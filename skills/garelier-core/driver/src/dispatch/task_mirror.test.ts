import { rmSync } from "../guard/path_guard.ts";
// task_mirror.ts — pins the W-027 hardening: cross-repo foreign-task protection
// and the completed-but-in-flight contradiction warning, plus a regression pin
// for the pre-existing create/update/complete behavior so neither fix silently
// widens or narrows the mirror's normal diff.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffOps,
  agentNameForSlug,
  buildDispatchDesired,
  buildDesired,
  parseBacklog,
  statusHead,
  boundToActiveBand,
  readCurrentActiveIds,
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

test("agentNameForSlug matches dispatch_prepare.ts's AGENT_NAME (ga-<role>-<slug>, sanitized, truncated)", () => {
  expect(agentNameForSlug("do-x", "worker")).toBe("ga-worker-do-x");
  // a slug carrying a char outside [A-Za-z0-9_-] sanitizes to '-', same as the
  // bash `tr -c 'A-Za-z0-9_-' '-'` in dispatch_prepare.ts.
  expect(agentNameForSlug("odd/slug", "worker")).toBe("ga-worker-odd-slug");
  expect(agentNameForSlug("x".repeat(80), "worker").length).toBe(64);
  // role varies with the resolved --role, not a fixed "produce" placeholder.
  expect(agentNameForSlug("harden-x", "smith")).toBe("ga-smith-harden-x");
});

