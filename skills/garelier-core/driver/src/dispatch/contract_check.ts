// Garelier dispatch (W-022) — completion-contract checker for attended dispatch.
//
// Detective fix for the "run-to-completion subagent goes idle without satisfying
// its artifact contract" class (target-project live friction, 3+1 cases 2026-06-30..07-02):
// a producer subagent implements but never commits / leaves report.md as the
// template / leaves STATE at WORKING, or a gate role reviews but never writes its
// verdict report. In attended mode (PM drives producer/gate subagents by hand,
// no headless driver) there was no detector — the PM noticed by eye and nudged.
//
// This is that detector as ONE command. It never "fixes" anything: it verifies
// the artifacts a completed dispatch/gate MUST have produced and, when they are
// missing, emits a ready-to-paste Japanese nudge for SendMessage. It is the
// minimal cohesive fix (role_subagent_dispatch idle-check); Claude Code hook
// wiring / dispatch_watch changes / driver polling are deliberately out of scope.
//
// usage:
//   producer:   bun contract_check.ts --pm-id <id> [--project <root>] --dispatch <N>
//   gate:       bun contract_check.ts --pm-id <id> [--project <root>] --gate <slug> [--roles guardian,observer]
//   stall-scan: bun contract_check.ts --pm-id <id> [--project <root>] --stall-scan [--handoff <N>]
//               [--nudge-after <N-min>] [--handoff-after <M-min>]
//   [--format json|text]  (default json)
//
// producer/gate output: one line of JSON { ok, mode, violations:[{check,detail}], nudge }.
// exit 0 = contract satisfied, exit 3 = violation(s), exit 2 = usage error.
//
// --stall-scan (W-034) is the PM-attended-mode counterpart to the producer check
// above: instead of verifying ONE dispatch's return artifacts, it scans every
// live _dispatch<N>/ container for a producer that went idle mid-WORKING and
// tells the PM whether that idle notification is a false positive (a long cold
// build still running — DEC-091) or a genuine stall (nothing running, no
// progress). Confusing the two caused two live mis-diagnoses (W-027 2026-07-02,
// W-053 2026-07-03): a PM nudged/respawned a producer that was mid-build and
// fine, wasting a completed implementation. Output: one line of JSON
// { ok, mode:"stall-scan", items:[{dispatch,state,commits,dirty,dirty_hash,
// background,judgement,suggested_nudge,escalation,escalation_elapsed_min,
// escalation_prompt}] } (+ handoff_prompt when --handoff is given).
// ok=false iff at least one item is judgement="stall-suspect". exit 0/3 mirror
// that; exit 2 = usage error.
//
// escalation (W-037, stall-scan follow-up): a PM that must manually re-run
// --stall-scan and eyeball the judgement to notice a real stall does not scale
// — two live cases (target-project W-058/W-055, 2026-07-03) show a producer that
// backgrounded its gate and orphaned mid-WORKING with NOBODY watching for it,
// because a foreground instruction in the prompt (DEC-073) does not stop a
// subagent from doing it anyway. So every --stall-scan run persists a small
// judgement history per dispatch to `<pmRoot>/runtime/dispatch/
// stall_scan_history.json` (gitignored runtime) and, when the SAME dispatch is
// judged "stall-suspect" across scans with an UNCHANGED checkout diff (same
// `git status --porcelain` hash — i.e. genuinely no progress, not merely the
// same verdict), escalates: continuous >= --nudge-after minutes (default 10)
// sets `escalation:"nudge"` with an upgraded nudge string; continuous >=
// --handoff-after minutes (default 25) sets `escalation:"handoff"` with the
// same respawn-handoff prompt `--handoff <N>` produces. Any judgement other
// than "stall-suspect" (build-wait/unknown) resets that dispatch's history —
// this only fires on sustained, unambiguous idleness. Nothing here sends a
// message; it only raises the signal a PM (or the jig_tick automation that
// already runs --stall-scan every tick, mode_e_jig.md) already reads.
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";

// ── git seam (Bun.spawnSync pattern, mirrors branch_gc.ts) ──────────────────
export type GitRunner = (args: string[], cwd: string) => { code: number; stdout: string };
const defaultGitRunner: GitRunner = (args, cwd) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, stdout: r.stdout ? r.stdout.toString() : "" };
};

