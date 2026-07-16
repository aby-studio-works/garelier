#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { die, emitJsonLine, git, valueAfter } from "./_lib.ts";
import { posix, readRecord, resolveLanePaths, validateSlug } from "./lane_common.ts";

const HELP = `#
# lane_commit_plan.sh — proxy-commit a codex producer's COMMIT PLAN (W-095 (f)).
#
# A codex seat runs proxy (its sandbox denies gitdir writes), so it emits a
# COMMIT PLAN in its result instead of committing. The PM otherwise transcribes
# the file list + message and commits by hand. This parses EVERY COMMIT PLAN
# block from the result file and commits it in the lane worktree, taking the
# Garelier: trailer from the DISPATCH RECORD (authoritative — the plan's own
# trailer, if any, is advisory) so provenance is never producer-forgeable.
#
# COMMIT PLAN block format (as lane_dispatch's codex prompt specifies):
#   === COMMIT PLAN ===
#   files:
#   - path/one
#   - path/two
#   message:
#   <subject ... [ROW]>
#
#   <body>
#   === END COMMIT PLAN ===
#
# Usage:
#   lane_commit_plan.sh --repo <path> --slug <kebab> [--pm-id <id>] [--result <path>] [--dry-run]
#
# --result defaults to the lane's .meta/<slug>.result.md. Exit 2 on a
# malformed/empty plan (fail closed — never commits a guessed message).`;

interface Args { repo: string; slug: string; pm: string; result: string; dryRun: boolean; }

function parse(argv: string[]): Args {
  const a: Args = { repo: "", slug: "", pm: "", result: "", dryRun: false };
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--repo": a.repo = valueAfter(argv, i); i += 2; break;
      case "--slug": a.slug = valueAfter(argv, i); i += 2; break;
      case "--pm-id": a.pm = valueAfter(argv, i); i += 2; break;
      case "--result": a.result = valueAfter(argv, i); i += 2; break;
      case "--dry-run": a.dryRun = true; i++; break;
      case "-h": case "--help": process.stdout.write(`${HELP}\n`); process.exit(0);
      default: die(`lane_commit_plan: unknown arg: ${argv[i]}\nlane_commit_plan: see --help for valid flags`);
    }
  }
  return a;
}

export interface CommitPlan { files: string[]; message: string; }

// Parse every === COMMIT PLAN === … === END COMMIT PLAN === block. Within a
// block: `files:` introduces `- path` lines; `message:` introduces the rest of
// the block (verbatim, trimmed of one leading blank line). Indentation the
// producer may have added to the whole block is stripped per line.
export function parseCommitPlans(text: string): CommitPlan[] {
  const plans: CommitPlan[] = [];
  const re = /^[ \t]*=== COMMIT PLAN ===[ \t]*$([\s\S]*?)^[ \t]*=== END COMMIT PLAN ===[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].replace(/\r/g, "");
    const lines = body.split("\n");
    const files: string[] = [];
    let section: "" | "files" | "message" = "";
    const messageLines: string[] = [];
    for (const raw of lines) {
      const line = raw.replace(/^[ \t]+/, ""); // strip any block-wide indent
      if (/^files:\s*$/.test(line)) { section = "files"; continue; }
      if (/^message:\s*$/.test(line)) { section = "message"; continue; }
      if (section === "files") {
        const f = line.match(/^-\s+(.+?)\s*$/);
        if (f) files.push(f[1]);
      } else if (section === "message") {
        messageLines.push(raw.replace(/^ {4}/, "").replace(/^\t/, "")); // keep body indent beyond the block indent
      }
    }
    while (messageLines.length && messageLines[0].trim() === "") messageLines.shift();
    while (messageLines.length && messageLines[messageLines.length - 1].trim() === "") messageLines.pop();
    plans.push({ files, message: messageLines.join("\n") });
  }
  return plans;
}

// Ensure the message ends with the dispatch record's trailer (authoritative).
// If the exact trailer line is already present, leave as-is; otherwise append it
// after a blank line.
export function ensureTrailer(message: string, trailer: string): string {
  if (!trailer) return message;
  const lines = message.replace(/\r/g, "").split("\n");
  if (lines.some((l) => l.trim() === trailer)) return message;
  const trimmed = message.replace(/\s+$/, "");
  return `${trimmed}\n\n${trailer}`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parse(argv);
  a.repo = posix(a.repo);
  if (!a.repo || !a.slug) die("lane_commit_plan: --repo and --slug are required");
  try { validateSlug(a.slug); } catch (e) { die(`lane_commit_plan: ${(e as Error).message}`); }

  let paths;
  try { paths = resolveLanePaths(a.repo, a.slug, a.pm, true); }
  catch (error) { die(`lane_commit_plan: ${(error as Error).message}`); }
  const worktree = paths.worktree;
  if (!existsSync(worktree)) die(`lane_commit_plan: lane worktree does not exist: ${worktree}`);
  const record = readRecord(a.repo, a.slug, a.pm);
  const trailer = record?.commit_trailer ?? "";
  if (!trailer) process.stderr.write(`lane_commit_plan: WARNING — no dispatch record trailer for '${a.slug}'; committing the plan message as-is (provenance trailer NOT enforced).\n`);

  const resultPath = a.result || `${paths.metaDir}/${a.slug}.result.md`;
  if (!existsSync(resultPath)) die(`lane_commit_plan: result file not found: ${resultPath}`);
  const plans = parseCommitPlans(readFileSync(resultPath, "utf8"));
  if (plans.length === 0) die(`lane_commit_plan: no COMMIT PLAN block found in ${resultPath} (fail closed — nothing committed)`, 2);

  const committed: { files: number; subject: string; sha: string }[] = [];
  for (const [idx, plan] of plans.entries()) {
    const subject = plan.message.split("\n")[0] ?? "";
    if (plan.files.length === 0) die(`lane_commit_plan: COMMIT PLAN #${idx + 1} lists no files (fail closed)`, 2);
    if (!subject.trim()) die(`lane_commit_plan: COMMIT PLAN #${idx + 1} has no subject line (fail closed)`, 2);
    const message = ensureTrailer(plan.message, trailer);

    if (a.dryRun) {
      process.stdout.write(`--- COMMIT PLAN #${idx + 1} (dry-run) ---\nfiles: ${plan.files.join(", ")}\nmessage:\n${message}\n`);
      committed.push({ files: plan.files.length, subject, sha: "(dry-run)" });
      continue;
    }
    const add = git(worktree, ["add", "--", ...plan.files]);
    if (add.exitCode !== 0) die(`lane_commit_plan: git add failed for plan #${idx + 1}: ${add.stderr.trim()}`, 1);
    const commit = git(worktree, ["commit", "-m", message]);
    if (commit.exitCode !== 0) die(`lane_commit_plan: git commit failed for plan #${idx + 1}: ${commit.stderr.trim() || commit.stdout.trim()}`, 1);
    const sha = git(worktree, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    committed.push({ files: plan.files.length, subject, sha });
    process.stdout.write(`lane_commit_plan: committed #${idx + 1} ${sha} — ${subject} (${plan.files.length} file(s))\n`);
  }

  emitJsonLine({ slug: a.slug, worktree, plans: plans.length, dry_run: a.dryRun, committed });
  return 0;
}

if (import.meta.main) process.exit(await main());
