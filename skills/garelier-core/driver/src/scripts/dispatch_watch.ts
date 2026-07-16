#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { crewSubdir } from "../workspace.ts";
import { git, run } from "./_lib.ts";
import { scanTranscriptForMalformed, MALFORMED_SUBAGENT_NUDGE } from "./malformed_detect.ts";

const HELP = `#
# dispatch_watch.sh — reactive stall backstop for a heavy producer dispatch
# (DEC-091, defense-in-depth behind the preventive measures). A sub-agent is
# run-to-completion: a build it detaches does NOT re-invoke it, so a producer that
# detaches a long compile and goes idle STALLS silently. The preventive fix is a
# warm cache + crate-scoped foreground gate (DEC-091); this is the backstop for
# when a producer stalls anyway.
#
# Two modes, ONE home (W-071 — no third watchdog implementation):
#   single  (default) — watch ONE producer (--id or --branch); detailed RUNAWAY
#                       compensation (hard ceiling + output-bloat).
#   --fleet           — watch EVERY live dispatch under a pm-id in one process
#                       (WORKING / REWORK, plus ungated REPORTING — the W-086
#                       blind spot). Loud, durable dormancy sweep + drain.
#
# The OPERATOR (main session — stall-immune) runs this in the background right
# after dispatching a heavy producer (single mode) or once per pm-id to watch the
# whole fleet (--fleet). It polls git-observable progress and the host's compile
# activity, then EXITS (re-invoking the operator) with a clear RESULT line. The
# verdict vocabulary is the SINGLE anomaly taxonomy defined in
# role_subagent_dispatch.md §6 (PROGRESS / ADVANCING / BUILDING / STALLED /
# RUNAWAY / REVIVE-NEEDED / IDLE-NO-REGISTER) — dispatch_watch and contract_check
# --stall-scan speak the same terms:
#   PROGRESS      — a NEW commit landed on the branch since the watch started (the
#                   producer is finishing; check for REPORTING)
#   ADVANCING     — no new commit and no live compile at the timeout, but STATE.md/
#                   report.md advanced during the window (uncommitted forward
#                   progress — NOT a detach-and-idle stall; re-run the watch)
#   BUILDING      — still compiling at timeout (re-run the watch for another window)
#   STALLED       — no new commit, no STATE/report change, no live compile after the
#                   timeout (warm-resume or re-dispatch the producer; cache is warm)
#   RUNAWAY       — a runaway safety trip (W-077). Because budget-read + message-wake
#                   lets a job outlive the bash-timeout ceiling that normally caps a
#                   runaway, the operator compensates with cheap runaway checks here
#                   (W-075: for a commit_mode=proxy seat — a codex producer that
#                   structurally cannot commit, the Dock proxy-commits later — the
#                   hard ceiling below only fires when NEITHER the worktree nor the
#                   STATE/report signal moved either; it never fires on commit
#                   absence alone, and its message says so explicitly):
#                   (a) HARD CEILING — BUILDING for --max-building-windows consecutive
#                       windows (default 3; a healthy cold build should have committed
#                       by then) — do NOT wait forever on infinite BUILDING; and
#                   (b) OUTPUT BLOAT — an opt-in --output-file grew past --max-output-mb
#                       with no STATE/report progress (a job writing without advancing;
#                       the log-fills-the-SSD precedent). On RUNAWAY the operator kills
#                       the producer's process group, marks the job FAILED, and checks
#                       for orphaned build procs (compile_procs in the poll lines)
#                       before re-dispatch — never masks it as success.
#   REVIVE-NEEDED — (--fleet) sustained dormancy: no git-observable progress (HEAD +
#                   STATE/report hash unchanged) for >= the stall threshold AND no
#                   build/verify process anywhere. A STALLED that stayed flat is a
#                   DORMANT producer — respawn it FRESH from its worktree (a /resume
#                   does NOT restore an in-process teammate — official). Distinct from
#                   STALLED (one flat window) so a truly dead producer is not merely
#                   nudged forever.
#   IDLE-NO-REGISTER — (single mode, needs --id) the watched producer reached REPORTING
#                   but the PM never processed its completion register (no
#                   register_received marker). It is DONE-but-unregistered — a WAKE, not
#                   a respawn: wake it to send the final register (a gate role: its
#                   verdict register), or process the register and touch the marker. It
#                   overrides the window verdict so a finished producer is not read as a
#                   PROGRESS/STALLED to re-arm on. The detective twin is contract_check
#                   --stall-scan's idle_no_register (W-018, same marker convention).
#   IDLE-DONE     — (single mode, needs --id, W-078c) a harness-gap variant of the same
#                   silence: the producer's own background job (e.g. a heavy gate run
#                   with run_in_background) finished, but the producer was never
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
#                   killing a live producer. Two guards close it: (a) compile_procs is
#                   RE-SAMPLED at the firing poll — a compile that (re)started within the
#                   poll suppresses the fire (think→compile boundary); and (c) for proxy
#                   seats ONLY, the static-poll fingerprint now also folds in report.md
#                   mtime, codex_last_message.md appearance, and a COMMIT PLAN in report.md
#                   (proxyActivityRaw) — a live think phase that touches any of these
#                   RE-ARMS the counter (and reads ADVANCING at window end) instead of
#                   tripping IDLE-DONE. Self-commit seats are unchanged.
#   MALFORMED-CALL — (single mode, W-097) the watched producer's LATEST assistant
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
#
# Progress is judged by GIT-OBSERVABLE forward movement only — a new commit
# beyond the branch tip captured at the FIRST observation (baseline), or a change
# in the content hash of the dispatch's STATE.md/report.md (fleet mode combines the
# two into a per-dispatch fingerprint: HEAD sha | hash(STATE.md + report.md)). It
# is NEVER reset by a bare liveness ping or a file mtime: a ping does not prove
# progress and letting it reset the clock would defeat the watchdog (a producer
# that only pings while dormant would never trip). The window is fixed; the signals
# classify only the terminal verdict.
#
# W-075 SINGLE-MODE EXCEPTION (proxy seats only): a commit_mode=proxy producer
# (codex — its sandbox re-pins the gitdir read-only, DEC-context W-042) never
# advances \`commits\`, so it needs a non-commit progress signal the way fleet mode
# already has one (STATE/report hash). Single mode adds the worktree's dirty-file
# count / newest mtime under checkout (wt_progress_sig) as an ADDITIONAL signal,
# gated to commit_mode=proxy only — it is real forward motion (a diff on disk), not
# a bare liveness ping, and is a no-op for self-commit producers. The anti-ping
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
# heartbeat is refreshed the whole time. --windows 1 reproduces the pre-W-094`;

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
  maxRunMin: number; maxRunSec?: number; transcript: string;
}

