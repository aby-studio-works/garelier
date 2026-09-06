import { parse as parseToml } from "smol-toml";
import {
  markdownSections,
  parseControlFrontmatter,
  sectionBody,
  typedReferences,
} from "./control_frontmatter.ts";
import type {
  BacklogMilestoneMembership,
  BacklogRecord,
  BacklogStatus,
  BacklogViewMembership,
  BacklogViewRecord,
  CanonicalMarkdownRecord,
  CheckpointActionRecord,
  CheckpointRecord,
  CheckpointStatus,
  CurrentRecord,
  LifecycleMeta,
  MilestoneChildLink,
  MilestoneRecord,
  MilestoneStatus,
  NotebookRecord,
  NoteRecord,
  PlanGraphArtifactRecord,
  PlanGraphBlueprintStatus,
  PlanGraphControlConfig,
  PlanGraphDecisionStatus,
  RelationLifecycle,
  RelationState,
  RoadmapMilestoneLink,
  RoadmapRecord,
  RoadmapStatus,
  RiskLevel,
  RiskRecord,
  RiskStatus,
} from "./plan_graph_types.ts";

export class PlanGraphSchemaError extends Error {
  constructor(message: string, readonly path: string, readonly field: string | null = null) {
    super(`${path}${field ? ` (${field})` : ""}: ${message}`);
    this.name = "PlanGraphSchemaError";
  }
}

type ObjectValue = Record<string, unknown>;

const ROADMAP_STATUSES = ["planned", "active", "paused", "completed", "abandoned"] as const;
const MILESTONE_STATUSES = ["planned", "active", "paused", "blocked", "shipped", "abandoned"] as const;
const BACKLOG_STATUSES = ["triage", "ready", "active", "blocked", "verification", "deferred", "done", "cancelled", "superseded"] as const;
const BACKLOG_VIEW_STATUSES = ["active", "retired"] as const;
const CHECKPOINT_STATUSES = ["active", "paused", "blocked", "completed", "abandoned"] as const;
const RISK_STATUSES = ["open", "mitigating", "accepted", "closed", "superseded"] as const;
const RISK_LEVELS = ["critical", "high", "medium", "low"] as const;
const DECISION_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
const BLUEPRINT_STATUSES = ["draft", "active", "blocked", "verification", "shipped", "archived"] as const;

export interface BacklogTitleProjection {
  title: string;
  canonical: boolean;
}

export function extractBacklogTitle(
  body: string,
  id: string,
  path = "backlog",
): BacklogTitleProjection {
  const heading = body.replace(/\r\n/g, "\n").split("\n")
    .find((line) => /^#\s+/.test(line));
  const canonical = heading?.match(/^#\s+(W-\d+):\s*(.+?)\s*$/);
  if (canonical) {
    if (canonical[1] !== id) {
      throw new PlanGraphSchemaError(`H1 identity ${canonical[1]} does not match ${id}`, path, "title");
    }
    return { title: canonical[2]!.trim(), canonical: true };
  }
  const malformedIdentity = heading?.match(/^#\s+(W-\d+)\s*:/);
  if (malformedIdentity) {
    throw new PlanGraphSchemaError(`H1 must match "# ${id}: <title>"`, path, "title");
  }
  const title = heading?.match(/^#\s+(.+?)\s*$/)?.[1]?.trim() ?? "";
  if (!title) throw new PlanGraphSchemaError("H1 title must not be empty", path, "title");
  return { title, canonical: false };
}

export function canonicalBacklogTitle(body: string, id: string, path = "backlog"): string {
  return extractBacklogTitle(body, id, path).title;
}

function object(value: unknown, path: string, field: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlanGraphSchemaError("must be a TOML table", path, field);
  }
  return value as ObjectValue;
}

function string(value: unknown, path: string, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new PlanGraphSchemaError("must be a string", path, field);
  return value;
}

function optionalString(value: unknown, path: string, field: string): string | undefined {
  if (value === undefined || value === null || value === "-") return undefined;
  return string(value, path, field);
}

function strings(value: unknown, path: string, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new PlanGraphSchemaError("must be an array of strings", path, field);
  }
  return [...value] as string[];
}

function boolean(value: unknown, path: string, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new PlanGraphSchemaError("must be a boolean", path, field);
  return value;
}

function integer(value: unknown, path: string, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new PlanGraphSchemaError("must be an integer", path, field);
  return value as number;
}

function enumeration<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new PlanGraphSchemaError(`must be one of: ${allowed.join(", ")}`, path, field);
  }
  return value as T;
}

