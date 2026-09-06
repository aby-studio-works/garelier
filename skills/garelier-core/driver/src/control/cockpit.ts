import type {
  BacklogRecord,
  CheckpointRecord,
  PlanGraphControlModel,
  PlanGraphFinding,
} from "./plan_graph_types.ts";
import { markdownSections } from "./control_frontmatter.ts";
import { statusText } from "../status_public_control.ts";
import { EVIDENCE_WRITER_STORAGE_KEY } from "./types.ts";

export const DEFAULT_COCKPIT_TOP_N = 10;
export const MAX_COCKPIT_TOP_N = 100;

interface CockpitBacklogSample {
  id: string;
  title: string;
  status: string;
}

interface CockpitIndicator<T> {
  count: number;
  samples: T[];
  truncated: number;
}

export interface ControlCockpit {
  schema_version: 1;
  kind: "control_cockpit";
  control_schema_version: 3;
  storage: "plan_graph_markdown";
  pm_id: string;
  control_revision: string;
  valid: boolean;
  top_n: number;
  counts: {
    open_backlog: number;
    landed_state_drift: number;
    focus_drift: number;
    missing_ac: number;
    legacy_import: number;
    unblocked_ready: number;
    warning: number;
    cleanup: number;
    incident: number;
    bypass: number;
    malformed_rows: number;
  };
  focus: {
    checkpoint_id: string | null;
    backlog_count: number;
    backlog: CockpitBacklogSample[];
    truncated: number;
  };
  indicators: {
    landed_state_drift: CockpitIndicator<CockpitBacklogSample>;
    focus_drift: CockpitIndicator<{
      current_path: string;
      stale_refs: string[];
      stale_ref_count: number;
      stale_refs_truncated: number;
      checkpoint_id: string | null;
      projected_subject: CockpitBacklogSample | null;
    }>;
    missing_ac: CockpitIndicator<CockpitBacklogSample>;
    legacy_import: CockpitIndicator<{ path: string | null; code: string; message: string }>;
    unblocked_ready: CockpitIndicator<CockpitBacklogSample>;
    warning: CockpitIndicator<CockpitBacklogSample>;
    cleanup: CockpitIndicator<CockpitBacklogSample>;
    incident: CockpitIndicator<CockpitBacklogSample>;
    bypass: CockpitIndicator<CockpitBacklogSample>;
    malformed_rows: CockpitIndicator<{ path: string | null; code: string; message: string }>;
  };
}

const TERMINAL_BACKLOG = new Set(["done", "cancelled", "superseded"]);
const COCKPIT_BYTES = {
  id: 128,
  title: 240,
  status: 80,
  path: 320,
  code: 128,
  message: 500,
} as const;
const compareId = (left: BacklogRecord, right: BacklogRecord): number =>
  left.id.localeCompare(right.id, "en");

function sample(record: BacklogRecord): CockpitBacklogSample {
  return {
    id: statusText(record.id, COCKPIT_BYTES.id),
    title: statusText(record.title, COCKPIT_BYTES.title),
    status: statusText(record.status, COCKPIT_BYTES.status),
  };
}

function bounded<T>(items: readonly T[], topN: number): CockpitIndicator<T> {
  return {
    count: items.length,
    samples: items.slice(0, topN),
    truncated: Math.max(0, items.length - topN),
  };
}

function canonicalCheckpoint(model: PlanGraphControlModel): CheckpointRecord | null {
  const current = model.current;
  if (!current) return null;
  const ids = [
    ...(current.primaryCheckpointId ? [current.primaryCheckpointId] : []),
    ...current.checkpointCandidates,
  ];
  for (const id of ids) {
    const checkpoint = model.checkpoints.get(id);
    if (checkpoint && ["active", "paused", "blocked"].includes(checkpoint.status)) return checkpoint;
  }
  return null;
}

function backlogReference(value: string): string {
  return value.replace(/^backlog:/, "");
}

function hasMergeLanding(record: BacklogRecord): boolean {
  const refs = record.frontmatter.evidence_refs;
  if (!Array.isArray(refs)) return false;
  return refs.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const ref = value as Record<string, unknown>;
    const writer = ref[EVIDENCE_WRITER_STORAGE_KEY];
    return ref.kind === "commit"
      && (writer === "garelier-merge-gate"
        || writer === "garelier-ancestry-verifier"
        || writer === "garelier-first-parent-verifier");
  });
}

