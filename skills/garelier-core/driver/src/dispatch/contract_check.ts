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
//               [--nudge-after <N-min>] [--handoff-after <M-min>] [--revive-after <R-min>]
//               [--resume-gap-hours <H>] [--unwatched-after <U-min>]
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
// background,judgement,watch,suggested_nudge,escalation,escalation_elapsed_min,
// escalation_prompt}], unwatched:[<id>,...], unwatched_detail:[{dispatch,
// watch_cmd}], unprocessed_results:[{...,cleanup_cmd}], unconsumed_instructions:
// [...], idle_no_register:[...] } (+ handoff_prompt when --handoff is given).
// `watch`/`unwatched`/`unwatched_detail` are the W-085 UNWATCHED detective;
// `unprocessed_results` is the W-086 UNPROCESSED-RESULT detective;
// `unconsumed_instructions` is the W-092 UNCONSUMED-INSTRUCTIONS detective;
// `idle_no_register` is the W-018 IDLE-NO-REGISTER detective — an idle dispatch
// with no processed register. Every one of these advisory findings (all below,
// none flips `ok`) carries a ready-to-run command — `wake_cmd` (idle_no_register),
// `watch_cmd` (unwatched_detail), `cleanup_cmd` (unprocessed_results) — so the
// attended operator runs it verbatim instead of hand-composing args (W-033).
// ok=false iff at least one item is judgement="stall-suspect", "post-commit-stall",
// or "ungated-reporting". exit 0/3 mirror that; exit 2 = usage error. It also
// carries a W-053 `touch_map` — declared touches / depends_on / pairwise conflicts
// across EVERY active dispatch (not only the WORKING stall candidates) — so the PM
// reads the parallel-collision landscape here too.
//
// It ALSO scans UNGATED REPORTING containers (W-071 / W-086 blind spot): a
// REPORTING dispatch whose Guardian/Observer verdict was never published is a
// finished-but-forgotten producer no one gated. It surfaces as
// judgement="ungated-reporting" so a status query notices it (dispatch_watch
// --fleet covers the same target set for the durable watch). The anomaly
// vocabulary is the single taxonomy in role_subagent_dispatch.md §6.
//
// session-resume (W-071): each --stall-scan persists its wall-clock timestamp to
// `<pmRoot>/runtime/dispatch/last_scan.json` and, when the gap since the previous
// scan exceeds --resume-gap-hours (default 2), emits a top-level `session_resume`
// banner. An attended PM's monitoring stops while the session is paused, and an
// in-process teammate is NOT restored by /resume (official) — so a large gap means
// "respawn required from the worktree", not "wake". The banner forces the operator
// to re-scan and re-dispatch dormant producers on resume (pm_playbook §11).
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
// same respawn-handoff prompt `--handoff <N>` produces; continuous >=
// --revive-after minutes (default 30) sets `escalation:"revive"` — the LOUD
// REVIVE-NEEDED level (W-071): a producer flat this long is DORMANT, so the
// prompt says respawn FRESH from the worktree, do not attempt to wake (a
// /resume does not restore an in-process teammate — official). Any judgement
// other than "stall-suspect"/"post-commit-stall" (build-wait/unknown/
// ungated-reporting) resets that dispatch's history — this only fires on
// sustained, unambiguous idleness. Nothing here sends a message; it only raises
// the signal a PM (or the jig_tick automation that already runs --stall-scan
// every tick, mode_e_jig.md) already reads.
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
// W-053 touch/depends conflict landscape, surfaced in --stall-scan output.
import { scanActiveDispatches, buildTouchMap, type TouchMapEntry } from "./conflict_check.ts";
import { seatAgentName } from "../scripts/gate_agents.ts"; // W-168 O3: single identity source
import { arg, numArg, printHelpAndExitIfRequested } from "../cli_args.ts";
import { crewSubdir } from "../workspace.ts";
import { containerSpawnEpoch, requireRuntimeExecutable, resolveCommand, withinSpawnGrace } from "../scripts/_lib.ts";
import {
  checkCloseContract, resolveReachability, normalizeRuntimeEffect, normalizeResourceClass,
  type ReachabilityDecl, type ReachabilityQuery, type CloseViolation, type RuntimeEffect, type ResourceClass,
} from "./engine_aware.ts";

// W-033: absolute path to the sibling scripts/ dir (this file lives at
// driver/src/dispatch/contract_check.ts; scripts/ is a sibling of driver/),
// resolved once so cleanup_cmd/watch_cmd below can emit a ready-to-run
// one-liner the same way dispatch_prepare.ts's watch_cmd does (absolute path,
// resolved at emission time, never a relative guess the caller's cwd could
// break).
const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

function dispatchLayout(pmRoot: string): { root: string; prefix: string } {
  // Legacy flat "_dispatch<N>" vs v2 crew "_crew/dispatch<N>". When pmRoot sits
  // under __garelier we resolve one container through the shared 3-tier
  // crewSubdir (which knows the live layout) and read the naming scheme off its
  // basename; otherwise (bare-temp fixtures) we resolve directly against pmRoot.
  // The prefix is derived from the resolved basename, NOT from string-comparing
  // root to pmRoot — the latter is always false on Windows, where crewSubdir
  // emits forward-slash paths that never string-equal a join()-built pmRoot, so
  // the flat "_dispatch<N>" scan silently found nothing (W-086 P2 regression).
  if (basename(dirname(pmRoot)) === "__garelier") {
    const sample = crewSubdir(dirname(dirname(pmRoot)), basename(pmRoot), "_dispatch0");
    return { root: dirname(sample), prefix: basename(sample).startsWith("_") ? "_dispatch" : "dispatch" };
  }
  const crew = join(pmRoot, "_crew");
  return existsSync(crew) ? { root: crew, prefix: "dispatch" } : { root: pmRoot, prefix: "_dispatch" };
}

function dispatchNames(pmRoot: string): { root: string; prefix: string; names: string[] } {
  const layout = dispatchLayout(pmRoot);
  const pattern = new RegExp(`^${layout.prefix}\\d+$`);
  try {
    return {
      ...layout,
      names: readdirSync(layout.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && pattern.test(e.name))
        .map((e) => e.name),
    };
  } catch { return { ...layout, names: [] }; }
}

function dispatchContainer(pmRoot: string, id: string): string {
  const projectRoot = dirname(dirname(pmRoot));
  if (basename(dirname(pmRoot)) === "__garelier") {
    return crewSubdir(projectRoot, basename(pmRoot), `_dispatch${id}`);
  }
  const { root, prefix } = dispatchLayout(pmRoot);
  return join(root, `${prefix}${id}`);
}

