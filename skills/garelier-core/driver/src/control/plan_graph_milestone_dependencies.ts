import type { MilestoneRecord } from "./plan_graph_types.ts";

export type MilestoneDependencySource = "depends_on" | "dependency_targets";
export type MilestoneDependencyKind = "milestone" | "backlog" | "missing" | "ambiguous";

export interface MilestoneDependencyEntry {
  source: MilestoneDependencySource;
  raw: string;
  kind: MilestoneDependencyKind;
  target: string | null;
  candidates: string[];
}

const compare = (left: string, right: string): number => left.localeCompare(right);
const BACKLOG_ID = /^W-\d{3,}$/;

function resolveLegacyTarget(
  milestones: ReadonlyMap<string, MilestoneRecord>,
  raw: string,
): Pick<MilestoneDependencyEntry, "kind" | "target" | "candidates"> {
  if (BACKLOG_ID.test(raw)) return { kind: "backlog", target: null, candidates: [] };
  if (milestones.has(raw)) return { kind: "milestone", target: raw, candidates: [raw] };
  const candidates = [...milestones.keys()].filter((slug) => slug.startsWith(`${raw}-`)).sort(compare);
  if (candidates.length === 1) return { kind: "milestone", target: candidates[0]!, candidates };
  if (candidates.length > 1) return { kind: "ambiguous", target: null, candidates };
  return { kind: "missing", target: null, candidates: [] };
}

export function milestoneDependencyEntries(
  milestones: ReadonlyMap<string, MilestoneRecord>,
  record: MilestoneRecord,
): MilestoneDependencyEntry[] {
  return [
    ...record.dependsOn.map((raw): MilestoneDependencyEntry => ({
      source: "depends_on",
      raw,
      kind: milestones.has(raw) ? "milestone" : "missing",
      target: milestones.has(raw) ? raw : null,
      candidates: [],
    })),
    ...record.legacyDependencyTargets.map((raw): MilestoneDependencyEntry => ({
      source: "dependency_targets",
      raw,
      ...resolveLegacyTarget(milestones, raw),
    })),
  ];
}

export function resolvedMilestoneDependencies(
  milestones: ReadonlyMap<string, MilestoneRecord>,
  record: MilestoneRecord,
): string[] {
  return [...new Set(milestoneDependencyEntries(milestones, record)
    .flatMap((entry) => entry.kind === "milestone" && entry.target ? [entry.target] : []))].sort(compare);
}

export function resolveMilestoneDependencySelector(
  milestones: ReadonlyMap<string, MilestoneRecord>,
  raw: string,
): string | null {
  if (milestones.has(raw)) return raw;
  const resolved = resolveLegacyTarget(milestones, raw);
  return resolved.kind === "milestone" ? resolved.target : null;
}
