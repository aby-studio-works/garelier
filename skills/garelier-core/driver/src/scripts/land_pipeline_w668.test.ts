// W-668 — the land pipeline's own oracle.
//
// Scope: this suite proves the glue land_pipeline.ts owns (ordering,
// idempotence, the four halt commands, unknown-artifact preservation, the A-0
// task-file shape, both spawn transports). It does NOT re-test review_prepare /
// merge_land / dispatch_cleanup: those are injected, because re-running them
// here would measure their behavior, not this file's composition of it.
//
// One test per stage-group, per blueprint w668 §5.5.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
// W-733: destructive fs goes through the guarded wrapper, never raw node:fs.
import { rmSync } from "../guard/path_guard.ts";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LAND_PIPELINE_STAGES,
  parseLandPipelineArgs,
  renderGateTaskFile,
  renderReport,
  relaySpawnCommands,
  resolveStudioAuthority,
  runLandPipeline,
  contextControlBinding,
  transcribeRegisterToReport,
  gateArtifactPreserveRoot,
  unknownLaneArtifacts,
  type LandPipelineDeps,
  type LandPipelineResult,
  type RunOutcome,
} from "./land_pipeline.ts";
import { bindingReference, dispatchExecutionIdentity, issueRoleAuthorization, roleBindingPaths } from "../dispatch/role_binding.ts";
import { resolveRoleKnowledgeBinding } from "../dispatch/knowledge_binding.ts";
import { makeSessionRecord, writeSessionRecord } from "./provider_session.ts";
import { requireRuntimeExecutable } from "./_lib.ts";
import { seedFixtureItemAuthority } from "../dispatch/fixture_item_authority.ts";
import { REVIEW_PREPARE_DELEGATION_MARKER } from "./review_prepare.ts";
import { parseMachineArtifact } from "../dispatch/machine_artifact.ts";
import { rebindResumeCommand } from "./dispatch_prepare.ts";
import { resumeDriftRecovery } from "./provider_session.ts";
import { extractVerdict } from "../merge_gate_parse.ts";
import { checkGate } from "../dispatch/contract_check.ts";
import { gateArtifactPreserveRoot as aftercarePreserveRoot, isKnownLaneArtifact, isKnownLaneEntry } from "../dispatch/land_aftercare.ts";
import { isPmStepGateLog, pmStepGateLogName, preservePmStepGateLogs } from "../dispatch/gate_step_artifacts.ts";
import {
  isUnfilledRoleReport,
  mergedEvidenceBody,
  unfilledRoleReportPlaceholders,
} from "../control/garelier_integration.ts";
import type { EvidenceReference } from "../control/types.ts";
import { TASK_FILE_SECTION_HEADINGS } from "../dispatch/prompt_section_contract.ts";
import { inspectPromptSections } from "../dispatch/prompt_section_contract.ts";

const ROOTS: string[] = [];
afterEach(() => {
  while (ROOTS.length > 0) rmSync(ROOTS.pop()!, { recursive: true, force: true });
});

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const STUDIO = "c".repeat(40);

interface Fixture {
  project: string;
  container: string;
  lane: string;
  calls: Array<{ script: string; args: string[]; env?: Record<string, string> }>;
}

function fixture(options: { laneExtras?: Record<string, string>; register?: string } = {}): Fixture {
  const project = mkdtempSync(join(tmpdir(), "garelier-land-pipeline-"));
  ROOTS.push(project);
  const container = join(project, "__garelier", "pm1", "_crew", "dispatch7");
  const lane = join(container, "lane");
  mkdirSync(lane, { recursive: true });
  mkdirSync(join(container, "checkout"), { recursive: true });
  mkdirSync(join(project, "__garelier", "pm1", "runtime", "guardian", "results"), { recursive: true });
  mkdirSync(join(project, "__garelier", "pm1", "runtime", "observer", "results"), { recursive: true });
  writeFileSync(join(container, "context.json"), JSON.stringify({
    task: { id: 7, slug: "demo-slug", branch: "garelier/t/pm1/workbench/#7/demo-slug", base_sha: BASE },
    project: { integration_branch: "garelier/t/pm1/studio" },
    anchors: { source: "__garelier/pm1/control/blueprints/demo.md" },
    gate_agents: {
      guardian: { name: "ga-guardian-demo-slug", model: "opus", report: "runtime/guardian/results/demo-slug-guardian.md" },
      observer: { name: "ga-observer-demo-slug", model: "opus", report: "runtime/observer/results/demo-slug-observer.md" },
    },
    // The schema-3 control binding dispatch_prepare writes, and the authority
    // stage 2 transcribes into the landed report's `[control]` (W-782 AC-3).
    control: { schema_version: 3, work_id: "W-668", session_id: "cs_pipeline", claim_owned: true },
  }));
  writeFileSync(join(lane, "result.md"), options.register ?? [
    "+++", "[lane]", "state = 'REPORTING'", "", "[gate]", `declared_base_sha = '${BASE}'`, "+++", "",
    "# register", "", "done.", "",
  ].join("\n"));
  writeFileSync(join(lane, "final_accounting.md"), `Review SHA: ${HEAD}\nGate result: GREEN\n`);
  for (const [name, body] of Object.entries(options.laneExtras ?? {})) writeFileSync(join(lane, name), body);
  return { project, container, lane, calls: [] };
}

/** The subset of dispatch_prepare's published JSON the relay reads, in the
 * exact shape dispatch_prepare emits for a claude-code / attended-agent gate
 * seat (provider_parent_routes; codex_cli BLOCKed for a claude seat). */
export function preparedGateSeatJson(role: "guardian" | "observer", id: string): Record<string, any> {
  return {
    id: Number(id),
    agent_name: `ga-${role}-demo-slug`,
    provider_parent_routes: {
      claude_code_parent: {
        transport: "Agent/Workflow",
        name: `ga-${role}-demo-slug`,
        model: "opus",
        message: `Execute Garelier ${role} gate for dispatch #${id}.`,
        prompt_file: "/p/prompt.md",
      },
      codex_cli: {
        transport: "blocked",
        directive: "BLOCK: configured provider is Claude; use claude_code_parent and do not substitute Codex CLI",
      },
    },
    gate_agents: {
      guardian: { name: "ga-guardian-demo-slug" },
      observer: { name: "ga-observer-demo-slug" },
    },
  };
}

