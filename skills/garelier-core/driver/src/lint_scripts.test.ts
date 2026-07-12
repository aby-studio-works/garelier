// Tests for the DEC-051 format validators (commit messages + PM history).
// Verifies width-agnostic ID handling, the non-mandatory/legacy-lenient policy,
// and the hard/soft rule split.
import { describe, test, expect } from "bun:test";
import { lintCommitMessage } from "../../scripts/lint_commits.ts";
import { lintHistory } from "../../scripts/lint_history.ts";

describe("lint_commits", () => {
  test("conforming message passes", () => {
    expect(lintCommitMessage("feat(garelier-worker): add coverage audit [DEC-023]").ok).toBe(true);
  });
  test("DEC-acceptance form passes (item ID in summary)", () => {
    expect(lintCommitMessage("docs(control): accept DEC-051 — standardize formats").ok).toBe(true);
  });
  test("4+ digit item IDs are accepted (no fixed width)", () => {
    const r = lintCommitMessage("feat(voxel_baker): schema [W-100000 / m6]");
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("item ID"))).toBe(false);
  });
  test("unknown type hard-fails", () => {
    expect(lintCommitMessage("frobnicate(core): do a thing").ok).toBe(false);
  });
  test("missing scope warns but passes", () => {
    const r = lintCommitMessage("chore: bump version [DEC-051]");
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("scope"))).toBe(true);
  });
  test("over-length first line warns but passes (length is soft)", () => {
    const r = lintCommitMessage("feat(core): " + "x".repeat(80) + " [DEC-1]");
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("> 72"))).toBe(true);
  });
  test("pasted diff in body fails", () => {
    expect(lintCommitMessage("fix(core): x [DEC-1]\n\ndiff --git a/x b/x\n+foo").ok).toBe(false);
  });
  test("merge/revert/fixup are exempt", () => {
    expect(lintCommitMessage("Merge branch 'studio'").ok).toBe(true);
    expect(lintCommitMessage('Revert "feat: x"').ok).toBe(true);
    expect(lintCommitMessage("fixup! feat(core): x").ok).toBe(true);
  });
  test("missing Garelier trailer warns but passes (soft, HEAD-only history)", () => {
    const r = lintCommitMessage("feat(core): add thing [W-006]");
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("Garelier:"))).toBe(true);
  });
  test("Garelier trailer present -> no trailer warning", () => {
    const r = lintCommitMessage("feat(core): add thing [W-006]\n\nwhy line\n\nGarelier: acme worker#42 W-006");
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("Garelier:"))).toBe(false);
  });
  test("missing Garelier-Seat trailer is unchecked by default (no --require-seat-trailer)", () => {
    const r = lintCommitMessage("feat(core): add thing [W-042]\n\nwhy line\n\nGarelier: acme worker#42 W-042");
    expect(r.ok).toBe(true);
  });
  test("--require-seat-trailer hard-fails a missing Garelier-Seat trailer", () => {
    const r = lintCommitMessage(
      "feat(core): add thing [W-042]\n\nwhy line\n\nGarelier: acme dock#9 W-042",
      { requireSeatTrailer: true },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Garelier-Seat"))).toBe(true);
  });
  test("--require-seat-trailer hard-fails a malformed Garelier-Seat trailer", () => {
    const r = lintCommitMessage(
      "feat(core): add thing [W-042]\n\nwhy line\n\nGarelier: acme dock#9 W-042\nGarelier-Seat: codex (proxy-commit via dock seat)",
      { requireSeatTrailer: true },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("Garelier-Seat"))).toBe(true);
  });
  test("--require-seat-trailer passes a well-formed Garelier-Seat trailer", () => {
    const r = lintCommitMessage(
      "feat(core): add thing [W-042]\n\nwhy line\n\nGarelier: acme dock#9 W-042\nGarelier-Seat: codex gpt-5.1-codex (proxy-commit via dock seat)",
      { requireSeatTrailer: true },
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
});

describe("lint_history", () => {
  const newGood =
    "## #066 — 2026-06-07T19:12:41+09:00 — operator pass\n" +
    "- Blueprint: -\n- Milestone: m6\n- Outcome: shipped\n- Reason: autonomous-decision — landed\n" +
    "- Decision: DEC-051\n- Escalation: none\n- Commits: 2\n- Follow-up: -\n- Notes: why line\n";
  test("conforming new-format entry has no errors", () => {
    expect(lintHistory(newGood).filter((i) => i.level === "error")).toHaveLength(0);
  });
  test("4+ digit entry number is parsed (no fixed width)", () => {
    const e = newGood.replace("#066", "#100000");
    expect(lintHistory(e).filter((i) => i.level === "error")).toHaveLength(0);
  });
  test("new-format entry with bad outcome errors", () => {
    expect(lintHistory(newGood.replace("Outcome: shipped", "Outcome: doing-stuff")).some((i) => i.level === "error")).toBe(true);
  });
  test("new-format entry with bad reason-code errors", () => {
    expect(lintHistory(newGood.replace("Reason: autonomous-decision — landed", "Reason: because I felt like it")).some((i) => i.level === "error")).toBe(true);
  });
  test("legacy entry (no Reason) is lenient — warnings only, no errors", () => {
    const legacy = "## #001 — 2026-05-01T00:00:00Z — old\n- Blueprint: -\n- Milestone: -\n- Outcome: shipped\n- Notes: free text\n";
    const issues = lintHistory(legacy);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
    expect(issues.some((i) => i.level === "warn")).toBe(true);
  });
  test("notes with pasted log flagged", () => {
    const bad = newGood.replace("- Notes: why line", "- Notes: [2026-06-07T00:00:00Z] driver: starting foo bar");
    expect(lintHistory(bad).some((i) => i.msg.includes("pasted"))).toBe(true);
  });
});
