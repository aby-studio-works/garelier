import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { renameSync, rmSync } from "../guard/path_guard.ts";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { assertNoSymlinkPath, assertPathInside, assertSafeIdentifier, assertSafeRelativePath, atomicWriteRuntimeFile, writeControlDiagnostic } from "./diagnostics.ts";
import {
  readCanonicalControlBinding,
  readControlGeneration,
  readControlGenerationSnapshot,
  reinitializeMissingControlGeneration,
  writeControlGenerationFile,
  type CanonicalControlBinding,
  type ControlGenerationSnapshot,
} from "./generation.ts";
import { canonicalJson, sha256 } from "./serialization.ts";
import { assertSafePmId } from "./roots.ts";
import {
  acquireNamespaceLockWithToken,
  acquireNamespaceLock,
  assertNamespaceLock,
  controlTreeSourceDigest,
  resolveControlNamespace,
  type ControlNamespacePaths,
  type ControlSemanticChange,
  type NamespaceLock,
} from "./transaction.ts";

export function recoverMissingControlGeneration(options: RecoveryPaths & { sessionId: string }): ControlGenerationSnapshot {
  const paths = resolveControlNamespace(options);
  const at = new Date().toISOString();
  const lock = acquireNamespaceLock(paths, { sessionId: options.sessionId, operation: "generation-recovery-reinitialize", at });
  try {
    assertNamespaceLock(paths, lock);
    const binding = readCanonicalControlBinding(paths.controlRoot);
    if (!options.validateCanonical) throw new Error("schema-3 generation recovery requires a strict canonical validation callback");
    options.validateCanonical(paths.controlRoot);
    return reinitializeMissingControlGeneration(paths, { sessionId: options.sessionId, at });
  } finally { lock.release(); }
}

export interface GenerationRecoveryJournal {
  schema_version: 1;
  kind: "garelier_control_generation_recovery";
  state: "prepared";
  generation: number;
  settle_generation: number;
  pm_id: string;
  operation: string;
  session_id: string;
  owner_token: string;
  control_schema_version?: 3;
  storage?: "plan_graph_markdown";
  source_digest_kind?: "canonical_tree_v1";
  created_at: string;
  staging_directory: string;
  backup_directory: ".transaction-backup";
  before: { revision: string; source_digest: string };
  after: { revision: string; source_digest: string };
  changes: ControlSemanticChange[];
  journal_hash: string;
}

export interface GenerationRecoveryPlan {
  schema_version: 1;
  kind: "garelier_control_generation_recovery_plan";
  pm_id: string;
  generation: number;
  journal_generation: number;
  journal_hash: string;
  control_schema_version?: 3;
  storage?: "plan_graph_markdown";
  canonical_state: "before" | "after";
  action: "abandon_prepared" | "settle_rolled_back" | "settle_committed" | "finalize_settled";
  control_revision: string;
  source_digest: string;
  plan_digest: string;
}

interface RecoveryPaths {
  targetRoot: string; pmId: string; controlRoot?: string; runtimeRoot?: string;
  validateCanonical?(controlRoot: string): void;
  hooks?: {
    afterRecoveryEpochAcquire?(): void;
    beforeRecoveryMutexRelease?(): void;
    beforeStagingRemoval?(): void;
    afterRecoveryReleaseTempOpen?(path: string): void;
    afterRecoveryReleaseTempWrite?(path: string): void;
    afterRecoveryReleaseRename?(path: string): void;
    afterRecoveryEpochPruneRename?(path: string): void;
    recoveryEpochEntryCap?: number;
  };
}

function journalDirectory(paths: ControlNamespacePaths): string { return join(paths.runtimeRoot, "recovery"); }
function journalPath(paths: ControlNamespacePaths, generation: number): string { return join(journalDirectory(paths), `generation-${generation}.json`); }
function journalPayload(value: Omit<GenerationRecoveryJournal, "journal_hash">): string { return canonicalJson(value); }

export function writeGenerationRecoveryJournal(options: {
  paths: ControlNamespacePaths;
  pmId: string;
  lock: NamespaceLock;
  generation: number;
  operation: string;
  sessionId: string;
  at: string;
  stagingRoot: string;
  beforeRevision: string;
  beforeSourceDigest: string;
  afterRevision: string;
  afterSourceDigest: string;
  changes: ControlSemanticChange[];
  controlBinding?: CanonicalControlBinding;
  sourceDigestKind?: "canonical_tree_v1";
}): GenerationRecoveryJournal {
  assertNamespaceLock(options.paths, options.lock);
  if (options.generation % 2 !== 1 || readControlGeneration(options.paths.runtimeRoot) !== options.generation - 1) throw new Error("recovery journal generation precondition failed");
  if (dirname(resolve(options.stagingRoot)) !== dirname(resolve(options.paths.controlRoot)) || !basename(options.stagingRoot).startsWith(`.${basename(options.paths.controlRoot)}.txn-`)) {
    throw new Error("recovery staging identity is outside the canonical control filesystem");
  }
  const binding = options.controlBinding ?? readCanonicalControlBinding(options.paths.controlRoot);
  const payload = {
    schema_version: 1 as const, kind: "garelier_control_generation_recovery" as const,
    state: "prepared" as const, generation: options.generation, settle_generation: options.generation + 1,
    pm_id: options.pmId, operation: options.operation, session_id: options.sessionId,
    owner_token: options.lock.token, created_at: options.at,
    control_schema_version: binding.controlSchemaVersion,
    storage: binding.storage,
    source_digest_kind: options.sourceDigestKind ?? "canonical_tree_v1" as const,
    staging_directory: basename(options.stagingRoot), backup_directory: ".transaction-backup" as const,
    before: { revision: options.beforeRevision, source_digest: options.beforeSourceDigest },
    after: { revision: options.afterRevision, source_digest: options.afterSourceDigest },
    changes: options.changes,
  };
  const journal: GenerationRecoveryJournal = { ...payload, journal_hash: sha256(journalPayload(payload)) };
  atomicWriteRuntimeFile(options.paths.runtimeRoot, journalPath(options.paths, options.generation), canonicalJson(journal));
  return journal;
}

