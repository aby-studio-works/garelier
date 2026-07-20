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
// reclaim. Busy/RAM pressure queue-waits; only an unusable lock infrastructure
// returns OPEN, which callers must treat as ABORT (never lockless execution).
//
// Single cross-platform implementation (DEC-072 TS-first; callable from bash
// wrappers or the Dock via `bun heavy_compile_lock.ts ...`).
//
// Usage:
//   acquire: heavy_compile_lock.ts --project <root> --pm-id <id> --mode acquire
//               [--label <s>] [--owner-pid <pid>]
//               [--timeout-sec <n>] [--poll-sec <n>]
//            -> prints a TOKEN line (slot dir path), "DISABLED" when explicitly
//               disabled, or "OPEN" only when lock infrastructure is unusable.
//               `timeout-sec` is a wait-status heartbeat interval; contention
//               continues queue-waiting instead of proceeding lockless.
//   release: heavy_compile_lock.ts --project <root> --pm-id <id> --mode release --token <t>
//               [--build-exit <code>] [--build-log <path>]
//            -> releases the slot the token names, resolved against the MAIN-ROOT
//               lock dir (a worktree-local / mismatched token is remapped by slot
//               name, not silently ignored — W-058 release side). token=OPEN or
//               DISABLED is a no-op (nothing was held). Exits 0 on a real release /
//               no-op token, 1 when
//               the expected slot is absent everywhere (NOT a silent success),
//               2 on an unusable token. When the caller passes the finished
//               build's exit code / log, a known-OOM signature records an oom_hint.
//   sweep:   heavy_compile_lock.ts --project <root> --pm-id <id> --mode sweep
//
// Config (setup_config.toml [heavy_compile], all optional; NO new namespace —
// the RAM knobs live in the SAME section as the count-only knobs):
//   enabled = true | max_concurrent = 1 | lease_minutes = 240
//   build_ram_budget_gb = 16     # est. RAM one build consumes (per-lease reservation)
//   max_build_ram_gb    = <cap>  # user hard cap; unset => (total physical - OS margin)
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync,
  statSync, readdirSync, openSync, readSync, closeSync, fstatSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { probePidLiveness, requireRuntimeExecutable, resolveCommand, type PidProbeVia } from "../driver/src/scripts/_lib.ts";

// RAM the OS + harness need to stay responsive; reserved off the top of the
// budget so a full build never starves the box. Also the default headroom under
// `max_build_ram_gb` when the user sets no explicit cap.
export const OS_MARGIN_GB = 3;
// Conservative default for one heavy `cargo` build; a large full-workspace
// compile is ~16 GB. PM tunes it per project (small scoped builds set it lower).
export const DEFAULT_BUILD_RAM_BUDGET_GB = 16;
// W-024: the SHORT idle-reclaim threshold, far below the hard `lease_minutes`
// safety net (240). A holder past this age that is running ZERO compile
// processes is stale — the BLOCKED-worker / pid-0 Dock-hold that keeps its slot
// without doing any build (the 2026-07-06 90-min gate stall). 30 min comfortably
// clears a legitimate full-workspace compile (a live build keeps its `cargo`
// parent alive the whole time, so its process count never reads 0).
export const DEFAULT_STALE_MINUTES = 30;
const GB = 1024 ** 3;

export interface HeavyCompileConfig {
  enabled: boolean;
  maxConcurrent: number;
  leaseMinutes: number;
  // W-024: short idle-reclaim threshold (minutes); see DEFAULT_STALE_MINUTES.
  staleMinutes: number;
  buildRamBudgetGb: number;
  // null => resolve at runtime to (total physical RAM - OS_MARGIN_GB).
  maxBuildRamGb: number | null;
}

