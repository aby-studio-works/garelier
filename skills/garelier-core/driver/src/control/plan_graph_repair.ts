import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteRuntimeFile, ensureSafeDirectory } from "./diagnostics.ts";
import { ensureControlGenerationBootstrapped } from "./generation.ts";
import { assertLifecycleV3ControlPath, lifecycleV3TerminalStatuses } from "./lifecycle_v3.ts";
import { loadPlanGraphModel } from "./plan_graph_model.ts";
import { planGraphEntityRevision, safeSlug } from "./plan_graph_write.ts";
import type { BacklogRecord, BacklogStatus, CanonicalMarkdownRecord, PlanGraphControlModel } from "./plan_graph_types.ts";
import { canonicalJson, sha256 } from "./serialization.ts";
import { closeControlSession, openControlSession, readControlSession, type ControlRuntimeCallbacks } from "./sessions.ts";
import {
  controlTreeSourceDigest,
  resolveControlNamespace,
  runControlFilePlanTransaction,
  type ControlFilePlanCallbacks,
  type ControlTransactionResult,
  type PlannedControlWrite,
} from "./transaction.ts";

export interface RepairPathOptions {
  targetRoot: string;
  pmId: string;
  controlRoot?: string;
  runtimeRoot?: string;
}

/**
 * Repair non-canonical entity filenames in a schema-3 control tree.
 * Historical migration snapshots are inert document content.
 */
export interface PlanGraphRepairChange {
  entity: string;
  from_path: string;
  to_path: string;
  reason: string[];
}

export interface PlanGraphRepairPlan {
  schema_version: 1;
  kind: "garelier_schema3_repair_plan";
  plan_id: string;
  plan_digest: string;
  pm_id: string;
  control_revision: string;
  finding_codes: string[];
  changes: PlanGraphRepairChange[];
}

export interface ApplyPlanGraphRepairOptions extends RepairPathOptions {
  planId: string;
  sessionId: string;
  agent: string;
  now?: () => Date;
}

function titleFromHeading(id: string, body: string): string {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`^#\\s+${escapedId}:\\s*(.*)$`, "m"));
  return match && match[1].trim() ? match[1].trim() : id;
}

/**
 * The slug already baked into a canonical `${id}-<slug>.md` filename, or
 * null for a bare `${id}.md` (D1's defect signature — nothing to preserve).
 * A record's title can legitimately drift after creation (a later
 * `planBacklogUpdate` rewrites only the body H1, never the file path, by
 * design); repair must not treat that drift as a canonicality defect and
 * re-slug an already-canonical record from today's title on every run —
 * that would make the plan non-idempotent and needlessly rename files with
 * no real defect. Preserve the slug that is already there; only derive a
 * fresh one from the title when the filename has none.
 */
// Must mirror assertLifecycleV3ControlPath's slug shape exactly: starts with
// an alnum char, then any run of alnum/"."/"_"/"-". A slug that DOESN'T match
// this is itself non-canonical (e.g. a leading "_" — Guardian N4) and must
// NOT be preserved: reusing it verbatim would rebuild the exact same
// non-canonical path, computeRepairDraft would see finalPath === record.path
// and skip the record as a no-op — doctor stays red, repair silently does
// nothing. Falling through to null forces a fresh, canonical slug from the
// title instead.
const CANONICAL_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function existingSlug(path: string, id: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1, -".md".length);
  if (!base.startsWith(`${id}-`)) return null;
  const slug = base.slice(id.length + 1);
  return CANONICAL_SLUG_RE.test(slug) ? slug : null;
}


