import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { rmSync } from "../guard/path_guard.ts";
import { isAbsolute, join } from "node:path";
import {
  assertNoSymlinkPath,
  assertSafeIdentifier,
  atomicWriteRuntimeFile,
  ensureSafeDirectory,
  writeControlDiagnostic,
} from "./diagnostics.ts";
import { readRuntimeDispatchSnapshot } from "./dispatch_runtime.ts";
import { readCanonicalControlBinding, type CanonicalControlBinding } from "./generation.ts";
import { canonicalJson } from "./serialization.ts";
import {
  assertSessionControlBinding,
  loadRuntimeControlSnapshot,
  readControlSession,
  readRuntimeSessions,
  writeControlSession,
  type ControlRuntimeCallbacks,
} from "./sessions.ts";
import { acquireNamespaceLock, assertNamespaceLock, resolveControlNamespace, type ControlNamespacePaths, type NamespaceLock } from "./transaction.ts";

export interface ControlClaimRecord {
  work_id: string;
  session_id: string;
  agent: string;
  claimed_at: string;
  expires_at: string;
  touches: string[];
  /** Advisory-only overlaps with live dispatches; PM decides whether to serialize. */
  touch_conflicts: ClaimTouchConflict[];
  entity_revision: number;
  control_schema_version?: 3;
  storage?: "plan_graph_markdown";
}

export interface ClaimTouchConflict {
  dispatch_id: string;
  overlapping_globs: string[];
}

export interface ActiveDispatchTouches {
  id: string;
  touches: string[];
  /** W-318: the Work/Backlog the dispatch container is bound to, when it declares one. */
  work_id?: string | null;
  /** W-318: the control session the dispatch container is bound to, when it declares one. */
  session_id?: string | null;
}

interface ClaimPathOptions {
  targetRoot: string;
  pmId: string;
  controlRoot?: string;
  runtimeRoot?: string;
  runtimeCallbacks?: ControlRuntimeCallbacks;
}

export interface ClaimWorkOptions extends ClaimPathOptions {
  workId: string;
  sessionId: string;
  touches?: string[];
  steal?: boolean;
  reason?: string;
  activeDispatches?: ActiveDispatchTouches[];
  /** Dispatch containers created by this same bind attempt. */
  excludeDispatchIds?: string[];
  now?: () => Date;
  namespaceLock?: NamespaceLock;
}

export interface ReleaseClaimOptions extends ClaimPathOptions {
  workId: string;
  sessionId: string;
  now?: () => Date;
  namespaceLock?: NamespaceLock;
}

function claimPath(paths: ControlNamespacePaths, workId: string): string {
  if (!/^W-\d+$/.test(workId)) throw new Error(`invalid Work ID: ${workId}`);
  return join(paths.runtimeRoot, "claims", `${workId}.json`);
}

