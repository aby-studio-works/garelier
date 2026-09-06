import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readStableControl } from "./generation.ts";
import {
  assertLifecycleV3Transition,
  planLifecycleV3TerminalArchive,
  type LifecycleV3FilePlan,
} from "./lifecycle_v3.ts";
import { loadPlanGraphModel } from "./plan_graph_model.ts";
import type { BacklogRecord, PlanGraphControlModel } from "./plan_graph_types.ts";
import {
  planGraphEntityRevision,
  planGraphRecordAdapter,
  planGraphTransactionCallbacks,
} from "./plan_graph_write.ts";
import { canonicalJson, sha256 } from "./serialization.ts";
import { runControlFilePlanTransaction } from "./transaction.ts";

const MAX_DECISION_FILE_BYTES = 1_000_000;
const MAX_DECISIONS = 500;

export interface BacklogTriageRoots {
  targetRoot: string;
  pmId: string;
  controlRoot: string;
  runtimeRoot: string;
}

type TriageAction = "keep" | "cancel" | "supersede";

interface TriageDecision {
  id: string;
  action: TriageAction;
  expect_revision: number;
  to?: string;
  reason?: string;
  replacement?: string;
}

interface TriageDecisionFile {
  schema_version: 1;
  kind: "garelier_backlog_triage_batch";
  reviewed_by: string;
  reviewed_at: string;
  source: string;
  decision_digest: string;
  decisions: TriageDecision[];
}

interface PlannedDecision {
  id: string;
  title: string;
  action: TriageAction;
  from: string;
  to: string;
  entity_revision: number;
  reason: string | null;
  replacement: string | null;
}

export interface BacklogTriageBatchPlan {
  schema_version: 1;
  kind: "garelier_backlog_triage_batch_plan";
  control_schema_version: 3;
  storage: "plan_graph_markdown";
  pm_id: string;
  reviewed_by: string;
  reviewed_at: string;
  source: string;
  decision_digest: string;
  control_revision: string;
  counts: {
    decisions: number;
    keep: number;
    transition: number;
    cancel: number;
    supersede: number;
    writes: number;
  };
  decisions: PlannedDecision[];
  plan_digest: string;
}

export interface BacklogTriageBatchApplyResult {
  schema_version: 1;
  kind: "garelier_backlog_triage_batch_result";
  status: "committed" | "dry_run";
  control_revision_before: string;
  control_revision_after: string;
  plan_digest: string;
  counts: BacklogTriageBatchPlan["counts"];
  changed_paths: string[];
}