// ── git seam (Bun.spawnSync pattern, mirrors branch_gc.ts) ──────────────────
export type GitRunner = (args: string[], cwd: string) => { code: number; stdout: string };
const defaultGitRunner: GitRunner = (args, cwd) => {
  // Catch a spawn failure (e.g. git not on PATH, or an unresolvable cwd — W-086)
  // and degrade to a non-zero "git failed" result. --stall-scan is an advisory
  // best-effort probe; a git-spawn throw must never crash the whole scan (every
  // caller already treats code !== 0 as "could not read"). Returning code 1 makes
  // the scanner skip that datum rather than abort.
  try {
    const r = Bun.spawnSync([requireRuntimeExecutable("git"), ...args], { windowsHide: true, cwd, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, stdout: r.stdout ? r.stdout.toString() : "" };
  } catch {
    return { code: 1, stdout: "" };
  }
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

// Placeholder markers written verbatim by dispatch_prepare.ts into report.md.
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

// ── close-contract mode (W-087) ──────────────────────────────────────────────
// The mechanization of planning_craft §2-10: a row does not close on its functional
// AC alone. Close ALSO requires the blueprint's 到達構成 (named crate/artifact/
// consumer) to have landed AND the RUN evidence the dispatch's runtime_effect
// demands (a visual task needs a screenshot / user-verdict pointer). This reads the
// dispatch's runtime_effect from context.json (overridable), resolves each declared
// construct's presence against the checkout, and returns the close violations — the
// W-484 "row green・到達構成未完" close refusal in one command. Presence probes are
// injected (exists / git) so the resolution is testable without a repo.
export interface CloseResult {
  ok: boolean;
  mode: "close";
  resource_class: ResourceClass;
  runtime_effect: RuntimeEffect;
  violations: CloseViolation[];
  nudge: string;
}

export interface CloseInputs {
  reach: ReachabilityDecl[];
  runArtifact: string | null;       // path (rel to checkout, or absolute) to a captured RUN artifact
  visualVerdict: string | null;     // screenshot path / user-verdict pointer
  runtimeEffectOverride?: string | null;
}

// context.json task.resource_class / runtime_effect, defaulted (with no warning
// here — the warning fires at dispatch time in context_pack) when absent/unknown.
function readEngineFields(contextPath: string): { resourceClass: ResourceClass; runtimeEffect: RuntimeEffect } {
  let rawRc: string | null = null;
  let rawRe: string | null = null;
  if (existsSync(contextPath)) {
    try {
      const pack = JSON.parse(readFileSync(contextPath, "utf8")) as { task?: { resource_class?: string; runtime_effect?: string } };
      rawRc = pack.task?.resource_class ?? null;
      rawRe = pack.task?.runtime_effect ?? null;
    } catch { /* fall through to defaults */ }
  }
  return { resourceClass: normalizeResourceClass(rawRc).value, runtimeEffect: normalizeRuntimeEffect(rawRe).value };
}

// The default presence probes against a dispatch checkout: a crate/artifact is a
// path presence; a consumer is a tracked-file reference found by `git grep`.
export function defaultReachabilityQuery(checkout: string, git: GitRunner = defaultGitRunner): ReachabilityQuery {
  return {
    exists: (name) => existsSync(join(checkout, name)),
    grep: (name) => git(["grep", "-q", "--fixed-strings", "--", name], checkout).code === 0,
  };
}

export function checkClose(
  container: string,
  inputs: CloseInputs,
  git: GitRunner = defaultGitRunner,
): CloseResult {
  const contextPath = join(container, "context.json");
  const checkout = join(container, "checkout");
  const { resourceClass, runtimeEffect: fileEffect } = readEngineFields(contextPath);
  const runtimeEffect = inputs.runtimeEffectOverride
    ? normalizeRuntimeEffect(inputs.runtimeEffectOverride).value
    : fileEffect;

  // A missing container / checkout cannot prove any construct landed — surface it
  // as a single unreachable violation rather than a false pass.
  if (!existsSync(container)) {
    return {
      ok: false, mode: "close", resource_class: resourceClass, runtime_effect: runtimeEffect,
      violations: [{ rule: "unreachable-construct", subject: container, detail: `_dispatch container not found: ${container} (wrong --dispatch id, or already cleaned up)` }],
      nudge: buildCloseNudge([{ rule: "unreachable-construct", subject: container, detail: "container missing" }]),
    };
  }

  const q = existsSync(checkout)
    ? defaultReachabilityQuery(checkout, git)
    // No checkout: nothing can be resolved present — every declared construct reads
    // absent (never a false "landed").
    : { exists: () => false, grep: () => false };
  const reachability = resolveReachability(inputs.reach, q);

  // The RUN artifact resolves against the checkout (rel) or as an absolute path.
  const runArtifactPresent = inputs.runArtifact
    ? existsSync(isAbsolutePath(inputs.runArtifact) ? inputs.runArtifact : join(checkout, inputs.runArtifact))
    : null;

  const res = checkCloseContract({
    runtimeEffect,
    reachability,
    runArtifactPresent,
    visualVerdictPointer: inputs.visualVerdict,
  });
  return {
    ok: res.ok, mode: "close", resource_class: resourceClass, runtime_effect: runtimeEffect,
    violations: res.violations, nudge: res.ok ? "" : buildCloseNudge(res.violations),
  };
}

function isAbsolutePath(p: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p);
}

function buildCloseNudge(violations: CloseViolation[]): string {
  const L: string[] = ["close 契約が未達です (planning_craft §2-10)。row の機能 AC が green でも、以下を満たすまで close しないでください:"];
  for (const v of violations) {
    if (v.rule === "unreachable-construct") L.push(`- 到達構成 "${v.subject}" が未着地 — named crate/artifact/consumer を landing させるか、残差を即 row 化する`);
    else if (v.rule === "run-artifact-missing") L.push(`- runtime_effect="${v.subject}" の RUN artifact (実行痕跡) を残す — compile 済みだけでは close 不可`);
    else if (v.rule === "visual-no-verdict") L.push("- visual task の screenshot / user-verdict pointer を添付する — prose だけで close 不可");
    else L.push(`- ${v.detail}`);
  }
  return L.join("\n");
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
// builder-name list dispatch_watch.ts / doctor.ts already use for their
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
        [requireRuntimeExecutable("pwsh"), "-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine"],
        { windowsHide: true, stdout: "pipe", stderr: "pipe" },
      );
      if (r.exitCode !== 0) return null;
      return r.stdout.toString().split(/\r?\n/).filter(Boolean);
    }
    for (const psArgs of [["-eo", "args"], ["-ef"], ["aux"]]) {
      const ps = resolveCommand(["ps", ...psArgs]);
      if (!ps) continue;
      const r = Bun.spawnSync(ps, { windowsHide: true, stdout: "pipe", stderr: "pipe" });
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

// ── watch coverage / UNWATCHED (W-085) ───────────────────────────────────────
// The detective twin of dispatch_prepare's watch_cmd + the PM-playbook arm step:
// a WORKING dispatch that NO dispatch_watch is actually watching is surfaced here,
// so a forgotten watch (which let a fleet of producers go dormant overnight,
// 2026-07-06) is caught rather than discovered the next morning. The evidence is
// the persistent liveness heartbeat dispatch_watch.ts writes under
// runtime/dispatch/watch/heartbeats/ (single: dispatch-<id>.json / branch-<key>.json;
// fleet: fleet-<pid>.json). A live FLEET heartbeat covers every working dispatch
// under the pm (the fleet watches them all); a SINGLE heartbeat covers the one it
// names (by id or branch). A marker older than the stale window reads the same as
// no marker — the watch died or was never re-armed. This is ADVISORY: it never
// flips the scan's `ok`/exit — a freshly-dispatched producer is briefly unwatched
// by construction (before the operator runs its watch_cmd), so coupling that to the
// stall exit code would be pure noise; it is reported so the operator arms the gap.
export type WatchCoverage = "watched" | "unwatched";

export interface WatchHeartbeat {
  pid?: number;
  mode?: string;            // "single" | "fleet"
  id?: string | null;       // single: the watched dispatch id
  branch?: string | null;   // single: the watched branch
  ts_epoch?: number;        // seconds since epoch (dispatch_watch writes `date +%s`)
  active_ids?: string;      // fleet: informational
}

// Reads every *.json under <pmRoot>/runtime/dispatch/watch/heartbeats/. Best-effort:
// a missing dir or a corrupt file yields no entry rather than throwing (absence of
// evidence is itself the UNWATCHED signal, never a crash).
export function readWatchHeartbeats(pmRoot: string): WatchHeartbeat[] {
  const dir = join(pmRoot, "runtime", "dispatch", "watch", "heartbeats");
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch { return []; }
  const out: WatchHeartbeat[] = [];
  for (const n of names) {
    try {
      const hb = JSON.parse(readFileSync(join(dir, n), "utf8")) as WatchHeartbeat;
      if (hb && typeof hb === "object") out.push(hb);
    } catch { /* skip a corrupt marker */ }
  }
  return out;
}

// Pure: is dispatch #dispatchId (branch may be null) covered by a FRESH watch?
// nowMs/staleMs are ms; a heartbeat's ts_epoch is seconds. Injectable heartbeats +
// now pin the staleness boundary in tests without a real wall-clock wait.
export function detectWatchCoverage(
  heartbeats: WatchHeartbeat[],
  dispatchId: string,
  branch: string | null,
  nowMs: number,
  staleMs: number,
): WatchCoverage {
  const freshCutSec = (nowMs - staleMs) / 1000;
  for (const hb of heartbeats) {
    if (typeof hb.ts_epoch !== "number" || hb.ts_epoch < freshCutSec) continue; // stale/unreadable
    if (hb.mode === "fleet") return "watched";                                   // covers all
    if (hb.id != null && String(hb.id) === dispatchId) return "watched";
    if (branch != null && hb.branch != null && hb.branch === branch) return "watched";
  }
  return "unwatched";
}

// ── unprocessed merge result / UNPROCESSED-RESULT (W-086) ─────────────────────
// The detective twin of merge_request's waiter_cmd + the PM-playbook arm step: a
// merge gate that landed SUCCESSFULLY but whose workbench branch was never cleaned
// up is aftercare that stalled (cleanup / next-merge drain / follow-up never ran
// because the result waiter was not armed — 2026-07-06, 4 landed merges backed up
// until the user flagged them). The gate archives each resolved request to
// archive/<id>.request.json (carrying workbench_branch + target_root); a `success`
// result whose workbench branch STILL EXISTS is a cleanup that never ran. Advisory,
// exactly like UNWATCHED: reported so the operator runs dispatch_cleanup + drains
// the next merge, never flipping the scan's ok/exit. Bounded: only results resolved
// within --unprocessed-window-hours (default 24, by result-file mtime) are scanned,
// so old merge history is never walked.
export interface UnprocessedResult {
  request_id: string;
  workbench_branch: string;
  studio_commit: string | null;
  // W-033: a ready-to-run `dispatch_cleanup.ts --delete-branch` one-liner for
  // THIS branch (same convention as IdleNoRegister.wake_cmd / dispatch_prepare's
  // watch_cmd) -- the attended PM runs it verbatim instead of hand-composing
  // --project/--pm-id/--id/--target-root. Empty when the dispatch id cannot be
  // parsed out of workbench_branch (a hand-crafted or malformed branch name);
  // that should not happen for a garelier-produced branch.
  cleanup_cmd: string;
}
export interface UnprocessedScanOpts {
  nowMs?: number;
  windowHours?: number;
}

export function scanUnprocessedResults(
  pmRoot: string,
  git: GitRunner = defaultGitRunner,
  opts: UnprocessedScanOpts = {},
): UnprocessedResult[] {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = (opts.windowHours ?? 24) * 3_600_000;
  const resultsDir = join(pmRoot, "runtime", "merge_gate", "results");
  const archiveDir = join(pmRoot, "runtime", "merge_gate", "archive");
  if (!existsSync(resultsDir)) return [];
  let names: string[];
  try {
    // Result files are <request_id>.json; the sibling <request_id>.summary.json is a
    // separate view — exclude it so a request is considered once.
    names = readdirSync(resultsDir).filter((n) => n.endsWith(".json") && !n.endsWith(".summary.json"));
  } catch { return []; }
  const out: UnprocessedResult[] = [];
  for (const n of names) {
    const resultPath = join(resultsDir, n);
    let mtimeMs: number;
    try { mtimeMs = statSync(resultPath).mtimeMs; } catch { continue; }
    if (nowMs - mtimeMs > windowMs) continue; // resolved outside the window — skip
    let result: { request_id?: string; status?: string; studio_commit?: string | null };
    try { result = JSON.parse(readFileSync(resultPath, "utf8")); } catch { continue; }
    if (result.status !== "success") continue; // only a LANDED merge can be un-cleaned
    const requestId = result.request_id ?? n.replace(/\.json$/, "");
    // The result carries no branch/target — the archived request does.
    const archivePath = join(archiveDir, `${requestId}.request.json`);
    if (!existsSync(archivePath)) continue; // cannot map result -> branch; skip
    let req: { workbench_branch?: string; target_root?: string };
    try { req = JSON.parse(readFileSync(archivePath, "utf8")); } catch { continue; }
    const branch = req.workbench_branch;
    const targetRoot = req.target_root;
    if (!branch || !targetRoot) continue;
    // Cleanup ran iff the branch is gone; a still-present branch = UNPROCESSED.
    const r = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], targetRoot);
    if (r.code === 0) {
      out.push({
        request_id: requestId, workbench_branch: branch, studio_commit: result.studio_commit ?? null,
        cleanup_cmd: buildCleanupCmd(pmRoot, branch, targetRoot),
      });
    }
  }
  return out;
}

// W-033: `pmRoot` is always `<project>/__garelier/<pmId>` (the sole construction
// site is main()'s `join(project, "__garelier", pmId)` below) — recover both
// without widening this function's signature. `branch` is
// `garelier/<slug>/<pmId>/workbench/#<id>/<slug>`; the dispatch id is the first
// `#<digits>` segment. Empty on an unparseable branch (never expected for a
// garelier-produced one) rather than guessing.
function buildCleanupCmd(pmRoot: string, branch: string, targetRoot: string): string {
  const idMatch = /#(\d+)\//.exec(branch);
  if (!idMatch) return "";
  const project = dirname(dirname(pmRoot));
  const pmId = basename(pmRoot);
  const script = join(SCRIPTS_DIR, "dispatch_cleanup.ts");
  return `bun "${script}" --project "${project}" --target-root "${targetRoot}" --pm-id ${pmId} --id ${idMatch[1]} --delete-branch`;
}

