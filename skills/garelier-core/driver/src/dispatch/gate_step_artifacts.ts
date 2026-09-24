/**
 * gate_step_artifacts.ts — the ONE definition of the durable gate artifacts a
 * land run leaves inside a dispatch container's `lane/`, and of where they are
 * preserved before the container is removed (W-741).
 *
 * WHY a separate module. `land_aftercare.ts` deliberately does NOT admit the
 * pm-step gate log into its lane allowlist: admitting it would let aftercare
 * DELETE the PM's 4th-step gate evidence with the rest of the container. Its
 * class is "durable, with an owner that MOVES it out first". That contract only
 * holds while every caller that removes a container actually is such an owner.
 * It was not: `land_pipeline.ts` stage 10 preserved the log, but a bare
 * `dispatch_cleanup.ts --request-id …` — the command the PM runs by hand, and
 * the one the field manual names — did not, so aftercare refused on the log the
 * pipeline itself had written and the PM passed `--force-remove` every time
 * (#605, 2026-09-05: two `gate-step4-*.log` entries refused, then forced).
 * `--force-remove` is an override for a dirty worktree or an unmerged branch; it
 * is not a way past evidence, and reaching for it by routine erases the line
 * between the two.
 *
 * So the naming convention and the preservation live HERE, imported by the
 * writer (`land_pipeline.ts`) and by both removers. A hand-copied `gate-step4-`
 * literal on either side agrees on the day it is written and nothing keeps it
 * agreeing; a drift in the WRITER's spelling silently returns the refusal, and a
 * drift in a REMOVER's spelling silently deletes the evidence.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { assertSafeLeaf, rmSync, rmdirSync, writeGuardedFileSync } from "../guard/path_guard.ts";
import { MIN_PRESERVED_ARTIFACT_MAX_BYTES } from "../config.ts";
import { canonicalJson, sha256 } from "../control/serialization.ts";
import { atomicWriteRuntimeFile } from "../control/diagnostics.ts";
import {
  gateRunRecordPath,
  readGateRunRecord,
  type GateRunPreservationRecord,
} from "./gate_run_record.ts";
import {
  digestReviewEvidence,
  dockReviewRecordPath,
  readDockReviewHandoffRecord,
  reviewEvidenceKey,
  verifyDockReviewHandoffRecord,
  type DockReviewHandoffRecord,
} from "./dock_review_record.ts";
import {
  evaluatePreservationAdmission,
  inspectableText,
  preservationAdmissionBytes,
  type PreservationAdmissionBinding,
} from "./preservation_admission.ts";

export const DEFAULT_PRESERVED_ARTIFACT_MAX_BYTES = 64 * 1024;

/** Durable, bounded face of the PM-selected step-4 stream. Unlike a runner
 * record, this stream is intentionally operator-readable: retain its digest,
 * beginning, every RESULT line, and its tail while the complete bytes live in
 * runtime preservation. */
export function summarizePmStepGateLog(
  raw: Buffer,
  runtimePath: string,
  structuredSummary: string,
  maxBytes = DEFAULT_PRESERVED_ARTIFACT_MAX_BYTES,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_PRESERVED_ARTIFACT_MAX_BYTES) {
    throw new Error(`preserved_artifact_bound_too_small: preserved artifact limit must be at least ${MIN_PRESERVED_ARTIFACT_MAX_BYTES} bytes (got ${maxBytes})`);
  }
  const lines = raw.toString("utf8").replaceAll("\r\n", "\n").split("\n");
  const clipped = (line: string): string => line.length > 1024 ? `${line.slice(0, 1024)}…` : line;
  const head = lines.slice(0, 32).map(clipped);
  const results = lines.filter((line) => /^RESULT(?:\s|$)/.test(line)).map(clipped);
  const tail = lines.slice(-128).map(clipped);
  const mandatory = [
    "PM_STEP_LOG_SUMMARY",
    `SHA256 ${sha256(raw).replace(/^sha256:/, "")}`,
    `BYTE_LENGTH ${raw.byteLength}`,
    `RAW_RUNTIME_PATH ${runtimePath.replaceAll("\\", "/")}`,
  ];
  const sections = [
    ...mandatory,
    "HEAD_BEGIN", ...head, "HEAD_END",
    "RESULT_LINES_BEGIN", ...results, "RESULT_LINES_END",
    "TAIL_BEGIN", ...tail, "TAIL_END",
    "RUNNER_SUMMARY_BEGIN", ...structuredSummary.trimEnd().split("\n"), "RUNNER_SUMMARY_END", "",
  ];
  while (Buffer.byteLength(sections.join("\n"), "utf8") > maxBytes) {
    const runnerStart = sections.indexOf("RUNNER_SUMMARY_BEGIN");
    const runnerEnd = sections.indexOf("RUNNER_SUMMARY_END");
    if (runnerEnd - runnerStart > 2) { sections.splice(runnerStart + 1, 1); continue; }
    const tailStart = sections.indexOf("TAIL_BEGIN");
    const tailEnd = sections.indexOf("TAIL_END");
    if (tailEnd - tailStart > 2) { sections.splice(tailStart + 1, 1); continue; }
    const headStart = sections.indexOf("HEAD_BEGIN");
    const headEnd = sections.indexOf("HEAD_END");
    if (headEnd - headStart > 2) { sections.splice(headEnd - 1, 1); continue; }
    break;
  }
  if (Buffer.byteLength(sections.join("\n"), "utf8") > maxBytes) {
    return [...mandatory, `PRESERVED_SUMMARY_TRUNCATED max_bytes=${maxBytes}`, ""].join("\n");
  }
  return sections.join("\n");
}

/**
 * Produce the tool-neutral durable face of a gate run (W-810). Its denominator
 * is the structured event record gate_runner writes while it emits each event;
 * the mixed raw stream is never parsed. Child stdout therefore cannot become a
 * runner marker even when it exactly spells the marker grammar. Failed stdout
 * remains useful as an explicitly encoded, bounded tail.
 */