test("buildDispatchDesired: WORKING -> in_progress, owner=agent_name, worker-doing activeForm", () => {
  const d: DispatchInfo = { id: 83, role: "worker", slug: "gate-agent-naming", state: "WORKING" };
  const [t] = buildDispatchDesired([d]);
  expect(t.key).toBe("#83");
  expect(t.subject).toBe("#83: gate-agent-naming [dispatch:working]");
  expect(t.status).toBe("in_progress");
  expect(t.activeForm).toBe("gate-agent-naming を worker が実装中");
  expect(t.description).toContain("Owner: ga-worker-gate-agent-naming");
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

test("scanDispatches reads _dispatch<N>/STATE.md fixtures (dispatch_prepare.ts's own scaffold shape)", () => {
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

test("scanDispatches reads dispatch<N> from crew layout", () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-task-mirror-"));
  const pmRoot = join(project, "__garelier", "pm1");
  try {
    const dispatch = join(pmRoot, "_crew", "dispatch7");
    mkdirSync(dispatch, { recursive: true });
    writeFileSync(join(dispatch, "STATE.md"), "# Dispatch #7 - worker crew-task\n\n## Status\n\nWORKING\n");
    expect(scanDispatches(pmRoot)).toEqual([{ id: 7, role: "worker", slug: "crew-task", state: "WORKING" }]);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// W-086 P2 regression: a pre-migration (flat _dispatch<N>) install whose pmRoot
// still sits under __garelier must keep resolving. Deriving the prefix from a
// string compare of dispatchRoot to pmRoot silently broke this on Windows,
// where crewSubdir emits forward-slash paths that never string-equal a
// join()-built pmRoot (mirror of contract_check.ts dispatchLayout).
test("scanDispatches reads flat _dispatch<N> under an __garelier pmRoot (pre-crew install)", () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-task-mirror-"));
  const pmRoot = join(project, "__garelier", "pm1");
  try {
    const dispatch = join(pmRoot, "_dispatch7");
    mkdirSync(dispatch, { recursive: true });
    writeFileSync(join(dispatch, "STATE.md"), "# Dispatch #7 - worker flat-task\n\n## Status\n\nWORKING\n");
    expect(scanDispatches(pmRoot)).toEqual([{ id: 7, role: "worker", slug: "flat-task", state: "WORKING" }]);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ── W-141: active-band scope + subject shortening + cap ───────────────────────
// DEC-092's default mirrored EVERY open backlog row (276 measured on the target project =
// 276 TaskCreate = session破壊) and embedded the full status prose in each subject.
// Default is now the ACTIVE BAND (in-flight + current.md ids), capped, short subject.

function writeBacklogFixture(pmRoot: string, rows: Array<{ id: string; status: string; desc?: string }>): void {
  mkdirSync(join(pmRoot, "control", "project_dashboard"), { recursive: true });
  const header = "| ID | Type | Priority | Status | Owner | Milestone | Outcome | Acceptance | Detail |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n";
  const body = rows.map((r) => `| ${r.id} | bug | normal | ${r.status} | - | m | ${r.desc ?? "some outcome desc"} | acc | |`).join("\n");
  writeFileSync(join(pmRoot, "control", "project_dashboard", "backlog.md"), `# Backlog\n\n${header}${body}\n`);
}

test("W-141 (b): statusHead takes the leading token, dropping embedded prose/markdown", () => {
  expect(statusHead("ready")).toBe("ready");
  expect(statusHead("ready (2026-07-18 実測 3 回 — spawn 直後 read phase)")).toBe("ready");
  expect(statusHead("**HOLD (user 指示 2026-07-17「止めて」)** (元指示)")).toBe("HOLD");
  expect(statusHead("needs-blueprint")).toBe("needs-blueprint");
  expect(statusHead("ready·tdd")).toBe("ready·tdd");
  expect(statusHead("")).toBe("?");
});

test("W-141 (b): buildDesired subject carries the SHORT status head, not the full prose", () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-tm-w141-"));
  const pmRoot = join(project, "__garelier", "pm1");
  try {
    writeBacklogFixture(pmRoot, [{ id: "W-050", status: "ready (2026-07-18 実測 3 回 — 長文長文長文長文長文長文長文長文長文)" }]);
    const desiredList = buildDesired(parseBacklog(join(pmRoot, "control", "project_dashboard", "backlog.md")), new Map());
    expect(desiredList).toHaveLength(1);
    expect(desiredList[0].subject).toContain("[ready]");
    expect(desiredList[0].subject).not.toContain("実測");        // prose is NOT in the subject
    expect(desiredList[0].subject.length).toBeLessThan(80);      // bounded
    expect(desiredList[0].description).toContain("ready (2026"); // full status still in description
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("W-141 (a)(c): a 276-row backlog yields a bounded default desired; --scope all keeps all", () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-tm-w141-"));
  const pmRoot = join(project, "__garelier", "pm1");
  try {
    const rows = Array.from({ length: 276 }, (_, i) => ({ id: `W-${String(i + 1).padStart(3, "0")}`, status: "ready" }));
    writeBacklogFixture(pmRoot, rows);
    // current.md names 3 active ids -> the default active band is just those 3.
    writeFileSync(join(pmRoot, "control", "project_dashboard", "current.md"), "# Current\n\n実行 queue: W-003, W-007 then W-011\n");
    const full = buildDesired(parseBacklog(join(pmRoot, "control", "project_dashboard", "backlog.md")), new Map());
    expect(full).toHaveLength(276); // --scope all is the full mirror
    const activeIds = readCurrentActiveIds(pmRoot);
    expect([...activeIds].sort()).toEqual(["W-003", "W-007", "W-011"]);
    const bound = boundToActiveBand(full, activeIds, 40);
    expect(bound.kept.map((d) => d.key).sort()).toEqual(["W-003", "W-007", "W-011"]);
    expect(bound.kept.length).toBeLessThanOrEqual(40);
    expect(bound.truncated).toBe(0);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("W-141 (c): boundToActiveBand caps at --max, counts the overflow, in-flight always kept first", () => {
  // 50 in-flight tasks + cap 40 -> 40 kept, 10 truncated; in-flight come first.
  const many = Array.from({ length: 50 }, (_, i) =>
    desired({ key: `W-${100 + i}`, status: "in_progress", dispatch: { state: "WORKING", num: i } }));
  const queuedOutOfBand = desired({ key: "W-999" }); // pending + not named -> not in band
  const bound = boundToActiveBand([...many, queuedOutOfBand], new Set(), 40);
  expect(bound.kept).toHaveLength(40);
  expect(bound.truncated).toBe(10);
  expect(bound.kept.every((d) => d.status === "in_progress")).toBe(true); // in-flight prioritized
  expect(bound.kept.find((d) => d.key === "W-999")).toBeUndefined();      // out-of-band dropped
});

test("W-141 (a): narrowing the default scope must NOT complete an out-of-band current task", () => {
  // The current Task list carries a mirror-owned W-200 that is OUT of the active
  // band (not in the narrowed desired) but STILL in the backlog (knownKeys). It must
  // be neither updated (absent from desired) nor completed (present in knownKeys).
  const current: CurrentTask[] = [
    { taskId: "1", subject: "W-200: still a real backlog row [ready]", status: "pending" },
  ];
  const narrowedDesired = [desired({ key: "W-003", status: "in_progress", dispatch: { state: "WORKING", num: 1 } })];
  const knownKeys = new Set(["W-003", "W-200"]); // full backlog still has W-200
  const { ops } = diffOps(current, narrowedDesired, knownKeys);
  expect(ops.find((o) => o.op === "complete")).toBeUndefined();   // NOT completed (still in backlog)
  expect(ops.find((o) => "taskId" in o && o.taskId === "1")).toBeUndefined(); // not touched
  // and a genuinely-removed key (absent from knownKeys) IS still completed.
  const gone: CurrentTask[] = [{ taskId: "2", subject: "W-201: merged away [ready]", status: "pending" }];
  const { ops: ops2 } = diffOps(gone, narrowedDesired, knownKeys);
  expect(ops2).toContainEqual({ op: "complete", taskId: "2", subject: "W-201: merged away [ready]" });
});
