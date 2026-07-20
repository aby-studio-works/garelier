#!/usr/bin/env bun
import { rmSync } from "../guard/path_guard.ts";

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crewSubdir } from "../workspace.ts";
import { emitJsonLine, git, run, utcIsoSeconds } from "./_lib.ts";

const HELP = `#
# dispatch_cleanup.ts — remove a dispatch_prepare.ts container after the merge
# gate integrated (or rejected) the branch (DEC-063 Part A).
# Robust on Windows (DEC-073 Part C): when a lingering build/compiler handle
# (or OS handle lag) holds a file under the worktree's deep build-output dir, the dir
# cannot be deleted even though git deregistered the worktree. Instead of leaking
# a stale \`_dispatch<N>/\`, this script retries with backoff, then DEFERS the dir
# to \`runtime/backlog/failed_cleanups.jsonl\` and exits 0 (git is already pruned).
# Re-runnable in --sweep mode (retries every recorded stale dir) — the self-heal
# hook that dispatch_prepare calls on every new dispatch. --sweep ALSO reclaims
# orphaned per-lane \`runtime/scratch/<slug>\` dirs whose dispatch container is
# already gone (W-084(a)): producer intermediate output survives container
# cleanup and otherwise piles up in the retention gap. A scratch dir a live
# dispatch still owns (its slug appears in an active \`_dispatch<N>\` context.json)
# is preserved.
#
# Usage:
#   dispatch_cleanup.ts --project <control-root> --pm-id <id> --id <n> [--delete-branch] [--force] [--target-root <git-root>] [--report-from-file <path>]
#   dispatch_cleanup.ts --project <control-root> --pm-id <id> --sweep [--target-root <git-root>]  # retry deferred stale dirs
#   dispatch_cleanup.ts --project <control-root> --pm-id <id> --id <n> --record-touches [--target-root <git-root>]  # W-021: record measured touches, remove nothing
#
# --record-touches (W-021): does NOT clean up. It records the dispatch's MEASURED
# path set (base_sha..HEAD) into context.json task.touches_actual so a gate /
# Guardian reads the actual diff instead of the dispatch-time \`touches\` prediction
# (which goes stale). Run it at REPORTING (before the gate); delegates to
# driver/src/dispatch/record_touches.ts. Best-effort — a git/read failure leaves
# context.json unchanged and exits non-zero without touching the container.
#
# --report-from-file <path> (W-019): report/register single-ledger. When the
# harness prevented the producer from writing report.md (a common live condition —
# the compact REGISTER message is then the canonical record), the PM saves that
# register text to a file and passes it here; cleanup transcribes it into the
# container's report.md BEFORE archiving, so the archived report carries the real
# outcome instead of the untouched dispatch scaffold. Best-effort: a missing
# source file is a no-op (the existing report.md is archived as-is).
set -uo pipefail`;

function out(line: string): void { process.stdout.write(`${line}\n`); }
function err(line: string): void { process.stderr.write(`${line}\n`); }
function fail(message: string, code: number): never { err(message); process.exit(code); }

function valueAfter(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value === "") fail(`dispatch_cleanup: missing value for ${argv[index]}`, 1);
  return value;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function readText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function gitOutput(root: string, args: string[]): string {
  const result = git(root, args);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

async function removeCheckoutDir(gitRoot: string, checkout: string, force: boolean): Promise<boolean> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (!existsSync(checkout)) return true;
    git(gitRoot, ["worktree", "remove", ...(force ? ["--force"] : []), checkout], { stdout: "ignore", stderr: "ignore" });
    if (!existsSync(checkout)) {
      git(gitRoot, ["worktree", "prune"], { stdout: "ignore", stderr: "ignore" });
      return true;
    }
    try { rmSync(checkout, { recursive: true, force: true }); } catch { /* retry */ }
    git(gitRoot, ["worktree", "prune"], { stdout: "ignore", stderr: "ignore" });
    if (!existsSync(checkout)) return true;
    if (attempt < 4) await Bun.sleep(500 * 2 ** (attempt - 1));
  }
  return !existsSync(checkout);
}

function appendFailedCleanup(failedFile: string, id: string, container: string, reason: string): void {
  try {
    mkdirSync(dirname(failedFile), { recursive: true });
    appendFileSync(failedFile, `${JSON.stringify({ ts: utcIsoSeconds(), dispatch_id: Number(id), container, reason: reason.replace(/"/g, "'") })}\n`);
  } catch { /* best effort */ }
}

function readStatus(path: string): string {
  try { return JSON.parse(readFileSync(path, "utf8"))?.status ?? ""; } catch {
    try { return readFileSync(path, "utf8").match(/"status"\s*:\s*"([^"]*)"/)?.[1] ?? ""; } catch { return ""; }
  }
}

