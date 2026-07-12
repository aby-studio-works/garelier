// W-022 — contract_check.ts: the attended-dispatch completion-contract detector.
// Pins ok / each violation class / nudge synthesis so the detector cannot silently
// stop catching an idle-without-artifact producer or gate.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkProducer,
  checkGate,
  readStateStatus,
  VERDICT_TOKENS,
  stallScan,
  detectBackgroundActivity,
  buildHandoffPrompt,
  applyEscalation,
  loadStallHistory,
  saveStallHistory,
  detectSessionResume,
  loadLastScanMs,
  saveLastScanMs,
  detectWatchCoverage,
  readWatchHeartbeats,
  scanUnprocessedResults,
  scanUnconsumedInstructions,
  parseUnconsumedLedger,
  scanIdleNoRegister,
  isStallCandidate,
  classifyWorkingJudgement,
  registerReceivedMarkerPath,
  type GitRunner,
  type ProcessLister,
  type StallScanItem,
  type StallHistoryMap,
  type WatchHeartbeat,
} from "./contract_check.ts";

// dispatch_prepare.sh report scaffold (verbatim placeholders that mark it unedited).
const SCAFFOLD_REPORT =
  "# Report\n\n## Status\n\n(REPORTING | BLOCKED)\n\n## Summary\n\n(what changed and why - compact; reference paths/SHAs, never paste diffs)\n\n## Gates\n\n(commands run + results)\n\n## Evidence\n\n(red->green proof, measurements, writer-audit conclusions)\n";
const REAL_REPORT =
  "# Report\n\n## Status\n\nREPORTING\n\n## Summary\n\nAdded the contract checker.\n\n## Gates\n\ntsc: pass\n\n## Evidence\n\nred->green shown.\n";

function makeDispatch(opts: {
  status?: string;
  baseSha?: string | null;
  report?: string;
  withCheckout?: boolean;
  withState?: boolean;
}): string {
  const container = mkdtempSync(join(tmpdir(), "garelier-cc-"));
  if (opts.withState !== false) {
    writeFileSync(join(container, "STATE.md"), `# Dispatch\n\n## Status\n\n${opts.status ?? "WORKING"}\n\n## Current task\n\nx\n`);
  }
  if (opts.report !== undefined) writeFileSync(join(container, "report.md"), opts.report);
  if (opts.baseSha !== null) {
    writeFileSync(join(container, "context.json"), JSON.stringify({ task: { base_sha: opts.baseSha ?? "abc1234" } }));
  }
  if (opts.withCheckout !== false) mkdirSync(join(container, "checkout"));
  return container;
}

// Injected git: `count` commits ahead of base.
function gitWith(count: number): GitRunner {
  return () => ({ code: 0, stdout: `${count}\n` });
}

