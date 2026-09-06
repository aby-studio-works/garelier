// Overview page data for the read-only Status Web Console.
//
// Reads files only (manifest, blueprints, backlog). Never mutates state, never
// spawns a provider. Every reader is total: a missing/corrupt file yields an
// empty section rather than throwing. Returned paths are repo-relative
// (forward slashes) so the client can open them through /api/file.

import type { SetupConfig } from "./config.ts";
import { milestoneScope } from "./control/plan_graph_model.ts";
import type { PlanGraphControlModel } from "./control/plan_graph_types.ts";
import { loadStatusControl } from "./status_control.ts";
import type { OverviewInfo } from "./status_types.ts";



// Count data rows of the first pipe-table in a backlog file (pending/in_flight).


function v3Overview(model: PlanGraphControlModel, pmId: string): OverviewInfo {
  const rootRel = `__garelier/${model.config?.pmId ?? pmId}/control`;
  const closed = new Set(["done", "cancelled", "superseded"]);
  const backlog = [...model.backlog.values()];
  const milestones = [...model.milestones.values()].map((record) => {
    const scope = milestoneScope(model, record.slug);
    const work = [...new Set([...scope.directBacklog, ...scope.descendantBacklog])];
    const done = work.filter((id) => closed.has(model.backlog.get(id)?.status ?? "")).length;
    return {
      name: record.slug,
      closed: record.status === "shipped" || record.status === "abandoned",
      progress: `${done}/${work.length} backlog`,
      phases: [],
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const blueprints = [...model.blueprints.values()].map((record) => ({
    name: record.id,
    title: record.id,
    rel: `${rootRel}/${record.path}`,
    updatedAt: record.updated,
    milestone: record.related.find((value) => value.startsWith("milestone:"))?.slice("milestone:".length) ?? null,
  })).sort((left, right) => left.name.localeCompare(right.name));
  return {
    present: true,
    schema: "v3",
    controlRevision: model.revision,
    milestones,
    blueprints,
    backlog: {
      pending: backlog.filter((record) => !closed.has(record.status) && record.status !== "active" && record.status !== "verification").length,
      inFlight: backlog.filter((record) => record.status === "active" || record.status === "verification").length,
      done: backlog.filter((record) => closed.has(record.status)).length,
      nextId: null,
    },
    dashboards: [
      ...(model.current ? [{ name: "current", rel: `${rootRel}/${model.current.path}`, bytes: 0, updatedAt: null, tooLargeToInline: false }] : []),
      ...(model.notebook ? [{ name: "notes", rel: `${rootRel}/${model.notebook.path}`, bytes: 0, updatedAt: null, tooLargeToInline: false }] : []),
    ],
  };
}

export function buildOverview(projectRoot: string, pmId: string, _config: SetupConfig | null, adapter = loadStatusControl(projectRoot, pmId)): OverviewInfo {
  if (adapter.model) return v3Overview(adapter.model, pmId);
  return {
    present: false,
    schema: "v3",
    controlRevision: null,
    milestones: [],
    blueprints: [],
    backlog: { pending: 0, inFlight: 0, done: 0, nextId: null },
    dashboards: [],
  };
}
