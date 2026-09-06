import { renameSync, rmSync } from "../guard/path_guard.ts";
// Garelier Merge Gate (TS, W-083) — faithful port of merge-gate.ts v2.2 (DEC-007).
//
// Mechanical merge + quality gate executor. Runs a workbench/anvil -> studio
// merge, an OPTIONAL lightweight preflight step (W-023), and the post-merge
// quality gate, as a background subprocess spawned by the driver. NO LLM call.
//
// Invoked with one argument: the path to a request JSON. Reads the request,
// runs the merge gate, writes a result JSON. This is the runtime the
// merge-gate.ts shim exec's; all CLI/stdout/exit/result-file behavior is frozen
// to the bash original (W-083 §3). Sibling driver CLIs (policy checks, prune,
// dock_merge poll, heavy_compile_lock, task_mirror) are invoked exactly as the
// bash did; the request parse + trusted-target-root reuse merge_gate_parse.ts.
//
// Transient-retry (W-029), data-only fast path (W-031), Observer/Guardian/refuter
// gates (DEC-019/024/W-066), W-054 landed-check, W-076 active-lock ownership +
// completed_externally + second-runner exclusion, W-077 primary-escape self-heal:
// all preserved 1:1.

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { buildRecords, resolveTrustedTargetRoot } from "../merge_gate_parse.ts";
import { w054LandedOutcome } from "./merge_gate_landed.ts";
import { gateTimeoutNote, runGateCommand } from "./gate_command.ts";
import { gateCommitEnv, gateEnv, gateCommandEnv } from "./spawn_env.ts";
import { resolveLaneEnv, skippedLaneEnvDiagnostics, type LaneEnv } from "./lane_env.ts";
import { loadLaneEnv } from "../config.ts";
import { requireRuntimeExecutable, resolveCommand, pidAlive } from "./_lib.ts";
import { acquireActiveLockAt, ownsActiveLock } from "./merge_gate_lock.ts";
import {
  runResidentProcessPreflight,
  type ResidentPreflightResult,
} from "./resident_process_health.ts";
import {
  acquireGarelierOperationGuard,
  claimDispatchControlWork,
  garelierControlRoots,
  inspectDispatchControlBinding,
  recordMergeControlOutcome,
} from "../control/garelier_integration.ts";
import { sha256 } from "../control/serialization.ts";
import { crewSubdir } from "../workspace.ts";
import { classifyStudioIndexBaseline } from "../merge_gate.ts";
import { assertChokepointAllowed, sha256Hex, type ChokepointContext } from "../integration_closure.ts";
import {
  recordRoleCloseGateOutcome,
  validateRoleBinding,
  type RoleBindingReference,
  type RoleCloseGateOutcome,
  type RoleCloseGateStatus,
  type RoleCloseReference,
} from "../dispatch/role_binding.ts";

// ── path anchors ────────────────────────────────────────────────────────────
const moduleDir = dirname(fileURLToPath(import.meta.url));
const DRIVER_SRC = resolve(moduleDir, "..").replace(/\\/g, "/"); // driver/src
const CORE_SCRIPTS_DIR = resolve(moduleDir, "../../../scripts").replace(/\\/g, "/");

// ── hardening (mirror: GIT_TERMINAL_PROMPT, exec </dev/null,
//    RUSTC wrapper unset) ───────────────────────────────────────────────────
// These in-process mutations still help any in-process reader, but on Windows
// Bun they do NOT reach spawnSync/spawn children (W-123). Every child below is
// therefore launched with an explicit env from spawn_env.ts. Only the final
// gate-owned `git commit` receives gateCommitEnv().
process.env.GIT_TERMINAL_PROMPT = "0";
delete process.env.GARELIER_MERGE_GATE_COMMIT;
delete process.env.RUSTC_WRAPPER;
delete process.env.RUSTC_WORKSPACE_WRAPPER;

// ── small process helpers ───────────────────────────────────────────────────
interface Cmd { code: number; stdout: string; stderr: string }

let MERGE_LANE_ENV: LaneEnv = {};
let MERGE_LANE_DIAGNOSTICS: string[] = [];

/** Preserve only Git's non-sensitive safe.directory handoff. The inherited
 * GIT_CONFIG_KEY_* family is otherwise secret-scrubbed by gateEnv(), and
 * forwarding a count without every paired key/value makes Git fail closed. */
function safeDirectoryGitConfigEnv(): Record<string, string> {
  const count = Number(process.env.GIT_CONFIG_COUNT ?? "");
  if (!Number.isInteger(count) || count < 1) return {};
  const entries: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    const key = process.env[`GIT_CONFIG_KEY_${index}`];
    const value = process.env[`GIT_CONFIG_VALUE_${index}`];
    if (key !== "safe.directory" || value === undefined) return {};
    entries[`GIT_CONFIG_KEY_${index}`] = key;
    entries[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return { GIT_CONFIG_COUNT: String(count), ...entries };
}

function mergeGateEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return gateEnv(overrides, safeDirectoryGitConfigEnv());
}

function mergeGateCommandEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  // Project declarations are one layer. Safe-directory handoff is gate-owned
  // too, so the shared compositor reasserts the whole core layer after it.
  return gateCommandEnv({ ...MERGE_LANE_ENV, ...overrides }, safeDirectoryGitConfigEnv());
}

function mergeGateCommitEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return gateCommitEnv({ ...MERGE_LANE_ENV, ...overrides }, safeDirectoryGitConfigEnv());
}

