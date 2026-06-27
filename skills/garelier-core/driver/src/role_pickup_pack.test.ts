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
  test("builds compact pickup packs for all producer roles", () => {
    const root = tmp();
    const assignmentPath = join(root, "assignment.md");
    const contextPath = join(root, "context.json");
    const roleIndexPath = join(root, "role_index.toml");
    writeFileSync(assignmentPath, assignment, "utf8");
    writeFileSync(contextPath, JSON.stringify({ task: { id: 12 }, project: { target_slug: "main" } }), "utf8");
    const roles: PickupRole[] = ["worker", "scout", "smith", "artisan", "librarian", "concierge"];
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
      expect(pack.warnings).toEqual([]);
    }
  });
});
