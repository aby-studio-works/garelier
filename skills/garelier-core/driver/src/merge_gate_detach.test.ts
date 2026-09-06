import { rm } from "./guard/path_guard.ts";
// W-087 — merge-gate spawn detach regression.
//
// The submit path is: PM Bash tool → merge_request.ts → `POLL_OUT="$(bun
// dock_merge.ts poll)"` (command substitution) → pollMergeGate → defaultSpawn.
// Two failure modes, both observed on Windows/Git-Bash (3 live incidents
// 2026-07-06), were caused by the old `Bun.spawn` gate launch:
//   1. Bun.spawn kept the poll `bun` process alive until the gate CHILD exited, so
//      the command substitution BLOCKED for the whole gate (a multi-minute cargo
//      build). The submit Bash tool then hit its timeout and the harness
//      tree-killed everything — the gate's cargo died silently, no result, orphan
//      lock (W-063 had to sweep it).
//   2. Bun.spawn ALSO kills its child when the bun process exits, so a naive
//      unref() would return fast but silently kill the gate before it ran.
//
// The fix (defaultSpawn via node:child_process spawn { detached:true,
// stdio:"ignore" } + unref()) must give BOTH: the spawning process returns
// immediately, AND the gate runs to completion after that process is gone.
//
// This drives the REAL defaultSpawn from a subprocess (the pollMergeGate tests
// inject spawnFn and bypass it, so only a subprocess covers the actual OS detach).
// It pins both properties and discriminates all three implementations:
//   old Bun.spawn (no unref) → parent BLOCKS ⇒ fast-return assertion fails.
//   Bun.spawn + unref        → gate KILLED  ⇒ survival assertion fails.
//   node detached + unref    → both hold    ⇒ passes.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const srcDir = import.meta.dir; // where merge_gate.ts lives, for the subprocess import
const CLEANUP_TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const CLEANUP_MAX_ATTEMPTS = 40;
const CLEANUP_RETRY_DELAY_MS = 50;

async function cleanupDir(path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !CLEANUP_TRANSIENT_CODES.has(code ?? "") || attempt >= CLEANUP_MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_DELAY_MS));
    }
  }
}

function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let watcher: ReturnType<typeof watch> | undefined;
    const timer = setTimeout(() => {
      watcher?.close();
      reject(new Error(`timed out waiting for ${path}`));
    }, timeoutMs);
    const finish = () => {
      if (!existsSync(path)) return;
      clearTimeout(timer);
      watcher?.close();
      resolve();
    };
    watcher = watch(dirname(path), finish);
    finish();
  });
}

test("defaultSpawn fully detaches the gate: parent returns immediately AND the gate survives the parent's exit (W-087)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "garelier-mg-detach-"));
  try {
    const markerBase = join(dir, "gate"); // gate writes <base>.started then <base>.done
    const startedMarker = `${markerBase}.started`;
    const doneMarker = `${markerBase}.done`;
    const releaseMarker = `${markerBase}.release`;
    // The dummy gate marks readiness, then blocks on an explicit release file.
    // A broken blocking parent reaches only the short fail deadline; a healthy
    // detached parent returns immediately and the test releases the child.
    const gateTs = join(dir, "gate.ts");
    writeFileSync(gateTs,
      `import { existsSync, watch, writeFileSync } from "node:fs";\n` +
      `import { dirname } from "node:path";\n` +
      `const marker = process.argv[2];\n` +
      `writeFileSync(marker + ".started", "started\\n");\n` +
      `const release = marker + ".release";\n` +
      `if (!existsSync(release)) await new Promise((resolve, reject) => {\n` +
      `  let watcher;\n` +
      `  const timer = setTimeout(() => { watcher?.close(); reject(new Error("release deadline")); }, 10_000);\n` +
      `  const finish = () => { if (!existsSync(release)) return; clearTimeout(timer); watcher?.close(); resolve(); };\n` +
      `  watcher = watch(dirname(release), finish);\n` +
      `  finish();\n` +
      `});\n` +
      `writeFileSync(marker + ".done", "done\\n");\n`,
    );

    // Subprocess that calls the REAL defaultSpawn and then exits. Paths go through
    // env (no fragile path escaping into the -e source). cwd = srcDir so the
    // relative import resolves.
    const code =
      'const { defaultSpawn } = await import("./merge_gate.ts");' +
      'defaultSpawn(process.env.GATE_SH, [process.env.MARKER_BASE], process.env.WORK_DIR, process.env);';
    const t0 = Date.now();
    const proc = Bun.spawn(["bun", "-e", code], { windowsHide: true,
      cwd: srcDir,
      env: { ...process.env, GATE_SH: gateTs, MARKER_BASE: markerBase, WORK_DIR: dir },
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    const parentElapsedMs = Date.now() - t0;

    // (1) The spawner exits before the controlled child is released. A blocking
    // spawn can return only when the child's 10s fail deadline fires.
    const PARENT_RETURN_BOUND_MS = 8_000;
    expect(parentElapsedMs).toBeLessThan(PARENT_RETURN_BOUND_MS);

    // (2) Readiness and completion are event-driven. The child must still be
    // blocked after the spawner exits, then complete only after explicit release.
    await waitForFile(startedMarker);
    expect(existsSync(doneMarker)).toBe(false);
    writeFileSync(releaseMarker, "release\n");
    await waitForFile(doneMarker);
    expect(existsSync(doneMarker)).toBe(true);
  } finally {
    await cleanupDir(dir);
  }
}, 25_000);
