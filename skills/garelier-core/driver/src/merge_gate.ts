// Driver-side tracking of the merge-gate subprocess (DEC-007).
//
// The driver spawns `merge-gate.{sh,ps1}` in the background. This module:
//   - enumerates pending requests under runtime/merge_gate/requests/
//   - enforces single-active concurrency via locks/active.lock
//   - spawns a fresh subprocess when active slot is free + queue non-empty
//   - on each driver tick, checks whether the active subprocess's pid is
//     still alive; if dead AND result file absent, synthesize an aborted
//     result so Dock can still react
//
// NOTE: the subprocess writes its own result.json atomically (via .tmp +
// rename); we never wait for it inside an iteration. The driver loop
// returns immediately so other agents can progress.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { isAbsolute, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./log.ts";
import type { SetupConfig } from "./config.ts";
import { roleContainer } from "./workspace.ts";

export interface MergeGatePaths {
  root: string;             // __garelier/<pm_id>/runtime/merge_gate
  requestsDir: string;      // .../requests
  resultsDir: string;       // .../results
  logsDir: string;          // .../logs
  locksDir: string;         // .../locks
  archiveDir: string;       // .../archive
  ackedDir: string;         // .../acked  (gate-producer auto-ack sentinels)
  activeLock: string;       // .../locks/active.lock
  nextSeqFile: string;      // .../next_seq
}

export function mergeGatePaths(projectRoot: string, pmId: string): MergeGatePaths {
  const root = join(projectRoot, "__garelier", pmId, "runtime", "merge_gate");
  return {
    root,
    requestsDir: join(root, "requests"),
    resultsDir:  join(root, "results"),
    logsDir:     join(root, "logs"),
    locksDir:    join(root, "locks"),
    archiveDir:  join(root, "archive"),
    ackedDir:    join(root, "acked"),
    activeLock:  join(root, "locks", "active.lock"),
    nextSeqFile: join(root, "next_seq"),
  };
}

export function ensureMergeGateDirs(p: MergeGatePaths): void {
  for (const d of [p.root, p.requestsDir, p.resultsDir, p.logsDir, p.locksDir, p.archiveDir, p.ackedDir]) {
    mkdirSync(d, { recursive: true });
  }
}

interface ActiveLock {
  pid: number;
  request_id: string;
  request_file: string;
  started_at: string;
  target_root?: string;
}

