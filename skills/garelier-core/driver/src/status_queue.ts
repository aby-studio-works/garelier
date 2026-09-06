// Queue page data for the read-only Status Web Console.
//
// Parses the runtime backlog (in_flight.md / pending.md / done/) into a
// structured work queue plus tier (milestone) congestion and per-role capacity.
// Reads files only; totally best-effort (missing/garbled → empty section).

import type { SetupConfig } from "./config.ts";
import type { BacklogRecord, PlanGraphControlModel } from "./control/plan_graph_types.ts";
import { loadStatusControl } from "./status_control.ts";
import type {
  QueueInfo, InFlightItem, PendingItem, TierInfo,
} from "./status_types.ts";

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




function v3Milestone(record: BacklogRecord): string | null {
  return record.milestoneMemberships.find((membership) => membership.state === "active")?.target ?? null;
}

function v3Pending(record: BacklogRecord): PendingItem {
  return {
    order: null,
    task: record.id,
    blueprint: record.related.find((value) => value.startsWith("blueprint:"))?.slice("blueprint:".length) ?? null,
    milestone: v3Milestone(record),
    role: null,
    dependsOn: record.dependsOn.join(", ") || null,
  };
}

function v3Queue(model: PlanGraphControlModel): QueueInfo {
  const closed = new Set(["done", "cancelled", "superseded"]);
  const backlog = [...model.backlog.values()];
  const inFlight = backlog.filter((record) => record.status === "active" || record.status === "verification").map((record) => ({
    task: record.id,
    agent: null,
    role: null,
    blueprint: record.related.find((value) => value.startsWith("blueprint:"))?.slice("blueprint:".length) ?? null,
    milestone: v3Milestone(record),
    branch: null,
    dispatched: record.updated,
  }));
  const pending = backlog.filter((record) =>
    !closed.has(record.status) && record.status !== "active" && record.status !== "verification").map(v3Pending);
  const activeMilestones = [...model.milestones.values()]
    .filter((record) => record.status === "active" || record.status === "blocked")
    .map((record) => record.slug)
    .sort();
  const activeSet = new Set(activeMilestones);
  const activePending = activeMilestones.length
    ? pending.filter((item) => item.milestone != null && activeSet.has(item.milestone))
    : pending;
  const futurePending = activeMilestones.length
    ? pending.filter((item) => item.milestone == null || !activeSet.has(item.milestone))
    : [];
  return {
    present: backlog.length > 0,
    schema: "v3",
    controlRevision: model.revision,
    inFlight,
    pending,
    activeMilestone: activeMilestones[0] ?? null,
    activeMilestones,
    activePending,
    futurePending,
    doneCount: backlog.filter((record) => closed.has(record.status)).length,
    nextId: null,
    tiers: buildTiers(inFlight, pending),
  };
}






export function buildQueue(projectRoot: string, pmId: string, _config: SetupConfig | null, adapter = loadStatusControl(projectRoot, pmId)): QueueInfo {
  if (adapter.model) return v3Queue(adapter.model);
  return {
    present: false,
    schema: "v3",
    controlRevision: null,
    inFlight: [],
    pending: [],
    activeMilestone: null,
    activeMilestones: [],
    activePending: [],
    futurePending: [],
    doneCount: 0,
    nextId: null,
    tiers: [],
  };
}