function hasAcceptanceCriteria(record: BacklogRecord): boolean {
  const body = markdownSections(record.body)
    .find((section) => ["acceptance criteria", "ac"].includes(section.heading.trim().toLowerCase()))?.body;
  if (!body) return false;
  return body.split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\[[ xX]\]\s+/, "")
      .trim())
    .some((line) => line && !/^(?:define acceptance|tbd|none(?: recorded)?)\.?$/i.test(line));
}

function readyAndUnblocked(model: PlanGraphControlModel, record: BacklogRecord): boolean {
  if (record.status !== "ready" || !record.path.startsWith("backlog/open/")) return false;
  if (record.blockedBy.length) return false;
  return record.dependsOn.every((raw) => {
    const dependency = model.backlog.get(backlogReference(raw));
    return dependency !== undefined && TERMINAL_BACKLOG.has(dependency.status);
  });
}

function keyword(records: readonly BacklogRecord[], pattern: RegExp): BacklogRecord[] {
  return records.filter((record) => pattern.test(record.title));
}

function backlogErrors(model: PlanGraphControlModel): PlanGraphFinding[] {
  return model.findings
    .filter((finding) => finding.severity === "error" && finding.path?.startsWith("backlog/"))
    .sort((left, right) =>
      `${left.path ?? ""}\0${left.code}\0${left.message}`.localeCompare(
        `${right.path ?? ""}\0${right.code}\0${right.message}`,
        "en",
      ));
}

export function buildControlCockpit(
  model: PlanGraphControlModel,
  pmId: string,
  topN = DEFAULT_COCKPIT_TOP_N,
): ControlCockpit {
  if (!Number.isInteger(topN) || topN < 1 || topN > MAX_COCKPIT_TOP_N) {
    throw new Error(`cockpit top_n must be an integer from 1 to ${MAX_COCKPIT_TOP_N}`);
  }
  const open = [...model.backlog.values()]
    .filter((record) => record.path.startsWith("backlog/open/") && !TERMINAL_BACKLOG.has(record.status))
    .sort(compareId);
  const landed = open.filter((record) => hasMergeLanding(record) && record.status !== "verification");
  const missingAc = open.filter((record) => !hasAcceptanceCriteria(record));
  const ready = open.filter((record) => readyAndUnblocked(model, record));
  const warnings = keyword(open, /\bwarning(?:s)?\b|警告/i);
  const cleanup = keyword(open, /\bclean[- ]?up\b|cleanup|掃除/i);
  const incidents = keyword(open, /\bincident(?:s)?\b|障害/i);
  const bypass = keyword(open, /\bbypass(?:ed)?\b|迂回/i);
  const malformed = backlogErrors(model);
  const legacyTitleRows = open
    .filter((record) => !record.titleCanonical)
    .map((record) => ({
      path: statusText(record.path, COCKPIT_BYTES.path),
      code: "backlog-title-legacy",
      message: statusText(
        `legacy H1 must migrate to "# ${record.id}: ${record.title}"`,
        COCKPIT_BYTES.message,
      ),
    }));
  const legacyParseErrors = malformed
    .filter((finding) => finding.code === "store-parse-error")
    .map((finding) => ({
      path: finding.path === null ? null : statusText(finding.path, COCKPIT_BYTES.path),
      code: statusText(finding.code, COCKPIT_BYTES.code),
      message: statusText(finding.message, COCKPIT_BYTES.message),
    }));
  const legacy = [...legacyTitleRows, ...legacyParseErrors]
    .sort((left, right) =>
      `${left.path ?? ""}\0${left.code}\0${left.message}`.localeCompare(
        `${right.path ?? ""}\0${right.code}\0${right.message}`,
        "en",
      ));

  const checkpoint = canonicalCheckpoint(model);
  const focusRows = (checkpoint?.backlog ?? [])
    .flatMap((id) => model.backlog.get(backlogReference(id)) ?? []);
  const focusRefs = new Set([
    ...(checkpoint ? [checkpoint.id] : []),
    ...focusRows.map((record) => record.id),
  ]);
  const currentRefs = [...new Set(model.current?.currentPosition.match(/\b(?:CP|W)-\d+\b/g) ?? [])].sort();
  const staleRefs = currentRefs.filter((id) => !focusRefs.has(id));
  const focusDrift = staleRefs.length && model.current
    ? [{
      current_path: statusText(model.current.path, COCKPIT_BYTES.path),
      stale_refs: staleRefs.slice(0, topN).map((id) => statusText(id, COCKPIT_BYTES.id)),
      stale_ref_count: staleRefs.length,
      stale_refs_truncated: Math.max(0, staleRefs.length - topN),
      checkpoint_id: checkpoint ? statusText(checkpoint.id, COCKPIT_BYTES.id) : null,
      projected_subject: focusRows[0] ? sample(focusRows[0]) : null,
    }]
    : [];
  const malformedSamples = malformed.map((finding) => ({
    path: finding.path === null ? null : statusText(finding.path, COCKPIT_BYTES.path),
    code: statusText(finding.code, COCKPIT_BYTES.code),
    message: statusText(finding.message, COCKPIT_BYTES.message),
  }));
  const indicators = {
    landed_state_drift: bounded(landed.map(sample), topN),
    focus_drift: bounded(focusDrift, topN),
    missing_ac: bounded(missingAc.map(sample), topN),
    legacy_import: bounded(legacy, topN),
    unblocked_ready: bounded(ready.map(sample), topN),
    warning: bounded(warnings.map(sample), topN),
    cleanup: bounded(cleanup.map(sample), topN),
    incident: bounded(incidents.map(sample), topN),
    bypass: bounded(bypass.map(sample), topN),
    malformed_rows: bounded(malformedSamples, topN),
  };
  return {
    schema_version: 1,
    kind: "control_cockpit",
    control_schema_version: 3,
    storage: "plan_graph_markdown",
    pm_id: statusText(pmId, COCKPIT_BYTES.id),
    control_revision: statusText(model.revision, COCKPIT_BYTES.id),
    valid: !model.findings.some((finding) => finding.severity === "error"),
    top_n: topN,
    counts: {
      open_backlog: open.length,
      landed_state_drift: indicators.landed_state_drift.count,
      focus_drift: indicators.focus_drift.count,
      missing_ac: indicators.missing_ac.count,
      legacy_import: indicators.legacy_import.count,
      unblocked_ready: indicators.unblocked_ready.count,
      warning: indicators.warning.count,
      cleanup: indicators.cleanup.count,
      incident: indicators.incident.count,
      bypass: indicators.bypass.count,
      malformed_rows: indicators.malformed_rows.count,
    },
    focus: {
      checkpoint_id: checkpoint ? statusText(checkpoint.id, COCKPIT_BYTES.id) : null,
      backlog_count: focusRows.length,
      backlog: focusRows.slice(0, topN).map(sample),
      truncated: Math.max(0, focusRows.length - topN),
    },
    indicators,
  };
}

