import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { rmSync } from "../guard/path_guard.ts";
import { join } from "node:path";
import {
  assertNoSymlinkPath,
  assertSafeIdentifier,
  atomicWriteRuntimeFile,
  ensureSafeDirectory,
  writeControlDiagnostic,
} from "./diagnostics.ts";
import { readCanonicalControlBinding, type CanonicalControlBinding } from "./generation.ts";
import { canonicalJson } from "./serialization.ts";
import {
  acquireNamespaceLock,
  assertNamespaceLock,
  resolveControlNamespace,
  type ControlNamespacePaths,
  type NamespaceLock,
} from "./transaction.ts";

export interface ControlSessionRecord {
  session_id: string;
  agent: string;
  pm_id: string;
  opened_at: string;
  heartbeat_at: string;
  base_control_revision: string;
  claims: string[];
  cwd: string;
  control_schema_version?: 3;
  storage?: "plan_graph_markdown";
}

export interface ControlRuntimeEntitySnapshot {
  revision: number;
  terminal: boolean;
}

export interface ControlRuntimeSnapshot {
  revision: string;
  claimTtlSeconds: number;
  claimStaleAfterSeconds: number;
  entity(id: string): ControlRuntimeEntitySnapshot | null;
}

export interface ControlRuntimeCallbacks {
  load(options: {
    targetRoot: string;
    pmId: string;
    controlRoot: string;
    runtimeRoot: string;
    now: Date;
    binding: CanonicalControlBinding;
  }): ControlRuntimeSnapshot;
}

interface SessionPathOptions {
  targetRoot: string;
  pmId: string;
  controlRoot?: string;
  runtimeRoot?: string;
  runtimeCallbacks?: ControlRuntimeCallbacks;
}

export interface OpenSessionOptions extends SessionPathOptions {
  agent: string;
  cwd: string;
  sessionId?: string;
  now?: () => Date;
}

export interface SessionActionOptions extends SessionPathOptions {
  sessionId: string;
  now?: () => Date;
}

export interface HeartbeatSessionOptions extends SessionActionOptions {
  namespaceLock?: NamespaceLock;
  /** Optional exact claim subset for a lane-scoped heartbeat. */
  workIds?: readonly string[];
}

function sessionIdFor(now: Date): string {
  return `cs_${now.getTime().toString(36).toUpperCase().padStart(10, "0")}_${randomBytes(6).toString("hex")}`;
}

function sessionPath(paths: ControlNamespacePaths, sessionId: string): string {
  assertSafeIdentifier(sessionId, "session_id");
  return join(paths.runtimeRoot, "sessions", `${sessionId}.json`);
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be a string array`);
  return [...new Set(value)].sort();
}

function parseSession(source: string, path: string): ControlSessionRecord {
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) { throw new Error(`invalid session JSON at ${path}: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`session must be an object: ${path}`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(["session_id", "agent", "pm_id", "opened_at", "heartbeat_at", "base_control_revision", "claims", "cwd", "control_schema_version", "storage"]);
  const extra = Object.keys(record).find((key) => !allowed.has(key));
  if (extra) throw new Error(`session contains unknown field: ${extra}`);
  const strings = ["session_id", "agent", "pm_id", "opened_at", "heartbeat_at", "base_control_revision", "cwd"] as const;
  for (const field of strings) if (typeof record[field] !== "string" || !(record[field] as string)) throw new Error(`session.${field} must be a non-empty string`);
  for (const field of ["opened_at", "heartbeat_at"] as const) if (!Number.isFinite(Date.parse(record[field] as string))) throw new Error(`session.${field} must be a timestamp`);
  const hasBinding = record.control_schema_version !== undefined || record.storage !== undefined;
  if (hasBinding && !(record.control_schema_version === 3 && record.storage === "plan_graph_markdown")) throw new Error("session canonical control binding is invalid");
  return {
    session_id: record.session_id as string,
    agent: record.agent as string,
    pm_id: record.pm_id as string,
    opened_at: record.opened_at as string,
    heartbeat_at: record.heartbeat_at as string,
    base_control_revision: record.base_control_revision as string,
    claims: parseStringArray(record.claims, "session.claims"),
    cwd: record.cwd as string,
    ...(hasBinding ? {
      control_schema_version: record.control_schema_version as 3,
      storage: record.storage as "plan_graph_markdown",
    } : {}),
  };
}

export function assertSessionControlBinding(session: ControlSessionRecord, binding: CanonicalControlBinding): void {
  if (session.control_schema_version === undefined && session.storage === undefined) {
    throw new Error(`schema-3 session lacks an explicit canonical binding: ${session.session_id}`);
  }
  if (session.control_schema_version !== binding.controlSchemaVersion || session.storage !== binding.storage) {
    throw new Error(
      `session ${session.session_id} is bound to schema ${session.control_schema_version}/${session.storage}, canonical control is ${binding.controlSchemaVersion}/${binding.storage}`,
    );
  }
}