export function removeGenerationRecoveryJournal(paths: ControlNamespacePaths, generation: number): void {
  const directory = journalDirectory(paths);
  const path = journalPath(paths, generation);
  assertPathInside(paths.runtimeRoot, directory);
  assertPathInside(directory, path);
  assertNoSymlinkPath(paths.runtimeRoot, path, existsSync(path));
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) throw new Error(`generation recovery journal removal target is unsafe: ${path}`);
  rmSync(path);
}

function readJournal(paths: ControlNamespacePaths, generation: number): GenerationRecoveryJournal {
  const path = journalPath(paths, generation);
  if (!existsSync(path)) throw new Error(`generation recovery journal is missing: ${path}`);
  assertNoSymlinkPath(paths.runtimeRoot, path);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) throw new Error(`generation recovery journal is unsafe: ${path}`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`generation recovery journal JSON is malformed: ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("generation recovery journal must be an object");
  const value = parsed as GenerationRecoveryJournal;
  const exactKeys = (record: object, allowed: readonly string[], label: string): void => {
    const actual = Object.keys(record).sort();
    const expected = [...allowed].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has unknown or missing fields`);
  };
  const requiredKeys = ["schema_version", "kind", "state", "generation", "settle_generation", "pm_id", "operation", "session_id", "owner_token", "created_at", "staging_directory", "backup_directory", "before", "after", "changes", "journal_hash"];
  const optionalKeys = ["control_schema_version", "storage", "source_digest_kind"];
  const actualKeys = Object.keys(value);
  if (requiredKeys.some((key) => !actualKeys.includes(key)) || actualKeys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))) {
    throw new Error("generation recovery journal has unknown or missing fields");
  }
  const { journal_hash, ...payload } = value;
  if (value.schema_version !== 1 || value.kind !== "garelier_control_generation_recovery" || value.state !== "prepared" || value.generation !== generation
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || value.generation % 2 !== 1
    || value.settle_generation !== generation + 1 || !Number.isSafeInteger(value.settle_generation)
    || typeof value.pm_id !== "string" || typeof value.operation !== "string" || !value.operation
    || typeof value.session_id !== "string" || typeof value.owner_token !== "string" || !value.owner_token
    || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))
    || value.backup_directory !== ".transaction-backup" || !Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 4096
    || typeof journal_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(journal_hash)
    || journal_hash !== sha256(journalPayload(payload))) throw new Error(`generation recovery journal integrity failed: ${path}`);
  assertSafePmId(value.pm_id);
  assertSafeIdentifier(value.operation, "journal operation");
  assertSafeIdentifier(value.session_id, "journal session_id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.owner_token)) throw new Error("generation recovery journal owner token is invalid");
  const hasBinding = value.control_schema_version !== undefined || value.storage !== undefined || value.source_digest_kind !== undefined;
  if (hasBinding && !(value.control_schema_version === 3
    && value.storage === "plan_graph_markdown"
    && value.source_digest_kind === "canonical_tree_v1")) throw new Error("generation recovery journal canonical binding is invalid");
  if (value.control_schema_version === 3 && value.source_digest_kind !== "canonical_tree_v1") {
    throw new Error("schema-3 generation recovery requires canonical_tree_v1 digest binding");
  }
  if (!value.before || typeof value.before !== "object" || Array.isArray(value.before) || !value.after || typeof value.after !== "object" || Array.isArray(value.after)) throw new Error("generation recovery journal snapshots must be objects");
  exactKeys(value.before, ["revision", "source_digest"], "journal before snapshot");
  exactKeys(value.after, ["revision", "source_digest"], "journal after snapshot");
  for (const snapshot of [value.before, value.after]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(snapshot.revision) || !/^sha256:[0-9a-f]{64}$/.test(snapshot.source_digest)) throw new Error("generation recovery snapshot digests are invalid");
  }
  const seen = new Set<string>();
  let previousPath = "";
  for (const change of value.changes) {
    if (!change || typeof change !== "object" || Array.isArray(change)) throw new Error("generation recovery change must be an object");
    exactKeys(change, ["path", "operation", "before", "after"], "generation recovery change");
    const safe = assertSafeRelativePath(change.path);
    if (seen.has(safe)) throw new Error(`duplicate generation recovery change path: ${safe}`);
    if (previousPath && safe <= previousPath) throw new Error("generation recovery changes must be strictly path-sorted");
    seen.add(safe);
    previousPath = safe;
    if (!(["create", "update", "delete"] as const).includes(change.operation)) throw new Error(`invalid generation recovery change operation: ${change.operation}`);
    for (const digest of [change.before, change.after]) if (digest !== null && !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`invalid generation recovery change hash: ${safe}`);
    if ((change.operation === "create") !== (change.before === null) || (change.operation === "delete") !== (change.after === null) || (change.operation === "update" && (change.before === null || change.after === null))) throw new Error(`generation recovery change operation/hash mismatch: ${safe}`);
    if (change.before === change.after) throw new Error(`generation recovery change has identical hashes: ${safe}`);
  }
  if (typeof value.staging_directory !== "string" || value.staging_directory !== basename(value.staging_directory)
    || value.staging_directory.length > 255 || value.staging_directory.includes("\\") || !value.staging_directory.startsWith(`.${basename(paths.controlRoot)}.txn-`)) throw new Error("generation recovery journal has an unsafe staging identity");
  const staging = join(dirname(paths.controlRoot), value.staging_directory);
  assertPathInside(dirname(paths.controlRoot), staging);
  assertNoSymlinkPath(dirname(paths.controlRoot), staging, existsSync(staging));
  if (dirname(resolve(staging)) !== dirname(resolve(paths.controlRoot))) throw new Error("generation recovery journal has an unsafe staging identity");
  return value;
}

