import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Logger } from "./log.ts";
import {
  mergeGatePaths,
  pollMergeGate,
  writeMergeRequest,
  reconcileGateAcks,
  pruneMergeGateResults,
  readResultsKeepConfig,
  pruneMergeGateArchive,
  readArchiveKeepDaysConfig,
  pruneMergeGateLogs,
  readLogsKeepConfig,
  capMergeGateLogSizes,
  readLogMaxBytesConfig,
} from "./merge_gate.ts";

const PM = "tpm";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function project(body: string) {
  const root = mkdtempSync(join(tmpdir(), "symph-mg-"));
  dirs.push(root);
  const pmDir = join(root, "__garelier", PM, "_pm");
  mkdirSync(pmDir, { recursive: true });
  writeFileSync(join(pmDir, "setup_config.toml"), `
[project]
name = "Test"

[branches]
target = "main"
integration = "garelier/main/tpm/studio"

${body}
`, "utf8");
  return { root, config: loadConfig(root, PM) };
}

describe("writeMergeRequest", () => {
  test("uses full gate commands while preserving fast/full request metadata", () => {
    const { root, config } = project(`
[quality_gate]
commands = ["legacy"]

[quality_gate.fast]
commands = ["quick"]
timeout_minutes_per_cmd = 5

[quality_gate.full]
commands = ["full-a", "full-b"]
timeout_minutes_per_cmd = 30
`);
    const id = writeMergeRequest(root, config, {
      workbenchBranch: "garelier/main/tpm/workbench/#1/task",
      workerId: "worker-01",
      taskId: "#1",
      mergeMessage: "merge task",
    });
    const p = mergeGatePaths(root, PM);
    const req = JSON.parse(readFileSync(join(p.requestsDir, `${id}.json`), "utf8"));
    expect(req.quality_gate_mode).toBe("full");
    expect(req.quality_gate_commands).toEqual(["full-a", "full-b"]);
    expect(req.quality_gate_timeout_minutes_per_cmd).toBe(30);
    expect(req.quality_gate_fast_commands).toEqual(["quick"]);
    expect(req.quality_gate_fast_timeout_minutes_per_cmd).toBe(5);
  });

  test("prunes an orphan summary sidecar and dispatches the newer real request (head-of-line guard)", async () => {
    const { root, config } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    mkdirSync(p.requestsDir, { recursive: true });
    mkdirSync(p.resultsDir, { recursive: true });
    mkdirSync(p.archiveDir, { recursive: true });

    // Orphan sidecar: its parent request (019-task.request.json) was already
    // archived (absent from requests/), but the result-summary companion lives
    // in results/ — the name collision that previously fooled resultExists()
    // into a forever re-dispatch loop.
    writeFileSync(join(p.requestsDir, "019-task.request.summary.json"), JSON.stringify({ request_id: "019-task" }));
    writeFileSync(join(p.resultsDir, "019-task.request.summary.json"), JSON.stringify({ schema_version: 1, request_id: "019-task", status: "failed" }));

    // Newer real request, not yet resolved — must be the one dispatched.
    writeFileSync(join(p.requestsDir, "020-task.request.json"), JSON.stringify({ request_id: "020-task" }));

    const dummyScript = join(root, "dummy-merge-gate.sh");
    writeFileSync(dummyScript, "#!/usr/bin/env bash\n");
    const dispatched: string[] = [];
    const log = new Logger("test", join(root, "driver.jsonl"));
    const result = await pollMergeGate(root, config, log, {
      scriptOverride: dummyScript,
      spawnFn: (_script, args) => { dispatched.push(args[0]!); return 4242; },
    });

    expect(result.spawnedRequestId).toBe("020-task.request");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain("020-task.request.json");
    // Orphan sidecar moved out of requests/ → archive/ so it can't loop.
    expect(existsSync(join(p.requestsDir, "019-task.request.summary.json"))).toBe(false);
    expect(existsSync(join(p.archiveDir, "019-task.request.summary.json"))).toBe(true);
  });

  test("archives an already-resolved request and dispatches the next unresolved one", async () => {
    const { root, config } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    mkdirSync(p.requestsDir, { recursive: true });
    mkdirSync(p.resultsDir, { recursive: true });
    mkdirSync(p.archiveDir, { recursive: true });

    // Resolved request left behind (result present, request not archived).
    writeFileSync(join(p.requestsDir, "010-task.request.json"), JSON.stringify({ request_id: "010-task" }));
    writeFileSync(join(p.resultsDir, "010-task.request.json"), JSON.stringify({ request_id: "010-task", status: "success" }));
    // Newer unresolved request.
    writeFileSync(join(p.requestsDir, "011-task.request.json"), JSON.stringify({ request_id: "011-task" }));

    const dummyScript = join(root, "dummy-merge-gate.sh");
    writeFileSync(dummyScript, "#!/usr/bin/env bash\n");
    const dispatched: string[] = [];
    const log = new Logger("test", join(root, "driver.jsonl"));
    const result = await pollMergeGate(root, config, log, {
      scriptOverride: dummyScript,
      spawnFn: (_script, args) => { dispatched.push(args[0]!); return 7777; },
    });

    expect(result.spawnedRequestId).toBe("011-task.request");
    expect(dispatched[0]).toContain("011-task.request.json");
    expect(existsSync(join(p.requestsDir, "010-task.request.json"))).toBe(false);
    expect(existsSync(join(p.archiveDir, "010-task.request.json"))).toBe(true);
  });

  test("does NOT spawn while an active.lock references a LIVE pid — the single-active guard W-039's self-drain relies on to never double-run a gate", async () => {
    // W-039: merge-gate.sh self-invokes `dock_merge.ts poll` on completion so a
    // queued request drains without waiting for a manual poll. That is only
    // safe because poll refuses to spawn while a gate is genuinely running. Prove
    // the guard with a lock owned by a real, live OS pid (this test process):
    // even with a request queued, poll must spawn nothing and leave the lock.
    const { root, config } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    mkdirSync(p.requestsDir, { recursive: true });
    mkdirSync(p.locksDir, { recursive: true });
    mkdirSync(p.resultsDir, { recursive: true });
    writeFileSync(join(p.requestsDir, "031-task.json"), JSON.stringify({ request_id: "031-task" }));
    writeFileSync(p.activeLock, JSON.stringify({
      pid: process.pid, request_id: "030-active", request_file: "030-active.json",
      started_at: new Date().toISOString(),
    }));
    const dispatched: string[] = [];
    const log = new Logger("test", join(root, "driver.jsonl"));
    const result = await pollMergeGate(root, config, log, {
      spawnFn: (_s, args) => { dispatched.push(args[0]!); return 111; },
    });
    expect(result.spawnedRequestId).toBeUndefined();
    expect(dispatched).toHaveLength(0);
    expect(existsSync(p.activeLock)).toBe(true); // running gate's lock untouched
  });

  function gateProject() {
    const { root, config } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    mkdirSync(p.requestsDir, { recursive: true });
    mkdirSync(p.resultsDir, { recursive: true });
    mkdirSync(p.archiveDir, { recursive: true });
    mkdirSync(p.ackedDir, { recursive: true });
    const gDir = join(root, "__garelier", PM, "_guardians", "guardian-01");
    const oDir = join(root, "__garelier", PM, "_observers", "observer-01");
    mkdirSync(gDir, { recursive: true });
    mkdirSync(oDir, { recursive: true });
    const writeState = (dir: string, status: string) =>
      writeFileSync(join(dir, "STATE.md"), `# State\n\n## Status\n${status}\n\n## Current task\nx\n`);
    const request = (extra: Record<string, unknown>) => ({
      request_id: "021-task",
      workbench_tip: "deadbeefcafe",
      task_id: "#21",
      guardian_report_path: `__garelier/${PM}/_guardians/guardian-01/archive/GATE-#21/guardian_report.md`,
      guardian_verdict: "PASS",
      observer_report_path: `__garelier/${PM}/_observers/observer-01/observation_report.md`,
      observer_verdict: "PASS_WITH_NOTES",
      ...extra,
    });
    return { root, config, p, gDir, oDir, writeState, request };
  }

  test("auto-acks a REPORTING gate producer once its merge succeeds (releases the stall)", () => {
    const { root, config, p, gDir, oDir, writeState, request } = gateProject();
    writeState(gDir, "REPORTING");
    writeState(oDir, "IDLE"); // observer already released — must NOT be re-acked
    // Archived request (parent already processed) + a success result.
    writeFileSync(join(p.archiveDir, "021-task.request.request.json"), JSON.stringify(request({})));
    writeFileSync(join(p.resultsDir, "021-task.request.json"), JSON.stringify({ status: "success", studio_commit: "abc123" }));

    const log = new Logger("test", join(root, "driver.jsonl"));
    const acked = reconcileGateAcks(root, PM, mergeGatePaths(root, PM), log);

    expect(acked).toContain("guardian:guardian-01");
    expect(acked).not.toContain("observer:observer-01");
    expect(existsSync(join(gDir, "acked.md"))).toBe(true);
    expect(existsSync(join(oDir, "acked.md"))).toBe(false);
    expect(readFileSync(join(gDir, "acked.md"), "utf8")).toContain("review_sha: deadbeefcafe");
  });

  test("does not ack when the merge has not succeeded, and is idempotent", () => {
    const { root, config, p, gDir, writeState, request } = gateProject();
    writeState(gDir, "REPORTING");
    writeFileSync(join(p.archiveDir, "021-task.request.request.json"), JSON.stringify(request({})));
    // failed result → no ack
    writeFileSync(join(p.resultsDir, "021-task.request.json"), JSON.stringify({ status: "failed" }));
    const log = new Logger("test", join(root, "driver.jsonl"));
    expect(reconcileGateAcks(root, PM, mergeGatePaths(root, PM), log)).toHaveLength(0);
    expect(existsSync(join(gDir, "acked.md"))).toBe(false);

    // Flip to success → ack once.
    writeFileSync(join(p.resultsDir, "021-task.request.json"), JSON.stringify({ status: "success" }));
    expect(reconcileGateAcks(root, PM, mergeGatePaths(root, PM), log)).toEqual(["guardian:guardian-01"]);
    // Second pass: acked.md already present → no duplicate.
    expect(reconcileGateAcks(root, PM, mergeGatePaths(root, PM), log)).toHaveLength(0);
  });

  test("removes a stale acked.md left on an already-released (non-REPORTING) producer", () => {
    const { root, p, gDir, writeState, request } = gateProject();
    writeState(gDir, "IDLE");
    writeFileSync(join(gDir, "acked.md"), "# stale leftover from a prior gate\n");
    writeFileSync(join(p.archiveDir, "021-task.request.request.json"), JSON.stringify(request({})));
    writeFileSync(join(p.resultsDir, "021-task.request.json"), JSON.stringify({ status: "success" }));

    const log = new Logger("test", join(root, "driver.jsonl"));
    reconcileGateAcks(root, PM, mergeGatePaths(root, PM), log);
    expect(existsSync(join(gDir, "acked.md"))).toBe(false);
  });

  test("acks at most once per merge even if the producer deletes acked.md mid-release (race guard)", () => {
    const { root, p, gDir, writeState, request } = gateProject();
    writeState(gDir, "REPORTING");
    writeFileSync(join(p.archiveDir, "021-task.request.request.json"), JSON.stringify(request({})));
    writeFileSync(join(p.resultsDir, "021-task.request.json"), JSON.stringify({ status: "success" }));
    const log = new Logger("test", join(root, "driver.jsonl"));

    expect(reconcileGateAcks(root, PM, mergeGatePaths(root, PM), log)).toEqual(["guardian:guardian-01"]);
    // Simulate the producer consuming the ack but not yet flipping STATE to IDLE.
    rmSync(join(gDir, "acked.md"));
    // Re-poll in that window: the sentinel must prevent re-stranding acked.md.
    expect(reconcileGateAcks(root, PM, mergeGatePaths(root, PM), log)).toHaveLength(0);
    expect(existsSync(join(gDir, "acked.md"))).toBe(false);
  });

  // W-073: in dispatch-only mode (DEC-066 deleted the headless driver that used
  // to WAKE a gate producer on acked.md) nothing runs the Observer/Guardian §6/§10
  // archive, so a PASSING producer strands in REPORTING forever. The poll must
  // finalize it mechanically — SYMMETRICALLY for both roles — so it reaches IDLE
  // and branch_gc can reclaim its ephemeral branch.
  test("finalizes a stranded REPORTING gate producer (Guardian + Observer symmetric): archive handoff + STATE->IDLE (W-073)", () => {
    const { root, p, gDir, oDir, writeState, request } = gateProject();
    writeState(gDir, "REPORTING");
    writeState(oDir, "REPORTING");
    const seed = (dir: string, reportFile: string) => {
      writeFileSync(join(dir, "assignment.md"), "# assignment\n");
      writeFileSync(join(dir, reportFile), "# verdict PASS\n");
    };
    seed(gDir, "guardian_report.md");
    seed(oDir, "report.md"); // observer writes report.md (role_contracts ROLE_REPORT_ARTIFACT)
    writeFileSync(join(p.archiveDir, "021-task.request.request.json"), JSON.stringify(request({})));
    writeFileSync(join(p.resultsDir, "021-task.request.json"), JSON.stringify({ status: "success" }));
    const log = new Logger("test", join(root, "driver.jsonl"));
    const mgp = mergeGatePaths(root, PM);

    // Pass 1 = ack only. An attended agent gets this cycle to run its own archive;
    // the producer stays REPORTING (acked.md recorded, not yet finalized).
    const first = reconcileGateAcks(root, PM, mgp, log);
    expect(first.sort()).toEqual(["guardian:guardian-01", "observer:observer-01"]);
    expect(existsSync(join(gDir, "acked.md"))).toBe(true);
    expect(existsSync(join(oDir, "acked.md"))).toBe(true);
    expect(readFileSync(join(gDir, "STATE.md"), "utf8")).toContain("REPORTING");
    expect(readFileSync(join(oDir, "STATE.md"), "utf8")).toContain("REPORTING");

    // Pass 2 = acked.md is STILL sitting in each container (no live agent consumed
    // it → dispatch-only). The poll mechanically finalizes BOTH: archive handoff +
    // flip STATE to IDLE, releasing the stall.
    reconcileGateAcks(root, PM, mgp, log);
    for (const [dir, reportFile] of [[gDir, "guardian_report.md"], [oDir, "report.md"]] as const) {
      const state = readFileSync(join(dir, "STATE.md"), "utf8");
      expect(state).toMatch(/##\s*Status\s*\r?\n\s*IDLE/);
      expect(state).not.toContain("REPORTING");
      expect(existsSync(join(dir, "archive", "021-task", "assignment.md"))).toBe(true);
      expect(existsSync(join(dir, "archive", "021-task", reportFile))).toBe(true);
      expect(existsSync(join(dir, "assignment.md"))).toBe(false); // moved out of root
    }
  });

  // W-073: an attended agent that consumes acked.md itself (deletes it, mid-archive)
  // must NOT be raced — if acked.md is gone while still REPORTING, the poll leaves
  // the live agent to finish its own §6/§10 archive.
  test("does not finalize when a live agent already consumed acked.md (attended mode, W-073)", () => {
    const { root, p, gDir, writeState, request } = gateProject();
    writeState(gDir, "REPORTING");
    writeFileSync(join(gDir, "assignment.md"), "# assignment\n");
    writeFileSync(join(p.archiveDir, "021-task.request.request.json"), JSON.stringify(request({})));
    writeFileSync(join(p.resultsDir, "021-task.request.json"), JSON.stringify({ status: "success" }));
    const log = new Logger("test", join(root, "driver.jsonl"));
    const mgp = mergeGatePaths(root, PM);

    reconcileGateAcks(root, PM, mgp, log);           // pass 1: ack
    rmSync(join(gDir, "acked.md"));                   // live agent consumes it
    reconcileGateAcks(root, PM, mgp, log);            // pass 2: acked.md gone → hands off
    // The poll neither re-strands acked.md nor pre-empts the agent's archive.
    expect(existsSync(join(gDir, "acked.md"))).toBe(false);
    expect(existsSync(join(gDir, "archive", "021-task", "assignment.md"))).toBe(false);
  });

  test("subprocess crash recovery writes compact summary sidecar", async () => {
    const { root, config } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    mkdirSync(p.locksDir, { recursive: true });
    writeFileSync(p.activeLock, JSON.stringify({
      pid: 999999,
      request_id: "001-task",
      request_file: "001-task.json",
      started_at: "2026-06-02T00:00:00.000Z",
    }));
    const log = new Logger("test", join(root, "driver.jsonl"));
    const result = await pollMergeGate(root, config, log);
    expect(result.recoveredAbortedRequestId).toBe("001-task");
    const summary = JSON.parse(readFileSync(join(p.resultsDir, "001-task.summary.json"), "utf8"));
    expect(summary.schema_version).toBe(1);
    expect(summary.status).toBe("aborted");
    expect(summary.quality_gate_mode).toBe("full");
    expect(summary.gate_steps).toEqual([]);
    expect(summary.failure_reason).toContain("subprocess pid 999999 died");
  });
});

// W-030 residual: results/ retention (write-time pruning, not read-time).
describe("pruneMergeGateResults", () => {
  function seedResults(p: ReturnType<typeof mergeGatePaths>, stems: string[]) {
    mkdirSync(p.resultsDir, { recursive: true });
    for (const stem of stems) {
      writeFileSync(join(p.resultsDir, `${stem}.json`), JSON.stringify({ request_id: stem, status: "success" }));
      writeFileSync(join(p.resultsDir, `${stem}.summary.json`), JSON.stringify({ request_id: stem }));
    }
  }
  const seq = (n: number) => `${String(n).padStart(3, "0")}-task`;

  test("no-op when total is at or under the keep window", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const stems = [1, 2, 3].map(seq);
    seedResults(p, stems);

    const outcome = pruneMergeGateResults(p, 3);
    expect(outcome.prunedStems).toEqual([]);
    expect(outcome.totalBefore).toBe(3);
    for (const stem of stems) {
      expect(existsSync(join(p.resultsDir, `${stem}.json`))).toBe(true);
      expect(existsSync(join(p.resultsDir, `${stem}.summary.json`))).toBe(true);
    }
  });

  test("keeps only the most recent K stems and deletes the .json+.summary.json pair for the rest", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const stems = [1, 2, 3, 4, 5].map(seq);
    seedResults(p, stems);

    const outcome = pruneMergeGateResults(p, 2);
    expect(outcome.totalBefore).toBe(5);
    expect(outcome.prunedStems).toEqual([seq(1), seq(2), seq(3)]);
    for (const stem of [seq(1), seq(2), seq(3)]) {
      expect(existsSync(join(p.resultsDir, `${stem}.json`))).toBe(false);
      expect(existsSync(join(p.resultsDir, `${stem}.summary.json`))).toBe(false);
    }
    for (const stem of [seq(4), seq(5)]) {
      expect(existsSync(join(p.resultsDir, `${stem}.json`))).toBe(true);
      expect(existsSync(join(p.resultsDir, `${stem}.summary.json`))).toBe(true);
    }
  });

  test("protects a stem still queued in requests/ even if it falls outside the keep window", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const stems = [1, 2, 3, 4].map(seq);
    seedResults(p, stems);
    // 001-task's request never got archived (defensive edge case) — must survive.
    mkdirSync(p.requestsDir, { recursive: true });
    writeFileSync(join(p.requestsDir, `${seq(1)}.json`), JSON.stringify({ request_id: seq(1) }));

    const outcome = pruneMergeGateResults(p, 1);
    expect(outcome.prunedStems).not.toContain(seq(1));
    expect(existsSync(join(p.resultsDir, `${seq(1)}.json`))).toBe(true);
    expect(existsSync(join(p.resultsDir, `${seq(1)}.summary.json`))).toBe(true);
    // The unprotected older-than-keep stems are still pruned.
    expect(outcome.prunedStems).toEqual(expect.arrayContaining([seq(2), seq(3)]));
  });

  test("protects the stem the active lock currently references", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const stems = [1, 2, 3].map(seq);
    seedResults(p, stems);
    mkdirSync(p.locksDir, { recursive: true });
    writeFileSync(p.activeLock, JSON.stringify({
      pid: process.pid,
      request_id: seq(1),
      request_file: `${seq(1)}.json`,
      started_at: new Date().toISOString(),
    }));

    const outcome = pruneMergeGateResults(p, 1);
    expect(outcome.prunedStems).not.toContain(seq(1));
    expect(existsSync(join(p.resultsDir, `${seq(1)}.json`))).toBe(true);
  });

  test("readResultsKeepConfig reads [merge_gate].results_keep and defaults to 40 when absent", () => {
    const { root: withKey } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n\n[merge_gate]\nresults_keep = 7\n`);
    expect(readResultsKeepConfig(withKey, PM)).toBe(7);

    const { root: withoutKey } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    expect(readResultsKeepConfig(withoutKey, PM)).toBe(40);
  });
});

describe("pruneMergeGateLogs (W-030 fix)", () => {
  const seq = (n: number) => `${String(n).padStart(3, "0")}-task`;
  function seedLogs(p: ReturnType<typeof mergeGatePaths>, stems: string[]) {
    mkdirSync(p.logsDir, { recursive: true });
    for (const stem of stems) writeFileSync(join(p.logsDir, `${stem}.log`), `log for ${stem}\n`);
  }

  test("no-op when total is at or under the keep window", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const stems = [1, 2, 3].map(seq);
    seedLogs(p, stems);

    const outcome = pruneMergeGateLogs(p, 3);
    expect(outcome.prunedStems).toEqual([]);
    expect(outcome.totalBefore).toBe(3);
    for (const stem of stems) expect(existsSync(join(p.logsDir, `${stem}.log`))).toBe(true);
  });

  test("keeps only the most recent K logs and deletes the rest", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    seedLogs(p, [1, 2, 3, 4, 5].map(seq));

    const outcome = pruneMergeGateLogs(p, 2);
    expect(outcome.totalBefore).toBe(5);
    expect(outcome.prunedStems).toEqual([seq(1), seq(2), seq(3)]);
    for (const stem of [seq(1), seq(2), seq(3)]) expect(existsSync(join(p.logsDir, `${stem}.log`))).toBe(false);
    for (const stem of [seq(4), seq(5)]) expect(existsSync(join(p.logsDir, `${stem}.log`))).toBe(true);
  });

  test("protects the in-flight log still queued in requests/ and the active-lock log", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    seedLogs(p, [1, 2, 3, 4].map(seq));
    // 001 is still queued (its log is being written); 002 is the active gate.
    mkdirSync(p.requestsDir, { recursive: true });
    writeFileSync(join(p.requestsDir, `${seq(1)}.json`), JSON.stringify({ request_id: seq(1) }));
    mkdirSync(p.locksDir, { recursive: true });
    writeFileSync(p.activeLock, JSON.stringify({
      pid: process.pid,
      request_id: seq(2),
      request_file: `${seq(2)}.json`,
      started_at: new Date().toISOString(),
    }));

    const outcome = pruneMergeGateLogs(p, 1);
    expect(outcome.prunedStems).not.toContain(seq(1));
    expect(outcome.prunedStems).not.toContain(seq(2));
    expect(existsSync(join(p.logsDir, `${seq(1)}.log`))).toBe(true);
    expect(existsSync(join(p.logsDir, `${seq(2)}.log`))).toBe(true);
    // an unprotected older-than-keep log is still pruned
    expect(outcome.prunedStems).toContain(seq(3));
  });

  test("no-op when logs/ is absent", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    expect(pruneMergeGateLogs(p, 5).prunedStems).toEqual([]);
  });

  test("readLogsKeepConfig reads [merge_gate].logs_keep, else falls back to results_keep", () => {
    const own = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n\n[merge_gate]\nlogs_keep = 5\n`);
    expect(readLogsKeepConfig(own.root, PM)).toBe(5);

    // logs_keep unset -> mirrors results_keep (here set to 7)
    const inherit = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n\n[merge_gate]\nresults_keep = 7\n`);
    expect(readLogsKeepConfig(inherit.root, PM)).toBe(7);

    // neither set -> the shared default (40)
    const dflt = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    expect(readLogsKeepConfig(dflt.root, PM)).toBe(40);
  });
});

describe("capMergeGateLogSizes (W-030 residual — byte axis)", () => {
  const seq = (n: number) => `${String(n).padStart(3, "0")}-task`;

  // A log with a unique HEAD line, a deep-middle sentinel, and a unique TAIL line.
  function bigLog(): string {
    const lines: string[] = ["HEAD-START request header"];
    for (let i = 0; i < 2000; i++) {
      lines.push(i === 1000 ? "DEEP-MIDDLE-SENTINEL should be dropped" : `filler line ${i} padding padding padding`);
    }
    lines.push("TAIL-END final verdict");
    return lines.join("\n") + "\n";
  }

  function seedLog(p: ReturnType<typeof mergeGatePaths>, stem: string, content: string) {
    mkdirSync(p.logsDir, { recursive: true });
    writeFileSync(join(p.logsDir, `${stem}.log`), content, "utf8");
  }

  test("caps an oversized log to head + tail, dropping the middle behind a marker", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const content = bigLog();
    seedLog(p, seq(1), content);
    const before = Buffer.byteLength(content, "utf8");

    const outcome = capMergeGateLogSizes(p, 4096);
    expect(outcome.cappedStems).toEqual([seq(1)]);

    const after = readFileSync(join(p.logsDir, `${seq(1)}.log`), "utf8");
    expect(Buffer.byteLength(after, "utf8")).toBeLessThan(before);
    // head + tail preserved, deep middle dropped, marker inserted.
    expect(after).toContain("HEAD-START request header");
    expect(after).toContain("TAIL-END final verdict");
    expect(after).not.toContain("DEEP-MIDDLE-SENTINEL");
    expect(after).toContain("merge_gate log capped");
    // whole lines only (no split line at the head cut: it ends on a newline before the marker).
    expect(after.split("\n")[0]).toBe("HEAD-START request header");
  });

  test("leaves a log at or under the cap byte-identical", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const content = "short gate log\nstep 1 ok\nstep 2 ok\n";
    seedLog(p, seq(2), content);

    const outcome = capMergeGateLogSizes(p, 4096);
    expect(outcome.cappedStems).toEqual([]);
    expect(readFileSync(join(p.logsDir, `${seq(2)}.log`), "utf8")).toBe(content);
  });

  test("never rewrites the in-flight (queued) or active-lock log, even when oversized", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const content = bigLog();
    seedLog(p, seq(1), content); // still queued -> its log is being written
    seedLog(p, seq(2), content); // the active gate
    seedLog(p, seq(3), content); // an ordinary completed log -> may be capped
    mkdirSync(p.requestsDir, { recursive: true });
    writeFileSync(join(p.requestsDir, `${seq(1)}.json`), JSON.stringify({ request_id: seq(1) }));
    mkdirSync(p.locksDir, { recursive: true });
    writeFileSync(p.activeLock, JSON.stringify({
      pid: process.pid,
      request_id: seq(2),
      request_file: `${seq(2)}.json`,
      started_at: new Date().toISOString(),
    }));

    const outcome = capMergeGateLogSizes(p, 4096);
    expect(outcome.cappedStems).not.toContain(seq(1));
    expect(outcome.cappedStems).not.toContain(seq(2));
    expect(outcome.cappedStems).toContain(seq(3));
    expect(readFileSync(join(p.logsDir, `${seq(1)}.log`), "utf8")).toBe(content);
    expect(readFileSync(join(p.logsDir, `${seq(2)}.log`), "utf8")).toBe(content);
  });

  test("disabled (maxBytes <= 0) is a no-op even on a huge log", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const content = bigLog();
    seedLog(p, seq(1), content);

    expect(capMergeGateLogSizes(p, 0).cappedStems).toEqual([]);
    expect(readFileSync(join(p.logsDir, `${seq(1)}.log`), "utf8")).toBe(content);
  });

  test("no-op when logs/ is absent", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    expect(capMergeGateLogSizes(p, 4096).cappedStems).toEqual([]);
  });

  test("readLogMaxBytesConfig reads [merge_gate].log_max_bytes, else defaults to 8 MiB", () => {
    const own = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n\n[merge_gate]\nlog_max_bytes = 12345\n`);
    expect(readLogMaxBytesConfig(own.root, PM)).toBe(12345);

    const dflt = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    expect(readLogMaxBytesConfig(dflt.root, PM)).toBe(8 * 1024 * 1024);
  });
});

