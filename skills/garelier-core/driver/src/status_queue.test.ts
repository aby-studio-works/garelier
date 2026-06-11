import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQueue } from "./status_queue.ts";
import { _resetWorkspaceCache } from "./workspace.ts";

const dirs: string[] = [];
afterEach(() => {
  _resetWorkspaceCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function proj(inFlightMd: string, pendingMd: string): string {
  const root = mkdtempSync(join(tmpdir(), "symphq-")); dirs.push(root);
  const backlog = join(root, "__garelier", "pm", "runtime", "backlog");
  mkdirSync(backlog, { recursive: true });
  writeFileSync(join(backlog, "in_flight.md"), inFlightMd, "utf8");
  writeFileSync(join(backlog, "pending.md"), pendingMd, "utf8");
  return root;
}

describe("buildQueue: a dispatched task is never double-listed (in-flight ∧ pending)", () => {
  const inflight =
    "| Task | Agent | Blueprint | Milestone | Branch | Dispatched |\n" +
    "| --- | --- | --- | --- | --- | --- |\n" +
    "| #15 | worker-01 | hp-p2-5 | m3 | workbench/#15/x | now |\n";
  const pending =
    "| Order | Task | Blueprint | Milestone | Role |\n" +
    "| --- | --- | --- | --- | --- |\n" +
    "| 09 | #15 | hp-p2-5 | m3 | worker |\n" +   // STALE: #15 already dispatched
    "| 11 | #16 | phase-r4 | m4 | worker |\n";

  test("#15 stays in in-flight but is dropped from pending (the ACTIVE-QUEUE/REVIEW double-show)", () => {
    const q = buildQueue(proj(inflight, pending), "pm", null);
    expect(q.inFlight.map((x) => x.task)).toContain("#15");
    expect(q.pending.map((p) => p.task)).not.toContain("#15"); // deduped
    expect(q.pending.map((p) => p.task)).toContain("#16");     // genuinely-pending kept
  });

  test("with nothing in flight, pending is untouched", () => {
    const emptyInflight = "| Task | Agent | Blueprint | Milestone | Branch | Dispatched |\n| --- | --- | --- | --- | --- | --- |\n";
    const q = buildQueue(proj(emptyInflight, pending), "pm", null);
    expect(q.pending.map((p) => p.task).sort()).toEqual(["#15", "#16"]);
  });
});

describe("buildQueue: structural truth (W-011) — live _dispatch<N> containers ARE the in-flight set", () => {
  function withDispatch(root: string, id: number, role: string, slug: string, branch: string): void {
    const c = join(root, "__garelier", "pm", `_dispatch${id}`);
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, "STATE.md"),
      `# Dispatch #${id} - ${role} ${slug}\n\n## Status\n\nWORKING\n\n## Current task\n\n#${id} ${slug} (${branch})\n`, "utf8");
  }

  test("a live container appears in-flight with NO in_flight.md at all (the missing-#37 class)", () => {
    const root = mkdtempSync(join(tmpdir(), "symphq-")); dirs.push(root);
    mkdirSync(join(root, "__garelier", "pm", "runtime", "backlog"), { recursive: true });
    withDispatch(root, 40, "worker", "instance-upload", "garelier/main/pm/workbench/#40/instance-upload");
    const q = buildQueue(root, "pm", null);
    expect(q.inFlight.map((x) => x.task)).toContain("#40 instance-upload");
    expect(q.inFlight[0].role).toBe("worker");
    expect(q.inFlight[0].branch).toBe("garelier/main/pm/workbench/#40/instance-upload");
    expect(q.present).toBe(true);
  });

  test("structural row dedupes the generated-view row for the same task id, and prunes pending by id", () => {
    const inflight =
      "| Task | Agent | Branch |\n| --- | --- | --- |\n" +
      "| #40 instance-upload | dispatch40 (worker) | garelier/main/pm/workbench/#40/instance-upload |\n";
    const pending =
      "| Order | Task | Blueprint | Milestone | Role |\n| --- | --- | --- | --- | --- |\n" +
      "| 01 | #40 instance-upload | bp | m9 | worker |\n" +
      "| 02 | #41 next-thing | bp | m9 | worker |\n";
    const root = proj(inflight, pending);
    withDispatch(root, 40, "worker", "instance-upload", "garelier/main/pm/workbench/#40/instance-upload");
    const q = buildQueue(root, "pm", null);
    expect(q.inFlight.filter((x) => x.task.includes("#40")).length).toBe(1); // not doubled
    expect(q.pending.map((p) => p.task)).toEqual(["#41 next-thing"]);        // #40 pruned by id
  });
});

