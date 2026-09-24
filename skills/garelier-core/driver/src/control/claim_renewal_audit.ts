import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertNoSymlinkPath, assertSafeRelativePath, atomicWriteRuntimeFile } from "./diagnostics.ts";
import {
  assertClaimControlBinding,
  claimHasLiveMergeReservation,
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
  authorityRefresh?: {
    previousRevision: number;
    currentRevision: number;
    evidencePath: string;
    evidenceHash: string;
  };
  /** Run every renewal precondition without committing the tracked audit or
   * changing runtime claim/session bytes. merge_land uses this before the
   * sealed candidate enters the gate. */
  validateOnly?: boolean;
  validateAuthorityRefresh?: boolean;
  /** Establish a runtime-only reservation from verdict validation through the
   * durable merge-outcome release, independent of the ordinary claim lease. */
  mergeReservationUntil?: Date;
  /** Bind a merge-settlement audit to the exact merge request that caused it.
   * The caller can then carry this generated Control write into the settlement
   * manifest without broadening authority to a path allowlist. */
  settlementRequestId?: string;
  testHooks?: {
    afterStageWrite?(path: string): void;
    afterRuntimeClaimWrite?(): void;
  };
}

export interface DispatchClaimReservation {
  previousClaim: ControlClaimRecord;
  reservedClaim: ControlClaimRecord;
}

export interface DispatchClaimRenewalResult {
  claim: ControlClaimRecord;
  renewed: boolean;
  auditPath: string | null;
  generatedControlWrite: { path: string; digest: string; authority: string } | null;
  reservation?: DispatchClaimReservation;
}

/** Read the record shape emitted by renewDispatchClaimWithAudit. Both a live
 * settlement write and a closed lane's content-addressed residue use this
 * reader, so an incomplete lookalike cannot acquire foreign ownership. */
export function readClaimRenewalAuthorizationRecord(source: string): Record<string, unknown> | null {
  let value: unknown;
  try { value = JSON.parse(source); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nonempty = (field: string): boolean => typeof record[field] === "string" && (record[field] as string).length > 0;
  const isoDate = (field: string): boolean => {
    if (!nonempty(field)) return false;
    try { return new Date(record[field] as string).toISOString() === record[field]; }
    catch { return false; }
  };
  try { if (source !== canonicalJson(record)) return null; }
  catch { return null; }
  const refresh = record.authority_refresh;
  if (record.schema_version !== 1 || record.control_schema_version !== 3
    || record.kind !== "claim_renewal_authorization"
    || record.authorization_status !== "authorized"
    || !nonempty("work_id") || !nonempty("session_id") || !nonempty("actor") || !nonempty("reason")
    || !isoDate("observed_at") || !isoDate("previous_expires_at") || !isoDate("authorized_expires_at")
    || (record.source !== "dispatch-bind" && record.source !== "merge-settlement")
    || (record.request_id !== null && (typeof record.request_id !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.request_id)))
    || (record.source === "merge-settlement" && record.request_id === null)
    || !Array.isArray(record.touches) || !record.touches.every((touch) => typeof touch === "string" && touch.length > 0)
    || (refresh !== null && (!refresh || typeof refresh !== "object" || Array.isArray(refresh)
      || typeof (refresh as Record<string, unknown>).previousRevision !== "number"
      || typeof (refresh as Record<string, unknown>).currentRevision !== "number"
      || typeof (refresh as Record<string, unknown>).evidencePath !== "string"
      || typeof (refresh as Record<string, unknown>).evidenceHash !== "string"))) return null;
  return record;
}