function selectJournal(paths: ControlNamespacePaths, generation: number): GenerationRecoveryJournal {
  if (generation % 2 === 1) return readJournal(paths, generation);
  const candidates = [generation - 1, generation + 1].filter((value) => value > 0 && existsSync(journalPath(paths, value)));
  if (candidates.length !== 1) throw new Error(candidates.length ? "multiple recovery journals make the generation state ambiguous" : "no prepared/settled generation recovery journal exists");
  return readJournal(paths, candidates[0]!);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

interface RecoveryEpochOwner {
  schema_version: 1; kind: "garelier_recovery_epoch_owner"; epoch: number; token: string;
  pm_id: string; journal_generation: number; journal_hash: string; operation: string;
  planned_namespace_token: string; inherited_namespace_token: string | null;
  pid: number; hostname: string; acquired_at: string;
}

interface RecoveryEpochRelease {
  schema_version: 1; kind: "garelier_recovery_epoch_release"; epoch: number; token: string;
  pm_id: string; journal_generation: number; journal_hash: string; operation: string;
  result: "succeeded" | "failed"; released_at: string;
}

interface RecoveryEpochLease {
  owner: RecoveryEpochOwner;
  inheritedNamespaceToken: string | null;
  prunePrevious(): void;
  release(result: RecoveryEpochRelease["result"]): void;
}

interface RecoveryNamespaceLock extends NamespaceLock {
  releaseWithResult(result: RecoveryEpochRelease["result"]): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EPOCH_RE = /^epoch-(\d{12,})$/;
const RELEASE_TEMP_RE = /^\.released-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
const EPOCH_ENTRY_CAP = 1024;

function recoveryEpochEntries(root: string, entryCap = EPOCH_ENTRY_CAP): Array<{ epoch: number; path: string }> {
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.length > entryCap) throw new Error(`recovery epoch count exceeds ${entryCap}; explicit retention recovery is required`);
  const epochs: Array<{ epoch: number; path: string }> = [];
  for (const entry of entries) {
    const match = entry.name.match(EPOCH_RE);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`unexpected recovery epoch entry: ${entry.name}`);
    const epoch = Number(match[1]);
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error(`invalid recovery epoch number: ${entry.name}`);
    epochs.push({ epoch, path: join(root, entry.name) });
  }
  epochs.sort((a, b) => a.epoch - b.epoch);
  for (let index = 1; index < epochs.length; index++) if (epochs[index - 1]!.epoch === epochs[index]!.epoch) throw new Error("duplicate recovery epoch number");
  return epochs;
}

