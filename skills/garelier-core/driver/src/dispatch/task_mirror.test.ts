// task_mirror.ts — pins the W-027 hardening: cross-repo foreign-task protection
// and the completed-but-in-flight contradiction warning, plus a regression pin
// for the pre-existing create/update/complete behavior so neither fix silently
// widens or narrows the mirror's normal diff.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffOps,
  agentNameForSlug,
  buildDispatchDesired,
  scanDispatches,
  type CurrentTask,
  type DesiredTask,
  type DispatchInfo,
} from "./task_mirror.ts";

function desired(over: Partial<DesiredTask> & { key: string }): DesiredTask {
  return {
    subject: `${over.key}: title [ready]`,
    status: "pending",
    description: "d",
    activeForm: "Draining",
    dispatch: null,
    ...over,
  };
}

// --- foreign-task protection (real incident: a same-session Task list also
// carrying another project's own "W-NNN" id inside free text) --------------

test("a foreign task whose subject merely CONTAINS a W-NNN token is left untouched, not completed", () => {
  const current: CurrentTask[] = [
    { taskId: "5", subject: "Foreign W-043 RESUME (Garelier 改修完了後、sonnet worker)", status: "pending" },
  ];
  // This backlog has no W-043 item at all — the old, unanchored keyOf() would
  // have read "W-043" out of the foreign subject and completed it.
  const { ops, foreign } = diffOps(current, [desired({ key: "W-027" })]);
  expect(ops.find((o) => o.op === "complete")).toBeUndefined();
  expect(ops.find((o) => "taskId" in o && o.taskId === "5")).toBeUndefined();
  expect(foreign).toBe(1);
});

test("a foreign task never blocks the real create op for the backlog item it doesn't shadow", () => {
  const current: CurrentTask[] = [
    { taskId: "5", subject: "Foreign W-043 RESUME (Garelier 改修完了後、sonnet worker)", status: "pending" },
  ];
  const { ops } = diffOps(current, [desired({ key: "W-027" })]);
  expect(ops).toEqual([
    { op: "create", subject: "W-027: title [ready]", description: "d", activeForm: "Draining" },
  ]);
});

test("a mirror-owned task (subject starts with W-NNN: ) is still completed when its backlog item is gone", () => {
  const current: CurrentTask[] = [
    { taskId: "9", subject: "W-020: some old item [ready]", status: "pending" },
  ];
  const { ops, foreign } = diffOps(current, []);
  expect(ops).toEqual([{ op: "complete", taskId: "9", subject: "W-020: some old item [ready]" }]);
  expect(foreign).toBe(0);
});

// --- completed-but-in-flight contradiction warning --------------------------

test("warns when the Task list says completed but a live _dispatch<N> is still WORKING it", () => {
  const current: CurrentTask[] = [{ taskId: "8", subject: "W-027: title [ready]", status: "completed" }];
  const d = [desired({ key: "W-027", dispatch: { state: "WORKING", num: 3 } })];
  const { ops } = diffOps(current, d);
  expect(ops).toEqual([{ op: "warn", reason: "completed_but_in_flight", taskId: "8", dispatch: 3 }]);
});

test("does not warn when the live dispatch is REPORTING or BLOCKED (legitimately about to finish)", () => {
  for (const state of ["REPORTING", "BLOCKED"]) {
    const current: CurrentTask[] = [{ taskId: "8", subject: "W-027: title [ready]", status: "completed" }];
    const d = [desired({ key: "W-027", dispatch: { state, num: 3 } })];
    const { ops } = diffOps(current, d);
    expect(ops).toEqual([]);
  }
});

test("does not warn when there is no live dispatch backing the completed task", () => {
  const current: CurrentTask[] = [{ taskId: "8", subject: "W-027: title [ready]", status: "completed" }];
  const { ops } = diffOps(current, [desired({ key: "W-027" })]);
  expect(ops).toEqual([]);
});

// --- regression pin: normal create/update/complete unaffected --------------

test("creates a Task for a desired item absent from current", () => {
  const { ops } = diffOps([], [desired({ key: "W-027" })]);
  expect(ops).toEqual([
    { op: "create", subject: "W-027: title [ready]", description: "d", activeForm: "Draining" },
  ]);
});

test("updates a Task whose subject/status drifted from desired", () => {
  const current: CurrentTask[] = [{ taskId: "1", subject: "W-027: old title [triage]", status: "pending" }];
  const d = [desired({ key: "W-027", status: "in_progress" })];
  const { ops } = diffOps(current, d);
  expect(ops).toEqual([
    { op: "update", taskId: "1", subject: "W-027: title [ready]", status: "in_progress", description: "d", activeForm: "Draining" },
  ]);
});

test("no-ops when current already matches desired exactly", () => {
  const current: CurrentTask[] = [{ taskId: "1", subject: "W-027: title [ready]", status: "pending" }];
  const { ops } = diffOps(current, [desired({ key: "W-027" })]);
  expect(ops).toEqual([]);
});

// --- W-040: dispatch-unit desired tasks + auto-correct -----------------------

test("agentNameForSlug matches dispatch_prepare.sh's AGENT_NAME (ga-produce-<slug>, sanitized, truncated)", () => {
  expect(agentNameForSlug("do-x")).toBe("ga-produce-do-x");
  // a slug carrying a char outside [A-Za-z0-9_-] sanitizes to '-', same as the
  // bash `tr -c 'A-Za-z0-9_-' '-'` in dispatch_prepare.sh.
  expect(agentNameForSlug("odd/slug")).toBe("ga-produce-odd-slug");
  expect(agentNameForSlug("x".repeat(80)).length).toBe(64);
});

