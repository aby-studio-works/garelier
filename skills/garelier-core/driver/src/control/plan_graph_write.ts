import { existsSync, lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { markdownSections, parseControlFrontmatter, sectionBody } from "./control_frontmatter.ts";
import { assertLifecycleV3ControlPath, type LifecycleV3CheckpointAdapter, type LifecycleV3CurrentAdapter, type LifecycleV3FilePlan, type LifecycleV3RecordAdapter, type LifecycleV3RelationAdapter } from "./lifecycle_v3.ts";
import { loadPlanGraphModel } from "./plan_graph_model.ts";
import {
  canonicalBacklogReference,
  milestoneTargetsFromTypedEdges,
} from "./plan_graph_milestone_inheritance.ts";
import { DEFAULT_PLAN_GRAPH_LIMITS, type BacklogRecord, type CanonicalMarkdownRecord, type CheckpointRecord, type CurrentRecord, type MilestoneRecord, type NoteRecord, type PlanGraphArtifactRecord, type PlanGraphControlModel, type RiskLevel, type RiskRecord, type RoadmapRecord } from "./plan_graph_types.ts";
import { controlTreeSourceDigest, type ControlFilePlanCallbacks } from "./transaction.ts";
import type { ControlRuntimeCallbacks } from "./sessions.ts";
import { EVIDENCE_WRITER_STORAGE_KEY, type EvidenceReference } from "./types.ts";
import { typedTargetExists } from "./plan_graph_validate.ts";

export type LifecyclePlanGraphRecord = RoadmapRecord | MilestoneRecord | BacklogRecord | CheckpointRecord | RiskRecord | PlanGraphArtifactRecord;
export type RelationOwnerRecord = RoadmapRecord | MilestoneRecord | BacklogRecord;

const TERMINAL_BACKLOG = new Set(["done", "cancelled", "superseded"]);
const compare = (left: string, right: string): number => left.localeCompare(right);

function renderedDocument(data: Record<string, unknown>, body: string): string {
  const toml = stringifyToml(data).trimEnd();
  return `+++\n${toml}\n+++\n${body.startsWith("\n") ? body : `\n${body}`}`.replace(/\n*$/, "\n");
}

export function mutateDocument<T extends CanonicalMarkdownRecord>(
  record: T,
  mutateData?: (data: Record<string, unknown>) => void,
  mutateBody?: (body: string) => string,
): T {
  const parsed = parseControlFrontmatter(record.source, record.path);
  const data = structuredClone(parsed.data);
  mutateData?.(data);
  const body = mutateBody ? mutateBody(parsed.body) : parsed.body;
  return { ...record, source: renderedDocument(data, body), frontmatter: data, body } as T;
}

function newlineConvention(source: string): "\r\n" | "\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeBody(value: string, newline: "\r\n" | "\n"): string {
  return value.trim().replace(/\r?\n/g, newline);
}

