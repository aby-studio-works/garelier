// Shared types for the read-only Status Web Console (Phase 1+).
//
// The console never mutates state and never calls an AI provider. These
// types describe the best-effort snapshot the server builds from runtime
// files. Anything unreadable becomes a warning, not an exception.

import type { RoleKind } from "./role_contracts.ts";
import type {
  RiskLevel,
} from "./control/types.ts";
export type { RoleKind };

export type ExecutionState = "idle" | "artisan" | "dock" | "mixed" | "unknown";
/** @deprecated Use ExecutionState. */
export type LaneState = ExecutionState;

export type HealthColor = "green" | "blue" | "yellow" | "red" | "gray";

export interface LaneInfo {
  state: LaneState;
  owner: string | null;
  taskId: string | null;
  branch: string | null;
  targetBranch: string | null;
  startedAt: string | null;
  status: string | null;
  stale: boolean;
}

export interface RoleInfo {
  kind: RoleKind;
  id: string | null;
  provider: string | null;
  model: string | null;
  state: string;          // STATE.md status or "configured" / "supervised" / "unknown"
  branch: string | null;
  // The role's own one-line "what am I working on" (STATE.md "## Current task",
  // e.g. "#25 — server_room reliable-resend flake repro"). Lets the console show
  // which WORK each role drives, not just its state. Display-only.
  task: string | null;
  warnings: string[];
}

export interface MergeGateInfo {
  state: "idle" | "running" | "passed" | "failed" | "environment_blocked" | "conflict" | "stale_base" | "unknown";
  active: boolean;
  pendingRequests: number;
  pendingResults: number;
  lastResult: string | null;
  executionRoutes: Array<"dock" | "artisan" | "unknown">;
}

export interface ReportInfo {
  role: string;
  agentId: string | null;
  path: string;             // display path ("__garelier/<pm_id>/...")
  rel: string | null;       // repo-relative real path (openable via /api/file); null if outside the project (exile)
  updatedAt: string | null;
  summary: string;          // first non-empty lines, redacted
}

export interface RoutineInfo {
  id: string;
  title?: string;
  manual?: string;
  manualRel?: string;       // manual resolved to a repo-relative path (viewer), if it exists
  defaultRole?: string;
  targetFile?: string;
  targetFileRel?: string;   // target_file resolved to a repo-relative path (viewer), if it exists
  sourceId?: string;
  trigger?: string;
  risk?: string;
}

export interface SourceInfo {
  id: string;
  title?: string;
  kind?: string;
  sourceType?: string;
  target?: string;
  targetRel?: string;       // target resolved to a repo-relative path (viewer), if it exists
  updateMode?: string;
  trust?: string;
  authority?: string;
  license?: string;
  use?: string;
  lastSyncedAt?: string;
  lastReviewedAt?: string;
  url?: string;             // possibly domain-only depending on config
}

// One selectable lens group from the shared lens registry
// (__garelier/__atmos/lenses/lens_registry.toml). A lens changes a role's judgment
// focus only — never its authority.
export interface LensInfo {
  packId: string;
  role?: string;
  groupId: string;
  status?: string;
  label?: string;
  description?: string;
  isDefault?: boolean;      // group is the pack's registry default_group
  packPathRel?: string;     // repo-relative path to the pack TOML (viewer)
}

export type WarningKind =
  | "stale_pid"
  | "legacy_lane_lock"
  | "failed_quality_gate"
  | "environment_blocked"
  | "unresolved_review"
  | "missing_assignment"
  | "missing_report"
  | "rate_limited"
  | "stale_source_registry"
  | "missing_routine_manual"
  | "idle_with_pending"
  | "dispatch_hold"
  | "plant_error"
  | "snapshot_error"
  | "merge_gate_active_commit_guard";

// A dispatch HOLD parks the pipeline (PM directive: "do not dispatch milestone X
// until explicitly resumed"). Without surfacing it, an idle run looks broken: the
// watcher cannot tell WHY nothing is moving. This makes the hold first-class so
// "why is it stopped?" is answerable at a glance.
export interface DispatchHoldInfo {
  active: boolean;
  scope: string | null;     // held milestone/slug if parseable (e.g. "m4")
  reason: string | null;    // short human reason (directive heading / DO-NOT line)
  rel: string | null;       // repo-relative openable path to the directive (/api/file)
  issuedAt: string | null;  // ISO timestamp if the directive declares one
  source: "marker" | "inbox" | null; // canonical marker vs heuristic inbox directive
}

export interface Warning {
  kind: WarningKind;
  path?: string;
  message: string;
}

export interface BranchInfo {
  target: string | null;
  studio: string | null;
  activeBranch: string | null;
}

