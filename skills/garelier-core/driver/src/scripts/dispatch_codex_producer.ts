#!/usr/bin/env bun
import { removeEmptyProbeGitDirSync, rmdirSync, unlinkSync } from "../guard/path_guard.ts";

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireRuntimeExecutable, resolveBashExecutable, resolveRuntimeExecutable } from "./_lib.ts";
import {
  acquireSessionLock,
  makeSessionRecord,
  parseCodexSessionId,
  releaseSessionLock,
  updateSessionRecord,
  writeSessionRecord,
  type ProviderSessionRecord,
  type SessionLock,
} from "./provider_session.ts";

const HELP = `Dispatch a NON-Claude producer (Codex) as a RUN-TO-COMPLETION subprocess for
the DEC-057/DEC-058 dispatch Dock. The Claude Agent/Workflow tool can
only spawn Claude subagents; this is how the interactive Dock/PM
gives a role to Codex instead: it runs \`codex exec\` SYNCHRONOUSLY in the role's
worktree, waits for completion, and prints the producer's final message so the
Dock can integrate the returned branch via the normal merge gate.

Sets the codex-cli flags (sandbox / approval_policy / model / reasoning effort)
so a Codex seat behaves like its claude-code peers under dispatch.

Usage:
  dispatch_codex_producer.ts \\
    --worktree <dir>        # role worktree (cwd; already on its branch off studio)
    --project  <dir>        # project/control root (granted via --add-dir)
    --prompt   <file>       # the role prompt (assignment) on stdin to codex
    --result   <file>       # where to capture codex's final message
    [--session-record <file>] # exact codex thread id record; default beside result
    [--sandbox read-only|workspace-write]   # default workspace-write (commit-bearing roles)
    [--model <name>] [--effort <low|medium|high|xhigh>] [--model-source <source>]
    [--skill-root <dir>]    # legacy context hint; never made writable
    [--target-root <dir>]   # Plant-Crust context hint; never made writable
    [--add-dir <dir>]       # repeatable extra grant for workspace-write

Exit code = codex exec's exit code. The final message is also echoed to stdout
between sentinels so it is easy to extract from a background-task log.
Codex --add-dir is a WRITE grant, not a read-only context grant. Project,
target, framework-skill, CODEX_HOME/skills, and context roots are therefore
never passed through it. The prompt is forwarded on stdin and checkout/context
files remain readable without making their real roots writable.
W-077: primary-checkout escape guard. The project root is no longer a broad
--add-dir, preventing writes to its SHARED .git/index. Keep the explicit prompt
prohibition as defense in depth for an operator-supplied --add-dir or a future
sandbox-policy change: all producer work stays inside its worktree cwd.
(merge-gate.ts also lossless-heals a branch-identical escape.)`;

function out(line: string): void { process.stdout.write(`${line}\n`); }
function err(line: string): void { process.stderr.write(`${line}\n`); }
function exitWith(message: string, code: number): never { err(message); process.exit(code); }

// W-095 (g): SIGPIPE / output-truncation resilience. When this launcher's stdout
// is piped into a reader that closes early (`… | head`, a log tailer that quits),
// the read end of the pipe is gone and the NEXT write raises EPIPE. An unhandled
// 'error' event on process.stdout crashes the launcher mid-dispatch — the real
// incident 2026-07-16 where `… | head` killed the launcher before it could
// surface the codex result. Swallow EPIPE (the reader is simply gone; there is
// nothing left to say) and exit cleanly; re-throw anything else so genuine
// stream faults still surface. Idempotent + additive: it only attaches error
// handlers, leaving every existing code path unchanged.
export function installPipeGuards(): void {
  const swallow = (stream: NodeJS.WriteStream): void => {
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e && e.code === "EPIPE") process.exit(0);
      throw e;
    });
  };
  swallow(process.stdout);
  swallow(process.stderr);
}

function nextValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined) exitWith(`dispatch_codex_producer.ts: line 1: $2: unbound variable`, 1);
  return value;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

