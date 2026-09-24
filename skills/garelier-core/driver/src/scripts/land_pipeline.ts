#!/usr/bin/env bun
/**
 * land_pipeline.ts — one PM command for register-received → landed → cleaned (W-668).
 *
 * WHY this exists. The measured cost of landing ONE dispatch on 2026-09-02 was
 * twelve hand-typed commands, and eight of the contracts those commands enforce
 * were written down nowhere (blueprint w668 §1). Each command is individually
 * correct; what the PM has to supply between them is ordering, three environment
 * variables, two SHA derivations, and a set of artifact-shape rules that only
 * appear as a refusal. This file supplies exactly that glue and nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO (`機械化は告知まで`, user standing rule):
 *   - it never invents or edits a verdict,
 *   - it never releases a lock,
 *   - it never closes a control row (merge_land's own row close is unchanged),
 *   - it never spawns a gate seat: it EMITS the exact spawn command for both
 *     transports and stops, because launching a reviewer is a human decision.
 * Every stage is a composition of an existing script. This file owns no policy.
 *
 * Stopping is a first-class outcome: when a stage refuses, the LAST line of
 * stdout is `NEXT_COMMAND: <command>` — verbatim-executable, so the PM never has
 * to reconstruct the recovery step from an error message.
 *
 * Idempotent by stage: re-running after a fix skips every stage whose product is
 * already present and valid, so recovery is "run the same command again".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { crewSubdir } from "../workspace.ts";
import { git, requireRuntimeExecutable, valueAfter } from "./_lib.ts";
import { appendGuardedFileSync, assertSafeLeaf, writeGuardedFileSync } from "../guard/path_guard.ts";
import { sha256 } from "../control/serialization.ts";
import {
  MachineArtifactError,
  parseMachineArtifact,
  renderMachineArtifact,
  type MachineSection,
} from "../dispatch/machine_artifact.ts";
import { TASK_FILE_SECTION_HEADINGS } from "../dispatch/prompt_section_contract.ts";
import { isKnownLaneEntry } from "../dispatch/land_aftercare.ts";
import { laneArtifactsWrittenByRun } from "../dispatch/gate_step_artifacts.ts";
import { gateArtifactPreserveRoot, pmStepGateLogName, pmStepGateLogsIn, preservePmStepGateLogs } from "../dispatch/gate_step_artifacts.ts";
import { admitDockProxyReadyPaths, readDockProxyJson, readDockProxyLaneSession, resolveDockProxyRegisterPath } from "./dock_proxy.ts";
import {
  assertBoundRoleQualityGateSelection,
  dispatchExecutionIdentity,
  readCurrentRoleAuthorization,
  roleBindingFromContext,
} from "../dispatch/role_binding.ts";
import { readProviderSessionHandoff } from "./provider_session.ts";
import { extractVerdict } from "../merge_gate_parse.ts";
import { REVIEW_PREPARE_DELEGATION_MARKER } from "./review_prepare.ts";
import {
  canonicalReviewSha,
  engineTreeHash,
  REVIEW_BINDING_POLICY,
  reviewBindingMatches,
} from "../dispatch/dock_review_record.ts";
import { loadConfig } from "../config.ts";
import { parseArtifactRecord } from "../control/plan_graph_schema.ts";
import {
  recoveryCommandForUninspectableGate,
  type GateRecoveryCommandInput,
} from "./dispatch_cleanup.ts";

// ── stage vocabulary ────────────────────────────────────────────────────────

/** The ten stages, in execution order. `--resume` re-enters at `verdict`. */
export const LAND_PIPELINE_STAGES = Object.freeze([
  "ack",
  "report",
  "review",
  "pm_step",
  "gate_tasks",
  "gate_seats",
  "verdict",
  "rebind",
  "land",
  "cleanup",
] as const);

export type LandPipelineStage = typeof LAND_PIPELINE_STAGES[number];

/** `done` = the stage ran now. `skipped` = its product was already valid, which
 * is what makes re-running the whole pipeline the canonical recovery move. */
export type StageOutcome = "done" | "skipped" | "halted";

export interface StageRecord {
  stage: LandPipelineStage;
  outcome: StageOutcome;
  detail: string;
}

export interface LandPipelineResult {
  dispatch_id: number;
  work_id: string;
  stages: StageRecord[];
  /** Present exactly when the run halted: the verbatim recovery command. */
  next_command: string | null;
  /** Why it halted, in one line. Empty on a complete run. */
  halt_reason: string;
  complete: boolean;
  /** Spawn commands for both transports, emitted (never executed) by gate_seats. */
  spawn_commands: SpawnCommandEmission[];
  preserved_artifacts: string[];
}

export interface SpawnCommandEmission {
  role: "guardian" | "observer";
  seat: string;
  /** claude attended-agent transport: the Agent-tool call the PM makes. */
  claude: string;
  /** codex transport: the helper invocation. */
  codex: string;
  /** Both transports need the launch acknowledged afterwards. */
  ack: string;
}

/** A stage refusal that carries its own recovery command. Thrown, not returned,
 * so no stage can forget to propagate one. */
export class PipelineHalt extends Error {
  constructor(
    readonly stage: LandPipelineStage,
    readonly nextCommand: string,
    reason: string,
  ) {
    super(reason);
    this.name = "PipelineHalt";
    if (!nextCommand) throw new Error("PipelineHalt requires a recovery command");
  }
}

// ── arguments ───────────────────────────────────────────────────────────────

export interface LandPipelineArgs {
  project: string;
  pmId: string;
  dispatchId: string;
  /** PM-selected 4th gate step (`gate_runner --steps <file>`); optional. */
  pmStep: string;
  /** Optional markdown body inserted as the task files' `## Dispatch-specific facts`. */
  facts: string;
  guardian: string;
  observer: string;
  resume: boolean;
  /** Stage 10 is destructive. Without this it announces the inventory and stops. */
  cleanup: boolean;
  json: boolean;
}

export function parseLandPipelineArgs(argv: string[]): LandPipelineArgs {
  const out: LandPipelineArgs = {
    project: "", pmId: "", dispatchId: "", pmStep: "", facts: "",
    guardian: "", observer: "", resume: false, cleanup: false, json: false,
  };
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": out.project = valueAfter(argv, i); i += 2; break;
      case "--pm-id": out.pmId = valueAfter(argv, i); i += 2; break;
      case "--id": case "--dispatch-id": out.dispatchId = valueAfter(argv, i); i += 2; break;
      case "--pm-step": out.pmStep = valueAfter(argv, i); i += 2; break;
      case "--facts": out.facts = valueAfter(argv, i); i += 2; break;
      case "--guardian": out.guardian = valueAfter(argv, i); i += 2; break;
      case "--observer": out.observer = valueAfter(argv, i); i += 2; break;
      case "--resume": out.resume = true; i += 1; break;
      case "--cleanup": out.cleanup = true; i += 1; break;
      case "--json": out.json = true; i += 1; break;
      default: throw new Error(`land_pipeline: unknown arg: ${argv[i]}`);
    }
  }
  if (!out.project || !out.pmId || !/^[1-9][0-9]*$/.test(out.dispatchId)) {
    throw new Error("land_pipeline: --project, --pm-id and numeric --id are required");
  }
  return out;
}

// ── injectable surface ──────────────────────────────────────────────────────

export interface RunOutcome { exitCode: number; stdout: string; stderr: string }

export interface LandPipelineDeps {
  /** Run `bun <script> <args…>`; every stage but `cleanup` goes through here. */
  runScript: (script: string, args: string[], env?: Record<string, string>) => RunOutcome;
  /** Resolve a git ref inside the candidate checkout. */
  gitRun: (cwd: string, args: string[]) => RunOutcome;
  /** Derive the only executable cleanup recovery from authenticated typed authority. */
  gateRecoveryCommand: (input: GateRecoveryCommandInput) => string | null;
  now: () => Date;
}

function defaultDeps(): LandPipelineDeps {
  return {
    runScript: (script, args, env) => {
      const result = Bun.spawnSync([requireRuntimeExecutable("bun"), script, ...args], {
        windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: env ? { ...process.env, ...env } : process.env,
      });
      return {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
      };
    },
    gitRun: (cwd, args) => {
      const result = git(cwd, args);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    gateRecoveryCommand: recoveryCommandForUninspectableGate,
    now: () => new Date(),
  };
}

// ── shared helpers ──────────────────────────────────────────────────────────

const FULL_SHA = /^[0-9a-f]{40}$/;

function scriptDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Quote one argument for a copy-pasteable POSIX command line. */
export function quoteArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./#-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function commandLine(parts: readonly string[]): string {
  return parts.map(quoteArg).join(" ");
}

/** The one line of a failed run worth putting in a halt reason. */
function lastLine(result: RunOutcome): string {
  return (result.stderr || result.stdout).trim().split(/\r?\n/).at(-1) ?? "";
}

function readJson(path: string, label: string): Record<string, any> {
  return readDockProxyJson<Record<string, any>>(path, label);
}

/** The pipeline's own scratch root — outside the dispatch container, so nothing
 * it writes can become an "unknown nested artifact" at cleanup time. */
export function pipelineScratchRoot(project: string, pmId: string, dispatchId: string): string {
  return resolve(project, "__garelier", pmId, "runtime", "land_pipeline", `dispatch${dispatchId}`);
}

/** Where cleanup preserves artifacts the aftercare allowlist does not know
 * (blueprint LP-3). Tracked, so the evidence survives the transient container.
 *
 * W-741: the definition moved to `dispatch/gate_step_artifacts.ts` so
 * `dispatch_cleanup.ts` — the OTHER remover, and the one the PM runs by hand —
 * preserves into the same place instead of needing `--force-remove`. Re-exported
 * here because this module's callers and tests already name it. */
