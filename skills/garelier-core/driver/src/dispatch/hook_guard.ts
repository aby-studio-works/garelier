// hook_guard.ts — build a self-guarding hook command (W-037).
//
// Claude Code pipes the event JSON to a hook's stdin and acts on its exit code
// (and, for decision events, its stdout JSON). A bare `bash "<hook>"` /
// `bun "<hook>"` command errors on EVERY intercepted tool call once the hook file
// is gone — e.g. the garelier repo was deleted (or its skills unlinked) without
// running teardown. Wrapping the invocation so the file is probed first turns that
// runaway error into a silent no-op.
//
// `exec` is load-bearing twice over: it hands the current stdin (the event JSON)
// to the hook unchanged, and it makes the hook's own exit code — and stdout — the
// command's, so a runtime_recovery SubagentStop block decision still propagates.
// The `|| exit 0` only fires when the `[ -f ]` probe fails (file absent); once
// `exec` succeeds it has replaced the process, so it never swallows the hook's
// real exit code.
//
// The hook path is framework-controlled (it points into the installed
// garelier-core skills directory), never user input, so — as with the prior
// direct-write form — it is embedded double-quoted without further escaping.
import { requireRuntimeExecutable } from "../scripts/_lib.ts";

function bashDoubleQuoted(value: string): string {
  return `"${value.replace(/\\/g, "/").replace(/(["$`\\])/g, "\\$1")}"`;
}

function bashSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Guard script body: run `<runner> "<hookPath>"` when the file exists, else
 *  `exit 0` silently. `exec` preserves stdin, stdout, and exit-code passthrough. */
export function hookGuardScript(runner: string, hookPath: string): string {
  return `[ -f ${bashDoubleQuoted(hookPath)} ] && exec ${bashDoubleQuoted(runner)} ${bashDoubleQuoted(hookPath)} || exit 0`;
}

/** Full guarded command as stored in a settings hook entry: the guard script run
 *  through `bash -c`. */
export function guardedHookCommand(
  runner: "bash" | "bun",
  hookPath: string,
  executables: { bash?: string; runner?: string } = {},
): string {
  const bash = executables.bash ?? requireRuntimeExecutable("bash");
  const resolvedRunner = executables.runner ?? (runner === "bash" ? bash : requireRuntimeExecutable("bun"));
  return `${bashDoubleQuoted(bash)} -c ${bashSingleQuoted(hookGuardScript(resolvedRunner, hookPath))}`;
}
