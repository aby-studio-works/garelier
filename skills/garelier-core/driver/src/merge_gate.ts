// Driver-side tracking of the merge-gate subprocess (DEC-007).
//
// The driver spawns `merge-gate.sh` in the background. This module:
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
  statSync,
} from "node:fs";
import { isAbsolute, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import type { Logger } from "./log.ts";
import type { SetupConfig } from "./config.ts";
import { roleContainer } from "./workspace.ts";
import { reportArtifact } from "./role_contracts.ts";
import { resolveTrustedTargetRoot } from "./merge_gate_parse.ts";
import { pidAlive } from "./scripts/_lib.ts";

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

export interface JsonDirectorySummary { count: number; recent: string[] }

export function summarizeJsonDirectory(dir: string, recentLimit = 3): JsonDirectorySummary {
  const all = existsSync(dir)
    ? readdirSync(dir).filter((file) => file.endsWith(".json")).sort()
    : [];
  return { count: all.length, recent: all.slice(-recentLimit) };
}

/** Public status view used by dock_merge without reimplementing gate storage. */
export function mergeGateStatusSnapshot(p: MergeGatePaths): {
  active: ActiveLock | { unparsed: true } | null;
  pending: JsonDirectorySummary;
  results: JsonDirectorySummary;
} {
  let active: ActiveLock | { unparsed: true } | null = null;
  if (existsSync(p.activeLock)) {
    try { active = JSON.parse(readFileSync(p.activeLock, "utf8")) as ActiveLock; }
    catch { active = { unparsed: true }; }
  }
  return {
    active,
    pending: summarizeJsonDirectory(p.requestsDir),
    results: summarizeJsonDirectory(p.resultsDir),
  };
}

const TERMINAL_MERGE_STATUSES = new Set(["success", "failed", "conflict", "aborted"]);

export function readTerminalMergeResult(
  p: MergeGatePaths,
  requestId: string,
): { request_id: string; status: string; result_file: string } | null {
  const summary = join(p.resultsDir, `${requestId}.summary.json`);
  const full = join(p.resultsDir, `${requestId}.json`);
  const file = existsSync(summary) ? summary : existsSync(full) ? full : null;
  if (!file) return null;
  try {
    const status = String((JSON.parse(readFileSync(file, "utf8")) as { status?: unknown }).status ?? "");
    return TERMINAL_MERGE_STATUSES.has(status)
      ? { request_id: requestId, status, result_file: file }
      : null;
  } catch {
    return null;
  }
}

// W-045: a request's target_root is untrusted (hand-edited, a broken test
// fixture, a stale/foreign lock, ...). The prior implementation resolved any
// non-absolute value AGAINST `fallback` and trusted the result — so a bogus
// relative string (e.g. a literal, unexpanded "$DT" leaking out of a shell
// fixture) silently became `<fallback>/$DT`, a real absolute path the caller
// then used as a spawn cwd, and the OS/producer script would happily mkdir
// into it, planting a stray literal-named directory INSIDE the real project.
// Trust only a value that is already absolute AND names an existing
// directory; anything else (relative, missing, or containing a literal "$")
// falls back to `fallback` untouched — it is never resolved-then-trusted.
function requestTargetRoot(requestPath: string, fallback: string): string {
  try {
    const raw = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    const target = typeof raw.target_root === "string" ? raw.target_root.trim() : "";
    if (!target || target.includes("$") || !isAbsolute(target)) return fallback;
    try {
      return statSync(target).isDirectory() ? target : fallback;
    } catch {
      return fallback;
    }
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

/** Rewrite the status token under a STATE.md's `## Status` heading to `IDLE`.
 *  Returns true when the file was changed. Best-effort; never throws. */
function flipContainerStateToIdle(container: string): boolean {
  const stateFile = join(container, "STATE.md");
  let text: string;
  try { text = readFileSync(stateFile, "utf8"); } catch { return false; }
  const next = text.replace(
    /(##[ \t]*Status[ \t]*\r?\n(?:[ \t]*\r?\n)*)[A-Za-z_]+/,
    "$1IDLE",
  );
  if (next === text) return false;
  try { writeFileSync(stateFile, next, "utf8"); return true; } catch { return false; }
}

/**
 * Mechanically run a stranded gate producer's REPORTING → archive → IDLE finish
 * (Observer review-workflow §6 / Guardian SKILL §10) — the step the DELETED
 * headless driver (DEC-066) used to trigger by waking the agent on `acked.md`.
 * In dispatch-only mode nothing wakes the agent, so the poll closes it: archive
 * the request's handoff files under `archive/<request_id>/` and flip STATE.md to
 * IDLE. Symmetric for both gate roles. Ephemeral-branch hygiene (gavel/monocle)
 * is intentionally NOT done here — `branch_gc` reclaims those once the producer
 * is IDLE, so this needs no git ops on the producer's worktree. Best-effort,
 * idempotent, and never throws out of the poll.
 */
function finalizeStrandedGateProducer(
  container: string,
  role: "guardian" | "observer",
  requestId: string,
  log: Logger,
): void {
  try {
    const archiveInto = join(container, "archive", requestId);
    // The files the agent's §6/§10 archive would move out of the container root.
    for (const name of ["assignment.md", reportArtifact(role), "advice.md"]) {
      const src = join(container, name);
      if (!existsSync(src)) continue;
      try {
        mkdirSync(archiveInto, { recursive: true });
        renameSync(src, join(archiveInto, name));
      } catch { /* best-effort per-file archive */ }
    }
    const stateIdle = flipContainerStateToIdle(container);
    log.info("gate_producer_finalized", { role, request_id: requestId, state_idle: stateIdle });
  } catch (e) {
    log.warn("gate_producer_finalize_failed", { role, request_id: requestId, error: (e as Error).message });
  }
}

/**
 * Auto-ack AND finalize gate producers (Guardian/Observer) whose verdict fed a
 * now-SUCCESSFUL merge but who are still waiting in REPORTING. First reconcile
 * writes the ack (`acked.md`); a subsequent reconcile that still finds `acked.md`
 * un-consumed (dispatch-only, no agent) mechanically finalizes the producer to
 * IDLE. Best-effort, idempotent, and must never throw out of the merge-gate
 * poll. Returns the newly-acked `role:id`s.
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

      // REPORTING, first encounter (no sentinel) → write the ack exactly once per
      // (merge, producer) and record the sentinel. We do NOT finalize on this pass:
      // an ATTENDED gate producer subagent gets this cycle to consume `acked.md`
      // and run its own §6/§10 archive + IDLE flip. The sentinel makes this
      // race-safe: the agent deletes acked.md as it archives but flips STATE to
      // IDLE a beat later, so a re-poll in that window would otherwise re-strand a
      // fresh acked.md.
      if (!existsSync(sentinel)) {
        if (existsSync(ackFile)) {                                // already acked by someone
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
        continue;
      }

      // Sentinel already present (acked on an earlier reconcile) yet the producer
      // is STILL REPORTING with `acked.md` un-consumed → no live agent picked it
      // up (dispatch-only, DEC-066 deleted the waker). Finalize mechanically so it
      // does not strand: archive the handoff + flip STATE to IDLE (branch_gc then
      // reclaims the ephemeral branch). If acked.md is GONE, an attended agent is
      // mid-archive — leave it to finish; a later `status !== REPORTING` pass will
      // reconcile any leftovers.
      if (existsSync(ackFile)) {
        finalizeStrandedGateProducer(container, prod.role, info.requestId ?? stem, log);
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

  // ---- Step 1: detect a dead-but-uncleaned OR hung-but-alive subprocess ----
  const active = readActiveLock(p);
  if (active) {
    const alive = pidAlive(active.pid);
    const stem = active.request_file.replace(/\.json$/, "");
    const resultLanded = resultExists(p, stem);
    if (!alive && !resultLanded) {
      // Subprocess died mid-merge. Synthesize an aborted result and release the
      // lock so Dock sees the failure on its next iter, then fall through to
      // spawn the next queued request.
      log.warn("merge_gate_subprocess_died", { pid: active.pid, request_id: active.request_id });
      abortActiveGate(p, projectRoot, config, active, stem, undefined, log);
      result.recoveredAbortedRequestId = active.request_id;
    } else if (alive) {
      // Watchdog (W-063): pid liveness ALONE cannot tell a hung gate from a
      // healthy long build — a wedged command (e.g. a rustc that ignores
      // SIGTERM) keeps the subprocess alive indefinitely, holding the single
      // active.lock and blocking the WHOLE merge queue forever. If the gate has
      // run past its computed ceiling AND its log has gone quiet, treat it as
      // hung: kill its process tree, synthesize an aborted(timeout) result,
      // release the lock, and fall through to drain the next queued request.
      // Otherwise it is genuinely still working — leave it running this tick.
      const ceilingMs = computeGateCeilingMs(
        activeRequestPath(p, active, stem),
        readGateCeilingMsConfig(projectRoot, config.pmId),
      );
      const startedAtMs = Date.parse(active.started_at);
      const decision = evaluateGateStale({
        startedAtMs,
        nowMs: Date.now(),
        ceilingMs,
        logMtimeMs: gateLogMtimeMs(p, stem),
      });
      if (!decision.stale) {
        // Still running within budget — nothing to do this tick.
        return result;
      }
      log.warn("merge_gate_watchdog_abort", {
        pid: active.pid,
        request_id: active.request_id,
        ceiling_ms: ceilingMs,
        elapsed_ms: Number.isNaN(startedAtMs) ? null : Date.now() - startedAtMs,
      });
      killGateProcessTree(active.pid);
      const reason =
        `merge gate exceeded its ${Math.round(ceilingMs / 60000)}-minute ceiling with a quiet log; ` +
        `driver watchdog killed pid ${active.pid} (W-063 hung gate)`;
      abortActiveGate(p, projectRoot, config, active, stem, reason, log);
      result.recoveredAbortedRequestId = active.request_id;
    } else if (resultLanded) {
      // alive === false && resultLanded: finished naturally. The script cleans up
      // its own lock; if it's still there, drop it now.
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

// ---------------------------------------------------------------------------
// Gate watchdog (W-063).
//
// The merge gate serializes on ONE active.lock. Before this, pollMergeGate only
// recovered a gate whose pid had DIED; a gate whose pid stayed alive but was
// HUNG (a wedged command that ignores SIGTERM, or a build stuck with no
// coreutils `timeout` to bound it) held the lock forever and blocked every
// queued merge. This computes an absolute wall-clock ceiling for a running gate
// and, once exceeded with a quiet log, force-kills its process tree and
// synthesizes an aborted result so the queue self-drains — the driver-side
// backstop to merge-gate.sh's per-command `timeout -k` (which native Windows
// grandchildren can escape).

const DEFAULT_GATE_PER_CMD_MINUTES = 120; // mirrors merge-gate.sh CMD_TIMEOUT_MINUTES default
// The request records only the quality_gate_commands list, but a gate also runs
// preflight + run-verify commands (each under the SAME per-cmd budget) and W-029
// can retry one gate command once. Multiply the enumerated budget by this factor
// as headroom for the commands the request does not list, plus a fixed margin
// for git merge / IO, so the ceiling is a generous LAST resort — not a tight
// per-command limit (that is merge-gate.sh's job).
const GATE_CEILING_CMD_FACTOR = 2;
const DEFAULT_GATE_CEILING_MARGIN_MS = 15 * 60_000;
const GATE_STALE_LOG_QUIET_MS_MIN = 60_000;
const GATE_STALE_LOG_QUIET_MS_MAX = 5 * 60_000;

/** The running gate's request file — live in requests/, else the archived copy. */
function activeRequestPath(p: MergeGatePaths, active: ActiveLock, stem: string): string {
  const live = join(p.requestsDir, active.request_file);
  return existsSync(live) ? live : join(p.archiveDir, `${stem}.request.json`);
}

/** Newest mtime of the gate's log (proxy for "is the gate still making progress"). */
function gateLogMtimeMs(p: MergeGatePaths, stem: string): number | null {
  try { return statSync(join(p.logsDir, `${stem}.log`)).mtimeMs; } catch { return null; }
}

/**
 * Absolute wall-clock ceiling (ms) a running gate may take before the watchdog
 * considers it hung. Precedence: the request's explicit `max_duration_ms`, else
 * the project `[merge_gate] gate_ceiling_minutes` override, else derived from
 * `quality_gate_timeout_minutes_per_cmd × command count × factor + margin`.
 * Fails open to the derived default on any read/parse error.
 */
export function computeGateCeilingMs(requestPath: string, configCeilingMs?: number | null): number {
  let perCmdMin = DEFAULT_GATE_PER_CMD_MINUTES;
  let cmdCount = 1;
  let explicit: number | null = null;
  try {
    const raw = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    const md = raw.max_duration_ms;
    if (typeof md === "number" && Number.isFinite(md) && md > 0) explicit = md;
    const t = raw.quality_gate_timeout_minutes_per_cmd;
    if (typeof t === "number" && Number.isFinite(t) && t > 0) perCmdMin = t;
    const cmds = raw.quality_gate_commands;
    if (Array.isArray(cmds) && cmds.length > 0) cmdCount = cmds.length;
  } catch { /* fall through to the derived default */ }
  if (explicit != null) return explicit;
  if (typeof configCeilingMs === "number" && Number.isFinite(configCeilingMs) && configCeilingMs > 0) return configCeilingMs;
  return perCmdMin * 60_000 * Math.max(cmdCount, 1) * GATE_CEILING_CMD_FACTOR + DEFAULT_GATE_CEILING_MARGIN_MS;
}

/** Read `[merge_gate] gate_ceiling_minutes` (ms), or null to use the derived default. */
export function readGateCeilingMsConfig(projectRoot: string, pmId: string): number | null {
  const configPath = join(projectRoot, "__garelier", pmId, "_pm", "setup_config.toml");
  if (!existsSync(configPath)) return null;
  try {
    const raw = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mg = raw.merge_gate as Record<string, unknown> | undefined;
    const n = mg?.gate_ceiling_minutes;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n * 60_000 : null;
  } catch {
    return null;
  }
}

export interface GateStaleDecision { stale: boolean; ceilingExceeded: boolean; logQuiet: boolean; }

/**
 * A running gate is stale (hung) only when it has BOTH run past its ceiling AND
 * its log has gone quiet for the quiet window. Requiring both avoids killing a
 * legitimately slow-but-progressing gate whose ceiling was under-estimated. A
 * missing log (`logMtimeMs` null) or an unparseable start time counts as quiet /
 * exceeded respectively is handled conservatively: an unparseable start time is
 * NOT treated as exceeded (we cannot judge elapsed), so the gate is left alone.
 */
export function evaluateGateStale(o: {
  startedAtMs: number;
  nowMs: number;
  ceilingMs: number;
  logMtimeMs: number | null;
}): GateStaleDecision {
  const startKnown = Number.isFinite(o.startedAtMs);
  const elapsed = o.nowMs - o.startedAtMs;
  const ceilingExceeded = startKnown && o.ceilingMs > 0 && elapsed > o.ceilingMs;
  const quietWindow = Math.max(
    GATE_STALE_LOG_QUIET_MS_MIN,
    Math.min(o.ceilingMs * 0.25, GATE_STALE_LOG_QUIET_MS_MAX),
  );
  const sinceLog = o.logMtimeMs == null ? Infinity : o.nowMs - o.logMtimeMs;
  const logQuiet = sinceLog >= quietWindow;
  return { stale: ceilingExceeded && logQuiet, ceilingExceeded, logQuiet };
}

/**
 * Force-kill a gate subprocess and its descendants. On Windows `taskkill /T /F`
 * walks the native child tree (cargo → rustc) while it is still parented to the
 * recorded bash pid — the authoritative reaper where MSYS2 signals do not reach
 * native grandchildren. On POSIX, TERM then KILL the process group (if the gate
 * is a group leader) and the pid itself. Best-effort; never throws.
 */
function killGateProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    if (process.platform === "win32") {
      const killed = Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdout: "ignore", stderr: "ignore",
      });
      // Restricted Windows sandboxes can deny taskkill even for a subprocess
      // this Bun process owns. Retain the tree kill as the primary path, but at
      // least terminate the recorded owner through the native process handle.
      if (killed.exitCode !== 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    } else {
      for (const sig of ["SIGTERM", "SIGKILL"] as const) {
        try { process.kill(-pid, sig); } catch { /* not a group leader */ }
        try { process.kill(pid, sig); } catch { /* already gone */ }
      }
    }
  } catch { /* best-effort */ }
}

/**
 * Terminal cleanup for an active gate the driver is aborting (dead pid OR
 * watchdog-detected hang): write the aborted result, run the retention prunes,
 * release the lock, and leave the working tree clean. Shared by both abort paths
 * so the recovery sequence has exactly one implementation. Never throws.
 */
function abortActiveGate(
  p: MergeGatePaths,
  projectRoot: string,
  config: SetupConfig,
  active: ActiveLock,
  stem: string,
  reason: string | undefined,
  log: Logger,
): void {
  writeSyntheticAbortedResult(p, active, stem, reason);
  try { pruneMergeGateResults(p, readResultsKeepConfig(projectRoot, config.pmId), log); } catch { /* pruning must never break the poll */ }
  try { pruneMergeGateArchive(p, readArchiveKeepDaysConfig(projectRoot, config.pmId), log); } catch { /* pruning must never break the poll */ }
  try { pruneMergeGateLogs(p, readLogsKeepConfig(projectRoot, config.pmId), log); } catch { /* pruning must never break the poll */ }
  try { capMergeGateLogSizes(p, readLogMaxBytesConfig(projectRoot, config.pmId), log); } catch { /* pruning must never break the poll */ }
  try { unlinkSync(p.activeLock); } catch { /* ignore */ }
  // Best-effort: leave the index clean for the next merge. W-048: route
  // active.target_root through the same absolute+existing-dir trust guard as
  // requestTargetRoot()/resolveTrustedTargetRoot() (W-045) — a hand-edited or
  // stale active.lock could otherwise carry a relative/malformed target_root
  // that becomes a spawn cwd (same class as stray-var-dir-leak.md).
  try {
    Bun.spawnSync(["git", "merge", "--abort"], {
      cwd: resolveTrustedTargetRoot(active.target_root, projectRoot),
      stderr: "ignore",
      stdout: "ignore",
    });
  } catch { /* ignore */ }
}

function writeSyntheticAbortedResult(p: MergeGatePaths, active: ActiveLock, stem: string, reason?: string): void {
  const ended = new Date().toISOString();
  const startedMs = Date.parse(active.started_at);
  const duration = isNaN(startedMs) ? 0 : (Date.now() - startedMs);
  const failureReason = reason ?? `subprocess pid ${active.pid} died without writing result (driver detected on next poll)`;
  const obj = {
    request_id: active.request_id,
    status: "aborted",
    studio_commit: null,
    started_at: active.started_at,
    ended_at: ended,
    duration_ms: duration,
    gate_steps: [],
    failure_reason: failureReason,
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

// ---------------------------------------------------------------------------
// Results retention (W-030 residual).
//
// `results/` gets one `.json` + one `.summary.json` per merge request and had
// no delete path — a long-running PM's results/ grows monotonically forever
// (a live target project measured 184 files / ~92 requests before this existed). Prune at
// WRITE time, not read time, so a caller (dock_merge.ts poll/status, the
// `await` loop) never observes a result it is mid-read on disappear —
// merge-gate.sh calls the `prune` CLI below right after every write_result(),
// and writeSyntheticAbortedResult() (this module's own result-writing path,
// used when the driver detects a dead gate subprocess) calls
// pruneMergeGateResults() directly. Both paths funnel through the same
// function so the retention policy has exactly one implementation.

const DEFAULT_RESULTS_KEEP = 40;

/** Read `[merge_gate] results_keep` from setup_config.toml; default 40, fail-open. */
export function readResultsKeepConfig(projectRoot: string, pmId: string): number {
  const configPath = join(projectRoot, "__garelier", pmId, "_pm", "setup_config.toml");
  if (!existsSync(configPath)) return DEFAULT_RESULTS_KEEP;
  try {
    const raw = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mg = raw.merge_gate as Record<string, unknown> | undefined;
    const n = mg?.results_keep;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : DEFAULT_RESULTS_KEEP;
  } catch {
    return DEFAULT_RESULTS_KEEP;
  }
}

export interface PruneResultsOutcome {
  prunedStems: string[];
  totalBefore: number;
  keep: number;
}

/**
 * Keep only the most recent `keep` request stems in results/ (filename-sorted
 * — stems are zero-padded seq-prefixed, so lexicographic order is
 * chronological order) and delete the `.json` + `.summary.json` pair for
 * everything older. Guards: a stem whose request is still queued in
 * requests/ (in-flight/unresolved — normally the request is archived by the
 * time its result exists, but this is defensive) and the stem the active
 * lock currently references are never pruned, even if they fall outside the
 * keep window. No-op when `keep` <= 0 or results/ is absent or already at or
 * under the cap.
 */
export function pruneMergeGateResults(p: MergeGatePaths, keep: number, log?: Logger): PruneResultsOutcome {
  if (!Number.isFinite(keep) || keep <= 0) return { prunedStems: [], totalBefore: 0, keep };
  if (!existsSync(p.resultsDir)) return { prunedStems: [], totalBefore: 0, keep };

  const stems = new Set<string>();
  for (const f of readdirSync(p.resultsDir)) {
    if (f.endsWith(".summary.json")) stems.add(f.slice(0, -".summary.json".length));
    else if (f.endsWith(".json")) stems.add(f.slice(0, -".json".length));
    // ignore .tmp (mid-write) and anything else
  }
  const sorted = [...stems].sort();
  const totalBefore = sorted.length;
  if (totalBefore <= keep) return { prunedStems: [], totalBefore, keep };

  const protectedStems = new Set<string>();
  if (existsSync(p.requestsDir)) {
    for (const f of readdirSync(p.requestsDir)) {
      if (f.endsWith(".json")) protectedStems.add(f.replace(/\.json$/, ""));
    }
  }
  const active = readActiveLock(p);
  if (active) protectedStems.add(active.request_file.replace(/\.json$/, ""));

  const pruneCount = totalBefore - keep;
  const prunedStems: string[] = [];
  for (const stem of sorted.slice(0, pruneCount)) {
    if (protectedStems.has(stem)) continue;
    for (const ext of [".json", ".summary.json"]) {
      try { unlinkSync(join(p.resultsDir, `${stem}${ext}`)); } catch { /* already gone */ }
    }
    prunedStems.push(stem);
  }
  if (prunedStems.length) {
    log?.info("merge_gate_results_pruned", { count: prunedStems.length, keep, total_before: totalBefore });
  }
  return { prunedStems, totalBefore, keep };
}

// ---------------------------------------------------------------------------
// Logs retention (W-030 fix).
//
// `logs/` gets one `<stem>.log` per merge request (the gate subprocess writes
// its stdout there; see log_file in writeSyntheticAbortedResult and merge-gate.sh)
// and — exactly like results/ before W-030 — had NO delete path, so it grows
// monotonically forever (a live target project measured 137MB / 120 files). This
// is the "write a log forever with no prune" class that can silently fill a disk.
// Kept by COUNT (like results/, not by age like archive/) so the newest N merge
// logs stay available for inspection. Same write-time trigger and guards as
// pruneMergeGateResults — pruned from the CLI `prune` path (after every
// write_result) and the driver's synthetic-abort poll path.

/**
 * Read `[merge_gate] logs_keep` from setup_config.toml; default = the effective
 * results_keep (which itself defaults to 40), fail-open. Sharing the results
 * default keeps a single knob for the common case while still allowing a
 * separate log budget when a project sets one.
 */
export function readLogsKeepConfig(projectRoot: string, pmId: string): number {
  const configPath = join(projectRoot, "__garelier", pmId, "_pm", "setup_config.toml");
  if (!existsSync(configPath)) return readResultsKeepConfig(projectRoot, pmId);
  try {
    const raw = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mg = raw.merge_gate as Record<string, unknown> | undefined;
    const n = mg?.logs_keep;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : readResultsKeepConfig(projectRoot, pmId);
  } catch {
    return readResultsKeepConfig(projectRoot, pmId);
  }
}

export interface PruneLogsOutcome {
  prunedStems: string[];
  totalBefore: number;
  keep: number;
}

/**
 * Keep only the most recent `keep` `<stem>.log` files in logs/ (filename-sorted
 * = chronological, since stems are zero-padded seq-prefixed) and delete the
 * rest. Guards mirror pruneMergeGateResults: a stem still queued in requests/
 * (in-flight — its log is being written) and the stem the active lock references
 * are never pruned. No-op when `keep` <= 0 or logs/ is absent or already at or
 * under the cap.
 */
export function pruneMergeGateLogs(p: MergeGatePaths, keep: number, log?: Logger): PruneLogsOutcome {
  if (!Number.isFinite(keep) || keep <= 0) return { prunedStems: [], totalBefore: 0, keep };
  if (!existsSync(p.logsDir)) return { prunedStems: [], totalBefore: 0, keep };

  const stems: string[] = [];
  for (const f of readdirSync(p.logsDir)) {
    if (f.endsWith(".log")) stems.push(f.slice(0, -".log".length));
  }
  const sorted = stems.sort();
  const totalBefore = sorted.length;
  if (totalBefore <= keep) return { prunedStems: [], totalBefore, keep };

  const protectedStems = new Set<string>();
  if (existsSync(p.requestsDir)) {
    for (const f of readdirSync(p.requestsDir)) {
      if (f.endsWith(".json")) protectedStems.add(f.replace(/\.json$/, ""));
    }
  }
  const active = readActiveLock(p);
  if (active) protectedStems.add(active.request_file.replace(/\.json$/, ""));

  const pruneCount = totalBefore - keep;
  const prunedStems: string[] = [];
  for (const stem of sorted.slice(0, pruneCount)) {
    if (protectedStems.has(stem)) continue;
    try { unlinkSync(join(p.logsDir, `${stem}.log`)); } catch { /* already gone */ }
    prunedStems.push(stem);
  }
  if (prunedStems.length) {
    log?.info("merge_gate_logs_pruned", { count: prunedStems.length, keep, total_before: totalBefore });
  }
  return { prunedStems, totalBefore, keep };
}

// ---------------------------------------------------------------------------
// Log SIZE cap (W-030 residual — the byte axis).
//
// pruneMergeGateLogs bounds the COUNT of <stem>.log files (keep the newest N),
// but a SINGLE log's byte size is still unbounded: merge-gate.sh streams the
// whole gate subprocess stdout/stderr into one <stem>.log, so a runaway build
// (a retry loop, a test that spams output) writes an arbitrarily large single
// file. keep(40) * unbounded_bytes = unbounded — the same "a log grows without
// bound and can fill the disk" class W-030 closed on the file-COUNT axis, still
// open on the per-file BYTE axis. This caps each retained log to `log_max_bytes`
// by keeping its HEAD (the request header + early steps) and TAIL (where the
// gate errors and the final verdict live) and dropping the middle behind a
// marker. The default (8 MiB) sits ABOVE a normal full-workspace build+test log
// (~4-5 MiB observed on a live target), so ordinary logs stay byte-identical and
// only a pathological runaway file is trimmed. Same write-time trigger and
// in-flight / active-lock guards as pruneMergeGateLogs. Nothing reads these logs
// into an agent context (dock_merge poll summarizes to {count, recent[3]},
// DEC-083), so this is purely disk hygiene — never a token or determinism concern.

const DEFAULT_LOG_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB — above a normal gate log
const LOG_CAP_HEAD_BYTES = 512 * 1024;         // keep the first 512 KiB (header + early steps)

/**
 * Read `[merge_gate] log_max_bytes` from setup_config.toml; default 8 MiB,
 * fail-open. A value <= 0 disables per-file capping. Mirrors the sibling
 * `[merge_gate]` retention knobs (results_keep / logs_keep / archive_keep_days)
 * because, like them, it drives an automated write-time prune.
 */
export function readLogMaxBytesConfig(projectRoot: string, pmId: string): number {
  const configPath = join(projectRoot, "__garelier", pmId, "_pm", "setup_config.toml");
  if (!existsSync(configPath)) return DEFAULT_LOG_MAX_BYTES;
  try {
    const raw = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mg = raw.merge_gate as Record<string, unknown> | undefined;
    const n = mg?.log_max_bytes;
    return typeof n === "number" && Number.isFinite(n) ? n : DEFAULT_LOG_MAX_BYTES;
  } catch {
    return DEFAULT_LOG_MAX_BYTES;
  }
}

export interface CapLogsOutcome {
  cappedStems: string[];
  maxBytes: number;
}

/**
 * Truncate each retained `<stem>.log` larger than `maxBytes` to head + tail,
 * inserting a one-line marker where the middle was dropped. Both cut points are
 * snapped to a newline so whole lines are kept and a multi-byte UTF-8 character
 * is never split. Guards mirror pruneMergeGateLogs: the in-flight stem (still
 * queued in requests/, its log actively being written) and the active-lock stem
 * are never rewritten. No-op when `maxBytes` <= 0, logs/ is absent, or no file
 * exceeds the cap. Best-effort per file — a read/write error skips that file,
 * never throws (pruning must not break the gate poll).
 */
export function capMergeGateLogSizes(p: MergeGatePaths, maxBytes: number, log?: Logger): CapLogsOutcome {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { cappedStems: [], maxBytes };
  if (!existsSync(p.logsDir)) return { cappedStems: [], maxBytes };

  const protectedStems = new Set<string>();
  if (existsSync(p.requestsDir)) {
    for (const f of readdirSync(p.requestsDir)) {
      if (f.endsWith(".json")) protectedStems.add(f.replace(/\.json$/, ""));
    }
  }
  const active = readActiveLock(p);
  if (active) protectedStems.add(active.request_file.replace(/\.json$/, ""));

  const cappedStems: string[] = [];
  for (const f of readdirSync(p.logsDir)) {
    if (!f.endsWith(".log")) continue;
    const stem = f.slice(0, -".log".length);
    if (protectedStems.has(stem)) continue;
    const path = join(p.logsDir, f);
    let buf: Buffer;
    try {
      if (statSync(path).size <= maxBytes) continue;
      buf = readFileSync(path);
    } catch { continue; }
    if (buf.length <= maxBytes) continue;

    // Head: keep the first ~headBudget bytes, extended forward to the next
    // newline so the last kept head line is whole.
    const headBudget = Math.min(LOG_CAP_HEAD_BYTES, Math.floor(maxBytes / 2));
    let headEnd = headBudget;
    const nlAfterHead = buf.indexOf(0x0a, headEnd);
    if (nlAfterHead !== -1 && nlAfterHead + 1 < buf.length) headEnd = nlAfterHead + 1;

    // Tail: keep the last ~tailBudget bytes, advanced forward past the first
    // (possibly partial) line so the first kept tail line is whole.
    const tailBudget = maxBytes - headEnd;
    let tailStart = buf.length - tailBudget;
    if (tailStart < headEnd) tailStart = headEnd;
    const nlBeforeTail = buf.indexOf(0x0a, tailStart);
    if (nlBeforeTail !== -1 && nlBeforeTail + 1 < buf.length) tailStart = nlBeforeTail + 1;
    if (tailStart <= headEnd) continue; // degenerate (lines too long to split meaningfully)

    const omitted = tailStart - headEnd;
    const marker = Buffer.from(
      `\n\n... [merge_gate log capped: ${omitted} bytes of the middle omitted to keep this file near ` +
        `${maxBytes} bytes (head ${headEnd} + tail ${buf.length - tailStart}); W-030 log_max_bytes. ` +
        `The full gate output was not retained.] ...\n\n`,
      "utf8",
    );
    const out = Buffer.concat([buf.subarray(0, headEnd), marker, buf.subarray(tailStart)]);
    try {
      writeFileSync(path, out);
      cappedStems.push(stem);
    } catch { /* best-effort */ }
  }
  if (cappedStems.length) {
    log?.info("merge_gate_logs_capped", { count: cappedStems.length, max_bytes: maxBytes });
  }
  return { cappedStems, maxBytes };
}

// ---------------------------------------------------------------------------
// Archive retention (W-038).
//
// `archive/` accumulates one `<stem>.request.json` per resolved merge request
// (archive_request() in merge-gate.sh, archiveStaleRequest() above) and — like
// results/ before W-030 — had no delete path, so it grows monotonically
// forever. retention.md documented `merge_gate_archive_keep_days` (default
// 14) as the policy since before this existed; this closes that doc/code gap.
// Unlike results/ (kept by COUNT because callers poll the newest N), archive/
// is kept by AGE (file mtime) because retention.md always specified a day
// window here, not a count. Same write-time trigger as pruneMergeGateResults
// — called from write_result() (via the `prune` CLI below) and from the
// driver's synthetic-abort path — so there is exactly one call class and no
// separate read-time sweep.

const DEFAULT_ARCHIVE_KEEP_DAYS = 14;

/**
 * Read `[merge_gate] archive_keep_days` from setup_config.toml; default 14,
 * fail-open. Deliberately mirrors readResultsKeepConfig's `[merge_gate]`
 * section (not the advisory `[retention]` defaults block in retention.md)
 * because, like results_keep, this value drives an actual automated prune —
 * retention.md's prose for `archive/` was updated to match (W-038).
 */
export function readArchiveKeepDaysConfig(projectRoot: string, pmId: string): number {
  const configPath = join(projectRoot, "__garelier", pmId, "_pm", "setup_config.toml");
  if (!existsSync(configPath)) return DEFAULT_ARCHIVE_KEEP_DAYS;
  try {
    const raw = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mg = raw.merge_gate as Record<string, unknown> | undefined;
    const n = mg?.archive_keep_days;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : DEFAULT_ARCHIVE_KEEP_DAYS;
  } catch {
    return DEFAULT_ARCHIVE_KEEP_DAYS;
  }
}

export interface PruneArchiveOutcome {
  prunedStems: string[];
  totalBefore: number;
  keepDays: number;
}

/**
 * Delete `<stem>.request.json` files in archive/ older than `keepDays` (by
 * mtime). Guards: a stem whose request is still queued in requests/ (should
 * not normally coexist with an archived copy, but defensive like the results
 * guard) and the stem the active lock currently references are never pruned.
 * No-op when `keepDays` <= 0 or archive/ is absent or empty.
 */
export function pruneMergeGateArchive(
  p: MergeGatePaths,
  keepDays: number,
  log?: Logger,
  nowMs: number = Date.now(),
): PruneArchiveOutcome {
  if (!Number.isFinite(keepDays) || keepDays <= 0) return { prunedStems: [], totalBefore: 0, keepDays };
  if (!existsSync(p.archiveDir)) return { prunedStems: [], totalBefore: 0, keepDays };

  const files = readdirSync(p.archiveDir).filter((f) => f.endsWith(".request.json"));
  const totalBefore = files.length;
  if (totalBefore === 0) return { prunedStems: [], totalBefore, keepDays };

  const protectedStems = new Set<string>();
  if (existsSync(p.requestsDir)) {
    for (const f of readdirSync(p.requestsDir)) {
      if (f.endsWith(".json")) protectedStems.add(f.replace(/\.json$/, ""));
    }
  }
  const active = readActiveLock(p);
  if (active) protectedStems.add(active.request_file.replace(/\.json$/, ""));

  const cutoffMs = nowMs - keepDays * 24 * 60 * 60 * 1000;
  const prunedStems: string[] = [];
  for (const f of files) {
    const stem = f.replace(/\.request\.json$/, "");
    if (protectedStems.has(stem)) continue;
    const full = join(p.archiveDir, f);
    let mtimeMs: number;
    try { mtimeMs = statSync(full).mtimeMs; } catch { continue; }
    if (mtimeMs > cutoffMs) continue;
    try { unlinkSync(full); } catch { continue; }
    prunedStems.push(stem);
  }
  if (prunedStems.length) {
    log?.info("merge_gate_archive_pruned", { count: prunedStems.length, keep_days: keepDays, total_before: totalBefore });
  }
  return { prunedStems, totalBefore, keepDays };
}

function defaultScriptPath(_isWindows: boolean): string {
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
  return join(skillCoreDir, "scripts", "merge-gate.sh");
}

// Exported for the detach regression test (merge_gate_detach.test.ts, W-087): the
// injected spawnFn in pollMergeGate bypasses this, so the real detach behavior is
// only covered by driving THIS function directly from a subprocess.
export function defaultSpawn(scriptPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): number {
  // W-087: the gate MUST fully detach from the caller. Two failure modes this
  // fixes, both observed on Windows/Git-Bash (3 live incidents 2026-07-06):
  //   1. `Bun.spawn` keeps THIS process (the `bun dock_merge.ts poll` that
  //      merge_request.sh runs in a `POLL_OUT="$(…)"` command substitution) alive
  //      until the child exits — so the submit BLOCKED for the whole gate (a
  //      multi-minute cargo build), hit its Bash-tool timeout, and the harness
  //      tree-killed everything including the spawned gate (silent cargo death,
  //      no result, orphan lock left for W-063 to sweep).
  //   2. `Bun.spawn` ALSO kills its spawned child when the bun process exits, so a
  //      bare unref() would make the submit return fast but SILENTLY KILL the gate
  //      before it ran (verified: the gate never wrote its first line).
  // node:child_process spawn with { detached: true } puts the gate in its OWN
  // process group (POSIX setsid / Windows DETACHED_PROCESS), so it is not killed
  // with the caller; stdio:"ignore" detaches its fds (the gate streams to its own
  // <stem>.log itself); .unref() lets this process exit immediately without
  // waiting on — or reaping — the gate. The gate then runs to completion and
  // records its result even if the submit is killed. Verified on Windows/Git-Bash.
  const child = nodeSpawn("bash", [scriptPath, ...args], {
    cwd,
    env,
    detached: true,
    stdio: "ignore",   // gate writes its own log file; no inherited console/pipe fd
    windowsHide: true, // Windows: no console window for the bash merge subprocess
  });
  child.unref();
  // node spawn reports a synchronous failure as an undefined pid (the ENOENT/EACCES
  // error arrives async on the 'error' event); surface it as a throw so the caller's
  // existing try/catch logs merge_gate_spawn_failed instead of writing a bogus lock.
  if (typeof child.pid !== "number") {
    throw new Error(`failed to spawn merge gate (bash ${scriptPath})`);
  }
  return child.pid;
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

// ---------------------------------------------------------------------------
// CLI entry (W-030 residual, extended by W-038): `bun merge_gate.ts prune
// --project <root> --pm-id <id> [--keep <n>] [--keep-days <n>]`.
// merge-gate.sh (bash) invokes this right after every write_result() so
// results/ COUNT pruning and archive/ AGE pruning both happen at write time
// regardless of which side wrote the result. `--keep` / `--keep-days` are
// optional — omitted, they read `[merge_gate] results_keep` (default 40) /
// `[merge_gate] archive_keep_days` (default 14) from setup_config.toml via
// readResultsKeepConfig() / readArchiveKeepDaysConfig(), so bash never has to
// parse TOML for this feature.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cliArg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv[0] === "prune") {
    const projectArg = cliArg("project");
    const pmIdArg = cliArg("pm-id");
    if (!projectArg || !pmIdArg) {
      console.error("usage: bun merge_gate.ts prune --project <root> --pm-id <id> [--keep <n>] [--keep-days <n>]");
      process.exit(2);
    }
    const resolvedProject = resolve(projectArg);
    const keepArg = cliArg("keep");
    const keep = keepArg ? Number(keepArg) : readResultsKeepConfig(resolvedProject, pmIdArg);
    const keepDaysArg = cliArg("keep-days");
    const keepDays = keepDaysArg ? Number(keepDaysArg) : readArchiveKeepDaysConfig(resolvedProject, pmIdArg);
    const keepLogsArg = cliArg("keep-logs");
    const keepLogs = keepLogsArg ? Number(keepLogsArg) : readLogsKeepConfig(resolvedProject, pmIdArg);
    const maxLogBytesArg = cliArg("max-log-bytes");
    const maxLogBytes = maxLogBytesArg ? Number(maxLogBytesArg) : readLogMaxBytesConfig(resolvedProject, pmIdArg);
    const paths = mergeGatePaths(resolvedProject, pmIdArg);
    const results = pruneMergeGateResults(paths, keep);
    const archive = pruneMergeGateArchive(paths, keepDays);
    const logs = pruneMergeGateLogs(paths, keepLogs);
    const logsCap = capMergeGateLogSizes(paths, maxLogBytes);
    console.log(JSON.stringify({ results, archive, logs, logsCap }));
  } else {
    console.error("usage: bun merge_gate.ts prune --project <root> --pm-id <id> [--keep <n>] [--keep-days <n>]");
    process.exit(2);
  }
}