export function assertDispatchAuthorityRefresh(options: {
  roots: RenewalRoots;
  workId: string;
  previousRevision: number;
  currentRevision: number;
  authorityRefresh?: DispatchClaimRenewalOptions["authorityRefresh"];
}): void {
  if (options.previousRevision === options.currentRevision) return;
  const refresh = options.authorityRefresh;
  let evidenceHash = "";
  if (refresh?.evidencePath) {
    const safePath = assertSafeRelativePath(refresh.evidencePath);
    const prefix = `__garelier/${options.roots.pmId}/runtime/dispatch/bindings/`;
    if (!safePath.startsWith(prefix)) throw new Error("dispatch authority refresh evidence is outside the role-binding runtime namespace");
    const absolute = resolve(options.roots.targetRoot, ...safePath.split("/"));
    assertNoSymlinkPath(options.roots.targetRoot, absolute);
    evidenceHash = sha256(readFileSync(absolute)).replace(/^sha256:/, "");
  }
  if (!refresh || refresh.previousRevision !== options.previousRevision
    || refresh.currentRevision !== options.currentRevision
    || !refresh.evidencePath.trim() || !/^[0-9a-f]{64}$/.test(refresh.evidenceHash)
    || evidenceHash !== refresh.evidenceHash) {
    throw new Error(
      `dispatch renewal refused because Work authority changed: ${options.workId} `
      + `(claim=${options.previousRevision}, current=${options.currentRevision})`,
    );
  }
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

  const model = loadPlanGraphModel(options.roots.controlRoot);
  const backlog = model.backlog.get(options.workId);
  if (!backlog) throw new Error(`dispatch Backlog does not exist: ${options.workId}`);
  const backlogRevision = planGraphEntityRevision(backlog);
  if (options.validateAuthorityRefresh !== false) {
    assertDispatchAuthorityRefresh({
      roots: options.roots,
      workId: options.workId,
      previousRevision: claim.entity_revision,
      currentRevision: backlogRevision,
      authorityRefresh: options.authorityRefresh,
    });
  }

  const reservationUntil = options.mergeReservationUntil?.getTime();
  if (reservationUntil !== undefined && (!Number.isFinite(reservationUntil) || reservationUntil <= options.now.getTime())) {
    throw new Error("merge-bound claim reservation must end in the future");
  }
  const sameTouches = canonicalJson(requestedTouches) === canonicalJson(claim.touches);
  const authorityRebindNeeded = claim.entity_revision !== backlogRevision;
  const reservationNeeded = reservationUntil !== undefined
    && (!claim.merge_bound_until || Date.parse(claim.merge_bound_until) < reservationUntil);

  const stale = Date.parse(claim.expires_at) <= options.now.getTime()
    || Date.parse(session.heartbeat_at) + runtime.snapshot.claimStaleAfterSeconds * 1000 <= options.now.getTime();
  // A merge-bound caller commonly reasserts an unchanged, still-live claim.
  // It remains a read-only no-op only after the helper has compared its entity
  // revision with current Backlog authority. This comparison belongs here for
  // validation, reservation, and settlement alike.
  if (!stale && sameTouches && !authorityRebindNeeded && !reservationNeeded) {
    return { claim, renewed: false, auditPath: null, generatedControlWrite: null };
  }

  // An unchanged live claim already passed its touch-conflict check when it was
  // created. Any stale claim or touch change must re-check current competitors.
  if (stale || !sameTouches) {
    const sessions = new Map(readRuntimeSessions(paths.runtimeRoot).map((record) => [record.session_id, record]));
    const claims = readRuntimeClaims(paths.runtimeRoot);
    for (const candidate of claims) assertClaimControlBinding(candidate, runtime.binding);
    const competitor = claims.find((candidate) => {
      if (candidate.work_id === options.workId) return false;
      const owner = sessions.get(candidate.session_id);
      if (!owner) return false;
      assertSessionControlBinding(owner, runtime.binding);
      const live = claimHasLiveMergeReservation(candidate, options.now)
        || (Date.parse(candidate.expires_at) > options.now.getTime()
          && Date.parse(owner.heartbeat_at) + runtime.snapshot.claimStaleAfterSeconds * 1000 > options.now.getTime());
      return live && requestedTouches.some((touch) => candidate.touches.some((other) => touchesConflict(touch, other)));
    });
    if (competitor) {
      throw new Error(`audited renewal refused: competing live claim ${competitor.work_id} (${competitor.session_id})`);
    }
  }

  const reason = options.reason.trim();
  if (stale && !reason) throw new Error("dispatch renewal requires a non-empty audit reason");

  // Preliminary merge_land admission occurs before verdict validation. It may
  // diagnose stale authority/touches, but no validateOnly path may alter claim
  // or session bytes. The post-verdict reservation call owns every rebind.
  if (options.validateOnly) return { claim, renewed: false, auditPath: null, generatedControlWrite: null };

  if (reservationUntil !== undefined) {
    const reservedClaim: ControlClaimRecord = {
      ...claim,
      touches: requestedTouches,
      entity_revision: backlogRevision,
      merge_bound_until: new Date(reservationUntil).toISOString(),
    };
    atomicWriteRuntimeFile(
      paths.runtimeRoot,
      join(paths.runtimeRoot, "claims", `${options.workId}.json`),
      canonicalJson(reservedClaim),
    );
    return {
      claim: reservedClaim,
      renewed: true,
      auditPath: null,
      generatedControlWrite: null,
      reservation: { previousClaim: claim, reservedClaim },
    };
  }

  if (!stale) {
    const widened = { ...claim, touches: requestedTouches, entity_revision: backlogRevision };
    atomicWriteRuntimeFile(paths.runtimeRoot, join(paths.runtimeRoot, "claims", `${options.workId}.json`), canonicalJson(widened));
    return { claim: widened, renewed: false, auditPath: null, generatedControlWrite: null };
  }

  if (options.settlementRequestId !== undefined
    && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.settlementRequestId)) {
    throw new Error("dispatch renewal settlement request id contains unsafe characters");
  }

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
    request_id: options.settlementRequestId ?? null,
    reason,
    previous_expires_at: claim.expires_at,
    authorized_expires_at: expiresAt,
    touches: requestedTouches,
    authority_refresh: options.authorityRefresh ?? null,
  };
  const auditSource = canonicalJson(audit);
  const auditHash = sha256(auditSource);
  const auditPath = `reports/claim_renewals/${options.workId}/${auditHash.replace(/^sha256:/, "")}.json`;
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
    entity_revision: backlogRevision,
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
  return {
    claim: updatedClaim,
    renewed: true,
    auditPath,
    generatedControlWrite: options.source === "merge-settlement" && options.settlementRequestId
      ? {
          path: auditPath,
          digest: auditHash,
          authority: `generated:claim-renewal:${options.settlementRequestId}`,
        }
      : null,
  };
}

