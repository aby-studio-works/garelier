import type { BacklogRecord, PlanGraphControlModel } from "./plan_graph_types.ts";

export interface BacklogReferenceEvidence {
  reference: string;
  source: "typed-edge" | "title-body";
  snippet: string;
}

export interface MilestoneReferenceEvidence extends BacklogReferenceEvidence {
  milestones: string[];
}

const BARE_BACKLOG = /^W-\d{3,}$/i;
const TYPED_BACKLOG = /^backlog:(W-\d{3,})$/i;
const PROSE_BACKLOG = /\bW-\d{3,}\b/gi;

export function canonicalBacklogReference(reference: string): string {
  return BARE_BACKLOG.test(reference) ? `backlog:${reference.toUpperCase()}` : reference;
}

function backlogId(reference: string): string | null {
  if (BARE_BACKLOG.test(reference)) return reference.toUpperCase();
  return TYPED_BACKLOG.exec(reference)?.[1]?.toUpperCase() ?? null;
}

function compactSnippet(line: string): string {
  const compact = line.trim().replace(/\s+/g, " ");
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
}

/**
 * Direct-author validation is intentionally read-only. When both owner fields
 * are empty, this extracts actionable typed-edge candidates from the Markdown
 * H1/body instead of silently rewriting authority during `control doctor`.
 */
export function proseBacklogReferenceEvidence(record: BacklogRecord): BacklogReferenceEvidence[] {
  const evidence = new Map<string, BacklogReferenceEvidence>();
  for (const line of record.body.split(/\r?\n/)) {
    for (const match of line.matchAll(PROSE_BACKLOG)) {
      const reference = match[0].toUpperCase();
      if (reference === record.id || evidence.has(reference)) continue;
      evidence.set(reference, { reference, source: "title-body", snippet: compactSnippet(line) });
    }
  }
  return [...evidence.values()].sort((left, right) => left.reference.localeCompare(right.reference));
}

export function typedBacklogReferenceEvidence(record: BacklogRecord): BacklogReferenceEvidence[] {
  const evidence = new Map<string, BacklogReferenceEvidence>();
  for (const [field, references] of [["depends_on", record.dependsOn], ["related", record.related]] as const) {
    for (const raw of references) {
      const reference = backlogId(raw);
      if (!reference || reference === record.id || evidence.has(reference)) continue;
      evidence.set(reference, { reference, source: "typed-edge", snippet: `${field} -> ${reference}` });
    }
  }
  return [...evidence.values()].sort((left, right) => left.reference.localeCompare(right.reference));
}

export function milestoneReferenceEvidence(
  model: PlanGraphControlModel,
  references: readonly BacklogReferenceEvidence[],
): MilestoneReferenceEvidence[] {
  const evidence: MilestoneReferenceEvidence[] = [];
  for (const reference of references) {
    const target = model.backlog.get(reference.reference);
    if (!target) continue;
    const milestones = [...new Set(target.milestoneMemberships
      .filter((membership) => membership.state === "active" && model.milestones.has(membership.target))
      .map((membership) => membership.target))]
      .sort((left, right) => left.localeCompare(right));
    if (milestones.length) evidence.push({ ...reference, milestones });
  }
  return evidence;
}

export function milestoneTargetsFromTypedEdges(
  model: PlanGraphControlModel,
  references: readonly string[],
): string[] {
  const evidence: BacklogReferenceEvidence[] = references.flatMap((raw) => {
    const reference = backlogId(raw);
    return reference ? [{ reference, source: "typed-edge" as const, snippet: `typed edge -> ${reference}` }] : [];
  });
  return [...new Set(milestoneReferenceEvidence(model, evidence).flatMap((item) => item.milestones))]
    .sort((left, right) => left.localeCompare(right));
}
