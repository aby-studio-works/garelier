#!/usr/bin/env bun
// TS-first port of scripts/session_digest.sh (DEC-061/066). Behaviour frozen:
// flags / stdout lines / always-exit-0 / read-only. A compact, DETERMINISTIC
// status summary for a Claude Code SessionStart hook. No provider call, no
// tokens. pm_id / project root are inferred from the cwd; --pm-id / --project
// override.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const outln = (s: string) => process.stdout.write(s + "\n");

function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
function isFile(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }

// find -maxdepth 1 -type f ! -name '.gitkeep'
function countFiles(dir: string): number {
  if (!isDir(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== ".gitkeep").length;
}
// find -maxdepth 1 -type f -name '*.json' ! -name '*.summary.json'
function countMergeResults(dir: string): number {
  if (!isDir(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.endsWith(".summary.json")).length;
}
// find -maxdepth 1 -name '*.json' ! -name '*.summary.json'  (no type filter)
function countJsonAny(dir: string): number {
  if (!isDir(dir)) return 0;
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json") && !n.endsWith(".summary.json")).length;
}

function main(): void {
  const argv = process.argv.slice(2);
  let pmId = "";
  let projectRoot = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pm-id") { pmId = argv[++i] ?? ""; }
    else if (a === "--project") { projectRoot = argv[++i] ?? ""; }
    // unknown args are ignored (shell: `*) shift`)
  }

  const cwd = process.cwd();
  if (!pmId && basename(cwd) === "_pm") {
    pmId = basename(dirname(cwd));
  }
  if (!projectRoot) {
    let cur = cwd;
    while (cur && cur !== "/") {
      if (isDir(`${cur}/__garelier`)) { projectRoot = cur; break; }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  // Can't infer context -> stay silent (never disturb the session).
  if (!projectRoot || !pmId) process.exit(0);
  const pmRoot = `${projectRoot}/__garelier/${pmId}`;
  if (!isDir(pmRoot)) process.exit(0);
  const runtime = `${pmRoot}/runtime`;

  // --- lane ---
  let lane = "idle/dock";
  if (isFile(`${runtime}/lane.lock`)) {
    const m = readFileSync(`${runtime}/lane.lock`, "utf8").match(/"lane"\s*:\s*"([^"]*)"/);
    lane = (m && m[1]) ? m[1] : "held";
  }

  // --- live dispatch producers (DEC-063 ephemeral _dispatch<N> homes) ---
  let live = 0;
  for (const name of listDirs(pmRoot).filter((n) => n.startsWith("_dispatch"))) {
    if (isFile(`${pmRoot}/${name}/STATE.md`)) live++;
  }

  // --- merge gate ---
  let gate = "idle";
  if (isFile(`${runtime}/merge_gate/locks/active.lock`)) gate = "RUNNING";
  const mgPending = countJsonAny(`${runtime}/merge_gate/requests`);

  // --- counts ---
  const pmInbox = countFiles(`${runtime}/pm/inbox`);
  const orchInbox = countFiles(`${runtime}/dock/inbox`);
  const mgResults = countMergeResults(`${runtime}/merge_gate/results`);
  const obsResults = countFiles(`${runtime}/observer/results`);

  // --- doctor summary (best-effort; never blocks) ---
  let doctorSummary = "";
  const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const doctor = `${coreDir}/scripts/doctor.sh`;
  if (isFile(doctor)) {
    const r = spawnSync("bash", [doctor, "--pm-id", pmId, "--project", projectRoot], { encoding: "utf8" });
    const line = (r.stdout ?? "").split(/\n/).find((l) => /^Summary:/.test(l));
    if (line) doctorSummary = line.replace(/^Summary: /, "");
  }

  outln(`── Garelier · PM ${pmId} ──────────────────────────────`);
  outln(`  lane: ${lane}    gate: ${gate} (pending ${mgPending})    live dispatch: ${live}`);
  outln(`  inbox: pm ${pmInbox} / dock ${orchInbox}    results: merge-gate ${mgResults} / observer ${obsResults}`);
  if (doctorSummary) outln(`  doctor: ${doctorSummary}`);
  outln(`  detail: garelier status --pm-id ${pmId} --project "${projectRoot}"  |  doctor.sh --pm-id ${pmId}`);
  process.exit(0);
}

function listDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

main();
