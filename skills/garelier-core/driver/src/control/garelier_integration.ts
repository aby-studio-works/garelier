import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { claimHasLiveMergeReservation, claimWork, readControlClaim, refreshClaimEntityRevision, releaseClaim, type ClaimTouchConflict, type ControlClaimRecord } from "./claims.ts";
import { assertNoSymlinkPath, atomicWriteRuntimeFile } from "./diagnostics.ts";
import { loadPlanGraphModel } from "./plan_graph_model.ts";
import type { BacklogRecord, CheckpointRecord, PlanGraphControlModel } from "./plan_graph_types.ts";
import {
  appendEvidenceLines,
  planBacklogUpdate,
  planGraphEntityRevision,
  planGraphEvidenceReferences,
  planGraphRecordAdapter,
  planGraphRuntimeCallbacks,
  planGraphTransactionCallbacks,
} from "./plan_graph_write.ts";
import { planLifecycleV3Transition } from "./lifecycle_v3.ts";
import { canonicalJson, sha256 } from "./serialization.ts";
import { readControlSession } from "./sessions.ts";
import { acquireNamespaceLock, assertNamespaceLock, resolveControlNamespace, resolveControlNamespaceForLock, runControlFilePlanTransaction, type NamespaceLock } from "./transaction.ts";
import { validateGateEvidence } from "./evidence_validation.ts";
import { optionalMachineString, tryParseMachineArtifact } from "../dispatch/machine_artifact.ts";
import { EVIDENCE_WRITER_STORAGE_KEY, type EvidenceReference } from "./types.ts";
import { readStableControl } from "./generation.ts";
import { readClaimRenewalAuthorizationRecord, renewDispatchClaimWithAudit, type DispatchClaimReservation } from "./claim_renewal_audit.ts";

export interface GarelierControlRoots {
  projectRoot: string;
  targetRoot: string;
  pmId: string;
  controlRoot: string;
  runtimeRoot: string;
}

export interface DispatchControlBinding {
  schema_version: 3;
  work_id: string;
  session_id: string;
  work_revision: number;
  claim_expires_at: string;
  touches: string[];
  touch_conflicts: ClaimTouchConflict[];
  generated_control_writes: ControlSettlementWrite[];
  merge_reservation?: DispatchClaimReservation;
}

interface UngatedMergeLandingBase {
  /** The dispatch branch whose tip landed. */
  branch: string;
  /** Full SHA of that branch's tip. */
  branchTip: string;
  /** The integration branch in which it landed directly. */
  integrationBranch: string;
  /** Full SHA of the integration branch tip at verification time. */
  integrationTip: string;
}

/**
 * W-472 — machine-checked proof that a branch landed on the integration
 * first-parent line, WITHOUT any merge-gate artifact. A merge landing names the
 * exact non-first parent; a fast-forward names the exact first-parent commit.
 * Every field is a git fact, never a self-reported claim ("I already merged it").
 */
export type UngatedMergeLanding = UngatedMergeLandingBase & (
  | { landingKind: "merge-parent"; parentNumber: number }
  | { landingKind: "fast-forward"; reflogSubject: string }
);

export interface MergeControlEvidence {
  /**
   * `ungated` (W-318/W-472) records a direct first-parent landing that git proves but NO merge
   * gate covers. It is deliberately not a synonym for `success`: it writes a
   * `merge_gate_bypass_record` (never a passing `gate` evidence reference), so
   * `hasMergeControlEvidence` keeps returning false and the row cannot close as
   * if it had been gated.
   */
  status: "success" | "ungated" | "aborted" | "failed" | "conflict" | "environment_blocked";
  commit?: string;
  /** Required for `ungated`; ignored otherwise. */
  ancestry?: UngatedMergeLanding;
  requestPath?: string;
  resultPath?: string;
  reportPath?: string;
  // W-247: alternate paths that also satisfy the merge request's
  // role_report_path binding (e.g. a pre-archive container path when
  // `reportPath` is the post-archive durable copy, or vice versa). A caller
  // recording evidence after dispatch_cleanup.ts has already archived the
  // role report passes the path the original merge request actually bound
  // to here, so the binding check below does not hard-fail on a path that only
  // changed because of routine archival.
  reportPathCandidates?: string[];
  guardianReportPath?: string;
  observerReportPath?: string;
  /**
   * Independent finalization captures request/result bytes before git ancestry
   * checks. The transactional recorder must recapture exactly these hashes and
   * the same requested tip before it may stage durable Control evidence.
   */
  expectedSuccessfulCapture?: {
    requestContentHash: string;
    resultContentHash: string;
    workbenchTip: string;
  };
  failureReason?: string;
}

export function garelierControlRoots(projectRoot: string, targetRoot: string, pmId: string): GarelierControlRoots {
  const project = resolve(projectRoot);
  const target = resolve(targetRoot || projectRoot);
  const controlRoot = join(project, "__garelier", pmId, "control");
  const runtimeRoot = join(project, "__garelier", pmId, "runtime", "control");
  return { projectRoot: project, targetRoot: target, pmId, controlRoot, runtimeRoot };
}

export function garelierControlSchema(projectRoot: string, pmId: string): number | null {
  const pmRoot = join(resolve(projectRoot), "__garelier", pmId);
  const controlRoot = join(pmRoot, "control");
  const runtimeRoot = join(pmRoot, "runtime", "control");
  return readStableControl({ controlRoot, runtimeRoot }, () => {
    const marker = join(controlRoot, "control.toml");
    if (!existsSync(marker)) return null;
    const source = readFileSync(marker, "utf8");
    const match = source.match(/^\s*schema_version\s*=\s*(\d+)\s*$/m);
    if (!match) throw new Error(`control.toml has an explicit but malformed/missing schema_version discriminator: ${marker}`);
    return Number(match[1]);
  });
}

export interface GarelierOperationGuard {
  roots: GarelierControlRoots;
  lock: NamespaceLock;
  schema: number | null;
  release(): void;
}

/** Acquire first, then validate schema while the same lock excludes writers. */
export function acquireGarelierOperationGuard(roots: GarelierControlRoots, sessionId: string, operation: string): GarelierOperationGuard {
  const preflightSchema = garelierControlSchema(roots.projectRoot, roots.pmId);
  if (preflightSchema !== null && preflightSchema !== 3) {
    throw new Error(`unsupported control schema_version ${preflightSchema}; only schema_version 3 is accepted`);
  }
  const paths = resolveControlNamespaceForLock({ targetRoot: roots.targetRoot, pmId: roots.pmId, controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot, allowMissingControl: true });
  const lock = acquireNamespaceLock(paths, { sessionId, operation, at: new Date().toISOString() });
  try {
    assertNamespaceLock(paths, lock);
    const marker = join(roots.controlRoot, "control.toml");
    let schema: number | null = null;
    if (existsSync(marker)) {
      const match = readFileSync(marker, "utf8").match(/^\s*schema_version\s*=\s*(\d+)\s*$/m);
      if (!match) throw new Error(`control.toml has an explicit but malformed/missing schema_version discriminator: ${marker}`);
      schema = Number(match[1]);
      if (schema !== 3) throw new Error(`unsupported control schema_version ${schema}; only schema_version 3 is accepted`);
    }
    return { roots, lock, schema, release: () => lock.release() };
  } catch (error) { lock.release(); throw error; }
}

function namespace(roots: GarelierControlRoots) {
  return resolveControlNamespace({
    targetRoot: roots.targetRoot,
    pmId: roots.pmId,
    controlRoot: roots.controlRoot,
    runtimeRoot: roots.runtimeRoot,
  });
}

export function inspectDispatchControlBinding(
  roots: GarelierControlRoots,
  workId: string,
  sessionId: string,
  namespaceLock?: NamespaceLock,
): { schema_version: 3; work: BacklogRecord; claim: ControlClaimRecord | null } {
  const paths = namespace(roots);
  if (namespaceLock) assertNamespaceLock(paths, namespaceLock);
  readControlSession(paths, sessionId);
  const schema = garelierControlSchema(roots.projectRoot, roots.pmId);
  if (schema === 3) {
    const model = loadPlanGraphModel(roots.controlRoot);
    const error = model.findings.find((finding) => finding.severity === "error");
    if (error) throw new Error(`schema-3 strict validation failed: ${error.code}: ${error.message}`);
    const work = model.backlog.get(workId);
    if (!work) throw new Error(`dispatch Backlog does not exist: ${workId}`);
    if (["done", "cancelled", "superseded"].includes(work.status)) throw new Error(`dispatch Backlog is closed: ${workId} (${work.status})`);
    return { schema_version: 3, work, claim: readControlClaim(paths, workId) };
  }
  throw new Error(`dispatch binding requires Control schema 3, found ${schema ?? "none"}`);
}

