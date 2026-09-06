// W-641: `review_prepare.ts` could not prepare a Dock review for a claude lane.
//
// Two independent defects, both measured on live lanes (#355 / #437) and both
// invisible to the #354 tests that introduced the postcondition:
//
//   1. admission read the provider from `context.routing.provider`, which
//      dispatch_prepare writes into the role AUTHORIZATION and never into
//      context.json — so every real lane fell back to `"codex-cli"`, expected
//      `lane/result.md`, and refused the attended lane's `<container>/report.md`.
//   2. the register contract that makes `gate_runner --from-register` produce a
//      GREEN existed only in the codex preamble, so a claude register could
//      never carry the REQUIRED GATE block and was structurally RED.
//
// The #354 H-1 test missed both: it hand-wrote `routing.provider` into a fixture
// context.json (a field no dispatch writes) and it faked `runGate`, so the block
// was never parsed. This file measures the SHAPE A REAL ATTENDED LANE HAS
// (no provider in `routing`, `provider_transport` in ready.json, register at
// `<container>/report.md`) and calls the REAL gate_runner.

import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
// W-733: destructive fs goes through the guarded wrapper, never raw node:fs.
import { rmSync } from "../guard/path_guard.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { admitDockProxyReadyPaths, resolveDockProxyProviderTransport } from "./dock_proxy.ts";
import { bindReviewSha } from "./bind_review_sha.ts";
import { parseMachineArtifact } from "../dispatch/machine_artifact.ts";
import { dockReviewRecordPath, reviewGateLogPath } from "../dispatch/dock_review_record.ts";
import { gateRunRecordPath, readGateRunRecord, writeGateRunRecord } from "../dispatch/gate_run_record.ts";
import { runReviewPrepare, type ReviewPrepareDeps } from "./review_prepare.ts";
import { runCli as runGateCli } from "./gate_runner.ts";
import { promptPreamble } from "./dispatch_prepare.ts";
import {
  CODEX_REQUIRED_GATE_REASON,
  DOCK_RUN_REQUIRED_GATE_REASON,
  REQUIRED_GATE_BLOCK_CLOSE,
  REQUIRED_GATE_BLOCK_OPEN,
  requiredGateDelegationContract,
} from "./lane_common.ts";
import { inspectDockReviewHandoff, runAttendedSpawn } from "../dispatch/attended_seat.ts";
import { ROLE_PERMISSION_PROFILE } from "../guard/permission_profiles.ts";