function readRecoveryEpochOwner(root: string, candidate: { epoch: number; path: string }): RecoveryEpochOwner {
  const ownerPath = join(candidate.path, "owner.json");
  assertNoSymlinkPath(root, ownerPath);
  const ownerInfo = lstatSync(ownerPath);
  if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile() || ownerInfo.size > 16 * 1024) throw new Error("recovery epoch owner is unsafe");
  const source = readFileSync(ownerPath, "utf8");
  let owner: RecoveryEpochOwner;
  try { owner = JSON.parse(source) as RecoveryEpochOwner; }
  catch { throw new Error("recovery epoch owner JSON is malformed"); }
  if (Object.keys(owner).sort().join(",") !== "acquired_at,epoch,hostname,inherited_namespace_token,journal_generation,journal_hash,kind,operation,pid,planned_namespace_token,pm_id,schema_version,token"
    || owner.schema_version !== 1 || owner.kind !== "garelier_recovery_epoch_owner" || owner.epoch !== candidate.epoch
    || !Number.isSafeInteger(owner.journal_generation) || owner.journal_generation < 1 || owner.journal_generation % 2 !== 1
    || !/^sha256:[0-9a-f]{64}$/.test(owner.journal_hash) || !UUID_RE.test(owner.token) || !UUID_RE.test(owner.planned_namespace_token)
    || !(owner.inherited_namespace_token === null || UUID_RE.test(owner.inherited_namespace_token))
    || typeof owner.pm_id !== "string" || typeof owner.operation !== "string" || !owner.operation
    || !Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.hostname !== "string" || !owner.hostname
    || owner.hostname.length > 255 || !Number.isFinite(Date.parse(owner.acquired_at)) || canonicalJson(owner) !== source) throw new Error("recovery epoch owner is malformed");
  assertSafePmId(owner.pm_id);
  assertSafeIdentifier(owner.operation, "recovery epoch operation");
  return owner;
}

function readRecoveryEpochRelease(root: string, candidate: { epoch: number; path: string }, owner: RecoveryEpochOwner): RecoveryEpochRelease | null {
  const releasedPath = join(candidate.path, "released.json");
  if (!existsSync(releasedPath)) return null;
  assertNoSymlinkPath(root, releasedPath);
  const releasedInfo = lstatSync(releasedPath);
  if (releasedInfo.isSymbolicLink() || !releasedInfo.isFile() || releasedInfo.size > 16 * 1024) throw new Error("recovery epoch release marker is unsafe");
  const source = readFileSync(releasedPath, "utf8");
  let released: RecoveryEpochRelease;
  try { released = JSON.parse(source) as RecoveryEpochRelease; }
  catch { throw new Error("recovery epoch release marker JSON is malformed"); }
  if (Object.keys(released).sort().join(",") !== "epoch,journal_generation,journal_hash,kind,operation,pm_id,released_at,result,schema_version,token"
    || released.schema_version !== 1 || released.kind !== "garelier_recovery_epoch_release" || released.epoch !== owner.epoch
    || released.token !== owner.token || released.pm_id !== owner.pm_id || released.journal_generation !== owner.journal_generation
    || released.journal_hash !== owner.journal_hash || released.operation !== owner.operation
    || !(["succeeded", "failed"] as const).includes(released.result)
    || typeof released.released_at !== "string" || !Number.isFinite(Date.parse(released.released_at))
    || canonicalJson(released) !== source) throw new Error("recovery epoch release marker is malformed");
  return released;
}

function validateRecoveryEpochDirectory(root: string, candidate: { epoch: number; path: string }): { owner: RecoveryEpochOwner; released: RecoveryEpochRelease | null } {
  const entries = readdirSync(candidate.path, { withFileTypes: true });
  if (entries.length > 64) throw new Error("recovery epoch artifact count exceeds 64");
  for (const entry of entries) {
    if (entry.name === "owner.json" || entry.name === "released.json") {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`unsafe recovery epoch artifact: ${entry.name}`);
      continue;
    }
    if (!RELEASE_TEMP_RE.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error(`unexpected recovery epoch artifact: ${entry.name}`);
    const info = lstatSync(join(candidate.path, entry.name));
    if (info.size > 16 * 1024) throw new Error(`oversize recovery epoch temporary artifact: ${entry.name}`);
  }
  const owner = readRecoveryEpochOwner(root, candidate);
  return { owner, released: readRecoveryEpochRelease(root, candidate, owner) };
}

function requireDeadSameHostEpoch(owner: RecoveryEpochOwner): void {
  if (owner.hostname !== hostname()) throw new Error("current recovery epoch belongs to another host; recovery refused");
  try { process.kill(owner.pid, 0); throw new Error("generation recovery is already in progress"); }
  catch (error) {
    if (error instanceof Error && error.message.includes("already in progress")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("recovery epoch owner liveness is ambiguous");
  }
}

function observeInheritedNamespaceToken(paths: ControlNamespacePaths, allowed: ReadonlySet<string>): string | null {
  const path = join(paths.runtimeRoot, "locks", "namespace.lock");
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) throw new Error("stale namespace lock is unsafe; recovery refused");
  let record: { token?: unknown };
  try { record = JSON.parse(readFileSync(path, "utf8")) as typeof record; }
  catch { throw new Error("stale namespace lock is malformed; recovery refused"); }
  if (typeof record.token !== "string" || !UUID_RE.test(record.token) || !allowed.has(record.token)) throw new Error("stale namespace lock token is not recoverable by the current epoch lineage");
  return record.token;
}