export { gateArtifactPreserveRoot };

// ── stage 2: report transcription (F-18) ────────────────────────────────────

/**
 * The control binding a landed report carries, read from the DRIVER's own
 * `context.json` (W-782 AC-3 / W-780 Observer N-1).
 *
 * `dispatch_prepare` writes these three fields into `context.json` and into the
 * report scaffold's `[control]` table from the same values, so context.json is
 * the authority and the scaffold is a copy of it. Reading the authority
 * directly removes the question of whether a copy survived: before W-782,
 * transcription took the binding from whichever text still carried the retired
 * `<!-- garelier-control-v3 … -->` comment, and once W-780 removed that comment
 * from the scaffold the only remaining carrier was the PRODUCER-written
 * register — so a producer could choose its own work_id / session_id, which is
 * the displacement this function's own contract says must not happen.
 *
 * Null when the dispatch has no schema-3 control binding; then a landed report
 * carries no `[control]` table at all rather than the producer's.
 */
export function contextControlBinding(context: Record<string, any>): Record<string, string> | null {
  const control = context?.control;
  if (!control || typeof control !== "object" || Array.isArray(control)) return null;
  const workId = String(control.work_id ?? "");
  const sessionId = String(control.session_id ?? "");
  const schemaVersion = String(control.schema_version ?? "");
  if (!workId || !sessionId || !schemaVersion) return null;
  // Exactly the three fields `reportScaffold` renders. `claim_owned` and any
  // later context key are driver bookkeeping, not part of the report's binding.
  return { schema_version: schemaVersion, work_id: workId, session_id: sessionId };
}

/** Transcribe a producer register into `report.md`, binding `[control]` to the
 * driver's own `context.json` values.
 *
 * The producer register is a machine artifact whose FIRST line must be `+++`.
 * A retired `<!-- garelier-control-v3 … -->` comment copied into it is stripped
 * rather than parsed — the comment never survives into a machine artifact, and
 * its fields are never read, because `control` is the authority.
 *
 * Exported for the test: the refutation is that a register naming a different
 * work_id still lands the context's.
 */
export function transcribeRegisterToReport(
  registerSource: string,
  control: Record<string, string> | null,
): string {
  const controlHeader = /^\s*<!--\s*garelier-control-v(\d+)\s+work_id=(\S+)\s+session_id=(\S+)\s*-->\s*$/m;
  // `lane/` is producer-writable, so its contents "prove shape, not authorship"
  // (review_prepare.ts, PV-1). The comment is removed, never read: `control` is
  // the only source of the binding, so the PRIOR report contributes nothing and
  // is not a parameter at all — a text that cannot change the answer must not
  // be passed in as though it could.
  const register = controlHeader.test(registerSource)
    ? registerSource.replace(controlHeader, "").replace(/^\s*\n/, "")
    : registerSource;
  const carried: Record<string, string> | null = control;

  const artifact = parseMachineArtifact(register, "lane/result.md");
  const sections: MachineSection[] = Object.entries(artifact.data).flatMap(([name, value]): MachineSection[] => {
    if (Array.isArray(value)) {
      return value.map((row) => ({
        name, array: true,
        fields: Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, String(v)] as const),
      }));
    }
    if (value && typeof value === "object") {
      return [{
        name,
        fields: Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)] as const),
      }];
    }
    throw new MachineArtifactError("invalid", "lane/result.md", `top-level ${name} must be a table`);
  });
  // `[control]` in a landed report is DRIVER-OWNED or absent. The mechanism
  // binding replaces whatever the register carries, and where the dispatch has
  // no binding the register's own table is dropped rather than promoted:
  // keeping it only when the driver had nothing to say is still letting the
  // producer choose its own work_id / session_id by writing that table into the
  // producer-writable register — the exact displacement this must not permit.
  const existing = sections.findIndex((section) => section.name === "control");
  if (existing >= 0) sections.splice(existing, 1);
  if (carried !== null) {
    sections.push({ name: "control", fields: Object.entries(carried).map(([k, v]) => [k, v] as const) });
  }
  return renderMachineArtifact(sections, artifact.body);
}

// ── stage 3: expected studio authority (F-22) ───────────────────────────────

export interface StudioAuthority {
  /** The newest studio commit the candidate ALREADY contains. */
  contained: string;
  /** The studio branch tip right now. */
  tip: string;
  /** Paths changed on studio since `contained` that the candidate also changes. */
  overlaps: string[];
}

/**
 * F-22(a): the PM used to pass the studio TIP, so every parallel land forced the
 * next lane through a base-track round trip even when the two lanes touched
 * disjoint paths. The authority a review can legitimately claim is the newest
 * studio commit the candidate contains; a base-track is required only when the
 * uncontained drift OVERLAPS the candidate's own paths.
 */
export function resolveStudioAuthority(
  checkout: string,
  studioRef: string,
  baseSha: string,
  reviewSha: string,
  gitRun: LandPipelineDeps["gitRun"],
): StudioAuthority {
  const rev = (ref: string, label: string): string => {
    const result = gitRun(checkout, ["rev-parse", "--verify", `${ref}^{commit}`]);
    const sha = result.stdout.trim();
    if (result.exitCode !== 0 || !FULL_SHA.test(sha)) throw new Error(`land_pipeline: ${label} does not resolve to a full commit SHA: ${ref}`);
    return sha;
  };
  const tip = rev(studioRef, "studio tip");
  const mergeBase = gitRun(checkout, ["merge-base", tip, reviewSha]);
  const contained = mergeBase.stdout.trim();
  if (mergeBase.exitCode !== 0 || !FULL_SHA.test(contained)) {
    throw new Error(`land_pipeline: cannot resolve the studio authority the candidate contains (studio=${tip})`);
  }
  if (contained === tip) return { contained, tip, overlaps: [] };
  const names = (from: string, to: string): string[] => {
    const result = gitRun(checkout, ["diff", "--no-renames", "--name-only", "-z", `${from}..${to}`, "--"]);
    if (result.exitCode !== 0) throw new Error(`land_pipeline: cannot enumerate ${from}..${to}`);
    return result.stdout.split("\0").filter((p) => p.length > 0);
  };
  // W-809: only first-parent, non-merge commits authored by this candidate are
  // the overlap denominator. A Dock base-track merge may carry every control
  // path that moved on studio; counting its tree diff made that imported
  // bookkeeping look like candidate work and forced another evidence round.
  const ownCommitsResult = gitRun(checkout, [
    "rev-list", "--first-parent", "--no-merges", "--reverse", `${baseSha}..${reviewSha}`,
  ]);
  if (ownCommitsResult.exitCode !== 0) {
    throw new Error(`land_pipeline: cannot enumerate candidate first-parent commits ${baseSha}..${reviewSha}`);
  }
  const candidate = new Set<string>();
  for (const commit of ownCommitsResult.stdout.split(/\r?\n/).filter((sha) => FULL_SHA.test(sha))) {
    for (const path of names(`${commit}^`, commit)) candidate.add(path);
  }
  const overlaps = names(contained, tip).filter((path) => candidate.has(path)).sort();
  return { contained, tip, overlaps };
}

// ── stage 5: gate task files (A-0 allowlist) ────────────────────────────────

export interface GateTaskFileInput {
  role: "guardian" | "observer";
  seat: string;
  dispatchId: string;
  branch: string;
  reviewSha: string;
  engineTreeHash: string;
  baseSha: string;
  checkout: string;
  blueprint: string;
  outputPath: string;
  facts: string;
}

const GUARDIAN_VERDICTS = "PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION";
const OBSERVER_VERDICTS = "PASS | PASS_WITH_NOTES | REWORK_RECOMMENDED | BLOCK | NO_OPINION";

/**
 * Renders the mechanism-owned `##` sections of the A-0 task-file allowlist,
 * plus the PM's own `## Dispatch-specific facts` body verbatim. The headings
 * come from `prompt_section_contract.ts`, so this emitter cannot drift from the
 * check that would refuse it.
 *
 * W-712 / DEC-100 裁定 3: `## Dock gate` (the run's log path and GREEN/RED) is
 * NOT emitted. It was the seat's identity/staleness item — "did the gate that
 * covers this commit actually pass" — and the answer is now a precondition of
 * the seat existing at all: `inspectDockReviewHandoff` refuses issuance unless
 * the coordinator seal is GREEN, fully covered, digest-matched, and bound to
 * the candidate HEAD and its gate run's start/end heads. A prompt that asks a
 * seat to re-derive a fact its own existence proves buys a weaker second
 * answer and costs a round when the two disagree. `## Review SHA` stays: the
 * verdict marker's front matter must carry it, so it is an OUTPUT field, not a
 * check.
 */
export function renderGateTaskFile(input: GateTaskFileInput): string {
  const facts = input.facts.trim();
  const sections: Array<[string, string]> = [
    ["Seat", input.seat],
    ["Dispatch", [
      `- dispatch: #${input.dispatchId}`,
      `- branch: ${input.branch}`,
      `- tip SHA: ${input.reviewSha}`,
      `- engine tree hash: ${input.engineTreeHash}`,
      `- ${REVIEW_BINDING_POLICY.verdictAndScannerInstruction}`,
      `- ${REVIEW_BINDING_POLICY.heavyStepInstruction}`,
      `- base SHA: ${input.baseSha}`,
      `- checkout: ${posix(input.checkout)}`,
    ].join("\n")],
    ["Blueprint", `${posix(input.blueprint)}\n\nこれが正本。`],
    ["Output", posix(input.outputPath)],
    ["Review SHA", `review_sha: ${input.reviewSha}`],
    ["Verdict", input.role === "guardian" ? GUARDIAN_VERDICTS : OBSERVER_VERDICTS],
  ];
  if (facts) sections.push(["Dispatch-specific facts", facts]);
  // Self-check on GENERATED content: every heading this renderer emits must be
  // one the A-0 canonical task-file set documents. W-708 retired the closed
  // allowlist for PM-AUTHORED sections, but a generator that invents a heading
  // the manual does not describe is still a defect.
  const known = new Set<string>(TASK_FILE_SECTION_HEADINGS);
  for (const [heading] of sections) {
    if (!known.has(heading)) throw new Error(`land_pipeline: '${heading}' is outside the A-0 canonical task-file section set`);
  }
  return `${sections.map(([heading, body]) => `## ${heading}\n\n${body}\n`).join("\n")}`;
}

