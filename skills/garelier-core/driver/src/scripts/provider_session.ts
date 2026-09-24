#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, renameSync, reparseEntryOnPath, rmdirSync, unlinkSync, writeFileSync } from "../guard/path_guard.ts";
import { pidAlive, requireRuntimeExecutable, resolveBashExecutable, resolveRuntimeExecutable, shellQuote } from "./_lib.ts";
import { loadLaneEnv } from "../config.ts";
import { normalizeProviderEffort } from "../dispatch/provider_routing.ts";
import { injectLaneEnv, resolveLaneEnv } from "./lane_env.ts";
import { roleProviderCoreEnv, roleProviderEnv } from "./spawn_env.ts";
import { acknowledgeInstructionDelivery, appendRoleInstruction, assertRoleBranchIdentity, dispatchExecutionIdentity, dispatchIdForRoleCheckout, materializeRoleInstructionLedgerEntry, parseCodexRegisterConsumptionDeclarations, preflightRoleInstructionLedgerEntry, readCurrentRoleAuthorization, resolveCanonicalRoleAcceptanceIds, RoleBoundSourceDriftError, RoleResumePreflightError, roleExecutionIdentityForBranch, roleInstructionResumePointer, validateRoleBinding } from "../dispatch/role_binding.ts";
import { inspectLaneRegisterFormat, parseDispatchResultState, type LaneRegisterFinding } from "../dispatch/lane_status.ts";
import { parseLedgerRowIds } from "../dispatch/instruction_ledger.ts";
import { machineArray, renderMachineArtifact, tryParseMachineArtifact, type MachineSection } from "../dispatch/machine_artifact.ts";
import { dispatchContainer } from "../workspace.ts";
import { evaluatePreservationAdmission } from "../dispatch/preservation_admission.ts";

export const SESSION_SCHEMA = "garelier.provider-session" as const;
export const SESSION_VERSION = 4 as const;
export const PROVIDER_FAILURE_SCHEMA = "garelier.provider-failure" as const;
const CLAUDE_RESUME_QUERY = "Execute the complete follow-up instruction supplied on stdin.";
const FRESH_INSTRUCTION_QUERY = "Execute the complete instruction supplied on stdin in this existing first-party project worktree.";
const FAILED_RESUME_RESULT = "provider resume result unavailable\n";
const SEND_MESSAGE_RECEIPT_PLACEHOLDER = "<SendMessage delivery receipt>";
export type SessionProvider = "codex-cli" | "claude-code";
export type SessionStatus = "running" | "ready" | "resuming" | "failed" | "expired";
export interface ProviderRoute { model: string; effort: string; source: string }

export interface SessionFallback {
  required: true;
  reason: string;
  action: "fresh_dispatch_required" | "retry_explicit_resume" | "retry_same_resume" | "reconcile_provider_session" | "change_routing_tier";
  detail?: string;
  next_command?: string;
  retry_after_s?: number;
}

export type ProviderFailureClass =
  | "pre_session_spawn"
  | "provider_exit"
  | "session_ambiguous"
  | "provider_protocol"
  | "launcher_control";

export type ProviderFailureCode =
  | "spawn_eagain"
  | "spawn_emfile"
  | "spawn_enfile"
  | "spawn_enomem"
  | "spawn_failed"
  | "provider_exit_nonzero"
  | "session_id_unobserved"
  | "session_id_mismatch"
  | "provider_result_invalid"
  | "launch_interrupted"
  | "launch_acknowledgement_refused"
  | "result_delivery_failed"
  | "launcher_internal"
  | "stale_owner_recovered"
  | "provider_resume_failed"
  | "provider_transient";

/** Durable provider failures are deliberately closed data, never provider text.
 * A provider can put prompts, repository contents, credentials, signed URLs, or
 * arbitrary diagnostics on stderr/stdout; only these allowlisted fields cross
 * the launcher boundary. */
export interface ProviderFailure {
  schema: typeof PROVIDER_FAILURE_SCHEMA;
  version: 1;
  class: ProviderFailureClass;
  code: ProviderFailureCode;
  attempt: number;
  retry_authorized: boolean;
  exit_code?: number;
  signal_exit?: number;
  stdout_bytes?: number;
  stderr_bytes?: number;
}

export interface ProviderSessionRecord {
  schema: typeof SESSION_SCHEMA;
  version: typeof SESSION_VERSION;
  provider: SessionProvider;
  session_id: string;
  /** Stable lock identity for the whole launch/resume generation. The provider
   * session id may be learned only after launch and must never move ownership
   * to a second lock namespace. */
  ownership_id: string;
  worktree: string;
  container?: string;
  /** False for a fresh, independent read-only role seat. Such a session is
   * evidence only and must never be resumed into a later gate/review round. */
  resumable?: false;
  operator_add_dirs?: string[];
  worktree_identity: { git_dir: string };
  status: SessionStatus;
  timestamps: {
    created_at: string;
    updated_at: string;
    last_resume_at?: string;
  };
  result_file?: string;
  /** Required on a failed fresh launch; absent on healthy ready/running state. */
  failure?: ProviderFailure;
  fallback?: SessionFallback;
  routing?: ProviderRoute;
}

export interface ResumeOutcome {
  ok: boolean;
  provider?: SessionProvider;
  session_id?: string;
  record_file: string;
  result_file: string;
  status: SessionStatus | "missing" | "busy" | "invalid";
  fallback?: SessionFallback;
  exit_code?: number;
  /** Resume failures are diagnostics, never replacement producer results. */
  failure_file?: string;
  provider_stderr_file?: string;
  provider_stderr_tail?: string[];
}

interface LockOwner {
  schema: "garelier.provider-session-lock";
  version: 1;
  provider: SessionProvider;
  ownership_id: string;
  pid: number;
  nonce: string;
  started_at: string;
}

export interface SessionLock {
  path: string;
  owner: LockOwner;
}

export type SessionLockAcquisition =
  | { kind: "acquired_fresh"; lock: SessionLock }
  | { kind: "reclaimed_confirmed_dead"; lock: SessionLock; previous_owner: LockOwner }
  | { kind: "busy"; owner: LockOwner }
  | { kind: "unverifiable"; reason: "noncanonical_lock" | "owner_missing_or_malformed" | "ownership_mismatch" | "reclaim_raced" };

function now(): string { return new Date().toISOString(); }

const FAILURE_CLASSES = new Set<ProviderFailureClass>([
  "pre_session_spawn", "provider_exit", "session_ambiguous", "provider_protocol", "launcher_control",
]);
const FAILURE_CODES = new Set<ProviderFailureCode>([
  "spawn_eagain", "spawn_emfile", "spawn_enfile", "spawn_enomem", "spawn_failed",
  "provider_exit_nonzero", "session_id_unobserved", "session_id_mismatch", "provider_result_invalid",
  "launch_interrupted", "launch_acknowledgement_refused", "result_delivery_failed", "launcher_internal",
  "stale_owner_recovered", "provider_resume_failed", "provider_transient",
]);
const RETRYABLE_SPAWN_CODES = new Set<ProviderFailureCode>([
  "spawn_eagain", "spawn_emfile", "spawn_enfile", "spawn_enomem",
]);

function boundedFailureInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`invalid provider failure ${label}`);
  }
  return Number(value);
}

export function makeProviderFailure(input: Omit<ProviderFailure, "schema" | "version">): ProviderFailure {
  if (!FAILURE_CLASSES.has(input.class) || !FAILURE_CODES.has(input.code)) {
    throw new Error("provider failure class/code is not allowlisted");
  }
  const attempt = boundedFailureInteger(input.attempt, "attempt", 4);
  if (!attempt || attempt < 1) throw new Error("invalid provider failure attempt");
  const retryAuthorized = (input.class === "pre_session_spawn"
      && RETRYABLE_SPAWN_CODES.has(input.code)
      && attempt === 1)
    || (input.class === "provider_exit" && input.code === "provider_transient" && attempt <= 3);
  if (input.retry_authorized !== retryAuthorized) throw new Error("provider failure retry authority mismatch");
  return {
    schema: PROVIDER_FAILURE_SCHEMA,
    version: 1,
    class: input.class,
    code: input.code,
    attempt,
    retry_authorized: retryAuthorized,
    ...(input.exit_code === undefined ? {} : { exit_code: boundedFailureInteger(input.exit_code, "exit_code", 255)! }),
    ...(input.signal_exit === undefined ? {} : { signal_exit: boundedFailureInteger(input.signal_exit, "signal_exit", 255)! }),
    ...(input.stdout_bytes === undefined ? {} : { stdout_bytes: boundedFailureInteger(input.stdout_bytes, "stdout_bytes")! }),
    ...(input.stderr_bytes === undefined ? {} : { stderr_bytes: boundedFailureInteger(input.stderr_bytes, "stderr_bytes")! }),
  };
}

export function providerSpawnFailure(error: unknown, attempt: number): ProviderFailure {
  const raw = typeof (error as NodeJS.ErrnoException | null)?.code === "string"
    ? String((error as NodeJS.ErrnoException).code).toUpperCase()
    : "";
  const code = ({
    EAGAIN: "spawn_eagain", EMFILE: "spawn_emfile", ENFILE: "spawn_enfile", ENOMEM: "spawn_enomem",
  } as const)[raw as "EAGAIN" | "EMFILE" | "ENFILE" | "ENOMEM"] ?? "spawn_failed";
  return makeProviderFailure({
    class: "pre_session_spawn", code, attempt,
    retry_authorized: attempt === 1 && RETRYABLE_SPAWN_CODES.has(code),
  });
}

export function formatProviderFailure(failure: ProviderFailure): string {
  const safe = makeProviderFailure({ ...failure });
  return [
    `class=${safe.class}`, `code=${safe.code}`, `attempt=${safe.attempt}`,
    `retry_authorized=${safe.retry_authorized}`,
    ...(safe.exit_code === undefined ? [] : [`exit_code=${safe.exit_code}`]),
    ...(safe.signal_exit === undefined ? [] : [`signal_exit=${safe.signal_exit}`]),
    ...(safe.stdout_bytes === undefined ? [] : [`stdout_bytes=${safe.stdout_bytes}`]),
    ...(safe.stderr_bytes === undefined ? [] : [`stderr_bytes=${safe.stderr_bytes}`]),
  ].join(" ");
}
function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function nativeCliPath(path: string): string {
  return process.platform === "win32" ? path.replace(/\\/g, "/") : path;
}

// W-764: `.native` is the FULL normalization — it expands Windows 8.3 short
// names and corrects component case as well as resolving links. Every path this
// module stores in a session record or compares against one (a worktree, a git
// top-level, a grant root) goes through it, so a short-name spelling of a
// directory and the long-name spelling git reports are one key, not two.
function optionalExistingDirectory(path: string): string {
  try {
    if (!path || !statSync(path).isDirectory()) return "";
    return realpathSync.native(path);
  } catch { return ""; }
}

// Directory of the real Bun executable. Fresh launch needs it in PATH while
// both fresh launch and resume need the same narrow --add-dir grant (W-093).
export function codexProviderBunDirectory(): string {
  try { return optionalExistingDirectory(dirname(realpathSync.native(process.execPath))); }
  catch { return ""; }
}

// The fresh launcher and exact-session resume must grant the same narrow roots.
// --add-dir is a write grant, so this intentionally excludes project, target,
// skills, and other broad context roots. W-093 requires the real Bun directory:
// resumed roles run the same scoped checks as freshly launched roles.
export function codexProviderWritableRoots(input: {
  worktree: string;
  container?: string;
  resultFile?: string;
  operatorAddDirs?: readonly string[];
}): string[] {
  const worktree = canonicalExistingDirectory(input.worktree, "Codex provider worktree");
  const expectedContainer = canonicalExistingDirectory(dirname(worktree), "Codex provider container");
  const container = input.container
    ? canonicalExistingDirectory(input.container, "Codex provider container")
    : expectedContainer;
  if (pathKey(container) !== pathKey(expectedContainer)) {
    throw new Error("Codex provider container must be the worktree parent");
  }

  const roots: string[] = [];
  const add = (candidate: string): void => {
    const root = optionalExistingDirectory(candidate);
    if (!root) return;
    const native = nativeCliPath(root);
    if (!roots.some((current) => pathKey(current) === pathKey(native))) roots.push(native);
  };
  add(worktree);
  add(container);
  if (input.resultFile) add(dirname(resolve(input.resultFile)));
  add(codexProviderBunDirectory());
  for (const root of input.operatorAddDirs ?? []) add(root);
  return roots;
}