function deps(fx: Fixture, outcomes: Record<string, RunOutcome> = {}): LandPipelineDeps {
  const ok: RunOutcome = { exitCode: 0, stdout: "", stderr: "" };
  return {
    runScript: (script, args, env) => {
      fx.calls.push({ script, args, env });
      const key = script.replace(/\\/g, "/").split("/").pop()!;
      if (key === "dispatch_prepare.ts" && args.includes("--attended-seat")) {
        return { exitCode: 0, stdout: JSON.stringify({ name: "ga-dock-demo", record_path: `${fx.project}/rec.json` }), stderr: "" };
      }
      if (key === "dispatch_prepare.ts" && args.includes("--role") && !args.includes("--rebind-authority")) {
        const role = args[args.indexOf("--role") + 1] as "guardian" | "observer";
        const seatId = role === "guardian" ? "8" : "9";
        // Mirror the real command: publish ready.json into a seat container, so
        // the idempotence path has the same artifact to relay from.
        const seat = join(fx.project, "__garelier", "pm1", "_crew", `dispatch${seatId}`);
        mkdirSync(seat, { recursive: true });
        writeFileSync(join(seat, "context.json"), JSON.stringify({ task: { id: Number(seatId), role, slug: "demo-slug" } }));
        // A prepared seat declares the candidate it reviews (A-0 `## Review SHA`).
        writeFileSync(join(seat, "assignment.md"), `## Review SHA\n\nreview_sha: ${HEAD}\n`);
        writeFileSync(join(seat, "ready.json"), JSON.stringify(preparedGateSeatJson(role, seatId)));
        return { exitCode: 0, stdout: JSON.stringify(preparedGateSeatJson(role, seatId)), stderr: "" };
      }
      return outcomes[key] ?? ok;
    },
    gitRun: (_cwd, args) => {
      if (args[0] === "rev-parse" && args[2]?.startsWith("HEAD")) return { exitCode: 0, stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${STUDIO}\n`, stderr: "" };
      if (args[0] === "merge-base") return { exitCode: 0, stdout: `${STUDIO}\n`, stderr: "" };
      if (args[0] === "diff") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    now: () => new Date("2026-09-03T00:00:00Z"),
  };
}

/** The same project, with a fresh call log — so "did THIS run call
 * dispatch_prepare?" is answerable for the second run alone. */
function fixtureSecondRun(fx: Fixture): Fixture {
  return { project: fx.project, container: fx.container, lane: fx.lane, calls: [] };
}

function args(project: string, extra: Partial<ReturnType<typeof parseLandPipelineArgs>> = {}) {
  return { ...parseLandPipelineArgs(["--project", project, "--pm-id", "pm1", "--id", "7"]), ...extra };
}

function writeVerdicts(
  project: string,
  options: { sha?: string; front?: string; section?: string } = {},
): void {
  const sha = options.sha ?? HEAD;
  const front = options.front ?? "PASS";
  const section = options.section ?? front;
  for (const role of ["guardian", "observer"]) {
    writeFileSync(join(project, "__garelier", "pm1", "runtime", role, "results", `demo-slug-${role}.md`),
      `+++\n[verdict]\nresult = '${front}'\nreview_sha = '${sha}'\n+++\n\n## Verdict\n\n${section}\n`);
  }
}

// ── stage 2 (F-18) ──────────────────────────────────────────────────────────

describe("report transcription (F-18)", () => {
  test("the landed [control] is the driver's, from context.json, whatever the register says", () => {
    // W-782 AC-5: the fixture is the scaffold `dispatch_prepare` WRITES TODAY —
    // front matter first, `[control]` as a typed table (W-780 AC-1). The retired
    // `<!-- garelier-control-v3 … -->` comment scaffold is gone from this file
    // for the reason the w318 fixture is built from real prepare output: an
    // oracle over a writer output that no longer exists stays GREEN while
    // measuring nothing.
    const scaffold = "+++\n[gate]\nbranch = 'b'\n\n[control]\nschema_version = '3'\nwork_id = 'W-668'\nsession_id = 'cs_x'\n+++\n\n# Report\n";
    expect(parseMachineArtifact(scaffold, "report.md").data.control)
      .toEqual({ schema_version: "3", work_id: "W-668", session_id: "cs_x" });
    const register = "+++\n[lane]\nstate = 'REPORTING'\n+++\n\n# register\n\nbody\n";

    // W-782 AC-3: the binding comes from context.json, the driver's own
    // authority, and `contextControlBinding` renders exactly the three fields
    // the scaffold does — not `claim_owned`, not any later context key.
    const control = contextControlBinding({
      control: { schema_version: 3, work_id: "W-668", session_id: "cs_x", claim_owned: true },
    });
    expect(control).toEqual({ schema_version: "3", work_id: "W-668", session_id: "cs_x" });

    const out = transcribeRegisterToReport(register, control);
    expect(out.split("\n")[0]).toBe("+++");
    const parsed = parseMachineArtifact(out, "report.md");
    expect((parsed.data.control as Record<string, string>).work_id).toBe("W-668");
    expect((parsed.data.control as Record<string, string>).session_id).toBe("cs_x");
    expect(parsed.body).toContain("body");
    // Idempotent: transcribing the product again changes nothing.
    expect(transcribeRegisterToReport(register, control)).toBe(out);

    // The refutation (W-780 Observer N-1, measured on the candidate): a producer
    // that writes its OWN work_id into the register — as a `[control]` table or
    // as the retired comment — does not get to choose the provenance the land
    // commits. Both carriers used to win once the scaffold stopped carrying one.
    for (const hostile of [
      "+++\n[lane]\nstate = 'REPORTING'\n\n[control]\nschema_version = '3'\nwork_id = 'W-999'\nsession_id = 'cs_PRODUCER'\n+++\n\n# register\n\nbody\n",
      `<!-- garelier-control-v3 work_id=W-999 session_id=cs_PRODUCER -->\n${register}`,
    ]) {
      const landed = parseMachineArtifact(transcribeRegisterToReport(hostile, control), "report.md");
      expect(landed.data.control).toEqual({ schema_version: "3", work_id: "W-668", session_id: "cs_x" });
      expect(landed.body).toContain("body");
    }
    // …and where the driver has NO binding to state, the producer's table is
    // dropped rather than promoted: `[control]` is driver-owned or absent.
    expect(contextControlBinding({ control: { work_id: "W-668" } })).toBeNull();
    expect(contextControlBinding({})).toBeNull();
    const unbound = parseMachineArtifact(transcribeRegisterToReport(
      "+++\n[lane]\nstate = 'REPORTING'\n\n[control]\nwork_id = 'W-999'\n+++\n\n# register\n\nbody\n", null,
    ), "report.md");
    expect(Object.hasOwn(unbound.data, "control")).toBeFalse();
    const fx = fixture();
    const assignment = join(fx.project, "task.md");
    const prompt = join(fx.lane, "prompt.md");
    writeFileSync(prompt, "Bound pipeline fixture.");
    const init = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", fx.project, "init", "-q", "-b", "main"],
      { stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 30_000 });
    expect(init.exitCode).toBe(0);
    seedFixtureItemAuthority(fx.project, [{ rel: "task.md", content: "# Pipeline task\n" }]);
    const checkout = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", fx.project, "worktree", "add", "-q", "-b", "fixture-worker", join(fx.container, "checkout")],
      { stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 30_000 });
    expect(checkout.exitCode, checkout.stderr.toString()).toBe(0);
    const authorization = issueRoleAuthorization({
      project_root: fx.project, pm_id: "pm1", identity: dispatchExecutionIdentity(7),
      role: "worker", carabiner: "implementation",
      item: { work_id: "W-668", revision: "1", session_id: "cs_pipeline", authority_path: assignment },
      assignment_path: assignment, prompt_path: prompt,
      routing: { provider: "codex-cli", model: "fixture", effort: "high", source: "flag" },
      lens: { ref: null, source: "none", registry_path: null, pack_path: null },
      knowledge: resolveRoleKnowledgeBinding({ projectRoot: fx.project, pmId: "pm1", role: "worker", required: [] }),
      integration: { ref: "main", base_sha: HEAD }, issuer: { role: "dock", id: "pipeline-fixture" },
    });
    const binding = bindingReference(authorization);
    const contextPath = join(fx.container, "context.json");
    const context = JSON.parse(readFileSync(contextPath, "utf8"));
    context.producer_binding = binding;
    writeFileSync(contextPath, JSON.stringify(context));
    const readyPath = join(fx.container, "ready.json");
    const ready = { provider_transport: "codex-cli", role_binding: binding };
    writeFileSync(readyPath, JSON.stringify(ready));
    const currentResult = join(fx.lane, "followup.result.md");
    // The register the REAL pipeline transcribes claims a work_id of its own, so
    // the end-to-end assertion below measures provenance and not just shape.
    writeFileSync(currentResult, register
      .replace("# register", "# current register")
      .replace("state = 'REPORTING'", "state = 'REPORTING'\n\n[control]\nschema_version = '3'\nwork_id = 'W-999'\nsession_id = 'cs_PRODUCER'"));
    const sessionPath = join(fx.lane, "session.json");
    writeSessionRecord(sessionPath, makeSessionRecord("codex-cli", "fixture-session",
      join(fx.container, "checkout"), "ready", currentResult, undefined,
      authorization.core.routing, [], { ownershipId: `launch-${authorization.core_digest}` }));
    const currentReport = join(fx.container, "report.md");
    const oldResult = join(fx.lane, "result.md");
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const contextBytes = readFileSync(contextPath);
    const readyBytes = readFileSync(readyPath);
    const sessionBytes = readFileSync(sessionPath);
    const pointer = roleBindingPaths(fx.project, "pm1", dispatchExecutionIdentity(7)).current;
    const pointerBytes = readFileSync(pointer);
    // Each vector stays inside this existing transcription definition.
    for (const mutation of ["ready-missing", "ready-malformed", "ready-stale", "context-erased",
      "context-stale", "session-missing", "session-malformed", "session-stale", "authority-malformed"]) {
      writeFileSync(contextPath, contextBytes); writeFileSync(readyPath, readyBytes);
      writeFileSync(sessionPath, sessionBytes); writeFileSync(pointer, pointerBytes);
      writeFileSync(currentReport, out);
      if (mutation === "ready-missing") rmSync(readyPath);
      if (mutation === "ready-malformed") writeFileSync(readyPath, "{broken");
      if (mutation === "ready-stale") writeFileSync(readyPath, JSON.stringify({ ...ready, role_binding: { ...binding, generation: 99 } }));
      if (mutation === "context-erased") writeFileSync(contextPath, JSON.stringify({ ...context, producer_binding: null }));
      if (mutation === "context-stale") writeFileSync(contextPath, JSON.stringify({ ...context, producer_binding: { ...binding, generation: 99 } }));
      if (mutation === "session-missing") rmSync(sessionPath);
      if (mutation === "session-malformed") writeFileSync(sessionPath, "{broken");
      if (mutation === "session-stale") writeFileSync(sessionPath, JSON.stringify({ ...JSON.parse(sessionBytes.toString()), ownership_id: "launch-stale" }));
      if (mutation === "authority-malformed") writeFileSync(pointer, "{broken");
      const before = [hash(oldResult), hash(currentReport)];
      const trial = fixtureSecondRun(fx);
      const result = runLandPipeline(args(fx.project), deps(trial));
      expect(result.complete, mutation).toBe(false);
      expect([hash(oldResult), hash(currentReport)], mutation).toEqual(before);
      expect(trial.calls, mutation).toEqual([]);
    }
    writeFileSync(contextPath, contextBytes); writeFileSync(readyPath, readyBytes);
    writeFileSync(sessionPath, sessionBytes); writeFileSync(pointer, pointerBytes);
    const valid = runLandPipeline(args(fx.project), deps(fx));
    expect(valid.stages.find(stage => stage.stage === "report")?.outcome).toBe("done");
    expect(readFileSync(currentReport, "utf8")).toContain("# current register");
    // W-782 AC-3 end to end: the landed report carries the CONTEXT's binding,
    // not the `W-999` / `cs_PRODUCER` the transcribed register asked for.
    expect(parseMachineArtifact(readFileSync(currentReport, "utf8"), "report.md").data.control)
      .toEqual({ schema_version: "3", work_id: "W-668", session_id: "cs_pipeline" });
    const legacy = fixture();
    const legacyRun = runLandPipeline(args(legacy.project), deps(legacy));
    expect(legacyRun.stages.find(stage => stage.stage === "report")?.outcome).toBe("done");
    process.stdout.write("W712_PIPELINE_REGISTER current=TRANSCRIBED legacy=TRANSCRIBED invalid_handoff=REFUSED hashes=UNCHANGED\n");

  });

  // LP-6: the two templates a role copies must themselves satisfy the readers
  // that consume them. Before W-668 neither did: report.md had no front matter
  // at all, and gate_verdict.md had no `## Verdict` section.
  test("templates/report.md opens with front matter; templates/gate_verdict.md carries both verdict surfaces", () => {
    const templates = join(import.meta.dir, "..", "..", "..", "templates");
    const report = readFileSync(join(templates, "report.md"), "utf8");
    expect(report.split("\n")[0]).toBe("+++");
    const reportFront = parseMachineArtifact(report, "templates/report.md");
    expect(Object.keys(reportFront.data).sort()).toEqual(["control", "gate"]);

    const verdictTemplate = readFileSync(join(templates, "gate_verdict.md"), "utf8");
    expect(verdictTemplate).toContain("\n## Verdict\n");
    // Fill the template's placeholders the way a gate role does, then run BOTH
    // readers over the product.
    const filled = verdictTemplate
      .replaceAll("{{PASS | PASS_WITH_NOTES | REWORK_RECOMMENDED | BLOCK | NO_OPINION}}", "PASS")
      .replace("{{head_sha}}", HEAD);
    expect(extractVerdict(filled)).toBe("PASS");
    const runtime = mkdtempSync(join(tmpdir(), "garelier-verdict-template-"));
    ROOTS.push(runtime);
    mkdirSync(join(runtime, "guardian", "results"), { recursive: true });
    writeFileSync(join(runtime, "guardian", "results", "demo-slug-guardian.md"), filled);
    expect(checkGate(runtime, "demo-slug", ["guardian"]).violations).toEqual([]);
  });
});

