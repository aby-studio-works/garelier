import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Logger } from "./log.ts";
import { mergeGatePaths, pollMergeGate, writeMergeRequest, reconcileGateAcks } from "./merge_gate.ts";

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
