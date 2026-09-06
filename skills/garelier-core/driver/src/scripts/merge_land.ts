import { rmSync } from "../guard/path_guard.ts";
// merge_land — one background command for the whole PM merge ritual (W-088, TS port W-083).
//
// Faithful port of merge_land.ts. Composition macro over the individually-tested
// sibling scripts (merge_request.ts / gate_result_waiter.ts / dispatch_cleanup.ts /
// merge_request_id_recover.ts) and dock_merge.ts — it adds NO merge/gate logic of
// its own. CLI / stdout JSON / stderr / exit codes / generated-file behavior are
// frozen to the bash original (W-083 §3).
//
// Sibling TypeScript entrypoints resolve relative to this module (or an injected
// test entry directory), while dock_merge + lint_commits resolve from the core
// root. This preserves the relocated W-055 fixture without a shell trampoline.
// The verdict marker parser reuses
// merge_gate_parse.extractVerdict directly.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { extractVerdict } from "../merge_gate_parse.ts";
import { dispatchContainer } from "../workspace.ts";
import { resolveCommand } from "./_lib.ts";
import { MERGE_LAND_FLAGS, MERGE_REQUEST_FLAGS, OTHER_TOOL_FLAG_OWNERS } from "./cli_flag_ownership.ts";
import { finalizeLongMergeEvidence } from "../control/landing_finalize.ts";
import { acquireGarelierOperationGuard, claimDispatchControlWork, garelierControlRoots, garelierControlSchema, inspectDispatchControlBinding, type GarelierOperationGuard } from "../control/garelier_integration.ts";
import { assertChokepointAllowed } from "../integration_closure.ts";
import { loadConfig } from "../config.ts";

// Resolve a dispatch's checkout + context.json through the shared canonical
// workspace resolver.
export function dispatchPaths(project: string, pm: string, id: string): { container: string; checkout: string; context: string } {
  const container = dispatchContainer(project, pm, id);
  return { container, checkout: `${container}/checkout`, context: `${container}/context.json` };
}

export interface MergeLandControlBinding {
  schema: number | null;
  workId: string;
  sessionId: string;
  reportPath: string;
}