function normalizeTouch(touch: string): string {
  if (!touch || isAbsolute(touch) || touch.includes("\\") || touch.includes("\0")) throw new Error(`unsafe touch path: ${touch}`);
  const parts = touch.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe touch path: ${touch}`);
  if (parts.some((part) => !/^[A-Za-z0-9._*?-]+$/.test(part))) throw new Error(`touch path contains unsupported glob syntax: ${touch}`);
  return parts.join("/");
}

function normalizeTouches(touches: readonly string[]): string[] {
  return [...new Set(touches.map(normalizeTouch))].sort();
}

function staticPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?{[]/);
  return (wildcard < 0 ? pattern : pattern.slice(0, wildcard)).replace(/\/$/, "");
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") { source += ".*"; index++; }
      else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$+.()|]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

export function touchesConflict(left: string, right: string): boolean {
  const a = normalizeTouch(left);
  const b = normalizeTouch(right);
  if (globRegex(a).test(b) || globRegex(b).test(a)) return true;
  if (!/[*?]/.test(a) && !/[*?]/.test(b)) return false;
  const ap = staticPrefix(a);
  const bp = staticPrefix(b);
  if (!ap || !bp) return true;
  return ap.startsWith(bp) || bp.startsWith(ap);
}

function parseClaim(source: string, path: string): ControlClaimRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch (error) { throw new Error(`invalid claim JSON at ${path}: ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`claim must be an object: ${path}`);
  const value = parsed as Record<string, unknown>;
  const allowed = new Set(["work_id", "session_id", "agent", "claimed_at", "expires_at", "touches", "touch_conflicts", "entity_revision", "control_schema_version", "storage"]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) throw new Error(`claim contains unknown field: ${extra}`);
  for (const field of ["work_id", "session_id", "agent", "claimed_at", "expires_at"] as const) {
    if (typeof value[field] !== "string" || !value[field]) throw new Error(`claim.${field} must be a non-empty string`);
  }
  for (const field of ["claimed_at", "expires_at"] as const) if (!Number.isFinite(Date.parse(value[field] as string))) throw new Error(`claim.${field} must be a timestamp`);
  if (!Number.isInteger(value.entity_revision) || (value.entity_revision as number) < 1) throw new Error("claim.entity_revision must be a positive integer");
  if (!Array.isArray(value.touches) || value.touches.some((touch) => typeof touch !== "string")) throw new Error("claim.touches must be a string array");
  const touchConflicts = value.touch_conflicts === undefined ? [] : value.touch_conflicts;
  if (!Array.isArray(touchConflicts) || touchConflicts.some((conflict) => !conflict || typeof conflict !== "object" || Array.isArray(conflict)
    || typeof (conflict as Record<string, unknown>).dispatch_id !== "string"
    || !(conflict as Record<string, unknown>).dispatch_id
    || !Array.isArray((conflict as Record<string, unknown>).overlapping_globs)
    || ((conflict as Record<string, unknown>).overlapping_globs as unknown[]).some((glob) => typeof glob !== "string"))) {
    throw new Error("claim.touch_conflicts must be dispatch/glob records");
  }
  const hasBinding = value.control_schema_version !== undefined || value.storage !== undefined;
  if (hasBinding && !(value.control_schema_version === 3 && value.storage === "plan_graph_markdown")) throw new Error("claim canonical control binding is invalid");
  return {
    work_id: value.work_id as string,
    session_id: value.session_id as string,
    agent: value.agent as string,
    claimed_at: value.claimed_at as string,
    expires_at: value.expires_at as string,
    touches: normalizeTouches(value.touches as string[]),
    touch_conflicts: (touchConflicts as Array<Record<string, unknown>>).map((conflict) => ({
      dispatch_id: conflict.dispatch_id as string,
      overlapping_globs: normalizeTouches(conflict.overlapping_globs as string[]),
    })),
    entity_revision: value.entity_revision as number,
    ...(hasBinding ? {
      control_schema_version: value.control_schema_version as 3,
      storage: value.storage as "plan_graph_markdown",
    } : {}),
  };
}

export function assertClaimControlBinding(claim: ControlClaimRecord, binding: CanonicalControlBinding): void {
  if (claim.control_schema_version === undefined && claim.storage === undefined) {
    throw new Error(`schema-3 claim lacks an explicit canonical binding: ${claim.work_id}`);
  }
  if (claim.control_schema_version !== binding.controlSchemaVersion || claim.storage !== binding.storage) {
    throw new Error(
      `claim ${claim.work_id} is bound to schema ${claim.control_schema_version}/${claim.storage}, canonical control is ${binding.controlSchemaVersion}/${binding.storage}`,
    );
  }
}

export function readControlClaim(paths: ControlNamespacePaths, workId: string): ControlClaimRecord | null {
  const path = claimPath(paths, workId);
  if (!existsSync(path)) return null;
  assertNoSymlinkPath(paths.runtimeRoot, path);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`claim path must be a regular file: ${path}`);
  const claim = parseClaim(readFileSync(path, "utf8"), path);
  if (claim.work_id !== workId) throw new Error(`claim Work identity mismatch: ${path}`);
  return claim;
}

function writeClaim(paths: ControlNamespacePaths, claim: ControlClaimRecord): void {
  ensureSafeDirectory(paths.runtimeRoot, join(paths.runtimeRoot, "claims"));
  atomicWriteRuntimeFile(paths.runtimeRoot, claimPath(paths, claim.work_id), canonicalJson(claim));
}

/**
 * W-318 — a dispatch's touch reservation exists to keep OTHER work off those
 * paths. A dispatch bound to the very (Work, session) pair now taking the claim
 * is not other work: it is the same actor re-acquiring the claim that dispatch
 * was created FOR. Counting it as a conflict is what closed the recovery cycle
 * (dispatch_cleanup wants a claim → claim refuses because the dispatch is
 * active → the dispatch cannot be cleaned up), so self-owned containers are
 * excluded here.
 *
 * The exclusion requires BOTH identities to match. A dispatch bound to the same
 * Work under a DIFFERENT session still conflicts (two sessions racing one row),
 * and a container that declares no binding at all (`work_id`/`session_id`
 * absent) is never treated as self-owned — an unidentifiable reservation stays
 * fail-closed.
 */
function selfOwnedDispatch(dispatch: ActiveDispatchTouches, workId: string, sessionId: string): boolean {
  return Boolean(dispatch.work_id) && Boolean(dispatch.session_id)
    && dispatch.work_id === workId && dispatch.session_id === sessionId;
}

