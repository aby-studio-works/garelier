"use strict";
// Read-only Status Web Console client. Vanilla JS, no dependencies.
// All dynamic text is HTML-escaped before insertion (defense in depth).

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
async function getJson(path) {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(path + " -> " + r.status);
  return r.json();
}
function colorFor(state) {
  const s = String(state || "").toLowerCase();
  if (["idle", "passed", "merged", "supervised", "success", "green"].includes(s)) return "green";
  if (["working", "assigned", "reporting", "running", "active", "artisan", "dock", "blue"].includes(s)) return "blue";
  if (["reviewing", "rework", "blocked", "stale", "waiting", "yellow", "conflict"].includes(s)) return "yellow";
  if (["failed", "aborted", "error", "red"].includes(s)) return "red";
  return "gray";
}
function chip(text, color) { return '<span class="chip ' + (color || colorFor(text)) + '">' + esc(text) + "</span>"; }

// ---- Language: Japanese by DEFAULT; an EN/JP toggle (topbar) switches the
// description PROSE only — headings, labels, states and identifiers stay English.
function currentLang() { return localStorage.getItem("garelier-lang") === "en" ? "en" : "ja"; }
function L(en, ja) { return currentLang() === "ja" ? ja : en; }
function dsc(o) { return o ? esc(L(o.en, o.ja)) : ""; }  // bilingual {en,ja} -> escaped current-lang text
function timeAgo(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return sec + "s ago";
  const min = Math.round(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.round(min / 60);
  if (hr < 48) return hr + "h ago";
  return Math.round(hr / 24) + "d ago";
}
function compactNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "m";
  if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(v);
}
function signedNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v === 0) return "±0";
  return (v > 0 ? "+" : "") + compactNum(v);
}

const ROLE_DESC = {
  pm: { en: "Decisions, roadmap, lane choice, promote. Writes no code.",
        ja: "判断・ロードマップ・lane選択・promote。コードは書かない。" },
  dock: { en: "Dock lane control: dispatch / review / merge gate. Owns studio.",
        ja: "通常 lane の統制: dispatch / review / merge gate。studio を所有。" },
  artisan: { en: "Artisan lane: runs Dock+Worker+Scout+Smith+Librarian alone. satchel branch → Guardian → Observer → Artisan → studio.",
        ja: "artisan lane: Dock+Worker+Scout+Smith+Librarian を単独実行。satchel → Guardian → Observer → Artisan → studio。" },
  worker: { en: "Implementation. workbench branch. Passes Dock review / merge gate.",
        ja: "実装。workbench branch。Dock review/merge gate を通す。" },
  scout: { en: "Commit-free investigation. spyglass branch (ephemeral). PM commits the inspection.",
        ja: "非コミット調査。spyglass branch(ephemeral)。inspection を PM が commit。" },
  smith: { en: "Post-integration hardening / license / security. anvil branch.",
        ja: "統合後 hardening / license / security。anvil branch。" },
  librarian: { en: "External-info sync + internal standardization + runbooks + registry upkeep. shelf branch.",
        ja: "外部情報同期 + 内部規約化 + runbook化 + registry管理。shelf branch。" },
  observer: { en: "Independent read-only review / advice sidecar. Never commits or merges; runs in both lanes. verdict: PASS / PASS_WITH_NOTES / REWORK_RECOMMENDED / BLOCK / NO_OPINION.",
        ja: "独立 read-only レビュー / 助言 sidecar。commit / merge せず、両 lane で稼働。verdict: PASS / PASS_WITH_NOTES / REWORK_RECOMMENDED / BLOCK / NO_OPINION。" },
  guardian: { en: "Security gate (read-only). gavel branch (ephemeral). Turns P0 vuln / secret / license issues into a verdict. Does not merge.",
        ja: "セキュリティ・ゲート(read-only)。gavel branch(ephemeral)。P0 脆弱/secret/license を verdict 化。merge しない。" },
  concierge: { en: "External-operation executor. clipboard branch (local-only). PM decides / approves; Concierge runs promote merge / tag / push etc.",
        ja: "外部操作の実行役。clipboard branch(local-only)。PM が決定/承認、Concierge が promote merge・tag・push 等を実行。" },
};
// owner / purpose / lifetime. Namespace: garelier/<target-slug>/<pm_id>/… (all local-only, never pushed).
const BRANCH_DESC = {
  target: { en: "User-owned (default main). Garelier touches it only on explicit instruction. The landing branch for promote.",
        ja: "ユーザー所有(既定 main)。Garelier は明示指示時のみ触れる。promote の着地先。" },
  studio: { en: "Shared integration branch for both lanes. Branched from target, kept current via base-tracking. Promotes to target through PM approval and Concierge.",
        ja: "両 lane 共通の統合ブランチ。target から分岐し base-tracking で追従。PM 承認後に Concierge が target へ promote。" },
  workbench: { en: "Worker. One per assignment. Cut from studio at dispatch. Passes Dock review / merge gate.",
        ja: "Worker。assignment 1件ごと。dispatch 時に studio から cut。Dock review / merge gate を通す。" },
  anvil: { en: "Smith. One per post-studio-integration hardening task.",
        ja: "Smith。studio 統合後の hardening 1件ごと。" },
  shelf: { en: "Librarian. Standards / runbooks / registry updates. Cut from studio, via Dock review.",
        ja: "Librarian。規約・runbook・registry 更新。studio から cut、Dock review 経由。" },
  satchel: { en: "Artisan. artisan lane. Branched from studio and integrated into studio after gates.",
        ja: "Artisan。artisan lane。studio から分岐し gate 後に studio へ統合。" },
  spyglass: { en: "Scout. One per investigation (ephemeral). Cut from the studio tip at pickup, deleted at IDLE. Never commits.",
        ja: "Scout。調査1件ごと(ephemeral)。studio tip から pickup 時に cut、IDLE で削除。commit しない。" },
  monocle: { en: "Observer. One per review (ephemeral). Cut from the review-target tip, deleted at IDLE. Never commits.",
        ja: "Observer。レビュー1件ごと(ephemeral)。review対象 tip から cut、IDLE で削除。commit しない。" },
  gavel: { en: "Guardian. One per security gate (ephemeral). Cut from the review-target tip, deleted at IDLE. Never commits.",
        ja: "Guardian。セキュリティ・ゲート1件ごと(ephemeral)。review対象 tip から cut、IDLE で削除。commit しない。" },
  clipboard: { en: "Concierge. One per external operation (local work ticket). Executes the approved external op. Never pushed.",
        ja: "Concierge。外部操作1件ごと(local work ticket)。承認済み外部操作を実行。never pushed。" },
};

let AUTO = 5;
let CONFIG = null;
let nextRefreshAt = 0;
let refreshCountdownTimer = null;
let autoRefreshBusy = false;
const QUEUE_PAGE = { active: 0, future: 0 };
const REVEAL = { pm: false, path: false, lanTop: false, lanDashboard: false };
const TOPBAR_IDENTITY = { pmId: null, projectRoot: null };

// Routes that are navigable documents (own data, no live snapshot) — excluded
// from auto-refresh so the open file / scroll position is preserved.
const DOC_ROUTES = new Set(["files", "knowledge", "role-knowledge", "control", "guide", "flow"]);

