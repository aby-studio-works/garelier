// Garelier dispatch (DEC-052) — Dock-bay-owned merge gate.
//
// In dispatch mode there is no external driver, so the DOCK BAY drives the merge
// gate. It reuses the existing merge_gate machinery: `pollMergeGate` takes the
// single active.lock and spawns `merge-gate.{sh,ps1}` in the BACKGROUND (the
// subprocess does git merge --no-ff + the quality gate with ZERO LLM tokens and
// writes results/<seq>.json atomically). The Dock bay then Monitors results/ and
// resolves (merged.md / review.md). On Dock-bay restart, `poll` re-detects and
// advances any in-flight merge — background tasks are not restored on resume.
//
// usage:
//   bun run dock_merge.ts poll   --pm-id <id> [--project <root>]
//   bun run dock_merge.ts status --pm-id <id> [--project <root>]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pollMergeGate, mergeGatePaths, ensureMergeGateDirs, type MergeGatePaths } from "../merge_gate.ts";
import { loadConfig } from "../config.ts";
import { Logger } from "../log.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Resolve the project root (where __garelier/ lives). The Dock bay runs in a
// worktree, so prefer an explicit --project / GARELIER_PROJECT; else derive it
// from GARELIER_DISPATCH_ROOT (<project>/__garelier/<pm>/runtime/dispatch).
function resolveProject(): string {
  const p = arg("project") ?? process.env.GARELIER_PROJECT;
  if (p) return resolve(p);
  const dr = process.env.GARELIER_DISPATCH_ROOT;
  if (dr) return resolve(dr, "..", "..", "..", "..");
  return process.cwd();
}

function readActive(p: MergeGatePaths): unknown {
  if (!existsSync(p.activeLock)) return null;
  try { return JSON.parse(readFileSync(p.activeLock, "utf8")); } catch { return { unparsed: true }; }
}
function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

const cmd = process.argv[2];
const project = resolveProject();
const pmId = arg("pm-id") ?? process.env.GARELIER_PM_ID;
if (!pmId || (cmd !== "poll" && cmd !== "status")) {
  console.error("usage: dock_merge.ts poll|status --pm-id <id> [--project <root>]");
  process.exit(2);
}
const paths = mergeGatePaths(project, pmId);
ensureMergeGateDirs(paths);

if (cmd === "poll") {
  let config;
  try {
    config = loadConfig(project, pmId);
  } catch (e) {
    console.error(`dock_merge poll: cannot load config for pm "${pmId}" at ${project}: ${(e as Error).message}`);
    process.exit(1);
  }
  const log = new Logger("dock-merge");
  const r = await pollMergeGate(project, config, log, {});
  console.log(JSON.stringify({
    spawned: r.spawnedRequestId ?? null,
    active: readActive(paths),
    pending: listJson(paths.requestsDir),
    results: listJson(paths.resultsDir),
  }));
} else {
  console.log(JSON.stringify({
    active: readActive(paths),
    pending: listJson(paths.requestsDir),
    results: listJson(paths.resultsDir),
  }));
}