export function summarizeGateRunForPreservation(
  source: GateRunPreservationRecord,
  runtimePath: string,
  maxBytes = DEFAULT_PRESERVED_ARTIFACT_MAX_BYTES,
  admission?: { projectRoot: string; pmId: string; binding: PreservationAdmissionBinding },
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_PRESERVED_ARTIFACT_MAX_BYTES) {
    throw new Error(
      `preserved_artifact_bound_too_small: preserved artifact limit must be at least ` +
      `${MIN_PRESERVED_ARTIFACT_MAX_BYTES} bytes (got ${maxBytes})`,
    );
  }
  const pointer = `RAW_RUNTIME_PATH ${runtimePath.replace(/\\/g, "/")}`;
  const failedSteps = source.failed_steps.map((step) => ({
    ...step,
    output_tail: [...step.output_tail],
  }));
  let redactionCount = 0;
  const redactionClasses = new Set<string>();
  const redactionFindings = new Set<string>();
  if (admission) {
    const sources = failedSteps.flatMap((step, stepIndex) => step.output_tail.map((line, lineIndex) => ({
      kind: "gate_run_record" as const,
      sourcePath: `failed-step-tail/${stepIndex + 1}/${lineIndex + 1}.txt`,
      bytes: Buffer.from(line, "utf8"),
    })));
    if (sources.length > 0) {
      const decision = evaluatePreservationAdmission({ ...admission, sources });
      const artifacts = new Map(decision.artifacts.map((artifact) => [artifact.source_path, artifact]));
      for (let stepIndex = 0; stepIndex < failedSteps.length; stepIndex += 1) {
        const step = failedSteps[stepIndex]!;
        step.output_tail = step.output_tail.map((line, lineIndex) => {
          const artifact = artifacts.get(`failed-step-tail/${stepIndex + 1}/${lineIndex + 1}.txt`);
          if (!artifact || artifact.decision === "CLEAN") return line;
          redactionCount += 1;
          const classes = [...new Set(artifact.findings.map((finding) => finding.finding_id))].sort();
          artifact.findings.forEach((finding) => {
            redactionClasses.add(finding.dimension);
            redactionFindings.add(finding.finding_id);
          });
          return `[redacted: ${classes.join(",")}]`;
        });
      }
    }
  }
  const redactionSummary = (): string | null => redactionCount > 0
    ? `REDACTION count=${redactionCount} classes=${[...redactionClasses].sort().join(",")} findings=${[...redactionFindings].sort().join(",")}`
    : null;
  const render = (bounded: boolean): string => {
    const kept = [...source.events];
    for (const step of failedSteps) {
      kept.push(
        `FAILED_STEP_OUTPUT_TAIL name=${step.name} exit=${step.exit} lines=${step.output_tail.length} truncated=${step.output_truncated}`,
        ...step.output_tail.map((line) => `OUTPUT ${JSON.stringify(line)}`),
        "END_FAILED_STEP_OUTPUT_TAIL",
      );
    }
    const redaction = redactionSummary();
    if (redaction) kept.push(redaction);
    if (bounded) kept.push(`PRESERVED_SUMMARY_TRUNCATED max_bytes=${maxBytes}`);
    return [...kept, pointer, ""].join("\n");
  };
  const full = render(false);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return full;

  // The declared artifact limit is the only byte bound. Remove the globally
  // oldest failed-step lines first, updating each step's own truncation claim;
  // later failures and the terminal line therefore cannot be starved by an
  // earlier step. Runner-owned structural events remain intact.
  let bounded = render(true);
  while (Buffer.byteLength(bounded, "utf8") > maxBytes) {
    const oldest = failedSteps.find((step) => step.output_tail.length > 0);
    if (!oldest) break;
    oldest.output_tail.shift();
    oldest.output_truncated = true;
    bounded = render(true);
  }
  if (Buffer.byteLength(bounded, "utf8") <= maxBytes) return bounded;

  // Extremely small custom limits may not fit even runner structure. Preserve
  // the newest structural events and the runtime pointer under the same bound.
  const events = [...source.events];
  while (events.length > 0) {
    events.shift();
    const fallback = [
      ...events,
      ...(redactionSummary() ? [redactionSummary()!] : []),
      `PRESERVED_SUMMARY_TRUNCATED max_bytes=${maxBytes}`,
      pointer,
      "",
    ].join("\n");
    if (Buffer.byteLength(fallback, "utf8") <= maxBytes) return fallback;
  }
  const mandatoryFace = [
    ...(redactionSummary() ? [redactionSummary()!] : []),
    `PRESERVED_SUMMARY_TRUNCATED max_bytes=${maxBytes}`, pointer, "",
  ].join("\n");
  if (Buffer.byteLength(mandatoryFace, "utf8") > maxBytes) {
    throw new Error(
      `preserved_artifact_bound_too_small: mandatory summary face exceeds ${maxBytes} bytes for ${runtimePath}`,
    );
  }
  return mandatoryFace;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface GateRuntimeEvidenceEntry {
  path: string;
  relativePath: string;
  mtimeMs: number;
  pinned: boolean;
}

export interface GateRuntimeRetentionOutcome {
  totalBefore: number;
  protected: string[];
  pruned: string[];
  keepDays: number;
  keepFiles: number;
}

function pathWithin(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !/^[/\\]/.test(rel));
}

function addJournalPin(
  raw: unknown,
  project: string,
  pmId: string,
  dispatchIds: Set<string>,
  containers: Set<string>,
): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const journal = raw as Record<string, unknown>;
  if (journal.kind !== "garelier_land_aftercare_journal" || typeof journal.state !== "string") return false;
  const plan = journal.plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
  const record = plan as Record<string, unknown>;
  if (record.pm_id !== pmId || resolve(String(record.project_root ?? "")) !== resolve(project)) return false;
  if (journal.state === "views_refreshed" || journal.state === "container_removed") return true;
  if (typeof record.dispatch_id === "string" && /^\d+$/.test(record.dispatch_id)) {
    dispatchIds.add(record.dispatch_id);
  }
  if (typeof record.container === "string" && record.container.trim() !== "") {
    containers.add(resolve(record.container));
  }
  return true;
}

/** Read the latest append-only journal revisions only to derive retention pins.
 * Any unreadable/malformed authority disables this sweep: retention may leak
 * bytes rather than guessing that live evidence is disposable. */
function collectAftercarePins(
  project: string,
  pmId: string,
  dispatchIds: Set<string>,
  containers: Set<string>,
): boolean {
  const root = join(project, "__garelier", pmId, "runtime", "land_aftercare", "journals");
  if (!existsSync(root)) return true;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return false; }
  const revisionStems = new Set(entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".json.revisions"))
    .map((entry) => entry.name.slice(0, -".revisions".length)));
  for (const entry of entries) {
    let authority: string | null = null;
    if (entry.isDirectory() && entry.name.endsWith(".json.revisions")) {
      const revisions = join(root, entry.name);
      let names: string[];
      try { names = readdirSync(revisions).filter((name) => /^\d{12}\.json$/.test(name)).sort(); }
      catch { return false; }
      if (names.length === 0) return false;
      authority = join(revisions, names.at(-1)!);
    } else if (entry.isFile() && entry.name.endsWith(".json") && !revisionStems.has(entry.name)) {
      authority = join(root, entry.name);
    } else {
      continue;
    }
    try {
      if (!addJournalPin(JSON.parse(readFileSync(authority, "utf8")), project, pmId, dispatchIds, containers)) {
        return false;
      }
    } catch { return false; }
  }
  return true;
}

/** Write-time owner for raw gate evidence (W-810). The age and count windows
 * share one denominator: unpinned regular files across `preserved_raw/` and
 * `run_records/`. An existing dispatch container or a non-terminal aftercare
 * journal pins its evidence. Invalid journals/records fail closed by skipping
 * deletion, never by treating unknown evidence as stale. */
