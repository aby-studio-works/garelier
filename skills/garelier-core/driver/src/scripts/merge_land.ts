import { rmSync } from "../guard/path_guard.ts";
// merge_land — one background command for the whole PM merge ritual (W-088, TS port W-083).
//
// Faithful port of merge_land.ts. Composition macro over the individually-tested
// sibling scripts (merge_request.ts / gate_result_waiter.ts / dispatch_cleanup.ts /
// merge_request_id_recover.ts) and dock_merge.ts — it adds NO merge/gate logic of
// its own. CLI / stdout JSON / stderr / exit codes / generated-file behavior are
// frozen to the bash original (W-083 §3).
//
// Sibling TypeScript entrypoints resolve relative to this module (or an injected
// test entry directory), while dock_merge + lint_commits resolve from the core
// root. This preserves the relocated W-055 fixture without a shell trampoline.
// The verdict marker parser reuses
// merge_gate_parse.extractVerdict directly.

import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { extractVerdict } from "../merge_gate_parse.ts";
import { dispatchContainer } from "../workspace.ts";
import { resolveCommand } from "./_lib.ts";
import { MERGE_LAND_FLAGS, MERGE_REQUEST_FLAGS, OTHER_TOOL_FLAG_OWNERS } from "./cli_flag_ownership.ts";
import { finalizeLongMergeEvidence } from "../control/landing_finalize.ts";
import {
  acquireGarelierOperationGuard,
  AFTERCARE_PRESERVATION_GENERATOR,
  aftercarePreservationPublicationPath,
  captureEvidenceSource,
  CLAIM_RENEWAL_GENERATOR,
  claimDispatchControlWork,
  garelierControlRoots,
  garelierControlSchema,
  GeneratedControlWriteRefusal,
  generatedControlWriteAuthority,
  hasMergeControlEvidence,
  inspectDispatchControlBinding,
  readAftercarePreservationPublication,
  validateGeneratedControlSettlementWrite,
  type ControlSettlementWrite,
  type GarelierOperationGuard,
  type GeneratedControlWriteRefusalReason,
} from "../control/garelier_integration.ts";
import { atomicWriteRuntimeFile } from "../control/diagnostics.ts";
import { canonicalJson, sha256 } from "../control/serialization.ts";
import { inspectControlReportRetention } from "../control/report_retention.ts";
import { CONTROL_TREE_DEFAULT_LIMITS, inspectControlTree } from "../control/transaction.ts";
import { readClaimRenewalAuthorizationRecord, rollbackDispatchClaimReservation, type DispatchClaimReservation } from "../control/claim_renewal_audit.ts";
import { assertClaimControlBinding, claimHasLiveMergeReservation, readControlClaim } from "../control/claims.ts";
import { resolveControlNamespace } from "../control/transaction.ts";
import { assertSessionControlBinding, loadRuntimeControlSnapshot, readRuntimeSessions } from "../control/sessions.ts";
import { planGraphEntityRevision } from "../control/plan_graph_write.ts";
import { planGraphEvidenceReferences, planGraphRuntimeCallbacks } from "../control/plan_graph_write.ts";
import { loadPlanGraphModel } from "../control/plan_graph_model.ts";
import { assertChokepointAllowed } from "../integration_closure.ts";
import { loadConfig } from "../config.ts";
import { assertBoundRoleQualityGateSelection, dispatchExecutionIdentity, roleBindingFromContext } from "../dispatch/role_binding.ts";

// Resolve a dispatch's checkout + context.json through the shared canonical
// workspace resolver.
export function dispatchPaths(project: string, pm: string, id: string): { container: string; checkout: string; context: string } {
  const container = dispatchContainer(project, pm, id);
  return { container, checkout: `${container}/checkout`, context: `${container}/context.json` };
}

export interface MergeLandControlBinding {
  schema: number | null;
  workId: string;
  sessionId: string;
  reportPath: string;
  workRevision: number;
  generatedControlWrites: ControlSettlementWrite[];
  mergeReservation?: DispatchClaimReservation;
}

interface MergeLandAuthorityRefresh {
  previousRevision: number;
  currentRevision: number;
  evidencePath: string;
  evidenceHash: string;
}

