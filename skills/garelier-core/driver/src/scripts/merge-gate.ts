// Garelier Merge Gate (TS, W-083) — faithful port of merge-gate.sh v2.2 (DEC-007).
//
// Mechanical merge + quality gate executor. Runs a workbench/anvil -> studio
// merge, an OPTIONAL lightweight preflight step (W-023), and the post-merge
// quality gate, as a background subprocess spawned by the driver. NO LLM call.
//
// Invoked with one argument: the path to a request JSON. Reads the request,
// runs the merge gate, writes a result JSON. This is the runtime the
// merge-gate.sh shim exec's; all CLI/stdout/exit/result-file behavior is frozen
// to the bash original (W-083 §3). Sibling driver CLIs (policy checks, prune,
// dock_merge poll, heavy_compile_lock, task_mirror) are invoked exactly as the
// bash did; the request parse + trusted-target-root reuse merge_gate_parse.ts.
//
// Transient-retry (W-029), data-only fast path (W-031), Observer/Guardian/refuter
// gates (DEC-019/024/W-066), W-054 landed-check, W-076 active-lock ownership +
// completed_externally + second-runner exclusion, W-077 primary-escape self-heal:
// all preserved 1:1.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { buildRecords, resolveTrustedTargetRoot } from "../merge_gate_parse.ts";
import { w054LandedOutcome } from "./merge_gate_landed.ts";
import { gateTimeoutNote, runGateCommand } from "./gate_command.ts";

// ── path anchors ────────────────────────────────────────────────────────────
const moduleDir = dirname(fileURLToPath(import.meta.url));
const DRIVER_SRC = resolve(moduleDir, "..").replace(/\\/g, "/"); // driver/src
const SCRIPTS_DIR = (process.env.GARELIER_SCRIPT_SHIM_DIR || resolve(moduleDir, "../../../scripts")).replace(/\\/g, "/");

// ── hardening (mirror: GIT_TERMINAL_PROMPT, exec </dev/null, gate-commit marker,
//    RUSTC wrapper unset) ───────────────────────────────────────────────────
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GARELIER_MERGE_GATE_COMMIT = "1";
delete process.env.RUSTC_WRAPPER;
delete process.env.RUSTC_WORKSPACE_WRAPPER;

// ── small process helpers ───────────────────────────────────────────────────
interface Cmd { code: number; stdout: string; stderr: string }

function runSync(command: string[], cwd?: string): Cmd {
  const c = Bun.spawnSync(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: c.exitCode, stdout: c.stdout?.toString() ?? "", stderr: c.stderr?.toString() ?? "" };
}