function writeRecoveryEpochRelease(target: string, owner: RecoveryEpochOwner, result: RecoveryEpochRelease["result"], hooks?: RecoveryPaths["hooks"]): void {
  const releasedPath = join(target, "released.json");
  const existing = readRecoveryEpochRelease(dirname(target), { epoch: owner.epoch, path: target }, owner);
  if (existing) return;
  const marker: RecoveryEpochRelease = {
    schema_version: 1, kind: "garelier_recovery_epoch_release", epoch: owner.epoch, token: owner.token,
    pm_id: owner.pm_id, journal_generation: owner.journal_generation, journal_hash: owner.journal_hash,
    operation: owner.operation, result, released_at: new Date().toISOString(),
  };
  const bytes = Buffer.from(canonicalJson(marker), "utf8");
  const temporary = join(target, `.released-${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  let renamed = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    hooks?.afterRecoveryReleaseTempOpen?.(temporary);
    writeFileSync(descriptor, bytes);
    hooks?.afterRecoveryReleaseTempWrite?.(temporary);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = null;
    if (lstatSync(temporary).size !== bytes.length || !readFileSync(temporary).equals(bytes)) throw new Error("recovery epoch release temporary write verification failed");
    if (existsSync(releasedPath)) {
      readRecoveryEpochRelease(dirname(target), { epoch: owner.epoch, path: target }, owner);
      return;
    }
    try { renameSync(temporary, releasedPath); renamed = true; }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (!readRecoveryEpochRelease(dirname(target), { epoch: owner.epoch, path: target }, owner)) throw error;
      return;
    }
    hooks?.afterRecoveryReleaseRename?.(releasedPath);
    readRecoveryEpochRelease(dirname(target), { epoch: owner.epoch, path: target }, owner);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    throw error;
  } finally {
    if (!renamed && existsSync(temporary)) rmSync(temporary);
  }
}

function sameIdentity(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

function prunePreviousRecoveryEpochs(root: string, stagingRoot: string, current: { epoch: number; path: string }, currentOwner: RecoveryEpochOwner, journal: GenerationRecoveryJournal, entryLimit: number, hooks?: RecoveryPaths["hooks"]): void {
  const entries = recoveryEpochEntries(root, entryLimit).filter((entry) => entry.epoch !== current.epoch);
  for (const entry of entries) {
    let artifacts: { owner: RecoveryEpochOwner; released: RecoveryEpochRelease | null };
    try { artifacts = validateRecoveryEpochDirectory(root, entry); }
    catch { continue; }
    let eligible = artifacts.released !== null;
    if (!eligible) {
      try { requireDeadSameHostEpoch(artifacts.owner); }
      catch { continue; }
      const lineage = new Set([journal.owner_token, artifacts.owner.planned_namespace_token, artifacts.owner.inherited_namespace_token].filter((token): token is string => token !== null));
      eligible = currentOwner.pm_id === journal.pm_id && currentOwner.journal_generation === journal.generation && currentOwner.journal_hash === journal.journal_hash
        && artifacts.owner.pm_id === currentOwner.pm_id && artifacts.owner.journal_generation === currentOwner.journal_generation
        && artifacts.owner.journal_hash === currentOwner.journal_hash
        && (currentOwner.inherited_namespace_token === null || lineage.has(currentOwner.inherited_namespace_token));
    }
    if (!eligible) continue;
    const before = lstatSync(entry.path);
    if (before.isSymbolicLink() || !before.isDirectory()) continue;
    const quarantine = join(stagingRoot, `.prune-${String(entry.epoch).padStart(12, "0")}-${randomUUID()}`);
    try { renameSync(entry.path, quarantine); }
    catch { continue; }
    hooks?.afterRecoveryEpochPruneRename?.(quarantine);
    try {
      const after = lstatSync(quarantine);
      if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(before, after)) continue;
      const relocated = { epoch: entry.epoch, path: quarantine };
      const verified = validateRecoveryEpochDirectory(stagingRoot, relocated);
      if (artifacts.released !== null) {
        if (verified.released === null) continue;
      } else {
        if (verified.released !== null || verified.owner.token !== artifacts.owner.token) continue;
        try { requireDeadSameHostEpoch(verified.owner); } catch { continue; }
      }
      rmSync(quarantine, { recursive: true });
    } catch { continue; }
  }
}

function acquireRecoveryEpoch(paths: ControlNamespacePaths, pmId: string, journal: GenerationRecoveryJournal, plannedNamespaceToken: string, operation: string, hooks?: RecoveryPaths["hooks"]): RecoveryEpochLease {
  const root = join(paths.runtimeRoot, "locks", "recovery_epochs");
  const stagingRoot = join(paths.runtimeRoot, "locks", "recovery_epoch_staging");
  mkdirSync(root, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });
  assertNoSymlinkPath(paths.runtimeRoot, root);
  assertNoSymlinkPath(paths.runtimeRoot, stagingRoot);
  assertSafeIdentifier(operation, "recovery epoch operation");
  const entryCap = hooks?.recoveryEpochEntryCap ?? EPOCH_ENTRY_CAP;
  if (!Number.isSafeInteger(entryCap) || entryCap < 2 || entryCap > EPOCH_ENTRY_CAP) throw new Error("recovery epoch entry cap override is invalid");
  const scan = (): { next: number; inheritedNamespaceToken: string | null } => {
    let epochs = recoveryEpochEntries(root, entryCap + 1);
    if (!epochs.length) return { next: 1, inheritedNamespaceToken: observeInheritedNamespaceToken(paths, new Set([journal.owner_token])) };
    let current = epochs.at(-1)!;
    let artifacts = validateRecoveryEpochDirectory(root, current);
    if (!artifacts.released) {
      requireDeadSameHostEpoch(artifacts.owner);
      if (artifacts.owner.pm_id !== pmId || artifacts.owner.journal_generation !== journal.generation || artifacts.owner.journal_hash !== journal.journal_hash) throw new Error("dead recovery epoch is not bound to the current journal");
    }
    if (epochs.length >= entryCap) {
      prunePreviousRecoveryEpochs(root, stagingRoot, current, artifacts.owner, journal, entryCap + 1, hooks);
      epochs = recoveryEpochEntries(root, entryCap + 1);
      current = epochs.at(-1)!;
      artifacts = validateRecoveryEpochDirectory(root, current);
      if (epochs.length >= entryCap) throw new Error("recovery epoch retention could not establish safe election room");
    }
    if (artifacts.released) return { next: current.epoch + 1, inheritedNamespaceToken: observeInheritedNamespaceToken(paths, new Set([journal.owner_token])) };
    requireDeadSameHostEpoch(artifacts.owner);
    if (artifacts.owner.pm_id !== pmId || artifacts.owner.journal_generation !== journal.generation || artifacts.owner.journal_hash !== journal.journal_hash) throw new Error("dead recovery epoch is not bound to the current journal");
    const allowed = new Set([journal.owner_token, artifacts.owner.planned_namespace_token, artifacts.owner.inherited_namespace_token].filter((token): token is string => token !== null));
    return { next: current.epoch + 1, inheritedNamespaceToken: observeInheritedNamespaceToken(paths, allowed) };
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = scan();
    if (!Number.isSafeInteger(state.next)) throw new Error("recovery epoch counter exhausted");
    const token = randomUUID();
    const owner: RecoveryEpochOwner = {
      schema_version: 1, kind: "garelier_recovery_epoch_owner", epoch: state.next, token, pm_id: pmId,
      journal_generation: journal.generation, journal_hash: journal.journal_hash, operation,
      planned_namespace_token: plannedNamespaceToken, inherited_namespace_token: state.inheritedNamespaceToken,
      pid: process.pid, hostname: hostname(), acquired_at: new Date().toISOString(),
    };
    const temporary = mkdtempSync(join(stagingRoot, ".epoch-"));
    const target = join(root, `epoch-${String(state.next).padStart(12, "0")}`);
    writeFileSync(join(temporary, "owner.json"), canonicalJson(owner), { encoding: "utf8", flag: "wx" });
    try { renameSync(temporary, target); }
    catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      if (["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    return {
      owner,
      inheritedNamespaceToken: state.inheritedNamespaceToken,
      prunePrevious(): void { prunePreviousRecoveryEpochs(root, stagingRoot, { epoch: owner.epoch, path: target }, owner, journal, entryCap + 1, hooks); },
      release(result): void { writeRecoveryEpochRelease(target, owner, result, hooks); },
    };
  }
  throw new Error("recovery epoch election remained contended after 4 attempts");
}

function acquireRecoveryLock(paths: ControlNamespacePaths, pmId: string, sessionId: string, operation: string, hooks?: RecoveryPaths["hooks"]): RecoveryNamespaceLock {
  const generation = readControlGeneration(paths.runtimeRoot);
  const journal = selectJournal(paths, generation);
  if (journal.pm_id !== pmId) throw new Error("generation recovery journal PM mismatch");
  const plannedNamespaceToken = randomUUID();
  const epoch = acquireRecoveryEpoch(paths, pmId, journal, plannedNamespaceToken, operation, hooks);
  try { hooks?.afterRecoveryEpochAcquire?.(); }
  catch (error) {
    try { epoch.release("failed"); } catch (releaseError) { throw new AggregateError([error, releaseError], "recovery epoch hook failed and release also failed"); }
    throw error;
  }
  let namespaceLock: NamespaceLock | null = null;
  let operationError: unknown = null;
  try {
    const path = join(paths.runtimeRoot, "locks", "namespace.lock");
    if (existsSync(path)) {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > 4096) throw new Error("stale namespace lock is unsafe; recovery refused");
    const source = readFileSync(path, "utf8");
    let record: { token?: unknown; pid?: unknown; hostname?: unknown };
    try { record = JSON.parse(source) as typeof record; } catch { throw new Error("stale namespace lock is malformed; recovery refused"); }
    if (![journal.owner_token, epoch.inheritedNamespaceToken].filter(Boolean).includes(record.token as string) || record.hostname !== hostname() || !Number.isInteger(record.pid) || (record.pid as number) < 1) {
      throw new Error("stale namespace lock identity does not match the recovery journal/local owner; recovery refused");
    }
    try { process.kill(record.pid as number, 0); throw new Error("namespace writer is still live; recovery refused"); }
    catch (error) {
      if (error instanceof Error && error.message.includes("still live")) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("namespace writer liveness is ambiguous; recovery refused");
    }
    const after = lstatSync(path);
    if (!sameFile(before, after) || readFileSync(path, "utf8") !== source || readControlGeneration(paths.runtimeRoot) !== generation
      || selectJournal(paths, generation).journal_hash !== journal.journal_hash) throw new Error("stale namespace lock changed during recovery proof; recovery refused");
      rmSync(path);
    }
    namespaceLock = acquireNamespaceLockWithToken(paths, { sessionId, operation, at: new Date().toISOString() }, plannedNamespaceToken);
    epoch.prunePrevious();
  } catch (error) { operationError = error; }
  if (operationError) {
    const cleanupErrors: unknown[] = [operationError];
    if (namespaceLock) try { namespaceLock.release(); } catch (error) { cleanupErrors.push(error); }
    try { epoch.release("failed"); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "recovery acquisition failed and cleanup also failed");
    throw operationError;
  }
  const held = namespaceLock!;
  const releaseWithResult = (result: RecoveryEpochRelease["result"]): void => {
    const errors: unknown[] = [];
    try { hooks?.beforeRecoveryMutexRelease?.(); } catch (error) { errors.push(error); }
    let namespaceReleased = false;
    try { held.release(); namespaceReleased = true; } catch (error) { errors.push(error); }
    if (namespaceReleased) try { epoch.release(result); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "recovery namespace/epoch release failed");
  };
  return {
    path: held.path,
    token: held.token,
    release(): void { releaseWithResult("failed"); },
    releaseWithResult,
  };
}

function planLocked(paths: ControlNamespacePaths, pmId: string, lock: NamespaceLock): GenerationRecoveryPlan {
  assertNamespaceLock(paths, lock);
  const generation = readControlGeneration(paths.runtimeRoot);
  const journal = selectJournal(paths, generation);
  if (journal.pm_id !== pmId) throw new Error(`generation recovery journal PM mismatch: ${journal.pm_id}`);
  const canonicalBinding = readCanonicalControlBinding(paths.controlRoot);
  if (journal.control_schema_version === undefined || journal.storage === undefined) {
    throw new Error("schema-3 generation recovery journal lacks an explicit canonical binding");
  } else if (journal.control_schema_version !== canonicalBinding.controlSchemaVersion || journal.storage !== canonicalBinding.storage) {
    throw new Error("generation recovery journal canonical binding does not match control.toml");
  }
  let revision: string;
  let digest: string;
  let canonical_state: "before" | "after" | null;
  if (journal.source_digest_kind !== "canonical_tree_v1") throw new Error("schema-3 generation recovery journal lacks canonical_tree_v1 digest binding");
  digest = controlTreeSourceDigest(paths.controlRoot);
  canonical_state = digest === journal.before.source_digest ? "before"
    : digest === journal.after.source_digest ? "after" : null;
  revision = canonical_state === "before" ? journal.before.revision
    : canonical_state === "after" ? journal.after.revision : digest;
  if (!canonical_state) throw new Error("canonical control is neither the journaled before nor after snapshot; partial or ambiguous recovery is refused and generation remains odd");
  const action = generation === journal.generation - 1 && canonical_state === "before" ? "abandon_prepared" as const
    : generation === journal.generation && canonical_state === "before" ? "settle_rolled_back" as const
    : generation === journal.generation && canonical_state === "after" ? "settle_committed" as const
    : generation === journal.settle_generation && canonical_state === "after" ? "finalize_settled" as const : null;
  if (!action) throw new Error("generation/journal/canonical state combination is not a provable recovery window");
  const payload = {
    schema_version: 1 as const, kind: "garelier_control_generation_recovery_plan" as const,
    pm_id: pmId, generation, journal_generation: journal.generation, journal_hash: journal.journal_hash, canonical_state, action,
    ...(journal.control_schema_version === undefined ? {} : {
      control_schema_version: journal.control_schema_version,
      storage: journal.storage,
    }),
    control_revision: revision, source_digest: digest,
  };
  return { ...payload, plan_digest: sha256(canonicalJson(payload)) };
}

function verifyRecoveryStaging(paths: ControlNamespacePaths, journal: GenerationRecoveryJournal): string | null {
  const staging = join(dirname(paths.controlRoot), journal.staging_directory);
  assertPathInside(dirname(paths.controlRoot), staging);
  if (!existsSync(staging)) return null;
  assertNoSymlinkPath(dirname(paths.controlRoot), staging);
  const info = lstatSync(staging);
  if (info.isSymbolicLink() || !info.isDirectory() || dirname(resolve(staging)) !== dirname(resolve(paths.controlRoot))
    || !basename(staging).startsWith(`.${basename(paths.controlRoot)}.txn-`)) throw new Error("journaled staging directory failed safe-path verification");
  for (const change of journal.changes) {
    for (const [candidate, expected] of [[join(staging, change.path), change.after], [join(staging, journal.backup_directory, change.path), change.before]] as const) {
      assertPathInside(staging, candidate);
      if (!existsSync(candidate)) continue;
      assertNoSymlinkPath(staging, candidate);
      const entry = lstatSync(candidate);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 16 * 1024 * 1024 || expected === null || sha256(readFileSync(candidate)) !== expected) throw new Error(`staging artifact hash verification failed: ${change.path}`);
    }
  }
  return staging;
}

function removeVerifiedRecoveryStaging(staging: string | null, hooks?: RecoveryPaths["hooks"]): string | null {
  if (!staging) return null;
  try { hooks?.beforeStagingRemoval?.(); rmSync(staging, { recursive: true }); return null; }
  catch (error) { return `staging cleanup failed: ${(error as Error).message}`; }
}

export function planGenerationRecovery(options: RecoveryPaths): GenerationRecoveryPlan {
  const paths = resolveControlNamespace(options);
  const lock = acquireRecoveryLock(paths, options.pmId, `recovery-plan-${process.pid}`, "generation-recovery-plan", options.hooks);
  let result: RecoveryEpochRelease["result"] = "failed";
  try {
    const plan = planLocked(paths, options.pmId, lock);
    result = "succeeded";
    return plan;
  } finally { lock.releaseWithResult(result); }
}

export function applyGenerationRecovery(options: RecoveryPaths & { expectedPlanDigest: string; expectedGeneration: number; sessionId: string }): GenerationRecoveryPlan {
  const paths = resolveControlNamespace(options);
  const at = new Date().toISOString();
  const lock = acquireRecoveryLock(paths, options.pmId, options.sessionId, "generation-recovery-apply", options.hooks);
  let completed: GenerationRecoveryPlan | null = null;
  let removeJournalGeneration: number | null = null;
  let operationError: unknown = null;
  try {
    const plan = planLocked(paths, options.pmId, lock);
    if (plan.generation !== options.expectedGeneration || plan.plan_digest !== options.expectedPlanDigest) throw new Error("generation recovery apply precondition is stale; create a new plan");
    assertNamespaceLock(paths, lock);
    if (readControlGeneration(paths.runtimeRoot) !== plan.generation) throw new Error("generation changed before recovery CAS");
    const journal = readJournal(paths, plan.journal_generation);
    const verifiedStaging = verifyRecoveryStaging(paths, journal);
    const auditPath = join(journalDirectory(paths), "audit", `generation-${plan.generation}-${plan.plan_digest.replace(/^sha256:/, "")}.json`);
    const audit = { ...plan, kind: "garelier_control_generation_recovery_audit", applied_at: at, session_id: options.sessionId };
    atomicWriteRuntimeFile(paths.runtimeRoot, auditPath, canonicalJson({ ...audit, status: "settling", cleanup_warning: null }));
    const settlesOdd = plan.action === "settle_rolled_back" || plan.action === "settle_committed";
    const generationSnapshot = readControlGenerationSnapshot(paths.runtimeRoot, 16, paths.controlRoot);
    if (settlesOdd) {
      if (!generationSnapshot.incarnation || generationSnapshot.legacy || generationSnapshot.generation !== plan.generation) throw new Error("generation recovery requires an incarnation-bound generation record v2");
      const binding = readCanonicalControlBinding(paths.controlRoot);
      writeControlGenerationFile(paths.runtimeRoot, `${JSON.stringify({
        schema_version: 2,
        kind: "garelier_control_generation",
        control_schema_version: binding.controlSchemaVersion,
        storage: binding.storage,
        incarnation: generationSnapshot.incarnation,
        generation: plan.generation + 1,
        state: "stable",
        operation: "generation-recovery-apply",
        session_id: options.sessionId,
        updated_at: at,
      }, null, 2)}\n`);
    }
    const expectedFinalGeneration = settlesOdd ? plan.generation + 1 : plan.generation;
    if (readControlGeneration(paths.runtimeRoot) !== expectedFinalGeneration) throw new Error("generation recovery settle verification failed");
    const cleanupWarning = removeVerifiedRecoveryStaging(verifiedStaging, options.hooks);
    atomicWriteRuntimeFile(paths.runtimeRoot, auditPath, canonicalJson({ ...audit, status: "settled", cleanup_warning: cleanupWarning }));
    writeControlDiagnostic(paths.runtimeRoot, { schema_version: 1, operation: "generation-recovery", status: "ok", pm_id: options.pmId, session_id: options.sessionId, at, control_revision: plan.control_revision, entity: null, changed_paths: [], reason: cleanupWarning ? `${plan.action}; ${cleanupWarning}` : plan.action, error: null });
    if (!cleanupWarning) removeJournalGeneration = plan.journal_generation;
    completed = plan;
  } catch (error) {
    writeControlDiagnostic(paths.runtimeRoot, { schema_version: 1, operation: "generation-recovery", status: "error", pm_id: options.pmId, session_id: options.sessionId, at, control_revision: null, entity: null, changed_paths: [], reason: null, error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } });
    operationError = error;
  }
  let releaseError: unknown = null;
  try { lock.releaseWithResult(operationError ? "failed" : "succeeded"); } catch (error) { releaseError = error; }
  if (operationError || releaseError) throw new AggregateError([...(operationError ? [operationError] : []), ...(releaseError ? [releaseError] : [])], "generation recovery apply failed");
  if (removeJournalGeneration !== null) removeGenerationRecoveryJournal(paths, removeJournalGeneration);
  return completed!;
}
