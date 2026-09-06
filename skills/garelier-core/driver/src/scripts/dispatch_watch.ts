#!/usr/bin/env bun
import { rmSync } from "../guard/path_guard.ts";

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { crewSubdir } from "../workspace.ts";
import { compileProcessCount, containerSpawnEpoch, withinSpawnGrace, git } from "./_lib.ts";
import { scanTranscriptForMalformed, MALFORMED_SUBAGENT_NUDGE } from "./malformed_detect.ts";
import { resolveHeavyTierBudget, declaredHeavyTier, heavyTierBudget } from "../dispatch/engine_aware.ts";
import { listLongJobs, longJobRoot, type LongJobRecord } from "../long_jobs.ts";
import {
  DISPATCH_CONTAINER_LIFECYCLE,
  type DispatchContainerLifecycle,
} from "../dispatch/container_lifecycle.ts";
import {
  parseDispatchResultState,
  parseLegacyDispatchState,
  readDispatchSessionResult,
} from "../dispatch/lane_status.ts";

const HELP = `#
# dispatch_watch.ts — reactive stall backstop for a heavy role dispatch
# (DEC-091, defense-in-depth behind the preventive measures). A sub-agent is
# run-to-completion: a build it detaches does NOT re-invoke it, so a role that
# detaches a long compile and goes idle STALLS silently. The preventive fix is a
# warm cache + crate-scoped foreground gate (DEC-091); this is the backstop for
# when a role stalls anyway.
#
# Two modes, ONE home (W-071 — no third watchdog implementation):
#   single  (default) — watch ONE role (--id or --branch); detailed RUNAWAY
#                       compensation (hard ceiling + output-bloat).
#   --fleet           — watch EVERY live dispatch under a pm-id in one process
#                       (WORKING / REWORK, plus ungated REPORTING — the W-086
#                       blind spot). Loud, durable dormancy sweep + drain.
#
# The OPERATOR (main session — stall-immune) runs this in the background right
# after dispatching a heavy role (single mode) or once per pm-id to watch the
# whole fleet (--fleet). It polls git-observable progress and the host's compile
# activity, then EXITS (re-invoking the operator) with a clear RESULT line. The
# verdict vocabulary is the SINGLE anomaly taxonomy defined in
# role_subagent_dispatch.md §6 (PROGRESS / ADVANCING / BUILDING / STALLED /
# RUNAWAY / REVIVE-NEEDED / IDLE-NO-REGISTER) — dispatch_watch and contract_check
# --stall-scan speak the same terms:
#   PROGRESS      — a NEW commit landed on the branch since the watch started (the
#                   role is finishing; check for REPORTING)
#   ADVANCING     — no new commit and no live compile at the timeout, but STATE.md/
#                   report.md advanced during the window (uncommitted forward
#                   progress — NOT a detach-and-idle stall; re-run the watch)
#   BUILDING      — still compiling at timeout (re-run the watch for another window)
#   STALLED       — no new commit, no STATE/report change, no live compile after the
#                   timeout (warm-resume or re-dispatch the role; cache is warm)
#   RUNAWAY       — a runaway safety trip (W-077). Because budget-read + message-wake
#                   lets a job outlive the bash-timeout ceiling that normally caps a
#                   runaway, the operator compensates with cheap runaway checks here
#                   (W-075: for a commit_mode=proxy seat — a Codex-dispatched role that
#                   structurally cannot commit, the Dock proxy-commits later — the
#                   hard ceiling below only fires when NEITHER the worktree nor the
#                   STATE/report signal moved either; it never fires on commit
#                   absence alone, and its message says so explicitly):
#                   (a) HARD CEILING — BUILDING for --max-building-windows consecutive
#                       windows (default 3; a healthy cold build should have committed
#                       by then) — do NOT wait forever on infinite BUILDING. SIZE THIS
#                       TO THE JOB via --heavy-tier <check|codegen> (W-348): the bare
#                       defaults are check-tier (20m x 3 = a 60m ceiling, right for a
#                       ~7m cargo check), and a full codegen run takes HOURS, so
#                       without the flag it is declared RUNAWAY and killed while it is
#                       compiling healthily. codegen = 60m x 4 (a 240m ceiling). An
#                       explicit --timeout-min / --max-building-windows still wins; and
#                   (b) OUTPUT BLOAT — an opt-in --output-file grew past --max-output-mb
#                       with no STATE/report progress (a job writing without advancing;
#                       the log-fills-the-SSD precedent). On RUNAWAY the operator kills
#                       the role's process group, marks the job FAILED, and checks
#                       for orphaned build procs (compile_procs in the poll lines)
#                       before re-dispatch — never masks it as success.
#   REVIVE-NEEDED — (--fleet) sustained dormancy: no git-observable progress (HEAD +
#                   STATE/report hash unchanged) for >= the stall threshold AND no
#                   build/verify process anywhere. A STALLED that stayed flat is a
#                   DORMANT role — respawn it FRESH from its worktree (a /resume
#                   does NOT restore an in-process teammate — official). Distinct from
#                   STALLED (one flat window) so a truly dead role is not merely
#                   nudged forever. W-362: the stall threshold is PER DISPATCH, read
#                   from each container's context.json task.heavy_tier — a declared
#                   codegen dispatch gets that tier's 90m (a multi-hour gate chain
#                   goes compile-quiet for longer than the 30m fleet default, and
#                   fleet only probes build procs once dormant). Undeclared and
#                   check-tier dispatches keep 30m, so fleet-wide detection does not
#                   slow down; an explicit --stall-min/--stall-sec overrides all.
#   IDLE-NO-REGISTER — (single mode, needs --id) the watched role reached REPORTING
#                   but the PM never processed its completion register (no
#                   register_received marker). It is DONE-but-unregistered — a WAKE, not
#                   a respawn: wake it to send the final register (a gate role: its
#                   verdict register), or process the register and touch the marker. It
#                   overrides the window verdict so a finished role is not read as a
#                   PROGRESS/STALLED to re-arm on. The detective twin is contract_check
#                   --stall-scan's idle_no_register (W-018, same marker convention).
#   IDLE-DONE     — (single mode, needs --id, W-078c) a harness-gap variant of the same
#                   silence: the role's own background job (e.g. a heavy gate run
#                   with run_in_background) finished, but the role was never
#                   re-woken to read it, so it never reaches REPORTING at all — STATE.md
#                   stays WORKING (or REPORTING with the register still unprocessed) while
#                   NOTHING moves for two consecutive polls: no compile process, no new
#                   commit, no STATE/report hash change, no worktree dirty-file/mtime
#                   change (the W-075 signal, reused UNGATED here — IDLE-DONE is not
#                   proxy-only). Two consecutive flat polls (not one — a single flat poll
#                   is normal cadence) is the trigger. Unlike every other verdict,
#                   IDLE-DONE EXITS THE WATCH IMMEDIATELY on its second matching poll —
#                   it does not wait out the rest of the window or the remaining
#                   --windows — because the fix is a prompt re-invocation of the operator,
#                   not more waiting. Never fires while a compile process is running (that
#                   is ordinary BUILDING) or once register_received exists (already
#                   processed). Field #334/#336/#338 (2026-07-15/16).
#                   W-090 CONTRACT CHANGE (field #340, 2026-07-16 — an INTENTIONAL spec
#                   change to the IDLE-DONE trigger, not a parity port): the two-static-poll
#                   trigger false-fired in a codex proxy seat's think/read phase between two
#                   compiles (compile_procs momentarily 0 + checkout momentarily static),
#                   killing a live role. Two guards close it: (a) compile_procs is
#                   RE-SAMPLED at the firing poll — a compile that (re)started within the
#                   poll suppresses the fire (think→compile boundary); and (c) for proxy
#                   seats ONLY, the static-poll fingerprint now also folds in report.md
#                   mtime and a COMMIT PLAN in report.md
#                   (proxyActivityRaw) — a live think phase that touches any of these
#                   RE-ARMS the counter (and reads ADVANCING at window end) instead of
#                   tripping IDLE-DONE. Self-commit seats are unchanged.
#   MALFORMED-CALL — (single mode, W-097) the watched role's LATEST assistant
#                   turn is a malformed tool call: the API reports stop_reason=tool_use
#                   yet the message carries 0 tool_use blocks (the Opus 4.8 2026-05-29+
#                   regression). The turn JAMMED — it is neither idle-done, building,
#                   nor a live think phase (a think phase advances report.md and carries
#                   NO malformed signature, so W-090 and this never cross). Needs a
#                   transcript to see: pass --transcript <jsonl> (or drop a
#                   transcript.jsonl in the dispatch container). Judged on the LATEST
#                   assistant turn only, so a malformed turn already followed by a good
#                   tool call (recovered) does NOT fire. Fires IMMEDIATELY (like
#                   IDLE-DONE) — waiting cannot un-jam a broken call; the fix is a
#                   prose-free, call-only resend, so the RESULT carries the verbatim
#                   SendMessage nudge. Recurs -> downgrade the seat to Opus 4.7 / lower
#                   reasoning effort. A missing/clean transcript is a silent no-op
#                   (fail-open — never a false MALFORMED).
#   BG-COMPLETION-UNACKED — (single mode, needs --id, W-363) the dispatch's own
#                   long-job LEDGER (armed via long_jobs.ts) records a job FINISHED
#                   for this dispatch_id that has sat un-drained/un-ACKed past a
#                   grace period, while the dispatch itself is still WORKING. This
#                   is a DIRECT ledger fact, not an inferred git/file fingerprint
#                   (unlike IDLE-DONE) — a background completion notification was
#                   lost (measured: 7+ times in one 24h session; every one needed a
#                   manual PM wake). Fires IMMEDIATELY (ledger evidence needs no
#                   confirmation window): wake the seat to read the ledger result/
#                   log and ACK it, do NOT respawn — the work almost certainly
#                   finished cleanly, only the wake was lost. A dispatch with no
#                   armed long jobs (the common case) never reads this ledger, so
#                   it is a no-op for every seat that never used the long-job path.
#
# Progress is judged by GIT-OBSERVABLE forward movement only — a new commit
# beyond the branch tip captured at the FIRST observation (baseline), or a change
# in the content hash of the dispatch's STATE.md/report.md (fleet mode combines the
# two into a per-dispatch fingerprint: HEAD sha | hash(STATE.md + report.md)). It
# is NEVER reset by a bare liveness ping or a file mtime: a ping does not prove
# progress and letting it reset the clock would defeat the watchdog (a role
# that only pings while dormant would never trip). The window is fixed; the signals
# classify only the terminal verdict.
#
# W-075 SINGLE-MODE EXCEPTION (proxy seats only): a commit_mode=proxy role
# (codex — its sandbox re-pins the gitdir read-only, DEC-context W-042) never
# advances \`commits\`, so it needs a non-commit progress signal the way fleet mode
# already has one (STATE/report hash). Single mode adds the worktree's dirty-file
# count / newest mtime under checkout (wt_progress_sig) as an ADDITIONAL signal,
# gated to commit_mode=proxy only — it is real forward motion (a diff on disk), not
# a bare liveness ping, and is a no-op for self-commit roles. The anti-ping
# principle above is unchanged for everyone else.
#
# WINDOWS (single mode, --windows N, default 3, W-094). One invocation runs up to N
# watch windows back-to-back so the OPERATOR (who re-invokes on every exit) is woken
# once per RUN, not once per window — cutting the re-arm notification storm (~8/day
# → 1/3 of that). The two "still clearly working" verdicts, PROGRESS (a commit
# landed) and BUILDING (still compiling), re-arm INTERNALLY to the next window,
# leaving a one-line \`window i/N … re-arming\` record but NO \`RESULT:\` line; every
# other verdict (ADVANCING / STALLED / RUNAWAY) is terminal and surfaces at once,
# as does the last window's verdict once N is consumed. Exactly ONE \`RESULT:\` line
# is printed per invocation — the final verdict — so the operator still reads a
# single RESULT line. Each internal window re-baselines like a fresh invocation, so
# --windows N is N back-to-back single windows minus the operator round-trip; the
# BUILDING hard-ceiling counter is file-persisted and accrues across them (N
# consecutive BUILDING windows trip RUNAWAY just as across invocations). The W-085
# heartbeat is refreshed the whole time. --windows 1 reproduces the pre-W-094
#
# SPAWN/RESUME GRACE (W-143, single mode). A role's first minutes (premise-read,
# think phase) look identical to a stall, so IDLE-DONE is SUPPRESSED while the
# dispatch is inside --spawn-grace-sec (default 600) of its container dispatched_at /
# resumed_at marker, OR while its --transcript file was written within that window.
# A marker-less container (legacy / test) has NO grace = byte-identical to before.
# --mark-resumed <needs --id> stamps resumed_at (run it right after a /resume so the
# next watch does not read the resume's read phase as a stall) and exits.`;

