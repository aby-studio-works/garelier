#!/usr/bin/env bun
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolvePlant } from "../plant.ts";
import { claimWork, releaseClaim } from "../control/claims.ts";
import { ControlGenerationError, ensureControlGenerationBootstrapped, readCanonicalControlBinding, readStableControl } from "../control/generation.ts";
import { applyGenerationRecovery, planGenerationRecovery } from "../control/generation_recovery.ts";
import { reconcilePlanGraphGit } from "../control/reconcile.ts";
import { applyPlanGraphRepairPlan, createPlanGraphRepairPlan, loadPlanGraphRepairPlan, savePlanGraphRepairPlan } from "../control/plan_graph_repair.ts";
import { ControlRootError, resolveControlRoots, resolveControlRootsForRecovery } from "../control/roots.ts";
import { buildPlanGraphContextNeighborhood, buildPlanGraphResume } from "../control/plan_graph_resume.ts";
import { loadBoundedPlanGraphResume } from "../control/plan_graph_resume_loader.ts";
import { loadPlanGraphModel } from "../control/plan_graph_model.ts";
import type { PlanGraphControlModel } from "../control/plan_graph_types.ts";
import { buildControlCockpit, MAX_COCKPIT_TOP_N, renderControlCockpit } from "../control/cockpit.ts";
import { applyBacklogTriageBatch, planBacklogTriageBatch } from "../control/backlog_triage_batch.ts";
import { applyLandingFinalization, planLandingFinalization } from "../control/landing_finalize.ts";
import { captureCheckpointGit, renderCheckpointGitCapture } from "../control/git_capture.ts";
import {
  appendEvidenceLines,
  planBacklogBatchCreate,
  planBacklogCreate,
  planBacklogUpdate,
  planCheckpointSave,
  planMilestoneCreate,
  planMilestoneDependencyUpdate,
  planNoteCreate,
  planNoteLink,
  patchCheckpointGitMetadata,
  planRoadmapCreate,
  planGraphRiskAdapter,
  planGraphArtifactRecord,
  planArtifactCreate,
  planArtifactUpdate,
  planGraphCheckpointAdapter,
  planGraphCurrentAdapter,
  planGraphDependencyRepairTransactionCallbacks,
  planGraphRecord,
  planGraphRecordAdapter,
  planGraphEvidenceReferences,
  planGraphRelationAdapter,
  planGraphRuntimeCallbacks,
  planGraphTransactionCallbacks,
  planRelationLink,
  planRiskCreate,
  planRiskUpdate,
  relationOwner,
  type PlanGraphArtifactMetadataInput,
  type PlanGraphArtifactMetadataPatch,
} from "../control/plan_graph_write.ts";
import {
  milestoneDependencyEntries,
  resolvedMilestoneDependencies,
  resolveMilestoneDependencySelector,
} from "../control/plan_graph_milestone_dependencies.ts";
import { reserveBacklogIds } from "../control/plan_graph_shared_ids.ts";
import { parseBacklogRecord, parseCheckpointRecord, parseRiskRecord } from "../control/plan_graph_schema.ts";
import {
  assertLifecycleV3ControlPath,
  planLifecycleV3Activation,
  planLifecycleV3BacklogReopen,
  planLifecycleV3BeginAction,
  planLifecycleV3FinishAction,
  planLifecycleV3Purge,
  planLifecycleV3RelationRetirement,
  planLifecycleV3RiskReopen,
  planLifecycleV3TerminalArchive,
  planLifecycleV3Transition,
  type LifecycleV3FilePlan,
} from "../control/lifecycle_v3.ts";
import { canonicalJson, sha256 } from "../control/serialization.ts";
import { assertSessionControlBinding, closeControlSession, heartbeatControlSession, openControlSession, readControlSession } from "../control/sessions.ts";
import { resolveControlNamespace, runControlFilePlanTransaction, type ControlFilePlanCallbacks, type ControlTransactionResult, type PlannedControlWrite } from "../control/transaction.ts";
import {
  PRIORITIES,
  RISK_LEVELS,
  RISK_STATES,
  WORK_STATES,
  type ControlFinding,
  type EvidenceReference,
} from "../control/types.ts";
import { buildControl } from "../status_control.ts";
import { detectForeignControlRoot, foreignCwdMessage, gitWorktreeProbe, resetPositionState, type WorktreeProbe } from "../control/cwd_fence.ts";
import { configurePathGuardRoots } from "../guard/path_guard.ts";
import { shellQuote } from "./_lib.ts";

type Format = "json" | "text" | "mermaid";

interface CommonOptions {
  project: string;
  container?: string;
  pmId: string;
  format: Format;
  /** W-267: opt out of the cwd fence when a lane's own committed control tree is
   *  genuinely the mutation target. */
  allowForeignCwd: boolean;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function refusalNextCommand(argv: string[], cwd: string, message: string): string | null {
  const flag = (name: string): string => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1]! : "";
  };
  const common = ["--project", flag("--project") || cwd, "--pm-id", flag("--pm-id") || "_workshop"];
  if (/cannot steal a Work without an existing stale claim/.test(message)) {
    const next: string[] = [];
    for (let index = 0; index < argv.length;) {
      if (argv[index] === "--steal") { index++; continue; }
      if (argv[index] === "--reason") { index += 2; continue; }
      next.push(argv[index]!); index++;
    }
    return ["garelier", "control", ...next].map((value) => shellQuote(value)).join(" ");
  }
  if (/invalid evidence shorthand|stale (?:Backlog|Risk)|expect(?:ed|_)(?: control )?revision/.test(message)) {
    const workId = argv.find((value) => /^(?:W|R)-\d+$/.test(value));
    if (workId) return ["garelier", "control", "get", workId, ...common, "--format", "json"].map((value) => shellQuote(value)).join(" ");
  }
  return null;
}

const USAGE = `usage:
  control context --resume | --backlog <W-NNN> | --checkpoint <CP-NNN> | --milestone <slug> | --roadmap <slug>
  control resume [--project <root>] [--container <id>] [--pm-id <id>] [--format json]
  control get <id> [--with-links] [--project <root>] [--pm-id <id>] [--format json]
  control list backlog|risk [filters] [--project <root>] [--pm-id <id>] [--format json]
  control doctor [--profile fast|strict] [--project <root>] [--pm-id <id>] [--format json]
  control generation-recover --plan | --apply --expect-plan-digest <sha> --expect-generation <odd> --session <id>
  control landing-finalize --plan --work <W-NNN> [--session <id>]
  control landing-finalize --apply --work <W-NNN> [--session <id>] --expect-plan-digest <sha> --expect-control-revision <rev>
  control reconcile --git [--project <root>] [--pm-id <id>] [--format json]
  control graph [--project <root>] [--pm-id <id>] [--format json|text|mermaid]
  control cockpit [--top-n <N>] [--project <root>] [--pm-id <id>] [--format json|text]
  control session-open --agent <id> [--session-id <id>]
  control session-heartbeat|session-close --session <id>
  control claim|claim-release <work-id> --session <id> [--touches <paths>]
  control backlog create --title <t> --type <t> --priority <p> --outcome <text> --next-action <text> --session <id> --expect-control-revision <rev> (schema 3; also --id, --acceptance (repeatable), --labels, --depends-on/--related, --no-inherit-milestones, --milestone none)
  control backlog update <W-NNN> ... --session <id>                (schema 3; accepts repeated --set-acceptance or --check-acceptance)
  control backlog create-batch --file <toml> --session <id> --expect-control-revision <rev> (schema 3; N rows, one transaction)
  control backlog triage-batch --plan --file <toml>               (schema 3; reviewed decisions, read-only plan)
  control backlog triage-batch --apply --file <toml> --expect-plan-digest <sha> --expect-control-revision <rev>
  control create roadmap|milestone|backlog|checkpoint|note --title <t> --session <id> --expect-control-revision <rev> (schema 3; roadmap/milestone also need --slug; checkpoint takes --next-action/--resume-verification; backlog takes --id/--type/--priority/--outcome/--acceptance/--next-action)
  control milestone update [<slug>] --add-dependency|--remove-dependency|--set-depends-on <slug[,slug...]|owner=target> --session <id> (schema 3)
  control relation link|retire ... --session <id>                  (schema 3)
  control transition roadmap|milestone|backlog|checkpoint|decision|blueprint <id> --to <status> --session <id> --expect-control-revision <rev> (schema 3)
  control transition-batch --file <toml> --session <id> --expect-control-revision <rev> (schema 3; N rows, one transaction, all-or-nothing)
  control archive|reopen|purge ... --session <id>                  (schema 3; reopen backlog <W-NNN> requires --reason and --evidence)
  control checkpoint save ... --session <id>                       (schema 3)
  control begin-action|finish-action ... --session <id>            (schema 3)
  control evidence-add <work-or-risk-id> --evidence <typed-ref> --session <id>
  control risk create|update|transition|archive|reopen ... --session <id>
  control artifact-create decision|blueprint --id <DEC-NNN|slug> --metadata-file <json> --body-file <markdown> --session <id> --expect-control-revision <rev> (schema 3)
  control artifact-update decision|blueprint <DEC-NNN|slug> [--metadata-file <json>] [--body-file <markdown>] --session <id> --expect-control-revision <rev> --expect-revision <updated-ms> (schema 3)
  control repair --plan | --apply <plan-id> --session <id>

Mutation preconditions: existing entity = --expect-revision; create/focus/config/gate = --expect-control-revision; split/reopen = both; [--dry-run]
cwd fence (W-267, opt-in via GARELIER_CONTROL_CWD_FENCE=1): a mutation whose control root resolves to
the committed __garelier copy inside a dispatch checkout / isolate lane is refused; cd to the repo root
(or pass --project <root>). Override once with --allow-foreign-cwd. Left OFF a lane keeps mutating its
own tree, which W-215 sanctions; an attended PM shell exports the variable to fence its stale cwd.`;

class UsageError extends Error {}

const WORK_ALIAS_WARNING = "control: `list work` is a deprecated compatibility alias; use `list backlog`.\n";

/**
 * W-667 F-3 — an EMPTY value and a MISSING value are different operator mistakes
 * and only one of them is a typo. `--session ""` is what a shell produces when
 * the variable holding the session id was never populated, which is the shape a
 * PM hits after capturing session-open's output incorrectly (note: session-open
 * writes its JSON to stdout, and the id is at `.session.session_id`, NOT at the
 * top level — reading `.session_id` yields null and then an empty --session).
 * Naming the flag alone sent the reader to USAGE, whose closing paragraph is
 * about the cwd fence, so they debugged the fence instead of the empty variable.
 */
function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === "") {
    throw new UsageError(
      `${flag} was given an EMPTY value — the variable holding it is unset, not the flag missing`
        + (flag === "--session"
          ? '. A session id comes from `garelier control session-open --agent <id> --format json` at `.session.session_id` (stdout); reading `.session_id` at the top level yields null'
          : ""),
    );
  }
  if (!value || value.startsWith("--")) throw new UsageError(`${flag} requires a value`);
  return value;
}

function commaList(value: string, flag: string): string[] {
  const values = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (!values.length) throw new UsageError(`${flag} requires at least one value`);
  return values;
}

function commaListOrEmpty(value: string, flag: string): string[] {
  return value === "none" ? [] : commaList(value, flag);
}

function expandEquals(argv: string[]): string[] {
  return argv.flatMap((arg) => {
    if (!arg.startsWith("--")) return [arg];
    const index = arg.indexOf("=");
    return index > 2 ? [arg.slice(0, index), arg.slice(index + 1)] : [arg];
  });
}

function enumList<T extends string>(value: string[] | undefined, allowed: readonly T[], flag: string): T[] | undefined {
  if (!value) return undefined;
  const invalid = value.find((item) => !allowed.includes(item as T));
  if (invalid) throw new UsageError(`${flag} has invalid value ${invalid}; allowed: ${allowed.join(", ")}`);
  return value as T[];
}

function parseCommon(argv: string[], cwd: string): { options: CommonOptions; rest: string[] } {
  let project = cwd;
  let container: string | undefined;
  let pmId = "_workshop";
  let format: Format = "json";
  let allowForeignCwd = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") { project = resolve(valueAfter(argv, i, arg)); i++; }
    else if (arg === "--container") { container = valueAfter(argv, i, arg); i++; }
    else if (arg === "--pm-id") { pmId = valueAfter(argv, i, arg); i++; }
    else if (arg === "--allow-foreign-cwd") { allowForeignCwd = true; }
    else if (arg === "--format") {
      const value = valueAfter(argv, i, arg);
      if (value !== "json" && value !== "text" && value !== "mermaid") throw new UsageError(`--format must be json, text, or mermaid (got ${value})`);
      format = value;
      i++;
    } else rest.push(arg);
  }
  return { options: { project, container, pmId, format, allowForeignCwd }, rest };
}

/**
 * Position authority for one control MUTATION. Two things, one resolution:
 *
 * W-545: declare the resolved control root as a fence root for this operation
 * (see the in-body comment), and
 *
 * W-267: refuse a control MUTATION whose resolved control root is the committed
 * `__garelier` copy carried by a dispatch checkout / isolate lane instead of the
 * repo's canonical tree. Read verbs are never fenced.
 *
 * Root discovery here goes through `resolvePlant` directly rather than `rootsFor`,
 * so the fence adds no generation read and stays usable by the recovery commands
 * that deliberately bypass `rootsFor` (W-222). Any resolution failure leaves the
 * fence inert — the normal path then reports its own, more precise error.
 */
export function assertControlCwdFence(command: string, options: CommonOptions, probe: WorktreeProbe = gitWorktreeProbe): void {
  // OPT-IN, and deliberately so. A lane creating rows from its OWN checkout is a
  // SANCTIONED workflow — W-215 exists precisely because "isolate lane は primary の
  // 新規 row が見えず採番が衝突する", and it was solved with a shared counter
  // (control/plan_graph_shared_ids.ts), not by forbidding lane mutations. At this
  // layer the lane's own role and a PM with a stale cwd issue byte-identical
  // commands, so a seat-blind fail-closed default would break the sanctioned case
  // to catch the accident. The attended shell that needs the fence is the one that
  // can declare it: export GARELIER_CONTROL_CWD_FENCE=1 in the PM session.
  let plant: ReturnType<typeof resolvePlant>;
  try { plant = resolvePlant(options.project, options.container); }
  catch { return; }

  // ORDER MATTERS, and an earlier revision had it backwards. The W-267 refusal
  // runs FIRST; only a root this fence did not reject is declared writable.
  // Declaring before checking meant a mutation the fence was about to refuse had
  // already been granted its target as a fence root — harmless in the end
  // (the throw aborts the operation) but it inverted the two rules, and the
  // comment claimed the fence "still decides", which is only true if it decides
  // FIRST.
  if (process.env.GARELIER_CONTROL_CWD_FENCE === "1") {
    const verdict = detectForeignControlRoot({ command, garelierRoot: plant.garelierRoot, mode: plant.mode, probe });
    if (verdict.foreign && !options.allowForeignCwd) {
      throw new ControlRootError("control-foreign-cwd", foreignCwdMessage(verdict, command, options.pmId));
    }
  }
  if (!plant.garelierRoot) return;

  // W-545: the control root this mutation RESOLVED is its declared write target,
  // so it is a fence root for this operation. Declared up front, not widened
  // after a refusal — nothing here retries or repairs anything. The reset at
  // `execute`'s entry and exit (W-467) bounds it to this one operation.
  //
  // RESIDUAL, stated rather than implied (r2): this declaration is NOT gated on
  // the caller being an attended PM, because nothing here can tell a PM from a
  // seat — `control` reads no dispatch record. So a SEAT that passes
  // `--project <parent>` also gets the parent's control root declared for that
  // one mutation, where the path fence would previously have refused it. What
  // bounds it: it is exactly the root the operator named, only for control
  // mutations, cleared at both ends of the operation, and the same target was
  // already reachable at base by `cd <parent> && control …` (cwd is fence root
  // #1), so the effective boundary is unchanged. The boundary that actually
  // holds for a seat is its record-derived explicit `fenceRoots`, which still
  // refuse the parent repository, and for codex the sandbox grant. The W-267
  // fence above is the control-MISPLACE defense and is opt-in; it is not what
  // makes this declaration safe, and an earlier comment here wrongly said it was.
  const roots: string[] = [plant.garelierRoot];

  // FORK-E note (r2): an earlier revision ALSO added the repository main
  // worktree root here, through a `.git`-pointer reader in path_guard. Measured,
  // it added nothing: every path this route writes lives under the control root
  // already declared above, so the extra root never decided anything. A guard
  // that never fires is not a guard, so the reader was deleted rather than given
  // a caller for its own sake. A PM write OUTSIDE `__garelier/<pm>/` from a lane
  // cwd is a real but separate gap and is reported, not silently widened here.
  configurePathGuardRoots(roots);
}


