import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mkdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "./guard/path_guard.ts";
import { pidAlive } from "./scripts/_lib.ts";

export const LONG_JOB_SCHEMA = "garelier.long-job" as const;
export const LONG_JOB_VERSION = 2 as const;
export type LongJobState = "ARMED" | "RUNNING" | "FINISHED" | "FAILED" | "ACKED";
export type WakeCapability = "monitor" | "async-rewake" | "claude-completion" | "codex-task";

export interface LongJobRecord {
  schema: typeof LONG_JOB_SCHEMA;
  version: typeof LONG_JOB_VERSION;
  job_id: string;
  command_digest: string;
  command_ref: string;
  dispatch_id: string;
  agent_id: string;
  provider: string;
  cwd: string;
  cwd_identity: string;
  state: LongJobState;
  attempt: number;
  paths: { record: string; result: string; log: string; exit: string; done: string; ack: string };
  timestamps: {
    created_at: string;
    updated_at: string;
    armed_at: string;
    started_at?: string;
    finished_at?: string;
    failed_at?: string;
    acked_at?: string;
  };
  wake: { armed: true; capability: WakeCapability; source: string };
  failure?: { reason: string; recoverable: boolean; exit_code: number };
  runtime?: { runner_pid: number; child_pid?: number };
  attempt_artifacts?: { attempt: number; log_digest: string; exit_digest: string; done_digest: string };
}

export interface RetiredLongJob {
  job_id: string;
  attempt: number;
  prior_state: "FINISHED" | "FAILED" | "ACKED";
  evidence_path: string;
}

export interface ArmLongJobInput {
  root: string;
  jobId: string;
  command: string;
  commandRef: string;
  dispatchId: string;
  agentId: string;
  provider: string;
  cwd: string;
  wake?: { armed: boolean; capability?: WakeCapability | "none"; source?: string };
  now?: string;
}

export interface RecoveryItem {
  job_id: string;
  attempt: number;
  action: "DRAIN" | "RERUN_WHOLE_COMMAND" | "START_BROKER" | "BLOCK_WAKE_UNARMED" | "BLOCK_BROKER_LOCK" | "BLOCK_WAKE_LOCK" | "BLOCK_LEDGER_PATH";
  reason: string;
}

export interface LongJobInspection {
  records: LongJobRecord[];
  issues: RecoveryItem[];
}

export interface BrokerOwner {
  schema: "garelier.long-job-broker";
  version: 1;
  pid: number;
  nonce: string;
  phase: "running" | "closing";
  started_at: string;
  heartbeat_at: string;
  owner: "operator";
  provenance: "operator-owned";
}

export type BrokerLockStatus =
  | { state: "absent" }
  | { state: "live" | "stale"; owner: BrokerOwner }
  | { state: "invalid"; reason: string };

export interface WakeOwner {
  schema: "garelier.long-job-wake-lock";
  version: 1;
  pid: number;
  nonce: string;
  started_at: string;
  heartbeat_at: string;
}

export type WakeLockStatus =
  | { state: "absent" }
  | { state: "live" | "stale"; owner: WakeOwner }
  | { state: "invalid"; reason: string };

function iso(value?: string): string { return value ?? new Date().toISOString(); }
const WAKE_CAPABILITIES = new Set<WakeCapability>(["monitor", "async-rewake", "claude-completion", "codex-task"]);
function safeJobId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new Error("long job: invalid job id");
  return id;
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalLedgerRoot(root: string, create = false): string {
  const lexical = resolve(root);
  if (create && !existsSync(lexical)) {
    const missing: string[] = [];
    let cursor = lexical;
    while (!existsSync(cursor)) {
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("long job: no existing normal ancestor for ledger root");
      cursor = parent;
    }
    const ancestor = lstatSync(cursor);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || pathKey(realpathSync.native(cursor)) !== pathKey(cursor)) {
      throw new Error("long job: ledger root ancestor must be a normal directory");
    }
    for (const path of missing.reverse()) {
      mkdirSync(path);
      const created = lstatSync(path);
      if (!created.isDirectory() || created.isSymbolicLink() || pathKey(realpathSync.native(path)) !== pathKey(path)) {
        throw new Error("long job: created ledger path is not a normal directory");
      }
    }
  }
  const stat = lstatSync(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("long job: ledger root must be a normal directory");
  const canonical = realpathSync.native(lexical);
  if (pathKey(canonical) !== pathKey(lexical)) throw new Error("long job: ledger root must not traverse symlink/reparse ancestors");
  return canonical;
}

function containedRelative(root: string, target: string): string {
  const rel = relative(root, target);
  const separator = process.platform === "win32" ? "\\" : "/";
  if (!rel || rel === ".." || rel.startsWith(`..${separator}`) || isAbsolute(rel)) throw new Error("long job: path must stay within the durable ledger root");
  return rel;
}

function canonicalNormalInside(root: string, target: string, kind: "file" | "directory", label: string): string {
  const lexical = resolve(target);
  const rel = containedRelative(root, lexical);
  let cursor = root;
  for (const segment of rel.split(/[\\/]+/)) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`long job: ${label} must not traverse symlink/reparse entries`);
  }
  const final = lstatSync(lexical);
  if (kind === "file" ? !final.isFile() : !final.isDirectory()) throw new Error(`long job: ${label} must be a normal ${kind}`);
  const canonical = realpathSync.native(lexical);
  if (pathKey(canonical) !== pathKey(lexical)) throw new Error(`long job: ${label} must not traverse symlink/reparse entries`);
  return canonical;
}