// ── stage 6: spawn command relay (LP-4) ─────────────────────────────

/**
 * RELAY, never re-derive. `dispatch_prepare` already computes the launch route
 * for every transport and publishes it as `provider_parent_routes` in the
 * container's `ready.json` (the same object it prints). This function copies
 * those fields out; it does not know how to launch anything.
 *
 * Why that matters concretely: a gate seat prepared with
 * `--provider claude-code --provider-transport attended-agent` gets
 * `codex_cli = { transport: "blocked", directive: "BLOCK: configured provider is
 * Claude; use claude_code_parent and do not substitute Codex CLI" }`. A
 * hand-rolled codex command for that seat is not merely unrunnable — it tells
 * the PM to do the thing the mechanism just refused. LP-4 asks for both
 * transports; the honest both is "the route, or the BLOCK the route carries".
 */
export function relaySpawnCommands(
  role: "guardian" | "observer",
  ready: Record<string, any>,
  ackCommand: string,
): SpawnCommandEmission {
  const routes = (ready.provider_parent_routes ?? {}) as Record<string, any>;
  const seat = String(ready.gate_agents?.[role]?.name ?? ready.agent_name ?? "");

  const render = (route: Record<string, any> | undefined): string => {
    if (!route) return "BLOCK: dispatch_prepare emitted no route for this transport";
    if (route.transport === "Agent/Workflow") {
      // Verbatim fields: the PM types the Agent call the mechanism specified.
      // The route's own `directive` (and the completion_contract beside it) is
      // relayed too — every other branch relays `directive` as its whole
      // payload, so dropping it here left the transport the PM actually uses as
      // the one without the line naming the seat's completion contract.
      const call = `Agent(name=${String(route.name)}, subagent_type=claude, model=${String(route.model ?? "")}, prompt=${JSON.stringify(String(route.message ?? ""))})`;
      const notes = [route.directive, route.completion_contract]
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      return notes.length > 0 ? [call, ...notes.map((note) => `  ${note}`)].join("\n") : call;
    }
    if (route.launch_cmd) return String(route.launch_cmd);
    return String(route.directive ?? "BLOCK: route carries neither launch_cmd nor directive");
  };

  return {
    role,
    seat,
    claude: render(routes.claude_code_parent),
    codex: render(routes.codex_cli),
    ack: ackCommand,
  };
}

// ── stage 10: unknown-artifact preservation (F-21 / LP-3) ───────────────────

/** One lane entry as this listing sees it — the `node:fs` Dirent surface the
 * recognition rule needs, so a fixture can supply the same information. */
export interface LaneDirEntry { name: string; isFile(): boolean; isDirectory(): boolean }

/** Recognition is shared with aftercare: `isKnownLaneEntry` IS the set, and
 * this caller adds nothing to it. Generic unknown files require aftercare's
 * admitted preservation transaction; only W741 PM-step logs have a dedicated
 * mover. Directories and unsafe leaves are not silently filtered out here.
 *
 * W-547 AC-4: the entry TYPE is part of the question, so the listing reads
 * dirents rather than names. The pre-W-782 form filtered `name !== "locks"`
 * beside a name-only predicate — a second spelling of the lane set, which is
 * how the two removal routes came to disagree about `lane/session.json`. */
export function unknownLaneArtifacts(
  lane: string,
  list: (dir: string) => LaneDirEntry[] = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []),
  writtenByRun: ReadonlySet<string> = new Set(),
): string[] {
  return list(lane)
    .filter((entry) => !isKnownLaneEntry([entry.name], entry, writtenByRun))
    .map((entry) => entry.name)
    .sort();
}

// ── the pipeline ────────────────────────────────────────────────────────────

interface Ctx {
  args: LandPipelineArgs;
  deps: LandPipelineDeps;
  project: string;
  container: string;
  checkout: string;
  lane: string;
  pmRoot: string;
  scripts: string;
  context: Record<string, any>;
  workId: string;
  stages: StageRecord[];
  spawns: SpawnCommandEmission[];
  preserved: string[];
  aftercareRequestId?: string;
}

interface GateSeatRouting { provider: "codex" | "claude-code"; model: string; effort: string }

function gateSeatRouting(ctx: Ctx): GateSeatRouting {
  const blueprintRef = String(ctx.context.anchors?.source ?? "");
  const blueprintPath = resolve(ctx.project, blueprintRef);
  let source = "";
  try { source = readFileSync(blueprintPath, "utf8"); }
  catch { /* named below as a missing gate line */ }
  const heading = /^## Effort-hint\s*$/m.exec(source);
  const section = heading
    ? source.slice(heading.index + heading[0].length).split(/^##\s+/m)[0] ?? ""
    : "";
  const line = section.split(/\r?\n/).find((candidate) => /^\s*-\s*gate\s*:/i.test(candidate)) ?? "";
  const model = /`([^`]+)`/.exec(line)?.[1]?.trim() ?? "";
  const effort = /\*\*([a-z][a-z0-9_-]*)\*\*/i.exec(line)?.[1]?.toLowerCase() ?? "";
  const explicitProvider = /:\s*(?:Guardian\s*\/\s*Observer\s*=\s*)?(codex|claude-code)\b/i.exec(line)?.[1]?.toLowerCase();
  const provider = explicitProvider === "codex" || explicitProvider === "claude-code"
    ? explicitProvider : null;
  if (!line || !provider || !model || !effort) {
    throw new PipelineHalt("gate_seats", selfCommand(ctx, []),
      `blueprint Effort-hint gate line is missing or incomplete: ${posix(blueprintPath)} (expected explicit provider (codex | claude-code), model and effort)`);
  }
  return { provider, model, effort };
}

function gateSeatControlBinding(ctx: Ctx): { workId: string; sessionId: string } {
  const path = join(ctx.container, "control_binding.json");
  let binding: Record<string, unknown> = {};
  try { binding = readJson(path, "control_binding.json"); }
  catch (error) {
    throw new PipelineHalt("gate_seats", selfCommand(ctx, []), (error as Error).message);
  }
  const workId = typeof binding.work_id === "string" ? binding.work_id : "";
  const sessionId = typeof binding.session_id === "string" ? binding.session_id : "";
  if (!/^W-[1-9][0-9]*$/.test(workId) || !sessionId) {
    throw new PipelineHalt("gate_seats", selfCommand(ctx, []),
      `control_binding.json has no canonical work_id / session_id: ${posix(path)}`);
  }
  return { workId, sessionId };
}

function note(ctx: Ctx, stage: LandPipelineStage, outcome: StageOutcome, detail: string): void {
  ctx.stages.push({ stage, outcome, detail });
}

function selfCommand(ctx: Ctx, extra: string[]): string {
  const base = [
    "bun", posix(join(ctx.scripts, "land_pipeline.ts")),
    "--project", posix(ctx.project), "--pm-id", ctx.args.pmId, "--id", ctx.args.dispatchId,
  ];
  if (ctx.args.pmStep) base.push("--pm-step", posix(resolve(ctx.args.pmStep)));
  if (ctx.args.facts) base.push("--facts", posix(resolve(ctx.args.facts)));
  return commandLine([...base, ...extra]);
}

// stage 1 ────────────────────────────────────────────────────────────────────
function stageAck(ctx: Ctx): void {
  const marker = join(ctx.container, "register_received");
  if (existsSync(marker)) {
    // Refresh nothing; the marker's presence IS the state.
    note(ctx, "ack", "skipped", posix(marker));
    return;
  }
  writeGuardedFileSync(marker, "", "land_pipeline register_received");
  const stamp = ctx.deps.now();
  utimesSync(marker, stamp, stamp);
  note(ctx, "ack", "done", posix(marker));
}

/** The ONE canonical producer register for this lane (W-688 / W-653).
 *
 * There used to be two: this stage read `lane/result.md` while the Dock read
 * whatever `resolveDockProxyRegisterPath` selected, and the role prompt asked
 * the producer to keep BOTH files byte-identical to bridge the gap. A rule that
 * two files must agree is a rule that will be broken; the transport already
 * knows which file the register lands in (an attended-agent lane captures into
 * `<container>/report.md`, a codex lane into a `lane/` leaf), so both readers
 * ask the same resolver instead. `ready.json` cannot redirect this: admission
 * derives the leaves from the container layout and only requires `ready.json`
 * to agree with them.
 *
 * Only canonical absence of authorization permits the pre-transport route;
 * a missing or corrupt current handoff is never predecessor evidence. */
export function canonicalRegisterPath(ctx: Ctx): string {
  let authorization: ReturnType<typeof readCurrentRoleAuthorization> | undefined;
  try {
    authorization = readCurrentRoleAuthorization({
      project_root: ctx.project, pm_id: ctx.args.pmId,
      identity: dispatchExecutionIdentity(ctx.args.dispatchId),
    });
  } catch (error) {
    if (roleBindingFromContext(ctx.context) != null
      || !(error as Error).message.startsWith("no current role binding exists")) throw error;
  }
  const readyPath = assertSafeLeaf(join(ctx.container, "ready.json"), "land_pipeline ready.json");
  if (!existsSync(readyPath)) {
    if (authorization) throw new Error("land_pipeline: current authorization requires ready.json");
    return assertSafeLeaf(join(ctx.lane, "result.md"), "land_pipeline legacy register");
  }
  const ready = readJson(readyPath, "ready.json");
  const admitted = admitDockProxyReadyPaths(ctx.project, ctx.container, ready);
  if (authorization && (ready.role_binding?.generation !== authorization.core.generation
    || ready.role_binding?.binding_digest !== authorization.core_digest
    || ready.provider_transport !== authorization.core.routing.provider)) {
    throw new Error("land_pipeline: ready.json does not match current authorization");
  }
  // Which lanes owe a provider session record is the shared admission decision
  // (`dockProxyLaneShape`), not a second `provider === "attended-agent"` test
  // written here: two spellings of one rule is how a recovered attended lane
  // came to be refused at review admission and admitted at landing (W-687 AC-5).
  const sessionPath = admitted.sessionPath
    ? assertSafeLeaf(admitted.sessionPath, "land_pipeline provider session")
    : null;
  let session: Record<string, any> | null = null;
  if (authorization && admitted.shape.providerSessionRecord) {
    if (!sessionPath) throw new Error("land_pipeline: provider session record path is required");
    readJson(sessionPath, "provider session");
    session = admitted.recoverySession ?? readProviderSessionHandoff(
      sessionPath, ctx.checkout, authorization.core.routing,
    );
    if (session.status !== "ready" || session.ownership_id !== `launch-${authorization.core_digest}`
      || session.provider !== (authorization.core.routing.provider === "codex-cli" ? "codex-cli" : "claude-code")) {
      throw new Error("land_pipeline: provider session does not match current authorization");
    }
  } else {
    session = readDockProxyLaneSession(admitted);
  }
  return assertSafeLeaf(resolveDockProxyRegisterPath(admitted, session), "land_pipeline admitted register");
}

// stage 2 ────────────────────────────────────────────────────────────────────
function stageReport(ctx: Ctx): void {
  const register = canonicalRegisterPath(ctx);
  const report = assertSafeLeaf(join(ctx.container, "report.md"), "land_pipeline report.md");
  if (!existsSync(register)) {
    throw new PipelineHalt("report", `# write the producer register to ${posix(register)} first`,
      `producer register missing: ${posix(register)}`);
  }
  const registerSource = readFileSync(register, "utf8");
  const existing = existsSync(report) ? readFileSync(report, "utf8") : "";
  let next: string;
  try {
    next = transcribeRegisterToReport(registerSource, contextControlBinding(ctx.context));
  } catch (error) {
    throw new PipelineHalt("report", `# fix ${posix(register)}: ${(error as Error).message}`,
      `register is not a machine artifact: ${(error as Error).message}`);
  }
  if (existing === next) {
    note(ctx, "report", "skipped", "report.md already carries the transcribed register");
    return;
  }
  writeGuardedFileSync(report, next, "land_pipeline report.md");
  note(ctx, "report", "done", posix(report));
}