// ── unconsumed instructions / UNCONSUMED-INSTRUCTIONS (W-092) ─────────────────
// The instruction-ledger detective: a producer that reached REPORTING while its
// instructions.md still holds an unchecked `- [ ] I<n>` entry dropped a mid-flight
// PM instruction — a scope change that crossed its completion register (the live
// class, 4 cases 2026-07-06). The ledger is dispatch_prepare's per-dispatch
// instructions.md; the PM appends entries, the producer checks each off before
// REPORTING. This surfaces a REPORTING dispatch with any unchecked entry so the PM
// re-dispatches / nudges. Advisory like UNWATCHED — it never flips the scan's ok.
export interface UnconsumedInstructions {
  dispatch: string;
  unconsumed: string[]; // the unchecked `- [ ] …` entry lines
}

// An unchecked ledger entry is a GitHub-style OPEN checkbox `- [ ] …` (or `* [ ]`);
// `- [x] …` is consumed. Header / HTML-comment lines are not checkboxes, so ignored.
export function parseUnconsumedLedger(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*[-*]\s+\[\s\]\s+/.test(raw)) out.push(raw.trim());
  }
  return out;
}

// Scans every _dispatch<N>/ container whose STATE.md is REPORTING for an
// instructions.md that still has an unchecked entry. Best-effort: a missing tree /
// unreadable file yields no entry (absence is not a false alarm).
export function scanUnconsumedInstructions(pmRoot: string): UnconsumedInstructions[] {
  const out: UnconsumedInstructions[] = [];
  if (!existsSync(pmRoot)) return out;
  const { root, prefix, names } = dispatchNames(pmRoot);
  for (const name of names) {
    const container = join(root, name);
    const statePath = join(container, "STATE.md");
    const ledgerPath = join(container, "instructions.md");
    if (!existsSync(statePath) || !existsSync(ledgerPath)) continue;
    // Only a "done" producer (REPORTING) with an open instruction is a problem; a
    // WORKING dispatch with unchecked entries is simply still working on them.
    if (readStateStatus(readFileSync(statePath, "utf8")) !== "REPORTING") continue;
    const unconsumed = parseUnconsumedLedger(readFileSync(ledgerPath, "utf8"));
    if (unconsumed.length > 0) out.push({ dispatch: name.slice(prefix.length), unconsumed });
  }
  return out;
}

// ── bypass-spawn detective / BYPASS-SPAWN (W-139) ─────────────────────────────
// The commit-bearing-role container detective. A commit-bearing PM-attended seat
// (attended_record.ts --profile producer, W-122) is a sanctioned exception to
// dispatch_prepare, but it is only sanctioned when the seat's granted --worktree
// IS one of the two commit-bearing entry points: a dispatch_prepare
// `_crew/dispatch<N>/checkout` or a workspace_isolate `_crew/lanes/<slug>` lane
// (garelier-pm SKILL.md Critical Invariants: gate=attended_record read-only /
// worker=dispatch_prepare or workspace_isolate). A producer-profile record whose
// worktree resolves to NEITHER shape means the PM handed the seat an
// unsanctioned worktree — dock non-tracked, isolate lane skipped — commonly the
// studio/target primary checkout itself. Live incident (W-139, 2026-07-18):
// aby_works PM reused the gate-only attended_record + bare Agent pattern for a
// worker task, bypassing dispatch_prepare, and edited the studio tree directly
// with no container and no isolate lane. --profile gate (guardian/observer) is
// a legitimate no-worktree/read-only attended pattern and is NEVER flagged
// here — only producer-profile records are in scope.
//
// W-155: a producer record that carries a top-level `lane_kind: "pm-direct"`
// marker (written by attended_record.ts --pm-direct) is a DECLARED PM-direct lane
// — a sanctioned lane under DEC-093. It is still surfaced (advisory=true) so the
// PM can see its PM-direct seats, but it does NOT flip the stall-scan's ok. A
// producer record WITHOUT the marker on an unsanctioned worktree is unchanged: a
// hard BYPASS-SPAWN (advisory=false) that flips ok — the undeclared, habit-driven
// gate-pattern reuse this detective was built to catch.
export interface BypassSpawn {
  agent: string;
  worktree: string;
  record_path: string;
  written_at: string | null;
  /** W-155: true when the record declared `lane_kind: "pm-direct"` — surfaced but
   * NOT a hard failure (does not flip the scan's ok). */
  advisory: boolean;
}

// Case/slash-insensitive path key for a Windows-safe equality compare (mirrors
// detectBackgroundActivity's own needle normalization above).
function canonicalCompareKey(p: string): string {
  return resolve(p).replace(/\\/g, "/").toLowerCase();
}

// Every _crew/dispatch<N>/checkout (or legacy _dispatch<N>/checkout) absolute
// path under pmRoot — reuses dispatchNames' own legacy/crew layout resolution
// so this never diverges from the stall-scan's own container discovery.
function dispatchCheckouts(pmRoot: string): string[] {
  const { root, names } = dispatchNames(pmRoot);
  return names.map((name) => canonicalCompareKey(join(root, name, "checkout")));
}

