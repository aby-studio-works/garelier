#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crewSubdir } from "../workspace.ts";
import { emitJsonLine, git, run, utcIsoSeconds } from "./_lib.ts";
import { codexProducerContract } from "./lane_common.ts";

const HELP = `#
# dispatch_prepare.sh — zero-LLM role-dispatch scaffolding (DEC-063 Part A).
#
# Does the mechanical bookkeeping a dispatch Dock otherwise hand-builds
# (and a mid-tier model gets wrong): atomically claims the next task id, cuts an
# ISOLATED worktree off the integration branch on the role's branch family, and
# prints {id, container, checkout, branch, base_sha, context} as one JSON line for
# the dispatched role prompt. It also writes a forward-supply fact-pack (context.json,
# DEC-081 Piece 1) and an advisory pickup_pack.json (W-017) into the container so
# the dispatched role does not re-derive project facts (gate command, target_slug,
# branch names, base sha) in its cold worktree.
# Never touches an in-flight persistent role container. Dispatch containers are
# \`_crew/dispatch<id>/\` on layout v2 and legacy \`_dispatch<id>/\` otherwise,
# with the worktree at checkout/.
#
# Usage:
#   dispatch_prepare.sh --project <control-root> --pm-id <id> --role <worker|smith|librarian|artisan>
#                       --slug <kebab-slug> [--base <integration-branch>] [--blueprint <path>]
#                       [--pipeline-package PP-N] [--target-root <git-root>]
#                       [--model M] [--effort E] [--scope MARKER] [--tags CSV] [--rework]
#                       [--producer codex|claude] [--task-file <path>]
#                         # default claude; --task-file is explicit-codex only;
#                         # legacy external-model auto-route retained
#                       [--touches '<glob>,<glob>'] [--depends-on '<slug|#id>,...'] [--allow-conflict]
#                       [--resource-class <heavy|light|data|review>] [--runtime-effect <none|headless|visual|aural|input>]
#                       [--full-gate]
#
# --resource-class / --runtime-effect (W-087) are the engine-aware assignment
# fields: resource_class=heavy routes the dispatch through the machine-wide heavy
# scheduler gate (one full-workspace compile at a time on the RAM-bound box);
# runtime_effect tells the close-contract check which RUN evidence to demand (a
# visual task needs a screenshot / user-verdict pointer). Omitting a field defaults
# to light/none WITH a warning — declare both on new dispatches.
#
# QUOTE glob-valued flags with SINGLE quotes (W-054): --touches 'docs/**'. If the
# value (e.g. docs/**) is left unquoted, the invoking shell expands it against the
# cwd into multiple words BEFORE this script sees them, so the extra path words
# arrive as stray positionals and fail arg parsing ("unknown arg: docs/engine").
# This script's own expansions are all quoted; the fix is at the call site.
#
# --touches / --depends-on are declared conflict/dependency metadata (W-053):`;

function out(line: string): void { process.stdout.write(`${line}\n`); }
function err(line: string): void { process.stderr.write(`${line}\n`); }
function fail(message: string, code = 2): never { err(message); process.exit(code); }
function valueAfter(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value === "") fail(`dispatch_prepare: missing value for ${argv[index]}`, 1);
  return value;
}
function text(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }
function readQuoted(path: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text(path).match(new RegExp(`^\\s*${escaped}\\s*=\\s*"(.*)".*$`, "m"))?.[1] ?? "";
}
function spawnCaptured(command: string[], stderr: "pipe" | "ignore" = "pipe") {
  return Bun.spawnSync(command, { stdin: "inherit", stdout: "pipe", stderr });
}
function capturedText(value: Uint8Array | undefined): string { return value?.toString() ?? ""; }
function runQuiet(command: string[]): { code: number; stdout: string } {
  const child = spawnCaptured(command, "ignore");
  return { code: child.exitCode, stdout: capturedText(child.stdout).trim() };
}
function runToStderr(command: string[]): number {
  const child = spawnCaptured(command, "pipe");
  process.stderr.write(capturedText(child.stdout));
  process.stderr.write(capturedText(child.stderr));
  return child.exitCode;
}
function sanitizeAgentName(value: string): string {
  let result = value.replace(/[^A-Za-z0-9_-]/g, "-");
  if (!/^[A-Za-z0-9]/.test(result)) result = `a${result}`;
  return result.slice(0, 64);
}
function isExternalSeatModel(value: string): boolean { return value.includes("codex") || /gpt-5\.\d/.test(value); }
function posixish(path: string): string { return path.replace(/\\/g, "/"); }