// main() may assemble the final list incrementally, but every root must still
// be authorized by the shared launch/resume builder. This closes the drift
// class where a fresh-launch-only structural grant silently strands resume.
export function assertCodexProviderWritableRoots(
  actual: readonly string[],
  expected: readonly string[],
): void {
  if (actual.length !== expected.length || actual.some((root, index) => pathKey(root) !== pathKey(expected[index] ?? ""))) {
    throw new Error("Codex launch writable roots bypassed the shared provider builder");
  }
}

function codexProviderOperatorWritableRoots(input: {
  worktree: string;
  container?: string;
  resultFile?: string;
  operatorAddDirs?: readonly string[];
}): string[] {
  const { operatorAddDirs, ...structuralInput } = input;
  const structural = codexProviderWritableRoots(structuralInput);
  const complete = codexProviderWritableRoots({ ...structuralInput, operatorAddDirs });
  return complete.filter((root) => !structural.some((current) => pathKey(current) === pathKey(root)));
}

function explicitSessionId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  if (!id || id.length > 512 || /\s/.test(id) || id.startsWith("-")) return "";
  if (id === "last" || id === "continue" || id === "--last" || id === "--continue") return "";
  return id;
}

function strictRoute(value: unknown, label: string): ProviderRoute {
  if (!value || typeof value !== "object") throw new Error(`${label} routing is required`);
  const route = value as Partial<ProviderRoute>;
  const model = typeof route.model === "string" ? route.model.trim() : "";
  let effort = "";
  try { effort = normalizeProviderEffort(typeof route.effort === "string" ? route.effort : ""); }
  catch { throw new Error(`${label} routing effort is invalid`); }
  const source = typeof route.source === "string" ? route.source.trim() : "";
  if (!model || model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(model)) throw new Error(`${label} routing model is invalid`);
  if (!source || source.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/+,=-]*$/.test(source)) throw new Error(`${label} routing source is invalid`);
  return { model, effort, source };
}

function sameRoute(left: ProviderRoute, right: ProviderRoute): boolean {
  return left.model === right.model && left.effort === right.effort && left.source === right.source;
}

function canonicalExistingDirectory(path: string, label: string): string {
  try {
    if (!statSync(path).isDirectory()) throw new Error();
    return realpathSync.native(path);
  } catch {
    throw new Error(`${label} is not an existing directory: ${path}`);
  }
}

function gitOutput(worktree: string, args: string[]): string {
  const result = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", worktree, ...args], {
    windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

export function worktreeIdentity(path: string): { worktree: string; git_dir: string } {
  const worktree = canonicalExistingDirectory(path, "worktree");
  const identity = gitOutput(worktree, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]).split(/\r?\n/);
  if (identity.length !== 2 || identity.some((value) => !value.trim())) {
    throw new Error("git worktree identity output is malformed");
  }
  const top = canonicalExistingDirectory(identity[0]!, "git top-level");
  if (pathKey(top) !== pathKey(worktree)) throw new Error(`worktree must be the git top-level: ${path}`);
  const gitDir = canonicalExistingDirectory(identity[1]!, "git dir");
  return { worktree, git_dir: gitDir };
}

function atomicWrite(path: string, content: string): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, target);
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve primary failure */ }
  }
}

export function writeSessionRecord(path: string, record: ProviderSessionRecord): void {
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
}

export function makeSessionRecord(
  provider: SessionProvider,
  sessionId: string,
  worktreePath: string,
  status: SessionStatus,
  resultFile = "",
  fallback?: SessionFallback,
  routing?: ProviderSessionRecord["routing"],
  operatorAddDirs: readonly string[] = [],
  options: { container?: string; resumable?: boolean; ownershipId?: string } = {},
): ProviderSessionRecord {
  const identity = worktreeIdentity(worktreePath);
  const resumable = options.resumable !== false;
  const container = canonicalExistingDirectory(
    options.container ?? dirname(identity.worktree),
    "provider container",
  );
  if (resumable && pathKey(container) !== pathKey(canonicalExistingDirectory(dirname(identity.worktree), "provider container"))) {
    throw new Error("resumable provider container must be the worktree parent");
  }
  if (!resumable && operatorAddDirs.length > 0) {
    throw new Error("one-shot provider sessions cannot persist writable add-dir grants");
  }
  const operatorRoots = operatorAddDirs.length
    ? codexProviderOperatorWritableRoots({
        worktree: identity.worktree,
        container,
        resultFile,
        operatorAddDirs,
      })
    : [];
  const timestamp = now();
  const ownershipId = explicitSessionId(options.ownershipId ?? sessionId);
  if (!ownershipId) throw new Error("provider session ownership id is required");
  return {
    schema: SESSION_SCHEMA,
    version: SESSION_VERSION,
    provider,
    session_id: sessionId,
    ownership_id: ownershipId,
    worktree: identity.worktree,
    container,
    ...(!resumable ? { resumable: false as const } : {}),
    ...(operatorRoots.length ? { operator_add_dirs: operatorRoots } : {}),
    worktree_identity: { git_dir: identity.git_dir },
    status,
    timestamps: { created_at: timestamp, updated_at: timestamp },
    ...(resultFile ? { result_file: resolve(resultFile) } : {}),
    ...(fallback ? { fallback } : {}),
    ...(routing ? { routing } : {}),
  };
}

export function updateSessionRecord(
  record: ProviderSessionRecord,
  changes: Partial<Pick<ProviderSessionRecord, "session_id" | "status" | "result_file" | "failure" | "fallback" | "routing">>,
  resumed = false,
): ProviderSessionRecord {
  const timestamp = now();
  const next: ProviderSessionRecord = {
    ...record,
    ...changes,
    timestamps: {
      ...record.timestamps,
      updated_at: timestamp,
      ...(resumed ? { last_resume_at: timestamp } : {}),
    },
  };
  if (changes.fallback === undefined && (changes.status === "ready" || changes.status === "resuming")) delete next.fallback;
  if (changes.failure === undefined && (changes.status === "ready" || changes.status === "resuming")) delete next.failure;
  return next;
}

export function parseCodexSessionId(line: string): string {
  try {
    const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
    return event.type === "thread.started" ? explicitSessionId(event.thread_id) : "";
  } catch { return ""; }
}

export interface CodexJsonlTurn {
  sessionId: string;
  result: string;
  completed: boolean;
  failed: boolean;
  valid: boolean;
}

/**
 * Decode the typed `codex exec --json` stream carried by the launcher's stdout
 * pipe. The last completed agent message is authoritative only when the stream
 * has one coherent thread and a terminal `turn.completed` event. Malformed,
 * contradictory, failed, or post-terminal events invalidate the whole turn.
 */
export function parseCodexJsonlTurn(output: string): CodexJsonlTurn {
  let phase: "awaiting-thread" | "active" | "terminal" = "awaiting-thread";
  let sessionId = "";
  let result = "";
  let completed = false;
  let failed = false;
  let invalid = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (phase === "terminal") { invalid = true; continue; }
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid event");
      event = parsed as Record<string, unknown>;
    } catch {
      invalid = true;
      continue;
    }
    const type = event.type;
    if (typeof type !== "string") { invalid = true; continue; }
    if (type === "thread.started") {
      const observed = explicitSessionId(event.thread_id);
      if (phase !== "awaiting-thread" || !observed) invalid = true;
      else {
        sessionId = observed;
        phase = "active";
      }
    } else if (type === "item.completed") {
      const item = event.item;
      if (!item || typeof item !== "object" || Array.isArray(item)) { invalid = true; continue; }
      const typedItem = item as Record<string, unknown>;
      if (typedItem.type === "agent_message") {
        if (phase !== "active" || typeof typedItem.text !== "string") invalid = true;
        else result = typedItem.text;
      }
    } else if (type === "turn.completed") {
      if (phase !== "active") invalid = true;
      completed = true;
      phase = "terminal";
    } else if (type === "turn.failed") {
      if (phase !== "active") invalid = true;
      failed = true;
      phase = "terminal";
    }
  }
  const valid = !invalid && phase === "terminal" && completed && !failed && Boolean(sessionId) && Boolean(result);
  return { sessionId, result, completed, failed, valid };
}

export function parseClaudeSessionId(output: string): string {
  try {
    const value = JSON.parse(output) as { session_id?: unknown };
    return explicitSessionId(value.session_id);
  } catch { return ""; }
}

function parseClaudeResult(output: string): string | null {
  try {
    const value = JSON.parse(output) as { result?: unknown };
    return typeof value.result === "string" ? value.result : null;
  } catch { return null; }
}

function boundedErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : "NonError";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "Error";
}

function byteCount(value: string): number { return Buffer.byteLength(value, "utf8"); }
function boundedExitCode(value: number): string { return Number.isSafeInteger(value) ? String(value) : "unknown"; }

function readRecord(path: string): ProviderSessionRecord {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProviderSessionRecord>;
  if (value.schema !== SESSION_SCHEMA || value.version !== SESSION_VERSION) throw new Error("unsupported session record schema/version");
  if (value.provider !== "codex-cli" && value.provider !== "claude-code") throw new Error("unsupported session provider");
  if (!["running", "ready", "resuming", "failed", "expired"].includes(String(value.status))) throw new Error("unsupported session status");
  if (typeof value.session_id !== "string") throw new Error("invalid session id field");
  if (!explicitSessionId(value.ownership_id)) throw new Error("invalid session ownership id field");
  if (!value.worktree || !value.worktree_identity?.git_dir || !value.timestamps?.created_at || !value.timestamps.updated_at) {
    throw new Error("incomplete session record");
  }
  const expectedContainer = canonicalExistingDirectory(dirname(value.worktree), "session container");
  const recordedContainer = value.container
    ? canonicalExistingDirectory(value.container, "session container")
    : expectedContainer;
  if (value.resumable !== false && pathKey(recordedContainer) !== pathKey(expectedContainer)) {
    throw new Error("resumable session container does not match the worktree parent");
  }
  value.container = recordedContainer;
  if (value.operator_add_dirs !== undefined) {
    if (value.provider !== "codex-cli" || !Array.isArray(value.operator_add_dirs)
      || value.operator_add_dirs.some((root) => typeof root !== "string")) {
      throw new Error("invalid session operator add-dir field");
    }
    value.operator_add_dirs = codexProviderOperatorWritableRoots({
      worktree: value.worktree,
      container: expectedContainer,
      resultFile: value.result_file,
      operatorAddDirs: value.operator_add_dirs,
    });
  }
  if (value.routing !== undefined) value.routing = strictRoute(value.routing, "record");
  if (value.failure !== undefined) value.failure = makeProviderFailure({ ...value.failure });
  return value as ProviderSessionRecord;
}

function validateRecordWorktree(record: ProviderSessionRecord, requested: string): string {
  const identity = worktreeIdentity(requested);
  if (pathKey(identity.worktree) !== pathKey(record.worktree)) throw new Error("session belongs to a different worktree path");
  if (pathKey(identity.git_dir) !== pathKey(record.worktree_identity.git_dir)) throw new Error("session belongs to a different git worktree identity");
  return identity.worktree;
}

/** Read-only handoff admission reuses resume's schema and worktree checks. */
export function readProviderSessionHandoff(recordPath: string, worktree: string, expectedRouting?: ProviderRoute): ProviderSessionRecord {
  if (reparseEntryOnPath(recordPath) || reparseEntryOnPath(worktree)) {
    throw new Error("provider handoff must not traverse a symlink or reparse point");
  }
  const record = readRecord(recordPath);
  validateRecordWorktree(record, worktree);
  if (!explicitSessionId(record.session_id)) throw new Error("invalid handoff provider session id");
  if (expectedRouting && !sameRoute(strictRoute(record.routing, "record"), strictRoute(expectedRouting, "expected"))) {
    throw new Error("provider handoff routing does not match the canonical authorization");
  }
  return record;
}