const resolvedRoots = new WeakMap<CommonOptions, ReturnType<typeof resolveControlRoots>>();
function rootsFor(options: CommonOptions): ReturnType<typeof resolveControlRoots> {
  let roots = resolvedRoots.get(options);
  if (!roots) { roots = resolveControlRoots(options.project, options.pmId, options.container); resolvedRoots.set(options, roots); }
  return roots;
}


function findingsSummary(findings: ControlFinding[]): { errors: number; warnings: number; info: number } {
  return {
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
    info: findings.filter((finding) => finding.severity === "info").length,
  };
}

function emit(value: unknown, options: CommonOptions, text?: string): string {
  if (options.format === "json") return canonicalJson(value);
  if (options.format === "mermaid") {
    if (!text) throw new UsageError("--format mermaid is supported only by control graph");
    return text;
  }
  return `${text ?? JSON.stringify(value, null, 2)}\n`;
}


interface ParsedCommandArgs {
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
}

function parseCommandArgs(argv: string[], valueFlags: readonly string[], booleanFlags: readonly string[] = []): ParsedCommandArgs {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  const allowedValues = new Set(valueFlags);
  const allowedBooleans = new Set(booleanFlags);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    if (allowedBooleans.has(arg)) { booleans.add(arg); continue; }
    if (!allowedValues.has(arg)) throw new UsageError(`unknown argument: ${arg}`);
    const value = valueAfter(argv, index, arg);
    values.set(arg, [...(values.get(arg) ?? []), value]);
    index++;
  }
  return { positionals, values, booleans };
}

function optionalArg(args: ParsedCommandArgs, flag: string): string | undefined {
  const values = args.values.get(flag);
  if (!values) return undefined;
  if (values.length !== 1) throw new UsageError(`${flag} may be specified only once`);
  return values[0];
}

function requiredArg(args: ParsedCommandArgs, flag: string): string {
  const value = optionalArg(args, flag);
  if (!value) throw new UsageError(`${flag} is required`);
  return value;
}

/**
 * W-620 追記 L-4 — report every missing requirement in one run.
 *
 * `requiredArg` throws on the first one it finds, so a caller missing two flags
 * pays two round trips to learn two facts the parser already had. A PM adding
 * `--session` only to be told `--expect-control-revision is required` is the
 * measured case. Order is preserved so the message reads as the command should
 * be typed.
 */
function requireAllArgs(args: ParsedCommandArgs, flags: readonly string[]): string[] {
  const missing = flags.filter((flag) => !optionalArg(args, flag));
  if (missing.length) {
    throw new UsageError(
      missing.length === 1
        ? `${missing[0]} is required`
        : `missing required argument(s): ${missing.join(", ")}`,
    );
  }
  return flags.map((flag) => requiredArg(args, flag));
}

function handleLandingFinalize(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(
    rest,
    ["--work", "--session", "--expect-plan-digest", "--expect-control-revision"],
    ["--plan", "--apply"],
  );
  if (args.positionals.length) throw new UsageError(`unexpected landing-finalize argument: ${args.positionals[0]}`);
  const planning = args.booleans.has("--plan");
  const applying = args.booleans.has("--apply");
  if (planning === applying) throw new UsageError("landing-finalize requires exactly one of --plan or --apply");
  requireV3(options);
  const resolved = rootsFor(options);
  const landing = {
    roots: {
      projectRoot: resolve(options.project),
      targetRoot: resolved.targetRoot,
      pmId: options.pmId,
      controlRoot: resolved.controlRoot,
      runtimeRoot: resolved.runtimeRoot,
    },
    workId: requiredArg(args, "--work"),
    sessionId: optionalArg(args, "--session"),
  };
  if (planning) {
    if (args.values.has("--expect-plan-digest") || args.values.has("--expect-control-revision")) {
      throw new UsageError("landing-finalize --plan does not accept apply preconditions");
    }
    return planLandingFinalization(landing);
  }
  return applyLandingFinalization({
    ...landing,
    expectedPlanDigest: requiredArg(args, "--expect-plan-digest"),
    expectedControlRevision: requiredArg(args, "--expect-control-revision"),
  });
}

function positional(args: ParsedCommandArgs, index: number, label: string): string {
  const value = args.positionals[index];
  if (!value) throw new UsageError(`${label} is required`);
  if (args.positionals.length > index + 1) throw new UsageError(`unexpected positional argument: ${args.positionals[index + 1]}`);
  return value;
}

function integerArg(value: string, flag: string, minimum = 1): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new UsageError(`${flag} must be an integer >= ${minimum}`);
  return parsed;
}

function booleanValue(value: string, flag: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new UsageError(`${flag} must be true or false`);
}

function localSchemaVersion(options: CommonOptions): number | null {
  // Preserve argument-error precedence: the common parse never touches the
  // filesystem. Lithosphere can cheaply identify an unsupported schema before
  // command dispatch; Plant-Crust resolves only when the command reads state.
  const marker = join(options.project, "__garelier", options.pmId, "control", "control.toml");
  if (!existsSync(marker)) return null;
  const match = readFileSync(marker, "utf8").match(/^\s*schema_version\s*=\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

function schemaVersion(options: CommonOptions): number | null {
  const local = localSchemaVersion(options);
  if (local !== null) return local;
  const roots = rootsFor(options);
  const marker = join(roots.controlRoot, "control.toml");
  if (!existsSync(marker)) return null;
  const match = readFileSync(marker, "utf8").match(/^\s*schema_version\s*=\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

function validateReadSyntax(command: string, input: string[]): void {
  const rest = [...input];
  if (command === "cockpit") {
    const args = parseCommandArgs(rest, ["--top-n"]);
    if (args.positionals.length) throw new UsageError(`unexpected cockpit argument: ${args.positionals[0]}`);
    const topN = optionalArg(args, "--top-n");
    if (topN !== undefined) integerArg(topN, "--top-n");
    return;
  }
  if (command === "context") {
    const args = parseCommandArgs(
      rest,
      ["--backlog", "--checkpoint", "--milestone", "--roadmap", "--related", "--to", "--depth"],
      ["--resume", "--all-checkpoints", "--read-first"],
    );
    if (args.positionals.length) throw new UsageError(`unexpected context argument: ${args.positionals[0]}`);
    if (args.booleans.has("--resume")) return;
    if (args.values.has("--related")) {
      if (requiredArg(args, "--related") !== "note") throw new UsageError("context --related currently supports note");
      requiredArg(args, "--to");
      return;
    }
    const selectors = ["--backlog", "--checkpoint", "--milestone", "--roadmap"].filter((flag) => args.values.has(flag));
    if (selectors.length !== 1) throw new UsageError("context requires --resume or exactly one entity selector");
    return;
  }
  if (command === "resume" || command === "graph") {
    if (rest.length) throw new UsageError(`unknown ${command} argument: ${rest[0]}`);
    return;
  }
  if (command === "get") {
    const id = rest.shift();
    if (!id || id.startsWith("--")) throw new UsageError("get requires an entity ID");
    for (const arg of rest) if (arg !== "--with-links") throw new UsageError(`unknown get argument: ${arg}`);
    return;
  }
  if (command === "list") {
    const requestedKind = rest.shift();
    if (requestedKind !== "backlog" && requestedKind !== "work" && requestedKind !== "risk") throw new UsageError("list requires backlog or risk");
    const kind = requestedKind === "backlog" ? "work" : requestedKind;
    const allowed = kind === "work" ? new Set(["--state", "--priority", "--milestone", "--label"]) : new Set(["--state", "--severity", "--milestone"]);
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!;
      if (arg === "--include-closed") continue;
      if (!allowed.has(arg)) throw new UsageError(`unknown ${kind} list argument: ${arg}`);
      const values = commaList(valueAfter(rest, index, arg), arg);
      if (arg === "--state") enumList(values, kind === "work" ? WORK_STATES : RISK_STATES, arg);
      else if (arg === "--priority") enumList(values, PRIORITIES, arg);
      else if (arg === "--severity") enumList(values, RISK_LEVELS, arg);
      index++;
    }
    return;
  }
  if (command === "doctor") {
    for (let index = 0; index < rest.length; index++) {
      if (rest[index] !== "--profile") throw new UsageError(`unknown doctor argument: ${rest[index]}`);
      const value = valueAfter(rest, index, "--profile");
      if (value !== "fast" && value !== "strict") throw new UsageError(`--profile must be fast or strict (got ${value})`);
      index++;
    }
  }
}

/**
 * W-621 [TX-3] — surface residual control-transaction staging directories.
 *
 * A transaction stages a whole copy of the control tree in
 * `.<control>.txn-<random>/` beside the control root and removes it on commit or
 * rollback. A crashed or interrupted one leaves it there; a real instance sat
 * for 13 hours. Being a dotfile it is invisible to `ls`, so the only way anyone
 * noticed was `git status` showing `??` — and `doctor --profile strict` returned
 * zero findings the whole time, which reads as "the tree is clean".
 *
 * This REPORTS. It does not delete: deciding whether a staging directory belongs
 * to a live transaction is exactly the judgement that must not be mechanized
 * from a timestamp, and removing a live one destroys an in-flight mutation. The
 * finding is a `warning`, so `doctor`'s exit code is unchanged and no existing
 * caller starts failing on residue that was always there.
 */
export function residualControlStagingFindings(controlRoot: string): ControlFinding[] {
  const parent = dirname(resolve(controlRoot));
  const prefix = `.${basename(resolve(controlRoot))}.txn-`;
  let entries: string[];
  try { entries = readdirSync(parent); } catch { return []; }
  return entries
    .filter((entry) => entry.startsWith(prefix))
    .sort()
    .map((entry) => ({
      severity: "warning" as const,
      code: "control_staging_residue",
      entity: null,
      path: join(parent, entry),
      field: null,
      message:
        "a control transaction staging directory is still present. It is a dotfile, so it does not appear in `ls`, "
        + "but `git add -A` would commit a duplicate of the whole control tree. It belongs either to a transaction "
        + "running right now or to one that crashed — inspect before removing; deleting a live one destroys an "
        + "in-flight mutation.",
      suggested_command: `ls -la ${join(parent, entry)}`,
    }));
}

function publicTransaction(result: ControlTransactionResult): Omit<ControlTransactionResult, "diagnostic"> {
  return {
    status: result.status,
    control_revision_before: result.control_revision_before,
    control_revision_after: result.control_revision_after,
    changes: result.changes,
    entity: result.entity,
    entity_revision_after: result.entity_revision_after,
  };
}

function parseEvidence(shorthand: string, now: string, writer: string, model?: { controlRoot: string }): EvidenceReference {
  const [kind, ...parts] = shorthand.split(":");
  const base = { observed_at: now, writer, summary: shorthand };
  if (kind === "commit" && parts.length === 1) return { kind, commit: parts[0], ...base };
  if (kind === "decision" && parts.length === 1) return { kind, id: parts[0], ...base };
  if ((kind === "report" || kind === "path") && parts.length >= 1) return { kind, root: "control", path: parts.join(":"), ...base };
  if (kind === "test" && parts.length >= 1) return { kind, id: parts[0], summary: parts.join(":"), observed_at: now, writer };
  if (kind === "gate" && parts.length >= 3) {
    const [id, commit, ...path] = parts;
    const relativePath = path.join(":");
    if (!model) throw new UsageError("gate evidence can only be sealed inside a Control transaction");
    const absolute = resolve(model.controlRoot, ...relativePath.split("/"));
    const rel = relative(resolve(model.controlRoot), absolute);
    if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) {
      throw new UsageError(`gate evidence path must be a regular non-symlink file below control: ${relativePath}`);
    }
    return { kind, id, commit, root: "control", path: relativePath, content_hash: sha256(readFileSync(absolute)), ...base };
  }
  throw new UsageError(`invalid evidence shorthand: ${shorthand}`);
}

function handleClaim(command: string, rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, ["--session", "--touches", "--reason"], ["--steal"]);
  const workId = positional(args, 0, "Work ID");
  const sessionId = requiredArg(args, "--session");
  const roots = rootsFor(options);
  const runtimeCallbacks = planGraphRuntimeCallbacks;
  if (command === "claim-release" || command === "work-release") {
    if (args.values.has("--touches") || args.values.has("--reason") || args.booleans.size) throw new UsageError("claim-release accepts only Work ID and --session");
    return { work_id: workId, released: releaseClaim({ targetRoot: roots.targetRoot, pmId: options.pmId, controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot, runtimeCallbacks, workId, sessionId }) };
  }
  return claimWork({
    targetRoot: roots.targetRoot,
    pmId: options.pmId,
    controlRoot: roots.controlRoot,
    runtimeRoot: roots.runtimeRoot,
    runtimeCallbacks,
    workId,
    sessionId,
    touches: args.values.get("--touches")?.flatMap((value) => commaList(value, "--touches")),
    steal: args.booleans.has("--steal"),
    reason: optionalArg(args, "--reason"),
  });
}


function updateStringList(current: readonly string[], args: ParsedCommandArgs, flags: { set: string; add: string; remove: string }): string[] {
  const hasSet = args.values.has(flags.set);
  if (hasSet && (args.values.has(flags.add) || args.values.has(flags.remove))) {
    throw new UsageError(`${flags.set} cannot be combined with ${flags.add} or ${flags.remove}`);
  }
  const values = new Set(hasSet ? commaListOrEmpty(optionalArg(args, flags.set)!, flags.set) : current);
  for (const value of args.values.get(flags.add) ?? []) for (const item of commaList(value, flags.add)) values.add(item);
  for (const value of args.values.get(flags.remove) ?? []) for (const item of commaList(value, flags.remove)) values.delete(item);
  return [...values].sort();
}


const MAX_ARTIFACT_METADATA_BYTES = 64 * 1024;
const MAX_ARTIFACT_BODY_BYTES = 8 * 1024 * 1024;

function filesystemIdentity(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

function pathKey(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function assertRealRegularPath(path: string, label: string): void {
  const root = parsePath(path).root;
  const chain: string[] = [];
  for (let cursor = path; pathKey(cursor) !== pathKey(root); cursor = dirname(cursor)) chain.push(cursor);
  chain.push(root);
  for (const cursor of chain.reverse()) {
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new UsageError(`${label} must not traverse a symlink, junction, or reparse point: ${cursor}`);
    if (cursor === path ? !info.isFile() : !info.isDirectory()) {
      throw new UsageError(`${label} must be a real regular file: ${path}`);
    }
  }
  if (pathKey(realpathSync.native(path)) !== pathKey(path)) {
    throw new UsageError(`${label} must not traverse a symlink, junction, or reparse point: ${path}`);
  }
}

function readBoundedArtifactInput(rawPath: string, label: string, maximumBytes: number): string {
  const path = resolve(rawPath);
  assertRealRegularPath(path, label);
  const before = lstatSync(path);
  if (before.size > maximumBytes) throw new UsageError(`${label} exceeds ${maximumBytes} bytes: ${rawPath}`);
  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor);
    if (filesystemIdentity(before) !== filesystemIdentity(opened)) throw new UsageError(`${label} changed identity before read: ${rawPath}`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    assertRealRegularPath(path, label);
    const final = lstatSync(path);
    if (bytes.length > maximumBytes) throw new UsageError(`${label} exceeds ${maximumBytes} bytes: ${rawPath}`);
    if (filesystemIdentity(opened) !== filesystemIdentity(after) || filesystemIdentity(after) !== filesystemIdentity(final)) {
      throw new UsageError(`${label} changed identity during read: ${rawPath}`);
    }
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new UsageError(`${label} must be valid UTF-8: ${rawPath}`); }
    if (source.includes("\0")) throw new UsageError(`${label} must not contain NUL bytes: ${rawPath}`);
    return source;
  } finally {
    closeSync(descriptor);
  }
}

function parseJsonWithoutDuplicateKeys(source: string, label: string): unknown {
  let cursor = 0;
  const whitespace = (): void => { while (/\s/.test(source[cursor] ?? "")) cursor++; };
  const fail = (message: string): never => { throw new UsageError(`${label} is not valid JSON: ${message} at byte ${cursor}`); };
  const string = (): string => {
    if (source[cursor] !== '"') fail("expected string");
    const start = cursor++;
    while (cursor < source.length) {
      const value = source[cursor++]!;
      if (value === '"') {
        try { return JSON.parse(source.slice(start, cursor)) as string; }
        catch { fail("invalid string escape"); }
      }
      if (value === "\\") cursor++;
      else if (value.charCodeAt(0) < 0x20) fail("unescaped control character");
    }
    return fail("unterminated string");
  };
  const value = (): void => {
    whitespace();
    const token = source[cursor];
    if (token === "{") {
      cursor++;
      whitespace();
      const keys = new Set<string>();
      if (source[cursor] === "}") { cursor++; return; }
      while (cursor < source.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new UsageError(`${label} contains duplicate JSON key: ${key}`);
        keys.add(key);
        whitespace();
        if (source[cursor++] !== ":") fail("expected colon");
        value();
        whitespace();
        const separator = source[cursor++];
        if (separator === "}") return;
        if (separator !== ",") fail("expected comma or closing brace");
      }
      fail("unterminated object");
    }
    if (token === "[") {
      cursor++;
      whitespace();
      if (source[cursor] === "]") { cursor++; return; }
      while (cursor < source.length) {
        value();
        whitespace();
        const separator = source[cursor++];
        if (separator === "]") return;
        if (separator !== ",") fail("expected comma or closing bracket");
      }
      fail("unterminated array");
    }
    if (token === '"') { string(); return; }
    const scalarMatch = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(cursor));
    if (!scalarMatch) return fail("invalid value");
    const scalar = scalarMatch[0];
    cursor += scalar.length;
  };
  value();
  whitespace();
  if (cursor !== source.length) fail("trailing content");
  try { return JSON.parse(source); }
  catch (error) { throw new UsageError(`${label} is not valid JSON: ${(error as Error).message}`); }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new UsageError(`${label} must be an array of strings`);
  return [...value] as string[];
}