export interface Violation { check: string; detail: string; }
export interface ContractResult {
  ok: boolean;
  mode: "producer" | "gate";
  violations: Violation[];
  nudge: string;
}

// Canonical verdict tokens a gate report's `## Verdict` section must carry
// (Observer + Guardian union; FAIL retained for legacy/other gate roles).
export const VERDICT_TOKENS = [
  "PASS_WITH_NOTES", // must precede PASS so token match is not shadowed
  "REWORK_RECOMMENDED",
  "NO_OPINION",
  "PASS",
  "BLOCK",
  "FAIL",
] as const;

// Placeholder markers written verbatim by dispatch_prepare.sh into report.md.
// Their presence proves the producer never overwrote the scaffold (case 3).
const REPORT_PLACEHOLDERS = [
  "(REPORTING | BLOCKED)",
  "(what changed and why",
  "(commands run + results)",
  "(red->green proof",
] as const;

// ── producer mode ───────────────────────────────────────────────────────────
// A dispatched producer that has finished MUST have: STATE.md at REPORTING or
// BLOCKED, at least one commit past base_sha on its checkout branch (unless
// legitimately BLOCKED before implementing), and a report.md no longer left as
// the dispatch_prepare scaffold.
export function checkProducer(
  container: string,
  git: GitRunner = defaultGitRunner,
): ContractResult {
  const violations: Violation[] = [];
  const statePath = join(container, "STATE.md");
  const reportPath = join(container, "report.md");
  const contextPath = join(container, "context.json");
  const checkout = join(container, "checkout");

  if (!existsSync(container)) {
    violations.push({ check: "container_missing", detail: `_dispatch container not found: ${container} (already cleaned up, or wrong --dispatch id?)` });
    return finish("producer", violations);
  }

  // (a) STATE.md status.
  let status: string | null = null;
  if (!existsSync(statePath)) {
    violations.push({ check: "state_missing", detail: `STATE.md not found at ${statePath}` });
  } else {
    status = readStateStatus(readFileSync(statePath, "utf8"));
    if (status === null) {
      violations.push({ check: "state_unreadable", detail: "STATE.md has no '## Status' value" });
    } else if (status !== "REPORTING" && status !== "BLOCKED") {
      violations.push({ check: "state_not_reporting", detail: `STATE.md Status is '${status}', expected REPORTING or BLOCKED (producer went idle without closing out)` });
    }
  }

  // (b) commits past base_sha. Skipped only for a legitimately BLOCKED producer
  // (blocked before writing code → no commit is expected). Any other status
  // (WORKING/REPORTING/unknown) implies "should have committed if done".
  if (status !== "BLOCKED") {
    const baseSha = readBaseSha(contextPath);
    if (!existsSync(checkout)) {
      violations.push({ check: "checkout_missing", detail: `checkout worktree not found at ${checkout}` });
    } else if (baseSha === null) {
      violations.push({ check: "base_sha_unknown", detail: `cannot read task.base_sha from ${contextPath}; unable to verify commits` });
    } else {
      const r = git(["rev-list", "--count", `${baseSha}..HEAD`], checkout);
      if (r.code !== 0) {
        violations.push({ check: "commit_check_failed", detail: `git rev-list ${baseSha}..HEAD failed in checkout` });
      } else if (parseInt(r.stdout.trim(), 10) === 0) {
        violations.push({ check: "no_commits", detail: `no commits past base ${baseSha} on the checkout branch (implemented but never committed?)` });
      }
    }
  }

  // (c) report.md no longer the scaffold template.
  if (!existsSync(reportPath)) {
    violations.push({ check: "report_missing", detail: `report.md not found at ${reportPath}` });
  } else {
    const body = readFileSync(reportPath, "utf8");
    const remaining = REPORT_PLACEHOLDERS.filter((p) => body.includes(p));
    if (remaining.length > 0) {
      violations.push({ check: "report_template", detail: `report.md still holds ${remaining.length} scaffold placeholder(s): ${remaining.join(", ")}` });
    }
  }

  return finish("producer", violations);
}

