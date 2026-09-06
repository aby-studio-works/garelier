import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { removeTreeSync, renameSync, rmSync } from "../guard/path_guard.ts";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import {
  assertNoSymlinkPath,
  assertPathInside,
  assertSafeRelativePath,
  ensureSafeDirectory,
  writeControlDiagnostic,
  type DiagnosticWriteResult,
} from "./diagnostics.ts";
import { assertSafeFilesystemPath, assertSafePmId } from "./roots.ts";
import {
  beginControlGeneration,
  readCanonicalControlBinding,
  readControlGeneration,
  type CanonicalControlBinding,
  type ControlGenerationLease,
} from "./generation.ts";
import { removeGenerationRecoveryJournal, writeGenerationRecoveryJournal } from "./generation_recovery.ts";
import { sha256 } from "./serialization.ts";

export class ControlTransactionError extends Error {
  constructor(readonly code: string, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ControlTransactionError";
  }
}

export class ControlLockError extends ControlTransactionError {
  constructor(message: string, cause?: unknown) { super("control-lock-contended", message, cause); this.name = "ControlLockError"; }
}

export interface ControlNamespacePaths {
  targetRoot: string;
  pmRoot: string;
  controlRoot: string;
  runtimeRoot: string;
}

export interface NamespaceLock {
  path: string;
  token: string;
  release(): void;
}

export function assertNamespaceLock(paths: ControlNamespacePaths, lock: NamespaceLock): void {
  const expected = join(paths.runtimeRoot, "locks", "namespace.lock");
  if (resolve(lock.path) !== resolve(expected)) throw new ControlTransactionError("control-lock-namespace-mismatch", `namespace lock does not belong to ${paths.runtimeRoot}`);
  let current: { token?: unknown };
  try { current = JSON.parse(readFileSync(lock.path, "utf8")) as { token?: unknown }; }
  catch (error) { throw new ControlTransactionError("control-lock-lost", `namespace lock is not readable: ${lock.path}`, error); }
  if (current.token !== lock.token) throw new ControlTransactionError("control-lock-changed", `control namespace lock ownership changed: ${lock.path}`);
}

export interface ControlNamespaceLockOptions {
  targetRoot: string;
  pmId: string;
  controlRoot?: string;
  runtimeRoot?: string;
  /** Import/bootstrap only: permit a not-yet-created PM/control namespace. */
  allowMissingControl?: boolean;
}

export interface PlannedControlWrite {
  path: string;
  source: string | null;
}

export interface ControlMutationPlan {
  writes: PlannedControlWrite[];
  entity?: string | null;
  summary?: string;
}

export interface ControlSemanticChange {
  path: string;
  operation: "create" | "update" | "delete";
  before: string | null;
  after: string | null;
}

export interface ControlTransactionResult {
  status: "committed" | "dry_run";
  control_revision_before: string;
  control_revision_after: string;
  changes: ControlSemanticChange[];
  entity: string | null;
  entity_revision_after: number | null;
  diagnostic: DiagnosticWriteResult;
}

export interface ControlFilePlanSnapshot<TState> {
  state: TState;
  revision: string;
  sourceDigest: string;
  entityRevision?(id: string): number | null;
}

export interface ControlFilePlanCallbacks<TState> {
  load(options: {
    targetRoot: string;
    pmId: string;
    controlRoot: string;
    runtimeRoot: string;
    now: Date;
  }): ControlFilePlanSnapshot<TState>;
  /** Repair-only preload. Staged and final snapshots always use strict `load`. */
  loadBefore?(options: {
    targetRoot: string;
    pmId: string;
    controlRoot: string;
    runtimeRoot: string;
    now: Date;
  }): ControlFilePlanSnapshot<TState>;
  normalizePath(path: string): string;
}

export interface ControlFilePlanTransactionOptions<TState> {
  targetRoot: string;
  pmId: string;
  controlRoot?: string;
  runtimeRoot?: string;
  expectedControlRevision?: string;
  expectedSourceDigest?: string;
  expectedEntityRevisions?: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
  dryRun?: boolean;
  now?: () => Date;
  agent: string;
  sessionId: string;
  command: string;
  namespaceLock?: NamespaceLock;
  callbacks: ControlFilePlanCallbacks<TState>;
  mutate(context: { state: TState; now: string }): ControlMutationPlan;
  hooks?: {
    afterStageWrite?(path: string): void;
    afterAtomicReplace?(path: string, index: number): void;
  };
}