// stage 3 ────────────────────────────────────────────────────────────────────
interface SealedReviewBinding { reviewSha: string; engineTreeHash: string | null }

function sealedReviewBinding(ctx: Ctx): SealedReviewBinding | null {
  const accounting = join(ctx.lane, "final_accounting.md");
  if (!existsSync(accounting)) return null;
  const text = readFileSync(accounting, "utf8");
  if (!/Gate result:\s*GREEN/i.test(text)) return null;
  const reviewSha = canonicalReviewSha(/^- Proxy \/ review SHA: \`([^`]+)\`$/m.exec(text)?.[1] ?? null);
  const engineTreeHash = /^- Engine tree hash \(excludes control\/docs\/__garelier\): \`([0-9a-f]{64})\`$/m.exec(text)?.[1] ?? null;
  return reviewSha ? { reviewSha, engineTreeHash } : null;
}

/** The shared binding predicate at each pipeline boundary. Security/verdict
 * callers use the exact-SHA default; only heavy steps opt into engine reuse. */
function reviewEvidenceIsCurrent(
  ctx: Ctx,
  evidenceSha: string | null,
  reviewSha: string,
  evidenceEngineTreeHash?: string | null,
  reuse: "exact" | "engine_tree" = "exact",
): boolean {
  try {
    const sealed = sealedReviewBinding(ctx);
    const sealedEngine = evidenceEngineTreeHash
      ?? (sealed?.reviewSha === evidenceSha ? sealed.engineTreeHash : null);
    return reviewBindingMatches({
      sealedReviewSha: evidenceSha,
      currentReviewSha: reviewSha,
      ...(reuse === "engine_tree" ? {
        reuse,
        sealedTreeHash: sealedEngine,
        currentTreeHash: engineTreeHash(ctx.checkout, reviewSha, ctx.deps.gitRun),
      } : {}),
    }) !== null;
  } catch {
    return false;
  }
}

function reviewIsCurrent(ctx: Ctx, reviewSha: string): boolean {
  const sealed = sealedReviewBinding(ctx);
  return sealed !== null
    && reviewEvidenceIsCurrent(ctx, sealed.reviewSha, reviewSha, sealed.engineTreeHash);
}

function stageReview(ctx: Ctx): { reviewSha: string; baseSha: string } {
  const head = ctx.deps.gitRun(ctx.checkout, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
  if (!FULL_SHA.test(head)) throw new Error(`land_pipeline: candidate HEAD does not resolve in ${ctx.checkout}`);
  const gateLog = join(ctx.lane, `gate-${head.slice(0, 12)}.log`);
  const baseSha = String(ctx.context.task?.base_sha ?? "").trim();
  const studioRef = String(ctx.context.project?.integration_branch ?? "").trim();
  if (!studioRef) throw new Error("land_pipeline: context.project.integration_branch is required");

  if (reviewIsCurrent(ctx, head)) {
    note(ctx, "review", "skipped", `final_accounting.md already binds exact review SHA ${head.slice(0, 12)} at GREEN`);
    return { reviewSha: head, baseSha };
  }

  const authority = resolveStudioAuthority(ctx.checkout, studioRef, baseSha, head, ctx.deps.gitRun);
  if (authority.overlaps.length > 0) {
    // F-22(a): a base-track is genuinely required — the drift touches this
    // candidate's own paths, so the self-gate cannot see the merge result.
    throw new PipelineHalt("review",
      commandLine(["git", "-C", posix(ctx.checkout), "merge", studioRef]),
      `studio ${authority.tip.slice(0, 12)} changed ${authority.overlaps.length} path(s) this candidate also changes (${authority.overlaps.slice(0, 5).join(", ")}); base-track then re-run`);
  }

  const result = ctx.deps.runScript(join(ctx.scripts, "review_prepare.ts"), [
    "--project", ctx.project, "--pm-id", ctx.args.pmId,
    "--dispatch-id", ctx.args.dispatchId, "--expected-studio-sha", authority.contained,
  ]);
  if (result.exitCode !== 0) {
    // W-743: a candidate that changes a gate-contract path does not get gated by
    // the studio scripts — review_prepare hands the gate+seal to the CANDIDATE's
    // own review_prepare.ts (§2-1d, a normal route, not a refusal). That
    // delegation announces itself on stderr and can still surface a non-zero
    // exit here, and the pipeline read the announcement as the refusal detail
    // and HALTED on a run that had already produced its gate log and
    // final_accounting.md (#466 r2: 31 gate-contract paths; the PM then drove
    // pm_step / gate_tasks / gate_seats by hand). The delegate writes into THIS
    // lane, so read its product under the SAME postcondition the non-delegated
    // path uses — a green seal binding this review SHA — and stop exactly as
    // before when the delegate was RED.
    const delegated = `${result.stdout}\n${result.stderr}`.includes(REVIEW_PREPARE_DELEGATION_MARKER);
    if (delegated && reviewIsCurrent(ctx, head)) {
      note(ctx, "review", "done",
        `delegated gate+seal to the candidate's review_prepare.ts; final_accounting.md binds ${head.slice(0, 12)} at GREEN`);
      return { reviewSha: head, baseSha };
    }
    throw new PipelineHalt("review",
      commandLine(["bun", posix(join(ctx.scripts, "review_prepare.ts")),
        "--project", posix(ctx.project), "--pm-id", ctx.args.pmId,
        "--dispatch-id", ctx.args.dispatchId, "--expected-studio-sha", authority.contained]),
      delegated
        ? `the candidate's own review_prepare.ts ran the gate and did not seal ${head.slice(0, 12)} at GREEN; read ${posix(gateLog)}`
        : `review_prepare refused: ${(result.stderr || result.stdout).trim().split(/\r?\n/).at(-1) ?? "no detail"}`);
  }
  note(ctx, "review", "done", `expected studio ${authority.contained.slice(0, 12)}${authority.contained === authority.tip ? " (studio tip)" : " (contained authority; tip not merged, no overlap)"}`);
  return { reviewSha: head, baseSha };
}

// stage 4 ────────────────────────────────────────────────────────────────────

/** Where the PM writes a declared step's file when none was passed. Inside the
 * pipeline's own runtime scratch root, like the gate task files. */
export function pmStepFileDestination(project: string, pmId: string, dispatchId: string): string {
  return join(pipelineScratchRoot(project, pmId, dispatchId), "pm-step.toml");
}

/**
 * W-844: the blueprint's PM-step declaration, read from its ONE machine-readable
 * seat — the `pm_step` front-matter field of the canonical typed blueprint
 * record (`parseArtifactRecord`, the parser `control doctor` validates with).
 * Never the Quality gates prose, never the changed paths.
 *
 * A blueprint without the field declares no step (`declared: null`). A
 * blueprint that cannot be read or parsed is not "no declaration": the
 * pipeline cannot tell, so it stops rather than skip a step it cannot see.
 */
