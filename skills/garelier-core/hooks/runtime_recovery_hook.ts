#!/usr/bin/env bun
// runtime_recovery_hook.ts — Claude Code runtime recovery hook (workshop W-035).
//
// This hook must never become the reason a Claude session stops. It accepts the
// official hook JSON on stdin, writes best-effort local runtime state under the
// current project cwd, and emits only supported hook response JSON.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

type Json = Record<string, unknown>;

const RUNTIME_DIR = ".claude/runtime/garelier";
const GARELIER_ROOT_SEARCH_DEPTH = 20;
const INCIDENTS_FILE = "incidents.jsonl";
const STATE_FILE = "state.json";
// W-063: snapshot of in-flight dispatch lanes captured just before compaction,
// re-read by the SessionStart(compact) handler as "what was live going in".
const COMPACT_SNAPSHOT_FILE = "compact_snapshot.json";
const POLICY =
  "Garelier runtime policy: long-running commands write a log file; final subagent output must end with GARELIER_RUNTIME_STATUS.";
const RECOVERY_PREFIX = "GARELIER_RUNTIME_INCIDENT";
const ESCALATION_PREFIX = "GARELIER_PM_ESCALATION";
// W-063: marker for the compaction/resume stall-sweep context injection.
const COMPACTION_PREFIX = "GARELIER_COMPACTION_SWEEP";
// STATE.md Status tokens that mean the dispatch is finished — everything else
// (WORKING / REPORTING / BLOCKED / ...) is treated as still in-flight, since a
// live dispatch container that the background subagent no longer drives is
// exactly the compaction stall we are hunting for.
const TERMINAL_STATES = new Set(["DONE", "MERGED", "CLEANED", "ARCHIVED", "COMPLETE", "COMPLETED", "CLOSED"]);
const MARKER_MISSING_KIND = "missing_marker";
const MARKER_MISSING_REASON =
  'GARELIER_RUNTIME_STATUS marker missing: end the final message with the last line ' +
  'GARELIER_RUNTIME_STATUS: {"runtime_ok": true|false, ...} and complete the register before finishing.';

interface OpenIncident {
  incident_id: string;
  kind: string;
  agent_id: string;
  attempts: number;
}

interface State {
  open_by_agent_id: Record<string, OpenIncident>;
}

interface Incident extends Json {
  incident_id: string;
  kind: string;
  agent_id: string;
}