const CONTROL_PATHS = [
  /^control\.toml$/,
  /^focus\.json$/,
  /^operations\/quality_gates\.json$/,
  /^work_items\/open\/W-\d+\.json$/,
  /^work_items\/closed\/\d{4}\/W-\d+\.json$/,
  /^risks\/open\/R-\d+\.json$/,
  /^risks\/closed\/\d{4}\/R-\d+\.json$/,
  /^decisions\/DEC-\d+(?:-[A-Za-z0-9._-]+)?\.md$/,
  /^milestones\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
  /^blueprints\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
  /^reports\/(?:gates|merge|reviews)\/W-\d+\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
] as const;

function controlPath(path: string): string {
  const safe = assertSafeRelativePath(path);
  if (!CONTROL_PATHS.some((pattern) => pattern.test(safe))) throw new ControlTransactionError("control-path-forbidden", `mutation path is not canonical: ${path}`);
  return safe;
}

function realDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new ControlTransactionError("control-root-missing", `${label} does not exist: ${path}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ControlTransactionError("control-symlink-forbidden", `${label} must be a real directory: ${path}`);
}

/**
 * Resolve the namespace used by every Control writer before taking the
 * namespace lock. Import/bootstrap may resolve a missing control directory,
 * but still shares the exact runtime lock path used by normal transactions.
 * This function performs no writes; acquireNamespaceLock creates only runtime
 * lock directories.
 */
export function resolveControlNamespaceForLock(options: ControlNamespaceLockOptions): ControlNamespacePaths {
  assertSafePmId(options.pmId);
  const targetRoot = resolve(options.targetRoot);
  realDirectory(targetRoot, "target root");
  assertSafeFilesystemPath(targetRoot, "target root");
  const defaultPmRoot = join(targetRoot, "__garelier", options.pmId);
  const controlRoot = resolve(options.controlRoot ?? join(defaultPmRoot, "control"));
  if (basename(controlRoot) !== "control") throw new ControlTransactionError("control-root-invalid", `control root must end in /control: ${controlRoot}`);
  const pmRoot = options.controlRoot ? dirname(controlRoot) : defaultPmRoot;
  if (basename(pmRoot) !== options.pmId) throw new ControlTransactionError("control-pm-root-mismatch", `control root is not in the ${options.pmId} namespace: ${controlRoot}`);
  if (existsSync(pmRoot)) realDirectory(pmRoot, "PM namespace");
  else if (!options.allowMissingControl) throw new ControlTransactionError("control-root-missing", `PM namespace does not exist: ${pmRoot}`);
  assertSafeFilesystemPath(pmRoot, "PM namespace", !options.allowMissingControl);
  if (options.controlRoot) assertNoSymlinkPath(dirname(pmRoot), pmRoot);
  else assertNoSymlinkPath(targetRoot, pmRoot);
  if (existsSync(controlRoot)) realDirectory(controlRoot, "control root");
  else if (!options.allowMissingControl) throw new ControlTransactionError("control-root-missing", `control root does not exist: ${controlRoot}`);
  assertSafeFilesystemPath(controlRoot, "control root", !options.allowMissingControl);
  assertNoSymlinkPath(dirname(controlRoot), controlRoot);
  const runtimeRoot = resolve(options.runtimeRoot ?? join(pmRoot, "runtime", "control"));
  assertSafeFilesystemPath(runtimeRoot, "control runtime root", false);
  const runtimeRel = relative(pmRoot, runtimeRoot);
  const runtimeInsidePm = runtimeRel === "" || (!runtimeRel.startsWith("..") && !isAbsolute(runtimeRel));
  if (!options.runtimeRoot || runtimeInsidePm) {
    assertPathInside(pmRoot, runtimeRoot);
  } else {
    const runtimeParent = dirname(runtimeRoot);
    realDirectory(runtimeParent, "runtime parent");
    assertNoSymlinkPath(runtimeParent, runtimeRoot, false);
  }
  return { targetRoot, pmRoot, controlRoot, runtimeRoot };
}

export function resolveControlNamespace(options: Pick<ControlNamespaceLockOptions, "targetRoot" | "pmId" | "controlRoot" | "runtimeRoot">): ControlNamespacePaths {
  return resolveControlNamespaceForLock(options);
}

interface CanonicalNamespaceLockOwner {
  token: string;
  session_id: string;
  operation: string;
  pid: number;
  hostname: string;
}

interface NamespaceLockSnapshot {
  source: string;
  owner: CanonicalNamespaceLockOwner;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readNamespaceLockSnapshot(path: string): NamespaceLockSnapshot | null {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 4096) return null;
    const source = readFileSync(path, "utf8");
    const value = JSON.parse(source) as Partial<CanonicalNamespaceLockOwner> | null;
    if (!value || typeof value !== "object"
      || typeof value.token !== "string" || !UUID_PATTERN.test(value.token)
      || typeof value.session_id !== "string" || !value.session_id.trim()
      || typeof value.operation !== "string" || !value.operation.trim()
      || !Number.isSafeInteger(value.pid) || value.pid! < 1
      || typeof value.hostname !== "string" || !value.hostname.trim()) return null;
    return {
      source,
      owner: {
        token: value.token,
        session_id: value.session_id,
        operation: value.operation,
        pid: value.pid!,
        hostname: value.hostname,
      },
    };
  } catch {
    return null;
  }
}

function namespaceLockOwnerMatches(left: CanonicalNamespaceLockOwner, right: CanonicalNamespaceLockOwner): boolean {
  return left.token === right.token
    && left.session_id === right.session_id
    && left.operation === right.operation
    && left.pid === right.pid
    && left.hostname === right.hostname;
}

function pidDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function writeNamespaceLockRecoveryDiagnostic(
  paths: ControlNamespacePaths,
  owner: { sessionId: string; operation: string; at: string },
  recovered: boolean,
): void {
  writeControlDiagnostic(paths.runtimeRoot, {
    schema_version: 1,
    operation: "transaction",
    status: recovered ? "ok" : "error",
    pm_id: basename(paths.pmRoot),
    session_id: owner.sessionId,
    at: owner.at,
    control_revision: null,
    entity: null,
    changed_paths: [],
    reason: recovered ? "namespace lock dead-owner recovered" : "namespace lock unsafe-to-reclaim",
    error: recovered ? null : { name: "ControlLockError", message: "namespace lock unsafe-to-reclaim" },
  });
}

function reclaimDeadRecoveryLease(path: string): boolean {
  const observed = readNamespaceLockSnapshot(path);
  if (!observed || observed.owner.hostname !== hostname() || !pidDefinitelyDead(observed.owner.pid)) return false;
  const stable = readNamespaceLockSnapshot(path);
  if (!stable || stable.source !== observed.source || !namespaceLockOwnerMatches(stable.owner, observed.owner)
    || stable.owner.hostname !== hostname() || !pidDefinitelyDead(stable.owner.pid)) return false;

  const claimedPath = `${path}.${randomUUID()}.reclaiming`;
  let claimed = false;
  try {
    renameSync(path, claimedPath);
    claimed = true;
    const moved = readNamespaceLockSnapshot(claimedPath);
    if (!moved || moved.source !== stable.source || !namespaceLockOwnerMatches(moved.owner, stable.owner)) {
      if (!existsSync(path)) {
        renameSync(claimedPath, path);
        claimed = false;
      }
      return false;
    }
    rmSync(claimedPath);
    claimed = false;
    return true;
  } catch {
    if (claimed && existsSync(claimedPath) && !existsSync(path)) {
      try { renameSync(claimedPath, path); } catch { /* retain the claimed entry for recovery */ }
    }
    return false;
  }
}

function acquireRecoveryLease(
  path: string,
  owner: { sessionId: string; operation: string; at: string },
): { release(): void } | null {
  const token = randomUUID();
  const source = JSON.stringify({
    token,
    session_id: owner.sessionId,
    operation: `namespace-lock-recovery:${owner.operation}`,
    acquired_at: owner.at,
    pid: process.pid,
    hostname: hostname(),
  });
  const publish = (): "created" | "exists" | "failed" => {
    const candidate = `${path}.${token}.candidate`;
    let descriptor: number | null = null;
    let candidateOwned = false;
    try {
      descriptor = openSync(candidate, "wx", 0o600);
      candidateOwned = true;
      writeFileSync(descriptor, source, "utf8");
      closeSync(descriptor);
      descriptor = null;
    } catch {
      if (descriptor !== null) closeSync(descriptor);
      try { if (candidateOwned && existsSync(candidate)) rmSync(candidate); } catch { /* owned candidate cleanup is best-effort */ }
      return "failed";
    }
    try {
      linkSync(candidate, path);
      return "created";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed";
    } finally {
      try { if (candidateOwned && existsSync(candidate)) rmSync(candidate); } catch { /* an orphan candidate never blocks the deterministic lease */ }
    }
  };

  const initial = publish();
  if (initial === "failed" || (initial === "exists" && (!reclaimDeadRecoveryLease(path) || publish() !== "created"))) return null;
  return {
    release(): void {
      const current = readNamespaceLockSnapshot(path);
      if (current?.owner.token === token) rmSync(path);
    },
  };
}

function reclaimDeadNamespaceLock(
  paths: ControlNamespacePaths,
  owner: { sessionId: string; operation: string; at: string },
  path: string,
): boolean {
  const observed = readNamespaceLockSnapshot(path);
  if (!observed || observed.owner.hostname !== hostname() || !pidDefinitelyDead(observed.owner.pid)) {
    writeNamespaceLockRecoveryDiagnostic(paths, owner, false);
    return false;
  }

  const recoveryPath = join(dirname(path), ".namespace.lock.recovery");
  const recoveryLease = acquireRecoveryLease(recoveryPath, owner);
  if (!recoveryLease) {
    writeNamespaceLockRecoveryDiagnostic(paths, owner, false);
    return false;
  }

  const claimedPath = join(dirname(path), `.namespace.lock.${randomUUID()}.reclaiming`);
  let claimed = false;
  try {
    const stable = readNamespaceLockSnapshot(path);
    if (!stable || stable.source !== observed.source || !namespaceLockOwnerMatches(stable.owner, observed.owner)
      || stable.owner.hostname !== hostname() || !pidDefinitelyDead(stable.owner.pid)) {
      writeNamespaceLockRecoveryDiagnostic(paths, owner, false);
      return false;
    }

    renameSync(path, claimedPath);
    claimed = true;
    const moved = readNamespaceLockSnapshot(claimedPath);
    if (!moved || moved.source !== stable.source || !namespaceLockOwnerMatches(moved.owner, stable.owner)) {
      if (!existsSync(path)) {
        renameSync(claimedPath, path);
        claimed = false;
      }
      writeNamespaceLockRecoveryDiagnostic(paths, owner, false);
      return false;
    }
    rmSync(claimedPath);
    claimed = false;
    writeNamespaceLockRecoveryDiagnostic(paths, owner, true);
    return true;
  } catch {
    if (claimed && existsSync(claimedPath) && !existsSync(path)) {
      try {
        renameSync(claimedPath, path);
        claimed = false;
      } catch {
        // Keep the claimed entry for recovery; never delete an unverified replacement.
      }
    }
    writeNamespaceLockRecoveryDiagnostic(paths, owner, false);
    return false;
  } finally {
    recoveryLease.release();
  }
}

function createNamespaceLockToken(paths: ControlNamespacePaths, owner: { sessionId: string; operation: string; at: string }, token: string): NamespaceLock {
  if (existsSync(paths.pmRoot)) {
    realDirectory(paths.pmRoot, "PM namespace");
    assertNoSymlinkPath(dirname(paths.pmRoot), paths.pmRoot);
  } else {
    assertNoSymlinkPath(dirname(paths.pmRoot), paths.pmRoot, false);
  }
  const lockDirectory = join(paths.runtimeRoot, "locks");
  ensureSafeDirectory(paths.runtimeRoot, lockDirectory);
  const path = join(lockDirectory, "namespace.lock");
  assertNoSymlinkPath(paths.runtimeRoot, path, false);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify({ token, session_id: owner.sessionId, operation: owner.operation, acquired_at: owner.at, pid: process.pid, hostname: hostname() }), "utf8");
    closeSync(descriptor);
    descriptor = null;
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new ControlLockError(`control namespace is locked: ${path}`, error);
    throw new ControlTransactionError("control-lock-failed", `could not acquire control namespace lock: ${(error as Error).message}`, error);
  }
  return {
    path,
    token,
    release(): void {
      try {
        const current = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
        if (current.token !== token) throw new ControlTransactionError("control-lock-changed", `control namespace lock ownership changed: ${path}`);
        rmSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    },
  };
}

/**
 * W-667 F-7 — name the HOLDER, not just the lock path.
 *
 * "control namespace is locked and unsafe-to-reclaim: <path>" told the operator
 * that something held the lock and nothing about what, so a `dispatch_cleanup
 * --sweep` that could not run left eleven stale containers standing while the
 * PM guessed. The lock file has carried session_id / operation / pid / hostname
 * since it was written; this only reads them back. Reporting only — the lock is
 * never taken, waited on, or released on the holder's behalf.
 */
export function describeNamespaceLockHolder(path: string, requesterSessionId: string): string {
  const snapshot = readNamespaceLockSnapshot(path);
  if (!snapshot) return " — the lock file is unreadable or malformed; inspect it by hand before removing it";
  const { session_id: sessionId, operation, pid, hostname: host } = snapshot.owner;
  const sameHost = host === hostname();
  const live = sameHost && processAlive(pid);
  const who = `held by operation '${operation}' of Control session ${sessionId} (pid ${pid} on ${host})`;
  if (sessionId === requesterSessionId) {
    return ` — ${who}, which is YOUR OWN session: finish or close that operation first, then rerun this one`;
  }
  if (live) return ` — ${who}; that process is still running, so wait for it to finish and rerun`;
  if (!sameHost) return ` — ${who}; this host cannot tell whether that process is alive, so confirm on ${host} before acting`;
  return ` — ${who}; that pid is gone but the lock was not reclaimable, so inspect ${path} by hand`;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function acquireNamespaceLockToken(paths: ControlNamespacePaths, owner: { sessionId: string; operation: string; at: string }, token: string): NamespaceLock {
  try {
    return createNamespaceLockToken(paths, owner, token);
  } catch (error) {
    if (!(error instanceof ControlLockError)) throw error;
    const path = join(paths.runtimeRoot, "locks", "namespace.lock");
    if (!reclaimDeadNamespaceLock(paths, owner, path)) {
      throw new ControlLockError(`control namespace is locked and unsafe-to-reclaim: ${path}${describeNamespaceLockHolder(path, owner.sessionId)}`, error);
    }
    return createNamespaceLockToken(paths, owner, token);
  }
}

export function acquireNamespaceLock(paths: ControlNamespacePaths, owner: { sessionId: string; operation: string; at: string }): NamespaceLock {
  return acquireNamespaceLockToken(paths, owner, randomUUID());
}

/** Recovery-only: the append-only epoch owner must pre-bind this token before wx acquisition. */
export function acquireNamespaceLockWithToken(paths: ControlNamespacePaths, owner: { sessionId: string; operation: string; at: string }, token: string): NamespaceLock {
  if (!UUID_PATTERN.test(token)) throw new ControlTransactionError("control-lock-token-invalid", "explicit namespace lock token must be a UUID");
  return acquireNamespaceLockToken(paths, owner, token);
}

export function withNamespaceLock<T>(paths: ControlNamespacePaths, owner: { sessionId: string; operation: string; at: string }, callback: () => T): T {
  const lock = acquireNamespaceLock(paths, owner);
  try { return callback(); } finally { lock.release(); }
}

function copyTree(source: string, destination: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new ControlTransactionError("control-symlink-forbidden", `control tree contains a symlink: ${from}`);
    if (entry.isDirectory()) { mkdirSync(to); copyTree(from, to); }
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new ControlTransactionError("control-file-type-forbidden", `control tree contains a non-regular entry: ${from}`);
  }
}

function expectedEntries(
  value: ControlFilePlanTransactionOptions<unknown>["expectedEntityRevisions"],
): [string, number][] {
  if (!value) return [];
  return value instanceof Map ? [...value.entries()] : Object.entries(value);
}

function applyPlan(
  stagingRoot: string,
  controlRoot: string,
  writes: PlannedControlWrite[],
  hook?: (path: string) => void,
  normalizePath: (path: string) => string = controlPath,
): ControlSemanticChange[] {
  const seen = new Set<string>();
  const changes: ControlSemanticChange[] = [];
  for (const write of writes) {
    const path = normalizePath(write.path);
    if (seen.has(path)) {
      throw new ControlTransactionError("control-path-duplicate", `mutation path appears more than once: ${path}`);
    }
    seen.add(path);
    const canonical = join(controlRoot, path);
    const staged = join(stagingRoot, path);
    assertPathInside(stagingRoot, staged);
    assertNoSymlinkPath(controlRoot, canonical, false);
    if (existsSync(canonical) && (lstatSync(canonical).isSymbolicLink() || !lstatSync(canonical).isFile())) {
      throw new ControlTransactionError("control-file-type-forbidden", `canonical target is not a regular file: ${path}`);
    }
    const beforeSource = existsSync(canonical) ? readFileSync(canonical) : null;
    const before = beforeSource === null ? null : sha256(beforeSource);
    if (write.source === null) {
      if (existsSync(staged)) rmSync(staged);
    } else {
      mkdirSync(dirname(staged), { recursive: true });
      assertNoSymlinkPath(stagingRoot, staged, false);
      writeFileSync(staged, write.source, "utf8");
    }
    hook?.(path);
    const after = write.source === null ? null : sha256(write.source);
    if (before === after) continue;
    changes.push({ path, operation: before === null ? "create" : after === null ? "delete" : "update", before, after });
  }
  return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}






interface Replacement { path: string; target: string; backup: string; installed: boolean; hadOriginal: boolean }
interface ReplacementBatch { rollback(): void }

function replaceAtomically(controlRoot: string, stagingRoot: string, changes: ControlSemanticChange[], hook?: (path: string, index: number) => void): ReplacementBatch {
  const backupRoot = join(stagingRoot, ".transaction-backup");
  mkdirSync(backupRoot);
  const replacements: Replacement[] = [];
  const rollback = (): void => {
    for (const replacement of [...replacements].reverse()) {
      if (replacement.installed && existsSync(replacement.target)) rmSync(replacement.target, { force: true });
      if (replacement.hadOriginal) {
        if (!existsSync(replacement.backup)) throw new ControlTransactionError("control-rollback-failed", `rollback backup is missing: ${replacement.path}`);
        mkdirSync(dirname(replacement.target), { recursive: true });
        renameSync(replacement.backup, replacement.target);
      }
    }
  };
  try {
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index]!;
      const target = join(controlRoot, change.path);
      const staged = join(stagingRoot, change.path);
      const backup = join(backupRoot, change.path);
      assertNoSymlinkPath(controlRoot, target, false);
      mkdirSync(dirname(target), { recursive: true });
      const hadOriginal = existsSync(target);
      const replacement: Replacement = { path: change.path, target, backup, installed: false, hadOriginal };
      replacements.push(replacement);
      if (hadOriginal) {
        mkdirSync(dirname(backup), { recursive: true });
        renameSync(target, backup);
      }
      if (change.operation !== "delete") {
        renameSync(staged, target);
        replacement.installed = true;
      }
      hook?.(change.path, index);
    }
  } catch (error) {
    try { rollback(); }
    catch { throw new ControlTransactionError("control-rollback-failed", "rollback failed; manual repair is required", error); }
    throw new ControlTransactionError("control-atomic-replace-failed", `atomic replace failed and was rolled back: ${(error as Error).message}`, error);
  }
  return { rollback };
}



export function controlTreeSourceDigest(controlRoot: string, limits: { files?: number; bytes?: number; fileBytes?: number } = {}): string {
  const root = resolve(controlRoot);
  const maxFiles = limits.files ?? 16_384;
  const maxBytes = limits.bytes ?? 128 * 1024 * 1024;
  const maxFileBytes = limits.fileBytes ?? 16 * 1024 * 1024;
  const entries: Array<{ path: string; hash: string; bytes: number }> = [];
  let bytes = 0;
  const visit = (directory: string): void => {
    assertNoSymlinkPath(root, directory);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      assertPathInside(root, path);
      if (entry.isSymbolicLink()) throw new ControlTransactionError("control-symlink-forbidden", `control tree contains a symlink: ${path}`);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) throw new ControlTransactionError("control-file-type-forbidden", `control tree contains a non-regular entry: ${path}`);
      const info = lstatSync(path);
      if (info.size > maxFileBytes) throw new ControlTransactionError("control-file-too-large", `control file exceeds ${maxFileBytes} bytes: ${path}`);
      bytes += info.size;
      if (bytes > maxBytes) throw new ControlTransactionError("control-tree-too-large", `control tree exceeds ${maxBytes} bytes`);
      if (entries.length >= maxFiles) throw new ControlTransactionError("control-file-count", `control tree exceeds ${maxFiles} files`);
      const source = readFileSync(path);
      entries.push({
        path: relative(root, path).replaceAll("\\", "/"),
        hash: sha256(source),
        bytes: source.length,
      });
    }
  };
  realDirectory(root, "control root");
  visit(root);
  return sha256(entries
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.path}\0${entry.hash}\0${entry.bytes}\n`)
    .join(""));
}

