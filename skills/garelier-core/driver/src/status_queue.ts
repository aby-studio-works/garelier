// Queue page data for the read-only Status Web Console.
//
// Parses the runtime backlog (in_flight.md / pending.md / done/) into a
// structured work queue plus tier (milestone) congestion and per-role capacity.
// Reads files only; totally best-effort (missing/garbled → empty section).

import { readFileSync, readdirSync } from "node:fs";
import type { SetupConfig } from "./config.ts";
import { parsePipeTables, columnIndex, cell } from "./md_tables.ts";
import { parseMilestones } from "./status_overview.ts";
import type {
  QueueInfo, InFlightItem, PendingItem, TierInfo,
} from "./status_types.ts";

function readText(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}
const nz = (s: string): string | null => (s && s.trim() ? s.trim() : null);

// "worker-01 (Worker)" -> { agent: "worker-01", role: "worker" }
// "(Worker)" -> { agent: null, role: "worker" }; "worker-01" -> { agent, role:null }
function splitAgent(s: string): { agent: string | null; role: string | null } {
  const role = (s.match(/\(([^)]+)\)\s*$/) || [])[1];
  const agent = s.replace(/\([^)]*\)\s*$/, "").trim();
  return { agent: nz(agent), role: role ? role.trim().toLowerCase() : null };
}

// Branch family -> role. in_flight.md's Agent column is often just "worker-01"
// (no "(Worker)" suffix), but the Branch column names the family, which maps 1:1
// to the role. Deriving from it stops the queue showing role "?".
function roleFromBranch(branch: string | null): string | null {
  const fam = branch?.match(/\b(workbench|anvil|shelf|satchel|spyglass|monocle|gavel|clipboard)\b/)?.[1];
  switch (fam) {
    case "workbench": return "worker";
    case "anvil": return "smith";
    case "shelf": return "librarian";
    case "satchel": return "artisan";
    case "spyglass": return "scout";
    case "monocle": return "observer";
    case "gavel": return "guardian";
    case "clipboard": return "concierge";
    default: return null;
  }
}

