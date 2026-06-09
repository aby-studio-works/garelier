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

// DEC-057 / Mode D: under dispatch there are NO driver pid leases (producers are
// in-session subagents / a codex subprocess), so the lease-based capacity count
// is 0 for every role and Capacity wrongly read "0/N". buildCapacity now also
// counts roles whose STATE.md shows an active dispatch state.
describe("buildQueue capacity: dispatch mode (no pid leases) counts STATE.md-active roles", () => {
  function dispatchProj(workerState: string): string {
    const root = mkdtempSync(join(tmpdir(), "symphq-d-")); dirs.push(root);
    const pm = join(root, "__garelier", "pm");
    const backlog = join(pm, "runtime", "backlog");
    mkdirSync(backlog, { recursive: true });
    writeFileSync(join(backlog, "pending.md"),
      "| Order | Task | Blueprint | Milestone | Role |\n| --- | --- | --- | --- | --- |\n| 01 | #21 | bp | m1 | worker |\n", "utf8");
    // worker-01 mid-dispatch via STATE.md; deliberately NO runtime/driver/pids lease.
    const wdir = join(pm, "_workers", "worker-01");
    mkdirSync(wdir, { recursive: true });
    writeFileSync(join(wdir, "STATE.md"),
      `# Worker worker-01 — State\n\n## Status\n\n${workerState}\n\n## Current task\n\nImplementing #21\n`, "utf8");
    return root;
  }

  test("an active (WORKING) STATE.md with no lease counts as inFlight=1", () => {
    const config = { pmId: "pm", runner: { pm: {}, dock: {} }, workers: [{ id: "worker-01" }] } as never;
    const q = buildQueue(dispatchProj("WORKING"), "pm", config);
    expect(q.capacity.find((c) => c.role === "worker")).toMatchObject({ configured: 1, inFlight: 1 });
  });

  test("an IDLE STATE.md with no lease counts as inFlight=0", () => {
    const config = { pmId: "pm", runner: { pm: {}, dock: {} }, workers: [{ id: "worker-01" }] } as never;
    const q = buildQueue(dispatchProj("IDLE"), "pm", config);
    expect(q.capacity.find((c) => c.role === "worker")).toMatchObject({ configured: 1, inFlight: 0 });
  });
});