export function pruneGateRuntimeEvidence(options: {
  project: string;
  pmId: string;
  keepDays: number;
  keepFiles: number;
  nowMs?: number;
}): GateRuntimeRetentionOutcome {
  const project = resolve(options.project);
  const outcome: GateRuntimeRetentionOutcome = {
    totalBefore: 0, protected: [], pruned: [],
    keepDays: options.keepDays, keepFiles: options.keepFiles,
  };
  if (!Number.isFinite(options.keepDays) || options.keepDays <= 0
    || !Number.isFinite(options.keepFiles) || options.keepFiles <= 0) return outcome;

  const pmRoot = join(project, "__garelier", options.pmId);
  const activeDispatchIds = new Set<string>();
  const activeContainers = new Set<string>();
  const crew = join(pmRoot, "_crew");
  if (existsSync(crew)) {
    try {
      for (const entry of readdirSync(crew, { withFileTypes: true })) {
        const match = /^dispatch(\d+)$/.exec(entry.name);
        if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        activeDispatchIds.add(match[1]!);
        activeContainers.add(resolve(crew, entry.name));
      }
    } catch { return outcome; }
  }
  if (!collectAftercarePins(project, options.pmId, activeDispatchIds, activeContainers)) return outcome;

  const evidence: GateRuntimeEvidenceEntry[] = [];
  const addFile = (path: string, relativePath: string, pinned: boolean): void => {
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) return;
      evidence.push({ path, relativePath, mtimeMs: info.mtimeMs, pinned });
    } catch { /* raced away; the next write-time sweep sees the remaining set */ }
  };

  const rawRoot = join(pmRoot, "runtime", "gate", "preserved_raw");
  if (existsSync(rawRoot)) {
    let dispatchDirs;
    try { dispatchDirs = readdirSync(rawRoot, { withFileTypes: true }); }
    catch { return outcome; }
    for (const dispatchDir of dispatchDirs) {
      const match = /^dispatch(\d+)$/.exec(dispatchDir.name);
      if (!match || !dispatchDir.isDirectory() || dispatchDir.isSymbolicLink()) continue;
      const dir = join(rawRoot, dispatchDir.name);
      let leaves;
      try { leaves = readdirSync(dir, { withFileTypes: true }); }
      catch { return outcome; }
      for (const leaf of leaves) {
        if (!leaf.isFile() || leaf.isSymbolicLink()) continue;
        addFile(join(dir, leaf.name), relative(project, join(dir, leaf.name)).replaceAll("\\", "/"), activeDispatchIds.has(match[1]!));
      }
    }
  }

  const recordsRoot = join(pmRoot, "runtime", "gate", "run_records");
  if (existsSync(recordsRoot)) {
    let leaves;
    try { leaves = readdirSync(recordsRoot, { withFileTypes: true }); }
    catch { return outcome; }
    for (const leaf of leaves) {
      if (!leaf.isFile() || leaf.isSymbolicLink()) continue;
      const path = join(recordsRoot, leaf.name);
      const record = readGateRunRecord(path);
      let pinned = record === null;
      if (record !== null) {
        try { pinned = [...activeContainers].some((container) => pathWithin(record.log, container)); }
        catch { pinned = true; }
      }
      addFile(path, relative(project, path).replaceAll("\\", "/"), pinned);
    }
  }

  outcome.totalBefore = evidence.length;
  outcome.protected = evidence.filter((entry) => entry.pinned).map((entry) => entry.relativePath).sort();
  const unpinned = evidence.filter((entry) => !entry.pinned)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.relativePath.localeCompare(right.relativePath));
  const keepByCount = new Set(unpinned.slice(0, Math.floor(options.keepFiles)).map((entry) => entry.path));
  const cutoff = (options.nowMs ?? Date.now()) - options.keepDays * MS_PER_DAY;
  for (const entry of unpinned) {
    if (entry.mtimeMs >= cutoff && keepByCount.has(entry.path)) continue;
    try {
      const current = lstatSync(entry.path);
      if (current.isSymbolicLink() || !current.isFile()) continue;
      rmSync(entry.path, { force: false });
      outcome.pruned.push(entry.relativePath);
    } catch { /* retention cannot invalidate the write that triggered it */ }
  }
  if (existsSync(rawRoot)) {
    try {
      for (const entry of readdirSync(rawRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const dir = join(rawRoot, entry.name);
        if (readdirSync(dir).length === 0) rmdirSync(dir);
      }
    } catch { /* empty-directory cleanup is optional */ }
  }
  outcome.pruned.sort();
  return outcome;
}

export interface GateLogRecoveryArtifact {
  source_path: string;
  archive_path: string;
  content_hash: string;
  byte_length: number;
  sealed_content_hash: string | null;
}

export interface GateLogRecoveryArchive {
  schema_version: 1;
  kind: "garelier_gate_log_recovery_archive";
  generated_by: "review_prepare.ts";
  recovery_id: string;
  archived_at: string;
  dispatch_id: string;
  review_sha: string;
  canonical_log: string;
  finding_id: string;
  artifacts: GateLogRecoveryArtifact[];
}

export interface GateLogRecoveryReceipt {
  schema_version: 1;
  kind: "garelier_gate_log_recovery_replacement";
  generated_by: "review_prepare.ts";
  recovery_id: string;
  sealed_at: string;
  dispatch_id: string;
  review_sha: string;
  archive_manifest: string;
  archive_manifest_hash: string;
  canonical_log: string;
  canonical_log_hash: string;
  gate_run_record: string;
  gate_run_record_hash: string;
  dock_review_record: string;
  dock_review_record_hash: string;
  gate_run_id: string;
}

function recoveryRawRoot(project: string, pmId: string, dispatchId: string): string {
  if (!/^\d+$/.test(dispatchId)) throw new Error(`gate log recovery requires a numeric dispatch id: ${dispatchId}`);
  return resolve(project, "__garelier", pmId, "runtime", "gate", "preserved_raw", `dispatch${dispatchId}`);
}

function recoveryArtifactName(recoveryId: string, index: number, source: string): string {
  const leaf = basename(source).replace(/[^A-Za-z0-9._-]/g, "_");
  return `recovery-${recoveryId}-${String(index + 1).padStart(2, "0")}-${leaf}`;
}

function readRecoveryArchive(path: string): GateLogRecoveryArchive | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GateLogRecoveryArchive;
    if (parsed.schema_version !== 1 || parsed.kind !== "garelier_gate_log_recovery_archive"
      || parsed.generated_by !== "review_prepare.ts" || !Array.isArray(parsed.artifacts)
      || !/^\d+$/.test(parsed.dispatch_id) || !/^[0-9a-f]{40}$/.test(parsed.review_sha)
      || typeof parsed.recovery_id !== "string" || typeof parsed.canonical_log !== "string"
      || typeof parsed.finding_id !== "string") return null;
    return parsed;
  } catch { return null; }
}

function readRecoveryReceipt(path: string): GateLogRecoveryReceipt | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GateLogRecoveryReceipt;
    if (parsed.schema_version !== 1 || parsed.kind !== "garelier_gate_log_recovery_replacement"
      || parsed.generated_by !== "review_prepare.ts" || !/^\d+$/.test(parsed.dispatch_id)
      || !/^[0-9a-f]{40}$/.test(parsed.review_sha) || typeof parsed.recovery_id !== "string") return null;
    return parsed;
  } catch { return null; }
}

function recoveryReceiptPath(archiveManifest: string): string {
  if (!archiveManifest.endsWith("-archive.json")) throw new Error(`gate log recovery archive name is invalid: ${archiveManifest}`);
  return archiveManifest.slice(0, -"-archive.json".length) + "-replacement.json";
}

function invalidRecoveryReceiptPath(path: string, bytes: Buffer): string {
  const hash = sha256(bytes).slice("sha256:".length, "sha256:".length + 12);
  return `${path.slice(0, -".json".length)}.invalid-${hash}.json`;
}

function assertCompleteRecoveryDockHandoff(options: {
  record: DockReviewHandoffRecord;
  dispatchId: string;
  reviewSha: string;
  canonicalLog: string;
  gateRunRecord: string;
}): void {
  const lane = dirname(resolve(options.canonicalLog));
  const scannerEvidence = join(lane, `scanner-${options.reviewSha.slice(0, 12)}.md`);
  const verification = verifyDockReviewHandoffRecord({
    record: options.record,
    dispatchId: options.dispatchId,
    branch: options.record.branch,
    baseSha: options.record.base_sha,
    reviewSha: options.reviewSha,
    evidence: [
      join(lane, "secret-scan.md"),
      scannerEvidence,
      `${scannerEvidence}.json`,
      options.canonicalLog,
      join(lane, "final_accounting.md"),
      options.gateRunRecord,
    ],
  });
  if (!verification.ok) {
    throw new Error(`gate log recovery fresh Dock handoff is invalid: ${verification.reason}`);
  }
}

const MAX_GATE_LOG_RECOVERY_ARTIFACT_BYTES = 4 * 1024 * 1024;

/**
 * Verify the immutable half of one same-SHA recovery in full. This is the one
 * archive predicate used before original sources are retired, before a fresh
 * replacement is sealed, and again when cleanup admits the receipt. Keeping
 * all three callers on the same predicate prevents a receipt from outliving a
 * deleted or rewritten archive payload.
 */
