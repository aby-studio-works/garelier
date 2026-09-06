#!/usr/bin/env bun
import { detachReparsePoints, removeTreeSync, rmSync } from "../guard/path_guard.ts";

import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { longJobRoot, retireLongJobsForDispatch } from "../long_jobs.ts";
import { crewSubdir } from "../workspace.ts";
import { emitJsonLine, git, run, utcIsoSeconds } from "./_lib.ts";
import { applyLandAftercare, dryRunLandAftercare, sameFilesystemPath } from "../dispatch/land_aftercare.ts";
import {
  laneUnknownIsOnlyPmStepGateLogs,
  plannedPmStepGateLogPreservation,
  preservePmStepGateLogs,
  refusalIsOnlyPmStepGateLogs,
} from "../dispatch/gate_step_artifacts.ts";
import { readControlClaim } from "../control/claims.ts";
import { resolveControlNamespace } from "../control/transaction.ts";
import { seatReportPath } from "./gate_agents.ts";
import { loadPlanGraphModel } from "../control/plan_graph_model.ts";
import { planGraphEvidenceReferences } from "../control/plan_graph_write.ts";
import { validateGateEvidence } from "../control/evidence_validation.ts";
import { canonicalJson, sha256 } from "../control/serialization.ts";
import { assertNoSymlinkPath, ensureSafeDirectory } from "../control/diagnostics.ts";
import { CLOSED_WORK_STATES, type EvidenceReference } from "../control/types.ts";
import {
  acquireGarelierOperationGuard,
  garelierControlRoots,
  hasMergeControlEvidence,
  inspectDispatchControlBinding,
  recordMergeControlOutcome,
  releaseDispatchControlClaim,
  type UngatedMergeLanding,
} from "../control/garelier_integration.ts";
import { assertFinalizeOrderOk } from "../integration_closure.ts";
import {
  DISPATCH_CONTAINER_LIFECYCLE,
  readDispatchContainerRecords,
  type DispatchContainerLifecycle,
} from "../dispatch/container_lifecycle.ts";
import { dispatchExecutionIdentity, readCurrentRoleAuthorization } from "../dispatch/role_binding.ts";

const HELP = `#
# dispatch_cleanup.ts — remove a dispatch_prepare.ts container after the merge
# gate integrated (or rejected) the branch (DEC-063 Part A).
# Robust on Windows (DEC-073 Part C): when a lingering build/compiler handle
# (or OS handle lag) holds a file under the worktree's deep build-output dir, the dir
# cannot be deleted even though git deregistered the worktree. Instead of leaking
# a stale \`_crew/dispatch<N>/\`, this script retries with backoff, then DEFERS the dir
# to \`runtime/backlog/failed_cleanups.jsonl\` and exits 0 (git is already pruned).
# Re-runnable in --sweep mode (retries every recorded stale dir) — the self-heal
# hook that dispatch_prepare calls on every new dispatch. --sweep ALSO reclaims
# orphaned per-lane \`runtime/scratch/<slug>\` dirs whose dispatch container is
# already gone (W-084(a)): role intermediate output survives container
# cleanup and otherwise piles up in the retention gap. A scratch dir a live
# dispatch still owns (its slug appears in an active \`_crew/dispatch<N>\` context.json)
# is preserved. It also non-force deletes canonical local temporary branches
# whose tips Git proves are already reachable from studio. With the explicit
# --retire-superseded flag, a terminal Control row with one validated typed gate
# evidence naming the landed round authorizes retirement of the other round refs
# by exact-tip CAS and tracked recovery records under
# control/reports/branch_retirements/. Active, checked-out, dirty, open-row,
# unmerged landed-round, target/studio, and merge-gate-referenced refs are preserved.
#
# Usage:
#   dispatch_cleanup.ts --project <control-root> --pm-id <id> [--id <n>] --request-id <merge-request-id> [--force-remove] [--dry-run] [--target-root <git-root>]
#   dispatch_cleanup.ts --project <control-root> --pm-id <id> --id <n> [--checkout <asserted-path>] [--delete-branch] [--force-remove] [--accept-ungated-merge] [--target-root <git-root>] [--report-from-file <path>]
#   dispatch_cleanup.ts --project <control-root> --pm-id <id> --sweep [--retire-superseded] [--target-root <git-root>]  # retry deferred stale dirs; opt in to superseded retirement
#   dispatch_cleanup.ts --project <control-root> --pm-id <id> --id <n> --record-touches [--target-root <git-root>]  # W-021: record measured touches, remove nothing
#
# --force-remove (W-318; was the unqualified --force): forces the REMOVAL half
# only — \`git worktree remove --force\` on a dirty/locked checkout, branch
# deletion without the merged-tip check, and skipping the "a merge of this branch
# is in progress" / "the merge gate holds this slug" races. It has NEVER bypassed
# a control check and still does not: the schema-3 control block below runs
# unconditionally, so no flag can delete a container without first recording what
# happened to its Work/Backlog row. The old name read like a global override,
# which is exactly backwards.
#
# --accept-ungated-merge (W-318): the ONLY exit from the "landing has no gate
# result" state (manual merge bypass). It does NOT skip a check — the ungated
# merge must exist on studio's first-parent line and lack validated durable gate
# evidence. Branch history is diagnostic attribution only. A possible manual
# fast-forward cannot be accepted because it has no first-parent merge record.
# What the flag adds is the acknowledgement that the gate was bypassed: the
# row gets a durable \`merge_gate_bypass_record\` (status \`bypassed\`, NOT a passing
# gate), keeps its current status instead of advancing to verification, and carries
# an explicit obligation to gate or waive before it can close.
#
# --record-touches (W-021): does NOT clean up. It records the dispatch's MEASURED
# path set (base_sha..HEAD) into context.json task.touches_actual so a gate /
# Guardian reads the actual diff instead of the dispatch-time \`touches\` prediction
# (which goes stale). Run it at REPORTING (before the gate); delegates to
# driver/src/dispatch/record_touches.ts. Best-effort — a git/read failure leaves
# context.json unchanged and exits non-zero without touching the container.
#
# --report-from-file <path> (W-019): report/register single-ledger. When the
# harness prevented the role from writing report.md (a common live condition —
# the compact REGISTER message is then the canonical record), the PM saves that
# register text to a file and passes it here; cleanup transcribes it into the
# container's report.md BEFORE archiving, so the archived report carries the real
# outcome instead of the untouched dispatch scaffold. Best-effort: a missing
# source file is a no-op (the existing report.md is archived as-is).
set -uo pipefail`;

function out(line: string): void { process.stdout.write(`${line}\n`); }
function err(line: string): void { process.stderr.write(`${line}\n`); }
class CliFailure extends Error { constructor(readonly exitCode: number) { super("dispatch_cleanup failed"); } }
function fail(message: string, code: number): never { err(message); throw new CliFailure(code); }

export function cleanupStatusFields(cleanupStatus: string, cleanupReasons: readonly string[]): {
  cleanup_status: string;
  cleanup_reasons: string[];
} {
  if ((cleanupStatus === "deferred" || cleanupStatus === "partial") && cleanupReasons.length === 0) {
    throw new Error(`dispatch_cleanup: ${cleanupStatus} result requires an explicit cleanup reason`);
  }
  return { cleanup_status: cleanupStatus, cleanup_reasons: [...cleanupReasons] };
}

// W-368 AC2: a land-aftercare refusal used to name only the immediate cause
// (e.g. "unknown top-level entry: ci_evidence"), never the consequence — a
// refused cleanup leaves the container's claim held, which blocks any new
// dispatch whose touches overlap it two symptoms later
// (`dispatch_prepare: claim touches conflict with active dispatch NNN`). Naming
// that chain here is what let the PM connect the two without re-deriving it from
// scratch under production pressure (measured 2026-08-03..05, target-project incidents #506/#507/#495).
function landAftercareRefusalMessage(id: string, cause: string): string {
  const claimant = id ? `dispatch #${id}` : "this dispatch";
  return `dispatch_cleanup: land aftercare refused: ${cause}. ` +
    `Until this is resolved, ${claimant}'s container stays active and its claim stays held — ` +
    `a NEW dispatch whose touches overlap it will fail with 'claim touches conflict with active dispatch ${id || "<id>"}'. ` +
    `Inspect the container named above, or re-run with --force-remove after confirming any evidence you would discard.`;
}

function valueAfter(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value === "") fail(`dispatch_cleanup: missing value for ${argv[index]}`, 1);
  return value;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function isRegularFileAtOrAfter(path: string, notBeforePath: string): boolean {
  try {
    const info = lstatSync(path);
    const notBefore = lstatSync(notBeforePath);
    return !info.isSymbolicLink() && info.isFile()
      && !notBefore.isSymbolicLink() && notBefore.isFile()
      && info.mtimeMs >= notBefore.mtimeMs;
  } catch { return false; }
}

function filesystemPathsMatch(left: string, right: string): boolean {
  try { return sameFilesystemPath(left, right); }
  catch { return false; }
}

/** W-530: a destructive caller and the dispatch registry must independently
 * select the same checkout. This gate runs before locks, archives, Control
 * mutations, reparse detachment, or any removal. */
function requireMatchingCheckout(explicitCheckout: string, derivedCheckout: string, id: string): void {
  if (!explicitCheckout) return;
  if (!filesystemPathsMatch(explicitCheckout, derivedCheckout)) {
    fail(
      `dispatch_cleanup: REFUSING — --checkout '${explicitCheckout}' does not match the checkout derived from --id ${id} ('${derivedCheckout}'). No filesystem or Control mutation was performed.`,
      3,
    );
  }
}