// W-097: malformed tool-call detector. The watched producer's transcript (a JSONL
// path passed via --transcript, or auto-discovered in the container) is tail-scanned
// each poll; a malformed LATEST assistant turn (stop_reason=tool_use + 0 tool_use
// blocks — the Opus 4.8 regression) means the turn JAMMED, distinct from a live
// think phase (W-090, which advances report.md and carries NO malformed signature)
// and from an idle/building producer. Returns the finding's detail or "" when the
// transcript is absent/clean. Reading the whole file is fine — the scanner tails it
// internally; a missing file is a silent no-op (fail-open, never a false MALFORMED).
function scanProducerTranscript(path: string): { detected: boolean; detail: string; softSignal: boolean } {
  if (!path || !existsSync(path)) return { detected: false, detail: "", softSignal: false };
  const finding = scanTranscriptForMalformed(text(path));
  return { detected: finding.detected, detail: finding.detail, softSignal: finding.softSignal };
}

function compileProcs(pattern: string): number {
  let snapshot = "";
  for (const args of [["ps", "-W"], ["ps", "-e"], ["ps", "aux"]]) {
    const r = run(args);
    if (r.exitCode === 0) { snapshot = r.stdout; break; }
  }
  let regex: RegExp;
  try { regex = new RegExp(`^(?:${pattern})$`, "i"); } catch { return 0; }
  let count = 0;
  for (const line of snapshot.split(/\r?\n/)) {
    if (/sccache/i.test(line)) continue;
    const tokens = line.trim().split(/\s+/).filter(Boolean).map((token) => token.replace(/^.*[\\/]/, ""));
    if (tokens.some((token) => regex.test(token))) count++;
  }
  return count;
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

function dispatchDirs(root: string, legacyPrefix: string): Array<{ id: string; container: string }> {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(legacyPrefix) && existsSync(resolve(root, entry.name, "STATE.md")))
      .map((entry) => ({ id: entry.name.replace(/\D/g, ""), container: resolve(root, entry.name) }))
      .filter((entry) => entry.id);
  } catch { return []; }
}

