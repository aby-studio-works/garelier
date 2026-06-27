import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkflow } from "./status_workflow.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "workflow-"));
  dirs.push(r);
  return r;
}

const blueprint = [
  "# Blueprint: workflow demo",
  "",
  "## Pipeline packages",
  "",
  "### PP-1 — implement behavior",
  "- Role: worker",
  "- Dispatch: immediate",
  "- Goal: Implement the behavior.",
  "- Inputs:",
  "  - `src/a.ts`",
  "- Allowed write paths:",
  "  - `src/**`",
  "- Do:",
  "  - Implement the behavior.",
  "- Acceptance:",
  "  - Behavior is covered.",
  "",
  "### PP-2 — inspect behavior",
  "- Role: scout",
  "- Dispatch: after PP-1",
  "- Depends on: PP-1",
  "- Goal: Inspect behavior without commits.",
  "- Inputs:",
  "  - PP-1 report",
  "- Do:",
  "  - Run read-only verification.",
  "- Acceptance:",
  "  - Inspection is recorded.",
  "- Expected outputs:",
  "  - `__garelier/<pm_id>/control/inspections/quality/YYYY/MM/inspect.md`",
  "",
  "### PP-10 — completed audit",
  "- Role: scout",
  "- Dispatch: manual",
  "- Goal: Record a completed read-only audit.",
  "- Inputs:",
  "  - `AGENTS.md`",
  "- Do:",
  "  - Confirm the audit evidence.",
  "- Acceptance:",
  "  - Audit event is visible.",
  "- Expected outputs:",
  "  - `__garelier/<pm_id>/control/inspections/quality/YYYY/MM/audit.md`",
].join("\n");

describe("buildWorkflow", () => {
  test("maps blueprint packages to live dispatch containers and events", () => {
    const project = root();
    const bpDir = join(project, "__garelier", "pm", "control", "blueprints");
    const dispatch = join(project, "__garelier", "pm", "_dispatch7");
    const eventDir = join(project, "__garelier", "pm", "runtime", "dispatch");
    mkdirSync(bpDir, { recursive: true });
    mkdirSync(dispatch, { recursive: true });
    mkdirSync(eventDir, { recursive: true });
    writeFileSync(join(bpDir, "workflow-demo.md"), blueprint, "utf8");
    writeFileSync(join(dispatch, "assignment.md"), [
      "# Assignment: implement behavior",
      "",
      "## Inputs",
      "- `__garelier/pm/control/blueprints/workflow-demo.md` (section: Pipeline packages / PP-1)",
      "",
      "## Goal",
      "Implement.",
    ].join("\n"), "utf8");
    writeFileSync(join(dispatch, "STATE.md"), "# Dispatch #7 - worker implement\n\n## Status\n\nWORKING\n\n## Current task\n\n#7 implement\n", "utf8");
    writeFileSync(join(dispatch, "report.md"), "# Report\n", "utf8");
    writeFileSync(join(eventDir, "events.jsonl"), [
      JSON.stringify({
        ts: "2026-06-27T00:00:00.000Z",
        role: "worker(#7)",
        kind: "start",
        task: "#7 implement dispatched [PP-1]",
        ref: null,
      }),
      JSON.stringify({
        ts: "2026-06-27T00:01:00.000Z",
        role: "scout(#10)",
        kind: "complete",
        task: "#10 audit complete [PP-10]",
        ref: "__garelier/pm/control/inspections/quality/2026/06/audit.md",
      }),
    ].join("\n") + "\n", "utf8");

    const wf = buildWorkflow(project, "pm");
    expect(wf.present).toBe(true);
    expect(wf.counts.active).toBe(1);
    expect(wf.counts.planned).toBe(1);
    expect(wf.counts.done).toBe(1);
    const pp1 = wf.packages.find((p) => p.packageId === "PP-1")!;
    expect(pp1.status).toBe("active");
    expect(pp1.container).toContain("_dispatch7");
    expect(pp1.assignmentRel).toContain("assignment.md");
    expect(pp1.recentEvents[0].task).toContain("[PP-1]");
    expect(pp1.recentEvents.map((e) => e.task).join("\n")).not.toContain("[PP-10]");
    const pp2 = wf.packages.find((p) => p.packageId === "PP-2")!;
    expect(pp2.status).toBe("planned");
    expect(pp2.dependsOn).toEqual(["PP-1"]);
    const pp10 = wf.packages.find((p) => p.packageId === "PP-10")!;
    expect(pp10.status).toBe("done");
    expect(pp10.recentEvents[0].task).toContain("[PP-10]");
  });
});
