// Canonical control-contract graph + validation (DEC-044).
//
// Reads only __garelier/<pm_id>/control. The graph is derived from the tracked
// authority and must never be hand-maintained.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ControlEdge, ControlInfo, ControlNode,
  PublicPlanGraphBacklog, PublicPlanGraphCheckpoint, PublicPlanGraphNote, PublicPlanGraphRisk,
  StatusControlFilters,
} from "./status_types.ts";
import {
  loadPlanGraphModel, milestoneScope, roadmapProgress,
} from "./control/plan_graph_model.ts";
import { buildPlanGraphResume } from "./control/plan_graph_resume.ts";
import type {
  BacklogRecord, CheckpointRecord, PlanGraphControlModel, RiskRecord,
} from "./control/plan_graph_types.ts";
import { controlRuntimeRoot, readStableControl } from "./control/generation.ts";
import { RISK_LEVELS as CONTROL_RISK_LEVELS } from "./control/types.ts";
import { assertSafePmId, resolveControlRoots } from "./control/roots.ts";
import { resolvePlant } from "./plant.ts";
import {
  statusText,
} from "./status_public_control.ts";

export type StatusControlAdapter =
  | { schema: "v3"; model: PlanGraphControlModel; runtime: null; error: null }
  | { schema: "v3"; model: null; runtime: null; error: { code: string; message: string } };

