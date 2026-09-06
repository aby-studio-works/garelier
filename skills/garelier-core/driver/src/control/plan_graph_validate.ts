import type {
  BacklogStatus,
  CanonicalMarkdownRecord,
  CheckpointStatus,
  MilestoneStatus,
  PlanGraphControlModel,
  PlanGraphFinding,
  RelationLifecycle,
  RiskStatus,
  RoadmapStatus,
} from "./plan_graph_types.ts";
import {
  milestoneReferenceEvidence,
  proseBacklogReferenceEvidence,
  typedBacklogReferenceEvidence,
} from "./plan_graph_milestone_inheritance.ts";
import { milestoneDependencyEntries } from "./plan_graph_milestone_dependencies.ts";
import { canonicalJson, sha256 } from "./serialization.ts";

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function hasEvidence(value: string): boolean {
  return value.split(/\r?\n/).some((line) => {
    const normalized = line.trim();
    return Boolean(normalized) && !/^[-*]\s*(?:none(?:\s+recorded)?\.?|-)?\s*$/i.test(normalized);
  });
}

export const ROADMAP_TRANSITIONS: Readonly<Record<RoadmapStatus, readonly RoadmapStatus[]>> = {
  planned: ["active", "paused", "abandoned"],
  active: ["paused", "completed", "abandoned"],
  paused: ["active", "abandoned"],
  completed: [],
  abandoned: [],
};

export const MILESTONE_TRANSITIONS: Readonly<Record<MilestoneStatus, readonly MilestoneStatus[]>> = {
  planned: ["active", "paused", "abandoned"],
  active: ["blocked", "paused", "shipped", "abandoned"],
  blocked: ["active", "paused", "shipped", "abandoned"],
  paused: ["active", "blocked", "abandoned"],
  shipped: [],
  abandoned: [],
};

export const BACKLOG_TRANSITIONS: Readonly<Record<BacklogStatus, readonly BacklogStatus[]>> = {
  triage: ["ready", "deferred", "cancelled", "superseded"],
  ready: ["active", "blocked", "deferred", "cancelled", "superseded"],
  active: ["blocked", "verification", "deferred", "cancelled", "superseded"],
  blocked: ["ready", "active", "deferred", "cancelled", "superseded"],
  verification: ["active", "blocked", "done", "cancelled", "superseded"],
  deferred: ["ready", "active", "cancelled", "superseded"],
  done: [],
  cancelled: [],
  superseded: [],
};

export const CHECKPOINT_TRANSITIONS: Readonly<Record<CheckpointStatus, readonly CheckpointStatus[]>> = {
  active: ["paused", "blocked", "completed", "abandoned"],
  paused: ["active", "blocked", "completed", "abandoned"],
  blocked: ["active", "paused", "completed", "abandoned"],
  completed: [],
  abandoned: [],
};

export const RISK_TRANSITIONS: Readonly<Record<RiskStatus, readonly RiskStatus[]>> = {
  open: ["mitigating", "accepted", "closed", "superseded"],
  mitigating: ["open", "accepted", "closed", "superseded"],
  accepted: ["mitigating", "closed", "superseded"],
  closed: [],
  superseded: [],
};

export function isPlanGraphTransitionAllowed(
  kind: "roadmap" | "milestone" | "backlog" | "checkpoint" | "risk",
  from: string,
  to: string,
): boolean {
  if (from === to) return false;
  const matrix = kind === "roadmap"
    ? ROADMAP_TRANSITIONS
    : kind === "milestone"
      ? MILESTONE_TRANSITIONS
      : kind === "backlog"
        ? BACKLOG_TRANSITIONS
        : kind === "checkpoint"
          ? CHECKPOINT_TRANSITIONS
          : RISK_TRANSITIONS;
  return (matrix as Readonly<Record<string, readonly string[]>>)[from]?.includes(to) ?? false;
}

