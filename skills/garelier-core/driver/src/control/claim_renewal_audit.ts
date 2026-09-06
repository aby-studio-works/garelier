import { join } from "node:path";
import { atomicWriteRuntimeFile } from "./diagnostics.ts";
import {
  assertClaimControlBinding,
  readControlClaim,
  readRuntimeClaims,
  touchesConflict,
  type ControlClaimRecord,
} from "./claims.ts";
import { loadPlanGraphModel } from "./plan_graph_model.ts";
import {
  planGraphEntityRevision,
  planGraphRuntimeCallbacks,
  planGraphTransactionCallbacks,
} from "./plan_graph_write.ts";
import { canonicalJson, sha256 } from "./serialization.ts";
import {
  assertSessionControlBinding,
  loadRuntimeControlSnapshot,
  readControlSession,
  readRuntimeSessions,
  writeControlSession,
} from "./sessions.ts";
import {
  assertNamespaceLock,
  resolveControlNamespace,
  runControlFilePlanTransaction,
  type NamespaceLock,
} from "./transaction.ts";

interface RenewalRoots {
  targetRoot: string;
  pmId: string;
  controlRoot: string;
  runtimeRoot: string;
}

export interface DispatchClaimRenewalOptions {
  roots: RenewalRoots;
  workId: string;
  sessionId: string;
  touches: string[];
  now: Date;
  namespaceLock: NamespaceLock;
  source: "dispatch-bind" | "merge-settlement";
  reason: string;
  testHooks?: {
    afterStageWrite?(path: string): void;
    afterRuntimeClaimWrite?(): void;
  };
}

export interface DispatchClaimRenewalResult {
  claim: ControlClaimRecord;
  renewed: boolean;
  auditPath: string | null;
}

/**
 * Renew only the dispatch-bound claim. The tracked audit record authorizes the
 * transition without rewriting the Work item that an already-issued role
 * authorization hashes. Runtime claim/session bytes move only after that audit
 * commits; a failed runtime transition restores both prior records when possible.
 */
