#!/usr/bin/env bun
// Garelier driver — entry point.
//
// Spawns the configured local provider CLI per role iteration:
// `claude -p` for claude-code or `codex exec` for codex-cli. Provider
// auth is whatever `claude login` / `codex login` configured.
//
// Usage:
//   bun run src/main.ts --pm-id <pm_id> [--project <path>] [--once] [--poll <seconds>]
//
// v2.1: every Garelier tree is namespaced under __garelier/<pm_id>/. The
// driver supervises ONE pm_id per process; launch one driver per PM.
// pm_id is resolved in this order:
//   1. --pm-id <id>            CLI flag
//   2. GARELIER_PM_ID env var (set by start_driver.{sh,ps1})
//   3. cwd path inference      (cwd inside __garelier/<pm_id>/... — convenience)
//
// Reads __garelier/<pm_id>/_pm/setup_config.toml from the project root,
// polls every driver_poll_interval_seconds, runs:
//   - PM iteration if supervise_pm = true and PM-interest files changed
//   - Dock iteration if Dock-interest files changed
//   - Worker iteration for each worker whose STATE is runnable and whose
//     interest files changed
//   - Scout iteration for each scout whose STATE is runnable and whose
//     interest files changed
//   - Smith iteration for each smith whose STATE is runnable and whose
//     interest files changed
//
// Stop: SIGINT, SIGTERM, or `touch __garelier/<pm_id>/runtime/driver/stop`.

import {
  existsSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, readFileSync,
  writeFileSync, renameSync, readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./log.ts";
import { loadConfig, ConfigError, validatePmId, DOCK_REORDERABLE_ROLES, type RunnerDef } from "./config.ts";
import { runIteration, type FinalActionKind } from "./role.ts";
import { roleContainer } from "./workspace.ts";
import { reportArtifact } from "./role_contracts.ts";
import {
  readDeliverableSidecarForMarkdown,
  deliverableSidecarSummary,
  type DeliverableSidecar,
} from "./deliverable_sidecar.ts";
import { pollMergeGate } from "./merge_gate.ts";
import { gcEphemeralBranches } from "./branch_gc.ts";
import type { RoleContext, RoleKind, DetachedAgentRole, RoleMailbox } from "./prompts.ts";
import {
  ChangeTracker,
  readAgentState,
  healRoleStateResidue,
  isAgentActive,
  type AgentStatus,
  type Signal,
  pmInterestPaths,
  dockInterestPaths,
  workerInterestPaths,
  scoutInterestPaths,
  smithInterestPaths,
  librarianInterestPaths,
  artisanInterestPaths,
  observerInterestPaths,
  guardianInterestPaths,
  conciergeInterestPaths,
} from "./state.ts";

interface CliArgs {
  projectRoot: string;
  pmId?: string;
  once: boolean;
  pollOverride?: number;
  spawnCmd?: string[];
  maxBudgetUsd?: number;
  // No-zombie lifecycle (DEC-042 follow-on): the PM's interactive `claude`
  // session PID. The driver is launched detached (survives the tool-call shell),
  // so closing the PM terminal would otherwise orphan it. When set, the driver
  // self-stops the moment this PID is gone — tying its lifetime to the PM
  // session. start_driver.{ps1,sh} discovers it.
  watchdogPid?: number;
}

function parseArgs(argv: string[]): CliArgs {
  let projectRoot = process.cwd();
  let pmId: string | undefined;
  let once = false;
  let pollOverride: number | undefined;
  let spawnCmd: string[] | undefined;
  let maxBudgetUsd: number | undefined;
  let watchdogPid: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") {
      projectRoot = resolve(argv[++i]);
    } else if (a === "--pm-id") {
      pmId = argv[++i];
    } else if (a === "--once") {
      once = true;
    } else if (a === "--poll") {
      pollOverride = parseInt(argv[++i], 10);
    } else if (a === "--spawn-cmd") {
      // Space-separated; e.g. "claude" or "echo test"
      spawnCmd = argv[++i].split(/\s+/);
    } else if (a === "--max-budget-usd") {
      maxBudgetUsd = parseFloat(argv[++i]);
    } else if (a === "--watchdog-pid") {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) watchdogPid = n;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return { projectRoot: resolve(projectRoot), pmId, once, pollOverride, spawnCmd, maxBudgetUsd, watchdogPid };
}

function printHelp(): void {
  process.stdout.write(
    `Garelier driver — spawns configured provider CLI per role iteration.\n\n` +
    `Usage: bun run src/main.ts --pm-id <pm_id> [options]\n\n` +
    `Options:\n` +
    `  --pm-id <id>            PM identity to supervise (REQUIRED, unless\n` +
    `                          GARELIER_PM_ID env var is set or cwd is\n` +
    `                          inside __garelier/<pm_id>/...).\n` +
    `  --project, -p <path>    Project root (default: cwd)\n` +
    `  --once                  Run one poll cycle and exit (smoke test)\n` +
    `  --poll <seconds>        Override [autonomy] driver_poll_interval_seconds\n` +
    `  --spawn-cmd <cmd>       Override provider spawn binary globally.\n` +
    `                          Default: 'claude' for claude-code, 'codex' for codex-cli.\n` +
    `                          Useful for tests: --spawn-cmd "echo test"\n` +
    `  --max-budget-usd <n>    Pass --max-budget-usd to Claude Code invocations\n` +
    `  --watchdog-pid <pid>    Self-stop when this PID (the PM's interactive claude\n` +
    `                          session) exits. Ties the driver to the PM terminal\n` +
    `                          so closing it leaves no zombies.\n` +
    `                          start_driver.{ps1,sh} sets this automatically.\n` +
    `  --help, -h              Show this help\n\n` +
    `Authentication: provider CLIs use their own login stores: 'claude login' or 'codex login'.\n\n` +
    `Environment:\n` +
    `  GARELIER_PM_ID         PM identity to supervise (alternative to --pm-id)\n` +
    `  GARELIER_CORE_DIR      Override path to garelier-core skill dir\n` +
    `  GARELIER_SPAWN_CMD     Override provider command globally (tests/debug only)\n` +
    `  GARELIER_MAX_BUDGET    Default --max-budget-usd if flag not passed\n` +
    `  DEBUG=1                 Verbose driver logging\n\n` +
    `Stop: touch __garelier/<pm_id>/runtime/driver/stop, or SIGINT/SIGTERM.\n`,
  );
}

/**
 * Infer pm_id from cwd if cwd is inside a per-PM subtree.
 * Returns undefined if cwd is not under __garelier/<pm_id>/...
 */
function inferPmIdFromCwd(projectRoot: string, cwd: string): string | undefined {
  const rootAbs = resolve(projectRoot);
  const cwdAbs = resolve(cwd);
  if (!cwdAbs.startsWith(rootAbs)) return undefined;
  const rel = cwdAbs.slice(rootAbs.length).split(sep).filter((p) => p.length > 0);
  if (rel.length >= 2 && rel[0] === "__garelier") {
    return rel[1];
  }
  return undefined;
}

/**
 * Skill docs the per-iteration prompts (prompts.ts `commonDocs` + the
 * role prompts) reference by absolute path. Only the role skills that
 * will actually be spawned are required, so a Worker-only or Scout-only
 * config doesn't fail on an unrelated role's skill. Keep this list in
 * sync with prompts.ts `commonDocs`.
 */
function requiredSkillDocs(skillCoreDir: string, config: ReturnType<typeof loadConfig>): string[] {
  const skillRoot = dirname(skillCoreDir);
  const docs = [
    join(skillCoreDir, "SKILL.md"),
    join(skillCoreDir, "protocol.md"),
    join(skillCoreDir, "state_machine.md"),
    join(skillCoreDir, "compact_handoff.md"),
  ];
  const roleSkills = ["garelier-dock"]; // Dock always runs
  if (config.autonomy.supervisePm) roleSkills.push("garelier-pm");
  if (config.workers.length > 0) roleSkills.push("garelier-worker");
  if (config.scouts.length > 0) roleSkills.push("garelier-scout");
  if (config.smiths.length > 0) roleSkills.push("garelier-smith");
  if (config.librarians.length > 0) roleSkills.push("garelier-librarian");
  if (config.observers.length > 0) roleSkills.push("garelier-observer");
  if (config.guardians.length > 0) roleSkills.push("garelier-guardian");
  if (config.concierges.length > 0) roleSkills.push("garelier-concierge");
  if (config.artisan) roleSkills.push("garelier-artisan");
  for (const rs of roleSkills) docs.push(join(skillRoot, rs, "SKILL.md"));
  return docs;
}

