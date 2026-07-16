// Garelier dispatch (W-088) — machine-readable acceptance-evidence provenance
// schema + anti-false-green lint.
//
// A producer that reported "green" has, again and again, handed the PM
// acceptance evidence that was actually FALSE-green. The recurring real-harm
// class (the four fixtures this lint distinguishes):
//   - W-455 swallowed exit    — `cmd | tail` ate the child exit; a failing run
//                                looked green because the pipe's exit was the
//                                tail's, not the command's (no pipefail/PIPESTATUS).
//   - W-480 self-referential   — a "census" check referenced itself as its own
//     census                     mother set, so it was tautologically true; no
//                                negative case was ever exercised to disprove it.
//   - W-481 literal golden     — the expected value was hand-written as a literal
//                                and diverged from the real measurement, yet was
//                                used as the pass/fail oracle.
//   - W-346 unreachable        — a registration with zero reachable consumers
//     registration               passed wearing a "this is used" face.
//
// This module is the SCHEMA + the pure lint. It is a NEW, OPTIONAL dispatch
// artifact: a producer MAY drop an `evidence.json` next to its report so the
// acceptance proof is machine-checkable rather than freeform prose. Nothing in
// contract_check.ts / dispatch_prepare.ts is required to change — a dispatch
// with no evidence.json lints as it always did (the artifact is additive and
// back-compatible by construction). The CLI wrapper is scripts/evidence_lint.ts.
//
// Vocabulary is fixed to the backlog row W-088: an evidence record registers
//   source = runtime|test|static|literal   (how the proof was produced)
//   negative_case                          (was a should-fail case observed to fail)
//   mother_set                             (the population a census claims to cover)
//   consumer_reachability                  (is the registration actually reachable)
//   exit propagation                       (pipefail/PIPESTATUS explicit on a pipe)
// plus the three CLAIM flags that say which of the four rules apply to a record
// (oracle_grade / asserts_rejection / claims_used) — the lint only fires a rule
// when the record itself claims the property that rule protects.

// How an evidence datum was produced. `literal` is a hand-written expected value
// (never a measurement) and can never be oracle-grade — see rule `literal-oracle`.
export type EvidenceSource = "runtime" | "test" | "static" | "literal";

export const EVIDENCE_SOURCES: readonly EvidenceSource[] = [
  "runtime",
  "test",
  "static",
  "literal",
] as const;

// Exit-propagation discipline for evidence produced through a shell pipe. A pipe
// without one of these silently discards the producing command's exit status
// (the W-455 class). `none` is the explicit "no propagation guard" value.
export type ExitPropagation = "pipefail" | "PIPESTATUS" | "none";

// The population a census-style AC claims to cover. `declared` is the full set
// size; `checked` is how many were actually observed. A self-referential census
// (W-480) reads declared === checked while never exercising a negative case, so
// the tautology is caught by the `reject-no-negative` rule, not by counting.
export interface MotherSet {
  declared: number;
  checked: number;
}

// One acceptance-evidence record. Only `source` is required; the claim flags and
// provenance fields are optional and each defaults to "the rule does not apply"
// so a partial record never manufactures a violation it did not assert.
export interface EvidenceRecord {
  // Free identifier for reporting (the AC / check this evidence backs). Optional.
  id?: string;
  // How the proof was produced.
  source: EvidenceSource;

  // ── claim flags: which rules apply to THIS record ──────────────────────────
  // This evidence is the oracle — the actual basis of the pass/fail decision.
  oracle_grade?: boolean;
  // The AC asserts a rejection / fail-closed / "reject する" behavior, so a
  // negative case is mandatory to prove the check is not tautologically true.
  asserts_rejection?: boolean;
  // The AC claims the registration/consumer is used / reachable.
  claims_used?: boolean;

  // ── provenance fields ──────────────────────────────────────────────────────
  // A should-fail case was exercised and observed to fail (disproves 恒真).
  negative_case?: boolean;
  // The census population (see MotherSet).
  mother_set?: MotherSet;
  // Whether a real, reachable consumer of the registration exists.
  consumer_reachability?: boolean;
  // Evidence was produced through a shell pipe (`a | b`).
  piped?: boolean;
  // The exit-propagation guard used when `piped`. Absent reads as no guard.
  exit_propagation?: ExitPropagation;

  // Free-form provenance for humans (command line, run id, …). Not linted.
  command?: string;
}

// A stable rule code per anti-false-green rule, so callers/tests key off the
// code rather than the human message.
export type EvidenceRuleCode =
  | "invalid-source" // structural: source missing or not in the closed set
  | "literal-oracle" // W-481: a literal used as the pass/fail oracle
  | "pipe-no-exit-propagation" // W-455: piped evidence with no pipefail/PIPESTATUS
  | "reject-no-negative" // W-480: a reject/census AC with no negative case
  | "unreachable-claimed-used"; // W-346: claims_used but consumer unreachable