export function loadRuntimeControlSnapshot(
  paths: ControlNamespacePaths,
  pmId: string,
  now: Date,
  callbacks?: ControlRuntimeCallbacks,
): { binding: CanonicalControlBinding; snapshot: ControlRuntimeSnapshot } {
  const binding = readCanonicalControlBinding(paths.controlRoot);
  if (callbacks) {
    const snapshot = callbacks.load({
      targetRoot: paths.targetRoot,
      pmId,
      controlRoot: paths.controlRoot,
      runtimeRoot: paths.runtimeRoot,
      now,
      binding,
    });
    if (!/^sha256:[0-9a-f]{64}$/.test(snapshot.revision)
      || !Number.isInteger(snapshot.claimTtlSeconds) || snapshot.claimTtlSeconds < 1
      || !Number.isInteger(snapshot.claimStaleAfterSeconds) || snapshot.claimStaleAfterSeconds < 1) {
      throw new Error("runtime control callback returned an invalid snapshot");
    }
    return { binding, snapshot };
  }
  throw new Error("schema-3 session/claim operation requires runtime callbacks");
}

export function readControlSession(paths: ControlNamespacePaths, sessionId: string): ControlSessionRecord {
  const path = sessionPath(paths, sessionId);
  assertNoSymlinkPath(paths.runtimeRoot, path);
  if (!existsSync(path)) throw new Error(`control session is not open: ${sessionId}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`session path must be a regular file: ${path}`);
  const record = parseSession(readFileSync(path, "utf8"), path);
  if (record.session_id !== sessionId || record.pm_id !== paths.pmRoot.split(/[\\/]/).at(-1)) throw new Error(`session identity mismatch: ${path}`);
  return record;
}

export function writeControlSession(paths: ControlNamespacePaths, record: ControlSessionRecord): void {
  const path = sessionPath(paths, record.session_id);
  ensureSafeDirectory(paths.runtimeRoot, join(paths.runtimeRoot, "sessions"));
  atomicWriteRuntimeFile(paths.runtimeRoot, path, canonicalJson({ ...record, claims: [...new Set(record.claims)].sort() }));
}

export function readRuntimeSessions(runtimeRoot: string, maxSessions = 4096): ControlSessionRecord[] {
  const directory = join(runtimeRoot, "sessions");
  if (!existsSync(directory)) return [];
  assertNoSymlinkPath(runtimeRoot, directory);
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`session root must be a real directory: ${directory}`);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > maxSessions) throw new Error(`session count exceeds ${maxSessions}`);
  const sessions: ControlSessionRecord[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`session symlink is forbidden: ${path}`);
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    assertNoSymlinkPath(runtimeRoot, path);
    const file = lstatSync(path);
    if (file.size > 64 * 1024) throw new Error(`session file exceeds 65536 bytes: ${path}`);
    const session = parseSession(readFileSync(path, "utf8"), path);
    if (`${session.session_id}.json` !== entry.name) throw new Error(`session identity mismatch: ${path}`);
    sessions.push(session);
  }
  return sessions.sort((a, b) => a.session_id.localeCompare(b.session_id));
}

export function openControlSession(options: OpenSessionOptions): ControlSessionRecord {
  const paths = resolveControlNamespace(options);
  const now = options.now?.() ?? new Date();
  const at = now.toISOString();
  const sessionId = options.sessionId ?? sessionIdFor(now);
  assertSafeIdentifier(sessionId, "session_id");
  assertSafeIdentifier(options.agent, "agent");
  const lock = acquireNamespaceLock(paths, { sessionId, operation: "session-open", at });
  try {
    const path = sessionPath(paths, sessionId);
    if (existsSync(path)) throw new Error(`control session already exists: ${sessionId}`);
    const { binding, snapshot } = loadRuntimeControlSnapshot(paths, options.pmId, now, options.runtimeCallbacks);
    const record: ControlSessionRecord = {
      session_id: sessionId,
      agent: options.agent,
      pm_id: options.pmId,
      opened_at: at,
      heartbeat_at: at,
      base_control_revision: snapshot.revision,
      claims: [],
      cwd: options.cwd,
      control_schema_version: binding.controlSchemaVersion,
      storage: binding.storage,
    };
    writeControlSession(paths, record);
    writeControlDiagnostic(paths.runtimeRoot, {
      schema_version: 1, operation: "session-open", status: "ok", pm_id: options.pmId, session_id: sessionId,
      at, control_revision: snapshot.revision, entity: null, changed_paths: [], reason: null, error: null,
    });
    return record;
  } catch (error) {
    writeControlDiagnostic(paths.runtimeRoot, {
      schema_version: 1, operation: "session-open", status: "error", pm_id: options.pmId, session_id: sessionId,
      at, control_revision: null, entity: null, changed_paths: [], reason: null,
      error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  } finally { lock.release(); }
}

export function heartbeatControlSession(options: HeartbeatSessionOptions): ControlSessionRecord {
  const paths = resolveControlNamespace(options);
  const now = options.now?.() ?? new Date();
  const at = now.toISOString();
  const lock = options.namespaceLock ?? acquireNamespaceLock(paths, { sessionId: options.sessionId, operation: "session-heartbeat", at });
  assertNamespaceLock(paths, lock);
  try {
    const session = readControlSession(paths, options.sessionId);
    const { binding, snapshot } = loadRuntimeControlSnapshot(paths, options.pmId, now, options.runtimeCallbacks);
    assertSessionControlBinding(session, binding);
    if (Date.parse(at) < Date.parse(session.heartbeat_at)) throw new Error("session heartbeat cannot move backwards");
    const selected = options.workIds === undefined ? session.claims : [...new Set(options.workIds)];
    if (options.workIds !== undefined) {
      const unowned = selected.filter((workId) => !session.claims.includes(workId));
      if (unowned.length > 0) throw new Error(`session heartbeat does not own requested claims: ${unowned.join(",")}`);
    }
    const claimsDirectory = join(paths.runtimeRoot, "claims");
    const claimUpdates: Array<{ path: string; claim: Record<string, unknown> }> = [];
    for (const workId of selected) {
      const path = join(claimsDirectory, `${workId}.json`);
      if (!existsSync(path)) {
        if (options.workIds !== undefined) throw new Error(`session heartbeat requested claim is missing: ${workId}`);
        continue;
      }
      assertNoSymlinkPath(paths.runtimeRoot, path);
      const claim = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (claim.session_id !== options.sessionId) {
        if (options.workIds !== undefined) throw new Error(`session heartbeat requested claim has a different owner: ${workId}`);
        continue;
      }
      if ((claim.control_schema_version !== undefined || claim.storage !== undefined)
        && (claim.control_schema_version !== binding.controlSchemaVersion || claim.storage !== binding.storage)) {
        throw new Error(`claim canonical binding mismatch during heartbeat: ${workId}`);
      }
      if (binding.controlSchemaVersion === 3 && claim.control_schema_version === undefined) {
        throw new Error(`schema-3 claim lacks an explicit canonical binding: ${workId}`);
      }
      const expiresAt = Date.parse(String(claim.expires_at));
      if (!Number.isFinite(expiresAt)) {
        if (options.workIds !== undefined) throw new Error(`claim expiry is invalid during heartbeat: ${workId}`);
        continue;
      }
      if (expiresAt <= now.getTime()) {
        if (options.workIds !== undefined) throw new Error(`session heartbeat requested claim is expired: ${workId}`);
        continue;
      }
      claim.expires_at = new Date(now.getTime() + snapshot.claimTtlSeconds * 1000).toISOString();
      claimUpdates.push({ path, claim });
    }
    const updated = { ...session, heartbeat_at: at };
    writeControlSession(paths, updated);
    for (const update of claimUpdates) {
      atomicWriteRuntimeFile(paths.runtimeRoot, update.path, canonicalJson(update.claim));
    }
    writeControlDiagnostic(paths.runtimeRoot, {
      schema_version: 1, operation: "session-heartbeat", status: "ok", pm_id: options.pmId, session_id: options.sessionId,
      at, control_revision: session.base_control_revision, entity: null, changed_paths: [], reason: null, error: null,
    });
    return updated;
  } finally { if (!options.namespaceLock) lock.release(); }
}

export function closeControlSession(options: SessionActionOptions): { session_id: string; released_claims: string[] } {
  const paths = resolveControlNamespace(options);
  const now = options.now?.() ?? new Date();
  const at = now.toISOString();
  const lock = acquireNamespaceLock(paths, { sessionId: options.sessionId, operation: "session-close", at });
  try {
    const session = readControlSession(paths, options.sessionId);
    const claimsDirectory = join(paths.runtimeRoot, "claims");
    const released: string[] = [];
    if (existsSync(claimsDirectory)) {
      assertNoSymlinkPath(paths.runtimeRoot, claimsDirectory);
      for (const entry of readdirSync(claimsDirectory, { withFileTypes: true })) {
        const path = join(claimsDirectory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`claim symlink is forbidden: ${path}`);
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const claim = JSON.parse(readFileSync(path, "utf8")) as { session_id?: string; work_id?: string };
        if (claim.session_id !== options.sessionId) continue;
        rmSync(path);
        if (claim.work_id) released.push(claim.work_id);
      }
    }
    rmSync(sessionPath(paths, options.sessionId));
    released.sort();
    writeControlDiagnostic(paths.runtimeRoot, {
      schema_version: 1, operation: "session-close", status: "ok", pm_id: options.pmId, session_id: options.sessionId,
      at, control_revision: session.base_control_revision, entity: null, changed_paths: [], reason: null, error: null,
    });
    return { session_id: options.sessionId, released_claims: released };
  } finally { lock.release(); }
}