function parseV3ArtifactMetadata(
  source: string,
  kind: "decision" | "blueprint",
  requireTitle: boolean,
): PlanGraphArtifactMetadataInput | PlanGraphArtifactMetadataPatch {
  const parsed = parseJsonWithoutDuplicateKeys(source, "--metadata-file");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError("--metadata-file must contain a JSON object");
  const input = parsed as Record<string, unknown>;
  const allowed = kind === "decision"
    ? new Set(["title", "related", "supersedes"])
    : new Set(["title", "related", "backlog_ids", "decision_ids", "acceptance_ids"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new UsageError(`--metadata-file has forbidden key for ${kind}: ${unknown}`);
  if (requireTitle && typeof input.title !== "string") throw new UsageError("--metadata-file title is required and must be a string");
  if (input.title !== undefined && typeof input.title !== "string") throw new UsageError("--metadata-file title must be a string");
  const metadata: PlanGraphArtifactMetadataPatch = {};
  if (input.title !== undefined) metadata.title = input.title;
  if (input.related !== undefined) metadata.related = stringArray(input.related, "--metadata-file related");
  if (kind === "decision" && input.supersedes !== undefined) metadata.supersedes = stringArray(input.supersedes, "--metadata-file supersedes");
  if (kind === "blueprint") {
    if (input.backlog_ids !== undefined) metadata.backlogIds = stringArray(input.backlog_ids, "--metadata-file backlog_ids");
    if (input.decision_ids !== undefined) metadata.decisionIds = stringArray(input.decision_ids, "--metadata-file decision_ids");
    if (input.acceptance_ids !== undefined) metadata.acceptanceIds = stringArray(input.acceptance_ids, "--metadata-file acceptance_ids");
  }
  return metadata as PlanGraphArtifactMetadataInput | PlanGraphArtifactMetadataPatch;
}

type ArtifactHtmlBlock = { end: RegExp } | { untilBlank: true };

const COMMONMARK_HTML_BLOCK_TAG = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i;
const COMMONMARK_COMPLETE_HTML_TAG = /^ {0,3}(?:<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>|<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>)[ \t]*$/;

function artifactHtmlBlockStart(line: string): ArtifactHtmlBlock | null {
  const rawTag = /^ {0,3}<(?:pre|script|style|textarea)(?:[ \t]|>|$)/i.exec(line);
  if (rawTag) return { end: /<\/(?:pre|script|style|textarea)>/i };
  if (/^ {0,3}<!--/.test(line)) return { end: /-->/ };
  if (/^ {0,3}<\?/.test(line)) return { end: /\?>/ };
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return { end: /\]\]>/ };
  if (/^ {0,3}<![A-Z]/.test(line)) return { end: />/ };
  const blockTag = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|\/?>|$)/.exec(line);
  if (blockTag && COMMONMARK_HTML_BLOCK_TAG.test(blockTag[1]!)) return { untilBlank: true };
  return null;
}

function validateArtifactBody(source: string): string {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) throw new UsageError("--body-file must contain non-empty Markdown");
  if (/^\s*\+\+\+[ \t]*(?:\n|$)/.test(normalized)) {
    throw new UsageError("--body-file must not contain TOML front matter");
  }
  let fence: { marker: string; length: number } | null = null;
  let htmlBlock: ArtifactHtmlBlock | null = null;
  let h1Count = 0;
  let nonEmptyH1Count = 0;
  for (const line of normalized.split("\n")) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (htmlBlock) {
      const closed = "untilBlank" in htmlBlock ? /^[ \t]*$/.test(line) : htmlBlock.end.test(line);
      if (closed) {
        htmlBlock = null;
      }
      continue;
    }
    const htmlStart = artifactHtmlBlockStart(line);
    if (htmlStart) {
      if (!("end" in htmlStart && htmlStart.end.test(line))) htmlBlock = htmlStart;
      continue;
    }
    if (COMMONMARK_COMPLETE_HTML_TAG.test(line)) {
      throw new UsageError("--body-file must not contain standalone CommonMark type-7 HTML tags");
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { marker: opening[1]![0]!, length: opening[1]!.length };
      continue;
    }
    if (/^[ \t]*$/.test(line)) {
      continue;
    }
    const heading = /^ {0,3}#(?:[ \t]+|$)(.*)$/.exec(line);
    if (heading) {
      h1Count++;
      const rawContent = heading[1]!.trim();
      const content = /^#+$/.test(rawContent)
        ? ""
        : rawContent.replace(/[ \t]+#+$/, "").trim();
      if (content) nonEmptyH1Count++;
      continue;
    }
  }
  if (htmlBlock && "end" in htmlBlock) {
    throw new UsageError("--body-file contains an unclosed CommonMark HTML block");
  }
  if (h1Count !== 1 || nonEmptyH1Count !== 1) throw new UsageError("--body-file must contain exactly one non-empty H1 heading");
  return normalized;
}



function v3ArtifactKind(value: string | undefined): "decision" | "blueprint" {
  if (value !== "decision" && value !== "blueprint") throw new UsageError("schema-3 artifact kind must be decision or blueprint");
  return value;
}

function handleV3ArtifactCreate(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, [
    ...V3_TRANSACTION_FLAGS, "--id", "--metadata-file", "--body-file",
  ], V3_TRANSACTION_BOOLEANS);
  if (args.positionals.length !== 1) throw new UsageError("schema-3 artifact-create requires decision|blueprint");
  const kind = v3ArtifactKind(args.positionals[0]);
  const id = requiredArg(args, "--id");
  const metadata = parseV3ArtifactMetadata(
    readBoundedArtifactInput(requiredArg(args, "--metadata-file"), "--metadata-file", MAX_ARTIFACT_METADATA_BYTES),
    kind,
    true,
  ) as PlanGraphArtifactMetadataInput;
  const body = validateArtifactBody(readBoundedArtifactInput(
    requiredArg(args, "--body-file"),
    "--body-file",
    MAX_ARTIFACT_BODY_BYTES,
  ));
  return planGraphTransaction("artifact-create", args, options, (model, now) => planArtifactCreate({
    model,
    kind,
    id,
    metadata,
    body,
    now,
  }));
}

function handleV3ArtifactUpdate(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, [
    ...V3_TRANSACTION_FLAGS, "--expect-revision", "--metadata-file", "--body-file",
  ], V3_TRANSACTION_BOOLEANS);
  if (args.positionals.length !== 2) throw new UsageError("schema-3 artifact-update requires decision|blueprint <DEC-NNN|slug>");
  const kind = v3ArtifactKind(args.positionals[0]);
  const id = args.positionals[1]!;
  if (!args.values.has("--metadata-file") && !args.values.has("--body-file")) {
    throw new UsageError("schema-3 artifact-update requires --metadata-file and/or --body-file");
  }
  const metadataFile = optionalArg(args, "--metadata-file");
  const bodyFile = optionalArg(args, "--body-file");
  const metadata = metadataFile === undefined ? undefined : parseV3ArtifactMetadata(
    readBoundedArtifactInput(metadataFile, "--metadata-file", MAX_ARTIFACT_METADATA_BYTES),
    kind,
    false,
  ) as PlanGraphArtifactMetadataPatch;
  const body = bodyFile === undefined ? undefined : validateArtifactBody(readBoundedArtifactInput(
    bodyFile,
    "--body-file",
    MAX_ARTIFACT_BODY_BYTES,
  ));
  const entityKey = `${kind}:${id}`;
  const expectedEntityRevision = integerArg(requiredArg(args, "--expect-revision"), "--expect-revision", 1);
  return planGraphTransaction("artifact-update", args, options, (model, now) => planArtifactUpdate({
    model,
    record: planGraphArtifactRecord(model, kind, id),
    metadata,
    body,
    now,
  }), planGraphTransactionCallbacks, { key: entityKey, revision: expectedEntityRevision });
}






function handleRepair(rest: string[], options: CommonOptions): unknown {
  return handleSchema3Repair(rest, options);
}

// schema-3 (plan_graph_markdown) repair: non-canonical record paths (W-207
// D1) and annotated-legacy-status-collapsed-to-triage records (W-207 D2) in
// an already-migrated control tree. `--agent` is required only for --apply,
// and only actually used when no session with `--session`'s id is already
// open — applyPlanGraphRepairPlan self-bootstraps a tolerant session in that
// case (a tree broken since checkout cannot open a normal strict session).
function handleSchema3Repair(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, ["--apply", "--session", "--agent"], ["--plan"]);
  if (args.positionals.length) throw new UsageError(`unexpected positional argument: ${args.positionals[0]}`);
  const planning = args.booleans.has("--plan"), applying = args.values.has("--apply");
  if (planning === applying) throw new UsageError("repair requires exactly one of --plan or --apply <plan-id>");
  const roots = rootsFor(options);
  const pathOptions = { targetRoot: roots.targetRoot, pmId: options.pmId, controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot };
  if (planning) {
    if (args.values.has("--session") || args.values.has("--agent")) throw new UsageError("repair --plan is read-only and does not accept --session or --agent");
    const plan = createPlanGraphRepairPlan(pathOptions);
    savePlanGraphRepairPlan(pathOptions, plan);
    return plan;
  }
  const sessionId = requiredArg(args, "--session");
  const paths = resolveControlNamespace(pathOptions);
  let agent: string;
  try {
    const session = readControlSession(paths, sessionId);
    assertSessionControlBinding(session, readCanonicalControlBinding(paths.controlRoot));
    agent = session.agent;
  } catch {
    agent = requiredArg(args, "--agent");
  }
  const planId = requiredArg(args, "--apply");
  const plan = loadPlanGraphRepairPlan(pathOptions, planId);
  return publicTransaction(applyPlanGraphRepairPlan({ ...pathOptions, planId, sessionId, agent }, plan));
}

const V3_TRANSACTION_FLAGS = ["--session", "--expect-control-revision"] as const;
const V3_TRANSACTION_BOOLEANS = ["--dry-run"] as const;

function planGraphFor(options: CommonOptions, allowErrors = false): PlanGraphControlModel {
  const roots = rootsFor(options);
  return readStableControl({ controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot }, () => {
    const model = loadPlanGraphModel(roots.controlRoot);
    const error = model.findings.find((finding) => finding.severity === "error");
    if (error && !allowErrors) throw new Error(`schema-3 strict validation failed: ${error.code}: ${error.message}`);
    return model;
  });
}

function captureTargetGit(options: CommonOptions) {
  const roots = rootsFor(options);
  return captureCheckpointGit(roots.targetRoot, {
    excludeRoots: [roots.controlRoot, roots.runtimeRoot],
  });
}

function boundedPlanGraphResumeFor(options: CommonOptions, controlRevision?: string) {
  const roots = rootsFor(options);
  return readStableControl({ controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot }, () => {
    const loaded = loadBoundedPlanGraphResume(roots.controlRoot);
    let repositoryState: ReturnType<typeof captureCheckpointGit> | undefined;
    try {
      repositoryState = captureCheckpointGit(roots.targetRoot, {
        excludeRoots: [roots.controlRoot, roots.runtimeRoot],
      });
    } catch { /* non-git source */ }
    const packet = buildPlanGraphResume(loaded.model, {
      inventory: loaded.inventory,
      repositoryState: repositoryState ? {
        branch: repositoryState.branch,
        head: repositoryState.head,
        workingTree: repositoryState.workingTree,
        statusHash: repositoryState.statusHash,
        staged: repositoryState.staged,
        modified: repositoryState.modified,
        untracked: repositoryState.untracked,
      } : undefined,
    });
    // `packet.control_revision` must always equal the value get/create/update
    // check for --expect-control-revision, but `loaded.model.revision` is a
    // bounded reachability hash (only files the resume loader actually reads
    // via Current/Checkpoint navigation) — a Backlog/Note/etc. row that is not
    // yet reachable from an active Checkpoint never touches it, so it goes
    // stale the moment such a write lands (W-219). The canonical value is
    // loadPlanGraphModel's full-tree revision; a session-open caller already
    // has it cheaply (session.base_control_revision) and passes it in, so only
    // recompute it here when no caller-supplied revision was given. Both loads
    // happen inside the same readStableControl generation, so they cannot
    // observe different writes.
    packet.control_revision = controlRevision ?? loadPlanGraphModel(roots.controlRoot).revision;
    return packet;
  });
}

function requireV3(options: CommonOptions): void {
  const version = schemaVersion(options);
  if (version !== 3) throw new Error(`schema-3 command refused: canonical schema_version is ${version ?? "missing"}`);
}

function planGraphTransaction(
  command: string,
  args: ParsedCommandArgs,
  options: CommonOptions,
  mutate: (model: PlanGraphControlModel, now: string, agent: string) => LifecycleV3FilePlan,
  callbacks: ControlFilePlanCallbacks<PlanGraphControlModel> = planGraphTransactionCallbacks,
  entityPrecondition?: { key: string; revision: number },
): unknown {
  requireV3(options);
  // Both preconditions at once (L-4): every mutation verb needs both, so
  // disclosing them one at a time costs a round trip per flag.
  const [sessionId, expectedControlRevision] = requireAllArgs(args, ["--session", "--expect-control-revision"]) as [string, string];
  const roots = rootsFor(options);
  const paths = resolveControlNamespace({
    targetRoot: roots.targetRoot,
    pmId: options.pmId,
    controlRoot: roots.controlRoot,
    runtimeRoot: roots.runtimeRoot,
  });
  const session = readControlSession(paths, sessionId);
  assertSessionControlBinding(session, readCanonicalControlBinding(paths.controlRoot));
  const result = runControlFilePlanTransaction({
    targetRoot: roots.targetRoot,
    pmId: options.pmId,
    controlRoot: roots.controlRoot,
    runtimeRoot: roots.runtimeRoot,
    agent: session.agent,
    sessionId,
    command,
    expectedControlRevision,
    expectedEntityRevisions: entityPrecondition ? { [entityPrecondition.key]: entityPrecondition.revision } : undefined,
    dryRun: args.booleans.has("--dry-run"),
    callbacks,
    mutate: ({ state, now }) => mutate(state, now, session.agent),
  });
  return publicTransaction(result);
}

const PLAN_GRAPH_GET_TYPED_ID = {
  roadmap: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  milestone: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  backlog: /^W-\d+$/,
  "backlog-view": /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  checkpoint: /^CP-\d+$/,
  risk: /^R-\d+$/,
  note: /^N-\d+$/,
  decision: /^DEC-\d+$/,
  blueprint: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
} as const;

function normalizePlanGraphGetRef(raw: string): string {
  if (!raw.includes(":")) return /^W-\d+$/.test(raw)
    ? `backlog:${raw}`
    : /^R-\d+$/.test(raw)
      ? `risk:${raw}`
      : /^CP-\d+$/.test(raw)
        ? `checkpoint:${raw}`
        : raw;
  const match = raw.match(/^([a-z-]+):([^:]+)$/);
  if (!match) throw new UsageError(`malformed typed entity reference: ${raw}`);
  const [, kind, id] = match;
  const idPattern = PLAN_GRAPH_GET_TYPED_ID[kind as keyof typeof PLAN_GRAPH_GET_TYPED_ID];
  if (!idPattern) throw new UsageError(`unknown typed entity kind: ${kind}`);
  if (!idPattern.test(id)) throw new UsageError(`typed entity kind/id mismatch: ${raw}`);
  return raw;
}