function blueprintPmStepDeclaration(ctx: Ctx): { blueprint: string; declared: string | null } {
  const blueprintRef = String(ctx.context.anchors?.source ?? "");
  const blueprintPath = posix(resolve(ctx.project, blueprintRef));
  const unreadable = (detail: string): never => {
    throw new PipelineHalt("pm_step", `# fix the blueprint this dispatch is bound to (context.json anchors.source = ${blueprintRef || "<empty>"}): ${detail}`,
      `cannot read the blueprint's PM-step seat (front matter \`pm_step\`) at ${blueprintPath}: ${detail}`);
  };
  if (!blueprintRef) return unreadable("the dispatch binds no blueprint");
  let source: string;
  try { source = readFileSync(blueprintPath, "utf8"); }
  catch (error) { return unreadable((error as Error).message); }
  try {
    return { blueprint: blueprintPath, declared: parseArtifactRecord(source, blueprintPath, "blueprint").pmStep };
  } catch (error) {
    return unreadable((error as Error).message);
  }
}

export function stagePmStep(ctx: Ctx, reviewSha: string): { log: string; status: "GREEN" | "RED" } | null {
  const { blueprint, declared } = blueprintPmStepDeclaration(ctx);
  if (!ctx.args.pmStep) {
    if (declared === null) {
      note(ctx, "pm_step", "skipped", `no --pm-step, and ${blueprint} declares no PM step (front matter \`pm_step\` absent)`);
      return null;
    }
    // #849: the step was declared, --pm-step was not passed, and the pipeline
    // used to note `skipped` and carry on to merge. A declared step is a
    // precondition of merge; stop here, before anything touches studio.
    const destination = posix(pmStepFileDestination(ctx.project, ctx.args.pmId, ctx.args.dispatchId));
    mkdirSync(dirname(destination), { recursive: true });
    const rerun = selfCommand({ ...ctx, args: { ...ctx.args, pmStep: destination } }, []);
    const what = declared.replace(/\s+/g, " ");
    throw new PipelineHalt("pm_step",
      `# write the PM step file at ${destination} ([[step]] name = "…" / cmd = "…") running what ${blueprint} front matter \`pm_step\` declares ("${what}"), then run: ${rerun}`,
      `${blueprint} declares a PM step in front matter \`pm_step\` ("${what}") but no --pm-step was given; merge is not reached until that step is GREEN`);
  }
  const stepFile = resolve(ctx.args.pmStep);
  if (!existsSync(stepFile)) {
    throw new PipelineHalt("pm_step", `# write the PM step file at ${posix(stepFile)} ([[step]] name=… cmd=…)`,
      `--pm-step file not found: ${posix(stepFile)}`);
  }
  const stepBytes = (): Buffer => {
    try { return readFileSync(assertSafeLeaf(stepFile, "PM step file")); }
    catch (error) {
      throw new PipelineHalt("pm_step", `# fix the PM step file at ${posix(stepFile)}: ${(error as Error).message}`,
        `cannot read --pm-step file ${posix(stepFile)}: ${(error as Error).message}`);
    }
  };
  const originalBytes = stepBytes();
  if (declared !== null) {
    let stepDeclaration: unknown;
    try {
      const parsed = /\.json$/i.test(stepFile)
        ? JSON.parse(originalBytes.toString("utf8"))
        : parseToml(originalBytes.toString("utf8"));
      stepDeclaration = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).pm_step : undefined;
    } catch (error) {
      throw new PipelineHalt("pm_step", `# fix the PM step file at ${posix(stepFile)}: ${(error as Error).message}`,
        `cannot parse --pm-step file ${posix(stepFile)}: ${(error as Error).message}`);
    }
    if (stepDeclaration !== declared) {
      throw new PipelineHalt("pm_step", `# set pm_step in ${posix(stepFile)} to exactly match ${blueprint} front matter \`pm_step\` ("${declared}")`,
        `--pm-step file ${posix(stepFile)} does not bind the declaration in ${blueprint} front matter \`pm_step\``);
    }
  }
  const binding = `PM_STEP_BINDING ${JSON.stringify({ path: posix(stepFile), sha256: sha256(originalBytes) })}`;
  const sealed = sealedReviewBinding(ctx);
  const evidenceSha = sealed && reviewEvidenceIsCurrent(
    ctx, sealed.reviewSha, reviewSha, sealed.engineTreeHash, "engine_tree",
  )
    ? sealed.reviewSha
    : reviewSha;
  const log = join(ctx.lane, pmStepGateLogName(evidenceSha));
  if (existsSync(log)) {
    const lines = readFileSync(assertSafeLeaf(log, "PM step gate log"), "utf8").trimEnd().split(/\r?\n/);
    const lastResult = lines.filter((line) => /^RESULT (?:GREEN|RED)$/.test(line)).at(-1);
    if (lastResult === "RESULT GREEN" && lines.at(-1) === binding) {
      if (!stepBytes().equals(originalBytes)) {
        throw new PipelineHalt("pm_step", selfCommand(ctx, []),
          `--pm-step file ${posix(stepFile)} changed while checking its GREEN binding; rerun the current step file`);
      }
      note(ctx, "pm_step", "skipped", `${posix(log)} already GREEN for ${binding}`);
      return { log, status: "GREEN" };
    }
  }

  // The Dock seat's three environment variables are the single most-forgotten
  // part of the manual flow: without them gate_runner exits 0 having attributed
  // the run to nobody (memory: gate-runner-dock-attribution-env-triple).
  const seat = ctx.deps.runScript(join(ctx.scripts, "dispatch_prepare.ts"), [
    "--attended-seat", "--role", "dock",
    "--slug", `${String(ctx.context.task?.slug ?? `dispatch-${ctx.args.dispatchId}`)}-step4`,
    "--worktree", ctx.checkout, "--project", ctx.project, "--pm-id", ctx.args.pmId,
    "--dispatch-id", ctx.args.dispatchId,
  ]);
  if (seat.exitCode !== 0) {
    throw new PipelineHalt("pm_step", commandLine(["bun", posix(join(ctx.scripts, "dispatch_prepare.ts")),
      "--attended-seat", "--role", "dock", "--slug", `${String(ctx.context.task?.slug ?? "")}-step4`,
      "--worktree", posix(ctx.checkout), "--project", posix(ctx.project), "--pm-id", ctx.args.pmId,
      "--dispatch-id", ctx.args.dispatchId]),
      `Dock seat issuance failed: ${(seat.stderr || seat.stdout).trim().split(/\r?\n/).at(-1) ?? ""}`);
  }
  let plan: Record<string, any>;
  try { plan = JSON.parse(seat.stdout); } catch { throw new Error("land_pipeline: Dock seat plan is not JSON"); }
  if (!plan.record_path) throw new Error("land_pipeline: Dock attended seat produced no permission record");

  const gate = ctx.deps.runScript(join(ctx.scripts, "gate_runner.ts"), [
    "--project", ctx.project, "--pm-id", ctx.args.pmId, "--cwd", ctx.checkout,
    "--steps", stepFile, "--log", log,
  ], {
    GARELIER_ROLE: "dock",
    GARELIER_AGENT_NAME: String(plan.name),
    GARELIER_DISPATCH_RECORD: String(plan.record_path),
  });
  const status: "GREEN" | "RED" = gate.exitCode === 0 ? "GREEN" : "RED";
  if (status === "RED") {
    throw new PipelineHalt("pm_step", selfCommand(ctx, []),
      `PM-selected step is RED (${posix(log)}); fix the candidate, then re-run the same command`);
  }
  if (!stepBytes().equals(originalBytes)) {
    throw new PipelineHalt("pm_step", selfCommand(ctx, []),
      `--pm-step file ${posix(stepFile)} changed while its gate ran; rerun the current step file`);
  }
  try { appendGuardedFileSync(log, `\n${binding}\n`, "PM step gate binding"); }
  catch (error) {
    throw new PipelineHalt("pm_step", selfCommand(ctx, []),
      `cannot bind GREEN PM-step evidence at ${posix(log)}: ${(error as Error).message}`);
  }
  if (!stepBytes().equals(originalBytes)) {
    throw new PipelineHalt("pm_step", selfCommand(ctx, []),
      `--pm-step file ${posix(stepFile)} changed while binding its GREEN log; rerun the current step file`);
  }
  note(ctx, "pm_step", "done", `${posix(log)} GREEN`);
  return { log, status };
}

// stage 5 ────────────────────────────────────────────────────────────────────
function stageGateTasks(ctx: Ctx, reviewSha: string, baseSha: string): string[] {
  const scratch = pipelineScratchRoot(ctx.project, ctx.args.pmId, ctx.args.dispatchId);
  mkdirSync(scratch, { recursive: true });
  const facts = ctx.args.facts
    ? (existsSync(resolve(ctx.args.facts))
      ? readFileSync(resolve(ctx.args.facts), "utf8")
      : (() => { throw new PipelineHalt("gate_tasks", `# write the facts body at ${posix(resolve(ctx.args.facts))}`, `--facts file not found: ${posix(resolve(ctx.args.facts))}`); })())
    : "";
  const out: string[] = [];
  const engineHash = engineTreeHash(ctx.checkout, reviewSha, ctx.deps.gitRun);
  for (const role of ["guardian", "observer"] as const) {
    const agent = ctx.context.gate_agents?.[role] ?? {};
    const path = join(scratch, `${role}-task.md`);
    const body = renderGateTaskFile({
      role,
      seat: String(agent.name ?? `ga-${role}-${String(ctx.context.task?.slug ?? "")}`),
      dispatchId: ctx.args.dispatchId,
      branch: String(ctx.context.task?.branch ?? ""),
      reviewSha, engineTreeHash: engineHash, baseSha,
      checkout: ctx.checkout,
      blueprint: String(ctx.context.anchors?.source ?? ""),
      outputPath: join(ctx.pmRoot, String(agent.report ?? `runtime/${role}/results/${role}.md`)),
      facts,
    });
    if (existsSync(path) && readFileSync(path, "utf8") === body) out.push(path);
    else { writeGuardedFileSync(path, body, `land_pipeline ${role} task file`); out.push(path); }
  }
  note(ctx, "gate_tasks", "done", out.map(posix).join(", "));
  return out;
}

