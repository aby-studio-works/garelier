// Best-effort runtime snapshot for the read-only Status Web Console.
//
// Reads files only. Never mutates state, never spawns a provider. Every
// section is wrapped so a missing/corrupt file becomes a warning instead
// of crashing the server. Secrets are redacted from any file content that
// reaches the browser.

import { existsSync, statSync, readFileSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readAgentState } from "./state.ts";
import { roleContainer } from "./workspace.ts";
import { reportArtifact, RATE_LIMIT_EVENTS } from "./role_contracts.ts";
import { deliverableSidecarSummary, readDeliverableSidecarForMarkdown } from "./deliverable_sidecar.ts";
import type { SetupConfig } from "./config.ts";
import type {
  StatusSnapshot, LaneInfo, RoleInfo, MergeGateInfo,
  ReportInfo, RoutineInfo, SourceInfo, Warning, BranchInfo, PmActionInfo, PmActionItem, DispatchHoldInfo,
  DispatchActivityInfo, DispatchEvent, DispatchInProgress,
} from "./status_types.ts";

export interface SnapshotOptions {
  showSourceUrls?: boolean; // false => domain-only
  maxReports?: number;
}

// Belt-and-suspenders redaction for any file content that reaches the browser
// (important under the LAN-default bind). Both keyword=value forms AND
// shape-based high-entropy tokens that carry no keyword, plus whole PEM blocks
// (not just the header) and connection-string credentials. Over-redaction is
// acceptable; this is a safety net, not the primary access control.
const SECRET_PATTERNS: Array<RegExp> = [
  /(?:api[_-]?key|secret|token|password|passwd|credential|cookie|private[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*\S+/gi,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, // whole PEM block (incl. body)
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, // lone header fallback
  /AKIA[0-9A-Z]{16}/g,                                  // AWS access key id
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/g,                    // GitHub PAT / OAuth / refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,                  // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                  // Slack
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,                          // OpenAI-style
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,    // Stripe-style
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,                         // Google API key
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT
];
// scheme://user:pass@host — mask the credentials, keep the scheme + host.
const CONN_CRED = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s:@/]+@/gi;

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  out = out.replace(CONN_CRED, (_m, scheme) => `${scheme}[REDACTED]@`);
  return out;
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function readJson<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (/^\d+$/.test(raw)) return { pid: Number(raw) } as unknown as T; // legacy numeric pidfile
    return JSON.parse(raw) as T;
  } catch { return null; }
}

function mtimeIso(path: string): string | null {
  try { return new Date(statSync(path).mtimeMs).toISOString(); } catch { return null; }
}

const SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const EXTERNAL_SOURCE_TYPES = new Set(["sharepoint", "url"]);
const SOURCE_REGISTRY_PATH = "docs/garelier/knowledge/source_registry.toml";
const ROUTINE_REGISTRY_PATH = "docs/garelier/knowledge/routine_registry.toml";

function listFiles(dir: string): string[] {
  try { return readdirSync(dir).map((f) => join(dir, f)); } catch { return []; }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseTimeMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function sameTimestamp(a: string, b: string): boolean {
  const ams = parseTimeMs(a);
  const bms = parseTimeMs(b);
  if (ams != null && bms != null) return ams === bms;
  return a.trim() === b.trim();
}

function safeProjectFile(projectRoot: string, rel: string | undefined): string | null {
  if (!rel || rel.includes("\0")) return null;
  const raw = rel.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(raw) || raw.startsWith("//")) return null;
  const clean = raw.replace(/^\/+/, "");
  if (!clean || clean.split("/").some((part) => part === "..")) return null;
  return join(projectRoot, clean);
}

function readMetadataValue(path: string, key: string): string | null {
  try {
    const re = new RegExp(`^[#>\\s-]*${escapeRegExp(key)}\\s*[:=]\\s*["']?([^"'#\\r\\n]+?)["']?\\s*(?:#.*)?$`, "i");
    const lines = readFileSync(path, "utf8").split(/\r?\n/).slice(0, 120);
    for (const line of lines) {
      const m = line.match(re);
      if (m) return m[1].trim();
    }
  } catch { /* best-effort metadata lint */ }
  return null;
}