function planGraphEntity(model: PlanGraphControlModel, raw: string): unknown {
  const typed = normalizePlanGraphGetRef(raw);
  const [kind, id] = typed.split(":", 2);
  if (!id) {
    const matches = [
      model.roadmaps.get(raw),
      model.milestones.get(raw),
      model.decisions.get(raw),
      model.blueprints.get(raw),
    ].filter(Boolean);
    return matches.length === 1 ? matches[0] : null;
  }
  if (kind === "roadmap") return model.roadmaps.get(id) ?? null;
  if (kind === "milestone") return model.milestones.get(id) ?? null;
  if (kind === "backlog") return model.backlog.get(id) ?? null;
  if (kind === "checkpoint") return model.checkpoints.get(id) ?? null;
  if (kind === "risk") return model.risks.get(id) ?? null;
  if (kind === "backlog-view") return model.backlogViews.get(id) ?? null;
  if (kind === "decision") return model.decisions.get(id) ?? null;
  if (kind === "blueprint") return model.blueprints.get(id) ?? null;
  if (kind === "note") return model.notes.find((note) => note.id === id) ?? null;
  return null;
}

function planGraphEntityTypedRef(entity: unknown): string {
  if (!entity || typeof entity !== "object") throw new Error("plan graph entity must be a record");
  const record = entity as { kind?: unknown; id?: unknown; slug?: unknown };
  const kind = record.kind === "backlog_view" ? "backlog-view" : record.kind;
  const id = typeof record.id === "string" ? record.id : record.slug;
  if (typeof kind !== "string" || typeof id !== "string") throw new Error("plan graph entity has no typed identity");
  const idPattern = PLAN_GRAPH_GET_TYPED_ID[kind as keyof typeof PLAN_GRAPH_GET_TYPED_ID];
  if (!idPattern || !idPattern.test(id)) throw new Error(`plan graph entity has invalid typed identity: ${kind}:${id}`);
  return `${kind}:${id}`;
}

function planGraphMermaid(model: PlanGraphControlModel): string {
  const nodeId = (id: string): string => `n${Buffer.from(id).toString("hex")}`;
  const lines = ["flowchart TD"];
  for (const node of model.graph.nodes) lines.push(`  ${nodeId(node.id)}[${JSON.stringify(`${node.id} (${node.kind})`)}]`);
  for (const edge of model.graph.edges) lines.push(`  ${nodeId(edge.from)} -->|${edge.kind}| ${nodeId(edge.to)}`);
  return `${lines.join("\n")}\n`;
}

function planGraphContext(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(
    rest,
    ["--backlog", "--checkpoint", "--milestone", "--roadmap", "--related", "--to", "--depth"],
    ["--resume", "--all-checkpoints", "--read-first"],
  );
  if (args.positionals.length) throw new UsageError(`unexpected context argument: ${args.positionals[0]}`);
  if (args.booleans.has("--resume")) {
    const packet = boundedPlanGraphResumeFor(options);
    if (args.booleans.has("--all-checkpoints")) {
      const model = planGraphFor(options);
      return { ...packet, all_checkpoints: [...model.checkpoints.values()].sort((left, right) => left.id.localeCompare(right.id)) };
    }
    if (args.booleans.has("--read-first")) {
      return {
        schema_version: 1,
        control_schema_version: 3,
        storage: "plan_graph_markdown",
        control_revision: packet.control_revision,
        read_first: packet.read_first,
      };
    }
    return packet;
  }
  const model = planGraphFor(options);
  if (args.values.has("--related")) {
    if (requiredArg(args, "--related") !== "note") throw new UsageError("context --related currently supports note");
    const target = requiredArg(args, "--to");
    const records = model.notes.filter((note) => note.related.includes(target));
    const sections = (model.notebook?.sections ?? []).filter((section) => section.related.includes(target));
    return {
      schema_version: 1,
      control_schema_version: 3,
      storage: "plan_graph_markdown",
      control_revision: model.revision,
      target,
      records,
      notebook_sections: sections,
    };
  }
  const selectors = ["--backlog", "--checkpoint", "--milestone", "--roadmap"].filter((flag) => args.values.has(flag));
  if (selectors.length !== 1) throw new UsageError("context requires --resume or exactly one entity selector");
  const flag = selectors[0]!;
  const id = requiredArg(args, flag);
  const kind = flag.slice(2);
  const root = `${kind}:${id}`;
  const entity = planGraphEntity(model, root);
  if (!entity) throw new Error(`${kind} does not exist: ${id}`);
  const neighborhood = buildPlanGraphContextNeighborhood(
    model,
    root,
    args.values.has("--depth") ? integerArg(requiredArg(args, "--depth"), "--depth", 0) : 1,
  );
  return {
    schema_version: 1,
    control_schema_version: 3,
    storage: "plan_graph_markdown",
    control_revision: model.revision,
    entity,
    depth: neighborhood.depth,
    nodes: neighborhood.nodes,
    links: neighborhood.links,
  };
}

function planGraphRead(command: string, rest: string[], options: CommonOptions): CliResult {
  let result: unknown;
  let text: string | undefined;
  let code = 0;
  let warning = "";
  if (command === "cockpit") {
    const args = parseCommandArgs(rest, ["--top-n"]);
    const topN = optionalArg(args, "--top-n");
    const parsedTopN = topN === undefined ? undefined : integerArg(topN, "--top-n");
    if (parsedTopN !== undefined && parsedTopN > MAX_COCKPIT_TOP_N) {
      throw new UsageError(`--top-n must be <= ${MAX_COCKPIT_TOP_N}`);
    }
    const cockpit = buildControlCockpit(planGraphFor(options, true), options.pmId, parsedTopN);
    result = cockpit;
    text = renderControlCockpit(cockpit);
    code = cockpit.valid ? 0 : 1;
  } else if (command === "context") {
    result = planGraphContext(rest, options);
  } else if (command === "resume") {
    if (rest.length) throw new UsageError(`unknown resume argument: ${rest[0]}`);
    result = boundedPlanGraphResumeFor(options);
  } else if (command === "get") {
    const id = rest.shift();
    if (!id || id.startsWith("--")) throw new UsageError("get requires an entity ID");
    if (rest.some((arg) => arg !== "--with-links")) throw new UsageError(`unknown get argument: ${rest.find((arg) => arg !== "--with-links")}`);
    const model = planGraphFor(options);
    const entity = planGraphEntity(model, id);
    if (!entity) return { code: 1, stdout: "", stderr: `control get: entity not found: ${id}\n` };
    const typedId = planGraphEntityTypedRef(entity);
    result = {
      schema_version: 1,
      control_schema_version: 3,
      storage: "plan_graph_markdown",
      control_revision: model.revision,
      entity,
      ...(rest.includes("--with-links")
        ? { links: [...model.graph.edges, ...model.graph.historicalEdges.filter((edge) => edge.state === "retired")].filter((edge) => edge.from === typedId || edge.to === typedId) }
        : {}),
    };
  } else if (command === "list") {
    const requested = rest.shift();
    if (requested !== "backlog" && requested !== "work" && requested !== "risk") {
      throw new UsageError("schema-3 list requires backlog or risk");
    }
    const model = planGraphFor(options);
    if (requested === "risk") {
      const args = parseCommandArgs(rest, ["--state", "--severity", "--milestone"], ["--include-closed"]);
      if (args.positionals.length) throw new UsageError(`unexpected risk list argument: ${args.positionals[0]}`);
      const states = enumList(
        args.values.get("--state")?.flatMap((value) => commaList(value, "--state")),
        ["open", "mitigating", "accepted", "closed", "superseded"] as const,
        "--state",
      );
      const severities = enumList(
        args.values.get("--severity")?.flatMap((value) => commaList(value, "--severity")),
        RISK_LEVELS,
        "--severity",
      );
      const milestones = args.values.get("--milestone")?.flatMap((value) => commaList(value, "--milestone"));
      const includeClosed = args.booleans.has("--include-closed");
      const records = [...model.risks.values()]
        .filter((record) => includeClosed || !record.path.startsWith("risks/archive/"))
        .filter((record) => !states || states.includes(record.status))
        .filter((record) => !severities || severities.includes(record.severity))
        .filter((record) => !milestones || milestones.some((milestone) => record.related.includes(`milestone:${milestone}`)))
        .sort((left, right) => left.id.localeCompare(right.id));
      result = { schema_version: 1, control_schema_version: 3, storage: "plan_graph_markdown", control_revision: model.revision, kind: "risk", records };
    } else {
      if (requested === "work") warning = WORK_ALIAS_WARNING;
      const args = parseCommandArgs(rest, ["--state", "--milestone", "--label", "--priority"], ["--include-closed"]);
      if (args.positionals.length) throw new UsageError(`unexpected backlog list argument: ${args.positionals[0]}`);
      const states = args.values.get("--state")?.flatMap((value) => commaList(value, "--state"));
      const milestones = args.values.get("--milestone")?.flatMap((value) => commaList(value, "--milestone"));
      const labels = args.values.get("--label")?.flatMap((value) => commaList(value, "--label"));
      const priorities = args.values.get("--priority")?.flatMap((value) => commaList(value, "--priority"));
      const includeClosed = args.booleans.has("--include-closed");
      const records = [...model.backlog.values()]
        .filter((record) => includeClosed || !record.path.startsWith("backlog/archive/"))
        .filter((record) => !states || states.includes(record.status))
        .filter((record) => !milestones || record.milestoneMemberships.some((link) => link.state === "active" && milestones.includes(link.target)))
        .filter((record) => !labels || labels.some((label) => Array.isArray(record.frontmatter.labels) && record.frontmatter.labels.includes(label)))
        .filter((record) => !priorities || priorities.includes(String(record.frontmatter.priority ?? "")))
        .sort((left, right) => left.id.localeCompare(right.id));
      result = { schema_version: 1, control_schema_version: 3, storage: "plan_graph_markdown", control_revision: model.revision, kind: "backlog", records };
    }
  } else if (command === "doctor") {
    const args = parseCommandArgs(rest, ["--profile"]);
    if (args.positionals.length) throw new UsageError(`unexpected doctor argument: ${args.positionals[0]}`);
    const profile = optionalArg(args, "--profile") ?? "strict";
    if (profile !== "fast" && profile !== "strict") throw new UsageError(`--profile must be fast or strict (got ${profile})`);
    const model = planGraphFor(options, true);
    const findings = [...model.findings, ...residualControlStagingFindings(rootsFor(options).controlRoot)]
      .sort((left, right) => `${left.severity}\0${left.code}\0${left.path ?? ""}`.localeCompare(`${right.severity}\0${right.code}\0${right.path ?? ""}`));
    const summary = {
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      info: findings.filter((finding) => finding.severity === "info").length,
    };
    result = { schema_version: 1, control_schema_version: 3, storage: "plan_graph_markdown", control_revision: model.revision, profile, findings, summary };
    text = `control doctor: ${summary.errors} error(s), ${summary.warnings} warning(s)`;
    code = summary.errors ? 1 : 0;
  } else if (command === "graph") {
    if (rest.length) throw new UsageError(`unknown graph argument: ${rest[0]}`);
    const model = planGraphFor(options);
    result = { schema_version: 1, control_schema_version: 3, storage: "plan_graph_markdown", control_revision: model.revision, graph: model.graph };
    text = options.format === "mermaid" ? planGraphMermaid(model) : `control graph: ${model.graph.nodes.length} node(s), ${model.graph.edges.length} edge(s)`;
  } else throw new Error(`unsupported schema-3 read command: ${command}`);
  return { code, stdout: emit(result, options, text), stderr: warning };
}

// W-215: --id is resolved through the shared cross-worktree counter
// (plan_graph_shared_ids.ts) instead of a pure local-model max — see that
// file's header comment for why. An explicit --id still passes straight
// through, but it also raises the shared counter's floor (count: 0 call) so
// a LATER auto-id create can never reissue the number it used.
function resolveAutoBacklogId(explicitId: string | undefined, model: PlanGraphControlModel, options: CommonOptions): string {
  const roots = rootsFor(options);
  const reserved = reserveBacklogIds({
    model,
    targetRoot: roots.targetRoot,
    pmId: options.pmId,
    count: explicitId ? 0 : 1,
    observedIds: explicitId ? [explicitId] : [],
  });
  return explicitId ?? reserved[0]!;
}

function handleV3Backlog(action: string, rest: string[], options: CommonOptions): unknown {
  if (action === "create-batch") return handleV3BacklogCreateBatch(rest, options);
  if (action === "triage-batch") return handleV3BacklogTriageBatch(rest, options);
  if (action === "reopen") return handleV3BacklogReopen(rest, options, "backlog-reopen");
  if (action === "create") {
    const args = parseCommandArgs(rest, [
      ...V3_TRANSACTION_FLAGS, "--id", "--title", "--type", "--priority", "--outcome", "--acceptance", "--next-action", "--labels",
      "--depends-on", "--related", "--milestone",
    ], [...V3_TRANSACTION_BOOLEANS, "--no-inherit-milestones"]);
    if (args.positionals.length) throw new UsageError(`unexpected backlog create argument: ${args.positionals[0]}`);
    const milestone = optionalArg(args, "--milestone");
    if (milestone !== undefined && milestone !== "none") throw new UsageError('--milestone only accepts "none"; actual memberships use relation link');
    // W-667 F-6 (W-620 追記 L-4, same class): these five were `requiredArg` calls
    // INSIDE the transaction callback, so each omission cost one round trip and
    // the parser opened and validated the Control session before saying which
    // flag was missing. A PM creating one row paid three of them. Collect them
    // here, before any session work.
    const [createTitle, createType, createPriority, createOutcome, createNextAction] = requireAllArgs(
      args,
      ["--title", "--type", "--priority", "--outcome", "--next-action"],
    ) as [string, string, string, string, string];
    return planGraphTransaction("backlog-create", args, options, (model, now) => planBacklogCreate({
      model,
      id: resolveAutoBacklogId(optionalArg(args, "--id"), model, options),
      title: createTitle,
      type: createType,
      priority: createPriority,
      outcome: createOutcome,
      acceptance: args.values.get("--acceptance") ?? [],
      exactNextAction: createNextAction,
      labels: args.values.get("--labels")?.flatMap((value) => commaList(value, "--labels")) ?? [],
      dependsOn: args.values.get("--depends-on")?.flatMap((value) => commaList(value, "--depends-on")),
      related: args.values.get("--related")?.flatMap((value) => commaList(value, "--related")),
      inheritMilestones: !args.booleans.has("--no-inherit-milestones"),
      milestone: milestone as "none" | undefined,
      now,
    }));
  }
  if (action !== "update") throw new UsageError(`backlog requires create, create-batch, triage-batch, reopen, or update (got ${action})`);
  const args = parseCommandArgs(rest, [
    ...V3_TRANSACTION_FLAGS, "--title", "--outcome", "--current-position", "--next-action", "--evidence",
    "--labels", "--depends-on", "--blocked-by", "--related", "--set-acceptance", "--check-acceptance",
  ], V3_TRANSACTION_BOOLEANS);
  const id = positional(args, 0, "Backlog ID");
  const acceptance = args.values.get("--set-acceptance");
  const checkedAcceptance = args.values.get("--check-acceptance");
  if (acceptance && checkedAcceptance) {
    throw new UsageError("--set-acceptance and --check-acceptance cannot be combined");
  }
  const list = (flag: string): string[] | undefined => args.values.has(flag)
    ? args.values.get(flag)!.flatMap((value) => commaListOrEmpty(value, flag))
    : undefined;
  return planGraphTransaction("backlog-update", args, options, (model, now) => planBacklogUpdate({
    record: planGraphRecord(model, "backlog", id) as ReturnType<PlanGraphControlModel["backlog"]["get"]> & {},
    now,
    title: optionalArg(args, "--title"),
    outcome: optionalArg(args, "--outcome"),
    currentPosition: optionalArg(args, "--current-position"),
    exactNextAction: optionalArg(args, "--next-action"),
    evidence: optionalArg(args, "--evidence"),
    labels: list("--labels"),
    dependsOn: list("--depends-on"),
    blockedBy: list("--blocked-by"),
    related: list("--related"),
    acceptance,
    checkedAcceptance,
  }));
}

