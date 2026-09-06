#!/usr/bin/env bun
import { rmSync } from "../guard/path_guard.ts";
// TS-first port of driver/src/scripts/fleet_watch.ts (W-028 / W-029 / W-033 / W-083).
// Behaviour frozen: flags / stdout / stderr / exit codes / the FLEET-ATTENTION
// RESULT line + detection JSON / lock file path + format all match the shell 1:1.
//
// The STANDING per-pm fleet stall watch: a permanent loop that periodically runs
// contract_check.ts --stall-scan, and the moment it finds ACTIONABLE work that
// survives a confirm re-scan (W-029), prints a single RESULT: FLEET-ATTENTION
// line + detection JSON and EXITS 0. All classification is delegated to the scan;
// this loop owns only the confirm / fingerprint / suppression temporal guards.
//
// The embedded keys/filter/decide bun program of the shell is inlined here as
// plain functions — the set/fingerprint/suppression logic lives in one place.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readIncidentRepeats } from "../guard/incident_log.ts";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scanTranscriptForMalformed, MALFORMED_PM_NUDGE } from "./malformed_detect.ts";
import { pidAlive, requireRuntimeExecutable, resolveRuntimeExecutable } from "./_lib.ts";
import { coalesceCompletionWake, longJobRoot, recoverLongJobs } from "../long_jobs.ts";
import { assertOperatorResidentStart, ResidentProcessEnvironmentError } from "./resident_process_health.ts";
import { loadConfig } from "../config.ts";
import { admitDockProxyReadyPaths } from "./dock_proxy.ts";
import { crewSubdir } from "../workspace.ts";

const outw = (s: string) => process.stdout.write(s + "\n");
const errw = (s: string) => process.stderr.write(s + "\n");

