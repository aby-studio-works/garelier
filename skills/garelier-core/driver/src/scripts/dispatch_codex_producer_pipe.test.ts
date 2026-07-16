import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// W-095 (g): SIGPIPE / output-truncation resilience for the codex launcher.
// Real incident 2026-07-16: piping the launcher through `| head` closed the
// read end of its stdout pipe, and the next write raised an unhandled EPIPE
// that killed the launcher mid-dispatch. installPipeGuards() must swallow EPIPE
// (exit 0) while re-throwing genuine stream faults. These drive real bun
// subprocesses (the faithful surface — EPIPE only manifests across a real pipe).

const MODULE = join(dirname(fileURLToPath(import.meta.url)), "dispatch_codex_producer.ts").replace(/\\/g, "/");

// Write a throwaway .ts entry that imports the guard, run it, return exit code.
function runFixture(body: string, pipeThroughHead: boolean): number {
  const dir = mkdtempSync(join(tmpdir(), "dcp-pipe-"));
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, `import { installPipeGuards } from ${JSON.stringify(MODULE)};\n${body}\n`);
    const entryPosix = entry.replace(/\\/g, "/");
    if (pipeThroughHead) {
      // `${bun} entry | head -c 8` — head reads 8 bytes then closes the pipe, so
      // the launcher's ongoing writes hit a broken pipe. PIPESTATUS[0] is the
      // launcher's own exit; the guard must make it 0.
      const r = Bun.spawnSync([
        "bash",
        "-c",
        `bun "${entryPosix}" | head -c 8 >/dev/null; exit "\${PIPESTATUS[0]}"`,
      ], { stdout: "pipe", stderr: "pipe" });
      return r.exitCode;
    }
    return Bun.spawnSync(["bun", entry], { stdout: "pipe", stderr: "pipe" }).exitCode;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W-095(g): a synthetic EPIPE on stdout is swallowed -> exit 0", () => {
  const code = runFixture(
    `installPipeGuards();
     const e = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
     process.stdout.emit("error", e);
     // if the guard did NOT exit(0), fall through to a non-zero marker
     process.exit(7);`,
    false,
  );
  expect(code).toBe(0);
});

test("W-095(g): a NON-EPIPE stream error is re-thrown, not silently eaten", () => {
  const code = runFixture(
    `installPipeGuards();
     const e = Object.assign(new Error("real fault"), { code: "ENOSPC" });
     process.stdout.emit("error", e);
     process.exit(0);`,
    false,
  );
  // re-throwing an unhandled 'error' aborts the process with a non-zero code.
  expect(code).not.toBe(0);
});

test("W-095(g): real `| head` truncation does not kill the launcher (exit 0)", () => {
  const code = runFixture(
    `installPipeGuards();
     // Flood stdout across the event loop so the broken-pipe 'error' can be
     // delivered (a tight sync loop would never yield to fire it).
     let n = 0;
     const tick = () => {
       for (let i = 0; i < 50; i++) process.stdout.write("x".repeat(65536));
       if (++n < 200) setTimeout(tick, 0); else process.exit(0);
     };
     tick();`,
    true,
  );
  expect(code).toBe(0);
});
