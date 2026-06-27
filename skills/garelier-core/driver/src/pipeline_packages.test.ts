import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateBlueprintToPipelinePackages,
  migrateBlueprintTree,
  parsePipelinePackages,
  renderAssignment,
  validatePipelinePackages,
} from "./pipeline_packages.ts";

const blueprint = [
  "# Blueprint: package demo",
  "",
  "## Pipeline packages",
  "",
  "### PP-1 — test-only report",
  "- Role: scout",
  "- Dispatch: immediate",
  "- Goal: Run the full test suite and report failures.",
  "- Inputs:",
  "  - `AGENTS.md`",
  "  - `package.json`",
  "- Do:",
  "  - Run the configured test commands read-only.",
  "  - Write an inspection with failures and rerun notes.",
  "- Acceptance:",
  "  - Test command output is captured.",
  "  - Report includes failure classification or a clean pass.",
  "- Expected outputs:",
  "  - `__garelier/<pm_id>/control/inspections/quality/YYYY/MM/YYYY-MM-DD-full-test-pass.md`",
  "",
  "### PP-2 — implement behavior",
  "- Role: worker",
  "- Dispatch: after PP-1",
  "- Depends on: PP-1",
  "- Goal: Implement the behavior verified by PP-1.",
  "- Inputs:",
  "  - `src/api/client.ts`",
  "  - PP-1 inspection",
  "- Allowed write paths:",
  "  - `src/api/**`",
  "  - `tests/api/**`",
  "- Forbidden write paths:",
  "  - `__garelier/**`",
  "  - `.env*`",
  "- Do:",
  "  - Add the failing regression test first.",
  "  - Implement the behavior.",
  "- Test discipline: tdd",
  "- Scope: bug fix",
  "- Waiver reason: -",
  "- Acceptance:",
  "  - Regression test fails before the fix and passes after.",
  "  - Project quality gate passes.",
  "- Expected outputs:",
  "  - branch commits and `report.md` evidence",
  "",
  "### PP-3 — integration hardening",
  "- Role: smith",
  "- Dispatch: after PP-2 merged into studio",
  "- Goal: Verify integrated behavior at the studio tip.",
  "- Inputs:",
  "  - PP-2 merge SHA",
  "- Allowed write paths:",
  "  - `tests/integration/**`",
  "- Do:",
  "  - Add or run integration coverage for the merged behavior.",
  "- Acceptance:",
  "  - Integration test evidence is recorded.",
].join("\n");

