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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { rmSync, writeGuardedFileSync } from "../guard/path_guard.ts";

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
 * `locks` is the recovery lock dir, which must be empty — aftercare enforces
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
}): string[] {
  const names = pmStepGateLogsIn(options.lane);
  if (names.length === 0) return [];
  const dest = gateArtifactPreserveRoot(options.project, options.pmId, options.workId, options.dispatchId);
  mkdirSync(dest, { recursive: true });
  const preserved: string[] = [];
  for (const name of names) {
    const from = join(options.lane, name);
    const to = join(dest, name);
    writeGuardedFileSync(to, readFileSync(from), "preserved pm-step gate log");
    rmSync(from, { force: true });
    preserved.push(relative(options.project, to).replaceAll("\\", "/"));
  }
  return preserved;
}
