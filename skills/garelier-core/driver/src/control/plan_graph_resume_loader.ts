import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertSafeFilesystemPath, assertSafePathWithin } from "./roots.ts";
import { buildPlanGraph } from "./plan_graph_relations.ts";
import { normalizeTypedRef } from "./plan_graph_validate.ts";
import {
  parseBacklogRecord,
  parseArtifactRecord,
  parseCheckpointRecord,
  parseCurrentRecord,
  parseMilestoneRecord,
  parseNotebook,
  parseNoteRecord,
  parsePlanGraphControlConfig,
  parseRoadmapRecord,
} from "./plan_graph_schema.ts";
import type {
  BacklogRecord,
  CheckpointRecord,
  MilestoneRecord,
  NoteRecord,
  PlanGraphControlModel,
  PlanGraphFinding,
  PlanGraphArtifactRecord,
  PlanGraphStoreLimits,
  RoadmapRecord,
} from "./plan_graph_types.ts";
import { DEFAULT_PLAN_GRAPH_LIMITS } from "./plan_graph_types.ts";

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const ACTIVE_CHECKPOINTS = new Set(["active", "paused", "blocked"]);
const MAX_NAVIGATION_FRONTMATTER_BYTES = 64 * 1024;

export interface PlanGraphResumeIoEvent {
  operation: "list" | "read";
  path: string;
  mode: "directory" | "full" | "frontmatter";
  bytes: number;
}

export interface LoadBoundedPlanGraphResumeOptions {
  limits?: Partial<PlanGraphStoreLimits>;
  onIo?: (event: PlanGraphResumeIoEvent) => void;
}

export interface BoundedPlanGraphResumeLoad {
  model: PlanGraphControlModel;
  inventory: {
    backlog: number;
    notes: number;
    milestones: number;
    roadmaps: number;
    decisions: number;
    blueprints: number;
  };
  readSet: string[];
}

