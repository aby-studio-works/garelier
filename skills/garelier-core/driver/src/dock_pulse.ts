// Dock runtime-state digest (DEC-081 Piece 3) — the "dock pulse".
//
// Dock's iteration start otherwise fans out to read EVERY active role's STATE.md
// (plus the inbox, resolutions, queue, and merge-gate state) raw. This scans that
// runtime state once and emits a compact `dock_pulse.json`: a role-state vector +
// inbox/resolution counts + queue head + merge-gate lock + derived signals. Dock
// reads the digest, then opens ONLY what needs attention (the REPORTING /
// BLOCKED containers' reports, the oldest inbox items), instead of reading every
// STATE.md up front.
//
// Advisory and additive (DEC-081): no decisions, no verdict; Dock may ignore the
// pulse and read the raw runtime files. No code content. Fail-open: an unreadable
// path is omitted, never a crash. Partly overlaps manifest.md by design — this is
// the machine-readable, always-fresh slice Dock acts on first.
//
// CLI:
//   bun dock_pulse.ts --project <root> --pm-id <id> [--inbox-limit N] [--queue-limit N] [--out <path>]
//   Writes the pulse JSON to --out (default stdout). Exit 0 always on a produced
//   pulse, 2 on usage error.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readWorkspacePointer } from "./workspace.ts";

// Compact claims lifted from a role's report.json so Dock can TRIAGE (order,
// route to Guardian on a risk flag, spot a failing gate) without opening every
// report.md — and skip opening report.json itself, since it is inlined here.
export interface RoleClaims {
  status: string | null;
  verdict: string | null;
  tests: unknown;
  risk_flags: unknown;
  summary: string | null;
  files_changed_count: number | null;
}
export interface RoleState {
  container: string; // e.g. "_dispatch1", "_workers/w2"
  role: string;
  status: string; // IDLE / WORKING / REPORTING / BLOCKED / ...
  task: string | null;
  claims: RoleClaims | null; // from <container>/report.json when present
}
export interface InboxMsg {
  file: string;
  summary: string | null;
}
export interface PulseInput {
  roles: RoleState[];
  inbox: InboxMsg[];
  resolutionsCount: number;
  queuePendingCount: number;
  queueNext: { id: string; text: string }[];
  mergeGate: { active_lock: boolean; lock_slug: string | null; requests: number };
}
export interface DockPulse {
  schema_version: 1;
  generated_by: "dock_pulse.ts";
  kind: "dock_pulse";
  advisory: true;
  roles: RoleState[];
  inbox: { count: number; oldest: InboxMsg[] };
  resolutions: { count: number };
  queue: { pending_count: number; next: { id: string; text: string }[] };
  merge_gate: { active_lock: boolean; lock_slug: string | null; requests: number };
  signals: {
    active_roles: number;
    idle_roles: number;
    has_reporting: boolean;
    has_blocked: boolean;
    reporting_roles: string[];
    blocked_roles: string[];
    risk_flagged_roles: string[]; // claims.risk_flags has a true value → route to Guardian
    inbox_nonempty: boolean;
    merge_in_flight: boolean;
  };
  note: string;
}

const ROLE_KEYWORDS = [
  "worker", "smith", "scout", "librarian", "observer", "guardian", "concierge", "artisan", "dispatch", "dock", "pm",
];