export function renderControlCockpit(cockpit: ControlCockpit): string {
  const countOrder: Array<keyof ControlCockpit["counts"]> = [
    "open_backlog",
    "landed_state_drift",
    "focus_drift",
    "missing_ac",
    "legacy_import",
    "unblocked_ready",
    "warning",
    "cleanup",
    "incident",
    "bypass",
    "malformed_rows",
  ];
  const lines = [
    `control cockpit: ${cockpit.valid ? "valid" : "INVALID"} revision ${cockpit.control_revision}`,
    `focus: ${cockpit.focus.checkpoint_id ?? "-"} (${cockpit.focus.backlog_count} backlog)`,
    ...cockpit.focus.backlog.map((record) => `  ${record.id}: ${record.title} [${record.status}]`),
    ...countOrder.map((key) => `${key}: ${cockpit.counts[key]}`),
  ];
  for (const key of Object.keys(cockpit.indicators) as Array<keyof ControlCockpit["indicators"]>) {
    const indicator = cockpit.indicators[key];
    for (const item of indicator.samples) {
      if ("id" in item) lines.push(`  ${key}: ${item.id}: ${item.title} [${item.status}]`);
      else if ("stale_refs" in item) lines.push(`  ${key}: ${item.stale_refs.join(", ")} -> ${item.checkpoint_id ?? "-"}/${item.projected_subject?.id ?? "-"}`);
      else lines.push(`  ${key}: ${item.path ?? "-"}: ${item.code}: ${item.message}`);
    }
    if (indicator.truncated) lines.push(`  ${key}: +${indicator.truncated} more`);
  }
  return `${lines.join("\n")}\n`;
}