// Every _crew/lanes/<slug> worktree that workspace_isolate actually created
// (has a sibling .meta/<slug>.json — a bare directory with no meta is not a
// real lane) under pmRoot. Best-effort: a missing lanes/ tree yields [].
function isolateLaneWorktrees(pmRoot: string): string[] {
  const lanesRoot = join(pmRoot, "_crew", "lanes");
  const metaDir = join(lanesRoot, ".meta");
  if (!existsSync(lanesRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(lanesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== ".meta")
      .map((e) => e.name);
  } catch { return []; }
  return entries
    .filter((slug) => existsSync(join(metaDir, `${slug}.json`)))
    .map((slug) => canonicalCompareKey(join(lanesRoot, slug)));
}

// Scans every `_crew/lanes/.meta/*.dispatch.json` record under pmRoot for an
// attended_record.ts-written (source:"attended_record") producer-profile record
// whose guard.worktree matches NEITHER a dispatch_prepare checkout nor a
// workspace_isolate lane. The SAME `.meta` directory also holds
// workspace_isolate's own `<slug>.json` and the lane-dispatch toolkit's
// `<slug>.dispatch.json` DispatchRecord (lane_common.ts) — both are filtered
// out by the `source` marker (only attended_record.ts writes it), so a
// legitimate PM-direct isolate-lane record is never misread as a bypass.
// Best-effort: a missing tree / corrupt record yields no entry (absence is not
// a false alarm).
export function scanBypassSpawns(pmRoot: string): BypassSpawn[] {
  const metaDir = join(pmRoot, "_crew", "lanes", ".meta");
  if (!existsSync(metaDir)) return [];
  let names: string[];
  try {
    names = readdirSync(metaDir).filter((n) => n.endsWith(".dispatch.json"));
  } catch { return []; }
  const sanctioned = [...dispatchCheckouts(pmRoot), ...isolateLaneWorktrees(pmRoot)];
  const out: BypassSpawn[] = [];
  for (const name of names) {
    const recordPath = join(metaDir, name);
    let record: {
      source?: string;
      lane_kind?: string;
      guard?: { permission_profile?: string; worktree?: string; agent_name?: string };
      attended?: { written_at?: string };
    };
    try { record = JSON.parse(readFileSync(recordPath, "utf8")); } catch { continue; }
    // Only an attended_record.ts record, and only its producer profile — gate
    // (guardian/observer) is a sanctioned no-worktree/read-only pattern and
    // must never be flagged here.
    if (record.source !== "attended_record") continue;
    if (record.guard?.permission_profile !== "producer") continue;
    const worktree = record.guard?.worktree;
    if (!worktree) continue;
    if (sanctioned.includes(canonicalCompareKey(worktree))) continue;
    out.push({
      agent: record.guard?.agent_name ?? name.replace(/\.dispatch\.json$/, ""),
      worktree,
      record_path: recordPath,
      written_at: record.attended?.written_at ?? null,
      // W-155: a declared PM-direct lane is surfaced but not a hard failure.
      advisory: record.lane_kind === "pm-direct",
    });
  }
  return out;
}

function buildBypassSpawnWarning(items: BypassSpawn[]): string {
  // W-155: split the hard bypasses (which flip ok) from the advisory declared
  // PM-direct lanes (which do not). Each block is emitted only when non-empty.
  const line = (it: BypassSpawn) =>
    `  - agent=${it.agent} worktree=${it.worktree}${it.written_at ? ` (written ${it.written_at})` : ""} record=${it.record_path}`;
  const hard = items.filter((it) => !it.advisory);
  const advisory = items.filter((it) => it.advisory);
  const L: string[] = [];
  if (hard.length > 0) {
    L.push(`BYPASS-SPAWN (W-139): ${hard.length} 個の producer attended_record が dispatch_prepare / workspace_isolate のどちらの worktree にも一致しません — dock 非追跡・isolated worktree 無しの bare spawn です:`);
    for (const it of hard) L.push(line(it));
    L.push(`gate = attended_record (read-only, no worktree) / worker = dispatch_prepare (dock) または workspace_isolate (isolated worktree) が正規経路です。該当 agent の作業を isolate lane (workspace_isolate.ts --slug <kebab>) へ移すか、dispatch_prepare 経由で container を発行し直してください。PM-direct lane を意図しているなら attended_record.ts --pm-direct で lane_kind を宣言してください (DEC-093、W-155)。`);
  }
  if (advisory.length > 0) {
    if (L.length > 0) L.push("");
    L.push(`PM-DIRECT (W-155, advisory): ${advisory.length} 個の lane_kind="pm-direct" attended_record — DEC-093 の正規 PM-direct lane です (ok には影響しません):`);
    for (const it of advisory) L.push(line(it));
  }
  return L.join("\n");
}

// ── idle-without-register / IDLE-NO-REGISTER (W-018) ──────────────────────────
// The "idle but no processed register" detective. A dispatched role is run-to-
// completion (there is no auto re-wake), and its ONE completion signal is the
// final register message (role_subagent_dispatch.md §6). Two idle shapes leave the
// PM with an unacknowledged dispatch it must WAKE by hand — the recurring friction
// this fixes (9 manual wakes on 2026-07-06: scout registers that never arrived,
// observer verdicts未着, worker completion nudges):
//   - REPORTING but the PM never processed a register (marker absent) — done-but-
//     unregistered, indistinguishable from a stall to a git-only watcher; wake it
//     to send the register (a gate role: to send its verdict register).
//   - WORKING but genuinely idle (a stall-suspect / post-commit-stall — fingerprint
//     stopped, NO live build) — wake it to continue or declare BLOCKED.
// The suppressor is a single new convention: when the PM processes a dispatch's
// register it touches `_dispatch<N>/register_received`; its presence removes the
// dispatch from this scan (pm SKILL / pm_playbook §3). Advisory like every sibling
// detective — it never flips the scan's ok/exit. Each item carries a ready-to-send
// `wake_cmd` (SendMessage `to` + a state-specific Japanese body) so the PM copies
// it verbatim instead of hand-writing a wake (the mechanization the friction wants).
export interface WakeCmd {
  to: string;      // SendMessage `to` — the target agent name
  message: string; // the ready-to-send Japanese wake body
}
export interface IdleNoRegister {
  dispatch: string;
  state: "REPORTING" | "WORKING";
  role: string | null;
  // reporting-no-register = a REPORTING producer whose register the PM never got.
  // working-stalled       = a WORKING producer idle with no live build.
  // gate-no-verdict       = a REPORTING gate role (guardian/observer) with no verdict.
  kind: "reporting-no-register" | "working-stalled" | "gate-no-verdict";
  wake_cmd: WakeCmd;
}

// The PM's acknowledgment marker: touched when the PM processes a dispatch's
// completion register. Present -> the register was received -> not IDLE-NO-REGISTER.
export function registerReceivedMarkerPath(container: string): string {
  return join(container, "register_received");
}

// context.json (FactPack) task.role — the dispatched role. null when unreadable.
function readDispatchRole(contextPath: string): string | null {
  if (!existsSync(contextPath)) return null;
  try {
    const pack = JSON.parse(readFileSync(contextPath, "utf8")) as { task?: { role?: string | null } };
    return pack.task?.role ? String(pack.task.role) : null;
  } catch { return null; }
}

// context.json gate_agents.<role>.name — the forward-supplied gate-role Agent name.
function readGateAgentName(contextPath: string, role: string): string | null {
  if (!existsSync(contextPath)) return null;
  try {
    const pack = JSON.parse(readFileSync(contextPath, "utf8")) as { gate_agents?: Record<string, { name?: string } | undefined> };
    const name = pack.gate_agents?.[role]?.name;
    return name ? String(name) : null;
  } catch { return null; }
}

// Same sanitize + 64-char truncate as dispatch_prepare.ts's AGENT_NAME and
// The SendMessage `to` for the wake. context.json carries no literal dispatched-
// role agent_name (only dispatch_prepare.ts's stdout JSON does), so DERIVE it the
// same way: every dispatch_prepare-launched role is the bare-Agent name
// `ga-<role>-<slug>` (W-042, user directive 2026-07-11 — worker/smith/librarian/
// artisan use their real role, not the retired `ga-produce-<slug>`); gate roles
// prefer the forward-supplied gate_agents name, else derive it the same way.
// Empty when the role/slug is unknown (the PM then addresses the agent by its
// board name by hand).
function idleWakeTarget(contextPath: string, role: string | null, slug: string | null): string {
  if (role === "guardian" || role === "observer") {
    return readGateAgentName(contextPath, role) ?? (slug ? seatAgentName(role, slug) : "");
  }
  return role && slug ? seatAgentName(role, slug) : "";
}

function buildReportingWake(dispatchId: string): string {
  return (
    `dispatch #${dispatchId} は REPORTING に達していますが完了 register が届いていません (register 受領 marker 不在)。` +
    `commit / STATE 更新だけでは完了 signal になりません — 最終 register message (最終 STATE / branch + commit SHA / ` +
    `report path / gate 結果 / 台帳 N/N consumed / BLOCKED 質問) を 1 通送ってください。`
  );
}

function buildWorkingWake(dispatchId: string): string {
  return (
    `dispatch #${dispatchId} は WORKING のまま停滞しています (fingerprint 停止・進行中の build/test process なし)。` +
    `作業を続行できるなら途中経過を 1 通、進められないなら BLOCKED を明示申告 (理由 + 必要な回答) してください。` +
    `沈黙のまま turn を終えないでください。`
  );
}

function buildGateWake(dispatchId: string, role: string, slug: string | null): string {
  return (
    `gate #${dispatchId} (${role}) の verdict register が届いていません。review 済みなら verdict marker ` +
    `(runtime/${role}/results/${slug ?? "<slug>"}-${role}.md の '## Verdict' 節に canonical token) を書き、` +
    `compact result を 1 通 register してください。`
  );
}

// Scans every `_dispatch<N>/` container for an idle dispatch with no processed
// register. REPORTING is flagged directly; WORKING only when it is a GENUINE idle
// stall (stall-suspect / post-commit-stall) — a live build (build-wait) or an
// unprobeable process table (unknown) is NEVER woken (the W-053 false-wake lesson,
// pinned in tests). Best-effort: a missing tree / unreadable file yields no entry.
export interface IdleScanOpts {
  nowMs?: number;
  spawnGraceSec?: number;
  // Pre-read set of live queue-waiter labels (W-143 #354); defaults to a fresh read
  // of the pm's heavy_compile_lock waiters dir.
  waiterLabels?: Set<string>;
}

export function scanIdleNoRegister(
  pmRoot: string,
  git: GitRunner = defaultGitRunner,
  lister: ProcessLister = defaultProcessLister,
  opts: IdleScanOpts = {},
): IdleNoRegister[] {
  const out: IdleNoRegister[] = [];
  if (!existsSync(pmRoot)) return out;
  const nowMs = opts.nowMs ?? Date.now();
  const graceSec = opts.spawnGraceSec ?? DEFAULT_STALL_SPAWN_GRACE_SEC;
  const waiterLabels = opts.waiterLabels ?? readActiveLockWaiterLabels(pmRoot, nowMs);
  const { root, prefix, names } = dispatchNames(pmRoot);
  for (const name of names) {
    const dispatchId = name.slice(prefix.length);
    const container = join(root, name);
    const statePath = join(container, "STATE.md");
    const contextPath = join(container, "context.json");
    if (!existsSync(statePath)) continue;
    if (existsSync(registerReceivedMarkerPath(container))) continue; // PM already processed the register
    const state = readStateStatus(readFileSync(statePath, "utf8"));
    const role = readDispatchRole(contextPath);
    const slug = readDispatchSlug(contextPath, statePath);
    if (state === "REPORTING") {
      const gateRole = role === "guardian" || role === "observer";
      out.push({
        dispatch: dispatchId, state: "REPORTING", role,
        kind: gateRole ? "gate-no-verdict" : "reporting-no-register",
        wake_cmd: {
          to: idleWakeTarget(contextPath, role, slug),
          message: gateRole ? buildGateWake(dispatchId, role!, slug) : buildReportingWake(dispatchId),
        },
      });
    } else if (state === "WORKING") {
      const checkout = join(container, "checkout");
      if (!existsSync(checkout)) continue;
      const baseSha = readBaseSha(contextPath);
      let commits: number | null = null;
      let dirty: boolean | null = null;
      if (baseSha !== null) {
        const rc = git(["rev-list", "--count", `${baseSha}..HEAD`], checkout);
        if (rc.code === 0) commits = parseInt(rc.stdout.trim(), 10);
      }
      const rd = git(["status", "--porcelain"], checkout);
      if (rd.code === 0) dirty = rd.stdout.trim().length > 0;
      if (!isStallCandidate(commits, dirty)) continue;
      const background = detectBackgroundActivity(resolve(checkout), lister);
      const judgement = classifyWorkingJudgement(commits, dirty, background);
      // ONLY a genuine idle stall is woken. build-wait / unknown must never fire.
      if (judgement !== "stall-suspect" && judgement !== "post-commit-stall") continue;
      // W-143: a fresh spawn/resume, or a live heavy-lock queue wait, looks exactly
      // like an idle stall (no build, flat fingerprint) but is a healthy producer —
      // never wake it (the #351/#352 read-phase + #354 lock-queue false wakes).
      if (isWorkingActiveNotStalled(container, slug, nowMs, graceSec, waiterLabels)) continue;
      out.push({
        dispatch: dispatchId, state: "WORKING", role,
        kind: "working-stalled",
        wake_cmd: { to: idleWakeTarget(contextPath, role, slug), message: buildWorkingWake(dispatchId) },
      });
    }
  }
  return out;
}

// "none" while escalation history has not been layered on (plain stallScan()
// output); a real level only appears once the CLI runs applyEscalation().
// "revive" is the top level (W-071): a sustained dormancy that calls for a fresh
// respawn, not a wake — see role_subagent_dispatch.md §6 REVIVE-NEEDED.
export type EscalationLevel = "none" | "nudge" | "handoff" | "revive";

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
  // The checkout HEAD sha, null when it could not be read. For a POST-COMMIT
  // stall (W-045) the tree is clean, so dirty_hash never moves — the tip sha is
  // what advances when a new commit lands, so it (not dirty_hash) is the
  // "progress moved" key escalation continuity uses for that judgement.
  tip_sha: string | null;
  background: "running" | "none" | "unknown";
  // stall-suspect  = WORKING, nothing committed, dirty tree, no live build (W-034).
  // post-commit-stall = WORKING, committed work, CLEAN tree, still not REPORTING,
  //   no live build (W-045) — a producer that finished coding + committing but
  //   fell asleep before writing its report / flipping STATE to REPORTING.
  // ungated-reporting = REPORTING, no Guardian/Observer verdict published yet
  //   (W-071 / W-086) — a finished-but-forgotten producer no one gated. Not a
  //   respawn case (the producer is DONE); the action is to gate it.
  judgement: "build-wait" | "stall-suspect" | "post-commit-stall" | "ungated-reporting" | "unknown";
  // watch coverage (W-085): "unwatched" only for a WORKING dispatch with no live
  // dispatch_watch heartbeat; ungated-REPORTING (DONE — gate it) is never flagged,
  // so it reads "watched". Advisory — does not affect `ok`.
  watch: WatchCoverage;
  suggested_nudge: string;
  escalation: EscalationLevel;
  escalation_elapsed_min: number | null;
  escalation_prompt: string;
}
export interface UnwatchedDetail {
  dispatch: string;
  // W-033: a ready-to-run `dispatch_watch.ts` (single mode) one-liner arming a
  // live watch on THIS dispatch — same convention as IdleNoRegister.wake_cmd /
  // UnprocessedResult.cleanup_cmd, mirroring dispatch_prepare.ts's own watch_cmd
  // construction so the PM never hand-composes --project/--pm-id/--id.
  watch_cmd: string;
}
export interface StallScanResult {
  ok: boolean;
  mode: "stall-scan";
  items: StallScanItem[];
  // W-085: ids of WORKING dispatches with no live watch heartbeat (a convenience
  // projection of items[].watch === "unwatched" — arm dispatch_watch on these).
  unwatched: string[];
  // W-033: same set as `unwatched`, each paired with a ready watch_cmd. Additive
  // sibling (kept `unwatched` as a plain string[] too — fleet_watch.ts's inline
  // JS keys/fingerprints directly off those raw ids).
  unwatched_detail: UnwatchedDetail[];
}