function bunEval(script: string, ...args: string[]): string {
  const c = Bun.spawnSync(["bun", "-e", script, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return c.exitCode === 0 ? (c.stdout?.toString() ?? "") : "";
}

function nulList(out: string): string[] {
  return out.split("\0").map((s) => s).filter((s) => s.length > 0);
}

function errln(s: string): void { process.stderr.write(s.endsWith("\n") ? s : s + "\n"); }
function fatal(msg: string, code = 2): never { errln(msg); process.exit(code); }

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let REQUEST_JSON = argv[0] ?? "";
if (!REQUEST_JSON || !existsSync(REQUEST_JSON) || !statSync(REQUEST_JSON).isFile()) {
  fatal("Error: usage: merge-gate.sh <request_json_path>");
}
REQUEST_JSON = resolve(REQUEST_JSON).replace(/\\/g, "/");

// ── parse request (reuse merge_gate_parse.ts's buildRecords) ─────────────────
const REQUEST_DIR = dirname(REQUEST_JSON).replace(/\\/g, "/");
const REQUEST_FILE = REQUEST_JSON.slice(REQUEST_DIR.length + 1);
const PROJECT_ROOT_FOR_PARSE = resolve(REQUEST_DIR, "../../../../..").replace(/\\/g, "/");

let req: Record<string, unknown>;
try {
  req = JSON.parse(readFileSync(REQUEST_JSON, "utf8")) as Record<string, unknown>;
} catch {
  fatal("Error: failed to parse request JSON via bun");
}

const TARGET_ROOT_FOR_GIT_RAW = resolveTrustedTargetRoot((req as Record<string, unknown>).target_root, PROJECT_ROOT_FOR_PARSE);
const TARGET_ROOT_FOR_GIT = (TARGET_ROOT_FOR_GIT_RAW || PROJECT_ROOT_FOR_PARSE).replace(/\\/g, "/");

// readReport resolves a relative observer/guardian report path against the
// control root (as merge_gate_parse.ts main does); headSha/treeHash run git in
// the trusted target root.
const readReport = (p: string): string | null => {
  try {
    const abs = (p.match(/^([A-Za-z]:[\\/]|[\\/])/) ? p : resolve(PROJECT_ROOT_FOR_PARSE, p));
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};
const headShaResolver = (ref: string): string | null => {
  const r = runSync(["git", "rev-parse", "--verify", `${ref}^{commit}`], TARGET_ROOT_FOR_GIT);
  return r.code === 0 ? r.stdout.trim() : null;
};
const treeHashResolver = (ref: string): string | null => {
  const r = runSync(["git", "rev-parse", "--verify", `${ref}^{tree}`], TARGET_ROOT_FOR_GIT);
  return r.code === 0 ? r.stdout.trim() : null;
};

let MG_FIELDS: string[];
try {
  MG_FIELDS = buildRecords(req, readReport, headShaResolver, treeHashResolver);
} catch (e) {
  // buildRecords throws the same messages the bash surfaced ("request JSON
  // missing required fields ...", "request JSON has no quality_gate_commands").
  fatal(`Error: ${(e as Error).message}`);
}
if (MG_FIELDS.length < 16) fatal("Error: request JSON parse produced too few fields (missing required keys?)");

const REQUEST_ID = MG_FIELDS[0];
const WORKBENCH_BRANCH = MG_FIELDS[1];
const STUDIO_BRANCH = MG_FIELDS[2];
const MERGE_MESSAGE = MG_FIELDS[3];
const PRE_MERGE_BASE_TRACKING = MG_FIELDS[4];
let CMD_TIMEOUT_MINUTES = parseInt(MG_FIELDS[5], 10);
if (!Number.isFinite(CMD_TIMEOUT_MINUTES) || MG_FIELDS[5] === "") CMD_TIMEOUT_MINUTES = 120;
let OBSERVER_GATE_FAIL = MG_FIELDS[6];
const HAS_PASSING_VERDICT = MG_FIELDS[7];
let GUARDIAN_GATE_FAIL = MG_FIELDS[8];
const HAS_PASSING_GUARDIAN_VERDICT = MG_FIELDS[9];
const GUARDIAN_VERDICT_BOUND_BY = MG_FIELDS[10];
const OBSERVER_VERDICT_BOUND_BY = MG_FIELDS[11];
const REFUTER_GATE_FAIL = MG_FIELDS[12];
const REFUTER_VERDICT = MG_FIELDS[13];
let PREFLIGHT_COMMAND_COUNT = /^[0-9]+$/.test(MG_FIELDS[14]) ? parseInt(MG_FIELDS[14], 10) : 0;
const PREFLIGHT_COMMANDS: string[] = PREFLIGHT_COMMAND_COUNT > 0 ? MG_FIELDS.slice(15, 15 + PREFLIGHT_COMMAND_COUNT) : [];
const QUALITY_GATE_COMMANDS: string[] = MG_FIELDS.slice(15 + PREFLIGHT_COMMAND_COUNT);

// pm_id = 3rd segment of garelier/<slug>/<pm_id>/studio.
const pmIdOf = (studioBranch: string): string => (studioBranch.split("/")[2] ?? "");

// ── Observer-policy backstop (DEC-019) ──────────────────────────────────────
if (!OBSERVER_GATE_FAIL) {
  const POLICY_TS = `${DRIVER_SRC}/observer_policy_check.ts`;
  const pm = pmIdOf(STUDIO_BRANCH);
  const cfg = `${PROJECT_ROOT_FOR_PARSE}/__garelier/${pm}/_pm/setup_config.toml`;
  if (existsSync(POLICY_TS) && pm && existsSync(cfg)) {
    OBSERVER_GATE_FAIL = runSync(["bun", POLICY_TS, cfg, TARGET_ROOT_FOR_GIT, STUDIO_BRANCH, WORKBENCH_BRANCH, HAS_PASSING_VERDICT]).stdout.trim();
  }
}
// ── Guardian-policy backstop (DEC-024) ──────────────────────────────────────
if (!GUARDIAN_GATE_FAIL) {
  const POLICY_TS = `${DRIVER_SRC}/guardian_policy_check.ts`;
  const pm = pmIdOf(STUDIO_BRANCH);
  const cfg = `${PROJECT_ROOT_FOR_PARSE}/__garelier/${pm}/_pm/setup_config.toml`;
  if (existsSync(POLICY_TS) && pm && existsSync(cfg)) {
    GUARDIAN_GATE_FAIL = runSync(["bun", POLICY_TS, cfg, TARGET_ROOT_FOR_GIT, STUDIO_BRANCH, WORKBENCH_BRANCH, HAS_PASSING_GUARDIAN_VERDICT]).stdout.trim();
  }
}

// ── Transient-retry policy (W-029) ──────────────────────────────────────────
let TRANSIENT_RETRY_ENABLED = "false";
{
  const pm = pmIdOf(STUDIO_BRANCH);
  const cfg = `${PROJECT_ROOT_FOR_PARSE}/__garelier/${pm}/_pm/setup_config.toml`;
  if (pm && existsSync(cfg)) {
    const out = bunEval('const c=require(process.argv[1]);process.stdout.write((c.merge_gate&&c.merge_gate.transient_retry===true)?"true":"false");', cfg);
    TRANSIENT_RETRY_ENABLED = out || "false";
  }
}

// ── Data-only fast-path config (W-031) ──────────────────────────────────────
let GATE_MODE = "full";
let DATA_ONLY_FILE_COUNT = 0;
let DATA_ONLY_PATHS: string[] = [];
let DATA_ONLY_COMMANDS: string[] = [];
{
  const pm = pmIdOf(STUDIO_BRANCH);
  const cfg = `${PROJECT_ROOT_FOR_PARSE}/__garelier/${pm}/_pm/setup_config.toml`;
  if (pm && existsSync(cfg)) {
    DATA_ONLY_PATHS = nulList(bunEval('const c=require(process.argv[1]);const a=(c.merge_gate&&Array.isArray(c.merge_gate.data_only_paths))?c.merge_gate.data_only_paths:[];for(const x of a){if(typeof x==="string"&&x.trim())process.stdout.write(x+"\\0")}', cfg));
    DATA_ONLY_COMMANDS = nulList(bunEval('const c=require(process.argv[1]);const a=(c.merge_gate&&Array.isArray(c.merge_gate.data_only_commands))?c.merge_gate.data_only_commands:[];for(const x of a){if(typeof x==="string"&&x.trim())process.stdout.write(x+"\\0")}', cfg));
  }
}

if (!REQUEST_ID || !WORKBENCH_BRANCH || !STUDIO_BRANCH) {
  fatal("Error: request JSON missing required fields (request_id / workbench_branch / studio_branch)");
}
if (QUALITY_GATE_COMMANDS.length === 0) fatal("Error: request JSON has no quality_gate_commands");

// ── result + log paths ──────────────────────────────────────────────────────
const MERGE_GATE_ROOT = resolve(REQUEST_DIR, "..").replace(/\\/g, "/");
const RESULT_DIR = `${MERGE_GATE_ROOT}/results`;
const LOG_DIR = `${MERGE_GATE_ROOT}/logs`;
const LOCK_DIR = `${MERGE_GATE_ROOT}/locks`;
const ARCHIVE_DIR = `${MERGE_GATE_ROOT}/archive`;
for (const d of [RESULT_DIR, LOG_DIR, LOCK_DIR, ARCHIVE_DIR]) mkdirSync(d, { recursive: true });

const STEM = REQUEST_FILE.replace(/\.json$/, "");
const RESULT_TMP = `${RESULT_DIR}/${STEM}.json.tmp`;
const RESULT_FINAL = `${RESULT_DIR}/${STEM}.json`;
const SUMMARY_TMP = `${RESULT_DIR}/${STEM}.summary.json.tmp`;
const SUMMARY_FINAL = `${RESULT_DIR}/${STEM}.summary.json`;
const LOG_FILE = `${LOG_DIR}/${STEM}.log`;

// ── project/target roots + cwd ──────────────────────────────────────────────
const PROJECT_ROOT = resolve(REQUEST_DIR, "../../../../..").replace(/\\/g, "/");
const TARGET_ROOT = TARGET_ROOT_FOR_GIT; // trusted, absolute, existing
// All git runs with cwd=TARGET_ROOT (mirror of `cd "$TARGET_ROOT"`).
function git(args: string[]): Cmd { return runSync(["git", ...args], TARGET_ROOT); }
// git that logs combined output to LOG_FILE and returns success bool.
function gitLogged(args: string[]): boolean {
  const r = git(args);
  appendLog(r.stdout + r.stderr);
  return r.code === 0;
}

const isoNow = (): string => new Date().toISOString();
const STARTED_AT = isoNow();
const STARTED_EPOCH = Math.floor(Date.now() / 1000);

// ── mutable gate state ──────────────────────────────────────────────────────
let PREFLIGHT_STEPS_JSON = "";
let PREFLIGHT_STEPS_SUMMARY_JSON = "";
let GATE_STEPS_JSON = "";
let GATE_STEPS_SUMMARY_JSON = "";
let FAILURE_REASON = "";
let STATUS = "";
let PRE_MERGE_TARGET_ADVANCED = "false";
let TRANSIENT_RETRY_JSON = "";
let REFUTER_WARNING = "";
let COMPLETED_EXTERNALLY = "";
let mgTeardown = false;

const MG_PM_ID = pmIdOf(STUDIO_BRANCH);

// W-076: task_mirror anchor hint (SUCCESS result only).
let TASK_MIRROR_HINT = "";
if (MG_PM_ID) {
  TASK_MIRROR_HINT = `bun ${DRIVER_SRC}/dispatch/task_mirror.ts --pm-id ${MG_PM_ID} --project ${PROJECT_ROOT_FOR_PARSE} --format ops`;
}

// W-070: heavy-compile lock wiring.
const HEAVY_LOCK_TS = `${SCRIPTS_DIR}/heavy_compile_lock.ts`;
let HEAVY_LOCK_TOKEN = "";
let LAST_GATE_EXIT = "";
// W-024: the merge active.lock owner pid. The driver records the bash launcher's
// Windows pid; the merge-gate.sh shim captures it (GARELIER_MERGE_GATE_OWNER_PID)
// before `exec bun`, since on Windows the exec'd bun runs under a different
// Windows pid than the bash the driver spawned. Fall back to this process's pid
// for a direct (non-shim) invocation.
const MG_OWNER_PID = process.env.GARELIER_MERGE_GATE_OWNER_PID || String(process.pid);

// ── JSON escape (backslash, quote, \n \r \t) ────────────────────────────────
function jesc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function appendLog(s: string): void {
  try { appendFileSync(LOG_FILE, s); } catch { /* best-effort */ }
}
function appendLogLn(s: string): void { appendLog(s.endsWith("\n") ? s : s + "\n"); }

// ── active-lock ownership (W-076) ───────────────────────────────────────────
function lockJson(): string {
  return `{\n  "pid": ${MG_OWNER_PID || "0"},\n  "request_id": "${jesc(REQUEST_ID)}",\n  "request_file": "${jesc(REQUEST_FILE)}",\n  "started_at": "${STARTED_AT}",\n  "target_root": "${jesc(TARGET_ROOT)}"\n}\n`;
}
function lockField(lockPath: string, key: string): string {
  try {
    const j = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    const v = j[key];
    return v == null ? "" : String(v);
  } catch {
    return "";
  }
}
// returns 0 proceed / 10 different request / 11 second runner.
function acquireActiveLock(): number {
  const lock = `${LOCK_DIR}/active.lock`;
  try {
    writeFileSync(lock, lockJson(), { flag: "wx" }); // noclobber create-if-absent
    appendLogLn(`--- active.lock: created (request_id=${REQUEST_ID}, pid=${MG_OWNER_PID || "?"}) ---`);
    return 0;
  } catch {
    // already exists — inspect ownership.
  }
  const lreq = lockField(lock, "request_id");
  const lpid = lockField(lock, "pid");
  if (lreq && lreq !== REQUEST_ID) {
    appendLogLn(`--- active.lock: held by a DIFFERENT request '${lreq}' (mine=${REQUEST_ID}) — not staging on top of it, exiting (queue serialization) ---`);
    return 10;
  }
  if (lpid && MG_OWNER_PID && lpid === MG_OWNER_PID) {
    appendLogLn(`--- active.lock: adopted (driver wrote it for THIS gate: request_id=${REQUEST_ID}, pid=${MG_OWNER_PID}) ---`);
    return 0;
  }
  if (lreq && lreq === REQUEST_ID && lpid && MG_OWNER_PID && lpid !== MG_OWNER_PID) {
    appendLogLn(`--- active.lock: SECOND RUNNER — request ${REQUEST_ID} already held by pid ${lpid} (mine=${MG_OWNER_PID}); exiting immediately without staging (W-076) ---`);
    return 11;
  }
  appendLogLn(`--- active.lock: present but ownership ambiguous (req='${lreq}' pid='${lpid}' mine='${MG_OWNER_PID || "?"}') — proceeding (fail-open) ---`);
  return 0;
}

// ── transient gate-failure detection (W-029) ────────────────────────────────
function transientFailurePattern(outFile: string, errFile: string): string {
  const read = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const blob = read(outFile) + "\n" + read(errFile);
  if (/error\[E0463\]/.test(blob)) return "E0463";
  if (/undefined symbol.*anon\.llvm/.test(blob)) return "undefined-symbol-anon-llvm";
  return "";
}

// ── result writer (atomic via .tmp + rename) ────────────────────────────────
function writeResult(status: string, studioCommit: string, failureReason: string, conflictFiles: string): void {
  const ended = isoNow();
  const durationMs = (Math.floor(Date.now() / 1000) - STARTED_EPOCH) * 1000;

  const r: string[] = [];
  r.push("{");
  r.push(`  "request_id": "${jesc(REQUEST_ID)}",`);
  r.push(`  "status": "${status}",`);
  if (status === "success" && TASK_MIRROR_HINT) r.push(`  "task_mirror_hint": "${jesc(TASK_MIRROR_HINT)}",`);
  r.push(studioCommit ? `  "studio_commit": "${studioCommit}",` : `  "studio_commit": null,`);
  r.push(`  "started_at": "${STARTED_AT}",`);
  r.push(`  "ended_at": "${ended}",`);
  r.push(`  "duration_ms": ${durationMs},`);
  r.push(`  "preflight_steps": [${PREFLIGHT_STEPS_JSON}],`);
  r.push(`  "gate_steps": [${GATE_STEPS_JSON}],`);
  r.push(`  "gate_mode": "${GATE_MODE}",`);
  r.push(`  "data_only_file_count": ${DATA_ONLY_FILE_COUNT},`);
  r.push(GUARDIAN_VERDICT_BOUND_BY ? `  "guardian_verdict_bound_by": "${GUARDIAN_VERDICT_BOUND_BY}",` : `  "guardian_verdict_bound_by": null,`);
  r.push(OBSERVER_VERDICT_BOUND_BY ? `  "observer_verdict_bound_by": "${OBSERVER_VERDICT_BOUND_BY}",` : `  "observer_verdict_bound_by": null,`);
  r.push(failureReason ? `  "failure_reason": "${jesc(failureReason)}",` : `  "failure_reason": null,`);
  r.push(REFUTER_WARNING ? `  "refuter_warning": "${jesc(REFUTER_WARNING)}",` : `  "refuter_warning": null,`);
  if (COMPLETED_EXTERNALLY) {
    r.push(`  "completed_externally": true,`);
    r.push(`  "absorbed_by": "${jesc(COMPLETED_EXTERNALLY)}",`);
  }
  r.push(`  "conflict_files": ${conflictFiles || "null"},`);
  if (TRANSIENT_RETRY_JSON) {
    r.push(`  "pre_merge_target_advanced": ${PRE_MERGE_TARGET_ADVANCED},`);
    r.push(`  "transient_retry": ${TRANSIENT_RETRY_JSON}`);
  } else {
    r.push(`  "pre_merge_target_advanced": ${PRE_MERGE_TARGET_ADVANCED}`);
  }
  r.push("}");
  writeFileSync(RESULT_TMP, r.join("\n") + "\n");
  renameSync(RESULT_TMP, RESULT_FINAL);

  const s: string[] = [];
  s.push("{");
  s.push(`  "schema_version": 1,`);
  s.push(`  "request_id": "${jesc(REQUEST_ID)}",`);
  s.push(`  "status": "${status}",`);
  if (status === "success" && TASK_MIRROR_HINT) s.push(`  "task_mirror_hint": "${jesc(TASK_MIRROR_HINT)}",`);
  s.push(`  "quality_gate_mode": "full",`);
  s.push(`  "gate_mode": "${GATE_MODE}",`);
  s.push(`  "data_only_file_count": ${DATA_ONLY_FILE_COUNT},`);
  s.push(`  "preflight_command_count": ${PREFLIGHT_COMMANDS.length},`);
  s.push(`  "quality_gate_command_count": ${QUALITY_GATE_COMMANDS.length},`);
  s.push(`  "quality_gate_timeout_minutes_per_cmd": ${CMD_TIMEOUT_MINUTES},`);
  s.push(studioCommit ? `  "studio_commit": "${studioCommit}",` : `  "studio_commit": null,`);
  s.push(`  "started_at": "${STARTED_AT}",`);
  s.push(`  "ended_at": "${ended}",`);
  s.push(`  "duration_ms": ${durationMs},`);
  s.push(`  "preflight_steps": [${PREFLIGHT_STEPS_SUMMARY_JSON}],`);
  s.push(`  "gate_steps": [${GATE_STEPS_SUMMARY_JSON}],`);
  s.push(GUARDIAN_VERDICT_BOUND_BY ? `  "guardian_verdict_bound_by": "${GUARDIAN_VERDICT_BOUND_BY}",` : `  "guardian_verdict_bound_by": null,`);
  s.push(OBSERVER_VERDICT_BOUND_BY ? `  "observer_verdict_bound_by": "${OBSERVER_VERDICT_BOUND_BY}",` : `  "observer_verdict_bound_by": null,`);
  s.push(failureReason ? `  "failure_reason": "${jesc(failureReason)}",` : `  "failure_reason": null,`);
  s.push(REFUTER_WARNING ? `  "refuter_warning": "${jesc(REFUTER_WARNING)}",` : `  "refuter_warning": null,`);
  if (COMPLETED_EXTERNALLY) {
    s.push(`  "completed_externally": true,`);
    s.push(`  "absorbed_by": "${jesc(COMPLETED_EXTERNALLY)}",`);
  }
  s.push(`  "conflict_files": ${conflictFiles || "null"},`);
  s.push(`  "pre_merge_target_advanced": ${PRE_MERGE_TARGET_ADVANCED},`);
  if (TRANSIENT_RETRY_JSON) s.push(`  "transient_retry": ${TRANSIENT_RETRY_JSON},`);
  s.push(`  "log_file": "runtime/merge_gate/logs/${jesc(STEM)}.log"`);
  s.push("}");
  writeFileSync(SUMMARY_TMP, s.join("\n") + "\n");
  renameSync(SUMMARY_TMP, SUMMARY_FINAL);

  pruneMergeGateResults();
}

function pruneMergeGateResults(): void {
  const mgTs = `${DRIVER_SRC}/merge_gate.ts`;
  if (!existsSync(mgTs)) return;
  const pm = pmIdOf(STUDIO_BRANCH);
  if (!pm) return;
  const r = runSync(["bun", mgTs, "prune", "--project", PROJECT_ROOT_FOR_PARSE, "--pm-id", pm]);
  appendLog(r.stdout + r.stderr);
}

// ── self-drain the merge queue on completion (W-039) ────────────────────────
function selfDrainQueue(): void {
  if (mgTeardown) return;
  const dmTs = `${DRIVER_SRC}/dispatch/dock_merge.ts`;
  if (!existsSync(dmTs)) return;
  const pm = pmIdOf(STUDIO_BRANCH);
  if (!pm) return;
  try {
    const child = Bun.spawn(["bun", dmTs, "poll", "--pm-id", pm, "--project", PROJECT_ROOT_FOR_PARSE], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    child.unref();
  } catch { /* best-effort */ }
}

// ── step-record appenders ───────────────────────────────────────────────────
function appendStep(target: "gate" | "preflight", cmd: string, exitCode: number, durationMs: number, stdoutTail: string, stderrTail: string): void {
  const entry = `{"cmd":"${jesc(cmd)}","exit_code":${exitCode},"duration_ms":${durationMs},"stdout_tail":"${jesc(stdoutTail)}","stderr_tail":"${jesc(stderrTail)}"}`;
  const summary = `{"cmd":"${jesc(cmd)}","exit_code":${exitCode},"duration_ms":${durationMs}}`;
  if (target === "gate") {
    GATE_STEPS_JSON = GATE_STEPS_JSON ? `${GATE_STEPS_JSON},${entry}` : entry;
    GATE_STEPS_SUMMARY_JSON = GATE_STEPS_SUMMARY_JSON ? `${GATE_STEPS_SUMMARY_JSON},${summary}` : summary;
  } else {
    PREFLIGHT_STEPS_JSON = PREFLIGHT_STEPS_JSON ? `${PREFLIGHT_STEPS_JSON},${entry}` : entry;
    PREFLIGHT_STEPS_SUMMARY_JSON = PREFLIGHT_STEPS_SUMMARY_JSON ? `${PREFLIGHT_STEPS_SUMMARY_JSON},${summary}` : summary;
  }
}

function archiveRequest(): void {
  try { renameSync(REQUEST_JSON, `${ARCHIVE_DIR}/${STEM}.request.json`); } catch { /* best-effort */ }
}

function clearLockIfMine(): void {
  const lock = `${LOCK_DIR}/active.lock`;
  if (existsSync(lock)) {
    try {
      const text = readFileSync(lock, "utf8");
      const re = new RegExp(`"request_id":\\s*"${REQUEST_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
      if (re.test(text)) rmSync(lock, { force: true });
    } catch { /* ignore */ }
  }
  if (HEAVY_LOCK_TOKEN) {
    const args = ["bun", HEAVY_LOCK_TS, "--project", PROJECT_ROOT_FOR_PARSE, "--pm-id", MG_PM_ID, "--mode", "release", "--token", HEAVY_LOCK_TOKEN, "--build-log", LOG_FILE];
    if (LAST_GATE_EXIT) args.push("--build-exit", LAST_GATE_EXIT);
    const r = runSync(args);
    appendLog(r.stdout + r.stderr);
    HEAVY_LOCK_TOKEN = "";
  }
  selfDrainQueue();
}

// ── cleanup/abort (crashes + SIGTERM/SIGINT) ────────────────────────────────
function cleanupAndAbort(signal: string, teardown: boolean): never {
  if (teardown) mgTeardown = true;
  appendLog(`\n=== cleanup_and_abort: signal=${signal} at ${isoNow()} ===\n`);
  git(["merge", "--abort"]); // harmless no-op if not mid-merge
  if (!STATUS) {
    // W-054 landed-check (shared, bun-tested helper): did the merge already land
    // despite the crash/signal? The merge_gate_landed_check.test.sh parity oracle
    // pins the identical decision from the retained bash cleanup_and_abort().
    const outcome = w054LandedOutcome(WORKBENCH_BRANCH, (a) => { const r = git(a); return { code: r.code, stdout: r.stdout }; });
    if (outcome.status === "success") {
      const landedCommit = outcome.commit;
      STATUS = "success";
      FAILURE_REASON = `aftercare warning: gate hit signal=${signal} AFTER the merge commit already landed (${landedCommit}) — self-check (W-054) confirmed ${WORKBENCH_BRANCH} is an ancestor of studio HEAD, reporting success instead of a false abort; verify post-commit housekeeping (archive/lock release) completed`;
      appendLogLn("cleanup_and_abort: W-054 landed-check found the merge ALREADY LANDED despite signal=" + signal + " — reporting success, not a false abort");
      writeResult("success", landedCommit, FAILURE_REASON, "null");
    } else {
      STATUS = "aborted";
      FAILURE_REASON = `signal ${signal} during merge gate`;
      writeResult("aborted", "", FAILURE_REASON, "null");
    }
  }
  archiveRequest();
  clearLockIfMine();
  process.exit(0);
}

process.on("SIGTERM", () => cleanupAndAbort("SIGTERM", true));
process.on("SIGINT", () => cleanupAndAbort("SIGINT", true));

// Terminal helper: disarm signal handlers + exit.
function done(code: number): never {
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  process.exit(code);
}

// JSON array literal of conflict file list.
function conflictJson(files: string[]): string {
  return "[" + files.filter((f) => f).map((f) => `"${jesc(f)}"`).join(",") + "]";
}

// glob-ish match mirroring bash `[[ "$f" == $pat ]]` with unquoted pattern
// (so `*` matches `/` too). Translate the shell glob to a RegExp.
function bashGlobMatch(file: string, pat: string): boolean {
  let re = "";
  for (const ch of pat) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$").test(file);
}

// ── primary-checkout escape self-heal (W-077) ───────────────────────────────
function primaryEscapeSelfHeal(): boolean {
  const statusOut = (() => { const r = runSync(["git", "-c", "core.quotepath=false", "status", "--porcelain"], TARGET_ROOT); return r.code === 0 ? r.stdout : ""; })();
  if (!statusOut.trim()) return false;
  const wbtip = (() => { const r = git(["rev-parse", "--verify", "-q", `${WORKBENCH_BRANCH}^{commit}`]); return r.code === 0 ? r.stdout.trim() : ""; })();
  if (!wbtip) return false;
  const healPaths: string[] = [];
  for (const rawLine of statusOut.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    const xy = line.slice(0, 2);
    const path = line.slice(3);
    if (xy === "??") continue;
    if (/U/.test(xy) || /^R/.test(xy) || /^C/.test(xy) || /R$/.test(xy) || /C$/.test(xy)) return false;
    if (path.includes(" -> ") || path.startsWith('"')) return false;
    if (git(["cat-file", "-e", `${wbtip}:${path}`]).code !== 0) return false;
    // byte-identical compare via hash-object vs the branch blob.
    const branchHash = (() => { const r = git(["rev-parse", `${wbtip}:${path}`]); return r.code === 0 ? r.stdout.trim() : ""; })();
    const workHash = (() => { const r = git(["hash-object", "--", path]); return r.code === 0 ? r.stdout.trim() : ""; })();
    if (!branchHash || !workHash || branchHash !== workHash) return false;
    healPaths.push(path);
  }
  if (healPaths.length === 0) return false;
  if (!gitLogged(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...healPaths])) return false;
  appendLogLn(`--- step 1-heal (W-077): lossless-restored ${healPaths.length} primary-checkout escape path(s) byte-identical to ${WORKBENCH_BRANCH}: ${healPaths.join(" ")} ---`);
  return true;
}

// ── absorbed-intact probe (W-076) ───────────────────────────────────────────
function absorbedIntactCheck(): boolean {
  const head = (() => { const r = git(["rev-parse", "-q", "--verify", "HEAD"]); return r.code === 0 ? r.stdout.trim() : ""; })();
  const wbtip = (() => { const r = git(["rev-parse", "-q", "--verify", `${WORKBENCH_BRANCH}^{commit}`]); return r.code === 0 ? r.stdout.trim() : ""; })();
  if (!head || !wbtip) return false;
  const p1 = (() => { const r = git(["rev-parse", "-q", "--verify", `${head}^1`]); return r.code === 0 ? r.stdout.trim() : ""; })();
  const p2 = (() => { const r = git(["rev-parse", "-q", "--verify", `${head}^2`]); return r.code === 0 ? r.stdout.trim() : ""; })();
  if (p2 && (p1 === wbtip || p2 === wbtip)) {
    appendLogLn(`--- W-076 absorbed-intact (a): HEAD ${head} is a 2-parent merge including branch tip ${wbtip} ---`);
    return true;
  }
  const base = (() => { const r = git(["merge-base", head, wbtip]); return r.code === 0 ? r.stdout.trim() : ""; })();
  if (!base) return false;
  const changed = (() => { const r = git(["diff", "--name-only", base, wbtip]); return r.code === 0 ? r.stdout.split("\n").filter((f) => f) : []; })();
  if (changed.length === 0) return false;
  if (git(["diff", "--quiet", head, wbtip, "--", ...changed]).code === 0) {
    appendLogLn(`--- W-076 absorbed-intact (b): all ${changed.length} inbound file(s) byte-identical between HEAD ${head} and branch tip ${wbtip} ---`);
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
async function main(): Promise<never> {
  // ── log header ────────────────────────────────────────────────────────────
  let header = "";
  header += `=== merge-gate.sh request ${REQUEST_ID} ===\n`;
  header += `started_at:      ${STARTED_AT}\n`;
  header += `workbench:       ${WORKBENCH_BRANCH}\n`;
  header += `studio:          ${STUDIO_BRANCH}\n`;
  header += `merge_message:   ${MERGE_MESSAGE}\n`;
  header += `pre_merge_base:  ${PRE_MERGE_BASE_TRACKING}\n`;
  header += `preflight:\n`;
  for (const c of PREFLIGHT_COMMANDS) header += `  - ${c}\n`;
  header += `quality_gate:\n`;
  for (const c of QUALITY_GATE_COMMANDS) header += `  - ${c}\n`;
  header += `cmd_timeout_min: ${CMD_TIMEOUT_MINUTES}\n`;
  header += `control_root:    ${PROJECT_ROOT}\n`;
  header += `target_root:     ${TARGET_ROOT}\n`;
  header += `\n`;
  writeFileSync(LOG_FILE, header);

  if (GUARDIAN_VERDICT_BOUND_BY === "tree") appendLog(`\n--- guardian gate: tree-identical amend accepted (G-15 tree fallback, W-035) ---\n`);
  if (OBSERVER_VERDICT_BOUND_BY === "tree") appendLog(`\n--- observer gate: tree-identical amend accepted (stale-verdict tree fallback, W-062) ---\n`);

  // ── acquire active-lock BEFORE any gate work (W-076) ──────────────────────
  const acq = acquireActiveLock();
  if (acq === 10 || acq === 11) {
    appendLog(`\n=== exiting without staging: acquire_active_lock rc=${acq} (another runner owns request ${REQUEST_ID}) ===\n`);
    done(0);
  }

  // ── Guardian gate (DEC-024) ───────────────────────────────────────────────
  if (GUARDIAN_GATE_FAIL) {
    STATUS = "failed";
    FAILURE_REASON = GUARDIAN_GATE_FAIL;
    appendLog(`\n--- guardian gate: REFUSED ---\n${GUARDIAN_GATE_FAIL}\n`);
    writeResult("failed", "", FAILURE_REASON, "null");
    archiveRequest(); clearLockIfMine(); done(0);
  }
  // ── Observer merge gate (DEC-019) ─────────────────────────────────────────
  if (OBSERVER_GATE_FAIL) {
    STATUS = "failed";
    FAILURE_REASON = OBSERVER_GATE_FAIL;
    appendLog(`\n--- observer gate: REFUSED ---\n${OBSERVER_GATE_FAIL}\n`);
    writeResult("failed", "", FAILURE_REASON, "null");
    archiveRequest(); clearLockIfMine(); done(0);
  }

  // ── Refuter gate (W-066) ──────────────────────────────────────────────────
  if (REFUTER_GATE_FAIL) {
    STATUS = "failed";
    FAILURE_REASON = REFUTER_GATE_FAIL;
    appendLog(`\n--- refuter gate: REFUTED (held for PM escalation) ---\n${REFUTER_GATE_FAIL}\n`);
    writeResult("failed", "", FAILURE_REASON, "null");
    archiveRequest(); clearLockIfMine(); done(0);
  }
  if (!REFUTER_VERDICT) {
    let refuterHsWhy = "";
    const hsFlag = req.high_stakes === true ? "true" : "false";
    if (hsFlag === "true") {
      refuterHsWhy = "explicit --high-stakes flag on the request";
    } else {
      const policyTs = `${DRIVER_SRC}/observer_policy_check.ts`;
      const cfg = `${PROJECT_ROOT_FOR_PARSE}/__garelier/${MG_PM_ID}/_pm/setup_config.toml`;
      if (existsSync(policyTs) && MG_PM_ID && existsSync(cfg)) {
        refuterHsWhy = runSync(["bun", policyTs, cfg, TARGET_ROOT_FOR_GIT, STUDIO_BRANCH, WORKBENCH_BRANCH, "false", "high-stakes"]).stdout.trim();
      }
    }
    if (refuterHsWhy) {
      REFUTER_WARNING = `high-stakes merge landed without a refuter verdict (W-066 advisory, non-blocking): ${refuterHsWhy}`;
      appendLog(`\n--- refuter gate: ADVISORY WARN — ${REFUTER_WARNING} ---\n`);
    }
  }

  // ── Step 1: ensure on studio (with W-077 self-heal retry) ─────────────────
  appendLogLn("--- step 1: checkout studio ---");
  if (!gitLogged(["checkout", STUDIO_BRANCH])) {
    if (primaryEscapeSelfHeal() && gitLogged(["checkout", STUDIO_BRANCH])) {
      appendLogLn("--- step 1: checkout studio succeeded after W-077 lossless self-heal ---");
    } else {
      STATUS = "failed";
      FAILURE_REASON = `could not checkout ${STUDIO_BRANCH} (working tree dirty?)`;
      writeResult("failed", "", FAILURE_REASON, "null");
      archiveRequest(); clearLockIfMine(); done(0);
    }
  }

  // studio-attached assert (DEC-050).
  const headRef = (() => { const r = git(["symbolic-ref", "-q", "--short", "HEAD"]); return r.code === 0 ? r.stdout.trim() : ""; })();
  if (headRef !== STUDIO_BRANCH) {
    STATUS = "failed";
    FAILURE_REASON = `after checkout, HEAD is '${headRef || "<detached>"}', not studio branch '${STUDIO_BRANCH}' — refusing to merge onto a detached HEAD (would strand the merge on a fork instead of advancing studio; DEC-050)`;
    appendLog(`\n--- studio-attached assert: FAILED (${FAILURE_REASON}) ---\n`);
    writeResult("failed", "", FAILURE_REASON, "null");
    archiveRequest(); clearLockIfMine(); done(0);
  }

  // ── Step 2: pre-merge base tracking (target -> studio) ────────────────────
  if (PRE_MERGE_BASE_TRACKING === "true") {
    const pmRoot = resolve(MERGE_GATE_ROOT, "../..").replace(/\\/g, "/");
    const setupConfig = `${pmRoot}/_pm/setup_config.toml`;
    if (existsSync(setupConfig)) {
      const m = readFileSync(setupConfig, "utf8").match(/^target[ \t]*=[ \t]*"([^"]*)"/m);
      const targetBranch = m ? m[1] : "";
      if (targetBranch) {
        appendLogLn(`--- step 2: base tracking (${targetBranch} → studio) ---`);
        if (git(["merge-base", "--is-ancestor", targetBranch, "HEAD"]).code === 0) {
          appendLogLn(`studio already contains ${targetBranch} tip, skipping merge`);
        } else if (gitLogged(["merge", "--no-edit", targetBranch])) {
          PRE_MERGE_TARGET_ADVANCED = "true";
        } else {
          const cf = git(["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter((f) => f).slice(0, 20);
          git(["merge", "--abort"]);
          STATUS = "conflict";
          FAILURE_REASON = `base-tracking merge of ${targetBranch} into studio produced conflicts`;
          writeResult("conflict", "", FAILURE_REASON, conflictJson(cf));
          archiveRequest(); clearLockIfMine(); done(0);
        }
      }
    }
  }

  // ── Step 3: merge the workbench ───────────────────────────────────────────
  if (!existsSync(`${LOCK_DIR}/active.lock`)) {
    try { writeFileSync(`${LOCK_DIR}/active.lock`, lockJson()); } catch { /* ignore */ }
    appendLogLn("--- step 3 pre-stage: active.lock was absent, recreated before staging (W-076) ---");
  }
  appendLog("\n");
  appendLogLn(`--- step 3: git merge --no-ff --no-commit ${WORKBENCH_BRANCH} ---`);
  if (!gitLogged(["merge", "--no-ff", "--no-commit", WORKBENCH_BRANCH])) {
    const cf = git(["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter((f) => f);
    if (cf.length > 0) {
      STATUS = "conflict";
      git(["merge", "--abort"]);
      FAILURE_REASON = `merge produced ${cf.length} conflicted files`;
      writeResult("conflict", "", FAILURE_REASON, conflictJson(cf));
    } else {
      STATUS = "failed";
      git(["merge", "--abort"]);
      FAILURE_REASON = "git merge failed (no conflict markers); see log";
      writeResult("failed", "", FAILURE_REASON, "null");
    }
    archiveRequest(); clearLockIfMine(); done(0);
  }

  // ── Step 3-empty: already-up-to-date short-circuit (W-055) ────────────────
  const mergeHeadPath = (() => { const r = git(["rev-parse", "--git-path", "MERGE_HEAD"]); return r.code === 0 ? r.stdout.trim() : ""; })();
  const mergeHeadAbs = mergeHeadPath ? resolve(TARGET_ROOT, mergeHeadPath) : "";
  const cachedClean = git(["diff", "--cached", "--quiet"]).code === 0;
  if ((!mergeHeadAbs || !existsSync(mergeHeadAbs)) && cachedClean) {
    appendLog("\n");
    appendLogLn("--- step 3: already up to date — workbench tip already in studio; nothing to gate/commit (already_merged), completing success ---");
    const studioCommit = git(["rev-parse", "HEAD"]).stdout.trim();
    STATUS = "success";
    writeResult("success", studioCommit, "", "null");
    archiveRequest(); clearLockIfMine(); done(0);
  }

  // W-066: pin the exact HEAD the merge was staged onto.
  const STAGED_ONTO_HEAD = (() => { const r = git(["rev-parse", "HEAD"]); return r.code === 0 ? r.stdout.trim() : ""; })();
  const TIMEOUT_SECS = CMD_TIMEOUT_MINUTES * 60;

  // ── Step 3a: data-only classification (W-031) ─────────────────────────────
  if (DATA_ONLY_PATHS.length > 0 && DATA_ONLY_COMMANDS.length > 0) {
    const diffFiles = git(["diff", "--cached", "--name-only"]).stdout.split("\n").filter((f) => f);
    DATA_ONLY_FILE_COUNT = 0;
    let allDataOnly = 1;
    for (const f of diffFiles) {
      DATA_ONLY_FILE_COUNT++;
      let matched = 0;
      for (const pat of DATA_ONLY_PATHS) { if (bashGlobMatch(f, pat)) { matched = 1; break; } }
      if (matched === 0) allDataOnly = 0;
    }
    if (DATA_ONLY_FILE_COUNT > 0 && allDataOnly === 1) GATE_MODE = "data_only";
  }
  appendLog("\n");
  appendLogLn(`--- step 3a: data-only classification: gate_mode=${GATE_MODE} (diff_files=${DATA_ONLY_FILE_COUNT}, allow_patterns=${DATA_ONLY_PATHS.length}, data_only_commands=${DATA_ONLY_COMMANDS.length}) ---`);

  // ── Step 3b: preflight commands (W-023) ───────────────────────────────────
  if (PREFLIGHT_COMMANDS.length > 0) {
    appendLog("\n");
    appendLogLn(`--- step 3b: preflight (${PREFLIGHT_COMMANDS.length} cmd, fail-fast before quality gate) ---`);
    for (const cmd of PREFLIGHT_COMMANDS) {
      if (!cmd) continue;
      appendLog("\n");
      appendLogLn(`--- preflight: ${cmd} ---`);
      const cmdStart = Math.floor(Date.now() / 1000);
      const outFile = tmpFile(); const errFile = tmpFile();
      const exitCode = await runGateCommand(cmd, outFile, errFile, TIMEOUT_SECS);
      const cmdEnd = Math.floor(Date.now() / 1000);
      const durationMs = (cmdEnd - cmdStart) * 1000;
      appendLog(readOrEmpty(outFile)); appendLog(readOrEmpty(errFile));
      const stdoutTail = tailC(outFile, 800); const stderrTail = tailC(errFile, 800);
      rmSyncSafe(outFile); rmSyncSafe(errFile);
      appendStep("preflight", cmd, exitCode, durationMs, stdoutTail, stderrTail);
      if (exitCode !== 0) {
        STATUS = "failed";
        git(["merge", "--abort"]);
        FAILURE_REASON = `preflight command failed: '${cmd}' (exit ${exitCode})${gateTimeoutNote(exitCode, TIMEOUT_SECS)}`;
        writeResult("failed", "", FAILURE_REASON, "null");
        archiveRequest(); clearLockIfMine(); done(0);
      }
    }
  }

  // ── Step 4-lock: heavy-compile lock (W-070; skipped in data_only, W-024) ──
  if (GATE_MODE === "data_only") {
    appendLog(`\n--- step 4-lock: heavy_compile_lock SKIPPED — gate_mode=data_only runs no heavy compile (W-024) ---\n`);
  } else if (MG_PM_ID && existsSync(HEAVY_LOCK_TS)) {
    const r = runSync(["bun", HEAVY_LOCK_TS, "--project", PROJECT_ROOT_FOR_PARSE, "--pm-id", MG_PM_ID, "--mode", "acquire", "--label", `mg-${STEM}`, "--owner-pid", MG_OWNER_PID, "--timeout-sec", "1800"]);
    appendLog(r.stderr);
    HEAVY_LOCK_TOKEN = r.code === 0 ? r.stdout.trim() : "";
    appendLog(`\n--- step 4-lock: heavy_compile_lock acquire token=${HEAVY_LOCK_TOKEN || "<none>"} (W-070; W-061 timeout 1800s fail-open) ---\n`);
  }

  // ── Step 4: quality gate commands (or data-only substitute) ───────────────
  const ACTIVE_GATE_COMMANDS = GATE_MODE === "data_only" ? DATA_ONLY_COMMANDS : QUALITY_GATE_COMMANDS;
  if (GATE_MODE === "data_only") {
    appendLog("\n");
    appendLogLn(`--- step 4: data-only fast path active — running ${ACTIVE_GATE_COMMANDS.length} data_only_commands instead of ${QUALITY_GATE_COMMANDS.length} quality_gate_commands ---`);
  }
  for (const cmd of ACTIVE_GATE_COMMANDS) {
    if (!cmd) continue;
    appendLog("\n");
    appendLogLn(`--- gate: ${cmd} ---`);
    const cmdStart = Math.floor(Date.now() / 1000);
    let outFile = tmpFile(); let errFile = tmpFile();
    let exitCode = await runGateCommand(cmd, outFile, errFile, TIMEOUT_SECS);
    const cmdEnd = Math.floor(Date.now() / 1000);
    let durationMs = (cmdEnd - cmdStart) * 1000;

    if (exitCode !== 0 && TRANSIENT_RETRY_ENABLED === "true") {
      const matched = transientFailurePattern(outFile, errFile);
      if (matched) {
        appendLog("\n");
        appendLogLn(`--- gate: '${cmd}' failed (exit ${exitCode}), matched transient pattern '${matched}' — retrying once ---`);
        appendLog(readOrEmpty(outFile)); appendLog(readOrEmpty(errFile));
        rmSyncSafe(outFile); rmSyncSafe(errFile);
        outFile = tmpFile(); errFile = tmpFile();
        const retryStart = Math.floor(Date.now() / 1000);
        exitCode = await runGateCommand(cmd, outFile, errFile, TIMEOUT_SECS);
        const retryEnd = Math.floor(Date.now() / 1000);
        durationMs = durationMs + (retryEnd - retryStart) * 1000;
        appendLogLn(`--- gate retry result: exit ${exitCode} ---`);
        if (exitCode === 0) TRANSIENT_RETRY_JSON = `{"cmd":"${jesc(cmd)}","pattern":"${jesc(matched)}"}`;
      }
    }

    appendLog(readOrEmpty(outFile)); appendLog(readOrEmpty(errFile));
    const stdoutTail = tailC(outFile, 800); const stderrTail = tailC(errFile, 800);
    rmSyncSafe(outFile); rmSyncSafe(errFile);
    LAST_GATE_EXIT = String(exitCode);
    appendStep("gate", cmd, exitCode, durationMs, stdoutTail, stderrTail);
    if (exitCode !== 0) {
      STATUS = "failed";
      git(["merge", "--abort"]);
      FAILURE_REASON = `quality gate command failed: '${cmd}' (exit ${exitCode})${gateTimeoutNote(exitCode, TIMEOUT_SECS)}`;
      writeResult("failed", "", FAILURE_REASON, "null");
      archiveRequest(); clearLockIfMine(); done(0);
    }
  }

  // ── Step 4b: run-verify commands (optional post-merge runtime gate) ────────
  const mgSetupConfig = `${PROJECT_ROOT}/__garelier/${MG_PM_ID}/_pm/setup_config.toml`;
  let RUN_VERIFY_COMMANDS: string[] = [];
  if (MG_PM_ID && existsSync(mgSetupConfig)) {
    RUN_VERIFY_COMMANDS = nulList(bunEval('const c=require(process.argv[1]);const a=(c.quality_gate&&Array.isArray(c.quality_gate.run_verify_commands))?c.quality_gate.run_verify_commands:[];for(const x of a){if(typeof x==="string"&&x.trim())process.stdout.write(x+"\\0")}', mgSetupConfig));
  }
  if (RUN_VERIFY_COMMANDS.length > 0) {
    appendLog("\n");
    appendLogLn(`--- step 4b: run-verify (${RUN_VERIFY_COMMANDS.length} cmd, post-merge RUNTIME gate) ---`);
    for (const cmd of RUN_VERIFY_COMMANDS) {
      if (!cmd) continue;
      appendLog("\n");
      appendLogLn(`--- run-verify: ${cmd} ---`);
      const cmdStart = Math.floor(Date.now() / 1000);
      const outFile = tmpFile(); const errFile = tmpFile();
      const exitCode = await runGateCommand(cmd, outFile, errFile, TIMEOUT_SECS);
      const cmdEnd = Math.floor(Date.now() / 1000);
      const durationMs = (cmdEnd - cmdStart) * 1000;
      appendLog(readOrEmpty(outFile)); appendLog(readOrEmpty(errFile));
      const stdoutTail = tailC(outFile, 800); const stderrTail = tailC(errFile, 800);
      rmSyncSafe(outFile); rmSyncSafe(errFile);
      appendStep("gate", `run-verify: ${cmd}`, exitCode, durationMs, stdoutTail, stderrTail);
      if (exitCode !== 0) {
        STATUS = "failed";
        git(["merge", "--abort"]);
        FAILURE_REASON = `run-verify command failed: '${cmd}' (exit ${exitCode})${gateTimeoutNote(exitCode, TIMEOUT_SECS)}`;
        writeResult("failed", "", FAILURE_REASON, "null");
        archiveRequest(); clearLockIfMine(); done(0);
      }
    }
  }

  // ── Step 5: commit the merge (W-066 HEAD-moved guard + W-076 absorb probe) ─
  const w066HeadNow = (() => { const r = git(["rev-parse", "HEAD"]); return r.code === 0 ? r.stdout.trim() : ""; })();
  const w066MergeHeadPath = (() => { const r = git(["rev-parse", "--git-path", "MERGE_HEAD"]); return r.code === 0 ? r.stdout.trim() : ""; })();
  const w066MergeHeadAbs = w066MergeHeadPath ? resolve(TARGET_ROOT, w066MergeHeadPath) : "";
  const mergeHeadPresent = !!(w066MergeHeadAbs && existsSync(w066MergeHeadAbs));
  if (STAGED_ONTO_HEAD && (w066HeadNow !== STAGED_ONTO_HEAD || !mergeHeadPresent)) {
    if (absorbedIntactCheck()) {
      STATUS = "success";
      COMPLETED_EXTERNALLY = w066HeadNow;
      FAILURE_REASON = `W-076 completed_externally: HEAD moved during the gate (staged onto ${STAGED_ONTO_HEAD}, now ${w066HeadNow}) but the absorbing commit already landed ${WORKBENCH_BRANCH} INTACT (2-parent merge including the branch tip, or byte-identical inbound content) — reporting success (absorbed_by=${w066HeadNow}) instead of a false abort. No re-land needed; verify the studio commit's message label if the absorbing commit was mislabeled.`;
      appendLog(`\n--- step 5: W-076 completed_externally — absorbed_by ${w066HeadNow} (no re-land needed) ---\n`);
      git(["merge", "--abort"]);
      writeResult("success", w066HeadNow, FAILURE_REASON, "null");
      archiveRequest(); clearLockIfMine(); done(0);
    }
    STATUS = "aborted";
    FAILURE_REASON = `W-066: HEAD moved during the gate (staged onto ${STAGED_ONTO_HEAD}, now ${w066HeadNow || "<none>"}; MERGE_HEAD ${mergeHeadPresent ? "present" : "GONE"}) — a commit on the shared main checkout absorbed or displaced the staged merge (the recurring PM-commit-during-gate incident). NOT committing a mislabeled/wrong merge. Recover: inspect the absorbing commit's content (usually intact), then re-run the land for ${WORKBENCH_BRANCH}; never commit to studio while runtime/merge_gate/locks/active.lock exists.`;
    git(["merge", "--abort"]);
    writeResult("aborted", "", FAILURE_REASON, "null");
    archiveRequest(); clearLockIfMine(); done(1);
  }
  appendLog("\n");
  appendLogLn("--- step 5: git commit (merge message) ---");
  {
    const c = Bun.spawnSync(["git", "commit", "-F", "-"], { cwd: TARGET_ROOT, stdin: Buffer.from(MERGE_MESSAGE), stdout: "pipe", stderr: "pipe" });
    appendLog((c.stdout?.toString() ?? "") + (c.stderr?.toString() ?? ""));
    if (c.exitCode !== 0) {
      // Unguarded in bash (relies on ERR trap → cleanup_and_abort). Mirror that.
      cleanupAndAbort("EXIT_NONZERO", false);
    }
  }
  const studioCommit = git(["rev-parse", "HEAD"]).stdout.trim();
  STATUS = "success";
  writeResult("success", studioCommit, "", "null");

  // ── Step 6: archive request only ──────────────────────────────────────────
  archiveRequest();
  clearLockIfMine();
  done(0);
}

// ── tmp-file helpers (mimic mktemp + tail -c) ───────────────────────────────
let tmpCounter = 0;
function tmpFile(): string {
  const dir = (process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp").replace(/\\/g, "/");
  tmpCounter += 1;
  return `${dir}/mg-${process.pid}-${Date.now()}-${tmpCounter}.tmp`;
}
function readOrEmpty(p: string): string { try { return readFileSync(p, "utf8"); } catch { return ""; } }
function tailC(p: string, n: number): string {
  try {
    const buf = readFileSync(p);
    // Mirror bash `stdout_tail="$(tail -c 800 …)"`: command substitution strips
    // trailing newlines from the captured tail.
    return buf.subarray(Math.max(0, buf.length - n)).toString("utf8").replace(/\n+$/, "");
  } catch {
    return "";
  }
}
function rmSyncSafe(p: string): void { try { rmSync(p, { force: true }); } catch { /* ignore */ } }

// Run; any unexpected throw mirrors the bash ERR trap (crash → cleanup_and_abort).
main().catch(() => cleanupAndAbort("EXIT_NONZERO", false));
