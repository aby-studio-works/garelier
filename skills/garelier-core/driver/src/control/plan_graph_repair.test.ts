import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";
import { applyPlanGraphRepairPlan, createPlanGraphRepairPlan } from "./plan_graph_repair.ts";
import { loadPlanGraphModel } from "./plan_graph_model.ts";
import { openControlSession } from "./sessions.ts";
import { planGraphRuntimeCallbacks } from "./plan_graph_write.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const at = (iso: string) => () => new Date(iso);

function document(frontmatter: string[], body: string): string {
  return `+++\n${frontmatter.join("\n")}\n+++\n${body}`;
}

const lifecycle = ['created = "2026-07-20T09:00:00+09:00"', 'updated = "2026-07-20T09:00:00+09:00"'];

/** A minimal, otherwise-strict-valid schema-3 control tree — same dashboard
 *  scaffold shape as plan_graph_model.test.ts's tempControl(), rooted under
 *  `__garelier/<pmId>/control` so `{ targetRoot: root, pmId }` resolves via
 *  the standard convention (no controlRoot/runtimeRoot override needed). */
function fixture(pmId = "pm1"): { root: string; control: string } {
  const root = mkdtempSync(join(tmpdir(), "control-schema3-repair-"));
  roots.push(root);
  const control = join(root, "__garelier", pmId, "control");
  for (const path of ["project_dashboard", "roadmaps", "milestones", "backlog/open", "backlog/archive/2025", "backlog/archive/2026", "backlog_views", "checkpoints/active", "checkpoints/archive/2025", "risks/open", "notes", "decisions", "blueprints"]) {
    mkdirSync(join(control, path), { recursive: true });
  }
  writeFileSync(join(control, "control.toml"), [
    "schema_version = 3", 'kind = "garelier_control"', `pm_id = "${pmId}"`, 'mode = "control_only"', 'storage = "plan_graph_markdown"',
    "", "[control]", "max_resume_bytes = 24576", "",
  ].join("\n"));
  writeFileSync(join(control, "project_dashboard/current.md"), [
    "# Current", "", "## Standing instructions", "", "Preserve canonical Markdown bodies.", "",
    "## Current position", "", "Repair fixture.", "", "## Active checkpoints", "", "- Primary checkpoint: -", "",
    "## Blockers and decisions required", "", "- None.", "", "## Read first", "", "- None.", "",
  ].join("\n"));
  writeFileSync(join(control, "project_dashboard/notes.md"), "# Notes\n\nNone.\n");
  writeFileSync(join(control, "project_dashboard/README.md"), "# Project Dashboard\n");
  writeFileSync(join(control, "project_dashboard/roadmap.md"), "# Roadmaps\n\n<!-- garelier-generated:roadmap-index:start -->\n<!-- garelier-generated:roadmap-index:end -->\n");
  writeFileSync(join(control, "project_dashboard/backlog.md"), "# Backlog views\n\n<!-- garelier-generated:backlog-index:start -->\n<!-- garelier-generated:backlog-index:end -->\n");
  writeFileSync(join(control, "project_dashboard/decisions.md"), "# Decisions\n\n<!-- garelier-generated:decision-index:start -->\n<!-- garelier-generated:decision-index:end -->\n");
  writeFileSync(join(control, "project_dashboard/risks.md"), "# Risks\n\n<!-- garelier-generated:risk-index:start -->\n<!-- garelier-generated:risk-index:end -->\n");
  writeFileSync(join(control, "project_dashboard/quality_gates.md"), "# Quality Gates\n\n<!-- garelier-generated:quality-gates:start -->\n<!-- garelier-generated:quality-gates:end -->\n");
  // A full write-transaction (runControlFilePlanTransaction, used by both
  // openControlSession and applyPlanGraphRepairPlan) needs a seeded
  // generation.json. A schema-3 control namespace is transactionally active
  // from the moment control.toml exists, so canonical setup initializes the
  // generation marker alongside it. Mirrors plan_graph_cli.test.ts's fixture.
  const runtime = join(root, "__garelier", pmId, "runtime", "control");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "generation.json"), `${JSON.stringify({
    schema_version: 2,
    kind: "garelier_control_generation",
    control_schema_version: 3,
    storage: "plan_graph_markdown",
    incarnation: "44444444-4444-4444-8444-444444444444",
    generation: 0,
    state: "stable",
    operation: "fixture",
    session_id: "fixture",
    updated_at: "2026-07-26T00:00:00Z",
  })}\n`);
  return { root, control };
}

