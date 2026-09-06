// STATE.md parser and SEMANTIC change detection.
//
// The pre-check is the single biggest cost saver: if NO signal the role
// depends on changed since the last iteration, we skip the model call
// entirely. The signal is semantic, not raw mtime — a role re-stamping its
// STATE.md heartbeat every working iteration must NOT wake a coordinator that
// has nothing new to do (the #1 observed cost driver). Snapshots can be
// persisted by the driver so idle projects keep costing 0 tokens after restart.

import { existsSync, statSync, readFileSync, writeFileSync } from "node:fs";

export type AgentStatus =
  | "IDLE"
  | "ASSIGNED"
  | "WORKING"
  | "REPORTING"
  | "REVIEWING"
  | "REWORK"
  | "MERGED"
  | "BLOCKED"
  | "ABORTED"
  // Observer-only states (DEC-019). Observer is commit-free; it reviews
  // (OBSERVING) and, once the requester ACKs its report, archives (ACKED).
  | "OBSERVING"
  | "ACKED"
  // Guardian-only state (DEC-024). Guardian is commit-free; it runs scanners
  // and applies policy (CHECKING), then reports a verdict.
  | "CHECKING"
  | "NO_STATE";

export interface AgentState {
  status: AgentStatus;
  rawStatus: string;
  lastActivity?: string;
  // The role's own one-line description of WHAT it is working on (STATE.md
  // "## Current task" — e.g. "#25 — server_room reliable-resend flake repro").
  // Surfaced in the Status Web so an operator sees which work each role drives,
  // not just its state. Display-only; never a wake/gating signal.
  currentTask?: string;
}

/**
 * Parse an agent's STATE.md. The wizard's template has:
 *   ## Status
 *   IDLE
 * ...with the status on the next non-empty line.
 */
export function readAgentState(stateFile: string): AgentState {
  if (!existsSync(stateFile)) {
    return { status: "NO_STATE", rawStatus: "" };
  }
  const text = readFileSync(stateFile, "utf8");
  const status = extractSection(text, "Status");
  const lastActivity = extractSection(text, "Last activity");
  const currentTask = extractSection(text, "Current task");
  const normalized = normalizeStatus(status);
  return {
    status: normalized,
    rawStatus: status,
    lastActivity,
    currentTask: currentTask || undefined,
  };
}

// Known Garelier role kinds (the first heading word of a STATE.md names one).
const KNOWN_ROLE_KINDS = new Set([
  "pm", "dock", "worker", "scout", "smith", "librarian", "observer", "guardian", "concierge", "artisan",
]);

/**
 * Self-heal cross-role STATE.md residue. A role container that was reused — or
 * mis-seeded by an earlier copy — can hold a STATE.md whose FIRST heading names a
 * DIFFERENT role (e.g. "# Worker worker-01 — State" sitting in a `_crew/scouts/<id>/`
 * dir). `readAgentState` would then parse that OTHER role's status (e.g.
 * REPORTING) as THIS role's status, which misleads both the status console (shown
 * as "stale") AND the driver's own `*ShouldRun` dispatch logic. When the header
 * names a *known* role that disagrees with the container's role, rewrite the file
 * to a fresh IDLE STATE for the correct role and return the residual kind that was
 * cleared; otherwise return null (no change). Conservative: only a clearly
 * different KNOWN role triggers a rewrite, and callers run this only when no live
 * lease holds the role, so a running agent's own STATE is never clobbered.
 */
export function healRoleStateResidue(stateFile: string, role: string, id: string): string | null {
  if (!existsSync(stateFile)) return null;
  let head = "";
  try { head = readFileSync(stateFile, "utf8").slice(0, 200); } catch { return null; }
  const m = /^#\s+([A-Za-z]+)\b/m.exec(head);
  const headerKind = m ? m[1].toLowerCase() : null;
  const want = role.toLowerCase();
  if (!headerKind || headerKind === want || !KNOWN_ROLE_KINDS.has(headerKind)) return null;
  const Role = role.charAt(0).toUpperCase() + role.slice(1);
  const ts = new Date().toISOString();
  const fresh =
    `# ${Role}${id ? " " + id : ""} — State\n\n` +
    `## Status\n\nIDLE\n\n` +
    `## Current branch\n\n(none)\n\n` +
    `## Current task\n\n(none)\n\n` +
    `## Last activity\n\n${ts} -- container reconciled: cross-role STATE residue (was "${headerKind}") cleared by driver self-heal\n`;
  try { writeFileSync(stateFile, fresh); return headerKind; } catch { return null; }
}