interface Parsed {
  project: string; targetRoot: string; pm: string; role: string; slug: string; base: string;
  blueprint: string; pipelinePackage: string; inModel: string; inEffort: string; inScope: string;
  inTags: string; inTouches: string; inDepends: string; inCommitMode: string;
  inResourceClass: string; inRuntimeEffect: string; producer: string; taskFile: string;
  allowConflict: boolean; fullGate: boolean; rework: boolean; force: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const p: Parsed = {
    project: "", targetRoot: "", pm: "", role: "", slug: "", base: "", blueprint: "",
    pipelinePackage: "", inModel: "", inEffort: "", inScope: "", inTags: "", inTouches: "",
    inDepends: "", inCommitMode: "", inResourceClass: "", inRuntimeEffect: "", producer: "",
    taskFile: "",
    allowConflict: false, fullGate: false, rework: false, force: false,
  };
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": p.project = valueAfter(argv, i); i += 2; break;
      case "--target-root": p.targetRoot = valueAfter(argv, i); i += 2; break;
      case "--pm-id": p.pm = valueAfter(argv, i); i += 2; break;
      case "--role": p.role = valueAfter(argv, i); i += 2; break;
      case "--slug": p.slug = valueAfter(argv, i); i += 2; break;
      case "--base": p.base = valueAfter(argv, i); i += 2; break;
      case "--blueprint": p.blueprint = valueAfter(argv, i); i += 2; break;
      case "--pipeline-package": p.pipelinePackage = valueAfter(argv, i); i += 2; break;
      case "--model": p.inModel = valueAfter(argv, i); i += 2; break;
      case "--effort": p.inEffort = valueAfter(argv, i); i += 2; break;
      case "--scope": p.inScope = valueAfter(argv, i); i += 2; break;
      case "--tags": p.inTags = valueAfter(argv, i); i += 2; break;
      case "--touches": p.inTouches = valueAfter(argv, i); i += 2; break;
      case "--depends-on": p.inDepends = valueAfter(argv, i); i += 2; break;
      case "--commit-mode": p.inCommitMode = valueAfter(argv, i); i += 2; break;
      case "--resource-class": p.inResourceClass = valueAfter(argv, i); i += 2; break;
      case "--runtime-effect": p.inRuntimeEffect = valueAfter(argv, i); i += 2; break;
      case "--producer": p.producer = valueAfter(argv, i); i += 2; break;
      case "--task-file": p.taskFile = valueAfter(argv, i); i += 2; break;
      case "--allow-conflict": p.allowConflict = true; i++; break;
      case "--full-gate": p.fullGate = true; i++; break;
      case "--rework": p.rework = true; i++; break;
      case "--force": p.force = true; i++; break;
      case "-h": case "--help": out(HELP); process.exit(0);
      default:
        err(`dispatch_prepare: unknown arg: ${argv[i]}`);
        if (existsSync(argv[i])) err(`dispatch_prepare: hint: '${argv[i]}' is an existing path — a glob-valued flag was almost certainly left UNQUOTED, so the shell expanded it into multiple words before this script ran (e.g. --touches docs/** became --touches docs/main docs/engine …). Single-quote the value so no pathname expansion happens: --touches 'docs/**' (same for --depends-on). See W-054.`);
        fail("dispatch_prepare: valid flags: --project --target-root --pm-id --role --slug --base --blueprint --pipeline-package --producer --task-file --model --effort --commit-mode --resource-class --runtime-effect --scope --tags --touches --depends-on --allow-conflict --full-gate --rework --force -h/--help");
    }
  }
  return p;
}

