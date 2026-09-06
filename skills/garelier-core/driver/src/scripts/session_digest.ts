#!/usr/bin/env bun
// TS-first port of driver/src/scripts/session_digest.ts (DEC-061/066). Behaviour frozen:
// flags / stdout lines / always-exit-0 / read-only. A compact, DETERMINISTIC
// status summary for a Claude Code SessionStart hook. No provider call, no
// tokens. pm_id / project root are inferred from the cwd; --pm-id / --project
// override.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { requireRuntimeExecutable } from "./_lib.ts";
import { garelierControlSchema } from "../control/garelier_integration.ts";
import { readStableControl } from "../control/generation.ts";
import { loadPlanGraphModel } from "../control/plan_graph_model.ts";
import { buildPlanGraphResume } from "../control/plan_graph_resume.ts";
import { loadConfig } from "../config.ts";
import { buildSnapshot } from "../status_snapshot.ts";

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
  let targetRoot = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pm-id") { pmId = argv[++i] ?? ""; }
    else if (a === "--project") { projectRoot = argv[++i] ?? ""; }
    else if (a === "--target-root") { targetRoot = argv[++i] ?? ""; }
    // unknown args are ignored (shell: `*) shift`)
  }

  const cwd = process.cwd();
  if (!pmId && basename(cwd) === "pm" && basename(dirname(cwd)) === "_crew") {
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
  if (!pmId && projectRoot) {
    const rel = resolve(cwd).slice(resolve(projectRoot).length).split(/[\\/]/).filter(Boolean);
    if (rel[0] === "__garelier" && rel[1] && !rel[1].startsWith("__")) pmId = rel[1];
  }
  if (!pmId && projectRoot) {
    const namespaces = listDirs(`${projectRoot}/__garelier`).filter((name) => isFile(`${projectRoot}/__garelier/${name}/control/control.toml`));
    if (namespaces.length === 1) pmId = namespaces[0];
  }
  // Can't infer context -> stay silent (never disturb the session).
  if (!projectRoot || !pmId) process.exit(0);
  const pmRoot = `${projectRoot}/__garelier/${pmId}`;
  if (!isDir(pmRoot)) process.exit(0);
  const runtime = `${pmRoot}/runtime`;
  let controlSchema: number | null = null;
  let controlSchemaError = "";
  let controlResume = "";
  try {
    readStableControl({ controlRoot: `${pmRoot}/control`, runtimeRoot: `${runtime}/control` }, () => {
      controlSchema = garelierControlSchema(projectRoot, pmId);
      if (controlSchema === 3) {
        const model = loadPlanGraphModel(`${pmRoot}/control`);
        const packet = buildPlanGraphResume(model, {
          allowInvalid: true,
          maxBytes: Math.min(model.config?.maxResumeBytes ?? 24_576, 4_096),
        });
        controlResume = JSON.stringify({
          control_schema_version: 3,
          control_revision: packet.control_revision,
          current: {
            position: packet.current.position,
            blockers: packet.current.blockers,
            primary_checkpoint_id: packet.current.primary_checkpoint_id,
          },
          primary_checkpoint: packet.primary_checkpoint ? {
            id: packet.primary_checkpoint.id,
            status: packet.primary_checkpoint.status,
            exact_next_action: packet.primary_checkpoint.exact_next_action,
            blockers: packet.primary_checkpoint.blockers,
          } : null,
          backlog: packet.backlog.map((entry) => ({
            id: entry.id,
            status: entry.status,
            exact_next_action: entry.exact_next_action,
          })),
          diagnostics: {
            errors: packet.diagnostics.errors,
            warnings: packet.diagnostics.warnings,
          },
          omitted: packet.omitted,
          truncation: packet.truncation,
          queries: packet.queries,
        });
      } else throw new Error(`control schema_version ${controlSchema} is unsupported; only schema_version 3 is accepted`);
    });
  }
  catch (error) { controlSchemaError = (error as Error).message; }

  // Public output keeps the old `lane` label for compatibility, but the value
  // is task-scoped execution state and never comes from retired lane.lock.
  let lane = "unknown";
  try { lane = buildSnapshot(projectRoot, pmId, loadConfig(projectRoot, pmId)).execution.state; }
  catch { /* status digest remains best-effort */ }

  // --- live dispatch roles (DEC-063 ephemeral _crew/dispatch<N> homes) ---
  let live = 0;
  const crewRoot = `${pmRoot}/_crew`;
  for (const name of listDirs(crewRoot).filter((n) => n.startsWith("dispatch"))) {
    if (isFile(`${crewRoot}/${name}/STATE.md`)) live++;
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
  const doctor = `${coreDir}/driver/src/scripts/doctor.ts`;
  if (isFile(doctor)) {
    const r = spawnSync(requireRuntimeExecutable("bun"), [doctor, "--pm-id", pmId, "--project", projectRoot], { windowsHide: true, encoding: "utf8" });
    const line = (r.stdout ?? "").split(/\n/).find((l) => /^Summary:/.test(l));
    if (line) doctorSummary = line.replace(/^Summary: /, "");
  }

  outln(`── Garelier · PM ${pmId} ──────────────────────────────`);
  if (controlSchemaError) {
    outln(`  control-resume: unavailable (${controlSchemaError})`);
  } else if (controlSchema === 3) {
    outln(`  control-resume: ${controlResume}`);
  }
  outln(`  lane: ${lane}    gate: ${gate} (pending ${mgPending})    live dispatch: ${live}`);
  outln(`  inbox: pm ${pmInbox} / dock ${orchInbox}    results: merge-gate ${mgResults} / observer ${obsResults}`);
  if (doctorSummary) outln(`  doctor: ${doctorSummary}`);
  outln(`  detail: garelier status --pm-id ${pmId} --project "${projectRoot}"  |  doctor.ts --pm-id ${pmId}`);
  process.exit(0);
}

function listDirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

main();