export function renewDispatchClaimWithAudit(options: DispatchClaimRenewalOptions): DispatchClaimRenewalResult {
  const paths = resolveControlNamespace(options.roots);
  assertNamespaceLock(paths, options.namespaceLock);
  const session = readControlSession(paths, options.sessionId);
  const runtime = loadRuntimeControlSnapshot(paths, options.roots.pmId, options.now, planGraphRuntimeCallbacks);
  assertSessionControlBinding(session, runtime.binding);
  const claim = readControlClaim(paths, options.workId);
  if (!claim) throw new Error(`dispatch renewal requires an existing claim: ${options.workId}`);
  if (claim.session_id !== options.sessionId) throw new Error(`dispatch renewal claim belongs to another session: ${options.workId}`);
  assertClaimControlBinding(claim, runtime.binding);
  const requestedTouches = [...new Set(options.touches)].sort();
  for (const touch of requestedTouches) touchesConflict(touch, touch);

  const stale = Date.parse(claim.expires_at) <= options.now.getTime()
    || Date.parse(session.heartbeat_at) + runtime.snapshot.claimStaleAfterSeconds * 1000 <= options.now.getTime();
  // A merge-bound caller commonly reasserts an unchanged, still-live claim.
  // That is a read-only no-op: a later overlapping claim may be valid PM
  // judgment evidence, but it cannot retroactively invalidate this claim.
  if (!stale && canonicalJson(requestedTouches) === canonicalJson(claim.touches)) {
    return { claim, renewed: false, auditPath: null };
  }

  const sessions = new Map(readRuntimeSessions(paths.runtimeRoot).map((record) => [record.session_id, record]));
  const claims = readRuntimeClaims(paths.runtimeRoot);
  for (const candidate of claims) assertClaimControlBinding(candidate, runtime.binding);
  const competitor = claims.find((candidate) => {
    if (candidate.work_id === options.workId) return false;
    const owner = sessions.get(candidate.session_id);
    if (!owner) return false;
    assertSessionControlBinding(owner, runtime.binding);
    const live = Date.parse(candidate.expires_at) > options.now.getTime()
      && Date.parse(owner.heartbeat_at) + runtime.snapshot.claimStaleAfterSeconds * 1000 > options.now.getTime();
    return live && requestedTouches.some((touch) => candidate.touches.some((other) => touchesConflict(touch, other)));
  });
  if (competitor) {
    throw new Error(`audited renewal refused: competing live claim ${competitor.work_id} (${competitor.session_id})`);
  }

  if (!stale) {
    const widened = { ...claim, touches: requestedTouches };
    atomicWriteRuntimeFile(paths.runtimeRoot, join(paths.runtimeRoot, "claims", `${options.workId}.json`), canonicalJson(widened));
    return { claim: widened, renewed: false, auditPath: null };
  }

  const reason = options.reason.trim();
  if (!reason) throw new Error("dispatch renewal requires a non-empty audit reason");
  const expiresAt = new Date(options.now.getTime() + runtime.snapshot.claimTtlSeconds * 1000).toISOString();
  const audit = {
    schema_version: 1,
    control_schema_version: 3,
    kind: "claim_renewal_authorization",
    authorization_status: "authorized",
    work_id: options.workId,
    session_id: options.sessionId,
    actor: session.agent,
    observed_at: options.now.toISOString(),
    source: options.source,
    reason,
    previous_expires_at: claim.expires_at,
    authorized_expires_at: expiresAt,
    touches: requestedTouches,
  };
  const auditSource = canonicalJson(audit);
  const auditHash = sha256(auditSource);
  const auditPath = `reports/claim_renewals/${options.workId}/${auditHash.replace(/^sha256:/, "")}.json`;
  const model = loadPlanGraphModel(options.roots.controlRoot);
  const backlog = model.backlog.get(options.workId);
  if (!backlog) throw new Error(`dispatch Backlog does not exist: ${options.workId}`);
  const backlogRevision = planGraphEntityRevision(backlog);
  if (claim.entity_revision !== backlogRevision) {
    throw new Error(
      `dispatch renewal refused because Work authority changed: ${options.workId} `
      + `(claim=${claim.entity_revision}, current=${backlogRevision})`,
    );
  }
  const transaction = runControlFilePlanTransaction({
    targetRoot: options.roots.targetRoot,
    pmId: options.roots.pmId,
    controlRoot: options.roots.controlRoot,
    runtimeRoot: options.roots.runtimeRoot,
    expectedEntityRevisions: { [options.workId]: backlogRevision },
    agent: session.agent,
    sessionId: options.sessionId,
    command: "dispatch-claim-renewal",
    now: () => options.now,
    namespaceLock: options.namespaceLock,
    callbacks: planGraphTransactionCallbacks,
    hooks: options.testHooks,
    mutate: ({ state }) => {
      const current = state.backlog.get(options.workId);
      if (!current) throw new Error(`dispatch Backlog does not exist: ${options.workId}`);
      return {
        entity: options.workId,
        summary: `authorized audited dispatch claim renewal for ${options.workId}`,
        writes: [{ path: auditPath, source: auditSource }],
      };
    },
  });
  if (transaction.status !== "committed") throw new Error("dispatch claim renewal audit transaction did not commit");

  const updatedClaim: ControlClaimRecord = {
    ...claim,
    expires_at: expiresAt,
    touches: requestedTouches,
    // The Work source is intentionally unchanged; renewal cannot rebind an
    // incoming claim to different authority.
    entity_revision: claim.entity_revision,
  };
  const claimPath = join(paths.runtimeRoot, "claims", `${options.workId}.json`);
  const previousClaim = canonicalJson(claim);
  try {
    atomicWriteRuntimeFile(paths.runtimeRoot, claimPath, canonicalJson(updatedClaim));
    options.testHooks?.afterRuntimeClaimWrite?.();
    writeControlSession(paths, { ...session, heartbeat_at: options.now.toISOString() });
  } catch (error) {
    const rollbackFailures: string[] = [];
    try { atomicWriteRuntimeFile(paths.runtimeRoot, claimPath, previousClaim); }
    catch (rollbackError) { rollbackFailures.push(`claim: ${(rollbackError as Error).message}`); }
    try { writeControlSession(paths, session); }
    catch (rollbackError) { rollbackFailures.push(`session: ${(rollbackError as Error).message}`); }
    if (rollbackFailures.length) {
      throw new Error(`dispatch claim renewal runtime transition failed and rollback was incomplete (${rollbackFailures.join("; ")}): ${(error as Error).message}`, { cause: error });
    }
    throw error;
  }
  return { claim: updatedClaim, renewed: true, auditPath };
}