async function render() {
  const route = (location.hash.replace(/^#\//, "") || "dashboard");
  document.querySelectorAll("#sidebar a").forEach((a) =>
    a.classList.toggle("active", a.getAttribute("href") === "#/" + route));
  const c = document.getElementById("content");
  try {
    if (route === "files") { c.innerHTML = await filesPage(); wireFiles(c); return; }
    if (route === "knowledge") { c.innerHTML = await knowledgePage(); wireKnowledge(c); renderMermaid(c); return; }
    if (route === "role-knowledge") { c.innerHTML = await roleKnowledgePage(); wireRoleKnowledge(c); return; }
    if (route === "control") { c.innerHTML = await controlPage(); renderMermaid(c); return; }
    if (route === "guide") { c.innerHTML = await docPage("web_console", "Guide"); renderMermaid(c); return; }
    if (route === "flow") { c.innerHTML = await docPage("pipeline_flow", "Flow — how work moves"); renderMermaid(c); return; }
    if (route === "dashboard") {
      const [snap, q, ov] = await Promise.all([getJson("/api/status"), getJson("/api/queue"), getJson("/api/overview")]);
      updateTopbar(snap);
      c.innerHTML = dashboardPage(snap, q.queue || {}, ov.overview || {});
      return;
    }
    if (route === "work") {
      const [snap, q, ov] = await Promise.all([getJson("/api/status"), getJson("/api/queue"), getJson("/api/overview")]);
      updateTopbar(snap);
      c.innerHTML = workPage(snap, q.queue || {}, ov.overview || {});
      return;
    }
    if (!pages[route]) {
      location.hash = "#/dashboard";
      return;
    }
    const snap = await getJson("/api/status");
    updateTopbar(snap);
    c.innerHTML = pages[route](snap);
  } catch (e) {
    c.innerHTML = '<p class="warn red">' + L("Failed to load: ", "読み込み失敗: ") + esc(e.message) + "</p>";
  }
}

// ---- Files: project tree + rendered file view ----
function treeHtml(node) {
  // node.children present for dirs; render dirs (collapsed) then files.
  let h = "<ul>";
  for (const ch of node.children || []) {
    if (ch.type === "dir") {
      h += '<li class="dir" data-path="' + esc(ch.path || ch.name) + '"><span class="tw">' +
        esc(ch.name) + "</span>" + treeHtml(ch) + "</li>";
    } else {
      h += '<li class="file" data-path="' + esc(ch.path) + '"><a class="file" data-path="' +
        esc(ch.path) + '">' + esc(ch.name) + "</a></li>";
    }
  }
  return h + "</ul>";
}
async function filesPage() {
  let tree;
  try { tree = (await getJson("/api/tree")).tree; }
  catch (e) { return "<h1>Files</h1><p class='warn red'>" + esc(e.message) + "</p>"; }
  return "<h1>Files</h1>" +
    '<div class="filterbar">' +
      '<input id="file-filter" type="search" autocomplete="off" spellcheck="false" ' +
        'placeholder="' + esc(L("Filter files: docs md", "ファイル絞り込み: docs md")) + '" ' +
        'aria-label="' + esc(L("Filter files by space-separated AND terms", "スペース区切り AND でファイルを絞り込み")) + '">' +
      '<button id="file-filter-clear" class="mini" type="button">' + esc(L("Clear", "クリア")) + "</button>" +
      '<span id="file-filter-count" class="muted"></span>' +
    "</div>" +
    '<p class="muted compact">' + L(
      "Space-separated partial matches are ANDed against the full path.",
      "スペース区切りの部分一致を full path に対して AND 検索します。") + "</p>" +
    "<div class=\"filespane\">" +
    '<div class="tree">' + treeHtml(tree) + "</div>" +
    '<div class="fileview muted" id="fileview">' + L("Select a file from the tree to view it.", "ツリーからファイルを選択すると表示します。") + "</div>" +
    "</div>";
}
function applyFileFilter(tree, raw, count) {
  const terms = String(raw || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const files = Array.from(tree.querySelectorAll("li.file"));
  let shown = 0;
  for (const li of files) {
    const path = String(li.getAttribute("data-path") || "").toLowerCase();
    const ok = terms.length === 0 || terms.every((t) => path.includes(t));
    li.hidden = !ok;
    if (ok) shown++;
  }
  const dirs = Array.from(tree.querySelectorAll("li.dir")).reverse();
  for (const li of dirs) {
    const hasVisibleFile = Array.from(li.querySelectorAll("li.file")).some((f) => !f.hidden);
    li.hidden = terms.length > 0 && !hasVisibleFile;
    if (terms.length > 0 && hasVisibleFile) li.classList.add("open");
  }
  if (count) count.textContent = terms.length ? (shown + " / " + files.length) : (files.length + "");
}
function wireFiles(container) {
  const tree = container.querySelector(".tree");
  if (!tree) return;
  const filter = container.querySelector("#file-filter");
  const clear = container.querySelector("#file-filter-clear");
  const count = container.querySelector("#file-filter-count");
  if (filter) {
    const run = () => applyFileFilter(tree, filter.value, count);
    filter.addEventListener("input", run);
    if (clear) clear.addEventListener("click", () => {
      filter.value = "";
      run();
      filter.focus();
    });
    run();
  }
  tree.addEventListener("click", (ev) => {
    const dir = ev.target.closest("li.dir > .tw");
    if (dir && tree.contains(dir)) { dir.parentElement.classList.toggle("open"); return; }
    const a = ev.target.closest("a.file");
    if (a && tree.contains(a)) {
      ev.preventDefault();
      tree.querySelectorAll("a.file.sel").forEach((x) => x.classList.remove("sel"));
      a.classList.add("sel");
      loadFile(a.getAttribute("data-path"));
    }
  });
}
async function loadFile(path, viewId) {
  const view = document.getElementById(viewId || "fileview");
  if (!view) return;
  view.classList.remove("muted");
  view.innerHTML = '<p class="muted">' + L("Loading ", "読み込み中: ") + esc(path) + "…</p>";
  try {
    const d = await getJson("/api/file?path=" + encodeURIComponent(path));
    if (!d.ok) { view.innerHTML = '<p class="warn red">' + esc(d.error || "error") + "</p>"; return; }
    let body;
    if (d.kind === "markdown") body = '<div class="md-body">' + d.html + "</div>"; // server-sanitized
    else if (d.kind === "text") body = "<pre>" + esc(d.text) + "</pre>";
    else if (d.kind === "binary") body = '<p class="muted">' + L("Binary file", "バイナリファイル") + " (" + (d.bytes || 0) + " bytes) — " + L("not shown.", "表示しません。") + "</p>";
    else if (d.kind === "too_large") body = '<p class="muted">' + L("File too large to view", "表示するには大きすぎるファイル") + " (" + (d.bytes || 0) + " bytes).</p>";
    else body = '<p class="muted">' + L("Unsupported.", "未対応です。") + "</p>";
    view.innerHTML = '<div class="path">' + esc(path) + "</div>" + body;
    renderMermaid(view);
  } catch (e) {
    view.innerHTML = '<p class="warn red">' + esc(e.message) + "</p>";
  }
}
// Render mermaid diagrams if the (vendored) library is present; otherwise the
// <pre class="mermaid"> blocks remain readable as diagram source.
function renderMermaid(scope) {
  try {
    if (window.mermaid && typeof window.mermaid.run === "function") {
      window.mermaid.run({ nodes: scope.querySelectorAll("pre.mermaid") });
    }
  } catch { /* leave source visible on render failure */ }
}

function revealButton(key, shown, enName, jaName) {
  return '<button class="mini reveal-toggle" type="button" data-reveal-key="' + esc(key) + '">' +
    esc(shown ? L("Hide " + enName, jaName + "非表示") : L("Show " + enName, jaName + "表示")) + "</button>";
}
function updateRevealButton(id, key, enName, jaName) {
  const btn = document.getElementById(id);
  if (btn) btn.textContent = REVEAL[key] ? L("Hide " + enName, jaName + "非表示") : L("Show " + enName, jaName + "表示");
}
function updateIdentityFields(next) {
  if (next) {
    if (next.pmId) TOPBAR_IDENTITY.pmId = next.pmId;
    if (next.projectRoot) TOPBAR_IDENTITY.projectRoot = next.projectRoot;
  }
  const pm = TOPBAR_IDENTITY.pmId || (CONFIG && CONFIG.pmId) || "?";
  const root = TOPBAR_IDENTITY.projectRoot || (CONFIG && CONFIG.projectRoot) || "—";
  const pmc = document.getElementById("pm-chip");
  if (pmc) {
    pmc.textContent = REVEAL.pm ? "pm: " + pm : "pm: hidden";
    pmc.className = "chip " + (REVEAL.pm ? "blue" : "gray");
  }
  const pp = document.getElementById("project-path");
  if (pp) {
    pp.textContent = REVEAL.path ? "path: " + root : "path: hidden";
    pp.title = REVEAL.path ? root : "";
  }
  updateRevealButton("pm-toggle", "pm", "PM", "PM");
  updateRevealButton("path-toggle", "path", "path", "path");
}

function updateTopbar(s) {
  const lane = s.lane || {};
  const activity = activitySummary(s, null);
  const laneChip = document.getElementById("lane-chip");
  laneChip.textContent = "lane: " + (lane.state || "unknown");
  laneChip.className = "chip " + colorFor(lane.state === "idle" ? "gray" : lane.state);
  const activityChip = document.getElementById("activity-chip");
  if (activityChip) {
    activityChip.textContent = "status: " + activity.label;
    activityChip.className = "chip " + activity.color;
  }
  updateIdentityFields({ pmId: s.pmId || null, projectRoot: s.projectRoot || (CONFIG && CONFIG.projectRoot) || null });
  updateRefreshNote();
}

function refreshIntervalMs() {
  return Math.max(2, AUTO) * 1000;
}
function updateRefreshNote() {
  const rn = document.getElementById("refresh-note");
  if (!rn) return;
  const full = Math.ceil(refreshIntervalMs() / 1000);
  const left = nextRefreshAt ? Math.max(1, Math.ceil((nextRefreshAt - Date.now()) / 1000)) : full;
  rn.textContent = "refresh " + left + "s";
}
function scheduleNextRefresh() {
  nextRefreshAt = Date.now() + refreshIntervalMs();
  updateRefreshNote();
}
function startRefreshCountdown() {
  scheduleNextRefresh();
  if (refreshCountdownTimer) clearInterval(refreshCountdownTimer);
  refreshCountdownTimer = setInterval(updateRefreshNote, 1000);
}

function firstWarning(s, kind) {
  return ((s && s.warnings) || []).find((w) => w.kind === kind) || null;
}
function seriousWarning(s) {
  const ws = (s && s.warnings) || [];
  return ws.find((w) => ["rate_limited", "failed_quality_gate", "stale_lane_lock"].includes(w.kind)) || ws[0] || null;
}
function rateLimitTail(w) {
  return w && w.message ? String(w.message).replace(/^Recent provider output looks rate-limited\/session-limited:\s*/i, "") : "";
}
function liveRoleCount(s) {
  const d = (s && s.driver) || {};
  return (((s && s.roles) || []).filter((r) => r.lease && r.lease.alive).length) + (d.inlineRole ? 1 : 0);
}
// DEC-057 dispatch mode has no headless driver process; "live" work shows up as
// roles mid-dispatch in STATE (s.dispatch.inProgress), not as alive pid leases.
// The dashboard must treat this as real activity so dispatch mode is visible.
function dispatchActiveCount(s) {
  return ((((s && s.dispatch) || {}).inProgress) || []).length;
}
// Shared dispatch-active STATE set — MUST stay identical to
// status_snapshot.ts DISPATCH_ACTIVE_STATES (same 8 states incl. the
// reviewer/rework states OBSERVING/CHECKING/REVIEWING/REWORK). A role is "active"
// under dispatch when its STATE is one of these — used by the roles rail, roles
// table, and Live work board so they agree with the backend Dispatch panel /
// Capacity / Concurrency. If you change one set, change the other.
const DISPATCH_ACTIVE_STATES = new Set(["ASSIGNED", "WORKING", "REWORK", "BLOCKED", "REVIEWING", "REPORTING", "OBSERVING", "CHECKING"]);
function isRoleActive(r) {
  return !!(r && ((r.lease && r.lease.alive) || DISPATCH_ACTIVE_STATES.has(String(r.state || "").toUpperCase())));
}
function firstInFlight(q) {
  return q && (q.inFlight || []).length ? q.inFlight[0] : null;
}
function activePending(q) {
  return q && q.activePending ? q.activePending : ((q && q.pending) || []);
}
function futurePending(q) {
  return q && q.futurePending ? q.futurePending : [];
}
function activeMilestoneLabel(q) {
  const names = q && Array.isArray(q.activeMilestones) && q.activeMilestones.length
    ? q.activeMilestones
    : (q && q.activeMilestone ? [q.activeMilestone] : []);
  if (!names.length) return "current milestone";
  if (names.length <= 2) return names.join(", ");
  return names.slice(0, 2).join(", ") + " +" + (names.length - 2);
}
function activityNext(s, q, label) {
  const x = firstInFlight(q);
  if (label === "BACKOFF") {
    return x ? L(
      `Next: wait for provider limit reset, then continue ${x.task} with ${x.agent || x.role || "the assigned role"}.`,
      `Next: provider limit resetを待ってから、${x.agent || x.role || "assigned role"} が ${x.task} を続行します。`,
    ) : L("Next: wait for provider limit reset, then resume the driver loop.", "Next: provider limit resetを待ってからdriver loopを再開します。");
  }
  if (label === "RETRYING") return L(
    "Next: wait for the active retry/probe to finish; a successful turn clears the rate-limit warning.",
    "Next: 実行中のretry/probe完了を待ちます。成功turnでrate-limit警告は解除されます。",
  );
  if (label === "GATE FAILED") {
    return x ? L(
      `Next: resolve the latest failed gate for ${x.task} (${x.agent || x.role || "assigned role"}), then rerun merge gate.`,
      `Next: ${x.task} (${x.agent || x.role || "assigned role"}) の最新 gate 失敗を直し、merge gateを再実行します。`,
    ) : L("Next: resolve the latest failed merge gate, then rerun it.", "Next: 最新のmerge gate失敗を直して再実行します。");
  }
  if (label === "PM ACTION") return L("Next: PM resolves the open question or blocked agent.", "Next: PMが未解決の質問またはblocked agentを解決します。");
  if (label === "ACTIVE") return L("Next: wait for the active role iteration to finish.", "Next: 実行中role iterationの完了を待ちます。");
  if (x) return L(
    `Next: continue ${x.task} with ${x.agent || x.role || "the assigned role"}.`,
    `Next: ${x.agent || x.role || "assigned role"} が ${x.task} を続行します。`,
  );
  if (q && activePending(q).length) return L(
    `Next: dispatch active/unblocked milestone work (${activeMilestoneLabel(q)}) when capacity and lane policy allow it.`,
    `Next: capacityとlane policyが許せば、active/unblocked milestone (${activeMilestoneLabel(q)}) のpending workをdispatchします。`,
  );
  if (q && futurePending(q).length) return L(
    `Next: clear the active/unblocked milestone gate (${activeMilestoneLabel(q)}) before dispatching held future milestone backlog.`,
    `Next: held future milestone backlog のdispatch前に、active/unblocked milestone gate (${activeMilestoneLabel(q)}) を解消します。`,
  );
  if (q && (q.pending || []).length) return L("Next: dispatch pending work when capacity and lane policy allow it.", "Next: capacityとlane policyが許せばpending workをdispatchします。");
  return L("Next: no immediate action detected.", "Next: 直近のactionは検出されていません。");
}
function activitySummary(s, q) {
  s = s || {};
  q = q || {};
  const d = s.driver || {}, mg = s.mergeGate || {}, pa = s.pmAction || {};
  const rl = firstWarning(s, "rate_limited");
  const failedGate = firstWarning(s, "failed_quality_gate") || (mg.state === "failed" ? { message: "merge gate failed" } : null);
  const live = liveRoleCount(s);
  const disp = dispatchActiveCount(s);
  // Driver-stopped is NOT a failure: dispatch mode (DEC-057) runs roles via an
  // interactive orchestrator with no headless driver. Rank by actual activity
  // and problems; the absence of a driver only becomes the headline when there
  // is genuinely nothing moving (handled as a gray IDLE at the end).
  let label = "CLEAR", color = "green", detail = L("No blocker detected.", "blocker は検出されていません。");
  if (rl && (live > 0 || disp > 0)) {
    label = "RETRYING"; color = "blue";
    const tail = rateLimitTail(rl);
    detail = L(
      "A provider limit was detected earlier, but a retry/probe is running now.",
      "以前provider limitを検出しましたが、現在はretry/probeが実行中です。",
    ) + (tail ? " " + tail : "");
  } else if (rl) {
    label = "BACKOFF"; color = "red";
    const tail = rateLimitTail(rl);
    detail = L("Provider session / usage limit is active.", "provider の session / usage limit を検出しています。") + (tail ? " " + tail : "");
  } else if (failedGate) {
    label = "GATE FAILED"; color = "red"; detail = failedGate.message || "merge gate failed";
  } else if (pa.needed) {
    label = "PM ACTION"; color = "red";
    detail = L(
      `${pa.blockedAgents || 0} blocked · ${pa.openQuestions || 0} questions · ${pa.inboxItems || 0} inbox`,
      `PM確認待ち: ${pa.blockedAgents || 0} blocked · ${pa.openQuestions || 0} questions · ${pa.inboxItems || 0} inbox`,
    );
  } else if (mg.state === "running") {
    label = "GATE RUNNING"; color = "blue"; detail = L("Merge gate is active.", "merge gate が実行中です。");
  } else if (disp > 0) {
    label = "DISPATCH"; color = "blue"; detail = L(
      `${disp} role(s) dispatched via the subagent orchestrator.`,
      `subagent orchestrator 経由で ${disp} 件の role を dispatch 中です。`);
  } else if (live > 0) {
    label = "ACTIVE"; color = "blue"; detail = L(`${live} live role session(s).`, `active role session は ${live} 件です。`);
  } else if ((q.inFlight || []).length > 0) {
    label = "WAITING"; color = "yellow";
    detail = L("Work is under review/reporting, but no provider process is live right now.", "作業はreview/reporting中ですが、現時点で稼働中のprovider processはありません。");
  } else if (activePending(q).length > 0) {
    label = "WAITING"; color = "yellow";
    detail = L(
      `Active/unblocked milestone work is queued (${activeMilestoneLabel(q)}); no live provider lease detected.`,
      `active/unblocked milestone (${activeMilestoneLabel(q)}) のworkがqueue中です。稼働中のprovider leaseは検出されていません。`,
    );
  } else if (futurePending(q).length > 0) {
    label = "WAITING"; color = "yellow";
    detail = L(
      `Held future milestone backlog is queued, but milestone/dependency gates hold dispatch until active work clears.`,
      `held future milestone backlog はqueue中ですが、milestone/dependency gate により active work 完了までdispatch保留です。`,
    );
  } else if (!d.running) {
    label = "IDLE"; color = "gray";
    detail = L(
      "No headless driver and no active dispatch. Start the driver, or dispatch roles via the orchestrator.",
      "headless driver も稼働中の dispatch もありません。driver を起動するか、orchestrator から role を dispatch してください。",
    );
  }
  const facts = [];
  facts.push(d.running ? `driver running${d.pid ? " pid " + d.pid : ""}` : (disp > 0 ? "dispatch mode (no driver)" : "driver stopped"));
  facts.push("last poll " + timeAgo(d.lastPollAt));
  if (d.inlineRole) facts.push(d.inlineRole + " inline");
  if (disp > 0) facts.push(disp + " dispatched");
  facts.push(live + " live role" + (live === 1 ? "" : "s"));
  facts.push("merge gate " + (mg.state || "idle"));
  facts.push("in-flight " + ((q.inFlight || []).length || 0));
  facts.push("pending " + ((q.pending || []).length || 0));
  return { label, color, detail, facts, next: activityNext(s, q, label) };
}
function activityStripHtml(s, q) {
  const a = activitySummary(s, q);
  return '<section class="activity-strip ' + a.color + '">' +
    '<div><div class="activity-state">' + esc(a.label) + '</div><div class="activity-detail">' + esc(a.detail) + '</div></div>' +
    '<div class="activity-facts">' + a.facts.map((f) => '<span class="fact">' + esc(f) + "</span>").join("") + "</div>" +
    '<div class="activity-next">' + esc(a.next) + "</div></section>";
}
function dashboardHealth(s, q) {
  const pa = s.pmAction || {}, d = s.driver || {}, mg = s.mergeGate || {};
  const rl = firstWarning(s, "rate_limited");
  const serious = seriousWarning(s);
  // Driver-stopped is not a failure in dispatch mode (DEC-057) — rank by real
  // activity/problems first; a missing driver only becomes the headline (gray
  // "Idle") when nothing is moving and nothing is queued.
  if (rl) {
    const tail = rl.message ? String(rl.message).replace(/^Recent provider output looks rate-limited\/session-limited:\s*/i, "") : "";
    return { label: "Rate limited", color: "red", detail: currentLang() === "ja"
      ? "provider の session / usage limit を検出しました。" + (tail ? " " + tail : "")
      : (rl.message || "Provider session limit detected.") };
  }
  if (serious && ["failed_quality_gate", "stale_lane_lock"].includes(serious.kind)) return { label: "Blocked", color: "red", detail: serious.message };
  if (pa.needed) return { label: "PM action needed", color: "red", detail: L(
    `${pa.blockedAgents || 0} blocked · ${pa.openQuestions || 0} questions · ${pa.inboxItems || 0} inbox`,
    `PM確認待ち: ${pa.blockedAgents || 0} blocked · ${pa.openQuestions || 0} questions · ${pa.inboxItems || 0} inbox`) };
  if (mg.state === "running") return { label: "Gate running", color: "blue", detail: L("Merge gate is active.", "merge gate が実行中です。") };
  const live = ((s.roles || []).filter((r) => r.lease && r.lease.alive).length) + ((d.inlineRole || "") ? 1 : 0);
  const disp = dispatchActiveCount(s);
  if (disp > 0) return { label: "Dispatch active", color: "blue", detail: L(
    `${disp} role(s) dispatched via the subagent orchestrator.`,
    `subagent orchestrator 経由で ${disp} 件の role を dispatch 中です。`) };
  if (live > 0) return { label: "Active", color: "blue", detail: L(`${live} live role session(s).`, `active role session は ${live} 件です。`) };
  if (serious) return { label: "Warning", color: "yellow", detail: serious.message };
  if ((q.pending || []).length > 0 || (q.inFlight || []).length > 0) return { label: "Waiting", color: "yellow", detail: L(
    "Work is queued or under review; no live provider lease detected.",
    "作業は queue または review 中です。稼働中の provider lease は検出されていません。") };
  if (!d.running) return { label: "Idle", color: "gray", detail: L(
    "No headless driver and no active dispatch. Start the driver, or dispatch via the orchestrator.",
    "headless driver も稼働中の dispatch もありません。driver を起動するか orchestrator から dispatch してください。") };
  return { label: "Clear", color: "green", detail: L("No blocker detected.", "blocker は検出されていません。") };
}
function accessLine() {
  const urls = (CONFIG && CONFIG.lanUrls) || [];
  if (urls.length) {
    const shown = REVEAL.lanDashboard;
    return '<div class="alertline green">' + chip("LAN", "green") + " " +
      (shown
        ? urls.map((u) => '<a class="link" href="' + esc(u) + '">' + esc(u) + "</a>").join(" · ")
        : L("hidden", "非表示")) +
      " " + revealButton("lanDashboard", shown, "LAN", "LAN") + "</div>";
  }
  const shown = REVEAL.lanDashboard;
  return '<div class="alertline yellow">' + chip("loopback", "yellow") + " " +
    (shown ? L(
        '127.0.0.1 only. For another PC on the same LAN, restart status web with <code>--lan</code> or <code>--host 0.0.0.0</code>.',
        '127.0.0.1 のみ。LAN 内の別PCから見るには status web を <code>--lan</code> または <code>--host 0.0.0.0</code> で再起動してください。')
      : L("hidden", "非表示")) +
    " " + revealButton("lanDashboard", shown, "LAN", "LAN") + "</div>";
}
function metricCard(k, v, sub) {
  return '<div class="hero-metric"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' +
    (sub ? '<div class="hero-sub">' + sub + '</div>' : '') + '</div>';
}
function roleRailHtml(roles) {
  let h = '<div class="rolerail">';
  for (const r of roles || []) {
    const active = isRoleActive(r); // lease alive OR dispatch-active STATE (DEC-057)
    const runner = [r.provider, r.model].filter(Boolean).join(" · ");
    // Hover shows the runner + WHAT the role is working on (STATE.md current task).
    const tip = [runner, r.task].filter(Boolean).join(" — ");
    h += '<span class="rolepill ' + (active ? "active" : "") + '"' + (tip ? ' title="' + esc(tip) + '"' : "") + '><span class="dot"></span>' +
      esc(r.kind) + (r.id ? ":" + esc(r.id) : "") + ' ' + chip(r.state || "?", active ? "blue" : colorFor(r.state)) + "</span>";
  }
  return h + "</div>";
}
function contextUsageHtml(oc) {
  const rows = (oc && oc.slotUsage) || [];
  if (!rows.length) return "<p class='muted'>" + L("No context usage yet.", "context usage はまだありません。") + "</p>";
  const kinds = ((oc && oc.finalActionKinds) || []).slice(0, 5)
    .map((x) => chip((x.kind || "?") + " " + (x.count || 0), x.kind === "no_action" ? "gray" : (x.kind === "coord_only" ? "yellow" : "blue")))
    .join(" ");
  let h = '<div class="ctxsummary">' +
    '<span><b>' + esc(compactNum(oc.totalIterations || 0)) + '</b> iter</span>' +
    '<span>avg prompt <b>' + esc(compactNum(oc.averagePromptBytes)) + '</b>B</span>' +
    '<span>prompt total <b>' + esc(compactNum(oc.totalPromptBytes || 0)) + '</b>B</span>' +
    (kinds ? '<span class="ctxkinds">' + kinds + '</span>' : '') +
    '</div>';
  const max = Math.max(1, ...rows.map((r) => r.contextTokens || 0));
  h += '<div class="ctxlist">';
  for (const r of rows.slice(0, 8)) {
    const ctx = r.contextTokens == null ? 0 : r.contextTokens;
    const pct = Math.max(2, Math.min(100, Math.round((ctx / max) * 100)));
    const delta = r.deltaContextTokens;
    const deltaClass = delta == null || delta === 0 ? "flat" : (delta > 0 ? "pos" : "neg");
    const label = r.label || r.id || r.role || "?";
    const title = [
      r.role,
      r.id ? "id " + r.id : null,
      r.provider,
      r.lastAt ? "last " + r.lastAt : null,
      r.outcome ? "outcome " + r.outcome : null,
      r.finalActionKind ? "final " + r.finalActionKind : null,
    ].filter(Boolean).join(" · ");
    h += '<div class="ctxrow" title="' + esc(title) + '"><div class="ctxlabel">' + esc(label) + '</div>' +
      '<div class="ctxbar"><span style="width:' + pct + '%"></span></div>' +
      '<div class="ctxmeta">ctx ' + esc(compactNum(r.contextTokens)) +
      ' <span class="ctxdelta ' + deltaClass + '">' + esc(signedNum(delta)) + '</span>' +
      ' · prompt ' + esc(compactNum(r.promptBytes)) + 'B' +
      ' · out ' + esc(compactNum(r.outputTokens)) +
      (r.finalActionKind ? ' · ' + chip(r.finalActionKind, r.finalActionKind === "no_action" ? "gray" : (r.finalActionKind === "coord_only" ? "yellow" : "blue")) : "") +
      ' · ' + esc(timeAgo(r.lastAt)) + '</div></div>';
  }
  return h + "</div><p class='muted'>" + L(
    "ctx is the last completed iteration's input + cache-read + cache-write tokens; delta is vs the previous completed iteration for that slot.",
    "ctx は直近完了iterationの input + cache-read + cache-write tokens。delta は同slotの前回完了iteration比です。") + "</p>";
}
// DEC-042: token efficiency at the user's FIXED model/effort (model is never a
// lever here). Shows how well the prompt cache absorbs the fixed per-iteration
// overhead and where tokens go, so "do more within capacity" is measurable.
function efficiencyHtml(eff) {
  eff = eff || {};
  if (!eff.totalIterations) return "<p class='muted'>" + L(
    "No headless-driver usage recorded. This panel aggregates the headless driver's per-iteration token log (runtime/driver/usage/*.jsonl); DEC-057/058 dispatch (subagent / codex exec) runs are NOT recorded here, so it stays empty in dispatch mode. Dispatch token totals come back on each subagent return (see the Dispatch activity panel).",
    "headless driver の usage 記録がありません。このパネルは headless driver の iteration 別トークンログ(runtime/driver/usage/*.jsonl)を集計します。DEC-057/058 の dispatch(subagent / codex exec)実行はここに記録されないため、dispatch モードでは空のままです。dispatch のトークンは各 subagent 完了時に返ります(Dispatch アクティビティ参照)。") + "</p>";
  const cachePct = eff.cacheHitRatio == null ? null : Math.round(eff.cacheHitRatio * 100);
  const kinds = (eff.actionKindMix || []).slice(0, 5)
    .map((x) => chip((x.kind || "?") + " " + (x.count || 0), x.kind === "no_action" ? "gray" : (x.kind === "coord_only" ? "yellow" : "blue")))
    .join(" ");
  let h = '<div class="ctxsummary">' +
    '<span><b>' + esc(compactNum(eff.totalIterations || 0)) + '</b> iter</span>' +
    '<span>avg in <b>' + esc(compactNum(eff.avgInputTokensPerIteration)) + '</b> tok</span>' +
    '<span>cache hit <b>' + (cachePct == null ? "—" : cachePct + "%") + '</b></span>' +
    '<span>$<b>' + esc((eff.totalCostUsd || 0).toFixed(2)) + '</b></span>' +
    (eff.latestMonth ? '<span class="muted">' + esc(eff.latestMonth) + '</span>' : '') +
    (kinds ? '<span class="ctxkinds">' + kinds + '</span>' : '') +
    '</div>';
  const rows = eff.topRolesByInputTokens || [];
  const max = Math.max(1, ...rows.map((r) => r.inputTokens || 0));
  h += '<div class="ctxlist">';
  for (const r of rows) {
    const v = r.inputTokens || 0;
    const pct = Math.max(2, Math.min(100, Math.round((v / max) * 100)));
    const label = (r.role || "?") + (r.id ? ":" + r.id : "");
    h += '<div class="ctxrow"><div class="ctxlabel">' + esc(label) + '</div>' +
      '<div class="ctxbar"><span style="width:' + pct + '%"></span></div>' +
      '<div class="ctxmeta">in ' + esc(compactNum(v)) +
      ' · $' + esc((r.costUsd || 0).toFixed(2)) +
      ' · ' + esc(compactNum(r.count)) + ' iter</div></div>';
  }
  h += '</div>';
  return h + "<p class='muted'>" + L(
    "Token efficiency at your configured model/effort (the model is not changed). 'avg in' = mean input + cache tokens per iteration; 'cache hit' = cache-read / (input + cache-read) — higher means the fixed prompt overhead is being reused.",
    "設定モデル/effort 固定でのトークン効率(モデルは変えません)。avg in = 1iterあたりの input + cache tokens 平均、cache hit = cache-read /(input + cache-read)。cache hit が高いほど固定プロンプトのオーバーヘッドが再利用されています。") + "</p>";
}
// DEC-057: dispatch activity for the subagent-orchestrator model. "In progress"
// = roles the orchestrator currently has out as subagents (live STATE), awaiting
// run-to-completion; "Recent" = the dispatch event log the orchestrator appends.
function dispatchKindColor(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "complete" || k === "merged" || k === "done") return "green";
  if (k === "start" || k === "assigned" || k === "dispatch") return "blue";
  if (k === "blocked" || k === "rework") return "yellow";
  if (k === "failed" || k === "aborted") return "red";
  return "gray";
}
function dispatchHtml(d) {
  d = d || {};
  const inProg = d.inProgress || [], recent = d.recent || [];
  let h = "";
  if (inProg.length) {
    h += '<div class="ctxsummary"><span><b>' + inProg.length + '</b> ' +
      L("in progress", "進行中") + '</span>';
    for (const p of inProg) {
      h += '<span>' + esc(p.role || "?") + ' ' + chip(p.state || "?", colorFor(p.state)) +
        (p.task ? ' <span class="muted">' + esc(String(p.task).slice(0, 60)) + '</span>' : '') + '</span>';
    }
    h += '</div>';
  } else {
    h += "<p class='muted'>" + L(
      "No subagent dispatch in progress (orchestrator idle at ~0 tokens).",
      "進行中の subagent dispatch はありません(orchestrator は ~0 トークンで待機)。") + "</p>";
  }
  if (recent.length) {
    h += '<table><tr><th>' + L("when", "時刻") + '</th><th>' + L("role", "ロール") +
      '</th><th>' + L("event", "イベント") + '</th><th>' + L("task", "タスク") + '</th></tr>';
    for (const e of recent) {
      const ref = e.ref
        ? " <a class='chip gray' data-open='" + esc(e.ref) + "'>" + L("artifact", "成果物") + "</a>"
        : "";
      h += "<tr><td class='muted'>" + esc(timeAgo(e.ts)) + "</td><td>" + esc(e.role || "?") +
        "</td><td>" + chip(e.kind || "note", dispatchKindColor(e.kind)) + "</td><td>" +
        esc(e.task ? String(e.task).slice(0, 80) : "—") + ref + "</td></tr>";
    }
    h += "</table>";
    if (d.eventsTotal && d.eventsTotal > recent.length) {
      h += "<p class='muted'>" + L("showing", "表示") + " " + recent.length + " / " + d.eventsTotal + "</p>";
    }
  } else {
    h += "<p class='muted'>" + L(
      "No dispatch events recorded yet (runtime/dispatch/events.jsonl).",
      "dispatch イベントの記録はまだありません(runtime/dispatch/events.jsonl)。") + "</p>";
  }
  return h;
}
// Repo-relative path to a role's container artifact (report.md if present is
// resolved via recentReports; this is the always-present STATE.md fallback) so a
// dispatch-mode Live work card is clickable even before a report exists.
const ROLE_CONTAINER = { worker: "_workers", scout: "_scouts", smith: "_smiths", observer: "_observers", guardian: "_guardians", librarian: "_librarians", concierge: "_concierges" };
function roleStateRel(s, r) {
  if (!s || !s.pmId || !r) return null;
  if (r.kind === "artisan") return "__garelier/" + s.pmId + "/_artisan/STATE.md";
  const d = ROLE_CONTAINER[r.kind];
  return (d && r.id) ? "__garelier/" + s.pmId + "/" + d + "/" + r.id + "/STATE.md" : null;
}
function compactPipeline(s, q, o) {
  o = o || {};
  const roles = s.roles || [], inFlight = q.inFlight || [], pending = activePending(q), future = futurePending(q);
  const roleById = {};
  for (const r of roles) if (r.id) roleById[(r.kind || "") + ":" + r.id] = r;
  const bpRel = {};
  for (const bp of (o.blueprints || [])) if (bp.rel) bpRel[bp.name] = bp.rel;
  const repRel = {};
  for (const r of (s.recentReports || [])) if (r.rel) repRel[(r.role || "") + ":" + (r.agentId || "")] = r.rel;
  const openAttr = (rel) => (rel ? " data-open='" + esc(rel) + "'" : "");
  const card = (task, sub, rel, live) => '<div class="taskcard ' + (live ? "live" : "") + (rel ? " clickable" : "") + '"' + openAttr(rel) +
    '><span class="t">' + esc(task) + '</span><span class="sub">' + esc(sub || "") + "</span></div>";
  const queued = pending.slice(0, 5).map((p) => card(p.task, [p.blueprint, p.milestone].filter(Boolean).join(" · "), bpRel[p.blueprint], false));
  if (pending.length > 5) queued.push('<div class="empty">+' + (pending.length - 5) + " more active</div>");
  const futureQueued = future.slice(0, 4).map((p) => card(p.task, [p.blueprint, p.milestone].filter(Boolean).join(" · "), bpRel[p.blueprint], false));
  if (future.length > 4) futureQueued.push('<div class="empty">+' + (future.length - 4) + " more future</div>");
  if (!futureQueued.length) {
    futureQueued.push('<div class="empty">' + L(
      "No later milestone backlog is queued. After the active/unblocked milestone queue clears, the next milestone starts here.",
      "後続milestone backlogは現在ありません。active/unblocked milestone queue が完了すると、次のmilestoneがここに表示されます。",
    ) + "</div>");
  }
  const working = [], review = [];
  const shownKeys = new Set();
  for (const x of inFlight) {
    const r = roleById[(x.role || "") + ":" + (x.agent || "")];
    const st = r ? String(r.state || "").toUpperCase() : "";
    const live = !!(r && r.lease && r.lease.alive);
    const rel = repRel[(x.role || "") + ":" + (x.agent || "")] || bpRel[x.blueprint];
    const html = card(x.task, [x.agent, x.blueprint, st].filter(Boolean).join(" · "), rel, live);
    shownKeys.add((x.role || "") + ":" + (x.agent || ""));
    if (["REVIEWING", "REPORTING", "OBSERVING", "CHECKING"].includes(st)) review.push(html);
    else working.push(html);
  }
  // DEC-057 dispatch mode: the driver queue's inFlight is empty (no headless
  // driver), so active work shows up only as non-idle role STATE. Surface those
  // roles here too — otherwise "Live work" looks empty while subagents are busy.
  for (const r of roles) {
    const st = String(r.state || "").toUpperCase();
    if (!r.id || !DISPATCH_ACTIVE_STATES.has(st)) continue;
    if (shownKeys.has((r.kind || "") + ":" + r.id)) continue; // already shown via inFlight
    const live = !!(r.lease && r.lease.alive);
    const rel = repRel[(r.kind || "") + ":" + r.id] || roleStateRel(s, r); // clickable: report if any, else STATE.md
    const label = r.task ? String(r.task).slice(0, 80) : ((r.kind || "role") + " " + r.id);
    const html = card(label, [r.id, st, "dispatch"].filter(Boolean).join(" · "), rel, live);
    if (["REVIEWING", "REPORTING", "OBSERVING", "CHECKING"].includes(st)) review.push(html);
    else working.push(html);
  }
  const mg = s.mergeGate || {};
  if (mg.state && mg.state !== "idle") review.push(card("merge gate", mg.state + (mg.pendingRequests ? " · req " + mg.pendingRequests : ""), null, mg.state === "running"));
  const done = [card("studio", `${q.doneCount || 0} merged`, null, false)];
  const col = (name, count, cards) =>
    '<div class="col"><div class="colhd"><span class="name">' + esc(name) + '</span><span class="count">' + count +
    "</span></div>" + (cards.length ? cards.join("") : '<div class="empty">—</div>') + "</div>";
  const board = (label, cols) =>
    '<div class="board-label">' + esc(label) + '</div><div class="board compact">' + cols.join("") + "</div>";
  // Two stacked rows so the queue is readable instead of squeezed onto the right:
  // top = what's moving NOW; bottom = what's waiting (pending + held).
  return board(L("In progress", "進行中"), [
      col("WORKING", working.length, working),
      col("REVIEW / GATE", review.length, review),
      col("DONE", q.doneCount || 0, done),
    ]) +
    board(L("Queue", "待ち行列"), [
      col("ACTIVE QUEUE", pending.length, queued),
      col("FUTURE QUEUE", future.length, futureQueued),
    ]);
}
function capacityTable(q) {
  const rows = q.capacity || [];
  if (!rows.length) return "<p class='muted'>" + L("No configured roles.", "設定済み role はありません。") + "</p>";
  let h = "<table class='compact-table'><tr><th>role</th><th>load</th><th></th></tr>";
  for (const c of rows) {
    const cap = c.configured || 0, used = c.inFlight || 0;
    const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : (used > 0 ? 100 : 0);
    const full = cap > 0 && used >= cap;
    h += "<tr><td>" + esc(c.role) + "</td><td style='width:170px'><div class='bar'><span class='fill" +
      (full ? "" : " in") + "' style='width:" + pct + "%'></span><span class='lbl'>" + used + " / " + (cap || "∞") +
      "</span></div></td><td>" + (full ? chip("full", "yellow") : "") + "</td></tr>";
  }
  return h + "</table>";
}
function pendingTable(title, items, emptyText, pageKey, bpRel) {
  items = items || [];
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(0, Math.min(QUEUE_PAGE[pageKey] || 0, pageCount - 1));
  const shown = items.slice(page * pageSize, (page + 1) * pageSize);
  let h = '<section class="surface"><h2>' + esc(title) + " (" + items.length + ")</h2>";
  if (!items.length) return h + "<p class='muted'>" + esc(emptyText) + "</p></section>";
  if (pageCount > 1) {
    h += '<div class="pager"><button type="button" data-queue-page="' + esc(pageKey) + '" data-page="' + (page - 1) + '"' +
      (page <= 0 ? " disabled" : "") + ">Prev</button><span>" +
      L("Page", "Page") + " " + (page + 1) + " / " + pageCount + "</span><button type=\"button\" data-queue-page=\"" +
      esc(pageKey) + '" data-page="' + (page + 1) + '"' + (page >= pageCount - 1 ? " disabled" : "") + ">Next</button></div>";
  }
  h += "<table><tr><th>pos</th><th>order</th><th>task</th><th>role</th><th>blueprint</th><th>milestone</th><th>depends on</th></tr>";
  shown.forEach((x, i) => {
    const rel = bpRel && x.blueprint ? bpRel[x.blueprint] : null;
    const bp = rel
      ? '<a class="link" href="#" data-open="' + esc(rel) + '">' + esc(x.blueprint || "") + "</a>"
      : esc(x.blueprint || "");
    h += "<tr><td class='posnum'>" + (page * pageSize + i + 1) + "</td><td>" + esc(x.order || "—") + "</td><td><b>" + esc(x.task) +
      "</b></td><td>" + chip(x.role || "?", "blue") + "</td><td>" + bp + "</td><td>" +
      esc(x.milestone || "") + "</td><td class='muted'>" + esc(x.dependsOn || "") + "</td></tr>";
  });
  return h + "</table></section>";
}
function queueDetailHtml(q, o) {
  if (!q || !q.present) return "<p class='muted'>" + L("No backlog yet.", "backlog はまだありません。") + "</p>";
  const bpRel = {};
  for (const bp of ((o && o.blueprints) || [])) if (bp.rel) bpRel[bp.name] = bp.rel;
  let h = '<div class="splitgrid"><section class="surface"><h2>Role capacity</h2>' + capacityTable(q) + '</section>';
  h += '<section class="surface"><h2>Tier congestion</h2><table class="compact-table"><tr><th>milestone</th><th>in-flight</th><th>pending</th></tr>';
  for (const t of q.tiers || []) h += "<tr><td>" + esc(t.name) + "</td><td>" + chip(String(t.inFlight), t.inFlight ? "blue" : "gray") +
    "</td><td>" + chip(String(t.pending), t.pending ? "yellow" : "gray") + "</td></tr>";
  h += "</table></section></div>";
  h += '<section class="surface"><h2>In-flight (' + (q.inFlight || []).length + ')</h2>';
  if (!(q.inFlight || []).length) h += "<p class='muted'>" + L("none", "なし") + "</p>";
  else {
    h += "<table><tr><th>task</th><th>agent</th><th>role</th><th>blueprint</th><th>milestone</th><th>dispatched</th></tr>";
    for (const x of q.inFlight) h += "<tr><td><b>" + esc(x.task) + "</b></td><td>" + esc(x.agent || "—") + "</td><td>" +
      chip(x.role || "?", "blue") + "</td><td>" + esc(x.blueprint || "") + "</td><td>" + esc(x.milestone || "") +
      "</td><td class='muted'>" + esc(x.dispatched || "") + "</td></tr>";
    h += "</table>";
  }
  h += "</section>";
  h += pendingTable("Active/unblocked milestone queue: " + activeMilestoneLabel(q), activePending(q), L("none", "なし"), "active", bpRel);
  h += pendingTable("Held future milestone queue", futurePending(q), L(
    "none — after the active/unblocked milestone queue clears, the next milestone starts here",
    "なし — active/unblocked milestone queue 完了後、次のmilestoneがここに表示されます",
  ), "future", bpRel);
  return h + "<p class='muted'>" + L("done", "done") + ": " + (q.doneCount || 0) + " · " + L("next id", "次の id") + ": " + (q.nextId == null ? "—" : "#" + q.nextId) + "</p>";
}
function dashboardPage(s, q, o) {
  const hstate = dashboardHealth(s, q);
  const lane = s.lane || {}, d = s.driver || {}, mg = s.mergeGate || {}, cc = s.concurrency || {};
  const pa = s.pmAction || {};
  let h = "<h1>Dashboard</h1>";
  h += activityStripHtml(s, q);
  h += '<div class="statushero">';
  h += '<div class="hero-main ' + hstate.color + '"><div class="hero-title">' + esc(hstate.label) + '</div><div class="hero-sub">' + esc(hstate.detail) + '</div>' +
    '<div class="dashboard-actions"><a class="chip blue" href="#/work">Work</a><a class="chip blue" href="#/reports">Reports</a><a class="chip blue" href="#/troubleshooting">Diagnostics</a></div></div>';
  {
    // "Execution" rather than "Driver": the headless driver is one path; the
    // other is dispatch mode (DEC-057, subagent orchestrator, no daemon). Show
    // whichever is active so a stopped driver in dispatch mode isn't read as broken.
    const disp = dispatchActiveCount(s);
    const execChip = d.running ? chip("driver", "blue") : (disp > 0 ? chip("dispatch", "blue") : chip("idle", "gray"));
    const execSub = d.running
      ? (d.pid ? "pid " + d.pid : "") + (d.inlineRole ? (d.pid ? " · " : "") + esc(d.inlineRole) + " inline" : "")
      : (disp > 0 ? disp + L(" dispatched", " 件 dispatch 中") : L("no driver / no dispatch", "driver/dispatch なし"));
    h += metricCard(L("Execution", "実行"), execChip, execSub);
  }
  h += metricCard("Lane", chip(lane.state || "idle", lane.state === "idle" ? "gray" : colorFor(lane.state)), lane.owner ? esc(lane.owner) : "");
  h += metricCard("Merge gate", chip(mg.state || "idle", colorFor(mg.state)), (mg.pendingRequests || 0) + " pending");
  {
    // Capacity is dispatch-aware: the driver's detached-pid count is 0 in
    // dispatch mode (no daemon), so fall back to the count of roles mid-dispatch
    // so a busy pipeline doesn't read as "0 / N".
    const disp = dispatchActiveCount(s);
    const alive = (cc.aliveDetached || 0) + (d.running ? 0 : disp);
    const capTxt = cc.cap ? String(cc.cap) : "∞"; // 0 = unlimited
    const capColor = (cc.cap && alive >= cc.cap) ? "yellow" : (alive > 0 ? "blue" : "gray");
    const sub = d.running ? L("agents alive / max", "稼働 / 最大") : L("dispatch active / max", "dispatch 稼働 / 最大");
    h += metricCard("Capacity", chip(alive + " / " + capTxt, capColor), sub);
  }
  h += "</div>";
  h += accessLine();
  h += holdBanner(s.dispatchHold);
  if (pa.needed) h += pmActionBlock(pa);
  if ((s.warnings || []).length) h += warningsBlock(s.warnings);
  h += '<section class="surface"><h2>Live work</h2>' + compactPipeline(s, q, o) + '</section>';
  h += '<div class="splitgrid"><section class="surface"><h2>Agents</h2>' + roleRailHtml(s.roles || []) +
    '<h2>Context by slot</h2>' + contextUsageHtml(s.outputControl) + '</section>';
  h += '<section class="surface"><h2>Recent reports</h2>' + reportsTable((s.recentReports || []).slice(0, 5)) + '</section></div>';
  h += '<section class="surface"><h2>' + L("Efficiency", "効率") + '</h2>' + efficiencyHtml(s.efficiency) + '</section>';
  h += '<section class="surface"><h2>' + L("Dispatch activity", "Dispatch アクティビティ") + '</h2>' + dispatchHtml(s.dispatch) + '</section>';
  return h;
}
function workPage(s, q, o) {
  let h = "<h1>Work</h1>";
  h += "<p class='muted'>" + L(
    "Execution follows roadmap → active/unblocked milestones → backlog items → phases. Garelier can run multiple milestones when their prerequisites allow it; future milestone backlog is visible, but held by milestone/dependency gates until opened.",
    "進行は roadmap → active/unblocked milestones → backlog item → phase の順です。前提条件が許せば複数milestoneを同時に進められます。future milestone backlog は表示しますが、milestone/dependency gate が開くまでdispatch保留です。") + "</p>";
  h += '<section class="surface"><h2>Execution flow</h2>' + compactPipeline(s, q, o) + roleRailHtml(s.roles || []) + "</section>";
  h += queueDetailHtml(q, o);
  const lane = s.lane || {};
  h += '<section class="surface"><h2>Lane</h2>';
  if (lane.taskId || lane.branch || lane.owner) {
    h += kvTable({ lane: lane.state, owner: lane.owner, task: lane.taskId, branch: lane.branch, target: lane.targetBranch, started: lane.startedAt, status: lane.status, stale: lane.stale ? "yes" : null });
  } else {
    h += "<p class='muted'>" + chip(lane.state || "idle", lane.state === "idle" ? "gray" : colorFor(lane.state)) + " — " +
      L("no lane lock held.", "lane lock は保持されていません。") + "</p>";
  }
  return h + "</section>";
}

const pages = {
  roles(s) {
    let h = "<h1>Roles</h1>" + rolesTable(s.roles);
    h += "<h2>Responsibilities</h2><table><tr><th>Role</th><th>Scope</th></tr>";
    for (const k of Object.keys(ROLE_DESC)) h += "<tr><td>" + esc(k) + "</td><td>" + dsc(ROLE_DESC[k]) + "</td></tr>";
    return h + "</table>";
  },
  branches(s) {
    const b = s.branches || {};
    let h = "<h1>Branches</h1>";
    h += kvTable({ target: b.target, studio: b.studio, active: b.activeBranch });
    h += "<p class='muted'>" + L(
      "All Garelier branches live under the <code>garelier/&lt;target-slug&gt;/&lt;pm_id&gt;/…</code> namespace and are " +
        "<b>local-only (never pushed)</b> — so several developers can use one repo at once. &lt;target-slug&gt; replaces the " +
        "target's <code>/</code> with <code>-</code> (e.g. develop/soft → develop-soft).",
      "全 Garelier ブランチは <code>garelier/&lt;target-slug&gt;/&lt;pm_id&gt;/…</code> 名前空間で、" +
        "<b>local-only(push しない)</b> — 同一 repo を複数開発者が同時に使えるため。&lt;target-slug&gt; は target の " +
        "<code>/</code> を <code>-</code> 化(例: develop/soft → develop-soft)。") + "</p>";
    h += "<h2>Branch families</h2><table><tr><th>Family</th><th>" + L("Owner · lifetime · purpose", "Owner · lifetime · 用途") + "</th></tr>";
    for (const k of Object.keys(BRANCH_DESC)) h += "<tr><td><b>" + esc(k) + "</b></td><td>" + dsc(BRANCH_DESC[k]) + "</td></tr>";
    h += "</table>";
    h += "<h2>Lifecycle</h2><ol>" + L(
      "<li><b>target</b> (default main) → Dock branches <b>studio</b> (kept current via base-tracking).</li>" +
        "<li>At dispatch, <b>workbench/#id</b> (Worker) is cut from studio. Scout/Observer/Guardian are ephemeral (spyglass/monocle/gavel — no commits, deleted at IDLE).</li>" +
        "<li>Worker/Smith/Librarian land in studio via the merge gate.</li>" +
        "<li>After explicit user instruction, PM approves the promote and Concierge merges studio into <b>target</b>. Without Concierge, promote is blocked.</li>" +
        "<li>The Artisan lane integrates <b>satchel/#id</b> into studio after Guardian and Observer.</li>",
      "<li><b>target</b>(既定 main)→ Dock が <b>studio</b> を分岐(base-tracking で追従)。</li>" +
        "<li>dispatch 時に studio から <b>workbench/#id</b>(Worker)を cut。Scout/Observer/Guardian は ephemeral(spyglass/monocle/gavel、commit せず IDLE で削除)。</li>" +
        "<li>Worker/Smith/Librarian が merge gate 経由で studio に着地。</li>" +
        "<li>ユーザーの明示指示後、PM が promote を承認し Concierge が studio を <b>target</b> に merge。Concierge がいなければ promote は BLOCK。</li>" +
        "<li>Artisan lane は Guardian / Observer 後に <b>satchel/#id</b> を studio へ統合。</li>") + "</ol>";
    h += "<p class='muted'>" + L("Live flow diagram", "動くフロー図") + ": <a class='link' href='#/flow'>Flow</a>.</p>";
    return h;
  },
  reports(s) { return "<h1>Reports</h1>" + reportsTable(s.recentReports); },
  routines(s) {
    const r = s.routines || [];
    if (!r.length) return "<h1>Routines</h1><p class='muted'>" + L(
      "No registered routines yet. The Librarian populates routine_registry.toml after standardizing repeatable work.",
      "登録済み routine はまだありません。Librarian が定型作業を標準化すると routine_registry.toml に登録されます。",
    ) + "</p>";
    let h = "<h1>Routines</h1><table><tr><th>id</th><th>title</th><th>default role</th><th>target</th><th>risk</th></tr>";
    for (const x of r) h += "<tr><td>" + esc(x.id) + "</td><td>" + esc(x.title || "") + "</td><td>" +
      chip(x.defaultRole || "?", "blue") + "</td><td>" + esc(x.targetFile || "") + "</td><td>" + esc(x.risk || "") + "</td></tr>";
    return h + "</table>";
  },
  sources(s) {
    const r = s.sources || [];
    if (!r.length) return "<h1>Sources</h1><p class='muted'>" + L(
      "No registered sources yet. The Librarian populates source_registry.toml after a source is approved for project knowledge.",
      "登録済み source はまだありません。project knowledge に採用する source が承認されると、Librarian が source_registry.toml に登録します。",
    ) + "</p>";
    let h = "<h1>Sources</h1><table><tr><th>id</th><th>kind</th><th>type</th><th>target</th><th>last synced</th><th>trust</th></tr>";
    for (const x of r) h += "<tr><td>" + esc(x.id) + "</td><td>" + esc(x.kind || "") + "</td><td>" + esc(x.sourceType || "") +
      "</td><td>" + esc(x.target || "") + "</td><td>" + esc(x.lastSyncedAt || "—") + "</td><td>" + esc(x.trust || "") + "</td></tr>";
    return h + "</table>";
  },
  troubleshooting(s) {
    let h = "<h1>Diagnostics</h1><p class='muted'>" + L(
      "Use this when the console looks idle or stuck. Check the warning surface first, then confirm lane, driver, merge gate, and role leases in that order.",
      "console が idle に見える、または止まって見える時に使います。まず warning を確認し、次に lane、driver、merge gate、role lease の順で見ます。") + "</p>" + warningsBlock(s.warnings);
    h += "<h2>Check order when stuck</h2><ol>" +
      "<li>Lane: " + esc((s.lane || {}).state) + " — " + L("artisan and dock are mutually exclusive; PM clears a stale lock.", "artisan と dock は排他。stale lock は PM が解除。") + "</li>" +
      "<li>Driver: " + ((s.driver || {}).running ? "running" : (dispatchActiveCount(s) > 0 ? "stopped (dispatch mode active)" : "stopped")) + "</li>" +
      "<li>Merge gate: " + esc((s.mergeGate || {}).state) + " (pending req " + ((s.mergeGate || {}).pendingRequests || 0) + ")</li>" +
      "<li>" + L("Role STATE / leases below.", "Role STATE / leases は下表。") + "</li></ol>";
    h += rolesTable(s.roles);
    return h;
  },
};

function kvTable(o) {
  let h = "<table>";
  for (const k of Object.keys(o)) h += "<tr><th>" + esc(k) + "</th><td>" + esc(o[k] == null ? "—" : o[k]) + "</td></tr>";
  return h + "</table>";
}
function rolesTable(roles) {
  roles = roles || [];
  let h = "<table><tr><th>role</th><th>slot id</th><th>provider</th><th>model</th><th>state</th><th>work</th><th>lease</th><th>branch</th></tr>";
  for (const r of roles) {
    // Lease is a DRIVER pid concept; under dispatch a role is active via STATE with
    // no pid. Show 'dispatch' when STATE is active and no live lease, so lease='—'
    // is not misread as "dead/idle" in dispatch mode.
    const lease = r.lease && r.lease.alive ? "alive(" + (r.lease.pid || "?") + ")"
      : (DISPATCH_ACTIVE_STATES.has(String(r.state || "").toUpperCase()) ? "— (dispatch)"
        : (r.lease ? "dead" : "—"));
    // What this role is actually working on: its STATE.md "Current task", else
    // the task #id from its branch (…/#<id>/<slug>), else —.
    const fromBranch = r.branch && /\/#(\d+)\//.test(r.branch) ? "#" + r.branch.match(/\/#(\d+)\//)[1] : null;
    const work = r.task || fromBranch || "—";
    h += "<tr><td>" + esc(r.kind) + "</td><td>" + esc(r.id || "—") + "</td><td>" + esc(r.provider || "—") +
      "</td><td>" + esc(r.model || "—") + "</td><td>" + chip(r.state) +
      "</td><td class='work'>" + esc(work) + "</td><td>" + esc(lease) + "</td><td class='branch'>" + esc(r.branch || "—") + "</td></tr>";
  }
  return h + "</table>";
}
function reportsTable(reports) {
  reports = reports || [];
  if (!reports.length) return "<p class='muted'>" + L("No recent reports.", "recent reports はありません。") + "</p>";
  let h = "<table><tr><th>role</th><th>updated</th><th>summary</th><th>path</th></tr>";
  for (const r of reports) {
    const open = r.rel ? " class='clickable' data-open='" + esc(r.rel) + "'" : "";
    h += "<tr" + open + "><td>" + esc(r.role) + "</td><td>" + esc(r.updatedAt || "—") +
      "</td><td class='summary'>" + esc(r.summary) + "</td><td class='path muted'>" + esc(r.path) + "</td></tr>";
  }
  return h + "</table><p class='muted'>" + L(
    "Click a row to open the full report (in-project reports whose rel resolves).",
    "行をクリックすると report 全文を表示します (rel が解決できる in-project report のみ)。") + "</p>";
}
// "PM action needed" surface: a red banner + table when a role is BLOCKED or
// raised a questions.md, plus the Dock→PM inbox review queue. Lets a watcher
// SEE that work is stuck awaiting a PM decision without reading runtime files.
function pmActionBlock(pa) {
  pa = pa || {};
  const items = pa.items || [];
  const acts = items.filter((i) => i.kind !== "inbox");
  const inbox = items.filter((i) => i.kind === "inbox");
  let h = "";
  if (pa.needed) {
    h += '<div class="warn red"><b>⚠ PM ACTION NEEDED</b> — ' +
      esc((pa.blockedAgents || 0) + " blocked agent(s), " + (pa.openQuestions || 0) + " open question(s)") +
      '. <span class="muted">' + L(
        "Review, then write the resolution to runtime/pm/resolutions/ (Dock relays answers.md).",
        "確認のうえ runtime/pm/resolutions/ に解決を書く (Dock が answers.md を中継)。") + "</span></div>";
  }
  if (acts.length) {
    h += "<table><tr><th>type</th><th>who</th><th>summary</th><th>since</th></tr>";
    for (const i of acts) {
      const open = i.rel ? " class='clickable' data-open='" + esc(i.rel) + "'" : "";
      h += "<tr" + open + "><td>" + chip(i.kind === "question" ? "question" : "blocked", "red") +
        "</td><td>" + esc((i.role || "") + (i.agentId ? " " + i.agentId : "")) + "</td><td>" + esc(i.summary) +
        "</td><td class='muted'>" + esc(i.since || "—") + "</td></tr>";
    }
    h += "</table>";
  }
  if (pa.inboxItems) {
    h += "<p>" + chip("PM inbox: " + pa.inboxItems, pa.needed ? "yellow" : "blue") +
      " <span class='muted'>" + L(
        "Dock → PM escalations / notices (recent; click a row for the full text):",
        "Dock → PM の escalation / 通知 (直近、行クリックで全文):") + "</span></p>";
    if (inbox.length) {
      h += "<table><tr><th>item</th><th>since</th></tr>";
      for (const i of inbox) {
        const open = i.rel ? " class='clickable' data-open='" + esc(i.rel) + "'" : "";
        h += "<tr" + open + "><td>" + esc(i.summary) + "</td><td class='muted'>" + esc(i.since || "—") + "</td></tr>";
      }
      h += "</table>";
    }
  }
  return h ? "<h2>PM action</h2>" + h : "";
}
// Dispatch HOLD banner: a watcher's first answer to "why is nothing moving?".
// A hold intentionally parks the backlog; without surfacing it an idle run reads
// as broken. Yellow (paused), not red (error). Clickable → opens the directive.
function holdBanner(hold) {
  if (!hold || !hold.active) return "";
  const sc = hold.scope ? esc(hold.scope) : "";
  const reason = esc(hold.reason || "dispatch hold in effect");
  const since = hold.issuedAt ? " <span class='muted'>(" + L("since ", "発行 ") + esc(hold.issuedAt) + ")</span>" : "";
  const open = hold.rel ? " class='warn clickable' data-open='" + esc(hold.rel) + "'" : ' class="warn"';
  const ex = sc || L("the milestone", "当該マイルストーン");
  return "<div" + open + "><b>⏸ " + L("DISPATCH HOLD", "DISPATCH HOLD（dispatch 保留）") + (sc ? " — " + sc : "") + "</b> " +
    L("The pipeline is intentionally paused — backlog work will NOT dispatch while this hold is in effect. ",
      "パイプラインは意図的に停止中 — この hold がある間 backlog は dispatch されません。") +
    "<b>" + L("To resume, just tell PM to lift the hold", "再開するには PM に解除を指示するだけです") +
    L(" — e.g. “resume " + ex + "”.", "（例:「" + ex + " を再開して」）。") + "</b>" +
    "<br><span class='muted'>" + reason + since + (hold.rel ? " — " + L("click to open the directive", "クリックで directive を開く") : "") + "</span></div>";
}
function warningsBlock(w) {
  w = w || [];
  if (!w.length) return "<p>" + chip("no warnings", "green") + "</p>";
  let h = "<h2>Warnings</h2>";
  for (const x of w) {
    const red = x.kind === "failed_quality_gate" || x.kind === "stale_lane_lock" || x.kind === "rate_limited";
    h += '<div class="warn' + (red ? " red" : "") + '">' + chip(x.kind, red ? "red" : "yellow") +
      " " + esc(x.message) + (x.path ? ' <span class="muted">(' + esc(x.path) + ")</span>" : "") + "</div>";
  }
  return h;
}
// ---- Bundled doc pages (Guide, Flow): server renders md → html ----
async function docPage(name, title) {
  try {
    const d = await getJson("/api/docs/" + name + "?lang=" + currentLang());
    if (!d.ok) return "<h1>" + esc(title) + "</h1><p class='muted'>" + esc(d.error || L("not available", "利用できません")) + "</p>";
    return "<h1>" + esc(title) + "</h1><div class=\"md-body\">" + d.html + "</div>"; // server-sanitized
  } catch (e) { return "<h1>" + esc(title) + "</h1><p class='warn red'>" + esc(e.message) + "</p>"; }
}

// ---- Knowledge: Librarian docs/garelier trees (tree + viewer pane) ----
async function knowledgePage() {
  let k;
  try { k = (await getJson("/api/knowledge")).knowledge; }
  catch (e) { return "<h1>Knowledge</h1><p class='warn red'>" + esc(e.message) + "</p>"; }
  const localNote = (kk) => {
    const l = kk && kk.local;
    if (!l) return "";
    return "<p class='muted'>" + chip("local-only", "gray") +
      " " + L("Librarian working area (not committed, DEC-038):", "Librarian working area (not committed, DEC-038):") + " raw " + (l.raw || 0) +
      " · cache " + (l.cache || 0) + " · drafts " + (l.drafts || 0) +
      " — " + L("under", "場所") + " <code>runtime/librarian/</code>, " +
      L("browse in", "閲覧は") + " <a class='link' href='#/files'>Files</a>.</p>";
  };
  if (!k || !k.present)
    return "<h1>Knowledge</h1><p class='muted'>" + L(
      "No Librarian knowledge trees under docs/garelier/ yet (tracked, DEC-029). They appear once the Librarian creates them.",
      "docs/garelier/ の Librarian ナレッジ木 (tracked) はまだありません (DEC-029)。Librarian が作成すると表示されます。") + "</p>" + localNote(k);
  let list = "";
  for (const cat of k.categories) {
    list += '<div class="kgroup"><div class="khd">' + esc(cat.category) + ' <span class="muted">(' + cat.docs.length + ")</span></div><ul>";
    for (const dnode of cat.docs) {
      const title = dnode.title ? " — " + dnode.title : "";
      list += '<li><a class="file" data-path="' + esc(dnode.rel) + '">' + esc(dnode.name) + "</a>" +
        '<span class="muted">' + esc(title) + "</span></li>";
    }
    list += "</ul></div>";
  }
  const graph = k.graph || {};
  let graphFindings = "";
  for (const f of graph.findings || []) {
    const open = f.rel ? " data-open='" + esc(f.rel) + "'" : "";
    graphFindings += '<div class="warn ' + (f.severity === "error" ? "red" : "") + ' clickable"' + open + ">" +
      chip(f.severity, f.severity === "error" ? "red" : "yellow") + " " + esc(f.code) + ": " + esc(f.message) + "</div>";
  }
  if (!graphFindings) graphFindings = "<p>" + chip("valid", "green") + " " + L("No knowledge-contract findings.", "knowledge contract の指摘はありません。") + "</p>";
  const graphHtml = "<h2>Knowledge graph</h2>" + graphFindings +
    "<div class='md-body'><pre class='mermaid'>" + esc(graph.mermaid || 'flowchart LR\n  empty["No graph"]') + "</pre></div>";
  const kfilter = '<div class="filterbar">' +
      '<input id="knowledge-filter" type="search" autocomplete="off" spellcheck="false" ' +
        'placeholder="' + esc(L("Filter knowledge: security policy", "ナレッジ絞り込み: security policy")) + '" ' +
        'aria-label="' + esc(L("Filter knowledge docs by space-separated AND terms", "スペース区切り AND でナレッジを絞り込み")) + '">' +
      '<button id="knowledge-filter-clear" class="mini" type="button">' + esc(L("Clear", "クリア")) + "</button>" +
      '<span id="knowledge-filter-count" class="muted"></span>' +
    "</div>";
  return "<h1>Knowledge</h1><p class='muted'>" + chip("tracked", "green") +
    " " + L("Librarian-maintained curated knowledge trees (committed, docs/garelier/). Click to view in full.",
            "Librarian 管理の curated 知識木 (committed, docs/garelier/)。クリックで全文表示。") + "</p>" +
    localNote(k) +
    kfilter +
    '<div class="filespane"><div class="tree">' + list + "</div>" +
    '<div class="fileview muted" id="fileview">' +
    L("Click an item on the left to view it in full.", "左の項目をクリックすると全文を表示します。") + "</div></div>" +
    graphHtml; // graph moved to the very bottom (user request)
}
function roleDocLinks(docs, emptyText) {
  if (!docs || !docs.length) return '<li class="muted">' + esc(emptyText) + "</li>";
  let h = "";
  for (const dnode of docs) {
    const title = dnode.title ? " — " + dnode.title : "";
    h += '<li><a class="file" data-path="' + esc(dnode.rel) + '">' + esc(dnode.rel) + "</a>" +
      '<span class="muted">' + esc(title) + "</span></li>";
  }
  return h;
}
async function roleKnowledgePage() {
  let k;
  try { k = (await getJson("/api/knowledge")).knowledge; }
  catch (e) { return "<h1>Role Knowledge</h1><p class='warn red'>" + esc(e.message) + "</p>"; }
  const ri = k && k.roleIndex;
  if (!ri || !ri.present)
    return "<h1>Role Knowledge</h1><p class='muted'>" + L(
      "No docs/garelier/knowledge/role_index.toml yet. The Librarian seeds it as the role-by-role reading index (DEC-048).",
      "docs/garelier/knowledge/role_index.toml はまだありません。Librarian がロール別 read index として seed します (DEC-048)。") + "</p>";

  let list = '<div class="kgroup"><div class="khd">role_index.toml ' + chip("index", "green") + "</div><ul>" +
    '<li><a class="file" data-path="' + esc(ri.rel || "") + '">' + esc(ri.rel || "role_index.toml") + "</a>" +
    '<span class="muted"> — ' + esc(L("authoritative role -> docs map", "ロール → docs の権威ある逆引き")) + "</span></li></ul></div>";
  for (const r of ri.roles || []) {
    const total = (r.readFirst || []).length + (r.onDemand || []).length;
    list += '<div class="kgroup"><div class="khd">' + esc(r.role) + " " +
      chip("read_first " + ((r.readFirst || []).length), "blue") + " " +
      chip("docs " + total, "gray") + "</div><ul>";
    if (r.note) list += '<li class="role-note muted">' + esc(r.note) + "</li>";
    if (r.unionOf && r.unionOf.length) list += '<li class="role-note muted">union_of: ' + esc(r.unionOf.join(", ")) + "</li>";
    list += '<li class="role-section">read_first</li>' +
      roleDocLinks(r.readFirst || [], L("No read_first files.", "read_first はありません。")) +
      '<li class="role-section">on_demand</li>' +
      roleDocLinks(r.onDemand || [], L("No on_demand files.", "on_demand はありません。"));
    if (r.missing && r.missing.length) {
      list += '<li class="role-section">missing</li>';
      for (const m of r.missing) list += '<li class="missing">' + esc(m) + "</li>";
    }
    list += "</ul></div>";
  }

  const err = ri.error ? '<p class="warn red">' + esc(ri.error) + "</p>" : "";
  return "<h1>Role Knowledge</h1><p class='muted'>" + chip("DEC-048", "green") +
    " " + L(
      "Role-by-role view of role_index.toml: what each role reads first, what it opens on demand, and the referenced file bodies.",
      "role_index.toml のロール別ビューです。各ロールが最初に読むもの、必要時に開くもの、参照先本文を確認できます。") + "</p>" +
    err +
    '<div class="filespane"><div class="tree">' + list + "</div>" +
    '<div class="fileview muted" id="fileview">' +
    L("Click role_index.toml or a referenced document on the left to view it in full.",
      "左の role_index.toml または参照 document をクリックすると全文を表示します。") + "</div></div>";
}
// Filter the curated knowledge tree by space-separated AND terms, matched
// against each doc's path + label. Hides empty category groups. Mirrors the
// Files filter but over the .kgroup/<li> structure the knowledge page uses.
function applyKnowledgeFilter(tree, raw, count) {
  const terms = String(raw || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const items = Array.from(tree.querySelectorAll(".kgroup li"));
  let shown = 0;
  for (const li of items) {
    const a = li.querySelector("a.file");
    const path = a ? String(a.getAttribute("data-path") || "") : "";
    const hay = (path + " " + li.textContent).toLowerCase();
    const ok = terms.length === 0 || terms.every((t) => hay.includes(t));
    li.hidden = !ok;
    if (ok) shown++;
  }
  for (const g of Array.from(tree.querySelectorAll(".kgroup"))) {
    const anyVisible = Array.from(g.querySelectorAll("li")).some((li) => !li.hidden);
    g.hidden = terms.length > 0 && !anyVisible;
    if (terms.length > 0 && anyVisible) g.classList.remove("closed");
  }
  if (count) count.textContent = terms.length ? (shown + " / " + items.length) : (items.length + "");
}
function wireKnowledge(container) {
  const tree = container.querySelector(".tree");
  if (!tree) return;
  const filter = container.querySelector("#knowledge-filter");
  const clear = container.querySelector("#knowledge-filter-clear");
  const count = container.querySelector("#knowledge-filter-count");
  if (filter) {
    const run = () => applyKnowledgeFilter(tree, filter.value, count);
    filter.addEventListener("input", run);
    if (clear) clear.addEventListener("click", () => { filter.value = ""; run(); filter.focus(); });
    run();
  }
  tree.addEventListener("click", (ev) => {
    const hd = ev.target.closest(".kgroup > .khd");
    if (hd && tree.contains(hd)) { hd.parentElement.classList.toggle("closed"); return; }
    const a = ev.target.closest("a.file");
    if (a && tree.contains(a)) {
      ev.preventDefault();
      tree.querySelectorAll("a.file.sel").forEach((x) => x.classList.remove("sel"));
      a.classList.add("sel");
      loadFile(a.getAttribute("data-path"), "fileview");
    }
  });
}
function wireRoleKnowledge(container) { wireKnowledge(container); }

async function controlPage() {
  let x;
  try { x = (await getJson("/api/control")).control; }
  catch (e) { return "<h1>Control</h1><p class='warn red'>" + esc(e.message) + "</p>"; }
  if (!x || !x.present) return "<h1>Control</h1><p class='muted'>" + L("No control tree.", "control tree はありません。") + "</p>";
  let counts = "";
  for (const k of Object.keys(x.counts || {}).sort()) counts += '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(x.counts[k]) + "</div></div>";
  let findings = "";
  for (const f of x.findings || []) {
    const open = f.rel ? " data-open='" + esc(f.rel) + "'" : "";
    findings += '<div class="warn ' + (f.severity === "error" ? "red" : "") + ' clickable"' + open + ">" +
      chip(f.severity, f.severity === "error" ? "red" : "yellow") + " " + esc(f.code) + ": " + esc(f.message) + "</div>";
  }
  if (!findings) findings = "<p>" + chip("valid", "green") + " " + L("No control-contract findings.", "control contract の指摘はありません。") + "</p>";
  let rows = "<table><tr><th>kind</th><th>status</th><th>title</th><th>path</th></tr>";
  for (const n of (x.nodes || []).filter((n) => n.rel)) {
    rows += "<tr class='clickable' data-open='" + esc(n.rel) + "'><td>" + esc(n.kind) + "</td><td>" +
      (n.status ? chip(n.status) : "—") + "</td><td>" + esc(n.title) + "</td><td class='path'>" + esc(n.rel) + "</td></tr>";
  }
  rows += "</table>";
  return "<h1>Control</h1><p class='muted'>" + esc(x.rootRel) + " · mode: " + esc(x.mode || "unknown") + "</p>" +
    '<div class="cards">' + counts + "</div><h2>Contract findings</h2>" + findings +
    "<h2>Artifacts</h2>" + rows +
    "<h2>Derived graph</h2><div class='md-body'><pre class='mermaid'>" + esc(x.mermaid) + "</pre></div>"; // graph at bottom (user request)
}

// ---- Modal file viewer (opened by any [data-open] element) ----
function ensureModal() {
  if (document.getElementById("modal")) return;
  const m = document.createElement("div");
  m.id = "modal"; m.hidden = true;
  m.innerHTML = '<div class="modal-back"></div><div class="modal-box">' +
    '<button class="modal-x" type="button" aria-label="Close">×</button>' +
    '<div class="modal-body fileview" id="modal-body"></div></div>';
  document.body.appendChild(m);
  m.querySelector(".modal-back").addEventListener("click", closeModal);
  m.querySelector(".modal-x").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
}
function closeModal() { const m = document.getElementById("modal"); if (m) m.hidden = true; }
async function openFileModal(path) {
  ensureModal();
  document.getElementById("modal").hidden = false;
  const body = document.getElementById("modal-body");
  body.innerHTML = '<p class="muted">' + L("Loading ", "読み込み中: ") + esc(path) + "…</p>";
  try {
    const d = await getJson("/api/file?path=" + encodeURIComponent(path));
    if (!d.ok) { body.innerHTML = '<p class="warn red">' + esc(d.error || "error") + "</p>"; return; }
    let inner;
    if (d.kind === "markdown") inner = '<div class="md-body">' + d.html + "</div>";
    else if (d.kind === "text") inner = "<pre>" + esc(d.text) + "</pre>";
    else if (d.kind === "binary") inner = '<p class="muted">' + L("Binary file", "バイナリファイル") + " (" + (d.bytes || 0) + " bytes).</p>";
    else if (d.kind === "too_large") inner = '<p class="muted">' + L(
      "File too large to view",
      "表示するには大きすぎるファイル") + " (" + (d.bytes || 0) + " bytes). " + L("Open it directly on disk.", "直接ディスク上で開いてください。") + "</p>";
    else inner = '<p class="muted">' + L("Unsupported.", "未対応です。") + "</p>";
    body.innerHTML = '<div class="path">' + esc(path) + "</div>" + inner;
    renderMermaid(body);
  } catch (e) { body.innerHTML = '<p class="warn red">' + esc(e.message) + "</p>"; }
}

// ---- Theme (light default; persisted) ----
function currentTheme() { return localStorage.getItem("garelier-theme") || "light"; }
function applyTheme(t) {
  document.documentElement.dataset.theme = (t === "dark" ? "dark" : "light");
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = (t === "dark" ? "☀" : "☾");
  try {
    if (window.mermaid && window.mermaid.initialize)
      window.mermaid.initialize({ startOnLoad: false, theme: t === "dark" ? "dark" : "neutral", securityLevel: "strict" });
  } catch { /* mermaid not vendored */ }
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  localStorage.setItem("garelier-theme", next);
  applyTheme(next);
  render(); // re-render so any mermaid diagram re-themes
}

// ---- Description language toggle (English default; persisted) ----
function applyLang() {
  document.documentElement.lang = currentLang() === "ja" ? "ja" : "en";
  const btn = document.getElementById("lang-toggle");
  if (btn) btn.textContent = currentLang() === "ja" ? "JP" : "EN";
  const footer = document.getElementById("footer");
  if (footer) footer.textContent = L(
    "Read-only · trusted LAN tool when bound with --lan / 0.0.0.0 · no AI tokens consumed by viewing.",
    "Read-only · --lan / 0.0.0.0 で trusted LAN 向け · 表示だけでは AI token を消費しません。");
  updateIdentityFields();
  if (CONFIG) showLanBar(CONFIG);
}
function toggleLang() {
  localStorage.setItem("garelier-lang", currentLang() === "ja" ? "en" : "ja");
  applyLang();
  render(); // re-render description prose (and re-fetch Guide/Flow in the new lang)
}

function showLanBar() {
  // Top LAN banner removed per operator request — the dashboard access line
  // (accessLine / lanDashboard) is the single LAN surface now.
  const bar = document.getElementById("lanbar");
  if (bar) bar.hidden = true;
}
async function boot() {
  applyTheme(currentTheme());
  applyLang();
  ensureModal();
  const tb = document.getElementById("theme-toggle");
  if (tb) tb.addEventListener("click", toggleTheme);
  const lb = document.getElementById("lang-toggle");
  if (lb) lb.addEventListener("click", toggleLang);
  // Any element with data-open opens that file in the modal viewer (reports,
  // blueprints, dashboard docs).
  document.body.addEventListener("click", (ev) => {
    const reveal = ev.target.closest("[data-reveal-key]");
    if (reveal) {
      ev.preventDefault();
      const key = reveal.getAttribute("data-reveal-key");
      if (Object.prototype.hasOwnProperty.call(REVEAL, key)) {
        REVEAL[key] = !REVEAL[key];
        updateIdentityFields();
        showLanBar(CONFIG);
        if (key === "lanDashboard") render();
      }
      return;
    }
    const pager = ev.target.closest("[data-queue-page]");
    if (pager) {
      ev.preventDefault();
      const key = pager.getAttribute("data-queue-page");
      const page = Number(pager.getAttribute("data-page"));
      if ((key === "active" || key === "future") && Number.isFinite(page) && page >= 0) {
        QUEUE_PAGE[key] = page;
        render();
      }
      return;
    }
    const o = ev.target.closest("[data-open]");
    if (o) { ev.preventDefault(); openFileModal(o.getAttribute("data-open")); }
  });
  try {
    const cfg = await getJson("/api/config");
    CONFIG = cfg;
    AUTO = cfg.autoRefreshSeconds || 5;
    showLanBar(cfg);
    // Topbar fields known at boot — so the header isn't stuck on placeholders
    // before the first dashboard snapshot arrives.
    updateIdentityFields({ pmId: cfg.pmId || null, projectRoot: cfg.projectRoot || null });
  } catch { /* defaults */ }
  startRefreshCountdown();
  await render();
  window.addEventListener("hashchange", () => {
    scheduleNextRefresh();
    render();
  });
  // Auto-refresh only the live dashboard pages; the document views (Files,
  // Knowledge, Role Knowledge, Guide, Flow) are navigable — re-rendering would
  // drop the open file / scroll position.
  setInterval(async () => {
    if (autoRefreshBusy) return;
    autoRefreshBusy = true;
    const route = (location.hash.replace(/^#\//, "") || "dashboard");
    try {
      if (!DOC_ROUTES.has(route)) await render();
    } finally {
      scheduleNextRefresh();
      autoRefreshBusy = false;
    }
  }, refreshIntervalMs());
}
boot();