// ── stage 3 (F-22) ──────────────────────────────────────────────────────────

describe("expected studio authority (F-22)", () => {
  test("uses the newest contained studio commit, demands base-track only on real overlap, and reads a delegated gate+seal", () => {
    const tip = "d".repeat(40);
    const contained = "e".repeat(40);
    const mkGit = (candidate: string[], drift: string[]): LandPipelineDeps["gitRun"] => (_cwd, argv) => {
      if (argv[0] === "rev-parse") return { exitCode: 0, stdout: `${tip}\n`, stderr: "" };
      if (argv[0] === "merge-base") return { exitCode: 0, stdout: `${contained}\n`, stderr: "" };
      const range = argv[argv.indexOf("-z") + 1] ?? "";
      const names = range.startsWith(BASE) ? candidate : drift;
      return { exitCode: 0, stdout: `${names.join("\0")}${names.length ? "\0" : ""}`, stderr: "" };
    };
    const disjoint = resolveStudioAuthority("/c", "studio", BASE, HEAD, mkGit(["a.ts"], ["z.ts"]));
    expect(disjoint.contained).toBe(contained);
    expect(disjoint.tip).toBe(tip);
    expect(disjoint.overlaps).toEqual([]);

    const colliding = resolveStudioAuthority("/c", "studio", BASE, HEAD, mkGit(["a.ts"], ["a.ts", "z.ts"]));
    expect(colliding.overlaps).toEqual(["a.ts"]);

    // W-743: a candidate that changes a gate-contract path does not get gated by
    // the studio scripts — review_prepare hands the gate+seal to the CANDIDATE's
    // own review_prepare.ts (§2-1d, a normal route). The pipeline read that
    // announcement as a refusal and halted a land whose delegated gate had
    // already written its log and final_accounting.md (#466 r2, 31 paths).
    // Both directions, through the real stage: the delegate's seal is read under
    // the SAME postcondition the non-delegated path uses.
    const delegation: RunOutcome = {
      exitCode: 1, stdout: "",
      stderr: "review_prepare: candidate changes 31 gate-contract path(s); "
        + `${REVIEW_PREPARE_DELEGATION_MARKER}/c/checkout/skills/garelier-core/driver/src/scripts/review_prepare.ts\n`,
    };
    const sealed = fixture();
    writeVerdicts(sealed.project);
    // The lane starts with NO seal, so the stage cannot short-circuit; the
    // delegate writes final_accounting.md during the run exactly as the real
    // candidate review_prepare.ts does, and still exits non-zero here.
    rmSync(join(sealed.lane, "final_accounting.md"), { force: true });
    const sealedDeps = deps(sealed);
    const delegatingDeps: LandPipelineDeps = {
      ...sealedDeps,
      runScript: (script, argv, env) => {
        if (script.replace(/\\/g, "/").endsWith("review_prepare.ts")) {
          writeFileSync(join(sealed.lane, "final_accounting.md"), `Review SHA: ${HEAD}\nGate result: GREEN\n`);
          return delegation;
        }
        return sealedDeps.runScript(script, argv, env);
      },
    };
    const proceeded = runLandPipeline(args(sealed.project, { resume: true } as never), delegatingDeps);
    const reviewStage = proceeded.stages.find((stage) => stage.stage === "review")!;
    expect(reviewStage.outcome).toBe("done");
    expect(reviewStage.detail).toContain("delegated gate+seal");
    // Direction 1: review no longer terminates the run — later stages execute.
    expect(proceeded.stages.map((stage) => stage.stage)).toContain("pm_step");

    // Direction 2: the same delegation with NO green seal for this review SHA
    // stops at review exactly as a refusal does, naming the delegate's gate log
    // (the file the PM has to read) rather than the delegation announcement.
    const unsealed = fixture();
    rmSync(join(unsealed.lane, "final_accounting.md"), { force: true });
    const halted = runLandPipeline(args(unsealed.project), deps(unsealed, { "review_prepare.ts": delegation }));
    expect(halted.complete).toBe(false);
    expect(halted.stages.at(-1)!.stage).toBe("review");
    expect(halted.halt_reason).toContain(`gate-${HEAD.slice(0, 12)}.log`);
    expect(halted.halt_reason).toContain("did not seal");
  });
});

