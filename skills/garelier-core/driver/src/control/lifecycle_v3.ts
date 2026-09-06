import { assertSafeRelativePath } from "./diagnostics.ts";
import { requireNonEmpty as nonEmpty } from "../guard/non_empty.ts";
import { canonicalJson, sha256 } from "./serialization.ts";

export type LifecycleV3EntityKind = "roadmap" | "milestone" | "backlog" | "checkpoint" | "risk" | "decision" | "blueprint";
export type LifecycleV3Status =
  | "planned" | "active" | "paused" | "completed" | "abandoned"
  | "blocked" | "shipped"
  | "triage" | "ready" | "verification" | "deferred" | "done" | "cancelled" | "superseded"
  | "open" | "mitigating" | "accepted" | "closed"
  | "proposed" | "rejected" | "draft" | "archived";

export interface LifecycleV3RecordView {
  kind: LifecycleV3EntityKind;
  id: string;
  status: string;
  created: string;
  updated: string;
  statusChanged?: string;
  closed?: string;
  archived?: string;
  evidenceCount: number;
  replacement?: string;
  backlogIds?: readonly string[];
}

export interface LifecycleV3RecordPatch {
  status?: string;
  updated: string;
  statusChanged?: string;
  closed?: string;
  archived?: string;
  clearClosed?: boolean;
  clearArchived?: boolean;
  clearReplacement?: boolean;
  transitionReason?: string;
  replacement?: string;
  backlogIds?: string[];
}

export interface LifecycleV3RecordAdapter<TRecord> {
  inspect(record: TRecord): LifecycleV3RecordView;
  patch(record: TRecord, patch: LifecycleV3RecordPatch): TRecord;
  render(record: TRecord): string;
}

export interface LifecycleV3CurrentAdapter<TCurrent> {
  activeCheckpointIds(current: TCurrent): readonly string[];
  addCheckpoint(current: TCurrent, checkpointId: string): TCurrent;
  removeCheckpoint(current: TCurrent, checkpointId: string): TCurrent;
  render(current: TCurrent): string;
}

export interface LifecycleV3CheckpointActionView {
  token?: string;
  exactNextAction?: string;
}

export interface LifecycleV3BeginActionPatch {
  token: string;
  preparedAt: string;
  exactNextAction: string;
  before: string;
  success: string;
  targets: string[];
}

export interface LifecycleV3FinishActionPatch {
  finishedAt: string;
  lastCompleted: string;
  result: string;
  changedFiles: string[];
  repositoryState: string;
  exactNextAction: string;
}

export interface LifecycleV3CheckpointAdapter<TCheckpoint> extends LifecycleV3RecordAdapter<TCheckpoint> {
  inspectAction(checkpoint: TCheckpoint): LifecycleV3CheckpointActionView;
  beginAction(checkpoint: TCheckpoint, patch: LifecycleV3BeginActionPatch): TCheckpoint;
  finishAction(checkpoint: TCheckpoint, patch: LifecycleV3FinishActionPatch): TCheckpoint;
}

export interface LifecycleV3PlannedWrite {
  path: string;
  source: string | null;
}

export interface LifecycleV3FilePlan {
  writes: LifecycleV3PlannedWrite[];
  entity?: string;
  summary: string;
}

