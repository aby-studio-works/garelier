// Coordinator-owned completion record for the Dock -> Guardian/Observer handoff.
//
// The handoff artifacts (Guardian scan, canonical scanner evidence, gate log,
// final accounting) all live under `dispatch<N>/lane/`, and provider_session.ts
// grants a producer write access to the worktree AND its whole parent container
// — `lane/` included. Validating only their CONTENTS therefore proves byte
// shape, not provenance: a producer can author its own accounting and gate log
// and have a gate seat issued.
//
// This record closes that boundary. It is written ONLY by review_prepare.ts,
// under the PM control root's `runtime/` tree, which is outside every root
// codexProviderWritableRoots() grants. It carries the facts a producer cannot
// restate on its own behalf — which dispatch, branch, base, review SHA, gate run
// and outcome — plus a digest of every artifact the Dock actually consumed, so
// a later rewrite of any of them is detected instead of trusted.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteRuntimeFile } from "../control/diagnostics.ts";
import { canonicalJson } from "../control/serialization.ts";
import { assertSafeLeaf } from "../guard/path_guard.ts";

export const DOCK_REVIEW_RECORD_KIND = "garelier_dock_review_handoff";
export const DOCK_REVIEW_RECORD_GENERATOR = "review_prepare.ts";

const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;

export interface DockReviewHandoffRecord {
  schema_version: 1;
  kind: typeof DOCK_REVIEW_RECORD_KIND;
  generated_by: typeof DOCK_REVIEW_RECORD_GENERATOR;
  generated_at: string;
  dispatch_id: string;
  branch: string;
  base_sha: string;
  review_sha: string;
  gate_run_id: string;
  /** sha256 of the producer register's PARSED `=== REQUIRED GATE (Dock-run) ===`
   * steps as they stood when this run was sealed (W-693 F-1).
   *
   * The register is producer-writable and is deliberately NOT in
   * `evidence_digests` — the Dock does not consume it as evidence, the gate
   * consumes it as INPUT. That is exactly why it needs a binding of its own:
   * a reuse decision replays a sealed run's audit, so it may only do so while
   * the register still declares the same gate the sealed run actually ran. */
  gate_required_block_digest: string;
  /** W-710: the commit the gate's checkout resolved to before its first step and
   * after its last, copied from the run record `gate_runner` wrote under
   * `<pm runtime>/gate/run_records/` (`gate_run_record.ts::gateRunRecordPath` —
   * never beside the log, which may sit inside the tree the gate measures).
   * Equal to each other AND to `review_sha` is the whole P-9 verdict, so a
   * reader of this record never parses the log for it. Both are "" when the run
   * stated nothing (a gate that did not go through `gate_runner`), which blocks
   * reuse rather than asserting anything. */
  gate_start_head: string;
  gate_end_head: string;
  gate_exit: number;
  gate_result: string;
  coverage: string;
  coverage_map_source: string;
  coverage_map_vs_studio: string;
  dock_seat: string;
  dock_record: string;
  /** Absolute POSIX-slashed artifact path -> sha256 of its exact bytes. */
  evidence_digests: Record<string, string>;
}

/** The single spelling of an evidence path, shared by writer and verifier so a
 * separator or case difference can never look like a missing artifact. */
export function reviewEvidenceKey(path: string): string {
  return resolve(path).replace(/\\/g, "/");
}

/** The review gate log's file name for one review SHA (W-720).
 *
 * `review_sha` and `gate_log` are ONE pair of facts about ONE commit: the log is
 * named for the review it covers. Three call sites used to spell that name
 * themselves, so nothing could state the pair as an invariant — and the binder
 * wrote `gate_log` only when it was still unset, which left round 1's pointer in
 * a round 2 register (#463 r2). One spelling, so a caller cannot pair a log with
 * a review it does not belong to. */
export function reviewGateLogName(reviewSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(reviewSha)) throw new Error(`review gate log requires a full 40-hex review SHA: ${reviewSha}`);
  return `gate-${reviewSha.slice(0, 12)}.log`;
}