function activeCheckpointForBacklog(model: PlanGraphControlModel, workId: string): CheckpointRecord {
  const current = model.current;
  if (!current) throw new Error(`dispatch Backlog ${workId} requires project_dashboard/current.md`);
  const currentIds = new Set([
    ...(current.primaryCheckpointId ? [current.primaryCheckpointId] : []),
    ...current.checkpointCandidates,
  ]);
  const checkpoint = [...model.checkpoints.values()].find((candidate) =>
    candidate.status === "active" && currentIds.has(candidate.id) && candidate.backlog.includes(workId));
  if (!checkpoint) {
    // W-667 F-8: name the commands that satisfy the precondition. The bare
    // sentence sent the operator to a USAGE line that spells `create checkpoint`
    // as `... --session <id>`, so the required arguments had to be discovered by
    // trial. A Checkpoint is created `active`; it must ALSO be listed in
    // project_dashboard/current.md and carry this Backlog id.
    throw new Error(
      `dispatch Backlog ${workId} requires an active Checkpoint that is referenced by Current. `
        + `NEXT_COMMAND: garelier control create checkpoint --title <title> --next-action <text> --session <sid> --expect-control-revision <rev>, `
        + `then garelier control checkpoint save <CP-NNN> --backlog ${workId} --read-first backlog:${workId} --activate --session <sid> --expect-control-revision <rev> `
        + `(--activate writes the Checkpoint into project_dashboard/current.md).`,
    );
  }
  return checkpoint;
}

/**
 * W-667 F-8: the same precondition `claimDispatchControlWork` enforces, exposed so
 * a dispatcher can run it BEFORE it allocates anything. The claim itself already
 * precedes container/worktree creation, but the failure used to surface only after
 * the operator had written a blueprint and a task file, and after model/effort
 * routing and the pipeline assignment render had run. Read-only: no lock, no write.
 */
export function assertDispatchCheckpointPrecondition(roots: GarelierControlRoots, workId: string): void {
  const model = loadPlanGraphModel(roots.controlRoot);
  const work = model.backlog.get(workId);
  // Absent/closed rows are reported by inspectDispatchControlBinding; an already
  // active row is exempt exactly as it is inside claimDispatchControlWork.
  if (!work || work.status === "active") return;
  activeCheckpointForBacklog(model, workId);
}

export function claimDispatchControlWork(options: {
  roots: GarelierControlRoots;
  workId: string;
  sessionId: string;
  touches: string[];
  dispatchId?: string;
  rework?: boolean;
  /** A merge-bound claim preserves an already-active/verification lifecycle
   * state. It is not a fresh dispatch and must never send verification back to
   * active merely so an already-landed request can settle or re-land. */
  mergeBound?: boolean;
  /** A reviewed merge may reactivate a ready row without changing the sealed
   * candidate. */
  allowMergeReady?: boolean;
  /** Validate (or re-take) the merge-bound reservation without writing tracked
   * Control. merge_land uses this before the merge gate so the canonical
   * checkout remains clean; it performs audited renewal/ready settlement after
   * the gate publishes success. */
  deferMutation?: boolean;
  /** With deferMutation, reserve this same-session claim through the merge
   * gate without changing tracked Control. */
  mergeReservationUntil?: Date;
  authorityRefresh?: {
    previousRevision: number;
    currentRevision: number;
    evidencePath: string;
    evidenceHash: string;
  };
  /** The first merge_land admission may restore a missing runtime claim before
   * the Guardian/Observer verdict is consumed. At that point an authority
   * refresh cannot yet be admitted, so revision proof is deferred to the
   * post-review admission. */
  validateAuthorityRefresh?: boolean;
  /** Exact merge request whose in-run generated Control writes may join the
   * authenticated settlement manifest. */
  settlementRequestId?: string;
  now?: () => Date;
  namespaceLock?: NamespaceLock;
}): DispatchControlBinding {
  let inspected = inspectDispatchControlBinding(options.roots, options.workId, options.sessionId, options.namespaceLock);
  const now = options.now?.() ?? new Date();
  const dispatchClock = () => now;
  let state = inspected.work.status;
  const entityLabel = "Backlog";
  const allowedStates = options.mergeBound
    ? ["active", "verification", ...(options.allowMergeReady ? ["ready"] : [])]
    : ["ready", "active", "verification"];
  if (!allowedStates.includes(state)) {
    const requiredStates = options.mergeBound ? "active/verification" : "ready/active";
    throw new Error(`dispatch ${entityLabel} ${options.workId} is open but not dispatchable from ${state}; transition it to ${requiredStates} first`);
  }
  if (!options.mergeBound && state === "verification" && !options.rework) {
    throw new Error(`dispatch ${entityLabel} ${options.workId} is already in verification; pass --rework to return it to active`);
  }
  if (!options.mergeBound && state !== "active") {
    activeCheckpointForBacklog(loadPlanGraphModel(options.roots.controlRoot), options.workId);
  }
  if (options.mergeBound && inspected.claim && inspected.claim.session_id !== options.sessionId) {
    throw new Error(`dispatch Backlog ${options.workId} claim belongs to ${inspected.claim.session_id}, not ${options.sessionId}; foreign-session claims are never stolen by merge_land`);
  }
  if (options.deferMutation) {
    if (!inspected.claim) {
      claimWork({
        targetRoot: options.roots.targetRoot,
        pmId: options.roots.pmId,
        controlRoot: options.roots.controlRoot,
        runtimeRoot: options.roots.runtimeRoot,
        workId: options.workId,
        sessionId: options.sessionId,
        touches: options.touches,
        excludeDispatchIds: options.dispatchId ? [options.dispatchId] : undefined,
        now: dispatchClock,
        namespaceLock: options.namespaceLock,
        runtimeCallbacks: planGraphRuntimeCallbacks,
      });
    }
    const renewal = renewDispatchClaimWithAudit({
      roots: options.roots,
      workId: options.workId,
      sessionId: options.sessionId,
      touches: options.touches,
      now,
      namespaceLock: options.namespaceLock ?? (() => { throw new Error("schema-3 deferred dispatch validation requires the caller-held namespace lock"); })(),
      source: "merge-settlement",
      reason: "merge-bound Control preflight before gate execution",
      authorityRefresh: options.authorityRefresh,
      validateOnly: options.mergeReservationUntil === undefined,
      validateAuthorityRefresh: options.validateAuthorityRefresh,
      mergeReservationUntil: options.mergeReservationUntil,
      settlementRequestId: options.settlementRequestId,
    });
    const currentRevision = planGraphEntityRevision(inspected.work);
    return {
      schema_version: inspected.schema_version,
      work_id: renewal.claim.work_id,
      session_id: renewal.claim.session_id,
      work_revision: currentRevision,
      claim_expires_at: renewal.claim.expires_at,
      touches: renewal.claim.touches,
      touch_conflicts: renewal.claim.touch_conflicts,
      generated_control_writes: renewal.generatedControlWrite ? [renewal.generatedControlWrite] : [],
      ...(renewal.reservation ? { merge_reservation: renewal.reservation } : {}),
    };
  }
  const generatedControlWrites: ControlSettlementWrite[] = [];
  if (inspected.claim?.session_id === options.sessionId) {
    const lock = options.namespaceLock;
    if (!lock) throw new Error("schema-3 dispatch renewal requires the caller-held namespace lock");
    const renewal = renewDispatchClaimWithAudit({
      roots: options.roots,
      workId: options.workId,
      sessionId: options.sessionId,
      touches: options.touches,
      now,
      namespaceLock: lock,
      source: options.mergeBound ? "merge-settlement" : "dispatch-bind",
      reason: options.mergeBound ? "merge-bound Control settlement after gate execution" : "same-session dispatch continuation",
      authorityRefresh: options.authorityRefresh,
      settlementRequestId: options.settlementRequestId,
    });
    if (renewal.generatedControlWrite) generatedControlWrites.push(renewal.generatedControlWrite);
    if (renewal.renewed) {
      inspected = inspectDispatchControlBinding(options.roots, options.workId, options.sessionId, options.namespaceLock);
      state = inspected.work.status;
    }
  }
  const claim = claimWork({
    targetRoot: options.roots.targetRoot,
    pmId: options.roots.pmId,
    controlRoot: options.roots.controlRoot,
    runtimeRoot: options.roots.runtimeRoot,
    workId: options.workId,
    sessionId: options.sessionId,
    touches: options.touches,
    excludeDispatchIds: options.dispatchId ? [options.dispatchId] : undefined,
    now: dispatchClock,
    namespaceLock: options.namespaceLock,
    runtimeCallbacks: planGraphRuntimeCallbacks,
  });
  let finalRevision = planGraphEntityRevision(inspected.work);
  if ((!options.mergeBound && (state === "ready" || state === "verification"))
    || (options.mergeBound && options.allowMergeReady && state === "ready")) {
    try {
      const result = runControlFilePlanTransaction({
          targetRoot: options.roots.targetRoot,
          pmId: options.roots.pmId,
          controlRoot: options.roots.controlRoot,
          runtimeRoot: options.roots.runtimeRoot,
          expectedEntityRevisions: { [options.workId]: finalRevision },
          agent: inspected.claim?.agent ?? claim.agent,
          sessionId: options.sessionId,
          command: "dispatch-bind",
          now: dispatchClock,
          namespaceLock: options.namespaceLock,
          callbacks: planGraphTransactionCallbacks,
          mutate: ({ state: model, now }) => {
            const work = model.backlog.get(options.workId);
            if (!work) throw new Error(`dispatch Backlog does not exist: ${options.workId}`);
            activeCheckpointForBacklog(model, options.workId);
            return planLifecycleV3Transition({
              path: work.path,
              record: work,
              to: "active",
              hasActiveCheckpoint: true,
              currentHasCheckpoint: true,
              now,
              adapter: planGraphRecordAdapter,
            });
          },
        });
      if (result.status !== "committed") throw new Error("dispatch bind unexpectedly produced a dry-run");
      finalRevision = result.entity_revision_after ?? (() => { throw new Error("schema-3 dispatch bind did not return a Backlog revision"); })();
      refreshClaimEntityRevision({
        targetRoot: options.roots.targetRoot,
        pmId: options.roots.pmId,
        controlRoot: options.roots.controlRoot,
        runtimeRoot: options.roots.runtimeRoot,
        workId: options.workId,
        sessionId: options.sessionId,
        entityRevision: finalRevision,
        now: dispatchClock,
        namespaceLock: options.namespaceLock,
        runtimeCallbacks: planGraphRuntimeCallbacks,
      });
    } catch (error) {
      try {
        releaseClaim({ targetRoot: options.roots.targetRoot, pmId: options.roots.pmId, controlRoot: options.roots.controlRoot, runtimeRoot: options.roots.runtimeRoot, workId: options.workId, sessionId: options.sessionId, now: dispatchClock, namespaceLock: options.namespaceLock, runtimeCallbacks: planGraphRuntimeCallbacks });
      } catch { /* preserve the binding failure */ }
      throw error;
    }
  }
  return {
    schema_version: inspected.schema_version,
    work_id: claim.work_id,
    session_id: claim.session_id,
    work_revision: finalRevision,
    claim_expires_at: claim.expires_at,
    touches: claim.touches,
    touch_conflicts: claim.touch_conflicts,
    generated_control_writes: generatedControlWrites,
  };
}

