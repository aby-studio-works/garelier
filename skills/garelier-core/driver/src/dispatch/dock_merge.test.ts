import { renameSync, rmSync } from "../guard/path_guard.ts";
// Garelier dispatch (DEC-052) — Dock-bay merge CLI tests. Covers status (pure
// reads) + poll on an empty queue (no spawn). The merge mechanics themselves are
// covered by merge_gate.test.ts (pollMergeGate with an injected spawnFn).
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureMergeGateDirs, mergeGatePaths } from "../merge_gate.ts";
import {
  classifyDockChildOutcome,
  integrateOne,
  readAuthoritativeDockResult,
  scanAuthoritativeDockRequests,
  type IntegrateCtx,
  type IntegrateDeps,
} from "./dock_integrate.ts";

const here = import.meta.dir;

async function runDock(args: string[], project: string) {
  const p = Bun.spawn(["bun", "run", join(here, "dock_merge.ts"), ...args], { windowsHide: true,
    cwd: here, env: { ...process.env, GARELIER_PROJECT: project }, stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill(); }, 30_000);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (timedOut) throw new Error(`dock_merge child timed out after 30000ms: ${args.join(" ")}`);
  return { out, err, code };
}

test("status: empty merge gate -> nulls/empties", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-dock-"));
  try {
    const r = await runDock(["status", "--pm-id", "demo"], project);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.active).toBeNull();
    // W-030: pending/results are {count, recent} summaries, not full arrays.
    expect(s.pending).toEqual({ count: 0, recent: [] });
    expect(s.results).toEqual({ count: 0, recent: [] });

    const setup = join(project, "__garelier", "demo", "_crew", "pm", "setup_config.toml");
    mkdirSync(join(project, "__garelier", "demo", "_crew", "pm"), { recursive: true });
    writeFileSync(setup, [
      "[project]", 'name = "dock-await-fixture"', "",
      "[branches]", 'target = "main"', 'integration = "garelier/main/demo/studio"', "",
    ].join("\n"));
    const paths = mergeGatePaths(project, "demo");
    ensureMergeGateDirs(paths);
    const settlementResult = join(paths.resultsDir, "req-settlement.json");
    writeFileSync(settlementResult, JSON.stringify({
      request_id: "req-settlement", status: "success", control_schema_version: 3,
      studio_commit: "a".repeat(40), control_update: null,
    }));
    const unsettled = await runDock([
      "await", "--pm-id", "demo", "--request-id", "req-settlement",
      "--poll-ms", "250", "--ceiling-ms", "250",
    ], project);
    expect(unsettled.code).toBe(125);
    expect(JSON.parse(unsettled.out)).toMatchObject({
      request_id: "req-settlement", status: "control_settlement_timeout",
    });
    writeFileSync(settlementResult, JSON.stringify({
      request_id: "req-settlement", status: "success", control_schema_version: 3,
      studio_commit: "a".repeat(40), control_update: { status: "ok" },
    }));
    const settled = await runDock([
      "await", "--pm-id", "demo", "--request-id", "req-settlement",
      "--poll-ms", "250", "--ceiling-ms", "250",
    ], project);
    expect(settled.code).toBe(0);
    expect(JSON.parse(settled.out).control_update.status).toBe("ok");

    const ctx: IntegrateCtx = {
      project, targetRoot: project, pmId: "demo", scriptsDir: here,
      studioBranch: "garelier/main/demo/studio", pollMs: 1, ceilingMs: 1000, noCleanup: false,
    };
    const calls: string[] = [];
    const deps: IntegrateDeps = {
      runBash(script, args) { calls.push(`${script} ${args.join(" ")}`); return { stdout: "{}", stderr: "", code: 0 }; },
      async pollOnce() {},
      readResult(stem) { return { request_id: stem, status: "success", studio_commit: "a".repeat(40) }; },
      isAncestorOfStudio() { return true; },
      scanRequests() { return []; },
      writeQuestions() {}, now: () => 0, sleep: async () => {}, log: { info() {}, warn() {} },
    };
    const item = { slug: "exact", branch: "garelier/main/demo/workbench/#1/exact", guardianVerdict: "PASS", dispatchId: 1 };
    writeFileSync(join(paths.archiveDir, "req-contradict.request.json"), JSON.stringify({ workbench_branch: item.branch }));
    const canonicalFailure = {
      request_id: "req-contradict", status: "failed", studio_commit: null,
      workbench_branch: item.branch, workbench_tip: "b".repeat(40),
    };
    writeFileSync(join(paths.resultsDir, "req-contradict.json"), JSON.stringify(canonicalFailure));
    writeFileSync(join(paths.resultsDir, "req-contradict.summary.json"), JSON.stringify({
      ...canonicalFailure, status: "success", studio_commit: "a".repeat(40),
    }));
    deps.readResult = (stem) => readAuthoritativeDockResult(paths, stem);
    deps.scanRequests = () => scanAuthoritativeDockRequests(paths);
    const contradictory = await integrateOne(item, ctx, deps);
    expect(contradictory.state).toBe("INTEGRATE_ERROR");
    expect(contradictory.error).toContain("derived summary disagrees with canonical result on status");

    const canonicalPath = join(paths.resultsDir, "req-contradict.json");
    const summaryPath = join(paths.resultsDir, "req-contradict.summary.json");
    rmSync(summaryPath, { force: false });
    const canonicalBytes = readFileSync(canonicalPath, "utf8");
    rmSync(canonicalPath, { force: false });
    const externalResult = join(project, "external-result.json");
    writeFileSync(externalResult, canonicalBytes);
    symlinkSync(externalResult, canonicalPath, "file");
    expect(readAuthoritativeDockResult(paths, "req-contradict")?.authority_error).toContain("non-reparse regular file");
    rmSync(canonicalPath, { force: false });
    writeFileSync(canonicalPath, "x".repeat(4 * 1024 * 1024 + 1));
    expect(readAuthoritativeDockResult(paths, "req-contradict")?.authority_error).toContain("exceeds 4194304 bytes");
    writeFileSync(canonicalPath, canonicalBytes);
    const preservedCanonical = join(project, "canonical-opened-preserved.json");
    const raced = readAuthoritativeDockResult(paths, "req-contradict", { afterCanonicalOpen: () => {
      renameSync(canonicalPath, preservedCanonical);
      writeFileSync(canonicalPath, JSON.stringify({ ...canonicalFailure, status: "success" }));
    } });
    expect(raced?.authority_error).toContain("changed during read");
    expect(JSON.parse(readFileSync(canonicalPath, "utf8")).status).toBe("success");
    expect(JSON.parse(readFileSync(preservedCanonical, "utf8")).status).toBe("failed");

    deps.readResult = (stem) => ({ request_id: stem, status: "success", studio_commit: "a".repeat(40) });
    deps.scanRequests = () => [];
    const refused = await integrateOne(item, ctx, deps);
    expect(refused.state).toBe("INTEGRATE_ERROR");
    expect(refused.error).toContain("one exact successful request/result pair");
    deps.scanRequests = () => [{ stem: "req-exact", workbench_branch: item.branch, terminalStatus: "success" }];
    const unverified = await integrateOne(item, ctx, deps);
    expect(unverified.state).toBe("INTEGRATE_ERROR");
    expect(unverified.error).toContain("workbench_branch");
    const frozenSuccess = { request_id: "req-exact", status: "success", studio_commit: "a".repeat(40), workbench_branch: item.branch, workbench_tip: "b".repeat(40) };
    let postScanReads = 0;
    deps.scanRequests = () => [{ stem: "req-exact", workbench_branch: item.branch, terminalStatus: "success", resultSnapshot: frozenSuccess }];
    deps.readResult = () => { postScanReads++; return { ...frozenSuccess, status: "failed" }; };
    deps.isAncestorOfStudio = (ref) => {
      if (ref === item.branch) throw new Error("branch ref was retired");
      return ref === "a".repeat(40);
    };
    const integrated = await integrateOne(item, ctx, deps);
    expect(integrated.state).toBe("INTEGRATED");
    expect(integrated.requestId).toBe("req-exact");
    expect(postScanReads).toBe(0);
    expect(integrated.cleaned).toBeTrue();
    expect(calls.some((call) => call.includes("dispatch_cleanup.ts")
      && call.includes("--request-id req-exact")
      && call.includes(`--checkout ${join(project, "__garelier", "demo", "_crew", "dispatch1", "checkout")}`))).toBeTrue();
    expect(calls.some((call) => call.includes("branch -D"))).toBeFalse();

    deps.runBash = (script, args) => {
      calls.push(`${script} ${args.join(" ")}`);
      return script.endsWith("dispatch_cleanup.ts")
        ? { stdout: "", stderr: "cleanup child timed out", code: 124, timedOut: true, timeoutMs: 120_000 }
        : { stdout: "{}", stderr: "", code: 0 };
    };
    const timedOut = await integrateOne(item, ctx, deps);
    expect(timedOut.state).toBe("INTEGRATED");
    expect(timedOut.cleaned).toContain("failed(timeout=120000ms)");
    expect(timedOut.cleaned).not.toBeTrue();

    const timeout = classifyDockChildOutcome({ status: null, signal: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }, "aftercare", 120_000);
    const signal = classifyDockChildOutcome({ status: null, signal: "SIGTERM" }, "aftercare", 120_000);
    const spawn = classifyDockChildOutcome({ status: null, signal: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) }, "aftercare", 120_000);
    const ordinary = classifyDockChildOutcome({ status: 7, signal: null }, "aftercare", 120_000);
    expect([timeout.outcome, signal.outcome, spawn.outcome, ordinary.outcome]).toEqual(["timeout", "signal", "spawn_failure", "exit"]);
    expect([timeout.code, signal.code, spawn.code, ordinary.code]).toEqual([124, 128, 127, 7]);

    for (const child of [
      { stdout: "", stderr: "terminated", code: 128, outcome: "signal" as const, signal: "SIGTERM" },
      { stdout: "", stderr: "spawn failed", code: 127, outcome: "spawn_failure" as const },
      { stdout: "", stderr: "ordinary exit", code: 7, outcome: "exit" as const },
    ]) {
      deps.runBash = (script) => script.endsWith("dispatch_cleanup.ts") ? child : { stdout: "{}", stderr: "", code: 0 };
      const outcome = await integrateOne(item, ctx, deps);
      expect(outcome.state).toBe("INTEGRATED");
      expect(outcome.cleaned).not.toBeTrue();
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("status: surfaces existing result + active lock", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-dock-"));
  try {
    const base = join(project, "__garelier", "demo", "runtime", "merge_gate");
    mkdirSync(join(base, "results"), { recursive: true });
    mkdirSync(join(base, "locks"), { recursive: true });
    writeFileSync(join(base, "results", "0001.json"), JSON.stringify({ verdict: "PASS" }));
    writeFileSync(join(base, "locks", "active.lock"), JSON.stringify({ pid: 123, request_id: "r1" }));
    const r = await runDock(["status", "--pm-id", "demo"], project);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.results.count).toBe(1);
    expect(s.results.recent).toContain("0001.json");
    expect((s.active as any).request_id).toBe("r1");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("poll: missing config -> graceful exit 1 with a clear message (no crash)", async () => {
  // The happy-path merge spawning is covered by merge_gate.test.ts (pollMergeGate
  // with an injected spawnFn); here we assert dock_merge fails cleanly when the
  // PM config is absent rather than throwing an opaque error.
  const project = mkdtempSync(join(tmpdir(), "garelier-dock-"));
  try {
    const r = await runDock(["poll", "--pm-id", "demo"], project);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot load config");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("bad usage -> exit 2", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-dock-"));
  try {
    const r = await runDock(["frobnicate", "--pm-id", "demo"], project);
    expect(r.code).toBe(2);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