// stallScan tuning (W-085): injectable now + stale window + heartbeats so the
// UNWATCHED boundary is pinned in tests without a real wall-clock wait or on-disk
// markers. All optional — the defaults read the wall clock and the heartbeats dir.
export interface StallScanOpts {
  nowMs?: number;
  unwatchedAfterMs?: number;
  heartbeats?: WatchHeartbeat[];
  // W-143: spawn/resume grace + live queue-waiter labels — a WORKING dispatch that
  // matches either is reclassified build-wait (a healthy producer, not a stall).
  spawnGraceSec?: number;
  waiterLabels?: Set<string>;
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

// W-045: a producer that committed its work and left a clean tree but never
// flipped STATE to REPORTING / wrote report.md, with no live build. The work is
// SAFE (already committed) — the gap is only the close-out — so the nudge points
// at finishing the report rather than at inspecting an uncommitted diff.
function buildPostCommitStallNudge(dispatchId: string, container: string): string {
  return [
    `dispatch #${dispatchId} が post-commit stall 疑いです (STATE=WORKING, commit 済み, tree clean, REPORTING 未達, 進行中の build/test process なし)。`,
    `実装は commit 済みなので保全されています。残りは close-out のみ:`,
    `- ${container}/checkout の commit 内容を確認する (git log --oneline / git show)`,
    `- agent がまだ生きていれば「quality gate を回し、report.md を書き、STATE.md を REPORTING にする」よう促す`,
    `- 反応がなければ respawn-handoff (contract_check.ts --stall-scan --handoff ${dispatchId}) で` +
      `打切り通告 + 引継ぎ prompt を生成し、commit 済みの成果を次の担当が gate/report して締める`,
  ].join("\n");
}

// W-071 / W-086: a REPORTING dispatch whose gate verdict was never published is a
// finished-but-forgotten producer no one picked up for the merge pipeline. The
// producer is DONE, so the fix is to GATE it (not respawn) — the nudge points at
// the Guardian→Observer merge path, not at inspecting a worktree.
function buildUngatedReportingNudge(dispatchId: string, container: string, slug: string | null): string {
  return [
    `dispatch #${dispatchId} は REPORTING ですが gate 未実施です (Guardian/Observer の verdict 不在 — W-086 の盲点: 完了したのに誰も gate せず放置)。`,
    `producer は完了しています。残りは gate → merge:`,
    `- ${container}/report.md と成果 (git log --oneline) を確認する`,
    `- Guardian → Observer の gate を回し、merge_request.ts で studio へ統合する${slug ? ` (slug: ${slug})` : ""}`,
    `- respawn は不要です (producer は dead ではなく DONE)`,
  ].join("\n");
}

// The dispatch's slug — for the ungated-REPORTING gate-result lookup and nudge.
// Prefer context.json task.slug; fall back to the 2nd token of the STATE.md
// "## Current task" line (`#<id> <slug> (<branch>)`, as dispatch_prepare writes it).
function readDispatchSlug(contextPath: string, statePath: string): string | null {
  if (existsSync(contextPath)) {
    try {
      const pack = JSON.parse(readFileSync(contextPath, "utf8")) as { task?: { slug?: string | null } };
      if (pack.task?.slug) return String(pack.task.slug);
    } catch { /* fall through to STATE.md */ }
  }
  if (existsSync(statePath)) {
    const lines = readFileSync(statePath, "utf8").split(/\r?\n/);
    const i = lines.findIndex((l) => /^##\s*Current task\b/i.test(l));
    if (i >= 0) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t.length > 0) return t.split(/\s+/)[1] ?? null;
      }
    }
  }
  return null;
}

// The dispatch's branch — for the UNWATCHED single-heartbeat match (W-085). Prefer
// context.json task.branch; fall back to the parenthesized branch in the STATE.md
// "## Current task" line (`#<id> <slug> (<branch>)`, as dispatch_prepare writes it).
function readDispatchBranch(contextPath: string, statePath: string): string | null {
  if (existsSync(contextPath)) {
    try {
      const pack = JSON.parse(readFileSync(contextPath, "utf8")) as { task?: { branch?: string | null } };
      if (pack.task?.branch) return String(pack.task.branch);
    } catch { /* fall through to STATE.md */ }
  }
  if (existsSync(statePath)) {
    const lines = readFileSync(statePath, "utf8").split(/\r?\n/);
    const i = lines.findIndex((l) => /^##\s*Current task\b/i.test(l));
    if (i >= 0) {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t.length > 0) { const m = t.match(/\(([^)]+)\)\s*$/); return m ? m[1] : null; }
      }
    }
  }
  return null;
}

// A REPORTING dispatch is "gated" (in the merge pipeline, out of the stall sweep)
// once ANY Guardian/Observer verdict marker exists for its slug. An unknown slug
// cannot be confirmed gated, so it errs toward flagging (returns false).
function gateVerdictPublished(pmRoot: string, slug: string | null): boolean {
  if (!slug) return false;
  for (const role of ["guardian", "observer"]) {
    if (existsSync(join(pmRoot, "runtime", role, "results", `${slug}-${role}.md`))) return true;
  }
  return false;
}

// The pre/post-commit stall CANDIDATE shape (W-034/W-045): nothing committed on a
// dirty tree, OR committed work on a clean tree. A WORKING container outside this
// shape (e.g. committed but still dirty = actively editing) is not worth judging.
export function isStallCandidate(commits: number | null, dirty: boolean | null): boolean {
  return (commits === 0 && dirty === true) || (commits !== null && commits > 0 && dirty === false);
}

// Classify a WORKING stall candidate from its background-activity probe. The SINGLE
// source for the "genuine idle stall vs live build" call shared by stallScan and
// scanIdleNoRegister (W-018) — do not diverge the definition. A non-candidate, a
// live build, or an unprobeable process table is never asserted as a stall (the
// W-053 false-wake lesson: an unverifiable idle notification is not a stall).
export function classifyWorkingJudgement(
  commits: number | null,
  dirty: boolean | null,
  background: "running" | "none" | "unknown",
): "build-wait" | "stall-suspect" | "post-commit-stall" | "unknown" {
  if (!isStallCandidate(commits, dirty)) return "unknown";
  if (background === "running") return "build-wait";
  if (background === "none") return commits === 0 ? "stall-suspect" : "post-commit-stall";
  return "unknown";
}

// W-143: the default spawn/resume grace both stall detectives honour (matches
// dispatch_watch's --spawn-grace-sec default). A WORKING dispatch younger than this
// (by its container's dispatched_at/resumed_at marker) is READING, not stalled.
export const DEFAULT_STALL_SPAWN_GRACE_SEC = 600;

// W-143 sub-case (#354): the labels of the heavy_compile_lock QUEUE WAITERS that are
// currently live. heavy_compile_lock refreshes a `waiter-<pid>.json` heartbeat each
// poll while it queue-waits; a waiter whose heartbeat is fresh (within staleMs) is a
// healthy producer blocked on the lock, NOT a stall. A stale heartbeat (a killed
// waiter) reads as absent, exactly like the watch-heartbeat staleness rule. Labelled
// by the acquire's `--label` (the gate passes the dispatch slug), so the stall scan
// correlates a waiter to a dispatch by slug. Best-effort: a missing dir / unreadable
// file yields no label rather than throwing.
export function readActiveLockWaiterLabels(pmRoot: string, nowMs: number, staleMs = 180_000): Set<string> {
  const labels = new Set<string>();
  const dir = join(pmRoot, "runtime", "locks", "heavy_compile", "waiters");
  if (!existsSync(dir)) return labels;
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return labels; }
  for (const name of names) {
    try {
      const raw = readFileSync(join(dir, name), "utf8");
      const label = raw.match(/"label"\s*:\s*"([^"]*)"/)?.[1] ?? "";
      const ts = parseInt(raw.match(/"ts_epoch"\s*:\s*(\d+)/)?.[1] ?? "", 10);
      if (label && Number.isFinite(ts) && nowMs / 1000 - ts < staleMs / 1000) labels.add(label);
    } catch { /* unreadable waiter — treat as absent */ }
  }
  return labels;
}

// A WORKING dispatch that is NOT a genuine idle stall because it is still inside its
// spawn/resume grace OR is actively queue-waiting on the heavy-compile lock. Shared
// by both detectives so the definition never diverges (W-143).
export function isWorkingActiveNotStalled(
  container: string, slug: string | null, nowMs: number, graceSec: number, waiterLabels: Set<string>,
): boolean {
  if (withinSpawnGrace(containerSpawnEpoch(container), Math.floor(nowMs / 1000), graceSec)) return true;
  return !!slug && waiterLabels.has(slug);
}