const cleanup: string[] = [];
afterAll(() => {
  for (const path of cleanup) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const DISPATCH_ID = "7";
const PM_ID = "pm1";
const DOCK_AGENT = "ga-dock-w641-parity";
const SCANNER_COMMAND = "gitleaks dir . --no-banner --redact --report-format json --report-path -";
const REGISTER_STEP = "git rev-parse --verify HEAD";

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function setupConfig(): string {
  return [
    "[project]", 'name = "w641-parity-fixture"', "",
    "[branches]", 'target = "main"', 'integration = "studio"', "",
    "[guardian_tools]", `secret_scan = "${SCANNER_COMMAND}"`, "",
    "[quality_gate]", 'stack = "custom"',
    `commands = ["${REGISTER_STEP}"]`, "timeout_minutes_per_cmd = 5", "",
    "[quality_gate.register]", 'summary_patterns = ["^[0-9a-f]{40}$"]', "",
    "[[quality_gate.register.steps]]", 'name = "probe"',
    'command_prefixes = ["git rev-parse"]', "",
    "[[quality_gate.register.closure]]", 'name = "closure"',
    'cmd = "git status --porcelain=v1"', "",
    "[[quality_gate.register.coverage]]", 'paths = ["src/**"]', 'steps = ["probe"]', "",
    "[quality_gate.register.test_trees]",
    'marker_globs = ["src/**/*.test.ts"]', 'roots = ["src"]', "",
  ].join("\n");
}

function registerText(withBlock: boolean): string {
  return [
    "+++", "[lane]", "state = 'REPORTING'", "+++", "",
    "w641 parity fixture",
    "",
    "## Gates",
    "",
    ...(withBlock ? [REQUIRED_GATE_BLOCK_OPEN, REGISTER_STEP, REQUIRED_GATE_BLOCK_CLOSE] : []),
    "",
  ].join("\n");
}

interface Fixture {
  root: string;
  container: string;
  checkout: string;
  lane: string;
  report: string;
  readyPath: string;
  base: string;
  head: string;
  dockRecord: string;
}

/** The exact shape `dispatch_prepare --provider claude-code` leaves behind for
 * an attended lane: `routing` WITHOUT a provider, `provider_transport` in
 * ready.json, and the register at `<container>/report.md`. */
function attendedFixture(
  transport = "attended-agent",
  withBlock = true,
  driverPaths: readonly string[] = [],
  /** Written into the BASE commit: present in the checkout, absent from the
   * candidate diff. Lets a case prove which path TRIGGERED delegation. */
  basePaths: readonly string[] = [],
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "garelier-w641-"));
  cleanup.push(root);
  const container = join(root, "__garelier", PM_ID, "_crew", `dispatch${DISPATCH_ID}`);
  const checkout = join(container, "checkout");
  const lane = join(container, "lane");
  mkdirSync(join(checkout, "src"), { recursive: true });
  mkdirSync(lane, { recursive: true });

  gitIn(checkout, "init", "--initial-branch=studio");
  gitIn(checkout, "config", "user.email", "w641@example.invalid");
  gitIn(checkout, "config", "user.name", "W641 Fixture");
  gitIn(checkout, "config", "commit.gpgsign", "false");
  writeFileSync(join(checkout, "src", "keep.txt"), "base\n");
  // Gate logs are ignored the way a real project ignores them, so a log written
  // INSIDE the measured tree does not dirty it by itself. That is what lets the
  // W-710 clean-tree assertion below measure the RECORD rather than the log.
  writeFileSync(join(checkout, ".gitignore"), "*.log\n");
  for (const relative of basePaths) {
    const target = join(checkout, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "// present before the candidate (fixture)\n");
  }
  gitIn(checkout, "add", "-A");
  gitIn(checkout, "commit", "-m", "base");
  const base = gitIn(checkout, "rev-parse", "HEAD");
  gitIn(checkout, "checkout", "-b", "work");
  writeFileSync(join(checkout, "src", "thing.txt"), "candidate\n");
  // W-691: a candidate that changes the driver's own gate scripts declares a
  // gate contract the studio-installed scripts do not implement.
  for (const relative of driverPaths) {
    const target = join(checkout, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "// candidate driver change (fixture)\n");
  }
  gitIn(checkout, "add", "-A");
  gitIn(checkout, "commit", "-m", "candidate");
  const head = gitIn(checkout, "rev-parse", "HEAD");

  const pmRoot = join(root, "__garelier", PM_ID);
  mkdirSync(join(pmRoot, "_crew", "pm"), { recursive: true });
  writeFileSync(join(pmRoot, "_crew", "pm", "setup_config.toml"), setupConfig());

  // The Dock attribution record gate_runner requires. It is written OUTSIDE the
  // runner (by dispatch_prepare in production) and lives in the PM attended-record
  // directory; gate_runner refuses a self-issued one.
  const metaDir = join(pmRoot, "_crew", "lanes", ".meta");
  mkdirSync(metaDir, { recursive: true });
  const dockRecord = join(metaDir, `${DOCK_AGENT}.dispatch.json`);
  writeFileSync(dockRecord, `${JSON.stringify({
    source: "attended_record",
    spawned_via: "dispatch_prepare",
    agent_name: DOCK_AGENT,
    guard: {
      agent_name: DOCK_AGENT,
      role: "dock",
      permission_profile: ROLE_PERMISSION_PROFILE.dock,
      fence_roots: [root],
      worktree: checkout,
    },
  }, null, 2)}\n`);

  writeFileSync(join(container, "context.json"), `${JSON.stringify({
    task: {
      id: Number(DISPATCH_ID), role: "worker", slug: "w641-parity",
      branch: "garelier/feature-none-soft/pm1/workbench/#7/w641-parity",
      base_sha: base,
    },
    project: { pm_id: PM_ID },
    guard: { worktree: checkout },
    // The real attended context.json: model / effort / source / commit_mode only.
    routing: { model: "opus", effort: "xhigh", source: "flag", commit_mode: "self" },
    gate_agents: {
      guardian: { name: "ga-guardian-w641-parity", report: "runtime/guardian/results/w641-parity-guardian.md" },
      observer: { name: "ga-observer-w641-parity", report: "runtime/observer/results/w641-parity-observer.md" },
    },
  }, null, 2)}\n`);

  const report = join(container, "report.md");
  writeFileSync(report, registerText(withBlock));
  const readyPath = join(container, "ready.json");
  writeFileSync(readyPath, `${JSON.stringify({
    id: Number(DISPATCH_ID), commit_mode: "self",
    provider: "claude-code", provider_transport: transport,
    session_record: join(lane, "session.json"),
    result_file: report,
    resume_instruction_file: join(lane, "followup.md"),
    resume_result_file: report,
  }, null, 2)}\n`);

  return { root, container, checkout, lane, report, readyPath, base, head, dockRecord };
}

/** Only the stages that are NOT under test are faked: the guardian scan and the
 * mandatory-scanner evidence writer. `runGate` is the real gate_runner CLI
 * (AC-4) and the SHA binder is the real `bindReviewSha` (W-709 / W-720): the
 * `[gate]` fields it writes ARE what those rows are about, so a fake binder
 * would measure the fixture instead of the driver. */
interface DelegationCall { script: string; args: string[]; env?: Record<string, string> }

