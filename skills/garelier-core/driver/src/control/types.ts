export const DEFAULT_STORE_LIMITS = {
  maxEntities: 5_000,
  maxJsonBytes: 1_048_576,
  maxArtifactBytes: 8_388_608,
  maxTotalBytes: 67_108_864,
  maxClosedDepth: 2,
} as const;

// W-314 deleted the control-only SKILLS and the control-only execution route
// (DEC-097). This enum is a DIFFERENT axis and is deliberately retained: it is
// a persisted `control.toml` value meaning "this namespace holds control
// authority only, with no full-Garelier setup beside it".
//
// Schema 3 still persists this independent namespace-mode axis. It distinguishes
// a control-only namespace from a full Garelier setup; it is not a schema
// compatibility switch.
export type ControlMode = "full" | "control_only";
export type FindingSeverity = "error" | "warning" | "info";
export type ValidationProfile = "fast" | "strict";
export type WorkState = "triage" | "ready" | "active" | "blocked" | "verification" | "deferred" | "done" | "cancelled" | "superseded";
export type WorkType = "feature" | "bug" | "maintenance" | "research" | "decision" | "docs";
export type Priority = "critical" | "high" | "normal" | "low";
export type AcceptanceState = "open" | "pass" | "fail" | "waived";
export type RiskState = "open" | "mitigating" | "accepted" | "closed" | "superseded";
export type RiskLevel = "critical" | "high" | "medium" | "low";
export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";
export type MilestoneStatus = "planned" | "active" | "verification" | "shipped" | "abandoned";
export type BlueprintStatus = "draft" | "active" | "blocked" | "verification" | "shipped" | "archived";
export type ArtifactKind = "decision" | "milestone" | "blueprint";
export type EvidenceKind = "commit" | "gate" | "report" | "path" | "decision" | "test" | "external";
export const EVIDENCE_WRITER_STORAGE_KEY = "producer" as const;

export const WORK_STATES: readonly WorkState[] = ["triage", "ready", "active", "blocked", "verification", "deferred", "done", "cancelled", "superseded"];
export const CLOSED_WORK_STATES = new Set<WorkState>(["done", "cancelled", "superseded"]);
export const WORK_TYPES: readonly WorkType[] = ["feature", "bug", "maintenance", "research", "decision", "docs"];
export const PRIORITIES: readonly Priority[] = ["critical", "high", "normal", "low"];
export const ACCEPTANCE_STATES: readonly AcceptanceState[] = ["open", "pass", "fail", "waived"];
export const RISK_STATES: readonly RiskState[] = ["open", "mitigating", "accepted", "closed", "superseded"];
export const CLOSED_RISK_STATES = new Set<RiskState>(["closed", "superseded"]);
export const RISK_LEVELS: readonly RiskLevel[] = ["critical", "high", "medium", "low"];

export const WORK_TRANSITIONS: Readonly<Record<WorkState, readonly WorkState[]>> = {
  triage: ["ready", "blocked", "deferred", "cancelled", "superseded"],
  ready: ["active", "blocked", "deferred", "cancelled", "superseded"],
  active: ["blocked", "verification", "deferred", "cancelled", "superseded"],
  blocked: ["ready", "active", "deferred", "cancelled", "superseded"],
  verification: ["active", "blocked", "done", "cancelled", "superseded"],
  deferred: ["ready", "cancelled", "superseded"],
  done: [],
  cancelled: [],
  superseded: [],
};

export const RISK_TRANSITIONS: Readonly<Record<RiskState, readonly RiskState[]>> = {
  open: ["mitigating", "accepted", "closed", "superseded"],
  mitigating: ["open", "accepted", "closed", "superseded"],
  accepted: ["mitigating", "closed", "superseded"],
  closed: [],
  superseded: [],
};

export interface EvidenceReference {
  kind: EvidenceKind;
  id?: string;
  commit?: string;
  root?: "control" | "target";
  path?: string;
  observed_at: string;
  writer: string;
  summary: string;
  uri?: string;
  content_hash?: string;
}

export interface ControlFinding {
  severity: FindingSeverity;
  code: string;
  entity: string | null;
  path: string | null;
  field: string | null;
  message: string;
  suggested_command: string | null;
}