function lockPath(recordPath: string, provider: SessionProvider, ownershipId: string, lockDir = ""): string {
  const digest = createHash("sha256").update(`${provider}\0${ownershipId}`).digest("hex").slice(0, 32);
  return join(lockDir ? resolve(lockDir) : join(dirname(resolve(recordPath)), "locks"), `${digest}.lock`);
}

function safeLockDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    // W-764: reparse traversal is proven by lstat on every entry, not by
    // comparing the lexical spelling with a realpath result — realpath also
    // normalizes 8.3 short names and case, which are spellings, not escapes.
    return stat.isDirectory() && !stat.isSymbolicLink() && !reparseEntryOnPath(path);
  } catch { return false; }
}

function readLockOwner(path: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const owner = parsed as Partial<LockOwner>;
    const keys = Object.keys(owner).sort();
    const expected = ["schema", "version", "provider", "ownership_id", "pid", "nonce", "started_at"].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
    if (owner.schema !== "garelier.provider-session-lock" || owner.version !== 1
      || (owner.provider !== "codex-cli" && owner.provider !== "claude-code")
      || !explicitSessionId(owner.ownership_id)
      || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0
      || typeof owner.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(owner.nonce)
      || typeof owner.started_at !== "string" || !Number.isFinite(Date.parse(owner.started_at))) return null;
    return owner as LockOwner;
  } catch { return null; }
}

export function releaseSessionLock(lock: SessionLock): void {
  if (!safeLockDirectory(lock.path)) return;
  const current = readLockOwner(lock.path);
  if (!current || current.nonce !== lock.owner.nonce) return;
  try { unlinkSync(join(lock.path, "owner.json")); } catch { return; }
  try { rmdirSync(lock.path); } catch { /* another entry appeared; fail closed */ }
}

function reclaimStaleLock(path: string, observed: LockOwner): boolean {
  if (pidAlive(observed.pid) || !safeLockDirectory(path)) return false;
  const current = readLockOwner(path);
  if (!current || current.nonce !== observed.nonce || pidAlive(current.pid)) return false;
  try { unlinkSync(join(path, "owner.json")); } catch { return false; }
  try { rmdirSync(path); return true; } catch { return false; }
}

export function acquireSessionLock(recordPath: string, record: ProviderSessionRecord, lockDir = ""): SessionLockAcquisition {
  const path = lockPath(recordPath, record.provider, record.ownership_id, lockDir);
  mkdirSync(dirname(path), { recursive: true });
  let reclaimedOwner: LockOwner | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path);
      const owner: LockOwner = {
        schema: "garelier.provider-session-lock", version: 1,
        provider: record.provider, ownership_id: record.ownership_id,
        pid: process.pid, nonce: randomUUID(), started_at: now(),
      };
      try { writeFileSync(join(path, "owner.json"), `${JSON.stringify(owner)}\n`); }
      catch (error) {
        try { rmdirSync(path); } catch { /* leave an unverifiable lock, never steal it */ }
        throw error;
      }
      const lock = { path, owner };
      return reclaimedOwner
        ? { kind: "reclaimed_confirmed_dead", lock, previous_owner: reclaimedOwner }
        : { kind: "acquired_fresh", lock };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!safeLockDirectory(path)) return { kind: "unverifiable", reason: "noncanonical_lock" };
      const owner = readLockOwner(path);
      if (!owner) return { kind: "unverifiable", reason: "owner_missing_or_malformed" };
      if (owner.provider !== record.provider || owner.ownership_id !== record.ownership_id) {
        return { kind: "unverifiable", reason: "ownership_mismatch" };
      }
      if (pidAlive(owner.pid)) return { kind: "busy", owner };
      if (!reclaimStaleLock(path, owner)) return { kind: "unverifiable", reason: "reclaim_raced" };
      reclaimedOwner = owner;
    }
  }
  return { kind: "unverifiable", reason: "reclaim_raced" };
}

export interface CapturedRegisterFinding {
  /** The machine name of one repair. Distinct names are the deliverable: a
   * producer told "your register is malformed" spends a round guessing. */
  code: string;
  message: string;
}

export interface CapturedRegisterInput {
  /** The bytes just written to the result file. */
  register: string;
  /** `instructions.md` as it stands NOW. The driver reads the file rather than
   * trusting a count carried in a prompt (W-688 AC-5). */
  ledger: string;
  /** True for a PROXY-commit lane. Two clauses hang off it, and both are
   * transport contracts rather than universal ones: the COMMIT PLAN block (a
   * producer that commits for itself has no plan to hand over) and the
   * register's own `[[instruction]]` consumption declarations (a self-committing
   * producer edits `instructions.md` directly instead). */
  proxyLane: boolean;
}

export interface DispatchRegisterLaneShape {
  provider: "codex" | "claude-code";
  commitMode: "proxy" | "self" | "read-only";
  proxyLane: boolean;
}

/** One provider-neutral register shape, derived from the provider transport and
 * commit mode already selected by dispatch_prepare. */
export function dispatchRegisterLaneShape(
  provider: unknown,
  commitMode: unknown,
): DispatchRegisterLaneShape {
  if (provider !== "codex" && provider !== "claude-code") {
    throw new Error(`dispatch register provider must be codex or claude-code, got ${JSON.stringify(provider)}`);
  }
  if (commitMode !== "proxy" && commitMode !== "self" && commitMode !== "read-only") {
    throw new Error(`dispatch register commit_mode must be proxy, self, or read-only, got ${JSON.stringify(commitMode)}`);
  }
  return { provider, commitMode, proxyLane: commitMode === "proxy" };
}

/** Read the commit mode from the dispatch fact pack. context.json exists before
 * the provider starts; ready.json is launch output and therefore cannot be a
 * precondition for validating the provider's first captured register. */
export function readDispatchRegisterCommitMode(
  containerPath: string,
): DispatchRegisterLaneShape["commitMode"] {
  const container = resolve(containerPath);
  const contextPath = join(container, "context.json");
  if (!existsSync(contextPath)) throw new Error(`dispatch register shape requires ${contextPath}`);
  let context: Record<string, any>;
  try { context = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, any>; }
  catch { throw new Error(`dispatch register shape cannot parse ${contextPath}`); }
  const contextMode = context?.routing?.commit_mode;
  if (contextMode !== "proxy" && contextMode !== "self" && contextMode !== "read-only") {
    throw new Error(`dispatch register commit_mode must be proxy, self, or read-only, got ${JSON.stringify(contextMode)}`);
  }
  return contextMode;
}

/** Stable body sections emitted by the full register template (W-807). */
export const FULL_REGISTER_REQUIRED_HEADINGS = [
  "## Acceptance evidence",
  "## Role census",
  "## Cross-check declarations",
  "## Out of scope",
] as const;

const FULL_REGISTER_ANGLE_TOKEN = /<[^<>\r\n]+>/g;

function angleTokens(source: string): string[] {
  return [...new Set(source.match(FULL_REGISTER_ANGLE_TOKEN) ?? [])];
}

let fullRegisterTemplateTokenSet: ReadonlySet<string> | null = null;

/** The denominator is the template the driver actually emits, not the
 * finished register's unrestricted angle-bracket prose. */
function emittedFullRegisterTemplateTokenSet(): ReadonlySet<string> {
  if (fullRegisterTemplateTokenSet) return fullRegisterTemplateTokenSet;
  const emptyLedger = "+++\n[lane]\nstate = 'EMPTY'\n+++\n";
  fullRegisterTemplateTokenSet = new Set([
    ...angleTokens(renderFullRegisterTemplate(
      emptyLedger,
      "lane/result.md",
      dispatchRegisterLaneShape("codex", "proxy"),
    )),
    ...angleTokens(renderFullRegisterTemplate(
      emptyLedger,
      "lane/register.md",
      dispatchRegisterLaneShape("claude-code", "self"),
    )),
  ]);
  return fullRegisterTemplateTokenSet;
}

/** The placeholder vocabulary is derived from the emitted template bytes.
 * Launcher capture, Dock proxy admission and tests all use this same scanner;
 * adding a token to the template cannot silently create an unvalidated class. */
export function fullRegisterTemplatePlaceholders(source: string): string[] {
  const emitted = emittedFullRegisterTemplateTokenSet();
  return angleTokens(source).filter((token) => emitted.has(token));
}

/**
 * Full producer register skeleton shared by the initial dispatch prompt and
 * every resume pointer. Proxy instruction rows come from the current ledger
 * bytes, not from a count or range copied into a follow-up message
 * (W-807/W-688).
 */
export function renderFullRegisterTemplate(
  ledger: string,
  artifactPath: string,
  shape: DispatchRegisterLaneShape,
): string {
  const candidateCommit = shape.commitMode === "proxy"
    ? "proxy pending"
    : shape.commitMode === "self" ? "<commit SHA>" : "not applicable (read-only)";
  const sections: MachineSection[] = [
    { name: "lane", fields: [["state", "REPORTING"], ["detail", "<summary>"]] },
    { name: "candidate", fields: [["branch", "<branch>"], ["commit", candidateCommit]] },
    { name: "gate", fields: [["result", "SELF_GATE_PENDING"], ["detail", "<scoped checks and delegated closure>"]] },
  ];
  const parsed = shape.proxyLane ? tryParseMachineArtifact(ledger, "instruction ledger") : null;
  if (parsed?.ok) {
    for (const row of machineArray(parsed.artifact, "instruction", "instruction ledger")) {
      const id = typeof row.id === "string" ? row.id : "";
      const message = typeof row.message === "string" ? row.message : "";
      const digest = typeof row.digest === "string" && /^[0-9a-f]{12}$/.test(row.digest)
        ? row.digest
        : createHash("sha256").update(message).digest("hex").slice(0, 12);
      sections.push({
        name: "instruction", array: true,
        fields: [
          ["id", id], ["digest", digest], ["checked", "true"],
          ["consumed", `artifact:${artifactPath}`],
        ],
      });
    }
  }
  const body = [
    "## Acceptance evidence", "", "<one row per acceptance criterion: file + symbol + oracle + RED/GREEN result>", "",
    "## Role census", "", "<required role/path census or not-applicable evidence>", "",
    "## Cross-check declarations", "", "<definition-count, cross-flow, provenance, and other blueprint cross-checks>", "",
    "## Out of scope", "", "<scope-out count and evidence>", "",
    "=== REQUIRED GATE (Dock-run) ===", "<exact project-declared command, one per line>", "=== END REQUIRED GATE ===", "",
    'GARELIER_RUNTIME_STATUS: {"runtime_ok": true, "detail": "<runtime recovery evidence>"}', "",
    ...(shape.proxyLane ? [
      "=== COMMIT PLAN ===", "files:", "- <project-relative-path>", "message:",
      "<type>(<scope>): <summary> [#<dispatch>]", "", "<why>", "",
      "Garelier: <pm> <role>#<dispatch> <work-id>",
      "Garelier-Seat: codex <model> (proxy-commit via dock seat)",
      "=== END COMMIT PLAN ===",
    ] : []),
  ].join("\n");
  return renderMachineArtifact(sections, body).trimEnd();
}

function inspectFullRegisterBody(register: string): CapturedRegisterFinding[] {
  const findings: CapturedRegisterFinding[] = [];
  const missing = FULL_REGISTER_REQUIRED_HEADINGS.filter((heading) =>
    !register.split(/\r?\n/).some((line) => line.trim() === heading));
  if (missing.length > 0) {
    findings.push({
      code: "register_full_evidence_missing",
      message: `full register evidence surface is incomplete; missing mandatory heading(s): ${missing.join(", ")}. Reissue the complete register, never a shortened skeleton.`,
    });
  }
  if (fullRegisterTemplatePlaceholders(register).length > 0) {
    findings.push({
      code: "register_template_placeholder_unresolved",
      message: "full register still contains an unresolved template placeholder",
    });
  }
  return findings;
}

