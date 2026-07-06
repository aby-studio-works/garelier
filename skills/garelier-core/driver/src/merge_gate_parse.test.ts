import { test, expect } from "bun:test";
import { extractVerdict, observerGateReason, observerVerdictBoundBy, guardianGateReason, guardianVerdictBoundBy, extractGuardianVerdict, buildRecords, extractRefuterVerdict, resolveRefuterVerdict, refuterGateReason } from "./merge_gate_parse.ts";

const noReport = (_p: string): string | null => null;

const baseReq = () => ({
  request_id: "MG-1",
  workbench_branch: "garelier/main/acme/workbench/#1/x",
  studio_branch: "garelier/main/acme/studio",
  merge_message: "merge #1",
  quality_gate_commands: ["npm test", 'sh -c "echo \\"hi\\""'],
});

test("extractVerdict prefers the ## Verdict section", () => {
  expect(extractVerdict("## Verdict\n\nPASS_WITH_NOTES\n\nnotes")).toBe("PASS_WITH_NOTES");
  expect(extractVerdict("blah PASS blah\n## Verdict\n\nBLOCK")).toBe("BLOCK");
  expect(extractVerdict("no verdict here")).toBeNull();
});

// --- W-057: verdict parser must FAIL-CLOSED on an unfilled / non-canonical
// report (an untouched template placeholder or a crashed review must never be
// coerced into a passing PASS). The literal placeholder strings are copied
// verbatim from the real templates (observer_report.md:22, guardian_report.md:14).

test("W-057: unfilled Observer verdict placeholder resolves to null (not PASS)", () => {
  const report = "## Verdict\n{{PASS|PASS_WITH_NOTES|REWORK_RECOMMENDED|BLOCK|NO_OPINION}}\n";
  expect(extractVerdict(report)).toBeNull();
});

test("W-057: unfilled Guardian verdict placeholder resolves to null (not PASS)", () => {
  const report = "verdict: {{PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION}}\n";
  expect(extractGuardianVerdict(report)).toBeNull();
});

test("W-057: a non-canonical Observer token (PASSED) is not coerced to PASS", () => {
  expect(extractVerdict("## Verdict\n\nPASSED\n")).toBeNull();
});

test("W-057: a non-canonical Guardian token (BLOCKING) is not coerced to BLOCK", () => {
  expect(extractGuardianVerdict("verdict: BLOCKING\n")).toBeNull();
});

test("W-057: a passing word buried in prose (no heading) is not a verdict", () => {
  // Under the old unanchored fallback, any 'PASS' anywhere in the body matched.
  expect(extractVerdict("The reviewer thinks this will PASS eventually.")).toBeNull();
  expect(extractGuardianVerdict("all checks should PASS once fixed")).toBeNull();
});

test("W-057: observer gate FAILS CLOSED on a placeholder report (required)", () => {
  const req = { ...baseReq(), observer_required: true, observer_report_path: "/fake/o.md" };
  const placeholder = () => "## Verdict\n{{PASS|PASS_WITH_NOTES|REWORK_RECOMMENDED|BLOCK|NO_OPINION}}\n";
  const reason = observerGateReason(req, placeholder);
  expect(reason).not.toBe("");
  expect(reason).toContain("no Observer verdict");
  // and the emitted record[6] (observer_gate_fail) is non-empty → merge blocked
  expect(buildRecords(req, placeholder)[6]).not.toBe("");
});

test("W-057: guardian gate FAILS CLOSED on a placeholder report (required)", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_report_path: "/fake/g.md" };
  const placeholder = () => "verdict: {{PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION}}\n";
  const reason = guardianGateReason(req, placeholder);
  expect(reason).not.toBe("");
  expect(reason).toContain("no Guardian verdict");
  expect(buildRecords(req, placeholder)[8]).not.toBe("");
});