function verifiedGateLogRecoveryArchive(options: {
  project: string;
  pmId: string;
  dispatchId: string;
  reviewSha: string;
  archiveManifest: string;
  canonicalLog: string;
}): GateLogRecoveryArchive {
  const root = recoveryRawRoot(options.project, options.pmId, options.dispatchId);
  const manifestPath = resolve(options.archiveManifest);
  if (!pathWithin(manifestPath, root) || dirname(manifestPath) !== root
    || !/^recovery-[0-9a-f]{12}-[0-9a-f]{12}-archive\.json$/.test(basename(manifestPath))) {
    throw new Error(`gate log recovery archive manifest escapes its approved root: ${manifestPath}`);
  }
  const safeManifest = assertSafeLeaf(manifestPath, "gate log recovery archive manifest");
  const manifestInfo = lstatSync(safeManifest);
  if (!manifestInfo.isFile() || manifestInfo.size > MAX_GATE_LOG_RECOVERY_ARTIFACT_BYTES) {
    throw new Error(`gate log recovery archive manifest is not a bounded regular file: ${manifestPath}`);
  }
  const archive = readRecoveryArchive(safeManifest);
  const canonicalLog = resolve(options.canonicalLog);
  if (!archive || archive.dispatch_id !== options.dispatchId || archive.review_sha !== options.reviewSha
    || resolve(archive.canonical_log) !== canonicalLog) {
    throw new Error(`gate log recovery archive does not bind this replacement: ${manifestPath}`);
  }
  if (!/^[0-9a-f]{12}-[0-9a-f]{12}$/.test(archive.recovery_id)
    || basename(manifestPath) !== `recovery-${archive.recovery_id}-archive.json`
    || basename(canonicalLog) !== `gate-${options.reviewSha.slice(0, 12)}.log`) {
    throw new Error(`gate log recovery archive identity is invalid: ${manifestPath}`);
  }
  const lane = dirname(canonicalLog);
  const sealPath = resolve(dockReviewRecordPath(options.project, options.pmId, options.dispatchId));
  const runRecordPath = resolve(gateRunRecordPath(options.project, options.pmId, canonicalLog));
  const sourcePaths = new Set<string>();
  const archivePaths = new Set<string>();
  const artifactsBySource = new Map<string, GateLogRecoveryArtifact>();
  for (const artifact of archive.artifacts) {
    if (!artifact || typeof artifact.source_path !== "string" || typeof artifact.archive_path !== "string"
      || typeof artifact.content_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(artifact.content_hash)
      || !Number.isSafeInteger(artifact.byte_length) || artifact.byte_length < 0
      || (artifact.sealed_content_hash !== null
        && (typeof artifact.sealed_content_hash !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sealed_content_hash)))) {
      throw new Error(`gate log recovery archive contains a malformed artifact: ${manifestPath}`);
    }
    const source = resolve(artifact.source_path);
    const payload = resolve(artifact.archive_path);
    if (sourcePaths.has(source) || archivePaths.has(payload)) {
      throw new Error(`gate log recovery archive contains duplicate artifact paths: ${manifestPath}`);
    }
    sourcePaths.add(source);
    archivePaths.add(payload);
    artifactsBySource.set(source, artifact);
    if (!pathWithin(payload, root) || dirname(payload) !== root || payload === manifestPath) {
      throw new Error(`gate log recovery payload escapes its approved root: ${payload}`);
    }
    if (!existsSync(payload)) {
      throw new Error(`gate log recovery archive payload is missing: ${payload}`);
    }
    const safePayload = assertSafeLeaf(payload, "gate log recovery archive payload");
    const payloadInfo = lstatSync(safePayload);
    if (!payloadInfo.isFile() || payloadInfo.size > MAX_GATE_LOG_RECOVERY_ARTIFACT_BYTES
      || payloadInfo.size !== artifact.byte_length) {
      throw new Error(`gate log recovery payload is missing, unbounded, non-regular, or has changed length: ${payload}`);
    }
    const bytes = readFileSync(safePayload);
    if (sha256(bytes) !== artifact.content_hash) {
      throw new Error(`gate log recovery payload digest changed: ${payload}`);
    }
  }
  const sealArtifact = artifactsBySource.get(sealPath);
  if (!sealArtifact || sealArtifact.sealed_content_hash !== null) {
    throw new Error("gate log recovery archive does not preserve exactly one original Dock seal");
  }
  const oldSeal = readDockReviewHandoffRecord(sealArtifact.archive_path);
  if (!oldSeal || oldSeal.dispatch_id !== options.dispatchId || oldSeal.review_sha !== options.reviewSha) {
    throw new Error("gate log recovery archived Dock seal has the wrong identity");
  }
  const requiredSources = new Set<string>([sealPath]);
  for (const [sealedPath, sealedDigest] of Object.entries(oldSeal.evidence_digests)) {
    const source = resolve(sealedPath);
    if (!pathWithin(source, lane) && source !== runRecordPath) {
      throw new Error(`gate log recovery archived Dock seal escapes its evidence boundary: ${source}`);
    }
    requiredSources.add(source);
    const artifact = artifactsBySource.get(source);
    if (!artifact || artifact.sealed_content_hash !== sealedDigest
      || artifact.content_hash !== `sha256:${sealedDigest}`) {
      throw new Error(`gate log recovery payload does not match the archived Dock seal: ${source}`);
    }
  }
  if (!requiredSources.has(canonicalLog)) {
    throw new Error("gate log recovery archived Dock seal does not bind the contaminated canonical log");
  }
  for (const [source, artifact] of artifactsBySource) {
    if (requiredSources.has(source)) continue;
    if (source !== runRecordPath || artifact.sealed_content_hash !== null) {
      throw new Error(`gate log recovery archive contains an unexpected payload: ${source}`);
    }
  }
  for (const source of requiredSources) {
    if (!artifactsBySource.has(source)) {
      throw new Error(`gate log recovery archive omits Dock-sealed evidence: ${source}`);
    }
  }
  return archive;
}

/**
 * Retire live sources only from an already verified immutable manifest. Missing
 * leaves mean an earlier attempt retired them successfully; present leaves must
 * still be regular files with the archived digest before they are removed.
 */
function retireGateLogRecoverySources(archive: GateLogRecoveryArchive): void {
  for (const artifact of archive.artifacts) {
    const source = resolve(artifact.source_path);
    if (!existsSync(source)) continue;
    const info = lstatSync(source);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`gate log recovery source is no longer a regular file: ${source}`);
    }
    const bytes = readFileSync(source);
    if (sha256(bytes) !== artifact.content_hash) {
      throw new Error(`gate log recovery source changed after archive: ${source}`);
    }
    rmSync(source, { force: false });
  }
}

function pendingGateLogRecovery(
  project: string,
  pmId: string,
  dispatchId: string,
  reviewSha: string,
  canonicalLog: string,
): string | null {
  const root = recoveryRawRoot(project, pmId, dispatchId);
  if (!existsSync(root)) return null;
  const pending = readdirSync(root)
    .filter((name) => /^recovery-[A-Za-z0-9-]+-archive\.json$/.test(name))
    .map((name) => join(root, name))
    .filter((archivePath) => {
      const receiptPath = recoveryReceiptPath(archivePath);
      if (!existsSync(receiptPath)) return true;
      const receipt = readRecoveryReceipt(receiptPath);
      if (!receipt) return true;
      try {
        verifiedGateLogRecoveryReceiptCandidate(
          { project, pmId, dispatchId },
          { path: receiptPath, receipt },
        );
        return false;
      } catch {
        return true;
      }
    })
    .map((path) => ({ path, record: readRecoveryArchive(path) }))
    .filter((entry): entry is { path: string; record: GateLogRecoveryArchive } => entry.record !== null)
    .filter((entry) => entry.record.dispatch_id === dispatchId
      && entry.record.review_sha === reviewSha
      && resolve(entry.record.canonical_log) === resolve(canonicalLog))
    .sort((left, right) => left.record.archived_at.localeCompare(right.record.archived_at));
  return pending.at(-1)?.path ?? null;
}