// Schema 3 binds a merge to the dispatch context's canonical Backlog/session. The
// caller may repeat the values explicitly, but may not contradict the context.
// Loading the Work through the shared model also proves the canonical record is
// present and structurally valid before merge_request writes anything.
export function resolveMergeLandControlBinding(options: {
  project: string; targetRoot: string; pmId: string; dispatchId?: string;
  workId?: string; sessionId?: string; reportPath?: string;
  ensureClaim?: boolean;
  requireClaim?: boolean;
  allowMergeReady?: boolean;
  deferMutation?: boolean;
  mergeReservationUntil?: Date;
  expectedAuthorityRevision?: number;
  validateAuthorityRefresh?: boolean;
  authorityRefresh?: MergeLandAuthorityRefresh;
  settlementRequestId?: string;
  guard?: GarelierOperationGuard;
}): MergeLandControlBinding {
  const schema = options.guard?.schema ?? garelierControlSchema(options.project, options.pmId);
  if (schema !== 3) throw new Error(`unsupported control schema_version ${schema ?? "missing"}; only schema_version 3 is accepted`);
  let contextWork = "", contextSession = "", container = "";
  let touches: string[] = [];
  if (options.dispatchId) {
    const paths = dispatchPaths(options.project, options.pmId, options.dispatchId);
    container = paths.container;
    if (!existsSync(paths.context)) throw new Error(`schema-v${schema} dispatch context is missing: ${paths.context}`);
    const context = JSON.parse(readFileSync(paths.context, "utf8")) as {
      control?: { work_id?: unknown; session_id?: unknown };
      task?: { touches?: unknown };
    };
    contextWork = typeof context.control?.work_id === "string" ? context.control.work_id : "";
    contextSession = typeof context.control?.session_id === "string" ? context.control.session_id : "";
    touches = Array.isArray(context.task?.touches)
      ? context.task.touches.filter((item): item is string => typeof item === "string")
      : [];
  }
  const workId = options.workId || contextWork;
  const sessionId = options.sessionId || contextSession;
  if (options.workId && contextWork && options.workId !== contextWork) throw new Error(`--work-id ${options.workId} contradicts dispatch context Work ${contextWork}`);
  if (options.sessionId && contextSession && options.sessionId !== contextSession) throw new Error(`--control-session ${options.sessionId} contradicts dispatch context session ${contextSession}`);
  if (!workId || !sessionId) throw new Error(`schema v${schema} requires a canonical Work/Backlog session binding (pass --dispatch-id or --work-id + --control-session)`);
  const roots = garelierControlRoots(options.project, options.targetRoot, options.pmId);
  const before = inspectDispatchControlBinding(roots, workId, sessionId, options.guard?.lock);
  const beforeRevision = planGraphEntityRevision(before.work);
  if (options.expectedAuthorityRevision !== undefined && beforeRevision !== options.expectedAuthorityRevision) {
    throw new Error(
      `reviewed Work authority changed during merge gate: ${workId} `
      + `(expected=${options.expectedAuthorityRevision}, current=${beforeRevision})`,
    );
  }
  // The preliminary check precedes verdict validation and is strictly
  // read-only. If the claim is absent, the post-verdict reservation call may
  // re-take it only against the independently captured Work revision above.
  const preliminaryValidation = options.deferMutation === true && options.mergeReservationUntil === undefined;
  const claimed = options.ensureClaim && !(preliminaryValidation && !before.claim)
    ? claimDispatchControlWork({
      roots,
      workId,
      sessionId,
      touches,
      dispatchId: options.dispatchId,
      mergeBound: true,
      allowMergeReady: options.allowMergeReady,
      deferMutation: options.deferMutation,
      mergeReservationUntil: options.mergeReservationUntil,
      authorityRefresh: options.authorityRefresh,
      validateAuthorityRefresh: options.validateAuthorityRefresh,
      settlementRequestId: options.settlementRequestId,
      namespaceLock: options.guard?.lock,
    })
    : null;
  const binding = inspectDispatchControlBinding(roots, workId, sessionId, options.guard?.lock);
  // W-318: this used to be a dead end. The claim can legitimately be gone (a PM
  // released it, or it was GC'd) while the dispatch container is still live and
  // still bound to the same Work/session, and re-taking it is a single command —
  // the dispatch's own reservation no longer blocks the claim it exists for. Name
  // that command instead of leaving the operator to rediscover it.
  if (options.requireClaim !== false && !binding.claim) {
    throw new Error(
      `schema-v${schema} Work/Backlog ${workId} has no active dispatch claim. ` +
      `Re-take it and re-run: garelier control claim ${workId} --session ${sessionId} --touches <the dispatch's touches>` +
      `${options.dispatchId ? ` (its own dispatch #${options.dispatchId} does not conflict with this claim)` : ""}.`,
    );
  }
  if (binding.claim && binding.claim.session_id !== sessionId) throw new Error(`schema-v${schema} Work/Backlog ${workId} claim belongs to ${binding.claim.session_id}, not ${sessionId}`);
  const reportPath = options.reportPath || (container ? `${container}/report.md` : "");
  return {
    schema,
    workId,
    sessionId,
    reportPath,
    workRevision: claimed?.work_revision ?? planGraphEntityRevision(binding.work),
    generatedControlWrites: claimed?.generated_control_writes ?? [],
    ...(claimed?.merge_reservation ? { mergeReservation: claimed.merge_reservation } : {}),
  };
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const ENTRY_DIR = (process.env.GARELIER_SCRIPT_ENTRY_DIR || moduleDir).replace(/\\/g, "/");
const CORE_DIR = (process.env.GARELIER_CORE_DIR || resolve(moduleDir, "../../..")).replace(/\\/g, "/");
const CORE_SCRIPTS = `${CORE_DIR}/scripts`;
const DRIVER_DISPATCH = (process.env.GARELIER_DRIVER_DISPATCH_DIR || `${CORE_DIR}/driver/src/dispatch`).replace(/\\/g, "/");

export function successfulLandCleanupArgs(
  entryDir: string,
  project: string,
  pmId: string,
  requestId: string,
  dispatchId: string,
  targetRoot: string,
): string[] {
  const args = ["bun", `${entryDir}/dispatch_cleanup.ts`, "--project", project, "--pm-id", pmId];
  if (dispatchId) args.push("--id", dispatchId, "--checkout", join(dispatchContainer(project, pmId, dispatchId), "checkout"));
  args.push("--request-id", requestId, "--delete-branch");
  if (targetRoot) args.push("--target-root", targetRoot);
  return args;
}

const CONTROL_SETTLEMENT_RESERVE_BYTES = 10 * 1024 * 1024;
const CONTROL_SETTLEMENT_RESERVE_FILES = 16;

export interface MergeLandControlPreflight {
  digest: string;
  files: number;
  bytes: number;
  projected_files: number;
  projected_bytes: number;
  raw_report_logs: string[];
  baseline_write_set: Array<{ path: string; digest: string; authority: string }>;
  receipt_path: string | null;
}

function controlRelativePath(gitRoot: string, controlRoot: string): string {
  const path = relative(resolve(gitRoot), resolve(controlRoot));
  if (!path || path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path)) {
    throw new Error(`Control root is outside the target Git root: ${controlRoot}`);
  }
  return path.replaceAll("\\", "/");
}

function controlGitStatus(gitRoot: string, controlRoot: string): string {
  const relativePath = controlRelativePath(gitRoot, controlRoot);
  const status = runSync(["git", "-C", gitRoot, "status", "--porcelain=v1", "--untracked-files=all", "--", relativePath]);
  if (status.code !== 0) throw new Error(`could not inspect Control Git status: ${status.stderr.trim() || `git exited ${status.code}`}`);
  return status.stdout.trim();
}

/** Only another Work's current claim row or a content-addressed claim renewal
 * record is foreign to this land. The renewal record remains identifiable after
 * its runtime claim has been released, so a closed lane does not block another
 * settlement. All other dirty Control paths still fail closed. */
function foreignClaimOwnedPaths(
  roots: ReturnType<typeof garelierControlRoots>,
  gitRoot: string,
  landingWorkId: string,
  changed: readonly string[],
): Set<string> {
  const model = loadPlanGraphModel(roots.controlRoot);
  const namespace = resolveControlNamespace(roots);
  const now = new Date();
  const sessions = new Map(readRuntimeSessions(namespace.runtimeRoot).map((session) => [session.session_id, session]));
  let runtime: ReturnType<typeof loadRuntimeControlSnapshot> | null = null;
  const rowOwners = new Map<string, string>();
  for (const work of model.backlog.values()) {
    if (work.id !== landingWorkId) rowOwners.set(gitPathForControlItem(gitRoot, roots.controlRoot, work.path).gitPath, work.id);
  }
  const foreign = new Set<string>();
  for (const gitPath of changed) {
    const rowWorkId = rowOwners.get(gitPath);
    if (rowWorkId) {
      const claim = readControlClaim(namespace, rowWorkId);
      const session = claim ? sessions.get(claim.session_id) : undefined;
      if (claim && session) {
        runtime ??= loadRuntimeControlSnapshot(namespace, roots.pmId, now, planGraphRuntimeCallbacks);
        assertClaimControlBinding(claim, runtime.binding);
        assertSessionControlBinding(session, runtime.binding);
      }
      if (claim && session && session.claims.includes(rowWorkId)
        && (claimHasLiveMergeReservation(claim, now)
          || (Date.parse(claim.expires_at) > now.getTime()
            && Date.parse(session.heartbeat_at) + runtime!.snapshot.claimStaleAfterSeconds * 1000 > now.getTime()))) {
        foreign.add(gitPath);
      }
      continue;
    }
    const relativePath = relative(roots.controlRoot, resolve(gitRoot, gitPath)).replaceAll("\\", "/");
    const renewal = /^reports\/claim_renewals\/(W-\d+)\/([0-9a-f]{64})\.json$/.exec(relativePath);
    if (!renewal || renewal[1] === landingWorkId) continue;
    try {
      const source = readFileSync(resolve(roots.controlRoot, relativePath), "utf8");
      const audit = readClaimRenewalAuthorizationRecord(source);
      if (sha256(source) === `sha256:${renewal[2]}`
        && audit?.work_id === renewal[1]
        && (audit.source === "dispatch-bind" || audit.source === "merge-settlement")) foreign.add(gitPath);
    } catch { /* malformed foreign record stays unbound */ }
  }
  return foreign;
}

function preflightReceiptPath(project: string, pmId: string, workId: string): string {
  return join(resolve(project), "__garelier", pmId, "runtime", "land_aftercare", "preflight", `${workId}.json`);
}

/**
 * The merge admission reads the exact transaction capacity denominator before
 * any claim reservation or merge request mutation. Historical raw tracked logs
 * are reported for PM-attended migration but are not a land denominator: new
 * preservation writes already enforce the excerpt + SHA-256 format. A new merge
 * accepts only the canonical live Work as a dirty
 * Control baseline and binds its exact path + digest into the receipt.
 * `--finalize-only` may recheck capacity over the expected uncommitted
 * settlement, whose exact write set is authenticated by commitControlSettlement.
 */
export function mergeLandControlPreflight(options: {
  project: string;
  gitRoot: string;
  pmId: string;
  workId: string;
  sessionId: string;
  dispatchId?: string;
  persistReceipt?: boolean;
  allowDirtySettlement?: boolean;
}): MergeLandControlPreflight {
  const roots = garelierControlRoots(options.project, options.gitRoot, options.pmId);
  let measured: ReturnType<typeof inspectControlTree>;
  try {
    measured = inspectControlTree(roots.controlRoot);
  } catch (error) {
    const detail = (error as Error).message;
    if (/control tree exceeds \d+ bytes/.test(detail)) throw new Error(`control-tree-too-large: ${detail}`);
    if (/control tree (?:has too many files|exceeds \d+ files)/.test(detail)) throw new Error(`control-file-count: ${detail}`);
    throw error;
  }
  const projectedFiles = measured.files + CONTROL_SETTLEMENT_RESERVE_FILES;
  const projectedBytes = measured.bytes + CONTROL_SETTLEMENT_RESERVE_BYTES;
  if (projectedFiles > CONTROL_TREE_DEFAULT_LIMITS.files) {
    throw new Error(`control-file-count: settlement projection ${projectedFiles} exceeds ${CONTROL_TREE_DEFAULT_LIMITS.files} files`);
  }
  if (projectedBytes > CONTROL_TREE_DEFAULT_LIMITS.bytes) {
    throw new Error(`control-tree-too-large: settlement projection ${projectedBytes} exceeds ${CONTROL_TREE_DEFAULT_LIMITS.bytes} bytes`);
  }
  const retention = inspectControlReportRetention(roots.controlRoot);
  const dirty = controlGitStatus(options.gitRoot, roots.controlRoot);
  const baselineWriteSet: Array<{ path: string; digest: string; authority: string }> = [];
  if (options.allowDirtySettlement !== true) {
    const mergeHead = runSync(["git", "-C", options.gitRoot, "rev-parse", "--verify", "-q", "MERGE_HEAD"]);
    if (mergeHead.code === 0) {
      throw new Error(`control-settlement-baseline-dirty: pre-existing merge is in progress at ${mergeHead.stdout.trim()}`);
    }
    if (mergeHead.code !== 1) {
      throw new Error(`control preflight MERGE_HEAD inspection failed: ${mergeHead.stderr.trim() || `git exited ${mergeHead.code}`}`);
    }
    const staged = gitNameList(options.gitRoot, ["diff", "--cached", "--name-only"], "control preflight staged-path inspection failed");
    if (staged.length) throw new Error(`control-settlement-baseline-dirty: merge preflight refuses staged paths: ${staged.join(", ")}`);
    const relativeControl = controlRelativePath(options.gitRoot, roots.controlRoot);
    const changed = [...new Set([
      ...gitNameList(options.gitRoot, ["diff", "--name-only", "--", relativeControl], "control preflight changed-path inspection failed"),
      ...gitNameList(options.gitRoot, ["ls-files", "--others", "--exclude-standard", "--", relativeControl], "control preflight untracked-path inspection failed"),
    ])].sort();
    const model = loadPlanGraphModel(roots.controlRoot);
    const work = model.backlog.get(options.workId);
    if (!work) throw new Error(`control-settlement-baseline-dirty: canonical Work is missing: ${options.workId}`);
    const allowedWork = gitPathForControlItem(options.gitRoot, roots.controlRoot, work.path);
    const foreign = foreignClaimOwnedPaths(roots, options.gitRoot, options.workId, changed);
    const unbound = changed.filter((path) => path !== allowedWork.gitPath && !foreign.has(path));
    if (unbound.length) {
      throw new Error(`control-settlement-baseline-dirty: merge preflight refuses unbound Control paths: ${unbound.join(", ")}`);
    }
    if (changed.includes(allowedWork.gitPath)) {
      baselineWriteSet.push({
        path: allowedWork.gitPath,
        digest: sha256(readFileSync(allowedWork.absolute)),
        authority: `work:${options.workId}`,
      });
    }
  }
  let receiptPath: string | null = null;
  if (options.persistReceipt) {
    receiptPath = preflightReceiptPath(options.project, options.pmId, options.workId);
    const runtimeRoot = join(resolve(options.project), "__garelier", options.pmId, "runtime");
    atomicWriteRuntimeFile(runtimeRoot, receiptPath, `${JSON.stringify({
      schema_version: 1,
      kind: "garelier_merge_land_control_preflight",
      work_id: options.workId,
      control_session_id: options.sessionId,
      dispatch_id: options.dispatchId || null,
      source_digest: measured.digest,
      files: measured.files,
      bytes: measured.bytes,
      projected_files: projectedFiles,
      projected_bytes: projectedBytes,
      git_control_status_sha256: sha256(dirty),
      git_control_path_count: dirty === "" ? 0 : dirty.split(/\r?\n/).length,
      baseline_write_set: baselineWriteSet,
      checked_at: new Date().toISOString(),
    })}\n`);
  }
  return {
    digest: measured.digest,
    files: measured.files,
    bytes: measured.bytes,
    projected_files: projectedFiles,
    projected_bytes: projectedBytes,
    raw_report_logs: retention.raw,
    baseline_write_set: baselineWriteSet,
    receipt_path: receiptPath,
  };
}

function assertFinalizeOnlyPreflightReceipt(options: {
  project: string; pmId: string; workId: string; sessionId: string; dispatchId: string;
}): { digest: string; files: number; bytes: number } {
  const path = preflightReceiptPath(options.project, options.pmId, options.workId);
  if (!existsSync(path)) throw new Error(`finalize-only requires the merge preflight receipt: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (value.kind !== "garelier_merge_land_control_preflight"
    || value.work_id !== options.workId
    || value.control_session_id !== options.sessionId
    || String(value.dispatch_id ?? "") !== options.dispatchId
    || typeof value.source_digest !== "string"
    || !Number.isSafeInteger(value.files)
    || !Number.isSafeInteger(value.bytes)) {
    throw new Error("finalize-only preflight receipt does not bind the landed Work/session/dispatch capacity baseline");
  }
  return { digest: value.source_digest, files: value.files as number, bytes: value.bytes as number };
}

function gitPathForControlItem(gitRoot: string, controlRoot: string, item: string): { gitPath: string; absolute: string } {
  const absolute = isAbsolute(item) ? resolve(item) : resolve(controlRoot, ...item.replaceAll("\\", "/").split("/"));
  const controlRelative = relative(resolve(controlRoot), absolute);
  if (!controlRelative || controlRelative === ".." || controlRelative.startsWith("../")
    || controlRelative.startsWith("..\\") || isAbsolute(controlRelative)) {
    throw new Error(`control settlement authority path is outside Control or names its root: ${item}`);
  }
  return { gitPath: relative(resolve(gitRoot), absolute).replaceAll("\\", "/"), absolute };
}

function gitNameList(gitRoot: string, args: string[], label: string): string[] {
  const result = runSync(["git", "-C", gitRoot, ...args]);
  if (result.code !== 0) throw new Error(`${label}: ${result.stderr.trim() || `git exited ${result.code}`}`);
  return result.stdout.split(/\r?\n/).map((item) => item.trim().replaceAll("\\", "/")).filter(Boolean);
}

function controlSettlementChangedPaths(gitRoot: string, controlRoot: string): string[] {
  const relativeControl = controlRelativePath(gitRoot, controlRoot);
  return [...new Set([
    ...gitNameList(gitRoot, ["diff", "--name-only", "--", relativeControl], "control settlement changed-path inspection failed"),
    ...gitNameList(gitRoot, ["ls-files", "--others", "--exclude-standard", "--", relativeControl], "control settlement untracked-path inspection failed"),
  ])].sort();
}

function settlementAuthorizationPath(project: string, pmId: string, requestId: string): string {
  return join(resolve(project), "__garelier", pmId, "runtime", "land_aftercare", "settlement_authorizations", `${requestId}.json`);
}

function normalizeSettlementWriteSet(value: unknown, label: string): ControlSettlementWrite[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label}[${index}] is malformed`);
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string" || !item.path || item.path.includes("\\") || isAbsolute(item.path)
      || item.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      || typeof item.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.digest)
      || typeof item.authority !== "string" || !item.authority) {
      throw new Error(`${label}[${index}] is malformed`);
    }
    if (seen.has(item.path)) throw new Error(`${label} repeats path: ${item.path}`);
    seen.add(item.path);
    return { path: item.path, digest: item.digest, authority: item.authority };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function persistSettlementAuthorization(options: {
  project: string; pmId: string; requestId: string; workId: string; studioCommit: string;
  writeSet: readonly ControlSettlementWrite[];
}): ControlSettlementWrite[] {
  const paths = normalizeSettlementWriteSet(options.writeSet, "Control settlement write set");
  const runtimeRoot = join(resolve(options.project), "__garelier", options.pmId, "runtime");
  const path = settlementAuthorizationPath(options.project, options.pmId, options.requestId);
  const source = `${canonicalJson({
    schema_version: 1,
    kind: "garelier_control_settlement_authorization",
    request_id: options.requestId,
    work_id: options.workId,
    studio_commit: options.studioCommit,
    paths,
    paths_digest: sha256(canonicalJson(paths)),
  })}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== source) throw new Error(`Control settlement authorization conflicts with its durable receipt: ${path}`);
  } else {
    atomicWriteRuntimeFile(runtimeRoot, path, source);
  }
  return paths;
}

function readSettlementAuthorization(options: {
  project: string; pmId: string; requestId: string; workId: string; studioCommit: string;
}): ControlSettlementWrite[] {
  const path = settlementAuthorizationPath(options.project, options.pmId, options.requestId);
  if (!existsSync(path)) throw new Error(`Control settlement authorization is missing: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (value.schema_version !== 1 || value.kind !== "garelier_control_settlement_authorization"
    || value.request_id !== options.requestId || value.work_id !== options.workId
    || value.studio_commit !== options.studioCommit) {
    throw new Error("Control settlement authorization identity is mismatched");
  }
  const paths = normalizeSettlementWriteSet(value.paths, "Control settlement authorization paths");
  if (value.paths_digest !== sha256(canonicalJson(paths))) {
    throw new Error("Control settlement authorization path digest is mismatched");
  }
  return paths;
}

