import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  die,
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

const HELP = `#
# merge_request.sh — one-command merge-gate request (DEC-064 §1).
#
# Derives everything the merge gate's request JSON needs from existing
# artifacts, so the Dock never hand-assembles it (the two live-failure
# classes — missing verdicts, empty merge_message — become impossible):
#   studio branch   ← setup_config.toml [branches] integration (or --studio)
#   request_id      ← UTC timestamp + task label
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
# this prints the exact \`gate_result_waiter.sh\` command for THIS request on stderr
# — the PM runs it via run_in_background and gets pushed the outcome when the gate
# terminates (the harness re-wakes on background completion). Default (no flag) is
# unchanged: driver mode's poll loop already drives the result, so no waiter is
# needed there.
#
# Usage:
#   merge_request.sh --project <control-root> --pm-id <id> --branch <workbench-branch>
#                    --guardian <PASS|PASS_WITH_NOTES> [--observer <verdict>]
#                    [--task <label>] [--message <msg>] [--studio <branch>]
#                    [--preflight <cmd>]... [--quality-gate <cmd>]...
#                    [--target-root <git-root>] [--core <garelier-core-dir>]
#                    [--refuter-verdict <UPHELD|REFUTED>] [--refuter-report <path>] [--high-stakes]
#                    [--notify] [--no-poll]
#
# Refuter (W-066): the opt-in adversarial-verify layer on top of the Observer
# verdict, for HIGH-STAKES merges only. --refuter-verdict carries an independent
# refuter agent's UPHELD/REFUTED (a REFUTED holds the merge for PM escalation;
# see merge-gate.sh). --high-stakes marks a merge high-stakes for a semantic
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

function shortBranchSha(root: string, branch: string): string {
  const result = git(root, ["rev-parse", "--short", branch]);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

function requestJson(fields: {
  requestId: string; branch: string; studio: string; gitRoot: string; task: string;
  guardian: string; guardianReport: string; guardianReviewSha: string; guardianRequireReport: boolean;
  observer: string; observerReport: string; observerReviewSha: string; observerRequireReport: boolean;
  refuterVerdict: string; refuterReport: string; highStakes: boolean;
  preflight: string[]; qualityGate: string[]; message: string;
}): string {
  const q = (value: string): string => `"${jsonEscape(value)}"`;
  const lines = [
    "{",
    `  "request_id": ${q(fields.requestId)},`,
    `  "workbench_branch": ${q(fields.branch)},`,
    `  "studio_branch": ${q(fields.studio)},`,
    `  "target_root": ${q(fields.gitRoot)},`,
    `  "task_id": ${q(fields.task)},`,
    '  "agent": "merge_request.sh",',
    `  "guardian_verdict": ${q(fields.guardian)},`,
  ];
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
  lines.push(`  "merge_message": ${q(fields.message)}`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let project = "", targetRoot = "", pm = "", branch = "", task = "";
  let guardian = "", observer = "", message = "", studio = "", core = "";
  let guardianReport = "", observerReport = "", guardianReviewSha = "", observerReviewSha = "";
  let refuterVerdict = "", refuterReport = "";
  let highStakes = false, notify = false, noPoll = false;
  const qualityGate: string[] = [];
  const preflight: string[] = [];
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": project = valueAfter(argv, i); i += 2; break;
      case "--target-root": targetRoot = valueAfter(argv, i); i += 2; break;
      case "--pm-id": pm = valueAfter(argv, i); i += 2; break;
      case "--branch": branch = valueAfter(argv, i); i += 2; break;
      case "--task": task = valueAfter(argv, i); i += 2; break;
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
        die(`merge_request: unknown arg: ${argv[i]}\nmerge_request: valid flags: --project --target-root --pm-id --branch --task --guardian --observer --guardian-report --observer-report --guardian-review-sha --observer-review-sha --message --studio --core --quality-gate --preflight --refuter-verdict --refuter-report --high-stakes --notify --no-poll -h/--help`);
    }
  }
  if (!project || !pm || !branch) die("merge_request: --project, --pm-id, --branch are required");
  const gitRoot = targetRoot || project;
  if (!guardian) die("merge_request: --guardian <verdict> is required ([guardian_policy] require_for_all_merges rejects requests without it)");
  guardian = normalizeVerdict("--guardian", guardian);
  if (observer) observer = normalizeVerdict("--observer", observer);
  if (refuterVerdict && refuterVerdict !== "UPHELD" && refuterVerdict !== "REFUTED") {
    die(`merge_request: --refuter-verdict must be UPHELD or REFUTED (got '${refuterVerdict}')`);
  }

  const config = `${project}/__garelier/${pm}/_pm/setup_config.toml`;
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
  const requestId = `${utcCompact()}-${safeTask || "req"}`;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const scriptDir = resolve(moduleDir, "../../../scripts").replace(/\\/g, "/");
  const waiterCommand = `bash "${scriptDir}/gate_result_waiter.sh" --project "${project}" --pm-id ${pm} --request-id ${requestId}`;

  if (!message) {
    const parts = branch.split("/");
    const branchTail = parts.length >= 3 ? parts.slice(-3).join("/") : branch;
    message = `merge ${task} into studio\n\nGuardian ${guardian}${observer ? `; Observer ${observer}` : ""}.\n\nGarelier: ${pm} merge ${branchTail}`;
  }
  if (!qualityGate.length) qualityGate.push(...readTomlStringArray(config, "merge_gate_commands"));
  if (!preflight.length) preflight.push(...readTomlStringArray(config, "preflight_commands"));

  const guardianRequireReport = readTomlScalar(config, "guardian_policy", "require_report") === "true";
  const observerRequireReport = readTomlScalar(config, "observer_policy", "require_report") === "true";
  if (guardianRequireReport && !guardianReport) {
    die(`merge_request: [guardian_policy] require_report = true but no --guardian-report <path> given — an asserted --guardian '${guardian}' cannot bind to a real Guardian review. Run Guardian and pass its report path.`);
  }
  if (observerRequireReport && observer && !observerReport) {
    die(`merge_request: [observer_policy] require_report = true but no --observer-report <path> given — an asserted --observer '${observer}' cannot bind to a real Observer review.`);
  }
  if (guardianReport && !guardianReviewSha) guardianReviewSha = shortBranchSha(gitRoot, branch);
  if (observerReport && !observerReviewSha) observerReviewSha = shortBranchSha(gitRoot, branch);

  const requestsDir = `${project}/__garelier/${pm}/runtime/merge_gate/requests`;
  mkdirSync(requestsDir, { recursive: true });
  const requestFile = `${requestsDir}/${requestId}.json`;
  writeFileSync(requestFile, requestJson({
    requestId, branch, studio, gitRoot, task, guardian, guardianReport, guardianReviewSha,
    guardianRequireReport, observer, observerReport, observerReviewSha, observerRequireReport,
    refuterVerdict, refuterReport, highStakes, preflight, qualityGate, message,
  }));
  process.stderr.write(`merge_request: wrote ${requestFile}\n`);
  if (notify) {
    process.stderr.write("merge_request: --notify — run this in the background to be pushed the gate result:\n");
    process.stderr.write(`  bash ${scriptDir}/gate_result_waiter.sh --project ${project} --pm-id ${pm} --request-id ${requestId}\n`);
  }
  if (noPoll) {
    const waiterForNoPoll = waiterCommand.replace(/"/g, '\\"');
    process.stdout.write(`{"request_id":"${requestId}","request_file":"${requestFile}","polled":false,"waiter_cmd":"${waiterForNoPoll}"}\n`);
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
}

if (import.meta.main) process.exit(await main());