const DEFAULT_PROC_REGEX = "cargo(\\.exe)?|rustc(\\.exe)?|cc1(\\.exe)?|cc1plus(\\.exe)?|gcc(\\.exe)?|g\\+\\+(\\.exe)?|clang(\\.exe)?|clang\\+\\+(\\.exe)?|tsc(\\.exe)?|esbuild(\\.exe)?|webpack(\\.exe)?|javac(\\.exe)?|kotlinc(\\.exe)?|gradle(\\.exe)?|go(\\.exe)?|ninja(\\.exe)?|make(\\.exe)?|bazel(\\.exe)?|msbuild(\\.exe)?|swiftc(\\.exe)?|link\\.exe";

function out(line: string): void { process.stdout.write(`${line}\n`); }
function err(line: string): void { process.stderr.write(`${line}\n`); }
function fail(message: string, code = 2): never { err(message); process.exit(code); }
function valueAfter(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value === "") fail(`dispatch_watch: missing value for ${argv[index]}`);
  return value;
}
function positiveInteger(value: string, flag: string, min = 1): number {
  if (!/^\d+$/.test(value)) fail(`dispatch_watch: ${flag} must be a positive integer`);
  const n = Number(value);
  if (n < min) fail(`dispatch_watch: ${flag} must be >= ${min}`);
  return n;
}
function nowSeconds(): number { return Math.floor(Date.now() / 1000); }
function text(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }
function hashText(value: string): string { return createHash("sha1").update(value).digest("hex"); }
function gitOut(root: string, args: string[]): string {
  const r = git(root, args); return r.exitCode === 0 ? r.stdout.trim() : "";
}

interface Options {
  fleet: boolean; project: string; targetRoot: string; pm: string; id: string; branch: string;
  windows: number; timeoutMin: number; timeoutSec?: number; intervalSec: number; procRegex: string;
  maxBuilding: number; outputFile: string; maxOutputMb: number; stallMin: number; stallSec?: number;
  maxRunMin: number; maxRunSec?: number; transcript: string; spawnGraceSec: number; markResumed: boolean;
  // W-362: true when the operator stated a stall threshold on the CLI. An explicit
  // number always wins over a per-dispatch tier default (same precedence the single
  // watch already gives --timeout-min / --max-building-windows).
  stallExplicit?: boolean;
}

// W-097: malformed tool-call detector. The watched role's transcript (a JSONL
// path passed via --transcript, or auto-discovered in the container) is tail-scanned
// each poll; a malformed LATEST assistant turn (stop_reason=tool_use + 0 tool_use
// blocks — the Opus 4.8 regression) means the turn JAMMED, distinct from a live
// think phase (W-090, which advances report.md and carries NO malformed signature)
// and from an idle/building role. Returns the finding's detail or "" when the
// transcript is absent/clean. Reading the whole file is fine — the scanner tails it
// internally; a missing file is a silent no-op (fail-open, never a false MALFORMED).
function scanRoleTranscript(path: string): { detected: boolean; detail: string; softSignal: boolean } {
  if (!path || !existsSync(path)) return { detected: false, detail: "", softSignal: false };
  const finding = scanTranscriptForMalformed(text(path));
  return { detected: finding.detected, detail: finding.detail, softSignal: finding.softSignal };
}

