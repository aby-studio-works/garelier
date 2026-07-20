#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "../guard/path_guard.ts";
import { pidAlive, requireRuntimeExecutable, resolveBashExecutable, resolveRuntimeExecutable } from "./_lib.ts";
import { normalizeProviderEffort } from "../dispatch/provider_routing.ts";

export const SESSION_SCHEMA = "garelier.provider-session" as const;
export const SESSION_VERSION = 2 as const;
export type SessionProvider = "codex-cli" | "claude-code";
export type SessionStatus = "running" | "ready" | "resuming" | "failed" | "expired";
export interface ProviderRoute { model: string; effort: string; source: string }

export interface SessionFallback {
  required: true;
  reason: string;
  action: "fresh_dispatch_required" | "retry_explicit_resume";
  detail?: string;
}

export interface ProviderSessionRecord {
  schema: typeof SESSION_SCHEMA;
  version: typeof SESSION_VERSION;
  provider: SessionProvider;
  session_id: string;
  worktree: string;
  worktree_identity: { git_dir: string };
  status: SessionStatus;
  timestamps: {
    created_at: string;
    updated_at: string;
    last_resume_at?: string;
  };
  result_file?: string;
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
}

interface LockOwner {
  schema: "garelier.provider-session-lock";
  version: 1;
  provider: SessionProvider;
  session_id: string;
  pid: number;
  nonce: string;
  started_at: string;
}

export interface SessionLock {
  path: string;
  owner: LockOwner;
}

function now(): string { return new Date().toISOString(); }
function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
    return realpathSync(path);
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
  const top = canonicalExistingDirectory(gitOutput(worktree, ["rev-parse", "--show-toplevel"]), "git top-level");
  if (pathKey(top) !== pathKey(worktree)) throw new Error(`worktree must be the git top-level: ${path}`);
  const gitDir = canonicalExistingDirectory(gitOutput(worktree, ["rev-parse", "--absolute-git-dir"]), "git dir");
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
): ProviderSessionRecord {
  const identity = worktreeIdentity(worktreePath);
  const timestamp = now();
  return {
    schema: SESSION_SCHEMA,
    version: SESSION_VERSION,
    provider,
    session_id: sessionId,
    worktree: identity.worktree,
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
  changes: Partial<Pick<ProviderSessionRecord, "session_id" | "status" | "result_file" | "fallback" | "routing">>,
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
  return next;
}

export function parseCodexSessionId(line: string): string {
  try {
    const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
    return event.type === "thread.started" ? explicitSessionId(event.thread_id) : "";
  } catch { return ""; }
}

export function parseClaudeSessionId(output: string): string {
  try {
    const value = JSON.parse(output) as { session_id?: unknown };
    return explicitSessionId(value.session_id);
  } catch { return ""; }
}

function parseClaudeResult(output: string): string {
  try {
    const value = JSON.parse(output) as { result?: unknown };
    return typeof value.result === "string" ? value.result : output;
  } catch { return output; }
}

function readRecord(path: string): ProviderSessionRecord {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProviderSessionRecord>;
  const rawVersion = (value as { version?: number }).version;
  if (value.schema !== SESSION_SCHEMA || (rawVersion !== 1 && rawVersion !== SESSION_VERSION)) throw new Error("unsupported session record schema/version");
  if (value.provider !== "codex-cli" && value.provider !== "claude-code") throw new Error("unsupported session provider");
  if (!["running", "ready", "resuming", "failed", "expired"].includes(String(value.status))) throw new Error("unsupported session status");
  if (typeof value.session_id !== "string") throw new Error("invalid session id field");
  if (!value.worktree || !value.worktree_identity?.git_dir || !value.timestamps?.created_at || !value.timestamps.updated_at) {
    throw new Error("incomplete session record");
  }
  if (value.routing !== undefined) value.routing = strictRoute(value.routing, "record");
  return { ...(value as ProviderSessionRecord), version: SESSION_VERSION };
}

function validateRecordWorktree(record: ProviderSessionRecord, requested: string): void {
  const identity = worktreeIdentity(requested);
  if (pathKey(identity.worktree) !== pathKey(record.worktree)) throw new Error("session belongs to a different worktree path");
  if (pathKey(identity.git_dir) !== pathKey(record.worktree_identity.git_dir)) throw new Error("session belongs to a different git worktree identity");
}

function lockPath(recordPath: string, provider: SessionProvider, sessionId: string, lockDir = ""): string {
  const digest = createHash("sha256").update(`${provider}\0${sessionId}`).digest("hex").slice(0, 32);
  return join(lockDir ? resolve(lockDir) : join(dirname(resolve(recordPath)), "locks"), `${digest}.lock`);
}

function safeLockDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && pathKey(realpathSync(path)) === pathKey(path);
  } catch { return false; }
}

function readLockOwner(path: string): LockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as LockOwner;
    if (owner.schema !== "garelier.provider-session-lock" || owner.version !== 1 || !owner.nonce) return null;
    return owner;
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

