import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bgCompletionGap } from "./dispatch_watch.ts";
import { promptPreamble } from "./dispatch_prepare.ts";
import { upsertRoleSourcePointerSection } from "../lenses.ts";
import { rmSync } from "../guard/path_guard.ts";
import {
  acknowledgeLongJob,
  armLongJob,
  failLongJob,
  finishLongJob,
  recoverLongJobs,
  readLongJob,
  startLongJob,
} from "../long_jobs.ts";

type LongJobIdentity = { command: string; dispatchId: string; agentId: string; provider: string };
type LongJobTimeline = { created: string; started: string; terminal: string; acked?: string };

const W389_IDENTITY: LongJobIdentity = {
  command: "bun role.ts --dispatch 540\n",
  dispatchId: "540",
  agentId: "w186-dispatch540-official-role",
  provider: "codex",
};
const W389_FAILED_TIMELINE: LongJobTimeline = {
  created: "2026-08-10T00:00:00.000Z",
  started: "2026-08-10T00:01:00.000Z",
  terminal: "2026-08-10T00:02:00.000Z",
};
const W389_SUCCESSOR_TIMELINE: LongJobTimeline = {
  created: "2026-08-10T00:03:00.000Z",
  started: "2026-08-10T00:04:00.000Z",
  terminal: "2026-08-10T00:05:00.000Z",
  acked: "2026-08-10T00:06:00.000Z",
};

function armLongJobFixture(root: string, cwd: string, jobId: string, identity: LongJobIdentity, created: string) {
  mkdirSync(root, { recursive: true });
  const commandRef = join(root, `${jobId}.command.txt`);
  writeFileSync(commandRef, identity.command);
  return armLongJob({
    root,
    jobId,
    command: identity.command,
    commandRef,
    dispatchId: identity.dispatchId,
    agentId: identity.agentId,
    provider: identity.provider,
    cwd,
    wake: { armed: true, capability: "codex-task", source: "w389-test" },
    now: created,
  });
}

function failedLongJobFixture(root: string, cwd: string, jobId: string, identity: LongJobIdentity, timeline: LongJobTimeline) {
  armLongJobFixture(root, cwd, jobId, identity, timeline.created);
  startLongJob(root, jobId, timeline.started, 900_001);
  return failLongJob(root, jobId, 1, "role launch failed", 1, timeline.terminal);
}

function successfulLongJobFixture(
  root: string,
  cwd: string,
  jobId: string,
  identity: LongJobIdentity,
  timeline: LongJobTimeline,
  acknowledge = true,
) {
  armLongJobFixture(root, cwd, jobId, identity, timeline.created);
  startLongJob(root, jobId, timeline.started, 900_002);
  const finished = finishLongJob(root, jobId, 1, { launched: true }, timeline.terminal);
  return acknowledge ? acknowledgeLongJob(root, jobId, 1, timeline.acked) : finished;
}

function w389RecoveryCase(
  name: string,
  successorIdentity = W389_IDENTITY,
  timeline = W389_SUCCESSOR_TIMELINE,
  acknowledge = true,
) {
  const cwd = mkdtempSync(join(tmpdir(), `garelier-w389-${name}-`));
  const root = join(cwd, "ledger");
  failedLongJobFixture(root, cwd, "w186-dispatch540-official-role", W389_IDENTITY, W389_FAILED_TIMELINE);
  const successor = successfulLongJobFixture(
    root,
    cwd,
    "w186-dispatch540-official-role-project-cwd",
    successorIdentity,
    timeline,
    acknowledge,
  );
  return { cwd, root, successor };
}

// W-363: heavy build/RUN roles lost a background-job completion wake 7+
// times in one 24h session (gate finished, seat never resumed; every one needed
// a manual PM wake — process-probe then SendMessage). Two changes close it:
// (a) dispatch_watch cross-references the dispatch's long-job LEDGER directly
//     (a FINISHED-but-unacked record is a fact, not an inferred git/file
//     fingerprint) and fires BG-COMPLETION-UNACKED immediately — see
//     bgCompletionGap below (dispatch_watch.ts wires it into runWindow's poll).
// (b) the role contract explicitly requires a self-check on every wake
//     ("Background self-check (W-363)" in dispatch_prepare's promptPreamble).
//
// Mechanism choice: option (a) from the row ("dispatch_watch itself calls
// SendMessage automatically") was NOT built as literally described — it
// contradicts DEC-066 (pm_playbook.md: a "true zero-token auto-wake" that
// delivers a wake with NO LLM in the loop is explicitly OUT OF Garelier's scope;
// that operating model was removed by user directive and is not reintroduced).
// The in-scope, testable half of (a) — ledger-authoritative DETECTION, stronger
// than IDLE-DONE's inference — is implemented, paired with (b)'s explicit
// self-check contract clause. Both still route through the existing
// human/PM-in-the-loop wake path (RESULT line -> operator reads it -> SendMessage).

