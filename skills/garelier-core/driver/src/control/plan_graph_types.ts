export const PLAN_GRAPH_SCHEMA_VERSION = 3 as const;
export const PLAN_GRAPH_STORAGE = "plan_graph_markdown" as const;

export type FindingSeverity = "error" | "warning" | "info";
export type RelationState = "active" | "retired";
export type RoadmapStatus = "planned" | "active" | "paused" | "completed" | "abandoned";
export type MilestoneStatus = "planned" | "active" | "paused" | "blocked" | "shipped" | "abandoned";
export type BacklogStatus =
  | "triage"
  | "ready"
  | "active"
  | "blocked"
  | "verification"
  | "deferred"
  | "done"
  | "cancelled"
  | "superseded";
export type CheckpointStatus = "active" | "paused" | "blocked" | "completed" | "abandoned";
export type RiskStatus = "open" | "mitigating" | "accepted" | "closed" | "superseded";
export type RiskLevel = "critical" | "high" | "medium" | "low";
export type PlanGraphDecisionStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type PlanGraphBlueprintStatus = "draft" | "active" | "blocked" | "verification" | "shipped" | "archived";
export type PlanGraphNodeKind =
  | "roadmap"
  | "milestone"
  | "backlog"
  | "backlog_view"
  | "checkpoint"
  | "risk"
  | "note"
  | "decision"
  | "blueprint";

export interface PlanGraphFinding {
  severity: FindingSeverity;
  code: string;
  path: string | null;
  entity: string | null;
  field: string | null;
  message: string;
}

export interface LifecycleMeta {
  created: string;
  updated: string;
  statusChanged?: string;
  closed?: string;
  archived?: string;
}

export interface RelationLifecycle {
  relationId: string;
  state: RelationState;
  added: string;
  updated: string;
  retired?: string;
  retireReason?: string;
}

export interface CanonicalMarkdownRecord extends LifecycleMeta {
  schemaVersion: 3;
  path: string;
  source: string;
  body: string;
  frontmatterSource: string;
  frontmatter: Readonly<Record<string, unknown>>;
}

export interface RoadmapMilestoneLink extends RelationLifecycle {
  target: string;
  track: string | null;
  order: number;
  relation: string;
  required: boolean;
}

export interface MilestoneChildLink extends RelationLifecycle {
  target: string;
  order: number;
  relation: string;
  required: boolean;
}

export interface BacklogMilestoneMembership extends RelationLifecycle {
  target: string;
  relation: string;
}

export interface BacklogViewMembership extends RelationLifecycle {
  target: string;
  order: number;
}

export interface BacklogViewRecord extends CanonicalMarkdownRecord {
  kind: "backlog_view";
  slug: string;
  status: "active" | "retired";
}

export interface RoadmapRecord extends CanonicalMarkdownRecord {
  kind: "roadmap";
  slug: string;
  status: RoadmapStatus;
  milestoneLinks: RoadmapMilestoneLink[];
}

export interface MilestoneRecord extends CanonicalMarkdownRecord {
  kind: "milestone";
  slug: string;
  status: MilestoneStatus;
  dependsOn: string[];
  legacyDependencyTargets: string[];
  childLinks: MilestoneChildLink[];
}

export interface BacklogRecord extends CanonicalMarkdownRecord {
  kind: "backlog";
  id: string;
  title: string;
  titleCanonical: boolean;
  status: BacklogStatus;
  milestone: "none" | null;
  inheritMilestones: boolean;
  milestoneMemberships: BacklogMilestoneMembership[];
  viewMemberships: BacklogViewMembership[];
  dependsOn: string[];
  blockedBy: string[];
  related: string[];
  replacement: string | null;
  currentPosition: string;
  exactNextAction: string;
  evidence: string;
}

export interface CheckpointRecord extends CanonicalMarkdownRecord {
  kind: "checkpoint";
  id: string;
  status: CheckpointStatus;
  roadmaps: string[];
  milestones: string[];
  backlog: string[];
  related: string[];
  branch: string | null;
  head: string | null;
  workingTree: string | null;
  gitStatusHash: string | null;
  stagedPaths: string[];
  modifiedPaths: string[];
  untrackedPaths: string[];
  action: CheckpointActionRecord | null;
  lastCompleted: string;
  exactNextAction: string;
  blockers: string;
  unresolvedAssumptions: string;
  knownGoodBaseline: string;
  readFirst: string[];
  resumeVerification: string;
}

export interface CheckpointActionRecord {
  token: string;
  preparedAt: string;
  exactNextAction: string;
  before: string;
  success: string;
  targets: string[];
}

export interface RiskRecord extends CanonicalMarkdownRecord {
  kind: "risk";
  id: string;
  status: RiskStatus;
  severity: RiskLevel;
  likelihood: RiskLevel;
  related: string[];
  mitigationBacklog: string[];
  evidence: string;
}

export interface MarkdownSection {
  level: 2 | 3;
  heading: string;
  startLine: number;
  endLine: number;
  body: string;
  related: string[];
}

export interface NoteRecord extends CanonicalMarkdownRecord {
  kind: "note";
  id: string;
  status: string;
  related: string[];
  promotedTo: string[];
  sections: MarkdownSection[];
}

export interface NotebookRecord {
  kind: "notebook";
  path: string;
  source: string;
  sections: MarkdownSection[];
}

export interface PlanGraphArtifactRecord extends CanonicalMarkdownRecord {
  kind: "decision" | "blueprint";
  id: string;
  title: string;
  status: PlanGraphDecisionStatus | PlanGraphBlueprintStatus;
  related: string[];
  supersedes: string[];
  backlogIds: string[];
  decisionIds: string[];
  acceptanceIds: string[];
}