const MAX_MERGE_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MERGE_EVIDENCE_TOTAL_BYTES = 8 * 1024 * 1024;

export interface CapturedEvidenceSource {
  path: string;
  source: string;
  contentHash: string;
  bytes: number;
}

interface DurableMergeEvidence {
  writes: { path: string; source: string }[];
  evidence: EvidenceReference[];
  reportPaths: string[];
  gatePath: string;
  reportBindingWarning?: string;
}

function projectRelativePath(roots: GarelierControlRoots, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(roots.projectRoot, path);
  const candidate = relative(roots.projectRoot, absolute);
  const normalized = candidate.replace(/\\/g, "/");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`merge evidence source escapes the control project: ${path}`);
  }
  return normalized;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function captureEvidenceSource(roots: GarelierControlRoots, path: string, label: string): CapturedEvidenceSource {
  const relativePath = projectRelativePath(roots, path)!;
  const absolute = resolve(roots.projectRoot, ...relativePath.split("/"));
  assertNoSymlinkPath(roots.projectRoot, absolute);
  const before = lstatSync(absolute);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  if (before.size > MAX_MERGE_EVIDENCE_FILE_BYTES) throw new Error(`${label} exceeds ${MAX_MERGE_EVIDENCE_FILE_BYTES} bytes: ${path}`);
  const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const descriptor = openSync(absolute, flags);
  let buffer: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error(`${label} changed while it was opened: ${path}`);
    buffer = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    if (!sameFile(opened, afterRead) || afterRead.size !== buffer.byteLength) throw new Error(`${label} changed while it was read: ${path}`);
  } finally {
    closeSync(descriptor);
  }
  assertNoSymlinkPath(roots.projectRoot, absolute);
  const after = lstatSync(absolute);
  if (!sameFile(before, after)) throw new Error(`${label} changed during evidence capture: ${path}`);
  const source = buffer.toString("utf8");
  if (source.includes("\0") || !Buffer.from(source, "utf8").equals(buffer)) throw new Error(`${label} must be valid UTF-8 text without NUL bytes: ${path}`);
  return { path: relativePath, source, contentHash: sha256(buffer), bytes: buffer.byteLength };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function parseJson(source: CapturedEvidenceSource, label: string): Record<string, unknown> {
  try { return record(JSON.parse(source.source), label); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${(error as Error).message}`); }
}

function reviewBinding(source: string, label: string): { verdict: "PASS" | "PASS_WITH_NOTES"; reviewSha: string } {
  let verdict = "", reviewSha = "";
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    verdict = typeof parsed.verdict === "string" ? parsed.verdict : "";
    reviewSha = typeof parsed.review_sha === "string" ? parsed.review_sha : "";
  } catch {
    // Not a JSON evidence record, so it is a gate verdict artifact: read the
    // typed front matter rather than scanning the prose for `verdict:`.
    const parsed = tryParseMachineArtifact(source, label);
    if (!parsed.ok) throw new Error(`${label} could not be read: ${parsed.message}`);
    verdict = optionalMachineString(parsed.artifact, "verdict", "result", label) ?? "";
    reviewSha = optionalMachineString(parsed.artifact, "verdict", "review_sha", label) ?? "";
  }
  if (verdict !== "PASS" && verdict !== "PASS_WITH_NOTES") throw new Error(`${label} has no canonical passing verdict`);
  if (!/^[0-9a-f]{7,64}$/.test(reviewSha)) throw new Error(`${label} has no canonical review_sha`);
  return { verdict, reviewSha };
}

function stringCommands(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be an array of non-empty command strings`);
  }
  return value as string[];
}

function sameCommands(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((command, index) => command !== expected[index])) {
    throw new Error(`${label} does not exactly match the requested ordered command set`);
  }
}

function passingSteps(value: unknown, expected: readonly string[], label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`merge-gate result ${label} must be an array`);
  const commands: string[] = [];
  if (value.some((step) => {
    const item = step && typeof step === "object" && !Array.isArray(step) ? step as Record<string, unknown> : null;
    if (item && typeof item.cmd === "string" && item.cmd) commands.push(item.cmd);
    return !item || typeof item.cmd !== "string" || !item.cmd || item.exit_code !== 0 || (item.status !== undefined && item.status !== "pass");
  })) throw new Error(`merge-gate result contains a non-passing ${label} entry`);
  sameCommands(commands, expected, `merge-gate result ${label}`);
  return commands;
}

function configSource(value: unknown, label: string): { path: string; content_hash: string } | null {
  if (value === null || value === undefined) return null;
  const item = record(value, label);
  if (typeof item.path !== "string" || !item.path || typeof item.content_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.content_hash)) {
    throw new Error(`${label} must bind a path and SHA-256 content hash`);
  }
  return { path: item.path, content_hash: item.content_hash };
}

function extension(path: string): string {
  const value = extname(path).toLowerCase();
  return [".md", ".json", ".txt", ".log"].includes(value) ? value : ".txt";
}

function hashToken(contentHash: string): string { return contentHash.replace(/^sha256:/, ""); }

function durableEvidence(kind: EvidenceReference["kind"], path: string | undefined, commit: string | undefined, id: string | undefined, at: string, writer: string, summary: string, contentHash?: string): EvidenceReference {
  return {
    kind,
    ...(id ? { id } : {}),
    ...(commit ? { commit } : {}),
    ...(path ? { root: "control" as const, path } : {}),
    ...(contentHash ? { content_hash: contentHash } : {}),
    observed_at: at,
    writer,
    summary,
  };
}

