import { rmSync } from "../guard/path_guard.ts";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBashExecutable } from "./_lib.ts";
import { runGateCommand } from "./gate_command.ts";

let temp = "";
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

test("W-143: Windows sanitized PATH runs leading bash via the explicit Git Bash override", async () => {
  if (process.platform !== "win32") return;
  const resolvedBash = resolveBashExecutable();
  expect(resolvedBash).not.toBeNull();
  temp = mkdtempSync(join(tmpdir(), "garelier gate path spaces "));
  const scriptDir = join(temp, "script path with spaces");
  mkdirSync(scriptDir, { recursive: true });
  const script = join(scriptDir, "verify args.sh");
  const out = join(temp, "stdout");
  const err = join(temp, "stderr");
  writeFileSync(script, '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$1" "$2"\n');
  chmodSync(script, 0o755);
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "path") delete childEnv[key];
  childEnv.PATH = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;
  childEnv.GARELIER_BASH = resolvedBash!;
  const command = `bash "${script.replace(/\\/g, "/")}" --verify "value with spaces"`;

  expect(await runGateCommand(command, out, err, 30, 1, childEnv)).toBe(0);
  expect(readFileSync(out, "utf8").trim()).toBe("--verify|value with spaces");
  expect(readFileSync(err, "utf8")).toBe("");
}, 30_000);

test("Windows sanitized PATH runs a fake configured gate by its resolved absolute path", async () => {
  if (process.platform !== "win32") return;
  const resolvedBash = resolveBashExecutable();
  expect(resolvedBash).not.toBeNull();
  temp = mkdtempSync(join(tmpdir(), "garelier fake gate "));
  const fakeDir = join(temp, "fake tools with spaces");
  mkdirSync(fakeDir, { recursive: true });
  const fake = join(fakeDir, "custom-gate");
  const out = join(temp, "stdout");
  const err = join(temp, "stderr");
  writeFileSync(fake, '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$1" "$2"\n');
  chmodSync(fake, 0o755);
  const childEnv: Record<string, string | undefined> = {
    GARELIER_BASH: resolvedBash!,
    PATH: `${fakeDir};${process.env.SystemRoot ?? "C:\\Windows"}\\System32`,
  };

  expect(await runGateCommand('custom-gate --verify "value with spaces"', out, err, 30, 1, childEnv)).toBe(0);
  expect(readFileSync(out, "utf8").trim()).toBe("--verify|value with spaces");
  expect(readFileSync(err, "utf8")).toBe("");
}, 30_000);

test("Windows sanitized PATH resolves cargo and keeps later compound cargo steps runnable", async () => {
  if (process.platform !== "win32") return;
  const resolvedBash = resolveBashExecutable();
  expect(resolvedBash).not.toBeNull();
  temp = mkdtempSync(join(tmpdir(), "garelier compound cargo gate "));
  const fakeDir = join(temp, "cargo tools with spaces");
  mkdirSync(fakeDir, { recursive: true });
  const fakeCargo = join(fakeDir, "cargo");
  const out = join(temp, "stdout");
  const err = join(temp, "stderr");
  writeFileSync(fakeCargo, '#!/bin/bash\nprintf "%s|%s\\n" "$RUSTC_WRAPPER" "$1"\n');
  chmodSync(fakeCargo, 0o755);
  const childEnv: Record<string, string | undefined> = {
    GARELIER_BASH: resolvedBash!,
    GARELIER_CARGO: fakeCargo,
    PATH: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`,
  };

  const code = await runGateCommand("RUSTC_WRAPPER= cargo first && cargo second", out, err, 30, 1, childEnv);
  expect(code, `${readFileSync(out, "utf8")}\n${readFileSync(err, "utf8")}`).toBe(0);
  expect(readFileSync(out, "utf8").trim().split(/\r?\n/)).toEqual(["|first", "|second"]);
  expect(readFileSync(err, "utf8")).toBe("");
}, 30_000);