// Schema 3 binds a merge to the dispatch context's canonical Backlog/session. The
// caller may repeat the values explicitly, but may not contradict the context.
// Loading the Work through the shared model also proves the canonical record is
// present and structurally valid before merge_request writes anything.
export function resolveMergeLandControlBinding(options: {
  project: string; targetRoot: string; pmId: string; dispatchId?: string;
  workId?: string; sessionId?: string; reportPath?: string;
  ensureClaim?: boolean;
  guard?: GarelierOperationGuard;
}): MergeLandControlBinding {
  const schema = options.guard?.schema ?? garelierControlSchema(options.project, options.pmId);
  if (schema !== 3) throw new Error(`unsupported control schema_version ${schema ?? "missing"}; only schema_version 3 is accepted`);
  let contextWork = "", contextSession = "", container = "";
  let touches: string[] = [];
  if (options.dispatchId) {
    const paths = dispatchPaths(options.project, options.pmId, options.dispatchId);
    container = paths.container;
    if (!existsSync(paths.context)) throw new Error(`schema-v${schema} dispatch context is missing: ${paths.context}`);
    const context = JSON.parse(readFileSync(paths.context, "utf8")) as {
      control?: { work_id?: unknown; session_id?: unknown };
      task?: { touches?: unknown };
    };
    contextWork = typeof context.control?.work_id === "string" ? context.control.work_id : "";
    contextSession = typeof context.control?.session_id === "string" ? context.control.session_id : "";
    touches = Array.isArray(context.task?.touches)
      ? context.task.touches.filter((item): item is string => typeof item === "string")
      : [];
  }
  const workId = options.workId || contextWork;
  const sessionId = options.sessionId || contextSession;
  if (options.workId && contextWork && options.workId !== contextWork) throw new Error(`--work-id ${options.workId} contradicts dispatch context Work ${contextWork}`);
  if (options.sessionId && contextSession && options.sessionId !== contextSession) throw new Error(`--control-session ${options.sessionId} contradicts dispatch context session ${contextSession}`);
  if (!workId || !sessionId) throw new Error(`schema v${schema} requires a canonical Work/Backlog session binding (pass --dispatch-id or --work-id + --control-session)`);
  const roots = garelierControlRoots(options.project, options.targetRoot, options.pmId);
  if (options.ensureClaim) {
    claimDispatchControlWork({
      roots,
      workId,
      sessionId,
      touches,
      dispatchId: options.dispatchId,
      mergeBound: true,
      stealStale: true,
      namespaceLock: options.guard?.lock,
    });
  }
  const binding = inspectDispatchControlBinding(roots, workId, sessionId, options.guard?.lock);
  // W-318: this used to be a dead end. The claim can legitimately be gone (a PM
  // released it, or it was GC'd) while the dispatch container is still live and
  // still bound to the same Work/session, and re-taking it is a single command —
  // the dispatch's own reservation no longer blocks the claim it exists for. Name
  // that command instead of leaving the operator to rediscover it.
  if (!binding.claim) {
    throw new Error(
      `schema-v${schema} Work/Backlog ${workId} has no active dispatch claim. ` +
      `Re-take it and re-run: garelier control claim ${workId} --session ${sessionId} --touches <the dispatch's touches>` +
      `${options.dispatchId ? ` (its own dispatch #${options.dispatchId} does not conflict with this claim)` : ""}.`,
    );
  }
  if (binding.claim.session_id !== sessionId) throw new Error(`schema-v${schema} Work/Backlog ${workId} claim belongs to ${binding.claim.session_id}, not ${sessionId}`);
  const reportPath = options.reportPath || (container ? `${container}/report.md` : "");
  return { schema, workId, sessionId, reportPath };
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const ENTRY_DIR = (process.env.GARELIER_SCRIPT_ENTRY_DIR || moduleDir).replace(/\\/g, "/");
const CORE_DIR = (process.env.GARELIER_CORE_DIR || resolve(moduleDir, "../../..")).replace(/\\/g, "/");
const CORE_SCRIPTS = `${CORE_DIR}/scripts`;
const DRIVER_DISPATCH = (process.env.GARELIER_DRIVER_DISPATCH_DIR || `${CORE_DIR}/driver/src/dispatch`).replace(/\\/g, "/");

export function successfulLandCleanupArgs(
  entryDir: string,
  project: string,
  pmId: string,
  requestId: string,
  dispatchId: string,
  targetRoot: string,
): string[] {
  const args = ["bun", `${entryDir}/dispatch_cleanup.ts`, "--project", project, "--pm-id", pmId];
  if (dispatchId) args.push("--id", dispatchId, "--checkout", join(dispatchContainer(project, pmId, dispatchId), "checkout"));
  args.push("--request-id", requestId, "--delete-branch");
  if (targetRoot) args.push("--target-root", targetRoot);
  return args;
}

export function dispatchIdFromBranch(branch: string): string {
  return /(?:^|\/)(?:workbench|anvil|shelf)\/#([0-9]+)(?:\/|$)/.exec(branch)?.[1] ?? "";
}

// W-372: a branch-bound self-gate structurally cannot see a semantic conflict
// that exists only in the merge result (Guardian-verified 2026-08-04 — the
// row's initial "widen the gate scope" prescription was refuted; base-track is
// the nearest mechanical approximation, since base-tracked tree === trial-merged
// tree). This computes how far a dispatch's RECORDED base_sha has fallen behind
// the current studio tip, at the moment of merge submission — the latest point
// a warning can still change the operator's next action before the merge gate
// spends its own cycle. Returns null when either ref does not resolve (a
// deleted/rewritten base, or an unreadable studio ref) — silence in that case,
// never a false "0 behind".
export function computeBaseBehindStudio(gitRoot: string, baseSha: string, studioTip: string): number | null {
  if (!baseSha || !studioTip) return null;
  const result = runSync(["git", "-C", gitRoot, "rev-list", "--count", `${baseSha}..${studioTip}`]);
  if (result.code !== 0) return null;
  const n = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

export interface BaseBehindStatus { base: string; studio_tip: string; commits_behind: number }

// Reads the dispatch's context.json task.base_sha (the SAME field
// dispatch_prepare.ts records at pickup) and compares it against the
// integration branch's CURRENT tip. Never throws — every failure to resolve a
// piece of the comparison (missing context, missing base_sha, unresolvable
// studio ref) degrades to "no detection" so this can never block a submit.
export function detectBaseBehindAtSubmit(input: {
  contextPath: string; gitRoot: string; integrationBranch: string;
}): BaseBehindStatus | null {
  if (!existsSync(input.contextPath)) return null;
  let recordedBaseSha = "";
  try { recordedBaseSha = firstMatch(readFileSync(input.contextPath, "utf8"), /"base_sha":\s*"([^"]*)"/); } catch { recordedBaseSha = ""; }
  if (!recordedBaseSha || !input.integrationBranch) return null;
  const tip = runSync(["git", "-C", input.gitRoot, "rev-parse", input.integrationBranch]);
  const studioTip = tip.code === 0 ? tip.stdout.trim() : "";
  if (!studioTip) return null;
  const commitsBehind = computeBaseBehindStudio(input.gitRoot, recordedBaseSha, studioTip);
  if (commitsBehind === null || commitsBehind <= 0) return null;
  return { base: recordedBaseSha, studio_tip: studioTip, commits_behind: commitsBehind };
}

export function baseBehindWarning(dispatchId: string, branch: string, status: BaseBehindStatus): string {
  return `merge_land: ⚠ BASE BEHIND STUDIO (W-372) — dispatch #${dispatchId || "?"}'s recorded base ${status.base} is ${status.commits_behind} commit(s) behind studio tip ${status.studio_tip}. A branch-bound self-gate cannot see a semantic conflict that exists only in the merge result. Base-track (merge studio into ${branch || "this branch"}) and re-run the whole-project quality-gate command on the tracked tree BEFORE trusting this self-gate. This is a WARNING, not a block — the merge gate itself still runs its own check on the merged tree.`;
}

export function baseBehindJsonField(status: BaseBehindStatus | null): string {
  if (!status) return "";
  return `,"base_behind":{"base":"${jesc(status.base)}","studio_tip":"${jesc(status.studio_tip)}","commits_behind":${status.commits_behind}}`;
}

const HELP = `#
# merge_land.ts — one background command for the whole PM merge ritual (W-088).
#
# Submits, BLOCK-waits for the gate result, and only on a landed merge cleans up
# + pulls. On a failed/aborted/timed-out gate it cleans up NOTHING and returns
# the failure.
#
# Usage:
#   merge_land.ts --project <control-root> --pm-id <id>
#                 (--branch <workbench-branch> | --dispatch-id <N>)
#                 [--guardian <PASS|PASS_WITH_NOTES>] [--observer <verdict>]
#                 [--seat-trailer <checked|skip>]
#                   Overrides the seat-trailer PREFLIGHT when it cannot decide —
#                   the container/context.json is unresolvable, or its content is
#                   unreadable (neither routing.commit_mode nor routing.model),
#                   both of which fail closed. checked = "I verified the proxy
#                   commits by hand", skip = "this dispatch needs no check".
#                   On a resolvable proxy dispatch it SKIPS the lint entirely,
#                   so it is an assertion by the operator, not a re-check: the
#                   ordinary fix for a failing trailer is to repair the commit.
#                   A Dock base-track merge commit no longer needs this flag at
#                   all — a two-parent commit is outside the seat-trailer
#                   denominator (W-692).
#                 [--no-pull]
#                 [--close-row <item-id> …]
#                 [--max-wait <seconds>] [--poll-interval <seconds>]
#                 [ …any other merge_request.ts flag… ]
#
# Batch mode (W-022): --id <N1> --id <N2> …  OR  --batch <file>.
`;

// ── process helpers ─────────────────────────────────────────────────────────
interface Cmd { code: number; stdout: string; stderr: string }
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const SUCCESSFUL_LAND_CLEANUP_TIMEOUT_MS = 120_000;
const RECURSIVE_MERGE_TIMEOUT_MS = 8_640_000;

export function classifyMergeLandChild(input: {
  exitCode?: number | null;
  signalCode?: string | number | null;
  exitedDueToTimeout?: boolean;
  spawnError?: unknown;
}, timeoutMs: number, command: readonly string[], stdout = "", stderr = ""): Cmd {
  if (input.exitedDueToTimeout) {
    return { code: 124, stdout, stderr: `${stderr}${stderr ? "\n" : ""}merge_land: child timed out after ${timeoutMs}ms: ${command.join(" ")}` };
  }
  if (input.signalCode) {
    return { code: 128, stdout, stderr: `${stderr}${stderr ? "\n" : ""}merge_land: child terminated by signal ${input.signalCode}: ${command.join(" ")}` };
  }
  if (input.spawnError !== undefined) {
    const detail = input.spawnError instanceof Error ? input.spawnError.message : String(input.spawnError);
    return { code: 127, stdout, stderr: `merge_land: child spawn failed: ${detail}` };
  }
  if (input.exitCode === null || input.exitCode === undefined) {
    return { code: 127, stdout, stderr: `merge_land: child exited without a status: ${command.join(" ")}` };
  }
  return { code: input.exitCode, stdout, stderr };
}

function runSync(command: string[], opts: { stderrTo?: "capture" | "inherit"; timeoutMs?: number } = {}): Cmd {
  const resolved = resolveCommand(command);
  if (!resolved) return { code: 127, stdout: "", stderr: `required executable not found: ${command[0] ?? "<empty>"}` };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  try {
    const c = Bun.spawnSync(resolved, { windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: opts.stderrTo === "inherit" ? "inherit" : "pipe",
      timeout: timeoutMs,
    });
    const stdout = c.stdout?.toString() ?? "";
    const stderr = opts.stderrTo === "inherit" ? "" : (c.stderr?.toString() ?? "");
    return classifyMergeLandChild(c, timeoutMs, command, stdout, stderr);
  } catch (error) {
    return classifyMergeLandChild({ spawnError: error }, timeoutMs, command);
  }
}
function err(s: string): void { process.stderr.write(s.endsWith("\n") ? s : s + "\n"); }
function out(s: string): void { process.stdout.write(s.endsWith("\n") ? s : s + "\n"); }
function jesc(s: string): string { return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function firstMatch(text: string, re: RegExp): string { const m = text.match(re); return m ? m[1] : ""; }

export function classifyMergeLandWaitFailure(
  waitRc: number,
  statusLine: string,
  parsedStatus = "",
  parsedDetail = "",
): { status: string; detail: string } {
  const status = parsedStatus || (waitRc === 125 ? "control_settlement_timeout" : waitRc === 124 ? "timeout" : "failed");
  const detail = parsedDetail || (waitRc === 125
    ? firstMatch(statusLine, /^MERGE_CONTROL_SETTLEMENT_TIMEOUT: (.*)$/m)
    : firstMatch(statusLine, /^MERGE_TIMEOUT: (.*)$/m));
  return { status, detail };
}

// read_marker_verdict — emit the canonical verdict token under `## Verdict`, or
// NOTHING when present-but-malformed (callers gate on file existence first, so an
// empty return there means malformed → the stderr note below).
function readMarkerVerdict(markerPath: string): string {
  let text: string;
  try { text = readFileSync(markerPath, "utf8"); } catch { return ""; }
  const v = extractVerdict(text);
  if (v) return v;
  err(`merge_land: verdict marker ${markerPath} is present but MALFORMED — no bare canonical token under '## Verdict' (a prose sentence, an unfilled {{…}} menu, bold like **PASS**, or a typo like PASSED all read as no-verdict; fix per templates/gate_verdict.md)`);
  return "";
}

export interface ResolvedMergeLandVerdict {
  verdict: string;
  reportPath: string;
  source: "token" | "file";
}

/** A canonical token remains an explicit override; every other value must be a
 * real verdict file. This turns the measured `--guardian <path>` refusal into
 * the same authenticated report binding merge_request already validates. */
export function resolveMergeLandVerdictInput(value: string, role: "Guardian" | "Observer"): ResolvedMergeLandVerdict {
  const canonical = new Set(["PASS", "PASS_WITH_NOTES", "REWORK_RECOMMENDED", "BLOCK", "NO_OPINION"]);
  if (canonical.has(value)) return { verdict: value, reportPath: "", source: "token" };
  if (!existsSync(value)) {
    throw new Error(`${role} verdict input is neither a canonical token nor an existing report: ${value}`);
  }
  const verdict = readMarkerVerdict(value);
  if (!verdict) throw new Error(`${role} verdict report is malformed: ${value}`);
  return { verdict, reportPath: resolve(value), source: "file" };
}

export function mergeLandAwaitArgs(
  dockMergeTs: string,
  project: string,
  pmId: string,
  requestId: string,
  maxWaitSeconds = "",
  pollIntervalSeconds = "",
): { command: string[]; timeoutMs: number } {
  const ceilingMs = maxWaitSeconds ? Number(maxWaitSeconds) * 1000 : 1_800_000;
  if (!Number.isFinite(ceilingMs) || ceilingMs < 60_000) {
    throw new Error(`--max-wait must be at least 60 seconds (got '${maxWaitSeconds}')`);
  }
  const pollMs = pollIntervalSeconds ? Number(pollIntervalSeconds) * 1000 : 3_000;
  if (!Number.isFinite(pollMs) || pollMs < 250) {
    throw new Error(`--poll-interval must be at least 0.25 seconds (got '${pollIntervalSeconds}')`);
  }
  return {
    command: ["bun", dockMergeTs, "await", "--pm-id", pmId, "--project", project,
      "--request-id", requestId, "--poll-ms", String(pollMs), "--ceiling-ms", String(ceilingMs)],
    timeoutMs: ceilingMs + 30_000,
  };
}

function main(): number {
  const argv = process.argv.slice(2);

  // ── W-022 batch pre-scan ──────────────────────────────────────────────────
  const scanShared: string[] = [];
  const scanItems: string[] = [];
  let scanBatchFile = "";
  let nId = 0, nBranch = 0;
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--batch") { scanBatchFile = argv[i + 1] ?? ""; i += 2; }
    else if (a === "--id" || a === "--dispatch-id") { nId++; scanItems.push(`--id ${argv[i + 1] ?? ""}`); i += 2; }
    else if (a === "--branch") { nBranch++; scanItems.push(`--branch ${argv[i + 1] ?? ""}`); i += 2; }
    else { scanShared.push(a); i += 1; }
  }
  let batchMode = false;
  if (scanBatchFile) batchMode = true;
  else if (nId >= 2 || nBranch >= 2) batchMode = true;

  if (batchMode) {
    const items: string[] = [];
    if (scanBatchFile) {
      if (nId > 0 || nBranch > 0) { err("merge_land: --batch <file> cannot be combined with top-level --id/--branch (put each item's flags on its own line in the file)"); return 2; }
      if (!existsSync(scanBatchFile)) { err(`merge_land: --batch file not found: ${scanBatchFile}`); return 2; }
      const lines = readFileSync(scanBatchFile, "utf8").split("\n");
      for (const raw of lines) {
        const line = raw.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");
        if (!line) continue;
        if (line.startsWith("#")) continue;
        items.push(line);
      }
      if (items.length === 0) { err(`merge_land: --batch file ${scanBatchFile} has no item lines`); return 2; }
    } else {
      items.push(...scanItems);
    }

    const total = items.length;
    let n = 0, landed = 0;
    err(`merge_land: batch of ${total} item(s) — landing serially, aborting the rest on the first failure.`);
    for (const it of items) {
      n++;
      const iargs = it.split(/\s+/).filter((s) => s.length > 0);
      err(`merge_land: [batch ${n}/${total}] landing: ${iargs.join(" ")}`);
      const r = runSync(["bun", `${ENTRY_DIR}/merge_land.ts`, ...scanShared, ...iargs], { stderrTo: "inherit", timeoutMs: RECURSIVE_MERGE_TIMEOUT_MS });
      if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
      if (r.code !== 0) {
        err(`merge_land: [batch ${n}/${total}] FAILED (rc=${r.code}) — aborting; ${total - n} remaining item(s) NOT attempted.`);
        out(`{"batch":true,"total":${total},"attempted":${n},"landed":${landed},"status":"failed","failed_item":"${jesc(it)}"}`);
        return r.code;
      }
      landed++;
      err(`merge_land: [batch ${n}/${total}] landed.`);
    }
    err(`merge_land: batch complete — all ${total} item(s) landed.`);
    out(`{"batch":true,"total":${total},"attempted":${total},"landed":${landed},"status":"success"}`);
    return 0;
  }

  // ── single-land arg parse ──────────────────────────────────────────────────
  const MR_ARGS: string[] = [];
  let PROJECT = "", PM = "", BRANCH = "", TARGET_ROOT = "", DISPATCH_ID = "";
  let NO_PULL = 0, MAX_WAIT = "", POLL_INTERVAL = "";
  let GUARDIAN = "", OBSERVER = "", IN_SEAT_TRAILER = "";
  let WORK_ID = "", CONTROL_SESSION = "", ROLE_REPORT = "";
  const CLOSE_ROWS: string[] = [];
  const need = (i: number, flag: string): string => { const v = argv[i + 1]; if (v === undefined || v === "") { err(`merge_land: ${flag} requires a value`); process.exit(2); } return v; };
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    switch (a) {
      case "--project": PROJECT = need(i, a); MR_ARGS.push(a, PROJECT); i += 2; break;
      case "--pm-id": PM = need(i, a); MR_ARGS.push(a, PM); i += 2; break;
      case "--target-root": TARGET_ROOT = need(i, a); MR_ARGS.push(a, TARGET_ROOT); i += 2; break;
      case "--branch": BRANCH = need(i, a); i += 2; break;
      case "--guardian": GUARDIAN = need(i, a); i += 2; break;
      case "--observer": OBSERVER = need(i, a); i += 2; break;
      case "--work-id": WORK_ID = need(i, a); i += 2; break;
      case "--control-session": CONTROL_SESSION = need(i, a); i += 2; break;
      case "--report": ROLE_REPORT = need(i, a); i += 2; break;
      case "--seat-trailer": IN_SEAT_TRAILER = need(i, a); i += 2; break;
      case "--dispatch-id": case "--id": DISPATCH_ID = need(i, a); i += 2; break;
      case "--no-pull": NO_PULL = 1; i += 1; break;
      case "--close-row": CLOSE_ROWS.push(need(i, a)); i += 2; break;
      case "--max-wait": MAX_WAIT = need(i, a); i += 2; break;
      case "--poll-interval": POLL_INTERVAL = need(i, a); i += 2; break;
      case "-h": case "--help": process.stdout.write(HELP); process.exit(0);
      default: MR_ARGS.push(a); i += 1; break;
    }
  }
  // W-622 (blueprint §2.1) / G-2 — check the forwarding promise before spawning.
  //
  // The banner offers "…any other merge_request.ts flag…" and the default branch
  // above forwards ANY unrecognized token. Those are not the same set: a flag
  // belonging to a different tool is forwarded happily and dies one process later
  // as `merge_request: unknown arg: --rebind-authority`, which reads as a bug in
  // merge_request rather than "merge_land does not take this flag". A PM lost a
  // round to exactly that.
  //
  // This narrows nothing: every flag merge_request accepts still forwards. What
  // changes is WHERE and HOW a flag it never accepted is reported.
  const forwardedUnknown = MR_ARGS.filter((token) => token.startsWith("--") && !MERGE_REQUEST_FLAGS.includes(token));
  if (forwardedUnknown.length) {
    err(`merge_land: not a merge_request flag: ${forwardedUnknown.join(" ")}`);
    err("merge_land: merge_land forwards unrecognized flags to merge_request.ts, so a flag must belong to one of the two.");
    err(`merge_land: merge_land's own flags: ${MERGE_LAND_FLAGS.join(" ")}`);
    err(`merge_land: merge_request's flags: ${MERGE_REQUEST_FLAGS.join(" ")}`);
    for (const token of forwardedUnknown) {
      const owner = OTHER_TOOL_FLAG_OWNERS[token];
      // Only when the flag demonstrably belongs elsewhere: pointing at the right
      // tool is the difference between one round and three.
      if (owner) err(`merge_land: ${token} is a ${owner} flag — run ${owner} directly for it, not through merge_land.`);
    }
    return 2;
  }
  if (IN_SEAT_TRAILER !== "" && IN_SEAT_TRAILER !== "checked" && IN_SEAT_TRAILER !== "skip") {
    err(`merge_land: --seat-trailer must be 'checked' or 'skip' (got '${IN_SEAT_TRAILER}')`); return 2;
  }
  if (!PROJECT || !PM) { err("merge_land: --project and --pm-id are required"); return 2; }
  const GIT_ROOT = TARGET_ROOT || PROJECT;
  const PM_ROOT = `${PROJECT}/__garelier/${PM}`;
  const controlRoots = garelierControlRoots(PROJECT, GIT_ROOT, PM);
  let guard: GarelierOperationGuard;
  try { guard = acquireGarelierOperationGuard(controlRoots, CONTROL_SESSION || `merge-land-${process.pid}`, "merge-land"); }
  catch (error) { err(`merge_land: ${(error as Error).message}`); return 2; }

  // ── (W-017 a) resolve --branch from --dispatch-id ─────────────────────────
  let BRANCH_ERR = "";
  if (!BRANCH && DISPATCH_ID) {
    const checkout = dispatchPaths(PROJECT, PM, DISPATCH_ID).checkout;
    if (!existsSync(checkout)) {
      BRANCH_ERR = `--dispatch-id ${DISPATCH_ID} given but no dispatch checkout at ${checkout} (prepare it first, or it was already cleaned up) — or pass --branch explicitly`;
    } else {
      const r = runSync(["git", "-C", checkout, "symbolic-ref", "--short", "HEAD"]);
      BRANCH = r.code === 0 ? r.stdout.trim() : "";
      if (BRANCH) err(`merge_land: resolved --branch ${BRANCH} from dispatch #${DISPATCH_ID} checkout`);
      else BRANCH_ERR = `dispatch #${DISPATCH_ID} checkout at ${checkout} is not on a branch (detached HEAD?) — pass --branch explicitly`;
    }
  }

  // dispatch id for cleanup: explicit, else a canonical dispatch-bearing lane.
  if (!DISPATCH_ID && BRANCH) DISPATCH_ID = dispatchIdFromBranch(BRANCH);

  // ── W-372: base-behind detection at merge-submit time ─────────────────────
  // Advisory only (never a hard block — the merge gate is the final net). See
  // computeBaseBehindStudio/detectBaseBehindAtSubmit above for the rationale.
  let BASE_BEHIND: BaseBehindStatus | null = null;
  if (DISPATCH_ID) {
    let integrationBranch = "";
    try { integrationBranch = loadConfig(PROJECT, PM).branches.integration; } catch { integrationBranch = ""; }
    BASE_BEHIND = detectBaseBehindAtSubmit({
      contextPath: dispatchPaths(PROJECT, PM, DISPATCH_ID).context,
      gitRoot: GIT_ROOT,
      integrationBranch,
    });
    if (BASE_BEHIND) err(baseBehindWarning(DISPATCH_ID, BRANCH, BASE_BEHIND));
  }
  const BASE_BEHIND_JSON = baseBehindJsonField(BASE_BEHIND);

  let CONTROL_SCHEMA: number | null = null;
  try {
    const binding = resolveMergeLandControlBinding({
      project: PROJECT, targetRoot: GIT_ROOT, pmId: PM, dispatchId: DISPATCH_ID,
      workId: WORK_ID, sessionId: CONTROL_SESSION, reportPath: ROLE_REPORT,
      ensureClaim: !!DISPATCH_ID,
      guard,
    });
    CONTROL_SCHEMA = binding.schema;
    WORK_ID = binding.workId;
    CONTROL_SESSION = binding.sessionId;
    ROLE_REPORT = binding.reportPath;
  } catch (error) {
    const message = (error as Error).message;
    err(`merge_land: schema-aware control binding rejected: ${message}`);
    if (DISPATCH_ID) {
      if (/claim belongs to .* not |Work already has an active claim/.test(message)) {
        const context = dispatchPaths(PROJECT, PM, DISPATCH_ID).context;
        let boundWork = WORK_ID;
        try { boundWork ||= String((JSON.parse(readFileSync(context, "utf8")) as { control?: { work_id?: unknown } }).control?.work_id ?? ""); } catch { /* fallback below */ }
        err(`NEXT_COMMAND: garelier control get ${JSON.stringify(boundWork)} --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --format json`);
      } else {
        err(`NEXT_COMMAND: bun ${ENTRY_DIR}/merge_land.ts --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --dispatch-id ${JSON.stringify(DISPATCH_ID)}`);
      }
    }
    return 2;
  } finally { guard.release(); }
  if (CONTROL_SCHEMA !== 3) {
    err(`merge_land: unsupported control schema_version ${CONTROL_SCHEMA ?? "missing"}; only schema_version 3 is accepted`);
    return 2;
  }
  if (CONTROL_SCHEMA === 3) {
    if (CLOSE_ROWS.some((id) => id !== WORK_ID)) {
      err(`merge_land: schema-v${CONTROL_SCHEMA} --close-row must match the bound Work/Backlog ${WORK_ID}; canonical state/evidence replaces dashboard row deletion.`);
      return 2;
    }
    MR_ARGS.push("--work-id", WORK_ID, "--control-session", CONTROL_SESSION);
    if (ROLE_REPORT) MR_ARGS.push("--report", ROLE_REPORT);
  }

  // ── seat-trailer preflight (guardian round-2/3, W-051) ────────────────────
  let SEAT_TRAILER_ERR = "";
  if (DISPATCH_ID) {
    const { context: seatCtx, checkout: seatCheckout } = dispatchPaths(PROJECT, PM, DISPATCH_ID);
    if (existsSync(seatCtx) && existsSync(seatCheckout)) {
      const ctxText = (() => { try { return readFileSync(seatCtx, "utf8"); } catch { return ""; } })();
      const seatCommitMode = firstMatch(ctxText, /"commit_mode":\s*"([^"]*)"/);
      let seatIsProxy = 0, seatUnreadable = 0;
      if (seatCommitMode === "proxy") seatIsProxy = 1;
      else if (seatCommitMode === "self") seatIsProxy = 0;
      else {
        const seatModel = firstMatch(ctxText, /"model":\s*"([^"]*)"/);
        if (/codex/.test(seatModel)) seatIsProxy = 1;
        else if (!seatCommitMode && !seatModel) seatUnreadable = 1;
      }
      if (seatIsProxy === 1) {
        if (IN_SEAT_TRAILER) {
          err(`merge_land: seat-trailer check skipped for dispatch #${DISPATCH_ID} — explicit --seat-trailer ${IN_SEAT_TRAILER} override`);
        } else {
          const seatBaseSha = firstMatch(ctxText, /"base_sha":\s*"([^"]*)"/);
          const seatLintTs = `${CORE_SCRIPTS}/lint_commits.ts`;
          let seatHandover = 0;
          if (seatBaseSha && existsSync(seatLintTs)) {
            const summaryJson = runSync(["bun", seatLintTs, "--range", seatBaseSha, seatCheckout, "--seat-summary"]).stdout;
            const seatTotal = firstMatch(summaryJson, /"total":([0-9]*)/);
            const seatSelf = firstMatch(summaryJson, /"self":([0-9]*)/);
            if (seatTotal && parseInt(seatTotal, 10) > 0 && seatTotal === seatSelf) {
              seatHandover = 1;
              err(`merge_land: seat handover detected: context.json commit_mode=proxy but branch carries self trailers (${seatTotal}/${seatTotal} commits since ${seatBaseSha}) — switching preflight to self-mode (W-051)`);
            }
            if (seatHandover !== 1) {
              const lint = runSync(["bun", seatLintTs, "--range", seatBaseSha, seatCheckout, "--require-seat-trailer"]);
              if (lint.code !== 0) {
                err(lint.stdout + lint.stderr);
                SEAT_TRAILER_ERR = `dispatch #${DISPATCH_ID} is commit_mode=proxy (or codex-model-inferred) but one or more commits on ${BRANCH || "<unresolved>"} (since ${seatBaseSha}) fail --require-seat-trailer (missing/malformed Garelier-Seat trailer — see lint output on stderr above); the Dock must inject/fix the trailer per dispatch_prepare.ts's COMMIT_RULE duty 2/3 before landing, or pass --seat-trailer checked if you have manually verified it`;
              }
            }
          }
        }
      } else if (seatUnreadable === 1) {
        if (IN_SEAT_TRAILER) {
          err(`merge_land: seat-trailer check skipped for dispatch #${DISPATCH_ID} — context.json content unreadable (neither commit_mode nor model resolved), explicit --seat-trailer ${IN_SEAT_TRAILER} override given`);
        } else {
          SEAT_TRAILER_ERR = `dispatch #${DISPATCH_ID}'s context.json (${seatCtx}) exists but its content is unreadable — neither routing.commit_mode nor routing.model resolved to a value (corrupted/emptied, not merely a stripped field); cannot determine whether this was a commit_mode=proxy dispatch needing a Garelier-Seat trailer check (round-3 residual: fail-closed, same boundary as an unresolvable container); pass --seat-trailer checked (you manually verified the commits) or --seat-trailer skip (this dispatch needs no check) to proceed`;
        }
      }
    } else if (IN_SEAT_TRAILER) {
      err(`merge_land: seat-trailer check skipped for dispatch #${DISPATCH_ID} — container unresolvable, explicit --seat-trailer ${IN_SEAT_TRAILER} override given`);
    } else {
      SEAT_TRAILER_ERR = `dispatch #${DISPATCH_ID}'s container/context.json is unresolvable (${seatCtx} / ${seatCheckout}) — cannot determine whether this was a commit_mode=proxy dispatch needing a Garelier-Seat trailer check (round-3: fail-closed, since the role itself can delete/strip this file); pass --seat-trailer checked (you manually verified the commits) or --seat-trailer skip (this dispatch needs no check) to proceed`;
    }
  }

  // ── (W-017 c) auto-read Guardian/Observer verdicts from markers ───────────
  const SLUG = BRANCH.includes("/") ? BRANCH.slice(BRANCH.lastIndexOf("/") + 1) : BRANCH;
  let GUARDIAN_SRC = "flag", GMARKER = "", OMARKER = "";
  let GUARDIAN_REPORT = "", OBSERVER_REPORT = "";
  if (BRANCH) {
    GMARKER = `${PM_ROOT}/runtime/guardian/results/${SLUG}-guardian.md`;
    OMARKER = `${PM_ROOT}/runtime/observer/results/${SLUG}-observer.md`;
    if (!GUARDIAN && existsSync(GMARKER)) {
      GUARDIAN = readMarkerVerdict(GMARKER);
      if (GUARDIAN) { GUARDIAN_SRC = "auto"; GUARDIAN_REPORT = resolve(GMARKER); err(`merge_land: auto-read Guardian verdict '${GUARDIAN}' from ${GMARKER}`); }
    }
    if (!OBSERVER && existsSync(OMARKER)) {
      OBSERVER = readMarkerVerdict(OMARKER);
      if (OBSERVER) { OBSERVER_REPORT = resolve(OMARKER); err(`merge_land: auto-read Observer verdict '${OBSERVER}' from ${OMARKER}`); }
    }
  }

  try {
    if (GUARDIAN && GUARDIAN_SRC === "flag") {
      const resolved = resolveMergeLandVerdictInput(GUARDIAN, "Guardian");
      GUARDIAN = resolved.verdict;
      GUARDIAN_REPORT = resolved.reportPath;
      if (resolved.source === "file") err(`merge_land: read Guardian verdict '${GUARDIAN}' from explicit report ${GUARDIAN_REPORT}`);
    }
    if (OBSERVER) {
      const resolved = resolveMergeLandVerdictInput(OBSERVER, "Observer");
      OBSERVER = resolved.verdict;
      OBSERVER_REPORT ||= resolved.reportPath;
      if (resolved.source === "file") err(`merge_land: read Observer verdict '${OBSERVER}' from explicit report ${OBSERVER_REPORT}`);
    }
  } catch (error) {
    const retry = `bun ${ENTRY_DIR}/merge_land.ts --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --dispatch-id ${JSON.stringify(DISPATCH_ID)}`;
    err(`merge_land: ${(error as Error).message}\nNEXT_COMMAND: ${retry}`);
    return 2;
  }

  // ── (W-017 b) one-shot pre-validation ─────────────────────────────────────
  const ERRORS: string[] = [];
  if (!BRANCH) {
    ERRORS.push(BRANCH_ERR || "no merge branch: pass --branch <workbench-branch>, or --dispatch-id <N> (alias --id) to auto-resolve it from the dispatch container");
  }
  if (SEAT_TRAILER_ERR) ERRORS.push(SEAT_TRAILER_ERR);
  if (!GUARDIAN) {
    if (BRANCH && existsSync(GMARKER)) {
      ERRORS.push(`Guardian verdict required: the marker at ${GMARKER} is present but MALFORMED (no bare canonical token under '## Verdict' — see the stderr note above and templates/gate_verdict.md); have the gate role fix it, or pass --guardian <PASS|PASS_WITH_NOTES> to override`);
    } else if (BRANCH) {
      ERRORS.push(`Guardian verdict required: pass --guardian <PASS|PASS_WITH_NOTES>, or run Guardian so a verdict marker exists at ${GMARKER} ([guardian_policy] require_for_all_merges rejects a merge without one)`);
    } else {
      ERRORS.push("Guardian verdict required: pass --guardian <PASS|PASS_WITH_NOTES> (or resolve --branch/--dispatch-id first so the Guardian marker can be auto-read)");
    }
  } else if (GUARDIAN_SRC === "auto") {
    if (GUARDIAN !== "PASS" && GUARDIAN !== "PASS_WITH_NOTES") {
      ERRORS.push(`auto-read Guardian verdict is ${GUARDIAN} (from ${GMARKER}), not PASS/PASS_WITH_NOTES — nothing to land; re-run Guardian, or pass --guardian explicitly to override`);
    }
  }
  if (ERRORS.length > 0) {
    err("merge_land: cannot submit — resolve the following first:");
    for (const e of ERRORS) err(`  - ${e}`);
    err("");
    process.stderr.write(HELP);
    return 2;
  }

  // forward resolved branch + verdicts to merge_request.
  MR_ARGS.push("--branch", BRANCH, "--guardian", GUARDIAN);
  if (GUARDIAN_REPORT) MR_ARGS.push("--guardian-report", GUARDIAN_REPORT);
  if (DISPATCH_ID) MR_ARGS.push("--dispatch-id", DISPATCH_ID, "--aftercare-binding", "dispatch");
  else MR_ARGS.push("--aftercare-binding", "branch_only");
  if (OBSERVER) MR_ARGS.push("--observer", OBSERVER);
  if (OBSERVER_REPORT) MR_ARGS.push("--observer-report", OBSERVER_REPORT);
  const messageIndex = argv.indexOf("--message");
  const suppliedMessage = messageIndex >= 0 ? argv[messageIndex + 1] ?? "" : "";
  const trailer = suppliedMessage.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("Garelier:"));
  const trailerFields = trailer?.match(/^Garelier:\s+(\S+)\s+(\S+)\s+(W-\d+)$/);
  if (suppliedMessage && (!trailerFields || trailerFields[1] !== PM || trailerFields[3] !== WORK_ID)) {
    err(`merge_land: schema-v${CONTROL_SCHEMA} merge message must carry the bound trailer 'Garelier: ${PM} <actor> ${WORK_ID}'.`);
    return 2;
  }
  if (!suppliedMessage) {
    MR_ARGS.push("--message", `chore(merge): land ${WORK_ID}\n\nGuardian ${GUARDIAN}${OBSERVER ? `; Observer ${OBSERVER}` : ""}.\n\nGarelier: ${PM} merge ${WORK_ID}`);
  }

  // ── W-346 FR5: land-entry chokepoint — refuse early, touching nothing ─────
  // merge_request/pollMergeGate/merge-gate.ts each re-check independently; this
  // early exit just gives the operator one clean refusal instead of a submit
  // that queues nothing. Pass-through when no closure state exists.
  try {
    const integrationBranch = loadConfig(PROJECT, PM).branches.integration;
    const closureVerdict = assertChokepointAllowed(resolve(PROJECT).replace(/\\/g, "/"), PM, integrationBranch, { requestKind: "ordinary" });
    if (!closureVerdict.allowed) {
      err(`merge_land: ${closureVerdict.reason} — not submitting; retry after the closure lease closes (W-346)`);
      out(`{"status":"closure_blocked","failure_reason":"${jesc(closureVerdict.reason)}","cleaned_up":false${BASE_BEHIND_JSON}}`);
      return 3;
    }
  } catch { /* config unreadable here → let the submit path surface its own error */ }

  // ── 1. submit WITHOUT poll ─────────────────────────────────────────────────
  const tmpDir = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/merge_land-`);
  const mrErrFile = `${tmpDir}/mr.err`;
  const submitStart = Math.floor(Date.now() / 1000);
  let mr = runSync(["bun", `${ENTRY_DIR}/merge_request.ts`, "--no-poll", ...MR_ARGS]);
  if (mr.code !== 0 && DISPATCH_ID && GUARDIAN_REPORT
    && /item authority source changed after authorization/.test(mr.stderr)) {
    const rebind = runSync(["bun", `${ENTRY_DIR}/dispatch_prepare.ts`,
      "--project", PROJECT, "--target-root", GIT_ROOT, "--pm-id", PM,
      "--rebind-authority", "--id", DISPATCH_ID, "--evidence", GUARDIAN_REPORT]);
    if (rebind.code !== 0) {
      err(`${mr.stderr}${rebind.stderr}`);
      err(`NEXT_COMMAND: bun ${ENTRY_DIR}/dispatch_prepare.ts --project ${JSON.stringify(PROJECT)} --target-root ${JSON.stringify(GIT_ROOT)} --pm-id ${JSON.stringify(PM)} --rebind-authority --id ${DISPATCH_ID} --evidence ${JSON.stringify(GUARDIAN_REPORT)}`);
      cleanupTmp(tmpDir);
      return rebind.code;
    }
    err(`merge_land: authority changed; rebound dispatch #${DISPATCH_ID} from ${GUARDIAN_REPORT} and resubmitting.`);
    mr = runSync(["bun", `${ENTRY_DIR}/merge_request.ts`, "--no-poll", ...MR_ARGS]);
  }
  writeFileSync(mrErrFile, mr.stderr);
  if (mr.stderr) process.stderr.write(mr.stderr);
  let REQ_ID = "";
  try { REQ_ID = String((JSON.parse(mr.stdout) as Record<string, unknown>).request_id ?? ""); } catch { REQ_ID = ""; }
  if (!REQ_ID && mr.code === 0) {
    const rec = runSync(["bun", `${ENTRY_DIR}/merge_request_id_recover.ts`,
      "--stderr-file", mrErrFile,
      "--requests-dir", `${PROJECT}/__garelier/${PM}/runtime/merge_gate/requests`,
      "--since", String(submitStart)]);
    REQ_ID = rec.code === 0 ? rec.stdout.trim() : "";
    if (REQ_ID) err(`merge_land: recovered request_id=${REQ_ID} from the request file (stdout parse failed — W-064).`);
  }
  if (!REQ_ID) {
    err(`merge_land: submit produced no request_id (merge_request rc=${mr.code}); no request was created — aborting.`);
    err(`NEXT_COMMAND: bun ${ENTRY_DIR}/merge_land.ts --project ${JSON.stringify(PROJECT)} --pm-id ${JSON.stringify(PM)} --dispatch-id ${JSON.stringify(DISPATCH_ID)}`);
    cleanupTmp(tmpDir);
    return 1;
  }

  // ── 2. await through Dock's existing single-poller path ────────────────────
  const dockMergeTs = `${DRIVER_DISPATCH}/dock_merge.ts`;
  if (!existsSync(dockMergeTs)) {
    err(`merge_land: dock_merge.ts not found at ${dockMergeTs}.`);
    err(`NEXT_COMMAND: bun ${JSON.stringify(dockMergeTs)} await --pm-id ${JSON.stringify(PM)} --project ${JSON.stringify(PROJECT)} --request-id ${JSON.stringify(REQ_ID)}`);
    cleanupTmp(tmpDir);
    return 1;
  }
  err(`merge_land: submitted ${REQ_ID}; waiting for the gate result…`);
  const RESULT_FILE = `${PROJECT}/__garelier/${PM}/runtime/merge_gate/results/${REQ_ID}.json`;
  let awaitSpec: ReturnType<typeof mergeLandAwaitArgs>;
  try { awaitSpec = mergeLandAwaitArgs(dockMergeTs, PROJECT, PM, REQ_ID, MAX_WAIT, POLL_INTERVAL); }
  catch (error) { err(`merge_land: ${(error as Error).message}`); cleanupTmp(tmpDir); return 2; }
  const wait = runSync(awaitSpec.command, { timeoutMs: awaitSpec.timeoutMs });
  if (wait.stderr) err(wait.stderr);
  let terminal: Record<string, unknown> = {};
  try { terminal = JSON.parse(wait.stdout) as Record<string, unknown>; }
  catch { /* classified below as failed output */ }
  const STATUS_LINE = wait.stdout;
  let STATUS = typeof terminal.status === "string" ? terminal.status : "";
  let DETAIL = typeof terminal.studio_commit === "string"
    ? terminal.studio_commit
    : typeof terminal.failure_reason === "string" ? terminal.failure_reason : "";
  const WAIT_RC = wait.code !== 0 ? wait.code : STATUS === "success" ? 0 : STATUS === "timeout" ? 124 : 1;

  // ── 3. non-success: clean up NOTHING, report ──────────────────────────────
  if (WAIT_RC !== 0) {
    ({ status: STATUS, detail: DETAIL } = classifyMergeLandWaitFailure(WAIT_RC, STATUS_LINE, STATUS, DETAIL));
    out(`{"request_id":"${jesc(REQ_ID)}","status":"${jesc(STATUS || "failed")}","failure_reason":"${jesc(DETAIL)}","cleaned_up":false${BASE_BEHIND_JSON}}`);
    err(`NEXT_COMMAND: bun ${JSON.stringify(dockMergeTs)} await --pm-id ${JSON.stringify(PM)} --project ${JSON.stringify(PROJECT)} --request-id ${JSON.stringify(REQ_ID)}${MAX_WAIT ? ` --ceiling-ms ${Number(MAX_WAIT) * 1000}` : ""}`);
    cleanupTmp(tmpDir);
    return WAIT_RC;
  }

  // W-121: defend against a false-success. The waiter maps every non-"success"
  // terminal result (aborted / failed / conflict) to a non-zero exit, but a zero
  // exit paired with a non-success status line (a torn result read, or a future
  // waiter variant) must NOT be mistaken for a landed merge: cleaning up the
  // dispatch and striking the backlog row on an aborted gate is exactly the
  // run_in_background false-success this row was filed for. Report and exit
  // non-zero, cleaning up nothing.
  if (STATUS && STATUS !== "success") {
    if (!DETAIL) DETAIL = firstMatch(STATUS_LINE, /^MERGE_TIMEOUT: (.*)$/m);
    err(`merge_land: gate result status is '${STATUS}', not 'success' (waiter exit ${WAIT_RC}) — NOT cleaning up or closing rows.`);
    out(`{"request_id":"${jesc(REQ_ID)}","status":"${jesc(STATUS)}","failure_reason":"${jesc(DETAIL)}","cleaned_up":false${BASE_BEHIND_JSON}}`);
    cleanupTmp(tmpDir);
    return 1;
  }

  // ── wait for OUR lock to clear before cleanup + row close ──────────────────
  const LOCK_ACTIVE = `${PROJECT}/__garelier/${PM}/runtime/merge_gate/locks/active.lock`;
  for (let w = 0; w < 50; w++) {
    if (!existsSync(LOCK_ACTIVE)) break;
    let text = ""; try { text = readFileSync(LOCK_ACTIVE, "utf8"); } catch { text = ""; }
    if (!text.includes(REQ_ID)) break;
    Bun.sleepSync(100);
  }

  let STUDIO_COMMIT = DETAIL;

  if (CONTROL_SCHEMA === 3) {
    const requestArchive = `${PROJECT}/__garelier/${PM}/runtime/merge_gate/archive/${REQ_ID}.request.json`;
    const requestPending = `${PROJECT}/__garelier/${PM}/runtime/merge_gate/requests/${REQ_ID}.json`;
    const requestPath = existsSync(requestArchive) ? requestArchive : requestPending;
    try {
      const result = JSON.parse(readFileSync(RESULT_FILE, "utf8")) as Record<string, unknown>;
      const studioCommit = typeof result.studio_commit === "string" ? result.studio_commit : STUDIO_COMMIT;
      if (/^[0-9a-f]{40,64}$/.test(studioCommit)) STUDIO_COMMIT = studioCommit;
      const finalized = finalizeLongMergeEvidence({
        roots: controlRoots,
        workId: WORK_ID,
        sessionId: CONTROL_SESSION,
        requestPath,
        resultPath: RESULT_FILE,
        reportPath: ROLE_REPORT,
        studioCommit,
      });
      err(`merge_land: independent-evidence finalization ${finalized.status} for ${WORK_ID} at ${studioCommit}`);
    } catch (error) {
      err(`merge_land: independent-evidence finalization refused; cleanup skipped: ${(error as Error).message}`);
      out(`{"request_id":"${jesc(REQ_ID)}","status":"failed","failure_reason":"${jesc((error as Error).message)}","cleaned_up":false${BASE_BEHIND_JSON}}`);
      cleanupTmp(tmpDir);
      return 4;
    }
  }

  // ── 4. success: clean up the dispatch + pull ──────────────────────────────
  let CLEANUP_STATUS = "skipped", BRANCH_DELETED = "false";
  const clean = runSync(successfulLandCleanupArgs(ENTRY_DIR, PROJECT, PM, REQ_ID, DISPATCH_ID, TARGET_ROOT), { timeoutMs: SUCCESSFUL_LAND_CLEANUP_TIMEOUT_MS });
  if (clean.stdout) err(clean.stdout);
  if (clean.stderr) err(clean.stderr);
  if (clean.code === 0) {
    CLEANUP_STATUS = firstMatch(clean.stdout, /"cleanup_status":"([^"]*)"/) || "success";
    BRANCH_DELETED = firstMatch(clean.stdout, /"branch_deleted":(true|false)/) || "false";
  } else {
    // W-235 (target-project dispatch): a non-zero exit prints no JSON on stdout (dispatch_cleanup's
    // fail() writes only to stderr), so the old code fell through to the initial
    // "skipped" placeholder — indistinguishable from a genuine no-op and hiding the
    // real refusal reason (e.g. "dispatch Backlog is closed"). Surface both.
    const reason = (clean.stderr.split(/\r?\n/).find((line) => line.trim()) || `dispatch_cleanup exited ${clean.code}`).trim();
    CLEANUP_STATUS = `failed(rc=${clean.code}): ${reason}`;
    err(`merge_land: dispatch_cleanup failed (rc=${clean.code}); cleanup_status recorded as failure, not skipped: ${reason}`);
    out(`{"request_id":"${jesc(REQ_ID)}","status":"cleanup_failed","studio_commit":"${jesc(STUDIO_COMMIT)}","dispatch_id":"${jesc(DISPATCH_ID || "")}","branch_deleted":false,"cleanup_status":"${jesc(CLEANUP_STATUS)}","pulled":"skipped"${BASE_BEHIND_JSON}}`);
    err(`NEXT_COMMAND: ${successfulLandCleanupArgs(ENTRY_DIR, PROJECT, PM, REQ_ID, DISPATCH_ID, TARGET_ROOT).map((part) => JSON.stringify(part)).join(" ")}`);
    cleanupTmp(tmpDir);
    return clean.code || 1;
  }

  // pull (best-effort, non-fatal).
  let PULLED = "skipped";
  if (NO_PULL !== 1) {
    const pull = runSync(["git", "-C", GIT_ROOT, "pull", "--ff-only"]);
    if (pull.code === 0) PULLED = "true";
    else { PULLED = "false"; err(`merge_land: git pull --ff-only skipped/failed: ${(pull.stderr.split("\n")[0] || "")}`); }
  }

  // ── 5. row close (W-093) ──────────────────────────────────────────────────
  let ROW_CLOSE_FIELD = "";
  if (CLOSE_ROWS.length > 0) {
    ROW_CLOSE_FIELD = `,"row_close":"typed-control"`;
    err(`merge_land: schema-v${CONTROL_SCHEMA} Work/Backlog ${WORK_ID} was updated through the transactional merge evidence path; no dashboard row was read, written, or deleted.`);
  }

  out(`{"request_id":"${jesc(REQ_ID)}","status":"success","studio_commit":"${jesc(STUDIO_COMMIT)}","dispatch_id":"${jesc(DISPATCH_ID || "")}","branch_deleted":${BRANCH_DELETED || "false"},"cleanup_status":"${jesc(CLEANUP_STATUS || "skipped")}","pulled":"${PULLED}"${ROW_CLOSE_FIELD}${BASE_BEHIND_JSON}}`);
  cleanupTmp(tmpDir);
  return 0;
}

function cleanupTmp(dir: string): void { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

// Guard the CLI entry so exported helpers remain importable by unit tests
// without executing the full merge ritual.
if (import.meta.main) process.exit(main());