/**
 * The register contract, evaluated at CAPTURE (W-688).
 *
 * Everything here is already a MUST in the role prompt and already checkable
 * against files on disk. Nothing checked it, so a register missing its front
 * matter and its COMMIT PLAN block was recorded as
 * `{"ok":true,"status":"ready"}` and failed one seat later — at `dock_proxy`,
 * at the gate seat, or in the PM's eyes. Each of those discoveries cost a whole
 * round for a defect that needed no provider turn to find.
 *
 * NOT checked here:
 *
 *  - `declared_base_sha`. The fourth round in the #538 series (r21→r22) was
 *    `bind_review_sha` refusing a producer-authored base, and W-709 closed that
 *    in the OPPOSITE direction — the field is driver-owned, so the binder
 *    writes it and announces the overwrite in the Dock accounting. A
 *    capture-time refusal would rebuild the round the ruling removed.
 *  - any lane's instruction digest / `checked` / full `consumed` values. Delivering an
 *    instruction and consuming it are separate acts, and a resume legitimately
 *    ends with the entry it just delivered still open — that is what
 *    `contract_check --stall-scan` and `validateRoleBinding`'s
 *    `requireConsumedLedger` are for, at REPORTING and close. Moving that
 *    predicate here would refuse the delivery turn itself.
 */
export function inspectCapturedRegister(input: CapturedRegisterInput): CapturedRegisterFinding[] {
  const findings: CapturedRegisterFinding[] = inspectLaneRegisterFormat(input.register, {
    requireCommitPlan: input.proxyLane,
  }).map((finding: LaneRegisterFinding) => ({ code: finding.fault, message: finding.message }));

  let state: string | null = null;
  try {
    state = parseDispatchResultState(input.register);
  } catch {
    // The format findings above already carry the actionable parse refusal.
    // Capture must return those findings instead of replacing them with an
    // exception from a second state read.
  }

  // The remaining clause is the PROXY transcription contract, and it is a
  // REPORTING predicate: BLOCKED does not require declarations here. Capture
  // success is not consumption proof; downstream admission checks full values.
  if (state === "REPORTING") {
    findings.push(...inspectFullRegisterBody(input.register));
  }
  if (!input.proxyLane || findings.some((finding) => finding.code === "register_front_matter_missing")
    || state !== "REPORTING") return findings;

  // The denominator is the ledger FILE, read now, so it is current by
  // construction — including the entry this very resume appended. #538 spent
  // r20 and r21 on a count the PM had typed into a followup that was itself the
  // next entry, which is why no number reaches this comparison.
  const ledgerIds = parseLedgerRowIds(input.ledger);
  let declarations: Map<string, { digest: string; consumed: string }>;
  try {
    declarations = parseCodexRegisterConsumptionDeclarations(input.register);
  } catch (error) {
    findings.push({
      code: "instruction_ledger_declaration_invalid",
      message: (error as Error).message,
    });
    return findings;
  }
  if (ledgerIds.length === 0) return findings;
  const declared = new Set(declarations.keys());
  const undeclared = ledgerIds.filter((id) => !declared.has(id));
  if (undeclared.length > 0) {
    findings.push({
      code: "instruction_ledger_undeclared",
      message: `register declares instruction IDs for ${declared.size} of the ${ledgerIds.length} \`[[instruction]]\` table(s) in instructions.md;`
        + ` missing: ${undeclared.join(", ")}. Re-read instructions.md immediately before writing the register and declare every entry it holds`
        + " (this round's own entry included) — never a count or id range carried in a message.",
    });
  }
  const parsedLedger = tryParseMachineArtifact(input.ledger, "instruction ledger");
  if (parsedLedger.ok) {
    for (const row of machineArray(parsedLedger.artifact, "instruction", "instruction ledger")) {
      const id = typeof row.id === "string" ? row.id : "";
      const expectedDigest = typeof row.digest === "string" ? row.digest : "";
      const declaration = declarations.get(id);
      if (declaration && expectedDigest && declaration.digest !== expectedDigest) {
        findings.push({
          code: "instruction_ledger_digest_mismatch",
          message: `${id} declares digest ${declaration.digest}, but instructions.md carries ${expectedDigest}`,
        });
      }
    }
  }
  return findings;
}

/** Read the files `inspectCapturedRegister` compares, from one container.
 *
 * `proxyLane` is DERIVED from the container's own pre-launch `context.json`,
 * not passed in by a caller: commit mode is a dispatch fact the mechanism
 * already recorded. An override exists for tests, never for production
 * callers. */
export function readCapturedRegisterInput(input: {
  container: string;
  resultFile: string;
  proxyLane?: boolean;
}): CapturedRegisterInput {
  const read = (path: string): string => {
    try { return existsSync(path) ? readFileSync(path, "utf8") : ""; }
    catch { return ""; }
  };
  const container = resolve(input.container);
  const proxyLane = input.proxyLane ?? readDispatchRegisterCommitMode(container) === "proxy";
  return {
    register: read(input.resultFile),
    ledger: read(join(container, "instructions.md")),
    proxyLane,
  };
}

/** Shared producer capture contract. Gate seats deliver a separate verdict artifact;
 * their launch contract, not lane-register grammar, admits that artifact. */
export function capturedRegisterFallback(input: {
  container: string; resultFile: string; proxyLane?: boolean; role?: string;
}): SessionFallback | undefined {
  if (input.role === "guardian" || input.role === "observer") return undefined;
  const findings = inspectCapturedRegister(readCapturedRegisterInput(input));
  return findings.length ? fallback(
    "register_contract_unsatisfied", "retry_explicit_resume",
    findings.map((finding) => `${finding.code}: ${finding.message}`).join(" | "),
    `# resume the SAME record and re-emit the register: ${findings.map((finding) => finding.code).join(", ")}`,
  ) : undefined;
}

/** A provider/role diagnostic message, made safe to put in a durable record.
 *
 * Durable failures are closed data (see `ProviderFailure`), so nothing a
 * PROVIDER wrote may cross this boundary. These messages are different: every
 * one is authored by `role_binding.ts` itself and already names the drifted
 * source by its PROJECT-RELATIVE path. What this does is enforce that — an
 * absolute path (a drive letter, a leading slash, a UNC prefix) is dropped
 * rather than recorded (W-440), control characters are stripped, and the whole
 * thing is capped.
 */
function boundedDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || /(?:^|[\s(:])(?:[A-Za-z]:[\\/]|\/\/|\\\\|\/[A-Za-z_.])/.test(clean)) return "";
  return clean.length > 400 ? `${clean.slice(0, 397)}...` : clean;
}

function boundedFailureDetail(error: unknown, stage: string): string {
  const message = boundedDiagnostic(error);
  return `error_class=${boundedErrorClass(error)} stage=${stage}${message ? ` message=${message}` : " message=unavailable"}`;
}

/** Which bound source drifted, and the ONE command that resumes past it.
 *
 * W-441/W-860: the retired detail carried only the exception class for every one of
 * these, because `boundedErrorClass` returns `error.name` and each of them is a
 * plain `Error`. Two lanes failed identically on a downstream project's
 * dispatch #538/#539; the PM diagnosed a claim expiry, handed the gate seat a
 * wrong counterfactual, and the real cause (a blueprint committed mid-run) only
 * appeared after an Observer hashed each bound source by hand. The messages
 * were always discriminating — nothing carried them.
 *
 * The recovery command is part of the same defect: a refusal that names no
 * remedy sends the reader to `--recover-role`'s ten steps, and
 * `--blueprint-update-commit` (which exists, and is the right move for the most
 * common case) was reachable only from memory.
 */
export function resumeDriftRecovery(input: {
  error: unknown;
  projectRoot: string;
  pmId: string;
  dispatchId?: string;
  branchRef?: string;
}): { detail: string; nextCommand: string } {
  const message = boundedDiagnostic(input.error);
  const detail = `error_class=${boundedErrorClass(input.error)}${message ? ` message=${message}` : ""}`;
  const script = (name: string): string =>
    posixScript(resolve(dirname(fileURLToPath(import.meta.url)), name));
  const identity = input.branchRef
    ? ["--recovery-branch", input.branchRef]
    : ["--recovery-dispatch", input.dispatchId ?? "<dispatch id>"];
  const source = input.error instanceof RoleBoundSourceDriftError && input.error.sourceLabel === "blueprint"
    ? "blueprint"
    : input.error instanceof RoleBoundSourceDriftError && input.error.sourceLabel === "item authority"
    ? "item_authority"
    : "";
  const nextCommand = source === "blueprint"
    // The flag already exists and is the documented way to admit a blueprint
    // the PM committed mid-run; nothing named it (W-441 AC-N2).
    ? [requireRuntimeExecutable("bun"), script("provider_session.ts"), "resume",
      "--blueprint-update-commit", "<the commit that carries the delivered blueprint>",
      "# …plus the flags this lane's ready.json resume_cmd already carries"]
      .map((part, index) => (index === 0 || part.startsWith("#") ? part : shellQuote(part))).join(" ")
    : source === "item_authority"
    ? shellCommandLine([requireRuntimeExecutable("bun"), script("dispatch_prepare.ts"), "--rebind-authority",
      "--project", input.projectRoot, "--pm-id", input.pmId, "--id", input.dispatchId ?? "<dispatch id>",
      "--evidence", "<gate verdict path>"])
    : (() => {
      try {
        const execution = input.branchRef
          ? roleExecutionIdentityForBranch(input.branchRef)
          : dispatchExecutionIdentity(input.dispatchId ?? "");
        const authorization = readCurrentRoleAuthorization({
          project_root: input.projectRoot, pm_id: input.pmId, identity: execution,
        });
        const core = authorization.core;
        const acceptanceIds = resolveCanonicalRoleAcceptanceIds(
          resolve(input.projectRoot, core.sources.assignment.path),
          core.sources.blueprint ? resolve(input.projectRoot, core.sources.blueprint.path) : null,
        );
        return shellCommandLine([
          requireRuntimeExecutable("bun"), script("dispatch_prepare.ts"), "--recover-role",
          "--project", input.projectRoot, "--pm-id", input.pmId, ...identity,
          "--work-id", core.item.work_id, "--control-session", core.item.session_id,
          "--recovery-reason", "provider_replacement",
          "--expected-previous-digest", authorization.core_digest,
          "--item-authority", core.item.authority.path,
          "--assignment-path", core.sources.assignment.path,
          ...(core.sources.blueprint ? ["--blueprint", core.sources.blueprint.path] : []),
          "--prompt-path", core.sources.prompt.path,
          "--initial-instructions-path", core.instruction_ledger?.path ?? "<initial instructions path>",
          "--base", core.integration.ref,
          ...acceptanceIds.flatMap((id) => ["--acceptance-id", id]),
        ]);
      } catch {
        return shellCommandLine([requireRuntimeExecutable("bun"), script("dispatch_prepare.ts"), "--recover-role",
          "--project", input.projectRoot, "--pm-id", input.pmId, ...identity]);
      }
    })();
  return { detail, nextCommand };
}

function shellCommandLine(argv: readonly string[]): string {
  return argv.map((value) => shellQuote(value)).join(" ");
}

function posixScript(path: string): string { return path.replace(/\\/g, "/"); }

function fallback(reason: string, action: SessionFallback["action"], detail = "", nextCommand = "", retryAfterS?: number): SessionFallback {
  return {
    required: true, reason, action,
    ...(detail ? { detail } : {}), ...(nextCommand ? { next_command: nextCommand } : {}),
    ...(retryAfterS === undefined ? {} : { retry_after_s: retryAfterS }),
  };
}

function emitOutcome(outcome: ResumeOutcome): void {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

function writeFailedResumeResult(resultFile: string): void {
  atomicWrite(resultFile, FAILED_RESUME_RESULT);
}

function writeResumeFailure(resultFile: string, outcome: ResumeOutcome): void {
  const failureFile = resolve(`${resultFile}.resume-error.json`);
  outcome.failure_file = failureFile;
  atomicWrite(failureFile, `${JSON.stringify(outcome, null, 2)}\n`);
}

const TRANSIENT_PROVIDER_CODES = new Set(["server_overloaded", "rate_limit", "rate_limit_exceeded", "usage_limit_reached"]);
const CODEX_ROLLOUT_TAIL_MAX_BYTES = 256 * 1024;

function boundedFileTail(path: string, maximumBytes: number): string {
  const descriptor = openSync(path, "r");
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) return "";
    const length = Math.min(info.size, maximumBytes);
    const bytes = Buffer.alloc(length);
    const start = Math.max(0, info.size - length);
    let consumed = 0;
    while (consumed < length) {
      const count = readSync(descriptor, bytes, consumed, length - consumed, start + consumed);
      if (count === 0) break;
      consumed += count;
    }
    return bytes.subarray(0, consumed).toString("utf8");
  } finally { closeSync(descriptor); }
}