test("buildDispatchDesired: WORKING -> in_progress, owner=agent_name, worker-doing activeForm", () => {
  const d: DispatchInfo = { id: 83, role: "worker", slug: "gate-agent-naming", state: "WORKING" };
  const [t] = buildDispatchDesired([d]);
  expect(t.key).toBe("#83");
  expect(t.subject).toBe("#83: gate-agent-naming [dispatch:working]");
  expect(t.status).toBe("in_progress");
  expect(t.activeForm).toBe("gate-agent-naming を worker が実装中");
  expect(t.description).toContain("Owner: ga-produce-gate-agent-naming");
  expect(t.dispatch).toEqual({ state: "WORKING", num: 83 });
});

test("buildDispatchDesired: REPORTING -> in_progress, gate-review activeForm (merge 前)", () => {
  const d: DispatchInfo = { id: 5, role: "smith", slug: "anvil-fix", state: "REPORTING" };
  const [t] = buildDispatchDesired([d]);
  expect(t.subject).toBe("#5: anvil-fix [dispatch:reporting]");
  expect(t.status).toBe("in_progress");
  expect(t.activeForm).toBe("anvil-fix gate review 中 (merge 前)");
});

test("buildDispatchDesired: BLOCKED -> still in_progress (not completed — container is still live)", () => {
  const d: DispatchInfo = { id: 9, role: "worker", slug: "blocked-task", state: "BLOCKED" };
  const [t] = buildDispatchDesired([d]);
  expect(t.status).toBe("in_progress");
  expect(t.activeForm).toContain("ブロック中");
});

test("diffOps creates a Task for a live dispatch absent from current", () => {
  const d = buildDispatchDesired([{ id: 12, role: "worker", slug: "new-thing", state: "WORKING" }]);
  const { ops } = diffOps([], d);
  expect(ops).toEqual([
    { op: "create", subject: d[0].subject, description: d[0].description, activeForm: d[0].activeForm },
  ]);
});

test("diffOps AUTO-CORRECTS (update, not warn) a dispatch task the worker marked completed while its container is still live", () => {
  // Real friction this closes: "worker が task を勝手に completed 化 → PM が
  // gate 中に戻す" — the dispatch-keyed task's identity is unambiguous (the
  // container itself), so this is a correctable contradiction, not a warning.
  const current: CurrentTask[] = [{ taskId: "4", subject: "#83: gate-agent-naming [dispatch:working]", status: "completed" }];
  const d = buildDispatchDesired([{ id: 83, role: "worker", slug: "gate-agent-naming", state: "REPORTING" }]);
  const { ops } = diffOps(current, d);
  expect(ops).toEqual([
    { op: "update", taskId: "4", subject: d[0].subject, status: "in_progress", description: d[0].description, activeForm: d[0].activeForm },
  ]);
});

test("diffOps completes a dispatch task only once its container is gone (absent from desired)", () => {
  const current: CurrentTask[] = [{ taskId: "4", subject: "#83: gate-agent-naming [dispatch:reporting]", status: "in_progress" }];
  const { ops, foreign } = diffOps(current, []); // no live _dispatch83 anymore -> cleaned up
  expect(ops).toEqual([{ op: "complete", taskId: "4", subject: "#83: gate-agent-naming [dispatch:reporting]" }]);
  expect(foreign).toBe(0);
});

test("diffOps: a #<id> token in an unrelated task's subject is foreign, never touched", () => {
  const current: CurrentTask[] = [{ taskId: "9", subject: "Fix GitHub #83 in another repo", status: "pending" }];
  const { ops, foreign } = diffOps(current, []);
  expect(ops).toEqual([]);
  expect(foreign).toBe(1);
});

test("scanDispatches reads _dispatch<N>/STATE.md fixtures (dispatch_prepare.sh's own scaffold shape)", () => {
  const pmRoot = mkdtempSync(join(tmpdir(), "task-mirror-dispatch-"));
  try {
    mkdirSync(join(pmRoot, "_dispatch7"));
    writeFileSync(
      join(pmRoot, "_dispatch7", "STATE.md"),
      "# Dispatch #7 - worker gate-agent-naming\n\n## Status\n\nWORKING\n\n## Current task\n\n#7 gate-agent-naming (garelier/main/pm/workbench/#7/gate-agent-naming)\n",
    );
    mkdirSync(join(pmRoot, "_dispatch11"));
    writeFileSync(
      join(pmRoot, "_dispatch11", "STATE.md"),
      "# Dispatch #11 - smith anvil-fix\n\n## Status\n\nREPORTING\n\n## Current task\n\n#11 anvil-fix (garelier/main/pm/anvil/#11/anvil-fix)\n",
    );
    // a container without STATE.md (mid-creation race) must be skipped, not crash.
    mkdirSync(join(pmRoot, "_dispatch99"));
    // a non-dispatch dir must be ignored.
    mkdirSync(join(pmRoot, "_workers"));

    const found = scanDispatches(pmRoot).sort((a, b) => a.id - b.id);
    expect(found).toEqual([
      { id: 7, role: "worker", slug: "gate-agent-naming", state: "WORKING" },
      { id: 11, role: "smith", slug: "anvil-fix", state: "REPORTING" },
    ]);
  } finally {
    rmSync(pmRoot, { recursive: true, force: true });
  }
});