function readText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function gitOutput(root: string, args: string[]): string {
  const result = git(root, args);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

/**
 * W-318 (PM N1) — is `path` a git worktree in its OWN right, rather than merely a
 * directory sitting inside one?
 *
 * A dispatch container lives under the project repo, so when its `checkout/`
 * subdir is absent (a crashed dispatch_prepare, or a checkout already removed)
 * every git query aimed at the container silently answers for the PARENT repo:
 * `--is-inside-work-tree` says true, `status --porcelain` reports the project's
 * dirt, and `branch --show-current` returns the PROJECT'S branch. That last one
 * is the dangerous one — cleanup would then treat e.g. `main` as the dispatch
 * branch, find it "merged" into studio, and with `--delete-branch` delete the
 * project's own branch. Comparing `--show-toplevel` against the path itself is
 * the only thing that separates the container's git state from its host's.
 */
type WorktreeIdentity =
  | { kind: "own-worktree" }
  | { kind: "not-own-worktree" }
  | { kind: "measurement-error"; detail: string };

type CheckoutSelection = "registered-checkout" | "container-fallback";

function worktreeIdentity(path: string, selection: CheckoutSelection): WorktreeIdentity {
  const marker = join(path, ".git");
  if (!existsSync(marker)) {
    if (selection === "container-fallback") return { kind: "not-own-worktree" };
    return {
      kind: "measurement-error",
      detail: `linked-worktree marker ${marker} is missing from the selected checkout`,
    };
  }
  try {
    if (!statSync(marker).isFile()) {
      return { kind: "measurement-error", detail: `${marker} is not a linked-worktree gitdir file` };
    }
  } catch (error) {
    return { kind: "measurement-error", detail: `cannot inspect ${marker}: ${(error as Error).message}` };
  }
  const result = git(path, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    return {
      kind: "measurement-error",
      detail: result.stderr.trim() || `git rev-parse exited ${result.exitCode}`,
    };
  }
  const top = result.stdout.trim();
  const normalize = (value: string) => resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (top && normalize(top) === normalize(path)) return { kind: "own-worktree" };
  return { kind: "measurement-error", detail: `${marker} resolves to another worktree top (${top || "<empty>"})` };
}

function isOwnWorktreeTop(path: string, selection: CheckoutSelection): boolean {
  return worktreeIdentity(path, selection).kind === "own-worktree";
}

type CheckoutMeasurement =
  | { kind: "not-own-worktree" }
  | { kind: "measured-clean" }
  | { kind: "measured-dirty"; paths: string[]; total: number }
  | { kind: "measurement-error"; detail: string };

/**
 * W-318 (PM N1 / Guardian GDN-001) — MEASURE what removing a checkout would
 * destroy, without ever converting an unknown answer into "clean".
 *
 * `not-own-worktree` exists only for the deliberate container fallback selected
 * when `container/checkout` does not exist. Once that registered checkout path
 * was selected, a missing marker is identity loss, not evidence that it is bare.
 * A real worktree has only three outcomes: measured clean, measured dirty, or a
 * measurement error. The last one is security-significant: missing metadata or
 * a corrupt/unreadable index must not authorize recursive deletion merely
 * because `git status` could not describe the uncommitted content.
 */
function measureCheckout(checkout: string, selection: CheckoutSelection, sample = 8): CheckoutMeasurement {
  const identity = worktreeIdentity(checkout, selection);
  if (identity.kind === "not-own-worktree") return identity;
  if (identity.kind === "measurement-error") return identity;
  const status = git(checkout, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.exitCode !== 0) {
    return {
      kind: "measurement-error",
      detail: status.stderr.trim() || `git status exited ${status.exitCode}`,
    };
  }
  const lines = status.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { kind: "measured-clean" };
  return { kind: "measured-dirty", paths: lines.slice(0, sample), total: lines.length };
}

/**
 * `force` gates BOTH removal steps, not just `git worktree remove --force`.
 *
 * The `rmSync` fallback exists for DEC-073 Part C: on Windows a lingering
 * build/compiler handle can hold a file under the worktree so `git worktree
 * remove` fails even though the tree is CLEAN and nothing would be lost. It was
 * running unconditionally, which made an unflagged `dispatch_cleanup --id N`
 * delete uncommitted role work whenever git refused for the OTHER reason —
 * a dirty tree (W-318 PM N1; same class as W-313 / W-317).
 *
 * So the fallback now runs only when the tree is measurably clean, or when the
 * caller explicitly passed `--force-remove`. A dirty tree without that flag is
 * refused outright and nothing is deleted. The locked-clean-tree recovery the
 * fallback was written for is untouched.
 *
 * W-380: BOTH removers here are recursive, and the git one follows Windows
 * junctions out of the tree (measured: it emptied a junction's target). Every
 * link is detached before either runs, so neither has a link to walk through.
 */
/**
 * W-667 F-7 — name what holds a checkout that could not be removed.
 *
 * The deferral recorded "worktree dir not removed (locked or dirty)", which is
 * the union of two unrelated situations with two different answers, and named
 * neither the path nor the holder. Eleven containers accumulated while the
 * operator guessed. This reports only: nothing is killed, no handle is forced,
 * no lock is released.
 */
/**
 * W-667 M6 — the probe never builds a shell command line.
 *
 * The first version interpolated the checkout path into a `sh -c` string inside
 * single quotes, and its escape collapsed to `'''` rather than the POSIX
 * `'\''` idiom, so a path containing a quote closed the literal and the rest ran
 * as shell code. Quoting is the wrong fix for a problem that exists only because
 * a shell is involved: both branches now invoke a program over argv and match
 * the path in TypeScript, where no quoting rule applies. The PowerShell script
 * is a constant — the path is never interpolated into it.
 */
export const PROCESS_TABLE_PROBE: readonly string[] = process.platform === "win32"
  ? ["powershell", "-NoProfile", "-NonInteractive", "-Command",
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)" }']
  : ["ps", "-eo", "pid=,comm=,args="];

/** Path comparison only; the value never reaches a shell. */
function normalizeForMatch(value: string): string {
  const slashed = value.replace(/\\/g, "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

interface ProcessRow { pid: string; name: string; haystack: string }

function parseProcessRow(line: string): ProcessRow | null {
  if (process.platform === "win32") {
    const parts = line.split("\t");
    if (parts.length < 2 || !parts[0]!.trim()) return null;
    return { pid: parts[0]!.trim(), name: parts[1]!.trim(), haystack: parts.slice(2).join("\t") };
  }
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return { pid: parts[0]!, name: parts[1]!, haystack: parts.slice(2).join(" ") };
}

export function describeCheckoutHolders(checkout: string): string {
  const needle = normalizeForMatch(checkout);
  try {
    const result = run([...PROCESS_TABLE_PROBE], { stdout: "pipe", stderr: "ignore" });
    const holders = String(result.stdout ?? "").split(/\r?\n/)
      .map(parseProcessRow)
      .filter((row): row is ProcessRow => row !== null)
      .filter((row) => row.pid !== String(process.pid))
      .filter((row) => normalizeForMatch(row.haystack).includes(needle))
      // W-667 M6: the command line decides the match but is never reported. It
      // can carry tokens, absolute paths and arguments that do not belong in
      // failed_cleanups.jsonl or on stderr, so only pid and process name leave
      // this function — the same shape the Windows branch already used.
      .map((row) => `${row.pid} ${row.name}`);
    if (holders.length) return `; processes referencing this path: ${holders.slice(0, 6).join(" | ")}`;
    // W-667 F-16 (PM addenda 2026-09-02): ten dirs reported this way were all
    // removable immediately afterwards by `git worktree prune && rm -rf`, so a
    // stale worktree registration — not a handle lag — is the likelier cause.
    // Name the command that clears it instead of telling the operator to wait.
    return "; no running process references this path, so the likely cause is a stale worktree registration rather than a handle lock — NEXT_COMMAND: git worktree prune, then rerun this cleanup";
  } catch {
    return "; the process probe could not run, so the holder is unknown";
  }
}

async function removeCheckoutDir(
  gitRoot: string,
  checkout: string,
  force: boolean,
  selection: CheckoutSelection,
  diag?: { reason?: string },
): Promise<boolean> {
  let lastRemovalError = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (!existsSync(checkout)) return true;
    const measurement = measureCheckout(checkout, selection);
    if (!force && (measurement.kind === "measured-dirty" || measurement.kind === "measurement-error")) {
      if (diag) {
        diag.reason = measurement.kind === "measured-dirty"
          ? `worktree left in place: ${checkout} is DIRTY and --force-remove was not passed — inspect it, then rerun with --force-remove to discard the changes`
          : `worktree left in place: ${checkout} could not be measured (${measurement.kind}) — resolve that before removal is authorized`;
      }
      return false;
    }
    // Deliberately AFTER the refusal gate: the measurement decides whether this
    // checkout may be destroyed at all, and detaching is already a mutation.
    const detachment = detachReparsePoints(checkout);
    if (detachment.failed.length > 0) {
      err(
        `dispatch_cleanup: REFUSING to remove ${checkout} — ${detachment.failed.length} reparse point(s) could not be detached first, ` +
        `and the recursive removers here (git worktree remove, rmSync) can follow a link OUT of the checkout and delete its target: ` +
        `${detachment.failed.map((entry) => `${entry.path} (${entry.reason})`).join("; ")}.`,
      );
      if (diag) {
        diag.reason = `worktree left in place: ${detachment.failed.length} reparse point(s) under ${checkout} could not be detached — `
          + `${detachment.failed.map((entry) => `${entry.path} (${entry.reason})`).join("; ")}`;
      }
      return false;
    }
    if (detachment.detached.length > 0) {
      err(`dispatch_cleanup: detached ${detachment.detached.length} reparse point(s) before removing ${checkout} (link entries removed, targets untouched): ${detachment.detached.join(" | ")}`);
    }
    if (measurement.kind === "not-own-worktree") {
      try { rmSync(checkout, { recursive: true, force: true }); } catch (error) { lastRemovalError = (error as Error).message; }
      if (!existsSync(checkout)) return true;
      if (attempt < 4) await Bun.sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    git(gitRoot, ["worktree", "remove", ...(force ? ["--force"] : []), checkout], { stdout: "ignore", stderr: "ignore" });
    if (!existsSync(checkout)) {
      git(gitRoot, ["worktree", "prune"], { stdout: "ignore", stderr: "ignore" });
      return true;
    }
    // Recursive fallback is authorized only by an explicit measured-clean
    // result from this attempt, or by the caller's destructive override.
    if (force || measurement.kind === "measured-clean") {
      try { rmSync(checkout, { recursive: true, force: true }); } catch (error) { lastRemovalError = (error as Error).message; }
    }
    git(gitRoot, ["worktree", "prune"], { stdout: "ignore", stderr: "ignore" });
    if (!existsSync(checkout)) return true;
    if (attempt < 4) await Bun.sleep(500 * 2 ** (attempt - 1));
  }
  if (!existsSync(checkout)) return true;
  if (diag) {
    diag.reason = `worktree dir not removed after 4 attempts: ${checkout}`
      + (lastRemovalError ? ` — last OS error: ${lastRemovalError}` : "")
      + describeCheckoutHolders(checkout);
  }
  return false;
}

function appendFailedCleanup(failedFile: string, id: string, container: string, reason: string): void {
  try {
    mkdirSync(dirname(failedFile), { recursive: true });
    appendFileSync(failedFile, `${JSON.stringify({ ts: utcIsoSeconds(), dispatch_id: Number(id), container, reason: reason.replace(/"/g, "'") })}\n`);
  } catch { /* best effort */ }
}

function readStatus(path: string): string {
  try { return JSON.parse(readFileSync(path, "utf8"))?.status ?? ""; } catch {
    try { return readFileSync(path, "utf8").match(/"status"\s*:\s*"([^"]*)"/)?.[1] ?? ""; } catch { return ""; }
  }
}

function mergeStatusForBranch(gitRoot: string, branch: string, studio: string, baseSha: string, resultsDir: string): string {
  if (branch && studio) {
    const branchOk = git(gitRoot, ["rev-parse", "--verify", "-q", branch]).exitCode === 0;
    const studioOk = git(gitRoot, ["rev-parse", "--verify", "-q", studio]).exitCode === 0;
    let equalTipsWithoutBase = false;
    if (branchOk && studioOk) {
      const branchTip = gitOutput(gitRoot, ["rev-parse", "--verify", `${branch}^{commit}`]);
      const studioTip = gitOutput(gitRoot, ["rev-parse", "--verify", `${studio}^{commit}`]);
      const baseTip = baseSha ? gitOutput(gitRoot, ["rev-parse", "--verify", `${baseSha}^{commit}`]) : "";
      // A dispatch is unchanged only when its tip still equals the base it was
      // cut from. Comparing with studio misclassified a legitimate fast-forward
      // integration as no_changes after studio advanced to the role tip.
      if (branchTip && baseTip && branchTip === baseTip) return "no_changes";
      // Old containers may predate durable base_sha. Equal branch/studio tips
      // are then ambiguous (unchanged vs fast-forward-landed), so do not turn
      // ancestry alone into merge evidence; a gate result can still prove it.
      equalTipsWithoutBase = Boolean(branchTip && studioTip && branchTip === studioTip && !baseTip);
    }
    if (!equalTipsWithoutBase && branchOk && studioOk && git(gitRoot, ["merge-base", "--is-ancestor", branch, studio]).exitCode === 0) return "merged";
  }
  const slug = branch.split("/").at(-1) ?? "";
  let best = "none";
  if (slug && isDirectory(resultsDir)) {
    for (const name of readdirSync(resultsDir).filter((n) => n.endsWith(".json")).sort()) {
      const stem = name.replace(/\.json$/, "").replace(/\.summary$/, "");
      if (!stem.includes(slug)) continue;
      const status = readStatus(resolve(resultsDir, name));
      if (!status) continue;
      if (status === "success") return "success";
      best = status;
    }
  }
  return best;
}

/**
 * Branch history is advisory attribution only. Whether a landing is gated is
 * decided exclusively from studio's first-parent history and durable Control
 * gate evidence below; an expired or incomplete reflog cannot change it.
 */
type ReflogHistory =
  | { status: "available"; entries: Array<{ tip: string; subject: string }> }
  | { status: "unavailable" | "incomplete" };

function readReflogHistory(gitRoot: string, ref: string): ReflogHistory {
  const history = git(gitRoot, ["reflog", "show", "--format=%H%x00%gs", ref]);
  if (history.exitCode !== 0) return { status: "unavailable" };
  const entries: Array<{ tip: string; subject: string }> = [];
  for (const line of history.stdout.split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf("\0");
    if (separator <= 0) return { status: "incomplete" };
    const tip = line.slice(0, separator);
    if (!/^[0-9a-f]{40,64}$/.test(tip)) return { status: "incomplete" };
    entries.push({ tip, subject: line.slice(separator + 1) });
  }
  return { status: "available", entries };
}

type StudioFirstParentGateProof = {
  censusState: "resolved";
  method: "studio-first-parent-gate-census";
  baseTip: string;
  integrationTip: string;
  firstParentMergeCommits: string[];
  firstParentNonMergeCommits: string[];
  branchFirstParentNonMergeCommits: string[];
  gatedLandingCommits: string[];
  ungatedLandingCommits: string[];
  unattributedUngatedMergeCommits: string[];
};

type WorkAttributedUngatedLanding = UngatedMergeLanding & { landingCommit: string };

type RepositoryUngatedMergeFinding = {
  kind: "ungated-studio-first-parent-merge";
  landingCommit: string;
  integrationBranch: string;
  integrationTip: string;
};

type UngatedLandingAnalysis =
  | { censusState: "unknown"; reason: string }
  | {
      censusState: "ambiguous";
      method: "studio-first-parent-non-merge-census";
      baseTip: string;
      branchTip: string;
      integrationTip: string;
      firstParentNonMergeCommits: string[];
      branchFirstParentNonMergeCommits: string[];
    }
  | {
      censusState: "resolved";
      landings: WorkAttributedUngatedLanding[];
      nonLandingProof: StudioFirstParentGateProof;
      repositoryFindings: RepositoryUngatedMergeFinding[];
    };

function boundMergeGateCommits(
  roots: ReturnType<typeof garelierControlRoots>,
  controlSchema: 3,
): Set<string> | undefined {
  try {
    const entries: Array<[string, EvidenceReference[]]> = [...loadPlanGraphModel(roots.controlRoot).backlog]
      .map(([id, work]) => [id, planGraphEvidenceReferences(work)]);
    const commits = new Set<string>();
    for (const [workId, evidence] of entries) {
      for (const item of evidence) {
        if (item.kind !== "gate" || !item.commit || !item.path) continue;
        if (validateGateEvidence({ targetRoot: roots.targetRoot, controlRoot: roots.controlRoot }, workId, item).length) continue;
        const evidenceRoot = item.root === "target" ? roots.targetRoot : roots.controlRoot;
        const value = JSON.parse(readFileSync(resolve(evidenceRoot, ...item.path.split("/")), "utf8")) as Record<string, unknown>;
        if (value.kind === "merge_gate_evidence") commits.add(item.commit);
      }
    }
    return commits;
  } catch {
    return undefined;
  }
}

function attributedMergeParent(
  gitRoot: string,
  branch: string,
  branchTip: string,
  parents: readonly string[],
): { branch: string; branchTip: string; parentNumber: number } | null {
  let matchedTip = parents.includes(branchTip) ? branchTip : "";
  if (!matchedTip) {
    const history = readReflogHistory(gitRoot, branch);
    if (history.status === "available") matchedTip = history.entries.find((entry) => parents.includes(entry.tip))?.tip ?? "";
  }
  if (!matchedTip) return null;
  return {
    branch,
    branchTip: matchedTip,
    parentNumber: parents.indexOf(matchedTip) + 2,
  };
}

function reportRepositoryUngatedMergeFindings(
  findings: readonly RepositoryUngatedMergeFinding[],
  branch: string,
): void {
  for (const finding of findings) {
    err(
      `dispatch_cleanup: REPOSITORY FINDING — studio first-parent merge ${finding.landingCommit} has no bound merge-gate record, ` +
      `but is not positively attributed to '${branch}'. It is not recorded on the current Work and does not block this Work's cleanup.`,
    );
  }
}

/**
 * W-472 — inspect every merge on studio's first-parent line since the dispatch
 * base. A merge is ungated exactly when no validated durable merge-gate record
 * binds its commit. Branch tip/reflog data is consulted only after that decision
 * to establish a positive current-Work attribution. Unattributed merges remain
 * repository findings: they are never recorded on, or used to wedge, this Work.
 *
 * This is deliberately computed here rather than accepted from the caller:
 * "the PM says it merged" is not evidence. If every first-parent merge is gated,
 * the census proves there is no ungated merge landing in the dispatch interval.
 * A non-merge first-parent commit remains ambiguous when it is also in this
 * branch's history because it could be a manual fast-forward. Unrelated direct
 * studio commits do not make this Work ambiguous.
 *
 * The sanctioned merge gate always uses `--no-ff`. A branch-attributed
 * first-parent non-merge update cannot be accepted as a bypass because no merge
 * record exists to bind; it therefore remains ambiguous and fail-closed.
 */
function ungatedLanding(
  gitRoot: string,
  branch: string,
  integrationBranch: string,
  baseSha: string,
  roots: ReturnType<typeof garelierControlRoots>,
  controlSchema: 3,
): UngatedLandingAnalysis {
  if (!branch || !integrationBranch) return { censusState: "unknown", reason: "branch or integration ref is missing" };
  const branchTip = gitOutput(gitRoot, ["rev-parse", "--verify", "-q", `${branch}^{commit}`]);
  const integrationTip = gitOutput(gitRoot, ["rev-parse", "--verify", "-q", `${integrationBranch}^{commit}`]);
  const baseTip = baseSha ? gitOutput(gitRoot, ["rev-parse", "--verify", "-q", `${baseSha}^{commit}`]) : "";
  if (![branchTip, integrationTip, baseTip].every((commit) => /^[0-9a-f]{40,64}$/.test(commit))) {
    return { censusState: "unknown", reason: "branch, integration, or base commit cannot be resolved" };
  }
  if (git(gitRoot, ["merge-base", "--is-ancestor", baseTip, integrationTip]).exitCode !== 0) {
    return { censusState: "unknown", reason: "dispatch base is not an ancestor of the integration tip" };
  }
  const range = `${baseTip}..${integrationTip}`;
  const mergeHistory = git(gitRoot, ["log", "--format=%H %P", "--first-parent", "--merges", range]);
  const directHistory = git(gitRoot, ["rev-list", "--first-parent", "--no-merges", range]);
  const branchHistory = git(gitRoot, ["rev-list", branchTip]);
  const gatedCommits = boundMergeGateCommits(roots, controlSchema);
  if (mergeHistory.exitCode !== 0 || directHistory.exitCode !== 0 || branchHistory.exitCode !== 0) {
    return { censusState: "unknown", reason: "git could not read the required first-parent or branch history" };
  }
  if (!gatedCommits) return { censusState: "unknown", reason: "bound merge-gate evidence could not be read" };
  const commitList = (output: string): string[] => output.trim() ? output.trim().split(/\r?\n/) : [];
  const firstParentNonMergeCommits = commitList(directHistory.stdout);
  const branchCommits = commitList(branchHistory.stdout);
  if ([...firstParentNonMergeCommits, ...branchCommits].some((commit) => !/^[0-9a-f]{40,64}$/.test(commit))) {
    return { censusState: "unknown", reason: "git returned malformed first-parent or branch history" };
  }
  const branchCommitSet = new Set(branchCommits);
  const branchFirstParentNonMergeCommits = firstParentNonMergeCommits.filter((commit) => branchCommitSet.has(commit));
  if (branchFirstParentNonMergeCommits.length) {
    return {
      censusState: "ambiguous",
      method: "studio-first-parent-non-merge-census",
      baseTip,
      branchTip,
      integrationTip,
      firstParentNonMergeCommits,
      branchFirstParentNonMergeCommits,
    };
  }
  const lines = mergeHistory.stdout.trim() ? mergeHistory.stdout.trim().split(/\r?\n/) : [];
  const firstParentMergeCommits: string[] = [];
  const gatedLandingCommits: string[] = [];
  const ungatedLandingCommits: string[] = [];
  const unattributedUngatedMergeCommits: string[] = [];
  const landings: WorkAttributedUngatedLanding[] = [];
  const repositoryFindings: RepositoryUngatedMergeFinding[] = [];
  for (const line of lines) {
    const commits = line.trim().split(/\s+/);
    if (commits.length < 3 || commits.some((commit) => !/^[0-9a-f]{40,64}$/.test(commit))) {
      return { censusState: "unknown", reason: "git returned malformed first-parent merge history" };
    }
    const landingCommit = commits[0]!;
    firstParentMergeCommits.push(landingCommit);
    if (gatedCommits.has(landingCommit)) {
      gatedLandingCommits.push(landingCommit);
      continue;
    }
    ungatedLandingCommits.push(landingCommit);
    const attribution = attributedMergeParent(gitRoot, branch, branchTip, commits.slice(2));
    if (attribution) {
      landings.push({
        ...attribution, integrationBranch, integrationTip,
        landingKind: "merge-parent", landingCommit,
      });
    } else {
      unattributedUngatedMergeCommits.push(landingCommit);
      repositoryFindings.push({
        kind: "ungated-studio-first-parent-merge",
        landingCommit,
        integrationBranch,
        integrationTip,
      });
    }
  }
  return { censusState: "resolved", landings, repositoryFindings, nonLandingProof: {
    censusState: "resolved",
    method: "studio-first-parent-gate-census",
    baseTip,
    integrationTip,
    firstParentMergeCommits,
    firstParentNonMergeCommits,
    branchFirstParentNonMergeCommits,
    gatedLandingCommits,
    ungatedLandingCommits,
    unattributedUngatedMergeCommits,
  } };
}

/**
 * W-318 — `sessionId` is REQUIRED to match the result's `control_session_id`.
 *
 * Matching on work_id alone selected results this dispatch cannot actually use:
 * `captureSuccessfulMergeEvidence` re-checks the session binding and hard-fails,
 * so a result gated under an earlier session (a rework that re-bound the
 * container, or a merge driven with explicit --work-id/--control-session)
 * produced a non-null result that could only ever throw — another dead end with
 * no command to clear it. A result not bound to this session is not evidence for
 * this dispatch; treating it as absent lets the ancestry recovery path below
 * handle it instead.
 */
function successfulControlResult(
  resultsDir: string,
  workId: string,
  sessionId: string,
  branch: string,
  branchTip: string,
  gitRoot: string,
  studioBranch: string,
): { path: string; requestPath: string; value: Record<string, unknown>; request: Record<string, unknown> } | null {
  if (!branch || !/^[0-9a-f]{40,64}$/.test(branchTip)) return null;
  if (!isDirectory(resultsDir)) return null;
  const matches: { path: string; requestPath: string; value: Record<string, unknown>; request: Record<string, unknown> }[] = [];
  for (const name of readdirSync(resultsDir).filter((entry) => entry.endsWith(".json") && !entry.endsWith(".summary.json")).sort()) {
    const path = resolve(resultsDir, name);
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (value.status !== "success" || value.work_id !== workId || value.control_session_id !== sessionId
        || value.workbench_branch !== branch || value.workbench_tip !== branchTip
        || typeof value.studio_commit !== "string" || !/^[0-9a-f]{40,64}$/.test(value.studio_commit)) continue;
      const stem = path.replace(/\.json$/, "").split(/[\\/]/).at(-1)!;
      const requestPath = resolve(resultsDir, "..", "archive", `${stem}.request.json`);
      const request = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
      if (request.request_id !== value.request_id || request.workbench_branch !== branch || request.workbench_tip !== branchTip
        || request.work_id !== workId || request.control_session_id !== sessionId) continue;
      if (git(gitRoot, ["merge-base", "--is-ancestor", branchTip, value.studio_commit], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) continue;
      if (studioBranch && git(gitRoot, ["merge-base", "--is-ancestor", value.studio_commit, studioBranch], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) continue;
      matches.push({ path, requestPath, value, request });
    } catch { /* malformed results are not evidence */ }
  }
  const selected = matches.at(-1);
  if (!selected) return null;
  return selected;
}

function transcribeReport(src: string, dst: string): boolean {
  if (!src) return false;
  if (!existsSync(src)) {
    err(`dispatch_cleanup: --report-from-file '${src}' not found; leaving report.md as-is`);
    return false;
  }
  try {
    const body = `<!-- transcribed from the role register by dispatch_cleanup --report-from-file (W-019):\n` +
      `     the compact register message is the canonical record when the harness blocked\n` +
      `     report.md writes. Source: ${src} -->\n\n${readFileSync(src, "utf8")}`;
    writeFileSync(dst, body);
    return true;
  } catch {
    err(`dispatch_cleanup: could not write ${dst} from --report-from-file '${src}'`);
    return false;
  }
}

function readIntegration(projectRoot: string, pmId: string): string {
  try { return loadConfig(projectRoot, pmId).branches.integration; }
  catch { return ""; }
}

interface CleanupControlIdentity {
  workId: string;
  sessionId: string;
  touches: string[];
  baseSha: string;
  claimOwned: boolean;
  source: "context.json" | "control_binding.json" | "role_authorization" | "STATE.md";
}

/** The bound Work id for artifact preservation only (W-741). Removal authority
 * still comes from cleanupControlIdentity's fail-closed binding check; an
 * unreadable binding here just files the preserved evidence under `unassigned`
 * rather than losing it. */
function containerWorkId(container: string): string {
  for (const file of ["control_binding.json", "context.json"] as const) {
    try {
      const value = JSON.parse(readFileSync(resolve(container, file), "utf8")) as
        { work_id?: unknown; control?: { work_id?: unknown } };
      const workId = typeof value.work_id === "string" ? value.work_id : value.control?.work_id;
      if (typeof workId === "string" && /^W-\d+$/.test(workId)) return workId;
    } catch { /* fall through to the next source, then to "unassigned" */ }
  }
  return "";
}

function dispatchBaseSha(container: string): string {
  try {
    const value = JSON.parse(readFileSync(resolve(container, "control_binding.json"), "utf8")) as Record<string, unknown>;
    if (typeof value.base_sha === "string" && value.base_sha) return value.base_sha;
  } catch { /* cleanupControlIdentity owns fail-closed binding validation */ }
  try {
    const value = JSON.parse(readFileSync(resolve(container, "context.json"), "utf8")) as { task?: { base_sha?: unknown } };
    if (typeof value.task?.base_sha === "string" && value.task.base_sha) return value.task.base_sha;
  } catch { /* report scaffold remains a compatibility fallback */ }
  const reportBase = readText(resolve(container, "report.md")).match(/^- Base SHA:\s*(\S+)\s*$/m)?.[1] ?? "";
  if (reportBase) return reportBase;
  return "";
}

/** Resolve the claim authority independently of the best-effort context pack.
 * dispatch_prepare claims before building context.json, so it persists the
 * minimal binding first. A missing/corrupt context may fall back to that exact
 * dispatch-id binding; conflicting or absent identities never authorize
 * container removal. */
function cleanupControlIdentity(
  container: string,
  dispatchId: string,
  schema: 3,
  projectRoot: string,
  pmId: string,
): CleanupControlIdentity | null {
  let contextIdentity: CleanupControlIdentity | null = null;
  try {
    const value = JSON.parse(readFileSync(resolve(container, "context.json"), "utf8")) as {
      control?: { schema_version?: unknown; work_id?: unknown; session_id?: unknown; claim_owned?: unknown };
      task?: { touches?: unknown; base_sha?: unknown };
    };
    if (typeof value.control?.work_id === "string" && typeof value.control.session_id === "string") {
      if (value.control.schema_version !== schema) throw new Error("context control schema does not match the active project schema");
      if (value.control.claim_owned !== undefined && typeof value.control.claim_owned !== "boolean") {
        throw new Error("context control claim_owned must be boolean when present");
      }
      contextIdentity = {
        workId: value.control.work_id,
        sessionId: value.control.session_id,
        touches: Array.isArray(value.task?.touches) ? value.task.touches.filter((item): item is string => typeof item === "string") : [],
        baseSha: typeof value.task?.base_sha === "string" ? value.task.base_sha : "",
        claimOwned: value.control.claim_owned !== false,
        source: "context.json",
      };
    }
  } catch (error) {
    if (existsSync(resolve(container, "context.json")) && !existsSync(resolve(container, "control_binding.json"))) {
      throw new Error(`context.json is unreadable and no pre-context binding survives: ${(error as Error).message}`);
    }
  }

  let durableIdentity: CleanupControlIdentity | null = null;
  const bindingPath = resolve(container, "control_binding.json");
  if (existsSync(bindingPath)) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(readFileSync(bindingPath, "utf8")) as Record<string, unknown>; }
    catch (error) { throw new Error(`control_binding.json is unreadable: ${(error as Error).message}`); }
    if (value.schema_version !== schema || String(value.dispatch_id ?? "") !== dispatchId
      || typeof value.work_id !== "string" || !/^W-\d+$/.test(value.work_id)
      || typeof value.session_id !== "string" || !value.session_id
      || !Array.isArray(value.touches) || value.touches.some((item) => typeof item !== "string")
      || (value.base_sha !== undefined && (typeof value.base_sha !== "string" || !/^[0-9a-f]{40,64}$/.test(value.base_sha)))) {
      throw new Error("control_binding.json does not exactly bind this dispatch/schema/Work/session/touches/base_sha");
    }
    durableIdentity = {
      workId: value.work_id,
      sessionId: value.session_id,
      touches: value.touches as string[],
      baseSha: typeof value.base_sha === "string" ? value.base_sha : "",
      claimOwned: true,
      source: "control_binding.json",
    };
  }
  if (contextIdentity && durableIdentity
    && (contextIdentity.workId !== durableIdentity.workId || contextIdentity.sessionId !== durableIdentity.sessionId)) {
    throw new Error("context.json conflicts with the pre-context control binding");
  }
  if (contextIdentity && durableIdentity && !contextIdentity.claimOwned) {
    throw new Error("context.json denies claim ownership but control_binding.json declares it");
  }
  if (contextIdentity && durableIdentity) return { ...contextIdentity, baseSha: durableIdentity.baseSha };
  const resolvedIdentity = contextIdentity ?? durableIdentity;
  if (resolvedIdentity) return resolvedIdentity;

  // Current dispatches also carry a coordinator-issued role authorization
  // outside the producer-owned container. It is the exact recovery authority
  // when a crash or manual incident removed both advisory context files.
  try {
    const authorization = readCurrentRoleAuthorization({
      project_root: projectRoot,
      pm_id: pmId,
      identity: dispatchExecutionIdentity(dispatchId),
    });
    if (/^W-\d+$/.test(authorization.core.item.work_id) && authorization.core.item.session_id) {
      return {
        workId: authorization.core.item.work_id,
        sessionId: authorization.core.item.session_id,
        touches: [],
        baseSha: authorization.core.integration.base_sha,
        claimOwned: true,
        source: "role_authorization",
      };
    }
  } catch { /* absence leaves the landed-only recovery predicate below */ }

  // W-502: gate preparation creates STATE.md before context/control binding.
  // A crash in that window has no Work/session claim to release. Accept only an
  // exact no-checkout gate-role header; a role-shaped or ambiguous shell
  // remains fail-closed because it may have claim authority we cannot identify.
  const statePath = resolve(container, "STATE.md");
  if (!existsSync(resolve(container, "checkout")) && existsSync(statePath)) {
    const state = readFileSync(statePath, "utf8");
    const header = new RegExp(`^#\\s*Dispatch\\s+#${dispatchId}\\s+-\\s+(scout|observer|guardian)\\s+\\S+\\s*$`, "m");
    if (header.test(state)) {
      return { workId: "", sessionId: "", touches: [], baseSha: "", claimOwned: false, source: "STATE.md" };
    }
  }
  return null;
}

/**
 * Lane slugs owned by a LIVE canonical `_crew/dispatch<N>` container — read from
 * each container's context.json task.slug. A present container means its lane is
 * still running, so its `runtime/scratch/<slug>` must survive the orphan sweep.
 * Best-effort: a missing / corrupt context.json contributes no slug.
 */
interface ActiveDispatchInventory { slugs: Set<string>; branches: Set<string>; }

function activeDispatchInventory(pmRoot: string): ActiveDispatchInventory {
  const slugs = new Set<string>();
  const branches = new Set<string>();
  for (const record of readDispatchContainerRecords(pmRoot)) {
    if (record.slug) slugs.add(record.slug);
    if (record.branch) branches.add(record.branch);
  }
  return { slugs, branches };
}

type SweepStatus = "reclaimed" | "kept" | "skipped";

interface FailedCleanupSweepEntry {
  dispatch_id: number | null;
  container: string;
  status: SweepStatus;
  missing_conditions: string[];
}

interface GateSeatSweepEntry {
  id: number;
  role: "guardian" | "observer";
  slug: string | null;
  status: "reclaimed" | "kept";
  missing_conditions: string[];
  predicates: {
    verdict_file: boolean;
    checkout_absent: boolean;
    claim_not_live: boolean;
  };
  removal_error?: string;
}

function gateSeatClaimLive(
  roots: ReturnType<typeof garelierControlRoots>,
  controlSchema: number | null,
  workId: string | null,
): boolean | null {
  // Missing canonical Control is not affirmative evidence that a claim is
  // absent: legacy/corrupt runtime claim files may still exist. Keep the seat.
  if (controlSchema === null) return null;
  if (controlSchema !== 3 || !workId) return null;
  try {
    const namespace = resolveControlNamespace({
      targetRoot: roots.targetRoot,
      pmId: roots.pmId,
      controlRoot: roots.controlRoot,
      runtimeRoot: roots.runtimeRoot,
    });
    const claim = readControlClaim(namespace, workId);
    return claim !== null && Date.parse(claim.expires_at) > Date.now();
  } catch { return null; }
}

/** W-530: no-worktree gate seats never reach land aftercare. Reclaim only the
 * exact three-way conjunction: durable regular verdict file, absent checkout
 * entry, and a control claim proven not live. The verdict lives outside the
 * container and is deliberately never archived or removed here. */
function sweepTerminalGateSeats(
  pmRoot: string,
  roots: ReturnType<typeof garelierControlRoots>,
  controlSchema: number | null,
): GateSeatSweepEntry[] {
  const results: GateSeatSweepEntry[] = [];
  for (const record of readDispatchContainerRecords(pmRoot)) {
    if (record.role !== "guardian" && record.role !== "observer") continue;
    const role = record.role;
    const resultRoot = resolve(pmRoot, "runtime", role, "results");
    const verdictPath = record.slug ? resolve(pmRoot, seatReportPath(role, record.slug)) : "";
    const verdictRelative = verdictPath ? relative(resultRoot, verdictPath) : "..";
    const verdictInside = verdictPath !== ""
      && verdictRelative !== ""
      && !verdictRelative.startsWith("..")
      && !isAbsolute(verdictRelative);
    const claimLive = gateSeatClaimLive(roots, controlSchema, record.work_id);
    const predicates = {
      // A reused slug can leave an older verdict at the canonical result path.
      // It is evidence for this seat only when written after this container was
      // dispatched; an old result must never make a fresh gate seat look done.
      verdict_file: verdictInside && isRegularFileAtOrAfter(verdictPath, resolve(record.container, "dispatched_at")),
      checkout_absent: !pathEntryExists(record.checkout),
      claim_not_live: claimLive === false,
    };
    const missingConditions = (Object.entries(predicates) as Array<[keyof typeof predicates, boolean]>)
      .filter(([, satisfied]) => !satisfied)
      .map(([name]) => name);
    const result: GateSeatSweepEntry = {
      id: Number(record.id), role, slug: record.slug, status: "kept",
      missing_conditions: missingConditions, predicates,
    };
    if (missingConditions.length === 0) {
      try {
        removeTreeSync(record.container);
        if (!pathEntryExists(record.container)) result.status = "reclaimed";
        else result.removal_error = "container still exists after removal";
      } catch (error) {
        result.removal_error = (error as Error).message;
      }
    }
    results.push(result);
  }
  return results;
}

/**
 * Remove orphaned `runtime/scratch/<slug>` lane dirs — role intermediate
 * output (dispatch_prompt_craft.md §1.8) that survives container cleanup and
 * otherwise piles up in the retention gap (W-084(a); a live project measured a
 * single lane's 1.8GB scratch surviving 8 days). A top-level scratch entry is
 * orphaned iff NO live dispatch container still owns its slug; a slug an active
 * dispatch still owns is preserved. Returns swept + kept top-level names.
 */
function sweepOrphanScratch(pmRoot: string, activeSlugs: Set<string>): { swept: string[]; kept: string[] } {
  const scratchRoot = resolve(pmRoot, "runtime", "scratch");
  const swept: string[] = [];
  const kept: string[] = [];
  let names: string[];
  try { names = readdirSync(scratchRoot); } catch { return { swept, kept }; }
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (activeSlugs.has(name)) { kept.push(name); continue; }
    // W-380: role scratch is exactly where a junction gets parked.
    try { removeTreeSync(resolve(scratchRoot, name)); swept.push(name); }
    catch { kept.push(name); }
  }
  return { swept, kept };
}

interface WorktreeBranchState { branch: string; dirty: boolean; }

/** One `git worktree list` inventory is the authority for checked-out branches. */
function worktreeBranchInventory(gitRoot: string): WorktreeBranchState[] | null {
  const listed = git(gitRoot, ["worktree", "list", "--porcelain"]);
  if (listed.exitCode !== 0) return null;
  const entries: { path: string; branch: string }[] = [];
  let path = "", branch = "";
  const flush = () => {
    if (path && branch) entries.push({ path, branch: branch.replace(/^refs\/heads\//, "") });
    path = ""; branch = "";
  };
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { flush(); path = line.slice("worktree ".length).trim(); }
    else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim();
  }
  flush();
  return entries.map(({ path: worktree, branch: worktreeBranch }) => {
    const status = git(worktree, ["status", "--porcelain", "--untracked-files=all"]);
    return { branch: worktreeBranch, dirty: status.exitCode !== 0 || Boolean(status.stdout.trim()) };
  });
}

interface MergeGateSnapshot { fingerprint: string; references: string; }

function readableDirectorySnapshot(dir: string): { fingerprint: string[]; references: string[] } | null {
  let names: string[];
  try { names = readdirSync(dir).sort((a, b) => a.localeCompare(b)); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { fingerprint: [], references: [] } : null;
  }
  const fingerprint: string[] = [];
  const references: string[] = [];
  for (const name of names) {
    const path = resolve(dir, name);
    try {
      const body = readFileSync(path, "utf8");
      fingerprint.push(`${path}\0${body}`);
      references.push(body);
    } catch { return null; }
  }
  return { fingerprint, references };
}

/**
 * Read one fail-closed merge-gate snapshot.
 *
 * The active request moves requests/<stem>.json -> archive/<stem>.request.json
 * before active.lock is cleared. Resolve both locations while the lock exists;
 * malformed/unreadable state is not evidence that a branch is unused.
 */
function mergeGateSnapshot(pmRoot: string): MergeGateSnapshot | null {
  const root = resolve(pmRoot, "runtime", "merge_gate");
  const fingerprint: string[] = [];
  const references: string[] = [];
  const lockPath = resolve(root, "locks", "active.lock");
  if (existsSync(lockPath)) {
    let lockBody = "";
    let requestFile = "";
    try {
      lockBody = readFileSync(lockPath, "utf8");
      const lock = JSON.parse(lockBody) as Record<string, unknown>;
      requestFile = typeof lock.request_file === "string" ? lock.request_file : "";
      if (!/^[^/\\]+\.json$/.test(requestFile)) return null;
    } catch { return null; }
    const stem = requestFile.replace(/\.json$/, "");
    const requestPaths = [
      resolve(root, "requests", requestFile),
      resolve(root, "archive", `${stem}.request.json`),
    ];
    let requestBody: string | null = null;
    let requestPath = "";
    for (const path of requestPaths) {
      try {
        requestBody = readFileSync(path, "utf8");
        requestPath = path;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
    }
    if (requestBody === null) return null;
    fingerprint.push(`${lockPath}\0${lockBody}`, `${requestPath}\0${requestBody}`);
    references.push(lockBody, requestBody);
  }
  for (const dir of [resolve(root, "requests"), resolve(root, "retry")]) {
    const snapshot = readableDirectorySnapshot(dir);
    if (!snapshot) return null;
    fingerprint.push(...snapshot.fingerprint);
    references.push(...snapshot.references);
  }
  return { fingerprint: fingerprint.join("\n"), references: references.join("\n") };
}

interface BranchRetirementAuthority {
  workId: string;
  workStatus: string;
  workPath: string;
  round: number;
  landedRound: number;
  gateEvidenceId: string;
}

interface BranchRetirementReceipt {
  branch: string;
  tip_sha: string;
  work_id: string;
  landed_round: number;
  recovery_ref: string;
  record_path: string;
}

interface BranchSweepResult {
  swept: string[];
  failed: string[];
  kept: number;
  skipped: Record<string, number>;
  retirements: BranchRetirementReceipt[];
}

type ControlRoundState =
  | { kind: "open" }
  | { kind: "landed-round-missing" }
  | { kind: "landed-round-ambiguous" }
  | { kind: "authorized"; status: string; path: string; landedRound: number; gateEvidenceId: string };

interface RoundTokenIdentity { workId: string; round: number; index: number; }

/** One parser for branch slugs and embedded gate ids: w<N>-r<n>[suffix]. */
function roundTokenIdentities(value: string): RoundTokenIdentity[] {
  const identities: RoundTokenIdentity[] = [];
  const pattern = /(^|[^a-z0-9])(w(\d+)-r([1-9]\d*)[a-z]*)(?=$|[^a-z0-9])/gi;
  for (const match of value.matchAll(pattern)) {
    identities.push({
      workId: `W-${match[3]}`,
      round: Number(match[4]),
      index: (match.index ?? 0) + match[1]!.length,
    });
  }
  return identities;
}

function roundBranchIdentity(branch: string): { workId: string; round: number } | null {
  const slug = branch.split("/").at(-1) ?? "";
  const identity = roundTokenIdentities(slug).find((item) => item.index === 0);
  return identity ? { workId: identity.workId, round: identity.round } : null;
}

/**
 * W-586: a terminal row's validated typed gate evidence is the sole authority
 * for identifying the landed round. Git ancestry/patch equivalence cannot do
 * this because a later round commonly rewrites the superseded round's patch.
 */
function controlRoundStates(
  roots: ReturnType<typeof garelierControlRoots>,
  requestedWorkIds: ReadonlySet<string>,
): Map<string, ControlRoundState> | null {
  try {
    const model = loadPlanGraphModel(roots.controlRoot);
    const states = new Map<string, ControlRoundState>();
    for (const workId of requestedWorkIds) {
      const work = model.backlog.get(workId);
      if (!work) continue;
      if (!CLOSED_WORK_STATES.has(work.status)) {
        states.set(workId, { kind: "open" });
        continue;
      }
      const landed = new Map<number, string>();
      for (const evidence of planGraphEvidenceReferences(work)) {
        if (evidence.kind !== "gate" || !evidence.id || !evidence.path) continue;
        const round = roundTokenIdentities(evidence.id).find((item) => item.workId === workId);
        if (!round) continue;
        if (validateGateEvidence({ targetRoot: roots.targetRoot, controlRoot: roots.controlRoot }, workId, evidence).length) continue;
        const evidenceRoot = evidence.root === "target" ? roots.targetRoot : roots.controlRoot;
        const gate = JSON.parse(readFileSync(resolve(evidenceRoot, ...evidence.path.split("/")), "utf8")) as Record<string, unknown>;
        if (gate.kind !== "merge_gate_evidence") continue;
        landed.set(round.round, evidence.id);
      }
      if (landed.size === 0) states.set(workId, { kind: "landed-round-missing" });
      else if (landed.size > 1) states.set(workId, { kind: "landed-round-ambiguous" });
      else {
        const [landedRound, gateEvidenceId] = [...landed][0]!;
        states.set(workId, {
          kind: "authorized",
          status: work.status,
          path: work.path,
          landedRound,
          gateEvidenceId,
        });
      }
    }
    return states;
  } catch {
    return null;
  }
}

function immutableControlRecord(controlRoot: string, path: string, record: Record<string, unknown>): void {
  const expected = canonicalJson(record);
  assertNoSymlinkPath(controlRoot, path, false);
  ensureSafeDirectory(controlRoot, dirname(path));
  const verifyExisting = (): boolean => {
    if (!existsSync(path)) return false;
    assertNoSymlinkPath(controlRoot, path);
    if (!lstatSync(path).isFile()) throw new Error(`branch retirement record is not a regular file: ${path}`);
    if (readFileSync(path, "utf8") !== expected) throw new Error(`branch retirement record identity conflict: ${path}`);
    return true;
  };
  if (verifyExisting()) return;
  try { writeFileSync(path, expected, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !verifyExisting()) throw error;
  }
}

function branchRetirementRecords(
  roots: ReturnType<typeof garelierControlRoots>,
  authority: BranchRetirementAuthority,
  branch: string,
  tip: string,
): { authorizationPath: string; receiptPath: string; recoveryRef: string; authorization: Record<string, unknown> } {
  const identity = sha256(branch).slice("sha256:".length);
  const recoveryRef = `refs/garelier/retired/${roots.pmId}/${authority.workId}/${identity}`;
  const directory = resolve(roots.controlRoot, "reports", "branch_retirements", authority.workId, identity);
  const authorizationPath = resolve(directory, "authorization.json");
  const receiptPath = resolve(directory, "receipt.json");
  const relativeAuthorization = relative(roots.controlRoot, authorizationPath).replace(/\\/g, "/");
  const relativeReceipt = relative(roots.controlRoot, receiptPath).replace(/\\/g, "/");
  const authorization = {
    schema_version: 1,
    kind: "garelier_branch_retirement_authorization",
    status: "authorized",
    work_id: authority.workId,
    work_status: authority.workStatus,
    branch,
    tip_sha: tip,
    round: authority.round,
    landed_round: authority.landedRound,
    gate_evidence_id: authority.gateEvidenceId,
    control_row: authority.workPath,
    recovery_ref: recoveryRef,
    deletion: { argv: ["git", "update-ref", "--no-deref", "-d", `refs/heads/${branch}`, tip] },
    restore: { argv: ["git", "branch", branch, tip] },
  };
  immutableControlRecord(roots.controlRoot, authorizationPath, authorization);
  return { authorizationPath: relativeAuthorization, receiptPath: relativeReceipt, recoveryRef, authorization };
}

/** W-274/W-586: canonical disposable families, proven by Git or terminal Control authority. */
function sweepRetirableBranches(
  gitRoot: string,
  projectRoot: string,
  pmId: string,
  activeDispatchBranches: Set<string>,
  retireSuperseded: boolean,
): BranchSweepResult {
  const skipped: Record<string, number> = {};
  const skip = (reason: string): void => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  const retirements: BranchRetirementReceipt[] = [];
  let target = "", integration = "";
  try {
    const branches = loadConfig(projectRoot, pmId).branches;
    target = branches.target;
    integration = branches.integration;
  } catch {
    skip("config_unreadable");
    return { swept: [], failed: [], kept: 0, skipped, retirements };
  }
  if (!integration || git(gitRoot, ["rev-parse", "--verify", "-q", `${integration}^{commit}`]).exitCode !== 0) {
    skip("no_studio");
    return { swept: [], failed: [], kept: 0, skipped, retirements };
  }
  const namespace = integration.endsWith("/studio") ? integration.slice(0, -"studio".length) : "";
  if (!namespace) { skip("invalid_studio"); return { swept: [], failed: [], kept: 0, skipped, retirements }; }
  const localResult = git(gitRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  if (localResult.exitCode !== 0) {
    skip("branch_inventory_failed");
    return { swept: [], failed: [], kept: 0, skipped, retirements };
  }
  const local = localResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const mergedResult = git(gitRoot, ["branch", "--merged", integration, "--format=%(refname:short)"]);
  if (mergedResult.exitCode !== 0) {
    skip("merged_inventory_failed");
    return { swept: [], failed: [], kept: 0, skipped, retirements };
  }
  const merged = new Set(mergedResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const worktrees = worktreeBranchInventory(gitRoot);
  if (!worktrees) { skip("worktree_inventory_failed"); return { swept: [], failed: [], kept: 0, skipped, retirements }; }
  const worktreeState = new Map(worktrees.map((entry) => [entry.branch, entry]));
  const candidate = (branch: string): boolean => branch.startsWith(`${namespace}workbench/`)
    || branch.startsWith(`${namespace}satchel/`)
    || branch.startsWith("garelier/isolate/")
    || /^__studio_[^/]+$/.test(branch);
  const candidateCount = local.filter(candidate).length;
  const gateState = mergeGateSnapshot(resolve(projectRoot, "__garelier", pmId));
  if (!gateState) {
    skipped.gate_inventory_failed = candidateCount;
    return { swept: [], failed: [], kept: candidateCount, skipped, retirements };
  }
  const controlRoots = garelierControlRoots(projectRoot, gitRoot, pmId);
  const requestedWorkIds = retireSuperseded
    ? new Set(local.map(roundBranchIdentity).filter((item) => item !== null).map((item) => item.workId))
    : new Set<string>();
  const roundStates = retireSuperseded ? controlRoundStates(controlRoots, requestedWorkIds) : null;
  const deletable: string[] = [];
  const retirementDeletable: Array<{ branch: string; tip: string; authority: BranchRetirementAuthority }> = [];
  let kept = 0;
  for (const branch of local) {
    if (!candidate(branch)) continue;
    if (branch === target || branch === integration) { kept++; skip("protected"); continue; }
    const worktree = worktreeState.get(branch);
    if (worktree?.dirty) { kept++; skip("dirty"); continue; }
    if (worktree) { kept++; skip("checked_out"); continue; }
    if (activeDispatchBranches.has(branch)) { kept++; skip("active_dispatch"); continue; }
    if (gateState.references.includes(branch)) { kept++; skip("gate_referenced"); continue; }
    const round = roundBranchIdentity(branch);
    if (round && retireSuperseded) {
      if (!roundStates) {
        if (!merged.has(branch)) { kept++; skip("control_unreadable"); continue; }
      } else {
        const control = roundStates.get(round.workId);
        if (!control) {
          if (!merged.has(branch)) { kept++; skip("control_row_missing"); continue; }
        } else if (control.kind === "open") {
          if (!merged.has(branch)) { kept++; skip("control_row_open"); continue; }
        } else if (control.kind === "landed-round-missing") {
          if (!merged.has(branch)) { kept++; skip("control_landed_round_missing"); continue; }
        } else if (control.kind === "landed-round-ambiguous") {
          kept++; skip("control_landed_round_ambiguous"); continue;
        } else if (round.round === control.landedRound) {
          if (!merged.has(branch)) { kept++; skip("landed_round"); continue; }
        } else {
          const tip = gitOutput(gitRoot, ["rev-parse", "--verify", `${branch}^{commit}`]);
          if (!/^[0-9a-f]{40,64}$/.test(tip)) { kept++; skip("branch_tip_unreadable"); continue; }
          retirementDeletable.push({
            branch,
            tip,
            authority: {
              workId: round.workId,
              workStatus: control.status,
              workPath: control.path,
              round: round.round,
              landedRound: control.landedRound,
              gateEvidenceId: control.gateEvidenceId,
            },
          });
          continue;
        }
      }
    }
    if (!merged.has(branch)) { kept++; skip("unmerged"); continue; }
    deletable.push(branch);
  }
  if (deletable.length === 0 && retirementDeletable.length === 0) return { swept: [], failed: [], kept, skipped, retirements };
  const finalGateState = mergeGateSnapshot(resolve(projectRoot, "__garelier", pmId));
  if (!finalGateState || finalGateState.fingerprint !== gateState.fingerprint) {
    const changed = [...deletable, ...retirementDeletable.map((item) => item.branch)];
    skipped.gate_inventory_changed = changed.length;
    return { swept: [], failed: changed, kept, skipped, retirements };
  }
  // Existing ancestry-proven refs retain the one non-force batch deletion. A
  // control-authorized superseded ref uses the existing exact-tip CAS deletion
  // primitive; no producer-facing `git branch -D` capability is introduced.
  const deletion = deletable.length
    ? git(gitRoot, ["branch", "-d", ...deletable], { stdout: "ignore", stderr: "ignore" })
    : { exitCode: 0, stdout: "", stderr: "" };
  const retirementFailed: string[] = [];
  const retirementSwept: string[] = [];
  for (const item of retirementDeletable) {
    let records: ReturnType<typeof branchRetirementRecords>;
    try { records = branchRetirementRecords(controlRoots, item.authority, item.branch, item.tip); }
    catch (error) {
      kept++; skip("retirement_record_failed");
      err(`dispatch_cleanup: retaining '${item.branch}' because its Control retirement authorization could not be recorded: ${(error as Error).message}`);
      continue;
    }
    const preservedTip = gitOutput(gitRoot, ["rev-parse", "--verify", records.recoveryRef]);
    if (preservedTip && preservedTip !== item.tip) {
      kept++; skip("recovery_ref_conflict");
      err(`dispatch_cleanup: retaining '${item.branch}' because recovery ref '${records.recoveryRef}' points to ${preservedTip}, not ${item.tip}`);
      continue;
    }
    if (!preservedTip) {
      const preserve = git(gitRoot, ["update-ref", "--no-deref", records.recoveryRef, item.tip, "0".repeat(item.tip.length)], { stdout: "ignore", stderr: "ignore" });
      if (preserve.exitCode !== 0 || gitOutput(gitRoot, ["rev-parse", "--verify", records.recoveryRef]) !== item.tip) {
        kept++; skip("recovery_ref_failed");
        err(`dispatch_cleanup: retaining '${item.branch}' because recovery ref '${records.recoveryRef}' could not be created at ${item.tip}`);
        continue;
      }
    }
    const deleted = git(gitRoot, ["update-ref", "--no-deref", "-d", `refs/heads/${item.branch}`, item.tip], { stdout: "ignore", stderr: "ignore" });
    const stillPresent = git(gitRoot, ["rev-parse", "--verify", "-q", `refs/heads/${item.branch}^{commit}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    if (deleted.exitCode !== 0 || stillPresent) {
      retirementFailed.push(item.branch);
      skip("delete_failed");
      continue;
    }
    const receipt = {
      ...records.authorization,
      kind: "garelier_branch_retirement_receipt",
      status: "retired",
      authorization_path: records.authorizationPath,
    };
    const absoluteReceipt = resolve(controlRoots.controlRoot, ...records.receiptPath.split("/"));
    try { immutableControlRecord(controlRoots.controlRoot, absoluteReceipt, receipt); }
    catch (error) {
      err(`dispatch_cleanup: branch '${item.branch}' was retired, but its receipt could not be written; authorization ${records.authorizationPath} still preserves the tip: ${(error as Error).message}`);
    }
    const recordPath = existsSync(absoluteReceipt) ? records.receiptPath : records.authorizationPath;
    retirementSwept.push(item.branch);
    retirements.push({
      branch: item.branch,
      tip_sha: item.tip,
      work_id: item.authority.workId,
      landed_round: item.authority.landedRound,
      recovery_ref: records.recoveryRef,
      record_path: recordPath,
    });
  }
  const remainingResult = git(gitRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  if (remainingResult.exitCode !== 0) {
    skipped.post_delete_inventory_failed = deletable.length + retirementDeletable.length;
    return { swept: retirementSwept, failed: [...deletable, ...retirementFailed], kept, skipped, retirements };
  }
  const remaining = new Set(remainingResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  if (deletion.exitCode !== 0) {
    skipped.delete_failed = deletable.length;
    return { swept: retirementSwept, failed: [...deletable, ...retirementFailed], kept, skipped, retirements };
  }
  const ordinarySwept = deletable.filter((branch) => !remaining.has(branch));
  const ordinaryFailed = deletable.filter((branch) => remaining.has(branch));
  const swept = [...ordinarySwept, ...retirementSwept];
  const failed = [...ordinaryFailed, ...retirementFailed];
  if (ordinaryFailed.length) skipped.post_delete_disagreement = ordinaryFailed.length;
  return { swept, failed, kept, skipped, retirements };
}

function archiveCoordination(container: string, doneDir: string, id: string, slug: string, branch: string): void {
  const names = ["assignment", "report", "questions", "answers", "instructions"];
  if (!names.some((name) => existsSync(resolve(container, `${name}.md`)))) return;
  mkdirSync(doneDir, { recursive: true });
  let body = `# #${id} ${slug} - archived by dispatch_cleanup (${branch || "no-branch"})\n\n`;
  const assignment = resolve(container, "assignment.md");
  const report = resolve(container, "report.md");
  if (existsSync(assignment)) {
    body += readFileSync(assignment, "utf8");
    if (existsSync(report)) body += "\n---\n\n";
  }
  if (existsSync(report)) body += readFileSync(report, "utf8");
  for (const name of ["questions", "answers", "instructions"]) {
    const path = resolve(container, `${name}.md`);
    if (existsSync(path)) body += `\n---\n\n${readFileSync(path, "utf8")}`;
  }
  writeFileSync(resolve(doneDir, `${id}-${slug}.md`), body);
  const sidecar = resolve(container, "report.json");
  if (existsSync(sidecar)) copyFileSync(sidecar, resolve(doneDir, `${id}-${slug}.json`));
}

export async function main(
  argv = process.argv.slice(2),
  lifecycle: DispatchContainerLifecycle = DISPATCH_CONTAINER_LIFECYCLE,
): Promise<number> {
  let project = "", targetRoot = "", pm = "", id = "", explicitCheckout = "", reportFromFile = "", requestId = "";
  let deleteBranch = false, forceRemove = false, sweep = false, retireSuperseded = false, recordTouches = false, acceptUngatedMerge = false, dryRun = false;
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": project = valueAfter(argv, i); i += 2; break;
      case "--target-root": targetRoot = valueAfter(argv, i); i += 2; break;
      case "--pm-id": pm = valueAfter(argv, i); i += 2; break;
      case "--id": id = valueAfter(argv, i); i += 2; break;
      case "--checkout": explicitCheckout = valueAfter(argv, i); i += 2; break;
      case "--request-id": requestId = valueAfter(argv, i); i += 2; break;
      case "--dry-run": dryRun = true; i++; break;
      case "--delete-branch": deleteBranch = true; i++; break;
      // W-318: renamed from the unqualified `--force`, which read like a global
      // override of every check while it only ever forced the REMOVAL half.
      case "--force-remove": forceRemove = true; i++; break;
      case "--accept-ungated-merge": acceptUngatedMerge = true; i++; break;
      case "--sweep": sweep = true; i++; break;
      case "--retire-superseded": retireSuperseded = true; i++; break;
      case "--report-from-file": reportFromFile = valueAfter(argv, i); i += 2; break;
      case "--record-touches": recordTouches = true; i++; break;
      case "-h": case "--help": out(HELP); return 0;
      case "--force":
        err("dispatch_cleanup: --force was renamed to --force-remove (W-318): it forces worktree/branch REMOVAL only and has never bypassed a control check.");
        fail("dispatch_cleanup: use --force-remove; to clear a merge that landed without a gate, use --accept-ungated-merge.", 2);
      // falls through to the arg error below only if the fail above is ever removed
      default:
        err(`dispatch_cleanup: unknown arg: ${argv[i]}`);
        fail("dispatch_cleanup: valid flags: --project --target-root --pm-id --id --checkout --request-id --dry-run --delete-branch --force-remove --accept-ungated-merge --sweep --retire-superseded --report-from-file --record-touches -h/--help", 2);
    }
  }
  if (!project || !pm) fail("dispatch_cleanup: --project, --pm-id are required", 2);
  if (retireSuperseded && !sweep) fail("dispatch_cleanup: --retire-superseded requires --sweep", 2);

  let gitRoot = targetRoot || project;
  const absolute = /^(?:\/|[A-Za-z]:[\\/])/.test(gitRoot);
  if (!absolute || gitRoot.includes("$") || !isDirectory(gitRoot)) gitRoot = project;

  const pmRoot = `${project}/__garelier/${pm}`;
  const pmContainer = crewSubdir(project, pm, "pm");
  const dispatchContainer = (dispatchId: string): string => crewSubdir(project, pm, `dispatch${dispatchId}`);
  const failedFile = `${pmRoot}/runtime/backlog/failed_cleanups.jsonl`;

  // W-530 P-1/P-2: destructive id-selected cleanup has two independent
  // selectors. Validate them before even acquiring an operation guard, because
  // omission/mismatch must not delete or mutate one byte.
  if (id && !sweep && !recordTouches && !dryRun) {
    requireMatchingCheckout(explicitCheckout, resolve(dispatchContainer(id), "checkout"), id);
  }

  // Successful-land route only. A request/result pair is the authority; every
  // other cleanup mode below keeps its legacy non-land contract and cannot
  // accidentally create a terminal aftercare journal.
  if (requestId) {
    if (sweep || recordTouches || acceptUngatedMerge || reportFromFile) {
      fail("dispatch_cleanup: --request-id cannot be combined with non-land cleanup/recovery flags", 2);
    }
    // W-741: this route is the one the PM runs by hand, and it refused on the
    // `lane/gate-step4-<sha12>.log` that land_pipeline's own pm_step stage wrote
    // (#605). Aftercare keeps that log OUT of its allowlist on purpose — its
    // class is "durable, with an owner that moves it out first" — so the fix is
    // to BE that owner here, not to admit the name into the allowlist (which
    // would delete the 4th-step gate evidence) and not to reach for
    // --force-remove (an override for a dirty worktree / unmerged branch, which
    // stops meaning anything once it is the routine way past evidence).
    // Preserved into the same tracked control tree land_pipeline stage 10 uses.
    // A log written under any OTHER name is not preserved and still refuses.
    const preservedGateLogs = dryRun || !id ? [] : preservePmStepGateLogs({
      lane: resolve(dispatchContainer(id), "lane"),
      project, pmId: pm, workId: containerWorkId(dispatchContainer(id)), dispatchId: id,
    });
    for (const path of preservedGateLogs) {
      out(`dispatch_cleanup: preserved pm-step gate log -> ${path}`);
    }
    // #474 Guardian: a preview must not mutate, so --dry-run skips the move
    // above and then walks a lane that still holds the log — it refuses where
    // the apply preserves and accepts. Round 3 closed that by re-taking the
    // preview with `forceRemove: true`, which was WRONG in the other direction
    // (#474 r3 -> M5): force-remove also relaxes the container-ownership check
    // and the dirty-checkout predicate, so a DIRTY checkout that happened to
    // hold a step-4 log previewed as success where it used to refuse. A preview
    // may never be taken under weaker rules than the apply it previews.
    //
    // So the caller's `forceRemove` is carried through unchanged and the preview
    // is never re-taken. What --dry-run adds is the TRUTH about the apply: when
    // the refusal names nothing but logs this preservation removes, it prints
    // the preservation the apply performs and refuses with that named, so the
    // PM habit W-741 exists to end ("preview refuses, reach for --force-remove")
    // is answered with the route that actually works. No byte moves either way.
    //
    // The predicate reads the CAUGHT ERROR, not just the lane: only the message
    // says why THIS preview refused. A lane walk alone answers "could an
    // unknown-entry refusal be explained by gate logs" and stays true while the
    // real cause is a dirty checkout or a missing ownership file. Both are
    // required — the message identifies the cause, the walk confirms the logs
    // are files this preservation would really move.
    const plannedGateLogs = dryRun && id ? plannedPmStepGateLogPreservation({
      lane: resolve(dispatchContainer(id), "lane"),
      project, pmId: pm, workId: containerWorkId(dispatchContainer(id)), dispatchId: id,
    }) : [];
    let preview: ReturnType<typeof dryRunLandAftercare>;
    try {
      preview = dryRunLandAftercare({
        project, targetRoot: gitRoot, pmId: pm, requestId, dispatchId: id || undefined,
        forceRemove,
      });
    } catch (error) {
      const cause = (error as Error).message;
      const blockedOnlyByGateLogs = dryRun
        && plannedGateLogs.length > 0
        && refusalIsOnlyPmStepGateLogs(cause)
        && laneUnknownIsOnlyPmStepGateLogs(resolve(dispatchContainer(id), "lane"));
      if (!blockedOnlyByGateLogs) fail(landAftercareRefusalMessage(id, cause), 3);
      for (const path of plannedGateLogs) {
        out(`dispatch_cleanup: would preserve pm-step gate log -> ${path}`);
      }
      fail(
        `dispatch_cleanup: --dry-run stops at the pm-step gate log the apply route preserves first (${plannedGateLogs.length} log(s), listed above). `
        + "Re-run the same command WITHOUT --dry-run: it preserves them into the tracked gates report tree and then proceeds. "
        + `Do NOT add --force-remove — it is an override for a dirty worktree or an unmerged branch, not a way past gate evidence. Aftercare said: ${cause}`,
        3,
      );
    }
    if (!id && preview.plan.dispatch_id !== null) {
      fail("dispatch_cleanup: this request binds a dispatch/container; --id <n> is required for caller cross-binding", 2);
    }
    if (!dryRun && id && preview.plan.checkout !== null
      && !filesystemPathsMatch(preview.plan.checkout, resolve(dispatchContainer(id), "checkout"))) {
      fail(
        `dispatch_cleanup: REFUSING — request ${requestId} selects checkout '${preview.plan.checkout}', which does not match the checkout derived from --id ${id}. No filesystem or Control mutation was performed.`,
        3,
      );
    }
    try {
      const result = dryRun
        ? preview
        : lifecycle.landCleanup(() => applyLandAftercare({
          project, targetRoot: gitRoot, pmId: pm, requestId, dispatchId: id || undefined,
          expectedPlanDigest: preview.plan.plan_digest, forceRemove,
        }));
      const branchPresent = git(gitRoot, ["rev-parse", "--verify", "-q", `refs/heads/${result.plan.workbench_branch}^{commit}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
      emitJsonLine({
        id: id ? Number(id) : null,
        request_id: requestId,
        cleanup_status: dryRun ? "dry-run" : result.mode === "no-op" ? "already-complete" : "success",
        branch: result.plan.workbench_branch,
        checkout_removed: result.plan.checkout === null ? null : !existsSync(result.plan.checkout),
        container_removed: result.plan.container === null ? null : !existsSync(result.plan.container),
        branch_present: branchPresent,
        branch_deleted: !branchPresent,
        aftercare_state: result.journal_state,
        aftercare_plan_digest: result.plan.plan_digest,
        aftercare_envelope_file: result.plan.envelope_path,
        idempotency_key: result.envelope?.idempotency_key ?? null,
        external_sync_pending: result.external_sync_pending,
        planned_actions: dryRun ? result.plan.actions : undefined,
        safety_predicates: dryRun ? result.plan.predicates : undefined,
      });
      return 0;
    } catch (error) {
      fail(landAftercareRefusalMessage(id, (error as Error).message), 3);
    }
  }
  if (dryRun) fail("dispatch_cleanup: --dry-run is valid only with --request-id", 2);

  const roots = garelierControlRoots(project, gitRoot, pm);
  let guard: ReturnType<typeof acquireGarelierOperationGuard>;
  try { guard = acquireGarelierOperationGuard(roots, `dispatch-cleanup-${id || "sweep"}-${process.pid}`, "dispatch-cleanup"); }
  catch (error) { fail(`dispatch_cleanup: ${(error as Error).message}`, 4); }
  try {
  const controlSchema = guard.schema;
  if (controlSchema !== null && controlSchema !== 3) {
    fail(`dispatch_cleanup: unsupported control schema_version ${controlSchema}; only schema_version 3 is accepted`, 4);
  }

  if (sweep) {
    let sweptCount = 0;
    const remaining: string[] = [];
    const failedCleanups: FailedCleanupSweepEntry[] = [];
    if (existsSync(failedFile)) {
      for (const line of readFileSync(failedFile, "utf8").split(/\r?\n/)) {
        if (!line) continue;
        let container = "";
        let dispatchId: number | null = null;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          container = typeof parsed.container === "string" ? parsed.container : "";
          const candidateId = Number(parsed.dispatch_id);
          if (Number.isSafeInteger(candidateId) && candidateId > 0) dispatchId = candidateId;
        } catch {
          container = line.match(/"container":"([^"]*)"/)?.[1] ?? "";
          const candidateId = Number(line.match(/"dispatch_id":(\d+)/)?.[1] ?? "");
          if (Number.isSafeInteger(candidateId) && candidateId > 0) dispatchId = candidateId;
        }
        if (dispatchId === null) {
          failedCleanups.push({ dispatch_id: null, container, status: "skipped", missing_conditions: ["dispatch_id"] });
          remaining.push(line);
          continue;
        }
        const derivedContainer = dispatchContainer(String(dispatchId));
        if (!container || !filesystemPathsMatch(container, derivedContainer)) {
          failedCleanups.push({ dispatch_id: dispatchId, container, status: "skipped", missing_conditions: ["container_path_match"] });
          remaining.push(line);
          continue;
        }
        // Never operate on the ledger-provided path. It is evidence only; the
        // actual target is independently re-derived from the verified id.
        const registeredCheckout = `${derivedContainer}/checkout`;
        const selection: CheckoutSelection = existsSync(registeredCheckout) ? "registered-checkout" : "container-fallback";
        const checkout = selection === "registered-checkout" ? registeredCheckout : derivedContainer;
        if (!existsSync(checkout) && !existsSync(derivedContainer)) {
          sweptCount++;
          failedCleanups.push({ dispatch_id: dispatchId, container: derivedContainer, status: "reclaimed", missing_conditions: [] });
          continue;
        }
        if (await removeCheckoutDir(gitRoot, checkout, true, selection)) {
          try { removeTreeSync(derivedContainer); } catch { /* retain */ }
          if (!existsSync(derivedContainer)) {
            sweptCount++;
            failedCleanups.push({ dispatch_id: dispatchId, container: derivedContainer, status: "reclaimed", missing_conditions: [] });
            continue;
          }
        }
        failedCleanups.push({ dispatch_id: dispatchId, container: derivedContainer, status: "kept", missing_conditions: ["removal_succeeded"] });
        remaining.push(line);
      }
      if (remaining.length) writeFileSync(failedFile, `${remaining.join("\n")}\n`);
      else rmSync(failedFile, { force: true });
    }
    const gateSeats = sweepTerminalGateSeats(pmRoot, roots, controlSchema);
    // W-084(a): the same self-heal sweep also reclaims orphaned per-lane
    // `runtime/scratch/<slug>` dirs whose dispatch container is already gone.
    const active = activeDispatchInventory(pmRoot);
    const scratch = sweepOrphanScratch(pmRoot, active.slugs);
    const branches = sweepRetirableBranches(gitRoot, project, pm, active.branches, retireSuperseded);
    const skipped = Object.entries(branches.skipped).sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `${reason}:${count}`).join(",") || "none";
    const gateReclaimed = gateSeats.filter((entry) => entry.status === "reclaimed").length;
    const gateKept = gateSeats.length - gateReclaimed;
    out(`swept=${sweptCount} remaining=${remaining.length} gate_seat_reclaimed=${gateReclaimed} gate_seat_kept=${gateKept} scratch_swept=${scratch.swept.length} scratch_kept=${scratch.kept.length} branch_swept=${branches.swept.length} branch_failed=${branches.failed.length} branch_kept=${branches.kept} branch_skipped=${skipped}`);
    emitJsonLine({
      cleanup_status: "sweep",
      failed_cleanups: failedCleanups,
      gate_seats: gateSeats,
      branch_retirements: branches.retirements,
      counts: { failed_cleanup_reclaimed: sweptCount, failed_cleanup_remaining: remaining.length, gate_seat_reclaimed: gateReclaimed, gate_seat_kept: gateKept },
    });
    return 0;
  }

  if (!id) fail("dispatch_cleanup: --id <n> is required (or use --sweep)", 2);
  const container = dispatchContainer(id);
  const registeredCheckout = `${container}/checkout`;
  const selection: CheckoutSelection = existsSync(registeredCheckout) ? "registered-checkout" : "container-fallback";
  const checkout = selection === "registered-checkout" ? registeredCheckout : container;
  if (!isDirectory(checkout)) fail(`dispatch_cleanup: no worktree at ${container}[/checkout]`, 1);

  if (recordTouches) {
    const contextJson = `${container}/context.json`;
    if (!existsSync(contextJson)) fail(`dispatch_cleanup: --record-touches: no context.json at ${contextJson}`, 1);
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const recordTouchesTs = resolve(moduleDir, "../dispatch/record_touches.ts");
    if (!existsSync(recordTouchesTs)) fail(`dispatch_cleanup: --record-touches: record_touches.ts not found at ${recordTouchesTs}`, 1);
    const result = run(["bun", recordTouchesTs, "--context", contextJson, "--checkout", checkout], { stdout: "inherit", stderr: "inherit" });
    return result.exitCode;
  }

  // W-318 (PM N1): only ask a real worktree for its branch. A bare container
  // answers with the PROJECT's current branch, which downstream reads as the
  // dispatch branch — `mergeStatusForBranch` then finds it "merged" into studio
  // and `--delete-branch` deletes the project's own branch.
  const identity = worktreeIdentity(checkout, selection);
  const branch = identity.kind === "own-worktree" ? gitOutput(checkout, ["branch", "--show-current"]) : "";
  const branchTip = branch ? gitOutput(gitRoot, ["rev-parse", "--verify", `${branch}^{commit}`]) : "";
  const studioBranch = readIntegration(project, pm);
  // W-318 (PM N1) — refuse BEFORE archiving, mutating control, or removing
  // anything. Measure the loss first and name it: unlike commits, uncommitted
  // work has no second copy, so "the branch is retained" is not a defence for it.
  if (!forceRemove) {
    const measurement = measureCheckout(checkout, selection);
    if (measurement.kind === "measurement-error") {
      fail(
        `dispatch_cleanup: REFUSING — could not measure the checkout's uncommitted state at ${checkout}: ${measurement.detail}. ` +
        `No control/archive/removal action was performed. Repair the worktree metadata/index and retry, or re-run with --force-remove to discard it deliberately.`,
        3,
      );
    }
    if (measurement.kind === "measured-dirty") {
      const more = measurement.total - measurement.paths.length;
      fail(
        `dispatch_cleanup: REFUSING — the checkout at ${checkout} holds ${measurement.total} uncommitted path(s), and removing it is the only thing standing between them and permanent loss (they are NOT on the branch): ` +
        `${measurement.paths.join(" | ")}${more > 0 ? ` | +${more} more` : ""}. ` +
        `Commit or stash them in the checkout first, or re-run with --force-remove to discard them deliberately.`,
        3,
      );
    }
    if (identity.kind === "own-worktree" && !branch) {
      const detachedTip = gitOutput(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const studioTip = gitOutput(gitRoot, ["rev-parse", "--verify", `${studioBranch}^{commit}`]);
      const landed = Boolean(detachedTip && studioTip)
        && git(gitRoot, ["merge-base", "--is-ancestor", detachedTip, studioTip], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
      if (!landed) {
        fail(
          `dispatch_cleanup: REFUSING — ${checkout} is a detached own-worktree at ${detachedTip || "<unknown tip>"}, ` +
          `and that exact tip is not reachable from ${studioBranch || "<no integration branch>"}. No branch retains it, so removing the checkout could drop its last durable ref. ` +
          `Create a named branch or land/prove the exact tip first, or re-run with --force-remove to discard it deliberately. No archive/control/removal action was performed.`,
          3,
        );
      }
    }
  }
  if (!forceRemove && branch) {
    const mergeHead = gitOutput(gitRoot, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
    const tip = gitOutput(gitRoot, ["rev-parse", "--verify", "-q", branch]);
    if (mergeHead && tip && mergeHead === tip) {
      fail(`dispatch_cleanup: REFUSING — a merge of '${branch}' is in progress (.git/MERGE_HEAD == branch tip). The merge gate is still integrating it; cleaning now races the merge. Wait until it finishes (lock released / studio advanced), then re-run. Use --force-remove to override.`, 3);
    }
    const lock = `${pmRoot}/runtime/merge_gate/locks/active.lock`;
    const slug = branch.split("/").at(-1) ?? "";
    if (existsSync(lock) && slug && readText(lock).includes(slug)) {
      fail(`dispatch_cleanup: REFUSING — the merge gate is processing '${slug}' (active.lock present and references it). Cleaning now races the in-flight merge. Wait until it finishes (lock released), then re-run. Use --force-remove to override.`, 3);
    }
  }

  const baseSha = dispatchBaseSha(container);
  const mergeStatus = mergeStatusForBranch(
    gitRoot,
    branch,
    studioBranch,
    baseSha,
    `${pmRoot}/runtime/merge_gate/results`,
  );
  // `branch` is empty when the container is not its own worktree (see
  // isOwnWorktreeTop) — there is then nothing to delete, so refusing to delete it
  // would be a refusal about a branch that does not exist.
  if (deleteBranch && branch && !forceRemove && mergeStatus !== "merged" && mergeStatus !== "success" && mergeStatus !== "no_changes") {
    fail(`dispatch_cleanup: REFUSING to delete branch '${branch}' — it is not confirmed merged (merge_status=${mergeStatus}: its tip is not an ancestor of studio and no status=success merge result matches its slug). A conflicted/failed merge leaves those commits reachable only from the branch, so deleting now loses that work. Verify the merge landed, or re-run with --force-remove to delete anyway.`, 3);
  }
  let controlIdentity: CleanupControlIdentity | null = null;
  if (controlSchema === 3) {
    try { controlIdentity = cleanupControlIdentity(container, id, controlSchema, project, pm); }
    catch (error) {
      fail(
        `dispatch_cleanup: REFUSING — cannot establish the exact claim owner for dispatch #${id}: ${(error as Error).message}. ` +
        `No archive/control/removal action was performed. Restore control_binding.json from the dispatch/session record, or explicitly release the identified claim before retrying.`,
        4,
      );
    }
    if (!controlIdentity) {
      const noUnlandedCommit = mergeStatus === "merged" || mergeStatus === "success" || mergeStatus === "no_changes";
      if (!noUnlandedCommit) {
        fail(
          `dispatch_cleanup: REFUSING — dispatch #${id} has no recoverable context/control binding and its branch is not proven landed or unchanged (merge_status=${mergeStatus}). ` +
          `Removing it could orphan authority or an unlanded commit; no archive/control/removal action was performed.`,
          4,
        );
      }
      err(`dispatch_cleanup: WARNING — dispatch #${id} has no recoverable control identity, but Git proves no unlanded commit remains (merge_status=${mergeStatus}); retiring only the landed container authority.`);
    }
  }
  let siblingCount = 0;
  let siblingProtected = false;
  if (controlSchema === 3 && controlIdentity?.workId && controlIdentity.sessionId) {
    const records = readDispatchContainerRecords(pmRoot);
    siblingCount = records.filter((record) =>
      record.id !== id
      && record.work_id === controlIdentity!.workId
      && record.session_id === controlIdentity!.sessionId
      && record.claim_owned !== false
    ).length;
    siblingProtected = lifecycle.preserveSiblingAuthority({
      dispatchId: id,
      workId: controlIdentity.workId,
      sessionId: controlIdentity.sessionId,
      records,
    });
  }
  let reportSource = "none";
  if (reportFromFile && transcribeReport(reportFromFile, `${container}/report.md`)) reportSource = reportFromFile;
  // Retire this dispatch's terminal long jobs while the ledger is still
  // inspectable. The retirement evidence is stored beside each durable record,
  // not in the transient container that this command removes below.
  let retiredLongJobs: ReturnType<typeof retireLongJobsForDispatch> = [];
  try {
    retiredLongJobs = retireLongJobsForDispatch(longJobRoot(project, pm), id);
  } catch (error) {
    fail(`dispatch_cleanup: long-job retirement refused; no checkout/branch removal performed: ${(error as Error).message}`, 4);
  }
  const slug = branch.split("/").at(-1) || "dispatch";
  const archivedReport = `${pmRoot}/runtime/backlog/done/${id}-${slug}.md`;
  archiveCoordination(container, `${pmRoot}/runtime/backlog/done`, id, slug, branch);
  let controlUpdate: Record<string, unknown> | null = null;
  let repositoryFindings: RepositoryUngatedMergeFinding[] = [];
  if (controlSchema === 3) {
    try {
      const workId = controlIdentity?.workId ?? "";
      const sessionId = controlIdentity?.sessionId ?? "";
      const claimIndependent = controlIdentity?.claimOwned === false;
      if (siblingProtected) {
        // S0 / W-501: the directory being retired is not the sole live owner of
        // this Work/session. Never mutate/release shared Control authority from
        // one sibling's cleanup; only its own ephemeral container is eligible.
        controlUpdate = { status: "sibling-protected", work_id: workId, merge_status: mergeStatus, sibling_count: siblingCount };
      } else if (claimIndependent) {
        // W-424: a no-worktree read-only seat has authority context, not claim
        // ownership. Cleanup archives/removes only its ephemeral container; it
        // must not record an abort, renew/release the role claim, or change
        // the Work bytes that the role authorization hashes.
        controlUpdate = { status: "claim-independent", work_id: workId, merge_status: mergeStatus };
      }
      // W-346 FR9: a Work bound to a landed-but-not-yet-closed closure lease
      // defers its terminal control transition / claim release / removal — the
      // shared finalize-order hook refuses out-of-order finalization unchanged.
      if (!claimIndependent && !siblingProtected && workId) assertFinalizeOrderOk(resolve(project).replace(/\\/g, "/"), pm, studioBranch, workId);
      // W-318 — a container with NO readable control binding used to be a hard
      // refusal, which wedged the ENTIRE project: readRuntimeDispatchSnapshot
      // throws on a container missing context.json, so every `control claim` and
      // every `dispatch_prepare` failed, and the only command that could remove
      // the offending container refused for the same missing file. A crashed /
      // interrupted dispatch_prepare (the container dir is created before
      // context.json is written) reaches exactly that state.
      //
      // This is not fail-open: a container that declares no Work/session has NO
      // row to record anything on and NO claim to release, so there is nothing
      // for the refusal to protect. Its branch is untouched — branch deletion has
      // its own merged-tip check — so no COMMIT is lost either, and uncommitted
      // work is held back by the pre-flight refusal above. It is recorded loudly
      // rather than silently, because on a schema-3 project a binding SHOULD
      // be there and its absence is worth seeing.
      let binding: ReturnType<typeof inspectDispatchControlBinding> | null = null;
      if (claimIndependent || siblingProtected) {
        // The read-only authority binding was already validated above; there is
        // deliberately no claim-bearing control operation to perform.
      } else if (!workId || !sessionId) {
        err(`dispatch_cleanup: WARNING — schema-v${controlSchema} dispatch #${id} declares no Work/Backlog session binding (context.json missing, unreadable, or without control). There is no row to update and no claim to release; removing the container. The branch is NOT deleted by this path.`);
        deleteBranch = false;
        controlUpdate = { status: "no-control-binding", merge_status: mergeStatus };
      } else {
      try {
        binding = inspectDispatchControlBinding(roots, workId, sessionId, guard.lock);
      } catch (error) {
        if (!/ is closed: /.test((error as Error).message)) throw error;
        // W-235 (a real target-project incident): a closed row (done/cancelled/superseded) has no
        // reopenable claim — inspectDispatchControlBinding correctly refuses new
        // binding (dispatch_prepare must not dispatch onto a closed row), but a
        // cleanup call arriving AFTER a confirmed merge is verify-only: once
        // merge-landing evidence bound to this work_id is confirmed, removal
        // proceeds without any control mutation (there is no claim to release
        // and no transition to record on an already-closed row). Evidence that
        // cannot be confirmed still refuses cleanup, protecting the branch of a
        // row closed in error.
        let evidence = "";
        if (mergeStatus === "success" && successfulControlResult(
          `${pmRoot}/runtime/merge_gate/results`, workId, sessionId, branch, branchTip, gitRoot, studioBranch,
        )) {
          evidence = `bound merge-gate result for ${workId}`;
        } else if (mergeStatus === "merged") {
          const analysis = ungatedLanding(gitRoot, branch, studioBranch, baseSha, roots, controlSchema);
          if (analysis.censusState === "unknown") {
            throw new Error(
              `${workId} is closed, but cleanup census state=unknown (${analysis.reason}); git could not complete the studio first-parent merge/gate census. ` +
              `Retaining the container and branch because an unclassified first-parent update could be an ungated fast-forward.`,
            );
          }
          if (analysis.censusState === "ambiguous") {
            throw new Error(
              `${workId} is closed, but cleanup census state=ambiguous: branch commit(s) ${analysis.branchFirstParentNonMergeCommits.join(", ")} ` +
              `appear on '${studioBranch}'s first-parent non-merge line. Retaining the container and branch because an unclassified first-parent update could be an ungated fast-forward.`,
            );
          }
          repositoryFindings = analysis.repositoryFindings;
          reportRepositoryUngatedMergeFindings(repositoryFindings, branch);
          if (analysis.landings.length) {
            const landingCommits = analysis.landings.map((landing) => landing.landingCommit).join(", ");
            throw new Error(
              `${workId} is closed, but cleanup census state=resolved: studio first-parent merge(s) ${landingCommits} have no bound merge-gate record and are positively attributed to this Work. ` +
              `Retaining the container and branch; closed-row cleanup cannot silently accept an ungated landing.`,
            );
          }
          evidence = repositoryFindings.length
            ? `census state=resolved; no ungated studio first-parent merge since dispatch base ${analysis.nonLandingProof.baseTip} is positively attributed to ${branch}; ${repositoryFindings.length} repository finding(s) reported separately`
            : `census state=resolved; every studio first-parent merge since dispatch base ${analysis.nonLandingProof.baseTip} has bound merge-gate evidence`;
        }
        if (!evidence) {
          // W-318 — this was the second unrecoverable cycle. A row closed
          // (done/cancelled/superseded) while its dispatch was still in flight can
          // NEVER be reopened: schema-3 gives the three closed states no outgoing
          // transition. So "no merge evidence" could never become "evidence", the
          // container stayed forever, and its touches stayed reserved. Cancelling a
          // row mid-dispatch is an ordinary PM action, so this was easy to reach.
          //
          // The refusal was protecting the wrong thing. A closed row cannot hold a
          // claim and cannot take a transition, so there is no control state to
          // lose. Branch deletion is forced off here so the COMMITS stay reachable,
          // and the unverified state is recorded rather than silently equated with a
          // verified landing.
          //
          // That covers commits only. UNCOMMITTED work in the checkout has no second
          // copy and no branch to survive on — it is protected separately, by the
          // pre-flight refusal above, which stops this path before it reaches here
          // unless the caller passed --force-remove (W-318 PM N1).
          err(`dispatch_cleanup: WARNING — ${workId} is closed and no merge evidence confirms this branch landed (merge_status=${mergeStatus}). A closed row has no claim to release and no transition to record, so the container is removed to free its touch reservation. Branch '${branch}' is NOT deleted: its commits remain reachable from it.`);
          deleteBranch = false;
          controlUpdate = { status: "closed-row-unverified", work_id: workId, merge_status: mergeStatus, branch_retained: branch };
        } else {
          controlUpdate = { status: "closed-row-verified", work_id: workId, merge_status: mergeStatus, evidence };
        }
      }
      if (binding) {
        if (mergeStatus === "merged" || mergeStatus === "success") {
          const result = successfulControlResult(
            `${pmRoot}/runtime/merge_gate/results`, workId, sessionId, branch, branchTip, gitRoot, studioBranch,
          );
          if (!result) {
            // W-318 — the deadlock that made this row. A branch merged OUTSIDE the
            // merge gate (`git merge --no-ff` by hand) leaves no result file, so the
            // requirement above could never be satisfied by any later command: the
            // container stayed forever, its `touches` stayed reserved, and every
            // other row overlapping those paths became undispatchable.
            //
            // The requirement conflated two different questions. "Is it safe to
            // remove this container?" is answered by git reachability alone — the
            // commits are in the integration branch, nothing is lost. "Did this work
            // pass its gate?" is answered by the gate result, and is a property of
            // the ROW, not of the container. Recovery therefore records the second
            // answer honestly (a bypass record, never a passing gate) instead of
            // blocking the first.
            //
            // Both predicates stay fail-closed: reachability answers deletion
            // safety, while only a direct first-parent landing can trigger an
            // ungated record. The acknowledgement flag alone proves neither.
            const analysis = ungatedLanding(gitRoot, branch, studioBranch, baseSha, roots, controlSchema);
            if (analysis.censusState === "unknown") {
              throw new Error(
                `merge_status=${mergeStatus} but no schema-v${controlSchema} gate result is bound to ${workId}, and census state=unknown (${analysis.reason}): ` +
                `git could not complete the studio first-parent merge/gate census rooted at '${studioBranch || "<no integration branch>"}'. ` +
                `Retaining claim and checkout because an unclassified first-parent update could be an ungated fast-forward.`,
              );
            }
            if (analysis.censusState === "ambiguous") {
              throw new Error(
                `merge_status=${mergeStatus} but no schema-v${controlSchema} gate result is bound to ${workId}, and census state=ambiguous: ` +
                `branch commit(s) ${analysis.branchFirstParentNonMergeCommits.join(", ")} appear on '${studioBranch || "<no integration branch>"}'s first-parent non-merge line. ` +
                `Retaining claim and checkout because an unclassified first-parent update could be an ungated fast-forward.`,
              );
            }
            repositoryFindings = analysis.repositoryFindings;
            reportRepositoryUngatedMergeFindings(repositoryFindings, branch);
            const landings = analysis.landings;
            if (!landings.length && mergeStatus !== "merged") {
              throw new Error(
                `merge_status=${mergeStatus} but no schema-v${controlSchema} gate result is bound to ${workId}, and census state=resolved but git cannot confirm '${branch || "<no branch>"}' is reachable from '${studioBranch || "<no integration branch>"}' either. ` +
                `Nothing proves this branch landed, so its commits are still reachable only from the branch — retaining claim and checkout.`,
              );
            }
            if (!landings.length) {
              if (binding.claim && binding.claim.session_id !== sessionId) {
                throw new Error(`reachable non-landing cleanup refused: ${workId}'s active claim belongs to a different session (${binding.claim.session_id}, expected ${sessionId})`);
              }
              const released = binding.claim?.session_id === sessionId
                ? releaseDispatchControlClaim(roots, workId, sessionId, guard.lock)
                : false;
              controlUpdate = {
                status: "reachable-not-landed",
                work_id: workId,
                released,
                non_landing_proof: analysis.nonLandingProof,
              };
            } else if (!acceptUngatedMerge) {
              const attributedMerges = landings.map((landing) => landing.landingKind === "merge-parent"
                ? `${landing.landingCommit} (branch tip ${landing.branchTip} is parent #${landing.parentNumber})`
                : `${landing.landingCommit} (integration ref-update '${landing.reflogSubject}' attributes ${landing.branchTip})`
              ).join(", ");
              throw new Error(
                `census state=resolved: studio first-parent merge(s) ${attributedMerges} have NO bound merge-gate result and are positively attributed to '${branch}'; these merges bypassed the merge gate. ` +
                `Two exits, both mechanical: (1) re-run the gate — 'garelier control claim ${workId} --session ${sessionId} --touches <paths>' then 'merge_land.ts --dispatch-id ${id}' — or ` +
                `(2) accept the bypass on the record: re-run this command with --accept-ungated-merge, which writes a durable merge_gate_bypass_record on ${workId} (status 'bypassed', NOT a passing gate), leaves the row's status where it is, and adds an explicit gate-or-waive obligation before it can close.`,
              );
            } else if (binding.claim && binding.claim.session_id !== sessionId) {
              throw new Error(`ungated merge recovery refused: ${workId}'s active claim belongs to a different session (${binding.claim.session_id}, expected ${sessionId})`);
            } else {
              const containerReport = `${container}/report.md`;
              let recorded: ReturnType<typeof recordMergeControlOutcome> | null = null;
              let released = false;
              for (const landing of [...landings].reverse()) {
                recorded = recordMergeControlOutcome({
                  roots,
                  workId,
                  sessionId,
                  outcome: {
                    status: "ungated",
                    commit: landing.landingCommit,
                    ancestry: landing,
                    reportPath: existsSync(containerReport) ? containerReport : archivedReport,
                  },
                  namespaceLock: guard.lock,
                  requireLiveClaim: false,
                });
                released ||= recorded.released;
              }
              controlUpdate = {
                ...(recorded ?? {}),
                released,
                status: "ungated-merge-recorded",
                work_id: workId,
                census_state: "resolved",
                ...(landings.length === 1
                  ? { merge_commit: landings[0]!.landingCommit }
                  : { merge_commits: landings.map((landing) => landing.landingCommit) }),
                gate_satisfied: false,
              };
            }
          } else {
          const commit = String(result.value.studio_commit);
          if (!hasMergeControlEvidence(roots, workId, commit, result.path)) {
            // W-247 (a real target-project incident): a claim that is merely expired — or already
            // GC'd entirely — must not block recording evidence for a merge that
            // mergeStatus (above) has already independently confirmed landed; only
            // a claim actively held by a DIFFERENT session blocks recovery (someone
            // else is legitimately using this row right now).
            if (binding.claim && binding.claim.session_id !== sessionId) {
              throw new Error(`merge evidence is missing and ${workId}'s active claim belongs to a different session (${binding.claim.session_id}, expected ${sessionId})`);
            }
            // W-247: the merge request's role_report_path was bound at
            // request-submission time to the (pre-archive) container report — bind
            // the same path here when it still exists (it is not removed until
            // after this control update completes below), falling back to the
            // post-archive copy otherwise. The other of the two is offered as a
            // secondary binding candidate so routine archival timing never turns
            // into a hard failure (captureSuccessfulMergeEvidence downgrades an
            // unmatched binding to a recorded warning, not a thrown error).
            const containerReportPath = `${container}/report.md`;
            const reportPath = existsSync(containerReportPath) ? containerReportPath : archivedReport;
            const reportPathCandidates = [containerReportPath, archivedReport].filter((path) => path !== reportPath);
            const recovered = recordMergeControlOutcome({
              roots,
              workId,
              sessionId,
              outcome: {
                status: "success",
                commit,
                requestPath: result.requestPath,
                resultPath: result.path,
                reportPath,
                reportPathCandidates,
                guardianReportPath: typeof result.request.guardian_report_path === "string" ? result.request.guardian_report_path : undefined,
                observerReportPath: typeof result.request.observer_report_path === "string" ? result.request.observer_report_path : undefined,
              },
              namespaceLock: guard.lock,
              requireLiveClaim: false,
            });
            controlUpdate = { ...recovered, status: "evidence-recovered", work_id: workId };
          } else {
            const released = binding.claim?.session_id === sessionId ? releaseDispatchControlClaim(roots, workId, sessionId, guard.lock) : false;
            controlUpdate = { status: "evidence-verified", work_id: workId, released };
          }
          }
        } else if (binding.claim?.session_id === sessionId) {
            const updated = recordMergeControlOutcome({
              roots,
              workId,
              sessionId,
              outcome: {
                status: "aborted",
                failureReason: `dispatch cleanup before a confirmed merge (merge_status=${mergeStatus})`,
              },
              namespaceLock: guard.lock,
            });
            controlUpdate = { ...updated, status: "aborted", work_id: workId };
        } else controlUpdate = { status: "already-released", work_id: workId };
      }
      }
    } catch (error) {
      const message = (error as Error).message;
      if (!forceRemove) {
        fail(
          `dispatch_cleanup: schema-v${controlSchema} control update failed; no checkout/branch removal performed: ${message}\n` +
          `NEXT_COMMAND: bun skills/garelier-core/driver/src/scripts/dispatch_cleanup.ts --project ${project} --target-root ${gitRoot} --pm-id ${pm} --id ${id} --checkout ${checkout} --force-remove${deleteBranch ? " --delete-branch" : ""}`,
          4,
        );
      }
      // --force-remove authorizes the removal half only. Preserve the failed
      // Control update as explicit output and continue with the already-vetted
      // checkout/branch selectors; never pretend Control was finalized.
      err(`dispatch_cleanup: WARNING — Control update failed under --force-remove; continuing removal only: ${message}`);
      controlUpdate = {
        status: "control-update-failed-force-remove",
        work_id: controlIdentity?.workId ?? null,
        error: message,
      };
    }
  }

  let cleanupStatus = "success";
  const cleanupReasons: string[] = [];
  // W-667 F-7: removeCheckoutDir now reports WHICH of its refusals fired and,
  // for a locked dir, the OS error and the processes referencing the path.
  const removalDiag: { reason?: string } = {};
  if (!(await removeCheckoutDir(gitRoot, checkout, forceRemove, selection, removalDiag))) {
    const reason = removalDiag.reason ?? "worktree dir not removed and the cause was not diagnosed";
    err(`dispatch_cleanup: ${reason}; deferring to failed_cleanups.jsonl`);
    appendFailedCleanup(failedFile, id, container, reason);
    cleanupReasons.push(reason);
    cleanupStatus = "deferred";
  }
  if (deleteBranch && branch) {
    git(
      gitRoot,
      forceRemove ? ["branch", "-D", branch] : ["update-ref", "--no-deref", "-d", `refs/heads/${branch}`, branchTip],
      { stdout: "ignore", stderr: "ignore" },
    );
  }

  // W-318 (PM N1) — the checkout lives UNDER the container, so this recursive
  // force-delete used to run even when the removal above had just declined and
  // recorded the checkout as deferred: the "we did not remove it" path removed it
  // one line later. Only collapse the container once its checkout is actually gone.
  if (cleanupStatus === "success") {
    try { removeTreeSync(container); } catch { /* defer below */ }
    if (existsSync(container)) {
      // W-667 F-7: same treatment for the container itself.
      const reason = `container dir not empty / locked: ${container}${describeCheckoutHolders(container)}`;
      appendFailedCleanup(failedFile, id, container, reason);
      cleanupReasons.push(reason);
      cleanupStatus = "deferred";
    }
  }
  const checkoutPresent = existsSync(registeredCheckout);
  const containerPresent = existsSync(container);
  const branchPresent = branch
    ? git(gitRoot, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
    : null;
  if (cleanupStatus === "success" && deleteBranch && branchPresent === true) {
    cleanupStatus = "partial";
    cleanupReasons.push("branch deletion did not remove the selected ref");
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const eventScript = resolve(moduleDir, "dispatch_event.ts");
  if (existsSync(eventScript) && !containerPresent) {
    run(["bun", eventScript, "--project", project, "--pm-id", pm, "--kind", "cleanup", "--role", `dispatch(#${id})`, "--task", `#${id} container removed`], { stdout: "ignore", stderr: "ignore" });
  }
  const heavyLock = resolve(moduleDir, "../../../scripts/heavy_compile_lock.ts");
  if (existsSync(heavyLock)) run(["bun", heavyLock, "--project", project, "--pm-id", pm, "--mode", "sweep"], { stdout: "ignore", stderr: "ignore" });

  const taskMirrorTs = resolve(moduleDir, "../dispatch/task_mirror.ts");
  const taskMirrorHint = `bun ${taskMirrorTs} --pm-id ${pm} --project ${project} --format ops`;
  emitJsonLine({
    id: Number(id),
    checkout_removed: !checkoutPresent,
    container_removed: !containerPresent,
    branch,
    branch_present: branchPresent,
    branch_deleted: deleteBranch && branchPresent === false,
    ...cleanupStatusFields(cleanupStatus, cleanupReasons),
    merge_status: mergeStatus,
    report_source: reportSource,
    long_jobs_retired: retiredLongJobs,
    control_update: controlUpdate,
    repository_findings: repositoryFindings,
    task_mirror_hint: taskMirrorHint,
  });
  return 0;
  } finally { guard.release(); }
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch (error) { process.exit(error instanceof CliFailure ? error.exitCode : 1); }
}