function recordBase(
  source: string,
  path: string,
  expectedKind: string,
): { parsed: ReturnType<typeof parseControlFrontmatter>; lifecycle: LifecycleMeta } {
  const parsed = parseControlFrontmatter(source, path);
  if (parsed.data.schema_version !== 3) throw new PlanGraphSchemaError("schema_version must be 3", path, "schema_version");
  if (parsed.data.kind !== expectedKind) throw new PlanGraphSchemaError(`kind must be ${expectedKind}`, path, "kind");
  return {
    parsed,
    lifecycle: {
      created: string(parsed.data.created, path, "created"),
      updated: string(parsed.data.updated, path, "updated"),
      statusChanged: optionalString(parsed.data.status_changed, path, "status_changed"),
      closed: optionalString(parsed.data.closed, path, "closed"),
      archived: optionalString(parsed.data.archived, path, "archived"),
    },
  };
}

function canonical(
  source: string,
  path: string,
  parsed: ReturnType<typeof parseControlFrontmatter>,
  lifecycle: LifecycleMeta,
): CanonicalMarkdownRecord {
  return {
    schemaVersion: 3,
    path,
    source,
    body: parsed.body,
    frontmatterSource: parsed.frontmatterSource,
    frontmatter: parsed.data,
    ...lifecycle,
  };
}

function relationLifecycle(row: ObjectValue, path: string, field: string): RelationLifecycle {
  const relationId = string(row.id ?? row.rel ?? row.relation_id, path, `${field}.id`);
  if (!/^rel-\d{3,}$/.test(relationId)) {
    throw new PlanGraphSchemaError("relation identity must match rel-NNN", path, `${field}.id`);
  }
  const state = enumeration(row.state, ["active", "retired"] as const, path, `${field}.state`);
  return {
    relationId,
    state,
    added: string(row.added, path, `${field}.added`),
    updated: string(row.updated, path, `${field}.updated`),
    retired: optionalString(row.retired, path, `${field}.retired`),
    retireReason: optionalString(row.retire_reason, path, `${field}.retire_reason`),
  };
}

function relationRows(value: unknown, path: string, field: string): ObjectValue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PlanGraphSchemaError("must be an array of TOML tables", path, field);
  return value.map((entry, index) => object(entry, path, `${field}[${index}]`));
}

export function parsePlanGraphControlConfig(source: string, path = "control.toml"): PlanGraphControlConfig {
  let decoded: unknown;
  try {
    decoded = parseToml(source);
  } catch (error) {
    throw new PlanGraphSchemaError(`malformed TOML: ${(error as Error).message}`, path);
  }
  const root = object(decoded, path, "root");
  if (root.schema_version !== 3) throw new PlanGraphSchemaError("schema_version must be 3", path, "schema_version");
  if (root.storage !== "plan_graph_markdown") throw new PlanGraphSchemaError("storage must be plan_graph_markdown", path, "storage");
  if (root.kind !== "garelier_control") throw new PlanGraphSchemaError("kind must be garelier_control", path, "kind");
  const control = root.control === undefined ? {} : object(root.control, path, "control");
  // `control_only` is retained on purpose after W-314 — this is the rejection
  // point that would make existing namespaces unreadable. See ControlMode in
  // ./types.ts for why removing it needs its own DEC + migration.
  const mode = enumeration(root.mode, ["full", "control_only"] as const, path, "mode");
  const maxResumeBytes = integer(control.max_resume_bytes, path, "control.max_resume_bytes", 24_576);
  if (maxResumeBytes < 1_024) throw new PlanGraphSchemaError("must be at least 1024", path, "control.max_resume_bytes");
  return {
    schemaVersion: 3,
    storage: "plan_graph_markdown",
    pmId: string(root.pm_id, path, "pm_id"),
    mode,
    maxResumeBytes,
    source,
  };
}

export function parseRoadmapRecord(source: string, path: string): RoadmapRecord {
  const { parsed, lifecycle } = recordBase(source, path, "garelier_roadmap");
  const links: RoadmapMilestoneLink[] = relationRows(parsed.data.milestone_links, path, "milestone_links").map((row, index) => ({
    ...relationLifecycle(row, path, `milestone_links[${index}]`),
    target: string(row.slug, path, `milestone_links[${index}].slug`),
    track: optionalString(row.track, path, `milestone_links[${index}].track`) ?? null,
    order: integer(row.order, path, `milestone_links[${index}].order`, index),
    relation: string(row.relation, path, `milestone_links[${index}].relation`, "root"),
    required: boolean(row.required, path, `milestone_links[${index}].required`, true),
  }));
  return {
    ...canonical(source, path, parsed, lifecycle),
    kind: "roadmap",
    slug: string(parsed.data.slug, path, "slug"),
    status: enumeration(parsed.data.status, ROADMAP_STATUSES, path, "status") as RoadmapStatus,
    milestoneLinks: links,
  };
}