function runSync(command: string[], cwd?: string): Cmd {
  const env = mergeGateEnv();
  const resolved = resolveCommand(command, { env });
  if (!resolved) return { code: 127, stdout: "", stderr: `required executable not found: ${command[0] ?? "<empty>"}` };
  const c = Bun.spawnSync(resolved, { windowsHide: true, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: c.exitCode, stdout: c.stdout?.toString() ?? "", stderr: c.stderr?.toString() ?? "" };
}

function bunEval(script: string, ...args: string[]): string {
  const c = Bun.spawnSync([requireRuntimeExecutable("bun"), "-e", script, ...args], { windowsHide: true, env: mergeGateEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
  fatal("Error: usage: merge-gate.ts <request_json_path>");
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
const CONTROL_SCHEMA_VERSION = req.control_schema_version === 3 ? 3 : null;
const CONTROL_WORK_ID = typeof req.work_id === "string" ? req.work_id : "";
const CONTROL_SESSION_ID = typeof req.control_session_id === "string" ? req.control_session_id : "";
const ROLE_REPORT_PATH = typeof req.role_report_path === "string" ? req.role_report_path : "";
const DISPATCH_CONTAINER = typeof req.dispatch_container === "string" ? req.dispatch_container : "";
const DISPATCH_ID = typeof req.dispatch_id === "string" ? req.dispatch_id : "";
const GUARDIAN_REPORT_PATH = typeof req.guardian_report_path === "string" ? req.guardian_report_path : "";
const OBSERVER_REPORT_PATH = typeof req.observer_report_path === "string" ? req.observer_report_path : "";
const EXECUTION_ROUTE = req.execution_route === "artisan" ? "artisan" : req.execution_route === "dock" ? "dock" : "";
const EXPECTED_STUDIO_SHA = typeof req.expected_studio_sha === "string" ? req.expected_studio_sha : "";
let OBSERVED_STUDIO_SHA = "";
let DISPATCH_ROLE = "", DISPATCH_SLUG = "";

try {
  const pmId = typeof req.studio_branch === "string" ? req.studio_branch.split("/")[2] ?? "" : "";
  if (!pmId) throw new Error("cannot discover pm_id from request studio_branch");
  if (DISPATCH_CONTAINER) {
    try {
      const context = JSON.parse(readFileSync(resolve(PROJECT_ROOT_FOR_PARSE, DISPATCH_CONTAINER, "context.json"), "utf8")) as { task?: { role?: unknown; slug?: unknown } };
      if (typeof context.task?.role === "string") DISPATCH_ROLE = context.task.role;
      if (typeof context.task?.slug === "string") DISPATCH_SLUG = context.task.slug;
    } catch { /* absent legacy context is valid unless a declaration needs it */ }
  }
  const resolution = resolveLaneEnv(loadLaneEnv(PROJECT_ROOT_FOR_PARSE, pmId), {
    checkout: TARGET_ROOT_FOR_GIT,
    project: PROJECT_ROOT_FOR_PARSE,
    container: DISPATCH_CONTAINER ? resolve(PROJECT_ROOT_FOR_PARSE, DISPATCH_CONTAINER) : dirname(TARGET_ROOT_FOR_GIT),
    dispatchId: DISPATCH_ID, role: DISPATCH_ROLE, slug: DISPATCH_SLUG,
  }, "gate");
  MERGE_LANE_ENV = resolution.values;
  MERGE_LANE_DIAGNOSTICS = skippedLaneEnvDiagnostics(resolution.skipped, "merge-gate");
} catch (error) {
  fatal(`Error: dispatch.env refused before merge-gate child execution: ${(error as Error).message}`);
}

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

type MergePolicyCheck = "observer_policy" | "guardian_policy";

function blockedPolicyResult(
  check: MergePolicyCheck,
  failureKind: "config" | "internal",
  reason: string,
): string {
  return JSON.stringify({
    schema_version: 1,
    check,
    status: "BLOCKED",
    required: true,
    failure_kind: failureKind,
    reason,
  });
}

function runPolicyBackstop(
  existingFailure: string,
  scriptName: string,
  check: MergePolicyCheck,
  hasPassingVerdict: string,
  guardianReportPath = "",
): string {
  if (existingFailure) return existingFailure;
  const policyTs = `${DRIVER_SRC}/${scriptName}`;
  if (!existsSync(policyTs)) {
    return blockedPolicyResult(check, "internal", `policy checker is missing (${policyTs})`);
  }
  const pm = pmIdOf(STUDIO_BRANCH);
  if (!pm) {
    return blockedPolicyResult(check, "config", `cannot discover pm_id from studio branch (${STUDIO_BRANCH})`);
  }
  const cfg = `${crewSubdir(PROJECT_ROOT_FOR_PARSE, pm, "pm")}/setup_config.toml`;
  if (!existsSync(cfg)) {
    return blockedPolicyResult(check, "config", `cannot read config (${cfg})`);
  }
  const result = runSync([
    "bun",
    policyTs,
    cfg,
    TARGET_ROOT_FOR_GIT,
    STUDIO_BRANCH,
    WORKBENCH_BRANCH,
    hasPassingVerdict,
    ...(guardianReportPath ? [resolve(PROJECT_ROOT_FOR_PARSE, guardianReportPath).replace(/\\/g, "/")] : []),
  ]);
  const stdout = result.stdout.trim();
  if (stdout) return stdout;
  if (result.code !== 0) {
    const detail = result.stderr.trim() || "no diagnostic";
    return blockedPolicyResult(check, "internal", `policy checker failed (exit ${result.code}: ${detail})`);
  }
  return "";
}

// ── Observer-policy backstop (DEC-019) ──────────────────────────────────────
OBSERVER_GATE_FAIL = runPolicyBackstop(
  OBSERVER_GATE_FAIL,
  "observer_policy_check.ts",
  "observer_policy",
  HAS_PASSING_VERDICT,
);
// ── Guardian-policy backstop (DEC-024) ──────────────────────────────────────
GUARDIAN_GATE_FAIL = runPolicyBackstop(
  GUARDIAN_GATE_FAIL,
  "guardian_policy_check.ts",
  "guardian_policy",
  HAS_PASSING_GUARDIAN_VERDICT,
  GUARDIAN_REPORT_PATH,
);

// ── Transient-retry policy (W-029) ──────────────────────────────────────────
let TRANSIENT_RETRY_ENABLED = "false";
{
  const pm = pmIdOf(STUDIO_BRANCH);
  const cfg = `${crewSubdir(PROJECT_ROOT_FOR_PARSE, pm, "pm")}/setup_config.toml`;
  if (pm && existsSync(cfg)) {
    const out = bunEval('const c=require(process.argv[1]);process.stdout.write((c.merge_gate&&c.merge_gate.transient_retry===true)?"true":"false");', cfg);
    TRANSIENT_RETRY_ENABLED = out || "false";
  }
}

// ── Data-only fast-path config (W-031) ──────────────────────────────────────
let GATE_MODE: "normal" | "data_only" = "normal";
let DATA_ONLY_FILE_COUNT = 0;
let DATA_ONLY_PATHS: string[] = [];
let DATA_ONLY_COMMANDS: string[] = [];
{
  const pm = pmIdOf(STUDIO_BRANCH);
  const cfg = `${crewSubdir(PROJECT_ROOT_FOR_PARSE, pm, "pm")}/setup_config.toml`;
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
let RUN_VERIFY_STEPS_JSON = "";
let RUN_VERIFY_STEPS_SUMMARY_JSON = "";
let FAILURE_REASON = "";
let STATUS = "";
let PRE_MERGE_TARGET_ADVANCED = "false";
let TRANSIENT_RETRY_JSON = "";
let REFUTER_WARNING = "";
let COMPLETED_EXTERNALLY = "";
let CONTROL_UPDATE: Record<string, unknown> | null = null;
let RESIDENT_PROCESS_PREFLIGHT: ResidentPreflightResult | null = null;
let mgTeardown = false;
let STUDIO_BASELINE_VERIFIED = false;
let GATE_OWNED_MERGE_HEAD = "";
let MERGE_OWNERSHIP_MARKER_ERROR = "";
let ROLE_CLOSE_OUTCOME: RoleCloseGateOutcome | { error: string } | null | undefined;

const MG_PM_ID = pmIdOf(STUDIO_BRANCH);
const MG_SETUP_CONFIG = MG_PM_ID ? `${crewSubdir(PROJECT_ROOT_FOR_PARSE, MG_PM_ID, "pm")}/setup_config.toml` : "";
const MG_CONFIG_SOURCE = MG_SETUP_CONFIG && existsSync(MG_SETUP_CONFIG)
  ? {
      path: relative(PROJECT_ROOT_FOR_PARSE, MG_SETUP_CONFIG).replace(/\\/g, "/"),
      content_hash: sha256(readFileSync(MG_SETUP_CONFIG)),
    }
  : null;
const REVIEW_RESOLVED_TARGET_SHA = headShaResolver(WORKBENCH_BRANCH) ?? "";
let EFFECTIVE_GATE_COMMANDS = [...QUALITY_GATE_COMMANDS];
const commandArray = (value: unknown): string[] | null => Array.isArray(value)
  && value.every((item) => typeof item === "string" && item.length > 0) ? value as string[] : null;
const sameCommandArray = (left: unknown, right: readonly string[]): boolean => {
  const parsed = commandArray(left);
  return Boolean(parsed && parsed.length === right.length && parsed.every((item, index) => item === right[index]));
};
const CONTROL_REQUEST_BINDING_ERROR = (() => {
  if (CONTROL_SCHEMA_VERSION !== 3) return "";
  if (req.workbench_branch !== WORKBENCH_BRANCH || req.workbench_tip !== REVIEW_RESOLVED_TARGET_SHA
    || !/^[0-9a-f]{40,64}$/.test(REVIEW_RESOLVED_TARGET_SHA)) {
    return `schema-v${CONTROL_SCHEMA_VERSION} request workbench branch/tip binding is missing or stale`;
  }
  if (req.gate_mode !== "normal"
    || !sameCommandArray(req.requested_preflight_commands, PREFLIGHT_COMMANDS)
    || !sameCommandArray(req.requested_quality_gate_commands, QUALITY_GATE_COMMANDS)
    || !sameCommandArray(req.effective_gate_commands, QUALITY_GATE_COMMANDS)) {
    return `schema-v${CONTROL_SCHEMA_VERSION} request command binding is missing, stale, or not in exact ordered agreement`;
  }
  if (JSON.stringify(req.merge_gate_config ?? null) !== JSON.stringify(MG_CONFIG_SOURCE)) {
    return `schema-v${CONTROL_SCHEMA_VERSION} request merge-gate config/source hash is stale`;
  }
  for (const role of ["guardian", "observer"] as const) {
    if (req[`${role}_required`] !== true) continue;
    const reviewSha = req[`${role}_review_sha`];
    if (typeof reviewSha !== "string" || !/^[0-9a-f]{40,64}$/.test(reviewSha)
      || !/^[0-9a-f]{40,64}$/.test(REVIEW_RESOLVED_TARGET_SHA)) {
      return `schema-v${CONTROL_SCHEMA_VERSION} ${role} review binding requires requested and resolved full lowercase commit SHAs`;
    }
  }
  return "";
})();

// W-076: task_mirror anchor hint (SUCCESS result only).
let TASK_MIRROR_HINT = "";
if (MG_PM_ID) {
  TASK_MIRROR_HINT = `bun ${DRIVER_SRC}/dispatch/task_mirror.ts --pm-id ${MG_PM_ID} --project ${PROJECT_ROOT_FOR_PARSE} --format ops`;
}

// W-070: heavy-compile lock wiring.
const HEAVY_LOCK_TS = `${CORE_SCRIPTS_DIR}/heavy_compile_lock.ts`;
let HEAVY_LOCK_TOKEN = "";
let LAST_GATE_EXIT = "";
// W-024: the merge active.lock owner pid. Direct Bun invocation owns the native
// process; an orchestrator may still forward the child pid when it pre-creates
// active.lock.
const MG_OWNER_PID = process.env.GARELIER_MERGE_GATE_OWNER_PID || String(process.pid);
// W-346 FR4: the spawn nonce pollMergeGate wrote into its placeholder-before-
// spawn active.lock. The child adopts ONLY the placeholder carrying this exact
// nonce (merge_gate_lock.ts); a direct invocation has none and behaves as before.
const MG_LOCK_NONCE = process.env.GARELIER_MERGE_GATE_LOCK_NONCE || "";
const MERGE_OWNERSHIP_MARKER = `${LOCK_DIR}/${STEM}.merge-owner.json`;
const MERGE_OWNERSHIP_MARKER_TMP = `${LOCK_DIR}/${STEM}.merge-owner.${MG_OWNER_PID}.tmp`;

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
for (const diagnostic of MERGE_LANE_DIAGNOSTICS) appendLogLn(diagnostic);

// ── active-lock ownership (W-076) ───────────────────────────────────────────
function lockJson(): string {
  const nonceField = MG_LOCK_NONCE ? `\n  "nonce": "${jesc(MG_LOCK_NONCE)}",` : "";
  return `{\n  "pid": ${MG_OWNER_PID || "0"},${nonceField}\n  "request_id": "${jesc(REQUEST_ID)}",\n  "request_file": "${jesc(REQUEST_FILE)}",\n  "started_at": "${STARTED_AT}",\n  "target_root": "${jesc(TARGET_ROOT)}",\n  "owner": "operator",\n  "provenance": "operator-owned"\n}\n`;
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
// returns 0 proceed / 10 different request / 11 second runner. W-175 f/g: a
// provably-dead lock owner is reclaimed (not stalled) and every branch logs a
// reason (no silent verdict). The pure decision lives in merge_gate_lock.ts.
function acquireActiveLock(): number {
  // W-169 (f): the atomic acquire + reclaim-race backoff live in merge_gate_lock.ts
  // (acquireActiveLockAt) so real 2-process mutual exclusion is testable end-to-end.
  // Behavior is unchanged: 0 proceed / 10 different-or-lost-reclaim / 11 second.
  return acquireActiveLockAt({
    lockPath: `${LOCK_DIR}/active.lock`,
    requestId: REQUEST_ID,
    ownerPid: MG_OWNER_PID,
    lockBody: lockJson(),
    isAlive: (p) => pidAlive(p),
    log: (msg) => appendLogLn(`--- active.lock: ${msg} ---`),
    adoptNonce: MG_LOCK_NONCE || undefined,
  });
}

// ── transient gate-failure detection (W-029) ────────────────────────────────
function transientFailurePattern(outFile: string, errFile: string): string {
  const read = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const blob = read(outFile) + "\n" + read(errFile);
  if (/error\[E0463\]/.test(blob)) return "E0463";
  if (/undefined symbol.*anon\.llvm/.test(blob)) return "undefined-symbol-anon-llvm";
  return "";
}

function classifyProjectCommandFailure(
  phase: "preflight" | "quality gate" | "run-verify",
  command: string,
  exitCode: number,
  timeoutSeconds: number,
  failureOutput: string,
): { status: "failed" | "environment_blocked"; reason: string } {
  const codeFailure = `${phase} command failed: '${command}' (exit ${exitCode})${gateTimeoutNote(exitCode, timeoutSeconds)}`;
  RESIDENT_PROCESS_PREFLIGHT = runResidentProcessPreflight({
    projectRoot: PROJECT_ROOT_FOR_PARSE,
    pmId: MG_PM_ID,
    command,
    failureOutput,
  });
  appendLogLn(`--- resident-process failure classification: ${RESIDENT_PROCESS_PREFLIGHT.status} ---`);
  appendLogLn(JSON.stringify(RESIDENT_PROCESS_PREFLIGHT));
  if (RESIDENT_PROCESS_PREFLIGHT.status === "ENVIRONMENT_BLOCKED") {
    return {
      status: "environment_blocked",
      reason: `environment blocked after ${codeFailure}: ${RESIDENT_PROCESS_PREFLIGHT.reason}`,
    };
  }
  return { status: "failed", reason: codeFailure };
}

// ── result writer (atomic via .tmp + rename) ────────────────────────────────
function writeResult(status: string, studioCommit: string, failureReason: string, conflictFiles: string): void {
  if (ROLE_CLOSE_OUTCOME === undefined) {
    const roleBinding = req.role_binding as RoleBindingReference | undefined;
    const roleClose = req.role_close as RoleCloseReference | undefined;
    const terminalStatuses: RoleCloseGateStatus[] = ["success", "failed", "conflict", "aborted", "stale_base", "environment_blocked"];
    if (!roleBinding || !roleClose || !MG_PM_ID || !terminalStatuses.includes(status as RoleCloseGateStatus)) {
      ROLE_CLOSE_OUTCOME = null;
    } else {
      try {
        ROLE_CLOSE_OUTCOME = recordRoleCloseGateOutcome({
          project_root: PROJECT_ROOT_FOR_PARSE, pm_id: MG_PM_ID, identity: roleBinding.identity,
          generation: roleBinding.generation, expect_digest: roleBinding.binding_digest,
          close_reference: roleClose, request_id: REQUEST_ID, status: status as RoleCloseGateStatus,
          failure_reason: failureReason || null, writer: { role: "merge-gate", id: REQUEST_ID },
        });
      } catch (error) {
        ROLE_CLOSE_OUTCOME = { error: (error as Error).message };
        appendLogLn(`role close gate-outcome record failed closed: ${(error as Error).message}`);
      }
    }
  }
  const ended = isoNow();
  const durationMs = (Math.floor(Date.now() / 1000) - STARTED_EPOCH) * 1000;

  const r: string[] = [];
  r.push("{");
  r.push(`  "request_id": "${jesc(REQUEST_ID)}",`);
  r.push(`  "status": "${status}",`);
  r.push(`  "workbench_branch": "${jesc(WORKBENCH_BRANCH)}",`);
  r.push(`  "role_close_outcome": ${JSON.stringify(ROLE_CLOSE_OUTCOME)},`);
  r.push(REVIEW_RESOLVED_TARGET_SHA ? `  "workbench_tip": "${REVIEW_RESOLVED_TARGET_SHA}",` : `  "workbench_tip": null,`);
  r.push(EXECUTION_ROUTE ? `  "execution_route": "${EXECUTION_ROUTE}",` : `  "execution_route": null,`);
  r.push(EXPECTED_STUDIO_SHA ? `  "expected_studio_sha": "${jesc(EXPECTED_STUDIO_SHA)}",` : `  "expected_studio_sha": null,`);
  r.push(OBSERVED_STUDIO_SHA ? `  "observed_studio_sha": "${jesc(OBSERVED_STUDIO_SHA)}",` : `  "observed_studio_sha": null,`);
  if (CONTROL_SCHEMA_VERSION === 3) {
    r.push(`  "control_schema_version": ${CONTROL_SCHEMA_VERSION},`);
    r.push(`  "work_id": "${jesc(CONTROL_WORK_ID)}",`);
    r.push(`  "control_session_id": "${jesc(CONTROL_SESSION_ID)}",`);
    r.push(`  "control_update": ${JSON.stringify(CONTROL_UPDATE)},`);
  }
  if (status === "success" && TASK_MIRROR_HINT) r.push(`  "task_mirror_hint": "${jesc(TASK_MIRROR_HINT)}",`);
  r.push(studioCommit ? `  "studio_commit": "${studioCommit}",` : `  "studio_commit": null,`);
  r.push(`  "started_at": "${STARTED_AT}",`);
  r.push(`  "ended_at": "${ended}",`);
  r.push(`  "duration_ms": ${durationMs},`);
  r.push(`  "preflight_steps": [${PREFLIGHT_STEPS_JSON}],`);
  r.push(`  "gate_steps": [${GATE_STEPS_JSON}],`);
  r.push(`  "run_verify_steps": [${RUN_VERIFY_STEPS_JSON}],`);
  r.push(`  "dispatch_env_diagnostics": ${JSON.stringify(MERGE_LANE_DIAGNOSTICS)},`);
  r.push(`  "resident_process_preflight": ${JSON.stringify(RESIDENT_PROCESS_PREFLIGHT)},`);
  r.push(`  "gate_mode": "${GATE_MODE}",`);
  r.push(`  "requested_preflight_commands": ${JSON.stringify(PREFLIGHT_COMMANDS)},`);
  r.push(`  "requested_quality_gate_commands": ${JSON.stringify(QUALITY_GATE_COMMANDS)},`);
  r.push(`  "effective_gate_commands": ${JSON.stringify(EFFECTIVE_GATE_COMMANDS)},`);
  r.push(`  "merge_gate_config": ${JSON.stringify(MG_CONFIG_SOURCE)},`);
  r.push(`  "data_only_file_count": ${DATA_ONLY_FILE_COUNT},`);
  r.push(GUARDIAN_VERDICT_BOUND_BY ? `  "guardian_verdict_bound_by": "${GUARDIAN_VERDICT_BOUND_BY}",` : `  "guardian_verdict_bound_by": null,`);
  r.push(OBSERVER_VERDICT_BOUND_BY ? `  "observer_verdict_bound_by": "${OBSERVER_VERDICT_BOUND_BY}",` : `  "observer_verdict_bound_by": null,`);
  r.push(req.guardian_required === true ? `  "guardian_review_sha": ${JSON.stringify(req.guardian_review_sha ?? null)},` : `  "guardian_review_sha": null,`);
  r.push(req.guardian_required === true ? `  "guardian_resolved_target_sha": ${JSON.stringify(REVIEW_RESOLVED_TARGET_SHA || null)},` : `  "guardian_resolved_target_sha": null,`);
  r.push(req.observer_required === true ? `  "observer_review_sha": ${JSON.stringify(req.observer_review_sha ?? null)},` : `  "observer_review_sha": null,`);
  r.push(req.observer_required === true ? `  "observer_resolved_target_sha": ${JSON.stringify(REVIEW_RESOLVED_TARGET_SHA || null)},` : `  "observer_resolved_target_sha": null,`);
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

  // The durable Control transaction must snapshot an already-written gate result.
  // Runtime remains transient: on success recordMergeControlOutcome copies/seals
  // the required artifacts below control/reports in the same transaction as Work.
  if (CONTROL_SCHEMA_VERSION === 3 && !CONTROL_UPDATE) {
    if (!CONTROL_WORK_ID || !CONTROL_SESSION_ID || !MG_PM_ID) {
      CONTROL_UPDATE = { status: "error", error: `schema-v${CONTROL_SCHEMA_VERSION} merge request lost work/session/pm binding` };
    } else {
      try {
        const roots = garelierControlRoots(PROJECT_ROOT_FOR_PARSE, TARGET_ROOT, MG_PM_ID);
        const guard = acquireGarelierOperationGuard(roots, `merge-gate-${STEM}-${process.pid}`, "merge-gate-control-settlement");
        try {
          // The project gate may outlive claim_ttl_seconds. Renew the exact
          // dispatch-bound claim after the merge and before the Control
          // transaction; this keeps the successful result strict without
          // requiring an operator to race the gate with a heartbeat.
          if (status === "success") {
            const binding = inspectDispatchControlBinding(roots, CONTROL_WORK_ID, CONTROL_SESSION_ID, guard.lock);
            if (!binding.claim) throw new Error(`merge-bound Backlog has no active claim: ${CONTROL_WORK_ID}`);
            claimDispatchControlWork({
              roots,
              workId: CONTROL_WORK_ID,
              sessionId: CONTROL_SESSION_ID,
              touches: binding.claim.touches,
              mergeBound: true,
              namespaceLock: guard.lock,
            });
          }
          const update = recordMergeControlOutcome({
            roots,
            workId: CONTROL_WORK_ID,
            sessionId: CONTROL_SESSION_ID,
            namespaceLock: guard.lock,
            outcome: {
            status: status === "success"
              ? "success"
              : status === "conflict"
                ? "conflict"
                : status === "failed"
                  ? "failed"
                  : status === "environment_blocked"
                    ? "environment_blocked"
                    : "aborted",
            commit: studioCommit || undefined,
            requestPath: REQUEST_JSON,
            resultPath: RESULT_FINAL,
            reportPath: ROLE_REPORT_PATH || undefined,
            guardianReportPath: GUARDIAN_REPORT_PATH || undefined,
            observerReportPath: OBSERVER_REPORT_PATH || undefined,
            failureReason: failureReason || undefined,
            },
          });
          CONTROL_UPDATE = { ...update, status: "ok", work_id: CONTROL_WORK_ID, session_id: CONTROL_SESSION_ID };
        } finally {
          guard.release();
        }
      } catch (error) {
        CONTROL_UPDATE = { status: "error", work_id: CONTROL_WORK_ID, session_id: CONTROL_SESSION_ID, error: (error as Error).message };
        appendLogLn(`control-v${CONTROL_SCHEMA_VERSION} update failed: ${(error as Error).message}`);
      }
    }
    try {
      const finalResult = JSON.parse(readFileSync(RESULT_FINAL, "utf8")) as Record<string, unknown>;
      finalResult.control_update = CONTROL_UPDATE;
      writeFileSync(RESULT_TMP, `${JSON.stringify(finalResult, null, 2)}\n`);
      renameSync(RESULT_TMP, RESULT_FINAL);
    } catch (error) {
      appendLogLn(`control-v${CONTROL_SCHEMA_VERSION} result annotation failed: ${(error as Error).message}`);
    }
  }

  const s: string[] = [];
  s.push("{");
  s.push(`  "schema_version": 1,`);
  s.push(`  "request_id": "${jesc(REQUEST_ID)}",`);
  s.push(`  "status": "${status}",`);
  s.push(`  "workbench_branch": "${jesc(WORKBENCH_BRANCH)}",`);
  s.push(`  "role_close_outcome": ${JSON.stringify(ROLE_CLOSE_OUTCOME)},`);
  s.push(REVIEW_RESOLVED_TARGET_SHA ? `  "workbench_tip": "${REVIEW_RESOLVED_TARGET_SHA}",` : `  "workbench_tip": null,`);
  s.push(EXECUTION_ROUTE ? `  "execution_route": "${EXECUTION_ROUTE}",` : `  "execution_route": null,`);
  s.push(EXPECTED_STUDIO_SHA ? `  "expected_studio_sha": "${jesc(EXPECTED_STUDIO_SHA)}",` : `  "expected_studio_sha": null,`);
  s.push(OBSERVED_STUDIO_SHA ? `  "observed_studio_sha": "${jesc(OBSERVED_STUDIO_SHA)}",` : `  "observed_studio_sha": null,`);
  if (CONTROL_SCHEMA_VERSION === 3) {
    s.push(`  "control_schema_version": ${CONTROL_SCHEMA_VERSION},`);
    s.push(`  "work_id": "${jesc(CONTROL_WORK_ID)}",`);
    s.push(`  "control_session_id": "${jesc(CONTROL_SESSION_ID)}",`);
    s.push(`  "control_update": ${JSON.stringify(CONTROL_UPDATE)},`);
  }
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
  s.push(`  "run_verify_steps": [${RUN_VERIFY_STEPS_SUMMARY_JSON}],`);
  s.push(`  "resident_process_preflight": ${JSON.stringify(RESIDENT_PROCESS_PREFLIGHT)},`);
  s.push(`  "requested_preflight_commands": ${JSON.stringify(PREFLIGHT_COMMANDS)},`);
  s.push(`  "requested_quality_gate_commands": ${JSON.stringify(QUALITY_GATE_COMMANDS)},`);
  s.push(`  "effective_gate_commands": ${JSON.stringify(EFFECTIVE_GATE_COMMANDS)},`);
  s.push(`  "merge_gate_config": ${JSON.stringify(MG_CONFIG_SOURCE)},`);
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
    const child = Bun.spawn([requireRuntimeExecutable("bun"), dmTs, "poll", "--pm-id", pm, "--project", PROJECT_ROOT_FOR_PARSE], { windowsHide: true,
      env: mergeGateEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    child.unref();
  } catch { /* best-effort */ }
}

// ── step-record appenders ───────────────────────────────────────────────────
function appendStep(target: "gate" | "preflight" | "run_verify", cmd: string, exitCode: number, durationMs: number, stdoutTail: string, stderrTail: string): void {
  const entry = `{"cmd":"${jesc(cmd)}","exit_code":${exitCode},"duration_ms":${durationMs},"stdout_tail":"${jesc(stdoutTail)}","stderr_tail":"${jesc(stderrTail)}"}`;
  const summary = `{"cmd":"${jesc(cmd)}","exit_code":${exitCode},"duration_ms":${durationMs}}`;
  if (target === "gate") {
    GATE_STEPS_JSON = GATE_STEPS_JSON ? `${GATE_STEPS_JSON},${entry}` : entry;
    GATE_STEPS_SUMMARY_JSON = GATE_STEPS_SUMMARY_JSON ? `${GATE_STEPS_SUMMARY_JSON},${summary}` : summary;
  } else if (target === "preflight") {
    PREFLIGHT_STEPS_JSON = PREFLIGHT_STEPS_JSON ? `${PREFLIGHT_STEPS_JSON},${entry}` : entry;
    PREFLIGHT_STEPS_SUMMARY_JSON = PREFLIGHT_STEPS_SUMMARY_JSON ? `${PREFLIGHT_STEPS_SUMMARY_JSON},${summary}` : summary;
  } else {
    RUN_VERIFY_STEPS_JSON = RUN_VERIFY_STEPS_JSON ? `${RUN_VERIFY_STEPS_JSON},${entry}` : entry;
    RUN_VERIFY_STEPS_SUMMARY_JSON = RUN_VERIFY_STEPS_SUMMARY_JSON ? `${RUN_VERIFY_STEPS_SUMMARY_JSON},${summary}` : summary;
  }
}

function archiveRequest(): void {
  try { renameSync(REQUEST_JSON, `${ARCHIVE_DIR}/${STEM}.request.json`); } catch { /* best-effort */ }
}

function clearMergeOwnershipMarkerIfMine(): void {
  try {
    const marker = JSON.parse(readFileSync(MERGE_OWNERSHIP_MARKER, "utf8")) as Record<string, unknown>;
    if (marker.request_id === REQUEST_ID && String(marker.owner_pid ?? "") === MG_OWNER_PID) {
      rmSync(MERGE_OWNERSHIP_MARKER, { force: true });
    }
  } catch { /* absent, malformed, or another runner's marker */ }
  try { rmSync(MERGE_OWNERSHIP_MARKER_TMP, { force: true }); } catch { /* best-effort */ }
}

function persistMergeOwnershipMarker(sourceSha: string): boolean {
  const marker = {
    schema_version: 1,
    request_id: REQUEST_ID,
    owner_pid: Number(MG_OWNER_PID),
    target_root: TARGET_ROOT,
    merge_head: sourceSha,
    source_sha: sourceSha,
  };
  try {
    writeFileSync(MERGE_OWNERSHIP_MARKER_TMP, JSON.stringify(marker, null, 2) + "\n", "utf8");
    renameSync(MERGE_OWNERSHIP_MARKER_TMP, MERGE_OWNERSHIP_MARKER);
    return true;
  } catch (e) {
    MERGE_OWNERSHIP_MARKER_ERROR = (e as Error).message;
    try { rmSync(MERGE_OWNERSHIP_MARKER_TMP, { force: true }); } catch { /* best-effort */ }
    return false;
  }
}

function clearLockIfMine(): void {
  clearMergeOwnershipMarkerIfMine();
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

function mergeHeadOids(): string[] | null {
  const pathProbe = git(["rev-parse", "--git-path", "MERGE_HEAD"]);
  if (pathProbe.code !== 0 || !pathProbe.stdout.trim()) return null;
  const path = resolve(TARGET_ROOT, pathProbe.stdout.trim());
  if (!existsSync(path)) return [];
  try {
    const oids = readFileSync(path, "utf8").split(/\s+/).filter(Boolean);
    return oids.length > 0 && oids.every((oid) => /^[0-9a-f]{40,64}$/i.test(oid)) ? oids : null;
  } catch {
    return null;
  }
}

function retainGateOwnedMerge(source: string, phase: string): boolean {
  MERGE_OWNERSHIP_MARKER_ERROR = "";
  if (!STUDIO_BASELINE_VERIFIED) {
    appendLogLn(`--- ${phase}: merge ownership NOT retained because the clean baseline was not verified ---`);
    return false;
  }
  const sourceProbe = git(["rev-parse", "--verify", `${source}^{commit}`]);
  const sourceTip = sourceProbe.code === 0 ? sourceProbe.stdout.trim() : "";
  const mergeHeads = mergeHeadOids();
  if (!sourceTip || !mergeHeads || mergeHeads.length !== 1 || mergeHeads[0] !== sourceTip) {
    appendLogLn(`--- ${phase}: merge ownership NOT retained; MERGE_HEAD does not uniquely match ${source} ---`);
    return false;
  }
  GATE_OWNED_MERGE_HEAD = sourceTip;
  if (!persistMergeOwnershipMarker(sourceTip)) {
    appendLogLn(`--- ${phase}: durable merge ownership marker write FAILED; aborting the still-proven merge (${MERGE_OWNERSHIP_MARKER_ERROR}) ---`);
    abortGateOwnedMerge("ownership marker persistence failure");
    return false;
  }
  appendLogLn(`--- ${phase}: gate-owned MERGE_HEAD retained (${sourceTip}) ---`);
  return true;
}

function abortGateOwnedMerge(reason: string): boolean {
  if (!GATE_OWNED_MERGE_HEAD) {
    appendLogLn(`--- merge abort skipped (${reason}): this gate has no owned MERGE_HEAD marker ---`);
    return false;
  }
  const mergeHeads = mergeHeadOids();
  if (!mergeHeads || mergeHeads.length !== 1 || mergeHeads[0] !== GATE_OWNED_MERGE_HEAD) {
    appendLogLn(`--- merge abort skipped (${reason}): current MERGE_HEAD is absent, unreadable, or not gate-owned ---`);
    GATE_OWNED_MERGE_HEAD = "";
    clearMergeOwnershipMarkerIfMine();
    return false;
  }
  const aborted = git(["merge", "--abort"]).code === 0;
  appendLogLn(`--- merge abort ${aborted ? "completed" : "failed"} (${reason}): gate-owned MERGE_HEAD ${GATE_OWNED_MERGE_HEAD} ---`);
  if (aborted) {
    GATE_OWNED_MERGE_HEAD = "";
    clearMergeOwnershipMarkerIfMine();
  }
  return aborted;
}

// ── cleanup/abort (crashes + SIGTERM/SIGINT) ────────────────────────────────
function cleanupAndAbort(signal: string, teardown: boolean): never {
  if (teardown) mgTeardown = true;
  appendLog(`\n=== cleanup_and_abort: signal=${signal} at ${isoNow()} ===\n`);
  abortGateOwnedMerge(`cleanup signal=${signal}`);
  if (!STATUS) {
    // W-054 landed-check (shared, bun-tested helper): did the merge already land
    // despite the crash/signal? The merge_gate_landed_check.test.ts parity oracle
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

function requireCleanStudioBaseline(phase: string): void {
  STUDIO_BASELINE_VERIFIED = false;
  const mergeHeads = mergeHeadOids();
  if (mergeHeads === null || mergeHeads.length > 0) {
    STATUS = "failed";
    FAILURE_REASON = mergeHeads === null
      ? "could not inspect MERGE_HEAD; refusing to start because merge-state ownership is unproven. The gate left Git state untouched."
      : `a pre-existing merge is already in progress (${mergeHeads.length} MERGE_HEAD entr${mergeHeads.length === 1 ? "y" : "ies"}). ` +
        "The gate did not start or abort it. Finish or abort that merge manually after preserving any staged work, then rerun the land.";
    appendLog(`\n--- clean studio baseline (${phase}): FAILED (${FAILURE_REASON}) ---\n`);
    writeResult("failed", "", FAILURE_REASON, "null");
    archiveRequest(); clearLockIfMine(); done(0);
  }
  const stagedProbe = git(["diff", "--cached", "--name-only", "-z"]);
  const baseline = classifyStudioIndexBaseline(stagedProbe.code === 0 ? nulList(stagedProbe.stdout) : null);
  if (baseline.clean) {
    STUDIO_BASELINE_VERIFIED = true;
    return;
  }
  STATUS = "failed";
  FAILURE_REASON = baseline.failureReason ?? "studio index baseline precondition failed";
  appendLog(`\n--- clean studio baseline (${phase}): FAILED (${FAILURE_REASON}) ---\n`);
  writeResult("failed", "", FAILURE_REASON, "null");
  archiveRequest(); clearLockIfMine(); done(0);
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
  // W-175 d: run every gate step relative to the request's trusted target root, not
  // the process cwd it was launched from (a manual rescue from the PM's cwd failed a
  // census on a relative path). git() already pins cwd=TARGET_ROOT; this makes the
  // quality-gate commands (spawned without an explicit cwd) target-root-relative too.
  try { process.chdir(TARGET_ROOT); } catch { /* trusted+existing; best-effort */ }
  // ── log header ────────────────────────────────────────────────────────────
  let header = "";
  header += `=== merge-gate.ts request ${REQUEST_ID} ===\n`;
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
  for (const diagnostic of MERGE_LANE_DIAGNOSTICS) appendLogLn(diagnostic);

  if (GUARDIAN_VERDICT_BOUND_BY === "tree") appendLog(`\n--- guardian gate: tree-identical amend accepted (G-15 tree fallback, W-035) ---\n`);
  if (OBSERVER_VERDICT_BOUND_BY === "tree") appendLog(`\n--- observer gate: tree-identical amend accepted (stale-verdict tree fallback, W-062) ---\n`);

  // ── acquire active-lock BEFORE any gate work (W-076) ──────────────────────
  const acq = acquireActiveLock();
  if (acq === 10 || acq === 11) {
    const why = acq === 11
      ? `second runner for request ${REQUEST_ID} — a live sibling already owns it (W-076)`
      : `request ${REQUEST_ID} is queued behind a live active.lock — the holder drains the queue on completion`;
    appendLog(`\n=== exiting without staging: acquire_active_lock rc=${acq} — ${why} ===\n`);
    // W-175 g: no silent exit — the invoker (a manual rescue) sees why it stopped.
    errln(`merge-gate: exiting without staging (rc=${acq}) — ${why}; log: ${LOG_FILE}`);
    done(0);
  }

  // ── W-346 FR5: closure chokepoint IN the gate process itself ──────────────
  // A direct `bun merge-gate.ts <request.json>` can no longer bypass a closure
  // lease: the same guard pollMergeGate consults runs here, before any studio
  // git operation. On refusal the gate exits WITHOUT staging, WITHOUT writing
  // a result, and WITHOUT archiving — the request waits byte-identical in
  // place (FR7); only its own active.lock is released.
  {
    const closureCtx: ChokepointContext = (() => {
      try {
        const bytes = readFileSync(REQUEST_JSON);
        const payloadDigest = sha256Hex(bytes.toString("utf8"));
        const kind = req.closure_request_kind;
        if (kind === "smith" || kind === "recovery") {
          return { requestKind: kind, requestId: typeof req.closure_request_id === "string" ? req.closure_request_id : null, payloadDigest };
        }
        return { requestKind: "ordinary", payloadDigest };
      } catch {
        return { requestKind: "ordinary" };
      }
    })();
    const closureVerdict = assertChokepointAllowed(PROJECT_ROOT_FOR_PARSE, MG_PM_ID, STUDIO_BRANCH, closureCtx);
    if (!closureVerdict.allowed) {
      appendLog(`\n=== exiting without staging: closure chokepoint refused — ${closureVerdict.reason} (W-346 FR5/FR7) ===\n`);
      errln(`merge-gate: closure lease blocks request ${REQUEST_ID}: ${closureVerdict.reason}; the request stays queued byte-identical; log: ${LOG_FILE}`);
      clearLockIfMine();
      done(0);
    }
  }

  if (CONTROL_REQUEST_BINDING_ERROR) {
    STATUS = "failed";
    FAILURE_REASON = CONTROL_REQUEST_BINDING_ERROR;
    appendLog(`\n--- control-v2 request binding: REFUSED ---\n${CONTROL_REQUEST_BINDING_ERROR}\n`);
    writeResult("failed", "", FAILURE_REASON, "null");
    archiveRequest(); clearLockIfMine(); done(0);
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
      const cfg = MG_SETUP_CONFIG;
      if (existsSync(policyTs) && MG_PM_ID && existsSync(cfg)) {
        refuterHsWhy = runSync(["bun", policyTs, cfg, TARGET_ROOT_FOR_GIT, STUDIO_BRANCH, WORKBENCH_BRANCH, "false", "high-stakes"]).stdout.trim();
      }
    }
    if (refuterHsWhy) {
      REFUTER_WARNING = `high-stakes merge landed without a refuter verdict (W-066 advisory, non-blocking): ${refuterHsWhy}`;
      appendLog(`\n--- refuter gate: ADVISORY WARN — ${REFUTER_WARNING} ---\n`);
    }
  }

  // Queue residence is an authority boundary: re-read the canonical current
  // generation immediately before the first checkout/merge operation. A request
  // that was valid at submit time may have been superseded while it waited.
  try {
    const roleBinding = req.role_binding as RoleBindingReference | undefined;
    const roleClose = req.role_close as RoleCloseReference | undefined;
    if (!roleBinding || roleBinding.schema_version !== 1 || !MG_PM_ID || !ROLE_REPORT_PATH) {
      throw new Error("request has no canonical role_binding/report/pm identity");
    }
    validateRoleBinding({
      project_root: PROJECT_ROOT_FOR_PARSE, pm_id: MG_PM_ID,
      identity: roleBinding.identity, stage: "merge_gate",
      generation: roleBinding.generation,
      expected_digest: roleBinding.binding_digest,
      candidate_sha: REVIEW_RESOLVED_TARGET_SHA,
      report_path: ROLE_REPORT_PATH,
      ledger_path: resolve(PROJECT_ROOT_FOR_PARSE, DISPATCH_CONTAINER || dirname(ROLE_REPORT_PATH), "instructions.md"),
      close_reference: roleClose,
    });
  } catch (error) {
    STATUS = "failed";
    FAILURE_REASON = `role binding backstop refused queued request: ${(error as Error).message}`;
    appendLog(`\n--- role binding backstop: REFUSED ---\n${FAILURE_REASON}\n`);
    writeResult("failed", "", FAILURE_REASON, "null");
    archiveRequest(); clearLockIfMine(); done(0);
  }

  // Check before checkout so switching branches or the W-077 self-heal never
  // touches a user-owned staged baseline. Re-check once attached to studio to
  // close the concurrent-add window before the first merge operation.
  requireCleanStudioBaseline("before checkout");

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

  requireCleanStudioBaseline("after studio checkout");

  // ── Step 2: pre-merge base tracking (target -> studio) ────────────────────
  if (PRE_MERGE_BASE_TRACKING === "true") {
    const setupConfig = MG_SETUP_CONFIG;
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
          retainGateOwnedMerge(targetBranch, "base-tracking merge failure");
          abortGateOwnedMerge("base-tracking merge failure");
          STATUS = "conflict";
          FAILURE_REASON = `base-tracking merge of ${targetBranch} into studio produced conflicts`;
          writeResult("conflict", "", FAILURE_REASON, conflictJson(cf));
          archiveRequest(); clearLockIfMine(); done(0);
        }
      }
    }
  }

  // An Artisan request is queued against the exact studio base it reviewed and
  // built from. Re-check that optimistic precondition at the last safe point:
  // after target→studio base tracking, immediately before staging the satchel.
  // If tracking or any concurrent integration advanced studio, terminate
  // stale_base without attempting the Artisan merge.
  OBSERVED_STUDIO_SHA = (() => {
    const r = git(["rev-parse", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : "";
  })();
  if (EXPECTED_STUDIO_SHA && OBSERVED_STUDIO_SHA !== EXPECTED_STUDIO_SHA) {
    STATUS = "stale_base";
    FAILURE_REASON = `studio HEAD changed since request submission (expected ${EXPECTED_STUDIO_SHA}, observed ${OBSERVED_STUDIO_SHA || "<unresolved>"})`;
    appendLog(`\n--- expected studio precondition: STALE_BASE (${FAILURE_REASON}); refusing to stage ${WORKBENCH_BRANCH} ---\n`);
    writeResult("stale_base", "", FAILURE_REASON, "null");
    archiveRequest(); clearLockIfMine(); done(0);
  }

  // ── Step 3: merge the workbench ───────────────────────────────────────────
  // W-175 R1: HARD ownership re-verify right before the destructive merge. Two
  // runners can transiently both win a dead-lock reclaim (the write→re-read window);
  // the lock settles to the last writer during the gate steps, so ONLY the current
  // owner may stage. A runner that no longer owns the lock backs off — its request
  // is left un-archived (unprocessed) so the queue drains it later — rather than a
  // second `git merge` clobbering the shared index.
  const preStageLock = `${LOCK_DIR}/active.lock`;
  if (!existsSync(preStageLock)) {
    try { writeFileSync(preStageLock, lockJson()); } catch { /* ignore */ }
    appendLogLn("--- step 3 pre-stage: active.lock was absent, recreated before staging (W-076) ---");
  } else if (!ownsActiveLock(lockField(preStageLock, "request_id"), lockField(preStageLock, "pid"), REQUEST_ID, MG_OWNER_PID)) {
    appendLogLn(`--- step 3 pre-stage: active.lock now owned by req='${lockField(preStageLock, "request_id")}' pid='${lockField(preStageLock, "pid")}' (mine=${REQUEST_ID}/${MG_OWNER_PID}) — another runner won the slot; backing off WITHOUT merging (W-175 R1) ---`);
    errln(`merge-gate: request ${REQUEST_ID} lost the active.lock before staging; exiting without merging (its request stays queued). log: ${LOG_FILE}`);
    clearLockIfMine(); // no-op on the active.lock (not mine); releases any heavy lock + drains the queue
    done(0);
  }
  appendLog("\n");
  appendLogLn(`--- step 3: git merge --no-ff --no-commit ${WORKBENCH_BRANCH} ---`);
  GATE_OWNED_MERGE_HEAD = "";
  if (!gitLogged(["merge", "--no-ff", "--no-commit", WORKBENCH_BRANCH])) {
    retainGateOwnedMerge(WORKBENCH_BRANCH, "workbench merge failure");
    const cf = git(["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter((f) => f);
    if (cf.length > 0) {
      STATUS = "conflict";
      abortGateOwnedMerge("workbench merge conflict");
      FAILURE_REASON = `merge produced ${cf.length} conflicted files`;
      writeResult("conflict", "", FAILURE_REASON, conflictJson(cf));
    } else {
      STATUS = "failed";
      abortGateOwnedMerge("workbench merge failure");
      FAILURE_REASON = "git merge failed (no conflict markers); see log";
      writeResult("failed", "", FAILURE_REASON, "null");
    }
    archiveRequest(); clearLockIfMine(); done(0);
  }
  if (!retainGateOwnedMerge(WORKBENCH_BRANCH, "workbench merge")) {
    if (MERGE_OWNERSHIP_MARKER_ERROR) {
      STATUS = "failed";
      FAILURE_REASON =
        `merge ownership marker could not be persisted atomically; the proven gate-owned merge was aborted and the gate stopped: ${MERGE_OWNERSHIP_MARKER_ERROR}`;
      writeResult("failed", "", FAILURE_REASON, "null");
      archiveRequest(); clearLockIfMine(); done(0);
    }
    const mergeHeads = mergeHeadOids();
    const cachedClean = git(["diff", "--cached", "--quiet"]).code === 0;
    if (!(mergeHeads?.length === 0 && cachedClean)) {
      STATUS = "failed";
      FAILURE_REASON =
        "merge started but the gate could not bind MERGE_HEAD to the requested workbench tip; refusing to continue or abort unowned Git state. Inspect MERGE_HEAD and the index manually.";
      writeResult("failed", "", FAILURE_REASON, "null");
      archiveRequest(); clearLockIfMine(); done(0);
    }
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
      // W-249: this spawns the PROJECT's own preflight command (cargo/scripts, same
      // class as gate_runner.ts's runStep) — gateCommandEnv(), not the plumbing-only
      // gateEnv(), so it gets the full MINIMAL_ENV_KEYS minimization.
      const exitCode = await runGateCommand(cmd, outFile, errFile, TIMEOUT_SECS, undefined, mergeGateCommandEnv());
      const cmdEnd = Math.floor(Date.now() / 1000);
      const durationMs = (cmdEnd - cmdStart) * 1000;
      const stdout = readOrEmpty(outFile); const stderr = readOrEmpty(errFile);
      appendLog(stdout); appendLog(stderr);
      const stdoutTail = tailC(outFile, 800); const stderrTail = tailC(errFile, 800);
      rmSyncSafe(outFile); rmSyncSafe(errFile);
      appendStep("preflight", cmd, exitCode, durationMs, stdoutTail, stderrTail);
      if (exitCode !== 0) {
        const classified = classifyProjectCommandFailure("preflight", cmd, exitCode, TIMEOUT_SECS, `${stdout}\n${stderr}`);
        STATUS = classified.status;
        abortGateOwnedMerge("preflight failure");
        FAILURE_REASON = classified.reason;
        writeResult(STATUS, "", FAILURE_REASON, "null");
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
    appendLog(`\n--- step 4-lock: heavy_compile_lock acquire token=${HEAVY_LOCK_TOKEN || "<none>"} (W-156 queue-wait; OPEN=ABORT) ---\n`);
    if (!HEAVY_LOCK_TOKEN || HEAVY_LOCK_TOKEN === "OPEN") {
      STATUS = "failed";
      abortGateOwnedMerge("heavy-compile lock failure");
      FAILURE_REASON = "heavy_compile_lock infrastructure unavailable (OPEN/empty); lockless quality-gate execution is prohibited (W-156)";
      writeResult("failed", "", FAILURE_REASON, "null");
      archiveRequest(); clearLockIfMine(); done(0);
    }
  }

  // ── Step 4: quality gate commands (or data-only substitute) ───────────────
  const ACTIVE_GATE_COMMANDS = GATE_MODE === "data_only" ? DATA_ONLY_COMMANDS : QUALITY_GATE_COMMANDS;
  EFFECTIVE_GATE_COMMANDS = [...ACTIVE_GATE_COMMANDS];
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
    // W-249: the project's own quality-gate command — gateCommandEnv(), see the
    // preflight site above for why.
    let exitCode = await runGateCommand(cmd, outFile, errFile, TIMEOUT_SECS, undefined, mergeGateCommandEnv());
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
        // W-249: retry of the same project quality-gate command — gateCommandEnv().
        exitCode = await runGateCommand(cmd, outFile, errFile, TIMEOUT_SECS, undefined, mergeGateCommandEnv());
        const retryEnd = Math.floor(Date.now() / 1000);
        durationMs = durationMs + (retryEnd - retryStart) * 1000;
        appendLogLn(`--- gate retry result: exit ${exitCode} ---`);
        if (exitCode === 0) TRANSIENT_RETRY_JSON = `{"cmd":"${jesc(cmd)}","pattern":"${jesc(matched)}"}`;
      }
    }

    const stdout = readOrEmpty(outFile); const stderr = readOrEmpty(errFile);
    appendLog(stdout); appendLog(stderr);
    const stdoutTail = tailC(outFile, 800); const stderrTail = tailC(errFile, 800);
    rmSyncSafe(outFile); rmSyncSafe(errFile);
    LAST_GATE_EXIT = String(exitCode);
    appendStep("gate", cmd, exitCode, durationMs, stdoutTail, stderrTail);
    if (exitCode !== 0) {
      const classified = classifyProjectCommandFailure("quality gate", cmd, exitCode, TIMEOUT_SECS, `${stdout}\n${stderr}`);
      STATUS = classified.status;
      abortGateOwnedMerge("quality gate failure");
      FAILURE_REASON = classified.reason;
      writeResult(STATUS, "", FAILURE_REASON, "null");
      archiveRequest(); clearLockIfMine(); done(0);
    }
  }

  // ── Step 4b: run-verify commands (optional post-merge runtime gate) ────────
  const mgSetupConfig = MG_SETUP_CONFIG;
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
      // W-249: the project's own run-verify command — gateCommandEnv().
      const exitCode = await runGateCommand(cmd, outFile, errFile, TIMEOUT_SECS, undefined, mergeGateCommandEnv());
      const cmdEnd = Math.floor(Date.now() / 1000);
      const durationMs = (cmdEnd - cmdStart) * 1000;
      const stdout = readOrEmpty(outFile); const stderr = readOrEmpty(errFile);
      appendLog(stdout); appendLog(stderr);
      const stdoutTail = tailC(outFile, 800); const stderrTail = tailC(errFile, 800);
      rmSyncSafe(outFile); rmSyncSafe(errFile);
      appendStep("run_verify", cmd, exitCode, durationMs, stdoutTail, stderrTail);
      if (exitCode !== 0) {
        const classified = classifyProjectCommandFailure("run-verify", cmd, exitCode, TIMEOUT_SECS, `${stdout}\n${stderr}`);
        STATUS = classified.status;
        abortGateOwnedMerge("run-verify failure");
        FAILURE_REASON = classified.reason;
        writeResult(STATUS, "", FAILURE_REASON, "null");
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
      abortGateOwnedMerge("completed externally");
      writeResult("success", w066HeadNow, FAILURE_REASON, "null");
      archiveRequest(); clearLockIfMine(); done(0);
    }
    STATUS = "aborted";
    FAILURE_REASON = `W-066: HEAD moved during the gate (staged onto ${STAGED_ONTO_HEAD}, now ${w066HeadNow || "<none>"}; MERGE_HEAD ${mergeHeadPresent ? "present" : "GONE"}) — a commit on the shared main checkout absorbed or displaced the staged merge (the recurring PM-commit-during-gate incident). NOT committing a mislabeled/wrong merge. Recover: inspect the absorbing commit's content (usually intact), then re-run the land for ${WORKBENCH_BRANCH}; never commit to studio while runtime/merge_gate/locks/active.lock exists.`;
    abortGateOwnedMerge("HEAD moved during gate");
    writeResult("aborted", "", FAILURE_REASON, "null");
    archiveRequest(); clearLockIfMine(); done(1);
  }
  appendLog("\n");
  appendLogLn("--- step 5: git commit (merge message) ---");
  {
    const c = Bun.spawnSync([requireRuntimeExecutable("git"), "commit", "-F", "-"], { windowsHide: true, cwd: TARGET_ROOT, env: mergeGateCommitEnv(), stdin: Buffer.from(MERGE_MESSAGE), stdout: "pipe", stderr: "pipe" });
    appendLog((c.stdout?.toString() ?? "") + (c.stderr?.toString() ?? ""));
    if (c.exitCode !== 0) {
      // Unguarded in bash (relies on ERR trap → cleanup_and_abort). Mirror that.
      cleanupAndAbort("EXIT_NONZERO", false);
    }
  }
  const studioCommit = git(["rev-parse", "HEAD"]).stdout.trim();
  GATE_OWNED_MERGE_HEAD = "";
  clearMergeOwnershipMarkerIfMine();
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
