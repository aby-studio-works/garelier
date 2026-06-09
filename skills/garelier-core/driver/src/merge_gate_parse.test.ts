import { test, expect } from "bun:test";
import { extractVerdict, observerGateReason, guardianGateReason, extractGuardianVerdict, buildRecords } from "./merge_gate_parse.ts";

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

test("buildRecords passes through fields incl. command with embedded quotes", () => {
  const r = buildRecords(baseReq(), noReport);
  expect(r[0]).toBe("MG-1");
  expect(r[4]).toBe("false"); // pre_merge_base_tracking default
  expect(r[5]).toBe("120"); // timeout default
  expect(r[6]).toBe(""); // no observer gate
  expect(r[7]).toBe("false"); // no passing observer verdict
  expect(r[8]).toBe(""); // no guardian gate
  expect(r[9]).toBe("false"); // no passing guardian verdict
  expect(r.slice(10)).toEqual(["npm test", 'sh -c "echo \\"hi\\""']);
});

test("buildRecords reports has_passing_verdict when a PASS report is present", () => {
  const req = { ...baseReq(), observer_report_path: "/fake/report.md" };
  const r = buildRecords(req, () => "## Verdict\n\nPASS\n");
  expect(r[7]).toBe("true");
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
  const cmds = buildRecords(req, noReport).slice(10);
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
  const cmds = buildRecords(baseReq(), noReport).slice(10);
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