function dispatchTouchConflicts(touches: string[], dispatches: ActiveDispatchTouches[], workId: string, sessionId: string): ClaimTouchConflict[] {
  const conflicts: ClaimTouchConflict[] = [];
  for (const dispatch of dispatches) {
    if (selfOwnedDispatch(dispatch, workId, sessionId)) continue;
    const existing = normalizeTouches(dispatch.touches);
    // Conflict annotations are persisted inside a claim and are parsed again on
    // every later claim read. Keep this field to valid touch syntax: the old
    // human-readable `left ~ right` rendering made the claim itself unreadable.
    const overlapping_globs = [...new Set(touches.flatMap((touch) => existing.flatMap((other) =>
      touchesConflict(touch, other) ? (touch === other ? [touch] : [touch, other]) : [],
    )))].sort();
    if (overlapping_globs.length) conflicts.push({ dispatch_id: dispatch.id, overlapping_globs });
  }
  return conflicts.sort((left, right) => left.dispatch_id.localeCompare(right.dispatch_id));
}

export function readRuntimeClaims(runtimeRoot: string, maxClaims = 4096): ControlClaimRecord[] {
  const directory = join(runtimeRoot, "claims");
  if (!existsSync(directory)) return [];
  assertNoSymlinkPath(runtimeRoot, directory);
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`claim root must be a real directory: ${directory}`);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > maxClaims) throw new Error(`claim count exceeds ${maxClaims}`);
  const claims: ControlClaimRecord[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`claim symlink is forbidden: ${path}`);
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    assertNoSymlinkPath(runtimeRoot, path);
    const file = lstatSync(path);
    if (file.size > 64 * 1024) throw new Error(`claim file exceeds 65536 bytes: ${path}`);
    const claim = parseClaim(readFileSync(path, "utf8"), path);
    if (`${claim.work_id}.json` !== entry.name) throw new Error(`claim Work identity mismatch: ${path}`);
    claims.push(claim);
  }
  return claims.sort((a, b) => a.work_id.localeCompare(b.work_id));
}

function diagnosticError(error: unknown): { name: string; message: string } {
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
}

export function claimWork(options: ClaimWorkOptions): ControlClaimRecord {
  const paths = resolveControlNamespace(options);
  assertSafeIdentifier(options.sessionId, "session_id");
  const now = options.now?.() ?? new Date();
  const at = now.toISOString();
  const touches = normalizeTouches(options.touches ?? []);
  const lock = options.namespaceLock ?? acquireNamespaceLock(paths, { sessionId: options.sessionId, operation: "claim", at });
  assertNamespaceLock(paths, lock);
  try {
    const dispatchBefore = readRuntimeDispatchSnapshot(paths.pmRoot, {
      excludeIds: options.excludeDispatchIds,
      targetRoot: paths.targetRoot,
    });
    const session = readControlSession(paths, options.sessionId);
    const { binding, snapshot } = loadRuntimeControlSnapshot(paths, options.pmId, now, options.runtimeCallbacks);
    assertSessionControlBinding(session, binding);
    const entity = snapshot.entity(options.workId);
    if (!entity) throw new Error(`Backlog does not exist: ${options.workId}`);
    if (entity.terminal) throw new Error(`terminal Backlog cannot be claimed: ${options.workId}`);
    const touchConflicts = dispatchTouchConflicts(touches, [
      ...dispatchBefore.dispatches.map((entry) => ({ id: entry.id, touches: entry.touches, work_id: entry.work_id, session_id: entry.session_id })),
      ...(options.activeDispatches ?? []),
    ], options.workId, options.sessionId);
    const path = claimPath(paths, options.workId);
    const previousSource = existsSync(path) ? readFileSync(path, "utf8") : null;
    const previous = previousSource === null ? null : parseClaim(previousSource, path);
    if (previous) assertClaimControlBinding(previous, binding);
    const sessions = new Map(readRuntimeSessions(paths.runtimeRoot).map((record) => [record.session_id, record]));
    const previousSession = previous ? sessions.get(previous.session_id) : undefined;
    if (previousSession) assertSessionControlBinding(previousSession, binding);
    const stale = previous ? Date.parse(previous.expires_at) <= now.getTime()
      || !previousSession
      || Date.parse(previousSession.heartbeat_at) + snapshot.claimStaleAfterSeconds * 1000 <= now.getTime() : false;
    if (previous && !stale) {
      if (previous.session_id === options.sessionId) return previous;
      throw new Error(`Work already has an active claim: ${options.workId}`);
    }
    const sameSessionRenewal = previous?.session_id === options.sessionId;
    if (previous && stale && !sameSessionRenewal && (!options.steal || !options.reason?.trim())) {
      throw new Error(`stale claim requires --steal with a non-empty reason: ${options.workId}`);
    }
    if (!previous && options.steal) throw new Error(`cannot steal a Work without an existing stale claim: ${options.workId}`);
    const runtimeClaims = readRuntimeClaims(paths.runtimeRoot);
    for (const other of runtimeClaims) assertClaimControlBinding(other, binding);
    const dispatchAfter = readRuntimeDispatchSnapshot(paths.pmRoot, {
      excludeIds: options.excludeDispatchIds,
      targetRoot: paths.targetRoot,
    });
    if (dispatchAfter.revision !== dispatchBefore.revision) throw new Error("active dispatch runtime changed during claim conflict check; retry");
    const claim: ControlClaimRecord = {
      work_id: options.workId,
      session_id: options.sessionId,
      agent: session.agent,
      claimed_at: at,
      expires_at: new Date(now.getTime() + snapshot.claimTtlSeconds * 1000).toISOString(),
      touches,
      touch_conflicts: touchConflicts,
      entity_revision: entity.revision,
      control_schema_version: binding.controlSchemaVersion,
      storage: binding.storage,
    };
    writeClaim(paths, claim);
    try {
      if (!session.claims.includes(options.workId)) writeControlSession(paths, { ...session, claims: [...session.claims, options.workId].sort() });
      if (previous && previous.session_id !== options.sessionId) {
        try {
          const previousSession = readControlSession(paths, previous.session_id);
          writeControlSession(paths, { ...previousSession, claims: previousSession.claims.filter((id) => id !== options.workId) });
        } catch {
          // A stale claim may outlive its session; absence is expected during an explicit steal.
        }
      }
    } catch (error) {
      if (previousSource === null) rmSync(path, { force: true });
      else atomicWriteRuntimeFile(paths.runtimeRoot, path, previousSource);
      throw error;
    }
    writeControlDiagnostic(paths.runtimeRoot, {
      schema_version: 1, operation: "claim", status: "ok", pm_id: options.pmId, session_id: options.sessionId,
      at, control_revision: snapshot.revision, entity: options.workId, changed_paths: [],
      reason: previous ? (sameSessionRenewal ? "same-session renewal" : options.reason!.trim()) : null, error: null,
    });
    return claim;
  } catch (error) {
    writeControlDiagnostic(paths.runtimeRoot, {
      schema_version: 1, operation: "claim", status: "error", pm_id: options.pmId, session_id: options.sessionId,
      at, control_revision: null, entity: options.workId, changed_paths: [], reason: options.reason?.trim() || null, error: diagnosticError(error),
    });
    throw error;
  } finally { if (!options.namespaceLock) lock.release(); }
}

