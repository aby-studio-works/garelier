#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { crewSubdir } from "../workspace.ts";
import { die, emitJsonLine, git, valueAfter } from "./_lib.ts";
import { parseCommitPlans } from "./lane_commit_plan.ts";

const HELP = `#
# dispatch_prepare_lane_commit_plan.ts — proxy-commit a managed Codex dispatch.
#
# Consumes the same COMMIT PLAN block format as lane_commit_plan.ts, but resolves
# the managed dispatch<N>/checkout and authoritative seat provenance from its
# context.json instead of an isolate-lane dispatch record.
#
# Usage:
#   dispatch_prepare_lane_commit_plan.ts --project <root> --pm-id <id> --id <N>
#       [--result <codex_last_message.md>] [--dry-run]
`;

interface Args { project: string; pm: string; id: string; result: string; dryRun: boolean; }

function parse(argv: string[]): Args {
  const args: Args = { project: "", pm: "", id: "", result: "", dryRun: false };
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": args.project = valueAfter(argv, i); i += 2; break;
      case "--pm-id": args.pm = valueAfter(argv, i); i += 2; break;
      case "--id": args.id = valueAfter(argv, i); i += 2; break;
      case "--result": args.result = valueAfter(argv, i); i += 2; break;
      case "--dry-run": args.dryRun = true; i++; break;
      case "-h": case "--help": process.stdout.write(HELP); process.exit(0);
      default: die(`dispatch_prepare_lane_commit_plan: unknown arg: ${argv[i]}`);
    }
  }
  return args;
}

function safeRelativeFile(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    die(`dispatch_prepare_lane_commit_plan: unsafe file path in COMMIT PLAN: ${path}`);
  }
  return normalized;
}

function authoritativeMessage(message: string, pm: string, role: string, id: string, model: string): string {
  const withoutSeat = message.replace(/^Garelier-Seat:.*(?:\r?\n|$)/gm, "").trimEnd();
  const trailer = withoutSeat.match(new RegExp(`^Garelier:\\s+${pm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#${id}\\s+\\S+`, "m"));
  if (!trailer || withoutSeat.includes("{{TASK_ID}}")) {
    die(`dispatch_prepare_lane_commit_plan: COMMIT PLAN message must contain a resolved 'Garelier: ${pm} ${role}#${id} <TASK_ID>' trailer`);
  }
  return `${withoutSeat}\n\nGarelier-Seat: codex ${model || "config-default"} (proxy-commit via dock seat)`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parse(argv);
  if (!args.project || !args.pm || !args.id) die("dispatch_prepare_lane_commit_plan: --project, --pm-id, and --id are required");
  if (!/^\d+$/.test(args.id)) die(`dispatch_prepare_lane_commit_plan: --id must be numeric: ${args.id}`);

  const container = crewSubdir(args.project, args.pm, `_dispatch${args.id}`);
  const worktree = resolve(container, "checkout");
  const contextPath = resolve(container, "context.json");
  const resultPath = args.result || resolve(container, "codex_last_message.md");
  if (!existsSync(worktree)) die(`dispatch_prepare_lane_commit_plan: checkout not found: ${worktree}`);
  if (!existsSync(contextPath)) die(`dispatch_prepare_lane_commit_plan: context not found: ${contextPath}`);
  if (!existsSync(resultPath)) die(`dispatch_prepare_lane_commit_plan: result not found: ${resultPath}`);

  let context: Record<string, any>;
  try { context = JSON.parse(readFileSync(contextPath, "utf8")); }
  catch { die(`dispatch_prepare_lane_commit_plan: invalid context JSON: ${contextPath}`); }
  if (context.routing?.commit_mode !== "proxy") die(`dispatch_prepare_lane_commit_plan: dispatch #${args.id} is not proxy mode`);
  const role = String(context.task?.role ?? "");
  const model = String(context.routing?.model ?? "");
  const expectedBranch = String(context.task?.branch ?? "");
  const actualBranch = git(worktree, ["branch", "--show-current"]).stdout.trim();
  if (!role || !expectedBranch || actualBranch !== expectedBranch) {
    die(`dispatch_prepare_lane_commit_plan: checkout/context mismatch (expected branch '${expectedBranch}', actual '${actualBranch}', role '${role}')`);
  }

  const plans = parseCommitPlans(readFileSync(resultPath, "utf8"));
  if (plans.length === 0) die(`dispatch_prepare_lane_commit_plan: no COMMIT PLAN block found in ${resultPath}`, 2);
  const plannedFiles = [...new Set(plans.flatMap((plan) => plan.files.map(safeRelativeFile)))].sort();
  const trackedChanges = git(worktree, ["-c", "core.quotePath=false", "diff", "--name-only", "HEAD", "--"]).stdout.split(/\r?\n/).filter(Boolean);
  const untrackedChanges = git(worktree, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "--"]).stdout.split(/\r?\n/).filter(Boolean);
  const actualFiles = [...new Set([...trackedChanges, ...untrackedChanges].map((path) => path.replace(/\\/g, "/")))].sort();
  if (plannedFiles.join("\n") !== actualFiles.join("\n")) {
    die(`dispatch_prepare_lane_commit_plan: COMMIT PLAN files do not match the actual worktree diff (planned=${plannedFiles.join(",") || "none"}; actual=${actualFiles.join(",") || "none"})`);
  }
  const committed: Array<{ files: number; subject: string; sha: string }> = [];
  for (const [index, plan] of plans.entries()) {
    if (plan.files.length === 0) die(`dispatch_prepare_lane_commit_plan: COMMIT PLAN #${index + 1} lists no files`, 2);
    const files = plan.files.map(safeRelativeFile);
    const subject = plan.message.split("\n")[0]?.trim() ?? "";
    if (!subject || !subject.endsWith(`[#${args.id}]`)) die(`dispatch_prepare_lane_commit_plan: COMMIT PLAN #${index + 1} subject must end with [#${args.id}]`, 2);
    const message = authoritativeMessage(plan.message, args.pm, role, args.id, model);
    if (args.dryRun) {
      process.stdout.write(`--- COMMIT PLAN #${index + 1} (dry-run) ---\nfiles: ${files.join(", ")}\nmessage:\n${message}\n`);
      committed.push({ files: files.length, subject, sha: "(dry-run)" });
      continue;
    }
    const add = git(worktree, ["add", "--", ...files]);
    if (add.exitCode !== 0) die(`dispatch_prepare_lane_commit_plan: git add failed for plan #${index + 1}: ${add.stderr.trim()}`, 1);
    const commit = git(worktree, ["commit", "-m", message]);
    if (commit.exitCode !== 0) die(`dispatch_prepare_lane_commit_plan: git commit failed for plan #${index + 1}: ${commit.stderr.trim() || commit.stdout.trim()}`, 1);
    const sha = git(worktree, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    committed.push({ files: files.length, subject, sha });
  }

  emitJsonLine({ id: Number(args.id), worktree, plans: plans.length, dry_run: args.dryRun, committed });
  return 0;
}

if (import.meta.main) process.exit(await main());
