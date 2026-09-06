#!/usr/bin/env bun
// blueprint_ship.ts — TS port of blueprint_ship.ts (W-083). One-command
// blueprint ship/abandon bookkeeping (W-064 #10). Derives the deterministic
// edits (blueprint Status flip, git-mv into archive/) and leaves the commit to
// the PM. CLI-frozen against blueprint_ship.ts:
// same flags, stdout, exit codes, and generated file edits.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { requireRuntimeExecutable } from "../../garelier-core/driver/src/scripts/_lib.ts";

// --help prints the original blueprint_ship.ts lines 2-38 verbatim (the .ts did
// `sed -n '2,38p' "$0"`; the shim's $0 is now 4 lines, so the text is embedded).
const HELP = `#
# blueprint_ship.ts — one-command blueprint ship/abandon bookkeeping (W-064 #10).
#
# When a blueprint ships (or is abandoned), the PM hand-edits 2-3 tracked files
# every time (promote.md steps 3-5): flip the blueprint Status and git-mv the
# blueprint into archive/.
# That per-ship toil had no script (pm/scripts and core/scripts both lacked one),
# so it was easy to do partially. This derives the edits from existing artifacts
# — same "derive, don't hand-assemble; leave the commit to a human" pattern as
# merge_request.ts — so the bookkeeping is one command and the PM only commits.
#
# It does the DETERMINISTIC parts:
#   1. blueprint Status:  → \`shipped\` (shipped) / \`archived\` (abandoned)
#   2. git mv  control/blueprints/<slug>.md → control/blueprints/archive/<slug>.md
#
# The roadmap "Recently promoted" move (promote.md step 3) is NOT automated: the
# milestone↔blueprint link is not derivable from <slug>, and a fuzzy edit could
# corrupt roadmap.md. The script prints a reminder for it instead.
#
# Usage:
#   blueprint_ship.ts --project <root> --pm-id <id> --slug <blueprint-slug>
#                     --outcome shipped|abandoned [--dry-run]
#
#   --project   project root that contains __garelier/ (default: cwd)
#   --pm-id     PM id (the <pm_id> segment under __garelier/)
#   --slug      blueprint file basename without .md (control/blueprints/<slug>.md)
#   --outcome   shipped | abandoned
#   --dry-run   print what would change; touch nothing
#
# Exit codes: 0 ok; 2 usage/precondition error.
set -euo pipefail

PROJECT="." PM="" SLUG="" OUTCOME="" DRY=0`;

function errExit(msg: string, code = 2): never {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

const argv = process.argv.slice(2);
let PROJECT = ".", PM = "", SLUG = "", OUTCOME = "", DRY = 0;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const need = (): string => {
    if (i + 1 >= argv.length) errExit(`blueprint_ship: ${a} requires a value`, 1);
    return argv[++i];
  };
  switch (a) {
    case "--project": PROJECT = need(); break;
    case "--pm-id": PM = need(); break;
    case "--slug": SLUG = need(); break;
    case "--outcome": OUTCOME = need(); break;
    case "--dry-run": DRY = 1; break;
    case "-h": case "--help": process.stdout.write(HELP + "\n"); process.exit(0);
    default:
      process.stderr.write(`blueprint_ship: unknown arg: ${a}\n`);
      process.stderr.write("blueprint_ship: valid flags: --project --pm-id --slug --outcome --dry-run -h/--help\n");
      process.exit(2);
  }
}

if (!PM) errExit("blueprint_ship: --pm-id is required");
if (!SLUG) errExit("blueprint_ship: --slug is required");
if (OUTCOME !== "shipped" && OUTCOME !== "abandoned") {
  errExit(`blueprint_ship: --outcome must be 'shipped' or 'abandoned' (got '${OUTCOME}')`);
}

// shipped -> Status: shipped; abandoned -> Status: archived. Both move to archive/.
const STATUS = OUTCOME === "abandoned" ? "archived" : "shipped";

const PM_ROOT = `${PROJECT}/__garelier/${PM}`;
const BLUEPRINT = `${PM_ROOT}/control/blueprints/${SLUG}.md`;
const ARCHIVE_DIR = `${PM_ROOT}/control/blueprints/archive`;
const ARCHIVE = `${ARCHIVE_DIR}/${SLUG}.md`;

if (!existsSync(BLUEPRINT)) errExit(`blueprint_ship: blueprint not found: ${BLUEPRINT}`);
if (existsSync(ARCHIVE)) errExit(`blueprint_ship: already archived: ${ARCHIVE}`);

function git(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(requireRuntimeExecutable("git"), args, { windowsHide: true, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const gr = git(["-C", PROJECT, "rev-parse", "--show-toplevel"]);
const GIT_ROOT = gr.status === 0 ? gr.stdout.trimEnd() : "";

const CHANGED: string[] = [];
const NOTES: string[] = [];

// 1. blueprint Status flip (in place; the git mv below moves the edited file).
const bpText = readFileSync(BLUEPRINT, "utf8");
if (/^- Status:/m.test(bpText)) {
  if (DRY === 0) {
    writeFileSync(BLUEPRINT, bpText.replace(/^- Status:.*$/gm, `- Status: ${STATUS}`));
  }
  CHANGED.push(`blueprint Status -> ${STATUS}`);
} else {
  NOTES.push("blueprint has no '- Status:' line; skipped Status flip");
}

// 2. archive move (git mv when tracked; plain mv otherwise).
if (DRY === 0) {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const tracked = GIT_ROOT !== "" &&
    git(["-C", GIT_ROOT, "ls-files", "--error-unmatch", BLUEPRINT]).status === 0;
  if (tracked) {
    const mv = git(["-C", GIT_ROOT, "mv", BLUEPRINT, ARCHIVE]);
    if (mv.status !== 0) { if (mv.stderr) process.stderr.write(mv.stderr); process.exit(mv.status || 1); }
  } else {
    renameSync(BLUEPRINT, ARCHIVE);
  }
}
CHANGED.push(`blueprint ${SLUG}.md -> archive/${SLUG}.md`);

// --- summary (never commits; leaves that to the PM) ---
const prefix = DRY === 1 ? "dry-run" : "applied";
console.log(`blueprint_ship (${prefix}): ${SLUG} -> ${OUTCOME}`);
for (const c of CHANGED) console.log(`  changed: ${c}`);
for (const n of NOTES) if (n) console.log(`  note: ${n}`);
console.log("  reminder: move the milestone to roadmap.md 'Recently promoted' by hand (not auto — milestone<->blueprint link is not derivable)");
console.log("  next: review the diff, then commit (this script never commits)");