/** Resolve only the recorded Codex session's rollout and inspect a bounded
 * tail. Capacity failures are emitted there even when the CLI stderr stream is
 * generic, so stdout/stderr alone cannot classify a real Codex resume. */
function codexRolloutTail(
  record: ProviderSessionRecord,
  env: Record<string, string | undefined>,
): string {
  if (record.provider !== "codex-cli") return "";
  const sessionId = explicitSessionId(record.session_id);
  const createdAt = new Date(record.timestamps.created_at);
  if (!sessionId || Number.isNaN(createdAt.getTime())) return "";
  const codexHome = resolve(env.CODEX_HOME ?? (env.HOME ? resolve(env.HOME, ".codex") : resolve(homedir(), ".codex")));
  const sessions = resolve(codexHome, "sessions");
  try {
    const info = lstatSync(sessions);
    if (info.isSymbolicLink() || !info.isDirectory()) return "";
    // Codex partitions rollouts by the local calendar while the session record
    // carries an ISO/UTC timestamp. Search only the three neighbouring dates
    // in both calendars, then bind the one result by its unique session id.
    const days = new Map<string, string[]>();
    for (const offset of [-1, 0, 1]) {
      const date = new Date(createdAt.getTime() + offset * 86_400_000);
      for (const parts of [
        [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()],
        [date.getFullYear(), date.getMonth() + 1, date.getDate()],
      ]) {
        const day = parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"));
        days.set(day.join("/"), day);
      }
    }
    const candidates: string[] = [];
    for (const parts of days.values()) {
      let directory = sessions;
      let valid = true;
      for (const part of parts) {
        directory = resolve(directory, part);
        try {
          const partInfo = lstatSync(directory);
          if (partInfo.isSymbolicLink() || !partInfo.isDirectory()) valid = false;
        } catch { valid = false; }
        if (!valid) break;
      }
      if (!valid) continue;
      candidates.push(...readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith("rollout-")
          && entry.name.endsWith(`-${sessionId}.jsonl`))
        .map((entry) => resolve(directory, entry.name)));
    }
    if (candidates.length !== 1) return "";
    return boundedFileTail(candidates[0]!, CODEX_ROLLOUT_TAIL_MAX_BYTES);
  } catch { return ""; }
}

function providerTransientCode(
  record: ProviderSessionRecord,
  stdout: string,
  stderr: string,
  env: Record<string, string | undefined>,
): string | null {
  const inspect = (value: unknown): string | null => {
    if (typeof value === "string") return TRANSIENT_PROVIDER_CODES.has(value) ? value : null;
    if (!value || typeof value !== "object") return null;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "codex_error_info" || key === "type" || key === "code")
        && typeof child === "string" && TRANSIENT_PROVIDER_CODES.has(child)) return child;
      const nested = inspect(child);
      if (nested) return nested;
    }
    return null;
  };
  // The rollout is authoritative for Codex failures. Captured streams remain
  // secondary sources for Claude and for providers that duplicate the code.
  for (const line of `${codexRolloutTail(record, env)}\n${stdout}\n${stderr}`.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const code = inspect(JSON.parse(trimmed));
      if (code) return code;
    } catch { /* non-JSON diagnostics are checked by the closed token pattern below */ }
    const token = /(?:codex_error_info|error(?:_code)?|type)["'\s:=]+(server_overloaded|rate_limit(?:_exceeded)?|usage_limit_reached)\b/i.exec(trimmed)?.[1]?.toLowerCase();
    if (token && TRANSIENT_PROVIDER_CODES.has(token)) return token;
  }
  return null;
}

function persistProviderStderr(
  resultFile: string,
  stderr: string,
  options: ResumeOptions,
): Pick<ResumeOutcome, "provider_stderr_file" | "provider_stderr_tail"> {
  const path = resolve(`${resultFile}.provider-stderr.log`);
  atomicWrite(path, stderr);
  const tail = stderr.split(/\r?\n/).slice(-40);
  if (!options.binding) {
    return {
      provider_stderr_file: path,
      provider_stderr_tail: tail.map((line) => line ? "[redacted: policy]" : line),
    };
  }
  try {
    const sources = tail.map((line, index) => ({
      kind: "container_artifact" as const,
      sourcePath: `provider-stderr-tail/${String(index + 1).padStart(3, "0")}.txt`,
      bytes: Buffer.from(line, "utf8"),
    }));
    const admission = evaluatePreservationAdmission({
      projectRoot: options.binding.projectRoot,
      pmId: options.binding.pmId,
      binding: {
        requestId: `provider-resume-${options.binding.dispatchId ?? options.binding.role}`,
        planDigest: `sha256:${createHash("sha256").update(Buffer.from(tail.join("\n"), "utf8")).digest("hex")}`,
        workId: null,
        dispatchId: options.binding.dispatchId ?? null,
      },
      sources,
    });
    const artifacts = new Map(admission.artifacts.map((artifact) => [artifact.source_path, artifact]));
    return {
      provider_stderr_file: path,
      provider_stderr_tail: tail.map((line, index) => {
        const artifact = artifacts.get(`provider-stderr-tail/${String(index + 1).padStart(3, "0")}.txt`);
        if (!artifact || artifact.decision === "CLEAN") return line;
        const classes = [...new Set(artifact.findings.map((finding) => finding.dimension))].sort();
        return `[redacted: ${classes.join(",") || "policy"}]`;
      }),
    };
  } catch {
    // A scanner/policy fault cannot turn provider bytes into durable output.
    return {
      provider_stderr_file: path,
      provider_stderr_tail: tail.map((line) => line ? "[redacted: policy]" : line),
    };
  }
}

export interface ResumeOptions {
  recordFile: string;
  instructionFile: string;
  resultFile: string;
  worktree?: string;
  lockDir?: string;
  env?: Record<string, string | undefined>;
  /** Test-only override of the capture-time PROXY-lane clauses. Production
   * derives it from the container's `context.json` commit mode (W-688). */
  proxyLane?: boolean;
  expectedRouting: ProviderRoute;
  binding?: {
    projectRoot: string;
    pmId: string;
    dispatchId?: string;
    branchRef?: string;
    role: string;
    slug: string;
    generation: number;
    digest: string;
    blueprintUpdateCommit?: string;
  };
}

export function codexResumeProviderArgs(
  record: ProviderSessionRecord,
): string[] {
  if (record.resumable === false) throw new Error("one-shot role-seat session cannot be resumed");
  const sessionId = explicitSessionId(record.session_id);
  if (!sessionId) throw new Error("explicit session id is required for Codex resume");
  const args = ["exec"];
  for (const root of codexProviderWritableRoots({
    worktree: record.worktree,
    container: record.container,
    resultFile: record.result_file,
    operatorAddDirs: record.operator_add_dirs,
  })) args.push("--add-dir", root);
  args.push(
    "resume", sessionId,
    ...(record.routing?.model ? ["--model", record.routing.model] : []),
    ...(record.routing?.effort ? ["-c", `model_reasoning_effort=\"${record.routing.effort}\"`] : []),
    "-",
  );
  return args;
}

export function providerChildEnv(
  provider: SessionProvider,
  bash: string,
  base: Record<string, string | undefined>,
  overlay: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const merged = { ...base, ...overlay };
  // W-249: value-only credential-URL scrub (a stray proxy/registry-style value
  // carrying embedded userinfo creds has no reason to reach this child). The
  // NAME-based secret drop stays OFF (dropSecretNames: false) — this child IS
  // the codex/claude CLI, which legitimately needs its own `*_API_KEY`/`*_TOKEN`
  // env to authenticate; dropping those by name would break the launch, not
  // secure it. No MINIMAL_ENV_KEYS allowlist either, for the same reason
  // childEnvWithBun() in dispatch_provider.ts skips it: this module
  // cannot enumerate every var a provider CLI needs.
  // W-308: roleProviderEnv additionally marks the role seat and sets
  // both rustc-wrapper overrides to the documented empty bypass. Provider
  // authentication inputs remain available to the provider CLI itself.
  // W-249 (Guardian N3): honest residual — with dropSecretNames off, a
  // HOST-set secret-named var (e.g. an unrelated *_TOKEN the operator's shell
  // exports) is NOT name-dropped here and reaches this child and, transitively,
  // whatever it spawns. Accepted because the child is the codex/claude CLI
  // itself, a trusted boundary in this model — not a scope this function polices.
  const env: Record<string, string | undefined> = roleProviderEnv(merged);
  if (provider === "claude-code" && process.platform === "win32") env.CLAUDE_CODE_GIT_BASH_PATH = bash;
  // Timeout variables are deliberately neither added nor rewritten. Their
  // effective values are read-only context owned by the host/user.
  return env;
}