// ── stage 5 (A-0) ───────────────────────────────────────────────────────────

describe("gate task file (A-0 allowlist)", () => {
  test("emits exactly the allowlisted headings and passes the machine contract", () => {
    const body = renderGateTaskFile({
      role: "guardian", seat: "ga-guardian-demo-slug", dispatchId: "7",
      branch: "garelier/t/pm1/workbench/#7/demo-slug", reviewSha: HEAD, baseSha: BASE,
      checkout: "C:\\c\\checkout", blueprint: "control/blueprints/demo.md",
      outputPath: "runtime/guardian/results/demo-slug-guardian.md",
      facts: "並行 lane = #359。",
    });
    const inspection = inspectPromptSections(body, "task_file");
    expect(inspection.forbidden).toEqual([]);
    expect(inspection.invalidFields).toEqual([]);
    // W-712 / DEC-100 裁定 3: `Dock gate` is the seat's identity/staleness item
    // and seat issuance now decides it, so the renderer no longer emits it.
    // Every OTHER canonical heading is still emitted, in order — the assertion
    // stays an equality (a heading silently dropped is still a failure), it
    // simply subtracts the one heading the ruling removed.
    expect(inspection.headings).toEqual(
      [...TASK_FILE_SECTION_HEADINGS].filter((heading) => heading !== "Dock gate"),
    );
    expect(body).not.toContain("## Dock gate");
    expect(body).not.toContain("gate-step4-");
    // Without the PM's facts body the last heading is simply absent, never empty.
    const withoutFacts = renderGateTaskFile({
      role: "observer", seat: "s", dispatchId: "7", branch: "b", reviewSha: HEAD, baseSha: BASE,
      checkout: "/c", blueprint: "bp.md", outputPath: "o.md", facts: "   ",
    });
    expect(inspectPromptSections(withoutFacts, "task_file").headings).not.toContain("Dispatch-specific facts");
    expect(withoutFacts).toContain("REWORK_RECOMMENDED");
    // The review SHA stays: it is the verdict marker's own front-matter field,
    // an OUTPUT the seat must stamp, not a fact it is asked to re-verify.
    expect(withoutFacts).toContain(`review_sha: ${HEAD}`);
  });
});

// ── stage 6 (LP-4) ──────────────────────────────────────────────────────────