function readActiveLock(p: MergeGatePaths): ActiveLock | null {
  if (!existsSync(p.activeLock)) return null;
  try {
    return JSON.parse(readFileSync(p.activeLock, "utf8")) as ActiveLock;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // signal 0 = check liveness without delivery
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listRequestJsonFiles(p: MergeGatePaths): string[] {
  if (!existsSync(p.requestsDir)) return [];
  return readdirSync(p.requestsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function isSummarySidecar(file: string): boolean {
  // A dispatchable merge request is `<seq>-<slug>.json`. The merge-gate
  // subprocess writes a compact `<seq>-<slug>.summary.json` companion into
  // results/, and a producer may also drop a request-side `*.summary.json`
  // sidecar. Neither is itself a merge request — they must never be dispatched.
  return file.endsWith(".summary.json");
}

function resultExists(p: MergeGatePaths, stem: string): boolean {
  return existsSync(join(p.resultsDir, `${stem}.json`));
}

function requestTargetRoot(requestPath: string, fallback: string): string {
  try {
    const raw = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    const target = typeof raw.target_root === "string" ? raw.target_root.trim() : "";
    return target ? (isAbsolute(target) ? target : resolve(fallback, target)) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Move a non-dispatchable request file out of requests/ so it cannot block the
 * queue head. Best-effort: if the archive name already exists (or a cross-device
 * rename fails) the file is simply dropped — leaving it would loop forever.
 */
function archiveStaleRequest(p: MergeGatePaths, file: string, reason: string, log: Logger): void {
  const from = join(p.requestsDir, file);
  try {
    mkdirSync(p.archiveDir, { recursive: true });
    renameSync(from, join(p.archiveDir, file));
  } catch {
    try { unlinkSync(from); } catch { /* ignore */ }
  }
  log.info("merge_gate_request_pruned", { request_file: file, reason });
}

/**
 * Called once per driver iteration. Non-blocking.
 *
 * 1. If active.lock exists but pid is dead AND no result file landed
 *    yet, the subprocess crashed → write a synthetic "aborted" result
 *    + release the lock so the queue moves on.
 * 2. If active.lock is absent and there's a pending request, spawn the
 *    next one as a background subprocess.
 *
 * `spawnFn` is injected so tests can stub it.
 */
// ---------------------------------------------------------------------------
// Gate-producer auto-ack backstop (Guardian / Observer release).
//
// Guardian and Observer are commit-free gate/review producers: they emit a
// verdict, transition REPORTING, and wait for the requester (Dock) to drop
// `acked.md` into their container before they archive + return to IDLE. But the
// Dock skill never reliably writes that ack — it embeds the verdict in the
// merge request and merges, leaving a PASSING gate producer orphaned in
// REPORTING forever, unusable for the next gate (observed live: guardian-01
// stuck on GATE-#15-final long after #15 merged).
//
// This closes the handshake deterministically: once the merge a verdict fed has
// SUCCEEDED, the driver writes `acked.md` to that producer's container — but
// only while it is still REPORTING and unacked. Stateless + idempotent: it
// reconciles from the durable request + result records each poll, so it also
// releases producers stranded by merges that completed before this code existed.

interface GateProducerRef {
  role: "guardian" | "observer";
  id: string;
  verdict: string | null;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Pull the `<id>` out of an `…/_guardians/<id>/…` or `…/_observers/<id>/…` path. */
function roleIdFromReportPath(reportPath: string, marker: string): string | null {
  const parts = reportPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const i = parts.indexOf(marker);
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
}

interface MergeRequestGateInfo {
  requestId: string | null;
  reviewSha: string | null;
  taskId: string | null;
  producers: GateProducerRef[];
}

function parseMergeRequestGateInfo(filePath: string): MergeRequestGateInfo | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const producers: GateProducerRef[] = [];
  const gPath = strOrNull(raw.guardian_report_path);
  if (gPath) {
    const id = roleIdFromReportPath(gPath, "_guardians");
    if (id) producers.push({ role: "guardian", id, verdict: strOrNull(raw.guardian_verdict) });
  }
  const oPath = strOrNull(raw.observer_report_path);
  if (oPath) {
    const id = roleIdFromReportPath(oPath, "_observers");
    if (id) producers.push({ role: "observer", id, verdict: strOrNull(raw.observer_verdict) });
  }
  if (producers.length === 0) return null;
  return {
    requestId: strOrNull(raw.request_id),
    reviewSha: strOrNull(raw.review_sha) ?? strOrNull(raw.workbench_tip),
    taskId: strOrNull(raw.task_id),
    producers,
  };
}

/** Newest merge-result status for a stem (still in results/, or Dock-archived). */
function mergeResultStatus(p: MergeGatePaths, stem: string): string | null {
  for (const f of [join(p.resultsDir, `${stem}.json`), join(p.archiveDir, `${stem}.result.json`)]) {
    if (!existsSync(f)) continue;
    try {
      const st = strOrNull((JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>).status);
      if (st) return st;
    } catch { /* ignore */ }
  }
  return null;
}

/** Read the `## Status` value from a container's STATE.md. */
function containerStatus(container: string): string | null {
  try {
    const m = readFileSync(join(container, "STATE.md"), "utf8").match(/##\s*Status\s*\r?\n\s*([A-Za-z_]+)/);
    return m ? m[1]!.toUpperCase() : null;
  } catch {
    return null;
  }
}

/** (filePath, stem) for live + most-recently-archived merge requests. */
function listMergeRequestRecords(p: MergeGatePaths, archiveScanLimit = 25): Array<{ filePath: string; stem: string }> {
  const out: Array<{ filePath: string; stem: string }> = [];
  if (existsSync(p.requestsDir)) {
    for (const f of readdirSync(p.requestsDir)) {
      if (f.endsWith(".json") && !f.endsWith(".summary.json")) {
        out.push({ filePath: join(p.requestsDir, f), stem: f.replace(/\.json$/, "") });
      }
    }
  }
  if (existsSync(p.archiveDir)) {
    for (const f of readdirSync(p.archiveDir).filter((x) => x.endsWith(".request.json")).sort().slice(-archiveScanLimit)) {
      out.push({ filePath: join(p.archiveDir, f), stem: f.replace(/\.request\.json$/, "") });
    }
  }
  return out;
}

/**
 * Auto-ack gate producers (Guardian/Observer) whose verdict fed a now-SUCCESSFUL
 * merge but who are still waiting in REPORTING. Best-effort, idempotent, and
 * must never throw out of the merge-gate poll. Returns the acked `role:id`s.
 */
export function reconcileGateAcks(projectRoot: string, pmId: string, p: MergeGatePaths, log: Logger): string[] {
  const acked: string[] = [];
  let records: Array<{ filePath: string; stem: string }>;
  try { records = listMergeRequestRecords(p); } catch { return acked; }
  for (const { filePath, stem } of records) {
    const info = parseMergeRequestGateInfo(filePath);
    if (!info) continue;
    if (mergeResultStatus(p, stem) !== "success") continue;
    for (const prod of info.producers) {
      let container: string;
      try { container = roleContainer(projectRoot, pmId, prod.role, prod.id); } catch { continue; }
      const ackFile = join(container, "acked.md");
      const sentinel = join(p.ackedDir, `${prod.role}__${prod.id}__${stem}.done`);
      const status = containerStatus(container);

      // Not REPORTING → the producer has already consumed the ack (or never
      // waited). An `acked.md` lingering on a non-REPORTING producer is a stale
      // leftover (an IDLE producer has no pending gate) that would prematurely
      // satisfy `hasAcked` for its NEXT gate — remove it. This also self-heals a
      // stray left by the write-vs-release race below.
      if (status !== "REPORTING") {
        if (existsSync(ackFile)) { try { unlinkSync(ackFile); } catch { /* ignore */ } }
        continue;
      }

      // REPORTING → ack exactly once per (merge, producer). The sentinel makes
      // this race-safe: the producer deletes acked.md as it archives but flips
      // STATE to IDLE a beat later, so a re-poll in that window would otherwise
      // re-strand a fresh acked.md.
      if (existsSync(sentinel)) continue;
      if (existsSync(ackFile)) {                                  // already acked by someone
        try { writeFileSync(sentinel, new Date().toISOString(), "utf8"); } catch { /* ignore */ }
        continue;
      }
      const body = [
        `# Acked`,
        ``,
        `Your gate verdict was consumed by a successful merge — archive your report and return to IDLE.`,
        ``,
        `- role: ${prod.role} ${prod.id}`,
        `- verdict consumed: ${prod.verdict ?? "(unspecified)"}`,
        `- task: ${info.taskId ?? "(unknown)"}`,
        `- review_sha: ${info.reviewSha ?? "(unknown)"}`,
        `- merge_request: ${info.requestId ?? stem}`,
        `- acked_by: driver auto-ack backstop (merge-gate)`,
        `- acked_at: ${new Date().toISOString()}`,
        ``,
      ].join("\n");
      try {
        writeFileSync(ackFile, body, "utf8");
        try { writeFileSync(sentinel, new Date().toISOString(), "utf8"); } catch { /* sentinel is best-effort */ }
        log.info("gate_producer_auto_acked", {
          role: prod.role, id: prod.id, request_id: info.requestId ?? stem, review_sha: info.reviewSha,
        });
        acked.push(`${prod.role}:${prod.id}`);
      } catch (e) {
        log.warn("gate_producer_auto_ack_failed", { role: prod.role, id: prod.id, error: (e as Error).message });
      }
    }
  }
  return acked;
}

export interface PollResult {
  spawnedRequestId?: string;
  recoveredAbortedRequestId?: string;
}

export async function pollMergeGate(
  projectRoot: string,
  config: SetupConfig,
  log: Logger,
  opts: {
    spawnFn?: (scriptPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => number;
    scriptOverride?: string;
  } = {},
): Promise<PollResult> {
  const p = mergeGatePaths(projectRoot, config.pmId);
  ensureMergeGateDirs(p);
  const result: PollResult = {};

  // Release any gate producer (Guardian/Observer) whose verdict fed a merge that
  // has since succeeded but is still stranded in REPORTING. Never break the poll.
  try { reconcileGateAcks(projectRoot, config.pmId, p, log); } catch { /* ignore */ }

  // ---- Step 1: detect dead-but-uncleaned subprocess ----
  const active = readActiveLock(p);
  if (active) {
    const alive = isPidAlive(active.pid);
    const stem = active.request_file.replace(/\.json$/, "");
    const resultLanded = resultExists(p, stem);
    if (!alive && !resultLanded) {
      // Subprocess died mid-merge. Synthesize an aborted result and
      // release the lock so Dock sees the failure on its next iter.
      log.warn("merge_gate_subprocess_died", { pid: active.pid, request_id: active.request_id });
      writeSyntheticAbortedResult(p, active, stem);
      try { unlinkSync(p.activeLock); } catch { /* ignore */ }
      result.recoveredAbortedRequestId = active.request_id;
      // Best-effort: leave the index clean for the next merge.
      try {
        const proc = Bun.spawnSync(["git", "merge", "--abort"], {
          cwd: active.target_root ?? projectRoot,
          stderr: "ignore",
          stdout: "ignore",
        });
        if (proc.exitCode !== 0) {
          // No active merge, expected
        }
      } catch { /* ignore */ }
    }
    if (alive) {
      // Still running — nothing to do this tick.
      return result;
    }
    if (alive === false && resultLanded) {
      // Subprocess finished naturally. Lock should already be gone (script
      // cleans up); if it's still there, drop it now.
      try { unlinkSync(p.activeLock); } catch { /* ignore */ }
    }
  }

  // ---- Step 2: prune non-dispatchable entries, then spawn the oldest real,
  //              UNRESOLVED request ----
  //
  // Structural head-of-line-blocking guard (self-healing). requests/ can hold
  // entries that must never be (re)dispatched:
  //   (a) summary sidecars (`*.summary.json`) — companions, not merge requests;
  //   (b) real requests that already produced a result but whose request file
  //       was not archived (the subprocess exited before its archive step, the
  //       driver synthesized an aborted result, or a producer wrote an extra
  //       copy).
  // If such an entry sorts to the head of the queue it would be respawned every
  // tick forever and starve newer requests — and a sidecar's name collides with
  // the real request's result-summary companion, so resultExists() is fooled
  // into thinking it "finished". Prune these on sight; dispatch always advances
  // to the oldest UNRESOLVED real request regardless of who wrote what.
  const allRequestFiles = listRequestJsonFiles(p);
  const realRequestSet = new Set(allRequestFiles.filter((f) => !isSummarySidecar(f)));

  let next: string | undefined;
  for (const f of allRequestFiles) {
    if (isSummarySidecar(f)) {
      // Prune a sidecar only once its parent request is no longer queued, so a
      // sidecar is never removed while its real request is still pending.
      const parent = f.replace(/\.summary\.json$/, ".json");
      if (!realRequestSet.has(parent)) archiveStaleRequest(p, f, "orphan_sidecar", log);
      continue;
    }
    const fStem = f.replace(/\.json$/, "");
    if (resultExists(p, fStem)) {
      archiveStaleRequest(p, f, "already_resolved", log);
      continue;
    }
    if (next === undefined) next = f; // oldest unresolved real request
  }
  if (next === undefined) return result;

  const requestPath = join(p.requestsDir, next);
  const stem = next.replace(/\.json$/, "");
  const targetRoot = requestTargetRoot(requestPath, projectRoot);

  // Determine which script to use.
  const isWindows = process.platform === "win32";
  const scriptPath = opts.scriptOverride ?? defaultScriptPath(isWindows);
  if (!existsSync(scriptPath)) {
    log.error("merge_gate_script_missing", { path: scriptPath });
    return result;
  }

  // The lock is written AFTER spawn (we need the child pid; the script only
  // checks the lock at cleanup, `clear_lock_if_mine`). This leaves a small
  // double-spawn window if two pollers run concurrently — the design assumes a
  // SINGLE poller (the Dock / driver loop). Do not call poll from
  // parallel agents; serializing the lock write would need a placeholder-pid
  // protocol (recorded as a W-008 finding in the _workshop control tree).
  const startedAt = new Date().toISOString();

  const spawnFn = opts.spawnFn ?? defaultSpawn;
  let pid: number;
  try {
    if (isWindows) {
      pid = spawnFn(scriptPath, [requestPath], targetRoot, {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      });
    } else {
      pid = spawnFn(scriptPath, [requestPath], targetRoot, {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      });
    }
  } catch (e) {
    log.error("merge_gate_spawn_failed", { error: (e as Error).message });
    return result;
  }

  const lock: ActiveLock = {
    pid,
    request_id: stem,
    request_file: next,
    started_at: startedAt,
    target_root: targetRoot,
  };
  writeFileSync(p.activeLock, JSON.stringify(lock, null, 2), "utf8");
  log.info("merge_gate_spawned", { pid, request_id: stem });
  result.spawnedRequestId = stem;
  return result;
}

function writeSyntheticAbortedResult(p: MergeGatePaths, active: ActiveLock, stem: string): void {
  const ended = new Date().toISOString();
  const startedMs = Date.parse(active.started_at);
  const duration = isNaN(startedMs) ? 0 : (Date.now() - startedMs);
  const obj = {
    request_id: active.request_id,
    status: "aborted",
    studio_commit: null,
    started_at: active.started_at,
    ended_at: ended,
    duration_ms: duration,
    gate_steps: [],
    failure_reason: `subprocess pid ${active.pid} died without writing result (driver detected on next poll)`,
    conflict_files: null,
    pre_merge_target_advanced: false,
  };
  const tmp = join(p.resultsDir, `${stem}.json.tmp`);
  const final = join(p.resultsDir, `${stem}.json`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, final);
  writeMergeResultSummary(p, stem, {
    schema_version: 1,
    request_id: active.request_id,
    status: "aborted",
    quality_gate_mode: "full",
    quality_gate_command_count: 0,
    quality_gate_timeout_minutes_per_cmd: null,
    studio_commit: null,
    started_at: active.started_at,
    ended_at: ended,
    duration_ms: duration,
    gate_steps: [],
    failure_reason: obj.failure_reason,
    conflict_files: null,
    pre_merge_target_advanced: false,
    log_file: `runtime/merge_gate/logs/${stem}.log`,
  });
}

function writeMergeResultSummary(p: MergeGatePaths, stem: string, obj: Record<string, unknown>): void {
  const tmp = join(p.resultsDir, `${stem}.summary.json.tmp`);
  const final = join(p.resultsDir, `${stem}.summary.json`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, final);
}

function defaultScriptPath(isWindows: boolean): string {
  // The driver lives at __garelier/<pm_id>/runtime/driver/, but the
  // skill is symlinked into ~/.claude/skills/garelier-core/. From the
  // driver's perspective, the install location is resolved relative to
  // skillCoreDir which main.ts already computes. To avoid threading that
  // through here, we read GARELIER_SKILL_CORE_DIR from env which main.ts
  // sets on spawn. Fallback: ~/.claude/skills/garelier-core.
  // DEC-053: cache-safe + dual-mode. main.ts sets GARELIER_SKILL_CORE_DIR in the
  // driver flow; in the Dock-bay/standalone flow (dock_merge.ts) it is unset, so
  // self-locate via import.meta (src -> driver -> garelier-core) before the legacy
  // $HOME fallback so the merge-gate script is found in the plugin cache too.
  const selfCoreDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const skillCoreDir =
    process.env.GARELIER_SKILL_CORE_DIR ??
    (process.env.CLAUDE_PLUGIN_ROOT ? join(process.env.CLAUDE_PLUGIN_ROOT, "skills", "garelier-core") : undefined) ??
    (existsSync(join(selfCoreDir, "SKILL.md")) ? selfCoreDir : undefined) ??
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".claude", "skills", "garelier-core");
  return isWindows
    ? join(skillCoreDir, "scripts", "merge-gate.ps1")
    : join(skillCoreDir, "scripts", "merge-gate.sh");
}

function defaultSpawn(scriptPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): number {
  // Bun.spawn returns a Subprocess with .pid. The subprocess is detached
  // by not awaiting .exited.
  const isPs = scriptPath.endsWith(".ps1");
  const cmd = isPs
    ? ["pwsh", "-NoProfile", "-NonInteractive", "-File", scriptPath, ...args]
    : ["bash", scriptPath, ...args];
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "ignore",  // subprocess writes its own log file
    stderr: "ignore",
    windowsHide: true, // Windows: no console window for the pwsh/bash merge subprocess
  });
  return proc.pid;
}

/**
 * Called by Dock LLM (via this module) to enqueue a merge request.
 * The caller passes the task branch + agent id + the active
 * merge_message; full quality_gate_commands come from config.qualityGate.
 *
 * Returns the request_id stem (= filename without .json).
 */
export function writeMergeRequest(
  projectRoot: string,
  config: SetupConfig,
  args: {
    workbenchBranch: string;
    workerId: string;
    taskId: string;
    mergeMessage: string;
    agentRole?: "worker" | "smith";
    agentId?: string;
  },
): string {
  const p = mergeGatePaths(projectRoot, config.pmId);
  ensureMergeGateDirs(p);

  // Allocate next seq.
  let seq = 1;
  if (existsSync(p.nextSeqFile)) {
    const cur = parseInt(readFileSync(p.nextSeqFile, "utf8").trim(), 10);
    if (!isNaN(cur)) seq = cur;
  }
  const seqStr = String(seq).padStart(3, "0");
  writeFileSync(p.nextSeqFile, String(seq + 1), "utf8");

  // Derive a slug for the filename.
  const slug = args.workbenchBranch.split("/").pop()!.replace(/[^a-zA-Z0-9._-]/g, "-");
  const stem = `${seqStr}-${slug}`;
  const requestPath = join(p.requestsDir, `${stem}.json`);

  const obj = {
    request_id: stem,
    workbench_branch: args.workbenchBranch,
    worker_id: args.workerId,
    agent_role: args.agentRole ?? "worker",
    agent_id: args.agentId ?? args.workerId,
    task_id: args.taskId,
    requested_at: new Date().toISOString(),
    requested_by: "dock",
    studio_branch: config.branches.integration,
    merge_message: args.mergeMessage,
    quality_gate_mode: "full",
    quality_gate_commands: config.qualityGate.fullCommands,
    quality_gate_timeout_minutes_per_cmd: config.qualityGate.fullTimeoutMinutesPerCmd,
    quality_gate_fast_commands: config.qualityGate.fastCommands,
    quality_gate_fast_timeout_minutes_per_cmd: config.qualityGate.fastTimeoutMinutesPerCmd,
    quality_gate_full_commands: config.qualityGate.fullCommands,
    quality_gate_full_timeout_minutes_per_cmd: config.qualityGate.fullTimeoutMinutesPerCmd,
    pre_merge_base_tracking: true,
  };

  const tmp = `${requestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, requestPath);
  return stem;
}