// ── gate mode ────────────────────────────────────────────────────────────────
// A completed gate role MUST have published its verdict marker at
// runtime/<role>/results/<slug>-<role>.md with a `## Verdict` section carrying a
// canonical token. (Case 2: review done, verdict file never written.)
export function checkGate(
  runtimeRoot: string,
  slug: string,
  roles: string[],
): ContractResult {
  const violations: Violation[] = [];
  for (const role of roles) {
    const path = join(runtimeRoot, role, "results", `${slug}-${role}.md`);
    if (!existsSync(path)) {
      violations.push({ check: "verdict_missing", detail: `${role}: verdict report not found at ${path}` });
      continue;
    }
    const body = readFileSync(path, "utf8");
    const verdictSection = extractVerdictSection(body);
    if (verdictSection === null) {
      violations.push({ check: "verdict_section_missing", detail: `${role}: ${path} has no '## Verdict' section` });
      continue;
    }
    if (!VERDICT_TOKENS.some((t) => verdictSection.includes(t))) {
      violations.push({ check: "verdict_token_missing", detail: `${role}: '## Verdict' section carries no canonical token (${VERDICT_TOKENS.join("/")})` });
    }
  }
  return finish("gate", violations, slug, roles);
}

// ── stall-scan mode (W-034) ──────────────────────────────────────────────────
// Best-effort probe: is a build/test tool (cargo/bun/npm/tsc/...) currently
// running with THIS dispatch's checkout path in its command line? Mirrors the
// builder-name list dispatch_watch.sh / doctor.sh already use for their
// system-wide compile-activity heuristic (DEC-091), but scoped per-checkout so
// a multi-item scan does not read one producer's live build as cover for a
// different, genuinely idle one. Injectable for tests; the real lister returns
// null when the platform probe itself is unavailable, and the caller reports
// "unknown" rather than mis-asserting either way (the W-053 lesson: an
// unverifiable idle notification is not evidence of a stall).
export type ProcessLister = () => string[] | null;

const BUILDER_RE = /\b(cargo|rustc|cc1|gcc|g\+\+|clang|tsc|esbuild|webpack|javac|kotlinc|gradle|go|ninja|make|bazel|msbuild|swiftc|link\.exe|bun|npm|yarn|pnpm|node|mvn|pytest|jest|dotnet)\b/i;