export function parseMilestoneRecord(source: string, path: string): MilestoneRecord {
  const { parsed, lifecycle } = recordBase(source, path, "garelier_milestone");
  const links: MilestoneChildLink[] = relationRows(parsed.data.child_links, path, "child_links").map((row, index) => ({
    ...relationLifecycle(row, path, `child_links[${index}]`),
    target: string(row.slug, path, `child_links[${index}].slug`),
    order: integer(row.order, path, `child_links[${index}].order`, index),
    relation: string(row.relation, path, `child_links[${index}].relation`, "contains"),
    required: boolean(row.required, path, `child_links[${index}].required`, true),
  }));
  return {
    ...canonical(source, path, parsed, lifecycle),
    kind: "milestone",
    slug: string(parsed.data.slug, path, "slug"),
    status: enumeration(parsed.data.status, MILESTONE_STATUSES, path, "status") as MilestoneStatus,
    dependsOn: strings(parsed.data.depends_on, path, "depends_on"),
    legacyDependencyTargets: strings(parsed.data.dependency_targets, path, "dependency_targets"),
    childLinks: links,
  };
}

export function parseBacklogRecord(source: string, path: string): BacklogRecord {
  const { parsed, lifecycle } = recordBase(source, path, "garelier_backlog");
  const sections = markdownSections(parsed.body);
  const id = string(parsed.data.id, path, "id");
  const title = extractBacklogTitle(parsed.body, id, path);
  const milestone = optionalString(parsed.data.milestone, path, "milestone") ?? null;
  if (milestone !== null && milestone !== "none") {
    throw new PlanGraphSchemaError('milestone must be the explicit cross-cutting marker "none" when present', path, "milestone");
  }
  const milestoneMemberships: BacklogMilestoneMembership[] = relationRows(
    parsed.data.milestone_memberships,
    path,
    "milestone_memberships",
  ).map((row, index) => ({
    ...relationLifecycle(row, path, `milestone_memberships[${index}]`),
    target: string(row.slug, path, `milestone_memberships[${index}].slug`),
    relation: string(row.relation, path, `milestone_memberships[${index}].relation`, "contributes"),
  }));
  const viewMemberships: BacklogViewMembership[] = relationRows(
    parsed.data.view_memberships,
    path,
    "view_memberships",
  ).map((row, index) => ({
    ...relationLifecycle(row, path, `view_memberships[${index}]`),
    target: string(row.slug, path, `view_memberships[${index}].slug`),
    order: integer(row.order, path, `view_memberships[${index}].order`, index),
  }));
  return {
    ...canonical(source, path, parsed, lifecycle),
    kind: "backlog",
    id,
    title: title.title,
    titleCanonical: title.canonical,
    status: enumeration(parsed.data.status, BACKLOG_STATUSES, path, "status") as BacklogStatus,
    milestone,
    inheritMilestones: boolean(parsed.data.inherit_milestones, path, "inherit_milestones", true),
    milestoneMemberships,
    viewMemberships,
    dependsOn: strings(parsed.data.depends_on, path, "depends_on"),
    blockedBy: strings(parsed.data.blocked_by, path, "blocked_by"),
    related: strings(parsed.data.related, path, "related"),
    replacement: optionalString(
      parsed.data.replacement ?? parsed.data.superseded_by,
      path,
      "replacement",
    ) ?? null,
    currentPosition: sectionBody(sections, "Current position"),
    exactNextAction: sectionBody(sections, "Exact next action")
      || labelledField(sectionBody(sections, "Current position"), "Exact next action"),
    evidence: sectionBody(sections, "Evidence"),
  };
}

export function parseBacklogViewRecord(source: string, path: string): BacklogViewRecord {
  const { parsed, lifecycle } = recordBase(source, path, "garelier_backlog_view");
  return {
    ...canonical(source, path, parsed, lifecycle),
    kind: "backlog_view",
    slug: string(parsed.data.slug, path, "slug"),
    status: enumeration(parsed.data.status, BACKLOG_VIEW_STATUSES, path, "status") as BacklogViewRecord["status"],
  };
}

