#!/usr/bin/env bun
// Garelier heavy-compile serialization lock — DEC-073 Part B + RAM build-lease (W-070).
//
// `[concurrency] max_concurrent_agents` bounds AGENT COUNT, not build LOAD. On a
// RAM-bound box a worker's `cargo build --workspace` (~16 GB) running at the same
// time as the async merge gate's `cargo test --workspace --no-run` (and/or an
// orphaned compile) can OOM and corrupt target dirs (`undefined symbol:
// anon.*.llvm`). This serializes the HEAVY-COMPILE INITIATORS across all layers
// (merge gate, driver/jig, interactive Dock) via a shared file lock
// (slot dirs under `runtime/locks/heavy_compile/`).
//
// W-070 extends the fixed "N concurrent" semaphore into a RAM-BUDGET build-lease:
// beyond the slot ceiling `max_concurrent`, admission also weighs a per-build RAM
// estimate against live free RAM (and a user hard cap), so concurrency settles at
// "as many builds as fit in RAM" instead of a hand-watched count. It stays
// count-only (unchanged behavior) where RAM cannot be read (fail-open), and never
// blocks the SOLE build — a machine always runs at least one, so the RAM gate only
// governs the 2nd+ lease. A known-OOM signature reported at release records an
// `oom_hint` that tightens the next admission by one build budget and warns the PM
// to shrink the config.
//
// WHO ACQUIRES (the initiator holds it for the compile's duration — never the
// subagent's discretion): the merge-gate subprocess wraps its quality gate; the
// Dock wraps a dispatched producer's lifetime (acquire before the
// Agent/Workflow dispatch, release on return). Self-heals via pid-dead + lease
// reclaim; acquire fail-opens on timeout so it can never deadlock the pipeline.
//
// Single cross-platform implementation (DEC-072 TS-first; callable from bash
// wrappers or the Dock via `bun heavy_compile_lock.ts ...`).
//
// Usage:
//   acquire: heavy_compile_lock.ts --project <root> --pm-id <id> --mode acquire
//               [--label <s>] [--timeout-sec <n>] [--poll-sec <n>]
//            -> prints a TOKEN line (slot dir path, or "OPEN" when disabled /
//               fail-open). Always exits 0 (never deadlocks a caller).
//   release: heavy_compile_lock.ts --project <root> --pm-id <id> --mode release --token <t>
//               [--build-exit <code>] [--build-log <path>]
//            -> releases the slot; when the caller passes the finished build's
//               exit code / log, a known-OOM signature records an oom_hint.
//   sweep:   heavy_compile_lock.ts --project <root> --pm-id <id> --mode sweep
//
// Config (setup_config.toml [heavy_compile], all optional; NO new namespace —
// the RAM knobs live in the SAME section as the count-only knobs):
//   enabled = true | max_concurrent = 1 | lease_minutes = 240
//   build_ram_budget_gb = 16     # est. RAM one build consumes (per-lease reservation)
//   max_build_ram_gb    = <cap>  # user hard cap; unset => (total physical - OS margin)
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync,
  openSync, readSync, closeSync, fstatSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";

// RAM the OS + harness need to stay responsive; reserved off the top of the
// budget so a full build never starves the box. Also the default headroom under
// `max_build_ram_gb` when the user sets no explicit cap.
export const OS_MARGIN_GB = 3;
// Conservative default for one heavy `cargo` build; a large full-workspace
// compile is ~16 GB. PM tunes it per project (small scoped builds set it lower).
export const DEFAULT_BUILD_RAM_BUDGET_GB = 16;
const GB = 1024 ** 3;

export interface HeavyCompileConfig {
  enabled: boolean;
  maxConcurrent: number;
  leaseMinutes: number;
  buildRamBudgetGb: number;
  // null => resolve at runtime to (total physical RAM - OS_MARGIN_GB).
  maxBuildRamGb: number | null;
}