export function replaceMarkdownSection(
  source: string,
  heading: string,
  value: string,
  aliases: readonly string[] = [],
): string {
  const newline = newlineConvention(source);
  const lines = source.split(/\r?\n/);
  const match = heading.match(/^(#{1,6})\s+(.+)$/);
  if (!match) throw new Error(`invalid Markdown heading: ${heading}`);
  const level = match[1]!.length;
  const acceptedHeadings = new Set([heading, ...aliases].map((value) => value.trim().toLowerCase()));
  const start = aliases.length
    ? (() => {
        const starts = lines
          .map((line, index) => acceptedHeadings.has(line.trim().toLowerCase()) ? index : -1)
          .filter((index) => index >= 0);
        if (starts.length > 1) {
          throw new Error(`ambiguous Markdown section headings: ${starts.map((index) => lines[index]!.trim()).join(", ")}`);
        }
        return starts[0] ?? -1;
      })()
    : lines.findIndex((line) => acceptedHeadings.has(line.trim().toLowerCase()));
  const replacement = [heading, "", normalizeBody(value, newline)];
  if (start < 0) {
    const prefix = lines.join(newline).trimEnd();
    return `${prefix}${prefix ? `${newline}${newline}` : ""}${replacement.join(newline).trimEnd()}${newline}`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const candidate = lines[index]!.match(/^(#{1,6})\s+/);
    if (candidate && candidate[1]!.length <= level) { end = index; break; }
  }
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)]
    .join(newline).replace(/(?:\r?\n)*$/, newline);
}

const BACKLOG_ACCEPTANCE_HEADING = "## Acceptance criteria";
const LEGACY_BACKLOG_ACCEPTANCE_HEADING = "## AC";
const ACCEPTANCE_CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(?:AC-(\d+):\s*)?(.+?)\s*$/i;

function acceptanceReplacement(values: readonly string[]): string {
  if (!values.length) throw new Error("--set-acceptance requires at least one criterion");
  return values.map((value, index) => {
    const text = value.trim();
    if (!text) throw new Error("--set-acceptance criteria must not be empty");
    if (/\r|\n/.test(text)) throw new Error("--set-acceptance criteria must be single-line text");
    return `- [ ] AC-${index + 1}: ${text}`;
  }).join("\n");
}

function checkedAcceptance(source: string, selectors: readonly string[]): string {
  const lines = source.split(/\r?\n/);
  const criteria = lines.flatMap((line, lineIndex) => {
    const match = line.match(ACCEPTANCE_CHECKBOX);
    return match ? [{
      lineIndex,
      prefix: match[1]!,
      suffix: `${match[3]!}${match[4] ? `AC-${match[4]}: ` : ""}${match[5]!}`,
      explicitOrdinal: match[4] ? Number(match[4]) : null,
    }] : [];
  });
  if (!criteria.length) throw new Error("Backlog acceptance checklist has no criteria");
  const hasExplicitOrdinals = criteria.some((criterion) => criterion.explicitOrdinal !== null);
  if (hasExplicitOrdinals && criteria.some((criterion) => criterion.explicitOrdinal === null)) {
    throw new Error("Backlog acceptance checklist mixes ordinal and legacy criteria");
  }
  if (hasExplicitOrdinals) {
    criteria.forEach((criterion, index) => {
      if (criterion.explicitOrdinal !== index + 1) {
        throw new Error(`Backlog acceptance checklist has invalid or duplicate ordinal AC-${criterion.explicitOrdinal}`);
      }
    });
  }
  const selected = new Set<number>();
  for (const selector of selectors) {
    const match = selector.trim().match(/^(?:AC-)?([1-9]\d*)$/i);
    if (!match) throw new Error(`invalid acceptance selector: ${selector}`);
    const ordinal = Number(match[1]);
    if (ordinal > criteria.length) throw new Error(`acceptance selector out of range: ${selector}`);
    if (selected.has(ordinal)) throw new Error(`duplicate acceptance selector: ${selector}`);
    selected.add(ordinal);
  }
  if (!selected.size) throw new Error("--check-acceptance requires at least one selector");
  for (const ordinal of selected) {
    const criterion = criteria[ordinal - 1]!;
    lines[criterion.lineIndex] = `${criterion.prefix}x${criterion.suffix}`;
  }
  return lines.join(newlineConvention(source));
}

function updateBacklogAcceptance(
  body: string,
  replacement: readonly string[] | undefined,
  selectors: readonly string[] | undefined,
): string {
  if (replacement !== undefined && selectors !== undefined) {
    throw new Error("--set-acceptance and --check-acceptance cannot be combined");
  }
  if (replacement !== undefined) {
    return replaceMarkdownSection(
      body,
      BACKLOG_ACCEPTANCE_HEADING,
      acceptanceReplacement(replacement),
      [LEGACY_BACKLOG_ACCEPTANCE_HEADING],
    );
  }
  if (selectors !== undefined) {
    const sections = markdownSections(body).filter((section) =>
      section.level === 2
      && ["acceptance criteria", "ac"].includes(section.heading.trim().toLowerCase()));
    if (sections.length !== 1) {
      throw new Error(sections.length
        ? "ambiguous Backlog acceptance headings"
        : "Backlog acceptance checklist is missing");
    }
    return replaceMarkdownSection(
      body,
      BACKLOG_ACCEPTANCE_HEADING,
      checkedAcceptance(sections[0]!.body, selectors),
      [LEGACY_BACKLOG_ACCEPTANCE_HEADING],
    );
  }
  return body;
}

const EMPTY_EVIDENCE_LINE = /^\s*[-*]\s*(?:none(?:\s+recorded)?\.?|-)?\s*$/i;

function evidenceCount(record: LifecyclePlanGraphRecord): number {
  const evidence = (record.kind === "backlog"
    ? record.evidence
    : sectionBody(markdownSections(record.body), "Evidence")).trim();
  if (!evidence || EMPTY_EVIDENCE_LINE.test(evidence)) return 0;
  return evidence.split(/\r?\n/).filter((line) => line.trim() && !EMPTY_EVIDENCE_LINE.test(line)).length;
}

/**
 * Appends typed-ref evidence lines to an existing `## Evidence` section body,
 * dropping placeholder lines ("- None recorded.") instead of preserving them.
 * Shared by `evidence-add` (control.ts) and any other v3 flow that needs
 * append-not-replace semantics on Backlog/Risk evidence (`planBacklogUpdate`
 * / `planRiskUpdate`'s `evidence` option replaces the whole section body).
 * Existing manual prose, indentation, blank lines, and line-ending style are retained.
 */
export function appendEvidenceLines(existing: string, lines: readonly string[]): string {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const prior = existing.split(/\r?\n/).filter((line) => !EMPTY_EVIDENCE_LINE.test(line));
  const preserved = prior.join(newline);
  if (!lines.length) return preserved;
  if (!preserved) return lines.join(newline);
  return `${preserved}${preserved.endsWith(newline) ? "" : newline}${lines.join(newline)}`;
}

export const planGraphRecordAdapter: LifecycleV3RecordAdapter<LifecyclePlanGraphRecord> = {
  inspect(record) {
    return {
      kind: record.kind,
      id: record.kind === "roadmap" || record.kind === "milestone" ? record.slug : record.id,
      status: record.status,
      created: record.created,
      updated: record.updated,
      statusChanged: record.statusChanged,
      closed: record.closed,
      archived: record.archived,
      evidenceCount: evidenceCount(record),
      replacement: record.kind === "backlog" ? record.replacement ?? undefined : undefined,
      backlogIds: record.kind === "checkpoint" ? record.backlog : undefined,
    };
  },
  patch(record, patch) {
    return mutateDocument(record, (data) => {
      data.status = patch.status ?? data.status;
      data.updated = patch.updated;
      if (patch.statusChanged !== undefined) data.status_changed = patch.statusChanged;
      if (patch.clearClosed) delete data.closed;
      else if (patch.closed !== undefined) data.closed = patch.closed;
      if (patch.clearArchived) delete data.archived;
      else if (patch.archived !== undefined) data.archived = patch.archived;
      if (patch.clearReplacement) {
        delete data.replacement;
        delete data.superseded_by;
      } else if (patch.replacement !== undefined) data.replacement = patch.replacement;
      if (patch.transitionReason !== undefined) data.transition_reason = patch.transitionReason;
      if (patch.backlogIds !== undefined && record.kind === "checkpoint") data.backlog = patch.backlogIds;
    });
  },
  render(record) { return record.source; },
};

export const planGraphRiskAdapter: LifecycleV3RecordAdapter<RiskRecord> =
  planGraphRecordAdapter as LifecycleV3RecordAdapter<RiskRecord>;

function checkpointAction(record: CheckpointRecord): Record<string, unknown> {
  const parsed = parseControlFrontmatter(record.source, record.path);
  const action = parsed.data.action;
  return action && typeof action === "object" && !Array.isArray(action)
    ? action as Record<string, unknown>
    : {};
}

export const planGraphCheckpointAdapter: LifecycleV3CheckpointAdapter<CheckpointRecord> = {
  ...planGraphRecordAdapter as LifecycleV3RecordAdapter<CheckpointRecord>,
  inspectAction(checkpoint) {
    const action = checkpointAction(checkpoint);
    return {
      token: typeof action.token === "string" ? action.token : undefined,
      exactNextAction: typeof action.exact_next_action === "string" ? action.exact_next_action : undefined,
    };
  },
  beginAction(checkpoint, patch) {
    return mutateDocument(checkpoint, (data) => {
      data.action = {
        token: patch.token,
        prepared_at: patch.preparedAt,
        exact_next_action: patch.exactNextAction,
        before: patch.before,
        success: patch.success,
        targets: patch.targets,
      };
    }, (body) => {
      const inProgress = replaceMarkdownSection(body, "### In progress", [
        `Action token: \`${patch.token}\``,
        `Prepared: ${patch.preparedAt}`,
        `Success: ${patch.success}`,
        `Targets: ${patch.targets.join(", ")}`,
      ].join("\n"));
      return replaceMarkdownSection(inProgress, "### Exact next action", patch.exactNextAction);
    });
  },
  finishAction(checkpoint, patch) {
    return mutateDocument(checkpoint, (data) => {
      delete data.action;
      data.branch = data.branch ?? "-";
    }, (body) => {
      let next = replaceMarkdownSection(body, "### Last completed", `${patch.lastCompleted}\n\nResult: ${patch.result}`);
      next = replaceMarkdownSection(next, "### Exact next action", patch.exactNextAction);
      next = replaceMarkdownSection(next, "### In progress", "-");
      next = replaceMarkdownSection(next, "## Partial repository state", [
        `Repository state: ${patch.repositoryState}`,
        `Changed files: ${patch.changedFiles.length ? patch.changedFiles.join(", ") : "-"}`,
      ].join("\n"));
      return next;
    });
  },
};

function currentCheckpointIds(current: CurrentRecord): string[] {
  return [...new Set([
    ...(current.primaryCheckpointId ? [current.primaryCheckpointId] : []),
    ...current.checkpointCandidates,
  ])];
}

function renderCurrent(current: CurrentRecord, ids: string[]): string {
  const primary = ids.includes(current.primaryCheckpointId ?? "") ? current.primaryCheckpointId : ids[0] ?? null;
  const lines = [
    `- Primary checkpoint: ${primary ? `\`checkpoint:${primary}\`` : "-"}`,
    ...ids.map((id) => `- \`checkpoint:${id}\``),
  ];
  return replaceMarkdownSection(current.source, "## Active checkpoints", lines.join("\n"));
}

export const planGraphCurrentAdapter: LifecycleV3CurrentAdapter<CurrentRecord> = {
  activeCheckpointIds: currentCheckpointIds,
  addCheckpoint(current, checkpointId) {
    const ids = currentCheckpointIds(current);
    if (!ids.includes(checkpointId)) ids.push(checkpointId);
    return { ...current, source: renderCurrent(current, ids), primaryCheckpointId: current.primaryCheckpointId ?? checkpointId, checkpointCandidates: ids };
  },
  removeCheckpoint(current, checkpointId) {
    const ids = currentCheckpointIds(current).filter((id) => id !== checkpointId);
    const primaryCheckpointId = current.primaryCheckpointId === checkpointId ? ids[0] ?? null : current.primaryCheckpointId;
    const next = { ...current, primaryCheckpointId, checkpointCandidates: ids };
    return { ...next, source: renderCurrent(next, ids) };
  },
  render(current) { return current.source; },
};

