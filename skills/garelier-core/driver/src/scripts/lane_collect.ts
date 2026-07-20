#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { die, emitJsonLine, git, requireRuntimeExecutable, valueAfter } from "./_lib.ts";
import { laneBranch, posix, readIsolateBase, readRecord, resolveLanePaths, validateSlug } from "./lane_common.ts";

const HELP = `#
# lane_collect.ts — one-command isolate-lane collect + row-close proposal (W-095 (c)).
#
# Bundles the PM's end-of-lane hand steps: list the lane's changed paths + commits
# (for the diff review), integrate the isolate branch back into its base via
# workspace_isolate --collect, then print a backlog row-close PROPOSAL (never
# auto-edits the backlog — the PM pastes/decides). The <repo> must be checked out
# on the lane's base branch with a clean tree (workspace_isolate's precondition).
#
# Usage:
#   lane_collect.ts --repo <path> --slug <kebab> [--pm-id <id>] [--base <branch>] [--row <ITEM-ID>]
#                   [--review-only] [--force-collect]
#
# --review-only prints the changed paths + commits and STOPS (no integration) —
# the diff-review pass before you commit to collecting. --row defaults to the
# dispatch record's row. Emits one JSON line with the review + collect result.`;

interface Args { repo: string; slug: string; pm: string; base: string; row: string; reviewOnly: boolean; force: boolean; }

function parse(argv: string[]): Args {
  const a: Args = { repo: "", slug: "", pm: "", base: "", row: "", reviewOnly: false, force: false };
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--repo": a.repo = valueAfter(argv, i); i += 2; break;
      case "--slug": a.slug = valueAfter(argv, i); i += 2; break;
      case "--pm-id": a.pm = valueAfter(argv, i); i += 2; break;
      case "--base": a.base = valueAfter(argv, i); i += 2; break;
      case "--row": a.row = valueAfter(argv, i); i += 2; break;
      case "--review-only": a.reviewOnly = true; i++; break;
      case "--force-collect": a.force = true; i++; break;
      case "-h": case "--help": process.stdout.write(`${HELP}\n`); process.exit(0);
      default: die(`lane_collect: unknown arg: ${argv[i]}\nlane_collect: see --help for valid flags`);
    }
  }
  return a;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parse(argv);
  a.repo = posix(a.repo);
  if (!a.repo || !a.slug) die("lane_collect: --repo and --slug are required");
  try { validateSlug(a.slug); } catch (e) { die(`lane_collect: ${(e as Error).message}`); }
  if (git(a.repo, ["rev-parse", "--show-toplevel"]).exitCode !== 0) die(`lane_collect: --repo is not a git repository: ${a.repo}`);

  let worktree = "";
  let resolvedPm = "";
  try {
    const paths = resolveLanePaths(a.repo, a.slug, a.pm, true);
    worktree = paths.worktree;
    resolvedPm = paths.pmId;
  } catch (error) { die(`lane_collect: ${(error as Error).message}`); }
  const branch = laneBranch(a.slug);
  if (git(a.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode !== 0) {
    die(`lane_collect: no isolate branch for slug '${a.slug}': ${branch}`);
  }
  const record = readRecord(a.repo, a.slug, a.pm);
  const base = a.base || readIsolateBase(a.repo, a.slug, a.pm) || record?.base || "";
  if (!base) die(`lane_collect: could not resolve base for '${a.slug}'; pass --base explicitly`);
  const row = a.row || record?.row || "";

  // Review data (gathered while the branch still exists).
  const filesRaw = git(a.repo, ["diff", "--name-status", `${base}...${branch}`]).stdout.replace(/\r/g, "").trimEnd();
  const files = filesRaw ? filesRaw.split("\n") : [];
  const commitsRaw = git(a.repo, ["log", "--reverse", "--format=%h %s", `${base}..${branch}`]).stdout.replace(/\r/g, "").trimEnd();
  const commits = commitsRaw ? commitsRaw.split("\n") : [];

  const out = process.stdout;
  out.write(`=== lane_collect review: isolate/${a.slug} -> ${base} ===\n`);
  out.write(`Commits (${commits.length}):\n${commits.map((c) => `  ${c}`).join("\n") || "  (none)"}\n`);
  out.write(`Changed paths (${files.length}):\n${files.map((f) => `  ${f}`).join("\n") || "  (none)"}\n`);

  if (a.reviewOnly) {
    emitJsonLine({ mode: "review-only", slug: a.slug, base, branch, commits: commits.length, files: files.length });
    return 0;
  }

  // Integrate via workspace_isolate --collect (its dirty-worktree + base-branch
  // + clean-tree guards still apply; we pass its exit through verbatim).
  const isolateTs = resolve(dirname(fileURLToPath(import.meta.url)), "workspace_isolate.ts");
  const collectArgs = [isolateTs, "--collect", "--repo", a.repo, "--slug", a.slug, "--base", base];
  if (a.pm || resolvedPm) collectArgs.push("--pm-id", a.pm || resolvedPm);
  if (a.force) collectArgs.push("--force-collect");
  const collect = Bun.spawnSync([requireRuntimeExecutable("bun"), ...collectArgs], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  const collectOut = (collect.stdout?.toString() ?? "").trim();
  // Preserve workspace_isolate's diagnostic verbatim.  In particular, exit 2
  // is a precondition failure whose actionable detail was previously dependent
  // on platform-specific inherited-stderr behavior in this wrapper.
  const collectErr = collect.stderr?.toString() ?? "";
  if (collectErr) process.stderr.write(collectErr);
  if (collect.exitCode !== 0) {
    process.stderr.write(`lane_collect: workspace_isolate --collect failed (exit ${collect.exitCode}); lane left intact for manual handling.\n`);
    return collect.exitCode;
  }
  out.write(`${collectOut}\n`);

  const proposal = row
    ? `PROPOSAL: mark ${row} DONE — landed ${commits.length} commit(s) into ${base} (${files.length} file(s) changed). Verify the lane's own lane_verify summary is in the report before closing.`
    : `PROPOSAL: landed ${commits.length} commit(s) into ${base} (${files.length} file(s) changed). (no --row/record: name the backlog row to close it.)`;
  out.write(`${proposal}\n`);

  emitJsonLine({ mode: "collect", slug: a.slug, base, branch, commits: commits.length, files: files.length, row, collected: true, close_proposal: proposal, worktree });
  return 0;
}

if (import.meta.main) process.exit(await main());