export interface CurrentRecord {
  path: string;
  source: string;
  sections: MarkdownSection[];
  standingInstructions: string;
  currentPosition: string;
  blockers: string;
  readFirst: string[];
  primaryCheckpointId: string | null;
  checkpointCandidates: string[];
}

export interface PlanGraphEdge {
  from: string;
  to: string;
  kind: string;
  relationId: string;
  state: RelationState;
  ownerPath: string;
}

export interface PlanGraphCycle {
  kind: "milestone-containment" | "milestone-dependency";
  nodes: string[];
}

export interface PlanGraph {
  nodes: Array<{ id: string; kind: PlanGraphNodeKind; path: string; status: string }>;
  edges: PlanGraphEdge[];
  historicalEdges: PlanGraphEdge[];
  cycles: PlanGraphCycle[];
  roadmapsByMilestone: Map<string, string[]>;
  parentsByMilestone: Map<string, string[]>;
  childrenByMilestone: Map<string, string[]>;
  backlogByMilestone: Map<string, string[]>;
  backlogByView: Map<string, string[]>;
  checkpointsByEntity: Map<string, string[]>;
  notesByEntity: Map<string, string[]>;
  risksByEntity: Map<string, string[]>;
}

export interface PlanGraphControlConfig {
  schemaVersion: 3;
  storage: "plan_graph_markdown";
  pmId: string;
  mode: "full" | "control_only";
  maxResumeBytes: number;
  source: string;
}

export interface PlanGraphControlModel {
  schemaVersion: 3;
  storage: "plan_graph_markdown";
  controlRoot: string;
  revision: string;
  config: PlanGraphControlConfig | null;
  current: CurrentRecord | null;
  roadmaps: Map<string, RoadmapRecord>;
  milestones: Map<string, MilestoneRecord>;
  backlog: Map<string, BacklogRecord>;
  backlogViews: Map<string, BacklogViewRecord>;
  checkpoints: Map<string, CheckpointRecord>;
  risks: Map<string, RiskRecord>;
  notes: NoteRecord[];
  notebook: NotebookRecord | null;
  decisions: Map<string, PlanGraphArtifactRecord>;
  blueprints: Map<string, PlanGraphArtifactRecord>;
  graph: PlanGraph;
  findings: PlanGraphFinding[];
  sources: Map<string, string>;
}

export interface PlanGraphStoreLimits {
  maxEntities: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxArchiveDepth: number;
}

export const DEFAULT_PLAN_GRAPH_LIMITS: PlanGraphStoreLimits = {
  maxEntities: 5_000,
  maxFileBytes: 8_388_608,
  maxTotalBytes: 67_108_864,
  maxArchiveDepth: 2,
};

export interface RepositoryState {
  branch: string;
  head: string;
  workingTree: string;
  statusHash?: string;
  staged?: string[];
  modified?: string[];
  untracked?: string[];
}

export interface ResumeCheckpointProjection {
  id: string;
  status: CheckpointStatus;
  path: string;
  exact_next_action: string;
  last_completed: string;
  blockers: string;
  unresolved_assumptions: string;
  last_verified_baseline: string;
  branch: string | null;
  head: string | null;
  working_tree: string | null;
  git_status_hash: string | null;
  staged_paths: string[];
  modified_paths: string[];
  untracked_paths: string[];
  active_action: {
    token: string;
    prepared_at: string;
    exact_next_action: string;
    before: string;
    success: string;
    targets: string[];
  } | null;
  roadmaps: string[];
  milestones: string[];
  backlog: string[];
  read_first: string[];
  resume_verification: string;
}

export interface PlanGraphResumePacket {
  schema_version: 1;
  control_schema_version: 3;
  storage: "plan_graph_markdown";
  control_revision: string;
  current: {
    standing_instructions: string;
    position: string;
    blockers: string;
    primary_checkpoint_id: string | null;
  };
  primary_checkpoint: ResumeCheckpointProjection | null;
  blocked_checkpoints: ResumeCheckpointProjection[];
  checkpoint_candidates: ResumeCheckpointProjection[];
  backlog: Array<{
    id: string;
    status: BacklogStatus;
    path: string;
    current_position: string;
    exact_next_action: string;
    milestones: string[];
  }>;
  milestones: Array<{ slug: string; status: MilestoneStatus; parents: string[]; roadmaps: string[] }>;
  roadmaps: Array<{ slug: string; status: RoadmapStatus }>;
  relevant_decisions: Array<{ id: string; status: string; path: string; body: string; related: string[] }>;
  relevant_blueprints: Array<{ id: string; status: string; path: string; body: string; related: string[] }>;
  relevant_reports: Array<{ path: string; body: string }>;
  relevant_notes: Array<{ path: string; heading: string; body: string; related: string[] }>;
  quality_gates: { path: string; body: string };
  read_first: string[];
  repository: {
    recorded: RepositoryState | null;
    actual: RepositoryState | null;
    drift: boolean;
  };
  diagnostics: { errors: number; warnings: number; findings: PlanGraphFinding[] };
  omitted: {
    backlog: number;
    checkpoint_candidates: number;
    milestones: number;
    notes: number;
    decisions: number;
    blueprints: number;
    reports: number;
    read_first: number;
    roadmaps: number;
  };
  truncation: {
    omitted_bytes: number;
    field_count: number;
    fields: string[];
    unlisted_fields: number;
  };
  queries: string[];
}

export interface PlanGraphContextNeighborhood {
  root: string;
  depth: number;
  nodes: PlanGraph["nodes"];
  links: PlanGraphEdge[];
}