function relationTables(record: RelationOwnerRecord): Array<Record<string, unknown>> {
  const data = parseControlFrontmatter(record.source, record.path).data;
  const names = record.kind === "roadmap" ? ["milestone_links"]
    : record.kind === "milestone" ? ["child_links"]
      : ["milestone_memberships", "view_memberships"];
  return names.flatMap((name) => Array.isArray(data[name]) ? data[name] as Array<Record<string, unknown>> : []);
}

export const planGraphRelationAdapter: LifecycleV3RelationAdapter<RelationOwnerRecord> = {
  inspect(owner) {
    return relationTables(owner).map((row) => ({
      id: String(row.id ?? row.rel ?? row.relation_id),
      state: row.state === "retired" ? "retired" : "active",
      added: String(row.added),
      updated: String(row.updated),
      retired: typeof row.retired === "string" ? row.retired : undefined,
      retireReason: typeof row.retire_reason === "string" ? row.retire_reason : undefined,
    }));
  },
  retire(owner, relationId, patch) {
    return mutateDocument(owner, (data) => {
      data.updated = patch.updated;
      for (const key of ["milestone_links", "child_links", "milestone_memberships", "view_memberships"]) {
        if (!Array.isArray(data[key])) continue;
        data[key] = (data[key] as Array<Record<string, unknown>>).map((row) =>
          String(row.id ?? row.rel ?? row.relation_id) === relationId
            ? { ...row, state: patch.state, updated: patch.updated, retired: patch.retired, retire_reason: patch.retireReason }
            : row);
      }
    });
  },
  render(owner) { return owner.source; },
};

function strictModel(controlRoot: string): PlanGraphControlModel {
  const model = loadPlanGraphModel(controlRoot);
  const error = model.findings.find((finding) => finding.severity === "error");
  if (error) throw new Error(`schema-3 strict validation failed: ${error.code}: ${error.message}`);
  return model;
}

function dependencyRepairModel(controlRoot: string): PlanGraphControlModel {
  const model = loadPlanGraphModel(controlRoot);
  const allowed = new Set([
    "milestone-dependency-cycle",
    "milestone-dependency-target-missing",
    "milestone-dependency-target-ambiguous",
  ]);
  const error = model.findings.find((finding) => finding.severity === "error" && !allowed.has(finding.code));
  if (error) throw new Error(`schema-3 strict validation failed: ${error.code}: ${error.message}`);
  return model;
}

export function planGraphEntityRevision(record: BacklogRecord | RiskRecord): number {
  const value = Math.floor(Date.parse(record.updated) / 1_000);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${record.kind} ${record.id} has no valid entity revision timestamp`);
  return value;
}

export function planGraphArtifactEntityRevision(record: PlanGraphArtifactRecord): number {
  const value = Date.parse(record.updated);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${record.kind} ${record.id} has no valid entity revision timestamp`);
  return value;
}

export const planGraphTransactionCallbacks: ControlFilePlanCallbacks<PlanGraphControlModel> = {
  load({ controlRoot }) {
    const model = strictModel(controlRoot);
    return {
      state: model,
      revision: model.revision,
      sourceDigest: controlTreeSourceDigest(controlRoot),
      entityRevision(id: string) {
        if (id.startsWith("decision:")) {
          const record = model.decisions.get(id.slice("decision:".length));
          return record ? planGraphArtifactEntityRevision(record) : null;
        }
        if (id.startsWith("blueprint:")) {
          const record = model.blueprints.get(id.slice("blueprint:".length));
          return record ? planGraphArtifactEntityRevision(record) : null;
        }
        const record = model.backlog.get(id) ?? model.risks.get(id);
        return record ? planGraphEntityRevision(record) : null;
      },
    };
  },
  normalizePath: assertLifecycleV3ControlPath,
};

export const planGraphDependencyRepairTransactionCallbacks: ControlFilePlanCallbacks<PlanGraphControlModel> = {
  ...planGraphTransactionCallbacks,
  loadBefore({ controlRoot }) {
    const model = dependencyRepairModel(controlRoot);
    return {
      state: model,
      revision: model.revision,
      sourceDigest: controlTreeSourceDigest(controlRoot),
    };
  },
};

export const planGraphRuntimeCallbacks: ControlRuntimeCallbacks = {
  load({ controlRoot }) {
    const model = strictModel(controlRoot);
    return {
      revision: model.revision,
      claimTtlSeconds: 1_800,
      claimStaleAfterSeconds: 900,
      entity(id) {
        const record = model.backlog.get(id) ?? model.risks.get(id);
        return record ? {
          revision: planGraphEntityRevision(record),
          terminal: record.kind === "backlog" ? TERMINAL_BACKLOG.has(record.status) : ["closed", "superseded"].includes(record.status),
        } : null;
      },
    };
  },
};

export function planGraphRecord(model: PlanGraphControlModel, kind: string, id: string): LifecyclePlanGraphRecord {
  const record = kind === "roadmap" ? model.roadmaps.get(id)
    : kind === "milestone" ? model.milestones.get(id)
      : kind === "backlog" ? model.backlog.get(id)
        : kind === "checkpoint" ? model.checkpoints.get(id)
          : kind === "risk" ? model.risks.get(id)
          : undefined;
  if (!record) throw new Error(`${kind} does not exist: ${id}`);
  return record;
}

export function planGraphArtifactRecord(
  model: PlanGraphControlModel,
  kind: "decision" | "blueprint",
  id: string,
): PlanGraphArtifactRecord {
  const record = kind === "decision" ? model.decisions.get(id) : model.blueprints.get(id);
  if (!record) throw new Error(`${kind} does not exist: ${id}`);
  return record;
}

export function relationOwner(model: PlanGraphControlModel, typedOwner: string): RelationOwnerRecord {
  const [kind, id] = typedOwner.split(":", 2);
  if (!id || !["roadmap", "milestone", "backlog"].includes(kind!)) throw new Error(`invalid relation owner: ${typedOwner}`);
  return planGraphRecord(model, kind!, id) as RelationOwnerRecord;
}

// Extracted from allocateBacklogId (W-215) so the shared cross-worktree
// allocator (plan_graph_shared_ids.ts) can use the same local-model floor
// without duplicating the id-parsing regex. Pure and git/fs-free by design —
// the impure git-common-dir lookup lives in plan_graph_shared_ids.ts, this
// file stays a pure in-memory-model transform.
export function nextBacklogNumber(model: PlanGraphControlModel): number {
  return [...model.backlog.keys()].reduce((value, id) => Math.max(value, Number(/^W-(\d+)$/.exec(id)?.[1] ?? 0)), 0) + 1;
}

export function allocateBacklogId(model: PlanGraphControlModel): string {
  return `W-${String(nextBacklogNumber(model)).padStart(3, "0")}`;
}

export function allocateCheckpointId(model: PlanGraphControlModel): string {
  const maximum = [...model.checkpoints.keys()].reduce((value, id) => Math.max(value, Number(/^CP-(\d+)$/.exec(id)?.[1] ?? 0)), 0);
  return `CP-${String(maximum + 1).padStart(3, "0")}`;
}

export function allocateRiskId(model: PlanGraphControlModel): string {
  const maximum = [...model.risks.keys()].reduce((value, id) => Math.max(value, Number(/^R-(\d+)$/.exec(id)?.[1] ?? 0)), 0);
  return `R-${String(maximum + 1).padStart(3, "0")}`;
}