export function commitControlSettlement(options: {
  project: string;
  gitRoot: string;
  controlRoot: string;
  integrationBranch: string;
  pmId: string;
  workId: string;
  sessionId: string;
  requestId: string;
  studioCommit: string;
  resultPath: string;
  authenticatedWriteSet: readonly ControlSettlementWrite[];
}): string {
  const branch = runSync(["git", "-C", options.gitRoot, "branch", "--show-current"]);
  if (branch.code !== 0 || branch.stdout.trim() !== options.integrationBranch) {
    throw new Error(`control settlement requires checked-out studio ${options.integrationBranch}, found ${branch.stdout.trim() || "detached/unreadable"}`);
  }
  const stagedBeforePaths = gitNameList(options.gitRoot, ["diff", "--cached", "--name-only"], "control settlement staged-path inspection failed");
  if (stagedBeforePaths.length) throw new Error(`control settlement requires an empty index; found: ${stagedBeforePaths.join(", ")}`);
  const roots = garelierControlRoots(options.project, options.gitRoot, options.pmId);
  const model = loadPlanGraphModel(options.controlRoot);
  const errors = model.findings.filter((finding) => finding.severity === "error");
  if (errors.length) throw new Error(`control settlement canonical model is invalid: ${errors[0]!.code}`);
  const work = model.backlog.get(options.workId);
  if (!work) throw new Error(`control settlement Work is missing: ${options.workId}`);
  const workAuthority = gitPathForControlItem(options.gitRoot, options.controlRoot, work.path);
  const preflightPath = preflightReceiptPath(options.project, options.pmId, options.workId);
  if (!existsSync(preflightPath)) throw new Error(`control settlement preflight receipt is missing: ${preflightPath}`);
  const preflightReceipt = JSON.parse(readFileSync(preflightPath, "utf8")) as Record<string, unknown>;
  if (preflightReceipt.kind !== "garelier_merge_land_control_preflight"
    || preflightReceipt.work_id !== options.workId) {
    throw new Error("control settlement preflight receipt identity is mismatched");
  }
  if (preflightReceipt.baseline_write_set !== undefined) {
    if (!Array.isArray(preflightReceipt.baseline_write_set)) {
      throw new Error("control settlement preflight baseline write set is malformed");
    }
    for (const entry of preflightReceipt.baseline_write_set) {
      const item = entry as Record<string, unknown>;
      if (item.path !== workAuthority.gitPath || item.authority !== `work:${options.workId}`
        || typeof item.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.digest)) {
        throw new Error("control settlement preflight baseline contains an unauthenticated path or digest");
      }
    }
  }
  const canonicalAuthorities = new Map<string, { digest: string | null; authority: string }>();
  canonicalAuthorities.set(work.path, { digest: null, authority: `work:${options.workId}` });
  for (const evidence of planGraphEvidenceReferences(work)) {
    if (evidence.root !== "control" || !evidence.path) continue;
    if (!evidence.content_hash) throw new Error(`control settlement evidence path lacks content_hash: ${evidence.path}`);
    canonicalAuthorities.set(evidence.path, { digest: evidence.content_hash, authority: `evidence:${evidence.kind}` });
  }
  const allowed = new Map<string, { absolute: string; digest: string; authority: string }>();
  for (const item of options.authenticatedWriteSet) {
    if (!item || typeof item.path !== "string" || typeof item.digest !== "string" || typeof item.authority !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(item.digest)) {
      throw new Error("control settlement authenticated write-set entry is malformed");
    }
    const canonical = canonicalAuthorities.get(item.path);
    if (item.authority.startsWith("generated:")) {
      validateGeneratedControlSettlementWrite({
        roots,
        workId: options.workId,
        sessionId: options.sessionId,
        requestId: options.requestId,
        write: item,
      });
    } else if (!canonical || canonical.authority !== item.authority
      || (canonical.digest !== null && canonical.digest !== item.digest)) {
      throw new Error(`control settlement write set lacks canonical authority: ${item.path}`);
    }
    const resolved = gitPathForControlItem(options.gitRoot, options.controlRoot, item.path);
    if (!existsSync(resolved.absolute) || !statSync(resolved.absolute).isFile()) {
      throw new Error(`control settlement authenticated path is missing or not a file: ${resolved.gitPath}`);
    }
    const digest = sha256(readFileSync(resolved.absolute));
    if (digest !== item.digest) {
      throw new Error(`control settlement authenticated digest changed: ${resolved.gitPath}`);
    }
    const previous = allowed.get(resolved.gitPath);
    if (previous) throw new Error(`control settlement write set repeats path: ${resolved.gitPath}`);
    allowed.set(resolved.gitPath, { absolute: resolved.absolute, digest, authority: item.authority });
  }
  const allChangedPaths = controlSettlementChangedPaths(options.gitRoot, options.controlRoot);
  const foreignChangedPaths = foreignClaimOwnedPaths(roots, options.gitRoot, options.workId, allChangedPaths);
  const changedPaths = allChangedPaths.filter((path) => !foreignChangedPaths.has(path));
  const changedSet = new Set(changedPaths);
  // W-843 AC-2: an authenticated write whose exact bytes are already committed
  // (the index is empty, the path is unchanged, and its digest was verified
  // above) is settled. A retry after a post-commit failure must not demand
  // that it change again — that turned the only recovery command into a
  // refusal it could never pass.
  const alreadySettled = [...allowed.keys()].filter((path) => !changedSet.has(path));
  if (alreadySettled.length) {
    const tracked = new Set(gitNameList(options.gitRoot, ["ls-files", "--", ...alreadySettled], "control settlement committed-path inspection failed"));
    const untracked = alreadySettled.filter((path) => !tracked.has(path)).sort();
    if (untracked.length) throw new Error(`control settlement authenticated paths are neither changed nor committed (ignored?): ${untracked.join(", ")}`);
  }
  const authenticatedPaths = [...allowed.keys()].filter((path) => changedSet.has(path)).sort();
  const unbound = changedPaths.filter((path) => !allowed.has(path));
  if (unbound.length) throw new Error(`control settlement refuses unbound Control paths: ${unbound.join(", ")}`);
  if (canonicalJson(changedPaths) !== canonicalJson(authenticatedPaths)) {
    throw new Error(
      `control settlement changed set differs from authenticated write set: `
      + `changed=${changedPaths.join(", ") || "none"}; authenticated=${authenticatedPaths.join(", ") || "none"}`,
    );
  }
  const canonicalLiveResult = join(
    resolve(options.project),
    "__garelier",
    options.pmId,
    "runtime",
    "merge_gate",
    "results",
    `${options.requestId}.json`,
  );
  if (!hasMergeControlEvidence(roots, options.workId, options.studioCommit, options.resultPath)
    && !hasMergeControlEvidence(roots, options.workId, options.studioCommit, canonicalLiveResult)) {
    throw new Error("control settlement cannot authenticate the landed merge evidence");
  }
  const manifest = changedPaths.map((path) => ({
    path,
    digest: allowed.get(path)!.digest,
    authority: allowed.get(path)!.authority,
  }));
  const runtimeRoot = join(resolve(options.project), "__garelier", options.pmId, "runtime");
  const receiptPath = join(runtimeRoot, "land_aftercare", "settlement", `${options.requestId}.json`);
  atomicWriteRuntimeFile(runtimeRoot, receiptPath, `${canonicalJson({
    schema_version: 1,
    kind: "garelier_control_settlement_manifest",
    request_id: options.requestId,
    work_id: options.workId,
    studio_commit: options.studioCommit,
    result_path: options.resultPath,
    paths: manifest,
    manifest_digest: sha256(canonicalJson(manifest)),
  })}\n`);
  if (changedPaths.length) {
    const add = runSync(["git", "-C", options.gitRoot, "add", "--", ...changedPaths]);
    if (add.code !== 0) throw new Error(`control settlement staging failed: ${add.stderr.trim() || `git exited ${add.code}`}`);
  }
  const stagedPaths = gitNameList(options.gitRoot, ["diff", "--cached", "--name-only"], "control settlement staged-path inspection failed").sort();
  if (canonicalJson(stagedPaths) !== canonicalJson(changedPaths)) {
    throw new Error(`control settlement staged set differs from authenticated manifest: ${stagedPaths.join(", ")}`);
  }
  for (const item of manifest) {
    if (sha256(readFileSync(allowed.get(item.path)!.absolute)) !== item.digest) {
      throw new Error(`control settlement path changed after manifest publication: ${item.path}`);
    }
  }
  if (stagedPaths.length) {
    const message = `chore(control): settle ${options.workId} land\n\nPersist request ${options.requestId} finalization and aftercare evidence.\n\nGarelier: ${options.pmId} merge ${options.workId}`;
    const commit = runSync(["git", "-C", options.gitRoot, "commit", "-m", message], { timeoutMs: 120_000 });
    if (commit.code !== 0) throw new Error(`control settlement commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
  const allRemaining = controlSettlementChangedPaths(options.gitRoot, options.controlRoot);
  const foreignRemaining = foreignClaimOwnedPaths(roots, options.gitRoot, options.workId, allRemaining);
  const remaining = allRemaining.filter((path) => !foreignRemaining.has(path));
  if (remaining.length) throw new Error(`control settlement left uncommitted paths: ${remaining.join(", ")}`);
  const head = runSync(["git", "-C", options.gitRoot, "rev-parse", "HEAD"]);
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(head.stdout.trim())) throw new Error("control settlement could not resolve its commit");
  return head.stdout.trim();
}

function controlTransactionResidue(controlRoot: string): string[] {
  const parent = dirname(controlRoot);
  const prefix = `.${basename(controlRoot)}.txn-`;
  if (!existsSync(parent)) return [];
  return readdirSync(parent).filter((name) => name.startsWith(prefix)).sort();
}

function inspectControlSettlementClosure(controlRoot: string): ReturnType<typeof inspectControlTree> {
  return inspectControlTree(controlRoot);
}

function emitSettlementRecovery(detail: string, project: string, pmId: string, requestId: string): void {
  const finalize = `bun ${ENTRY_DIR}/merge_land.ts --project ${JSON.stringify(project)} --pm-id ${JSON.stringify(pmId)} --finalize-only --request-id ${JSON.stringify(requestId)} --no-pull`;
  if (detail.startsWith("Control transaction residue remains:")) {
    err(`NEXT_COMMAND: bun ${ENTRY_DIR}/control.ts doctor --profile strict --project ${JSON.stringify(project)} --pm-id ${JSON.stringify(pmId)} --format json`);
    err(`AFTER_RECOVERY: ${finalize}`);
    return;
  }
  err(`NEXT_COMMAND: ${finalize}`);
}

export function dispatchIdFromBranch(branch: string): string {
  return /(?:^|\/)(?:workbench|anvil|shelf)\/#([0-9]+)(?:\/|$)/.exec(branch)?.[1] ?? "";
}

// W-372: a branch-bound self-gate structurally cannot see a semantic conflict
// that exists only in the merge result (Guardian-verified 2026-08-04 — the
// row's initial "widen the gate scope" prescription was refuted; base-track is
// the nearest mechanical approximation, since base-tracked tree === trial-merged
// tree). This computes how far a dispatch's RECORDED base_sha has fallen behind
// the current studio tip, at the moment of merge submission — the latest point
// a warning can still change the operator's next action before the merge gate
// spends its own cycle. Returns null when either ref does not resolve (a
// deleted/rewritten base, or an unreadable studio ref) — silence in that case,
// never a false "0 behind".
export function computeBaseBehindStudio(gitRoot: string, baseSha: string, studioTip: string): number | null {
  if (!baseSha || !studioTip) return null;
  const result = runSync(["git", "-C", gitRoot, "rev-list", "--count", `${baseSha}..${studioTip}`]);
  if (result.code !== 0) return null;
  const n = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

export interface BaseBehindStatus { base: string; studio_tip: string; commits_behind: number }

// Reads the dispatch's context.json task.base_sha (the SAME field
// dispatch_prepare.ts records at pickup) and compares it against the
// integration branch's CURRENT tip. Never throws — every failure to resolve a
// piece of the comparison (missing context, missing base_sha, unresolvable
// studio ref) degrades to "no detection" so this can never block a submit.
export function detectBaseBehindAtSubmit(input: {
  contextPath: string; gitRoot: string; integrationBranch: string;
}): BaseBehindStatus | null {
  if (!existsSync(input.contextPath)) return null;
  let recordedBaseSha = "";
  try { recordedBaseSha = firstMatch(readFileSync(input.contextPath, "utf8"), /"base_sha":\s*"([^"]*)"/); } catch { recordedBaseSha = ""; }
  if (!recordedBaseSha || !input.integrationBranch) return null;
  const tip = runSync(["git", "-C", input.gitRoot, "rev-parse", input.integrationBranch]);
  const studioTip = tip.code === 0 ? tip.stdout.trim() : "";
  if (!studioTip) return null;
  const commitsBehind = computeBaseBehindStudio(input.gitRoot, recordedBaseSha, studioTip);
  if (commitsBehind === null || commitsBehind <= 0) return null;
  return { base: recordedBaseSha, studio_tip: studioTip, commits_behind: commitsBehind };
}

export function baseBehindWarning(dispatchId: string, branch: string, status: BaseBehindStatus): string {
  return `merge_land: ⚠ BASE BEHIND STUDIO (W-372) — dispatch #${dispatchId || "?"}'s recorded base ${status.base} is ${status.commits_behind} commit(s) behind studio tip ${status.studio_tip}. A branch-bound self-gate cannot see a semantic conflict that exists only in the merge result. Base-track (merge studio into ${branch || "this branch"}) and re-run the whole-project quality-gate command on the tracked tree BEFORE trusting this self-gate. This is a WARNING, not a block — the merge gate itself still runs its own check on the merged tree.`;
}

export function baseBehindJsonField(status: BaseBehindStatus | null): string {
  if (!status) return "";
  return `,"base_behind":{"base":"${jesc(status.base)}","studio_tip":"${jesc(status.studio_tip)}","commits_behind":${status.commits_behind}}`;
}

const HELP = `#
# merge_land.ts — one background command for the whole PM merge ritual (W-088).
#
# Submits, BLOCK-waits for the gate result, and only on a landed merge cleans up
# + pulls. On a failed/aborted/timed-out gate it cleans up NOTHING and returns
# the failure.
#
# Usage:
#   merge_land.ts --project <control-root> --pm-id <id>
#                 (--branch <workbench-branch> | --dispatch-id <N>)
#                 [--guardian <PASS|PASS_WITH_NOTES>] [--observer <verdict>]
#                 [--seat-trailer <checked|skip>]
#                   Overrides the seat-trailer PREFLIGHT when it cannot decide —
#                   the container/context.json is unresolvable, or its content is
#                   unreadable (neither routing.commit_mode nor routing.model),
#                   both of which fail closed. checked = "I verified the proxy
#                   commits by hand", skip = "this dispatch needs no check".
#   merge_land.ts --project <control-root> --pm-id <id>
#                 --finalize-only --request-id <landed-request-id> [--no-pull]
#                   On a resolvable proxy dispatch it SKIPS the lint entirely,
#                   so it is an assertion by the operator, not a re-check: the
#                   ordinary fix for a failing trailer is to repair the commit.
#                   A Dock base-track merge commit no longer needs this flag at
#                   all — a two-parent commit is outside the seat-trailer
#                   denominator (W-692).
#                 [--no-pull]
#                 [--close-row <item-id> …]
#                 [--max-wait <seconds>] [--poll-interval <seconds>]
#                 [ …any other merge_request.ts flag… ]
#
# Batch mode (W-022): --id <N1> --id <N2> …  OR  --batch <file>.
`;

// ── process helpers ─────────────────────────────────────────────────────────
interface Cmd { code: number; stdout: string; stderr: string }
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const SUCCESSFUL_LAND_CLEANUP_TIMEOUT_MS = 120_000;
const RECURSIVE_MERGE_TIMEOUT_MS = 8_640_000;

export function classifyMergeLandChild(input: {
  exitCode?: number | null;
  signalCode?: string | number | null;
  exitedDueToTimeout?: boolean;
  spawnError?: unknown;
}, timeoutMs: number, command: readonly string[], stdout = "", stderr = ""): Cmd {
  if (input.exitedDueToTimeout) {
    return { code: 124, stdout, stderr: `${stderr}${stderr ? "\n" : ""}merge_land: child timed out after ${timeoutMs}ms: ${command.join(" ")}` };
  }
  if (input.signalCode) {
    return { code: 128, stdout, stderr: `${stderr}${stderr ? "\n" : ""}merge_land: child terminated by signal ${input.signalCode}: ${command.join(" ")}` };
  }
  if (input.spawnError !== undefined) {
    const detail = input.spawnError instanceof Error ? input.spawnError.message : String(input.spawnError);
    return { code: 127, stdout, stderr: `merge_land: child spawn failed: ${detail}` };
  }
  if (input.exitCode === null || input.exitCode === undefined) {
    return { code: 127, stdout, stderr: `merge_land: child exited without a status: ${command.join(" ")}` };
  }
  return { code: input.exitCode, stdout, stderr };
}

function runSync(command: string[], opts: { stderrTo?: "capture" | "inherit"; timeoutMs?: number } = {}): Cmd {
  const resolved = resolveCommand(command);
  if (!resolved) return { code: 127, stdout: "", stderr: `required executable not found: ${command[0] ?? "<empty>"}` };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  try {
    const c = Bun.spawnSync(resolved, { windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: opts.stderrTo === "inherit" ? "inherit" : "pipe",
      timeout: timeoutMs,
    });
    const stdout = c.stdout?.toString() ?? "";
    const stderr = opts.stderrTo === "inherit" ? "" : (c.stderr?.toString() ?? "");
    return classifyMergeLandChild(c, timeoutMs, command, stdout, stderr);
  } catch (error) {
    return classifyMergeLandChild({ spawnError: error }, timeoutMs, command);
  }
}
function err(s: string): void { process.stderr.write(s.endsWith("\n") ? s : s + "\n"); }
function out(s: string): void { process.stdout.write(s.endsWith("\n") ? s : s + "\n"); }
function jesc(s: string): string { return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function firstMatch(text: string, re: RegExp): string { const m = text.match(re); return m ? m[1] : ""; }

export function classifyMergeLandWaitFailure(
  waitRc: number,
  statusLine: string,
  parsedStatus = "",
  parsedDetail = "",
): { status: string; detail: string } {
  const status = parsedStatus || (waitRc === 125 ? "control_settlement_timeout" : waitRc === 124 ? "timeout" : "failed");
  const detail = parsedDetail || (waitRc === 125
    ? firstMatch(statusLine, /^MERGE_CONTROL_SETTLEMENT_TIMEOUT: (.*)$/m)
    : firstMatch(statusLine, /^MERGE_TIMEOUT: (.*)$/m));
  return { status, detail };
}

// read_marker_verdict — emit the canonical verdict token under `## Verdict`, or
// NOTHING when present-but-malformed (callers gate on file existence first, so an
// empty return there means malformed → the stderr note below).
function readMarkerVerdict(markerPath: string): string {
  let text: string;
  try { text = readFileSync(markerPath, "utf8"); } catch { return ""; }
  const v = extractVerdict(text);
  if (v) return v;
  err(`merge_land: verdict marker ${markerPath} is present but MALFORMED — no bare canonical token under '## Verdict' (a prose sentence, an unfilled {{…}} menu, bold like **PASS**, or a typo like PASSED all read as no-verdict; fix per templates/gate_verdict.md)`);
  return "";
}

export interface ResolvedMergeLandVerdict {
  verdict: string;
  reportPath: string;
  source: "token" | "file";
}

/** A canonical token remains an explicit override; every other value must be a
 * real verdict file. This turns the measured `--guardian <path>` refusal into
 * the same authenticated report binding merge_request already validates. */
export function resolveMergeLandVerdictInput(value: string, role: "Guardian" | "Observer"): ResolvedMergeLandVerdict {
  const canonical = new Set(["PASS", "PASS_WITH_NOTES", "REWORK_RECOMMENDED", "BLOCK", "NO_OPINION"]);
  if (canonical.has(value)) return { verdict: value, reportPath: "", source: "token" };
  if (!existsSync(value)) {
    throw new Error(`${role} verdict input is neither a canonical token nor an existing report: ${value}`);
  }
  const verdict = readMarkerVerdict(value);
  if (!verdict) throw new Error(`${role} verdict report is malformed: ${value}`);
  return { verdict, reportPath: resolve(value), source: "file" };
}

export function mergeLandAwaitArgs(
  dockMergeTs: string,
  project: string,
  pmId: string,
  requestId: string,
  maxWaitSeconds = "",
  pollIntervalSeconds = "",
): { command: string[]; timeoutMs: number } {
  const ceilingMs = maxWaitSeconds ? Number(maxWaitSeconds) * 1000 : 1_800_000;
  if (!Number.isFinite(ceilingMs) || ceilingMs < 60_000) {
    throw new Error(`--max-wait must be at least 60 seconds (got '${maxWaitSeconds}')`);
  }
  const pollMs = pollIntervalSeconds ? Number(pollIntervalSeconds) * 1000 : 3_000;
  if (!Number.isFinite(pollMs) || pollMs < 250) {
    throw new Error(`--poll-interval must be at least 0.25 seconds (got '${pollIntervalSeconds}')`);
  }
  return {
    command: ["bun", dockMergeTs, "await", "--pm-id", pmId, "--project", project,
      "--request-id", requestId, "--poll-ms", String(pollMs), "--ceiling-ms", String(ceilingMs)],
    timeoutMs: ceilingMs + 30_000,
  };
}

type GeneratedControlWriteSkip = {
  path: string;
  reason: "oversized" | "invalid_json" | GeneratedControlWriteRefusalReason;
};

/**
 * The ONE collector of the Control writes this land's generators returned
 * (W-843). Every generator that writes into Control for a land request outside
 * the main plan-graph transaction is read here, and nowhere else decides what a
 * land may settle beyond that transaction:
 *
 *   - claim renewal: content-addressed audit records, discovered by scanning
 *     its own directory (the record authenticates itself);
 *   - aftercare preservation: the path + digest record the aftercare wrote for
 *     this request when it published gate evidence (run records, the Guardian
 *     admission, PM-step log summaries, preserved artifacts).
 *
 * Both the ordinary land and `--finalize-only` call this after cleanup, because
 * the aftercare is the last generator to run. Before W-843 only the claim
 * renewal was collected, and only by finalize-only, so a land's own gate
 * records were refused as unbound and finalize-only could not recover (#649).
 * A write whose path is already committed with the same bytes is not returned:
 * the settlement has nothing left to stage for it.
 */
function collectGeneratedControlWrites(options: {
  roots: ReturnType<typeof garelierControlRoots>;
  gitRoot: string;
  workId: string;
  sessionId: string;
  requestId: string;
}): { writes: ControlSettlementWrite[]; skipped: GeneratedControlWriteSkip[] } {
  const changed = new Set(controlSettlementChangedPaths(options.gitRoot, options.roots.controlRoot));
  const writes: ControlSettlementWrite[] = [];
  const skipped: GeneratedControlWriteSkip[] = [];
  const admit = (write: ControlSettlementWrite): void => {
    let gitPath: string;
    try {
      gitPath = gitPathForControlItem(options.gitRoot, options.roots.controlRoot, write.path).gitPath;
    } catch {
      skipped.push({ path: write.path, reason: "unresolved_path" });
      return;
    }
    try {
      const validated = validateGeneratedControlSettlementWrite({ ...options, write });
      if (changed.has(gitPath)) writes.push(validated);
    } catch (error) {
      if (!(error instanceof GeneratedControlWriteRefusal)) throw error;
      skipped.push({ path: write.path, reason: error.reason });
    }
  };

  const renewalRoot = `reports/claim_renewals/${options.workId}`;
  const absoluteRenewalRoot = join(options.roots.controlRoot, ...renewalRoot.split("/"));
  const renewals = existsSync(absoluteRenewalRoot) ? readdirSync(absoluteRenewalRoot, { withFileTypes: true }) : [];
  for (const entry of renewals) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
    const absolute = join(absoluteRenewalRoot, entry.name);
    const path = `${renewalRoot}/${entry.name}`;
    let captured: ReturnType<typeof captureEvidenceSource>;
    try {
      if (statSync(absolute).size > 64 * 1024) {
        skipped.push({ path, reason: "oversized" });
        continue;
      }
      captured = captureEvidenceSource(options.roots, absolute, "merge Control settlement generated write");
    } catch {
      skipped.push({ path, reason: "unreadable" });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(captured.source);
    } catch {
      skipped.push({ path, reason: "invalid_json" });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      skipped.push({ path, reason: "invalid_record" });
      continue;
    }
    if ((parsed as Record<string, unknown>).request_id !== options.requestId) continue;
    admit({
      path,
      digest: captured.contentHash,
      authority: generatedControlWriteAuthority(CLAIM_RENEWAL_GENERATOR, options.requestId),
    });
  }

  let publication: ReturnType<typeof readAftercarePreservationPublication> = null;
  try {
    publication = readAftercarePreservationPublication(options.roots, options.requestId);
  } catch (error) {
    if (!(error instanceof GeneratedControlWriteRefusal)) throw error;
    const record = aftercarePreservationPublicationPath(options.roots, options.requestId);
    skipped.push({ path: relative(resolve(options.roots.projectRoot), record).replaceAll("\\", "/"), reason: error.reason });
  }
  for (const write of publication?.writes ?? []) {
    admit({ ...write, authority: generatedControlWriteAuthority(AFTERCARE_PRESERVATION_GENERATOR, options.requestId) });
  }
  return {
    writes: writes.sort((left, right) => left.path.localeCompare(right.path)),
    skipped: skipped.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function reportGeneratedControlWriteSkips(skipped: readonly GeneratedControlWriteSkip[]): void {
  for (const item of skipped) err(`merge_land: skipped generated Control write ${item.path}: ${item.reason}`);
}

function mergeSettlementWriteSets(
  recorded: readonly ControlSettlementWrite[],
  generated: readonly ControlSettlementWrite[],
): ControlSettlementWrite[] {
  const merged = new Map<string, ControlSettlementWrite>();
  for (const write of [...recorded, ...generated]) {
    const previous = merged.get(write.path);
    if (previous && (previous.digest !== write.digest || previous.authority !== write.authority)) {
      throw new Error(`settlement write authority changed: ${write.path}`);
    }
    merged.set(write.path, { ...write });
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function finalizeOnlyLand(options: {
  project: string;
  gitRoot: string;
  pmId: string;
  requestId: string;
  noPull: boolean;
}): number {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.requestId)) {
    err(`merge_land: --request-id contains unsafe path characters: ${options.requestId}`);
    return 2;
  }
  const pmRoot = join(resolve(options.project), "__garelier", options.pmId);
  const archivedRequest = join(pmRoot, "runtime", "merge_gate", "archive", `${options.requestId}.request.json`);
  const archivedResult = join(pmRoot, "runtime", "merge_gate", "archive", `${options.requestId}.result.json`);
  const pendingRequest = join(pmRoot, "runtime", "merge_gate", "requests", `${options.requestId}.json`);
  const requestPath = existsSync(archivedRequest) ? archivedRequest : pendingRequest;
  const liveResult = join(pmRoot, "runtime", "merge_gate", "results", `${options.requestId}.json`);
  const resultPath = existsSync(liveResult) ? liveResult : archivedResult;
  try {
    if (!existsSync(requestPath) || !existsSync(resultPath)) {
      throw new Error(`finalize-only requires the canonical request/result pair: ${requestPath} / ${resultPath}`);
    }
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    const workId = typeof request.work_id === "string" ? request.work_id : "";
    const sessionId = typeof request.control_session_id === "string" ? request.control_session_id : "";
    const dispatchId = typeof request.dispatch_id === "string" ? request.dispatch_id : "";
    const reportPath = typeof request.role_report_path === "string" ? request.role_report_path : "";
    const studioCommit = typeof result.studio_commit === "string" ? result.studio_commit : "";
    if (!workId || !sessionId || !dispatchId || !reportPath || !/^[0-9a-f]{40,64}$/.test(studioCommit)) {
      throw new Error("finalize-only request/result is missing its Work/session/dispatch/report/studio binding");
    }
    const admission = assertFinalizeOnlyPreflightReceipt({
      project: options.project,
      pmId: options.pmId,
      workId,
      sessionId,
      dispatchId,
    });
    const preflight = mergeLandControlPreflight({
      project: options.project,
      gitRoot: options.gitRoot,
      pmId: options.pmId,
      workId,
      sessionId,
      dispatchId,
      allowDirtySettlement: true,
    });
    const roots = garelierControlRoots(options.project, options.gitRoot, options.pmId);
    const collectGenerated = () => collectGeneratedControlWrites({
      roots,
      gitRoot: options.gitRoot,
      workId,
      sessionId,
      requestId: options.requestId,
    });
    // Skip reasons are reported once, from the post-cleanup collection below,
    // which sees every generator including the aftercare.
    const generatedControlWrites = collectGenerated().writes;
    const finalized = finalizeLongMergeEvidence({
      roots,
      workId,
      sessionId,
      requestPath,
      resultPath,
      reportPath,
      studioCommit,
      generatedControlWrites,
    });
    const priorAuthorizationExists = existsSync(settlementAuthorizationPath(
      options.project,
      options.pmId,
      options.requestId,
    ));
    const priorWriteSet = priorAuthorizationExists ? readSettlementAuthorization({
      project: options.project,
      pmId: options.pmId,
      requestId: options.requestId,
      workId,
      studioCommit,
    }) : [];
    const settlementWriteSet = mergeSettlementWriteSets(
      priorWriteSet,
      mergeSettlementWriteSets(finalized.settlement_write_set, generatedControlWrites),
    );
    // A recovery receipt may predate the merge-bound renewal that interrupted
    // settlement.  Keep that immutable receipt as the baseline and extend its
    // authority in memory only with request-bound generator output revalidated
    // above.  A retry reconstructs the same set from the still-live Control
    // artifact; no broader path allowlist or mutable receipt is introduced.
    const authenticatedWriteSet = settlementWriteSet.length === 0
      ? []
      : priorAuthorizationExists
        ? settlementWriteSet
        : persistSettlementAuthorization({
          project: options.project,
          pmId: options.pmId,
          requestId: options.requestId,
          workId,
          studioCommit,
          writeSet: settlementWriteSet,
          });
    const recheck = inspectControlTree(roots.controlRoot);
    err(
      `merge_land: finalize-only Control settlement recheck of preflight values `
      + `preflight_digest=${admission.digest} preflight_files=${admission.files} preflight_bytes=${admission.bytes} `
      + `recovery_digest=${preflight.digest} recovery_files=${preflight.files} recovery_bytes=${preflight.bytes} `
      + `settlement_digest=${recheck.digest} settlement_files=${recheck.files} settlement_bytes=${recheck.bytes} `
      + `finalization=${finalized.status}`,
    );
    const cleanup = runSync(
      successfulLandCleanupArgs(ENTRY_DIR, options.project, options.pmId, options.requestId, dispatchId, options.gitRoot),
      { timeoutMs: SUCCESSFUL_LAND_CLEANUP_TIMEOUT_MS },
    );
    if (cleanup.stdout) err(cleanup.stdout);
    if (cleanup.stderr) err(cleanup.stderr);
    if (cleanup.code !== 0 || !/"container_removed":true/.test(cleanup.stdout)) {
      throw new Error(cleanup.stderr.trim() || `dispatch cleanup did not remove container (exit=${cleanup.code})`);
    }
    const closure = inspectControlSettlementClosure(roots.controlRoot);
    err(`merge_land: finalize-only post-aftercare Control closure files=${closure.files} bytes=${closure.bytes} digest=${closure.digest}`);
    const residueBeforeCommit = controlTransactionResidue(roots.controlRoot);
    if (residueBeforeCommit.length) throw new Error(`Control transaction residue remains: ${residueBeforeCommit.join(", ")}`);
    const postCleanupGenerated = collectGenerated();
    reportGeneratedControlWriteSkips(postCleanupGenerated.skipped);
    const settlementCommit = commitControlSettlement({
      project: options.project,
      gitRoot: options.gitRoot,
      controlRoot: roots.controlRoot,
      integrationBranch: loadConfig(options.project, options.pmId).branches.integration,
      pmId: options.pmId,
      workId,
      sessionId,
      requestId: options.requestId,
      studioCommit,
      resultPath,
      authenticatedWriteSet: mergeSettlementWriteSets(authenticatedWriteSet, postCleanupGenerated.writes),
    });
    rmSync(settlementAuthorizationPath(options.project, options.pmId, options.requestId), { force: true });
    const transactionResidue = controlTransactionResidue(roots.controlRoot);
    if (transactionResidue.length) throw new Error(`Control transaction residue remains: ${transactionResidue.join(", ")}`);
    const reportChanges = controlSettlementChangedPaths(options.gitRoot, join(roots.controlRoot, "reports"));
    const foreignReports = foreignClaimOwnedPaths(roots, options.gitRoot, workId, reportChanges);
    const reportResidue = reportChanges.filter((path) => !foreignReports.has(path));
    if (reportResidue.length) throw new Error(`untracked or uncommitted Control report residue remains: ${reportResidue.join(", ")}`);
    const receipt = preflightReceiptPath(options.project, options.pmId, workId);
    if (existsSync(receipt)) rmSync(receipt, { force: true });
    let pulled = "skipped";
    if (!options.noPull) {
      const pull = runSync(["git", "-C", options.gitRoot, "pull", "--ff-only"]);
      pulled = pull.code === 0 ? "true" : "false";
      if (pull.code !== 0) err(`merge_land: git pull --ff-only skipped/failed: ${pull.stderr.split("\n")[0] || ""}`);
    }
    out(JSON.stringify({
      request_id: options.requestId,
      status: "success",
      mode: "finalize-only",
      studio_commit: studioCommit,
      settlement_commit: settlementCommit,
      dispatch_id: dispatchId,
      cleaned_up: true,
      pulled,
    }));
    return 0;
  } catch (error) {
    const detail = (error as Error).message;
    err(`merge_land: finalize-only refused: ${detail}`);
    emitSettlementRecovery(detail, options.project, options.pmId, options.requestId);
    out(JSON.stringify({ request_id: options.requestId, status: "settlement_failed", mode: "finalize-only", failure_reason: detail, cleaned_up: false }));
    return 4;
  }
}

function main(): number {
  const argv = process.argv.slice(2);

  // ── W-022 batch pre-scan ──────────────────────────────────────────────────
  const scanShared: string[] = [];
  const scanItems: string[] = [];
  let scanBatchFile = "";
  let nId = 0, nBranch = 0;
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--batch") { scanBatchFile = argv[i + 1] ?? ""; i += 2; }
    else if (a === "--id" || a === "--dispatch-id") { nId++; scanItems.push(`--id ${argv[i + 1] ?? ""}`); i += 2; }
    else if (a === "--branch") { nBranch++; scanItems.push(`--branch ${argv[i + 1] ?? ""}`); i += 2; }
    else { scanShared.push(a); i += 1; }
  }
  let batchMode = false;
  if (scanBatchFile) batchMode = true;
  else if (nId >= 2 || nBranch >= 2) batchMode = true;

  if (batchMode) {
    const items: string[] = [];
    if (scanBatchFile) {
      if (nId > 0 || nBranch > 0) { err("merge_land: --batch <file> cannot be combined with top-level --id/--branch (put each item's flags on its own line in the file)"); return 2; }
      if (!existsSync(scanBatchFile)) { err(`merge_land: --batch file not found: ${scanBatchFile}`); return 2; }
      const lines = readFileSync(scanBatchFile, "utf8").split("\n");
      for (const raw of lines) {
        const line = raw.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");
        if (!line) continue;
        if (line.startsWith("#")) continue;
        items.push(line);
      }
      if (items.length === 0) { err(`merge_land: --batch file ${scanBatchFile} has no item lines`); return 2; }
    } else {
      items.push(...scanItems);
    }

    const total = items.length;
    let n = 0, landed = 0;
    err(`merge_land: batch of ${total} item(s) — landing serially, aborting the rest on the first failure.`);
    for (const it of items) {
      n++;
      const iargs = it.split(/\s+/).filter((s) => s.length > 0);
      err(`merge_land: [batch ${n}/${total}] landing: ${iargs.join(" ")}`);
      const r = runSync(["bun", `${ENTRY_DIR}/merge_land.ts`, ...scanShared, ...iargs], { stderrTo: "inherit", timeoutMs: RECURSIVE_MERGE_TIMEOUT_MS });
      if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
      if (r.code !== 0) {
        err(`merge_land: [batch ${n}/${total}] FAILED (rc=${r.code}) — aborting; ${total - n} remaining item(s) NOT attempted.`);
        out(`{"batch":true,"total":${total},"attempted":${n},"landed":${landed},"status":"failed","failed_item":"${jesc(it)}"}`);
        return r.code;
      }
      landed++;
      err(`merge_land: [batch ${n}/${total}] landed.`);
    }
    err(`merge_land: batch complete — all ${total} item(s) landed.`);
    out(`{"batch":true,"total":${total},"attempted":${total},"landed":${landed},"status":"success"}`);
    return 0;
  }

  // ── single-land arg parse ──────────────────────────────────────────────────
  const MR_ARGS: string[] = [];
  let PROJECT = "", PM = "", BRANCH = "", TARGET_ROOT = "", DISPATCH_ID = "";
  let NO_PULL = 0, MAX_WAIT = "", POLL_INTERVAL = "", REQUEST_ID = "";
  let FINALIZE_ONLY = false;
  let GUARDIAN = "", OBSERVER = "", IN_SEAT_TRAILER = "";
  let WORK_ID = "", CONTROL_SESSION = "", ROLE_REPORT = "";
  const CLOSE_ROWS: string[] = [];
  const need = (i: number, flag: string): string => { const v = argv[i + 1]; if (v === undefined || v === "") { err(`merge_land: ${flag} requires a value`); process.exit(2); } return v; };
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    switch (a) {
      case "--project": PROJECT = need(i, a); MR_ARGS.push(a, PROJECT); i += 2; break;
      case "--pm-id": PM = need(i, a); MR_ARGS.push(a, PM); i += 2; break;
      case "--target-root": TARGET_ROOT = need(i, a); MR_ARGS.push(a, TARGET_ROOT); i += 2; break;
      case "--branch": BRANCH = need(i, a); i += 2; break;
      case "--guardian": GUARDIAN = need(i, a); i += 2; break;
      case "--observer": OBSERVER = need(i, a); i += 2; break;
      case "--work-id": WORK_ID = need(i, a); i += 2; break;
      case "--control-session": CONTROL_SESSION = need(i, a); i += 2; break;
      case "--report": ROLE_REPORT = need(i, a); i += 2; break;
      case "--seat-trailer": IN_SEAT_TRAILER = need(i, a); i += 2; break;
      case "--dispatch-id": case "--id": DISPATCH_ID = need(i, a); i += 2; break;
      case "--no-pull": NO_PULL = 1; i += 1; break;
      case "--close-row": CLOSE_ROWS.push(need(i, a)); i += 2; break;
      case "--max-wait": MAX_WAIT = need(i, a); i += 2; break;
      case "--poll-interval": POLL_INTERVAL = need(i, a); i += 2; break;
      case "--request-id": REQUEST_ID = need(i, a); i += 2; break;
      case "--finalize-only": FINALIZE_ONLY = true; i += 1; break;
      case "-h": case "--help": process.stdout.write(HELP); process.exit(0);
      default: MR_ARGS.push(a); i += 1; break;
    }
  }
  // W-622 (blueprint §2.1) / G-2 — check the forwarding promise before spawning.
  //
  // The banner offers "…any other merge_request.ts flag…" and the default branch
  // above forwards ANY unrecognized token. Those are not the same set: a flag
  // belonging to a different tool is forwarded happily and dies one process later
  // as `merge_request: unknown arg: --rebind-authority`, which reads as a bug in
  // merge_request rather than "merge_land does not take this flag". A PM lost a
  // round to exactly that.
  //
  // This narrows nothing: every flag merge_request accepts still forwards. What
  // changes is WHERE and HOW a flag it never accepted is reported.
  const forwardedUnknown = MR_ARGS.filter((token) => token.startsWith("--") && !MERGE_REQUEST_FLAGS.includes(token));
  if (forwardedUnknown.length) {
    err(`merge_land: not a merge_request flag: ${forwardedUnknown.join(" ")}`);
    err("merge_land: merge_land forwards unrecognized flags to merge_request.ts, so a flag must belong to one of the two.");
    err(`merge_land: merge_land's own flags: ${MERGE_LAND_FLAGS.join(" ")}`);
    err(`merge_land: merge_request's flags: ${MERGE_REQUEST_FLAGS.join(" ")}`);
    for (const token of forwardedUnknown) {
      const owner = OTHER_TOOL_FLAG_OWNERS[token];
      // Only when the flag demonstrably belongs elsewhere: pointing at the right
      // tool is the difference between one round and three.
      if (owner) err(`merge_land: ${token} is a ${owner} flag — run ${owner} directly for it, not through merge_land.`);
    }
    return 2;
  }
  if (IN_SEAT_TRAILER !== "" && IN_SEAT_TRAILER !== "checked" && IN_SEAT_TRAILER !== "skip") {
    err(`merge_land: --seat-trailer must be 'checked' or 'skip' (got '${IN_SEAT_TRAILER}')`); return 2;
  }
  if (!PROJECT || !PM) { err("merge_land: --project and --pm-id are required"); return 2; }
  if (FINALIZE_ONLY !== !!REQUEST_ID) {
    err("merge_land: --finalize-only and --request-id <landed-request-id> are required together");
    return 2;
  }
  const GIT_ROOT = TARGET_ROOT || PROJECT;
  const PM_ROOT = `${PROJECT}/__garelier/${PM}`;
  const controlRoots = garelierControlRoots(PROJECT, GIT_ROOT, PM);
  if (FINALIZE_ONLY) {
    return finalizeOnlyLand({ project: PROJECT, gitRoot: GIT_ROOT, pmId: PM, requestId: REQUEST_ID, noPull: NO_PULL === 1 });
  }
  let reviewedAuthorityRevision: number | undefined;
  let authenticatedSettlementWriteSet: ControlSettlementWrite[] = [];
  let generatedSettlementWrites: ControlSettlementWrite[] = [];
  let guard: GarelierOperationGuard;
  try { guard = acquireGarelierOperationGuard(controlRoots, CONTROL_SESSION || `merge-land-${process.pid}`, "merge-land"); }
  catch (error) { err(`merge_land: ${(error as Error).message}`); return 2; }

  // ── (W-017 a) resolve --branch from --dispatch-id ─────────────────────────
  let BRANCH_ERR = "";
  if (!BRANCH && DISPATCH_ID) {
    const checkout = dispatchPaths(PROJECT, PM, DISPATCH_ID).checkout;
    if (!existsSync(checkout)) {
      BRANCH_ERR = `--dispatch-id ${DISPATCH_ID} given but no dispatch checkout at ${checkout} (prepare it first, or it was already cleaned up) — or pass --branch explicitly`;
    } else {
      const r = runSync(["git", "-C", checkout, "symbolic-ref", "--short", "HEAD"]);
      BRANCH = r.code === 0 ? r.stdout.trim() : "";
      if (BRANCH) err(`merge_land: resolved --branch ${BRANCH} from dispatch #${DISPATCH_ID} checkout`);
      else BRANCH_ERR = `dispatch #${DISPATCH_ID} checkout at ${checkout} is not on a branch (detached HEAD?) — pass --branch explicitly`;
    }
  }

  // dispatch id for cleanup: explicit, else a canonical dispatch-bearing lane.
  if (!DISPATCH_ID && BRANCH) DISPATCH_ID = dispatchIdFromBranch(BRANCH);

  // ── W-372: base-behind detection at merge-submit time ─────────────────────
  // Advisory only (never a hard block — the merge gate is the final net). See
  // computeBaseBehindStudio/detectBaseBehindAtSubmit above for the rationale.
  let BASE_BEHIND: BaseBehindStatus | null = null;
  if (DISPATCH_ID) {
    let integrationBranch = "";
    try { integrationBranch = loadConfig(PROJECT, PM).branches.integration; } catch { integrationBranch = ""; }
    BASE_BEHIND = detectBaseBehindAtSubmit({
      contextPath: dispatchPaths(PROJECT, PM, DISPATCH_ID).context,
      gitRoot: GIT_ROOT,
      integrationBranch,
    });
    if (BASE_BEHIND) err(baseBehindWarning(DISPATCH_ID, BRANCH, BASE_BEHIND));
  }
  const BASE_BEHIND_JSON = baseBehindJsonField(BASE_BEHIND);

  let CONTROL_SCHEMA: number | null = null;
  try {
    const binding = resolveMergeLandControlBinding({
      project: PROJECT, targetRoot: GIT_ROOT, pmId: PM, dispatchId: DISPATCH_ID,
      workId: WORK_ID, sessionId: CONTROL_SESSION, reportPath: ROLE_REPORT,
      ensureClaim: !!DISPATCH_ID,
      requireClaim: false,
      allowMergeReady: true,
      deferMutation: true,
      validateAuthorityRefresh: false,
      guard,
    });
    CONTROL_SCHEMA = binding.schema;
    WORK_ID = binding.workId;
    CONTROL_SESSION = binding.sessionId;
    ROLE_REPORT = binding.reportPath;
    reviewedAuthorityRevision = binding.workRevision;
  } catch (error) {
    const message = (error as Error).message;
    err(`merge_land: schema-aware control binding rejected: ${message}`);
    if (DISPATCH_ID) {
      if (/claim belongs to .* not |Work already has an active claim/.test(message)) {
        err("merge_land: foreign-session claims are never stolen by merge_land; repair the studio-side Control claim only; do not touch or base-track the reviewed candidate branch because its review SHA is sealed.");
        const context = dispatchPaths(PROJECT, PM, DISPATCH_ID).context;
        let boundWork = WORK_ID;
        try { boundWork ||= String((JSON.parse(readFileSync(context, "utf8")) as { control?: { work_id?: unknown } }).control?.work_id ?? ""); } catch { /* fallback below */ }
        err(`NEXT_COMMAND: garelier control get ${JSON.stringify(boundWork)} --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --format json`);
      } else {
        err(`NEXT_COMMAND: bun ${ENTRY_DIR}/merge_land.ts --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --dispatch-id ${JSON.stringify(DISPATCH_ID)}`);
      }
    }
    return 2;
  } finally { guard.release(); }
  if (CONTROL_SCHEMA !== 3) {
    err(`merge_land: unsupported control schema_version ${CONTROL_SCHEMA ?? "missing"}; only schema_version 3 is accepted`);
    return 2;
  }
  if (CONTROL_SCHEMA === 3) {
    if (CLOSE_ROWS.some((id) => id !== WORK_ID)) {
      err(`merge_land: schema-v${CONTROL_SCHEMA} --close-row must match the bound Work/Backlog ${WORK_ID}; canonical state/evidence replaces dashboard row deletion.`);
      return 2;
    }
    MR_ARGS.push("--work-id", WORK_ID, "--control-session", CONTROL_SESSION);
    if (ROLE_REPORT) MR_ARGS.push("--report", ROLE_REPORT);
  }

  // ── seat-trailer preflight (guardian round-2/3, W-051) ────────────────────
  let SEAT_TRAILER_ERR = "";
  if (DISPATCH_ID) {
    const { context: seatCtx, checkout: seatCheckout } = dispatchPaths(PROJECT, PM, DISPATCH_ID);
    if (existsSync(seatCtx) && existsSync(seatCheckout)) {
      const ctxText = (() => { try { return readFileSync(seatCtx, "utf8"); } catch { return ""; } })();
      const seatCommitMode = firstMatch(ctxText, /"commit_mode":\s*"([^"]*)"/);
      let seatIsProxy = 0, seatUnreadable = 0;
      if (seatCommitMode === "proxy") seatIsProxy = 1;
      else if (seatCommitMode === "self") seatIsProxy = 0;
      else {
        const seatModel = firstMatch(ctxText, /"model":\s*"([^"]*)"/);
        if (/codex/.test(seatModel)) seatIsProxy = 1;
        else if (!seatCommitMode && !seatModel) seatUnreadable = 1;
      }
      if (seatIsProxy === 1) {
        if (IN_SEAT_TRAILER) {
          err(`merge_land: seat-trailer check skipped for dispatch #${DISPATCH_ID} — explicit --seat-trailer ${IN_SEAT_TRAILER} override`);
        } else {
          const seatBaseSha = firstMatch(ctxText, /"base_sha":\s*"([^"]*)"/);
          const seatLintTs = `${CORE_SCRIPTS}/lint_commits.ts`;
          let seatHandover = 0;
          if (seatBaseSha && existsSync(seatLintTs)) {
            const summaryJson = runSync(["bun", seatLintTs, "--range", seatBaseSha, seatCheckout, "--seat-summary"]).stdout;
            const seatTotal = firstMatch(summaryJson, /"total":([0-9]*)/);
            const seatSelf = firstMatch(summaryJson, /"self":([0-9]*)/);
            if (seatTotal && parseInt(seatTotal, 10) > 0 && seatTotal === seatSelf) {
              seatHandover = 1;
              err(`merge_land: seat handover detected: context.json commit_mode=proxy but branch carries self trailers (${seatTotal}/${seatTotal} commits since ${seatBaseSha}) — switching preflight to self-mode (W-051)`);
            }
            if (seatHandover !== 1) {
              const lint = runSync(["bun", seatLintTs, "--range", seatBaseSha, seatCheckout, "--require-seat-trailer"]);
              if (lint.code !== 0) {
                err(lint.stdout + lint.stderr);
                SEAT_TRAILER_ERR = `dispatch #${DISPATCH_ID} is commit_mode=proxy (or codex-model-inferred) but one or more commits on ${BRANCH || "<unresolved>"} (since ${seatBaseSha}) fail --require-seat-trailer (missing/malformed Garelier-Seat trailer — see lint output on stderr above); the Dock must inject/fix the trailer per dispatch_prepare.ts's COMMIT_RULE duty 2/3 before landing, or pass --seat-trailer checked if you have manually verified it`;
              }
            }
          }
        }
      } else if (seatUnreadable === 1) {
        if (IN_SEAT_TRAILER) {
          err(`merge_land: seat-trailer check skipped for dispatch #${DISPATCH_ID} — context.json content unreadable (neither commit_mode nor model resolved), explicit --seat-trailer ${IN_SEAT_TRAILER} override given`);
        } else {
          SEAT_TRAILER_ERR = `dispatch #${DISPATCH_ID}'s context.json (${seatCtx}) exists but its content is unreadable — neither routing.commit_mode nor routing.model resolved to a value (corrupted/emptied, not merely a stripped field); cannot determine whether this was a commit_mode=proxy dispatch needing a Garelier-Seat trailer check (round-3 residual: fail-closed, same boundary as an unresolvable container); pass --seat-trailer checked (you manually verified the commits) or --seat-trailer skip (this dispatch needs no check) to proceed`;
        }
      }
    } else if (IN_SEAT_TRAILER) {
      err(`merge_land: seat-trailer check skipped for dispatch #${DISPATCH_ID} — container unresolvable, explicit --seat-trailer ${IN_SEAT_TRAILER} override given`);
    } else {
      SEAT_TRAILER_ERR = `dispatch #${DISPATCH_ID}'s container/context.json is unresolvable (${seatCtx} / ${seatCheckout}) — cannot determine whether this was a commit_mode=proxy dispatch needing a Garelier-Seat trailer check (round-3: fail-closed, since the role itself can delete/strip this file); pass --seat-trailer checked (you manually verified the commits) or --seat-trailer skip (this dispatch needs no check) to proceed`;
    }
  }

  // ── (W-017 c) auto-read Guardian/Observer verdicts from markers ───────────
  const SLUG = BRANCH.includes("/") ? BRANCH.slice(BRANCH.lastIndexOf("/") + 1) : BRANCH;
  let GUARDIAN_SRC = "flag", GMARKER = "", OMARKER = "";
  let GUARDIAN_REPORT = "", OBSERVER_REPORT = "";
  if (BRANCH) {
    GMARKER = `${PM_ROOT}/runtime/guardian/results/${SLUG}-guardian.md`;
    OMARKER = `${PM_ROOT}/runtime/observer/results/${SLUG}-observer.md`;
    if (!GUARDIAN && existsSync(GMARKER)) {
      GUARDIAN = readMarkerVerdict(GMARKER);
      if (GUARDIAN) { GUARDIAN_SRC = "auto"; GUARDIAN_REPORT = resolve(GMARKER); err(`merge_land: auto-read Guardian verdict '${GUARDIAN}' from ${GMARKER}`); }
    }
    if (!OBSERVER && existsSync(OMARKER)) {
      OBSERVER = readMarkerVerdict(OMARKER);
      if (OBSERVER) { OBSERVER_REPORT = resolve(OMARKER); err(`merge_land: auto-read Observer verdict '${OBSERVER}' from ${OMARKER}`); }
    }
  }

  try {
    if (GUARDIAN && GUARDIAN_SRC === "flag") {
      const resolved = resolveMergeLandVerdictInput(GUARDIAN, "Guardian");
      GUARDIAN = resolved.verdict;
      GUARDIAN_REPORT = resolved.reportPath;
      if (resolved.source === "file") err(`merge_land: read Guardian verdict '${GUARDIAN}' from explicit report ${GUARDIAN_REPORT}`);
    }
    if (OBSERVER) {
      const resolved = resolveMergeLandVerdictInput(OBSERVER, "Observer");
      OBSERVER = resolved.verdict;
      OBSERVER_REPORT ||= resolved.reportPath;
      if (resolved.source === "file") err(`merge_land: read Observer verdict '${OBSERVER}' from explicit report ${OBSERVER_REPORT}`);
    }
  } catch (error) {
    const retry = `bun ${ENTRY_DIR}/merge_land.ts --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --dispatch-id ${JSON.stringify(DISPATCH_ID)}`;
    err(`merge_land: ${(error as Error).message}\nNEXT_COMMAND: ${retry}`);
    return 2;
  }

  // ── (W-017 b) one-shot pre-validation ─────────────────────────────────────
  const ERRORS: string[] = [];
  if (!BRANCH) {
    ERRORS.push(BRANCH_ERR || "no merge branch: pass --branch <workbench-branch>, or --dispatch-id <N> (alias --id) to auto-resolve it from the dispatch container");
  }
  if (SEAT_TRAILER_ERR) ERRORS.push(SEAT_TRAILER_ERR);
  if (!GUARDIAN) {
    if (BRANCH && existsSync(GMARKER)) {
      ERRORS.push(`Guardian verdict required: the marker at ${GMARKER} is present but MALFORMED (no bare canonical token under '## Verdict' — see the stderr note above and templates/gate_verdict.md); have the gate role fix it, or pass --guardian <PASS|PASS_WITH_NOTES> to override`);
    } else if (BRANCH) {
      ERRORS.push(`Guardian verdict required: pass --guardian <PASS|PASS_WITH_NOTES>, or run Guardian so a verdict marker exists at ${GMARKER} ([guardian_policy] require_for_all_merges rejects a merge without one)`);
    } else {
      ERRORS.push("Guardian verdict required: pass --guardian <PASS|PASS_WITH_NOTES> (or resolve --branch/--dispatch-id first so the Guardian marker can be auto-read)");
    }
  } else if (GUARDIAN_SRC === "auto") {
    if (GUARDIAN !== "PASS" && GUARDIAN !== "PASS_WITH_NOTES") {
      ERRORS.push(`auto-read Guardian verdict is ${GUARDIAN} (from ${GMARKER}), not PASS/PASS_WITH_NOTES — nothing to land; re-run Guardian, or pass --guardian explicitly to override`);
    }
  }
  if (ERRORS.length > 0) {
    err("merge_land: cannot submit — resolve the following first:");
    for (const e of ERRORS) err(`  - ${e}`);
    err("");
    process.stderr.write(HELP);
    return 2;
  }

  let CONTROL_PREFLIGHT: MergeLandControlPreflight;
  try {
    CONTROL_PREFLIGHT = mergeLandControlPreflight({
      project: PROJECT,
      gitRoot: GIT_ROOT,
      pmId: PM,
      workId: WORK_ID,
      sessionId: CONTROL_SESSION,
      dispatchId: DISPATCH_ID,
      persistReceipt: true,
    });
    err(
      `merge_land: Control preflight PASS digest=${CONTROL_PREFLIGHT.digest} `
      + `files=${CONTROL_PREFLIGHT.files}/${CONTROL_TREE_DEFAULT_LIMITS.files} `
      + `bytes=${CONTROL_PREFLIGHT.bytes}/${CONTROL_TREE_DEFAULT_LIMITS.bytes} `
      + `projected_files=${CONTROL_PREFLIGHT.projected_files} projected_bytes=${CONTROL_PREFLIGHT.projected_bytes} `
      + `legacy_raw_report_logs=${CONTROL_PREFLIGHT.raw_report_logs.length} migration=PM-attended-nonblocking`,
    );
  } catch (error) {
    const detail = (error as Error).message;
    const date = new Date().toISOString().slice(0, 10);
    const inspection = `inspections/quality/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}-control-report-retention.md`;
    const migration = `bun ${ENTRY_DIR}/migrate_control_report_logs.ts --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --inspection ${JSON.stringify(inspection)}`;
    const status = `git -C ${JSON.stringify(GIT_ROOT)} status --short -- ${JSON.stringify(controlRelativePath(GIT_ROOT, garelierControlRoots(PROJECT, GIT_ROOT, PM).controlRoot))}`;
    const staged = `git -C ${JSON.stringify(GIT_ROOT)} diff --cached --name-status`;
    const recovery = detail.includes("merge preflight refuses staged paths:") ? staged : status;
    err(`merge_land: Control preflight refused before merge submission: ${detail}`);
    err(`NEXT_COMMAND: ${detail.startsWith("control-settlement-baseline-dirty:") ? recovery : migration}`);
    out(`{"status":"preflight_refused","failure_reason":"${jesc(detail)}","next_command":"${jesc(detail.startsWith("control-settlement-baseline-dirty:") ? recovery : migration)}","studio_unchanged":true,"cleaned_up":false${BASE_BEHIND_JSON}}`);
    return 2;
  }

  // Bind Control only after the sealed Guardian/Observer round has passed
  // pre-validation. A ready row or an expired same-session lease is routine
  // studio-side residue; the reviewed candidate branch must remain untouched.
  let reviewedAuthorityRefresh: MergeLandAuthorityRefresh | undefined;
  let reviewedClaimReservation: DispatchClaimReservation | undefined;
  let reviewedReservationUntil: Date;
  try {
    const waitBudget = mergeLandAwaitArgs("dock_merge.ts", PROJECT, PM, "pending", MAX_WAIT, POLL_INTERVAL).timeoutMs;
    reviewedReservationUntil = new Date(Date.now() + waitBudget + 60_000);
  } catch (error) {
    err(`merge_land: ${(error as Error).message}`);
    return 2;
  }
  const ensureReviewedControlReservation = (): string | null => {
    let claimGuard: GarelierOperationGuard;
    try { claimGuard = acquireGarelierOperationGuard(controlRoots, CONTROL_SESSION, "merge-land-reviewed-control"); }
    catch (error) { return (error as Error).message; }
    try {
      const binding = resolveMergeLandControlBinding({
        project: PROJECT, targetRoot: GIT_ROOT, pmId: PM, dispatchId: DISPATCH_ID,
        workId: WORK_ID, sessionId: CONTROL_SESSION, reportPath: ROLE_REPORT,
        ensureClaim: !!DISPATCH_ID, requireClaim: true, allowMergeReady: true,
        deferMutation: true, authorityRefresh: reviewedAuthorityRefresh,
        expectedAuthorityRevision: reviewedAuthorityRevision,
        mergeReservationUntil: reviewedReservationUntil,
        guard: claimGuard,
      });
      if (binding.mergeReservation) reviewedClaimReservation = binding.mergeReservation;
      reviewedAuthorityRevision = binding.workRevision;
      return null;
    } catch (error) {
      return (error as Error).message;
    } finally {
      claimGuard.release();
    }
  };
  const rollbackReviewedClaimReservation = (): void => {
    if (!reviewedClaimReservation) return;
    let claimGuard: GarelierOperationGuard | null = null;
    try {
      claimGuard = acquireGarelierOperationGuard(controlRoots, CONTROL_SESSION, "merge-land-reservation-rollback");
      const rollback = rollbackDispatchClaimReservation({
        roots: controlRoots,
        workId: WORK_ID,
        sessionId: CONTROL_SESSION,
        reservation: reviewedClaimReservation,
        namespaceLock: claimGuard.lock,
      });
      reviewedClaimReservation = undefined;
      err(rollback === "restored"
        ? `merge_land: released pre-gate Control reservation for ${WORK_ID} and restored its prior claim; candidate branch remains sealed.`
        : `merge_land: pre-gate Control reservation for ${WORK_ID} was already released by terminal gate settlement; candidate branch remains sealed.`);
    } catch (error) {
      err(`merge_land: pre-gate Control reservation rollback refused; preserving reservation until expiry: ${(error as Error).message}`);
    } finally {
      claimGuard?.release();
    }
  };
  const readAuthorityRefresh = (stdout: string): MergeLandAuthorityRefresh => {
    const payload = stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>).at(-1);
    const previousRevision = Number(payload?.previous_authority_revision);
    const currentRevision = Number(payload?.current_authority_revision);
    const evidencePath = String(payload?.evidence_snapshot_path ?? "");
    const evidenceHash = String(payload?.evidence_snapshot_hash ?? "");
    if (!Number.isSafeInteger(previousRevision) || !Number.isSafeInteger(currentRevision)
      || !evidencePath || !/^[0-9a-f]{64}$/.test(evidenceHash)) {
      throw new Error("authority rebind did not return a complete revision/evidence binding");
    }
    return { previousRevision, currentRevision, evidencePath, evidenceHash };
  };
  let controlBindingError = ensureReviewedControlReservation();
  if (controlBindingError && DISPATCH_ID && GUARDIAN_REPORT
    && /Work authority changed|not dispatchable from ready/.test(controlBindingError)) {
    const rebind = runSync(["bun", `${ENTRY_DIR}/dispatch_prepare.ts`,
      "--project", PROJECT, "--target-root", GIT_ROOT, "--pm-id", PM,
      "--rebind-authority", "--id", DISPATCH_ID, "--evidence", GUARDIAN_REPORT]);
    if (rebind.code === 0) {
      try {
        reviewedAuthorityRefresh = readAuthorityRefresh(rebind.stdout);
        reviewedAuthorityRevision = reviewedAuthorityRefresh.currentRevision;
        err(`merge_land: refreshed reviewed Control authority for dispatch #${DISPATCH_ID}; candidate branch remains sealed.`);
        controlBindingError = ensureReviewedControlReservation();
      } catch (error) {
        controlBindingError = (error as Error).message;
      }
    } else {
      controlBindingError = `${controlBindingError}; studio-side authority refresh failed: ${rebind.stderr.trim()}`;
    }
  }
  if (controlBindingError) {
    err(`merge_land: schema-aware control binding rejected after review: ${controlBindingError}`);
    err("merge_land: repair the studio-side Control/claim residue only; do not touch or base-track the reviewed candidate branch because its review SHA is sealed.");
    if (/claim belongs to .* not |foreign-session claims/.test(controlBindingError)) {
      err(`NEXT_COMMAND: garelier control get ${JSON.stringify(WORK_ID)} --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --format json`);
    } else {
      err(`NEXT_COMMAND: bun ${ENTRY_DIR}/merge_land.ts --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --dispatch-id ${JSON.stringify(DISPATCH_ID)}`);
    }
    rollbackReviewedClaimReservation();
    return 2;
  }

  // W-808: a dispatch-bound land runs the exact bound PM declaration, or the
  // project's fixed set when both authority and context declare no override.
  // Explicit forwarded commands may repeat that set, but cannot add or remove
  // a command. No changed-path or extension classification participates.
  if (DISPATCH_ID) {
    const contextPath = dispatchPaths(PROJECT, PM, DISPATCH_ID).context;
    let selected: string[] = [];
    try {
      const context = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, any>;
      const bound = assertBoundRoleQualityGateSelection({
        project_root: PROJECT,
        pm_id: PM,
        identity: dispatchExecutionIdentity(DISPATCH_ID),
        reference: roleBindingFromContext(context),
        context_selection: context.quality_gate_selection,
      });
      const commands = bound?.current.commands ?? loadConfig(PROJECT, PM).qualityGate.fullCommands;
      if (commands.length === 0) throw new Error("project-default quality gate contains no commands");
      selected = commands.map((command) => command.trim());
    } catch (error) {
      err(`merge_land: dispatch gate-set binding refused: ${(error as Error).message} (${contextPath})`);
      rollbackReviewedClaimReservation();
      return 2;
    }
    const explicit: string[] = [];
    for (let i = 0; i < MR_ARGS.length; i += 1) {
      if (MR_ARGS[i] === "--quality-gate") explicit.push(String(MR_ARGS[i + 1] ?? "").trim());
    }
    if (explicit.length > 0 && JSON.stringify(explicit) !== JSON.stringify(selected)) {
      err(`merge_land: GATE_SET_UPDATED_OR_MISMATCH current=${JSON.stringify(selected)} requested=${JSON.stringify(explicit)}`);
      rollbackReviewedClaimReservation();
      return 2;
    }
    if (explicit.length === 0) {
      for (const command of selected) MR_ARGS.push("--quality-gate", command);
    }
  }

  // forward resolved branch + verdicts to merge_request.
  MR_ARGS.push("--branch", BRANCH, "--guardian", GUARDIAN);
  if (GUARDIAN_REPORT) MR_ARGS.push("--guardian-report", GUARDIAN_REPORT);
  if (DISPATCH_ID) MR_ARGS.push("--dispatch-id", DISPATCH_ID, "--aftercare-binding", "dispatch");
  else MR_ARGS.push("--aftercare-binding", "branch_only");
  if (OBSERVER) MR_ARGS.push("--observer", OBSERVER);
  if (OBSERVER_REPORT) MR_ARGS.push("--observer-report", OBSERVER_REPORT);
  const messageIndex = argv.indexOf("--message");
  const suppliedMessage = messageIndex >= 0 ? argv[messageIndex + 1] ?? "" : "";
  const trailer = suppliedMessage.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("Garelier:"));
  const trailerFields = trailer?.match(/^Garelier:\s+(\S+)\s+(\S+)\s+(W-\d+)$/);
  if (suppliedMessage && (!trailerFields || trailerFields[1] !== PM || trailerFields[3] !== WORK_ID)) {
    err(`merge_land: schema-v${CONTROL_SCHEMA} merge message must carry the bound trailer 'Garelier: ${PM} <actor> ${WORK_ID}'.`);
    rollbackReviewedClaimReservation();
    return 2;
  }
  if (!suppliedMessage) {
    MR_ARGS.push("--message", `chore(merge): land ${WORK_ID}\n\nGuardian ${GUARDIAN}${OBSERVER ? `; Observer ${OBSERVER}` : ""}.\n\nGarelier: ${PM} merge ${WORK_ID}`);
  }

  // ── W-346 FR5: land-entry chokepoint — refuse early, touching nothing ─────
  // merge_request/pollMergeGate/merge-gate.ts each re-check independently; this
  // early exit just gives the operator one clean refusal instead of a submit
  // that queues nothing. Pass-through when no closure state exists.
  try {
    const integrationBranch = loadConfig(PROJECT, PM).branches.integration;
    const closureVerdict = assertChokepointAllowed(resolve(PROJECT).replace(/\\/g, "/"), PM, integrationBranch, { requestKind: "ordinary" });
    if (!closureVerdict.allowed) {
      err(`merge_land: ${closureVerdict.reason} — not submitting; retry after the closure lease closes (W-346)`);
      out(`{"status":"closure_blocked","failure_reason":"${jesc(closureVerdict.reason)}","cleaned_up":false${BASE_BEHIND_JSON}}`);
      rollbackReviewedClaimReservation();
      return 3;
    }
  } catch { /* config unreadable here → let the submit path surface its own error */ }

  // ── 1. submit WITHOUT poll ─────────────────────────────────────────────────
  const tmpDir = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/merge_land-`);
  const mrErrFile = `${tmpDir}/mr.err`;
  const submitStart = Math.floor(Date.now() / 1000);
  let mr = runSync(["bun", `${ENTRY_DIR}/merge_request.ts`, "--no-poll", ...MR_ARGS]);
  if (mr.code !== 0 && DISPATCH_ID && GUARDIAN_REPORT
    && /item authority source changed after authorization/.test(mr.stderr)) {
    const rebind = runSync(["bun", `${ENTRY_DIR}/dispatch_prepare.ts`,
      "--project", PROJECT, "--target-root", GIT_ROOT, "--pm-id", PM,
      "--rebind-authority", "--id", DISPATCH_ID, "--evidence", GUARDIAN_REPORT]);
    if (rebind.code !== 0) {
      err(`${mr.stderr}${rebind.stderr}`);
      err(`NEXT_COMMAND: bun ${ENTRY_DIR}/dispatch_prepare.ts --project ${JSON.stringify(PROJECT)} --target-root ${JSON.stringify(GIT_ROOT)} --pm-id ${JSON.stringify(PM)} --rebind-authority --id ${DISPATCH_ID} --evidence ${JSON.stringify(GUARDIAN_REPORT)}`);
      cleanupTmp(tmpDir);
      rollbackReviewedClaimReservation();
      return rebind.code;
    }
    try {
      reviewedAuthorityRefresh = readAuthorityRefresh(rebind.stdout);
      reviewedAuthorityRevision = reviewedAuthorityRefresh.currentRevision;
    }
    catch (error) {
      err(`merge_land: ${(error as Error).message}`);
      cleanupTmp(tmpDir);
      rollbackReviewedClaimReservation();
      return 2;
    }
    const reboundError = ensureReviewedControlReservation();
    if (reboundError) {
      err(`merge_land: reviewed Control reservation failed after authority rebind: ${reboundError}`);
      cleanupTmp(tmpDir);
      rollbackReviewedClaimReservation();
      return 2;
    }
    err(`merge_land: authority changed; rebound dispatch #${DISPATCH_ID} from ${GUARDIAN_REPORT} and resubmitting.`);
    mr = runSync(["bun", `${ENTRY_DIR}/merge_request.ts`, "--no-poll", ...MR_ARGS]);
  }
  writeFileSync(mrErrFile, mr.stderr);
  if (mr.stderr) process.stderr.write(mr.stderr);
  let REQ_ID = "";
  try { REQ_ID = String((JSON.parse(mr.stdout) as Record<string, unknown>).request_id ?? ""); } catch { REQ_ID = ""; }
  if (!REQ_ID && mr.code === 0) {
    const rec = runSync(["bun", `${ENTRY_DIR}/merge_request_id_recover.ts`,
      "--stderr-file", mrErrFile,
      "--requests-dir", `${PROJECT}/__garelier/${PM}/runtime/merge_gate/requests`,
      "--since", String(submitStart)]);
    REQ_ID = rec.code === 0 ? rec.stdout.trim() : "";
    if (REQ_ID) err(`merge_land: recovered request_id=${REQ_ID} from the request file (stdout parse failed — W-064).`);
  }
  if (!REQ_ID) {
    err(`merge_land: submit produced no request_id (merge_request rc=${mr.code}); no request was created — aborting.`);
    err(`NEXT_COMMAND: bun ${ENTRY_DIR}/merge_land.ts --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --dispatch-id ${JSON.stringify(DISPATCH_ID)}`);
    cleanupTmp(tmpDir);
    rollbackReviewedClaimReservation();
    return 1;
  }

  // ── 2. await through Dock's existing single-poller path ────────────────────
  const dockMergeTs = `${DRIVER_DISPATCH}/dock_merge.ts`;
  if (!existsSync(dockMergeTs)) {
    err(`merge_land: dock_merge.ts not found at ${dockMergeTs}.`);
    err(`NEXT_COMMAND: bun ${JSON.stringify(dockMergeTs)} await --pm-id ${JSON.stringify(PM)} --project ${JSON.stringify(PROJECT)} --request-id ${JSON.stringify(REQ_ID)}`);
    cleanupTmp(tmpDir);
    return 1;
  }
  err(`merge_land: submitted ${REQ_ID}; waiting for the gate result…`);
  const RESULT_FILE = `${PROJECT}/__garelier/${PM}/runtime/merge_gate/results/${REQ_ID}.json`;
  let awaitSpec: ReturnType<typeof mergeLandAwaitArgs>;
  try { awaitSpec = mergeLandAwaitArgs(dockMergeTs, PROJECT, PM, REQ_ID, MAX_WAIT, POLL_INTERVAL); }
  catch (error) { err(`merge_land: ${(error as Error).message}`); cleanupTmp(tmpDir); return 2; }
  const wait = runSync(awaitSpec.command, { timeoutMs: awaitSpec.timeoutMs });
  if (wait.stderr) err(wait.stderr);
  let terminal: Record<string, unknown> = {};
  try { terminal = JSON.parse(wait.stdout) as Record<string, unknown>; }
  catch { /* classified below as failed output */ }
  const STATUS_LINE = wait.stdout;
  let STATUS = typeof terminal.status === "string" ? terminal.status : "";
  let DETAIL = typeof terminal.studio_commit === "string"
    ? terminal.studio_commit
    : typeof terminal.failure_reason === "string" ? terminal.failure_reason : "";
  const WAIT_RC = wait.code !== 0 ? wait.code : STATUS === "success" ? 0 : STATUS === "timeout" ? 124 : 1;

  // ── 3. non-success: clean up NOTHING, report ──────────────────────────────
  if (WAIT_RC !== 0) {
    ({ status: STATUS, detail: DETAIL } = classifyMergeLandWaitFailure(WAIT_RC, STATUS_LINE, STATUS, DETAIL));
    if (["aborted", "failed", "conflict", "environment_blocked", "closure_blocked"].includes(STATUS)) {
      rollbackReviewedClaimReservation();
    }
    out(`{"request_id":"${jesc(REQ_ID)}","status":"${jesc(STATUS || "failed")}","failure_reason":"${jesc(DETAIL)}","cleaned_up":false${BASE_BEHIND_JSON}}`);
    err(`NEXT_COMMAND: bun ${JSON.stringify(dockMergeTs)} await --pm-id ${JSON.stringify(PM)} --project ${JSON.stringify(PROJECT)} --request-id ${JSON.stringify(REQ_ID)}${MAX_WAIT ? ` --ceiling-ms ${Number(MAX_WAIT) * 1000}` : ""}`);
    cleanupTmp(tmpDir);
    return WAIT_RC;
  }

  // W-121: defend against a false-success. The waiter maps every non-"success"
  // terminal result (aborted / failed / conflict) to a non-zero exit, but a zero
  // exit paired with a non-success status line (a torn result read, or a future
  // waiter variant) must NOT be mistaken for a landed merge: cleaning up the
  // dispatch and striking the backlog row on an aborted gate is exactly the
  // run_in_background false-success this row was filed for. Report and exit
  // non-zero, cleaning up nothing.
  if (STATUS && STATUS !== "success") {
    if (!DETAIL) DETAIL = firstMatch(STATUS_LINE, /^MERGE_TIMEOUT: (.*)$/m);
    err(`merge_land: gate result status is '${STATUS}', not 'success' (waiter exit ${WAIT_RC}) — NOT cleaning up or closing rows.`);
    rollbackReviewedClaimReservation();
    out(`{"request_id":"${jesc(REQ_ID)}","status":"${jesc(STATUS)}","failure_reason":"${jesc(DETAIL)}","cleaned_up":false${BASE_BEHIND_JSON}}`);
    cleanupTmp(tmpDir);
    return 1;
  }

  // ── wait for OUR lock to clear before cleanup + row close ──────────────────
  const LOCK_ACTIVE = `${PROJECT}/__garelier/${PM}/runtime/merge_gate/locks/active.lock`;
  for (let w = 0; w < 50; w++) {
    if (!existsSync(LOCK_ACTIVE)) break;
    let text = ""; try { text = readFileSync(LOCK_ACTIVE, "utf8"); } catch { text = ""; }
    if (!text.includes(REQ_ID)) break;
    Bun.sleepSync(100);
  }

  let STUDIO_COMMIT = DETAIL;

  if (CONTROL_SCHEMA === 3) {
    const requestArchive = `${PROJECT}/__garelier/${PM}/runtime/merge_gate/archive/${REQ_ID}.request.json`;
    const requestPending = `${PROJECT}/__garelier/${PM}/runtime/merge_gate/requests/${REQ_ID}.json`;
    const requestPath = existsSync(requestArchive) ? requestArchive : requestPending;
    let settlementGuard: GarelierOperationGuard | null = null;
    try {
      const result = JSON.parse(readFileSync(RESULT_FILE, "utf8")) as Record<string, unknown>;
      const studioCommit = typeof result.studio_commit === "string" ? result.studio_commit : STUDIO_COMMIT;
      if (/^[0-9a-f]{40,64}$/.test(studioCommit)) STUDIO_COMMIT = studioCommit;
      if (reviewedAuthorityRevision === undefined) throw new Error("reviewed Work authority revision is missing");
      settlementGuard = acquireGarelierOperationGuard(controlRoots, CONTROL_SESSION, "merge-land-reviewed-settlement");
      if (!hasMergeControlEvidence(controlRoots, WORK_ID, STUDIO_COMMIT, RESULT_FILE)) {
        const inspected = inspectDispatchControlBinding(controlRoots, WORK_ID, CONTROL_SESSION, settlementGuard.lock);
        const currentRevision = planGraphEntityRevision(inspected.work);
        if (currentRevision !== reviewedAuthorityRevision) {
          throw new Error(
            `reviewed Work authority changed during merge gate: ${WORK_ID} `
            + `(expected=${reviewedAuthorityRevision}, current=${currentRevision})`,
          );
        }
        if (!inspected.claim) {
          throw new Error(`merge-bound Control reservation disappeared before durable settlement: ${WORK_ID}`);
        }
        if (inspected.claim.session_id !== CONTROL_SESSION) {
          throw new Error(`merge-bound Backlog claim belongs to another session: ${inspected.claim.session_id}`);
        }
        if (!claimHasLiveMergeReservation(inspected.claim, new Date())) {
          throw new Error(`merge-bound Control reservation expired before durable settlement: ${WORK_ID}`);
        }
        const binding = resolveMergeLandControlBinding({
          project: PROJECT, targetRoot: GIT_ROOT, pmId: PM, dispatchId: DISPATCH_ID,
          workId: WORK_ID, sessionId: CONTROL_SESSION, reportPath: ROLE_REPORT,
          ensureClaim: !!DISPATCH_ID, requireClaim: true, allowMergeReady: true,
          expectedAuthorityRevision: reviewedAuthorityRevision,
          authorityRefresh: reviewedAuthorityRefresh,
          settlementRequestId: REQ_ID,
          guard: settlementGuard,
        });
        reviewedAuthorityRevision = binding.workRevision;
        generatedSettlementWrites = binding.generatedControlWrites;
      }
      const finalized = finalizeLongMergeEvidence({
        roots: controlRoots,
        workId: WORK_ID,
        sessionId: CONTROL_SESSION,
        requestPath,
        resultPath: RESULT_FILE,
        reportPath: ROLE_REPORT,
        studioCommit,
        expectedAuthorityRevision: reviewedAuthorityRevision,
        generatedControlWrites: generatedSettlementWrites,
        guard: settlementGuard,
      });
      authenticatedSettlementWriteSet = finalized.settlement_write_set.length
        ? persistSettlementAuthorization({
            project: PROJECT,
            pmId: PM,
            requestId: REQ_ID,
            workId: WORK_ID,
            studioCommit,
            writeSet: finalized.settlement_write_set,
          })
        : readSettlementAuthorization({
            project: PROJECT,
            pmId: PM,
            requestId: REQ_ID,
            workId: WORK_ID,
            studioCommit,
          });
      err(`merge_land: independent-evidence finalization ${finalized.status} for ${WORK_ID} at ${studioCommit}`);
    } catch (error) {
      err(`merge_land: independent-evidence finalization refused; cleanup skipped: ${(error as Error).message}`);
      out(`{"request_id":"${jesc(REQ_ID)}","status":"failed","failure_reason":"${jesc((error as Error).message)}","cleaned_up":false${BASE_BEHIND_JSON}}`);
      cleanupTmp(tmpDir);
      return 4;
    } finally {
      settlementGuard?.release();
    }
  }

  try {
    const recheck = inspectControlTree(controlRoots.controlRoot);
    err(
      `merge_land: Control settlement recheck of preflight values `
      + `preflight_digest=${CONTROL_PREFLIGHT.digest} preflight_files=${CONTROL_PREFLIGHT.files} preflight_bytes=${CONTROL_PREFLIGHT.bytes} `
      + `settlement_digest=${recheck.digest} settlement_files=${recheck.files} settlement_bytes=${recheck.bytes}`,
    );
  } catch (error) {
    const detail = (error as Error).message;
    err(`merge_land: Control settlement recheck refused; cleanup skipped: ${detail}`);
    out(`{"request_id":"${jesc(REQ_ID)}","status":"settlement_failed","failure_reason":"${jesc(detail)}","cleaned_up":false${BASE_BEHIND_JSON}}`);
    err(`NEXT_COMMAND: bun ${ENTRY_DIR}/merge_land.ts --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --finalize-only --request-id ${JSON.stringify(REQ_ID)} --no-pull`);
    cleanupTmp(tmpDir);
    return 4;
  }

  // ── 4. success: clean up the dispatch + pull ──────────────────────────────
  let CLEANUP_STATUS = "skipped", BRANCH_DELETED = "false";
  const clean = runSync(successfulLandCleanupArgs(ENTRY_DIR, PROJECT, PM, REQ_ID, DISPATCH_ID, TARGET_ROOT), { timeoutMs: SUCCESSFUL_LAND_CLEANUP_TIMEOUT_MS });
  if (clean.stdout) err(clean.stdout);
  if (clean.stderr) err(clean.stderr);
  if (clean.code === 0) {
    CLEANUP_STATUS = firstMatch(clean.stdout, /"cleanup_status":"([^"]*)"/) || "success";
    BRANCH_DELETED = firstMatch(clean.stdout, /"branch_deleted":(true|false)/) || "false";
    if (DISPATCH_ID && !/"container_removed":true/.test(clean.stdout)) {
      CLEANUP_STATUS = "failed: dispatch container remains after aftercare";
      err(`merge_land: dispatch_cleanup reported success but dispatch #${DISPATCH_ID} container remains.`);
      out(`{"request_id":"${jesc(REQ_ID)}","status":"cleanup_failed","studio_commit":"${jesc(STUDIO_COMMIT)}","dispatch_id":"${jesc(DISPATCH_ID)}","branch_deleted":${BRANCH_DELETED || "false"},"cleanup_status":"${jesc(CLEANUP_STATUS)}","pulled":"skipped"${BASE_BEHIND_JSON}}`);
      err(`NEXT_COMMAND: bun ${ENTRY_DIR}/merge_land.ts --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --finalize-only --request-id ${JSON.stringify(REQ_ID)} --no-pull`);
      cleanupTmp(tmpDir);
      return 4;
    }
  } else {
    // W-235 (target-project dispatch): a non-zero exit prints no JSON on stdout (dispatch_cleanup's
    // fail() writes only to stderr), so the old code fell through to the initial
    // "skipped" placeholder — indistinguishable from a genuine no-op and hiding the
    // real refusal reason (e.g. "dispatch Backlog is closed"). Surface both.
    const reason = (clean.stderr.split(/\r?\n/).find((line) => line.trim()) || `dispatch_cleanup exited ${clean.code}`).trim();
    CLEANUP_STATUS = `failed(rc=${clean.code}): ${reason}`;
    err(`merge_land: dispatch_cleanup failed (rc=${clean.code}); cleanup_status recorded as failure, not skipped: ${reason}`);
    out(`{"request_id":"${jesc(REQ_ID)}","status":"cleanup_failed","studio_commit":"${jesc(STUDIO_COMMIT)}","dispatch_id":"${jesc(DISPATCH_ID || "")}","branch_deleted":false,"cleanup_status":"${jesc(CLEANUP_STATUS)}","pulled":"skipped"${BASE_BEHIND_JSON}}`);
    err(`NEXT_COMMAND: ${successfulLandCleanupArgs(ENTRY_DIR, PROJECT, PM, REQ_ID, DISPATCH_ID, TARGET_ROOT).map((part) => JSON.stringify(part)).join(" ")}`);
    cleanupTmp(tmpDir);
    return clean.code || 1;
  }

  let SETTLEMENT_COMMIT = "";
  try {
    const integrationBranch = loadConfig(PROJECT, PM).branches.integration;
    const closure = inspectControlSettlementClosure(controlRoots.controlRoot);
    err(`merge_land: post-aftercare Control closure files=${closure.files} bytes=${closure.bytes} digest=${closure.digest}`);
    const residueBeforeCommit = controlTransactionResidue(controlRoots.controlRoot);
    if (residueBeforeCommit.length) throw new Error(`Control transaction residue remains: ${residueBeforeCommit.join(", ")}`);
    // The aftercare that just ran published this land's gate evidence into
    // Control after the write set above was authorized; take its return (and
    // every other generator's) from the one collector before committing.
    const generated = collectGeneratedControlWrites({
      roots: controlRoots,
      gitRoot: GIT_ROOT,
      workId: WORK_ID,
      sessionId: CONTROL_SESSION,
      requestId: REQ_ID,
    });
    reportGeneratedControlWriteSkips(generated.skipped);
    SETTLEMENT_COMMIT = commitControlSettlement({
      project: PROJECT,
      gitRoot: GIT_ROOT,
      controlRoot: controlRoots.controlRoot,
      integrationBranch,
      pmId: PM,
      workId: WORK_ID,
      sessionId: CONTROL_SESSION,
      requestId: REQ_ID,
      studioCommit: STUDIO_COMMIT,
      resultPath: RESULT_FILE,
      authenticatedWriteSet: mergeSettlementWriteSets(authenticatedSettlementWriteSet, generated.writes),
    });
    rmSync(settlementAuthorizationPath(PROJECT, PM, REQ_ID), { force: true });
    const transactionResidue = controlTransactionResidue(controlRoots.controlRoot);
    if (transactionResidue.length) throw new Error(`Control transaction residue remains: ${transactionResidue.join(", ")}`);
    const reportChanges = controlSettlementChangedPaths(GIT_ROOT, join(controlRoots.controlRoot, "reports"));
    const foreignReports = foreignClaimOwnedPaths(controlRoots, GIT_ROOT, WORK_ID, reportChanges);
    const reportResidue = reportChanges.filter((path) => !foreignReports.has(path));
    if (reportResidue.length) throw new Error(`untracked or uncommitted Control report residue remains: ${reportResidue.join(", ")}`);
    if (CONTROL_PREFLIGHT.receipt_path && existsSync(CONTROL_PREFLIGHT.receipt_path)) rmSync(CONTROL_PREFLIGHT.receipt_path, { force: true });
    err(`merge_land: Control settlement committed at ${SETTLEMENT_COMMIT}; container/transaction/report residue check PASS.`);
  } catch (error) {
    const detail = (error as Error).message;
    err(`merge_land: Control settlement commit/refuse after landing: ${detail}`);
    out(`{"request_id":"${jesc(REQ_ID)}","status":"settlement_failed","studio_commit":"${jesc(STUDIO_COMMIT)}","failure_reason":"${jesc(detail)}","cleaned_up":true${BASE_BEHIND_JSON}}`);
    emitSettlementRecovery(detail, PROJECT, PM, REQ_ID);
    cleanupTmp(tmpDir);
    return 4;
  }

  // pull (best-effort, non-fatal).
  let PULLED = "skipped";
  if (NO_PULL !== 1) {
    const pull = runSync(["git", "-C", GIT_ROOT, "pull", "--ff-only"]);
    if (pull.code === 0) PULLED = "true";
    else { PULLED = "false"; err(`merge_land: git pull --ff-only skipped/failed: ${(pull.stderr.split("\n")[0] || "")}`); }
  }

  // ── 5. row close (W-093) ──────────────────────────────────────────────────
  let ROW_CLOSE_FIELD = "";
  if (CLOSE_ROWS.length > 0) {
    ROW_CLOSE_FIELD = `,"row_close":"typed-control"`;
    err(`merge_land: schema-v${CONTROL_SCHEMA} Work/Backlog ${WORK_ID} was updated through the transactional merge evidence path; no dashboard row was read, written, or deleted.`);
  }

  out(`{"request_id":"${jesc(REQ_ID)}","status":"success","studio_commit":"${jesc(STUDIO_COMMIT)}","settlement_commit":"${jesc(SETTLEMENT_COMMIT)}","dispatch_id":"${jesc(DISPATCH_ID || "")}","branch_deleted":${BRANCH_DELETED || "false"},"cleanup_status":"${jesc(CLEANUP_STATUS || "skipped")}","pulled":"${PULLED}"${ROW_CLOSE_FIELD}${BASE_BEHIND_JSON}}`);
  cleanupTmp(tmpDir);
  return 0;
}

function cleanupTmp(dir: string): void { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

// Guard the CLI entry so exported helpers remain importable by unit tests
// without executing the full merge ritual.
if (import.meta.main) process.exit(main());
