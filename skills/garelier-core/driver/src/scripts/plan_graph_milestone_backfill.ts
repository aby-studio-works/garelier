#!/usr/bin/env bun
import { loadPlanGraphModel } from "../control/plan_graph_model.ts";
import {
  milestoneReferenceEvidence,
  proseBacklogReferenceEvidence,
  typedBacklogReferenceEvidence,
  type MilestoneReferenceEvidence,
} from "../control/plan_graph_milestone_inheritance.ts";
import type { BacklogRecord, PlanGraphControlModel } from "../control/plan_graph_types.ts";
import { parseControlFrontmatter } from "../control/control_frontmatter.ts";
import { readCanonicalControlBinding } from "../control/generation.ts";
import { resolveControlRoots } from "../control/roots.ts";
import { assertSessionControlBinding, readControlSession } from "../control/sessions.ts";
import { planGraphTransactionCallbacks } from "../control/plan_graph_write.ts";
import {
  resolveControlNamespace,
  runControlFilePlanTransaction,
  type ControlTransactionResult,
  type PlannedControlWrite,
} from "../control/transaction.ts";
import { canonicalJson } from "../control/serialization.ts";

export interface MilestoneBackfillProposal {
  row_id: string;
  path: string;
  candidate_milestones: string[];
  evidence: MilestoneReferenceEvidence[];
}

export interface MilestoneBackfillReport {
  schema_version: 1;
  kind: "garelier_plan_graph_milestone_backfill";
  control_revision: string;
  proposals: MilestoneBackfillProposal[];
}

export interface ApplyMilestoneBackfillOptions {
  targetRoot: string;
  pmId: string;
  controlRoot?: string;
  runtimeRoot?: string;
  sessionId: string;
  expectedControlRevision: string;
  now?: () => Date;
}

function proposalFor(model: PlanGraphControlModel, record: BacklogRecord): MilestoneBackfillProposal | null {
  if (record.milestone === "none" || !record.inheritMilestones
    || record.milestoneMemberships.some((membership) => membership.state === "active")) return null;
  const typed = typedBacklogReferenceEvidence(record);
  const prose = proseBacklogReferenceEvidence(record);
  const references = [...typed, ...prose.filter((candidate) =>
    !typed.some((existing) => existing.reference === candidate.reference))];
  const evidence = milestoneReferenceEvidence(model, references);
  const candidateMilestones = [...new Set(evidence.flatMap((item) => item.milestones))]
    .sort((left, right) => left.localeCompare(right));
  if (!candidateMilestones.length) return null;
  return {
    row_id: record.id,
    path: record.path,
    candidate_milestones: candidateMilestones,
    evidence,
  };
}

function reportForModel(model: PlanGraphControlModel): MilestoneBackfillReport {
  const error = model.findings.find((finding) => finding.severity === "error");
  if (error) throw new Error(`schema-3 strict validation failed: ${error.code}: ${error.message}`);
  const proposals = [...model.backlog.values()]
    .map((record) => proposalFor(model, record))
    .filter((proposal): proposal is MilestoneBackfillProposal => proposal !== null)
    .sort((left, right) => left.row_id.localeCompare(right.row_id));
  return {
    schema_version: 1,
    kind: "garelier_plan_graph_milestone_backfill",
    control_revision: model.revision,
    proposals,
  };
}

export function createMilestoneBackfillReport(controlRoot: string): MilestoneBackfillReport {
  return reportForModel(loadPlanGraphModel(controlRoot));
}

function maxRelationNumber(record: BacklogRecord): number {
  return [...record.milestoneMemberships, ...record.viewMemberships].reduce((maximum, relation) => {
    const value = Number(/^rel-(\d+)$/.exec(relation.relationId)?.[1] ?? 0);
    return Math.max(maximum, value);
  }, 0);
}

/**
 * Insert new TOML array-table blocks immediately before the closing delimiter.
 * No serializer is used: every pre-existing frontmatter byte and the complete
 * Markdown body remain byte-identical.
 */