// Lines 2-89 of the original fleet_watch.ts (what `sed -n '2,89p' "$0"` printed).
const HELP = "#\n# fleet_watch.ts — the STANDING fleet stall watch (W-028). A permanent loop that\n# closes the three STRUCTURAL causes of an unattended stall (the \"stalled 5×/day\"\n# root-cause analysis, user 2026-07-07):\n#   1. a sub-agent is run-to-completion — after its turn ends it is NOT re-invoked\n#      until an external message arrives (no self-continuation), so a role that\n#      went idle/REPORTING-without-register waits silently until someone asks;\n#   2. dispatch_watch.ts is a SINGLE finite run — after its --windows expire (or\n#      its --fleet --max-run window ends) it EXITS and, unless re-armed, nothing\n#      watches the fleet at all (the overnight failure, 2026-07-06); and\n#   3. the scan → wake step was a MANUAL PM chore no timer enforced.\n#\n# The fix is one standing loop per pm-id that periodically runs the detective\n# (`contract_check.ts --stall-scan`) and, the moment it finds ACTIONABLE work,\n# prints a single `RESULT: FLEET-ATTENTION` line + the detection JSON (wake_cmd\n# included) and EXITS 0 — which re-invokes the operator (the PM is woken by the\n# run_in_background completion notification). The PM runs the wake_cmd(s), then\n# re-arms this watch. When nothing is actionable it sleeps and loops again, so it\n# NEVER becomes unmonitored by expiry (cause #2): the ONLY exits are an actionable\n# finding, the driver stop file, or a `--max-hours` safety cap (re-arm after each).\n#\n# RELATION TO dispatch_watch.ts (W-071 --fleet). No third watchdog — different job:\n#   - dispatch_watch --fleet is a FINITE dormancy sweep with its OWN git-fingerprint\n#     progress logic + a --max-run window; it EXITS HEALTHY after the window even\n#     with nothing wrong, and must be re-armed to keep watching (cause #2 for it).\n#   - fleet_watch is a PERMANENT loop that owns NO stall logic of its own: it\n#     delegates 100% of the classification (build-wait vs genuine stall, ungated\n#     REPORTING, idle-no-register, unprocessed result, unwatched) to the single\n#     anomaly taxonomy in contract_check.ts --stall-scan. Misfire suppression is\n#     therefore fully the scan's job — build-wait / unknown NEVER reach the\n#     actionable set (they are excluded upstream, W-018 / W-053), so this loop\n#     cannot false-wake a healthy cold build. The two compose: arm a per-role\n#     dispatch_watch (single mode) for a HEAVY role's close RUNAWAY-compensated\n#     window; keep ONE fleet_watch standing as the net that catches a watch that\n#     was forgotten or expired (surfaced here as `unwatched`).\n#\n# ACTIONABLE = any of the three --stall-scan arrays is non-empty:\n#   - idle_no_register  (W-018) — an idle dispatch with no processed register:\n#       REPORTING-done-but-unregistered, a genuinely stalled WORKING, or a gate\n#       role whose verdict never arrived. Each carries a ready-to-send wake_cmd.\n#   - unprocessed_results (W-086) — a landed merge whose workbench branch was never\n#       cleaned up (a forgotten result waiter left the aftercare stalled).\n#   - unwatched (W-085) — a WORKING dispatch with NO live dispatch_watch heartbeat\n#       (never armed, or its single watch EXPIRED and went stale — exactly cause #2).\n# Advisory detectives only — this loop never invents a verdict; it relays the\n# scan's. session_resume / unconsumed_instructions are reported by --stall-scan in\n# its own output but are not part of THIS loop's exit trigger (kept to the three\n# the wake protocol acts on).\n#\n# WAKE-SPAM SUPPRESSION (W-029). A single --stall-scan is a point-in-time probe, so\n# it flaps against two role races (day-one field data: of 5 wakes only 1 was a\n# real stall): (a) a heavy role whose build process is momentarily between\n# invocations reads as procs=0 → a build-wait misfires as a stall; (b) a role\n# actively editing (its dirty tree still growing) reads as an idle stall-suspect.\n# Three guards close them, ALL owned by THIS loop (contract_check stays a stateless\n# single-shot detective — the temporal \"compare two scans\" belongs here):\n#   1. CONFIRM (--confirm-delay-sec, default 600). An actionable finding does NOT\n#      fire immediately; the loop waits the delay, RE-scans, and fires only for the\n#      dispatches STILL actionable AND whose fingerprint is unchanged. A build-wait\n#      that flickered procs=0 is gone from the confirm scan (procs>0 again → not in\n#      idle_no_register) so it drops — the \"2 回とも procs=0 の時だけ\" rule.\n#   2. FINGERPRINT = the scan's own items[].tip_sha + dirty_hash (+ dirty) for the\n#      dispatch. If it MOVED between the two scans the role made progress (a new\n#      commit, or the dirty tree grew = still editing) → NOT a stall → dropped. This\n#      is the \"dirty 増加は進行中扱い\" rule, keyed on data --stall-scan already emits.\n#   3. SUPPRESSION WINDOW (--suppress-min, default 15). After a dispatch fires, its\n#      key is stamped in runtime/driver/fleet_watch_state.json; for the next window\n#      the loop will not re-flag it (the manual \"I already woke that one\" judgement,\n#      mechanized). Keys are pruned once past the window so the file stays small.\n# unprocessed_results carry no checkout fingerprint (a landed-merge structural fact,\n# not a flapping probe); they confirm on presence-in-both-scans + the window alone.\n#\n# MULTI-LAUNCH GUARD. runtime/driver/fleet_watch.lock holds the owner pid; a second\n# launch refuses (exit 3) while the owner is alive, and RECLAIMS a stale lock whose\n# owner pid is dead (W-024 liveness rule). The pid stored is the WINDOWS-checkable\n# winpid (Git-Bash `/proc/$$/winpid`, falling back to `$$` on native Linux/macOS)\n# so the liveness probe works on Windows too.\n#\n# Usage:\n#   fleet_watch.ts --project <root> --pm-id <id>\n#                  [--interval-sec N] [--max-hours H] [--unwatched-after MIN]\n#                  [--confirm-delay-sec D] [--suppress-min M]\n#                  [--pm-transcript <jsonl>]   (W-097 self face: tail the PM's own\n#                     session transcript for a malformed tool call; off by default)\n#                  [--max-sec S]   (precise/test override of --max-hours)\n# Defaults: --interval-sec 300  --max-hours 12  --confirm-delay-sec 600\n#           --suppress-min 15. --unwatched-after is passed through to contract_check\n# (its default 60 min applies when omitted). Always exits 0 on a RESULT line\n# (FLEET-ATTENTION / FLEET-CLEAR / FLEET-STOP); exit 2 = arg error;\n# exit 3 = a live fleet_watch already owns the lock.";

// W-169 (O N2): the multi-launch guard's liveness probe is the SHARED
// _lib.probePidLiveness (os-signal → tasklist → MSYS `ps`), not a Windows-only
// tasklist read — an MSYS `$$` owner pid (Git-Bash) is invisible to tasklist, so
// the old local probe read a LIVE git-bash fleet_watch owner as dead and reclaimed
// its lock (the same class W-169 closed for heavy_compile_lock). fail-ALIVE on an
// unprobeable pid is preserved (a false reclaim is impossible from a probe miss).
function epoch(): number { return Math.floor(Date.now() / 1000); }
function sleepSec(sec: number): void { if (sec > 0) Bun.sleepSync(sec * 1000); }

type Json = Record<string, unknown>;
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);

export interface AutoProxyCommitCandidate { dispatchId: string; container: string; resultFile: string }
export interface AutoProxyDiscoveryDeps { readText?: (path: string) => string }
export interface AutoProxyConfigDeps {
  readText?: (path: string) => string;
  load?: (project: string, pmId: string) => { autonomy: { autoProxyCommit: boolean } };
}

/** Read only the explicit opt-in before asking the strict whole-config loader to
 * validate auto-proxy policy. A malformed unrelated config must not silence the
 * standing watch for a project that never enabled this optional mutation. */
