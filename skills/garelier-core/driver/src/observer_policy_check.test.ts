import { test, expect } from "bun:test";
import { policyReason, type PolicyInputs, type DiffInputs } from "./observer_policy_check.ts";

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