export function resumeExplicitSession(options: ResumeOptions): ResumeOutcome {
  const recordFile = resolve(options.recordFile);
  const resultFile = resolve(options.resultFile);
  const base: Pick<ResumeOutcome, "record_file" | "result_file"> = { record_file: recordFile, result_file: resultFile };
  let record: ProviderSessionRecord;
  try {
    if (!existsSync(recordFile)) throw new Error("session record does not exist");
    record = readRecord(recordFile);
  } catch (error) {
    const outcome: ResumeOutcome = { ...base, ok: false, status: "missing", fallback: fallback("session_record_missing_or_invalid", "fresh_dispatch_required", boundedFailureDetail(error, "session_record_read")) };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }

  const common = { ...base, provider: record.provider, session_id: record.session_id };
  if (record.resumable === false) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("one_shot_role_seat", "fresh_dispatch_required") };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }
  try {
    const expected = strictRoute(options.expectedRouting, "expected");
    const recorded = strictRoute(record.routing, "record");
    if (!sameRoute(expected, recorded)) throw new Error("recorded route does not match PM/Dock expected route");
  } catch (error) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("routing_authority_mismatch", "retry_explicit_resume", boundedFailureDetail(error, "routing_validation")) };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }
  if (options.binding && record.ownership_id !== `launch-${options.binding.digest}`) {
    // W-687 AC-2: name the RECORD. This refusal carried no detail at all, so a
    // resume pointed at a pre-recovery `session.json` while the live record was
    // `recovery.session.json` looked identical to a genuine ownership problem —
    // the third of three consecutive failures on a downstream project's
    // dispatch #538, and the one that sent the operator into the binding tree
    // by hand.
    const outcome: ResumeOutcome = {
      ...common,
      ok: false,
      status: "invalid",
      fallback: fallback(
        "session_lock_ownership_unverifiable",
        "retry_explicit_resume",
        `record ownership ${record.ownership_id} does not belong to generation ${options.binding.generation}`
          + ` (expected launch-${options.binding.digest}); record: ${recordFile.replace(/\\/g, "/")}`,
        `# resume the record this generation owns; ready.json's resume_cmd carries it after --recover-role rebinds it (W-687)`,
      ),
    };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }
  const sessionId = explicitSessionId(record.session_id);
  if (!sessionId) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("explicit_session_id_missing_or_forbidden", "reconcile_provider_session") };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }
  const replaceExpiredSession = record.status === "expired";
  if (record.status === "running" || record.status === "resuming") {
    // The status file is not process authority. A force-killed launcher can
    // leave `running`/`resuming` behind while its lock owner is dead. Probe the
    // existing session lock before refusing; acquireSessionLock reclaims only a
    // lock whose exact recorded PID is no longer live. The probe itself is
    // released immediately, then this same invocation proceeds with the same
    // binding generation (W-600 AC-4f).
    let deadOwnerProbe: SessionLockAcquisition;
    try { deadOwnerProbe = acquireSessionLock(recordFile, record, options.lockDir); }
    catch (error) {
      const outcome: ResumeOutcome = {
        ...common, ok: false, status: record.status,
        fallback: fallback("session_lock_failed", "retry_explicit_resume", boundedFailureDetail(error, "session_lock_acquire")),
      };
      writeResumeFailure(resultFile, outcome);
      return outcome;
    }
    if (deadOwnerProbe.kind !== "reclaimed_confirmed_dead") {
      if (deadOwnerProbe.kind === "acquired_fresh") releaseSessionLock(deadOwnerProbe.lock);
      const reason = deadOwnerProbe.kind === "busy"
        ? "session_invocation_in_progress"
        : "session_lock_ownership_unverifiable";
      const outcome: ResumeOutcome = { ...common, ok: false, status: record.status, fallback: fallback(reason, "retry_explicit_resume") };
      writeResumeFailure(resultFile, outcome);
      return outcome;
    }
    releaseSessionLock(deadOwnerProbe.lock);
    record = updateSessionRecord(record, {
      status: "failed",
      failure: makeProviderFailure({
        class: "launcher_control", code: "stale_owner_recovered", attempt: 1, retry_authorized: false,
      }),
    });
    writeSessionRecord(recordFile, record);
  }

  let canonicalWorktree = "";
  try {
    canonicalWorktree = validateRecordWorktree(record, options.worktree || record.worktree);
  } catch (error) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("worktree_identity_mismatch", "retry_explicit_resume", boundedFailureDetail(error, "worktree_identity")) };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }

  if (!options.binding) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("role_binding_missing", "fresh_dispatch_required") };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }
  const roleIdentity = options.binding.branchRef
    ? roleExecutionIdentityForBranch(options.binding.branchRef)
    : dispatchExecutionIdentity(options.binding.dispatchId ?? "");
  const transport = record.provider === "codex-cli" ? "codex-cli" : "claude-subprocess";
  let validatedRole: ReturnType<typeof validateRoleBinding>;
  try {
    if (options.binding.branchRef) assertRoleBranchIdentity(roleIdentity, gitOutput(canonicalWorktree, ["branch", "--show-current"]));
    validatedRole = validateRoleBinding({
      project_root: options.binding.projectRoot, pm_id: options.binding.pmId, identity: roleIdentity,
      stage: "resume", generation: options.binding.generation, expected_digest: options.binding.digest,
      provider_session_id: sessionId, expected_transport: transport,
      blueprint_update_commit: options.binding.blueprintUpdateCommit,
    });
    if (validatedRole.authorization.core.role !== options.binding.role) {
      throw new Error("resume role does not match the canonical role binding");
    }
  } catch (error) {
    if (error instanceof RoleResumePreflightError) {
      const workId = readCurrentRoleAuthorization({
        project_root: options.binding.projectRoot, pm_id: options.binding.pmId, identity: roleIdentity,
      }).core.item.work_id;
      const nextCommand = [
        "garelier", "pm", "next", "--work", workId,
        "--project", options.binding.projectRoot, "--pm-id", options.binding.pmId,
      ].map((part) => shellQuote(part)).join(" ");
      const outcome: ResumeOutcome = {
        ...common, ok: false, status: "ready",
        fallback: fallback("resume_preflight_rejected", "retry_explicit_resume", error.message, nextCommand),
      };
      writeResumeFailure(resultFile, outcome);
      return outcome;
    }
    // W-441 / W-687: `fresh_dispatch_required` was wrong as well as unhelpful.
    // Every failure that reaches here is a bound source that moved or a
    // generation that advanced, and each of those is repaired in place — a
    // fresh dispatch throws away a live worktree to fix a pointer. The action
    // is `retry_explicit_resume` and the record carries the command that makes
    // the retry succeed.
    const recovery = resumeDriftRecovery({
      error,
      projectRoot: options.binding.projectRoot,
      pmId: options.binding.pmId,
      ...(options.binding.dispatchId ? { dispatchId: options.binding.dispatchId } : {}),
      ...(options.binding.branchRef ? { branchRef: options.binding.branchRef } : {}),
    });
    const outcome: ResumeOutcome = {
      ...common, ok: false, status: "invalid",
      fallback: fallback("role_binding_invalid", "retry_explicit_resume", recovery.detail, recovery.nextCommand),
    };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }

  // Only a typed transient provider failure authorizes re-delivery on the
  // same provider session. A terminal provider_resume_failed record still
  // requires the established recovery/rebind path; otherwise merely invoking
  // resume again would silently turn `fresh_dispatch_required` into an
  // unbounded retry while reusing its pending ledger entry.
  if (validatedRole.pending_instruction && record.failure?.code === "provider_resume_failed") {
    const recovery = resumeDriftRecovery({
      error: new Error("previous non-transient provider resume failed"),
      projectRoot: options.binding.projectRoot,
      pmId: options.binding.pmId,
      ...(options.binding.dispatchId ? { dispatchId: options.binding.dispatchId } : {}),
      ...(options.binding.branchRef ? { branchRef: options.binding.branchRef } : {}),
    });
    const outcome: ResumeOutcome = {
      ...common, ok: false, status: "invalid",
      fallback: fallback("role_binding_invalid", "retry_explicit_resume", recovery.detail, recovery.nextCommand),
    };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }

  let laneEnv: Record<string, string>;
  let resumeContainer = "";
  try {
    const projectRoot = canonicalExistingDirectory(options.binding.projectRoot, "project root");
    const branch = gitOutput(canonicalWorktree, ["branch", "--show-current"]);
    const dispatchId = options.binding.dispatchId ?? dispatchIdForRoleCheckout(branch, canonicalWorktree);
    if (!dispatchId) throw new Error("resume dispatch context has no canonical dispatch id");
    // The signed role binding, not an optional provider-record convenience
    // field or the caller's worktree spelling, owns the dispatch container.
    // This is also where the authoritative instruction ledger lives.
    resumeContainer = options.binding.dispatchId
      ? canonicalExistingDirectory(
        dispatchContainer(projectRoot, options.binding.pmId, dispatchId),
        "resume dispatch container",
      )
      : record.container ?? dirname(canonicalWorktree);
    laneEnv = resolveLaneEnv(loadLaneEnv(projectRoot, options.binding.pmId), {
      checkout: canonicalWorktree,
      project: projectRoot,
      container: resumeContainer,
      dispatchId,
      role: options.binding.role,
      slug: options.binding.slug,
    }, "producer").values;
  } catch (error) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("dispatch_env_invalid", "fresh_dispatch_required", boundedFailureDetail(error, "dispatch_env")) };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }

  let instructionText = "";
  try { instructionText = readFileSync(options.instructionFile, "utf8"); } catch { /* handled below */ }
  if (!instructionText.trim()) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("instruction_file_missing_or_empty", "retry_explicit_resume") };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }
  // The signed instruction allocator canonicalizes outer whitespace with
  // `requireText`; retry comparison must use that exact same spelling for both
  // providers or a newline-terminated Claude message cannot be re-delivered.
  const instruction = instructionText.trim();

  let lockAcquisition: SessionLockAcquisition;
  try { lockAcquisition = acquireSessionLock(recordFile, record, options.lockDir); }
  catch (error) {
    const sessionFallback = fallback("session_lock_failed", "retry_explicit_resume", boundedFailureDetail(error, "session_lock_acquire"));
    const outcome: ResumeOutcome = { ...common, ok: false, status: "failed", fallback: sessionFallback };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }
  if (lockAcquisition.kind === "busy" || lockAcquisition.kind === "unverifiable") {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "busy", fallback: fallback("session_locked_by_live_or_unverifiable_process", "retry_explicit_resume") };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  }
  const lock = lockAcquisition.lock;
  let providerResultCaptured = false;
  const priorProviderTransientAttempt = record.failure?.class === "provider_exit"
    && record.failure.code === "provider_transient"
    ? record.failure.attempt
    : 0;

  try {
    try {
      if (validatedRole.pending_instruction
        && validatedRole.pending_instruction.message !== instruction) {
        throw new RoleResumePreflightError(
          `resume must re-deliver pending ${validatedRole.pending_instruction.ledger_token} before appending another instruction`,
        );
      }
      if (!validatedRole.pending_instruction) {
      preflightRoleInstructionLedgerEntry({
        project_root: options.binding.projectRoot, pm_id: options.binding.pmId, identity: roleIdentity,
        generation: options.binding.generation, expect_digest: options.binding.digest,
        message: instruction, blueprint_update_commit: options.binding.blueprintUpdateCommit,
      });
      }
    } catch (error) {
      if (!(error instanceof RoleResumePreflightError)) throw error;
      const current = readCurrentRoleAuthorization({
        project_root: options.binding.projectRoot, pm_id: options.binding.pmId, identity: roleIdentity,
      });
      if (current.core.generation !== options.binding.generation || current.core_digest !== options.binding.digest) {
        throw new Error("role binding changed during resume ledger pre-flight");
      }
      const nextCommand = [
        "garelier", "pm", "next", "--work", validatedRole.authorization.core.item.work_id,
        "--project", options.binding.projectRoot, "--pm-id", options.binding.pmId,
      ].map((part) => shellQuote(part)).join(" ");
      const outcome: ResumeOutcome = {
        ...common, ok: false, status: "ready",
        fallback: fallback("resume_preflight_rejected", "retry_explicit_resume", error.message, nextCommand),
      };
      writeResumeFailure(resultFile, outcome);
      return outcome;
    }
    record = updateSessionRecord(record, { status: "resuming", result_file: resultFile }, true);
    writeSessionRecord(recordFile, record);
    const canonicalInstruction = validatedRole.pending_instruction ?? appendRoleInstruction({
        project_root: options.binding.projectRoot, pm_id: options.binding.pmId, identity: roleIdentity,
        generation: options.binding.generation, expect_digest: options.binding.digest,
        message: instruction, blueprint_update_commit: options.binding.blueprintUpdateCommit,
        issuer: { role: "coordinator", id: "provider_session" },
      });
    if (!validatedRole.pending_instruction) {
      materializeRoleInstructionLedgerEntry({
        project_root: options.binding.projectRoot, pm_id: options.binding.pmId, identity: roleIdentity,
        generation: options.binding.generation, expect_digest: options.binding.digest,
        instruction: canonicalInstruction,
      });
    }
    const capturedAtContainerRoot = resolve(resultFile).toLowerCase()
      === resolve(resumeContainer, "report.md").toLowerCase();
    const producerRegister = capturedAtContainerRoot
      ? resolve(resumeContainer, "lane", "register.md")
      : resolve(resultFile);
    const producerRegisterRelative = relative(options.binding.projectRoot, producerRegister).replace(/\\/g, "/");
    const currentLedger = readFileSync(resolve(resumeContainer, "instructions.md"), "utf8");
    const registerShape = dispatchRegisterLaneShape(
      record.provider === "codex-cli" ? "codex" : "claude-code",
      readDispatchRegisterCommitMode(resumeContainer),
    );
    const resumePointer = roleInstructionResumePointer(
      canonicalInstruction,
      renderFullRegisterTemplate(
        currentLedger,
        producerRegisterRelative,
        registerShape,
      ),
    );
    // W-756: resolve the executables from the SAME environment the child is
    // spawned with. `options.env` is an OVERLAY (the caller pins
    // GARELIER_CODEX / GARELIER_CLAUDE / lane vars); the child has always run
    // with `{ ...process.env, ...options.env }` (providerChildEnv below), but
    // resolution used the overlay alone. An overlay without PATH therefore
    // resolved nothing — invisible on Windows only because
    // resolveBashExecutable falls back to hard-coded Git-for-Windows install
    // roots that need no PATH, while the POSIX branch has PATH and nothing
    // else (_lib.ts standardRuntimeCandidates returns nothing off win32). The
    // Linux symptom was `Git Bash not found` surfacing as the generic
    // resume_launcher_failed / error_class=Error fallback. Merging here makes
    // the two environments one object, so the contract no longer depends on
    // which platform can guess an install path.
    const providerEnv: Record<string, string | undefined> = { ...process.env, ...(options.env ?? {}) };
    const bash = resolveBashExecutable({ env: providerEnv });
    if (!bash) throw new Error("Git Bash not found");
    const commandName = record.provider === "codex-cli" ? "codex" : "claude";
    const provider = resolveRuntimeExecutable(commandName, { env: providerEnv });
    if (!provider) throw new Error(`${commandName} CLI not found`);
    const invoke = (fresh: boolean): {
      exitCode: number; stdout: string; stderr: string; sessionId: string; result: string;
    } => {
      const writableRoots = record.provider === "codex-cli"
        ? codexProviderWritableRoots({
          worktree: record.worktree, container: record.container, resultFile,
          operatorAddDirs: record.operator_add_dirs,
        })
        : [];
      const replacementSessionId = fresh && record.provider === "claude-code" ? randomUUID() : "";
        const providerArgs = !fresh
          ? record.provider === "codex-cli"
            ? codexResumeProviderArgs(record)
            : ["-p", CLAUDE_RESUME_QUERY, "--resume", sessionId, "--output-format", "json",
              "--model", record.routing!.model, "--effort", record.routing!.effort]
          : record.provider === "codex-cli"
            ? [
              "exec", "--cd", canonicalWorktree.replace(/\\/g, "/"), "--sandbox", "workspace-write",
              "-c", "approval_policy=never", "--json",
              ...writableRoots.flatMap((root) => ["--add-dir", root]),
              ...(record.routing?.model ? ["--model", record.routing.model] : []),
              ...(record.routing?.effort ? ["-c", `model_reasoning_effort=\"${record.routing.effort}\"`] : []),
              "-",
            ]
            : ["-p", FRESH_INSTRUCTION_QUERY, "--session-id", replacementSessionId, "--output-format", "json",
              "--model", record.routing!.model, "--effort", record.routing!.effort];
        const command = [bash, "-c", 'exec "$1" "${@:2}"', `garelier-${commandName}`, provider, ...providerArgs];
        const child = Bun.spawnSync(command, {
          windowsHide: true,
          cwd: canonicalWorktree,
          env: injectLaneEnv(
            providerChildEnv(record.provider, bash, providerEnv),
            laneEnv,
            roleProviderCoreEnv(),
          ),
          stdin: Buffer.from(resumePointer),
          stdout: "pipe", stderr: "pipe",
        });
        const stdout = child.stdout?.toString() ?? "";
        const stderr = child.stderr?.toString() ?? "";
        const codexTurn = fresh && record.provider === "codex-cli" ? parseCodexJsonlTurn(stdout) : null;
        const freshSessionId = fresh
          ? record.provider === "codex-cli"
            ? codexTurn?.sessionId ?? ""
            : parseClaudeSessionId(stdout)
          : sessionId;
        const result = fresh
          ? record.provider === "codex-cli"
            ? codexTurn?.valid ? codexTurn.result : ""
            : parseClaudeResult(stdout) ?? ""
          : stdout;
      return { exitCode: child.exitCode ?? 1, stdout, stderr, sessionId: freshSessionId, result };
    };

    const turn = invoke(replaceExpiredSession);
    if (turn.exitCode !== 0 || (replaceExpiredSession && (!turn.sessionId || !turn.result))) {
      const stdout = turn.stdout;
      const stderr = turn.stderr;
      const safeDetail = `exit_code=${boundedExitCode(turn.exitCode)} stdout_bytes=${byteCount(stdout)} stderr_bytes=${byteCount(stderr)}`;
      const transientCode = providerTransientCode(record, stdout, stderr, providerEnv);
      const stderrEvidence = persistProviderStderr(resultFile, stderr, options);
      const transientAttempt = transientCode
        ? Math.min(priorProviderTransientAttempt + 1, 4)
        : 1;
      const transientRetryAuthorized = transientCode !== null && transientAttempt <= 3;
      const sessionFallback = transientCode
        ? transientRetryAuthorized
          ? fallback("provider_transient", "retry_same_resume", `${safeDetail} provider_code=${transientCode} attempt=${transientAttempt}/3`, "", 30)
          : fallback("provider_transient_retry_exhausted", "change_routing_tier", `${safeDetail} provider_code=${transientCode} attempts=3`)
        : fallback("provider_resume_failed", "fresh_dispatch_required", safeDetail);
      record = updateSessionRecord(record, {
        status: transientRetryAuthorized ? "ready" : "failed",
        fallback: sessionFallback,
        failure: makeProviderFailure({
          class: "provider_exit", code: transientCode ? "provider_transient" : "provider_resume_failed",
          attempt: transientAttempt, retry_authorized: transientRetryAuthorized,
          exit_code: Math.max(0, turn.exitCode), stdout_bytes: byteCount(stdout), stderr_bytes: byteCount(stderr),
        }),
      });
      writeSessionRecord(recordFile, record);
      const outcome: ResumeOutcome = {
        ...common, ...stderrEvidence, ok: false, status: record.status,
        fallback: sessionFallback, exit_code: turn.exitCode,
      };
      writeResumeFailure(resultFile, outcome);
      return outcome;
    }
    if (!replaceExpiredSession && record.provider === "claude-code" && parseClaudeSessionId(turn.stdout) !== sessionId) {
      const sessionFallback = fallback("provider_session_id_mismatch", "fresh_dispatch_required", `stdout_bytes=${byteCount(turn.stdout)} stderr_bytes=${byteCount(turn.stderr)}`);
      record = updateSessionRecord(record, { status: "failed", fallback: sessionFallback });
      writeSessionRecord(recordFile, record);
      const outcome: ResumeOutcome = { ...common, ok: false, status: "failed", fallback: sessionFallback, exit_code: 0 };
      writeResumeFailure(resultFile, outcome);
      return outcome;
    }
    let result = turn.result;
    if (!replaceExpiredSession && record.provider === "claude-code") {
      const parsedResult = parseClaudeResult(turn.stdout);
      if (parsedResult === null) {
        const sessionFallback = fallback("provider_result_invalid", "fresh_dispatch_required", `stdout_bytes=${byteCount(turn.stdout)} stderr_bytes=${byteCount(turn.stderr)}`);
        record = updateSessionRecord(record, { status: "failed", fallback: sessionFallback });
        writeSessionRecord(recordFile, record);
        const outcome: ResumeOutcome = { ...common, ok: false, status: "failed", fallback: sessionFallback, exit_code: 0 };
        writeResumeFailure(resultFile, outcome);
        return outcome;
      }
      result = parsedResult;
    }
    // W-802: provider completion is durable before any post-turn authority or
    // register check. A PM may legitimately move a bound blueprint while this
    // turn runs; that makes the acknowledgement a retry signal, not permission
    // to erase a completed implementation/register.
    atomicWrite(resultFile, result);
    providerResultCaptured = true;
    const staleProviderStderr = resolve(`${resultFile}.provider-stderr.log`);
    if (existsSync(staleProviderStderr)) unlinkSync(staleProviderStderr);
    try {
      acknowledgeInstructionDelivery({
        project_root: options.binding.projectRoot, pm_id: options.binding.pmId, identity: roleIdentity,
        generation: options.binding.generation, expect_digest: options.binding.digest,
        sequence: canonicalInstruction.sequence, provider_session_id: turn.sessionId,
        ...(replaceExpiredSession ? { previous_provider_session_id: sessionId } : {}),
        evidence: replaceExpiredSession
          ? "expired session replaced inside the existing container + captured result"
          : "exact-session resume exit 0 + captured result",
        writer: { role: "launcher", id: "provider_session" },
      });
    } catch (error) {
      const diagnostic = boundedDiagnostic(error);
      if (error instanceof RoleBoundSourceDriftError) {
        const recovery = resumeDriftRecovery({
          error, projectRoot: options.binding.projectRoot, pmId: options.binding.pmId,
          dispatchId: options.binding.dispatchId, branchRef: options.binding.branchRef,
        });
        const sessionFallback = fallback(
          "bound_source_drift_during_turn",
          "retry_explicit_resume",
          `stage=instruction_ack ${recovery.detail}`,
          recovery.nextCommand,
        );
        record = updateSessionRecord(record, {
          session_id: turn.sessionId, status: "ready", result_file: resultFile, fallback: sessionFallback,
        });
        writeSessionRecord(recordFile, record);
        const outcome: ResumeOutcome = {
          ...common, session_id: turn.sessionId, ok: false, status: "ready",
          fallback: sessionFallback, exit_code: 0,
        };
        writeResumeFailure(resultFile, outcome);
        return outcome;
      }
      throw new Error(boundedFailureDetail(error, "instruction_ack"));
    }
    record = updateSessionRecord(record, { session_id: turn.sessionId, status: "ready", result_file: resultFile });
    writeSessionRecord(recordFile, record);

    // W-688: the register contract is checked HERE, against the bytes just
    // written and the ledger file as it stands. The result file is left in
    // place and the worktree is untouched, so the producer's implementation
    // survives and the repair is one more resume — `retry_explicit_resume`,
    // never `fresh_dispatch_required`.
    const sessionFallback = capturedRegisterFallback({
      container: resumeContainer, resultFile, role: options.binding.role,
      proxyLane: options.proxyLane ?? registerShape.proxyLane,
    });
    if (sessionFallback) {
      record = updateSessionRecord(record, { status: "ready", fallback: sessionFallback });
      writeSessionRecord(recordFile, record);
      const outcome: ResumeOutcome = {
        ...common, session_id: turn.sessionId, ok: false, status: "ready",
        fallback: sessionFallback, exit_code: 0,
      };
      writeResumeFailure(resultFile, outcome);
      return outcome;
    }
    return { ...common, session_id: turn.sessionId, ok: true, status: "ready", exit_code: 0 };
  } catch (error) {
    const sessionFallback = fallback(
      "resume_launcher_failed", providerResultCaptured ? "retry_explicit_resume" : "fresh_dispatch_required",
      boundedFailureDetail(error, "resume_launcher"),
    );
    record = updateSessionRecord(record, {
      status: providerResultCaptured ? "ready" : "failed",
      fallback: sessionFallback,
      failure: makeProviderFailure({
        class: "launcher_control", code: "launcher_internal", attempt: 1, retry_authorized: false,
      }),
    });
    writeSessionRecord(recordFile, record);
    const outcome: ResumeOutcome = {
      ...common, ok: false, status: providerResultCaptured ? "ready" : "failed", fallback: sessionFallback,
    };
    writeResumeFailure(resultFile, outcome);
    return outcome;
  } finally {
    releaseSessionLock(lock);
  }
}

