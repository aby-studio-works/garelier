import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareReadOnlyAssignment } from "./readonly_assignment_prep.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "readonly-prep-"));
  dirs.push(root);
  mkdirSync(join(root, "__garelier", "pm", "_pm"), { recursive: true });
  mkdirSync(join(root, "__garelier", "pm", "knowledge"), { recursive: true });
  writeFileSync(join(root, "__garelier", "pm", "_pm", "setup_config.toml"), [
    "[project]",
    'name = "Test"',
    "",
    "[branches]",
    'target = "main"',
    'target_slug = "main"',
    'integration = "garelier/main/pm/studio"',
    "",
    "[quality_gate]",
    'commands = ["bun test"]',
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "__garelier", "pm", "knowledge", "role_index.toml"), [
    "[roles.scout]",
    'read_first = ["quality/test_strategy.md"]',
    'on_demand = ["quality/flakes.md"]',
  ].join("\n"), "utf8");
  return root;
}

const blueprint = [
  "# Blueprint: read-only package",
  "",
  "## Context pack",
  "- Entry points: `src/a.ts`",
  "- Invariants: no writes",
  "- Local verify: `bun test`",
  "",
  "## Pipeline packages",
  "",
  "### PP-1 — investigate flaky check",
  "- Role: scout",
  "- Dispatch: immediate",
  "- Goal: Run read-only diagnostics for the flaky check.",
  "- Inputs:",
  "  - `AGENTS.md`",
  "  - `src/a.ts`",
  "- Do:",
  "  - Run diagnostics without modifying tracked files.",
  "- Acceptance:",
  "  - Inspection states pass/fail and exact command evidence.",
  "- Expected outputs:",
  "  - `__garelier/<pm_id>/control/inspections/quality/YYYY/MM/flaky-check.md`",
].join("\n");

describe("prepareReadOnlyAssignment", () => {
  test("renders Scout assignment/context/pickup without creating a checkout", async () => {
    const root = project();
    const bp = join(root, "__garelier", "pm", "control", "blueprints", "demo.md");
    mkdirSync(join(bp, ".."), { recursive: true });
    writeFileSync(bp, blueprint, "utf8");
    const container = join(root, "__garelier", "pm", "_scouts", "scout-01");

    const result = await prepareReadOnlyAssignment({
      projectRoot: root,
      pmId: "pm",
      role: "scout",
      blueprintPath: bp,
      packageId: "PP-1",
      container,
      taskId: "21",
      agentId: "scout(#21)",
      baseBranch: "garelier/main/pm/studio",
    });

    expect(result.package_id).toBe("PP-1");
    expect(existsSync(result.assignment)).toBe(true);
    expect(existsSync(result.context)).toBe(true);
    expect(existsSync(result.pickup_pack)).toBe(true);
    expect(existsSync(join(container, "checkout"))).toBe(false);
    expect(readFileSync(result.assignment, "utf8")).toContain("Scout is commit-free");
    const pickup = JSON.parse(readFileSync(result.pickup_pack, "utf8"));
    expect(pickup.task.package_id).toBe("PP-1");
    expect(pickup.knowledge.read_first).toEqual(["quality/test_strategy.md"]);
  });
});