function readTail(path: string, maxBytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    const st = statSync(path);
    const bytes = Math.min(maxBytes, st.size);
    if (bytes <= 0) return "";
    const buf = Buffer.alloc(bytes);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, bytes, st.size - bytes);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function buildSnapshot(
  projectRoot: string,
  pmId: string,
  config: SetupConfig | null,
  opts: SnapshotOptions = {},
): StatusSnapshot {
  const warnings: Warning[] = [];
  const pmRoot = `${projectRoot}/__garelier/${pmId}`;
  const runtime = `${pmRoot}/runtime`;
  const showUrls = opts.showSourceUrls !== false;
  const maxReports = opts.maxReports ?? 10;

  const safe = <T>(label: string, fn: () => T, fallback: T): T => {
    try { return fn(); }
    catch (e) {
      warnings.push({ kind: "snapshot_error", path: label, message: (e as Error).message });
      return fallback;
    }
  };

  const lane = safe<LaneInfo>("lane.lock", () => readLane(runtime), {
    state: "unknown", owner: null, taskId: null, branch: null,
    targetBranch: null, startedAt: null, status: null, stale: false,
  });

  // The dock lane is the DEFAULT lane — it does not write lane.lock (only
  // the artisan lane claims the lock for mutual exclusion). So "no lane.lock"
  // does NOT mean idle: while work is being driven and the artisan lane is
  // unclaimed, the dock pipeline (PM → Dock → Worker/Scout/Smith) is the active
  // lane. This is finalized below once `dispatch` is known, so the dock lane also
  // shows active under dispatch (DEC-057).

  const branches: BranchInfo = {
    target: config?.branches.target ?? null,
    studio: config?.branches.integration ?? null,
    // The artisan lane names a satchel branch in lane.lock; the dock
    // lane has no single lane branch — its active integration branch is studio.
    activeBranch: lane.branch ?? config?.branches.integration ?? null,
  };

  const roles = safe<RoleInfo[]>("roles", () => readRoles(projectRoot, pmId, runtime, config), []);
  const mergeGate = safe<MergeGateInfo>("merge_gate", () => readMergeGate(runtime), {
    state: "unknown", active: false, pendingRequests: 0, pendingResults: 0, lastResult: null,
  });
  const recentReports = safe<ReportInfo[]>("reports", () => readReports(projectRoot, pmId, config, pmRoot, maxReports), []);
  const routines = safe<RoutineInfo[]>("routines", () => readRoutines(projectRoot), []);
  const sources = safe<SourceInfo[]>("sources", () => readSources(projectRoot, showUrls), []);
  const pmAction = safe<PmActionInfo>("pm_action", () => readPmAction(projectRoot, pmId, runtime, config, roles), {
    needed: false, blockedAgents: 0, openQuestions: 0, inboxItems: 0, items: [],
  });
  const dispatchHold = safe<DispatchHoldInfo>("dispatch_hold", () => readDispatchHold(runtime, pmId), NO_HOLD);
  const dispatch = safe<DispatchActivityInfo>("dispatch", () => readDispatchActivity(runtime, roles), {
    inProgress: [], recent: [], eventsTotal: 0,
  });
  // Finalize the dock-lane heuristic now that activity is known: the default
  // (unclaimed) lane reads as "dock" whenever work is being driven — either the
  // roles are mid-dispatch under the DEC-057
  // subagent orchestrator (which runs no driver process). Without this, dispatch
  // work would falsely show the lane as "idle".
  if (lane.state === "idle" && dispatch.inProgress.length > 0) lane.state = "dock";

  // ---- Cross-cutting warnings ----
  safe("warnings", () => { collectWarnings(runtime, lane, roles, mergeGate, dispatchHold, warnings); return null; }, null);
  safe("knowledge_warnings", () => { collectKnowledgeWarnings(projectRoot, routines, sources, warnings); return null; }, null);

  return {
    ok: true,
    pmId,
    project: config?.project.name ?? null,
    projectRoot,
    generatedAt: new Date().toISOString(),
    lane, branches, roles, mergeGate, pmAction,
    dispatchHold, dispatch,
    recentReports, routines, sources, warnings,
  };
}

