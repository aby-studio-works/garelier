#!/usr/bin/env bun
// TS-first port of scripts/fleet_watch.sh (W-028 / W-029 / W-033 / W-083).
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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scanTranscriptForMalformed, MALFORMED_PM_NUDGE } from "./malformed_detect.ts";

const outw = (s: string) => process.stdout.write(s + "\n");
const errw = (s: string) => process.stderr.write(s + "\n");

// Lines 2-89 of the original fleet_watch.sh (what `sed -n '2,89p' "$0"` printed).
const HELP = "#\n# fleet_watch.sh — the STANDING fleet stall watch (W-028). A permanent loop that\n# closes the three STRUCTURAL causes of an unattended stall (the \"stalled 5×/day\"\n# root-cause analysis, user 2026-07-07):\n#   1. a sub-agent is run-to-completion — after its turn ends it is NOT re-invoked\n#      until an external message arrives (no self-continuation), so a producer that\n#      went idle/REPORTING-without-register waits silently until someone asks;\n#   2. dispatch_watch.sh is a SINGLE finite run — after its --windows expire (or\n#      its --fleet --max-run window ends) it EXITS and, unless re-armed, nothing\n#      watches the fleet at all (the overnight failure, 2026-07-06); and\n#   3. the scan → wake step was a MANUAL PM chore no timer enforced.\n#\n# The fix is one standing loop per pm-id that periodically runs the detective\n# (`contract_check.ts --stall-scan`) and, the moment it finds ACTIONABLE work,\n# prints a single `RESULT: FLEET-ATTENTION` line + the detection JSON (wake_cmd\n# included) and EXITS 0 — which re-invokes the operator (the PM is woken by the\n# run_in_background completion notification). The PM runs the wake_cmd(s), then\n# re-arms this watch. When nothing is actionable it sleeps and loops again, so it\n# NEVER becomes unmonitored by expiry (cause #2): the ONLY exits are an actionable\n# finding, the driver stop file, or a `--max-hours` safety cap (re-arm after each).\n#\n# RELATION TO dispatch_watch.sh (W-071 --fleet). No third watchdog — different job:\n#   - dispatch_watch --fleet is a FINITE dormancy sweep with its OWN git-fingerprint\n#     progress logic + a --max-run window; it EXITS HEALTHY after the window even\n#     with nothing wrong, and must be re-armed to keep watching (cause #2 for it).\n#   - fleet_watch is a PERMANENT loop that owns NO stall logic of its own: it\n#     delegates 100% of the classification (build-wait vs genuine stall, ungated\n#     REPORTING, idle-no-register, unprocessed result, unwatched) to the single\n#     anomaly taxonomy in contract_check.ts --stall-scan. Misfire suppression is\n#     therefore fully the scan's job — build-wait / unknown NEVER reach the\n#     actionable set (they are excluded upstream, W-018 / W-053), so this loop\n#     cannot false-wake a healthy cold build. The two compose: arm a per-producer\n#     dispatch_watch (single mode) for a HEAVY producer's close RUNAWAY-compensated\n#     window; keep ONE fleet_watch standing as the net that catches a watch that\n#     was forgotten or expired (surfaced here as `unwatched`).\n#\n# ACTIONABLE = any of the three --stall-scan arrays is non-empty:\n#   - idle_no_register  (W-018) — an idle dispatch with no processed register:\n#       REPORTING-done-but-unregistered, a genuinely stalled WORKING, or a gate\n#       role whose verdict never arrived. Each carries a ready-to-send wake_cmd.\n#   - unprocessed_results (W-086) — a landed merge whose workbench branch was never\n#       cleaned up (a forgotten result waiter left the aftercare stalled).\n#   - unwatched (W-085) — a WORKING dispatch with NO live dispatch_watch heartbeat\n#       (never armed, or its single watch EXPIRED and went stale — exactly cause #2).\n# Advisory detectives only — this loop never invents a verdict; it relays the\n# scan's. session_resume / unconsumed_instructions are reported by --stall-scan in\n# its own output but are not part of THIS loop's exit trigger (kept to the three\n# the wake protocol acts on).\n#\n# WAKE-SPAM SUPPRESSION (W-029). A single --stall-scan is a point-in-time probe, so\n# it flaps against two producer races (day-one field data: of 5 wakes only 1 was a\n# real stall): (a) a heavy producer whose build process is momentarily between\n# invocations reads as procs=0 → a build-wait misfires as a stall; (b) a producer\n# actively editing (its dirty tree still growing) reads as an idle stall-suspect.\n# Three guards close them, ALL owned by THIS loop (contract_check stays a stateless\n# single-shot detective — the temporal \"compare two scans\" belongs here):\n#   1. CONFIRM (--confirm-delay-sec, default 60). An actionable finding does NOT\n#      fire immediately; the loop waits the delay, RE-scans, and fires only for the\n#      dispatches STILL actionable AND whose fingerprint is unchanged. A build-wait\n#      that flickered procs=0 is gone from the confirm scan (procs>0 again → not in\n#      idle_no_register) so it drops — the \"2 回とも procs=0 の時だけ\" rule.\n#   2. FINGERPRINT = the scan's own items[].tip_sha + dirty_hash (+ dirty) for the\n#      dispatch. If it MOVED between the two scans the producer made progress (a new\n#      commit, or the dirty tree grew = still editing) → NOT a stall → dropped. This\n#      is the \"dirty 増加は進行中扱い\" rule, keyed on data --stall-scan already emits.\n#   3. SUPPRESSION WINDOW (--suppress-min, default 15). After a dispatch fires, its\n#      key is stamped in runtime/driver/fleet_watch_state.json; for the next window\n#      the loop will not re-flag it (the manual \"I already woke that one\" judgement,\n#      mechanized). Keys are pruned once past the window so the file stays small.\n# unprocessed_results carry no checkout fingerprint (a landed-merge structural fact,\n# not a flapping probe); they confirm on presence-in-both-scans + the window alone.\n#\n# MULTI-LAUNCH GUARD. runtime/driver/fleet_watch.lock holds the owner pid; a second\n# launch refuses (exit 3) while the owner is alive, and RECLAIMS a stale lock whose\n# owner pid is dead (W-024 liveness rule). The pid stored is the WINDOWS-checkable\n# winpid (Git-Bash `/proc/$$/winpid`, falling back to `$$` on native Linux/macOS)\n# so the liveness probe works on Windows too.\n#\n# Usage:\n#   fleet_watch.sh --project <root> --pm-id <id>\n#                  [--interval-sec N] [--max-hours H] [--unwatched-after MIN]\n#                  [--confirm-delay-sec D] [--suppress-min M]\n#                  [--pm-transcript <jsonl>]   (W-097 self face: tail the PM's own\n#                     session transcript for a malformed tool call; off by default)\n#                  [--max-sec S]   (precise/test override of --max-hours)\n# Defaults: --interval-sec 300  --max-hours 12  --confirm-delay-sec 60\n#           --suppress-min 15. --unwatched-after is passed through to contract_check\n# (its default 60 min applies when omitted). Always exits 0 on a RESULT line\n# (FLEET-ATTENTION / FLEET-CLEAR / FLEET-STOP); exit 2 = arg error;\n# exit 3 = a live fleet_watch already owns the lock.";