async function runFleet(opts: Options, pmRoot: string, dispatchRoot: string, dispatchPrefix: string, heartbeatDir: string): Promise<number> {
  const stallSec = opts.stallSec ?? opts.stallMin * 60;
  const maxRunSec = opts.maxRunSec ?? opts.maxRunMin * 60;
  const start = nowSeconds();
  let cycle = 0;
  const lastFp = new Map<string, string>();
  const lastHead = new Map<string, string>();
  const lastProg = new Map<string, number>();
  const lastKind = new Map<string, string>();
  out(`dispatch_watch[fleet]: pm=${opts.pm} stall=${stallSec}s interval=${opts.intervalSec}s max_run=${maxRunSec}s (targets: WORKING/REWORK + ungated REPORTING)`);
  for (;;) {
    const now = nowSeconds(); cycle++;
    const active: Array<{ id: string; label: string }> = [];
    for (const { id, container } of dispatchDirs(dispatchRoot, dispatchPrefix)) {
      const status = stateField(resolve(container, "STATE.md"), "Status").replace(/\s/g, "");
      let label = "";
      if (status === "WORKING" || status === "REWORK") label = status;
      else if (status === "REPORTING") {
        const slug = fleetSlug(container);
        if (slug && (existsSync(`${pmRoot}/runtime/guardian/results/${slug}-guardian.md`) || existsSync(`${pmRoot}/runtime/observer/results/${slug}-observer.md`))) continue;
        label = "REPORTING(ungated)";
      } else continue;
      active.push({ id, label });
      const head = gitOut(resolve(container, "checkout"), ["rev-parse", "HEAD"]) || "none";
      const fileHash = hashText(text(resolve(container, "STATE.md")) + text(resolve(container, "report.md")));
      const fp = `${head}|${fileHash}`;
      if ((lastFp.get(id) ?? "__new__") !== fp) {
        if (!lastFp.has(id)) lastKind.set(id, "SEEDED");
        else if (lastHead.get(id) !== head) lastKind.set(id, "PROGRESS");
        else lastKind.set(id, "ADVANCING");
        lastFp.set(id, fp); lastHead.set(id, head); lastProg.set(id, now);
      }
    }
    if (!active.length) { out(`RESULT: DRAIN — no active WORKING/REWORK/ungated-REPORTING dispatch under ${opts.pm} (nothing to watch)`); return 0; }
    const dormant = active.filter(({ id }) => now - (lastProg.get(id) ?? now) >= stallSec);
    const buildProcs = dormant.length ? compileProcs(opts.procRegex) : 0;
    const vis = active.map(({ id, label }) => ` #${id}(${label},${now - (lastProg.get(id) ?? now)}s)`).join("");
    out(`poll ${cycle} (~${now - start}s): active=${vis}${dormant.length ? ` dormant= ${dormant.map((x) => x.id).join(" ")} build_procs=${buildProcs}` : ""}`);
    writeHeartbeat(heartbeatDir, `fleet-${process.pid}.json`, { pid: process.pid, mode: "fleet", ts_epoch: nowSeconds(), active_ids: active.map((x) => x.id).join(" ") });
    if (dormant.length && buildProcs === 0) {
      for (const { id, label } of dormant) {
        const container = crewSubdir(opts.project, opts.pm, `_dispatch${id}`);
        out(`RESULT: REVIVE-NEEDED — dispatch #${id} (${label}) had no git-observable progress (HEAD + STATE/report hash unchanged) for >= ${stallSec}s and no build/verify process is running: the producer is DORMANT, not building. Respawn it FRESH from its worktree — a /resume does NOT restore an in-process teammate (official). Recovery: inspect ${container}/checkout (git status / git log --oneline) + STATE.md, then re-dispatch preserving that worktree (contract_check.ts --stall-scan --handoff ${id} emits the respawn-handoff prompt). Do NOT wake it.`);
      }
      out(`RESULT: REVIVE-NEEDED — ${dormant.length} dormant dispatch(es) need a fresh respawn (per-dispatch lines above)`);
      return 0;
    }
    if (now - start >= maxRunSec) {
      const buildNow = compileProcs(opts.procRegex);
      let summary = "";
      for (const { id, label } of active) {
        const dorm = now - (lastProg.get(id) ?? now);
        let verdict: string;
        if (dorm < opts.intervalSec && lastKind.get(id) === "PROGRESS") verdict = "PROGRESS";
        else if (dorm < opts.intervalSec && lastKind.get(id) === "ADVANCING") verdict = "ADVANCING";
        else if (buildNow > 0) verdict = "BUILDING";
        else if (dorm >= stallSec) verdict = "REVIVE-NEEDED";
        else verdict = "STALLED";
        out(`  #${id} (${label}): dormancy=${dorm}s verdict=${verdict}`);
        summary += ` #${id}=${verdict}`;
      }
      out(`RESULT: HEALTHY — watched ${now - start}s, no dispatch crossed the ${stallSec}s dormancy threshold;${summary}; re-run the fleet watch to keep watching`);
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

// W-090(c): proxy-seat (codex) think/read-phase activity signal. A codex producer
// spends minutes between compiles READING and THINKING; during that phase its
// checkout worktree is momentarily static and compile_procs momentarily 0, but it
// is very much alive — it is streaming a COMMIT PLAN into report.md, its
// --output-last-message codex_last_message.md lands, or it re-touches report.md.
// None of those move progressSig (content hash of STATE.md+report.md alone) on an
// mtime-only touch, nor worktreeProgressRaw (which walks checkout/, not the
// container). Folding them in as a proxy-only activity fingerprint lets a live
// think phase RE-ARM the IDLE-DONE static-poll counter instead of tripping a false
// IDLE-DONE early-exit (field #340, W-082's residual hole). Proxy-only — a
// self-commit seat is judged by commits/sig/worktree exactly as before.
function proxyActivityRaw(container: string): string {
  if (!container) return "";
  const reportMtime = fileMtimeMs(resolve(container, "report.md"));
  const codexMtime = fileMtimeMs(resolve(container, "codex_last_message.md"));
  const commitPlan = /COMMIT PLAN/.test(text(resolve(container, "report.md"))) ? 1 : 0;
  return `${reportMtime}|${codexMtime}|${commitPlan}`;
}

interface WindowResult { verdict: string; message: string; }

async function runWindow(args: {
  opts: Options; win: number; studio: string; branch: string; container: string; isProxy: boolean;
  heartbeatDir: string; heartbeatFile: string; watchStateDir: string; buildingCounter: string;
}): Promise<WindowResult> {
  const { opts, win, studio, branch, container, isProxy, heartbeatDir, heartbeatFile, watchStateDir, buildingCounter } = args;
  const commitCount = (): number => {
    const result = gitOut(opts.targetRoot, ["log", "--oneline", `${studio}..${branch}`]);
    return result ? result.split(/\r?\n/).filter(Boolean).length : 0;
  };
  const producerStatus = (): string => container ? stateField(resolve(container, "STATE.md"), "Status").replace(/\s/g, "") : "";
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

  // W-097: the producer's transcript to tail-scan for a malformed tool call.
  // Explicit --transcript wins; otherwise a conventional transcript.jsonl in the
  // dispatch container (absent by default — a no-op when not present).
  const transcriptPath = opts.transcript || (container ? resolve(container, "transcript.jsonl") : "");

  const baseCommits = commitCount();
  const baseSig = progressSig(container);
  const baseWt = isProxy ? worktreeProgressRaw(container) : "";
  const basePa = isProxy ? proxyActivityRaw(container) : "";
  const baseIdleFp = `${baseCommits}|${baseSig}|${worktreeProgressRaw(container)}|${basePa}`;
  let sigMoved = false, wtMoved = false, paMoved = false, idleDoneArmed = false, idleDoneCount = 0, idleDonePrev = "";
  const proxyNote = isProxy ? " commit_mode=proxy (worktree/report signal, not commits)" : "";
  out(`dispatch_watch[window ${win}/${opts.windows}]: branch=${branch} studio=${studio} timeout=${opts.timeoutMin}m interval=${opts.intervalSec}s base_commits=${baseCommits}${proxyNote}`);
  heartbeat();
  const totalSec = opts.timeoutSec ?? opts.timeoutMin * 60;
  const iters = Math.max(1, Math.floor(totalSec / opts.intervalSec));
  for (let i = 1; i <= iters; i++) {
    await Bun.sleep(opts.intervalSec * 1000);
    heartbeat();
    const commits = commitCount();
    const sig = progressSig(container);
    const wt = isProxy ? worktreeProgressRaw(container) : "";
    const pa = isProxy ? proxyActivityRaw(container) : "";
    const procs = compileProcs(opts.procRegex);
    if (sig && sig !== baseSig) sigMoved = true;
    if (wt && wt !== baseWt) wtMoved = true;
    if (pa && pa !== basePa) paMoved = true;
    const mb = outputMb();
    const malformed = scanProducerTranscript(transcriptPath);
    out(`poll ${i} (~${i * opts.intervalSec}s): commits=${commits} (base ${baseCommits}) sig_moved=${sigMoved ? 1 : 0} compile_procs=${procs}${mb === undefined ? "" : ` output_mb=${mb}`}${isProxy ? ` wt_moved=${wtMoved ? 1 : 0} pa_moved=${paMoved ? 1 : 0}` : ""}${transcriptPath ? ` malformed=${malformed.detected ? 1 : 0}` : ""}`);
    // W-097: a malformed LATEST assistant turn means the producer's turn JAMMED —
    // it is neither idle-done, building, nor a live think phase (a think phase
    // advances report.md and carries NO malformed signature). Fire immediately
    // (like IDLE-DONE): more waiting cannot un-jam a broken tool call; the fix is a
    // prose-free call-only resend, which the operator triggers with the nudge below.
    if (malformed.detected) {
      resetBuilding();
      return {
        verdict: "MALFORMED-CALL",
        message:
          `MALFORMED-CALL — the watched producer's ${malformed.detail}. The turn JAMMED (not idle-done, not building` +
          ` — compile_procs=${procs}), so waiting will not recover it. Do NOT respawn or kill. Recovery: SendMessage the` +
          ` producer verbatim: "${MALFORMED_SUBAGENT_NUDGE}" If it recurs, downgrade the seat to Opus 4.7 or lower its` +
          ` reasoning effort (the immediate mitigation).`,
      };
    }
    if (!isProxy && commits > baseCommits) {
      resetBuilding();
      return { verdict: "PROGRESS", message: `PROGRESS — ${commits - baseCommits} new commit(s) on ${branch} since watch start; the producer is finishing (check for REPORTING, then gate via jig_gate_held)` };
    }
    if (mb !== undefined && mb > opts.maxOutputMb && !sigMoved) {
      resetBuilding();
      return { verdict: "RUNAWAY", message: `RUNAWAY — ${opts.outputFile} grew past ${opts.maxOutputMb}MB (now ${mb}MB) with no STATE/report progress: a job writing without advancing (SSD-fill precedent). Kill the producer's process group, mark the job FAILED, and check for orphaned build procs (compile_procs=${procs}) before re-dispatch — do NOT keep the watch running on it.` };
    }
    const idleFp = `${commits}|${sig}|${worktreeProgressRaw(container)}|${isProxy ? proxyActivityRaw(container) : ""}`;
    if (procs > 0 || idleFp !== baseIdleFp) idleDoneArmed = true;
    const registered = container && existsSync(resolve(container, "register_received"));
    const state = producerStatus();
    if (container && procs === 0 && !registered && idleDoneArmed && (state === "WORKING" || state === "REPORTING")) {
      if (idleFp === (idleDonePrev || "__unset__")) idleDoneCount++;
      else idleDoneCount = 1;
      idleDonePrev = idleFp;
      // W-090(a): re-sample compile_procs at the firing poll — a compile that
      // (re)started between this poll's process probe and here means the producer
      // is BUILDING, not idle-done; suppress and let the counter re-earn it. Guards
      // the codex think→compile boundary where procs flips 0→>0 within one poll.
      if (idleDoneCount >= 2 && compileProcs(opts.procRegex) === 0) {
        resetBuilding();
        return { verdict: "IDLE-DONE", message: "IDLE-DONE — producer went silent after its background finished (procs=0, no progress 2 polls). Wake it: send the producer a message to read its last background output, transcribe verbatim results, commit (if self mode), and register. Do NOT kill or re-dispatch — work is likely complete in the worktree." };
      }
    } else { idleDoneCount = 0; idleDonePrev = ""; }
  }

  const finalProcs = compileProcs(opts.procRegex);
  if (finalProcs > 0 && (!isProxy || (!sigMoved && !wtMoved && !paMoved))) {
    const count = bumpBuilding();
    if (count >= opts.maxBuilding) {
      resetBuilding();
      if (isProxy) return { verdict: "RUNAWAY", message: `RUNAWAY — proxy seat — do NOT judge by commits; verify worktree mtime + codex processes before killing. Still compiling after ${count} consecutive BUILDING window(s) (~${count * opts.timeoutMin}m, hard ceiling ${opts.maxBuilding}) with NO worktree dirty-file/mtime change and NO STATE/report change (commit_mode=proxy — commits are never the signal here, the Dock proxy-commits later): kill the producer's process group, mark the job FAILED, and check for orphaned build procs (compile_procs=${finalProcs}) before re-dispatch.` };
      return { verdict: "RUNAWAY", message: `RUNAWAY — still compiling after ${count} consecutive BUILDING window(s) (~${count * opts.timeoutMin}m, hard ceiling ${opts.maxBuilding}). A healthy cold build should have committed by now — treat as runaway, not patience: kill the producer's process group, mark the job FAILED, and check for orphaned build procs (compile_procs=${finalProcs}) before re-dispatch. Do NOT keep waiting on infinite BUILDING.` };
    }
    return { verdict: "BUILDING", message: `BUILDING — still compiling at timeout (window ${count}/${opts.maxBuilding}, no new commit yet); re-run the watch for another window (trips RUNAWAY at the hard ceiling)` };
  }
  resetBuilding();
  if (sigMoved || (isProxy && (wtMoved || paMoved))) {
    if (isProxy && !sigMoved) return { verdict: "ADVANCING", message: "ADVANCING — proxy seat (commit_mode=proxy; commits are NOT the progress signal here, the Dock proxy-commits later): worktree dirty-file count / file mtime OR report.md/codex_last_message.md activity advanced during the window even though STATE.md/report.md content stayed flat (a live think/read phase, W-090). Re-run the watch for another window; if it goes flat next window with no compile and no worktree/report activity, treat as STALLED." };
    return { verdict: "ADVANCING", message: "ADVANCING — no new commit and no live compile at timeout, but STATE.md/report.md advanced during the window (uncommitted forward progress, NOT a detach-and-idle stall). Re-run the watch for another window; if it goes flat next window with no compile, treat as STALLED." };
  }
  return { verdict: "STALLED", message: `STALLED — no new commit, no STATE/report change, and no live compile after ${opts.timeoutMin}m. The producer likely detached a build and went idle (DEC-091). Warm-resume it (cache is now warm) or re-dispatch; if uncommitted work survives in ${container || "the dispatch container"}/checkout, a resume preserves it. If it stays flat across re-arms with no build, --fleet escalates it to REVIVE-NEEDED (respawn).` };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const opts: Options = {
    fleet: false, project: "", targetRoot: "", pm: "", id: "", branch: "", windows: 3,
    timeoutMin: 20, intervalSec: 90, procRegex: DEFAULT_PROC_REGEX, maxBuilding: 3,
    outputFile: "", maxOutputMb: 100, stallMin: 30, maxRunMin: 60, transcript: "",
  };
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--fleet": opts.fleet = true; i++; break;
      case "--project": opts.project = valueAfter(argv, i); i += 2; break;
      case "--target-root": opts.targetRoot = valueAfter(argv, i); i += 2; break;
      case "--pm-id": opts.pm = valueAfter(argv, i); i += 2; break;
      case "--id": opts.id = valueAfter(argv, i); i += 2; break;
      case "--branch": opts.branch = valueAfter(argv, i); i += 2; break;
      case "--windows": opts.windows = positiveInteger(valueAfter(argv, i), "--windows"); i += 2; break;
      case "--timeout-min": opts.timeoutMin = Number(valueAfter(argv, i)); i += 2; break;
      case "--timeout-sec": opts.timeoutSec = positiveInteger(valueAfter(argv, i), "--timeout-sec"); i += 2; break;
      case "--interval-sec": opts.intervalSec = Number(valueAfter(argv, i)); i += 2; break;
      case "--proc-regex": opts.procRegex = valueAfter(argv, i); i += 2; break;
      case "--max-building-windows": opts.maxBuilding = Number(valueAfter(argv, i)); i += 2; break;
      case "--output-file": opts.outputFile = valueAfter(argv, i); i += 2; break;
      case "--max-output-mb": opts.maxOutputMb = Number(valueAfter(argv, i)); i += 2; break;
      case "--stall-min": opts.stallMin = Number(valueAfter(argv, i)); i += 2; break;
      case "--stall-sec": opts.stallSec = Number(valueAfter(argv, i)); i += 2; break;
      case "--max-run-min": opts.maxRunMin = Number(valueAfter(argv, i)); i += 2; break;
      case "--max-run-sec": opts.maxRunSec = Number(valueAfter(argv, i)); i += 2; break;
      case "--transcript": opts.transcript = valueAfter(argv, i); i += 2; break;
      case "-h": case "--help": out(HELP); return 0;
      default: fail(`dispatch_watch: unknown arg: ${argv[i]}`);
    }
  }
  if (!opts.project || !opts.pm) fail("dispatch_watch: --project and --pm-id are required");
  if (!opts.targetRoot) opts.targetRoot = opts.project;
  const pmRoot = `${opts.project}/__garelier/${opts.pm}`;
  const pmContainer = crewSubdir(opts.project, opts.pm, "_pm");
  const dispatch0 = crewSubdir(opts.project, opts.pm, "_dispatch0");
  const dispatchRoot = resolve(dispatch0, "..");
  const dispatchPrefix = basename(dispatch0).replace(/0$/, "");
  const heartbeatDir = `${pmRoot}/runtime/dispatch/watch/heartbeats`;
  if (opts.fleet) return runFleet(opts, pmRoot, dispatchRoot, dispatchPrefix, heartbeatDir);

  if (!opts.id && !opts.branch) fail("dispatch_watch: one of --id or --branch is required (or pass --fleet)");
  const config = `${pmContainer}/setup_config.toml`;
  const studio = text(config).match(/^integration[ \t]*=\s*"([^"]*)"/m)?.[1] ?? "";
  if (!studio) fail(`dispatch_watch: cannot resolve integration branch from ${config}`);
  const container = opts.id ? crewSubdir(opts.project, opts.pm, `_dispatch${opts.id}`) : "";
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
  const producerStatus = (): string => container ? stateField(`${container}/STATE.md`, "Status").replace(/\s/g, "") : "";
  const idleNoRegister = (): boolean => !!container && existsSync(`${container}/STATE.md`) && !existsSync(`${container}/register_received`) && producerStatus() === "REPORTING";

  let final: WindowResult = { verdict: "", message: "" };
  for (let win = 1; win <= opts.windows; win++) {
    final = await runWindow({ opts, win, studio, branch: opts.branch, container, isProxy, heartbeatDir, heartbeatFile, watchStateDir, buildingCounter });
    if (idleNoRegister()) break;
    if ((final.verdict === "PROGRESS" || final.verdict === "BUILDING") && win < opts.windows) {
      out(`dispatch_watch: window ${win}/${opts.windows} verdict=${final.verdict} — re-arming to window ${win + 1}/${opts.windows} (still working, no notification)`);
      continue;
    }
    break;
  }
  if (idleNoRegister()) {
    final = { verdict: "IDLE-NO-REGISTER", message: `IDLE-NO-REGISTER — dispatch #${opts.id} は REPORTING だが完了 register 未処理 (register_received marker 不在)。producer は DONE の可能性が高い — wake して最終 register (最終 STATE / branch+SHA / report path / gate 結果 / 台帳 N/N) を送らせるか、内容を確認して register を処理し ${container}/register_received を touch してください。respawn は不要。contract_check.ts --stall-scan の idle_no_register が同判定 + wake 文面を出します。` };
  }
  out(`RESULT: ${final.message}`);
  return 0;
}

if (import.meta.main) process.exit(await main());