export function inspectAutoProxyCommitSetting(
  project: string,
  pmId: string,
  deps: AutoProxyConfigDeps = {},
): { enabled: boolean; error: string | null } {
  const readText = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const setup = join(crewSubdir(project, pmId, "pm"), "setup_config.toml");
  let raw: string;
  try { raw = readText(setup); } catch { return { enabled: false, error: null }; }
  let section = "";
  let optedIn = false;
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.split("#", 1)[0]!.trim();
    const table = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (table) { section = table[1]!; continue; }
    if (section === "autonomy" && /^auto_proxy_commit\s*=\s*true$/.test(line)) optedIn = true;
  }
  if (!optedIn) return { enabled: false, error: null };
  try {
    return { enabled: (deps.load ?? loadConfig)(project, pmId).autonomy.autoProxyCommit, error: null };
  } catch (error) {
    return { enabled: false, error: (error as Error).message };
  }
}

/** Pure discovery for the opt-in proxy loop. The mutating dock_proxy command
 * remains the single validation/commit/resume authority; this scan only
 * selects ready Codex proxy units with both a dirty tree and a complete plan. */
export function findAutoProxyCommitCandidates(
  project: string,
  pmId: string,
  deps: AutoProxyDiscoveryDeps = {},
): AutoProxyCommitCandidate[] {
  const readText = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const crew = resolve(project, "__garelier", pmId, "_crew");
  if (!existsSync(crew)) return [];
  const candidates: AutoProxyCommitCandidate[] = [];
  for (const entry of readdirSync(crew, { withFileTypes: true })) {
    const match = entry.isDirectory() ? /^dispatch(\d+)$/.exec(entry.name) : null;
    if (!match) continue;
    const container = join(crew, entry.name);
    const checkout = join(container, "checkout");
    try {
      const ready = JSON.parse(readText(join(container, "ready.json"))) as Record<string, any>;
      // ready.json is producer-controlled. Admit all four canonical lane paths
      // before reading even one of them; malformed/escaping handoffs are not
      // discovery candidates and cannot become an external read oracle.
      const admitted = admitDockProxyReadyPaths(project, container, ready);
      const session = JSON.parse(readText(admitted.sessionPath)) as Record<string, any>;
      if (ready.commit_mode !== "proxy" || session.status !== "ready" || !existsSync(checkout)) continue;
      const dirty = spawnSync(requireRuntimeExecutable("git"), ["-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"], {
        windowsHide: true, encoding: "utf8",
      });
      if (dirty.status !== 0 || !(dirty.stdout ?? "").trim()) continue;
      const resultFiles = [admitted.initialResultPath, admitted.followupResultPath]
        .filter((path) => existsSync(path) && readText(path).includes("=== COMMIT PLAN ==="));
      if (resultFiles.length === 0) continue;
      candidates.push({ dispatchId: match[1]!, container, resultFile: resultFiles[0]! });
    } catch { /* malformed/incomplete dispatches are left to contract_check */ }
  }
  return candidates.sort((left, right) => Number(left.dispatchId) - Number(right.dispatchId));
}

// ── keys / filter / decide (inlined from the shell's embedded FW_JS) ──────────
function keysOf(d: Json): string[] {
  const ks: string[] = [];
  for (const it of arr(d.idle_no_register)) ks.push("idle:" + it.dispatch);
  for (const u of arr(d.unwatched)) ks.push("unwatched:" + String(u));
  for (const u of arr(d.unprocessed_results)) ks.push("unproc:" + u.request_id);
  return ks;
}
function fpMap(d: Json): Record<string, string> {
  const m: Record<string, string> = {};
  for (const it of arr(d.items)) m[String(it.dispatch)] = `${it.tip_sha ?? ""}|${it.dirty_hash ?? ""}|${it.dirty ?? ""}`;
  return m;
}
function fpOf(key: string, m: Record<string, string>): string {
  const mm = /^(?:idle|unwatched):(.+)$/.exec(key);
  return mm ? (m[mm[1]] ?? "") : "";
}
function loadState(stateFile: string): Record<string, unknown> {
  if (!stateFile || !existsSync(stateFile)) return {};
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    return (s && typeof s === "object") ? s : {};
  } catch { return {}; }
}
function suppressed(state: Record<string, unknown>, k: string, now: number, supp: number): boolean {
  return supp > 0 && typeof state[k] === "number" && (now - (state[k] as number)) < supp;
}