test("buildRecords passes through fields incl. command with embedded quotes", () => {
  const r = buildRecords(baseReq(), noReport);
  expect(r[0]).toBe("MG-1");
  expect(r[4]).toBe("false"); // pre_merge_base_tracking default
  expect(r[5]).toBe("120"); // timeout default
  expect(r[6]).toBe(""); // no observer gate
  expect(r[7]).toBe("false"); // no passing observer verdict
  expect(r[8]).toBe(""); // no guardian gate
  expect(r[9]).toBe("false"); // no passing guardian verdict
  expect(r[10]).toBe(""); // guardian_verdict_bound_by (W-035; not required → "")
  expect(r[11]).toBe(""); // observer_verdict_bound_by (W-062; not required → "")
  expect(r[12]).toBe(""); // refuter_gate_fail (W-066; no refuter verdict → "")
  expect(r[13]).toBe(""); // refuter_verdict (W-066; absent → "")
  expect(r[14]).toBe("0"); // preflight_command_count default (no preflight)
  expect(r.slice(15)).toEqual(["npm test", 'sh -c "echo \\"hi\\""']);
});

test("W-023: preflight commands are counted and precede the quality gate commands", () => {
  const req = { ...baseReq(), preflight: ["cargo metadata --locked --offline"] };
  const r = buildRecords(req, noReport);
  expect(r[14]).toBe("1"); // preflight_command_count
  expect(r.slice(15, 16)).toEqual(["cargo metadata --locked --offline"]);
  expect(r.slice(16)).toEqual(["npm test", 'sh -c "echo \\"hi\\""']); // quality gate unaffected
});

test("W-023: no preflight field → count is 0 and quality gate ordering is unchanged", () => {
  const r = buildRecords(baseReq(), noReport);
  expect(r[14]).toBe("0");
  expect(r.slice(15)).toEqual(["npm test", 'sh -c "echo \\"hi\\""']);
});

test("buildRecords reports has_passing_verdict when a PASS report is present", () => {
  const req = { ...baseReq(), observer_report_path: "/fake/report.md" };
  const r = buildRecords(req, () => "## Verdict\n\nPASS\n");
  expect(r[7]).toBe("true");
});

test("asserted guardian_verdict PASS (no report) is honored by default", () => {
  const req = { ...baseReq(), guardian_verdict: "PASS" };
  const r = buildRecords(req, noReport);
  expect(r[9]).toBe("true"); // string fallback stands when require_report is off
});

test("DEC-088 C2: guardian_require_report drops the asserted-string fallback", () => {
  // An asserted --guardian PASS with NO backing report must NOT count as passing
  // once [guardian_policy] require_report = true (the "--guardian PASS without
  // running Guardian" bypass).
  const req = { ...baseReq(), guardian_verdict: "PASS", guardian_require_report: true };
  const r = buildRecords(req, noReport);
  expect(r[9]).toBe("false"); // has_passing_guardian_verdict — report-less PASS refused
});

test("DEC-088 C2: guardian_require_report still passes a real report-backed PASS", () => {
  const req = {
    ...baseReq(),
    guardian_required: true,
    guardian_require_report: true,
    guardian_report_path: "/fake/g.md",
  };
  const r = buildRecords(req, () => "verdict: PASS\nreview_sha: deadbee\n");
  expect(r[9]).toBe("true");
  expect(r[8]).toBe(""); // guardian gate ok (verdict resolved from the report)
});

test("DEC-088 C2: observer_require_report drops the asserted-string fallback", () => {
  const req = { ...baseReq(), observer_verdict: "PASS", observer_require_report: true };
  const r = buildRecords(req, noReport);
  expect(r[7]).toBe("false");
});

test("buildRecords throws on missing required fields and empty commands", () => {
  expect(() => buildRecords({ ...baseReq(), request_id: "" }, noReport)).toThrow();
  expect(() => buildRecords({ ...baseReq(), quality_gate_commands: [] }, noReport)).toThrow();
});