const text = (path: string): string => {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
};
const safeLabel = (value: string): string => value.replace(/"/g, "'").replace(/[\r\n]+/g, " ").slice(0, 80);

// A namespace that declares a canonical discriminator never falls back to
// dashboard parsing, including when its marker or canonical records are bad.
function loadStatusControlSnapshot(projectRoot: string, pmId: string, options: { container?: string } = {}): StatusControlAdapter {
  try { assertSafePmId(pmId); }
  catch (error) {
    return { schema: "v3", model: null, runtime: null, error: { code: "control-root-unavailable", message: error instanceof Error ? error.message : String(error) } };
  }
  let roots: ReturnType<typeof resolveControlRoots>;
  try { roots = resolveControlRoots(projectRoot, pmId, options.container); }
  catch (error) {
    return { schema: "v3", model: null, runtime: null, error: { code: "control-root-unavailable", message: error instanceof Error ? error.message : String(error) } };
  }
  const marker = text(join(roots.controlRoot, "control.toml"));
  const schemaV3 = /(?:^|\n)\s*schema_version\s*=\s*3\s*(?:#.*)?(?:\n|$)/.test(marker);
  const storageV3 = /(?:^|\n)\s*storage\s*=\s*["']plan_graph_markdown["']\s*(?:#.*)?(?:\n|$)/.test(marker);
  if (schemaV3 && storageV3) {
    try {
      const loaded = loadPlanGraphModel(roots.controlRoot);
      const model = loaded.config && loaded.config.pmId !== pmId
        ? {
          ...loaded,
          findings: [...loaded.findings, {
            severity: "error" as const,
            code: "config-pm-id-mismatch",
            path: "control.toml",
            entity: "control",
            field: "pm_id",
            message: `control.toml pm_id must match the selected namespace ${pmId}`,
          }],
        }
        : loaded;
      return { schema: "v3", model, runtime: null, error: null };
    } catch (error) {
      return {
        schema: "v3", model: null, runtime: null,
        error: { code: "control-v3-unavailable", message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
  return {
    schema: "v3", model: null, runtime: null,
    error: { code: "control-schema-unsupported", message: "only schema_version 3 with storage plan_graph_markdown is accepted" },
  };
}

export function loadStatusControl(projectRoot: string, pmId: string, options: { container?: string } = {}): StatusControlAdapter {
  try { assertSafePmId(pmId); }
  catch { return loadStatusControlSnapshot(projectRoot, pmId, options); }
  let plant: ReturnType<typeof resolvePlant>;
  try { plant = resolvePlant(projectRoot, options.container); }
  catch { return loadStatusControlSnapshot(projectRoot, pmId, options); }
  try {
    if (!plant.garelierRoot) return loadStatusControlSnapshot(projectRoot, pmId, options);
    const controlRoot = join(plant.garelierRoot, pmId, "control");
    return readStableControl({ controlRoot, runtimeRoot: controlRuntimeRoot(controlRoot) },
      () => loadStatusControlSnapshot(projectRoot, pmId, options));
  } catch (error) {
    return {
      schema: "v3", model: null, runtime: null,
      error: { code: "control-generation-unavailable", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export class StatusControlQueryError extends Error {
  constructor(message: string) { super(message); this.name = "StatusControlQueryError"; }
}

const STATUS_FILTER_KEYS = new Set([
  "milestone", "riskSeverity", "roadmap", "backlogStatus", "archive", "checkpoint", "related",
]);
const PLAN_GRAPH_BACKLOG_STATES = new Set([
  "triage", "ready", "active", "blocked", "verification", "deferred", "done", "cancelled", "superseded",
]);
function filterValues(params: URLSearchParams, key: string): string[] | undefined {
  const values = params.getAll(key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (!values.length) return undefined;
  if (values.length > 100 || values.some((value) => value.length > 128 || value.includes("\0"))) {
    throw new StatusControlQueryError(`${key} filter exceeds its bounded value limit`);
  }
  return [...new Set(values)];
}

export function parseStatusControlFilters(params: URLSearchParams): StatusControlFilters {
  for (const key of params.keys()) if (!STATUS_FILTER_KEYS.has(key)) throw new StatusControlQueryError(`unknown control filter: ${key}`);
  const riskSeverity = filterValues(params, "riskSeverity");
  const backlogStatus = filterValues(params, "backlogStatus");
  const archive = filterValues(params, "archive");
  const invalidRisk = riskSeverity?.find((value) => !CONTROL_RISK_LEVELS.includes(value as never));
  if (invalidRisk) throw new StatusControlQueryError(`unknown risk severity: ${invalidRisk}`);
  const invalidBacklogState = backlogStatus?.find((value) => !PLAN_GRAPH_BACKLOG_STATES.has(value));
  if (invalidBacklogState) throw new StatusControlQueryError(`unknown Backlog status: ${invalidBacklogState}`);
  if (archive && (archive.length !== 1 || !["open", "archived", "all"].includes(archive[0]!))) {
    throw new StatusControlQueryError("archive filter must be open, archived, or all");
  }
  return {
    milestone: filterValues(params, "milestone"),
    riskSeverity: riskSeverity as StatusControlFilters["riskSeverity"],
    roadmap: filterValues(params, "roadmap"),
    backlogStatus,
    archive: archive?.[0] as StatusControlFilters["archive"],
    checkpoint: filterValues(params, "checkpoint"),
    related: filterValues(params, "related"),
  };
}

function planGraphRel(rootRel: string, path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) return rootRel;
  return `${rootRel}/${normalized}`;
}

function publicPlanGraphBacklog(rootRel: string, record: BacklogRecord): PublicPlanGraphBacklog {
  return {
    id: statusText(record.id, 128),
    title: statusText(record.title, 240),
    status: statusText(record.status, 80),
    rel: planGraphRel(rootRel, record.path),
    archived: record.path.startsWith("backlog/archive/"),
    milestones: record.milestoneMemberships.filter((link) => link.state === "active").map((link) => statusText(link.target, 128)),
    views: record.viewMemberships.filter((link) => link.state === "active").map((link) => statusText(link.target, 128)),
    dependsOn: record.dependsOn.slice(0, 128).map((value) => statusText(value, 128)),
    blockedBy: record.blockedBy.slice(0, 128).map((value) => statusText(value, 128)),
    related: record.related.slice(0, 128).map((value) => statusText(value, 128)),
    replacement: record.replacement ? statusText(record.replacement, 128) : null,
    currentPosition: statusText(record.currentPosition, 1_000),
    exactNextAction: statusText(record.exactNextAction, 1_000),
    evidence: statusText(record.evidence, 1_000),
  };
}

function publicPlanGraphCheckpoint(rootRel: string, record: CheckpointRecord): PublicPlanGraphCheckpoint {
  return {
    id: statusText(record.id, 128),
    status: statusText(record.status, 80),
    rel: planGraphRel(rootRel, record.path),
    archived: record.path.startsWith("checkpoints/archive/"),
    roadmaps: record.roadmaps.slice(0, 128).map((value) => statusText(value, 128)),
    milestones: record.milestones.slice(0, 128).map((value) => statusText(value, 128)),
    backlog: record.backlog.slice(0, 128).map((value) => statusText(value, 128)),
    lastCompleted: statusText(record.lastCompleted, 1_000),
    exactNextAction: statusText(record.exactNextAction, 1_000),
    blockers: statusText(record.blockers, 1_000),
    readFirst: record.readFirst.slice(0, 128).map((value) => statusText(value, 320)),
    resumeVerification: statusText(record.resumeVerification, 1_000),
  };
}

function publicPlanGraphRisk(rootRel: string, record: RiskRecord): PublicPlanGraphRisk {
  return {
    id: statusText(record.id, 128),
    status: statusText(record.status, 80),
    severity: statusText(record.severity, 80),
    likelihood: statusText(record.likelihood, 80),
    rel: planGraphRel(rootRel, record.path),
    archived: record.path.startsWith("risks/archive/"),
    related: record.related.slice(0, 128).map((value) => statusText(value, 128)),
    mitigationBacklog: record.mitigationBacklog.slice(0, 128).map((value) => statusText(value, 128)),
    evidence: statusText(record.evidence, 1_000),
  };
}

function publicPlanGraphNotes(model: PlanGraphControlModel, rootRel: string): PublicPlanGraphNote[] {
  const notes: PublicPlanGraphNote[] = [];
  let headingsLeft = 5_000;
  for (const record of model.notes.slice(0, 1_000)) {
    const headings = record.sections.slice(0, Math.min(256, headingsLeft)).map((section) => ({
      heading: statusText(section.heading, 240),
      level: section.level,
      startLine: section.startLine,
      endLine: section.endLine,
      related: section.related.slice(0, 128).map((value) => statusText(value, 128)),
    }));
    headingsLeft -= headings.length;
    notes.push({
      id: statusText(record.id, 128),
      status: statusText(record.status, 80),
      rel: planGraphRel(rootRel, record.path),
      related: record.related.slice(0, 128).map((value) => statusText(value, 128)),
      promotedTo: record.promotedTo.slice(0, 128).map((value) => statusText(value, 128)),
      headings,
    });
    if (headingsLeft === 0) break;
  }
  for (const section of model.notebook?.sections ?? []) {
    if (notes.length >= 1_000 || headingsLeft === 0) break;
    const match = section.heading.match(/\b(N-\d{3,})\b/);
    notes.push({
      id: statusText(match?.[1] ?? section.heading, 128),
      status: "active",
      rel: planGraphRel(rootRel, model.notebook!.path),
      related: section.related.slice(0, 128).map((value) => statusText(value, 128)),
      promotedTo: [],
      headings: [{
        heading: statusText(section.heading, 240),
        level: section.level,
        startLine: section.startLine,
        endLine: section.endLine,
        related: section.related.slice(0, 128).map((value) => statusText(value, 128)),
      }],
    });
    headingsLeft--;
  }
  return notes.sort((left, right) => left.id.localeCompare(right.id) || left.rel.localeCompare(right.rel));
}

function intersects(values: readonly string[], selected?: readonly string[]): boolean {
  return !selected?.length || values.some((value) => selected.includes(value));
}

function v3ControlInfo(model: PlanGraphControlModel, pmId: string, selected: StatusControlFilters): ControlInfo {
  const effectivePmId = pmId;
  const rootRel = `__garelier/${effectivePmId}/control`;
  const publicBacklog = [...model.backlog.values()].map((record) => publicPlanGraphBacklog(rootRel, record));
  const publicRisks = [...model.risks.values()].map((record) => publicPlanGraphRisk(rootRel, record));
  const publicCheckpoints = [...model.checkpoints.values()].map((record) => publicPlanGraphCheckpoint(rootRel, record));
  const publicNotes = publicPlanGraphNotes(model, rootRel);
  const roadmapSelectors = [...model.roadmaps.values()].map((record) => {
    const progress = roadmapProgress(model, record.slug);
    return {
      slug: statusText(record.slug, 128),
      status: statusText(record.status, 80),
      completed: progress.completed.length,
      total: progress.backlog.length,
      ratio: progress.ratio,
    };
  }).sort((left, right) => left.slug.localeCompare(right.slug));
  const selectedRoadmaps = selected.roadmap?.length ? new Set(selected.roadmap) : null;
  const selectedMilestones = new Set(
    [...model.milestones.keys()].filter((slug) =>
      (!selectedRoadmaps || (model.graph.roadmapsByMilestone.get(slug) ?? []).some((roadmap) => selectedRoadmaps.has(roadmap)))
      && (!selected.milestone?.length || selected.milestone.includes(slug))),
  );
  const roadmaps = [...model.roadmaps.values()]
    .filter((record) => !selectedRoadmaps || selectedRoadmaps.has(record.slug))
    .map((record) => {
      const progress = roadmapProgress(model, record.slug);
      return {
        slug: statusText(record.slug, 128),
        status: statusText(record.status, 80),
        rel: planGraphRel(rootRel, record.path),
        milestones: progress.milestones.map((value) => statusText(value, 128)),
        backlog: progress.backlog.map((value) => statusText(value, 128)),
        completed: progress.completed.length,
        total: progress.backlog.length,
        ratio: progress.ratio,
      };
    });
  const milestones = [...model.milestones.values()]
    .filter((record) => selectedMilestones.has(record.slug))
    .map((record) => {
      const scope = milestoneScope(model, record.slug);
      return {
        slug: statusText(record.slug, 128),
        status: statusText(record.status, 80),
        rel: planGraphRel(rootRel, record.path),
        parents: (model.graph.parentsByMilestone.get(record.slug) ?? []).map((value) => statusText(value, 128)),
        children: (model.graph.childrenByMilestone.get(record.slug) ?? []).map((value) => statusText(value, 128)),
        roadmaps: (model.graph.roadmapsByMilestone.get(record.slug) ?? []).map((value) => statusText(value, 128)),
        directBacklog: scope.directBacklog.map((value) => statusText(value, 128)),
        descendantBacklog: scope.descendantBacklog.map((value) => statusText(value, 128)),
      };
    });
  const backlog = publicBacklog.filter((record) => {
    if (selected.backlogStatus?.length && !selected.backlogStatus.includes(record.status)) return false;
    if (selected.archive === "open" && record.archived) return false;
    if (selected.archive === "archived" && !record.archived) return false;
    if (selected.milestone?.length && !intersects(record.milestones, selected.milestone)) return false;
    if (selectedRoadmaps && !record.milestones.some((milestone) =>
      (model.graph.roadmapsByMilestone.get(milestone) ?? []).some((roadmap) => selectedRoadmaps.has(roadmap)))) return false;
    const related = [`backlog:${record.id}`, ...record.milestones.map((value) => `milestone:${value}`), ...record.dependsOn, ...record.blockedBy, ...record.related];
    return intersects(related, selected.related);
  });
  const risks = publicRisks.filter((record) => {
    if (selected.riskSeverity?.length && !selected.riskSeverity.includes(record.severity as never)) return false;
    return intersects([`risk:${record.id}`, ...record.related, ...record.mitigationBacklog.map((id) => `backlog:${id}`)], selected.related);
  });
  const checkpoints = publicCheckpoints.filter((record) => {
    if (selected.checkpoint?.length && !selected.checkpoint.includes(record.id)) return false;
    if (selectedRoadmaps && !record.roadmaps.some((roadmap) => selectedRoadmaps.has(roadmap))) return false;
    if (selected.milestone?.length && !intersects(record.milestones, selected.milestone)) return false;
    return intersects([
      `checkpoint:${record.id}`,
      ...record.roadmaps.map((value) => `roadmap:${value}`),
      ...record.milestones.map((value) => `milestone:${value}`),
      ...record.backlog.map((value) => `backlog:${value}`),
    ], selected.related);
  });
  const notes = publicNotes.flatMap((note) => {
    const noteMatches = intersects([`note:${note.id}`, ...note.related], selected.related);
    const headings = selected.related?.length && !noteMatches
      ? note.headings.filter((section) => intersects(section.related, selected.related))
      : note.headings;
    return noteMatches || headings.length ? [{ ...note, headings }] : [];
  });
  const resumePacket = buildPlanGraphResume(model, { allowInvalid: true });
  const checkpointById = new Map(publicCheckpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const nodes = model.graph.nodes.slice(0, 5_000).map((node) => ({
    id: statusText(node.id, 128),
    kind: node.kind,
    title: node.kind === "backlog"
      ? statusText(model.backlog.get(node.id.replace(/^backlog:/, ""))?.title ?? node.id, 240)
      : statusText(node.id.includes(":") ? node.id.slice(node.id.indexOf(":") + 1) : node.id, 128),
    status: statusText(node.status, 80) || null,
    rel: planGraphRel(rootRel, node.path),
  }));
  const edges = model.graph.edges.slice(0, 10_000).map((edge) => ({
    from: statusText(edge.from, 128),
    to: statusText(edge.to, 128),
    relation: edge.kind === "backlog-depends-on"
      ? "depends" as const
      : edge.kind === "roadmap-milestone" || edge.kind === "milestone-child" || edge.kind === "backlog-milestone"
        ? "includes" as const
        : "related" as const,
  }));
  const findings = model.findings.slice(0, 1_000).map((finding) => ({
    severity: finding.severity === "error" ? "error" as const : "warning" as const,
    code: statusText(finding.code, 128),
    message: statusText(finding.message, 500),
    rel: finding.path ? planGraphRel(rootRel, finding.path) : null,
  }));
  return {
    present: true,
    schema: "v3",
    controlRevision: model.revision,
    rootRel,
    pmId: effectivePmId,
    mode: model.config?.mode ?? null,
    counts: {
      roadmaps: model.roadmaps.size,
      milestones: model.milestones.size,
      backlog: model.backlog.size,
      risks: model.risks.size,
      checkpoints: model.checkpoints.size,
      notes: model.notes.length + (model.notebook?.sections.length ?? 0),
      decisions: model.decisions.size,
      blueprints: model.blueprints.size,
    },
    nodes,
    edges,
    findings,
    mermaid: toMermaid(nodes, edges),
    filters: {
      selected,
      available: {
        milestones: [...model.milestones.keys()].sort(),
        riskSeverities: [...new Set(publicRisks.map((record) => record.severity))].sort() as typeof CONTROL_RISK_LEVELS[number][],
        roadmaps: [...model.roadmaps.keys()].sort(),
        backlogStates: [...new Set(publicBacklog.map((record) => record.status))].sort(),
        checkpoints: [...model.checkpoints.keys()].sort(),
        related: [...new Set([
          ...model.graph.nodes.map((node) => node.id),
          ...publicNotes.flatMap((note) => note.related),
          ...publicNotes.flatMap((note) => note.headings.flatMap((section) => section.related)),
        ])].sort().slice(0, 1_000),
      },
      matched: { risks: risks.length, backlog: backlog.length, checkpoints: checkpoints.length, notes: notes.length },
      total: { risks: publicRisks.length, backlog: publicBacklog.length, checkpoints: publicCheckpoints.length, notes: publicNotes.length },
    },
    planGraph: {
      selectors: { roadmaps: roadmapSelectors },
      roadmaps,
      milestones,
      backlog,
      risks,
      checkpoints,
      notes,
      resume: {
        current: {
          standingInstructions: statusText(resumePacket.current.standing_instructions, 1_000),
          position: statusText(resumePacket.current.position, 1_000),
          blockers: statusText(resumePacket.current.blockers, 1_000),
          primaryCheckpointId: resumePacket.current.primary_checkpoint_id
            ? statusText(resumePacket.current.primary_checkpoint_id, 128) : null,
        },
        primaryCheckpoint: resumePacket.primary_checkpoint
          ? checkpointById.get(resumePacket.primary_checkpoint.id) ?? null : null,
        blockedCheckpoints: resumePacket.blocked_checkpoints
          .flatMap((record) => checkpointById.get(record.id) ?? []),
        checkpointCandidates: resumePacket.checkpoint_candidates
          .flatMap((record) => checkpointById.get(record.id) ?? []),
        readFirst: resumePacket.read_first.slice(0, 128).map((value) => statusText(value, 320)),
      },
      model: {
        schemaVersion: 3,
        storage: "plan_graph_markdown",
        pmId: effectivePmId,
        mode: model.config?.mode ?? "control_only",
        revision: model.revision,
      },
    },
  };
}

export function buildControl(
  projectRoot: string,
  pmId: string,
  adapter = loadStatusControl(projectRoot, pmId),
  filters: StatusControlFilters = {},
): ControlInfo {
  if (adapter.model) return v3ControlInfo(adapter.model, pmId, filters);
  const rootRel = `__garelier/${pmId}/control`;
  const unavailable = {
    code: statusText(adapter.error!.code, 128),
    message: statusText(adapter.error!.message, 500),
  };
  return {
    present: true, schema: adapter.schema, controlRevision: null, unavailable, rootRel, pmId, mode: null, counts: {}, nodes: [], edges: [],
    findings: [{ severity: "error", code: unavailable.code, message: unavailable.message, rel: `${rootRel}/control.toml` }],
    mermaid: `flowchart LR\n  unavailable["Control ${adapter.schema} unavailable"]`,
  };
}

function toMermaid(nodes: ControlNode[], edges: ControlEdge[]): string {
  const lines = ["flowchart LR"];
  for (const n of nodes) {
    const suffix = n.status ? `\\n[${n.status}]` : "";
    lines.push(`  ${n.id}["${safeLabel(n.title)}${safeLabel(suffix)}"]`);
  }
  for (const e of edges) lines.push(`  ${e.from} -->|${e.relation}| ${e.to}`);
  return lines.join("\n");
}
