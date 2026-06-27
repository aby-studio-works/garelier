import { describe, expect, test } from "bun:test";
import { buildPipelinePlan, renderPlanMarkdown } from "./pipeline_plan.ts";

const blueprint = [
  "# Blueprint: dispatch plan demo",
  "",
  "## Pipeline packages",
  "",
  "### PP-1 — inspect first",
  "- Role: scout",
  "- Dispatch: immediate",
  "- Goal: Inspect the current failure without writing code.",
  "- Inputs:",
  "  - `AGENTS.md`",
  "- Do:",
  "  - Run read-only checks.",
  "- Acceptance:",
  "  - Inspection result is documented.",
  "- Expected outputs:",
  "  - `__garelier/<pm_id>/control/inspections/quality/YYYY/MM/inspect.md`",
  "",
  "### PP-2 — implement fix",
  "- Role: worker",
  "- Dispatch: after PP-1",
  "- Depends on: PP-1",
  "- Goal: Implement the bounded fix.",
  "- Inputs:",
  "  - `src/a.ts`",
  "- Allowed write paths:",
  "  - `src/**`",
  "  - `tests/**`",
  "- Forbidden write paths:",
  "  - `__garelier/**`",
  "- Do:",
  "  - Add a failing regression test first.",
  "  - Implement the fix.",
  "- Test discipline: tdd",
  "- Scope: bug fix",
  "- Acceptance:",
  "  - Regression test proves the fix.",
  "",
  "### PP-3 — harden integration",
  "- Role: smith",
  "- Dispatch: after PP-2 merged into studio",
  "- Depends on: PP-2",
  "- Goal: Verify the studio tip after merge.",
  "- Inputs:",
  "  - PP-2 merge SHA",
  "- Allowed write paths:",
  "  - `tests/integration/**`",
  "- Do:",
  "  - Run or add integration coverage.",
  "- Acceptance:",
  "  - Integration evidence is recorded.",
].join("\n");

describe("buildPipelinePlan", () => {
  test("plans commit-bearing and read-only package commands", () => {
    const plan = buildPipelinePlan({
      blueprintPath: "__garelier/pm/control/blueprints/demo.md",
      blueprintMd: blueprint,
      pmId: "pm",
      projectRoot: "C:/repo",
      base: "garelier/main/pm/studio",
    });
    expect(plan.summary).toMatchObject({ packages: 3, ready: 3, blocked: 0, legacy_fallback: false });
    expect(plan.packages[0].path).toBe("read-only");
    expect(plan.packages[0].command).toContain("readonly_assignment_prep.ts");
    expect(plan.packages[0].command).toContain("--package 'PP-1'");
    expect(plan.packages[1].path).toBe("commit-bearing");
    expect(plan.packages[1].command).toContain("dispatch_prepare.sh");
    expect(plan.packages[1].command).toContain("--pipeline-package 'PP-2'");
    expect(plan.packages[2].role).toBe("smith");
    expect(renderPlanMarkdown(plan)).toContain("Pipeline dispatch plan");
  });

  test("falls back cleanly when a legacy blueprint has no Pipeline packages", () => {
    const plan = buildPipelinePlan({
      blueprintPath: "legacy.md",
      blueprintMd: "# Blueprint: legacy\n\n## Goal\nDo work.\n",
      pmId: "pm",
    });
    expect(plan.summary.legacy_fallback).toBe(true);
    expect(plan.packages[0].status).toBe("legacy-fallback");
    expect(plan.packages[0].command).toBeNull();
  });
});