export function acquireSessionLock(recordPath: string, record: ProviderSessionRecord, lockDir = ""): SessionLock | null {
  const path = lockPath(recordPath, record.provider, record.session_id, lockDir);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path);
      const owner: LockOwner = {
        schema: "garelier.provider-session-lock", version: 1,
        provider: record.provider, session_id: record.session_id,
        pid: process.pid, nonce: randomUUID(), started_at: now(),
      };
      try { writeFileSync(join(path, "owner.json"), `${JSON.stringify(owner)}\n`); }
      catch (error) {
        try { rmdirSync(path); } catch { /* leave an unverifiable lock, never steal it */ }
        throw error;
      }
      return { path, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!safeLockDirectory(path)) return null;
      const owner = readLockOwner(path);
      if (!owner || !reclaimStaleLock(path, owner)) return null;
    }
  }
  return null;
}

function fallback(reason: string, action: SessionFallback["action"], detail = ""): SessionFallback {
  return { required: true, reason, action, ...(detail ? { detail } : {}) };
}

function expiredFailure(stderr: string, stdout: string): boolean {
  return /(?:session|thread|conversation).{0,40}(?:expired|not found|unknown|does not exist)|(?:expired|not found).{0,40}(?:session|thread|conversation)/i.test(`${stderr}\n${stdout}`);
}