// stage 6 ────────────────────────────────────────────────────────────────────

/** The launch acknowledgement is the same five flags for every transport. */
function ackCommand(ctx: Ctx, dispatchId: string, handle: string): string {
  return commandLine(["bun", posix(join(ctx.scripts, "dispatch_prepare.ts")), "--ack-launch",
    "--project", posix(ctx.project), "--pm-id", ctx.args.pmId,
    "--dispatch-id", dispatchId, "--agent-handle", handle, "--parent-id", "pm"]);
}

/** The candidate a verdict marker actually reviewed, from its `[verdict]`
 * front matter. null when the marker declares none (which is itself a refusal
 * downstream: a verdict bound to no commit cannot gate a merge). */
export function markerReviewSha(body: string): string | null {
  try {
    const gate = parseMachineArtifact(body, "gate verdict").data.verdict;
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) return null;
    const value = (gate as Record<string, unknown>).review_sha;
    return typeof value === "string" && FULL_SHA.test(value) ? value : null;
  } catch { return null; }
}

/** The candidate a prepared gate seat was pointed at, read from the task file
 * the seat carries (`## Review SHA` is a mandatory A-0 section, so every seat
 * this pipeline prepares declares one). null when it cannot be read. */
export function seatBoundReviewSha(
  seatContainer: string,
  read: (path: string) => string | null = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
): string | null {
  for (const name of ["assignment.md", "lane/prompt.md"]) {
    const body = read(join(seatContainer, name));
    if (body === null) continue;
    const match = /^\s*review_sha:\s*([0-9a-f]{40})\s*$/m.exec(body);
    if (match) return match[1]!;
  }
  return null;
}

export function seatBoundEngineTreeHash(
  seatContainer: string,
  read: (path: string) => string | null = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
): string | null {
  for (const name of ["assignment.md", "lane/prompt.md"]) {
    const body = read(join(seatContainer, name));
    if (body === null) continue;
    const match = /^\s*-\s*engine tree hash:\s*([0-9a-f]{64})\s*$/m.exec(body);
    if (match) return match[1]!;
  }
  return null;
}

/** A gate seat already prepared for this (role, slug), with the `ready.json`
 * `dispatch_prepare` published for it. `ready.json` is that command's own stdout
 * written durably, so relaying from it and relaying from a fresh run emit the
 * same fields. */
function findPreparedGateSeat(
  ctx: Ctx,
  role: "guardian" | "observer",
  slug: string,
  reviewSha: string,
): { dispatchId: string; ready: Record<string, any>; staleSha: string | null } | null {
  const crewRoot = dirname(ctx.container);
  if (!existsSync(crewRoot)) return null;
  let staleFallback: { dispatchId: string; ready: Record<string, any>; staleSha: string | null } | null = null;
  for (const entry of readdirSync(crewRoot).sort()) {
    const id = /^dispatch([1-9][0-9]*)$/.exec(entry)?.[1];
    if (!id || id === ctx.args.dispatchId) continue;
    const contextPath = join(crewRoot, entry, "context.json");
    const readyPath = join(crewRoot, entry, "ready.json");
    if (!existsSync(contextPath) || !existsSync(readyPath)) continue;
    let seatContext: Record<string, any>;
    let ready: Record<string, any>;
    try {
      seatContext = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, any>;
      ready = JSON.parse(readFileSync(readyPath, "utf8")) as Record<string, any>;
    } catch { continue; }
    if (String(seatContext.task?.role ?? "") === role && String(seatContext.task?.slug ?? "") === slug) {
      // (role, slug) is round-invariant, so it alone would match last round's
      // seat. Bind it to the candidate the seat was actually pointed at.
      const seatContainer = join(crewRoot, entry);
      const bound = seatBoundReviewSha(seatContainer);
      const boundEngine = seatBoundEngineTreeHash(seatContainer);
      const candidate = {
        dispatchId: id,
        ready,
        staleSha: reviewEvidenceIsCurrent(ctx, bound, reviewSha, boundEngine) ? null : bound ?? "unreadable",
      };
      if (candidate.staleSha === null) return candidate;
      staleFallback ??= candidate;
    }
  }
  return staleFallback;
}

