import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { optionalMachineString, tryParseMachineArtifact } from "./machine_artifact.ts";
import { parseDispatchResultState } from "./lane_status.ts";
import { isAttendedGcTerminal } from "./aftercare_terminal.ts";
import { crewSubdir } from "../workspace.ts";
import { loadConfig, MIN_PRESERVED_ARTIFACT_MAX_BYTES } from "../config.ts";
import { assertFinalizeOrderOk } from "../integration_closure.ts";
import { canonicalJson, sha256 } from "../control/serialization.ts";
import { assertNoSymlinkPath, atomicWriteRuntimeFile, ensureSafeDirectory } from "../control/diagnostics.ts";
import {
  acquireGarelierOperationGuard,
  garelierControlRoots,
  hasMergeControlEvidence,
  recordAftercarePreservationPublication,
  recordMergeControlOutcome,
} from "../control/garelier_integration.ts";
import {
  assertSafeLeaf,
  canonicalPath,
  createGuardedFileSync,
  detachReparsePoints,
  mkdirSync as guardedMkdirSync,
  removeTreeSync,
  renameSync,
  unlinkSync,
} from "../guard/path_guard.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";
import {
  bindingReference,
  acceptedRoleCommitTrailer,
  dispatchExecutionIdentity,
  hashRoleFile,
  roleBindingPaths,
  readCurrentRoleAuthorization,
  roleCommitTrailerWorkIds,
  roleBindingFromContext,
  ROLE_RECORD_KIND,
  ROLE_RECOVERY_ARCHIVE_RECORD_KIND,
  validateRoleBinding,
  isProviderTransport,
  type RoleBindingReference,
  type RoleCloseReference,
} from "./role_binding.ts";
// The recovered × transport admission decision has exactly one home; aftercare
// asks it rather than re-deriving "does this lane owe a session record".
import { dockProxyLaneShape, type DockProxyLaneShape } from "../scripts/dock_proxy.ts";
import { SESSION_SCHEMA, SESSION_VERSION } from "../scripts/provider_session.ts";
import { gateRunRecordPath, parseGateRunRecord, readGateRunRecord } from "./gate_run_record.ts";
import {
  digestReviewEvidence,
  dockReviewRecordPath,
  engineTreeHash,
  readDockReviewHandoffRecord,
  reviewEvidenceKey,
  reviewGateLogName,
} from "./dock_review_record.ts";
import {
  gateArtifactPreserveRoot,
  isKnownLaneArtifact,
  isKnownLaneEntry,
  laneArtifactsWrittenByRun,
  isPmStepGateLog,
  pmStepGateLogName,
  pruneGateRuntimeEvidence,
  summarizePmStepGateLog,
  summarizeGateRunForPreservation,
  verifiedGateLogRecoveryReceipt,
} from "./gate_step_artifacts.ts";
import {
  evaluatePreservationAdmission,
  preservationAdmissionBytes,
  preservedEvidenceRelativePath,
  type PreservationSourceKind,
} from "./preservation_admission.ts";

export { gateArtifactPreserveRoot, isKnownLaneArtifact, isKnownLaneEntry };

export const AFTERCARE_SCHEMA_VERSION = 1 as const;
export const AFTERCARE_STATES = [
  "prepared",
  "control_finalized",
  "archived",
  "worktree_removed",
  "branch_removed",
  "container_retired",
  "views_refreshed",
  "container_removed",
] as const;
export type AftercareState = (typeof AFTERCARE_STATES)[number];
export type AftercareBinding = "dispatch" | "branch_only";

export interface RoleBranchIdentity {
  family: "workbench" | "anvil" | "shelf" | "satchel";
  numericId: string;
  slug: string;
}

