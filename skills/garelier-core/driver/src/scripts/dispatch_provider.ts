#!/usr/bin/env bun
import { configurePathGuardRoots, removeEmptyProbeGitDirSync, rmdirSync, unlinkSync, writeGuardedFileSync } from "../guard/path_guard.ts";

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { requireRuntimeExecutable, resolveBashExecutable, resolveRuntimeExecutable } from "./_lib.ts";
import { ensureWindowsCheckoutWritable } from "../dispatch/windows_checkout_acl.ts";
import { injectLaneEnv, resolveLaneEnv } from "./lane_env.ts";
import { roleProviderCoreEnv } from "./spawn_env.ts";
import {
  CLAUDE_ROLE_PROMPT_CONTRACT_MARKER,
  CODEX_ROLE_PROMPT_CONTRACT_MARKER,
  checkRolePromptContractMarker,
  type PromptContractCheck,
} from "./lane_common.ts";
import { loadLaneEnv } from "../config.ts";
import { atomicWriteRuntimeFile } from "../control/diagnostics.ts";
import { canonicalJson } from "../control/serialization.ts";
import { buildFactPack, resolveTouchedPackages } from "../context_pack.ts";
import { crewSubdir } from "../workspace.ts";
import { garelierControlRoots, garelierControlSchema } from "../control/garelier_integration.ts";
import { readControlClaim } from "../control/claims.ts";
import { resolveControlNamespace } from "../control/transaction.ts";
import { heartbeatControlSession, type HeartbeatSessionOptions } from "../control/sessions.ts";
import { planGraphRuntimeCallbacks } from "../control/plan_graph_write.ts";
import {
  acquireSessionLock,
  assertCodexProviderWritableRoots,
  codexProviderBunDirectory,
  codexProviderWritableRoots,
  formatProviderFailure,
  makeSessionRecord,
  makeProviderFailure,
  parseCodexJsonlTurn,
  parseClaudeSessionId,
  providerSpawnFailure,
  providerChildEnv,
  releaseSessionLock,
  updateSessionRecord,
  writeSessionRecord,
  type ProviderSessionRecord,
  type ProviderFailure,
  type SessionFallback,
  type SessionProvider,
  type SessionLock,
} from "./provider_session.ts";
import {
  acknowledgeRoleLaunch,
  assertRoleBranchIdentity,
  bindingReference,
  dispatchExecutionIdentity,
  dispatchIdForRoleCheckout,
  roleExecutionIdentityForBranch,
  hashRoleFile,
  readCurrentRoleAuthorization,
  recoverRoleAuthorization,
  roleBindingFromContext,
  resolveCanonicalRoleAcceptanceIds,
  roleSeatExecutionIdentity,
  validateRoleBinding,
  validateRoleLaunchPending,
  writeRoleBindingToContext,
  type RoleAuthorization,
  type RoleKind,
} from "../dispatch/role_binding.ts";

const HELP = `Dispatch a recorded provider CLI role through one shared launch path.
Binding validation, prompt and worktree boundaries, routing checks, result
delivery, child cleanup, and launch acknowledgement run once around the small
provider argv/response adapters.

Usage:
  dispatch_provider.ts \\
    --provider <codex|claude-code> \\
    --worktree <dir>        # role source tree (role cwd; role-seat read context)
    --project  <dir>        # project/control root (granted via --add-dir)
    --prompt   <file>       # the role prompt (assignment) on provider stdin
    --result   <file>       # where to capture the provider's final message
    [--session-record <file>] # exact provider session id; default beside result
    [--sandbox read-only|workspace-write]   # default workspace-write
    [--seat-role <scout|observer|guardian|concierge> --seat-dispatch-id <id>]
    [--context <context.json>] # required for a role-seat launch
    [--model <name>] [--effort <low|medium|high|xhigh>] [--model-source <source>]
    [--skill-root <dir>]    # context hint; never made writable
    [--target-root <dir>]   # Plant-Crust context hint; never made writable
    [--add-dir <dir>]       # repeatable extra role/Concierge grant

Exit code = the provider CLI exit code. The final response is written once by
this launcher and echoed between sentinels for a background-task log.
Provider add-dir is a WRITE grant, not a read-only context grant. Project,
target, framework-skill, CODEX_HOME/skills, and context roots are therefore
never passed through it. The prompt is forwarded on stdin and checkout/context
files remain readable without making their real roots writable. A non-Concierge
role seat runs from its designated artifact directory and grants only that
directory; its repository source tree is never the provider cwd or an --add-dir.
Primary-checkout escape guard: the project root is not a broad
--add-dir, preventing writes to its SHARED .git/index. Keep the explicit prompt
prohibition as defense in depth for an operator-supplied --add-dir or a future
sandbox-policy change: all role work stays inside its worktree cwd.
(merge-gate.ts also lossless-heals a branch-identical escape.)`;

