// W-343: bounded integration closure primitive.
//
// A closure lease lets an origin merge that opts in via an immutable
// `closure_intent` hold one `studio` lineage closed to UNRELATED writes from
// the moment its merge lands until Smith/runtime verification finishes,
// without blocking, mutating, or reordering any unrelated queued request.
//
// Absent an active closure record for a studio branch — true for every
// request in the fleet today, since nothing yet constructs a `closure_intent`
// — every chokepoint exported here is a pure pass-through: `assertChokepointAllowed`
// and `assertFinalizeOrderOk` return "allowed"/no-op immediately. Wiring these
// into the merge-gate entry points is therefore a zero-observable-behavior-change
// change for all current traffic (blueprint FR3), while making the primitive
// itself real, CAS-safe, and unit-tested.
//
// Scope implemented in this dispatch (see the W-343 PP-1 worker report for the
// exact CL-1..CL-5 mapping and what remains):
//   - versioned CAS `state.json` + append-only terminal history (FR1, FR12)
//   - acquire / inspect / heartbeat / bind / activate / close / recover as
//     CAS-safe operations, each re-verifying (lease_id, nonce, fencing_epoch,
//     phase, record_digest) before any write (FR2)
//   - a coordinator-first `withCoordinatorLock` every mutating op runs inside,
//     reusing this codebase's existing wx-create + process_start_identity
//     dead-owner reclaim convention (see land_aftercare.ts) (FR4)
//   - monotonic fencing-epoch allocation, checked, permanently fail-closed on
//     exhaustion (FR12)
//   - bounded, non-extendable deadlines: default 2h, maximum 4h (FR8)
//   - a conservative owner-reclaim policy: dead pid + same host + expired
//     deadline + a stable double read of the record before reclaim; foreign
//     host, missing, or malformed owners are never auto-reclaimed (FR10)
//   - pass-through enforcement guards for the named chokepoints (FR5, FR9)
//
// W-346 (the follow-up package W-343 deferred to) completes the remainder:
//   - the successor-reservation payload protocol (FR6): a request id is
//     reserved BEFORE the payload exists, the immutable payload+digest is CAS
//     slot-bound and fsync-published inside ONE coordinator critical section,
//     a bind-then-crash leaves `reserved_unpublished` retryable only by the
//     same id+digest, and every Smith/recovery allowlist identity is
//     digest-bound (closes the self-declared-id spoof, Observer O-1)
//   - chokepoint enforcement at every named entry (FR5): scripts/merge-gate.ts
//     itself, merge_request submit, merge_land, dock_integrate, watchdog
//     abort, dispatch_cleanup and land_aftercare finalize-order — direct CLI
//     invocation can no longer bypass the guard
//   - pollMergeGate's placeholder-before-spawn restructure (FR4/FR13): the
//     atomic `active.lock` placeholder is created BEFORE the child spawn and
//     the child adopts it by exact nonce; the ambiguous-owner fail-open in the
//     active-lock classifier is retired (fail-closed)
//   - the FR10 second factor is supplied: `systemSameProcessStillRunning`
//     probes the real OS process start time (PowerShell Get-Process StartTime
//     on Windows, `ps -o lstart=` on POSIX) and is the reclaim default
//   - the terminal-history ordinal is a prune-resistant monotonic counter
//     persisted in `state.json` (`last_history_ordinal`), not a count of
//     prunable files (Guardian N11)
// Fence note (Guardian N16): destructive fs calls here route through
// guard/path_guard.ts, so they are cwd-sensitive — a driver process whose cwd
// is outside every fence root (repo root, tmpdir, GARELIER_* roots) throws
// where raw node:fs would have succeeded. That is the repo-wide convention.

import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
// W-343 REWORK M6: the driver's path_guard lint (src/scripts/path_guard_lint.ts)
// forbids importing a destructive node:fs binding directly outside guard/path_guard.ts
// itself — every destructive call goes through its fence (cwd/repo-root/tmpdir/
// configured roots, depth >= 3, no `.git` component) instead. Delete/rename here
// only ever target paths this module itself constructed under
// `runtime/merge_gate/closure/`, so the fence is always satisfied; this changes
// no behavior, only the import source.
import { renameSync, unlinkSync } from "./guard/path_guard.ts";
import { fsyncSync } from "node:fs";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { resolveCommand, resolveRuntimeExecutable } from "./scripts/_lib.ts";

// ---------------------------------------------------------------------------
// Bounds (FR1: "全文字列/配列/履歴は上限を持ち…拒否する").

export const DEFAULT_DEADLINE_MS = 2 * 60 * 60 * 1000;
export const MAX_DEADLINE_MS = 4 * 60 * 60 * 1000;
export const MAX_SUCCESSOR_SLOTS = 8;
export const MAX_ALLOWED_REQUESTS = 8;
export const MAX_STRING_LEN = 512;
export const MAX_STATE_BYTES = 65536;
export const MAX_SUCCESSOR_PAYLOAD_BYTES = 262144;
export const MAX_RECOVERY_RESERVATIONS = 1;
export const MAX_HISTORY_ENTRY_BYTES = 8192;
export const MAX_FENCING_EPOCH = Number.MAX_SAFE_INTEGER;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE_RE = /^[0-9a-f]{32,}$/; // >= 128 bit
const SHA_RE = /^[0-9a-f]{40,64}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const WORK_ID_RE = /^W-\d+$/;
const SESSION_ID_RE = /^[A-Za-z0-9_.-]{1,MAXLEN}$/.source.replace("MAXLEN", String(MAX_STRING_LEN));
const SESSION_ID_REGEXP = new RegExp(SESSION_ID_RE);

export type ClosurePhase =
  | "acquired"
  | "bound"
  | "active"
  | "activation_blocked"
  | "landed_pending_closure"
  | "expired_blocked"
  | "closed"
  | "recovered";

const VALID_PHASES: ReadonlySet<ClosurePhase> = new Set([
  "acquired", "bound", "active", "activation_blocked",
  "landed_pending_closure", "expired_blocked", "closed", "recovered",
]);

/** The set of phases in which an active closure record blocks unrelated writes. */
const BLOCKING_PHASES: ReadonlySet<ClosurePhase> = new Set([
  "active", "activation_blocked", "landed_pending_closure", "expired_blocked",
]);

export type SuccessorSlotKind = "smith" | "recovery";
export type SuccessorReservationState = "reserved_unpublished" | "published";

/** W-346 FR6: a digest-bound successor identity. The ONLY way onto a closure
 * lease's allowlist — there is no digestless entry, so an id copied off a
 * queue filename can never impersonate a reserved successor (Observer O-1). */
export interface SuccessorReservation {
  slot_kind: SuccessorSlotKind;
  request_id: string;
  payload_digest: string;
  owner_session: string;
  state: SuccessorReservationState;
  reserved_at: string;
}

export interface ClosureRecord {
  schema_version: 1;
  lease_id: string;
  nonce: string;
  fencing_epoch: number;
  studio_branch: string;
  base_sha: string;
  current_sha: string;
  expected_sha: string;
  origin_request_digest: string;
  origin_result_digest: string | null;
  owner_session: string;
  hostname: string;
  pid: number;
  process_start_identity: string;
  phase: ClosurePhase;
  heartbeat_at: string;
  deadline_at: string;
  renewal_count: number;
  successor_slots: number;
  successor_reservations: SuccessorReservation[];
  closure_work_id: string | null;
  created_at: string;
  record_digest: string;
}

export interface ClosureState {
  schema_version: 1;
  last_fencing_epoch: number;
  /** W-346 (Guardian N11): monotonic terminal-history ordinal source. Persisted
   * here — never derived from the prunable history directory — so pruning can
   * never make a later entry reuse (and silently overwrite) a live ordinal. */
  last_history_ordinal: number;
  last_terminal_digest: string | null;
  active: ClosureRecord | null;
}

