import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertSafeFilesystemPath } from "./roots.ts";
import { assertLifecycleV3ControlPath } from "./lifecycle_v3.ts";
import { buildPlanGraph } from "./plan_graph_relations.ts";
import {
  parseArtifactRecord,
  parseBacklogRecord,
  parseBacklogViewRecord,
  parseCheckpointRecord,
  parseCurrentRecord,
  parseMilestoneRecord,
  parseNotebook,
  parseNoteRecord,
  parsePlanGraphControlConfig,
  parseRoadmapRecord,
  parseRiskRecord,
  PlanGraphSchemaError,
} from "./plan_graph_schema.ts";
import type {
  BacklogRecord,
  BacklogViewRecord,
  CheckpointRecord,
  MilestoneRecord,
  NoteRecord,
  PlanGraphArtifactRecord,
  PlanGraphControlConfig,
  PlanGraphControlModel,
  PlanGraphFinding,
  PlanGraphStoreLimits,
  RoadmapRecord,
  RiskRecord,
} from "./plan_graph_types.ts";
import { DEFAULT_PLAN_GRAPH_LIMITS as LIMITS } from "./plan_graph_types.ts";
import { validatePlanGraphModel } from "./plan_graph_validate.ts";

export interface LoadPlanGraphOptions {
  limits?: Partial<PlanGraphStoreLimits>;
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const forward = (path: string): string => path.replaceAll("\\", "/");

const REQUIRED_DASHBOARD_FILES = [
  "README.md",
  "current.md",
  "roadmap.md",
  "backlog.md",
  "decisions.md",
  "risks.md",
  "quality_gates.md",
  "notes.md",
] as const;

const DASHBOARD_GENERATED_MARKERS: Readonly<Record<string, readonly [string, string] | undefined>> = {
  "roadmap.md": ["<!-- garelier-generated:roadmap-index:start -->", "<!-- garelier-generated:roadmap-index:end -->"],
  "backlog.md": ["<!-- garelier-generated:backlog-index:start -->", "<!-- garelier-generated:backlog-index:end -->"],
  "decisions.md": ["<!-- garelier-generated:decision-index:start -->", "<!-- garelier-generated:decision-index:end -->"],
  "risks.md": ["<!-- garelier-generated:risk-index:start -->", "<!-- garelier-generated:risk-index:end -->"],
  "quality_gates.md": ["<!-- garelier-generated:quality-gates:start -->", "<!-- garelier-generated:quality-gates:end -->"],
};

function finding(
  code: string,
  path: string | null,
  message: string,
  field: string | null = null,
  severity: PlanGraphFinding["severity"] = "error",
  entity: string | null = null,
): PlanGraphFinding {
  return { severity, code, path, entity, field, message };
}

type Parser<T> = (source: string, path: string) => T;

export function loadPlanGraphModel(controlRootInput: string, options: LoadPlanGraphOptions = {}): PlanGraphControlModel {
  const controlRoot = resolve(controlRootInput);
  const limits: PlanGraphStoreLimits = { ...LIMITS, ...options.limits };
  const findings: PlanGraphFinding[] = [];
  const sources = new Map<string, string>();
  let totalBytes = 0;
  let entityCount = 0;
  let safeRoot = true;

  try {
    assertSafeFilesystemPath(controlRoot, "schema-3 control root");
  } catch (error) {
    safeRoot = false;
    findings.push(finding("store-control-root-unsafe", null, (error as Error).message));
  }

  const read = (relativePath: string, required = false): string | null => {
    if (!safeRoot) return null;
    const relative = forward(relativePath);
    const absolute = join(controlRoot, relative);
    if (!existsSync(absolute)) {
      if (required) findings.push(finding("store-file-missing", relative, "required canonical file is missing"));
      return null;
    }
    let info;
    try {
      info = lstatSync(absolute);
    } catch (error) {
      findings.push(finding("store-file-read", relative, (error as Error).message));
      return null;
    }
    if (info.isSymbolicLink()) {
      findings.push(finding("store-symlink-forbidden", relative, "canonical files cannot be symlinks or junctions"));
      return null;
    }
    if (!info.isFile()) {
      findings.push(finding("store-file-type", relative, "canonical path must be a regular file"));
      return null;
    }
    if (info.size > limits.maxFileBytes) {
      findings.push(finding("store-file-too-large", relative, `file is ${info.size} bytes; cap is ${limits.maxFileBytes}`));
      return null;
    }
    totalBytes += info.size;
    if (totalBytes > limits.maxTotalBytes) {
      findings.push(finding("store-total-too-large", relative, `canonical bytes exceed ${limits.maxTotalBytes}`));
      return null;
    }
    try {
      const source = readFileSync(absolute, "utf8");
      sources.set(relative, source);
      return source;
    } catch (error) {
      findings.push(finding("store-file-read", relative, (error as Error).message));
      return null;
    }
  };

  const parse = <T>(relativePath: string, parser: Parser<T>, required = false): T | null => {
    const source = read(relativePath, required);
    if (source === null) return null;
    try {
      entityCount++;
      if (entityCount > limits.maxEntities) {
        findings.push(finding("store-entity-cap", relativePath, `entity count exceeds ${limits.maxEntities}`));
        return null;
      }
      return parser(source, forward(relativePath));
    } catch (error) {
      const schema = error instanceof PlanGraphSchemaError
        ? error
        : new PlanGraphSchemaError((error as Error).message, forward(relativePath));
      findings.push(finding("store-parse-error", forward(relativePath), schema.message, schema.field));
      return null;
    }
  };

  const flatPaths = (relativeDirectory: string): string[] => {
    if (!safeRoot) return [];
    const absolute = join(controlRoot, relativeDirectory);
    if (!existsSync(absolute)) return [];
    const rootInfo = lstatSync(absolute);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      findings.push(finding(rootInfo.isSymbolicLink() ? "store-symlink-forbidden" : "store-directory-type", relativeDirectory, "canonical directory must be a real directory"));
      return [];
    }
    const paths: string[] = [];
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name))) {
      const relative = forward(`${relativeDirectory}/${entry.name}`);
      if (entry.isSymbolicLink()) {
        findings.push(finding("store-symlink-forbidden", relative, "canonical entities cannot be symlinks"));
      } else if (entry.isDirectory()) {
        findings.push(finding("store-depth-exceeded", relative, "unexpected nested canonical directory"));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        paths.push(relative);
      }
    }
    return paths;
  };

  const archivePaths = (relativeDirectory: string): string[] => {
    if (!safeRoot) return [];
    if (limits.maxArchiveDepth < 2) {
      findings.push(finding("store-depth-exceeded", relativeDirectory, `archive records require depth 2; cap is ${limits.maxArchiveDepth}`));
      return [];
    }
    const absolute = join(controlRoot, relativeDirectory);
    if (!existsSync(absolute)) return [];
    const rootInfo = lstatSync(absolute);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      findings.push(finding("store-directory-type", relativeDirectory, "archive root must be a real directory"));
      return [];
    }
    const paths: string[] = [];
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name))) {
      const relative = forward(`${relativeDirectory}/${entry.name}`);
      if (entry.isSymbolicLink()) {
        findings.push(finding("store-symlink-forbidden", relative, "archive directories cannot be symlinks"));
      } else if (!entry.isDirectory() || !/^\d{4}$/.test(entry.name)) {
        if (!(entry.isFile() && entry.name === ".gitkeep")) findings.push(finding("store-archive-layout", relative, "archive records require one YYYY directory"));
      } else {
        paths.push(...flatPaths(relative));
      }
    }
    return paths;
  };

  let config: PlanGraphControlConfig | null = null;
  let current: ReturnType<typeof parseCurrentRecord> | null = null;
  let notebook: ReturnType<typeof parseNotebook> | null = null;
  const configSource = read("control.toml", true);
  if (configSource !== null) {
    try {
      config = parsePlanGraphControlConfig(configSource);
    } catch (error) {
      const schema = error as PlanGraphSchemaError;
      findings.push(finding("store-config-invalid", "control.toml", schema.message, schema.field));
    }
  }
  const dashboardSources = new Map<string, string>();
  for (const name of REQUIRED_DASHBOARD_FILES) {
    const path = `project_dashboard/${name}`;
    const source = read(path, true);
    if (source === null) continue;
    dashboardSources.set(name, source);
    const marker = DASHBOARD_GENERATED_MARKERS[name];
    if (marker) {
      const [start, end] = marker;
      const firstStart = source.indexOf(start);
      const firstEnd = source.indexOf(end);
      const hasAnyMarker = firstStart >= 0 || firstEnd >= 0;
      const hasExactlyOne = firstStart >= 0 && firstEnd > firstStart
        && source.indexOf(start, firstStart + start.length) < 0
        && source.indexOf(end, firstEnd + end.length) < 0;
      if (hasAnyMarker && !hasExactlyOne) {
        findings.push(finding("dashboard-generated-marker-invalid", path,
          `required generated marker pair is missing, duplicated, or out of order (${start} ... ${end})`));
      }
    }
  }
  const currentSource = dashboardSources.get("current.md") ?? null;
  if (currentSource !== null) current = parseCurrentRecord(currentSource);
  const notebookSource = dashboardSources.get("notes.md") ?? null;
  if (notebookSource !== null) notebook = parseNotebook(notebookSource);

  const roadmaps = new Map<string, RoadmapRecord>();
  const milestones = new Map<string, MilestoneRecord>();
  const backlog = new Map<string, BacklogRecord>();
  const backlogViews = new Map<string, BacklogViewRecord>();
  const checkpoints = new Map<string, CheckpointRecord>();
  const risks = new Map<string, RiskRecord>();
  const notes: NoteRecord[] = [];
  const decisions = new Map<string, PlanGraphArtifactRecord>();
  const blueprints = new Map<string, PlanGraphArtifactRecord>();

  const insert = <T>(
    map: Map<string, T>,
    id: string,
    value: T,
    path: string,
    kind: string,
  ): void => {
    if (map.has(id)) {
      findings.push(finding(`${kind}-identity-duplicate`, path, `duplicate ${kind} identity ${id}`, "identity", "error", `${kind}:${id}`));
    } else map.set(id, value);
  };

  // Delegates to the single canonical schema-3 lifecycle path authority
  // (assertLifecycleV3ControlPath) instead of a parallel, looser ad hoc
  // check, so a Backlog/Checkpoint bare `${id}.md` (mandatory-slug kinds)
  // is always flagged even though a Risk bare `${id}.md` (optional-slug
  // kind) legitimately is not (W-207).
  const checkFilenameCanonical = (path: string, id: string, code: string, entity: string): void => {
    try {
      assertLifecycleV3ControlPath(path);
    } catch (error) {
      findings.push(finding(code, path, (error as Error).message, "id", "error", entity));
      return;
    }
    if (!basename(path).startsWith(`${id}-`) && basename(path) !== `${id}.md`) {
      findings.push(finding(code, path, `filename must start with ${id}-`, "id", "error", entity));
    }
  };

  for (const path of flatPaths("roadmaps")) {
    const value = parse(path, parseRoadmapRecord);
    if (!value) continue;
    insert(roadmaps, value.slug, value, path, "roadmap");
    if (basename(path, ".md") !== value.slug) findings.push(finding("roadmap-filename-mismatch", path, `filename must be ${value.slug}.md`, "slug", "error", `roadmap:${value.slug}`));
  }
  for (const path of flatPaths("milestones")) {
    const value = parse(path, parseMilestoneRecord);
    if (!value) continue;
    insert(milestones, value.slug, value, path, "milestone");
    if (basename(path, ".md") !== value.slug) findings.push(finding("milestone-filename-mismatch", path, `filename must be ${value.slug}.md`, "slug", "error", `milestone:${value.slug}`));
  }
  for (const path of [...flatPaths("backlog/open"), ...archivePaths("backlog/archive")]) {
    const value = parse(path, parseBacklogRecord);
    if (!value) continue;
    insert(backlog, value.id, value, path, "backlog");
    checkFilenameCanonical(path, value.id, "backlog-filename-mismatch", `backlog:${value.id}`);
  }
  for (const path of flatPaths("backlog_views")) {
    const value = parse(path, parseBacklogViewRecord);
    if (!value) continue;
    insert(backlogViews, value.slug, value, path, "backlog-view");
    if (basename(path, ".md") !== value.slug) {
      findings.push(finding("backlog-view-filename-mismatch", path, `filename must be ${value.slug}.md`, "slug", "error", `backlog-view:${value.slug}`));
    }
  }
  for (const path of [...flatPaths("checkpoints/active"), ...archivePaths("checkpoints/archive")]) {
    const value = parse(path, parseCheckpointRecord);
    if (!value) continue;
    insert(checkpoints, value.id, value, path, "checkpoint");
    checkFilenameCanonical(path, value.id, "checkpoint-filename-mismatch", `checkpoint:${value.id}`);
  }
  for (const path of [...flatPaths("risks/open"), ...archivePaths("risks/archive")]) {
    const value = parse(path, parseRiskRecord);
    if (!value) continue;
    insert(risks, value.id, value, path, "risk");
    checkFilenameCanonical(path, value.id, "risk-filename-mismatch", `risk:${value.id}`);
  }
  const noteIds = new Set<string>();
  for (const path of flatPaths("notes")) {
    const value = parse(path, parseNoteRecord);
    if (!value) continue;
    checkFilenameCanonical(path, value.id, "note-filename-mismatch", `note:${value.id}`);
    if (noteIds.has(value.id)) findings.push(finding("note-identity-duplicate", path, `duplicate note identity ${value.id}`, "id", "error", `note:${value.id}`));
    else {
      noteIds.add(value.id);
      notes.push(value);
    }
  }
  for (const path of flatPaths("decisions")) {
    const value = parse(path, (source, relative) => parseArtifactRecord(source, relative, "decision"));
    if (value) insert(decisions, value.id, value, path, "decision");
  }
  for (const path of flatPaths("blueprints")) {
    const value = parse(path, (source, relative) => parseArtifactRecord(source, relative, "blueprint"));
    if (value) insert(blueprints, value.id, value, path, "blueprint");
  }
  notes.sort((left, right) => compare(left.id, right.id));

  const revision = `sha256:${createHash("sha256").update(
    [...sources.entries()]
      .sort(([left], [right]) => compare(left, right))
      .map(([path, source]) => `${path}\0${Buffer.byteLength(source)}\0${source}`)
      .join("\0"),
  ).digest("hex")}`;
  const base = {
    schemaVersion: 3 as const,
    storage: "plan_graph_markdown" as const,
    controlRoot,
    revision,
    config,
    current,
    roadmaps,
    milestones,
    backlog,
    backlogViews,
    checkpoints,
    risks,
    notes,
    notebook,
    decisions,
    blueprints,
    sources,
  };
  const graph = buildPlanGraph(base);
  const model: PlanGraphControlModel = { ...base, graph, findings };
  model.findings = [...findings, ...validatePlanGraphModel(model)];
  return model;
}