function handleV3BacklogReopen(rest: string[], options: CommonOptions, command = "backlog-reopen"): unknown {
  const args = parseCommandArgs(rest, [...V3_TRANSACTION_FLAGS, "--to", "--reason", "--evidence"], V3_TRANSACTION_BOOLEANS);
  const id = positional(args, 0, "Backlog ID");
  const evidence = args.values.get("--evidence");
  if (!evidence?.length) throw new UsageError("backlog-reopen requires --evidence");
  for (const shorthand of evidence) {
    if (/[\r\n]/.test(shorthand)) throw new UsageError("--evidence must not contain newlines (CR/LF)");
  }
  const to = optionalArg(args, "--to") ?? "ready";
  if (!(["triage", "ready", "blocked", "deferred"] as const).includes(to as "triage" | "ready" | "blocked" | "deferred")) {
    throw new UsageError("backlog-reopen --to must be triage, ready, blocked, or deferred");
  }
  const reason = requiredArg(args, "--reason");
  return planGraphTransaction(command, args, options, (model, now, agent) => {
    const record = planGraphRecord(model, "backlog", id) as ReturnType<PlanGraphControlModel["backlog"]["get"]> & {};
    const parsedEvidence = evidence.map((shorthand) => parseEvidence(shorthand, now, agent, model));
    const evidenceLines = evidence.map((shorthand) => `- ${shorthand} (session ${requiredArg(args, "--session")}, observed ${now})`);
    const update = planBacklogUpdate({
      record,
      now,
      evidence: appendEvidenceLines(record.evidence, evidenceLines),
      evidenceRefs: [...planGraphEvidenceReferences(record), ...parsedEvidence],
    });
    const updated = parseBacklogRecord(update.writes[0]!.source!, record.path);
    const filename = record.path.split("/").at(-1)!;
    return planLifecycleV3BacklogReopen({
      sourcePath: record.path,
      openPath: `backlog/open/${filename}`,
      record: updated,
      to: to as "triage" | "ready" | "blocked" | "deferred",
      reason,
      evidenceCount: planGraphRecordAdapter.inspect(updated).evidenceCount,
      now,
      adapter: planGraphRecordAdapter,
    });
  });
}

const MAX_CONTROL_BATCH_ROWS = 200;
const MAX_CONTROL_BATCH_FILE_BYTES = 1_000_000;

interface BacklogBatchFileRow {
  id?: string;
  title: string;
  type?: string;
  priority?: string;
  outcome?: string;
  acceptance?: string[];
  next_action?: string;
  labels?: string[];
  depends_on?: string[];
  related?: string[];
  inherit_milestones?: boolean;
  milestone?: "none";
}

const BACKLOG_BATCH_ALLOWED_KEYS = new Set<keyof BacklogBatchFileRow>([
  "id", "title", "type", "priority", "outcome", "acceptance", "next_action",
  "labels", "depends_on", "related", "inherit_milestones", "milestone",
]);

function boundedBatchKey(key: string): string {
  const codePoints = Array.from(key);
  const bounded = codePoints.length <= 128 ? key : `${codePoints.slice(0, 128).join("")}…`;
  return JSON.stringify(bounded);
}

function batchStringField(row: Record<string, unknown>, key: string, index: number): string | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new UsageError(`batch row ${index} field ${key} must be a string`);
  return value;
}

function batchStringArrayField(row: Record<string, unknown>, key: string, index: number): string[] | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new UsageError(`batch row ${index} field ${key} must be an array of strings`);
  return value as string[];
}

function batchBooleanField(row: Record<string, unknown>, key: string, index: number): boolean | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new UsageError(`batch row ${index} field ${key} must be a boolean`);
  return value;
}

function parseBacklogBatchRow(raw: unknown, index: number): BacklogBatchFileRow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError(`batch row ${index} must be a table`);
  const row = raw as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!BACKLOG_BATCH_ALLOWED_KEYS.has(key as keyof BacklogBatchFileRow)) {
      throw new UsageError(`batch row ${index} has unknown key: ${boundedBatchKey(key)}`);
    }
  }
  const title = batchStringField(row, "title", index);
  if (!title?.trim()) throw new UsageError(`batch row ${index} requires a non-empty title`);
  const id = batchStringField(row, "id", index);
  if (id !== undefined && !/^W-\d{3,}$/.test(id)) throw new UsageError(`batch row ${index} has an invalid id: ${id}`);
  const milestone = batchStringField(row, "milestone", index);
  if (milestone !== undefined && milestone !== "none") throw new UsageError(`batch row ${index} field milestone only accepts "none"`);
  return {
    id,
    title,
    type: batchStringField(row, "type", index),
    priority: batchStringField(row, "priority", index),
    outcome: batchStringField(row, "outcome", index),
    acceptance: batchStringArrayField(row, "acceptance", index),
    next_action: batchStringField(row, "next_action", index),
    labels: batchStringArrayField(row, "labels", index),
    depends_on: batchStringArrayField(row, "depends_on", index),
    related: batchStringArrayField(row, "related", index),
    inherit_milestones: batchBooleanField(row, "inherit_milestones", index),
    milestone: milestone as "none" | undefined,
  };
}