function out(line: string): void { process.stdout.write(`${line}\n`); }
function err(line: string): void { process.stderr.write(`${line}\n`); }
let activeResultPath = "";
function deliverResult(body: string): string {
  if (!activeResultPath) return "result path unavailable";
  try { writeGuardedFileSync(activeResultPath, body, "provider result"); return ""; }
  catch (error) { return (error as Error).name || "Error"; }
}
function exitWith(message: string, code: number): never {
  const deliveryError = activeResultPath ? deliverResult(FAILED_RESULT) : "";
  err(`${message}${deliveryError ? `; result write failed (${deliveryError})` : ""}`);
  process.exit(code);
}

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
  if (value === undefined) exitWith(`dispatch_provider.ts: line 1: $2: unbound variable`, 1);
  return value;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function currentBranch(worktree: string): string {
  const result = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", worktree, "branch", "--show-current"], {
    windowsHide: true, stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`cannot resolve checked-out branch: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
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

// W-226 (R2, N1 — Guardian): a --worktree pointing at the PRIMARY/shared
// checkout (whose .git is a real directory holding the index/refs/objects
// EVERY worktree shares) would let checkout ACL repair touch the shared root
// and would hand codex a write grant
// against the shared index rather than an isolated worktree — the exact
// escape W-077 already fences --add-dir against. A linked git worktree's own
// .git is always a FILE containing a "gitdir: <path>" pointer, never a
// directory. Missing .git entirely is rejected too (dispatch_prepare and
// lane_dispatch always create --worktree as a real git worktree; anything
// else is not the shape this launcher is contracted to receive).
export function isLinkedGitWorktree(worktreeAbs: string): boolean {
  try { return lstatSync(resolve(worktreeAbs, ".git")).isFile(); }
  catch { return false; }
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

// Child env with the real bun dir prepended to PATH (W-093), so `bun` resolves
// to the plain PE instead of the sandbox-opaque WinGet/Links symlink. Pairs
// with the matching --add-dir grant in main() (the sandbox needs both: the
// PATH entry to find bun, the grant to exec it — a probe confirmed PATH alone
// leaves `bun` unresolved). Mutates the existing PATH key in place (Windows may
// spell it `Path`) to avoid a duplicate.
// W-249: value-only credential-URL scrub (a stray proxy/registry-style value
// carrying embedded userinfo creds has no reason to reach this child). The
// NAME-based secret drop stays OFF (dropSecretNames: false) — this child IS the
// codex CLI, which legitimately needs its own `*_API_KEY`/`*_TOKEN` env to
// authenticate; dropping those by name would break the launch, not secure it.
// No MINIMAL_ENV_KEYS allowlist either — this module cannot enumerate every var
// the codex CLI needs (see provider_session.ts's providerChildEnv() for the
// matching policy on the codex/claude resume path). Exported for direct test.
// W-249 (Guardian N3): honest residual — with dropSecretNames off, a HOST-set
// secret-named var (e.g. an unrelated *_TOKEN the operator's shell exports) is
// NOT name-dropped here and reaches this child and, transitively, whatever it
// spawns. Accepted because the child is the codex CLI itself, a trusted
// boundary in this model — not a scope this function polices.
export function childEnvWithBun(
  provider: SessionProvider = "codex-cli",
  bash = "",
): Record<string, string> {
  const env = providerChildEnv(provider, bash, process.env) as Record<string, string>;
  if (provider !== "codex-cli") return env;
  const bunDir = codexProviderBunDirectory();
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

export function materializeRecoveryContext(options: {
  contextPath: string;
  projectRoot: string;
  pmId: string;
  worktree: string;
  branch: string;
  dispatchId: string;
  authorization: RoleAuthorization;
}): Record<string, unknown> {
  const core = options.authorization.core;
  if (core.carabiner !== "role_recovery") {
    throw new Error("context.json routing is required; only canonical role_recovery may materialize context");
  }
  let config: Record<string, unknown> | null = null;
  const configPath = resolve(crewSubdir(options.projectRoot, options.pmId, "pm"), "setup_config.toml");
  if (existsSync(configPath)) {
    try { config = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>; }
    catch { config = null; }
  }
  const blueprintPath = core.sources.blueprint?.path ?? null;
  const blueprintMd = blueprintPath ? readFileSync(resolve(options.projectRoot, blueprintPath), "utf8") : null;
  const touches = (core.recovery?.wip ?? []).flatMap((entry) => {
    const path = resolve(options.projectRoot, entry.path);
    const rel = relative(options.worktree, path);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
      ? [rel.replace(/\\/g, "/")]
      : [];
  });
  const packed = buildFactPack({
    pmId: options.pmId,
    projectRoot: options.projectRoot,
    integration: core.integration.ref,
    config,
    blueprintMd,
    blueprintPath,
    task: {
      id: Number(options.dispatchId), role: core.role, slug: options.branch.split("/").at(-1) ?? null,
      branch: options.branch, base_branch: core.integration.ref, base_sha: core.integration.base_sha,
      touches, depends_on: [],
    },
    routing: { model: core.routing.model, effort: core.routing.effort, source: core.routing.source, commit_mode: "proxy" },
    touchedPackages: resolveTouchedPackages(options.worktree, touches),
    guard: {
      permission_profile: "role", fence_roots: [options.worktree, dirname(options.worktree)],
      role: core.role, worktree: options.worktree,
    },
  }) as unknown as Record<string, unknown>;
  const controlSchema = garelierControlSchema(options.projectRoot, options.pmId);
  if (controlSchema === 3) {
    packed.control = {
      schema_version: controlSchema,
      work_id: core.item.work_id,
      session_id: core.item.session_id,
    };
  }
  writeRoleBindingToContext(packed, bindingReference(options.authorization));
  atomicWriteRuntimeFile(dirname(options.contextPath), options.contextPath, canonicalJson(packed));
  const context = JSON.parse(readFileSync(options.contextPath, "utf8")) as Record<string, any>;
  if (context.kind !== "dispatch_fact_pack" || context.generated_by !== "context_pack.ts"
    || context.project?.pm_id !== options.pmId || resolve(String(context.project?.project_root ?? "")) !== resolve(options.projectRoot)
    || context.task?.role !== core.role || context.task?.branch !== options.branch
    || context.task?.base_sha !== core.integration.base_sha
    || (controlSchema === 3 && (context.control?.schema_version !== controlSchema
      || context.control?.work_id !== core.item.work_id || context.control?.session_id !== core.item.session_id))
    || canonicalJson(roleBindingFromContext(context)) !== canonicalJson(bindingReference(options.authorization))) {
    throw new Error("materialized recovery context failed canonical binding validation");
  }
  assertRoutingMatches({
    model: String(context.routing?.model ?? ""),
    effort: String(context.routing?.effort ?? ""),
    source: String(context.routing?.source ?? ""),
  }, { model: core.routing.model, effort: core.routing.effort, source: core.routing.source });
  return context;
}

// W-226 (R1/R2): the launcher is the ONE choke point every codex launch
// passes through — dispatch_prepare-generated AND hand-authored prompts alike
// (a raw `codex exec` is separately denied by the codex_raw_exec command_guard
// rule, per codex_worker_playbook.md W-039). A real target-project incident (2026-07-26)
// proved a hand-authored prompt can silently bypass dispatch_prepare's
// codexProviderContract preamble and reinvent — incorrectly — a direct
// heavy_compile_lock.ts invocation the sandbox can never reach. Rather than
// leave detection to a PM remembering to check, the launcher itself refuses to
// spawn codex against a prompt that either (a) lacks the contract's own
// marker line (so it did not go through dispatch_prepare), or (b) instructs a
// direct heavy_compile_lock.ts invocation (always forbidden — see below), or
// (c) references a garelier-core/scripts|driver path that resolves OUTSIDE
// the granted worktree. No escape-hatch flag is offered by design (per
// DEC-057 model, an exception belongs in the contract, not a bypass switch).
//
// R2 (Guardian BLOCK, 2026-07-27): R1's (b) was a bare text-match regex with
// no worktree awareness, which fired on this repo's OWN real lane prompts —
// a `_workshop` lane worktree IS a checkout of the garelier framework repo,
// so a line like `bun skills/garelier-core/driver/src/scripts/ci.ts` is the
// repo's own, perfectly-reachable acceptance command, not a cross-repo
// reference. 8 of this repo's own real historical dispatch prompts
// (`_crew/lanes/.meta/*.prompt.md`) matched and would have become
// unlaunchable. The fix: `heavy_compile_lock.ts` stays UNCONDITIONALLY
// forbidden regardless of locality (even inside a self-repo lane, the lock's
// target directory is the PROJECT ROOT's `runtime/locks/heavy_compile/`,
// which sits outside every role's granted roots — semantically always
// wrong for codex to invoke directly); every OTHER `garelier-core/scripts|driver`
// reference is resolved against the worktree and forbidden ONLY when it lands
// outside it (or does not exist there at all — a relative-looking reference
// that does not resolve to a real file in this worktree is exactly what a
// hallucinated/copy-pasted cross-repo path looks like, so it is treated the
// same as an out-of-worktree absolute path).
export const PROMPT_CONTRACT_MARKER = CODEX_ROLE_PROMPT_CONTRACT_MARKER;
export const PROMPT_HEAVY_LOCK_PATTERN = /heavy_compile_lock\.ts/i;
export const PROMPT_GARELIER_CORE_SCRIPT_PATTERN = /garelier-core[\\/](?:scripts|driver)[\\/]/i;

// Path-like tokens out of free prose: split on whitespace/quote/backtick/paren
// delimiters (prose wraps paths in backticks or parens, and lists them after a
// dash), then trim common trailing punctuation (":", ",", ".", ";") a sentence
// leaves stuck to a path. Deliberately permissive — a false-positive TOKEN
// just gets an extra (cheap, local) existsSync/resolve check below, never a
// silent skip.
function extractPathTokens(text: string): Array<{ value: string; gitDiffHeader: boolean }> {
  const values = text
    .split(/[\s`'"()]+/)
    .filter(Boolean)
    .map((t) => t.replace(/^[,;:]+|[,;:.]+$/g, ""));
  return values.map((value, index) => ({
    value,
    gitDiffHeader: (values[index - 1] === "---" && value.startsWith("a/"))
      || (values[index - 1] === "+++" && value.startsWith("b/"))
      || (values[index - 2] === "diff" && values[index - 1] === "--git" && value.startsWith("a/"))
      || (values[index - 3] === "diff" && values[index - 2] === "--git"
        && values[index - 1]?.startsWith("a/") && value.startsWith("b/")),
  }));
}

// Resolve `candidate` (absolute or worktree-relative) and report whether it
// lands INSIDE `worktreeAbs` AND actually exists there as a file. Both
// conditions matter: an out-of-worktree absolute path (a real hand-written-
// prompt incident's shape) fails the containment check; a relative-looking
// reference that mathematically resolves inside the worktree but does not
// correspond to a real file there
// (a hallucinated cross-repo path pasted into a non-self-repo project's
// prompt) fails the existence check instead of silently passing containment.
function resolvesToRealFileInWorktree(candidate: string, worktreeAbs: string, exactFile = false): boolean {
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(worktreeAbs, candidate);
  const norm = (p: string): string => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const resolvedNorm = norm(resolved);
  const worktreeNorm = norm(worktreeAbs);
  const inside = resolvedNorm === worktreeNorm || resolvedNorm.startsWith(`${worktreeNorm}${sep}`);
  if (!inside) return false;
  try { if (statSync(resolved).isFile()) return true; } catch { /* fall through to the directory check */ }
  if (exactFile) return false;
  // Tolerate a glob/shorthand leaf (prose like "dispatch_prepare*.ts" describing
  // a file family) or a stale-but-close filename: the CONTAINING directory
  // existing inside the worktree is still strong evidence this is a genuine
  // self-repo reference, not a hallucinated/cross-repo one (which would have
  // neither the exact file NOR its parent directory anywhere in this worktree).
  try { return statSync(dirname(resolved)).isDirectory(); } catch { return false; }
}

function resolvesGitDiffHeaderToRealFileInWorktree(candidate: string, worktreeAbs: string): boolean {
  const stripped = candidate.slice(2);
  return stripped.length > 0
    && !isAbsolute(stripped)
    && resolvesToRealFileInWorktree(stripped, worktreeAbs, true);
}