function emitOutcome(outcome: ResumeOutcome): void {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

function writeFallbackResult(resultFile: string, outcome: ResumeOutcome): void {
  atomicWrite(resultFile, `${JSON.stringify(outcome, null, 2)}\n`);
}

export interface ResumeOptions {
  recordFile: string;
  instructionFile: string;
  resultFile: string;
  worktree?: string;
  lockDir?: string;
  env?: Record<string, string | undefined>;
  expectedRouting: ProviderRoute;
}

export function providerChildEnv(
  provider: SessionProvider,
  bash: string,
  base: Record<string, string | undefined>,
  overlay: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env = { ...base, ...overlay };
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
    const outcome: ResumeOutcome = { ...base, ok: false, status: "missing", fallback: fallback("session_record_missing_or_invalid", "fresh_dispatch_required", (error as Error).message) };
    writeFallbackResult(resultFile, outcome);
    return outcome;
  }

  const common = { ...base, provider: record.provider, session_id: record.session_id };
  try {
    const expected = strictRoute(options.expectedRouting, "expected");
    const recorded = strictRoute(record.routing, "record");
    if (!sameRoute(expected, recorded)) throw new Error("recorded route does not match PM/Dock expected route");
  } catch (error) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("routing_authority_mismatch", "retry_explicit_resume", (error as Error).message) };
    writeFallbackResult(resultFile, outcome);
    return outcome;
  }
  const sessionId = explicitSessionId(record.session_id);
  if (!sessionId) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("explicit_session_id_missing_or_forbidden", "fresh_dispatch_required") };
    writeFallbackResult(resultFile, outcome);
    return outcome;
  }
  if (record.status === "expired") {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "expired", fallback: record.fallback ?? fallback("session_expired", "fresh_dispatch_required") };
    writeFallbackResult(resultFile, outcome);
    return outcome;
  }

  try {
    validateRecordWorktree(record, options.worktree || record.worktree);
  } catch (error) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("worktree_identity_mismatch", "retry_explicit_resume", (error as Error).message) };
    writeFallbackResult(resultFile, outcome);
    return outcome;
  }

  let instruction = "";
  try { instruction = readFileSync(options.instructionFile, "utf8").trim(); } catch { /* handled below */ }
  if (!instruction) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "invalid", fallback: fallback("instruction_file_missing_or_empty", "retry_explicit_resume") };
    writeFallbackResult(resultFile, outcome);
    return outcome;
  }

  let lock: SessionLock | null;
  try { lock = acquireSessionLock(recordFile, record, options.lockDir); }
  catch (error) {
    const sessionFallback = fallback("session_lock_failed", "retry_explicit_resume", (error as Error).message);
    const outcome: ResumeOutcome = { ...common, ok: false, status: "failed", fallback: sessionFallback };
    writeFallbackResult(resultFile, outcome);
    return outcome;
  }
  if (!lock) {
    const outcome: ResumeOutcome = { ...common, ok: false, status: "busy", fallback: fallback("session_locked_by_live_or_unverifiable_process", "retry_explicit_resume") };
    writeFallbackResult(resultFile, outcome);
    return outcome;
  }

  try {
    record = updateSessionRecord(record, { status: "resuming", result_file: resultFile }, true);
    writeSessionRecord(recordFile, record);
    const bash = resolveBashExecutable({ env: options.env });
    if (!bash) throw new Error("Git Bash not found");
    const providerArgs = record.provider === "codex-cli"
      ? ["exec", "resume", sessionId,
        ...(record.routing?.model ? ["--model", record.routing.model] : []),
        ...(record.routing?.effort ? ["-c", `model_reasoning_effort=\"${record.routing.effort}\"`] : []),
        "-"]
      : ["-p", instruction, "--resume", sessionId, "--output-format", "json"];
    const commandName = record.provider === "codex-cli" ? "codex" : "claude";
    const provider = resolveRuntimeExecutable(commandName, { env: options.env });
    if (!provider) throw new Error(`${commandName} CLI not found`);
    const command = [bash, "-c", 'exec "$1" "${@:2}"', `garelier-${commandName}`, provider, ...providerArgs];
    const child = Bun.spawnSync(command, {
      windowsHide: true,
      cwd: record.worktree,
      env: providerChildEnv(record.provider, bash, process.env, options.env),
      stdin: record.provider === "codex-cli" ? Buffer.from(instruction) : "ignore",
      stdout: "pipe", stderr: "pipe",
    });
    const stdout = child.stdout?.toString() ?? "";
    const stderr = child.stderr?.toString() ?? "";
    if (child.exitCode !== 0) {
      const expired = expiredFailure(stderr, stdout);
      const sessionFallback = fallback(expired ? "session_expired_or_unavailable" : "provider_resume_failed", expired ? "fresh_dispatch_required" : "retry_explicit_resume", stderr.trim() || stdout.trim());
      record = updateSessionRecord(record, { status: expired ? "expired" : "failed", fallback: sessionFallback });
      writeSessionRecord(recordFile, record);
      const outcome: ResumeOutcome = { ...common, ok: false, status: record.status, fallback: sessionFallback, exit_code: child.exitCode };
      writeFallbackResult(resultFile, outcome);
      return outcome;
    }
    if (record.provider === "claude-code" && parseClaudeSessionId(stdout) !== sessionId) {
      const sessionFallback = fallback("provider_session_id_mismatch", "retry_explicit_resume");
      record = updateSessionRecord(record, { status: "failed", fallback: sessionFallback });
      writeSessionRecord(recordFile, record);
      const outcome: ResumeOutcome = { ...common, ok: false, status: "failed", fallback: sessionFallback, exit_code: 0 };
      writeFallbackResult(resultFile, outcome);
      return outcome;
    }
    const result = record.provider === "claude-code" ? parseClaudeResult(stdout) : stdout;
    atomicWrite(resultFile, result);
    record = updateSessionRecord(record, { status: "ready", result_file: resultFile });
    writeSessionRecord(recordFile, record);
    return { ...common, ok: true, status: "ready", exit_code: 0 };
  } catch (error) {
    const sessionFallback = fallback("resume_launcher_failed", "retry_explicit_resume", (error as Error).message);
    record = updateSessionRecord(record, { status: "failed", fallback: sessionFallback });
    writeSessionRecord(recordFile, record);
    const outcome: ResumeOutcome = { ...common, ok: false, status: "failed", fallback: sessionFallback };
    writeFallbackResult(resultFile, outcome);
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
  const missing = !sessionId ? fallback("session_id_not_captured", "fresh_dispatch_required") : undefined;
  const routing = strictRoute({ model, effort, source }, "capture");
  const record = makeSessionRecord(provider, sessionId, worktree, sessionId ? "ready" : "failed", resultFile, missing, routing);
  writeSessionRecord(recordFile, record);
  if (provider === "claude-code" && resultFile && sessionId) atomicWrite(resultFile, parseClaudeResult(input));
  emitOutcome({
    ok: Boolean(sessionId), provider, session_id: sessionId,
    record_file: resolve(recordFile), result_file: resultFile ? resolve(resultFile) : "",
    status: record.status, ...(missing ? { fallback: missing } : {}),
  });
  return sessionId ? 0 : 4;
}

function resumeSession(argv: string[]): number {
  let recordFile = "", instructionFile = "", resultFile = "", worktree = "", lockDir = "", model = "", effort = "", source = "";
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
      default: throw new Error(`unknown resume arg: ${argv[i]}`);
    }
  }
  if (!recordFile || !instructionFile || !resultFile || !model || !source) throw new Error("resume requires --record, --instruction, --result, and authoritative --expected-model/--expected-effort/--expected-source");
  const outcome = resumeExplicitSession({ recordFile, instructionFile, resultFile, worktree, lockDir, expectedRouting: { model, effort, source } });
  emitOutcome(outcome);
  return outcome.ok ? 0 : 4;
}

export function main(argv = process.argv.slice(2)): number {
  const [command, ...rest] = argv;
  if (command === "capture") return captureSession(rest);
  if (command === "resume") return resumeSession(rest);
  process.stderr.write("usage: provider_session.ts capture|resume ...\n");
  return 2;
}

if (import.meta.main) {
  try { process.exit(main()); }
  catch (error) { process.stderr.write(`provider_session: ${(error as Error).message}\n`); process.exit(2); }
}