// W-223: reads a `[[row]] ...` TOML array (smol-toml, the same parser already
// used for control frontmatter) so a PM can stage N backlog rows in one file
// instead of N separate `control create backlog` invocations — the operation
// that, run as N separate 2-minute-timeout-bounded CLI calls, let a SIGKILL
// land mid-transaction on one of the six and desync generation parity
// (real incident that produced W-222).
function loadBatchRowTables(rawPath: string): unknown[] {
  const path = resolve(rawPath);
  if (!existsSync(path)) throw new UsageError(`batch file does not exist: ${rawPath}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new UsageError(`batch file must be a regular file: ${rawPath}`);
  if (info.size > MAX_CONTROL_BATCH_FILE_BYTES) throw new UsageError(`batch file exceeds ${MAX_CONTROL_BATCH_FILE_BYTES} bytes: ${rawPath}`);
  const source = readFileSync(path, "utf8");
  let parsed: unknown;
  try { parsed = parseToml(source); }
  catch (error) { throw new UsageError(`batch file is not valid TOML: ${(error as Error).message}`); }
  const rows = (parsed as { row?: unknown }).row;
  if (!Array.isArray(rows) || !rows.length) throw new UsageError("batch file must define at least one [[row]] table");
  if (rows.length > MAX_CONTROL_BATCH_ROWS) throw new UsageError(`batch file exceeds ${MAX_CONTROL_BATCH_ROWS} rows`);
  return rows;
}

function loadBacklogBatchFile(rawPath: string): BacklogBatchFileRow[] {
  return loadBatchRowTables(rawPath).map((raw, index) => parseBacklogBatchRow(raw, index + 1));
}

// The whole batch commits through ONE planGraphTransaction call — one
// namespace lock acquisition, one recovery journal, one atomic replace
// (transaction.ts's applyPlan/replaceAtomically already iterate an arbitrary
// `writes[]` array; nothing about that machinery is single-write-only, a
// batch just gives it a longer plan). A SIGKILL anywhere in this call either
// lands before the atomic replace (nothing touched the canonical control
// tree; W-222's existing recovery journal replays or discards the whole
// staged plan) or after it (all N rows are committed) — never a partial
// subset of the batch.
function handleV3BacklogCreateBatch(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, [...V3_TRANSACTION_FLAGS, "--file"], V3_TRANSACTION_BOOLEANS);
  if (args.positionals.length) throw new UsageError(`unexpected backlog create-batch argument: ${args.positionals[0]}`);
  const rows = loadBacklogBatchFile(requiredArg(args, "--file"));
  const explicitIds = rows.flatMap((row) => row.id ? [row.id] : []);
  const duplicate = explicitIds.find((id, index) => explicitIds.indexOf(id) !== index);
  if (duplicate) throw new UsageError(`duplicate id in batch file: ${duplicate}`);
  const roots = rootsFor(options);
  return planGraphTransaction("backlog-create-batch", args, options, (model, now) => {
    const autoCount = rows.filter((row) => !row.id).length;
    const reserved = reserveBacklogIds({
      model, targetRoot: roots.targetRoot, pmId: options.pmId, count: autoCount, observedIds: explicitIds,
    });
    let cursor = 0;
    return planBacklogBatchCreate({
      model,
      now,
      rows: rows.map((row) => ({
        id: row.id ?? reserved[cursor++]!,
        title: row.title,
        type: row.type,
        priority: row.priority,
        outcome: row.outcome,
        acceptance: row.acceptance,
        exactNextAction: row.next_action,
        labels: row.labels,
        dependsOn: row.depends_on,
        related: row.related,
        inheritMilestones: row.inherit_milestones,
        milestone: row.milestone,
      })),
    });
  });
}

function handleV3BacklogTriageBatch(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(
    rest,
    ["--file", "--expect-plan-digest", "--expect-control-revision"],
    ["--plan", "--apply"],
  );
  if (args.positionals.length) throw new UsageError(`unexpected backlog triage-batch argument: ${args.positionals[0]}`);
  const planning = args.booleans.has("--plan");
  const applying = args.booleans.has("--apply");
  if (planning === applying) throw new UsageError("backlog triage-batch requires exactly one of --plan or --apply");
  requireV3(options);
  const resolved = rootsFor(options);
  const roots = {
    targetRoot: resolved.targetRoot,
    pmId: options.pmId,
    controlRoot: resolved.controlRoot,
    runtimeRoot: resolved.runtimeRoot,
  };
  const file = requiredArg(args, "--file");
  if (planning) {
    if (args.values.has("--expect-plan-digest") || args.values.has("--expect-control-revision")) {
      throw new UsageError("backlog triage-batch --plan does not accept apply preconditions");
    }
    return planBacklogTriageBatch(roots, file);
  }
  return applyBacklogTriageBatch(
    roots,
    file,
    requiredArg(args, "--expect-plan-digest"),
    requiredArg(args, "--expect-control-revision"),
  );
}

// evidence-add is the only entity-agnostic Backlog/Risk mutation (v2's handleEvidenceAdd
// looks up model.work.get(id) ?? model.risks.get(id) the same way) — v3 has no separate
// `## Evidence` section grammar per kind, so one handler covers both. Appends (never
// replaces) typed-ref lines onto the entity's existing `## Evidence` section so the
// terminal-transition evidenceCount() gate (plan_graph_write.ts) can be satisfied through
// this command instead of a direct record edit.
function handleV3EvidenceAdd(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, [...V3_TRANSACTION_FLAGS, "--evidence"], V3_TRANSACTION_BOOLEANS);
  const id = positional(args, 0, "entity ID");
  const shorthands = args.values.get("--evidence");
  if (!shorthands?.length) throw new UsageError("--evidence is required");
  // Guardian N2: `path:`/`report:` shorthands accept an unrestricted `parts.join(":")` in
  // parseEvidence (below), so an embedded CR/LF would otherwise land verbatim in the
  // constructed `- ${shorthand} (...)` line and let a single evidence line inject new
  // Markdown structure (e.g. a `## Heading`) into the canonical record body once written.
  // Deny outright (fail-closed) rather than silently stripping — a shorthand that needs a
  // newline to make its point is not a valid single-line typed-ref anyway.
  for (const shorthand of shorthands) {
    if (/[\r\n]/.test(shorthand)) throw new UsageError("--evidence must not contain newlines (CR/LF)");
  }
  const sessionId = requiredArg(args, "--session");
  return planGraphTransaction("evidence-add", args, options, (model, now, agent) => {
    const record = model.backlog.get(id) ?? model.risks.get(id);
    if (!record) throw new Error(`Backlog or Risk does not exist: ${id}`);
    // Parse the entire ordered batch before planning either representation. An invalid
    // later value therefore produces no body/frontmatter write. Exact duplicates remain
    // ordered append events in both representations instead of being silently collapsed.
    const parsed = shorthands.map((shorthand) => parseEvidence(shorthand, now, agent, model));
    const lines = shorthands.map((shorthand) => `- ${shorthand} (session ${sessionId}, observed ${now})`);
    const evidence = appendEvidenceLines(record.evidence, lines);
    return record.kind === "backlog"
      ? planBacklogUpdate({
        record,
        now,
        evidence,
        evidenceRefs: [...planGraphEvidenceReferences(record), ...parsed],
      })
      : planRiskUpdate({ record, now, evidence });
  });
}

function handleV3Create(rest: string[], options: CommonOptions): unknown {
  const kind = rest.shift();
  if (!kind || !["roadmap", "milestone", "backlog", "checkpoint", "note"].includes(kind)) {
    throw new UsageError("create requires roadmap, milestone, backlog, checkpoint, or note");
  }
  const args = parseCommandArgs(rest, [
    ...V3_TRANSACTION_FLAGS, "--slug", "--id", "--title", "--type", "--priority", "--outcome",
    "--acceptance", "--next-action", "--labels", "--resume-verification", "--related", "--depends-on", "--milestone",
  ], [...V3_TRANSACTION_BOOLEANS, "--no-inherit-milestones"]);
  if (args.positionals.length) throw new UsageError(`unexpected create argument: ${args.positionals[0]}`);
  const title = requiredArg(args, "--title");
  if (kind === "roadmap" || kind === "milestone") {
    const slug = requiredArg(args, "--slug");
    return planGraphTransaction(`${kind}-create`, args, options, (model, now) =>
      kind === "roadmap"
        ? planRoadmapCreate({ model, slug, title, now })
        : planMilestoneCreate({ model, slug, title, now }));
  }
  const rawId = optionalArg(args, "--id");
  const id = rawId === "auto" ? undefined : rawId;
  if (kind === "backlog") {
    const milestone = optionalArg(args, "--milestone");
    if (milestone !== undefined && milestone !== "none") throw new UsageError('--milestone only accepts "none"; actual memberships use relation link');
    return planGraphTransaction("backlog-create", args, options, (model, now) => planBacklogCreate({
      model,
      id: resolveAutoBacklogId(id, model, options),
      title,
      type: optionalArg(args, "--type") ?? "task",
      priority: optionalArg(args, "--priority") ?? "normal",
      outcome: optionalArg(args, "--outcome") ?? title,
      acceptance: args.values.get("--acceptance") ?? ["Define acceptance."],
      exactNextAction: optionalArg(args, "--next-action") ?? "Triage this Backlog.",
      labels: args.values.get("--labels")?.flatMap((value) => commaList(value, "--labels")) ?? [],
      dependsOn: args.values.get("--depends-on")?.flatMap((value) => commaList(value, "--depends-on")),
      related: args.values.get("--related")?.flatMap((value) => commaList(value, "--related")),
      inheritMilestones: !args.booleans.has("--no-inherit-milestones"),
      milestone: milestone as "none" | undefined,
      now,
    }));
  }
  if (kind === "note") {
    return planGraphTransaction("note-create", args, options, (model, now) => planNoteCreate({
      model,
      id,
      title,
      related: args.values.get("--related")?.flatMap((value) => commaList(value, "--related")),
      now,
    }));
  }
  return planGraphTransaction("checkpoint-create", args, options, (model, now, agent) => planCheckpointSave({
    model,
    id,
    title,
    exactNextAction: optionalArg(args, "--next-action") ?? "Define the exact next action.",
    resumeVerification: optionalArg(args, "--resume-verification") ?? "Review this Checkpoint before continuing.",
    related: args.values.get("--related")?.flatMap((value) => commaList(value, "--related")),
    agent,
    now,
  }));
}

function handleV3Milestone(action: string, rest: string[], options: CommonOptions): unknown {
  if (action !== "update") throw new UsageError(`milestone requires update (got ${action})`);
  const mutationFlags = ["--set-depends-on", "--add-dependency", "--remove-dependency"] as const;
  const args = parseCommandArgs(rest, [...V3_TRANSACTION_FLAGS, ...mutationFlags], V3_TRANSACTION_BOOLEANS);
  if (args.positionals.length > 1) throw new UsageError(`unexpected milestone update argument: ${args.positionals[1]}`);
  const slug = args.positionals[0];
  if (!mutationFlags.some((flag) => args.values.has(flag))) {
    throw new UsageError("milestone update requires at least one dependency update flag");
  }
  const removeOnly = args.values.has("--remove-dependency")
    && !args.values.has("--set-depends-on")
    && !args.values.has("--add-dependency");
  if (!removeOnly && !slug) throw new UsageError("milestone update requires a Milestone slug");

  if (removeOnly) {
    const removals = (args.values.get("--remove-dependency") ?? []).flatMap((value) =>
      commaList(value, "--remove-dependency").map((item) => {
        const split = item.indexOf("=");
        if (split < 0) {
          if (!slug) throw new UsageError("a removal without a positional Milestone requires owner=target");
          return { owner: slug, target: item };
        }
        if (split === 0 || split === item.length - 1 || item.indexOf("=", split + 1) >= 0) {
          throw new UsageError("cross-Milestone removal must be owner=target");
        }
        return { owner: item.slice(0, split), target: item.slice(split + 1) };
      }));
    return planGraphTransaction("milestone-dependency-repair", args, options, (model, now) => {
      const grouped = new Map<string, string[]>();
      for (const removal of removals) grouped.set(removal.owner, [...(grouped.get(removal.owner) ?? []), removal.target]);
      const writes: PlannedControlWrite[] = [];
      for (const [owner, targets] of grouped) {
        const record = model.milestones.get(owner);
        if (!record) throw new Error(`Milestone does not exist: ${owner}`);
        let entries = milestoneDependencyEntries(model.milestones, record);
        for (const target of targets) {
          const resolvedSelector = resolveMilestoneDependencySelector(model.milestones, target);
          let removed = false;
          entries = entries.filter((entry) => {
            const matches = entry.kind !== "backlog"
              && (entry.raw === target || (resolvedSelector !== null && entry.target === resolvedSelector));
            if (matches) removed = true;
            return !matches;
          });
          if (!removed) throw new Error(`Milestone dependency does not exist: ${owner} -> ${target}`);
        }
        const dependsOn = entries.flatMap((entry) => {
          if (entry.source === "depends_on") return [entry.target ?? entry.raw];
          return entry.kind === "milestone" && entry.target ? [entry.target] : [];
        });
        const legacyDependencyTargets = entries.flatMap((entry) =>
          entry.source === "dependency_targets" && entry.kind !== "milestone" ? [entry.raw] : []);
        writes.push(...planMilestoneDependencyUpdate({ record, dependsOn, legacyDependencyTargets, now }).writes);
      }
      return {
        writes,
        entity: slug ?? grouped.keys().next().value ?? null,
        summary: `remove ${removals.length} Milestone dependency edge(s)`,
      };
    }, planGraphDependencyRepairTransactionCallbacks);
  }

  return planGraphTransaction("milestone-update", args, options, (model, now) => {
    const record = model.milestones.get(slug!);
    if (!record) throw new Error(`Milestone does not exist: ${slug}`);
    const dependsOn = updateStringList(resolvedMilestoneDependencies(model.milestones, record), args, {
      set: "--set-depends-on",
      add: "--add-dependency",
      remove: "--remove-dependency",
    });
    const legacyDependencyTargets = milestoneDependencyEntries(model.milestones, record)
      .filter((entry) => entry.source === "dependency_targets" && entry.kind !== "milestone")
      .map((entry) => entry.raw);
    return planMilestoneDependencyUpdate({ record, dependsOn, legacyDependencyTargets, now });
  });
}

function riskLevel(args: ParsedCommandArgs, flag: string, required = false): "critical" | "high" | "medium" | "low" | undefined {
  const value = required ? requiredArg(args, flag) : optionalArg(args, flag);
  if (value === undefined) return undefined;
  if (!RISK_LEVELS.includes(value as never)) throw new UsageError(`invalid risk ${flag.slice(2)}: ${value}`);
  return value as "critical" | "high" | "medium" | "low";
}

function riskList(args: ParsedCommandArgs, flag: string): string[] | undefined {
  return args.values.has(flag) ? args.values.get(flag)!.flatMap((value) => commaListOrEmpty(value, flag)) : undefined;
}

function riskLegacyRelated(current: string[], args: ParsedCommandArgs): string[] | undefined {
  const direct = riskList(args, "--related");
  if (direct !== undefined) return direct;
  if (!args.values.has("--milestone")) return undefined;
  const milestone = requiredArg(args, "--milestone");
  const withoutMilestone = current.filter((reference) => !reference.startsWith("milestone:"));
  return milestone === "none" ? withoutMilestone : [...withoutMilestone, `milestone:${milestone}`];
}

function riskLegacyBacklog(args: ParsedCommandArgs): string[] | undefined {
  return riskList(args, "--mitigation-backlog")
    ?? (args.values.has("--mitigation-work") ? riskList(args, "--mitigation-work") : undefined);
}

function riskWithEvidence(record: ReturnType<PlanGraphControlModel["risks"]["get"]> & {}, evidence: string | undefined, now: string) {
  if (evidence === undefined) return record;
  const plan = planRiskUpdate({ record, now, evidence });
  return parseRiskRecord(plan.writes[0]!.source!, record.path);
}

function handleV3RiskTransition(rest: string[], options: CommonOptions, command = "risk-transition"): unknown {
  const args = parseCommandArgs(rest, [
    ...V3_TRANSACTION_FLAGS, "--to", "--reason", "--evidence",
  ], V3_TRANSACTION_BOOLEANS);
  const id = positional(args, 0, "Risk ID");
  const to = requiredArg(args, "--to");
  if (!["open", "mitigating", "accepted", "closed", "superseded"].includes(to)) throw new UsageError(`invalid Risk state: ${to}`);
  if (["closed", "superseded"].includes(to) && !args.values.has("--evidence")) {
    throw new UsageError(`risk ${to} requires --evidence`);
  }
  return planGraphTransaction(command, args, options, (model, now) => {
    const record = planGraphRecord(model, "risk", id) as ReturnType<PlanGraphControlModel["risks"]["get"]> & {};
    const updated = riskWithEvidence(record, optionalArg(args, "--evidence"), now);
    if (["closed", "superseded"].includes(to)) {
      const filename = record.path.split("/").at(-1)!;
      return planLifecycleV3TerminalArchive({
        sourcePath: record.path,
        archivePath: `risks/archive/${now.slice(0, 4)}/${filename}`,
        record: updated,
        to,
        evidenceCount: planGraphRiskAdapter.inspect(updated).evidenceCount,
        reason: requiredArg(args, "--reason"),
        now,
        adapter: planGraphRiskAdapter,
      });
    }
    return planLifecycleV3Transition({
      path: record.path,
      record: updated,
      to,
      reason: optionalArg(args, "--reason"),
      now,
      adapter: planGraphRiskAdapter,
    });
  });
}

function handleV3RiskReopen(rest: string[], options: CommonOptions, command = "risk-reopen"): unknown {
  const args = parseCommandArgs(rest, [...V3_TRANSACTION_FLAGS, "--reason", "--evidence"], V3_TRANSACTION_BOOLEANS);
  const id = positional(args, 0, "Risk ID");
  const evidence = requiredArg(args, "--evidence");
  return planGraphTransaction(command, args, options, (model, now) => {
    const record = planGraphRecord(model, "risk", id) as ReturnType<PlanGraphControlModel["risks"]["get"]> & {};
    const updated = riskWithEvidence(record, evidence, now);
    const filename = record.path.split("/").at(-1)!;
    return planLifecycleV3RiskReopen({
      sourcePath: record.path,
      openPath: `risks/open/${filename}`,
      record: updated,
      reason: requiredArg(args, "--reason"),
      evidenceCount: planGraphRiskAdapter.inspect(updated).evidenceCount,
      now,
      adapter: planGraphRiskAdapter,
    });
  });
}

function handleV3Risk(action: string, rest: string[], options: CommonOptions): unknown {
  if (action === "transition" || action === "archive") return handleV3RiskTransition(rest, options, `risk-${action}`);
  if (action === "reopen") return handleV3RiskReopen(rest, options, "risk-reopen");
  if (action === "create") {
    const args = parseCommandArgs(rest, [
      ...V3_TRANSACTION_FLAGS, "--id", "--title", "--severity", "--likelihood", "--risk", "--trigger", "--impact", "--mitigation",
      "--owner", "--review", "--related", "--mitigation-backlog", "--evidence",
      "--milestone", "--mitigation-work", "--review-at",
    ], V3_TRANSACTION_BOOLEANS);
    if (args.positionals.length) throw new UsageError(`unexpected risk create argument: ${args.positionals[0]}`);
    return planGraphTransaction("risk-create", args, options, (model, now) => planRiskCreate({
      model,
      id: optionalArg(args, "--id"),
      title: requiredArg(args, "--title"),
      severity: riskLevel(args, "--severity", true)!,
      likelihood: riskLevel(args, "--likelihood", true)!,
      risk: requiredArg(args, "--risk"),
      trigger: requiredArg(args, "--trigger"),
      impact: optionalArg(args, "--impact") ?? "-",
      mitigation: optionalArg(args, "--mitigation") ?? "-",
      owner: optionalArg(args, "--owner"),
      review: optionalArg(args, "--review") ?? optionalArg(args, "--review-at"),
      related: riskLegacyRelated([], args) ?? [],
      mitigationBacklog: riskLegacyBacklog(args) ?? [],
      evidence: optionalArg(args, "--evidence"),
      now,
    }));
  }
  if (action !== "update") throw new UsageError(`risk requires create, update, transition, archive, or reopen (got ${action})`);
  const flags = [
    "--title", "--severity", "--likelihood", "--risk", "--trigger", "--impact", "--mitigation",
    "--owner", "--review", "--related", "--mitigation-backlog", "--evidence",
    "--milestone", "--mitigation-work", "--review-at", "--accepted-rationale",
  ];
  const args = parseCommandArgs(rest, [...V3_TRANSACTION_FLAGS, ...flags], V3_TRANSACTION_BOOLEANS);
  const id = positional(args, 0, "Risk ID");
  if (!flags.some((flag) => args.values.has(flag))) throw new UsageError("risk update requires at least one update flag");
  return planGraphTransaction("risk-update", args, options, (model, now) => planRiskUpdate({
    record: planGraphRecord(model, "risk", id) as ReturnType<PlanGraphControlModel["risks"]["get"]> & {},
    now,
    title: optionalArg(args, "--title"),
    severity: riskLevel(args, "--severity"),
    likelihood: riskLevel(args, "--likelihood"),
    risk: optionalArg(args, "--risk"),
    trigger: optionalArg(args, "--trigger"),
    impact: optionalArg(args, "--impact"),
    mitigation: optionalArg(args, "--mitigation"),
    owner: optionalArg(args, "--owner"),
    review: optionalArg(args, "--review") ?? (args.values.has("--review-at")
      ? optionalArg(args, "--review-at") === "none" ? "-" : optionalArg(args, "--review-at")
      : undefined),
    acceptedRationale: args.values.has("--accepted-rationale")
      ? optionalArg(args, "--accepted-rationale") === "none" ? "-" : optionalArg(args, "--accepted-rationale")
      : undefined,
    related: riskLegacyRelated((planGraphRecord(model, "risk", id) as ReturnType<PlanGraphControlModel["risks"]["get"]> & {}).related, args),
    mitigationBacklog: riskLegacyBacklog(args),
    evidence: optionalArg(args, "--evidence"),
  }));
}

function handleV3Reopen(rest: string[], options: CommonOptions): unknown {
  const kind = rest.shift();
  if (kind !== "backlog") throw new UsageError("reopen requires backlog <W-NNN>");
  return handleV3BacklogReopen(rest, options, "backlog-reopen");
}

function handleV3Relation(action: string, rest: string[], options: CommonOptions): unknown {
  if (action === "link") {
    const args = parseCommandArgs(rest, [
      ...V3_TRANSACTION_FLAGS, "--to", "--relation", "--track", "--order", "--required",
    ], V3_TRANSACTION_BOOLEANS);
    const ownerRef = positional(args, 0, "relation owner");
    return planGraphTransaction("relation-link", args, options, (model, now) => planRelationLink({
      owner: relationOwner(model, ownerRef),
      target: requiredArg(args, "--to"),
      relation: optionalArg(args, "--relation"),
      track: optionalArg(args, "--track"),
      order: args.values.has("--order") ? integerArg(requiredArg(args, "--order"), "--order", 0) : undefined,
      required: args.values.has("--required") ? booleanValue(requiredArg(args, "--required"), "--required") : undefined,
      now,
    }));
  }
  if (action !== "retire") throw new UsageError(`relation requires link or retire (got ${action})`);
  const args = parseCommandArgs(rest, [...V3_TRANSACTION_FLAGS, "--relation-id", "--reason"], V3_TRANSACTION_BOOLEANS);
  if (args.positionals.length < 1 || args.positionals.length > 2) throw new UsageError("relation retire requires <owner> <rel-NNN>");
  const ownerRef = args.positionals[0]!;
  const relationId = optionalArg(args, "--relation-id") ?? args.positionals[1];
  if (!relationId) throw new UsageError("relation retire requires <rel-NNN> or --relation-id <rel-NNN>");
  if (args.positionals[1] && args.values.has("--relation-id")) throw new UsageError("relation ID may be positional or passed by flag, not both");
  return planGraphTransaction("relation-retire", args, options, (model, now) => {
    const owner = relationOwner(model, ownerRef);
    return planLifecycleV3RelationRetirement({
      ownerPath: owner.path,
      owner,
      relationId,
      reason: requiredArg(args, "--reason"),
      now,
      adapter: planGraphRelationAdapter,
    });
  });
}

function handleV3LinkAlias(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, [
    ...V3_TRANSACTION_FLAGS, "--relation", "--track", "--order", "--required",
  ], V3_TRANSACTION_BOOLEANS);
  if (args.positionals.length !== 4) {
    throw new UsageError("link requires roadmap <slug> milestone <slug>, milestone <parent> child <child>, backlog <W-NNN> milestone <slug>, or note <N-NNN> to <typed-ref>");
  }
  const [sourceKind, sourceId, connector, targetId] = args.positionals;
  if (sourceKind === "note" && connector === "to") {
    return planGraphTransaction("note-link", args, options, (model, now) => {
      const note = model.notes.find((candidate) => candidate.id === sourceId);
      if (!note) throw new Error(`note does not exist: ${sourceId}`);
      return planNoteLink({ note, target: targetId!, now });
    });
  }
  const target = sourceKind === "roadmap" && connector === "milestone" ? `milestone:${targetId}`
    : sourceKind === "milestone" && connector === "child" ? `milestone:${targetId}`
      : sourceKind === "backlog" && connector === "milestone" ? `milestone:${targetId}`
        : null;
  if (!target) throw new UsageError(`unsupported link endpoints: ${args.positionals.join(" ")}`);
  return planGraphTransaction("relation-link", args, options, (model, now) => planRelationLink({
    owner: relationOwner(model, `${sourceKind}:${sourceId}`),
    target,
    relation: optionalArg(args, "--relation"),
    track: optionalArg(args, "--track"),
    order: args.values.has("--order") ? integerArg(requiredArg(args, "--order"), "--order", 0) : undefined,
    required: args.values.has("--required") ? booleanValue(requiredArg(args, "--required"), "--required") : undefined,
    now,
  }));
}

function handleV3RetireAlias(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, [...V3_TRANSACTION_FLAGS, "--reason"], V3_TRANSACTION_BOOLEANS);
  if (args.positionals.length !== 3 || args.positionals[0] !== "relation") {
    throw new UsageError("retire requires relation <source-ref> <target-ref> --reason <text>");
  }
  const source = args.positionals[1]!;
  const target = args.positionals[2]!;
  return planGraphTransaction("relation-retire", args, options, (model, now) => {
    const owner = relationOwner(model, source);
    const targetId = target.split(":", 2)[1];
    if (!targetId) throw new UsageError(`invalid typed relation target: ${target}`);
    const relationId = owner.kind === "roadmap"
      ? owner.milestoneLinks.find((link) => link.state === "active" && target === `milestone:${link.target}`)?.relationId
      : owner.kind === "milestone"
        ? owner.childLinks.find((link) => link.state === "active" && target === `milestone:${link.target}`)?.relationId
        : [
            ...owner.milestoneMemberships.map((link) => ({ ...link, typed: `milestone:${link.target}` })),
            ...owner.viewMemberships.map((link) => ({ ...link, typed: `backlog-view:${link.target}` })),
          ].find((link) => link.state === "active" && link.typed === target)?.relationId;
    if (!relationId) throw new Error(`active relation does not exist: ${source} -> ${target}`);
    return planLifecycleV3RelationRetirement({
      ownerPath: owner.path,
      owner,
      relationId,
      reason: requiredArg(args, "--reason"),
      now,
      adapter: planGraphRelationAdapter,
    });
  });
}

const TRANSITION_KINDS = ["roadmap", "milestone", "backlog", "checkpoint", "decision", "blueprint"] as const;

type TransitionKind = (typeof TRANSITION_KINDS)[number];

interface TransitionRowSpec {
  kind: TransitionKind;
  id: string;
  to: string;
  reason?: string;
  replacement?: string;
  checkpoint?: string;
}

/** Shape checks that do not need the loaded model — shared by the single-row CLI form and every batch row. */
function assertTransitionRowShape(kind: string | undefined, id: string | undefined, hasCheckpoint: boolean): TransitionKind {
  if (!TRANSITION_KINDS.includes(kind as TransitionKind)) throw new UsageError(`unsupported transition kind: ${kind}`);
  if (kind === "decision" && !/^DEC-\d+$/.test(id!)) throw new UsageError(`invalid decision id: ${id}`);
  if (kind === "blueprint" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id!)) throw new UsageError(`invalid blueprint slug: ${id}`);
  if ((kind === "decision" || kind === "blueprint") && hasCheckpoint) {
    throw new UsageError(`transition ${kind} does not accept --checkpoint`);
  }
  return kind as TransitionKind;
}