function resolvePmId(args: CliArgs): string {
  if (args.pmId) return args.pmId;
  const fromEnv = process.env.GARELIER_PM_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const fromCwd = inferPmIdFromCwd(args.projectRoot, process.cwd());
  if (fromCwd) return fromCwd;
  process.stderr.write(
    `Error: pm_id is required. v2.1 namespaces every PM under __garelier/<pm_id>/.\n` +
    `Provide it via one of:\n` +
    `  --pm-id <id>             CLI flag (recommended for explicit launches)\n` +
    `  GARELIER_PM_ID=<id>     env var (set by start_driver.{sh,ps1})\n` +
    `  cwd inside __garelier/<pm_id>/...   (auto-detected)\n\n` +
    `Example: bun run src/main.ts --pm-id alice --project /path/to/project\n`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = args.projectRoot;
  const pmId = resolvePmId(args);

  try {
    validatePmId(pmId);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  // Load config
  let config;
  try {
    config = loadConfig(root, pmId);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  if (!config.autonomy.enabled) {
    process.stderr.write(
      `Driver refuses to start: [autonomy] enabled != true in setup_config.toml.\n` +
      `Set enabled = true to opt into unattended execution.\n`,
    );
    process.exit(1);
  }
  if (config.setup && !config.setup.complete) {
    process.stderr.write(
      `Driver refuses to start: [setup] complete is not true. The setup wizard did not finish.\n` +
      `Re-run the setup wizard.\n`,
    );
    process.exit(1);
  }

  const pollSeconds = args.pollOverride ?? config.autonomy.pollIntervalSeconds;
  const pmRoot = `${root}/__garelier/${pmId}`;
  const driverDir = `${pmRoot}/runtime/driver`;
  const logsDir = `${driverDir}/logs`;
  const tmpDir = `${driverDir}/tmp`;
  const pidsDir = `${driverDir}/pids`;
  const pidFile = `${driverDir}/driver.pid`;
  const stopFile = `${driverDir}/stop`;
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(pidsDir, { recursive: true });

  // Resolve skill core dir (DEC-053: cache-safe + dual-mode). Order:
  //   1. GARELIER_CORE_DIR (explicit; set by start_driver / the plugin bootstrap)
  //   2. ${CLAUDE_PLUGIN_ROOT}/skills/garelier-core (plugin runtime)
  //   3. import.meta self-location (src -> driver -> garelier-core): works whether
  //      this file is symlinked OR in the read-only plugin cache
  //   4. legacy ~/.claude/skills/garelier-core (dev symlink last resort)
  const selfCoreDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const skillCoreDir = process.env.GARELIER_CORE_DIR
    ?? (process.env.CLAUDE_PLUGIN_ROOT ? join(process.env.CLAUDE_PLUGIN_ROOT, "skills", "garelier-core") : undefined)
    ?? (existsSync(join(selfCoreDir, "SKILL.md")) ? selfCoreDir : undefined)
    ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".claude/skills/garelier-core");

  // Fail loud if the skill docs the per-iteration prompts point at are
  // missing. Codex CLI roles cannot self-discover skills, so prompts.ts
  // injects these exact paths into every prompt; a missing file silently
  // turns a Codex iteration into a blind run. Claude Code roles also
  // `--add-dir` the skill dir, so a wrong skillCoreDir hurts both
  // providers. The README lists "Garelier skills installed" as a
  // prerequisite — this enforces it before any provider is spawned.
  const missingSkillDocs = requiredSkillDocs(skillCoreDir, config).filter((p) => !existsSync(p));
  if (missingSkillDocs.length > 0) {
    process.stderr.write(
      `Driver refuses to start: required Garelier skill docs are missing.\n` +
      `The driver injects these exact paths into every role prompt (Codex CLI cannot\n` +
      `self-discover skills), so a missing file would make that role run blind.\n\n` +
      `Resolved garelier-core dir: ${skillCoreDir}\n` +
      `Fix: set GARELIER_CORE_DIR, reinstall/update the garelier plugin, or re-run\n` +
      `install.{sh,ps1} (dev symlink mode).\n\n` +
      `Missing:\n` + missingSkillDocs.map((p) => `  - ${p}`).join("\n") + `\n`,
    );
    process.exit(1);
  }

  // Spawn command override and budget. When absent, role.ts chooses the
  // default command per provider (claude-code => claude, codex-cli => codex).
  const spawnCmd = args.spawnCmd
    ?? (process.env.GARELIER_SPAWN_CMD ? process.env.GARELIER_SPAWN_CMD.split(/\s+/) : undefined);
  const maxBudgetUsd = args.maxBudgetUsd
    ?? (process.env.GARELIER_MAX_BUDGET ? parseFloat(process.env.GARELIER_MAX_BUDGET) : undefined);

  // PID atomic claim (fail if another driver holds it)
  let pidFd: number;
  try {
    pidFd = openSync(pidFile, "wx");
    writeSync(pidFd, String(process.pid));
    closeSync(pidFd);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const existing = readFileSync(pidFile, "utf8").trim();
      const alive = isPidAlive(Number(existing));
      if (alive) {
        process.stderr.write(
          `Error: another driver is running for pm_id=${pmId} (pid ${existing}). To stop it: ` +
          `touch ${stopFile} (graceful) or kill ${existing} (immediate).\n`,
        );
        process.exit(1);
      }
      process.stderr.write(`Removing stale driver.pid (pid ${existing} not alive).\n`);
      unlinkSync(pidFile);
      pidFd = openSync(pidFile, "wx");
      writeSync(pidFd, String(process.pid));
      closeSync(pidFd);
    } else {
      throw e;
    }
  }

  // Clear stale stop file from prior shutdown
  if (existsSync(stopFile)) {
    try { unlinkSync(stopFile); } catch { /* ignore */ }
  }

  const log = new Logger("driver", `${logsDir}/driver.jsonl`, {
    maxBytes: config.outputControl.driverLogMaxBytes,
    keepFiles: config.outputControl.driverLogKeepFiles,
  }); // DEC-028 rotation; inherited by role child loggers via log.child()
  log.info("starting", {
    project: config.project.name,
    pm_id: pmId,
    root,
    target: config.branches.target,
    studio: config.branches.integration,
    poll_seconds: pollSeconds,
    supervise_pm: config.autonomy.supervisePm,
    auto_approve_blueprints: config.autonomy.autoApproveBlueprints,
    auto_approve_milestones: config.autonomy.autoApproveMilestones,
    workers: config.workers.map((w) => w.id),
    scouts: config.scouts.map((s) => s.id),
    smiths: config.smiths.map((s) => s.id),
    spawn_cmd_override: spawnCmd ? spawnCmd.join(" ") : null,
    runner: config.runner,
    max_budget_usd: maxBudgetUsd,
    skill_core_dir: skillCoreDir,
    watchdog_pid: args.watchdogPid ?? null, // PM session PID; driver self-stops when it exits (no zombies)
  });
  if (!config.autonomy.supervisePm) {
    log.info("hybrid_mode", {
      note: `PM is NOT supervised — run an interactive PM session in __garelier/${pmId}/_pm/ yourself`,
    });
  }

  const tracker = new ChangeTracker(`${driverDir}/change_tracker.json`);

  // Shutdown plumbing
  let stopRequested = false;
  let inIteration = false;
  const requestStop = (source: string) => {
    if (stopRequested) return;
    stopRequested = true;
    log.info("stop_requested", { source });
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  // No-zombie watchdog (DEC-042 follow-on). When --watchdog-pid is set, it is
  // the PM's interactive `claude` session. The driver was launched detached so it
  // survives the tool-call shell, but that means closing the PM terminal would
  // orphan it. Tie its lifetime to the PM session: stop the moment the watched
  // PID is gone. Checked each poll and during backoff sleep.
  const watchdogPid = args.watchdogPid;
  const watchdogDead = (): boolean => watchdogPid != null && !isPidAlive(watchdogPid);

  const cleanup = () => {
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    try { if (existsSync(stopFile)) unlinkSync(stopFile); } catch { /* ignore */ }
  };

  const shared: SharedState = {
    root,
    pmId,
    config,
    log,
    tracker,
    tmpDir,
    logsDir,
    pidsDir,
    skillCoreDir,
    spawnCmd,
    maxBudgetUsd,
    driverBootMs: Date.now(),   // DEC-027: for the alive-lease PID-reuse guard
    deferAges: new Map(),       // DEC-027: per-key deferral age for anti-starvation
    coordIdle: new Map(),       // no-op coordinator loop guard
  };

  try {
    while (!stopRequested) {
      if (existsSync(stopFile)) {
        requestStop("stop_file");
        break;
      }
      // No-zombie watchdog: the PM session is gone → stop the driver.
      if (watchdogDead()) {
        log.info("watchdog_stop", { watchdog_pid: watchdogPid, note: "PM interactive claude session exited — stopping driver (no zombies)." });
        requestStop("watchdog_pid_gone");
        break;
      }
      inIteration = true;
      await pollCycle(shared);
      inIteration = false;

      if (args.once || stopRequested) break;

      // Backoff for rate limits. Each consecutive rate-limited role
      // iteration multiplies the wait. With pollSeconds=60s defaults:
      //   1 hit  → ~60s (normal poll)
      //   2 hits → 2m
      //   3 hits → 4m
      //   4 hits → 8m
      //   5+ hits → 15m (capped)
      // Cap chosen so rate-limit windows that typically last 5-15 min
      // get one or two probes during the window plus immediate retry
      // once cleared. Successful iteration resets the counter.
      let waitMs = pollSeconds * 1000;
      const rlCount = shared.rateLimitConsecutive ?? 0;
      if (rlCount >= 2) {
        const mult = Math.min(Math.pow(2, rlCount - 1), 15); // 2,4,8,15
        const backoffMs = Math.min(mult * 60 * 1000, 15 * 60 * 1000);
        waitMs = Math.max(waitMs, backoffMs);
        log.warn("rate_limit_backoff", {
          consecutive: rlCount,
          wait_ms: waitMs,
          wait_human: `${Math.round(waitMs / 60000)}m`,
        });
      }
      await sleep(waitMs, () => stopRequested || existsSync(stopFile) || watchdogDead());
    }
    log.info("shutting_down", { in_iteration: inIteration });
  } finally {
    cleanup();
  }
}

interface SharedState {
  root: string;
  pmId: string;
  config: ReturnType<typeof loadConfig>;
  log: Logger;
  tracker: ChangeTracker;
  tmpDir: string;
  logsDir: string;
  pidsDir: string;
  skillCoreDir: string;
  spawnCmd?: string[];
  maxBudgetUsd?: number;
  // Rate-limit bookkeeping (set by invokeRole when a role iteration's
  // stderr looks like a 429 / rate_limit). The poll loop reads these
  // to apply backoff between iterations.
  rateLimitLastHitMs?: number;
  rateLimitConsecutive?: number;
  // Per-role failure circuit breaker: consecutive NON-rate-limit failures
  // (bad auth, repeated non-zero exit) per agent key, with a backoff deadline.
  // Stops one broken role from re-launching every poll forever. In-memory:
  // resets on a successful iteration or a driver restart.
  failures?: Map<string, { count: number; nextMs: number }>;
  // Per-role rate-limit brake. A provider rate-limit must PARK that specific
  // role for a self-expiring wall-clock window instead of re-launching it every
  // poll (the death-spiral: role hits limit -> invalidate -> relaunch -> re-hit).
  // Symmetric to `failures` but armed on the FIRST hit (a limit means "wait").
  // In-memory: cleared on a successful iteration or a driver restart.
  rateLimits?: Map<string, { count: number; nextMs: number }>;
  // PM/Dock no-op loop guard. A coordinator that repeatedly ends with
  // `no action` or explicit `coord_only` gets a short in-memory cooldown so
  // incidental coordination-file churn does not burn provider context.
  coordIdle: Map<string, { count: number; nextMs: number; lastKind: FinalActionKind }>;
  // DEC-027 concurrency cap: epoch ms the driver booted (PID-reuse guard for
  // the alive-lease count) and per-key deferral age (anti-starvation aging).
  driverBootMs: number;
  deferAges: Map<string, number>;
}

// Per-role circuit breaker threshold: after this many consecutive non-rate-limit
// failures, back off that role (capped 30m) instead of retrying every poll.
export const FAILURE_CIRCUIT_THRESHOLD = 5;

// Backoff (ms) for a role with `count` consecutive non-rate-limit failures.
// 0 below the threshold (retry next poll as before); then 1m, 2m, 4m, … capped
// at 30m. A successful iteration or a driver restart resets the count.
export function failureBackoffMs(count: number): number {
  if (count < FAILURE_CIRCUIT_THRESHOLD) return 0;
  const minutes = Math.min(Math.pow(2, count - FAILURE_CIRCUIT_THRESHOLD), 30);
  return minutes * 60 * 1000;
}

export const COORD_IDLE_GUARD_THRESHOLD = 2;

export function coordinatorIdleBackoffMs(count: number): number {
  if (count < COORD_IDLE_GUARD_THRESHOLD) return 0;
  const minutes = Math.min(Math.pow(2, count - COORD_IDLE_GUARD_THRESHOLD), 5);
  return minutes * 60 * 1000;
}

function inFailureBackoff(s: SharedState, key: string, now: number): boolean {
  const fb = s.failures?.get(key);
  return fb != null && now < fb.nextMs;
}

// Backoff (ms) for a role with `count` consecutive provider rate-limits. Unlike
// the failure breaker this arms on the FIRST hit — a rate-limit means "the
// provider is throttling, wait" — so count=1 already parks the role. 1m, 2m, 4m,
// … capped at 30m. The window is wall-clock and SELF-EXPIRING: the role becomes
// launch-eligible again after it passes even if no successful iteration ever
// occurred, so a cleared provider limit always resumes. A successful iteration
// or a driver restart resets the count.
export function rateLimitBackoffMs(count: number): number {
  if (count < 1) return 0;
  const minutes = Math.min(Math.pow(2, count - 1), 30);
  return minutes * 60 * 1000;
}

function inRateLimitBackoff(s: SharedState, key: string, now: number): boolean {
  const rl = s.rateLimits?.get(key);
  return rl != null && now < rl.nextMs;
}

// Record a provider rate-limit for `key`: bump the per-role brake (parks it for a
// self-expiring window) AND the global streak (drives the coarse poll-loop
// backoff). Returns the per-role backoff applied, for logging.
function noteRateLimit(s: SharedState, key: string, now: number): number {
  if (!s.rateLimits) s.rateLimits = new Map();
  const rl = s.rateLimits.get(key) ?? { count: 0, nextMs: 0 };
  rl.count += 1;
  const backoff = rateLimitBackoffMs(rl.count);
  rl.nextMs = now + backoff;
  s.rateLimits.set(key, rl);
  s.rateLimitLastHitMs = now;
  s.rateLimitConsecutive = (s.rateLimitConsecutive ?? 0) + 1;
  return backoff;
}

function inCoordinatorIdleBackoff(s: SharedState, key: string, now: number): boolean {
  const idle = s.coordIdle.get(key);
  return idle != null && now < idle.nextMs;
}

// DEC-035: every detached role's RESOLVED physical container, for the
// Dock / PM prompts (they scan STATE.md and write assignment/review/abort
// into these dirs — the in-project `_<role>/<id>/` path may be exiled away).
function buildRoster(root: string, pmId: string, config: ReturnType<typeof loadConfig>): RoleMailbox[] {
  const out: RoleMailbox[] = [];
  const add = (role: DetachedAgentRole, id: string) =>
    out.push({ role, id, container: roleContainer(root, pmId, role, id) });
  for (const w of config.workers) add("worker", w.id);
  for (const sc of config.scouts) add("scout", sc.id);
  for (const sm of config.smiths) add("smith", sm.id);
  for (const l of config.librarians) add("librarian", l.id);
  for (const o of config.observers) add("observer", o.id);
  for (const g of config.guardians) add("guardian", g.id);
  for (const c of config.concierges) add("concierge", c.id);
  if (config.artisan) add("artisan", "");
  return out;
}

export function buildRoleStatusSummary(
  roster: RoleMailbox[],
  readState: (stateFile: string) => { status: AgentStatus; lastActivity?: string } = readAgentState,
  readSidecar: (reportPath: string) => DeliverableSidecar | null = readDeliverableSidecarForMarkdown,
): string {
  return roster.map((m) => {
    const st = readState(`${m.container}/STATE.md`);
    const label = m.id ? `${m.role} ${m.id}` : `${m.role}`;
    const last = st.lastActivity
      ? `; last=${st.lastActivity.replace(/\s+/g, " ").slice(0, 120)}`
      : "";
    // DEC-049 D — context diet: inline the producer's compact deliverable digest
    // (verdict/summary/tests/risks/needs) from its report sidecar so a coordinator
    // gets the report ESSENCE here and need not open the full report body (1M+
    // cache-read per wake). The sidecar only exists once the role wrote it, so its
    // presence is the natural gate. PROMPT CONTENT ONLY — never wired into a wake
    // signal / interest path (that stays the semantic STATE.md status).
    let digest = "";
    const sc = readSidecar(`${m.container}/${reportArtifact(m.role)}`);
    if (sc) {
      const s = deliverableSidecarSummary(sc);
      if (s) digest = `\n    ↳ ${s.slice(0, 400)}`;
    }
    return `- ${label}: ${st.status}${last}; container=${m.container}${digest}`;
  }).join("\n");
}

async function pollCycle(s: SharedState): Promise<void> {
  const { root, pmId, config, log, tracker, logsDir } = s;
  const workerIds = config.workers.map((w) => w.id);
  const scoutIds = config.scouts.map((s) => s.id);
  const smithIds = config.smiths.map((s) => s.id);
  const librarianIds = config.librarians.map((l) => l.id);
  const observerIds = config.observers.map((o) => o.id);
  const guardianIds = config.guardians.map((g) => g.id);
  const conciergeIds = config.concierges.map((c) => c.id);
  const roster = buildRoster(root, pmId, config);
  const roleStatusSummary = buildRoleStatusSummary(roster);

  // ---- Lane arbitration (DEC-017) ----
  // runtime/lane.lock decides which lane runs. The artisan lane and the
  // dock lane are mutually exclusive. The artisan lane is active when
  // the lock names it, OR when a configured Artisan is mid-task (active
  // STATE) without a lock — crash recovery, so we never resume the
  // dock lane on top of half-done artisan work. PM always runs and is
  // responsible for writing/clearing the lock (it chooses the lane).
  const laneLock = readLaneLock(root, pmId);
  // A lane.lock whose owner pid is dead is stale (the lane holder crashed). It
  // must not block the dock lane forever — but if the Artisan is genuinely
  // mid-task (active STATE) we still keep the artisan lane so it resumes its own
  // work rather than letting dock barge in on a half-done task.
  const laneOwnerPid = Number(laneLock?.pid ?? NaN);
  const laneLockStale = laneLock != null && Number.isFinite(laneOwnerPid) && laneOwnerPid > 0 && !isPidAlive(laneOwnerPid);
  // DEC-056: a valid (non-stale) lock names the lane explicitly; otherwise fall
  // back to the configured [lanes] default. default="artisan" runs the single-
  // agent lane with no lock (small-scale projects); default="dock" (the default)
  // keeps the historic behavior exactly (no lock => dock).
  const lockedLane = laneLock != null && !laneLockStale ? (laneLock.lane ?? null) : null;
  const chosenLane = lockedLane ?? config.defaultLane;
  let artisanLaneActive = config.artisan != null && chosenLane === "artisan";
  if (config.artisan && !artisanLaneActive) {
    const st = readAgentState(`${roleContainer(root, pmId, "artisan", "")}/STATE.md`);
    if (isAgentActive(st.status)) artisanLaneActive = true; // crash recovery: resume the in-flight artisan
  }
  // L17: clear a provably-orphaned lane.lock (dead pid) so a crashed lane holder
  // cannot block the dock lane. Once stale, lockedLane is already null (the chosen
  // lane no longer depends on the lock), so unlinking is safe regardless of which
  // lane ends up active — including default_lane = "artisan" (DEC-056), where the
  // old `&& !artisanLaneActive` guard would have left the orphan for doctor (P1).
  if (laneLockStale) {
    try {
      unlinkSync(`${root}/__garelier/${pmId}/runtime/lane.lock`);
      log.warn("stale_lane_lock_cleared", { owner: laneLock?.owner ?? null, pid: laneOwnerPid });
    } catch { /* ignore */ }
  }
  const dockLaneActive = !artisanLaneActive;
  if (laneLock) {
    log.debug("lane_lock", {
      lane: laneLock.lane ?? null,
      owner: laneLock.owner ?? null,
      status: laneLock.status ?? null,
      artisan_lane_active: artisanLaneActive,
    });
  }

  // ---- PM (only if supervised) ----
  if (config.autonomy.supervisePm) {
    const key = "pm";
    const paths = pmInterestPaths(root, pmId);
    if (inRateLimitBackoff(s, key, Date.now())) {
      log.debug("pm_skipped", { reason: "rate_limit_backoff", next_ms: s.rateLimits?.get(key)?.nextMs ?? null });
    } else if (inCoordinatorIdleBackoff(s, key, Date.now())) {
      log.debug("pm_skipped", { reason: "no_action_backoff" });
    } else if (tracker.hasChanged(key, paths)) {
      await invokeRole({
        s, key, role: "pm",
        runner: config.runner.pm,
        ctx: { projectRoot: root, pmId, roster, roleStatusSummary },
        logFile: `${logsDir}/pm.jsonl`,
      });
    } else {
      log.debug("pm_skipped", { reason: "no interest-file changes" });
    }
  }

  // ---- Artisan lane (DEC-017) ----
  // Artisan is a detached, commit-bearing agent, so it is launched through the
  // concurrency-capped scheduler below (DEC-027) together with the other
  // detached roles — not inline here. It is still lane-gated: gathered only
  // while the artisan lane is active.

  // ---- Dock ----
  if (dockLaneActive) {
    const key = "dock";
    const paths = dockInterestPaths(root, pmId, workerIds, scoutIds, smithIds, librarianIds, observerIds, guardianIds, conciergeIds);
    if (inRateLimitBackoff(s, key, Date.now())) {
      log.debug("dock_skipped", { reason: "rate_limit_backoff", next_ms: s.rateLimits?.get(key)?.nextMs ?? null });
    } else if (inCoordinatorIdleBackoff(s, key, Date.now())) {
      log.debug("dock_skipped", { reason: "no_action_backoff" });
    } else if (tracker.hasChanged(key, paths)) {
      await invokeRole({
        s, key, role: "dock",
        runner: config.runner.dock,
        ctx: { projectRoot: root, pmId, roster, roleStatusSummary },
        logFile: `${logsDir}/dock.jsonl`,
      });
    } else {
      log.debug("dock_skipped", { reason: "no interest-file changes" });
    }
  }

  // ---- Merge Gate (DEC-007) ----
  //
  // Non-blocking subprocess management. The actual merge + quality gate
  // runs in the background; this just polls liveness + spawns the next
  // queued request if no merge is active. Workers/Scouts/Smiths continue in
  // parallel while a merge subprocess is in flight.
  if (dockLaneActive) try {
    // Ensure subprocess can find merge-gate.{sh,ps1} via env.
    process.env.GARELIER_SKILL_CORE_DIR = s.skillCoreDir;
    const pr = await pollMergeGate(root, config, log);
    if (pr.spawnedRequestId) {
      log.info("merge_gate_dispatched", { request_id: pr.spawnedRequestId });
    }
    if (pr.recoveredAbortedRequestId) {
      log.warn("merge_gate_recovered_aborted", { request_id: pr.recoveredAbortedRequestId });
    }
  } catch (e) {
    log.error("merge_gate_poll_error", { error: (e as Error).message });
    // Do NOT throw — merge gate failures should never crash the driver loop.
  }

  // GC orphaned commit-free ephemeral branches (gavel/monocle/spyglass) once
  // every owning role is IDLE, so leftover gate/investigation branches — which
  // the role's own headless `git branch -D` routinely fails to remove — do not
  // accumulate without bound. Never crash the loop.
  try {
    gcEphemeralBranches(root, config, log);
  } catch (e) {
    log.error("ephemeral_branch_gc_error", { error: (e as Error).message });
  }

  // ---- Detached agents: concurrency-capped, priority-scheduled (DEC-027) ----
  //
  // Artisan / Worker / Scout / Smith / Librarian / Observer / Guardian /
  // Concierge are all launched as detached child processes (one provider CLI
  // each) with a lease under runtime/driver/pids/. Each owns its own worktree
  // and writes to independent paths, so they are safe to run concurrently — but
  // running ALL of them at once can exhaust machine memory. We therefore bound
  // the number of live detached children to [concurrency].max_concurrent_agents
  // and launch them in priority order; over-budget candidates are deferred to a
  // later poll (with aging, so a low-priority role can't be starved forever).
  //
  // PM / Dock / merge-gate above are foreground and intentionally NOT
  // capped — they are the coordination spine, never the memory-heavy bulk.
  //
  // Three phases per poll:
  //   0. COUNT  — read lease files once, count live children → budget.
  //   1. GATHER — for each runnable role, PEEK its interest files (non-mutating)
  //               and collect a Candidate. We must NOT consume the change
  //               snapshot here: a candidate that loses the budget race would
  //               otherwise have its mtime baseline advanced without launching,
  //               stranding it until the file changes again.
  //   2. SCHEDULE — sort by (aging, priority, key), launch up to `budget`
  //               (committing the snapshot only at the real launch), defer the
  //               rest and bump their age.
  const { aliveCount, budget } = countAliveDetached(s);
  log.debug("concurrency_budget", {
    alive: aliveCount,
    cap: config.concurrency.maxConcurrentAgents,
    budget: Number.isFinite(budget) ? budget : "inf",
  });

  const candidates: Candidate[] = [];
  const offer = (
    key: string,
    role: DetachedAgentRole,
    paths: Signal[],
    launchArgs: LaunchDetachedArgs,
  ): void => {
    if (!tracker.peekChanged(key, paths)) {
      log.debug("agent_skipped", { key, reason: "no interest-file changes" });
      return;
    }
    // DEC-031: a per-task urgency override — an `urgent.md` marker in the agent
    // container (written by PM/Dock for a user-requested "do this first").
    const dir = launchArgs.ctx.workerOrScoutCwd;
    const urgent = dir ? existsSync(`${dir}/urgent.md`) : false;
    candidates.push({ key, role, paths, age: s.deferAges.get(key) ?? 0, urgent, launchArgs });
  };

  // Read a role's STATE.md, first self-healing any cross-role residue (a reused
  // container holding ANOTHER role's STATE.md). Without this the driver's
  // *ShouldRun checks below — and the console — would act on the wrong role's
  // status. Runs only here, after the per-role lease check, so a live agent's own
  // STATE is never clobbered. See state.healRoleStateResidue.
  const readRoleState = (dir: string, role: string, id: string) => {
    const was = healRoleStateResidue(`${dir}/STATE.md`, role, id);
    if (was) log.info("role_state_residue_healed", { role, id, was, dir });
    return readAgentState(`${dir}/STATE.md`);
  };

  // Artisan (singleton; only while its lane is active) — DEC-017.
  if (artisanLaneActive && config.artisan) {
    const sol = config.artisan;
    const artisanDir = roleContainer(root, pmId, "artisan", "");
    const key = `artisan:${sol.id}`;
    const lease = consumeAgentLease(s, key, "artisan", sol.id);
    if (lease !== "running" && lease !== "consumed") {
      const state = readRoleState(artisanDir, "artisan", sol.id);
      const hasAssignment = existsSync(`${artisanDir}/assignment.md`);
      if (!artisanShouldRun(artisanDir, state.status, hasAssignment)) {
        log.debug("artisan_skipped", { id: sol.id, status: state.status });
      } else {
        offer(key, "artisan", artisanInterestPaths(root, pmId), {
          s, key, role: "artisan", runner: sol,
          ctx: {
            projectRoot: root,
            pmId,
            workerOrScoutId: sol.id,
            workerOrScoutCwd: artisanDir,
            worktreeDir: `${artisanDir}/checkout`, // DEC-020
          },
          logFile: `${logsDir}/artisan-${sol.id}.jsonl`,
        });
      }
    }
  }

  // Workers (dock lane). Bootstrap cases (NO_STATE/IDLE + assignment.md,
  // or IDLE + merged.md) are handled inside workerLikeShouldRun.
  for (const w of (dockLaneActive ? config.workers : [])) {
    const workerDir = roleContainer(root, pmId, "worker", w.id);
    const key = `worker:${w.id}`;
    const lease = consumeAgentLease(s, key, "worker", w.id);
    if (lease === "running" || lease === "consumed") continue;
    const state = readRoleState(workerDir, "worker", w.id);
    const hasAssignment = existsSync(`${workerDir}/assignment.md`);
    const hasMerged     = existsSync(`${workerDir}/merged.md`);
    if (!workerLikeShouldRun(workerDir, state.status, hasAssignment, hasMerged)) {
      log.debug("worker_skipped", { id: w.id, status: state.status });
      continue;
    }
    offer(key, "worker", workerInterestPaths(root, pmId, w.id), {
      s, key, role: "worker", runner: w,
      ctx: {
        projectRoot: root,
        pmId,
        workerOrScoutId: w.id,
        workerOrScoutCwd: workerDir,
        worktreeDir: `${workerDir}/checkout`, // DEC-020
      },
      logFile: `${logsDir}/worker-${w.id}.jsonl`,
    });
  }

  // Scouts (dock lane). Bootstrap: NO_STATE/IDLE + assignment.md, or
  // NO_STATE/IDLE + committed.md (DEC-008 transition trigger).
  for (const sc of (dockLaneActive ? config.scouts : [])) {
    const scoutDir = roleContainer(root, pmId, "scout", sc.id);
    const key = `scout:${sc.id}`;
    const lease = consumeAgentLease(s, key, "scout", sc.id);
    if (lease === "running" || lease === "consumed") continue;
    const state = readRoleState(scoutDir, "scout", sc.id);
    const hasAssignment = existsSync(`${scoutDir}/assignment.md`);
    const hasCommitted  = existsSync(`${scoutDir}/committed.md`);
    if (!scoutShouldRun(scoutDir, state.status, hasAssignment, hasCommitted)) {
      log.debug("scout_skipped", { id: sc.id, status: state.status });
      continue;
    }
    offer(key, "scout", scoutInterestPaths(root, pmId, sc.id), {
      s, key, role: "scout", runner: sc,
      ctx: {
        projectRoot: root,
        pmId,
        workerOrScoutId: sc.id,
        workerOrScoutCwd: scoutDir,
        worktreeDir: sc.checkout === false ? undefined : `${scoutDir}/checkout`, // DEC-020 / DEC-021
        checkout: sc.checkout,
      },
      logFile: `${logsDir}/scout-${sc.id}.jsonl`,
    });
  }

  // Smiths (dock lane). Same bootstrap semantics as Worker.
  for (const sm of (dockLaneActive ? config.smiths : [])) {
    const smithDir = roleContainer(root, pmId, "smith", sm.id);
    const key = `smith:${sm.id}`;
    const lease = consumeAgentLease(s, key, "smith", sm.id);
    if (lease === "running" || lease === "consumed") continue;
    const state = readRoleState(smithDir, "smith", sm.id);
    const hasAssignment = existsSync(`${smithDir}/assignment.md`);
    const hasMerged     = existsSync(`${smithDir}/merged.md`);
    if (!workerLikeShouldRun(smithDir, state.status, hasAssignment, hasMerged)) {
      log.debug("smith_skipped", { id: sm.id, status: state.status });
      continue;
    }
    offer(key, "smith", smithInterestPaths(root, pmId, sm.id), {
      s, key, role: "smith", runner: sm,
      ctx: {
        projectRoot: root,
        pmId,
        workerOrScoutId: sm.id,
        workerOrScoutCwd: smithDir,
        worktreeDir: `${smithDir}/checkout`, // DEC-020
      },
      logFile: `${logsDir}/smith-${sm.id}.jsonl`,
    });
  }

  // Librarians (dock lane). Same bootstrap semantics as Worker.
  for (const lib of (dockLaneActive ? config.librarians : [])) {
    const librarianDir = roleContainer(root, pmId, "librarian", lib.id);
    const key = `librarian:${lib.id}`;
    const lease = consumeAgentLease(s, key, "librarian", lib.id);
    if (lease === "running" || lease === "consumed") continue;
    const state = readRoleState(librarianDir, "librarian", lib.id);
    const hasAssignment = existsSync(`${librarianDir}/assignment.md`);
    const hasMerged     = existsSync(`${librarianDir}/merged.md`);
    if (!workerLikeShouldRun(librarianDir, state.status, hasAssignment, hasMerged)) {
      log.debug("librarian_skipped", { id: lib.id, status: state.status });
      continue;
    }
    offer(key, "librarian", librarianInterestPaths(root, pmId, lib.id), {
      s, key, role: "librarian", runner: lib,
      ctx: {
        projectRoot: root,
        pmId,
        workerOrScoutId: lib.id,
        workerOrScoutCwd: librarianDir,
        worktreeDir: `${librarianDir}/checkout`, // DEC-020
      },
      logFile: `${logsDir}/librarian-${lib.id}.jsonl`,
    });
  }

  // Observers (DEC-019) — read-only review/advice sidecar; NOT lane-gated.
  // They run in BOTH the dock and artisan lanes: they never take lane.lock
  // and never merge, so they cannot conflict with whichever lane owns the commit
  // path. They review diffs/reports and write report.md / advice.md only.
  for (const ob of config.observers) {
    const observerDir = roleContainer(root, pmId, "observer", ob.id);
    const key = `observer:${ob.id}`;
    const lease = consumeAgentLease(s, key, "observer", ob.id);
    if (lease === "running" || lease === "consumed") continue;
    const state = readRoleState(observerDir, "observer", ob.id);
    const hasAssignment = existsSync(`${observerDir}/assignment.md`);
    if (!observerShouldRun(observerDir, state.status, hasAssignment)) {
      log.debug("observer_skipped", { id: ob.id, status: state.status });
      continue;
    }
    offer(key, "observer", observerInterestPaths(root, pmId, ob.id), {
      s, key, role: "observer", runner: ob,
      ctx: {
        projectRoot: root,
        pmId,
        workerOrScoutId: ob.id,
        workerOrScoutCwd: observerDir,
        worktreeDir: ob.checkout === false ? undefined : `${observerDir}/checkout`, // DEC-020 / DEC-021
        checkout: ob.checkout,
      },
      logFile: `${logsDir}/observer-${ob.id}.jsonl`,
    });
  }

  // Guardians (DEC-024) — security/privacy/dependency/license gate. Commit-free
  // like Observer; NOT lane-gated. Reads Librarian-owned policy, emits a verdict.
  for (const gd of config.guardians) {
    const guardianDir = roleContainer(root, pmId, "guardian", gd.id);
    const key = `guardian:${gd.id}`;
    const lease = consumeAgentLease(s, key, "guardian", gd.id);
    if (lease === "running" || lease === "consumed") continue;
    const state = readRoleState(guardianDir, "guardian", gd.id);
    const hasAssignment = existsSync(`${guardianDir}/assignment.md`);
    if (!guardianShouldRun(guardianDir, state.status, hasAssignment)) {
      log.debug("guardian_skipped", { id: gd.id, status: state.status });
      continue;
    }
    offer(key, "guardian", guardianInterestPaths(root, pmId, gd.id), {
      s, key, role: "guardian", runner: gd,
      ctx: {
        projectRoot: root,
        pmId,
        workerOrScoutId: gd.id,
        workerOrScoutCwd: guardianDir,
        worktreeDir: gd.checkout === false ? undefined : `${guardianDir}/checkout`, // DEC-020 / DEC-021
        checkout: gd.checkout,
      },
      logFile: `${logsDir}/guardian-${gd.id}.jsonl`,
    });
  }

  // Concierges (DEC-025) — external operations executor. Commit-bearing for the
  // operation it runs (e.g. a promote merge + tag) but never implements source;
  // PM-dispatched only; NOT lane-gated. Phase-fine states (PREPARING/
  // CHECKING_GATES/EXECUTING/VERIFYING) ride inside WORKING (STATE.md Current
  // task), like Artisan — so no AgentStatus enum change.
  for (const cg of config.concierges) {
    const conciergeDir = roleContainer(root, pmId, "concierge", cg.id);
    const key = `concierge:${cg.id}`;
    const lease = consumeAgentLease(s, key, "concierge", cg.id);
    if (lease === "running" || lease === "consumed") continue;
    const state = readRoleState(conciergeDir, "concierge", cg.id);
    const hasAssignment = existsSync(`${conciergeDir}/assignment.md`);
    if (!conciergeShouldRun(conciergeDir, state.status, hasAssignment)) {
      log.debug("concierge_skipped", { id: cg.id, status: state.status });
      continue;
    }
    offer(key, "concierge", conciergeInterestPaths(root, pmId, cg.id), {
      s, key, role: "concierge", runner: cg,
      ctx: {
        projectRoot: root,
        pmId,
        workerOrScoutId: cg.id,
        workerOrScoutCwd: conciergeDir,
        worktreeDir: `${conciergeDir}/checkout`, // DEC-020; concierge always has a worktree
        checkout: cg.checkout,
      },
      logFile: `${logsDir}/concierge-${cg.id}.jsonl`,
    });
  }

  // ---- Phase 2: SCHEDULE — priority + aging, launch up to budget ----------
  scheduleDetached(s, candidates, budget);
}

type LeaseDisposition = "none" | "running" | "consumed" | "cleared";

export interface AgentLease {
  version?: number;
  status?: "starting" | "running" | "finished";
  role?: DetachedAgentRole;
  lane?: "artisan" | "dock";
  id?: string;
  pid?: number;
  child_pid?: number;
  key?: string;
  assignment_hash?: string | null;
  branch?: string | null;
  started_at?: string;
  ended_at?: string;
  outcome?: string;
  exit_code?: number | null;
  duration_ms?: number;
  final_action_kind?: FinalActionKind | null;
  error_message?: string | null;
}

interface LaunchDetachedArgs {
  s: SharedState;
  key: string;
  role: DetachedAgentRole;
  runner: RunnerDef;
  ctx: RoleContext;
  logFile: string;
}

// ---- DEC-027: detached-agent concurrency cap + priority scheduling --------
//
// `max_concurrent_agents` bounds how many detached provider CLIs run at once so
// enabling every role does not exhaust machine memory. PM / Dock / merge-
// gate are foreground and uncapped. A cap of 0 disables the cap (unlimited).

export interface Candidate {
  key: string;
  role: DetachedAgentRole;
  paths: Signal[];
  age: number;            // consecutive polls this key has been deferred
  // DEC-031: a per-task urgency override (an `urgent.md` marker in the agent
  // container, written by PM/Dock for a user-requested "do this first").
  // Urgent candidates jump above the role tiers AND above the aging breaker.
  urgent: boolean;
  launchArgs: LaunchDetachedArgs;
}

// Liveness for the alive-count only (distinct from consumeAgentLease, which also
// reaps). A "starting" lease with no pid yet is spawning → count it. `isAlive`
// is injectable for tests; production passes the real pid check.
export function isPidAliveForLease(
  lease: AgentLease,
  isAlive: (pid: number) => boolean = isPidAlive,
): boolean {
  const pid = Number(lease.pid ?? lease.child_pid);
  if (!Number.isFinite(pid) || pid <= 0) return lease.status === "starting";
  return isAlive(pid);
}

// Pure budget computation. A "finished" lease is not alive (it is reaped in
// Phase 1). A lease with a dead pid is not alive. Over-counting (e.g. a recycled
// pre-boot pid) only ever under-launches — it can never let us exceed the cap —
// so the memory bound stays a hard ceiling. `cap <= 0` disables the cap.
export function computeAliveBudget(
  leases: AgentLease[],
  cap: number,
  driverBootMs: number,
  isAlive: (pid: number) => boolean = isPidAlive,
): { aliveCount: number; preBootLive: number; budget: number } {
  let alive = 0;
  let preBootLive = 0;
  for (const lease of leases) {
    if (!lease || lease.status === "finished") continue;
    if (!isPidAliveForLease(lease, isAlive)) continue;
    alive++;
    const started = lease.started_at ? Date.parse(lease.started_at) : NaN;
    if (Number.isFinite(started) && started < driverBootMs) preBootLive++;
  }
  const budget = cap <= 0 ? Number.POSITIVE_INFINITY : Math.max(0, cap - alive);
  return { aliveCount: alive, preBootLive, budget };
}

// Count the detached children currently consuming memory by reading their lease
// files once, then delegating to the pure computeAliveBudget.
function countAliveDetached(s: SharedState): { aliveCount: number; budget: number } {
  let entries: string[] = [];
  try { entries = readdirSync(s.pidsDir); } catch { entries = []; }
  const leases: AgentLease[] = [];
  for (const f of entries) {
    if (!f.endsWith(".pid")) continue;
    const lease = readAgentLeaseFile(`${s.pidsDir}/${f}`);
    if (lease) leases.push(lease);
  }
  const { aliveCount, preBootLive, budget } = computeAliveBudget(
    leases, s.config.concurrency.maxConcurrentAgents, s.driverBootMs);
  if (preBootLive > 0) {
    // Children that outlived a prior driver generation still hold real memory,
    // so they are counted. A recycled pid merely under-launches this poll;
    // doctor flags stale leases. A robust OS start-time guard is a follow-up.
    s.log.debug("concurrency_preboot_alive", { count: preBootLive });
  }
  return { aliveCount, budget };
}

// Flatten priority tiers into a role -> tier-index map (lower = higher priority).
export function tierIndexMap(tiers: string[][]): Record<string, number> {
  const m: Record<string, number> = {};
  tiers.forEach((roles, i) => roles.forEach((r) => { if (!(r in m)) m[r] = i; }));
  return m;
}

// Apply an optional Dock producer-tier reorder (DEC-031). `override` is the
// reordered producer band: an array of role groups containing ONLY the
// dock-lane producer roles (smith/librarian/worker/scout). The gate tier
// (above the band) and artisan (below it) stay FIXED; the producer groups are
// renumbered into the band's index range in the override order; any omitted
// producer is appended (in default order) as a trailing group. Unknown /
// non-producer entries are ignored. A below-band role (artisan) shifts to stay
// below the new band.
export function effectiveTierIndexMap(tiers: string[][], override: string[][] | null): Record<string, number> {
  const base = tierIndexMap(tiers);
  const reSet = new Set<string>(DOCK_REORDERABLE_ROLES);
  const prodIdx = Object.keys(base).filter((r) => reSet.has(r)).map((r) => base[r]);
  if (!override || override.length === 0 || prodIdx.length === 0) return base;
  const bandStart = Math.min(...prodIdx); // producers keep their top boundary

  // Reordered producer groups from the override, then any omitted producer
  // appended (in default tier order) so none loses its tier.
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const g of override) {
    const grp = (Array.isArray(g) ? g : [g])
      .map((x) => String(x).trim().toLowerCase())
      .filter((r) => reSet.has(r) && !seen.has(r));
    grp.forEach((r) => seen.add(r));
    if (grp.length) groups.push(grp);
  }
  for (const r of Object.keys(base).filter((r) => reSet.has(r) && !seen.has(r)).sort((a, b) => base[a] - base[b])) {
    groups.push([r]);
  }

  // Assign EVERY role a tier (no undefined): roles above the producer band (gates,
  // any reserved tier) keep their base; producer groups occupy bandStart..; all
  // other non-producer roles at/below the band (e.g. artisan) drop to the bottom,
  // preserving their relative default order, below the reordered producers.
  const out: Record<string, number> = {};
  for (const r of Object.keys(base)) if (base[r] < bandStart) out[r] = base[r];
  groups.forEach((grp, k) => grp.forEach((r) => { out[r] = bandStart + k; }));
  const bottomStart = bandStart + groups.length;
  const remaining = Object.keys(base).filter((r) => !(r in out)).sort((a, b) => base[a] - base[b]);
  remaining.forEach((r, k) => { out[r] = bottomStart + k; });
  return out;
}

// Pure scheduling decision (DEC-031): order candidates by (aging promotion, tier,
// FIFO, key) and split at `budget`. Aged candidates (deferred >= starvationCycles)
// sort ahead of tier order — the cross-tier starvation breaker so a low tier is
// never starved by saturated upper tiers. Within a tier, the longest-waiting agent
// (highest age) runs first (FIFO).
export function planDetachedSchedule(
  candidates: Candidate[],
  budget: number,
  tierOf: Record<string, number>,
  starvationCycles: number,
): { launch: Candidate[]; defer: Candidate[] } {
  // Priority buckets: a PM/user-flagged URGENT task (0) jumps above everything,
  // then the AGING starvation-breaker (1), then NORMAL (2). Within a bucket, order
  // by tier, then FIFO (longest-waiting first), then key for determinism.
  const bucket = (c: Candidate) =>
    c.urgent ? 0 : (starvationCycles > 0 && c.age >= starvationCycles ? 1 : 2);
  const tier = (role: string) => (role in tierOf ? tierOf[role] : Number.MAX_SAFE_INTEGER);
  const sorted = [...candidates].sort((a, b) =>
    bucket(a) - bucket(b) ||
    tier(a.role) - tier(b.role) ||
    (b.age - a.age) ||                       // FIFO: longest-waiting first within a tier
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const launch: Candidate[] = [];
  const defer: Candidate[] = [];
  let remaining = budget;
  for (const c of sorted) {
    if (remaining > 0) { launch.push(c); remaining--; }
    else defer.push(c);
  }
  return { launch, defer };
}

// Optional Dock producer-tier reorder hint (DEC-031): the reordered producer
// band as an array of role groups (only producer roles honored). Best-effort;
// absent/corrupt => no override. Accepts `producer_tiers` (array of arrays) or
// `producer_order` (flat — each role becomes its own group).
function readTierOverride(s: SharedState): string[][] | null {
  const p = `${s.root}/__garelier/${s.pmId}/runtime/dock/tier_order.json`;
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    if (Array.isArray(raw.producer_tiers)) {
      return raw.producer_tiers.map((g) => (Array.isArray(g) ? g.map((x) => String(x)) : [String(g)]));
    }
    if (Array.isArray(raw.producer_order)) {
      return raw.producer_order.map((x) => [String(x)]);
    }
    return null;
  } catch {
    return null;
  }
}

// Phase 2: apply the schedule. The change snapshot for a key is committed
// (tracker.hasChanged) ONLY when that key is actually launched — deferred
// candidates keep their old baseline so they remain "changed" and are re-offered
// next poll (no stranding). Each defer bumps the key's age.
function scheduleDetached(s: SharedState, candidates: Candidate[], budget: number): void {
  const { tiers, starvationCycles } = s.config.concurrency;
  const tierOf = effectiveTierIndexMap(tiers, readTierOverride(s));
  const { launch, defer } = planDetachedSchedule(candidates, budget, tierOf, starvationCycles);
  for (const c of launch) {
    if (starvationCycles > 0 && c.age >= starvationCycles) {
      s.log.info("agent_promoted_by_aging", { key: c.key, role: c.role, age: c.age });
    }
    s.tracker.hasChanged(c.key, c.paths); // commit snapshot only at real launch
    launchDetachedAgent(c.launchArgs);
    s.deferAges.delete(c.key);
  }
  for (const c of defer) {
    s.deferAges.set(c.key, c.age + 1);
    s.log.info("agent_deferred", { key: c.key, role: c.role, age: c.age + 1 });
  }
  // Drop deferral ages for keys that are no longer candidates (became running or
  // not-runnable), so a stale age cannot mis-promote a future, unrelated run.
  const offeredKeys = new Set(candidates.map((c) => c.key));
  for (const k of [...s.deferAges.keys()]) {
    if (!offeredKeys.has(k)) s.deferAges.delete(k);
  }
  if (candidates.length > 0) {
    s.log.debug("concurrency_schedule", {
      candidates: candidates.length,
      launched: launch.length,
      deferred: defer.length,
      budget: Number.isFinite(budget) ? budget : "inf",
    });
  }
}

function consumeAgentLease(
  s: SharedState,
  key: string,
  role: DetachedAgentRole,
  id: string,
): LeaseDisposition {
  const leaseFile = agentLeasePath(s, role, id);
  if (!existsSync(leaseFile)) {
    // No active/finished lease. If this role tripped the failure circuit
    // breaker OR is in a rate-limit backoff window, park it (skip launch) until
    // the window passes — this is what stops the rate-limit death spiral.
    if (inFailureBackoff(s, key, Date.now())) {
      s.log.debug("agent_circuit_backoff", { role, id, next_ms: s.failures?.get(key)?.nextMs ?? null });
      return "running";
    }
    if (inRateLimitBackoff(s, key, Date.now())) {
      s.log.debug("agent_rate_limit_backoff", { role, id, next_ms: s.rateLimits?.get(key)?.nextMs ?? null });
      return "running";
    }
    return "none";
  }

  const lease = readAgentLeaseFile(leaseFile);
  if (!lease) {
    s.log.warn("agent_lease_corrupt", { role, id, lease_file: leaseFile });
    try { unlinkSync(leaseFile); } catch { /* ignore */ }
    s.tracker.invalidate(key);
    return "cleared";
  }

  if (lease.status === "finished") {
    handleDetachedOutcome(s, key, role, id, lease);
    try { unlinkSync(leaseFile); } catch { /* ignore */ }
    return "consumed";
  }

  const pid = Number(lease.pid ?? lease.child_pid);
  if (isPidAlive(pid)) {
    s.log.debug("agent_lease_running", {
      role,
      id,
      pid,
      assignment_hash: lease.assignment_hash ?? null,
      branch: lease.branch ?? null,
      started_at: lease.started_at ?? null,
    });
    return "running";
  }

  s.log.warn("agent_lease_stale", {
    role,
    id,
    pid: Number.isFinite(pid) ? pid : null,
    lease_file: leaseFile,
  });
  try { unlinkSync(leaseFile); } catch { /* ignore */ }
  s.tracker.invalidate(key);
  return "cleared";
}

function handleDetachedOutcome(
  s: SharedState,
  key: string,
  role: DetachedAgentRole,
  id: string,
  lease: AgentLease,
): void {
  const sourceLabel = `${role}-${id}`;
  const roleLog = s.log.child(sourceLabel, `${s.logsDir}/${sourceLabel}.jsonl`);
  const outcome = lease.outcome ?? "unknown";
  roleLog.info("detached_iteration_finished", {
    outcome,
    exit_code: lease.exit_code ?? null,
    duration_ms: lease.duration_ms ?? null,
    error_message: lease.error_message ?? null,
  });

  if (
    outcome === "non_zero_exit" ||
    outcome === "incomplete" ||
    outcome === "spawn_error" ||
    outcome === "child_error" ||
    outcome === "unknown"
  ) {
    // Per-role circuit breaker: count consecutive non-rate-limit failures and
    // back off (capped 30m) once they pass the threshold, so a permanently
    // broken role (e.g. bad auth) cannot re-launch every poll forever.
    if (!s.failures) s.failures = new Map();
    const fb = s.failures.get(key) ?? { count: 0, nextMs: 0 };
    fb.count += 1;
    const backoff = failureBackoffMs(fb.count);
    fb.nextMs = backoff > 0 ? Date.now() + backoff : 0;
    s.failures.set(key, fb);
    if (backoff > 0) {
      roleLog.error("circuit_backoff", {
        outcome,
        consecutive: fb.count,
        backoff_ms: backoff,
        backoff_human: `${Math.round(backoff / 60000)}m`,
        reason: lease.error_message?.slice(0, 200) ?? null,
      });
    } else {
      roleLog.warn("retry_scheduled", { outcome, consecutive: fb.count, reason: lease.error_message ?? null });
    }
    s.tracker.invalidate(key);
    return;
  }

  if (outcome === "rate_limited") {
    // Per-role brake (park this role for a self-expiring window) + global streak.
    // Keep invalidate so the post-backoff poll re-offers this work; the launch
    // itself is gated by inRateLimitBackoff in consumeAgentLease.
    const backoff = noteRateLimit(s, key, Date.now());
    s.tracker.invalidate(key);
    roleLog.error("rate_limited_recorded", {
      consecutive: s.rateLimitConsecutive,
      role_backoff_ms: backoff,
      role_backoff_human: `${Math.round(backoff / 60000)}m`,
      reason: lease.error_message?.slice(0, 200) ?? null,
    });
    return;
  }

  if (outcome === "ok") {
    if (s.failures?.has(key)) {
      roleLog.info("circuit_cleared", { previous_consecutive: s.failures.get(key)?.count ?? null });
      s.failures.delete(key);
    }
    if (s.rateLimits?.has(key)) {
      roleLog.info("rate_limited_cleared", { previous_consecutive: s.rateLimits.get(key)?.count ?? null });
      s.rateLimits.delete(key);
    }
    s.rateLimitConsecutive = 0;
  }
}

function launchDetachedAgent(args: LaunchDetachedArgs): void {
  const { s, key, role, runner, ctx, logFile } = args;
  const id = ctx.workerOrScoutId;
  if (!id || !ctx.workerOrScoutCwd) {
    s.log.error("agent_detach_missing_context", { role, key });
    s.tracker.invalidate(key);
    return;
  }

  const sourceLabel = `${role}-${id}`;
  const leaseFile = agentLeasePath(s, role, id);
  const launchFile = `${s.tmpDir}/${safeLeaseName(role, id)}.launch.json`;
  const childScript = join(dirname(fileURLToPath(import.meta.url)), "agent_child.ts");

  const lease: AgentLease = {
    version: 1,
    status: "starting",
    role,
    lane: role === "artisan" ? "artisan" : "dock",
    id,
    key,
    assignment_hash: hashFileIfExists(`${ctx.workerOrScoutCwd}/assignment.md`),
    // DEC-020: the branch lives in the checkout worktree, not the container.
    // DEC-021: checkout=false read-only roles have no worktree → no branch.
    branch: ctx.checkout === false ? null : currentGitBranch(ctx.worktreeDir ?? `${ctx.workerOrScoutCwd}/checkout`),
    started_at: new Date().toISOString(),
  };
  writeJsonAtomic(leaseFile, lease);

  const launch = {
    key,
    role,
    sourceLabel,
    runner,
    ctx,
    logFile,
    leaseFile,
    tmpDir: s.tmpDir,
    projectRoot: s.root,
    skillCoreDir: s.skillCoreDir,
    spawnCmd: s.spawnCmd,
    maxBudgetUsd: s.maxBudgetUsd,
    permissionProfile: s.config.permissions.profile,
    outputControl: s.config.outputControl, // DEC-028
    // DEC-049 C1: grant producers their declared formatter so they auto-fix
    // before REPORTING. The adapter scopes this to producer roles.
    autofixCommands: s.config.qualityGate.autofixCommands,
  };
  writeJsonAtomic(launchFile, launch);

  try {
    const proc = Bun.spawn([process.execPath, childScript, "--launch", launchFile], {
      cwd: s.root,
      env: { ...process.env },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      // Windows: `detached` would otherwise open a NEW CONSOLE WINDOW per worker
      // every poll, which accumulate visibly ("claude" terminals). Suppress it —
      // the child is headless (stdio ignored, logs to file). No-op on POSIX.
      windowsHide: true,
    });
    patchJsonAtomic(leaseFile, { pid: proc.pid, child_pid: proc.pid });
    proc.unref();
    s.log.info("agent_detached", {
      role,
      id,
      pid: proc.pid,
      assignment_hash: lease.assignment_hash,
      branch: lease.branch,
    });
  } catch (e) {
    const message = (e as Error).message;
    s.log.error("agent_detach_spawn_failed", { role, id, error: message });
    patchJsonAtomic(leaseFile, {
      status: "finished",
      ended_at: new Date().toISOString(),
      outcome: "spawn_error",
      exit_code: null,
      error_message: message,
    });
    s.tracker.invalidate(key);
  }
}

function agentLeasePath(s: SharedState, role: DetachedAgentRole, id: string): string {
  return `${s.pidsDir}/${safeLeaseName(role, id)}.pid`;
}

function safeLeaseName(role: DetachedAgentRole, id: string): string {
  return `${role}-${id}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

function hashFileIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function currentGitBranch(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    return new TextDecoder().decode(proc.stdout).trim() || null;
  } catch {
    return null;
  }
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readAgentLeaseFile(path: string): AgentLease | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (/^\d+$/.test(raw)) {
      return { version: 0, status: "running", pid: Number(raw) };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as AgentLease;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, path);
}

function patchJsonAtomic(path: string, patch: Record<string, unknown>): void {
  const prev = readJsonFile<Record<string, unknown>>(path) ?? {};
  writeJsonAtomic(path, { ...prev, ...patch });
}

interface InvokeArgs {
  s: SharedState;
  key: string;
  role: "pm" | "dock" | "worker" | "scout" | "smith";
  runner: RunnerDef;
  ctx: import("./prompts.ts").RoleContext;
  logFile: string;
}

async function invokeRole(args: InvokeArgs): Promise<void> {
  const { s, key, role, runner, ctx, logFile } = args;
  const sourceLabel = role === "worker" || role === "scout" || role === "smith"
    ? `${role}-${ctx.workerOrScoutId}`
    : role;
  const roleLog = s.log.child(sourceLabel, logFile);
  try {
    const result = await runIteration({
      role,
      ctx,
      log: roleLog,
      provider: runner.provider,
      tmpDir: s.tmpDir,
      projectRoot: s.root,
      skillCoreDir: s.skillCoreDir,
      spawnCmd: s.spawnCmd,
      model: runner.model,
      effort: runner.effort,
      maxBudgetUsd: s.maxBudgetUsd,
      permissionProfile: s.config.permissions.profile,
      outputControl: s.config.outputControl, // DEC-028
    });
    // Invalidate the tracker for non-OK outcomes so the next poll
    // retries even if no interest files changed. Without this,
    // a timed-out iteration that never wrote a state update would
    // deadlock the role permanently (mtime pre-check perpetually
    // returns "no change").
    if (
      result.outcome === "non_zero_exit" ||
      result.outcome === "incomplete" ||
      result.outcome === "spawn_error"
    ) {
      roleLog.warn("retry_scheduled", { outcome: result.outcome, reason: result.errorMessage });
      s.tracker.invalidate(key);
    } else if (result.outcome === "rate_limited") {
      // Per-role brake parks this coordinator for a self-expiring window (gated
      // at the wake site) + global streak drives the coarse poll-loop backoff.
      // Invalidate so the post-backoff poll retries even if no interest changed.
      const backoff = noteRateLimit(s, key, Date.now());
      s.tracker.invalidate(key);
      roleLog.error("rate_limited_recorded", {
        consecutive: s.rateLimitConsecutive,
        role_backoff_ms: backoff,
        role_backoff_human: `${Math.round(backoff / 60000)}m`,
        reason: result.errorMessage?.slice(0, 200),
      });
    } else if (result.outcome === "ok") {
      // Successful iteration clears the rate-limit brake + streak.
      if (s.rateLimits?.has(key)) {
        roleLog.info("rate_limited_cleared", { previous_consecutive: s.rateLimits.get(key)?.count ?? null });
        s.rateLimits.delete(key);
      }
      s.rateLimitConsecutive = 0;
      recordCoordinatorFinalAction(s, key, role, result.finalActionKind ?? "unknown", roleLog);
    }
  } catch (e) {
    roleLog.error("iteration_threw", { message: (e as Error).message });
    s.tracker.invalidate(key); // retry next poll
  }
}

function recordCoordinatorFinalAction(
  s: SharedState,
  key: string,
  role: "pm" | "dock" | "worker" | "scout" | "smith",
  kind: FinalActionKind,
  log: Logger,
): void {
  if (role !== "pm" && role !== "dock") return;
  if (kind !== "no_action" && kind !== "coord_only") {
    if (s.coordIdle.has(key)) {
      log.info("coordinator_no_action_backoff_cleared", { previous_kind: s.coordIdle.get(key)?.lastKind ?? null });
      s.coordIdle.delete(key);
    }
    return;
  }
  const prev = s.coordIdle.get(key);
  const count = (prev?.count ?? 0) + 1;
  const backoff = coordinatorIdleBackoffMs(count);
  const nextMs = backoff > 0 ? Date.now() + backoff : 0;
  s.coordIdle.set(key, { count, nextMs, lastKind: kind });
  if (backoff > 0) {
    log.warn("coordinator_no_action_backoff", {
      final_action_kind: kind,
      consecutive: count,
      backoff_ms: backoff,
      backoff_human: `${Math.round(backoff / 60000)}m`,
    });
  }
}

export function workerLikeShouldRun(
  agentDir: string,
  status: AgentStatus,
  hasAssignment: boolean,
  hasMerged: boolean,
): boolean {
  if (existsSync(`${agentDir}/abort.md`)) return true;
  switch (status) {
    case "NO_STATE":
      return hasAssignment;
    case "IDLE":
      return hasAssignment || hasMerged;
    case "ASSIGNED":
    case "WORKING":
    case "REWORK":
      return true;
    case "REPORTING":
      return existsSync(`${agentDir}/under_review.md`) ||
        existsSync(`${agentDir}/review.md`) ||
        hasMerged;
    case "REVIEWING":
      return existsSync(`${agentDir}/review.md`) || hasMerged;
    case "BLOCKED":
      return existsSync(`${agentDir}/answers.md`);
    case "MERGED":
      return hasMerged;
    case "OBSERVING":
    case "ACKED":
    case "CHECKING":
      return false; // Observer/Guardian-only states; never apply to worker-like roles
    case "ABORTED":
      return false;
  }
}

export interface LaneLock {
  lane?: "artisan" | "dock" | string;
  owner?: string;
  task_id?: string;
  branch?: string;
  target_branch?: string;
  pid?: number;
  started_at?: string;
  status?: string;
}

export function readLaneLock(projectRoot: string, pmId: string): LaneLock | null {
  return readJsonFile<LaneLock>(`${projectRoot}/__garelier/${pmId}/runtime/lane.lock`);
}

export function artisanShouldRun(
  artisanDir: string,
  status: AgentStatus,
  hasAssignment: boolean,
): boolean {
  if (existsSync(`${artisanDir}/abort.md`)) return true;
  switch (status) {
    case "NO_STATE":
    case "IDLE":
    case "REPORTING": // transient; pick up a fresh assignment or finish
      return hasAssignment;
    case "ASSIGNED":
    case "WORKING":
    case "REWORK":
      return true;
    case "BLOCKED":
      return existsSync(`${artisanDir}/answers.md`);
    case "REVIEWING":
    case "MERGED":
    case "OBSERVING":
    case "ACKED":
    case "CHECKING":
    case "ABORTED":
      return false;
  }
}

export function scoutShouldRun(
  scoutDir: string,
  status: AgentStatus,
  hasAssignment: boolean,
  hasCommitted: boolean,
): boolean {
  if (existsSync(`${scoutDir}/abort.md`)) return true;
  switch (status) {
    case "NO_STATE":
    case "IDLE":
      return hasAssignment || hasCommitted;
    case "ASSIGNED":
    case "WORKING":
    case "REWORK":
      return true;
    case "REPORTING":
    case "MERGED":
      return hasCommitted;
    case "BLOCKED":
      return existsSync(`${scoutDir}/answers.md`);
    case "REVIEWING":
    case "OBSERVING":
    case "ACKED":
    case "CHECKING":
    case "ABORTED":
      return false;
  }
}

// Observer (DEC-019): commit-free review/advice sidecar. Runs in BOTH
// lanes. IDLE→ASSIGNED→OBSERVING→REPORTING→ACKED→IDLE (+BLOCKED, ABORTED).
export function observerShouldRun(
  observerDir: string,
  status: AgentStatus,
  hasAssignment: boolean,
): boolean {
  if (existsSync(`${observerDir}/abort.md`)) return true;
  const hasAcked = existsSync(`${observerDir}/acked.md`);
  switch (status) {
    case "NO_STATE":
    case "IDLE":
      return hasAssignment;
    case "ASSIGNED":
    case "OBSERVING":
      return true;
    case "REPORTING":
      // Waiting for the requester to ACK; only run when the ACK lands so we
      // can archive and return to IDLE.
      return hasAcked;
    case "ACKED":
      return true; // archive, then IDLE
    case "BLOCKED":
      return existsSync(`${observerDir}/answers.md`);
    case "WORKING":
    case "REVIEWING":
    case "REWORK":
    case "MERGED":
    case "ABORTED":
    case "CHECKING":
      return false;
  }
}

export function guardianShouldRun(
  guardianDir: string,
  status: AgentStatus,
  hasAssignment: boolean,
): boolean {
  if (existsSync(`${guardianDir}/abort.md`)) return true;
  const hasAcked = existsSync(`${guardianDir}/acked.md`);
  switch (status) {
    case "NO_STATE":
    case "IDLE":
      return hasAssignment;
    case "ASSIGNED":
    case "CHECKING":
      return true;
    case "REPORTING":
      return hasAcked; // waiting for ack; run to archive on ack
    case "ACKED":
      return true; // archive, then IDLE
    case "BLOCKED":
      return existsSync(`${guardianDir}/answers.md`);
    case "WORKING":
    case "REVIEWING":
    case "REWORK":
    case "MERGED":
    case "ABORTED":
    case "OBSERVING":
      return false;
  }
}

export function conciergeShouldRun(
  conciergeDir: string,
  status: AgentStatus,
  hasAssignment: boolean,
): boolean {
  if (existsSync(`${conciergeDir}/abort.md`)) return true;
  const hasAcked = existsSync(`${conciergeDir}/acked.md`);
  switch (status) {
    case "NO_STATE":
    case "IDLE":
      return hasAssignment;
    case "ASSIGNED":
    case "WORKING": // PREPARING/CHECKING_GATES/EXECUTING/VERIFYING ride inside WORKING
      return true;
    case "REPORTING":
      return hasAcked; // waiting for PM ack; run to archive on ack
    case "ACKED":
      return true; // archive, then IDLE
    case "BLOCKED":
      return existsSync(`${conciergeDir}/answers.md`);
    case "REVIEWING":
    case "REWORK":
    case "MERGED":
    case "CHECKING":
    case "OBSERVING":
    case "ABORTED":
      return false;
  }
}

async function sleep(ms: number, shouldExit: () => boolean): Promise<void> {
  const step = 500;
  let remaining = ms;
  while (remaining > 0) {
    if (shouldExit()) return;
    const wait = Math.min(step, remaining);
    await new Promise((r) => setTimeout(r, wait));
    remaining -= wait;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

// Only run the driver loop when executed directly (`bun run main.ts`).
// Importing this module (e.g. from unit tests) must not start the driver.
if (import.meta.main) {
  // Dispatch-only (DEC-061): the headless driver (Mode B) is disabled. Garelier
  // runs roles via dispatch (in-session subagents / `codex exec`), not this
  // per-iteration `claude -p` loop. Refuse direct invocation too (defense in
  // depth — start_driver.{sh,ps1} already refuse). The code is retained, not
  // deleted; GARELIER_ALLOW_DRIVER=1 is an unsupported internal escape hatch.
  if (process.env.GARELIER_ALLOW_DRIVER !== "1") {
    process.stderr.write(
      "Garelier is DISPATCH-ONLY: the headless driver (Mode B) is disabled (DEC-061).\n" +
      "Run roles via dispatch — the interactive PM/Dock session dispatches each role as\n" +
      "an in-session subagent (or a 'codex exec' subprocess). See docs/execution_backends.md.\n",
    );
    process.exit(2);
  }
  main().catch((e) => {
    process.stderr.write(`Fatal: ${(e as Error).stack ?? (e as Error).message}\n`);
    process.exit(1);
  });
}
