import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGateCommand } from "./scripts/gate_command.ts";

// W-094: verify the executable TypeScript helper directly. The old oracle sed-
// extracted dead Bash from merge-gate.sh after its exec, forcing duplicate code.

let temp = "";
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

function files(): { out: string; err: string } {
  temp = mkdtempSync(join(tmpdir(), "garelier-gate-timeout-"));
  return { out: join(temp, "stdout"), err: join(temp, "stderr") };
}

describe("runGateCommand (TypeScript implementation, W-063/W-094)", () => {
  test("bounds a TERM-ignoring command and escalates when needed", async () => {
    const { out, err } = files();
    const started = Date.now();
    const code = await runGateCommand('trap "" TERM; while :; do :; done', out, err, 1, 1);
    const elapsed = Date.now() - started;
    expect([124, 137]).toContain(code);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(8_000);
  }, 15_000);

  test("preserves the real exit code of a fast command", async () => {
    const { out, err } = files();
    expect(await runGateCommand("exit 7", out, err, 30, 1)).toBe(7);
  });

  test("captures stdout for a fast success", async () => {
    const { out, err } = files();
    expect(await runGateCommand("echo captured-stdout", out, err, 30, 1)).toBe(0);
    expect(readFileSync(out, "utf8").trim()).toBe("captured-stdout");
    expect(readFileSync(err, "utf8")).toBe("");
  });
});
