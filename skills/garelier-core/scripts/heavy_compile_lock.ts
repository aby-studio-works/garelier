#!/usr/bin/env bun
// Garelier heavy-compile serialization lock — DEC-073 Part B.
//
// `[concurrency] max_concurrent_agents` bounds AGENT COUNT, not build LOAD. On a
// RAM-bound box a worker's `cargo build --workspace` (~16 GB) running at the same
// time as the async merge gate's `cargo test --workspace --no-run` (and/or an
// orphaned compile) can OOM and corrupt target dirs (`undefined symbol:
// anon.*.llvm`). This serializes the HEAVY-COMPILE INITIATORS across all layers
// (merge gate, driver/jig, interactive Dock) via a shared file lock
// (slot dirs under `runtime/locks/heavy_compile/`).
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
//   sweep:   heavy_compile_lock.ts --project <root> --pm-id <id> --mode sweep
//
// Config (setup_config.toml [heavy_compile], all optional):
//   enabled = true | max_concurrent = 1 | lease_minutes = 240
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv;
function flag(name: string, def = ""): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
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

if (!project || !pm || !mode) {
  console.error("heavy_compile_lock: --project, --pm-id, --mode are required");
  process.exit(2);
}

// --- config (regex the [heavy_compile] section; no TOML dep) ---
let enabled = true, maxConcurrent = 1, leaseMinutes = 240;
const configPath = join(project, "__garelier", pm, "_pm", "setup_config.toml");
if (existsSync(configPath)) {
  const raw = readFileSync(configPath, "utf8");
  const sec = raw.match(/^\[heavy_compile\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
  if (sec) {
    const body = sec[1];
    const en = body.match(/^\s*enabled\s*=\s*(true|false)/m);
    if (en) enabled = en[1] === "true";
    const mc = body.match(/^\s*max_concurrent\s*=\s*(-?\d+)/m);
    if (mc) maxConcurrent = parseInt(mc[1], 10);
    const lm = body.match(/^\s*lease_minutes\s*=\s*(\d+)/m);
    if (lm) leaseMinutes = parseInt(lm[1], 10);
  }
}
const lockDir = join(project, "__garelier", pm, "runtime", "locks", "heavy_compile");

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e && e.code === "EPERM"; }
}

// Stale if owner file missing, owner file older than the lease, or (when the
// owner recorded a real pid) the owner process is dead. A pid of 0 means the
// owner has no stable pid (Dock-held); then only the lease applies, so
// the slot stays held until an explicit release or lease expiry.
function slotStale(slot: string): boolean {
  const owner = join(slot, "owner");
  if (!existsSync(owner)) return true;
  try {
    const ageMin = (Date.now() - statSync(owner).mtimeMs) / 60000;
    if (ageMin > leaseMinutes) return true;
    const pid = parseInt(readFileSync(owner, "utf8").split("|")[0], 10) || 0;
    if (pid > 0 && !pidAlive(pid)) return true; // recorded owner process died
    return false;
  } catch { return true; }
}

function reclaim(slot: string) { try { rmSync(slot, { recursive: true, force: true }); } catch {} }

function sweep(): number {
  let n = 0;
  if (!existsSync(lockDir)) return 0;
  for (const name of readdirSync(lockDir)) {
    if (!name.startsWith("slot-")) continue;
    const slot = join(lockDir, name);
    if (slotStale(slot)) { reclaim(slot); n++; }
  }
  return n;
}

if (mode === "release") {
  if (token && token !== "OPEN" && existsSync(token)) reclaim(token);
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
if (!enabled || maxConcurrent <= 0) { console.log("OPEN"); process.exit(0); }
mkdirSync(lockDir, { recursive: true });
const deadline = Date.now() + timeoutSec * 1000;
while (true) {
  for (let i = 0; i < maxConcurrent; i++) {
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
  if (Date.now() >= deadline) {
    // Fail-open: never deadlock the pipeline. Proceed without the lock, loudly.
    console.error(`heavy_compile_lock: acquire timed out after ${timeoutSec}s; proceeding WITHOUT lock (fail-open). Check for a stuck/orphaned compile.`);
    console.log("OPEN");
    process.exit(0);
  }
  Bun.sleepSync(pollSec * 1000);
}