function backlogBody(id: string, title: string, extraSections = ""): string {
  return `# ${id}: ${title}\n\n## Outcome\n\n-\n\n## Acceptance criteria\n\n- Yes.\n\n## Current position\n\n-\n\n## Exact next action\n\n-\n\n## Evidence\n\n- none\n${extraSections}`;
}

function writeBareBacklog(control: string, id: string, status: string, title: string, extraSections = "", timestamps: readonly string[] = lifecycle): string {
  const path = join(control, "backlog/open", `${id}.md`);
  writeFileSync(path, document(["schema_version = 3", 'kind = "garelier_backlog"', `id = "${id}"`, `status = "${status}"`, ...timestamps], backlogBody(id, title, extraSections)));
  return path;
}

describe("schema-3 repair engine (W-207 D4)", () => {
  // W-677: the 8 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("moves a bare id-only Backlog to a title-derived canonical path, content otherwise unchanged (+7 folded cases)", () => {
    // case: moves a bare id-only Backlog to a title-derived canonical path, content otherwise unchanged
    {
      const { root, control } = fixture();
      writeBareBacklog(control, "W-100", "ready", "Fix the widget");
      const plan = createPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1" });
      expect(plan.changes).toEqual([{ entity: "backlog:W-100", from_path: "backlog/open/W-100.md", to_path: "backlog/open/W-100-fix-the-widget.md", reason: ["move to canonical schema-3 lifecycle path (was backlog/open/W-100.md)"] }]);
    }
    // case: a duplicate-id collision (canonical + non-canonical file for the same Backlog) is left alone by repair, not silently resolved
    {
      const { root, control } = fixture();
      writeFileSync(join(control, "backlog/open/W-300-canonical-slug.md"), document(["schema_version = 3", 'kind = "garelier_backlog"', 'id = "W-300"', 'status = "ready"', ...lifecycle], backlogBody("W-300", "Canonical winner")));
      writeBareBacklog(control, "W-300", "ready", "Bare loser");
      const before = loadPlanGraphModel(control);
      expect(before.findings).toContainEqual(expect.objectContaining({ code: "backlog-identity-duplicate", path: "backlog/open/W-300.md" }));
      expect(before.findings).toContainEqual(expect.objectContaining({ code: "backlog-filename-mismatch", path: "backlog/open/W-300.md" }));
      const plan = createPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1" });
      expect(plan.changes.filter((change) => change.entity === "backlog:W-300")).toEqual([]);
    }
    // case: preserves an already-canonical record's existing slug even after its title drifts — no false rename
    {
      const { root, control } = fixture();
      writeFileSync(join(control, "backlog/open/W-104-original-slug.md"), document(["schema_version = 3", 'kind = "garelier_backlog"', 'id = "W-104"', 'status = "ready"', ...lifecycle], backlogBody("W-104", "A brand-new title that would slugify completely differently")));
      const plan = createPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1" });
      expect(plan.changes).toEqual([]);
    }
    // case: renames a record whose EXISTING filename slug is itself non-canonical (leading underscore) instead of silently skipping it
    {
      const { root, control } = fixture();
      writeFileSync(join(control, "backlog/open/W-108-_bad.md"), document(["schema_version = 3", 'kind = "garelier_backlog"', 'id = "W-108"', 'status = "ready"', ...lifecycle], backlogBody("W-108", "Legit title")));
      const plan = createPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1" });
      expect(plan.changes).toEqual([{ entity: "backlog:W-108", from_path: "backlog/open/W-108-_bad.md", to_path: "backlog/open/W-108-legit-title.md", reason: ["move to canonical schema-3 lifecycle path (was backlog/open/W-108-_bad.md)"] }]);
    }
    // case: a bare record with an all-non-ASCII title still repairs to a canonical path
    {
      const { root, control } = fixture();
      writeBareBacklog(control, "W-109", "ready", "日本語のみのタイトル");
      const plan = createPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1" });
      expect(plan.changes).toEqual([{ entity: "backlog:W-109", from_path: "backlog/open/W-109.md", to_path: "backlog/open/W-109-item.md", reason: ["move to canonical schema-3 lifecycle path (was backlog/open/W-109.md)"] }]);
    }
    // case: moves a bare Checkpoint filename to its canonical slug path
    {
      const { root, control } = fixture();
      writeFileSync(join(control, "checkpoints/active/CP-100.md"), document(["schema_version = 3", 'kind = "garelier_checkpoint"', 'id = "CP-100"', 'status = "active"', ...lifecycle], "# CP-100: Focus checkpoint\n\n## Current position\n\n### Last completed\n\n-\n\n### Exact next action\n\n-\n\n## Blockers / external decisions\n\n-\n\n## Read first on resume\n\n-\n\n## Resume verification\n\n-\n"));
      const plan = createPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1" });
      expect(plan.changes).toEqual([{ entity: "checkpoint:CP-100", from_path: "checkpoints/active/CP-100.md", to_path: "checkpoints/active/CP-100-focus-checkpoint.md", reason: ["move to canonical schema-3 lifecycle path (was checkpoints/active/CP-100.md)"] }]);
    }
    // case: self-bootstraps a session against a tree that has been non-canonical since checkout (no prior healthy session) and is idempotent on a second run
    {
      const { root, control } = fixture();
      writeBareBacklog(control, "W-105", "ready", "Bootstrap case");
      writeBareBacklog(control, "W-106", "ready", "Second bare row");
      // No session-open call here at all — this is the exact chicken-and-egg
      // scenario a freshly checked-out worktree hits (D4's motivating bug):
      // openControlSession's normal strict runtime callback cannot open a
      // session against a tree that is already non-canonical.
      const plan = createPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1" });
      expect(plan.changes).toHaveLength(2);
      const result = applyPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1", planId: plan.plan_id, sessionId: "cs_bootstrap", agent: "repair-bootstrap" }, plan);
      expect(result.status).toBe("committed");
      const model = loadPlanGraphModel(control);
      expect(model.findings.filter((finding) => finding.severity === "error")).toEqual([]);
      expect(model.backlog.get("W-105")?.status).toBe("ready");
      // Idempotent: a fresh plan against the now-repaired tree is empty.
      const second = createPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1" });
      expect(second.changes).toEqual([]);
      // And a normal session can now be opened — repair actually unblocked the
      // tree, it didn't just work around the check for its own single call.
      const session = openControlSession({ targetRoot: root, pmId: "pm1", agent: "post-repair", sessionId: "cs_post_repair", cwd: root, runtimeCallbacks: planGraphRuntimeCallbacks });
      expect(session.control_schema_version).toBe(3);
    }
    // case: apply is stale-rejected against a plan digest that no longer matches the tree
    {
      const { root, control } = fixture();
      writeBareBacklog(control, "W-107", "ready", "Stale plan case");
      const plan = createPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1" });
      writeFileSync(join(control, "backlog/open/W-107.md"), document(["schema_version = 3", 'kind = "garelier_backlog"', 'id = "W-107"', 'status = "ready"', ...lifecycle], backlogBody("W-107", "Mutated after planning")));
      expect(() => applyPlanGraphRepairPlan({ targetRoot: root, pmId: "pm1", planId: plan.plan_id, sessionId: "cs_stale", agent: "repair-test" }, plan)).toThrow();
    }
  });
});