function mergeStatusForBranch(gitRoot: string, branch: string, studio: string, resultsDir: string): string {
  if (branch && studio) {
    const branchOk = git(gitRoot, ["rev-parse", "--verify", "-q", branch]).exitCode === 0;
    const studioOk = git(gitRoot, ["rev-parse", "--verify", "-q", studio]).exitCode === 0;
    if (branchOk && studioOk && git(gitRoot, ["merge-base", "--is-ancestor", branch, studio]).exitCode === 0) return "merged";
  }
  const slug = branch.split("/").at(-1) ?? "";
  let best = "none";
  if (slug && isDirectory(resultsDir)) {
    for (const name of readdirSync(resultsDir).filter((n) => n.endsWith(".json")).sort()) {
      const stem = name.replace(/\.json$/, "").replace(/\.summary$/, "");
      if (!stem.includes(slug)) continue;
      const status = readStatus(resolve(resultsDir, name));
      if (!status) continue;
      if (status === "success") return "success";
      best = status;
    }
  }
  return best;
}

function transcribeReport(src: string, dst: string): boolean {
  if (!src) return false;
  if (!existsSync(src)) {
    err(`dispatch_cleanup: --report-from-file '${src}' not found; leaving report.md as-is`);
    return false;
  }
  try {
    const body = `<!-- transcribed from the producer register by dispatch_cleanup --report-from-file (W-019):\n` +
      `     the compact register message is the canonical record when the harness blocked\n` +
      `     report.md writes. Source: ${src} -->\n\n${readFileSync(src, "utf8")}`;
    writeFileSync(dst, body);
    return true;
  } catch {
    err(`dispatch_cleanup: could not write ${dst} from --report-from-file '${src}'`);
    return false;
  }
}

function readIntegration(config: string): string {
  if (!existsSync(config)) return "";
  return readFileSync(config, "utf8").match(/^\s*integration\s*=\s*"(.*)".*$/m)?.[1] ?? "";
}

/**
 * Lane slugs owned by a LIVE dispatch container — flat `_dispatch<N>` directly
 * under the pm root and crew `_crew/dispatch<N>` (W-086 layout v2) — read from
 * each container's context.json task.slug. A present container means its lane is
 * still running, so its `runtime/scratch/<slug>` must survive the orphan sweep.
 * Best-effort: a missing / corrupt context.json contributes no slug.
 */
function activeDispatchSlugs(pmRoot: string): Set<string> {
  const slugs = new Set<string>();
  const scan = (parent: string, re: RegExp): void => {
    let names: string[];
    try { names = readdirSync(parent); } catch { return; }
    for (const name of names) {
      if (!re.test(name)) continue;
      const dir = resolve(parent, name);
      if (!isDirectory(dir)) continue;
      try {
        const slug = JSON.parse(readFileSync(resolve(dir, "context.json"), "utf8"))?.task?.slug;
        if (typeof slug === "string" && slug) slugs.add(slug);
      } catch { /* no readable slug — not a live lane owner */ }
    }
  };
  scan(pmRoot, /^_dispatch\d+$/);
  scan(resolve(pmRoot, "_crew"), /^dispatch\d+$/);
  return slugs;
}

/**
 * Remove orphaned `runtime/scratch/<slug>` lane dirs — producer intermediate
 * output (dispatch_prompt_craft.md §1.8) that survives container cleanup and
 * otherwise piles up in the retention gap (W-084(a); a live project measured a
 * single lane's 1.8GB scratch surviving 8 days). A top-level scratch entry is
 * orphaned iff NO live dispatch container still owns its slug; a slug an active
 * dispatch still owns is preserved. Returns swept + kept top-level names.
 */
function sweepOrphanScratch(pmRoot: string, activeSlugs: Set<string>): { swept: string[]; kept: string[] } {
  const scratchRoot = resolve(pmRoot, "runtime", "scratch");
  const swept: string[] = [];
  const kept: string[] = [];
  let names: string[];
  try { names = readdirSync(scratchRoot); } catch { return { swept, kept }; }
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (activeSlugs.has(name)) { kept.push(name); continue; }
    try { rmSync(resolve(scratchRoot, name), { recursive: true, force: true }); swept.push(name); }
    catch { kept.push(name); }
  }
  return { swept, kept };
}