function canonicalNormalDirectory(path: string, label: string): string {
  try {
    const lexical = resolve(path);
    const stat = lstatSync(lexical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    const canonical = realpathSync.native(lexical);
    if (pathKey(canonical) !== pathKey(lexical)) throw new Error();
    return canonical;
  } catch { throw new Error(`long job: ${label} is unavailable or not a normal directory`); }
}

function canonicalDirectoryIdentity(path: string, label: string): string {
  const canonical = canonicalNormalDirectory(path, label);
  const stat = statSync(canonical);
  return `sha256:${createHash("sha256").update([pathKey(canonical), stat.dev, stat.ino, stat.birthtimeMs].join("\0")).digest("hex")}`;
}

function contentDigest(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function commandDigest(command: string): string {
  return `sha256:${createHash("sha256").update(command).digest("hex")}`;
}

export function longJobRoot(project: string, pmId: string): string {
  if (!pmId.trim()) throw new Error("long job: pm id required");
  return resolve(project, "__garelier", pmId, "runtime", "long_jobs");
}

// A job directory is identified by the artifacts a job owns. `arm` requires the
// `--command-ref` file to live INSIDE the ledger root, so callers legitimately
// create sibling directories there to hold command payloads. Counting every
// root-level directory as a job turned such a payload directory into a job with
// no `record.json`, which made the whole recovery scan BLOCK and stopped every
// dispatch for that PM until someone hand-edited a machine-owned record. The
// denominator is therefore "directories that hold a job artifact", never "every
// directory".
const JOB_ARTIFACT_NAMES = ["record.json", "result.json", "job.log", "exit.json", ".done", "ack.json", "retirement.json", "attempt-audits"] as const;

function isJobArtifactName(name: string): boolean {
  // `atomicWrite` publishes through `<artifact>.tmp-<pid>-<uuid>`, so crash
  // residue must still mark the directory as a job (fail closed) rather than
  // letting a half-written record hide live work from the scan.
  return JOB_ARTIFACT_NAMES.some((artifact) => name === artifact || name.startsWith(`${artifact}.`));
}

function ledgerEntryHoldsJob(dir: string): boolean {
  // An unreadable directory stays in the denominator so the scan BLOCKs on it
  // rather than silently dropping work it could not inspect.
  let names: string[];
  try { names = readdirSync(dir); } catch { return true; }
  // A directory that holds a job artifact but no `record.json` is a CORRUPT job
  // and still BLOCKs below — partial deletion must never hide live work. An
  // empty directory carries no such claim: it is an emptied payload directory
  // or the microsecond `arm` window before the first `record.json` publish, and
  // whole-directory removal was always indistinguishable from "no job" anyway,
  // so treating it as a job only reproduces the false BLOCK this classification
  // exists to remove.
  return names.some(isJobArtifactName);
}

function jobDirectory(root: string, jobId: string): string { return join(resolve(root), safeJobId(jobId)); }
function recordPath(root: string, jobId: string): string { return join(jobDirectory(root, jobId), "record.json"); }
export function brokerLockPath(root: string): string { return join(resolve(root), ".broker.lock"); }
function brokerOwnerPath(root: string): string { return join(brokerLockPath(root), "owner.json"); }
function brokerHandoffPath(root: string): string { return join(resolve(root), ".broker.handoff"); }
export function wakeLockPath(root: string): string { return join(resolve(root), ".wake.lock"); }
function wakeOwnerPath(root: string): string { return join(wakeLockPath(root), "owner.json"); }
function wakeHandoffPath(root: string): string { return join(resolve(root), ".wake.handoff"); }

function atomicWrite(path: string, content: string): void {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, target);
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve primary error */ }
  }
}

function publishOwnerDirectory<T>(lock: string, owner: T, afterTempMkdir?: (temporary: string) => void): void {
  const temporary = `${lock}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(temporary);
    afterTempMkdir?.(temporary);
    writeFileSync(join(temporary, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`);
    // W-114 (Linux parity): POSIX `rename(2)` atomically REPLACES an empty target
    // directory, so a corrupt/empty lock dir would be silently clobbered and the
    // lock acquired — Windows rename fails on ANY existing target, which masked
    // this. Refuse to publish onto an existing lock on every platform; the caller's
    // catch then inspects it and BLOCKS (invalid) or reclaims (stale) as it should.
    // A valid lock published by a real claimer always contains owner.json (a
    // non-empty dir, which POSIX rename already refuses), so this only closes the
    // empty/corrupt-dir hole and never races a legitimate concurrent acquisition.
    if (existsSync(lock)) throw new Error("long job lock already present");
    renameSync(temporary, lock);
  } finally {
    if (existsSync(temporary)) {
      try { if (existsSync(join(temporary, "owner.json"))) unlinkSync(join(temporary, "owner.json")); } catch { /* exact temp cleanup only */ }
      try { rmdirSync(temporary); } catch { /* crash residue remains non-authoritative */ }
    }
  }
}

function writeRecord(record: LongJobRecord): void {
  atomicWrite(record.paths.record, `${JSON.stringify(record, null, 2)}\n`);
}

function inspectBrokerLockOnce(root: string, isAlive: (pid: number) => boolean): BrokerLockStatus {
  const lock = brokerLockPath(root);
  if (!existsSync(lock)) return { state: "absent" };
  try {
    const stat = lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink() || pathKey(realpathSync.native(lock)) !== pathKey(lock)) return { state: "invalid", reason: "broker lock is not a normal directory" };
    const owner = JSON.parse(readFileSync(brokerOwnerPath(root), "utf8")) as BrokerOwner;
    if (owner.schema !== "garelier.long-job-broker" || owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.nonce || (owner.phase !== "running" && owner.phase !== "closing")) {
      return { state: "invalid", reason: "broker owner record is invalid" };
    }
    return { state: isAlive(owner.pid) ? "live" : "stale", owner };
  } catch (error) {
    return { state: "invalid", reason: `broker owner unreadable: ${(error as Error).message}` };
  }
}

export function inspectBrokerLock(root: string, isAlive: (pid: number) => boolean = pidAlive): BrokerLockStatus {
  let status = inspectBrokerLockOnce(root, isAlive);
  if (status.state !== "invalid") return status;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 25; attempt++) {
    Atomics.wait(pause, 0, 0, 2);
    status = inspectBrokerLockOnce(root, isAlive);
    if (status.state !== "invalid") return status;
  }
  return status;
}

export function claimBrokerLock(root: string, isAlive: (pid: number) => boolean = pidAlive, at?: string): BrokerOwner {
  const base = canonicalLedgerRoot(root, true);
  const lock = brokerLockPath(base);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const timestamp = iso(at);
      const owner: BrokerOwner = {
        schema: "garelier.long-job-broker",
        version: 1,
        pid: process.pid,
        nonce: randomUUID(),
        phase: "running",
        started_at: timestamp,
        heartbeat_at: timestamp,
        owner: "operator",
        provenance: "operator-owned",
      };
      publishOwnerDirectory(lock, owner);
      try { rmdirSync(brokerHandoffPath(base)); } catch { /* absent or owned by a concurrent closer */ }
      return owner;
    } catch {
      const status = inspectBrokerLock(base, isAlive);
      if (status.state === "live") throw new Error(status.owner.phase === "closing" ? "long job broker closing; successor must wait" : "long job broker already running");
      if (status.state === "absent") continue;
      if (status.state !== "stale") throw new Error(`long job broker lock blocked: ${status.state === "invalid" ? status.reason : "lock acquisition race"}`);
      const current = inspectBrokerLock(base, isAlive);
      if (current.state !== "stale" || current.owner.nonce !== status.owner.nonce || current.owner.pid !== status.owner.pid) {
        throw new Error("long job broker lock changed during stale reclaim");
      }
      unlinkSync(brokerOwnerPath(base));
      rmdirSync(lock);
    }
  }
  throw new Error("long job broker lock acquisition failed");
}

function inspectWakeLockOnce(root: string, isAlive: (pid: number) => boolean): WakeLockStatus {
  const lock = wakeLockPath(root);
  if (!existsSync(lock)) return { state: "absent" };
  try {
    const stat = lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink() || pathKey(realpathSync.native(lock)) !== pathKey(lock)) {
      return { state: "invalid", reason: "wake lock is not a normal directory" };
    }
    const owner = JSON.parse(readFileSync(wakeOwnerPath(root), "utf8")) as WakeOwner;
    if (owner.schema !== "garelier.long-job-wake-lock" || owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.nonce || !Number.isFinite(Date.parse(owner.started_at)) || !Number.isFinite(Date.parse(owner.heartbeat_at))) {
      return { state: "invalid", reason: "wake owner record is invalid" };
    }
    return { state: isAlive(owner.pid) ? "live" : "stale", owner };
  } catch (error) {
    return { state: "invalid", reason: `wake owner unreadable: ${(error as Error).message}` };
  }
}