describe("spawn relay (LP-4)", () => {
  test("every emitted field comes VERBATIM from the prepare JSON, including the codex BLOCK", () => {
    const ready = preparedGateSeatJson("guardian", "8");
    const emission = relaySpawnCommands("guardian", ready, "ACK-CMD");
    const claudeRoute = ready.provider_parent_routes.claude_code_parent;
    const codexRoute = ready.provider_parent_routes.codex_cli;

    // Field equality, not substring: a hand-rolled command that merely mentions
    // the right words no longer passes.
    expect(emission.seat).toBe(ready.agent_name);
    expect(emission.claude).toBe(
      `Agent(name=${claudeRoute.name}, subagent_type=claude, model=${claudeRoute.model}, prompt=${JSON.stringify(claudeRoute.message)})`,
    );
    // The seat is claude-prepared, so dispatch_prepare BLOCKs the codex route.
    // Relaying that verbatim is the only honest codex half; inventing a
    // dispatch_provider.ts line would tell the PM to do what was just refused.
    expect(emission.codex).toBe(codexRoute.directive);
    expect(emission.codex).not.toContain("dispatch_provider.ts");
    expect(emission.ack).toBe("ACK-CMD");

    // A codex-provider seat relays its launch_cmd, again verbatim.
    const codexSeat = {
      agent_name: "ga-guardian-demo-slug",
      provider_parent_routes: {
        claude_code_parent: { transport: "blocked", directive: "BLOCK: configured provider is Codex CLI; use codex_cli" },
        codex_cli: { transport: "recorded-cli", launch_cmd: "bun /d/dispatch_provider.ts --provider codex --worktree /w --prompt /p --result /r" },
      },
    };
    const relayed = relaySpawnCommands("guardian", codexSeat, "ACK-CMD");
    expect(relayed.codex).toBe(codexSeat.provider_parent_routes.codex_cli.launch_cmd);
    expect(relayed.claude).toBe(codexSeat.provider_parent_routes.claude_code_parent.directive);
  });
});

// ── stage 10 (F-21 / LP-3) ──────────────────────────────────────────────────