function table(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort()[0];
  if (unknown) throw new Error(`${label} has unknown key: ${unknown}`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function parseDecision(raw: unknown, index: number): TriageDecision {
  const row = table(raw, `decision ${index}`);
  exactKeys(row, ["id", "action", "expect_revision", "to", "reason", "replacement"], `decision ${index}`);
  const id = requiredString(row.id, `decision ${index}.id`);
  if (!/^W-\d{3,}$/.test(id)) throw new Error(`decision ${index}.id must match W-NNN`);
  const action = requiredString(row.action, `decision ${index}.action`) as TriageAction;
  if (!["keep", "cancel", "supersede"].includes(action)) {
    throw new Error(`decision ${index}.action must be keep, cancel, or supersede`);
  }
  if (!Number.isSafeInteger(row.expect_revision) || Number(row.expect_revision) < 0) {
    throw new Error(`decision ${index}.expect_revision must be a non-negative integer`);
  }
  const decision: TriageDecision = {
    id,
    action,
    expect_revision: Number(row.expect_revision),
    to: optionalString(row.to, `decision ${index}.to`),
    reason: optionalString(row.reason, `decision ${index}.reason`),
    replacement: optionalString(row.replacement, `decision ${index}.replacement`),
  };
  const extras = action === "keep" ? ["to", "reason", "replacement"]
    : action === "cancel" ? ["to", "replacement"]
      : ["to"];
  const invalid = extras.find((key) => decision[key as keyof TriageDecision] !== undefined);
  if (invalid) throw new Error(`decision ${index}.${invalid} is not valid for action ${action}`);
  if ((action === "cancel" || action === "supersede") && !decision.reason) {
    throw new Error(`decision ${index}.reason is required for ${action}`);
  }
  if (action === "supersede" && !decision.replacement) {
    throw new Error(`decision ${index}.replacement is required for supersede`);
  }
  return decision;
}

function loadDecisionFile(rawPath: string): TriageDecisionFile {
  const path = resolve(rawPath);
  if (!existsSync(path)) throw new Error(`decision file does not exist: ${rawPath}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`decision file must be a regular non-symlink file: ${rawPath}`);
  if (info.size > MAX_DECISION_FILE_BYTES) throw new Error(`decision file exceeds ${MAX_DECISION_FILE_BYTES} bytes`);
  const source = readFileSync(path, "utf8");
  let decoded: unknown;
  try { decoded = parseToml(source); }
  catch (error) { throw new Error(`decision file is not valid TOML: ${(error as Error).message}`); }
  const root = table(decoded, "decision file");
  exactKeys(root, ["schema_version", "kind", "reviewed_by", "reviewed_at", "decision"], "decision file");
  if (root.schema_version !== 1) throw new Error("decision file schema_version must be 1");
  if (root.kind !== "garelier_backlog_triage_batch") {
    throw new Error("decision file kind must be garelier_backlog_triage_batch");
  }
  const reviewedBy = requiredString(root.reviewed_by, "decision file reviewed_by");
  const reviewedAt = requiredString(root.reviewed_at, "decision file reviewed_at");
  if (!Number.isFinite(Date.parse(reviewedAt))) throw new Error("decision file reviewed_at must be RFC 3339");
  if (!Array.isArray(root.decision) || root.decision.length < 1) {
    throw new Error("decision file must contain at least one [[decision]]");
  }
  if (root.decision.length > MAX_DECISIONS) throw new Error(`decision file exceeds ${MAX_DECISIONS} decisions`);
  const decisions = root.decision.map(parseDecision);
  const duplicate = decisions.map((decision) => decision.id)
    .find((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`duplicate decision id: ${duplicate}`);
  decisions.sort((left, right) => left.id.localeCompare(right.id, "en"));
  return {
    schema_version: 1,
    kind: "garelier_backlog_triage_batch",
    reviewed_by: reviewedBy,
    reviewed_at: new Date(reviewedAt).toISOString(),
    source: basename(path),
    decision_digest: sha256(source),
    decisions,
  };
}

function activeCheckpointContains(model: PlanGraphControlModel, id: string): boolean {
  const currentIds = new Set([
    ...(model.current?.primaryCheckpointId ? [model.current.primaryCheckpointId] : []),
    ...(model.current?.checkpointCandidates ?? []),
  ]);
  return [...model.checkpoints.values()].some((checkpoint) =>
    currentIds.has(checkpoint.id)
    && ["active", "paused", "blocked"].includes(checkpoint.status)
    && checkpoint.backlog.includes(id));
}

function validateDecision(
  model: PlanGraphControlModel,
  decision: TriageDecision,
): PlannedDecision {
  const record = model.backlog.get(decision.id);
  if (!record) throw new Error(`unknown Backlog: ${decision.id}`);
  if (decision.action !== "keep" && !record.path.startsWith("backlog/open/")) {
    throw new Error(`decision ${decision.id} action ${decision.action} requires an open Backlog`);
  }
  const entityRevision = planGraphEntityRevision(record);
  if (entityRevision !== decision.expect_revision) {
    throw new Error(`stale Backlog ${decision.id}: expected revision ${decision.expect_revision}, found ${entityRevision}`);
  }
  const to = decision.action === "keep" ? record.status
    : decision.action === "cancel" ? "cancelled" : "superseded";
  if (decision.action === "supersede") {
    if (decision.replacement === decision.id) throw new Error(`decision ${decision.id} cannot supersede itself`);
    if (!model.backlog.has(decision.replacement!)) {
      throw new Error(`decision ${decision.id} replacement does not exist: ${decision.replacement}`);
    }
  }
  if (decision.action !== "keep") {
    const checkpointBound = activeCheckpointContains(model, decision.id);
    const evidenceCount = planGraphRecordAdapter.inspect(record).evidenceCount;
    assertLifecycleV3Transition({
      kind: "backlog",
      from: record.status,
      to,
      evidenceCount,
      reason: decision.reason,
      replacement: decision.replacement,
      hasActiveCheckpoint: checkpointBound,
      currentHasCheckpoint: checkpointBound,
    });
  }
  return {
    id: decision.id,
    title: record.title,
    action: decision.action,
    from: record.status,
    to,
    entity_revision: entityRevision,
    reason: decision.reason ?? null,
    replacement: decision.replacement ?? null,
  };
}

function buildPlan(
  model: PlanGraphControlModel,
  pmId: string,
  file: TriageDecisionFile,
): BacklogTriageBatchPlan {
  const error = model.findings.find((finding) => finding.severity === "error");
  if (error) throw new Error(`schema-3 strict validation failed: ${error.code}: ${error.message}`);
  const decisions = file.decisions.map((decision) => validateDecision(model, decision));
  const counts = {
    decisions: decisions.length,
    keep: decisions.filter((decision) => decision.action === "keep").length,
    transition: 0,
    cancel: decisions.filter((decision) => decision.action === "cancel").length,
    supersede: decisions.filter((decision) => decision.action === "supersede").length,
    writes: decisions.filter((decision) => decision.action !== "keep").length,
  };
  const payload = {
    schema_version: 1 as const,
    kind: "garelier_backlog_triage_batch_plan" as const,
    control_schema_version: 3 as const,
    storage: "plan_graph_markdown" as const,
    pm_id: pmId,
    reviewed_by: file.reviewed_by,
    reviewed_at: file.reviewed_at,
    source: file.source,
    decision_digest: file.decision_digest,
    control_revision: model.revision,
    counts,
    decisions,
  };
  return { ...payload, plan_digest: sha256(canonicalJson(payload)) };
}

export function planBacklogTriageBatch(
  roots: BacklogTriageRoots,
  decisionFile: string,
): BacklogTriageBatchPlan {
  const file = loadDecisionFile(decisionFile);
  return readStableControl(
    { controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot },
    () => buildPlan(loadPlanGraphModel(roots.controlRoot), roots.pmId, file),
  );
}

function decisionPlan(
  record: BacklogRecord,
  decision: PlannedDecision,
  now: string,
  checkpointBound: boolean,
): LifecycleV3FilePlan {
  if (decision.action === "keep") return { entity: record.id, summary: `keep ${record.id}`, writes: [] };
  const evidenceCount = planGraphRecordAdapter.inspect(record).evidenceCount;
  return planLifecycleV3TerminalArchive({
    sourcePath: record.path,
    archivePath: `backlog/archive/${now.slice(0, 4)}/${basename(record.path)}`,
    record,
    to: decision.to,
    evidenceCount,
    reason: decision.reason ?? undefined,
    replacement: decision.replacement ?? undefined,
    now,
    adapter: planGraphRecordAdapter,
  });
}

export function applyBacklogTriageBatch(
  roots: BacklogTriageRoots,
  decisionFile: string,
  expectedPlanDigest: string,
  expectedControlRevision: string,
): BacklogTriageBatchApplyResult {
  const file = loadDecisionFile(decisionFile);
  const applied: { plan?: BacklogTriageBatchPlan } = {};
  const result = runControlFilePlanTransaction({
    targetRoot: roots.targetRoot,
    pmId: roots.pmId,
    controlRoot: roots.controlRoot,
    runtimeRoot: roots.runtimeRoot,
    agent: file.reviewed_by,
    sessionId: "triage-batch",
    command: "backlog-triage-batch",
    expectedControlRevision,
    callbacks: planGraphTransactionCallbacks,
    mutate: ({ state, now }) => {
      const plan = buildPlan(state, roots.pmId, file);
      if (plan.plan_digest !== expectedPlanDigest) {
        throw new Error(`triage-batch plan digest mismatch: expected ${expectedPlanDigest}, found ${plan.plan_digest}`);
      }
      applied.plan = plan;
      const writes = plan.decisions.flatMap((decision) => {
        const record = state.backlog.get(decision.id);
        if (!record) throw new Error(`Backlog disappeared during triage-batch: ${decision.id}`);
        return decisionPlan(record, decision, now, activeCheckpointContains(state, decision.id)).writes;
      });
      return {
        entity: "backlog-triage-batch",
        summary: `apply ${plan.counts.decisions} reviewed Backlog decisions`,
        writes,
      };
    },
  });
  const appliedPlan = applied.plan;
  if (!appliedPlan) throw new Error("triage-batch transaction did not produce a plan");
  return {
    schema_version: 1,
    kind: "garelier_backlog_triage_batch_result",
    status: result.status,
    control_revision_before: result.control_revision_before,
    control_revision_after: result.control_revision_after,
    plan_digest: appliedPlan.plan_digest,
    counts: appliedPlan.counts,
    changed_paths: result.changes.map((change) => change.path),
  };
}