function captureSession(argv: string[]): number {
  let provider = "", worktree = "", recordFile = "", inputFile = "", resultFile = "", model = "", effort = "", source = "";
  for (let i = 0; i < argv.length;) {
    const value = argv[i + 1] ?? "";
    switch (argv[i]) {
      case "--provider": provider = value; i += 2; break;
      case "--worktree": worktree = value; i += 2; break;
      case "--record": recordFile = value; i += 2; break;
      case "--input": inputFile = value; i += 2; break;
      case "--result": resultFile = value; i += 2; break;
      case "--model": model = value; i += 2; break;
      case "--effort": effort = value; i += 2; break;
      case "--model-source": source = value; i += 2; break;
      default: throw new Error(`unknown capture arg: ${argv[i]}`);
    }
  }
  if (provider !== "codex-cli" && provider !== "claude-code") throw new Error("--provider must be codex-cli or claude-code");
  if (!worktree || !recordFile || !inputFile) throw new Error("capture requires --worktree, --record, and --input");
  const input = readFileSync(inputFile, "utf8");
  const sessionId = provider === "codex-cli"
    ? input.split(/\r?\n/).map(parseCodexSessionId).find(Boolean) ?? ""
    : parseClaudeSessionId(input);
  const claudeResult = provider === "claude-code" && sessionId ? parseClaudeResult(input) : null;
  let captureFallback = !sessionId
    ? fallback("session_id_not_captured", "reconcile_provider_session")
    : provider === "claude-code" && claudeResult === null
      ? fallback("provider_result_invalid", "retry_explicit_resume")
      : undefined;
  const transportReady = Boolean(sessionId) && !captureFallback;
  const routing = strictRoute({ model, effort, source }, "capture");
  let record = makeSessionRecord(
    provider, sessionId, worktree, transportReady ? "ready" : "failed", resultFile, captureFallback, routing, [],
    sessionId ? {} : { ownershipId: `capture-${randomUUID()}` },
  );
  if (existsSync(recordFile)) {
    const previous = readRecord(recordFile);
    validateRecordWorktree(previous, worktree);
    if (previous.provider !== provider || previous.session_id !== sessionId
      || !sameRoute(strictRoute(previous.routing, "record"), routing)) {
      throw new Error("capture does not match the existing provider session and routing");
    }
    record = updateSessionRecord(previous, {
      status: transportReady ? "ready" : "failed", result_file: resultFile, fallback: captureFallback,
    });
  }
  writeSessionRecord(recordFile, record);
  if (provider === "claude-code" && resultFile && sessionId) {
    if (claudeResult === null) writeFailedResumeResult(resultFile);
    else atomicWrite(resultFile, claudeResult);
  }
  if (transportReady) {
    captureFallback = capturedRegisterFallback({
      container: record.container!,
      resultFile,
      proxyLane: readDispatchRegisterCommitMode(record.container!) === "proxy",
    });
    if (captureFallback) {
      captureFallback = fallback(captureFallback.reason, "reconcile_provider_session",
        `${captureFallback.detail} Re-capture corrected input with the same capture arguments and record; this does not issue signed launch-bound resume authority.`,
        [process.execPath, fileURLToPath(import.meta.url), "capture", ...argv].map((arg) => shellQuote(arg)).join(" "));
      record = updateSessionRecord(record, { status: "ready", fallback: captureFallback });
      writeSessionRecord(recordFile, record);
    }
  }
  const ready = transportReady && !captureFallback;
  emitOutcome({
    ok: ready, provider, session_id: sessionId,
    record_file: resolve(recordFile), result_file: resultFile ? resolve(resultFile) : "",
    status: record.status, ...(captureFallback ? { fallback: captureFallback } : {}),
  });
  return ready ? 0 : 4;
}

