import type {
  PlanGraph,
  PlanGraphControlModel,
  PlanGraphCycle,
  PlanGraphEdge,
} from "./plan_graph_types.ts";
import { normalizeTypedRef } from "./plan_graph_validate.ts";
import { resolvedMilestoneDependencies } from "./plan_graph_milestone_dependencies.ts";

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function addInverse(map: Map<string, Set<string>>, target: string, source: string): void {
  const values = map.get(target) ?? new Set<string>();
  values.add(source);
  map.set(target, values);
}

function sortedInverse(source: Map<string, Set<string>>): Map<string, string[]> {
  return new Map(
    [...source.entries()]
      .sort(([left], [right]) => compare(left, right))
      .map(([key, values]) => [key, [...values].sort(compare)]),
  );
}

function normalizeCycle(nodes: string[]): string[] {
  const body = nodes.slice(0, -1);
  let best = body;
  for (let index = 1; index < body.length; index++) {
    const candidate = [...body.slice(index), ...body.slice(0, index)];
    if (candidate.join("\0") < best.join("\0")) best = candidate;
  }
  return [...best, best[0]!];
}

function milestoneCycles(
  adjacency: Map<string, string[]>,
  kind: PlanGraphCycle["kind"],
): PlanGraphCycle[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const found = new Map<string, string[]>();
  const visit = (node: string): void => {
    const current = state.get(node) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      const start = stack.indexOf(node);
      if (start >= 0) {
        const normalized = normalizeCycle([...stack.slice(start), node]);
        found.set(normalized.join("\0"), normalized);
      }
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const child of [...(adjacency.get(node) ?? [])].sort(compare)) {
      if (adjacency.has(child)) visit(child);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of [...adjacency.keys()].sort(compare)) visit(node);
  return [...found.values()]
    .sort((left, right) => compare(left.join("\0"), right.join("\0")))
    .map((nodes) => ({ kind, nodes }));
}

type GraphModelInput = Omit<PlanGraphControlModel, "graph" | "findings">;