export function allocateNoteId(model: PlanGraphControlModel): string {
  const maximum = model.notes.reduce((value, note) => Math.max(value, Number(/^N-(\d+)$/.exec(note.id)?.[1] ?? 0)), 0);
  return `N-${String(maximum + 1).padStart(3, "0")}`;
}

const SAFE_SLUG_MAX_LENGTH = 80;

export function safeSlug(value: string): string {
  // The canonical schema-3 lifecycle path regex (assertLifecycleV3ControlPath)
  // requires the slug to START with an alnum char (`[A-Za-z0-9][A-Za-z0-9._-]*`).
  // Strip a leading run of "." / "-" / "_" too, not just "-" — "_" IS in the
  // allowed slug charset (kept throughout the rest of the slug) but is not
  // alnum, so a title beginning with it (e.g. "_internal note") would
  // otherwise slugify to "_internal-note" and fail canonicality (W-207 N4,
  // Guardian). A title beginning with a literal path reference (e.g.
  // "../blueprints/x.md`; DEC-096") gets the same treatment for "..".
  let slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  // A free-text legacy title/detail cell can run to hundreds of characters;
  // an unbounded slug produces a filename component past the filesystem's
  // per-component limit (NTFS/ext4 ~255 bytes) and the write fails outright.
  // The id prefix already guarantees uniqueness, so truncating here cannot
  // introduce a collision (W-207). A title with no alnum/._- content at all
  // (e.g. entirely non-ASCII, or entirely "_"/"."/"-") collapses to "" here;
  // the id prefix keeps "item" unique across records regardless.
  if (slug.length > SAFE_SLUG_MAX_LENGTH) slug = slug.slice(0, SAFE_SLUG_MAX_LENGTH).replace(/[._-]+$/, "");
  return slug || "item";
}

export interface PlanGraphArtifactMetadataInput {
  title: string;
  related?: string[];
  supersedes?: string[];
  backlogIds?: string[];
  decisionIds?: string[];
  acceptanceIds?: string[];
}

export interface PlanGraphArtifactMetadataPatch {
  title?: string;
  related?: string[];
  supersedes?: string[];
  backlogIds?: string[];
  decisionIds?: string[];
  acceptanceIds?: string[];
}

const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function artifactSlug(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) || WINDOWS_RESERVED_FILENAME.test(value)) {
    throw new Error(`${label} must be a safe non-reserved filename slug of at most 80 characters`);
  }
  return value;
}

function normalizedArtifactRelated(model: PlanGraphControlModel, values: readonly string[] | undefined): string[] {
  const normalized = [...new Set((values ?? []).map((value) => /^W-\d{3,}$/.test(value) ? `backlog:${value}` : value))].sort(compare);
  for (const reference of normalized) {
    if (reference.startsWith("report:") || !typedTargetExists(model, reference)) {
      throw new Error(`artifact related target does not resolve uniquely: ${reference}`);
    }
  }
  return normalized;
}

function artifactIdentityFromFilename(kind: "decision" | "blueprint", filename: string): string | undefined {
  if (kind === "decision") return /^(DEC-\d{3,})(?:-.*)?\.md$/i.exec(filename)?.[1];
  return /^(.*)\.md$/i.exec(filename)?.[1];
}

interface ActualArtifactInventory {
  ownerPaths: string[];
  identityPaths: string[];
}

function actualArtifactInventory(
  model: PlanGraphControlModel,
  path: string,
  artifactKind: "decision" | "blueprint",
  id: string,
): ActualArtifactInventory {
  const separator = path.indexOf("/");
  const relativeDirectory = path.slice(0, separator);
  const filename = path.slice(separator + 1);
  const foldedFilename = filename.toLocaleLowerCase("en-US");
  const foldedIdentity = id.toLocaleLowerCase("en-US");
  const ownerPaths: string[] = [];
  const identityPaths: string[] = [];
  for (const candidateKind of ["decision", "blueprint"] as const) {
    const directoryName = candidateKind === "decision" ? "decisions" : "blueprints";
    const directory = join(model.controlRoot, directoryName);
    if (!existsSync(directory)) continue;
    const directoryInfo = lstatSync(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error(`artifact owner directory must be a real directory: ${directoryName}`);
    }
    const handle = opendirSync(directory);
    let count = 0;
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        if (++count > DEFAULT_PLAN_GRAPH_LIMITS.maxEntities) {
          throw new Error(`artifact owner directory exceeds ${DEFAULT_PLAN_GRAPH_LIMITS.maxEntities} entries: ${directoryName}`);
        }
        const relative = `${directoryName}/${entry.name}`;
        const info = lstatSync(join(directory, entry.name));
        if (entry.isSymbolicLink() || info.isSymbolicLink()) {
          throw new Error(`artifact owner directory contains a symlink, junction, or reparse alias: ${relative}`);
        }
        if (!entry.isFile() || !info.isFile()) {
          throw new Error(`artifact owner directory contains a non-regular entry: ${relative}`);
        }
        if (directoryName === relativeDirectory && entry.name.toLocaleLowerCase("en-US") === foldedFilename) {
          ownerPaths.push(relative);
        }
        const candidateIdentity = artifactIdentityFromFilename(candidateKind, entry.name);
        if (candidateKind === artifactKind && candidateIdentity?.toLocaleLowerCase("en-US") === foldedIdentity) {
          identityPaths.push(relative);
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  return { ownerPaths: ownerPaths.sort(compare), identityPaths: identityPaths.sort(compare) };
}

function assertArtifactCreateAvailable(
  model: PlanGraphControlModel,
  kind: "decision" | "blueprint",
  path: string,
  id: string,
): void {
  const inventory = actualArtifactInventory(model, path, kind, id);
  if (inventory.identityPaths.length && !inventory.ownerPaths.length) {
    throw new Error(`${kind} identity already exists or case-collides: ${inventory.identityPaths[0]}`);
  }
  const pathCollision = inventory.ownerPaths[0]
    ?? [...model.sources.keys()].find((candidate) => candidate.toLocaleLowerCase("en-US") === path.toLocaleLowerCase("en-US"));
  if (pathCollision) throw new Error(`artifact owner path already exists or case-collides: ${pathCollision}`);
}

function assertArtifactUpdateOwner(model: PlanGraphControlModel, record: PlanGraphArtifactRecord): void {
  const inventory = actualArtifactInventory(model, record.path, record.kind, record.id);
  if (!inventory.ownerPaths.includes(record.path)) {
    throw new Error(`artifact canonical owner path is missing: ${record.path}`);
  }
  const pathCollision = inventory.ownerPaths.find((path) => path !== record.path);
  if (pathCollision) throw new Error(`artifact owner path has a hidden case-folded duplicate: ${pathCollision}`);
  const identityCollision = inventory.identityPaths.find((path) => path !== record.path);
  if (identityCollision) {
    throw new Error(`${record.kind} identity has a hidden duplicate owner: ${identityCollision}`);
  }
}

function normalizedDecisionSupersedes(model: PlanGraphControlModel, values: readonly string[] | undefined): string[] {
  const normalized = [...new Set(values ?? [])].sort(compare);
  for (const reference of normalized) {
    if (!/^decision:DEC-\d{3,}$/.test(reference) || !model.decisions.has(reference.slice("decision:".length))) {
      throw new Error(`supersedes requires an existing decision:DEC-NNN reference: ${reference}`);
    }
  }
  return normalized;
}

function normalizedCanonicalIds(
  model: PlanGraphControlModel,
  kind: "backlog" | "decision",
  values: readonly string[] | undefined,
): string[] {
  const normalized = [...new Set(values ?? [])].sort(compare);
  for (const id of normalized) {
    const valid = kind === "backlog"
      ? /^W-\d{3,}$/.test(id) && model.backlog.has(id)
      : /^DEC-\d{3,}$/.test(id) && model.decisions.has(id);
    if (!valid) throw new Error(`${kind}_ids requires an existing canonical ${kind} id: ${id}`);
  }
  return normalized;
}

function normalizedAcceptanceIds(values: readonly string[] | undefined): string[] {
  const ids = values ?? [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error(`acceptance_ids contains an invalid stable label: ${id}`);
    if (seen.has(id)) throw new Error(`acceptance_ids contains a duplicate label: ${id}`);
    seen.add(id);
  }
  return [...ids];
}

function canonicalArtifactBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "") + "\n";
}