function archiveCoordination(container: string, doneDir: string, id: string, slug: string, branch: string): void {
  const names = ["assignment", "report", "questions", "answers", "instructions"];
  if (!names.some((name) => existsSync(resolve(container, `${name}.md`)))) return;
  mkdirSync(doneDir, { recursive: true });
  let body = `# #${id} ${slug} - archived by dispatch_cleanup (${branch || "no-branch"})\n\n`;
  const assignment = resolve(container, "assignment.md");
  const report = resolve(container, "report.md");
  if (existsSync(assignment)) {
    body += readFileSync(assignment, "utf8");
    if (existsSync(report)) body += "\n---\n\n";
  }
  if (existsSync(report)) body += readFileSync(report, "utf8");
  for (const name of ["questions", "answers", "instructions"]) {
    const path = resolve(container, `${name}.md`);
    if (existsSync(path)) body += `\n---\n\n${readFileSync(path, "utf8")}`;
  }
  writeFileSync(resolve(doneDir, `${id}-${slug}.md`), body);
  const sidecar = resolve(container, "report.json");
  if (existsSync(sidecar)) copyFileSync(sidecar, resolve(doneDir, `${id}-${slug}.json`));
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let project = "", targetRoot = "", pm = "", id = "", reportFromFile = "";
  let deleteBranch = false, force = false, sweep = false, recordTouches = false;
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": project = valueAfter(argv, i); i += 2; break;
      case "--target-root": targetRoot = valueAfter(argv, i); i += 2; break;
      case "--pm-id": pm = valueAfter(argv, i); i += 2; break;
      case "--id": id = valueAfter(argv, i); i += 2; break;
      case "--delete-branch": deleteBranch = true; i++; break;
      case "--force": force = true; i++; break;
      case "--sweep": sweep = true; i++; break;
      case "--report-from-file": reportFromFile = valueAfter(argv, i); i += 2; break;
      case "--record-touches": recordTouches = true; i++; break;
      case "-h": case "--help": out(HELP); return 0;
      default:
        err(`dispatch_cleanup: unknown arg: ${argv[i]}`);
        fail("dispatch_cleanup: valid flags: --project --target-root --pm-id --id --delete-branch --force --sweep --report-from-file --record-touches -h/--help", 2);
    }
  }
  if (!project || !pm) fail("dispatch_cleanup: --project, --pm-id are required", 2);

  let gitRoot = targetRoot || project;
  const absolute = /^(?:\/|[A-Za-z]:[\\/])/.test(gitRoot);
  if (!absolute || gitRoot.includes("$") || !isDirectory(gitRoot)) gitRoot = project;

  const pmRoot = `${project}/__garelier/${pm}`;
  const pmContainer = crewSubdir(project, pm, "_pm");
  const dispatchContainer = (dispatchId: string): string => crewSubdir(project, pm, `_dispatch${dispatchId}`);
  const failedFile = `${pmRoot}/runtime/backlog/failed_cleanups.jsonl`;

  if (sweep) {
    let sweptCount = 0;
    const remaining: string[] = [];
    if (existsSync(failedFile)) {
      for (const line of readFileSync(failedFile, "utf8").split(/\r?\n/)) {
        if (!line) continue;
        let container = "";
        try { container = String(JSON.parse(line).container ?? ""); }
        catch { container = line.match(/"container":"([^"]*)"/)?.[1] ?? ""; }
        let checkout = `${container}/checkout`;
        if (!existsSync(checkout)) checkout = container;
        if (!existsSync(checkout) && !existsSync(container)) { sweptCount++; continue; }
        if (await removeCheckoutDir(gitRoot, checkout, true)) {
          try { rmSync(container, { recursive: true, force: true }); } catch { /* retain */ }
          if (!existsSync(container)) { sweptCount++; continue; }
        }
        remaining.push(line);
      }
      if (remaining.length) writeFileSync(failedFile, `${remaining.join("\n")}\n`);
      else rmSync(failedFile, { force: true });
    }
    // W-084(a): the same self-heal sweep also reclaims orphaned per-lane
    // `runtime/scratch/<slug>` dirs whose dispatch container is already gone.
    const scratch = sweepOrphanScratch(pmRoot, activeDispatchSlugs(pmRoot));
    out(`swept=${sweptCount} remaining=${remaining.length} scratch_swept=${scratch.swept.length} scratch_kept=${scratch.kept.length}`);
    return 0;
  }

  if (!id) fail("dispatch_cleanup: --id <n> is required (or use --sweep)", 2);
  const container = dispatchContainer(id);
  let checkout = `${container}/checkout`;
  if (!isDirectory(checkout)) checkout = container;
  if (!isDirectory(checkout)) fail(`dispatch_cleanup: no worktree at ${container}[/checkout]`, 1);

  if (recordTouches) {
    const contextJson = `${container}/context.json`;
    if (!existsSync(contextJson)) fail(`dispatch_cleanup: --record-touches: no context.json at ${contextJson}`, 1);
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const recordTouchesTs = resolve(moduleDir, "../dispatch/record_touches.ts");
    if (!existsSync(recordTouchesTs)) fail(`dispatch_cleanup: --record-touches: record_touches.ts not found at ${recordTouchesTs}`, 1);
    const result = run(["bun", recordTouchesTs, "--context", contextJson, "--checkout", checkout], { stdout: "inherit", stderr: "inherit" });
    return result.exitCode;
  }

  const branch = gitOutput(checkout, ["branch", "--show-current"]);
  if (!force && branch) {
    const mergeHead = gitOutput(gitRoot, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
    const tip = gitOutput(gitRoot, ["rev-parse", "--verify", "-q", branch]);
    if (mergeHead && tip && mergeHead === tip) {
      fail(`dispatch_cleanup: REFUSING — a merge of '${branch}' is in progress (.git/MERGE_HEAD == branch tip). The merge gate is still integrating it; cleaning now races the merge. Wait until it finishes (lock released / studio advanced), then re-run. Use --force to override.`, 3);
    }
    const lock = `${pmRoot}/runtime/merge_gate/locks/active.lock`;
    const slug = branch.split("/").at(-1) ?? "";
    if (existsSync(lock) && slug && readText(lock).includes(slug)) {
      fail(`dispatch_cleanup: REFUSING — the merge gate is processing '${slug}' (active.lock present and references it). Cleaning now races the in-flight merge. Wait until it finishes (lock released), then re-run. Use --force to override.`, 3);
    }
  }

  const studioBranch = readIntegration(`${pmContainer}/setup_config.toml`);
  const mergeStatus = mergeStatusForBranch(gitRoot, branch, studioBranch, `${pmRoot}/runtime/merge_gate/results`);
  if (deleteBranch && !force && mergeStatus !== "merged" && mergeStatus !== "success") {
    fail(`dispatch_cleanup: REFUSING to delete branch '${branch}' — it is not confirmed merged (merge_status=${mergeStatus}: its tip is not an ancestor of studio and no status=success merge result matches its slug). A conflicted/failed merge leaves those commits reachable only from the branch, so deleting now loses that work. Verify the merge landed, or re-run with --force to delete anyway.`, 3);
  }

  let cleanupStatus = "success";
  if (!(await removeCheckoutDir(gitRoot, checkout, force))) {
    err("dispatch_cleanup: worktree dir still locked after retries; deferring to failed_cleanups.jsonl (git pruned)");
    appendFailedCleanup(failedFile, id, container, "worktree dir locked after retries");
    cleanupStatus = "deferred";
  }
  if (deleteBranch && branch) git(gitRoot, ["branch", "-D", branch], { stdout: "ignore", stderr: "ignore" });

  let reportSource = "none";
  if (reportFromFile && transcribeReport(reportFromFile, `${container}/report.md`)) reportSource = reportFromFile;
  const slug = branch.split("/").at(-1) || "dispatch";
  archiveCoordination(container, `${pmRoot}/runtime/backlog/done`, id, slug, branch);
  try { rmSync(container, { recursive: true, force: true }); } catch { /* defer below */ }
  if (existsSync(container) && cleanupStatus === "success") {
    appendFailedCleanup(failedFile, id, container, "container dir not empty / locked");
    cleanupStatus = "deferred";
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const eventScript = resolve(moduleDir, "dispatch_event.ts");
  if (existsSync(eventScript)) {
    run(["bun", eventScript, "--project", project, "--pm-id", pm, "--kind", "cleanup", "--role", `dispatch(#${id})`, "--task", `#${id} container removed`], { stdout: "ignore", stderr: "ignore" });
  }
  const heavyLock = resolve(moduleDir, "../../../scripts/heavy_compile_lock.ts");
  if (existsSync(heavyLock)) run(["bun", heavyLock, "--project", project, "--pm-id", pm, "--mode", "sweep"], { stdout: "ignore", stderr: "ignore" });

  const taskMirrorTs = resolve(moduleDir, "../dispatch/task_mirror.ts");
  const taskMirrorHint = `bun ${taskMirrorTs} --pm-id ${pm} --project ${project} --format ops`;
  emitJsonLine({
    id: Number(id),
    removed: checkout,
    branch,
    branch_deleted: deleteBranch,
    cleanup_status: cleanupStatus,
    merge_status: mergeStatus,
    report_source: reportSource,
    task_mirror_hint: taskMirrorHint,
  });
  return 0;
}

if (import.meta.main) process.exit(await main());
