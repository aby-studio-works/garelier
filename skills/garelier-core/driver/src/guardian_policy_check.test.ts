import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "./guard/path_guard.ts";
import {
  guardianReportPolicyReason, policyReason, type GuardianPolicyInputs,
} from "./guardian_policy_check.ts";

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
  // W-677: the 10 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  it("is inert when disabled (+9 folded cases)", () => {
    // case: is inert when disabled
    {
      expect(policyReason({ ...base, enabled: false }, { changedFiles: [".env"], hasPassingVerdict: false })).toBe("");
    }
    // case: is inert when a passing Guardian verdict is already present
    {
      expect(policyReason(base, { changedFiles: [".env"], hasPassingVerdict: true })).toBe("");
      const uncoveredSecretPii = [
        "+++",
        "[verdict]",
        "result = 'PASS'",
        `review_sha = '${"a".repeat(40)}'`,
        "",
        "[[uncovered]]",
        "dimension = 'secret_pii'",
        "cause = '''cross-repo seat binding is unavailable'''",
        "tracking_row = 'W-365'",
        "alternate_confidence_basis = '''full manual diff review'''",
        "+++",
        "",
        "UNCOVERED dimension disclosure follows in prose; no value here is read.",
      ].join("\n");
      expect(guardianReportPolicyReason(base, { changedFiles: ["app/Cargo.lock"], hasPassingVerdict: true }, uncoveredSecretPii))
        .toContain("require_for_dependency_changes");
      expect(guardianReportPolicyReason(base, { changedFiles: [".env.production"], hasPassingVerdict: true }, uncoveredSecretPii))
        .toContain("security_sensitive_paths");
      expect(guardianReportPolicyReason(base, { changedFiles: ["src/main.ts"], hasPassingVerdict: true }, uncoveredSecretPii)).toBe("");
      expect(guardianReportPolicyReason(base, { changedFiles: ["app/Cargo.lock"], hasPassingVerdict: true }, uncoveredSecretPii))
        .toContain("declares secret/PII UNCOVERED");
      expect(guardianReportPolicyReason(base, { changedFiles: ["app/Cargo.lock"], hasPassingVerdict: true }, uncoveredSecretPii))
        .not.toContain("no passing Guardian verdict accompanies this merge");
    }
    // case: blocks a protected-path change without a verdict
    {
      const r = policyReason(base, { changedFiles: ["infra/deploy.tf"], hasPassingVerdict: false });
      expect(r).toContain("require_for_protected_paths");
      expect(r).toContain("infra/deploy.tf");
    }
    // case: blocks a lockfile / manifest change by basename
    {
      expect(policyReason(base, { changedFiles: ["app/Cargo.lock"], hasPassingVerdict: false }))
        .toContain("require_for_dependency_changes");
    }
    // case: blocks a security-sensitive path change (.env*)
    {
      expect(policyReason(base, { changedFiles: [".env.production"], hasPassingVerdict: false }))
        .toContain("security_sensitive_paths");
    }
    // case: blocks a CI workflow change
    {
      expect(policyReason(base, { changedFiles: [".github/workflows/deploy.yml"], hasPassingVerdict: false }))
        .toContain("security_sensitive_paths");
    }
    // case: allows an ordinary source change
    {
      expect(policyReason(base, { changedFiles: ["src/main.ts", "README.md"], hasPassingVerdict: false })).toBe("");
    }
    // case: require_for_all_merges blocks even an ordinary source change without a verdict
    {
      const r = policyReason({ ...base, requireForAllMerges: true }, { changedFiles: ["src/main.ts"], hasPassingVerdict: false });
      expect(r).toContain("require_for_all_merges");
    }
    // case: require_for_all_merges is still short-circuited by a passing verdict
    {
      expect(policyReason({ ...base, requireForAllMerges: true }, { changedFiles: ["src/main.ts"], hasPassingVerdict: true })).toBe("");
    }
    // case: require_for_all_merges is inert when the policy is disabled and policy-check failures block
    {
      expect(policyReason({ ...base, enabled: false, requireForAllMerges: true }, { changedFiles: ["src/main.ts"], hasPassingVerdict: false })).toBe("");

      const fixture = mkdtempSync(join(tmpdir(), "garelier-w297-policy-check-"));
      try {
        const config = join(fixture, "setup_config.toml");
        writeFileSync(config, [
          "[guardian_policy]",
          "enabled = true",
          "",
          "[observer_policy]",
          "enabled = true",
        ].join("\n"));
        const cases = [
          {
            check: "guardian_policy",
            script: join(import.meta.dir, "guardian_policy_check.ts"),
            config: join(fixture, "missing.toml"),
            failureKind: "config",
          },
          {
            check: "guardian_policy",
            script: join(import.meta.dir, "guardian_policy_check.ts"),
            config,
            failureKind: "git",
          },
          {
            check: "observer_policy",
            script: join(import.meta.dir, "observer_policy_check.ts"),
            config: join(fixture, "missing.toml"),
            failureKind: "config",
          },
          {
            check: "observer_policy",
            script: join(import.meta.dir, "observer_policy_check.ts"),
            config,
            failureKind: "git",
          },
        ];
        for (const item of cases) {
          const result = Bun.spawnSync([
            "bun",
            item.script,
            item.config,
            fixture,
            "missing-base",
            "missing-head",
            "false",
          ], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
          expect(result.exitCode, result.stderr.toString()).toBe(0);
          expect(JSON.parse(result.stdout.toString()), `${item.check}/${item.failureKind}`).toMatchObject({
            schema_version: 1,
            check: item.check,
            status: "BLOCKED",
            required: true,
            failure_kind: item.failureKind,
          });
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    }
  });
});