/**
 * Move one uninspectable canonical review log and every recreatable artifact
 * bound by its Dock seal out of the append target before a same-SHA rerun.
 * Archive bytes are written and verified first; source leaves are removed only
 * after the manifest exists, so a crash never turns recovery into evidence
 * loss. The deterministic id makes a partially completed retry idempotent.
 */
export function archiveUninspectableReviewGateEvidence(options: {
  project: string;
  pmId: string;
  dispatchId: string;
  reviewSha: string;
  lane: string;
  canonicalLog: string;
  now?: () => Date;
}): string | null {
  const project = resolve(options.project);
  const lane = resolve(options.lane);
  const canonicalLog = resolve(options.canonicalLog);
  if (!pathWithin(canonicalLog, lane) || canonicalLog !== resolve(lane, `gate-${options.reviewSha.slice(0, 12)}.log`)) {
    throw new Error(`gate log recovery requires the canonical same-SHA lane log: ${canonicalLog}`);
  }
  const priorPending = pendingGateLogRecovery(
    project, options.pmId, options.dispatchId, options.reviewSha, canonicalLog,
  );
  if (priorPending) {
    const archive = verifiedGateLogRecoveryArchive({
      project,
      pmId: options.pmId,
      dispatchId: options.dispatchId,
      reviewSha: options.reviewSha,
      archiveManifest: priorPending,
      canonicalLog,
    });
    const archivedCanonical = archive.artifacts.find(
      (artifact) => resolve(artifact.source_path) === canonicalLog,
    );
    if (!archivedCanonical) {
      throw new Error(`gate log recovery archive omits its canonical source: ${canonicalLog}`);
    }
    if (existsSync(canonicalLog)) {
      const currentBytes = readFileSync(canonicalLog);
      if (sha256(currentBytes) !== archivedCanonical.content_hash) {
        // A previous attempt may have completed the gate run and stopped before
        // sealing its receipt. Preserve that established retry behavior: the
        // inspectable replacement is rerun and sealed, never treated as an old
        // source to remove. A different uninspectable file is not that state.
        if (inspectableText(currentBytes).findingId === null) return priorPending;
        throw new Error(`gate log recovery canonical source changed after archive: ${canonicalLog}`);
      }
    }
    retireGateLogRecoverySources(archive);
    return priorPending;
  }
  if (!existsSync(canonicalLog)) return priorPending;
  const logBytes = readFileSync(canonicalLog);
  const finding = inspectableText(logBytes).findingId;
  if (finding === null) return priorPending;

  const logHash = sha256(logBytes).slice("sha256:".length);
  const recoveryId = `${options.reviewSha.slice(0, 12)}-${logHash.slice(0, 12)}`;
  const root = recoveryRawRoot(project, options.pmId, options.dispatchId);
  const manifestPath = join(root, `recovery-${recoveryId}-archive.json`);
  const sealPath = dockReviewRecordPath(project, options.pmId, options.dispatchId);
  const runRecordPath = gateRunRecordPath(project, options.pmId, canonicalLog);
  const seal = readDockReviewHandoffRecord(sealPath);
  if (!seal || seal.dispatch_id !== options.dispatchId || seal.review_sha !== options.reviewSha
    || !(reviewEvidenceKey(canonicalLog) in seal.evidence_digests)) {
    throw new Error("gate log recovery requires the valid Dock seal that binds the contaminated canonical log");
  }
  const sources = new Set<string>([canonicalLog, runRecordPath, sealPath]);
  for (const key of Object.keys(seal.evidence_digests)) {
    const source = resolve(key);
    if (!pathWithin(source, lane) && source !== resolve(runRecordPath)) {
      throw new Error(`gate log recovery seal binds evidence outside its lane/run-record boundary: ${source}`);
    }
    if (!existsSync(source)) throw new Error(`gate log recovery seal-bound evidence is missing: ${source}`);
    if (digestReviewEvidence(source) !== seal.evidence_digests[key]) {
      throw new Error(`gate log recovery source no longer matches its Dock seal: ${source}`);
    }
    sources.add(source);
  }
  const present = [...sources].filter((source) => existsSync(source)).sort((left, right) => left.localeCompare(right));
  if (!present.includes(canonicalLog)) throw new Error(`gate log recovery lost its canonical source: ${canonicalLog}`);
  mkdirSync(root, { recursive: true });
  const artifacts: GateLogRecoveryArtifact[] = present.map((source, index) => {
    const info = lstatSync(source);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`gate log recovery source must be a regular file: ${source}`);
    const bytes = readFileSync(source);
    const archivePath = join(root, recoveryArtifactName(recoveryId, index, source));
    const expectedSealedHash = seal.evidence_digests[reviewEvidenceKey(source)] ?? null;
    if (existsSync(archivePath)) {
      const archivedInfo = lstatSync(archivePath);
      if (archivedInfo.isSymbolicLink() || !archivedInfo.isFile() || !readFileSync(archivePath).equals(bytes)) {
        throw new Error(`gate log recovery archive collision: ${archivePath}`);
      }
    } else {
      writeGuardedFileSync(archivePath, bytes, "gate log recovery archive artifact");
    }
    return {
      source_path: source.replace(/\\/g, "/"),
      archive_path: archivePath.replace(/\\/g, "/"),
      content_hash: sha256(bytes),
      byte_length: bytes.byteLength,
      sealed_content_hash: expectedSealedHash,
    };
  });
  let record: GateLogRecoveryArchive = {
    schema_version: 1,
    kind: "garelier_gate_log_recovery_archive",
    generated_by: "review_prepare.ts",
    recovery_id: recoveryId,
    archived_at: (options.now?.() ?? new Date()).toISOString(),
    dispatch_id: options.dispatchId,
    review_sha: options.reviewSha,
    canonical_log: canonicalLog.replace(/\\/g, "/"),
    finding_id: finding,
    artifacts,
  };
  if (existsSync(manifestPath)) {
    const existing = readRecoveryArchive(manifestPath);
    if (!existing || canonicalJson(existing) !== canonicalJson({ ...record, archived_at: existing.archived_at })) {
      throw new Error(`gate log recovery manifest collision: ${manifestPath}`);
    }
    record = existing;
  } else {
    writeGuardedFileSync(manifestPath, canonicalJson(record), "gate log recovery archive manifest");
  }
  record = verifiedGateLogRecoveryArchive({
    project,
    pmId: options.pmId,
    dispatchId: options.dispatchId,
    reviewSha: options.reviewSha,
    archiveManifest: manifestPath,
    canonicalLog,
  });
  retireGateLogRecoverySources(record);
  return manifestPath;
}