describe("unknown lane artifacts (F-21)", () => {
  test("a PM step-4 log is unknown to the aftercare allowlist; a canonical gate log is not", () => {
    // W-547 AC-4: the listing reads DIRENTS, because the entry type is part of
    // the one recognition rule — `locks` and `logs` are known directories, and
    // a FILE by either of those names is not one of them.
    const dirent = (name: string, directory = false) =>
      ({ name, isFile: () => !directory, isDirectory: () => directory });
    const names = [
      dirent("gate-step4-abcdef012345.log"), dirent("gate-abcdef012345.log"),
      dirent("final_accounting.md"), dirent("result.md"),
      dirent("locks", true), dirent("logs", true),
    ];
    expect(unknownLaneArtifacts("/lane", () => names)).toEqual(["gate-step4-abcdef012345.log"]);
    // Direction 2: the same two names as FILES are not the known directories,
    // and `result.md` as a DIRECTORY is not the known result leaf.
    expect(unknownLaneArtifacts("/lane", () => [dirent("locks"), dirent("logs"), dirent("result.md", true)]))
      .toEqual(["locks", "logs", "result.md"]);

    // The predicate is aftercare's own (Observer finding 4): the pipeline
    // imports it rather than restating it. Pin the whole documented set here,
    // because THIS suite runs in the gate and the aftercare suite does not fit
    // the foreground budget — a drift in either direction fails right here.
    const known = [
      "prompt.md", "result.md", "followup.md", "followup.template.md", "followup.result.md",
      "session.json", "secret-scan.md", "final_accounting.md", "recovery.result.md",
      "recovery.session.json", "scanner-abcdef012345.md", "scanner-abcdef012345.md.json",
      "gate-abcdef012345.log",
      // W-547 AC-5: mechanism-emitted and disposable with the container.
      // dispatch_prepare.ts writes `reuse-<work-id>.md` for a warm serial
      // reuse; provider_session.ts writes `<result>.resume-error.json` beside
      // the result whose resume failed. Both used to be refused by the same
      // mechanism that wrote them, which held the container's claim.
      "reuse-W-690.md", "followup.result.md.resume-error.json", "result.md.resume-error.json",
      // W-782 AC-4: the alternate register leaf a claude lane writes when the
      // harness refuses the name `report.md` (W-780). `dock_proxy` admits it and
      // PREFERS it, and until this line the same mechanism refused it as
      // producer scratch and held the container's claim (_workshop #523).
      "register.md",
    ];
    for (const name of known) expect(isKnownLaneArtifact(name)).toBe(true);
    for (const name of [
      "gate-step4-abcdef012345.log", "gate-abc.log", "scanner-abc.md", "notes.txt",
      // The sidecar is known exactly when its SUBJECT is: an unknown result
      // leaf does not become known by gaining an error suffix.
      "r2-ten-rows-register.result.md.resume-error.json", "reuse-lowercase.md", "reuse-.md",
      // The counterfactual the set exists for: widening it by two names did not
      // make it open. A `.log` at the lane ROOT is still scratch — the place a
      // producer's own run log belongs is `lane/logs/`.
      "w318-full.log", "register.txt", "foo.txt",
    ]) {
      expect(isKnownLaneArtifact(name)).toBe(false);
    }
    // And the two callers agree by construction, not by coincidence.
    expect(unknownLaneArtifacts("/lane", () => known.map((name) => dirent(name)))).toEqual([]);

    // W-782 AC-4 / W-547 AC-4: `lane/logs/**` is recognised by CONTAINMENT —
    // the framework names the directory, the producer names the files in it, so
    // a self-gate log stops being "unknown producer scratch" without any file
    // name becoming known at the lane root. Paths are relative to `lane/`.
    expect(isKnownLaneEntry(["logs"], dirent("logs", true))).toBeTrue();
    expect(isKnownLaneEntry(["logs", "w318-full.log"], dirent("w318-full.log"))).toBeTrue();
    expect(isKnownLaneEntry(["logs", "round2", "cargo.log"], dirent("cargo.log"))).toBeTrue();
    // `locks` is a known directory whose CONTENTS are not: it must be empty, and
    // aftercare enforces that structurally.
    expect(isKnownLaneEntry(["locks"], dirent("locks", true))).toBeTrue();
    expect(isKnownLaneEntry(["locks", "owner.json"], dirent("owner.json"))).toBeFalse();
    expect(isKnownLaneEntry(["foo.txt"], dirent("foo.txt"))).toBeFalse();
    expect(isKnownLaneEntry([], dirent("lane", true))).toBeFalse();

    // W-741: aftercare keeps the step-4 log out of the allowlist so it is not
    // DELETED with the container; the contract is that a remover moves it out
    // first. `dispatch_cleanup --request-id` did not, so it refused on the log
    // land_pipeline itself had written and the PM passed --force-remove every
    // time (#605). Both removers now call this one preservation, and the name
    // convention is written once — `pmStepGateLogName` produces exactly what
    // `isPmStepGateLog` accepts and what aftercare refuses.
    expect(pmStepGateLogName(HEAD)).toBe(`gate-step4-${HEAD.slice(0, 12)}.log`);
    expect(isPmStepGateLog(pmStepGateLogName(HEAD))).toBe(true);
    expect(isKnownLaneArtifact(pmStepGateLogName(HEAD))).toBe(false);

    const fx = fixture({
      laneExtras: {
        [pmStepGateLogName(HEAD)]: "RESULT GREEN\n",
        // Direction 2: a log NOT following the convention is not preserved and
        // stays refused — the detection the allowlist exists to keep.
        "gate-step4-notasha.log": "RESULT GREEN\n",
      },
    });
    const preserved = preservePmStepGateLogs({
      lane: fx.lane, project: fx.project, pmId: "pm1", workId: "W-741", dispatchId: "7",
    });
    expect(preserved).toEqual([`__garelier/pm1/control/reports/gates/W-741/dispatch7/${pmStepGateLogName(HEAD)}`]);
    expect(readFileSync(join(fx.project, preserved[0]!), "utf8")).toBe("RESULT GREEN\n");
    expect(readdirSync(fx.lane)).not.toContain(pmStepGateLogName(HEAD));
    expect(unknownLaneArtifacts(fx.lane)).toEqual(["gate-step4-notasha.log"]);
    // Idempotent: a second removal pass finds nothing left to preserve.
    expect(preservePmStepGateLogs({
      lane: fx.lane, project: fx.project, pmId: "pm1", workId: "W-741", dispatchId: "7",
    })).toEqual([]);

    // ── stage 1b (W-713 / W-721 / W-724 / W-441 / W-687) ────────────────────
    // Folded into this definition rather than added beside it: the repository
    // definition budget (`W327_CANONICAL_DEFINITION_CEILING`) is a monotonic
    // one, so a new predicate pays for itself by sharing an existing case.
    // Everything below is a pure function over inputs built here — no fixture,
    // no filesystem, so the cost of sharing the case is a few microseconds.
    // W-713 AC-3: the PM's 4th-step log and every artifact aftercare does not
    // recognise land in the SAME directory, because both callers ask the same
    // function. A second spelling would scatter one dispatch's evidence across
    // two directories.
    expect(gateArtifactPreserveRoot("/p", "pm1", "W-713", "465"))
      .toBe(aftercarePreserveRoot("/p", "pm1", "W-713", "465"));
    expect(gateArtifactPreserveRoot("/p", "pm1", "", "465"))
      .toBe(resolve("/p", "__garelier", "pm1", "control", "reports", "gates", "unassigned", "dispatch465"));

    // W-721 AC-2: the scaffolded template IS the thing six of a downstream
    // project's rows carried
    // as a "durable role completion report". Measured against the real file, so
    // the predicate cannot drift from the template it is about.
    const template = readFileSync(resolve(import.meta.dir, "..", "..", "..", "templates", "report.md"), "utf8");
    expect(isUnfilledRoleReport(template)).toBeTrue();
    expect(unfilledRoleReportPlaceholders(template).length).toBeGreaterThan(10);
    // A filled register is not, even when it quotes a placeholder while
    // explaining the template — which is why the predicate counts rather than
    // matching one sentinel.
    const filled = [
      "+++", "[lane]", "state = 'REPORTING'", "+++", "",
      "result: landed", "", "The template's `{{one-line outcome}}` slot is filled above.", "",
    ].join("\n");
    expect(isUnfilledRoleReport(filled)).toBeFalse();
    expect(unfilledRoleReportPlaceholders(filled)).toEqual(["{{one-line outcome}}"]);

    // W-724 AC-1: a land APPENDS. The #464 land replaced 45 producer-authored
    // lines on W-709 with 6 summary lines and the PM restored them from HEAD.
    const producerEvidence = ["- binder stdout was written to a pipe and dropped",
      "- the bound fact now lives in final_accounting.md",
      "- the fixture's fake binder returns the summary on stdout"].join("\n");
    const refs = [
      { kind: "commit", commit: "a".repeat(40), summary: "studio merge commit", writer: "garelier-merge-gate", observed_at: "2026-09-05T00:00:00.000Z" },
      { kind: "path", root: "control", path: "reports/merge/W-709/request-abc.json", summary: "durable merge request", writer: "garelier-merge-gate", observed_at: "2026-09-05T00:00:00.000Z" },
    ] as unknown as EvidenceReference[];
    const merged = mergedEvidenceBody(producerEvidence, refs);
    for (const line of producerEvidence.split("\n")) expect(merged).toContain(line);
    expect(merged.startsWith(producerEvidence)).toBeTrue();
    expect(merged).toContain("- commit: `" + "a".repeat(40) + "` — studio merge commit");
    // AC-2: a placeholder-only section is REPLACED, so no empty section survives.
    const fromPlaceholder = mergedEvidenceBody("- None recorded.", refs);
    expect(fromPlaceholder).not.toContain("None recorded");
    expect(fromPlaceholder.split("\n")).toHaveLength(2);
    // AC-3: re-running the same land adds nothing a second time.
    expect(mergedEvidenceBody(merged, refs)).toBe(merged);

    // W-441 AC-4 / AC-N1 / AC-N2: three drifts, three DIFFERENT details and
    // three DIFFERENT next commands. Before this, all three produced the single
    // string `error_class=Error`, because every throw on this path is a plain
    // `Error` and `boundedErrorClass` returns `error.name`. Two lanes failed
    // identically in one session and the PM diagnosed the wrong cause.
    const at = { projectRoot: "/p", pmId: "pm1", dispatchId: "465" };
    const blueprint = resumeDriftRecovery({ ...at, error: new Error("blueprint source changed: __garelier/pm1/control/blueprints/b.md") });
    const row = resumeDriftRecovery({ ...at, error: new Error("item authority source changed: __garelier/pm1/control/backlog/open/W-1.md") });
    const generation = resumeDriftRecovery({ ...at, error: new Error("role binding generation 1 is superseded by generation 2") });
    const details = [blueprint.detail, row.detail, generation.detail];
    expect(new Set(details).size).toBe(3);
    expect(new Set([blueprint.nextCommand, row.nextCommand, generation.nextCommand]).size).toBe(3);
    for (const detail of details) expect(detail).toContain("error_class=Error");
    // …and each carries the discriminator the message always had.
    expect(blueprint.detail).toContain("control/blueprints/b.md");
    expect(row.detail).toContain("W-1.md");
    expect(generation.detail).toContain("superseded by generation 2");
    // AC-N2 / AC-N3: the remedy is named, and it is a different one each time.
    expect(blueprint.nextCommand).toContain("--blueprint-update-commit");
    expect(row.nextCommand).toContain("--rebind-authority");
    expect(generation.nextCommand).toContain("--recover-role");
    // W-440: a message carrying an absolute path is dropped rather than
    // recorded, so the durable record never learns the operator's filesystem.
    expect(resumeDriftRecovery({ ...at, error: new Error("blueprint source changed: C:/private/b.md") }).detail)
      .toBe("error_class=Error");

    // W-687 AC-1: the five values a recovery moves. The published `resume_cmd`
    // kept generation 1's argv, so running the canonical documented command
    // failed 100% of the time.
    const published = ["bun", "provider_session.ts", "resume",
      "--record", "'/c/lane/session.json'", "--instruction", "'/c/lane/followup.md'",
      "--result", "'/c/lane/followup.result.md'", "--slug", "'w712'",
      "--binding-generation", "'1'", "--binding-digest", `'${"c".repeat(64)}'`].join(" ");
    const rebound = rebindResumeCommand(published, {
      "--binding-generation": "2",
      "--binding-digest": "d".repeat(64),
      "--record": "/c/lane/recovery.session.json",
      "--result": "/c/lane/recovery.result.md",
    });
    expect(rebound).toContain("'--binding-generation' '2'".replace(/'--binding-generation' /, "--binding-generation "));
    expect(rebound).toContain(`--binding-digest '${"d".repeat(64)}'`);
    expect(rebound).toContain("--record '/c/lane/recovery.session.json'");
    expect(rebound).toContain("--result '/c/lane/recovery.result.md'");
    // Every other token is byte-identical: the slug and script path a recovery
    // cannot re-derive (role/slug are forbidden inputs there) are the reason
    // this rewrites tokens instead of regenerating the command.
    expect(rebound).toContain("--slug 'w712'");
    expect(rebound).toContain("--instruction '/c/lane/followup.md'");
    expect(rebound.split(" ")).toHaveLength(published.split(" ").length);
    // A flag that is not there is a refusal, never a silent no-op — the defect
    // being fixed is a command that looked runnable and was not.
    expect(() => rebindResumeCommand("bun resume --record 'x'", { "--binding-digest": "e".repeat(64) }))
      .toThrow("does not carry it");
  });
});