export interface EvidenceViolation {
  rule: EvidenceRuleCode;
  evidence_id: string; // record `id`, or its 0-based index when unnamed
  detail: string;
}

export interface EvidenceLintResult {
  ok: boolean;
  checked: number; // number of records linted
  violations: EvidenceViolation[];
}

// Normalize the several accepted document shapes to a flat record list. Accepts
// a single record `{...}`, a bare array `[{...}, ...]`, or a wrapper
// `{ evidence: [...] }`. Returns null for a shape that is not evidence at all
// (the CLI maps that to a usage error, exit 2 — there is nothing to lint).
export function normalizeEvidenceDoc(doc: unknown): EvidenceRecord[] | null {
  if (Array.isArray(doc)) return doc as EvidenceRecord[];
  if (doc && typeof doc === "object") {
    const wrapper = doc as { evidence?: unknown };
    if (Array.isArray(wrapper.evidence)) return wrapper.evidence as EvidenceRecord[];
    // A single record must at least look like one (have a `source` key present);
    // otherwise it is not an evidence document.
    if ("source" in (doc as object)) return [doc as EvidenceRecord];
    return null;
  }
  return null;
}

function recordId(rec: EvidenceRecord, index: number): string {
  return rec.id && rec.id.length > 0 ? rec.id : `#${index}`;
}

// Pure anti-false-green lint over one record. Each rule fires ONLY when the
// record itself claims the property that rule protects — a record that does not
// claim to be an oracle, to reject anything, or to be used is never penalized
// for the corresponding provenance being absent.
export function lintEvidenceRecord(rec: EvidenceRecord, index: number): EvidenceViolation[] {
  const id = recordId(rec, index);
  const out: EvidenceViolation[] = [];

  // Structural: source is required and closed-vocabulary. An unknown/missing
  // source cannot be reasoned about, so it is a violation rather than silently ok.
  if (!rec.source || !EVIDENCE_SOURCES.includes(rec.source)) {
    out.push({
      rule: "invalid-source",
      evidence_id: id,
      detail: `source is ${JSON.stringify(rec.source)}, must be one of ${EVIDENCE_SOURCES.join("|")}`,
    });
    // Without a valid source the remaining rules cannot be judged meaningfully;
    // report only the structural defect for this record.
    return out;
  }

  // Rule literal-oracle (W-481): a literal is a hand-written expected value, not
  // a measurement — it can never be the oracle that decides pass/fail.
  if (rec.source === "literal" && rec.oracle_grade === true) {
    out.push({
      rule: "literal-oracle",
      evidence_id: id,
      detail: "source=literal used as oracle-grade evidence — a hand-written literal cannot decide pass/fail (W-481 literal golden)",
    });
  }

  // Rule pipe-no-exit-propagation (W-455): evidence produced through a pipe must
  // declare pipefail/PIPESTATUS, or the producing command's exit was swallowed.
  if (rec.piped === true && rec.exit_propagation !== "pipefail" && rec.exit_propagation !== "PIPESTATUS") {
    out.push({
      rule: "pipe-no-exit-propagation",
      evidence_id: id,
      detail: `piped evidence with exit_propagation=${JSON.stringify(rec.exit_propagation ?? null)} — a pipe without pipefail/PIPESTATUS swallows the child exit (W-455 swallowed exit)`,
    });
  }

  // Rule reject-no-negative (W-480): a reject / fail-closed / census AC with no
  // negative case is tautologically true — nothing that should fail was shown to
  // fail (the self-referential census class).
  if (rec.asserts_rejection === true && rec.negative_case !== true) {
    out.push({
      rule: "reject-no-negative",
      evidence_id: id,
      detail: "AC asserts a rejection but negative_case is not exercised — a reject/census check with no negative case is 恒真 (W-480 self-referential census)",
    });
  }

  // Rule unreachable-claimed-used (W-346): claiming a registration is used while
  // it has no reachable consumer is a green face over a dead registration.
  if (rec.claims_used === true && rec.consumer_reachability === false) {
    out.push({
      rule: "unreachable-claimed-used",
      evidence_id: id,
      detail: "claims_used=true but consumer_reachability=false — a registration with no reachable consumer claimed as used (W-346 unreachable registration)",
    });
  }

  return out;
}

// Pure lint over a whole normalized document.
export function lintEvidence(records: EvidenceRecord[]): EvidenceLintResult {
  const violations: EvidenceViolation[] = [];
  records.forEach((rec, i) => violations.push(...lintEvidenceRecord(rec, i)));
  return { ok: violations.length === 0, checked: records.length, violations };
}
