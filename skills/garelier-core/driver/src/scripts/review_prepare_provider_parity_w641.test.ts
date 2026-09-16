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

import { createHash } from "node:crypto";
import {
  acknowledgeRoleLaunch,
  bindingReference,
  dispatchExecutionIdentity,
  issueRoleAuthorization,
  roleBindingPaths,
  updateRoleQualityGateSelection,
} from "../dispatch/role_binding.ts";
import { resolveRoleKnowledgeBinding } from "../dispatch/knowledge_binding.ts";
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
// W-733: destructive fs goes through the guarded wrapper, never raw node:fs.
import { rmSync, rmdirSync } from "../guard/path_guard.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  admitDockProxyReadyPaths,
  dockProxyGenerationCutoffMs,
  dockProxyLaneShape,
  dockProxyRecoveryLeaves,
  dockProxyRegisterCandidates,
  readDockProxyLaneSession,
  resolveDockProxyProviderTransport,
  resolveDockProxyReadyRegisterPath,
  type DockProxyReadyPaths,
} from "./dock_proxy.ts";
import { bindReviewSha, renderBindSummary, reviewArtifactPaths } from "./bind_review_sha.ts";
import { parseMachineArtifact } from "../dispatch/machine_artifact.ts";
import { dockReviewRecordPath, reviewGateLogPath } from "../dispatch/dock_review_record.ts";
import { gateRunRecordPath, readGateRunRecord, writeGateRunRecord } from "../dispatch/gate_run_record.ts";
import { runReviewPrepare, summarizeDriverOverwrites, type ReviewPrepareDeps } from "./review_prepare.ts";
import { findAutoProxyCommitCandidates } from "./fleet_watch.ts";
import {
  capturedRegisterFallback,
  dispatchRegisterLaneShape,
  fullRegisterTemplatePlaceholders,
  inspectCapturedRegister,
  readCapturedRegisterInput,
  renderFullRegisterTemplate,
} from "./provider_session.ts";
import { main as registerCheckMain } from "./register_check.ts";
import { runCli as runGateCli } from "./gate_runner.ts";
import { SEAT_FILE_AUTHORING_CONTRACT, promptPreamble, roleSeatPreamble } from "./dispatch_prepare.ts";
import { heredocAuthoringNotice, hookOutput, type Decision } from "../guard/command_guard.ts";
import { RUNTIME_POLICY } from "../../../hooks/runtime_recovery_hook.ts";
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
    "[branches]", 'target = "main"', 'target_slug = "feature-none-soft"', 'integration = "studio"', "",
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
  // W-764: name the fixture root the way a real project root is named — the
  // canonical spelling. `tmpdir()` on a Windows runner is an 8.3 short name
  // (`C:\Users\RUNNER~1\AppData\Local\Temp`), and the admission boundaries under
  // test return canonical paths, so a lexically-built expectation compared a
  // spelling the production code never produces.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "garelier-w641-")));
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
  writeFileSync(report, registerText(withBlock).replace(
    "[lane]", "[gate]\nreview_sha = 'PENDING_REVIEW_SHA'\n[lane]",
  ));
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
          gateReview: value("--gate-review") || undefined,
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

  // ── W-687 AC-5: "recovered × transport" is ONE decision, in one place ──────
  // The pre-fix admission asked only "is this lane recovered", so it demanded a
  // provider-session record from attended-agent — a transport with no writer for
  // one — and stopped `review_prepare` on _workshop #520 at
  // `ENOENT … lane/recovery.session.json`. The two axes are answered together
  // here so no reader has to re-derive them; the recovered-lane lifecycle is
  // driven end to end (real `--recover-role`, real admission) in
  // dispatch_deadlock_w318.test.ts.
  expect(dockProxyLaneShape("attended-agent", true)).toEqual({
    transport: "attended-agent", recovered: true,
    providerSessionRecord: false, registerInContainerRoot: true,
  });
  expect(dockProxyLaneShape("claude-subprocess", true)).toEqual({
    transport: "claude-subprocess", recovered: true,
    providerSessionRecord: true, registerInContainerRoot: false,
  });
  expect(dockProxyLaneShape("codex-cli", true)).toEqual({
    transport: "codex-cli", recovered: true,
    providerSessionRecord: true, registerInContainerRoot: false,
  });
  // The recovery WRITER and the admission READER derive the leaves from the one
  // function, so `ready.json` and the lane cannot disagree about where a
  // recovered lane registers (the second half of the #520 defect).
  expect(dockProxyRecoveryLeaves(f.container, "attended-agent")).toEqual({
    resultPath: resolve(f.report), sessionRecordPath: null,
  });
  expect(dockProxyRecoveryLeaves(f.container, "codex-cli")).toEqual({
    resultPath: resolve(join(f.lane, "recovery.result.md")),
    sessionRecordPath: resolve(join(f.lane, "recovery.session.json")),
  });
  // …and the readers consume that absence instead of stat-ing a path nothing
  // writes: an attended lane has no session record, recovered or not.
  const attendedAdmitted = admitDockProxyReadyPaths(f.root, f.container, ready);
  expect(attendedAdmitted.sessionPath).toBeNull();
  expect(readDockProxyLaneSession(attendedAdmitted)).toBeNull();
  expect(codexAdmitted.sessionPath?.toLowerCase()).toBe(resolve(join(f.lane, "session.json")).toLowerCase());

  // ── W-780 AC-2: the harness-safe alternate register leaf ───────────────────
  // The harness refuses, by name, to let an attended subagent write a file
  // called `report.md` ("Subagents should return findings as text, not write
  // report files…", verbatim twice on aby_works #716). The lane had already
  // finished; only the FILENAME was unavailable. `lane/register.md` is admitted
  // as well — derived from the container layout, never read out of ready.json,
  // so it widens no trust boundary.
  expect(attendedAdmitted.alternateRegisterPath?.toLowerCase())
    .toBe(resolve(join(f.lane, "register.md")).toLowerCase());
  // A codex lane already registers into `lane/`; it gets no second spelling.
  expect(codexAdmitted.alternateRegisterPath).toBeNull();
  // The scaffolded report.md exists from preparation, so it is what a lane with
  // no authored alternate resolves to.
  expect(resolveDockProxyReadyRegisterPath(attendedAdmitted).toLowerCase())
    .toBe(resolve(f.report).toLowerCase());
  // …and an AUTHORED alternate wins, because only the producer writes it while
  // report.md's existence proves nothing about authorship.
  writeFileSync(join(f.lane, "register.md"), registerText(true));
  expect(resolveDockProxyReadyRegisterPath(attendedAdmitted).toLowerCase())
    .toBe(resolve(join(f.lane, "register.md")).toLowerCase());
  // A lane on its FIRST generation has no earlier generation to be confused
  // with, so it carries no cutoff and this selection is what it always was.
  expect(attendedAdmitted.generationCutoffMs).toBeNull();

  // ── W-782 AC-1: the alternate leaf gets the SAME admission as every other ──
  // It was the ONE admitted leaf that did not pass through `canonicalReadyPath`
  // (W-780 Guardian G1): joined straight onto the container root and handed
  // back, so it never received the reparse check every other leaf gets, and
  // `resolveDockProxyReadyRegisterPath`'s `existsSync` would follow a reparse
  // point planted at `<container>/lane/register.md` and return it as the
  // admitted register. "Admitted leaf" now carries one safety property, not two.
  rmSync(join(f.lane, "register.md"));
  const foreignRegister = join(f.root, "foreign-register.md");
  writeFileSync(foreignRegister, registerText(true));
  symlinkSync(foreignRegister, join(f.lane, "register.md"), "file");
  try {
    expect(() => admitDockProxyReadyPaths(f.root, f.container, ready))
      .toThrow(/alternate register leaf must not contain a malformed path or symlink\/reparse point/);
  } finally {
    rmSync(join(f.lane, "register.md"));
  }
  // The check refuses a REPARSE POINT, not the name: an ordinary file at the
  // same path is admitted and selected exactly as before.
  writeFileSync(join(f.lane, "register.md"), registerText(true));
  expect(resolveDockProxyReadyRegisterPath(admitDockProxyReadyPaths(f.root, f.container, ready)).toLowerCase())
    .toBe(resolve(join(f.lane, "register.md")).toLowerCase());

  // Counterfactual: with NEITHER leaf present the lane is refused by name — the
  // alternate is an additional admitted path, not a relaxation.
  rmSync(join(f.lane, "register.md"));
  rmSync(f.report);
  expect(() => resolveDockProxyReadyRegisterPath(attendedAdmitted))
    .toThrow(/no admitted producer register exists/);

  // ── W-783 AC-1: a leaf the generation rule cannot DATE is refused by name ──
  // The rule answered `catch { return true; }`, so ANY lstat failure on the
  // alternate leaf re-admitted it — including a permission/IO error on a leaf
  // that DOES exist, which is exactly the stale generation-1 register the cutoff
  // exists to drop, readmitted silently (W-782 Observer N-2). This lane is on
  // generation 1, so the cutoff is supplied here to put the rule in force; the
  // real two-generation lane is driven in dispatch_deadlock_w318.test.ts.
  // (i) A leaf that EXISTS but is not a register: its mtime dates a DIRECTORY,
  //     and the existence search downstream would then hand that directory back
  //     as the register — which the session route already refuses by requiring
  //     `isFile`. One rule, one spelling.
  mkdirSync(join(f.lane, "register.md"));
  try {
    expect(() => dockProxyRegisterCandidates({ ...attendedAdmitted, generationCutoffMs: Date.now() }))
      .toThrow(/alternate register leaf is not a regular file, so it cannot be dated/);
  } finally {
    rmdirSync(join(f.lane, "register.md"));
  }
  // (ii) An lstat that THROWS. Measured on this platform: Windows reports every
  //      path-SHAPE failure as "no entry" — a component that is not a directory,
  //      an invalid name — so the only input that reaches the catch from a path
  //      is one lstat rejects outright. A permission/IO error on a leaf that does
  //      exist (the case W-782 Observer N-2 names) takes this same single branch.
  const undatable: DockProxyReadyPaths = {
    ...attendedAdmitted,
    generationCutoffMs: Date.now(),
    alternateRegisterPath: join(f.lane, "regi\0ster.md"),
  };
  expect(() => dockProxyRegisterCandidates(undatable))
    .toThrow(/alternate register leaf cannot be dated against the generation cutoff/);
  // Refutation: an ABSENT leaf is not stale and not an error. Under a live
  // cutoff the candidate list is identical to the un-dated one, so the harmless
  // case keeps exactly the behaviour it had before this change.
  const absentUnderCutoff: DockProxyReadyPaths = { ...attendedAdmitted, generationCutoffMs: Date.now() };
  expect(existsSync(attendedAdmitted.alternateRegisterPath!)).toBeFalse();
  expect(dockProxyRegisterCandidates(absentUnderCutoff))
    .toEqual(dockProxyRegisterCandidates(attendedAdmitted));
  expect(dockProxyRegisterCandidates(absentUnderCutoff)).toContain(attendedAdmitted.alternateRegisterPath!);
});