function finding(
  severity: PlanGraphFinding["severity"],
  code: string,
  path: string | null,
  entity: string | null,
  field: string | null,
  message: string,
): PlanGraphFinding {
  return { severity, code, path, entity, field, message };
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateLifecycle(
  record: CanonicalMarkdownRecord & { status: string; kind: string },
  terminal: ReadonlySet<string>,
  archivedPath: boolean,
  requiresArchivedTimestamp = archivedPath,
): PlanGraphFinding[] {
  const result: PlanGraphFinding[] = [];
  const entity = `${record.kind}:${"id" in record ? String(record.id) : "slug" in record ? String(record.slug) : record.path}`;
  const created = timestamp(record.created);
  const updated = timestamp(record.updated);
  const changed = timestamp(record.statusChanged);
  const closed = timestamp(record.closed);
  const archived = timestamp(record.archived);
  const invalid = (value: string | undefined, field: string): void => {
    if (value && timestamp(value) === null) {
      result.push(finding("error", "lifecycle-timestamp-invalid", record.path, entity, field, `${field} is not an RFC 3339 timestamp or date`));
    }
  };
  invalid(record.created, "created");
  invalid(record.updated, "updated");
  invalid(record.statusChanged, "status_changed");
  invalid(record.closed, "closed");
  invalid(record.archived, "archived");
  if (created !== null && updated !== null && updated < created) {
    result.push(finding("error", "lifecycle-updated-before-created", record.path, entity, "updated", "updated precedes created"));
  }
  if (created !== null && changed !== null && changed < created) {
    result.push(finding("error", "lifecycle-status-before-created", record.path, entity, "status_changed", "status_changed precedes created"));
  }
  if (updated !== null && changed !== null && changed > updated) {
    result.push(finding("error", "lifecycle-status-after-updated", record.path, entity, "status_changed", "status_changed follows updated"));
  }
  if (terminal.has(record.status) && closed === null) {
    result.push(finding("error", "lifecycle-terminal-closed-missing", record.path, entity, "closed", "terminal status requires closed"));
  }
  if (closed !== null && updated !== null && closed < updated) {
    result.push(finding("error", "lifecycle-closed-before-updated", record.path, entity, "closed", "closed precedes updated"));
  }
  if (requiresArchivedTimestamp && archived === null) {
    result.push(finding("error", "lifecycle-archive-timestamp-missing", record.path, entity, "archived", "archived lifecycle requires an archived timestamp"));
  }
  if (archivedPath && archived !== null) {
    const archiveYear = record.path.match(/\/archive\/(\d{4})\//)?.[1];
    const timestampYear = record.archived!.slice(0, 4);
    if (archiveYear && archiveYear !== timestampYear) {
      result.push(finding("error", "lifecycle-archive-year-mismatch", record.path, entity, "archived", `archive path year ${archiveYear} does not match archived year ${timestampYear}`));
    }
  }
  if (archived !== null && closed !== null && archived < closed) {
    result.push(finding("error", "lifecycle-archived-before-closed", record.path, entity, "archived", "archived precedes closed"));
  }
  return result;
}

function validateRelationLifecycle(
  relation: RelationLifecycle,
  path: string,
  entity: string,
  field: string,
): PlanGraphFinding[] {
  const result: PlanGraphFinding[] = [];
  const added = timestamp(relation.added);
  const updated = timestamp(relation.updated);
  const retired = timestamp(relation.retired);
  if (added === null || updated === null) {
    result.push(finding("error", "relation-timestamp-invalid", path, entity, field, "relation added/updated must be valid timestamps"));
  } else if (updated < added) {
    result.push(finding("error", "relation-updated-before-added", path, entity, field, "relation updated precedes added"));
  }
  if (relation.state === "retired") {
    if (retired === null || !relation.retireReason) {
      result.push(finding("error", "relation-retirement-incomplete", path, entity, field, "retired relation requires retired and retire_reason"));
    }
    if (retired !== null && added !== null && retired < added) {
      result.push(finding("error", "relation-retired-before-added", path, entity, field, "relation retired precedes added"));
    }
  } else if (relation.retired || relation.retireReason) {
    result.push(finding("error", "relation-active-retirement-metadata", path, entity, field, "active relation cannot carry retirement metadata"));
  }
  return result;
}

// `W-` is reserved for Backlog ids across the whole schema (no other kind's id
// ever starts with `W-`), so a bare `W-NNN` in any typed-reference list
// (depends_on / blocked_by / related / mitigation_backlog, on every record
// kind) is unambiguous shorthand for `backlog:W-NNN`. Anything already
// carrying a `kind:` prefix — `decision:DEC-1`, `checkpoint:CP-1`, an
// already-typed `backlog:W-1` — passes through unchanged; it is never
// re-prefixed. This is a deliberate contract change (W-255): related-style
// fields used to require the full typed form everywhere, which matched what
// was actually on disk but not what workers naturally wrote by hand.
const BARE_BACKLOG_ID = /^W-\d{3,}$/;
export function normalizeTypedRef(ref: string): string {
  return BARE_BACKLOG_ID.test(ref) ? `backlog:${ref}` : ref;
}

// Fields that may only ever reference a Backlog -- dependsOn, blockedBy,
// risk.mitigationBacklog, checkpoint.backlog. Bare `W-NNN` sugar still
// applies via normalizeTypedRef, but an already-typed ref resolving to any
// OTHER kind (e.g. `decision:DEC-1`) is invalid here: unlike `related`, these
// are not general cross-kind links, they are backlog-scoped by definition.
// (Guardian gate confirmation item, W-255 rework note 1 -- normalizeTypedRef
// alone stopped rejecting a non-backlog typed ref here once the old
// unconditional-prefix bugs that accidentally enforced this were fixed.)
// `related` is the ONLY general cross-kind link, and the one field that
// legitimately names a row this repository does not own (another project's
// `W-NNN`, a sibling PM namespace). W-708 (DEC-100 stage 0): an unresolvable
// `related` target is reported as a WARNING, not an error, so it no longer
// refuses `session-open` / resume for every seat in the namespace. The
// backlog-scoped, structural fields (`depends_on`, `blocked_by`,
// `mitigation_backlog`, `checkpoint.backlog`, roadmap/milestone pointers) keep
// their error severity: those describe THIS graph and must resolve inside it.
function relatedRefFindings(
  model: PlanGraphControlModel,
  refs: readonly string[],
  path: string,
  entity: string,
  code: string,
): PlanGraphFinding[] {
  const result: PlanGraphFinding[] = [];
  for (const ref of refs.map(normalizeTypedRef)) {
    if (!typedTargetExists(model, ref)) {
      result.push(finding("warning", code, path, entity, "related", `missing target ${ref}; related may point outside this control graph`));
    }
  }
  return result;
}

function backlogOnlyRefFindings(
  model: PlanGraphControlModel,
  refs: readonly string[],
  path: string,
  entity: string,
  field: string,
  code: string,
): PlanGraphFinding[] {
  const result: PlanGraphFinding[] = [];
  for (const raw of refs) {
    const ref = normalizeTypedRef(raw);
    if (!ref.startsWith("backlog:")) {
      result.push(finding("error", code, path, entity, field, `${field} only accepts a Backlog reference (bare W-NNN or backlog:W-NNN), got ${ref}`));
    } else if (!typedTargetExists(model, ref)) {
      result.push(finding("error", code, path, entity, field, `missing target ${ref}`));
    }
  }
  return result;
}

export function typedTargetExists(model: PlanGraphControlModel, typedRef: string): boolean {
  const [kind, id] = typedRef.split(":", 2);
  if (!id) return false;
  if (kind === "roadmap") return model.roadmaps.has(id);
  if (kind === "milestone") return model.milestones.has(id);
  if (kind === "backlog") return model.backlog.has(id);
  if (kind === "backlog-view") return model.backlogViews.has(id);
  if (kind === "checkpoint") return model.checkpoints.has(id);
  if (kind === "risk") return model.risks.has(id);
  if (kind === "decision") return model.decisions.has(id);
  if (kind === "blueprint") return model.blueprints.has(id);
  if (kind === "note") {
    const sharded = model.notes.filter((note) => note.id === id).length;
    const notebook = model.notebook?.sections.filter((section) => section.heading.match(/\bN-\d{3,}\b/)?.[0] === id).length ?? 0;
    return sharded + notebook === 1;
  }
  return kind === "report";
}

export function validatePlanGraphModel(model: PlanGraphControlModel): PlanGraphFinding[] {
  const result: PlanGraphFinding[] = [];
  const activeCheckpoints = new Set(["active", "paused", "blocked"]);
  const terminalBacklog = new Set(["done", "cancelled", "superseded"]);
  const terminalCheckpoint = new Set(["completed", "abandoned"]);
  const currentPointers = new Set(model.current?.checkpointCandidates ?? []);

  const foldedPaths = new Map<string, string>();
  for (const path of model.sources.keys()) {
    const key = path.toLocaleLowerCase("en-US");
    const prior = foldedPaths.get(key);
    if (prior && prior !== path) {
      result.push(finding("error", "store-path-case-collision", path, null, "path", `case-folded canonical path collides with ${prior}`));
    } else foldedPaths.set(key, path);
  }

  if (!model.current) {
    result.push(finding("error", "current-missing", "project_dashboard/current.md", "current", null, "current.md is required"));
  }

  for (const roadmap of model.roadmaps.values()) {
    result.push(...validateLifecycle(roadmap, new Set(["completed", "abandoned"]), false));
    if (!roadmap.milestoneLinks.some((link) => link.state === "active")) {
      result.push(finding("warning", "roadmap-milestones-empty", roadmap.path, `roadmap:${roadmap.slug}`, "milestone_links", "Roadmap has no active Milestone link"));
    }
    roadmap.milestoneLinks.forEach((link, index) => result.push(...validateRelationLifecycle(link, roadmap.path, `roadmap:${roadmap.slug}`, `milestone_links[${index}]`)));
  }
  for (const milestone of model.milestones.values()) {
    result.push(...validateLifecycle(milestone, new Set(["shipped", "abandoned"]), false));
    for (const dependency of milestoneDependencyEntries(model.milestones, milestone)) {
      if (dependency.kind === "missing") {
        result.push(finding(
          "error",
          "milestone-dependency-target-missing",
          milestone.path,
          `milestone:${milestone.slug}`,
          dependency.source,
          `missing target milestone:${dependency.raw}`,
        ));
      } else if (dependency.kind === "ambiguous") {
        result.push(finding(
          "error",
          "milestone-dependency-target-ambiguous",
          milestone.path,
          `milestone:${milestone.slug}`,
          dependency.source,
          `ambiguous legacy Milestone target ${dependency.raw}: ${dependency.candidates.join(", ")}`,
        ));
      }
    }
    milestone.childLinks.forEach((link, index) => result.push(...validateRelationLifecycle(link, milestone.path, `milestone:${milestone.slug}`, `child_links[${index}]`)));
  }
  for (const backlog of model.backlog.values()) {
    const archivedPath = backlog.path.startsWith("backlog/archive/");
    result.push(...validateLifecycle(backlog, terminalBacklog, archivedPath));
    if (archivedPath && !terminalBacklog.has(backlog.status)) {
      result.push(finding("error", "backlog-archive-status-open", backlog.path, `backlog:${backlog.id}`, "status", "archived Backlog must have terminal status"));
    }
    if (!archivedPath && terminalBacklog.has(backlog.status)) {
      result.push(finding("error", "backlog-open-status-terminal", backlog.path, `backlog:${backlog.id}`, "status", "terminal Backlog must be archived"));
    }
    if (backlog.status === "done" && (!backlog.evidence.trim() || !/^##\s+Acceptance criteria\s*$/im.test(backlog.body))) {
      result.push(finding("error", "backlog-done-evidence-missing", backlog.path, `backlog:${backlog.id}`, "body", "done Backlog requires Acceptance criteria and Evidence"));
    }
    if (backlog.status === "superseded" && !backlog.replacement) {
      result.push(finding("error", "backlog-superseded-replacement-missing", backlog.path, `backlog:${backlog.id}`, "replacement", "superseded Backlog requires replacement"));
    }
    if (["active", "blocked", "verification"].includes(backlog.status) && (!backlog.currentPosition.trim() || !backlog.exactNextAction.trim())) {
      result.push(finding("warning", "backlog-resume-incomplete", backlog.path, `backlog:${backlog.id}`, "body", "active Backlog requires Current position and Exact next action"));
    }
    if (backlog.status === "active") {
      const activationCheckpoint = [...model.checkpoints.values()].find((checkpoint) =>
        checkpoint.status === "active"
        && checkpoint.backlog.includes(backlog.id)
        && currentPointers.has(checkpoint.id));
      if (!activationCheckpoint) {
        result.push(finding("error", "backlog-activation-incomplete", backlog.path, `backlog:${backlog.id}`, "status", "active Backlog requires an active Checkpoint backlink and Current pointer from the same coherent activation"));
      }
    }
    const activeMilestones = backlog.milestoneMemberships.filter((link) => link.state === "active");
    const proseReferences = backlog.related.length === 0 && backlog.dependsOn.length === 0
      ? proseBacklogReferenceEvidence(backlog).filter((candidate) => model.backlog.has(candidate.reference))
      : [];
    if (proseReferences.length) {
      const candidates = proseReferences.map((candidate) => candidate.reference).join(", ");
      result.push(finding(
        "warning",
        "backlog-typed-edge-candidates",
        backlog.path,
        `backlog:${backlog.id}`,
        "related",
        `Backlog has no typed related/depends_on edge; title/body candidates: ${candidates}. Attach a candidate with related = ["backlog:${proseReferences[0]!.reference}"] or depends_on = ["${proseReferences[0]!.reference}"].`,
      ));
    }
    const inheritanceEvidence = milestoneReferenceEvidence(
      model,
      proseReferences.length ? proseReferences : typedBacklogReferenceEvidence(backlog),
    );
    if (!activeMilestones.length && backlog.milestone !== "none" && backlog.inheritMilestones && inheritanceEvidence.length) {
      const milestones = [...new Set(inheritanceEvidence.flatMap((item) => item.milestones))].sort(compare);
      const references = inheritanceEvidence.map((item) => `${item.reference} -> ${item.milestones.join(",")}`).join("; ");
      result.push(finding(
        "warning",
        "backlog-milestone-inheritance-candidates",
        backlog.path,
        `backlog:${backlog.id}`,
        "milestone_memberships",
        `Backlog can inherit Milestone membership(s) ${milestones.join(", ")} from ${references}; attach the typed edge and membership, or run plan_graph_milestone_backfill.ts after review.`,
      ));
    }
    if (!activeMilestones.length && backlog.milestone !== "none") {
      result.push(finding(
        "warning",
        "backlog-milestone-unassigned",
        backlog.path,
        `backlog:${backlog.id}`,
        "milestone_memberships",
        'Backlog has no active Milestone membership; if intentionally cross-cutting, set milestone = "none".',
      ));
    }
    if (activeMilestones.length && backlog.milestone === "none") {
      result.push(finding(
        "error",
        "backlog-milestone-none-conflict",
        backlog.path,
        `backlog:${backlog.id}`,
        "milestone",
        'milestone = "none" conflicts with an active Milestone membership',
      ));
    }
    backlog.milestoneMemberships.forEach((link, index) => result.push(...validateRelationLifecycle(link, backlog.path, `backlog:${backlog.id}`, `milestone_memberships[${index}]`)));
    backlog.viewMemberships.forEach((link, index) => result.push(...validateRelationLifecycle(link, backlog.path, `backlog:${backlog.id}`, `view_memberships[${index}]`)));
    result.push(...backlogOnlyRefFindings(model, backlog.dependsOn, backlog.path, `backlog:${backlog.id}`, "depends_on", "backlog-target-missing"));
    result.push(...backlogOnlyRefFindings(model, backlog.blockedBy, backlog.path, `backlog:${backlog.id}`, "blocked_by", "backlog-target-missing"));
    result.push(...relatedRefFindings(model, backlog.related, backlog.path, `backlog:${backlog.id}`, "backlog-related-target-missing"));
  }
  for (const view of model.backlogViews.values()) {
    result.push(...validateLifecycle(view, new Set(), false));
  }
  for (const checkpoint of model.checkpoints.values()) {
    const archivedPath = checkpoint.path.startsWith("checkpoints/archive/");
    result.push(...validateLifecycle(checkpoint, terminalCheckpoint, archivedPath));
    if (archivedPath && !terminalCheckpoint.has(checkpoint.status)) {
      result.push(finding("error", "checkpoint-archive-status-open", checkpoint.path, `checkpoint:${checkpoint.id}`, "status", "archived Checkpoint must have terminal status"));
    }
    if (!archivedPath && terminalCheckpoint.has(checkpoint.status)) {
      result.push(finding("error", "checkpoint-active-status-terminal", checkpoint.path, `checkpoint:${checkpoint.id}`, "status", "terminal Checkpoint must be archived"));
    }
    if (activeCheckpoints.has(checkpoint.status) && !checkpoint.resumeVerification.trim()) {
      result.push(finding("warning", "checkpoint-resume-verification-missing", checkpoint.path, `checkpoint:${checkpoint.id}`, "body", "active Checkpoint requires Resume verification"));
    }
    if (checkpoint.status === "active" && !currentPointers.has(checkpoint.id)) {
      result.push(finding("error", "checkpoint-activation-pointer-missing", checkpoint.path, `checkpoint:${checkpoint.id}`, "status", "active Checkpoint must be present in Current active pointers"));
    }
    if (checkpoint.action) {
      const prepared = Date.parse(checkpoint.action.preparedAt);
      if (prepared < Date.parse(checkpoint.created) || prepared > Date.parse(checkpoint.updated)) {
        result.push(finding("error", "checkpoint-action-chronology", checkpoint.path, `checkpoint:${checkpoint.id}`, "action.prepared_at", "prepared action timestamp must be within Checkpoint lifecycle"));
      }
      if (checkpoint.action.exactNextAction !== checkpoint.exactNextAction) {
        result.push(finding("error", "checkpoint-action-next-mismatch", checkpoint.path, `checkpoint:${checkpoint.id}`, "action.exact_next_action", "prepared action must match the durable Exact next action"));
      }
      const expectedToken = sha256(canonicalJson({
        checkpoint: checkpoint.id,
        exact_next_action: checkpoint.action.exactNextAction,
        repository_state: checkpoint.action.before,
        success_condition: checkpoint.action.success,
        targets: [...new Set(checkpoint.action.targets)].sort(compare),
        prepared_at: checkpoint.action.preparedAt,
      }));
      if (checkpoint.action.token !== expectedToken) {
        result.push(finding("error", "checkpoint-action-token-invalid", checkpoint.path, `checkpoint:${checkpoint.id}`, "action.token", "prepared action token does not match its durable inputs"));
      }
    }
    result.push(...backlogOnlyRefFindings(model, checkpoint.backlog, checkpoint.path, `checkpoint:${checkpoint.id}`, "backlog", "checkpoint-target-missing"));
    for (const ref of [
      ...checkpoint.roadmaps.map((id) => `roadmap:${id}`),
      ...checkpoint.milestones.map((id) => `milestone:${id}`),
    ]) {
      if (!typedTargetExists(model, ref)) {
        result.push(finding("error", "checkpoint-target-missing", checkpoint.path, `checkpoint:${checkpoint.id}`, "references", `missing target ${ref}`));
      }
    }
    result.push(...relatedRefFindings(model, checkpoint.related, checkpoint.path, `checkpoint:${checkpoint.id}`, "checkpoint-related-target-missing"));
  }
  const terminalRisk = new Set(["closed", "superseded"]);
  for (const risk of model.risks.values()) {
    const archivedPath = risk.path.startsWith("risks/archive/");
    result.push(...validateLifecycle(risk, terminalRisk, archivedPath));
    if (archivedPath && !terminalRisk.has(risk.status)) {
      result.push(finding("error", "risk-archive-status-open", risk.path, `risk:${risk.id}`, "status", "archived Risk must have terminal status"));
    }
    if (!archivedPath && terminalRisk.has(risk.status)) {
      result.push(finding("error", "risk-open-status-terminal", risk.path, `risk:${risk.id}`, "status", "terminal Risk must be archived"));
    }
    if (terminalRisk.has(risk.status) && !hasEvidence(risk.evidence)) {
      result.push(finding("error", "risk-closure-evidence-missing", risk.path, `risk:${risk.id}`, "body", "terminal Risk requires Evidence"));
    }
    result.push(...relatedRefFindings(model, risk.related, risk.path, `risk:${risk.id}`, "risk-related-target-missing"));
    result.push(...backlogOnlyRefFindings(model, risk.mitigationBacklog, risk.path, `risk:${risk.id}`, "mitigation_backlog", "risk-target-missing"));
  }

  const relationOwners = new Map<string, Set<string>>();
  const activeEndpoints = new Map<string, string>();
  const ownerRelations = [
    ...[...model.roadmaps.values()].flatMap((record) =>
      record.milestoneLinks.map((relation) => ({
        owner: `roadmap:${record.slug}`,
        path: record.path,
        kind: "roadmap-milestone",
        target: `milestone:${relation.target}`,
        relation,
      }))),
    ...[...model.milestones.values()].flatMap((record) =>
      record.childLinks.map((relation) => ({
        owner: `milestone:${record.slug}`,
        path: record.path,
        kind: "milestone-child",
        target: `milestone:${relation.target}`,
        relation,
      }))),
    ...[...model.backlog.values()].flatMap((record) => [
      ...record.milestoneMemberships.map((relation) => ({
        owner: `backlog:${record.id}`,
        path: record.path,
        kind: "backlog-milestone",
        target: `milestone:${relation.target}`,
        relation,
      })),
      ...record.viewMemberships.map((relation) => ({
        owner: `backlog:${record.id}`,
        path: record.path,
        kind: "backlog-view",
        target: `backlog-view:${relation.target}`,
        relation,
      })),
    ]),
  ];
  for (const entry of ownerRelations) {
    const ids = relationOwners.get(entry.owner) ?? new Set<string>();
    if (ids.has(entry.relation.relationId)) {
      result.push(finding("error", "relation-id-duplicate", entry.path, entry.owner, "relation.id", `duplicate owner-local relation identity ${entry.relation.relationId}`));
    }
    ids.add(entry.relation.relationId);
    relationOwners.set(entry.owner, ids);
    if (entry.relation.state === "active") {
      const key = `${entry.owner}\0${entry.kind}\0${entry.target}`;
      if (activeEndpoints.has(key)) {
        result.push(finding("error", "relation-active-duplicate", entry.path, entry.owner, "relation", `duplicate active ${entry.kind} edge to ${entry.target}`));
      } else activeEndpoints.set(key, entry.relation.relationId);
    }
  }
  for (const edge of model.graph.historicalEdges) {
    if (edge.state === "active") {
      if (edge.from === edge.to) {
        result.push(finding("error", "relation-self-link", edge.ownerPath, edge.from, "relation", `self-link ${edge.from} is forbidden`));
      }
      if (!typedTargetExists(model, edge.to)) {
        result.push(finding("error", "relation-target-missing", edge.ownerPath, edge.from, "relation", `missing target ${edge.to}`));
      }
    }
  }
  for (const cycle of model.graph.cycles) {
    const dependencyCycle = cycle.kind === "milestone-dependency";
    const path = cycle.nodes[0] ? model.milestones.get(cycle.nodes[0])?.path ?? null : null;
    const rendered = cycle.nodes.map((node) => `milestone:${node}`).join(" -> ");
    result.push(finding(
      "error",
      dependencyCycle ? "milestone-dependency-cycle" : "milestone-cycle",
      path,
      cycle.nodes[0] ? `milestone:${cycle.nodes[0]}` : null,
      dependencyCycle ? "depends_on" : "child_links",
      dependencyCycle
        ? `Milestone dependency cycle: ${rendered}; remove the required edge(s) with control milestone update [<slug>] --remove-dependency <slug|owner=target>, repeating owner=target in one transaction when other cycles also exist.`
        : rendered,
    ));
  }

  if (model.current) {
    const pointers = new Set(model.current.checkpointCandidates);
    if (model.current.primaryCheckpointId && !pointers.has(model.current.primaryCheckpointId)) {
      result.push(finding("error", "current-primary-not-candidate", model.current.path, "current", "primary_checkpoint", "primary Checkpoint must also be in the ordered candidate list"));
    }
    for (const id of pointers) {
      const checkpoint = model.checkpoints.get(id);
      if (!checkpoint) {
        result.push(finding("error", "current-checkpoint-missing", model.current.path, "current", "active_checkpoints", `missing Checkpoint ${id}`));
      } else if (!activeCheckpoints.has(checkpoint.status)) {
        result.push(finding("error", "current-checkpoint-archived", model.current.path, "current", "active_checkpoints", `terminal Checkpoint ${id} remains an active pointer`));
      }
    }
  }

  for (const note of model.notes) {
    result.push(...relatedRefFindings(model, note.related, note.path, `note:${note.id}`, "note-related-target-missing"));
    for (const ref of note.promotedTo) {
      if (!typedTargetExists(model, ref)) {
        result.push(finding("warning", "note-promotion-target-missing", note.path, `note:${note.id}`, "promoted_to", `missing promotion target ${ref}`));
      }
    }
  }
  const foldedArtifacts = new Map<string, { kind: "decision" | "blueprint"; id: string }>();
  for (const artifact of [...model.decisions.values(), ...model.blueprints.values()]) {
    const key = `${artifact.kind}:${artifact.id.toLocaleLowerCase("en-US")}`;
    const prior = foldedArtifacts.get(key);
    if (prior) {
      result.push(finding("error", "artifact-identity-case-collision", artifact.path, `${artifact.kind}:${artifact.id}`, "identity", `case-folded identity collides with ${prior.kind}:${prior.id}`));
    } else {
      foldedArtifacts.set(key, { kind: artifact.kind, id: artifact.id });
    }
  }
  for (const artifact of [...model.decisions.values(), ...model.blueprints.values()]) {
    const terminal = artifact.kind === "decision"
      ? new Set(["rejected", "superseded"])
      : new Set(["shipped", "archived"]);
    result.push(...validateLifecycle(artifact, terminal, false, artifact.kind === "blueprint" && artifact.status === "archived"));
    result.push(...relatedRefFindings(model, artifact.related, artifact.path, `${artifact.kind}:${artifact.id}`, "artifact-related-target-missing"));
    if (artifact.kind === "decision") {
      for (const ref of artifact.supersedes) {
        if (!/^decision:DEC-\d{3,}$/.test(ref) || !typedTargetExists(model, ref)) {
          result.push(finding("error", "decision-supersedes-invalid", artifact.path, `decision:${artifact.id}`, "supersedes", `supersedes requires an existing decision:DEC-NNN reference, got ${ref}`));
        }
      }
    } else {
      for (const id of artifact.backlogIds) {
        if (!/^W-\d{3,}$/.test(id) || !model.backlog.has(id)) {
          result.push(finding("error", "blueprint-backlog-id-invalid", artifact.path, `blueprint:${artifact.id}`, "backlog_ids", `missing canonical Backlog id ${id}`));
        }
      }
      for (const id of artifact.decisionIds) {
        if (!/^DEC-\d{3,}$/.test(id) || !model.decisions.has(id)) {
          result.push(finding("error", "blueprint-decision-id-invalid", artifact.path, `blueprint:${artifact.id}`, "decision_ids", `missing canonical Decision id ${id}`));
        }
      }
      const acceptanceIds = new Set<string>();
      for (const id of artifact.acceptanceIds) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
          result.push(finding("error", "blueprint-acceptance-id-invalid", artifact.path, `blueprint:${artifact.id}`, "acceptance_ids", `acceptance id is not a stable non-empty label: ${id}`));
        } else if (acceptanceIds.has(id)) {
          result.push(finding("error", "blueprint-acceptance-id-duplicate", artifact.path, `blueprint:${artifact.id}`, "acceptance_ids", `duplicate acceptance id ${id}`));
        }
        acceptanceIds.add(id);
      }
    }
  }
  const noteIds = new Set(model.notes.map((note) => note.id));
  for (const section of model.notebook?.sections ?? []) {
    const id = section.heading.match(/\b(N-\d{3,})\b/)?.[1];
    if (id && noteIds.has(id)) {
      result.push(finding("error", "note-identity-duplicate", model.notebook!.path, `note:${id}`, "heading", `Note ${id} exists in both notebook and sharded records`));
    }
    result.push(...relatedRefFindings(model, section.related, model.notebook!.path, id ? `note:${id}` : "notebook", "note-related-target-missing"));
  }

  return result.sort((left, right) =>
    compare(left.severity, right.severity)
    || compare(left.code, right.code)
    || compare(left.path ?? "", right.path ?? "")
    || compare(left.message, right.message));
}