// W-347: the single place that turns one transition intent into a file plan.
// `transition` and `transition-batch` both call it, so the edge table
// (STATE_MATRIX), evidence gate, reason/replacement requirements and the
// three-write Backlog activation plan apply per row by construction — a batch
// cannot drift into a weaker validation path because there is no second path.
function planTransitionRow(model: PlanGraphControlModel, now: string, spec: TransitionRowSpec): LifecycleV3FilePlan {
  const record = spec.kind === "decision" || spec.kind === "blueprint"
    ? planGraphArtifactRecord(model, spec.kind, spec.id)
    : planGraphRecord(model, spec.kind, spec.id);
  if (spec.kind === "backlog" && spec.to === "active") {
    if (!spec.checkpoint) throw new UsageError("--checkpoint is required");
    const checkpoint = planGraphRecord(model, "checkpoint", spec.checkpoint);
    if (checkpoint.kind !== "checkpoint" || !model.current) throw new Error("Backlog activation requires Checkpoint and Current");
    return planLifecycleV3Activation({
      backlogPath: record.path,
      backlog: record,
      checkpointPath: checkpoint.path,
      checkpoint,
      currentPath: model.current.path,
      current: model.current,
      now,
      recordAdapter: planGraphRecordAdapter,
      currentAdapter: planGraphCurrentAdapter,
    });
  }
  const currentIds = model.current ? planGraphCurrentAdapter.activeCheckpointIds(model.current) : [];
  return planLifecycleV3Transition({
    path: record.path,
    record,
    to: spec.to,
    reason: spec.reason,
    replacement: spec.replacement,
    hasActiveCheckpoint: spec.checkpoint ? model.checkpoints.get(spec.checkpoint)?.status === "active" : false,
    currentHasCheckpoint: spec.checkpoint ? currentIds.includes(spec.checkpoint) : false,
    now,
    adapter: planGraphRecordAdapter,
  });
}

function handleV3Transition(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, [
    ...V3_TRANSACTION_FLAGS, "--to", "--reason", "--replacement", "--checkpoint",
  ], V3_TRANSACTION_BOOLEANS);
  if (args.positionals.length !== 2) throw new UsageError("transition requires <roadmap|milestone|backlog|checkpoint|decision|blueprint> <id>");
  const [rawKind, id] = args.positionals;
  const kind = assertTransitionRowShape(rawKind, id, args.values.has("--checkpoint"));
  return planGraphTransaction("transition", args, options, (model, now) => planTransitionRow(model, now, {
    kind,
    id: id!,
    to: requiredArg(args, "--to"),
    reason: optionalArg(args, "--reason"),
    replacement: optionalArg(args, "--replacement"),
    checkpoint: optionalArg(args, "--checkpoint"),
  }));
}

const TRANSITION_BATCH_ALLOWED_KEYS = new Set(["kind", "id", "to", "reason", "replacement", "checkpoint"]);

function parseTransitionBatchRow(raw: unknown, index: number): TransitionRowSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError(`batch row ${index} must be a table`);
  const row = raw as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!TRANSITION_BATCH_ALLOWED_KEYS.has(key)) throw new UsageError(`batch row ${index} has unknown key: ${boundedBatchKey(key)}`);
  }
  const id = batchStringField(row, "id", index);
  if (!id?.trim()) throw new UsageError(`batch row ${index} requires a non-empty id`);
  const to = batchStringField(row, "to", index);
  if (!to?.trim()) throw new UsageError(`batch row ${index} requires a non-empty to`);
  const checkpoint = batchStringField(row, "checkpoint", index);
  const kind = assertTransitionRowShape(batchStringField(row, "kind", index), id, checkpoint !== undefined);
  return {
    kind,
    id,
    to,
    reason: batchStringField(row, "reason", index),
    replacement: batchStringField(row, "replacement", index),
    checkpoint,
  };
}

// W-347: fold N transition intents into ONE LifecycleV3FilePlan so the whole set
// commits through a single planGraphTransaction — one namespace lock, one recovery
// journal, one atomic replace. All-or-nothing is structural rather than
// compensating: every row is planned (and therefore fully validated) before any
// write is emitted, so the first rejected row aborts the mutate callback and the
// transaction never produces a plan — nothing reaches the canonical control tree
// and no row needs rolling back. This is the mechanism the PM lacked when three
// simultaneously-ready rows had to be transitioned one CLI call at a time, which
// left the set half-applied and forced a compensating rollback (2026-08-02).
function planTransitionBatch(model: PlanGraphControlModel, now: string, rows: TransitionRowSpec[]): LifecycleV3FilePlan {
  if (!rows.length) throw new UsageError("batch requires at least one row");
  const seen = new Set<string>();
  const writers = new Map<string, string>();
  const writes: LifecycleV3FilePlan["writes"] = [];
  const summaries: string[] = [];
  // W-667 F-12: the batch is still all-or-nothing, but its VERDICT is now
  // complete. Aborting on the first rejected row told the operator one fact per
  // run: a five-row file whose row 5 lacked a Checkpoint and whose row 1 was an
  // illegal transition cost three round trips to learn two defects the planner
  // already had in hand. Every row is planned, every rejection is collected, and
  // the whole set is reported once. A single failure keeps its original shape
  // and error class so nothing that reads these messages changes.
  const failures: { message: string; usage: boolean }[] = [];
  const reject = (index: number, target: string, error: unknown): void => {
    failures.push({
      message: `batch row ${index + 1} (${target}): ${(error as Error).message}`,
      usage: error instanceof UsageError,
    });
  };
  for (const [index, row] of rows.entries()) {
    const target = `${row.kind}:${row.id}`;
    if (seen.has(target)) {
      reject(index, target, new UsageError(`duplicate transition target within batch: ${target}`));
      continue;
    }
    seen.add(target);
    let plan: LifecycleV3FilePlan;
    try {
      plan = planTransitionRow(model, now, row);
    } catch (error) {
      reject(index, target, error);
      continue;
    }
    for (const write of plan.writes) {
      // Every row plans against the SAME loaded model, so two rows that touch one
      // shared file (two activations both deriving project_dashboard/current.md
      // from its pre-batch state, or two rows moving the same Checkpoint) would
      // silently drop the earlier row's edit at write time. Fail closed instead of
      // committing a last-writer-wins result — merging the two edits is deliberately
      // NOT implemented; splitting the batch is the supported answer.
      const owner = writers.get(write.path);
      if (owner) {
        reject(index, target, new UsageError(`batch rows ${owner} and ${target} both write ${write.path}; `
          + "a batch carries at most one Backlog activation because each one rewrites "
          + "project_dashboard/current.md — keep one activation in this batch and run the rest "
          + "as separate transitions"));
        continue;
      }
      writers.set(write.path, target);
      writes.push(write);
    }
    summaries.push(plan.summary);
  }
  if (failures.length === 1) {
    const only = failures[0]!;
    throw only.usage ? new UsageError(only.message) : new Error(only.message);
  }
  if (failures.length) {
    const message = `batch refused: ${failures.length} of ${rows.length} row(s) cannot be planned — fix all of them and rerun:\n`
      + failures.map((failure) => `  - ${failure.message}`).join("\n");
    throw failures.every((failure) => failure.usage) ? new UsageError(message) : new Error(message);
  }
  return { writes, summary: `transition ${rows.length} row(s) in one batch: ${summaries.join("; ")}` };
}

function handleV3TransitionBatch(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, [...V3_TRANSACTION_FLAGS, "--file"], V3_TRANSACTION_BOOLEANS);
  if (args.positionals.length) throw new UsageError(`unexpected transition-batch argument: ${args.positionals[0]}`);
  const rows = loadBatchRowTables(requiredArg(args, "--file")).map((raw, index) => parseTransitionBatchRow(raw, index + 1));
  return planGraphTransaction("transition-batch", args, options, (model, now) => planTransitionBatch(model, now, rows));
}

function handleV3Archive(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, [
    ...V3_TRANSACTION_FLAGS, "--to", "--reason", "--replacement",
  ], V3_TRANSACTION_BOOLEANS);
  if (args.positionals.length !== 2) throw new UsageError("archive requires <backlog|checkpoint> <id>");
  const [kind, id] = args.positionals;
  if (kind !== "backlog" && kind !== "checkpoint") throw new UsageError("archive supports only backlog or checkpoint");
  return planGraphTransaction("archive", args, options, (model, now) => {
    const record = planGraphRecord(model, kind, id!);
    const filename = record.path.split("/").at(-1)!;
    const archivePath = `${kind === "backlog" ? "backlog" : "checkpoints"}/archive/${now.slice(0, 4)}/${filename}`;
    return planLifecycleV3TerminalArchive({
      sourcePath: record.path,
      archivePath,
      record,
      to: requiredArg(args, "--to"),
      evidenceCount: planGraphRecordAdapter.inspect(record).evidenceCount,
      reason: optionalArg(args, "--reason"),
      replacement: optionalArg(args, "--replacement"),
      now,
      adapter: planGraphRecordAdapter,
      ...(kind === "checkpoint" && model.current
        ? { current: { path: model.current.path, record: model.current, adapter: planGraphCurrentAdapter } }
        : {}),
    });
  });
}

function handleV3Purge(rest: string[], options: CommonOptions): unknown {
  const args = parseCommandArgs(rest, [
    ...V3_TRANSACTION_FLAGS, "--expect-hash", "--manifest", "--classification", "--sharing", "--reachability",
    "--inbound-relations", "--outbound-relations", "--reference-count", "--reason", "--approval-ref",
  ], [...V3_TRANSACTION_BOOLEANS, "--used-as-authority", "--has-unique-information"]);
  const targetPath = positional(args, 0, "purge target path");
  return planGraphTransaction("purge", args, options, (model, now, agent) => {
    const safeTargetPath = assertLifecycleV3ControlPath(targetPath);
    const target = join(rootsFor(options).controlRoot, ...safeTargetPath.split("/"));
    if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) {
      throw new Error(`purge target does not exist as a regular canonical file: ${safeTargetPath}`);
    }
    const source = readFileSync(target);
    const expected = requiredArg(args, "--expect-hash");
    const actual = sha256(source);
    if (actual !== expected) throw new Error(`purge target hash changed: expected ${expected}, got ${actual}`);
    const classification = requiredArg(args, "--classification");
    if (!["mistake", "empty_scaffold", "typo_duplicate"].includes(classification)) {
      throw new UsageError("--classification must be mistake, empty_scaffold, or typo_duplicate");
    }
    const sharing = requiredArg(args, "--sharing");
    if (!["uncommitted", "proven_unshared", "unknown", "shared"].includes(sharing)) {
      throw new UsageError("--sharing must be uncommitted, proven_unshared, unknown, or shared");
    }
    const reachability = requiredArg(args, "--reachability");
    if (!["proven_unreachable", "unknown", "reachable"].includes(reachability)) {
      throw new UsageError("--reachability must be proven_unreachable, unknown, or reachable");
    }
    const manifest = optionalArg(args, "--manifest")
      ?? `reports/purges/${now.slice(0, 10)}-${targetPath.split("/").at(-1)!.replace(/\.[^.]+$/, "")}.json`;
    return planLifecycleV3Purge({
      targetPath: safeTargetPath,
      targetHash: expected,
      manifestPath: manifest,
      classification: classification as "mistake" | "empty_scaffold" | "typo_duplicate",
      sharing: sharing as "uncommitted" | "proven_unshared" | "unknown" | "shared",
      reachability: reachability as "proven_unreachable" | "unknown" | "reachable",
      inboundRelations: integerArg(requiredArg(args, "--inbound-relations"), "--inbound-relations", 0),
      outboundRelations: integerArg(requiredArg(args, "--outbound-relations"), "--outbound-relations", 0),
      referenceCount: integerArg(requiredArg(args, "--reference-count"), "--reference-count", 0),
      usedAsAuthority: args.booleans.has("--used-as-authority"),
      hasUniqueInformation: args.booleans.has("--has-unique-information"),
      reason: requiredArg(args, "--reason"),
      agent,
      now,
      userApprovalRef: optionalArg(args, "--approval-ref"),
    });
  });
}

function handleV3Checkpoint(action: string, rest: string[], options: CommonOptions): unknown {
  if (action === "begin-action" || action === "finish-action") return handleV3Action(action, rest, options, true);
  if (action === "resume") {
    const args = parseCommandArgs(rest, [], ["--verify-git"]);
    if (args.positionals.length !== 1) throw new UsageError("checkpoint resume requires <CP-NNN>");
    const checkpoint = planGraphRecord(planGraphFor(options), "checkpoint", args.positionals[0]!);
    if (checkpoint.kind !== "checkpoint") throw new Error(`Checkpoint does not exist: ${args.positionals[0]}`);
    const actual = args.booleans.has("--verify-git") ? captureTargetGit(options) : null;
    const mismatch = actual ? [
      checkpoint.branch !== actual.branch ? "branch" : null,
      checkpoint.head !== actual.head ? "head" : null,
      checkpoint.workingTree !== actual.workingTree ? "working_tree" : null,
      checkpoint.gitStatusHash && checkpoint.gitStatusHash !== actual.statusHash ? "git_status_hash" : null,
    ].filter((value): value is string => value !== null) : [];
    return {
      schema_version: 1,
      control_schema_version: 3,
      storage: "plan_graph_markdown",
      checkpoint,
      repository: actual,
      drift: mismatch.length > 0,
      mismatches: mismatch,
    };
  }
  if (action === "close") {
    const args = parseCommandArgs(rest, [...V3_TRANSACTION_FLAGS, "--status", "--reason"], V3_TRANSACTION_BOOLEANS);
    if (args.positionals.length !== 1) throw new UsageError("checkpoint close requires <CP-NNN>");
    const id = args.positionals[0]!;
    const to = requiredArg(args, "--status");
    if (!["completed", "abandoned"].includes(to)) throw new UsageError("checkpoint close --status must be completed or abandoned");
    return planGraphTransaction("checkpoint-close", args, options, (model, now) => {
      const record = planGraphRecord(model, "checkpoint", id);
      if (record.kind !== "checkpoint" || !model.current) throw new Error(`Checkpoint cannot be closed: ${id}`);
      if (to === "completed" && record.action) {
        throw new Error(`Checkpoint ${id} has an unfinished prepared action; finish it before completing the Checkpoint`);
      }
      return planLifecycleV3TerminalArchive({
        sourcePath: record.path,
        archivePath: `checkpoints/archive/${now.slice(0, 4)}/${record.path.split("/").at(-1)!}`,
        record,
        to,
        evidenceCount: planGraphRecordAdapter.inspect(record).evidenceCount,
        reason: optionalArg(args, "--reason"),
        now,
        adapter: planGraphRecordAdapter,
        current: { path: model.current.path, record: model.current, adapter: planGraphCurrentAdapter },
      });
    });
  }
  if (action !== "save") throw new UsageError(`checkpoint requires begin-action, finish-action, save, resume, or close (got ${action})`);
  const args = parseCommandArgs(rest, [
    ...V3_TRANSACTION_FLAGS, "--id", "--checkpoint", "--title", "--next-action", "--last-completed", "--blockers", "--resume-verification",
    "--read-first", "--roadmaps", "--milestones", "--backlog", "--related", "--branch", "--head", "--working-tree",
  ], [...V3_TRANSACTION_BOOLEANS, "--activate", "--capture-git"]);
  if (args.positionals.length > 1) throw new UsageError(`unexpected checkpoint save argument: ${args.positionals[1]}`);
  const optionId = optionalArg(args, "--id") ?? optionalArg(args, "--checkpoint");
  if (optionId && args.positionals.length) throw new UsageError("Checkpoint ID may be positional or passed by flag, not both");
  const captureGit = args.booleans.has("--capture-git");
  if (captureGit && ["--branch", "--head", "--working-tree"].some((flag) => args.values.has(flag))) {
    throw new UsageError("--capture-git cannot be combined with --branch, --head, or --working-tree");
  }
  const gitCapture = captureGit ? captureTargetGit(options) : undefined;
  const list = (flag: string): string[] | undefined => args.values.has(flag)
    ? args.values.get(flag)!.flatMap((value) => commaListOrEmpty(value, flag))
    : undefined;
  return planGraphTransaction("checkpoint-save", args, options, (model, now, agent) => planCheckpointSave({
    model,
    id: optionId ?? args.positionals[0],
    title: optionalArg(args, "--title"),
    exactNextAction: optionalArg(args, "--next-action")
      ?? (optionId ?? args.positionals[0] ? model.checkpoints.get((optionId ?? args.positionals[0])!)?.exactNextAction : undefined)
      ?? (() => { throw new UsageError("new checkpoint save requires --next-action"); })(),
    lastCompleted: optionalArg(args, "--last-completed"),
    blockers: optionalArg(args, "--blockers"),
    resumeVerification: optionalArg(args, "--resume-verification")
      ?? (optionId ?? args.positionals[0] ? model.checkpoints.get((optionId ?? args.positionals[0])!)?.resumeVerification : undefined)
      ?? (() => { throw new UsageError("new checkpoint save requires --resume-verification"); })(),
    readFirst: list("--read-first"),
    roadmaps: list("--roadmaps"),
    milestones: list("--milestones"),
    backlog: list("--backlog"),
    related: list("--related"),
    branch: gitCapture?.branch ?? optionalArg(args, "--branch"),
    head: gitCapture?.head ?? optionalArg(args, "--head"),
    workingTree: gitCapture?.workingTree ?? optionalArg(args, "--working-tree"),
    gitStatusHash: gitCapture?.statusHash,
    stagedPaths: gitCapture?.staged,
    modifiedPaths: gitCapture?.modified,
    untrackedPaths: gitCapture?.untracked,
    gitCapture: gitCapture ? renderCheckpointGitCapture(gitCapture) : undefined,
    agent,
    now,
    activate: args.booleans.has("--activate"),
  }));
}