const isWindows = process.platform === "win32";
function pidAlive(pid: string): boolean {
  if (!pid) return false;
  if (isWindows) {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8" });
    return new RegExp(`\\b${pid}\\b`).test(r.stdout ?? "");
  }
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function epoch(): number { return Math.floor(Date.now() / 1000); }
function sleepSec(sec: number): void { if (sec > 0) Bun.sleepSync(sec * 1000); }

type Json = Record<string, unknown>;
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);

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

function need(argv: string[], i: number): string {
  const v = argv[i];
  if (v === undefined || v === "") { errw("fleet_watch: missing option value"); process.exit(2); }
  return v;
}
function isPosIntStr(v: string): boolean { return /^[0-9]+$/.test(v); }

function main(): number {
  const argv = process.argv.slice(2);
  let PROJECT = "", PM = "", INTERVAL_SEC = "300", MAX_HOURS = "12", MAX_SEC = "", UNWATCHED_AFTER = "";
  let CONFIRM_DELAY_SEC = "60", SUPPRESS_MIN = "15", PM_TRANSCRIPT = "";

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
    else if (a === "-h" || a === "--help") { outw(HELP); return 0; }
    else { errw(`fleet_watch: unknown arg: ${a}`); return 2; }
  }

  if (!PROJECT || !PM) { errw("fleet_watch: --project and --pm-id are required"); return 2; }
  if (!isPosIntStr(INTERVAL_SEC)) { errw("fleet_watch: --interval-sec must be a positive integer"); return 2; }
  if (Number(INTERVAL_SEC) < 1) { errw("fleet_watch: --interval-sec must be >= 1"); return 2; }
  if (!isPosIntStr(CONFIRM_DELAY_SEC)) { errw("fleet_watch: --confirm-delay-sec must be a non-negative integer"); return 2; }
  if (!isPosIntStr(SUPPRESS_MIN)) { errw("fleet_watch: --suppress-min must be a non-negative integer"); return 2; }
  if (MAX_SEC !== "") {
    if (!isPosIntStr(MAX_SEC)) { errw("fleet_watch: --max-sec must be a positive integer"); return 2; }
    if (Number(MAX_SEC) < 1) { errw("fleet_watch: --max-sec must be >= 1"); return 2; }
  }
  if (!Bun.which("bun")) { errw("fleet_watch: 'bun' not found on PATH"); return 2; }

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

  const OWNER_PID = String(process.pid);
  const START = epoch();

  const readLockPid = (): string => {
    try { return readFileSync(LOCK, "utf8").match(/"pid":\s*([0-9]+)/)?.[1] ?? ""; } catch { return ""; }
  };
  const writeLock = (): void => {
    try {
      mkdirSync(LOCK_DIR, { recursive: true });
      writeFileSync(LOCK, `{"pid":${OWNER_PID},"host_pid":${OWNER_PID},"started":${START},"last_poll":${epoch()},"interval_sec":${intervalNum}}\n`);
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
    const r = spawnSync("bun", [CC, ...args], { encoding: "utf8" });
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

  outw(`fleet_watch: pm=${PM} interval=${intervalNum}s max=${maxSecNum}s confirm=${confirmNum}s suppress=${Number(SUPPRESS_MIN)}min${PM_TRANSCRIPT ? ` pm_transcript=on` : ""} (standing stall watch — delegates classification to contract_check --stall-scan)`);
  errw("fleet_watch: launch me under the harness run_in_background, NEVER a shell '&' — a '&' job is untracked so my FLEET-ATTENTION exit never wakes the PM and the watch net goes silent (2026-07-07).");

  let cycle = 0;
  for (;;) {
    cycle++;
    if (existsSync(STOP_FILE)) stopNow();

    // W-097: a jammed PM is the most urgent finding — check it before the stall scan.
    const pmMalformed = pmMalformedResult();
    if (pmMalformed !== null) { process.stdout.write(pmMalformed + "\n"); return 0; }

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
