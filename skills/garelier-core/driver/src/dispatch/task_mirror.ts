// task_mirror.ts — mechanical backlog → Task-list mirror (DEC-092).
//
// Derives the session work mirror from the CANONICAL sources (the control
// planning backlog + the live _dispatch<N> containers) so no agent hand-crafts
// it. Emits, from one computation:
//   --format ops      : a desired Task list + the minimal create/update/complete
//                       ops vs a passed-in current list (a Claude-Code agent
//                       applies these to the harness Task tool; this is the only
//                       agent-side, judgment-free step).
//   --format markdown : an agent-agnostic queue view (Codex / humans / a console).
//   --format json     : the raw derived model.
//
// The control backlog (`control/project_dashboard/backlog.md`) is canonical; this
// script only READS it (+ live dispatch state). The Task list / markdown are
// derived views — re-run at each refresh anchor (loop boundary, user status
// query, merge, session resume) so a missed update self-corrects.
//
// Usage:
//   bun task_mirror.ts --pm-id <id> --project <root> [--format ops|markdown|json]
//                      [--current <tasklist.json>]
//   <tasklist.json> = [{ "taskId": "11", "subject": "...", "status": "pending" }, ...]
//   (a Claude agent obtains it from TaskList and passes it; absent → ops create-all).

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arg, printHelpAndExitIfRequested } from "../cli_args.ts";

// The dispatchability class is the backlog's own `status` value (faithful
// pass-through), with `ready` refined by type / blueprint / Test discipline. The
// script does NOT guess a class from prose — if a class is wrong, fix the backlog
// `status` (the canonical field), not the script. The status vocabulary is
// extensible: a PM who sets status `gated` / `run` / `blueprint` / `design` sees
// exactly that.
type DispatchClass = string;

export interface BacklogItem {
  id: string;            // W-NNN
  type: string;          // feature/bug/maintenance/research
  priority: string;      // high/normal
  status: string;        // ready/triage/deferred
  milestone: string;
  desc: string;
  blueprint: string | null;  // relative path or null
  cls: DispatchClass;
}

export interface LiveEntry { state: string; num: number }  // _dispatch<num> STATE.md status
export interface DispatchInfo { id: number; role: string; slug: string; state: string }  // one live _dispatch<id> container

export interface DesiredTask {
  key: string;           // the W-NNN (stable identity in the subject)
  subject: string;
  status: "pending" | "in_progress";
  description: string;
  activeForm: string;
  dispatch: LiveEntry | null;  // live _dispatch<N> backing this item, if any
}

export interface CurrentTask { taskId: string; subject: string; status: string }
export type Op =
  | { op: "create"; subject: string; description: string; activeForm?: string }
  | { op: "update"; taskId: string; subject?: string; status?: string; description?: string; activeForm?: string }
  | { op: "complete"; taskId: string; subject: string }
  // Non-destructive: current shows completed but a live _dispatch<N> is still
  // actually running it (STATE.md not REPORTING/BLOCKED) — surface it, never
  // auto-correct the Task list from a warn (the live dispatch is the truth
  // once it reports).
  | { op: "warn"; reason: "completed_but_in_flight"; taskId: string; dispatch: number };

function readText(p: string): string { try { return readFileSync(p, "utf8"); } catch { return ""; } }