function extractSection(text: string, section: string): string {
  const lines = text.split("\n");
  let capture = false;
  for (const line of lines) {
    if (line.trimEnd() === `## ${section}`) {
      capture = true;
      continue;
    }
    if (capture) {
      if (line.startsWith("## ")) return "";
      const t = line.trim();
      if (t) return t;
    }
  }
  return "";
}

function normalizeStatus(s: string): AgentStatus {
  const u = s.trim().toUpperCase();
  if (
    u === "IDLE" || u === "ASSIGNED" || u === "WORKING" ||
    u === "REPORTING" || u === "REVIEWING" || u === "REWORK" ||
    u === "MERGED" || u === "BLOCKED" || u === "ABORTED" ||
    u === "OBSERVING" || u === "ACKED" || u === "CHECKING"
  ) return u;
  return "NO_STATE";
}

// A wake SIGNAL: the thing a role's dispatch is gated on. A bare string is the
// legacy "watch this path by mtime" form (a write IS the event — assignment.md /
// inbox drops / a new merge-gate result). An object carries an EXPLICIT semantic
// value so cosmetic churn (heartbeat re-stamps, "Last activity" bumps, log
// appends) does NOT register as an actionable change. Coordinators (PM /
// Dock) watch roles via the semantic form (statusSignal / contentSignal)
// so they wake only on a real state transition or handoff — not on the
// working-heartbeat the role writes every iteration. This is the root cost
// lever: wake on PROGRESS, not on wall-clock churn.
export type Signal = string | { id: string; value: string };

function resolveSignal(sig: Signal): [string, string] {
  if (typeof sig === "string") return [sig, String(mtimeOf(sig))];
  return [sig.id, sig.value];
}

/**
 * Track per-signal VALUES across iterations. A role's iteration is skipped if
 * none of the signals it depends on changed since last run. The stored value is
 * a string: mtime for a bare path, or a semantic digest (status / content) for
 * an explicit Signal. See `Signal`.
 */
export class ChangeTracker {
  // role-or-agent key -> signal id -> value (mtime string, or semantic digest)
  private snapshots = new Map<string, Map<string, string>>();
  private snapshotFile?: string;

  constructor(snapshotFile?: string) {
    this.snapshotFile = snapshotFile;
    this.load();
  }

  /**
   * Returns true if any path in `paths` has a different mtime than the last
   * snapshot for `key`. Also updates the snapshot. First call returns true
   * only when no persisted snapshot exists for this key.
   */
  hasChanged(key: string, signals: Signal[]): boolean {
    const prev = this.snapshots.get(key);
    const next = new Map<string, string>();
    for (const sig of signals) {
      const [id, value] = resolveSignal(sig);
      next.set(id, value);
    }
    this.snapshots.set(key, next);
    this.persist();
    if (!prev) return true;
    if (prev.size !== next.size) return true;
    for (const [p, v] of next) {
      if (prev.get(p) !== v) return true;
    }
    return false;
  }

  /**
   * NON-MUTATING probe: same comparison as hasChanged() but does NOT update or
   * persist the snapshot. Used by the concurrency scheduler (DEC-027) to decide
   * whether an agent is eligible WITHOUT consuming the change — so an agent that
   * is eligible but deferred (no slot) is re-offered verbatim next cycle instead
   * of being stranded. The snapshot is only committed (via hasChanged) at the
   * moment the agent actually launches. First probe (no snapshot) returns true.
   */
  peekChanged(key: string, signals: Signal[]): boolean {
    const prev = this.snapshots.get(key);
    if (!prev) return true;
    const next = new Map<string, string>();
    for (const sig of signals) {
      const [id, value] = resolveSignal(sig);
      next.set(id, value);
    }
    if (prev.size !== next.size) return true;
    for (const [p, v] of next) {
      if (prev.get(p) !== v) return true;
    }
    return false;
  }