function compileProcs(pattern: string): number {
  return compileProcessCount(pattern);
}

function writeHeartbeat(dir: string, name: string, body: object): void {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(resolve(dir, name), `${JSON.stringify(body)}\n`); } catch { /* fail-open */ }
}

function stateField(path: string, heading: string): string {
  const lines = text(path).split(/\r?\n/);
  const re = new RegExp(`^##\\s+${heading}\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return lines[j].trim();
  }
  return "";
}

function fleetSlug(container: string): string {
  const task = stateField(resolve(container, "STATE.md"), "Current task");
  const fromState = task.split(/\s+/)[1] ?? "";
  if (fromState) return fromState;
  try { return String(JSON.parse(text(resolve(container, "context.json")))?.task?.slug ?? ""); } catch { return ""; }
}

function dispatchDirs(root: string, prefix: string): Array<{ id: string; container: string }> {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && existsSync(resolve(root, entry.name, "STATE.md")))
      .map((entry) => ({ id: entry.name.replace(/\D/g, ""), container: resolve(root, entry.name) }))
      .filter((entry) => entry.id);
  } catch { return []; }
}

// W-362 (Guardian N2 + axis 4): the fleet's dormancy comparison, extracted so the
// dormancy branch and the max-run summary cannot drift apart again. They previously
// held two different thresholds — one per-dispatch, one fleet-wide — and disagreed
// inside a single output line. One comparison, two callers, both tested.
export function isDormantFor(dormancyMs: number, stallMs: number): boolean {
  return dormancyMs >= stallMs;
}

export type FleetVerdict = "PROGRESS" | "ADVANCING" | "BUILDING" | "REVIVE-NEEDED" | "STALLED";

// The per-dispatch verdict the max-run summary prints. Pure so the loop's rule
// application is testable without driving the unbounded polling loop.
//
// It takes `dormant` as an already-decided BOOLEAN rather than a threshold to
// compare. That is deliberate and is the structural fix for Guardian N2: the
// summary used to re-derive dormancy from its own threshold, picked up the
// fleet-wide value instead of the per-dispatch one, and printed REVIVE-NEEDED
// inside a line that simultaneously reported nothing had crossed. With the
// comparison living in exactly ONE place per poll (the `dormant` filter, whose
// result is passed in here), a second threshold cannot be introduced by accident
// — there is no longer anywhere to put one.
export function fleetVerdictFor(a: {
  dormancyMs: number;
  intervalMs: number;
  lastKind: string | undefined;
  buildProcs: number;
  dormant: boolean;
}): FleetVerdict {
  if (a.dormancyMs < a.intervalMs && a.lastKind === "PROGRESS") return "PROGRESS";
  if (a.dormancyMs < a.intervalMs && a.lastKind === "ADVANCING") return "ADVANCING";
  if (a.buildProcs > 0) return "BUILDING";
  if (a.dormant) return "REVIVE-NEEDED";
  return "STALLED";
}

// The per-dispatch stall threshold: a DECLARED tier's own budget, else the fleet
// default. Absence must not widen anything (AC3) — which only holds because
// context_pack now carries absence as null instead of folding it to codegen.
export function dispatchStallMs(contextJson: string, fleetStallMs: number, explicit: boolean): number {
  if (explicit) return fleetStallMs;
  const tier = declaredHeavyTier(contextJson);
  return tier ? heavyTierBudget(tier).staleMinutes * 60_000 : fleetStallMs;
}

// W-363: a FINISHED long job this dispatch armed but never drained/ACKed is a
// DIRECT ledger fact (long_jobs.ts), not an inferred git/file-hash fingerprint —
// stronger evidence than IDLE-DONE needs, so it does not wait for a static-poll
// count. Pure/testable: the caller supplies already-loaded records (typically
// filtered to this dispatch_id) and the current time; a grace period (default 2m)
// keeps a job that JUST finished from firing before the seat has had any chance
// to notice. Returns the OLDEST unacknowledged completion past grace, or null.
export interface BgCompletionGap { jobId: string; ageMs: number }
export interface BgCompletionRecord { job_id: string; state: LongJobRecord["state"]; timestamps: { finished_at?: string } }
export function bgCompletionGap(
  records: ReadonlyArray<BgCompletionRecord>,
  nowMs: number,
  graceMs = 120_000,
): BgCompletionGap | null {
  let oldest: BgCompletionGap | null = null;
  for (const r of records) {
    if (r.state !== "FINISHED") continue;
    const finishedAt = Date.parse(r.timestamps.finished_at ?? "");
    if (!Number.isFinite(finishedAt)) continue;
    const ageMs = nowMs - finishedAt;
    if (ageMs < graceMs) continue;
    if (!oldest || ageMs > oldest.ageMs) oldest = { jobId: r.job_id, ageMs };
  }
  return oldest;
}

export interface GateTerminalGap {
  runId: string;
  reason: "gate_end_without_result";
}

/** Inspect only the latest run slice. A historical incomplete run must not
 * shadow a later terminal result, while a current GATE_END without RESULT is
 * immediately actionable instead of waiting for the generic stall window. */
export function gateTerminalGap(log: string): GateTerminalGap | null {
  const starts = [...log.matchAll(/^GATE_START\s+run_id=(\S+).*$/gm)];
  const latest = starts.at(-1);
  if (!latest || latest.index === undefined) return null;
  const runId = latest[1]!;
  const slice = log.slice(latest.index);
  if (!new RegExp(`^GATE_END\\s+run_id=${runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(slice)) return null;
  if (/^RESULT\s+(?:GREEN|RED|REFUSED)\b/m.test(slice)) return null;
  return { runId, reason: "gate_end_without_result" };
}

function containerGateTerminalGap(container: string): GateTerminalGap | null {
  return gateTerminalGap(text(resolve(container, "ci_evidence", "gate_runner.log")));
}

// Best-effort ledger read for one dispatch: absent ledger root / unreadable
// records / corrupt entries all degrade to "nothing pending" (fail-open — a
// probe over another agent's or a stale worktree's ledger must never crash the
// watch or false-fire on a read error).
function pendingBgCompletionsFor(project: string, pm: string, dispatchId: string): LongJobRecord[] {
  if (!dispatchId) return [];
  try {
    return listLongJobs(longJobRoot(project, pm)).filter((r) => r.dispatch_id === dispatchId);
  } catch { return []; }
}

async function runFleet(
  opts: Options,
  pmRoot: string,
  dispatchRoot: string,
  dispatchPrefix: string,
  heartbeatDir: string,
  lifecycle: DispatchContainerLifecycle,
): Promise<number> {
  const stallSec = opts.stallSec ?? opts.stallMin * 60;
  const maxRunSec = opts.maxRunSec ?? opts.maxRunMin * 60;
  // Fleet decisions used whole-second wall-clock values. A poll that straddled a
  // clock boundary could report 0s or 2s for an almost-identical 1s interval,
  // making the fast smoke's stall/max-run ordering intermittent under load.
  // Keep persisted heartbeats in epoch seconds, but use monotonic-resolution
  // elapsed milliseconds for this invocation's temporal decisions (W-110).
  const start = Date.now();
  const stallMs = stallSec * 1000;
  const maxRunMs = maxRunSec * 1000;
  let cycle = 0;
  const lastFp = new Map<string, string>();
  const lastHead = new Map<string, string>();
  const lastProg = new Map<string, number>();
  const lastKind = new Map<string, string>();
  out(`dispatch_watch[fleet]: pm=${opts.pm} stall=${stallSec}s interval=${opts.intervalSec}s max_run=${maxRunSec}s (targets: WORKING/REWORK + ungated REPORTING)`);
  for (;;) {
    const now = Date.now(); cycle++;
    const active: Array<{ id: string; label: string; stallMs: number }> = [];
    for (const { id, container } of dispatchDirs(dispatchRoot, dispatchPrefix)) {
      if (lifecycle.consumeAbort(container)) {
        out(`dispatch_watch[fleet]: dispatch #${id} consumed abort.md and transitioned to ABORTED`);
        continue;
      }
      // The lane's own declaration outranks STATE.md, which is dispatch-setup
      // intent and stays WORKING after a provider emits its terminal register. A
      // lane that declared BLOCKED is waiting on the PM and a lane that declared
      // REPORTING is finished; neither is dormant work to respawn, and calling
      // either REVIVE-NEEDED would respawn a lane that already did its job.
      const declared = laneDeclaredCompletion(container);
      if (declared === "BLOCKED" || declared === "ABORTED") continue;
      const status = declared === "REPORTING"
        ? "REPORTING"
        : stateField(resolve(container, "STATE.md"), "Status").replace(/\s/g, "");
      let label = "";
      if (status === "WORKING" || status === "REWORK") label = status;
      else if (status === "REPORTING") {
        const slug = fleetSlug(container);
        if (slug && (existsSync(`${pmRoot}/runtime/guardian/results/${slug}-guardian.md`) || existsSync(`${pmRoot}/runtime/observer/results/${slug}-observer.md`))) continue;
        label = "REPORTING(ungated)";
      } else continue;
      const gateGap = containerGateTerminalGap(container);
      if (gateGap) {
        out(`RESULT: GATE-RESULT-MISSING — dispatch #${id} gate run ${gateGap.runId} has GATE_END without RESULT; inspect ${resolve(container, "ci_evidence", "gate_runner.log")} and re-run through gate_runner (do not wait for the stall timeout)`);
        return 0;
      }
      // W-362 (G-N4): stall this dispatch against ITS OWN declared tier. The fleet
      // figure is 30m — the same number the codegen row raised to 90m for the lock,
      // on the same reasoning (`engine_aware.ts`: compile-quiet gaps across a
      // multi-hour gate chain exceed 30m). Fleet is narrower than it looks (it only
      // fires when buildProcs === 0, which protects an actively-compiling job), but
      // a codegen job that is between cargo invocations shows zero compile procs and
      // reads as dormant. Read per dispatch, not fleet-wide: an undeclared or
      // check-tier dispatch keeps the 30m default, so fleet-wide stall detection
      // does not slow down — the exact asymmetry the single-watch path documents.
      const perStallMs = dispatchStallMs(text(resolve(container, "context.json")), stallMs, opts.stallExplicit === true);
      active.push({ id, label, stallMs: perStallMs });
      const head = gitOut(resolve(container, "checkout"), ["rev-parse", "HEAD"]) || "none";
      const fileHash = hashText(text(resolve(container, "STATE.md")) + text(resolve(container, "report.md")));
      // The seat's write destination belongs in the progress denominator: without
      // the checkout's dirty state a role that edits for the whole dormancy window
      // without committing or touching the container reads as "no git-observable
      // progress" and is escalated to REVIVE-NEEDED. `git status --porcelain` only
      // (no tree walk) keeps the per-poll cost of the fleet sweep bounded.
      const fp = `${head}|${fileHash}|${worktreeDirtyRaw(container)}`;
      if ((lastFp.get(id) ?? "__new__") !== fp) {
        if (!lastFp.has(id)) lastKind.set(id, "SEEDED");
        else if (lastHead.get(id) !== head) lastKind.set(id, "PROGRESS");
        else lastKind.set(id, "ADVANCING");
        lastFp.set(id, fp); lastHead.set(id, head); lastProg.set(id, now);
      }
    }
    if (!active.length) { out(`RESULT: DRAIN — no active WORKING/REWORK/ungated-REPORTING dispatch under ${opts.pm} (nothing to watch)`); return 0; }
    // The ONE dormancy comparison per poll. Both the REVIVE-NEEDED branch and the
    // max-run summary consume this result rather than re-deriving it (W-362 N2).
    const dormant = active.filter(({ id, stallMs: ms }) => isDormantFor(now - (lastProg.get(id) ?? now), ms));
    const dormantIds = new Set(dormant.map((d) => d.id));
    const buildProcs = dormant.length ? compileProcs(opts.procRegex) : 0;
    const elapsedSec = Math.floor((now - start) / 1000);
    const vis = active.map(({ id, label }) => ` #${id}(${label},${Math.floor((now - (lastProg.get(id) ?? now)) / 1000)}s)`).join("");
    out(`poll ${cycle} (~${elapsedSec}s): active=${vis}${dormant.length ? ` dormant= ${dormant.map((x) => x.id).join(" ")} build_procs=${buildProcs}` : ""}`);
    writeHeartbeat(heartbeatDir, `fleet-${process.pid}.json`, { pid: process.pid, mode: "fleet", ts_epoch: nowSeconds(), active_ids: active.map((x) => x.id).join(" ") });
    if (dormant.length && buildProcs === 0) {
      for (const { id, label, stallMs: ms } of dormant) {
        const container = crewSubdir(opts.project, opts.pm, `dispatch${id}`);
        out(`RESULT: REVIVE-NEEDED — dispatch #${id} (${label}) had no git-observable progress (HEAD + STATE/report hash unchanged) for >= ${Math.round(ms / 1000)}s and no build/verify process is running: the role is DORMANT, not building. Respawn it FRESH from its worktree — a /resume does NOT restore an in-process teammate (official). Recovery: inspect ${container}/checkout (git status / git log --oneline) + STATE.md, then re-dispatch preserving that worktree (contract_check.ts --stall-scan --handoff ${id} emits the respawn-handoff prompt). Do NOT wake it.`);
      }
      out(`RESULT: REVIVE-NEEDED — ${dormant.length} dormant dispatch(es) need a fresh respawn (per-dispatch lines above)`);
      return 0;
    }
    if (now - start >= maxRunMs) {
      const buildNow = compileProcs(opts.procRegex);
      let summary = "";
      // W-362 (Guardian N2): compare against the SAME per-dispatch threshold the
      // dormancy branch above used, not the fleet-wide `stallMs`. Reading the fleet
      // value here made a codegen dispatch quiet for 35m print verdict=REVIVE-NEEDED
      // inside the very line that reports "no dispatch crossed the threshold" — two
      // thresholds in one function, contradicting each other in one output.
      for (const { id, label } of active) {
        const dorm = now - (lastProg.get(id) ?? now);
        const verdict = fleetVerdictFor({
          dormancyMs: dorm, intervalMs: opts.intervalSec * 1000,
          lastKind: lastKind.get(id), buildProcs: buildNow, dormant: dormantIds.has(id),
        });
        out(`  #${id} (${label}): dormancy=${Math.floor(dorm / 1000)}s verdict=${verdict}`);
        summary += ` #${id}=${verdict}`;
      }
      out(`RESULT: HEALTHY — watched ${elapsedSec}s, no dispatch crossed its own dormancy threshold (${stallSec}s by default; a declared heavy_tier raises it for that dispatch alone);${summary}; re-run the fleet watch to keep watching`);
      return 0;
    }
    await Bun.sleep(opts.intervalSec * 1000);
  }
}

function progressSig(container: string): string {
  return container ? hashText(text(resolve(container, "STATE.md")) + text(resolve(container, "report.md"))) : "";
}

function commitMode(container: string): "proxy" | "self" {
  if (!container || !existsSync(resolve(container, "context.json"))) return "self";
  const raw = text(resolve(container, "context.json"));
  const cm = raw.match(/"commit_mode"\s*:\s*"([^"]*)"/)?.[1];
  if (cm === "proxy" || cm === "self") return cm;
  const model = raw.match(/"model"\s*:\s*"([^"]*)"/)?.[1] ?? "";
  return model.includes("codex") ? "proxy" : "self";
}

