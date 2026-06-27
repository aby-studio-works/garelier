import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoleDocDiet } from "./role_doc_diet.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, "utf8");
}

describe("buildRoleDocDiet", () => {
  test("reports prompt-surface size and compact-hook warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "doc-diet-"));
    dirs.push(root);
    write(root, "skills/garelier-worker/SKILL.md", "# Worker\n\nRead context.json first.\n");
    write(root, "skills/garelier-worker/references/main.md", "one two three\n");
    write(root, "skills/garelier-smith/SKILL.md", "# Smith\n\nNo compact hook here.\n");
    write(root, "skills/garelier-smith/references/large.md", Array.from({ length: 3601 }, (_, i) => `w${i}`).join(" "));

    const report = buildRoleDocDiet(root);
    expect(report.roles.map((r) => r.skill).sort()).toEqual(["garelier-smith", "garelier-worker"]);
    const worker = report.roles.find((r) => r.skill === "garelier-worker")!;
    expect(worker.has_compact_hook).toBe(true);
    expect(worker.warnings).toEqual([]);
    const smith = report.roles.find((r) => r.skill === "garelier-smith")!;
    expect(smith.has_compact_hook).toBe(false);
    expect(smith.warnings).toContain("no compact read-first hook detected");
    expect(smith.warnings).toContain("largest reference over 3500 words");
  });
});
