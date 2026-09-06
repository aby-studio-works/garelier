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
import { isKnownLaneArtifact } from "./land_aftercare.ts";

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
 * The unknown set is derived from aftercare's own `isKnownLaneArtifact`, not a
 * second copy of the rule, so a name aftercare starts accepting stops counting
 * here on the same day. False when the lane holds no such log at all, so a
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
    .filter((entry) => entry.name !== "locks" && !isKnownLaneArtifact(entry.name));
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