function newestFileSeconds(root: string): number {
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== ".git") walk(path); continue; }
      try { newest = Math.max(newest, Math.floor(statSync(path).mtimeMs / 1000)); } catch { /* ignore */ }
    }
  };
  walk(root);
  return newest;
}

/** The seat's checkout dirty state, WITHOUT the recursive mtime walk — the cheap
 * half of worktreeProgressRaw, for the fleet sweep which evaluates every active
 * dispatch on every poll. */
function worktreeDirtyRaw(container: string): string {
  const checkout = container ? resolve(container, "checkout") : "";
  if (!checkout || !existsSync(checkout)) return "";
  return hashText(gitOut(checkout, ["status", "--porcelain"]));
}

function worktreeProgressRaw(container: string): string {
  const checkout = container ? resolve(container, "checkout") : "";
  if (!checkout || !existsSync(checkout)) return "";
  const dirty = gitOut(checkout, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean).length;
  return `${dirty}|${newestFileSeconds(checkout)}`;
}

// Millisecond mtime (0 if missing). The IDLE-DONE counter compares the proxy
// activity fingerprint across CONSECUTIVE polls, so whole-second granularity could
// alias two polls of a live think phase into one "static" pair and false-fire;
// milliseconds make any re-touch during the window distinct.
function fileMtimeMs(path: string): number {
  try { return Math.floor(statSync(path).mtimeMs); } catch { return 0; }
}

