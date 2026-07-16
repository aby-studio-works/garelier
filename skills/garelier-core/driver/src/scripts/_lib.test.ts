import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonEscape, pmCandidates, readTomlQuoted, readTomlScalar, readTomlStringArray, shellQuote, utcCompact } from "./_lib.ts";

let temp = "";
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

describe("script compatibility helpers", () => {
  test("JSON escaping matches the shell helpers", () => {
    expect(jsonEscape('a\\b"c\nnext')).toBe('a\\\\b\\"c\\nnext');
  });

  test("reads the shell scripts' intentionally narrow TOML shapes", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-script-lib-"));
    const path = join(temp, "setup_config.toml");
    writeFileSync(path,
      '[branches]\nintegration = "garelier/main/tpm/studio"\n' +
      '[merge_gate]\ngate_ceiling_minutes = 12 # bounded\n' +
      'preflight_commands = ["echo one", "echo two"]\n');
    expect(readTomlQuoted(path, "integration")).toBe("garelier/main/tpm/studio");
    expect(readTomlScalar(path, "merge_gate", "gate_ceiling_minutes")).toBe("12");
    expect(readTomlStringArray(path, "preflight_commands")).toEqual(["echo one", "echo two"]);
  });

  test("UTC request prefix keeps the legacy second-resolution form", () => {
    expect(utcCompact(new Date("2026-07-16T09:08:07Z"))).toBe("20260716-090807");
  });

  test("shell quoting preserves both legacy serialization styles", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote("echo", "printf-q")).toBe("echo");
    expect(shellQuote("status hello", "printf-q")).toBe("status\\ hello");
  });

  test("PM candidates recognize both setup and control-only namespaces", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-script-lib-"));
    mkdirSync(join(temp, "zeta", "_pm"), { recursive: true });
    writeFileSync(join(temp, "zeta", "_pm", "setup_config.toml"), "");
    mkdirSync(join(temp, "alpha", "control"), { recursive: true });
    writeFileSync(join(temp, "alpha", "control", "control.toml"), "");
    mkdirSync(join(temp, "ignored"), { recursive: true });
    expect(pmCandidates(temp)).toEqual(["alpha", "zeta"]);
  });
});