describe("parsePipelinePackages", () => {
  test("parses role-specific pipeline packages", () => {
    const packages = parsePipelinePackages(blueprint);
    expect(packages).toHaveLength(3);
    expect(packages[0].id).toBe("PP-1");
    expect(packages[0].role).toBe("scout");
    expect(packages[0].expected_outputs[0]).toContain("inspections/quality");
    expect(packages[1].role).toBe("worker");
    expect(packages[1].depends_on).toEqual(["PP-1"]);
    expect(packages[1].test_discipline?.mode).toBe("tdd");
    expect(packages[2].role).toBe("smith");
  });

  test("validates code, non-code, and delayed Smith packages", () => {
    const issues = validatePipelinePackages(parsePipelinePackages(blueprint));
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  test("rejects TDD on Smith packages so Dock cannot copy Worker-only sections", () => {
    const bad = blueprint.replace("- Role: smith\n- Dispatch: after PP-2 merged into studio", "- Role: smith\n- Dispatch: after PP-2 merged into studio\n- Test discipline: tdd");
    const issues = validatePipelinePackages(parsePipelinePackages(bad));
    expect(issues.some((i) => i.package_id === "PP-3" && i.message.includes("Test discipline"))).toBe(true);
  });
});

describe("renderAssignment", () => {
  test("renders a complete Worker assignment with TDD evidence", () => {
    const p = parsePipelinePackages(blueprint)[1];
    const md = renderAssignment(p, {
      taskId: 12,
      agentId: "worker(#12)",
      assignedAt: "2026-06-27T00:00:00.000Z",
      pmId: "_workshop",
      targetSlug: "main",
      slug: "implement-behavior",
      branch: "garelier/main/_workshop/workbench/#12/implement-behavior",
      baseBranch: "garelier/main/_workshop/studio",
      blueprintPath: "__garelier/_workshop/control/blueprints/demo.md",
    });
    expect(md).toContain("## Test discipline");
    expect(md).toContain("- Mode: tdd");
    expect(md).toContain("TDD evidence is recorded");
    expect(md).toContain("allowed_write_paths:\n- `src/api/**`");
  });

  test("renders a Scout assignment for test-only work without branch commits", () => {
    const p = parsePipelinePackages(blueprint)[0];
    const md = renderAssignment(p, {
      taskId: 11,
      agentId: "scout(#11)",
      assignedAt: "2026-06-27T00:00:00.000Z",
      pmId: "_workshop",
      targetSlug: "main",
      slug: "test-only-report",
      baseBranch: "garelier/main/_workshop/studio",
    });
    expect(md).toContain("Branch name: N/A");
    expect(md).toContain("Scout is commit-free");
    expect(md).toContain("full-test-pass.md");
    expect(md).not.toContain("## Test discipline");
  });

  test("renders a Smith assignment without Test discipline", () => {
    const p = parsePipelinePackages(blueprint)[2];
    const md = renderAssignment(p, {
      taskId: 13,
      agentId: "smith(#13)",
      assignedAt: "2026-06-27T00:00:00.000Z",
      pmId: "_workshop",
      targetSlug: "main",
      slug: "integration-hardening",
      branch: "garelier/main/_workshop/anvil/#13/integration-hardening",
      baseBranch: "garelier/main/_workshop/studio",
      baseSha: "abc1234",
      smithCoverageWindow: "abc1234..def5678",
      coveredWorkerMerges: "#12@def5678",
    });
    expect(md).toContain("Smith coverage window: abc1234..def5678");
    expect(md).toContain("Covered Worker merges: #12@def5678");
    expect(md).not.toContain("## Test discipline");
    expect(md).not.toContain("Mode: tdd");
  });
});

describe("migrateBlueprintToPipelinePackages", () => {
  test("adds a migration scaffold before Acceptance criteria", () => {
    const legacy = [
      "# Blueprint: legacy",
      "## Identity",
      "- Execution lane hint: dock",
      "- Preferred role hint: scout",
      "## Goal",
      "Run scheduled checks and report only.",
      "## Inputs",
      "- `AGENTS.md`",
      "## Expected outputs",
      "- `__garelier/<pm_id>/control/inspections/quality/YYYY/MM/report.md`",
      "## Acceptance criteria",
      "1. Report exists.",
    ].join("\n");
    const migrated = migrateBlueprintToPipelinePackages(legacy, { now: "2026-06-27" });
    expect(migrated).toContain("## Pipeline packages");
    expect(migrated).toContain("- Role: scout");
    expect(migrated.indexOf("## Pipeline packages")).toBeLessThan(migrated.indexOf("## Acceptance criteria"));
    expect(migrateBlueprintToPipelinePackages(migrated)).toBe(migrated);
  });

  test("dry-runs and writes a blueprint directory migration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "garelier-pipeline-packages-"));
    try {
      const legacyPath = join(dir, "legacy.md");
      const readmePath = join(dir, "README.md");
      const archiveDir = join(dir, "archive");
      const archivedPath = join(archiveDir, "old.md");
      await mkdir(archiveDir);
      await writeFile(legacyPath, [
        "# Blueprint: legacy",
        "## Goal",
        "Run scheduled checks and report only.",
        "## Inputs",
        "- `AGENTS.md`",
        "## Acceptance criteria",
        "- Report exists.",
      ].join("\n"));
      await writeFile(readmePath, "# Blueprints\n\nRepository-local guidance.\n");
      await writeFile(archivedPath, [
        "# Blueprint: archived",
        "## Goal",
        "Historical only.",
        "## Acceptance criteria",
        "- Already shipped.",
      ].join("\n"));

      const dryRun = await migrateBlueprintTree(dir, { now: "2026-06-27" });
      expect(dryRun.find((r) => r.file === legacyPath)?.status).toBe("would-migrate");
      expect(dryRun.find((r) => r.file === readmePath)?.status).toBe("skipped");
      expect(dryRun.some((r) => r.file === archivedPath)).toBe(false);
      expect(await readFile(legacyPath, "utf8")).not.toContain("## Pipeline packages");

      const written = await migrateBlueprintTree(dir, { now: "2026-06-27", write: true });
      expect(written.find((r) => r.file === legacyPath)?.status).toBe("migrated");
      expect(await readFile(legacyPath, "utf8")).toContain("## Pipeline packages");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