function backlogArchiveYear(record: BacklogRecord, chronology: string | null): string {
  if (chronology !== null) return chronology.slice(0, 4);
  if (record.archived) return record.archived.slice(0, 4);
  const fromPath = record.path.match(/^backlog\/archive\/(\d{4})\//)?.[1];
  if (fromPath) return fromPath;
  if (record.closed) return record.closed.slice(0, 4);
  return record.updated.slice(0, 4);
}

function canonicalBacklogPath(id: string, slug: string, status: BacklogStatus, archiveYear: string): string {
  return lifecycleV3TerminalStatuses("backlog").has(status) ? `backlog/archive/${archiveYear}/${id}-${slug}.md` : `backlog/open/${id}-${slug}.md`;
}


function canonicalCheckpointPath(id: string, slug: string, currentPath: string): string {
  const archived = currentPath.startsWith("checkpoints/archive/");
  if (!archived) return `checkpoints/active/${id}-${slug}.md`;
  const year = currentPath.match(/^checkpoints\/archive\/(\d{4})\//)?.[1] ?? "1970";
  return `checkpoints/archive/${year}/${id}-${slug}.md`;
}

/** The slug for a record's canonical path: whatever is already baked into
 *  the current filename, or a fresh one derived from the title only when
 *  the filename is bare (see existingSlug). */
function recordSlug(record: { id: string; path: string; body: string }): string {
  return existingSlug(record.path, record.id) ?? safeSlug(titleFromHeading(record.id, record.body));
}

interface DraftChange { entity: string; fromPath: string; toPath: string; reason: string[]; source: string }

function computeRepairDraft(model: PlanGraphControlModel): DraftChange[] {
  const drafts: DraftChange[] = [];
  for (const record of model.backlog.values()) {
    const archiveYear = backlogArchiveYear(record, null);
    const finalPath = canonicalBacklogPath(record.id, recordSlug(record), record.status, archiveYear);
    if (finalPath === record.path) continue;
    assertLifecycleV3ControlPath(finalPath);
    const reason: string[] = [];
    if (finalPath !== record.path) reason.push(`move to canonical schema-3 lifecycle path (was ${record.path})`);
    drafts.push({ entity: `backlog:${record.id}`, fromPath: record.path, toPath: finalPath, reason, source: record.source });
  }
  for (const record of model.checkpoints.values()) {
    const finalPath = canonicalCheckpointPath(record.id, recordSlug(record), record.path);
    if (finalPath === record.path) continue;
    assertLifecycleV3ControlPath(finalPath);
    drafts.push({
      entity: `checkpoint:${record.id}`,
      fromPath: record.path,
      toPath: finalPath,
      reason: [`move to canonical schema-3 lifecycle path (was ${record.path})`],
      source: (record as CanonicalMarkdownRecord).source,
    });
  }
  drafts.sort((a, b) => a.entity.localeCompare(b.entity));
  return drafts;
}

function draftsToWrites(drafts: readonly DraftChange[]): PlannedControlWrite[] {
  const writes: PlannedControlWrite[] = [];
  for (const draft of drafts) {
    if (draft.fromPath !== draft.toPath) writes.push({ path: draft.fromPath, source: null });
    writes.push({ path: draft.toPath, source: draft.source });
  }
  return writes;
}

/** Tolerant load: unlike planGraphTransactionCallbacks (plan_graph_write.ts),
 *  this never throws on a strict-validation error — the whole point of
 *  repair is to run against a control tree that currently has findings. */
const planGraphRepairCallbacks: ControlFilePlanCallbacks<PlanGraphControlModel> = {
  load({ controlRoot }) {
    const model = loadPlanGraphModel(controlRoot);
    return { state: model, revision: model.revision, sourceDigest: controlTreeSourceDigest(controlRoot) };
  },
  // Repair must be able to touch/delete a currently non-canonical path (that
  // is what it is fixing); the strict per-kind regex only applies to the
  // OUTPUT path, asserted explicitly in computeRepairDraft above.
  normalizePath: (path) => path,
};

/**
 * Tolerant session runtime: unlike planGraphRuntimeCallbacks
 * (plan_graph_write.ts), this never throws on a strict-validation error.
 * openControlSession's normal runtime callback would make it impossible to
 * ever open a session against a control tree that is non-canonical from the
 * moment it was checked out (no prior "was valid, became invalid" window to
 * open a session in) — exactly the state repair exists to fix (W-207 D4).
 */
const planGraphRepairRuntimeCallbacks: ControlRuntimeCallbacks = {
  load({ controlRoot }) {
    const model = loadPlanGraphModel(controlRoot);
    return {
      revision: model.revision,
      claimTtlSeconds: 1_800,
      claimStaleAfterSeconds: 900,
      entity(id) {
        const record = model.backlog.get(id) ?? model.risks.get(id);
        return record ? {
          revision: planGraphEntityRevision(record),
          terminal: record.kind === "backlog" ? lifecycleV3TerminalStatuses("backlog").has(record.status) : ["closed", "superseded"].includes(record.status),
        } : null;
      },
    };
  },
};

export function createPlanGraphRepairPlan(options: RepairPathOptions): PlanGraphRepairPlan {
  const paths = resolveControlNamespace(options);
  const model = loadPlanGraphModel(paths.controlRoot);
  const drafts = computeRepairDraft(model);
  const changes: PlanGraphRepairChange[] = drafts.map((draft) => ({ entity: draft.entity, from_path: draft.fromPath, to_path: draft.toPath, reason: draft.reason }));
  const base = {
    schema_version: 1 as const,
    kind: "garelier_schema3_repair_plan" as const,
    pm_id: options.pmId,
    control_revision: model.revision,
    finding_codes: [...new Set(model.findings.map((finding) => finding.code))].sort(),
    changes,
  };
  const planDigest = sha256(canonicalJson(base));
  return { ...base, plan_id: `schema3-repair-${planDigest.slice("sha256:".length, "sha256:".length + 16)}`, plan_digest: planDigest };
}

function schema3RepairPlanPath(runtimeRoot: string, planId: string): string {
  if (!/^schema3-repair-[a-f0-9]{16}$/.test(planId)) throw new Error(`invalid schema-3 repair plan ID: ${planId}`);
  return join(runtimeRoot, "repair_plans", `${planId}.json`);
}

export function savePlanGraphRepairPlan(options: RepairPathOptions, plan: PlanGraphRepairPlan): string {
  const paths = resolveControlNamespace(options);
  if (plan.pm_id !== options.pmId) throw new Error("schema-3 repair plan namespace mismatch");
  const directory = join(paths.runtimeRoot, "repair_plans");
  ensureSafeDirectory(paths.runtimeRoot, directory);
  const path = schema3RepairPlanPath(paths.runtimeRoot, plan.plan_id);
  atomicWriteRuntimeFile(paths.runtimeRoot, path, canonicalJson(plan));
  return path;
}

export function loadPlanGraphRepairPlan(options: RepairPathOptions, planId: string): PlanGraphRepairPlan {
  const paths = resolveControlNamespace(options);
  const path = schema3RepairPlanPath(paths.runtimeRoot, planId);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`schema-3 repair plan not found: ${planId}`);
  const source = readFileSync(path, "utf8");
  const plan = JSON.parse(source) as PlanGraphRepairPlan;
  if (source !== canonicalJson(plan)) throw new Error(`schema-3 repair plan is not canonical: ${planId}`);
  if (plan.plan_id !== planId || plan.pm_id !== options.pmId || plan.kind !== "garelier_schema3_repair_plan") throw new Error(`schema-3 repair plan identity mismatch: ${planId}`);
  const { plan_id: _id, plan_digest: _digest, ...base } = plan;
  const digest = sha256(canonicalJson(base));
  if (digest !== plan.plan_digest || plan.plan_id !== `schema3-repair-${digest.slice("sha256:".length, "sha256:".length + 16)}`) throw new Error(`schema-3 repair plan digest mismatch: ${planId}`);
  return plan;
}

export function applyPlanGraphRepairPlan(options: ApplyPlanGraphRepairOptions, plan: PlanGraphRepairPlan): ControlTransactionResult {
  if (!/^schema3-repair-[a-f0-9]{16}$/.test(plan.plan_id) || plan.plan_digest.length === 0) throw new Error(`invalid schema-3 repair plan: ${plan.plan_id}`);
  const paths = resolveControlNamespace(options);
  // W-211: this is also reachable as the FIRST command ever run against a
  // runtime location (a tree broken since checkout has no prior successful
  // session-open to have bootstrapped generation already). Prime it before
  // the self-open below acquires the namespace lock, or the lock's own
  // directory-creation side effect would falsify the "never touched"
  // signal readControlGenerationSnapshot's fresh-worktree fallback needs.
  ensureControlGenerationBootstrapped(paths.controlRoot, paths.runtimeRoot);
  // A control tree that has been non-canonical since the moment it was
  // checked out (never had a healthy window in this namespace to open a
  // normal session in) cannot open one through the strict runtime callback —
  // that IS the state repair exists to fix. Reuse an already-open session if
  // the caller has one (the "became invalid later" case); otherwise
  // self-bootstrap one through the tolerant runtime callback and close it
  // when done, so repair is usable standalone against a broken-since-checkout
  // tree without depending on a prior healthy session (W-207 D4).
  let selfOpened = false;
  try {
    readControlSession(paths, options.sessionId);
  } catch {
    openControlSession({
      targetRoot: options.targetRoot, pmId: options.pmId, controlRoot: options.controlRoot, runtimeRoot: options.runtimeRoot,
      runtimeCallbacks: planGraphRepairRuntimeCallbacks, agent: options.agent, sessionId: options.sessionId, cwd: options.targetRoot, now: options.now,
    });
    selfOpened = true;
  }
  try {
    return runControlFilePlanTransaction<PlanGraphControlModel>({
      targetRoot: options.targetRoot,
      pmId: options.pmId,
      controlRoot: options.controlRoot,
      runtimeRoot: options.runtimeRoot,
      expectedControlRevision: plan.control_revision,
      agent: options.agent,
      sessionId: options.sessionId,
      command: "schema3-repair --apply",
      now: options.now,
      callbacks: planGraphRepairCallbacks,
      mutate: ({ state }) => {
        const current = createPlanGraphRepairPlan({ targetRoot: options.targetRoot, pmId: options.pmId, controlRoot: options.controlRoot, runtimeRoot: options.runtimeRoot });
        if (current.plan_digest !== plan.plan_digest) throw new Error("schema-3 repair plan is stale; re-run --plan");
        const drafts = computeRepairDraft(state);
        return { writes: draftsToWrites(drafts), summary: `apply ${plan.plan_id}` };
      },
    });
  } finally {
    if (selfOpened) {
      try {
        closeControlSession({
          targetRoot: options.targetRoot, pmId: options.pmId, controlRoot: options.controlRoot, runtimeRoot: options.runtimeRoot,
          runtimeCallbacks: planGraphRepairRuntimeCallbacks, sessionId: options.sessionId,
        });
      } catch { /* best-effort cleanup; a stale session file does not invalidate the completed transaction */ }
    }
  }
}