/** The `[gate]` table an artifact currently carries, as the machine reads it. */
function gateTable(path: string): Record<string, string> {
  const data = parseMachineArtifact(readFileSync(path, "utf8"), path).data as Record<string, unknown>;
  return (data.gate ?? {}) as Record<string, string>;
}

test("W-641 AC-2: runReviewPrepare admits the real attended lane and selects report.md; a redirected result_file is still refused; the driver owns the [gate] SHA and log fields (W-709 / W-720)", async () => {
  const f = attendedFixture();
  // A refusal after reading a linked handoff is too late. Count attempted
  // content reads in both consumers, before their later semantic admission.
  const handoffArgs = { project: f.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: f.base };
  const handoffReads: Record<string, number> = {};
  for (const name of ["context.json", "ready.json"]) {
    const path = join(f.container, name);
    const original = readFileSync(path, "utf8");
    const foreign = join(f.root, `foreign-${name}`);
    writeFileSync(foreign, original);
    rmSync(path);
    symlinkSync(foreign, path, "file");
    let foreignReads = 0;
    const readHandoffText = (candidate: string) => {
      if (resolve(candidate).toLowerCase() === resolve(path).toLowerCase()
        || realpathSync.native(candidate).toLowerCase() === realpathSync.native(foreign).toLowerCase()) foreignReads += 1;
      return readFileSync(candidate, "utf8");
    };
    try {
      await expect(runReviewPrepare(handoffArgs, { ...reviewDeps(f), readHandoffText })).rejects.toThrow();
      expect(findAutoProxyCommitCandidates(f.root, PM_ID, { readText: readHandoffText })).toEqual([]);
      handoffReads[name] = foreignReads;
    } finally {
      rmSync(path);
      writeFileSync(path, original);
    }
    writeFileSync(path, "[]");
    await expect(runReviewPrepare(handoffArgs, reviewDeps(f))).rejects.toThrow(/not valid JSON/);
    expect(findAutoProxyCommitCandidates(f.root, PM_ID)).toEqual([]);
    writeFileSync(path, original);
  }
  process.stdout.write(`W687_HANDOFF_READ ${JSON.stringify(handoffReads)} malformed=refused\n`);
  expect(handoffReads).toEqual({ "context.json": 0, "ready.json": 0 });
  // W-709 AC-1: the producer wrote the BASE-TRACK destination into the field the
  // driver owns. Before DEC-100 P1 the binder refused that value
  // (`declared_base_sha changes from … to …`) and the whole round was spent
  // retyping a SHA the driver resolves itself (a downstream project's dispatch #538 r19..r22).
  const syntheticChecksumValidGateLog = ["gate-", "1234", "5678", "9018", ".log"].join("");
  writeFileSync(f.report, readFileSync(f.report, "utf8").replace(
    "review_sha = 'PENDING_REVIEW_SHA'",
    `declared_base_sha = '${f.head}'\nreview_sha = '${f.head}'\ngate_log = '${syntheticChecksumValidGateLog}'`,
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
  // W-688 (#464 r3, note 3): the announcement names ONLY fields whose prior
  // value the producer can have authored. `review_sha` / `gate_review_sha` / `gate_log` /
  // `candidate_stat` are functions of the review commit, so the driver rewrites
  // them every round and from round 2 on it would be announcing its OWN round-1
  // values as producer overwrites. The line's whole discriminating power was
  // `declared_base_sha`; naming the other three added noise that a reader had
  // to learn to ignore.
  expect(overwriteLine).not.toContain("gate_log");
  expect(overwriteLine).not.toContain("gate_review_sha");
  expect(overwriteLine).not.toContain("review_sha");
  expect(overwriteLine).not.toContain("candidate_stat");
  // W-688 / W-653: the attended lane's result and report are ONE file, so the
  // line names it once. Pre-fix `reviewArtifactPaths` returned it twice and the
  // accounting printed the same pair twice, which reads as two artifacts
  // agreeing rather than one counted twice (#464).
  expect(overwriteLine.split(";")).toHaveLength(1);
  // W-720 AC-1: `gate_log` is bound to the SAME review SHA, so the stale pointer
  // the producer carried in is replaced instead of surviving the round. The
  // pre-fix binder wrote it only when it was `undefined`, which is the shape
  // measured on #463 r2 (review_sha moved, gate_log did not). This is the fact
  // the dropped announcement used to stand in for — asserted on the ARTIFACT,
  // where it cannot be satisfied by a prose line.
  expect(bound.gate_log).toBe(reviewGateLogPath(f.lane, f.head));
  expect(bound.gate_review_sha).toBe(f.head);

  // W-801 AC-2, refusal direction: an absent producer review claim remains a
  // refusal. The binder may rewrite an existing pending/exact value, but must
  // not create review_sha and silently promote an incomplete register.
  writeFileSync(f.report, registerText(true));
  const missingReviewBytes = readFileSync(f.report, "utf8");
  await expect(runReviewPrepare(
    { project: f.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: f.base, rerunGate: true },
    reviewDeps(f),
  )).rejects.toThrow(/\[gate\] review_sha is absent/);
  expect(readFileSync(f.report, "utf8")).toBe(missingReviewBytes);

  // W-801: binding owns [gate] only. Legal producer-authored TOML arrays,
  // inline tables and [[instruction]] rows on either side remain byte-for-byte
  // identical. Before the fix rewriteMachineArtifact decoded then re-emitted
  // every table through a scalar-only emitter and failed on `labels`/`meta`.
  const exoticPrefix = [
    "+++", "[lane]", "state = 'REPORTING'", "labels = ['alpha', 'beta']",
    "meta = { owner = 'worker', round = 2 }", "", "[gate]",
    "producer_labels = ['gate-alpha', 'gate-beta']",
    "producer_meta = { owner = 'worker', round = 2 }",
  ].join("\n") + "\n";
  const exoticSuffix = [
    "[[instruction]]", "id = 'I0001'", "digest = '0123456789ab'",
    "checked = 'true'", "consumed = 'artifact:lane/result.md'", "+++", "",
    "body bytes stay exactly here", "",
  ].join("\n");
  const exotic = exoticPrefix + `review_sha = '${"c".repeat(40)}'\n\n` + exoticSuffix;
  const exoticResult = join(f.lane, "result.md");
  writeFileSync(exoticResult, exotic);
  writeFileSync(f.report, exotic);
  bindReviewSha({
    container: f.container, resultPath: exoticResult, review: f.head, base: f.base,
    gateLog: reviewGateLogPath(f.lane, f.head), replace: true,
  });
  for (const artifactPath of [exoticResult, f.report]) {
    const rebound = readFileSync(artifactPath, "utf8");
    expect(rebound.startsWith(exoticPrefix)).toBeTrue();
    expect(rebound.endsWith(exoticSuffix)).toBeTrue();
    expect((parseMachineArtifact(rebound, artifactPath).data.lane as Record<string, unknown>).labels)
      .toEqual(["alpha", "beta"]);
    const reboundGate = parseMachineArtifact(rebound, artifactPath).data.gate as Record<string, unknown>;
    expect(reboundGate.producer_labels).toEqual(["gate-alpha", "gate-beta"]);
    expect(reboundGate.producer_meta).toEqual({ owner: "worker", round: 2 });
  }

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

  // W-720 AC-2: `gate_review_sha` and `gate_log` are one pair of facts about one
  // commit, checked where they are written. Without an explicit heavy-gate SHA,
  // a log named for another review is refused rather than stamped.
  expect(() => bindReviewSha({
    container: f.container, resultPath: f.report, review: f.head, base: f.base,
    gateLog: reviewGateLogPath(f.lane, round2), replace: true,
  })).toThrow(/is not the review log for --gate-review/);

  // W-720 AC-3: while `lane/result.md` and `report.md` are both canonical
  // (W-653), the stamp lands on both — their `[gate]` tables are identical.
  const laneResult = join(f.lane, "result.md");
  const pendingRegister = registerText(true).replace(
    "[lane]", "[gate]\nreview_sha = 'PENDING_REVIEW_SHA'\n[lane]",
  );
  writeFileSync(laneResult, pendingRegister);
  writeFileSync(f.report, pendingRegister);
  bindReviewSha({
    container: f.container, resultPath: laneResult, review: f.head, base: f.base,
    gateLog: reviewGateLogPath(f.lane, f.head), replace: true,
  });
  expect(JSON.stringify(gateTable(laneResult))).toBe(JSON.stringify(gateTable(f.report)));
  expect(gateTable(laneResult).gate_log).toBe(reviewGateLogPath(f.lane, f.head));

  // ── W-688: the register contract, checked at CAPTURE ───────────────────────
  // AC-1 / AC-3: three malformed registers, three DIFFERENT named reasons, and
  // none of them requires a person to open the file. Pre-fix all three were
  // written to disk and recorded `{"ok":true,"status":"ready"}`.
  const laneLedger = join(f.container, "instructions.md");
  const cleanLedger = ["+++", "[[instruction]]", "id = 'I0001'", "message = '''one'''",
    "checked = true", "consumed = '''artifact:lane/result.md'''", "+++", "", "# ledger", ""].join("\n");
  writeFileSync(laneLedger, cleanLedger);
  const capture = (register: string, proxyLane = true, ledger = cleanLedger): string[] =>
    inspectCapturedRegister({ register, ledger, proxyLane }).map((finding) => finding.code);
  const declaration = (id: string): string[] => [
    "[[instruction]]", `id = '${id}'`, "digest = '0123456789ab'",
    "checked = 'true'",
    "consumed = '''artifact:lane/result.md'''",
  ];
  const fullRegisterBody = [
    "## Acceptance evidence", "complete", "",
    "## Role census", "complete", "",
    "## Cross-check declarations", "complete", "",
    "## Out of scope", "zero", "",
  ];
  const registerWith = (state: string, ids: readonly string[]): string => [
    "+++", "[lane]", `state = '${state}'`, ...ids.flatMap(declaration), "+++", "", ...fullRegisterBody,
    "=== COMMIT PLAN ===", "files: a.ts", "=== END COMMIT PLAN ===", "",
  ].join("\n");
  const validRegister = registerWith("REPORTING", ["I0001"]);
  expect(capture(validRegister)).toEqual([]);
  const booleanChecked = inspectCapturedRegister({
    register: validRegister.replace("checked = 'true'", "checked = true"),
    ledger: cleanLedger,
    proxyLane: true,
  });
  expect(booleanChecked.map((finding) => finding.code)).toContain("instruction_ledger_declaration_invalid");
  expect(booleanChecked.map((finding) => finding.message).join("\n"))
    .toContain("register_instruction_checked_type_invalid");
  for (const role of ["guardian", "observer"]) {
    const verdictPath = join(f.lane, `${role}.verdict.md`);
    writeFileSync(verdictPath, `+++\n[verdict]\nresult = 'PASS'\nreview_sha = '${f.head}'\n+++\n`);
    expect(capturedRegisterFallback({ container: f.container, resultFile: verdictPath, role })).toBeUndefined();
    expect(capturedRegisterFallback({ container: f.container, resultFile: verdictPath, role: "worker" })?.reason)
      .toBe("register_contract_unsatisfied");
  }

  for (const state of ["7", "''", "[]", "true", "{}"] ) {
    expect(capture(validRegister.replace("state = 'REPORTING'", `state = ${state}`)))
      .toContain("register_lane_state_invalid");
  }
  expect(capture(validRegister.replace("consumed = '''artifact:lane/result.md'''", "consumed = ''"), true, cleanLedger.replace("checked = true", "checked = false")))
    .toContain("instruction_ledger_declaration_invalid");

  // 1. the #538 r18 shape: 818 bytes of prose with no front matter at all.
  expect(capture("# #538 r18 REPORTING report\n\nprose only\n")).toEqual([
    "register_front_matter_missing", "commit_plan_block_missing",
  ]);
  // 2. front matter present, plan absent (the #394 r37 shape). The ledger
  //    clause fires too — that register declares nothing — which is the point:
  //    every fault the round would have cost is returned at once.
  expect(capture(["+++", "[lane]", "state = 'REPORTING'", "+++", "",
    "COMMIT PLAN は実差分と一致", ""].join("\n")))
    .toEqual(["commit_plan_block_missing", "register_full_evidence_missing", "instruction_ledger_undeclared"]);
  // 3. plan present but not terminal — the exact clause the prompt states and
  //    nothing read.
  expect(capture([validRegister, "trailing prose after the plan", ""].join("\n")))
    .toEqual(["commit_plan_end_not_final_line"]);
  // A producer-committed lane hands over no plan and declares consumption by
  // editing instructions.md, so neither PROXY clause applies there.
  expect(capture(["+++", "[lane]", "state = 'REPORTING'", "+++", "", ...fullRegisterBody, ""].join("\n"), false)).toEqual([]);
  // A lower-case / unknown state is named as such, not as "no front matter".
  expect(capture("+++\n[lane]\nstate = 'reporting'\n+++\n\nbody\n", false))
    .toEqual(["register_lane_state_invalid"]);

  // AC-4 / AC-5: the denominator is the ledger FILE, read now. #538 r20→r21 was
  // the PM writing "18 entries, I0001..I0018" into a followup that was itself
  // entry 19 — a count is stale the moment it is typed, so none is accepted.
  const staleLedger = ["+++",
    "[[instruction]]", "id = 'I0001'", "message = '''one'''", "checked = true", "consumed = '''x'''",
    "[[instruction]]", "id = 'I0002'", "message = '''the followup that carried the count'''", "checked = false",
    "+++", "", "# ledger", ""].join("\n");
  const stale = inspectCapturedRegister({ register: validRegister, ledger: staleLedger, proxyLane: true });
  expect(stale.map((finding) => finding.code)).toEqual(["instruction_ledger_undeclared"]);
  // Named in full, against the driver's own denominator — never "1 is open".
  expect(stale[0]!.message).toContain("1 of the 2");
  expect(stale[0]!.message).toContain("I0002");
  // Declaring the entry the followup added clears it, with no count anywhere.
  expect(capture(registerWith("REPORTING", ["I0001", "I0002"]), true, staleLedger)).toEqual([]);
  // A BLOCKED register is ledger-unconsumed by definition; refusing it here
  // would refuse the one shape the contract exists to let through.
  expect(capture(registerWith("BLOCKED", ["I0001"]), true, staleLedger)).toEqual([]);
  // W-807: all four measured producer defects are named by the same capture +
  // proxy parser pair used by register_check.ts, while the complete form exits 0.
  const namedInstruction = validRegister.replace(
    "[[instruction]]\nid = 'I0001'\n", "[instruction.I0001]\nid = 'I0001'\n",
  );
  expect(capture(namedInstruction)).toContain("instruction_ledger_declaration_invalid");
  expect(capture(validRegister.replace(fullRegisterBody.join("\n"), "short result")))
    .toContain("register_full_evidence_missing");
  const emittedTemplate = renderFullRegisterTemplate(
    cleanLedger, "lane/result.md", dispatchRegisterLaneShape("codex", "proxy"),
  );
  const emittedPlaceholders = fullRegisterTemplatePlaceholders(emittedTemplate);
  expect(emittedPlaceholders).toEqual(expect.arrayContaining([
    "<branch>", "<one row per acceptance criterion: file + symbol + oracle + RED/GREEN result>",
    "<required role/path census or not-applicable evidence>", "<runtime recovery evidence>",
    "<dispatch>", "<pm>", "<role>", "<work-id>", "<model>",
  ]));
  for (const placeholder of emittedPlaceholders) {
    const withOneTemplateToken = validRegister.replace(
      "## Acceptance evidence", `## Acceptance evidence\n${placeholder}`,
    );
    expect(capture(withOneTemplateToken)).toContain("register_template_placeholder_unresolved");
  }
  const genericAngleProse = validRegister.replace(
    "## Acceptance evidence", "## Acceptance evidence\nEvidence type: Map<string, number>",
  );
  expect(capture(genericAngleProse)).not.toContain("register_template_placeholder_unresolved");
  expect(capture(validRegister.replace(
    "## Acceptance evidence", "## Acceptance evidence\n<unused prose token>",
  ))).not.toContain("register_template_placeholder_unresolved");
  expect(capture(validRegister.replace(
    "## Acceptance evidence", "## Acceptance evidence\n<branch>",
  ))).toContain("register_template_placeholder_unresolved");
  // Round 7 / F-2: the full template and standalone validator both derive the
  // lane shape from the dispatch record. A real attended Claude lane has
  // commit_mode=self, so its template has a committed-SHA slot and no proxy
  // ledger declarations, COMMIT PLAN, or Codex seat trailer.
  const selfTemplate = renderFullRegisterTemplate(
    cleanLedger, "lane/register.md", dispatchRegisterLaneShape("claude-code", "self"),
  );
  expect(selfTemplate).toContain("commit = '<commit SHA>'");
  expect(selfTemplate).not.toContain("proxy pending");
  expect(selfTemplate).not.toContain("[[instruction]]");
  expect(selfTemplate).not.toContain("=== COMMIT PLAN ===");
  expect(selfTemplate).not.toContain("Garelier-Seat:");
  const readOnlyTemplate = renderFullRegisterTemplate(
    cleanLedger, "lane/register.md", dispatchRegisterLaneShape("claude-code", "read-only"),
  );
  expect(readOnlyTemplate).toContain("commit = 'not applicable (read-only)'");
  expect(readOnlyTemplate).not.toContain("=== COMMIT PLAN ===");
  const selfRegister = [
    "+++", "[lane]", "state = 'REPORTING'", "[candidate]",
    `commit = '${f.head}'`, "+++", "", ...fullRegisterBody,
    'GARELIER_RUNTIME_STATUS: {"runtime_ok": true, "detail": "self lane complete"}', "",
  ].join("\n");
  const selfRegisterPath = join(f.lane, "register.md");
  writeFileSync(selfRegisterPath, selfRegister);
  expect(registerCheckMain([selfRegisterPath, "--instructions", laneLedger])).toBe(0);

  // The recorded Codex/proxy shape keeps the proxy-only provenance and the
  // validator still refuses the same register when its COMMIT PLAN is absent.
  expect(emittedTemplate).toContain("commit = 'proxy pending'");
  expect(emittedTemplate).toContain("[[instruction]]");
  expect(emittedTemplate).toContain("checked = 'true'");
  expect(emittedTemplate).not.toContain("checked = true");
  expect(emittedTemplate).toContain("=== COMMIT PLAN ===");
  expect(emittedTemplate).toContain("Garelier-Seat: codex");
  const contextPath = join(f.container, "context.json");
  const contextBeforeProxy = readFileSync(contextPath, "utf8");
  const readyBeforeProxy = readFileSync(f.readyPath, "utf8");
  const proxyContext = JSON.parse(contextBeforeProxy) as Record<string, any>;
  proxyContext.routing.commit_mode = "proxy";
  writeFileSync(contextPath, `${JSON.stringify(proxyContext, null, 2)}\n`);
  const proxyReady = JSON.parse(readyBeforeProxy) as Record<string, any>;
  proxyReady.provider = "codex";
  proxyReady.commit_mode = "proxy";
  writeFileSync(f.readyPath, `${JSON.stringify(proxyReady, null, 2)}\n`);
  const registerCheckPath = join(f.lane, "result.md");
  writeFileSync(registerCheckPath, validRegister);
  expect(registerCheckMain([registerCheckPath, "--instructions", laneLedger])).toBe(0);
  writeFileSync(registerCheckPath, selfRegister);
  expect(registerCheckMain([registerCheckPath, "--instructions", laneLedger])).toBe(2);
  writeFileSync(contextPath, contextBeforeProxy);
  writeFileSync(f.readyPath, readyBeforeProxy);
  // The commit mode is DERIVED from the container, never handed in: this lane's
  // context.json says `self`, so neither PROXY clause is applied.
  expect(readCapturedRegisterInput({ container: f.container, resultFile: f.report }).proxyLane).toBeFalse();

  // W-688 / W-653: ONE canonical register path per lane. `reviewArtifactPaths`
  // used to return the attended lane's single file twice (once as `result`,
  // once as `report`), so the binder bound it twice and the accounting printed
  // the same pair twice (#464).
  expect(reviewArtifactPaths(f.container, f.report).map((ref) => ref.path)).toEqual([f.report]);
  // A codex-shaped lane still has two distinct files, so de-duplication removes
  // a duplicate rather than an artifact.
  expect(reviewArtifactPaths(f.container, laneResult).map((ref) => ref.path))
    .toEqual([laneResult, f.report]);

  // W-688: one spelling of `driver_overwrote=`, shared by writer and reader. A
  // line carrying the token that does not parse is a refusal — the retired
  // local regex turned a miss into `none`, which is the same answer it prints
  // when nothing was overwritten.
  expect(summarizeDriverOverwrites(renderBindSummary({
    label: "report.md", previous: true, overwrote: ["declared_base_sha"],
  }))).toBe("report.md declared_base_sha");
  expect(summarizeDriverOverwrites(renderBindSummary({
    label: "report.md", previous: false, overwrote: [],
  }))).toBe("none");
  expect(() => summarizeDriverOverwrites("report.md: driver_overwrote=declared_base_sha"))
    .toThrow(/unreadable summary line/);

  // (b) admission still refuses a result_file that is not the container-derived leaf.
  const ready = JSON.parse(readFileSync(f.readyPath, "utf8")) as Record<string, any>;
  writeFileSync(f.readyPath, `${JSON.stringify({ ...ready, result_file: join(f.container, "elsewhere.md") })}\n`);
  await expect(runReviewPrepare(
    { project: f.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: f.base },
    reviewDeps(f),
  )).rejects.toThrow(/ready\.json result_file does not match the canonical lane path/);
}, 120_000);

// ── AC-3 / defect 2 (contract text) ───────────────────────────────────────────

test("W-641 AC-3 / W-777 / W-780: both claude preambles carry the REQUIRED GATE clauses from the same definition as codex, and the file-authoring + register-file contracts reach every face (preamble, gate seat, field manuals, command_guard notice)", () => {
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
    expect(preamble).toContain("instruction_ledger_undeclared");
    expect(preamble).toContain("Capture success is not consumption proof");
    expect(preamble).not.toContain("hands back every open id by name");
  }
  for (const face of ["worker_field_manual.md", "pm_field_manual.md", "gate_field_manual.md", "codex_worker_playbook.md", "attended-gate-dispatch.md"]) {
    const text = readFileSync(resolve(import.meta.dir,"../../../references",face),"utf8");
    expect(text).toContain("instruction_ledger_undeclared");
    expect(text).toContain("Capture success is not consumption proof");
    expect(text).not.toContain("instruction_ledger_unconsumed");
  }
  const registerCheckGuidance = "最終報告の直前に `bun skills/garelier-core/driver/src/scripts/register_check.ts <register path> --instructions <instructions.md>` を実行し、この command を exit 0 にしてから register を書く。";
  for (const face of ["worker_field_manual.md", "codex_worker_playbook.md"]) {
    expect(readFileSync(resolve(import.meta.dir, "../../../references", face), "utf8"))
      .toContain(registerCheckGuidance);
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

  // ── W-777: ONE file-authoring contract, on all three faces ────────────────
  // A heredoc fails two ways here and only one is loud; the quiet one hands back
  // 0 matches that read like a clean probe. Stated in the preamble (producer AND
  // gate seats), in both field manuals, and announced by the guard at the moment
  // it is typed — from one definition, so the faces cannot drift.
  for (const preamble of [claude, codex]) expect(preamble).toContain(SEAT_FILE_AUTHORING_CONTRACT);
  expect(roleSeatPreamble("guardian", DISPATCH_ID, "/project", "/out/verdict.md", true, {
    blueprintPath: null, lens: { ref: null, source: "none", registry_path: null, pack_path: null },
  })).toContain(SEAT_FILE_AUTHORING_CONTRACT);
  expect(SEAT_FILE_AUTHORING_CONTRACT).toContain("Write tool");
  expect(SEAT_FILE_AUTHORING_CONTRACT).toContain("bun <path>");
  expect(SEAT_FILE_AUTHORING_CONTRACT).toContain("unexpected EOF while looking for matching quote");
  expect(SEAT_FILE_AUTHORING_CONTRACT).toContain("is NOT evidence");
  for (const face of ["worker_field_manual.md", "pm_field_manual.md"]) {
    const text = readFileSync(resolve(import.meta.dir, "../../../references", face), "utf8");
    expect(text).toContain("heredoc 経由で書いた probe の 0 件は evidence にならない");
    expect(text).toContain("Write tool");
    expect(text).toContain("unexpected EOF while looking for matching quote");
  }
  // The guard ANNOUNCES; it never decides. An allow stays an allow and carries
  // only the documented `systemMessage` channel — no `hookSpecificOutput`, so no
  // auto-approval and no denial.
  const allow: Decision = { action: "allow", rule: "none", reason: "" };
  const heredocCommand = "cat > probe.ts <<'EOF'\nconst x = 1;\nEOF\n";
  expect(heredocAuthoringNotice("Bash", heredocCommand)).toContain("[command_guard:heredoc_authoring]");
  const announced = JSON.parse(hookOutput(allow, "Bash", heredocCommand)!) as Record<string, unknown>;
  expect(String(announced.systemMessage)).toContain("NOT evidence");
  expect(announced.hookSpecificOutput).toBeUndefined();
  // Refutation, three ways: an ordinary Bash command, a here-STRING (`<<<`), and
  // PowerShell (whose here-string is `@'…'@`) all announce nothing.
  expect(heredocAuthoringNotice("Bash", "git rev-parse --verify HEAD")).toBeNull();
  expect(heredocAuthoringNotice("Bash", "grep -c EOF <<<\"$body\"")).toBeNull();
  expect(heredocAuthoringNotice("PowerShell", heredocCommand)).toBeNull();
  expect(hookOutput(allow, "Bash", "git rev-parse --verify HEAD")).toBeNull();

  // ── W-780 / W-735: the producer is TOLD the register file contract, and it
  // names ONE path to author ────────────────────────────────────────────────
  const withResult = promptPreamble(
    parsed, DISPATCH_ID, "branch", "abc1234", "/container", "self", "opus", "claude-code", "/container/report.md",
    undefined, undefined, "attended-agent",
  );
  expect(withResult).toContain("Register FILE contract (W-780 / W-735)");
  expect(withResult).toContain("retired body-regex form");
  expect(withResult).toContain("write your register to /container/lane/register.md");
  expect(withResult).toContain("commit = '<commit SHA>'");
  expect(withResult).not.toContain("commit = 'proxy pending'");
  expect(withResult).not.toContain("=== COMMIT PLAN ===");
  expect(withResult).not.toContain("Garelier-Seat: codex");
  // W-735 (PM 裁定 2026-09-11): the capture leaf is the DRIVER's file and the
  // producer is told so, rather than being given it as a first choice with a
  // fallback. The old wording ("if the harness REFUSES writing …/report.md,
  // write the identical register to …/lane/register.md") is two paths and an
  // "identical bytes" rule between them — the rule every claude lane since #466
  // has had to break, because the harness refuses that name by design.
  expect(withResult).toContain("Do NOT write /container/report.md yourself");
  expect(withResult).not.toContain("If the harness REFUSES");
  expect(withResult).not.toContain("identical register");
  // The writable-artifact list names the same one path, so the two sentences a
  // producer reads cannot disagree about which file it authors.
  expect(withResult).toContain("canonical artifacts (/container/lane/register.md,");
  // The OTHER claude transport lands on the same leaf, so a lane does not have to
  // know which of the two it is to know where it writes.
  expect(promptPreamble(
    parsed, DISPATCH_ID, "branch", "abc1234", "/container", "self", "opus", "claude-code", "/container/report.md",
    undefined, undefined, "claude-subprocess",
  )).toContain("write your register to /container/lane/register.md");
  // Refutation: on a lane whose captured leaf ALREADY is the producer's (codex
  // writes `lane/result.md`), the same contract names that file and adds no
  // second path — the rule is "one path", not "always lane/register.md".
  const codexResult = promptPreamble(
    parsed, DISPATCH_ID, "branch", "abc1234", "/container", "self", "opus", "codex", "/container/lane/result.md",
    undefined, undefined, "codex-cli",
  );
  expect(codexResult).toContain("write your register to /container/lane/result.md");
  expect(codexResult).not.toContain("Do NOT write");
  expect(codexResult).not.toContain("/container/lane/register.md");
  const codexProxyResult = promptPreamble(
    parsed, DISPATCH_ID, "branch", "abc1234", "/container", "proxy", "gpt", "codex", "/container/lane/result.md",
    undefined, undefined, "codex-cli",
  );
  expect(codexProxyResult).toContain("commit = 'proxy pending'");
  expect(codexProxyResult).toContain("=== COMMIT PLAN ===");
  expect(codexProxyResult).toContain("Garelier-Seat: codex");
  // W-789 refutation: even when recovery cannot type the transport, the captured
  // container-root report.md proves that it is driver-owned. The producer leaf
  // is derived from that capture face and never falls back to telling the role
  // to author report.md.
  const unknownTransport = promptPreamble(
    parsed, DISPATCH_ID, "branch", "abc1234", "/container", "self", "opus", "claude-code", "/container/report.md",
  );
  expect(unknownTransport).toContain("write your register to /container/lane/register.md");
  expect(unknownTransport).toContain("Do NOT write /container/report.md yourself");
  // A lane with no captured result path has no register leaf to name.
  expect(claude).not.toContain("Register FILE contract (W-780");

  // ── W-783 AC-4: the runtime policy names WHERE a long-running log goes ─────
  // The sentence a dispatched role actually receives said "long-running commands
  // write a log file" and named no destination, while the shape that cost #523 a
  // round — `lane/w318-full.log` at the lane ROOT — is unknown scratch that stops
  // cleanup (W-782 Observer N-1). The destination is now IN the policy, and it is
  // the one the retention contract row names, so the two faces cannot send a role
  // to two places for the same artifact.
  expect(RUNTIME_POLICY).toMatch(/long-running commands write a log file under <container>\/lane\/logs\//);
  expect(RUNTIME_POLICY).toContain("a log at the lane root is unknown scratch and stops cleanup");
  const retention = readFileSync(resolve(import.meta.dir, "../../../retention.md"), "utf8");
  expect(retention).toContain("lane/logs/");
  expect(retention).toContain("your own run logs");
  // Refutation, both directions. (a) The pre-W-783 sentence — the same words with
  // no destination — fails the match above, so the assertion measures the
  // destination rather than the topic. (b) `showcase/<topic>/` is a DIFFERENT
  // retention row (promotable transient artifacts, W-165) and the policy does not
  // name it, so "where does my run log go" has one answer.
  expect(/long-running commands write a log file under <container>\/lane\/logs\//
    .test("Garelier runtime policy: long-running commands write a log file; final subagent"
      + " output must end with GARELIER_RUNTIME_STATUS.")).toBeFalse();
  expect(RUNTIME_POLICY).not.toContain("showcase");
  expect(claude).toContain("showcase/<topic>/");
});

// ── AC-4 / end-to-end with the REAL gate_runner ───────────────────────────────

test("W-641 AC-4: a claude register with the block reaches GREEN through the real gate_runner and issues a Guardian seat; without the block it is REGISTER_REFUSED and no seat is issued", async () => {
  const green = attendedFixture("attended-agent", true);
  const greenResult = await runReviewPrepare(
    { project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base },
    reviewDeps(green),
  );
  const greenAccounting = readFileSync(greenResult.final_accounting, "utf8");
  const diagnosticLog = join(green.container, "lane", `gate-${greenResult.review_sha.slice(0, 12)}.log`);
  expect(greenResult.gate.code, JSON.stringify({
    message: greenResult.gate.message, log: diagnosticLog,
    output: existsSync(diagnosticLog) ? readFileSync(diagnosticLog, "utf8") : "gate log missing",
  })).toBe(0);
  expect(greenAccounting).toContain("- Gate result: GREEN (exit 0)");
  // W-693 / W-691: the seal states which run it binds and which checkout's gate
  // scripts produced it. The first pass has no run to bind and no driver change.
  expect(greenResult.gate_run_source).toBe("executed");
  expect(greenResult.gate_script_source).toBe("studio");
  expect(greenAccounting).toContain("- Gate script source: studio");
  expect(greenAccounting).toContain("- Gate run source: executed (no terminal gate run in the review log)");
  // W-779 AC-1: a COVERED verdict is issued by the register audit BEFORE any
  // step runs, so on its own it names the step DECLARED to cover the path. The
  // run's own census names the declared steps its executed commands stand
  // behind. _workshop #520 (2026-09-10) reported `ci.ts`, `ci_unit_process.ts`
  // and `ci_test_timeout.test.ts` as COVERED over a census in which no executed
  // step covered them, and the Observer had to re-derive that by hand from the
  // log. Both directions over one fixture shape, with the census as the only
  // difference between the two calls.
  const coverageBinding = async (census: string): Promise<{ coverage: string; accounting: string }> => {
    const fixture = attendedFixture();
    const result = await runReviewPrepare(
      { project: fixture.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: fixture.base },
      {
        ...reviewDeps(fixture),
        runGate: async (args) => {
          const log = args[args.indexOf("--log") + 1]!;
          writeFileSync(log, [
            "GATE_START run_id=w779-coverage started_at=2026-09-05T00:00:00.000Z",
            census,
            "RESULT GREEN",
            "GATE_END run_id=w779-coverage",
            "",
          ].join("\n"));
          writeGateRunRecord({
            path: gateRunRecordPath(fixture.root, PM_ID, log),
            logPath: log, runId: "w779-coverage",
            startedAt: "2026-09-05T00:00:00.000Z", endedAt: "2026-09-05T00:01:00.000Z",
            cwd: fixture.checkout, startHead: fixture.head, endHead: fixture.head,
            status: "GREEN", exit: 0,
          });
          return {
            code: 0,
            message: ["CHANGED_PATHS 1", "COVERED src/thing.txt -> probe", "RESULT GREEN"].join("\n"),
          };
        },
      },
    );
    return {
      coverage: JSON.parse(readFileSync(result.dock_review_record, "utf8")).coverage,
      accounting: readFileSync(result.final_accounting, "utf8"),
    };
  };
  const executedCovering = await coverageBinding(
    "GATE_STEP_CENSUS executed=1 skipped_green=0 executed_coverage_steps=probe",
  );
  expect(executedCovering.coverage).toBe("COVERED (1 of 1 changed paths)");
  expect(executedCovering.accounting).toContain("- Uncovered paths: none");
  const noCoveringStepRan = await coverageBinding(
    "GATE_STEP_CENSUS executed=1 skipped_green=0 executed_coverage_steps=none",
  );
  expect(noCoveringStepRan.coverage).toBe("UNCOVERED (1 of 1 changed paths)");
  expect(noCoveringStepRan.accounting).toContain("- `src/thing.txt`");

  // W-779 AC-2 through the REAL runner, on the run this test already made:
  // `src/thing.txt` is the candidate's only changed path, the register's
  // `git rev-parse` step is the declared `probe` that covers it, and that step
  // ran — so the reported coverage is what it has always been.
  expect(greenAccounting).toContain("- Coverage: COVERED (1 of 1 changed paths)");
  expect(greenAccounting).toContain("- Uncovered paths: none");
  expect(greenResult.gate.message).toContain("COVERED src/thing.txt -> probe");
  expect(readFileSync(reviewGateLogPath(green.lane, green.head), "utf8"))
    .toContain("executed_coverage_steps=probe");
  expect(readFileSync(greenResult.gate.message.includes("log=")
    ? greenResult.gate.message.split("log=")[1]!.split("\n")[0]!
    : join(green.lane, `gate-${green.head.slice(0, 12)}.log`), "utf8")).toContain("RESULT GREEN");


  const greenHandoff = inspectDockReviewHandoff({ project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID });
  expect(greenHandoff.ready).toBeTrue();
  expect(runAttendedSpawn({
    role: "guardian", project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID,
    slug: "w641-parity", worktree: green.checkout,
  } as any, green.root).name).toBe("ga-guardian-w641-parity");

  // ── W-712 (DEC-100 ruling 3): seat issuance decides identity / staleness ────
  // Each case mutates exactly one input of the SAME lane that just issued a
  // seat, so the "before" is the assertion three lines up: with the mutation
  // reverted the seat is issued again, which is the (b) direction of every
  // refutation below. Mutating the seal is legitimate — it is the record
  // itself, not one of the artifacts it digests.
  const sealPath = greenResult.dock_review_record;
  const sealBytes = readFileSync(sealPath, "utf8");
  const withSeal = (patch: Record<string, unknown>): void =>
    writeFileSync(sealPath, `${JSON.stringify({ ...JSON.parse(sealBytes), ...patch }, null, 2)}\n`);
  const refusal = (f: Fixture = green): string => {
    const seat = inspectDockReviewHandoff({ project: f.root, pmId: PM_ID, dispatchId: DISPATCH_ID });
    expect(seat.ready).toBeFalse();
    expect(() => runAttendedSpawn({
      role: "guardian", project: f.root, pmId: PM_ID, dispatchId: DISPATCH_ID,
      slug: "w641-parity", worktree: f.checkout,
    } as any, f.root)).toThrow("Dock review handoff postcondition failed");
    return seat.reason;
  };

  // AC-1: the #539 r10 / #538 r11 shape — context.json bound to the integration
  // branch. The gate seat was the ONLY thing that ever caught it, one round late.
  // The branch is rewritten BEFORE review_prepare runs, which is what actually
  // happened: the accounting is then written FROM the wrong branch and agrees
  // with it, so every content check passes and only the topology is wrong. (A
  // rewrite after the seal is a different defect — the accounting stops matching
  // — and would not measure this one.)
  for (const [wrong, expected] of [
    ["garelier/feature-none-soft/pm1/studio", "binds a non-review branch"],
    ["garelier/feature-none-soft/pm1/workbench/#99/w641-parity", "whose dispatch identity is 99"],
  ] as const) {
    const misbound = attendedFixture();
    const contextPath = join(misbound.container, "context.json");
    writeFileSync(contextPath, readFileSync(contextPath, "utf8").replace(
      "garelier/feature-none-soft/pm1/workbench/#7/w641-parity", wrong,
    ));
    const sealed = await runReviewPrepare(
      { project: misbound.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: misbound.base },
      reviewDeps(misbound),
    );
    // review_prepare itself is content-complete on this lane: it sealed a GREEN,
    // fully covered run whose accounting binds the wrong branch verbatim. That
    // is exactly why the seat used to be issued.
    expect(sealed.gate.code).toBe(0);
    expect(readFileSync(sealed.final_accounting, "utf8")).toContain(`- Branch: \`${wrong}\``);
    expect(refusal(misbound)).toContain(expected);
  }

  // AC-2: the seal binds a different commit than the candidate HEAD.
  const otherSha = "0".repeat(39) + "1";
  withSeal({ review_sha: otherSha, engine_tree_hash: "0".repeat(64) });
  expect(refusal()).toContain(`Dock review record seals review SHA ${otherSha}`);

  // AC-5 (#464 Observer N-1): a seal whose run stated nothing about its own
  // tree. `decideGateRun` already declines to REUSE it, but seat issuance and
  // land read the seal for a different question and used to accept the silence.
  withSeal({ gate_start_head: "", gate_end_head: "" });
  expect(refusal()).toContain("carries no gate run record heads");
  withSeal({ gate_start_head: green.head, gate_end_head: green.base });
  expect(refusal()).toContain("heavy gate run measured");

  // Reverted: the seat issues again, so every refusal above is attributable to
  // its own mutation and not to fixture damage.
  writeFileSync(sealPath, sealBytes);
  expect(inspectDockReviewHandoff({ project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID }).ready).toBeTrue();

  // W-809 / GDN-550-002: a control/docs-only advance does NOT reuse the old
  // exact-SHA scan/handoff. Re-running review_prepare emits fresh scans at the
  // new SHA while reusing only the Dock-sealed heavy gate; an engine byte then
  // invalidates even that heavy-step fallback.
  const sameTreeFixture = attendedFixture();
  await runReviewPrepare(
    { project: sameTreeFixture.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: sameTreeFixture.base },
    reviewDeps(sameTreeFixture),
  );
  mkdirSync(join(sameTreeFixture.checkout, "docs"), { recursive: true });
  writeFileSync(join(sameTreeFixture.checkout, "docs", "control-note.md"), "control-only\n");
  gitIn(sameTreeFixture.checkout, "add", "docs/control-note.md");
  gitIn(sameTreeFixture.checkout, "commit", "-q", "-m", "control-only base-track fixture");
  const controlOnlyHead = gitIn(sameTreeFixture.checkout, "rev-parse", "HEAD");
  expect(refusal(sameTreeFixture)).toContain(`seals review SHA ${sameTreeFixture.head}`);
  const reuseDeps = reviewDeps(sameTreeFixture);
  let heavyGateRuns = 0;
  const controlReuse = await runReviewPrepare(
    { project: sameTreeFixture.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: sameTreeFixture.base },
    { ...reuseDeps, runGate: async (...args) => { heavyGateRuns++; return reuseDeps.runGate(...args); } },
  );
  expect(controlReuse.review_sha).toBe(controlOnlyHead);
  expect(controlReuse.gate_run_source).toBe("reused");
  expect(heavyGateRuns).toBe(0);
  const sameTree = inspectDockReviewHandoff({ project: sameTreeFixture.root, pmId: PM_ID, dispatchId: DISPATCH_ID });
  expect(sameTree.ready, sameTree.reason).toBeTrue();
  expect(sameTree.review_sha).toBe(controlOnlyHead);
  expect(sameTree.reason).toContain("current HEAD scans and a Dock-sealed heavy gate");
  expect(JSON.parse(readFileSync(controlReuse.scanner_evidence_json, "utf8")).head).toBe(controlOnlyHead);
  writeFileSync(join(sameTreeFixture.checkout, "src", "engine-change.txt"), "engine changed\n");
  gitIn(sameTreeFixture.checkout, "add", "src/engine-change.txt");
  gitIn(sameTreeFixture.checkout, "commit", "-q", "-m", "engine change fixture");
  expect(refusal(sameTreeFixture)).toContain("but current HEAD");

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
    "+++", "[lane]", "state = 'REPORTING'", "[gate]", `review_sha = '${green.head}'`,
    ...(runId === null ? [] : [`gate_run_id = '${runId}'`]),
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
  // W-808: changing the registered command now also requires a PM declaration
  // update. Keep this older reuse oracle on the admitted path by advancing the
  // coordinator-bound set and its context mirror before asking the runner to
  // execute the substitution.
  const greenContextPath = join(green.container, "context.json");
  const greenContext = JSON.parse(readFileSync(greenContextPath, "utf8"));
  const defaultGateEntry = {
    name: "default", commands: [REGISTER_STEP], source: "project-default", declared_at: "2026-09-13T00:00:00.000Z",
  };
  const substitutedGateEntry = {
    name: "inline-substituted", commands: [substitutedStep], source: "update-cli", declared_at: "2026-09-14T00:00:00.000Z",
  };
  gitIn(green.root, "init", "--initial-branch=main");
  gitIn(green.root, "config", "user.name", "Fixture");
  gitIn(green.root, "config", "user.email", "fixture.invalid");
  const gateAuthorityPath = join(green.root, "w808-authority.md");
  writeFileSync(gateAuthorityPath, "# W-808 fixture authority\n");
  gitIn(green.root, "add", "w808-authority.md");
  gitIn(green.root, "commit", "-m", "fixture authority");
  const gateAuthorization = issueRoleAuthorization({
    project_root: green.root,
    pm_id: PM_ID,
    identity: dispatchExecutionIdentity(DISPATCH_ID),
    role: "worker",
    carabiner: "implementation",
    item: { work_id: "W-808", revision: "fixture", session_id: "fixture", authority_path: gateAuthorityPath },
    assignment_path: gateAuthorityPath,
    prompt_path: gateAuthorityPath,
    routing: { provider: "attended-agent", model: "test", effort: "medium", source: "fixture" },
    lens: { ref: null, source: "none", registry_path: null, pack_path: null },
    knowledge: resolveRoleKnowledgeBinding({ projectRoot: green.root, pmId: PM_ID, role: "worker", required: [] }),
    integration: { ref: "studio", base_sha: green.base },
    quality_gate_selection: { current: defaultGateEntry, history: [defaultGateEntry] },
    issuer: { role: "dock", id: "fixture" },
  });
  greenContext.producer_binding = bindingReference(gateAuthorization);
  greenContext.quality_gate_selection = {
    current: defaultGateEntry,
    history: [defaultGateEntry],
  };
  writeFileSync(greenContextPath, `${JSON.stringify(greenContext, null, 2)}\n`);
  updateRoleQualityGateSelection({
    project_root: green.root,
    pm_id: PM_ID,
    reference: bindingReference(gateAuthorization),
    expected_context_selection: greenContext.quality_gate_selection,
    next: substitutedGateEntry,
    writer: { role: "pm", id: "fixture-pm" },
  });
  greenContext.quality_gate_selection = {
    current: substitutedGateEntry,
    history: [defaultGateEntry, substitutedGateEntry],
  };
  writeFileSync(greenContextPath, `${JSON.stringify(greenContext, null, 2)}\n`);
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
  {
    const green = attendedFixture();
    await runReviewPrepare({ project: green.root, pmId: PM_ID, dispatchId: DISPATCH_ID, expectedStudioSha: green.base }, reviewDeps(green));
    // Direct merge_request admission, with valid G/O retained and --no-poll:
    // no merge or provider is launched. Negative cases may not publish a queue
    // request or close authorization; the exact same candidate then submits.
    const landBranch = "garelier/feature-none-soft/pm1/workbench/#7/w641-parity";
    gitIn(green.checkout, "branch", landBranch, green.head);
    gitIn(green.root, "init", "--initial-branch=main");
    gitIn(green.root, "config", "user.name", "Fixture");
    gitIn(green.root, "config", "user.email", "fixture@example.invalid");
    const authority = join(green.root, "authority.md");
    writeFileSync(authority, "# W712 fixture authority\n");
    gitIn(green.root, "add", "authority.md");
    gitIn(green.root, "commit", "-m", "fixture authority");
    const ledger = join(green.container, "instructions.md");
    writeFileSync(ledger, "+++\n[ledger]\nkind = 'role_instruction_ledger_v1'\n+++\n");
    const issued = issueRoleAuthorization({
      project_root: green.root, pm_id: PM_ID, identity: dispatchExecutionIdentity(DISPATCH_ID),
      role: "worker", carabiner: "implementation", item: { work_id: "W-712", revision: "1", session_id: "fixture", authority_path: authority },
      assignment_path: authority, prompt_path: authority, initial_instructions_path: ledger,
      routing: { provider: "attended-agent", model: "test", effort: "medium", source: "fixture" },
      lens: { ref: null, source: "none", registry_path: null, pack_path: null },
      knowledge: resolveRoleKnowledgeBinding({ projectRoot: green.root, pmId: PM_ID, role: "worker", required: [] }),
      integration: { ref: "studio", base_sha: green.base }, issuer: { role: "dock", id: "fixture" }
    });
    acknowledgeRoleLaunch({
      project_root: green.root, pm_id: PM_ID, identity: issued.core.execution_identity,
      generation: issued.core.generation, expect_digest: issued.core_digest, transport: "attended-agent", provider_session_id: "fixture-land",
      success_evidence: "fixture launch", writer: { role: "attended-parent", id: "fixture" }
    });
    writeFileSync(join(green.container, "control_binding.json"), JSON.stringify({ dispatch_id: DISPATCH_ID }));
    const guardian = join(green.lane, "guardian.md"), observer = join(green.lane, "observer.md");
    for (const path of [guardian, observer]) writeFileSync(path, `+++\n[verdict]\nresult = 'PASS'\nreview_sha = '${green.head}'\n+++\n`);
    const landArgs = [process.execPath, join(import.meta.dir, "merge_request.ts"), "--project", green.root, "--target-root", green.checkout,
      "--pm-id", PM_ID, "--branch", landBranch, "--studio", "studio", "--guardian", "PASS", "--guardian-report", guardian,
      "--observer", "PASS", "--observer-report", observer, "--report", green.report, "--quality-gate", REGISTER_STEP, "--no-poll"];
    const submit = () => Bun.spawnSync(landArgs, { windowsHide: true, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const runRecord = gateRunRecordPath(green.root, PM_ID, reviewGateLogPath(green.lane, green.head));
    const runBytes = readFileSync(runRecord, "utf8");
    const beforeHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const retained = new Map([guardian, observer, green.report].map(path => [path, beforeHash(path)]));
    const queue = join(green.root, "__garelier", PM_ID, "runtime/merge_gate/requests");
    const bindingPaths = roleBindingPaths(green.root, PM_ID, issued.core.execution_identity, issued.core.generation);
    for (const bad of [null, "{", JSON.stringify({ ...JSON.parse(runBytes), end_head: green.base })]) {
      if (bad === null) rmSync(runRecord); else writeFileSync(runRecord, bad);
      const rejected = submit();
      expect(rejected.exitCode, rejected.stderr.toString()).toBe(2);
      expect(rejected.stderr.toString()).toContain("Dock review handoff postcondition failed");
      expect(existsSync(queue)).toBeFalse();
      expect(existsSync(bindingPaths.close)).toBeFalse();
      expect(gitIn(green.checkout, "rev-parse", landBranch)).toBe(green.head);
      expect(gitIn(green.checkout, "rev-parse", "studio")).toBe(green.base);
      for (const [path, hash] of retained) expect(beforeHash(path)).toBe(hash);
    }
    writeFileSync(runRecord, runBytes);
    const submitted = submit();
    expect(submitted.exitCode, submitted.stderr.toString()).toBe(0);
    expect(existsSync(queue)).toBeTrue();
    expect(existsSync(bindingPaths.close)).toBeTrue();
    expect(gitIn(green.checkout, "rev-parse", "studio")).toBe(green.base);
    process.stdout.write("W712_DIRECT_LAND missing_malformed_mismatched_run=REFUSED queue+close=ABSENT verdicts+refs=UNCHANGED valid=QUEUED no_poll=true\n");
  }

}, 300_000);