function captureSuccessfulMergeEvidence(roots: GarelierControlRoots, controlSchemaVersion: 3, workId: string, sessionId: string, outcome: MergeControlEvidence, at: string): DurableMergeEvidence {
  if (!outcome.commit || !/^[0-9a-f]{40,64}$/.test(outcome.commit)) throw new Error("successful merge evidence requires a full lowercase commit SHA");
  if (!outcome.requestPath) throw new Error("successful merge evidence requires the merge request source");
  if (!outcome.resultPath) throw new Error("successful merge evidence requires the merge-gate result source");
  if (!outcome.reportPath) throw new Error("successful merge evidence requires the role completion report source");

  const request = captureEvidenceSource(roots, outcome.requestPath, "merge request");
  const result = captureEvidenceSource(roots, outcome.resultPath, "merge-gate result");
  const role = captureEvidenceSource(roots, outcome.reportPath, "role completion report");
  const expectedCapture = outcome.expectedSuccessfulCapture;
  if (expectedCapture) {
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedCapture.requestContentHash)
      || !/^sha256:[0-9a-f]{64}$/.test(expectedCapture.resultContentHash)
      || !/^[0-9a-f]{40,64}$/.test(expectedCapture.workbenchTip)) {
      throw new Error("successful merge capture expectation is malformed");
    }
    if (request.contentHash !== expectedCapture.requestContentHash) {
      throw new Error("merge request changed after independent evidence capture");
    }
    if (result.contentHash !== expectedCapture.resultContentHash) {
      throw new Error("merge-gate result changed after independent evidence capture");
    }
  }
  const requestJson = parseJson(request, "merge request");
  const resultJson = parseJson(result, "merge-gate result");
  if (expectedCapture && (requestJson.workbench_tip !== expectedCapture.workbenchTip
    || resultJson.workbench_tip !== expectedCapture.workbenchTip)) {
    throw new Error("merge request/result workbench tip changed after independent evidence capture");
  }
  const requestId = typeof requestJson.request_id === "string" ? requestJson.request_id : "";
  if (!requestId || requestJson.control_schema_version !== controlSchemaVersion || requestJson.work_id !== workId || requestJson.control_session_id !== sessionId) {
    throw new Error(`merge request is not bound to schema-v${controlSchemaVersion} ${workId}/${sessionId}`);
  }
  let reportBindingWarning: string | undefined;
  if (typeof requestJson.role_report_path === "string") {
    const bound = projectRelativePath(roots, requestJson.role_report_path);
    const candidatePaths = [role.path, ...(outcome.reportPathCandidates ?? [])];
    const candidates = candidatePaths.filter((path, index) => candidatePaths.indexOf(path) === index).map((path) => {
      try { return projectRelativePath(roots, path); } catch { return undefined; }
    });
    // W-247: a captured or candidate path exactly matching the merge request's
    // bound role_report_path is the strong (original) proof; if none match
    // (e.g. every candidate moved due to archival) this is not treated as a
    // forged/substituted report — the file content itself is still hashed and
    // sealed as evidence below — but it is recorded as a durable warning rather
    // than silently accepted, so a genuine substitution stays discoverable.
    if (!candidates.includes(bound)) {
      reportBindingWarning = `role report source does not exactly match the merge request binding (bound=${bound ?? "<unresolvable>"}, captured=${role.path})`;
    }
  }
  if (resultJson.request_id !== requestId || resultJson.status !== "success" || resultJson.studio_commit !== outcome.commit) {
    throw new Error(`merge-gate result is not a successful result for commit ${outcome.commit}`);
  }
  if (resultJson.work_id !== workId || resultJson.control_session_id !== sessionId) {
    throw new Error(`merge-gate result is not bound to schema-v${controlSchemaVersion} ${workId}/${sessionId}`);
  }
  const requestedPreflight = stringCommands(requestJson.preflight ?? [], "merge request preflight");
  const requestedGate = stringCommands(requestJson.quality_gate_commands, "merge request quality_gate_commands");
  if (requestJson.gate_mode !== "normal") throw new Error("merge request gate_mode must record the normal requested command path");
  sameCommands(stringCommands(requestJson.requested_preflight_commands, "merge request requested_preflight_commands"), requestedPreflight, "merge request requested_preflight_commands");
  sameCommands(stringCommands(requestJson.requested_quality_gate_commands, "merge request requested_quality_gate_commands"), requestedGate, "merge request requested_quality_gate_commands");
  sameCommands(stringCommands(requestJson.effective_gate_commands, "merge request effective_gate_commands"), requestedGate, "merge request normal effective_gate_commands");
  const resultRequestedPreflight = stringCommands(resultJson.requested_preflight_commands, "merge-gate result requested_preflight_commands");
  const resultRequestedGate = stringCommands(resultJson.requested_quality_gate_commands, "merge-gate result requested_quality_gate_commands");
  sameCommands(resultRequestedPreflight, requestedPreflight, "merge-gate result requested_preflight_commands");
  sameCommands(resultRequestedGate, requestedGate, "merge-gate result requested_quality_gate_commands");
  passingSteps(resultJson.preflight_steps, requestedPreflight, "preflight_steps");
  const gateMode = resultJson.gate_mode;
  if (gateMode !== "normal" && gateMode !== "data_only") throw new Error("merge-gate result gate_mode must be normal or data_only");
  const effectiveGate = stringCommands(resultJson.effective_gate_commands, "merge-gate result effective_gate_commands");
  if (gateMode === "normal") sameCommands(effectiveGate, requestedGate, "normal merge-gate effective commands");
  const executedGate = passingSteps(resultJson.gate_steps, effectiveGate, "gate_steps");
  if (gateMode === "data_only" && !effectiveGate.length) throw new Error("data-only merge-gate result must record explicit DATA_ONLY effective commands");
  const requestConfig = configSource(requestJson.merge_gate_config, "merge request merge_gate_config");
  const resultConfig = configSource(resultJson.merge_gate_config, "merge-gate result merge_gate_config");
  if (requestConfig?.path !== resultConfig?.path || requestConfig?.content_hash !== resultConfig?.content_hash) {
    throw new Error("merge-gate result config/source hash is stale or does not match the request");
  }
  if (!role.source.trim()) throw new Error("role completion report is empty");

  const guardianRequired = requestJson.guardian_required === true;
  const observerRequired = requestJson.observer_required === true;
  if (guardianRequired && !outcome.guardianReportPath) throw new Error("required Guardian report source is missing");
  if (observerRequired && !outcome.observerReportPath) throw new Error("required Observer report source is missing");
  const guardian = outcome.guardianReportPath ? captureEvidenceSource(roots, outcome.guardianReportPath, "Guardian report") : null;
  const observer = outcome.observerReportPath ? captureEvidenceSource(roots, outcome.observerReportPath, "Observer report") : null;
  if (guardian && typeof requestJson.guardian_report_path === "string" && projectRelativePath(roots, requestJson.guardian_report_path) !== guardian.path) {
    throw new Error("Guardian report source does not match the merge request binding");
  }
  if (observer && typeof requestJson.observer_report_path === "string" && projectRelativePath(roots, requestJson.observer_report_path) !== observer.path) {
    throw new Error("Observer report source does not match the merge request binding");
  }
  const bindReview = (role: "guardian" | "observer", source: CapturedEvidenceSource | null, required: boolean): Record<string, unknown> | null => {
    if (!required) return null;
    if (!source) throw new Error(`required ${role} report source is missing`);
    const review = reviewBinding(source.source, `${role} report`);
    const requestedSha = requestJson[`${role}_review_sha`];
    const boundBy = resultJson[`${role}_verdict_bound_by`];
    const resultReviewSha = resultJson[`${role}_review_sha`];
    const resolvedTargetSha = resultJson[`${role}_resolved_target_sha`];
    if (typeof requestedSha !== "string" || !/^[0-9a-f]{40,64}$/.test(requestedSha) || review.reviewSha !== requestedSha) {
      throw new Error(`${role} review_sha does not exactly match the full merge request binding`);
    }
    if (resultReviewSha !== requestedSha || typeof resolvedTargetSha !== "string" || !/^[0-9a-f]{40,64}$/.test(resolvedTargetSha)) {
      throw new Error(`${role} merge result does not bind the requested and resolved full review target SHA`);
    }
    if (boundBy !== "sha" && boundBy !== "tree") throw new Error(`${role} passing verdict is not bound by sha or tree in the merge result`);
    if (boundBy === "sha" && resolvedTargetSha !== requestedSha) throw new Error(`${role} sha-bound verdict does not exactly cover the resolved review target`);
    const binding = { required: true, verdict: review.verdict, review_sha: review.reviewSha, requested_sha: requestedSha, resolved_target_sha: resolvedTargetSha, verdict_bound_by: boundBy, content_hash: source.contentHash };
    return { ...binding, payload_hash: sha256(canonicalJson(binding)) };
  };
  const guardianBinding = bindReview("guardian", guardian, guardianRequired);
  const observerBinding = bindReview("observer", observer, observerRequired);

  const captured = [request, result, role, guardian, observer].filter((item): item is CapturedEvidenceSource => item !== null);
  const totalBytes = captured.reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes > MAX_MERGE_EVIDENCE_TOTAL_BYTES) throw new Error(`merge evidence exceeds ${MAX_MERGE_EVIDENCE_TOTAL_BYTES} total bytes`);

  const gateId = requestId;
  const resultPayloadHash = sha256(canonicalJson(resultJson));
  const gateSource = canonicalJson({
    schema_version: 1,
    control_schema_version: controlSchemaVersion,
    kind: "merge_gate_evidence",
    work_id: workId,
    session_id: sessionId,
    gate_id: gateId,
    status: "pass",
    exit_code: 0,
    commit: outcome.commit,
    observed_at: at,
    executed_at: typeof resultJson.ended_at === "string" ? resultJson.ended_at : at,
    [EVIDENCE_WRITER_STORAGE_KEY]: "garelier-merge-gate",
    summary: `merge request ${requestId} passed`,
    content_hash: result.contentHash,
    request: {
      path: request.path,
      content_hash: request.contentHash,
      payload_hash: sha256(canonicalJson(requestJson)),
      gate_mode: gateMode,
      requested_preflight_commands: requestedPreflight,
      requested_quality_gate_commands: requestedGate,
      effective_gate_commands: effectiveGate,
      config_source: requestConfig,
      payload: requestJson,
    },
    execution: {
      gate_mode: gateMode,
      requested_preflight_commands: resultRequestedPreflight,
      requested_quality_gate_commands: resultRequestedGate,
      effective_gate_commands: executedGate,
      config_source: resultConfig,
      payload_hash: resultPayloadHash,
    },
    reviews: { guardian: guardianBinding, observer: observerBinding },
    source: { root: "project", path: result.path, content_hash: result.contentHash, bytes: result.bytes },
    payload_hash: resultPayloadHash,
    payload: resultJson,
  });
  const gateBytes = Buffer.byteLength(gateSource, "utf8");
  if (gateBytes > MAX_MERGE_EVIDENCE_FILE_BYTES) throw new Error(`durable merge-gate evidence exceeds ${MAX_MERGE_EVIDENCE_FILE_BYTES} bytes`);
  const durableBytes = gateBytes + request.bytes + role.bytes + (guardian?.bytes ?? 0) + (observer?.bytes ?? 0);
  if (durableBytes > MAX_MERGE_EVIDENCE_TOTAL_BYTES) throw new Error(`durable merge evidence exceeds ${MAX_MERGE_EVIDENCE_TOTAL_BYTES} total bytes`);
  const gateHash = sha256(gateSource);
  const gatePath = `reports/gates/${workId}/merge-gate-${hashToken(gateHash)}.json`;
  const requestPath = `reports/merge/${workId}/request-${hashToken(request.contentHash)}.json`;
  const rolePath = `reports/merge/${workId}/role-${hashToken(role.contentHash)}${extension(role.path)}`;
  const writes = [
    { path: gatePath, source: gateSource },
    { path: requestPath, source: request.source },
    { path: rolePath, source: role.source },
  ];
  // W-721 AC-2: the bytes are preserved either way — a template is still what
  // the lane produced, and deleting it would hide that. What changes is the
  // CLAIM: an unfilled template is not a completion report, so it does not
  // enter `evidence_refs` as one. The row then reads as UNCOVERED for role
  // evidence, which is true, instead of carrying a ref whose target says
  // `{{one-line outcome}}`.
  const rolePlaceholders = unfilledRoleReportPlaceholders(role.source);
  const roleIsTemplate = rolePlaceholders.length >= 3;
  const additions: EvidenceReference[] = [
    durableEvidence("commit", undefined, outcome.commit, undefined, at, "garelier-merge-gate", "studio merge commit"),
    durableEvidence("gate", gatePath, outcome.commit, gateId, at, "garelier-merge-gate", "passing durable merge-gate result", gateHash),
    ...(roleIsTemplate ? [] : [durableEvidence("report", rolePath, undefined, undefined, at, "garelier-role", reportBindingWarning ? `durable role completion report (WARNING: ${reportBindingWarning})` : "durable role completion report", role.contentHash)]),
    durableEvidence("path", requestPath, undefined, undefined, at, "garelier-merge-gate", "durable merge request", request.contentHash),
  ];
  if (roleIsTemplate) {
    additions.push(durableEvidence(
      "path", rolePath, undefined, undefined, at, "garelier-role",
      `UNCOVERED: role register is an unfilled template (${rolePlaceholders.length} placeholder token(s): ${rolePlaceholders.slice(0, 4).join(", ")}); preserved, not accepted as a completion report`,
      role.contentHash,
    ));
  }
  const reportPaths = [rolePath];
  if (guardian) {
    const path = `reports/reviews/${workId}/guardian-${hashToken(guardian.contentHash)}${extension(guardian.path)}`;
    writes.push({ path, source: guardian.source });
    additions.push(durableEvidence("report", path, undefined, undefined, at, "garelier-guardian", "durable Guardian report", guardian.contentHash));
    reportPaths.push(path);
  }
  if (observer) {
    const path = `reports/reviews/${workId}/observer-${hashToken(observer.contentHash)}${extension(observer.path)}`;
    writes.push({ path, source: observer.source });
    additions.push(durableEvidence("report", path, undefined, undefined, at, "garelier-observer", "durable Observer report", observer.contentHash));
    reportPaths.push(path);
  }
  return { writes, evidence: additions, reportPaths, gatePath, ...(reportBindingWarning ? { reportBindingWarning } : {}) };
}