/** Seal the fresh same-SHA replacement without mutating the immutable archive. */
export function sealReviewGateEvidenceRecovery(options: {
  project: string;
  pmId: string;
  dispatchId: string;
  reviewSha: string;
  archiveManifest: string | null;
  canonicalLog: string;
  dockReviewRecord: string;
  now?: () => Date;
}): string | null {
  if (options.archiveManifest === null) return null;
  const archive = verifiedGateLogRecoveryArchive({
    project: options.project,
    pmId: options.pmId,
    dispatchId: options.dispatchId,
    reviewSha: options.reviewSha,
    archiveManifest: options.archiveManifest,
    canonicalLog: options.canonicalLog,
  });
  const logBytes = readFileSync(options.canonicalLog);
  const finding = inspectableText(logBytes).findingId;
  if (finding !== null) throw new Error(`gate log recovery replacement remains uninspectable: ${finding}`);
  const dockRecord = readDockReviewHandoffRecord(options.dockReviewRecord);
  if (!dockRecord) {
    throw new Error("gate log recovery replacement has no fresh GREEN Dock seal");
  }
  const runRecordPath = gateRunRecordPath(options.project, options.pmId, options.canonicalLog);
  const runRecord = readGateRunRecord(runRecordPath);
  if (!runRecord || runRecord.run_id !== dockRecord.gate_run_id
    || resolve(runRecord.log) !== resolve(options.canonicalLog) || runRecord.status !== "GREEN") {
    throw new Error("gate log recovery replacement run record does not bind the fresh GREEN run");
  }
  assertCompleteRecoveryDockHandoff({
    record: dockRecord,
    dispatchId: options.dispatchId,
    reviewSha: options.reviewSha,
    canonicalLog: options.canonicalLog,
    gateRunRecord: runRecordPath,
  });
  let receipt: GateLogRecoveryReceipt = {
    schema_version: 1,
    kind: "garelier_gate_log_recovery_replacement",
    generated_by: "review_prepare.ts",
    recovery_id: archive.recovery_id,
    sealed_at: (options.now?.() ?? new Date()).toISOString(),
    dispatch_id: options.dispatchId,
    review_sha: options.reviewSha,
    archive_manifest: resolve(options.archiveManifest).replace(/\\/g, "/"),
    archive_manifest_hash: sha256(readFileSync(options.archiveManifest)),
    canonical_log: resolve(options.canonicalLog).replace(/\\/g, "/"),
    canonical_log_hash: sha256(logBytes),
    gate_run_record: resolve(runRecordPath).replace(/\\/g, "/"),
    gate_run_record_hash: sha256(readFileSync(runRecordPath)),
    dock_review_record: resolve(options.dockReviewRecord).replace(/\\/g, "/"),
    dock_review_record_hash: sha256(readFileSync(options.dockReviewRecord)),
    gate_run_id: runRecord.run_id,
  };
  const path = recoveryReceiptPath(options.archiveManifest);
  if (existsSync(path)) {
    const existing = readRecoveryReceipt(path);
    if (existing && canonicalJson(existing) === canonicalJson({ ...receipt, sealed_at: existing.sealed_at })) {
      receipt = existing;
    } else {
      let existingIsValid = false;
      if (existing) {
        try {
          verifiedGateLogRecoveryReceiptCandidate(
            { project: options.project, pmId: options.pmId, dispatchId: options.dispatchId },
            { path, receipt: existing },
          );
          existingIsValid = true;
        } catch { /* Invalid receipt bytes are retained below before replacement. */ }
      }
      if (existingIsValid) throw new Error(`gate log recovery receipt collision: ${path}`);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`gate log recovery receipt is not a regular file: ${path}`);
      }
      const bytes = readFileSync(path);
      const invalidPath = invalidRecoveryReceiptPath(path, bytes);
      if (existsSync(invalidPath)) {
        const invalidInfo = lstatSync(invalidPath);
        if (invalidInfo.isSymbolicLink() || !invalidInfo.isFile() || !readFileSync(invalidPath).equals(bytes)) {
          throw new Error(`gate log recovery invalid-receipt archive collision: ${invalidPath}`);
        }
      } else {
        writeGuardedFileSync(invalidPath, bytes, "invalid gate log recovery receipt archive");
      }
      atomicWriteRuntimeFile(recoveryRawRoot(options.project, options.pmId, options.dispatchId), path, canonicalJson(receipt));
    }
  } else {
    writeGuardedFileSync(path, canonicalJson(receipt), "gate log recovery replacement receipt");
  }
  return path;
}

function verifiedGateLogRecoveryReceiptCandidate(
  options: { project: string; pmId: string; dispatchId: string },
  selected: { path: string; receipt: GateLogRecoveryReceipt },
): { path: string; receipt: GateLogRecoveryReceipt } {
  const receipt = selected.receipt;
  for (const [path, expected, label] of [
    [receipt.archive_manifest, receipt.archive_manifest_hash, "archive manifest"],
    [receipt.canonical_log, receipt.canonical_log_hash, "canonical log"],
    [receipt.gate_run_record, receipt.gate_run_record_hash, "gate run record"],
    [receipt.dock_review_record, receipt.dock_review_record_hash, "Dock review record"],
  ] as const) {
    if (!existsSync(path) || sha256(readFileSync(path)) !== expected) {
      throw new Error(`gate log recovery ${label} is missing or changed: ${path}`);
    }
  }
  if (inspectableText(readFileSync(receipt.canonical_log)).findingId !== null) {
    throw new Error("gate log recovery canonical replacement is no longer inspectable");
  }
  const archive = verifiedGateLogRecoveryArchive({
    project: options.project,
    pmId: options.pmId,
    dispatchId: options.dispatchId,
    reviewSha: receipt.review_sha,
    archiveManifest: receipt.archive_manifest,
    canonicalLog: receipt.canonical_log,
  });
  const dockRecord = readDockReviewHandoffRecord(receipt.dock_review_record);
  const runRecord = readGateRunRecord(receipt.gate_run_record);
  if (archive.recovery_id !== receipt.recovery_id) {
    throw new Error("gate log recovery receipt does not bind its archive manifest");
  }
  if (!dockRecord || dockRecord.gate_run_id !== receipt.gate_run_id) {
    throw new Error("gate log recovery receipt does not bind its fresh Dock seal");
  }
  assertCompleteRecoveryDockHandoff({
    record: dockRecord,
    dispatchId: options.dispatchId,
    reviewSha: receipt.review_sha,
    canonicalLog: receipt.canonical_log,
    gateRunRecord: receipt.gate_run_record,
  });
  if (!runRecord || runRecord.run_id !== receipt.gate_run_id || runRecord.status !== "GREEN"
    || resolve(runRecord.log) !== resolve(receipt.canonical_log)
    || runRecord.start_head !== receipt.review_sha || runRecord.end_head !== receipt.review_sha) {
    throw new Error("gate log recovery receipt does not bind its fresh same-SHA run record");
  }
  return selected;
}

/** Latest fresh-seal receipt used to authorize driver-owned aftercare replan. */
export function verifiedGateLogRecoveryReceipt(options: {
  project: string;
  pmId: string;
  dispatchId: string;
}): { path: string; receipt: GateLogRecoveryReceipt } {
  const root = recoveryRawRoot(options.project, options.pmId, options.dispatchId);
  if (!existsSync(root)) throw new Error(`gate log recovery archive is missing for dispatch ${options.dispatchId}`);
  const candidates = readdirSync(root)
    .filter((name) => /^recovery-[A-Za-z0-9-]+-replacement\.json$/.test(name))
    .map((name) => join(root, name))
    .map((path) => ({ path, receipt: readRecoveryReceipt(path) }))
    .filter((entry): entry is { path: string; receipt: GateLogRecoveryReceipt } => entry.receipt !== null)
    .filter((entry) => entry.receipt.dispatch_id === options.dispatchId)
    .sort((left, right) => left.receipt.sealed_at.localeCompare(right.receipt.sealed_at));
  const selected = candidates.at(-1);
  if (!selected) throw new Error(`gate log recovery replacement receipt is missing for dispatch ${options.dispatchId}`);
  return verifiedGateLogRecoveryReceiptCandidate(options, selected);
}

const KNOWN_LANE_FILES = new Set([
  "prompt.md", "result.md", "register.md", "followup.md", "followup.template.md", "followup.result.md",
  "session.json", "secret-scan.md", "final_accounting.md", "recovery.result.md", "recovery.session.json",
]);
const KNOWN_LANE_REVIEW_FILE_RE =
  /^(?:scanner-[0-9a-f]{12}\.md(?:\.json)?|gate(?:-step4)?-[0-9a-f]{12}\.log|reuse-[A-Z]+-\d+\.md)$/;
const LANE_RESUME_ERROR_SUFFIX = ".resume-error.json";