export interface PlantInfo {
  mode: "lithosphere" | "crust" | "unknown";
  controlRoot: string | null;
  targetRoot: string | null;
  workfolderRoot: string | null;
  containerId: string | null;
  issues: { level: "error" | "warn"; code: string; message: string; path?: string }[];
}

// usage JSONL (no new capture, no provider calls). The optimization axis is
// "more useful work per unit of capacity" at the user's FIXED
// model/effort — so this surfaces where tokens go and how well the prompt cache
// "PM action needed" surface — so a watcher can SEE when work is stuck awaiting
// a PM decision without reading runtime files by hand. The hard signal is a role
// in BLOCKED state or one that raised a `questions.md`; the PM inbox (Dock →
// PM escalations) is shown as a review queue alongside it.
export interface PmActionItem {
  kind: "blocked_agent" | "question" | "inbox" | "guard_report" | "merge_stalled" | "record_supply_gap" | "gate_name_mismatch" | "reporting_unhandled";
  role: string | null;
  agentId: string | null;
  summary: string;          // questions.md first heading / inbox topic (redacted)
  rel: string | null;       // repo-relative openable path (/api/file), or null
  since: string | null;     // mtime ISO
  dispatchId?: string;      // reporting_unhandled dispatch id
  workId?: string | null;   // reporting_unhandled bound Control work
  elapsedMinutes?: number;  // reporting_unhandled age at snapshot time
}
export interface PmActionInfo {
  needed: boolean;          // true when any role is BLOCKED, has a questions.md, or an open guard report
  blockedAgents: number;
  openQuestions: number;
  inboxItems: number;       // files in runtime/pm/inbox/ (Dock→PM review queue)
  guardReports: number;     // W-164: open command_guard deny/ask reports in incidents.jsonl
  mergeStalled: number;     // W-175: queued merge-gate requests with no live runner (drain stall)
  recordSupplyGaps: number; // W-176: agents with N+ guard asks (likely a missing dispatch record)
  gateNameMismatch: number; // W-168: hand-made gate seat names not matching a declared gate_agent
  reportingUnhandled: number; // W-594: provider reported, but PM has not started proxy/gate handling
  items: PmActionItem[];    // blocked/question items first, then guard reports, then recent inbox
}

// ---- Dispatch activity (DEC-057): live subagent dispatches + recent log ----
export interface DispatchEvent {
  ts: string | null;     // ISO timestamp the event was recorded
  role: string;          // worker-01 / scout-01 / artisan / dock / ...
  kind: string;          // start | complete | blocked | note
  task: string | null;   // assignment id / one-line task
  ref: string | null;    // report / inspection artifact path
}

export interface DispatchInProgress {
  role: string;
  kind?: RoleKind;
  state: string;         // ASSIGNED | WORKING | REPORTING | BLOCKED
  task: string | null;
}

export interface DispatchActivityInfo {
  // Roles currently mid-dispatch (non-idle STATE) — live subagent work.
  inProgress: DispatchInProgress[];
  // Recent dispatch events from runtime/dispatch/events.jsonl, newest first.
  recent: DispatchEvent[];
  eventsTotal: number;   // total events on file (for "showing N of M")
}

export interface StatusSnapshot {
  ok: boolean;
  pmId: string;
  project: string | null;
  projectRoot: string;
  generatedAt: string;
  execution: LaneInfo;
  /** @deprecated Compatibility alias for execution. */
  lane: LaneInfo;
  branches: BranchInfo;
  plant: PlantInfo;
  roles: RoleInfo[];
  mergeGate: MergeGateInfo;
  pmAction: PmActionInfo;
  dispatchHold: DispatchHoldInfo;
  dispatch: DispatchActivityInfo;
  recentReports: ReportInfo[];
  routines: RoutineInfo[];
  sources: SourceInfo[];
  lenses: LensInfo[];
  warnings: Warning[];
}

// ---- Overview page: milestones + blueprints + backlog rollup ----
export interface MilestoneInfo {
  name: string;
  closed: boolean;                 // "✅" present in the manifest heading
  progress: string | null;         // e.g. "0/1 phases (5 blueprints, 2 dispatched, 0 merged)"
  phases: { done: boolean; title: string }[];
}
export interface BlueprintInfo {
  name: string;                    // file basename without ".md"
  title: string | null;           // first "# " heading, if any
  rel: string;                     // repo-relative path (openable via /api/file)
  updatedAt: string | null;
  milestone: string | null;        // owning milestone slug, from the blueprint's "Linked milestone:" field
}
export interface BacklogCounts {
  pending: number;
  inFlight: number;
  done: number;
  nextId: number | null;
}
export interface DashboardDoc {
  name: string;                    // roadmap / current / notes / backlog / milestones / ...
  rel: string;                     // repo-relative path
  bytes: number;
  updatedAt: string | null;
  tooLargeToInline: boolean;       // bytes over the inline viewer cap
}
export interface OverviewInfo {
  present: boolean;
  schema: "v3";
  controlRevision?: string | null;
  milestones: MilestoneInfo[];
  blueprints: BlueprintInfo[];
  backlog: BacklogCounts;
  dashboards: DashboardDoc[];
}