function main(): void {
  try {
    const raw = readStdin();
    if (!raw.trim()) return;
    let event: Json;
    try {
      event = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    const name = eventName(event);
    if (name === "SubagentStart") return emitContext("SubagentStart", POLICY);
    if (name === "PostToolUseFailure") return handleFailure(event);
    if (name === "PostToolUse") return handlePostToolUse(event);
    if (name === "SubagentStop") return handleSubagentStop(event);
    if (name === "SessionStart") return handleSessionStart(event);
    if (name === "PreCompact") return handlePreCompact(event);
  } catch {
    // Fail shut for the hook itself: no output, exit 0.
  }
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function eventName(event: Json): string {
  return str(event.hook_event_name) || str(event.event_name) || str(event.event) || "";
}

function isShellTool(event: Json): boolean {
  const tool = str(event.tool_name);
  return tool === "Bash" || tool === "PowerShell";
}

function handleFailure(event: Json): void {
  if (!isShellTool(event)) return;
  const cwd = baseCwd(event);
  const incident = buildIncident(event, isTimeout(str(event.error_message)) ? "bash_command_timeout" : "bash_command_failed");
  appendIncident(cwd, incident);
  if (incident.agent_id) {
    const state = readState(cwd);
    state.open_by_agent_id[incident.agent_id] = {
      incident_id: incident.incident_id,
      kind: incident.kind,
      agent_id: incident.agent_id,
      attempts: 0,
    };
    writeState(cwd, state);
  }
  emitContext(
    "PostToolUseFailure",
    `${RECOVERY_PREFIX}: ${incident.incident_id}. Review ${join(runtimeDir(cwd), INCIDENTS_FILE)}, recover before continuing, and finish with GARELIER_RUNTIME_STATUS.`,
  );
}

function handlePostToolUse(event: Json): void {
  if (!isShellTool(event)) return;
  const text = collectText(event.tool_response);
  if (!isSpill(text)) return;
  const cwd = baseCwd(event);
  const incident = buildIncident(event, "bash_output_spilled");
  appendIncident(cwd, incident);
  emitContext(
    "PostToolUse",
    `${RECOVERY_PREFIX}: ${incident.incident_id}. Bash output was truncated or saved aside; this is not a command failure, but inspect the log/output before relying on the result.`,
  );
}

function handleSubagentStop(event: Json): void {
  const agentId = str(event.agent_id);
  if (!agentId) return;
  const cwd = baseCwd(event);
  const state = readState(cwd);
  const open = state.open_by_agent_id[agentId];
  const last = str(event.last_assistant_message);

  if (open) {
    if (runtimeOk(last)) {
      delete state.open_by_agent_id[agentId];
      writeState(cwd, state);
      return;
    }
    const reason =
      `${RECOVERY_PREFIX}: ${open.incident_id}. Recover the runtime incident, inspect incidents.jsonl, ` +
      `then end with GARELIER_RUNTIME_STATUS: {"runtime_ok": true, "incident_id": "${open.incident_id}"}`;
    const escalation =
      `${ESCALATION_PREFIX}: runtime incident ${open.incident_id} still open after 2 recovery blocks; PM must classify rerun safety before further action.`;
    stepAttemptsAndRespond(cwd, state, agentId, open, reason, escalation);
    return;
  }

  // W-038: even with no open incident, a subagent must register with the
  // GARELIER_RUNTIME_STATUS marker before it stops (clean-stall guard).
  if (hasStatusMarker(last)) return;
  const markerEntry: OpenIncident = { incident_id: `gri-marker-${agentId}`, kind: MARKER_MISSING_KIND, agent_id: agentId, attempts: 0 };
  const escalation =
    `${ESCALATION_PREFIX}: subagent ${agentId} stopped without a GARELIER_RUNTIME_STATUS marker after 2 blocks; PM must classify rerun safety before further action.`;
  stepAttemptsAndRespond(cwd, state, agentId, markerEntry, MARKER_MISSING_REASON, escalation);
}

// ── W-063: compaction / resume stall sweep ────────────────────────────────────
// Claude Code's official spec stops background subagents when the parent session
// compacts (or resumes). A dispatch container's STATE.md stays WORKING, so
// "manifest in-flight, agent dead" drift is structural and, until now, only caught
// by the PM's own status sweep (実戦 2026-07-13 target-project dispatch: 4.5h stall). These two
// handlers turn that self-judgement into a machine trigger: PreCompact snapshots
// the in-flight lanes, SessionStart(compact|resume) re-lists them and tells the
// resumed session to verify liveness and restart any stalled producer.

interface DispatchLane {
  pmId: string;
  dispatch: string; // container dir name, e.g. "_dispatch7"
  task: string; // "## Current task" line (carries the branch)
  state: string; // "## Status" token (WORKING / REPORTING / ...)
  stateMtime: string; // STATE.md mtime, ISO — a proxy for last activity
}

interface CompactSnapshot {
  timestamp: string;
  trigger?: string; // PreCompact matcher: manual | auto
  lanes: Array<{ id: string; task: string; state: string; state_mtime: string }>;
}

// SessionStart fires for startup/resume/clear/compact; we only sweep on
// compact|resume (the two that kill background subagents). The installer matcher
// already narrows this, but re-check the source field as a second defence so a
// startup/clear session never gets the injection noise.
function handleSessionStart(event: Json): void {
  const source = str(event.source);
  if (source !== "compact" && source !== "resume") return;
  const cwd = baseCwd(event);
  const root = findGarelierRoot(cwd);
  if (!root) return;
  const lanes = scanInFlightLanes(root);
  if (lanes.length === 0) return; // in-flight 0 -> zero noise
  emitContext("SessionStart", buildCompactionSweepContext(root, cwd, lanes, source));
}

// PreCompact cannot inject context or return decision fields (official spec) —
// it only snapshots the in-flight lanes for the post-compaction handler and
// never blocks. Fully fail-shut: any error leaves compaction untouched.
function handlePreCompact(event: Json): void {
  try {
    const cwd = baseCwd(event);
    const root = findGarelierRoot(cwd);
    if (!root) return;
    const lanes = scanInFlightLanes(root);
    const snapshot: CompactSnapshot = {
      timestamp: new Date().toISOString(),
      trigger: str(event.trigger) || undefined,
      lanes: lanes.map((l) => ({
        id: `${l.pmId}/${l.dispatch}`,
        task: l.task,
        state: l.state,
        state_mtime: l.stateMtime,
      })),
    };
    writeCompactSnapshot(cwd, snapshot);
  } catch {
    // best effort only — PreCompact never blocks compaction.
  }
}

// scanInFlightLanes: read every __garelier/<pm_id>/_dispatch*/STATE.md under the
// resolved Garelier root and collect the lanes whose Status is not terminal. The
// SessionStart cwd is the project root (or a _pm subdir), so we scan across all
// PMs rather than a single pm_id.
function scanInFlightLanes(root: string): DispatchLane[] {
  const lanes: DispatchLane[] = [];
  const garelier = join(root, "__garelier");
  let pmDirs: string[];
  try {
    pmDirs = readdirSync(garelier);
  } catch {
    return lanes;
  }
  for (const pmId of pmDirs) {
    if (pmId.startsWith(".")) continue;
    const pmPath = join(garelier, pmId);
    let entries: string[];
    try {
      entries = readdirSync(pmPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("_dispatch")) continue;
      const stateFile = join(pmPath, entry, "STATE.md");
      let content: string;
      let mtime: string;
      try {
        content = readFileSync(stateFile, "utf8");
        mtime = statSync(stateFile).mtime.toISOString();
      } catch {
        continue; // no STATE.md / unreadable — skip, never fail the sweep
      }
      const state = parseStateSection(content, "Status");
      if (!isInFlightState(state)) continue;
      lanes.push({ pmId, dispatch: entry, task: parseStateSection(content, "Current task"), state, stateMtime: mtime });
    }
  }
  lanes.sort((a, b) => (`${a.pmId}/${a.dispatch}` < `${b.pmId}/${b.dispatch}` ? -1 : 1));
  return lanes;
}

function isInFlightState(state: string): boolean {
  const s = state.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!s) return false;
  return !TERMINAL_STATES.has(s);
}

// parseStateSection: first non-empty line after a `## <heading>` line, trimmed.
// Mirrors dispatch_prepare.sh's awk reads of the same STATE.md sections.
function parseStateSection(content: string, heading: string): string {
  const headRe = new RegExp(`^##\\s*${heading}\\s*$`, "i");
  let inSection = false;
  for (const line of content.split(/\r?\n/)) {
    if (!inSection) {
      if (headRe.test(line)) inSection = true;
      continue;
    }
    if (line.startsWith("##")) break; // ran into the next section
    if (line.trim()) return line.trim();
  }
  return "";
}

function buildCompactionSweepContext(root: string, cwd: string, lanes: DispatchLane[], source: string): string {
  const snap = readCompactSnapshot(cwd);
  const preCompact = new Map<string, CompactSnapshot["lanes"][number]>();
  for (const l of snap?.lanes ?? []) preCompact.set(l.id, l);

  const header =
    `${COMPACTION_PREFIX}: this session resumed via ${source} — per Claude Code's official spec, background subagents are ` +
    `STOPPED on compaction/resume. The dispatch lanes below still read a non-terminal STATE.md, so their agent process is ` +
    `likely dead while the manifest shows them in-flight. For EACH lane, verify real activity (worktree changes / running ` +
    `process) and RESTART the producer for any that has stalled:`;
  const rows = lanes.map((l) => {
    const before = preCompact.get(`${l.pmId}/${l.dispatch}`);
    const beforeNote = before ? ` (pre-compaction: ${before.state} @ ${before.state_mtime})` : "";
    return `  - ${l.pmId}/${l.dispatch} [${l.state}] ${l.task || "(no task line)"} — last STATE activity ${l.stateMtime}${beforeNote}`;
  });
  const fleetNote = buildFleetWatchNote(root, lanes);
  return [header, ...rows, fleetNote].filter(Boolean).join("\n");
}

// buildFleetWatchNote: best-effort — if a PM with in-flight lanes has no standing
// fleet_watch (its runtime/driver/fleet_watch.lock is absent), say so in one line
// so the resumed session can restart the stall net. No pid-liveness probing.
function buildFleetWatchNote(root: string, lanes: DispatchLane[]): string {
  const missing: string[] = [];
  for (const pm of [...new Set(lanes.map((l) => l.pmId))].sort()) {
    const lock = join(root, "__garelier", pm, "runtime", "driver", "fleet_watch.lock");
    try {
      if (!existsSync(lock)) missing.push(pm);
    } catch {
      // best effort
    }
  }
  if (missing.length === 0) return "";
  return `  fleet_watch stall net is NOT running for: ${missing.join(", ")} — start it (fleet_watch.sh --project <root> --pm-id <id>).`;
}

function writeCompactSnapshot(cwd: string, snap: CompactSnapshot): void {
  try {
    const dir = runtimeDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, COMPACT_SNAPSHOT_FILE), JSON.stringify(snap, null, 2) + "\n", "utf8");
  } catch {
    // best effort only
  }
}