// Parse a STATE.md: status is the first non-empty line under `## Status`; role is
// the first role keyword in the H1 title; task is the first line under
// `## Current task` (if present).
export function parseStateMd(md: string, fallbackRole: string): { role: string; status: string; task: string | null } {
  const lines = md.split("\n");
  const sectionFirstLine = (heading: RegExp): string | null => {
    let inSec = false;
    for (const ln of lines) {
      if (heading.test(ln)) { inSec = true; continue; }
      if (inSec && /^#{1,6}\s/.test(ln)) break;
      if (inSec && ln.trim()) return ln.trim();
    }
    return null;
  };
  const status = (sectionFirstLine(/^##\s+Status\s*$/i) ?? "UNKNOWN").split(/\s+/)[0].toUpperCase();
  const task = sectionFirstLine(/^##\s+Current task\s*$/i);
  const titleLine = lines.find((l) => /^#\s/.test(l)) ?? "";
  // dispatch_prepare format "# Dispatch #N - <role> <slug>": the role is the
  // token right after " - " (a slug may itself contain a role word, so do NOT
  // keyword-scan a dispatch title); otherwise match a role keyword in the title.
  const dm = /dispatch\s+#\d+\s*-\s*([a-z]+)/i.exec(titleLine);
  const role = dm
    ? dm[1].toLowerCase()
    : (ROLE_KEYWORDS.find((k) => titleLine.toLowerCase().includes(k)) ?? fallbackRole);
  return { role, status, task };
}

// Compact a role's report.json into triage claims. Returns null on absent /
// unparseable input (Dock then opens the report itself).
export function parseClaims(text: string | null): RoleClaims | null {
  if (text == null) return null;
  try {
    const r = JSON.parse(text) as Record<string, unknown>;
    return {
      status: typeof r.status === "string" ? r.status : null,
      verdict: typeof r.verdict === "string" ? r.verdict : null,
      tests: r.tests ?? null,
      risk_flags: r.risk_flags ?? null,
      summary: typeof r.summary === "string" ? r.summary : null,
      files_changed_count: Array.isArray(r.files_changed) ? r.files_changed.length : null,
    };
  } catch {
    return null;
  }
}

function hasRisk(claims: RoleClaims | null): boolean {
  const rf = claims?.risk_flags;
  return !!rf && typeof rf === "object" && Object.values(rf as Record<string, unknown>).some((v) => v === true);
}

// Pure. Same inputs → same pulse.
export function buildDockPulse(inp: PulseInput): DockPulse {
  const active = inp.roles.filter((r) => r.status !== "IDLE" && r.status !== "UNKNOWN");
  const reporting = inp.roles.filter((r) => r.status === "REPORTING");
  const blocked = inp.roles.filter((r) => r.status.startsWith("BLOCK"));
  return {
    schema_version: 1,
    generated_by: "dock_pulse.ts",
    kind: "dock_pulse",
    advisory: true,
    roles: inp.roles,
    inbox: { count: inp.inbox.length, oldest: inp.inbox },
    resolutions: { count: inp.resolutionsCount },
    queue: { pending_count: inp.queuePendingCount, next: inp.queueNext },
    merge_gate: inp.mergeGate,
    signals: {
      active_roles: active.length,
      idle_roles: inp.roles.length - active.length,
      has_reporting: reporting.length > 0,
      has_blocked: blocked.length > 0,
      reporting_roles: reporting.map((r) => r.container),
      blocked_roles: blocked.map((r) => r.container),
      risk_flagged_roles: inp.roles.filter((r) => hasRisk(r.claims)).map((r) => r.container),
      inbox_nonempty: inp.inbox.length > 0,
      merge_in_flight: inp.mergeGate.active_lock,
    },
    note: "runtime digest, advisory (DEC-081); open the named STATE.md / report.md / inbox files for detail. You may ignore it and read the raw runtime state.",
  };
}

// ---- filesystem gathering (best-effort, fail-open) --------------------------

function safeRead(p: string): string | null {
  try { return existsSync(p) ? readFileSync(p, "utf8") : null; } catch { return null; }
}
function listDir(p: string): string[] {
  try { return existsSync(p) ? readdirSync(p) : []; } catch { return []; }
}

// Scan a pm's containers for STATE.md. _dispatch<N>/ and _artisan/ hold STATE.md
// directly; _workers/_smiths/_scouts/_librarians/_observers/_guardians/_concierges
// hold one per <id> subdir. Exiled containers (DEC-036) live OUTSIDE the project
// and are enumerated from the runtime/workspace_paths pointer — dedup by absolute
// dir so a pulse never silently omits an exiled role.
export function gatherRoles(pmRoot: string, projectRoot: string, pmId: string): RoleState[] {
  const out: RoleState[] = [];
  const seen = new Set<string>();
  const add = (label: string, absDir: string, fallbackRole: string) => {
    if (seen.has(absDir)) return;
    seen.add(absDir);
    const md = safeRead(join(absDir, "STATE.md"));
    if (md == null) return;
    const { role, status, task } = parseStateMd(md, fallbackRole);
    const claims = parseClaims(safeRead(join(absDir, "report.json")));
    out.push({ container: label, role, status, task, claims });
  };
  // In-project containers.
  for (const name of listDir(pmRoot)) {
    if (/^_dispatch\d+$/.test(name)) add(name, join(pmRoot, name), "dispatch");
    else if (name === "_artisan") add(name, join(pmRoot, name), "artisan");
  }
  const pluralRoles: Record<string, string> = {
    _workers: "worker", _smiths: "smith", _scouts: "scout", _librarians: "librarian",
    _observers: "observer", _guardians: "guardian", _concierges: "concierge",
  };
  for (const [dir, role] of Object.entries(pluralRoles)) {
    for (const id of listDir(join(pmRoot, dir))) add(join(dir, id), join(pmRoot, dir, id), role);
  }
  // Exiled containers (opt-in): pointer keys are `<role>.<id>` or `artisan`.
  for (const [key, abs] of readWorkspacePointer(projectRoot, pmId)) {
    const dot = key.indexOf(".");
    const role = dot > 0 ? key.slice(0, dot) : key;
    add(`${key} (exiled)`, abs, role);
  }
  return out.sort((a, b) => a.container.localeCompare(b.container));
}

function gatherInbox(runtimeRoot: string, limit: number): InboxMsg[] {
  const dir = join(runtimeRoot, "dock", "inbox");
  const files = listDir(dir)
    .filter((f) => !f.startsWith("."))
    .map((f) => ({ f, m: (() => { try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => a.m - b.m) // oldest first
    .slice(0, limit);
  return files.map(({ f }) => {
    const body = safeRead(join(dir, f)) ?? "";
    const summary = body.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
    return { file: f, summary };
  });
}

function gatherQueue(runtimeRoot: string, limit: number): { count: number; next: { id: string; text: string }[] } {
  const md = safeRead(join(runtimeRoot, "backlog", "pending.md"));
  if (!md) return { count: 0, next: [] };
  const rows = md.split("\n").map((l) => l.trim()).filter((l) => /#\d+/.test(l));
  const next = rows.slice(0, limit).map((l) => {
    const id = (/#(\d+)/.exec(l)?.[1]) ?? "";
    return { id, text: l.replace(/^[|\-*\s]+/, "").slice(0, 120) };
  });
  return { count: rows.length, next };
}

function gatherMergeGate(runtimeRoot: string): PulseInput["mergeGate"] {
  const lockPath = join(runtimeRoot, "merge_gate", "locks", "active.lock");
  const lock = safeRead(lockPath);
  const requests = listDir(join(runtimeRoot, "merge_gate", "requests")).filter((f) => f.endsWith(".json")).length;
  return {
    active_lock: lock != null,
    lock_slug: lock != null ? (lock.split("\n").map((l) => l.trim()).find(Boolean) ?? null) : null,
    requests,
  };
}

function numFlag(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : dflt;
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const project = flag("project");
  const pmId = flag("pm-id");
  if (!project || !pmId) {
    process.stderr.write("usage: dock_pulse.ts --project <root> --pm-id <id> [--inbox-limit N] [--queue-limit N] [--out <path>]\n");
    process.exit(2);
  }
  const pmRoot = join(project, "__garelier", pmId);
  const runtimeRoot = join(pmRoot, "runtime");

  const q = gatherQueue(runtimeRoot, numFlag("queue-limit", 5));
  const pulse = buildDockPulse({
    roles: gatherRoles(pmRoot, project, pmId),
    inbox: gatherInbox(runtimeRoot, numFlag("inbox-limit", 5)),
    resolutionsCount: listDir(join(runtimeRoot, "pm", "resolutions")).filter((f) => !f.startsWith(".")).length,
    queuePendingCount: q.count,
    queueNext: q.next,
    mergeGate: gatherMergeGate(runtimeRoot),
  });

  const json = JSON.stringify(pulse, null, 2);
  const out = flag("out");
  if (out) {
    await Bun.write(out, json + "\n");
    process.stdout.write(`${out}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

if (import.meta.main) {
  void main();
}