// Parse only the [heavy_compile] section (regex; no TOML dep — matches the
// wizard's flat key=value emit). Unknown/absent keys keep the defaults.
export function parseHeavyCompileConfig(raw: string): HeavyCompileConfig {
  const cfg: HeavyCompileConfig = {
    enabled: true, maxConcurrent: 1, leaseMinutes: 240,
    staleMinutes: DEFAULT_STALE_MINUTES,
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
  const sm = body.match(/^\s*stale_minutes\s*=\s*(\d+)/m);
  if (sm) cfg.staleMinutes = parseInt(sm[1], 10);
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

// Owner pid fields are intentionally strict. `0`, `unknown`, empty/missing, and
// malformed values all mean "liveness unknown" — never "definitely dead".
export function parseOwnerPid(field: string): number | null {
  const raw = field.trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export interface StaleCheck {
  ownerExists: boolean;
  ageMin: number;              // minutes since the owner file's mtime (acquire time)
  leaseMinutes: number;        // hard lease cap (safety net, regardless of process state)
  staleMinutes: number;        // shorter idle-reclaim threshold (W-024)
  hasPid: boolean;             // a real owner pid (>0) was recorded in the owner file
  ownerProcessLive: boolean;   // that recorded pid is alive (pidAlive); false when hasPid is false
  compileCount: number | null; // live cargo/rustc process count; null => not checked / unreadable
}

// The stale-slot decision (W-024). Returns the reclaim reason, or null when the
// slot is a live holder. Precedence, cheap-and-certain first:
//   1. owner-missing        — no owner file, but only after the same grace and
//                             confirmed compile-quiet check as an unknown pid.
//   2. owner-pid-dead       — a real pid was recorded and it is gone: the
//                             initiator crashed, reclaim fast.
//   3. lease-expired        — a REAL recorded pid survives past the hard lease.
//   4. idle-no-compile      — an UNKNOWN pid is past the SHORT stale threshold,
//                             AND a
//                             definite ZERO compile processes are running. This
//                             reclaims a BLOCKED-worker / legacy pid-0 hold that
//                             kept its slot doing no build.
// The misfire guards (誤解放防止): pid 0 / unknown / missing never enter the
// owner-pid-dead path, even beyond the hard lease; they need both the grace and a
// CONFIRMED compile count of 0. A null/unreadable or positive count never reclaims.
export function staleReason(c: StaleCheck): string | null {
  if (!c.ownerExists) {
    return c.ageMin > c.staleMinutes && c.compileCount === 0 ? "owner-missing" : null;
  }
  if (c.hasPid && !c.ownerProcessLive) return "owner-pid-dead";
  if (c.hasPid && c.ageMin > c.leaseMinutes) return "lease-expired";
  if (!c.hasPid && c.ageMin > c.staleMinutes && c.compileCount === 0) {
    return "idle-no-compile";
  }
  return null;
}

// Count live heavy-compile processes (cargo / rustc) cross-platform, or null when
// the process list is unreadable (=> the idle-reclaim path stays conservative and
// does NOT fire — it needs a confirmed 0). A test seam (GARELIER_HC_COMPILE_PROCS)
// injects a deterministic count or forces the unreadable path.
export function compileProcessCount(): number | null {
  const override = process.env.GARELIER_HC_COMPILE_PROCS;
  if (override !== undefined) {
    if (override === "unreadable") return null;
    const n = parseInt(override, 10);
    return isFinite(n) && n >= 0 ? n : null;
  }
  return compileProcessCountPlatform();
}

function compileProcessCountPlatform(): number | null {
  const names = new Set(["cargo", "rustc", "cargo.exe", "rustc.exe"]);
  try {
    if (process.platform === "win32") {
      // tasklist is present on every Windows; CSV rows start with "image.exe".
      const out = execFileSync(requireRuntimeExecutable("tasklist"), ["/FO", "CSV", "/NH"], { ...memOpts(), windowsHide: true });
      let n = 0;
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/);
        if (m && names.has(m[1].toLowerCase())) n++;
      }
      return n;
    }
    // POSIX: `ps` is universal and exits 0 (unlike `pgrep`, which exits 1 on no
    // match — indistinguishable from "pgrep missing"). `comm=` prints the command
    // name; basename covers the macOS full-path form.
    const ps = resolveCommand(["ps", "-A", "-o", "comm="]);
    if (!ps) return null;
    const out = execFileSync(ps[0], ps.slice(1), { ...memOpts(), windowsHide: true });
    let n = 0;
    for (const line of out.split(/\r?\n/)) {
      const cmd = line.trim();
      if (!cmd) continue;
      if (names.has((cmd.split("/").pop() || cmd).toLowerCase())) n++;
    }
    return n;
  } catch {
    return null; // tool missing / spawn error => unreadable (no idle-reclaim)
  }
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
      const totalBytes = parseInt(execFileSync("sysctl", ["-n", "hw.memsize"], { ...memOpts(), windowsHide: true }).trim(), 10);
      const vm = execFileSync("vm_stat", [], { ...memOpts(), windowsHide: true });
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
      const out = execFileSync(requireRuntimeExecutable("pwsh"), [
        "-NoProfile", "-NonInteractive", "-Command",
        '$o=Get-CimInstance Win32_OperatingSystem; "$($o.FreePhysicalMemory) $($o.TotalVisibleMemorySize)"',
      ], { ...memOpts(), windowsHide: true }).trim();
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
  // caller's pid so a crashed owner is reclaimed fast. A one-shot intermediary
  // must forward the long-lived pid; absent/0/malformed input is recorded as
  // `unknown`, never as a dead pid.
  //
  // W-169 (c) — WINDOWS gate-script guidance (for the future W-157 template): a
  // Git Bash `$$` is an MSYS pid, invisible to Windows `tasklist`. The liveness
  // probe (probePidLiveness) is now MSYS-aware (tasklist → `ps`), so `--owner-pid
  // $$` no longer false-reclaims — but PREFER passing the Windows pid where you
  // have it: `--owner-pid "$(cat /proc/$$/winpid 2>/dev/null || echo $$)"`. PM
  // scripts already do this; gate templates should standardize it.
  const ownerPid = parseOwnerPid(flag("owner-pid", ""));
  const ownerPidField = ownerPid === null ? "unknown" : String(ownerPid);
  // Optional build outcome reported at release, for OOM-signature detection.
  const buildExitRaw = flag("build-exit", "");
  const buildExit = buildExitRaw === "" ? null : (parseInt(buildExitRaw, 10) || 0);
  const buildLog = flag("build-log", "");

  if (!project || !pm || !mode) {
    console.error("heavy_compile_lock: --project, --pm-id, --mode are required");
    process.exit(2);
  }

  // W-058: resolve to the MAIN repository root so a caller inside a linked
  // worktree (`--project .` from a dispatch checkout) shares the SAME lock as the
  // merge gate / interactive Dock, instead of a worktree-local one that breaks
  // the cross-layer heavy-compile serialization. The guard: when this redirects,
  // say so loudly on stderr so a misrouted worktree-local lock is never silent.
  const mainRoot = resolveMainRoot(project);
  if (!samePath(mainRoot, project)) {
    console.error(`heavy_compile_lock: --project '${project}' is a linked worktree; using the shared lock at the main root '${mainRoot}' (git-common-dir). The worktree-local runtime/ lock is bypassed by design (W-058).`);
  }

  const cfg = existsSync(configPathOf(mainRoot, pm))
    ? parseHeavyCompileConfig(readFileSync(configPathOf(mainRoot, pm), "utf8"))
    : parseHeavyCompileConfig("");
  const lockDir = join(mainRoot, "__garelier", pm, "runtime", "locks", "heavy_compile");
  const oomHintFile = join(lockDir, "oom_hint");
  const reclaimLog = join(lockDir, "reclaim.log");
  // W-169: remember HOW each slot's owner pid was probed (os-signal|tasklist|
  // msys-ps|dead) so a reclaim audit records the means — the 18:21 false reclaim
  // had no trace that the owner was an MSYS pid tasklist could not see.
  const probeVia = new Map<string, PidProbeVia>();

  // Owner-liveness decision for one slot (W-024). Returns the stale reason or
  // null; only spends a process-list spawn (compileProcessCount) when the cheap
  // fields already say the idle path MIGHT fire (past the short threshold and the
  // owner is not a live registered process), so the fresh-lock hot path never
  // shells out.
  const slotStaleReason = (slot: string): string | null => {
    const owner = join(slot, "owner");
    if (!existsSync(owner)) {
      try {
        const ageMin = (Date.now() - statSync(slot).mtimeMs) / 60000;
        const compileCount = ageMin > cfg.staleMinutes ? compileProcessCount() : null;
        return staleReason({
          ownerExists: false, ageMin,
          leaseMinutes: cfg.leaseMinutes, staleMinutes: cfg.staleMinutes,
          hasPid: false, ownerProcessLive: false, compileCount,
        });
      } catch { return null; }
    }
    let mtimeMs: number;
    let pid: number | null;
    try {
      mtimeMs = statSync(owner).mtimeMs;
      pid = parseOwnerPid(readFileSync(owner, "utf8").split("|")[0] ?? "");
    } catch { return null; } // unreadable owner is unknown, never proof of stale
    const ageMin = (Date.now() - mtimeMs) / 60000;
    let ownerProcessLive = false;
    if (pid !== null) {
      const probe = probePidLiveness(pid); // W-169: MSYS-pid-aware (tasklist → ps)
      ownerProcessLive = probe.alive;
      probeVia.set(slot, probe.via);
    }
    const compileCount =
      pid === null && ageMin > cfg.staleMinutes ? compileProcessCount() : null;
    return staleReason({
      ownerExists: true, ageMin,
      leaseMinutes: cfg.leaseMinutes, staleMinutes: cfg.staleMinutes,
      hasPid: pid !== null, ownerProcessLive, compileCount,
    });
  };
  // W-061: name the SUSPECT slot while a waiter loops. The idle-no-compile
  // reclaim deliberately needs a compile-quiet MACHINE (a confirmed global 0),
  // so on a busy multi-lane box a dead-owner slot (pid 0 / pid-dead-unverifiable)
  // can sit un-reclaimed for the whole wait — the 90-minute wedge had NO trace of
  // who was suspected. This warns ONCE per slot per waiter, changes no reclaim
  // semantics, and tells the operator exactly what to inspect/sweep.
  const suspectWarned = new Set<string>();
  const warnSuspectSlot = (slot: string): void => {
    if (suspectWarned.has(slot)) return;
    const owner = join(slot, "owner");
    try {
      const ageMin = (Date.now() - statSync(owner).mtimeMs) / 60000;
      const line = readFileSync(owner, "utf8").trim();
      const pid = parseOwnerPid(line.split("|")[0] ?? "");
      const live = pid !== null && probePidLiveness(pid).alive;
      if (ageMin > cfg.staleMinutes && !live) {
        suspectWarned.add(slot);
        console.error(
          `heavy_compile_lock: waiting on SUSPECT ${basename(slot)} (age ${Math.round(ageMin)}m > stale ${cfg.staleMinutes}m, owner not verifiably alive: [${line}]) — idle-reclaim is held back only because other compile processes are running on this machine. If that owner is dead, free it now: --mode sweep (once the machine is compile-quiet) or remove the slot dir manually. (W-061)`,
        );
      }
    } catch { /* best-effort, never affects the wait */ }
  };
  // Plain slot removal (used by an OWNER's explicit release — not a reclaim).
  const removeSlot = (slot: string) => { try { rmSync(slot, { recursive: true, force: true }); } catch { /* ignore */ } };
  // Reclaim a slot a WAITER/sweep found stale: capture the owner line, remove the
  // slot, then append one audit line to reclaim.log and warn on stderr so a
  // reclaim is never silent (the 90-min stall had no trace of who held it).
  const reclaimStale = (slot: string, reason: string) => {
    let ownerInfo = "";
    try { ownerInfo = readFileSync(join(slot, "owner"), "utf8").trim(); } catch { /* ignore */ }
    removeSlot(slot);
    const name = basename(slot);
    const via = probeVia.get(slot) ?? "unknown"; // W-169: how the owner pid was probed
    const line = `${new Date().toISOString()}\treclaim\t${name}\t${reason}\tprobe=${via}\towner=${ownerInfo}`;
    try { mkdirSync(lockDir, { recursive: true }); appendFileSync(reclaimLog, line + "\n"); } catch { /* best-effort */ }
    console.error(`heavy_compile_lock: reclaimed stale ${name} (${reason}); freed for a waiting build. owner=[${ownerInfo}] probe=${via}`);
  };
  const countHolders = (): number => {
    if (!existsSync(lockDir)) return 0;
    let n = 0;
    for (const name of readdirSync(lockDir)) {
      if (!name.startsWith("slot-")) continue;
      if (!slotStaleReason(join(lockDir, name))) n++;
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
      const reason = slotStaleReason(slot);
      if (reason) { reclaimStale(slot, reason); n++; }
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
    // Resolve the REAL slot to delete against the main-root lock dir (W-058
    // release side): a worktree-local / mismatched token must NOT silently no-op
    // while the actual owner stays and blocks the pipeline.
    const target = resolveReleaseTarget(token, lockDir, existsSync);
    let releaseCode = 0;
    switch (target.kind) {
      case "invalid":
        console.error(`heavy_compile_lock: ${target.reason}`);
        releaseCode = 2;
        break;
      case "open":
        console.log(`released (token=${token.trim()}; no slot was held)`);
        break;
      case "remove":
        removeSlot(target.path);
        console.log(`released ${basename(target.path)}${target.remapped ? ` (resolved token to the main-root lock: ${target.path})` : ""}`);
        break;
      case "absent":
        // The anti-silent-no-op guard: the expected slot is not at the main-root
        // lock, so NOTHING was released. Exit non-zero and say so loudly — a real
        // owner may still be stuck under a different slot/project (run --mode
        // sweep, or reclaim manually). Never report a false "released".
        console.error(`heavy_compile_lock: release found no held ${target.slot} to remove (looked at: ${target.tried.join(", ")}). NOTHING was released — if a build is stalled waiting on the lock, a real owner may be stuck; run \`--mode sweep\` or reclaim the main-root ${target.slot} manually. This is NOT a silent success (W-058 release side).`);
        releaseCode = 1;
        break;
    }
    // OOM-hint recording is independent of the slot-removal outcome: if the caller
    // reported the build outcome, record a hint so the next acquire tightens
    // admission + warns the PM to shrink the RAM budget.
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
    process.exit(releaseCode);
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
  if (!cfg.enabled || cfg.maxConcurrent <= 0) { console.log("DISABLED"); process.exit(0); }

  const infraOpen = (action: string, error: unknown): never => {
    const code = (error as NodeJS.ErrnoException)?.code ?? "unknown";
    console.error(`heavy_compile_lock: reason=lock-infra action=${action} code=${code}; returning OPEN for caller ABORT. Lockless execution is prohibited.`);
    console.log("OPEN");
    process.exit(0);
  };
  try { mkdirSync(lockDir, { recursive: true }); }
  catch (error) { infraOpen("create-lock-dir", error); }

  const hint = readOomHint();
  if (hint) {
    console.error(`heavy_compile_lock: recent OOM detected (${hint}); tightening admission by one build budget. Consider lowering [heavy_compile] max_build_ram_gb or raising build_ram_budget_gb.`);
  }
  const oomHint = !!hint;

  const startedAt = Date.now();
  // W-143 sub-case (#354): a QUEUE-WAITING acquire is a live, healthy producer that
  // simply cannot start compiling yet — but from the outside it looks exactly like a
  // stall (no compile process, flat fingerprint), so contract_check --stall-scan
  // false-flagged the waiting dispatch as working-stalled. A queue wait now leaves a
  // WAITER HEARTBEAT the stall scan reads as an active signal. Best-effort only —
  // the marker never affects the lock decision, and a killed waiter's file simply
  // ages out (contract_check treats a stale heartbeat as absent).
  const waitersDir = join(lockDir, "waiters");
  const waiterFile = join(waitersDir, `waiter-${process.pid}.json`);
  const refreshWaiter = (reason: string): void => {
    try {
      mkdirSync(waitersDir, { recursive: true });
      writeFileSync(waiterFile, `{"pid":${process.pid},"label":${JSON.stringify(label)},"since_epoch":${Math.floor(startedAt / 1000)},"ts_epoch":${Math.floor(Date.now() / 1000)},"reason":${JSON.stringify(reason)}}\n`);
    } catch { /* best-effort — never blocks the wait */ }
  };
  const clearWaiter = (): void => { try { rmSync(waiterFile, { force: true }); } catch { /* best-effort */ } };
  // Remove the heartbeat on ANY exit (successful acquire, OPEN abort, or kill via
  // the harness) so a slot handoff does not leave a phantom waiter behind.
  process.on("exit", clearWaiter);

  let nextHeartbeatAt = startedAt + timeoutSec * 1000;
  let lastWaitReason = "";
  while (true) {
    let holders = 0;
    try { holders = countHolders(); }
    catch (error) { infraOpen("read-lock-dir", error); }
    // RAM admission: never block the SOLE build (holders == 0) — the machine must
    // run at least one; queueing the only possible build cannot improve safety. The
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
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
            infraOpen(`create-${basename(slot)}`, error);
          }
          const reason = slotStaleReason(slot);
          if (reason) reclaimStale(slot, reason); // next pass retries this freed slot
          else warnSuspectSlot(slot); // W-061: dead-owner-on-busy-box, name it once
          continue;
        }
        try {
          writeFileSync(join(slot, "owner"), `${ownerPidField}|${label}|${new Date().toISOString()}`);
        } catch (error) {
          removeSlot(slot);
          infraOpen(`write-${basename(slot)}-owner`, error);
        }
        console.log(slot);
        process.exit(0);
      }
    }

    const waitReason = ramOk ? "slot-busy" : "ram-budget";
    refreshWaiter(waitReason); // W-143: heartbeat so the stall scan reads a queue wait as active
    if (waitReason !== lastWaitReason) {
      console.error(`heavy_compile_lock: waiting reason=${waitReason}; queue wait active, lockless execution prohibited.`);
      lastWaitReason = waitReason;
    }
    const now = Date.now();
    if (now >= nextHeartbeatAt) {
      const elapsedSec = Math.floor((now - startedAt) / 1000);
      console.error(`heavy_compile_lock: still waiting reason=${waitReason} elapsed_sec=${elapsedSec}; queue wait continues.`);
      nextHeartbeatAt = now + timeoutSec * 1000;
    }
    Bun.sleepSync(pollSec * 1000);
  }
}

