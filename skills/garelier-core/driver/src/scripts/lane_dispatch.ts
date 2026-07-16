#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { die, emitJsonLine, git, utcIsoSeconds, valueAfter } from "./_lib.ts";
import {
  codexProducerContract,
  commitTrailer,
  laneInstructionsPath,
  lanePromptPath,
  laneRecordPath,
  posix,
  validateSlug,
  writeRecord,
  type DispatchRecord,
} from "./lane_common.ts";

const HELP = `#
# lane_dispatch.sh — one-command isolate-lane dispatch (W-095 (a)).
#
# Mechanizes what the PM otherwise hand-builds for every DEC-093 PM-direct /
# isolate lane: cut the isolated worktree (via workspace_isolate, WITH an owner
# lock), synthesize the producer prompt (common contract + row reference + scope
# fence + verification steps + commit/register convention), create the lane-local
# instruction ledger, write a dispatch record, and print either a codex launch
# command or the Claude Agent prompt path — as ONE JSON line.
#
# Usage:
#   lane_dispatch.sh --repo <path> --slug <kebab> --row <ITEM-ID> --pm-id <id>
#                    --owner <agent-name> [--base <branch>]
#                    [--producer codex|claude] [--model <name>]
#                    [--title <one-line>] [--task-file <path>]
#                    [--scope <fence-text>] [--scope-file <path>]
#                    [--verify <command>]
#
# --owner is the agent that will hold the lane; it is recorded in the lane meta
# so a second producer assignment is refused (with the owner named) BEFORE spawn.
# --producer codex emits a launch_cmd (dispatch_codex_producer.sh); claude emits
# the prompt_file to hand the Agent tool. The instruction ledger is where the PM
# appends later scope changes (append-only) instead of racing SendMessage.
#
# Emits one JSON line: {worktree, branch, base_sha, prompt_file, instructions_file,
#   record_file, producer, launch_cmd?}. Exit 2 on usage error; passes through
# workspace_isolate's exit (incl. the owner-collision refusal).`;

function err(line: string): void { process.stderr.write(`${line}\n`); }

interface Args {
  repo: string; slug: string; row: string; pm: string; owner: string; base: string;
  producer: string; model: string; title: string; taskFile: string;
  scope: string; scopeFile: string; verify: string;
}

function parse(argv: string[]): Args {
  const a: Args = {
    repo: "", slug: "", row: "", pm: "", owner: "", base: "",
    producer: "claude", model: "", title: "", taskFile: "", scope: "", scopeFile: "", verify: "",
  };
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--repo": a.repo = valueAfter(argv, i); i += 2; break;
      case "--slug": a.slug = valueAfter(argv, i); i += 2; break;
      case "--row": a.row = valueAfter(argv, i); i += 2; break;
      case "--pm-id": a.pm = valueAfter(argv, i); i += 2; break;
      case "--owner": a.owner = valueAfter(argv, i); i += 2; break;
      case "--base": a.base = valueAfter(argv, i); i += 2; break;
      case "--producer": a.producer = valueAfter(argv, i); i += 2; break;
      case "--model": a.model = valueAfter(argv, i); i += 2; break;
      case "--title": a.title = valueAfter(argv, i); i += 2; break;
      case "--task-file": a.taskFile = valueAfter(argv, i); i += 2; break;
      case "--scope": a.scope = valueAfter(argv, i); i += 2; break;
      case "--scope-file": a.scopeFile = valueAfter(argv, i); i += 2; break;
      case "--verify": a.verify = valueAfter(argv, i); i += 2; break;
      case "-h": case "--help": process.stdout.write(`${HELP}\n`); process.exit(0);
      default: die(`lane_dispatch: unknown arg: ${argv[i]}\nlane_dispatch: see --help for valid flags`);
    }
  }
  return a;
}

function readText(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }

function synthPrompt(a: Args, worktree: string, branch: string, baseSha: string, instructionsPath: string, verifyCmd: string, trailer: string): string {
  const scope = a.scope || (a.scopeFile ? readText(a.scopeFile) : "");
  const task = a.taskFile ? readText(a.taskFile) : (a.title || "(see backlog row for the task)");
  const lines = [
    `You are the producer for Garelier isolate lane '${a.slug}' (row ${a.row}), PM ${a.pm}.`,
    "",
    `## Task`,
    task,
    "",
    `## Where to work`,
    `- Work ONLY inside your worktree: ${worktree} (branch ${branch}, off ${baseSha}).`,
    `- NEVER edit the parent repo / primary checkout or touch its git index (add/commit/stash/checkout) outside your worktree. git READ commands anywhere are fine.`,
  ];
  if (scope.trim()) {
    lines.push("", "## Scope fence", scope.trim());
  }
  lines.push(
    "",
    "## Verify before reporting",
    `- Run the canonical lane verification and paste its VERBATIM summary into your report:`,
    `    ${verifyCmd}`,
    `- Do not claim green without the runner's own summary — a hand-assembled pass is a false-green (the class this toolkit exists to kill).`,
    "",
    "## Commit + register",
  );
  if (a.producer === "codex") {
    lines.push(codexProducerContract({
      worktree,
      branch,
      baseSha,
      subjectSuffix: `[${a.row}]`,
      trailer,
    }));
  } else {
    lines.push(
      `- Each commit subject ends with [${a.row}]; end the message with a blank line then this trailer VERBATIM:`,
      `    ${trailer}`,
      `- Explain WHY in the body; never paste diffs.`,
    );
  }
  lines.push(
    `- Instruction ledger (append-only): BEFORE reporting, read ${instructionsPath} and satisfy EVERY entry the PM appended; state "ledger N/N consumed" in your register.`,
    `- Register-terminate: your LAST turn MUST end with the compact register (final state, branch + commit SHA (or COMMIT PLAN if proxy), verify result, any BLOCKED question).`,
  );
  return `${lines.join("\n")}\n`;
}