export interface ClosureTerminalEntry {
  schema_version: 1;
  lease_id: string;
  fencing_epoch: number;
  phase: ClosurePhase;
  reason: string;
  prev_digest: string | null;
  digest: string;
  closed_at: string;
}

export interface ClosureIntent {
  owner_session: string;
  closure_work_id?: string | null;
  base_studio_sha: string;
  origin_request_digest: string;
  max_deadline_ms?: number;
  successor_slots?: number;
  protocol_version?: 1;
}

export interface ClosureFence {
  lease_id: string;
  nonce: string;
  fencing_epoch: number;
}

export interface ClosurePaths {
  root: string;
  statePath: string;
  historyDir: string;
  coordinatorLock: string;
}

export function closurePaths(projectRoot: string, pmId: string): ClosurePaths {
  const root = join(projectRoot, "__garelier", pmId, "runtime", "merge_gate", "closure");
  return {
    root,
    statePath: join(root, "state.json"),
    historyDir: join(root, "history"),
    coordinatorLock: join(root, "coordinator.lock"),
  };
}

// ---------------------------------------------------------------------------
// Canonical digest (tamper-evidence for the CAS record).

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function recordDigest(recordWithoutDigest: Omit<ClosureRecord, "record_digest">): string {
  return sha256Hex(canonicalJson(recordWithoutDigest));
}

// ---------------------------------------------------------------------------
// Safe, stable JSON reads (mirrors merge_gate.ts's own retention-read pattern:
// reject a symlink/non-regular/oversize target, then verify the file's
// identity + bytes are unchanged between open and read so a concurrent
// writer can never hand back a torn read).

function readStableJsonFile(path: string, maxBytes: number, label: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  if (before.size > BigInt(maxBytes)) throw new Error(`${label} exceeds ${maxBytes} bytes: ${path}`);
  const fd = openSync(path, "r");
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`${label} identity changed while opening: ${path}`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
      throw new Error(`${label} changed during read: ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`${label} is not valid JSON: ${path}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object: ${path}`);
    return parsed as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

function writeAtomic(finalPath: string, dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  writeFileSync(tmp, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    renameSync(tmp, finalPath);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best-effort private temp cleanup */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Validation (fail-closed; never coerce/repair a malformed record).

function assertBoundedString(value: unknown, label: string, re?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LEN) {
    throw new Error(`${label} must be a non-empty string of at most ${MAX_STRING_LEN} chars`);
  }
  if (re && !re.test(value)) throw new Error(`${label} has an invalid shape: ${value}`);
  return value;
}

function assertBoundedArray<T>(value: unknown, label: string, max: number): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array of at most ${max} entries`);
  return value as T[];
}

/** W-343 REWORK N5 (diagnostic secrecy): bounds and sanitizes an arbitrary,
 * possibly-attacker-controlled value before it can be interpolated into a
 * thrown error message — those messages flow into refusal `reason` strings
 * that reach an agent-read log (`merge_gate.ts`'s `merge_gate_closure_blocked`).
 * Caps length well under the record/state byte ceilings and replaces any
 * non-printable-ASCII character so control sequences / log injection cannot
 * ride along with a corrupt state file. */
function sanitizeForDiagnostic(value: unknown, maxLen = 64): string {
  const text = typeof value === "string" ? value : String(value);
  return text.slice(0, maxLen).replace(/[^\x20-\x7e]/g, "?");
}

