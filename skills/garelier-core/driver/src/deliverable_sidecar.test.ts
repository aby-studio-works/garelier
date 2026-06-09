import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELIVERABLE_SIDECAR_SCHEMA_VERSION,
  deliverableSidecarSummary,
  normalizeDeliverableSidecar,
  readDeliverableSidecarForMarkdown,
  sidecarPathForMarkdown,
} from "./deliverable_sidecar.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("deliverable sidecars", () => {
  test("maps markdown deliverables to sibling json sidecars", () => {
    expect(sidecarPathForMarkdown("/x/report.md")).toBe("/x/report.json");
    expect(sidecarPathForMarkdown("/x/2026-06-02-topic.md")).toBe("/x/2026-06-02-topic.json");
    expect(sidecarPathForMarkdown("/x/report.txt")).toBeNull();
  });

  test("normalizes compact schema v1 and builds a routing summary", () => {
    const s = normalizeDeliverableSidecar({
      schema_version: 1,
      assignment_id: "A-012",
      role: "worker",
      status: "done",
      summary: "Implemented the core path.",
      commits: ["abc123"],
      files_changed: ["src/a.ts"],
      tests: { fast: "passed", full: "not_run" },
      risk_flags: { security: false, external_write: true },
      needs: ["dock_review"],
    });
    expect(s?.schemaVersion).toBe(1);
    expect(s?.commits).toEqual(["abc123"]);
    expect(deliverableSidecarSummary(s!)).toContain("status=done");
    expect(deliverableSidecarSummary(s!)).toContain("tests fast:passed");
    expect(deliverableSidecarSummary(s!)).toContain("risks external_write");
  });

  test("reads a sibling sidecar and ignores invalid schema", () => {
    const root = mkdtempSync(join(tmpdir(), "sidecar-")); dirs.push(root);
    const report = join(root, "report.md");
    writeFileSync(report, "# Report\n");
    writeFileSync(join(root, "report.json"), JSON.stringify({ schema_version: 1, summary: "compact" }));
    expect(readDeliverableSidecarForMarkdown(report)?.summary).toBe("compact");
    writeFileSync(join(root, "report.json"), JSON.stringify({ schema_version: 2, summary: "future" }));
    expect(readDeliverableSidecarForMarkdown(report)).toBeNull();
  });

  test("bundled sidecar templates are compact schema v1 json", () => {
    const templates = ["report.json", "review.json", "guardian_report.json", "concierge_report.json", "inspection.json"];
    for (const name of templates) {
      const raw = readFileSync(join(import.meta.dir, "..", "..", "templates", name), "utf8");
      const obj = JSON.parse(raw) as Record<string, unknown>;
      expect(normalizeDeliverableSidecar(obj)).not.toBeNull();
      expect(obj.schema_version).toBe(DELIVERABLE_SIDECAR_SCHEMA_VERSION);
      expect(obj.summary).toBeTruthy();
      expect("body" in obj).toBe(false);
      expect("markdown" in obj).toBe(false);
    }
  });
});
