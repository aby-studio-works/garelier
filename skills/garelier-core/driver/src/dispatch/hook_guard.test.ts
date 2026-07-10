import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedHookCommand, hookGuardScript } from "./hook_guard.ts";

// bash (MSYS/Git Bash on Windows) reads `[ -f "C:\path" ]` unreliably because the
// backslashes are shell escapes; convert to mixed form (C:/path) exactly as the
// W-035 runtime_recovery_hook.test.sh does. No-op where cygpath is absent.
function bashPath(p: string): string {
  const r = spawnSync("cygpath", ["-m", p], { encoding: "utf8" });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : p;
}

// Run just the guard script body (the part `bash -c '<...>'` executes) under bash
// with the given stdin, so we exercise the real probe/exec logic Claude Code runs.
function runGuard(runner: string, hookPath: string, input: string) {
  return spawnSync("bash", ["-c", hookGuardScript(runner, hookPath)], { input, encoding: "utf8" });
}

test("guardedHookCommand wraps the guard script in bash -c", () => {
  expect(guardedHookCommand("bash", "/h/task_mirror_hook.sh")).toBe(
    `bash -c '[ -f "/h/task_mirror_hook.sh" ] && exec bash "/h/task_mirror_hook.sh" || exit 0'`,
  );
  expect(guardedHookCommand("bun", "/h/runtime_recovery_hook.ts")).toBe(
    `bash -c '[ -f "/h/runtime_recovery_hook.ts" ] && exec bun "/h/runtime_recovery_hook.ts" || exit 0'`,
  );
});

test("(b) missing hook file exits 0 with no output", () => {
  const dir = bashPath(mkdtempSync(join(tmpdir(), "guard-")));
  const r = runGuard("bash", `${dir}/gone_task_mirror_hook.sh`, '{"hook_event_name":"PostToolUse"}');
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe("");
});

test("(c) present hook receives the event JSON on stdin", () => {
  const raw = mkdtempSync(join(tmpdir(), "guard-"));
  const dir = bashPath(raw);
  // Hook echoes its stdin so the test can confirm passthrough.
  const hook = `${dir}/task_mirror_hook.sh`;
  writeFileSync(join(raw, "task_mirror_hook.sh"), "#!/usr/bin/env bash\ncat\n");
  chmodSync(join(raw, "task_mirror_hook.sh"), 0o755);
  const event = '{"hook_event_name":"PostToolUse","tool_name":"Bash"}';
  const r = runGuard("bash", hook, event);
  expect(r.status).toBe(0);
  expect(r.stdout).toBe(event);
});

test("present hook's exit code passes through (exec, not swallowed by || exit 0)", () => {
  // A runtime_recovery SubagentStop block can exit non-zero; exec must propagate
  // it rather than the guard masking it with exit 0.
  const raw = mkdtempSync(join(tmpdir(), "guard-"));
  const dir = bashPath(raw);
  const hook = `${dir}/runtime_recovery_hook.sh`;
  writeFileSync(join(raw, "runtime_recovery_hook.sh"), "#!/usr/bin/env bash\nexit 2\n");
  chmodSync(join(raw, "runtime_recovery_hook.sh"), 0o755);
  const r = runGuard("bash", hook, "{}");
  expect(r.status).toBe(2);
});