function assertSafeInt(value: unknown, label: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${label} must be a safe integer >= ${min}`);
  }
  return value;
}

export function validateIntent(intent: ClosureIntent): Required<ClosureIntent> {
  assertBoundedString(intent.owner_session, "closure_intent.owner_session", SESSION_ID_REGEXP);
  assertBoundedString(intent.base_studio_sha, "closure_intent.base_studio_sha", SHA_RE);
  assertBoundedString(intent.origin_request_digest, "closure_intent.origin_request_digest", DIGEST_RE);
  const closureWorkId = intent.closure_work_id ?? null;
  if (closureWorkId !== null) assertBoundedString(closureWorkId, "closure_intent.closure_work_id", WORK_ID_RE);
  const maxDeadlineMs = intent.max_deadline_ms ?? DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(maxDeadlineMs) || maxDeadlineMs <= 0 || maxDeadlineMs > MAX_DEADLINE_MS) {
    throw new Error(`closure_intent.max_deadline_ms must be in (0, ${MAX_DEADLINE_MS}]`);
  }
  const successorSlots = intent.successor_slots ?? 0;
  if (!Number.isInteger(successorSlots) || successorSlots < 0 || successorSlots > MAX_SUCCESSOR_SLOTS) {
    throw new Error(`closure_intent.successor_slots must be an integer in [0, ${MAX_SUCCESSOR_SLOTS}]`);
  }
  const protocolVersion = intent.protocol_version ?? 1;
  if (protocolVersion !== 1) throw new Error("closure_intent.protocol_version must be 1");
  return {
    owner_session: intent.owner_session,
    closure_work_id: closureWorkId,
    base_studio_sha: intent.base_studio_sha,
    origin_request_digest: intent.origin_request_digest,
    max_deadline_ms: maxDeadlineMs,
    successor_slots: successorSlots,
    protocol_version: 1,
  };
}

/** Queue-filename-safe request id (the reservation id becomes `<id>.json`). */
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

function validateReservationShape(raw: Record<string, unknown>, label: string): SuccessorReservation {
  const slotKind = raw.slot_kind;
  if (slotKind !== "smith" && slotKind !== "recovery") throw new Error(`${label}.slot_kind must be smith or recovery`);
  const requestId = assertBoundedString(raw.request_id, `${label}.request_id`, SAFE_REQUEST_ID_RE);
  const payloadDigest = assertBoundedString(raw.payload_digest, `${label}.payload_digest`, DIGEST_RE);
  const ownerSession = assertBoundedString(raw.owner_session, `${label}.owner_session`, SESSION_ID_REGEXP);
  const state = raw.state;
  if (state !== "reserved_unpublished" && state !== "published") throw new Error(`${label}.state must be reserved_unpublished or published`);
  const reservedAt = assertBoundedString(raw.reserved_at, `${label}.reserved_at`);
  if (!Number.isFinite(Date.parse(reservedAt))) throw new Error(`${label}.reserved_at is not a valid timestamp`);
  return { slot_kind: slotKind, request_id: requestId, payload_digest: payloadDigest, owner_session: ownerSession, state, reserved_at: reservedAt };
}

function validateRecordShape(raw: Record<string, unknown>): ClosureRecord {
  if (raw.schema_version !== 1) throw new Error("closure record schema_version must be 1");
  const leaseId = assertBoundedString(raw.lease_id, "closure record lease_id", UUID_RE);
  const nonce = assertBoundedString(raw.nonce, "closure record nonce", NONCE_RE);
  const fencingEpoch = assertSafeInt(raw.fencing_epoch, "closure record fencing_epoch", 1);
  const studioBranch = assertBoundedString(raw.studio_branch, "closure record studio_branch");
  const baseSha = assertBoundedString(raw.base_sha, "closure record base_sha", SHA_RE);
  const currentSha = assertBoundedString(raw.current_sha, "closure record current_sha", SHA_RE);
  const expectedSha = assertBoundedString(raw.expected_sha, "closure record expected_sha", SHA_RE);
  const originRequestDigest = assertBoundedString(raw.origin_request_digest, "closure record origin_request_digest", DIGEST_RE);
  const originResultDigest = raw.origin_result_digest === null || raw.origin_result_digest === undefined
    ? null
    : assertBoundedString(raw.origin_result_digest, "closure record origin_result_digest", DIGEST_RE);
  const ownerSession = assertBoundedString(raw.owner_session, "closure record owner_session", SESSION_ID_REGEXP);
  const host = assertBoundedString(raw.hostname, "closure record hostname");
  const pid = assertSafeInt(raw.pid, "closure record pid", 1);
  const processStartIdentity = assertBoundedString(raw.process_start_identity, "closure record process_start_identity");
  const phase = raw.phase;
  if (typeof phase !== "string" || phase.length > 64 || !VALID_PHASES.has(phase as ClosurePhase)) {
    throw new Error(`closure record phase is invalid: ${sanitizeForDiagnostic(phase)}`);
  }
  const heartbeatAt = assertBoundedString(raw.heartbeat_at, "closure record heartbeat_at");
  if (!Number.isFinite(Date.parse(heartbeatAt))) throw new Error("closure record heartbeat_at is not a valid timestamp");
  const deadlineAt = assertBoundedString(raw.deadline_at, "closure record deadline_at");
  if (!Number.isFinite(Date.parse(deadlineAt))) throw new Error("closure record deadline_at is not a valid timestamp");
  const renewalCount = assertSafeInt(raw.renewal_count, "closure record renewal_count", 0);
  const successorSlots = assertSafeInt(raw.successor_slots, "closure record successor_slots", 0);
  if (successorSlots > MAX_SUCCESSOR_SLOTS) throw new Error(`closure record successor_slots exceeds ${MAX_SUCCESSOR_SLOTS}`);
  const successorReservations = assertBoundedArray<Record<string, unknown>>(raw.successor_reservations, "closure record successor_reservations", MAX_ALLOWED_REQUESTS)
    .map((entry, i) => validateReservationShape(entry, `closure record successor_reservations[${i}]`));
  const closureWorkId = raw.closure_work_id === null || raw.closure_work_id === undefined
    ? null
    : assertBoundedString(raw.closure_work_id, "closure record closure_work_id", WORK_ID_RE);
  const createdAt = assertBoundedString(raw.created_at, "closure record created_at");
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("closure record created_at is not a valid timestamp");
  const digest = assertBoundedString(raw.record_digest, "closure record record_digest", DIGEST_RE);

  const record: ClosureRecord = {
    schema_version: 1, lease_id: leaseId, nonce, fencing_epoch: fencingEpoch, studio_branch: studioBranch,
    base_sha: baseSha, current_sha: currentSha, expected_sha: expectedSha,
    origin_request_digest: originRequestDigest, origin_result_digest: originResultDigest,
    owner_session: ownerSession, hostname: host, pid, process_start_identity: processStartIdentity,
    phase: phase as ClosurePhase, heartbeat_at: heartbeatAt, deadline_at: deadlineAt, renewal_count: renewalCount,
    successor_slots: successorSlots, successor_reservations: successorReservations,
    closure_work_id: closureWorkId, created_at: createdAt, record_digest: digest,
  };
  const { record_digest: _digest, ...withoutDigest } = record;
  if (recordDigest(withoutDigest) !== digest) throw new Error("closure record digest does not match its own contents — refusing a tampered/corrupt record");
  return record;
}

export function validateState(raw: Record<string, unknown>): ClosureState {
  if (raw.schema_version !== 1) throw new Error("closure state schema_version must be 1");
  const lastFencingEpoch = assertSafeInt(raw.last_fencing_epoch, "closure state last_fencing_epoch", 0);
  const lastHistoryOrdinal = assertSafeInt(raw.last_history_ordinal, "closure state last_history_ordinal", 0);
  const lastTerminalDigest = raw.last_terminal_digest === null || raw.last_terminal_digest === undefined
    ? null
    : assertBoundedString(raw.last_terminal_digest, "closure state last_terminal_digest", DIGEST_RE);
  const active = raw.active === null || raw.active === undefined
    ? null
    : validateRecordShape(raw.active as Record<string, unknown>);
  if (active && active.fencing_epoch > lastFencingEpoch) throw new Error("closure state active.fencing_epoch exceeds last_fencing_epoch high-watermark");
  return { schema_version: 1, last_fencing_epoch: lastFencingEpoch, last_history_ordinal: lastHistoryOrdinal, last_terminal_digest: lastTerminalDigest, active };
}

function loadState(paths: ClosurePaths): ClosureState {
  const raw = readStableJsonFile(paths.statePath, MAX_STATE_BYTES, "closure state");
  if (!raw) return { schema_version: 1, last_fencing_epoch: 0, last_history_ordinal: 0, last_terminal_digest: null, active: null };
  return validateState(raw);
}

function saveState(paths: ClosurePaths, state: ClosureState): void {
  writeAtomic(paths.statePath, paths.root, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Coordinator lock (FR4: coordinator-first ordering). Reuses this codebase's
// existing wx-create + process_start_identity dead-owner convention (see
// `land_aftercare.ts`'s request lock) instead of inventing a new one.

export function processStartIdentity(): string {
  return `${hostname()}:${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`;
}

// ---------------------------------------------------------------------------
// W-346 AC-1 (FR10 second factor, Guardian N3/N10): a REAL cross-process
// start-time probe, so `process_start_identity` is finally consulted instead of
// only recorded. Direction of safety is unchanged: a positive confirmation that
// the recorded process is STILL the one running only ever ADDS a reclaim
// refusal; every probe failure returns false ("cannot positively confirm"),
// which is exactly the pre-W-346 default behavior.

/** Self-measured start epochs (`Date.now() - uptime`) and OS-reported ones can
 * disagree by scheduler/rounding jitter; both are compared at second-class
 * resolution, so a generous fixed window is correct here. */
export const PROCESS_START_TOLERANCE_MS = 15_000;

export function parseProcessStartIdentity(identity: string): { host: string; pid: number; startMs: number } | null {
  const m = /^(.*):(\d+):(\d+)$/.exec(identity);
  if (!m) return null;
  const pid = Number(m[2]);
  const startMs = Number(m[3]);
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(startMs) || startMs <= 0) return null;
  return { host: m[1]!, pid, startMs };
}

/** The kernel's own record of a process's start, with no child process, no
 * PATH lookup and no human-readable date to parse: `/proc/<pid>/stat` field 22
 * is the start time in clock ticks since boot, and `/proc/stat`'s `btime` is
 * the boot instant in epoch seconds.
 *
 * W-756: this exists because the POSIX branch below was the ONLY side of this
 * probe that could fail for environmental reasons. The Windows branch resolves
 * its shell from a hard-coded System32 / Program Files location and reads a
 * structured API, so it answers even from a stripped environment; the POSIX
 * branch had to find `ps` on PATH (`ps` is not a declared runtime tool, and
 * _lib.ts's standard-location fallback is win32-only) and then parse a
 * locale-shaped `lstart` string. Every one of those returns null, and a null
 * start time is what `heavy_compile_lock`'s reclaim reads as
 * `identity-unconfirmed` — it then refuses to stop a genuinely stale holder and
 * the acquire loops to its caller timeout. Reading the numbers the kernel
 * already publishes removes the whole class rather than hardening one hop of
 * it. `ps` stays as the fallback for POSIX kernels without procfs.
 *
 * The returned epoch is second-class: `btime` is whole seconds, so two reads of
 * the same live process agree, but this value must never be compared to a
 * millisecond-precise one by equality (see PROCESS_START_TOLERANCE_MS). */
export function procfsProcessStartTimeMs(
  pid: number,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): number | null {
  try {
    // Field 2 (comm) is parenthesized and may itself contain spaces and
    // parentheses, so the fields are counted from the LAST ')'.
    const stat = read(`/proc/${pid}/stat`);
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    // stat fields are 1-based and `afterComm[0]` is field 3 (state), so field 22
    // (starttime) sits at index 19.
    const ticks = Number(afterComm[19]);
    if (!Number.isFinite(ticks) || ticks < 0) return null;
    const btime = Number(/^btime[ \t]+(\d+)$/m.exec(read("/proc/stat"))?.[1]);
    if (!Number.isSafeInteger(btime) || btime <= 0) return null;
    // USER_HZ is 100 on every Linux ABI this runs on and is not exposed to a
    // process without sysconf; the tick term is sub-second either way, and the
    // comparison tolerance covers it.
    const ms = btime * 1000 + Math.floor((ticks / 100) * 1000);
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/** Best-effort OS probe of another local process's start time (epoch ms), or
 * null when it cannot be determined. Windows: PowerShell Get-Process StartTime
 * (the factor named in W-346 AC-1). POSIX: the kernel's own `/proc` numbers
 * first, then `ps -p <pid> -o lstart=`. Bounded: at most one short-lived child
 * with a hard timeout, no shell interpolation of anything but the validated
 * numeric pid; executables go through the central absolute-path resolver
 * (tool_spawn lint) with windowsHide (W-112). */
export function systemProcessStartTimeMs(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === "win32") {
      // ToFileTimeUtc is timezone-unambiguous: 100ns intervals since 1601-01-01
      // UTC; the constant is the 1601→1970 epoch offset in milliseconds.
      const script = `[math]::Floor((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc() / 10000) - 11644473600000`;
      for (const shell of ["powershell", "pwsh"] as const) {
        const executable = resolveRuntimeExecutable(shell);
        if (!executable) continue;
        const r = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5_000, encoding: "utf8" });
        if (r.status === 0) {
          const ms = Number.parseFloat((r.stdout ?? "").trim());
          return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : null;
        }
        if (r.error === undefined) return null; // shell ran and said the pid has no readable start time
      }
      return null;
    }
    const fromProcfs = procfsProcessStartTimeMs(pid);
    if (fromProcfs !== null) return fromProcfs;
    const resolved = resolveCommand(["ps", "-p", String(pid), "-o", "lstart="]);
    if (!resolved) return null;
    const r = spawnSync(resolved[0]!, resolved.slice(1), { windowsHide: true, timeout: 5_000, encoding: "utf8" });
    if (r.status !== 0) return null;
    const parsed = Date.parse((r.stdout ?? "").trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** True ONLY when pid is provably the SAME process recorded at acquire: same
 * host, still present, and an OS-reported start time within tolerance of the
 * recorded one. Any parse/probe failure, foreign host, or start-time mismatch
 * (a recycled pid) returns false — never a positive identification. */
export function systemSameProcessStillRunning(pid: number, expectedProcessStartIdentity: string): boolean {
  const expected = parseProcessStartIdentity(expectedProcessStartIdentity);
  if (!expected || expected.pid !== pid || expected.host !== hostname()) return false;
  const observed = systemProcessStartTimeMs(pid);
  if (observed === null) return false;
  return Math.abs(observed - expected.startMs) <= PROCESS_START_TOLERANCE_MS;
}

const COORDINATOR_WAIT_BUDGET_MS = 5_000;
const COORDINATOR_RETRY_MS = 5;

interface CoordinatorLockBody { pid: number; host: string; nonce: string; process_start_identity: string; at: string }

function parseCoordinatorLock(path: string): CoordinatorLockBody | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CoordinatorLockBody>;
    if (typeof raw.pid !== "number" || typeof raw.host !== "string"
      || typeof raw.nonce !== "string" || raw.nonce.length === 0
      || typeof raw.process_start_identity !== "string" || raw.process_start_identity.length === 0
      || typeof raw.at !== "string") return null;
    return raw as CoordinatorLockBody;
  } catch {
    return null;
  }
}

function sameCoordinatorLockOwner(a: CoordinatorLockBody, b: CoordinatorLockBody): boolean {
  return a.pid === b.pid && a.host === b.host && a.nonce === b.nonce && a.process_start_identity === b.process_start_identity;
}

/** A coordinator lock is reclaimable only when it names THIS host and a pid
 * this host can prove is dead — a foreign host, or a lock this process
 * cannot parse, is `unknown` and is never auto-broken (FR10). */
function coordinatorLockReclaimable(owner: CoordinatorLockBody | null, isAlive: (pid: number) => boolean): boolean {
  if (!owner) return false; // unreadable/malformed => unknown => never reclaim
  if (owner.host !== hostname()) return false; // foreign host => unknown => never reclaim
  return !isAlive(owner.pid);
}

/** W-343 REWORK N1/N2: claims a dead-owner coordinator lock via an ATOMIC
 * rename-to-quarantine — mirroring `land_aftercare.ts`'s `claimStaleLockDirectory`
 * (`dispatch/land_aftercare.ts:995-1013`) instead of a bare `unlinkSync`. The OS
 * rename is the actual CAS: exactly one of two racing reclaimers' rename of the
 * SAME source path can succeed; the other observes the source gone (ENOENT) and
 * must back off, never delete anything. Re-parses the owner IMMEDIATELY before
 * the rename and compares the full tuple `(pid, host, nonce, process_start_identity)`
 * — if it changed (a live holder rewrote/renewed it, or a different reclaimer
 * already won), this refuses rather than silently reclaiming a lock that is no
 * longer the one it decided to reclaim. Returns without effect when the source
 * is already gone (a concurrent reclaimer won this race) — the caller's retry
 * loop then finds the path free and creates its own lock normally. */
function reclaimCoordinatorLock(path: string, expected: CoordinatorLockBody): void {
  const immediatelyBefore = parseCoordinatorLock(path);
  if (!immediatelyBefore) return; // already gone — a racing reclaimer won; nothing to do
  if (!sameCoordinatorLockOwner(immediatelyBefore, expected)) {
    throw new Error("integration_closure: coordinator lock owner changed before removal — refusing to reclaim");
  }
  const quarantine = `${path}.stale-${randomUUID()}`;
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // lost the race — someone else already claimed it
    throw error;
  }
  const claimed = parseCoordinatorLock(quarantine);
  if (!claimed || !sameCoordinatorLockOwner(claimed, expected)) {
    // W-346 (Guardian N12): name only the sibling file, never echo the absolute path.
    throw new Error(`integration_closure: coordinator lock identity changed during reclaim; preserved quarantine sibling: ${basename(quarantine)}`);
  }
  try { unlinkSync(quarantine); } catch { /* best-effort cleanup of the claimed tombstone */ }
}

/** Runs `fn` with the closure coordinator lock held. Every closure state
 * mutation (acquire/heartbeat/bind/activate/close/recover, epoch alloc)
 * happens inside this lock so a concurrent CAS reread can never race a write
 * (FR2, FR4). Held for microseconds of local file IO; a busy holder simply
 * means another mutation is briefly in flight, so the wait budget is small. */
export function withCoordinatorLock<T>(paths: ClosurePaths, isAlive: (pid: number) => boolean, fn: () => T): T {
  mkdirSync(paths.root, { recursive: true });
  const body: CoordinatorLockBody = { pid: process.pid, host: hostname(), nonce: randomBytes(8).toString("hex"), process_start_identity: processStartIdentity(), at: new Date().toISOString() };
  const serialized = JSON.stringify(body);
  const deadline = Date.now() + COORDINATOR_WAIT_BUDGET_MS;
  for (;;) {
    try {
      writeFileSync(paths.coordinatorLock, serialized, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = parseCoordinatorLock(paths.coordinatorLock);
      if (coordinatorLockReclaimable(owner, isAlive)) {
        reclaimCoordinatorLock(paths.coordinatorLock, owner!); // either wins or loses the race; either way retry wx-create
        continue;
      }
      if (Date.now() > deadline) throw new Error("integration_closure: coordinator lock contended past its wait budget — a live holder or an unknown/foreign owner is blocking it");
      const until = Date.now() + COORDINATOR_RETRY_MS;
      while (Date.now() < until) { /* short synchronous backoff before re-checking */ }
    }
  }
  try {
    return fn();
  } finally {
    // W-346 (Observer O-4): release only OUR OWN lock — re-verify the full owner
    // tuple immediately before the unlink, mirroring the reclaim discipline, so a
    // release racing a reclaim can never delete another holder's fresh lock.
    try {
      const current = parseCoordinatorLock(paths.coordinatorLock);
      if (current && sameCoordinatorLockOwner(current, body)) unlinkSync(paths.coordinatorLock);
    } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Fencing/CAS check shared by every mutating op.

function assertFence(active: ClosureRecord | null, fence: ClosureFence, label: string): ClosureRecord {
  if (!active) throw new Error(`${label}: no active closure lease exists`);
  if (active.lease_id !== fence.lease_id || active.nonce !== fence.nonce || active.fencing_epoch !== fence.fencing_epoch) {
    throw new Error(`${label}: fence mismatch (stale lease_id/nonce/fencing_epoch) — refusing to mutate`);
  }
  return active;
}

function isExpired(record: ClosureRecord, now: number): boolean {
  return Date.parse(record.deadline_at) <= now;
}

// ---------------------------------------------------------------------------
// Lifecycle operations. Every op takes `isAlive` so it is deterministically
// testable without a real second process.

export function acquireClosure(
  projectRoot: string, pmId: string, studioBranch: string, intent: ClosureIntent,
  isAlive: (pid: number) => boolean = () => true,
): ClosureRecord {
  const validated = validateIntent(intent);
  const paths = closurePaths(projectRoot, pmId);
  return withCoordinatorLock(paths, isAlive, () => {
    const state = loadState(paths);
    if (state.active) {
      // Idempotent same-origin retry (a caller crashed between acquiring and
      // reading its own response): return the identical existing lease
      // instead of erroring, but never mutate it.
      if (state.active.studio_branch === studioBranch
        && state.active.origin_request_digest === validated.origin_request_digest
        && state.active.base_sha === validated.base_studio_sha) {
        return state.active;
      }
      throw new Error(`integration_closure: studio '${studioBranch}' already has an active closure lease (lease_id=${state.active.lease_id})`);
    }
    if (state.last_fencing_epoch >= MAX_FENCING_EPOCH) throw new Error("integration_closure: fencing epoch exhausted — permanently fail-closed");
    const fencingEpoch = state.last_fencing_epoch + 1;
    const now = Date.now();
    const base: Omit<ClosureRecord, "record_digest"> = {
      schema_version: 1,
      lease_id: randomUUID(),
      nonce: randomBytes(16).toString("hex"),
      fencing_epoch: fencingEpoch,
      studio_branch: studioBranch,
      base_sha: validated.base_studio_sha,
      current_sha: validated.base_studio_sha,
      expected_sha: validated.base_studio_sha,
      origin_request_digest: validated.origin_request_digest,
      origin_result_digest: null,
      owner_session: validated.owner_session,
      hostname: hostname(),
      pid: process.pid,
      process_start_identity: processStartIdentity(),
      phase: "acquired",
      heartbeat_at: new Date(now).toISOString(),
      deadline_at: new Date(now + validated.max_deadline_ms).toISOString(),
      renewal_count: 0,
      successor_slots: validated.successor_slots,
      successor_reservations: [],
      closure_work_id: validated.closure_work_id,
      created_at: new Date(now).toISOString(),
    };
    const record: ClosureRecord = { ...base, record_digest: recordDigest(base) };
    saveState(paths, { ...state, last_fencing_epoch: fencingEpoch, active: record });
    return record;
  });
}

export function inspectClosure(projectRoot: string, pmId: string): ClosureRecord | null {
  return loadState(closurePaths(projectRoot, pmId)).active;
}

/** Updates liveness only. The deadline is fixed at acquire and is NEVER
 * extended (FR8: "取得後は延長不可"); `renewal_count` is bounded bookkeeping. */
export function heartbeatClosure(
  projectRoot: string, pmId: string, fence: ClosureFence,
  isAlive: (pid: number) => boolean = () => true,
): ClosureRecord {
  const paths = closurePaths(projectRoot, pmId);
  return withCoordinatorLock(paths, isAlive, () => {
    const state = loadState(paths);
    const active = assertFence(state.active, fence, "heartbeatClosure");
    if (isExpired(active, Date.now())) throw new Error("heartbeatClosure: lease deadline has already expired — recover or close it instead");
    const { record_digest: _d, ...rest } = active;
    const next: Omit<ClosureRecord, "record_digest"> = { ...rest, heartbeat_at: new Date().toISOString(), renewal_count: active.renewal_count + 1 };
    const record: ClosureRecord = { ...next, record_digest: recordDigest(next) };
    saveState(paths, { ...state, active: record });
    return record;
  });
}

/** FR3: binds the origin merge's result digest + new studio sha and moves to
 * `bound`. Callers activate separately (see `activateClosure`) so the
 * `(result write -> result digest bind -> closure active CAS)` ordering the
 * blueprint requires is explicit at the call site, not hidden in one op. */
export function bindClosureResult(
  projectRoot: string, pmId: string, fence: ClosureFence, resultDigest: string, newStudioSha: string,
  isAlive: (pid: number) => boolean = () => true,
): ClosureRecord {
  assertBoundedString(resultDigest, "bindClosureResult resultDigest", DIGEST_RE);
  assertBoundedString(newStudioSha, "bindClosureResult newStudioSha", SHA_RE);
  const paths = closurePaths(projectRoot, pmId);
  return withCoordinatorLock(paths, isAlive, () => {
    const state = loadState(paths);
    const active = assertFence(state.active, fence, "bindClosureResult");
    if (active.phase !== "acquired") throw new Error(`bindClosureResult: expected phase 'acquired', found '${active.phase}'`);
    const { record_digest: _d, ...rest } = active;
    const next: Omit<ClosureRecord, "record_digest"> = { ...rest, origin_result_digest: resultDigest, current_sha: newStudioSha, phase: "bound" };
    const record: ClosureRecord = { ...next, record_digest: recordDigest(next) };
    saveState(paths, { ...state, active: record });
    return record;
  });
}

/** FR3: the activation CAS itself — only after this returns may the caller
 * release the active merge slot / call self-drain. */
export function activateClosure(
  projectRoot: string, pmId: string, fence: ClosureFence,
  isAlive: (pid: number) => boolean = () => true,
): ClosureRecord {
  const paths = closurePaths(projectRoot, pmId);
  return withCoordinatorLock(paths, isAlive, () => {
    const state = loadState(paths);
    const active = assertFence(state.active, fence, "activateClosure");
    if (active.phase !== "bound") throw new Error(`activateClosure: expected phase 'bound', found '${active.phase}'`);
    const { record_digest: _d, ...rest } = active;
    const next: Omit<ClosureRecord, "record_digest"> = { ...rest, phase: "active" };
    const record: ClosureRecord = { ...next, record_digest: recordDigest(next) };
    saveState(paths, { ...state, active: record });
    return record;
  });
}

/** FR3: if the activation write itself fails after the merge already landed,
 * the caller records this tombstone under the SAME coordinator lock and must
 * fail-closed everything downstream (self-drain, all studio writes) until a
 * fenced recovery resolves it. */
export function markActivationBlocked(
  projectRoot: string, pmId: string, fence: ClosureFence, reason: string,
  isAlive: (pid: number) => boolean = () => true,
): ClosureRecord {
  assertBoundedString(reason, "markActivationBlocked reason");
  const paths = closurePaths(projectRoot, pmId);
  return withCoordinatorLock(paths, isAlive, () => {
    const state = loadState(paths);
    const active = assertFence(state.active, fence, "markActivationBlocked");
    const { record_digest: _d, ...rest } = active;
    const next: Omit<ClosureRecord, "record_digest"> = { ...rest, phase: "activation_blocked" };
    const record: ClosureRecord = { ...next, record_digest: recordDigest(next) };
    saveState(paths, { ...state, active: record });
    return record;
  });
}

export const DEFAULT_HISTORY_KEEP = 200;

/** FR12: "bounded history pruning" — never removes `state.json`'s own
 * high-watermark and always keeps the newest entry, so a restart can still
 * reconcile the most recent terminal digest. Filenames are zero-padded
 * epoch-prefixed, so lexicographic order is chronological order (same
 * convention `merge_gate.ts` uses for its own results/logs retention). */
export function pruneClosureHistory(paths: ClosurePaths, keep: number = DEFAULT_HISTORY_KEEP): string[] {
  if (!Number.isFinite(keep) || keep < 1 || !existsSync(paths.historyDir)) return [];
  const files = readdirSync(paths.historyDir).filter((f) => f.endsWith(".json")).sort();
  if (files.length <= keep) return [];
  const toRemove = files.slice(0, files.length - keep);
  const removed: string[] = [];
  for (const f of toRemove) {
    try { unlinkSync(join(paths.historyDir, f)); removed.push(f); } catch { /* best-effort */ }
  }
  return removed;
}

/** W-343 REWORK N4: the history filename prefix shared by every entry for one
 * `(fencing_epoch, lease_id)` pair — the epoch changes only on acquire, so a
 * single lease can produce several head transitions (e.g. reclaimed ->
 * expired_blocked, later -> closed) that all share this prefix. */
function historyFilePrefix(fencingEpoch: number, leaseId: string): string {
  return `${String(fencingEpoch).padStart(20, "0")}-${leaseId}`;
}

/** W-343 REWORK N4 + W-346 (Guardian N11): a UNIQUE filename per transition.
 * The ordinal comes from `state.json.last_history_ordinal + 1` — a monotonic
 * counter that survives history pruning — NOT from counting prefix-matching
 * files (a prunable population whose shrinkage could make the counter reuse a
 * live ordinal, the same silent-overwrite class N4 fixed). Runs inside the
 * coordinator lock (single writer). Returns the ordinal the caller MUST
 * persist into `state.json` in its subsequent state CAS; a crash between the
 * history write and that CAS is converged by the same-digest idempotency
 * check below (FR12: "history-onlyなら同じCASを完了"), and a colliding name
 * carrying a DIFFERENT digest advances forward rather than overwriting. */
function appendTerminalHistory(paths: ClosurePaths, entry: ClosureTerminalEntry, ordinal: number): number {
  const body = JSON.stringify(entry);
  if (Buffer.byteLength(body, "utf8") > MAX_HISTORY_ENTRY_BYTES) throw new Error("integration_closure: terminal history entry exceeds its byte cap");
  mkdirSync(paths.historyDir, { recursive: true });
  const prefix = historyFilePrefix(entry.fencing_epoch, entry.lease_id);
  let effective = ordinal;
  for (;;) {
    const target = join(paths.historyDir, `${prefix}-${String(effective).padStart(6, "0")}.json`);
    if (existsSync(target)) {
      try {
        const existing = JSON.parse(readFileSync(target, "utf8")) as Partial<ClosureTerminalEntry>;
        if (existing.digest === entry.digest) return effective; // crash-window replay of the SAME transition — already written
      } catch { /* unreadable existing entry — never overwrite it */ }
      effective += 1;
      continue;
    }
    writeAtomic(target, paths.historyDir, body);
    break;
  }
  try { pruneClosureHistory(paths); } catch { /* retention must never break a terminal write */ }
  return effective;
}

/** FR12: closes the lease. `(terminal history write -> state CAS active=null,
 * last_epoch/last_terminal_digest updated)`. Idempotent: if the state is
 * already closed for this exact lease (history entry present, active null),
 * this is a no-op success rather than an error. */
export function closeClosure(
  projectRoot: string, pmId: string, fence: ClosureFence, reason: string,
  isAlive: (pid: number) => boolean = () => true,
): { closed: true; already: boolean } {
  assertBoundedString(reason, "closeClosure reason");
  const paths = closurePaths(projectRoot, pmId);
  return withCoordinatorLock(paths, isAlive, () => {
    const state = loadState(paths);
    if (!state.active) {
      const prefix = `${historyFilePrefix(fence.fencing_epoch, fence.lease_id)}-`;
      const hasHistory = existsSync(paths.historyDir) && readdirSync(paths.historyDir).some((f) => f.startsWith(prefix));
      if (hasHistory) return { closed: true, already: true };
      throw new Error("closeClosure: no active lease and no matching terminal history — nothing to close");
    }
    const active = assertFence(state.active, fence, "closeClosure");
    const { record_digest: _d, ...rest } = active;
    const digest = recordDigest({ ...rest, phase: "closed" });
    const entry: ClosureTerminalEntry = {
      schema_version: 1, lease_id: active.lease_id, fencing_epoch: active.fencing_epoch, phase: "closed",
      reason, prev_digest: state.last_terminal_digest, digest, closed_at: new Date().toISOString(),
    };
    const ordinal = appendTerminalHistory(paths, entry, state.last_history_ordinal + 1);
    saveState(paths, { schema_version: 1, last_fencing_epoch: state.last_fencing_epoch, last_history_ordinal: ordinal, last_terminal_digest: digest, active: null });
    return { closed: true, already: false };
  });
}

/** FR11: re-verifies the origin/final SHA against the current studio ancestry
 * before deciding. Already-landed => idempotent close (no re-merge). Not yet
 * reachable => `expired_blocked`; only a successor published through the FR6
 * reservation protocol (`publishSuccessorRequest`, kind "recovery") may
 * progress further — recovery identities are digest-bound like every other
 * allowlist entry (W-346, closes Observer O-1's digestless side door). */
export function recoverClosure(
  projectRoot: string, pmId: string, fence: ClosureFence,
  isReachableInStudio: (sha: string) => boolean,
  isAlive: (pid: number) => boolean = () => true,
): { outcome: "closed" | "expired_blocked"; record?: ClosureRecord } {
  const paths = closurePaths(projectRoot, pmId);
  return withCoordinatorLock(paths, isAlive, () => {
    const state = loadState(paths);
    const active = assertFence(state.active, fence, "recoverClosure");
    if (isReachableInStudio(active.expected_sha) || isReachableInStudio(active.current_sha)) {
      const { record_digest: _d, ...rest } = active;
      const digest = recordDigest({ ...rest, phase: "recovered" });
      const entry: ClosureTerminalEntry = {
        schema_version: 1, lease_id: active.lease_id, fencing_epoch: active.fencing_epoch, phase: "recovered",
        reason: "origin/final SHA already reachable in studio — idempotent close, no re-merge",
        prev_digest: state.last_terminal_digest, digest, closed_at: new Date().toISOString(),
      };
      const ordinal = appendTerminalHistory(paths, entry, state.last_history_ordinal + 1);
      saveState(paths, { schema_version: 1, last_fencing_epoch: state.last_fencing_epoch, last_history_ordinal: ordinal, last_terminal_digest: digest, active: null });
      return { outcome: "closed" };
    }
    const { record_digest: _d, ...rest } = active;
    const next: Omit<ClosureRecord, "record_digest"> = { ...rest, phase: "expired_blocked" };
    const record: ClosureRecord = { ...next, record_digest: recordDigest(next) };
    saveState(paths, { ...state, active: record });
    return { outcome: "expired_blocked", record };
  });
}

// ---------------------------------------------------------------------------
// W-346 FR6: successor reservation + publish. A Smith / recovery successor is
// admitted onto a live closure ONLY through this protocol:
//   1. `reserveSuccessorRequestId()` — a random id chosen BEFORE any payload
//      exists (no payload content can influence id selection);
//   2. the caller builds the COMPLETE immutable payload in memory and hands it
//      to `publishSuccessorRequest`, which inside ONE coordinator critical
//      section performs `(slot CAS bind to request_id+payload_digest -> temp
//      fsync -> atomic queue rename -> published CAS)`;
//   3. a crash after the bind but before the publish leaves the entry
//      `reserved_unpublished`; ONLY the same (id, digest) may retry the
//      publish — a different payload is rejected; rollback of an unpublished
//      reservation needs the exact fence within the deadline, or the
//      dead-owner recovery CAS, and never counts the slot as consumed.

export function reserveSuccessorRequestId(): string {
  return `succ-${randomUUID()}`;
}

function mergeGateRequestsDir(projectRoot: string, pmId: string): string {
  return join(projectRoot, "__garelier", pmId, "runtime", "merge_gate", "requests");
}

function saveReservationCas(paths: ClosurePaths, state: ClosureState, active: ClosureRecord, reservations: SuccessorReservation[]): ClosureRecord {
  const { record_digest: _d, ...rest } = active;
  const next: Omit<ClosureRecord, "record_digest"> = { ...rest, successor_reservations: reservations };
  const record: ClosureRecord = { ...next, record_digest: recordDigest(next) };
  saveState(paths, { ...state, active: record });
  return record;
}

export function publishSuccessorRequest(
  projectRoot: string, pmId: string, fence: ClosureFence, kind: SuccessorSlotKind,
  requestId: string, payload: string,
  isAlive: (pid: number) => boolean = () => true,
): { record: ClosureRecord; published: boolean } {
  if (!SAFE_REQUEST_ID_RE.test(requestId)) throw new Error("publishSuccessorRequest: request id is not queue-filename-safe");
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes === 0 || payloadBytes > MAX_SUCCESSOR_PAYLOAD_BYTES) {
    throw new Error(`publishSuccessorRequest: payload must be 1..${MAX_SUCCESSOR_PAYLOAD_BYTES} bytes`);
  }
  const digest = sha256Hex(payload);
  const paths = closurePaths(projectRoot, pmId);
  return withCoordinatorLock(paths, isAlive, () => {
    const state = loadState(paths);
    const active = assertFence(state.active, fence, "publishSuccessorRequest");
    if (!BLOCKING_PHASES.has(active.phase)) {
      throw new Error(`publishSuccessorRequest: closure phase '${active.phase}' does not admit successors (pre-land lease)`);
    }
    const reservations = [...active.successor_reservations];
    let entryIndex = reservations.findIndex((r) => r.request_id === requestId);
    if (entryIndex >= 0) {
      const entry = reservations[entryIndex]!;
      // Same-id retry: ONLY the exact same (kind, digest) may complete a
      // bind-then-crash publish; a different payload is rejected unchanged.
      if (entry.slot_kind !== kind || entry.payload_digest !== digest) {
        throw new Error("publishSuccessorRequest: reservation exists with a DIFFERENT kind/payload digest — same-id retry requires the identical payload");
      }
    } else {
      const kindCount = reservations.filter((r) => r.slot_kind === kind).length;
      const capacity = kind === "smith" ? active.successor_slots : MAX_RECOVERY_RESERVATIONS;
      if (kindCount >= capacity) throw new Error(`publishSuccessorRequest: no free ${kind} successor slot (capacity ${capacity})`);
      if (reservations.length >= MAX_ALLOWED_REQUESTS) throw new Error("publishSuccessorRequest: reservation table is full");
      reservations.push({
        slot_kind: kind, request_id: requestId, payload_digest: digest,
        owner_session: active.owner_session, state: "reserved_unpublished", reserved_at: new Date().toISOString(),
      });
      entryIndex = reservations.length - 1;
    }
    // (a) slot CAS bind — persisted BEFORE the queue file exists.
    let record = saveReservationCas(paths, state, active, reservations);

    // (b) temp fsync + atomic queue rename. An existing final file must be the
    // byte-identical prior publish (crash between rename and the published
    // CAS); anything else is refused without touching it (FR7).
    const requestsDir = mergeGateRequestsDir(projectRoot, pmId);
    mkdirSync(requestsDir, { recursive: true });
    const finalPath = join(requestsDir, `${requestId}.json`);
    if (existsSync(finalPath)) {
      const existing = readFileSync(finalPath, "utf8");
      if (sha256Hex(existing) !== digest) {
        throw new Error("publishSuccessorRequest: a queue file already holds this id with DIFFERENT bytes — refusing to overwrite");
      }
    } else {
      const tmp = join(requestsDir, `.${requestId}.${randomUUID()}.tmp`);
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeFileSync(fd, payload, { encoding: "utf8" });
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(tmp, finalPath);
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* best-effort private temp cleanup */ }
        throw error;
      }
    }

    // (c) published CAS — the allowlist admits this identity only from here on.
    const bound = [...record.successor_reservations];
    const boundIndex = bound.findIndex((r) => r.request_id === requestId);
    if (boundIndex >= 0 && bound[boundIndex]!.state !== "published") {
      bound[boundIndex] = { ...bound[boundIndex]!, state: "published" };
      const reread = loadState(paths);
      const rereadActive = assertFence(reread.active, fence, "publishSuccessorRequest(published CAS)");
      record = saveReservationCas(paths, reread, rereadActive, bound);
    }
    return { record, published: true };
  });
}

export function rollbackSuccessorReservation(
  projectRoot: string, pmId: string, fence: ClosureFence, requestId: string,
  opts: { deadOwnerRecovery?: boolean; isAlive?: (pid: number) => boolean; now?: number } = {},
): ClosureRecord {
  const isAlive = opts.isAlive ?? (() => true);
  const paths = closurePaths(projectRoot, pmId);
  return withCoordinatorLock(paths, isAlive, () => {
    const state = loadState(paths);
    const active = assertFence(state.active, fence, "rollbackSuccessorReservation");
    const index = active.successor_reservations.findIndex((r) => r.request_id === requestId);
    if (index < 0) throw new Error("rollbackSuccessorReservation: no reservation with this request id");
    const entry = active.successor_reservations[index]!;
    if (entry.state !== "reserved_unpublished") {
      throw new Error("rollbackSuccessorReservation: only an UNPUBLISHED reservation can be rolled back");
    }
    const expired = isExpired(active, opts.now ?? Date.now());
    if (expired && !(opts.deadOwnerRecovery === true && !isAlive(active.pid))) {
      throw new Error("rollbackSuccessorReservation: after the deadline only a dead-owner recovery CAS may roll back");
    }
    const reservations = active.successor_reservations.filter((_, i) => i !== index);
    return saveReservationCas(paths, state, active, reservations); // slot NOT consumed
  });
}

// ---------------------------------------------------------------------------
// Dead-owner reclaim (FR10). Deliberately conservative: EVERY factor below
// must hold, and a foreign host, missing owner, or malformed record is always
// `unknown` and is never auto-reclaimed.

export interface ReclaimContext {
  now: number;
  isAlive: (pid: number) => boolean;
  hasActiveGateOrMergeHead: () => boolean;
  /** FR10 second factor. W-346 AC-1: the default is now the REAL OS probe
   * (`systemSameProcessStillRunning` — Get-Process StartTime on Windows,
   * `ps -o lstart=` on POSIX), so `process_start_identity` is consulted in
   * every configuration rather than merely recorded (Guardian N3/N10 closed).
   * Injectable for deterministic tests. Returning true only ever ADDS a
   * refusal; a probe failure returns false, which is byte-identical to the
   * pre-W-346 `() => false` behavior — eligibility is never widened. */
  sameProcessStillRunning?: (pid: number, expectedProcessStartIdentity: string) => boolean;
}

export function reclaimEligible(record: ClosureRecord, ctx: ReclaimContext): boolean {
  if (record.phase !== "acquired" && record.phase !== "bound" && record.phase !== "active" && record.phase !== "activation_blocked") {
    return false; // already expired_blocked/closed/recovered — dead-owner reclaim has nothing left to do
  }
  if (record.hostname !== hostname()) return false; // foreign host => unknown => never reclaim
  if (!isExpired(record, ctx.now)) return false; // deadline not yet expired
  if (ctx.isAlive(record.pid)) return false; // owner still alive
  if ((ctx.sameProcessStillRunning ?? systemSameProcessStillRunning)(record.pid, record.process_start_identity)) return false; // FR10 second factor (W-346 AC-1: real probe by default)
  if (ctx.hasActiveGateOrMergeHead()) return false; // a real merge/gate may still be in flight
  return true;
}

/** Attempts to reclaim a lease whose owner is dead. Re-reads the record AFTER
 * eligibility is decided (a stable reread) so a live heartbeat racing this
 * check loses the CAS instead of being silently overridden. */
export function attemptDeadOwnerReclaim(
  projectRoot: string, pmId: string, ctx: ReclaimContext,
): { reclaimed: boolean; reason: string } {
  const paths = closurePaths(projectRoot, pmId);
  return withCoordinatorLock(paths, ctx.isAlive, () => {
    const state = loadState(paths);
    if (!state.active) return { reclaimed: false, reason: "no active lease" };
    if (!reclaimEligible(state.active, ctx)) return { reclaimed: false, reason: "not eligible (live owner, unexpired deadline, foreign host, or an active gate/MERGE_HEAD)" };
    const reread = loadState(paths);
    if (!reread.active || reread.active.record_digest !== state.active.record_digest) {
      return { reclaimed: false, reason: "record changed during the stable reread — a live owner is acting on it" };
    }
    const active = reread.active;
    const { record_digest: _d, ...rest } = active;
    // W-343 REWORK N4: the entry's digest MUST be the POST-transition digest
    // (matching closeClosure/recoverClosure's convention) and `last_terminal_digest`
    // MUST advance to it so the NEXT entry's `prev_digest` chain does not skip
    // this transition — the prior code wrote the PRE-transition `active.record_digest`
    // into the entry and left `last_terminal_digest` untouched, silently dropping
    // this reclaim from the audit chain.
    const next: Omit<ClosureRecord, "record_digest"> = { ...rest, phase: "expired_blocked" };
    const digest = recordDigest(next);
    const record: ClosureRecord = { ...next, record_digest: digest };
    const entry: ClosureTerminalEntry = {
      schema_version: 1, lease_id: active.lease_id, fencing_epoch: active.fencing_epoch, phase: "expired_blocked",
      reason: "dead same-host owner reclaimed after deadline expiry (FR10)",
      prev_digest: state.last_terminal_digest, digest, closed_at: new Date().toISOString(),
    };
    const ordinal = appendTerminalHistory(paths, entry, state.last_history_ordinal + 1);
    saveState(paths, { schema_version: 1, last_fencing_epoch: state.last_fencing_epoch, last_history_ordinal: ordinal, last_terminal_digest: digest, active: record });
    return { reclaimed: true, reason: "dead-owner reclaim CAS complete; lease is now expired_blocked pending an allow-listed recovery request" };
  });
}

// ---------------------------------------------------------------------------
// Chokepoint enforcement (FR5). Every named entry point calls one of these
// two guards. Both are pure pass-through whenever no active closure record
// targets the caller's studio branch — the state for 100% of current fleet
// traffic — so wiring them in changes no observable behavior today.

export interface ChokepointContext {
  requestKind: "smith" | "recovery" | "ordinary";
  requestId?: string | null;
  /** W-346 FR6/O-1: sha256 hex of the EXACT request payload bytes. A
   * Smith/recovery identity is admitted only when this matches its published
   * reservation's `payload_digest`; an ordinary request matching the lease's
   * `origin_request_digest` is the origin itself (restart convergence, FR11)
   * and passes. */
  payloadDigest?: string | null;
}

export type ChokepointVerdict = { allowed: true } | { allowed: false; reason: string };

export function assertChokepointAllowed(
  projectRoot: string, pmId: string, studioBranch: string, ctx: ChokepointContext,
): ChokepointVerdict {
  const paths = closurePaths(projectRoot, pmId);
  let state: ClosureState;
  try {
    state = loadState(paths);
  } catch (error) {
    // W-346 (Observer O-2): a PRESENT-but-unreadable/malformed closure state is
    // tampering/corruption evidence and now fails closed for EVERY request kind
    // — the blueprint requires closure-time studio writes to be fail-closed,
    // and an ordinary pass-through here would let traffic mutate studio while a
    // live closure's record is corrupt. Today's fleet has no closure state
    // file at all (loadState returns the default), so this changes nothing for
    // ordinary traffic outside closure use.
    return { allowed: false, reason: `closure state unreadable/invalid — fail-closed for all requests until repaired or recovered: ${(error as Error).message}` };
  }
  const active = state.active;
  if (!active || active.studio_branch !== studioBranch) return { allowed: true };
  if (!BLOCKING_PHASES.has(active.phase)) return { allowed: true }; // pre-land (acquired/bound): does not yet block
  if (ctx.requestKind === "ordinary") {
    if (ctx.payloadDigest && ctx.payloadDigest === active.origin_request_digest) return { allowed: true }; // the origin request itself (FR11 restart convergence)
    return { allowed: false, reason: `studio '${studioBranch}' is under an active closure lease (lease_id=${active.lease_id}); unrelated requests wait unchanged until it closes` };
  }
  const entry = active.successor_reservations.find((r) => r.slot_kind === ctx.requestKind && r.request_id === ctx.requestId);
  if (!entry) return { allowed: false, reason: `request is not a reserved ${ctx.requestKind} successor on closure lease ${active.lease_id}` };
  if (entry.state !== "published") return { allowed: false, reason: `reserved successor '${entry.request_id}' is not yet published (reserved_unpublished)` };
  if (!ctx.payloadDigest || ctx.payloadDigest !== entry.payload_digest) {
    return { allowed: false, reason: `successor '${entry.request_id}' payload digest does not match its reservation — a copied allowlist id cannot pass (FR6/O-1)` };
  }
  return { allowed: true };
}

/** FR9: rejects finalize for `workId` while ITS bound closure lease has
 * landed but not yet closed/recovered. No-op (proceed) whenever no closure
 * targets this branch, or the active lease is not bound to this Work, or the
 * lease is still pre-land, or it has already closed. */
export function assertFinalizeOrderOk(projectRoot: string, pmId: string, studioBranch: string, workId: string): void {
  const paths = closurePaths(projectRoot, pmId);
  const state = loadState(paths);
  const active = state.active;
  if (!active || active.studio_branch !== studioBranch) return;
  if (active.closure_work_id !== workId) return;
  if (BLOCKING_PHASES.has(active.phase)) {
    throw new Error(
      `integration_closure: Backlog ${workId} finalize is deferred — its bound closure lease `
      + `(lease_id=${active.lease_id}, fencing_epoch=${active.fencing_epoch}, phase=${active.phase}) has not closed or recovered yet`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test-only export surface (kept minimal; used by merge_gate_lock.test.ts).

// W-346 (Guardian N13): frozen so a consumer cannot swap a probe for a mutator
// at runtime; `reclaimCoordinatorLock` stays exported ONLY for the N1/N2 race
// regression oracle, which needs to drive the reclaim CAS directly.
export const __internal = Object.freeze({
  readStableJsonFile, coordinatorLockReclaimable, isExpired,
  parseCoordinatorLock, reclaimCoordinatorLock, sameCoordinatorLockOwner,
});