/** The review gate log inside a dispatch's `lane/`. */
export function reviewGateLogPath(lane: string, reviewSha: string): string {
  return resolve(lane, reviewGateLogName(reviewSha));
}

/** sha256 over the exact bytes of one bounded regular handoff artifact. */
export function digestReviewEvidence(path: string): string {
  const safe = assertSafeLeaf(path, "Dock review evidence");
  const info = lstatSync(safe);
  if (!info.isFile() || info.size > MAX_EVIDENCE_BYTES) {
    throw new Error(`Dock review evidence is not a bounded regular file: ${safe}`);
  }
  return createHash("sha256").update(readFileSync(safe)).digest("hex");
}

/** The record's home: the PM control root's runtime tree, never the dispatch
 * container. Keep this the only place the location is spelled. */
export function dockReviewRecordPath(project: string, pmId: string, dispatchId: string): string {
  if (!/^\d+$/.test(dispatchId)) throw new Error(`Dock review record requires a numeric dispatch id: ${dispatchId}`);
  return join(resolve(project), "__garelier", pmId, "runtime", "dock", "review_handoff", `dispatch${dispatchId}.json`);
}

function runtimeRootFor(project: string, pmId: string): string {
  return join(resolve(project), "__garelier", pmId, "runtime");
}

export interface WriteDockReviewRecordInput {
  project: string;
  pmId: string;
  dispatchId: string;
  branch: string;
  baseSha: string;
  reviewSha: string;
  gateRunId: string;
  /** See DockReviewHandoffRecord.gate_required_block_digest. */
  gateRequiredBlockDigest: string;
  /** See DockReviewHandoffRecord.gate_start_head / gate_end_head. */
  gateStartHead: string;
  gateEndHead: string;
  gateExit: number;
  gateResult: string;
  coverage: string;
  coverageMapSource: string;
  coverageMapVsStudio: string;
  dockSeat: string;
  dockRecord: string;
  /** Every artifact the gate seat is allowed to consume, digested as written. */
  evidence: readonly string[];
  now?: () => Date;
}

export function writeDockReviewHandoffRecord(input: WriteDockReviewRecordInput): string {
  const path = dockReviewRecordPath(input.project, input.pmId, input.dispatchId);
  const digests: Record<string, string> = {};
  for (const artifact of input.evidence) digests[reviewEvidenceKey(artifact)] = digestReviewEvidence(artifact);
  const record: DockReviewHandoffRecord = {
    schema_version: 1,
    kind: DOCK_REVIEW_RECORD_KIND,
    generated_by: DOCK_REVIEW_RECORD_GENERATOR,
    generated_at: (input.now?.() ?? new Date()).toISOString(),
    dispatch_id: input.dispatchId,
    branch: input.branch,
    base_sha: input.baseSha,
    review_sha: input.reviewSha,
    gate_run_id: input.gateRunId,
    gate_required_block_digest: input.gateRequiredBlockDigest,
    gate_start_head: input.gateStartHead,
    gate_end_head: input.gateEndHead,
    gate_exit: input.gateExit,
    gate_result: input.gateResult,
    coverage: input.coverage,
    coverage_map_source: input.coverageMapSource,
    coverage_map_vs_studio: input.coverageMapVsStudio,
    dock_seat: input.dockSeat,
    dock_record: input.dockRecord.replace(/\\/g, "/"),
    evidence_digests: digests,
  };
  atomicWriteRuntimeFile(runtimeRootFor(input.project, input.pmId), path, canonicalJson(record));
  return path;
}

/** Null when no coordinator record exists or it is not the canonical shape.
 * Both cases mean the same thing to a gate seat: the Dock did not produce this
 * handoff, so refuse. */