describe("W-363 bgCompletionGap (ledger-authoritative BG-COMPLETION-UNACKED signal)", () => {
  const rec = (jobId: string, state: string, finishedAt?: string) => ({
    job_id: jobId, state: state as "ARMED" | "RUNNING" | "FINISHED" | "FAILED" | "ACKED",
    timestamps: { finished_at: finishedAt } as { finished_at?: string },
  });

  test("no records -> null", () => {
    expect(bgCompletionGap([], Date.now())).toBeNull();
  });

  test("a FINISHED record inside the grace period does not fire (just-finished, seat hasn't had a chance to notice)", () => {
    const now = Date.parse("2026-08-05T15:30:00.000Z");
    const finishedAt = new Date(now - 30_000).toISOString(); // 30s ago, grace default 120s
    expect(bgCompletionGap([rec("job-1", "FINISHED", finishedAt)], now)).toBeNull();
  });

  test("a FINISHED record past grace fires with the job id and age", () => {
    const now = Date.parse("2026-08-05T15:30:00.000Z");
    const finishedAt = new Date(now - 180_000).toISOString(); // 3 minutes ago
    const gap = bgCompletionGap([rec("job-1", "FINISHED", finishedAt)], now);
    expect(gap).not.toBeNull();
    expect(gap!.jobId).toBe("job-1");
    expect(gap!.ageMs).toBe(180_000);
  });

  test("boundary: exactly at the grace threshold fires (>= , not >)", () => {
    const now = Date.parse("2026-08-05T15:30:00.000Z");
    const finishedAt = new Date(now - 120_000).toISOString();
    expect(bgCompletionGap([rec("job-1", "FINISHED", finishedAt)], now, 120_000)).not.toBeNull();
    expect(bgCompletionGap([rec("job-1", "FINISHED", finishedAt)], now, 120_001)).toBeNull();
  });

  test("non-FINISHED wake states stay silent; W-389 recovery supersedes only exact later ACKED success", () => {
    const now = Date.parse("2026-08-05T15:30:00.000Z");
    const longAgo = new Date(now - 3_600_000).toISOString();
    for (const state of ["ARMED", "RUNNING", "FAILED", "ACKED"]) {
      expect(bgCompletionGap([rec("job-1", state, longAgo)], now)).toBeNull();
    }

    const fixtures: string[] = [];
    try {
      const exact = w389RecoveryCase("exact");
      fixtures.push(exact.cwd);
      expect(recoverLongJobs(exact.root)).toEqual([]);

      const variants: Array<[string, LongJobIdentity, LongJobTimeline, boolean]> = [
        ["digest", { ...W389_IDENTITY, command: "bun role.ts --dispatch 541\n" }, W389_SUCCESSOR_TIMELINE, true],
        ["dispatch", { ...W389_IDENTITY, dispatchId: "541" }, W389_SUCCESSOR_TIMELINE, true],
        ["agent", { ...W389_IDENTITY, agentId: "replacement-agent" }, W389_SUCCESSOR_TIMELINE, true],
        ["provider", { ...W389_IDENTITY, provider: "claude-code" }, W389_SUCCESSOR_TIMELINE, true],
        ["not-acked", W389_IDENTITY, W389_SUCCESSOR_TIMELINE, false],
        ["earlier", W389_IDENTITY, {
          created: "2026-08-09T23:53:00.000Z",
          started: "2026-08-09T23:54:00.000Z",
          terminal: "2026-08-09T23:55:00.000Z",
          acked: "2026-08-09T23:56:00.000Z",
        }, true],
      ];
      for (const [name, successorIdentity, timeline, acknowledge] of variants) {
        const fixture = w389RecoveryCase(name, successorIdentity, timeline, acknowledge);
        fixtures.push(fixture.cwd);
        expect(recoverLongJobs(fixture.root)).toContainEqual({
          job_id: "w186-dispatch540-official-role",
          attempt: 1,
          action: "RERUN_WHOLE_COMMAND",
          reason: "failed",
        });
      }

      const corrupt = w389RecoveryCase("corrupt-ack");
      fixtures.push(corrupt.cwd);
      writeFileSync(corrupt.successor.paths.ack, "{not-json}\n");
      const actions = recoverLongJobs(corrupt.root);
      expect(actions).toContainEqual({
        job_id: "w186-dispatch540-official-role",
        attempt: 1,
        action: "RERUN_WHOLE_COMMAND",
        reason: "failed",
      });
      expect(actions.some((item) => item.job_id === corrupt.successor.job_id && item.action === "BLOCK_LEDGER_PATH")).toBeTrue();

      // W-391: a terminal record remains acknowledgeable after its dispatch
      // checkout disappeared; a live record keeps the cwd identity fence.
      const orphan = mkdtempSync(join(tmpdir(), "garelier-w391-terminal-"));
      fixtures.push(orphan);
      const terminalCwd = join(orphan, "removed-container");
      mkdirSync(terminalCwd);
      const terminalRoot = join(orphan, "ledger");
      failedLongJobFixture(terminalRoot, terminalCwd, "terminal", W389_IDENTITY, W389_FAILED_TIMELINE);
      rmSync(terminalCwd, { recursive: true, force: true });
      expect(acknowledgeLongJob(terminalRoot, "terminal", 1).state).toBe("ACKED");
      expect(recoverLongJobs(terminalRoot)).toEqual([]);

      const liveCwd = join(orphan, "live-container");
      mkdirSync(liveCwd);
      armLongJobFixture(terminalRoot, liveCwd, "live", W389_IDENTITY, W389_SUCCESSOR_TIMELINE.created);
      rmSync(liveCwd, { recursive: true, force: true });
      expect(() => readLongJob(terminalRoot, "live")).toThrow("cwd/worktree");
    } finally {
      for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("a missing/unparseable finished_at is skipped, never crashes or false-fires", () => {
    const now = Date.now();
    expect(bgCompletionGap([rec("job-1", "FINISHED", undefined)], now)).toBeNull();
    expect(bgCompletionGap([rec("job-1", "FINISHED", "not-a-date")], now)).toBeNull();
  });

  test("multiple pending completions report the OLDEST (largest age)", () => {
    const now = Date.parse("2026-08-05T15:30:00.000Z");
    const recent = new Date(now - 150_000).toISOString();
    const old = new Date(now - 900_000).toISOString();
    const gap = bgCompletionGap([rec("job-recent", "FINISHED", recent), rec("job-old", "FINISHED", old)], now);
    expect(gap!.jobId).toBe("job-old");
    expect(gap!.ageMs).toBe(900_000);
  });
});

describe("W-363 role contract: background self-check clause", () => {
  const baseParsed = {
    project: "", targetRoot: "", pm: "pm", role: "worker", slug: "slug", base: "", blueprint: "",
    pipelinePackage: "", inModel: "", inEffort: "", inScope: "", inTags: "", inTouches: "",
    inDepends: "", inCommitMode: "", inResourceClass: "", inRuntimeEffect: "", inHeavyTier: "", inBashBudgetMs: "", provider: "claude-code", providerTransport: "",
    taskFile: "", reuse: "", row: "",
    workId: "", controlSession: "",
    recoverRole: false, recoveryDispatch: "", recoveryBranch: "", recoveryReason: "",
    rebindAuthority: false, dispatchId: "", evidence: "", candidateSha: "",
    expectedPreviousDigest: "", expectedPreviousDigestSet: false,
    itemAuthority: "", assignmentPath: "", promptPath: "", initialInstructionsPath: "",
    recoveryWip: [], acceptanceIds: [], approvedRemotes: [],
    allowConflict: false, fullGate: false, rework: false, force: false,
  };

  test("promptPreamble includes the W-363 background self-check requirement, naming BG-COMPLETION-UNACKED", () => {
    const preamble = promptPreamble(baseParsed, "1", "branch", "abc123", "/container", "self", "sonnet", "claude-code");
    expect(preamble).toContain("Background self-check (W-363)");
    expect(preamble).toContain("BG-COMPLETION-UNACKED");
    expect(preamble).toContain("your FIRST action is to check every outstanding background job");

    // W-402: the Codex-dispatched role contract (proxy-commit path) carries the four
    // long-run operational bullets a real 8-lane codex run needed (2026-08-11
    // knowledge log): background-terminal long-run handling, launch-ack timing,
    // control-only base drift, and mandatory scoped self-gate.
    const codexPreamble = promptPreamble(baseParsed, "1", "branch", "abc123", "/container", "proxy", "sonnet", "codex");
    expect(codexPreamble).toContain("Long-run commands (W-402)");
    expect(codexPreamble).toContain("background terminal");
    expect(codexPreamble).toContain("background_terminal_max_timeout` default 300000ms/poll");
    expect(codexPreamble).toContain("Launch ack timing (W-402)");
    expect(codexPreamble).toContain("never a BLOCK condition");
    expect(codexPreamble).toContain("Base drift (W-402)");
    expect(codexPreamble).toContain("control-only commit difference");
    expect(codexPreamble).toContain("Scoped self-gate (W-402)");
    expect(codexPreamble).toContain("full-workspace-tier gate");

    // W-436: recovery updates the source pointers in the exact byte shape
    // emitted by promptPreamble. The pointer span must never absorb the
    // role contract bullets that follow it. Also cover prompts emitted
    // before the explicit pointer terminator existed.
    const pointerOptions = {
      blueprintPath: "/next-blueprint.md",
      lens: { ref: null, source: "none" as const, registry_path: null, pack_path: null },
    };
    const recoveredPreambles = [
      upsertRoleSourcePointerSection(codexPreamble, pointerOptions),
      upsertRoleSourcePointerSection(
        codexPreamble.replace("<!-- /Role source pointers -->\n", ""),
        pointerOptions,
      ),
    ];
    for (const recovered of recoveredPreambles) {
      expect(recovered).toContain("Blueprint: `/next-blueprint.md`");
      expect(recovered).toContain("Work ONLY inside your checkout worktree");
      expect(recovered).toContain("Process kill (W-170)");
      expect(recovered).toContain("NEVER an indiscriminate name/image bulk kill");
      expect(recovered).toContain("Register-terminate (W-085)");
      expect(recovered).toContain("Delivery (W-146)");
      expect(recovered).toContain("Do NOT push any branch");
    }
  });
});