function artifactUpdatedAfter(record: PlanGraphArtifactRecord, now: string): string {
  const previous = Date.parse(record.updated);
  const transaction = Date.parse(now);
  if (!Number.isFinite(previous) || !Number.isFinite(transaction)) throw new Error(`invalid artifact update timestamp: ${record.updated}`);
  return new Date(Math.max(transaction, previous + 1)).toISOString();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function planArtifactCreate(options: {
  model: PlanGraphControlModel;
  kind: "decision" | "blueprint";
  id: string;
  metadata: PlanGraphArtifactMetadataInput;
  body: string;
  now: string;
}): LifecycleV3FilePlan {
  const title = options.metadata.title.trim();
  if (!title) throw new Error("artifact title must be a non-empty string");
  let id: string;
  if (options.kind === "decision") {
    if (!/^DEC-\d{3,}$/.test(options.id)) throw new Error(`invalid Decision id: ${options.id}`);
    id = options.id;
  } else {
    id = artifactSlug(options.id, "Blueprint slug");
  }
  const identities = options.kind === "decision" ? options.model.decisions.keys() : options.model.blueprints.keys();
  const collision = [...identities]
    .find((candidate) => candidate.toLocaleLowerCase("en-US") === id.toLocaleLowerCase("en-US"));
  if (collision) throw new Error(`${options.kind} identity already exists or case-collides: ${collision}`);
  const path = options.kind === "decision"
    ? `decisions/${id}-${safeSlug(title)}.md`
    : `blueprints/${id}.md`;
  assertArtifactCreateAvailable(options.model, options.kind, path, id);
  const related = normalizedArtifactRelated(options.model, options.metadata.related);
  const data: Record<string, unknown> = {
    schema_version: 3,
    kind: options.kind === "decision" ? "garelier_decision" : "garelier_blueprint",
    [options.kind === "decision" ? "id" : "slug"]: id,
    title,
    status: options.kind === "decision" ? "proposed" : "draft",
    created: options.now,
    updated: options.now,
    related,
  };
  if (options.kind === "decision") {
    data.supersedes = normalizedDecisionSupersedes(options.model, options.metadata.supersedes);
  } else {
    data.backlog_ids = normalizedCanonicalIds(options.model, "backlog", options.metadata.backlogIds);
    data.decision_ids = normalizedCanonicalIds(options.model, "decision", options.metadata.decisionIds);
    data.acceptance_ids = normalizedAcceptanceIds(options.metadata.acceptanceIds);
  }
  return {
    entity: `${options.kind}:${id}`,
    summary: `create ${options.kind} ${id}`,
    writes: [{ path, source: renderedDocument(data, canonicalArtifactBody(options.body)) }],
  };
}

export function planArtifactUpdate(options: {
  model: PlanGraphControlModel;
  record: PlanGraphArtifactRecord;
  metadata?: PlanGraphArtifactMetadataPatch;
  body?: string;
  now: string;
}): LifecycleV3FilePlan {
  assertArtifactUpdateOwner(options.model, options.record);
  const patch = options.metadata ?? {};
  const title = patch.title === undefined ? options.record.title : patch.title.trim();
  if (patch.title !== undefined && !title) throw new Error("artifact title must be a non-empty string");
  const related = patch.related === undefined ? options.record.related : normalizedArtifactRelated(options.model, patch.related);
  const supersedes = options.record.kind === "decision"
    ? patch.supersedes === undefined ? options.record.supersedes : normalizedDecisionSupersedes(options.model, patch.supersedes)
    : [];
  const backlogIds = options.record.kind === "blueprint"
    ? patch.backlogIds === undefined ? options.record.backlogIds : normalizedCanonicalIds(options.model, "backlog", patch.backlogIds)
    : [];
  const decisionIds = options.record.kind === "blueprint"
    ? patch.decisionIds === undefined ? options.record.decisionIds : normalizedCanonicalIds(options.model, "decision", patch.decisionIds)
    : [];
  const acceptanceIds = options.record.kind === "blueprint"
    ? patch.acceptanceIds === undefined ? options.record.acceptanceIds : normalizedAcceptanceIds(patch.acceptanceIds)
    : [];
  const body = options.body === undefined ? canonicalArtifactBody(options.record.body) : canonicalArtifactBody(options.body);
  const unchanged = (patch.title === undefined || title === options.record.title)
    && sameStrings(related, options.record.related)
    && sameStrings(supersedes, options.record.supersedes)
    && sameStrings(backlogIds, options.record.backlogIds)
    && sameStrings(decisionIds, options.record.decisionIds)
    && sameStrings(acceptanceIds, options.record.acceptanceIds)
    && (options.body === undefined || body === canonicalArtifactBody(options.record.body));
  if (unchanged) return { entity: `${options.record.kind}:${options.record.id}`, summary: `no-op ${options.record.kind} ${options.record.id}`, writes: [] };
  const updated = mutateDocument(options.record, (data) => {
    if (patch.title !== undefined) data.title = title;
    if (patch.related !== undefined) data.related = related;
    if (options.record.kind === "decision" && patch.supersedes !== undefined) data.supersedes = supersedes;
    if (options.record.kind === "blueprint") {
      if (patch.backlogIds !== undefined) data.backlog_ids = backlogIds;
      if (patch.decisionIds !== undefined) data.decision_ids = decisionIds;
      if (patch.acceptanceIds !== undefined) data.acceptance_ids = acceptanceIds;
    }
    data.updated = artifactUpdatedAfter(options.record, options.now);
  }, options.body === undefined ? undefined : () => body);
  return {
    entity: `${options.record.kind}:${options.record.id}`,
    summary: `update ${options.record.kind} ${options.record.id}`,
    writes: [{ path: options.record.path, source: updated.source }],
  };
}

export function planRoadmapCreate(options: {
  model: PlanGraphControlModel;
  slug: string;
  title: string;
  now: string;
}): LifecycleV3FilePlan {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.slug)) throw new Error(`invalid Roadmap slug: ${options.slug}`);
  if (options.model.roadmaps.has(options.slug)) throw new Error(`Roadmap already exists: ${options.slug}`);
  const data: Record<string, unknown> = {
    schema_version: 3,
    kind: "garelier_roadmap",
    slug: options.slug,
    status: "planned",
    created: options.now,
    updated: options.now,
    milestone_links: [],
  };
  return {
    entity: options.slug,
    summary: `create Roadmap ${options.slug}`,
    writes: [{ path: `roadmaps/${options.slug}.md`, source: renderedDocument(data, `# ${options.title}\n\n## Direction\n\n## Success criteria\n\n## Notes\n`) }],
  };
}

