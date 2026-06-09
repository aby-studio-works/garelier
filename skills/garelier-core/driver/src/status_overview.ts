// Overview page data for the read-only Status Web Console.
//
// Reads files only (manifest, blueprints, backlog). Never mutates state, never
// spawns a provider. Every reader is total: a missing/corrupt file yields an
// empty section rather than throwing. Returned paths are repo-relative
// (forward slashes) so the client can open them through /api/file.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { SetupConfig } from "./config.ts";
import { parsePipeTables } from "./md_tables.ts";
import type {
  OverviewInfo, MilestoneInfo, BlueprintInfo, BacklogCounts, DashboardDoc,
} from "./status_types.ts";

// Files larger than this are linked, not inlined (roadmap.md can be ~600 KiB).
const INLINE_LIMIT = 256 * 1024;

const fwd = (p: string): string => p.replace(/\\/g, "/");
const relTo = (root: string, abs: string): string => {
  const r = fwd(root).replace(/\/+$/, "");
  const a = fwd(abs);
  return a.startsWith(r + "/") ? a.slice(r.length + 1) : a;
};
function mtimeIso(p: string): string | null {
  try { return new Date(statSync(p).mtimeMs).toISOString(); } catch { return null; }
}
function readText(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

// Parse the manifest's "## Active milestones" section into structured entries.
// Each "### Milestone: <name> [✅]" starts a milestone; "- Progress: …" and the
// "#### Phases" checklist under it are captured until the next milestone.
export function parseMilestones(manifest: string): MilestoneInfo[] {
  const lines = manifest.replace(/\r\n?/g, "\n").split("\n");
  const out: MilestoneInfo[] = [];
  let cur: MilestoneInfo | null = null;
  let inPhases = false;
  for (const line of lines) {
    const ms = line.match(/^###\s+Milestone:\s*(.+?)\s*$/);
    if (ms) {
      const raw = ms[1];
      cur = { name: raw.replace(/✅/g, "").trim(), closed: /✅/.test(raw), progress: null, phases: [] };
      out.push(cur);
      inPhases = false;
      continue;
    }
    if (!cur) continue;
    const pm = line.match(/^\s*-\s*Progress:\s*(.+)$/i);
    if (pm) { cur.progress = pm[1].trim(); continue; }
    if (/^####\s+Phases/i.test(line)) { inPhases = true; continue; }
    if (/^###?\s/.test(line)) { inPhases = false; }       // a new heading ends the phase list
    if (inPhases) {
      const ph = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
      if (ph) cur.phases.push({ done: ph[1].toLowerCase() === "x", title: ph[2].trim() });
    }
  }
  return out;
}

function listBlueprints(root: string, dir: string): BlueprintInfo[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: BlueprintInfo[] = [];
  for (const n of names) {
    if (!n.endsWith(".md")) continue;
    const p = `${dir}/${n}`;
    try { if (statSync(p).isDirectory()) continue; } catch { continue; }
    const body = readText(p);
    const h = body.match(/^#\s+(.+)$/m);
    // Blueprints declare their milestone in an Identity bullet, e.g.
    //   - Linked milestone: `m3-hp-p2-closure`
    // Parse it so the overview can show + group blueprints by milestone.
    const ms = body.match(/^[-*]\s*Linked milestone:\s*`?([^`\n]+?)`?\s*$/im);
    out.push({
      name: n.replace(/\.md$/, ""), title: h ? h[1].trim() : null,
      rel: relTo(root, p), updatedAt: mtimeIso(p),
      milestone: ms ? ms[1].trim() : null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Count data rows of the first pipe-table in a backlog file (pending/in_flight).
function countTableRows(p: string): number {
  const tables = parsePipeTables(readText(p));
  return tables.length ? tables[0].rows.length : 0;
}

export function buildOverview(projectRoot: string, pmId: string, _config: SetupConfig | null): OverviewInfo {
  const root = fwd(projectRoot);
  const pmRoot = `${root}/__garelier/${pmId}`;
  const runtime = `${pmRoot}/runtime`;
  const dash = `${pmRoot}/control/project_dashboard`;
  const present = existsSync(pmRoot);

  const milestones = parseMilestones(readText(`${runtime}/manifest.md`));
  const blueprints = listBlueprints(root, `${pmRoot}/control/blueprints`);

  let nextId: number | null = null;
  const idRaw = readText(`${runtime}/backlog/next_id`).trim();
  if (/^\d+$/.test(idRaw)) nextId = Number(idRaw);
  let done = 0;
  try { done = readdirSync(`${runtime}/backlog/done`).filter((f) => f.endsWith(".md")).length; } catch { done = 0; }
  const backlog: BacklogCounts = {
    pending: countTableRows(`${runtime}/backlog/pending.md`),
    inFlight: countTableRows(`${runtime}/backlog/in_flight.md`),
    done, nextId,
  };

  const dashboards: DashboardDoc[] = [];
  for (const n of ["roadmap.md", "current.md", "notes.md", "backlog.md", "milestones.md", "risks.md", "quality_gates.md"]) {
    const p = `${dash}/${n}`;
    if (!existsSync(p)) continue;
    let bytes = 0;
    try { bytes = statSync(p).size; } catch { bytes = 0; }
    dashboards.push({
      name: n.replace(/\.md$/, ""), rel: relTo(root, p), bytes,
      updatedAt: mtimeIso(p), tooLargeToInline: bytes > INLINE_LIMIT,
    });
  }

  return { present, milestones, blueprints, backlog, dashboards };
}