test("DEC-049 C2: fast commands run FIRST then full, deduped (fail-fast ordering)", () => {
  const req = {
    ...baseReq(),
    quality_gate_commands: ["cargo build", "cargo test", "cargo clippy", "cargo fmt --all -- --check"],
    quality_gate_fast_commands: ["cargo fmt --all -- --check", "cargo clippy"],
  };
  const cmds = buildRecords(req, noReport).slice(15);
  // fast first, in order; then the full set minus what fast already covered
  expect(cmds).toEqual([
    "cargo fmt --all -- --check",
    "cargo clippy",
    "cargo build",
    "cargo test",
  ]);
  // the cheap deterministic checks precede the expensive build/test
  expect(cmds.indexOf("cargo fmt --all -- --check")).toBeLessThan(cmds.indexOf("cargo build"));
  expect(cmds.indexOf("cargo clippy")).toBeLessThan(cmds.indexOf("cargo test"));
});

test("no fast commands → ordering unchanged (gate behaves exactly as before)", () => {
  const cmds = buildRecords(baseReq(), noReport).slice(15);
  expect(cmds).toEqual(["npm test", 'sh -c "echo \\"hi\\""']);
});

test("observer gate: not required → ok", () => {
  expect(observerGateReason(baseReq(), noReport)).toBe("");
});

test("observer gate: required + PASS (verdict field) → ok", () => {
  expect(observerGateReason({ ...baseReq(), observer_required: true, observer_verdict: "PASS" }, noReport)).toBe("");
});

test("observer gate: required + BLOCK → refused", () => {
  const reason = observerGateReason({ ...baseReq(), observer_required: true, observer_verdict: "BLOCK" }, noReport);
  expect(reason).toContain("BLOCK");
});

test("observer gate: required + missing verdict → refused", () => {
  const reason = observerGateReason({ ...baseReq(), observer_required: true }, noReport);
  expect(reason).toContain("no Observer verdict");
});

test("observer gate: report verdict overrides a request-claimed PASS (integrity)", () => {
  // Request claims PASS, but the actual report says BLOCK → refused.
  const req = {
    ...baseReq(),
    observer_required: true,
    observer_verdict: "PASS",
    observer_report_path: "/fake/report.md",
  };
  const readReport = (_p: string) => "## Verdict\n\nBLOCK\n";
  expect(observerGateReason(req, readReport)).toContain("BLOCK");
});

test("observer gate: report PASS_WITH_NOTES → ok via buildRecords record[6]", () => {
  const req = {
    ...baseReq(),
    observer_required: true,
    observer_report_path: "/fake/report.md",
  };
  const readReport = (_p: string) => "## Verdict\n\nPASS_WITH_NOTES\n";
  expect(buildRecords(req, readReport)[6]).toBe("");
});

test("guardian gate: not required → ok", () => {
  expect(guardianGateReason(baseReq(), noReport)).toBe("");
});

test("guardian gate: required + PASS (verdict field) → ok", () => {
  expect(guardianGateReason({ ...baseReq(), guardian_required: true, guardian_verdict: "PASS" }, noReport)).toBe("");
});

test("guardian gate: required + BLOCK → refused", () => {
  expect(guardianGateReason({ ...baseReq(), guardian_required: true, guardian_verdict: "BLOCK" }, noReport)).toContain("BLOCK");
});

test("guardian gate: required + missing verdict → refused", () => {
  expect(guardianGateReason({ ...baseReq(), guardian_required: true }, noReport)).toContain("no Guardian verdict");
});

test("extractGuardianVerdict reads the verdict: field", () => {
  expect(extractGuardianVerdict("verdict: PASS_WITH_NOTES\nkind: delta_gate\n")).toBe("PASS_WITH_NOTES");
  expect(extractGuardianVerdict("verdict: BLOCK\n")).toBe("BLOCK");
});

test("guardian gate: report verdict overrides a request-claimed PASS", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS", guardian_report_path: "/fake/g.md" };
  expect(guardianGateReason(req, () => "verdict: BLOCK\n")).toContain("BLOCK");
});

