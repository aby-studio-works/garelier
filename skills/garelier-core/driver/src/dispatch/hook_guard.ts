// hook_guard.ts — build a self-guarding hook command (W-037).
//
// Claude Code pipes the event JSON to a hook's stdin and acts on its exit code
// (and, for decision events, its stdout JSON). A bare `bash "<hook>"` /
// `bun "<hook>"` command errors on EVERY intercepted tool call once the hook file
// is gone — e.g. the garelier repo was deleted (or its skills unlinked) without
// running teardown. Wrapping the invocation so the file is probed first turns that
// runaway error into a silent no-op.
//
// Blocking lifecycle events use `exec`: it hands the current stdin (the event
// JSON) to the hook unchanged and preserves its stdout + exit code, so a
// runtime_recovery SubagentStop block decision still propagates. Advisory events
// use the separate fail-open wrapper below: stdout still streams unchanged, but
// a missing, failed, thrown, or timed-out hook can never block the intercepted
// operation.
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

/** Advisory hook body: preserve supported stdout JSON while normalizing every
 * hook failure to exit 0. GNU timeout is supplied by Git for Windows; its child
 * deadline stays below the hook entry's outer timeout so a hung child is reaped
 * before Claude Code can classify the hook command itself as failed. If timeout
 * is unavailable or fails, `|| exit 0` still preserves the fail-open contract. */
export function failOpenHookGuardScript(runner: string, hookPath: string, timeoutSeconds = 9): string {
  const seconds = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 9;
  return `if [ ! -f ${bashDoubleQuoted(hookPath)} ]; then exit 0; fi; ` +
    `timeout --signal=KILL ${seconds}s ${bashDoubleQuoted(runner)} ${bashDoubleQuoted(hookPath)} || exit 0; exit 0`;
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

/** Full advisory command. Unlike guardedHookCommand(), this is intentionally
 * fail-open and must only be used for warning-only hook events. */
export function failOpenGuardedHookCommand(
  runner: "bash" | "bun",
  hookPath: string,
  executables: { bash?: string; runner?: string } = {},
  timeoutSeconds = 9,
): string {
  const bash = executables.bash ?? requireRuntimeExecutable("bash");
  const resolvedRunner = executables.runner ?? (runner === "bash" ? bash : requireRuntimeExecutable("bun"));
  return `${bashDoubleQuoted(bash)} -c ${bashSingleQuoted(failOpenHookGuardScript(resolvedRunner, hookPath, timeoutSeconds))}`;
}