// Convert an MSYS/POSIX path (e.g. /tmp/..., /c/Users/...) to a native
// "mixed" Windows path (C:/...) via cygpath -m, matching the shell helper's
// resolve_dir_native. Bun's node:fs cannot stat MSYS mount paths like /tmp
// (it reads them as C:\tmp\...), so context.json values written as raw POSIX
// strings — unlike CLI args, which MSYS auto-converts before Bun sees them —
// need this bridge. Returns "" when cygpath is absent (non-Windows) or fails.
function cygpathMixed(path: string): string {
  try {
    const cygpath = resolveRuntimeExecutable("cygpath");
    if (!cygpath) return "";
    const r = Bun.spawnSync([cygpath, "-m", path], { windowsHide: true, stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0) return r.stdout.toString().trim();
  } catch { /* cygpath not on PATH */ }
  return "";
}

function absoluteExistingDir(path: string): string {
  if (!path) return "";
  if (isDirectory(path)) {
    try { return realpathSync(path); } catch { return ""; }
  }
  const native = cygpathMixed(path);
  if (native && isDirectory(native)) {
    try { return realpathSync(native); } catch { return native; }
  }
  return "";
}

function absoluteExistingFile(path: string): string {
  if (!path || !isFile(path)) return "";
  try { return realpathSync(path); } catch { return ""; }
}

function nativeCliPath(path: string): string {
  return process.platform === "win32" ? path.replace(/\\/g, "/") : path;
}

// Directory of the REAL, symlink-resolved bun executable running this helper.
// W-093: a Codex producer's shell (Windows `elevated` sandbox) refuses to
// traverse the WinGet shim at ...\WinGet\Links\bun.exe — a reparse-point
// symlink into ...\WinGet\Packages\... — so `command -v bun` reports "not
// found" even though Links is already on PATH, breaking every bun self-check
// (bun test / bun <script>.ts). process.execPath resolves through that symlink
// to the plain bun.exe PE, whose directory the sandbox CAN exec. Returns "" if
// it cannot be resolved (bun should always know its own path).
function bunBinDir(): string {
  try {
    const dir = dirname(realpathSync(process.execPath));
    return isDirectory(dir) ? dir : "";
  } catch { return ""; }
}

// Child env with the real bun dir prepended to PATH (W-093), so `bun` resolves
// to the plain PE instead of the sandbox-opaque WinGet/Links symlink. Pairs
// with the matching --add-dir grant in main() (the sandbox needs both: the
// PATH entry to find bun, the grant to exec it — a probe confirmed PATH alone
// leaves `bun` unresolved). Mutates the existing PATH key in place (Windows may
// spell it `Path`) to avoid a duplicate.
function childEnvWithBun(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const bunDir = bunBinDir();
  if (!bunDir) return env;
  const sep = process.platform === "win32" ? ";" : ":";
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const current = env[pathKey] ?? "";
  if (!current.split(sep).some((p) => p === bunDir)) {
    env[pathKey] = current ? `${bunDir}${sep}${current}` : bunDir;
  }
  return env;
}

function resultPath(path: string): string {
  if (!path) return "";
  return nativeCliPath(resolve(path));
}

const MODEL_ALIASES: Readonly<Record<string, string>> = {
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
};

// Bare alphabetic model tokens are Garelier/operator shorthand, not full Codex
// model identifiers. Resolve only aliases whose real model name is confirmed;
// Full identifiers (gpt-*, codex-*, o3, o4-mini, provider/name, etc.) pass
// through unchanged, and an omitted --model continues to use Codex config.
export function resolveModelName(input: string): string {
  if (!input) return "";
  const resolved = MODEL_ALIASES[input.toLowerCase()];
  if (resolved) return resolved;
  if (/^[A-Za-z]+$/.test(input)) {
    throw new Error(`unknown model alias '${input}'; use a full model name or omit --model to use the Codex config default`);
  }
  return input;
}

export function assertRoutingMatches(
  context: { model: string; effort: string; source: string } | null,
  launcher: { model: string; effort: string; source: string },
): void {
  if (!context) throw new Error("context.json routing is required; refusing silent launcher inheritance");
  if (context.model !== launcher.model || context.effort !== launcher.effort || context.source !== launcher.source) {
    throw new Error(`launcher/context routing mismatch (launcher=${launcher.model}/${launcher.effort}/${launcher.source}, context=${context.model}/${context.effort}/${context.source})`);
  }
}

export function turnFailedMessage(line: string): string {
  try {
    const event = JSON.parse(line) as { type?: unknown; error?: { message?: unknown } };
    if (event.type !== "turn.failed") return "";
    const message = event.error?.message;
    return typeof message === "string" && message.trim() ? message.trim() : "turn.failed (no error message)";
  } catch {
    return "";
  }
}

async function mirrorCodexStdout(
  stream: ReadableStream<Uint8Array>,
  onSession: (sessionId: string) => void = () => {},
): Promise<{ failure: string; sessionId: string }> {
  const decoder = new TextDecoder();
  let pending = "";
  let failure = "";
  let sessionId = "";
  const inspect = (line: string): void => {
    if (!sessionId) {
      sessionId = parseCodexSessionId(line);
      if (sessionId) onSession(sessionId);
    }
    if (!failure) {
      failure = turnFailedMessage(line);
      if (failure) err(`CODEX_LAUNCH_FAILED: ${failure}`);
    }
  };

  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    process.stdout.write(text);
    pending += text;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      inspect(pending.slice(0, newline).replace(/\r$/, ""));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  const tail = decoder.decode();
  if (tail) {
    process.stdout.write(tail);
    pending += tail;
  }
  if (pending) inspect(pending.replace(/\r$/, ""));
  return { failure, sessionId };
}

// W-103/W-111 boundary contract: after each Codex run, inspect the launch cwd
// ancestry from worktree through project root, exactly ONE directory above the
// project root, and every granted --add-dir root. Remove only empty `.agents` /
// `.codex` directories. `.git` is NEVER removed, even when empty: an empty
// directory produces an attended-review warning and stays in place (M2). A
// non-empty probe directory, file, or symlink is also never touched. When
// Plant-Crust paths are not nested, fail closed to explicit anchors instead of
// walking toward filesystem root. This is Codex read-probe cleanup, not general
// dotdir cleanup.
export function sweepEmptyCodexProbeDirs(
  worktree: string,
  project: string,
  addDirRoots: readonly string[] = [],
): void {
  const worktreeAbs = resolve(worktree);
  const projectAbs = resolve(project);
  const rel = relative(projectAbs, worktreeAbs);
  const nested = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  const dirs: string[] = [];
  const add = (path: string): void => { if (!dirs.includes(path)) dirs.push(path); };

  if (nested) {
    let current = worktreeAbs;
    while (true) {
      add(current);
      if (current === projectAbs) break;
      current = dirname(current);
    }
    add(dirname(projectAbs));
  } else {
    add(worktreeAbs);
    add(projectAbs);
    add(dirname(projectAbs));
    err(`dispatch_codex_producer: probe sweep ancestry mismatch; limited to explicit anchors (worktree=${worktreeAbs}, project=${projectAbs})`);
  }
  for (const root of addDirRoots) add(resolve(root));

  const protectedGitPaths = [resolve(projectAbs, ".git"), resolve(worktreeAbs, ".git")];

  for (const dir of dirs) {
    for (const name of [".agents", ".codex"]) {
      const candidate = resolve(dir, name);
      if (!existsSync(candidate)) continue;
      try {
        if (!lstatSync(candidate).isDirectory() || readdirSync(candidate).length !== 0) {
          err(`dispatch_codex_producer: probe sweep kept non-empty directory: ${candidate}`);
          continue;
        }
        rmdirSync(candidate);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        err(`dispatch_codex_producer: probe sweep kept non-empty directory: ${candidate}`);
      }
    }
    // An exact, empty `<probe-anchor>/.git` directory is not repository
    // metadata and is removed by the path guard's narrow non-recursive
    // exception. Real repositories, worktree `.git` files, symlinks, races,
    // and unreadable/non-empty directories remain untouched.
    const gitCandidate = resolve(dir, ".git");
    if (existsSync(gitCandidate)) {
      const result = removeEmptyProbeGitDirSync(gitCandidate, { cleanupRoots: dirs, protectedGitPaths });
      if (!result.removed) err(`dispatch_codex_producer: probe sweep kept ${nativeCliPath(result.candidate)}: ${result.reason}`);
    }
  }
}

interface KillableChild { pid: number; kill(signal?: number | NodeJS.Signals): void; }

// The explicit Git Bash launch can introduce a shell process between this
// launcher and Codex on Windows. taskkill /T is therefore the best-effort
// termination path; a plain child.kill() could leave the nested Codex alive.
function terminateChildTree(child: KillableChild): void {
  try {
    if (process.platform === "win32") {
      const killed = Bun.spawnSync([requireRuntimeExecutable("taskkill"), "/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      if (killed.exitCode === 0) return;
    }
    child.kill("SIGTERM");
  } catch { /* the child already exited or the host is terminating */ }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  installPipeGuards();
  let worktree = "", project = "", prompt = "", result = "", sessionRecord = "";
  let sandbox = "workspace-write", model = "", effort = "", modelSource = "";
  let skillRoot = "", targetRoot = "";
  const extraAddDirs: string[] = [];

  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--worktree": worktree = nextValue(argv, i); i += 2; break;
      case "--project": project = nextValue(argv, i); i += 2; break;
      case "--prompt": prompt = nextValue(argv, i); i += 2; break;
      case "--result": result = nextValue(argv, i); i += 2; break;
      case "--session-record": sessionRecord = nextValue(argv, i); i += 2; break;
      case "--sandbox": sandbox = nextValue(argv, i); i += 2; break;
      case "--model": model = nextValue(argv, i); i += 2; break;
      case "--effort": effort = nextValue(argv, i); i += 2; break;
      case "--model-source": modelSource = nextValue(argv, i); i += 2; break;
      case "--skill-root": skillRoot = nextValue(argv, i); i += 2; break;
      case "--target-root": targetRoot = nextValue(argv, i); i += 2; break;
      case "--add-dir": extraAddDirs.push(nextValue(argv, i)); i += 2; break;
      case "-h": case "--help": out(HELP); return 0;
      default: exitWith(`unknown arg: ${argv[i]}`, 2);
    }
  }

  if (!worktree) exitWith("missing --worktree", 2);
  if (!project) exitWith("missing --project", 2);
  if (!prompt) exitWith("missing --prompt", 2);
  if (!result) exitWith("missing --result", 2);

  try { model = resolveModelName(model); }
  catch (error) { exitWith(`dispatch_codex_producer: ${(error as Error).message}`, 2); }
  if (effort === "ultra" || !["", "low", "medium", "high", "xhigh"].includes(effort)) {
    exitWith(`dispatch_codex_producer: unsupported/forbidden effort '${effort}'`, 2);
  }

  if (sandbox === "danger-full-access") {
    exitWith("dispatch_codex_producer: danger-full-access is not allowed; use workspace-write plus --add-dir grants", 2);
  }
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    exitWith(`dispatch_codex_producer: unsupported --sandbox '${sandbox}' (expected read-only or workspace-write)`, 2);
  }
  // Resolve both launch executables before spawning. Codex may be an
  // extensionless shebang script on Windows, so Git Bash launches its exact
  // absolute path; Bash never performs a second PATH lookup.
  const bash = resolveBashExecutable();
  if (!bash) {
    exitWith("dispatch_codex_producer: Git Bash not found (checked PATH, GARELIER_BASH, and standard Git for Windows locations)", 3);
  }
  const codexEnv = childEnvWithBun();
  const codex = resolveRuntimeExecutable("codex", { env: codexEnv });
  if (!codex) exitWith("codex CLI not found (checked GARELIER_CODEX, PATH, and standard user locations)", 3);

  const worktreeAbs = absoluteExistingDir(worktree);
  const projectAbs = absoluteExistingDir(project);
  const promptAbs = absoluteExistingFile(prompt);
  const resultAbs = resultPath(result);
  if (!worktreeAbs) exitWith(`dispatch_codex_producer: --worktree is not an existing directory: ${worktree}`, 2);
  if (!projectAbs) exitWith(`dispatch_codex_producer: --project is not an existing directory: ${project}`, 2);
  if (!promptAbs) exitWith(`dispatch_codex_producer: --prompt is not a file: ${prompt}`, 2);

  const worktreeNative = nativeCliPath(worktreeAbs);
  const projectNative = nativeCliPath(projectAbs);
  const promptReadable = promptAbs;
  const resultNative = resultAbs;
  const sessionRecordAbs = resultPath(sessionRecord || resolve(dirname(resultAbs), "session.json"));
  const containerAbs = dirname(worktreeAbs);
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const skillsRoot = realpathSync(resolve(moduleDir, "../../../.."));

  const addDirs: string[] = [];
  const cleanupRoots: string[] = [];
  const addResolvedUnique = (list: string[], candidate: string): void => {
    const abs = absoluteExistingDir(candidate);
    if (!abs) return;
    const native = nativeCliPath(abs);
    if (!list.includes(native)) list.push(native);
  };
  const addDirUnique = (candidate: string): void => addResolvedUnique(addDirs, candidate);
  const addCleanupRoot = (candidate: string): void => addResolvedUnique(cleanupRoots, candidate);

  // Writable roots only. Broad context roots are intentionally excluded:
  // --add-dir gives the nested agent write access and its startup probes then
  // leave `.agents`/`.codex`/`.git` behind in those real roots.
  addDirUnique(worktreeAbs);
  addDirUnique(containerAbs);
  addDirUnique(dirname(resultAbs));
  const codexHome = process.env.CODEX_HOME || resolve(process.env.HOME || "", ".codex");
  // W-093: grant the real bun dir so the Windows `elevated` sandbox permits
  // exec of the bun.exe PE that childEnvWithBun() prepends onto PATH. The PATH
  // entry alone is not enough — a probe showed `bun` stayed unresolved until
  // this dir was an --add-dir grant. Scope stays at just the bun binary dir.
  addDirUnique(bunBinDir());

  // Safety-net roots include historical broad grants so the next launch heals
  // leftovers from a prior force-killed launcher without granting them again.
  for (const root of [projectAbs, worktreeAbs, containerAbs, dirname(resultAbs), targetRoot,
    skillRoot || skillsRoot, resolve(codexHome, "skills"), bunBinDir()]) addCleanupRoot(root);

  const contextPath = resolve(containerAbs, "context.json");
  let contextRouting: { model: string; effort: string; source: string } | null = null;
  if (existsSync(contextPath)) {
    try {
      const context = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, any>;
      const values = [
        context?.project?.project_root,
        context?.project?.control_root,
        context?.project?.target_root,
        context?.control_root,
        context?.target_root,
      ];
      for (const value of values) if (typeof value === "string" && value) addCleanupRoot(value);
      contextRouting = {
        model: String(context?.routing?.model ?? ""),
        effort: String(context?.routing?.effort ?? ""),
        source: String(context?.routing?.source ?? ""),
      };
    } catch { /* best effort, matching the shell helper */ }
  }
  try { assertRoutingMatches(contextRouting, { model, effort, source: modelSource }); }
  catch (error) { exitWith(`dispatch_codex_producer: ${(error as Error).message}`, 4); }
  for (const extra of extraAddDirs) { addDirUnique(extra); addCleanupRoot(extra); }

  const args = [
    "exec", "--cd", worktreeNative, "--sandbox", sandbox,
    "-c", "approval_policy=never", "--output-last-message", resultNative, "--json",
  ];
  for (const dir of addDirs) args.push("--add-dir", dir);
  if (model) args.push("--model", model);
  if (effort) args.push("-c", `model_reasoning_effort=\"${effort}\"`);
  args.push("-");

  // A prior result must never make a failed new launch look successful.
  try { if (existsSync(resultAbs) && statSync(resultAbs).isFile()) unlinkSync(resultAbs); } catch { /* launch/result checks report the failure */ }

  let sessionState = makeSessionRecord("codex-cli", "", worktreeAbs, "running", resultAbs, undefined, contextRouting!);
  writeSessionRecord(sessionRecordAbs, sessionState);

  const escapeGuard = `[Garelier sandbox rule — W-077, READ FIRST, non-negotiable]
Your working directory is your OWN git worktree: ${worktreeNative}. Do ALL work
there. You are also granted read access to the project root and sibling dirs for
context ONLY.
- NEVER run 'git add', 'git commit', 'git stash', 'git restore', 'git checkout',
  or ANY index-mutating git command, and NEVER create/edit/delete files, outside
  your worktree cwd — above all NOT at the project root or the primary checkout.
- The project root's git index is SHARED with the merge gate and other roles.
  Writing it (even staging the same change you already made in your worktree)
  corrupts the pending merge and aborts the land. This is a hard failure, not a
  style preference.
- If a tool or habit would 'git add' at the project root, STOP — the correct place
  is your worktree. git READ commands (status/log/diff) anywhere are fine.`;

  // Heal probe litter from an earlier SIGKILL/taskkill before the next nested
  // Codex gets a chance to inspect or recreate it.
  sweepEmptyCodexProbeDirs(worktreeAbs, projectAbs, cleanupRoots);

  err(`[dispatch_codex_producer] codex exec (sandbox=${sandbox} cwd=${worktreeNative} add_dirs=${addDirs.length}) — SYNCHRONOUS, waiting...`);
  // Launch the exact Codex path under Bash; "$@" preserves each arg verbatim (paths with spaces, the
  // model_reasoning_effort="…" literal quotes), and exec propagates codex's
  // exit code and stdio unchanged.
  let child: KillableChild | null = null;
  let sessionLock: SessionLock | null = null;
  let childSettled = false;
  let cleanupDone = false;
  let rc = 1, turnFailure = "", capturedSessionId = "";
  const cleanup = (): void => {
    if (cleanupDone) return;
    cleanupDone = true;
    sweepEmptyCodexProbeDirs(worktreeAbs, projectAbs, cleanupRoots);
  };
  const terminate = (): void => {
    if (!child || childSettled) return;
    terminateChildTree(child);
  };
  const onExit = (): void => { terminate(); cleanup(); };
  const onSignal = (code: number): (() => void) => () => process.exit(code);
  const sigint = onSignal(130), sigterm = onSignal(143), sigbreak = onSignal(131);
  try {
    const spawned = Bun.spawn([bash, "-c", 'exec "$1" "${@:2}"', "garelier-codex", codex, ...args], {
      stdin: "pipe", stdout: "pipe", stderr: "inherit", env: codexEnv,
      // W-112 emergency hotfix (2026-07-17): a console-less background parent makes
      // every console child (pwsh/cargo/git spawned by codex) allocate a NEW visible
      // console window on Windows — the flashing windows steal the user's focus and
      // made the desktop unusable. windowsHide gives the tree a hidden console to
      // inherit so no window ever surfaces. No-op off Windows.
      windowsHide: true,
    });
    child = spawned;
    process.once("exit", onExit);
    process.once("SIGINT", sigint);
    process.once("SIGTERM", sigterm);
    if (process.platform === "win32") process.once("SIGBREAK", sigbreak);
    spawned.stdin.write(`${escapeGuard}\n\n${readFileSync(promptReadable, "utf8")}`);
    spawned.stdin.end();
    const exited = spawned.exited.then((code) => { childSettled = true; return code; });
    const [exitCode, mirrored] = await Promise.all([
      exited,
      mirrorCodexStdout(spawned.stdout, (sessionId) => {
        sessionState = updateSessionRecord(sessionState, { session_id: sessionId, status: "running" });
        sessionLock = acquireSessionLock(sessionRecordAbs, sessionState);
        if (!sessionLock) {
          turnFailure = "session lock is already live or unverifiable";
          err(`CODEX_LAUNCH_FAILED: ${turnFailure}`);
          terminateChildTree(spawned);
          return;
        }
        writeSessionRecord(sessionRecordAbs, sessionState);
      }),
    ]);
    rc = exitCode;
    turnFailure = turnFailure || mirrored.failure;
    capturedSessionId = mirrored.sessionId;
  } finally {
    process.off("exit", onExit);
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    if (process.platform === "win32") process.off("SIGBREAK", sigbreak);
    terminate();
    cleanup();
    if (sessionLock) releaseSessionLock(sessionLock);
  }

  const sessionFallback = capturedSessionId
    ? undefined
    : { required: true as const, reason: "session_id_not_captured", action: "fresh_dispatch_required" as const };
  const sessionChanges: Partial<Pick<ProviderSessionRecord, "session_id" | "status" | "fallback">> = {
    session_id: capturedSessionId,
    status: rc === 0 && !turnFailure && capturedSessionId ? "ready" : "failed",
    ...(sessionFallback ? { fallback: sessionFallback } : {}),
  };
  sessionState = updateSessionRecord(sessionState, sessionChanges);
  writeSessionRecord(sessionRecordAbs, sessionState);

  out("__CODEX_RESULT_BEGIN__");
  const hasResult = existsSync(resultAbs) && isFile(resultAbs);
  if (hasResult) process.stdout.write(readFileSync(resultAbs, "utf8"));
  else out("(no result file written)");
  out("__CODEX_RESULT_END__");
  out(`__CODEX_EXIT__:${rc}`);
  if (turnFailure) return rc === 0 ? 1 : rc;
  if (rc === 0 && !hasResult) {
    err("CODEX_LAUNCH_FAILED: codex exited successfully without writing a result file");
    return 1;
  }
  if (rc !== 0) err(`CODEX_LAUNCH_FAILED: codex exec exited with code ${rc}`);
  return rc;
}

if (import.meta.main) process.exit(await main());