function assertFilePlanSnapshot<TState>(snapshot: ControlFilePlanSnapshot<TState>): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(snapshot.revision) || !/^sha256:[0-9a-f]{64}$/.test(snapshot.sourceDigest)) {
    throw new ControlTransactionError("control-snapshot-invalid", "file-plan callback revisions and source digests must be sha256 digests");
  }
}

function verifyFilePlanPreconditions<TState>(
  snapshot: ControlFilePlanSnapshot<TState>,
  options: ControlFilePlanTransactionOptions<TState>,
): void {
  assertFilePlanSnapshot(snapshot);
  if (options.expectedControlRevision && options.expectedControlRevision !== snapshot.revision) {
    throw new ControlTransactionError("control-revision-stale", `expected control revision ${options.expectedControlRevision}, found ${snapshot.revision}`);
  }
  if (options.expectedSourceDigest && options.expectedSourceDigest !== snapshot.sourceDigest) {
    throw new ControlTransactionError("control-source-digest-stale", `expected control source digest ${options.expectedSourceDigest}, found ${snapshot.sourceDigest}`);
  }
  for (const [id, expected] of expectedEntries(options.expectedEntityRevisions)) {
    if (!Number.isInteger(expected) || expected < 1) throw new ControlTransactionError("entity-revision-invalid", `expected revision for ${id} must be a positive integer`);
    const actual = snapshot.entityRevision?.(id) ?? null;
    if (actual === null) throw new ControlTransactionError("entity-not-found", `entity does not exist: ${id}`);
    if (actual !== expected) throw new ControlTransactionError("entity-revision-stale", `expected ${id} revision ${expected}, found ${actual}`);
  }
}

