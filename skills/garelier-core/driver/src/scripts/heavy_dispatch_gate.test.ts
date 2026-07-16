import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runHeavyGate, EXIT_QUEUED, type LockRunner } from "./heavy_dispatch_gate.ts";

// W-087: the heavy-dispatch scheduler gate. Two layers of proof for "heavy 同時
//起動 0": (1) the PURE gate decision over an injected heavy_compile_lock runner,
// and (2) an END-TO-END run driving the REAL heavy_compile_lock so a 2nd heavy
// dispatch against a held slot is QUEUED, never granted a concurrent slot.

const PM = "tpm";
const SCRIPT = join(import.meta.dir, "heavy_dispatch_gate.ts");
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

// ── pure gate over an injected lock runner ───────────────────────────────────
describe("runHeavyGate (pure over an injected lock runner)", () => {
  const noLock: LockRunner = () => { throw new Error("lock must NOT be touched for a non-heavy class"); };

  test("a non-heavy class returns NOT-HEAVY and never touches the lock", () => {
    for (const rc of ["light", "data", "review"]) {
      const r = runHeavyGate(["--project", "/p", "--pm-id", PM, "--resource-class", rc], noLock, () => {});
      expect(r).toEqual({ line: "NOT-HEAVY", code: 0 });
    }
  });

  test("an unspecified class warns, defaults to light, and stays NOT-HEAVY", () => {
    const warns: string[] = [];
    const r = runHeavyGate(["--project", "/p", "--pm-id", PM], noLock, (s) => warns.push(s));
    expect(r.line).toBe("NOT-HEAVY");
    expect(warns.join("\n")).toContain("unspecified");
  });

  test("heavy + a granted slot token -> ADMITTED <token>", () => {
    const slotLock: LockRunner = () => ({ stdout: "/main/.../heavy_compile/slot-0\n", stderr: "", code: 0 });
    const r = runHeavyGate(["--project", "/p", "--pm-id", PM, "--resource-class", "heavy"], slotLock, () => {});
    expect(r.code).toBe(0);
    expect(r.line).toContain("ADMITTED");
    expect(r.line).toContain("slot-0");
  });

  test("heavy + a busy-timeout OPEN -> QUEUED (exit 10), a 2nd heavy is deferred", () => {
    const busyLock: LockRunner = () => ({
      stdout: "OPEN\n",
      stderr: "heavy_compile_lock: acquire timed out after 1s (all slots held); proceeding WITHOUT lock (fail-open).",
      code: 0,
    });
    const r = runHeavyGate(["--project", "/p", "--pm-id", PM, "--resource-class", "heavy"], busyLock, () => {});
    expect(r.line).toBe("QUEUED");
    expect(r.code).toBe(EXIT_QUEUED);
  });

  test("heavy + a free/disabled OPEN (no timeout) -> ADMITTED OPEN", () => {
    const freeLock: LockRunner = () => ({ stdout: "OPEN\n", stderr: "", code: 0 });
    const r = runHeavyGate(["--project", "/p", "--pm-id", PM, "--resource-class", "heavy"], freeLock, () => {});
    expect(r.line).toBe("ADMITTED OPEN");
    expect(r.code).toBe(0);
  });
});

// ── end-to-end: the REAL heavy_compile_lock enforces heavy 同時起動 0 ──────────
function mkProject(configBody: string): { proj: string; lockDir: string } {
  const proj = mkdtempSync(join(tmpdir(), "garelier-hdg-"));
  tmps.push(proj);
  mkdirSync(join(proj, "__garelier", PM, "_pm"), { recursive: true });
  writeFileSync(join(proj, "__garelier", PM, "_pm", "setup_config.toml"), configBody);
  return { proj, lockDir: join(proj, "__garelier", PM, "runtime", "locks", "heavy_compile") };
}

// A slot held by THIS (live) test process pid + a fresh mtime, so heavy_compile_lock
// never idle-reclaims it during the 2nd acquire — a genuine concurrent holder.
function holdLiveSlot(lockDir: string) {
  const slot = join(lockDir, "slot-0");
  mkdirSync(slot, { recursive: true });
  writeFileSync(join(slot, "owner"), `${process.pid}|held|${new Date().toISOString()}`);
}

function runGate(proj: string, args: string[], memEnv: string) {
  const env = { ...process.env, GARELIER_HC_MEM_GB: memEnv } as Record<string, string>;
  return spawnSync(process.execPath, [SCRIPT, "--project", proj, "--pm-id", PM, ...args],
    { encoding: "utf8", env, timeout: 20000 });
}

describe("heavy_dispatch_gate end-to-end (real heavy_compile_lock)", () => {
  test("the FIRST heavy dispatch is ADMITTED a real machine-wide slot", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\n");
    const r = runGate(proj, ["--resource-class", "heavy", "--slug", "w087-a"], "100,128");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ADMITTED");
    expect(existsSync(join(lockDir, "slot-0"))).toBe(true);
  });

  test("a 2nd heavy dispatch while a slot is held is QUEUED — 0 concurrent heavy starts", () => {
    // max_concurrent=1 + a LIVE holder: the single machine-wide slot is taken, so
    // the 2nd heavy dispatch can never obtain a concurrent slot. It waits its short
    // timeout then the gate reports QUEUED (defer), never ADMITTED slot-1.
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\n");
    holdLiveSlot(lockDir);
    const r = runGate(proj, ["--resource-class", "heavy", "--slug", "w087-b", "--timeout-sec", "1", "--poll-sec", "1"], "100,128");
    expect(r.status).toBe(EXIT_QUEUED);
    expect(r.stdout.trim()).toBe("QUEUED");
    // The invariant: no 2nd slot was ever created — exactly one heavy holder.
    expect(existsSync(join(lockDir, "slot-1"))).toBe(false);
  });

  test("a non-heavy dispatch never creates a heavy lock dir", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\n");
    const r = runGate(proj, ["--resource-class", "review", "--slug", "w087-c"], "100,128");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("NOT-HEAVY");
    expect(existsSync(lockDir)).toBe(false);
  });

  test("release from the gate frees the held heavy slot", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\n");
    const acq = runGate(proj, ["--resource-class", "heavy", "--slug", "w087-d"], "100,128");
    const token = acq.stdout.replace(/^ADMITTED\s+/, "").trim();
    expect(existsSync(join(lockDir, "slot-0"))).toBe(true);
    const rel = runGate(proj, ["--resource-class", "heavy", "--mode", "release", "--token", token], "100,128");
    expect(rel.status).toBe(0);
    expect(existsSync(join(lockDir, "slot-0"))).toBe(false);
  });
});
