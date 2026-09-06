import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failOpenHookGuardScript, guardedHookCommand, hookGuardScript } from "./hook_guard.ts";
import { agentPreToolUseRuntimeRecoveryCommand, hasRuntimeRecoveryHook, mergeRuntimeRecoveryHook } from "./install_runtime_recovery_hook.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";
import { attendedSpawnWarning } from "../../../hooks/runtime_recovery_hook.ts";
import { buildSnapshot } from "../status_snapshot.ts";
import { doctorHasRuntimeRecoveryHook } from "../scripts/doctor.ts";
import { roleProfile } from "./attended_seat.ts";

// bash (MSYS/Git Bash on Windows) reads `[ -f "C:\path" ]` unreliably because the
// backslashes are shell escapes; convert to mixed form (C:/path) exactly as the
// W-035 runtime_recovery_hook.test.ts does. No-op where cygpath is absent.
function bashPath(p: string): string {
  return process.platform === "win32" ? p.replace(/\\/g, "/") : p;
}

// Run just the guard script body (the part `bash -c '<...>'` executes) under bash
// with the given stdin, so we exercise the real probe/exec logic Claude Code runs.
function runGuard(runner: string, hookPath: string, input: string) {
  return spawnSync(requireRuntimeExecutable("bash"), ["-c", hookGuardScript(runner, hookPath)], { windowsHide: true, input, encoding: "utf8" });
}

test("guardedHookCommand wraps the guard script in bash -c", () => {
  const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const bun = "C:\\Runtime Tools\\bun.exe";
  expect(guardedHookCommand("bash", "/h/task_mirror_hook.sh", { bash, runner: bash })).toBe(
    `"C:/Program Files/Git/bin/bash.exe" -c '[ -f "/h/task_mirror_hook.sh" ] && exec "C:/Program Files/Git/bin/bash.exe" "/h/task_mirror_hook.sh" || exit 0'`,
  );
  expect(guardedHookCommand("bun", "/h/runtime_recovery_hook.ts", { bash, runner: bun })).toBe(
    `"C:/Program Files/Git/bin/bash.exe" -c '[ -f "/h/runtime_recovery_hook.ts" ] && exec "C:/Runtime Tools/bun.exe" "/h/runtime_recovery_hook.ts" || exit 0'`,
  );
  expect(agentPreToolUseRuntimeRecoveryCommand("/h/runtime_recovery_hook.ts", { bash, runner: bun })).toBe(
    `"C:/Program Files/Git/bin/bash.exe" -c 'if [ ! -f "/h/runtime_recovery_hook.ts" ]; then exit 0; fi; timeout --signal=KILL 9s "C:/Runtime Tools/bun.exe" "/h/runtime_recovery_hook.ts" || exit 0; exit 0'`,
  );
  const settings = mergeRuntimeRecoveryHook({}, "/h/runtime_recovery_hook.ts");
  const hookSettings = settings.hooks as Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; timeout?: number }> }>>;
  const preToolUse = hookSettings.PreToolUse;
  expect(preToolUse.some((entry) => entry.matcher === "Agent" && entry.hooks?.some((hook) =>
    hook.command?.includes("timeout --signal=KILL 9s") && hook.timeout === 10,
  ))).toBe(true);
  expect(hookSettings.SubagentStop.some((entry) => entry.hooks?.some((hook) =>
    hook.command?.includes("&& exec") && hook.timeout === undefined,
  ))).toBe(true);
  expect(hasRuntimeRecoveryHook(settings)).toBe(true);
  expect(doctorHasRuntimeRecoveryHook([settings])).toBe(true);
  const staleSettings = structuredClone(settings);
  const stalePreToolUse = (staleSettings.hooks as Record<string, Array<{ matcher?: string }>>).PreToolUse;
  stalePreToolUse.find((entry) => entry.matcher === "Agent")!.matcher = "Bash";
  expect(hasRuntimeRecoveryHook(staleSettings)).toBe(false);
  expect(doctorHasRuntimeRecoveryHook([staleSettings])).toBe(false);
  expect(hasRuntimeRecoveryHook(mergeRuntimeRecoveryHook(staleSettings, "/h/runtime_recovery_hook.ts"))).toBe(true);

  const root = mkdtempSync(join(tmpdir(), "attended-spawn-warning-"));
  const meta = join(root, "__garelier", "pm", "_crew", "lanes", ".meta");
  mkdirSync(meta, { recursive: true });
  const warning = attendedSpawnWarning(root, "ga-scout-missing-record");
  expect(warning).toContain("dispatch_prepare.ts --attended-seat --role <role> --slug <slug> --worktree <path>");
  expect(warning).toContain("profile_unknown");
  expect(warning).toContain("no-output idle");
  expect(warning).toContain("Do not decide from a role enumeration");
  const incidents = join(root, "__garelier", "pm", "runtime", "hooks", "incidents.jsonl");
  mkdirSync(join(root, "__garelier", "pm", "runtime", "hooks"), { recursive: true });
  writeFileSync(incidents, JSON.stringify({
    kind: "guard_missing_attended_record", status: "open", action: "warn",
    rule: "dispatch_prepare_record_missing", command: "Agent name=ga-scout-missing-record",
    resolved_agent: "ga-scout-missing-record", created_at: "2026-08-13T00:00:00.000Z",
  }) + "\n");
  const status = buildSnapshot(root, "pm", null).pmAction;
  expect(status.guardReports).toBe(1);
  expect(status.items.some((item) => item.kind === "guard_report" && item.summary.includes("dispatch_prepare_record_missing"))).toBe(true);

  // F1: dispatch_prepare records the Worker identity in context.json rather than
  // in a same-name .meta file. The pre-spawn check must resolve it exactly as
  // command_guard does, or every canonical Worker launch becomes a false warning.
  const container = join(root, "__garelier", "pm", "_crew", "dispatch98");
  const checkout = join(container, "checkout");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(container, "context.json"), JSON.stringify({
    guard: {
      permission_profile: "role",
      fence_roots: [checkout],
      role: "worker",
      agent_name: "ga-worker-w434-spawn-guard-hook",
      worktree: checkout,
    },
  }) + "\n");
  expect(attendedSpawnWarning(root, "ga-worker-w434-spawn-guard-hook")).toBeNull();

  // A lane record may also be slug-keyed: its filename need not equal agent_name.
  writeFileSync(join(meta, "w862-pointer.dispatch.json"), JSON.stringify({
    source: "attended_record",
    guard: {
      permission_profile: "role",
      fence_roots: [root],
      role: "worker",
      agent_name: "ga-worker-w862-pointer",
      worktree: root,
    },
  }) + "\n");
  expect(attendedSpawnWarning(root, "ga-worker-w862-pointer")).toBeNull();

  // F4: every managed Garelier role that can be an Agent seat is accepted and
  // receives its canonical command_guard profile; unknown roles remain rejected.
  expect([
    "pm", "dock", "artisan", "worker", "scout", "smith", "librarian",
    "observer", "guardian", "concierge",
  ].map(roleProfile)).toEqual([
    "baseline-destructive", "baseline-destructive", "role", "role", "scout",
    "role", "role", "gate", "gate", "concierge",
  ]);
  expect(() => roleProfile("unknown-role")).toThrow("managed Garelier role");
});