describe("pruneMergeGateArchive", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const seq = (n: number) => `${String(n).padStart(3, "0")}-task`;

  function seedArchive(p: ReturnType<typeof mergeGatePaths>, entries: Array<{ stem: string; ageDays: number }>, now: number) {
    mkdirSync(p.archiveDir, { recursive: true });
    for (const { stem, ageDays } of entries) {
      const file = join(p.archiveDir, `${stem}.request.json`);
      writeFileSync(file, JSON.stringify({ request_id: stem }));
      const mtime = new Date(now - ageDays * DAY_MS);
      utimesSync(file, mtime, mtime);
    }
  }

  test("no-op when every archived request is within the keep window", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const now = Date.now();
    seedArchive(p, [
      { stem: seq(1), ageDays: 1 },
      { stem: seq(2), ageDays: 13 },
    ], now);

    const outcome = pruneMergeGateArchive(p, 14, undefined, now);
    expect(outcome.prunedStems).toEqual([]);
    expect(outcome.totalBefore).toBe(2);
    expect(existsSync(join(p.archiveDir, `${seq(1)}.request.json`))).toBe(true);
    expect(existsSync(join(p.archiveDir, `${seq(2)}.request.json`))).toBe(true);
  });

  test("deletes archived requests older than keepDays and keeps the rest", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const now = Date.now();
    seedArchive(p, [
      { stem: seq(1), ageDays: 20 },
      { stem: seq(2), ageDays: 15 },
      { stem: seq(3), ageDays: 5 },
      { stem: seq(4), ageDays: 1 },
    ], now);

    const outcome = pruneMergeGateArchive(p, 14, undefined, now);
    expect(outcome.totalBefore).toBe(4);
    expect(outcome.prunedStems.sort()).toEqual([seq(1), seq(2)]);
    for (const stem of [seq(1), seq(2)]) {
      expect(existsSync(join(p.archiveDir, `${stem}.request.json`))).toBe(false);
    }
    for (const stem of [seq(3), seq(4)]) {
      expect(existsSync(join(p.archiveDir, `${stem}.request.json`))).toBe(true);
    }
  });

  test("protects a stem still queued in requests/ even if it is older than keepDays", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const now = Date.now();
    seedArchive(p, [{ stem: seq(1), ageDays: 30 }], now);
    mkdirSync(p.requestsDir, { recursive: true });
    writeFileSync(join(p.requestsDir, `${seq(1)}.json`), JSON.stringify({ request_id: seq(1) }));

    const outcome = pruneMergeGateArchive(p, 14, undefined, now);
    expect(outcome.prunedStems).toEqual([]);
    expect(existsSync(join(p.archiveDir, `${seq(1)}.request.json`))).toBe(true);
  });

  test("protects the stem the active lock currently references even if it is older than keepDays", () => {
    const { root } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    const p = mergeGatePaths(root, PM);
    const now = Date.now();
    seedArchive(p, [{ stem: seq(1), ageDays: 30 }], now);
    mkdirSync(p.locksDir, { recursive: true });
    writeFileSync(p.activeLock, JSON.stringify({
      pid: process.pid,
      request_id: seq(1),
      request_file: `${seq(1)}.json`,
      started_at: new Date().toISOString(),
    }));

    const outcome = pruneMergeGateArchive(p, 14, undefined, now);
    expect(outcome.prunedStems).toEqual([]);
    expect(existsSync(join(p.archiveDir, `${seq(1)}.request.json`))).toBe(true);
  });

  test("readArchiveKeepDaysConfig reads [merge_gate].archive_keep_days and defaults to 14 when absent", () => {
    const { root: withKey } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n\n[merge_gate]\narchive_keep_days = 3\n`);
    expect(readArchiveKeepDaysConfig(withKey, PM)).toBe(3);

    const { root: withoutKey } = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    expect(readArchiveKeepDaysConfig(withoutKey, PM)).toBe(14);
  });
});