// "PM action needed" detector for the status console. Hard signal: a role in
// BLOCKED state, or one that left a `questions.md` (it cannot proceed without a
// PM/Dock answer). The PM inbox (Dock→PM escalations) is surfaced as a
// review queue: its total count plus the most-recent few, so escalations that
// need a PM decision but didn't BLOCK an agent (e.g. a "waive vs re-gate" call)
// are visible too. Read-only + best-effort; never throws (wrapped by `safe`).
function readPmAction(
  projectRoot: string, pmId: string, runtime: string,
  config: SetupConfig | null, roles: RoleInfo[],
): PmActionInfo {
  const items: PmActionItem[] = [];
  let blocked = 0;
  let questions = 0;

  for (const r of roles) {
    if (r.kind === "pm" || r.kind === "dock") continue; // supervised, no questions.md
    if (r.kind !== "artisan" && !r.id) continue;
    const dir = roleContainer(projectRoot, pmId, r.kind, r.kind === "artisan" ? "" : r.id!);
    const qPath = `${dir}/questions.md`;
    const hasQ = existsSync(qPath);
    const isBlocked = (r.state ?? "").toUpperCase() === "BLOCKED";
    // A questions.md is only OPEN while the role is BLOCKED on it. A leftover
    // questions.md on a role that has since resumed (WORKING/REPORTING) is stale
    // residue — counting it shows a false "PM action needed".
    if (isBlocked) blocked++;
    if (hasQ && isBlocked) questions++;
    if (!isBlocked) continue;
    const who = `${r.kind}${r.id ? ` ${r.id}` : ""}`;
    let summary = isBlocked ? `${who} is BLOCKED — awaiting PM/Dock` : `${who} raised a question`;
    let openPath = isBlocked ? `${dir}/STATE.md` : qPath;
    if (hasQ) {
      try {
        const head = readFileSync(qPath, "utf8").split(/\r?\n/)
          .map((l) => l.trim()).find((l) => l && !l.startsWith("<!--"));
        if (head) summary = `${who}: ${head.replace(/^#+\s*/, "")}`;
        openPath = qPath;
      } catch { /* keep default */ }
    }
    items.push({
      kind: hasQ ? "question" : "blocked_agent",
      role: r.kind, agentId: r.id,
      summary: redact(summary).slice(0, 200),
      rel: repoRel(projectRoot, openPath), since: mtimeIso(openPath),
    });
  }

  const inboxDir = `${runtime}/pm/inbox`;
  const inboxFiles = listFiles(inboxDir).filter((f) => f.endsWith(".md"));
  const recentInbox = inboxFiles
    .map((f) => ({ f, m: (() => { try { return statSync(f).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 6);
  for (const { f } of recentInbox) {
    const base = f.replace(/\\/g, "/").split("/").pop() ?? f;
    // filename shape: <YYYYMMDD-HHMMSS>-<from>-<topic>.md → show "from: topic"
    const m = base.match(/^\d{8}-\d{6}-([^-]+)-(.+)\.md$/);
    const topic = m ? `${m[1]}: ${m[2].replace(/-/g, " ")}` : base.replace(/\.md$/, "");
    items.push({
      kind: "inbox", role: null, agentId: null,
      summary: redact(topic).slice(0, 200),
      rel: repoRel(projectRoot, f), since: mtimeIso(f),
    });
  }

  return {
    needed: blocked > 0 || questions > 0,
    blockedAgents: blocked, openQuestions: questions,
    inboxItems: inboxFiles.length, items,
  };
}

function readLane(runtime: string): LaneInfo {
  const p = `${runtime}/lane.lock`;
  const raw = readJson<Record<string, unknown>>(p);
  if (!raw) {
    return { state: "idle", owner: null, taskId: null, branch: null, targetBranch: null, startedAt: null, status: null, stale: false };
  }
  const laneVal = String(raw.lane ?? "unknown");
  const ownerPid = typeof raw.pid === "number" ? raw.pid : null;
  const stale = ownerPid != null && !isPidAlive(ownerPid);
  const state = laneVal === "artisan" ? "artisan" : laneVal === "dock" ? "dock" : "unknown";
  return {
    state,
    owner: raw.owner ? String(raw.owner) : null,
    taskId: raw.task_id ? String(raw.task_id) : null,
    branch: raw.branch ? String(raw.branch) : null,
    targetBranch: raw.target_branch ? String(raw.target_branch) : null,
    startedAt: raw.started_at ? String(raw.started_at) : null,
    status: raw.status ? String(raw.status) : null,
    stale,
  };
}

function roleState(dir: string, expectedKind: string): { state: string; stale: boolean; task: string | null } {
  const stateFile = `${dir}/STATE.md`;
  if (!existsSync(stateFile)) return { state: "idle", stale: false, task: null };
  // Detect a STATE.md left by a DIFFERENT role (container-reuse residue): its
  // first heading names the role kind (e.g. "# Worker worker-01"). If that
  // disagrees with the container's role, the status is STALE — never report it
  // as a live state.
  try {
    const head = readFileSync(stateFile, "utf8").slice(0, 200);
    const m = /^#\s+([A-Za-z]+)\b/m.exec(head);
    const headerKind = m ? m[1].toLowerCase() : null;
    if (headerKind && headerKind !== expectedKind.toLowerCase()) {
      return { state: "stale", stale: true, task: null };
    }
  } catch { /* fall through to the normal read */ }
  const st = readAgentState(stateFile);
  const task = st.currentTask ? redact(st.currentTask).replace(/\s+/g, " ").slice(0, 200) : null;
  return { state: st.status, stale: false, task };
}

export function readRoles(projectRoot: string, pmId: string, runtime: string, config: SetupConfig | null): RoleInfo[] {
  const roles: RoleInfo[] = [];
  // PM + Dock are coordinators, not worktree producers.
  // they are driver-"supervised"; under DEC-057 dispatch mode there is no driver
  // iterating them — they ARE the interactive orchestrator. Report mode-aware so
  // "supervised" is not shown when no driver supervises them.
  const pmDockState = "orchestrator"; // dispatch-only (DEC-066): the interactive session IS PM/Dock
  roles.push({
    kind: "pm",
    id: config?.pmId ?? null,
    provider: config?.runner.pm.provider ?? null,
    model: config?.runner.pm.model || null,
    state: pmDockState,
    branch: null,
    task: null,
    warnings: [],
  });
  roles.push({
    kind: "dock",
    id: null,
    provider: config?.runner.dock.provider ?? null,
    model: config?.runner.dock.model || null,
    state: pmDockState,
    branch: null,
    task: null,
    warnings: [],
  });

  if (config?.artisan) {
    // DEC-036 (superseding 0035): resolve the role container (in-project by
    // default; an exile home outside <proj> only when exile is opted in).
    const dir = roleContainer(projectRoot, pmId, "artisan", "");
    const { state, stale, task } = roleState(dir, "artisan");
    roles.push({
      kind: "artisan",
      id: config.artisan.id,
      provider: config.artisan.provider,
      model: config.artisan.model || null,
      state,
      branch: null,
      task,
      warnings: stale ? ["stale STATE.md (residue from another role — not a live artisan)"] : [],
    });
  }
  const groups: Array<[
    "worker" | "scout" | "smith" | "librarian" | "observer" | "guardian" | "concierge",
    { id: string; provider?: string; model?: string }[],
  ]> = [
    ["worker", config?.workers ?? []],
    ["scout", config?.scouts ?? []],
    ["smith", config?.smiths ?? []],
    ["librarian", config?.librarians ?? []],
    ["observer", config?.observers ?? []],
    ["guardian", config?.guardians ?? []],
    ["concierge", config?.concierges ?? []],
  ];
  for (const [kind, agents] of groups) {
    for (const a of agents) {
      const dir = roleContainer(projectRoot, pmId, kind, a.id);
      const { state, stale, task } = roleState(dir, kind);
      const w: string[] = [];
      if (stale) w.push(`stale STATE.md (residue from another role — not a live ${kind})`);
      else if (state === "REPORTING") {
        const rf = reportArtifact(kind);
        if (!existsSync(`${dir}/${rf}`)) w.push(`REPORTING without ${rf}`);
      }
      roles.push({
        kind,
        id: a.id,
        provider: a.provider ?? null,
        model: a.model || null,
        state,
        branch: null,
        task,
        warnings: w,
      });
    }
  }
  return roles;
}

function readMergeGate(runtime: string): MergeGateInfo {
  const reqDir = `${runtime}/merge_gate/requests`;
  const resDir = `${runtime}/merge_gate/results`;
  const lockFile = `${runtime}/merge_gate/locks/active.lock`;
  // Count only real request files: `*.summary.json` are companions/sidecars,
  // never dispatchable merge requests. Counting them inflated pendingRequests
  // and — because a sidecar basename never matches a result basename — pinned
  // the gate to "running" forever (head-of-line orphan sidecar). Mirror the
  // results filter so both sides agree on what a request is.
  const requests = listFiles(reqDir).filter((f) => f.endsWith(".json") && !f.endsWith(".summary.json"));
  const results = listFiles(resDir).filter((f) => f.endsWith(".json") && !f.endsWith(".summary.json"));
  const base = (f: string) => f.split(/[\\/]/).pop() ?? f;
  const resultNames = new Set(results.map(base));

  // Newest COMPLETED result — kept for reference even while a newer gate runs.
  let lastResult: string | null = null;
  if (results.length > 0) {
    const newest = results.map((f) => ({ f, m: statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0]!.f;
    lastResult = readJson<{ status?: string }>(newest)?.status ?? null;
  }

  // A gate is RUNNING now if the runner holds the active lock, or a queued
  // request has not yet produced a result (same basename). Such a run
  // SUPERSEDES the last completed result: reporting that stale result as the
  // current state — the bug this guards — made every status surface read
  // "failed" while a newer gate was mid-flight (e.g. an old sccache false-fail
  // shown as current while the re-gate was already passing). When a run is in
  // flight the state is "running"; the prior outcome stays in `lastResult`.
  const running = existsSync(lockFile) || requests.some((f) => !resultNames.has(base(f)));

  let state: MergeGateInfo["state"];
  if (running) state = "running";
  else if (lastResult === "success") state = "passed";
  else if (lastResult === "failed") state = "failed";
  else if (lastResult === "conflict") state = "conflict";
  else if (lastResult != null) state = "unknown";
  else if (requests.length > 0) state = "running";
  else state = "idle";

  return { state, active: running, pendingRequests: requests.length, pendingResults: results.length, lastResult };
}

function readReports(
  projectRoot: string,
  pmId: string,
  config: SetupConfig | null,
  pmRoot: string,
  max: number,
): ReportInfo[] {
  const out: ReportInfo[] = [];
  // Most roles write report.md; Guardian/Concierge use a role-specific name.
  // DEC-036 (superseding 0035): enumerate agents from config and resolve each
  // container via the role-home resolver (in-project by default; an opted-in
  // exile home is not under pmRoot, so directory scanning would miss it). Scout
  // writes no report.md.
  const candidates: Array<{ role: string; id: string | null; dir: string; reportFile: string }> = [];
  if (config?.artisan) {
    candidates.push({ role: "artisan", id: config.artisan.id, dir: roleContainer(projectRoot, pmId, "artisan", ""), reportFile: "report.md" });
  }
  const groups: Array<["worker" | "smith" | "librarian" | "observer" | "guardian" | "concierge", { id: string }[], string]> = [
    ["worker", config?.workers ?? [], "report.md"],
    ["smith", config?.smiths ?? [], "report.md"],
    ["librarian", config?.librarians ?? [], "report.md"],
    ["observer", config?.observers ?? [], "report.md"],
    ["guardian", config?.guardians ?? [], "guardian_report.md"],
    ["concierge", config?.concierges ?? [], "concierge_report.md"],
  ];
  for (const [role, agents, reportFile] of groups) {
    for (const a of agents) candidates.push({ role, id: a.id, dir: roleContainer(projectRoot, pmId, role, a.id), reportFile });
  }
  for (const c of candidates) {
    const rp = `${c.dir}/${c.reportFile}`;
    if (!existsSync(rp)) continue;
    out.push(makeReport(c.role, c.id, projectRoot, pmRoot, rp));
  }
  // control/reports/** (promote, benchmark, data_audit, requests, ...)
  walkReports(`${pmRoot}/control/reports`, 2, projectRoot, pmRoot, out);
  out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return out.slice(0, max);
}

function walkReports(dir: string, depth: number, projectRoot: string, pmRoot: string, out: ReportInfo[]): void {
  if (depth < 0) return;
  for (const p of listFiles(dir)) {
    try {
      const st = statSync(p);
      if (st.isDirectory()) walkReports(p, depth - 1, projectRoot, pmRoot, out);
      else if (p.endsWith(".md")) out.push(makeReport("report", null, projectRoot, pmRoot, p));
    } catch { /* ignore */ }
  }
}

// Repo-relative path (forward slashes) when `path` is inside the project; null
// for an exile container outside it (DEC-036) — such reports aren't openable
// via /api/file. Drives the click-to-open full report view.
function repoRel(projectRoot: string, path: string): string | null {
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = path.replace(/\\/g, "/");
  return p.startsWith(root + "/") ? p.slice(root.length + 1) : null;
}

function makeReport(role: string, agentId: string | null, projectRoot: string, pmRoot: string, path: string): ReportInfo {
  let summary = "";
  try {
    const sidecar = readDeliverableSidecarForMarkdown(path);
    if (sidecar) {
      summary = redact(deliverableSidecarSummary(sidecar)).slice(0, 240);
    }
    if (!summary) {
      const lines = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("<!--"));
      summary = redact(lines.slice(0, 3).join(" / ")).slice(0, 240);
    }
  } catch { /* ignore */ }
  return {
    role, agentId,
    path: path.replace(pmRoot, "__garelier/<pm_id>"),
    rel: repoRel(projectRoot, path),
    updatedAt: mtimeIso(path), summary,
  };
}

function readRoutines(projectRoot: string): RoutineInfo[] {
  const p = `${projectRoot}/docs/garelier/knowledge/routine_registry.toml`;
  if (!existsSync(p)) return [];
  const data = parseToml(readFileSync(p, "utf8")) as { routines?: Array<Record<string, unknown>> };
  return (data.routines ?? []).map((r) => ({
    id: String(r.id ?? ""),
    title: r.title ? String(r.title) : undefined,
    manual: r.manual ? String(r.manual) : undefined,
    defaultRole: r.default_role ? String(r.default_role) : undefined,
    targetFile: r.target_file ? String(r.target_file) : undefined,
    sourceId: r.source_id ? String(r.source_id) : undefined,
    trigger: r.trigger ? String(r.trigger) : undefined,
    risk: r.risk ? String(r.risk) : undefined,
  }));
}

function readSources(projectRoot: string, showUrls: boolean): SourceInfo[] {
  const p = `${projectRoot}/docs/garelier/knowledge/source_registry.toml`;
  if (!existsSync(p)) return [];
  const data = parseToml(readFileSync(p, "utf8")) as { sources?: Array<Record<string, unknown>> };
  return (data.sources ?? []).map((s) => {
    let url = s.url ? String(s.url) : undefined;
    if (url && !showUrls) { try { url = new URL(url).host; } catch { url = "[hidden]"; } }
    return {
      id: String(s.id ?? ""),
      title: s.title ? String(s.title) : undefined,
      kind: s.kind ? String(s.kind) : undefined,
      sourceType: s.source_type ? String(s.source_type) : undefined,
      target: s.target ? String(s.target) : undefined,
      updateMode: s.update_mode ? String(s.update_mode) : undefined,
      trust: s.trust ? String(s.trust) : undefined,
      authority: s.authority ? String(s.authority) : undefined,
      license: s.license ? String(s.license) : undefined,
      use: s.use ? String(s.use) : undefined,
      lastSyncedAt: s.last_synced_at ? String(s.last_synced_at) : undefined,
      lastReviewedAt: s.last_reviewed_at ? String(s.last_reviewed_at) : undefined,
      url,
    };
  });
}

/** Count pending backlog task rows (e.g. "| 07 | #13 | ..."). Best-effort. */
function readPendingBacklogCount(runtime: string): number {
  const p = `${runtime}/backlog/pending.md`;
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (/^\s*\|\s*\d+\s*\|\s*#\d+/.test(line)) n++;
  }
  return n;
}


function sourceNeedsFreshness(s: SourceInfo): boolean {
  const sourceType = (s.sourceType ?? "").toLowerCase();
  const updateMode = (s.updateMode ?? "").toLowerCase();
  return EXTERNAL_SOURCE_TYPES.has(sourceType) || Boolean(s.url) || updateMode === "scheduled";
}

function isExternalSource(s: SourceInfo): boolean {
  const sourceType = (s.sourceType ?? "").toLowerCase();
  return EXTERNAL_SOURCE_TYPES.has(sourceType) || Boolean(s.url);
}

function collectKnowledgeWarnings(
  projectRoot: string, routines: RoutineInfo[], sources: SourceInfo[], warnings: Warning[],
): void {
  const now = Date.now();

  for (const s of sources) {
    const label = s.id || s.target || "(unnamed source)";
    const external = isExternalSource(s);
    if (external) {
      for (const [field, value] of [
        ["authority", s.authority],
        ["license", s.license],
        ["use", s.use],
        ["last_reviewed_at", s.lastReviewedAt],
      ] as const) {
        if (!value) {
          warnings.push({
            kind: "stale_source_registry",
            path: SOURCE_REGISTRY_PATH,
            message: `source ${label} is external but ${field} is empty.`,
          });
        }
      }
      if ((s.license ?? "").toLowerCase() === "not-adoptable") {
        warnings.push({
          kind: "stale_source_registry",
          path: SOURCE_REGISTRY_PATH,
          message: `source ${label} is marked license=not-adoptable; do not export/adopt it without PM review.`,
        });
      } else if ((s.license ?? "").toLowerCase() === "unknown") {
        warnings.push({
          kind: "stale_source_registry",
          path: SOURCE_REGISTRY_PATH,
          message: `source ${label} has license=unknown; confirm license before adoption/export.`,
        });
      }
    }

    if (!sourceNeedsFreshness(s)) continue;

    if (!s.lastSyncedAt) {
      warnings.push({
        kind: "stale_source_registry",
        path: SOURCE_REGISTRY_PATH,
        message: `source ${label} needs freshness tracking but last_synced_at is empty.`,
      });
      continue;
    }

    const syncedMs = parseTimeMs(s.lastSyncedAt);
    if (syncedMs == null) {
      warnings.push({
        kind: "stale_source_registry",
        path: SOURCE_REGISTRY_PATH,
        message: `source ${label} has invalid last_synced_at: ${s.lastSyncedAt}.`,
      });
      continue;
    }
    if (now - syncedMs > SOURCE_STALE_AFTER_MS) {
      const days = Math.floor((now - syncedMs) / (24 * 60 * 60 * 1000));
      warnings.push({
        kind: "stale_source_registry",
        path: SOURCE_REGISTRY_PATH,
        message: `source ${label} last synced ${days} day(s) ago; refresh or re-review the registry entry.`,
      });
    }

    if (!s.target) continue;
    const targetPath = safeProjectFile(projectRoot, s.target);
    if (!targetPath) {
      warnings.push({
        kind: "stale_source_registry",
        path: SOURCE_REGISTRY_PATH,
        message: `source ${label} has an invalid target path: ${s.target}.`,
      });
      continue;
    }
    if (!existsSync(targetPath)) {
      warnings.push({
        kind: "stale_source_registry",
        path: s.target,
        message: `source ${label} target is missing: ${s.target}.`,
      });
      continue;
    }
    const targetSyncedAt = readMetadataValue(targetPath, "last_synced_at");
    if (!targetSyncedAt) {
      warnings.push({
        kind: "stale_source_registry",
        path: s.target,
        message: `source ${label} target lacks last_synced_at metadata matching source_registry.toml.`,
      });
    } else if (!sameTimestamp(s.lastSyncedAt, targetSyncedAt)) {
      warnings.push({
        kind: "stale_source_registry",
        path: s.target,
        message: `source ${label} last_synced_at mismatch: registry=${s.lastSyncedAt}, target=${targetSyncedAt}.`,
      });
    }
  }

  for (const r of routines) {
    if (!r.manual) continue;
    const manualPath = safeProjectFile(projectRoot, r.manual);
    if (!manualPath || !existsSync(manualPath)) {
      warnings.push({
        kind: "missing_routine_manual",
        path: r.manual || ROUTINE_REGISTRY_PATH,
        message: `routine ${r.id || "(unnamed routine)"} manual is missing: ${r.manual}.`,
      });
    }
  }
}

const NO_HOLD: DispatchHoldInfo = { active: false, scope: null, reason: null, rel: null, issuedAt: null, source: null };

/** True when directive text declares an ACTIVE dispatch hold (vs a pure resume). */
function isActiveHoldText(txt: string): boolean {
  return /\bHELD\b|stays?\s+held|do\s*not\s+dispatch|dispatch\s+hold|on\s+hold\b/i.test(txt);
}
/** First "# heading" line, trimmed, as a short reason. */
function firstHeading(txt: string): string | null {
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^#+\s+(.*\S)\s*$/);
    if (m) return m[1]!.slice(0, 200);
  }
  return null;
}
/** The HELD milestone token (e.g. "m4"), not a co-mentioned resumed one. */
function extractHoldScope(txt: string): string | null {
  // milestone as the subject of the hold: "<m> stays held" / "<m> on hold".
  let m = txt.match(/\b(m\d+[\w-]*)\s+(?:stays?\s+)?(?:on\s+)?(?:hold|held)\b/i);
  if (m) return m[1]!;
  // milestone as the object: "hold/held/do not dispatch … <m>".
  m = txt.match(/(?:do\s*not\s+dispatch|on\s+hold|\bhold\b|\bheld\b)[^\n]{0,40}?\b(m\d+[\w-]*)\b/i);
  if (m) return m[1]!;
  m = txt.match(/\b(m\d+[\w-]*)\b/i);
  return m ? m[1]! : null;
}
function extractIssued(txt: string): string | null {
  const m = txt.match(/Issued:\s*([0-9T:.\-Z]+)/);
  return m ? m[1]! : null;
}

/**
 * Detect an active dispatch HOLD so the console can explain WHY the pipeline is
 * parked. Prefers a canonical marker (`runtime/dock/dispatch_hold.md`); else
 * heuristically surfaces the newest dock-inbox directive that declares a
 * hold. Read-only, best-effort.
 */
export function readDispatchHold(runtime: string, pmId: string): DispatchHoldInfo {
  // Robust repo-relative path: listFiles() returns join()'d paths (backslashes
  // on Windows) while `runtime` may use forward slashes — normalize both before
  // stripping the prefix, else the openable link is corrupted.
  const relOf = (abs: string) => {
    const a = abs.replace(/\\/g, "/");
    const r = runtime.replace(/\\/g, "/");
    const tail = a.startsWith(r) ? a.slice(r.length) : a.replace(/^.*\/runtime/, "");
    return `__garelier/${pmId}/runtime${tail.startsWith("/") ? tail : "/" + tail}`;
  };
  const marker = `${runtime}/dock/dispatch_hold.md`;
  if (existsSync(marker)) {
    let txt = ""; try { txt = readFileSync(marker, "utf8"); } catch { /* ignore */ }
    return {
      active: true,
      scope: extractHoldScope(txt),
      reason: firstHeading(txt) ?? "dispatch hold in effect",
      rel: relOf(marker),
      issuedAt: extractIssued(txt),
      source: "marker",
    };
  }
  const inbox = `${runtime}/dock/inbox`;
  if (!existsSync(inbox)) return NO_HOLD;
  let best: { path: string; mtime: number; txt: string } | null = null;
  for (const f of listFiles(inbox)) {
    if (!f.endsWith(".md")) continue;
    let txt: string; try { txt = readFileSync(f, "utf8"); } catch { continue; }
    if (!isActiveHoldText(txt)) continue;
    let m = 0; try { m = statSync(f).mtimeMs; } catch { /* ignore */ }
    if (!best || m > best.mtime) best = { path: f, mtime: m, txt };
  }
  if (!best) return NO_HOLD;
  // Supersession: if a NEWER inbox directive explicitly RESUMES this scope (and
  // does not itself re-declare it held), the hold has been lifted — don't keep
  // showing it. Without this, a resume directive can't clear the banner because
  // older hold files still match the hold heuristic.
  const scope0 = extractHoldScope(best.txt);
  if (scope0) {
    const esc = scope0.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reScope = new RegExp(`\\b${esc}\\b`, "i");
    const reStillHold = new RegExp(`\\b${esc}\\b[^\\n]{0,30}(?:stays?\\s+held|on\\s+hold|\\bheld\\b)|do\\s*not\\s+dispatch[^\\n]*\\b${esc}\\b`, "i");
    for (const f of listFiles(inbox)) {
      if (!f.endsWith(".md")) continue;
      let m = 0; try { m = statSync(f).mtimeMs; } catch { continue; }
      if (m <= best.mtime) continue;
      let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
      if (reScope.test(t) && /\bresume\b|\blift(ed|ing|s)?\b|再開|unhold/i.test(t) && !reStillHold.test(t)) {
        return NO_HOLD;
      }
    }
  }
  const lines = best.txt.split(/\r?\n/);
  const doNot =
    lines.find((l) => /do\s*not\s+dispatch/i.test(l)) ??
    lines.find((l) => !/^#/.test(l) && /\bm\d+\b/i.test(l) && /held|hold/i.test(l)) ??
    lines.find((l) => !/^#/.test(l) && /stays?\s+held|on\s+hold|remain[^\n]*held/i.test(l));
  return {
    active: true,
    scope: extractHoldScope(best.txt),
    reason: (doNot?.replace(/^[-*\s]+/, "").trim().slice(0, 200)) || firstHeading(best.txt) || "dispatch hold in effect",
    rel: relOf(best.path),
    issuedAt: extractIssued(best.txt),
    source: "inbox",
  };
}

// Dispatch states a subagent passes through while a producer/reviewer is mid-run
// (vs IDLE/unknown). Derived from each role's STATE.md status. MUST include the
// reviewer/rework states: a Guardian (CHECKING) or Observer (OBSERVING) subagent
// running during the merge gate, or a Worker re-running on REWORK/REVIEWING, is
// genuinely mid-dispatch and occupies a slot. Omitting them made the Dispatch
// panel + Capacity/Concurrency read "idle 0/cap" during a Guardian→Observer
// review — the console lying about the system's most common operation. Kept
// identical to static/app.js DISPATCH_ACTIVE_STATES (the SPA's copy); update both.
export const DISPATCH_ACTIVE_STATES = new Set([
  "ASSIGNED", "WORKING", "REPORTING", "REVIEWING", "REWORK", "OBSERVING", "CHECKING", "BLOCKED",
]);

/**
 * Live "Dispatch activity" for the console (DEC-057 subagent-orchestrator model):
 *   - `inProgress`: roles whose STATE.md shows them mid-dispatch right now — i.e.
 *     subagents the orchestrator has out and is awaiting (no idle bays to poll).
 *   - `recent`: the newest dispatch events the orchestrator appended to
 *     `runtime/dispatch/events.jsonl` (one compact JSON object per line:
 *     {ts, role, kind, task, ref}). Newest first, capped at 20.
 * Read-only, best-effort; a missing/garbled events file just yields an empty log.
 */
export function readDispatchActivity(runtime: string, roles: RoleInfo[]): DispatchActivityInfo {
  const inProgress: DispatchInProgress[] = roles
    .filter((r) => r.id != null && DISPATCH_ACTIVE_STATES.has(String(r.state).toUpperCase()))
    .map((r) => ({ role: r.id as string, state: String(r.state).toUpperCase(), task: r.task }));

  // Ad-hoc dispatch containers (__garelier/<pm>/_dispatch<N>/, DEC-063 helper):
  // not in the role roster, but their STATE.md (written by dispatch_prepare,
  // removed by dispatch_cleanup) makes live producer work visible here —
  // operator feedback: a running jig tick must show on the dashboard.
  try {
    const pmDir = runtime.replace(/[\\\/]runtime[\\\/]?$/, "");
    for (const name of readdirSync(pmDir)) {
      if (!/^_dispatch\d+$/.test(name)) continue;
      let body = "";
      try { body = readFileSync(`${pmDir}/${name}/STATE.md`, "utf8"); } catch { continue; }
      const st = body.match(/##\s*Status\s*\r?\n\s*([A-Za-z_]+)/)?.[1]?.toUpperCase() ?? "";
      if (!DISPATCH_ACTIVE_STATES.has(st)) continue;
      const task = body.match(/##\s*Current task\s*\r?\n\s*(.+)/)?.[1]?.trim() ?? null;
      inProgress.push({ role: name.replace(/^_/, ""), state: st, task });
    }
  } catch { /* best-effort */ }

  let recent: DispatchEvent[] = [];
  let eventsTotal = 0;
  const file = `${runtime}/dispatch/events.jsonl`;
  if (existsSync(file)) {
    let raw = ""; try { raw = readFileSync(file, "utf8"); } catch { raw = ""; }
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    eventsTotal = lines.length;
    const parsed: DispatchEvent[] = [];
    for (const l of lines.slice(-20)) {
      try {
        const o = JSON.parse(l) as Record<string, unknown>;
        parsed.push({
          ts: o.ts != null ? String(o.ts) : null,
          role: String(o.role ?? "?"),
          kind: String(o.kind ?? "note"),
          task: o.task != null ? String(o.task) : null,
          ref: o.ref != null ? String(o.ref) : null,
        });
      } catch { /* skip malformed line */ }
    }
    recent = parsed.reverse(); // newest first
  }
  return { inProgress, recent, eventsTotal };
}

function collectWarnings(
  runtime: string, lane: LaneInfo, roles: RoleInfo[], mergeGate: MergeGateInfo, hold: DispatchHoldInfo, warnings: Warning[],
): void {
  if (lane.stale) {
    warnings.push({ kind: "stale_lane_lock", path: "runtime/lane.lock", message: `lane.lock owner (${lane.owner ?? "?"}) pid is not alive; verify and clear via PM.` });
  }
  if (mergeGate.state === "failed") {
    // Only when NO newer run is in flight (readMergeGate reports "running",
    // not "failed", while a re-gate supersedes this result).
    warnings.push({ kind: "failed_quality_gate", path: "runtime/merge_gate/results", message: "Last completed merge-gate result is failed (no newer run in flight)." });
  }
  // Idle-with-pending: the system is up but nothing is moving while work waits.
  // This is the signal behind "why doesn't the next task start?" — most often a
  // dispatch hold / PM directive in dock/inbox (intentional), but also a
  // stuck dispatch. Surfacing it distinguishes idle-by-design from stuck, so an
  // idle run with a full backlog is never mistaken for a broken one.
  // Any producer OR reviewer role being non-idle counts as "the pipeline is
  // moving" (scout/observer/guardian/concierge were wrongly excluded, so a busy
  // reviewer read as idle). Also covers dispatch mode (STATE-based).
  const BUSY_KINDS = new Set(["worker", "smith", "artisan", "librarian", "scout", "observer", "guardian", "concierge"]);
  // Actively-progressing states (case-robust: roleState returns lowercase "idle"
  // for no-STATE.md roles while STATE.md statuses are uppercase). BLOCKED is NOT
  // "busy" (it is surfaced via pmAction, and a blocked item is not moving).
  const ACTIVE_PRODUCER_STATES = new Set(["WORKING", "ASSIGNED", "REPORTING", "REVIEWING", "OBSERVING", "CHECKING", "REWORK"]);
  const producersBusy = roles.some(
    (r) => BUSY_KINDS.has(r.kind) && ACTIVE_PRODUCER_STATES.has(String(r.state || "").toUpperCase()),
  );
  // Fire whenever an explicit hold parks pending work
  // (where driverAlive() is false by design) — gating on driverAlive() hid the
  // "why is nothing moving / dispatch hold" signal in dispatch mode.
  if (!producersBusy && mergeGate.state !== "running") {
    const pending = readPendingBacklogCount(runtime);
    if (pending > 0) {
      if (hold.active) {
        // A dispatch HOLD parks the backlog (fire regardless of how the
        // AND DEC-057 dispatch), since an explicit hold is the answer to "why is
        // nothing moving?" regardless of how the pipeline is driven.
        warnings.push({
          kind: "dispatch_hold",
          path: hold.rel ?? "runtime/dock/inbox",
          message: `DISPATCH HOLD${hold.scope ? ` on ${hold.scope}` : ""} — ${pending} backlog item(s) parked: ${hold.reason ?? "see directive"}. To resume, just tell PM to lift the hold${hold.scope ? ` (e.g. "resume ${hold.scope}")` : ""}.`,
        });
      }
      // (No generic idle_with_pending without an explicit hold: under
      // dispatch-only, idle-with-backlog is expected until the PM dispatches.)
    }
  }
  for (const r of roles) {
    if (r.warnings.length) for (const m of r.warnings) warnings.push({ kind: "unresolved_review", message: `${r.kind} ${r.id ?? ""}: ${m}` });
  }
}
