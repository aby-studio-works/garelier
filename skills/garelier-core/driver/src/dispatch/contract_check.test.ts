// W-022 — contract_check.ts: the attended-dispatch completion-contract detector.
// Pins ok / each violation class / nudge synthesis so the detector cannot silently
// stop catching an idle-without-artifact producer or gate.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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
  type GitRunner,
  type ProcessLister,
  type StallScanItem,
  type StallHistoryMap,
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
function gitStall(commits: number, dirty: boolean): GitRunner {
  return (args) => {
    if (args[0] === "rev-list") return { code: 0, stdout: `${commits}\n` };
    if (args[0] === "status") return { code: 0, stdout: dirty ? " M some/file.ts\n" : "" };
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

test("stallScan: REPORTING/BLOCKED/IDLE containers are out of scope (not producer-mode's job here)", () => {
  const pm = makePmRoot();
  try {
    writeDispatch(pm, 6, { status: "REPORTING" });
    writeDispatch(pm, 7, { status: "BLOCKED" });
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

test("buildHandoffPrompt: preserves partial work + includes termination notice and resume prompt", () => {
  const item: StallScanItem = { dispatch: "42", state: "WORKING", commits: 0, dirty: true, dirty_hash: "h1", background: "none", judgement: "stall-suspect", suggested_nudge: "x", escalation: "none", escalation_elapsed_min: null, escalation_prompt: "" };
  const prompt = buildHandoffPrompt(item, "/proj/__garelier/pm/_dispatch42");
  expect(prompt).toContain("dispatch #42");
  expect(prompt).toContain("RESUME in the EXISTING worktree");
  expect(prompt).toContain("do NOT run dispatch_prepare again");
  expect(prompt).not.toContain("NOTE: this dispatch was NOT classified");
});

test("buildHandoffPrompt: warns when generated for a non-stall-suspect item", () => {
  const item: StallScanItem = { dispatch: "5", state: "WORKING", commits: 0, dirty: true, dirty_hash: "h2", background: "unknown", judgement: "unknown", suggested_nudge: "", escalation: "none", escalation_elapsed_min: null, escalation_prompt: "" };
  const prompt = buildHandoffPrompt(item, "/proj/__garelier/pm/_dispatch5");
  expect(prompt).toContain("NOTE: this dispatch was NOT classified stall-suspect");
});

// ── escalation (W-037) ─────────────────────────────────────────────────────────
// Pins the N/M minute boundaries via injected nowMs (never a real wall-clock
// wait) and the two reset conditions the design calls out: judgement moving
// away from stall-suspect, and the dirty diff moving (real progress) even
// while judgement stays stall-suspect.
function stallItem(dispatch: string, dirtyHash: string, judgement: StallScanItem["judgement"] = "stall-suspect"): StallScanItem {
  return {
    dispatch, state: "WORKING", commits: 0, dirty: true, dirty_hash: dirtyHash,
    background: judgement === "stall-suspect" ? "none" : "unknown", judgement,
    suggested_nudge: judgement === "stall-suspect" ? `dispatch #${dispatch} stall nudge` : "",
    escalation: "none", escalation_elapsed_min: null, escalation_prompt: "",
  };
}
const containerOf = (id: string) => `/proj/__garelier/pm/_dispatch${id}`;
const ESC_OPTS = { nudgeAfterMin: 10, handoffAfterMin: 25 };

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