function handleV3Action(command: "begin-action" | "finish-action", rest: string[], options: CommonOptions, checkpointStyle = false): unknown {
  const args = parseCommandArgs(rest, command === "begin-action"
    ? [...V3_TRANSACTION_FLAGS, "--checkpoint", "--next-action", "--next", "--repository-state", "--success", "--target"]
    : [...V3_TRANSACTION_FLAGS, "--checkpoint", "--expect-action-token", "--result", "--changed-file", "--repository-state", "--next-action", "--next"],
  [...V3_TRANSACTION_BOOLEANS, "--capture-git"]);
  if (args.positionals.length > (checkpointStyle ? 1 : 0)) throw new UsageError(`unexpected ${command} argument: ${args.positionals.at(-1)}`);
  const positionalId = checkpointStyle ? args.positionals[0] : undefined;
  const optionId = optionalArg(args, "--checkpoint");
  if (positionalId && optionId) throw new UsageError("Checkpoint ID may be positional or passed by flag, not both");
  const checkpointId = positionalId ?? optionId ?? (() => { throw new UsageError(`${command} requires a Checkpoint ID`); })();
  const captureGit = args.booleans.has("--capture-git");
  if (captureGit && args.values.has("--repository-state")) throw new UsageError("--capture-git cannot be combined with --repository-state");
  const captured = captureGit ? captureTargetGit(options) : null;
  const capturedState = captured ? renderCheckpointGitCapture(captured) : undefined;
  return planGraphTransaction(command, args, options, (model, now) => {
    const record = planGraphRecord(model, "checkpoint", checkpointId);
    if (record.kind !== "checkpoint") throw new Error(`Checkpoint does not exist: ${checkpointId}`);
    const plan = command === "begin-action"
      ? planLifecycleV3BeginAction({
        checkpointPath: record.path,
        checkpoint: record,
        exactNextAction: optionalArg(args, "--next-action") ?? requiredArg(args, "--next"),
        repositoryState: capturedState ?? requiredArg(args, "--repository-state"),
        successCondition: optionalArg(args, "--success") ?? "Complete the recorded action and preserve all quality gates.",
        targets: args.values.get("--target")?.flatMap((value) => commaList(value, "--target")) ?? [`checkpoint:${checkpointId}`],
        now,
        adapter: planGraphCheckpointAdapter,
      })
      : planLifecycleV3FinishAction({
        checkpointPath: record.path,
        checkpoint: record,
        expectedActionToken: optionalArg(args, "--expect-action-token")
          ?? planGraphCheckpointAdapter.inspectAction(record).token
          ?? (() => { throw new Error(`Checkpoint ${checkpointId} has no prepared action`); })(),
        result: requiredArg(args, "--result"),
        changedFiles: captured
          ? [...new Set([...captured.staged, ...captured.modified, ...captured.untracked])].sort()
          : args.values.get("--changed-file")?.flatMap((value) => commaListOrEmpty(value, "--changed-file")) ?? [],
        repositoryState: capturedState ?? requiredArg(args, "--repository-state"),
        exactNextAction: optionalArg(args, "--next-action") ?? optionalArg(args, "--next")
          ?? "Review the recorded result and select the next action.",
        now,
        adapter: planGraphCheckpointAdapter,
      });
    if (!captured) return plan;
    const write = plan.writes.find((candidate) => candidate.path === record.path && candidate.source !== null);
    if (!write?.source) throw new Error(`${command} did not produce a Checkpoint write`);
    const persisted = parseCheckpointRecord(write.source, record.path);
    const patched = patchCheckpointGitMetadata({
      checkpoint: persisted,
      branch: captured.branch,
      head: captured.head,
      workingTree: captured.workingTree,
      gitStatusHash: captured.statusHash,
      stagedPaths: captured.staged,
      modifiedPaths: captured.modified,
      untrackedPaths: captured.untracked,
      now,
    });
    return {
      ...plan,
      writes: plan.writes.map((candidate) =>
        candidate === write ? { ...candidate, source: planGraphCheckpointAdapter.render(patched) } : candidate),
    };
  });
}

function execute(argv: string[], cwd: string): CliResult {
  try {
    // W-467: one CLI invocation is one operation. Roots and worktree shapes that
    // a PREVIOUS operation in this process declared are dropped here, so a
    // scenario that must be refused cannot be allowed by a root its predecessor
    // added (the accumulation was monotonic — add with no counterpart). This
    // only ever narrows; nothing here grants anything.
    resetPositionState();
    argv = expandEquals(argv);
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") return { code: 0, stdout: `${USAGE}\n`, stderr: "" };
    const command = argv[0];
    const { options, rest } = parseCommon(argv.slice(1), cwd);
    if (options.format === "mermaid" && command !== "graph") throw new UsageError("--format mermaid is supported only by control graph");
    const version = schemaVersion(options);
    if (version !== 3) {
      throw new Error(`unsupported control schema_version ${version ?? "missing"}; only schema_version 3 with storage plan_graph_markdown is accepted`);
    }
    if (["context", "resume", "get", "list", "doctor", "graph", "cockpit"].includes(command)) {
      validateReadSyntax(command, rest);
      return planGraphRead(command, rest, options);
    }
    // W-267: every verb past the read dispatch above mutates the tree, so the cwd
    // fence runs here — once, before any command-specific root resolution.
    assertControlCwdFence(command, options);
    let result: unknown;
    let text: string | undefined;
    switch (command) {
      case "generation-recover": {
        const args = parseCommandArgs(rest, ["--expect-plan-digest", "--expect-generation", "--session"], ["--plan", "--apply"]);
        if (args.positionals.length) throw new UsageError(`unexpected generation-recover argument: ${args.positionals[0]}`);
        const planning = args.booleans.has("--plan"), applying = args.booleans.has("--apply");
        if (planning === applying) throw new UsageError("generation-recover requires exactly one of --plan or --apply");
        // W-222: root discovery for THIS command must not go through rootsFor's
        // readStableControl-gated resolveControlRoots — that throws
        // "...odd without a live namespace lock..." for exactly the crashed-writer
        // state generation-recover exists to fix, so the recovery command could
        // never reach its own plan/apply logic. resolveControlRootsForRecovery
        // resolves the same paths without requiring a settled generation.
        const roots = resolveControlRootsForRecovery(options.project, options.pmId, options.container);
        const pathOptions = { targetRoot: roots.targetRoot, pmId: options.pmId, controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot };
        if (planning) {
          if (args.values.size) throw new UsageError("generation-recover --plan accepts no apply preconditions");
          result = planGenerationRecovery(pathOptions);
          text = `control generation-recover: plan ${(result as { plan_digest: string }).plan_digest}`;
        } else {
          const generation = Number(requiredArg(args, "--expect-generation"));
          if (!Number.isSafeInteger(generation) || generation < 0) throw new UsageError("--expect-generation must be a non-negative integer from the plan");
          result = applyGenerationRecovery({ ...pathOptions, expectedPlanDigest: requiredArg(args, "--expect-plan-digest"), expectedGeneration: generation, sessionId: requiredArg(args, "--session") });
          text = `control generation-recover: applied generation ${generation}`;
        }
        break;
      }
      case "landing-finalize":
        result = handleLandingFinalize(rest, options);
        text = `control landing-finalize: ${(result as { state?: string; plan_digest?: string }).state ?? `plan ${(result as { plan_digest: string }).plan_digest}`}`;
        break;
      case "reconcile": {
        const args = parseCommandArgs(rest, [], ["--git"]);
        if (args.positionals.length || !args.booleans.has("--git")) throw new UsageError("reconcile requires --git");
        const roots = rootsFor(options);
        const reconciled = readStableControl({ controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot }, () => {
          const model = loadPlanGraphModel(roots.controlRoot);
          const modelFindings = model.findings.map((finding) => ({
            ...finding,
            suggested_command: null,
          }));
          return {
            revision: model.revision,
            findings: [...modelFindings, ...reconcilePlanGraphGit(model, { targetRoot: roots.targetRoot, pmId: options.pmId })],
          };
        });
        const summary = findingsSummary(reconciled.findings);
        result = { schema_version: 1, control_schema_version: version, pm_id: options.pmId, control_revision: reconciled.revision, findings: reconciled.findings, summary };
        text = `control reconcile: ${summary.errors} error(s), ${summary.warnings} warning(s)`;
        return { code: summary.errors ? 1 : 0, stdout: emit(result, options, text), stderr: "" };
      }
      case "session-open":
      case "session-heartbeat":
      case "session-close": {
        const args = parseCommandArgs(rest, command === "session-open" ? ["--agent", "--session-id"] : ["--session"]);
        if (args.positionals.length) throw new UsageError(`unexpected positional argument: ${args.positionals[0]}`);
        const roots = rootsFor(options);
        if (command === "session-open") {
            // Prime/bootstrap the generation snapshot before openControlSession's own
            // namespace-lock + session-record writes touch runtimeRoot (W-211) — otherwise
            // those writes falsify the "never-touched runtime location" signal that
            // readControlGenerationSnapshot's fresh-worktree fallback relies on by the time
            // boundedPlanGraphResumeFor (below) reads generation.
            ensureControlGenerationBootstrapped(roots.controlRoot, roots.runtimeRoot);
            const session = openControlSession({
              targetRoot: roots.targetRoot,
              pmId: options.pmId,
              controlRoot: roots.controlRoot,
              runtimeRoot: roots.runtimeRoot,
              runtimeCallbacks: planGraphRuntimeCallbacks,
              agent: requiredArg(args, "--agent"),
              sessionId: optionalArg(args, "--session-id"),
              cwd,
            });
          result = { session, resume: boundedPlanGraphResumeFor(options, session.base_control_revision) };
        } else if (command === "session-heartbeat") {
          result = heartbeatControlSession({
            targetRoot: roots.targetRoot, pmId: options.pmId, controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot,
            runtimeCallbacks: planGraphRuntimeCallbacks, sessionId: requiredArg(args, "--session"),
          });
        } else {
          result = closeControlSession({
            targetRoot: roots.targetRoot, pmId: options.pmId, controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot,
            runtimeCallbacks: planGraphRuntimeCallbacks, sessionId: requiredArg(args, "--session"),
          });
        }
        break;
      }
      case "claim":
      case "work-claim":
      case "claim-release":
      case "work-release":
        result = handleClaim(command, rest, options);
        break;
      case "work-create":
        result = handleV3Backlog("create", rest, options);
        break;
      case "work-update":
        result = handleV3Backlog("update", rest, options);
        break;
      case "work-transition":
        result = handleV3Transition(["backlog", ...rest], options);
        break;
      case "backlog": {
        const action = rest.shift();
        if (!action) throw new UsageError("backlog requires create, create-batch, triage-batch, reopen, or update");
        result = handleV3Backlog(action, rest, options);
        break;
      }
      case "backlog-create":
        result = handleV3Backlog("create", rest, options);
        break;
      case "backlog-update":
        result = handleV3Backlog("update", rest, options);
        break;
      case "backlog-create-batch":
        requireV3(options);
        result = handleV3BacklogCreateBatch(rest, options);
        break;
      case "create":
        result = handleV3Create(rest, options);
        break;
      case "milestone": {
        const action = rest.shift();
        if (!action) throw new UsageError("milestone requires update");
        result = handleV3Milestone(action, rest, options);
        break;
      }
      case "risk": {
        const action = rest.shift();
        if (!action) throw new UsageError("risk requires create, update, transition, archive, or reopen");
        result = handleV3Risk(action, rest, options);
        break;
      }
      case "relation": {
        const action = rest.shift();
        if (!action) throw new UsageError("relation requires link or retire");
        result = handleV3Relation(action, rest, options);
        break;
      }
      case "relation-link":
        result = handleV3Relation("link", rest, options);
        break;
      case "relation-retire":
        result = handleV3Relation("retire", rest, options);
        break;
      case "link":
        result = handleV3LinkAlias(rest, options);
        break;
      case "retire":
        result = handleV3RetireAlias(rest, options);
        break;
      case "transition":
        result = handleV3Transition(rest, options);
        break;
      case "transition-batch":
        requireV3(options);
        result = handleV3TransitionBatch(rest, options);
        break;
      case "archive":
        result = handleV3Archive(rest, options);
        break;
      case "reopen":
        requireV3(options);
        result = handleV3Reopen(rest, options);
        break;
      case "purge":
        result = handleV3Purge(rest, options);
        break;
      case "checkpoint": {
        const action = rest.shift();
        if (!action) throw new UsageError("checkpoint requires begin-action, finish-action, save, resume, or close");
        result = handleV3Checkpoint(action, rest, options);
        break;
      }
      case "checkpoint-save":
        result = handleV3Checkpoint("save", rest, options);
        break;
      case "begin-action":
      case "finish-action":
        result = handleV3Action(command, rest, options);
        break;
      case "work-reopen":
        result = handleV3BacklogReopen(rest, options, "backlog-reopen");
        break;
      case "evidence-add":
        result = handleV3EvidenceAdd(rest, options);
        break;
      case "risk-create":
        result = handleV3Risk("create", rest, options);
        break;
      case "risk-update":
        result = handleV3Risk("update", rest, options);
        break;
      case "risk-transition":
        result = handleV3RiskTransition(rest, options);
        break;
      case "risk-close":
        result = handleV3RiskTransition([...rest, "--to", "closed"], options, "risk-close");
        break;
      case "risk-reopen":
        result = handleV3RiskReopen(rest, options);
        break;
      case "milestone-update":
        result = handleV3Milestone("update", rest, options);
        break;
      case "milestone-transition":
        result = handleV3Transition(["milestone", ...rest], options);
        break;
      case "artifact-create":
        result = handleV3ArtifactCreate(rest, options);
        break;
      case "artifact-update":
        result = handleV3ArtifactUpdate(rest, options);
        break;
      case "repair":
        result = handleRepair(rest, options);
        break;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
    return { code: 0, stdout: emit(result, options, text), stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const next = refusalNextCommand(argv, cwd, message);
    // W-620 追記 L-1/L-3 — the real cause must be the LAST thing printed.
    //
    // A usage error printed the one-line cause, then dumped 40 lines of USAGE
    // whose closing paragraph explains the W-267 cwd fence. A PM who omitted the
    // entity kind read the tail, took the fence for the cause, and spent five
    // steps checking cwd, repo root, --project and the env var — none of which
    // were involved; the fence is opt-in and was not even enabled. Then, still
    // reading the tail, they took a batch of six identical argv failures for
    // "four rows transitioned". A failure that names the wrong cause is worse
    // than one that names none: it produces confident wrong action.
    //
    // Same lesson as W-461's stats block, one layer up: whatever the tail says
    // is what gets read, so the tail has to be the answer.
    const restated = error instanceof UsageError
      ? `\n${USAGE}\ncontrol: ${message}`
      : "";
    return {
      code: error instanceof UsageError ? 2 : 1,
      stdout: "",
      stderr: `control: ${message}${next ? `\nNEXT_COMMAND: ${next}` : ""}${restated}\n`,
    };
  } finally {
    // W-467: the operation's declared fence root does not outlive the operation.
    // Without this, a control mutation left its own control root trusted for the
    // rest of the process, and a LATER unrelated delete of that root's own parent
    // was then refused as "ancestor of a fence root" — measured against the
    // control transaction fixtures, which clean up their temp trees after calling
    // the CLI. Entry AND exit are both cleared so neither the previous nor the
    // next operation inherits this one's position.
    resetPositionState();
  }
}

export function runCli(argv = process.argv.slice(2), cwd = process.cwd()): CliResult {
  return execute(argv, cwd);
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()): number {
  const result = runCli(argv, cwd);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

if (import.meta.main) process.exit(main());