function finding(code: string, path: string | null, message: string, field: string | null = null): PlanGraphFinding {
  return { severity: "error", code, path, entity: null, field, message };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Load only the authoritative resume chain. Navigation owners are inspected
 * through capped front matter reads; Backlog, Checkpoint, and Note bodies are
 * read only after Current or a selected record points at them.
 */
export function loadBoundedPlanGraphResume(
  controlRootInput: string,
  options: LoadBoundedPlanGraphResumeOptions = {},
): BoundedPlanGraphResumeLoad {
  const controlRoot = resolve(controlRootInput);
  const limits = { ...DEFAULT_PLAN_GRAPH_LIMITS, ...options.limits };
  assertSafeFilesystemPath(controlRoot, "schema-3 resume control root");

  const sources = new Map<string, string>();
  const readSet = new Set<string>();
  let totalBytes = 0;
  let entityCount = 0;

  const absolute = (relativePath: string): string =>
    assertSafePathWithin(controlRoot, join(controlRoot, relativePath), `schema-3 resume path ${relativePath}`);

  const account = (relativePath: string, bytes: number, mode: PlanGraphResumeIoEvent["mode"]): void => {
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`bounded resume bytes exceed ${limits.maxTotalBytes} at ${relativePath}`);
    }
    readSet.add(relativePath);
    options.onIo?.({ operation: "read", path: relativePath, mode, bytes });
  };

  const read = (relativePath: string): string => {
    const path = absolute(relativePath);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`bounded resume requires a regular file: ${relativePath}`);
    if (info.size > limits.maxFileBytes) throw new Error(`bounded resume file exceeds ${limits.maxFileBytes}: ${relativePath}`);
    const source = readFileSync(path, "utf8");
    account(relativePath, info.size, "full");
    sources.set(relativePath, source);
    return source;
  };

  const readFrontmatter = (relativePath: string): string => {
    const path = absolute(relativePath);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`bounded resume requires a regular file: ${relativePath}`);
    if (info.size > limits.maxFileBytes) throw new Error(`bounded resume file exceeds ${limits.maxFileBytes}: ${relativePath}`);
    const bytesToRead = Math.min(info.size, MAX_NAVIGATION_FRONTMATTER_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const handle = openSync(path, "r");
    let bytes = 0;
    try {
      while (bytes < bytesToRead) {
        const length = Math.min(4 * 1024, bytesToRead - bytes);
        const count = readSync(handle, buffer, bytes, length, bytes);
        if (!count) break;
        bytes += count;
        if (buffer.subarray(0, bytes).toString("utf8").match(/^\+\+\+\r?\n[\s\S]*?\r?\n\+\+\+\r?\n?/)) break;
      }
    } finally {
      closeSync(handle);
    }
    const prefix = buffer.subarray(0, bytes).toString("utf8");
    const close = prefix.match(/^\+\+\+\r?\n[\s\S]*?\r?\n\+\+\+\r?\n?/);
    if (!close) {
      throw new Error(`bounded resume front matter exceeds ${MAX_NAVIGATION_FRONTMATTER_BYTES} or is unterminated: ${relativePath}`);
    }
    account(relativePath, bytes, "frontmatter");
    sources.set(relativePath, close[0]);
    return close[0];
  };

  const list = (relativeDirectory: string, required = false): string[] => {
    const path = join(controlRoot, relativeDirectory);
    if (!existsSync(path)) {
      if (required) throw new Error(`bounded resume directory is missing: ${relativeDirectory}`);
      return [];
    }
    const safe = absolute(relativeDirectory);
    const info = lstatSync(safe);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`bounded resume requires a real directory: ${relativeDirectory}`);
    const entries = readdirSync(safe, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name));
    options.onIo?.({ operation: "list", path: relativeDirectory, mode: "directory", bytes: 0 });
    if (entries.length > limits.maxEntities) throw new Error(`bounded resume directory entry cap exceeded: ${relativeDirectory}`);
    return entries
      .filter((entry) => {
        if (entry.isSymbolicLink()) throw new Error(`bounded resume refuses symlink: ${relativeDirectory}/${entry.name}`);
        return entry.isFile() && entry.name.endsWith(".md");
      })
      .map((entry) => `${relativeDirectory}/${entry.name}`.replaceAll("\\", "/"));
  };

  const archiveFiles = (relativeDirectory: string): string[] => {
    const path = join(controlRoot, relativeDirectory);
    if (!existsSync(path)) return [];
    const safe = absolute(relativeDirectory);
    const years = readdirSync(safe, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name));
    options.onIo?.({ operation: "list", path: relativeDirectory, mode: "directory", bytes: 0 });
    const result: string[] = [];
    for (const year of years) {
      if (year.isSymbolicLink()) throw new Error(`bounded resume refuses symlink: ${relativeDirectory}/${year.name}`);
      if (year.isDirectory() && /^\d{4}$/.test(year.name)) result.push(...list(`${relativeDirectory}/${year.name}`));
    }
    return result;
  };

  const uniqueIdentityPath = (paths: string[], id: string, kind: string): string => {
    const pattern = new RegExp(`^${escapeRegExp(id)}(?:-|\\.md$)`);
    const matches = paths.filter((path) => pattern.test(basename(path)));
    if (matches.length !== 1) {
      throw new Error(matches.length
        ? `bounded resume found duplicate ${kind} identity ${id}: ${matches.join(", ")}`
        : `bounded resume missing referenced ${kind} ${id}`);
    }
    return matches[0]!;
  };

  const configSource = read("control.toml");
  const config = parsePlanGraphControlConfig(configSource);
  const currentSource = read("project_dashboard/current.md");
  const current = parseCurrentRecord(currentSource);
  // notes.md is one durable notebook. It is read once; individual Note records
  // remain pointer-selected and are never body-scanned to discover backlinks.
  const notebookSource = read("project_dashboard/notes.md");
  const notebook = parseNotebook(notebookSource);
  read("project_dashboard/quality_gates.md");

  const checkpointPaths = list("checkpoints/active");
  const backlogPaths = [...list("backlog/open"), ...archiveFiles("backlog/archive")];
  const notePaths = list("notes");
  const roadmapPaths = list("roadmaps");
  const milestonePaths = list("milestones");
  const decisionPaths = list("decisions");
  const blueprintPaths = list("blueprints");

  const checkpoints = new Map<string, CheckpointRecord>();
  for (const path of checkpointPaths) {
    if (++entityCount > limits.maxEntities) throw new Error(`bounded resume navigation entity cap exceeds ${limits.maxEntities}`);
    const record = parseCheckpointRecord(read(path), path);
    if (!ACTIVE_CHECKPOINTS.has(record.status)) {
      throw new Error(`bounded resume active directory contains non-resumable Checkpoint ${record.id} (${record.status})`);
    }
    if (checkpoints.has(record.id)) throw new Error(`bounded resume duplicate Checkpoint ${record.id}`);
    checkpoints.set(record.id, record);
  }
  for (const id of [...current.checkpointCandidates, ...(current.primaryCheckpointId ? [current.primaryCheckpointId] : [])]) {
    if (!checkpoints.has(id)) throw new Error(`bounded resume Current references missing Checkpoint ${id}`);
  }

  const backlog = new Map<string, BacklogRecord>();
  const backlogIds = [...new Set([...checkpoints.values()].flatMap((checkpoint) => checkpoint.backlog))].sort(compare);
  for (const id of backlogIds) {
    const path = uniqueIdentityPath(backlogPaths, id, "Backlog");
    const record = parseBacklogRecord(read(path), path);
    if (record.id !== id) throw new Error(`bounded resume Backlog identity mismatch: ${path}`);
    backlog.set(id, record);
  }

  // Roadmap/Milestone relations are front-matter-only navigation metadata.
  // Inspecting this bounded index is enough to derive parents, children, and
  // direct/inherited Roadmaps without loading unrelated artifact bodies.
  const roadmaps = new Map<string, RoadmapRecord>();
  for (const path of roadmapPaths) {
    if (++entityCount > limits.maxEntities) throw new Error(`bounded resume navigation entity cap exceeds ${limits.maxEntities}`);
    const record = parseRoadmapRecord(readFrontmatter(path), path);
    if (roadmaps.has(record.slug)) throw new Error(`bounded resume duplicate Roadmap ${record.slug}`);
    roadmaps.set(record.slug, record);
  }
  const milestones = new Map<string, MilestoneRecord>();
  for (const path of milestonePaths) {
    if (++entityCount > limits.maxEntities) throw new Error(`bounded resume navigation entity cap exceeds ${limits.maxEntities}`);
    const record = parseMilestoneRecord(readFrontmatter(path), path);
    if (milestones.has(record.slug)) throw new Error(`bounded resume duplicate Milestone ${record.slug}`);
    milestones.set(record.slug, record);
  }

  const requiredMilestones = new Set([
    ...[...checkpoints.values()].flatMap((checkpoint) => checkpoint.milestones),
    ...[...backlog.values()].flatMap((record) =>
      record.milestoneMemberships.filter((membership) => membership.state === "active").map((membership) => membership.target)),
  ]);
  for (const slug of requiredMilestones) {
    if (!milestones.has(slug)) throw new Error(`bounded resume missing referenced Milestone ${slug}`);
  }
  for (const slug of [...checkpoints.values()].flatMap((checkpoint) => checkpoint.roadmaps)) {
    if (!roadmaps.has(slug)) throw new Error(`bounded resume missing referenced Roadmap ${slug}`);
  }

  const directlyRelated = new Set([
    ...[...checkpoints.values()].flatMap((checkpoint) => checkpoint.related),
    ...[...backlog.values()].flatMap((record) => record.related),
    ...current.readFirst,
    ...[...checkpoints.values()].flatMap((checkpoint) => checkpoint.readFirst),
  ]);
  const relatedEntityRefs = new Set([
    ...[...checkpoints.keys()].map((id) => `checkpoint:${id}`),
    ...[...backlog.keys()].map((id) => `backlog:${id}`),
    ...[...requiredMilestones].map((slug) => `milestone:${slug}`),
    ...[...checkpoints.values()].flatMap((checkpoint) => checkpoint.roadmaps).map((slug) => `roadmap:${slug}`),
  ]);

  const loadRelevantArtifacts = (
    kind: "decision" | "blueprint",
    paths: string[],
  ): Map<string, PlanGraphArtifactRecord> => {
    const indexed = new Map<string, { path: string; record: PlanGraphArtifactRecord }>();
    for (const path of paths) {
      if (++entityCount > limits.maxEntities) throw new Error(`bounded resume navigation entity cap exceeds ${limits.maxEntities}`);
      const record = parseArtifactRecord(readFrontmatter(path), path, kind);
      if (indexed.has(record.id)) throw new Error(`bounded resume duplicate ${kind} ${record.id}`);
      indexed.set(record.id, { path, record });
    }
    const prefix = `${kind}:`;
    const selected = new Set<string>();
    for (const reference of directlyRelated) {
      if (reference.startsWith(prefix)) selected.add(reference.slice(prefix.length));
      const normalized = reference.replaceAll("\\", "/").replace(/^\.\//, "");
      for (const [id, artifact] of indexed) {
        if (normalized === artifact.path) selected.add(id);
      }
    }
    for (const [id, artifact] of indexed) {
      if (artifact.record.related.some((reference) => relatedEntityRefs.has(normalizeTypedRef(reference)))) selected.add(id);
    }
    const loaded = new Map<string, PlanGraphArtifactRecord>();
    for (const id of [...selected].sort(compare)) {
      const indexedArtifact = indexed.get(id);
      if (!indexedArtifact) throw new Error(`bounded resume missing referenced ${kind} ${id}`);
      const record = parseArtifactRecord(read(indexedArtifact.path), indexedArtifact.path, kind);
      if (record.id !== id) throw new Error(`bounded resume ${kind} identity mismatch: ${indexedArtifact.path}`);
      loaded.set(id, record);
    }
    return loaded;
  };

  const decisions = loadRelevantArtifacts("decision", decisionPaths);
  const blueprints = loadRelevantArtifacts("blueprint", blueprintPaths);
  const reportPaths = new Set<string>();
  for (const reference of [...directlyRelated].sort(compare)) {
    let normalized = reference.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.startsWith("report:")) normalized = normalized.slice("report:".length);
    const reportsAt = normalized.indexOf("reports/");
    if (reportsAt >= 0) normalized = normalized.slice(reportsAt);
    else if (reference.startsWith("report:")) normalized = `reports/${normalized}`;
    else continue;
    assertSafePathWithin(join(controlRoot, "reports"), join(controlRoot, normalized), `schema-3 resume report ${normalized}`);
    reportPaths.add(normalized);
  }
  for (const path of [...reportPaths].sort(compare)) read(path);
  const noteIds = [...directlyRelated]
    .map((reference) => /^note:(N-\d{3,})$/i.exec(reference)?.[1])
    .filter((id): id is string => Boolean(id));
  const notes: NoteRecord[] = [];
  for (const id of [...new Set(noteIds)].sort(compare)) {
    const path = uniqueIdentityPath(notePaths, id, "Note");
    const record = parseNoteRecord(read(path), path);
    if (record.id !== id) throw new Error(`bounded resume Note identity mismatch: ${path}`);
    notes.push(record);
  }

  const revision = `sha256:${createHash("sha256").update(
    [...sources.entries()].sort(([left], [right]) => compare(left, right))
      .map(([path, source]) => `${path}\0${Buffer.byteLength(source)}\0${source}`).join("\0"),
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
    backlogViews: new Map(),
    checkpoints,
    risks: new Map(),
    notes,
    notebook,
    decisions,
    blueprints,
    sources,
  };
  const graph = buildPlanGraph(base);
  const findings: PlanGraphFinding[] = [];
  if (!current.primaryCheckpointId && current.checkpointCandidates.length) {
    findings.push(finding("resume-primary-missing", current.path, "Current has resumable Checkpoints but no primary pointer", "primary_checkpoint"));
  }
  const model: PlanGraphControlModel = { ...base, graph, findings };
  return {
    model,
    inventory: {
      backlog: backlogPaths.length,
      notes: notePaths.length + notebook.sections.length,
      milestones: milestonePaths.length,
      roadmaps: roadmapPaths.length,
      decisions: decisionPaths.length,
      blueprints: blueprintPaths.length,
    },
    readSet: [...readSet].sort(compare),
  };
}