function instructionLedger(slug: string, row: string): string {
  return `# Instruction ledger — isolate/${slug} (${row})\n\n` +
    `<!-- W-095 (a): the PM appends ONE entry per added instruction here\n` +
    `     (\`- [ ] I<n> <one line> [-> pointer]\`) instead of racing SendMessage; the\n` +
    `     producer checks off EVERY entry (\`- [x] … (consumed: <sha|register>)\`) BEFORE\n` +
    `     reporting and states "ledger N/N consumed". Never rewrite prior entries. -->\n\n` +
    `(no instructions yet)\n`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parse(argv);
  a.repo = posix(a.repo);
  if (!a.repo || !a.slug || !a.row || !a.pm) die("lane_dispatch: --repo, --slug, --row, --pm-id are required");
  if (!a.owner) die("lane_dispatch: --owner (the holding agent name) is required — it is the lane lock that prevents a second producer collision");
  try { validateSlug(a.slug); } catch (e) { die(`lane_dispatch: ${(e as Error).message}`); }
  if (a.producer !== "codex" && a.producer !== "claude") die(`lane_dispatch: --producer must be codex|claude (got '${a.producer}')`);
  if (git(a.repo, ["rev-parse", "--show-toplevel"]).exitCode !== 0) die(`lane_dispatch: --repo is not a git repository: ${a.repo}`);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const isolateTs = resolve(moduleDir, "workspace_isolate.ts");
  const coreScripts = resolve(moduleDir, "../../../scripts");

  // Cut the isolated worktree WITH the owner lock. Pass workspace_isolate's
  // stdout/stderr through: on a collision it now names the owner (W-095 (d)).
  const isoArgs = [isolateTs, "--repo", a.repo, "--slug", a.slug, "--pm-id", a.pm, "--owner", a.owner];
  if (a.base) isoArgs.push("--base", a.base);
  const iso = Bun.spawnSync(["bun", ...isoArgs], { stdout: "pipe", stderr: "inherit" });
  if (iso.exitCode !== 0) return iso.exitCode;
  const isoOut = iso.stdout?.toString() ?? "";
  let parsed: { worktree: string; branch: string; base_sha: string };
  try { parsed = JSON.parse(isoOut.trim().split("\n").pop() ?? ""); } catch { die(`lane_dispatch: could not parse workspace_isolate output: ${isoOut}`, 1); }
  const { worktree, branch, base_sha } = parsed;

  const instructionsPath = laneInstructionsPath(a.repo, a.slug, a.pm, false);
  if (!existsSync(instructionsPath)) writeFileSync(instructionsPath, instructionLedger(a.slug, a.row));

  const verifyShim = resolve(coreScripts, "lane_verify.sh").replace(/\\/g, "/");
  const verifyCmd = a.verify || `bash "${verifyShim}" --repo "${a.repo}" --slug "${a.slug}" --pm-id "${a.pm}"`;
  const trailer = commitTrailer(a.pm, a.slug, a.row);

  const promptPath = lanePromptPath(a.repo, a.slug, a.pm, false);
  writeFileSync(promptPath, synthPrompt(a, worktree, branch, base_sha, instructionsPath, verifyCmd, trailer));

  const record: DispatchRecord = {
    slug: a.slug, row: a.row, pm_id: a.pm, producer: a.producer, model: a.model,
    branch, worktree, base: a.base, base_sha, owner: a.owner,
    commit_trailer: trailer, created: utcIsoSeconds(),
  };
  writeRecord(a.repo, a.slug, a.pm, record);

  let launchCmd = "";
  if (a.producer === "codex") {
    const codexShim = resolve(coreScripts, "dispatch_codex_producer.sh").replace(/\\/g, "/");
    const resultPath = `${dirname(promptPath)}/${a.slug}.result.md`;
    launchCmd = `bash "${codexShim}" --worktree "${worktree}" --project "${a.repo}" --prompt "${promptPath}" --result "${resultPath}"`;
    if (a.model) launchCmd += ` --model "${a.model}"`;
    err("lane_dispatch: codex producer — launch ONLY via the emitted launch_cmd; a raw 'codex exec' lacks --add-dir grants.");
    err(`lane_dispatch: after codex writes its result, proxy-commit its COMMIT PLAN with: bash "${resolve(coreScripts, "lane_commit_plan.sh").replace(/\\/g, "/")}" --repo "${a.repo}" --slug "${a.slug}" --pm-id "${a.pm}" --result "${resultPath}"`);
  } else {
    err(`lane_dispatch: claude producer — hand the Agent tool the prompt at ${promptPath} (name it after --owner '${a.owner}').`);
  }

  emitJsonLine({
    worktree, branch, base_sha,
    prompt_file: promptPath, instructions_file: instructionsPath, record_file: laneRecordPath(a.repo, a.slug, a.pm, false),
    producer: a.producer, verify_cmd: verifyCmd, commit_trailer: trailer,
    ...(launchCmd ? { launch_cmd: launchCmd } : {}),
  });
  return 0;
}

if (import.meta.main) process.exit(await main());