function decide(
  s1: Json | null, s2: Json | null, allowed: string[], stateFile: string, now: number, supp: number,
): string | null {
  if (s1 === null || s2 === null) return null;
  const keys2 = new Set(keysOf(s2));
  const fp1 = fpMap(s1), fp2 = fpMap(s2);
  const state = loadState(stateFile);
  const survivors = allowed.filter((k) => keys2.has(k) && fpOf(k, fp1) === fpOf(k, fp2) && !suppressed(state, k, now, supp));
  if (survivors.length === 0) return null;
  const sset = new Set(survivors);
  for (const k of survivors) state[k] = now;                       // stamp this fire
  for (const k of Object.keys(state)) {                            // drop entries past the window
    if (typeof state[k] !== "number" || (supp > 0 && (now - (state[k] as number)) >= supp)) delete state[k];
  }
  try { if (stateFile) writeFileSync(stateFile, JSON.stringify(state) + "\n"); } catch { /* best effort */ }
  const idle = arr(s2.idle_no_register).filter((it) => sset.has("idle:" + it.dispatch));
  const up = arr(s2.unprocessed_results).filter((u) => sset.has("unproc:" + u.request_id));
  const uw = arr(s2.unwatched_detail).filter((u) => sset.has("unwatched:" + String(u.dispatch)));
  const n = idle.length + up.length + uw.length;
  const resultLine =
    `RESULT: FLEET-ATTENTION — idle_no_register=${idle.length} unprocessed_results=${up.length} unwatched=${uw.length} (計 ${n} 件、confirm 済 = 2 scan 連続 actionable + fingerprint 不変)。` +
    `下記 JSON の各項目は wake_cmd/cleanup_cmd/watch_cmd を持つ — 判断・組み立て不要でそのまま実行 (idle_no_register は ` +
    `SendMessage、unprocessed_results/unwatched は run_in_background で bash 実行) し、処理後に該当 dispatch container の register_received ` +
    `を touch。その後 fleet watch を再 arm してください (W-033、真のゼロトークン driver 注入は DEC-066 の scope 外 — ` +
    `garelier の契約は実行可能な *_cmd を出すところまで)。`;
  const json = JSON.stringify({ attention: n, idle_no_register: idle, unprocessed_results: up, unwatched: uw }, null, 2);
  return resultLine + "\n" + json;
}

// W-179 (c): the command_guard hook writes a `guard_ask` record to incidents.jsonl
// for every ask (W-164 maybeWriteGuardReport). A subagent hitting an ask BLOCKS
// waiting for a user who, on an unattended fleet, is not watching — the 7h ask-storm
// (2026-07-20 03:35-11:00). fleet_watch now treats a RECENT unsurfaced guard_ask as
// FLEET-ATTENTION so the PM is actively woken to resolve it (allow the pattern in the
// project's command_guard_policy.toml, supply/repair the record, or instruct the
// agent), instead of the ask sitting undetected. The telemetry sink (incidents.jsonl
// + dock_status pmAction) already exists; this is the active wake for it.
export interface GuardAskIncident {
  incident_id: string;
  /** Identity for dedupe / already-surfaced bookkeeping. Distinct from
   * `incident_id`, which must stay a real id an operator can look up. */
  occurrence_key: string;
  created_at: string; command: string; cwd: string; agent: string | null; rule: string;
}

export function readGuardAskIncidents(paths: string[]): GuardAskIncident[] {
  const out: GuardAskIncident[] = [];
  const seenId = new Set<string>(); // the same record can appear in >1 incidents.jsonl path
  for (const p of paths) {
    let raw: string;
    try { raw = readFileSync(p, "utf8"); } catch { continue; }
    // The stream records one line per CAUSE, so a recurring ask keeps its FIRST
    // created_at. Recency here is the pending signal, so read the repeat tally's
    // last_at instead, and fold the occurrence count into the identity so a NEW
    // burst of an already-surfaced ask is pending again rather than silently
    // filtered by the seen set. Both were properties of the pre-coalescing stream
    // (a fresh id + timestamp per occurrence) and must survive it.
    const repeats = readIncidentRepeats(dirname(p));
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Json;
        if (j.kind !== "guard_ask" || typeof j.incident_id !== "string") continue;
        const tally = typeof j.repeat_key === "string" ? repeats.get(j.repeat_key) : undefined;
        // Publish a REAL id. The surfaced id must resolve to something an operator
        // can open: the most recent occurrence's id, which the tally keeps, or the
        // stream record's own id when there is no tally. A synthesised id (the
        // earlier `<id>#<count>` form) named no record in any file.
        const incidentId = tally?.last_incident_id || j.incident_id;
        // Dedupe and "already surfaced" are keyed on the OCCURRENCE, not the id, so
        // a fresh burst of an already-surfaced ask is pending again — the property
        // the pre-coalescing stream had for free by minting a new record each time.
        const occurrenceKey = tally ? `${j.repeat_key as string}:${tally.count}` : incidentId;
        if (seenId.has(occurrenceKey)) continue;
        seenId.add(occurrenceKey);
        out.push({
          incident_id: incidentId, occurrence_key: occurrenceKey, created_at: tally?.last_at ?? String(j.created_at ?? ""),
          command: String(j.command ?? ""), cwd: String(j.cwd ?? ""),
          agent: (j.resolved_agent as string) ?? (j.agent_id as string) ?? null, rule: String(j.rule ?? ""),
        });
      } catch { /* skip a malformed line */ }
    }
  }
  return out;
}

/** guard_ask records created within `windowSec` that have not already been surfaced
 * (the seen set) — the PENDING asks a fresh FLEET-ATTENTION should wake on. An ask
 * older than the window is treated as stale/handled (the guard never writes a
 * resolution back, so recency is the pending signal). W-179 (d)(ii): a record with NO
 * created_at cannot be proven stale, so it is surfaced conservatively (fail-to-surface,
 * not fail-to-silence — the earlier form silently dropped a timestamp-less ask). A
 * present-but-garbage timestamp stays excluded (a malformed field is not a signal). */
