// Garelier dispatch (DEC-083) — one-shot aggregated dock-lane status.
//
// Supersedes the hand-rolled status.ps1 / status.sh text scrapers (friction 3:
// scattered state). It is a THIN projection of the SAME deterministic aggregators
// the Status Web server uses — buildSnapshot() (lane / merge gate / roles /
// dispatch activity / pmAction / dispatchHold) + buildOverview() (backlog counts /
// milestones / blueprints) — plus a derived `driver` block. One deterministic call
// is the single read surface for BOTH the agent (default --format json, so the PM
// judges the whole lane in one shot) and a human (--format text).
//
// usage:
//   bun dock_status.ts --pm-id <id> [--project <root>] [--format json|text] [--all-pms]
//
// A status read must never hard-fail the caller: a broken/missing config yields
// { ok:false, warnings:[…] } and exit 0.
import { existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildSnapshot } from "../status_snapshot.ts";
import { buildOverview } from "../status_overview.ts";
import { loadConfig } from "../config.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function resolveProject(): string {
  const p = arg("project") ?? process.env.GARELIER_PROJECT;
  if (p) return resolve(p);
  const dr = process.env.GARELIER_DISPATCH_ROOT;
  if (dr) return resolve(dr, "..", "..", "..", "..");
  return process.cwd();
}

function discoverPms(project: string): string[] {
  const base = join(project, "__garelier");
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((d) => existsSync(join(base, d, "_pm", "setup_config.toml")));
}

// Derive the friction-3 "driver on/off" signal. Under dispatch-only (DEC-066) there
// is no headless driver pid — lane.state IS the liveness signal: the unclaimed
// default lane reads "dock" while work is mid-dispatch, "idle" when nothing runs.
function deriveDriver(snapshot: ReturnType<typeof buildSnapshot>): Record<string, unknown> {
  const lane = snapshot.lane.state;
  const inFlight = snapshot.dispatch.inProgress.length;
  return {
    mode: "dispatch",
    lane,
    active: lane !== "idle" && lane !== "unknown",
    inFlight,
    note: lane === "unknown" ? "lane state unknown (no lane.lock / read error)" : null,
  };
}

function statusFor(project: string, pmId: string): Record<string, unknown> {
  let config: ReturnType<typeof loadConfig> | null = null;
  const warnings: string[] = [];
  try { config = loadConfig(project, pmId); }
  catch (e) { warnings.push(`config load failed: ${(e as Error).message}`); }

  const snapshot = buildSnapshot(project, pmId, config, {});
  let overview;
  try { overview = buildOverview(project, pmId, config); }
  catch (e) { warnings.push(`overview build failed: ${(e as Error).message}`); overview = null; }

  return {
    ...snapshot,
    ok: snapshot.ok && config !== null,
    driver: deriveDriver(snapshot),
    backlog: overview ? overview.backlog : null,
    overviewCounts: overview ? { milestones: overview.milestones.length, blueprints: overview.blueprints.length } : null,
    warnings: [...warnings, ...snapshot.warnings.map((w) => `${w.kind}@${w.path}: ${w.message}`)],
  };
}

function textFor(s: Record<string, unknown>): string {
  const lane = s.lane as { state: string; taskId: string | null } | undefined;
  const gate = s.gate as undefined; // not present; mergeGate below
  void gate;
  const mg = (s.mergeGate ?? {}) as { state?: string; active?: boolean; pendingRequests?: number; lastResult?: string | null };
  const br = (s.branches ?? {}) as { studio?: string | null; target?: string | null };
  const drv = (s.driver ?? {}) as { mode?: string; active?: boolean; inFlight?: number };
  const bl = (s.backlog ?? null) as { pending?: number; inFlight?: number; done?: number; nextId?: number | null } | null;
  const inflight = (s.dispatch as { inProgress?: Array<{ taskId?: string; role?: string; branch?: string }> } | undefined)?.inProgress ?? [];
  const pa = (s.pmAction ?? {}) as { needed?: boolean; blockedAgents?: number; openQuestions?: number; inboxItems?: number };
  const recent = (s.dispatch as { recent?: Array<{ kind?: string; task?: string }> } | undefined)?.recent ?? [];
  const L: string[] = [];
  L.push(`--- PM: ${s.pmId} (ok=${s.ok}) ---`);
  L.push(`  target:  ${br.target ?? "?"}`);
  L.push(`  studio:  ${br.studio ?? "?"}`);
  L.push(`  driver:  ${drv.mode} | lane=${lane?.state ?? "?"} | active=${drv.active} | inFlight=${drv.inFlight}`);
  L.push(`  gate:    ${mg.state}${mg.active ? " (RUNNING)" : ""} | pendingReq=${mg.pendingRequests ?? 0} | last=${mg.lastResult ?? "-"}`);
  if (bl) L.push(`  backlog: pending=${bl.pending} inFlight=${bl.inFlight} done=${bl.done} nextId=#${bl.nextId ?? "?"}`);
  if (inflight.length) for (const f of inflight) L.push(`  LIVE:    ${f.taskId ?? "?"} ${f.role ?? ""} ${f.branch ?? ""}`);
  else L.push(`  LIVE:    none`);
  L.push(`  pmAction:${pa.needed ? " NEEDED" : " none"} | blocked=${pa.blockedAgents ?? 0} questions=${pa.openQuestions ?? 0} inbox=${pa.inboxItems ?? 0}`);
  if (recent.length) { L.push(`  recent:`); for (const e of recent.slice(0, 5)) L.push(`    [${e.kind}] ${e.task}`); }
  const warns = (s.warnings as string[]) ?? [];
  if (warns.length) { L.push(`  warnings:`); for (const w of warns.slice(0, 5)) L.push(`    ! ${w}`); }
  return L.join("\n");
}

function main(): void {
  const project = resolveProject();
  const format = (arg("format") ?? "json").toLowerCase();
  const allPms = process.argv.includes("--all-pms");
  const pmId = arg("pm-id") ?? process.env.GARELIER_PM_ID;

  let pms: string[];
  if (allPms) pms = discoverPms(project);
  else if (pmId) pms = [pmId];
  else { console.error("dock_status: --pm-id <id> or --all-pms required"); process.exit(2); return; }

  const results = pms.map((pm) => statusFor(project, pm));

  if (format === "text") {
    console.log(results.map(textFor).join("\n\n"));
  } else {
    console.log(JSON.stringify(allPms ? { pms: results } : results[0]));
  }
  // a status read never hard-fails the caller
  process.exit(0);
}

if (import.meta.main) main();