// --- parse the control backlog markdown table -----------------------------
// Row: | W-NNN | type | priority | status | owner | milestone | desc | accept | `path` |
export function parseBacklog(path: string): BacklogItem[] {
  const out: BacklogItem[] = [];
  for (const raw of readText(path).split(/\r?\n/)) {
    if (!/^\|\s*W-\d+\s*\|/.test(raw)) continue;
    const c = raw.split("|").map((s) => s.trim());
    // c[0] is the empty cell before the leading pipe.
    const id = c[1], type = c[2] ?? "", priority = c[3] ?? "", status = c[4] ?? "";
    const milestone = c[6] ?? "", desc = c[7] ?? "", bpCell = c[9] ?? "";
    const bpM = bpCell.match(/`([^`]+\.md)`/);
    const blueprint = bpM ? bpM[1] : null;
    const item: BacklogItem = { id, type, priority, status, milestone, desc, blueprint, cls: "ready" };
    item.cls = classify(item);
    out.push(item);
  }
  return out;
}

// Dispatchability class — primarily from RELIABLE explicit fields (status, type,
// blueprint presence, the blueprint's Test discipline); keyword scan only as a
// secondary, carefully-bounded hint. Mechanical; keeps the user-facing "why is
// this (not) being dispatched" honest. The full prose lives in the backlog desc.
function classify(it: BacklogItem): DispatchClass {
  // The backlog `status` IS the class — pass it through faithfully. Only the
  // generic `ready` is refined by reliable explicit signals (type / blueprint /
  // Test discipline). No prose guessing: a wrong class is fixed in the backlog
  // `status`, not here. (So a PM who sets status `gated`/`run`/`blueprint`/
  // `design`/`verify`/`idle` sees exactly that.)
  if (it.status !== "ready") return it.status;
  if (it.type === "research") return "research";
  if (!it.blueprint) return "needs-blueprint";
  return testDisciplineTdd(it.blueprint) ? "ready·tdd" : "ready";
}

let g_bpDir = "";
function testDisciplineTdd(bpRel: string): boolean {
  if (!g_bpDir) return false;
  // blueprint paths in the backlog are relative to project_dashboard/ (../blueprints/x.md)
  const name = bpRel.replace(/^.*\//, "");
  const body = readText(`${g_bpDir}/${name}`);
  return /^- *Test discipline: *tdd\b/im.test(body);
}

// --- live dispatch state (in-flight producers) ----------------------------
// Scans `_dispatch<N>/STATE.md` (dispatch_prepare.sh's own scaffold, written at
// L151 of dispatch_prepare.sh: `# Dispatch #<id> - <role> <slug>` header +
// `## Status` + `## Current task`). One dispatch container disappearing from
// this scan (cleanup already ran) is the only "merge done" signal (W-040) --
// there is no separate "done" flag to read.
export function scanDispatches(pmRoot: string): DispatchInfo[] {
  const out: DispatchInfo[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(pmRoot); } catch { return out; }
  for (const name of entries) {
    const dm = name.match(/^_dispatch(\d+)$/);
    if (!dm) continue;
    const raw = readText(`${pmRoot}/${name}/STATE.md`);
    if (!raw) continue;
    const header = raw.match(/^#\s*Dispatch\s*#\d+\s*-\s*(\S+)\s+(\S.*)$/m);
    const role = header?.[1] ?? "";
    const slug = (header?.[2] ?? "").trim()
      || raw.match(/^##\s*Current task[\s\S]*?\n\n.*?(\S+-\S+)/m)?.[1]
      || raw.match(/-\s+(w\d+-[a-z0-9-]+|[a-z0-9]+(?:-[a-z0-9]+)+)/i)?.[1]
      || "";
    const state = raw.match(/^##\s*Status\s*\n\s*\n\s*(\w+)/m)?.[1] ?? "";
    if (slug) out.push({ id: Number(dm[1]), role, slug, state });
  }
  return out;
}

export function liveDispatch(pmRoot: string): Map<string, LiveEntry> {
  // slug -> { state: WORKING/REPORTING/BLOCKED, num: the <N> in _dispatch<N> }
  const m = new Map<string, LiveEntry>();
  for (const d of scanDispatches(pmRoot)) m.set(d.slug, { state: d.state, num: d.id });
  return m;
}

// Same sanitize + 64-char truncate as dispatch_prepare.sh's AGENT_NAME (`tr -c
// 'A-Za-z0-9_-' '-'` + leading-char guard) so the owner shown here is the exact
// name `dispatch_prepare.sh` assigned the dispatched role (workflow-naming.md
// §5): `ga-<role>-<slug>`, not the retired `ga-produce-<slug>` (W-042,
// user directive 2026-07-11 — eca9ffa changed what dispatch_prepare.sh
// actually emits; this must reconstruct the SAME value, not a stale one).
export function agentNameForSlug(slug: string, role: string): string {
  const cleaned = `ga-${role}-${slug}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const named = /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `a${cleaned}`;
  return named.slice(0, 64);
}

// --- dispatch-unit desired tasks (W-040) -----------------------------------
// One desired Task PER LIVE `_dispatch<N>` container, independent of whether
// its slug happens to embed the backlog W-NNN number (buildDesired's overlay
// above only catches that coincidence). Key is `#<id>` (anchored the same way
// `W-NNN:` is, see keyOf) so it never collides with a backlog-item key.
// completed is defined as ONLY "the container is gone" (merge done, cleanup
// ran) -- a live WORKING/REPORTING/BLOCKED container is always in_progress,
// which lets diffOps auto-correct a worker that marked its own task completed
// early (real friction: "worker が task を勝手に completed 化 → PM が gate 中に
// 戻す").
export function buildDispatchDesired(dispatches: DispatchInfo[]): DesiredTask[] {
  return dispatches.map((d) => {
    const owner = agentNameForSlug(d.slug, d.role);
    const st = d.state.toUpperCase();
    let activeForm: string;
    if (st === "WORKING") activeForm = `${d.slug} を ${d.role || "producer"} が実装中`;
    else if (st === "REPORTING") activeForm = `${d.slug} gate review 中 (merge 前)`;
    else if (st === "BLOCKED") activeForm = `${d.slug} がブロック中 (回答待ち)`;
    else activeForm = `${d.slug} (#${d.id} ${d.role || "?"}, state ${d.state || "unknown"})`;
    const stateTag = d.state ? d.state.toLowerCase() : "unknown";
    return {
      key: `#${d.id}`,
      subject: `#${d.id}: ${d.slug} [dispatch:${stateTag}]`,
      status: "in_progress",
      description:
        `Dispatch: #${d.id} (${d.role || "?"}) — ${d.slug}\n` +
        `State: ${d.state || "unknown"}\n` +
        `Owner: ${owner}\n` +
        `Completed only when __garelier/<pm_id>/_dispatch${d.id}/ is gone (merge done, W-040).`,
      activeForm,
      dispatch: { state: d.state, num: d.id },
    };
  });
}

function shortTitle(it: BacklogItem): string {
  // truncate at a word boundary (no mid-word cuts), ellipsis if shortened.
  const clip = (s: string): string => {
    const t = s.trim();
    if (t.length <= 54) return t;
    const cut = t.slice(0, 52);
    // trim back to the last word boundary if there is one (latin); keep as-is for
    // space-less scripts (e.g. CJK).
    return (/\s/.test(cut) ? cut.replace(/\s\S*$/, "") : cut) + "…";
  };
  // A real blueprint stem is the best title; an inspection / milestone path is not.
  if (it.blueprint && /\/blueprints\//.test(it.blueprint)) {
    return clip(it.blueprint.replace(/^.*\//, "").replace(/\.md$/, "").replace(/^w\d+-/i, "").replace(/-/g, " "));
  }
  // a backlog desc usually opens with a **bold** title phrase — prefer it.
  const bold = it.desc.match(/\*\*([^*]{5,}?)\*\*/);
  if (bold) {
    const t = bold[1].replace(/^[（(]|[）)]$/g, "").replace(/`[^`]*`/g, "").trim();
    if (t.length >= 5 && !/^\s*[（(]/.test(bold[1])) return clip(t);
  }
  // else: drop bold/code/dates and take the first meaningful clause.
  const cleaned = it.desc
    .replace(/\*\*/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\(?\b\d{4}[-\s]\d{1,2}[-\s]\d{1,2}\b\)?/g, "");
  const clause = cleaned.split(/[。.|]/).map((s) => s.trim()).find((s) => s.length > 4);
  return clip(clause ?? it.id);
}

// in-flight if any live dispatch slug carries this item's id (w<NNN>-...) or matches.
function dispatchStateFor(it: BacklogItem, live: Map<string, LiveEntry>): LiveEntry | null {
  const num = it.id.replace(/^W-/i, "");
  for (const [slug, entry] of live) {
    if (new RegExp(`(^|[^0-9])w0*${num}-`, "i").test(slug)) return entry;
  }
  return null;
}

export function buildDesired(items: BacklogItem[], live: Map<string, LiveEntry>): DesiredTask[] {
  return items.map((it) => {
    const title = shortTitle(it);
    const dstate = dispatchStateFor(it, live);
    const dispatchable = it.cls === "ready" || it.cls === "ready·tdd";
    const subject = `${it.id}: ${title} [${it.cls}]`;
    const description =
      `Backlog: ${it.id} · ${it.type}/${it.priority}/${it.status}\n` +
      `Class: ${it.cls}${dispatchable ? " — dispatchable now" : " — see desc"}\n` +
      `Blueprint: ${it.blueprint ?? "—"}\n` +
      `Dispatch: ${dstate ? `in-flight (${dstate.state}, #${dstate.num})` : "none"}\n` +
      `Notes: ${it.milestone}`;
    return {
      key: it.id,
      subject,
      status: dstate ? "in_progress" : "pending",
      description,
      activeForm: `Draining ${it.id} ${title}`,
      dispatch: dstate,
    };
  });
}

// --- diff against the agent's current Task list ---------------------------
// Anchored: a subject is recognized as belonging to THIS mirror only if it
// starts with the exact id-prefix shape the mirror generates (`W-NNN: `). A
// subject that merely CONTAINS a W-NNN token elsewhere — e.g. a different
// project's own backlog id named inside free text, such as a cross-repo task
// on the same session's Task list — must never be treated as backlog-owned.
// An earlier, unanchored version matched W-NNN anywhere in the subject, so it
// could complete/overwrite a foreign task whose id happened to collide
// (real incident: a foreign "W-043 …" task on the same Task list as this
// Garelier mirror; DEC-092, W-027).
// W-040: the dispatch-unit desired tasks from buildDispatchDesired use a
// second anchor shape, `#<id>: `, disjoint from `W-NNN: ` by construction (a
// backlog id is always `W-` + digits; a dispatch id is always `#` + digits).
export function keyOf(subject: string): string | null {
  return subject.match(/^(W-\d+):\s/)?.[1] ?? subject.match(/^(#\d+):\s/)?.[1] ?? null;
}

// A near-miss: carries a W-NNN or #NNN token but not in either mirror-owned
// shape above — exactly the case that used to risk a stray complete/update.
// Counted, never touched, so drift review can see it happened.
export function looksForeign(subject: string): boolean {
  return (/\bW-\d+\b/.test(subject) || /#\d+\b/.test(subject)) && !keyOf(subject);
}

export function diffOps(current: CurrentTask[], desired: DesiredTask[]): { ops: Op[]; foreign: number } {
  const ops: Op[] = [];
  const curByKey = new Map<string, CurrentTask>();
  let foreign = 0;
  for (const t of current) {
    const k = keyOf(t.subject);
    if (k) { curByKey.set(k, t); continue; }
    if (looksForeign(t.subject)) foreign++;
  }
  const desiredKeys = new Set(desired.map((d) => d.key));
  for (const d of desired) {
    const cur = curByKey.get(d.key);
    if (!cur) { ops.push({ op: "create", subject: d.subject, description: d.description, activeForm: d.activeForm }); continue; }
    if (cur.status === "completed" && d.dispatch) {
      // W-040: a dispatch-keyed task (`#<id>: `) IS the live _dispatch<N>
      // container — an unambiguous identity, unlike a backlog item's fuzzy
      // slug-number overlay below. So a worker self-completing its own task
      // while the container is still live (any state) is a correctable
      // contradiction, not just a warning: reopen it. "completed" is defined
      // as merge-done (container gone) only — see buildDispatchDesired.
      if (d.key.startsWith("#")) {
        ops.push({ op: "update", taskId: cur.taskId, subject: d.subject, status: d.status, description: d.description, activeForm: d.activeForm });
        continue;
      }
      // Backlog item overlay: non-destructive contradiction check only — the
      // W-NNN<->dispatch link is a slug-number coincidence, not identity, so
      // warn instead of silently trusting either side (W-027/W-032).
      if (d.dispatch.state !== "REPORTING" && d.dispatch.state !== "BLOCKED") {
        ops.push({ op: "warn", reason: "completed_but_in_flight", taskId: cur.taskId, dispatch: d.dispatch.num });
      }
      continue;
    }
    if (cur.status !== "completed" && (cur.subject !== d.subject || cur.status !== d.status)) {
      ops.push({ op: "update", taskId: cur.taskId, subject: d.subject, status: d.status, description: d.description, activeForm: d.activeForm });
    }
  }
  // A current MIRROR-OWNED task whose backlog item is gone = merged/removed →
  // complete it. Foreign tasks never entered curByKey above, so they can never
  // reach this loop and can never get a stray complete op.
  for (const t of current) {
    const k = keyOf(t.subject);
    if (k && !desiredKeys.has(k) && t.status !== "completed") ops.push({ op: "complete", taskId: t.taskId, subject: t.subject });
  }
  return { ops, foreign };
}

function renderMarkdown(desired: DesiredTask[]): string {
  const live = desired.filter((d) => d.status === "in_progress");
  const queued = desired.filter((d) => d.status === "pending");
  const line = (d: DesiredTask) => `- ${d.subject}`;
  return [
    `# Work mirror (derived from the control backlog + live dispatch — DEC-092)`,
    ``,
    `## Live work (${live.length})`,
    ...(live.length ? live.map(line) : ["- (none)"]),
    ``,
    `## Queue (${queued.length})`,
    ...(queued.length ? queued.map(line) : ["- (none)"]),
    ``,
    `_Mirror only — the control backlog is canonical. Re-run task_mirror.ts to refresh._`,
  ].join("\n");
}

// Sync the Status-Web queue source (runtime/backlog/pending.md) FROM the control
// backlog, so the Status Web ACTIVE/FUTURE QUEUE shows the same open work as the
// harness Task mirror. pending.md is read ONLY by the status display (buildQueue /
// dock_status) — NOT by dispatch — so regenerating it is display-only and safe.
function writePending(items: BacklogItem[], pendingPath: string): number {
  const rows = items.map((it, i) => {
    const title = shortTitle(it);
    const bp = it.blueprint ? it.blueprint.replace(/^.*\//, "").replace(/\.md$/, "") : "—";
    const role = (it.type === "research" || it.cls === "verify") ? "pm" : "worker";
    const dep = (it.cls === "ready" || it.cls === "ready·tdd") ? "—" : it.cls; // blocker/class for non-ready
    const task = `${it.id} ${title}`.replace(/\|/g, "/");
    return `| ${i + 1} | ${task} | ${bp} | ${it.milestone} | ${role} | ${dep} |`;
  });
  const body =
    `# Pending assignments\n\n` +
    `Queued work awaiting dispatch — GENERATED from the control backlog\n` +
    `(\`control/project_dashboard/backlog.md\`) by \`task_mirror.ts\` (DEC-092). Do NOT\n` +
    `edit by hand; re-run task_mirror to refresh. This file is read only by the status\n` +
    `display (Status Web / dock_status), never by dispatch.\n\n` +
    `| Order | Task | Blueprint | Milestone | Role | Depends on |\n` +
    `| ----- | ---- | --------- | --------- | ---- | ---------- |\n` +
    rows.join("\n") + "\n";
  writeFileSync(pendingPath, body, "utf8");
  return rows.length;
}

function main(): void {
  printHelpAndExitIfRequested(
    "task_mirror — reconcile the Task-list mirror against the control backlog (DEC-092).\n" +
    "usage: task_mirror --pm-id <id> [--project <path>] [--format ops|json] [--current <id>]\n" +
    "       [--include-dispatches] [--sync-pending]",
  );
  const pmId = arg("pm-id");
  const project = arg("project") ?? process.cwd();
  const format = arg("format") ?? "ops";
  if (!pmId) { console.error("task_mirror: --pm-id required"); process.exit(2); }
  const pmRoot = `${project}/__garelier/${pmId}`;
  g_bpDir = `${pmRoot}/control/blueprints`;
  const items = parseBacklog(`${pmRoot}/control/project_dashboard/backlog.md`);
  const live = liveDispatch(pmRoot);
  let desired = buildDesired(items, live);

  // --include-dispatches (W-040): also mirror one Task PER LIVE _dispatch<N>
  // container (owner/state visibility independent of the W-NNN<->slug
  // coincidence buildDesired's overlay above relies on). Opt-in — default
  // output is unchanged for an existing consumer of this script.
  if (process.argv.includes("--include-dispatches")) {
    desired = desired.concat(buildDispatchDesired(scanDispatches(pmRoot)));
  }

  // --sync-pending: regenerate the Status-Web queue source from the control
  // backlog so the Status Web ACTIVE/FUTURE QUEUE matches this mirror. Display-only
  // (pending.md is not read by dispatch), so it is safe. Composable with any format.
  if (format === "sync-pending" || process.argv.includes("--sync-pending")) {
    const n = writePending(items, `${pmRoot}/runtime/backlog/pending.md`);
    if (format === "sync-pending") { console.log(JSON.stringify({ synced: "runtime/backlog/pending.md", rows: n })); return; }
  }

  if (format === "markdown") { console.log(renderMarkdown(desired)); return; }
  if (format === "json") { console.log(JSON.stringify({ desired }, null, 2)); return; }
  // ops (default)
  const curPath = arg("current");
  let current: CurrentTask[] = [];
  if (curPath) { try { current = JSON.parse(readText(curPath)); } catch { current = []; } }
  const { ops, foreign } = diffOps(current, desired);
  console.log(JSON.stringify({ desired, ops, foreign }, null, 2));
}

if (import.meta.main) main();