export function selectPendingGuardAsks(asks: GuardAskIncident[], seen: Set<string>, nowSec: number, windowSec: number): GuardAskIncident[] {
  return asks.filter((a) => guardAskInWindow(a, nowSec, windowSec) && !seen.has(a.occurrence_key));
}

/** True when an ask should be treated as PENDING for the window: a missing created_at
 * (empty/whitespace) is pending (can't prove stale); otherwise it must parse and be
 * younger than the window. Shared by selectPendingGuardAsks (what to surface) and
 * guardAskSeenSet (what to persist) so the two never disagree — W-179 (d)(iii): a
 * surfaced ask MUST be persisted, else it re-fires every fleet_watch invocation. */
function guardAskInWindow(a: GuardAskIncident, nowSec: number, windowSec: number): boolean {
  if (!a.created_at.trim()) return true; // missing timestamp → conservatively pending
  const ts = Math.floor(Date.parse(a.created_at) / 1000);
  return Number.isFinite(ts) && nowSec - ts < windowSec;
}

/** W-179 (d)(iii): the incident ids to persist as "surfaced" after a FLEET-ATTENTION —
 * exactly the asks still inside the window (incl. timestamp-less ones, so a surfaced
 * missing-created_at ask is remembered and fires once, not every invocation). Extracted
 * from the former inline keep-set so the persistence contract is unit-testable and
 * cannot drift from selectPendingGuardAsks. */
export function guardAskSeenSet(asks: GuardAskIncident[], nowSec: number, windowSec: number): string[] {
  return asks.filter((a) => guardAskInWindow(a, nowSec, windowSec)).map((a) => a.occurrence_key);
}

function need(argv: string[], i: number): string {
  const v = argv[i];
  if (v === undefined || v === "") { errw("fleet_watch: missing option value"); process.exit(2); }
  return v;
}
function isPosIntStr(v: string): boolean { return /^[0-9]+$/.test(v); }