const defaultProcessLister: ProcessLister = () => {
  try {
    if (process.platform === "win32") {
      const r = Bun.spawnSync(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine"],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (r.exitCode !== 0) return null;
      return r.stdout.toString().split(/\r?\n/).filter(Boolean);
    }
    for (const psArgs of [["-eo", "args"], ["-ef"], ["aux"]]) {
      const r = Bun.spawnSync(["ps", ...psArgs], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode === 0) return r.stdout.toString().split(/\r?\n/).filter(Boolean);
    }
    return null;
  } catch {
    return null;
  }
};

export function detectBackgroundActivity(
  checkoutAbsPath: string,
  lister: ProcessLister = defaultProcessLister,
): "running" | "none" | "unknown" {
  const lines = lister();
  if (lines === null) return "unknown";
  const needle = checkoutAbsPath.replace(/\\/g, "/").toLowerCase();
  const hit = lines.some((l) => BUILDER_RE.test(l) && l.replace(/\\/g, "/").toLowerCase().includes(needle));
  return hit ? "running" : "none";
}

// "none" while escalation history has not been layered on (plain stallScan()
// output); a real level only appears once the CLI runs applyEscalation().
export type EscalationLevel = "none" | "nudge" | "handoff";

export interface StallScanItem {
  dispatch: string;
  state: string | null;
  commits: number | null;
  dirty: boolean | null;
  // sha256 of `git status --porcelain` in the checkout, null when it could not
  // be read. Used (only) to tell "still stall-suspect, same unchanged diff"
  // apart from "still stall-suspect, but the diff moved" — the latter is
  // progress and must not accumulate escalation time (W-037).
  dirty_hash: string | null;
  background: "running" | "none" | "unknown";
  judgement: "build-wait" | "stall-suspect" | "unknown";
  suggested_nudge: string;
  escalation: EscalationLevel;
  escalation_elapsed_min: number | null;
  escalation_prompt: string;
}
export interface StallScanResult {
  ok: boolean;
  mode: "stall-scan";
  items: StallScanItem[];
}

function buildStallNudge(dispatchId: string, container: string): string {
  return [
    `dispatch #${dispatchId} が stall 疑いです (STATE=WORKING, 未commit, checkout dirty, 進行中の build/test process なし)。`,
    `再開手順:`,
    `- ${container}/checkout の作業内容を確認する (git status / git diff)`,
    `- agent がまだ生きていれば「進捗があれば途中経過を1 message送る」よう再開を促す`,
    `- 反応がなければ respawn-handoff (contract_check.ts --stall-scan --handoff ${dispatchId}) で` +
      `打切り通告 + 引継ぎ prompt を生成し、部分実装を保全したまま次の担当に引き継ぐ`,
  ].join("\n");
}

// Scans every `_dispatch<N>/` container directly under `<pmRoot>` (mirrors the
// _dispatch<N> layout dispatch_prepare.sh creates). Only STATE.md=WORKING
// containers are candidates; REPORTING/BLOCKED/IDLE are none of stall-scan's
// business (that is contract_check's producer mode). Within a WORKING
// container, the stall-suspect CANDIDATE condition is commits===0 AND
// dirty===true (backlog W-034 design) — a WORKING container with either a
// commit already or a clean checkout is not yet worth flagging either way.
export function stallScan(
  pmRoot: string,
  git: GitRunner = defaultGitRunner,
  lister: ProcessLister = defaultProcessLister,
): StallScanResult {
  const items: StallScanItem[] = [];
  if (existsSync(pmRoot)) {
    const dirs = readdirSync(pmRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^_dispatch\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => parseInt(a.slice("_dispatch".length), 10) - parseInt(b.slice("_dispatch".length), 10));
    for (const name of dirs) {
      const dispatchId = name.slice("_dispatch".length);
      const container = join(pmRoot, name);
      const statePath = join(container, "STATE.md");
      const checkout = join(container, "checkout");
      const contextPath = join(container, "context.json");

      const state = existsSync(statePath) ? readStateStatus(readFileSync(statePath, "utf8")) : null;
      if (state !== "WORKING") continue;

      let commits: number | null = null;
      let dirty: boolean | null = null;
      let dirtyHash: string | null = null;
      if (existsSync(checkout)) {
        const baseSha = readBaseSha(contextPath);
        if (baseSha !== null) {
          const rc = git(["rev-list", "--count", `${baseSha}..HEAD`], checkout);
          if (rc.code === 0) commits = parseInt(rc.stdout.trim(), 10);
        }
        const rd = git(["status", "--porcelain"], checkout);
        if (rd.code === 0) {
          dirty = rd.stdout.trim().length > 0;
          dirtyHash = hashPorcelain(rd.stdout);
        }
      }

      const isCandidate = commits === 0 && dirty === true;
      let background: StallScanItem["background"] = "unknown";
      let judgement: StallScanItem["judgement"] = "unknown";
      if (isCandidate) {
        background = detectBackgroundActivity(resolve(checkout), lister);
        judgement = background === "running" ? "build-wait" : background === "none" ? "stall-suspect" : "unknown";
      }

      items.push({
        dispatch: dispatchId, state, commits, dirty, dirty_hash: dirtyHash, background, judgement,
        suggested_nudge: judgement === "stall-suspect" ? buildStallNudge(dispatchId, container) : "",
        escalation: "none", escalation_elapsed_min: null, escalation_prompt: "",
      });
    }
  }
  return { ok: !items.some((i) => i.judgement === "stall-suspect"), mode: "stall-scan", items };
}

// Respawn-handoff prompt (W-034 requirement 3): a ready-to-paste block covering
// (a) a termination notice for the stalled producer (if it is still reachable)
// and (b) a resume prompt for the NEXT agent that preserves the partial
// implementation on the same checkout rather than starting cold.
export function buildHandoffPrompt(item: StallScanItem, container: string): string {
  const L: string[] = [];
  L.push(`# dispatch #${item.dispatch} respawn-handoff`);
  L.push("");
  L.push(`judgement=${item.judgement} background=${item.background} commits=${item.commits ?? "?"} dirty=${item.dirty ?? "?"}`);
  if (item.judgement !== "stall-suspect") {
    L.push(`NOTE: this dispatch was NOT classified stall-suspect (${item.judgement}) — confirm it is genuinely idle before terminating it.`);
  }
  L.push("");
  L.push("## 打切り通告 (旧 producer が応答すれば送る)");
  L.push(`dispatch #${item.dispatch} は進捗が確認できない (未commit + 進行中の build/test process なし) ため打ち切ります。`);
  L.push(`${container}/checkout の部分実装は削除しません。次の担当が確認・再開します。`);
  L.push("");
  L.push("## 引継ぎ prompt (次の subagent へそのまま渡す)");
  L.push(`RESUME in the EXISTING worktree ${container}/checkout (do NOT run dispatch_prepare again).`);
  L.push(`A prior producer here (dispatch #${item.dispatch}) went idle without committing. FIRST read STATE.md ` +
    `and inspect the uncommitted diff (git status / git diff) before doing anything else.`);
  L.push(`If the partial diff is on-track for the assignment, continue it, run the quality gate in the ` +
    `FOREGROUND, commit, and update STATE.md/report.md. If it looks like a false start or unrelated, discard ` +
    `it (git checkout -- . && git clean -fd) and re-implement from the assignment.`);
  L.push(`While waiting on a long build, send ONE progress message instead of going silent — that omission is ` +
    `what caused this handoff.`);
  return L.join("\n");
}

// sha256 of the raw `git status --porcelain` output. Deliberately coarse (the
// whole porcelain block, not a real diff) — good enough to tell "the checkout
// changed since last scan" from "nothing moved", which is all escalation
// continuity needs (W-037).
function hashPorcelain(porcelain: string): string {
  return createHash("sha256").update(porcelain).digest("hex");
}

// ── escalation (W-037) ───────────────────────────────────────────────────────
// Per-dispatch judgement history, persisted across --stall-scan invocations so
// a PM/jig_tick that only ever calls stallScan() once per tick can still tell
// "just became stall-suspect" apart from "has been stall-suspect for 25
// minutes with nobody looking." Keyed by dispatch id; rebuilt fresh from the
// CURRENT scan every run, so a dispatch that stops appearing (cleaned up,
// resolved) or stops being stall-suspect (judgement changed) has no stale
// leftover entry.
export interface StallHistoryRecord {
  judgement: StallScanItem["judgement"];
  dirty_hash: string | null;
  since_ms: number;
  last_seen_ms: number;
}
export type StallHistoryMap = Record<string, StallHistoryRecord>;

export function loadStallHistory(path: string): StallHistoryMap {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as StallHistoryMap) : {};
  } catch {
    return {};
  }
}

