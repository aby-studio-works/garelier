import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { claimWork, readControlClaim, refreshClaimEntityRevision, releaseClaim, type ClaimTouchConflict, type ControlClaimRecord } from "./claims.ts";
import { assertNoSymlinkPath } from "./diagnostics.ts";
import { loadPlanGraphModel } from "./plan_graph_model.ts";
import type { BacklogRecord, CheckpointRecord, PlanGraphControlModel } from "./plan_graph_types.ts";
import {
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
import { renewDispatchClaimWithAudit } from "./claim_renewal_audit.ts";

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
  /** Merge-land recovery may take over an expired foreign claim using the
   * dispatch-bound session. Ordinary dispatch creation remains non-stealing. */
  stealStale?: boolean;
  now?: () => Date;
  namespaceLock?: NamespaceLock;
}): DispatchControlBinding {
  let inspected = inspectDispatchControlBinding(options.roots, options.workId, options.sessionId, options.namespaceLock);
  const now = options.now?.() ?? new Date();
  const dispatchClock = () => now;
  let state = inspected.work.status;
  const entityLabel = "Backlog";
  const allowedStates = options.mergeBound ? ["active", "verification"] : ["ready", "active", "verification"];
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
    });
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
    steal: options.stealStale === true
      && inspected.claim !== null
      && inspected.claim.session_id !== options.sessionId,
    reason: options.stealStale === true
      && inspected.claim !== null
      && inspected.claim.session_id !== options.sessionId
      ? `merge_land recovery for dispatch ${options.dispatchId ?? "unknown"}`
      : undefined,
    now: dispatchClock,
    namespaceLock: options.namespaceLock,
    runtimeCallbacks: planGraphRuntimeCallbacks,
  });
  let finalRevision = planGraphEntityRevision(inspected.work);
  if (!options.mergeBound && (state === "ready" || state === "verification")) {
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
  const additions: EvidenceReference[] = [
    durableEvidence("commit", undefined, outcome.commit, undefined, at, "garelier-merge-gate", "studio merge commit"),
    durableEvidence("gate", gatePath, outcome.commit, gateId, at, "garelier-merge-gate", "passing durable merge-gate result", gateHash),
    durableEvidence("report", rolePath, undefined, undefined, at, "garelier-role", reportBindingWarning ? `durable role completion report (WARNING: ${reportBindingWarning})` : "durable role completion report", role.contentHash),
    durableEvidence("path", requestPath, undefined, undefined, at, "garelier-merge-gate", "durable merge request", request.contentHash),
  ];
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

function evidenceMarkdown(evidence: readonly EvidenceReference[]): string {
  return evidence.map((item) => {
    const target = item.path ? `\`${item.path}\`` : item.commit ? `\`${item.commit}\`` : item.id ? `\`${item.id}\`` : "-";
    return `- ${item.kind}: ${target} — ${item.summary}`;
  }).join("\n") || "- None recorded.";
}

function planGraphReportReferences(work: BacklogRecord): string[] {
  const value = work.frontmatter.report_refs;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Backlog ${work.id} report_refs must be an array of paths`);
  }
  return value as string[];
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
}): { status: "committed" | "dry_run"; state: string; released: boolean; report_binding_warning?: string } {
  const isSuccess = options.outcome.status === "success";
  // W-318/W-472: a first-parent-proved landing with no gate behind it. It records durable
  // evidence and releases the claim like a success, but never transitions the row
  // to verification and never writes passing gate evidence.
  const isUngated = options.outcome.status === "ungated";
  const requireLiveClaim = options.requireLiveClaim !== false;
  const paths = namespace(options.roots);
  const schema = garelierControlSchema(options.roots.projectRoot, options.roots.pmId);
  if (schema !== 3) throw new Error(`merge control outcome requires Control schema 3, found ${schema ?? "none"}`);
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
      if (requireLiveClaim) {
        if (!claim) throw new Error(`merge-bound Backlog has no active claim: ${options.workId}`);
        if (claim.session_id !== options.sessionId) throw new Error(`merge-bound Backlog claim belongs to another session: ${claim.session_id}`);
        if (Date.parse(claim.expires_at) <= Date.parse(now)) throw new Error(`merge-bound Backlog claim expired at ${claim.expires_at}`);
        const revision = planGraphEntityRevision(work);
        if (claim.entity_revision !== revision) throw new Error(`merge-bound Backlog claim revision ${claim.entity_revision} does not match Backlog revision ${revision}`);
      } else if (claim && claim.session_id !== options.sessionId) {
        throw new Error(`merge-bound Backlog claim belongs to another session: ${claim.session_id}`);
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
          evidence: evidenceMarkdown(evidence),
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
  const state = loadPlanGraphModel(options.roots.controlRoot).backlog.get(options.workId)?.status;
  return { status: result.status, state: state ?? "missing", released, ...(reportBindingWarning ? { report_binding_warning: reportBindingWarning } : {}) };
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
