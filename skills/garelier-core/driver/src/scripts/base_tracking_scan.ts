import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { die, emitJsonLine, git, printHelp, readTomlQuoted, resolveProjectPm, utcIsoSeconds, valueAfter } from "./_lib.ts";

const HELP = `#
# base_tracking_scan.ts — forward-integration drift detector (DEC-039 §8.6, W-061).
#
# DEC-039 makes "studio -> in-flight workbench/anvil" forward-integration a
# SYSTEMATIC per-iteration duty: on each iteration Dock measures how far every
# in-flight Worker/Smith branch is behind the studio tip and, if it is behind
# beyond a threshold and no catch-up is already pending, drops an idempotent
# \`track-target.md\` trigger the producer consumes at its next iteration boundary
# (garelier-worker §6.5). merge-gate.md §8.6 spells this out as a literal
# \`git log --oneline <branch>..<studio> | wc -l\` loop Dock/PM was expected to run
# BY HAND for every producer — a mechanism with no reachability (DEC-067 class).
# This script is that loop as ONE command; the jig wires it per tick so driver
# mode gets it for free, and attended Dock/PM run it instead of hand-counting.
#
# What it does NOT do: it never merges, never touches studio, never resolves
# conflicts — the PRODUCER performs the merge and owns any conflict (DEC-039 does
# not widen Dock's no-code-writing boundary). This tool only measures + (with
# --write) drops the trigger file into the producer's own container.
#
# Eligibility (mirrors §8.5/§8.6): only a producer whose STATE.md Status is
# WORKING and whose checkout is on a \`.../workbench/...\` or \`.../anvil/...\` branch
# is a candidate — a BLOCKED/REPORTING/REVIEWING/REWORK producer must not be
# instructed, and non-producer roles (scout/observer/guardian/concierge) have no
# forward-integrated branch. Containers scanned: the dispatch-native
# \`_dispatch<N>/\` homes (DEC-063) plus in-project persistent \`_workers/<id>/\` and
# \`_smiths/<id>/\` containers (DEC-036 default). Exile-relocated containers
# (opt-in) are out of scope.
#
# Usage:
#   base_tracking_scan.ts --pm-id <id> [--project <root>] [--studio <branch>]
#       [--threshold <N>] [--write | --dry-run] [--format json|text]
#
#   --threshold N   commits-behind at/above which a trigger is warranted
#                   (default 3, matching merge-gate.md §8.6).
#   --write         actually drop track-target.md for each eligible producer
#                   (idempotent: never overwrites an existing pending trigger).
#   --dry-run       detect + report only, write nothing (DEFAULT).
#   --format        json (default) or text.
#
# Output (json): one object
#   {"pm_id","studio","threshold","mode":"dry-run"|"write","scanned","triggered",
#    "producers":[{"container","role","branch","behind","pending","action","wrote"}]}
#   action ∈ trigger | current | pending | below-threshold | no-studio | no-branch
# Exit: 0 always on a completed scan (drift is informational, not a failure);
#       2 = usage / precondition error.
set -uo pipefail

PROJECT="" PM="" STUDIO="" THRESHOLD=3 MODE="dry-run" FORMAT="json"
while [ $# -gt 0 ]; do
  case "$1" in
    --project)   PROJECT="\${2:?}"; shift 2 ;;`;

interface Producer {
  container: string;
  role: "worker" | "smith";
  branch: string;
  behind: number;
  pending: boolean;
  action: "trigger" | "current" | "pending" | "below-threshold" | "no-studio" | "no-branch";
  wrote: boolean;
}

function statusOf(path: string): string {
  let found = false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (/^##\s*Status/.test(line)) { found = true; continue; }
    if (found && /\S/.test(line)) return line.replace(/\s/g, "");
  }
  return "";
}

function childDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => join(path, x.name)).sort();
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let project = "";
  let pm = "";
  let studio = "";
  let threshold = "3";
  let mode: "dry-run" | "write" = "dry-run";
  let format: "json" | "text" | string = "json";
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": project = valueAfter(argv, i); i += 2; break;
      case "--pm-id": pm = valueAfter(argv, i); i += 2; break;
      case "--studio": studio = valueAfter(argv, i); i += 2; break;
      case "--threshold": threshold = valueAfter(argv, i); i += 2; break;
      case "--write": mode = "write"; i++; break;
      case "--dry-run": mode = "dry-run"; i++; break;
      case "--format": format = valueAfter(argv, i); i += 2; break;
      case "-h": case "--help": printHelp(HELP);
      default:
        die(`base_tracking_scan: unknown arg: ${argv[i]}\nbase_tracking_scan: valid flags: --pm-id --project --studio --threshold --write --dry-run --format -h/--help`);
    }
  }
  ({ project, pmId: pm } = resolveProjectPm(project, pm, { envFallback: true, defaultProject: process.cwd() }));
  if (!pm) die("base_tracking_scan: --pm-id <id> required");
  if (!/^\d+$/.test(threshold)) die("base_tracking_scan: --threshold must be a non-negative integer");
  if (format !== "json" && format !== "text") die("base_tracking_scan: --format must be json or text");

  const base = `${project}/__garelier/${pm}`;
  if (!existsSync(base)) die(`base_tracking_scan: no PM environment at ${base}`);
  if (!studio) studio = readTomlQuoted(`${base}/_pm/setup_config.toml`, "integration");
  if (git(project, ["rev-parse", "--git-dir"]).exitCode !== 0) {
    die(`base_tracking_scan: --project is not inside a git repository: ${project}`);
  }
  const studioExists = Boolean(studio) && git(project, ["rev-parse", "--verify", "--quiet", `refs/heads/${studio}`]).exitCode === 0;
  const now = utcIsoSeconds();
  const producers: Producer[] = [];
  let triggered = 0;

  const scan = (container: string): void => {
    const state = `${container}/STATE.md`;
    const checkout = `${container}/checkout`;
    if (!existsSync(state) || !existsSync(checkout) || statusOf(state) !== "WORKING") return;
    const branchResult = git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "";
    let role: "worker" | "smith";
    if (branch.includes("/workbench/")) role = "worker";
    else if (branch.includes("/anvil/")) role = "smith";
    else return;
    const normalizedContainer = container.replace(/\\/g, "/");
    const normalizedBase = base.replace(/\\/g, "/");
    const relative = normalizedContainer.startsWith(`${normalizedBase}/`)
      ? normalizedContainer.slice(normalizedBase.length + 1)
      : normalizedContainer;
    const pendingFile = `${container}/track-target.md`;
    let pending = existsSync(pendingFile);
    const row: Producer = { container: relative, role, branch, behind: 0, pending, action: "current", wrote: false };
    if (!studioExists) {
      row.action = "no-studio";
      producers.push(row);
      return;
    }
    const count = git(project, ["rev-list", "--count", `${branch}..${studio}`]);
    const raw = count.exitCode === 0 ? count.stdout.trim() : "";
    if (!/^\d+$/.test(raw)) {
      row.action = "no-branch";
      producers.push(row);
      return;
    }
    row.behind = Number(raw);
    if (row.behind === 0) row.action = "current";
    else if (pending) row.action = "pending";
    else if (row.behind < Number(threshold)) row.action = "below-threshold";
    else {
      row.action = "trigger";
      if (mode === "write" && !existsSync(pendingFile)) {
        writeFileSync(pendingFile,
          `# Track target\n\nIssued at: ${now}\nIssued by: Dock\nStrategy: merge\nReason: studio advanced ${row.behind} commit(s) past this branch — merge studio in per garelier-worker §6.5 (base_tracking_scan, DEC-039 §8.6).\n`);
        row.wrote = true;
        row.pending = true;
        pending = true;
      }
      triggered++;
    }
    producers.push(row);
  };

  for (const path of childDirs(base).filter((x) => /[\\/]_dispatch[^\\/]*$/.test(x))) scan(path);
  for (const path of childDirs(`${base}/_workers`)) scan(path);
  for (const path of childDirs(`${base}/_smiths`)) scan(path);

  if (format === "text") {
    process.stdout.write(`base-tracking scan: pm=${pm} studio=${studio || "<unresolved>"} threshold=${threshold} mode=${mode}\n`);
    process.stdout.write(`  scanned=${producers.length} triggered=${triggered}\n`);
    // Preserve the shell implementation's rendering: its comma split means no
    // producer detail line matches the later three-field sed expression.
  } else {
    emitJsonLine({
      pm_id: pm,
      studio,
      threshold: Number(threshold),
      mode,
      scanned: producers.length,
      triggered,
      producers,
    });
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
