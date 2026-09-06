import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.ts";
import { assertFinalizeOrderOk } from "../integration_closure.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";
import { assertClaimControlBinding, readControlClaim, releaseClaim } from "./claims.ts";
import { atomicWriteRuntimeFile } from "./diagnostics.ts";
import { validateGateEvidence } from "./evidence_validation.ts";
import {
  acquireGarelierOperationGuard,
  captureEvidenceSource,
  hasMergeControlEvidence,
  recordMergeControlOutcome,
  type GarelierControlRoots,
} from "./garelier_integration.ts";
import { planLandingVerification } from "./landing_state.ts";
import { loadPlanGraphModel } from "./plan_graph_model.ts";
import type { PlanGraphControlModel } from "./plan_graph_types.ts";
import { planBacklogUpdate, planGraphEntityRevision, planGraphEvidenceReferences, planGraphRuntimeCallbacks, planGraphTransactionCallbacks } from "./plan_graph_write.ts";
import { canonicalJson, sha256 } from "./serialization.ts";
import { assertSessionControlBinding, loadRuntimeControlSnapshot, readControlSession } from "./sessions.ts";
import { resolveControlNamespace, runControlFilePlanTransaction, type NamespaceLock } from "./transaction.ts";
import type { EvidenceReference } from "./types.ts";

const FULL_SHA = /^[0-9a-f]{40,64}$/;
const ELIGIBLE = new Set(["triage", "ready", "active"]);
const GIT = requireRuntimeExecutable("git");
const GIT_TIMEOUT_MS = 30_000;

export interface LandingFinalizeOptions {
  roots: GarelierControlRoots;
  workId: string;
  sessionId?: string;
}

export interface LandingFinalizePlan {
  schema_version: 1;
  kind: "landing_finalize_plan";
  work_id: string;
  session_id: string;
  control_revision: string;
  backlog_status: string;
  checkpoint_id: string;
  role_branch: string;
  role_tip: string;
  studio_branch: string;
  studio_tip: string;
  merge_commit: string;
  gate_evidence_path: string;
  gate_evidence_hash: string;
  review_sources: Array<{ role: "guardian" | "observer"; path: string; content_hash: string }>;
  claim: "matching-live" | "absent";
  plan_digest: string;
}

export interface LandingFinalizeApplyResult {
  status: "committed" | "dry_run";
  state: "verification";
  released: boolean;
  control_revision_before: string;
  control_revision_after: string;
  plan_digest: string;
}

export interface LongMergeFinalizationOptions {
  roots: GarelierControlRoots;
  workId: string;
  sessionId: string;
  requestPath: string;
  resultPath: string;
  reportPath: string;
  studioCommit: string;
  testHooks?: { afterEvidenceCapture?(): void };
}

export type LongMergeFinalizationResult =
  | { status: "already-recorded"; state: string; released: false }
  | ReturnType<typeof recordMergeControlOutcome>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function canonicalControlFile(roots: GarelierControlRoots, path: string, label: string): { path: string; source: string; hash: string } {
  if (isAbsolute(path)) throw new Error(`${label} path must be control-relative: ${path}`);
  const absolute = resolve(roots.controlRoot, path);
  const rel = relative(roots.controlRoot, absolute).replaceAll("\\", "/");
  if (!rel || rel === ".." || rel.startsWith("../") || /^[A-Za-z]:/.test(rel)) throw new Error(`${label} escapes control/: ${path}`);
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${path}`);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  const source = readFileSync(absolute, "utf8");
  return { path: rel, source, hash: sha256(source) };
}

function runGit(root: string, args: string[]) {
  const result = spawnSync(GIT, ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT") throw new Error(`git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`);
  if (error) throw new Error(`git ${args.join(" ")} spawn failed: ${error.message}`);
  if (result.signal) throw new Error(`git ${args.join(" ")} terminated by signal ${result.signal}`);
  if (result.status === null) throw new Error(`git ${args.join(" ")} ended without an exit status`);
  return result;
}

function git(root: string, args: string[]): string {
  const result = runGit(root, args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function assertAncestor(root: string, ancestor: string, descendant: string, label: string): void {
  const args = ["merge-base", "--is-ancestor", ancestor, descendant];
  const result = runGit(root, args);
  if (result.status === 1) throw new Error(`${label}: ${ancestor} is not an ancestor of ${descendant}`);
  if (result.status !== 0) throw new Error(`${label}: git ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
}