// Scans every `_dispatch<N>/` container directly under `<pmRoot>` (mirrors the
// _dispatch<N> layout dispatch_prepare.ts creates). Candidates are STATE.md=WORKING
// (the stall classes) and STATE.md=REPORTING-but-UNGATED (W-071 / W-086 — a
// finished producer no gate picked up); BLOCKED/IDLE and GATED REPORTING are out
// of scope. Within a WORKING container, the stall-suspect CANDIDATE condition is
// commits===0 AND dirty===true (backlog W-034 design) — a WORKING container with
// either a commit already or a clean checkout is not yet worth flagging either way.
export function stallScan(
  pmRoot: string,
  git: GitRunner = defaultGitRunner,
  lister: ProcessLister = defaultProcessLister,
  opts: StallScanOpts = {},
): StallScanResult {
  const nowMs = opts.nowMs ?? Date.now();
  const unwatchedAfterMs = opts.unwatchedAfterMs ?? 60 * 60_000; // W-085 stale window
  const heartbeats = opts.heartbeats ?? readWatchHeartbeats(pmRoot);
  const graceSec = opts.spawnGraceSec ?? DEFAULT_STALL_SPAWN_GRACE_SEC; // W-143
  const waiterLabels = opts.waiterLabels ?? readActiveLockWaiterLabels(pmRoot, nowMs); // W-143
  const items: StallScanItem[] = [];
  if (existsSync(pmRoot)) {
    const { root, prefix, names } = dispatchNames(pmRoot);
    const dirs = names.sort((a, b) => parseInt(a.slice(prefix.length), 10) - parseInt(b.slice(prefix.length), 10));
    for (const name of dirs) {
      const dispatchId = name.slice(prefix.length);
      const container = join(root, name);
      const statePath = join(container, "STATE.md");
      const checkout = join(container, "checkout");
      const contextPath = join(container, "context.json");

      const state = existsSync(statePath) ? readStateStatus(readFileSync(statePath, "utf8")) : null;
      // Candidates: WORKING (the stall classes) and REPORTING that is still
      // UNGATED (W-071 / W-086). A gated REPORTING is in the merge pipeline; a
      // BLOCKED/IDLE/other state is out of scope.
      let slug: string | null = null;
      let ungatedReporting = false;
      if (state === "REPORTING") {
        slug = readDispatchSlug(contextPath, statePath);
        if (gateVerdictPublished(pmRoot, slug)) continue;
        ungatedReporting = true;
      } else if (state !== "WORKING") {
        continue;
      }

      let commits: number | null = null;
      let dirty: boolean | null = null;
      let dirtyHash: string | null = null;
      let tipSha: string | null = null;
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
        const rh = git(["rev-parse", "HEAD"], checkout);
        if (rh.code === 0) tipSha = rh.stdout.trim() || null;
      }

      // Two independent candidate classes (mutually exclusive on the commit
      // count) via isStallCandidate. PRE-commit (W-034): nothing committed +
      // dirty tree — the classic "implemented but idle before committing" stall.
      // POST-commit (W-045): committed work + CLEAN tree, still WORKING — a
      // producer that finished coding + committing but fell asleep before writing
      // report.md / flipping STATE to REPORTING. Both are only worth judging when
      // no live build explains the silence; classifyWorkingJudgement makes the
      // "build-wait vs stall vs unknown" call (never mis-assert — W-053).
      let background: StallScanItem["background"] = "unknown";
      let judgement: StallScanItem["judgement"] = "unknown";
      if (ungatedReporting) {
        // The producer is DONE — no build-wait probe applies; the gap is the
        // ungated gate, surfaced directly (W-071 / W-086).
        judgement = "ungated-reporting";
      } else if (isStallCandidate(commits, dirty)) {
        background = detectBackgroundActivity(resolve(checkout), lister);
        judgement = classifyWorkingJudgement(commits, dirty, background);
        // W-143: a fresh spawn/resume or a live heavy-lock queue wait is a healthy
        // producer, not a stall — reclassify to build-wait so it never becomes
        // actionable (the #351/#352 read-phase + #354 lock-queue false flags).
        if ((judgement === "stall-suspect" || judgement === "post-commit-stall")
          && isWorkingActiveNotStalled(container, readDispatchSlug(contextPath, statePath), nowMs, graceSec, waiterLabels)) {
          judgement = "build-wait";
        }
      }

      const suggestedNudge =
        judgement === "stall-suspect" ? buildStallNudge(dispatchId, container)
        : judgement === "post-commit-stall" ? buildPostCommitStallNudge(dispatchId, container)
        : judgement === "ungated-reporting" ? buildUngatedReportingNudge(dispatchId, container, slug)
        : "";
      // UNWATCHED (W-085) applies only to a WORKING dispatch (an ungated-REPORTING
      // producer is DONE — the action is to gate it, not watch it). A WORKING
      // dispatch with no live dispatch_watch heartbeat is "unwatched".
      let watch: WatchCoverage = "watched";
      if (state === "WORKING") {
        const branch = readDispatchBranch(contextPath, statePath);
        watch = detectWatchCoverage(heartbeats, dispatchId, branch, nowMs, unwatchedAfterMs);
      }
      items.push({
        dispatch: dispatchId, state, commits, dirty, dirty_hash: dirtyHash, tip_sha: tipSha, background, judgement,
        watch,
        suggested_nudge: suggestedNudge,
        escalation: "none", escalation_elapsed_min: null, escalation_prompt: "",
      });
    }
  }
  return {
    // `ok` intentionally excludes watch coverage (W-085 is advisory — see the
    // watch-coverage note above); only genuine stalls / ungated REPORTING flip it.
    ok: !items.some((i) => i.judgement === "stall-suspect" || i.judgement === "post-commit-stall" || i.judgement === "ungated-reporting"),
    mode: "stall-scan",
    items,
    unwatched: items.filter((i) => i.watch === "unwatched").map((i) => i.dispatch),
    unwatched_detail: items.filter((i) => i.watch === "unwatched").map((i) => ({
      dispatch: i.dispatch, watch_cmd: buildWatchCmd(pmRoot, i.dispatch),
    })),
  };
}

// W-033: same dispatch_prepare.ts watch_cmd shape (`dispatch_watch.ts --project
// <p> --pm-id <id> --id <n>`), reconstructed here for a dispatch that is ALREADY
// unwatched (dispatch_prepare's own watch_cmd was for arming it at spawn time —
// this is the detective-side equivalent for a watch that lapsed or was never
// armed). `--target-root` is intentionally omitted: dispatch_watch.ts already
// falls back to `--project` when absent, and stallScan (unlike
// scanUnprocessedResults) has no archived request to read a target_root from.
function buildWatchCmd(pmRoot: string, dispatchId: string): string {
  const project = dirname(dirname(pmRoot));
  const pmId = basename(pmRoot);
  const script = join(SCRIPTS_DIR, "dispatch_watch.ts");
  return `bun "${script}" --project "${project}" --pm-id ${pmId} --id ${dispatchId}`;
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
  if (item.judgement !== "stall-suspect" && item.judgement !== "post-commit-stall") {
    L.push(`NOTE: this dispatch was NOT classified as a stall (${item.judgement}) — confirm it is genuinely idle before terminating it.`);
  }
  const postCommit = item.judgement === "post-commit-stall";
  L.push("");
  L.push("## 打切り通告 (旧 producer が応答すれば送る)");
  if (postCommit) {
    L.push(`dispatch #${item.dispatch} は commit 済み・tree clean だが REPORTING に到達せず (進行中の build/test process なし) 打ち切ります。`);
    L.push(`${container}/checkout の commit 済み成果は削除しません。次の担当が gate/report して締めます。`);
  } else {
    L.push(`dispatch #${item.dispatch} は進捗が確認できない (未commit + 進行中の build/test process なし) ため打ち切ります。`);
    L.push(`${container}/checkout の部分実装は削除しません。次の担当が確認・再開します。`);
  }
  L.push("");
  L.push("## 引継ぎ prompt (次の subagent へそのまま渡す)");
  L.push(`RESUME in the EXISTING worktree ${container}/checkout (do NOT run dispatch_prepare again).`);
  if (postCommit) {
    L.push(`A prior producer here (dispatch #${item.dispatch}) committed its work but went idle before closing out ` +
      `(no report.md / STATE still WORKING). FIRST read STATE.md and inspect the committed work ` +
      `(git log --oneline, git show) before doing anything else.`);
    L.push(`If the committed work is complete and on-track for the assignment, run the quality gate in the ` +
      `FOREGROUND, then write report.md and set STATE.md to REPORTING. If it is incomplete, continue it, ` +
      `re-run the gate, commit, and close out the same way.`);
  } else {
    L.push(`A prior producer here (dispatch #${item.dispatch}) went idle without committing. FIRST read STATE.md ` +
      `and inspect the uncommitted diff (git status / git diff) before doing anything else.`);
    L.push(`If the partial diff is on-track for the assignment, continue it, run the quality gate in the ` +
      `FOREGROUND, commit, and update STATE.md/report.md. If it looks like a false start or unrelated, discard ` +
      `it (git checkout -- . && git clean -fd) and re-implement from the assignment.`);
  }
  L.push(`While waiting on a long build, send ONE progress message instead of going silent — that omission is ` +
    `what caused this handoff.`);
  L.push(`Delivery (W-146): send your register AND every progress message via SendMessage to your reporting ` +
    `channel (Dock / team-lead). A resume seat's PLAIN-TEXT final output is not reliably delivered to the lead, so ` +
    `a turn that ends with plain text alone reads as IDLE even when the work is healthy (the #351 mis-wake this ` +
    `handoff keeps hitting). Plain text is not a completion signal; the SendMessage is.`);
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
  // W-045: recorded alongside dirty_hash so post-commit-stall continuity can key
  // on the commit tip (its tree is clean, so dirty_hash is constant and useless
  // as a progress signal). Optional for back-compat with pre-W-045 history files.
  tip_sha?: string | null;
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

// ── session-resume detection (W-071) ─────────────────────────────────────────
// An attended PM IS the session, so while the session is paused nothing watches
// the producers (only the driver polls continuously). On resume, a large
// wall-clock gap since the last scan means the fleet may have gone dormant
// unseen — and an in-process teammate is NOT restored by /resume (official), so
// the correct response is a FRESH respawn from the worktree, never a wake. Each
// --stall-scan persists its timestamp; the next scan compares against it.
export interface SessionResumeInfo {
  gap_hours: number;
  message: string;
}

// null when there is no prior scan (first run) or the gap is under the threshold.
// Pure + injectable-time so the boundary is pinned without a real wall-clock wait.
export function detectSessionResume(
  lastScanMs: number | null,
  nowMs: number,
  resumeGapMs: number,
): SessionResumeInfo | null {
  if (lastScanMs === null) return null;
  const gapMs = nowMs - lastScanMs;
  if (gapMs < resumeGapMs) return null;
  const gapHours = gapMs / 3_600_000;
  return {
    gap_hours: Number(gapHours.toFixed(1)),
    message:
      `SESSION-RESUME: 前回 scan から ${gapHours.toFixed(1)}h 経過 — session pause 中は監視が止まり、` +
      `in-process teammate は全喪失します (公式: /resume は teammate を復元しない)。respawn required: ` +
      `dormant producer を worktree/STATE.md から FRESH respawn し、re-dispatch してください (wake 不可)。`,
  };
}

export function loadLastScanMs(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { ts_ms?: number };
    return typeof parsed.ts_ms === "number" ? parsed.ts_ms : null;
  } catch { return null; }
}