// Parse only the [heavy_compile] section (regex; no TOML dep — matches the
// wizard's flat key=value emit). Unknown/absent keys keep the defaults.
export function parseHeavyCompileConfig(raw: string): HeavyCompileConfig {
  const cfg: HeavyCompileConfig = {
    enabled: true, maxConcurrent: 1, leaseMinutes: 240,
    buildRamBudgetGb: DEFAULT_BUILD_RAM_BUDGET_GB, maxBuildRamGb: null,
  };
  const sec = raw.match(/^\[heavy_compile\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
  if (!sec) return cfg;
  const body = sec[1];
  const en = body.match(/^\s*enabled\s*=\s*(true|false)/m);
  if (en) cfg.enabled = en[1] === "true";
  const mc = body.match(/^\s*max_concurrent\s*=\s*(-?\d+)/m);
  if (mc) cfg.maxConcurrent = parseInt(mc[1], 10);
  const lm = body.match(/^\s*lease_minutes\s*=\s*(\d+)/m);
  if (lm) cfg.leaseMinutes = parseInt(lm[1], 10);
  const br = body.match(/^\s*build_ram_budget_gb\s*=\s*([\d.]+)/m);
  if (br) cfg.buildRamBudgetGb = parseFloat(br[1]);
  const mb = body.match(/^\s*max_build_ram_gb\s*=\s*([\d.]+)/m);
  if (mb) cfg.maxBuildRamGb = parseFloat(mb[1]);
  return cfg;
}

export interface RamAdmission {
  freeGb: number;         // live free/available RAM
  holders: number;        // current non-stale lease holders (excludes the new one)
  buildRamBudgetGb: number;
  maxBuildRamGb: number;  // already resolved (config cap, or total - OS margin)
  osMarginGb: number;
  oomHint: boolean;       // a recent OOM was recorded -> tighten by one budget
}

// The build-lease admission predicate (W-070). The available budget is the
// LESSER of the user hard cap and what live RAM leaves after the OS margin; a
// recent OOM shaves one more build's worth (the single-step tightening). A new
// lease is admitted when that budget covers every current holder PLUS the new
// build. A non-positive budget disables RAM gating (count-only).
export function admitByRam(p: RamAdmission): boolean {
  if (!(p.buildRamBudgetGb > 0)) return true;
  const baseCap = Math.min(p.maxBuildRamGb, p.freeGb - p.osMarginGb);
  const cap = baseCap - (p.oomHint ? p.buildRamBudgetGb : 0);
  return cap >= p.buildRamBudgetGb * (p.holders + 1);
}

// Detect the known heavy-compile OOM fingerprints from a finished build's exit
// code + log tail. Kept deliberately narrow so the hint (a warning, never a hard
// block) does not nag on benign output. Returns the matched signature or null.
export function detectOomSignature(exitCode: number | null, log: string): string | null {
  if (exitCode === 137) return "oom-kill-137"; // 128 + SIGKILL(9): the OOM killer
  const text = log || "";
  // The corrupted-link symptom seen after a build was OOM-killed mid-codegen.
  if (/\banon\.[A-Za-z0-9_.$]*\.llvm\b/.test(text)) return "anon-llvm-link";
  if (/out of memory|cannot allocate memory|memory allocation of \d+ bytes failed|std::bad_alloc|\bsignal:\s*9\b|\bSIGKILL\b/i.test(text)) {
    return "oom-kill";
  }
  if (/incremental compilation[\s\S]{0,120}?(corrupt|invalid|aborting|failed)|found invalid metadata files/i.test(text)) {
    return "incremental-corruption";
  }
  return null;
}

// Cross-platform free/total physical RAM in GB, or null when unreadable (=>
// caller degrades to count-only). Platform-specific readers give "available"
// (reclaimable-cache-aware) numbers where the OS exposes them; node:os
// free/total is the universal fallback. A test seam (GARELIER_HC_MEM_GB) injects
// deterministic values or forces the unreadable path.
export function readMem(): { freeGb: number; totalGb: number } | null {
  const override = process.env.GARELIER_HC_MEM_GB;
  if (override !== undefined) {
    if (override === "unreadable") return null;
    const m = override.match(/^\s*([\d.]+)\s*,\s*([\d.]+)\s*$/);
    return m ? { freeGb: parseFloat(m[1]), totalGb: parseFloat(m[2]) } : null;
  }
  return readMemPlatform();
}

function readMemPlatform(): { freeGb: number; totalGb: number } | null {
  try {
    if (process.platform === "linux") {
      const raw = readFileSync("/proc/meminfo", "utf8");
      const avail = raw.match(/^MemAvailable:\s+(\d+)\s*kB/m);
      const free = raw.match(/^MemFree:\s+(\d+)\s*kB/m);
      const total = raw.match(/^MemTotal:\s+(\d+)\s*kB/m);
      // MemAvailable (reclaimable-cache-aware) beats MemFree when present.
      const freeKb = avail ? +avail[1] : free ? +free[1] : NaN;
      const totalKb = total ? +total[1] : NaN;
      if (isFinite(freeKb) && isFinite(totalKb)) {
        return { freeGb: (freeKb * 1024) / GB, totalGb: (totalKb * 1024) / GB };
      }
    } else if (process.platform === "darwin") {
      const totalBytes = parseInt(execFileSync("sysctl", ["-n", "hw.memsize"], memOpts()).trim(), 10);
      const vm = execFileSync("vm_stat", [], memOpts());
      const psMatch = vm.match(/page size of (\d+) bytes/);
      const pageSize = psMatch ? +psMatch[1] : 4096;
      const pages = (k: string) => {
        const m = vm.match(new RegExp(`Pages ${k}:\\s+(\\d+)`));
        return m ? +m[1] : 0;
      };
      const freeBytes = (pages("free") + pages("inactive") + pages("speculative")) * pageSize;
      if (isFinite(totalBytes) && totalBytes > 0) {
        return { freeGb: freeBytes / GB, totalGb: totalBytes / GB };
      }
    } else if (process.platform === "win32") {
      // wmic is removed on recent Windows; PowerShell CIM is the durable reader.
      // Both values are in KB.
      const out = execFileSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        '$o=Get-CimInstance Win32_OperatingSystem; "$($o.FreePhysicalMemory) $($o.TotalVisibleMemorySize)"',
      ], memOpts()).trim();
      const m = out.match(/(\d+)\s+(\d+)/);
      if (m) return { freeGb: (+m[1] * 1024) / GB, totalGb: (+m[2] * 1024) / GB };
    }
  } catch { /* fall through to the universal fallback */ }
  try {
    const total = totalmem();
    if (total > 0) return { freeGb: freemem() / GB, totalGb: total / GB };
  } catch { /* ignore */ }
  return null;
}