test("(b) missing hook file lets Agent spawn proceed with no output", () => {
  const dir = bashPath(mkdtempSync(join(tmpdir(), "guard-")));
  const r = runGuard("bash", `${dir}/gone_runtime_recovery_hook.ts`, '{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"name":"ga-scout-no-hook"}}');
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

test("Agent PreToolUse stays fail-open on a present hook throw or timeout", () => {
  const raw = mkdtempSync(join(tmpdir(), "guard-"));
  const dir = bashPath(raw);
  const hook = `${dir}/runtime_recovery_hook.ts`;
  writeFileSync(join(raw, "runtime_recovery_hook.ts"), [
    'process.stdout.write(\'{"systemMessage":"warning survived"}\\n\');',
    'throw new Error("intentional throw");',
    "",
  ].join("\n"));
  const bun = requireRuntimeExecutable("bun");
  const thrown = spawnSync(requireRuntimeExecutable("bash"), ["-c", failOpenHookGuardScript(bun, hook, 1)], {
    windowsHide: true, input: '{"hook_event_name":"PreToolUse","tool_name":"Agent"}', encoding: "utf8",
  });
  expect(thrown.status).toBe(0);
  expect(thrown.stdout).toBe('{"systemMessage":"warning survived"}\n');
  expect(thrown.stderr).toContain("intentional throw");

  writeFileSync(join(raw, "runtime_recovery_hook.ts"), "await Bun.sleep(2_000);\n");
  const timedOut = spawnSync(requireRuntimeExecutable("bash"), ["-c", failOpenHookGuardScript(bun, hook, 0.1)], {
    windowsHide: true, input: '{}', encoding: "utf8", timeout: 5_000,
  });
  expect(timedOut.status).toBe(0);
});