test("buildRecords record[8] is the guardian gate fail; record[9] the passing flag", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_report_path: "/fake/g.md" };
  const r = buildRecords(req, () => "verdict: PASS\n");
  expect(r[8]).toBe("");
  expect(r[9]).toBe("true");
});

test("guardian gate: stale verdict (review_sha != workbench tip) → refused (G-15)", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS", guardian_review_sha: "aaaaaaa" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  expect(guardianGateReason(req, noReport, headSha)).toContain("stale");
});

test("guardian gate: review_sha matches workbench tip (prefix) → ok", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS", guardian_review_sha: "abc1234" };
  const headSha = (_ref: string) => "abc1234def567890abcdef1234567890abcdef12";
  expect(guardianGateReason(req, noReport, headSha)).toBe("");
});

test("guardian gate: review_sha read from report, mismatch → stale", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_report_path: "/fake/g.md" };
  const report = "verdict: PASS\nreview_sha: deadbeef\n";
  const headSha = (_ref: string) => "cafef00d00000000000000000000000000000000";
  expect(guardianGateReason(req, () => report, headSha)).toContain("stale");
});

test("guardian gate: stale check skipped without a headSha resolver (back-compat)", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS", guardian_review_sha: "aaaaaaa" };
  expect(guardianGateReason(req, noReport)).toBe("");
});

test("guardian gate: no review_sha → stale check is a no-op", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  expect(guardianGateReason(req, noReport, headSha)).toBe("");
});

// --- W-035: G-15 tree-hash fallback for message-only amend/reword ---

test("guardian gate: SHA mismatch but identical tree (message-only amend) → accepted, not stale", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS", guardian_review_sha: "aaaaaaa" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const treeHash = (ref: string) => "same-tree"; // both the review sha and the tip resolve to the same tree
  expect(guardianGateReason(req, noReport, headSha, treeHash)).toBe("");
});

test("guardian gate: SHA mismatch and different tree → still stale even with treeHash resolver", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS", guardian_review_sha: "aaaaaaa" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const treeHash = (ref: string) => (ref === "aaaaaaa" ? "tree-a" : "tree-b");
  expect(guardianGateReason(req, noReport, headSha, treeHash)).toContain("stale");
});

test("guardianVerdictBoundBy: exact SHA match → \"sha\"", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS", guardian_review_sha: "abc1234" };
  const headSha = (_ref: string) => "abc1234def567890abcdef1234567890abcdef12";
  expect(guardianVerdictBoundBy(req, noReport, headSha)).toBe("sha");
});

test("guardianVerdictBoundBy: tree-identical amend → \"tree\"", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS", guardian_review_sha: "aaaaaaa" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const treeHash = (_ref: string) => "same-tree";
  expect(guardianVerdictBoundBy(req, noReport, headSha, treeHash)).toBe("tree");
});

test("guardianVerdictBoundBy: not required → \"\"", () => {
  expect(guardianVerdictBoundBy(baseReq(), noReport)).toBe("");
});

test("guardianVerdictBoundBy: required but no headSha resolver → \"\" (back-compat)", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS", guardian_review_sha: "aaaaaaa" };
  expect(guardianVerdictBoundBy(req, noReport)).toBe("");
});