const FULL_SHA = /^[0-9a-f]{40,64}$/;

/**
 * W-318/W-472 — durable record for a direct first-parent integration landing
 * that NO merge-gate result covers (manual merge or fast-forward bypass).
 *
 * Deliberately NOT shaped like `captureSuccessfulMergeEvidence`:
 *   - it writes `kind: "merge_gate_bypass_record"` with `status: "bypassed"` and
 *     `gate_satisfied: false`, so nothing reads it as a passing gate;
 *   - it emits NO `kind: "gate"` evidence reference, so `hasMergeControlEvidence`
 *     still answers false and the row keeps demanding a real gate;
 *   - it carries the ancestry facts verbatim, so a later reader can re-derive the
 *     same conclusion from git instead of trusting the record.
 *
 * The role completion report is captured when one exists (it is the only
 * account of what the branch did), but its absence is not fatal — the point of
 * this path is that the gate ritual's artifacts do not exist.
 */
function captureUngatedMergeLanding(roots: GarelierControlRoots, controlSchemaVersion: 3, workId: string, sessionId: string, outcome: MergeControlEvidence, at: string): DurableMergeEvidence {
  const ancestry = outcome.ancestry;
  if (!ancestry) throw new Error("ungated merge landing requires the git first-parent proof");
  if (!outcome.commit || !FULL_SHA.test(outcome.commit)) throw new Error("ungated merge landing requires a full lowercase landing commit SHA");
  if (!FULL_SHA.test(ancestry.branchTip)) throw new Error("ungated merge landing requires a full lowercase branch tip SHA");
  if (!FULL_SHA.test(ancestry.integrationTip)) throw new Error("ungated merge landing requires a full lowercase integration tip SHA");
  if (!ancestry.branch.trim() || !ancestry.integrationBranch.trim()) throw new Error("ungated merge landing requires both branch names");
  if (ancestry.landingKind === "merge-parent" && (!Number.isInteger(ancestry.parentNumber) || ancestry.parentNumber < 2)) {
    throw new Error("ungated merge landing requires a non-first parent number");
  }

  const role = outcome.reportPath && existsSync(isAbsolute(outcome.reportPath) ? outcome.reportPath : resolve(roots.projectRoot, outcome.reportPath))
    ? captureEvidenceSource(roots, outcome.reportPath, "role completion report")
    : null;

  const recordSource = canonicalJson({
    schema_version: 1,
    control_schema_version: controlSchemaVersion,
    kind: "merge_gate_bypass_record",
    work_id: workId,
    session_id: sessionId,
    status: "bypassed",
    gate_satisfied: false,
    commit: outcome.commit,
    observed_at: at,
    [EVIDENCE_WRITER_STORAGE_KEY]: "garelier-first-parent-verifier",
    summary: `${ancestry.branch} landed directly in ${ancestry.integrationBranch} with no merge-gate result bound to ${workId}`,
    verification: {
      method: ancestry.landingKind === "merge-parent"
        ? "git-first-parent-direct-parent"
        : "git-first-parent-commit",
      command: ancestry.landingKind === "merge-parent"
        ? `git rev-list --first-parent --parents ${ancestry.integrationTip}`
        : `git rev-list --first-parent --parents ${ancestry.integrationTip} && git reflog show --format=%H%x00%gs ${ancestry.integrationBranch}`,
      branch: ancestry.branch,
      branch_tip: ancestry.branchTip,
      integration_branch: ancestry.integrationBranch,
      integration_tip: ancestry.integrationTip,
      landing_kind: ancestry.landingKind,
      landing_commit: outcome.commit,
      ...(ancestry.landingKind === "merge-parent"
        ? { direct_parent: ancestry.branchTip, parent_number: ancestry.parentNumber }
        : {
            first_parent_commit: ancestry.branchTip,
            ref_update: {
              destination_ref: ancestry.integrationBranch,
              source_ref: ancestry.branch,
              subject: ancestry.reflogSubject,
            },
          }),
    },
    ...(role ? { role_report: { path: role.path, content_hash: role.contentHash } } : {}),
  });
  const recordBytes = Buffer.byteLength(recordSource, "utf8");
  const totalBytes = recordBytes + (role?.bytes ?? 0);
  if (recordBytes > MAX_MERGE_EVIDENCE_FILE_BYTES) throw new Error(`ungated merge landing record exceeds ${MAX_MERGE_EVIDENCE_FILE_BYTES} bytes`);
  if (totalBytes > MAX_MERGE_EVIDENCE_TOTAL_BYTES) throw new Error(`ungated merge landing evidence exceeds ${MAX_MERGE_EVIDENCE_TOTAL_BYTES} total bytes`);
  const recordHash = sha256(recordSource);
  const recordPath = `reports/gates/${workId}/ungated-merge-${hashToken(recordHash)}.json`;
  const writes = [{ path: recordPath, source: recordSource }];
  const landingLabel = ancestry.landingKind === "merge-parent" ? "merge" : "fast-forward";
  const evidence: EvidenceReference[] = [
    durableEvidence("commit", undefined, outcome.commit, undefined, at, "garelier-first-parent-verifier", `first-parent ${landingLabel} into ${ancestry.integrationBranch} — MERGE GATE BYPASSED`),
    durableEvidence("path", recordPath, outcome.commit, undefined, at, "garelier-first-parent-verifier", "ungated merge landing record (no merge-gate result exists for this merge)", recordHash),
  ];
  const reportPaths: string[] = [];
  if (role) {
    const path = `reports/merge/${workId}/role-${hashToken(role.contentHash)}${extension(role.path)}`;
    writes.push({ path, source: role.source });
    evidence.push(durableEvidence("report", path, undefined, undefined, at, "garelier-role", "durable role completion report", role.contentHash));
    reportPaths.push(path);
  }
  return { writes, evidence, reportPaths, gatePath: recordPath };
}