export function inspectWakeLock(root: string, isAlive: (pid: number) => boolean = pidAlive): WakeLockStatus {
  let status = inspectWakeLockOnce(root, isAlive);
  if (status.state !== "invalid") return status;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 25; attempt++) {
    Atomics.wait(pause, 0, 0, 2);
    status = inspectWakeLockOnce(root, isAlive);
    if (status.state !== "invalid") return status;
  }
  return status;
}

export function claimWakeLock(
  root: string,
  isAlive: (pid: number) => boolean = pidAlive,
  at?: string,
  afterTempMkdir?: (temporary: string) => void,
): WakeOwner {
  const base = canonicalLedgerRoot(root, true);
  const lock = wakeLockPath(base);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const timestamp = iso(at);
      const owner: WakeOwner = { schema: "garelier.long-job-wake-lock", version: 1, pid: process.pid, nonce: randomUUID(), started_at: timestamp, heartbeat_at: timestamp };
      publishOwnerDirectory(lock, owner, afterTempMkdir);
      return owner;
    } catch (error) {
      const status = inspectWakeLock(base, isAlive);
      if (status.state === "live") throw new Error("long job wake lock already running");
      if (status.state === "absent") continue;
      if (status.state !== "stale") throw new Error(`long job wake lock blocked: ${status.state === "invalid" ? status.reason : (error as Error).message}`);
      const current = inspectWakeLock(base, isAlive);
      if (current.state !== "stale" || current.owner.nonce !== status.owner.nonce || current.owner.pid !== status.owner.pid) throw new Error("long job wake lock changed during stale reclaim");
      unlinkSync(wakeOwnerPath(base));
      rmdirSync(lock);
    }
  }
  throw new Error("long job wake lock acquisition failed");
}

export function releaseWakeLock(root: string, owner: WakeOwner): void {
  const status = inspectWakeLock(root, () => true);
  if (status.state !== "live" || status.owner.nonce !== owner.nonce || status.owner.pid !== owner.pid) return;
  unlinkSync(wakeOwnerPath(root));
  rmdirSync(wakeLockPath(root));
}

function waitForWakeLock(root: string, at?: string, waitMs = 30_000): WakeOwner {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const owner = claimWakeLock(root, pidAlive, at);
      try { rmdirSync(wakeHandoffPath(root)); } catch { /* no queued handoff */ }
      return owner;
    } catch (error) {
      if (!/wake lock already running/.test((error as Error).message)) throw error;
      try { mkdirSync(wakeHandoffPath(root)); } catch { /* coalesced durable waiter */ }
      if (Date.now() >= deadline) throw new Error("long job wake lock handoff remains pending after bounded wait");
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}

export function heartbeatBrokerLock(root: string, owner: BrokerOwner, at?: string): void {
  const status = inspectBrokerLock(root, () => true);
  if (status.state !== "live" || status.owner.nonce !== owner.nonce || status.owner.pid !== owner.pid) throw new Error("long job broker lost lock ownership");
  const next = { ...owner, heartbeat_at: iso(at) };
  atomicWrite(brokerOwnerPath(root), `${JSON.stringify(next, null, 2)}\n`);
  owner.heartbeat_at = next.heartbeat_at;
}

export function setBrokerPhase(root: string, owner: BrokerOwner, phase: BrokerOwner["phase"], at?: string): void {
  const status = inspectBrokerLock(root, () => true);
  if (status.state !== "live" || status.owner.nonce !== owner.nonce || status.owner.pid !== owner.pid) throw new Error("long job broker lost lock ownership");
  const next = { ...owner, phase, heartbeat_at: iso(at) };
  atomicWrite(brokerOwnerPath(root), `${JSON.stringify(next, null, 2)}\n`);
  owner.phase = phase;
  owner.heartbeat_at = next.heartbeat_at;
  if (phase === "running") try { rmdirSync(brokerHandoffPath(root)); } catch { /* no queued handoff */ }
}

export function requestBrokerHandoff(root: string, owner: BrokerOwner): boolean {
  const status = inspectBrokerLock(root);
  if (status.state !== "live" || status.owner.nonce !== owner.nonce || status.owner.phase !== "closing") return false;
  try { mkdirSync(brokerHandoffPath(root)); return true; } catch { return false; }
}

export function releaseBrokerLock(root: string, owner: BrokerOwner): void {
  const status = inspectBrokerLock(root, () => true);
  if (status.state !== "live" || status.owner.nonce !== owner.nonce || status.owner.pid !== owner.pid) return;
  unlinkSync(brokerOwnerPath(root));
  rmdirSync(brokerLockPath(root));
}

export function readLongJob(root: string, jobId: string): LongJobRecord {
  const canonicalRoot = canonicalLedgerRoot(root);
  const dir = jobDirectory(canonicalRoot, jobId);
  canonicalNormalInside(canonicalRoot, dir, "directory", "job directory");
  canonicalNormalInside(canonicalRoot, join(dir, "record.json"), "file", "record");
  const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as LongJobRecord;
  if (record.schema !== LONG_JOB_SCHEMA) throw new Error("long job: unsupported record schema");
  if (record.version !== LONG_JOB_VERSION) {
    throw new Error(`long job BLOCK_LEDGER_PATH: ledger version ${String(record.version)} lacks canonical cwd identity; owner-reviewed migration is required before recovery`);
  }
  if (record.job_id !== safeJobId(jobId) || record.attempt < 1) throw new Error("long job: corrupt identity/attempt");
  if (!record.wake?.armed || !WAKE_CAPABILITIES.has(record.wake.capability) || !record.wake.source) throw new Error("long job: wake is not reliably armed");
  const expected = {
    record: join(dir, "record.json"), result: join(dir, "result.json"), log: join(dir, "job.log"),
    exit: join(dir, "exit.json"), done: join(dir, ".done"), ack: join(dir, "ack.json"),
  };
  const samePath = (a: string, b: string): boolean => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  for (const [name, path] of Object.entries(record.paths)) {
    if (!samePath(path, expected[name as keyof typeof expected])) throw new Error(`long job: corrupt ${name} path`);
    if (existsSync(path)) canonicalNormalInside(canonicalRoot, path, "file", name);
  }
  if (!isAbsolute(record.cwd)) throw new Error("long job: cwd/worktree is unavailable");
  // A dispatch cleanup can remove its checkout after a command has written its
  // terminal marker. The ledger is the durable evidence in that case, so a
  // terminal record must remain readable/acknowledgeable even though its former
  // worktree no longer exists. ARMED/RUNNING records remain live work and keep
  // the canonical cwd identity check before any recovery action can use them.
  const terminal = record.state === "FAILED" || existsSync(record.paths.done);
  if (!terminal) {
    const cwdIdentity = canonicalDirectoryIdentity(record.cwd, "cwd/worktree");
    if (!record.cwd_identity || record.cwd_identity !== cwdIdentity) throw new Error("long job BLOCK: cwd/worktree canonical identity mismatch");
  }
  if (!isAbsolute(record.command_ref)) throw new Error("long job: command_ref must stay within the durable ledger root");
  // ACKED means the terminal attempt was read and acknowledged, so no recovery
  // action will ever re-execute it: `rearmWholeCommand` accepts only FAILED or
  // stale RUNNING, and `executeJob` accepts only ARMED. The durable identity of
  // what ran stays in `command_digest` on the record itself. Demanding the
  // command payload FILE forever therefore pins an artifact with no remaining
  // re-execution consumer, and its removal turns every later recovery scan —
  // and so every dispatch for that PM — into a hard BLOCK on already-settled
  // work. Containment and normal-file shape are still enforced, so an ACKED
  // record can never be used to point recovery outside the ledger root.
  // Supersession evidence (`verifyTerminalArtifacts`) keeps requiring the file,
  // because there the payload is the proof that an ACKED successor ran the same
  // command as the FAILED job it supersedes — that is evidence, not re-execution.
  if (record.state === "ACKED" && !existsSync(record.command_ref)) {
    containedRelative(canonicalRoot, resolve(record.command_ref));
  } else {
    canonicalNormalInside(canonicalRoot, record.command_ref, "file", "command_ref");
  }
  return record;
}