function main(): number {
  try { assertOperatorResidentStart("fleet_watch"); }
  catch (error) {
    if (error instanceof ResidentProcessEnvironmentError) {
      errw(error.message);
      return error.exitCode;
    }
    throw error;
  }
  const argv = process.argv.slice(2);
  let PROJECT = "", PM = "", INTERVAL_SEC = "300", MAX_HOURS = "12", MAX_SEC = "", UNWATCHED_AFTER = "";
  // CONFIRM delay: the gap between the two scans whose fingerprints must match
  // before anything fires. It has to outlast how long a HEALTHY lane's fingerprint
  // legitimately holds still, or the confirm confirms nothing.
  //
  // Measured by sampling the same `tip_sha|dirty_hash|dirty` fingerprint every 30s
  // for 39 minutes on a live lane: 32 quiet runs of median 60s and p90 120s, with a
  // maximum of 330s, while the lane was demonstrably working (its fingerprint moved
  // 30 times in the same window). At 60s a lane merely thinking between edits reads
  // as unchanged in BOTH scans and survives the confirm — the guard the operator was
  // relying on was shorter than the pause it was supposed to tolerate.
  //
  // 600s is roughly twice the measured maximum. The margin is deliberate: 330s is
  // the longest quiet stretch SEEN on one lane in one window, which is a lower bound
  // on the longest possible one, not the value itself — an earlier partial read of
  // the same lane put the maximum at 240s. It also lands on the same scale as the
  // spawn/resume grace, which answers the same underlying question ("how long can a
  // healthy role legitimately be quiet"), though the two remain independent
  // quantities: this is a gap between two scans, that is an age since spawn.
  //
  // The only cost is that a genuine stall is ANNOUNCED later; nothing acts on its
  // own either way, and the escalation ladder (nudge 10m / handoff 25m / revive 30m)
  // already works on that timescale.
  let CONFIRM_DELAY_SEC = "600", SUPPRESS_MIN = "15", PM_TRANSCRIPT = "", GUARD_ASK_WINDOW_MIN = "30";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") { PROJECT = need(argv, ++i); }
    else if (a === "--pm-id") { PM = need(argv, ++i); }
    else if (a === "--interval-sec") { INTERVAL_SEC = need(argv, ++i); }
    else if (a === "--max-hours") { MAX_HOURS = need(argv, ++i); }
    else if (a === "--max-sec") { MAX_SEC = need(argv, ++i); }
    else if (a === "--unwatched-after") { UNWATCHED_AFTER = need(argv, ++i); }
    else if (a === "--confirm-delay-sec") { CONFIRM_DELAY_SEC = need(argv, ++i); }
    else if (a === "--suppress-min") { SUPPRESS_MIN = need(argv, ++i); }
    else if (a === "--pm-transcript") { PM_TRANSCRIPT = need(argv, ++i); }
    else if (a === "--guard-ask-window-min") { GUARD_ASK_WINDOW_MIN = need(argv, ++i); }
    else if (a === "-h" || a === "--help") { outw(HELP); return 0; }
    else { errw(`fleet_watch: unknown arg: ${a}`); return 2; }
  }

  if (!PROJECT || !PM) { errw("fleet_watch: --project and --pm-id are required"); return 2; }
  if (!isPosIntStr(INTERVAL_SEC)) { errw("fleet_watch: --interval-sec must be a positive integer"); return 2; }
  if (Number(INTERVAL_SEC) < 1) { errw("fleet_watch: --interval-sec must be >= 1"); return 2; }
  if (!isPosIntStr(CONFIRM_DELAY_SEC)) { errw("fleet_watch: --confirm-delay-sec must be a non-negative integer"); return 2; }
  if (!isPosIntStr(SUPPRESS_MIN)) { errw("fleet_watch: --suppress-min must be a non-negative integer"); return 2; }
  if (!isPosIntStr(GUARD_ASK_WINDOW_MIN)) { errw("fleet_watch: --guard-ask-window-min must be a non-negative integer"); return 2; }
  if (MAX_SEC !== "") {
    if (!isPosIntStr(MAX_SEC)) { errw("fleet_watch: --max-sec must be a positive integer"); return 2; }
    if (Number(MAX_SEC) < 1) { errw("fleet_watch: --max-sec must be >= 1"); return 2; }
  }
  if (!resolveRuntimeExecutable("bun")) { errw("fleet_watch: required Bun executable is unavailable"); return 2; }

  const PM_ROOT = `${PROJECT}/__garelier/${PM}`;
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const CC = process.env.GARELIER_CONTRACT_CHECK_TS || `${selfDir}/../dispatch/contract_check.ts`;
  const maxSecNum = MAX_SEC !== "" ? Number(MAX_SEC) : Number(MAX_HOURS) * 3600;
  const SUPPRESS_SEC = Number(SUPPRESS_MIN) * 60;
  const intervalNum = Number(INTERVAL_SEC);
  const confirmNum = Number(CONFIRM_DELAY_SEC);
  const STOP_FILE = `${PM_ROOT}/runtime/driver/stop`;
  const STATE_FILE = `${PM_ROOT}/runtime/driver/fleet_watch_state.json`;
  const LOCK_DIR = `${PM_ROOT}/runtime/driver`;
  const LOCK = `${LOCK_DIR}/fleet_watch.lock`;
  const LONG_JOBS = longJobRoot(PROJECT, PM);
  // W-179 (c): guard_ask surfacing. The guard hook writes to the pm's runtime/hooks/
  // incidents.jsonl (cwd under __garelier/<pm>, or a uniquely-resolved pm) or, when the
  // pm is ambiguous, the shared __atmos/guard/unresolved/ fallback (W-188). The
  // project-root .claude/ path is legacy (pre-W-188) and is READ so older incidents
  // still surface — nothing writes there any more.
  const GUARD_ASK_WINDOW_SEC = Number(GUARD_ASK_WINDOW_MIN) * 60;
  const GUARD_ASK_SEEN_FILE = `${PM_ROOT}/runtime/driver/guard_ask_seen.json`;
  const GUARD_ASK_INCIDENT_PATHS = [
    `${PM_ROOT}/runtime/hooks/incidents.jsonl`,
    `${PROJECT}/__garelier/__atmos/guard/unresolved/incidents.jsonl`,
    `${PROJECT}/.claude/runtime/garelier/incidents.jsonl`,
  ];

  const OWNER_PID = String(process.pid);
  const START = epoch();

  const readLockPid = (): string => {
    try { return readFileSync(LOCK, "utf8").match(/"pid":\s*([0-9]+)/)?.[1] ?? ""; } catch { return ""; }
  };
  const writeLock = (): void => {
    try {
      mkdirSync(LOCK_DIR, { recursive: true });
      writeFileSync(LOCK, `{"pid":${OWNER_PID},"host_pid":${OWNER_PID},"owner":"operator","provenance":"operator-owned","started":${START},"last_poll":${epoch()},"interval_sec":${intervalNum}}\n`);
    } catch { /* best effort */ }
  };
  const releaseLock = (): void => {
    try { if (readLockPid() === OWNER_PID) rmSync(LOCK, { force: true }); } catch { /* best effort */ }
  };
  // Mirror the shell's `trap release_lock EXIT INT TERM`: never yank a lock a
  // reclaimer took (releaseLock is ownership-checked, so exit-3 is safe too).
  process.on("exit", releaseLock);

  // Multi-launch guard: refuse while a live owner holds the lock; reclaim a stale one.
  if (existsSync(LOCK)) {
    const existing = readLockPid();
    if (existing && pidAlive(existing)) {
      errw(`fleet_watch: already running for pm '${PM}' (owner pid ${existing}). Stop it first, or wait for its RESULT.`);
      return 3;
    }
    errw(`fleet_watch: reclaiming stale lock (owner pid ${existing || "?"} not alive)`);
    try { rmSync(LOCK, { force: true }); } catch { /* best effort */ }
  }
  writeLock();

  const runScan = (): Json | null => {
    const args = ["--pm-id", PM, "--project", PROJECT, "--stall-scan", "--format", "json"];
    if (UNWATCHED_AFTER) { args.push("--unwatched-after", UNWATCHED_AFTER); }
    const r = spawnSync(requireRuntimeExecutable("bun"), [CC, ...args], { windowsHide: true, encoding: "utf8" });
    try { return JSON.parse(r.stdout ?? "") as Json; } catch { return null; }
  };

  const stopNow = (): never => {
    outw(`RESULT: FLEET-STOP — driver stop file present (${STOP_FILE}); fleet watch exiting (re-arm after clearing stop).`);
    process.exit(0);
  };

  // W-097 self/PM face: the external malformed-tool-call watcher. A jammed PM
  // CANNOT self-report (the broken party is the one that would raise the alarm), so
  // the ONLY model-independent path is an OUTSIDE process tailing the PM's own
  // session JSONL transcript for the signature. Opt-in via --pm-transcript; off by
  // default (byte-identical to the pre-W-097 loop when absent). On a malformed
  // LATEST assistant turn it exits with a FLEET-ATTENTION carrying the self-recovery
  // nudge. HONEST LIMIT: this surfaces the jam, but delivery still waits on the PM's
  // harness re-invoking it (a fully-jammed turn is not interrupted mid-flight) — the
  // "気づける主体が壊れている" double problem the row names. A completed malformed turn
  // is stable in the JSONL (lines are appended after a turn ends), so a single read
  // is genuine, not a mid-turn partial; a recovered turn clears it (latest-turn rule).
  const pmMalformedResult = (): string | null => {
    if (!PM_TRANSCRIPT || !existsSync(PM_TRANSCRIPT)) return null;
    let raw: string;
    try { raw = readFileSync(PM_TRANSCRIPT, "utf8"); } catch { return null; }
    const finding = scanTranscriptForMalformed(raw);
    if (!finding.detected) return null;
    const line =
      `RESULT: FLEET-ATTENTION — malformed_self=1: the PM's own ${finding.detail}. The broken party cannot ` +
      `self-report, so this external watcher surfaces it. Next PM turn: ${MALFORMED_PM_NUDGE}`;
    const json = JSON.stringify(
      { attention: 1, malformed_self: [{ transcript: PM_TRANSCRIPT, detail: finding.detail, nudge: MALFORMED_PM_NUDGE }] },
      null, 2,
    );
    return line + "\n" + json;
  };

  const pendingLongJobsResult = (): string | null => {
    const actions = recoverLongJobs(LONG_JOBS);
    if (actions.length === 0) return null;
    const wake = coalesceCompletionWake(LONG_JOBS);
    return `RESULT: LONG-JOBS-PENDING — ${actions.length} durable item(s); drain FINISHED attempts, start the broker for ARMED work, or audit and rearm each failed/stale whole command.\n` +
      JSON.stringify({ attention: actions.length, long_jobs: actions, wake }, null, 2);
  };

  // W-179 (c): surface a RECENT unresolved command_guard ask (a subagent blocked
  // waiting for a user who is not watching — the 7h ask-storm). A seen-set persists
  // surfaced ask ids (pruned to the window) so each ask wakes the PM exactly once.
  const guardAsksResult = (): string | null => {
    const asks = readGuardAskIncidents(GUARD_ASK_INCIDENT_PATHS);
    if (asks.length === 0) return null;
    const seen = new Set<string>(((): string[] => {
      try { const s = JSON.parse(readFileSync(GUARD_ASK_SEEN_FILE, "utf8")); return Array.isArray(s) ? s.map(String) : []; } catch { return []; }
    })());
    const now = epoch();
    const pending = selectPendingGuardAsks(asks, seen, now, GUARD_ASK_WINDOW_SEC);
    if (pending.length === 0) return null;
    // Persist the surfaced ids (only those still inside the window, so the file stays
    // small and an ask that recurs after the window can re-fire). W-179 (d)(iii): the
    // shared guardAskSeenSet keeps this in lockstep with selectPendingGuardAsks, so a
    // just-surfaced ask (incl. a timestamp-less one) is remembered and fires once.
    const keep = guardAskSeenSet(asks, now, GUARD_ASK_WINDOW_SEC);
    try { mkdirSync(LOCK_DIR, { recursive: true }); writeFileSync(GUARD_ASK_SEEN_FILE, JSON.stringify(keep) + "\n"); } catch { /* best effort */ }
    const line =
      `RESULT: FLEET-ATTENTION — guard_ask_pending=${pending.length}: subagent(s) are BLOCKED on a command_guard ask ` +
      `with no PM in the loop (the 7h ask-storm class, 2026-07-20). Review each and resolve: allow the pattern in the ` +
      `project's command_guard_policy.toml, supply/repair the dispatch record, or instruct the agent — then the seat proceeds. ` +
      `The same records are in incidents.jsonl / dock_status pmAction (W-164).`;
    const json = JSON.stringify({
      attention: pending.length,
      guard_ask_pending: pending.map((a) => ({ incident_id: a.incident_id, command: a.command, cwd: a.cwd, agent: a.agent, rule: a.rule, created_at: a.created_at })),
    }, null, 2);
    return line + "\n" + json;
  };

  const autoProxyCommitResult = (): string | null => {
    const setting = inspectAutoProxyCommitSetting(PROJECT, PM);
    if (setting.error !== null) {
      return `RESULT: FLEET-ATTENTION — auto_proxy_commit config invalid: ${setting.error}`;
    }
    if (!setting.enabled) return null;
    const dockProxy = resolve(selfDir, "dock_proxy.ts");
    for (const candidate of findAutoProxyCommitCandidates(PROJECT, PM)) {
      const result = spawnSync(requireRuntimeExecutable("bun"), [
        dockProxy, "--project", PROJECT, "--pm-id", PM, "--dispatch-id", candidate.dispatchId,
      ], { windowsHide: true, encoding: "utf8" });
      if (result.status !== 0) {
        return `RESULT: FLEET-ATTENTION — auto_proxy_commit dispatch #${candidate.dispatchId} refused (exit=${result.status ?? 1}): ${(result.stderr || result.stdout || "").trim()}`;
      }
      outw(`fleet_watch: auto_proxy_commit completed dispatch #${candidate.dispatchId}`);
    }
    return null;
  };

  outw(`fleet_watch: pm=${PM} interval=${intervalNum}s max=${maxSecNum}s confirm=${confirmNum}s suppress=${Number(SUPPRESS_MIN)}min${PM_TRANSCRIPT ? ` pm_transcript=on` : ""} (standing stall watch — delegates classification to contract_check --stall-scan)`);
  errw("fleet_watch: launch me under the harness run_in_background, NEVER a shell '&' — a '&' job is untracked so my FLEET-ATTENTION exit never wakes the PM and the watch net goes silent (2026-07-07).");

  let cycle = 0;
  for (;;) {
    cycle++;
    if (existsSync(STOP_FILE)) stopNow();

    const autoProxy = autoProxyCommitResult();
    if (autoProxy !== null) { process.stdout.write(autoProxy + "\n"); return 0; }

    // Durable long-job completion/recovery has priority over ordinary stall
    // classification. This is also the PM/Dock session-resume scan: a FINISHED
    // but unacknowledged attempt wakes without re-running the command, while a
    // stale RUNNING attempt is surfaced for explicit whole-command recovery.
    const pendingLongJobs = pendingLongJobsResult();
    if (pendingLongJobs !== null) { process.stdout.write(pendingLongJobs + "\n"); return 0; }

    // W-097: a jammed PM is the most urgent finding — check it before the stall scan.
    const pmMalformed = pmMalformedResult();
    if (pmMalformed !== null) { process.stdout.write(pmMalformed + "\n"); return 0; }

    // W-179 (c): a subagent blocked on a guard ask — wake the PM to resolve it.
    const guardAsks = guardAsksResult();
    if (guardAsks !== null) { process.stdout.write(guardAsks + "\n"); return 0; }

    let note = "";
    const scan1 = runScan();
    let krc: 0 | 1 | 2;
    let keys1: string[] = [];
    if (scan1 === null) { krc = 2; }
    else { keys1 = keysOf(scan1); krc = keys1.length === 0 ? 1 : 0; }

    if (krc === 2) {
      errw("fleet_watch: scan output unreadable this cycle (keys rc=2) — skipping, will retry");
    } else if (krc === 0) {
      const state = loadState(STATE_FILE);
      const now1 = epoch();
      const allowed = keys1.filter((k) => !suppressed(state, k, now1, SUPPRESS_SEC));
      if (allowed.length === 0) {
        note = `actionable だが全 key が suppression window 内 (${Number(SUPPRESS_MIN)}min) — skip`;
      } else {
        const kcount = allowed.length;
        outw(`fleet_watch: actionable detected (${kcount} key) — ${confirmNum}s 後に再確認して発火判定 (W-029 confirm)`);
        if (existsSync(STOP_FILE)) stopNow();
        if (confirmNum > 0) sleepSec(confirmNum);
        if (existsSync(STOP_FILE)) stopNow();
        const scan2 = runScan();
        const out = decide(scan1, scan2, allowed, STATE_FILE, epoch(), SUPPRESS_SEC);
        if (out !== null) {
          process.stdout.write(out + "\n");
          return 0; // FIRE — confirmed actionable over two scans
        }
        note = "confirm で settle/変化 (race) — 発火せず継続";
      }
    }

    writeLock(); // refresh last_poll
    const now = epoch();
    const elapsed = now - START;
    if (note) {
      outw(`poll ${cycle} (~${elapsed}s): ${note} — next in ${intervalNum}s`);
    } else {
      outw(`poll ${cycle} (~${elapsed}s): clear (idle_no_register / unprocessed_results / unwatched すべて 0) — next in ${intervalNum}s`);
    }

    if (elapsed >= maxSecNum) {
      outw(`RESULT: FLEET-CLEAR — watched ${elapsed}s (safety cap ${maxSecNum}s) with nothing actionable; re-arm the fleet watch to keep watching.`);
      return 0;
    }
    sleepSec(intervalNum);
  }
}

export { keysOf, fpMap, fpOf, suppressed, decide, loadState };

if (import.meta.main) process.exit(main());