function bodyReadFirst(source: string): string[] {
  return [...new Set([
    ...typedReferences(source),
    ...[...source.matchAll(/`([^`\r\n]+(?:\/[^`\r\n]+)+)`/g)].map((match) => match[1]!),
  ])];
}

function labelledField(source: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = source.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?${escaped}\\s*:\\s*(.*)$`, "i");
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(pattern);
    if (!match) continue;
    if (match[1]!.trim()) return match[1]!.trim();
    const continuation: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const line = lines[cursor]!;
      if (/^\s*(?:[-*]\s*)?[A-Za-z][^:]{0,60}:\s*/.test(line) || /^#{1,6}\s/.test(line)) break;
      continuation.push(line);
    }
    return continuation.join("\n").trim();
  }
  return "";
}

function checkpointAction(value: unknown, path: string): CheckpointActionRecord | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlanGraphSchemaError("must be a table", path, "action");
  }
  const data = value as Record<string, unknown>;
  const token = string(data.token, path, "action.token");
  if (!/^sha256:[0-9a-f]{64}$/.test(token)) throw new PlanGraphSchemaError("must be a sha256 token", path, "action.token");
  const preparedAt = string(data.prepared_at, path, "action.prepared_at");
  if (!Number.isFinite(Date.parse(preparedAt))) throw new PlanGraphSchemaError("must be an RFC3339 timestamp", path, "action.prepared_at");
  const targets = strings(data.targets, path, "action.targets");
  if (!targets.length) throw new PlanGraphSchemaError("must contain at least one target", path, "action.targets");
  return {
    token,
    preparedAt,
    exactNextAction: string(data.exact_next_action, path, "action.exact_next_action"),
    before: string(data.before, path, "action.before"),
    success: string(data.success, path, "action.success"),
    targets,
  };
}

export function parseCheckpointRecord(source: string, path: string): CheckpointRecord {
  const { parsed, lifecycle } = recordBase(source, path, "garelier_checkpoint");
  const sections = markdownSections(parsed.body);
  return {
    ...canonical(source, path, parsed, lifecycle),
    kind: "checkpoint",
    id: string(parsed.data.id, path, "id"),
    status: enumeration(parsed.data.status, CHECKPOINT_STATUSES, path, "status") as CheckpointStatus,
    roadmaps: strings(parsed.data.roadmaps, path, "roadmaps"),
    milestones: strings(parsed.data.milestones, path, "milestones"),
    backlog: strings(parsed.data.backlog, path, "backlog"),
    related: strings(parsed.data.related, path, "related"),
    branch: optionalString(parsed.data.branch, path, "branch") ?? null,
    head: optionalString(parsed.data.head, path, "head") ?? null,
    workingTree: optionalString(parsed.data.working_tree, path, "working_tree") ?? null,
    gitStatusHash: optionalString(parsed.data.git_status_hash, path, "git_status_hash") ?? null,
    stagedPaths: strings(parsed.data.staged_paths, path, "staged_paths"),
    modifiedPaths: strings(parsed.data.modified_paths, path, "modified_paths"),
    untrackedPaths: strings(parsed.data.untracked_paths, path, "untracked_paths"),
    action: checkpointAction(parsed.data.action, path),
    lastCompleted: sectionBody(sections, "Last completed"),
    exactNextAction: sectionBody(sections, "Exact next action"),
    blockers: sectionBody(sections, "Blockers / external decisions"),
    unresolvedAssumptions: sectionBody(sections, "Decisions and assumptions made during this checkpoint"),
    knownGoodBaseline: sectionBody(sections, "Known-good baseline"),
    readFirst: bodyReadFirst(sectionBody(sections, "Read first on resume")),
    resumeVerification: sectionBody(sections, "Resume verification"),
  };
}

export function parseRiskRecord(source: string, path: string): RiskRecord {
  const { parsed, lifecycle } = recordBase(source, path, "garelier_risk");
  const sections = markdownSections(parsed.body);
  return {
    ...canonical(source, path, parsed, lifecycle),
    kind: "risk",
    id: string(parsed.data.id, path, "id"),
    status: enumeration(parsed.data.status, RISK_STATUSES, path, "status") as RiskStatus,
    severity: enumeration(parsed.data.severity, RISK_LEVELS, path, "severity") as RiskLevel,
    likelihood: enumeration(parsed.data.likelihood, RISK_LEVELS, path, "likelihood") as RiskLevel,
    related: strings(parsed.data.related, path, "related"),
    mitigationBacklog: strings(parsed.data.mitigation_backlog, path, "mitigation_backlog"),
    evidence: sectionBody(sections, "Evidence"),
  };
}

export function parseNoteRecord(source: string, path: string): NoteRecord {
  const { parsed, lifecycle } = recordBase(source, path, "garelier_note");
  return {
    ...canonical(source, path, parsed, lifecycle),
    kind: "note",
    id: string(parsed.data.id, path, "id"),
    status: string(parsed.data.status, path, "status"),
    related: strings(parsed.data.related, path, "related"),
    promotedTo: strings(parsed.data.promoted_to, path, "promoted_to"),
    sections: markdownSections(parsed.body),
  };
}

export function parseArtifactRecord(
  source: string,
  path: string,
  kind: "decision" | "blueprint",
): PlanGraphArtifactRecord {
  const expectedKinds = kind === "decision"
    ? new Set(["garelier_decision", "decision"])
    : new Set(["garelier_blueprint", "blueprint"]);
  const parsed = parseControlFrontmatter(source, path);
  if (parsed.data.schema_version !== 3) throw new PlanGraphSchemaError("schema_version must be 3", path, "schema_version");
  if (!expectedKinds.has(String(parsed.data.kind))) {
    throw new PlanGraphSchemaError(`kind does not match ${kind}`, path, "kind");
  }
  const lifecycle: LifecycleMeta = {
    created: string(parsed.data.created, path, "created"),
    updated: string(parsed.data.updated, path, "updated"),
    statusChanged: optionalString(parsed.data.status_changed, path, "status_changed"),
    closed: optionalString(parsed.data.closed, path, "closed"),
    archived: optionalString(parsed.data.archived, path, "archived"),
  };
  return {
    ...canonical(source, path, parsed, lifecycle),
    kind,
    id: string(kind === "decision" ? parsed.data.id : parsed.data.slug, path, kind === "decision" ? "id" : "slug"),
    title: string(parsed.data.title, path, "title", "-"),
    status: kind === "decision"
      ? enumeration(parsed.data.status, DECISION_STATUSES, path, "status") as PlanGraphDecisionStatus
      : enumeration(parsed.data.status, BLUEPRINT_STATUSES, path, "status") as PlanGraphBlueprintStatus,
    related: strings(parsed.data.related, path, "related"),
    supersedes: kind === "decision" ? strings(parsed.data.supersedes, path, "supersedes") : [],
    backlogIds: kind === "blueprint" ? strings(parsed.data.backlog_ids, path, "backlog_ids") : [],
    decisionIds: kind === "blueprint" ? strings(parsed.data.decision_ids, path, "decision_ids") : [],
    acceptanceIds: kind === "blueprint" ? strings(parsed.data.acceptance_ids, path, "acceptance_ids") : [],
  };
}

export function parseNotebook(source: string, path = "project_dashboard/notes.md"): NotebookRecord {
  return { kind: "notebook", path, source, sections: markdownSections(source) };
}

function checkpointRefs(source: string): string[] {
  return [...source.matchAll(/\b(?:checkpoint:)?(CP-\d{3,})\b/g)].map((match) => match[1]!);
}

export function parseCurrentRecord(source: string, path = "project_dashboard/current.md"): CurrentRecord {
  const sections = markdownSections(source);
  const legacySection = (heading: string): string => {
    const exact = sectionBody(sections, heading);
    if (exact) return exact;
    const prefix = `${heading.trim().toLowerCase()} (`;
    return sections.find((section) => section.heading.trim().toLowerCase().startsWith(prefix))?.body ?? "";
  };
  const activeSource = sectionBody(sections, "Active checkpoints");
  const primaryMatch = activeSource.match(/Primary\s+checkpoint\s*:\s*`?(?:checkpoint:)?(CP-\d{3,})`?/i);
  const candidates = [...new Set(checkpointRefs(activeSource.replace(/^.*Primary\s+checkpoint.*$/gim, "")))];
  const currentPosition = sectionBody(sections, "Current position")
    || legacySection("Active focus");
  const blockers = sectionBody(sections, "Blockers and decisions required")
    || sectionBody(sections, "Blockers")
    || sectionBody(sections, "Blocker");
  return {
    path,
    source,
    sections,
    standingInstructions: sectionBody(sections, "Standing instructions"),
    currentPosition,
    blockers,
    readFirst: bodyReadFirst(sectionBody(sections, "Read first")),
    primaryCheckpointId: primaryMatch?.[1] ?? null,
    checkpointCandidates: candidates,
  };
}
