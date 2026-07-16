#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `!/usr/bin/env bash

Dispatch a NON-Claude producer (Codex) as a RUN-TO-COMPLETION subprocess for
the DEC-057/DEC-058 dispatch Dock. The Claude Agent/Workflow tool can
only spawn Claude subagents; this is how the interactive Dock/PM
gives a role to Codex instead: it runs \`codex exec\` SYNCHRONOUSLY in the role's
worktree, waits for completion, and prints the producer's final message so the
Dock can integrate the returned branch via the normal merge gate.

Sets the codex-cli flags (sandbox / approval_policy / model / reasoning effort)
so a Codex seat behaves like its claude-code peers under dispatch.

Usage:
  dispatch_codex_producer.sh \\
    --worktree <dir>        # role worktree (cwd; already on its branch off studio)
    --project  <dir>        # project/control root (granted via --add-dir)
    --prompt   <file>       # the role prompt (assignment) on stdin to codex
    --result   <file>       # where to capture codex's final message
    [--sandbox read-only|workspace-write]   # default workspace-write (commit-bearing roles)
    [--model <name>] [--effort <low|medium|high|xhigh|ultra>]   # ultra = gpt-5.6-sol subagent fan-out mode (high cost; pair with a token budget)
    [--skill-root <dir>]    # extra read dir (Garelier skill root), optional
    [--target-root <dir>]   # Plant-Crust target checkout, optional
    [--add-dir <dir>]       # repeatable extra grant for workspace-write

Exit code = codex exec's exit code. The final message is also echoed to stdout
between sentinels so it is easy to extract from a background-task log.
Codex CLI now treats a skill-load stat failure as fatal (was a warning),
so the dispatched thread dies instantly unless it can read its own
~/.codex/skills tree (e.g. .system/{imagegen,openai-docs,...}). Grant it
read access by default; add_dir_unique silently no-ops when the dir is
absent (resolve_dir_native requires -d), so this is a no-op on hosts
without a Codex skills tree.
W-077: primary-checkout escape guard. A codex producer is granted --add-dir at
the project root (for reads + its own container writes), which ALSO lets a
\`git add\` there write the SHARED primary .git/index even though the producer's
OWN worktree gitdir index.lock is sandbox-denied. Staging identical work into
the primary index (field #327 / #333, the \`M \` state) then makes the merge
gate's \`git checkout studio\` / \`git merge\` fail with "local changes would be
overwritten" and aborts the land. Prepend a hard, explicit prohibition to the
prompt so the producer never touches the project root's git state or files —
all its work stays inside its worktree cwd. (merge-gate.sh also lossless-heals
a branch-identical escape, but prevention is the primary fix.)`;

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
  if (value === undefined) exitWith(`dispatch_codex_producer.sh: line 1: $2: unbound variable`, 1);
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
    const r = Bun.spawnSync(["cygpath", "-m", path], { stdout: "pipe", stderr: "ignore" });
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