// W-090(c): proxy-seat (codex) think/read-phase activity signal. A Codex-dispatched role
// spends minutes between compiles READING and THINKING; during that phase its
// checkout worktree is momentarily static and compile_procs momentarily 0, but it
// is very much alive — it is streaming a COMMIT PLAN into report.md or
// re-touches report.md.
// None of those move progressSig (content hash of STATE.md+report.md alone) on an
// mtime-only touch, nor worktreeProgressRaw (which walks checkout/, not the
// container). Folding them in as a proxy-only activity fingerprint lets a live
// think phase RE-ARM the IDLE-DONE static-poll counter instead of tripping a false
// IDLE-DONE early-exit (field #340, W-082's residual hole). Proxy-only — a
// self-commit seat is judged by commits/sig/worktree exactly as before.
function proxyActivityRaw(container: string): string {
  if (!container) return "";
  const reportMtime = fileMtimeMs(resolve(container, "report.md"));
  const commitPlan = /COMMIT PLAN/.test(text(resolve(container, "report.md"))) ? 1 : 0;
  return `${reportMtime}|${commitPlan}`;
}

/**
 * The lane's OWN declaration of completion.
 *
 * Every stall verdict below asks "did anything move?". A lane that has already
 * declared it is done answers "no" truthfully and forever — its commits stop, its
 * tree stops, its report stops — so a progress-only detector reads completion as
 * stagnation and recommends waking or re-dispatching a lane that is finished.
 * Completion is not stagnation, so the declaration is consulted before any stall
 * verdict is returned.
 *
 * PROVIDER SYMMETRY. Two launch transports produce that declaration differently:
 * a CLI-transport seat (either provider) has `lane/result.md` written for it by
 * provider_session, while an Agent-tool-spawned seat never passes through that
 * path and its container carries only the STATE.md heading the role maintains by
 * hand. Reading just one of them would make this suppression real for one
 * transport and absent for the other. Both are accepted, with the SAME precedence
 * the canonical lane reader uses: the provider result decides whenever a result
 * source exists at all, and STATE.md is consulted only when there is none. That
 * ordering is what keeps the two symmetric rather than merely both-consulted — a
 * present-but-unparsable result must not be overridden by a stale STATE.md, or a
 * corrupt provider result would read as a completed lane and silence the stall
 * detector for exactly the seat most likely to need it.
 */
export function laneDeclaredCompletion(container: string): string | null {
  if (!container) return null;
  const laneRoot = resolve(container, "lane");
  const sessionSource = text(resolve(laneRoot, "session.json")) || null;
  const result = readDispatchSessionResult(laneRoot, sessionSource, (path) => text(path) || null);
  if (result.source !== null) return parseDispatchResultState(result.source);
  const legacy = parseLegacyDispatchState(text(resolve(container, "STATE.md")) || null);
  return legacy && ["REPORTING", "BLOCKED", "ABORTED", "DONE"].includes(legacy) ? legacy : null;
}

export type TerminalWindowVerdict = "ADVANCING" | "DECLARED-DONE" | "SPAWN-GRACE" | "STALLED";

/**
 * The end-of-window verdict when nothing is compiling. Pure so the rule is pinned
 * without driving the polling loop — same shape as `fleetVerdictFor`.
 *
 * ORDER MATTERS. Observed progress wins first (the seat did something). Then the
 * two shapes a healthy lane takes at the ends of its life, which a progress-only
 * detector cannot tell apart from a stall: a lane that already DECLARED it is
 * done, and a lane still inside its spawn/resume grace that has not had time to
 * produce anything. STALLED is what is left: past the grace, not declared done,
 * and nothing moved anywhere the seat writes.
 */
export function terminalWindowVerdict(a: {
  sigMoved: boolean;
  wtMoved: boolean;
  paMoved: boolean;
  isProxy: boolean;
  declaredCompletion: string | null;
  inSpawnGrace: boolean;
}): TerminalWindowVerdict {
  if (a.sigMoved || a.wtMoved || (a.isProxy && a.paMoved)) return "ADVANCING";
  if (a.declaredCompletion) return "DECLARED-DONE";
  if (a.inSpawnGrace) return "SPAWN-GRACE";
  return "STALLED";
}

interface WindowResult { verdict: string; message: string; }

