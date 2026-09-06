import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, unlinkSync } from "./guard/path_guard.ts";
import {
  acknowledgeLongJob,
  armLongJob,
  finishLongJob,
  listLongJobs,
  recoverLongJobs,
  startLongJob,
  type LongJobRecord,
} from "./long_jobs.ts";

const COMMAND = "bun some_whole_gate_command.ts --project .\n";
const scratch: string[] = [];

function scratchDir(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `garelier-ledger-${label}-`));
  scratch.push(path);
  return path;
}

/** Ledger root + a worktree, both disposable, matching a real dispatch shape. */
function fixture(label: string): { root: string; cwd: string } {
  return { root: join(scratchDir(`${label}-home`), "long_jobs"), cwd: scratchDir(`${label}-cwd`) };
}

/**
 * Arm a job whose `--command-ref` sits in a sibling payload directory inside the
 * ledger root — the position `arm` accepts, and the one that used to turn the
 * payload directory into a job with no `record.json`.
 */
function armWithPayloadDirectory(root: string, cwd: string, jobId: string): { record: LongJobRecord; commandRef: string } {
  mkdirSync(join(root, "commands"), { recursive: true });
  const commandRef = join(root, "commands", `${jobId}.cmd`);
  writeFileSync(commandRef, COMMAND);
  const record = armLongJob({
    root,
    jobId,
    command: COMMAND,
    commandRef,
    dispatchId: "355",
    agentId: `${jobId}-agent`,
    provider: "operator-background",
    cwd,
    wake: { armed: true, capability: "monitor", source: "ledger-denominator-test" },
  });
  return { record, commandRef };
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("long-job ledger denominator", () => {
  test("a command payload directory accepted by arm does not become a job", () => {
    const { root, cwd } = fixture("payload");
    const { record } = armWithPayloadDirectory(root, cwd, "gate-run");

    // The armed job itself is still visible and still the ONLY job.
    expect(listLongJobs(root).map((job) => job.job_id)).toEqual(["gate-run"]);
    expect(record.state).toBe("ARMED");

    // With a broker absent an ARMED job legitimately asks for a broker; that is
    // an action, not a ledger BLOCK. No entry may name the payload directory.
    const actions = recoverLongJobs(root);
    expect(actions.map((action) => action.job_id)).not.toContain("commands");
    expect(actions.filter((action) => action.action.startsWith("BLOCK_"))).toEqual([]);
  });

  test("a settled ledger with a payload directory produces no recovery action at all", () => {
    const { root, cwd } = fixture("settled");
    armWithPayloadDirectory(root, cwd, "gate-run");
    startLongJob(root, "gate-run", undefined, 900_101);
    finishLongJob(root, "gate-run", 1, { ok: true });
    acknowledgeLongJob(root, "gate-run", 1);

    expect(recoverLongJobs(root)).toEqual([]);
  });

  test("a directory holding job artifacts but no record.json still BLOCKs", () => {
    const { root, cwd } = fixture("corrupt");
    armWithPayloadDirectory(root, cwd, "gate-run");
    // A job whose record was lost must never be silently dropped from the scan.
    mkdirSync(join(root, "lost-record"), { recursive: true });
    writeFileSync(join(root, "lost-record", "job.log"), "partial output\n");

    const blocked = recoverLongJobs(root).filter((action) => action.job_id === "lost-record");
    expect(blocked.map((action) => action.action)).toEqual(["BLOCK_WAKE_UNARMED"]);
  });

  test("an emptied payload directory is not a job", () => {
    const { root, cwd } = fixture("empty");
    armWithPayloadDirectory(root, cwd, "gate-run");
    mkdirSync(join(root, "drained-payloads"), { recursive: true });

    expect(recoverLongJobs(root).map((action) => action.job_id)).not.toContain("drained-payloads");
  });

  test("a live job whose command payload is missing still BLOCKs", () => {
    const { root, cwd } = fixture("missing-live");
    const { commandRef } = armWithPayloadDirectory(root, cwd, "gate-run");
    unlinkSync(commandRef);

    const blocked = recoverLongJobs(root).filter((action) => action.job_id === "gate-run");
    expect(blocked.map((action) => action.action)).toEqual(["BLOCK_WAKE_UNARMED"]);
    expect(blocked[0]?.reason).toContain("gate-run.cmd");
  });

  test("an ACKED job whose command payload was removed does not stop the scan", () => {
    const { root, cwd } = fixture("missing-acked");
    const { commandRef } = armWithPayloadDirectory(root, cwd, "gate-run");
    startLongJob(root, "gate-run", undefined, 900_102);
    finishLongJob(root, "gate-run", 1, { ok: true });
    acknowledgeLongJob(root, "gate-run", 1);
    unlinkSync(commandRef);

    expect(recoverLongJobs(root)).toEqual([]);
    expect(listLongJobs(root).map((job) => job.state)).toEqual(["ACKED"]);
  });

  test("an ACKED command_ref pointing outside the ledger root still BLOCKs", () => {
    const { root, cwd } = fixture("escape-acked");
    armWithPayloadDirectory(root, cwd, "gate-run");
    startLongJob(root, "gate-run", undefined, 900_103);
    finishLongJob(root, "gate-run", 1, { ok: true });
    acknowledgeLongJob(root, "gate-run", 1);

    const recordPath = join(root, "gate-run", "record.json");
    const raw = JSON.parse(readFileSync(recordPath, "utf8")) as LongJobRecord;
    raw.command_ref = join(cwd, "outside.cmd");
    writeFileSync(recordPath, `${JSON.stringify(raw, null, 2)}\n`);

    const blocked = recoverLongJobs(root).filter((action) => action.job_id === "gate-run");
    expect(blocked.map((action) => action.action)).toEqual(["BLOCK_WAKE_UNARMED"]);
    expect(blocked[0]?.reason).toContain("durable ledger root");
  });
});