/** Restore the exact claim bytes that preceded a reservation. A missing claim
 * means canonical terminal settlement already released it; any other
 * intervening claim change is preserved and reported instead of overwritten. */
export function rollbackDispatchClaimReservation(options: {
  roots: RenewalRoots;
  workId: string;
  sessionId: string;
  reservation: DispatchClaimReservation;
  namespaceLock: NamespaceLock;
}): "restored" | "already-released" {
  const paths = resolveControlNamespace(options.roots);
  assertNamespaceLock(paths, options.namespaceLock);
  const current = readControlClaim(paths, options.workId);
  // A terminal merge-gate failure records its abort transaction first, and
  // that canonical settlement may release the claim before merge_land wakes.
  if (!current) return "already-released";
  if (current.session_id !== options.sessionId) {
    throw new Error(`merge-bound claim reservation belongs to another session: ${current.session_id}`);
  }
  if (canonicalJson(current) !== canonicalJson(options.reservation.reservedClaim)) {
    throw new Error(`merge-bound claim reservation changed after preflight: ${options.workId}`);
  }
  atomicWriteRuntimeFile(
    paths.runtimeRoot,
    join(paths.runtimeRoot, "claims", `${options.workId}.json`),
    canonicalJson(options.reservation.previousClaim),
  );
  return "restored";
}
