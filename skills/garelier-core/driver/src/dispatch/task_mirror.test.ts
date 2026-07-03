// task_mirror.ts — pins the W-027 hardening: cross-repo foreign-task protection
// and the completed-but-in-flight contradiction warning, plus a regression pin
// for the pre-existing create/update/complete behavior so neither fix silently
// widens or narrows the mirror's normal diff.
import { test, expect } from "bun:test";
import { diffOps, type CurrentTask, type DesiredTask } from "./task_mirror.ts";

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
