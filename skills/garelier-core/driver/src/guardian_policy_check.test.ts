import { describe, it, expect } from "bun:test";
import { policyReason, type GuardianPolicyInputs } from "./guardian_policy_check.ts";

const base: GuardianPolicyInputs = {
  enabled: true,
  requireForAllMerges: false,
  requireForProtectedPaths: true,
  requireForDependencyChanges: true,
  requireForLockfileChanges: true,
  requireForConfigInfraCiDeploy: true,
  requireForAuthSecurity: true,
  protectedGlobs: ["infra/**", "migrations/**"],
  securitySensitivePaths: [".env*", "**/*.key", ".github/workflows/**"],
  packageFiles: ["package.json", "Cargo.lock"],
};

describe("guardian policyReason", () => {
  it("is inert when disabled", () => {
    expect(policyReason({ ...base, enabled: false }, { changedFiles: [".env"], hasPassingVerdict: false })).toBe("");
  });

  it("is inert when a passing Guardian verdict is already present", () => {
    expect(policyReason(base, { changedFiles: [".env"], hasPassingVerdict: true })).toBe("");
  });

  it("blocks a protected-path change without a verdict", () => {
    const r = policyReason(base, { changedFiles: ["infra/deploy.tf"], hasPassingVerdict: false });
    expect(r).toContain("require_for_protected_paths");
    expect(r).toContain("infra/deploy.tf");
  });

  it("blocks a lockfile / manifest change by basename", () => {
    expect(policyReason(base, { changedFiles: ["app/Cargo.lock"], hasPassingVerdict: false }))
      .toContain("require_for_dependency_changes");
  });

  it("blocks a security-sensitive path change (.env*)", () => {
    expect(policyReason(base, { changedFiles: [".env.production"], hasPassingVerdict: false }))
      .toContain("security_sensitive_paths");
  });

  it("blocks a CI workflow change", () => {
    expect(policyReason(base, { changedFiles: [".github/workflows/deploy.yml"], hasPassingVerdict: false }))
      .toContain("security_sensitive_paths");
  });

  it("allows an ordinary source change", () => {
    expect(policyReason(base, { changedFiles: ["src/main.ts", "README.md"], hasPassingVerdict: false })).toBe("");
  });

  it("require_for_all_merges blocks even an ordinary source change without a verdict", () => {
    const r = policyReason({ ...base, requireForAllMerges: true }, { changedFiles: ["src/main.ts"], hasPassingVerdict: false });
    expect(r).toContain("require_for_all_merges");
  });

  it("require_for_all_merges is still short-circuited by a passing verdict", () => {
    expect(policyReason({ ...base, requireForAllMerges: true }, { changedFiles: ["src/main.ts"], hasPassingVerdict: true })).toBe("");
  });

  it("require_for_all_merges is inert when the policy is disabled", () => {
    expect(policyReason({ ...base, enabled: false, requireForAllMerges: true }, { changedFiles: ["src/main.ts"], hasPassingVerdict: false })).toBe("");
  });
});
