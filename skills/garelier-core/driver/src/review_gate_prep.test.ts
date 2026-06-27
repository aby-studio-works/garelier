import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewGatePrep } from "./review_gate_prep.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(root: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", root, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

function repo(): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "review-prep-"));
  dirs.push(root);
  run(root, ["init"]);
  run(root, ["config", "user.email", "test@example.invalid"]);
  run(root, ["config", "user.name", "Test User"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  run(root, ["add", "."]);
  run(root, ["commit", "-m", "base"]);
  const base = run(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
  writeFileSync(join(root, "src", "a.test.ts"), "test('a', () => {});\n", "utf8");
  run(root, ["add", "."]);
  run(root, ["commit", "-m", "head"]);
  const head = run(root, ["rev-parse", "HEAD"]);
  return { root, base, head };
}

describe("buildReviewGatePrep", () => {
  test("writes a review brief and appends prepared context to assignment", () => {
    const { root, base, head } = repo();
    const outDir = join(root, "__garelier", "pm", "_observers", "observer-01");
    mkdirSync(outDir, { recursive: true });
    const assignment = join(outDir, "assignment.md");
    writeFileSync(assignment, "# Observer assignment\n\n## Goal\nReview the diff.\n", "utf8");

    const result = buildReviewGatePrep({
      role: "observer",
      projectRoot: root,
      base,
      head,
      outDir,
      assignmentPath: assignment,
      updateAssignment: true,
    });

    expect(existsSync(result.review_brief)).toBe(true);
    expect(result.updated_assignment).toBe(true);
    const brief = JSON.parse(readFileSync(result.review_brief, "utf8"));
    expect(brief.files.map((f: { path: string }) => f.path).sort()).toEqual(["src/a.test.ts", "src/a.ts"]);
    expect(readFileSync(assignment, "utf8")).toContain("## Prepared context");
  });

  test("Guardian prep leaves a scan draft path for the gate handoff", () => {
    const { root, base, head } = repo();
    const outDir = join(root, "__garelier", "pm", "_guardians", "guardian-01");
    const result = buildReviewGatePrep({ role: "guardian", projectRoot: root, base, head, outDir });

    expect(existsSync(result.review_brief)).toBe(true);
    expect(result.guardian_scan_draft).not.toBeNull();
    expect(existsSync(result.guardian_scan_draft!)).toBe(true);
    const scan = JSON.parse(readFileSync(result.guardian_scan_draft!, "utf8"));
    expect(String(scan.generated_by)).toMatch(/guardian_scan\.ts|review_gate_prep\.ts/);
    expect(["PASS", "PASS_WITH_NOTES", "BLOCK", "NO_OPINION"]).toContain(scan.provisional_verdict);
  });
});
