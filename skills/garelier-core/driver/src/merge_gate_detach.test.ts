import { rmSync } from "./guard/path_guard.ts";
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
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const srcDir = import.meta.dir; // where merge_gate.ts lives, for the subprocess import

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("defaultSpawn fully detaches the gate: parent returns immediately AND the gate survives the parent's exit (W-087)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "garelier-mg-detach-"));
  try {
    // W-056: GATE_SECONDS=5 with a 3000ms parent-return bound left only ~2s of
    // slack above bun-startup-under-load before conflating "detached" with
    // "blocked" — measured 3339ms once under parallel CI load (isolated rerun
    // passed). Widen GATE_SECONDS so the blocking-vs-detached gap stays wide (a
    // truly blocking spawn takes the FULL gate duration — minutes in real
    // production, here the full GATE_SECONDS sleep) even with a generous
    // parent-return bound (below): 20s sleep vs a 10s ceiling is still a clean
    // 2x discrimination margin, comfortably load-tolerant.
    const GATE_SECONDS = 20;
    const markerBase = join(dir, "gate"); // gate writes <base>.started then <base>.done
    const startedMarker = `${markerBase}.started`;
    const doneMarker = `${markerBase}.done`;
    // The dummy gate: mark start, sleep several seconds (stand-in for a cargo
    // build), mark done. No real cargo — only its lifetime matters here.
    const gateTs = join(dir, "gate.ts");
    writeFileSync(gateTs,
      `import { writeFileSync } from "node:fs";\n` +
      `const marker = process.argv[2];\n` +
      `writeFileSync(marker + ".started", "started\\n");\n` +
      `await Bun.sleep(${GATE_SECONDS * 1000});\n` +
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

    // (1) The spawning process returned WELL BEFORE the gate finished. bun startup +
    // module import is the floor (~sub-second, generously a couple seconds under
    // heavy parallel CI load); the gate sleeps GATE_SECONDS. The old blocking
    // Bun.spawn would have returned only after ~GATE_SECONDS*1000ms — a genuinely
    // blocking spawn here would take ~20000ms, so a 10000ms ceiling (W-056) still
    // cleanly discriminates it from a healthy detached return while absorbing
    // load-induced startup jitter that a tighter 3000ms bound did not (measured
    // 3339ms once under parallel load).
    const PARENT_RETURN_BOUND_MS = 10_000;
    expect(parentElapsedMs).toBeLessThan(PARENT_RETURN_BOUND_MS);
    expect(GATE_SECONDS * 1000).toBeGreaterThan(PARENT_RETURN_BOUND_MS); // guard: the window is real

    // (2) The detached gate keeps running after its spawner is gone and records its
    // result. Poll for the done marker past the gate's own runtime.
    const deadline = Date.now() + (GATE_SECONDS + 8) * 1000;
    while (!existsSync(doneMarker) && Date.now() < deadline) await sleep(200);
    expect(existsSync(startedMarker)).toBe(true); // the gate actually ran (not killed pre-start)
    expect(existsSync(doneMarker)).toBe(true);    // and ran to completion after the parent exited
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // W-056: GATE_SECONDS=20 pushes the done-marker poll deadline to ~28s past an
  // already-generous parent-return wait; 50s keeps headroom under load.
}, 50_000);
