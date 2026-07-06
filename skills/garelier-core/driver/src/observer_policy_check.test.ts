import { test, expect } from "bun:test";
import { policyReason, highStakesReason, type PolicyInputs, type DiffInputs } from "./observer_policy_check.ts";

const base: PolicyInputs = {
  enabled: true,
  requireForAllMerges: false,
  requireForLargeDiff: true,
  largeDiffLines: 800,
  requireForProtectedPaths: true,
  protectedGlobs: [".env*", "infra/**", "migrations/**", ".github/workflows/**"],
};
const clean: DiffInputs = { churn: 10, changedFiles: ["src/a.ts"], hasPassingVerdict: false };

test("disabled policy is inert", () => {
  expect(policyReason({ ...base, enabled: false }, { ...clean, churn: 100000, changedFiles: [".env"] })).toBe("");
});

test("a passing verdict short-circuits (review already happened)", () => {
  expect(policyReason(base, { churn: 100000, changedFiles: [".env"], hasPassingVerdict: true })).toBe("");
});

test("small non-protected diff → allowed", () => {
  expect(policyReason(base, clean)).toBe("");
});

test("require_for_all_merges → even a tiny clean diff is mandated", () => {
  const r = policyReason({ ...base, requireForAllMerges: true }, clean);
  expect(r).toContain("require_for_all_merges");
});

test("require_for_all_merges but a passing verdict already present → allowed", () => {
  expect(policyReason({ ...base, requireForAllMerges: true }, { ...clean, hasPassingVerdict: true })).toBe("");
});

test("require_for_all_merges but policy disabled → inert", () => {
  expect(policyReason({ ...base, enabled: false, requireForAllMerges: true }, clean)).toBe("");
});

test("large diff over threshold → mandated", () => {
  const r = policyReason(base, { ...clean, churn: 800 });
  expect(r).toContain("require_for_large_diff");
  expect(r).toContain("800");
});

test("just under threshold → allowed", () => {
  expect(policyReason(base, { ...clean, churn: 799 })).toBe("");
});

test("large_diff disabled → not mandated by size", () => {
  expect(policyReason({ ...base, requireForLargeDiff: false }, { ...clean, churn: 5000 })).toBe("");
});

test("protected path (.env*) → mandated", () => {
  const r = policyReason(base, { ...clean, changedFiles: ["src/a.ts", ".env.production"] });
  expect(r).toContain("require_for_protected_paths");
  expect(r).toContain(".env.production");
});

test("protected glob with ** (infra/**) → mandated", () => {
  const r = policyReason(base, { ...clean, changedFiles: ["infra/terraform/main.tf"] });
  expect(r).toContain("infra/terraform/main.tf");
});

test("non-protected paths → allowed", () => {
  expect(policyReason(base, { ...clean, changedFiles: ["src/lib/util.ts", "docs/readme.md"] })).toBe("");
});

test("protected disabled → path change allowed", () => {
  expect(policyReason({ ...base, requireForProtectedPaths: false }, { ...clean, changedFiles: [".env"] })).toBe("");
});

test("no protected globs configured → path trigger inert", () => {
  expect(policyReason({ ...base, protectedGlobs: [] }, { ...clean, changedFiles: [".env"] })).toBe("");
});

// --- W-066: highStakesReason (refuter applicability) — the require_for_* SUBSET,
// evaluated REGARDLESS of a passing verdict and NEVER counting require_for_all_merges.

test("W-066: high-stakes fires on a large diff even with a passing verdict present", () => {
  // Unlike policyReason, a passing verdict does NOT suppress this — the refuter
  // sits ON TOP of the Observer verdict a high-stakes merge already carries.
  const r = highStakesReason(base, { churn: 900, changedFiles: ["src/a.ts"], hasPassingVerdict: true });
  expect(r).toContain("require_for_large_diff");
});

test("W-066: high-stakes fires on a protected path with a passing verdict present", () => {
  const r = highStakesReason(base, { churn: 10, changedFiles: [".env.production"], hasPassingVerdict: true });
  expect(r).toContain("require_for_protected_paths");
});

test("W-066: require_for_all_merges does NOT make a plain merge high-stakes (daily merges do not fire)", () => {
  // The cost design: only large_diff / protected_paths count, never
  // require_for_all_merges — else every merge would be high-stakes.
  expect(highStakesReason({ ...base, requireForAllMerges: true }, clean)).toBe("");
});

test("W-066: a small non-protected diff is not high-stakes", () => {
  expect(highStakesReason(base, clean)).toBe("");
});

test("W-066: disabled policy → not high-stakes (explicit --high-stakes flag is the only trigger then)", () => {
  expect(highStakesReason({ ...base, enabled: false }, { churn: 100000, changedFiles: [".env"], hasPassingVerdict: false })).toBe("");
});