function reviewDeps(
  f: Fixture,
  delegations: DelegationCall[] = [],
): ReviewPrepareDeps {
  const runScript: ReviewPrepareDeps["runScript"] = (script, args, env) => {
    const value = (flag: string): string => args[args.indexOf(flag) + 1] ?? "";
    // W-691: the candidate's own review_prepare.ts, invoked by delegation. The
    // real one would run the full pipeline in the candidate checkout; the
    // fixture only has to prove the studio script hands off to THAT path with
    // the source-marking environment, and returns what the candidate produced.
    if (script === resolve(f.checkout, "skills/garelier-core/driver/src/scripts/review_prepare.ts")) {
      delegations.push({ script, args, env });
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          dispatch_id: Number(DISPATCH_ID), review_sha: f.head, base_sha: f.base,
          expected_studio_sha: f.base, retired_evidence: [],
          secret_scan: "", scanner_evidence: "", scanner_evidence_json: "",
          final_accounting: "", identity_scrub: "not-applicable", dock_record: "",
          dock_review_record: "", gate_script_source: "candidate", gate_run_source: "executed",
          gate: { code: 0, message: "candidate script" },
        })}\n`,
        stderr: "",
      };
    }
    if (script.endsWith("bind_review_sha.ts")) {
      // The real binder prints one summary line per artifact to stdout
      // (`bind_review_sha.ts::main`). This fake returns them the same way, so
      // the caller under test is exercised on the value it actually receives —
      // an earlier version collected them in an array instead, and that array
      // was the only place the `driver_overwrote=` announcement ever reached
      // (W-709 F-1: production wrote it to a pipe and dropped it).
      const summaries: string[] = [];
      try {
        for (const summary of bindReviewSha({
          container: value("--container"), resultPath: value("--result") || undefined,
          review: value("--review"), base: value("--base"),
          gateLog: value("--gate-log") || undefined,
          gateResult: (value("--gate-result") || undefined) as "GREEN" | undefined,
          stat: value("--stat") || undefined,
          replace: args.includes("--replace"),
        })) summaries.push(summary);
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: `${(error as Error).message}\n` };
      }
      return { exitCode: 0, stdout: `${summaries.join("\n")}\n`, stderr: "" };
    }
    if (script.endsWith("guardian_scan.ts")) {
      writeFileSync(value("--out"), `${JSON.stringify({
        scan_state: "complete",
        scope: { base_ref: value("--base"), head_ref: value("--head") },
        findings: [],
      }, null, 2)}\n`);
    } else if (script.endsWith("scanner_evidence.ts")) {
      const out = value("--out");
      writeFileSync(out, "scanner evidence (fixture)\n");
      writeFileSync(`${out}.json`, `${JSON.stringify({
        schema_version: 1, generated_by: "scanner_evidence.ts",
        base: value("--base"), head: value("--head"), exit: 0,
        scanner_command: value("--command"), cwd: value("--checkout"),
      }, null, 2)}\n`);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return {
    runScript,
    prepareDockSeat: () => ({ name: DOCK_AGENT, record_path: f.dockRecord } as any),
    runGate: runGateCli,
  };
}

// ── AC-1 / defect 1 ────────────────────────────────────────────────────────────

test("W-641 AC-1: the provider shape comes from ready.json provider_transport, with no default", () => {
  const f = attendedFixture();
  const ready = JSON.parse(readFileSync(f.readyPath, "utf8")) as Record<string, any>;
  expect(resolveDockProxyProviderTransport(ready)).toBe("attended-agent");
  expect(admitDockProxyReadyPaths(f.root, f.container, ready).initialResultPath.toLowerCase())
    .toBe(resolve(f.report).toLowerCase());

  // Counterfactual: with the transport absent, admission REFUSES. It does not
  // silently assume codex — that assumption is exactly what broke #355.
  const { provider_transport: _dropped, ...withoutTransport } = ready;
  expect(() => admitDockProxyReadyPaths(f.root, f.container, withoutTransport))
    .toThrow(/ready\.json provider_transport must be one of/);
  expect(() => admitDockProxyReadyPaths(f.root, f.container, { ...ready, provider_transport: "claude-code" }))
    .toThrow(/ready\.json provider_transport must be one of/);

  // The pre-fix source of truth is still absent from a real attended context.json,
  // so a reader that consults it learns nothing (this is why the default fired).
  const context = JSON.parse(readFileSync(join(f.container, "context.json"), "utf8")) as Record<string, any>;
  expect(context.routing.provider).toBeUndefined();

  // A codex lane keeps the lane/ leaves: this fix moves the SOURCE, not the shape.
  const codex = {
    ...ready, provider_transport: "codex-cli",
    result_file: join(f.lane, "result.md"),
    resume_result_file: join(f.lane, "followup.result.md"),
  };
  const codexAdmitted = admitDockProxyReadyPaths(f.root, f.container, codex);
  expect(codexAdmitted.initialResultPath.toLowerCase())
    .toBe(resolve(join(f.lane, "result.md")).toLowerCase());
  expect(codexAdmitted.followupResultPath.toLowerCase())
    .toBe(resolve(join(f.lane, "followup.result.md")).toLowerCase());

  // The other claude transport is the same predicate, not a second one: both
  // register in the container root, initial and followup alike.
  const subprocess = attendedFixture("claude-subprocess");
  const subprocessAdmitted = admitDockProxyReadyPaths(
    subprocess.root, subprocess.container,
    JSON.parse(readFileSync(subprocess.readyPath, "utf8")) as Record<string, any>,
  );
  expect(subprocessAdmitted.initialResultPath.toLowerCase()).toBe(resolve(subprocess.report).toLowerCase());
  expect(subprocessAdmitted.followupResultPath.toLowerCase()).toBe(resolve(subprocess.report).toLowerCase());
});

/** The `[gate]` table an artifact currently carries, as the machine reads it. */
function gateTable(path: string): Record<string, string> {
  const data = parseMachineArtifact(readFileSync(path, "utf8"), path).data as Record<string, unknown>;
  return (data.gate ?? {}) as Record<string, string>;
}

test("W-641 AC-2: runReviewPrepare admits the real attended lane and selects report.md; a redirected result_file is still refused; the driver owns the [gate] SHA and log fields (W-709 / W-720)", async () => {
  const f = attendedFixture();
  // W-709 AC-1: the producer wrote the BASE-TRACK destination into the field the
  // driver owns. Before DEC-100 P1 the binder refused that value
  // (`declared_base_sha changes from … to …`) and the whole round was spent
  // retyping a SHA the driver resolves itself (a downstream project's dispatch #538 r19..r22).
  writeFileSync(f.report, readFileSync(f.report, "utf8").replace(
    "[lane]",
    `[gate]\ndeclared_base_sha = '${f.head}'\nreview_sha = '${f.head}'\ngate_log = 'gate-000000000000.log'\n[lane]`,
  ));
  expect(gateTable(f.report).declared_base_sha).toBe(f.head);
  const result = await runReviewPrepare(
    { project: f.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: f.base },
    reviewDeps(f),
  );
  expect(result.review_sha).toBe(f.head);
  expect(readFileSync(result.final_accounting, "utf8"))
    .toContain(`- Canonical producer result: \`${f.report.replace(/\\/g, "/")}\``);

  // (a) exit 0, and the field holds the PICKUP base the driver derived — not
  // what the producer typed. The overwrite is announced, never silent.
  const bound = gateTable(f.report);
  expect(bound.declared_base_sha).toBe(f.base);
  expect(bound.review_sha).toBe(f.head);
  // W-709 F-1: the announcement reaches a READER. It is a bound fact of the
  // Dock-owned accounting, which the seal digests — not a string the binder
  // wrote to a pipe that only a failing stage would have read.
  const accounting = readFileSync(result.final_accounting, "utf8");
  const overwriteLine = /^- Driver-owned \[gate\] fields overwritten: (.+)$/m.exec(accounting)?.[1] ?? "";
  expect(overwriteLine).toContain("declared_base_sha");
  // W-720 AC-1: `gate_log` is bound to the SAME review SHA, so the stale pointer
  // the producer carried in is replaced instead of surviving the round. The
  // pre-fix binder wrote it only when it was `undefined`, which is the shape
  // measured on #463 r2 (review_sha moved, gate_log did not).
  expect(bound.gate_log).toBe(reviewGateLogPath(f.lane, f.head));
  expect(overwriteLine).toContain("gate_log");

  // (b) the other direction: with NO producer-authored [gate] SHA fields at all,
  // the same three values still appear — they are derived, not transcribed.
  writeFileSync(f.report, registerText(true));
  expect(gateTable(f.report).declared_base_sha).toBeUndefined();
  const derivedResult = await runReviewPrepare(
    { project: f.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: f.base, rerunGate: true },
    reviewDeps(f),
  );
  const fromNothing = gateTable(f.report);
  expect(fromNothing.declared_base_sha).toBe(f.base);
  expect(fromNothing.review_sha).toBe(f.head);
  expect(fromNothing.gate_log).toBe(reviewGateLogPath(f.lane, f.head));
  // …and the same accounting line reports `none`, so a reader can tell
  // "nothing was overwritten" from "this Dock run did not look".
  expect(readFileSync(derivedResult.final_accounting, "utf8"))
    .toContain("- Driver-owned [gate] fields overwritten: none");

  // W-720 AC-1 (round 2): re-binding at a NEW review SHA moves `gate_log` with
  // it. Pre-fix the artifact kept round 1's log name here, and the Dock sealed
  // a register pointing at the previous round's log.
  const round2 = "b".repeat(40);
  bindReviewSha({
    container: f.container, resultPath: f.report, review: round2, base: f.base,
    gateLog: reviewGateLogPath(f.lane, round2), replace: true,
  });
  expect(gateTable(f.report).gate_log).toBe(reviewGateLogPath(f.lane, round2));
  expect(gateTable(f.report).previous_review_sha).toBe(f.head);

  // W-720 AC-2: `review_sha` and `gate_log` are ONE pair of facts about ONE
  // commit, checked where they are written — a log named for another review is
  // refused rather than stamped, so a bound register cannot hold a mismatch.
  expect(() => bindReviewSha({
    container: f.container, resultPath: f.report, review: f.head, base: f.base,
    gateLog: reviewGateLogPath(f.lane, round2), replace: true,
  })).toThrow(/is not the review log for --review/);

  // W-720 AC-3: while `lane/result.md` and `report.md` are both canonical
  // (W-653), the stamp lands on both — their `[gate]` tables are identical.
  const laneResult = join(f.lane, "result.md");
  writeFileSync(laneResult, registerText(true));
  writeFileSync(f.report, registerText(true));
  bindReviewSha({
    container: f.container, resultPath: laneResult, review: f.head, base: f.base,
    gateLog: reviewGateLogPath(f.lane, f.head), replace: true,
  });
  expect(JSON.stringify(gateTable(laneResult))).toBe(JSON.stringify(gateTable(f.report)));
  expect(gateTable(laneResult).gate_log).toBe(reviewGateLogPath(f.lane, f.head));

  // (b) admission still refuses a result_file that is not the container-derived leaf.
  const ready = JSON.parse(readFileSync(f.readyPath, "utf8")) as Record<string, any>;
  writeFileSync(f.readyPath, `${JSON.stringify({ ...ready, result_file: join(f.container, "elsewhere.md") })}\n`);
  await expect(runReviewPrepare(
    { project: f.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: f.base },
    reviewDeps(f),
  )).rejects.toThrow(/ready\.json result_file does not match the canonical lane path/);
}, 120_000);

