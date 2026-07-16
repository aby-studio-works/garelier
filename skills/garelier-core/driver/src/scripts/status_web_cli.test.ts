import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let temp = "";
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

function run(file: string, args: string[]) {
  const result = Bun.spawnSync(["bun", join(import.meta.dir, file), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

describe("consolidated Status Web command", () => {
  for (const [legacy, action] of [
    ["start_status.ts", "start"],
    ["stop_status.ts", "stop"],
    ["status_web_status.ts", "status"],
  ] as const) {
    test(`${legacy} remains byte-compatible with the ${action} subcommand`, () => {
      expect(run(legacy, ["--help"])).toEqual(run("status_web_cli.ts", [action, "--help"]));
    });
  }

  test("rejects an unknown subcommand", () => {
    const result = run("status_web_cli.ts", ["unknown"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("start|stop|status");
  });

  test("auto-detects one PM and preserves stop/status no-pid behavior", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-status-cli-"));
    const control = join(temp, "__garelier", "demo", "control");
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, "control.toml"), "version = 1\n");

    expect(run("status_web_cli.ts", ["stop", "--project", temp])).toEqual({
      code: 0,
      out: "No status console pidfile for PM 'demo' — not running. Nothing to stop.\n",
      err: "",
    });
    expect(run("status_web_cli.ts", ["status", "--project", temp])).toEqual({
      code: 1,
      out: "Status console for PM 'demo': DOWN (no pidfile).\n",
      err: "",
    });
  });
});