const STATE_MATRIX: Readonly<Record<LifecycleV3EntityKind, Readonly<Record<string, readonly string[]>>>> = {
  roadmap: {
    planned: ["active", "paused", "completed", "abandoned"],
    active: ["paused", "completed", "abandoned"],
    paused: ["active", "completed", "abandoned"],
    completed: [],
    abandoned: [],
  },
  milestone: {
    planned: ["active", "paused", "shipped", "abandoned"],
    active: ["blocked", "paused", "shipped", "abandoned"],
    blocked: ["active", "paused", "shipped", "abandoned"],
    paused: ["active", "shipped", "abandoned"],
    shipped: [],
    abandoned: [],
  },
  backlog: {
    triage: ["ready", "deferred", "done", "cancelled", "superseded"],
    // W-667 F-4: `ready -> verification` exists for the row that LANDED inside
    // another lane's merge. landing-finalize cannot settle it — its gate evidence
    // is bound to the other row's work_id — and `ready -> active` demands a
    // prepared paused/blocked Checkpoint the row will never get, so the row was
    // unreachable and the PM's judgement had nowhere to land. The mechanism does
    // not decide: the transition is admitted only once the operator has recorded
    // the merge as typed evidence (enforced below), so the record carries WHY.
    ready: ["active", "verification", "deferred", "done", "cancelled", "superseded"],
    active: ["blocked", "verification", "deferred", "done", "cancelled", "superseded"],
    blocked: ["ready", "active", "deferred", "done", "cancelled", "superseded"],
    verification: ["active", "blocked", "deferred", "done", "cancelled", "superseded"],
    deferred: ["ready", "active", "done", "cancelled", "superseded"],
    done: [],
    cancelled: [],
    superseded: [],
  },
  checkpoint: {
    active: ["paused", "blocked", "completed", "abandoned"],
    paused: ["active", "blocked", "completed", "abandoned"],
    blocked: ["active", "paused", "completed", "abandoned"],
    completed: [],
    abandoned: [],
  },
  risk: {
    open: ["mitigating", "accepted", "closed", "superseded"],
    mitigating: ["open", "accepted", "closed", "superseded"],
    accepted: ["mitigating", "closed", "superseded"],
    closed: [],
    superseded: [],
  },
  decision: {
    proposed: ["accepted", "rejected", "superseded"],
    accepted: ["superseded"],
    rejected: [],
    superseded: [],
  },
  blueprint: {
    draft: ["active", "archived"],
    active: ["blocked", "verification", "archived"],
    blocked: ["active", "archived"],
    verification: ["active", "blocked", "shipped", "archived"],
    shipped: ["archived"],
    archived: [],
  },
};

const TERMINAL: Readonly<Record<LifecycleV3EntityKind, ReadonlySet<string>>> = {
  roadmap: new Set(["completed", "abandoned"]),
  milestone: new Set(["shipped", "abandoned"]),
  backlog: new Set(["done", "cancelled", "superseded"]),
  checkpoint: new Set(["completed", "abandoned"]),
  risk: new Set(["closed", "superseded"]),
  decision: new Set(["rejected", "superseded"]),
  blueprint: new Set(["shipped", "archived"]),
};

function timestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an RFC 3339 timestamp`);
  return value;
}

function assertChronology(view: LifecycleV3RecordView, now: string): void {
  timestamp(view.created, `${view.kind}.created`);
  timestamp(view.updated, `${view.kind}.updated`);
  timestamp(now, "lifecycle time");
  if (Date.parse(view.updated) < Date.parse(view.created)) throw new Error(`${view.kind}.updated cannot precede created`);
  if (Date.parse(now) < Date.parse(view.updated)) throw new Error(`${view.kind} lifecycle time cannot move updated backwards`);
}

export function lifecycleV3TerminalStatuses(kind: LifecycleV3EntityKind): ReadonlySet<string> {
  return TERMINAL[kind];
}

export function assertLifecycleV3Transition(options: {
  kind: LifecycleV3EntityKind;
  from: string;
  to: string;
  evidenceCount: number;
  reason?: string;
  replacement?: string;
  hasActiveCheckpoint?: boolean;
  currentHasCheckpoint?: boolean;
}): void {
  const allowed = STATE_MATRIX[options.kind][options.from];
  if (!allowed || !allowed.includes(options.to)) {
    // W-667 F-5/F-12: an operator reading only the tail must see what IS
    // reachable, not just what is refused.
    const reachable = allowed && allowed.length ? allowed.join(", ") : "(none — this status is terminal)";
    throw new Error(`${options.kind} transition ${options.from} -> ${options.to} is not allowed; reachable from ${options.from}: ${reachable}`);
  }
  if (options.kind === "backlog" && options.from === "ready" && options.to === "verification"
    && (!Number.isInteger(options.evidenceCount) || options.evidenceCount < 1)) {
    throw new Error(
      "backlog ready -> verification records a row that landed inside another lane's merge, so it requires the merge recorded as typed evidence first. "
        + "NEXT_COMMAND: garelier control evidence-add <W-NNN> --evidence commit:<merge-sha> --session <sid>, then rerun this transition.",
    );
  }
  if ((options.kind === "backlog" || options.kind === "milestone") && options.to === "active"
    && (!options.hasActiveCheckpoint || !options.currentHasCheckpoint)) {
    throw new Error(`${options.kind} activation requires an active Checkpoint and current pointer in the same file plan`);
  }
  if ((options.kind === "roadmap" && options.to === "completed")
    || (options.kind === "milestone" && options.to === "shipped")
    || (options.kind === "backlog" && options.to === "done")
    || (options.kind === "risk" && TERMINAL.risk.has(options.to))) {
    if (!Number.isInteger(options.evidenceCount) || options.evidenceCount < 1) {
      throw new Error(`${options.kind} ${options.to} transition requires evidence`);
    }
  }
  if (["blocked", "deferred", "cancelled", "superseded", "abandoned", "rejected", "archived"].includes(options.to)
    || (options.kind === "risk" && options.to === "closed")) {
    nonEmpty(options.reason, `${options.to} reason`);
  }
  if (options.kind === "backlog" && options.to === "superseded") nonEmpty(options.replacement, "superseded replacement");
}

function transitionPatch(now: string, to: string, archive = false): LifecycleV3RecordPatch {
  timestamp(now, "transition time");
  return {
    status: to,
    updated: now,
    statusChanged: now,
    ...(TERMINAL.backlog.has(to) || TERMINAL.checkpoint.has(to) || TERMINAL.roadmap.has(to) || TERMINAL.milestone.has(to) || TERMINAL.risk.has(to)
      || TERMINAL.decision.has(to) || TERMINAL.blueprint.has(to)
      ? { closed: now }
      : {}),
    ...(archive || to === "archived" ? { archived: now } : {}),
  };
}

export function assertLifecycleV3ControlPath(path: string): string {
  const safe = assertSafeRelativePath(path);
  const patterns = [
    /^control\.toml$/,
    /^README\.md$/,
    /^project_dashboard\/(?:README|current|roadmap|backlog|decisions|risks|quality_gates|notes)\.md$/,
    /^roadmaps\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    /^milestones\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    /^backlog\/(?:open|archive\/\d{4})\/W-\d+-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    /^backlog_views\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    /^checkpoints\/(?:active|archive\/\d{4})\/CP-\d+-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    /^risks\/(?:open|archive\/\d{4})\/R-\d+(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?\.md$/,
    /^notes\/N-\d+-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
    /^(?:blueprints|decisions|operations|inspections|observations|reports|delegation|request_intake|scheduled_jobs|templates)\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:md|json|toml)$/,
  ];
  if (!patterns.some((pattern) => pattern.test(safe))) throw new Error(`schema-3 lifecycle path is not canonical: ${path}`);
  return safe;
}

export function planLifecycleV3Activation<TRecord, TCurrent>(options: {
  backlogPath: string;
  backlog: TRecord;
  checkpointPath: string;
  checkpoint: TRecord;
  currentPath: string;
  current: TCurrent;
  now: string;
  recordAdapter: LifecycleV3RecordAdapter<TRecord>;
  currentAdapter: LifecycleV3CurrentAdapter<TCurrent>;
}): LifecycleV3FilePlan {
  const backlogPath = assertLifecycleV3ControlPath(options.backlogPath);
  const checkpointPath = assertLifecycleV3ControlPath(options.checkpointPath);
  const currentPath = assertLifecycleV3ControlPath(options.currentPath);
  if (!backlogPath.startsWith("backlog/open/") || !checkpointPath.startsWith("checkpoints/active/")
    || currentPath !== "project_dashboard/current.md") throw new Error("activation paths do not match the canonical active layout");
  const backlog = options.recordAdapter.inspect(options.backlog);
  const checkpoint = options.recordAdapter.inspect(options.checkpoint);
  if (backlog.kind !== "backlog") throw new Error("activation backlog record kind mismatch");
  if (checkpoint.kind !== "checkpoint" || !["paused", "blocked"].includes(checkpoint.status)) {
    throw new Error("activation requires a prepared paused or blocked Checkpoint record");
  }
  assertChronology(backlog, options.now);
  assertChronology(checkpoint, options.now);
  const currentIds = options.currentAdapter.activeCheckpointIds(options.current);
  if (currentIds.includes(checkpoint.id)) throw new Error(`current already contains active Checkpoint ${checkpoint.id}`);
  assertLifecycleV3Transition({
    kind: "backlog",
    from: backlog.status,
    to: "active",
    evidenceCount: backlog.evidenceCount,
    hasActiveCheckpoint: true,
    currentHasCheckpoint: true,
  });
  const activatedBacklog = options.recordAdapter.patch(options.backlog, transitionPatch(options.now, "active"));
  const durableCheckpoint = options.recordAdapter.patch(options.checkpoint, {
    ...transitionPatch(options.now, "active"),
    backlogIds: [...new Set([...(checkpoint.backlogIds ?? []), backlog.id])],
  });
  const current = options.currentAdapter.addCheckpoint(options.current, checkpoint.id);
  return {
    entity: backlog.id,
    summary: `activate ${backlog.id} with ${checkpoint.id}`,
    writes: [
      { path: backlogPath, source: options.recordAdapter.render(activatedBacklog) },
      { path: checkpointPath, source: options.recordAdapter.render(durableCheckpoint) },
      { path: currentPath, source: options.currentAdapter.render(current) },
    ],
  };
}

/**
 * W-667 F-5 — the exact command that performs the refused terminal move, with
 * the arguments the state machine will demand once it runs (`--reason` for every
 * non-`done` terminal status, `--replacement` for superseded, recorded evidence
 * for `done`).
 */
function terminalArchiveCommand(view: LifecycleV3RecordView, to: string): string {
  const tail = "--session <sid> --expect-control-revision <rev> --expect-revision <updated-ms>";
  if (view.kind === "checkpoint") {
    return `garelier control checkpoint close ${view.id} --status ${to} ${to === "abandoned" ? "--reason <text> " : ""}${tail}`;
  }
  const reason = to === "done" ? "" : "--reason <text> ";
  const replacement = to === "superseded" ? "--replacement <id> " : "";
  // `control archive` takes backlog and checkpoint; a Risk archives through its
  // own subcommand.
  const verb = view.kind === "risk" ? `risk archive ${view.id}` : `archive ${view.kind} ${view.id}`;
  const evidence = to === "done"
    ? ` (a done ${view.kind} requires evidence — run garelier control evidence-add ${view.id} --evidence <typed-ref> --session <sid> first)`
    : "";
  return `garelier control ${verb} --to ${to} ${reason}${replacement}${tail}${evidence}`;
}

export function planLifecycleV3Transition<TRecord>(options: {
  path: string;
  record: TRecord;
  to: string;
  reason?: string;
  replacement?: string;
  hasActiveCheckpoint?: boolean;
  currentHasCheckpoint?: boolean;
  now: string;
  adapter: LifecycleV3RecordAdapter<TRecord>;
}): LifecycleV3FilePlan {
  const path = assertLifecycleV3ControlPath(options.path);
  const view = options.adapter.inspect(options.record);
  assertChronology(view, options.now);
  if ((view.kind === "backlog" || view.kind === "checkpoint" || view.kind === "risk") && TERMINAL[view.kind].has(options.to)) {
    // W-667 F-5: the plan has a name and the operator has to type it, so say it
    // here. The old sentence named the CONCEPT ("atomic terminal+archive plan")
    // and left the command, and the fact that --reason is mandatory, to be found
    // by trial.
    throw new Error(
      `terminal ${view.kind} transition must use the atomic terminal+archive plan. NEXT_COMMAND: ${terminalArchiveCommand(view, options.to)}`,
    );
  }
  assertLifecycleV3Transition({
    kind: view.kind,
    from: view.status,
    to: options.to,
    evidenceCount: view.evidenceCount,
    reason: options.reason,
    replacement: options.replacement ?? view.replacement,
    hasActiveCheckpoint: options.hasActiveCheckpoint,
    currentHasCheckpoint: options.currentHasCheckpoint,
  });
  const patch = transitionPatch(options.now, options.to);
  if (options.reason !== undefined) patch.transitionReason = nonEmpty(options.reason, "transition reason");
  if (options.replacement !== undefined) patch.replacement = nonEmpty(options.replacement, "transition replacement");
  const record = options.adapter.patch(options.record, patch);
  return {
    entity: view.id,
    summary: `${view.kind} ${view.id}: ${view.status} -> ${options.to}`,
    writes: [{ path, source: options.adapter.render(record) }],
  };
}

export function planLifecycleV3TerminalArchive<TRecord, TCurrent = never>(options: {
  sourcePath: string;
  archivePath: string;
  record: TRecord;
  to: string;
  evidenceCount: number;
  reason?: string;
  replacement?: string;
  now: string;
  adapter: LifecycleV3RecordAdapter<TRecord>;
  current?: { path: string; record: TCurrent; adapter: LifecycleV3CurrentAdapter<TCurrent> };
}): LifecycleV3FilePlan {
  const sourcePath = assertLifecycleV3ControlPath(options.sourcePath);
  const archivePath = assertLifecycleV3ControlPath(options.archivePath);
  const view = options.adapter.inspect(options.record);
  if (view.kind !== "backlog" && view.kind !== "checkpoint" && view.kind !== "risk") {
    throw new Error("only terminal Backlog, Checkpoint, and Risk records are archived by this operation");
  }
  if (!TERMINAL[view.kind].has(options.to)) throw new Error(`${view.kind} target ${options.to} is not terminal`);
  const sourcePrefix = view.kind === "backlog" ? "backlog/open/"
    : view.kind === "checkpoint" ? "checkpoints/active/" : "risks/open/";
  const archivePrefix = view.kind === "backlog" ? "backlog/archive/"
    : view.kind === "checkpoint" ? "checkpoints/archive/" : "risks/archive/";
  if (!sourcePath.startsWith(sourcePrefix) || !archivePath.startsWith(archivePrefix) || sourcePath === archivePath) {
    throw new Error(`${view.kind} terminal archive paths do not match the canonical open/archive layout`);
  }
  assertChronology(view, options.now);
  if (options.evidenceCount !== view.evidenceCount) throw new Error("terminal transition evidence precondition does not match the record");
  assertLifecycleV3Transition({
    kind: view.kind,
    from: view.status,
    to: options.to,
    evidenceCount: options.evidenceCount,
    reason: options.reason,
    replacement: options.replacement ?? view.replacement,
  });
  const patch = transitionPatch(options.now, options.to, true);
  if (options.reason !== undefined) patch.transitionReason = nonEmpty(options.reason, "transition reason");
  if (options.replacement !== undefined) patch.replacement = nonEmpty(options.replacement, "transition replacement");
  const archived = options.adapter.patch(options.record, patch);
  const writes: LifecycleV3PlannedWrite[] = [
    { path: sourcePath, source: null },
    { path: archivePath, source: options.adapter.render(archived) },
  ];
  if (view.kind === "checkpoint") {
    if (!options.current) {
      if (view.status === "active") throw new Error("active Checkpoint archive requires current pointer removal in the same file plan");
    } else {
      const currentPath = assertLifecycleV3ControlPath(options.current.path);
      if (currentPath !== "project_dashboard/current.md") throw new Error("Checkpoint archive current path is not canonical");
      const active = options.current.adapter.activeCheckpointIds(options.current.record);
      if (active.includes(view.id)) {
        const current = options.current.adapter.removeCheckpoint(options.current.record, view.id);
        writes.push({ path: currentPath, source: options.current.adapter.render(current) });
      } else if (view.status === "active") {
        throw new Error(`current does not contain active Checkpoint ${view.id}`);
      }
    }
  }
  return { entity: view.id, summary: `${view.kind} ${view.id} -> ${options.to} and archive`, writes };
}

/** Reopening a terminal Backlog is explicit and atomically restores its canonical open path. */
export function planLifecycleV3BacklogReopen<TRecord>(options: {
  sourcePath: string;
  openPath: string;
  record: TRecord;
  to: "triage" | "ready" | "blocked" | "deferred";
  reason: string;
  evidenceCount: number;
  now: string;
  adapter: LifecycleV3RecordAdapter<TRecord>;
}): LifecycleV3FilePlan {
  const sourcePath = assertLifecycleV3ControlPath(options.sourcePath);
  const openPath = assertLifecycleV3ControlPath(options.openPath);
  const view = options.adapter.inspect(options.record);
  if (view.kind !== "backlog") throw new Error("only Backlog records can be reopened by this operation");
  if (!TERMINAL.backlog.has(view.status)) throw new Error(`backlog-reopen requires terminal Backlog: ${view.id}`);
  if (!sourcePath.startsWith("backlog/archive/") || !openPath.startsWith("backlog/open/") || sourcePath === openPath) {
    throw new Error("Backlog reopen paths do not match the canonical archive/open layout");
  }
  assertChronology(view, options.now);
  if (!Number.isInteger(options.evidenceCount) || options.evidenceCount < 1 || options.evidenceCount !== view.evidenceCount) {
    throw new Error("backlog-reopen requires current evidence and a matching evidence precondition");
  }
  const reopened = options.adapter.patch(options.record, {
    status: options.to,
    updated: options.now,
    statusChanged: options.now,
    clearClosed: true,
    clearArchived: true,
    clearReplacement: true,
    transitionReason: nonEmpty(options.reason, "reopen reason"),
  });
  return {
    entity: view.id,
    summary: `backlog ${view.id}: ${view.status} -> ${options.to} and reopen`,
    writes: [
      { path: sourcePath, source: null },
      { path: openPath, source: options.adapter.render(reopened) },
    ],
  };
}

/** Reopening a terminal Risk is intentionally explicit and atomically restores its active path. */
export function planLifecycleV3RiskReopen<TRecord>(options: {
  sourcePath: string;
  openPath: string;
  record: TRecord;
  reason: string;
  evidenceCount: number;
  now: string;
  adapter: LifecycleV3RecordAdapter<TRecord>;
}): LifecycleV3FilePlan {
  const sourcePath = assertLifecycleV3ControlPath(options.sourcePath);
  const openPath = assertLifecycleV3ControlPath(options.openPath);
  const view = options.adapter.inspect(options.record);
  if (view.kind !== "risk") throw new Error("only Risk records can be reopened by this operation");
  if (!TERMINAL.risk.has(view.status)) throw new Error(`risk-reopen requires terminal Risk: ${view.id}`);
  if (!sourcePath.startsWith("risks/archive/") || !openPath.startsWith("risks/open/") || sourcePath === openPath) {
    throw new Error("Risk reopen paths do not match the canonical archive/open layout");
  }
  assertChronology(view, options.now);
  if (!Number.isInteger(options.evidenceCount) || options.evidenceCount < 1 || options.evidenceCount !== view.evidenceCount) {
    throw new Error("risk-reopen requires current evidence and a matching evidence precondition");
  }
  const reopened = options.adapter.patch(options.record, {
    status: "open",
    updated: options.now,
    statusChanged: options.now,
    clearClosed: true,
    clearArchived: true,
    transitionReason: nonEmpty(options.reason, "reopen reason"),
  });
  return {
    entity: view.id,
    summary: `risk ${view.id}: ${view.status} -> open and reopen`,
    writes: [
      { path: sourcePath, source: null },
      { path: openPath, source: options.adapter.render(reopened) },
    ],
  };
}

export interface LifecycleV3RelationView {
  id: string;
  state: "active" | "retired";
  added: string;
  updated: string;
  retired?: string;
  retireReason?: string;
}

export interface LifecycleV3RelationAdapter<TOwner> {
  inspect(owner: TOwner): readonly LifecycleV3RelationView[];
  retire(owner: TOwner, relationId: string, patch: {
    state: "retired";
    updated: string;
    retired: string;
    retireReason: string;
  }): TOwner;
  render(owner: TOwner): string;
}

export function planLifecycleV3RelationRetirement<TOwner>(options: {
  ownerPath: string;
  owner: TOwner;
  relationId: string;
  reason: string;
  now: string;
  adapter: LifecycleV3RelationAdapter<TOwner>;
}): LifecycleV3FilePlan {
  const ownerPath = assertLifecycleV3ControlPath(options.ownerPath);
  if (!/^rel-\d+$/.test(options.relationId)) throw new Error(`invalid owner-local relation ID: ${options.relationId}`);
  const reason = nonEmpty(options.reason, "relation retire reason");
  const relation = options.adapter.inspect(options.owner).find((candidate) => candidate.id === options.relationId);
  if (!relation) throw new Error(`relation does not exist: ${options.relationId}`);
  if (relation.state !== "active") throw new Error(`relation is already retired: ${options.relationId}`);
  const now = timestamp(options.now, "relation retirement time");
  if (Date.parse(now) < Date.parse(relation.added)) throw new Error("relation retirement cannot precede relation addition");
  const owner = options.adapter.retire(options.owner, options.relationId, {
    state: "retired",
    updated: now,
    retired: now,
    retireReason: reason,
  });
  return {
    summary: `retire ${options.relationId}`,
    writes: [{ path: ownerPath, source: options.adapter.render(owner) }],
  };
}

export function planLifecycleV3Purge(options: {
  targetPath: string;
  targetHash: string;
  manifestPath: string;
  classification: "mistake" | "empty_scaffold" | "typo_duplicate";
  sharing: "uncommitted" | "proven_unshared" | "unknown" | "shared";
  reachability: "proven_unreachable" | "unknown" | "reachable";
  inboundRelations: number;
  outboundRelations: number;
  referenceCount: number;
  usedAsAuthority: boolean;
  hasUniqueInformation: boolean;
  reason: string;
  agent: string;
  now: string;
  userApprovalRef?: string;
}): LifecycleV3FilePlan {
  const reason = nonEmpty(options.reason, "purge reason");
  const agent = nonEmpty(options.agent, "purge agent");
  timestamp(options.now, "purge timestamp");
  const targetPath = assertLifecycleV3ControlPath(options.targetPath);
  const manifestPath = assertLifecycleV3ControlPath(options.manifestPath);
  if (targetPath === manifestPath) throw new Error("purge manifest cannot replace the purge target");
  if (!/^sha256:[0-9a-f]{64}$/.test(options.targetHash)) throw new Error("purge target hash is invalid");
  if (options.sharing === "shared") throw new Error("purge target is shared");
  const userApprovalRef = options.sharing === "unknown"
    ? nonEmpty(options.userApprovalRef, "unknown sharing approval reference")
    : options.userApprovalRef?.trim();
  if (options.reachability !== "proven_unreachable") throw new Error("local and remote reachability must be proven unreachable");
  if (options.inboundRelations !== 0 || options.outboundRelations !== 0) throw new Error("purge target still has relations");
  if (options.referenceCount !== 0) throw new Error("purge target is still referenced");
  if (options.usedAsAuthority) throw new Error("purge target was used as repository or user authority");
  if (options.hasUniqueInformation) throw new Error("purge target contains unique information");
  const manifest = canonicalJson({
    schema_version: 1,
    kind: "garelier_control_purge_manifest",
    control_schema_version: 3,
    storage: "plan_graph_markdown",
    path: targetPath,
    sha256: options.targetHash,
    classification: options.classification,
    reason,
    agent,
    purged_at: options.now,
    sharing: options.sharing,
    unknown_sharing_approval: userApprovalRef ?? null,
  });
  return {
    summary: `purge ${options.targetPath}`,
    writes: [
      { path: targetPath, source: null },
      { path: manifestPath, source: manifest },
    ],
  };
}

export function planLifecycleV3BeginAction<TCheckpoint>(options: {
  checkpointPath: string;
  checkpoint: TCheckpoint;
  exactNextAction: string;
  repositoryState: string;
  successCondition: string;
  targets: string[];
  now: string;
  adapter: LifecycleV3CheckpointAdapter<TCheckpoint>;
}): LifecycleV3FilePlan {
  const checkpointPath = assertLifecycleV3ControlPath(options.checkpointPath);
  if (!checkpointPath.startsWith("checkpoints/active/")) throw new Error("begin-action requires an active Checkpoint path");
  const view = options.adapter.inspect(options.checkpoint);
  if (view.kind !== "checkpoint" || !["active", "paused", "blocked"].includes(view.status)) {
    throw new Error("begin-action requires a non-terminal Checkpoint");
  }
  const exactNextAction = nonEmpty(options.exactNextAction, "Exact next action");
  const repositoryState = nonEmpty(options.repositoryState, "action-before repository state");
  const success = nonEmpty(options.successCondition, "action success condition");
  const targets = [...new Set(options.targets.map((target) => nonEmpty(target, "action target")))].sort();
  if (!targets.length) throw new Error("begin-action requires at least one target");
  const now = timestamp(options.now, "begin-action time");
  assertChronology(view, now);
  const token = sha256(canonicalJson({
    checkpoint: view.id,
    exact_next_action: exactNextAction,
    repository_state: repositoryState,
    success_condition: success,
    targets,
    prepared_at: now,
  }));
  const checkpoint = options.adapter.beginAction(options.checkpoint, {
    token,
    preparedAt: now,
    exactNextAction,
    before: repositoryState,
    success,
    targets,
  });
  const updated = options.adapter.patch(checkpoint, { updated: now });
  return {
    entity: view.id,
    summary: `begin action ${view.id}`,
    writes: [{ path: checkpointPath, source: options.adapter.render(updated) }],
  };
}

export function planLifecycleV3FinishAction<TCheckpoint>(options: {
  checkpointPath: string;
  checkpoint: TCheckpoint;
  expectedActionToken: string;
  result: string;
  changedFiles: string[];
  repositoryState: string;
  exactNextAction: string;
  now: string;
  adapter: LifecycleV3CheckpointAdapter<TCheckpoint>;
}): LifecycleV3FilePlan {
  const checkpointPath = assertLifecycleV3ControlPath(options.checkpointPath);
  if (!checkpointPath.startsWith("checkpoints/active/")) throw new Error("finish-action requires an active Checkpoint path");
  const view = options.adapter.inspect(options.checkpoint);
  if (view.kind !== "checkpoint" || !["active", "paused", "blocked"].includes(view.status)) {
    throw new Error("finish-action requires a non-terminal Checkpoint");
  }
  const action = options.adapter.inspectAction(options.checkpoint);
  if (!action.token || action.token !== options.expectedActionToken) throw new Error("finish-action precondition is stale");
  const lastCompleted = nonEmpty(action.exactNextAction, "prepared action");
  const result = nonEmpty(options.result, "action result");
  const repositoryState = nonEmpty(options.repositoryState, "action-after repository state");
  const exactNextAction = nonEmpty(options.exactNextAction, "next Exact next action");
  const changedFiles = [...new Set(options.changedFiles.map((path) => nonEmpty(path, "changed file")))].sort();
  const now = timestamp(options.now, "finish-action time");
  if (Date.parse(now) < Date.parse(view.updated)) throw new Error("finish-action cannot move Checkpoint.updated backwards");
  const checkpoint = options.adapter.finishAction(options.checkpoint, {
    finishedAt: now,
    lastCompleted,
    result,
    changedFiles,
    repositoryState,
    exactNextAction,
  });
  const updated = options.adapter.patch(checkpoint, { updated: now });
  return {
    entity: view.id,
    summary: `finish action ${view.id}`,
    writes: [{ path: checkpointPath, source: options.adapter.render(updated) }],
  };
}