// ── AC-3 / defect 2 (contract text) ───────────────────────────────────────────

test("W-641 AC-3: both claude preambles carry the REQUIRED GATE clauses, from the same definition as codex", () => {
  const parsed = { role: "worker", slug: "w641-parity", pm: PM_ID } as any;
  // attended-agent and claude-subprocess share this branch: `provider` is
  // claude-code and `commit_mode` is self for both.
  const claude = promptPreamble(parsed, DISPATCH_ID, "branch", "abc1234", "/container", "self", "opus", "claude-code");
  const codex = promptPreamble(parsed, DISPATCH_ID, "branch", "abc1234", "/container", "proxy", "gpt", "codex");
  for (const preamble of [claude, codex]) {
    expect(preamble).toContain(REQUIRED_GATE_BLOCK_OPEN);
    expect(preamble).toContain(REQUIRED_GATE_BLOCK_CLOSE);
    expect(preamble).toContain("Register-step form:");
    expect(preamble).toContain("Scoped self-gate (W-402)");
  }
  // P-1: one definition, two reasons. The obligation text is byte-identical.
  expect(claude).toContain(requiredGateDelegationContract(DOCK_RUN_REQUIRED_GATE_REASON));
  expect(codex).toContain(requiredGateDelegationContract(CODEX_REQUIRED_GATE_REASON));
  const shared = requiredGateDelegationContract("R").split("R.")[1]!;
  expect(shared.length).toBeGreaterThan(200);
  expect(claude).toContain(shared);
  expect(codex).toContain(shared);
  // The claude reason must not import codex's sandbox rationale.
  expect(claude).not.toContain("heavy_compile_lock, so you CANNOT");
  // (b) removing the clauses from the shared definition drops the assert.
  expect(requiredGateDelegationContract("")).toContain(REQUIRED_GATE_BLOCK_OPEN);
  expect("".includes(REQUIRED_GATE_BLOCK_OPEN)).toBeFalse();
});