// W-011 (DEC-064 §3): the structural truth for "executing now" is the set of
// live _dispatch<N>/STATE.md containers (created by dispatch_prepare, removed
// by dispatch_cleanup). backlog/in_flight.md is a GENERATED view of the same
// truth (scripts/dispatch_event.{sh,ps1}) kept for humans and legacy flows
// (parked role containers, pre-W-011 hand-maintained files). Read the
// containers directly so the queue can never disagree with reality.
function liveDispatchInFlight(root: string, pmId: string): InFlightItem[] {
  const pmDir = `${root}/__garelier/${pmId}`;
  const out: InFlightItem[] = [];
  let names: string[] = [];
  try { names = readdirSync(pmDir); } catch { return out; }
  for (const name of names) {
    if (!/^_dispatch\d+$/.test(name)) continue;
    let body = "";
    try { body = readFileSync(`${pmDir}/${name}/STATE.md`, "utf8"); } catch { continue; }
    // STATE.md shape (dispatch_prepare): "# Dispatch #<id> - <role> <slug>",
    // "## Current task" -> "#<id> <slug> (<branch>)".
    const head = body.match(/^#\s*Dispatch\s*#(\d+)\s*-\s*([A-Za-z]+)/m);
    const taskLine = body.match(/##\s*Current task\s*\r?\n\s*(\S[^\r\n]*)/)?.[1]?.trim() ?? "";
    const branch = taskLine.match(/\(([^()]+)\)\s*$/)?.[1] ?? null;
    const task = taskLine.replace(/\s*\([^()]*\)\s*$/, "").trim();
    const id = head?.[1] ?? name.replace(/^_dispatch/, "");
    out.push({
      task: task || `#${id}`,
      agent: name.replace(/^_/, ""),
      role: head?.[2]?.toLowerCase() ?? roleFromBranch(branch),
      blueprint: null,
      milestone: null,
      branch,
      dispatched: null,
    });
  }
  return out;
}

// Dedupe key: the "#<n>" task id when present, else the whole task text.
function taskKey(task: string | null): string | null {
  if (!task) return null;
  return task.match(/#\d+/)?.[0] ?? task;
}

function parseInFlight(text: string): InFlightItem[] {
  const tables = parsePipeTables(text);
  if (!tables.length) return [];
  const t = tables[0];
  const cols = columnIndex(t.header);
  const out: InFlightItem[] = [];
  for (const row of t.rows) {
    const task = cell(row, cols, "task");
    if (!task) continue;
    const { agent, role } = splitAgent(cell(row, cols, "agent"));
    const branch = nz(cell(row, cols, "branch"));
    out.push({
      task: task.trim(), agent,
      role: role ?? roleFromBranch(branch), // fall back to the branch family
      blueprint: nz(cell(row, cols, "blueprint")),
      milestone: nz(cell(row, cols, "milestone")),
      branch,
      dispatched: nz(cell(row, cols, "dispatched")),
    });
  }
  return out;
}

function parsePending(text: string): PendingItem[] {
  const tables = parsePipeTables(text);
  if (!tables.length) return [];
  const t = tables[0];
  const cols = columnIndex(t.header);
  const out: PendingItem[] = [];
  for (const row of t.rows) {
    const task = cell(row, cols, "task");
    if (!task) continue;
    out.push({
      order: nz(cell(row, cols, "order")),
      task: task.trim(),
      blueprint: nz(cell(row, cols, "blueprint")),
      milestone: nz(cell(row, cols, "milestone")),
      role: (nz(cell(row, cols, "role")) ?? "").toLowerCase() || null,
      dependsOn: nz(cell(row, cols, "depends on", "depends", "dependency")),
    });
  }
  // Stable order by the "Order" column when present (numeric), else input order.
  return out.sort((a, b) => {
    const ao = a.order ? parseInt(a.order, 10) : Number.POSITIVE_INFINITY;
    const bo = b.order ? parseInt(b.order, 10) : Number.POSITIVE_INFINITY;
    return (Number.isNaN(ao) ? Infinity : ao) - (Number.isNaN(bo) ? Infinity : bo);
  });
}

// Tier proxy = milestone. Congestion = how many items sit in each milestone,
// split by pending vs in-flight, so a crowded band is visible at a glance.
function buildTiers(inFlight: InFlightItem[], pending: PendingItem[]): TierInfo[] {
  const map = new Map<string, TierInfo>();
  const bump = (name: string | null, key: "pending" | "inFlight") => {
    const n = name ?? "(unassigned)";
    const t = map.get(n) ?? { name: n, pending: 0, inFlight: 0 };
    t[key]++;
    map.set(n, t);
  };
  for (const x of inFlight) bump(x.milestone, "inFlight");
  for (const x of pending) bump(x.milestone, "pending");
  return [...map.values()].sort((a, b) => (b.pending + b.inFlight) - (a.pending + a.inFlight));
}

function roleCount(config: SetupConfig | null, role: string): number {
  if (!config) return 0;
  switch (role) {
    case "worker": return config.workers?.length ?? 0;
    case "scout": return config.scouts?.length ?? 0;
    case "smith": return config.smiths?.length ?? 0;
    case "librarian": return config.librarians?.length ?? 0;
    case "observer": return config.observers?.length ?? 0;
    case "guardian": return config.guardians?.length ?? 0;
    case "concierge": return config.concierges?.length ?? 0;
    case "artisan": return config.artisan ? 1 : 0;
    default: return 0;
  }
}





function activeMilestoneNames(manifest: string, pending: PendingItem[], inFlight: InFlightItem[]): string[] {
  const active = parseMilestones(manifest).filter((m) => !m.closed).map((m) => m.name);
  if (active.length > 0) return active;
  const fallback = inFlight.find((x) => x.milestone)?.milestone ?? pending.find((x) => x.milestone)?.milestone ?? null;
  return fallback ? [fallback] : [];
}

export function buildQueue(projectRoot: string, pmId: string, config: SetupConfig | null): QueueInfo {
  const root = projectRoot.replace(/\\/g, "/");
  const runtime = `${root}/__garelier/${pmId}/runtime`;
  const backlog = `${runtime}/backlog`;

  // W-011: structural truth first (live _dispatch<N> containers), then the
  // in_flight.md rows (generated view / legacy hand-maintained), deduped by
  // task id so a task never shows twice.
  const structural = liveDispatchInFlight(root, pmId);
  const structuralKeys = new Set(structural.map((x) => taskKey(x.task)).filter(Boolean));
  const fromFile = parseInFlight(readText(`${backlog}/in_flight.md`))
    .filter((x) => !structuralKeys.has(taskKey(x.task)));
  const inFlight = [...structural, ...fromFile];
  // A dispatched task lives in the in-flight set, but backlog/pending.md may
  // still carry a stale entry for it (pending isn't always pruned on
  // dispatch). Drop those so a task never appears in BOTH the queue and the
  // in-flight / REVIEW lane (e.g. #15 showing in ACTIVE QUEUE and REVIEW/GATE).
  const inFlightTasks = new Set(inFlight.flatMap((x) => {
    const k = taskKey(x.task);
    return x.task ? [x.task, ...(k ? [k] : [])] : [];
  }));
  const pending = parsePending(readText(`${backlog}/pending.md`))
    .filter((p) => !p.task || (!inFlightTasks.has(p.task) && !inFlightTasks.has(taskKey(p.task) ?? "")));
  const activeMilestones = activeMilestoneNames(readText(`${runtime}/manifest.md`), pending, inFlight);
  const activeSet = new Set(activeMilestones);
  const activeMilestone = activeMilestones[0] ?? null;
  const activePending = activeMilestones.length > 0
    ? pending.filter((p) => p.milestone != null && activeSet.has(p.milestone))
    : pending;
  const futurePending = activeMilestones.length > 0
    ? pending.filter((p) => p.milestone == null || !activeSet.has(p.milestone))
    : [];

  let doneCount = 0;
  try { doneCount = readdirSync(`${backlog}/done`).filter((f) => f.endsWith(".md")).length; } catch { doneCount = 0; }
  let nextId: number | null = null;
  const idRaw = readText(`${backlog}/next_id`).trim();
  if (/^\d+$/.test(idRaw)) nextId = Number(idRaw);

  const present = inFlight.length > 0 || pending.length > 0 || doneCount > 0 || nextId != null;
  return {
    present, inFlight, pending, activeMilestone, activeMilestones, activePending, futurePending, doneCount, nextId,
    tiers: buildTiers(inFlight, pending),
  };
}
