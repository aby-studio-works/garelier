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
  StatusSnapshot, LaneInfo, RoleInfo, LeaseInfo, MergeGateInfo,
  DriverInfo, ReportInfo, RoutineInfo, SourceInfo, Warning, BranchInfo,
  ConcurrencyInfo, OutputActionKindCount, OutputControlInfo, OutputRoleChars, OutputRolePromptBytes,
  OutputSlotUsage, PmActionInfo, PmActionItem, DispatchHoldInfo,
  EfficiencyInfo, EfficiencyRoleTokens,
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

  const driver = safe<DriverInfo>("driver", () => readDriver(runtime), {
    running: false, pid: null, lastPollAt: null, inlineRole: null,
  });

  // The dock lane is the DEFAULT lane — it does not write lane.lock (only
  // the artisan lane claims the lock for mutual exclusion). So "no lane.lock"
  // does NOT mean idle: while work is being driven and the artisan lane is
  // unclaimed, the dock pipeline (PM → Dock → Worker/Scout/Smith) is the active
  // lane. This is finalized below once `dispatch` is known, so the dock lane also
  // shows active under DEC-057 dispatch mode (which runs no headless driver).

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
  const concurrency = safe<ConcurrencyInfo>("concurrency", () => readConcurrency(runtime, config, roles), {
    cap: config?.concurrency.maxConcurrentAgents ?? 4, aliveDetached: 0,
  });
  const outputControl = safe<OutputControlInfo>("output_control", () => readOutputControl(runtime, config), {
    enabled: config?.outputControl.enabled ?? true,
    defaultProfile: config?.outputControl.defaultProfile ?? "compact",
    latestUsageMonth: null, totalIterations: 0, recentOverBudget: 0,
    lastOverBudgetAt: null,
    totalPromptBytes: 0,
    averagePromptBytes: null,
    finalActionKinds: [],
    topRolesByOutputChars: [],
    topRolesByPromptBytes: [],
    slotUsage: [],
  });
  const efficiency = safe<EfficiencyInfo>("efficiency", () => readEfficiency(runtime, config), {
    latestMonth: null, totalIterations: 0, avgInputTokensPerIteration: null,
    cacheHitRatio: null, totalCostUsd: 0, topRolesByInputTokens: [], actionKindMix: [],
  });
  const pmAction = safe<PmActionInfo>("pm_action", () => readPmAction(projectRoot, pmId, runtime, config, roles), {
    needed: false, blockedAgents: 0, openQuestions: 0, inboxItems: 0, items: [],
  });
  const dispatchHold = safe<DispatchHoldInfo>("dispatch_hold", () => readDispatchHold(runtime, pmId), NO_HOLD);
  const dispatch = safe<DispatchActivityInfo>("dispatch", () => readDispatchActivity(runtime, roles), {
    inProgress: [], recent: [], eventsTotal: 0,
  });
  // Finalize the dock-lane heuristic now that activity is known: the default
  // (unclaimed) lane reads as "dock" whenever work is being driven — either the
  // headless driver is running, OR roles are mid-dispatch under the DEC-057
  // subagent orchestrator (which runs no driver process). Without this, dispatch
  // work would falsely show the lane as "idle".
  if (lane.state === "idle" && (driver.running || dispatch.inProgress.length > 0)) lane.state = "dock";

  // ---- Cross-cutting warnings ----
  safe("warnings", () => { collectWarnings(runtime, lane, roles, mergeGate, dispatchHold, warnings); return null; }, null);
  safe("knowledge_warnings", () => { collectKnowledgeWarnings(projectRoot, routines, sources, warnings); return null; }, null);

  return {
    ok: true,
    pmId,
    project: config?.project.name ?? null,
    projectRoot,
    generatedAt: new Date().toISOString(),
    lane, driver, branches, roles, mergeGate, concurrency, outputControl, efficiency, pmAction,
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
        const head = readFileSync(qPath, "utf8").split("\n")
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

// DEC-027: count alive detached children from lease files vs the configured cap.
// DEC-057/059: under dispatch / Mode D there are NO driver leases (producers are
// in-session subagents / a codex subprocess), so the lease count is structurally
// 0 and the Concurrency card wrongly read "0/cap". Also count roles mid-dispatch
// from STATE.md (same DISPATCH_ACTIVE_STATES ground truth as the Capacity card +
// the Dispatch-activity panel); max() keeps the headless lease count authoritative
// when present. pm/dock never match (their state is supervised/orchestrator).
function readConcurrency(runtime: string, config: SetupConfig | null, roles: RoleInfo[]): ConcurrencyInfo {
  const cap = config?.concurrency.maxConcurrentAgents ?? 4;
  let alive = 0;
  for (const f of listFiles(`${runtime}/driver/pids`)) {
    if (!f.endsWith(".pid")) continue;
    const lease = readJson<Record<string, unknown>>(f);
    if (!lease) continue;
    if (lease.status === "finished") continue;
    const pid = Number(lease.pid ?? lease.child_pid);
    if (lease.status === "starting" && (!Number.isFinite(pid) || pid <= 0)) { alive++; continue; }
    if (isPidAlive(pid)) alive++;
  }
  const dispatchActive = roles.filter((r) => DISPATCH_ACTIVE_STATES.has(String(r.state).toUpperCase())).length;
  return { cap, aliveDetached: Math.max(alive, dispatchActive) };
}

// DEC-028: read the latest month's usage JSONL for the over-budget trend and the
// roles producing the most output. Best-effort; a missing/corrupt file => zeros.
function readOutputControl(runtime: string, config: SetupConfig | null): OutputControlInfo {
  const enabled = config?.outputControl.enabled ?? true;
  const defaultProfile = config?.outputControl.defaultProfile ?? "compact";
  const usageFiles = listFiles(`${runtime}/driver/usage`)
    .filter((f) => f.endsWith(".jsonl"))
    .sort(); // YYYY-MM.jsonl sorts chronologically
  const latest = usageFiles.length ? usageFiles[usageFiles.length - 1] : null;
  if (!latest) {
    return {
      enabled, defaultProfile, latestUsageMonth: null, totalIterations: 0, recentOverBudget: 0,
      lastOverBudgetAt: null, totalPromptBytes: 0, averagePromptBytes: null, finalActionKinds: [],
      topRolesByOutputChars: [], topRolesByPromptBytes: [], slotUsage: [],
    };
  }
  const month = latest.replace(/\\/g, "/").split("/").pop()!.replace(/\.jsonl$/, "");
  let total = 0;
  let over = 0;
  let lastOverAt: string | null = null;
  let totalPromptBytes = 0;
  const byRole = new Map<string, OutputRoleChars>();
  const byPrompt = new Map<string, OutputRolePromptBytes>();
  const byActionKind = new Map<string, number>();
  const bySlot = new Map<string, Array<Record<string, unknown>>>();
  const currentSlots = currentUsageSlots(config);
  let raw = "";
  try { raw = readFileSync(latest, "utf8"); } catch { raw = ""; }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    total++;
    const chars = Number(rec.result_chars) || 0;
    const promptBytes = Number(rec.prompt_bytes) || 0;
    const role = String(rec.role ?? "?");
    const id = rec.id == null ? null : String(rec.id);
    const key = `${role}:${id ?? ""}`;
    totalPromptBytes += promptBytes;
    const kind = rec.final_action_kind == null ? "unknown" : String(rec.final_action_kind);
    byActionKind.set(kind, (byActionKind.get(kind) ?? 0) + 1);
    if (!currentSlots || currentSlots.has(key)) {
      const prev = byRole.get(key) ?? { role, id, outputChars: 0, count: 0 };
      prev.outputChars += chars;
      prev.count += 1;
      byRole.set(key, prev);
      const pprev = byPrompt.get(key) ?? { role, id, promptBytes: 0, count: 0 };
      pprev.promptBytes += promptBytes;
      pprev.count += 1;
      byPrompt.set(key, pprev);
    }
    const records = bySlot.get(key) ?? [];
    records.push(rec);
    bySlot.set(key, records);
    if (rec.over_budget === true) {
      over++;
      if (typeof rec.ts === "string") lastOverAt = rec.ts;
    }
  }
  const top = [...byRole.values()].sort((a, b) => b.outputChars - a.outputChars).slice(0, 5);
  const topPrompt = [...byPrompt.values()].sort((a, b) => b.promptBytes - a.promptBytes).slice(0, 5);
  const finalActionKinds: OutputActionKindCount[] = [...byActionKind.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const slotUsage = [...bySlot.entries()].map(([key, records]): OutputSlotUsage | null => {
    if (currentSlots && !currentSlots.has(key)) return null;
    const last = records[records.length - 1];
    if (!last) return null;
    const [role] = key.split(":");
    const id = last.id == null ? null : String(last.id);
    const ctx = usageContextTokens(last);
    let prevCtx: number | null = null;
    for (let i = records.length - 2; i >= 0; i--) {
      prevCtx = usageContextTokens(records[i]);
      if (prevCtx != null) break;
    }
    const outputTokens = num(last.output_tokens);
    const promptBytes = num(last.prompt_bytes);
    return {
      role: String(last.role ?? role),
      id,
      label: id ?? String(last.role ?? role),
      provider: last.provider == null ? null : String(last.provider),
      lastAt: typeof last.ts === "string" ? last.ts : null,
      contextTokens: ctx,
      promptBytes,
      outputTokens,
      deltaContextTokens: ctx != null && prevCtx != null ? ctx - prevCtx : null,
      count: records.length,
      outcome: last.outcome == null ? null : String(last.outcome),
      finalActionKind: last.final_action_kind == null ? null : String(last.final_action_kind),
    };
  })
    .filter((x): x is OutputSlotUsage => x != null)
    .sort((a, b) => {
      const at = a.lastAt ? Date.parse(a.lastAt) : 0;
      const bt = b.lastAt ? Date.parse(b.lastAt) : 0;
      if (bt !== at) return bt - at;
      return (b.contextTokens ?? 0) - (a.contextTokens ?? 0);
    })
    .slice(0, 12);
  return {
    enabled, defaultProfile, latestUsageMonth: month,
    totalIterations: total, recentOverBudget: over, lastOverBudgetAt: lastOverAt,
    totalPromptBytes,
    averagePromptBytes: total > 0 ? Math.round(totalPromptBytes / total) : null,
    finalActionKinds,
    topRolesByOutputChars: top,
    topRolesByPromptBytes: topPrompt,
    slotUsage,
  };
}

function currentUsageSlots(config: SetupConfig | null): Set<string> | null {
  if (!config) return null;
  const set = new Set<string>(["pm:", "dock:"]);
  if (config.artisan) set.add(`artisan:${config.artisan.id}`);
  const groups: Array<["worker" | "scout" | "smith" | "librarian" | "observer" | "guardian" | "concierge", { id: string }[]]> = [
    ["worker", config.workers],
    ["scout", config.scouts],
    ["smith", config.smiths],
    ["librarian", config.librarians],
    ["observer", config.observers],
    ["guardian", config.guardians],
    ["concierge", config.concierges],
  ];
  for (const [role, agents] of groups) for (const a of agents) set.add(`${role}:${a.id}`);
  return set;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function usageContextTokens(rec: Record<string, unknown>): number | null {
  const parts = [num(rec.input_tokens), num(rec.cache_read), num(rec.cache_write)].filter((n): n is number => n != null);
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b, 0);
}

// DEC-042: token-efficiency aggregation over the latest month's usage JSONL.
// Pure read; a missing/corrupt file => safe zeros. Model is never a lever here —
// this only shows where tokens go and how well the prompt cache absorbs the
// fixed per-iteration overhead, at the user's configured model/effort.
export function readEfficiency(runtime: string, _config: SetupConfig | null): EfficiencyInfo {
  const empty: EfficiencyInfo = {
    latestMonth: null, totalIterations: 0, avgInputTokensPerIteration: null,
    cacheHitRatio: null, totalCostUsd: 0, topRolesByInputTokens: [], actionKindMix: [],
  };
  const usageFiles = listFiles(`${runtime}/driver/usage`)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const latest = usageFiles.length ? usageFiles[usageFiles.length - 1] : null;
  if (!latest) return empty;
  const month = latest.replace(/\\/g, "/").split("/").pop()!.replace(/\.jsonl$/, "");
  let total = 0;
  let sumContext = 0;     // input + cache_read + cache_write across iterations
  let sumInput = 0;       // raw input_tokens (cache-miss reads)
  let sumCacheRead = 0;   // cache_read (cache hits)
  let totalCost = 0;
  const byRole = new Map<string, EfficiencyRoleTokens>();
  const byActionKind = new Map<string, number>();
  let raw = "";
  try { raw = readFileSync(latest, "utf8"); } catch { raw = ""; }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    total++;
    const ctx = usageContextTokens(rec) ?? 0;
    sumContext += ctx;
    sumInput += num(rec.input_tokens) ?? 0;
    sumCacheRead += num(rec.cache_read) ?? 0;
    const cost = num(rec.cost_usd) ?? 0;
    totalCost += cost;
    const role = String(rec.role ?? "?");
    const id = rec.id == null ? null : String(rec.id);
    const key = `${role}:${id ?? ""}`;
    const prev = byRole.get(key) ?? { role, id, inputTokens: 0, costUsd: 0, count: 0 };
    prev.inputTokens += ctx;
    prev.costUsd += cost;
    prev.count += 1;
    byRole.set(key, prev);
    const kind = rec.final_action_kind == null ? "unknown" : String(rec.final_action_kind);
    byActionKind.set(kind, (byActionKind.get(kind) ?? 0) + 1);
  }
  const topRolesByInputTokens = [...byRole.values()]
    .sort((a, b) => b.inputTokens - a.inputTokens)
    .slice(0, 8);
  const actionKindMix: OutputActionKindCount[] = [...byActionKind.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  const cacheDenom = sumInput + sumCacheRead;
  return {
    latestMonth: month,
    totalIterations: total,
    avgInputTokensPerIteration: total > 0 ? Math.round(sumContext / total) : null,
    cacheHitRatio: cacheDenom > 0 ? sumCacheRead / cacheDenom : null,
    totalCostUsd: Math.round(totalCost * 10000) / 10000,
    topRolesByInputTokens,
    actionKindMix,
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

// The driver runs PM and Dock INLINE (not as detached agents), logging
// "<role>: iteration_start" / "<role>: iteration_end" to its stdout log. The most
// recent of those two events tells us whether a role is iterating right now: a
// trailing iteration_start (no later iteration_end) => that role is busy inline.
// This is the only signal that the driver is working during the long PM/Dock
// windows where aliveDetached is structurally 0. Best-effort; scans the tail only.
function readInlineRole(runtime: string, running: boolean): string | null {
  if (!running) return null;
  let raw = "";
  try { raw = readFileSync(`${runtime}/driver/logs/driver.stdout.log`, "utf8"); } catch { return null; }
  const lines = raw.split("\n");
  const floor = Math.max(0, lines.length - 800);
  for (let i = lines.length - 1; i >= floor; i--) {
    const m = lines[i].match(/\]\s+(pm|dock):\s+(iteration_start|iteration_end)\b/);
    if (m) return m[2] === "iteration_start" ? m[1] : null;
  }
  return null;
}

function readDriver(runtime: string): DriverInfo {
  const pidFile = `${runtime}/driver/driver.pid`;
  const raw = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
  const pid = /^\d+$/.test(raw) ? Number(raw) : null;
  const running = isPidAlive(pid);
  const trackerMtime = mtimeIso(`${runtime}/driver/change_tracker.json`);
  return { running, pid, lastPollAt: trackerMtime, inlineRole: readInlineRole(runtime, running) };
}

function readLease(runtime: string, role: string, id: string): LeaseInfo | null {
  const p = `${runtime}/driver/pids/${role}-${id}.pid`;
  const raw = readJson<Record<string, unknown>>(p);
  if (!raw) return null;
  const pid = typeof raw.pid === "number" ? raw.pid : (typeof raw.child_pid === "number" ? raw.child_pid : null);
  return {
    status: raw.status ? String(raw.status) : null,
    pid,
    alive: isPidAlive(pid),
    branch: raw.branch ? String(raw.branch) : null,
    lane: raw.lane ? String(raw.lane) : null,
    startedAt: raw.started_at ? String(raw.started_at) : null,
  };
}

function roleState(dir: string, expectedKind: string): { state: string; stale: boolean; task: string | null } {
  const stateFile = `${dir}/STATE.md`;
  if (!existsSync(stateFile)) return { state: "idle", stale: false, task: null };
  // Detect a STATE.md left by a DIFFERENT role (container-reuse residue): its
  // first heading names the role kind (e.g. "# Worker worker-01"). If that
  // disagrees with the container's role, the status is STALE — never report it
  // as a live state. (A Scout container left holding a merged Worker's REPORTING
  // would otherwise show "REPORTING" forever.)
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
  // PM + Dock are coordinators, not worktree producers. Under the headless driver
  // they are driver-"supervised"; under DEC-057 dispatch mode there is no driver
  // iterating them — they ARE the interactive orchestrator. Report mode-aware so
  // "supervised" is not shown when no driver supervises them.
  const pmDockState = driverAlive(runtime) ? "supervised" : "orchestrator";
  roles.push({
    kind: "pm",
    id: config?.pmId ?? null,
    provider: config?.runner.pm.provider ?? null,
    model: config?.runner.pm.model || null,
    state: pmDockState,
    branch: null,
    lease: null,
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
    lease: null,
    task: null,
    warnings: [],
  });

  if (config?.artisan) {
    // DEC-036 (superseding 0035): resolve the role container (in-project by
    // default; an exile home outside <proj> only when exile is opted in).
    const dir = roleContainer(projectRoot, pmId, "artisan", "");
    const { state, stale, task } = roleState(dir, "artisan");
    const lease = readLease(runtime, "artisan", config.artisan.id);
    roles.push({
      kind: "artisan",
      id: config.artisan.id,
      provider: config.artisan.provider,
      model: config.artisan.model || null,
      state,
      branch: lease?.branch ?? null,
      lease,
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
      const lease = readLease(runtime, kind, a.id);
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
        branch: lease?.branch ?? null,
        lease,
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
      const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("<!--"));
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

/** Whether the per-PM driver process is alive (its pid file points to a live pid). */
function driverAlive(runtime: string): boolean {
  const p = `${runtime}/driver/driver.pid`;
  if (!existsSync(p)) return false;
  const raw = readFileSync(p, "utf8").trim();
  // driver.pid is a bare number ("7164") in current builds, but tolerate a
  // JSON object ({"pid":7164}) too. JSON.parse("7164") returns the NUMBER 7164,
  // so handle the number case explicitly (a naive obj.pid read would miss it).
  let pid = NaN;
  try {
    const j = JSON.parse(raw) as number | { pid?: number };
    if (typeof j === "number") pid = j;
    else if (j && typeof j.pid === "number") pid = j.pid;
  } catch {
    pid = parseInt(raw, 10);
  }
  return Number.isFinite(pid) && pid > 0 && isPidAlive(pid);
}

const RECENT_RATE_LIMIT_WINDOW_MS = 6 * 60 * 60 * 1000;

// A driver "*_cleared" recovery event (rate_limited_cleared) contains the
// substring "rate_limited", so it matches BASE_RATE_LIMIT_PATTERNS — but it means
// a PRIOR limit has RECOVERED (consecutive counter reset to 0). When it is the
// NEWEST rate-limit signal, the provider is no longer throttled and no warning
// should show. Derived from the role_contracts SoT (CI-checked against the event
// the driver actually emits) so a rename can't silently un-recognize recovery.
// (circuit_cleared carries no rate/limit token, so it never reaches this scan.)
const RATE_LIMIT_CLEARED_RE = new RegExp(RATE_LIMIT_EVENTS.cleared.join("|"), "i");

// Status-scan rate-limit matcher. We scan STRUCTURED driver logs, so a line is a
// rate-limit signal ONLY if it names a driver rate-limit EVENT (RATE_LIMIT_EVENTS)
// or carries a provider limit PHRASE. We deliberately do NOT reuse
// BASE_RATE_LIMIT_PATTERNS here: its bare `\b429\b` false-matches a numeric log
// field (e.g. `output_tokens=429`, `cache_write=429`) on an ordinary iteration_end
// line. A genuine raw-429 provider error is already classified by the driver into
// a `rate_limited` EVENT (role.ts), which the event matcher still catches — so
// nothing real is missed.
const RATE_LIMIT_EVENT_RE = new RegExp(
  [...RATE_LIMIT_EVENTS.active, ...RATE_LIMIT_EVENTS.cleared].join("|"), "i",
);
const RATE_LIMIT_PHRASE_RE =
  /rate[_ -]?limit|session[_ -]?limit|usage[_ -]?limit|hit your .{0,40}limit|quota[_ -]?exceeded|too[_ -]?many[_ -]?requests/i;
function lineRateLimited(s: string): boolean {
  return RATE_LIMIT_EVENT_RE.test(s) || RATE_LIMIT_PHRASE_RE.test(s);
}

function rateLimitLineSummary(line: string): { tsMs: number | null; summary: string } {
  const trimmed = line.trim();
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const tsRaw = typeof obj.ts === "string" ? obj.ts : null;
    const tsMs = tsRaw ? Date.parse(tsRaw) : null;
    const text =
      (typeof obj.text === "string" && obj.text) ||
      (typeof obj.reason === "string" && obj.reason) ||
      (typeof obj.error_message === "string" && obj.error_message) ||
      (typeof obj.result_tail === "string" && obj.result_tail) ||
      (typeof obj.stderr_tail === "string" && obj.stderr_tail) ||
      (typeof obj.stdout_tail === "string" && obj.stdout_tail) ||
      (typeof obj.event === "string" && obj.event) ||
      trimmed;
    return { tsMs: Number.isFinite(tsMs) ? tsMs : null, summary: redact(String(text)).slice(0, 240) };
  } catch {
    // Plain driver.stdout.log line: "[2026-06-02T04:52:51.466Z] source: event …".
    // Parse the ISO prefix so recency keys on the real event time, not the
    // (always fresh, continuously-appended) file mtime — otherwise a stale line
    // in a live log file is forever treated as "recent".
    const m = trimmed.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    const tsMs = m ? Date.parse(m[1]) : NaN;
    return { tsMs: Number.isFinite(tsMs) ? tsMs : null, summary: redact(trimmed).slice(0, 240) };
  }
}

// Epoch ms of the CURRENT driver run's start = the newest "driver: starting"
// marker in the driver stdout log. Used to scope the rate-limit scan to this run:
// the log is appended across restarts, so a backoff from a prior (since-restarted)
// run must not surface as the current state. 0 when no boot marker is in the tail
// (then the scan falls back to the plain recency window).
function currentRunStartMs(runtime: string): number {
  const tail = readTail(`${runtime}/driver/logs/driver.stdout.log`);
  let best = 0;
  const re = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\][^\n]*\bdriver:\s*starting\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) best = Math.max(best, t);
  }
  return best;
}

function readRecentRateLimit(runtime: string): { path: string; summary: string } | null {
  const logsDir = `${runtime}/driver/logs`;
  const now = Date.now();
  // Only count rate-limit events that belong to the CURRENT run and are recent:
  // a restart clears the in-memory rate-limit state, so a prior run's backoff is
  // not "current" (it also flickered as the readTail window slid past it).
  const lowerBound = Math.max(now - RECENT_RATE_LIMIT_WINDOW_MS, currentRunStartMs(runtime));
  const files = listFiles(logsDir)
    .filter((f) => /\.(jsonl|log)(\.\d+)?$/i.test(f))
    .map((f) => {
      try { return { f, mtimeMs: statSync(f).mtimeMs }; } catch { return { f, mtimeMs: 0 }; }
    })
    .filter((x) => now - x.mtimeMs <= RECENT_RATE_LIMIT_WINDOW_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 20);

  // The newest rate-limit-related event across recent logs decides the CURRENT
  // state: a "*_cleared" recovery event means the limit has lifted (no warning);
  // an active event (rate_limited / rate_limited_recorded / rate_limit_backoff /
  // a raw provider session-limit message) still within the window warns. Scanning
  // for "the first match newest-first" was wrong — a recovery event sorts newest
  // yet still matched the pattern, so a cleared limit showed as active forever.
  let newest: { tsMs: number; cleared: boolean; summary: string; path: string } | null = null;
  for (const { f } of files) {
    const tail = readTail(f);
    if (!lineRateLimited(tail)) continue;
    const lines = tail.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (!lineRateLimited(line)) continue;
      const hit = rateLimitLineSummary(line);
      // A matching line with NO parseable timestamp is a multi-line-field
      // continuation or a readTail boundary-cut partial line — NOT the event's
      // primary record (which always carries `[ISO]` / JSON `ts`). Skip it: the
      // old `?? mtimeMs` fallback dated such a fragment to the (always-fresh) file
      // mtime, so a stale (e.g. 10h-old) session-limit message read as "now" and
      // stuck on the Dashboard forever.
      if (hit.tsMs == null) continue;
      const tsMs = hit.tsMs;
      if (!newest || tsMs >= newest.tsMs) {
        newest = {
          tsMs,
          cleared: RATE_LIMIT_CLEARED_RE.test(line),
          summary: hit.summary,
          path: `runtime/driver/logs/${basename(f)}`,
        };
      }
    }
  }
  if (!newest) return null;
  if (newest.cleared) return null;            // recovered
  if (newest.tsMs < lowerBound) return null;  // from a prior run, or older than the window
  return { path: newest.path, summary: newest.summary };
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
  // stale pid leases
  for (const f of listFiles(`${runtime}/driver/pids`)) {
    if (!f.endsWith(".pid")) continue;
    const raw = readJson<Record<string, unknown>>(f);
    const pid = raw && typeof raw.pid === "number" ? raw.pid : null;
    const status = raw?.status ? String(raw.status) : null;
    if (pid != null && status !== "finished" && !isPidAlive(pid)) {
      warnings.push({ kind: "stale_pid", path: f.replace(runtime, "runtime"), message: `PID ${pid} not alive but lease not finished.` });
    }
  }
  if (lane.stale) {
    warnings.push({ kind: "stale_lane_lock", path: "runtime/lane.lock", message: `lane.lock owner (${lane.owner ?? "?"}) pid is not alive; verify and clear via PM.` });
  }
  if (mergeGate.state === "failed") {
    // Only when NO newer run is in flight (readMergeGate reports "running",
    // not "failed", while a re-gate supersedes this result).
    warnings.push({ kind: "failed_quality_gate", path: "runtime/merge_gate/results", message: "Last completed merge-gate result is failed (no newer run in flight)." });
  }
  const rateLimited = readRecentRateLimit(runtime);
  if (rateLimited) {
    warnings.push({
      kind: "rate_limited",
      path: rateLimited.path,
      message: `Recent provider output looks rate-limited/session-limited: ${rateLimited.summary}`,
    });
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
  // Fire in BOTH modes: under the headless driver AND under DEC-057 dispatch
  // (where driverAlive() is false by design) — gating on driverAlive() hid the
  // "why is nothing moving / dispatch hold" signal in dispatch mode.
  if (!producersBusy && mergeGate.state !== "running") {
    const pending = readPendingBacklogCount(runtime);
    if (pending > 0) {
      if (hold.active) {
        // A dispatch HOLD parks the backlog — fire in BOTH modes (headless driver
        // AND DEC-057 dispatch), since an explicit hold is the answer to "why is
        // nothing moving?" regardless of how the pipeline is driven.
        warnings.push({
          kind: "dispatch_hold",
          path: hold.rel ?? "runtime/dock/inbox",
          message: `DISPATCH HOLD${hold.scope ? ` on ${hold.scope}` : ""} — ${pending} backlog item(s) parked: ${hold.reason ?? "see directive"}. To resume, just tell PM to lift the hold${hold.scope ? ` (e.g. "resume ${hold.scope}")` : ""}.`,
        });
      } else if (driverAlive(runtime)) {
        // Generic idle-with-pending only when the headless driver is alive (= the
        // pipeline is SUPPOSED to be auto-running). With no driver (dispatch mode
        // or simply stopped) and no explicit hold, idle is expected — not a warning.
        warnings.push({
          kind: "idle_with_pending",
          path: "runtime/dock/inbox",
          message: `Idle: ${pending} backlog item(s) pending but no producer is working and no gate is running — a dispatch hold or PM directive may be in effect. Check runtime/dock/inbox/.`,
        });
      }
    }
  }
  for (const r of roles) {
    if (r.warnings.length) for (const m of r.warnings) warnings.push({ kind: "unresolved_review", message: `${r.kind} ${r.id ?? ""}: ${m}` });
  }
}