export function releaseClaim(options: ReleaseClaimOptions): boolean {
  const paths = resolveControlNamespace(options);
  const now = options.now?.() ?? new Date();
  const at = now.toISOString();
  const lock = options.namespaceLock ?? acquireNamespaceLock(paths, { sessionId: options.sessionId, operation: "claim-release", at });
  assertNamespaceLock(paths, lock);
  try {
    const claim = readControlClaim(paths, options.workId);
    if (!claim) return false;
    if (claim.session_id !== options.sessionId) throw new Error(`claim belongs to another session: ${options.workId}`);
    const session = readControlSession(paths, options.sessionId);
    const binding = readCanonicalControlBinding(paths.controlRoot);
    assertSessionControlBinding(session, binding);
    assertClaimControlBinding(claim, binding);
    rmSync(claimPath(paths, options.workId));
    try { writeControlSession(paths, { ...session, claims: session.claims.filter((id) => id !== options.workId) }); }
    catch (error) { writeClaim(paths, claim); throw error; }
    writeControlDiagnostic(paths.runtimeRoot, {
      schema_version: 1, operation: "claim-release", status: "ok", pm_id: options.pmId, session_id: options.sessionId,
      at, control_revision: session.base_control_revision, entity: options.workId, changed_paths: [], reason: null, error: null,
    });
    return true;
  } finally { if (!options.namespaceLock) lock.release(); }
}

export function refreshClaimEntityRevision(options: ReleaseClaimOptions & { entityRevision: number }): ControlClaimRecord {
  if (!Number.isInteger(options.entityRevision) || options.entityRevision < 1) throw new Error("claim entity revision must be a positive integer");
  const paths = resolveControlNamespace(options);
  const now = options.now?.() ?? new Date();
  const lock = options.namespaceLock ?? acquireNamespaceLock(paths, { sessionId: options.sessionId, operation: "claim-refresh", at: now.toISOString() });
  assertNamespaceLock(paths, lock);
  try {
    const claim = readControlClaim(paths, options.workId);
    if (!claim) throw new Error(`Work has no active claim: ${options.workId}`);
    if (claim.session_id !== options.sessionId) throw new Error(`claim belongs to another session: ${options.workId}`);
    const binding = readCanonicalControlBinding(paths.controlRoot);
    assertClaimControlBinding(claim, binding);
    assertSessionControlBinding(readControlSession(paths, options.sessionId), binding);
    const updated = { ...claim, entity_revision: options.entityRevision };
    writeClaim(paths, updated);
    return updated;
  } finally { if (!options.namespaceLock) lock.release(); }
}
