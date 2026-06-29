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

// The dispatchability class is the backlog's own `status` value (faithful
// pass-through), with `ready` refined by type / blueprint / Test discipline. The
// script does NOT guess a class from prose — if a class is wrong, fix the backlog
// `status` (the canonical field), not the script. The status vocabulary is
// extensible: a PM who sets status `gated` / `run` / `blueprint` / `design` sees
// exactly that.
type DispatchClass = string;

interface BacklogItem {
  id: string;            // W-NNN
  type: string;          // feature/bug/maintenance/research
  priority: string;      // high/normal
  status: string;        // ready/triage/deferred
  milestone: string;
  desc: string;
  blueprint: string | null;  // relative path or null
  cls: DispatchClass;
}

interface DesiredTask {
  key: string;           // the W-NNN (stable identity in the subject)
  subject: string;
  status: "pending" | "in_progress";
  description: string;
  activeForm: string;
}

interface CurrentTask { taskId: string; subject: string; status: string }
type Op =
  | { op: "create"; subject: string; description: string; activeForm?: string }
  | { op: "update"; taskId: string; subject?: string; status?: string; description?: string; activeForm?: string }
  | { op: "complete"; taskId: string; subject: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function readText(p: string): string { try { return readFileSync(p, "utf8"); } catch { return ""; } }

// --- parse the control backlog markdown table -----------------------------
// Row: | W-NNN | type | priority | status | owner | milestone | desc | accept | `path` |
function parseBacklog(path: string): BacklogItem[] {
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
function liveDispatch(pmRoot: string): Map<string, string> {
  // slug -> STATE (WORKING/REPORTING/BLOCKED)
  const m = new Map<string, string>();
  let entries: string[] = [];
  try { entries = readdirSync(pmRoot); } catch { return m; }
  for (const name of entries) {
    if (!/^_dispatch\d+$/.test(name)) continue;
    const state = readText(`${pmRoot}/${name}/STATE.md`);
    const slug = state.match(/^##\s*Current task[\s\S]*?\n\n.*?(\S+-\S+)/m)?.[1]
      ?? state.match(/-\s+(w\d+-[a-z0-9-]+|[a-z0-9]+(?:-[a-z0-9]+)+)/i)?.[1] ?? "";
    const st = state.match(/^##\s*Status\s*\n\s*\n\s*(\w+)/m)?.[1] ?? "";
    if (slug) m.set(slug, st);
  }
  return m;
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
function dispatchStateFor(it: BacklogItem, live: Map<string, string>): string | null {
  const num = it.id.replace(/^W-/i, "");
  for (const [slug, st] of live) {
    if (new RegExp(`(^|[^0-9])w0*${num}-`, "i").test(slug)) return st;
  }
  return null;
}

function buildDesired(items: BacklogItem[], live: Map<string, string>): DesiredTask[] {
  return items.map((it) => {
    const title = shortTitle(it);
    const dstate = dispatchStateFor(it, live);
    const dispatchable = it.cls === "ready" || it.cls === "ready·tdd";
    const subject = `${it.id}: ${title} [${it.cls}]`;
    const description =
      `Backlog: ${it.id} · ${it.type}/${it.priority}/${it.status}\n` +
      `Class: ${it.cls}${dispatchable ? " — dispatchable now" : " — see desc"}\n` +
      `Blueprint: ${it.blueprint ?? "—"}\n` +
      `Dispatch: ${dstate ? `in-flight (${dstate})` : "none"}\n` +
      `Notes: ${it.milestone}`;
    return {
      key: it.id,
      subject,
      status: dstate ? "in_progress" : "pending",
      description,
      activeForm: `Draining ${it.id} ${title}`,
    };
  });
}

// --- diff against the agent's current Task list ---------------------------
function keyOf(subject: string): string | null { return subject.match(/\bW-\d+/)?.[0] ?? null; }

function diffOps(current: CurrentTask[], desired: DesiredTask[]): Op[] {
  const ops: Op[] = [];
  const curByKey = new Map<string, CurrentTask>();
  for (const t of current) { const k = keyOf(t.subject); if (k) curByKey.set(k, t); }
  const desiredKeys = new Set(desired.map((d) => d.key));
  for (const d of desired) {
    const cur = curByKey.get(d.key);
    if (!cur) { ops.push({ op: "create", subject: d.subject, description: d.description, activeForm: d.activeForm }); continue; }
    if (cur.status !== "completed" && (cur.subject !== d.subject || cur.status !== d.status)) {
      ops.push({ op: "update", taskId: cur.taskId, subject: d.subject, status: d.status, description: d.description, activeForm: d.activeForm });
    }
  }
  // A current task whose backlog item is gone = merged/removed → complete it.
  for (const t of current) {
    const k = keyOf(t.subject);
    if (k && !desiredKeys.has(k) && t.status !== "completed") ops.push({ op: "complete", taskId: t.taskId, subject: t.subject });
  }
  return ops;
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
  const pmId = arg("pm-id");
  const project = arg("project") ?? process.cwd();
  const format = arg("format") ?? "ops";
  if (!pmId) { console.error("task_mirror: --pm-id required"); process.exit(2); }
  const pmRoot = `${project}/__garelier/${pmId}`;
  g_bpDir = `${pmRoot}/control/blueprints`;
  const items = parseBacklog(`${pmRoot}/control/project_dashboard/backlog.md`);
  const live = liveDispatch(pmRoot);
  const desired = buildDesired(items, live);

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
  const ops = diffOps(current, desired);
  console.log(JSON.stringify({ desired, ops }, null, 2));
}

main();