// ---- Queue page: in-flight + pending + tier congestion ----
export interface InFlightItem {
  task: string;                    // "#11"
  agent: string | null;           // "worker-01"
  role: string | null;            // "worker" (parsed from "worker-01 (Worker)")
  blueprint: string | null;
  milestone: string | null;
  branch: string | null;
  dispatched: string | null;
}
export interface PendingItem {
  order: string | null;           // "07"
  task: string;                    // "#13"
  blueprint: string | null;
  milestone: string | null;
  role: string | null;
  dependsOn: string | null;
}
export interface TierInfo {
  name: string;                    // milestone (proxy for a role tier / band)
  pending: number;
  inFlight: number;
}
export interface QueueInfo {
  present: boolean;
  schema: "v3";
  controlRevision?: string | null;
  inFlight: InFlightItem[];
  pending: PendingItem[];
  activeMilestone: string | null;
  activeMilestones: string[];
  activePending: PendingItem[];
  futurePending: PendingItem[];
  doneCount: number;
  nextId: number | null;
  tiers: TierInfo[];
}

// ---- Workflow page: blueprint Pipeline packages -> live dispatch containers ----
export type WorkflowPackageStatus = "planned" | "active" | "blocked" | "done";
export interface WorkflowFinding {
  severity: "error" | "warning";
  rel: string | null;
  packageId: string | null;
  message: string;
}
export interface WorkflowPackageInfo {
  blueprint: string;
  blueprintRel: string;
  packageId: string;
  title: string;
  role: string | null;
  dispatch: string | null;
  dependsOn: string[];
  status: WorkflowPackageStatus;
  state: string | null;
  container: string | null;
  assignmentRel: string | null;
  reportRel: string | null;
  expectedOutputs: string[];
  issues: string[];
  recentEvents: DispatchEvent[];
}
export interface WorkflowInfo {
  present: boolean;
  packages: WorkflowPackageInfo[];
  counts: Record<WorkflowPackageStatus, number>;
  findings: WorkflowFinding[];
}

// ---- Knowledge page: Librarian-managed knowledge trees (DEC-029, DEC-077) ----
export interface KnowledgeDoc {
  name: string;                    // basename
  title: string | null;
  rel: string;                     // repo-relative path (openable via /api/file)
  updatedAt: string | null;
  layer?: "shared" | "pm";         // DEC-077 layer this doc resolved from
  overridden?: boolean;            // per-pm topic that won via override_shared: true
}
export interface KnowledgeCategory {
  category: string;                // engineering / quality / review / system / security / external_operations
  indexRel: string | null;        // index.md if present
  docs: KnowledgeDoc[];
}
export interface RoleKnowledgeEntry {
  role: string;                    // worker / smith / observer / ...
  readFirst: KnowledgeDoc[];       // role_index.toml read_first files that exist
  onDemand: KnowledgeDoc[];        // role_index.toml on_demand files that exist
  missing: string[];               // declared paths that are not openable in this project
  unionOf: string[];               // optional DEC-048 composition metadata (e.g. artisan)
  note: string | null;
}
export interface RoleKnowledgeInfo {
  present: boolean;                // role_index.toml exists
  rel: string | null;              // repo-relative role_index.toml path
  roles: RoleKnowledgeEntry[];
  error?: string;                  // parse/read error, if any
}
export interface KnowledgeInfo {
  present: boolean;
  categories: KnowledgeCategory[];                 // tracked, curated trees (committed)
  roleIndex: RoleKnowledgeInfo;                     // inverse role -> docs axis (DEC-048)
  local?: { raw: number; cache: number; drafts: number }; // runtime/librarian working area (local-only, DEC-038)
  graph?: KnowledgeGraphInfo;
}

export interface KnowledgeGraphNode {
  id: string;
  kind: "knowledge" | "category" | "document" | "role" | "source" | "routine";
  title: string;
  rel: string | null;
  overridden?: boolean;            // per-pm document that overrode the shared copy (DEC-077)
}

export interface KnowledgeGraphEdge {
  from: string;
  to: string;
  relation: "contains" | "reads_first" | "reads" | "targets" | "uses_source" | "manual";
}

export interface KnowledgeGraphFinding {
  severity: "error" | "warning";
  code: string;
  message: string;
  rel: string | null;
}