export function inspectLongJobs(root: string): LongJobInspection {
  if (!existsSync(root)) return { records: [], issues: [] };
  const records: LongJobRecord[] = [];
  const issues: RecoveryItem[] = [];
  let canonicalRoot: string;
  try { canonicalRoot = canonicalLedgerRoot(root); }
  catch (error) {
    return { records, issues: [{ job_id: ".ledger-root", attempt: 0, action: "BLOCK_LEDGER_PATH", reason: (error as Error).message }] };
  }
  for (const entry of readdirSync(canonicalRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) {
      issues.push({ job_id: entry.name, attempt: 0, action: "BLOCK_LEDGER_PATH", reason: "ledger entry is not a normal job directory" });
      continue;
    }
    if (!entry.isDirectory()) continue; // command_ref and payload files are root-level durable artifacts
    if (!ledgerEntryHoldsJob(join(canonicalRoot, entry.name))) continue; // command_ref payload directory, not a job
    try { records.push(readLongJob(root, entry.name)); }
    catch (error) {
      const reason = (error as Error).message;
      issues.push({
        job_id: entry.name,
        attempt: 0,
        action: reason.includes("BLOCK_LEDGER_PATH") ? "BLOCK_LEDGER_PATH" : "BLOCK_WAKE_UNARMED",
        reason: `invalid-or-wake-unarmed-record: ${reason}`,
      });
    }
  }
  records.sort((a, b) => Date.parse(a.timestamps.armed_at) - Date.parse(b.timestamps.armed_at) || a.job_id.localeCompare(b.job_id) || a.attempt - b.attempt);
  issues.sort((a, b) => a.job_id.localeCompare(b.job_id));
  return { records, issues };
}

export function listLongJobs(root: string): LongJobRecord[] {
  return inspectLongJobs(root).records;
}

export function armLongJob(input: ArmLongJobInput): LongJobRecord {
  const wake = input.wake;
  if (!wake?.armed || !wake.capability || wake.capability === "none" || !WAKE_CAPABILITIES.has(wake.capability as WakeCapability) || !wake.source?.trim()) {
    throw new Error("long job BLOCK: reliable completion wake must be armed before launch");
  }
  const jobId = safeJobId(input.jobId);
  const canonicalRoot = canonicalLedgerRoot(input.root, true);
  if (!isAbsolute(input.commandRef)) throw new Error("long job: command_ref must stay within the durable ledger root");
  const commandRef = canonicalNormalInside(canonicalRoot, input.commandRef, "file", "command_ref");
  const referenced = readFileSync(commandRef, "utf8");
  if (referenced !== input.command) throw new Error("long job: command_ref content does not match the armed command");
  if (!isAbsolute(input.cwd)) throw new Error("long job: cwd must be an existing absolute worktree/project directory");
  const cwd = canonicalNormalDirectory(input.cwd, "cwd");
  const cwdIdentity = canonicalDirectoryIdentity(cwd, "cwd");
  const dir = jobDirectory(canonicalRoot, jobId);
  const recordFile = join(dir, "record.json");
  try { mkdirSync(dir); } catch { throw new Error(`long job: ${jobId} already exists or cannot be created exclusively`); }
  const timestamp = iso(input.now);
  const record: LongJobRecord = {
    schema: LONG_JOB_SCHEMA,
    version: LONG_JOB_VERSION,
    job_id: jobId,
    command_digest: commandDigest(input.command),
    command_ref: commandRef,
    dispatch_id: input.dispatchId,
    agent_id: input.agentId,
    provider: input.provider,
    cwd,
    cwd_identity: cwdIdentity,
    state: "ARMED",
    attempt: 1,
    paths: {
      record: recordFile,
      result: join(dir, "result.json"),
      log: join(dir, "job.log"),
      exit: join(dir, "exit.json"),
      done: join(dir, ".done"),
      ack: join(dir, "ack.json"),
    },
    timestamps: { created_at: timestamp, updated_at: timestamp, armed_at: timestamp },
    wake: { armed: true, capability: wake.capability, source: wake.source.trim() },
  };
  writeRecord(record);
  return record;
}

export function loadVerifiedLongJobCommand(record: LongJobRecord): string {
  const root = dirname(dirname(record.paths.record));
  const canonicalRoot = canonicalLedgerRoot(root);
  canonicalNormalInside(canonicalRoot, record.command_ref, "file", "command_ref");
  const command = readFileSync(record.command_ref, "utf8");
  if (commandDigest(command) !== record.command_digest) throw new Error("long job BLOCK: command_ref digest mismatch");
  return command;
}

function transition(record: LongJobRecord, state: LongJobState, at?: string): LongJobRecord {
  const timestamp = iso(at);
  const next: LongJobRecord = { ...record, state, timestamps: { ...record.timestamps, updated_at: timestamp } };
  if (state === "RUNNING") next.timestamps.started_at = timestamp;
  if (state === "FINISHED") next.timestamps.finished_at = timestamp;
  if (state === "FAILED") next.timestamps.failed_at = timestamp;
  if (state === "ACKED") next.timestamps.acked_at = timestamp;
  return next;
}

function readNormalArtifact(record: LongJobRecord, path: string, label: string): Buffer {
  const root = dirname(dirname(record.paths.record));
  canonicalNormalInside(root, path, "file", label);
  const before = lstatSync(path);
  const content = readFileSync(path);
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`long job BLOCK: ${label} changed during audit`);
  }
  canonicalNormalInside(root, path, "file", label);
  return content;
}

function prepareAttemptFiles(record: LongJobRecord): void {
  const root = dirname(dirname(record.paths.record));
  for (const [label, path] of Object.entries({ result: record.paths.result, exit: record.paths.exit, done: record.paths.done, ack: record.paths.ack })) {
    if (!existsSync(path)) continue;
    canonicalNormalInside(root, path, "file", label);
    unlinkSync(path);
  }
  if (!existsSync(record.paths.log)) writeFileSync(record.paths.log, "", { flag: "wx" });
  canonicalNormalInside(root, record.paths.log, "file", "log");
  writeFileSync(record.paths.log, "", { flag: "w" });
  canonicalNormalInside(root, record.paths.log, "file", "log");
}

export function startLongJob(root: string, jobId: string, at?: string, runnerPid = process.pid): LongJobRecord {
  const record = readLongJob(root, jobId);
  if (record.state !== "ARMED") throw new Error(`long job: start requires ARMED, got ${record.state}`);
  prepareAttemptFiles(record);
  const next = transition(record, "RUNNING", at);
  next.runtime = { runner_pid: runnerPid };
  writeRecord(next);
  return next;
}