  /**
   * Force the next hasChanged() for this key to return true (e.g., after
   * an aborted iteration we want to retry).
   */
  invalidate(key: string): void {
    this.snapshots.delete(key);
    this.persist();
  }

  private load(): void {
    if (!this.snapshotFile || !existsSync(this.snapshotFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.snapshotFile, "utf8")) as {
        snapshots?: Record<string, Record<string, string>>;
      };
      if (!raw.snapshots) return;
      for (const [key, paths] of Object.entries(raw.snapshots)) {
        this.snapshots.set(key, new Map(Object.entries(paths)));
      }
    } catch {
      this.snapshots.clear();
    }
  }

  private persist(): void {
    if (!this.snapshotFile) return;
    const out: Record<string, Record<string, string>> = {};
    for (const [key, paths] of this.snapshots) {
      out[key] = Object.fromEntries(paths);
    }
    writeFileSync(
      this.snapshotFile,
      JSON.stringify({ version: 1, saved_at: new Date().toISOString(), snapshots: out }, null, 2),
      "utf8",
    );
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

// FNV-1a 32-bit, base-36. Deterministic (no Date/Math.random) so the same
// content always yields the same signal value across polls/persistence.
function hashStr(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Coordinator wake signal for a role's STATE.md: the normalized STATUS only.
// Roles re-stamp "## Last activity" / "## Recent log" every working
// iteration; watching the whole file by mtime made a coordinator (Dock/PM)
// wake (~$1+/iteration, 1M+ cache_read) on that pure heartbeat. Keying on the
// status line means the coordinator wakes only on a real transition
// (-> REPORTING / BLOCKED / ABORTED / REVIEWING / ...). Pair with an mtime watch
// of the role's report artifact (Dock's own watch composition) so a
// handoff that lands the file a beat before the status flip still wakes it.
export function statusSignal(stateFile: string): Signal {
  let status = "NO_STATE";
  try {
    status = normalizeStatus(extractSection(readFileSync(stateFile, "utf8"), "Status"));
  } catch { /* missing/unreadable -> NO_STATE, independent of mtime */ }
  return { id: stateFile, value: `status:${status}` };
}

// A line whose SOLE purpose is a "last updated / last activity" timestamp stamp.
// ANCHORED to a leading label (after optional list/quote/heading/emphasis marks)
// so it matches ONLY a dedicated stamp line — never a substantive line that
// merely CONTAINS a date (a milestone target date, a dated decision/log entry, a
// user note). Over-matching here would drop real content and silently stall PM.
const PURE_STAMP_LINE =
  /^\s*(?:[-*>#]\s*)*(?:[_*]+\s*)?(?:last\s*(?:updated|activity)|updated\s*(?:at|on)?|最終更新|更新日時)\b/i;

// PM wake signal for dashboard files (roadmap.md / current.md). PM has NO
// heartbeat floor — a dropped signal is a PERMANENT stall — so this must wake on
// EVERY substantive content change (including a user-edited roadmap, and edits to
// lines that happen to carry a date). We suppress ONLY dedicated "last updated"
// stamp lines, which are the actual churn; everything else (text OR an embedded
// date moving) flips the hash and wakes PM. Erring toward waking is just cost; a
// missed wake is a stall.
export function contentSignal(path: string): Signal {
  let body: string;
  try { body = readFileSync(path, "utf8"); }
  catch { return { id: path, value: "absent" }; }
  const stable = body.split(/\r?\n/).filter((l) => !PURE_STAMP_LINE.test(l)).join("\n");
  return { id: path, value: `content:${hashStr(stable)}` };
}