export function saveLastScanMs(path: string, tsMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ts_ms: tsMs }) + "\n", "utf8");
}

// The no-progress evidence phrase differs by judgement: a stall-suspect is
// pinned by its unchanged dirty diff, a post-commit-stall by its unchanged
// commit tip (its tree is already clean). W-045.
function noProgressEvidenceJa(item: StallScanItem): string {
  return item.judgement === "post-commit-stall"
    ? "同一判定 + commit tip 不変"
    : "同一判定 + checkout diff 不変";
}

function buildEscalationNudge(item: StallScanItem, elapsedMin: number): string {
  return [
    `[escalation: nudge] dispatch #${item.dispatch} は ${item.judgement} のまま ${Math.floor(elapsedMin)} 分継続しています` +
      ` (${noProgressEvidenceJa(item)} — 進捗が無いことを意味します)。至急ようすを確認してください。`,
    item.suggested_nudge,
  ].join("\n\n");
}

function buildEscalationHandoffPrompt(item: StallScanItem, container: string, elapsedMin: number): string {
  return (
    `[escalation: handoff] dispatch #${item.dispatch} は ${item.judgement} のまま ${Math.floor(elapsedMin)} 分継続` +
    ` (handoff しきい値到達)。手動介入なしで以下の respawn-handoff prompt を使用してください:\n\n` +
    buildHandoffPrompt(item, container)
  );
}

// W-071: the LOUD top level. A producer flat this long is DORMANT (not building);
// the only correct action is a FRESH respawn from the worktree — a /resume does
// NOT restore an in-process teammate (official, role_subagent_dispatch.md §6). The
// token "REVIVE-NEEDED" is the shared taxonomy term dispatch_watch --fleet also
// emits, so both tools are greppable with one word.
function buildReviveEscalationPrompt(item: StallScanItem, container: string, elapsedMin: number): string {
  return (
    `[escalation: REVIVE-NEEDED] dispatch #${item.dispatch} は ${item.judgement} のまま ${Math.floor(elapsedMin)} 分継続` +
    ` (${noProgressEvidenceJa(item)} — 長時間 dormant)。producer は事実上 dead です。wake ではなく worktree から` +
    ` FRESH respawn 一択です (公式: /resume は in-process teammate を復元しない)。以下の respawn-handoff prompt を使用してください:\n\n` +
    buildHandoffPrompt(item, container)
  );
}

export interface EscalationOptions {
  nudgeAfterMin: number;
  handoffAfterMin: number;
  reviveAfterMin: number;
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
    // Both stall judgements escalate on the same clock; any other judgement
    // (build-wait / unknown) — or the same judgement with its progress signal
    // moved — resets the clock (W-034/W-037, extended to post-commit by W-045).
    if (item.judgement !== "stall-suspect" && item.judgement !== "post-commit-stall") {
      return { ...item, escalation: "none", escalation_elapsed_min: null, escalation_prompt: "" };
    }
    const hash = item.dirty_hash ?? "";
    const tip = item.tip_sha ?? "";
    // Continuity key is the judgement-appropriate "did progress move" signal:
    // the dirty diff for a stall-suspect, the commit tip for a post-commit-stall
    // (whose tree is clean, so its dirty diff never moves — keying on it would
    // make the clock immortal). Judgement must also match, so a dispatch that
    // flips between the two classes restarts its clock.
    const priorKey = item.judgement === "post-commit-stall" ? (history[item.dispatch]?.tip_sha ?? "") : (history[item.dispatch]?.dirty_hash ?? "");
    const curKey = item.judgement === "post-commit-stall" ? tip : hash;
    const prior = history[item.dispatch];
    const continued = prior !== undefined && prior.judgement === item.judgement && priorKey === curKey;
    const since = continued ? prior.since_ms : opts.nowMs;
    nextHistory[item.dispatch] = { judgement: item.judgement, dirty_hash: hash, tip_sha: tip, since_ms: since, last_seen_ms: opts.nowMs };