// ── LP-1: the whole run ─────────────────────────────────────────────────────

describe("LP-1 full run", () => {
  test("two invocations (verdict in between) land and clean, preserving the step-4 log", () => {
    const fx = fixture({ laneExtras: { "gate-step4-aaaaaaaaaaaa.log": "RESULT GREEN\n" } });
    const stepFile = join(fx.project, "step.toml");
    writeFileSync(stepFile, `[[step]]\nname = "focused"\ncmd = "bun test x.test.ts"\n`);

    const first = runLandPipeline(args(fx.project, { pmStep: stepFile }), deps(fx));
    expect(first.complete).toBe(false);
    expect(first.spawn_commands).toHaveLength(2);
    expect(first.next_command).toContain("--resume");
    expect(renderReport(first).trim().split("\n").at(-1)!.startsWith("NEXT_COMMAND: ")).toBe(true);
    // It prepared the seats but never spawned them.
    const invoked = fx.calls.map((call) => call.script.split(/[\\/]/).pop());
    expect(invoked).not.toContain("dispatch_provider.ts");
    // Exactly the two gate-seat preparations (the PM step-4 log was already
    // GREEN, so no Dock seat was re-issued for it).
    expect(invoked.filter((name) => name === "dispatch_prepare.ts")).toHaveLength(2);
    expect(existsSync(join(fx.container, "register_received"))).toBe(true);
    expect(readFileSync(join(fx.container, "report.md"), "utf8").split("\n")[0]).toBe("+++");

    // Observer finding 2 — the window the PM actually occupies. Between "seat
    // prepared" and "verdict written", a plain re-run must NOT call
    // dispatch_prepare again (it is refused as a duplicate in-flight dispatch
    // AND as an existing container, and handing that command back as
    // NEXT_COMMAND advances nothing). The stage's product is the prepared seat,
    // so it recognises that and relays the route the seat already published.
    const between = fixtureSecondRun(fx);
    const rerun = runLandPipeline(args(fx.project, { pmStep: stepFile }), deps(between));
    expect(rerun.complete).toBe(false);
    expect(between.calls.filter((call) => call.script.endsWith("dispatch_prepare.ts")
      && call.args.includes("--role"))).toHaveLength(0);
    expect(rerun.stages.find((stage) => stage.stage === "gate_seats")!.outcome).toBe("skipped");
    expect(rerun.spawn_commands).toHaveLength(2);
    // Byte-identical to the first run's emission: relayed from ready.json, not re-derived.
    expect(rerun.spawn_commands.map((spawn) => spawn.claude))
      .toEqual(first.spawn_commands.map((spawn) => spawn.claude));

    writeVerdicts(fx.project);

    // Cleanup is destructive, so the DEFAULT is announce-and-stop: it names the
    // inventory and removes nothing (deletion_and_forcewrite_safety.md).
    const announce = fixtureSecondRun(fx);
    const announced = runLandPipeline(args(fx.project, { pmStep: stepFile, resume: true }), deps(announce));
    expect(announced.complete).toBe(false);
    expect(announced.stages.find((stage) => stage.stage === "cleanup")!.outcome).toBe("skipped");
    expect(announced.halt_reason).toContain("preserve+remove lane/gate-step4-aaaaaaaaaaaa.log");
    expect(announced.halt_reason).toContain("delete branch");
    expect(announced.next_command).toContain("--cleanup");
    expect(announce.calls.filter((call) => call.script.endsWith("dispatch_cleanup.ts"))).toHaveLength(0);
    expect(existsSync(join(fx.lane, "gate-step4-aaaaaaaaaaaa.log"))).toBe(true);
    expect(announced.preserved_artifacts).toEqual([]);

    const second = runLandPipeline(args(fx.project, { pmStep: stepFile, resume: true, cleanup: true }), deps(fx));
    expect(second.halt_reason).toBe("");
    expect(second.complete).toBe(true);
    expect(second.stages.map((s) => s.stage)).toEqual([...LAND_PIPELINE_STAGES]);
    // Stage 1/2 report `skipped` on the second pass: idempotence, observed.
    expect(second.stages.find((s) => s.stage === "ack")!.outcome).toBe("skipped");
    // LP-3: the unknown artifact is preserved into the tracked control tree and
    // removed from the container BEFORE cleanup could refuse over it.
    expect(second.preserved_artifacts).toEqual([
      "__garelier/pm1/control/reports/gates/W-668/dispatch7/gate-step4-aaaaaaaaaaaa.log",
    ]);
    expect(existsSync(join(fx.lane, "gate-step4-aaaaaaaaaaaa.log"))).toBe(false);
    const preserved = join(fx.project, "__garelier/pm1/control/reports/gates/W-668/dispatch7/gate-step4-aaaaaaaaaaaa.log");
    expect(readFileSync(preserved, "utf8")).toBe("RESULT GREEN\n");
    expect(unknownLaneArtifacts(fx.lane)).toEqual([]);
    // Counterfactual: with preservation removed the log would still be in lane/,
    // which is exactly the shape land_aftercare refuses.
    expect(readdirSync(fx.lane)).not.toContain("gate-step4-aaaaaaaaaaaa.log");
    // A successful merge delegates generic evidence to request-authenticated
    // aftercare. Pipeline must neither overwrite its admission nor unlink input.
    const collision = fixture({ laneExtras: { "security_admission.json": "unknown lane bytes\n", "sentinel.txt": "keep\n" } });
    writeVerdicts(collision.project);
    const preserveRoot = gateArtifactPreserveRoot(collision.project, "pm1", "W-668", "7");
    mkdirSync(preserveRoot, { recursive: true });
    const admission = join(preserveRoot, "security_admission.json");
    writeFileSync(admission, "authenticated admission sentinel\n");
    const snapshots = [admission, join(collision.lane, "security_admission.json"), join(collision.lane, "sentinel.txt")]
      .map(path => ({ path, bytes: readFileSync(path) }));
    for (const exitCode of [3, 0]) {
      const trial = fixtureSecondRun(collision);
      const result = runLandPipeline(args(collision.project, { resume: true, cleanup: true }), deps(trial, {
        "merge_land.ts": { exitCode: 0, stdout: '{"request_id":"pipeline-admitted-request","status":"success"}', stderr: "" },
        "dispatch_cleanup.ts": { exitCode, stdout: "", stderr: exitCode ? "preservation security admission rejected" : "" },
      }));
      for (const snapshot of snapshots) expect(readFileSync(snapshot.path)).toEqual(snapshot.bytes);
      expect(result.complete).toBe(exitCode === 0);
      const cleanup = trial.calls.find(call => call.script.endsWith("dispatch_cleanup.ts"))!;
      expect(cleanup.args).toContain("--request-id");
      expect(cleanup.args).toContain("pipeline-admitted-request");
      expect(cleanup.args).not.toContain("--force-remove");
    }
    const noRequest = fixtureSecondRun(collision);
    expect(runLandPipeline(args(collision.project, { resume: true, cleanup: true }), deps(noRequest)).complete).toBe(false);
    expect(noRequest.calls.some(call => call.script.endsWith("dispatch_cleanup.ts"))).toBe(false);
    for (const snapshot of snapshots) expect(readFileSync(snapshot.path)).toEqual(snapshot.bytes);
    const directory = fixture();
    writeVerdicts(directory.project);
    const disguisedLog = join(directory.lane, pmStepGateLogName(HEAD));
    mkdirSync(disguisedLog);
    const directorySentinel = join(disguisedLog, "sentinel.txt");
    writeFileSync(directorySentinel, "retain directory bytes");
    expect(runLandPipeline(args(directory.project, { resume: true, cleanup: true }), deps(directory)).complete).toBe(false);
    expect(directory.calls.some(call => call.script.endsWith("dispatch_cleanup.ts"))).toBe(false);
    expect(readFileSync(directorySentinel, "utf8")).toBe("retain directory bytes");
    process.stdout.write("W712_PIPELINE_CLEANUP admission_collision=UNCHANGED unknowns=RETAINED request_route=ONLY refusal=ATOMIC\n");

  });
});