test("buildRecords record[10] carries guardian_verdict_bound_by", () => {
  const req = { ...baseReq(), guardian_required: true, guardian_verdict: "PASS", guardian_review_sha: "aaaaaaa" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const treeHash = (_ref: string) => "same-tree";
  const r = buildRecords(req, noReport, headSha, treeHash);
  expect(r[8]).toBe(""); // guardian gate ok (tree fallback accepted it)
  expect(r[10]).toBe("tree");
});

// --- W-062: Observer stale-verdict guard (symmetric with the Guardian G-15 guard) ---

test("observer gate: stale verdict (review_sha != workbench tip) → refused (W-062)", () => {
  const req = { ...baseReq(), observer_required: true, observer_verdict: "PASS", observer_review_sha: "aaaaaaa" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  expect(observerGateReason(req, noReport, headSha)).toContain("stale");
});

test("observer gate: review_sha matches workbench tip (prefix) → ok", () => {
  const req = { ...baseReq(), observer_required: true, observer_verdict: "PASS", observer_review_sha: "abc1234" };
  const headSha = (_ref: string) => "abc1234def567890abcdef1234567890abcdef12";
  expect(observerGateReason(req, noReport, headSha)).toBe("");
});

test("observer gate: review_sha read from report, mismatch → stale", () => {
  const req = { ...baseReq(), observer_required: true, observer_report_path: "/fake/o.md" };
  // Observer report: machine-readable review_sha line + the ## Verdict section.
  const report = "review_sha: deadbeef\n## Verdict\n\nPASS\n";
  const headSha = (_ref: string) => "cafef00d00000000000000000000000000000000";
  expect(observerGateReason(req, () => report, headSha)).toContain("stale");
});

test("observer gate: stale check skipped without a headSha resolver (back-compat)", () => {
  const req = { ...baseReq(), observer_required: true, observer_verdict: "PASS", observer_review_sha: "aaaaaaa" };
  expect(observerGateReason(req, noReport)).toBe("");
});

test("observer gate: no review_sha → stale check is a no-op", () => {
  const req = { ...baseReq(), observer_required: true, observer_verdict: "PASS" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  expect(observerGateReason(req, noReport, headSha)).toBe("");
});

test("observer gate: SHA mismatch but identical tree (message-only amend) → accepted, not stale", () => {
  const req = { ...baseReq(), observer_required: true, observer_verdict: "PASS", observer_review_sha: "aaaaaaa" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const treeHash = (_ref: string) => "same-tree"; // both the review sha and the tip resolve to the same tree
  expect(observerGateReason(req, noReport, headSha, treeHash)).toBe("");
});

test("observer gate: SHA mismatch and different tree → still stale even with treeHash resolver", () => {
  const req = { ...baseReq(), observer_required: true, observer_verdict: "PASS", observer_review_sha: "aaaaaaa" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const treeHash = (ref: string) => (ref === "aaaaaaa" ? "tree-a" : "tree-b");
  expect(observerGateReason(req, noReport, headSha, treeHash)).toContain("stale");
});

test("observer gate: report verdict PASS but stale sha → refused (verdict resolves, sha does not)", () => {
  // Integrity: a genuine PASS in the report is still refused when the tip moved.
  const req = { ...baseReq(), observer_required: true, observer_report_path: "/fake/o.md" };
  const report = "review_sha: aaaaaaa\n## Verdict\n\nPASS_WITH_NOTES\n";
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const r = buildRecords(req, () => report, headSha);
  expect(r[7]).toBe("true"); // has_passing_verdict — the report PASS resolves
  expect(r[6]).toContain("stale"); // …but the merge is blocked as stale
});

test("observerVerdictBoundBy: exact SHA match → \"sha\"", () => {
  const req = { ...baseReq(), observer_required: true, observer_verdict: "PASS", observer_review_sha: "abc1234" };
  const headSha = (_ref: string) => "abc1234def567890abcdef1234567890abcdef12";
  expect(observerVerdictBoundBy(req, noReport, headSha)).toBe("sha");
});

test("observerVerdictBoundBy: tree-identical amend → \"tree\"", () => {
  const req = { ...baseReq(), observer_required: true, observer_verdict: "PASS", observer_review_sha: "aaaaaaa" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const treeHash = (_ref: string) => "same-tree";
  expect(observerVerdictBoundBy(req, noReport, headSha, treeHash)).toBe("tree");
});

test("observerVerdictBoundBy: not required → \"\"", () => {
  expect(observerVerdictBoundBy(baseReq(), noReport)).toBe("");
});

test("observerVerdictBoundBy: required but no headSha resolver → \"\" (back-compat)", () => {
  const req = { ...baseReq(), observer_required: true, observer_verdict: "PASS", observer_review_sha: "aaaaaaa" };
  expect(observerVerdictBoundBy(req, noReport)).toBe("");
});

test("buildRecords record[11] carries observer_verdict_bound_by", () => {
  const req = { ...baseReq(), observer_required: true, observer_verdict: "PASS", observer_review_sha: "aaaaaaa" };
  const headSha = (_ref: string) => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const treeHash = (_ref: string) => "same-tree";
  const r = buildRecords(req, noReport, headSha, treeHash);
  expect(r[6]).toBe(""); // observer gate ok (tree fallback accepted it)
  expect(r[11]).toBe("tree");
});

// --- W-066: refuter (opt-in adversarial verify on top of the Observer verdict) ---

test("W-066: extractRefuterVerdict reads the canonical token, fail-closed otherwise", () => {
  expect(extractRefuterVerdict("refuter_verdict: UPHELD\n")).toBe("UPHELD");
  expect(extractRefuterVerdict("refuter_verdict: REFUTED\n")).toBe("REFUTED");
  // fail-closed like the Observer/Guardian extractors (W-057): placeholder /
  // malformed token / prose mention → null, never a coerced value.
  expect(extractRefuterVerdict("refuter_verdict: {{UPHELD | REFUTED}}\n")).toBeNull();
  expect(extractRefuterVerdict("refuter_verdict: REFUTE\n")).toBeNull();
  expect(extractRefuterVerdict("the reviewer will be REFUTED probably")).toBeNull();
});

test("W-066: resolveRefuterVerdict is report-authoritative — a report REFUTED beats an asserted UPHELD", () => {
  // The anti-rubber-stamp property: an asserted UPHELD string cannot cover a
  // report that says REFUTED.
  const req = { ...baseReq(), refuter_verdict: "UPHELD", refuter_report_path: "/fake/refuter.md" };
  expect(resolveRefuterVerdict(req, () => "refuter_verdict: REFUTED\n")).toBe("REFUTED");
});

test("W-066: resolveRefuterVerdict falls back to the request string when no report is given", () => {
  expect(resolveRefuterVerdict({ ...baseReq(), refuter_verdict: "UPHELD" }, noReport)).toBe("UPHELD");
  // a garbage asserted string does not resolve to a verdict (defense in depth)
  expect(resolveRefuterVerdict({ ...baseReq(), refuter_verdict: "yes" }, noReport)).toBeNull();
  expect(resolveRefuterVerdict(baseReq(), noReport)).toBeNull();
});

test("W-066: refuterGateReason holds ONLY on a present REFUTED verdict", () => {
  // REFUTED → non-empty hold reason (fail-closed, PM escalate).
  expect(refuterGateReason({ ...baseReq(), refuter_verdict: "REFUTED" }, noReport)).not.toBe("");
  // UPHELD and absent are both no-ops — the refuter is never mandatory.
  expect(refuterGateReason({ ...baseReq(), refuter_verdict: "UPHELD" }, noReport)).toBe("");
  expect(refuterGateReason(baseReq(), noReport)).toBe("");
});

test("W-066: buildRecords emits refuter_gate_fail (record[12]) and refuter_verdict (record[13])", () => {
  // REFUTED: record[12] is the hold reason, record[13] echoes the verdict.
  const refuted = buildRecords({ ...baseReq(), refuter_verdict: "REFUTED" }, noReport);
  expect(refuted[12]).not.toBe("");
  expect(refuted[13]).toBe("REFUTED");
  // UPHELD: no hold (record[12] empty), record[13] present so bash does NOT warn.
  const upheld = buildRecords({ ...baseReq(), refuter_verdict: "UPHELD" }, noReport);
  expect(upheld[12]).toBe("");
  expect(upheld[13]).toBe("UPHELD");
  // absent: both empty — bash decides the advisory warn from high-stakes alone.
  const absent = buildRecords(baseReq(), noReport);
  expect(absent[12]).toBe("");
  expect(absent[13]).toBe("");
});