export function checkPromptContract(
  promptText: string,
  worktreeAbs: string,
  provider: SessionProvider = "codex-cli",
): PromptContractCheck {
  const marker = provider === "codex-cli"
    ? CODEX_ROLE_PROMPT_CONTRACT_MARKER
    : CLAUDE_ROLE_PROMPT_CONTRACT_MARKER;
  const markerCheck = checkRolePromptContractMarker(
    promptText,
    marker,
    `missing the role preamble marker ("${marker}") — use dispatch_prepare to emit the provider prompt`,
  );
  if (!markerCheck.ok) return markerCheck;
  if (PROMPT_HEAVY_LOCK_PATTERN.test(promptText)) {
    return {
      ok: false,
      reason: `instructs the role to invoke heavy_compile_lock.ts directly — its lock directory sits at the PROJECT ROOT, outside every role's granted roots. Emit a '=== REQUIRED GATE (Dock-run) ===' block for the Dock gate.`,
    };
  }
  for (const { value: token, gitDiffHeader } of extractPathTokens(promptText)) {
    if (!PROMPT_GARELIER_CORE_SCRIPT_PATTERN.test(token)) continue;
    if (resolvesToRealFileInWorktree(token, worktreeAbs)) continue; // self-repo lane referencing its own tree — reachable, allow
    if (gitDiffHeader && resolvesGitDiffHeaderToRealFileInWorktree(token, worktreeAbs)) continue;
    return {
      ok: false,
      reason: `references a garelier-core/scripts|driver path ("${token}") that does not resolve to a real file inside the granted worktree (${worktreeAbs})`,
    };
  }
  return { ok: true, reason: "" };
}

export const ROLE_SEAT_PROMPT_MARKER = "[Garelier role-seat contract v1]";

