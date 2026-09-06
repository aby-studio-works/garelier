#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { crewSubdir } from "../workspace.ts";
import {
  dispatchExecutionIdentity,
  readCurrentRoleAuthorization,
  roleBindingFromContext,
  transcribeCodexRegisterConsumption,
} from "../dispatch/role_binding.ts";
import { die, emitJsonLine, git, valueAfter } from "./_lib.ts";
import { parseCommitPlans } from "./lane_commit_plan.ts";
import { bindReviewSha, inspectDeclaredReviewShas, resolveReviewResultPath } from "./bind_review_sha.ts";

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

function authoritativeMessage(
  message: string,
  pm: string,
  role: string,
  id: string,
  model: string,
): string {
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

  const container = crewSubdir(args.project, args.pm, `dispatch${args.id}`);
  const worktree = resolve(container, "checkout");
  const contextPath = resolve(container, "context.json");
  let resultPath = "";
  try {
    resultPath = resolveReviewResultPath(container, args.result || resolve(container, "codex_last_message.md"));
  } catch (error) {
    die(`dispatch_prepare_lane_commit_plan: ${(error as Error).message}`);
  }
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

  const resultText = readFileSync(resultPath, "utf8");
  const plans = parseCommitPlans(resultText);
  if (plans.length === 0) die(`dispatch_prepare_lane_commit_plan: no COMMIT PLAN block found in ${resultPath}`, 2);
  const identity = dispatchExecutionIdentity(args.id);
  // Only Codex-dispatched roles are fenced out of their container-owned ledger. Other
  // roles must record consumption in that ledger themselves, so their
  // register text is not a transcription input. The bound provider, rather than
  // advisory context routing, decides this admission behavior.
  const provider = readCurrentRoleAuthorization({
    project_root: args.project, pm_id: args.pm, identity,
  }).core.routing.provider;
  const plannedFiles = [...new Set(plans.flatMap((plan) => plan.files.map(safeRelativeFile)))].sort();
  const trackedChanges = git(worktree, ["-c", "core.quotePath=false", "diff", "--name-only", "HEAD", "--"]).stdout.split(/\r?\n/).filter(Boolean);
  const untrackedChanges = git(worktree, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "--"]).stdout.split(/\r?\n/).filter(Boolean);
  let actualFiles = [...new Set([...trackedChanges, ...untrackedChanges].map((path) => path.replace(/\\/g, "/")))].sort();
  // Preserve the historical post-parse rejection order for dirty lanes: a bad
  // plan must be rejected before unrelated/missing SHA metadata can obscure the
  // exact problem or trigger ledger transcription. A clean lane is resolved
  // against base..HEAD below so a producer-owned commit can be admitted.
  if (actualFiles.length > 0 && plannedFiles.join("\n") !== actualFiles.join("\n")) {
    die(`dispatch_prepare_lane_commit_plan: COMMIT PLAN files do not match the actual worktree diff (planned=${plannedFiles.join(",") || "none"}; actual=${actualFiles.join(",") || "none"})`);
  }
  const acceptedPlans = plans.map((plan, index) => {
    if (plan.files.length === 0) die(`dispatch_prepare_lane_commit_plan: COMMIT PLAN #${index + 1} lists no files`, 2);
    const files = plan.files.map(safeRelativeFile);
    const subject = plan.message.split("\n")[0]?.trim() ?? "";
    if (!subject || !subject.endsWith(`[#${args.id}]`)) die(`dispatch_prepare_lane_commit_plan: COMMIT PLAN #${index + 1} subject must end with [#${args.id}]`, 2);
    const message = authoritativeMessage(plan.message, args.pm, role, args.id, model);
    return { files, subject, message };
  });
  const baseRef = String(context.task?.base_sha ?? "");
  const base = git(worktree, ["rev-parse", "--verify", `${baseRef}^{commit}`]).stdout.trim();
  const review = git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(review) || !/^[0-9a-f]{40}$/.test(base)) {
    die("dispatch_prepare_lane_commit_plan: review/base SHA could not be resolved for proxy admission");
  }
  const precommitted = actualFiles.length === 0 && review !== base;
  if (precommitted) {
    if (plans.length !== 1) die("dispatch_prepare_lane_commit_plan: a clean producer-committed lane requires exactly one COMMIT PLAN");
    const headMessage = git(worktree, ["log", "-1", "--format=%B", "HEAD"]).stdout;
    if (/^Garelier-Seat:\s+.*\(proxy-commit via dock seat\)\s*$/m.test(headMessage)) {
      die("dispatch_prepare_lane_commit_plan: clean lane HEAD is already a Dock proxy commit; refusing duplicate proxy admission");
    }
    authoritativeMessage(headMessage, args.pm, role, args.id, model);
    const diff = git(worktree, ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", `${base}..${review}`, "--"]);
    if (diff.exitCode !== 0) die(`dispatch_prepare_lane_commit_plan: cannot enumerate producer-committed files: ${diff.stderr.trim()}`);
    actualFiles = [...new Set(diff.stdout.split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/")))].sort();
  }
  // PV-1 (GDN-003): admission accepts a DECLARED final review SHA only when it
  // is the commit this checkout actually resolves to. The binder used to run
  // with `replace: true` unconditionally, so a producer artifact naming a
  // different 40-hex was demoted to `previous_review_sha:` and overwritten with
  // HEAD — exit 0 on an artifact whose own provenance claim was false. Only the
  // coordinator moves a bound SHA forward, and it may do so only from the value
  // it bound last (the current HEAD) to the commit it is about to create. The
  // check precedes ledger transcription and every git mutation, so a refusal
  // leaves the lane exactly as the producer left it.
  for (const artifact of inspectDeclaredReviewShas(container, resultPath)) {
    if (artifact.final && artifact.declared !== review) {
      die(`dispatch_prepare_lane_commit_plan: ${artifact.label} declares final review_sha ${artifact.declared} but the checkout resolves HEAD to ${review}; only a coordinator-bound SHA equal to the resolved HEAD is admissible (${artifact.path})`);
    }
  }
  if (plannedFiles.join("\n") !== actualFiles.join("\n")) {
    die(`dispatch_prepare_lane_commit_plan: COMMIT PLAN files do not match the actual worktree diff (planned=${plannedFiles.join(",") || "none"}; actual=${actualFiles.join(",") || "none"})`);
  }
  // Codex declarations are transcribed only after every commit-plan validation
  // succeeds. The transcription depends on the register text and binding, not
  // on parsed plan data. A commit-plan dry run remains read-only, so it
  // intentionally does not mutate the ledger.
  if (!args.dryRun && provider === "codex-cli") {
    transcribeCodexRegisterConsumption({
      project_root: args.project, pm_id: args.pm, identity,
      result_text: resultText,
      expected_digest: roleBindingFromContext(context)?.binding_digest,
    });
  }
  const committed: Array<{ files: number; subject: string; sha: string }> = [];
  for (const [index, plan] of acceptedPlans.entries()) {
    const { files, subject, message } = plan;
    if (precommitted) {
      committed.push({ files: files.length, subject, sha: args.dryRun ? "(existing-dry-run)" : review.slice(0, 7) });
      continue;
    }
    if (args.dryRun) {
      process.stdout.write(`--- COMMIT PLAN #${index + 1} (dry-run) ---\nfiles: ${files.join(", ")}\nmessage:\n${message}\n`);
      committed.push({ files: files.length, subject, sha: "(dry-run)" });
      continue;
    }
    // GDN-B12: the commit message travels on git stdin, never through a file.
    // The earlier form wrote <container>/lane/.proxy-commit-message-<pid>-<n>.txt
    // -- inside the PRODUCER write fence (context.json fence_roots), under a name
    // derived only from a pid and a counter, with a plain writeFileSync that
    // follows an existing symlink or Windows reparse point. A producer that
    // pre-placed such a leaf pointing outside its own fence made this
    // Dock-authority process truncate and rewrite that target on its behalf.
    // Exclusive-create plus no-follow would narrow that; having no path at all
    // closes it. "-F -" needs no writable directory, no name, and no cleanup, so
    // there is nothing to pre-place, race, or leave behind on a failure path.
    // Encoding happens BEFORE git add, so a message this tool would refuse can
    // never leave a staged index behind.
    const messageBytes = new TextEncoder().encode(`${message.trimEnd()}\n`);
    const add = git(worktree, ["add", "--", ...files]);
    if (add.exitCode !== 0) die(`dispatch_prepare_lane_commit_plan: git add failed for plan #${index + 1}: ${add.stderr.trim()}`, 1);
    const commit = git(worktree, ["commit", "-F", "-"], { stdin: messageBytes });
    if (commit.exitCode !== 0) die(`dispatch_prepare_lane_commit_plan: git commit failed for plan #${index + 1}: ${commit.stderr.trim() || commit.stdout.trim()}`, 1);
    const sha = git(worktree, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    committed.push({ files: files.length, subject, sha });
  }

  if (!args.dryRun && committed.length > 0) {
    const committedReview = precommitted
      ? review
      : git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(committedReview) || committedReview === base) {
      die("dispatch_prepare_lane_commit_plan: committed review SHA could not be resolved or equals base");
    }
    const stat = git(worktree, ["diff", "--shortstat", `${base}...${committedReview}`, "--"]).stdout.trim();
    for (const summary of bindReviewSha({ container, resultPath, review: committedReview, base, stat, replace: true })) process.stderr.write(`${summary}\n`);
  }

  emitJsonLine({ id: Number(args.id), worktree, plans: plans.length, dry_run: args.dryRun, precommitted, committed });
  return 0;
}

if (import.meta.main) process.exit(await main());