async function runWindow(args: {
  opts: Options; win: number; studio: string; branch: string; container: string; isProxy: boolean;
  heartbeatDir: string; heartbeatFile: string; watchStateDir: string; buildingCounter: string;
  lifecycle: DispatchContainerLifecycle;
}): Promise<WindowResult> {
  const { opts, win, studio, branch, container, isProxy, heartbeatDir, heartbeatFile, watchStateDir, buildingCounter, lifecycle } = args;
  const commitCount = (): number => {
    const result = gitOut(opts.targetRoot, ["log", "--oneline", `${studio}..${branch}`]);
    return result ? result.split(/\r?\n/).filter(Boolean).length : 0;
  };
  const roleStatus = (): string => container ? stateField(resolve(container, "STATE.md"), "Status").replace(/\s/g, "") : "";
  const heartbeat = (): void => writeHeartbeat(heartbeatDir, heartbeatFile, { pid: process.pid, mode: "single", id: opts.id, branch, ts_epoch: nowSeconds() });
  const resetBuilding = (): void => { try { rmSync(buildingCounter, { force: true }); } catch { /* best effort */ } };
  const readBuilding = (): number => { const value = text(buildingCounter).trim(); return /^\d+$/.test(value) ? Number(value) : 0; };
  const bumpBuilding = (): number => {
    const n = readBuilding() + 1;
    try { mkdirSync(watchStateDir, { recursive: true }); writeFileSync(buildingCounter, `${n}\n`); } catch { /* fail open */ }
    return n;
  };
  const outputMb = (): number | undefined => {
    if (!opts.outputFile || !existsSync(opts.outputFile)) return undefined;
    try { return Math.floor(statSync(opts.outputFile).size / 1_048_576); } catch { return undefined; }
  };

  // W-097: the role's transcript to tail-scan for a malformed tool call.
  // Explicit --transcript wins; otherwise a conventional transcript.jsonl in the
  // dispatch container (absent by default — a no-op when not present).
  const transcriptPath = opts.transcript || (container ? resolve(container, "transcript.jsonl") : "");

  // W-143 spawn/resume grace. The dispatch's `dispatched_at`/`resumed_at` marker is
  // the anchor (read once — it does not move within a window); a role still in
  // its grace window is READING/THINKING, not stalled, so IDLE-DONE must not fire.
  // Part (b): a transcript that was WRITTEN TO within the grace window is live
  // tool/turn activity — it re-earns grace for a resume's read phase even past the
  // spawn anchor. Both are ABSENT-by-default (no marker / no transcript => no
  // grace), so this is byte-identical to pre-W-143 for a container without them.
  const spawnEpoch = containerSpawnEpoch(container);
  const inSpawnGrace = (): boolean => {
    const nowSec = nowSeconds();
    if (withinSpawnGrace(spawnEpoch, nowSec, opts.spawnGraceSec)) return true;
    if (opts.spawnGraceSec > 0 && transcriptPath && existsSync(transcriptPath)) {
      const mtimeSec = Math.floor(fileMtimeMs(transcriptPath) / 1000);
      if (mtimeSec > 0 && nowSec - mtimeSec < opts.spawnGraceSec) return true;
    }
    return false;
  };

  const baseCommits = commitCount();
  const baseSig = progressSig(container);
  // The seat's WRITE DESTINATION is its checkout worktree — not the container and
  // not the commit log. A role can edit for a whole window without touching
  // STATE.md/report.md and without committing, so a terminal verdict computed from
  // STATE/report content alone calls active editing a stall. This is tracked for
  // EVERY seat (it used to be proxy-only) so the worktree counts as progress in
  // the terminal decision below, exactly as it already does for IDLE-DONE.
  const baseWt = worktreeProgressRaw(container);
  const basePa = isProxy ? proxyActivityRaw(container) : "";
  const baseIdleFp = `${baseCommits}|${baseSig}|${baseWt}|${basePa}`;
  let sigMoved = false, wtMoved = false, paMoved = false, idleDoneArmed = false, idleDoneCount = 0, idleDonePrev = "";
  const proxyNote = isProxy ? " commit_mode=proxy (worktree/report signal, not commits)" : "";
  out(`dispatch_watch[window ${win}/${opts.windows}]: branch=${branch} studio=${studio} timeout=${opts.timeoutMin}m interval=${opts.intervalSec}s base_commits=${baseCommits}${proxyNote}`);
  heartbeat();
  const totalSec = opts.timeoutSec ?? opts.timeoutMin * 60;
  const iters = Math.max(1, Math.floor(totalSec / opts.intervalSec));
  for (let i = 1; i <= iters; i++) {
    await Bun.sleep(opts.intervalSec * 1000);
    heartbeat();
    if (container && lifecycle.consumeAbort(container)) {
      resetBuilding();
      return { verdict: "ABORTED", message: `ABORTED — dispatch #${opts.id} consumed abort.md and transitioned to STATE.md=ABORTED` };
    }
    const commits = commitCount();
    const sig = progressSig(container);
    const wt = worktreeProgressRaw(container);
    const pa = isProxy ? proxyActivityRaw(container) : "";
    const procs = compileProcs(opts.procRegex);
    if (sig && sig !== baseSig) sigMoved = true;
    if (wt && wt !== baseWt) wtMoved = true;
    if (pa && pa !== basePa) paMoved = true;
    const mb = outputMb();
    const malformed = scanRoleTranscript(transcriptPath);
    const graceNow = inSpawnGrace();
    out(`poll ${i} (~${i * opts.intervalSec}s): commits=${commits} (base ${baseCommits}) sig_moved=${sigMoved ? 1 : 0} compile_procs=${procs}${mb === undefined ? "" : ` output_mb=${mb}`} wt_moved=${wtMoved ? 1 : 0}${isProxy ? ` pa_moved=${paMoved ? 1 : 0}` : ""}${transcriptPath ? ` malformed=${malformed.detected ? 1 : 0}` : ""}${graceNow ? " grace=1" : ""}`);
    // W-097: a malformed LATEST assistant turn means the role's turn JAMMED —
    // it is neither idle-done, building, nor a live think phase (a think phase
    // advances report.md and carries NO malformed signature). Fire immediately
    // (like IDLE-DONE): more waiting cannot un-jam a broken tool call; the fix is a
    // prose-free call-only resend, which the operator triggers with the nudge below.
    if (malformed.detected) {
      resetBuilding();
      return {
        verdict: "MALFORMED-CALL",
        message:
          `MALFORMED-CALL — the watched role's ${malformed.detail}. The turn JAMMED (not idle-done, not building` +
          ` — compile_procs=${procs}), so waiting will not recover it. Do NOT respawn or kill. Recovery: SendMessage the` +
          ` role verbatim: "${MALFORMED_SUBAGENT_NUDGE}" If it recurs, downgrade the seat to Opus 4.7 or lower its` +
          ` reasoning effort (the immediate mitigation).`,
      };
    }
    // W-363: a FINISHED long job this dispatch armed but never drained/ACKed is a
    // DIRECT ledger fact — fires immediately (no 2-poll confirmation needed, unlike
    // IDLE-DONE's indirect git/file-hash inference). A dispatch that never armed a
    // long job never matches any record here (pendingBgCompletionsFor filters by
    // this dispatch's id), so this is a no-op for the common non-heavy case.
    if (container && opts.id) {
      const gap = bgCompletionGap(pendingBgCompletionsFor(opts.project, opts.pm, opts.id), Date.now());
      const state = roleStatus();
      if (gap && (state === "WORKING" || state === "REPORTING")) {
        resetBuilding();
        return {
          verdict: "BG-COMPLETION-UNACKED",
          message: `BG-COMPLETION-UNACKED — long job ${gap.jobId} (dispatch #${opts.id}) finished ${Math.round(gap.ageMs / 1000)}s ago per the long-job ledger but has not been drained/ACKed, and the dispatch is still ${state}: a completion wake was lost (W-363, measured 7+ times/24h). Wake the seat to read the job's result/log and ACK it — do NOT respawn, the work almost certainly finished cleanly, only the wake was lost.`,
        };
      }
    }
    if (!isProxy && commits > baseCommits) {
      resetBuilding();
      return { verdict: "PROGRESS", message: `PROGRESS — ${commits - baseCommits} new commit(s) on ${branch} since watch start; the role is finishing (check for REPORTING, then gate via jig_gate_held)` };
    }
    if (mb !== undefined && mb > opts.maxOutputMb && !sigMoved) {
      resetBuilding();
      return { verdict: "RUNAWAY", message: `RUNAWAY — ${opts.outputFile} grew past ${opts.maxOutputMb}MB (now ${mb}MB) with no STATE/report progress: a job writing without advancing (SSD-fill precedent). Kill the role's process group, mark the job FAILED, and check for orphaned build procs (compile_procs=${procs}) before re-dispatch — do NOT keep the watch running on it.` };
    }
    const idleFp = `${commits}|${sig}|${wt}|${pa}`;
    if (procs > 0 || idleFp !== baseIdleFp) idleDoneArmed = true;
    const registered = container && existsSync(resolve(container, "register_received"));
    const state = roleStatus();
    if (container && procs === 0 && !registered && idleDoneArmed && (state === "WORKING" || state === "REPORTING")) {
      if (idleFp === (idleDonePrev || "__unset__")) idleDoneCount++;
      else idleDoneCount = 1;
      idleDonePrev = idleFp;
      // W-090(a): re-sample compile_procs at the firing poll — a compile that
      // (re)started between this poll's process probe and here means the role
      // is BUILDING, not idle-done; suppress and let the counter re-earn it. Guards
      // the codex think→compile boundary where procs flips 0→>0 within one poll.
      // W-143: a role still inside its spawn/resume grace (or with live
      // transcript activity) is READING, not idle-done — suppress and let the
      // counter re-earn it once the grace elapses (the #351/#352 read-phase false
      // fire). resetBuilding is NOT called here so a subsequent real idle still fires.
      // A lane that DECLARED completion is not idle-done work waiting to be woken:
      // its flat fingerprint is the expected shape of a finished lane. The
      // unregistered case is answered by IDLE-NO-REGISTER in main() (gate/register
      // it), which is an aftercare action, not a stall verdict.
      if (idleDoneCount >= 2 && compileProcs(opts.procRegex) === 0 && !graceNow && !laneDeclaredCompletion(container)) {
        resetBuilding();
        return { verdict: "IDLE-DONE", message: `IDLE-DONE — role went silent after its background finished (procs=0, no progress 2 polls). Wake it: send the role a message to read its last background output, transcribe verbatim results, commit (if self mode), and register. Do NOT kill or re-dispatch — work is likely complete in the worktree. NOTE: if this role was dispatched/resumed less than ~${Math.round(opts.spawnGraceSec / 60)}m ago, an IDLE-DONE can be a false positive of the spawn read/think phase — confirm STATE.md/report.md really stopped moving before waking.` };
      }
    } else { idleDoneCount = 0; idleDonePrev = ""; }
  }

  const finalProcs = compileProcs(opts.procRegex);
  if (finalProcs > 0 && (!isProxy || (!sigMoved && !wtMoved && !paMoved))) {
    const count = bumpBuilding();
    if (count >= opts.maxBuilding) {
      resetBuilding();
      if (isProxy) return { verdict: "RUNAWAY", message: `RUNAWAY — proxy seat — do NOT judge by commits; verify worktree mtime + codex processes before killing. Still compiling after ${count} consecutive BUILDING window(s) (~${count * opts.timeoutMin}m, hard ceiling ${opts.maxBuilding}) with NO worktree dirty-file/mtime change and NO STATE/report change (commit_mode=proxy — commits are never the signal here, the Dock proxy-commits later): kill the role's process group, mark the job FAILED, and check for orphaned build procs (compile_procs=${finalProcs}) before re-dispatch.` };
      return { verdict: "RUNAWAY", message: `RUNAWAY — still compiling after ${count} consecutive BUILDING window(s) (~${count * opts.timeoutMin}m, hard ceiling ${opts.maxBuilding}). A healthy cold build should have committed by now — treat as runaway, not patience: kill the role's process group, mark the job FAILED, and check for orphaned build procs (compile_procs=${finalProcs}) before re-dispatch. Do NOT keep waiting on infinite BUILDING.` };
    }
    return { verdict: "BUILDING", message: `BUILDING — still compiling at timeout (window ${count}/${opts.maxBuilding}, no new commit yet); re-run the watch for another window (trips RUNAWAY at the hard ceiling)` };
  }
  resetBuilding();
  const declaredCompletion = laneDeclaredCompletion(container);
  const verdict = terminalWindowVerdict({ sigMoved, wtMoved, paMoved, isProxy, declaredCompletion, inSpawnGrace: inSpawnGrace() });
  if (verdict === "ADVANCING") {
    if (isProxy && !sigMoved) return { verdict: "ADVANCING", message: "ADVANCING — proxy seat (commit_mode=proxy; commits are NOT the progress signal here, the Dock proxy-commits later): worktree dirty-file count / file mtime OR report.md activity advanced during the window even though STATE.md/report.md content stayed flat (a live think/read phase, W-090). Re-run the watch for another window; if it goes flat next window with no compile and no worktree/report activity, treat as STALLED." };
    if (!sigMoved) return { verdict: "ADVANCING", message: "ADVANCING — no new commit, no live compile, and STATE.md/report.md stayed flat, but the seat's CHECKOUT WORKTREE advanced during the window (dirty-file count or file mtime moved): the role is editing, which is uncommitted forward progress and not a detach-and-idle stall. Re-run the watch for another window; if the worktree also goes flat with no compile, treat as STALLED." };
    return { verdict: "ADVANCING", message: "ADVANCING — no new commit and no live compile at timeout, but STATE.md/report.md advanced during the window (uncommitted forward progress, NOT a detach-and-idle stall). Re-run the watch for another window; if it goes flat next window with no compile, treat as STALLED." };
  }
  // Both branches below apply to the TERMINAL verdict, where IDLE-DONE's own
  // guards no longer run. Without them a healthy lane is called STALLED at the two
  // ends of its life: right after spawn/resume, where the read/think phase has
  // produced nothing yet, and right after it declared completion, where it has
  // correctly stopped producing. Both were measured as false STALLED verdicts on a
  // lane that was demonstrably fine, and the recommended action (warm-resume or
  // re-dispatch) would have interrupted it.
  if (verdict === "DECLARED-DONE") {
    return {
      verdict: "DECLARED-DONE",
      message: `DECLARED-DONE — the lane declared STATE=${declaredCompletion}; a finished lane stops committing and stops touching its tree, so a flat window is the EXPECTED shape and not a stall. Do NOT warm-resume or re-dispatch. Remaining aftercare (if any) is to gate the result and process its register — contract_check.ts --stall-scan reports that as ungated-reporting / idle_no_register with the wake text.`,
    };
  }
  if (verdict === "SPAWN-GRACE") {
    return {
      verdict: "SPAWN-GRACE",
      message: `SPAWN-GRACE — the window went flat but the dispatch is still inside its ${Math.round(opts.spawnGraceSec / 60)}m spawn/resume grace (or its transcript is still being written): the role is READING/THINKING and has not had time to produce a commit or a report edit. Not a stall — re-run the watch; STALLED can only be asserted once the grace has elapsed.`,
    };
  }
  return { verdict: "STALLED", message: `STALLED — no new commit, no STATE/report change, and no live compile after ${opts.timeoutMin}m. The role likely detached a build and went idle (DEC-091). Warm-resume it (cache is now warm) or re-dispatch; if uncommitted work survives in ${container || "the dispatch container"}/checkout, a resume preserves it. If it stays flat across re-arms with no build, --fleet escalates it to REVIVE-NEEDED (respawn).` };
}