export interface SafetyPredicate {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ContainerSnapshot {
  identity: { device: string; inode: string; real_path: string };
  entries: Array<{ path: string; kind: "directory" | "file"; content_hash: string | null }>;
  recovery_artifacts?: RecoveryArtifactSnapshot;
  review_artifact?: ReviewArtifactSnapshot;
}

/** A recovered lane's evidence, in the shape its transport actually produces.
 *
 * The pair below is written by a provider SUBPROCESS. attended-agent has no
 * subprocess, so it publishes neither file, and the only launch authority that
 * exists for it is the current generation's `launch.json` acknowledgement —
 * which is why this snapshot freezes that record's bytes instead (W-687 AC-5).
 * Which of the two applies is the shared admission decision
 * (`dockProxyLaneShape`), never a guess from which files happen to be present:
 * inferring "not a recovery" from an absent pair is what let a recovered
 * attended lane through aftercare with no recovery evidence checked at all. */
export interface RecoverySubprocessArtifacts {
  transport: "provider-subprocess";
  role_binding: RoleBindingReference;
  provider_session_id: string;
  result: { path: "lane/recovery.result.md"; content_hash: string; byte_length: number };
  session: { path: "lane/recovery.session.json"; content_hash: string; byte_length: number };
}
export interface RecoveryAttendedArtifacts {
  transport: "attended-agent";
  role_binding: RoleBindingReference;
  provider_session_id: string;
  /** Project-relative path to the launch acknowledgement, plus its frozen
   * bytes. The record lives in the canonical binding tree and OUTLIVES the
   * container this aftercare retires. */
  launch: { path: string; content_hash: string; byte_length: number };
}
export type RecoveryArtifactSnapshot = RecoverySubprocessArtifacts | RecoveryAttendedArtifacts;

export interface ReviewArtifactSnapshot {
  path: "review.json";
  content_hash: string;
  byte_length: number;
}

export interface DeclaredPreservedEvidenceSnapshot {
  /** Literal project declaration before placeholder expansion. */
  declared_path: string;
  /** Expanded, validated project-relative source path. */
  source_path: string;
  content_hash: string;
  byte_length: number;
  /** Exact bytes admitted and later published, independent of live config or
   * source changes during apply/crash recovery. */
  content_base64: string;
}

export interface DeclaredPreservationSnapshot {
  retention_limit_bytes: number;
  runtime_archive_keep_days: number;
  runtime_archive_keep_files: number;
  sources: DeclaredPreservedEvidenceSnapshot[];
}

export interface LandAftercarePlan {
  schema_version: 1;
  request_id: string;
  request_path: string;
  request_hash: string;
  result_path: string;
  result_hash: string;
  project_root: string;
  target_root: string;
  pm_id: string;
  work_id: string | null;
  control_session_id: string | null;
  dispatch_id: string | null;
  container: string | null;
  container_snapshot: ContainerSnapshot | null;
  checkout: string | null;
  aftercare_binding: AftercareBinding;
  workbench_branch: string;
  workbench_tip: string;
  studio_branch: string;
  studio_commit: string;
  current_studio_tip: string;
  report_source: string | null;
  report_json_source: string | null;
  role_report_path: string | null;
  /** Exact producer lane paths from the digest-bound role authorization. */
  lane_artifacts?: string[];
  /** W-713: container-relative paths aftercare does not recognise. They are
   * COPIED into `gateArtifactPreserveRoot` before the container is retired, and
   * they are part of the plan so the digest covers them and the announcement is
   * the same on a resumed run. */
  preserved_artifacts: string[];
  /** Frozen non-candidate/legacy gate evidence excluded from publication. */
  preservation_skips: string[];
  /** W-713: where `preserved_artifacts` are copied. Null when the request binds
   * no dispatch container. */
  preserve_root: string | null;
  /** W-809: the separately reviewed declaration, expanded paths, limits and
   * source bytes. This is null only for branch-only aftercare, which has no
   * dispatch evidence preservation boundary. */
  declared_preservation: DeclaredPreservationSnapshot | null;
  report_archive: string | null;
  report_json_archive: string | null;
  journal_path: string;
  envelope_path: string;
  predicates: SafetyPredicate[];
  actions: Array<{ state: AftercareState; target: string | null }>;
  /** Present only for an explicit destructive recovery invocation. */
  force_remove?: true;
  plan_digest: string;
}

export interface AftercareOperation {
  surface: "report_archive" | "local_register" | "derived_manifest" | "task_mirror";
  payload: unknown;
  payload_hash: string;
  local_ack: "pending" | "applied";
  provider_ack: "not_applicable" | "pending" | "applied";
}

export interface AftercareResultEnvelope {
  schema_version: 1;
  kind: "garelier_land_aftercare_result";
  idempotency_key: string;
  request_id: string;
  work_id: string | null;
  studio_commit: string;
  dispatch: { id: string | null; container: string | null };
  report_archive: {
    path: string | null;
    content_hash: string | null;
    json_path: string | null;
    json_content_hash: string | null;
  };
  retirement_tombstone: null;
  physical_gc_pending: boolean;
  journal_state: AftercareState;
  local_cleanup_complete: boolean;
  external_sync_pending: boolean;
  operations: AftercareOperation[];
}

export interface AftercareJournal {
  schema_version: 1;
  kind: "garelier_land_aftercare_journal";
  request_id: string;
  revision: number;
  genesis_plan_digest: string;
  previous_revision_hash: string | null;
  record_hash: string;
  state: AftercareState;
  pending_step: AftercareState | null;
  retirement_claim: null;
  provider_receipt: ProviderAckReceipt | null;
  plan: LandAftercarePlan;
  envelope: AftercareResultEnvelope;
  updated_at: string;
}

export interface PlanLandAftercareOptions {
  project: string;
  targetRoot?: string;
  pmId: string;
  requestId: string;
  dispatchId?: string | number | null;
  forceRemove?: boolean;
}

export interface ApplyLandAftercareOptions extends PlanLandAftercareOptions {
  expectedPlanDigest: string;
  now?: () => Date;
  staleLockGraceMs?: number;
  testHooks?: {
    afterPreparedJournal?: () => void;
    afterControlFinalized?: () => void;
    afterContainerRemoved?: () => void;
  };
}

export interface AftercareRunResult {
  mode: "dry-run" | "apply" | "control-recovery" | "no-op";
  plan: LandAftercarePlan;
  journal_state: AftercareState | null;
  envelope: AftercareResultEnvelope | null;
  external_sync_pending: boolean;
}

interface MergePair {
  requestPath: string;
  requestSource: string;
  request: Record<string, unknown>;
  resultPath: string;
  resultSource: string;
  result: Record<string, unknown>;
}

export interface GateRecoveryCommandAuthority {
  request_id: string;
  dispatch_id: string;
  expected_studio_sha: string;
  review_sha: string;
  studio_commit: string;
  request_path: string;
  result_path: string;
}

export interface LockOwner {
  schema_version: 1;
  request_id: string;
  pid: number;
  process_start_identity: string;
  nonce: string;
  host: string;
  acquired_at: string;
}

export interface ProviderAckReceipt {
  schema_version: 1;
  kind: "garelier_land_aftercare_provider_receipt";
  surface: "task_mirror";
  request_id: string;
  idempotency_key: string;
  payload_hash: string;
  acknowledged_at: string;
}

export interface LogicalDispatchRetirementMarker {
  schema_version: 1;
  kind: "garelier_logical_dispatch_retirement";
  dispatch_id: string;
  container: string;
  request_id: string;
  plan_digest: string;
  journal_revision: number;
  journal_record_hash: string;
}

const SHA_RE = /^[0-9a-f]{40,64}$/;
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
const MAX_AUTHORITY_JSON_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_REVISIONS = 512;
const MAX_REPORT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_ARCHIVE_BYTES = MAX_REPORT_FILE_BYTES * 9;
const MAX_LOCK_RECORD_BYTES = 64 * 1024;
const KNOWN_CONTAINER_FILES = new Set([
  "assignment.md", "report.md", "report.json",
  "questions.md", "answers.md", "instructions.md", "STATE.md", "context.json", "control_binding.json",
  "pickup_pack.json", "ready.json", "dispatched_at", "review.md", "review.json", "under_review.md", "merged.md",
  "abort.md", "track-target.md", "ack.md", "acked.md", "followup.md", "result.md",
  // W-368: the PM's own register-processed completion marker (touched at the
  // container root by dispatch_watch.ts / pm_playbook.md sec3 — "touch
  // _crew/dispatch<N>/register_received"). No template produces it, so it must be
  // allowlisted explicitly like every other coordination file above; before this
  // it hard-failed land aftercare exactly like any other unrecognized entry
  // (W-349, measured incident #495 rc=3 in a target project).
  "register_received",
]);
const KNOWN_CONTAINER_DIRS = new Set(["checkout", "lane", "checkpoints", "archive"]);
// W-368: container-root evidence directory whose CONTENTS are defined by assignment
// convention ("script/log は必ず <container>/ci_evidence/ 配下へ"), not by this
// framework — filenames inside it are arbitrary and cannot be enumerated here. It is
// a known top-level entry, but its contents are walked permissively (see
// walkPermissive below): still no symlinks, still counted against the shared
// entry-count ceiling, and still hash-pinned into the container snapshot like any
// other entry (assertContainerSnapshot detects tampering the same way) — only the
// FILENAME allowlist is relaxed. This does not touch the checkout dirtiness /
// branch-ancestry checks elsewhere, which stay unconditional.
//
// Retention policy (W-368 AC3): the container is transient — this evidence dir does
// NOT survive cleanup any differently than the rest of the container (see
// archiveCoordination in dispatch_cleanup.ts, which archives only the fixed
// coordination files, and the `report.md`/register-based cleanup path in general).
// Summarizing ci_evidence/ content into a durable record BEFORE cleanup runs (diff +
// counts + repro command, never a raw dump — retention.md's showcase rule) is a PM
// action, not something dispatch_cleanup performs automatically: this fix stops
// cleanup from refusing to run over the directory's mere presence, it does not by
// itself preserve the directory's content. A dedicated pre-cleanup evidence-capture
// hook is tracked as a follow-up, not implemented in this dispatch (out of the
// dispatch_cleanup.ts/land_aftercare.ts scope this row was dispatched against).
const EVIDENCE_CONTAINER_DIR = "ci_evidence";
// W-368: a role/gate log dropped directly at the container root (measured:
// `w793_check.log`; measured incidents #506/#507) is tolerated by pattern rather than by an
// ever-growing exact-name list — any *.log file is PM-operational evidence, never
// part of the coordination protocol itself.
const CONTAINER_ROOT_LOG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.log$/;
interface UnknownContainerEntry {
  item: string;
  kind: "top-level entry" | "nested artifact";
}

/** W-547 AC-5: every unknown entry in ONE refusal.
 *
 * The walker used to throw on the first one, so a container holding four
 * unknown lane artifacts needed four refuse -> move-one-aside -> rerun cycles,
 * and the operator could not see how many were left. Both historical phrases
 * are preserved verbatim so existing callers and their assertions keep
 * matching; what is added is the rest of the list. */
function unknownContainerEntryMessage(entries: readonly UnknownContainerEntry[]): string {
  const clause = (kind: UnknownContainerEntry["kind"]): string[] => {
    const items = entries.filter((entry) => entry.kind === kind).map((entry) => entry.item).sort();
    return items.length === 0 ? [] : [`dispatch container has unknown ${kind}: ${items.join(", ")}`];
  };
  const clauses = [...clause("top-level entry"), ...clause("nested artifact")];
  return `${clauses.join("; ")} (${entries.length} unknown entr${entries.length === 1 ? "y" : "ies"} total;`
    + " the walk lists every one, so a single pass resolves them all)";
}
const KNOWN_ARCHIVE_FILES = new Set([
  "assignment.md", "report.md", "report.json", "questions.md", "answers.md", "instructions.md", "STATE.md",
  "review.md", "under_review.md", "merged.md", "guardian_report.md", "observer_report.md", "advice.md", "acked.md",
]);

export function roleBranchIdentity(branch: string, targetSlug: string, pmId: string): RoleBranchIdentity {
  const prefix = `garelier/${targetSlug}/${pmId}/`;
  if (!branch.startsWith(prefix)) throw new Error(`role branch is outside the configured Garelier namespace: ${branch}`);
  const parts = branch.slice(prefix.length).split("/");
  const family = parts[0];
  const numericId = parts[1]?.match(/^#(\d+)$/)?.[1] ?? "";
  const slug = parts[2] ?? "";
  if (parts.length !== 3 || !(["workbench", "anvil", "shelf", "satchel"] as const).includes(family as RoleBranchIdentity["family"])
    || !numericId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new Error(`role branch does not match the canonical Garelier grammar: ${branch}`);
  }
  return { family: family as RoleBranchIdentity["family"], numericId, slug };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function parseJson(source: string, path: string): Record<string, unknown> {
  try { return record(JSON.parse(source), path); }
  catch (error) { throw new Error(`invalid JSON at ${path}: ${(error as Error).message}`); }
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function exactSha(value: unknown, label: string): string {
  const text = exactString(value, label);
  if (!SHA_RE.test(text)) throw new Error(`${label} must be a full lowercase commit SHA`);
  return text;
}

export function sameFilesystemPath(a: string, b: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const left = resolve(a);
  const right = resolve(b);
  if (existsSync(left) && existsSync(right)) {
    const leftReal = realpathSync.native(left);
    const rightReal = realpathSync.native(right);
    const leftStat = statSync(leftReal);
    const rightStat = statSync(rightReal);
    return leftStat.dev === rightStat.dev
      && leftStat.ino === rightStat.ino
      && normalize(leftReal) === normalize(rightReal);
  }
  return normalize(left) === normalize(right);
}

function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !/^[\\/]/.test(rel));
}

export function classifyAftercareProcessTermination(input: {
  errorCode?: string | null;
  signal?: NodeJS.Signals | null;
  status: number | null;
}): { kind: "timeout" | "signal" | "spawn_failure" | "exit"; code: number } {
  if (input.errorCode === "ETIMEDOUT") return { kind: "timeout", code: 124 };
  if (input.errorCode) return { kind: "spawn_failure", code: 127 };
  if (input.signal) return { kind: "signal", code: 128 };
  if (input.status === null) return { kind: "spawn_failure", code: 127 };
  return { kind: "exit", code: input.status };
}

function git(root: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const out = spawnSync(requireRuntimeExecutable("git"), args, {
    windowsHide: true,
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  const errorCode = (out.error as NodeJS.ErrnoException | undefined)?.code;
  const classified = classifyAftercareProcessTermination({ errorCode, signal: out.signal, status: out.status });
  const stderr = classified.kind === "timeout" ? `git timed out after 30000ms: ${args.join(" ")}`
    : out.error ? `git spawn failed: ${out.error.message}`
    : classified.kind === "signal" ? `git terminated by signal ${out.signal}: ${args.join(" ")}`
    : out.status === null ? `git exited without a status: ${args.join(" ")}`
    : out.stderr ?? "";
  return { code: classified.code, stdout: out.stdout ?? "", stderr };
}

function gitText(root: string, args: string[], label: string): string {
  const result = git(root, args);
  if (result.code !== 0) throw new Error(`${label}: ${result.stderr.trim() || `git exited ${result.code}`}`);
  return result.stdout.trim();
}

/** One cleanliness denominator for planning and every destructive recheck.
 * Ignored build output is disposable checkout residue; unfinished role work is
 * tracked changes plus non-ignored untracked files. */
function checkoutDirtyStatus(checkout: string, label: string): string {
  return gitText(checkout, ["--no-optional-locks", "status", "--porcelain=v2", "--untracked-files=all"], label);
}

/** Bound journal/refusal detail independently from the cleanliness decision. */
export function summarizeCheckoutDirtyStatus(status: string): string {
  const lines = status.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return "clean";
  const categories = new Map<string, number>();
  for (const line of lines) {
    const category = line.startsWith("? ") ? "untracked"
      : line.startsWith("! ") ? "ignored"
      : line.startsWith("1 ") ? "ordinary"
      : line.startsWith("2 ") ? "renamed_or_copied"
      : line.startsWith("u ") ? "unmerged"
      : "other";
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  const counts = [...categories.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => `${category}:${count}`).join(",");
  return `dirty_entries=${lines.length} categories=${counts} bytes=${Buffer.byteLength(status, "utf8")} sha256=${sha256(status).replace(/^sha256:/, "")}`;
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  const result = git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`git merge-base ancestry check ${result.code === 124 ? "timed out" : "failed"}: ${result.stderr.trim() || `exit ${result.code}`}`);
}

export function classifyGitRefPresence(result: { code: number; stderr?: string; stdout?: string }, label: string): boolean {
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`${label} ${result.code === 124 ? "timed out" : "failed"}: ${(result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `git exited ${result.code}`}`);
}

function refExists(root: string, ref: string): boolean {
  return classifyGitRefPresence(git(root, ["show-ref", "--verify", "--quiet", ref]), `git ref probe ${ref}`);
}

function symbolicRefTarget(root: string, ref: string): string | null {
  const result = git(root, ["symbolic-ref", "-q", ref]);
  if (result.code === 0) return result.stdout.trim() || "(unknown referent)";
  if (result.code === 1) return null;
  throw new Error(`git symbolic-ref probe ${result.code === 124 ? "timed out" : "failed"}: ${result.stderr.trim() || `exit ${result.code}`}`);
}

function mergeGateRoot(project: string, pmId: string): string {
  return join(project, "__garelier", pmId, "runtime", "merge_gate");
}

function uniqueExisting(paths: string[], label: string): string {
  const existing = paths.filter(existsSync);
  if (existing.length !== 1) throw new Error(`${label} must resolve to exactly one file; found ${existing.length}: ${existing.join(", ") || "none"}`);
  const path = existing[0]!;
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a real regular file: ${path}`);
  return path;
}

function readStableFile(path: string, label: string, maxBytes: number): Buffer {
  const pathInfo = lstatSync(path);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error(`${label} must be a real regular file: ${path}`);
  if (pathInfo.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${pathInfo.size}`);
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || String(before.dev) !== String(pathInfo.dev) || String(before.ino) !== String(pathInfo.ino)) {
      throw new Error(`${label} identity changed while opening: ${path}`);
    }
    if (before.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes: ${before.size}`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino)
      || after.size !== before.size || bytes.length !== before.size) {
      throw new Error(`${label} changed while reading its bound handle: ${path}`);
    }
    return bytes;
  } finally { closeSync(descriptor); }
}

function readStableText(path: string, label: string, maxBytes: number): string {
  return readStableFile(path, label, maxBytes).toString("utf8");
}

function readMergePair(project: string, pmId: string, requestId: string): MergePair {
  if (!SAFE_ID_RE.test(requestId)) throw new Error(`request_id contains unsafe path characters: ${requestId}`);
  const root = mergeGateRoot(project, pmId);
  const requestPath = uniqueExisting([
    join(root, "requests", `${requestId}.json`),
    join(root, "archive", `${requestId}.request.json`),
  ], `merge request ${requestId}`);
  const resultPath = uniqueExisting([
    join(root, "results", `${requestId}.json`),
    join(root, "archive", `${requestId}.result.json`),
  ], `merge result ${requestId}`);
  assertNoSymlinkPath(root, requestPath);
  assertNoSymlinkPath(root, resultPath);
  const requestSource = readStableText(requestPath, "merge request", MAX_AUTHORITY_JSON_BYTES);
  const resultSource = readStableText(resultPath, "merge result", MAX_AUTHORITY_JSON_BYTES);
  return {
    requestPath, requestSource, request: parseJson(requestSource, requestPath),
    resultPath, resultSource, result: parseJson(resultSource, resultPath),
  };
}

/**
 * Resolve only the immutable merge authority needed to print the public gate
 * recovery commands. A full aftercare plan cannot be used here: the caller is
 * asking for these commands precisely because preservation admission rejected
 * an escaped canonical log. The request/result pair, dispatch binding, target,
 * studio branch, and landed ancestry are still authenticated before the
 * request's pre-land expected_studio_sha is exposed.
 */
export function resolveGateRecoveryCommandAuthority(
  options: PlanLandAftercareOptions,
): GateRecoveryCommandAuthority {
  const project = canonicalPath(resolve(options.project));
  const targetRoot = canonicalPath(resolve(options.targetRoot ?? project));
  const pmRoot = join(project, "__garelier", options.pmId);
  if (!existsSync(pmRoot) || !lstatSync(pmRoot).isDirectory()) throw new Error(`PM root is missing: ${pmRoot}`);

  const pair = readMergePair(project, options.pmId, options.requestId);
  const requestId = exactString(pair.request.request_id, "request.request_id");
  if (requestId !== options.requestId) throw new Error(`request_id_match: ${requestId} != ${options.requestId}`);
  if (pair.result.request_id !== requestId) throw new Error(`result.request_id does not match request: ${String(pair.result.request_id)}`);
  if (pair.result.status !== "success") throw new Error(`merge result is not terminal success: ${String(pair.result.status)}`);

  const requestTarget = exactString(pair.request.target_root, "request.target_root");
  if (!sameFilesystemPath(requestTarget, targetRoot)) throw new Error(`target_root_exact: ${requestTarget} == ${targetRoot}`);
  const setupConfig = loadConfig(project, options.pmId);
  const studioBranch = exactString(pair.request.studio_branch, "request.studio_branch");
  if (studioBranch !== setupConfig.branches.integration) {
    throw new Error(`studio_branch_exact: ${studioBranch} == ${setupConfig.branches.integration}`);
  }

  const branch = exactString(pair.request.workbench_branch, "request.workbench_branch");
  const branchIdentity = roleBranchIdentity(branch, setupConfig.branches.targetSlug, options.pmId);
  const aftercareBinding = exactString(pair.request.aftercare_binding, "request.aftercare_binding");
  if (aftercareBinding !== "dispatch") throw new Error(`gate recovery requires dispatch aftercare, got: ${aftercareBinding}`);
  const reviewSha = exactSha(pair.request.workbench_tip, "request.workbench_tip");
  const resultBranch = exactString(pair.result.workbench_branch, "result.workbench_branch");
  const resultTip = exactSha(pair.result.workbench_tip, "result.workbench_tip");
  if (resultBranch !== branch) throw new Error("result.workbench_branch does not match request");
  if (resultTip !== reviewSha) throw new Error("result.workbench_tip does not match request");

  const requestDispatch = exactString(pair.request.dispatch_id, "request.dispatch_id");
  if (!/^\d+$/.test(requestDispatch)) throw new Error(`request.dispatch_id must be numeric: ${requestDispatch}`);
  if (branchIdentity.family === "satchel" || branchIdentity.numericId !== requestDispatch) {
    throw new Error(`request.dispatch_id does not match branch dispatch identity: ${requestDispatch} != ${branchIdentity.numericId ?? "null"}`);
  }
  const callerDispatch = options.dispatchId === undefined || options.dispatchId === null
    ? null
    : String(options.dispatchId).replace(/^#/, "");
  if (callerDispatch !== null && callerDispatch !== requestDispatch) {
    throw new Error("caller dispatch id does not match immutable merge request");
  }
  const container = exactString(pair.request.dispatch_container, "request.dispatch_container");
  const expectedContainer = crewSubdir(project, options.pmId, `dispatch${requestDispatch}`);
  if (!sameFilesystemPath(container, expectedContainer)) {
    throw new Error(`dispatch_container_exact: ${container} == ${expectedContainer}`);
  }

  const expectedStudioSha = exactSha(pair.request.expected_studio_sha, "request.expected_studio_sha");
  if (expectedStudioSha.length !== 40) {
    throw new Error("request.expected_studio_sha must be a 40-character commit SHA for review_prepare");
  }
  const resultExpectedStudioSha = exactSha(pair.result.expected_studio_sha, "result.expected_studio_sha");
  if (resultExpectedStudioSha !== expectedStudioSha) {
    throw new Error("result.expected_studio_sha does not match request");
  }
  const studioCommit = exactSha(pair.result.studio_commit, "result.studio_commit");
  const currentStudioTip = gitText(targetRoot, ["rev-parse", "--verify", `${studioBranch}^{commit}`], "cannot resolve current studio tip");
  if (!isAncestor(targetRoot, expectedStudioSha, studioCommit)) {
    throw new Error(`request expected studio is not an ancestor of result: ${expectedStudioSha} -> ${studioCommit}`);
  }
  if (!isAncestor(targetRoot, reviewSha, studioCommit)) {
    throw new Error(`request tip is not an ancestor of result: ${reviewSha} -> ${studioCommit}`);
  }
  if (!isAncestor(targetRoot, studioCommit, currentStudioTip)) {
    throw new Error(`result is not an ancestor of current studio: ${studioCommit} -> ${currentStudioTip}`);
  }

  return {
    request_id: requestId,
    dispatch_id: requestDispatch,
    expected_studio_sha: expectedStudioSha,
    review_sha: reviewSha,
    studio_commit: studioCommit,
    request_path: pair.requestPath,
    result_path: pair.resultPath,
  };
}

interface WorktreeEntry { path: string; head: string; branch: string | null; }
function registeredWorktrees(targetRoot: string): WorktreeEntry[] {
  const source = gitText(targetRoot, ["worktree", "list", "--porcelain", "-z"], "cannot read worktree registry");
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const field of source.split("\0")) {
    if (!field) continue;
    const split = field.indexOf(" ");
    const key = split < 0 ? field : field.slice(0, split);
    const value = split < 0 ? "" : field.slice(split + 1);
    if (key === "worktree") {
      if (current.path) entries.push({ path: current.path, head: current.head ?? "", branch: current.branch ?? null });
      current = { path: value };
    } else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.branch = null;
  }
  if (current.path) entries.push({ path: current.path, head: current.head ?? "", branch: current.branch ?? null });
  return entries;
}

/** Is this nested container entry one the framework recognises?
 *
 * ONE spelling, because two walks ask it (W-713): the strict walk, which
 * refuses or records what it does not recognise, and the force-remove walk,
 * which tolerates anything but still has to record the unrecognised files so
 * they can be preserved. A second copy would let the two modes disagree about
 * what "unknown" means, which is precisely the drift that let force-remove
 * preserve nothing. */
function isNestedRecognised(
  segments: readonly string[],
  entry: { isFile(): boolean; isDirectory(): boolean },
  includeCheckout: boolean,
  writtenByRun: ReadonlySet<string>,
): boolean {
  return segments[0] === "lane"
    ? isKnownLaneEntry(segments.slice(1), entry, writtenByRun)
    : segments[0] === "checkpoints"
      ? segments.length === 2 && entry.isFile() && /^\d{4}-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(segments[1]!)
      : segments[0] === "archive"
        ? ((segments.length === 2 && entry.isDirectory() && SAFE_ID_RE.test(segments[1]!))
          || (segments.length === 3 && entry.isFile() && SAFE_ID_RE.test(segments[1]!) && KNOWN_ARCHIVE_FILES.has(segments[2]!)))
        : segments[0] === "checkout" && includeCheckout;
}

/**
 * @param collectUnknown when supplied, unknown entries are COLLECTED into it
 * instead of throwing (W-713 / DEC-100 ruling 5). The caller then preserves
 * them before the container is retired, which is the whole ruling: aftercare's
 * judgement about what it recognises does not change, only what happens to the
 * bytes it does not. Structural violations — a symlink, a non-file/non-dir
 * entry, the entry ceiling, a non-empty recovery lock dir — still THROW here in
 * both modes (W-380): those are boundary violations, not evidence to keep.
 */
function validateContainerInventory(
  root: string,
  includeCheckout: boolean,
  maxEntries = 4096,
  allowUnknown = false,
  collectUnknown?: string[],
  writtenByRun: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  // Collected, not thrown, so the refusal can name every unknown entry at once
  // (W-547 AC-5). Structural failures — symlink, entry-type, ceiling, non-empty
  // recovery locks — stay fail-fast: those are boundary violations, not a list
  // of artifacts an operator is meant to review together.
  const unknown: UnknownContainerEntry[] = [];
  // W-368: the evidence dir's contents are PM/assignment-convention-defined, not
  // framework-fixed — walk them for the same symlink-safety and entry-count
  // ceiling as everything else, but without a filename allowlist (there is none
  // to check against).
  const walkPermissive = (directory: string, classifyUnknown = false): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || entry.isSymbolicLink()) throw new Error(`symlink is forbidden in aftercare target: ${path}`);
      const item = relative(root, path).replaceAll("\\", "/");
      out.push(item);
      if (out.length > maxEntries) throw new Error(`aftercare target inventory exceeds ${maxEntries} entries: ${root}`);
      if (classifyUnknown && entry.isFile() && !isNestedRecognised(item.split("/"), entry, includeCheckout, writtenByRun)) {
        unknown.push({ item, kind: "nested artifact" });
      }
      if (item === "lane/locks" && entry.isDirectory() && readdirSync(path).length !== 0) {
        throw new Error("recovery lane locks directory must be empty");
      }
      if (entry.isDirectory()) walkPermissive(path, classifyUnknown);
      else if (!entry.isFile()) throw new Error(`unknown filesystem entry type in aftercare target: ${path}`);
    }
  };
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || entry.isSymbolicLink()) throw new Error(`symlink is forbidden in aftercare target: ${path}`);
      const item = relative(root, path).replaceAll("\\", "/");
      out.push(item);
      if (out.length > maxEntries) throw new Error(`aftercare target inventory exceeds ${maxEntries} entries: ${root}`);
      const segments = item.split("/");
      // W-713: RECOGNITION and TOLERATION are separate questions, and
      // `allowUnknown` (force-remove) only answers the second. It used to
      // short-circuit before anything was recorded, so a force-removed
      // container preserved nothing — the collector stayed empty and the
      // preserve step returned at its first line. `recognised` answers the
      // first question the same way in both modes; `allowUnknown` then decides
      // whether an unrecognised entry refuses or is merely recorded.
      const recognisedTopLevelFile = segments.length === 1 && entry.isFile()
        && (KNOWN_CONTAINER_FILES.has(item) || CONTAINER_ROOT_LOG_RE.test(item));
      if (segments.length === 1) {
        if (entry.isDirectory()) {
          if (item === EVIDENCE_CONTAINER_DIR) { walkPermissive(path); continue; }
          if (allowUnknown && item !== "checkout") { walkPermissive(path, true); continue; }
          if (!KNOWN_CONTAINER_DIRS.has(item)) { unknown.push({ item, kind: "top-level entry" }); continue; }
          if (item === "checkout") {
            if (!includeCheckout) continue;
          } else walk(path);
        } else if (entry.isFile() && allowUnknown && !recognisedTopLevelFile) {
          // Tolerated by force-remove, but still not recognised: record it so
          // the preserve step can copy it before the container is retired.
          unknown.push({ item, kind: "top-level entry" });
        } else if (entry.isFile() && (allowUnknown || KNOWN_CONTAINER_FILES.has(item) || CONTAINER_ROOT_LOG_RE.test(item))) {
          // known coordination file, or a *.log role/gate artifact (W-368) —
          // already recorded in `out` above, nothing further to validate.
        } else {
          unknown.push({ item, kind: "top-level entry" });
        }
        continue;
      }
      if (allowUnknown && segments[0] !== "checkout") {
        if (entry.isDirectory()) walkPermissive(path, true);
        else if (entry.isFile()) {
          if (!isNestedRecognised(segments, entry, includeCheckout, writtenByRun)) unknown.push({ item, kind: "nested artifact" });
        } else throw new Error(`unknown filesystem entry type in aftercare target: ${path}`);
        continue;
      }
      const allowed = isNestedRecognised(segments, entry, includeCheckout, writtenByRun);
      // An unknown entry is recorded and NOT descended into: listing its
      // children would bury the entry the operator actually has to act on.
      if (!allowed) { unknown.push({ item, kind: "nested artifact" }); continue; }
      if (item === "lane/locks") {
        if (readdirSync(path).length !== 0) throw new Error("recovery lane locks directory must be empty");
      } else if (entry.isDirectory()) walk(path);
      else if (!entry.isFile()) throw new Error(`unknown filesystem entry type in aftercare target: ${path}`);
    }
  };
  walk(root);
  if (unknown.length > 0) {
    // W-741 supersedes W-713 for this one durable artifact class. The pm-step
    // log has a named owner that moves it before either container-removal path;
    // allowing generic aftercare preservation to consume it would make the
    // dedicated preview/apply contract unreachable again.
    const ownerPreserved = unknown.some((entry) => {
      const segments = entry.item.split("/");
      return segments.length === 2 && segments[0] === "lane" && isPmStepGateLog(segments[1]!);
    });
    if (ownerPreserved) throw new Error(unknownContainerEntryMessage(unknown));
    if (!collectUnknown) throw new Error(unknownContainerEntryMessage(unknown));
    // Files only: a directory has no single set of bytes to preserve, and
    // descending into one was already declined above.
    for (const entry of unknown) {
      const path = join(root, entry.item);
      if (existsSync(path) && lstatSync(path).isFile()) collectUnknown.push(entry.item);
      else throw new Error(unknownContainerEntryMessage([entry]));
    }
    collectUnknown.sort();
  }
  return out.sort();
}

function validateContainer(
  container: string,
  checkout: string,
  forceRemove = false,
  collectUnknown?: string[],
  writtenByRun: ReadonlySet<string> = new Set(),
): string[] {
  assertNoSymlinkPath(dirname(container), container);
  const info = lstatSync(container);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`dispatch container must be a real directory: ${container}`);
  const inventory = validateContainerInventory(container, false, 4096, forceRemove, collectUnknown, writtenByRun);
  if (!inventory.some((item) => item === "checkout" || item.startsWith("checkout/"))) {
    throw new Error(`registered checkout is absent from dispatch container: ${checkout}`);
  }
  return inventory;
}

function authenticatedLaneArtifacts(input: {
  projectRoot: string;
  pmId: string;
  dispatchId: string | null;
  requestBinding: unknown;
}): ReadonlySet<string> {
  if (input.dispatchId === null || input.requestBinding == null) return new Set();
  const identity = dispatchExecutionIdentity(input.dispatchId);
  const authorization = readCurrentRoleAuthorization({
    project_root: input.projectRoot,
    pm_id: input.pmId,
    identity,
  });
  if (canonicalJson(bindingReference(authorization)) !== canonicalJson(input.requestBinding)) {
    throw new Error("merge request role binding does not match the current authorization used for lane artifact admission");
  }
  return laneArtifactsWrittenByRun(authorization.core.lane_artifacts);
}

function recoveryBindingReference(value: unknown, label: string): RoleBindingReference {
  const reference = record(value, label);
  const identity = record(reference.identity, `${label}.identity`);
  if (reference.schema_version !== 1
    || typeof reference.binding_id !== "string" || !/^[0-9a-f]{64}$/.test(reference.binding_id)
    || !Number.isSafeInteger(reference.generation) || Number(reference.generation) < 1
    || typeof reference.binding_digest !== "string" || !/^[0-9a-f]{64}$/.test(reference.binding_digest)
    || identity.kind !== "dispatch" || typeof identity.id !== "string" || !/^[1-9][0-9]*$/.test(identity.id)
    || Object.keys(identity).length !== 2
    || Object.keys(reference).length !== 5) {
    throw new Error(`${label} is malformed`);
  }
  return reference as unknown as RoleBindingReference;
}

/** The lane identity a container belongs to, when the caller knows it. Without
 * it there is no canonical authorization to ask, and the artifact pair is the
 * only signal available. */
export interface RecoveryLaneIdentity { projectRoot: string; pmId: string; dispatchId: string }

/** The recovered-lane shape from the CANONICAL authorization, or undefined when
 * this identity has no current binding or its carabiner is not `role_recovery`. */
function recoveredLaneAuthorization(identity: RecoveryLaneIdentity): {
  shape: DockProxyLaneShape;
  launchPath: string;
} | undefined {
  const execution = dispatchExecutionIdentity(identity.dispatchId);
  let authorization: ReturnType<typeof readCurrentRoleAuthorization>;
  try {
    authorization = readCurrentRoleAuthorization({
      project_root: identity.projectRoot, pm_id: identity.pmId, identity: execution,
    });
  } catch (error) {
    // Reuse the canonical absence contract; a corrupt authority still throws.
    if ((error as Error).message.startsWith("no current role binding exists")) return undefined;
    throw error;
  }
  if (authorization.core.carabiner !== "role_recovery") return undefined;
  const transport = authorization.core.routing.provider;
  if (!isProviderTransport(transport)) {
    throw new Error(`recovery authorization transport is not canonical: ${transport}`);
  }
  return {
    shape: dockProxyLaneShape(transport, true),
    launchPath: roleBindingPaths(
      identity.projectRoot, identity.pmId, execution, authorization.core.generation,
    ).launch,
  };
}

function recoveryArtifactSnapshot(
  container: string,
  inventory: readonly string[],
  identity?: RecoveryLaneIdentity,
): RecoveryArtifactSnapshot | undefined {
  const resultPath = "lane/recovery.result.md" as const;
  const sessionPath = "lane/recovery.session.json" as const;
  const hasResult = inventory.includes(resultPath);
  const hasSession = inventory.includes(sessionPath);
  const recovery = identity ? recoveredLaneAuthorization(identity) : undefined;
  const contextSnapshot = (): RoleBindingReference => {
    const contextPath = join(container, "context.json");
    const context = parseJson(readStableText(contextPath, "dispatch context", MAX_AUTHORITY_JSON_BYTES), contextPath);
    return recoveryBindingReference(roleBindingFromContext(context), "recovery role binding in dispatch context");
  };
  if (recovery && !recovery.shape.providerSessionRecord) {
    // attended-agent: the launch acknowledgement is the whole evidence. A
    // `recovery.result.md` left over in the lane is a preserved lane artifact,
    // not canonical recovery evidence, so the pair rule does not apply here.
    if (!existsSync(recovery.launchPath)) {
      // Name the artifact. This transport has exactly one launch authority, so
      // its absence is the whole refusal, not an incidental read error.
      throw new Error(`recovery role launch acknowledgement is missing: ${recovery.launchPath}`);
    }
    const launchBytes = readStableFile(recovery.launchPath, "recovery role launch", MAX_AUTHORITY_JSON_BYTES);
    let launch: Record<string, unknown>;
    try { launch = record(JSON.parse(launchBytes.toString("utf8")), "recovery role launch"); }
    catch (error) { throw new Error(`recovery role launch is malformed JSON: ${(error as Error).message}`); }
    return {
      transport: "attended-agent",
      role_binding: contextSnapshot(),
      provider_session_id: exactString(launch.provider_session_id, "recovery provider session id"),
      launch: {
        path: relative(realpathSync.native(resolve(identity!.projectRoot)), realpathSync.native(recovery.launchPath))
          .replaceAll("\\", "/"),
        content_hash: sha256(launchBytes),
        byte_length: launchBytes.length,
      },
    };
  }
  if (hasResult !== hasSession) throw new Error("recovery result and session artifacts must appear together");
  if (recovery && !hasResult) {
    throw new Error(`recovered ${recovery.shape.transport} lane is missing its canonical recovery result and session artifacts`);
  }
  // W-806: `lane/locks/` is a normal provider-launcher leaf. Its existence is
  // never recovery evidence; only the artifact pair above or the canonical
  // recovery authorization/launch can select this path. Non-empty locks remain
  // refused by validateContainerInventory before this snapshot is built.
  if (!hasResult) return undefined;
  const roleBinding = contextSnapshot();
  const resultBytes = readStableFile(join(container, ...resultPath.split("/")), "recovery result", MAX_REPORT_FILE_BYTES);
  const sessionBytes = readStableFile(join(container, ...sessionPath.split("/")), "recovery session", MAX_AUTHORITY_JSON_BYTES);
  let session: Record<string, unknown>;
  try { session = record(JSON.parse(sessionBytes.toString("utf8")), "recovery session"); }
  catch (error) { throw new Error(`recovery session is malformed JSON: ${(error as Error).message}`); }
  return {
    transport: "provider-subprocess",
    role_binding: roleBinding,
    provider_session_id: exactString(session.session_id, "recovery provider session id"),
    result: { path: resultPath, content_hash: sha256(resultBytes), byte_length: resultBytes.length },
    session: { path: sessionPath, content_hash: sha256(sessionBytes), byte_length: sessionBytes.length },
  };
}

function reviewArtifactSnapshot(container: string, inventory: readonly string[]): ReviewArtifactSnapshot | undefined {
  const path = "review.json" as const;
  if (!inventory.includes(path)) return undefined;
  const bytes = readStableFile(join(container, path), "Dock review artifact", MAX_AUTHORITY_JSON_BYTES);
  return { path, content_hash: sha256(bytes), byte_length: bytes.length };
}

function captureContainerSnapshot(
  container: string,
  inventory = validateContainerInventory(container, false),
  identity?: RecoveryLaneIdentity,
): ContainerSnapshot {
  const rootInfo = statSync(container);
  const realPath = realpathSync.native(container).replaceAll("\\", "/").replace(/\/+$/, "");
  const entries = inventory
    .filter((item) => item !== "checkout" && !item.startsWith("checkout/"))
    .map((item): ContainerSnapshot["entries"][number] => {
      const path = join(container, ...item.split("/"));
      const info = lstatSync(path);
      if (info.isDirectory()) return { path: item, kind: "directory", content_hash: null };
      if (!info.isFile()) throw new Error(`unknown filesystem entry type in aftercare target: ${path}`);
      const maxBytes = item.startsWith("lane/") && isPmStepGateLog(basename(item))
        ? info.size
        : MAX_REPORT_FILE_BYTES;
      return { path: item, kind: "file", content_hash: sha256(readStableFile(path, `dispatch snapshot ${item}`, maxBytes)) };
    });
  const recoveryArtifacts = recoveryArtifactSnapshot(container, inventory, identity);
  const reviewArtifact = reviewArtifactSnapshot(container, inventory);
  return {
    identity: { device: String(rootInfo.dev), inode: String(rootInfo.ino), real_path: realPath },
    entries,
    ...(recoveryArtifacts ? { recovery_artifacts: recoveryArtifacts } : {}),
    ...(reviewArtifact ? { review_artifact: reviewArtifact } : {}),
  };
}

function readFrozenContainerFile(plan: LandAftercarePlan, container: string, item: string): Buffer {
  const expected = plan.container_snapshot?.entries.find((entry) => entry.path === item);
  if (!expected || expected.kind !== "file" || typeof expected.content_hash !== "string") {
    throw new Error(`dispatch snapshot has no authenticated file entry for ${item}`);
  }
  const absolute = join(container, ...item.split("/"));
  const maxBytes = item.startsWith("lane/") && isPmStepGateLog(basename(item))
    ? lstatSync(absolute).size
    : MAX_REPORT_FILE_BYTES;
  const bytes = readStableFile(absolute, `dispatch ${item}`, maxBytes);
  if (sha256(bytes) !== expected.content_hash) throw new Error(`dispatch ${item} bytes changed after planning`);
  return bytes;
}

export function assertContainerSnapshot(plan: LandAftercarePlan, container = plan.container, requireOriginalPath = true): void {
  if (!plan.container || !plan.container_snapshot) throw new Error("aftercare plan has no frozen dispatch container snapshot");
  if (!container) throw new Error("aftercare container snapshot target is missing");
  // W-713: this walk only needs the inventory, but it uses the same strict
  // validator, so it needs the collector for the same reason — otherwise the
  // pre-fix refusal fires here instead. The snapshot comparison below is what
  // actually detects a changed container; the collected set is discarded.
  const current = captureContainerSnapshot(
    container,
    validateContainerInventory(
      container,
      false,
      4096,
      plan.force_remove === true,
      [],
      laneArtifactsWrittenByRun(plan.lane_artifacts),
    ),
    // Same identity the plan was derived under, so the re-derivation asks the
    // canonical authorization the same question rather than inferring recovery
    // from which files survive.
    plan.dispatch_id
      ? { projectRoot: plan.project_root, pmId: plan.pm_id, dispatchId: plan.dispatch_id }
      : undefined,
  );
  const expected = plan.container_snapshot;
  const identityMatches = current.identity.device === expected.identity.device
    && current.identity.inode === expected.identity.inode
    && (!requireOriginalPath || current.identity.real_path === expected.identity.real_path);
  if (!identityMatches || canonicalJson(current.entries) !== canonicalJson(expected.entries)) {
    throw new Error("dispatch container identity or coordination bytes changed after planning");
  }
}

function validateContainerOwnership(input: {
  container: string; dispatchId: string; branch: string; workId: string | null; sessionId: string | null;
}): void {
  const contextPath = join(input.container, "context.json");
  const bindingPath = join(input.container, "control_binding.json");
  const context = parseJson(readStableText(contextPath, "dispatch context", MAX_AUTHORITY_JSON_BYTES), contextPath);
  const task = record(context.task, "context.task");
  const binding = parseJson(readStableText(bindingPath, "dispatch control binding", MAX_AUTHORITY_JSON_BYTES), bindingPath);
  if (String(task.id ?? "") !== input.dispatchId || task.branch !== input.branch) {
    throw new Error("dispatch context task id/branch does not match merge request");
  }
  if (String(binding.dispatch_id ?? "") !== input.dispatchId) throw new Error("control binding dispatch_id does not match merge request");
  if (input.workId !== null && binding.work_id !== input.workId) throw new Error("control binding work_id does not match merge request");
  if (input.sessionId !== null && binding.session_id !== input.sessionId) throw new Error("control binding session_id does not match merge request");
}

function recoveryCloseReference(value: unknown, requestId: string, candidateSha: string): RoleCloseReference {
  const close = record(value, "recovery role close reference");
  if (close.schema_version !== 1
    || typeof close.receipt_id !== "string" || !/^[0-9a-f]{64}$/.test(close.receipt_id)
    || close.request_id !== requestId || close.candidate_sha !== candidateSha
    || Object.keys(close).length !== 4) {
    throw new Error("recovery role close reference is malformed or mismatched");
  }
  return close as unknown as RoleCloseReference;
}

function canonicalRoleRecord(path: string, label: string, kind: string): Record<string, unknown> {
  const source = readStableText(path, label, MAX_AUTHORITY_JSON_BYTES);
  const value = parseJson(source, path);
  if (source !== canonicalJson(value) || value.schema_version !== 1 || value.kind !== kind) {
    throw new Error(`${label} is non-canonical or has the wrong schema/kind`);
  }
  return value;
}

function roleActor(value: unknown, roles: ReadonlySet<string>, label: string): Record<string, unknown> {
  const actor = record(value, label);
  if (Object.keys(actor).length !== 2 || typeof actor.id !== "string" || actor.id.length === 0
    || typeof actor.role !== "string" || !roles.has(actor.role)) {
    throw new Error(`${label} is malformed or unauthorized`);
  }
  return actor;
}

function readSnapshotEntry(input: {
  container: string; snapshot: ContainerSnapshot; item: string; label: string; maxBytes: number;
}): Buffer {
  const expected = input.snapshot.entries.find((entry) => entry.path === input.item);
  if (!expected || expected.kind !== "file" || typeof expected.content_hash !== "string") {
    throw new Error(`dispatch snapshot has no authenticated file entry for ${input.item}`);
  }
  const bytes = readStableFile(join(input.container, ...input.item.split("/")), input.label, input.maxBytes);
  if (sha256(bytes) !== expected.content_hash) {
    throw new Error(`${input.label} bytes changed between snapshot capture and canonical validation`);
  }
  return bytes;
}

function validateRecoveryResult(source: string, input: {
  branch: string; pmId: string; dispatchId: string; role: string; workIds: readonly string[]; proxyLane: boolean;
}): void {
  // Keep the full parse: the shared terminal-state reader has a 64KiB window.
  // REPORTING/BLOCKED describe provider completion, not successful land authority.
  const parsed = tryParseMachineArtifact(source, "recovery result");
  if (!parsed.ok) {
    throw new Error(`recovery result reporting state/branch marker is unreadable: ${parsed.message}`);
  }
  if (parseDispatchResultState(source) === null) {
    throw new Error("recovery result reporting state/branch marker is malformed or mismatched");
  }
  // The authenticated input owns the branch. Optional duplicate declarations
  // must each agree; neither may conceal a contradictory value in the other.
  for (const section of ["lane", "gate"]) {
    if (Array.isArray(parsed.artifact.data[section])) {
      throw new Error(`recovery result [${section}] must be a TOML table`);
    }
    const branch = optionalMachineString(parsed.artifact, section, "branch", "recovery result");
    if (branch !== null && branch !== input.branch) {
      throw new Error("recovery result reporting state/branch marker is malformed or mismatched");
    }
  }
  const lines = parsed.artifact.body.replaceAll("\r\n", "\n").split("\n");
  // W-708 (DEC-100 stage 0): the terminal signal is `[lane].state`,
  // checked directly above. The retired form ALSO required the
  // GARELIER_RUNTIME_STATUS marker to appear exactly once, immediately before
  // COMMIT PLAN, and to carry exactly four keys - a second spelling of the same
  // fact, which refused registers whose state field was already correct. The
  // marker stays a requested observability line in the role prompt; it is no
  // longer a position- and count-checked field. The COMMIT PLAN envelope is a
  // separate (proxy) contract and keeps its own shape checks.
  // W-687 AC-4: the COMMIT PLAN envelope is the PROXY hand-over. A lane whose
  // producer commits for itself never writes one, so requiring it here refused
  // every recovered claude lane at land — after merge_land had already
  // succeeded, which left the container active and its claim held with no way
  // forward that did not involve a person hand-writing producer evidence.
  const planIndexes = lines.flatMap((line, index) => line === "=== COMMIT PLAN ===" ? [index] : []);
  const endIndexes = lines.flatMap((line, index) => line === "=== END COMMIT PLAN ===" ? [index] : []);
  // A producer-committed lane may or may not carry one — some registers quote
  // the envelope in prose, and refusing that would be a NEW refusal this row
  // did not ask for. The requirement is dropped there, not inverted.
  if (input.proxyLane && planIndexes.length !== 1) {
    throw new Error("recovery result must carry exactly one COMMIT PLAN block");
  } else if (input.proxyLane && (endIndexes.length !== 1 || lines.findLastIndex((line) => line.trim().length > 0) !== endIndexes[0])) {
    throw new Error("recovery result COMMIT PLAN end marker must be the final non-empty line");
  }
  if (lines.filter((line) => acceptedRoleCommitTrailer(line, input)).length !== 1) {
    throw new Error("recovery result Garelier role identity trailer is missing or mismatched");
  }
}

function reviewStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) return null;
  const values = value as string[];
  return new Set(values).size === values.length ? values : null;
}

function validateCanonicalReviewArtifact(input: {
  container: string;
  snapshot: ContainerSnapshot;
  dispatchId: string;
  workId: string | null;
}): void {
  const artifact = input.snapshot.review_artifact;
  if (!artifact) return;
  if (!input.snapshot.entries.some((entry) => entry.path === "review.md" && entry.kind === "file")) {
    throw new Error("Dock review artifact requires its canonical review.md pair");
  }
  const reviewBytes = readSnapshotEntry({
    container: input.container,
    snapshot: input.snapshot,
    item: artifact.path,
    label: "Dock review artifact",
    maxBytes: MAX_AUTHORITY_JSON_BYTES,
  });
  if (sha256(reviewBytes) !== artifact.content_hash || reviewBytes.length !== artifact.byte_length) {
    throw new Error("Dock review artifact snapshot digest or byte length is inconsistent");
  }
  let review: Record<string, unknown>;
  try { review = record(JSON.parse(reviewBytes.toString("utf8")), "Dock review artifact"); }
  catch (error) { throw new Error(`Dock review artifact is malformed JSON: ${(error as Error).message}`); }
  const requiredKeys = [
    "schema_version", "assignment_id", "task_id", "role", "status", "verdict", "summary", "commits",
    "files_changed", "tests", "risk_flags", "needs",
  ];
  const allowedKeys = new Set([...requiredKeys, "allowlist"]);
  if (requiredKeys.some((key) => !Object.hasOwn(review, key))
    || Object.keys(review).some((key) => !allowedKeys.has(key))) {
    throw new Error("Dock review artifact has unknown or missing fields");
  }
  if (review.schema_version !== 1 || review.assignment_id !== input.dispatchId
    || input.workId === null || review.task_id !== input.workId || review.role !== "dock") {
    throw new Error("Dock review artifact identity is mismatched");
  }
  const verdicts: Readonly<Record<string, string>> = { pass: "PASS", rework: "REWORK", blocked: "BLOCK" };
  if (typeof review.status !== "string" || verdicts[review.status] !== review.verdict) {
    throw new Error("Dock review artifact status/verdict is mismatched");
  }
  const commits = reviewStringArray(review.commits);
  const filesChanged = reviewStringArray(review.files_changed);
  const needs = reviewStringArray(review.needs);
  const allowlist = review.allowlist === undefined ? [] : reviewStringArray(review.allowlist);
  let tests: Record<string, unknown>;
  let riskFlags: Record<string, unknown>;
  try {
    tests = record(review.tests, "Dock review tests");
    riskFlags = record(review.risk_flags, "Dock review risk flags");
  } catch {
    throw new Error("Dock review artifact field shape is malformed");
  }
  const testValues = new Set(["passed", "failed", "not_run"]);
  if (typeof review.summary !== "string" || review.summary.length === 0
    || commits === null || commits.some((commit) => !SHA_RE.test(commit))
    || filesChanged === null || needs === null || allowlist === null
    || Object.keys(tests).length !== 2 || !Object.hasOwn(tests, "fast") || !Object.hasOwn(tests, "full")
    || !testValues.has(String(tests.fast)) || !testValues.has(String(tests.full))
    || Object.keys(riskFlags).length !== 3
    || !["security", "external_write", "data_change"].every((key) => typeof riskFlags[key] === "boolean")
    || (review.allowlist !== undefined && review.status !== "rework")) {
    throw new Error("Dock review artifact field shape is malformed");
  }
  const context = parseJson(readSnapshotEntry({
    container: input.container,
    snapshot: input.snapshot,
    item: "context.json",
    label: "dispatch context for Dock review",
    maxBytes: MAX_AUTHORITY_JSON_BYTES,
  }).toString("utf8"), join(input.container, "context.json"));
  const task = record(context.task, "dispatch context task for Dock review");
  const contextTouches = reviewStringArray(task.touches);
  const contextActualTouches = task.touches_actual === undefined ? [] : reviewStringArray(task.touches_actual);
  const binding = parseJson(readSnapshotEntry({
    container: input.container,
    snapshot: input.snapshot,
    item: "control_binding.json",
    label: "dispatch control binding for Dock review",
    maxBytes: MAX_AUTHORITY_JSON_BYTES,
  }).toString("utf8"), join(input.container, "control_binding.json"));
  const bindingTouches = reviewStringArray(binding.touches);
  if (contextTouches === null || contextActualTouches === null || bindingTouches === null
    || canonicalJson([...contextTouches].sort()) !== canonicalJson([...bindingTouches].sort())
    || contextActualTouches.some((path) => !bindingTouches.includes(path))) {
    throw new Error("dispatch context touches for Dock review are malformed");
  }
  const authorized = new Set(bindingTouches);
  if (filesChanged.some((path) => !authorized.has(path))) {
    throw new Error("Dock review files_changed differs from dispatch context touches");
  }
  if (allowlist.some((path) => !authorized.has(path))) {
    throw new Error("Dock review allowlist differs from dispatch context touches");
  }
}

function validateCanonicalRecoveryArtifacts(input: {
  project: string;
  targetRoot: string;
  pmId: string;
  requestId: string;
  resultPath: string;
  request: Record<string, unknown>;
  container: string;
  checkout: string;
  snapshot: ContainerSnapshot;
  dispatchId: string;
  branch: string;
  workbenchTip: string;
  studioBranch: string;
  studioCommit: string;
  workId: string | null;
  sessionId: string | null;
  role: RoleBranchIdentity["family"];
}): void {
  const artifacts = input.snapshot.recovery_artifacts;
  if (!artifacts) return;
  const identity = dispatchExecutionIdentity(input.dispatchId);
  const requestBinding = recoveryBindingReference(input.request.role_binding, "recovery role binding in merge request");
  const contextSource = readSnapshotEntry({
    container: input.container,
    snapshot: input.snapshot,
    item: "context.json",
    label: "recovery dispatch context",
    maxBytes: MAX_AUTHORITY_JSON_BYTES,
  }).toString("utf8");
  const context = parseJson(contextSource, join(input.container, "context.json"));
  const contextBinding = recoveryBindingReference(roleBindingFromContext(context), "recovery role binding in dispatch context");
  if (canonicalJson(requestBinding) !== canonicalJson(artifacts.role_binding)
    || canonicalJson(requestBinding) !== canonicalJson(contextBinding)
    || canonicalJson(requestBinding.identity) !== canonicalJson(identity)) {
    throw new Error("recovery role binding differs between canonical dispatch context, request, or execution identity");
  }
  const authorization = readCurrentRoleAuthorization({
    project_root: input.project, pm_id: input.pmId, identity,
  });
  const expectedRole: Record<RoleBranchIdentity["family"], string> = {
    workbench: "worker", anvil: "smith", shelf: "librarian", satchel: "artisan",
  };
  if (canonicalJson(bindingReference(authorization)) !== canonicalJson(requestBinding)
    || authorization.core.carabiner !== "role_recovery" || authorization.core.recovery === null
    || authorization.core.role !== expectedRole[input.role]
    || authorization.core.item.work_id !== input.workId
    || authorization.core.item.session_id !== input.sessionId
    || authorization.core.integration.ref !== input.studioBranch) {
    throw new Error("recovery role binding does not match the canonical recovery authorization or landed item");
  }
  const closeReference = recoveryCloseReference(input.request.role_close, input.requestId, input.workbenchTip);
  const ledgerPath = authorization.core.instruction_ledger
    ? resolve(input.project, authorization.core.instruction_ledger.path)
    : undefined;
  const itemAuthorityPath = resolve(input.project, authorization.core.item.authority.path);
  const currentItemAuthorityHash = existsSync(itemAuthorityPath)
    ? hashRoleFile(itemAuthorityPath)
    : undefined;
  const itemAuthorityHashOverride = currentItemAuthorityHash !== undefined
    && currentItemAuthorityHash !== authorization.core.item.authority.content_hash
    ? currentItemAuthorityHash
    : undefined;
  if (itemAuthorityHashOverride) {
    const roots = garelierControlRoots(input.project, input.targetRoot, input.pmId);
    if (input.workId === null
      || !hasMergeControlEvidence(roots, input.workId, input.studioCommit, input.resultPath)) {
      throw new Error(
        `post-land item authority drift lacks exact merge control evidence: item authority source changed: ${authorization.core.item.authority.path}; `
        + `expected pre-claim content_hash=${authorization.core.item.authority.content_hash}. `
        + "After a successful land, run dispatch_cleanup before PM row/archive/blueprint aftercare. "
        + "For an archived uninspectable-gate recovery, re-run the same request with --replan-after-gate-recovery so the driver verifies the replacement seal, archives frozen journal authority, and replans.",
      );
    }
  }
  let checked: ReturnType<typeof validateRoleBinding>;
  try {
    checked = validateRoleBinding({
      project_root: input.project,
      pm_id: input.pmId,
      identity,
      stage: "merge_gate",
      generation: requestBinding.generation,
      expected_digest: requestBinding.binding_digest,
      candidate_sha: input.workbenchTip,
      report_path: join(input.container, "report.md"),
      ledger_path: ledgerPath,
      close_reference: closeReference,
      item_authority_hash_override: itemAuthorityHashOverride,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/^(?:item authority|blueprint) source changed:/.test(detail)) {
      const expected = detail.startsWith("blueprint source changed:")
        ? authorization.core.sources.blueprint?.content_hash ?? "unbound"
        : authorization.core.item.authority.content_hash;
      throw new Error(`${detail}; expected pre-claim content_hash=${expected}. After a successful land, run dispatch_cleanup before PM row/archive/blueprint aftercare. For an archived uninspectable-gate recovery, re-run the same request with --replan-after-gate-recovery so the driver verifies the replacement seal, archives frozen journal authority, and replans.`);
    }
    throw error;
  }
  if (canonicalJson(checked.reference) !== canonicalJson(requestBinding) || !checked.launch || !checked.close) {
    throw new Error("recovery role binding or close authority is not canonical");
  }
  const paths = roleBindingPaths(input.project, input.pmId, identity, requestBinding.generation);
  const launch = canonicalRoleRecord(paths.launch, "recovery role launch", ROLE_RECORD_KIND.launch);
  roleActor(launch.writer, new Set(["launcher", "attended-parent"]), "recovery role launch writer");
  if (Object.keys(launch).length !== 11
    || launch.binding_id !== requestBinding.binding_id || launch.binding_digest !== requestBinding.binding_digest
    || launch.generation !== requestBinding.generation || launch.prompt_hash !== authorization.core.sources.prompt.content_hash
    || typeof launch.transport !== "string" || !new Set(["codex-cli", "claude-subprocess", "attended-agent", "recorded-cli", "lane-dispatch"]).has(launch.transport)
    || typeof launch.provider_session_id !== "string" || launch.provider_session_id.length === 0
    || typeof launch.success_evidence !== "string" || launch.success_evidence.length === 0
    || typeof launch.launched_at !== "string" || !Number.isFinite(Date.parse(launch.launched_at))) {
    throw new Error("recovery role launch is malformed or mismatched");
  }
  const receiptArchivePath = join(paths.close_receipts, `${closeReference.receipt_id}.json`);
  const receiptPath = existsSync(receiptArchivePath) ? receiptArchivePath : paths.close;
  const receipt = canonicalRoleRecord(receiptPath, "recovery role close receipt", ROLE_RECORD_KIND.close);
  roleActor(receipt.writer, new Set(["admission-controller", "dock"]), "recovery role close writer");
  const report = record(receipt.report, "recovery role close report");
  const checkedSourceHashes = reviewStringArray(receipt.checked_source_hashes);
  const { receipt_id: _receiptId, ...receiptCore } = receipt;
  const boundReceiptId = createHash("sha256").update(canonicalJson(receiptCore)).digest("hex");
  const reportPath = join(input.container, "report.md");
  const reportRelative = relative(realpathSync.native(resolve(input.project)), realpathSync.native(reportPath)).replaceAll("\\", "/");
  const reportHash = createHash("sha256").update(readStableFile(reportPath, "recovery role report", MAX_REPORT_FILE_BYTES)).digest("hex");
  if (Object.keys(receipt).length !== 14 || Object.keys(report).length !== 2
    || receipt.receipt_id !== closeReference.receipt_id || boundReceiptId !== closeReference.receipt_id
    || receipt.binding_id !== requestBinding.binding_id || receipt.binding_digest !== requestBinding.binding_digest
    || receipt.generation !== requestBinding.generation || receipt.candidate_sha !== input.workbenchTip
    || report.path !== reportRelative || report.content_hash !== reportHash
    || checkedSourceHashes === null || checkedSourceHashes.length === 0
    || checkedSourceHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))
    || typeof receipt.final_instruction_chain_hash !== "string" || !/^[0-9a-f]{64}$/.test(receipt.final_instruction_chain_hash)
    || receipt.validator_version !== 1 || typeof receipt.receipt_nonce !== "string" || receipt.receipt_nonce.length === 0
    || typeof receipt.closed_at !== "string" || !Number.isFinite(Date.parse(receipt.closed_at))) {
    throw new Error("recovery role close receipt is malformed or mismatched");
  }
  const claimPath = join(paths.close_claims, `${input.requestId}.json`);
  const claim = canonicalRoleRecord(claimPath, "recovery role close claim", ROLE_RECORD_KIND.closeClaim);
  roleActor(claim.writer, new Set(["admission-controller", "dock"]), "recovery role close claim writer");
  if (Object.keys(claim).length !== 10
    || claim.binding_id !== requestBinding.binding_id || claim.binding_digest !== requestBinding.binding_digest
    || claim.generation !== requestBinding.generation || claim.receipt_id !== closeReference.receipt_id
    || claim.request_id !== input.requestId || claim.candidate_sha !== input.workbenchTip
    || typeof claim.claimed_at !== "string" || !Number.isFinite(Date.parse(claim.claimed_at))) {
    throw new Error("recovery role close claim is malformed or mismatched");
  }

  if (artifacts.transport === "attended-agent") {
    // The launch acknowledgement validated just above IS this lane's recovery
    // evidence. Freeze it: the plan digest covers `container_snapshot`, so the
    // record these bytes were planned against cannot be swapped for another
    // between planning and execution. There is no session record to read and no
    // `recovery.result.md` to validate — the register is `<container>/report.md`,
    // whose hash the close receipt above already binds.
    const launchBytes = readStableFile(paths.launch, "recovery role launch", MAX_AUTHORITY_JSON_BYTES);
    if (sha256(launchBytes) !== artifacts.launch.content_hash
      || launchBytes.length !== artifacts.launch.byte_length) {
      throw new Error("recovery role launch snapshot digest or byte length is inconsistent");
    }
    if (artifacts.provider_session_id !== launch.provider_session_id) {
      throw new Error("recovery provider session does not match the canonical role launch");
    }
    if (launch.transport !== "attended-agent") {
      throw new Error("recovery session provider does not match the canonical role launch transport");
    }
    validateRecoveryGateOutcome(input, paths, requestBinding, closeReference);
    return;
  }

  const sessionBytes = readSnapshotEntry({
    container: input.container,
    snapshot: input.snapshot,
    item: artifacts.session.path,
    label: "recovery session",
    maxBytes: MAX_AUTHORITY_JSON_BYTES,
  });
  if (sha256(sessionBytes) !== artifacts.session.content_hash || sessionBytes.length !== artifacts.session.byte_length) {
    throw new Error("recovery session snapshot digest or byte length is inconsistent");
  }
  const sessionSource = sessionBytes.toString("utf8");
  let session: Record<string, unknown>;
  try { session = record(JSON.parse(sessionSource), "recovery session"); }
  catch (error) { throw new Error(`recovery session is malformed JSON: ${(error as Error).message}`); }
  const allowedSessionKeys = new Set([
    "schema", "version", "provider", "session_id", "ownership_id", "worktree", "container", "operator_add_dirs",
    "worktree_identity", "status", "timestamps", "result_file", "routing",
  ]);
  const requiredSessionKeys = [
    "schema", "version", "provider", "session_id", "ownership_id", "worktree", "container",
    "worktree_identity", "status", "timestamps", "result_file", "routing",
  ];
  if (Object.keys(session).some((key) => !allowedSessionKeys.has(key))
    || requiredSessionKeys.some((key) => !Object.hasOwn(session, key))
    || session.schema !== SESSION_SCHEMA || session.version !== SESSION_VERSION || session.status !== "ready"
    || session.ownership_id !== `launch-${requestBinding.binding_digest}`) {
    throw new Error("recovery session schema, version, status, or fields are malformed");
  }
  const providerByTransport: Readonly<Record<string, string>> = {
    "codex-cli": "codex-cli", "claude-subprocess": "claude-code",
  };
  const expectedProvider = providerByTransport[String(launch.transport)];
  if (!expectedProvider || session.provider !== expectedProvider) {
    throw new Error("recovery session provider does not match the canonical role launch transport");
  }
  if (session.session_id !== launch.provider_session_id
    || artifacts.provider_session_id !== launch.provider_session_id) {
    throw new Error("recovery provider session does not match the canonical role launch");
  }
  if (typeof session.worktree !== "string" || !sameFilesystemPath(session.worktree, input.checkout)
    || typeof session.container !== "string" || !sameFilesystemPath(session.container, input.container)
    || typeof session.result_file !== "string"
    || !sameFilesystemPath(session.result_file, join(input.container, "lane", "recovery.result.md"))) {
    throw new Error("recovery session worktree, container, or result path is mismatched");
  }
  const worktreeIdentity = record(session.worktree_identity, "recovery session worktree identity");
  const expectedGitDir = gitText(input.checkout, ["rev-parse", "--absolute-git-dir"], "cannot resolve recovery worktree git identity");
  if (Object.keys(worktreeIdentity).length !== 1 || typeof worktreeIdentity.git_dir !== "string"
    || !sameFilesystemPath(worktreeIdentity.git_dir, expectedGitDir)) {
    throw new Error("recovery session worktree identity is mismatched");
  }
  const routing = record(session.routing, "recovery session routing");
  if (Object.keys(routing).length !== 3
    || routing.model !== authorization.core.routing.model
    || routing.effort !== authorization.core.routing.effort
    || routing.source !== authorization.core.routing.source) {
    throw new Error("recovery session routing is mismatched");
  }
  const timestamps = record(session.timestamps, "recovery session timestamps");
  if (Object.keys(timestamps).some((key) => !["created_at", "updated_at", "last_resume_at"].includes(key))
    || typeof timestamps.created_at !== "string" || !Number.isFinite(Date.parse(timestamps.created_at))
    || typeof timestamps.updated_at !== "string" || !Number.isFinite(Date.parse(timestamps.updated_at))
    || (timestamps.last_resume_at !== undefined
      && (typeof timestamps.last_resume_at !== "string" || !Number.isFinite(Date.parse(timestamps.last_resume_at))))) {
    throw new Error("recovery session timestamps are malformed");
  }
  if (session.operator_add_dirs !== undefined
    && (session.provider !== "codex-cli" || !Array.isArray(session.operator_add_dirs)
      || session.operator_add_dirs.some((path) => typeof path !== "string"))) {
    throw new Error("recovery session operator add-dir evidence is malformed");
  }

  const resultBytes = readSnapshotEntry({
    container: input.container,
    snapshot: input.snapshot,
    item: artifacts.result.path,
    label: "recovery result",
    maxBytes: MAX_REPORT_FILE_BYTES,
  });
  if (sha256(resultBytes) !== artifacts.result.content_hash || resultBytes.length !== artifacts.result.byte_length) {
    throw new Error("recovery result snapshot digest or byte length is inconsistent");
  }
  const resultSource = resultBytes.toString("utf8");
  validateRecoveryResult(resultSource, {
    branch: input.branch,
    pmId: input.pmId,
    dispatchId: input.dispatchId,
    role: authorization.core.role,
    workIds: roleCommitTrailerWorkIds(input.project, authorization),
    // Derived from the container the recovery ran in, never re-supplied.
    proxyLane: String((context.routing as Record<string, unknown> | undefined)?.commit_mode ?? '') === 'proxy',
  });

  validateRecoveryGateOutcome(input, paths, requestBinding, closeReference);
}

/** The successful merge-gate outcome every recovered lane's close must carry.
 * Shared by both transports: the gate outcome is a property of the landing, not
 * of how the producer was launched. */
function validateRecoveryGateOutcome(
  input: { requestId: string; workbenchTip: string },
  paths: { close_gate_outcomes: string },
  requestBinding: RoleBindingReference,
  closeReference: RoleCloseReference,
): void {
  const outcomePath = join(paths.close_gate_outcomes, `${input.requestId}.json`);
  const outcomeSource = readStableText(outcomePath, "recovery role close gate outcome", MAX_AUTHORITY_JSON_BYTES);
  const outcome = parseJson(outcomeSource, outcomePath);
  roleActor(outcome.writer, new Set(["merge-gate"]), "recovery role close gate outcome writer");
  if (outcomeSource !== canonicalJson(outcome)
    || outcome.schema_version !== 1 || outcome.kind !== ROLE_RECORD_KIND.closeGateOutcome
    || Object.keys(outcome).length !== 13
    || outcome.binding_id !== requestBinding.binding_id || outcome.binding_digest !== requestBinding.binding_digest
    || outcome.generation !== requestBinding.generation || outcome.receipt_id !== closeReference.receipt_id
    || outcome.request_id !== input.requestId || outcome.candidate_sha !== input.workbenchTip
    || outcome.status !== "success" || outcome.invalidates_close !== false || outcome.failure_reason !== null
    || typeof outcome.ended_at !== "string" || !Number.isFinite(Date.parse(outcome.ended_at))) {
    throw new Error("recovery role close gate outcome is missing, non-canonical, or not successful");
  }
}

export const MAX_AFTERCARE_PREDICATE_DETAIL_BYTES = 4096;

export function boundedAftercarePredicateDetail(detail: string): string {
  const bytes = Buffer.byteLength(detail, "utf8");
  if (bytes <= MAX_AFTERCARE_PREDICATE_DETAIL_BYTES) return detail;
  return `bounded_detail bytes=${bytes} sha256=${sha256(detail).replace(/^sha256:/, "")}`;
}

function predicate(list: SafetyPredicate[], name: string, ok: boolean, detail: string): void {
  const boundedDetail = boundedAftercarePredicateDetail(detail);
  list.push({ name, ok, detail: boundedDetail });
  if (!ok) throw new Error(`${name}: ${boundedDetail}`);
}

function planPayload(plan: Omit<LandAftercarePlan, "plan_digest"> | LandAftercarePlan): string {
  return canonicalJson({
    schema_version: plan.schema_version,
    request_id: plan.request_id,
    request_path: plan.request_path,
    request_hash: plan.request_hash,
    result_path: plan.result_path,
    result_hash: plan.result_hash,
    project_root: plan.project_root,
    target_root: plan.target_root,
    pm_id: plan.pm_id,
    work_id: plan.work_id,
    control_session_id: plan.control_session_id,
    dispatch_id: plan.dispatch_id,
    container: plan.container,
    container_snapshot: plan.container_snapshot,
    checkout: plan.checkout,
    aftercare_binding: plan.aftercare_binding,
    workbench_branch: plan.workbench_branch,
    workbench_tip: plan.workbench_tip,
    studio_branch: plan.studio_branch,
    studio_commit: plan.studio_commit,
    current_studio_tip: plan.current_studio_tip,
    report_source: plan.report_source,
    report_json_source: plan.report_json_source,
    role_report_path: plan.role_report_path,
    ...(plan.lane_artifacts === undefined ? {} : { lane_artifacts: plan.lane_artifacts }),
    preserved_artifacts: plan.preserved_artifacts,
    preservation_skips: plan.preservation_skips,
    preserve_root: plan.preserve_root,
    declared_preservation: plan.declared_preservation,
    report_archive: plan.report_archive,
    report_json_archive: plan.report_json_archive,
    journal_path: plan.journal_path,
    envelope_path: plan.envelope_path,
    predicates: plan.predicates,
    actions: plan.actions,
    ...(plan.force_remove ? { force_remove: true } : {}),
  });
}

function planAuthorityPayload(plan: Omit<LandAftercarePlan, "plan_digest"> | LandAftercarePlan): string {
  const payload = JSON.parse(planPayload(plan)) as Record<string, unknown>;
  delete payload.container_snapshot;
  // The merge gate atomically moves immutable evidence between pending/result
  // and archive names. Location is operational metadata, never pair identity.
  delete payload.request_path;
  delete payload.result_path;
  // Live-only predicates (worktree/ref presence and cleanliness) intentionally
  // disappear after their authorized removal. They remain frozen in the
  // journal's self-digest but are not re-derived as post-removal authority.
  delete payload.predicates;
  // A destructive recovery choice changes execution, not merge identity.
  delete payload.force_remove;
  // Preservation selection diagnostics were added after journals already
  // existed in the field. They explain why runtime evidence was skipped; they
  // do not identify the successful merge pair, so a pre-field journal remains
  // resumable without a conversion or rewrite.
  delete payload.preservation_skips;
  // W-778: the studio TIP is an observation of a moving branch, not evidence of
  // this merge. The normal order is land -> PM commits the Control trail ->
  // cleanup, so the tip has almost always advanced by the time a resumed
  // aftercare re-derives the plan, and comparing it made the journal fail to
  // match itself (_workshop #520, 2026-09-10: journal froze 4b939218, the PM's
  // own evidence commit 1ebb9b62 then dead-ended the cleanup and held the
  // container's claim). What identifies THIS merge is request-bound and
  // immutable — request/result bytes, `workbench_tip`, `studio_commit`,
  // `role_report_path` — and all of it stays authority above. The tip remains
  // frozen in the plan (and so in the journal's self-digest) as the observation
  // it always was; what changes is that it is no longer re-derived and compared.
  // The safety it was standing in for is the ancestry check in
  // `assertFrozenPair`: the landed `studio_commit` must still be reachable from
  // the live tip, which refuses a rewound or rewritten studio while permitting
  // an ordinary later merge.
  delete payload.current_studio_tip;
  return canonicalJson(payload);
}

function reportArchiveBody(plan: LandAftercarePlan, container: string, id: string, slug: string, branch: string): string | null {
  const names = ["assignment", "report", "questions", "answers", "instructions", "review"];
  const available = new Set(plan.container_snapshot?.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path) ?? []);
  const recovery = plan.container_snapshot?.recovery_artifacts;
  const review = plan.container_snapshot?.review_artifact;
  if (!names.some((name) => available.has(`${name}.md`)) && !recovery && !review) return null;
  let body = `# #${id} ${slug} - archived by land_aftercare (${branch})\n\n`;
  const parts: string[] = [];
  for (const name of names) {
    const item = `${name}.md`;
    if (available.has(item)) parts.push(readFrozenContainerFile(plan, container, item).toString("utf8"));
  }
  if (recovery) {
    // The archive preserves what the retirement DESTROYS. A subprocess lane's
    // recovery pair lives in the container, so its bytes are carried here; an
    // attended lane's evidence is the launch acknowledgement, which stays in
    // the canonical binding tree, so only its frozen identity is recorded.
    const artifacts = recovery.transport === "attended-agent"
      ? [{ ...recovery.launch }]
      : [
        {
          ...recovery.result, encoding: "base64",
          content_base64: readFrozenContainerFile(plan, container, recovery.result.path).toString("base64"),
        },
        {
          ...recovery.session, encoding: "base64",
          content_base64: readFrozenContainerFile(plan, container, recovery.session.path).toString("base64"),
        },
      ];
    const archive = {
      schema_version: 1,
      kind: ROLE_RECOVERY_ARCHIVE_RECORD_KIND,
      role_binding: recovery.role_binding,
      provider_session_id: recovery.provider_session_id,
      transport: recovery.transport,
      artifacts,
    };
    parts.push(`## Canonical role recovery archive\n\n\`\`\`json\n${canonicalJson(archive)}\`\`\`\n`);
  }
  if (review) {
    const reviewBytes = readFrozenContainerFile(plan, container, review.path);
    const archive = {
      schema_version: 1,
      kind: "garelier_dock_review_archive",
      artifact: { ...review, encoding: "base64", content_base64: reviewBytes.toString("base64") },
    };
    parts.push(`## Canonical Dock review archive\n\n\`\`\`json\n${canonicalJson(archive)}\`\`\`\n`);
  }
  body += parts.join("\n---\n\n");
  return body;
}

export function canonicalIdempotencyKey(requestId: string, resultHash: string, planDigest: string): string {
  const fields = [requestId, resultHash, planDigest];
  const encoded = fields.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("");
  return `aftercare-v1:${createHash("sha256").update(encoded).digest("hex")}`;
}

function deriveLandAftercarePlan(
  options: PlanLandAftercareOptions,
  requireLiveTargets: boolean,
  frozenDeclaredPreservation?: DeclaredPreservationSnapshot | null,
  frozenPreservationSkips?: string[],
): LandAftercarePlan {
  // W-764: the plan's paths are STORED in the journal envelope and later
  // compared, string-exact, against a re-derivation
  // (`validateJournalAgainstPlan`). The two derivations run from different
  // callers — one from a `--project` typed by a human or a test, the other from
  // a hook that resolved it through the shell — so the root is canonicalized
  // once here and every derived path inherits that one spelling. Without it a
  // Windows 8.3 spelling on either side made the journal fail to match itself.
  const project = canonicalPath(resolve(options.project));
  const targetRoot = canonicalPath(resolve(options.targetRoot ?? project));
  const pmRoot = join(project, "__garelier", options.pmId);
  if (!existsSync(pmRoot) || !lstatSync(pmRoot).isDirectory()) throw new Error(`PM root is missing: ${pmRoot}`);
  const pair = readMergePair(project, options.pmId, options.requestId);
  const requestId = exactString(pair.request.request_id, "request.request_id");
  predicate([], "request_id_match", requestId === options.requestId, `${requestId} != ${options.requestId}`);
  if (pair.result.request_id !== requestId) throw new Error(`result.request_id does not match request: ${String(pair.result.request_id)}`);
  if (pair.result.status !== "success") throw new Error(`merge result is not terminal success: ${String(pair.result.status)}`);
  const branch = exactString(pair.request.workbench_branch, "request.workbench_branch");
  const workbenchTip = exactSha(pair.request.workbench_tip, "request.workbench_tip");
  const studioBranch = exactString(pair.request.studio_branch, "request.studio_branch");
  const studioCommit = exactSha(pair.result.studio_commit, "result.studio_commit");
  const resultBranch = exactString(pair.result.workbench_branch, "result.workbench_branch");
  const resultTip = exactSha(pair.result.workbench_tip, "result.workbench_tip");
  if (resultBranch !== branch) throw new Error("result.workbench_branch does not match request");
  if (resultTip !== workbenchTip) throw new Error("result.workbench_tip does not match request");
  const requestTarget = exactString(pair.request.target_root, "request.target_root");
  const setupConfig = loadConfig(project, options.pmId);
  const configuredBranches = setupConfig.branches;
  const configuredStudio = configuredBranches.integration;
  const branchIdentity = roleBranchIdentity(branch, configuredBranches.targetSlug, options.pmId);
  const aftercareBinding = exactString(pair.request.aftercare_binding, "request.aftercare_binding") as AftercareBinding;
  if (aftercareBinding !== "dispatch" && aftercareBinding !== "branch_only") {
    throw new Error(`request.aftercare_binding is unsupported: ${aftercareBinding}`);
  }
  if (branch === configuredBranches.target || branch === configuredStudio) {
    throw new Error(`protected target/studio ref cannot enter aftercare: ${branch}`);
  }
  const predicates: SafetyPredicate[] = [];
  predicate(predicates, "target_root_exact", sameFilesystemPath(requestTarget, targetRoot), `${requestTarget} == ${targetRoot}`);
  predicate(predicates, "studio_branch_exact", studioBranch === configuredStudio, `${studioBranch} == ${configuredStudio}`);
  const currentStudioTip = gitText(targetRoot, ["rev-parse", "--verify", `${studioBranch}^{commit}`], "cannot resolve current studio tip");
  if (requireLiveTargets) {
    const branchTip = gitText(targetRoot, ["rev-parse", "--verify", `${branch}^{commit}`], "cannot resolve workbench branch tip");
    predicate(predicates, "branch_ref_matches_request_tip", branchTip === workbenchTip, `${branchTip} == ${workbenchTip}`);
  }
  predicate(predicates, "request_tip_ancestor_of_result", isAncestor(targetRoot, workbenchTip, studioCommit), `${workbenchTip} -> ${studioCommit}`);
  predicate(predicates, "result_ancestor_of_current_studio", isAncestor(targetRoot, studioCommit, currentStudioTip), `${studioCommit} -> ${currentStudioTip}`);

  const workId = typeof pair.request.work_id === "string" ? pair.request.work_id : null;
  const sessionId = typeof pair.request.control_session_id === "string" ? pair.request.control_session_id : null;
  if ((workId === null) !== (sessionId === null)) throw new Error("request work_id/control_session_id must both be present or both be absent");
  if (pair.result.work_id !== undefined && pair.result.work_id !== workId) throw new Error("result.work_id does not match request");
  if (pair.result.control_session_id !== undefined && pair.result.control_session_id !== sessionId) throw new Error("result.control_session_id does not match request");
  const requestDispatch = pair.request.dispatch_id;
  const dispatchId = requestDispatch === null ? null : exactString(requestDispatch, "request.dispatch_id");
  if (dispatchId !== null && !/^\d+$/.test(dispatchId)) throw new Error(`request.dispatch_id must be numeric: ${dispatchId}`);
  const branchDispatch = branchIdentity.family === "satchel" ? null : branchIdentity.numericId;
  if (aftercareBinding === "dispatch" && branchIdentity.family === "satchel") {
    throw new Error("satchel aftercare cannot claim a dispatch container");
  }
  if (aftercareBinding === "dispatch" && dispatchId !== branchDispatch) {
    throw new Error(`request.dispatch_id does not match branch dispatch identity: ${dispatchId ?? "null"} != ${branchDispatch ?? "null"}`);
  }
  if (aftercareBinding === "branch_only" && dispatchId !== null) {
    throw new Error("branch-only aftercare must not carry dispatch_id");
  }
  const requestedByCaller = options.dispatchId === undefined || options.dispatchId === null ? null : String(options.dispatchId).replace(/^#/, "");
  if (requestedByCaller !== null && requestedByCaller !== dispatchId) throw new Error("caller dispatch id does not match immutable merge request");
  const requestContainer = pair.request.dispatch_container;
  const container = requestContainer === null ? null : exactString(requestContainer, "request.dispatch_container");
  if ((dispatchId === null) !== (container === null)) throw new Error("request dispatch_id/dispatch_container must both be null or both be present");
  if (aftercareBinding === "dispatch" && (dispatchId === null || container === null)) throw new Error("dispatch aftercare requires immutable dispatch_id/container");
  if (aftercareBinding === "branch_only" && container !== null) throw new Error("branch-only aftercare must not carry a dispatch container");
  if (dispatchId !== null) {
    const expectedContainer = crewSubdir(project, options.pmId, `dispatch${dispatchId}`);
    predicate(predicates, "dispatch_container_exact", sameFilesystemPath(container!, expectedContainer), `${container} == ${expectedContainer}`);
  }
  const checkout = container === null ? null : join(container, "checkout");
  const writtenByRun = authenticatedLaneArtifacts({
    projectRoot: project,
    pmId: options.pmId,
    dispatchId,
    requestBinding: pair.request.role_binding,
  });
  let containerSnapshot: ContainerSnapshot | null = null;
  // W-713: filled by validateContainer below. Empty on every container whose
  // entries aftercare already recognises, so a lane that leaves nothing behind
  // reads exactly as it did before.
  const preservedArtifacts: string[] = [];
  // Unknown sources survive logical retirement. Re-admission must rederive
  // their inventory too; an empty list disagrees with the authenticated plan.
  if (!requireLiveTargets && container && existsSync(container)) {
    assertNoSymlinkPath(dirname(container), container);
    validateContainerInventory(container, false, 4096, options.forceRemove === true, preservedArtifacts, writtenByRun);
  }
  const worktrees = requireLiveTargets ? registeredWorktrees(targetRoot) : [];
  const branchWorktrees = worktrees.filter((entry) => entry.branch === branch);
  if (requireLiveTargets && checkout === null) {
    predicate(predicates, "branch_not_checked_out", branchWorktrees.length === 0, `registered worktrees=${branchWorktrees.map((entry) => entry.path).join(",") || "none"}`);
  } else if (requireLiveTargets && checkout !== null) {
    const exactContainer = container!;
    predicate(predicates, "container_inside_pm_root", pathInside(exactContainer, pmRoot), exactContainer);
    predicate(predicates, "checkout_exact_registered_path", branchWorktrees.length === 1 && sameFilesystemPath(branchWorktrees[0]!.path, checkout), branchWorktrees.map((entry) => entry.path).join(",") || "none");
    const registered = branchWorktrees[0]!;
    predicate(predicates, "checkout_head_matches_request_tip", registered.head === workbenchTip, `${registered.head} == ${workbenchTip}`);
    const inventory = validateContainer(exactContainer, checkout, options.forceRemove === true, preservedArtifacts, writtenByRun);
    const ownershipFilesPresent = existsSync(join(exactContainer, "context.json")) || existsSync(join(exactContainer, "control_binding.json"));
    if (ownershipFilesPresent || !options.forceRemove) {
      validateContainerOwnership({ container: exactContainer, dispatchId: dispatchId!, branch, workId, sessionId });
    }
    containerSnapshot = captureContainerSnapshot(exactContainer, inventory, {
      projectRoot: project, pmId: options.pmId, dispatchId: dispatchId!,
    });
    validateCanonicalReviewArtifact({
      container: exactContainer,
      snapshot: containerSnapshot,
      dispatchId: dispatchId!,
      workId,
    });
    validateCanonicalRecoveryArtifacts({
      project,
      targetRoot,
      pmId: options.pmId,
      requestId,
      resultPath: pair.resultPath,
      request: pair.request,
      container: exactContainer,
      checkout,
      snapshot: containerSnapshot,
      dispatchId: dispatchId!,
      branch,
      workbenchTip,
      studioBranch,
      studioCommit,
      workId,
      sessionId,
      role: branchIdentity.family,
    });
    const checkedBranch = gitText(checkout, ["branch", "--show-current"], "cannot read checked-out branch");
    const checkedHead = gitText(checkout, ["rev-parse", "--verify", "HEAD^{commit}"], "cannot read checkout HEAD");
    const dirty = checkoutDirtyStatus(checkout, "cannot measure checkout cleanliness");
    predicate(predicates, "checked_out_branch_matches_request", checkedBranch === branch, `${checkedBranch} == ${branch}`);
    predicate(predicates, "checkout_head_matches_request_tip_live", checkedHead === workbenchTip, `${checkedHead} == ${workbenchTip}`);
    predicate(
      predicates,
      "checkout_clean_or_force_remove",
      options.forceRemove === true || dirty.length === 0,
      dirty ? (options.forceRemove ? `force-remove authorized dirty checkout: ${summarizeCheckoutDirtyStatus(dirty)}` : summarizeCheckoutDirtyStatus(dirty)) : "clean",
    );
  }

  const slug = branchIdentity.slug;
  const reportSource = container ? join(container, "report.md") : null;
  const requestReportJson = pair.request.role_report_json_path;
  const reportJsonSource = requestReportJson === null ? null : exactString(requestReportJson, "request.role_report_json_path");
  if (reportJsonSource !== null) {
    if (!container || !sameFilesystemPath(reportJsonSource, join(container, "report.json"))) {
      throw new Error("request structured report path does not match the exact dispatch container sidecar");
    }
    if (requireLiveTargets && (!existsSync(reportJsonSource) || lstatSync(reportJsonSource).isSymbolicLink() || !lstatSync(reportJsonSource).isFile())) {
      throw new Error("request structured report sidecar is missing or not a real file");
    }
  }
  const roleReportPath = typeof pair.request.role_report_path === "string" ? pair.request.role_report_path : null;
  const reportArchive = container && dispatchId ? join(pmRoot, "runtime", "backlog", "done", `${dispatchId}-${slug}.md`) : null;
  const reportJsonArchive = reportArchive && reportJsonSource ? reportArchive.replace(/\.md$/, ".json") : null;
  const runtimeRoot = join(pmRoot, "runtime", "land_aftercare");
  const journalPath = join(runtimeRoot, "journals", `${requestId}.json`);
  const envelopePath = join(runtimeRoot, "envelopes", `${requestId}.json`);
  const declaredPreservation = container === null
    ? null
    : frozenDeclaredPreservation !== undefined
      ? frozenDeclaredPreservation
      : captureDeclaredPreservationSnapshot({
        projectRoot: project,
        pmId: options.pmId,
        dispatchId,
        workId,
        reviewSha: workbenchTip,
        declaredPaths: setupConfig.qualityGate.preservedPaths,
        retentionLimitBytes: setupConfig.retention.preservedArtifactMaxBytes,
        runtimeArchiveKeepDays: setupConfig.retention.runtimeArchiveKeepDays,
        runtimeArchiveKeepFiles: setupConfig.retention.runtimeArchiveKeepFiles,
      });
  // The initial live plan authenticates the complete container snapshot and
  // freezes which historical gate logs were outside the candidate-bound
  // denominator. A resume intentionally re-derives without a live snapshot,
  // so retain that authenticated exclusion set instead of silently changing
  // the journal authority after Control finalization.
  const preservationSkips = frozenPreservationSkips ?? gatePreservationScope({
    project_root: project, pm_id: options.pmId, container,
    dispatch_id: dispatchId, checkout, container_snapshot: containerSnapshot,
    workbench_tip: workbenchTip,
  }).skips;
  const withoutDigest: Omit<LandAftercarePlan, "plan_digest"> = {
    schema_version: 1,
    request_id: requestId,
    request_path: pair.requestPath,
    request_hash: sha256(pair.requestSource),
    result_path: pair.resultPath,
    result_hash: sha256(pair.resultSource),
    project_root: project,
    target_root: targetRoot,
    pm_id: options.pmId,
    work_id: workId,
    control_session_id: sessionId,
    dispatch_id: dispatchId,
    container,
    container_snapshot: containerSnapshot,
    checkout,
    aftercare_binding: aftercareBinding,
    workbench_branch: branch,
    workbench_tip: workbenchTip,
    studio_branch: studioBranch,
    studio_commit: studioCommit,
    current_studio_tip: currentStudioTip,
    report_source: reportSource,
    report_json_source: reportJsonSource,
    role_report_path: roleReportPath,
    lane_artifacts: [...writtenByRun].sort(),
    preserved_artifacts: preservedArtifacts,
    preservation_skips: preservationSkips,
    preserve_root: container && dispatchId
      ? gateArtifactPreserveRoot(project, options.pmId, workId ?? "", dispatchId)
      : null,
    declared_preservation: declaredPreservation,
    report_archive: reportArchive,
    report_json_archive: reportJsonArchive,
    journal_path: journalPath,
    envelope_path: envelopePath,
    predicates,
    actions: [
      { state: "prepared", target: journalPath },
      { state: "control_finalized", target: workId },
      { state: "archived", target: reportArchive },
      { state: "worktree_removed", target: checkout },
      { state: "branch_removed", target: branch },
      { state: "container_retired", target: container },
      { state: "views_refreshed", target: envelopePath },
      { state: "container_removed", target: container },
    ],
    ...(options.forceRemove ? { force_remove: true as const } : {}),
  };
  return { ...withoutDigest, plan_digest: sha256(planPayload(withoutDigest)) };
}

export function planLandAftercare(options: PlanLandAftercareOptions): LandAftercarePlan {
  return deriveLandAftercarePlan(options, true);
}

function initialEnvelope(plan: LandAftercarePlan): AftercareResultEnvelope {
  const reportPayload = {
    path: plan.report_archive,
    source: plan.report_source,
    json_path: plan.report_json_archive,
    json_source: plan.report_json_source,
  };
  const registerPayload = { request_id: plan.request_id, work_id: plan.work_id, studio_commit: plan.studio_commit, journal: plan.journal_path };
  const manifestPayload = { command: "dispatch_event --regen-only", pm_id: plan.pm_id };
  const mirrorPayload = { argv: ["--project", plan.project_root, "--pm-id", plan.pm_id, "--include-dispatches", "--format", "ops"] };
  const operation = (surface: AftercareOperation["surface"], payload: unknown, provider = false): AftercareOperation => ({
    surface,
    payload,
    payload_hash: sha256(canonicalJson(payload)),
    local_ack: "pending",
    provider_ack: provider ? "pending" : "not_applicable",
  });
  return {
    schema_version: 1,
    kind: "garelier_land_aftercare_result",
    idempotency_key: canonicalIdempotencyKey(plan.request_id, plan.result_hash, plan.plan_digest),
    request_id: plan.request_id,
    work_id: plan.work_id,
    studio_commit: plan.studio_commit,
    dispatch: { id: plan.dispatch_id, container: plan.container },
    report_archive: {
      path: plan.report_archive,
      content_hash: null,
      json_path: plan.report_json_archive,
      json_content_hash: null,
    },
    retirement_tombstone: null,
    physical_gc_pending: false,
    journal_state: "prepared",
    local_cleanup_complete: false,
    external_sync_pending: true,
    operations: [
      operation("report_archive", reportPayload),
      operation("local_register", registerPayload),
      operation("derived_manifest", manifestPayload),
      operation("task_mirror", mirrorPayload, true),
    ],
  };
}

function parseJournalFile(path: string): AftercareJournal {
  const value = parseJson(readStableText(path, "aftercare journal", MAX_AUTHORITY_JSON_BYTES), path) as unknown as AftercareJournal;
  if (value.schema_version !== 1 || value.kind !== "garelier_land_aftercare_journal") throw new Error(`unsupported aftercare journal: ${path}`);
  if (!AFTERCARE_STATES.includes(value.state)) throw new Error(`invalid aftercare journal state: ${String(value.state)}`);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error(`invalid aftercare journal revision: ${String(value.revision)}`);
  if (value.pending_step !== null && !AFTERCARE_STATES.includes(value.pending_step)) throw new Error(`invalid aftercare pending step: ${String(value.pending_step)}`);
  if (!CONTENT_HASH_RE.test(value.genesis_plan_digest)
    || (value.previous_revision_hash !== null && !CONTENT_HASH_RE.test(value.previous_revision_hash))
    || !CONTENT_HASH_RE.test(value.record_hash)) {
    throw new Error(`aftercare journal hash-chain fields are malformed: ${path}`);
  }
  if (value.retirement_claim !== null) throw new Error(`aftercare journal physical retirement claim is forbidden: ${path}`);
  if (value.provider_receipt === undefined) throw new Error(`aftercare journal provider receipt field is missing: ${path}`);
  if (value.provider_receipt !== null && (value.provider_receipt.schema_version !== 1
    || value.provider_receipt.kind !== "garelier_land_aftercare_provider_receipt"
    || value.provider_receipt.surface !== "task_mirror"
    || value.provider_receipt.request_id !== value.request_id
    || typeof value.provider_receipt.idempotency_key !== "string"
    || !CONTENT_HASH_RE.test(value.provider_receipt.payload_hash)
    || !Number.isFinite(Date.parse(value.provider_receipt.acknowledged_at)))) {
    throw new Error(`aftercare journal provider receipt is malformed: ${path}`);
  }
  return value;
}

function journalRecordHash(journal: AftercareJournal): string {
  const { record_hash: _recordHash, ...payload } = journal;
  return sha256(canonicalJson(payload));
}

function journalRevisionDirectory(path: string): string {
  return `${path}.revisions`;
}

function readJournalOptional(path: string): AftercareJournal | null {
  const revisions = journalRevisionDirectory(path);
  if (!existsSync(revisions)) {
    if (existsSync(path)) throw new Error("aftercare journal cache exists without append-only genesis");
    return null;
  }
  const info = lstatSync(revisions);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`aftercare journal revision store must be a real directory: ${revisions}`);
  const records: AftercareJournal[] = [];
  const revisionEntries = readdirSync(revisions);
  const revisionCount = revisionEntries.filter((entry) => /^\d{12}\.json$/.test(entry)).length;
  if (revisionCount > MAX_JOURNAL_REVISIONS) throw new Error(`aftercare journal revision count exceeds ${MAX_JOURNAL_REVISIONS}: ${revisionCount}`);
  for (const entry of revisionEntries) {
    if (/^\.\d{12}\.json\.[A-Za-z0-9-]+\.tmp$/.test(entry)) continue;
    if (!/^\d{12}\.json$/.test(entry)) throw new Error(`unknown aftercare journal revision artifact: ${entry}`);
    const recordPath = join(revisions, entry);
    const recordInfo = lstatSync(recordPath);
    if (recordInfo.isSymbolicLink() || !recordInfo.isFile()) throw new Error(`aftercare journal revision must be a real file: ${recordPath}`);
    const journal = parseJournalFile(recordPath);
    if (Number(entry.slice(0, 12)) !== journal.revision) throw new Error(`aftercare journal revision filename/content mismatch: ${recordPath}`);
    records.push(journal);
  }
  if (records.length === 0) {
    if (existsSync(path)) throw new Error("aftercare journal cache exists without append-only genesis");
    return null;
  }
  records.sort((left, right) => left.revision - right.revision);
  const genesisPlan = canonicalJson(records[0]!.plan);
  const genesisDigest = records[0]!.plan.plan_digest;
  let frozenReceipt: ProviderAckReceipt | null = null;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const prior = index === 0 ? null : records[index - 1]!;
    if (record.revision !== index) throw new Error(`aftercare journal revisions must be contiguous from genesis: expected ${index}, found ${record.revision}`);
    if (record.genesis_plan_digest !== genesisDigest || record.plan.plan_digest !== genesisDigest
      || canonicalJson(record.plan) !== genesisPlan) {
      throw new Error(`aftercare journal frozen genesis plan changed at revision ${record.revision}`);
    }
    if (record.previous_revision_hash !== (prior?.record_hash ?? null)) {
      throw new Error(`aftercare journal hash-chain predecessor mismatch at revision ${record.revision}`);
    }
    if (record.record_hash !== journalRecordHash(record)) {
      throw new Error(`aftercare journal record hash mismatch at revision ${record.revision}`);
    }
    if (frozenReceipt === null && record.provider_receipt !== null) frozenReceipt = record.provider_receipt;
    if (frozenReceipt !== null && canonicalJson(record.provider_receipt) !== canonicalJson(frozenReceipt)) {
      throw new Error(`aftercare journal provider receipt changed or disappeared at revision ${record.revision}`);
    }
  }
  const latest = records.at(-1)!;
  if (existsSync(path)) {
    try {
      const cache = parseJournalFile(path);
      if (cache.revision > latest.revision) throw new Error("aftercare journal cache is newer than its append-only authority");
    } catch (error) {
      if ((error as Error).message.includes("newer than its append-only authority")) throw error;
      // Malformed/stale cache bytes are derived state; the locked caller repairs
      // them from the append-only revision authority before mutation.
    }
  }
  return latest;
}

function readJournal(path: string): AftercareJournal {
  const journal = readJournalOptional(path);
  if (!journal) throw new Error(`aftercare journal is missing: ${path}`);
  return journal;
}

function journalEvidenceExists(path: string): boolean {
  return readJournalOptional(path) !== null;
}

function writeJournalCas(journal: AftercareJournal, expected: AftercareJournal | null): AftercareJournal {
  const path = journal.plan.journal_path;
  const current = readJournalOptional(path);
  if (expected === null) {
    if (current !== null) throw new Error("aftercare journal CAS failed: expected no journal");
  } else {
    if (current === null) throw new Error("aftercare journal CAS failed: expected journal disappeared");
    if (canonicalJson(current) !== canonicalJson(expected)) {
      throw new Error(`aftercare journal CAS failed: expected exact revision/state/digest snapshot ${expected.revision}/${expected.state}/${expected.plan.plan_digest}`);
    }
  }
  const nextBase: AftercareJournal = {
    ...journal,
    revision: (expected?.revision ?? -1) + 1,
    genesis_plan_digest: expected?.genesis_plan_digest ?? journal.plan.plan_digest,
    previous_revision_hash: expected?.record_hash ?? null,
    record_hash: "sha256:" + "0".repeat(64),
    updated_at: new Date().toISOString(),
  };
  const next: AftercareJournal = { ...nextBase, record_hash: journalRecordHash(nextBase) };
  const runtimeRoot = join(journal.plan.project_root, "__garelier", journal.plan.pm_id, "runtime");
  const revisionDir = journalRevisionDirectory(path);
  ensureSafeDirectory(runtimeRoot, revisionDir);
  const revisionPath = join(revisionDir, `${String(next.revision).padStart(12, "0")}.json`);
  const temporaryPath = join(revisionDir, `.${String(next.revision).padStart(12, "0")}.json.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, canonicalJson(next), { encoding: "utf8", flag: "wx", mode: 0o600 });
    linkSync(temporaryPath, revisionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`aftercare journal revision already exists: ${next.revision}`);
    }
    throw error;
  } finally {
    try { unlinkSync(temporaryPath); } catch { /* best-effort private temp cleanup */ }
  }
  // The append-only revision above is authority. This file is a compatibility
  // cache; a hard stop in its replacement gap is repaired on the next locked
  // resume without losing the committed transition.
  atomicWriteRuntimeFile(runtimeRoot, path, canonicalJson(next));
  return next;
}

function sameLockIdentity(left: LockOwner, right: LockOwner): boolean {
  return left.request_id === right.request_id
    && left.pid === right.pid
    && left.host === right.host
    && left.nonce === right.nonce
    && left.process_start_identity === right.process_start_identity;
}

function parseLockOwner(path: string): LockOwner {
  const owner = parseJson(readStableText(path, "aftercare lock owner", MAX_LOCK_RECORD_BYTES), path) as unknown as LockOwner;
  if (owner.schema_version !== 1 || !SAFE_ID_RE.test(owner.request_id)
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.process_start_identity !== "string" || owner.process_start_identity.length === 0
    || typeof owner.nonce !== "string" || owner.nonce.length === 0
    || typeof owner.host !== "string" || owner.host.length === 0
    || !Number.isFinite(Date.parse(owner.acquired_at))) {
    throw new Error(`aftercare request lock owner is malformed: ${path}`);
  }
  return owner;
}

interface DirectoryIdentity { device: string; inode: string }

function directoryIdentity(path: string, label: string): DirectoryIdentity {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
  return { device: String(info.dev), inode: String(info.ino) };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function claimStaleLockDirectory(lockDir: string, expected: LockOwner, beforeRename: () => void = () => {}): string {
  const ownerPath = join(lockDir, "owner.json");
  const immediatelyBefore = parseLockOwner(ownerPath);
  if (!sameLockIdentity(immediatelyBefore, expected)) {
    throw new Error("aftercare stale-lock owner nonce/process_start_identity changed before removal");
  }
  const identity = directoryIdentity(lockDir, "aftercare stale lock");
  beforeRename();
  const quarantine = `${lockDir}.stale-${randomUUID()}`;
  renameSync(lockDir, quarantine);
  const claimedIdentity = directoryIdentity(quarantine, "aftercare stale lock tombstone");
  const claimedOwnerPath = join(quarantine, "owner.json");
  const claimedOwner = parseLockOwner(claimedOwnerPath);
  if (!sameDirectoryIdentity(claimedIdentity, identity)
    || !sameLockIdentity(claimedOwner, expected)) {
    throw new Error(`aftercare stale-lock CAS identity changed; preserved quarantine: ${quarantine}`);
  }
  return quarantine;
}

export function retireOwnedLockDirectory(lockDir: string, expected: LockOwner, beforeRename: () => void = () => {}): string {
  const current = parseLockOwner(join(lockDir, "owner.json"));
  if (!sameLockIdentity(current, expected)) throw new Error("aftercare request lock nonce/process_start_identity changed");
  const identity = directoryIdentity(lockDir, "aftercare owned lock");
  beforeRename();
  const tombstone = `${lockDir}.retired-${randomUUID()}`;
  renameSync(lockDir, tombstone);
  const claimedIdentity = directoryIdentity(tombstone, "aftercare owned lock tombstone");
  const claimedOwner = parseLockOwner(join(tombstone, "owner.json"));
  if (!sameDirectoryIdentity(claimedIdentity, identity) || !sameLockIdentity(claimedOwner, expected)) {
    throw new Error(`aftercare request lock identity changed during release; preserved tombstone: ${tombstone}`);
  }
  return tombstone;
}

function acquireRequestLock(plan: LandAftercarePlan, now: Date, graceMs: number): { owner: LockOwner; release(): void } {
  const lockRoot = join(plan.project_root, "__garelier", plan.pm_id, "runtime", "land_aftercare", "locks");
  const lockDir = join(lockRoot, plan.request_id);
  ensureSafeDirectory(join(plan.project_root, "__garelier", plan.pm_id, "runtime"), lockRoot);
  const ownerPath = join(lockDir, "owner.json");
  const owner: LockOwner = {
    schema_version: 1,
    request_id: plan.request_id,
    pid: process.pid,
    process_start_identity: `${hostname()}:${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`,
    nonce: randomUUID(),
    host: hostname(),
    acquired_at: now.toISOString(),
  };
  const tryCreate = (): boolean => {
    const candidate = `${lockDir}.candidate-${randomUUID()}`;
    try {
      guardedMkdirSync(candidate, { mode: 0o700 });
      const descriptor = openSync(join(candidate, "owner.json"), "wx", 0o600);
      try { writeFileSync(descriptor, canonicalJson(owner), "utf8"); } finally { closeSync(descriptor); }
      renameSync(candidate, lockDir);
      return true;
    } catch {
      // Candidate publication failed. It is unguessable and never authoritative;
      // preserve it for attended/TTL GC instead of deleting through a pathname.
      return false;
    }
  };
  if (!tryCreate()) {
    let previous: LockOwner;
    try { previous = parseLockOwner(ownerPath); }
    catch { throw new Error(`aftercare request lock owner is unknown; refusing recovery: ${lockDir}`); }
    if (previous.host !== hostname()) throw new Error(`aftercare request lock is owned by another/unknown host: ${previous.host}`);
    let alive: boolean | null = null;
    try { process.kill(previous.pid, 0); alive = true; }
    catch (error) { alive = (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null; }
    if (alive !== false) throw new Error(`aftercare request lock owner is ${alive ? "live" : "unknown"}: pid=${previous.pid}`);
    const age = now.getTime() - Date.parse(previous.acquired_at);
    if (!Number.isFinite(age) || age < graceMs) throw new Error(`aftercare request lock is stale-looking but inside grace period: ${age}ms < ${graceMs}ms`);
    claimStaleLockDirectory(lockDir, previous);
    if (!tryCreate()) throw new Error(`aftercare request lock recovery lost a race: ${lockDir}`);
  }
  return {
    owner,
    release() {
      try {
        retireOwnedLockDirectory(lockDir, owner);
      } catch (error) { throw new Error(`aftercare request lock release failed: ${(error as Error).message}`); }
    },
  };
}

function assertFrozenPair(plan: LandAftercarePlan): void {
  const pair = readMergePair(plan.project_root, plan.pm_id, plan.request_id);
  if (sha256(pair.requestSource) !== plan.request_hash) throw new Error("merge request bytes changed after planning");
  if (sha256(pair.resultSource) !== plan.result_hash) throw new Error("merge result bytes changed after planning");
  const studioTip = gitText(plan.target_root, ["rev-parse", "--verify", `${plan.studio_branch}^{commit}`], "cannot resolve studio before aftercare step");
  // W-778: the tip is allowed to have MOVED — land -> PM Control commit ->
  // cleanup is the normal order, and every step below acts on request-bound
  // evidence, not on the branch head. What must still hold is that this merge is
  // part of the branch's history: a rewound, reset, or rewritten studio fails
  // here and nothing is retired. Pairing this with dropping the tip from
  // `planAuthorityPayload` keeps ONE answer for "may this aftercare proceed" —
  // an equality here would re-impose, one layer down, exactly the refusal the
  // authority payload no longer makes.
  if (!isAncestor(plan.target_root, plan.studio_commit, studioTip)) throw new Error("result studio commit is no longer reachable from current studio");
}

function assertLiveTargets(plan: LandAftercarePlan, checkDeclaredPreservation = false): void {
  assertFrozenPair(plan);
  if (checkDeclaredPreservation) assertDeclaredPreservationUnchanged(plan);
  const branchTip = gitText(plan.target_root, ["rev-parse", "--verify", `${plan.workbench_branch}^{commit}`], "workbench branch disappeared before authorized removal");
  if (branchTip !== plan.workbench_tip) throw new Error("workbench branch ref changed after planning");
  if (!isAncestor(plan.target_root, plan.workbench_tip, plan.studio_commit)) throw new Error("request tip/result ancestry changed");
  if (plan.checkout && plan.container) {
    // W-713: the apply path has to pass the collector too. Without it
    // `validateContainerInventory` takes its `!collectUnknown` branch and
    // throws the pre-fix `unknown top-level entry` here — BEFORE the preserve
    // step a few states later — so the row's whole outcome was unreachable and
    // production behaviour was identical to base. The authorised set is the
    // FROZEN one: an unrecognised file that appeared after planning is not
    // covered by the plan digest, so it refuses rather than being copied.
    const live: string[] = [];
    validateContainer(plan.container, plan.checkout, plan.force_remove === true, live);
    const frozen = [...plan.preserved_artifacts].sort().join("|");
    if (live.sort().join("|") !== frozen) {
      throw new Error(
        `unrecognised container artifacts changed after planning: plan froze [${plan.preserved_artifacts.join(", ") || "none"}],`
        + ` the container now holds [${live.join(", ") || "none"}]`,
      );
    }
    const ownershipFilesPresent = existsSync(join(plan.container, "context.json")) || existsSync(join(plan.container, "control_binding.json"));
    if (ownershipFilesPresent || plan.force_remove !== true) {
      validateContainerOwnership({
        container: plan.container,
        dispatchId: plan.dispatch_id!,
        branch: plan.workbench_branch,
        workId: plan.work_id,
        sessionId: plan.control_session_id,
      });
    }
    assertContainerSnapshot(plan);
    const registered = registeredWorktrees(plan.target_root).filter((entry) => entry.branch === plan.workbench_branch);
    if (registered.length !== 1 || !sameFilesystemPath(registered[0]!.path, plan.checkout) || registered[0]!.head !== plan.workbench_tip) {
      throw new Error("registered worktree binding changed after planning");
    }
    const dirty = checkoutDirtyStatus(plan.checkout, "cannot revalidate checkout cleanliness");
    if (dirty && plan.force_remove !== true) throw new Error(`checkout became dirty before destructive step: ${summarizeCheckoutDirtyStatus(dirty)}`);
  }
}

function archiveBodyForPlan(plan: LandAftercarePlan, container = plan.container): string | null {
  if (!container || !plan.dispatch_id) return null;
  return reportArchiveBody(plan, container, plan.dispatch_id, plan.workbench_branch.split("/").at(-1) ?? "dispatch", plan.workbench_branch);
}

function withPending(journal: AftercareJournal, step: AftercareState): AftercareJournal {
  if (journal.pending_step === step) return journal;
  if (journal.pending_step !== null) throw new Error(`journal has unresolved pending step ${journal.pending_step}`);
  return writeJournalCas({ ...journal, pending_step: step }, journal);
}

function advance(journal: AftercareJournal, state: AftercareState, envelope: AftercareResultEnvelope): AftercareJournal {
  return writeJournalCas({ ...journal, state, pending_step: null, envelope: { ...envelope, journal_state: state } }, journal);
}

function markOperation(envelope: AftercareResultEnvelope, surface: AftercareOperation["surface"], updates: Partial<AftercareOperation>): AftercareResultEnvelope {
  return { ...envelope, operations: envelope.operations.map((item) => item.surface === surface ? { ...item, ...updates } : item) };
}

function finalizeControl(plan: LandAftercarePlan): void {
  if (!plan.work_id || !plan.control_session_id) return;
  const pair = readMergePair(plan.project_root, plan.pm_id, plan.request_id);
  const roots = garelierControlRoots(plan.project_root, plan.target_root, plan.pm_id);
  if (hasMergeControlEvidence(roots, plan.work_id, plan.studio_commit, pair.resultPath)) return;
  const guard = acquireGarelierOperationGuard(roots, `land-aftercare-${plan.request_id}-${process.pid}`, "land-aftercare-control-finalize");
  try {
    const reportCandidates = [plan.role_report_path, plan.report_source, plan.report_archive]
      .filter((item): item is string => !!item);
    const reportPath = reportCandidates.find((item) => existsSync(item));
    if (!reportPath) throw new Error("successful aftercare control recovery has no surviving role completion report");
    recordMergeControlOutcome({
      roots,
      workId: plan.work_id,
      sessionId: plan.control_session_id,
      namespaceLock: guard.lock,
      requireLiveClaim: false,
      outcome: {
        status: "success",
        commit: plan.studio_commit,
        requestPath: pair.requestPath,
        resultPath: pair.resultPath,
        reportPath,
        reportPathCandidates: reportCandidates,
        guardianReportPath: typeof pair.request.guardian_report_path === "string" ? pair.request.guardian_report_path : undefined,
        observerReportPath: typeof pair.request.observer_report_path === "string" ? pair.request.observer_report_path : undefined,
        expectedSuccessfulCapture: {
          requestContentHash: plan.request_hash,
          resultContentHash: plan.result_hash,
          workbenchTip: plan.workbench_tip,
        },
      },
    });
  } finally { guard.release(); }
}

/** Pending inputs for the admitted copy of every artifact aftercare does not
 * recognise into the tracked control tree (W-713 AC-1).
 *
 * The retired behaviour REFUSED on the first unknown name, after `merge_land`
 * had already succeeded — so the container stayed active, its claim stayed
 * held, and an operator moved one file aside and re-ran, repeatedly (measured:
 * four sequential passes on a downstream project's dispatch #538). Refusing
 * also destroyed nothing and preserved nothing; it just stopped. Preserving is
 * not "automatic repair": the judgement about what aftercare recognises is
 * unchanged, and the announcement names every file, so nothing disappears
 * silently. Structural violations (symlink / reparse point, W-380) still refuse
 * upstream in `validateContainerInventory` — those are not evidence to keep. */
interface PendingPreservedEvidence {
  kind: PreservationSourceKind;
  sourcePath: string;
  displaySource: string;
  sourceAbsolute: string | null;
  /** Bytes scanned by Guardian admission before any tracked publication. */
  admissionBytes: Buffer;
  /** Bounded bytes published to the tracked control report. */
  bytes: Buffer;
  /** Optional post-admission renderer for structured runtime evidence. */
  renderAfterAdmission?: (admittedBytes: Buffer) => Buffer;
  runtimeRaw: { path: string; bytes: Buffer } | null;
  target: string;
  retireSource: boolean;
}

function verifyExistingEvidence(target: string, expected: Buffer, label: string): "missing" | "reused" {
  if (!existsSync(target)) return "missing";
  assertSafeLeaf(target, label);
  if (lstatSync(target).size !== expected.length) {
    throw new Error(`${label}: refused, destination already exists with different content: ${target}`);
  }
  const actual = readStableFile(target, label, expected.length);
  assertSafeLeaf(target, label);
  if (!actual.equals(expected)) {
    throw new Error(`${label}: refused, destination already exists with different content: ${target}`);
  }
  return "reused";
}

function publishExactEvidence(controlRoot: string, target: string, bytes: Buffer, label: string): "created" | "reused" {
  const existing = verifyExistingEvidence(target, bytes, label);
  if (existing === "reused") return existing;
  ensureSafeDirectory(controlRoot, dirname(target));
  // Exclusive creation is the publication point. A concurrent/new leaf is a
  // refusal, never a rename-overwrite of evidence that won the race.
  createGuardedFileSync(target, bytes, label);
  return "created";
}

/** The gate run records this dispatch owns at land time.
 *
 * `gate_runner` writes one JSON record per run under the PM runtime tree. The
 * raw record stays there for runtime retention; land publishes only the shared
 * bounded summary face. That keeps P-9/raw failure bytes available without
 * moving an unbounded record into the tracked control tree.
 *
 * The set is derived, not enumerated: every `lane/gate-*.log` in the frozen
 * snapshot names exactly one record through the same `gateRunRecordPath` the
 * runner used. A record that is already gone is not an error — a re-run may
 * already have published its bounded summary. */
function gateRunRecordsForPreservation(plan: LandAftercarePlan): Array<{
  log: { sourcePath: string; absolutePath: string };
  record: string;
}> {
  return gateLogsForPreservation(plan)
    .map((log) => ({ log, record: gateRunRecordPath(plan.project_root, plan.pm_id, log.absolutePath) }));
}

/** Frozen raw gate logs that must outlive physical container GC (W-810). */
type GatePreservationPlan = Pick<LandAftercarePlan,
  "project_root" | "pm_id" | "dispatch_id" | "checkout" | "container" | "container_snapshot" | "workbench_tip">;

function allGateLogsForPreservation(plan: GatePreservationPlan): Array<{
  sourcePath: string;
  absolutePath: string;
}> {
  if (!plan.container) return [];
  return (plan.container_snapshot?.entries ?? [])
    .filter((entry) => entry.kind === "file" && /^lane\/gate(?:-step4)?-[0-9a-f]{12}\.log$/.test(entry.path))
    .map((entry) => ({
      sourcePath: entry.path,
      absolutePath: join(plan.container!, ...entry.path.split("/")),
    }));
}

function gatePreservationScope(plan: GatePreservationPlan): {
  selected: Array<{ sourcePath: string; absolutePath: string }>;
  skips: string[];
} {
  const selected: Array<{ sourcePath: string; absolutePath: string }> = [];
  const skips: string[] = [];
  const candidateNames = new Set([
    `gate-${plan.workbench_tip.slice(0, 12)}.log`,
    pmStepGateLogName(plan.workbench_tip),
  ]);
  let engineBoundName: string | null = null;
  let boundReview: ReturnType<typeof readDockReviewHandoffRecord> = null;
  if (plan.dispatch_id && plan.checkout) {
    boundReview = readDockReviewHandoffRecord(dockReviewRecordPath(
      plan.project_root, plan.pm_id, plan.dispatch_id,
    ));
    if (boundReview?.review_sha === plan.workbench_tip
      && boundReview.gate_start_head === boundReview.gate_end_head
      && /^[0-9a-f]{40}$/.test(boundReview.gate_start_head)
      && boundReview.engine_tree_hash === boundReview.gate_engine_tree_hash) {
      let currentEngineHash: string | null = null;
      try {
        currentEngineHash = engineTreeHash(plan.checkout, plan.workbench_tip, (cwd, argv) => {
          const result = git(cwd, argv);
          return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        skips.push(`engine binding unavailable: engine tree probe: ${reason}`);
      }
      const gateName = reviewGateLogName(boundReview.gate_start_head);
      const gatePath = join(plan.container!, "lane", gateName);
      if (currentEngineHash === boundReview.engine_tree_hash) {
        let currentGateDigest: string | null = null;
        try {
          currentGateDigest = digestReviewEvidence(gatePath);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          skips.push(`engine binding unavailable: evidence probe: ${reason}`);
        }
        if (currentGateDigest !== null
          && boundReview.evidence_digests[reviewEvidenceKey(gatePath)] === currentGateDigest) {
          engineBoundName = gateName;
        }
      }
    }
  }
  for (const log of allGateLogsForPreservation(plan)) {
    const name = basename(log.absolutePath);
    if (!candidateNames.has(name) && name !== engineBoundName) {
      skips.push(`${log.sourcePath}: old_round_review_sha_mismatch`);
      continue;
    }
    const record = readGateRunRecord(gateRunRecordPath(plan.project_root, plan.pm_id, log.absolutePath));
    if (!record?.preservation) {
      skips.push(`${log.sourcePath}: legacy_or_missing_gate_run_record`);
      continue;
    }
    const exactShaBinding = candidateNames.has(name)
      && record.start_head === plan.workbench_tip
      && record.end_head === plan.workbench_tip;
    const engineTreeBinding = name === engineBoundName && plan.dispatch_id !== null
      && boundReview !== null
      && record.run_id === boundReview.gate_run_id
      && record.start_head === boundReview.gate_start_head
      && record.end_head === boundReview.gate_end_head;
    if (!exactShaBinding && !engineTreeBinding) {
      skips.push(`${log.sourcePath}: gate_run_review_sha_mismatch`);
      continue;
    }
    selected.push(log);
  }
  return { selected, skips };
}

/** Only the landed candidate's SHA-bound run may enter tracked preservation. */
function gateLogsForPreservation(plan: GatePreservationPlan): Array<{
  sourcePath: string;
  absolutePath: string;
}> {
  return gatePreservationScope(plan).selected;
}

function captureDeclaredPreservationSnapshot(input: {
  projectRoot: string;
  pmId: string;
  dispatchId: string | null;
  workId: string | null;
  reviewSha: string;
  declaredPaths: readonly string[];
  retentionLimitBytes: number;
  runtimeArchiveKeepDays: number;
  runtimeArchiveKeepFiles: number;
}): DeclaredPreservationSnapshot {
  const replacements: Record<string, string> = {
    pm_id: input.pmId,
    dispatch_id: input.dispatchId ?? "",
    work_id: input.workId ?? "unassigned",
    review_sha: input.reviewSha,
  };
  const sources = input.declaredPaths.map((declaredPath): DeclaredPreservedEvidenceSnapshot => {
    let sourcePath = declaredPath.replace(/\{(pm_id|dispatch_id|work_id|review_sha)\}/g, (_whole, key: string) => replacements[key]!);
    sourcePath = sourcePath.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!sourcePath || isAbsolute(sourcePath) || sourcePath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`quality_gate.preserved_paths entry is not a safe project-relative path: ${declaredPath}`);
    }
    const sourceAbsolute = resolve(input.projectRoot, ...sourcePath.split("/"));
    const within = relative(resolve(input.projectRoot), sourceAbsolute);
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
      throw new Error(`quality_gate.preserved_paths entry escapes the project: ${declaredPath}`);
    }
    assertNoSymlinkPath(input.projectRoot, sourceAbsolute);
    const info = lstatSync(sourceAbsolute);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`quality_gate.preserved_paths entry is not a real regular file: ${sourcePath}`);
    }
    const bytes = readStableFile(sourceAbsolute, "declared preserved evidence", info.size);
    return {
      declared_path: declaredPath,
      source_path: sourcePath,
      content_hash: sha256(bytes),
      byte_length: bytes.byteLength,
      content_base64: bytes.toString("base64"),
    };
  });
  return {
    retention_limit_bytes: input.retentionLimitBytes,
    runtime_archive_keep_days: input.runtimeArchiveKeepDays,
    runtime_archive_keep_files: input.runtimeArchiveKeepFiles,
    sources,
  };
}

function liveDeclaredPreservationSnapshot(plan: LandAftercarePlan): DeclaredPreservationSnapshot {
  const config = loadConfig(plan.project_root, plan.pm_id);
  return captureDeclaredPreservationSnapshot({
    projectRoot: plan.project_root,
    pmId: plan.pm_id,
    dispatchId: plan.dispatch_id,
    workId: plan.work_id,
    reviewSha: plan.workbench_tip,
    declaredPaths: config.qualityGate.preservedPaths,
    retentionLimitBytes: config.retention.preservedArtifactMaxBytes,
    runtimeArchiveKeepDays: config.retention.runtimeArchiveKeepDays,
    runtimeArchiveKeepFiles: config.retention.runtimeArchiveKeepFiles,
  });
}

function assertDeclaredPreservationUnchanged(plan: LandAftercarePlan): void {
  if (plan.declared_preservation === null) return;
  if (canonicalJson(liveDeclaredPreservationSnapshot(plan)) !== canonicalJson(plan.declared_preservation)) {
    throw new Error("declared quality-gate preservation changed after planning");
  }
}

function declaredPreservationSources(plan: LandAftercarePlan): Array<{
  sourcePath: string;
  sourceAbsolute: string;
  bytes: Buffer;
}> {
  if (plan.declared_preservation === null) return [];
  return plan.declared_preservation.sources.map((source) => {
    const sourcePath = source.source_path;
    const sourceAbsolute = resolve(plan.project_root, ...sourcePath.split("/"));
    const bytes = Buffer.from(source.content_base64, "base64");
    if (bytes.toString("base64") !== source.content_base64
      || bytes.byteLength !== source.byte_length
      || sha256(bytes) !== source.content_hash) {
      throw new Error(`frozen declared preserved evidence is malformed: ${sourcePath}`);
    }
    return { sourcePath, sourceAbsolute, bytes };
  });
}

function boundedPreservedEvidence(
  plan: LandAftercarePlan,
  kind: PreservationSourceKind,
  sourcePath: string,
  bytes: Buffer,
  maxBytes: number,
): { bytes: Buffer; runtimeRaw: { path: string; bytes: Buffer } | null } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_PRESERVED_ARTIFACT_MAX_BYTES) {
    throw new Error(
      `preserved_artifact_bound_too_small: preserved artifact limit must be at least ` +
      `${MIN_PRESERVED_ARTIFACT_MAX_BYTES} bytes (got ${maxBytes})`,
    );
  }
  const runtimeRoot = join(plan.project_root, "__garelier", plan.pm_id, "runtime");
  const rawPath = join(runtimeRoot, "gate", "preserved_raw", `dispatch${plan.dispatch_id ?? "unknown"}`,
    `${sha256(`${kind}\0${sourcePath}`).replace(/^sha256:/, "").slice(0, 16)}.raw`);
  if (sourcePath.endsWith(".log")) {
    return {
      bytes: Buffer.from(summarizePmStepGateLog(
        bytes,
        relative(plan.project_root, rawPath).replaceAll("\\", "/"),
        `PRESERVED_LOG source=${sourcePath} kind=${kind}`,
        maxBytes,
      ), "utf8"),
      runtimeRaw: { path: rawPath, bytes },
    };
  }
  if (bytes.byteLength <= maxBytes) return { bytes, runtimeRaw: null };
  const detail = [
    "PRESERVED_ARTIFACT_SUMMARY",
    `KIND ${kind}`,
    `SOURCE ${sourcePath}`,
    `SHA256 ${sha256(bytes).replace(/^sha256:/, "")}`,
    `BYTE_LENGTH ${bytes.byteLength}`,
  ];
  const mandatory = [
    `PRESERVED_SUMMARY_TRUNCATED max_bytes=${maxBytes}`,
    `RAW_RUNTIME_PATH ${relative(plan.project_root, rawPath).replaceAll("\\", "/")}`,
    "",
  ];
  if (Buffer.byteLength(mandatory.join("\n"), "utf8") > maxBytes) {
    throw new Error(`preserved_artifact_bound_too_small: mandatory summary face exceeds ${maxBytes} bytes`);
  }
  const kept: string[] = [];
  for (const line of detail) {
    const candidate = [...kept, line, ...mandatory].join("\n");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) kept.push(line);
  }
  const encoded = Buffer.from([...kept, ...mandatory].join("\n"), "utf8");
  return {
    bytes: encoded,
    runtimeRaw: { path: rawPath, bytes },
  };
}

/** Security-admit the complete source set before publishing any one member.
 *
 * The SHA-bound merge scans cannot see unrecognised container/runtime bytes.
 * This is their separately recorded boundary: invalid/binary text, every
 * Guardian registry match, customer-data markers, and provenance-rights risks
 * make the whole batch REJECTED. Rejection writes only a redacted runtime
 * admission and leaves every source in place. CLEAN batches publish an exact
 * tracked admission plus injectively named evidence; existing bytes are reused
 * only after content verification and different bytes are never overwritten. */
function preserveAftercareEvidence(plan: LandAftercarePlan): void {
  if (!plan.preserve_root || !plan.container) return;
  if (plan.declared_preservation === null) throw new Error("dispatch preservation plan has no frozen declaration");
  const preservedLimit = plan.declared_preservation.retention_limit_bytes;
  const runtimeRoot = join(plan.project_root, "__garelier", plan.pm_id, "runtime");
  const runtimeGateLogs = gateLogsForPreservation(plan).map((log) => ({
    ...log,
    bytes: readFrozenContainerFile(plan, plan.container!, log.sourcePath),
    target: join(runtimeRoot, "gate", "preserved_raw", `dispatch${plan.dispatch_id ?? "unknown"}`, basename(log.absolutePath)),
  }));
  const pending: PendingPreservedEvidence[] = plan.preserved_artifacts.map((item) => {
    const kind: PreservationSourceKind = "container_artifact";
    const admissionBytes = readFrozenContainerFile(plan, plan.container!, item);
    const bounded = boundedPreservedEvidence(plan, kind, item, admissionBytes, preservedLimit);
    return {
      kind,
      sourcePath: item,
      displaySource: item,
      sourceAbsolute: join(plan.container!, ...item.split("/")),
      admissionBytes,
      bytes: bounded.bytes,
      runtimeRaw: bounded.runtimeRaw,
      target: join(plan.preserve_root!, ...preservedEvidenceRelativePath(kind, item).split("/")),
      retireSource: false,
    };
  });

  for (const evidence of gateRunRecordsForPreservation(plan)) {
    const { log, record } = evidence;
    const kind: PreservationSourceKind = "gate_run_record";
    const sourcePath = basename(record);
    const target = isPmStepGateLog(basename(log.absolutePath))
      ? join(plan.preserve_root, basename(log.absolutePath))
      : join(plan.preserve_root, ...preservedEvidenceRelativePath(kind, sourcePath).split("/"));
    if (existsSync(record)) {
      const info = lstatSync(record);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`aftercare preserved gate run record must be a real regular file: ${record}`);
      }
      const bytes = readStableFile(record, "aftercare gate run record", MAX_AUTHORITY_JSON_BYTES);
      pending.push({
        kind, sourcePath, displaySource: record, sourceAbsolute: record,
        admissionBytes: bytes,
        // Guardian admission owns the first judgement over raw evidence. Only
        // admitted bytes are then interpreted as the runner's structured
        // record and reduced through the one configured tracked-artifact bound.
        bytes,
        renderAfterAdmission: (admittedBytes) => {
          const parsed = parseGateRunRecord(admittedBytes);
          if (!parsed?.preservation) {
            throw new Error(`aftercare gate run record has no runner-owned preservation summary: ${record}`);
          }
          const structuredSummary = summarizeGateRunForPreservation(
            parsed.preservation,
            relative(plan.project_root, record).replaceAll("\\", "/"),
            preservedLimit,
          );
          if (isPmStepGateLog(basename(log.absolutePath))) {
            const raw = runtimeGateLogs.find((candidate) => candidate.sourcePath === log.sourcePath);
            if (!raw) throw new Error(`aftercare PM-step raw log is missing from preservation scope: ${log.sourcePath}`);
            return Buffer.from(summarizePmStepGateLog(
              raw.bytes,
              relative(plan.project_root, raw.target).replaceAll("\\", "/"),
              structuredSummary,
              preservedLimit,
            ), "utf8");
          }
          return Buffer.from(structuredSummary, "utf8");
        },
        runtimeRaw: null,
        target, retireSource: false,
      });
    } else if (existsSync(target)) {
      // Crash-resume cut: publication completed and the runtime source retired,
      // but the archived journal advance did not. Re-admit the exact tracked
      // bytes so the batch record/destination checks remain identical.
      assertSafeLeaf(target, "aftercare preserved gate run record");
      const bytes = readStableFile(target, "aftercare preserved gate run record", MAX_AUTHORITY_JSON_BYTES);
      pending.push({
        kind, sourcePath, displaySource: record, sourceAbsolute: null,
        admissionBytes: bytes,
        bytes,
        runtimeRaw: null,
        target, retireSource: false,
      });
    }
  }
  for (const declared of declaredPreservationSources(plan)) {
    const kind: PreservationSourceKind = "declared_quality_gate_evidence";
    const bounded = boundedPreservedEvidence(plan, kind, declared.sourcePath, declared.bytes, preservedLimit);
    pending.push({
      kind,
      sourcePath: declared.sourcePath,
      displaySource: declared.sourceAbsolute,
      sourceAbsolute: declared.sourceAbsolute,
      admissionBytes: declared.bytes,
      bytes: bounded.bytes,
      runtimeRaw: bounded.runtimeRaw,
      target: join(plan.preserve_root, ...preservedEvidenceRelativePath(kind, declared.sourcePath).split("/")),
      retireSource: false,
    });
  }
  if (pending.length === 0 && runtimeGateLogs.length === 0) return;

  const targetKeys = new Set<string>();
  for (const item of pending) {
    const key = item.target.replaceAll("\\", "/").toLowerCase();
    if (targetKeys.has(key)) throw new Error(`preserved evidence destination collision: ${item.target}`);
    targetKeys.add(key);
  }

  const admission = evaluatePreservationAdmission({
    projectRoot: plan.project_root,
    pmId: plan.pm_id,
    binding: {
      requestId: plan.request_id,
      planDigest: plan.plan_digest,
      workId: plan.work_id,
      dispatchId: plan.dispatch_id,
    },
    sources: [
      ...pending.map((item) => ({ kind: item.kind, sourcePath: item.sourcePath, bytes: item.admissionBytes })),
      ...runtimeGateLogs.map((item) => ({
        kind: "container_artifact" as const, sourcePath: item.sourcePath, bytes: item.bytes,
      })),
    ],
  });
  const admissionBody = preservationAdmissionBytes(admission);
  const admissionId = admission.record_hash.replace(/^sha256:/, "");
  const runtimeAdmission = join(runtimeRoot, "land_aftercare", "preservation_admissions", `${plan.request_id}-${admissionId}.json`);
  if (existsSync(runtimeAdmission)) {
    if (readStableText(runtimeAdmission, "preservation security admission", MAX_AUTHORITY_JSON_BYTES) !== admissionBody) {
      throw new Error(`preservation security admission hash collision: ${runtimeAdmission}`);
    }
  } else {
    atomicWriteRuntimeFile(runtimeRoot, runtimeAdmission, admissionBody);
  }
  process.stdout.write(`land_aftercare: ADMISSION ${admission.status} artifacts=${pending.length + runtimeGateLogs.length} record=${runtimeAdmission.replaceAll("\\", "/")}\n`);
  if (admission.status !== "CLEAN") {
    const pointers = admission.artifacts
      .flatMap((artifact) => artifact.findings.map((finding) => finding.redacted_pointer))
      .join(", ");
    throw new Error(`preservation security admission rejected; source artifacts retained: ${pointers}`);
  }

  for (const item of pending) {
    if (item.renderAfterAdmission) item.bytes = item.renderAfterAdmission(item.admissionBytes);
  }

  // Ordinary lane/gate-<sha>.log bytes are runtime evidence, not tracked
  // summaries. Preserve the exact frozen bytes after admission and before the
  // container can be retired; crash replays verify rather than overwrite.
  for (const log of runtimeGateLogs) {
    if (existsSync(log.target)) {
      verifyExistingEvidence(log.target, log.bytes, "runtime raw gate log");
    } else {
      const text = log.bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(log.bytes)) {
        throw new Error(`runtime raw gate log is not canonical UTF-8: ${log.sourcePath}`);
      }
      atomicWriteRuntimeFile(runtimeRoot, log.target, text);
    }
    process.stdout.write(`land_aftercare: PRESERVED ${log.sourcePath} -> ${log.target.replaceAll("\\", "/")}\n`);
  }

  // Raw oversized evidence remains runtime-only and is written only after the
  // complete original bytes pass Guardian admission. The tracked face below is
  // always the bounded summary that points back here.
  for (const item of pending) {
    if (!item.runtimeRaw) continue;
    const rawText = item.runtimeRaw.bytes.toString("utf8");
    if (!Buffer.from(rawText, "utf8").equals(item.runtimeRaw.bytes)) {
      throw new Error(`preserved runtime raw artifact is not canonical UTF-8: ${item.sourcePath}`);
    }
    if (existsSync(item.runtimeRaw.path)) {
      verifyExistingEvidence(item.runtimeRaw.path, item.runtimeRaw.bytes, "runtime raw preserved evidence");
    } else {
      atomicWriteRuntimeFile(runtimeRoot, item.runtimeRaw.path, rawText);
    }
  }

  const controlRoot = join(plan.project_root, "__garelier", plan.pm_id, "control");
  const trackedAdmission = join(plan.preserve_root, "security_admission.json");
  const publications = [
    ...pending.map((item) => ({ target: item.target, bytes: item.bytes, label: "aftercare preserved evidence" })),
    { target: trackedAdmission, bytes: Buffer.from(admissionBody, "utf8"), label: "aftercare preservation admission" },
  ];
  // Verify the whole existing destination set first. If any leaf disagrees,
  // publish nothing new and retain all sources.
  for (const publication of publications) verifyExistingEvidence(publication.target, publication.bytes, publication.label);
  for (const publication of publications) publishExactEvidence(controlRoot, publication.target, publication.bytes, publication.label);
  // W-843: these leaves land in tracked Control after merge_land has already
  // authorized its settlement write set, so the settlement can only accept
  // them from this generator's own return: the exact path + digest it
  // published. Recorded after publication and before the journal advances, so
  // a crash replay re-verifies the same leaves and records the same set.
  recordAftercarePreservationPublication({
    roots: garelierControlRoots(plan.project_root, plan.target_root, plan.pm_id),
    requestId: plan.request_id,
    workId: plan.work_id,
    sessionId: plan.control_session_id,
    dispatchId: plan.dispatch_id,
    writes: publications.map((publication) => ({
      path: relative(controlRoot, publication.target).replaceAll("\\", "/"),
      digest: sha256(publication.bytes),
    })),
  });

  // Runtime sources retire only after every tracked byte and the admission
  // record are durable. Unknown container artifacts remain copies until the
  // journal reaches the ordinary whole-container retirement step.
  for (const item of pending.filter((candidate) => candidate.retireSource)) {
    const current = readStableFile(item.sourceAbsolute!, "aftercare gate run record before retirement", MAX_AUTHORITY_JSON_BYTES);
    if (!current.equals(item.admissionBytes)) throw new Error(`gate run record changed after admission; source retained: ${item.sourceAbsolute}`);
  }
  for (const item of pending.filter((candidate) => candidate.retireSource)) unlinkSync(item.sourceAbsolute!);
  for (const item of pending) {
    process.stdout.write(`land_aftercare: PRESERVED ${item.displaySource.replaceAll("\\", "/")} -> ${item.target.replaceAll("\\", "/")}\n`);
  }
  try {
    pruneGateRuntimeEvidence({
      project: plan.project_root,
      pmId: plan.pm_id,
      keepDays: plan.declared_preservation.runtime_archive_keep_days,
      keepFiles: plan.declared_preservation.runtime_archive_keep_files,
    });
  } catch { /* retention never invalidates the durable publication that triggered it */ }
}

function writeArchive(plan: LandAftercarePlan, body: string | null): { contentHash: string | null; jsonContentHash: string | null } {
  if (!plan.report_archive) return { contentHash: null, jsonContentHash: null };
  if (body === null) throw new Error("authenticated dispatch report body is missing");
  const runtimeRoot = join(plan.project_root, "__garelier", plan.pm_id, "runtime");
  atomicWriteRuntimeFile(runtimeRoot, plan.report_archive, body);
  let jsonContentHash: string | null = null;
  if (plan.report_json_source && plan.report_json_archive) {
    const source = readFrozenContainerFile(plan, plan.container!, "report.json").toString("utf8");
    atomicWriteRuntimeFile(runtimeRoot, plan.report_json_archive, source);
    jsonContentHash = sha256(source);
  }
  return { contentHash: sha256(body), jsonContentHash };
}

function removeWorktree(plan: LandAftercarePlan): void {
  if (!plan.checkout) return;
  // W-380: git's recursive worktree removal follows a Windows junction out of
  // the tree and deletes what it points at. Detach every link first so git is
  // handed a tree with none; a link that cannot be detached refuses the removal
  // rather than letting git walk it.
  const detachment = detachReparsePoints(plan.checkout);
  if (detachment.failed.length > 0) {
    throw new Error(
      `git worktree remove refused: ${detachment.failed.length} reparse point(s) could not be detached first, and a recursive delete can follow a link out of the checkout: ` +
      detachment.failed.map((entry) => `${entry.path} (${entry.reason})`).join("; "),
    );
  }
  const result = git(plan.target_root, ["worktree", "remove", ...(plan.force_remove ? ["--force"] : []), plan.checkout]);
  if (result.code !== 0) throw new Error(`git worktree remove refused: ${result.stderr.trim() || result.stdout.trim()}`);
  if (existsSync(plan.checkout)) throw new Error(`git reported success but worktree path remains: ${plan.checkout}`);
}

export function deleteExactBranchRef(targetRoot: string, ref: string, expectedTip: string): void {
  const valid = git(targetRoot, ["check-ref-format", ref]);
  if (valid.code !== 0) throw new Error(`workbench branch is not a valid local ref: ${ref}`);
  const symbolicTarget = symbolicRefTarget(targetRoot, ref);
  if (symbolicTarget !== null) throw new Error(`workbench ref became symbolic before deletion: ${ref} -> ${symbolicTarget}`);
  const result = git(targetRoot, ["update-ref", "--no-deref", "-d", ref, expectedTip]);
  if (result.code !== 0) throw new Error(`git update-ref CAS deletion refused: ${result.stderr.trim() || result.stdout.trim()}`);
  if (symbolicRefTarget(targetRoot, ref) !== null || refExists(targetRoot, ref)) {
    throw new Error(`git reported success but branch ref remains: ${ref}`);
  }
}

function removeBranch(plan: LandAftercarePlan): void {
  const tip = gitText(plan.target_root, ["rev-parse", "--verify", `${plan.workbench_branch}^{commit}`], "cannot revalidate branch before deletion");
  if (tip !== plan.workbench_tip) throw new Error("branch ref changed before deletion");
  if (!isAncestor(plan.target_root, plan.workbench_tip, plan.studio_commit)) throw new Error("branch is no longer proven landed");
  if (registeredWorktrees(plan.target_root).some((entry) => entry.branch === plan.workbench_branch)) throw new Error("branch is still checked out");
  const ref = `refs/heads/${plan.workbench_branch}`;
  // `git branch -d` judges mergedness against the caller checkout's HEAD. The
  // proven ancestry above authorizes deletion; --no-deref + expected OID make
  // the named ref itself the CAS target and preserve any raced referent.
  deleteExactBranchRef(plan.target_root, ref, plan.workbench_tip);
}

function validateContainerAfterCheckout(
  plan: LandAftercarePlan,
  envelope: AftercareResultEnvelope,
  container: string,
  requireOriginalPath: boolean,
): void {
  assertNoSymlinkPath(dirname(container), container);
  // W-713: the same collector, for the same reason as `assertLiveTargets` —
  // without it this walk throws the pre-fix refusal at container retirement,
  // after the preserve step has already copied the files.
  const live: string[] = [];
  validateContainerInventory(
    container,
    false,
    4096,
    plan.force_remove === true,
    live,
    laneArtifactsWrittenByRun(plan.lane_artifacts),
  );
  const frozen = [...plan.preserved_artifacts].sort().join("|");
  if (live.sort().join("|") !== frozen) {
    throw new Error(
      `unrecognised container artifacts changed after planning: plan froze [${plan.preserved_artifacts.join(", ") || "none"}],`
      + ` the container now holds [${live.join(", ") || "none"}]`,
    );
  }
  const ownershipFilesPresent = existsSync(join(container, "context.json")) || existsSync(join(container, "control_binding.json"));
  if (ownershipFilesPresent || plan.force_remove !== true) {
    validateContainerOwnership({
      container,
      dispatchId: plan.dispatch_id!,
      branch: plan.workbench_branch,
      workId: plan.work_id,
      sessionId: plan.control_session_id,
    });
  }
  assertContainerSnapshot(plan, container, requireOriginalPath);
  const archiveBody = archiveBodyForPlan(plan, container);
  const sourceHash = archiveBody === null ? null : sha256(archiveBody);
  if (sourceHash !== envelope.report_archive.content_hash) {
    throw new Error("dispatch coordination bytes no longer match the archived report content");
  }
  if (sourceHash !== null && (!plan.report_archive || !existsSync(plan.report_archive)
    || sha256(readStableFile(plan.report_archive, "dispatch report archive", MAX_REPORT_ARCHIVE_BYTES)) !== sourceHash)) {
    throw new Error("dispatch report archive is missing or changed before container retirement");
  }
  const jsonSourceHash = plan.report_json_source ? sha256(readFrozenContainerFile(plan, container, "report.json")) : null;
  if (jsonSourceHash !== envelope.report_archive.json_content_hash) {
    throw new Error("dispatch structured report bytes no longer match the archived sidecar");
  }
  if (jsonSourceHash !== null && (!plan.report_json_archive || !existsSync(plan.report_json_archive)
    || sha256(readStableFile(plan.report_json_archive, "structured report archive", MAX_REPORT_FILE_BYTES)) !== jsonSourceHash)) {
    throw new Error("dispatch structured report archive is missing or changed before container retirement");
  }
}

function refreshViews(plan: LandAftercarePlan, envelope: AftercareResultEnvelope): AftercareResultEnvelope {
  const runtimeRoot = join(plan.project_root, "__garelier", plan.pm_id, "runtime");
  // The canonical key is a protocol value (`aftercare-v1:<digest>`), not a
  // filesystem name: ':' is illegal on Windows. Hashing the complete framed key
  // preserves a deterministic one-to-one register name on every platform.
  const registerName = sha256(envelope.idempotency_key).replace(/^sha256:/, "");
  const registerPath = join(runtimeRoot, "land_aftercare", "register", `${registerName}.json`);
  const taskMirror = join(dirname(import.meta.dir), "dispatch", "task_mirror.ts");
  const eventScript = join(dirname(import.meta.dir), "scripts", "dispatch_event.ts");
  let next = envelope;
  atomicWriteRuntimeFile(runtimeRoot, registerPath, canonicalJson({
    schema_version: 1,
    kind: "land_aftercare_register",
    idempotency_key: envelope.idempotency_key,
    request_id: envelope.request_id,
    work_id: envelope.work_id,
    studio_commit: envelope.studio_commit,
    journal: plan.journal_path,
  }));
  next = markOperation(next, "local_register", { local_ack: "applied" });
  const event = spawnSync(process.execPath, [eventScript, "--project", plan.project_root, "--pm-id", plan.pm_id, "--regen-only"], {
    windowsHide: true, cwd: plan.project_root, encoding: "utf8", timeout: 60_000,
  });
  if ((event.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new Error("derived manifest refresh timed out after 60000ms");
  if (event.error) throw new Error(`derived manifest refresh spawn failed: ${event.error.message}`);
  if (event.signal) throw new Error(`derived manifest refresh terminated by signal ${event.signal}`);
  if (event.status === null) throw new Error("derived manifest refresh exited without a status");
  if (event.status !== 0) throw new Error(`derived manifest refresh failed: ${event.stderr?.toString().trim()}`);
  next = markOperation(next, "derived_manifest", { local_ack: "applied" });
  const mirror = spawnSync(process.execPath, [taskMirror, "--project", plan.project_root, "--target-root", plan.target_root, "--pm-id", plan.pm_id, "--include-dispatches", "--format", "ops"], {
    windowsHide: true, cwd: plan.project_root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
  });
  if ((mirror.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new Error("task mirror operation generation timed out after 60000ms");
  if (mirror.error) throw new Error(`task mirror operation generation spawn failed: ${mirror.error.message}`);
  if (mirror.signal) throw new Error(`task mirror operation generation terminated by signal ${mirror.signal}`);
  if (mirror.status === null) throw new Error("task mirror operation generation exited without a status");
  if (mirror.status !== 0) throw new Error(`task mirror operation generation failed: ${mirror.stderr?.toString().trim()}`);
  const mirrorPayload = parseJson(mirror.stdout?.toString() ?? "", "task_mirror stdout");
  next = {
    ...next,
    operations: next.operations.map((item) => item.surface === "task_mirror"
      ? { ...item, payload: mirrorPayload, payload_hash: sha256(canonicalJson(mirrorPayload)), local_ack: "applied" }
      : item),
    local_cleanup_complete: true,
    external_sync_pending: true,
  };
  return next;
}

function createJournal(plan: LandAftercarePlan): AftercareJournal {
  const journal: AftercareJournal = {
    schema_version: 1,
    kind: "garelier_land_aftercare_journal",
    request_id: plan.request_id,
    revision: 0,
    genesis_plan_digest: plan.plan_digest,
    previous_revision_hash: null,
    record_hash: "sha256:" + "0".repeat(64),
    state: "prepared",
    pending_step: null,
    retirement_claim: null,
    provider_receipt: null,
    plan,
    envelope: initialEnvelope(plan),
    updated_at: new Date().toISOString(),
  };
  return writeJournalCas(journal, null);
}

function validateJournalAgainstPlan(journal: AftercareJournal, canonicalPlan: LandAftercarePlan): void {
  if (journal.request_id !== canonicalPlan.request_id || journal.plan.request_id !== canonicalPlan.request_id) {
    throw new Error("aftercare journal request identity does not match canonical merge evidence");
  }
  const selfDigest = sha256(planPayload(journal.plan));
  if (journal.plan.plan_digest !== selfDigest) throw new Error("aftercare journal plan digest does not match its canonical payload");
  if (sha256(planAuthorityPayload(journal.plan)) !== sha256(planAuthorityPayload(canonicalPlan))) {
    throw new Error("aftercare journal authority does not match canonically re-derived merge evidence");
  }
  const stateIndex = AFTERCARE_STATES.indexOf(journal.state);
  const expectedPending = AFTERCARE_STATES[stateIndex + 1] ?? null;
  if (journal.pending_step !== null && journal.pending_step !== expectedPending) {
    throw new Error(`aftercare journal pending step ${journal.pending_step} is not the successor of ${journal.state}`);
  }
  if (journal.retirement_claim !== null) throw new Error("automatic aftercare cannot own a physical container retirement claim");

  const expected = initialEnvelope(journal.plan);
  const envelope = journal.envelope;
  const containerRetired = stateIndex >= AFTERCARE_STATES.indexOf("container_retired");
  const containerRemoved = stateIndex >= AFTERCARE_STATES.indexOf("container_removed");
  const expectedTombstone = null;
  if (envelope.schema_version !== 1 || envelope.kind !== "garelier_land_aftercare_result"
    || envelope.idempotency_key !== expected.idempotency_key
    || envelope.request_id !== canonicalPlan.request_id
    || envelope.work_id !== canonicalPlan.work_id
    || envelope.studio_commit !== canonicalPlan.studio_commit
    || envelope.dispatch.id !== canonicalPlan.dispatch_id
    || envelope.dispatch.container !== canonicalPlan.container
    || envelope.report_archive.path !== canonicalPlan.report_archive
    || envelope.report_archive.json_path !== canonicalPlan.report_json_archive
    || canonicalJson(envelope.retirement_tombstone) !== canonicalJson(expectedTombstone)
    || envelope.physical_gc_pending !== (containerRetired && !containerRemoved && canonicalPlan.container !== null)
    || envelope.journal_state !== journal.state
    || envelope.operations.length !== expected.operations.length) {
    throw new Error("aftercare journal envelope identity/state does not match canonical plan");
  }
  const expectedBySurface = new Map(expected.operations.map((item) => [item.surface, item]));
  const seen = new Set<string>();
  for (const operation of envelope.operations) {
    const expectedOperation = expectedBySurface.get(operation.surface);
    if (!expectedOperation || seen.has(operation.surface)) throw new Error(`aftercare journal has invalid/duplicate operation surface: ${operation.surface}`);
    seen.add(operation.surface);
    if (operation.payload_hash !== sha256(canonicalJson(operation.payload))) {
      throw new Error(`aftercare journal ${operation.surface} payload hash mismatch`);
    }
    if (operation.surface !== "task_mirror" || stateIndex < AFTERCARE_STATES.indexOf("views_refreshed")) {
      if (canonicalJson(operation.payload) !== canonicalJson(expectedOperation.payload)) {
        throw new Error(`aftercare journal ${operation.surface} payload does not match canonical plan`);
      }
    }
    if (!(["pending", "applied"] as const).includes(operation.local_ack)) throw new Error(`aftercare journal ${operation.surface} local ack is invalid`);
    if (!(["not_applicable", "pending", "applied"] as const).includes(operation.provider_ack)) throw new Error(`aftercare journal ${operation.surface} provider ack is invalid`);
    if (operation.surface !== "task_mirror" && operation.provider_ack !== "not_applicable") {
      throw new Error(`aftercare journal ${operation.surface} provider ack is not applicable`);
    }
  }
  const operationBySurface = new Map(envelope.operations.map((item) => [item.surface, item]));
  const archived = stateIndex >= AFTERCARE_STATES.indexOf("archived");
  const terminal = stateIndex >= AFTERCARE_STATES.indexOf("views_refreshed");
  if (archived && canonicalPlan.report_archive && (typeof envelope.report_archive.content_hash !== "string"
    || !CONTENT_HASH_RE.test(envelope.report_archive.content_hash))) {
    throw new Error("aftercare terminal report archive requires a stored content hash");
  }
  if (archived && canonicalPlan.report_json_archive && (typeof envelope.report_archive.json_content_hash !== "string"
    || !CONTENT_HASH_RE.test(envelope.report_archive.json_content_hash))) {
    throw new Error("aftercare terminal structured archive requires a stored content hash");
  }
  if (!canonicalPlan.report_archive && envelope.report_archive.content_hash !== null) throw new Error("aftercare envelope has a report hash without an archive path");
  if (!canonicalPlan.report_json_archive && envelope.report_archive.json_content_hash !== null) throw new Error("aftercare envelope has a structured hash without an archive path");
  if (operationBySurface.get("report_archive")?.local_ack !== (archived ? "applied" : "pending")
    || operationBySurface.get("local_register")?.local_ack !== (terminal ? "applied" : "pending")
    || operationBySurface.get("derived_manifest")?.local_ack !== (terminal ? "applied" : "pending")
    || operationBySurface.get("task_mirror")?.local_ack !== (terminal ? "applied" : "pending")) {
    throw new Error("aftercare journal operation acknowledgements do not match journal state");
  }
  const taskProviderAck = operationBySurface.get("task_mirror")?.provider_ack;
  if (journal.provider_receipt !== null) {
    if (!terminal
      || journal.provider_receipt.idempotency_key !== envelope.idempotency_key
      || journal.provider_receipt.payload_hash !== operationBySurface.get("task_mirror")?.payload_hash
      || taskProviderAck !== "applied") {
      throw new Error("aftercare provider receipt is not bound to the terminal operation");
    }
  } else if (taskProviderAck === "applied") {
    throw new Error("aftercare provider ack cannot be applied without an append-only receipt");
  }
  if ((!terminal && taskProviderAck !== "pending")
    || envelope.local_cleanup_complete !== terminal
    || envelope.external_sync_pending !== (taskProviderAck !== "applied")) {
    throw new Error("aftercare journal cleanup/provider status does not match journal state");
  }
}

function assertJournalPostconditions(journal: AftercareJournal): void {
  const plan = journal.plan;
  const stateIndex = AFTERCARE_STATES.indexOf(journal.state);
  if (stateIndex >= AFTERCARE_STATES.indexOf("control_finalized") && plan.work_id && plan.control_session_id) {
    const roots = garelierControlRoots(plan.project_root, plan.target_root, plan.pm_id);
    // Durable control evidence binds the result's original canonical location.
    // Retention may later move the exact authenticated bytes beside the archived
    // request; the fresh pair/hash validation has already proven equivalence.
    if (!hasMergeControlEvidence(roots, plan.work_id, plan.studio_commit, plan.result_path)) {
      throw new Error("aftercare journal claims control finalization without canonical merge evidence");
    }
  }
  if (stateIndex >= AFTERCARE_STATES.indexOf("archived") && plan.report_archive) {
    const expectedHash = journal.envelope.report_archive.content_hash;
    if (typeof expectedHash !== "string" || !CONTENT_HASH_RE.test(expectedHash)) {
      throw new Error("aftercare journal archive postcondition has no authenticated hash");
    }
    if (!existsSync(plan.report_archive)
      || sha256(readStableFile(plan.report_archive, "aftercare report archive", MAX_REPORT_ARCHIVE_BYTES)) !== expectedHash) {
      throw new Error("aftercare journal archive postcondition is missing or has changed bytes");
    }
    const expectedJsonHash = journal.envelope.report_archive.json_content_hash;
    if (plan.report_json_archive) {
      if (typeof expectedJsonHash !== "string" || !CONTENT_HASH_RE.test(expectedJsonHash)) {
        throw new Error("aftercare journal structured archive postcondition has no authenticated hash");
      }
      if (!existsSync(plan.report_json_archive)
        || sha256(readStableFile(plan.report_json_archive, "aftercare structured archive", MAX_REPORT_FILE_BYTES)) !== expectedJsonHash) {
        throw new Error("aftercare journal structured archive postcondition is missing or has changed bytes");
      }
    }
  }
  if (stateIndex >= AFTERCARE_STATES.indexOf("worktree_removed") && plan.checkout) {
    if (existsSync(plan.checkout) || registeredWorktrees(plan.target_root).some((entry) => entry.branch === plan.workbench_branch || sameFilesystemPath(entry.path, plan.checkout!))) {
      throw new Error("aftercare journal claims worktree removal but the checkout remains registered/present");
    }
  }
  if (stateIndex >= AFTERCARE_STATES.indexOf("branch_removed") && refExists(plan.target_root, `refs/heads/${plan.workbench_branch}`)) {
    throw new Error("aftercare journal claims branch removal but the ref remains");
  }
  if (stateIndex >= AFTERCARE_STATES.indexOf("container_removed") && plan.container) {
    if (existsSync(plan.container)) throw new Error("aftercare journal claims container removal but the container remains");
  } else if (stateIndex >= AFTERCARE_STATES.indexOf("container_retired") && plan.container) {
    if (!existsSync(plan.container)) {
      if (journal.pending_step !== "container_removed" && !isAttendedGcTerminal(journal, false)) {
        throw new Error("aftercare logical retirement requires the original container until physical removal intent is journaled");
      }
    } else {
      validateContainerAfterCheckout(plan, journal.envelope, plan.container, false);
    }
  }
}

function convergeJournalCaches(journal: AftercareJournal): void {
  const runtimeRoot = join(journal.plan.project_root, "__garelier", journal.plan.pm_id, "runtime");
  const journalBytes = canonicalJson(journal);
  if (!existsSync(journal.plan.journal_path) || readStableText(journal.plan.journal_path, "aftercare journal cache", MAX_AUTHORITY_JSON_BYTES) !== journalBytes) {
    atomicWriteRuntimeFile(runtimeRoot, journal.plan.journal_path, journalBytes);
  }
  if (AFTERCARE_STATES.indexOf(journal.state) >= AFTERCARE_STATES.indexOf("views_refreshed")) {
    const envelopeBytes = canonicalJson(journal.envelope);
    if (!existsSync(journal.plan.envelope_path) || readStableText(journal.plan.envelope_path, "aftercare envelope cache", MAX_AUTHORITY_JSON_BYTES) !== envelopeBytes) {
      atomicWriteRuntimeFile(runtimeRoot, journal.plan.envelope_path, envelopeBytes);
    }
  }
}

function logicalRetirementMarker(journal: AftercareJournal): LogicalDispatchRetirementMarker | null {
  if (!journal.plan.container || !journal.plan.dispatch_id
    || AFTERCARE_STATES.indexOf(journal.state) < AFTERCARE_STATES.indexOf("container_retired")) return null;
  return {
    schema_version: 1,
    kind: "garelier_logical_dispatch_retirement",
    dispatch_id: journal.plan.dispatch_id,
    container: journal.plan.container,
    request_id: journal.request_id,
    plan_digest: journal.plan.plan_digest,
    journal_revision: journal.revision,
    journal_record_hash: journal.record_hash,
  };
}

function publishLogicalRetirementMarker(journal: AftercareJournal): boolean {
  const marker = logicalRetirementMarker(journal);
  if (!marker) return false;
  const runtimeRoot = join(journal.plan.project_root, "__garelier", journal.plan.pm_id, "runtime");
  const path = join(runtimeRoot, "land_aftercare", "retired_dispatches", `${marker.dispatch_id}.json`);
  const bytes = canonicalJson(marker);
  if (existsSync(path)) {
    try {
      if (readStableText(path, "logical dispatch retirement marker", MAX_AUTHORITY_JSON_BYTES) === bytes) return false;
    } catch { /* derived marker is repaired from append-only journal authority */ }
  }
  atomicWriteRuntimeFile(runtimeRoot, path, bytes);
  return true;
}

function refreshDerivedManifestOnly(plan: LandAftercarePlan): void {
  const eventScript = join(dirname(import.meta.dir), "scripts", "dispatch_event.ts");
  const event = spawnSync(process.execPath, [eventScript, "--project", plan.project_root, "--pm-id", plan.pm_id, "--regen-only"], {
    windowsHide: true, cwd: plan.project_root, encoding: "utf8", timeout: 60_000,
  });
  if ((event.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw new Error("derived manifest retirement refresh timed out after 60000ms");
  if (event.error) throw new Error(`derived manifest retirement refresh spawn failed: ${event.error.message}`);
  if (event.signal) throw new Error(`derived manifest retirement refresh terminated by signal ${event.signal}`);
  if (event.status === null) throw new Error("derived manifest retirement refresh exited without a status");
  if (event.status !== 0) throw new Error(`derived manifest retirement refresh failed: ${event.stderr?.toString().trim()}`);
}

function readAndValidateJournal(path: string, options: PlanLandAftercareOptions): { journal: AftercareJournal; plan: LandAftercarePlan } {
  const journal = readJournal(path);
  const containerPresent = journal.plan.container !== null && existsSync(journal.plan.container);
  const attendedGcTerminal = journal.plan.container !== null && isAttendedGcTerminal(journal, containerPresent);
  const frozenAfterRemovalIntent = journal.state === "container_removed"
    || journal.pending_step === "container_removed"
    || attendedGcTerminal;
  if (frozenAfterRemovalIntent && (journal.request_id !== options.requestId
    || journal.plan.pm_id !== options.pmId
    || !sameFilesystemPath(journal.plan.project_root, resolve(options.project))
    || !sameFilesystemPath(journal.plan.target_root, resolve(options.targetRoot ?? options.project))
    || (options.dispatchId != null && journal.plan.dispatch_id !== String(options.dispatchId)))) {
    throw new Error("terminal aftercare journal does not match the requested project/PM/request/dispatch identity");
  }
  // A completed replay, and a crash replay after physical-removal intent,
  // authenticate the frozen plan, request/result pair and postconditions.
  // Re-deriving preservation inputs after their source container has been
  // removed would dead-end the very crash window that intent journaling closes;
  // earlier intermediate states still require fresh re-derivation.
  const canonicalPlan = frozenAfterRemovalIntent ? journal.plan : deriveLandAftercarePlan(
    options, false, journal.plan.declared_preservation, journal.plan.preservation_skips,
  );
  validateJournalAgainstPlan(journal, canonicalPlan);
  assertFrozenPair(journal.plan);
  assertJournalPostconditions(journal);
  return { journal, plan: journal.plan };
}

function assertExpectedPlanDigest(plan: LandAftercarePlan, expectedPlanDigest: string): void {
  if (!CONTENT_HASH_RE.test(expectedPlanDigest)) throw new Error("aftercare expected plan digest is malformed");
  if (plan.plan_digest !== expectedPlanDigest) {
    throw new Error(`aftercare expected plan digest mismatch: ${plan.plan_digest} != ${expectedPlanDigest}`);
  }
}

/** A legacy cleanup may have removed the checkout and branch before Control
 * evidence was finalized. Only that exact, fully-removed shape is recoverable:
 * derive the plan from the immutable successful request/result pair and leave
 * every filesystem-retirement step untouched. */
function postCleanupControlRecoveryPlan(options: PlanLandAftercareOptions): LandAftercarePlan | null {
  const plan = deriveLandAftercarePlan(options, false);
  const branchPresent = refExists(plan.target_root, `refs/heads/${plan.workbench_branch}`);
  const checkoutPresent = plan.checkout !== null && existsSync(plan.checkout);
  if (branchPresent || checkoutPresent) return null;
  return plan;
}

export interface GateRecoveryAftercareReplan {
  recovery_receipt: string;
  review_sha: string;
  archive_root: string | null;
  archive_manifest: string | null;
  retired_plan_digest: string | null;
}

/**
 * Retire frozen aftercare authority only after review_prepare has archived the
 * contaminated gate evidence and sealed an inspectable same-SHA replacement.
 * This is the driver-owned half of the recovery path: callers never edit a
 * journal or move `.revisions/` by hand. A deterministic runtime/tmp archive
 * makes a crash between the two renames resumable and keeps every old byte
 * traceable to the replacement receipt that authorized re-planning.
 */
export function replanLandAftercareAfterGateRecovery(
  options: PlanLandAftercareOptions & { dispatchId: string | number },
): GateRecoveryAftercareReplan {
  if (!SAFE_ID_RE.test(options.requestId)) throw new Error(`request_id contains unsafe path characters: ${options.requestId}`);
  const dispatchId = String(options.dispatchId);
  if (!/^\d+$/.test(dispatchId)) throw new Error("gate-recovery aftercare replan requires a numeric dispatch id");
  if (options.forceRemove === true) throw new Error("gate-recovery aftercare replan forbids force-remove");
  const project = resolve(options.project);
  const verified = verifiedGateLogRecoveryReceipt({
    project, pmId: options.pmId, dispatchId,
  });
  const receipt = verified.receipt;
  const runtimeRoot = join(project, "__garelier", options.pmId, "runtime");
  const journalPath = join(runtimeRoot, "land_aftercare", "journals", `${options.requestId}.json`);
  const revisionPath = journalRevisionDirectory(journalPath);
  const archiveRoot = join(runtimeRoot, "tmp", "gate-recovery-aftercare", `${options.requestId}-${receipt.recovery_id}`);
  const archivedJournal = join(archiveRoot, basename(journalPath));
  const archivedRevisions = journalRevisionDirectory(archivedJournal);
  const manifestPath = join(archiveRoot, "replan.json");
  const existingManifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    : null;
  if (existingManifest && (existingManifest.kind !== "garelier_land_aftercare_gate_replan"
    || existingManifest.recovery_id !== receipt.recovery_id
    || existingManifest.request_id !== options.requestId
    || existingManifest.dispatch_id !== dispatchId)) {
    throw new Error(`gate-recovery aftercare replan manifest is invalid: ${manifestPath}`);
  }

  const sourceRevisions = existsSync(revisionPath);
  const destinationRevisions = existsSync(archivedRevisions);
  if (sourceRevisions && destinationRevisions) {
    // A completed archive plus a new canonical journal is expected after a
    // crash during the replacement apply. It is distinguishable by the frozen
    // plan digest and must not be retired a second time.
    if (!existingManifest) throw new Error("gate-recovery aftercare archive has two revision authorities without a manifest");
    const current = readJournal(journalPath);
    if (current.plan.plan_digest === existingManifest.retired_plan_digest) {
      throw new Error("gate-recovery aftercare old journal reappeared after retirement");
    }
    return {
      recovery_receipt: verified.path,
      review_sha: receipt.review_sha,
      archive_root: archiveRoot,
      archive_manifest: manifestPath,
      retired_plan_digest: String(existingManifest.retired_plan_digest),
    };
  }
  if (!sourceRevisions && !destinationRevisions) {
    // Planning can reject an uninspectable log before a journal is born. The
    // verified receipt is still mandatory; there is simply no frozen authority
    // to retire before the caller derives the first clean plan.
    return {
      recovery_receipt: verified.path,
      review_sha: receipt.review_sha,
      archive_root: null,
      archive_manifest: null,
      retired_plan_digest: null,
    };
  }

  // The archive is written in two renames (revisions first, journal second).
  // Prefer the canonical journal whenever it still exists so a crash between
  // those renames resumes instead of treating the not-yet-created destination
  // journal as authority.
  const oldJournalPath = existsSync(journalPath) ? journalPath : archivedJournal;
  const journal = readJournal(oldJournalPath);
  if (journal.plan.project_root !== project || journal.plan.pm_id !== options.pmId
    || journal.plan.request_id !== options.requestId || journal.plan.dispatch_id !== dispatchId) {
    throw new Error("gate-recovery aftercare journal identity does not match the requested recovery");
  }
  if (journal.plan.workbench_tip !== receipt.review_sha) {
    throw new Error(
      `gate-recovery aftercare journal review ${journal.plan.workbench_tip} does not match replacement ${receipt.review_sha}`,
    );
  }
  if (AFTERCARE_STATES.indexOf(journal.state) >= AFTERCARE_STATES.indexOf("views_refreshed")) {
    throw new Error("gate-recovery aftercare journal is already terminal and must not be replanned");
  }
  if (existingManifest && journal.plan.plan_digest !== existingManifest.retired_plan_digest) {
    throw new Error("gate-recovery aftercare archive manifest does not bind the retired journal plan");
  }
  const lock = acquireRequestLock(journal.plan, new Date(), 30_000);
  try {
    const locked = readJournal(oldJournalPath);
    if (canonicalJson(locked) !== canonicalJson(journal)) {
      throw new Error("gate-recovery aftercare journal changed while acquiring its request lock");
    }
    ensureSafeDirectory(runtimeRoot, archiveRoot);
    if (sourceRevisions) renameSync(revisionPath, archivedRevisions);
    if (existsSync(journalPath)) {
      if (existsSync(archivedJournal)) throw new Error(`gate-recovery aftercare archive collision: ${archivedJournal}`);
      renameSync(journalPath, archivedJournal);
    }
    const files = readdirSync(archivedRevisions)
      .filter((name) => /^\d{12}\.json$/.test(name))
      .sort()
      .map((name) => {
        const path = join(archivedRevisions, name);
        return { path: path.replace(/\\/g, "/"), content_hash: sha256(readFileSync(path)) };
      });
    if (existsSync(archivedJournal)) {
      files.push({
        path: archivedJournal.replace(/\\/g, "/"),
        content_hash: sha256(readFileSync(archivedJournal)),
      });
    }
    const manifest = {
      schema_version: 1,
      kind: "garelier_land_aftercare_gate_replan",
      generated_by: "dispatch_cleanup.ts",
      request_id: options.requestId,
      dispatch_id: dispatchId,
      review_sha: receipt.review_sha,
      recovery_id: receipt.recovery_id,
      recovery_receipt: verified.path.replace(/\\/g, "/"),
      recovery_receipt_hash: sha256(readFileSync(verified.path)),
      retired_plan_digest: journal.plan.plan_digest,
      archived_files: files,
    };
    const body = canonicalJson(manifest);
    if (existingManifest) {
      if (canonicalJson(existingManifest) !== body) throw new Error(`gate-recovery aftercare manifest collision: ${manifestPath}`);
    } else {
      atomicWriteRuntimeFile(runtimeRoot, manifestPath, body);
    }
    return {
      recovery_receipt: verified.path,
      review_sha: receipt.review_sha,
      archive_root: archiveRoot,
      archive_manifest: manifestPath,
      retired_plan_digest: journal.plan.plan_digest,
    };
  } finally { lock.release(); }
}

export function applyLandAftercare(options: ApplyLandAftercareOptions): AftercareRunResult {
  if (!SAFE_ID_RE.test(options.requestId)) throw new Error(`request_id contains unsafe path characters: ${options.requestId}`);
  const project = resolve(options.project);
  const journalPath = join(project, "__garelier", options.pmId, "runtime", "land_aftercare", "journals", `${options.requestId}.json`);
  let journal: AftercareJournal | null = null;
  let plan: LandAftercarePlan;
  if (journalEvidenceExists(journalPath)) {
    ({ journal, plan } = readAndValidateJournal(journalPath, options));
  } else {
    plan = postCleanupControlRecoveryPlan(options) ?? planLandAftercare(options);
  }
  assertExpectedPlanDigest(plan, options.expectedPlanDigest);
  const lock = acquireRequestLock(plan, options.now?.() ?? new Date(), options.staleLockGraceMs ?? 30_000);
  try {
    let createdJournal = false;
    if (journalEvidenceExists(journalPath)) {
      ({ journal, plan } = readAndValidateJournal(journalPath, options));
      convergeJournalCaches(journal);
    } else {
      const recoveryPlan = postCleanupControlRecoveryPlan(options);
      if (recoveryPlan) {
        plan = recoveryPlan;
        assertExpectedPlanDigest(plan, options.expectedPlanDigest);
        assertFrozenPair(plan);
        if (postCleanupControlRecoveryPlan(options) === null) {
          throw new Error("post-cleanup recovery targets reappeared before Control finalization");
        }
        if (plan.work_id) assertFinalizeOrderOk(project, options.pmId, plan.studio_branch, plan.work_id);
        finalizeControl(plan);
        return {
          mode: "control-recovery", plan, journal_state: null, envelope: null,
          external_sync_pending: false,
        };
      }
      plan = planLandAftercare(options);
      assertExpectedPlanDigest(plan, options.expectedPlanDigest);
      assertDeclaredPreservationUnchanged(plan);
      journal = createJournal(plan);
      createdJournal = true;
    }
    assertExpectedPlanDigest(plan, options.expectedPlanDigest);
    if (createdJournal) options.testHooks?.afterPreparedJournal?.();
    if (journal.state === "container_removed") {
      if (publishLogicalRetirementMarker(journal)) refreshDerivedManifestOnly(journal.plan);
      return { mode: "no-op", plan: journal.plan, journal_state: journal.state, envelope: journal.envelope, external_sync_pending: journal.envelope.external_sync_pending };
    }
    // The journal freezes merge authority, while force-remove is an attended
    // execution choice. A later recovery may therefore strengthen only the
    // destructive operation without rewriting the append-only plan. Keep all
    // archival/control identity on `journal.plan`; use this projection solely
    // for live safety checks and the removal calls that consume the flag.
    const executionPlan = (): LandAftercarePlan => options.forceRemove === true
      ? { ...journal!.plan, force_remove: true }
      : journal!.plan;
    const index = () => AFTERCARE_STATES.indexOf((journal as AftercareJournal).state);
    if (index() < AFTERCARE_STATES.indexOf("control_finalized")) {
      assertLiveTargets(executionPlan(), true);
      journal = withPending(journal, "control_finalized");
      // W-346 FR9: aftercare for a Work bound to a landed-but-not-yet-closed
      // closure lease is deferred unchanged (the shared finalize-order hook —
      // same guard as landing_finalize.ts and dispatch_cleanup.ts).
      if (journal.plan.work_id) {
        assertFinalizeOrderOk(project, options.pmId, journal.plan.studio_branch, journal.plan.work_id);
      }
      finalizeControl(journal.plan);
      journal = advance(journal, "control_finalized", journal.envelope);
      options.testHooks?.afterControlFinalized?.();
    }
    if (index() < AFTERCARE_STATES.indexOf("archived")) {
      journal = withPending(journal, "archived");
      assertLiveTargets(executionPlan());
      const body = archiveBodyForPlan(journal.plan);
      const { contentHash, jsonContentHash } = writeArchive(journal.plan, body);
      // W-713 / DEC-100 ruling 5: preserve BEFORE the container is retired.
      // The bytes come through `readFrozenContainerFile`, so an artifact
      // rewritten after the plan was frozen is detected rather than copied.
      // Copy, never move: the snapshot assertions later in this run compare the
      // container against the frozen inventory, and the container is removed
      // whole a few steps below, so a per-file delete here would only be a
      // second way to be wrong.
      preserveAftercareEvidence(journal.plan);
      let envelope = markOperation(journal.envelope, "report_archive", { local_ack: "applied" });
      envelope = { ...envelope, report_archive: {
        path: journal.plan.report_archive,
        content_hash: contentHash,
        json_path: journal.plan.report_json_archive,
        json_content_hash: jsonContentHash,
      } };
      journal = advance(journal, "archived", envelope);
    }
    if (index() < AFTERCARE_STATES.indexOf("worktree_removed")) {
      const resumingPending = journal.pending_step === "worktree_removed";
      if (!resumingPending && journal.plan.checkout && !existsSync(journal.plan.checkout)) {
        throw new Error("worktree is absent without journaled removal intent");
      }
      journal = withPending(journal, "worktree_removed");
      if (!journal.plan.checkout || existsSync(journal.plan.checkout)) {
        assertLiveTargets(executionPlan());
        removeWorktree(executionPlan());
      }
      journal = advance(journal, "worktree_removed", journal.envelope);
    }
    if (index() < AFTERCARE_STATES.indexOf("branch_removed")) {
      const resumingPending = journal.pending_step === "branch_removed";
      const ref = `refs/heads/${journal.plan.workbench_branch}`;
      const existedBeforeIntent = refExists(journal.plan.target_root, ref);
      if (!resumingPending && !existedBeforeIntent) throw new Error("branch is absent without journaled removal intent");
      journal = withPending(journal, "branch_removed");
      assertFrozenPair(journal.plan);
      const branchExists = refExists(journal.plan.target_root, ref);
      if (branchExists) removeBranch(executionPlan());
      else if (!resumingPending) throw new Error("branch disappeared after intent but before this runner removed it");
      journal = advance(journal, "branch_removed", journal.envelope);
    }
    if (index() < AFTERCARE_STATES.indexOf("container_retired")) {
      journal = withPending(journal, "container_retired");
      assertFrozenPair(journal.plan);
      if (journal.plan.container) {
        if (!existsSync(journal.plan.container)) throw new Error("container is absent before logical retirement");
        validateContainerAfterCheckout(executionPlan(), journal.envelope, journal.plan.container, false);
      }
      const retirementEnvelope = {
        ...journal.envelope,
        retirement_tombstone: null,
        physical_gc_pending: journal.plan.container !== null,
      };
      journal = advance(journal, "container_retired", retirementEnvelope);
      publishLogicalRetirementMarker(journal);
    }
    if (index() < AFTERCARE_STATES.indexOf("views_refreshed")) {
      journal = withPending(journal, "views_refreshed");
      assertFrozenPair(journal.plan);
      const envelope = refreshViews(journal.plan, journal.envelope);
      journal = advance(journal, "views_refreshed", envelope);
      convergeJournalCaches(journal);
    }
    if (index() < AFTERCARE_STATES.indexOf("container_removed")) {
      const resumingPending = journal.pending_step === "container_removed";
      const attendedGcTerminal = journal.plan.container !== null
        && isAttendedGcTerminal(journal, existsSync(journal.plan.container));
      journal = withPending(journal, "container_removed");
      assertFrozenPair(journal.plan);
      if (journal.plan.container && existsSync(journal.plan.container)) {
        validateContainerAfterCheckout(executionPlan(), journal.envelope, journal.plan.container, false);
        removeTreeSync(journal.plan.container);
      } else if (journal.plan.container && !resumingPending && !attendedGcTerminal) {
        throw new Error("container is absent without journaled physical removal intent");
      }
      if (journal.plan.container && existsSync(journal.plan.container)) {
        throw new Error(`container removal did not remove ${journal.plan.container}`);
      }
      options.testHooks?.afterContainerRemoved?.();
      journal = advance(journal, "container_removed", { ...journal.envelope, physical_gc_pending: false });
      convergeJournalCaches(journal);
      publishLogicalRetirementMarker(journal);
    }
    return { mode: "apply", plan: journal.plan, journal_state: journal.state, envelope: journal.envelope, external_sync_pending: journal.envelope.external_sync_pending };
  } finally { lock.release(); }
}

export function dryRunLandAftercare(options: PlanLandAftercareOptions): AftercareRunResult {
  if (!SAFE_ID_RE.test(options.requestId)) throw new Error(`request_id contains unsafe path characters: ${options.requestId}`);
  const journalPath = join(resolve(options.project), "__garelier", options.pmId, "runtime", "land_aftercare", "journals", `${options.requestId}.json`);
  if (journalEvidenceExists(journalPath)) {
    const { journal } = readAndValidateJournal(journalPath, options);
    return { mode: "no-op", plan: journal.plan, journal_state: journal.state, envelope: journal.envelope, external_sync_pending: journal.envelope.external_sync_pending };
  }
  const plan = postCleanupControlRecoveryPlan(options) ?? planLandAftercare(options);
  return { mode: "dry-run", plan, journal_state: null, envelope: null, external_sync_pending: true };
}

export interface VerifiedProviderOperation {
  schema_version: 1;
  kind: "garelier_land_aftercare_verified_provider_operation";
  journal: string;
  request_id: string;
  idempotency_key: string;
  payload_hash: string;
  payload: unknown;
}

export function verifyProviderOperation(options: PlanLandAftercareOptions): VerifiedProviderOperation {
  if (!SAFE_ID_RE.test(options.requestId)) throw new Error(`request_id contains unsafe path characters: ${options.requestId}`);
  const project = resolve(options.project);
  const journalPath = join(project, "__garelier", options.pmId, "runtime", "land_aftercare", "journals", `${options.requestId}.json`);
  const { journal } = readAndValidateJournal(journalPath, options);
  const containerPresent = journal.plan.container !== null && existsSync(journal.plan.container);
  if (journal.state !== "container_removed" && !isAttendedGcTerminal(journal, containerPresent)) {
    throw new Error(`provider operation requires local terminal state, found ${journal.state}`);
  }
  if (journal.provider_receipt !== null) throw new Error("provider operation is already acknowledged");
  const operation = journal.envelope.operations.find((item) => item.surface === "task_mirror");
  if (!operation || operation.local_ack !== "applied" || operation.provider_ack !== "pending") {
    throw new Error("provider operation is not a pending authenticated task_mirror operation");
  }
  return {
    schema_version: 1,
    kind: "garelier_land_aftercare_verified_provider_operation",
    journal: journalPath,
    request_id: journal.request_id,
    idempotency_key: journal.envelope.idempotency_key,
    payload_hash: operation.payload_hash,
    payload: operation.payload,
  };
}

export function acknowledgeProvider(options: PlanLandAftercareOptions & { idempotencyKey: string; payloadHash: string }): AftercareResultEnvelope {
  if (!SAFE_ID_RE.test(options.requestId)) throw new Error(`request_id contains unsafe path characters: ${options.requestId}`);
  const project = resolve(options.project);
  const journalPath = join(project, "__garelier", options.pmId, "runtime", "land_aftercare", "journals", `${options.requestId}.json`);
  if (!journalEvidenceExists(journalPath)) throw new Error(`aftercare journal is missing: ${journalPath}`);
  let { journal, plan } = readAndValidateJournal(journalPath, options);
  const containerPresent = journal.plan.container !== null && existsSync(journal.plan.container);
  if (journal.state !== "container_removed" && !isAttendedGcTerminal(journal, containerPresent)) {
    throw new Error(`provider ack requires local terminal state, found ${journal.state}`);
  }
  if (journal.envelope.idempotency_key !== options.idempotencyKey) throw new Error("provider ack idempotency key mismatch");
  const operation = journal.envelope.operations.find((item) => item.surface === "task_mirror")!;
  if (operation.payload_hash !== options.payloadHash) throw new Error("provider ack payload hash mismatch");
  const lock = acquireRequestLock(plan, new Date(), 30_000);
  try {
    ({ journal, plan } = readAndValidateJournal(journalPath, options));
    convergeJournalCaches(journal);
    if (publishLogicalRetirementMarker(journal)) refreshDerivedManifestOnly(journal.plan);
    const lockedContainerPresent = journal.plan.container !== null && existsSync(journal.plan.container);
    if (journal.state !== "container_removed" && !isAttendedGcTerminal(journal, lockedContainerPresent)) {
      throw new Error(`provider ack requires local terminal state, found ${journal.state}`);
    }
    if (journal.envelope.idempotency_key !== options.idempotencyKey) throw new Error("provider ack idempotency key mismatch");
    const lockedOperation = journal.envelope.operations.find((item) => item.surface === "task_mirror")!;
    if (lockedOperation.payload_hash !== options.payloadHash) throw new Error("provider ack payload hash mismatch");
    if (lockedOperation.provider_ack === "applied") return journal.envelope;
    const providerReceipt: ProviderAckReceipt = {
      schema_version: 1,
      kind: "garelier_land_aftercare_provider_receipt",
      surface: "task_mirror",
      request_id: journal.request_id,
      idempotency_key: journal.envelope.idempotency_key,
      payload_hash: lockedOperation.payload_hash,
      acknowledged_at: new Date().toISOString(),
    };
    let envelope = markOperation(journal.envelope, "task_mirror", { provider_ack: "applied" });
    envelope = { ...envelope, external_sync_pending: false };
    journal = writeJournalCas({ ...journal, envelope, provider_receipt: providerReceipt }, journal);
    convergeJournalCaches(journal);
    return envelope;
  } finally { lock.release(); }
}

function valueAfter(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`missing value for ${argv[index]}`);
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "";
  let project = "", targetRoot = "", pmId = "", requestId = "", dispatchId: string | null = null;
  let idempotencyKey = "", payloadHash = "", expectedPlanDigest = "";
  for (let index = 1; index < argv.length;) {
    switch (argv[index]) {
      case "--project": project = valueAfter(argv, index); index += 2; break;
      case "--target-root": targetRoot = valueAfter(argv, index); index += 2; break;
      case "--pm-id": pmId = valueAfter(argv, index); index += 2; break;
      case "--request-id": requestId = valueAfter(argv, index); index += 2; break;
      case "--dispatch-id": dispatchId = valueAfter(argv, index); index += 2; break;
      case "--idempotency-key": idempotencyKey = valueAfter(argv, index); index += 2; break;
      case "--payload-hash": payloadHash = valueAfter(argv, index); index += 2; break;
      case "--expect-plan-digest": expectedPlanDigest = valueAfter(argv, index); index += 2; break;
      default: throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (!project || !pmId || !requestId) throw new Error("--project, --pm-id, and --request-id are required");
  const common = { project, targetRoot: targetRoot || undefined, pmId, requestId, dispatchId };
  if (command === "dry-run") console.log(JSON.stringify(dryRunLandAftercare(common)));
  else if (command === "apply") {
    if (!expectedPlanDigest) {
      throw new Error("apply requires --expect-plan-digest from a separately reviewed dry-run; run dry-run first");
    }
    console.log(JSON.stringify(applyLandAftercare({ ...common, expectedPlanDigest })));
  }
  else if (command === "verify-provider-operation") console.log(JSON.stringify(verifyProviderOperation(common)));
  else if (command === "ack-provider") console.log(JSON.stringify(acknowledgeProvider({ ...common, idempotencyKey, payloadHash })));
  else throw new Error("usage: land_aftercare.ts <dry-run|apply|verify-provider-operation|ack-provider> --project <root> --pm-id <id> --request-id <id> [--target-root <root>] [--dispatch-id <id>] [--expect-plan-digest <sha256>]");
}

if (import.meta.main) main().catch((error) => { console.error(`land_aftercare: ${(error as Error).message}`); process.exit(2); });