export function buildPlanGraph(input: GraphModelInput): PlanGraph {
  const nodes: PlanGraph["nodes"] = [];
  const edges: PlanGraphEdge[] = [];
  const historicalEdges: PlanGraphEdge[] = [];
  const directRoadmaps = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const backlog = new Map<string, Set<string>>();
  const backlogViews = new Map<string, Set<string>>();
  const checkpoints = new Map<string, Set<string>>();
  const notes = new Map<string, Set<string>>();
  const risks = new Map<string, Set<string>>();
  const childAdjacency = new Map<string, string[]>();
  const dependencyAdjacency = new Map<string, string[]>();

  const edge = (value: PlanGraphEdge): void => {
    historicalEdges.push(value);
    if (value.state === "active") edges.push(value);
  };

  for (const roadmap of [...input.roadmaps.values()].sort((left, right) => compare(left.slug, right.slug))) {
    nodes.push({ id: `roadmap:${roadmap.slug}`, kind: "roadmap", path: roadmap.path, status: roadmap.status });
    for (const link of roadmap.milestoneLinks) {
      edge({
        from: `roadmap:${roadmap.slug}`,
        to: `milestone:${link.target}`,
        kind: "roadmap-milestone",
        relationId: link.relationId,
        state: link.state,
        ownerPath: roadmap.path,
      });
      if (link.state === "active") addInverse(directRoadmaps, link.target, roadmap.slug);
    }
  }
  for (const milestone of [...input.milestones.values()].sort((left, right) => compare(left.slug, right.slug))) {
    nodes.push({ id: `milestone:${milestone.slug}`, kind: "milestone", path: milestone.path, status: milestone.status });
    childAdjacency.set(milestone.slug, []);
    const dependencies = resolvedMilestoneDependencies(input.milestones, milestone);
    dependencyAdjacency.set(milestone.slug, dependencies);
    for (const dependency of dependencies) {
      edges.push({
        from: `milestone:${milestone.slug}`,
        to: `milestone:${dependency}`,
        kind: "milestone-depends-on",
        relationId: `derived-depends-on:${dependency}`,
        state: "active",
        ownerPath: milestone.path,
      });
    }
    for (const link of milestone.childLinks) {
      edge({
        from: `milestone:${milestone.slug}`,
        to: `milestone:${link.target}`,
        kind: "milestone-child",
        relationId: link.relationId,
        state: link.state,
        ownerPath: milestone.path,
      });
      if (link.state === "active") {
        childAdjacency.get(milestone.slug)!.push(link.target);
        addInverse(parents, link.target, milestone.slug);
        addInverse(children, milestone.slug, link.target);
      }
    }
  }
  for (const record of [...input.backlog.values()].sort((left, right) => compare(left.id, right.id))) {
    nodes.push({ id: `backlog:${record.id}`, kind: "backlog", path: record.path, status: record.status });
    for (const membership of record.milestoneMemberships) {
      edge({
        from: `backlog:${record.id}`,
        to: `milestone:${membership.target}`,
        kind: "backlog-milestone",
        relationId: membership.relationId,
        state: membership.state,
        ownerPath: record.path,
      });
      if (membership.state === "active") addInverse(backlog, membership.target, record.id);
    }
    for (const membership of record.viewMemberships) {
      edge({
        from: `backlog:${record.id}`,
        to: `backlog-view:${membership.target}`,
        kind: "backlog-view",
        relationId: membership.relationId,
        state: membership.state,
        ownerPath: record.path,
      });
      if (membership.state === "active") addInverse(backlogViews, membership.target, record.id);
    }
    for (const dependency of record.dependsOn) {
      edges.push({
        from: `backlog:${record.id}`,
        to: normalizeTypedRef(dependency),
        kind: "backlog-depends-on",
        relationId: `derived-depends-on:${dependency}`,
        state: "active",
        ownerPath: record.path,
      });
    }
  }
  for (const view of [...input.backlogViews.values()].sort((left, right) => compare(left.slug, right.slug))) {
    nodes.push({ id: `backlog-view:${view.slug}`, kind: "backlog_view", path: view.path, status: view.status });
  }
  for (const checkpoint of [...input.checkpoints.values()].sort((left, right) => compare(left.id, right.id))) {
    nodes.push({ id: `checkpoint:${checkpoint.id}`, kind: "checkpoint", path: checkpoint.path, status: checkpoint.status });
    const targets = [
      ...checkpoint.roadmaps.map((id) => `roadmap:${id}`),
      ...checkpoint.milestones.map((id) => `milestone:${id}`),
      ...checkpoint.backlog.map(normalizeTypedRef),
      ...checkpoint.related.map(normalizeTypedRef),
    ];
    for (const [index, target] of targets.entries()) {
      edges.push({
        from: `checkpoint:${checkpoint.id}`,
        to: target,
        kind: "checkpoint-reference",
        relationId: `derived-checkpoint-${String(index + 1).padStart(3, "0")}`,
        state: "active",
        ownerPath: checkpoint.path,
      });
      addInverse(checkpoints, target, checkpoint.id);
    }
  }
  for (const risk of [...input.risks.values()].sort((left, right) => compare(left.id, right.id))) {
    nodes.push({ id: `risk:${risk.id}`, kind: "risk", path: risk.path, status: risk.status });
    const targets = [
      ...risk.related.map(normalizeTypedRef),
      ...risk.mitigationBacklog.map(normalizeTypedRef),
    ];
    for (const [index, target] of targets.entries()) {
      edges.push({
        from: `risk:${risk.id}`,
        to: target,
        kind: target.startsWith("backlog:") && index >= risk.related.length ? "risk-mitigation" : "risk-related",
        relationId: `derived-risk-${String(index + 1).padStart(3, "0")}`,
        state: "active",
        ownerPath: risk.path,
      });
      addInverse(risks, target, risk.id);
    }
  }
  for (const note of [...input.notes].sort((left, right) => compare(left.id, right.id))) {
    nodes.push({ id: `note:${note.id}`, kind: "note", path: note.path, status: note.status });
    for (const [index, rawTarget] of note.related.entries()) {
      const target = normalizeTypedRef(rawTarget);
      edges.push({
        from: `note:${note.id}`,
        to: target,
        kind: "note-related",
        relationId: `derived-note-${String(index + 1).padStart(3, "0")}`,
        state: "active",
        ownerPath: note.path,
      });
      addInverse(notes, target, note.id);
    }
  }
  for (const section of input.notebook?.sections ?? []) {
    const match = section.heading.match(/\b(N-\d{3,})\b/);
    if (!match) continue;
    const id = match[1]!;
    nodes.push({ id: `note:${id}`, kind: "note", path: input.notebook!.path, status: "active" });
    for (const target of section.related.map(normalizeTypedRef)) addInverse(notes, target, id);
  }
  for (const decision of [...input.decisions.values()].sort((left, right) => compare(left.id, right.id))) {
    nodes.push({ id: `decision:${decision.id}`, kind: "decision", path: decision.path, status: decision.status });
  }
  for (const blueprint of [...input.blueprints.values()].sort((left, right) => compare(left.id, right.id))) {
    nodes.push({ id: `blueprint:${blueprint.id}`, kind: "blueprint", path: blueprint.path, status: blueprint.status });
  }

  const roadmapsByMilestone = new Map<string, Set<string>>();
  for (const roadmap of [...input.roadmaps.values()].sort((left, right) => compare(left.slug, right.slug))) {
    const queue = roadmap.milestoneLinks.filter((link) => link.state === "active").map((link) => link.target);
    const visited = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      addInverse(roadmapsByMilestone, current, roadmap.slug);
      for (const child of childAdjacency.get(current) ?? []) queue.push(child);
    }
  }

  nodes.sort((left, right) => compare(left.id, right.id) || compare(left.path, right.path));
  edges.sort((left, right) =>
    compare(left.from, right.from)
    || compare(left.kind, right.kind)
    || compare(left.to, right.to)
    || compare(left.relationId, right.relationId));
  historicalEdges.sort((left, right) =>
    compare(left.from, right.from)
    || compare(left.kind, right.kind)
    || compare(left.to, right.to)
    || compare(left.relationId, right.relationId));

  return {
    nodes,
    edges,
    historicalEdges,
    cycles: [
      ...milestoneCycles(childAdjacency, "milestone-containment"),
      ...milestoneCycles(dependencyAdjacency, "milestone-dependency"),
    ],
    roadmapsByMilestone: sortedInverse(roadmapsByMilestone),
    parentsByMilestone: sortedInverse(parents),
    childrenByMilestone: sortedInverse(children),
    backlogByMilestone: sortedInverse(backlog),
    backlogByView: sortedInverse(backlogViews),
    checkpointsByEntity: sortedInverse(checkpoints),
    notesByEntity: sortedInverse(notes),
    risksByEntity: sortedInverse(risks),
  };
}