function evidenceKey(value: EvidenceReference): string {
  return `${value.kind}\0${value.commit ?? ""}\0${value.root ?? ""}\0${value.path ?? ""}`;
}

/** Mustache tokens the scaffolded report/register templates carry. A role
 * report still holding them was never written (W-721). */
const ROLE_REPORT_PLACEHOLDER_RE = /\{\{[^{}\n]{1,80}\}\}/g;

/**
 * Is this "role completion report" the template nobody filled in? (W-721 AC-2)
 *
 * Six rows in a downstream project carried `[[evidence_refs]]` entries summarised as "durable
 * role completion report" whose targets were placeholder text (Scout, 2026-09-05).
 * A hash of a template is a perfectly valid hash, so content-addressed
 * preservation cannot tell the difference — the SUMMARY has to, or a reader
 * following the ref finds `{{one-line outcome}}` where the evidence should be.
 *
 * The predicate is a count, not a single sentinel: a filled report may quote a
 * placeholder while explaining the template, and a template has them
 * everywhere. Three or more surviving tokens is the line, and the caller
 * announces the count rather than deciding silently.
 */
export function unfilledRoleReportPlaceholders(source: string): string[] {
  return [...new Set(source.match(ROLE_REPORT_PLACEHOLDER_RE) ?? [])].sort();
}

export function isUnfilledRoleReport(source: string): boolean {
  return unfilledRoleReportPlaceholders(source).length >= 3;
}

function evidenceLines(evidence: readonly EvidenceReference[]): string[] {
  return evidence.map((item) => {
    const target = item.path ? `\`${item.path}\`` : item.commit ? `\`${item.commit}\`` : item.id ? `\`${item.id}\`` : "-";
    return `- ${item.kind}: ${target} — ${item.summary}`;
  });
}

/**
 * The `## Evidence` body a landed row should end up with: what the producer
 * wrote, PLUS the refs this land is adding (W-724).
 *
 * This used to be `evidenceLines(...).join("\n")` handed to `planBacklogUpdate`'s
 * `evidence` option, which REPLACES the whole section. The #464 land measured
 * the cost: 45 lines of producer-authored evidence on W-709 were replaced by
 * the 6 summary lines below, and the PM restored them by hand from HEAD.
 * Deleting evidence is a producer/PM act; a land only adds.
 *
 * `appendEvidenceLines` already drops the `- None recorded.` placeholder, so a
 * row that never had a body still ends with just the refs. Lines already
 * present are not re-added, which makes re-running the same land a no-op on
 * this section — each ref renders one deterministic line carrying its path or
 * commit, so an identical line is the same reference.
 */
export function mergedEvidenceBody(existing: string, evidence: readonly EvidenceReference[]): string {
  const priorLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const additions = evidenceLines(evidence).filter((line) => !priorLines.has(line.trim()));
  return appendEvidenceLines(existing, additions);
}

