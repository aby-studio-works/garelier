// Garelier dispatch (DEC-083) — deterministic mechanical tail of the jig tick.
//
// The jig Workflow keeps only the LLM-judgment steps (dispatch producers,
// Guardian, refuter, Observer, the warm-rework decision). The MECHANICAL tail —
// merge_request -> await terminal -> record -> cleanup-on-success — is purely
// deterministic and runs HERE, with ZERO agent()/LLM. This eliminates the
// friction-1 failure class: there is no StructuredOutput to drop (DEC-082 fix-5
// MERGE_UNTRACKED disappears). The tick invokes this via one THIN journaled
// agent (`bun dock_integrate.ts run --items <file> --out <result>`); the journal
// preserves guaranteed-re-run and this command is idempotent, so a crash-replay
// is safe (the agent reads --out on a StructuredOutput drop = no loss).
//
// usage:
//   bun dock_integrate.ts run --pm-id <id> [--project <root>] --items <items.json>
//        [--out <result.json>] [--poll-ms 3000] [--ceiling-ms 1800000] [--no-cleanup]
//
// items.json: { "items": [ { slug, branch, guardianVerdict, observerVerdict?,
//   dispatchId, reportPath?, role?, sha?, summary?, hasWarmProducer?,
//   guardianSummary?, observerSummary?, refuterSummary?, task?, deleteBranch? } ] }
//
// stdout (and --out): { integrated[], enqueued[], mergeFailed[], integrateError[], warnings[] }
//
// SINGLE-POLLER invariant: items are processed SERIALLY (never Promise.all); this
// command must not run concurrently with `dock_merge poll`.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { pollMergeGate, mergeGatePaths, ensureMergeGateDirs, type MergeGatePaths } from "../merge_gate.ts";
import { loadConfig } from "../config.ts";
import { Logger } from "../log.ts";

const TERMINAL = ["success", "failed", "conflict", "aborted"];

export interface IntegrateItem {
  slug: string;
  branch: string;                 // workbench branch — the PRIMARY idempotency key (verbatim)
  guardianVerdict: string;        // REQUIRED — merge_request.sh hard-exits 2 without it
  observerVerdict?: string | null;
  dispatchId?: number | string | null;  // null on a gate_held branch with no container
  reportPath?: string | null;
  role?: string;
  sha?: string | null;
  summary?: string | null;
  hasWarmProducer?: boolean;
  guardianSummary?: string | null;
  observerSummary?: string | null;
  refuterSummary?: string | null;
  task?: string;
  deleteBranch?: boolean;
}

export interface IntegrateOutcome {
  slug: string;
  branch: string;
  state: "INTEGRATED" | "ENQUEUED" | "MERGE_FAILED" | "INTEGRATE_ERROR";
  mergeStatus: string | null;
  requestId: string | null;
  dispatchId: number | string | null;
  hasWarmProducer: boolean;
  cleaned: boolean | "deferred" | "skipped";
  adopted: boolean;
  error?: string;
}

export interface IntegrateResult {
  integrated: Array<Record<string, unknown>>;
  enqueued: Array<Record<string, unknown>>;
  mergeFailed: Array<Record<string, unknown>>;
  integrateError: Array<Record<string, unknown>>;
  warnings: string[];
}

