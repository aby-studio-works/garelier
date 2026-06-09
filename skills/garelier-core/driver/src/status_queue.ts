// Queue page data for the read-only Status Web Console.
//
// Parses the runtime backlog (in_flight.md / pending.md / done/) into a
// structured work queue plus tier (milestone) congestion and per-role capacity.
// Reads files only; totally best-effort (missing/garbled → empty section).

import { readFileSync, readdirSync } from "node:fs";
import type { SetupConfig } from "./config.ts";
import { parsePipeTables, columnIndex, cell } from "./md_tables.ts";
import { parseMilestones } from "./status_overview.ts";
import { readRoles, DISPATCH_ACTIVE_STATES } from "./status_snapshot.ts";
import type {
  QueueInfo, InFlightItem, PendingItem, TierInfo, RoleCapacity,
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

// Liveness check mirrors status_snapshot.isPidAlive (process.kill(pid,0)); kept
// local so the queue module needs no cross-import. EPERM => alive (exists, not ours).
function isPidAlive(pid: number): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// Count LIVE detached agents per role from the driver lease files — the SAME
// ground truth as the Status page Concurrency card (aliveDetached). The old
// capacity count came from in_flight.md, a declarative backlog table that lags
// reality (a finished gate or a stale row left guardian/smith "stuck" at a fixed
// number even with no agent running). Live leases make the bar move only while an
// agent is actually alive, and keep this table consistent with Concurrency.
function aliveLeasesByRole(runtime: string): Map<string, number> {
  const m = new Map<string, number>();
  let files: string[] = [];
  try { files = readdirSync(`${runtime}/driver/pids`); } catch { return m; }
  for (const f of files) {
    if (!f.endsWith(".pid")) continue;
    let lease: Record<string, unknown>;
    try { lease = JSON.parse(readFileSync(`${runtime}/driver/pids/${f}`, "utf8")) as Record<string, unknown>; }
    catch { continue; }
    if (lease.status === "finished") continue;
    const role = (typeof lease.role === "string" ? lease.role : f.split("-")[0] || "").toLowerCase();
    if (!role) continue;
    const pid = Number(lease.pid ?? lease.child_pid);
    const alive = lease.status === "starting" && (!Number.isFinite(pid) || pid <= 0) ? true : isPidAlive(pid);
    if (alive) m.set(role, (m.get(role) ?? 0) + 1);
  }
  return m;
}

// Dispatch-mode in-flight per role kind, derived from each role's STATE.md
// (the SAME ground truth as the console's Dispatch-activity card and the
// idle-with-pending warning). Under DEC-057 dispatch / Mode D there are no
// driver pid leases — producers run as in-session subagents / a codex
// subprocess — so the lease-based count is 0 for every role and Capacity wrongly
// reads "0/N". Counting roles whose STATE.md shows an active dispatch state
// (ASSIGNED/WORKING/REPORTING/BLOCKED) makes Capacity correct in dispatch mode;
// combined with the lease count via max() it stays correct under the headless
// driver too. Best-effort: any read failure yields an empty map (lease-only).
function activeStatesByRole(projectRoot: string, pmId: string, runtime: string, config: SetupConfig | null): Map<string, number> {
  const m = new Map<string, number>();
  let roles: ReturnType<typeof readRoles> = [];
  try { roles = readRoles(projectRoot, pmId, runtime, config); } catch { return m; }
  for (const r of roles) {
    if (!DISPATCH_ACTIVE_STATES.has(String(r.state).toUpperCase())) continue;
    m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
  }
  return m;
}

function buildCapacity(
  config: SetupConfig | null,
  aliveByRole: Map<string, number>,
  stateActiveByRole: Map<string, number>,
): RoleCapacity[] {
  const roles = ["worker", "scout", "smith", "librarian", "observer", "guardian", "concierge", "artisan"];
  const out: RoleCapacity[] = [];
  for (const r of roles) {
    const configured = roleCount(config, r);
    // Occupied slots = the larger of live pid leases (headless driver) and
    // STATE.md-active roles (dispatch mode). One source is ~0 in each mode.
    const flying = Math.max(aliveByRole.get(r) ?? 0, stateActiveByRole.get(r) ?? 0);
    if (configured === 0 && flying === 0) continue;   // hide roles not in play
    out.push({ role: r, configured, inFlight: flying });
  }
  return out;
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

  const inFlight = parseInFlight(readText(`${backlog}/in_flight.md`));
  // A dispatched task lives in in_flight.md, but backlog/pending.md may still
  // carry a stale entry for it (Dock doesn't always prune pending on
  // dispatch). Drop those so a task never appears in BOTH the queue and the
  // in-flight / REVIEW lane (e.g. #15 showing in ACTIVE QUEUE and REVIEW/GATE).
  const inFlightTasks = new Set(inFlight.map((x) => x.task).filter(Boolean));
  const pending = parsePending(readText(`${backlog}/pending.md`))
    .filter((p) => !p.task || !inFlightTasks.has(p.task));
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
    capacity: buildCapacity(
      config,
      aliveLeasesByRole(runtime),
      activeStatesByRole(root, pmId, runtime, config),
    ),
  };
}