export function saveStallHistory(path: string, history: StallHistoryMap): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(history, null, 2) + "\n", "utf8");
}

function buildEscalationNudge(item: StallScanItem, elapsedMin: number): string {
  return [
    `[escalation: nudge] dispatch #${item.dispatch} は stall-suspect のまま ${Math.floor(elapsedMin)} 分継続しています` +
      ` (同一判定 + checkout diff 不変 — 進捗が無いことを意味します)。至急ようすを確認してください。`,
    item.suggested_nudge,
  ].join("\n\n");
}

function buildEscalationHandoffPrompt(item: StallScanItem, container: string, elapsedMin: number): string {
  return (
    `[escalation: handoff] dispatch #${item.dispatch} は stall-suspect のまま ${Math.floor(elapsedMin)} 分継続` +
    ` (handoff しきい値到達)。手動介入なしで以下の respawn-handoff prompt を使用してください:\n\n` +
    buildHandoffPrompt(item, container)
  );
}

export interface EscalationOptions {
  nudgeAfterMin: number;
  handoffAfterMin: number;
  nowMs: number;
}

// Applies persisted history on top of one stallScan() result. A dispatch's
// clock only keeps running while it stays judgement="stall-suspect" WITH an
// unchanged dirty_hash between scans — any other judgement (build-wait/
// unknown), OR the same judgement but a diff that moved (real progress),
// resets it. `containerOf` builds the container path for the handoff prompt
// without this module needing to know pmRoot's layout convention itself.
export function applyEscalation(
  items: StallScanItem[],
  history: StallHistoryMap,
  opts: EscalationOptions,
  containerOf: (dispatchId: string) => string,
): { items: StallScanItem[]; history: StallHistoryMap } {
  const nextHistory: StallHistoryMap = {};
  const outItems = items.map((item): StallScanItem => {
    if (item.judgement !== "stall-suspect") {
      return { ...item, escalation: "none", escalation_elapsed_min: null, escalation_prompt: "" };
    }
    const hash = item.dirty_hash ?? "";
    const prior = history[item.dispatch];
    const continued = prior !== undefined && prior.judgement === "stall-suspect" && prior.dirty_hash === hash;
    const since = continued ? prior.since_ms : opts.nowMs;
    nextHistory[item.dispatch] = { judgement: "stall-suspect", dirty_hash: hash, since_ms: since, last_seen_ms: opts.nowMs };

    const elapsedMin = (opts.nowMs - since) / 60_000;
    let escalation: EscalationLevel = "none";
    let prompt = "";
    if (elapsedMin >= opts.handoffAfterMin) {
      escalation = "handoff";
      prompt = buildEscalationHandoffPrompt(item, containerOf(item.dispatch), elapsedMin);
    } else if (elapsedMin >= opts.nudgeAfterMin) {
      escalation = "nudge";
      prompt = buildEscalationNudge(item, elapsedMin);
    }
    return { ...item, escalation, escalation_elapsed_min: elapsedMin, escalation_prompt: prompt };
  });
  return { items: outItems, history: nextHistory };
}