export function readDockReviewHandoffRecord(path: string): DockReviewHandoffRecord | null {
  if (!existsSync(path)) return null;
  let parsed: Record<string, unknown>;
  try {
    const safe = assertSafeLeaf(path, "Dock review record");
    const info = lstatSync(safe);
    if (!info.isFile() || info.size > MAX_EVIDENCE_BYTES) return null;
    parsed = JSON.parse(readFileSync(safe, "utf8")) as Record<string, unknown>;
  } catch { return null; }
  if (parsed.schema_version !== 1 || parsed.kind !== DOCK_REVIEW_RECORD_KIND
    || parsed.generated_by !== DOCK_REVIEW_RECORD_GENERATOR) return null;
  // A record without gate_required_block_digest predates the W-693 F-1 binding.
  // It is rejected rather than migrated (DEC-046): the caller then has no reuse
  // anchor and executes a gate, which is the fail-safe direction.
  const strings = ["generated_at", "dispatch_id", "branch", "base_sha", "review_sha", "gate_run_id",
    "gate_required_block_digest", "gate_start_head", "gate_end_head",
    "gate_result", "coverage", "coverage_map_source", "coverage_map_vs_studio", "dock_seat", "dock_record"] as const;
  if (strings.some((field) => typeof parsed[field] !== "string")) return null;
  if (typeof parsed.gate_exit !== "number" || !Number.isInteger(parsed.gate_exit)) return null;
  const digests = parsed.evidence_digests;
  if (!digests || typeof digests !== "object" || Array.isArray(digests)) return null;
  const entries = Object.entries(digests as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([, value]) => typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))) return null;
  return parsed as unknown as DockReviewHandoffRecord;
}

export interface DockReviewRecordVerification {
  ok: boolean;
  reason: string;
}

/** The gate-seat predicate (PV-1): the coordinator produced THIS handoff, for
 * this dispatch identity, and every artifact still carries the bytes the Dock
 * digested. Content validity is the caller's separate check; this one is
 * provenance only. */
export function verifyDockReviewHandoffRecord(input: {
  record: DockReviewHandoffRecord;
  dispatchId: string;
  branch: string;
  baseSha: string;
  reviewSha: string;
  evidence: readonly string[];
}): DockReviewRecordVerification {
  const { record } = input;
  if (record.dispatch_id !== input.dispatchId || record.branch !== input.branch
    || record.base_sha !== input.baseSha || record.review_sha !== input.reviewSha) {
    return {
      ok: false,
      reason: `Dock review record binds dispatch ${record.dispatch_id} / ${record.branch} / ${record.base_sha}..${record.review_sha},`
        + ` not ${input.dispatchId} / ${input.branch} / ${input.baseSha}..${input.reviewSha}`,
    };
  }
  if (record.gate_exit !== 0 || !record.gate_result.startsWith("GREEN")) {
    return { ok: false, reason: `Dock review record does not record a GREEN gate run: ${record.gate_result} (exit ${record.gate_exit})` };
  }
  if (!/^COVERED \((\d+) of \1 changed paths\)$/.test(record.coverage)) {
    return { ok: false, reason: `Dock review record does not record complete coverage: ${record.coverage}` };
  }
  const expected = [...new Set(input.evidence.map(reviewEvidenceKey))].sort();
  const recorded = Object.keys(record.evidence_digests).sort();
  if (expected.join("\n") !== recorded.join("\n")) {
    return { ok: false, reason: `Dock review record covers ${recorded.length} artifact(s), not exactly the ${expected.length} consumed handoff artifacts` };
  }
  for (const [artifact, digest] of Object.entries(record.evidence_digests)) {
    let actual: string;
    try { actual = digestReviewEvidence(artifact); }
    catch (error) { return { ok: false, reason: `Dock review evidence is unreadable: ${error instanceof Error ? error.message : String(error)}` }; }
    if (actual !== digest) {
      return { ok: false, reason: `Dock review handoff artifact changed after the Dock run: ${artifact}` };
    }
  }
  return { ok: true, reason: "Dock review record binds this dispatch and every consumed artifact digest" };
}