    const elapsedMin = (opts.nowMs - since) / 60_000;
    let escalation: EscalationLevel = "none";
    let prompt = "";
    // Ladder highest-first (revive > handoff > nudge). Revive is the sustained-
    // dormancy respawn level (W-071); it supersedes handoff so a truly dead
    // producer is not merely handed off but explicitly respawned-not-woken.
    if (elapsedMin >= opts.reviveAfterMin) {
      escalation = "revive";
      prompt = buildReviveEscalationPrompt(item, containerOf(item.dispatch), elapsedMin);
    } else if (elapsedMin >= opts.handoffAfterMin) {
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
// dispatch_prepare.ts writes it and dispatch_prepare guard reads it).
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
function resolveProject(): string {
  const p = arg("project") ?? process.env.GARELIER_PROJECT;
  return p ? resolve(p) : process.cwd();
}

// W-087: the blueprint 到達構成 declared on the CLI as --reach-crate / --reach-artifact
// / --reach-consumer (each a comma-separated name list). Each name's presence is
// resolved against the dispatch checkout by checkClose.
function parseReachDecls(): ReachabilityDecl[] {
  const out: ReachabilityDecl[] = [];
  const add = (flagName: string, kind: ReachabilityDecl["kind"]) => {
    const raw = arg(flagName);
    if (!raw) return;
    for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) out.push({ kind, name });
  };
  add("reach-crate", "crate");
  add("reach-artifact", "artifact");
  add("reach-consumer", "consumer");
  return out;
}

type StallScanOutput = StallScanResult & {
  handoff_dispatch?: string;
  handoff_prompt?: string | null;
  handoff_error?: string;
  // W-053: touches / depends_on / pairwise conflicts across ALL active
  // dispatches (not only the WORKING stall candidates in `items`), so the PM
  // reads the parallel-collision landscape alongside the stall verdicts.
  touch_map?: TouchMapEntry[];
  // W-071: present when the wall-clock gap since the previous scan exceeded
  // --resume-gap-hours — a session-resume that requires respawn, not wake.
  session_resume?: SessionResumeInfo;
  // W-086: landed (success) merges whose workbench branch was never cleaned up —
  // aftercare that stalled because the result waiter was not armed. Advisory.
  unprocessed_results?: UnprocessedResult[];
  // W-092: REPORTING dispatches whose instruction ledger still has an unchecked
  // entry — a mid-flight PM instruction the producer never consumed. Advisory.
  unconsumed_instructions?: UnconsumedInstructions[];
  // W-018: idle dispatches with no processed register (REPORTING done-but-
  // unregistered, or a genuinely stalled WORKING) — each carries a ready-to-send
  // wake_cmd. Advisory: the PM wakes each, then touches its register_received marker.
  idle_no_register?: IdleNoRegister[];
  // W-139: producer-profile attended_record(s) whose granted worktree matches
  // neither a dispatch_prepare checkout nor a workspace_isolate lane — a bare
  // bypass spawn. A HARD entry (advisory=false) flips `ok` (below) — a completed
  // boundary violation, not a coverage gap. W-155: a declared PM-direct entry
  // (advisory=true, lane_kind:"pm-direct") is surfaced here but does NOT flip ok.
  bypass_spawns?: BypassSpawn[];
};

function main(): void {
  printHelpAndExitIfRequested(
    "contract_check — verify a dispatch/gate handoff contract, or scan for stalled roles.\n" +
    "usage: contract_check --pm-id <id> (--dispatch <N> | --gate <slug> | --stall-scan) [--project <path>]\n" +
    "       [--format json|text] [--roles <csv>] [--handoff <path>] [--nudge-after <n>] [--revive-after <n>]\n" +
    "       [--handoff-after <n>] [--resume-gap-hours <n>] [--unwatched-after <n>] [--unprocessed-window-hours <n>]",
  );
  const project = resolveProject();
  const pmId = arg("pm-id") ?? process.env.GARELIER_PM_ID;
  const dispatch = arg("dispatch");
  const gate = arg("gate");
  const stallScanFlag = process.argv.includes("--stall-scan");
  const closeFlag = process.argv.includes("--close");
  const handoff = arg("handoff");
  const format = (arg("format") ?? "json").toLowerCase();

  if (!pmId) { console.error("contract_check: --pm-id <id> required"); process.exit(2); return; }
  const modeCount = [dispatch !== undefined, gate !== undefined, stallScanFlag].filter(Boolean).length;
  if (modeCount !== 1) {
    console.error("contract_check: exactly one of --dispatch <N>, --gate <slug>, or --stall-scan required");
    process.exit(2); return;
  }
  if (closeFlag && dispatch === undefined) {
    console.error("contract_check: --close requires --dispatch <N> (the dispatch to close-check)");
    process.exit(2); return;
  }
  if (handoff !== undefined && !stallScanFlag) {
    console.error("contract_check: --handoff requires --stall-scan");
    process.exit(2); return;
  }

  const pmRoot = join(project, "__garelier", pmId);
  let result: ContractResult | StallScanOutput | CloseResult;
  if (dispatch !== undefined) {
    const n = dispatch.replace(/^#/, "");
    if (closeFlag) {
      result = checkClose(dispatchContainer(pmRoot, n), {
        reach: parseReachDecls(),
        runArtifact: arg("run-artifact") ?? null,
        visualVerdict: arg("visual-verdict") ?? null,
        runtimeEffectOverride: arg("runtime-effect") ?? null,
      });
    } else {
      result = checkProducer(dispatchContainer(pmRoot, n));
    }
  } else if (gate !== undefined) {
    const roles = (arg("roles") ?? "guardian,observer").split(",").map((s) => s.trim()).filter(Boolean);
    result = checkGate(join(pmRoot, "runtime"), gate!, roles);
  } else {
    const nowMs = Date.now();
    // The process-table snapshot is the expensive probe (a PowerShell CIM query on
    // Windows). stallScan AND scanIdleNoRegister (W-018) both need it for their
    // WORKING candidates — take it AT MOST ONCE, lazily (nothing when there is no
    // candidate), and share the same snapshot between them so the added detective
    // never doubles the cost.
    let procSnapshot: string[] | null | undefined;
    const sharedLister: ProcessLister = () => {
      if (procSnapshot === undefined) procSnapshot = defaultProcessLister();
      return procSnapshot;
    };
    // W-143: --spawn-grace-sec (default 600) + the live heavy-lock queue-waiter set,
    // read ONCE and shared between both detectives so a fresh spawn/resume or a
    // queued build is never flagged as a stall (the #351/#352/#354 false wakes).
    const spawnGraceSec = numArg("spawn-grace-sec", DEFAULT_STALL_SPAWN_GRACE_SEC);
    const waiterLabels = readActiveLockWaiterLabels(pmRoot, nowMs);
    // W-085: --unwatched-after <min> (default 60) is the stale window past which a
    // watch heartbeat is treated as dead (UNWATCHED). Advisory — see StallScanResult.
    const scan: StallScanOutput = stallScan(pmRoot, defaultGitRunner, sharedLister, {
      nowMs,
      unwatchedAfterMs: numArg("unwatched-after", 60) * 60_000,
      spawnGraceSec,
      waiterLabels,
    });
    const historyPath = join(pmRoot, "runtime", "dispatch", "stall_scan_history.json");
    const nudgeAfterMin = numArg("nudge-after", 10);
    const handoffAfterMin = numArg("handoff-after", 25);
    const reviveAfterMin = numArg("revive-after", 30);
    const esc = applyEscalation(
      scan.items,
      loadStallHistory(historyPath),
      { nudgeAfterMin, handoffAfterMin, reviveAfterMin, nowMs },
      (id) => dispatchContainer(pmRoot, id),
    );
    saveStallHistory(historyPath, esc.history);
    scan.items = esc.items;
    // W-071: session-resume — a large wall-clock gap since the previous scan.
    const lastScanPath = join(pmRoot, "runtime", "dispatch", "last_scan.json");
    const resumeGapMs = numArg("resume-gap-hours", 2) * 3_600_000;
    const resume = detectSessionResume(loadLastScanMs(lastScanPath), nowMs, resumeGapMs);
    if (resume) scan.session_resume = resume;
    saveLastScanMs(lastScanPath, nowMs);
    // W-053: attach the touch/conflict landscape across every active dispatch.
    scan.touch_map = buildTouchMap(scanActiveDispatches(pmRoot));
    // W-086: post-merge aftercare — landed merges whose workbench branch was never
    // cleaned up (a forgotten result waiter left the aftercare stalled).
    scan.unprocessed_results = scanUnprocessedResults(pmRoot, defaultGitRunner, {
      nowMs,
      windowHours: numArg("unprocessed-window-hours", 24),
    });
    // W-092: REPORTING dispatches whose instruction ledger has an unchecked entry.
    scan.unconsumed_instructions = scanUnconsumedInstructions(pmRoot);
    // W-018: idle dispatches with no processed register — each with a wake_cmd.
    // Shares the single process snapshot with stallScan above (no double probe).
    scan.idle_no_register = scanIdleNoRegister(pmRoot, defaultGitRunner, sharedLister, { nowMs, spawnGraceSec, waiterLabels });
    // W-139: producer-profile attended_record(s) with no matching dispatch
    // container / isolate lane — a bare bypass spawn. A HARD bypass flips `ok`
    // (a completed boundary violation). W-155: a record that declared
    // `lane_kind: "pm-direct"` is a sanctioned PM-direct lane (DEC-093) — it is
    // surfaced (advisory=true) but does NOT flip ok; only a non-advisory entry does.
    scan.bypass_spawns = scanBypassSpawns(pmRoot);
    if (scan.bypass_spawns.some((b) => !b.advisory)) scan.ok = false;
    if (handoff !== undefined) {
      const hid = handoff.replace(/^#/, "");
      const item = scan.items.find((i) => i.dispatch === hid);
      scan.handoff_dispatch = hid;
      if (item) {
        scan.handoff_prompt = buildHandoffPrompt(item, dispatchContainer(pmRoot, hid));
      } else {
        scan.handoff_prompt = null;
        scan.handoff_error = `dispatch #${hid} not found among WORKING / ungated-REPORTING containers in this stall-scan`;
      }
    }
    result = scan;
  }

  if (format === "text") {
    if (result.mode === "stall-scan") {
      // W-071: the session-resume banner comes FIRST — it is the loudest signal
      // and reframes every verdict below it as "respawn, not wake".
      if (result.session_resume) console.log(result.session_resume.message + "\n");
      console.log(`stall-scan: ${result.items.length} dispatch(es) (WORKING + ungated REPORTING)`);
      for (const it of result.items) {
        const escSuffix = it.escalation !== "none" ? ` escalation=${it.escalation} (${Math.floor(it.escalation_elapsed_min ?? 0)}min)` : "";
        console.log(`  #${it.dispatch}: state=${it.state} commits=${it.commits ?? "?"} dirty=${it.dirty ?? "?"} background=${it.background} judgement=${it.judgement} watch=${it.watch}${escSuffix}`);
        if (it.escalation !== "none") console.log(it.escalation_prompt.split("\n").map((l) => "    " + l).join("\n"));
        else if (it.judgement === "stall-suspect" || it.judgement === "post-commit-stall" || it.judgement === "ungated-reporting") console.log(it.suggested_nudge.split("\n").map((l) => "    " + l).join("\n"));
      }
      // W-085: WORKING dispatches with no live watch — arm dispatch_watch on each.
      // W-033: each carries a ready-to-run watch_cmd (run_in_background it verbatim
      // — no need to hunt down the original dispatch_prepare JSON or hand-compose
      // the args).
      if (result.unwatched.length > 0) {
        console.log(`\nUNWATCHED (W-085): ${result.unwatched.length} WORKING dispatch(es) with no live dispatch_watch heartbeat: #${result.unwatched.join(" #")}`);
        for (const d of result.unwatched_detail) console.log(`  #${d.dispatch}: ${d.watch_cmd}`);
        console.log(`  run each watch_cmd with run_in_background, or run the fleet watch (dispatch_watch.ts --fleet). See pm_playbook.md §3/§11.`);
      }
      // W-053: touch/depends/conflict landscape across every active dispatch.
      if (result.touch_map && result.touch_map.length > 0) {
        console.log(`\ntouch map: ${result.touch_map.length} active dispatch(es)`);
        for (const t of result.touch_map) {
          const touches = t.touches.length ? t.touches.join(",") : "-";
          const deps = t.depends_on.length ? t.depends_on.join(",") : "-";
          const conf = t.conflicts_with.length ? `CONFLICTS_WITH #${t.conflicts_with.join(",#")}` : "no-conflict";
          console.log(`  #${t.dispatch}${t.slug ? ` (${t.slug})` : ""}: touches=${touches} depends_on=${deps} ${conf}`);
        }
      }
      // W-086: landed merges whose workbench branch still exists — run cleanup + drain.
      // W-033: each carries a ready-to-run cleanup_cmd — run it verbatim, no
      // hand-composed --project/--pm-id/--id/--target-root.
      if (result.unprocessed_results && result.unprocessed_results.length > 0) {
        console.log(`\nUNPROCESSED-RESULT (W-086): ${result.unprocessed_results.length} landed merge(s) with an un-cleaned workbench branch:`);
        for (const u of result.unprocessed_results) {
          console.log(`  ${u.request_id}: branch ${u.workbench_branch} still present (studio_commit ${u.studio_commit ?? "?"})`);
          if (u.cleanup_cmd) console.log(`    ${u.cleanup_cmd}`);
        }
        console.log(`  run each cleanup_cmd, then poll the next merge (dock_merge.ts poll). See pm_playbook.md §1/§10.`);
      }
      // W-092: REPORTING dispatches whose instruction ledger has an unchecked entry.
      if (result.unconsumed_instructions && result.unconsumed_instructions.length > 0) {
        console.log(`\nUNCONSUMED-INSTRUCTIONS (W-092): ${result.unconsumed_instructions.length} REPORTING dispatch(es) with an un-consumed instruction ledger entry:`);
        for (const u of result.unconsumed_instructions) {
          console.log(`  #${u.dispatch}: ${u.unconsumed.length} open entry(ies) in instructions.md`);
          for (const line of u.unconsumed) console.log(`      ${line}`);
        }
        console.log(`  the producer reported done without consuming a mid-flight instruction — re-dispatch it (review.md) to consume + check off the ledger before merge.`);
      }
      // W-018: idle dispatches with no processed register — send each wake_cmd, then
      // touch its register_received marker so the scan stops flagging it.
      if (result.idle_no_register && result.idle_no_register.length > 0) {
        console.log(`\nIDLE-NO-REGISTER (W-018): ${result.idle_no_register.length} idle dispatch(es) with no processed register — wake each (send the wake_cmd body via SendMessage):`);
        for (const u of result.idle_no_register) {
          console.log(`  #${u.dispatch} (${u.kind}, role=${u.role ?? "?"}) -> to: ${u.wake_cmd.to || "(unknown — address by board name)"}`);
          console.log(u.wake_cmd.message.split("\n").map((l) => "      " + l).join("\n"));
        }
        console.log(`  after you process a dispatch's register, touch its _dispatch<N>/register_received marker so the scan stops flagging it. See pm_playbook.md §3/§11.`);
      }
      // W-139: producer-profile attended_record(s) with no matching dispatch
      // container / isolate lane — a bare bypass spawn (flips `ok`, see above).
      if (result.bypass_spawns && result.bypass_spawns.length > 0) {
        console.log(`\n${buildBypassSpawnWarning(result.bypass_spawns)}`);
      }
      if (result.handoff_dispatch !== undefined) {
        console.log(`\n--- handoff (--handoff ${result.handoff_dispatch}) ---`);
        console.log(result.handoff_prompt ?? result.handoff_error ?? "(no handoff generated)");
      }
    } else if (result.mode === "close") {
      if (result.ok) console.log(`close contract OK (resource_class=${result.resource_class} runtime_effect=${result.runtime_effect})`);
      else {
        console.log(`close contract REFUSED (resource_class=${result.resource_class} runtime_effect=${result.runtime_effect}):`);
        for (const v of result.violations) console.log(`  ! [${v.rule}] ${v.detail}`);
        console.log("\n--- nudge (paste into SendMessage) ---\n" + result.nudge);
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