// Injectable side effects (real impls in realDeps; tests inject fakes).
export interface IntegrateDeps {
  // run a bash script; return its stdout/stderr/exit code (no throw)
  runBash(scriptAbs: string, args: string[]): { stdout: string; stderr: string; code: number };
  // advance the merge gate once (idempotent; spawns next queued / self-heals dead pid)
  pollOnce(): Promise<void>;
  // read the terminal result for a request stem, or null if not yet present/parseable
  readResult(stem: string): { status?: string; studio_commit?: string | null } | null;
  // is `branch` already an ancestor of `studio` (i.e. already merged)?
  isAncestorOfStudio(branch: string): boolean;
  // existing requests/results to scan for idempotent adopt: returns {stem, workbench_branch, terminalStatus|null}
  scanRequests(): Array<{ stem: string; workbench_branch: string | null; terminalStatus: string | null }>;
  writeQuestions(dispatchId: number | string, content: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export interface IntegrateCtx {
  project: string;
  targetRoot?: string;
  pmId: string;
  scriptsDir: string;          // <core>/scripts
  studioBranch: string;        // config.branches.integration
  pollMs: number;
  ceilingMs: number;
  noCleanup: boolean;
}

function questionsScaffold(it: IntegrateItem, state: string): string {
  const v = (verdict?: string | null, summary?: string | null) =>
    `${verdict ?? "(none)"} - ${summary ?? "(none)"}`;
  return (
    `# ${it.slug} -> ${state}\n` +
    `## Producer summary\n${it.summary ?? "(none)"}\n` +
    `## Guardian: ${v(it.guardianVerdict, it.guardianSummary)}\n` +
    `## Refuter: ${v(null, it.refuterSummary)}\n` +
    `## Observer: ${v(it.observerVerdict, it.observerSummary)}\n`
  );
}

// PER-ITEM (serial). Returns the outcome; never throws (errors become INTEGRATE_ERROR).
export async function integrateOne(it: IntegrateItem, ctx: IntegrateCtx, deps: IntegrateDeps): Promise<IntegrateOutcome> {
  const base: IntegrateOutcome = {
    slug: it.slug, branch: it.branch, state: "ENQUEUED", mergeStatus: null, requestId: null,
    dispatchId: it.dispatchId ?? null, hasWarmProducer: !!it.hasWarmProducer, cleaned: "skipped", adopted: false,
  };

  // 1. PRE-VALIDATE
  if (!it.guardianVerdict || !it.guardianVerdict.trim()) {
    return { ...base, state: "INTEGRATE_ERROR", error: "missing guardianVerdict (merge_request.sh requires --guardian)" };
  }

  // Already-merged short-circuit (idempotent re-run / commit-before-result-write window):
  // if the branch tip is already an ancestor of studio, the merge is DONE.
  let alreadyMerged = false;
  try { alreadyMerged = deps.isAncestorOfStudio(it.branch); } catch { /* treat as not-merged */ }

  // 2. IDEMPOTENT REQUEST — adopt an existing in-flight request for THIS branch (verbatim key).
  let requestId: string | null = null;
  let adopted = false;
  if (!alreadyMerged) {
    const existing = deps.scanRequests().filter((r) => r.workbench_branch === it.branch);
    const live = existing.find((r) => r.terminalStatus === null);
    if (live) { requestId = live.stem; adopted = true; }
    else {
      // no live request: issue a fresh one with --no-poll (default path execs poll -> stdout is poll JSON, not request_id)
      const r = deps.runBash(join(ctx.scriptsDir, "merge_request.sh"), [
        "--project", ctx.project, "--pm-id", ctx.pmId, "--branch", it.branch, "--task", it.task ?? it.slug,
        "--target-root", ctx.targetRoot ?? ctx.project,
        "--guardian", it.guardianVerdict, ...(it.observerVerdict ? ["--observer", it.observerVerdict] : []), "--no-poll",
      ]);
      if (r.code !== 0) {
        return { ...base, state: "INTEGRATE_ERROR", error: `merge_request.sh exit ${r.code}: ${r.stderr.trim().slice(0, 300)}` };
      }
      try { requestId = JSON.parse(r.stdout.trim()).request_id ?? null; }
      catch { return { ...base, state: "INTEGRATE_ERROR", error: `merge_request.sh stdout not JSON: ${r.stdout.trim().slice(0, 200)}` }; }
      if (!requestId) return { ...base, state: "INTEGRATE_ERROR", error: "merge_request.sh returned no request_id" };
    }
  }

  // 3. AWAIT LOOP — drive the gate to a terminal result in-process (no nested subprocess).
  let status: string | null = alreadyMerged ? "success" : null;
  if (!alreadyMerged && requestId) {
    const started = deps.now();
    for (;;) {
      const res = deps.readResult(requestId);
      const st = res?.status;
      if (st && TERMINAL.includes(st)) { status = st; break; }
      // aborted/synthetic can mask an already-committed merge (commit-before-result-write):
      // re-detect an already-merged tip before trusting a non-success terminal.
      if (deps.now() - started >= ctx.ceilingMs) { status = "timeout"; break; }
      await deps.pollOnce();
      // re-check already-merged each iteration (defends the commit-before-result window)
      try { if (deps.isAncestorOfStudio(it.branch)) { status = "success"; break; } } catch { /* ignore */ }
      await deps.sleep(ctx.pollMs);
    }
  }

  // 4. MAP STATUS. A non-success terminal that is actually already-merged -> success.
  if (status && status !== "success" && TERMINAL.includes(status)) {
    try { if (deps.isAncestorOfStudio(it.branch)) status = "success"; } catch { /* ignore */ }
  }
  const state: IntegrateOutcome["state"] =
    status === "success" ? "INTEGRATED"
    : (status === "failed" || status === "conflict" || status === "aborted") ? "MERGE_FAILED"
    : "ENQUEUED"; // timeout | null
  const kind = (state === "INTEGRATED" || state === "ENQUEUED") ? "complete" : "rework";

  // 5. RECORD — event + (non-complete + dispatchId) questions.md
  const ev = deps.runBash(join(ctx.scriptsDir, "dispatch_event.sh"), [
    "--project", ctx.project, "--pm-id", ctx.pmId, "--kind", kind, "--role", `${it.role ?? "worker"}(${it.slug})`,
    "--task", `${it.slug} -> ${state}${it.sha ? " @" + it.sha : ""}`, ...(it.reportPath ? ["--ref", it.reportPath] : []),
  ]);
  if (ev.code !== 0) deps.log.warn(`dispatch_event.sh exit ${ev.code} for ${it.slug}: ${ev.stderr.trim().slice(0, 200)}`);
  if (kind !== "complete" && it.dispatchId != null) {
    try { deps.writeQuestions(it.dispatchId, questionsScaffold(it, state)); }
    catch (e) { deps.log.warn(`questions.md write failed for ${it.slug}: ${(e as Error).message}`); }
  }

  // 6. CLEANUP — success only, no --force, dispatchId required (gate_held dispatchId==null = no container).
  let cleaned: IntegrateOutcome["cleaned"] = "skipped";
  if (state === "INTEGRATED" && !ctx.noCleanup) {
    if (it.dispatchId == null) {
      // held branch with no container: just delete the merged branch directly (no cleanup script).
      if (it.deleteBranch) {
        const g = deps.runBash("git", ["branch", "-D", it.branch]); // runBash treats "git" as a passthrough exec
        cleaned = g.code === 0 ? true : "skipped";
      } else { cleaned = "skipped"; }
    } else {
      const c = deps.runBash(join(ctx.scriptsDir, "dispatch_cleanup.sh"), [
        "--project", ctx.project, "--pm-id", ctx.pmId, "--id", String(it.dispatchId),
        "--target-root", ctx.targetRoot ?? ctx.project,
        ...(it.deleteBranch ? ["--delete-branch"] : []),
      ]);
      // no-worktree (exit 1 'no worktree') == already-cleaned; deferred == success-with-defer.
      cleaned = c.code === 0 ? (/deferred/i.test(c.stdout) ? "deferred" : true) : true; // re-run/no-worktree is not a failure
    }
  }

  return { ...base, state, mergeStatus: status, requestId, adopted, cleaned };
}

export async function integrateItems(items: IntegrateItem[], ctx: IntegrateCtx, deps: IntegrateDeps): Promise<IntegrateResult> {
  const out: IntegrateResult = { integrated: [], enqueued: [], mergeFailed: [], integrateError: [], warnings: [] };
  for (const it of items) {                          // SERIAL — single-poller invariant
    const o = await integrateOne(it, ctx, deps);
    if (o.state === "INTEGRATED")
      out.integrated.push({ slug: o.slug, branch: o.branch, sha: it.sha ?? null, merged: true, mergeStatus: o.mergeStatus, cleaned: o.cleaned, adopted: o.adopted });
    else if (o.state === "ENQUEUED")
      out.enqueued.push({ slug: o.slug, branch: o.branch, sha: it.sha ?? null, merged: false, mergeStatus: o.mergeStatus });
    else if (o.state === "MERGE_FAILED")
      out.mergeFailed.push({ slug: o.slug, branch: o.branch, dispatchId: o.dispatchId, mergeStatus: o.mergeStatus, hasWarmProducer: o.hasWarmProducer });
    else
      out.integrateError.push({ slug: o.slug, error: o.error });
  }
  return out;
}

// ---- real deps + CLI ----

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function resolveProject(): string {
  const p = arg("project") ?? process.env.GARELIER_PROJECT;
  if (p) return resolve(p);
  const dr = process.env.GARELIER_DISPATCH_ROOT;
  if (dr) return resolve(dr, "..", "..", "..", "..");
  return process.cwd();
}

function realDeps(ctx: IntegrateCtx, config: ReturnType<typeof loadConfig>, paths: MergeGatePaths, log: Logger): IntegrateDeps {
  const project = ctx.project;
  const gitRoot = ctx.targetRoot ?? ctx.project;
  return {
    runBash(scriptAbs, args) {
      const isGit = scriptAbs === "git";
      const r = spawnSync(isGit ? "git" : "bash", isGit ? args : [scriptAbs, ...args], {
        cwd: isGit ? gitRoot : project, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
    },
    async pollOnce() { await pollMergeGate(project, config, log, {}); },
    readResult(stem) {
      for (const f of [join(paths.resultsDir, `${stem}.summary.json`), join(paths.resultsDir, `${stem}.json`)]) {
        if (existsSync(f)) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { /* mid-write */ } }
      }
      return null;
    },
    isAncestorOfStudio(branch) {
      const r = spawnSync("git", ["merge-base", "--is-ancestor", branch, ctx.studioBranch], { cwd: gitRoot });
      return r.status === 0;
    },
    scanRequests() {
      const out: Array<{ stem: string; workbench_branch: string | null; terminalStatus: string | null }> = [];
      const readWb = (f: string): string | null => { try { return JSON.parse(readFileSync(f, "utf8")).workbench_branch ?? null; } catch { return null; } };
      const termOf = (stem: string): string | null => {
        for (const f of [join(paths.resultsDir, `${stem}.summary.json`), join(paths.resultsDir, `${stem}.json`)]) {
          if (existsSync(f)) { try { const s = JSON.parse(readFileSync(f, "utf8")).status; return TERMINAL.includes(s) ? s : null; } catch { /* */ } }
        }
        return null;
      };
      for (const dir of [paths.requestsDir, paths.archiveDir]) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const stem = f.replace(/\.request\.json$/, "").replace(/\.json$/, "");
          out.push({ stem, workbench_branch: readWb(join(dir, f)), terminalStatus: termOf(stem) });
        }
      }
      return out;
    },
    writeQuestions(dispatchId, content) {
      const dir = join(project, "__garelier", ctx.pmId, `_dispatch${dispatchId}`);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "questions.md"), content, "utf8");
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
  };
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd !== "run") { console.error("usage: dock_integrate.ts run --pm-id <id> [--project <root>] (--items <items.json> | --items-b64 <base64>) [--out <f>]"); process.exit(2); }
  const project = resolveProject();
  const pmId = arg("pm-id") ?? process.env.GARELIER_PM_ID;
  const itemsPath = arg("items");
  const itemsB64 = arg("items-b64");  // DEC-083: the jig thin-agent passes items as ONE base64 token (no file write, no quoting/mangle risk)
  if (!pmId || (!itemsPath && !itemsB64)) { console.error("run: --pm-id and one of --items/--items-b64 are required"); process.exit(2); }
  let config;
  try { config = loadConfig(project, pmId); }
  catch (e) { console.error(`dock_integrate: cannot load config for pm "${pmId}" at ${project}: ${(e as Error).message}`); process.exit(1); return; }
  let items: IntegrateItem[];
  try {
    const raw = itemsB64 ? Buffer.from(itemsB64, "base64").toString("utf8") : readFileSync(resolve(itemsPath!), "utf8");
    items = (JSON.parse(raw).items ?? []) as IntegrateItem[];
  }
  catch (e) { console.error(`dock_integrate: cannot read items (${itemsB64 ? "--items-b64" : itemsPath}): ${(e as Error).message}`); process.exit(1); return; }

  const log = new Logger("dock-integrate");
  const paths = mergeGatePaths(project, pmId);
  ensureMergeGateDirs(paths);
  const ctx: IntegrateCtx = {
    project, targetRoot: resolve(arg("target-root") ?? project), pmId, scriptsDir: resolve(arg("core") ?? join(dirname(import.meta.dir), "..", ".."), "scripts"),
    studioBranch: (config as { branches: { integration: string } }).branches.integration,
    pollMs: Math.max(250, Number(arg("poll-ms") ?? 3000)),
    ceilingMs: Math.max(60_000, Number(arg("ceiling-ms") ?? 1_800_000)),
    noCleanup: process.argv.includes("--no-cleanup"),
  };
  const result = await integrateItems(items, ctx, realDeps(ctx, config, paths, log));
  const json = JSON.stringify(result);
  const outPath = arg("out");
  if (outPath) { try { writeFileSync(resolve(outPath), json + "\n", "utf8"); } catch (e) { log.warn(`--out write failed: ${(e as Error).message}`); } }
  console.log(json);
}

// run as CLI only (importable for tests without side effects)
if (import.meta.main) main().catch((e) => { console.error(`dock_integrate: ${e?.message ?? e}`); process.exit(1); });
