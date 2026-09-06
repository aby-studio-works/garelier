import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  git,
  jsonEscape,
  printHelp,
  readTomlQuoted,
  readTomlScalar,
  readTomlStringArray,
  run,
  utcCompact,
  valueAfter,
} from "./_lib.ts";
import { crewSubdir } from "../workspace.ts";
import { MERGE_REQUEST_FLAGS } from "./cli_flag_ownership.ts";
import { acquireGarelierOperationGuard, garelierControlRoots, inspectDispatchControlBinding } from "../control/garelier_integration.ts";
import { canonicalJson, sha256 } from "../control/serialization.ts";
import { extractGuardianVerdict, extractReviewSha, extractVerdict } from "../merge_gate_parse.ts";
import { roleBranchIdentity, type AftercareBinding } from "../dispatch/land_aftercare.ts";
import { loadConfig } from "../config.ts";
import { assertChokepointAllowed } from "../integration_closure.ts";
import { closeRoleAdmission } from "../dispatch/contract_check.ts";
import {
  dispatchExecutionIdentity,
  roleBindingFromContext,
  roleExecutionIdentityForBranch,
  type RoleBindingReference,
  type RoleCloseReference,
} from "../dispatch/role_binding.ts";

class CliFailure extends Error { constructor(readonly exitCode = 2) { super("merge_request failed"); } }
function die(message: string): never { process.stderr.write(`${message}\n`); throw new CliFailure(); }

// Resolve canonical `_crew/pm/setup_config.toml` through the shared workspace
// resolver so callers never duplicate the layout contract.
export function resolveSetupConfig(project: string, pm: string): string {
  return `${crewSubdir(project, pm, "pm")}/setup_config.toml`;
}

const HELP = `#
# merge_request.ts — one-command merge-gate request (DEC-064 §1).
#
# Derives everything the merge gate's request JSON needs from existing
# artifacts, so the Dock never hand-assembles it (the two live-failure
# classes — missing verdicts, empty merge_message — become impossible):
#   studio branch   ← setup_config.toml [branches] integration (or --studio)
#   request_id      ← UTC timestamp + random UUID + task label
#   merge_message   ← generated non-empty (or --message)
#   verdicts        ← --guardian / --observer flags
#   preflight       ← --preflight flags (optional, repeatable; W-023). Lightweight
#                     checks the merge gate runs right after the merge and BEFORE
#                     the (potentially expensive) quality gate, so a cheap,
#                     deterministic problem fails in seconds instead of at the end
#                     of a multi-minute compile/test run. Example for a Rust
#                     project: \`--preflight 'cargo metadata --locked --offline'\`
#                     catches a stale Cargo.lock without compiling anything.
#                     No --preflight flag falls back to [merge_gate]
#                     preflight_commands (single-line array) in setup_config
#                     (W-033 — this is how the jig merge paths opt in). Absent in
#                     both places → no preflight step (behavior identical to before).
# Writes runtime/merge_gate/requests/<id>.json and (unless --no-poll) runs the
# zero-LLM dock_merge.ts poll so the gate subprocess starts immediately.
#
# --notify (W-079): the merge gate is async and in ATTENDED mode nothing watches
# results/, so a finished (or conflict-failed) gate goes unnoticed. With --notify
# this prints the exact \`gate_result_waiter.ts\` command for THIS request on stderr
# — the PM runs it via run_in_background and gets pushed the outcome when the gate
# terminates (the harness re-wakes on background completion). Default (no flag) is
# unchanged: driver mode's poll loop already drives the result, so no waiter is
# needed there.
#
# Usage:
#   merge_request.ts --project <control-root> --pm-id <id> --branch <workbench-branch>
#                    --guardian <PASS|PASS_WITH_NOTES> [--observer <verdict>]
#                    [--task <label>] [--message <msg>] [--studio <branch>]
#                    [--work-id W-N] [--control-session <session_id>] [--report <path>]
#                    [--dispatch-id <id>] # equality assertion; branch identity is authoritative
#                    [--aftercare-binding <dispatch|branch_only>]
#                    [--execution-route <dock|artisan>] [--expected-studio-sha <full-sha>]
#                    [--preflight <cmd>]... [--quality-gate <cmd>]...
#                    [--target-root <git-root>] [--core <garelier-core-dir>]
#                    [--refuter-verdict <UPHELD|REFUTED>] [--refuter-report <path>] [--high-stakes]
#                    [--notify] [--no-poll]
#
# Refuter (W-066): the opt-in adversarial-verify layer on top of the Observer
# verdict, for HIGH-STAKES merges only. --refuter-verdict carries an independent
# refuter agent's UPHELD/REFUTED (a REFUTED holds the merge for PM escalation;
# see merge-gate.ts). --high-stakes marks a merge high-stakes for a semantic
# trigger the gate cannot see from the diff (migration / public API / auth) so
# the gate warns (advisory) if it lands without a refuter verdict. Both are
# optional and default-off — a merge with neither behaves exactly as before.`;