function stageGateSeats(ctx: Ctx, taskFiles: string[], reviewSha: string): void {
  const roles = ["guardian", "observer"] as const;
  const routing = gateSeatRouting(ctx);
  const control = gateSeatControlBinding(ctx);
  const slug = String(ctx.context.task?.slug ?? "");
  const alreadyReviewed: string[] = [];
  const fresh: string[] = [];
  const reused: string[] = [];
  const stale: Array<{ role: string; path: string; sha: string | null }> = [];
  for (const [index, role] of roles.entries()) {
    const agent = ctx.context.gate_agents?.[role] ?? {};
    const taskFile = taskFiles[index]!;
    const marker = join(ctx.pmRoot, String(agent.report ?? ""));
    if (agent.report && existsSync(marker)) {
      // A marker is only THIS round's verdict when it reviewed THIS candidate.
      // An exact reviewed marker is sufficient; its completed, exact-SHA seat
      // container is disposable runtime residue and is reclaimed below. On a
      // rework round the previous round's marker sits at the same path and would silently count
      // as done: stage 7 accepts any canonical token (BLOCK included), the run
      // reaches merge_land, and merge_land refuses on the stale review_sha —
      // handing back a command that can never advance. The real move is a new
      // gate round, so say that instead.
      const markerSha = markerReviewSha(readFileSync(marker, "utf8"));
      if (reviewEvidenceIsCurrent(ctx, markerSha, reviewSha)) {
        const completedSeat = findPreparedGateSeat(ctx, role, slug, reviewSha);
        if (completedSeat && completedSeat.staleSha === null) {
          const cleanupArgs = [
            "--project", ctx.project, "--pm-id", ctx.args.pmId,
            "--id", completedSeat.dispatchId,
            "--checkout", join(crewSubdir(ctx.project, ctx.args.pmId, `dispatch${completedSeat.dispatchId}`), "checkout"),
            "--force-remove",
          ];
          const cleanup = ctx.deps.runScript(join(ctx.scripts, "dispatch_cleanup.ts"), cleanupArgs);
          if (cleanup.exitCode !== 0) {
            throw new PipelineHalt(
              "gate_seats",
              commandLine(["bun", posix(join(ctx.scripts, "dispatch_cleanup.ts")), ...cleanupArgs.map(posix)]),
              `${role} verdict is current, but its completed seat container is studio-side residue and cleanup failed: ${lastLine(cleanup)}. Repair only that seat container; do not touch or base-track candidate ${reviewSha} because its review SHA is sealed.`,
            );
          }
        }
        alreadyReviewed.push(role);
        continue;
      }
      stale.push({ role, path: marker, sha: markerSha });
      continue;
    }
    // IDEMPOTENCE (the window the PM actually occupies). Between "seat prepared"
    // and "verdict written", a plain re-run must not call dispatch_prepare
    // again: it is refused as a duplicate in-flight dispatch AND as an existing
    // container, and handing that same command back as NEXT_COMMAND advances
    // nothing. The stage's PRODUCT is the prepared seat container, so recognise
    // it and relay its published route instead.
    const existing = findPreparedGateSeat(ctx, role, slug, reviewSha);
    if (existing && existing.staleSha !== null) {
      stale.push({ role, path: join(dirname(ctx.container), `dispatch${existing.dispatchId}`), sha: existing.staleSha });
      continue;
    }
    if (existing) {
      ctx.spawns.push(relaySpawnCommands(role, existing.ready, ackCommand(ctx, existing.dispatchId, String(existing.ready.agent_name ?? agent.name ?? ""))));
      reused.push(role);
      continue;
    }
    if (ctx.args.resume) {
      // `--resume` asserts the seats have already reviewed, and no seat exists
      // to relay. Preparing one here would silently widen a resume into a fresh
      // gate round, so say the true thing: the marker is not there yet.
      throw new PipelineHalt("gate_seats",
        selfCommand(ctx, []),
        `--resume was given but the ${role} verdict marker is absent and no ${role} seat is prepared for slug '${slug}': ${posix(marker)}. Re-run without --resume to prepare it.`);
    }
    const prepareArgs = [
      "--project", ctx.project, "--pm-id", ctx.args.pmId, "--role", role,
      "--slug", slug, "--blueprint", String(ctx.context.anchors?.source ?? ""),
      "--provider", routing.provider, "--model", routing.model, "--effort", routing.effort,
      ...(routing.provider === "claude-code" ? ["--provider-transport", "attended-agent"] : []),
      "--task-file", taskFile, "--work-id", control.workId, "--control-session", control.sessionId,
      ...(index === 1 ? ["--force"] : []),
    ];
    const prepared = ctx.deps.runScript(join(ctx.scripts, "dispatch_prepare.ts"), prepareArgs);
    if (prepared.exitCode !== 0) {
      throw new PipelineHalt("gate_seats",
        commandLine(["bun", posix(join(ctx.scripts, "dispatch_prepare.ts")), ...prepareArgs.map(posix)]),
        `${role} seat preparation failed: ${lastLine(prepared)}`);
    }
    let ready: Record<string, any>;
    try { ready = JSON.parse(prepared.stdout) as Record<string, any>; } catch {
      throw new PipelineHalt("gate_seats", selfCommand(ctx, []),
        `${role} seat preparation printed no JSON route to relay`);
    }
    ctx.spawns.push(relaySpawnCommands(role, ready, ackCommand(ctx, String(ready.id ?? ready.dispatch_id ?? ""), String(ready.agent_name ?? agent.name ?? ""))));
    fresh.push(role);
  }
  if (stale.length > 0) {
    // Announce only: the PM decides whether last round's artifacts go. Deleting
    // a previous round's verdict or seat container automatically would destroy
    // the record of why that round was sent back.
    const targets = stale.map((entry) => `${entry.role} @ ${posix(entry.path)} (review_sha ${entry.sha ?? "unreadable"})`);
    throw new PipelineHalt("gate_seats",
      commandLine(["bun", posix(join(ctx.scripts, "dispatch_cleanup.ts")),
        "--project", posix(ctx.project), "--pm-id", ctx.args.pmId, "--sweep"]),
      `${stale.length} gate artifact(s) belong to an earlier round, not to candidate ${reviewSha.slice(0, 12)}: ${targets.join("; ")}. Clear only this studio-side residue (and the stale verdict markers); do not touch or base-track the reviewed candidate branch.`);
  }
  if (ctx.spawns.length > 0) {
    const detail = [
      fresh.length > 0 ? `prepared ${fresh.join(", ")}` : "",
      reused.length > 0 ? `relayed already-prepared ${reused.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    note(ctx, "gate_seats", fresh.length > 0 ? "done" : "skipped", `${detail}; spawn is the PM's decision`);
    throw new PipelineHalt("gate_seats", selfCommand(ctx, ["--resume"]),
      `spawn the ${ctx.spawns.length} prepared gate seat(s) (commands above), then resume`);
  }
  note(ctx, "gate_seats", "skipped", `verdict marker already present for ${alreadyReviewed.join(", ")}`);
}

// stage 7 ────────────────────────────────────────────────────────────────────
function stageVerdict(ctx: Ctx): void {
  const slug = String(ctx.context.task?.slug ?? "");
  const check = ctx.deps.runScript(join(ctx.scripts, "..", "dispatch", "contract_check.ts"), [
    "--project", ctx.project, "--pm-id", ctx.args.pmId, "--gate", slug, "--roles", "guardian,observer",
  ]);
  if (check.exitCode !== 0) {
    // The two readers disagree on shape (F-20): merge_land reads `[verdict]`
    // front matter, contract_check requires a `## Verdict` section. The marker
    // must carry BOTH — templates/gate_verdict.md is the single canonical form.
    throw new PipelineHalt("verdict",
      commandLine(["bun", posix(join(ctx.scripts, "..", "dispatch", "contract_check.ts")),
        "--project", posix(ctx.project), "--pm-id", ctx.args.pmId, "--gate", slug, "--roles", "guardian,observer"]),
      `gate verdict contract unmet: ${(check.stderr || check.stdout).trim().split(/\r?\n/).at(-1) ?? ""} — the marker needs BOTH \`[verdict]\` front matter and a \`## Verdict\` section (templates/gate_verdict.md)`);
  }
  // contract_check asserts the section carries SOME canonical token and
  // merge_land decides on the front matter; neither compares the two. A marker
  // whose surfaces disagree therefore passes the check and lands (or refuses) on
  // a token a human never read. This lane made the two-surface marker canonical,
  // so this lane checks the identity.
  const disagreements: string[] = [];
  for (const role of ["guardian", "observer"] as const) {
    const report = String(ctx.context.gate_agents?.[role]?.report ?? "");
    if (!report) continue;
    const markerPath = join(ctx.pmRoot, report);
    if (!existsSync(markerPath)) continue;
    const body = readFileSync(markerPath, "utf8");
    const front = extractVerdict(body);
    const section = sectionVerdictToken(body);
    if (front && section && front !== section) {
      disagreements.push(`${role}: [verdict] result = '${front}' but the '## Verdict' section says '${section}' (${posix(markerPath)})`);
    }
  }
  if (disagreements.length > 0) {
    throw new PipelineHalt("verdict",
      `# make the two surfaces identical in the marker, then re-run: ${disagreements.join("; ")}`,
      `gate verdict marker surfaces disagree — ${disagreements.join("; ")}. merge_land obeys the front matter; a human reads the section.`);
  }
  note(ctx, "verdict", "done", "both markers carry a canonical token, and their two surfaces agree");
}

/** The bare canonical token under `## Verdict`, or null. Deliberately the same
 * shape `contract_check --gate` looks for, so "agrees" is measured against the
 * surface that check accepts. */
export function sectionVerdictToken(body: string): string | null {
  const tokens = ["PASS_WITH_NOTES", "REWORK_RECOMMENDED", "NO_OPINION", "PASS", "BLOCK"];
  const match = /^##\s+Verdict\s*$/m.exec(body);
  if (!match) return null;
  const after = body.slice(match.index + match[0].length);
  const section = after.split(/^##\s+/m)[0] ?? "";
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (tokens.includes(trimmed)) return trimmed;
  }
  return null;
}

// stage 8 ────────────────────────────────────────────────────────────────────

/** The evidence is the Guardian verdict marker for THIS dispatch — the file the
 * gate role already wrote. One argv, so the executed rebind and the printed
 * recovery command can never say different things. */
function rebindArgv(ctx: Ctx): string[] {
  const guardianReport = String(ctx.context.gate_agents?.guardian?.report ?? "");
  return ["--rebind-authority", "--id", ctx.args.dispatchId,
    "--evidence", guardianReport ? join(ctx.pmRoot, guardianReport) : "",
    "--project", ctx.project, "--pm-id", ctx.args.pmId];
}

function rebindCommand(ctx: Ctx): string {
  return commandLine(["bun", posix(join(ctx.scripts, "dispatch_prepare.ts")), ...rebindArgv(ctx).map(posix)]);
}

// stage 9 ────────────────────────────────────────────────────────────────────
/**
 * Stages 8 + 9 together, because authority drift is only OBSERVABLE by
 * attempting the land. Splitting them left stage 8 executing nothing.
 *
 * The rebind itself is not a judgement: `dispatch_prepare --rebind-authority`
 * is evidence-gated on the Guardian verdict marker that already exists, and it
 * only refreshes the item authority to the current canonical row bytes. So the
 * pipeline runs it ONCE on drift and retries the land ONCE. Anything past that
 * stops with the command to run.
 */
function stageLandAndRebind(ctx: Ctx): void {
  let selectedGate: string[];
  try {
    const bound = assertBoundRoleQualityGateSelection({
      project_root: ctx.project,
      pm_id: ctx.args.pmId,
      identity: dispatchExecutionIdentity(ctx.args.dispatchId),
      reference: roleBindingFromContext(ctx.context),
      context_selection: ctx.context.quality_gate_selection,
    });
    selectedGate = bound?.current.commands ?? loadConfig(ctx.project, ctx.args.pmId).qualityGate.fullCommands;
  } catch (error) {
    throw new PipelineHalt("land", "# repair context.json quality_gate_selection.current",
      `dispatch quality gate authority is invalid: ${(error as Error).message}`);
  }
  if (selectedGate.length === 0) throw new PipelineHalt("land", "# configure the project fixed quality gate",
    "dispatch has neither a PM declaration nor a non-empty project fixed quality gate set");
  const gateArgs = selectedGate.flatMap((command: string) => ["--quality-gate", command.trim()]);
  const args = ["--project", ctx.project, "--pm-id", ctx.args.pmId, "--id", ctx.args.dispatchId, ...gateArgs];
  if (ctx.args.guardian) args.push("--guardian", ctx.args.guardian);
  if (ctx.args.observer) args.push("--observer", ctx.args.observer);
  const landCommand = commandLine(["bun", posix(join(ctx.scripts, "merge_land.ts")),
    "--project", posix(ctx.project), "--pm-id", ctx.args.pmId, "--id", ctx.args.dispatchId,
    ...(ctx.args.guardian ? ["--guardian", ctx.args.guardian] : []),
    ...(ctx.args.observer ? ["--observer", ctx.args.observer] : []),
    ...gateArgs]);
  const result = ctx.deps.runScript(join(ctx.scripts, "merge_land.ts"), args);
  if (result.exitCode === 0) {
    note(ctx, "rebind", "skipped", "no authority drift observed");
    // Only the successful production merge response supplies the aftercare
    // request. The shared cleanup command independently authenticates it.
    const response = result.stdout.trim().split(/\r?\n/).findLast(line => line.startsWith("{"));
    if (response) {
      const requestId = JSON.parse(response).request_id;
      if (typeof requestId === "string" && /^[A-Za-z0-9._-]+$/.test(requestId)) ctx.aftercareRequestId = requestId;
    }
    note(ctx, "land", "done", "merge_land exit 0");
    return;
  }
  const drifted = /item authority|authority drift|merge_request: .*authority|row .* changed/i
    .test(`${result.stdout}
${result.stderr}`);
  if (!drifted) {
    note(ctx, "rebind", "skipped", "no authority drift observed");
    throw new PipelineHalt("land", landCommand, `merge_land exit ${result.exitCode}: ${lastLine(result)}`);
  }
  // PM ruling 2026-09-03: the pipeline does NOT run the rebind. The drift stop
  // exists so a human looks at what changed in the row after pickup, and the
  // evidence that would clear it — a Guardian marker — was written BEFORE the
  // drift: it attests to the code candidate, never to the new row bytes. So the
  // announce boundary holds here (gate point 5-2, 「機械化は告知まで」): name the
  // command, stop, let the PM decide.
  note(ctx, "rebind", "skipped", "authority drift observed; the rebind command is the stop, not an action");
  throw new PipelineHalt("rebind", rebindCommand(ctx),
    `merge_land refused on the item authority (exit ${result.exitCode}): ${lastLine(result)}. Review what changed in the row since pickup, then rebind and re-run.`);
}

// stage 10 ───────────────────────────────────────────────────────────────────
function stageCleanup(ctx: Ctx): void {
  // Announce the selected cleanup before running it. Request-bound aftercare
  // preserves generic unknowns and retires logically; the legacy route can
  // move only W741 logs before its ordinary explicit physical cleanup.
  const contextBinding = roleBindingFromContext(ctx.context);
  let authorization: ReturnType<typeof readCurrentRoleAuthorization> | undefined;
  try {
    authorization = readCurrentRoleAuthorization({
      project_root: ctx.project,
      pm_id: ctx.args.pmId,
      identity: dispatchExecutionIdentity(ctx.args.dispatchId),
    });
  } catch (error) {
    if (contextBinding != null || !(error as Error).message.startsWith("no current role binding exists")) throw error;
  }
  if (contextBinding != null && authorization
    && (contextBinding.generation !== authorization.core.generation
      || contextBinding.binding_digest !== authorization.core_digest)) {
    throw new Error("land_pipeline: context role binding does not match lane-artifact authorization");
  }
  const unknown = unknownLaneArtifacts(
    ctx.lane,
    undefined,
    authorization ? laneArtifactsWrittenByRun(authorization.core.lane_artifacts) : new Set(),
  );
  const pmLogs = new Set(pmStepGateLogsIn(ctx.lane));
  const cleanupArgs = ["--project", ctx.project, "--pm-id", ctx.args.pmId, "--id", ctx.args.dispatchId,
    "--checkout", join(ctx.container, "checkout"),
    ...(ctx.aftercareRequestId ? ["--request-id", ctx.aftercareRequestId] : ["--force-remove", "--delete-branch"])];
  const cleanupCommand = commandLine(["bun", posix(join(ctx.scripts, "dispatch_cleanup.ts")), ...cleanupArgs]);

  if (!ctx.args.cleanup) {
    const inventory = [
      ...unknown.map((name) => pmLogs.has(name)
        ? `preserve+remove lane/${name} via W741`
        : `admit+preserve lane/${name} via request-bound aftercare; retain unknown source`),
      ctx.aftercareRequestId ? `verify logical retirement ${posix(ctx.container)}` : `remove container ${posix(ctx.container)} (checkout + worktree)`,
      `delete branch ${String(ctx.context.task?.branch ?? "")}`,
    ];
    note(ctx, "cleanup", "skipped", `announce only (${inventory.length} target(s)): ${inventory.join("; ")}`);
    throw new PipelineHalt("cleanup", selfCommand(ctx, ["--cleanup"]),
      `landed. Cleanup is destructive, so it did NOT run: ${inventory.join("; ")}. Re-run with --cleanup to execute, or run ${cleanupCommand} yourself.`);
  }

  // Generic evidence belongs only to the authenticated aftercare transaction.
  // Never republish it under its original name or unlink retained sources.
  if (!ctx.aftercareRequestId) {
    const generic = unknown.filter(name => !pmLogs.has(name));
    if (generic.length) throw new PipelineHalt("cleanup",
      "# obtain the successful merge request and run dispatch_cleanup --request-id with --id",
      `unknown artifacts require request-bound preservation; retained: ${generic.join(", ")}`);
    const retention = loadConfig(ctx.project, ctx.args.pmId).retention;
    ctx.preserved.push(...preservePmStepGateLogs({
      lane: ctx.lane, project: ctx.project, pmId: ctx.args.pmId,
      workId: ctx.workId, dispatchId: ctx.args.dispatchId,
      maxBytes: retention.preservedArtifactMaxBytes,
      runtimeArchiveKeepDays: retention.runtimeArchiveKeepDays,
      runtimeArchiveKeepFiles: retention.runtimeArchiveKeepFiles,
    }));
  }
  const result = ctx.deps.runScript(join(ctx.scripts, "dispatch_cleanup.ts"), cleanupArgs);
  if (result.exitCode !== 0) {
    const recoveryCommand = ctx.aftercareRequestId
      ? ctx.deps.gateRecoveryCommand({
        project: ctx.project,
        targetRoot: ctx.project,
        pmId: ctx.args.pmId,
        id: ctx.args.dispatchId,
        requestId: ctx.aftercareRequestId,
      })
      : null;
    throw new PipelineHalt("cleanup", recoveryCommand ?? cleanupCommand,
      `dispatch_cleanup exit ${result.exitCode}; child diagnostics are not executable command authority`);
  }
  note(ctx, "cleanup", "done",
    ctx.aftercareRequestId ? "request-bound aftercare verified; unknown container sources retained"
      : ctx.preserved.length > 0 ? `preserved ${ctx.preserved.length} artifact(s): ${ctx.preserved.join(", ")}` : "no unknown artifact");
}

// ── driver ──────────────────────────────────────────────────────────────────

export function runLandPipeline(args: LandPipelineArgs, deps: LandPipelineDeps = defaultDeps()): LandPipelineResult {
  const project = resolve(args.project);
  const container = crewSubdir(project, args.pmId, `dispatch${args.dispatchId}`);
  const context = readJson(join(container, "context.json"), "context.json");
  const ctx: Ctx = {
    args, deps, project, container,
    checkout: resolve(container, "checkout"),
    lane: resolve(container, "lane"),
    pmRoot: resolve(project, "__garelier", args.pmId),
    scripts: scriptDir(),
    context,
    workId: String(context.control?.work_id ?? ""),
    stages: [], spawns: [], preserved: [],
  };

  const finish = (halt: PipelineHalt | null): LandPipelineResult => ({
    dispatch_id: Number(args.dispatchId),
    work_id: ctx.workId,
    stages: ctx.stages,
    next_command: halt ? halt.nextCommand : null,
    halt_reason: halt ? halt.message : "",
    complete: halt === null,
    spawn_commands: ctx.spawns,
    preserved_artifacts: ctx.preserved,
  });

  try {
    stageAck(ctx);
    stageReport(ctx);
    const { reviewSha, baseSha } = stageReview(ctx);
    // The PM-selected 4th step still runs (and still halts the pipeline when it
    // is RED); its log simply no longer reaches the gate prompt (W-712).
    stagePmStep(ctx, reviewSha);
    const taskFiles = stageGateTasks(ctx, reviewSha, baseSha);
    stageGateSeats(ctx, taskFiles, reviewSha);
    stageVerdict(ctx);
    stageLandAndRebind(ctx);
    stageCleanup(ctx);
    return finish(null);
  } catch (error) {
    if (error instanceof PipelineHalt) {
      if (!ctx.stages.some((record) => record.stage === error.stage)) {
        note(ctx, error.stage, "halted", error.message);
      }
      return finish(error);
    }
    // An unexpected error is still a stop, and a stop must always end with a
    // NEXT_COMMAND line — otherwise the PM gets a bare exit 2 with nothing to
    // do next. There is no runnable recovery for a malformed input, so the line
    // is a `#` comment naming the field to fix, the same shape the report and
    // pm_step input halts already use.
    const failed = (ctx.stages.at(-1)?.stage ?? "ack") as LandPipelineStage;
    const detail = (error as Error).message;
    return finish(new PipelineHalt(failed, `# fix the input this stage read: ${detail}`,
      `unexpected failure after stage '${failed}': ${detail}`));
  }
}

const HELP = `land_pipeline.ts — register-received → landed → cleaned, in one command (W-668).

Usage:
  land_pipeline.ts --project <root> --pm-id <id> --id <N>
                   [--pm-step <steps.toml>] [--facts <facts.md>]
                   [--guardian <token|path>] [--observer <token|path>]
                   [--resume] [--cleanup] [--json]

Stages: ${LAND_PIPELINE_STAGES.join(" -> ")}
Each stage is idempotent; re-running after a fix skips what is already valid.
--pm-step is required when the dispatch's blueprint declares front matter
'pm_step' (W-844); without that declaration the pm_step stage is skipped.
For a declared step, the steps file must repeat that exact string as top-level
'pm_step'. A GREEN log is reusable only for the same step-file path and bytes.
It NEVER spawns a gate seat, writes a verdict, releases a lock, or closes a row —
it emits the spawn command for both transports and stops.
When it stops, the LAST line is 'NEXT_COMMAND: <verbatim command>'.
`;

export function renderReport(result: LandPipelineResult): string {
  const lines: string[] = [`LAND_PIPELINE dispatch=#${result.dispatch_id} work=${result.work_id || "-"}`];
  for (const record of result.stages) {
    lines.push(`  ${record.outcome.toUpperCase().padEnd(7)} ${record.stage.padEnd(11)} ${record.detail}`);
  }
  for (const spawn of result.spawn_commands) {
    lines.push(`SPAWN ${spawn.role} seat=${spawn.seat}`);
    lines.push(`  claude: ${spawn.claude}`);
    lines.push(`  codex:  ${spawn.codex}`);
    lines.push(`  ack:    ${spawn.ack}`);
  }
  for (const path of result.preserved_artifacts) lines.push(`PRESERVED ${path}`);
  lines.push(result.complete ? "RESULT LANDED" : `RESULT HALTED ${result.halt_reason}`);
  if (result.next_command) lines.push(`NEXT_COMMAND: ${result.next_command}`);
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)): number {
  if (argv.includes("-h") || argv.includes("--help")) { process.stdout.write(HELP); return 0; }
  let args: LandPipelineArgs;
  try { args = parseLandPipelineArgs(argv); } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${HELP}`);
    return 2;
  }
  let result: LandPipelineResult;
  try { result = runLandPipeline(args); } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderReport(result));
  return result.complete ? 0 : 1;
}

if (import.meta.main) process.exit(main());