export function planMilestoneCreate(options: {
  model: PlanGraphControlModel;
  slug: string;
  title: string;
  now: string;
}): LifecycleV3FilePlan {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.slug)) throw new Error(`invalid Milestone slug: ${options.slug}`);
  if (options.model.milestones.has(options.slug)) throw new Error(`Milestone already exists: ${options.slug}`);
  const data: Record<string, unknown> = {
    schema_version: 3,
    kind: "garelier_milestone",
    slug: options.slug,
    status: "planned",
    created: options.now,
    updated: options.now,
    depends_on: [],
    child_links: [],
  };
  return {
    entity: options.slug,
    summary: `create Milestone ${options.slug}`,
    writes: [{ path: `milestones/${options.slug}.md`, source: renderedDocument(data, `# ${options.title}\n\n## Outcome\n\n## Exit criteria\n\n## Notes\n`) }],
  };
}

export function planMilestoneDependencyUpdate(options: {
  record: MilestoneRecord;
  dependsOn: string[];
  legacyDependencyTargets?: string[];
  now: string;
}): LifecycleV3FilePlan {
  const dependsOn = [...new Set(options.dependsOn)];
  const legacyDependencyTargets = [...new Set(options.legacyDependencyTargets ?? [])].sort(compare);
  for (const dependency of dependsOn) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(dependency)) {
      throw new Error(`invalid Milestone dependency slug: ${dependency}`);
    }
  }
  const updated = mutateDocument(options.record, (data) => {
    data.depends_on = dependsOn.sort(compare);
    if (legacyDependencyTargets.length) data.dependency_targets = legacyDependencyTargets;
    else delete data.dependency_targets;
    data.updated = options.now;
  });
  return {
    entity: options.record.slug,
    summary: `update Milestone ${options.record.slug} dependencies`,
    writes: [{ path: options.record.path, source: updated.source }],
  };
}

export function planNoteCreate(options: {
  model: PlanGraphControlModel;
  id?: string;
  title: string;
  related?: string[];
  now: string;
}): LifecycleV3FilePlan {
  const id = options.id ?? allocateNoteId(options.model);
  if (!/^N-\d{3,}$/.test(id)) throw new Error(`invalid Note ID: ${id}`);
  if (options.model.notes.some((note) => note.id === id)) throw new Error(`Note already exists: ${id}`);
  const data: Record<string, unknown> = {
    schema_version: 3,
    kind: "garelier_note",
    id,
    status: "active",
    created: options.now,
    updated: options.now,
    related: [...new Set(options.related ?? [])].sort(compare),
    promoted_to: [],
  };
  return {
    entity: id,
    summary: `create Note ${id}`,
    writes: [{ path: `notes/${id}-${safeSlug(options.title)}.md`, source: renderedDocument(data, `# ${id}: ${options.title}\n\n## Memory\n\n`) }],
  };
}

export function planNoteLink(options: {
  note: NoteRecord;
  target: string;
  now: string;
}): LifecycleV3FilePlan {
  if (!/^(?:roadmap|milestone|backlog|backlog-view|checkpoint|risk|note|decision|blueprint):[^:\s]+$/.test(options.target)) {
    throw new Error(`invalid typed Note target: ${options.target}`);
  }
  if (options.note.related.includes(options.target)) throw new Error(`active Note relation already exists: ${options.target}`);
  const updated = mutateDocument(options.note, (data) => {
    data.related = [...new Set([...options.note.related, options.target])].sort(compare);
    data.updated = options.now;
  });
  return { entity: options.note.id, summary: `link note:${options.note.id} to ${options.target}`, writes: [{ path: options.note.path, source: updated.source }] };
}

export function planBacklogCreate(options: {
  model: PlanGraphControlModel;
  id?: string;
  title: string;
  type: string;
  priority: string;
  outcome: string;
  acceptance: string[];
  exactNextAction: string;
  labels: string[];
  dependsOn?: string[];
  related?: string[];
  inheritMilestones?: boolean;
  milestone?: "none" | null;
  now: string;
}): LifecycleV3FilePlan {
  const id = options.id ?? allocateBacklogId(options.model);
  if (!/^W-\d{3,}$/.test(id)) throw new Error(`invalid Backlog ID: ${id}`);
  if (options.model.backlog.has(id)) throw new Error(`Backlog already exists: ${id}`);
  const dependsOn = [...new Set((options.dependsOn ?? []).map(canonicalBacklogReference))].sort(compare);
  const related = [...new Set((options.related ?? []).map(canonicalBacklogReference))].sort(compare);
  const inheritMilestones = options.inheritMilestones ?? true;
  const milestone = options.milestone ?? null;
  const inheritedMilestones = inheritMilestones && milestone !== "none"
    ? milestoneTargetsFromTypedEdges(options.model, [...dependsOn, ...related])
    : [];
  const data: Record<string, unknown> = {
    schema_version: 3,
    kind: "garelier_backlog",
    id,
    type: options.type,
    priority: options.priority,
    status: "triage",
    owner: "-",
    created: options.now,
    updated: options.now,
    labels: [...new Set(options.labels)].sort(compare),
    depends_on: dependsOn,
    blocked_by: [],
    related,
    milestone_memberships: inheritedMilestones.map((slug, index) => ({
      id: `rel-${String(index + 1).padStart(3, "0")}`,
      slug,
      state: "active",
      added: options.now,
      updated: options.now,
      relation: "inherited",
    })),
  };
  if (!inheritMilestones) data.inherit_milestones = false;
  if (milestone === "none") data.milestone = "none";
  const body = `# ${id}: ${options.title}\n\n## Outcome\n\n${options.outcome}\n\n## Acceptance criteria\n\n${options.acceptance.map((item) => `- [ ] ${item}`).join("\n") || "- [ ] Define acceptance."}\n\n## Current position\n\nCreated; awaiting triage.\n\n## Exact next action\n\n${options.exactNextAction}\n\n## Evidence\n\n- None recorded.\n\n## Notes\n\n## Revision history\n`;
  const path = `backlog/open/${id}-${safeSlug(options.title)}.md`;
  return { entity: id, summary: `create Backlog ${id}`, writes: [{ path, source: renderedDocument(data, body) }] };
}

// W-223: batch backlog creation. Every row's id must already be resolved
// (auto ids reserved up front via plan_graph_shared_ids.ts's reserveBacklogIds,
// explicit ids passed through) — this function stays pure (no id allocation
// side effects) and just folds N planBacklogCreate write-plans into ONE
// LifecycleV3FilePlan, so the caller commits all N rows through a single
// runControlFilePlanTransaction call: one journal, one atomic replace, all-or-
// nothing under a SIGKILL (the transaction's existing crash-recovery covers a
// multi-write plan exactly the same as a single-write one — nothing new is
// required there, W-222's recovery journal replays whatever `writes` held).
export function planBacklogBatchCreate(options: {
  model: PlanGraphControlModel;
  rows: Array<{
    id: string;
    title: string;
    type?: string;
    priority?: string;
    outcome?: string;
    acceptance?: string[];
    exactNextAction?: string;
    labels?: string[];
    dependsOn?: string[];
    related?: string[];
    inheritMilestones?: boolean;
    milestone?: "none" | null;
  }>;
  now: string;
}): LifecycleV3FilePlan {
  if (!options.rows.length) throw new Error("batch requires at least one row");
  const seen = new Set<string>();
  const writes: LifecycleV3FilePlan["writes"] = [];
  const ids: string[] = [];
  for (const row of options.rows) {
    if (seen.has(row.id)) throw new Error(`duplicate Backlog ID within batch: ${row.id}`);
    seen.add(row.id);
    const created = planBacklogCreate({
      model: options.model,
      id: row.id,
      title: row.title,
      type: row.type ?? "task",
      priority: row.priority ?? "normal",
      outcome: row.outcome ?? row.title,
      acceptance: row.acceptance?.length ? row.acceptance : ["Define acceptance."],
      exactNextAction: row.exactNextAction ?? "Triage this Backlog.",
      labels: row.labels ?? [],
      dependsOn: row.dependsOn,
      related: row.related,
      inheritMilestones: row.inheritMilestones,
      milestone: row.milestone,
      now: options.now,
    });
    writes.push(...created.writes);
    ids.push(row.id);
  }
  return { writes, summary: `create ${ids.length} Backlog row(s) in one batch: ${ids.join(", ")}` };
}