function memOpts() {
  const stdio: ("ignore" | "pipe")[] = ["ignore", "pipe", "ignore"];
  return { encoding: "utf8" as const, stdio, timeout: 5000 };
}

// Read the last `maxBytes` of a (possibly large) build log without slurping it
// whole — OOM logs can be big, and we only need the tail for signature matching.
function readLogTail(path: string, maxBytes = 131072): string {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = size > maxBytes ? size - maxBytes : 0;
      const len = size - start;
      if (len <= 0) return "";
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return ""; }
}

// ---------------------------------------------------------------------------
// CLI (only runs when invoked directly; importing this file for tests must not
// read argv, spawn, or exit).
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv;
  const flag = (name: string, def = ""): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const project = flag("project");
  const pm = flag("pm-id");
  const mode = flag("mode");
  const token = flag("token");
  const label = flag("label", "heavy-compile");
  const timeoutSec = parseInt(flag("timeout-sec", "9000"), 10) || 9000;
  const pollSec = parseInt(flag("poll-sec", "5"), 10) || 5;
  // The OWNER is the long-lived caller that holds the lock for the compile's
  // duration — NOT this one-shot CLI (which exits right after acquire). Pass the
  // caller's pid (merge-gate `$PID`) so a crashed owner is reclaimed fast; pass 0
  // (the Dock case, no stable pid) to rely on explicit release + lease.
  const ownerPid = parseInt(flag("owner-pid", "0"), 10) || 0;
  // Optional build outcome reported at release, for OOM-signature detection.
  const buildExitRaw = flag("build-exit", "");
  const buildExit = buildExitRaw === "" ? null : (parseInt(buildExitRaw, 10) || 0);
  const buildLog = flag("build-log", "");

  if (!project || !pm || !mode) {
    console.error("heavy_compile_lock: --project, --pm-id, --mode are required");
    process.exit(2);
  }

  const cfg = existsSync(configPathOf(project, pm))
    ? parseHeavyCompileConfig(readFileSync(configPathOf(project, pm), "utf8"))
    : parseHeavyCompileConfig("");
  const lockDir = join(project, "__garelier", pm, "runtime", "locks", "heavy_compile");
  const oomHintFile = join(lockDir, "oom_hint");

  const slotStale = (slot: string): boolean => {
    const owner = join(slot, "owner");
    if (!existsSync(owner)) return true;
    try {
      const ageMin = (Date.now() - statSync(owner).mtimeMs) / 60000;
      if (ageMin > cfg.leaseMinutes) return true;
      const pid = parseInt(readFileSync(owner, "utf8").split("|")[0], 10) || 0;
      if (pid > 0 && !pidAlive(pid)) return true; // recorded owner process died
      return false;
    } catch { return true; }
  };
  const reclaim = (slot: string) => { try { rmSync(slot, { recursive: true, force: true }); } catch { /* ignore */ } };
  const countHolders = (): number => {
    if (!existsSync(lockDir)) return 0;
    let n = 0;
    for (const name of readdirSync(lockDir)) {
      if (!name.startsWith("slot-")) continue;
      if (!slotStale(join(lockDir, name))) n++;
    }
    return n;
  };
  // A recorded OOM stays actionable until it ages past the lease, then self-clears.
  const readOomHint = (): string | null => {
    if (!existsSync(oomHintFile)) return null;
    try {
      const ageMin = (Date.now() - statSync(oomHintFile).mtimeMs) / 60000;
      if (ageMin > cfg.leaseMinutes) return null;
      return readFileSync(oomHintFile, "utf8").trim();
    } catch { return null; }
  };
  const sweep = (): number => {
    let n = 0;
    if (!existsSync(lockDir)) return 0;
    for (const name of readdirSync(lockDir)) {
      if (!name.startsWith("slot-")) continue;
      const slot = join(lockDir, name);
      if (slotStale(slot)) { reclaim(slot); n++; }
    }
    // Clear an aged-out OOM hint too so the tightening does not persist forever.
    if (existsSync(oomHintFile)) {
      try {
        if ((Date.now() - statSync(oomHintFile).mtimeMs) / 60000 > cfg.leaseMinutes) {
          rmSync(oomHintFile, { force: true }); n++;
        }
      } catch { /* ignore */ }
    }
    return n;
  };

  if (mode === "release") {
    if (token && token !== "OPEN" && existsSync(token)) reclaim(token);
    // If the caller reported the build outcome, record an OOM hint so the next
    // acquire tightens admission + warns the PM to shrink the RAM budget.
    if (buildExit !== null || buildLog) {
      const sig = detectOomSignature(buildExit, buildLog ? readLogTail(buildLog) : "");
      if (sig) {
        try {
          mkdirSync(lockDir, { recursive: true });
          writeFileSync(oomHintFile, `${new Date().toISOString()}|${sig}`);
          console.error(`heavy_compile_lock: recorded OOM hint (${sig}); next acquire will tighten the RAM budget by one build.`);
        } catch { /* best-effort */ }
      }
    }
    console.log("released");
    process.exit(0);
  }
  if (mode === "sweep") {
    console.log(`swept=${sweep()}`);
    process.exit(0);
  }
  if (mode !== "acquire") {
    console.error(`heavy_compile_lock: unknown mode: ${mode}`);
    process.exit(2);
  }

  // --- acquire ---
  if (!cfg.enabled || cfg.maxConcurrent <= 0) { console.log("OPEN"); process.exit(0); }
  mkdirSync(lockDir, { recursive: true });

  const hint = readOomHint();
  if (hint) {
    console.error(`heavy_compile_lock: recent OOM detected (${hint}); tightening admission by one build budget. Consider lowering [heavy_compile] max_build_ram_gb or raising build_ram_budget_gb.`);
  }
  const oomHint = !!hint;

  const deadline = Date.now() + timeoutSec * 1000;
  let ramBlockedOnce = false;
  while (true) {
    const holders = countHolders();
    // RAM admission: never block the SOLE build (holders == 0) — the machine must
    // run at least one, and blocking-then-fail-open would only add latency. The
    // budget gate governs the 2nd+ lease. Degrade to count-only when RAM is
    // unreadable (fail-open: keep the pre-W-070 behavior).
    let ramOk = true;
    if (holders > 0) {
      const mem = readMem();
      if (mem) {
        const maxBuildRamGb = cfg.maxBuildRamGb ?? (mem.totalGb - OS_MARGIN_GB);
        ramOk = admitByRam({
          freeGb: mem.freeGb, holders,
          buildRamBudgetGb: cfg.buildRamBudgetGb, maxBuildRamGb,
          osMarginGb: OS_MARGIN_GB, oomHint,
        });
      }
    }
    if (ramOk) {
      for (let i = 0; i < cfg.maxConcurrent; i++) {
        const slot = join(lockDir, `slot-${i}`);
        try {
          mkdirSync(slot); // atomic: throws EEXIST if held
          writeFileSync(join(slot, "owner"), `${ownerPid}|${label}|${new Date().toISOString()}`);
          console.log(slot);
          process.exit(0);
        } catch {
          if (slotStale(slot)) reclaim(slot); // next pass retries this slot
        }
      }
    } else {
      ramBlockedOnce = true;
    }
    if (Date.now() >= deadline) {
      // Fail-open: never deadlock the pipeline. Proceed without the lock, loudly.
      const why = ramBlockedOnce
        ? "RAM budget kept it waiting (free RAM below the build budget)"
        : "all slots held";
      console.error(`heavy_compile_lock: acquire timed out after ${timeoutSec}s (${why}); proceeding WITHOUT lock (fail-open). Check for a stuck/orphaned compile.`);
      console.log("OPEN");
      process.exit(0);
    }
    Bun.sleepSync(pollSec * 1000);
  }
}

function configPathOf(project: string, pm: string): string {
  return join(project, "__garelier", pm, "_pm", "setup_config.toml");
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e && e.code === "EPERM"; }
}

if (import.meta.main) main();
