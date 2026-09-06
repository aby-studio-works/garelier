import type {
  BacklogRecord,
  CheckpointRecord,
  PlanGraphControlModel,
  PlanGraphContextNeighborhood,
  PlanGraphFinding,
  PlanGraphArtifactRecord,
  PlanGraphResumePacket,
  RepositoryState,
  ResumeCheckpointProjection,
} from "./plan_graph_types.ts";
import { normalizeTypedRef } from "./plan_graph_validate.ts";

export interface PlanGraphResumeOptions {
  maxBytes?: number;
  repositoryState?: RepositoryState;
  allowInvalid?: boolean;
  inventory?: {
    backlog: number;
    notes: number;
    milestones: number;
    roadmaps: number;
    decisions: number;
    blueprints: number;
  };
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const ACTIVE_CHECKPOINTS = new Set(["active", "paused", "blocked"]);
const MIN_RESUME_BYTES = 2_048;
const MAX_REPORTED_TRUNCATION_FIELDS = 12;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort(compare).map((key) => [key, stableValue(record[key])]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function byteLength(packet: PlanGraphResumePacket): number {
  return Buffer.byteLength(stableJson(packet), "utf8");
}

function checkpointProjection(checkpoint: CheckpointRecord): ResumeCheckpointProjection {
  return {
    id: checkpoint.id,
    status: checkpoint.status,
    path: checkpoint.path,
    exact_next_action: checkpoint.exactNextAction,
    last_completed: checkpoint.lastCompleted,
    blockers: checkpoint.blockers,
    unresolved_assumptions: checkpoint.unresolvedAssumptions,
    last_verified_baseline: checkpoint.knownGoodBaseline,
    branch: checkpoint.branch,
    head: checkpoint.head,
    working_tree: checkpoint.workingTree,
    git_status_hash: checkpoint.gitStatusHash,
    staged_paths: [...checkpoint.stagedPaths],
    modified_paths: [...checkpoint.modifiedPaths],
    untracked_paths: [...checkpoint.untrackedPaths],
    active_action: checkpoint.action ? {
      token: checkpoint.action.token,
      prepared_at: checkpoint.action.preparedAt,
      exact_next_action: checkpoint.action.exactNextAction,
      before: checkpoint.action.before,
      success: checkpoint.action.success,
      targets: [...checkpoint.action.targets],
    } : null,
    roadmaps: [...checkpoint.roadmaps],
    milestones: [...checkpoint.milestones],
    backlog: [...checkpoint.backlog],
    read_first: [...checkpoint.readFirst],
    resume_verification: checkpoint.resumeVerification,
  };
}

function checkpointOrder(model: PlanGraphControlModel): CheckpointRecord[] {
  const explicit = model.current?.checkpointCandidates ?? [];
  const rank = new Map(explicit.map((id, index) => [id, index]));
  const stateRank = new Map([["active", 0], ["blocked", 1], ["paused", 2]]);
  return [...model.checkpoints.values()]
    .filter((checkpoint) => ACTIVE_CHECKPOINTS.has(checkpoint.status))
    .sort((left, right) => {
      const leftExplicit = rank.get(left.id);
      const rightExplicit = rank.get(right.id);
      if (leftExplicit !== undefined || rightExplicit !== undefined) {
        if (leftExplicit === undefined) return 1;
        if (rightExplicit === undefined) return -1;
        return leftExplicit - rightExplicit;
      }
      return (stateRank.get(left.status) ?? 9) - (stateRank.get(right.status) ?? 9)
        || Date.parse(right.updated) - Date.parse(left.updated)
        || compare(left.id, right.id);
    });
}

function selectPrimary(model: PlanGraphControlModel, ordered: CheckpointRecord[]): CheckpointRecord | null {
  const explicit = model.current?.primaryCheckpointId;
  if (explicit) {
    const checkpoint = model.checkpoints.get(explicit);
    if (checkpoint && ACTIVE_CHECKPOINTS.has(checkpoint.status)) return checkpoint;
  }
  return ordered[0] ?? null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function projectBacklog(record: BacklogRecord): PlanGraphResumePacket["backlog"][number] {
  return {
    id: record.id,
    status: record.status,
    path: record.path,
    current_position: record.currentPosition,
    exact_next_action: record.exactNextAction,
    milestones: record.milestoneMemberships.filter((link) => link.state === "active").map((link) => link.target),
  };
}

function driftFinding(recorded: RepositoryState, actual: RepositoryState): PlanGraphFinding | null {
  const differences: string[] = [];
  if (recorded.branch !== actual.branch) differences.push(`branch ${recorded.branch} != ${actual.branch}`);
  if (recorded.head !== actual.head) differences.push(`HEAD ${recorded.head} != ${actual.head}`);
  if (recorded.workingTree !== actual.workingTree) differences.push(`working tree ${recorded.workingTree} != ${actual.workingTree}`);
  if (recorded.statusHash && actual.statusHash && recorded.statusHash !== actual.statusHash) {
    differences.push(`status hash ${recorded.statusHash} != ${actual.statusHash}`);
  }
  return differences.length
    ? {
      severity: "warning",
      code: "resume-drift",
      path: null,
      entity: null,
      field: "repository",
      message: differences.join("; "),
    }
    : null;
}

function omittedQuery(kind: keyof PlanGraphResumePacket["omitted"], id?: string): string {
  if (kind === "backlog" && id) return `garelier control context --backlog ${id}`;
  if (kind === "checkpoint_candidates") return "garelier control context --resume --all-checkpoints";
  if (kind === "milestones" && id) return `garelier control context --milestone ${id} --depth 2`;
  if (kind === "roadmaps" && id) return `garelier control context --roadmap ${id}`;
  if (kind === "notes") return "garelier control context --related note --to <typed-ref>";
  if (kind === "decisions" && id) return `garelier control get decision:${id}`;
  if (kind === "blueprints" && id) return `garelier control get blueprint:${id}`;
  if (kind === "reports" && id) return `read ${id}`;
  return "garelier control context --resume --read-first";
}

function projectArtifact(record: PlanGraphArtifactRecord): PlanGraphResumePacket["relevant_decisions"][number] {
  return {
    id: record.id,
    status: record.status,
    path: record.path,
    body: record.body,
    related: [...record.related],
  };
}

export function buildPlanGraphContextNeighborhood(
  model: PlanGraphControlModel,
  root: string,
  depth = 1,
): PlanGraphContextNeighborhood {
  if (!Number.isInteger(depth) || depth < 0 || depth > 32) {
    throw new Error("context depth must be an integer between 0 and 32");
  }
  if (!model.graph.nodes.some((node) => node.id === root)) {
    throw new Error(`context root does not exist: ${root}`);
  }
  const visited = new Set([root]);
  let frontier = new Set([root]);
  const selectedLinks = new Map<string, (typeof model.graph.edges)[number]>();
  for (let level = 0; level < depth && frontier.size; level++) {
    const next = new Set<string>();
    for (const edge of model.graph.edges) {
      if (!frontier.has(edge.from) && !frontier.has(edge.to)) continue;
      const key = `${edge.from}\0${edge.kind}\0${edge.to}\0${edge.relationId}`;
      selectedLinks.set(key, edge);
      for (const id of [edge.from, edge.to]) {
        if (!visited.has(id)) {
          visited.add(id);
          next.add(id);
        }
      }
    }
    frontier = next;
  }
  return {
    root,
    depth,
    nodes: model.graph.nodes.filter((node) => visited.has(node.id)),
    links: [...selectedLinks.values()],
  };
}

function utf8Excerpt(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const marker = "\n[… truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes) {
    let result = "";
    for (const character of "…") {
      if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
      result += character;
    }
    return result;
  }
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") + markerBytes > maxBytes) break;
    result += character;
  }
  return `${result}${marker}`;
}

export function buildPlanGraphResume(
  model: PlanGraphControlModel,
  options: PlanGraphResumeOptions = {},
): PlanGraphResumePacket {
  const firstError = model.findings.find((finding) => finding.severity === "error");
  if (firstError && !options.allowInvalid) {
    throw new Error(`plan graph has error finding ${firstError.code}; resume refused`);
  }
  const cap = options.maxBytes ?? model.config?.maxResumeBytes ?? 24_576;
  if (!Number.isInteger(cap) || cap < MIN_RESUME_BYTES) {
    throw new Error(`maxBytes must be an integer of at least ${MIN_RESUME_BYTES}`);
  }
  const ordered = checkpointOrder(model);
  const primary = selectPrimary(model, ordered);
  const blocked = ordered.filter((checkpoint) => checkpoint.status === "blocked" && checkpoint.id !== primary?.id);
  const candidates = ordered.filter((checkpoint) => checkpoint.id !== primary?.id && checkpoint.status !== "blocked");
  const selectedCheckpoints = [primary, ...blocked, ...candidates].filter((value): value is CheckpointRecord => value !== null);

  const selectedBacklogIds = unique(selectedCheckpoints.flatMap((checkpoint) => checkpoint.backlog));
  const selectedBacklog = selectedBacklogIds
    .map((id) => model.backlog.get(id))
    .filter((record): record is BacklogRecord => Boolean(record))
    .sort((left, right) => compare(left.id, right.id));
  const omittedBacklog = [...model.backlog.keys()].filter((id) => !selectedBacklogIds.includes(id)).sort(compare);
  const backlogTotal = options.inventory?.backlog ?? model.backlog.size;

  const directMilestoneIds = unique([
    ...selectedCheckpoints.flatMap((checkpoint) => checkpoint.milestones),
    ...selectedBacklog.flatMap((backlog) => backlog.milestoneMemberships.filter((link) => link.state === "active").map((link) => link.target)),
  ]).sort(compare);
  const milestoneSet = new Set(directMilestoneIds);
  const milestoneQueue = [...directMilestoneIds];
  while (milestoneQueue.length) {
    const child = milestoneQueue.shift()!;
    for (const parent of model.graph.parentsByMilestone.get(child) ?? []) {
      if (milestoneSet.has(parent)) continue;
      milestoneSet.add(parent);
      milestoneQueue.push(parent);
    }
  }
  const milestoneIds = [...milestoneSet].sort(compare);
  const roadmaps = unique([
    ...selectedCheckpoints.flatMap((checkpoint) => checkpoint.roadmaps),
    ...milestoneIds.flatMap((milestone) => model.graph.roadmapsByMilestone.get(milestone) ?? []),
  ]).sort(compare);
  const relatedRefs = new Set([
    ...selectedBacklogIds.map((id) => `backlog:${id}`),
    ...milestoneIds.map((id) => `milestone:${id}`),
    ...roadmaps.map((id) => `roadmap:${id}`),
    ...selectedCheckpoints.map((checkpoint) => `checkpoint:${checkpoint.id}`),
  ]);
  const directReferences = new Set([
    ...(model.current?.readFirst ?? []),
    ...selectedCheckpoints.flatMap((checkpoint) => [...checkpoint.related, ...checkpoint.readFirst]),
    ...selectedBacklog.flatMap((backlog) => backlog.related),
  ]);
  const relevantNotes: PlanGraphResumePacket["relevant_notes"] = [];
  for (const note of model.notes) {
    if (!directReferences.has(`note:${note.id}`) && !directReferences.has(note.path)
      && !note.related.some((ref) => relatedRefs.has(normalizeTypedRef(ref)))) continue;
    relevantNotes.push({ path: note.path, heading: note.id, body: note.body, related: [...note.related] });
  }
  for (const section of model.notebook?.sections ?? []) {
    const sectionId = /\b(N-\d{3,})\b/.exec(section.heading)?.[1];
    if ((!sectionId || !directReferences.has(`note:${sectionId}`))
      && !section.related.some((ref) => relatedRefs.has(normalizeTypedRef(ref)))) continue;
    relevantNotes.push({
      path: model.notebook!.path,
      heading: section.heading,
      body: section.body,
      related: [...section.related],
    });
  }
  relevantNotes.sort((left, right) => compare(left.path, right.path) || compare(left.heading, right.heading));
  const artifactIsRelevant = (record: PlanGraphArtifactRecord): boolean =>
    directReferences.has(`${record.kind}:${record.id}`)
    || directReferences.has(record.path)
    || record.related.some((reference) => relatedRefs.has(normalizeTypedRef(reference)));
  const relevantDecisions = [...model.decisions.values()].filter(artifactIsRelevant)
    .sort((left, right) => compare(left.id, right.id)).map(projectArtifact);
  const relevantBlueprints = [...model.blueprints.values()].filter(artifactIsRelevant)
    .sort((left, right) => compare(left.id, right.id)).map(projectArtifact);
  const relevantReports = [...model.sources.entries()]
    .filter(([path]) => path.startsWith("reports/"))
    .sort(([left], [right]) => compare(left, right))
    .map(([path, body]) => ({ path, body }));
  const qualityGates = {
    path: "project_dashboard/quality_gates.md",
    body: model.sources.get("project_dashboard/quality_gates.md") ?? "",
  };

  const recorded = primary && primary.branch && primary.head && primary.workingTree
    ? {
      branch: primary.branch,
      head: primary.head,
      workingTree: primary.workingTree,
      statusHash: primary.gitStatusHash ?? undefined,
      staged: [...primary.stagedPaths],
      modified: [...primary.modifiedPaths],
      untracked: [...primary.untrackedPaths],
    }
    : null;
  const resumeFindings = model.findings.filter((item) => item.severity === "error");
  const repositoryDrift = recorded && options.repositoryState
    ? driftFinding(recorded, options.repositoryState)
    : null;
  if (repositoryDrift) resumeFindings.push(repositoryDrift);
  const readFirst = unique([
    ...(model.current?.readFirst ?? []),
    ...selectedCheckpoints.flatMap((checkpoint) => checkpoint.readFirst),
  ]);
  const packet: PlanGraphResumePacket = {
    schema_version: 1,
    control_schema_version: 3,
    storage: "plan_graph_markdown",
    control_revision: model.revision,
    current: {
      standing_instructions: model.current?.standingInstructions ?? "",
      position: model.current?.currentPosition ?? "",
      blockers: model.current?.blockers ?? "",
      primary_checkpoint_id: primary?.id ?? null,
    },
    primary_checkpoint: primary ? checkpointProjection(primary) : null,
    blocked_checkpoints: blocked.map(checkpointProjection),
    checkpoint_candidates: candidates.map(checkpointProjection),
    backlog: selectedBacklog.map(projectBacklog),
    milestones: milestoneIds
      .map((slug) => model.milestones.get(slug))
      .filter((milestone): milestone is NonNullable<typeof milestone> => Boolean(milestone))
      .map((milestone) => ({
        slug: milestone.slug,
        status: milestone.status,
        parents: [...(model.graph.parentsByMilestone.get(milestone.slug) ?? [])],
        roadmaps: [...(model.graph.roadmapsByMilestone.get(milestone.slug) ?? [])],
      })),
    roadmaps: roadmaps
      .map((slug) => model.roadmaps.get(slug))
      .filter((roadmap): roadmap is NonNullable<typeof roadmap> => Boolean(roadmap))
      .map((roadmap) => ({ slug: roadmap.slug, status: roadmap.status })),
    relevant_decisions: relevantDecisions,
    relevant_blueprints: relevantBlueprints,
    relevant_reports: relevantReports,
    relevant_notes: relevantNotes,
    quality_gates: qualityGates,
    read_first: readFirst,
    repository: { recorded, actual: options.repositoryState ?? null, drift: repositoryDrift !== null },
    diagnostics: {
      errors: resumeFindings.filter((item) => item.severity === "error").length,
      warnings: resumeFindings.filter((item) => item.severity === "warning").length,
      findings: resumeFindings,
    },
    omitted: {
      backlog: Math.max(0, backlogTotal - selectedBacklog.length),
      checkpoint_candidates: 0,
      milestones: Math.max(0, (options.inventory?.milestones ?? model.milestones.size) - milestoneIds.filter((id) => model.milestones.has(id)).length),
      notes: Math.max(0, (options.inventory?.notes ?? (model.notes.length + (model.notebook?.sections.length ?? 0))) - relevantNotes.length),
      decisions: Math.max(0, (options.inventory?.decisions ?? model.decisions.size) - relevantDecisions.length),
      blueprints: Math.max(0, (options.inventory?.blueprints ?? model.blueprints.size) - relevantBlueprints.length),
      reports: 0,
      read_first: 0,
      roadmaps: Math.max(0, (options.inventory?.roadmaps ?? model.roadmaps.size) - roadmaps.filter((id) => model.roadmaps.has(id)).length),
    },
    truncation: { omitted_bytes: 0, field_count: 0, fields: [], unlisted_fields: 0 },
    queries: [],
  };
  const queryKinds = new Set<keyof PlanGraphResumePacket["omitted"]>();
  const ensureQuery = (kind: keyof PlanGraphResumePacket["omitted"], id?: string): void => {
    if (queryKinds.has(kind)) return;
    queryKinds.add(kind);
    packet.queries.push(omittedQuery(kind, id));
  };
  if (packet.omitted.backlog) ensureQuery("backlog", omittedBacklog[0]);
  if (packet.omitted.milestones) {
    const omitted = [...model.milestones.keys()].filter((id) => !milestoneIds.includes(id)).sort(compare);
    ensureQuery("milestones", omitted[0]);
  }
  if (packet.omitted.roadmaps) {
    const omitted = [...model.roadmaps.keys()].filter((id) => !roadmaps.includes(id)).sort(compare);
    ensureQuery("roadmaps", omitted[0]);
  }
  if (packet.omitted.notes) ensureQuery("notes");
  if (packet.omitted.decisions) ensureQuery("decisions");
  if (packet.omitted.blueprints) ensureQuery("blueprints");

  const truncatedFields = new Set<string>();
  const recordOmission = (path: string, beforeBytes: number, afterBytes: number): void => {
    const delta = Math.max(0, beforeBytes - afterBytes);
    if (!delta) return;
    packet.truncation.omitted_bytes += delta;
    truncatedFields.add(path);
    const sorted = [...truncatedFields].sort(compare);
    packet.truncation.field_count = sorted.length;
    packet.truncation.fields = sorted.slice(0, MAX_REPORTED_TRUNCATION_FIELDS);
    packet.truncation.unlisted_fields = Math.max(0, sorted.length - packet.truncation.fields.length);
    if (path === "quality_gates.body") {
      if (!packet.queries.includes("read project_dashboard/quality_gates.md")) {
        packet.queries.push("read project_dashboard/quality_gates.md");
      }
    } else {
      ensureQuery("read_first");
    }
  };

  const removeLast = <T>(
    values: T[],
    kind: keyof PlanGraphResumePacket["omitted"],
    identity?: (value: T) => string,
  ): boolean => {
    const removed = values.pop();
    if (removed === undefined) return false;
    packet.omitted[kind]++;
    ensureQuery(kind, identity?.(removed));
    return true;
  };
  while (byteLength(packet) > cap && removeLast(packet.relevant_notes, "notes")) {}
  while (byteLength(packet) > cap && removeLast(packet.relevant_blueprints, "blueprints", (value) => value.id)) {}
  while (byteLength(packet) > cap && removeLast(packet.relevant_decisions, "decisions", (value) => value.id)) {}
  while (byteLength(packet) > cap && removeLast(packet.relevant_reports, "reports", (value) => value.path)) {}
  while (byteLength(packet) > cap && removeLast(packet.roadmaps, "roadmaps", (value) => value.slug)) {}
  while (byteLength(packet) > cap && removeLast(packet.milestones, "milestones", (value) => value.slug)) {}
  while (byteLength(packet) > cap && removeLast(packet.checkpoint_candidates, "checkpoint_candidates", (value) => value.id)) {}
  while (byteLength(packet) > cap && removeLast(packet.read_first, "read_first")) {}

  interface StringSlot {
    path: string;
    minimum: number;
    preserveMinimum?: boolean;
    get(): string;
    set(value: string): void;
  }
  const stringSlots = (): StringSlot[] => {
    const slots: StringSlot[] = [
      { path: "current.standing_instructions", minimum: 64, get: () => packet.current.standing_instructions, set: (value) => { packet.current.standing_instructions = value; } },
      { path: "current.position", minimum: 64, get: () => packet.current.position, set: (value) => { packet.current.position = value; } },
      { path: "current.blockers", minimum: 64, get: () => packet.current.blockers, set: (value) => { packet.current.blockers = value; } },
    ];
    const addCheckpoint = (checkpoint: ResumeCheckpointProjection, path: string): void => {
      slots.push(
        { path: `${path}.path`, minimum: 24, get: () => checkpoint.path, set: (value) => { checkpoint.path = value; } },
        { path: `${path}.exact_next_action`, minimum: 96, get: () => checkpoint.exact_next_action, set: (value) => { checkpoint.exact_next_action = value; } },
        { path: `${path}.last_completed`, minimum: 48, get: () => checkpoint.last_completed, set: (value) => { checkpoint.last_completed = value; } },
        { path: `${path}.blockers`, minimum: 64, get: () => checkpoint.blockers, set: (value) => { checkpoint.blockers = value; } },
        { path: `${path}.unresolved_assumptions`, minimum: 48, get: () => checkpoint.unresolved_assumptions, set: (value) => { checkpoint.unresolved_assumptions = value; } },
        { path: `${path}.last_verified_baseline`, minimum: 48, get: () => checkpoint.last_verified_baseline, set: (value) => { checkpoint.last_verified_baseline = value; } },
        { path: `${path}.resume_verification`, minimum: 48, get: () => checkpoint.resume_verification, set: (value) => { checkpoint.resume_verification = value; } },
      );
      for (const key of ["branch", "head", "working_tree"] as const) {
        if (checkpoint[key] !== null) slots.push({
          path: `${path}.${key}`,
          minimum: 24,
          get: () => checkpoint[key] ?? "",
          set: (value) => { checkpoint[key] = value; },
        });
      }
      if (checkpoint.active_action) {
        slots.push(
          {
            path: `${path}.active_action.before`,
            minimum: 32,
            preserveMinimum: true,
            get: () => checkpoint.active_action?.before ?? "",
            set: (value) => { if (checkpoint.active_action) checkpoint.active_action.before = value; },
          },
          {
            path: `${path}.active_action.success`,
            minimum: 48,
            get: () => checkpoint.active_action?.success ?? "",
            set: (value) => { if (checkpoint.active_action) checkpoint.active_action.success = value; },
          },
        );
      }
    };
    if (packet.primary_checkpoint) addCheckpoint(packet.primary_checkpoint, "primary_checkpoint");
    packet.blocked_checkpoints.forEach((checkpoint, index) => addCheckpoint(checkpoint, `blocked_checkpoints.${index}`));
    packet.backlog.forEach((backlog, index) => slots.push(
      { path: `backlog.${index}.path`, minimum: 24, get: () => backlog.path, set: (value) => { backlog.path = value; } },
      { path: `backlog.${index}.current_position`, minimum: 64, get: () => backlog.current_position, set: (value) => { backlog.current_position = value; } },
      { path: `backlog.${index}.exact_next_action`, minimum: 64, get: () => backlog.exact_next_action, set: (value) => { backlog.exact_next_action = value; } },
    ));
    for (const [kind, state] of [["recorded", packet.repository.recorded], ["actual", packet.repository.actual]] as const) {
      if (!state) continue;
      for (const key of ["branch", "head", "workingTree"] as const) slots.push({
        path: `repository.${kind}.${key}`,
        minimum: 24,
        get: () => state[key],
        set: (value) => { state[key] = value; },
      });
    }
    packet.diagnostics.findings.forEach((finding, index) => slots.push({
      path: `diagnostics.findings.${index}.message`,
      minimum: 48,
      get: () => finding.message,
      set: (value) => { finding.message = value; },
    }));
    slots.push({
      path: "quality_gates.body",
      minimum: 96,
      get: () => packet.quality_gates.body,
      set: (value) => { packet.quality_gates.body = value; },
    });
    return slots;
  };
  const shrinkLargestString = (allowEmpty: boolean): boolean => {
    const candidates = stringSlots()
      .map((slot) => ({ slot, bytes: Buffer.byteLength(slot.get(), "utf8") }))
      .filter(({ slot, bytes }) => bytes > (allowEmpty && !slot.preserveMinimum ? 0 : slot.minimum))
      .sort((left, right) => right.bytes - left.bytes || compare(left.slot.path, right.slot.path));
    const candidate = candidates[0];
    if (!candidate) return false;
    const excess = Math.max(1, byteLength(packet) - cap);
    const floor = allowEmpty && !candidate.slot.preserveMinimum ? 0 : candidate.slot.minimum;
    const target = Math.max(floor, candidate.bytes - Math.max(excess + 64, Math.ceil(candidate.bytes / 3)));
    const value = candidate.slot.get();
    const excerpt = utf8Excerpt(value, target);
    candidate.slot.set(excerpt);
    recordOmission(candidate.slot.path, Buffer.byteLength(value, "utf8"), Buffer.byteLength(excerpt, "utf8"));
    return excerpt !== value;
  };
  while (byteLength(packet) > cap && shrinkLargestString(false)) {}

  const recordArrayPop = <T>(values: T[], path: string): boolean => {
    if (!values.length) return false;
    const before = Buffer.byteLength(stableJson(values), "utf8");
    values.pop();
    const after = Buffer.byteLength(stableJson(values), "utf8");
    recordOmission(path, before, after);
    return true;
  };
  while (byteLength(packet) > cap) {
    if (packet.backlog.length > 1) {
      const primaryBacklog = new Set(packet.primary_checkpoint?.backlog ?? []);
      let index = packet.backlog.findLastIndex((entry) => !primaryBacklog.has(entry.id));
      if (index < 0) index = packet.backlog.length - 1;
      const [removed] = packet.backlog.splice(index, 1);
      if (!removed) continue;
      packet.omitted.backlog++;
      ensureQuery("backlog", removed.id);
      recordOmission("backlog", Buffer.byteLength(stableJson(removed), "utf8"), 0);
      continue;
    }
    const arrays: Array<{ path: string; values: string[]; minimum?: number }> = [];
    if (packet.primary_checkpoint) {
      for (const key of ["read_first", "roadmaps", "milestones", "backlog", "staged_paths", "modified_paths", "untracked_paths"] as const) {
        arrays.push({ path: `primary_checkpoint.${key}`, values: packet.primary_checkpoint[key] });
      }
      if (packet.primary_checkpoint.active_action) arrays.push({
        path: "primary_checkpoint.active_action.targets",
        values: packet.primary_checkpoint.active_action.targets,
        minimum: 1,
      });
    }
    packet.blocked_checkpoints.forEach((checkpoint, index) => {
      for (const key of ["read_first", "roadmaps", "milestones", "backlog", "staged_paths", "modified_paths", "untracked_paths"] as const) {
        arrays.push({ path: `blocked_checkpoints.${index}.${key}`, values: checkpoint[key] });
      }
      if (checkpoint.active_action) arrays.push({
        path: `blocked_checkpoints.${index}.active_action.targets`,
        values: checkpoint.active_action.targets,
        minimum: 1,
      });
    });
    for (const [kind, state] of [["recorded", packet.repository.recorded], ["actual", packet.repository.actual]] as const) {
      if (!state) continue;
      for (const key of ["staged", "modified", "untracked"] as const) {
        const values = state[key];
        if (values) arrays.push({ path: `repository.${kind}.${key}`, values });
      }
    }
    packet.backlog.forEach((backlog, index) => arrays.push({ path: `backlog.${index}.milestones`, values: backlog.milestones }));
    const shrinkable = arrays.filter((entry) => entry.values.length > (entry.minimum ?? 0));
    shrinkable.sort((left, right) => right.values.length - left.values.length || compare(left.path, right.path));
    if (shrinkable[0] && recordArrayPop(shrinkable[0].values, shrinkable[0].path)) continue;
    const removableFinding = packet.diagnostics.findings.findLastIndex((finding) => finding.code !== "resume-drift");
    if (removableFinding >= 0) {
      const [removed] = packet.diagnostics.findings.splice(removableFinding, 1);
      if (!removed) continue;
      recordOmission("diagnostics.findings", Buffer.byteLength(stableJson(removed), "utf8"), 0);
      continue;
    }
    if (shrinkLargestString(true)) continue;
    throw new Error(`resume packet structural minimum cannot fit maxBytes=${cap}`);
  }
  return packet;
}

export function renderPlanGraphResume(
  model: PlanGraphControlModel,
  options: PlanGraphResumeOptions = {},
): string {
  return stableJson(buildPlanGraphResume(model, options));
}
