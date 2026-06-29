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
  if (["idle", "passed", "merged", "done", "supervised", "success", "green"].includes(s)) return "green";
  if (["working", "assigned", "reporting", "running", "active", "artisan", "dock", "blue"].includes(s)) return "blue";
  if (["reviewing", "rework", "blocked", "stale", "waiting", "yellow", "conflict"].includes(s)) return "yellow";
  if (["failed", "aborted", "error", "red"].includes(s)) return "red";
  return "gray";
}
function chip(text, color) { return '<span class="chip ' + (color || colorFor(text)) + '">' + esc(text) + "</span>"; }
// A control node's "status" may be long prose (e.g. a blueprint Status: line that
// carries a full paragraph), not a short keyword. Render only a short leading
// label as the chip and keep the full text in the title (hover) so the status
// column cannot stretch the table and hide the other columns.
function statusLabel(s) {
  let t = String(s == null ? "" : s).replace(/\*\*/g, "").replace(/[\r\n]+/g, " ").trim();
  t = t.split(/[(（]/)[0].trim();            // up to the first parenthesis
  if (!t) t = String(s).replace(/\*\*/g, "").trim();
  if (t.length > 22) t = t.slice(0, 21).trim() + "…";
  return t || "?";
}
function statusCell(s) {
  if (s == null || s === "") return "—";
  const label = statusLabel(s);
  return '<span class="chip ' + colorFor(label) + '" title="' + esc(String(s)) + '">' + esc(label) + "</span>";
}

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

// ---- Integrated navigation: 7 top-level views, sub-views as pill tabs.
// Legacy single-view routes remain as aliases so old bookmarks keep working.
const LEGACY_ROUTES = {
  roles: "work/agents",
  reports: "work/reports",
  "role-knowledge": "knowledge/roles",
  routines: "knowledge/routines",
  sources: "knowledge/sources",
  branches: "flow/branches",
  troubleshooting: "guide/diagnostics",
};
function parseRoute() {
  const full = (location.hash.replace(/^#\//, "") || "dashboard");
  const qIdx = full.indexOf("?");
  const raw = qIdx >= 0 ? full.slice(0, qIdx) : full;
  const query = qIdx >= 0 ? full.slice(qIdx + 1) : "";
  const parts = raw.split("/");
  const mapped = LEGACY_ROUTES[parts[0]];
  if (mapped) { const m = mapped.split("/"); return { base: m[0], sub: m[1] || "", query }; }
  return { base: parts[0], sub: parts[1] || "", query };
}
// Pill tab bar for a view's sub-pages. The default tab has key "" (base route).
function tabsHtml(base, tabs, active) {
  let h = '<div class="tabbar">';
  for (const t of tabs) {
    h += '<a href="#/' + esc(base) + (t.key ? "/" + esc(t.key) : "") + '"' +
      ((t.key || "") === (active || "") ? ' class="active"' : "") + ">" + esc(t.label) + "</a>";
  }
  return h + "</div>";
}
// Live views auto-refresh; document views (own data / scroll position) do not.
function isLiveRoute(base, sub) {
  if (base === "dashboard" || base === "work") return true;
  if (base === "guide") return sub === "diagnostics";
  return false;
}

async function render() {
  const { base: route, sub, query } = parseRoute();
  document.querySelectorAll("#sidebar a").forEach((a) =>
    a.classList.toggle("active", (a.getAttribute("href") || "").replace(/^#\//, "").split("/")[0] === route));
  const c = document.getElementById("content");
  try {
    if (route === "files") { c.innerHTML = await filesPage(); wireFiles(c); return; }
    if (route === "knowledge") {
      const tabs = [
        { key: "", label: "Curated" },
        { key: "roles", label: "By role" },
        { key: "lenses", label: "Lens" },
        { key: "routines", label: "Routines" },
        { key: "sources", label: "Sources" },
      ];
      const head = "<h1>Knowledge</h1>" + tabsHtml("knowledge", tabs, sub);
      if (sub === "routines" || sub === "sources" || sub === "lenses") {
        const snap = await getJson("/api/status");
        updateTopbar(snap);
        c.innerHTML = head + (sub === "routines" ? routinesSection(snap) : sub === "lenses" ? lensesSection(snap) : sourcesSection(snap));
        return;
      }
      if (sub === "roles") { c.innerHTML = head + (await roleKnowledgePage()); wireRoleKnowledge(c); return; }
      c.innerHTML = head + (await knowledgePage());
      wireKnowledge(c);
      renderMermaid(c);
      return;
    }
    if (route === "control") { c.innerHTML = await controlPage(); renderMermaid(c); return; }
    if (route === "guide") {
      const tabs = [
        { key: "", label: "Using Garelier" },
        { key: "console", label: "Console" },
        { key: "diagnostics", label: "Diagnostics" },
      ];
      const head = "<h1>Guide</h1>" + tabsHtml("guide", tabs, sub);
      if (sub === "diagnostics") {
        const snap = await getJson("/api/status");
        updateTopbar(snap);
        c.innerHTML = head + diagnosticsSection(snap);
        return;
      }
      if (sub === "console") {
        c.innerHTML = head + (await docPage("web_console"));
        renderMermaid(c);
        return;
      }
      c.innerHTML = head + (await docPage("using_garelier"));
      renderMermaid(c);
      return;
    }
    if (route === "flow") {
      const tabs = [
        { key: "", label: "Pipeline" },
        { key: "branches", label: "Branches" },
      ];
      const head = "<h1>" + esc(L("Flow — how work moves", "Flow — 作業の流れ")) + "</h1>" + tabsHtml("flow", tabs, sub);
      if (sub === "branches") {
        const snap = await getJson("/api/status");
        updateTopbar(snap);
        c.innerHTML = head + branchesSection(snap);
        return;
      }
      c.innerHTML = head + (await docPage("pipeline_flow"));
      renderMermaid(c);
      return;
    }
    if (route === "dashboard") {
      const [snap, q, ov] = await Promise.all([getJson("/api/status"), getJson("/api/queue"), getJson("/api/overview")]);
      updateTopbar(snap);
      c.innerHTML = dashboardPage(snap, q.queue || {}, ov.overview || {});
      return;
    }
    if (route === "work") {
      const [snap, q, ov, wf] = await Promise.all([getJson("/api/status"), getJson("/api/queue"), getJson("/api/overview"), getJson("/api/workflow")]);
      updateTopbar(snap);
      c.innerHTML = workPage(snap, q.queue || {}, ov.overview || {}, wf.workflow || {}, sub);
      // A "+N more active/future" link lands on the Queue tab focused on the
      // matching table, so the overflow items it counted are actually in view.
      // Strip the focus marker after scrolling so the periodic live refresh
      // (which re-renders this route) does not keep yanking the scroll back.
      const focus = /(?:^|&)focus=(active|future)/.exec(query || "");
      if (focus) {
        const el = document.getElementById("q-" + focus[1]);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        history.replaceState(null, "", "#/work/queue");
      }
      return;
    }
    location.hash = "#/dashboard";
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
      "Space-separated partial matches are ANDed against the full path. Click a file to open it in the viewer.",
      "スペース区切りの部分一致を full path に対して AND 検索します。ファイルをクリックするとビューワーで開きます。") + "</p>" +
    '<div class="tree">' + treeHtml(tree) + "</div>";
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
      openFileModal(a.getAttribute("data-path")); // modal viewer (no inline pane)
    }
  });
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
  return ws.find((w) => ["failed_quality_gate", "stale_lane_lock"].includes(w.kind)) || ws[0] || null;
}
// Under dispatch (DEC-057), "live" work shows up as
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
// Subset that is actually EXECUTING right now. BLOCKED (awaiting answers) and
// REPORTING (returned, awaiting review) are work inventory, not running
// producers — counting them made Capacity read "over cap" while idle.
const DISPATCH_EXEC_STATES = new Set(["ASSIGNED", "WORKING", "REWORK", "REVIEWING", "OBSERVING", "CHECKING"]);
function dispatchExecCount(s) {
  return ((((s && s.dispatch) || {}).inProgress) || [])
    .filter((p) => DISPATCH_EXEC_STATES.has(String(p.state || "").toUpperCase())).length;
}
function isRoleActive(r) {
  return !!(r && DISPATCH_ACTIVE_STATES.has(String(r.state || "").toUpperCase()));
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
  if (label === "GATE FAILED") {
    return x ? L(
      `Next: resolve the latest failed gate for ${x.task} (${x.agent || x.role || "assigned role"}), then rerun merge gate.`,
      `Next: ${x.task} (${x.agent || x.role || "assigned role"}) の最新 gate 失敗を直し、merge gateを再実行します。`,
    ) : L("Next: resolve the latest failed merge gate, then rerun it.", "Next: 最新のmerge gate失敗を直して再実行します。");
  }
  if (label === "PM ACTION") return L("Next: PM resolves the open question or blocked agent.", "Next: PMが未解決の質問またはblocked agentを解決します。");
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
  const mg = s.mergeGate || {}, pa = s.pmAction || {};
  const failedGate = firstWarning(s, "failed_quality_gate") || (mg.state === "failed" ? { message: "merge gate failed" } : null);
  const exec = dispatchExecCount(s);
  const disp = dispatchActiveCount(s);
  let label = "CLEAR", color = "green", detail = L("No blocker detected.", "blocker は検出されていません。");
  if (failedGate) {
    label = "GATE FAILED"; color = "red"; detail = failedGate.message || "merge gate failed";
  } else if (pa.needed) {
    label = "PM ACTION"; color = "red";
    detail = L(
      `${pa.blockedAgents || 0} blocked · ${pa.openQuestions || 0} questions · ${pa.inboxItems || 0} inbox`,
      `PM確認待ち: ${pa.blockedAgents || 0} blocked · ${pa.openQuestions || 0} questions · ${pa.inboxItems || 0} inbox`,
    );
  } else if (mg.state === "running") {
    label = "GATE RUNNING"; color = "blue"; detail = L("Merge gate is active.", "merge gate が実行中です。");
  } else if (exec > 0) {
    label = "DISPATCH"; color = "blue"; detail = L(
      `${exec} producer(s) executing via dispatch.`,
      `dispatch で ${exec} 件の producer が実行中です。`);
  } else if (disp > 0 || (q.inFlight || []).length > 0) {
    label = "WAITING"; color = "yellow";
    detail = L("Work is under review/reporting or awaiting PM action.", "作業は review/reporting 中、または PM 対応待ちです。");
  } else if (activePending(q).length > 0) {
    label = "READY"; color = "yellow";
    detail = L(
      `Active/unblocked milestone work is queued (${activeMilestoneLabel(q)}) — dispatch when ready.`,
      `active/unblocked milestone (${activeMilestoneLabel(q)}) のworkがqueue中です — dispatch 待ち。`,
    );
  } else if (futurePending(q).length > 0) {
    label = "READY"; color = "yellow";
    detail = L(
      `Held future milestone backlog is queued behind the milestone gate.`,
      `held future milestone backlog が milestone gate の後ろに並んでいます。`,
    );
  } else {
    label = "IDLE"; color = "gray";
    detail = L("Nothing executing and nothing queued.", "実行中・queue 中の作業はありません。");
  }
  const facts = [];
  facts.push(exec + L(" executing", " 実行中"));
  if (disp > exec) facts.push((disp - exec) + L(" in review/blocked", " review/blocked"));
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
  const pa = s.pmAction || {}, mg = s.mergeGate || {};
  const serious = seriousWarning(s);
  if (serious && ["failed_quality_gate", "stale_lane_lock"].includes(serious.kind)) return { label: "Blocked", color: "red", detail: serious.message };
  if (pa.needed) return { label: "PM action needed", color: "red", detail: L(
    `${pa.blockedAgents || 0} blocked · ${pa.openQuestions || 0} questions · ${pa.inboxItems || 0} inbox`,
    `PM確認待ち: ${pa.blockedAgents || 0} blocked · ${pa.openQuestions || 0} questions · ${pa.inboxItems || 0} inbox`) };
  if (mg.state === "running") return { label: "Gate running", color: "blue", detail: L("Merge gate is active.", "merge gate が実行中です。") };
  const exec = dispatchExecCount(s);
  if (exec > 0) return { label: "Dispatch active", color: "blue", detail: L(
    `${exec} producer(s) executing.`, `${exec} 件の producer が実行中です。`) };
  if (serious) return { label: "Warning", color: "yellow", detail: serious.message };
  if ((q.pending || []).length > 0 || (q.inFlight || []).length > 0) return { label: "Waiting", color: "yellow", detail: L(
    "Work is queued or under review — dispatch when ready.",
    "作業は queue または review 中です — 準備でき次第 dispatch してください。") };
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
function plantLine(s) {
  const p = s.plant || {};
  if (!p.mode || p.mode === "unknown") return "";
  const issues = p.issues || [];
  const hasErr = issues.some((x) => x.level === "error");
  const color = hasErr ? "red" : (p.mode === "crust" ? "blue" : "gray");
  const shown = REVEAL.path;
  const bits = [chip("plant:" + p.mode, color)];
  if (p.containerId) bits.push(chip("container:" + p.containerId, "blue"));
  if (issues.length) bits.push(chip(String(issues.length) + " issue" + (issues.length === 1 ? "" : "s"), hasErr ? "red" : "yellow"));
  if (shown) {
    bits.push('<span class="muted">control: ' + esc(p.controlRoot || "—") + '</span>');
    if (p.targetRoot && p.targetRoot !== p.controlRoot) bits.push('<span class="muted">target: ' + esc(p.targetRoot) + '</span>');
  } else {
    bits.push('<span class="muted">' + L("paths hidden", "path 非表示") + '</span>');
  }
  bits.push(revealButton("path", shown, "paths", "paths"));
  return '<div class="alertline ' + color + '">' + bits.join(" ") + "</div>";
}
function metricCard(k, v, sub) {
  return '<div class="hero-metric"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' +
    (sub ? '<div class="hero-sub">' + sub + '</div>' : '') + '</div>';
}
function roleRailHtml(s) {
  // Dispatch-native rail: Dock + live ephemeral producers + parked
  // inventory. Idle roster slots (driver-era config ghosts) are not "agents".
  let h = '<div class="rolerail">';
  h += '<span class="rolepill active"><span class="dot"></span>pm/dock ' + chip("dispatch", "blue") + "</span>";
  for (const p of (((s && s.dispatch) || {}).inProgress) || []) {
    const key = String(p.role || "");
    const live = DISPATCH_EXEC_STATES.has(String(p.state || "").toUpperCase());
    h += '<span class="rolepill ' + (live ? "active" : "") + '"' + (p.task ? ' title="' + esc(p.task) + '"' : "") + '><span class="dot"></span>' +
      esc(key) + ' ' + chip(p.state || "?", live ? "blue" : colorFor(p.state)) + "</span>";
  }
  for (const r of ((s && s.roles) || [])) {
    const st = String(r.state || "").toUpperCase();
    if (!r.id || ["IDLE", "DOCK", "NO_STATE", ""].includes(st)) continue;
    h += '<span class="rolepill"' + (r.task ? ' title="' + esc(r.task) + '"' : "") + '><span class="dot"></span>' +
      esc(r.kind) + ":" + esc(r.id) + ' ' + chip(st, "yellow") + "</span>";
  }
  return h + "</div>";
}
// DEC-057: dispatch activity for the subagent-dispatch model. "In progress"
// = roles the Dock currently has out as subagents (live STATE), awaiting
// run-to-completion; "Recent" = the dispatch event log the Dock appends.
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
      "No subagent dispatch in progress (the Dock idle at ~0 tokens).",
      "進行中の subagent dispatch はありません(Dock は ~0 トークンで待機)。") + "</p>";
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
  const _bd = (o.dashboards || []).find((d) => d.name === "backlog");
  const backlogRel = _bd ? _bd.rel : null;
  const repRel = {};
  for (const r of (s.recentReports || [])) if (r.rel) repRel[(r.role || "") + ":" + (r.agentId || "")] = r.rel;
  const openAttr = (rel) => (rel ? " data-open='" + esc(rel) + "'" : "");
  const card = (task, sub, rel, live) => '<div class="taskcard ' + (live ? "live" : "") + (rel ? " clickable" : "") + '"' + openAttr(rel) +
    '><span class="t">' + esc(task) + '</span><span class="sub">' + esc(sub || "") + "</span></div>";
  const queued = pending.slice(0, 5).map((p) => card(p.task, [p.blueprint, p.milestone].filter(Boolean).join(" · "), bpRel[p.blueprint] || backlogRel, false));
  if (pending.length > 5) queued.push('<a class="empty morelink" href="#/work/queue?focus=active">+' + (pending.length - 5) + " more active →</a>");
  const futureQueued = future.slice(0, 4).map((p) => card(p.task, [p.blueprint, p.milestone].filter(Boolean).join(" · "), bpRel[p.blueprint] || backlogRel, false));
  if (future.length > 4) futureQueued.push('<a class="empty morelink" href="#/work/queue?focus=future">+' + (future.length - 4) + " more future →</a>");
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
    const live = !!(r && DISPATCH_EXEC_STATES.has(st));
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
    const live = DISPATCH_EXEC_STATES.has(st);
    const rel = repRel[(r.kind || "") + ":" + r.id] || roleStateRel(s, r); // clickable: report if any, else STATE.md
    const label = r.task ? String(r.task).slice(0, 80) : ((r.kind || "role") + " " + r.id);
    const html = card(label, [r.id, st, "dispatch"].filter(Boolean).join(" · "), rel, live);
    if (["REVIEWING", "REPORTING", "OBSERVING", "CHECKING"].includes(st)) review.push(html);
    else working.push(html);
  }
  // Ad-hoc dispatch producers (__garelier/<pm>/_dispatch<N>/, jig/helper):
  // outside the roster, surfaced via s.dispatch.inProgress — without these the
  // board stayed empty while a jig tick was visibly merging work (operator
  // feedback: "Live work に #37 が出ない違和感").
  for (const pr of (((s.dispatch || {}).inProgress) || [])) {
    const key = String(pr.role || "");
    if (!/^dispatch\d+$/.test(key)) continue;            // roster entries already shown above
    if (shownKeys.has(key)) continue;
    shownKeys.add(key);
    const st = String(pr.state || "").toUpperCase();
    const rel = s.pmId ? "__garelier/" + s.pmId + "/_" + key + "/STATE.md" : null;
    const html = card(pr.task ? String(pr.task).slice(0, 80) : key, [key, st, "dispatch"].filter(Boolean).join(" · "), rel, st === "WORKING");
    if (["REVIEWING", "REPORTING", "OBSERVING", "CHECKING"].includes(st)) review.push(html);
    else working.push(html);
  }
  const mg = s.mergeGate || {};
  if (mg.state && mg.state !== "idle") review.push(card("merge gate", mg.state + (mg.pendingRequests ? " · req " + mg.pendingRequests : ""), null, mg.state === "running"));
  const done = [card("studio", `${q.doneCount || 0} merged`, null, false)];
  const col = (name, count, cards) =>
    '<div class="col"><div class="colhd"><span class="name">' + esc(name) + '</span><span class="count">' + count +
    "</span></div>" + (cards.length ? cards.join("") : '<div class="empty">—</div>') + "</div>";
  // No group label — each column already carries its own header (WORKING /
  // ACTIVE QUEUE / …) and the enclosing section is titled "Live work", so a
  // redundant "進行中 / 待ち行列" caption only overlaps the cards in front of it.
  const board = (cols) => '<div class="board compact">' + cols.join("") + "</div>";
  // Two stacked rows so the queue is readable instead of squeezed onto the right:
  // top = what's moving NOW; bottom = what's waiting (pending + held).
  return board([
      col("WORKING", working.length, working),
      col("REVIEW / GATE", review.length, review),
      col("DONE", q.doneCount || 0, done),
    ]) +
    board([
      col("ACTIVE QUEUE", pending.length, queued),
      col("FUTURE QUEUE", future.length, futureQueued),
    ]);
}
function pendingTable(title, items, emptyText, pageKey, bpRel, backlogRel) {
  items = items || [];
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(0, Math.min(QUEUE_PAGE[pageKey] || 0, pageCount - 1));
  const shown = items.slice(page * pageSize, (page + 1) * pageSize);
  let h = '<section class="surface" id="q-' + esc(pageKey) + '"><h2>' + esc(title) + " (" + items.length + ")</h2>";
  if (!items.length) return h + "<p class='muted'>" + esc(emptyText) + "</p></section>";
  if (pageCount > 1) {
    h += '<div class="pager"><button type="button" data-queue-page="' + esc(pageKey) + '" data-page="' + (page - 1) + '"' +
      (page <= 0 ? " disabled" : "") + ">Prev</button><span>" +
      L("Page", "Page") + " " + (page + 1) + " / " + pageCount + "</span><button type=\"button\" data-queue-page=\"" +
      esc(pageKey) + '" data-page="' + (page + 1) + '"' + (page >= pageCount - 1 ? " disabled" : "") + ">Next</button></div>";
  }
  h += "<table class='pendq'><tr><th>pos</th><th>order</th><th>task</th><th>role</th><th>blueprint</th><th>milestone</th><th>depends on</th></tr>";
  shown.forEach((x, i) => {
    const blueprintRel = bpRel && x.blueprint ? bpRel[x.blueprint] : null;
    const bp = blueprintRel
      ? '<a class="link" href="#" data-open="' + esc(blueprintRel) + '">' + esc(x.blueprint || "") + "</a>"
      : (backlogRel ? '<a class="link" href="#" data-open="' + esc(backlogRel) + '">' + esc(x.blueprint || "(backlog)") + "</a>" : esc(x.blueprint || ""));
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
  const _qbd = ((o && o.dashboards) || []).find((d) => d.name === "backlog");
  const backlogRel = _qbd ? _qbd.rel : null;
  let h = '<div class="splitgrid">';
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
  h += pendingTable("Active/unblocked milestone queue: " + activeMilestoneLabel(q), activePending(q), L("none", "なし"), "active", bpRel, backlogRel);
  h += pendingTable("Held future milestone queue", futurePending(q), L(
    "none — after the active/unblocked milestone queue clears, the next milestone starts here",
    "なし — active/unblocked milestone queue 完了後、次のmilestoneがここに表示されます",
  ), "future", bpRel, backlogRel);
  return h + "<p class='muted'>" + L("done", "done") + ": " + (q.doneCount || 0) + " · " + L("next id", "次の id") + ": " + (q.nextId == null ? "—" : "#" + q.nextId) + "</p>";
}
function dashboardPage(s, q, o) {
  const hstate = dashboardHealth(s, q);
  const lane = s.lane || {}, mg = s.mergeGate || {};
  const pa = s.pmAction || {};
  let h = "<h1>Dashboard</h1>";
  h += activityStripHtml(s, q);
  h += '<div class="statushero">';
  h += '<div class="hero-main ' + hstate.color + '"><div class="hero-title">' + esc(hstate.label) + '</div><div class="hero-sub">' + esc(hstate.detail) + '</div>' +
    '<div class="dashboard-actions"><a class="chip blue" href="#/work">Work</a><a class="chip blue" href="#/work/reports">Reports</a><a class="chip blue" href="#/guide/diagnostics">Diagnostics</a></div></div>';
  {
    const exec = dispatchExecCount(s);
    const execChip = exec > 0 ? chip("dispatch", "blue") : chip("idle", "gray");
    const execSub = exec > 0 ? exec + L(" executing", " 件実行中") : L("no producer executing", "実行中の producer なし");
    h += metricCard(L("Execution", "実行"), execChip, execSub);
  }
  h += metricCard("Lane", chip(lane.state || "idle", lane.state === "idle" ? "gray" : colorFor(lane.state)), lane.owner ? esc(lane.owner) : "");
  h += metricCard("Merge gate", chip(mg.state || "idle", colorFor(mg.state)), (mg.pendingRequests || 0) + " pending");
  {
    // Dispatch capacity: EXECUTING producers vs the jig fan-out cap.
    const exec = dispatchExecCount(s);
    const capJ = (CONFIG && CONFIG.jigFanOutCap) || null;
    const capTxt = capJ ? String(capJ) : "∞";
    const capColor = (capJ && exec >= capJ) ? "yellow" : (exec > 0 ? "blue" : "gray");
    h += metricCard("Capacity", chip(exec + " / " + capTxt, capColor),
      L("executing / jig fan-out cap", "実行中 / jig fan-out 上限"));
  }
  h += "</div>";
  h += accessLine();
  h += plantLine(s);
  h += holdBanner(s.dispatchHold);
  if (pa.needed) h += pmActionBlock(pa);
  if ((s.warnings || []).length) h += warningsBlock(s.warnings);
  h += '<section class="surface"><h2>Live work</h2>' + compactPipeline(s, q, o) + '</section>';
  h += '<section class="surface"><h2>Agents</h2>' + roleRailHtml(s) + '</section>';
  h += '<section class="surface"><h2>' + L("Dispatch activity", "Dispatch アクティビティ") + '</h2>' + dispatchHtml(s.dispatch) + '</section>';
  h += '<section class="surface"><h2>Recent reports</h2>' + reportsTable((s.recentReports || []).slice(0, 5)) + '</section>';
  return h;
}
// Work view: one integrated surface with Live / Queue / Agents / Reports tabs.
const WORK_TABS = [
  { key: "", label: "Live" },
  { key: "workflow", label: "Workflow" },
  { key: "queue", label: "Queue" },
  { key: "agents", label: "Agents" },
  { key: "reports", label: "Reports" },
];
function workPage(s, q, o, wf, sub) {
  let h = "<h1>Work</h1>" + tabsHtml("work", WORK_TABS, sub);
  if (sub === "workflow") return h + workflowSection(wf);
  if (sub === "queue") return h + workQueueSection(s, q, o);
  if (sub === "agents") return h + agentsSection(s);
  if (sub === "reports") return h + reportsSection(s);
  h += "<p class='muted'>" + L(
    "Execution follows roadmap → active/unblocked milestones → backlog items → phases. Garelier can run multiple milestones when their prerequisites allow it; future milestone backlog is visible, but held by milestone/dependency gates until opened.",
    "進行は roadmap → active/unblocked milestones → backlog item → phase の順です。前提条件が許せば複数milestoneを同時に進められます。future milestone backlog は表示しますが、milestone/dependency gate が開くまでdispatch保留です。") + "</p>";
  h += '<section class="surface"><h2>Execution flow</h2>' + compactPipeline(s, q, o) + roleRailHtml(s) + "</section>";
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
function workQueueSection(s, q, o) {
  return queueDetailHtml(q, o);
}
function workflowSection(wf) {
  wf = wf || {};
  const pkgs = wf.packages || [];
  let h = '<section class="surface"><h2>Pipeline packages</h2>';
  if (!wf.present || !pkgs.length) {
    return h + "<p class='muted'>" + L(
      "No blueprint Pipeline packages found yet. Legacy blueprints still use the older Dock routing path.",
      "Blueprint Pipeline packages はまだ見つかりません。旧形式 blueprint は従来のDock routingを使います。") + "</p></section>";
  }
  const counts = wf.counts || {};
  h += '<div class="ctxsummary">' +
    '<span>' + chip("planned " + (counts.planned || 0), "gray") + "</span>" +
    '<span>' + chip("active " + (counts.active || 0), "blue") + "</span>" +
    '<span>' + chip("blocked " + (counts.blocked || 0), "yellow") + "</span>" +
    '<span>' + chip("done " + (counts.done || 0), "green") + "</span>" +
    "</div>";
  h += "<table><tr><th>Package</th><th>Status</th><th>Role</th><th>Blueprint</th><th>Dispatch</th><th>Depends</th><th>Container</th><th>Artifacts</th></tr>";
  for (const p of pkgs) {
    const bp = p.blueprintRel
      ? '<a class="link" href="#" data-open="' + esc(p.blueprintRel) + '">' + esc(p.blueprint || p.blueprintRel) + "</a>"
      : esc(p.blueprint || "");
    const cont = p.container
      ? '<a class="link" href="#" data-open="' + esc((p.assignmentRel || p.reportRel || (p.container + "/STATE.md"))) + '">' + esc(p.container.split("/").slice(-2).join("/")) + "</a>"
      : "<span class='muted'>—</span>";
    const arts = [
      p.assignmentRel ? '<a class="chip gray" data-open="' + esc(p.assignmentRel) + '">assignment</a>' : "",
      p.reportRel ? '<a class="chip gray" data-open="' + esc(p.reportRel) + '">report</a>' : "",
    ].filter(Boolean).join(" ");
    const detail = (p.issues || []).length ? "<div class='muted'>" + esc(p.issues.join("; ")) + "</div>" :
      ((p.recentEvents || []).length ? "<div class='muted'>" + esc((p.recentEvents[0].kind || "event") + ": " + (p.recentEvents[0].task || "")) + "</div>" : "");
    h += "<tr><td><b>" + esc(p.packageId) + "</b><div class='muted'>" + esc(p.title || "") + "</div></td><td>" +
      chip(p.status || "planned", colorFor(p.status)) + (p.state ? "<div class='muted'>" + esc(p.state) + "</div>" : "") + "</td><td>" +
      chip(p.role || "?", "blue") + "</td><td>" + bp + "</td><td>" + esc(p.dispatch || "—") + "</td><td>" +
      esc((p.dependsOn || []).join(", ") || "—") + "</td><td>" + cont + "</td><td>" + (arts || "<span class='muted'>—</span>") + detail + "</td></tr>";
  }
  h += "</table></section>";
  const findings = wf.findings || [];
  if (findings.length) {
    h += '<section class="surface"><h2>Package findings</h2><table class="compact-table"><tr><th>severity</th><th>package</th><th>message</th><th>blueprint</th></tr>';
    for (const f of findings.slice(0, 40)) {
      h += "<tr><td>" + chip(f.severity || "warning", f.severity === "error" ? "red" : "yellow") + "</td><td>" +
        esc(f.packageId || "—") + "</td><td>" + esc(f.message || "") + "</td><td>" +
        (f.rel ? '<a class="link" href="#" data-open="' + esc(f.rel) + '">' + esc(f.rel) + "</a>" : "—") + "</td></tr>";
    }
    h += "</table></section>";
  }
  return h;
}
function agentsSection(s) {
  // Dispatch-native view (DEC-065/066): show what EXISTS — the Dock,
  // live ephemeral producers, and containers holding parked work. Roster rows
  // with provider/model/lease were driver-era config fiction and are gone.
  const roles = s.roles || [];
  let h = "";
  const dispatchSession = roles.find((r) => String(r.state || "").toLowerCase() === "dock" || r.kind === "pm");
  h += "<h2>" + L("Dock", "Dock") + "</h2><p>" +
    chip(dispatchSession ? (dispatchSession.kind === "pm" ? "pm" : "pm/dock") + (dispatchSession.id ? ":" + esc(dispatchSession.id) : "") : "pm", "blue") +
    " <span class='muted'>" + L("the interactive session — plans, dispatches, gates, integrates.",
      "対話セッション本体 — 計画・dispatch・ゲート・統合を行います。") + "</span></p>";
  const adhoc = (((s.dispatch || {}).inProgress) || []).filter((p) => /^dispatch\d+$/.test(String(p.role || "")));
  h += "<h2>" + L("Live producers (ephemeral)", "稼働中 producer（使い捨て）") + "</h2>";
  if (!adhoc.length) {
    h += "<p class='muted'>" + L("None running — producers exist only while a task executes (_dispatch<N>), and are cleaned up after merge.",
      "稼働なし — producer はタスク実行中のみ存在（_dispatch<N>）し、マージ後に片付けられます。") + "</p>";
  } else {
    h += "<table><tr><th>container</th><th>state</th><th>task</th></tr>";
    for (const p2 of adhoc) {
      const rel = s.pmId ? "__garelier/" + s.pmId + "/_" + esc(String(p2.role)) + "/STATE.md" : null;
      h += "<tr" + (rel ? " class='clickable' data-open='" + esc(rel) + "'" : "") + "><td>_" + esc(String(p2.role)) + "</td><td>" + chip(p2.state) + "</td><td class='work'>" + esc(p2.task || "—") + "</td></tr>";
    }
    h += "</table>";
  }
  const parked = roles.filter((r) => r.id && !["IDLE", "DOCK", "NO_STATE", ""].includes(String(r.state || "").toUpperCase()));
  h += "<h2>" + L("Parked inventory", "保留中の作業在庫") + "</h2>";
  if (!parked.length) {
    h += "<p class='muted'>" + L("None — no container holds unresolved work.", "なし — 未解決の作業を抱えたコンテナはありません。") + "</p>";
  } else {
    h += "<p class='muted'>" + L("Containers holding unresolved work (not running agents) — resolve or requeue via PM.",
      "未解決の作業が残っているコンテナです（稼働中のエージェントではありません）。PM が解決または requeue します。") + "</p>";
    h += "<table><tr><th>container</th><th>state</th><th>work</th><th>branch</th></tr>";
    for (const r of parked) {
      h += "<tr><td>" + esc(r.kind) + ":" + esc(r.id) + "</td><td>" + chip(r.state) + "</td><td class='work'>" + esc(r.task || "—") + "</td><td class='branch'>" + esc(r.branch || "—") + "</td></tr>";
    }
    h += "</table>";
  }
  h += "<h2>" + L("Role responsibilities (reference)", "ロールの責務（リファレンス）") + "</h2><table><tr><th>Role</th><th>Scope</th></tr>";
  for (const k of Object.keys(ROLE_DESC)) h += "<tr><td>" + esc(k) + "</td><td>" + dsc(ROLE_DESC[k]) + "</td></tr>";
  return h + "</table>";
}
function reportsSection(s) {
  return reportsTable(s.recentReports);
}
function branchesSection(s) {
    const b = s.branches || {};
    let h = "";
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
}
function routinesSection(s) {
  const r = s.routines || [];
  const note = "<p class='muted'>" + L(
    "Registered repeatable routines (routine_registry.toml). The Librarian populates it after standardizing repeatable work. Click a row to open its target/manual.",
    "登録済みの定型作業 (routine_registry.toml)。Librarian が定型作業を標準化すると登録されます。行をクリックで対象/手順を開きます。") + "</p>";
  let h = "<table class='ktable'><tr><th>id</th><th>" + L("Title", "タイトル") + "</th><th>" +
    L("Default role", "既定ロール") + "</th><th>" + L("Target", "対象") + "</th><th>risk</th></tr>";
  if (!r.length) h += "<tr><td colspan='5' class='muted'>" + L("No registered routines yet.", "登録済み routine はまだありません。") + "</td></tr>";
  for (const x of r) {
    const openRel = x.targetFileRel || x.manualRel || null; // backend-resolved repo-rel
    const open = openRel ? " class='clickable' data-open='" + esc(openRel) + "'" : "";
    h += "<tr" + open + "><td>" + esc(x.id) + "</td><td>" + esc(x.title || "") + "</td><td>" +
      chip(x.defaultRole || "?", "blue") + "</td><td class='path muted'>" + esc(x.targetFile || "") + "</td><td>" + esc(x.risk || "") + "</td></tr>";
  }
  return note + h + "</table>";
}
function sourcesSection(s) {
  const r = s.sources || [];
  const note = "<p class='muted'>" + L(
    "Registered knowledge sources (source_registry.toml). Click a repo-file source to view its target document.",
    "登録済みナレッジソース (source_registry.toml)。repo-file ソースは行クリックで対象 document を表示します。") + "</p>";
  let h = "<table class='ktable'><tr><th>id</th><th>" + L("Title", "タイトル") + "</th><th>kind</th><th>type</th><th>" +
    L("Target", "対象") + "</th><th>" + L("Last synced", "最終同期") + "</th><th>trust</th></tr>";
  if (!r.length) h += "<tr><td colspan='7' class='muted'>" + L("No registered sources yet.", "登録済み source はまだありません。") + "</td></tr>";
  for (const x of r) {
    const open = x.targetRel ? " class='clickable' data-open='" + esc(x.targetRel) + "'" : "";
    h += "<tr" + open + "><td>" + esc(x.id) + "</td><td>" + esc(x.title || "") + "</td><td>" + esc(x.kind || "") + "</td><td>" + esc(x.sourceType || "") +
      "</td><td class='path muted'>" + esc(x.target || "") + "</td><td>" + esc(x.lastSyncedAt || "—") + "</td><td>" + esc(x.trust || "") + "</td></tr>";
  }
  return note + h + "</table>";
}
function lensesSection(s) {
  const r = s.lenses || [];
  const note = "<p class='muted'>" + L(
    "Lens packs (lens_registry.toml under __garelier/__atmos). A lens changes a role's judgment focus only — never its authority, write paths, or contracts. Click a row to open its pack. Empty here means no lens registry is configured (lenses are opt-in).",
    "Lens packs(__garelier/__atmos の lens_registry.toml)。Lens は role の判断フォーカスだけを変え、権限・書込パス・contract は変えません。行クリックで pack を開きます。空欄は lens registry 未設定(Lens は opt-in)を意味します。") + "</p>";
  let h = "<table class='ktable'><tr><th>pack</th><th>role</th><th>group</th><th>status</th><th>" +
    L("Label", "ラベル") + "</th><th>" + L("Default", "既定") + "</th></tr>";
  if (!r.length) h += "<tr><td colspan='6' class='muted'>" + L("No lens registry configured.", "lens registry は未設定です。") + "</td></tr>";
  for (const x of r) {
    const open = x.packPathRel ? " class='clickable' data-open='" + esc(x.packPathRel) + "'" : "";
    h += "<tr" + open + "><td>" + esc(x.packId || "") + "</td><td>" + chip(x.role || "?", "blue") +
      "</td><td><b>" + esc(x.groupId || "") + "</b></td><td>" + esc(x.status || "") + "</td><td>" +
      esc(x.label || x.description || "") + "</td><td>" + (x.isDefault ? chip("default", "green") : "") + "</td></tr>";
  }
  return note + h + "</table>";
}
function diagnosticsSection(s) {
  let h = "<p class='muted'>" + L(
    "Use this when the console looks idle or stuck. Check the warning surface first, then lane, merge gate, and role STATE in that order.",
    "console が idle に見える、または止まって見える時に使います。まず warning を確認し、次に lane、merge gate、role STATE の順で見ます。") + "</p>" + warningsBlock(s.warnings);
  h += "<h2>Check order when stuck</h2><ol>" +
    "<li>Lane: " + esc((s.lane || {}).state) + " — " + L("artisan and dock are mutually exclusive; PM clears a stale lock.", "artisan と dock は排他。stale lock は PM が解除。") + "</li>" +
    "<li>Merge gate: " + esc((s.mergeGate || {}).state) + " (pending req " + ((s.mergeGate || {}).pendingRequests || 0) + ")</li>" +
    "<li>" + L("Role STATE below.", "Role STATE は下表。") + "</li></ol>";
  h += rolesTable(s.roles);
  return h;
}

function kvTable(o) {
  let h = "<table>";
  for (const k of Object.keys(o)) h += "<tr><th>" + esc(k) + "</th><td>" + esc(o[k] == null ? "—" : o[k]) + "</td></tr>";
  return h + "</table>";
}
function rolesTable(roles) {
  roles = roles || [];
  let h = "<table><tr><th>role</th><th>slot id</th><th>state</th><th>work</th><th>branch</th></tr>";
  for (const r of roles) {
    const fromBranch = r.branch && /\/#(\d+)\//.test(r.branch) ? "#" + r.branch.match(/\/#(\d+)\//)[1] : null;
    const work = r.task || fromBranch || "—";
    h += "<tr><td>" + esc(r.kind) + "</td><td>" + esc(r.id || "—") + "</td><td>" + chip(r.state) +
      "</td><td class='work'>" + esc(work) + "</td><td class='branch'>" + esc(r.branch || "—") + "</td></tr>";
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
    const red = x.kind === "failed_quality_gate" || x.kind === "stale_lane_lock";
    h += '<div class="warn' + (red ? " red" : "") + '">' + chip(x.kind, red ? "red" : "yellow") +
      " " + esc(x.message) + (x.path ? ' <span class="muted">(' + esc(x.path) + ")</span>" : "") + "</div>";
  }
  return h;
}
// ---- Bundled doc pages (Guide, Flow): server renders md → html ----
async function docPage(name) {
  try {
    const d = await getJson("/api/docs/" + name + "?lang=" + currentLang());
    if (!d.ok) return "<p class='muted'>" + esc(d.error || L("not available", "利用できません")) + "</p>";
    return '<div class="md-body">' + d.html + "</div>"; // server-sanitized
  } catch (e) { return "<p class='warn red'>" + esc(e.message) + "</p>"; }
}

// ---- Knowledge: Librarian knowledge trees (tree + viewer pane) ----
async function knowledgePage() {
  let k;
  try { k = (await getJson("/api/knowledge")).knowledge; }
  catch (e) { return "<p class='warn red'>" + esc(e.message) + "</p>"; }
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
    return "<p class='muted'>" + L(
      "No Librarian knowledge trees yet (tracked, DEC-029). They appear once the Librarian creates them.",
      "Librarian のナレッジ木 (tracked) はまだありません (DEC-029)。Librarian が作成すると表示されます。") + "</p>" + localNote(k);
  let rows = "";
  for (const cat of k.categories) {
    for (const dnode of cat.docs) {
      const layerChip = dnode.layer ? chip(dnode.layer === "pm" ? "pm" : "shared", dnode.layer === "pm" ? "blue" : "gray") : "";
      const overChip = dnode.overridden ? " " + chip("override", "yellow") : "";
      rows += "<tr class='krow clickable' data-open='" + esc(dnode.rel) + "'><td>" + esc(cat.category) +
        "</td><td><b>" + esc(dnode.name) + "</b>" + overChip + "</td><td>" + esc(dnode.title || "") +
        "</td><td>" + layerChip + "</td><td class='path muted'>" + esc(dnode.rel) + "</td></tr>";
    }
  }
  const table = "<table class='ktable'><tr><th>" + L("Category", "カテゴリ") + "</th><th>" +
    L("Document", "ドキュメント") + "</th><th>" + L("Title", "タイトル") + "</th><th>" +
    L("Layer", "レイヤー") + "</th><th>" + L("Path", "パス") + "</th></tr>" + rows + "</table>";
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
  return "<p class='muted'>" + chip("tracked", "green") +
    " " + L("Librarian-maintained curated knowledge trees (committed). Click a row to view it in full.",
            "Librarian 管理の curated 知識木 (committed)。行をクリックで全文表示。") + "</p>" +
    localNote(k) +
    knowledgeFilterBar() +
    table +
    graphHtml; // graph moved to the very bottom (user request)
}
async function roleKnowledgePage() {
  let k;
  try { k = (await getJson("/api/knowledge")).knowledge; }
  catch (e) { return "<p class='warn red'>" + esc(e.message) + "</p>"; }
  const ri = k && k.roleIndex;
  if (!ri || !ri.present)
    return "<p class='muted'>" + L(
      "No role_index.toml knowledge index yet. The Librarian seeds it as the role-by-role reading index (DEC-048).",
      "role_index.toml ナレッジ索引はまだありません。Librarian がロール別 read index として seed します (DEC-048)。") + "</p>";

  const baseName = (p) => String(p || "").split("/").pop();
  const layerChipOf = (d) => d.layer ? chip(d.layer === "pm" ? "pm" : "shared", d.layer === "pm" ? "blue" : "gray") : "";
  let rows = "";
  if (ri.rel) {
    rows += "<tr class='krow clickable' data-open='" + esc(ri.rel) + "'><td>—</td><td>" + chip("index", "green") +
      "</td><td><b>role_index.toml</b></td><td>" + esc(L("authoritative role → docs map", "ロール → docs の権威ある逆引き")) +
      "</td><td></td><td class='path muted'>" + esc(ri.rel) + "</td></tr>";
  }
  for (const r of ri.roles || []) {
    const notes = [];
    if (r.note) notes.push(esc(r.note));
    if (r.unionOf && r.unionOf.length) notes.push("union_of: " + esc(r.unionOf.join(", ")));
    if (notes.length) rows += "<tr class='krow'><td>" + esc(r.role) + "</td><td>" + chip("note", "gray") + "</td><td colspan='4' class='muted'>" + notes.join(" · ") + "</td></tr>";
    const emit = (docs, tierCell) => {
      for (const d of docs || []) {
        const overChip = d.overridden ? " " + chip("override", "yellow") : "";
        rows += "<tr class='krow clickable' data-open='" + esc(d.rel) + "'><td>" + esc(r.role) + "</td><td>" + tierCell +
          "</td><td><b>" + esc(baseName(d.rel)) + "</b>" + overChip + "</td><td>" + esc(d.title || "") +
          "</td><td>" + layerChipOf(d) + "</td><td class='path muted'>" + esc(d.rel) + "</td></tr>";
      }
    };
    emit(r.readFirst, chip("read_first", "blue"));
    emit(r.onDemand, chip("on_demand", "gray"));
    for (const m of r.missing || []) {
      rows += "<tr class='krow'><td>" + esc(r.role) + "</td><td>" + chip("missing", "red") +
        "</td><td colspan='4' class='path muted'>" + esc(m) + "</td></tr>";
    }
  }
  const table = "<table class='ktable ktable-roles'><tr><th>" + L("Role", "ロール") + "</th><th>" + L("Tier", "区分") +
    "</th><th>" + L("Document", "ドキュメント") + "</th><th>" + L("Title", "タイトル") + "</th><th>" +
    L("Layer", "レイヤー") + "</th><th>" + L("Path", "パス") + "</th></tr>" + rows + "</table>";

  const err = ri.error ? '<p class="warn red">' + esc(ri.error) + "</p>" : "";
  return "<p class='muted'>" +
    L(
      "Role-by-role view of role_index.toml: what each role reads first, what it opens on demand. Click a row to view the file in full.",
      "role_index.toml のロール別ビューです。各ロールが最初に読むもの、必要時に開くもの。行をクリックで全文表示。") + "</p>" +
    err +
    knowledgeFilterBar() +
    table;
}
// Shared filter bar markup for the knowledge tables (Curated + By role).
function knowledgeFilterBar() {
  return '<div class="filterbar">' +
      '<input id="knowledge-filter" type="search" autocomplete="off" spellcheck="false" ' +
        'placeholder="' + esc(L("Filter knowledge: security policy", "ナレッジ絞り込み: security policy")) + '" ' +
        'aria-label="' + esc(L("Filter knowledge docs by space-separated AND terms", "スペース区切り AND でナレッジを絞り込み")) + '">' +
      '<button id="knowledge-filter-clear" class="mini" type="button">' + esc(L("Clear", "クリア")) + "</button>" +
      '<span id="knowledge-filter-count" class="muted"></span>' +
    "</div>";
}
// Filter the knowledge table rows by space-separated AND terms, matched against
// each row's visible text + its data-open path. Hides non-matching rows.
function applyKnowledgeFilter(scope, raw, count) {
  const terms = String(raw || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const rows = Array.from(scope.querySelectorAll("tr.krow"));
  let shown = 0;
  for (const tr of rows) {
    const hay = (tr.textContent + " " + (tr.getAttribute("data-open") || "")).toLowerCase();
    const ok = terms.length === 0 || terms.every((t) => hay.includes(t));
    tr.hidden = !ok;
    if (ok) shown++;
  }
  if (count) count.textContent = terms.length ? (shown + " / " + rows.length) : (rows.length + "");
}
function wireKnowledge(container) {
  const table = container.querySelector("table.ktable");
  const filter = container.querySelector("#knowledge-filter");
  const clear = container.querySelector("#knowledge-filter-clear");
  const count = container.querySelector("#knowledge-filter-count");
  if (filter && table) {
    const run = () => applyKnowledgeFilter(table, filter.value, count);
    filter.addEventListener("input", run);
    if (clear) clear.addEventListener("click", () => { filter.value = ""; run(); filter.focus(); });
    run();
  }
  // Row clicks open the modal viewer via the global [data-open] delegation.
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
      statusCell(n.status) + "</td><td>" + esc(n.title) + "</td><td class='path'>" + esc(n.rel) + "</td></tr>";
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
    "Read-only · LAN-reachable by default (--loopback to restrict) · no AI tokens consumed by viewing.",
    "Read-only · 既定で LAN から閲覧可（--loopback で制限）· 表示だけでは AI token を消費しません。");
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
  // Auto-refresh only the live views (Dashboard, Work, Diagnostics); the
  // document views (Files, Knowledge, Control, Flow, Guide) are navigable —
  // re-rendering would drop the open file / scroll position.
  setInterval(async () => {
    if (autoRefreshBusy) return;
    autoRefreshBusy = true;
    const r = parseRoute();
    try {
      if (isLiveRoute(r.base, r.sub)) await render();
    } finally {
      scheduleNextRefresh();
      autoRefreshBusy = false;
    }
  }, refreshIntervalMs());
}
boot();
