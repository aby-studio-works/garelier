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
import { join, relative, resolve } from "node:path";
import { rmSync, rmdirSync, writeGuardedFileSync } from "../guard/path_guard.ts";
import { MIN_PRESERVED_ARTIFACT_MAX_BYTES } from "../config.ts";
import { canonicalJson, sha256 } from "../control/serialization.ts";
import {
  gateRunRecordPath,
  readGateRunRecord,
  type GateRunPreservationRecord,
} from "./gate_run_record.ts";
import { evaluatePreservationAdmission, preservationAdmissionBytes, type PreservationAdmissionBinding } from "./preservation_admission.ts";

export const DEFAULT_PRESERVED_ARTIFACT_MAX_BYTES = 64 * 1024;

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
  if (journal.state === "views_refreshed") return true;
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

const KNOWN_LANE_FILES = new Set([
  "prompt.md", "result.md", "register.md", "followup.md", "followup.template.md", "followup.result.md",
  "session.json", "secret-scan.md", "final_accounting.md", "recovery.result.md", "recovery.session.json",
]);
const KNOWN_LANE_REVIEW_FILE_RE =
  /^(?:scanner-[0-9a-f]{12}\.md(?:\.json)?|gate-[0-9a-f]{12}\.log|reuse-[A-Z]+-\d+\.md)$/;
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
 * outputs, warm-reuse pointers, and resume-error sidecars. `register.md` is the
 * alternate register leaf a claude lane writes when the harness refuses the
 * name `report.md` (W-780) — admitted by `dock_proxy` and, before W-782,
 * refused as producer scratch by the very mechanism that told the lane to write
 * it. The durable pm-step log and arbitrary producer scratch deliberately stay
 * outside this set; this module preserves the former before removal, while
 * aftercare reports the latter. */
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
): boolean {
  const head = segments[0];
  if (head === undefined) return false;
  if (segments.length === 1) {
    return entry.isDirectory() ? KNOWN_LANE_DIRS.has(head) : entry.isFile() && isKnownLaneArtifact(head);
  }
  // Inside a recognised lane directory. Only `logs` has recognised CONTENTS;
  // `locks` must be empty, so a path below it is not something this set knows.
  return head === "logs";
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
    const summary = Buffer.from(summarizeGateRunForPreservation(
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