/**
 * The `lane/` SUBDIRECTORIES the framework recognises.
 *
 * `locks` is the provider-launcher lock dir, which must be empty — aftercare enforces
 * that structurally, so nothing here describes its contents. `logs` is where a
 * producer puts the run logs its own prompt requires it to keep ("long-running
 * commands write a log file"); the framework names the directory and the
 * producer names the files inside it, so the subtree is recognised by
 * CONTAINMENT, the same way the container's evidence dir already is.
 */
const KNOWN_LANE_DIRS = new Set(["locks", "logs"]);

/** The single predicate for lane FILE NAMES that are disposable with a
 * dispatch container (W-547). Its denominator comes from the framework's
 * emitting call sites: prompt/result/register/session artifacts, scanner/gate
 * outputs (including the runner-owned pm-step log), warm-reuse pointers, and resume-error sidecars. `register.md` is the
 * alternate register leaf a claude lane writes when the harness refuses the
 * name `report.md` (W-780) — admitted by `dock_proxy` and, before W-782,
 * refused as producer scratch by the very mechanism that told the lane to write
 * it. Arbitrary producer scratch deliberately stays outside this set; land
 * aftercare recognizes and preserves the runner-owned pm-step log itself. */
export function isKnownLaneArtifact(name: string): boolean {
  if (KNOWN_LANE_FILES.has(name) || KNOWN_LANE_REVIEW_FILE_RE.test(name)) return true;
  return name.endsWith(LANE_RESUME_ERROR_SUFFIX)
    && isKnownLaneArtifact(name.slice(0, -LANE_RESUME_ERROR_SUFFIX.length));
}

/**
 * The ONE recognition rule for an entry inside a dispatch container's `lane/`
 * (W-547 AC-2 / AC-4): one set, read by every route that removes a container.
 *
 * `segments` is the path RELATIVE TO `lane/`, already split. The file/directory
 * distinction is part of the rule, not a caller's business: a directory named
 * `result.md` is not a result, and a file named `logs` is not the log dir.
 *
 * Before this existed, `land_aftercare.ts` spelled the rule as
 * "segments.length === 2 && isKnownLaneArtifact(…) || … 'locks'" while
 * `land_pipeline.ts` spelled it as "name !== 'locks' && !isKnownLaneArtifact(…)".
 * Two spellings agree on the day they are written and nothing keeps them
 * agreeing — which is exactly how one route accepted `lane/session.json` while
 * the other refused it (#43), holding the container's claim.
 */
export function isKnownLaneEntry(
  segments: readonly string[],
  entry: { isFile(): boolean; isDirectory(): boolean },
  writtenByRun: ReadonlySet<string> = new Set(),
): boolean {
  const head = segments[0];
  if (head === undefined) return false;
  const relativePath = segments.join("/");
  if (entry.isFile() && writtenByRun.has(relativePath)) return true;
  if (entry.isDirectory() && [...writtenByRun].some((path) => path.startsWith(`${relativePath}/`))) return true;
  if (segments.length === 1) {
    return entry.isDirectory() ? KNOWN_LANE_DIRS.has(head) : entry.isFile() && isKnownLaneArtifact(head);
  }
  // Inside a recognised lane directory. Only `logs` has recognised CONTENTS;
  // `locks` must be empty, so a path below it is not something this set knows.
  return head === "logs";
}

/** Exact variable producer paths published by this dispatch generation. The
 * role authorization v3 digest is the authority; `ready.json` only mirrors
 * this set for operators and is never read as an admission source. */
export function laneArtifactsWrittenByRun(values: readonly string[] | undefined): ReadonlySet<string> {
  const declared = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")
      || /^[A-Za-z]:/.test(value)
      || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`role authorization lane artifact path is unsafe: ${String(value)}`);
    }
    declared.add(value);
  }
  return declared;
}

/** `<container>/lane/gate-step4-<review sha12>.log`, written by land_pipeline's
 * pm_step stage. The prefix and the 12-hex shape are declared once. */
const PM_STEP_GATE_LOG_PREFIX = "gate-step4-";
const PM_STEP_GATE_LOG_RE = new RegExp(`^${PM_STEP_GATE_LOG_PREFIX}[0-9a-f]{12}\\.log$`);

/** The lane file name for one pm-step gate run over `reviewSha`. */
export function pmStepGateLogName(reviewSha: string): string {
  return `${PM_STEP_GATE_LOG_PREFIX}${reviewSha.slice(0, 12)}.log`;
}

/** Does this `lane/` file name follow the pm-step gate log convention?
 *
 * Deliberately exact: a log written under any other name is NOT preserved and
 * still reaches aftercare's refusal, which is the detection this convention
 * exists to keep. */
export function isPmStepGateLog(name: string): boolean {
  return PM_STEP_GATE_LOG_RE.test(name);
}

/** Where a removed container's gate artifacts are kept. Tracked control tree, so
 * the evidence outlives the transient container (blueprint LP-3). */
export function gateArtifactPreserveRoot(
  project: string,
  pmId: string,
  workId: string,
  dispatchId: string,
): string {
  return resolve(project, "__garelier", pmId, "control", "reports", "gates", workId || "unassigned", `dispatch${dispatchId}`);
}

/** Move every pm-step gate log out of `lane/` into the preserve root, so a
 * removal path can proceed without `--force-remove` and without discarding the
 * gate evidence. Returns the project-relative destinations, in name order.
 *
 * Copy-then-remove, never remove-only: the point is that the evidence survives.
 * Idempotent — a second call finds no matching lane file and preserves nothing.
 */
/** The pm-step gate logs actually present in `lane/`, in name order. Reading
 * only — the shared denominator for preserving them and for predicting that
 * preservation. */
export function pmStepGateLogsIn(lane: string): string[] {
  if (!existsSync(lane)) return [];
  return readdirSync(lane)
    .filter((name) => isPmStepGateLog(name))
    .filter((name) => {
      try { return statSync(join(lane, name)).isFile(); } catch { return false; }
    })
    .sort();
}

/** Where `preservePmStepGateLogs` WOULD put each log, computing nothing else and
 * writing nothing (W-741, #474 Guardian). A `--dry-run` preview must not mutate,
 * so it cannot show the accepted plan the apply reaches; what it CAN do without
 * relaxing one rule is name the preservation the apply performs, which is the
 * answer the PM habit the row exists to end — "preview refuses, reach for
 * --force-remove" — actually needs. */
export function plannedPmStepGateLogPreservation(options: {
  lane: string;
  project: string;
  pmId: string;
  workId: string;
  dispatchId: string;
}): string[] {
  const names = pmStepGateLogsIn(options.lane);
  if (names.length === 0) return [];
  const dest = gateArtifactPreserveRoot(options.project, options.pmId, options.workId, options.dispatchId);
  return names.map((name) => relative(options.project, join(dest, name)).replaceAll("\\", "/"));
}

/** Would aftercare's refusal name ONLY logs this preservation removes?
 *
 * The unknown set is derived from aftercare's own `isKnownLaneEntry`, not a
 * second copy of the rule, so a name aftercare starts accepting stops counting
 * here on the same day. `isKnownLaneEntry` is the whole rule — name AND dirent
 * type — where `isKnownLaneArtifact` is only its name half; naming the narrower
 * predicate here is the drift this function exists to prevent (W-783 AC-5, from
 * W-782 Guardian N-3). False when the lane holds no such log at all, so a
 * preview that would refuse for an unrelated reason still refuses.
 *
 * `isFile` is required for the same reason `pmStepGateLogsIn` requires it
 * (#474 r3 -> M5): a DIRECTORY named to the convention is not something this
 * preservation removes, so counting it here would answer "only preserved logs"
 * about an entry that stays behind. The two predicates walk the same lane and
 * must agree on what a pm-step gate log IS. */