function normalizeVerdict(flag: string, value: string): string {
  if (value === "PASS_WITH_CHANGES" || value === "PASS_WITH_NOTE") {
    process.stderr.write(`merge_request: ${flag} '${value}' normalized to PASS_WITH_NOTES (canonical vocabulary: PASS / PASS_WITH_NOTES / BLOCK / NO_OPINION; Observer also REWORK_RECOMMENDED) — W-073\n`);
    return "PASS_WITH_NOTES";
  }
  return value;
}

function fullBranchSha(root: string, branch: string): string {
  const result = git(root, ["rev-parse", "--verify", `${branch}^{commit}`]);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

function validateCanonicalGateReport(
  role: "Guardian" | "Observer", reportPath: string, assertedVerdict: string, project: string,
): string {
  const path = resolve(project, reportPath);
  if (!existsSync(path)) die(`merge_request: ${role} report is unreadable: ${reportPath}`);
  const text = readFileSync(path, "utf8");
  const verdict = role === "Guardian" ? extractGuardianVerdict(text) : extractVerdict(text);
  const reviewSha = extractReviewSha(text);
  if (!verdict || !reviewSha) {
    die(`merge_request: ${role} report is not canonical (require standalone verdict and full 40..64-character lowercase review_sha) — refusing to queue`);
  }
  if (verdict !== assertedVerdict) {
    die(`merge_request: ${role} report verdict ${verdict} does not match asserted --${role.toLowerCase()} ${assertedVerdict}`);
  }
  return reviewSha;
}

function requestJson(fields: {
  requestId: string; branch: string; branchTip: string; studio: string; gitRoot: string; task: string;
  guardian: string; guardianReport: string; guardianReviewSha: string; guardianRequireReport: boolean;
  observer: string; observerReport: string; observerReviewSha: string; observerRequireReport: boolean;
  refuterVerdict: string; refuterReport: string; highStakes: boolean;
  preflight: string[]; qualityGate: string[]; qualityGateTimeoutMinutesPerCmd: number; message: string;
  executionRoute: string; expectedStudioSha: string;
  controlSchema: number | null; workId: string; controlSession: string; report: string; projectRoot: string;
  dispatchId: string | null; dispatchContainer: string | null; aftercareBinding: AftercareBinding; reportJson: string | null;
  mergeGateConfig: { path: string; content_hash: string } | null;
  roleBinding: RoleBindingReference;
  roleClose: RoleCloseReference;
}): string {
  const q = (value: string): string => `"${jsonEscape(value)}"`;
  const lines = [
    "{",
    `  "request_id": ${q(fields.requestId)},`,
    `  "workbench_branch": ${q(fields.branch)},`,
    `  "workbench_tip": ${q(fields.branchTip)},`,
    `  "studio_branch": ${q(fields.studio)},`,
    `  "target_root": ${q(fields.gitRoot)},`,
    `  "dispatch_id": ${fields.dispatchId === null ? "null" : q(fields.dispatchId)},`,
    `  "dispatch_container": ${fields.dispatchContainer === null ? "null" : q(fields.dispatchContainer)},`,
    `  "aftercare_binding": ${q(fields.aftercareBinding)},`,
    `  "role_report_json_path": ${fields.reportJson === null ? "null" : q(fields.reportJson)},`,
    `  "role_binding": ${JSON.stringify(fields.roleBinding)},`,
    `  "role_close": ${JSON.stringify(fields.roleClose)},`,
    `  "task_id": ${q(fields.task)},`,
    '  "agent": "merge_request.ts",',
    `  "guardian_verdict": ${q(fields.guardian)},`,
  ];
  if (fields.executionRoute) lines.push(`  "execution_route": ${q(fields.executionRoute)},`);
  if (fields.expectedStudioSha) lines.push(`  "expected_studio_sha": ${q(fields.expectedStudioSha)},`);
  if (fields.controlSchema === 3) {
    lines.push(`  "control_schema_version": ${fields.controlSchema},`);
    lines.push(`  "control_project_root": ${q(fields.projectRoot)},`);
    lines.push(`  "work_id": ${q(fields.workId)},`);
    lines.push(`  "control_session_id": ${q(fields.controlSession)},`);
    if (fields.report) lines.push(`  "role_report_path": ${q(fields.report)},`);
  }
  if (fields.guardianReport) {
    lines.push('  "guardian_required": true,');
    lines.push(`  "guardian_report_path": ${q(fields.guardianReport)},`);
    if (fields.guardianReviewSha) lines.push(`  "guardian_review_sha": ${q(fields.guardianReviewSha)},`);
  }
  if (fields.guardianRequireReport) lines.push('  "guardian_require_report": true,');
  if (fields.observer) {
    lines.push(`  "observer_verdict": ${q(fields.observer)},`);
    if (fields.observerReport) {
      lines.push('  "observer_required": true,');
      lines.push(`  "observer_report_path": ${q(fields.observerReport)},`);
      if (fields.observerReviewSha) lines.push(`  "observer_review_sha": ${q(fields.observerReviewSha)},`);
    }
    if (fields.observerRequireReport) lines.push('  "observer_require_report": true,');
  }
  if (fields.refuterVerdict) lines.push(`  "refuter_verdict": ${q(fields.refuterVerdict)},`);
  if (fields.refuterReport) lines.push(`  "refuter_report_path": ${q(fields.refuterReport)},`);
  if (fields.highStakes) lines.push('  "high_stakes": true,');
  if (fields.preflight.length) lines.push(`  "preflight": [${fields.preflight.map(q).join(", ")}],`);
  if (fields.qualityGate.length) lines.push(`  "quality_gate_commands": [${fields.qualityGate.map(q).join(", ")}],`);
  lines.push(`  "quality_gate_timeout_minutes_per_cmd": ${fields.qualityGateTimeoutMinutesPerCmd},`);
  if (fields.controlSchema === 3) {
    lines.push('  "gate_mode": "normal",');
    lines.push(`  "requested_preflight_commands": [${fields.preflight.map(q).join(", ")}],`);
    lines.push(`  "requested_quality_gate_commands": [${fields.qualityGate.map(q).join(", ")}],`);
    lines.push(`  "effective_gate_commands": [${fields.qualityGate.map(q).join(", ")}],`);
    lines.push(`  "merge_gate_config": ${JSON.stringify(fields.mergeGateConfig)},`);
  }
  lines.push(`  "merge_message": ${q(fields.message)}`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let project = "", targetRoot = "", pm = "", branch = "", task = "";
  let guardian = "", observer = "", message = "", studio = "", core = "";
  let guardianReport = "", observerReport = "", guardianReviewSha = "", observerReviewSha = "";
  let refuterVerdict = "", refuterReport = "";
  let executionRoute = "", expectedStudioSha = "", aftercareBinding = "";
  let workId = "", controlSession = "", roleReport = "", dispatchId = "";
  let highStakes = false, notify = false, noPoll = false;
  const qualityGate: string[] = [];
  const preflight: string[] = [];
  for (let i = 0; i < argv.length;) {
    // W-622 / G-2: the accepted set lives in MERGE_REQUEST_FLAGS and the refusal
    // message below is DERIVED from it, so the two cannot drift apart. The
    // switch is still the executable authority; merge_request.test.ts asserts
    // the two agree in both directions.
    switch (argv[i]) {
      case "--project": project = valueAfter(argv, i); i += 2; break;
      case "--target-root": targetRoot = valueAfter(argv, i); i += 2; break;
      case "--pm-id": pm = valueAfter(argv, i); i += 2; break;
      case "--branch": branch = valueAfter(argv, i); i += 2; break;
      case "--task": task = valueAfter(argv, i); i += 2; break;
      case "--work-id": workId = valueAfter(argv, i); i += 2; break;
      case "--control-session": controlSession = valueAfter(argv, i); i += 2; break;
      case "--report": roleReport = valueAfter(argv, i); i += 2; break;
      case "--dispatch-id": dispatchId = valueAfter(argv, i).replace(/^#/, ""); i += 2; break;
      case "--aftercare-binding": aftercareBinding = valueAfter(argv, i); i += 2; break;
      case "--execution-route": executionRoute = valueAfter(argv, i); i += 2; break;
      case "--expected-studio-sha": expectedStudioSha = valueAfter(argv, i); i += 2; break;
      case "--guardian": guardian = valueAfter(argv, i); i += 2; break;
      case "--observer": observer = valueAfter(argv, i); i += 2; break;
      case "--guardian-report": guardianReport = valueAfter(argv, i); i += 2; break;
      case "--observer-report": observerReport = valueAfter(argv, i); i += 2; break;
      case "--guardian-review-sha": guardianReviewSha = valueAfter(argv, i); i += 2; break;
      case "--observer-review-sha": observerReviewSha = valueAfter(argv, i); i += 2; break;
      case "--message": message = valueAfter(argv, i); i += 2; break;
      case "--studio": studio = valueAfter(argv, i); i += 2; break;
      case "--core": core = valueAfter(argv, i); i += 2; break;
      case "--quality-gate": qualityGate.push(valueAfter(argv, i)); i += 2; break;
      case "--preflight": preflight.push(valueAfter(argv, i)); i += 2; break;
      case "--refuter-verdict": refuterVerdict = valueAfter(argv, i); i += 2; break;
      case "--refuter-report": refuterReport = valueAfter(argv, i); i += 2; break;
      case "--high-stakes": highStakes = true; i++; break;
      case "--notify": notify = true; i++; break;
      case "--no-poll": noPoll = true; i++; break;
      case "-h": case "--help": printHelp(HELP);
      default:
        die(`merge_request: unknown arg: ${argv[i]}\nmerge_request: valid flags: ${MERGE_REQUEST_FLAGS.join(" ")} -h/--help`);
    }
  }
  if (!project || !pm || !branch) die("merge_request: --project, --pm-id, --branch are required");
  if (executionRoute && executionRoute !== "dock" && executionRoute !== "artisan") {
    die(`merge_request: --execution-route must be dock or artisan (got '${executionRoute}')`);
  }
  if (expectedStudioSha && !/^[0-9a-f]{40,64}$/.test(expectedStudioSha)) {
    die("merge_request: --expected-studio-sha must be a full lowercase commit SHA");
  }
  if (executionRoute === "artisan" && !expectedStudioSha) {
    die("merge_request: --execution-route artisan requires --expected-studio-sha <full-sha>");
  }
  const gitRoot = targetRoot || project;
  const roots = garelierControlRoots(project, gitRoot, pm);
  let guard: ReturnType<typeof acquireGarelierOperationGuard>;
  try { guard = acquireGarelierOperationGuard(roots, controlSession || `merge-request-${process.pid}`, "merge-request"); }
  catch (error) { die(`merge_request: ${(error as Error).message}`); }
  try {
  const controlSchema = guard.schema;
  if (controlSchema === 3) {
    if (!workId || !controlSession) die(`merge_request: schema v${controlSchema} requires --work-id W-N and --control-session <session_id>`);
    try {
      const binding = inspectDispatchControlBinding(roots, workId, controlSession, guard.lock);
      if (!binding.claim) die(`merge_request: schema-v${controlSchema} Work/Backlog ${workId} has no active dispatch claim`);
      if (binding.claim.session_id !== controlSession) die(`merge_request: schema-v${controlSchema} Work/Backlog ${workId} claim belongs to ${binding.claim.session_id}, not ${controlSession}`);
    } catch (error) {
      die(`merge_request: schema-v${controlSchema} Work/Backlog binding rejected: ${(error as Error).message}`);
    }
  } else if (controlSchema !== null) die(`merge_request: unsupported control schema_version ${controlSchema}; only schema_version 3 is accepted`);
  if (!guardian) die("merge_request: --guardian <verdict> is required ([guardian_policy] require_for_all_merges rejects requests without it)");
  guardian = normalizeVerdict("--guardian", guardian);
  if (observer) observer = normalizeVerdict("--observer", observer);
  if (refuterVerdict && refuterVerdict !== "UPHELD" && refuterVerdict !== "REFUTED") {
    die(`merge_request: --refuter-verdict must be UPHELD or REFUTED (got '${refuterVerdict}')`);
  }

  const config = resolveSetupConfig(project, pm);
  let qualityGateTimeoutMinutesPerCmd: number;
  try {
    qualityGateTimeoutMinutesPerCmd = loadConfig(project, pm).qualityGate.fullTimeoutMinutesPerCmd;
  } catch (error) {
    die(`merge_request: cannot resolve the project quality-gate timeout: ${(error as Error).message}`);
  }
  if (!Number.isSafeInteger(qualityGateTimeoutMinutesPerCmd) || qualityGateTimeoutMinutesPerCmd <= 0) {
    die(`merge_request: configured quality-gate timeout must be a positive integer number of minutes (got ${qualityGateTimeoutMinutesPerCmd})`);
  }
  if (!studio) {
    if (!existsSync(config)) die(`merge_request: no --studio and no ${config}`);
    studio = readTomlQuoted(config, "integration");
    if (!studio) die(`merge_request: [branches] integration not found in ${config}`);
  }
  if (!task) {
    const parts = branch.split("/");
    task = parts.length === 1 ? `${branch}-${branch}` : `${parts.at(-2) ?? ""}-${parts.at(-1) ?? ""}`;
  }
  const safeTask = task.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  const requestId = `${utcCompact()}-${randomUUID()}-${safeTask || "req"}`;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // W-180: gate_result_waiter.ts lives in this SAME directory (driver/src/scripts),
  // not `../../../scripts` (garelier-core/scripts) — the old resolve() emitted a
  // path with no file behind it, so a PM running the printed waiter_cmd verbatim hit
  // `Module not found` and the merge-completion push never armed (a stall class).
  // Emit the real sibling path and assert it exists, so a future relocation
  // fails HERE (submit time) instead of silently emitting a dead waiter_cmd.
  const scriptDir = moduleDir.replace(/\\/g, "/");
  const waiterScript = `${scriptDir}/gate_result_waiter.ts`;
  if (!existsSync(waiterScript)) {
    die(`merge_request: gate_result_waiter.ts not found at ${waiterScript} — the waiter_cmd would be a dead path (PM would hit Module not found). The script moved; update merge_request's scriptDir.`);
  }
  const waiterCommand = `bun "${waiterScript}" --project "${project}" --pm-id ${pm} --request-id ${requestId}`;

  if (!message) {
    const parts = branch.split("/");
    const branchTail = parts.length >= 3 ? parts.slice(-3).join("/") : branch;
    message = `merge ${task} into studio\n\nGuardian ${guardian}${observer ? `; Observer ${observer}` : ""}.\n\nGarelier: ${pm} merge ${branchTail}`;
  }
  const normalizeCommands = (commands: string[]): string[] => commands
    .map((command) => command.trim())
    .filter(Boolean);
  qualityGate.splice(0, qualityGate.length, ...normalizeCommands(qualityGate));
  if (!qualityGate.length) qualityGate.push(...normalizeCommands(readTomlStringArray(config, "merge_gate_commands")));
  if (!preflight.length) preflight.push(...readTomlStringArray(config, "preflight_commands"));

  // W-121: a request with no quality_gate_commands is one the merge gate rejects
  // ("request JSON has no quality_gate_commands") — but only at gate-run time,
  // one stage too late. Fail the submit HERE instead of writing an incomplete
  // request: the usual cause is an unresolved setup_config; surface that up
  // front.
  if (!qualityGate.length) {
    const why = existsSync(config)
      ? `no [merge_gate] merge_gate_commands in ${config}`
      : `setup_config not found at ${config}`;
    die(`merge_request: refusing to write an incomplete request — no quality_gate_commands (none via --quality-gate and ${why}). The merge gate would reject it at run time. Pass --quality-gate <cmd>… or fix the canonical config path (_crew/pm/).`);
  }

  const guardianRequireReport = readTomlScalar(config, "guardian_policy", "require_report") === "true";
  const observerRequireReport = readTomlScalar(config, "observer_policy", "require_report") === "true";
  if (guardianRequireReport && !guardianReport) {
    die(`merge_request: [guardian_policy] require_report = true but no --guardian-report <path> given — an asserted --guardian '${guardian}' cannot bind to a real Guardian review. Run Guardian and pass its report path.`);
  }
  if (observerRequireReport && observer && !observerReport) {
    die(`merge_request: [observer_policy] require_report = true but no --observer-report <path> given — an asserted --observer '${observer}' cannot bind to a real Observer review.`);
  }
  // A report path is authoritative evidence, not optional decoration. Validate
  // it before making the request visible to the async merge queue so malformed
  // headings, short SHAs, and CLI fallback strings cannot race into the gate.
  if (guardianReport) guardianReviewSha = validateCanonicalGateReport("Guardian", guardianReport, guardian, project);
  if (observerReport) {
    if (!observer) die("merge_request: --observer-report requires --observer <verdict>");
    observerReviewSha = validateCanonicalGateReport("Observer", observerReport, observer, project);
  }
  if (guardianReport && !guardianReviewSha) guardianReviewSha = fullBranchSha(gitRoot, branch);
  if (observerReport && !observerReviewSha) observerReviewSha = fullBranchSha(gitRoot, branch);
  if (controlSchema === 3) {
    for (const [role, reviewSha] of [["Guardian", guardianReviewSha], ["Observer", observerReviewSha]] as const) {
      if (reviewSha && !/^[0-9a-f]{40,64}$/.test(reviewSha)) die(`merge_request: ${role} review SHA must be a full lowercase commit SHA for Control v${controlSchema}`);
    }
  }
  const projectRoot = resolve(project).replace(/\\/g, "/");
  const branchTip = fullBranchSha(gitRoot, branch);
  if (!/^[0-9a-f]{40,64}$/.test(branchTip)) {
    die(`merge_request: cannot bind request to the exact workbench tip for '${branch}'`);
  }
  const normalizedConfig = resolve(config).replace(/\\/g, "/");
  const mergeGateConfig = existsSync(config)
    ? { path: normalizedConfig.startsWith(`${projectRoot}/`) ? normalizedConfig.slice(projectRoot.length + 1) : normalizedConfig, content_hash: sha256(readFileSync(config)) }
    : null;

  // The immutable request carries both canonical role-ref identity and an
  // explicit aftercare authority mode. Gate-held workbenches and satchels are
  // branch-only; ordinary dispatch roles must bind their exact container.
  const target = readTomlQuoted(config, "target");
  const targetSlug = readTomlQuoted(config, "target_slug") || target.replace(/\//g, "-");
  if (branch === target || branch === studio) die(`merge_request: protected target/studio ref cannot be queued as a role branch: ${branch}`);
  let branchIdentity: ReturnType<typeof roleBranchIdentity>;
  try { branchIdentity = roleBranchIdentity(branch, targetSlug, pm); }
  catch (error) { die(`merge_request: ${(error as Error).message}`); }
  if (dispatchId && !/^\d+$/.test(dispatchId)) die(`merge_request: --dispatch-id must be numeric (got '${dispatchId}')`);
  if (aftercareBinding && aftercareBinding !== "dispatch" && aftercareBinding !== "branch_only") {
    die(`merge_request: --aftercare-binding must be dispatch or branch_only (got '${aftercareBinding}')`);
  }
  const binding = (aftercareBinding || (executionRoute === "artisan" || branchIdentity.family === "satchel" ? "branch_only" : "dispatch")) as AftercareBinding;
  const branchDispatch = branchIdentity.family === "satchel" ? null : branchIdentity.numericId;
  if (dispatchId && branchDispatch !== dispatchId) {
    die(`merge_request: --dispatch-id ${dispatchId} does not match branch dispatch identity ${branchDispatch ?? "none"}`);
  }
  if (binding === "branch_only" && dispatchId) die("merge_request: branch_only aftercare cannot carry --dispatch-id");
  if (binding === "dispatch" && branchDispatch === null) die("merge_request: satchel role branches require branch_only aftercare");
  if (binding === "branch_only" && branchIdentity.family !== "satchel") {
    const inferredContainer = resolve(crewSubdir(project, pm, `dispatch${branchIdentity.numericId}`)).replace(/\\/g, "/");
    if (existsSync(inferredContainer)) {
      die(`merge_request: branch_only aftercare cannot discard a live dispatch/container binding: ${inferredContainer}`);
    }
  }
  const boundDispatchId = binding === "dispatch" ? branchDispatch : null;
  let dispatchContainer: string | null = null;
  let contextRoleBinding: RoleBindingReference | null = null;
  if (boundDispatchId !== null) {
    dispatchContainer = resolve(crewSubdir(project, pm, `dispatch${boundDispatchId}`)).replace(/\\/g, "/");
    if (!existsSync(dispatchContainer)) die(`merge_request: bound dispatch container is missing: ${dispatchContainer}`);
    try {
      const context = JSON.parse(readFileSync(`${dispatchContainer}/context.json`, "utf8")) as {
        task?: { id?: unknown; branch?: unknown };
      };
      const binding = JSON.parse(readFileSync(`${dispatchContainer}/control_binding.json`, "utf8")) as { dispatch_id?: unknown; work_id?: unknown; session_id?: unknown };
      if (String(context.task?.id ?? "") !== boundDispatchId || context.task?.branch !== branch) {
        die("merge_request: dispatch context task id/branch does not match the requested branch");
      }
      if (String(binding.dispatch_id ?? "") !== boundDispatchId) die("merge_request: control binding dispatch_id does not match the requested branch");
      if (workId && binding.work_id !== workId) die("merge_request: control binding work_id does not match --work-id");
      if (controlSession && binding.session_id !== controlSession) die("merge_request: control binding session_id does not match --control-session");
      const storedRoleBinding = roleBindingFromContext(context);
      if (storedRoleBinding !== undefined) {
        if (!storedRoleBinding || typeof storedRoleBinding !== "object" || Array.isArray(storedRoleBinding)) {
          die("merge_request: dispatch context role binding reference is malformed");
        }
        contextRoleBinding = storedRoleBinding;
        const expectedIdentity = contextRoleBinding.identity?.kind === "branch"
          ? roleExecutionIdentityForBranch(branch)
          : dispatchExecutionIdentity(boundDispatchId);
        if (canonicalJson(contextRoleBinding.identity) !== canonicalJson(expectedIdentity)) {
          die("merge_request: dispatch context role identity does not match the canonical requested branch/dispatch identity");
        }
      }
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      die(`merge_request: cannot verify bound dispatch context/control identity: ${(error as Error).message}`);
    }
  }
  const reportJson = dispatchContainer && existsSync(`${dispatchContainer}/report.json`)
    ? resolve(`${dispatchContainer}/report.json`).replace(/\\/g, "/")
    : null;
  if (!roleReport) die("merge_request: --report is required for role binding admission");
  const roleIdentity = boundDispatchId !== null
    ? contextRoleBinding?.identity ?? dispatchExecutionIdentity(boundDispatchId)
    : roleExecutionIdentityForBranch(branch);
  let roleBinding: RoleBindingReference;
  let roleClose: RoleCloseReference;
  try {
    const admission = closeRoleAdmission({
      project_root: project, pm_id: pm, identity: roleIdentity,
      candidate_sha: branchTip, report_path: roleReport,
      ledger_path: dispatchContainer ? `${dispatchContainer}/instructions.md` : resolve(dirname(roleReport), "instructions.md"),
      request_id: requestId,
    });
    roleBinding = admission.reference;
    roleClose = admission.close;
  } catch (error) {
    die(`merge_request: role binding admission refused: ${(error as Error).message}`);
  }
  if (contextRoleBinding && canonicalJson(roleBinding) !== canonicalJson(contextRoleBinding)) {
    die("merge_request: closed role binding does not match the dispatch context binding reference");
  }

  // W-346 FR5: merge-request-submit chokepoint. While a closure lease holds
  // this studio lineage, an ordinary submit is refused up front — enqueueing
  // would change the closed queue's composition (FR7), and the gate/poll
  // guards would refuse it anyway. Smith/recovery successors are published
  // through the closure reservation protocol (integration_closure.ts
  // `publishSuccessorRequest`), never through this CLI; a future origin
  // constructor carrying `closure_intent` passes via its origin digest.
  // Pass-through whenever no closure state exists (all current traffic).
  {
    const closureVerdict = assertChokepointAllowed(resolve(project).replace(/\\/g, "/"), pm, studio, { requestKind: "ordinary" });
    if (!closureVerdict.allowed) {
      die(`merge_request: ${closureVerdict.reason} — resubmit after the closure lease closes (W-346 FR5/FR7)`);
    }
  }

  const requestsDir = `${project}/__garelier/${pm}/runtime/merge_gate/requests`;
  mkdirSync(requestsDir, { recursive: true });
  const requestFile = `${requestsDir}/${requestId}.json`;
  writeFileSync(requestFile, requestJson({
    requestId, branch, branchTip, studio, gitRoot, task, guardian, guardianReport, guardianReviewSha,
    guardianRequireReport, observer, observerReport, observerReviewSha, observerRequireReport,
    refuterVerdict, refuterReport, highStakes, preflight, qualityGate, qualityGateTimeoutMinutesPerCmd, message,
    executionRoute, expectedStudioSha,
    controlSchema, workId, controlSession, report: roleReport, projectRoot,
    dispatchId: boundDispatchId, dispatchContainer, aftercareBinding: binding, reportJson,
    mergeGateConfig,
    roleBinding,
    roleClose,
  }), { encoding: "utf8", flag: "wx" });
  process.stderr.write(`merge_request: wrote ${requestFile}\n`);
  if (notify) {
    process.stderr.write("merge_request: --notify — run this in the background to be pushed the gate result:\n");
    process.stderr.write(`  bun ${scriptDir}/gate_result_waiter.ts --project ${project} --pm-id ${pm} --request-id ${requestId}\n`);
  }
  if (noPoll) {
    // W-180: build the object and JSON.stringify it (the poll branch below already
    // does) instead of hand-splicing with only `"` escaped — a Windows `--project`
    // path inside waiter_cmd carries backslashes that made the emitted line invalid
    // JSON, so a PM/tool could not even parse waiter_cmd to run it.
    process.stdout.write(`${JSON.stringify({ request_id: requestId, request_file: requestFile, polled: false, waiter_cmd: waiterCommand })}\n`);
    return 0;
  }

  core ||= resolve(moduleDir, "../../..");
  const poll = run(["bun", `${core}/driver/src/dispatch/dock_merge.ts`, "poll", "--pm-id", pm, "--project", project], { stderr: "inherit" });
  const pollOut = poll.stdout.replace(/[\r\n]+$/, "");
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(pollOut) as Record<string, unknown>; } catch { /* preserve raw output */ }
  const spawned = typeof parsed?.spawned === "string" ? parsed.spawned : "";
  const active = parsed?.active && typeof parsed.active === "object" ? parsed.active as Record<string, unknown> : null;
  const activeId = typeof active?.request_id === "string" ? active.request_id : "";
  if (spawned === requestId) {
    process.stderr.write(`merge_request: gate started immediately for ${requestId}.\n`);
  } else if (spawned) {
    process.stderr.write(`merge_request: gate started for ${spawned}; ${requestId} is queued and will be processed automatically when the active gate completes (self-drain, W-039).\n`);
  } else if (activeId) {
    process.stderr.write(`merge_request: ${requestId} queued behind active gate ${activeId}; it will be processed automatically when that gate completes (self-drain, W-039).\n`);
  } else {
    process.stderr.write(`merge_request: ${requestId} submitted; no gate spawned (already resolved or queue empty). Run 'dock_merge.ts poll' if this is unexpected.\n`);
  }
  if (parsed) {
    parsed.waiter_cmd = waiterCommand;
    process.stdout.write(`${JSON.stringify(parsed)}\n`);
  } else {
    process.stdout.write(`${pollOut}\n`);
  }
  return poll.exitCode;
  } finally { guard.release(); }
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch (error) { process.exit(error instanceof CliFailure ? error.exitCode : 1); }
}