function planGraphReportReferences(work: BacklogRecord): string[] {
  const value = work.frontmatter.report_refs;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Backlog ${work.id} report_refs must be an array of paths`);
  }
  return value as string[];
}

export interface ControlSettlementWrite {
  path: string;
  digest: string;
  authority: string;
}

/** Why one generated Control write was not authenticated (W-843 AC-3).
 *
 * `invalid_record` is a CONTENT defect of the write or of the generator's own
 * record (wrong identity, digest, shape). `unresolved_path` is a failure to
 * resolve the write to a location inside Control, and `unreadable` is an I/O
 * failure while capturing its bytes. Keeping the three apart is what lets a
 * skip line say which of them happened: before W-843 a path that could not be
 * resolved was reported as a content defect. */
export type GeneratedControlWriteRefusalReason = "invalid_record" | "unresolved_path" | "unreadable";

export class GeneratedControlWriteRefusal extends Error {
  constructor(readonly reason: GeneratedControlWriteRefusalReason, message: string) {
    super(message);
    this.name = "GeneratedControlWriteRefusal";
  }
}

/** Generators that run for one land request outside the main plan-graph
 * transaction and write into Control. Each returns its writes with path +
 * digest provenance; the settlement authenticates a write only against the
 * generator its authority names. An authority naming any other generator is
 * refused — a new generator is added here, never through a path allowlist. */
export const CLAIM_RENEWAL_GENERATOR = "claim-renewal";
export const AFTERCARE_PRESERVATION_GENERATOR = "aftercare-preservation";

export function generatedControlWriteAuthority(generator: string, requestId: string): string {
  return `generated:${generator}:${requestId}`;
}

const SETTLEMENT_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The aftercare's return value for the settlement: every Control path its
 * evidence preservation published for this request, with the digest of the
 * exact bytes it published. aftercare runs in `dispatch_cleanup`, a separate
 * process from `merge_land`, so the return is a request-bound runtime record
 * rather than an in-memory value (the claim renewal generator's in-process
 * return has the same fields). */
export interface AftercarePreservationPublication {
  schema_version: 1;
  kind: "garelier_aftercare_preservation_publication";
  request_id: string;
  work_id: string | null;
  control_session_id: string | null;
  dispatch_id: string | null;
  writes: Array<{ path: string; digest: string }>;
}

export function aftercarePreservationPublicationPath(roots: GarelierControlRoots, requestId: string): string {
  if (!SETTLEMENT_REQUEST_ID_RE.test(requestId)) throw new Error(`request_id contains unsafe path characters: ${requestId}`);
  return join(roots.projectRoot, "__garelier", roots.pmId, "runtime", "land_aftercare", "preservation_publications", `${requestId}.json`);
}

/** Null when this request's aftercare published nothing into Control. */
export function readAftercarePreservationPublication(
  roots: GarelierControlRoots,
  requestId: string,
): AftercarePreservationPublication | null {
  const path = aftercarePreservationPublicationPath(roots, requestId);
  if (!existsSync(path)) return null;
  let source: string;
  try {
    assertNoSymlinkPath(roots.projectRoot, path);
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new GeneratedControlWriteRefusal("unreadable", `aftercare preservation publication record is unreadable: ${(error as Error).message}`);
  }
  const malformed = (detail: string): never => {
    throw new GeneratedControlWriteRefusal("invalid_record", `aftercare preservation publication record is malformed (${detail}): ${path.replaceAll("\\", "/")}`);
  };
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(source), "aftercare preservation publication"); }
  catch { return malformed("not a JSON object"); }
  const optional = (field: string): string | null => {
    const item = value[field];
    if (item === null) return null;
    if (typeof item !== "string" || !item) return malformed(field);
    return item;
  };
  if (value.schema_version !== 1 || value.kind !== "garelier_aftercare_preservation_publication") malformed("kind");
  if (value.request_id !== requestId) malformed("request_id");
  if (!Array.isArray(value.writes)) return malformed("writes");
  const seen = new Set<string>();
  const writes = value.writes.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return malformed(`writes[${index}]`);
    const item = entry as Record<string, unknown>;
    // The path is NOT shape-checked here: resolving it is the settlement's
    // job, and a path that does not resolve is `unresolved_path` for that
    // entry, not a defect of every other entry the generator returned.
    if (typeof item.path !== "string" || !item.path || typeof item.digest !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(item.digest) || seen.has(item.path)) {
      return malformed(`writes[${index}]`);
    }
    seen.add(item.path);
    return { path: item.path, digest: item.digest };
  });
  return {
    schema_version: 1,
    kind: "garelier_aftercare_preservation_publication",
    request_id: requestId,
    work_id: optional("work_id"),
    control_session_id: optional("control_session_id"),
    dispatch_id: optional("dispatch_id"),
    writes,
  };
}

/** Record what aftercare preservation published. Idempotent and additive: a
 * crash replay or a gate-recovery replan of the same request publishes the
 * same leaves again, and every leaf it has ever published for this request is
 * still in Control and still needs the settlement. A leaf may never change
 * digest — publication itself already refuses to overwrite different bytes. */
export function recordAftercarePreservationPublication(options: {
  roots: GarelierControlRoots;
  requestId: string;
  workId: string | null;
  sessionId: string | null;
  dispatchId: string | null;
  writes: ReadonlyArray<{ path: string; digest: string }>;
}): void {
  const path = aftercarePreservationPublicationPath(options.roots, options.requestId);
  const existing = readAftercarePreservationPublication(options.roots, options.requestId);
  if (existing && (existing.work_id !== options.workId || existing.control_session_id !== options.sessionId
    || existing.dispatch_id !== options.dispatchId)) {
    throw new Error(`aftercare preservation publication record identity conflicts: ${path}`);
  }
  const merged = new Map((existing?.writes ?? []).map((write) => [write.path, write.digest]));
  for (const write of options.writes) {
    const previous = merged.get(write.path);
    if (previous !== undefined && previous !== write.digest) {
      throw new Error(`aftercare preservation publication digest changed for ${write.path}: ${path}`);
    }
    merged.set(write.path, write.digest);
  }
  const next: AftercarePreservationPublication = {
    schema_version: 1,
    kind: "garelier_aftercare_preservation_publication",
    request_id: options.requestId,
    work_id: options.workId,
    control_session_id: options.sessionId,
    dispatch_id: options.dispatchId,
    writes: [...merged].map(([writePath, digest]) => ({ path: writePath, digest }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  if (existing && canonicalJson(existing) === canonicalJson(next)) return;
  atomicWriteRuntimeFile(join(options.roots.projectRoot, "__garelier", options.roots.pmId, "runtime"), path, `${canonicalJson(next)}\n`);
}

/** Authenticate one generated write against the generator its authority
 * names. Throws `GeneratedControlWriteRefusal` whose reason separates a
 * content defect from a path/I-O failure. */
export function validateGeneratedControlSettlementWrite(options: {
  roots: GarelierControlRoots;
  workId: string;
  sessionId: string;
  requestId: string;
  write: ControlSettlementWrite;
}): ControlSettlementWrite {
  const generator = [CLAIM_RENEWAL_GENERATOR, AFTERCARE_PRESERVATION_GENERATOR]
    .find((candidate) => options.write.authority === generatedControlWriteAuthority(candidate, options.requestId));
  if (!generator) {
    throw new GeneratedControlWriteRefusal("invalid_record", `merge Control settlement generated-write authority is invalid: ${options.write.path}`);
  }
  const absolute = resolve(options.roots.controlRoot, ...options.write.path.split("/"));
  const relativePath = relative(options.roots.controlRoot, absolute).replaceAll("\\", "/");
  if (relativePath !== options.write.path || !relativePath || relativePath === ".."
    || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new GeneratedControlWriteRefusal("unresolved_path", `merge Control settlement generated write is unsafe: ${options.write.path}`);
  }
  let captured: CapturedEvidenceSource;
  try {
    captured = captureEvidenceSource(options.roots, absolute, "merge Control settlement generated write");
  } catch (error) {
    throw new GeneratedControlWriteRefusal("unreadable", (error as Error).message);
  }
  const expectedProjectPath = relative(options.roots.projectRoot, absolute).replaceAll("\\", "/");
  if (captured.path !== expectedProjectPath) {
    throw new GeneratedControlWriteRefusal("unresolved_path", `merge Control settlement generated-write path changed during capture: ${options.write.path}`);
  }
  if (captured.contentHash !== options.write.digest) {
    throw new GeneratedControlWriteRefusal("invalid_record", `merge Control settlement generated-write digest is invalid: ${options.write.path}`);
  }
  if (generator === CLAIM_RENEWAL_GENERATOR) {
    const expectedPrefix = `reports/claim_renewals/${options.workId}/`;
    if (!options.write.path.startsWith(expectedPrefix)
      || `${captured.contentHash.replace(/^sha256:/, "")}.json` !== options.write.path.slice(expectedPrefix.length)) {
      throw new GeneratedControlWriteRefusal("invalid_record", `merge Control settlement generated-write digest is invalid: ${options.write.path}`);
    }
    const renewal = readClaimRenewalAuthorizationRecord(captured.source);
    if (!renewal || renewal.work_id !== options.workId
      || renewal.session_id !== options.sessionId
      || renewal.source !== "merge-settlement"
      || renewal.request_id !== options.requestId) {
      throw new GeneratedControlWriteRefusal("invalid_record", `merge Control settlement generated-write identity is invalid: ${options.write.path}`);
    }
    return { ...options.write };
  }
  const publication = readAftercarePreservationPublication(options.roots, options.requestId);
  if (!publication || publication.work_id !== options.workId || publication.control_session_id !== options.sessionId
    || !publication.writes.some((entry) => entry.path === options.write.path && entry.digest === options.write.digest)) {
    throw new GeneratedControlWriteRefusal("invalid_record", `merge Control settlement generated write was not published by this request's aftercare: ${options.write.path}`);
  }
  return { ...options.write };
}