export function laneUnknownIsOnlyPmStepGateLogs(lane: string): boolean {
  if (!existsSync(lane)) return false;
  const unknown = readdirSync(lane, { withFileTypes: true })
    .filter((entry) => !isKnownLaneEntry([entry.name], entry));
  return unknown.length > 0 && unknown.every((entry) => entry.isFile() && isPmStepGateLog(entry.name));
}

/** The `lane/` entries an aftercare refusal names, or `null` when the refusal is
 * NOT the unknown-container-entry class at all.
 *
 * Read from the caught message, because that is the only thing that says WHY
 * this particular preview refused. A predicate that walks the lane instead
 * answers a different question — "could an unknown-entry refusal be explained
 * by gate logs" — and returns true while the real cause is a dirty checkout, a
 * missing ownership file, or a symlink (#474 r3 -> M5: that gap let a dirty
 * checkout holding a step-4 log preview as success). */
export function unknownLaneEntriesInRefusal(message: string): string[] | null {
  // The refusal is `<clause>[; <clause>] (<n> unknown entr… total; …)`, one
  // clause per entry KIND, each `dispatch container has unknown <kind>: a, b`.
  // Clause starts are located rather than split on "; ", because the trailing
  // parenthetical carries a "; " of its own.
  const starts = [...message.matchAll(/dispatch container has unknown (?:top-level entry|nested artifact): /g)];
  if (starts.length === 0) return null;
  const items: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]!.index! + starts[i]![0].length;
    const next = starts[i + 1];
    const raw = next === undefined ? message.slice(from) : message.slice(from, next.index! - "; ".length);
    const listEnd = raw.indexOf(" (");
    for (const item of (listEnd < 0 ? raw : raw.slice(0, listEnd)).split(", ")) {
      if (item.length > 0) items.push(item);
    }
  }
  return items.length > 0 ? items : null;
}

/** Does this refusal name nothing but `lane/` pm-step gate logs — the exact set
 * `preservePmStepGateLogs` moves out before the apply removes the container? */
export function refusalIsOnlyPmStepGateLogs(message: string): boolean {
  const items = unknownLaneEntriesInRefusal(message);
  if (items === null) return false;
  return items.every((item) => {
    const segments = item.split("/");
    return segments.length === 2 && segments[0] === "lane" && isPmStepGateLog(segments[1]!);
  });
}

export function preservePmStepGateLogs(options: {
  lane: string;
  project: string;
  pmId: string;
  workId: string;
  dispatchId: string;
  maxBytes?: number;
  runtimeArchiveKeepDays?: number;
  runtimeArchiveKeepFiles?: number;
}): string[] {
  const names = pmStepGateLogsIn(options.lane);
  if (names.length === 0) return [];
  const dest = gateArtifactPreserveRoot(options.project, options.pmId, options.workId, options.dispatchId);
  const runtimeDest = resolve(options.project, "__garelier", options.pmId, "runtime", "gate", "preserved_raw", `dispatch${options.dispatchId}`);
  const redactionPlanDigest = sha256(canonicalJson(names.map((name) => ({
    source: `lane/${name}`,
    raw_hash: sha256(readFileSync(join(options.lane, name))),
  }))));
  const prepared = names.map((name) => {
    const from = join(options.lane, name);
    const to = join(dest, name);
    const raw = readFileSync(from);
    const rawPath = join(runtimeDest, name);
    const runRecord = readGateRunRecord(gateRunRecordPath(options.project, options.pmId, from));
    if (!runRecord?.preservation || runRecord.log !== resolve(from).replace(/\\/g, "/")) {
      throw new Error(`pm-step gate log has no matching runner-owned preservation record: ${from}`);
    }
    const structuredSummary = summarizeGateRunForPreservation(
      runRecord.preservation, relative(options.project, rawPath).replaceAll("\\", "/"),
      options.maxBytes ?? DEFAULT_PRESERVED_ARTIFACT_MAX_BYTES,
      {
        projectRoot: options.project, pmId: options.pmId,
        binding: {
          requestId: `pm-step-${options.dispatchId}`,
          planDigest: redactionPlanDigest,
          workId: options.workId,
          dispatchId: options.dispatchId,
        },
      },
    );
    const summary = Buffer.from(summarizePmStepGateLog(
      raw,
      relative(options.project, rawPath).replaceAll("\\", "/"),
      structuredSummary,
      options.maxBytes ?? DEFAULT_PRESERVED_ARTIFACT_MAX_BYTES,
    ), "utf8");
    return { name, from, to, raw, rawPath, summary };
  });

  // PM-step publication is the same trust boundary as generic aftercare.
  // Admit the exact tracked summary bytes as one batch before creating any
  // tracked leaf; a refusal records only redacted pointers and retains source.
  const planDigest = sha256(canonicalJson(prepared.map((item) => ({
    source: `lane/${item.name}`,
    summary_hash: sha256(item.summary),
  }))));
  const admission = evaluatePreservationAdmission({
    projectRoot: options.project,
    pmId: options.pmId,
    binding: {
      requestId: `pm-step-${options.dispatchId}`,
      planDigest,
      workId: options.workId,
      dispatchId: options.dispatchId,
    },
    sources: prepared.map((item) => ({
      kind: "container_artifact" as const,
      sourcePath: `lane/${item.name}`,
      bytes: item.summary,
    })),
  });
  const admissionBody = preservationAdmissionBytes(admission);
  const runtimeAdmissionDir = resolve(options.project, "__garelier", options.pmId, "runtime", "gate", "preservation_admissions");
  const runtimeAdmission = join(runtimeAdmissionDir, `${admission.record_hash.replace(/^sha256:/, "")}.json`);
  mkdirSync(runtimeAdmissionDir, { recursive: true });
  if (existsSync(runtimeAdmission)) {
    if (readFileSync(runtimeAdmission, "utf8") !== admissionBody) {
      throw new Error(`pm-step preservation admission hash collision: ${runtimeAdmission}`);
    }
  } else {
    writeGuardedFileSync(runtimeAdmission, admissionBody, "runtime pm-step preservation admission");
  }
  if (admission.status !== "CLEAN") {
    const pointers = admission.artifacts
      .flatMap((artifact) => artifact.findings.map((finding) => finding.redacted_pointer))
      .join(", ");
    throw new Error(`pm-step preservation security admission rejected; source artifacts retained: ${pointers}`);
  }

  // Verify the complete existing destination set before publishing one leaf.
  for (const item of prepared) {
    for (const [path, bytes, label] of [
      [item.rawPath, item.raw, "runtime raw pm-step gate log"],
      [item.to, item.summary, "preserved pm-step gate summary"],
    ] as const) {
      if (!existsSync(path)) continue;
      if (!lstatSync(path).isFile() || !readFileSync(path).equals(bytes)) {
        throw new Error(`${label}: destination already exists with different content: ${path}`);
      }
    }
  }
  mkdirSync(dest, { recursive: true });
  mkdirSync(runtimeDest, { recursive: true });
  const preserved: string[] = [];
  for (const item of prepared) {
    if (!existsSync(item.rawPath)) writeGuardedFileSync(item.rawPath, item.raw, "runtime raw pm-step gate log");
    if (!existsSync(item.to)) writeGuardedFileSync(item.to, item.summary, "preserved pm-step gate summary");
    rmSync(item.from, { force: true });
    preserved.push(relative(options.project, item.to).replaceAll("\\", "/"));
  }
  try {
    pruneGateRuntimeEvidence({
      project: options.project,
      pmId: options.pmId,
      keepDays: options.runtimeArchiveKeepDays ?? 30,
      keepFiles: options.runtimeArchiveKeepFiles ?? 300,
    });
  } catch { /* retention never invalidates the evidence publication that triggered it */ }
  return preserved;
}