function duplicateDispatch(dispatchRoot: string, prefix: string, slug: string): { name: string; state: string } | undefined {
  let names: string[] = [];
  try { names = readdirSync(dispatchRoot).filter((name) => name.startsWith(prefix)).sort(); } catch { return undefined; }
  for (const name of names) {
    const statePath = resolve(dispatchRoot, name, "STATE.md");
    if (!existsSync(statePath)) continue;
    const raw = text(statePath);
    const task = raw.match(/^##\s*Current task\s*$[\s\S]*?^\s*\S+\s+(\S+)/m)?.[1] ?? "";
    if (task !== slug) continue;
    const state = raw.match(/^##\s*Status\s*$[\s\S]*?^\s*(\S+)/m)?.[1]?.replace(/\s/g, "") ?? "?";
    return { name, state };
  }
  return undefined;
}

async function claimId(project: string, pm: string): Promise<string> {
  const idFile = `${project}/__garelier/${pm}/runtime/backlog/next_id`;
  mkdirSync(dirname(idFile), { recursive: true });
  const lock = `${idFile}.lock`;
  let acquired = false;
  for (let tries = 0; tries < 50; tries++) {
    try { mkdirSync(lock); acquired = true; break; } catch { await Bun.sleep(100); }
  }
  if (!acquired) {
    err(`dispatch_prepare: could not lock ${lock} after 5s`);
    err(`  if a prior run was killed the lock may be stranded; inspect ${lock}/owner,`);
    fail(`  and if its pid is not alive recover with: rm -rf "${lock}"`, 1);
  }
  const release = (): void => { try { rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    try { writeFileSync(`${lock}/owner`, `{"pid": ${process.pid}, "ts": "${utcIsoSeconds()}", "kind": "next_id"}\n`); } catch { /* best effort */ }
    if (!existsSync(idFile)) writeFileSync(idFile, "1\n");
    const id = text(idFile).replace(/[^0-9]/g, "");
    if (!id) fail(`dispatch_prepare: ${idFile} is not a number`, 1);
    writeFileSync(idFile, `${Number(id) + 1}\n`);
    return id;
  } finally { release(); }
}

function reportScaffold(id: string, slug: string, role: string, branch: string, baseSha: string): string {
  return `# Report - #${id} ${slug} (${role})\n\n` +
    `- Branch: ${branch}\n- Base SHA: ${baseSha}\n\n` +
    `<!-- Register-canonical (W-019): if the harness blocks writing this file, your compact\n` +
    `     register message IS the canonical record - the PM transcribes it here at cleanup via\n` +
    `     \`dispatch_cleanup.sh --report-from-file <path>\`. Do not stall completion on this write. -->\n\n` +
    `## Status\n\n(REPORTING | BLOCKED)\n\n` +
    `## Summary\n\n(what changed and why - compact; reference paths/SHAs, never paste diffs)\n\n` +
    `## Gates\n\n(commands run + results)\n\n` +
    `## Evidence\n\n(red->green proof, measurements, writer-audit conclusions)\n\n` +
    `## Context pack gaps\n\n(facts you had to rediscover that the assignment/blueprint should have carried - exact paths, invariants, verify commands; "none" when the context pack sufficed - DEC-071)\n`;
}

function instructionLedger(id: string, slug: string): string {
  return `# Instruction ledger - #${id} ${slug}\n\n` +
    `<!-- W-092 - guards the "PM scope-change crosses the dispatched role's completion register" class.\n` +
    `     PM: append ONE entry per added instruction (\`- [ ] I<n> <one line> [-> pointer]\`); never rewrite prior entries.\n` +
    `     Dispatched role: BEFORE REPORTING, check off EVERY entry -> \`- [x] I<n> …\` + append \`(consumed: <sha|register>)\`.\n` +
    `     Do NOT reach REPORTING while any entry is \`- [ ]\`; state "ledger N/N consumed" in your register.\n` +
    `     W-041 - instructions can ALSO arrive as teammate MESSAGES (SendMessage), which do NOT land in this\n` +
    `     file by themselves. Dispatched role: on receiving a message-borne instruction, APPEND it here yourself\n` +
    `     (\`- [ ] M<n> <one line> (via message)\`) BEFORE acting, then check it off like any entry - so the\n` +
    `     ledger stays the single audit surface and the PM never mistakes a consumed message for a dropped one. -->\n\n` +
    `(no instructions yet - the PM appends \`- [ ] I<n> …\` entries here as scope changes)\n`;
}

function routing(project: string, pm: string, seat: string, extras: string[]): Record<string, any> | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const path = resolve(moduleDir, "../dispatch/model_routing.ts");
  const r = runQuiet(["bun", path, "--project", project, "--pm-id", pm, "--seat", seat, ...extras]);
  if (r.code !== 0) return undefined;
  try { return JSON.parse(r.stdout); } catch { return undefined; }
}

function commitRule(commitMode: string, id: string, pm: string, role: string, model: string): string {
  if (commitMode === "proxy") return `- Commit (PROXY mode — W-042): you CANNOT run git add / git commit / git stash in this worktree (the sandbox denies writes to its gitdir; .git here is a pointer into the parent repo's protected .git/worktrees/). NEVER attempt them. Instead, at each commit-worthy milestone write a COMMIT PLAN into your report: the exact file list + the full commit message (subject ends with [#${id}]; blank line; then this trailer VERBATIM, replacing {{TASK_ID}} with the bound backlog id, e.g. W-123):
    Garelier: ${pm} ${role}#${id} {{TASK_ID}}
    Garelier-Seat: codex ${model} (proxy-commit via dock seat)
  BOTH trailer lines are mandatory — the Garelier-Seat line is the provenance marker so the Dock/reviewers always see the commit is codex-produced and proxy-committed: the git committer is the dock-seat occupant (often the PM sitting in the Dock seat), NOT the author of the change. Explain WHY in the body; never paste diffs. git READ commands (status/log/diff) are fine.
  Dock-side duties on a proxy commit (guardian W-042): (1) BEFORE committing, diff the worktree's ACTUAL changed files against the dispatch's declared --touches scope and reconcile any out-of-scope path — refuse or escalate (never commit blind) on hooks-adjacent / CI-workflow / .gitattributes / .gitignore / validator files not covered by the declared scope; (2) the Dock writes the Garelier-Seat trailer FROM THE DISPATCH JSON (commit_mode/model), overwriting the plan's line if they disagree — the dispatched role's trailer text is advisory, the dispatch record is authoritative; (3) AFTER committing (guardian round-2 N1), the Dock self-checks with 'bun skills/garelier-core/scripts/lint_commits.ts --last --require-seat-trailer <checkout>' — a non-zero exit means the trailer it just wrote is missing/malformed; fix it (amend or a follow-up commit) before reporting the commit onward. merge_land.sh also re-checks this at land time from context.json's commit_mode, so a forgotten self-check is still caught, but do not rely on that as your check.`;
  return `- Commit: the subject ends with [#${id}]; end the message with a blank line then this trailer VERBATIM, replacing {{TASK_ID}} with the bound backlog id (e.g. W-123):
    Garelier: ${pm} ${role}#${id} {{TASK_ID}}
  Explain WHY the change is needed; never paste diffs.`;
}

function promptPreamble(p: Parsed, id: string, branch: string, baseSha: string, container: string, commitMode: string, model: string, producer: string, resultPath = ""): string {
  const baseTrack = commitMode === "proxy"
    ? `- Branch: ${branch}. Base-track is handled by the DOCK SEAT at proxy-commit time (W-072): the sandbox denies gitdir writes, so 'git merge' here dies at ORIG_HEAD.lock — do NOT attempt it and do NOT stall on it. If you notice the studio tip moved past your base (${baseSha}) while working, note it in your report; the Dock seat merges and resolves conflicts before the gate.`
    : `- Branch: ${branch}. At pickup, base-track FIRST: merge the studio tip into your branch (merge, never rebase) and resolve any conflicts yourself before implementing.`;
  const terminate = commitMode === "proxy"
    ? "- Register-terminate (W-085): your LAST turn MUST end with the compact register message (final STATE, branch + commit plan submitted (Dock commits — PROXY mode, no SHA yet), report path, gate result, any BLOCKED question) - a commit-plan/STATE update alone is not a completion signal."
    : "- Register-terminate (W-085): your LAST turn MUST end with the compact register message (final STATE, branch + commit SHA, report path, gate result, any BLOCKED question) - a commit/STATE update alone is not a completion signal.";
  const runtimeRecovery = producer === "codex" && commitMode === "proxy"
    ? "- Runtime recovery: include one `GARELIER_RUNTIME_STATUS: {\"runtime_ok\": true|false, ...}` marker immediately BEFORE the final COMMIT PLAN block; `=== END COMMIT PLAN ===` remains the result's final line."
    : "- Runtime recovery: the final line of every subagent final output MUST be exactly one `GARELIER_RUNTIME_STATUS: {\"runtime_ok\": true|false, ...}` marker.";
  const commitContract = producer === "codex" && commitMode === "proxy"
    ? codexProducerContract({
      worktree: `${container}/checkout`,
      branch,
      baseSha,
      subjectSuffix: `[#${id}]`,
      trailer: `Garelier: ${p.pm} ${p.role}#${id} {{TASK_ID}}`,
      seatTrailer: `Garelier-Seat: codex ${model || "config-default"} (proxy-commit via dock seat)`,
    })
    : `${baseTrack}\n${commitRule(commitMode, id, p.pm, p.role, model)}`;
  const resultContract = resultPath
    ? `\n- Result/report contract: your final response is captured at ${resultPath}. Treat that container-local path as the canonical Codex result.`
    : "";
  return `You are the Garelier ${p.role} for dispatch #${id} (${p.slug}).
- Work ONLY inside your checkout worktree: ${container}/checkout - never edit the parent repo / primary checkout.
${commitContract}${resultContract}
- Instruction ledger (W-092): before REPORTING, open instructions.md and check off EVERY entry ("- [ ]" -> "- [x] ... (consumed: <sha|register>)"); do NOT reach REPORTING while any entry is unchecked. State "ledger N/N consumed" in your register.
${terminate}
- Heavy discipline: run a long gate (compile/test/headless) as ONE chained script under run_in_background - the completion notification auto-resumes you; NEVER end a turn on a foreground long-run (the harness kills it at the timeout ceiling and the turn falls silent). A heavy full-workspace compile still serializes via the operator's heavy_compile_lock; send ONE interim progress message during a long build.
- Background wake (W-078): when you end a turn with a job in run_in_background, your NEXT turn MUST begin by READING that job's output/log file - the completion wake can fail to arrive, and sitting idle after the job already finished is a stall (harness known issue). You may end AT MOST ONE turn with no report while a background job runs; never end a second consecutive unreported turn - if unsure whether it finished, read the log rather than waiting. Deliver your final register as an actual completion message (your dispatcher reads your last output), never a plain-text sign-off that omits the register fields.
${runtimeRecovery}
- After a timeout, do not immediately re-run the same command; inspect the incident/log first and change the execution plan (scope, log file, or background watch).
- End EVERY turn one of two ways: (a) the compact register, or (b) a progress message WITH a background job still running. Falling silent at a milestone (commit, compile start, report) is a stall and a violation.
- Instructions may arrive as teammate MESSAGES mid-flight (W-041): append each to the container instructions.md ledger yourself (- [ ] M<n> ... (via message)) BEFORE acting, check it off when consumed, and count them in your register (ledger N/N + messages M/M consumed).
- Output control (output_control.md): your final response and every progress message use the compressed register - no greeting/thanks/request-echo/self-narration, fragments fine; durable detail goes in report.md/STATE.md NOT the response; an id/SHA/path reference replaces re-explaining it. NEVER shorten code symbols, paths, commands, error text, numbers, SHAs, or risks/blockers/warnings. The register-terminate rule above is still mandatory - compressed does not mean omitted.
- Do NOT push any branch; the operator integrates it through the merge gate.`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const p = parseArgs(argv);
  if (!p.project || !p.pm || !p.role || !p.slug) fail("dispatch_prepare: --project, --pm-id, --role, --slug are required");
  if (p.producer && p.producer !== "codex" && p.producer !== "claude") fail(`dispatch_prepare: --producer must be codex|claude (got '${p.producer}')`);
  if (p.producer === "codex" && p.inCommitMode && p.inCommitMode !== "proxy") fail("dispatch_prepare: --producer codex requires proxy commit mode; omit --commit-mode or use --commit-mode proxy");
  if (p.taskFile && p.producer !== "codex") fail("dispatch_prepare: --task-file requires --producer codex");
  let taskBody = "";
  if (p.taskFile) {
    try { taskBody = readFileSync(p.taskFile, "utf8"); }
    catch { fail(`dispatch_prepare: --task-file is not readable: ${p.taskFile}`); }
  }
  const gitRoot = p.targetRoot || p.project;
  const pmRoot = `${p.project}/__garelier/${p.pm}`;
  const pmContainer = crewSubdir(p.project, p.pm, "_pm");
  const dispatch0 = crewSubdir(p.project, p.pm, "_dispatch0");
  const dispatchRoot = dirname(dispatch0);
  const dispatchPrefix = basename(dispatch0).replace(/0$/, "");
  const dispatchContainer = (id: string): string => crewSubdir(p.project, p.pm, `_dispatch${id}`);
  if (!/^[a-z0-9-]+$/.test(p.slug)) fail("dispatch_prepare: --slug must be kebab-case [a-z0-9-]");

  const family: Record<string, string> = { worker: "workbench", smith: "anvil", librarian: "shelf", artisan: "satchel" };
  if (["scout", "observer", "guardian"].includes(p.role)) fail(`dispatch_prepare: ${p.role} is read-only under dispatch — no worktree needed (role_subagent_dispatch.md §2)`);
  if (!family[p.role]) fail(`dispatch_prepare: unknown role: ${p.role} (worker|smith|librarian|artisan)`);

  const config = `${pmContainer}/setup_config.toml`;
  if (!p.base) {
    if (!existsSync(config)) fail(`dispatch_prepare: no --base and no ${config}`);
    p.base = readQuoted(config, "integration");
    if (!p.base) fail(`dispatch_prepare: [branches] integration not found in ${config}`);
  }
  const targetBranch = existsSync(config) ? readQuoted(config, "target") : "";
  if (p.pipelinePackage && p.role === "artisan" && !targetBranch) fail(`dispatch_prepare: [branches] target not found in ${config}`);
  if (!p.base.endsWith("/studio")) fail(`dispatch_prepare: integration branch must end in /studio: ${p.base}`);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const driverSrc = resolve(moduleDir, "..");
  const coreScripts = resolve(moduleDir, "../../../scripts");
  const pipelineArgs = targetBranch ? ["--target-branch", targetBranch] : [];
  if (p.pipelinePackage) {
    if (!p.blueprint) fail("dispatch_prepare: --pipeline-package requires --blueprint");
    const rc = run(["bun", resolve(driverSrc, "pipeline_packages.ts"), "render-assignment", "--blueprint", p.blueprint, "--package", p.pipelinePackage, "--role", p.role, "--task-id", "0", "--agent-id", `${p.role}(#0)`, "--pm-id", p.pm, "--slug", p.slug, ...pipelineArgs, "--base-branch", p.base, "--config", config], { stdout: "ignore", stderr: "inherit" });
    if (rc.exitCode !== 0) fail(`dispatch_prepare: invalid pipeline package ${p.pipelinePackage} for role ${p.role}`, 1);
  }
  if (p.blueprint && existsSync(p.blueprint)) {
    const bp = text(p.blueprint);
    if (/^##\s+Review sign-off\s*$/m.test(bp) && !/^[-*]?\s*Verdict:\s*(PASS|PASS_WITH_NOTES|REWORK_RECOMMENDED|BLOCK|NO_OPINION)\b/m.test(bp)) {
      err(`dispatch_prepare: WARNING — blueprint '${p.blueprint}' declares a '## Review sign-off' footer (DEC-076 high-stakes) but records no design-review Verdict. Route it through Wanderer->Observer and fill the sign-off before dispatch (W-067). Proceeding (advisory).`);
    }
  }

  run(["bun", resolve(moduleDir, "dispatch_cleanup.ts"), "--project", p.project, "--pm-id", p.pm, "--target-root", gitRoot, "--sweep"], { stdout: "ignore", stderr: "ignore" });
  if (!p.force) {
    const duplicate = duplicateDispatch(dispatchRoot, dispatchPrefix, p.slug);
    if (duplicate) fail(`dispatch_prepare: slug '${p.slug}' already has an in-flight dispatch (${duplicate.name}, state ${duplicate.state || "?"}) — producing another would silently duplicate it. Gate or dispatch_cleanup that one first (it is the same work), or pass --force for a deliberate parallel.`);
  }

  const id = await claimId(p.project, p.pm);
  const container = dispatchContainer(id);
  if (existsSync(container)) fail(`dispatch_prepare: container already exists: ${container}`, 1);
  const branch = `${p.base.slice(0, -"studio".length)}${family[p.role]}/#${id}/${p.slug}`;
  mkdirSync(container, { recursive: true });
  const addRc = runToStderr(["git", "-C", gitRoot, "worktree", "add", `${container}/checkout`, "-b", branch, p.base]);
  if (addRc !== 0) return addRc;
  const baseSha = gitOut(gitRoot, ["rev-parse", "--short", p.base]);
  writeFileSync(`${container}/STATE.md`, `# Dispatch #${id} - ${p.role} ${p.slug}\n\n## Status\n\nWORKING\n\n## Current task\n\n#${id} ${p.slug} (${branch})\n`);
  writeFileSync(`${container}/report.md`, reportScaffold(id, p.slug, p.role, branch, baseSha));
  writeFileSync(`${container}/instructions.md`, instructionLedger(id, p.slug));
  const taskLabel = `#${id} ${p.slug} dispatched${p.pipelinePackage ? ` [${p.pipelinePackage}]` : ""}`;
  const eventRc = runToStderr(["bash", resolve(coreScripts, "dispatch_event.sh"), "--project", p.project, "--pm-id", p.pm, "--kind", "start", "--role", `${p.role}(#${id})`, "--task", taskLabel]);
  if (eventRc !== 0) return eventRc;

  let model = "", effort = "", modelSource = "", suggestedModel = "", needsConfirmation = false;
  let pmModel = process.env.GARELIER_PM_MODEL ?? "";
  if (!pmModel && existsSync(config)) pmModel = readQuoted(config, "pm_model") || readQuoted(config, "default_agent_model");
  const routeExtras: string[] = [];
  if (p.blueprint) routeExtras.push("--blueprint", p.blueprint);
  if (p.inModel) routeExtras.push("--model", p.inModel);
  if (p.inEffort) routeExtras.push("--effort", p.inEffort);
  if (p.inScope) routeExtras.push("--scope", p.inScope);
  if (p.inTags) routeExtras.push("--tags", p.inTags);
  if (p.rework) routeExtras.push("--rework");
  if (pmModel) routeExtras.push("--pm-model", pmModel);
  const route = routing(p.project, p.pm, p.role, routeExtras);
  if (route) {
    model = String(route.model ?? ""); effort = String(route.effort ?? ""); modelSource = String(route.source ?? "");
    suggestedModel = String(route.suggested_model ?? ""); needsConfirmation = route.needs_confirmation === true;
    if (needsConfirmation) err(`dispatch_prepare: routing suggests '${suggestedModel}' above the PM model (above_pm=ask); dispatched at the safe '${model}' — an attended PM confirms before using the suggestion.`);
  } else err("dispatch_prepare: model routing best-effort skipped (bun/model_routing unavailable)");
  if (isExternalSeatModel(p.inModel)) { model = p.inModel; modelSource = "external_seat"; needsConfirmation = false; }
  if (p.producer === "codex") {
    model = p.inModel;
    effort = p.inEffort;
    modelSource = model ? "explicit_codex_producer" : "codex_config_default";
    needsConfirmation = false;
  }

  // Backward compatibility: before --producer existed, external-seat model
  // names mechanically selected Codex. An explicit flag wins; otherwise retain
  // that route, with ordinary/default model routing remaining Claude.
  const producer = p.producer || (isExternalSeatModel(model) ? "codex" : "claude");

  let commitMode = "self";
  if (producer === "codex") {
    commitMode = p.inCommitMode || process.env.GARELIER_EXTERNAL_SEAT_COMMIT || "proxy";
    if (commitMode !== "self" && commitMode !== "proxy") {
      err(`dispatch_prepare: unknown commit-mode '${commitMode}' — failing closed to proxy for the codex seat`);
      commitMode = "proxy";
    }
  }

  let context = `${container}/context.json`;
  const ctxArgs = ["--config", config, "--pm-id", p.pm, "--project", gitRoot, "--integration", p.base, "--task-id", id, "--role", p.role, "--slug", p.slug, "--branch", branch, "--base-sha", baseSha, "--commit-mode", commitMode, "--out", context];
  if (p.blueprint) ctxArgs.push("--blueprint", p.blueprint);
  if (model) ctxArgs.push("--model", model);
  if (effort) ctxArgs.push("--effort", effort);
  if (modelSource) ctxArgs.push("--model-source", modelSource);
  if (p.inTouches) ctxArgs.push("--touches", p.inTouches);
  if (p.inDepends) ctxArgs.push("--depends-on", p.inDepends);
  if (p.inResourceClass) ctxArgs.push("--resource-class", p.inResourceClass);
  if (p.inRuntimeEffect) ctxArgs.push("--runtime-effect", p.inRuntimeEffect);
  if (p.fullGate) ctxArgs.push("--full-gate");
  if (run(["bun", resolve(driverSrc, "context_pack.ts"), ...ctxArgs], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    err("dispatch_prepare: context.json best-effort skipped (bun/context_pack unavailable)"); context = "";
  }

  if (p.pipelinePackage) {
    let targetSlug = "";
    if (p.base.startsWith("garelier/")) targetSlug = p.base.slice("garelier/".length).split("/")[0];
    const args = ["bun", resolve(driverSrc, "pipeline_packages.ts"), "render-assignment", "--blueprint", p.blueprint, "--package", p.pipelinePackage, "--role", p.role, "--task-id", id, "--agent-id", `${p.role}(#${id})`, "--pm-id", p.pm, "--target-slug", targetSlug, ...pipelineArgs, "--slug", p.slug, "--branch", branch, "--base-branch", p.base, "--base-sha", baseSha, "--config", config, "--out", `${container}/assignment.md`];
    if (run(args, { stdout: "inherit", stderr: "inherit" }).exitCode !== 0) fail(`dispatch_prepare: failed to render assignment for ${p.pipelinePackage}`, 1);
  }

  let pickup = `${container}/pickup_pack.json`;
  if (existsSync(`${container}/assignment.md`)) {
    let roleIndex = `${p.project}/__garelier/__atmos/knowledge/role_index.toml`;
    if (!existsSync(roleIndex)) roleIndex = `${p.project}/__garelier/${p.pm}/knowledge/role_index.toml`;
    const pickupArgs = ["--role", p.role, "--assignment", `${container}/assignment.md`, "--out", pickup];
    if (context) pickupArgs.push("--context", context);
    if (existsSync(roleIndex)) pickupArgs.push("--role-index", roleIndex);
    if (run(["bun", resolve(driverSrc, "role_pickup_pack.ts"), ...pickupArgs], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
      err("dispatch_prepare: pickup_pack.json best-effort skipped (bun/role_pickup_pack unavailable)"); pickup = "";
    }
  } else pickup = "";

  const agentName = sanitizeAgentName(`ga-${p.role}-${p.slug}`);
  const guardianName = sanitizeAgentName(`ga-guardian-${p.slug}`);
  const observerName = sanitizeAgentName(`ga-observer-${p.slug}`);
  let guardianModel = "", observerModel = "";
  for (const seat of ["guardian", "observer"]) {
    const gateRoute = routing(p.project, p.pm, seat, pmModel ? ["--pm-model", pmModel] : []);
    const gateModel = String(gateRoute?.model ?? "");
    if (seat === "guardian") guardianModel = gateModel; else observerModel = gateModel;
  }
  const gateTemplate = "skills/garelier-core/templates/gate_verdict.md";
  const commitTemplate = `<type>(<scope>): <summary>  [#${id}]\n\nGarelier: ${p.pm} ${p.role}#${id} #${id}`;
  const bugFixDiscipline = "bug fix discipline: observe -> hypothesize -> verify -> fix the confirmed root cause only; reproduction test RED->GREEN first (instrumentation-log before/after when a test is impossible, e.g. visual/GPU); no guess fix / symptom-silencing guard / shotgun fix. Full rule: garelier-core/references/debugging_discipline.md (W-052).";

  let conflictCheck: any = { touches: [], depends_on: [], conflicts: [], unmet_deps: [], warning: "" };
  if (p.inTouches || p.inDepends) {
    const ccArgs = ["check", "--pm-root", pmRoot, "--self", id];
    if (p.inTouches) ccArgs.push("--touches", p.inTouches);
    if (p.inDepends) ccArgs.push("--depends-on", p.inDepends);
    const cc = runQuiet(["bun", resolve(driverSrc, "dispatch/conflict_check.ts"), ...ccArgs]);
    try {
      if (cc.code === 0 && cc.stdout) conflictCheck = JSON.parse(cc.stdout);
      else throw new Error();
      if (conflictCheck.warning && !p.allowConflict) err(`dispatch_prepare: [conflict_check] ${conflictCheck.warning}`);
    } catch { err("dispatch_prepare: conflict_check best-effort skipped (bun/conflict_check unavailable)"); }
  }

  const watchScript = posixish(resolve(coreScripts, "dispatch_watch.sh"));
  let watchCmd = `bash "${watchScript}" --project "${p.project}" --pm-id ${p.pm} --id ${id} --target-root "${gitRoot}"`;
  let launchCmd = "";
  let promptPath = "", codexResult = "";
  if (producer === "codex" && p.taskFile) {
    const laneDir = `${container}/lane`;
    promptPath = `${laneDir}/prompt.md`;
    codexResult = `${laneDir}/result.md`;
    mkdirSync(laneDir, { recursive: true });
    watchCmd = `while [ ! -s "${codexResult}" ]; do sleep 30; done`;
  }
  const preamble = promptPreamble(p, id, branch, baseSha, container, commitMode, model, producer, codexResult);
  if (promptPath) {
    writeFileSync(promptPath, `${preamble.trimEnd()}\n\n## Task\n\n${taskBody.trimEnd()}\n`);
    const codexScript = posixish(resolve(coreScripts, "dispatch_codex_producer.sh"));
    launchCmd = `bash "${codexScript}" --worktree "${container}/checkout" --project "${p.project}" --prompt "${promptPath}" --result "${codexResult}"`;
    if (model) launchCmd += ` --model "${model}"`;
    if (effort) launchCmd += ` --effort "${effort}"`;
    if (p.targetRoot && gitRoot !== p.project) launchCmd += ` --target-root "${gitRoot}"`;
    err("dispatch_prepare: codex seat — launch ONLY via the emitted launch_cmd (dispatch_codex_producer.sh); a raw 'codex exec' lacks --add-dir grants and dies with 1312 in a dispatch worktree");
  }
  const spawnDirective = producer === "codex"
    ? (launchCmd
      ? `Codex producer: run ONLY the emitted launch_cmd synchronously; do not use the Agent tool.`
      : `Codex producer: launch_cmd is intentionally empty because --task-file was omitted; use the existing manual handoff path.`)
    : model
    ? `Agent tool call for this dispatch MUST set model=${model} and name=${agentName} explicitly - omitting model silently inherits the PARENT PM session's model instead of this resolved routing decision (source=${modelSource}). See workflow-naming.md section 5 for the name convention.`
    : `model resolved to inherit (empty, source=${modelSource}) - the Agent tool call still needs name=${agentName} explicitly; passing no model here is correct, but confirm that is intentional before spawning.`;
  const proxyResult = codexResult || `${container}/codex_last_message.md`;
  const proxyCommitCmd = producer === "codex" && commitMode === "proxy"
    ? `bash "${posixish(resolve(coreScripts, "dispatch_prepare_lane_commit_plan.sh"))}" --project "${p.project}" --pm-id "${p.pm}" --id "${id}" --result "${proxyResult}"`
    : "";

  const w071Ids: string[] = [];
  for (const tag of p.inTags.replace(/,/g, " ").split(/\s+/).filter(Boolean)) if (/^W-\d+/.test(tag)) w071Ids.push(tag);
  const slugMatch = p.slug.match(/^w(\d+)/);
  const slugId = slugMatch ? `W-${slugMatch[1]}` : "";
  if (slugId && !w071Ids.includes(slugId)) w071Ids.push(slugId);
  let stalePremise = "";
  for (const item of w071Ids) {
    const r = git(gitRoot, ["log", "--grep", `\\[${item}\\]`, "--grep", `${item} `, "--oneline", "-5", p.base, "--"]);
    const hits = r.exitCode === 0 ? r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 5).join(";") : "";
    if (hits) stalePremise += `${item} already appears in ${p.base} history — verify the row is not stale before launching: ${hits}; `;
  }
  if (stalePremise) err(`dispatch_prepare: [stale_premise] ${stalePremise}-- read the commits (git log --grep '<id>') and the row's acceptance before launching; abandon + cleanup if the work already landed (W-071).`);

  emitJsonLine({
    id: Number(id), container, checkout: `${container}/checkout`, branch, base_sha: baseSha,
    target_root: gitRoot, context, pickup_pack: pickup, label: `${p.role}:${p.slug}`, name: `${p.role}(#${id})`,
    agent_name: agentName, model, effort, model_source: modelSource, suggested_model: suggestedModel,
    spawn_directive: spawnDirective, producer, commit_mode: commitMode, needs_confirmation: needsConfirmation,
    commit_template: commitTemplate, bug_fix_discipline: bugFixDiscipline,
    launch_cmd: launchCmd, watch_cmd: watchCmd, prompt_file: promptPath, result_file: codexResult,
    proxy_commit_cmd: proxyCommitCmd, prompt_preamble: preamble, stale_premise_warning: stalePremise, conflict_check: conflictCheck,
    gate_agents: {
      guardian: { name: guardianName, model: guardianModel, report: `runtime/guardian/results/${p.slug}-guardian.md`, verdict_template: gateTemplate },
      observer: { name: observerName, model: observerModel, report: `runtime/observer/results/${p.slug}-observer.md`, verdict_template: gateTemplate },
    },
  });
  return 0;
}

function gitOut(root: string, args: string[]): string {
  const r = git(root, args); return r.exitCode === 0 ? r.stdout.trim() : "";
}

if (import.meta.main) process.exit(await main());