async function mirrorCodexStdout(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let pending = "";
  let failure = "";
  const inspect = (line: string): void => {
    if (failure) return;
    failure = turnFailedMessage(line);
    if (failure) err(`CODEX_LAUNCH_FAILED: ${failure}`);
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
  return failure;
}

// W-103 boundary contract: after each Codex run, inspect only the launch cwd
// ancestry from worktree through project root, plus exactly ONE directory above
// project root. Remove only empty `.agents` / `.codex` directories. A non-empty
// directory, file, or symlink is never touched and produces one warning. When
// Plant-Crust paths are not nested, fail closed to the three explicit anchors
// (worktree, project root, project parent) instead of walking toward filesystem
// root. This is cleanup for Codex's read-probe litter, not general dotdir cleanup.
export function sweepEmptyCodexProbeDirs(worktree: string, project: string): void {
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
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  installPipeGuards();
  let worktree = "", project = "", prompt = "", result = "";
  let sandbox = "workspace-write", model = "", effort = "", skillRoot = "", targetRoot = "";
  const extraAddDirs: string[] = [];

  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--worktree": worktree = nextValue(argv, i); i += 2; break;
      case "--project": project = nextValue(argv, i); i += 2; break;
      case "--prompt": prompt = nextValue(argv, i); i += 2; break;
      case "--result": result = nextValue(argv, i); i += 2; break;
      case "--sandbox": sandbox = nextValue(argv, i); i += 2; break;
      case "--model": model = nextValue(argv, i); i += 2; break;
      case "--effort": effort = nextValue(argv, i); i += 2; break;
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

  if (sandbox === "danger-full-access") {
    exitWith("dispatch_codex_producer: danger-full-access is not allowed; use workspace-write plus --add-dir grants", 2);
  }
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    exitWith(`dispatch_codex_producer: unsupported --sandbox '${sandbox}' (expected read-only or workspace-write)`, 2);
  }
  // Resolve `codex` through bash (a PATH lookup that honors extensionless
  // shebang scripts), exactly as dispatch_codex_producer.sh did. Bun.which and
  // a bare Bun.spawn(["codex"]) use native win32 resolution, which respects
  // PATHEXT and silently skips an extensionless `codex` on PATH (e.g. the test
  // fixture), falling through to a different codex — the W-083 launch
  // regression. Keep guard and launch on the same (bash) resolution.
  if (Bun.spawnSync(["bash", "-c", "command -v codex"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    exitWith("codex CLI not on PATH", 3);
  }

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
  const containerAbs = dirname(worktreeAbs);
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const skillsRoot = realpathSync(resolve(moduleDir, "../../../.."));

  const addDirs: string[] = [];
  const addDirUnique = (candidate: string): void => {
    const abs = absoluteExistingDir(candidate);
    if (!abs) return;
    const native = nativeCliPath(abs);
    if (!addDirs.includes(native)) addDirs.push(native);
  };

  addDirUnique(projectAbs);
  addDirUnique(worktreeAbs);
  addDirUnique(containerAbs);
  addDirUnique(dirname(resultAbs));
  if (targetRoot) addDirUnique(targetRoot);
  addDirUnique(skillRoot || skillsRoot);
  const codexHome = process.env.CODEX_HOME || resolve(process.env.HOME || "", ".codex");
  addDirUnique(resolve(codexHome, "skills"));
  // W-093: grant the real bun dir so the Windows `elevated` sandbox permits
  // exec of the bun.exe PE that childEnvWithBun() prepends onto PATH. The PATH
  // entry alone is not enough — a probe showed `bun` stayed unresolved until
  // this dir was an --add-dir grant. Scope stays at just the bun binary dir.
  addDirUnique(bunBinDir());

  const contextPath = resolve(containerAbs, "context.json");
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
      for (const value of values) if (typeof value === "string" && value) addDirUnique(value);
    } catch { /* best effort, matching the shell helper */ }
  }
  for (const extra of extraAddDirs) addDirUnique(extra);

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

  err(`[dispatch_codex_producer] codex exec (sandbox=${sandbox} cwd=${worktreeNative} add_dirs=${addDirs.length}) — SYNCHRONOUS, waiting...`);
  // Launch codex under bash (`exec codex "$@"`) so PATH resolution matches the
  // shell helper; "$@" preserves each arg verbatim (paths with spaces, the
  // model_reasoning_effort="…" literal quotes), and exec propagates codex's
  // exit code and stdio unchanged.
  const child = Bun.spawn(["bash", "-c", 'exec codex "$@"', "codex", ...args], {
    stdin: "pipe", stdout: "pipe", stderr: "inherit", env: childEnvWithBun(),
  });
  child.stdin.write(`${escapeGuard}\n\n${readFileSync(promptReadable, "utf8")}`);
  child.stdin.end();
  const [rc, turnFailure] = await Promise.all([child.exited, mirrorCodexStdout(child.stdout)]);
  sweepEmptyCodexProbeDirs(worktreeAbs, projectAbs);

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
