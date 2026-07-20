import { rmSync } from "../guard/path_guard.ts";
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// W-169 (f): the arbiter-wiring unit tests (merge_gate_lock.test.ts) exercise
// classifyActiveLock in isolation. This complements them with a REAL two-process
// race on the actual `wx` (noclobber) create — the OS-atomic arbiter — to prove
// end-to-end mutual exclusion: exactly one racer proceeds, the other backs off,
// so two runners never both stage a `git merge`. The assertion is order-
// independent (exactly-one-winner), so it does not flake on process-start jitter
// (the W-148 class the scoping note warns against).

const LOCK_MODULE = join(dirname(fileURLToPath(import.meta.url)), "merge_gate_lock.ts");

// A minimal driver: acquire the shared lock with a distinct request id and this
// process's own (live) pid, then print the numeric rc. isAlive is fixed true —
// both racers ARE live, so the arbiter is purely the atomic create (a loser reads
// the winner's LIVE different-request lock → "different" → 10).
function driverSource(lockPath: string, reqId: string): string {
  return [
    `import { acquireActiveLockAt } from ${JSON.stringify(LOCK_MODULE)};`,
    `const rc = acquireActiveLockAt({`,
    `  lockPath: ${JSON.stringify(lockPath)},`,
    `  requestId: ${JSON.stringify(reqId)},`,
    `  ownerPid: String(process.pid),`,
    `  lockBody: JSON.stringify({ pid: process.pid, request_id: ${JSON.stringify(reqId)} }) + "\\n",`,
    `  isAlive: () => true,`,
    `});`,
    `process.stdout.write(String(rc));`,
  ].join("\n");
}

function runDriver(path: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.on("close", () => resolve(out.trim()));
  });
}

test("W-169 (f): two real racers — exactly one wins the active.lock, the other backs off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mg-race-"));
  try {
    const lockPath = join(dir, "active.lock");
    const d1 = join(dir, "d1.ts"); writeFileSync(d1, driverSource(lockPath, "req-A"));
    const d2 = join(dir, "d2.ts"); writeFileSync(d2, driverSource(lockPath, "req-B"));

    const [rc1, rc2] = await Promise.all([runDriver(d1), runDriver(d2)]);

    // Exactly one winner (rc 0) and one back-off (rc 10/11) — never two winners.
    expect([rc1, rc2].filter((r) => r === "0").length, `rc1=${rc1} rc2=${rc2}`).toBe(1);
    expect([rc1, rc2].filter((r) => r === "10" || r === "11").length, `rc1=${rc1} rc2=${rc2}`).toBe(1);

    // The surviving lock belongs to the winner (a real request id, well-formed).
    expect(existsSync(lockPath)).toBe(true);
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { request_id: string };
    expect(["req-A", "req-B"]).toContain(held.request_id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