function assertBindingUnchanged(before: CanonicalControlBinding, controlRoot: string): void {
  const after = readCanonicalControlBinding(controlRoot);
  if (before.controlSchemaVersion !== after.controlSchemaVersion || before.storage !== after.storage) {
    throw new ControlTransactionError(
      "control-binding-changed",
      `file-plan transaction cannot change canonical binding ${before.controlSchemaVersion}/${before.storage} -> ${after.controlSchemaVersion}/${after.storage}`,
    );
  }
}

/**
 * Parser-independent transaction runner for schema-adaptive canonical trees.
 * The caller owns parsing and strict validation through callbacks; this layer
 * owns locking, CAS preconditions, same-filesystem staging, generation
 * journaling, replacement rollback, and crash recovery metadata.
 */
export function runControlFilePlanTransaction<TState>(options: ControlFilePlanTransactionOptions<TState>): ControlTransactionResult {
  const paths = resolveControlNamespace(options);
  const nowDate = options.now?.() ?? new Date();
  const at = nowDate.toISOString();
  const binding = readCanonicalControlBinding(paths.controlRoot);
  let lock: NamespaceLock | null = null;
  let generation: ControlGenerationLease | null = null;
  let recoveryGeneration: number | null = null;
  let canonicalResolved = false;
  let stagingRoot: string | null = null;
  let beforeRevision: string | null = null;
  let entity: string | null = null;
  let changes: ControlSemanticChange[] = [];
  let diagnosticError: Error | null = null;
  const normalizePath = (path: string): string => assertSafeRelativePath(options.callbacks.normalizePath(path));
  try {
    lock = options.namespaceLock ?? acquireNamespaceLock(paths, { sessionId: options.sessionId, operation: options.command, at });
    assertNamespaceLock(paths, lock);
    const loadBefore = options.callbacks.loadBefore ?? options.callbacks.load;
    const before = loadBefore({
      targetRoot: paths.targetRoot,
      pmId: options.pmId,
      controlRoot: paths.controlRoot,
      runtimeRoot: paths.runtimeRoot,
      now: nowDate,
    });
    beforeRevision = before.revision;
    if (before.sourceDigest !== controlTreeSourceDigest(paths.controlRoot)) {
      throw new ControlTransactionError("control-source-digest-contract", "file-plan callback sourceDigest must use controlTreeSourceDigest for crash recovery");
    }
    verifyFilePlanPreconditions(before, options);
    const plan = options.mutate({ state: before.state, now: at });
    entity = plan.entity ?? null;
    stagingRoot = mkdtempSync(join(dirname(paths.controlRoot), `.${basename(paths.controlRoot)}.txn-`));
    if (statSync(dirname(paths.controlRoot)).dev !== statSync(stagingRoot).dev) throw new ControlTransactionError("control-staging-filesystem-mismatch", "transaction staging must be on the control filesystem");
    copyTree(paths.controlRoot, stagingRoot);
    changes = applyPlan(stagingRoot, paths.controlRoot, plan.writes, options.hooks?.afterStageWrite, normalizePath);
    assertBindingUnchanged(binding, stagingRoot);
    const staged = options.callbacks.load({
      targetRoot: paths.targetRoot,
      pmId: options.pmId,
      controlRoot: stagingRoot,
      runtimeRoot: paths.runtimeRoot,
      now: nowDate,
    });
    assertFilePlanSnapshot(staged);
    if (staged.sourceDigest !== controlTreeSourceDigest(stagingRoot)) {
      throw new ControlTransactionError("control-source-digest-contract", "staged file-plan callback sourceDigest must use controlTreeSourceDigest");
    }
    const current = loadBefore({
      targetRoot: paths.targetRoot,
      pmId: options.pmId,
      controlRoot: paths.controlRoot,
      runtimeRoot: paths.runtimeRoot,
      now: nowDate,
    });
    assertFilePlanSnapshot(current);
    if (current.revision !== before.revision) throw new ControlTransactionError("control-revision-changed", "control revision changed while the transaction lock was held");
    if (current.sourceDigest !== before.sourceDigest) throw new ControlTransactionError("control-source-changed", "control source bytes changed while the transaction lock was held");
    assertBindingUnchanged(binding, paths.controlRoot);
    if (options.dryRun) {
      const diagnostic = writeControlDiagnostic(paths.runtimeRoot, {
        schema_version: 1, operation: "transaction", status: "dry_run", pm_id: options.pmId, session_id: options.sessionId,
        at, control_revision: staged.revision, entity, changed_paths: changes.map((change) => change.path), reason: plan.summary ?? null, error: null,
      });
      return {
        status: "dry_run",
        control_revision_before: before.revision,
        control_revision_after: staged.revision,
        changes,
        entity,
        entity_revision_after: entity ? staged.entityRevision?.(entity) ?? null : null,
        diagnostic,
      };
    }
    if (changes.length) {
      recoveryGeneration = readControlGeneration(paths.runtimeRoot, 16, paths.controlRoot) + 1;
      writeGenerationRecoveryJournal({
        paths,
        pmId: options.pmId,
        lock,
        generation: recoveryGeneration,
        operation: options.command,
        sessionId: options.sessionId,
        at,
        stagingRoot,
        beforeRevision: before.revision,
        beforeSourceDigest: before.sourceDigest,
        afterRevision: staged.revision,
        afterSourceDigest: staged.sourceDigest,
        changes,
        controlBinding: binding,
        sourceDigestKind: "canonical_tree_v1",
      });
      try { generation = beginControlGeneration(paths, { sessionId: options.sessionId, operation: options.command, at }); }
      catch (error) { removeGenerationRecoveryJournal(paths, recoveryGeneration); recoveryGeneration = null; throw error; }
    }
    const replacement = replaceAtomically(paths.controlRoot, stagingRoot, changes, options.hooks?.afterAtomicReplace);
    let final: ControlFilePlanSnapshot<TState>;
    try {
      assertBindingUnchanged(binding, paths.controlRoot);
      final = options.callbacks.load({
        targetRoot: paths.targetRoot,
        pmId: options.pmId,
        controlRoot: paths.controlRoot,
        runtimeRoot: paths.runtimeRoot,
        now: nowDate,
      });
      assertFilePlanSnapshot(final);
    } catch (error) {
      try { replacement.rollback(); }
      catch { throw new ControlTransactionError("control-rollback-failed", "final reload failed and rollback also failed; manual repair is required", error); }
      throw new ControlTransactionError("control-final-reload-failed", `final strict reload failed: ${(error as Error).message}`, error);
    }
    if (final.revision !== staged.revision || final.sourceDigest !== staged.sourceDigest) {
      try { replacement.rollback(); }
      catch (error) { throw new ControlTransactionError("control-rollback-failed", "snapshot mismatch rollback failed; manual repair is required", error); }
      throw new ControlTransactionError("control-final-revision-mismatch", "final control snapshot differs from the staged snapshot");
    }
    canonicalResolved = true;
    generation?.settle();
    if (recoveryGeneration !== null) removeGenerationRecoveryJournal(paths, recoveryGeneration);
    const diagnostic = writeControlDiagnostic(paths.runtimeRoot, {
      schema_version: 1, operation: "transaction", status: "ok", pm_id: options.pmId, session_id: options.sessionId,
      at, control_revision: final.revision, entity, changed_paths: changes.map((change) => change.path), reason: plan.summary ?? null, error: null,
    });
    return {
      status: "committed",
      control_revision_before: before.revision,
      control_revision_after: final.revision,
      changes,
      entity,
      entity_revision_after: entity ? final.entityRevision?.(entity) ?? null : null,
      diagnostic,
    };
  } catch (error) {
    if (generation && error instanceof ControlTransactionError && [
      "control-atomic-replace-failed", "control-final-reload-failed", "control-final-revision-mismatch",
    ].includes(error.code)) canonicalResolved = true;
    diagnosticError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    if (diagnosticError) writeControlDiagnostic(paths.runtimeRoot, {
      schema_version: 1, operation: "transaction", status: "error", pm_id: options.pmId, session_id: options.sessionId,
      at, control_revision: beforeRevision, entity, changed_paths: changes.map((change) => change.path), reason: null,
      error: { name: diagnosticError.name, message: diagnosticError.message },
    });
    if (stagingRoot && existsSync(stagingRoot) && !(generation && !canonicalResolved)) {
      // `stagingRoot` is the exact mkdtemp result owned by this invocation.
      // The stable, validated PM namespace is the fence; a reparse replacement
      // still resolves outside it and is refused by removeTreeSync.
      removeTreeSync(stagingRoot, { fenceRoots: [paths.pmRoot] });
    }
    try {
      if (canonicalResolved) {
        generation?.settle();
        if (recoveryGeneration !== null) removeGenerationRecoveryJournal(paths, recoveryGeneration);
      }
    } finally { if (!options.namespaceLock) lock?.release(); }
  }
}