function resumeSession(argv: string[]): number {
  let recordFile = "", instructionFile = "", resultFile = "", worktree = "", lockDir = "", model = "", effort = "", source = "";
  let projectRoot = "", pmId = "", dispatchId = "", bindingBranch = "", role = "", slug = "", bindingDigest = "", blueprintUpdateCommit = "", bindingGeneration = 0;
  for (let i = 0; i < argv.length;) {
    const value = argv[i + 1] ?? "";
    switch (argv[i]) {
      case "--record": recordFile = value; i += 2; break;
      case "--instruction": instructionFile = value; i += 2; break;
      case "--result": resultFile = value; i += 2; break;
      case "--worktree": worktree = value; i += 2; break;
      case "--lock-dir": lockDir = value; i += 2; break;
      case "--expected-model": model = value; i += 2; break;
      case "--expected-effort": effort = value; i += 2; break;
      case "--expected-source": source = value; i += 2; break;
      case "--project": projectRoot = value; i += 2; break;
      case "--pm-id": pmId = value; i += 2; break;
      case "--dispatch-id": dispatchId = value; i += 2; break;
      case "--binding-branch-ref": bindingBranch = value; i += 2; break;
      case "--role": role = value; i += 2; break;
      case "--slug": slug = value; i += 2; break;
      case "--binding-generation": bindingGeneration = Number(value); i += 2; break;
      case "--binding-digest": bindingDigest = value; i += 2; break;
      case "--blueprint-update-commit": blueprintUpdateCommit = value; i += 2; break;
      default: throw new Error(`unknown resume arg: ${argv[i]}`);
    }
  }
  if (!recordFile || !instructionFile || !resultFile || !model || !source || !projectRoot || !pmId || (!dispatchId && !bindingBranch) || !role || !slug || !bindingGeneration || !bindingDigest) throw new Error("resume requires record/instruction/result/routing plus canonical project/pm/execution/role/slug/binding flags");
  const outcome = resumeExplicitSession({
    recordFile,
    instructionFile,
    resultFile,
    worktree,
    lockDir,
    expectedRouting: { model, effort, source },
    binding: {
      projectRoot,
      pmId,
      ...(bindingBranch ? { branchRef: bindingBranch } : { dispatchId }),
      role,
      slug,
      generation: bindingGeneration,
      digest: bindingDigest,
      ...(blueprintUpdateCommit ? { blueprintUpdateCommit } : {}),
    },
  });
  emitOutcome(outcome);
  return outcome.ok ? 0 : 4;
}

/** Queue a PM/message-borne instruction through the same allocator as resume. */
function instructRole(argv: string[]): number {
  let projectRoot = "", pmId = "", dispatchId = "", bindingBranch = "";
  let messageFile = "", bindingDigest = "", bindingGeneration = 0;
  for (let i = 0; i < argv.length;) {
    const value = argv[i + 1] ?? "";
    switch (argv[i]) {
      case "--project": projectRoot = value; i += 2; break;
      case "--pm-id": pmId = value; i += 2; break;
      case "--dispatch-id": dispatchId = value; i += 2; break;
      case "--binding-branch-ref": bindingBranch = value; i += 2; break;
      case "--binding-generation": bindingGeneration = Number(value); i += 2; break;
      case "--binding-digest": bindingDigest = value; i += 2; break;
      case "--message-file": messageFile = value; i += 2; break;
      default: throw new Error(`unknown instruct arg: ${argv[i]}`);
    }
  }
  if (!projectRoot || !pmId || (!dispatchId && !bindingBranch) || !bindingGeneration
    || !bindingDigest || !messageFile) {
    throw new Error("instruct requires project/pm/execution/binding and --message-file");
  }
  const message = readFileSync(messageFile, "utf8").trim();
  if (!message) throw new Error("instruct message file is empty");
  const identity = bindingBranch
    ? roleExecutionIdentityForBranch(bindingBranch)
    : dispatchExecutionIdentity(dispatchId);
  const authorization = readCurrentRoleAuthorization({ project_root: projectRoot, pm_id: pmId, identity });
  const attendedHandle = authorization.core.routing.provider === "attended-agent"
    ? validateRoleBinding({
      project_root: projectRoot, pm_id: pmId, identity, stage: "resume",
      generation: bindingGeneration, expected_digest: bindingDigest,
      expected_transport: "attended-agent",
    }).launch?.provider_session_id
    : null;
  if (authorization.core.routing.provider === "attended-agent" && !attendedHandle) {
    throw new Error("instruct requires the current attended launch and its agent handle");
  }
  const instruction = appendRoleInstruction({
    project_root: projectRoot, pm_id: pmId, identity,
    generation: bindingGeneration, expect_digest: bindingDigest,
    message, issuer: { role: "coordinator", id: "provider_session" },
  });
  materializeRoleInstructionLedgerEntry({
    project_root: projectRoot, pm_id: pmId, identity,
    generation: bindingGeneration, expect_digest: bindingDigest, instruction,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true, ledger_token: instruction.ledger_token,
    message_digest: instruction.message_digest, sequence: instruction.sequence,
    ...(authorization.core.routing.provider === "attended-agent" ? {
      next: "SendMessage to agent_name; then run deliver_command with the recorded --ack-launch Agent tool handle and the SendMessage receipt",
      deliver_command: ["bun", "skills/garelier-core/driver/src/scripts/provider_session.ts", "deliver",
        "--project", projectRoot, "--pm-id", pmId,
        ...(bindingBranch ? ["--binding-branch-ref", bindingBranch] : ["--dispatch-id", dispatchId]),
        "--binding-generation", String(bindingGeneration), "--binding-digest", bindingDigest,
        "--sequence", String(instruction.sequence), "--agent-handle", attendedHandle!,
        "--evidence", SEND_MESSAGE_RECEIPT_PLACEHOLDER],
    } : {}),
  })}\n`);
  return 0;
}

/** The attended parent records the delivery after SendMessage succeeds. */
function deliverRole(argv: string[]): number {
  let projectRoot = "", pmId = "", dispatchId = "", bindingBranch = "";
  let bindingDigest = "", bindingGeneration = 0, sequence = 0, agentHandle = "", evidence = "";
  for (let i = 0; i < argv.length;) {
    const value = argv[i + 1] ?? "";
    switch (argv[i]) {
      case "--project": projectRoot = value; i += 2; break;
      case "--pm-id": pmId = value; i += 2; break;
      case "--dispatch-id": dispatchId = value; i += 2; break;
      case "--binding-branch-ref": bindingBranch = value; i += 2; break;
      case "--binding-generation": bindingGeneration = Number(value); i += 2; break;
      case "--binding-digest": bindingDigest = value; i += 2; break;
      case "--sequence": sequence = Number(value); i += 2; break;
      case "--agent-handle": agentHandle = value; i += 2; break;
      case "--evidence": evidence = value; i += 2; break;
      default: throw new Error(`unknown deliver arg: ${argv[i]}`);
    }
  }
  if (!projectRoot || !pmId || Boolean(dispatchId) === Boolean(bindingBranch)
    || !Number.isInteger(bindingGeneration) || bindingGeneration < 1 || !bindingDigest
    || !Number.isInteger(sequence) || sequence < 1 || !agentHandle.trim() || !evidence.trim()) {
    throw new Error("deliver requires project/pm/execution/binding/sequence/agent-handle/evidence");
  }
  if (evidence.trim() === SEND_MESSAGE_RECEIPT_PLACEHOLDER || /^<[^<>]*>$/.test(evidence.trim())) {
    throw new Error("deliver evidence is an unfilled template; send the instruction with SendMessage, then put its returned receipt or a value confirming delivery in --evidence");
  }
  const identity = bindingBranch
    ? roleExecutionIdentityForBranch(bindingBranch)
    : dispatchExecutionIdentity(dispatchId);
  const checked = validateRoleBinding({
    project_root: projectRoot, pm_id: pmId, identity, stage: "resume", expected_digest: bindingDigest,
  });
  if (checked.authorization.core.generation !== bindingGeneration
    || checked.authorization.core.routing.provider !== "attended-agent"
    || checked.launch?.transport !== "attended-agent"
    || checked.launch.provider_session_id !== agentHandle) {
    throw new Error("deliver requires the current attended launch and its agent handle");
  }
  const delivery = acknowledgeInstructionDelivery({
    project_root: projectRoot, pm_id: pmId, identity, generation: bindingGeneration,
    expect_digest: bindingDigest, sequence, provider_session_id: agentHandle,
    evidence, writer: { role: "attended-parent", id: "provider_session" },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, sequence: delivery.sequence,
    provider_session_id: delivery.provider_session_id, delivered_at: delivery.delivered_at })}\n`);
  return 0;
}

export function main(argv = process.argv.slice(2)): number {
  const [command, ...rest] = argv;
  if (command === "capture") return captureSession(rest);
  if (command === "resume") return resumeSession(rest);
  if (command === "instruct") return instructRole(rest);
  if (command === "deliver") return deliverRole(rest);
  process.stderr.write("usage: provider_session.ts capture|resume|instruct|deliver ...\n");
  return 2;
}

function providerFailureNextCommand(argv: string[]): string {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1]! : "";
  };
  const project = value("--project"), pmId = value("--pm-id"), dispatchId = value("--dispatch-id");
  let workId = "";
  if (project && pmId && dispatchId) {
    try {
      const context = JSON.parse(readFileSync(join(project, "__garelier", pmId, "_crew", `dispatch${dispatchId}`, "context.json"), "utf8")) as { control?: { work_id?: unknown } };
      workId = typeof context.control?.work_id === "string" ? context.control.work_id : "";
    } catch { /* fall back to status below */ }
  }
  const parts = workId
    ? ["garelier", "pm", "next", "--work", workId, "--project", project, "--pm-id", pmId]
    : ["garelier", "status", ...(project ? ["--project", project] : []), ...(pmId ? ["--pm-id", pmId] : [])];
  return parts.map((part) => shellQuote(part)).join(" ");
}

if (import.meta.main) {
  try { process.exit(main()); }
  catch (error) {
    process.stderr.write(`provider_session: failed; ${boundedFailureDetail(error, "cli")}\nNEXT_COMMAND: ${providerFailureNextCommand(process.argv.slice(2))}\n`);
    process.exit(2);
  }
}