// ── parsing helpers ──────────────────────────────────────────────────────────
// First non-blank line under the '## Status' heading (STATE.md convention, as
// dispatch_prepare.sh writes it and dispatch_prepare guard reads it).
export function readStateStatus(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^##\s*Status\b/i.test(l));
  if (i < 0) return null;
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t.length > 0) return t;
  }
  return null;
}

function readBaseSha(contextPath: string): string | null {
  if (!existsSync(contextPath)) return null;
  try {
    const pack = JSON.parse(readFileSync(contextPath, "utf8")) as { task?: { base_sha?: string | null } };
    const sha = pack.task?.base_sha;
    return sha ? String(sha) : null;
  } catch { return null; }
}

// The '## Verdict' section body: text between that heading and the next '## '.
function extractVerdictSection(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^##\s*Verdict\b/i.test(l));
  if (i < 0) return null;
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^##\s/.test(lines[j])) break;
    out.push(lines[j]);
  }
  return out.join("\n");
}

// ── nudge synthesis ──────────────────────────────────────────────────────────
// A ready-to-paste Japanese SendMessage body listing exactly the missing
// artifacts. When there are no violations the caller does not send a nudge.
function finish(mode: "producer" | "gate", violations: Violation[], slug?: string, roles?: string[]): ContractResult {
  const ok = violations.length === 0;
  return { ok, mode, violations, nudge: ok ? "" : buildNudge(mode, violations, slug, roles) };
}