export interface KnowledgeGraphInfo {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  findings: KnowledgeGraphFinding[];
  counts: Record<string, number>;
  mermaid: string;
}

// ---- Control page: canonical control contract graph (DEC-043) ----
export type ControlNodeKind =
  | "control"
  | "category"
  | "dashboard"
  | "roadmap"
  | "backlog"
  | "backlog_view"
  | "milestone"
  | "checkpoint"
  | "risk"
  | "note"
  | "blueprint"
  | "decision"
  | "document";

export interface ControlNode {
  id: string;
  kind: ControlNodeKind;
  title: string;
  status: string | null;
  rel: string | null;
}

export interface ControlEdge {
  from: string;
  to: string;
  relation: "contains" | "includes" | "depends" | "related";
}

export interface ControlFinding {
  severity: "error" | "warning";
  code: string;
  message: string;
  rel: string | null;
}

export interface PublicPlanGraphRoadmap {
  slug: string;
  status: string;
  rel: string;
  milestones: string[];
  backlog: string[];
  completed: number;
  total: number;
  ratio: number;
}

export interface PublicPlanGraphMilestone {
  slug: string;
  status: string;
  rel: string;
  parents: string[];
  children: string[];
  roadmaps: string[];
  directBacklog: string[];
  descendantBacklog: string[];
}

export interface PublicPlanGraphBacklog {
  id: string;
  title: string;
  status: string;
  rel: string;
  archived: boolean;
  milestones: string[];
  views: string[];
  dependsOn: string[];
  blockedBy: string[];
  related: string[];
  replacement: string | null;
  currentPosition: string;
  exactNextAction: string;
  evidence: string;
}

export interface PublicPlanGraphCheckpoint {
  id: string;
  status: string;
  rel: string;
  archived: boolean;
  roadmaps: string[];
  milestones: string[];
  backlog: string[];
  lastCompleted: string;
  exactNextAction: string;
  blockers: string;
  readFirst: string[];
  resumeVerification: string;
}

export interface PublicPlanGraphRisk {
  id: string;
  status: string;
  severity: string;
  likelihood: string;
  rel: string;
  archived: boolean;
  related: string[];
  mitigationBacklog: string[];
  evidence: string;
}

export interface PublicPlanGraphNote {
  id: string;
  status: string;
  rel: string;
  related: string[];
  promotedTo: string[];
  headings: Array<{
    heading: string;
    level: 2 | 3;
    startLine: number;
    endLine: number;
    related: string[];
  }>;
}

export interface PublicPlanGraphProjection {
  selectors: {
    roadmaps: Array<{ slug: string; status: string; completed: number; total: number; ratio: number }>;
  };
  roadmaps: PublicPlanGraphRoadmap[];
  milestones: PublicPlanGraphMilestone[];
  backlog: PublicPlanGraphBacklog[];
  risks: PublicPlanGraphRisk[];
  checkpoints: PublicPlanGraphCheckpoint[];
  notes: PublicPlanGraphNote[];
  resume: {
    current: {
      standingInstructions: string;
      position: string;
      blockers: string;
      primaryCheckpointId: string | null;
    };
    primaryCheckpoint: PublicPlanGraphCheckpoint | null;
    blockedCheckpoints: PublicPlanGraphCheckpoint[];
    checkpointCandidates: PublicPlanGraphCheckpoint[];
    readFirst: string[];
  };
  model: {
    schemaVersion: 3;
    storage: "plan_graph_markdown";
    pmId: string;
    mode: string;
    revision: string;
  };
}

export interface ControlInfo {
  present: boolean;
  schema: "v3";
  controlRevision?: string | null;
  // A canonical-model load failure is surfaced, never represented as an empty
  // control tree or silently parsed through the legacy dashboard adapter.
  unavailable?: { code: string; message: string } | null;
  filters?: {
    selected: StatusControlFilters;
    available: {
      milestones: string[];
      riskSeverities: RiskLevel[];
      roadmaps?: string[];
      backlogStates?: string[];
      checkpoints?: string[];
      related?: string[];
    };
    matched: { risks: number; backlog?: number; checkpoints?: number; notes?: number };
    total: { risks: number; backlog?: number; checkpoints?: number; notes?: number };
  } | null;
  planGraph?: PublicPlanGraphProjection | null;
  rootRel: string;
  pmId: string;
  mode: string | null;
  counts: Record<string, number>;
  nodes: ControlNode[];
  edges: ControlEdge[];
  findings: ControlFinding[];
  mermaid: string;
}

export interface StatusControlFilters {
  milestone?: string[];
  riskSeverity?: RiskLevel[];
  roadmap?: string[];
  backlogStatus?: string[];
  archive?: "open" | "archived" | "all";
  checkpoint?: string[];
  related?: string[];
}