function readCompactSnapshot(cwd: string): CompactSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeDir(cwd), COMPACT_SNAPSHOT_FILE), "utf8")) as CompactSnapshot;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.lanes)) return parsed;
  } catch {
    // missing/broken snapshot -> the sweep falls back to STATE.md scan only.
  }
  return null;
}

function stepAttemptsAndRespond(
  cwd: string,
  state: State,
  agentId: string,
  entry: OpenIncident,
  blockReason: string,
  escalationText: string,
): void {
  entry.attempts = (entry.attempts || 0) + 1;
  state.open_by_agent_id[agentId] = entry;
  writeState(cwd, state);
  if (entry.attempts <= 2) {
    emitBlock(blockReason);
  } else {
    emitContext("SubagentStop", escalationText);
  }
}

function buildIncident(event: Json, kind: string): Incident {
  const now = new Date().toISOString();
  return {
    incident_id: `gri-${now.replace(/[^0-9TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    status: "open",
    created_at: now,
    session_id: str(event.session_id),
    cwd: str(event.cwd),
    agent_id: str(event.agent_id),
    agent_type: str(event.agent_type),
    tool_name: str(event.tool_name),
    tool_input: event.tool_input ?? null,
    exit_code: numberOrNull(event.exit_code),
    error_message: str(event.error_message),
  };
}

function baseCwd(event: Json): string {
  return normalizeCwd(str(event.cwd) || ".");
}

function normalizeCwd(cwd: string): string {
  if (/^\/[a-zA-Z]\//.test(cwd)) return `${cwd[1].toUpperCase()}:/${cwd.slice(3)}`;
  return cwd;
}

// findGarelierRoot (workshop W-047): walk cwd's ancestors (bounded) looking for
// a directory that has a `__garelier` child. Returns that ancestor, or null when
// none is found within the bound (a plain repo with no Garelier coordination).
function findGarelierRoot(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < GARELIER_ROOT_SEARCH_DEPTH; i++) {
    try {
      if (existsSync(join(dir, "__garelier"))) return dir;
    } catch {
      // best effort
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// gitToplevel (W-091): resolve the git worktree root for cwd, memoized per cwd.
// Used to anchor the legacy .claude/runtime/garelier fallback at the repo root
// instead of cwd-relative — so a hook firing in ANY repo subdir (a source dir, a
// worktree checkout) writes ONE root-level tree the wizard gitignores, rather
// than scattering strays under whatever subdir the producer happens to sit in
// (W-091 class a). In a LINKED git worktree this correctly returns that
// worktree's own root, not the main repo, so each worktree keeps its own
// .claude/. Returns null when git is unavailable or cwd is not inside a repo
// (e.g. the hermetic hook tests), where the caller falls back to cwd.
const gitTopCache = new Map<string, string | null>();
function gitToplevel(cwd: string): string | null {
  const cached = gitTopCache.get(cwd);
  if (cached !== undefined) return cached;
  let top: string | null = null;
  try {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (r.status === 0) {
      const out = (r.stdout ?? "").toString().trim();
      if (out) top = out;
    }
  } catch {
    // git missing / not a repo — leave null; the caller falls back to cwd.
  }
  gitTopCache.set(cwd, top);
  return top;
}

// runtimeDir (workshop W-047): a hook-writing cwd nested under
// `__garelier/<pm_id>/...` (a dispatched role's worktree, `_pm`, `_dock`, ...)
// already has a gitignored `__garelier/<pm_id>/runtime/` tree (DEC-051, DEC-006).
// Redirect writes there (`runtime/hooks/`) instead of dropping an UNTRACKED
// `.claude/runtime/garelier/` at that cwd — the recurring untracked-noise report
// (target project 実戦 2026-07-11, workshop W-047). Falls back to the legacy cwd-relative
// path (still covered by the wizard's project-root `.claude/.gitignore` —
// garelier_write_claude_runtime_ignore) when cwd is the project root itself or no
// `__garelier` ancestor is found at all.
function runtimeDir(cwd: string): string {
  const root = findGarelierRoot(cwd);
  if (root) {
    const norm = cwd.replace(/\\/g, "/");
    const prefix = `${root.replace(/\\/g, "/")}/__garelier/`;
    if (norm.startsWith(prefix)) {
      const pmId = norm.slice(prefix.length).split("/")[0];
      if (pmId) return join(root, "__garelier", pmId, "runtime", "hooks");
    }
  }
  // cwd is not under a pm subtree (a source subdir, a worktree checkout, or the
  // project root itself). Anchor the legacy .claude/runtime/garelier at the
  // resolved project root — the git worktree root first, else the
  // __garelier-bearing ancestor, else cwd — so no cwd-relative stray lands under
  // a subdir (W-091 class a). The root-level .claude/runtime/ is covered by the
  // wizard's project-root .claude/.gitignore (`runtime/`).
  return join(gitToplevel(cwd) ?? root ?? cwd, RUNTIME_DIR);
}

function appendIncident(cwd: string, incident: Json): void {
  try {
    const dir = runtimeDir(cwd);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, INCIDENTS_FILE), JSON.stringify(incident) + "\n", "utf8");
  } catch {
    // best effort only
  }
}

function readState(cwd: string): State {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeDir(cwd), STATE_FILE), "utf8")) as Partial<State>;
    if (parsed && typeof parsed === "object" && parsed.open_by_agent_id && typeof parsed.open_by_agent_id === "object") {
      return { open_by_agent_id: parsed.open_by_agent_id as Record<string, OpenIncident> };
    }
  } catch {
    // broken/missing state is reset; the hook must not fail the session.
  }
  return { open_by_agent_id: {} };
}

function writeState(cwd: string, state: State): void {
  try {
    const dir = runtimeDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // best effort only
  }
}

function emitContext(hookEventName: string, additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext,
      },
    }) + "\n",
  );
}

function emitBlock(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

function isTimeout(message: string): boolean {
  return /\b(timed out|timeout|time[- ]?out|exceeded|deadline|time limit)\b/i.test(message);
}

function isSpill(text: string): boolean {
  return /(output (was )?(truncated|too large|exceeded)|saved (to|as).*(log|file)|maximum output|showing (first|last)|remaining output|omitted)/i.test(
    text,
  );
}

function runtimeOk(text: string): boolean {
  const marker = text.match(/GARELIER_RUNTIME_STATUS:\s*(\{[^\n\r]*\})/);
  if (!marker) return false;
  try {
    const parsed = JSON.parse(marker[1]) as { runtime_ok?: unknown };
    return parsed.runtime_ok === true;
  } catch {
    return false;
  }
}

// W-038: presence-only check (register completed) — unlike runtimeOk(), this
// does not require runtime_ok === true, since the marker may legitimately
// report runtime_ok: false and still count as "finished cleanly with status".
function hasStatusMarker(text: string): boolean {
  return /GARELIER_RUNTIME_STATUS:\s*\{[^\n\r]*\}/.test(text);
}

function collectText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(collectText).join("\n");
  if (typeof value === "object") {
    const out: string[] = [];
    for (const v of Object.values(value as Record<string, unknown>)) out.push(collectText(v));
    return out.join("\n");
  }
  return "";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

if (import.meta.main) main();