export function recordLongJobChildPid(root: string, jobId: string, attempt: number, childPid: number): LongJobRecord {
  const record = readLongJob(root, jobId);
  if (record.state !== "RUNNING" || record.attempt !== attempt) throw new Error("long job: stale child pid update");
  const next = { ...record, runtime: { runner_pid: record.runtime?.runner_pid ?? process.pid, child_pid: childPid } };
  writeRecord(next);
  return next;
}

export function finishLongJob(root: string, jobId: string, attempt: number, result: unknown, at?: string): LongJobRecord {
  const record = readLongJob(root, jobId);
  if (record.state !== "RUNNING" || record.attempt !== attempt) throw new Error("long job: stale or non-running finish");
  const timestamp = iso(at);
  const exitContent = `${JSON.stringify({ job_id: record.job_id, attempt, exit_code: 0, at: timestamp })}\n`;
  const doneContent = `${JSON.stringify({ job_id: record.job_id, attempt, state: "FINISHED" })}\n`;
  const log = readNormalArtifact(record, record.paths.log, "log");
  atomicWrite(record.paths.result, `${JSON.stringify({ job_id: record.job_id, attempt, completed_at: timestamp, result }, null, 2)}\n`);
  atomicWrite(record.paths.exit, exitContent);
  const next = transition(record, "FINISHED", timestamp);
  next.attempt_artifacts = { attempt, log_digest: contentDigest(log), exit_digest: contentDigest(exitContent), done_digest: contentDigest(doneContent) };
  writeRecord(next);
  atomicWrite(record.paths.done, doneContent);
  return next;
}

export function failLongJob(root: string, jobId: string, attempt: number, reason: string, exitCode = 1, at?: string): LongJobRecord {
  const record = readLongJob(root, jobId);
  if (record.state !== "RUNNING" || record.attempt !== attempt) throw new Error("long job: stale or non-running failure");
  const timestamp = iso(at);
  if (!Number.isInteger(exitCode)) throw new Error("long job: failure exit code must be an integer");
  const exitContent = `${JSON.stringify({ job_id: record.job_id, attempt, exit_code: exitCode, reason, at: timestamp })}\n`;
  const doneContent = `${JSON.stringify({ job_id: record.job_id, attempt, state: "FAILED" })}\n`;
  const log = readNormalArtifact(record, record.paths.log, "log");
  atomicWrite(record.paths.exit, exitContent);
  const next = transition(record, "FAILED", timestamp);
  next.failure = { reason, recoverable: true, exit_code: exitCode };
  next.attempt_artifacts = { attempt, log_digest: contentDigest(log), exit_digest: contentDigest(exitContent), done_digest: contentDigest(doneContent) };
  writeRecord(next);
  atomicWrite(record.paths.done, doneContent);
  return next;
}

interface AttemptAuditFile {
  status: "present" | "unknown/missing observed";
  digest: string | null;
  archive_file: string | null;
}

interface AttemptAuditManifest {
  schema: "garelier.long-job-attempt-audit";
  version: 1;
  job_id: string;
  attempt: number;
  state: "FAILED" | "RUNNING";
  record_updated_at: string;
  command_digest: string;
  cwd: string;
  cwd_identity: string;
  processes: {
    runner_pid: { pid: number | null; status: "dead observed" | "unknown/missing observed" };
    child_pid: { pid: number | null; status: "dead observed" | "unknown/missing observed" };
  };
  files: Record<"record" | "log" | "exit" | "done", AttemptAuditFile>;
}

function parseAuditJson(content: Buffer, label: string): Record<string, unknown> {
  try { return JSON.parse(content.toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error(`long job BLOCK: ${label} is not valid JSON`); }
}

function attemptAudit(record: LongJobRecord, isAlive: (pid: number) => boolean): { manifest: AttemptAuditManifest; contents: Map<string, Buffer>; path: string } {
  if (record.state !== "FAILED" && record.state !== "RUNNING") throw new Error("long job BLOCK: only FAILED or stale RUNNING attempts can be audited for rearm");
  const auditedState = record.state;
  const root = dirname(dirname(record.paths.record));
  const jobDir = dirname(record.paths.record);
  if (canonicalDirectoryIdentity(record.cwd, "cwd/worktree") !== record.cwd_identity) throw new Error("long job BLOCK: cwd/worktree canonical identity mismatch");
  loadVerifiedLongJobCommand(record);

  const processObservation = (name: "runner_pid" | "child_pid", value: unknown) => {
    if (value === undefined) return { pid: null, status: "unknown/missing observed" as const };
    if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`long job BLOCK: invalid ${name}`);
    const pid = value as number;
    if (isAlive(pid)) throw new Error(`long job BLOCK: live orphan/runner pid remains (${pid})`);
    return { pid, status: "dead observed" as const };
  };
  const runner = processObservation("runner_pid", record.runtime?.runner_pid);
  const child = processObservation("child_pid", record.runtime?.child_pid);

  const recordContent = readNormalArtifact(record, record.paths.record, "record");
  const logContent = readNormalArtifact(record, record.paths.log, "log");
  const exitContent = existsSync(record.paths.exit) ? readNormalArtifact(record, record.paths.exit, "exit") : null;
  const doneContent = existsSync(record.paths.done) ? readNormalArtifact(record, record.paths.done, "done") : null;
  if (record.state === "FAILED") {
    if (!record.failure || !record.attempt_artifacts || record.attempt_artifacts.attempt !== record.attempt) throw new Error("long job BLOCK: FAILED attempt lacks trusted terminal artifact digests");
    if (!exitContent || !doneContent) throw new Error("long job BLOCK: FAILED attempt is missing exit/done artifacts");
    if (contentDigest(logContent) !== record.attempt_artifacts.log_digest || contentDigest(exitContent) !== record.attempt_artifacts.exit_digest || contentDigest(doneContent) !== record.attempt_artifacts.done_digest) {
      throw new Error("long job BLOCK: FAILED exit/done/log artifact digest mismatch");
    }
    const exit = parseAuditJson(exitContent, "exit");
    const done = parseAuditJson(doneContent, "done");
    if (exit.job_id !== record.job_id || exit.attempt !== record.attempt || exit.exit_code !== record.failure.exit_code || exit.reason !== record.failure.reason
      || done.job_id !== record.job_id || done.attempt !== record.attempt || done.state !== "FAILED") {
      throw new Error("long job BLOCK: FAILED record.failure and exit/done artifacts disagree");
    }
  } else {
    if (exitContent || doneContent || existsSync(record.paths.result)) throw new Error("long job BLOCK: stale RUNNING attempt has unexpected terminal artifacts");
  }

  const contents = new Map<string, Buffer>([["record.json", recordContent], ["job.log", logContent]]);
  if (exitContent) contents.set("exit.json", exitContent);
  if (doneContent) contents.set(".done", doneContent);
  const file = (name: string, content: Buffer | null): AttemptAuditFile => content
    ? { status: "present", digest: contentDigest(content), archive_file: name }
    : { status: "unknown/missing observed", digest: null, archive_file: null };
  const manifest: AttemptAuditManifest = {
    schema: "garelier.long-job-attempt-audit", version: 1, job_id: record.job_id, attempt: record.attempt,
    state: auditedState, record_updated_at: record.timestamps.updated_at, command_digest: record.command_digest,
    cwd: record.cwd, cwd_identity: record.cwd_identity,
    processes: { runner_pid: runner, child_pid: child },
    files: {
      record: file("record.json", recordContent), log: file("job.log", logContent),
      exit: file("exit.json", exitContent), done: file(".done", doneContent),
    },
  };
  const auditRoot = join(jobDir, "attempt-audits");
  if (!existsSync(auditRoot)) {
    try { mkdirSync(auditRoot); } catch { throw new Error("long job BLOCK: attempt audit root cannot be created exclusively"); }
  }
  canonicalNormalInside(root, auditRoot, "directory", "attempt audit root");
  return { manifest, contents, path: join(auditRoot, `attempt-${String(record.attempt).padStart(6, "0")}`) };
}

