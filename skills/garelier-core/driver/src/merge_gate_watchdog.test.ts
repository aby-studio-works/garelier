import { rmSync } from "./guard/path_guard.ts";
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Logger } from "./log.ts";
import {
  mergeGatePaths,
  pollMergeGate,
  computeGateCeilingMs,
  evaluateGateStale,
  readGateCeilingMsConfig,
} from "./merge_gate.ts";

// W-063: the driver-side gate watchdog. merge-gate.ts's per-command `timeout -k`
// cannot always reap a native Windows grandchild, and a gate stuck OUTSIDE a
// timed command (or in a `timeout`-less env) leaves the subprocess alive
// forever, holding the single merge active.lock and blocking the whole queue.
// pollMergeGate now detects a hung-but-alive gate (past its ceiling + quiet log),
// kills its process tree, writes an aborted result, and drains the next request.

const PM = "tpm";
const dirs: string[] = [];
const kids: Array<{ pid: number; kill: () => void }> = [];
afterEach(() => {
  for (const k of kids.splice(0)) { try { k.kill(); } catch { /* already gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForExit(child: { pid: number; exited: Promise<number> }, timeoutMs = 5_000): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for pid ${child.pid} to exit`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function project(body = `[quality_gate]\nstack = "typescript"\ncommands = []\n`) {
  const root = mkdtempSync(join(tmpdir(), "garelier-w063-"));
  dirs.push(root);
  const pmDir = join(root, "__garelier", PM, "_crew", "pm");
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

const MIN = 60_000;

describe("computeGateCeilingMs", () => {
  function reqFile(obj: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), "garelier-w063-req-"));
    dirs.push(root);
    const f = join(root, "req.json");
    writeFileSync(f, JSON.stringify(obj));
    return f;
  }

  // W-677: the 4 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("an explicit max_duration_ms in the request wins over config and derivation (+3 folded cases)", () => {
    // case: an explicit max_duration_ms in the request wins over config and derivation
    {
      const f = reqFile({ max_duration_ms: 123456, quality_gate_timeout_minutes_per_cmd: 30, quality_gate_commands: ["a", "b"] });
      expect(computeGateCeilingMs(f, 999 * MIN)).toBe(123456);
    }
    // case: the config override is used when the request has no max_duration_ms
    {
      const f = reqFile({ quality_gate_timeout_minutes_per_cmd: 30, quality_gate_commands: ["a"] });
      expect(computeGateCeilingMs(f, 42 * MIN)).toBe(42 * MIN);
    }
    // case: derives per-cmd-timeout × command-count × factor(2) + 15min margin otherwise
    {
      const f = reqFile({ quality_gate_timeout_minutes_per_cmd: 30, quality_gate_commands: ["a", "b"] });
      expect(computeGateCeilingMs(f)).toBe(30 * MIN * 2 * 2 + 15 * MIN);
    }
    // case: fails open to the 120-min default derivation on an unreadable request
    {
      expect(computeGateCeilingMs(join(tmpdir(), "w063-does-not-exist.json"))).toBe(120 * MIN * 1 * 2 + 15 * MIN);
    }
  });
});

describe("evaluateGateStale", () => {
  const CEIL = 60 * MIN;
  const now = 1_000_000_000_000;

  // W-677: the 5 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("a gate within its ceiling is not stale (+4 folded cases)", () => {
    // case: a gate within its ceiling is not stale
    {
      const d = evaluateGateStale({ startedAtMs: now - 10 * MIN, nowMs: now, ceilingMs: CEIL, logMtimeMs: now });
      expect(d.ceilingExceeded).toBe(false);
      expect(d.stale).toBe(false);
    }
    // case: past the ceiling but with an ACTIVELY-written log is not stale (slow but progressing)
    {
      const d = evaluateGateStale({ startedAtMs: now - 2 * CEIL, nowMs: now, ceilingMs: CEIL, logMtimeMs: now - 1000 });
      expect(d.ceilingExceeded).toBe(true);
      expect(d.logQuiet).toBe(false);
      expect(d.stale).toBe(false);
    }
    // case: past the ceiling AND a quiet log is stale
    {
      const d = evaluateGateStale({ startedAtMs: now - 2 * CEIL, nowMs: now, ceilingMs: CEIL, logMtimeMs: now - 10 * MIN });
      expect(d.stale).toBe(true);
    }
    // case: a missing log counts as quiet
    {
      const d = evaluateGateStale({ startedAtMs: now - 2 * CEIL, nowMs: now, ceilingMs: CEIL, logMtimeMs: null });
      expect(d.logQuiet).toBe(true);
      expect(d.stale).toBe(true);
    }
    // case: an unparseable start time is never treated as exceeded (cannot judge elapsed)
    {
      const d = evaluateGateStale({ startedAtMs: NaN, nowMs: now, ceilingMs: CEIL, logMtimeMs: null });
      expect(d.ceilingExceeded).toBe(false);
      expect(d.stale).toBe(false);
    }
  });
});

describe("readGateCeilingMsConfig", () => {
  test("reads [merge_gate].gate_ceiling_minutes as ms, null when absent", () => {
    const withKey = project(`[quality_gate]\nstack = "typescript"\ncommands = []\n\n[merge_gate]\ngate_ceiling_minutes = 10\n`);
    expect(readGateCeilingMsConfig(withKey.root, PM)).toBe(10 * MIN);
    const without = project();
    expect(readGateCeilingMsConfig(without.root, PM)).toBeNull();
  });
});

describe("pollMergeGate watchdog (W-063)", () => {
  function seedActive(root: string, opts: {
    pid: number;
    startedAt: string;
    logMtimeMs: number;
    maxDurationMs: number;
    stem?: string;
    sourceBranch?: string;
    sourceSha?: string;
  }) {
    const p = mergeGatePaths(root, PM);
    for (const d of [p.requestsDir, p.resultsDir, p.logsDir, p.locksDir, p.archiveDir]) mkdirSync(d, { recursive: true });
    const stem = opts.stem ?? "050-task";
    writeFileSync(join(p.requestsDir, `${stem}.json`), JSON.stringify({
      request_id: stem,
      max_duration_ms: opts.maxDurationMs,
      studio_branch: "garelier/main/tpm/studio",
      target_root: root,
      ...(opts.sourceBranch ? { workbench_branch: opts.sourceBranch } : {}),
      ...(opts.sourceSha ? { workbench_tip: opts.sourceSha } : {}),
    }));
    const logFile = join(p.logsDir, `${stem}.log`);
    writeFileSync(logFile, "gate log\n");
    const t = new Date(opts.logMtimeMs);
    utimesSync(logFile, t, t);
    writeFileSync(p.activeLock, JSON.stringify({
      pid: opts.pid, request_id: stem, request_file: `${stem}.json`, started_at: opts.startedAt, target_root: root,
    }));
    return { p, stem };
  }

  function liveChild() {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], { windowsHide: true, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    kids.push(child);
    return child;
  }

  function git(root: string, args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
  }

  function beginFixtureMerge(root: string, branch: string): string {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "ci@ci"]);
    git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["checkout", "-q", "-b", branch]);
    writeFileSync(join(root, `${branch}.txt`), `${branch}\n`);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", branch]);
    const sourceSha = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "--no-ff", "--no-commit", branch]);
    expect(git(root, ["rev-parse", "MERGE_HEAD"])).toBe(sourceSha);
    return sourceSha;
  }

  test("recovers stale gates, preserves unowned merges, aborts proven gate-owned merges, and kills hung trees", async () => {
    const { root, config } = project();
    const child = liveChild();
    const { p, stem } = seedActive(root, {
      pid: child.pid,
      startedAt: new Date(Date.now() - 10 * MIN).toISOString(), // 10 min ago >> tiny ceiling
      logMtimeMs: Date.now() - 10 * MIN,                        // log quiet 10 min
      maxDurationMs: 1000,                                      // 1s ceiling → exceeded
    });
    const log = new Logger("test", join(root, "driver.jsonl"));
    const result = await pollMergeGate(root, config, log);

    expect(result.recoveredAbortedRequestId).toBe(stem);
    const res = JSON.parse(readFileSync(join(p.resultsDir, `${stem}.json`), "utf8"));
    expect(res.status).toBe("aborted");
    expect(res.failure_reason).toContain("watchdog");
    expect(existsSync(p.activeLock)).toBe(false); // lock released → queue can move

    await waitForExit(child);
    expect(isAlive(child.pid)).toBe(false); // process tree reaped

    // W-286 Final2: a dead subprocess may have acquired active.lock before it
    // rejected a pre-existing user merge. Without durable request-bound
    // ownership evidence, driver recovery must preserve MERGE_HEAD + index.
    const unowned = project();
    const userMergeHead = beginFixtureMerge(unowned.root, "user-merge");
    const userIndex = git(unowned.root, ["diff", "--cached", "--binary"]);
    const unownedActive = seedActive(unowned.root, {
      pid: 2_147_483_647,
      startedAt: new Date().toISOString(),
      logMtimeMs: Date.now(),
      maxDurationMs: 60 * MIN,
      stem: "052-unowned",
    });
    const unownedResult = await pollMergeGate(
      unowned.root,
      unowned.config,
      new Logger("test", join(unowned.root, "driver.jsonl")),
    );
    expect(unownedResult.recoveredAbortedRequestId).toBe(unownedActive.stem);
    expect(git(unowned.root, ["rev-parse", "MERGE_HEAD"])).toBe(userMergeHead);
    expect(git(unowned.root, ["diff", "--cached", "--binary"])).toBe(userIndex);

    // The inverse boundary: exact request/root/MERGE_HEAD/source evidence proves
    // this merge belongs to the dead gate, so recovery aborts it and clears the
    // request marker instead of stranding the shared studio index.
    const owned = project();
    const ownedMergeHead = beginFixtureMerge(owned.root, "gate-source");
    const ownedActive = seedActive(owned.root, {
      pid: 2_147_483_647,
      startedAt: new Date().toISOString(),
      logMtimeMs: Date.now(),
      maxDurationMs: 60 * MIN,
      stem: "053-owned",
      sourceBranch: "gate-source",
      sourceSha: ownedMergeHead,
    });
    const marker = join(ownedActive.p.locksDir, `${ownedActive.stem}.merge-owner.json`);
    writeFileSync(marker, JSON.stringify({
      schema_version: 1,
      request_id: ownedActive.stem,
      owner_pid: 2_147_483_647,
      target_root: owned.root,
      merge_head: ownedMergeHead,
      source_sha: ownedMergeHead,
    }));
    const ownedResult = await pollMergeGate(
      owned.root,
      owned.config,
      new Logger("test", join(owned.root, "driver.jsonl")),
    );
    expect(ownedResult.recoveredAbortedRequestId).toBe(ownedActive.stem);
    expect(() => git(owned.root, ["rev-parse", "--verify", "MERGE_HEAD"])).toThrow();
    expect(git(owned.root, ["diff", "--cached", "--name-only"])).toBe("");
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  test("after aborting a hung gate, drains the next queued request (self-drain fall-through)", async () => {
    const { root, config } = project();
    const child = liveChild();
    const { p, stem } = seedActive(root, {
      pid: child.pid,
      startedAt: new Date(Date.now() - 10 * MIN).toISOString(),
      logMtimeMs: Date.now() - 10 * MIN,
      maxDurationMs: 1000,
    });
    // A newer queued request the drain must pick up once the hung gate is cleared.
    writeFileSync(join(p.requestsDir, "051-next.json"), JSON.stringify({
      request_id: "051-next", studio_branch: "garelier/main/tpm/studio", target_root: root,
    }));
    const dummyScript = join(root, "dummy-merge-gate.ts");
    writeFileSync(dummyScript, "#!/usr/bin/env bash\n");
    const dispatched: string[] = [];
    const log = new Logger("test", join(root, "driver.jsonl"));
    const result = await pollMergeGate(root, config, log, {
      scriptOverride: dummyScript,
      spawnFn: (_s, args) => { dispatched.push(args[0]!); return 4242; },
    });

    expect(result.recoveredAbortedRequestId).toBe(stem);
    expect(result.spawnedRequestId).toBe("051-next");
    expect(dispatched[0]).toContain("051-next.json");
    // The hung gate's request was archived as resolved; the active lock now
    // belongs to the freshly dispatched request, not the aborted one.
    const lock = JSON.parse(readFileSync(p.activeLock, "utf8"));
    expect(lock.request_id).toBe("051-next");
  }, 20_000);

  test("leaves a healthy gate within its ceiling running — lock intact, no aborted result", async () => {
    const { root, config } = project();
    const child = liveChild();
    const { p, stem } = seedActive(root, {
      pid: child.pid,
      startedAt: new Date().toISOString(), // just started
      logMtimeMs: Date.now(),              // fresh log
      maxDurationMs: 60 * MIN,             // 1h ceiling → not exceeded
    });
    const log = new Logger("test", join(root, "driver.jsonl"));
    const result = await pollMergeGate(root, config, log);

    expect(result.recoveredAbortedRequestId).toBeUndefined();
    expect(existsSync(p.activeLock)).toBe(true);                          // untouched
    expect(existsSync(join(p.resultsDir, `${stem}.json`))).toBe(false);  // not aborted
    expect(isAlive(child.pid)).toBe(true);                               // still running
  }, 20_000);
});