// ── LP-2: the four halts ────────────────────────────────────────────────────

describe("LP-2 halts name the next command", () => {
  const cases: Array<{
    name: string;
    build: () => { fx: Fixture; deps: LandPipelineDeps; extra?: Record<string, unknown> };
    expect: RegExp;
    after?: (fx: Fixture, result: LandPipelineResult) => void;
  }> = [
    {
      name: "review_prepare refusal",
      build: () => {
        const fx = fixture();
        rmSync(join(fx.lane, "final_accounting.md"), { force: true });
        // Any review_prepare refusal halts the pipeline the same way; this one
        // is a currently reachable message (W-709 retired the
        // `declared_base_sha changes from … to …` refusal this used to quote).
        return { fx, deps: deps(fx, { "review_prepare.ts": { exitCode: 1, stdout: "", stderr: "review_prepare: review HEAD equals dispatch base; review commit is missing\n" } }) };
      },
      expect: /review_prepare\.ts .*--expected-studio-sha [0-9a-f]{40}$/,
    },
    {
      name: "verdict marker present but contract_check refuses it",
      build: () => {
        const fx = fixture();
        writeVerdicts(fx.project);
        return { fx, deps: deps(fx, { "contract_check.ts": { exitCode: 1, stdout: "", stderr: "verdict_section_missing\n" } }), extra: { resume: true } };
      },
      expect: /contract_check\.ts .*--gate demo-slug/,
    },
    {
      // PM ruling 2026-09-03: the pipeline NAMES the rebind, never runs it. The
      // evidence that would clear the drift is a Guardian marker written BEFORE
      // the drift, so it attests to the code candidate, never to the new row
      // bytes — a human has to look at what changed in the row.
      name: "authority drift at land",
      build: () => {
        const fx = fixture();
        writeVerdicts(fx.project);
        return { fx, deps: deps(fx, { "merge_land.ts": { exitCode: 3, stdout: "", stderr: "merge_request: item authority changed since pickup\n" } }), extra: { resume: true, cleanup: true } };
      },
      expect: /dispatch_prepare\.ts --rebind-authority --id 7 --evidence /,
      after: (fx: Fixture, result: LandPipelineResult) => {
        expect(fx.calls.filter((call) => call.args.includes("--rebind-authority"))).toHaveLength(0);
        expect(fx.calls.filter((call) => call.script.endsWith("merge_land.ts"))).toHaveLength(1);
        expect(result.stages.find((stage) => stage.stage === "rebind")!.outcome).toBe("skipped");
      },
    },
    {
      // Gate containers are not auto-reclaimed, so last round's marker sits at
      // the same path. Counting it as done would carry a BLOCK past stage 7.
      name: "stale verdict marker from an earlier round",
      build: () => {
        const fx = fixture();
        writeVerdicts(fx.project, { sha: "9".repeat(40), front: "BLOCK" });
        return { fx, deps: deps(fx) };
      },
      expect: /dispatch_cleanup\.ts .*--sweep$/,
      after: (_fx: Fixture, result: LandPipelineResult) => {
        expect(result.halt_reason).toContain("belong to an earlier round");
        expect(result.halt_reason).toContain("9999999999");
      },
    },
    {
      // merge_land obeys the front matter; a human reads the section.
      name: "verdict marker whose two surfaces disagree",
      build: () => {
        const fx = fixture();
        writeVerdicts(fx.project, { front: "BLOCK", section: "PASS" });
        return { fx, deps: deps(fx), extra: { resume: true } };
      },
      expect: /^# make the two surfaces identical/,
      after: (fx: Fixture, result: LandPipelineResult) => {
        expect(result.halt_reason).toContain("surfaces disagree");
        expect(fx.calls.filter((call) => call.script.endsWith("merge_land.ts"))).toHaveLength(0);
      },
    },
    {
      name: "cleanup refusal (only reachable with --cleanup)",
      build: () => {
        const fx = fixture();
        writeVerdicts(fx.project);
        return { fx, deps: deps(fx, { "dispatch_cleanup.ts": { exitCode: 3, stdout: "", stderr: "worktree dir not removed (locked or dirty)\n" } }), extra: { resume: true, cleanup: true } };
      },
      expect: /dispatch_cleanup\.ts .*--force-remove --delete-branch$/,
    },
  ];

  for (const scenario of cases) {
    test(scenario.name, () => {
      const built = scenario.build();
      const result = runLandPipeline(args(built.fx.project, built.extra as never), built.deps);
      expect(result.complete).toBe(false);
      expect(result.next_command).not.toBeNull();
      expect(result.next_command!).toMatch(scenario.expect);
      const rendered = renderReport(result).trimEnd().split("\n");
      expect(rendered.at(-1)!).toBe(`NEXT_COMMAND: ${result.next_command}`);
      scenario.after?.(built.fx, result);
    });
  }
});