function gitInspector(root: string) {
  return {
    commitExists(commit: string): boolean {
      return runGit(root, ["cat-file", "-e", `${commit}^{commit}`]).status === 0;
    },
    isReachable(commit: string, from: string): boolean {
      const args = ["merge-base", "--is-ancestor", commit, from];
      const result = runGit(root, args);
      if (result.status === 0) return true;
      if (result.status === 1) return false;
      throw new Error(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
    },
  };
}

/**
 * Recovery boundary for a gate that finished after its dispatch claim TTL.
 * Raw runtime artifacts are accepted only after their Work/session/request,
 * passing status, and landed studio commit agree mechanically. The underlying
 * Control transaction then seals the same evidence used by the normal gate path.
 */
export function finalizeLongMergeEvidence(options: LongMergeFinalizationOptions): LongMergeFinalizationResult {
  const studioBranchForClosure = loadConfig(options.roots.projectRoot, options.roots.pmId).branches.integration;
  assertFinalizeOrderOk(options.roots.projectRoot, options.roots.pmId, studioBranchForClosure, options.workId);
  const guard = acquireGarelierOperationGuard(options.roots, options.sessionId, "long-merge-finalize");
  try {
    if (guard.schema !== 3) throw new Error(`long-merge finalization requires Control schema 3, found ${guard.schema ?? "none"}`);
    if (!FULL_SHA.test(options.studioCommit)) throw new Error("long-merge finalization requires a full lowercase studio commit SHA");
    const requestCapture = captureEvidenceSource(options.roots, options.requestPath, "merge request");
    const resultCapture = captureEvidenceSource(options.roots, options.resultPath, "merge-gate result");
    const request = record(JSON.parse(requestCapture.source), "merge request");
    const result = record(JSON.parse(resultCapture.source), "merge result");
    if (result.status !== "success" || result.studio_commit !== options.studioCommit) {
      throw new Error("long-merge finalization requires a passing result bound to the supplied studio commit");
    }
    if (request.request_id !== result.request_id
      || request.work_id !== options.workId || result.work_id !== options.workId
      || request.control_session_id !== options.sessionId || result.control_session_id !== options.sessionId) {
      throw new Error("long-merge finalization request/result Work/session binding mismatch");
    }
    const roleTip = String(request.workbench_tip ?? "");
    if (!FULL_SHA.test(roleTip) || result.workbench_tip !== roleTip) {
      throw new Error("long-merge finalization request/result workbench tip binding mismatch");
    }
    const studioBranch = loadConfig(options.roots.projectRoot, options.roots.pmId).branches.integration;
    const studioTip = git(options.roots.targetRoot, ["rev-parse", `${studioBranch}^{commit}`]);
    assertAncestor(options.roots.targetRoot, roleTip, options.studioCommit, "long-merge role landing check");
    assertAncestor(options.roots.targetRoot, options.studioCommit, studioTip, "long-merge studio landing check");

    const currentClaim = readControlClaim(resolveControlNamespace(options.roots), options.workId);
    if (currentClaim && currentClaim.session_id !== options.sessionId
      && Date.parse(currentClaim.expires_at) > Date.now()) {
      throw new Error(`long-merge finalization refused: live claim belongs to another session: ${currentClaim.session_id}`);
    }
    if (hasMergeControlEvidence(options.roots, options.workId, options.studioCommit, options.resultPath)) {
      const state = loadPlanGraphModel(options.roots.controlRoot).backlog.get(options.workId)?.status ?? "missing";
      return { status: "already-recorded", state, released: false };
    }
    options.testHooks?.afterEvidenceCapture?.();
    return recordMergeControlOutcome({
      roots: options.roots,
      workId: options.workId,
      sessionId: options.sessionId,
      outcome: {
        status: "success",
        commit: options.studioCommit,
        requestPath: options.requestPath,
        resultPath: options.resultPath,
        reportPath: options.reportPath,
        guardianReportPath: typeof request.guardian_report_path === "string" ? request.guardian_report_path : undefined,
        observerReportPath: typeof request.observer_report_path === "string" ? request.observer_report_path : undefined,
        expectedSuccessfulCapture: {
          requestContentHash: requestCapture.contentHash,
          resultContentHash: resultCapture.contentHash,
          workbenchTip: roleTip,
        },
      },
      requireLiveClaim: false,
      namespaceLock: guard.lock,
    });
  } finally {
    guard.release();
  }
}

function evidenceFile(roots: GarelierControlRoots, evidence: EvidenceReference, label: string) {
  if (evidence.root !== "control" || !evidence.path || !evidence.content_hash) throw new Error(`${label} must bind control path + content_hash`);
  const source = canonicalControlFile(roots, evidence.path, label);
  if (source.hash !== evidence.content_hash) throw new Error(`${label} content hash mismatch: ${evidence.path}`);
  return source;
}

function passingGateEvidence(
  roots: GarelierControlRoots,
  model: PlanGraphControlModel,
  workId: string,
  evidence: readonly EvidenceReference[],
  studioBranch: string,
) {
  const gates = evidence.filter((item) => item.kind === "gate");
  if (gates.length !== 1) throw new Error(`Backlog ${workId} requires exactly one typed gate evidence reference (found ${gates.length})`);
  const ref = gates[0]!;
  const findings = validateGateEvidence({ targetRoot: roots.targetRoot, controlRoot: model.controlRoot }, workId, ref, {
    git: gitInspector(roots.targetRoot),
    historyRef: studioBranch,
  });
  if (findings.length) {
    throw new Error(`gate evidence failed canonical validation: ${findings.map((item) => item.code).join(", ")}`);
  }
  const file = evidenceFile(roots, ref, "gate evidence");
  let payload: Record<string, unknown>;
  try { payload = record(JSON.parse(file.source), "gate evidence"); }
  catch (error) { throw new Error(`gate evidence is not valid JSON: ${(error as Error).message}`); }
  if (payload.kind !== "merge_gate_evidence" || payload.status !== "pass" || payload.exit_code !== 0 || payload.work_id !== workId) {
    throw new Error(`gate evidence for ${workId} is not a canonical passing merge-gate result`);
  }
  const sessionId = String(payload.session_id ?? "");
  const commit = String(payload.commit ?? "");
  if (!sessionId || !FULL_SHA.test(commit) || ref.commit !== commit) {
    throw new Error(`gate evidence Work/session/commit binding mismatch for ${workId}`);
  }
  const source = record(payload.source, "gate evidence source");
  if (source.root !== "project" || typeof source.path !== "string" || source.content_hash !== payload.content_hash) {
    throw new Error(`gate evidence original result source/hash contract is invalid for ${workId}`);
  }
  const request = record(record(payload.request, "gate evidence request").payload, "gate evidence request payload");
  const result = record(payload.payload, "gate evidence result payload");
  const roleBranch = String(request.workbench_branch ?? "");
  const roleTip = String(request.workbench_tip ?? "");
  const expectedStudioTip = typeof request.expected_studio_sha === "string" && request.expected_studio_sha
    ? request.expected_studio_sha
    : null;
  const observedStudioTip = String(result.observed_studio_sha ?? "");
  if (request.work_id !== workId || request.control_session_id !== sessionId || !roleBranch || !FULL_SHA.test(roleTip)
    || request.studio_branch !== studioBranch || !FULL_SHA.test(observedStudioTip)
    || (expectedStudioTip !== null && !FULL_SHA.test(expectedStudioTip))) {
    throw new Error(`gate evidence request does not bind ${workId}/${sessionId}/branch/tip`);
  }
  if (result.workbench_branch !== roleBranch || result.workbench_tip !== roleTip
    || result.studio_commit !== commit || result.expected_studio_sha !== expectedStudioTip
    || (expectedStudioTip !== null && observedStudioTip !== expectedStudioTip)) {
    throw new Error(`gate evidence result does not bind the requested role/studio refs for ${workId}`);
  }
  const execution = record(payload.execution, "gate evidence execution");
  if (execution.gate_mode !== "normal" && execution.gate_mode !== "data_only") throw new Error("gate evidence records an unsupported or bypassed gate mode");
  return { ref, file, payload, request, result, sessionId, commit, roleBranch, roleTip, studioBaseTip: observedStudioTip };
}

function reviewSources(
  roots: GarelierControlRoots,
  evidence: readonly EvidenceReference[],
  gatePayload: Record<string, unknown>,
  gateRequest: Record<string, unknown>,
): LandingFinalizePlan["review_sources"] {
  const reviews = record(gatePayload.reviews, "gate evidence reviews");
  const out: LandingFinalizePlan["review_sources"] = [];
  for (const role of ["guardian", "observer"] as const) {
    const binding = reviews[role];
    const required = gateRequest[`${role}_required`] === true;
    if (!required) {
      if (binding !== null && binding !== undefined) throw new Error(`${role} review is bound without a required request`);
      continue;
    }
    if (binding === null || binding === undefined) throw new Error(`${role} review is required but missing from durable gate evidence`);
    const item = record(binding, `${role} review binding`);
    if (item.required !== true || (item.verdict !== "PASS" && item.verdict !== "PASS_WITH_NOTES")
      || typeof item.content_hash !== "string") throw new Error(`${role} review binding is not passing and content-addressed`);
    const ref = evidence.find((candidate) =>
      candidate.kind === "report" && candidate.writer === `garelier-${role}` && candidate.content_hash === item.content_hash);
    if (!ref) throw new Error(`${role} review binding has no matching typed durable report evidence`);
    const file = evidenceFile(roots, ref, `${role} review evidence`);
    out.push({ role, path: file.path, content_hash: file.hash });
  }
  return out;
}

function optionalSession(roots: GarelierControlRoots, sessionId: string) {
  try { return readControlSession(resolveControlNamespace(roots), sessionId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || /session does not exist|session not found/i.test((error as Error).message)) return null;
    throw error;
  }
}

function buildPlan(options: LandingFinalizeOptions, namespaceLock?: NamespaceLock): LandingFinalizePlan {
  if (!/^W-\d+$/.test(options.workId)) throw new Error(`invalid Backlog ID: ${options.workId}`);
  const model = loadPlanGraphModel(options.roots.controlRoot);
  const finding = model.findings.find((item) => item.severity === "error");
  if (finding) throw new Error(`schema-3 strict validation failed: ${finding.code}: ${finding.message}`);
  const backlog = model.backlog.get(options.workId);
  if (!backlog) throw new Error(`Backlog does not exist: ${options.workId}`);
  if (!ELIGIBLE.has(backlog.status)) throw new Error(`Backlog ${options.workId} must be triage, ready, or active (found ${backlog.status})`);
  const current = model.current;
  if (!current) throw new Error("landing-finalize requires project_dashboard/current.md");
  const currentIds = new Set([...(current.primaryCheckpointId ? [current.primaryCheckpointId] : []), ...current.checkpointCandidates]);
  const checkpoints = [...model.checkpoints.values()].filter((checkpoint) =>
    checkpoint.status === "active" && currentIds.has(checkpoint.id) && checkpoint.backlog.includes(options.workId));
  if (checkpoints.length !== 1) throw new Error(`Backlog ${options.workId} requires exactly one active Checkpoint referenced by Current (found ${checkpoints.length})`);

  const studioBranch = loadConfig(options.roots.projectRoot, options.roots.pmId).branches.integration;
  const evidence = planGraphEvidenceReferences(backlog);
  const gate = passingGateEvidence(options.roots, model, options.workId, evidence, studioBranch);
  if (options.sessionId && options.sessionId !== gate.sessionId) throw new Error(`requested session ${options.sessionId} does not match durable gate session ${gate.sessionId}`);
  if (!evidence.some((item) => item.kind === "commit" && item.commit === gate.commit)) {
    throw new Error(`Backlog ${options.workId} has no typed merge commit evidence for ${gate.commit}`);
  }
  const reviews = reviewSources(options.roots, evidence, gate.payload, gate.request);

  const studioTip = git(options.roots.targetRoot, ["rev-parse", `${studioBranch}^{commit}`]);
  assertAncestor(options.roots.targetRoot, gate.studioBaseTip, gate.commit, "studio base binding check");
  assertAncestor(options.roots.targetRoot, gate.roleTip, gate.commit, "role merge binding check");
  assertAncestor(options.roots.targetRoot, gate.roleTip, studioTip, "role landing check");
  assertAncestor(options.roots.targetRoot, gate.commit, studioTip, "merge evidence freshness check");

  const paths = resolveControlNamespace(options.roots);
  if (namespaceLock) {
    const currentClaim = readControlClaim(paths, options.workId);
    if (currentClaim && currentClaim.session_id !== gate.sessionId) {
      throw new Error(`Backlog ${options.workId} claim belongs to another session: ${currentClaim.session_id}`);
    }
  }
  const claim = readControlClaim(paths, options.workId);
  const session = optionalSession(options.roots, gate.sessionId);
  const now = new Date();
  const runtime = session
    ? loadRuntimeControlSnapshot(paths, options.roots.pmId, now, planGraphRuntimeCallbacks)
    : null;
  if (session && runtime) assertSessionControlBinding(session, runtime.binding);
  if (claim) {
    if (claim.session_id !== gate.sessionId) throw new Error(`Backlog ${options.workId} claim belongs to another session: ${claim.session_id}`);
    if (!session || !runtime) throw new Error(`matching claim has no live session: ${gate.sessionId}`);
    assertClaimControlBinding(claim, runtime.binding);
    if (Date.parse(claim.expires_at) <= now.getTime()
      || Date.parse(session.heartbeat_at) + runtime.snapshot.claimStaleAfterSeconds * 1000 <= now.getTime()) {
      throw new Error(`Backlog ${options.workId} claim/session is stale`);
    }
    const revision = planGraphEntityRevision(backlog);
    if (claim.entity_revision !== revision) throw new Error(`Backlog ${options.workId} claim revision ${claim.entity_revision} does not match ${revision}`);
    if (!session.claims.includes(options.workId)) throw new Error(`session ${gate.sessionId} does not list its matching claim for ${options.workId}`);
  } else if (session?.claims.includes(options.workId)) {
    throw new Error(`session ${gate.sessionId} has a dirty claim binding for claimless ${options.workId}`);
  }

  const payload = {
    schema_version: 1 as const,
    kind: "landing_finalize_plan" as const,
    work_id: options.workId,
    session_id: gate.sessionId,
    control_revision: model.revision,
    backlog_status: backlog.status,
    checkpoint_id: checkpoints[0]!.id,
    role_branch: gate.roleBranch,
    role_tip: gate.roleTip,
    studio_branch: studioBranch,
    studio_tip: studioTip,
    merge_commit: gate.commit,
    gate_evidence_path: gate.file.path,
    gate_evidence_hash: gate.file.hash,
    review_sources: reviews,
    claim: claim ? "matching-live" as const : "absent" as const,
    claim_digest: claim ? sha256(canonicalJson(claim)) : null,
    session_digest: session ? sha256(canonicalJson(session)) : null,
  };
  const planDigest = sha256(canonicalJson(payload));
  const { claim_digest: _claimDigest, session_digest: _sessionDigest, ...publicPlan } = payload;
  return { ...publicPlan, plan_digest: planDigest };
}

export function planLandingFinalization(options: LandingFinalizeOptions): LandingFinalizePlan {
  return buildPlan(options);
}

export function applyLandingFinalization(options: LandingFinalizeOptions & {
  expectedPlanDigest: string;
  expectedControlRevision: string;
  testHooks?: { beforeClaimRelease?(): void; afterClaimReleaseBeforeCompensation?(): void };
}): LandingFinalizeApplyResult {
  const studioBranchForClosure = loadConfig(options.roots.projectRoot, options.roots.pmId).branches.integration;
  assertFinalizeOrderOk(options.roots.projectRoot, options.roots.pmId, studioBranchForClosure, options.workId);
  const preliminary = buildPlan(options);
  const guard = acquireGarelierOperationGuard(options.roots, preliminary.session_id, "landing-finalize");
  try {
    if (guard.schema !== 3) throw new Error(`landing-finalize requires Control schema 3, found ${guard.schema ?? "none"}`);
    const plan = buildPlan(options, guard.lock);
    if (plan.plan_digest !== options.expectedPlanDigest) throw new Error(`landing-finalize plan digest mismatch: expected ${options.expectedPlanDigest}, found ${plan.plan_digest}`);
    if (plan.control_revision !== options.expectedControlRevision) throw new Error(`landing-finalize control revision mismatch: expected ${options.expectedControlRevision}, found ${plan.control_revision}`);
    let released = false;
    const namespace = resolveControlNamespace(options.roots);
    const claimPath = join(namespace.runtimeRoot, "claims", `${options.workId}.json`);
    const sessionPath = join(namespace.runtimeRoot, "sessions", `${plan.session_id}.json`);
    const runtimeSession = plan.claim === "matching-live" ? readControlSession(namespace, plan.session_id) : null;
    const runtimeBefore = runtimeSession ? {
      claim: readFileSync(claimPath, "utf8"),
      session: readFileSync(sessionPath, "utf8"),
    } : null;
    const releasedSessionFallback = runtimeSession
      ? canonicalJson({ ...runtimeSession, claims: runtimeSession.claims.filter((id) => id !== options.workId) })
      : null;
    let transaction: ReturnType<typeof runControlFilePlanTransaction>;
    try {
      transaction = runControlFilePlanTransaction({
        targetRoot: options.roots.targetRoot,
        pmId: options.roots.pmId,
        controlRoot: options.roots.controlRoot,
        runtimeRoot: options.roots.runtimeRoot,
        expectedControlRevision: plan.control_revision,
        agent: "garelier-control",
        sessionId: plan.session_id,
        command: "landing-finalize",
        namespaceLock: guard.lock,
        callbacks: planGraphTransactionCallbacks,
        mutate: ({ state, now }) => {
          const backlog = state.backlog.get(options.workId);
          if (!backlog) throw new Error(`Backlog does not exist: ${options.workId}`);
          const transition = planLandingVerification({ backlog, now });
          const source = transition.writes[0]?.source;
          if (!source) throw new Error(`landing-finalize did not produce a Backlog source for ${options.workId}`);
          const transitioned = { ...backlog, source, status: "verification" as const, updated: now };
          return planBacklogUpdate({
            record: transitioned,
            now,
            currentPosition: `Merge ${plan.merge_commit} passed its bound gate and is awaiting verification.`,
            exactNextAction: "Verify acceptance and required runtime evidence; close only after every criterion passes.",
          });
        },
        hooks: plan.claim === "matching-live" ? {
          afterAtomicReplace() {
            options.testHooks?.beforeClaimRelease?.();
            released = releaseClaim({
              targetRoot: options.roots.targetRoot,
              pmId: options.roots.pmId,
              controlRoot: options.roots.controlRoot,
              runtimeRoot: options.roots.runtimeRoot,
              runtimeCallbacks: planGraphRuntimeCallbacks,
              workId: options.workId,
              sessionId: plan.session_id,
              namespaceLock: guard.lock,
            });
            if (!released) throw new Error("landing-finalize did not release the prevalidated matching claim");
            options.testHooks?.afterClaimReleaseBeforeCompensation?.();
          },
        } : undefined,
      });
    } catch (error) {
      if (released && runtimeBefore) {
        try {
          atomicWriteRuntimeFile(namespace.runtimeRoot, sessionPath, runtimeBefore.session);
          atomicWriteRuntimeFile(namespace.runtimeRoot, claimPath, runtimeBefore.claim);
          released = false;
        } catch (rollbackError) {
          if (releasedSessionFallback !== null) {
            try { atomicWriteRuntimeFile(namespace.runtimeRoot, sessionPath, releasedSessionFallback); } catch { /* preserve original rollback error */ }
          }
          throw new Error(`landing-finalize runtime rollback failed: ${(rollbackError as Error).message}`, { cause: error });
        }
      }
      throw error;
    }
    return {
      status: transaction.status,
      state: "verification",
      released,
      control_revision_before: transaction.control_revision_before,
      control_revision_after: transaction.control_revision_after,
      plan_digest: plan.plan_digest,
    };
  } finally {
    guard.release();
  }
}