export async function main(
  argv = process.argv.slice(2),
  lifecycle: DispatchContainerLifecycle = DISPATCH_CONTAINER_LIFECYCLE,
): Promise<number> {
  const opts: Options = {
    fleet: false, project: "", targetRoot: "", pm: "", id: "", branch: "", windows: 3,
    timeoutMin: 20, intervalSec: 90, procRegex: DEFAULT_PROC_REGEX, maxBuilding: 3,
    outputFile: "", maxOutputMb: 100, stallMin: 30, maxRunMin: 60, transcript: "",
    spawnGraceSec: 600, markResumed: false,
  };
  // W-348: the `opts` literal above carries CHECK-tier budgets (20m windows, a 3-
  // window ceiling) — right for a ~7m cargo check, but a full codegen run takes
  // HOURS and gets declared RUNAWAY at ~60m while it is compiling healthily.
  // `--heavy-tier codegen` swaps in that tier's budgets. An explicitly passed
  // --timeout-min / --max-building-windows always wins over the tier default, so
  // the tier raises the floor for callers that pass nothing without overriding a
  // caller that stated a number.
  let heavyTierRaw = "";
  const explicit = new Set<string>();
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--fleet": opts.fleet = true; i++; break;
      case "--project": opts.project = valueAfter(argv, i); i += 2; break;
      case "--target-root": opts.targetRoot = valueAfter(argv, i); i += 2; break;
      case "--pm-id": opts.pm = valueAfter(argv, i); i += 2; break;
      case "--id": opts.id = valueAfter(argv, i); i += 2; break;
      case "--branch": opts.branch = valueAfter(argv, i); i += 2; break;
      case "--windows": opts.windows = positiveInteger(valueAfter(argv, i), "--windows"); i += 2; break;
      case "--heavy-tier": heavyTierRaw = valueAfter(argv, i); i += 2; break;
      case "--timeout-min": opts.timeoutMin = Number(valueAfter(argv, i)); explicit.add("timeout-min"); i += 2; break;
      case "--timeout-sec": opts.timeoutSec = positiveInteger(valueAfter(argv, i), "--timeout-sec"); i += 2; break;
      case "--interval-sec": opts.intervalSec = Number(valueAfter(argv, i)); i += 2; break;
      case "--proc-regex": opts.procRegex = valueAfter(argv, i); i += 2; break;
      case "--max-building-windows": opts.maxBuilding = Number(valueAfter(argv, i)); explicit.add("max-building-windows"); i += 2; break;
      case "--output-file": opts.outputFile = valueAfter(argv, i); i += 2; break;
      case "--max-output-mb": opts.maxOutputMb = Number(valueAfter(argv, i)); i += 2; break;
      case "--stall-min": opts.stallMin = Number(valueAfter(argv, i)); opts.stallExplicit = true; i += 2; break;
      case "--stall-sec": opts.stallSec = Number(valueAfter(argv, i)); opts.stallExplicit = true; i += 2; break;
      case "--max-run-min": opts.maxRunMin = Number(valueAfter(argv, i)); i += 2; break;
      case "--max-run-sec": opts.maxRunSec = Number(valueAfter(argv, i)); i += 2; break;
      case "--transcript": opts.transcript = valueAfter(argv, i); i += 2; break;
      case "--spawn-grace-sec": opts.spawnGraceSec = Number(valueAfter(argv, i)); i += 2; break;
      case "--mark-resumed": opts.markResumed = true; i++; break;
      case "-h": case "--help": out(HELP); return 0;
      default: fail(`dispatch_watch: unknown arg: ${argv[i]}`);
    }
  }
  // W-348: apply the tier budgets. Absence of --heavy-tier is NOT treated as the
  // conservative codegen default here (unlike a heavy dispatch's own undeclared
  // tier): this watch runs over every dispatch, most of them non-heavy, so
  // defaulting them all to codegen windows would triple the stall-detection delay
  // fleet-wide. No flag = no tier information = the documented defaults, unchanged.
  // A supplied-but-unknown token still resolves to codegen, the safe side.
  if (heavyTierRaw) {
    const tier = resolveHeavyTierBudget(heavyTierRaw);
    if (tier.warning) out(`dispatch_watch: ${tier.warning}`);
    if (!explicit.has("timeout-min")) opts.timeoutMin = tier.budget.watchTimeoutMinutes;
    if (!explicit.has("max-building-windows")) opts.maxBuilding = tier.budget.watchMaxBuildingWindows;
    out(`dispatch_watch: heavy_tier=${tier.budget.tier} — window ${opts.timeoutMin}m x ${opts.maxBuilding} (runaway ceiling ${opts.timeoutMin * opts.maxBuilding}m)`);
  }
  if (!opts.project || !opts.pm) fail("dispatch_watch: --project and --pm-id are required");
  if (!opts.targetRoot) opts.targetRoot = opts.project;
  // W-143: --mark-resumed stamps the resume grace anchor and exits. The operator
  // runs it right after re-invoking a role so the next watch does not read the
  // resume's read/think phase as a stall (the #352 resume-read false fire).
  if (opts.markResumed) {
    if (!opts.id) fail("dispatch_watch: --mark-resumed requires --id");
    const container = crewSubdir(opts.project, opts.pm, `dispatch${opts.id}`);
    if (!existsSync(container)) fail(`dispatch_watch: --mark-resumed: no container ${container}`);
    if (lifecycle.consumeAbort(container)) {
      out(`RESULT: ABORTED — dispatch #${opts.id} consumed abort.md and transitioned to STATE.md=ABORTED`);
      return 0;
    }
    writeFileSync(resolve(container, "resumed_at"), `${nowSeconds()}\n`);
    out(`dispatch_watch: marked dispatch #${opts.id} resumed at ${nowSeconds()} (grace re-anchored)`);
    return 0;
  }
  const pmRoot = `${opts.project}/__garelier/${opts.pm}`;
  const pmContainer = crewSubdir(opts.project, opts.pm, "pm");
  const dispatch0 = crewSubdir(opts.project, opts.pm, "dispatch0");
  const dispatchRoot = resolve(dispatch0, "..");
  const dispatchPrefix = basename(dispatch0).replace(/0$/, "");
  const heartbeatDir = `${pmRoot}/runtime/dispatch/watch/heartbeats`;
  if (opts.fleet) return runFleet(opts, pmRoot, dispatchRoot, dispatchPrefix, heartbeatDir, lifecycle);

  if (!opts.id && !opts.branch) fail("dispatch_watch: one of --id or --branch is required (or pass --fleet)");
  const config = `${pmContainer}/setup_config.toml`;
  const studio = text(config).match(/^integration[ \t]*=\s*"([^"]*)"/m)?.[1] ?? "";
  if (!studio) fail(`dispatch_watch: cannot resolve integration branch from ${config}`);
  const container = opts.id ? crewSubdir(opts.project, opts.pm, `dispatch${opts.id}`) : "";
  if (container && lifecycle.consumeAbort(container)) {
    out(`RESULT: ABORTED — dispatch #${opts.id} consumed abort.md and transitioned to STATE.md=ABORTED`);
    return 0;
  }
  if (container) {
    const gateGap = containerGateTerminalGap(container);
    if (gateGap) {
      out(`RESULT: GATE-RESULT-MISSING — dispatch #${opts.id} gate run ${gateGap.runId} has GATE_END without RESULT; inspect ${resolve(container, "ci_evidence", "gate_runner.log")} and re-run through gate_runner (do not wait for the stall timeout)`);
      return 0;
    }
  }
  if (!opts.branch) {
    const state = `${container}/STATE.md`;
    const slug = stateField(state, "Current task").split(/\s+/)[1] ?? "";
    if (!slug) fail(`dispatch_watch: cannot resolve slug from ${state}`);
    const refs1 = gitOut(opts.targetRoot, ["for-each-ref", "--format=%(refname:short)", `refs/heads/*/${opts.pm}/workbench/#${opts.id}/${slug}`]);
    const refs2 = refs1 || gitOut(opts.targetRoot, ["for-each-ref", "--format=%(refname:short)", `refs/heads/**/#${opts.id}/${slug}`]);
    opts.branch = refs2.split(/\r?\n/)[0] ?? "";
    if (!opts.branch) fail(`dispatch_watch: cannot resolve branch for id ${opts.id} slug ${slug} — pass --branch`);
  }

  const isProxy = commitMode(container) === "proxy";
  const watchStateDir = `${pmRoot}/runtime/dispatch/watch`;
  const watchKey = opts.branch.replace(/[^A-Za-z0-9_.-]/g, "_");
  const buildingCounter = `${watchStateDir}/${watchKey}.building`;
  const heartbeatFile = opts.id ? `dispatch-${opts.id}.json` : `branch-${watchKey}.json`;
  const roleStatus = (): string => container ? stateField(`${container}/STATE.md`, "Status").replace(/\s/g, "") : "";
  // The lane's own declaration is canonical: STATE.md is dispatch-setup intent and
  // routinely stays WORKING after the provider emitted its terminal register, so
  // reading only STATE.md misses exactly the lanes that finished.
  const idleNoRegister = (): boolean => !!container && !existsSync(`${container}/register_received`)
    && (roleStatus() === "REPORTING" || laneDeclaredCompletion(container) === "REPORTING");

  let final: WindowResult = { verdict: "", message: "" };
  for (let win = 1; win <= opts.windows; win++) {
    final = await runWindow({ opts, win, studio, branch: opts.branch, container, isProxy, heartbeatDir, heartbeatFile, watchStateDir, buildingCounter, lifecycle });
    if (idleNoRegister()) break;
    if ((final.verdict === "PROGRESS" || final.verdict === "BUILDING" || final.verdict === "SPAWN-GRACE") && win < opts.windows) {
      out(`dispatch_watch: window ${win}/${opts.windows} verdict=${final.verdict} — re-arming to window ${win + 1}/${opts.windows} (still working, no notification)`);
      continue;
    }
    break;
  }
  if (idleNoRegister()) {
    final = { verdict: "IDLE-NO-REGISTER", message: `IDLE-NO-REGISTER — dispatch #${opts.id} は REPORTING だが完了 register 未処理 (register_received marker 不在)。role は DONE の可能性が高い — wake して最終 register (最終 STATE / branch+SHA / report path / gate 結果 / 台帳 N/N) を送らせるか、内容を確認して register を処理し ${container}/register_received を touch してください。respawn は不要。contract_check.ts --stall-scan の idle_no_register が同判定 + wake 文面を出します。` };
  }
  out(`RESULT: ${final.message}`);
  return 0;
}

if (import.meta.main) process.exit(await main());