function persistAttemptAudit(record: LongJobRecord, isAlive: (pid: number) => boolean): string {
  const audit = attemptAudit(record, isAlive);
  const root = dirname(dirname(record.paths.record));
  const manifestContent = Buffer.from(`${JSON.stringify(audit.manifest, null, 2)}\n`);
  const expected = new Map(audit.contents);
  expected.set("manifest.json", manifestContent);
  if (existsSync(audit.path)) {
    canonicalNormalInside(root, audit.path, "directory", "attempt audit");
    const names = readdirSync(audit.path).sort();
    const expectedNames = [...expected.keys()].sort();
    if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error("long job BLOCK: existing attempt audit is incomplete or has unexpected files");
    for (const [name, content] of expected) {
      const archived = readNormalArtifact(record, join(audit.path, name), `attempt audit ${name}`);
      if (contentDigest(archived) !== contentDigest(content)) throw new Error("long job BLOCK: existing attempt audit differs from observed attempt");
    }
    return audit.path;
  }
  const auditRoot = dirname(audit.path);
  const stem = `.${audit.path.slice(auditRoot.length + 1)}.tmp-`;
  if (readdirSync(auditRoot).some((name) => name.startsWith(stem))) {
    throw new Error("long job BLOCK: incomplete attempt audit temp residue requires owner review");
  }
  const temporary = join(auditRoot, `${stem}${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(temporary);
    canonicalNormalInside(root, temporary, "directory", "attempt audit temporary directory");
    for (const [name, content] of expected) {
      const path = join(temporary, name);
      writeFileSync(path, content, { flag: "wx" });
      canonicalNormalInside(root, path, "file", `attempt audit ${name}`);
    }
    if (JSON.stringify(readdirSync(temporary).sort()) !== JSON.stringify([...expected.keys()].sort())) {
      throw new Error("long job BLOCK: attempt audit temporary directory is incomplete");
    }
    renameSync(temporary, audit.path);
    canonicalNormalInside(root, audit.path, "directory", "attempt audit");
    return audit.path;
  } catch (error) {
    if (existsSync(temporary)) {
      for (const name of expected.keys()) {
        const path = join(temporary, name);
        try { if (existsSync(path)) unlinkSync(path); } catch { /* exact temp residue is BLOCKed on retry */ }
      }
      try { rmdirSync(temporary); } catch { /* exact temp residue is BLOCKed on retry */ }
    }
    if (existsSync(audit.path)) return persistAttemptAudit(record, isAlive);
    throw error;
  }
}

export function rearmWholeCommand(
  root: string,
  jobId: string,
  at?: string,
  isAlive: (pid: number) => boolean = pidAlive,
  afterAudit?: (auditPath: string) => void,
): LongJobRecord {
  const record = readLongJob(root, jobId);
  if (record.state !== "FAILED" && record.state !== "RUNNING") throw new Error("long job: recovery rearm requires FAILED or stale RUNNING");
  const auditPath = persistAttemptAudit(record, isAlive);
  afterAudit?.(auditPath);
  const timestamp = iso(at);
  const next: LongJobRecord = {
    ...record,
    state: "ARMED",
    attempt: record.attempt + 1,
    timestamps: { created_at: record.timestamps.created_at, updated_at: timestamp, armed_at: timestamp },
  };
  delete next.failure;
  delete next.runtime;
  delete next.attempt_artifacts;
  writeRecord(next);
  return next;
}

export function acknowledgeLongJob(root: string, jobId: string, attempt: number, at?: string): LongJobRecord {
  const record = readLongJob(root, jobId);
  if (record.state === "ACKED" && record.attempt === attempt) return record;
  if ((record.state !== "FINISHED" && record.state !== "FAILED") || record.attempt !== attempt) {
    throw new Error("long job: ACK requires exact terminal attempt");
  }
  const timestamp = iso(at);
  atomicWrite(record.paths.ack, `${JSON.stringify({ job_id: record.job_id, attempt, acked_at: timestamp, terminal_state: record.state })}\n`);
  const next = transition(record, "ACKED", timestamp);
  writeRecord(next);
  return next;
}

function retirementEvidence(record: LongJobRecord, dispatchId: string, at?: string): string {
  const root = dirname(dirname(record.paths.record));
  const path = join(dirname(record.paths.record), "retirement.json");
  if (existsSync(path)) {
    canonicalNormalInside(root, path, "file", "retirement evidence");
    const existing = JSON.parse(readFileSync(path, "utf8")) as { dispatch_id?: unknown; record?: { job_id?: unknown; attempt?: unknown } };
    if (existing.dispatch_id !== dispatchId || existing.record?.job_id !== record.job_id || existing.record?.attempt !== record.attempt) {
      throw new Error("long job BLOCK: existing retirement evidence disagrees with dispatch record");
    }
    return path;
  }
  const payload = `${JSON.stringify({
    schema: "garelier.long-job-retirement-evidence",
    version: 1,
    retired_at: iso(at),
    dispatch_id: dispatchId,
    prior_state: record.state,
    record,
  }, null, 2)}\n`;
  writeFileSync(path, payload, { flag: "wx" });
  canonicalNormalInside(root, path, "file", "retirement evidence");
  return path;
}

/**
 * Retire only the terminal ledger entries owned by a dispatch before its
 * container is removed. The immutable per-job evidence copy makes the cleanup
 * observable; no record directory is silently deleted from the ledger.
 */
export function retireLongJobsForDispatch(root: string, dispatchId: string, at?: string): RetiredLongJob[] {
  const id = dispatchId.trim();
  if (!id) throw new Error("long job: dispatch id is required for retirement");
  const retired: RetiredLongJob[] = [];
  for (const record of inspectLongJobs(root).records) {
    if (record.dispatch_id !== id) continue;
    if (record.state === "ARMED" || record.state === "RUNNING") {
      throw new Error(`long job BLOCK: dispatch ${id} still owns live ${record.state} job ${record.job_id}`);
    }
    if (record.state !== "FINISHED" && record.state !== "FAILED" && record.state !== "ACKED") {
      throw new Error(`long job BLOCK: dispatch ${id} has unknown job state ${record.state}`);
    }
    const evidencePath = retirementEvidence(record, id, at);
    const priorState = record.state;
    if (record.state !== "ACKED") acknowledgeLongJob(root, record.job_id, record.attempt, at);
    retired.push({ job_id: record.job_id, attempt: record.attempt, prior_state: priorState, evidence_path: evidencePath });
  }
  return retired;
}

function resultAttempt(record: LongJobRecord): number | null {
  try {
    const result = JSON.parse(readFileSync(record.paths.result, "utf8")) as { attempt?: unknown };
    return typeof result.attempt === "number" ? result.attempt : null;
  } catch { return null; }
}

function executionIdentity(record: LongJobRecord): string {
  return JSON.stringify([record.command_digest, record.dispatch_id, record.agent_id, record.provider]);
}

function timestampMs(value: string | undefined, label: string): number {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) throw new Error(`long job BLOCK: invalid ${label} timestamp`);
  return parsed;
}

function verifyTimeline(record: LongJobRecord, terminal: "FAILED" | "ACKED"): { created: number; terminal: number } {
  const created = timestampMs(record.timestamps.created_at, "created_at");
  const armed = timestampMs(record.timestamps.armed_at, "armed_at");
  const started = timestampMs(record.timestamps.started_at, "started_at");
  const finished = terminal === "ACKED" ? timestampMs(record.timestamps.finished_at, "finished_at") : null;
  const ended = timestampMs(terminal === "ACKED" ? record.timestamps.acked_at : record.timestamps.failed_at, terminal === "ACKED" ? "acked_at" : "failed_at");
  const updated = timestampMs(record.timestamps.updated_at, "updated_at");
  const ordered = terminal === "ACKED"
    ? created <= armed && armed <= started && started <= finished! && finished! <= ended
    : created <= armed && armed <= started && started <= ended;
  if (!ordered || updated !== ended) throw new Error(`long job BLOCK: invalid ${terminal} timestamp order`);
  return { created, terminal: ended };
}

function verifyTerminalArtifacts(record: LongJobRecord, terminal: "FAILED" | "ACKED"): void {
  loadVerifiedLongJobCommand(record);
  if (!record.attempt_artifacts || record.attempt_artifacts.attempt !== record.attempt) {
    throw new Error(`long job BLOCK: ${terminal} attempt lacks trusted terminal artifact digests`);
  }
  const logContent = readNormalArtifact(record, record.paths.log, "log");
  const exitContent = readNormalArtifact(record, record.paths.exit, "exit");
  const doneContent = readNormalArtifact(record, record.paths.done, "done");
  if (contentDigest(logContent) !== record.attempt_artifacts.log_digest
    || contentDigest(exitContent) !== record.attempt_artifacts.exit_digest
    || contentDigest(doneContent) !== record.attempt_artifacts.done_digest) {
    throw new Error(`long job BLOCK: ${terminal} exit/done/log artifact digest mismatch`);
  }
  const exit = parseAuditJson(exitContent, "exit");
  const done = parseAuditJson(doneContent, "done");
  if (exit.job_id !== record.job_id || exit.attempt !== record.attempt || done.job_id !== record.job_id || done.attempt !== record.attempt) {
    throw new Error(`long job BLOCK: ${terminal} terminal artifacts disagree with record identity`);
  }
  if (terminal === "FAILED") {
    if (!record.failure || exit.exit_code !== record.failure.exit_code || exit.reason !== record.failure.reason || done.state !== "FAILED") {
      throw new Error("long job BLOCK: FAILED record.failure and exit/done artifacts disagree");
    }
    return;
  }
  const ack = parseAuditJson(readNormalArtifact(record, record.paths.ack, "ack"), "ack");
  if (ack.job_id !== record.job_id || ack.attempt !== record.attempt || ack.acked_at !== record.timestamps.acked_at) {
    throw new Error("long job BLOCK: ACKED result/ack artifacts disagree with record");
  }
  if (ack.terminal_state === "FAILED") {
    if (!record.failure || exit.exit_code !== record.failure.exit_code || exit.reason !== record.failure.reason || done.state !== "FAILED") {
      throw new Error("long job BLOCK: ACKED retirement artifacts do not prove the FAILED attempt");
    }
    return;
  }
  if (ack.terminal_state !== "FINISHED" || record.failure || exit.exit_code !== 0 || done.state !== "FINISHED") {
    throw new Error("long job BLOCK: ACKED exit/done artifacts do not prove success");
  }
  const result = parseAuditJson(readNormalArtifact(record, record.paths.result, "result"), "result");
  if (result.job_id !== record.job_id || result.attempt !== record.attempt || result.completed_at !== record.timestamps.finished_at) {
    throw new Error("long job BLOCK: ACKED result artifacts disagree with record");
  }
}

function supersededFailedJobs(records: LongJobRecord[]): { superseded: Set<string>; issues: RecoveryItem[] } {
  const ackedByIdentity = new Map<string, LongJobRecord[]>();
  for (const record of records) {
    if (record.state !== "ACKED" || record.failure) continue;
    const key = executionIdentity(record);
    const bucket = ackedByIdentity.get(key) ?? [];
    bucket.push(record);
    ackedByIdentity.set(key, bucket);
  }
  const superseded = new Set<string>();
  const issues: RecoveryItem[] = [];
  const issueKeys = new Set<string>();
  for (const failed of records) {
    if (failed.state !== "FAILED") continue;
    let failureTime: number;
    try {
      failureTime = verifyTimeline(failed, "FAILED").terminal;
      verifyTerminalArtifacts(failed, "FAILED");
    } catch (error) {
      const reason = `invalid FAILED supersession source: ${(error as Error).message}`;
      const key = `${failed.job_id}:${failed.attempt}:${reason}`;
      if (!issueKeys.has(key)) {
        issueKeys.add(key);
        issues.push({ job_id: failed.job_id, attempt: failed.attempt, action: "BLOCK_LEDGER_PATH", reason });
      }
      continue;
    }
    for (const successor of ackedByIdentity.get(executionIdentity(failed)) ?? []) {
      let timeline: { created: number; terminal: number };
      try { timeline = verifyTimeline(successor, "ACKED"); }
      catch (error) {
        const reason = `invalid ACKED supersession evidence: ${(error as Error).message}`;
        const key = `${successor.job_id}:${successor.attempt}:${reason}`;
        if (!issueKeys.has(key)) {
          issueKeys.add(key);
          issues.push({ job_id: successor.job_id, attempt: successor.attempt, action: "BLOCK_LEDGER_PATH", reason });
        }
        continue;
      }
      if (timeline.created <= failureTime) continue;
      try { verifyTerminalArtifacts(successor, "ACKED"); }
      catch (error) {
        const reason = `invalid ACKED supersession evidence: ${(error as Error).message}`;
        const key = `${successor.job_id}:${successor.attempt}:${reason}`;
        if (!issueKeys.has(key)) {
          issueKeys.add(key);
          issues.push({ job_id: successor.job_id, attempt: successor.attempt, action: "BLOCK_LEDGER_PATH", reason });
        }
        continue;
      }
      superseded.add(`${failed.job_id}:${failed.attempt}`);
    }
  }
  return { superseded, issues };
}

export function recoverLongJobs(root: string, nowMs = Date.now(), staleMs = 15 * 60_000): RecoveryItem[] {
  const inspection = inspectLongJobs(root);
  const actions: RecoveryItem[] = [...inspection.issues];
  const supersession = supersededFailedJobs(inspection.records);
  actions.push(...supersession.issues);
  const broker = inspectBrokerLock(root);
  const wake = inspectWakeLock(root);
  if (wake.state === "invalid") actions.push({ job_id: ".wake.lock", attempt: 0, action: "BLOCK_WAKE_LOCK", reason: wake.reason });
  if (existsSync(wakeHandoffPath(root)) && wake.state === "absent") actions.push({ job_id: ".wake.handoff", attempt: 0, action: "BLOCK_WAKE_LOCK", reason: "completion coalescer handoff requires retry" });
  for (let record of inspection.records) {
    if (record.state === "ARMED") {
      if (broker.state === "live") continue;
      if (broker.state === "invalid") actions.push({ job_id: record.job_id, attempt: record.attempt, action: "BLOCK_BROKER_LOCK", reason: broker.reason });
      else actions.push({ job_id: record.job_id, attempt: record.attempt, action: "START_BROKER", reason: broker.state === "stale" ? "stale-broker-owner" : "armed-without-broker-confirmation" });
      continue;
    }
    if (record.state === "FINISHED" || record.state === "FAILED") {
      if (record.state === "FAILED" && supersession.superseded.has(`${record.job_id}:${record.attempt}`)) continue;
      actions.push({ job_id: record.job_id, attempt: record.attempt, action: record.state === "FINISHED" ? "DRAIN" : "RERUN_WHOLE_COMMAND", reason: record.state.toLowerCase() });
      continue;
    }
    if (record.state !== "RUNNING") continue;
    if (resultAttempt(record) === record.attempt) {
      record = transition(record, "FINISHED");
      writeRecord(record);
      atomicWrite(record.paths.done, `${JSON.stringify({ job_id: record.job_id, attempt: record.attempt, state: "FINISHED", recovered: true })}\n`);
      actions.push({ job_id: record.job_id, attempt: record.attempt, action: "DRAIN", reason: "result-written-before-state-crash" });
      continue;
    }
    const started = Date.parse(record.timestamps.started_at ?? record.timestamps.updated_at);
    if (!Number.isFinite(started) || nowMs - started >= staleMs) {
      actions.push({ job_id: record.job_id, attempt: record.attempt, action: "RERUN_WHOLE_COMMAND", reason: "stale-running-no-result" });
    }
  }
  return actions;
}

export function dequeueArmedJobs(root: string, providerCaps: Record<string, number>): LongJobRecord[] {
  const records = listLongJobs(root);
  const running = new Map<string, number>();
  for (const record of records) if (record.state === "RUNNING") running.set(record.provider, (running.get(record.provider) ?? 0) + 1);
  const selected: LongJobRecord[] = [];
  for (const record of records) {
    if (record.state !== "ARMED") continue;
    const cap = Math.max(0, providerCaps[record.provider] ?? 1);
    const used = (running.get(record.provider) ?? 0) + selected.filter((item) => item.provider === record.provider).length;
    if (used < cap) selected.push(record);
  }
  return selected;
}

export interface WakeBatch { emitted: boolean; pending: number; epoch: string; payload_file: string }

interface WakePayload {
  schema: "garelier.long-job-wake";
  version: 2;
  epoch: string;
  generation: string;
  pending: number;
  at: string;
  lease_until: string;
  recovery?: RecoveryItem[];
}

function wakePayloadPath(root: string): string { return join(resolve(root), "wake-pending.json"); }
function readWakePayload(path: string): WakePayload | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as WakePayload;
    if (value.schema !== "garelier.long-job-wake" || value.version !== 2 || !value.epoch || !value.generation || !Number.isInteger(value.pending) || value.pending < 0) return null;
    return value;
  } catch { return null; }
}

function wakeRecovery(root: string): RecoveryItem[] {
  return recoverLongJobs(root).filter((item) => item.action === "DRAIN" || item.action === "RERUN_WHOLE_COMMAND");
}

function wakeGeneration(root: string, recovery: RecoveryItem[]): string {
  const states = new Map(listLongJobs(root).map((record) => [`${record.job_id}:${record.attempt}`, record.state]));
  const entries = recovery.map((item) => `${item.job_id}:${item.attempt}:${states.get(`${item.job_id}:${item.attempt}`) ?? item.action}`).sort();
  return `sha256:${createHash("sha256").update(entries.join("\n")).digest("hex")}`;
}

function writeComparedWakePayload(path: string, observed: WakePayload | null, next: WakePayload): void {
  const current = readWakePayload(path);
  if ((current?.epoch ?? "") !== (observed?.epoch ?? "") || (current?.generation ?? "") !== (observed?.generation ?? "")) {
    throw new Error("long job wake payload changed outside the owner lock");
  }
  atomicWrite(path, `${JSON.stringify(next)}\n`);
}

export function coalesceCompletionWake(root: string, at?: string, leaseMs = 60_000): WakeBatch {
  const base = canonicalLedgerRoot(root, true);
  const payload = wakePayloadPath(base);
  const owner = waitForWakeLock(base, at);
  try {
    const recovery = wakeRecovery(base);
    const pending = recovery.length;
    if (pending === 0) return { emitted: false, pending: 0, epoch: "", payload_file: payload };
    const existing = readWakePayload(payload);
    const generation = wakeGeneration(base, recovery);
    const observedAt = Date.parse(iso(at));
    const leaseUntil = Date.parse(existing?.lease_until ?? "");
    if (existing?.pending === pending && existing.generation === generation && Number.isFinite(leaseUntil) && leaseUntil > observedAt) {
      return { emitted: false, pending, epoch: existing.epoch, payload_file: payload };
    }
    const epoch = randomUUID();
    const emittedAt = iso(at);
    writeComparedWakePayload(payload, existing, { schema: "garelier.long-job-wake", version: 2, epoch, generation, pending, at: emittedAt, lease_until: new Date(Date.parse(emittedAt) + leaseMs).toISOString(), recovery });
    return { emitted: true, pending, epoch, payload_file: payload };
  } finally {
    releaseWakeLock(base, owner);
  }
}

export function drainLongJobs(
  root: string,
  consume: (record: LongJobRecord, result: unknown) => void,
  afterPass?: (pass: number) => void,
  beforeFinalRescan?: () => void,
  afterFinalRescan?: () => void,
): { acked: number; passes: number } {
  const base = canonicalLedgerRoot(root, true);
  let acked = 0;
  let passes = 0;
  const payload = wakePayloadPath(base);
  for (;;) {
    const pending = listLongJobs(base).filter((record) => record.state === "FINISHED");
    if (pending.length === 0) break;
    passes++;
    for (const record of pending) {
      let result: unknown = null;
      try { result = JSON.parse(readFileSync(record.paths.result, "utf8")); } catch { result = { failure: record.failure ?? null }; }
      consume(record, result);
      acknowledgeLongJob(base, record.job_id, record.attempt);
      acked++;
    }
    afterPass?.(passes);
  }
  beforeFinalRescan?.();
  const owner = waitForWakeLock(base);
  try {
    const observed = readWakePayload(payload);
    let recovery = wakeRecovery(base);
    afterFinalRescan?.();
    const refreshed = wakeRecovery(base);
    if (wakeGeneration(base, refreshed) !== wakeGeneration(base, recovery)) recovery = refreshed;
    const generation = wakeGeneration(base, recovery);
    const timestamp = iso();
    writeComparedWakePayload(payload, observed, {
      schema: "garelier.long-job-wake", version: 2, epoch: randomUUID(), generation,
      pending: recovery.length, at: timestamp, lease_until: "1970-01-01T00:00:00.000Z", recovery,
    });
    return { acked, passes };
  } finally {
    releaseWakeLock(base, owner);
  }
}