export function checkRoleSeatPromptContract(promptText: string, role: RoleKind, resultPath: string): PromptContractCheck {
  const preamble = promptText.split(/\r?\n## Task\r?\n/, 1)[0] ?? "";
  const lines = preamble.split(/\r?\n/);
  if (!lines.includes(ROLE_SEAT_PROMPT_MARKER)) {
    return { ok: false, reason: `missing the role-seat prompt marker ("${ROLE_SEAT_PROMPT_MARKER}")` };
  }
  if (!lines.includes(`role=${role}`)) return { ok: false, reason: `role-seat prompt does not bind role=${role}` };
  const deliveryPrefix = `- Deliver the complete ${role} artifact as the final response. The trusted provider launcher captures it at `;
  const deliveryLines = lines.filter((line) => line.startsWith(deliveryPrefix));
  const expectedDelivery = `${deliveryPrefix}${nativeCliPath(resolve(resultPath))}; no other output path is granted.`;
  if (deliveryLines.length !== 1 || deliveryLines[0] !== expectedDelivery) {
    return { ok: false, reason: "role-seat launcher-captured output path does not exactly match the authorization-bound contract" };
  }
  return { ok: true, reason: "" };
}

export function roleSeatArtifactBoundary(resultFile: string): { cwd: string; addDirs: string[] } {
  const root = absoluteExistingDir(dirname(resolve(resultFile)));
  if (!root) throw new Error(`role-seat artifact directory is not an existing directory: ${dirname(resolve(resultFile))}`);
  const nativeRoot = nativeCliPath(root);
  return { cwd: nativeRoot, addDirs: [nativeRoot] };
}

const STDIN_TASK_QUERY = "Execute the complete task supplied on stdin.";
const FAILED_RESULT = "provider result unavailable\n";

export interface ProviderArgvInput {
  provider: SessionProvider;
  executable: string;
  bash: string;
  cwd: string;
  sandbox: string;
  model: string;
  effort: string;
  addDirs: readonly string[];
  expectedSessionId: string;
}

export interface ProviderInvocation {
  command: string[];
  expectedSessionId: string;
  mirrorStdout: boolean;
}

/** Provider adapter responsibility 1/2: construct only provider CLI argv. */
export function buildProviderArgv(input: ProviderArgvInput): ProviderInvocation {
  if (input.provider === "codex-cli") {
    const argv = [
      "exec", "--cd", input.cwd, "--sandbox", input.sandbox,
      "-c", "approval_policy=never", "--json",
    ];
    for (const dir of input.addDirs) argv.push("--add-dir", dir);
    if (input.model) argv.push("--model", input.model);
    if (input.effort) argv.push("-c", `model_reasoning_effort=\"${input.effort}\"`);
    argv.push("-");
    return {
      command: [input.bash, "-c", 'exec "$1" "${@:2}"', "garelier-codex", input.executable, ...argv],
      expectedSessionId: "",
      // Provider JSON events may contain prompt/repository fragments or
      // arbitrary diagnostics. The launcher emits only its own structured
      // status plus the final captured result.
      mirrorStdout: false,
    };
  }
  const sessionId = input.expectedSessionId;
  if (!sessionId) throw new Error("Claude provider invocation requires a preallocated session id");
  const argv = [
    input.executable, "-p", STDIN_TASK_QUERY,
    "--output-format", "json", "--session-id", sessionId,
    "--model", input.model, "--effort", input.effort,
  ];
  for (const dir of input.addDirs) argv.push("--add-dir", dir);
  return { command: argv, expectedSessionId: sessionId, mirrorStdout: false };
}

export interface ProviderResponse {
  sessionId: string;
  result: string;
  failureCode: "" | "provider_result_invalid" | "session_id_mismatch";
}

/** Terminal exit for a run whose claim lease could no longer be held. Distinct
 * from a signal (130/143/131) and from a spawn failure (4) so an operator can
 * tell a lease-terminated run from an interrupted one. */
export const PROVIDER_LEASE_LOST_EXIT = 75;

/** What the running provider's claim lease is currently worth. `lost` is
 * terminal: the heartbeat has stopped and supervision was told to stop the
 * provider with it. */
export interface DispatchClaimLeaseHealth {
  state: "healthy" | "degraded" | "lost";
  consecutive_failures: number;
  last_error: string | null;
  last_success_at: string | null;
  claim_expires_at: string | null;
  reason: string | null;
}

export interface DispatchClaimHeartbeat {
  stop(): void;
  /** Production reader for the lease state. A field nobody reads is not
   * supervision — GDN-004 (W-617 r7). */
  health(): DispatchClaimLeaseHealth;
}

/** The claim facts supervision needs; a subset of ControlClaimRecord so a test
 * or a future claim store can supply them without the whole namespace. */
export interface DispatchClaimLeaseProbe {
  session_id: string;
  expires_at: string;
}

/** Keep only this dispatch's live claim ahead of its lease while the provider
 * process is running. The first renewal is synchronous and fail-closed; later
 * transient failures are reported and retried on the next bounded tick.
 *
 * GDN-004: retrying forever is not enough. Runtime defaults renew every 300s
 * against an 1,800s lease, so ~5 consecutive failures let the claim expire
 * while the provider is still executing — and an expired claim is exactly what
 * `claims.ts` lets a foreign session take with an explicit steal. That would
 * put two live execution identities on one Work. So every tick also MEASURES
 * the claim this provider runs under, and the lease is declared lost — the
 * heartbeat stopped, supervision notified — while the claim is still live:
 * when it has been taken by another session, has disappeared, has become
 * unreadable, or has less than the supervision guard left before expiry. The
 * provider is stopped by that callback, so a stale claim and a running provider
 * cannot coexist. */
export function startDispatchClaimHeartbeat(options: {
  targetRoot: string;
  pmId: string;
  workId: string;
  sessionId: string;
  intervalMs?: number;
  /** How much lease must remain for the provider to keep running. Defaults to
   * one heartbeat interval: the run stops a full tick before the claim could
   * expire, never after. */
  leaseGuardMs?: number;
  /** Only the renewal's success or failure is consumed here, never its record. */
  heartbeat?: (options: HeartbeatSessionOptions) => unknown;
  readClaim?: () => DispatchClaimLeaseProbe | null;
  now?: () => number;
  onError?: (error: Error) => void;
  onLeaseLost?: (health: DispatchClaimLeaseHealth) => void;
}): DispatchClaimHeartbeat {
  const heartbeat = options.heartbeat ?? heartbeatControlSession;
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  const leaseGuardMs = options.leaseGuardMs ?? intervalMs;
  const readClaim = options.readClaim
    ?? (() => readControlClaim(
      resolveControlNamespace(garelierControlRoots(options.targetRoot, options.targetRoot, options.pmId)),
      options.workId,
    ));
  let state: DispatchClaimLeaseHealth["state"] = "healthy";
  let consecutiveFailures = 0;
  let lastError: Error | null = null;
  let lastSuccessAt: string | null = null;
  let claimExpiresAt: string | null = null;
  let reason: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const health = (): DispatchClaimLeaseHealth => ({
    state,
    consecutive_failures: consecutiveFailures,
    last_error: lastError?.message ?? null,
    last_success_at: lastSuccessAt,
    claim_expires_at: claimExpiresAt,
    reason,
  });
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const lose = (why: string): void => {
    if (state === "lost") return;
    state = "lost";
    reason = why;
    stop();
    options.onLeaseLost?.(health());
  };
  const assessLease = (): void => {
    if (state === "lost") return;
    let claim: DispatchClaimLeaseProbe | null;
    try { claim = readClaim(); }
    catch (error) {
      lose(`claim record is unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!claim) return lose(`claim for ${options.workId} no longer exists`);
    claimExpiresAt = claim.expires_at;
    if (claim.session_id !== options.sessionId) {
      return lose(`claim for ${options.workId} is now owned by session ${claim.session_id}`);
    }
    const expiresAt = Date.parse(claim.expires_at);
    if (!Number.isFinite(expiresAt)) return lose(`claim expiry for ${options.workId} is not a timestamp: ${claim.expires_at}`);
    const remainingMs = expiresAt - now();
    if (remainingMs <= leaseGuardMs) {
      return lose(
        `claim lease for ${options.workId} has ${Math.max(0, Math.round(remainingMs / 1000))}s left,`
        + ` at or under the ${Math.round(leaseGuardMs / 1000)}s supervision guard`,
      );
    }
  };
  const beat = (): void => {
    heartbeat({
      targetRoot: options.targetRoot,
      pmId: options.pmId,
      sessionId: options.sessionId,
      workIds: [options.workId],
      runtimeCallbacks: planGraphRuntimeCallbacks,
    });
  };
  const succeed = (): void => {
    consecutiveFailures = 0;
    lastError = null;
    lastSuccessAt = new Date(now()).toISOString();
    if (state !== "lost") state = "healthy";
  };
  const fail = (error: unknown): Error => {
    consecutiveFailures += 1;
    lastError = error instanceof Error ? error : new Error(String(error));
    if (state !== "lost") state = "degraded";
    return lastError;
  };
  try { beat(); succeed(); }
  catch (error) {
    const failure = fail(error);
    // dispatch_prepare and recovery publish under the same bounded namespace
    // lock. A launcher can become runnable just before that publisher releases
    // it, so lock contention is retryable; malformed binding/state is not.
    if (!/control namespace is locked|namespace\.lock/i.test(failure.message)) throw failure;
    options.onError?.(failure);
  }
  assessLease();
  // Read through the public accessor: the state is only ever moved inside the
  // closures above, so a direct comparison here is narrowed to its initializer.
  if (health().state !== "lost") {
    timer = setInterval(() => {
      // fail() runs first and unconditionally: `onError?.(fail(e))` would
      // short-circuit the whole call when no reporter is installed, leaving the
      // failure counter — the thing supervision reads — permanently at 1.
      try { beat(); succeed(); }
      catch (error) {
        const failure = fail(error);
        options.onError?.(failure);
      }
      assessLease();
    }, intervalMs);
    timer.unref?.();
  }
  return { stop, health };
}

/** Provider adapter responsibility 2/2: extract only the final response. */
export function extractProviderResponse(input: {
  provider: SessionProvider;
  stdout: string;
  expectedSessionId: string;
}): ProviderResponse {
  if (input.provider === "codex-cli") {
    const turn = parseCodexJsonlTurn(input.stdout);
    return {
      sessionId: turn.sessionId,
      result: turn.valid ? turn.result : "",
      failureCode: turn.valid ? "" : "provider_result_invalid",
    };
  }
  try {
    const parsed = JSON.parse(input.stdout) as { session_id?: unknown; result?: unknown };
    const sessionId = parseClaudeSessionId(input.stdout);
    const result = typeof parsed.result === "string" ? parsed.result : "";
    const failureCode = sessionId !== input.expectedSessionId
      ? "session_id_mismatch" as const
      : result ? "" : "provider_result_invalid" as const;
    return { sessionId, result, failureCode };
  } catch {
    return { sessionId: "", result: "", failureCode: "provider_result_invalid" };
  }
}

async function captureProviderStdout(
  stream: ReadableStream<Uint8Array>,
  mirror: boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let captured = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (mirror) process.stdout.write(text);
    captured += text;
  }
  const tail = decoder.decode();
  if (tail) {
    if (mirror) process.stdout.write(tail);
    captured += tail;
  }
  return captured;
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
    err(`dispatch_provider: probe sweep ancestry mismatch; limited to explicit anchors (worktree=${worktreeAbs}, project=${projectAbs})`);
  }
  for (const root of addDirRoots) add(resolve(root));

  const protectedGitPaths = [resolve(projectAbs, ".git"), resolve(worktreeAbs, ".git")];

  for (const dir of dirs) {
    for (const name of [".agents", ".codex"]) {
      const candidate = resolve(dir, name);
      if (!existsSync(candidate)) continue;
      try {
        if (!lstatSync(candidate).isDirectory() || readdirSync(candidate).length !== 0) {
          err(`dispatch_provider: probe sweep kept non-empty directory: ${candidate}`);
          continue;
        }
        rmdirSync(candidate);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        err(`dispatch_provider: probe sweep kept non-empty directory: ${candidate}`);
      }
    }
    // An exact, empty `<probe-anchor>/.git` directory is not repository
    // metadata and is removed by the path guard's narrow non-recursive
    // exception. Real repositories, worktree `.git` files, symlinks, races,
    // and unreadable/non-empty directories remain untouched.
    const gitCandidate = resolve(dir, ".git");
    if (existsSync(gitCandidate)) {
      const result = removeEmptyProbeGitDirSync(gitCandidate, { cleanupRoots: dirs, protectedGitPaths });
      if (!result.removed) err(`dispatch_provider: probe sweep kept ${nativeCliPath(result.candidate)}: ${result.reason}`);
    }
  }
}

interface KillableChild { pid: number; kill(signal?: number | NodeJS.Signals): void; }
interface ProviderChild extends KillableChild {
  stdin: Bun.FileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

// A provider executable can introduce shell processes between this launcher
// and the provider on Windows. taskkill /T is therefore the best-effort
// termination path; a plain child.kill() could leave nested children alive.
export function terminateChildTree(child: KillableChild): void {
  try {
    if (process.platform === "win32") {
      const taskkill = requireRuntimeExecutable("taskkill");
      // Explicit runtime-tool overrides can legitimately be Windows batch
      // launchers. libuv cannot execute .cmd/.bat directly; route only that
      // already-canonical absolute override through the native interpreter.
      // All switches remain launcher-owned literals and the PID stays numeric.
      const command = /\.(?:cmd|bat)$/i.test(taskkill)
        ? (() => {
            const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
            const commandInterpreter = realpathSync.native(resolve(systemRoot, "System32", "cmd.exe"));
            if (!statSync(commandInterpreter).isFile()) throw new Error("Windows command interpreter is not a file");
            return [commandInterpreter, "/d", "/s", "/c", "call", taskkill, "/PID", String(child.pid), "/T", "/F"];
          })()
        : [taskkill, "/PID", String(child.pid), "/T", "/F"];
      const killed = Bun.spawnSync(command, {
        windowsHide: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env,
      });
      if (killed.exitCode === 0) return;
    } else {
      process.kill(-child.pid, "SIGTERM");
      return;
    }
    child.kill("SIGTERM");
  } catch { /* the child already exited or the host is terminating */ }
}

function worktreeWip(project: string, worktree: string): Array<{ path: string; content_hash: string }> {
  const listed = Bun.spawnSync([
    requireRuntimeExecutable("git"), "-C", worktree,
    "ls-files", "-m", "-o", "--exclude-standard", "-z",
  ], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (listed.exitCode !== 0) {
    throw new Error(`cannot inventory preserved worktree files: ${listed.stderr.toString().trim()}`);
  }
  return listed.stdout.toString().split("\0").filter(Boolean).map((path) => {
    const absolute = resolve(worktree, path);
    const projectPath = relative(project, absolute).replace(/\\/g, "/");
    if (!projectPath || projectPath === ".." || projectPath.startsWith("../") || isAbsolute(projectPath)) {
      throw new Error(`preserved worktree file escapes project: ${path}`);
    }
    return { path: absolute, content_hash: hashRoleFile(absolute) };
  });
}

function recoverStoppedProvider(input: {
  authorization: RoleAuthorization;
  project: string;
  pmId: string;
  worktree: string;
  resultFile: string;
  sessionRecord: string;
  branchRef: string;
}): RoleAuthorization {
  const current = input.authorization;
  if (current.core.execution_identity.kind === "role-seat") {
    throw new Error("completed role-seat launch is immutable");
  }
  const provider: SessionProvider = current.core.routing.provider === "codex-cli"
    ? "codex-cli"
    : current.core.routing.provider === "claude-subprocess"
    ? "claude-code"
    : (() => { throw new Error(`recorded CLI recovery does not support provider ${current.core.routing.provider}`); })();
  if (provider !== "codex-cli" && provider !== "claude-code") {
    throw new Error(`recorded CLI recovery does not support provider ${current.core.routing.provider}`);
  }
  const held: SessionLock[] = [];
  const probe = (record: ProviderSessionRecord, label: string): void => {
    const acquisition = acquireSessionLock(input.sessionRecord, record);
    if (acquisition.kind === "busy") throw new Error(`provider process is still live (${label})`);
    if (acquisition.kind === "unverifiable") throw new Error(`provider ownership is unverifiable (${label}: ${acquisition.reason})`);
    if ((record.status === "running" || record.status === "resuming")
      && acquisition.kind !== "reclaimed_confirmed_dead") {
      releaseSessionLock(acquisition.lock);
      throw new Error(`provider ownership is unverifiable (${label}: missing recorded owner)`);
    }
    held.push(acquisition.lock);
  };
  try {
    if (!existsSync(input.sessionRecord)) throw new Error("provider ownership is unverifiable (session record missing)");
    const session = JSON.parse(readFileSync(input.sessionRecord, "utf8")) as ProviderSessionRecord;
    if (session.provider !== provider || typeof session.session_id !== "string"
      || session.ownership_id !== `launch-${current.core_digest}`) {
      throw new Error("provider ownership is unverifiable (session record malformed or binding ownership mismatched)");
    }
    probe(session, "session lock");
    const assignment = resolve(input.project, current.core.sources.assignment.path);
    const blueprint = current.core.sources.blueprint
      ? resolve(input.project, current.core.sources.blueprint.path)
      : null;
    const instructionLedger = current.core.instruction_ledger
      ? resolve(input.project, current.core.instruction_ledger.path)
      : null;
    validateRoleBinding({
      project_root: input.project,
      pm_id: input.pmId,
      identity: current.core.execution_identity,
      stage: "authorization",
      generation: current.core.generation,
      expected_digest: current.core_digest,
      ledger_path: instructionLedger ?? undefined,
    });
    const acceptance = resolveCanonicalRoleAcceptanceIds(assignment, blueprint);
    const execution = current.core.execution_identity.kind === "branch"
      ? { kind: "branch" as const, branch: input.branchRef }
      : { kind: "dispatch" as const, id: current.core.execution_identity.id, role: current.core.role as "worker" | "smith" | "librarian" | "artisan" };
    return recoverRoleAuthorization({
      project_root: input.project,
      pm_id: input.pmId,
      execution,
      expected_previous_digest: current.core_digest,
      item: {
        work_id: current.core.item.work_id,
        revision: hashRoleFile(resolve(input.project, current.core.item.authority.path)),
        session_id: current.core.item.session_id,
        authority_path: resolve(input.project, current.core.item.authority.path),
      },
      assignment_path: assignment,
      blueprint_path: blueprint,
      package_id: current.core.sources.package_id,
      prompt_path: resolve(input.project, current.core.sources.prompt.path),
      routing: current.core.routing,
      lens: {
        ref: current.core.lens.ref,
        source: current.core.lens.source,
        registry_path: current.core.lens.registry ? resolve(input.project, current.core.lens.registry.path) : null,
        pack_path: current.core.lens.pack ? resolve(input.project, current.core.lens.pack.path) : null,
      },
      knowledge: current.core.knowledge,
      integration: current.core.integration,
      initial_instructions_path: instructionLedger,
      recovery: {
        reason: "provider_replacement",
        wip: worktreeWip(input.project, input.worktree),
        dependencies_reaudited: true,
        acceptance_reaudited: acceptance,
      },
      issuer: { role: "attended-parent", id: "dispatch_provider:stopped-provider" },
    });
  } finally {
    for (const lock of held.reverse()) releaseSessionLock(lock);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  installPipeGuards();
  activeResultPath = "";
  let worktree = "", project = "", prompt = "", result = "", sessionRecord = "", contextPathArg = "";
  let providerArg = "";
  let sandbox = "workspace-write", model = "", effort = "", modelSource = "";
  let skillRoot = "", targetRoot = "", pmId = "", bindingDigest = "", bindingBranch = "", bindingGeneration = 0;
  let seatRole = "", seatDispatchId = "", dispatchRole = "", dispatchSlug = "";
  const extraAddDirs: string[] = [];

  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--provider": providerArg = nextValue(argv, i); i += 2; break;
      case "--worktree": worktree = nextValue(argv, i); i += 2; break;
      case "--project": project = nextValue(argv, i); i += 2; break;
      case "--prompt": prompt = nextValue(argv, i); i += 2; break;
      case "--result": result = nextValue(argv, i); i += 2; break;
      case "--session-record": sessionRecord = nextValue(argv, i); i += 2; break;
      case "--context": contextPathArg = nextValue(argv, i); i += 2; break;
      case "--sandbox": sandbox = nextValue(argv, i); i += 2; break;
      case "--seat-role": seatRole = nextValue(argv, i); i += 2; break;
      case "--seat-dispatch-id": seatDispatchId = nextValue(argv, i); i += 2; break;
      case "--role": dispatchRole = nextValue(argv, i); i += 2; break;
      case "--slug": dispatchSlug = nextValue(argv, i); i += 2; break;
      case "--model": model = nextValue(argv, i); i += 2; break;
      case "--effort": effort = nextValue(argv, i); i += 2; break;
      case "--model-source": modelSource = nextValue(argv, i); i += 2; break;
      case "--skill-root": skillRoot = nextValue(argv, i); i += 2; break;
      case "--target-root": targetRoot = nextValue(argv, i); i += 2; break;
      case "--pm-id": pmId = nextValue(argv, i); i += 2; break;
      case "--binding-generation": bindingGeneration = Number(nextValue(argv, i)); i += 2; break;
      case "--binding-digest": bindingDigest = nextValue(argv, i); i += 2; break;
      case "--binding-branch-ref": bindingBranch = nextValue(argv, i); i += 2; break;
      case "--add-dir": extraAddDirs.push(nextValue(argv, i)); i += 2; break;
      case "-h": case "--help": out(HELP); return 0;
      default: exitWith(`unknown arg: ${argv[i]}`, 2);
    }
  }

  const provider: SessionProvider = providerArg === "codex"
    ? "codex-cli"
    : providerArg === "claude-code"
    ? "claude-code"
    : exitWith("dispatch_provider: --provider must be codex|claude-code", 2);
  if (!worktree) exitWith("missing --worktree", 2);
  if (!project) exitWith("missing --project", 2);
  if (!prompt) exitWith("missing --prompt", 2);
  if (!result) exitWith("missing --result", 2);
  if (!pmId || !Number.isSafeInteger(bindingGeneration) || bindingGeneration < 1 || !/^[0-9a-f]{64}$/.test(bindingDigest)) {
    exitWith("dispatch_provider: canonical --pm-id/--binding-generation/--binding-digest are required; bindingless launch requires role_recovery", 4);
  }
  const roleSeat = seatRole
    ? (seatRole === "scout" || seatRole === "observer" || seatRole === "guardian" || seatRole === "concierge"
      ? seatRole
      : exitWith(`dispatch_provider: unsupported --seat-role '${seatRole}'`, 2))
    : null;
  if (Boolean(roleSeat) !== Boolean(seatDispatchId)) {
    exitWith("dispatch_provider: --seat-role and --seat-dispatch-id are required together", 2);
  }
  if (roleSeat && !contextPathArg) exitWith("dispatch_provider: role-seat launch requires --context", 2);
  if (!roleSeat && contextPathArg) exitWith("dispatch_provider: --context is valid only for a role-seat launch", 2);
  if (roleSeat && roleSeat !== "concierge" && extraAddDirs.length > 0) {
    exitWith(`dispatch_provider: ${roleSeat} role-seat cannot accept operator --add-dir grants; only its artifact directory is writable`, 2);
  }

  try {
    if (provider === "codex-cli") model = resolveModelName(model);
    else if (!model || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(model)) throw new Error("an explicit safe --model is required");
  } catch (error) { exitWith(`dispatch_provider: ${(error as Error).message}`, 2); }
  if (effort === "ultra" || !["", "low", "medium", "high", "xhigh"].includes(effort)) {
    exitWith(`dispatch_provider: unsupported effort '${effort}'`, 2);
  }

  if (sandbox === "danger-full-access") {
    exitWith("dispatch_provider: danger-full-access is not allowed; use workspace-write plus --add-dir grants", 2);
  }
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    exitWith(`dispatch_provider: unsupported --sandbox '${sandbox}' (expected read-only or workspace-write)`, 2);
  }
  // Resolve both launch executables before spawning. Codex may be an
  // extensionless shebang script on Windows, so Git Bash launches its exact
  // absolute path; Bash never performs a second PATH lookup.
  const bash = resolveBashExecutable();
  if (!bash) {
    exitWith("dispatch_provider: Git Bash not found (checked PATH, GARELIER_BASH, and standard Git for Windows locations)", 3);
  }
  const providerEnv = childEnvWithBun(provider, bash);
  const executableName = provider === "codex-cli" ? "codex" : "claude";
  const providerExecutable = resolveRuntimeExecutable(executableName, { env: providerEnv });
  if (!providerExecutable) exitWith(`dispatch_provider: ${executableName} CLI not found`, 3);

  const worktreeAbs = absoluteExistingDir(worktree);
  const projectAbs = absoluteExistingDir(project);
  const promptAbs = absoluteExistingFile(prompt);
  const resultAbs = resultPath(result);
  if (!worktreeAbs) exitWith(`dispatch_provider: --worktree is not an existing directory: ${worktree}`, 2);
  if (!projectAbs) exitWith(`dispatch_provider: --project is not an existing directory: ${project}`, 2);
  if (!promptAbs) exitWith(`dispatch_provider: --prompt is not a file: ${prompt}`, 2);
  const roleSeatContextAbs = roleSeat ? absoluteExistingFile(contextPathArg) : null;
  if (roleSeat && !roleSeatContextAbs) exitWith(`dispatch_provider: --context is not a file: ${contextPathArg}`, 2);
  if (roleSeat) {
    const expectedContext = absoluteExistingFile(resolve(crewSubdir(projectAbs, pmId, `dispatch${seatDispatchId}`), "context.json"));
    if (!expectedContext || roleSeatContextAbs !== expectedContext) {
      exitWith(`dispatch_provider: role-seat --context is not the canonical dispatch context for #${seatDispatchId}`, 4);
    }
  }
  const promptContractCheck = roleSeat
    ? checkRoleSeatPromptContract(readFileSync(promptAbs, "utf8"), roleSeat, resultAbs)
    : checkPromptContract(readFileSync(promptAbs, "utf8"), worktreeAbs, provider);
  if (!promptContractCheck.ok) {
    exitWith(`dispatch_provider: REFUSED — prompt ${promptContractCheck.reason}`, 5);
  }
  if (roleSeat) activeResultPath = resultAbs;
  const roleSeatContainer = roleSeat ? dirname(roleSeatContextAbs!) : "";
  // W-226 (R2, N1): --worktree must be a LINKED git worktree, never the
  // primary/shared checkout (see isLinkedGitWorktree doc above).
  if ((!roleSeat || roleSeat === "concierge") && !isLinkedGitWorktree(worktreeAbs)) {
    exitWith(`dispatch_provider: --worktree is not a linked git worktree (its .git is a directory or missing, not the "gitdir: <path>" file a linked worktree has): ${worktreeAbs}. Never point this launcher at the primary/shared checkout — it must be a dedicated dispatch_prepare/lane_dispatch worktree.`, 2);
  }
  const worktreeBranch = roleSeat && roleSeat !== "concierge" ? "" : currentBranch(worktreeAbs);
  // The checkout can itself live below another dispatch container. Never scan
  // the full absolute path: an outer ancestor must not replace this role's
  // own branch/container identity.
  const dispatchId = roleSeat ? seatDispatchId : dispatchIdForRoleCheckout(worktreeBranch, worktreeAbs);
  if (!dispatchId && !bindingBranch) exitWith("dispatch_provider: worktree has no canonical dispatch or branch binding identity", 4);
  let laneEnv: Record<string, string>;
  try {
    laneEnv = resolveLaneEnv(loadLaneEnv(projectAbs, pmId), {
      checkout: worktreeAbs,
      project: projectAbs,
      container: roleSeat ? roleSeatContainer : dirname(worktreeAbs),
      dispatchId: seatDispatchId || String(dispatchId ?? ""),
      role: dispatchRole || roleSeat || "",
      slug: dispatchSlug,
    }, "producer").values;
  } catch (error) {
    exitWith(`dispatch_provider: dispatch.env refused before provider launch: ${(error as Error).message}`, 4);
  }
  const roleIdentity = roleSeat
    ? roleSeatExecutionIdentity(dispatchId!, roleSeat)
    : bindingBranch ? roleExecutionIdentityForBranch(bindingBranch) : dispatchExecutionIdentity(dispatchId!);
  let launchAuthorization: RoleAuthorization;
  try {
    if (bindingBranch) assertRoleBranchIdentity(roleIdentity, worktreeBranch);
    try {
      launchAuthorization = validateRoleLaunchPending({
        project_root: projectAbs, pm_id: pmId, identity: roleIdentity,
        generation: bindingGeneration, expected_digest: bindingDigest,
      }).authorization;
    } catch (error) {
      if (!/role launch acknowledgement already exists/.test((error as Error).message)) throw error;
      const current = readCurrentRoleAuthorization({ project_root: projectAbs, pm_id: pmId, identity: roleIdentity });
      launchAuthorization = recoverStoppedProvider({
        authorization: current,
        project: projectAbs,
        pmId,
        worktree: worktreeAbs,
        resultFile: resultAbs,
        sessionRecord: resultPath(sessionRecord || resolve(dirname(resultAbs), "session.json")),
        branchRef: bindingBranch || worktreeBranch,
      });
      const rebound = bindingReference(launchAuthorization);
      bindingGeneration = rebound.generation;
      bindingDigest = rebound.binding_digest;
      launchAuthorization = validateRoleLaunchPending({
        project_root: projectAbs, pm_id: pmId, identity: roleIdentity,
        generation: bindingGeneration, expected_digest: bindingDigest,
      }).authorization;
    }
    const expectedRoutingProvider = provider === "codex-cli" ? "codex-cli" : "claude-subprocess";
    if (launchAuthorization.core.routing.provider !== expectedRoutingProvider) {
      throw new Error(`launcher provider ${provider} does not match authorization ${launchAuthorization.core.routing.provider}`);
    }
    assertRoutingMatches(
      {
        model: launchAuthorization.core.routing.model,
        effort: launchAuthorization.core.routing.effort,
        source: launchAuthorization.core.routing.source,
      },
      { model, effort, source: modelSource },
    );
    if (roleSeat && launchAuthorization.core.role !== roleSeat) throw new Error("role-seat authorization role does not match --seat-role");
    const boundPrompt = absoluteExistingFile(resolve(projectAbs, launchAuthorization.core.sources.prompt.path));
    if (!boundPrompt || boundPrompt !== promptAbs) throw new Error("launcher prompt does not match the canonical role binding");
  } catch (error) {
    exitWith(`dispatch_provider: role authorization refused: ${(error as Error).message}`, 4);
  }

  const worktreeNative = nativeCliPath(worktreeAbs);
  const projectNative = nativeCliPath(projectAbs);
  const promptReadable = promptAbs;
  const resultNative = resultAbs;
  let roleSeatBoundary: ReturnType<typeof roleSeatArtifactBoundary> | null = null;
  if (roleSeat && roleSeat !== "concierge") {
    try { roleSeatBoundary = roleSeatArtifactBoundary(resultAbs); }
    catch (error) { exitWith(`dispatch_provider: ${(error as Error).message}`, 2); }
  }
  const sessionRecordAbs = resultPath(sessionRecord || resolve(dirname(resultAbs), "session.json"));
  const containerAbs = roleSeat ? roleSeatContainer : dirname(worktreeAbs);
  // W-485: the container is the write grant's second root (codexProviderWritableRoots),
  // so the injected prompt must be able to NAME it. Native spelling for a CLI prompt.
  const containerNative = nativeCliPath(containerAbs);
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const skillsRoot = realpathSync(resolve(moduleDir, "../../../.."));

  // Shared with exact-session resume so adding a required fresh-launch grant
  // cannot silently strand a resumed role (W-446).
  const structuralAddDirs = roleSeatBoundary?.addDirs ?? codexProviderWritableRoots({
    worktree: worktreeAbs, container: containerAbs, resultFile: resultAbs,
  });
  const expectedAddDirs = roleSeatBoundary?.addDirs ?? codexProviderWritableRoots({
    worktree: worktreeAbs, container: containerAbs, resultFile: resultAbs, operatorAddDirs: extraAddDirs,
  });
  const addDirs = [...structuralAddDirs];
  const cleanupRoots: string[] = [];
  const addResolvedUnique = (list: string[], candidate: string): void => {
    const abs = absoluteExistingDir(candidate);
    if (!abs) return;
    const native = nativeCliPath(abs);
    if (!list.includes(native)) list.push(native);
  };
  const addDirUnique = (candidate: string): void => addResolvedUnique(addDirs, candidate);
  const addCleanupRoot = (candidate: string): void => addResolvedUnique(cleanupRoots, candidate);

  const codexHome = process.env.CODEX_HOME || resolve(process.env.HOME || "", ".codex");

  // Safety-net roots include historical broad grants so the next launch heals
  // leftovers from a prior force-killed launcher without granting them again.
  for (const root of [roleSeat ? "" : projectAbs, worktreeAbs, containerAbs, dirname(resultAbs), targetRoot,
    skillRoot || skillsRoot, resolve(codexHome, "skills"), ...addDirs]) addCleanupRoot(root);

  const contextPath = roleSeatContextAbs ?? resolve(containerAbs, "context.json");
  if (!contextPath) exitWith(`dispatch_provider: --context is not a file: ${contextPathArg}`, 2);
  // Every fresh recovery generation atomically republishes advisory context.
  // A failed prior send may have materialized context without ever producing a
  // launch acknowledgement, so existence alone cannot prove current binding.
  if (launchAuthorization.core.carabiner === "role_recovery") {
    try {
      const recoveryBranch = worktreeBranch;
      const recoveryDispatchId = dispatchId ?? /\/#([1-9][0-9]*)\//.exec(recoveryBranch)?.[1];
      if (!recoveryDispatchId) throw new Error("recovered worktree has no canonical dispatch number");
      configurePathGuardRoots([dirname(contextPath)]);
      materializeRecoveryContext({
        contextPath, projectRoot: projectAbs, pmId, worktree: worktreeAbs,
        branch: recoveryBranch, dispatchId: recoveryDispatchId, authorization: launchAuthorization,
      });
    } catch (error) {
      exitWith(`dispatch_provider: canonical recovery context generation refused: ${(error as Error).message}`, 4);
    }
  }
  let contextRouting: { model: string; effort: string; source: string } | null = null;
  let contextControl: { workId: string; sessionId: string; claimOwned: boolean } | null = null;
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
      const workId = String(context?.control?.work_id ?? "");
      const sessionId = String(context?.control?.session_id ?? "");
      if (workId && sessionId) {
        contextControl = { workId, sessionId, claimOwned: context?.control?.claim_owned !== false };
      }
    } catch { /* best effort, matching the shell helper */ }
  }
  try { assertRoutingMatches(contextRouting, { model, effort, source: modelSource }); }
  catch (error) { exitWith(`dispatch_provider: ${(error as Error).message}`, 4); }
  for (const extra of extraAddDirs) { addDirUnique(extra); addCleanupRoot(extra); }
  try { assertCodexProviderWritableRoots(addDirs, expectedAddDirs); }
  catch (error) { exitWith(`dispatch_provider: ${(error as Error).message}`, 4); }

  const executionCwdNative = roleSeatBoundary?.cwd ?? worktreeNative;
  const expectedSessionId = provider === "claude-code" ? randomUUID() : "";

  // W-265: run the real tracked-file write probe before changing the provider
  // session/result records. A stale-SID denial is repaired for the exact
  // checkout-scoped Codex capability SID and verified; repair/probe failure
  // stops the launch.
  if (provider === "codex-cli" && sandbox === "workspace-write" && (!roleSeat || roleSeat === "concierge")) {
    ensureWindowsCheckoutWritable(worktreeAbs, {
      codexHome,
      log: (message) => err(`[dispatch_provider] ${message}`),
    });
  }

  const operatorAddDirs = expectedAddDirs.filter((root) => !structuralAddDirs.includes(root));
  let sessionState = makeSessionRecord(
    provider, expectedSessionId, worktreeAbs, "running", resultAbs, undefined, contextRouting!,
    provider === "codex-cli" ? operatorAddDirs : [],
    roleSeat
      ? { container: containerAbs, resumable: false, ownershipId: `launch-${bindingDigest}` }
      : { ownershipId: `launch-${bindingDigest}` },
  );
  const launchAcquisition = acquireSessionLock(sessionRecordAbs, sessionState);
  if (launchAcquisition.kind === "busy") {
    err("dispatch_provider: provider launch is already live");
    return 4;
  }
  if (launchAcquisition.kind === "unverifiable") {
    err(`dispatch_provider: provider launch ownership is unverifiable (${launchAcquisition.reason})`);
    return 4;
  }
  const launchLock = launchAcquisition.lock;
  activeResultPath = resultAbs;

  // The binding-scoped lock covers every shared launch artifact. A loser exits
  // above without deleting or writing result or session bytes. The Codex
  // capture itself is created only after this lock is held.
  try { if (existsSync(resultAbs) && statSync(resultAbs).isFile()) unlinkSync(resultAbs); } catch { /* launch/result checks report the failure */ }
  writeSessionRecord(sessionRecordAbs, sessionState);

  const escapeGuard = roleSeat && roleSeat !== "concierge"
    ? `[Garelier role-seat sandbox rule — READ FIRST, non-negotiable]
role=${roleSeat}. The repository at ${worktreeNative} has NO WRITE GRANT. Do not
create, edit, delete, stage, commit, merge, or restore any repository file. Only
the designated artifact directory ${roleSeatBoundary!.cwd} is
writable. Return the complete ${roleSeat} artifact as your final response; the
trusted launcher captures it at ${resultNative}. If the bound task explicitly
names one sandbox-denial probe path, attempt that exact write once, treat any
unexpected success as BLOCK, and report the exact outcome; this is the sole
exception and grants no permission to retain or modify repository content.`
    : `[Garelier sandbox rule — W-077, READ FIRST, non-negotiable]
Your working directory is your OWN git worktree: ${worktreeNative}. Do ALL work
there. You are also granted read access to the project root and sibling dirs for
context ONLY.
- You may WRITE in exactly two places: your worktree, and the canonical artifact
  files directly under your dispatch container ${containerNative} —
  report.md, STATE.md, instructions.md and the launcher's result file. Nothing
  else under the container, and nothing outside these two, is writable.
  (W-485: the launcher's own --add-dir grant has always covered those container
  artifacts, because writing report.md/STATE.md IS how a role reports. An earlier
  wording of this rule said "worktree only", which contradicted the grant and left
  roles treating their own required artifacts as forbidden.)
- NEVER run 'git add', 'git commit', 'git stash', 'git restore', 'git checkout',
  or ANY index-mutating git command outside your worktree, and NEVER
  create/edit/delete files anywhere but the two places named above — above all
  NOT at the project root, the primary checkout, or a shared gitdir.
- The project root's git index is SHARED with the merge gate and other roles.
  Writing it (even staging the same change you already made in your worktree)
  corrupts the pending merge and aborts the land. This is a hard failure, not a
  style preference.
- If a tool or habit would 'git add' at the project root, STOP — the correct place
is your worktree. git READ commands (status/log/diff) anywhere are fine.`;

  if (provider === "codex-cli" && (!roleSeat || roleSeat === "concierge")) {
    sweepEmptyCodexProbeDirs(worktreeAbs, projectAbs, cleanupRoots);
  }

  err(`[dispatch_provider] provider=${provider} sandbox=${sandbox} cwd=${executionCwdNative} add_dirs=${addDirs.length} — SYNCHRONOUS, waiting...`);
  let child: KillableChild | null = null;
  let childSettled = false;
  let requestedExitCode: number | null = null;
  const terminate = (): void => {
    if (!child || childSettled) return;
    terminateChildTree(child);
  };
  const onExit = (): void => { terminate(); };
  const onSignal = (code: number): (() => void) => () => {
    requestedExitCode ??= code;
    terminate();
  };
  const sigint = onSignal(130), sigterm = onSignal(143), sigbreak = onSignal(131);
  let claimHeartbeat: DispatchClaimHeartbeat | null = null;
  let leaseLost: DispatchClaimLeaseHealth | null = null;
  try {
    if (!roleSeat && contextControl?.claimOwned && garelierControlSchema(projectAbs, pmId) === 3) {
      claimHeartbeat = startDispatchClaimHeartbeat({
        targetRoot: projectAbs,
        pmId,
        workId: contextControl.workId,
        sessionId: contextControl.sessionId,
        onError: (error) => err(`[dispatch_provider] claim heartbeat retry pending: ${error.message}`),
        // GDN-004: the lease IS the authority to execute. Losing it while the
        // provider runs is what lets a foreign session steal the claim and put
        // a second live identity on this Work, so the run stops with it.
        onLeaseLost: (health) => {
          leaseLost = health;
          err(`[dispatch_provider] claim lease lost after ${health.consecutive_failures} consecutive heartbeat failure(s): ${health.reason}`);
          requestedExitCode ??= PROVIDER_LEASE_LOST_EXIT;
          terminate();
        },
      });
    }
    const invocation = buildProviderArgv({
      provider,
      executable: providerExecutable,
      bash,
      cwd: executionCwdNative,
      sandbox,
      model,
      effort,
      addDirs,
      expectedSessionId,
    });
    process.once("exit", onExit);
    process.once("SIGINT", sigint);
    process.once("SIGTERM", sigterm);
    if (process.platform === "win32") process.once("SIGBREAK", sigbreak);
    let response: ProviderResponse = { sessionId: "", result: "", failureCode: "provider_result_invalid" };
    let code = 1;
    let failure: ProviderFailure | undefined;
    let sessionFallback: SessionFallback | undefined;
    let stderrBytes = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      childSettled = false;
      let spawned: ProviderChild;
      try {
        spawned = Bun.spawn(invocation.command, {
        cwd: executionCwdNative,
        // Project declarations override scrubbed ambient values, while the
        // complete explicit provider invariant overlay always wins layer 3.
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: injectLaneEnv(providerEnv, laneEnv, roleProviderCoreEnv()),
        detached: process.platform !== "win32",
        // W-112 emergency hotfix (2026-07-17): a console-less background parent makes
        // every console child (pwsh/cargo/git spawned by a provider) allocate a NEW visible
        // console window on Windows — the flashing windows steal the user's focus and
        // made the desktop unusable. windowsHide gives the tree a hidden console to
        // inherit so no window ever surfaces. No-op off Windows.
        windowsHide: true,
        }) as ProviderChild;
      } catch (error) {
        failure = providerSpawnFailure(error, attempt);
        code = 4;
        if (failure.retry_authorized) {
          out(`ROLE_LAUNCH_RETRY ${formatProviderFailure(failure)} next_attempt=2/2`);
          continue;
        }
        sessionFallback = {
          required: true,
          reason: "authoritative_pre_session_spawn_failure",
          action: "fresh_dispatch_required",
          detail: formatProviderFailure(failure),
        };
        break;
      }
      child = spawned;
      spawned.stdin.write(`${escapeGuard}\n\n${readFileSync(promptReadable, "utf8")}`);
      spawned.stdin.end();
      const exited = spawned.exited.then((exitCode) => { childSettled = true; return exitCode; });
      const [exitCode, stdout, attemptStderr] = await Promise.all([
        exited,
        captureProviderStdout(spawned.stdout, invocation.mirrorStdout),
        new Response(spawned.stderr).text(),
      ]);
      const attemptStdoutBytes = Buffer.byteLength(stdout, "utf8");
      const attemptStderrBytes = Buffer.byteLength(attemptStderr, "utf8");
      stderrBytes += attemptStderrBytes;
      response = extractProviderResponse({
        provider,
        stdout,
        expectedSessionId: invocation.expectedSessionId,
      });
      code = requestedExitCode ?? exitCode;
      failure = requestedExitCode !== null
        ? makeProviderFailure({
            class: "launcher_control", code: "launch_interrupted", attempt, retry_authorized: false,
            signal_exit: requestedExitCode, stdout_bytes: attemptStdoutBytes, stderr_bytes: attemptStderrBytes,
          })
        : exitCode !== 0
          ? makeProviderFailure({
              class: response.sessionId ? "provider_exit" : "session_ambiguous",
              code: response.sessionId ? "provider_exit_nonzero" : "session_id_unobserved",
              attempt, retry_authorized: false, exit_code: Math.max(0, exitCode),
              stdout_bytes: attemptStdoutBytes, stderr_bytes: attemptStderrBytes,
            })
          : response.failureCode
            ? makeProviderFailure({
                class: response.failureCode === "session_id_mismatch" ? "provider_protocol" : "provider_protocol",
                code: response.failureCode, attempt, retry_authorized: false,
                exit_code: Math.max(0, exitCode), stdout_bytes: attemptStdoutBytes, stderr_bytes: attemptStderrBytes,
              })
            : !response.result
              ? makeProviderFailure({
                  class: "provider_protocol", code: "provider_result_invalid", attempt, retry_authorized: false,
                  exit_code: Math.max(0, exitCode), stdout_bytes: attemptStdoutBytes, stderr_bytes: attemptStderrBytes,
                })
              : !response.sessionId
                ? makeProviderFailure({
                    class: "session_ambiguous", code: "session_id_unobserved", attempt, retry_authorized: false,
                    exit_code: Math.max(0, exitCode), stdout_bytes: attemptStdoutBytes, stderr_bytes: attemptStderrBytes,
                  })
                : undefined;
      if (failure) code = code || 1;
      if (failure) {
        const recoverableSessionId = response.sessionId || invocation.expectedSessionId;
        if (recoverableSessionId) response = { ...response, sessionId: recoverableSessionId };
        sessionFallback = {
          required: true,
          reason: recoverableSessionId ? "recover_original_provider_session" : "reconcile_unobserved_provider_session",
          action: recoverableSessionId ? "retry_explicit_resume" : "reconcile_provider_session",
          detail: formatProviderFailure(failure),
        };
      } else sessionFallback = undefined;
      break;
    }
    if (failure?.code === "session_id_unobserved" && invocation.expectedSessionId && response.sessionId && !roleSeat) {
      try {
        acknowledgeRoleLaunch({
          project_root: projectAbs, pm_id: pmId, identity: roleIdentity, generation: bindingGeneration,
          expect_digest: bindingDigest,
          transport: "claude-subprocess",
          provider_session_id: response.sessionId,
          success_evidence: "provider invoked with a preallocated exact session id; ambiguous result permits exact-session recovery only",
          writer: { role: "launcher", id: "dispatch_provider" },
        });
      } catch {
        failure = makeProviderFailure({
          class: "launcher_control", code: "launch_acknowledgement_refused", attempt: 1, retry_authorized: false,
        });
        sessionFallback = {
          required: true, reason: "reconcile_provider_session_binding", action: "reconcile_provider_session",
          detail: formatProviderFailure(failure),
        };
      }
    }
    if (code === 0 && !failure && response.sessionId) {
      try {
      acknowledgeRoleLaunch({
        project_root: projectAbs, pm_id: pmId, identity: roleIdentity, generation: bindingGeneration,
          expect_digest: bindingDigest,
          transport: provider === "codex-cli" ? "codex-cli" : "claude-subprocess",
          provider_session_id: response.sessionId,
          success_evidence: "provider exit 0 + exact session + captured result",
          writer: { role: "launcher", id: "dispatch_provider" },
      });
      } catch (error) {
        failure = makeProviderFailure({
          class: "launcher_control", code: "launch_acknowledgement_refused", attempt: 1, retry_authorized: false,
        });
        sessionFallback = {
          required: true, reason: "recover_original_provider_session", action: "retry_explicit_resume",
          detail: formatProviderFailure(failure),
        };
        code = 1;
      }
    }
    const delivered = code === 0 && !failure ? response.result : FAILED_RESULT;
    const deliveryError = deliverResult(delivered);
    if (deliveryError) {
      failure ||= makeProviderFailure({
        class: "launcher_control", code: "result_delivery_failed", attempt: 1, retry_authorized: false,
      });
      if (response.sessionId) sessionFallback = {
        required: true, reason: "recover_original_provider_session", action: "retry_explicit_resume",
        detail: formatProviderFailure(failure),
      };
      code = 1;
    }
    sessionState = updateSessionRecord(sessionState, {
      session_id: response.sessionId,
      status: code === 0 && !failure && response.sessionId ? "ready" : "failed",
      ...(failure ? { failure } : {}),
      ...(sessionFallback ? { fallback: sessionFallback } : {}),
    });
    writeSessionRecord(sessionRecordAbs, sessionState);
    if (stderrBytes) err(`[dispatch_provider] provider stderr bytes=${stderrBytes}`);
    // GDN-004 production reader: the run's terminal lease state is reported, so
    // an operator sees a lease-terminated run as such instead of an opaque exit.
    const lease = claimHeartbeat?.health() ?? leaseLost;
    if (lease && lease.state !== "healthy") {
      out(`ROLE_CLAIM_LEASE ${lease.state} consecutive_failures=${lease.consecutive_failures} reason=${JSON.stringify(lease.reason ?? lease.last_error ?? "unknown")}`);
    }
    if (failure) out(`ROLE_LAUNCH_FAILED ${formatProviderFailure(failure)}`);
    out("__ROLE_RESULT_BEGIN__");
    process.stdout.write(delivered);
    out("__ROLE_RESULT_END__");
    out(`__ROLE_EXIT__:${code}`);
    return code;
  } catch (error) {
    err(`[dispatch_provider] launcher internal error: ${error instanceof Error ? error.message : String(error)}`);
    const failure = makeProviderFailure({
      class: "launcher_control", code: "launcher_internal", attempt: 1, retry_authorized: false,
    });
    sessionState = updateSessionRecord(sessionState, { status: "failed", failure });
    try { writeSessionRecord(sessionRecordAbs, sessionState); } catch { /* stdout remains the terminal failure channel */ }
    const deliveryError = deliverResult(FAILED_RESULT);
    out(`ROLE_LAUNCH_FAILED ${formatProviderFailure(failure)}${deliveryError ? " delivery_error_class=write_failed" : ""}`);
    out("__ROLE_RESULT_BEGIN__");
    process.stdout.write(FAILED_RESULT);
    out("__ROLE_RESULT_END__");
    out("__ROLE_EXIT__:4");
    return 4;
  } finally {
    claimHeartbeat?.stop();
    process.off("exit", onExit);
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    if (process.platform === "win32") process.off("SIGBREAK", sigbreak);
    terminate();
    releaseSessionLock(launchLock);
    if (provider === "codex-cli" && (!roleSeat || roleSeat === "concierge")) {
      sweepEmptyCodexProbeDirs(worktreeAbs, projectAbs, cleanupRoots);
    }
  }
}

if (import.meta.main) process.exit(await main());