// ── AC-4 / end-to-end with the REAL gate_runner ───────────────────────────────

test("W-641 AC-4: a claude register with the block reaches GREEN through the real gate_runner and issues a Guardian seat; without the block it is REGISTER_REFUSED and no seat is issued", async () => {
  const green = attendedFixture("attended-agent", true);
  const greenResult = await runReviewPrepare(
    { project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base },
    reviewDeps(green),
  );
  const greenAccounting = readFileSync(greenResult.final_accounting, "utf8");
  expect(greenResult.gate.code).toBe(0);
  expect(greenAccounting).toContain("- Gate result: GREEN (exit 0)");
  // W-693 / W-691: the seal states which run it binds and which checkout's gate
  // scripts produced it. The first pass has no run to bind and no driver change.
  expect(greenResult.gate_run_source).toBe("executed");
  expect(greenResult.gate_script_source).toBe("studio");
  expect(greenAccounting).toContain("- Gate script source: studio");
  expect(greenAccounting).toContain("- Gate run source: executed (no terminal gate run in the review log)");
  expect(readFileSync(greenResult.gate.message.includes("log=")
    ? greenResult.gate.message.split("log=")[1]!.split("\n")[0]!
    : join(green.lane, `gate-${green.head.slice(0, 12)}.log`), "utf8")).toContain("RESULT GREEN");
  const greenHandoff = inspectDockReviewHandoff({ project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID });
  expect(greenHandoff.ready).toBeTrue();
  expect(runAttendedSpawn({
    role: "guardian", project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID,
    slug: "w641-parity", worktree: green.checkout,
  } as any, green.root).name).toBe("ga-guardian-w641-parity");

  // W-710: a gate leaves NOTHING in the tree it measures — asserted where it can
  // FAIL. The first version wrote the record beside the log; a caller may point
  // `--log` INSIDE the gate's own cwd, and that untracked sibling then makes the
  // next run's `gate step identity requires a clean checkout` throw, turning the
  // gate RED with its own evidence. Running the real gate with the log inside
  // the checkout is the only arrangement that discriminates: asserting on a
  // lane-sibling log passes under the pre-fix code too, because the record lands
  // in `lane/` where nothing looks.
  const insideLog = join(green.checkout, "gate-inside-tree.log");
  const insideRun = await runGateCli([
    "--project", green.root, "--pm-id", PM_ID, "--cwd", green.checkout,
    "--from-register", green.report, "--log", insideLog,
  ], {
    ...process.env,
    GARELIER_ROLE: "dock",
    GARELIER_AGENT_NAME: DOCK_AGENT,
    GARELIER_DISPATCH_RECORD: green.dockRecord,
  });
  expect(insideRun.code, insideRun.message).toBe(0);
  // The tree is untouched: the log is ignored, and the record is NOT beside it.
  // Pre-fix this listed `?? gate-inside-tree.log.run.json`, an unignored sibling
  // that made the NEXT run throw `gate step identity requires a clean checkout` —
  // so this run would have been RED rather than GREEN.
  expect(gitIn(green.checkout, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  expect(existsSync(gateRunRecordPath(green.root, PM_ID, insideLog))).toBeTrue();
  expect(existsSync(`${insideLog}.run.json`)).toBeFalse();
  rmSync(insideLog, { force: true });

  // ── W-693 / W-711: the seal binds the run the DOCK RECORD already seals ─────
  const greenLog = reviewGateLogPath(green.lane, green.head);
  const runIds = (): string[] => [...readFileSync(greenLog, "utf8").matchAll(/^GATE_START run_id=(\S+)/gm)].map((m) => m[1]!);
  const executedRunId = runIds().at(-1)!;
  expect(runIds()).toHaveLength(1);
  const sealed = (): Record<string, any> => JSON.parse(readFileSync(greenResult.dock_review_record, "utf8"));
  expect(sealed().gate_run_id).toBe(executedRunId);

  // (a) the record already seals this run over these log bytes -> the seal binds
  // it and NO new run is executed. W-711: the register plays no part in that.
  // `quoteRun` still writes a `[gate] gate_run_id`, and the cases below prove it
  // is INERT: a wrong id and a missing id produce the same decision as a right
  // one, where both used to refuse and cost the round.
  const quoteRun = (runId: string | null, step: string = REGISTER_STEP): void => writeFileSync(green.report, [
    "+++", "[lane]", "state = 'REPORTING'",
    ...(runId === null ? [] : ["[gate]", `gate_run_id = '${runId}'`]),
    "+++", "",
    "w641 parity fixture", "", "## Gates", "",
    REQUIRED_GATE_BLOCK_OPEN, step, REQUIRED_GATE_BLOCK_CLOSE, "",
  ].join("\n"));
  quoteRun(executedRunId);
  const reused = await runReviewPrepare(
    { project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base },
    reviewDeps(green),
  );
  expect(reused.gate_run_source).toBe("reused");
  expect(reused.gate.code).toBe(0);
  expect(runIds()).toEqual([executedRunId]);
  expect(sealed().gate_run_id).toBe(executedRunId);
  // The reused seal reports the reused run's own audit, not an empty one.
  expect(sealed().coverage).toBe(JSON.parse(readFileSync(greenResult.dock_review_record, "utf8")).coverage);
  expect(readFileSync(reused.final_accounting, "utf8"))
    .toContain(`- Gate run source: reused (Dock-sealed run ${executedRunId})`);

  // (b) W-711 (DEC-100 ruling 2), both directions on the SAME lane: a register
  // quoting a DIFFERENT run, and one quoting none at all, now reach the same
  // reuse and the same sealed run. Both used to be refused before any mutation,
  // so a producer that mis-copied or omitted a run id spent a round on a value
  // the Dock record already held. Nothing else moved between these calls.
  for (const quoted of ["00000000-0000-4000-8000-000000000000", null]) {
    quoteRun(quoted);
    const inert = await runReviewPrepare(
      { project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base },
      reviewDeps(green),
    );
    expect(inert.gate_run_source).toBe("reused");
    expect(sealed().gate_run_id).toBe(executedRunId);
  }
  expect(runIds()).toEqual([executedRunId]);

  // (c) --rerun-gate is the explicit way to execute a new run; the run count moves.
  const rerun = await runReviewPrepare(
    { project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base, rerunGate: true },
    reviewDeps(green),
  );
  expect(rerun.gate_run_source).toBe("executed");
  expect(runIds()).toHaveLength(2);
  expect(runIds().at(-1)).not.toBe(executedRunId);
  // (c2) W-693 F-1: the register is the OTHER producer-writable artifact the
  // reuse decision trusts. Reuse skips gate_runner, which is the only consumer
  // of the register, so a replayed audit would re-issue GREEN + COVERED for
  // whatever steps the register declares NOW. The reuse flow exists precisely
  // because the producer edits the register between two Dock calls, so the
  // declared steps get the same treatment the log got: bound in the seal,
  // compared at the decision, executed when they moved.
  const rerunRunId = runIds().at(-1)!;
  quoteRun(rerunRunId);
  const boundAgain = await runReviewPrepare(
    { project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base },
    reviewDeps(green),
  );
  expect(boundAgain.gate_run_source).toBe("reused");
  expect(runIds()).toHaveLength(2);
  const sealedBlockDigest = sealed().gate_required_block_digest;
  expect(sealedBlockDigest).toMatch(/^[0-9a-f]{64}$/);

  // Same quoted run id, one substituted step: the sealed audit no longer covers
  // what the register declares, so the gate RUNS instead of being replayed.
  const substitutedStep = "git rev-parse HEAD";
  expect(substitutedStep).not.toBe(REGISTER_STEP);
  quoteRun(rerunRunId, substitutedStep);
  const substituted = await runReviewPrepare(
    { project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base },
    reviewDeps(green),
  );
  expect(substituted.gate_run_source).toBe("executed");
  // The substituted step really RAN and passed — a RED here would also produce
  // "executed" on the next call and would hide what this case measures.
  expect(substituted.gate.code).toBe(0);
  expect(readFileSync(substituted.final_accounting, "utf8"))
    .toContain("declared REQUIRED GATE steps changed since the sealed run");
  expect(runIds()).toHaveLength(3);
  // The new seal binds the new declaration, so the next round re-locks on it.
  expect(sealed().gate_required_block_digest).not.toBe(sealedBlockDigest);
  quoteRun(runIds().at(-1)!, substitutedStep);
  const relocked = await runReviewPrepare(
    { project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base },
    reviewDeps(green),
  );
  expect(relocked.gate_run_source).toBe("reused");
  expect(runIds()).toHaveLength(3);
  // A comment inside the block is not a declaration change (the digest is over
  // the PARSED steps), so editing prose does not force a re-run.
  quoteRun(runIds().at(-1)!, `# a comment the parser drops
${substitutedStep}`);
  const reflowed = await runReviewPrepare(
    { project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base },
    reviewDeps(green),
  );
  expect(reflowed.gate_run_source).toBe("reused");
  expect(runIds()).toHaveLength(3);

  // (d) `lane/` is inside the producer's write fence, so "the log says GREEN"
  // proves shape, not provenance. A producer-appended GREEN run that its own
  // register quotes must NOT skip the gate: the Dock record outside the fence
  // no longer matches the log bytes, so the run executes instead of being
  // reused. Without this the reuse contract would be a way to skip the gate.
  const forgedRunId = "ffffffff-0000-4000-8000-ffffffffffff";
  const beforeForge = runIds().length;
  writeFileSync(greenLog, `${readFileSync(greenLog, "utf8")}GATE_START run_id=${forgedRunId} started_at=2026-09-05T00:00:00.000Z\nGATE_STEP_CENSUS executed=0 skipped_green=0\nRESULT GREEN\nGATE_END run_id=${forgedRunId}\n`);
  // The declaration is left EXACTLY as the last seal bound it, so the only
  // thing that moved is the log — otherwise (c2) would explain the execution.
  quoteRun(forgedRunId, substitutedStep);
  expect(runIds()).toHaveLength(beforeForge + 1);
  const forged = await runReviewPrepare(
    { project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base },
    reviewDeps(green),
  );
  expect(forged.gate_run_source).toBe("executed");
  expect(readFileSync(forged.final_accounting, "utf8")).toContain("no Dock review record binds GREEN run");
  expect(runIds()).toHaveLength(beforeForge + 2);
  expect(sealed().gate_run_id).not.toBe(forgedRunId);

  // ── W-710: the seal binds the RUN RECORD, and states the tree it measured ───
  // (a) the record is the source of the bound run id. Append one more terminal
  // GREEN run to the log AFTER the seal: the retired binding read the last
  // `GATE_START run_id=` in the FILE and would now name this appended run, while
  // the record is one object the last real run replaced. Two runs in one log,
  // one answer (#394 r32 / #538 r12).
  const trailingRunId = "eeeeeeee-0000-4000-8000-eeeeeeeeeeee";
  writeFileSync(greenLog, `${readFileSync(greenLog, "utf8")}GATE_START run_id=${trailingRunId} started_at=2026-09-05T00:00:00.000Z\nGATE_STEP_CENSUS executed=0 skipped_green=0\nRESULT GREEN\nGATE_END run_id=${trailingRunId}\n`);
  expect(runIds().at(-1)).toBe(trailingRunId);
  expect(sealed().gate_run_id).not.toBe(trailingRunId);
  expect(readGateRunRecord(gateRunRecordPath(green.root, PM_ID, greenLog))!.run_id).toBe(sealed().gate_run_id);
  // (b) the P-9 facts live in the seal, so nothing downstream parses the log for
  // them. A still checkout records the review commit on both ends.
  expect(sealed().gate_start_head).toBe(green.head);
  expect(sealed().gate_end_head).toBe(green.head);
  expect(readGateRunRecord(gateRunRecordPath(green.root, PM_ID, greenLog))!.cwd).toBe(green.checkout.replace(/\\/g, "/"));

  // W-710 AC-1: the same pipeline over a run that recorded a MOVED checkout —
  // written through the production writer, so the fixture cannot drift from the
  // shape gate_runner emits — refuses before any seal exists.
  const moved = attendedFixture();
  const movedLog = reviewGateLogPath(moved.lane, moved.head);
  await expect(runReviewPrepare(
    { project: moved.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: moved.base },
    {
      ...reviewDeps(moved),
      runGate: async (args) => {
        const log = args[args.indexOf("--log") + 1]!;
        writeFileSync(log, [
          "GATE_START run_id=w710-moved started_at=2026-09-05T00:00:00.000Z",
          "GATE_STEP_CENSUS executed=1 skipped_green=0",
          "RESULT GREEN",
          "GATE_END run_id=w710-moved",
          "",
        ].join("\n"));
        writeGateRunRecord({
          path: gateRunRecordPath(moved.root, PM_ID, log),
          logPath: log, runId: "w710-moved",
          startedAt: "2026-09-05T00:00:00.000Z", endedAt: "2026-09-05T00:01:00.000Z",
          cwd: moved.checkout, startHead: moved.head, endHead: moved.base,
          status: "GREEN", exit: 0,
        });
        return { code: 0, message: "RESULT GREEN" };
      },
    },
  )).rejects.toThrow(/measured .* not the review commit .*; the checkout moved under the gate/);
  expect(existsSync(gateRunRecordPath(moved.root, PM_ID, movedLog))).toBeTrue();
  expect(existsSync(dockReviewRecordPath(moved.root, PM_ID, DISPATCH_ID))).toBeFalse();
  // (b) the same run with both heads on the review commit seals normally, so the
  // refusal is about the MOVE and not about running through this dep at all.
  const still = await runReviewPrepare(
    { project: moved.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: moved.base },
    {
      ...reviewDeps(moved),
      runGate: async (args) => {
        const log = args[args.indexOf("--log") + 1]!;
        writeFileSync(log, [
          "GATE_START run_id=w710-still started_at=2026-09-05T00:00:00.000Z",
          "GATE_STEP_CENSUS executed=1 skipped_green=0",
          "RESULT GREEN",
          "GATE_END run_id=w710-still",
          "",
        ].join("\n"));
        writeGateRunRecord({
          path: gateRunRecordPath(moved.root, PM_ID, log),
          logPath: log, runId: "w710-still",
          startedAt: "2026-09-05T00:00:00.000Z", endedAt: "2026-09-05T00:01:00.000Z",
          cwd: moved.checkout, startHead: moved.head, endHead: moved.head,
          status: "GREEN", exit: 0,
        });
        return { code: 0, message: "RESULT GREEN" };
      },
    },
  );
  const stillSeal = JSON.parse(readFileSync(still.dock_review_record, "utf8")) as Record<string, any>;
  expect(stillSeal.gate_run_id).toBe("w710-still");
  expect(stillSeal.gate_start_head).toBe(moved.head);
  expect(stillSeal.gate_end_head).toBe(moved.head);

  // ── W-691: a candidate that changes the driver gates with ITS OWN scripts ────
  const delegations: DelegationCall[] = [];
  const candidate = attendedFixture("attended-agent", true, ["skills/garelier-core/driver/src/scripts/review_prepare.ts"]);
  const delegated = await runReviewPrepare(
    { project: candidate.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: candidate.base },
    reviewDeps(candidate, delegations),
  );
  expect(delegations).toHaveLength(1);
  expect(delegations[0]!.script).toBe(resolve(candidate.checkout, "skills/garelier-core/driver/src/scripts/review_prepare.ts"));
  expect(delegations[0]!.env).toEqual({ GARELIER_REVIEW_PREPARE_GATE_SCRIPT_SOURCE: "candidate" });
  expect(delegated.gate_script_source).toBe("candidate");
  // The studio script did NOT run a gate of its own for this candidate.
  expect(existsSync(join(candidate.lane, `gate-${candidate.head.slice(0, 12)}.log`))).toBeFalse();

  // The delegated child does not delegate again: the environment marks it as
  // the candidate, so it gates here and records `candidate` as the source.
  const asCandidate: DelegationCall[] = [];
  process.env.GARELIER_REVIEW_PREPARE_GATE_SCRIPT_SOURCE = "candidate";
  try {
    const child = await runReviewPrepare(
      { project: candidate.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: candidate.base },
      reviewDeps(candidate, asCandidate),
    );
    expect(asCandidate).toHaveLength(0);
    expect(child.gate_script_source).toBe("candidate");
    expect(readFileSync(child.final_accounting, "utf8")).toContain("- Gate script source: candidate");
  } finally {
    delete process.env.GARELIER_REVIEW_PREPARE_GATE_SCRIPT_SOURCE;
  }

  // Fork D fallback: the candidate changes driver code but carries no
  // review_prepare.ts to delegate to. The studio scripts run, and the seal says
  // so instead of pretending the candidate's own contract was satisfied.
  const noScript: DelegationCall[] = [];
  const legacy = attendedFixture("attended-agent", true, ["skills/garelier-core/driver/src/scripts/gate_runner.ts"]);
  const legacyResult = await runReviewPrepare(
    { project: legacy.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: legacy.base },
    reviewDeps(legacy, noScript),
  );
  expect(noScript).toHaveLength(0);
  expect(legacyResult.gate_script_source).toStartWith("studio (candidate driver changed but ");
  expect(readFileSync(legacyResult.final_accounting, "utf8")).toContain("- Gate script source: studio (candidate driver changed but ");

  // W-693 F-2: the delegation denominator is every path the gate contract is
  // implemented in, not only the runner sources. `renderFinalAccounting`
  // asserts the template's placeholder set EQUALS the values it is given, so a
  // candidate that changes ONLY the template reproduces the W-691 symptom —
  // the studio script throws on the mismatch, nothing delegates, nothing warns.
  const templateOnly: DelegationCall[] = [];
  const templateCandidate = attendedFixture(
    "attended-agent", true,
    ["skills/garelier-core/templates/final_accounting.md"],
    ["skills/garelier-core/driver/src/scripts/review_prepare.ts"],
  );
  // The candidate diff contains NO driver/src path — the script it delegates to
  // exists but is unchanged. So only the widened prefix set can fire here; under
  // the driver-only denominator this case threw on the placeholder mismatch with
  // no delegation and no warning, which is the W-691 symptom verbatim.
  const templateDiff = gitIn(templateCandidate.checkout, "diff", "--name-only", `${templateCandidate.base}..${templateCandidate.head}`)
    .split("\n").filter(Boolean);
  expect(templateDiff).toContain("skills/garelier-core/templates/final_accounting.md");
  expect(templateDiff.filter((path) => path.startsWith("skills/garelier-core/driver/src/"))).toEqual([]);
  const templateDelegated = await runReviewPrepare(
    { project: templateCandidate.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: templateCandidate.base },
    reviewDeps(templateCandidate, templateOnly),
  );
  expect(templateOnly).toHaveLength(1);
  expect(templateDelegated.gate_script_source).toBe("candidate");

  // W-711 AC-5: the denominator is DERIVED from the delegate's own path, so the
  // runnable package's manifests are inside it. The hand-kept prefix list began
  // at `driver/src/`, which left `driver/tsconfig.json` and `driver/package.json`
  // — the files that decide whether the candidate's scripts run AT ALL — outside
  // it: such a candidate delegated nothing and warned about nothing.
  const configOnly: DelegationCall[] = [];
  const configCandidate = attendedFixture(
    "attended-agent", true,
    ["skills/garelier-core/driver/tsconfig.json"],
    ["skills/garelier-core/driver/src/scripts/review_prepare.ts"],
  );
  const configDiff = gitIn(configCandidate.checkout, "diff", "--name-only", `${configCandidate.base}..${configCandidate.head}`)
    .split("\n").filter(Boolean);
  expect(configDiff).toContain("skills/garelier-core/driver/tsconfig.json");
  // No `driver/src/` path in the diff: only the derived package prefix can fire.
  expect(configDiff.filter((path) => path.startsWith("skills/garelier-core/driver/src/"))).toEqual([]);
  const configDelegated = await runReviewPrepare(
    { project: configCandidate.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: configCandidate.base },
    reviewDeps(configCandidate, configOnly),
  );
  expect(configOnly).toHaveLength(1);
  expect(configDelegated.gate_script_source).toBe("candidate");

  // (b) counterfactual for the delegation predicate: the same pipeline on a
  // candidate that touches NO gate-contract path never delegates.
  expect(greenResult.gate_script_source).toBe("studio");

  // (b) the SAME lane with the block removed: the real runner refuses the
  // register, the run is RED, and the gate seat stays closed.
  const red = attendedFixture("attended-agent", false);
  const redResult = await runReviewPrepare(
    { project: red.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: red.base },
    reviewDeps(red),
  );
  expect(redResult.gate.code).not.toBe(0);
  expect(redResult.gate.message).toContain("required_gate_block_missing");
  expect(readFileSync(redResult.final_accounting, "utf8")).not.toContain("- Gate result: GREEN (exit 0)");
  const redHandoff = inspectDockReviewHandoff({ project: red.root, pmId: PM_ID, dispatchId: DISPATCH_ID });
  expect(redHandoff.ready).toBeFalse();
  expect(() => runAttendedSpawn({
    role: "guardian", project: red.root, pmId: PM_ID, dispatchId: DISPATCH_ID,
    slug: "w641-parity", worktree: red.checkout,
  } as any, red.root)).toThrow(/Dock review handoff postcondition failed/);
}, 300_000);