function buildNudge(mode: "producer" | "gate", violations: Violation[], slug?: string, roles?: string[]): string {
  const L: string[] = [];
  if (mode === "producer") {
    L.push("完了前に artifact contract が未達です。以下を満たしてから再度 REPORTING してください:");
    for (const v of violations) {
      if (v.check === "no_commits") L.push("- 実装を workbench branch に commit する (未 commit の変更が残っています)");
      else if (v.check === "state_not_reporting" || v.check === "state_unreadable" || v.check === "state_missing") L.push("- STATE.md の Status を REPORTING (または BLOCKED) に更新する");
      else if (v.check === "report_template") L.push("- report.md を scaffold template から実内容 (Status/Summary/Gates/Evidence) に書き換える");
      else if (v.check === "report_missing") L.push("- report.md を作成し完了報告を書く");
      else L.push(`- ${v.detail}`);
    }
  } else {
    const who = roles && roles.length ? roles.join(" / ") : "gate role";
    L.push(`gate '${slug ?? ""}' の verdict artifact が未達です (${who})。review 済であれば verdict report を publish してください:`);
    for (const v of violations) {
      if (v.check === "verdict_missing") L.push(`- ${v.detail} を作成し '## Verdict' 節に canonical token を書く`);
      else if (v.check === "verdict_section_missing") L.push(`- ${v.detail} — '## Verdict' 節を追記する`);
      else if (v.check === "verdict_token_missing") L.push(`- ${v.detail} を記入する`);
      else L.push(`- ${v.detail}`);
    }
  }
  return L.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function numArg(name: string, def: number): number {
  const v = arg(name);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function resolveProject(): string {
  const p = arg("project") ?? process.env.GARELIER_PROJECT;
  return p ? resolve(p) : process.cwd();
}

type StallScanOutput = StallScanResult & {
  handoff_dispatch?: string;
  handoff_prompt?: string | null;
  handoff_error?: string;
};

function main(): void {
  const project = resolveProject();
  const pmId = arg("pm-id") ?? process.env.GARELIER_PM_ID;
  const dispatch = arg("dispatch");
  const gate = arg("gate");
  const stallScanFlag = process.argv.includes("--stall-scan");
  const handoff = arg("handoff");
  const format = (arg("format") ?? "json").toLowerCase();

  if (!pmId) { console.error("contract_check: --pm-id <id> required"); process.exit(2); return; }
  const modeCount = [dispatch !== undefined, gate !== undefined, stallScanFlag].filter(Boolean).length;
  if (modeCount !== 1) {
    console.error("contract_check: exactly one of --dispatch <N>, --gate <slug>, or --stall-scan required");
    process.exit(2); return;
  }
  if (handoff !== undefined && !stallScanFlag) {
    console.error("contract_check: --handoff requires --stall-scan");
    process.exit(2); return;
  }

  const pmRoot = join(project, "__garelier", pmId);
  let result: ContractResult | StallScanOutput;
  if (dispatch !== undefined) {
    const n = dispatch.replace(/^#/, "");
    result = checkProducer(join(pmRoot, `_dispatch${n}`));
  } else if (gate !== undefined) {
    const roles = (arg("roles") ?? "guardian,observer").split(",").map((s) => s.trim()).filter(Boolean);
    result = checkGate(join(pmRoot, "runtime"), gate!, roles);
  } else {
    const scan: StallScanOutput = stallScan(pmRoot);
    const historyPath = join(pmRoot, "runtime", "dispatch", "stall_scan_history.json");
    const nudgeAfterMin = numArg("nudge-after", 10);
    const handoffAfterMin = numArg("handoff-after", 25);
    const esc = applyEscalation(
      scan.items,
      loadStallHistory(historyPath),
      { nudgeAfterMin, handoffAfterMin, nowMs: Date.now() },
      (id) => join(pmRoot, `_dispatch${id}`),
    );
    saveStallHistory(historyPath, esc.history);
    scan.items = esc.items;
    if (handoff !== undefined) {
      const hid = handoff.replace(/^#/, "");
      const item = scan.items.find((i) => i.dispatch === hid);
      scan.handoff_dispatch = hid;
      if (item) {
        scan.handoff_prompt = buildHandoffPrompt(item, join(pmRoot, `_dispatch${hid}`));
      } else {
        scan.handoff_prompt = null;
        scan.handoff_error = `dispatch #${hid} not found among WORKING containers in this stall-scan`;
      }
    }
    result = scan;
  }

  if (format === "text") {
    if (result.mode === "stall-scan") {
      console.log(`stall-scan: ${result.items.length} WORKING dispatch(es)`);
      for (const it of result.items) {
        const escSuffix = it.escalation !== "none" ? ` escalation=${it.escalation} (${Math.floor(it.escalation_elapsed_min ?? 0)}min)` : "";
        console.log(`  #${it.dispatch}: state=${it.state} commits=${it.commits ?? "?"} dirty=${it.dirty ?? "?"} background=${it.background} judgement=${it.judgement}${escSuffix}`);
        if (it.escalation !== "none") console.log(it.escalation_prompt.split("\n").map((l) => "    " + l).join("\n"));
        else if (it.judgement === "stall-suspect") console.log(it.suggested_nudge.split("\n").map((l) => "    " + l).join("\n"));
      }
      if (result.handoff_dispatch !== undefined) {
        console.log(`\n--- handoff (--handoff ${result.handoff_dispatch}) ---`);
        console.log(result.handoff_prompt ?? result.handoff_error ?? "(no handoff generated)");
      }
    } else if (result.ok) console.log(`contract OK (${result.mode})`);
    else {
      console.log(`contract VIOLATION (${result.mode}):`);
      for (const v of result.violations) console.log(`  ! [${v.check}] ${v.detail}`);
      console.log("\n--- nudge (paste into SendMessage) ---\n" + result.nudge);
    }
  } else {
    console.log(JSON.stringify(result));
  }
  process.exit(result.ok ? 0 : 3);
}

if (import.meta.main) main();