export function planBacklogUpdate(options: {
  record: BacklogRecord;
  now: string;
  title?: string;
  outcome?: string;
  currentPosition?: string;
  exactNextAction?: string;
  evidence?: string;
  evidenceRefs?: EvidenceReference[];
  reportRefs?: string[];
  labels?: string[];
  dependsOn?: string[];
  blockedBy?: string[];
  related?: string[];
  acceptance?: string[];
  checkedAcceptance?: string[];
}): LifecycleV3FilePlan {
  let updated = mutateDocument(options.record, (data) => {
    data.updated = options.now;
    if (options.labels) data.labels = [...new Set(options.labels)].sort(compare);
    if (options.dependsOn) data.depends_on = [...new Set(options.dependsOn)].sort(compare);
    if (options.blockedBy) data.blocked_by = [...new Set(options.blockedBy)].sort(compare);
    if (options.related) data.related = [...new Set(options.related)].sort(compare);
    if (options.evidenceRefs) {
      data.evidence_refs = options.evidenceRefs.map(({ writer, ...reference }) => ({
        ...reference,
        [EVIDENCE_WRITER_STORAGE_KEY]: writer,
      }));
    }
    if (options.reportRefs) data.report_refs = [...new Set(options.reportRefs)].sort(compare);
  }, (body) => {
    let next = body;
    if (options.title) next = next.replace(/^#\s+.*$/m, `# ${options.record.id}: ${options.title}`);
    if (options.outcome !== undefined) next = replaceMarkdownSection(next, "## Outcome", options.outcome);
    if (options.currentPosition !== undefined) next = replaceMarkdownSection(next, "## Current position", options.currentPosition);
    if (options.exactNextAction !== undefined) next = replaceMarkdownSection(next, "## Exact next action", options.exactNextAction);
    if (options.evidence !== undefined) next = replaceMarkdownSection(next, "## Evidence", options.evidence);
    next = updateBacklogAcceptance(next, options.acceptance, options.checkedAcceptance);
    return next;
  });
  updated = { ...updated, updated: options.now };
  return { entity: options.record.id, summary: `update Backlog ${options.record.id}`, writes: [{ path: options.record.path, source: updated.source }] };
}

export function planRiskCreate(options: {
  model: PlanGraphControlModel;
  id?: string;
  title: string;
  severity: RiskLevel;
  likelihood: RiskLevel;
  risk: string;
  trigger: string;
  impact: string;
  mitigation: string;
  owner?: string;
  review?: string;
  related: string[];
  mitigationBacklog: string[];
  evidence?: string;
  now: string;
}): LifecycleV3FilePlan {
  const id = options.id ?? allocateRiskId(options.model);
  if (!/^R-\d{3,}$/.test(id)) throw new Error(`invalid Risk ID: ${id}`);
  if (options.model.risks.has(id)) throw new Error(`Risk already exists: ${id}`);
  const data: Record<string, unknown> = {
    schema_version: 3,
    kind: "garelier_risk",
    id,
    status: "open",
    severity: options.severity,
    likelihood: options.likelihood,
    created: options.now,
    updated: options.now,
    related: [...new Set(options.related)].sort(compare),
    mitigation_backlog: [...new Set(options.mitigationBacklog)].sort(compare),
  };
  const body = `# ${id}: ${options.title}\n\n## Risk\n\n${options.risk}\n\n## Trigger\n\n${options.trigger}\n\n## Impact\n\n${options.impact}\n\n## Mitigation\n\n${options.mitigation}\n\n## Owner\n\n${options.owner ?? "-"}\n\n## Review\n\n${options.review ?? "-"}\n\n## Evidence\n\n${options.evidence ?? "- None recorded."}\n`;
  const path = `risks/open/${id}-${safeSlug(options.title)}.md`;
  return { entity: id, summary: `create Risk ${id}`, writes: [{ path, source: renderedDocument(data, body) }] };
}

export function planRiskUpdate(options: {
  record: RiskRecord;
  now: string;
  title?: string;
  severity?: RiskLevel;
  likelihood?: RiskLevel;
  risk?: string;
  trigger?: string;
  impact?: string;
  mitigation?: string;
  owner?: string;
  review?: string;
  acceptedRationale?: string;
  related?: string[];
  mitigationBacklog?: string[];
  evidence?: string;
}): LifecycleV3FilePlan {
  const updated = mutateDocument(options.record, (data) => {
    data.updated = options.now;
    if (options.severity !== undefined) data.severity = options.severity;
    if (options.likelihood !== undefined) data.likelihood = options.likelihood;
    if (options.related !== undefined) data.related = [...new Set(options.related)].sort(compare);
    if (options.mitigationBacklog !== undefined) data.mitigation_backlog = [...new Set(options.mitigationBacklog)].sort(compare);
  }, (body) => {
    let next = body;
    if (options.title !== undefined) next = next.replace(/^#\s+.*$/m, `# ${options.record.id}: ${options.title}`);
    if (options.risk !== undefined) next = replaceMarkdownSection(next, "## Risk", options.risk);
    if (options.trigger !== undefined) next = replaceMarkdownSection(next, "## Trigger", options.trigger);
    if (options.impact !== undefined) next = replaceMarkdownSection(next, "## Impact", options.impact);
    if (options.mitigation !== undefined) next = replaceMarkdownSection(next, "## Mitigation", options.mitigation);
    if (options.owner !== undefined) next = replaceMarkdownSection(next, "## Owner", options.owner);
    if (options.review !== undefined) next = replaceMarkdownSection(next, "## Review", options.review);
    if (options.acceptedRationale !== undefined) next = replaceMarkdownSection(next, "## Accepted rationale", options.acceptedRationale);
    if (options.evidence !== undefined) next = replaceMarkdownSection(next, "## Evidence", options.evidence);
    return next;
  });
  return { entity: options.record.id, summary: `update Risk ${options.record.id}`, writes: [{ path: options.record.path, source: updated.source }] };
}

export function planGraphEvidenceReferences(record: BacklogRecord): EvidenceReference[] {
  const value = parseControlFrontmatter(record.source, record.path).data.evidence_refs;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Backlog ${record.id} evidence_refs must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Backlog ${record.id} evidence_refs[${index}] must be a table`);
    }
    const candidate = item as Record<string, unknown>;
    const writer = candidate[EVIDENCE_WRITER_STORAGE_KEY];
    if (typeof candidate.kind !== "string" || typeof candidate.observed_at !== "string"
      || typeof writer !== "string" || typeof candidate.summary !== "string") {
      throw new Error(`Backlog ${record.id} evidence_refs[${index}] is incomplete`);
    }
    const { [EVIDENCE_WRITER_STORAGE_KEY]: _storedWriter, ...reference } = candidate;
    return { ...reference, writer } as unknown as EvidenceReference;
  });
}

export function planRelationLink(options: {
  owner: RelationOwnerRecord;
  target: string;
  relation?: string;
  track?: string;
  order?: number;
  required?: boolean;
  now: string;
}): LifecycleV3FilePlan {
  const [targetKind, targetId] = options.target.split(":", 2);
  if (!targetId) throw new Error(`invalid typed relation target: ${options.target}`);
  const table = options.owner.kind === "roadmap" && targetKind === "milestone" ? "milestone_links"
    : options.owner.kind === "milestone" && targetKind === "milestone" ? "child_links"
      : options.owner.kind === "backlog" && targetKind === "milestone" ? "milestone_memberships"
        : options.owner.kind === "backlog" && targetKind === "backlog-view" ? "view_memberships"
          : null;
  if (!table) throw new Error(`unsupported relation endpoints: ${options.owner.kind} -> ${targetKind}`);
  const rows = relationTables(options.owner);
  const maximum = rows.reduce((value, row) => Math.max(value, Number(/^rel-(\d+)$/.exec(String(row.id ?? ""))?.[1] ?? 0)), 0);
  const relationId = `rel-${String(maximum + 1).padStart(3, "0")}`;
  const updated = mutateDocument(options.owner, (data) => {
    const entries = Array.isArray(data[table]) ? [...data[table] as Array<Record<string, unknown>>] : [];
    const targetField = "slug";
    if (entries.some((row) => row.state === "active" && row[targetField] === targetId)) throw new Error(`active relation already exists: ${options.target}`);
    const row: Record<string, unknown> = {
      id: relationId,
      [targetField]: targetId,
      state: "active",
      added: options.now,
      updated: options.now,
    };
    if (table === "milestone_links") {
      row.track = options.track ?? "-";
      row.order = options.order ?? entries.length;
      row.relation = options.relation ?? "root";
      row.required = options.required ?? true;
    } else if (table === "child_links") {
      row.order = options.order ?? entries.length;
      row.relation = options.relation ?? "contains";
      row.required = options.required ?? true;
    } else if (table === "milestone_memberships") {
      row.relation = options.relation ?? "contributes";
      // A direct membership makes the intentional-unbound marker inapplicable.
      // Keep the relation link and marker update in one transaction so strict
      // validation never observes an invalid intermediate control tree.
      delete data.milestone;
    }
    else row.order = options.order ?? entries.length;
    data[table] = [...entries, row];
    data.updated = options.now;
  });
  return { summary: `link ${relationId} to ${options.target}`, writes: [{ path: options.owner.path, source: updated.source }] };
}

export function planCheckpointSave(options: {
  model: PlanGraphControlModel;
  id?: string;
  title?: string;
  exactNextAction: string;
  lastCompleted?: string;
  blockers?: string;
  resumeVerification: string;
  readFirst?: string[];
  roadmaps?: string[];
  milestones?: string[];
  backlog?: string[];
  related?: string[];
  branch?: string;
  head?: string;
  workingTree?: string;
  gitStatusHash?: string;
  stagedPaths?: string[];
  modifiedPaths?: string[];
  untrackedPaths?: string[];
  gitCapture?: string;
  agent: string;
  now: string;
  activate?: boolean;
}): LifecycleV3FilePlan {
  const id = options.id ?? allocateCheckpointId(options.model);
  if (!/^CP-\d{3,}$/.test(id)) throw new Error(`invalid Checkpoint ID: ${id}`);
  const existing = options.model.checkpoints.get(id);
  if (existing?.path.startsWith("checkpoints/archive/")) throw new Error(`archived Checkpoint cannot be saved: ${id}`);
  let path: string;
  let source: string;
  if (existing) {
    path = existing.path;
    const updated = mutateDocument(existing, (data) => {
      data.updated = options.now;
      for (const [key, value] of Object.entries({
        roadmaps: options.roadmaps,
        milestones: options.milestones,
        backlog: options.backlog,
        related: options.related,
        branch: options.branch,
        head: options.head,
        working_tree: options.workingTree,
        git_status_hash: options.gitStatusHash,
        staged_paths: options.stagedPaths,
        modified_paths: options.modifiedPaths,
        untracked_paths: options.untrackedPaths,
      })) if (value !== undefined) data[key] = value;
    }, (body) => {
      let next = body;
      if (options.title) next = next.replace(/^#\s+.*$/m, `# ${id}: ${options.title}`);
      next = replaceMarkdownSection(next, "### Exact next action", options.exactNextAction);
      if (options.lastCompleted !== undefined) next = replaceMarkdownSection(next, "### Last completed", options.lastCompleted);
      if (options.blockers !== undefined) next = replaceMarkdownSection(next, "## Blockers / external decisions", options.blockers);
      next = replaceMarkdownSection(next, "## Resume verification", options.resumeVerification);
      if (options.readFirst) next = replaceMarkdownSection(next, "## Read first on resume", options.readFirst.map((item) => `- \`${item}\``).join("\n"));
      if (options.gitCapture) next = replaceMarkdownSection(next, "## Partial repository state", options.gitCapture);
      return next;
    });
    source = updated.source;
  } else {
    const title = options.title ?? id;
    path = `checkpoints/active/${id}-${safeSlug(title)}.md`;
    const data: Record<string, unknown> = {
      schema_version: 3,
      kind: "garelier_checkpoint",
      id,
      status: options.activate ? "active" : "paused",
      created: options.now,
      updated: options.now,
      agent: options.agent,
      roadmaps: options.roadmaps ?? [],
      milestones: options.milestones ?? [],
      backlog: options.backlog ?? [],
      related: options.related ?? [],
      branch: options.branch ?? "-",
      head: options.head ?? "-",
      working_tree: options.workingTree ?? "unknown",
      git_status_hash: options.gitStatusHash ?? "-",
      staged_paths: options.stagedPaths ?? [],
      modified_paths: options.modifiedPaths ?? [],
      untracked_paths: options.untrackedPaths ?? [],
    };
    const body = `# ${id}: ${title}\n\n## Goal\n\n## Current position\n\n### Last completed\n\n${options.lastCompleted ?? "-"}\n\n### In progress\n\n-\n\n### Exact next action\n\n${options.exactNextAction}\n\n## Partial repository state\n\n${options.gitCapture ?? "-"}\n\n## Commands and results\n\n## Decisions and assumptions made during this checkpoint\n\n## Blockers / external decisions\n\n${options.blockers ?? "-"}\n\n## Read first on resume\n\n${(options.readFirst ?? []).map((item) => `- \`${item}\``).join("\n") || "-"}\n\n## Known-good baseline\n\n## Do not repeat\n\n## Resume verification\n\n${options.resumeVerification}\n\n## Handoff note\n`;
    source = renderedDocument(data, body);
  }
  const writes: LifecycleV3FilePlan["writes"] = [{ path, source }];
  const current = options.model.current;
  if (options.activate && current && !currentCheckpointIds(current).includes(id)) {
    writes.push({ path: current.path, source: planGraphCurrentAdapter.render(planGraphCurrentAdapter.addCheckpoint(current, id)) });
  }
  return { entity: id, summary: `save Checkpoint ${id}`, writes };
}

export function patchCheckpointGitMetadata(options: {
  checkpoint: CheckpointRecord;
  branch: string;
  head: string;
  workingTree: string;
  gitStatusHash: string;
  stagedPaths: string[];
  modifiedPaths: string[];
  untrackedPaths: string[];
  now: string;
}): CheckpointRecord {
  return mutateDocument(options.checkpoint, (data) => {
    data.updated = options.now;
    data.branch = options.branch;
    data.head = options.head;
    data.working_tree = options.workingTree;
    data.git_status_hash = options.gitStatusHash;
    data.staged_paths = [...options.stagedPaths];
    data.modified_paths = [...options.modifiedPaths];
    data.untracked_paths = [...options.untrackedPaths];
  });
}