export function insertMilestoneMemberships(
  record: BacklogRecord,
  milestones: readonly string[],
  now: string,
): string {
  if (!milestones.length) return record.source;
  const parsed = parseControlFrontmatter(record.source, record.path);
  const openingEnd = record.source.indexOf("\n") + 1;
  const closingStart = openingEnd + parsed.frontmatterSource.length;
  const newline = record.source.includes("\r\n") ? "\r\n" : "\n";
  let relationNumber = maxRelationNumber(record);
  const blocks = milestones.map((slug) => {
    relationNumber++;
    return [
      "[[milestone_memberships]]",
      `id = "rel-${String(relationNumber).padStart(3, "0")}"`,
      `slug = "${slug}"`,
      'state = "active"',
      `added = "${now}"`,
      `updated = "${now}"`,
      'relation = "inherited"',
    ].join(newline);
  });
  const prefix = record.source.slice(0, closingStart);
  const separator = prefix.endsWith(newline) ? newline : `${newline}${newline}`;
  const insertion = `${separator}${blocks.join(`${newline}${newline}`)}${newline}`;
  return `${prefix}${insertion}${record.source.slice(closingStart)}`;
}

function writesFor(model: PlanGraphControlModel, now: string): PlannedControlWrite[] {
  return reportForModel(model).proposals.map((proposal) => {
    const record = model.backlog.get(proposal.row_id)!;
    return {
      path: record.path,
      source: insertMilestoneMemberships(record, proposal.candidate_milestones, now),
    };
  });
}

export function applyMilestoneBackfill(options: ApplyMilestoneBackfillOptions): ControlTransactionResult {
  const paths = resolveControlNamespace(options);
  const session = readControlSession(paths, options.sessionId);
  assertSessionControlBinding(session, readCanonicalControlBinding(paths.controlRoot));
  return runControlFilePlanTransaction({
    ...options,
    agent: session.agent,
    command: "plan-graph-milestone-backfill",
    callbacks: planGraphTransactionCallbacks,
    mutate: ({ state, now }) => ({
      summary: "backfill inherited schema-3 Backlog milestone memberships",
      writes: writesFor(state, now),
    }),
  });
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function runMilestoneBackfillCli(argv: string[], cwd = process.cwd()): CliResult {
  try {
    let project = cwd;
    let pmId = "_workshop";
    let sessionId: string | undefined;
    let expectedControlRevision: string | undefined;
    let apply = false;
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index]!;
      if (arg === "--project") { project = valueAfter(argv, index, arg); index++; }
      else if (arg === "--pm-id") { pmId = valueAfter(argv, index, arg); index++; }
      else if (arg === "--session") { sessionId = valueAfter(argv, index, arg); index++; }
      else if (arg === "--expect-control-revision") { expectedControlRevision = valueAfter(argv, index, arg); index++; }
      else if (arg === "--apply") apply = true;
      else if (arg === "--help" || arg === "-h") {
        return {
          code: 0,
          stdout: "usage: plan_graph_milestone_backfill.ts [--project <root>] [--pm-id <id>] [--apply --session <id> --expect-control-revision <sha>]\n",
          stderr: "",
        };
      } else throw new Error(`unknown argument: ${arg}`);
    }
    const roots = resolveControlRoots(project, pmId);
    const report = createMilestoneBackfillReport(roots.controlRoot);
    if (!apply) return { code: 0, stdout: canonicalJson({ ...report, mode: "dry-run" }), stderr: "" };
    if (!sessionId || !expectedControlRevision) {
      throw new Error("--apply requires --session and --expect-control-revision from the reviewed dry-run");
    }
    const transaction = applyMilestoneBackfill({
      targetRoot: roots.targetRoot,
      controlRoot: roots.controlRoot,
      runtimeRoot: roots.runtimeRoot,
      pmId,
      sessionId,
      expectedControlRevision,
    });
    return { code: 0, stdout: canonicalJson({ ...report, mode: "apply", transaction }), stderr: "" };
  } catch (error) {
    return { code: 1, stdout: "", stderr: `plan_graph_milestone_backfill: ${(error as Error).message}\n` };
  }
}

if (import.meta.main) {
  const result = runMilestoneBackfillCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