export function recordMergeControlOutcome(options: {
  roots: GarelierControlRoots;
  workId: string;
  sessionId: string;
  outcome: MergeControlEvidence;
  now?: () => Date;
  namespaceLock?: NamespaceLock;
  // W-247: when false, permits recording already-independently-confirmed merge
  // evidence (success / W-318 ungated outcomes only) even when the bound claim's
  // TTL has elapsed or the claim record itself is gone — the normal in-flight
  // merge_gate.ts recording path always uses the strict default (true). A
  // caller may only set this after establishing durable proof the merge
  // actually landed (e.g. dispatch_cleanup.ts's mergeStatus check) — a claim
  // still held by a DIFFERENT session is always refused, live or not.
  requireLiveClaim?: boolean;
  /** Authority revision authenticated before the gate (or by an accepted
   * post-verdict rebind). Unlike the runtime claim, this baseline survives a
   * missing or replaced claim record. */
  expectedAuthorityRevision?: number;
  /** Exact writes returned by generators that ran for this merge request
   * outside the main plan-graph transaction. */
  generatedControlWrites?: readonly ControlSettlementWrite[];
}): {
  status: "committed" | "dry_run";
  state: string;
  released: boolean;
  settlement_write_set: ControlSettlementWrite[];
  report_binding_warning?: string;
} {
  const isSuccess = options.outcome.status === "success";
  // W-318/W-472: a first-parent-proved landing with no gate behind it. It records durable
  // evidence and releases the claim like a success, but never transitions the row
  // to verification and never writes passing gate evidence.
  const isUngated = options.outcome.status === "ungated";
  const requireLiveClaim = options.requireLiveClaim !== false;
  if (options.expectedAuthorityRevision !== undefined
    && (!Number.isSafeInteger(options.expectedAuthorityRevision) || options.expectedAuthorityRevision < 1)) {
    throw new Error("merge control outcome expected authority revision must be a positive integer");
  }
  const paths = namespace(options.roots);
  const schema = garelierControlSchema(options.roots.projectRoot, options.roots.pmId);
  if (schema !== 3) throw new Error(`merge control outcome requires Control schema 3, found ${schema ?? "none"}`);
  const generatedControlWrites = options.generatedControlWrites ?? [];
  const generatedRequestId = generatedControlWrites.length > 0 && typeof options.outcome.requestPath === "string"
    ? String((JSON.parse(readFileSync(options.outcome.requestPath, "utf8")) as Record<string, unknown>).request_id ?? "")
    : "";
  const generatedSettlementWrites = generatedControlWrites.map((write) => {
    if (!generatedRequestId) throw new Error("merge Control settlement generated writes require a bound merge request");
    return validateGeneratedControlSettlementWrite({
      roots: options.roots,
      workId: options.workId,
      sessionId: options.sessionId,
      requestId: generatedRequestId,
      write,
    });
  });
  let reportBindingWarning: string | undefined;
  const result = runControlFilePlanTransaction({
    targetRoot: options.roots.targetRoot,
    pmId: options.roots.pmId,
    controlRoot: options.roots.controlRoot,
    runtimeRoot: options.roots.runtimeRoot,
    agent: "garelier-merge-gate",
    sessionId: options.sessionId,
    command: isSuccess ? "merge-evidence" : "merge-abort",
    now: options.now,
    namespaceLock: options.namespaceLock,
    callbacks: planGraphTransactionCallbacks,
    mutate: ({ state: model, now }) => {
      const work = model.backlog.get(options.workId);
      if (!work) throw new Error(`merge-bound Backlog does not exist: ${options.workId}`);
      if (["done", "cancelled", "superseded"].includes(work.status)) throw new Error(`merge-bound Backlog is closed: ${options.workId} (${work.status})`);
      const claim = readControlClaim(paths, options.workId);
      if (requireLiveClaim && !claim) throw new Error(`merge-bound Backlog has no active claim: ${options.workId}`);
      const revision = planGraphEntityRevision(work);
      if (options.expectedAuthorityRevision !== undefined && revision !== options.expectedAuthorityRevision) {
        throw new Error(
          `reviewed Work authority changed during merge gate: ${options.workId} `
          + `(expected=${options.expectedAuthorityRevision}, current=${revision})`,
        );
      }
      if (claim) {
        if (claim.session_id !== options.sessionId) throw new Error(`merge-bound Backlog claim belongs to another session: ${claim.session_id}`);
        if (claim.entity_revision !== revision) throw new Error(`merge-bound Backlog claim revision ${claim.entity_revision} does not match Backlog revision ${revision}`);
        if (requireLiveClaim && !claimHasLiveMergeReservation(claim, Date.parse(now))
          && Date.parse(claim.expires_at) <= Date.parse(now)) {
          throw new Error(`merge-bound Backlog claim expired at ${claim.expires_at}`);
        }
      }
      const durable = isSuccess
        ? captureSuccessfulMergeEvidence(options.roots, 3, options.workId, options.sessionId, options.outcome, now)
        : isUngated ? captureUngatedMergeLanding(options.roots, 3, options.workId, options.sessionId, options.outcome, now) : null;
      if (durable?.reportBindingWarning) reportBindingWarning = durable.reportBindingWarning;
      const known = new Set(planGraphEvidenceReferences(work).map(evidenceKey));
      const evidence = [...planGraphEvidenceReferences(work), ...(durable?.evidence ?? []).filter((item) => !known.has(evidenceKey(item)))];
      let updated = work;
      let transitionSummary = work.status;
      if (isSuccess && work.status === "active") {
        const transition = planLifecycleV3Transition({
          path: work.path,
          record: work,
          to: "verification",
          now,
          adapter: planGraphRecordAdapter,
        });
        const source = transition.writes[0]?.source;
        if (!source) throw new Error(`schema-3 merge transition did not produce Backlog source for ${work.id}`);
        updated = { ...work, source, status: "verification", updated: now };
        transitionSummary = "verification";
      }
      const nextAction = isSuccess
        ? updated.status === "verification"
          ? "Verify acceptance and required runtime evidence; close only after every criterion passes."
          : `Merge landed; transition ${work.id} to active/verification after resolving its current ${work.status} state.`
        : isUngated
          ? `Merge landed WITHOUT a merge gate (${options.outcome.commit}); ${work.id} keeps status ${work.status}. Run the required gate against the landed tree, or record an explicit ruling that waives it, before closing.`
          : `Resume after merge ${options.outcome.status}: ${options.outcome.failureReason || "inspect merge-gate result and retry"}`;
      const backlogPlan = planBacklogUpdate({
        record: updated,
        now,
        currentPosition: isSuccess
          ? `Merge ${options.outcome.commit} passed its bound gate and is awaiting verification.`
          : isUngated
            ? `Merge ${options.outcome.commit} landed on ${options.outcome.ancestry?.integrationBranch ?? "the integration branch"} with NO merge gate behind it (first-parent landing verified, W-472). Canonical status remains ${work.status}.`
            : `Merge ${options.outcome.status}; canonical status remains ${work.status}.`,
        exactNextAction: nextAction,
        ...(durable ? {
          evidence: mergedEvidenceBody(updated.evidence, evidence),
          evidenceRefs: evidence,
          reportRefs: [...planGraphReportReferences(work), ...durable.reportPaths],
        } : {}),
      });
      return {
        writes: [...(durable?.writes ?? []), ...backlogPlan.writes],
        entity: options.workId,
        summary: `${options.outcome.status} -> ${transitionSummary}`,
      };
    },
  });
  let released = false;
  try {
    released = releaseClaim({
      targetRoot: options.roots.targetRoot,
      pmId: options.roots.pmId,
      controlRoot: options.roots.controlRoot,
      runtimeRoot: options.roots.runtimeRoot,
      workId: options.workId,
      sessionId: options.sessionId,
      now: options.now,
      namespaceLock: options.namespaceLock,
      runtimeCallbacks: planGraphRuntimeCallbacks,
    });
  } catch (error) {
    if (!String((error as Error).message).includes("another session")) throw error;
  }
  const settledModel = loadPlanGraphModel(options.roots.controlRoot);
  const settledWork = settledModel.backlog.get(options.workId);
  const evidence = settledWork ? planGraphEvidenceReferences(settledWork) : [];
  const settlementWriteSet = result.changes.map((change): ControlSettlementWrite => {
    if (change.after === null) throw new Error(`merge Control settlement cannot authorize a deletion: ${change.path}`);
    const digest = change.after;
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`merge Control transaction returned an invalid content digest: ${change.path}`);
    }
    if (settledWork && change.path === settledWork.path) {
      return { path: change.path, digest, authority: `work:${options.workId}` };
    }
    const reference = evidence.find((item) => item.root === "control" && item.path === change.path);
    if (!reference?.content_hash || reference.content_hash !== digest) {
      throw new Error(`merge Control transaction wrote an unreferenced or digest-mismatched path: ${change.path}`);
    }
    return { path: change.path, digest, authority: `evidence:${reference.kind}` };
  });
  settlementWriteSet.push(...generatedSettlementWrites);
  settlementWriteSet.sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 1; index < settlementWriteSet.length; index++) {
    if (settlementWriteSet[index - 1]!.path === settlementWriteSet[index]!.path) {
      throw new Error(`merge Control settlement write set repeats path: ${settlementWriteSet[index]!.path}`);
    }
  }
  const state = settledWork?.status;
  return {
    status: result.status,
    state: state ?? "missing",
    released,
    settlement_write_set: settlementWriteSet,
    ...(reportBindingWarning ? { report_binding_warning: reportBindingWarning } : {}),
  };
}

export function releaseDispatchControlClaim(roots: GarelierControlRoots, workId: string, sessionId: string, namespaceLock?: NamespaceLock): boolean {
  const schema = garelierControlSchema(roots.projectRoot, roots.pmId);
  if (schema !== 3) throw new Error(`control claim release requires schema_version 3, found ${schema ?? "none"}`);
  return releaseClaim({ targetRoot: roots.targetRoot, pmId: roots.pmId, controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot, workId, sessionId, namespaceLock, runtimeCallbacks: planGraphRuntimeCallbacks });
}

export function hasMergeControlEvidence(roots: GarelierControlRoots, workId: string, commit: string, resultPath: string): boolean {
  return readStableControl({ controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot }, () => {
  const schema = garelierControlSchema(roots.projectRoot, roots.pmId);
  if (schema !== 3) return false;
  const model = loadPlanGraphModel(roots.controlRoot);
  const work = model.backlog.get(workId);
  if (!work) return false;
  const normalizedResult = projectRelativePath(roots, resultPath);
  const evidence = planGraphEvidenceReferences(work);
  const gate = evidence.find((item) => item.kind === "gate" && item.commit === commit && item.root === "control" && item.path);
  if (!gate?.path || !normalizedResult) return false;
  try {
    if (validateGateEvidence({ targetRoot: roots.targetRoot, controlRoot: roots.controlRoot }, workId, gate).length) return false;
    const source = readFileSync(join(roots.controlRoot, ...gate.path.split("/")), "utf8");
    if (gate.content_hash && sha256(source) !== gate.content_hash) return false;
    const value = record(JSON.parse(source), "durable merge-gate evidence");
    const origin = record(value.source, "durable merge-gate evidence source");
    return value.status === "pass" && value.exit_code === 0 && value.commit === commit && origin.path === normalizedResult
      && evidence.some((item) => item.kind === "commit" && item.commit === commit);
  } catch { return false; }
  });
}