test("producer: satisfied contract -> ok, no nudge", () => {
  const c = makeDispatch({ status: "REPORTING", report: REAL_REPORT });
  try {
    const r = checkProducer(c, gitWith(2));
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
    expect(r.nudge).toBe("");
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test("producer: implemented but not committed -> no_commits violation + nudge", () => {
  const c = makeDispatch({ status: "REPORTING", report: REAL_REPORT });
  try {
    const r = checkProducer(c, gitWith(0));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.check)).toContain("no_commits");
    expect(r.nudge).toContain("commit");
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test("producer: STATE still WORKING -> state_not_reporting violation", () => {
  const c = makeDispatch({ status: "WORKING", report: REAL_REPORT });
  try {
    const r = checkProducer(c, gitWith(3));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.check)).toContain("state_not_reporting");
    expect(r.nudge).toContain("REPORTING");
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test("producer: report left as scaffold -> report_template violation", () => {
  const c = makeDispatch({ status: "REPORTING", report: SCAFFOLD_REPORT });
  try {
    const r = checkProducer(c, gitWith(1));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.check)).toContain("report_template");
    expect(r.nudge).toContain("report.md");
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test("producer: BLOCKED with no commits is acceptable (commit check skipped)", () => {
  const c = makeDispatch({ status: "BLOCKED", report: REAL_REPORT });
  try {
    const r = checkProducer(c, gitWith(0));
    expect(r.ok).toBe(true);
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test("producer: missing report.md -> report_missing violation", () => {
  const c = makeDispatch({ status: "REPORTING" }); // no report written
  try {
    const r = checkProducer(c, gitWith(1));
    expect(r.violations.map((v) => v.check)).toContain("report_missing");
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test("producer: missing container -> container_missing violation, no crash", () => {
  const r = checkProducer(join(tmpdir(), "garelier-cc-does-not-exist-xyz"), gitWith(0));
  expect(r.ok).toBe(false);
  expect(r.violations.map((v) => v.check)).toContain("container_missing");
});

// ── gate mode ────────────────────────────────────────────────────────────────
function makeRuntime(): string {
  return mkdtempSync(join(tmpdir(), "garelier-cc-rt-"));
}
function writeVerdict(runtime: string, role: string, slug: string, body: string): void {
  const dir = join(runtime, role, "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}-${role}.md`), body);
}

test("gate: both roles published a verdict token -> ok", () => {
  const rt = makeRuntime();
  try {
    writeVerdict(rt, "guardian", "w023p1", "## Verdict\n\nPASS_WITH_NOTES\n");
    writeVerdict(rt, "observer", "w023p1", "## Verdict\n\nPASS\n");
    const r = checkGate(rt, "w023p1", ["guardian", "observer"]);
    expect(r.ok).toBe(true);
  } finally { rmSync(rt, { recursive: true, force: true }); }
});

test("gate: verdict report never written -> verdict_missing + nudge", () => {
  const rt = makeRuntime();
  try {
    writeVerdict(rt, "guardian", "w023p1", "## Verdict\n\nPASS\n");
    // observer never published
    const r = checkGate(rt, "w023p1", ["guardian", "observer"]);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.check)).toContain("verdict_missing");
    expect(r.nudge).toContain("observer");
  } finally { rmSync(rt, { recursive: true, force: true }); }
});

test("gate: report present but no Verdict section -> verdict_section_missing", () => {
  const rt = makeRuntime();
  try {
    writeVerdict(rt, "guardian", "w023p1", "## Summary\n\nlooked fine\n");
    const r = checkGate(rt, "w023p1", ["guardian"]);
    expect(r.violations.map((v) => v.check)).toContain("verdict_section_missing");
  } finally { rmSync(rt, { recursive: true, force: true }); }
});

test("gate: Verdict section without canonical token -> verdict_token_missing", () => {
  const rt = makeRuntime();
  try {
    writeVerdict(rt, "guardian", "w023p1", "## Verdict\n\nlooks good to me\n");
    const r = checkGate(rt, "w023p1", ["guardian"]);
    expect(r.violations.map((v) => v.check)).toContain("verdict_token_missing");
  } finally { rmSync(rt, { recursive: true, force: true }); }
});

test("gate: PASS token is not shadowed by the PASS_WITH_NOTES prefix rule", () => {
  const rt = makeRuntime();
  try {
    writeVerdict(rt, "observer", "s", "## Verdict\n\nREWORK_RECOMMENDED\n");
    const r = checkGate(rt, "s", ["observer"]);
    expect(r.ok).toBe(true);
  } finally { rmSync(rt, { recursive: true, force: true }); }
});

// ── parsing unit ──────────────────────────────────────────────────────────────
test("readStateStatus reads first non-blank line under ## Status", () => {
  expect(readStateStatus("## Status\n\nREPORTING\n")).toBe("REPORTING");
  expect(readStateStatus("no heading here")).toBeNull();
});

test("VERDICT_TOKENS covers the canonical set", () => {
  for (const t of ["PASS", "PASS_WITH_NOTES", "REWORK_RECOMMENDED", "BLOCK", "NO_OPINION", "FAIL"]) {
    expect(VERDICT_TOKENS as readonly string[]).toContain(t);
  }
});

// ── stall-scan mode (W-034) ──────────────────────────────────────────────────
// Pins the false-positive/true-stall distinction the design record calls out
// (target-project W-027 2026-07-02 + W-053 2026-07-03: a cold-build idle
// notification was mis-diagnosed as a stall and the producer was needlessly
// respawned).
function makePmRoot(): string {
  return mkdtempSync(join(tmpdir(), "garelier-cc-stall-"));
}
function writeDispatch(
  pmRoot: string,
  id: number,
  opts: { status?: string; baseSha?: string | null; withCheckout?: boolean },
): string {
  const container = join(pmRoot, `_dispatch${id}`);
  mkdirSync(container, { recursive: true });
  writeFileSync(join(container, "STATE.md"), `# Dispatch\n\n## Status\n\n${opts.status ?? "WORKING"}\n\n## Current task\n\nx\n`);
  if (opts.baseSha !== null) {
    writeFileSync(join(container, "context.json"), JSON.stringify({ task: { base_sha: opts.baseSha ?? "abc1234" } }));
  }
  if (opts.withCheckout !== false) mkdirSync(join(container, "checkout"), { recursive: true });
  return container;
}
// git double: commits ahead of base + dirty porcelain output.
function gitStall(commits: number, dirty: boolean, tip = "deadbeefcafe"): GitRunner {
  return (args) => {
    if (args[0] === "rev-list") return { code: 0, stdout: `${commits}\n` };
    if (args[0] === "status") return { code: 0, stdout: dirty ? " M some/file.ts\n" : "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${tip}\n` };
    return { code: 1, stdout: "" };
  };
}
const listerNone: ProcessLister = () => [];
const listerUnknown: ProcessLister = () => null;
const listerHit = (needlePath: string): ProcessLister => () => [`bash -c cd ${needlePath} && cargo build`];

test("stallScan: no pmRoot -> ok true, no items", () => {
  const r = stallScan(join(tmpdir(), "garelier-cc-stall-missing-xyz"), gitStall(0, true), listerNone);
  expect(r.ok).toBe(true);
  expect(r.mode).toBe("stall-scan");
  expect(r.items).toHaveLength(0);
});

test("stallScan: WORKING + commits 0 + dirty + no background activity -> stall-suspect, ok false", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 1, {});
    const r = stallScan(pm, gitStall(0, true), listerNone);
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ dispatch: "1", state: "WORKING", commits: 0, dirty: true, background: "none", judgement: "stall-suspect" });
    expect(r.items[0].suggested_nudge.length).toBeGreaterThan(0);
    expect(r.items[0].suggested_nudge).toContain("stall");
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: WORKING + commits 0 + dirty + a builder process on this checkout -> build-wait, ok true (false-positive avoided)", () => {
  const pm = makePmRoot();
  try {
    const container = writeDispatch(pm, 2, {});
    const checkout = join(container, "checkout");
    const r = stallScan(pm, gitStall(0, true), listerHit(checkout));
    expect(r.ok).toBe(true);
    expect(r.items[0]).toMatchObject({ background: "running", judgement: "build-wait" });
    expect(r.items[0].suggested_nudge).toBe("");
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: process listing unavailable -> unknown, never mis-asserts either way", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 3, {});
    const r = stallScan(pm, gitStall(0, true), listerUnknown);
    expect(r.ok).toBe(true);
    expect(r.items[0]).toMatchObject({ background: "unknown", judgement: "unknown" });
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: commits already present -> not a stall candidate (unknown, no process probe)", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 4, {});
    const r = stallScan(pm, gitStall(2, true), listerNone);
    expect(r.ok).toBe(true);
    expect(r.items[0]).toMatchObject({ commits: 2, judgement: "unknown" });
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: clean checkout (not dirty) -> not a stall candidate", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 5, {});
    const r = stallScan(pm, gitStall(0, false), listerNone);
    expect(r.ok).toBe(true);
    expect(r.items[0]).toMatchObject({ dirty: false, judgement: "unknown" });
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: WORKING + commits>0 + clean tree + no background -> post-commit-stall, ok false (W-045)", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 10, {});
    const r = stallScan(pm, gitStall(4, false, "tip-sha-aaa"), listerNone);
    expect(r.ok).toBe(false);
    expect(r.items[0]).toMatchObject({
      dispatch: "10", state: "WORKING", commits: 4, dirty: false,
      tip_sha: "tip-sha-aaa", background: "none", judgement: "post-commit-stall",
    });
    expect(r.items[0].suggested_nudge).toContain("post-commit");
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: WORKING + commits>0 + clean tree + a builder on this checkout -> build-wait, ok true (W-045)", () => {
  const pm = makePmRoot();
  try {
    const container = writeDispatch(pm, 11, {});
    const r = stallScan(pm, gitStall(4, false), listerHit(join(container, "checkout")));
    expect(r.ok).toBe(true);
    expect(r.items[0]).toMatchObject({ background: "running", judgement: "build-wait" });
    expect(r.items[0].suggested_nudge).toBe("");
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: WORKING + commits>0 + DIRTY tree -> not a candidate (actively editing, not a stall) (W-045)", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 12, {});
    const r = stallScan(pm, gitStall(4, true), listerNone);
    expect(r.ok).toBe(true);
    expect(r.items[0]).toMatchObject({ commits: 4, dirty: true, judgement: "unknown" });
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: BLOCKED/IDLE out of scope, but ungated REPORTING is now IN scope (W-071/W-086)", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 6, { status: "REPORTING" }); // ungated (no gate result) -> in scope
    writeDispatch(pm, 7, { status: "BLOCKED" });    // out of scope
    const r = stallScan(pm, gitStall(0, true), listerNone);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ dispatch: "6", state: "REPORTING", judgement: "ungated-reporting" });
    expect(r.items[0].suggested_nudge).toContain("gate");
    expect(r.ok).toBe(false); // an ungated REPORTING needs action (gate it)
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: a GATED REPORTING is excluded — it is in the merge pipeline (W-071)", () => {
  const pm = makePmRoot();
  try {
    const container = join(pm, "_dispatch8");
    mkdirSync(join(container, "checkout"), { recursive: true });
    writeFileSync(join(container, "STATE.md"), "# D\n\n## Status\n\nREPORTING\n\n## Current task\n\n#8 feat-x (br)\n");
    writeFileSync(join(container, "context.json"), JSON.stringify({ task: { base_sha: "abc1234", slug: "feat-x" } }));
    mkdirSync(join(pm, "runtime", "guardian", "results"), { recursive: true });
    writeFileSync(join(pm, "runtime", "guardian", "results", "feat-x-guardian.md"), "## Verdict\n\nPASS\n");
    const r = stallScan(pm, gitStall(0, true), listerNone);
    expect(r.items).toHaveLength(0);
    expect(r.ok).toBe(true);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: multiple WORKING dispatches are judged independently (per-checkout scoping)", () => {
  const pm = makePmRoot();
  try {
    const c1 = writeDispatch(pm, 8, {});
    writeDispatch(pm, 9, {});
    // Only dispatch #8's checkout has a matching builder process; #9 has none —
    // a global (unscoped) probe would have wrongly cleared BOTH.
    const r = stallScan(pm, gitStall(0, true), listerHit(join(c1, "checkout")));
    expect(r.ok).toBe(false); // #9 still stall-suspect
    const byId = Object.fromEntries(r.items.map((i) => [i.dispatch, i]));
    expect(byId["8"].judgement).toBe("build-wait");
    expect(byId["9"].judgement).toBe("stall-suspect");
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("detectBackgroundActivity: matches a builder keyword AND the checkout path", () => {
  expect(detectBackgroundActivity("/x/y/checkout", () => ["bash -c cd /x/y/checkout && cargo build"])).toBe("running");
  // builder keyword present, but for a DIFFERENT checkout -> no match.
  expect(detectBackgroundActivity("/x/y/checkout", () => ["cargo build --manifest-path /other/path"])).toBe("none");
  // this checkout is busy, but with a non-builder process -> no match.
  expect(detectBackgroundActivity("/x/y/checkout", () => ["some-random-daemon --watch /x/y/checkout"])).toBe("none");
  expect(detectBackgroundActivity("/x/y/checkout", () => null)).toBe("unknown");
});

// ── watch coverage / UNWATCHED (W-085) ───────────────────────────────────────
// Pins the detective side of the preventive watch_cmd: a WORKING dispatch with no
// live dispatch_watch heartbeat is UNWATCHED, but that never flips `ok` (advisory).
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;
const fresh = (over: Partial<WatchHeartbeat> = {}): WatchHeartbeat => ({ ts_epoch: NOW_SEC, ...over });

test("detectWatchCoverage: fresh single heartbeat matching the id -> watched", () => {
  const hb = [fresh({ mode: "single", id: "7", branch: "br-x" })];
  expect(detectWatchCoverage(hb, "7", "br-x", NOW_MS, 60 * 60_000)).toBe("watched");
  // a different id but the SAME branch also matches (single --branch invocation).
  expect(detectWatchCoverage([fresh({ mode: "single", id: "", branch: "br-x" })], "7", "br-x", NOW_MS, 60 * 60_000)).toBe("watched");
});

test("detectWatchCoverage: a fresh FLEET heartbeat covers every working dispatch", () => {
  const hb = [fresh({ mode: "fleet", active_ids: "1 2" })];
  expect(detectWatchCoverage(hb, "9", "br-other", NOW_MS, 60 * 60_000)).toBe("watched");
});

test("detectWatchCoverage: no heartbeats / non-matching / stale -> unwatched", () => {
  expect(detectWatchCoverage([], "7", "br-x", NOW_MS, 60 * 60_000)).toBe("unwatched");
  // matches neither id nor branch.
  expect(detectWatchCoverage([fresh({ mode: "single", id: "8", branch: "br-y" })], "7", "br-x", NOW_MS, 60 * 60_000)).toBe("unwatched");
  // right id, but the marker is older than the stale window (watch died / not re-armed).
  const stale = [{ mode: "single", id: "7", branch: "br-x", ts_epoch: NOW_SEC - 2 * 3600 }];
  expect(detectWatchCoverage(stale, "7", "br-x", NOW_MS, 60 * 60_000)).toBe("unwatched");
  // a marker with no ts_epoch is unreadable -> skipped -> unwatched.
  expect(detectWatchCoverage([{ mode: "fleet" }], "7", "br-x", NOW_MS, 60 * 60_000)).toBe("unwatched");
});

test("readWatchHeartbeats: missing dir -> [], reads valid, skips corrupt", () => {
  const pm = makePmRoot();
  try {
    expect(readWatchHeartbeats(pm)).toEqual([]); // dir absent
    const dir = join(pm, "runtime", "dispatch", "watch", "heartbeats");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fleet-1.json"), JSON.stringify({ mode: "fleet", ts_epoch: 123 }));
    writeFileSync(join(dir, "bad.json"), "{not json");
    writeFileSync(join(dir, "ignore.txt"), "not a heartbeat");
    const hb = readWatchHeartbeats(pm);
    expect(hb).toHaveLength(1);
    expect(hb[0]).toMatchObject({ mode: "fleet", ts_epoch: 123 });
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: WORKING dispatch with a fresh single heartbeat for its id -> watch watched, not in unwatched", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 1, {});
    const hb = [fresh({ mode: "single", id: "1", branch: null })];
    const r = stallScan(pm, gitStall(0, true), listerNone, { nowMs: NOW_MS, heartbeats: hb });
    expect(r.items[0].watch).toBe("watched");
    expect(r.unwatched).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: WORKING dispatch with no heartbeat -> UNWATCHED, but `ok` is unaffected (advisory)", () => {
  const pm = makePmRoot();
  try {
    const container = writeDispatch(pm, 2, {});
    // build-wait (a live builder) so the STALL judgement keeps ok=true; the point is
    // that UNWATCHED does NOT flip ok on its own.
    const r = stallScan(pm, gitStall(0, true), listerHit(join(container, "checkout")), { nowMs: NOW_MS, heartbeats: [] });
    expect(r.items[0].judgement).toBe("build-wait");
    expect(r.items[0].watch).toBe("unwatched");
    expect(r.unwatched).toEqual(["2"]);
    expect(r.ok).toBe(true); // advisory: UNWATCHED alone never flips ok
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: unwatched_detail carries a ready dispatch_watch.sh watch_cmd for each unwatched id (W-033)", () => {
  const pm = makePmRoot();
  try {
    const container = writeDispatch(pm, 2, {});
    const r = stallScan(pm, gitStall(0, true), listerHit(join(container, "checkout")), { nowMs: NOW_MS, heartbeats: [] });
    expect(r.unwatched).toEqual(["2"]);
    expect(r.unwatched_detail).toHaveLength(1);
    expect(r.unwatched_detail[0].dispatch).toBe("2");
    expect(r.unwatched_detail[0].watch_cmd).toContain("dispatch_watch.sh");
    expect(r.unwatched_detail[0].watch_cmd).toContain("--pm-id");
    expect(r.unwatched_detail[0].watch_cmd).toContain("--id 2");
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: a fresh fleet heartbeat clears UNWATCHED for every working dispatch", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 3, {});
    writeDispatch(pm, 4, {});
    const r = stallScan(pm, gitStall(0, true), listerNone, { nowMs: NOW_MS, heartbeats: [fresh({ mode: "fleet" })] });
    expect(r.unwatched).toEqual([]);
    expect(r.items.every((i) => i.watch === "watched")).toBe(true);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("stallScan: an ungated REPORTING is DONE — never flagged UNWATCHED even with no heartbeat (W-085)", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 5, { status: "REPORTING" });
    const r = stallScan(pm, gitStall(0, true), listerNone, { nowMs: NOW_MS, heartbeats: [] });
    expect(r.items[0].judgement).toBe("ungated-reporting");
    expect(r.items[0].watch).toBe("watched"); // gate it, don't watch it
    expect(r.unwatched).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

// ── unprocessed merge result / UNPROCESSED-RESULT (W-086) ─────────────────────
// A landed (success) merge whose workbench branch was never cleaned up. The scan
// maps result -> branch via the archived request, then checks branch existence.
// Result mtime is pinned to NOW_MS so the --unprocessed-window-hours boundary is
// deterministic (no reliance on the real wall clock).
function writeMergeResult(
  pmRoot: string,
  requestId: string,
  opts: { status?: string; studioCommit?: string | null; branch?: string | null; targetRoot?: string | null; withArchive?: boolean },
): string {
  const resultsDir = join(pmRoot, "runtime", "merge_gate", "results");
  const archiveDir = join(pmRoot, "runtime", "merge_gate", "archive");
  mkdirSync(resultsDir, { recursive: true });
  const resultPath = join(resultsDir, `${requestId}.json`);
  writeFileSync(resultPath, JSON.stringify({ request_id: requestId, status: opts.status ?? "success", studio_commit: opts.studioCommit ?? "studioabc" }));
  utimesSync(resultPath, new Date(NOW_MS), new Date(NOW_MS));
  if (opts.withArchive !== false) {
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, `${requestId}.request.json`), JSON.stringify({ request_id: requestId, workbench_branch: opts.branch ?? "br/default", target_root: opts.targetRoot ?? "/proj" }));
  }
  return resultPath;
}
// git double: reports `git show-ref --verify refs/heads/<b>` exit 0 iff <b> ∈ existing.
function gitBranches(existing: string[]): GitRunner {
  return (args) => {
    if (args[0] === "show-ref" && args.includes("--verify")) {
      const branch = (args[args.length - 1] ?? "").replace(/^refs\/heads\//, "");
      return { code: existing.includes(branch) ? 0 : 1, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
}

test("scanUnprocessedResults: success result whose workbench branch still exists -> reported (W-086)", () => {
  const pm = makePmRoot();
  try {
    writeMergeResult(pm, "20260706-1-taskA", { branch: "br/a" });
    const r = scanUnprocessedResults(pm, gitBranches(["br/a"]), { nowMs: NOW_MS });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ request_id: "20260706-1-taskA", workbench_branch: "br/a", studio_commit: "studioabc" });
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanUnprocessedResults: cleanup_cmd is a ready dispatch_cleanup.sh --delete-branch one-liner (W-033)", () => {
  const pm = makePmRoot();
  try {
    writeMergeResult(pm, "20260706-1-taskA", { branch: "garelier/main/tpm/workbench/#42/taskA", targetRoot: "/fake/target" });
    const r = scanUnprocessedResults(pm, gitBranches(["garelier/main/tpm/workbench/#42/taskA"]), { nowMs: NOW_MS });
    expect(r).toHaveLength(1);
    expect(r[0].cleanup_cmd).toContain("dispatch_cleanup.sh");
    expect(r[0].cleanup_cmd).toContain("--id 42");
    expect(r[0].cleanup_cmd).toContain("--delete-branch");
    expect(r[0].cleanup_cmd).toContain('--target-root "/fake/target"');
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanUnprocessedResults: branch already deleted (cleanup ran) -> not reported (W-086)", () => {
  const pm = makePmRoot();
  try {
    writeMergeResult(pm, "r1", { branch: "br/gone" });
    expect(scanUnprocessedResults(pm, gitBranches([]), { nowMs: NOW_MS })).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanUnprocessedResults: a failed/conflict result is never reported (only landed merges) (W-086)", () => {
  const pm = makePmRoot();
  try {
    writeMergeResult(pm, "r1", { status: "conflict", branch: "br/a" });
    expect(scanUnprocessedResults(pm, gitBranches(["br/a"]), { nowMs: NOW_MS })).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanUnprocessedResults: no archived request (cannot map result->branch) -> skipped (W-086)", () => {
  const pm = makePmRoot();
  try {
    writeMergeResult(pm, "r1", { branch: "br/a", withArchive: false });
    expect(scanUnprocessedResults(pm, gitBranches(["br/a"]), { nowMs: NOW_MS })).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanUnprocessedResults: the .summary.json sibling is not double-counted (W-086)", () => {
  const pm = makePmRoot();
  try {
    writeMergeResult(pm, "r1", { branch: "br/a" });
    writeFileSync(join(pm, "runtime", "merge_gate", "results", "r1.summary.json"), JSON.stringify({ status: "success", request_id: "r1" }));
    expect(scanUnprocessedResults(pm, gitBranches(["br/a"]), { nowMs: NOW_MS })).toHaveLength(1);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanUnprocessedResults: a result resolved outside the window is skipped (W-086)", () => {
  const pm = makePmRoot();
  try {
    const resultPath = writeMergeResult(pm, "r1", { branch: "br/a" });
    const old = new Date(NOW_MS - 48 * 3_600_000); // 48h ago, outside the 24h window
    utimesSync(resultPath, old, old);
    expect(scanUnprocessedResults(pm, gitBranches(["br/a"]), { nowMs: NOW_MS, windowHours: 24 })).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanUnprocessedResults: missing merge_gate dir -> [] (no crash) (W-086)", () => {
  expect(scanUnprocessedResults(join(tmpdir(), "garelier-cc-nomg-xyz"), gitBranches([]), { nowMs: NOW_MS })).toEqual([]);
});

// ── unconsumed instructions / UNCONSUMED-INSTRUCTIONS (W-092) ─────────────────
// A REPORTING dispatch whose instruction ledger still has an unchecked `- [ ]`
// entry dropped a mid-flight PM instruction. Only REPORTING is flagged (a WORKING
// dispatch is still working through them). Advisory — never flips ok.
const LEDGER_HEADER = "# Instruction ledger - #1 slug\n\n<!-- convention -->\n\n";
function writeLedgerDispatch(pmRoot: string, id: number, opts: { status: string; ledger?: string }): void {
  const container = join(pmRoot, `_dispatch${id}`);
  mkdirSync(container, { recursive: true });
  writeFileSync(join(container, "STATE.md"), `# D\n\n## Status\n\n${opts.status}\n\n## Current task\n\nx\n`);
  if (opts.ledger !== undefined) writeFileSync(join(container, "instructions.md"), opts.ledger);
}

test("parseUnconsumedLedger: `- [ ]` / `* [ ]` are open; `- [x]` and prose are not (W-092)", () => {
  const open = parseUnconsumedLedger(LEDGER_HEADER + "- [ ] I1 add validation\n* [ ] I2 also docs\n- [x] I3 done (consumed: abc)\nsome prose\n");
  expect(open).toHaveLength(2);
  expect(open[0]).toContain("I1");
  expect(open[1]).toContain("I2");
});

test("scanUnconsumedInstructions: REPORTING dispatch with an open entry -> reported (W-092)", () => {
  const pm = makePmRoot();
  try {
    writeLedgerDispatch(pm, 1, { status: "REPORTING", ledger: LEDGER_HEADER + "- [ ] I1 add the flag\n" });
    const r = scanUnconsumedInstructions(pm);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ dispatch: "1" });
    expect(r[0].unconsumed[0]).toContain("I1");
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanUnconsumedInstructions: all entries checked -> not reported (W-092)", () => {
  const pm = makePmRoot();
  try {
    writeLedgerDispatch(pm, 1, { status: "REPORTING", ledger: LEDGER_HEADER + "- [x] I1 done (consumed: sha)\n" });
    expect(scanUnconsumedInstructions(pm)).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanUnconsumedInstructions: a WORKING dispatch with open entries is not flagged (still working) (W-092)", () => {
  const pm = makePmRoot();
  try {
    writeLedgerDispatch(pm, 1, { status: "WORKING", ledger: LEDGER_HEADER + "- [ ] I1 pending\n" });
    expect(scanUnconsumedInstructions(pm)).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanUnconsumedInstructions: no ledger / empty ledger -> not reported; missing pmRoot -> [] (W-092)", () => {
  const pm = makePmRoot();
  try {
    writeLedgerDispatch(pm, 1, { status: "REPORTING" }); // no instructions.md
    writeLedgerDispatch(pm, 2, { status: "REPORTING", ledger: LEDGER_HEADER + "(no instructions yet)\n" });
    expect(scanUnconsumedInstructions(pm)).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
  expect(scanUnconsumedInstructions(join(tmpdir(), "garelier-cc-noledger-xyz"))).toEqual([]);
});

// ── idle-without-register / IDLE-NO-REGISTER (W-018) ──────────────────────────
// A dispatched role that went idle with no processed register needs a WAKE, not a
// respawn. REPORTING (done-but-unregistered) is flagged directly; WORKING only when
// it is a GENUINE idle stall — a live build (build-wait) is NEVER woken (the W-053
// false-wake lesson). The register_received marker is the single suppressor.
function writeIdleDispatch(
  pmRoot: string,
  id: number,
  opts: {
    status: string;
    role?: string | null;
    slug?: string | null;
    withMarker?: boolean;
    gateAgents?: Record<string, { name: string }>;
    withCheckout?: boolean;
    baseSha?: string | null;
  },
): string {
  const container = join(pmRoot, `_dispatch${id}`);
  mkdirSync(container, { recursive: true });
  writeFileSync(join(container, "STATE.md"), `# D\n\n## Status\n\n${opts.status}\n\n## Current task\n\n#${id} ${opts.slug ?? "x"} (br)\n`);
  const ctx: Record<string, unknown> = {
    task: { base_sha: opts.baseSha ?? "abc1234", role: opts.role ?? null, slug: opts.slug ?? null },
  };
  if (opts.gateAgents) ctx.gate_agents = opts.gateAgents;
  writeFileSync(join(container, "context.json"), JSON.stringify(ctx));
  if (opts.withCheckout !== false) mkdirSync(join(container, "checkout"), { recursive: true });
  if (opts.withMarker) writeFileSync(registerReceivedMarkerPath(container), "");
  return container;
}

test("isStallCandidate / classifyWorkingJudgement: pre/post-commit shapes + build-wait/unknown never assert a stall (W-018)", () => {
  expect(isStallCandidate(0, true)).toBe(true);   // pre-commit
  expect(isStallCandidate(3, false)).toBe(true);  // post-commit
  expect(isStallCandidate(3, true)).toBe(false);  // committed + still editing
  expect(isStallCandidate(0, false)).toBe(false); // nothing done, clean
  expect(classifyWorkingJudgement(0, true, "none")).toBe("stall-suspect");
  expect(classifyWorkingJudgement(3, false, "none")).toBe("post-commit-stall");
  expect(classifyWorkingJudgement(0, true, "running")).toBe("build-wait");
  expect(classifyWorkingJudgement(0, true, "unknown")).toBe("unknown");
  expect(classifyWorkingJudgement(3, true, "none")).toBe("unknown"); // not a candidate
});

test("scanIdleNoRegister: REPORTING with no register_received marker -> advisory + wake_cmd (W-018)", () => {
  const pm = makePmRoot();
  try {
    writeIdleDispatch(pm, 1, { status: "REPORTING", role: "worker", slug: "feat-x" });
    const r = scanIdleNoRegister(pm, gitStall(2, false), listerNone);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ dispatch: "1", state: "REPORTING", role: "worker", kind: "reporting-no-register" });
    expect(r[0].wake_cmd.to).toBe("ga-worker-feat-x"); // derived from task.role + task.slug
    expect(r[0].wake_cmd.message).toContain("register");
    expect(r[0].wake_cmd.message).toContain("#1");
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanIdleNoRegister: register_received marker present -> not flagged (W-018)", () => {
  const pm = makePmRoot();
  try {
    writeIdleDispatch(pm, 2, { status: "REPORTING", role: "worker", slug: "feat-y", withMarker: true });
    expect(scanIdleNoRegister(pm, gitStall(2, false), listerNone)).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanIdleNoRegister: WORKING stall-suspect (no live build) -> working-stalled (W-018)", () => {
  const pm = makePmRoot();
  try {
    writeIdleDispatch(pm, 3, { status: "WORKING", role: "worker", slug: "feat-z" });
    const r = scanIdleNoRegister(pm, gitStall(0, true), listerNone);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ dispatch: "3", state: "WORKING", kind: "working-stalled" });
    expect(r[0].wake_cmd.message).toContain("BLOCKED");
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanIdleNoRegister: WORKING with a LIVE build (build-wait) is NEVER woken (false-wake suppression, W-018/W-053)", () => {
  const pm = makePmRoot();
  try {
    const container = writeIdleDispatch(pm, 4, { status: "WORKING", role: "worker", slug: "feat-b" });
    // A builder process is live on this checkout -> build-wait -> must not be flagged.
    expect(scanIdleNoRegister(pm, gitStall(0, true), listerHit(join(container, "checkout")))).toEqual([]);
    // An unprobeable process table -> unknown -> also never woken.
    expect(scanIdleNoRegister(pm, gitStall(0, true), listerUnknown)).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanIdleNoRegister: a gate role (observer) REPORTING with no verdict -> gate-no-verdict, wake targets the gate agent (W-018)", () => {
  const pm = makePmRoot();
  try {
    writeIdleDispatch(pm, 5, {
      status: "REPORTING", role: "observer", slug: "feat-g",
      gateAgents: { guardian: { name: "ga-guardian-feat-g" }, observer: { name: "ga-observer-feat-g" } },
    });
    const r = scanIdleNoRegister(pm, gitStall(0, false), listerNone);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ dispatch: "5", state: "REPORTING", role: "observer", kind: "gate-no-verdict" });
    expect(r[0].wake_cmd.to).toBe("ga-observer-feat-g"); // from context.json gate_agents
    expect(r[0].wake_cmd.message).toContain("verdict");
  } finally { rmSync(pm, { recursive: true, force: true }); }
});

test("scanIdleNoRegister: BLOCKED / non-idle states and missing pmRoot -> not flagged (W-018)", () => {
  const pm = makePmRoot();
  try {
    writeIdleDispatch(pm, 6, { status: "BLOCKED", role: "worker", slug: "feat-c" });
    writeIdleDispatch(pm, 7, { status: "WORKING", role: "worker", slug: "feat-d" }); // clean + no commit -> not a candidate
    const r = scanIdleNoRegister(pm, gitStall(0, false), listerNone);
    expect(r).toEqual([]);
  } finally { rmSync(pm, { recursive: true, force: true }); }
  expect(scanIdleNoRegister(join(tmpdir(), "garelier-cc-noidle-xyz"), gitStall(0, true), listerNone)).toEqual([]);
});

test("buildHandoffPrompt: preserves partial work + includes termination notice and resume prompt", () => {
  const item: StallScanItem = { dispatch: "42", state: "WORKING", commits: 0, dirty: true, dirty_hash: "h1", tip_sha: null, background: "none", judgement: "stall-suspect", watch: "watched", suggested_nudge: "x", escalation: "none", escalation_elapsed_min: null, escalation_prompt: "" };
  const prompt = buildHandoffPrompt(item, "/proj/__garelier/pm/_dispatch42");
  expect(prompt).toContain("dispatch #42");
  expect(prompt).toContain("RESUME in the EXISTING worktree");
  expect(prompt).toContain("do NOT run dispatch_prepare again");
  expect(prompt).not.toContain("NOTE: this dispatch was NOT classified");
});

test("buildHandoffPrompt: warns when generated for a non-stall-suspect item", () => {
  const item: StallScanItem = { dispatch: "5", state: "WORKING", commits: 0, dirty: true, dirty_hash: "h2", tip_sha: null, background: "unknown", judgement: "unknown", watch: "watched", suggested_nudge: "", escalation: "none", escalation_elapsed_min: null, escalation_prompt: "" };
  const prompt = buildHandoffPrompt(item, "/proj/__garelier/pm/_dispatch5");
  expect(prompt).toContain("NOTE: this dispatch was NOT classified as a stall");
});

// ── escalation (W-037) ─────────────────────────────────────────────────────────
// Pins the N/M minute boundaries via injected nowMs (never a real wall-clock
// wait) and the two reset conditions the design calls out: judgement moving
// away from stall-suspect, and the dirty diff moving (real progress) even
// while judgement stays stall-suspect.
function stallItem(dispatch: string, dirtyHash: string, judgement: StallScanItem["judgement"] = "stall-suspect"): StallScanItem {
  return {
    dispatch, state: "WORKING", commits: 0, dirty: true, dirty_hash: dirtyHash, tip_sha: null,
    background: judgement === "stall-suspect" ? "none" : "unknown", judgement, watch: "watched",
    suggested_nudge: judgement === "stall-suspect" ? `dispatch #${dispatch} stall nudge` : "",
    escalation: "none", escalation_elapsed_min: null, escalation_prompt: "",
  };
}
// W-045: a post-commit-stall item — committed work, clean tree, keyed on tip sha.
function postCommitItem(dispatch: string, tipSha: string): StallScanItem {
  return {
    dispatch, state: "WORKING", commits: 3, dirty: false, dirty_hash: "clean", tip_sha: tipSha,
    background: "none", judgement: "post-commit-stall", watch: "watched",
    suggested_nudge: `dispatch #${dispatch} post-commit nudge`,
    escalation: "none", escalation_elapsed_min: null, escalation_prompt: "",
  };
}
const containerOf = (id: string) => `/proj/__garelier/pm/_dispatch${id}`;
const ESC_OPTS = { nudgeAfterMin: 10, handoffAfterMin: 25, reviveAfterMin: 30 };

test("applyEscalation: fresh stall-suspect (no prior history) -> escalation none, history seeded at now", () => {
  const now = 1_000_000;
  const { items, history } = applyEscalation([stallItem("1", "h1")], {}, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("none");
  expect(items[0].escalation_elapsed_min).toBe(0);
  expect(history["1"]).toMatchObject({ judgement: "stall-suspect", dirty_hash: "h1", since_ms: now, last_seen_ms: now });
});

test("applyEscalation: just under nudgeAfterMin -> still none", () => {
  const history: StallHistoryMap = { "2": { judgement: "stall-suspect", dirty_hash: "h2", since_ms: 0, last_seen_ms: 0 } };
  const now = 10 * 60_000 - 1;
  const { items } = applyEscalation([stallItem("2", "h2")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("none");
});

test("applyEscalation: continued same judgement+hash for exactly nudgeAfterMin -> escalation nudge", () => {
  const history: StallHistoryMap = { "3": { judgement: "stall-suspect", dirty_hash: "h3", since_ms: 0, last_seen_ms: 0 } };
  const now = 10 * 60_000;
  const { items } = applyEscalation([stallItem("3", "h3")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("nudge");
  expect(items[0].escalation_prompt).toContain("escalation: nudge");
  expect(items[0].escalation_prompt).toContain("dispatch #3");
});

test("applyEscalation: just under handoffAfterMin -> still nudge, not handoff", () => {
  const history: StallHistoryMap = { "4": { judgement: "stall-suspect", dirty_hash: "h4", since_ms: 0, last_seen_ms: 0 } };
  const now = 25 * 60_000 - 1;
  const { items } = applyEscalation([stallItem("4", "h4")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("nudge");
});

test("applyEscalation: continued for exactly handoffAfterMin -> escalation handoff, respawn-handoff prompt content", () => {
  const history: StallHistoryMap = { "5": { judgement: "stall-suspect", dirty_hash: "h5", since_ms: 0, last_seen_ms: 0 } };
  const now = 25 * 60_000;
  const { items } = applyEscalation([stallItem("5", "h5")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("handoff");
  expect(items[0].escalation_prompt).toContain("escalation: handoff");
  expect(items[0].escalation_prompt).toContain("RESUME in the EXISTING worktree");
  expect(items[0].escalation_prompt).toContain("do NOT run dispatch_prepare again");
});

test("applyEscalation: dirty_hash moved (real progress) -> clock resets even though judgement is still stall-suspect", () => {
  const history: StallHistoryMap = { "6": { judgement: "stall-suspect", dirty_hash: "h6-old", since_ms: 0, last_seen_ms: 0 } };
  const now = 30 * 60_000; // would be well past both thresholds if continuity held
  const { items, history: next } = applyEscalation([stallItem("6", "h6-new")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("none");
  expect(next["6"]).toMatchObject({ dirty_hash: "h6-new", since_ms: now });
});

test("applyEscalation: judgement moved away from stall-suspect -> history reset (record removed, no escalation)", () => {
  const history: StallHistoryMap = { "7": { judgement: "stall-suspect", dirty_hash: "h7", since_ms: 0, last_seen_ms: 0 } };
  const now = 999_999;
  const { items, history: next } = applyEscalation([stallItem("7", "h7", "build-wait")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("none");
  expect(items[0].escalation_prompt).toBe("");
  expect(next["7"]).toBeUndefined();
});

test("applyEscalation: a dispatch that drops out of the scan entirely leaves no history behind (rebuilt fresh each call)", () => {
  const history: StallHistoryMap = { "8": { judgement: "stall-suspect", dirty_hash: "h8", since_ms: 0, last_seen_ms: 0 } };
  const { history: next } = applyEscalation([], history, { ...ESC_OPTS, nowMs: 1 }, containerOf);
  expect(next).toEqual({});
});

// ── post-commit-stall escalation (W-045) ────────────────────────────────────
// Same clock/thresholds as stall-suspect, but continuity is keyed on the commit
// TIP (the tree is clean, so dirty_hash never moves), and the handoff prompt
// speaks to committed-but-unreported work rather than an uncommitted diff.

test("applyEscalation: post-commit-stall continued same tip for handoffAfterMin -> handoff, committed-work prompt (W-045)", () => {
  const history: StallHistoryMap = { "20": { judgement: "post-commit-stall", tip_sha: "tipA", dirty_hash: "clean", since_ms: 0, last_seen_ms: 0 } };
  const now = 25 * 60_000;
  const { items } = applyEscalation([postCommitItem("20", "tipA")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("handoff");
  expect(items[0].escalation_prompt).toContain("post-commit-stall");
  expect(items[0].escalation_prompt).toContain("committed its work but went idle before closing out");
  expect(items[0].escalation_prompt).toContain("RESUME in the EXISTING worktree");
});

test("applyEscalation: post-commit-stall new commit tip (progress) -> clock resets even though judgement unchanged (W-045)", () => {
  const history: StallHistoryMap = { "21": { judgement: "post-commit-stall", tip_sha: "tipOld", dirty_hash: "clean", since_ms: 0, last_seen_ms: 0 } };
  const now = 40 * 60_000; // past both thresholds if continuity had held
  const { items, history: next } = applyEscalation([postCommitItem("21", "tipNew")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("none");
  expect(next["21"]).toMatchObject({ judgement: "post-commit-stall", tip_sha: "tipNew", since_ms: now });
});

test("applyEscalation: switching stall-suspect <-> post-commit-stall restarts the clock (different judgement) (W-045)", () => {
  const history: StallHistoryMap = { "22": { judgement: "stall-suspect", dirty_hash: "hX", tip_sha: null, since_ms: 0, last_seen_ms: 0 } };
  const now = 40 * 60_000;
  const { items, history: next } = applyEscalation([postCommitItem("22", "tipZ")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("none"); // judgement changed -> not continued
  expect(next["22"]).toMatchObject({ judgement: "post-commit-stall", since_ms: now });
});

// ── revive escalation (W-071) ────────────────────────────────────────────────
// The top level above handoff: a sustained dormancy escalates to a LOUD
// REVIVE-NEEDED respawn directive (not a wake) once elapsed >= reviveAfterMin.

test("applyEscalation: just under reviveAfterMin -> still handoff, not revive (W-071)", () => {
  const history: StallHistoryMap = { "31": { judgement: "stall-suspect", dirty_hash: "h31", since_ms: 0, last_seen_ms: 0 } };
  const now = 30 * 60_000 - 1;
  const { items } = applyEscalation([stallItem("31", "h31")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("handoff");
});

test("applyEscalation: continued same judgement+hash for reviveAfterMin -> escalation revive, LOUD respawn prompt (W-071)", () => {
  const history: StallHistoryMap = { "30": { judgement: "stall-suspect", dirty_hash: "h30", since_ms: 0, last_seen_ms: 0 } };
  const now = 30 * 60_000;
  const { items } = applyEscalation([stallItem("30", "h30")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("revive");
  expect(items[0].escalation_prompt).toContain("REVIVE-NEEDED");
  expect(items[0].escalation_prompt).toContain("FRESH respawn");
  expect(items[0].escalation_prompt).toContain("RESUME in the EXISTING worktree");
});

test("applyEscalation: post-commit-stall also escalates to revive at reviveAfterMin (W-071)", () => {
  const history: StallHistoryMap = { "32": { judgement: "post-commit-stall", tip_sha: "tipA", dirty_hash: "clean", since_ms: 0, last_seen_ms: 0 } };
  const now = 35 * 60_000;
  const { items } = applyEscalation([postCommitItem("32", "tipA")], history, { ...ESC_OPTS, nowMs: now }, containerOf);
  expect(items[0].escalation).toBe("revive");
  expect(items[0].escalation_prompt).toContain("REVIVE-NEEDED");
});

// ── session-resume detection (W-071) ─────────────────────────────────────────
// A wall-clock gap since the previous scan means the fleet went unwatched (an
// attended session pause) and any in-process teammate is gone — respawn, not wake.

test("detectSessionResume: no prior scan -> null (nothing to compare)", () => {
  expect(detectSessionResume(null, 1_000_000, 2 * 3_600_000)).toBeNull();
});

test("detectSessionResume: gap under threshold -> null", () => {
  const now = 100 * 3_600_000;
  expect(detectSessionResume(now - 1 * 3_600_000, now, 2 * 3_600_000)).toBeNull();
});

test("detectSessionResume: gap >= threshold -> SESSION-RESUME banner with respawn directive (W-071)", () => {
  const now = 100 * 3_600_000;
  const info = detectSessionResume(now - 3 * 3_600_000, now, 2 * 3_600_000);
  expect(info).not.toBeNull();
  expect(info!.gap_hours).toBe(3);
  expect(info!.message).toContain("SESSION-RESUME");
  expect(info!.message).toContain("respawn");
});

test("loadLastScanMs / saveLastScanMs: round-trip via a nested temp path; missing -> null", () => {
  const dir = mkdtempSync(join(tmpdir(), "garelier-cc-ls-"));
  try {
    const path = join(dir, "nested", "last_scan.json");
    expect(loadLastScanMs(path)).toBeNull();
    saveLastScanMs(path, 1_700_000_000_000);
    expect(loadLastScanMs(path)).toBe(1_700_000_000_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadLastScanMs: corrupt JSON -> null (no crash)", () => {
  const dir = mkdtempSync(join(tmpdir(), "garelier-cc-ls-"));
  try {
    const path = join(dir, "last_scan.json");
    writeFileSync(path, "{not json");
    expect(loadLastScanMs(path)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadStallHistory / saveStallHistory: round-trip via a nested temp path; missing file -> {}", () => {
  const dir = mkdtempSync(join(tmpdir(), "garelier-cc-hist-"));
  try {
    const path = join(dir, "nested", "stall_scan_history.json");
    expect(loadStallHistory(path)).toEqual({});
    const history: StallHistoryMap = { "1": { judgement: "stall-suspect", dirty_hash: "abc", since_ms: 1, last_seen_ms: 2 } };
    saveStallHistory(path, history);
    expect(loadStallHistory(path)).toEqual(history);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadStallHistory: corrupt JSON -> {} (no crash)", () => {
  const dir = mkdtempSync(join(tmpdir(), "garelier-cc-hist-"));
  try {
    const path = join(dir, "stall_scan_history.json");
    writeFileSync(path, "{not json");
    expect(loadStallHistory(path)).toEqual({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── CLI smoke (exit codes, matches dock_status.test.ts subprocess pattern) ─────
const here = import.meta.dir;
async function runCli(args: string[]) {
  const p = Bun.spawn(["bun", "run", join(here, "contract_check.ts"), ...args], {
    cwd: here, stdout: "pipe", stderr: "pipe",
  });
  return { out: await new Response(p.stdout).text(), code: await p.exited };
}

test("CLI: --pm-id missing -> usage exit 2", async () => {
  const r = await runCli(["--dispatch", "1"]);
  expect(r.code).toBe(2);
});

test("CLI: neither/both of --dispatch/--gate -> usage exit 2", async () => {
  expect((await runCli(["--pm-id", "demo"])).code).toBe(2);
  expect((await runCli(["--pm-id", "demo", "--dispatch", "1", "--gate", "x"])).code).toBe(2);
});

test("CLI: producer violation -> exit 3 with JSON body", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-"));
  try {
    // no __garelier tree at all -> container_missing violation
    const r = await runCli(["--pm-id", "demo", "--project", project, "--dispatch", "9"]);
    expect(r.code).toBe(3);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(false);
    expect(j.mode).toBe("producer");
    expect(j.nudge.length).toBeGreaterThan(0);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("CLI: --dispatch and --stall-scan together -> usage exit 2", async () => {
  const r = await runCli(["--pm-id", "demo", "--dispatch", "1", "--stall-scan"]);
  expect(r.code).toBe(2);
});

test("CLI: --handoff without --stall-scan -> usage exit 2", async () => {
  const r = await runCli(["--pm-id", "demo", "--dispatch", "1", "--handoff", "1"]);
  expect(r.code).toBe(2);
});

test("CLI: --stall-scan with no __garelier tree -> ok, empty items, exit 0", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-stall-"));
  try {
    const r = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(true);
    expect(j.mode).toBe("stall-scan");
    expect(j.items).toHaveLength(0);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("CLI: --stall-scan emits a W-053 touch_map with pairwise conflicts across active dispatches", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-touch-"));
  try {
    const pmRoot = join(project, "__garelier", "demo");
    const mk = (n: number, slug: string, status: string, touches: string[]) => {
      const c = join(pmRoot, `_dispatch${n}`);
      mkdirSync(c, { recursive: true });
      writeFileSync(join(c, "STATE.md"), `# Dispatch\n\n## Status\n\n${status}\n\n## Current task\n\nx\n`);
      writeFileSync(join(c, "context.json"), JSON.stringify({ task: { slug, touches } }));
    };
    mk(1, "recipe", "REPORTING", ["core/recipe/**"]);
    mk(2, "recipe-2", "WORKING", ["core/recipe/filter.rs"]); // overlaps #1
    mk(3, "docs", "WORKING", ["docs/x.md"]); // isolated
    const r = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    expect(r.code === 0 || r.code === 3).toBe(true); // 3 if #3 judged stall-suspect; touch_map still present
    const j = JSON.parse(r.out);
    expect(j.touch_map).toHaveLength(3);
    const one = j.touch_map.find((t: { dispatch: string }) => t.dispatch === "1");
    const three = j.touch_map.find((t: { dispatch: string }) => t.dispatch === "3");
    expect(one.conflicts_with).toContain("2");
    expect(three.conflicts_with).toEqual([]);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("CLI: --stall-scan --handoff on an unknown dispatch id -> handoff_error, still exit 0 (no stall found)", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-stall-"));
  try {
    const r = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan", "--handoff", "3"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.handoff_dispatch).toBe("3");
    expect(j.handoff_prompt).toBeNull();
    expect(j.handoff_error).toContain("#3");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// End-to-end escalation demonstration (W-037): a genuinely-stalled dispatch
// (real git repo, 0 commits past base, uncommitted diff, no builder process)
// escalates none -> nudge -> handoff purely from the PERSISTED history across
// separate --stall-scan invocations, with the elapsed-time boundary crossed by
// rewinding the on-disk history file rather than a real wall-clock wait (the
// same effect two --stall-scan calls N/M minutes apart would have).
test("CLI: --stall-scan escalates a persisted stall-suspect none -> nudge -> handoff across scans (fixture demo)", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-esc-"));
  try {
    const pmRoot = join(project, "__garelier", "demo");
    const container = join(pmRoot, "_dispatch1");
    const checkout = join(container, "checkout");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(container, "STATE.md"), "# Dispatch\n\n## Status\n\nWORKING\n\n## Current task\n\nx\n");

    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(checkout, "a.txt"), "1\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]).stdout.toString().trim();
    writeFileSync(join(checkout, "a.txt"), "2\n"); // uncommitted -> dirty, 0 commits past base
    writeFileSync(join(container, "context.json"), JSON.stringify({ task: { base_sha: baseSha } }));

    // Scan 1 ("tick 0"): freshly stall-suspect, no escalation yet, history seeded.
    const r1 = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    const j1 = JSON.parse(r1.out);
    expect(j1.items[0]).toMatchObject({ judgement: "stall-suspect", escalation: "none" });

    const historyPath = join(pmRoot, "runtime", "dispatch", "stall_scan_history.json");
    const rewind = (minutes: number) => {
      const h = JSON.parse(readFileSync(historyPath, "utf8"));
      h["1"].since_ms -= minutes * 60_000;
      h["1"].last_seen_ms -= minutes * 60_000;
      writeFileSync(historyPath, JSON.stringify(h));
    };

    // Simulate "tick 11" (>= default --nudge-after 10) without waiting 11 real minutes.
    rewind(11);
    const r2 = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    const j2 = JSON.parse(r2.out);
    expect(j2.items[0].escalation).toBe("nudge");
    expect(j2.items[0].escalation_prompt).toContain("escalation: nudge");

    // Simulate "tick 26" (>= default --handoff-after 25) the same way.
    rewind(15);
    const r3 = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    const j3 = JSON.parse(r3.out);
    expect(j3.items[0].escalation).toBe("handoff");
    expect(j3.items[0].escalation_prompt).toContain("escalation: handoff");
    expect(j3.items[0].escalation_prompt).toContain("RESUME in the EXISTING worktree");
  } finally { rmSync(project, { recursive: true, force: true }); }
}, 60_000);

test("CLI: --nudge-after / --handoff-after override the default thresholds", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-esc2-"));
  try {
    const pmRoot = join(project, "__garelier", "demo");
    const container = join(pmRoot, "_dispatch1");
    const checkout = join(container, "checkout");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(container, "STATE.md"), "# Dispatch\n\n## Status\n\nWORKING\n\n## Current task\n\nx\n");
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(checkout, "a.txt"), "1\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]).stdout.toString().trim();
    writeFileSync(join(checkout, "a.txt"), "2\n");
    writeFileSync(join(container, "context.json"), JSON.stringify({ task: { base_sha: baseSha } }));

    await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    const historyPath = join(pmRoot, "runtime", "dispatch", "stall_scan_history.json");
    const h = JSON.parse(readFileSync(historyPath, "utf8"));
    h["1"].since_ms -= 3 * 60_000;
    writeFileSync(historyPath, JSON.stringify(h));

    // A 3-minute-old stall-suspect should NOT escalate under the default (10),
    // but SHOULD under a --nudge-after 2 override.
    const rDefault = JSON.parse((await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"])).out);
    expect(rDefault.items[0].escalation).toBe("none");
    const rOverride = JSON.parse((await runCli(["--pm-id", "demo", "--project", project, "--stall-scan", "--nudge-after", "2"])).out);
    expect(rOverride.items[0].escalation).toBe("nudge");
  } finally { rmSync(project, { recursive: true, force: true }); }
}, 60_000);

// ── W-071: ungated REPORTING + session-resume, end to end ─────────────────────

test("CLI: --stall-scan reports UNWATCHED for a WORKING dispatch with no watch heartbeat, exit 0 (advisory) (W-085)", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-unwatched-"));
  try {
    const pmRoot = join(project, "__garelier", "demo");
    const container = join(pmRoot, "_dispatch1");
    mkdirSync(join(container, "checkout"), { recursive: true }); // not a git repo -> judgement unknown
    writeFileSync(join(container, "STATE.md"), "# D\n\n## Status\n\nWORKING\n\n## Current task\n\n#1 feat-a (br)\n");
    writeFileSync(join(container, "context.json"), JSON.stringify({ task: { base_sha: "x", branch: "br" } }));
    const r = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    const j = JSON.parse(r.out);
    expect(j.unwatched).toContain("1");
    expect(j.items[0].watch).toBe("unwatched");
    expect(r.code).toBe(0); // UNWATCHED is advisory — it does not flip ok/exit on its own
    // W-033: unwatched_detail's watch_cmd resolves project/pm-id from the REAL
    // pmRoot the CLI constructed (join(project,"__garelier","demo")), not a test
    // stub -- proves the reverse-derivation in buildWatchCmd is correct end to
    // end, not just against a synthetic pmRoot.
    const detail = j.unwatched_detail.find((d: { dispatch: string }) => d.dispatch === "1");
    expect(detail).toBeDefined();
    expect(detail.watch_cmd).toContain("dispatch_watch.sh");
    expect(detail.watch_cmd).toContain(`--pm-id demo`);
    expect(detail.watch_cmd).toContain("--id 1");
    expect(detail.watch_cmd).toContain(`--project "${project}"`);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("CLI: --stall-scan reports UNPROCESSED-RESULT for a landed merge whose workbench branch still exists, exit 0 (advisory) (W-086)", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-unproc-"));
  try {
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(project, "a.txt"), "1\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    // Canonical branch shape (garelier/<slug>/<pm_id>/workbench/#<id>/<slug>) so
    // the W-033 cleanup_cmd assertion below exercises the real id-parsing path,
    // not a synthetic name that happens to have no #<id>/ segment.
    git(["branch", "garelier/main/demo/workbench/#7/x"]); // the un-cleaned workbench branch (cleanup never ran)
    const pmRoot = join(project, "__garelier", "demo");
    const resultsDir = join(pmRoot, "runtime", "merge_gate", "results");
    const archiveDir = join(pmRoot, "runtime", "merge_gate", "archive");
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(resultsDir, "r1.json"), JSON.stringify({ request_id: "r1", status: "success", studio_commit: "deadbeef" }));
    writeFileSync(join(archiveDir, "r1.request.json"), JSON.stringify({ request_id: "r1", workbench_branch: "garelier/main/demo/workbench/#7/x", target_root: project }));
    const r = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    const j = JSON.parse(r.out);
    expect(j.unprocessed_results).toHaveLength(1);
    expect(j.unprocessed_results[0]).toMatchObject({ request_id: "r1", workbench_branch: "garelier/main/demo/workbench/#7/x" });
    expect(r.code).toBe(0); // UNPROCESSED-RESULT is advisory — it does not flip ok/exit
    // W-033: cleanup_cmd resolves project/pm-id from the REAL pmRoot the CLI
    // constructed, same end-to-end proof as the UNWATCHED test above.
    expect(j.unprocessed_results[0].cleanup_cmd).toContain("dispatch_cleanup.sh");
    expect(j.unprocessed_results[0].cleanup_cmd).toContain("--pm-id demo");
    expect(j.unprocessed_results[0].cleanup_cmd).toContain("--id 7");
    expect(j.unprocessed_results[0].cleanup_cmd).toContain("--delete-branch");
    expect(j.unprocessed_results[0].cleanup_cmd).toContain(`--project "${project}"`);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("CLI: --stall-scan flags an ungated REPORTING (exit 3, judgement ungated-reporting)", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-ungated-"));
  try {
    const pmRoot = join(project, "__garelier", "demo");
    const container = join(pmRoot, "_dispatch1");
    mkdirSync(join(container, "checkout"), { recursive: true });
    writeFileSync(join(container, "STATE.md"), "# D\n\n## Status\n\nREPORTING\n\n## Current task\n\n#1 feat-a (br)\n");
    writeFileSync(join(container, "context.json"), JSON.stringify({ task: { base_sha: "x", slug: "feat-a" } }));
    const r = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    expect(r.code).toBe(3);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(false);
    expect(j.items[0].judgement).toBe("ungated-reporting");
    expect(j.items[0].suggested_nudge).toContain("gate");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("CLI: --stall-scan reports unconsumed_instructions for a REPORTING dispatch with an open ledger, advisory exit 0 (W-092)", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-ledger-"));
  try {
    const pmRoot = join(project, "__garelier", "demo");
    const container = join(pmRoot, "_dispatch1");
    mkdirSync(join(container, "checkout"), { recursive: true });
    writeFileSync(join(container, "STATE.md"), "# D\n\n## Status\n\nREPORTING\n\n## Current task\n\n#1 feat-a (br)\n");
    writeFileSync(join(container, "context.json"), JSON.stringify({ task: { base_sha: "x", slug: "feat-a" } }));
    writeFileSync(join(container, "instructions.md"), "# ledger\n\n- [ ] I1 also handle the edge case\n");
    // Gate it so stallScan skips it (not ungated) → exit stays 0; the ledger scan
    // still flags it → pins that UNCONSUMED-INSTRUCTIONS is advisory (does not flip exit).
    mkdirSync(join(pmRoot, "runtime", "guardian", "results"), { recursive: true });
    writeFileSync(join(pmRoot, "runtime", "guardian", "results", "feat-a-guardian.md"), "## Verdict\n\nPASS\n");
    const r = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    const j = JSON.parse(r.out);
    expect(j.unconsumed_instructions).toHaveLength(1);
    expect(j.unconsumed_instructions[0].dispatch).toBe("1");
    expect(j.unconsumed_instructions[0].unconsumed[0]).toContain("I1");
    expect(r.code).toBe(0); // advisory — UNCONSUMED-INSTRUCTIONS does not flip ok/exit
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("CLI: --stall-scan surfaces session_resume when the previous scan is old (W-071)", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-cc-cli-resume-"));
  try {
    const pmRoot = join(project, "__garelier", "demo");
    // Seed an old last_scan so THIS scan detects the resume gap (no real wait).
    const lastScanDir = join(pmRoot, "runtime", "dispatch");
    mkdirSync(lastScanDir, { recursive: true });
    writeFileSync(join(lastScanDir, "last_scan.json"), JSON.stringify({ ts_ms: Date.now() - 3 * 3_600_000 }));
    const r = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    const j = JSON.parse(r.out);
    expect(j.session_resume).toBeDefined();
    expect(j.session_resume.message).toContain("SESSION-RESUME");
    // And the scan persisted a fresh timestamp -> a second immediate scan does NOT re-fire.
    const r2 = await runCli(["--pm-id", "demo", "--project", project, "--stall-scan"]);
    expect(JSON.parse(r2.out).session_resume).toBeUndefined();
  } finally { rmSync(project, { recursive: true, force: true }); }
});
