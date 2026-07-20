#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { die, emitJsonLine, git, valueAfter } from "./_lib.ts";
import {
  laneBranch,
  posix,
  readIsolateBase,
  readRecord,
  resolveLanePaths,
  validateSlug,
} from "./lane_common.ts";

const HELP = `#
# lane_recover.ts — machine state summary for an idle-without-register lane (W-095 (e)).
#
# When a producer goes idle without sending its completion register, the PM
# otherwise hand-collects the lane's git state to decide whether it is done,
# stalled, or abandoned (4 hand-runs 2026-07-16). This gathers it READ-ONLY:
# owner/row/producer from the dispatch record, the branch's commits since base,
# the worktree's dirty status, and any codex result / instruction-ledger traces.
#
# Usage:
#   lane_recover.ts --repo <path> --slug <kebab> [--pm-id <id>] [--base <branch>] [--json]
#
# Mutates NOTHING (no collect, no abort). Exit 0 always when the lane exists;
# exit 2 if the lane has neither a worktree nor a branch (nothing to recover).`;

interface Args { repo: string; slug: string; pm: string; base: string; json: boolean; }

function parse(argv: string[]): Args {
  const a: Args = { repo: "", slug: "", pm: "", base: "", json: false };
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--repo": a.repo = valueAfter(argv, i); i += 2; break;
      case "--slug": a.slug = valueAfter(argv, i); i += 2; break;
      case "--pm-id": a.pm = valueAfter(argv, i); i += 2; break;
      case "--base": a.base = valueAfter(argv, i); i += 2; break;
      case "--json": a.json = true; i++; break;
      case "-h": case "--help": process.stdout.write(`${HELP}\n`); process.exit(0);
      default: die(`lane_recover: unknown arg: ${argv[i]}\nlane_recover: see --help for valid flags`);
    }
  }
  return a;
}

function text(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parse(argv);
  a.repo = posix(a.repo);
  if (!a.repo || !a.slug) die("lane_recover: --repo and --slug are required");
  try { validateSlug(a.slug); } catch (e) { die(`lane_recover: ${(e as Error).message}`); }
  if (git(a.repo, ["rev-parse", "--show-toplevel"]).exitCode !== 0) die(`lane_recover: --repo is not a git repository: ${a.repo}`);

  let paths;
  try { paths = resolveLanePaths(a.repo, a.slug, a.pm, true); }
  catch (error) { die(`lane_recover: ${(error as Error).message}`); }
  const worktree = paths.worktree;
  const branch = laneBranch(a.slug);
  const hasWorktree = existsSync(worktree);
  const hasBranch = git(a.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0;
  if (!hasWorktree && !hasBranch) die(`lane_recover: no lane for slug '${a.slug}' (no worktree, no branch) — nothing to recover`, 2);

  const record = readRecord(a.repo, a.slug, a.pm);
  const base = a.base || readIsolateBase(a.repo, a.slug, a.pm) || record?.base || "";

  let commits: string[] = [];
  let ahead = 0;
  if (hasBranch && base) {
    const log = git(a.repo, ["log", "--reverse", "--format=%h %s", `${base}..${branch}`]).stdout.replace(/\r/g, "").trimEnd();
    commits = log ? log.split("\n") : [];
    ahead = commits.length;
  }
  const dirty = hasWorktree ? git(worktree, ["status", "--porcelain"]).stdout.replace(/\r/g, "").trimEnd() : "";
  const dirtyFiles = dirty ? dirty.split("\n") : [];

  // Verification traces: the codex result file, and whether the instruction
  // ledger still has unchecked entries (- [ ]).
  const resultPath = `${paths.metaDir}/${a.slug}.result.md`;
  const hasResult = existsSync(resultPath);
  const resultTail = hasResult ? text(resultPath).replace(/\r/g, "").trimEnd().split("\n").slice(-8).join("\n") : "";
  const ledgerText = text(`${paths.metaDir}/${a.slug}.instructions.md`);
  const openLedger = (ledgerText.match(/^- \[ \]/gm) ?? []).length;

  const out = process.stdout;
  out.write(`=== lane_recover: isolate/${a.slug} ===\n`);
  out.write(`owner:     ${record?.owner || "(unrecorded)"}\n`);
  out.write(`row:       ${record?.row || "(unrecorded)"}\n`);
  out.write(`producer:  ${record?.producer || "(unrecorded)"}${record?.model ? ` (${record.model})` : ""}\n`);
  out.write(`base:      ${base || "(unknown)"}\n`);
  out.write(`worktree:  ${hasWorktree ? worktree : "(absent)"}\n`);
  out.write(`branch:    ${hasBranch ? branch : "(absent)"} — ${ahead} commit(s) ahead of base\n`);
  out.write(`commits:\n${commits.map((c) => `  ${c}`).join("\n") || "  (none)"}\n`);
  out.write(`dirty:     ${dirtyFiles.length} uncommitted path(s)${dirtyFiles.length ? `:\n${dirtyFiles.map((f) => `  ${f}`).join("\n")}` : ""}\n`);
  out.write(`result:    ${hasResult ? `present (${resultPath})` : "absent"}\n`);
  if (resultTail) out.write(`------ result tail ------\n${resultTail}\n-------------------------\n`);
  out.write(`ledger:    ${openLedger} unchecked instruction(s)\n`);

  // A blunt disposition hint (advisory — the PM decides).
  let disposition: string;
  if (dirtyFiles.length > 0) disposition = "MID-EDIT — worktree dirty; the producer may still be working. Do NOT collect (would need --force-collect and could discard work).";
  else if (ahead > 0) disposition = "COMMITTED-IDLE — commits present, tree clean, no register. Likely done: review + lane_collect (or lane_commit_plan if a codex COMMIT PLAN is in the result).";
  else if (hasResult) disposition = "RESULT-ONLY — a result file exists but no commits. Check the result tail: proxy COMMIT PLAN to run, or a BLOCKED question.";
  else disposition = "EMPTY — no commits, no dirty tree, no result. Producer likely never started or died early; consider --abort.";
  out.write(`disposition: ${disposition}\n`);

  if (a.json) emitJsonLine({
    slug: a.slug, owner: record?.owner ?? "", row: record?.row ?? "", producer: record?.producer ?? "",
    base, worktree: hasWorktree ? worktree : "", branch: hasBranch ? branch : "",
    ahead, dirty: dirtyFiles.length, has_result: hasResult, open_ledger: openLedger, disposition,
  });
  return 0;
}

if (import.meta.main) process.exit(await main());
