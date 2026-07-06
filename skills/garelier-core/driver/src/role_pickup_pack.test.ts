import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRolePickupPack, type PickupRole } from "./role_pickup_pack.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pickup-pack-"));
  dirs.push(d);
  return d;
}

const assignment = [
  "# Assignment: Implement bounded behavior",
  "",
  "## Inputs",
  "",
  "- `__garelier/pm/control/blueprints/demo.md` (section: Pipeline packages / PP-2)",
  "- `src/a.ts`",
  "",
  "## Goal",
  "",
  "Implement one small behavior.",
  "",
  "## Do",
  "",
  "- Add the failing test.",
  "- Implement the code.",
  "",
  "## Acceptance",
  "",
  "- Test fails first and passes after.",
  "",
  "## Allowed write paths",
  "",
  "- `src/**`",
  "",
  "## Forbidden write paths",
  "",
  "- `__garelier/**`",
  "",
  "## Expected outputs",
  "",
  "- `report.md`",
  "",
  "## Prepared context",
  "",
  "- `context.json`",
  "",
  "## Test discipline",
  "",
  "- Mode: tdd",
].join("\n");

function roleIndex(roles: PickupRole[]): string {
  return roles.map((r) => [
    `[roles.${r}]`,
    `read_first = ["quality/${r}.md"]`,
    `on_demand = ["engineering/${r}.md"]`,
    "",
  ].join("\n")).join("\n");
}

describe("buildRolePickupPack", () => {
  test("builds compact pickup packs for all producer + coordinator roles", () => {
    const root = tmp();
    const assignmentPath = join(root, "assignment.md");
    const contextPath = join(root, "context.json");
    const roleIndexPath = join(root, "role_index.toml");
    writeFileSync(assignmentPath, assignment, "utf8");
    writeFileSync(contextPath, JSON.stringify({ task: { id: 12 }, project: { target_slug: "main" } }), "utf8");
    // pm/dock are coordinators, not producers, but they resolve the same
    // role_index knowledge surface so decision/dispatch context reaches them
    // deterministically (W-067).
    const roles: PickupRole[] = ["worker", "scout", "smith", "artisan", "librarian", "concierge", "pm", "dock"];
    writeFileSync(roleIndexPath, roleIndex(roles), "utf8");

    for (const role of roles) {
      const pack = buildRolePickupPack({ role, assignmentPath, assignmentMd: assignment, contextPath, roleIndexPath });
      expect(pack.role).toBe(role);
      expect(pack.advisory).toBe(true);
      expect(pack.task.package_id).toBe("PP-2");
      expect(pack.task.test_mode).toBe("tdd");
      expect(pack.assignment.do).toContain("Add the failing test.");
      expect(pack.assignment.acceptance[0]).toContain("Test fails first");
      expect(pack.assignment.prepared_context).toEqual(["`context.json`"]);
      expect(pack.knowledge.read_first).toEqual([`quality/${role}.md`]);
      expect(pack.knowledge.on_demand).toEqual([`engineering/${role}.md`]);
      expect(pack.knowledge.triggered).toEqual([]);
      expect(pack.warnings).toEqual([]);
    }
  });

  // [[triggers]] promotion (DEC-067, W-064 #8). role_index [[triggers]] whose
  // `when` matches the assignment text/paths get their `read` docs pre-computed
  // into knowledge.triggered, the same deterministic shape as read_first.
  const roleIndexWithTriggers = [
    "[[triggers]]",
    // keyword match: "bounded" is in the assignment title.
    'when = ["bounded", "nonexistent-zzz"]',
    'read = ["engineering/change_propagation_policy.md"]',
    "",
    "[[triggers]]",
    // path glob: matches the `src/a.ts` input / `src/**` allowed write path.
    'when = ["src/**"]',
    'read = ["engineering/change_isolation_policy.md"]',
    "",
    "[[triggers]]",
    // no term matches this assignment.
    'when = ["totally-absent-keyword"]',
    'read = ["quality/should_not_fire.md"]',
    "",
    "[[triggers]]",
    // fires, but its doc is already in worker read_first -> excluded from delta.
    'when = ["behavior"]',
    'read = ["quality/worker.md"]',
    "",
    // reviewer-direction glob: only matches when diff paths are supplied.
    "[[triggers]]",
    'when = ["core/engine/**"]',
    'read = ["engineering/refactoring_playbook.md"]',
    "",
    "[roles.worker]",
    'read_first = ["quality/worker.md"]',
    'on_demand = ["engineering/worker.md"]',
    "",
  ].join("\n");

  test("promotes matched [[triggers]].read docs into knowledge.triggered", () => {
    const root = tmp();
    const assignmentPath = join(root, "assignment.md");
    const roleIndexPath = join(root, "role_index.toml");
    writeFileSync(assignmentPath, assignment, "utf8");
    writeFileSync(roleIndexPath, roleIndexWithTriggers, "utf8");

    const pack = buildRolePickupPack({ role: "worker", assignmentPath, assignmentMd: assignment, roleIndexPath });
    // keyword + glob fire; absent keyword does not; read_first doc is deduped.
    expect(pack.knowledge.triggered).toEqual([
      "engineering/change_propagation_policy.md",
      "engineering/change_isolation_policy.md",
    ]);
    expect(pack.knowledge.read_first).toEqual(["quality/worker.md"]);
    expect(pack.warnings).toEqual([]);
  });

  test("reviewer diff paths fire path-glob triggers (knowledge-consult.md §1b)", () => {
    const root = tmp();
    const assignmentPath = join(root, "assignment.md");
    const roleIndexPath = join(root, "role_index.toml");
    writeFileSync(assignmentPath, assignment, "utf8");
    writeFileSync(roleIndexPath, roleIndexWithTriggers, "utf8");

    // Without diff paths the core/engine/** trigger does not fire.
    const noDiff = buildRolePickupPack({ role: "worker", assignmentPath, assignmentMd: assignment, roleIndexPath });
    expect(noDiff.knowledge.triggered).not.toContain("engineering/refactoring_playbook.md");

    // A diff touching core/engine/ fires it.
    const withDiff = buildRolePickupPack({
      role: "worker",
      assignmentPath,
      assignmentMd: assignment,
      roleIndexPath,
      diffPaths: ["core/engine/render_graph.rs"],
    });
    expect(withDiff.knowledge.triggered).toContain("engineering/refactoring_playbook.md");
  });
});