function descendants(model: PlanGraphControlModel, root: string, includeRoot: boolean): string[] {
  const result = new Set<string>();
  const queue = includeRoot ? [root] : [...(model.graph.childrenByMilestone.get(root) ?? [])];
  while (queue.length) {
    const current = queue.shift()!;
    if (result.has(current)) continue;
    result.add(current);
    for (const child of model.graph.childrenByMilestone.get(current) ?? []) queue.push(child);
  }
  return [...result].sort(compare);
}

export function milestoneScope(
  model: PlanGraphControlModel,
  slug: string,
): { milestones: string[]; directBacklog: string[]; descendantBacklog: string[] } {
  const milestones = descendants(model, slug, true);
  const directBacklog = [...(model.graph.backlogByMilestone.get(slug) ?? [])].sort(compare);
  const nested = descendants(model, slug, false);
  const descendantBacklog = [...new Set(nested.flatMap((milestone) => model.graph.backlogByMilestone.get(milestone) ?? []))].sort(compare);
  return { milestones, directBacklog, descendantBacklog };
}

export function roadmapProgress(
  model: PlanGraphControlModel,
  slug: string,
): { backlog: string[]; completed: string[]; milestones: string[]; ratio: number } {
  const milestones = [...model.graph.roadmapsByMilestone.entries()]
    .filter(([, roadmaps]) => roadmaps.includes(slug))
    .map(([milestone]) => milestone)
    .sort(compare);
  const backlog = [...new Set(milestones.flatMap((milestone) => model.graph.backlogByMilestone.get(milestone) ?? []))].sort(compare);
  const completed = backlog.filter((id) => ["done", "cancelled", "superseded"].includes(model.backlog.get(id)?.status ?? ""));
  return {
    backlog,
    completed,
    milestones,
    ratio: backlog.length === 0 ? 0 : completed.length / backlog.length,
  };
}