// W-058: the SHARED lock must live at the MAIN repository root, never inside a
// linked worktree. A worktree's `__garelier/<pm>/runtime/` is a per-worktree,
// gitignored path; a caller that passes `--project .` from inside a `git worktree`
// (a dispatch checkout) would otherwise build its lock dir there — a DIFFERENT dir
// from the main-root lock that the merge gate / interactive Dock hold, so the
// cross-layer heavy-compile serialization (the OOM guard) silently breaks. This
// resolves `project` to the git-common-dir side so every layer shares ONE lock.
//
// git-common-dir is the shared `.git` for a whole worktree set: in the MAIN
// checkout git-dir == git-common-dir; in a LINKED worktree git-dir is
// `<mainRoot>/.git/worktrees/<name>` while git-common-dir stays `<mainRoot>/.git`.
// So: same => already main (or a plain non-worktree repo), keep project unchanged;
// differ => linked worktree, main root is the parent of the common `.git`.

// Case-fold on Windows (paths are case-insensitive) so the git-dir vs common-dir
// comparison is not fooled by drive-letter / component casing differences.
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

// Pure decision (unit-testable without a repo): given the absolute git-dir and
// git-common-dir, return the resolved MAIN ROOT, or null to keep `project` as-is.
// null covers the main checkout (dirs equal) and any unusual layout (bare repo,
// common-dir not named `.git`) where deriving a worktree root is unsafe.
export function mainRootFromGitDirs(gitDir: string, commonDir: string): string | null {
  if (!gitDir || !commonDir) return null;
  if (samePath(gitDir, commonDir)) return null; // main checkout / plain repo
  const common = resolve(commonDir).replace(/[\\/]+$/, "");
  if (basename(common) !== ".git") return null; // bare / unexpected layout
  return dirname(common);
}

// Resolve `project` to the main repository root for the shared lock (W-058).
// Spawns git once; on ANY failure (not a git repo, old git, spawn error) it
// FAILS OPEN by returning `project` unchanged — the lock still works, it just
// falls back to the pre-W-058 path (never worse than before, never a deadlock).
// A test seam (GARELIER_HC_MAIN_ROOT) injects the resolved root deterministically.
export function resolveMainRoot(project: string): string {
  const override = process.env.GARELIER_HC_MAIN_ROOT;
  if (override !== undefined) return override === "" ? project : override;
  try {
    // `--path-format=absolute` (git 2.31+) makes both paths absolute regardless of
    // cwd; it applies to the options that follow it. Output: git-dir, then
    // git-common-dir, one per line.
    const out = execFileSync(
      requireRuntimeExecutable("git"),
      ["-C", project, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    );
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return project;
    const [gitDir, commonDir] = lines;
    const gitDirAbs = isAbsolute(gitDir) ? gitDir : resolve(project, gitDir);
    const commonDirAbs = isAbsolute(commonDir) ? commonDir : resolve(project, commonDir);
    return mainRootFromGitDirs(gitDirAbs, commonDirAbs) ?? project;
  } catch {
    return project; // not a git repo / old git / spawn error => keep project
  }
}

// W-058 (release side): which slot dir a `release --token <t>` must delete —
// ALWAYS anchored to the resolved (main-root) lockDir, never the caller's literal
// token path. The 2026-07-13 downstream #285 incident: a worker ran release,
// printed "released", yet the main-root slot-0 owner stayed (30-min gate stall,
// manual reclaim). Cause: release removed the token path VERBATIM
// (`existsSync(token)`), so a worktree-local / mismatched token was absent and
// the real main-root owner was never touched — a SILENT no-op. `exists` is
// injected so the decision is pure and unit-testable without a filesystem.
export type ReleaseTarget =
  | { kind: "open" }                                       // token=OPEN/DISABLED: nothing held
  | { kind: "remove"; path: string; remapped: boolean }    // a real slot to delete (remapped => not the literal token)
  | { kind: "absent"; slot: string; tried: string[] }      // expected slot not found anywhere (=> hard error, not success)
  | { kind: "invalid"; reason: string };                   // unusable token

export function resolveReleaseTarget(token: string, lockDir: string,
                                     exists: (p: string) => boolean): ReleaseTarget {
  const t = token.trim();
  if (!t) return { kind: "invalid", reason: "release requires --token (the acquire slot path, OPEN, or DISABLED)" };
  if (t === "OPEN" || t === "DISABLED") return { kind: "open" };
  const slot = basename(t.replace(/[\\/]+$/, ""));
  if (!/^slot-\d+$/.test(slot)) {
    return { kind: "invalid", reason: `--token does not name a slot ("slot-<n>"): ${token}` };
  }
  // Canonical target: the slot under the resolved (main-root) lock dir. This is
  // the fix — resolve the REAL owner here regardless of what path the token names.
  const canonical = join(lockDir, slot);
  if (exists(canonical)) return { kind: "remove", path: canonical, remapped: t !== canonical };
  // Secondary: an absolute literal token that still exists (a rare pre-fix
  // worktree-local leftover) and differs from canonical — remove it too.
  if (isAbsolute(t) && t !== canonical && exists(t)) {
    return { kind: "remove", path: t, remapped: false };
  }
  return { kind: "absent", slot, tried: isAbsolute(t) && t !== canonical ? [canonical, t] : [canonical] };
}

function configPathOf(project: string, pm: string): string {
  return join(project, "__garelier", pm, "_pm", "setup_config.toml");
}

if (import.meta.main) main();
