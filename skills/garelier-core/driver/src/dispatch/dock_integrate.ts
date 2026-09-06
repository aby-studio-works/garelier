// Garelier dispatch (DEC-083) — deterministic mechanical tail of the jig tick.
//
// The jig Workflow keeps only the LLM-judgment steps (dispatch roles,
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
//   dispatchId, reportPath?, role?, sha?, summary?, hasWarmRole?,
//   guardianSummary?, observerSummary?, refuterSummary?, task?, deleteBranch? } ] }
//
// stdout (and --out): { integrated[], enqueued[], mergeFailed[], integrateError[], warnings[] }
//
// SINGLE-POLLER invariant: items are processed SERIALLY (never Promise.all); this
// command must not run concurrently with `dock_merge poll`.
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { pollMergeGate, mergeGatePaths, ensureMergeGateDirs, type MergeGatePaths } from "../merge_gate.ts";
import { assertChokepointAllowed } from "../integration_closure.ts";
import { loadConfig } from "../config.ts";
import { Logger } from "../log.ts";
import { arg, printHelpAndExitIfRequested } from "../cli_args.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";
import { dispatchContainer } from "../workspace.ts";

const TERMINAL = ["success", "failed", "conflict", "aborted", "stale_base", "environment_blocked"];

export interface AuthoritativeDockResult {
  status?: string;
  studio_commit?: string | null;
  request_id?: string | null;
  workbench_branch?: string | null;
  workbench_tip?: string | null;
  authority_error?: string;
}

export interface DockRequestScanRecord {
  stem: string;
  workbench_branch: string | null;
  terminalStatus: string | null;
  authorityError?: string;
  resultSnapshot?: AuthoritativeDockResult | null;
}

export interface IntegrateItem {
  slug: string;
  branch: string;                 // workbench branch — the PRIMARY idempotency key (verbatim)
  guardianVerdict: string;        // REQUIRED — merge_request.ts hard-exits 2 without it
  observerVerdict?: string | null;
  dispatchId?: number | string | null;  // null on a gate_held branch with no container
  reportPath?: string | null;
  role?: string;
  sha?: string | null;
  summary?: string | null;
  hasWarmRole?: boolean;
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
  hasWarmRole: boolean;
  cleaned: boolean | "deferred" | "skipped" | string;  // string = "failed(rc=N): <reason>" (W-238)
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
  // run a Bun CLI; return its stdout/stderr/exit code (no throw)
  runBash(scriptAbs: string, args: string[]): {
    stdout: string;
    stderr: string;
    code: number;
    outcome?: "success" | "timeout" | "signal" | "spawn_failure" | "exit";
    signal?: string | null;
    timedOut?: boolean;
    timeoutMs?: number;
  };
  // advance the merge gate once (idempotent; spawns next queued / self-heals dead pid)
  pollOnce(): Promise<void>;
  // read the terminal result for a request stem, or null if not yet present/parseable
  readResult(stem: string): AuthoritativeDockResult | null;
  // is `branch` already an ancestor of `studio` (i.e. already merged)?
  isAncestorOfStudio(branch: string): boolean;
  // existing requests/results to scan for idempotent adopt: returns {stem, workbench_branch, terminalStatus|null}
  scanRequests(): DockRequestScanRecord[];
  writeQuestions(dispatchId: number | string, content: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export interface IntegrateCtx {
  project: string;
  targetRoot?: string;
  pmId: string;
  scriptsDir: string;          // <core>/driver/src/scripts
  studioBranch: string;        // config.branches.integration
  pollMs: number;
  ceilingMs: number;
  noCleanup: boolean;
}

export function classifyDockChildOutcome(input: {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
}, scriptName: string, timeoutMs: number): { outcome: "success" | "timeout" | "signal" | "spawn_failure" | "exit"; code: number; signal: string | null; detail: string } {
  if (input.error?.code === "ETIMEDOUT") return { outcome: "timeout", code: 124, signal: null, detail: `dock_integrate ${scriptName} child timed out after ${timeoutMs}ms` };
  if (input.error) return { outcome: "spawn_failure", code: 127, signal: null, detail: `dock_integrate ${scriptName} spawn failed: ${input.error.message}` };
  if (input.signal) return { outcome: "signal", code: 128, signal: input.signal, detail: `dock_integrate ${scriptName} terminated by signal ${input.signal}` };
  if (input.status === null) return { outcome: "spawn_failure", code: 127, signal: null, detail: `dock_integrate ${scriptName} exited without a status` };
  return { outcome: input.status === 0 ? "success" : "exit", code: input.status, signal: null, detail: "" };
}

function successfulResultBindingError(
  result: ReturnType<IntegrateDeps["readResult"]>,
  requestId: string,
  item: IntegrateItem,
): string | null {
  if (result?.authority_error) return result.authority_error;
  if (!result || result.status !== "success") return "canonical result is absent or not success";
  if (result.request_id !== requestId) return "result.request_id does not match the exact request";
  if (result.workbench_branch !== item.branch) return "result.workbench_branch does not match the role branch";
  if (typeof result.workbench_tip !== "string" || !/^[0-9a-f]{40,64}$/.test(result.workbench_tip)) return "result.workbench_tip is missing or invalid";
  if (item.sha && result.workbench_tip !== item.sha) return "result.workbench_tip does not match the submitted role SHA";
  if (typeof result.studio_commit !== "string" || !/^[0-9a-f]{40,64}$/.test(result.studio_commit)) return "result.studio_commit is missing or invalid";
  return null;
}

function questionsScaffold(it: IntegrateItem, state: string): string {
  const v = (verdict?: string | null, summary?: string | null) =>
    `${verdict ?? "(none)"} - ${summary ?? "(none)"}`;
  return (
    `# ${it.slug} -> ${state}\n` +
    `## Role summary\n${it.summary ?? "(none)"}\n` +
    `## Guardian: ${v(it.guardianVerdict, it.guardianSummary)}\n` +
    `## Refuter: ${v(null, it.refuterSummary)}\n` +
    `## Observer: ${v(it.observerVerdict, it.observerSummary)}\n`
  );
}

// PER-ITEM (serial). Returns the outcome; never throws (errors become INTEGRATE_ERROR).
export async function integrateOne(it: IntegrateItem, ctx: IntegrateCtx, deps: IntegrateDeps): Promise<IntegrateOutcome> {
  const base: IntegrateOutcome = {
    slug: it.slug, branch: it.branch, state: "ENQUEUED", mergeStatus: null, requestId: null,
    dispatchId: it.dispatchId ?? null, hasWarmRole: !!it.hasWarmRole, cleaned: "skipped", adopted: false,
  };

  // 1. PRE-VALIDATE
  if (!it.guardianVerdict || !it.guardianVerdict.trim()) {
    return { ...base, state: "INTEGRATE_ERROR", error: "missing guardianVerdict (merge_request.ts requires --guardian)" };
  }

  // 1b. W-346 FR5: Dock-integrate chokepoint. While a closure lease holds this
  // studio lineage, an unrelated integration WAITS — nothing is submitted,
  // polled, adopted, or cleaned; the item stays ENQUEUED for a later run.
  // Pass-through whenever no closure state exists (all current traffic).
  const closureVerdict = assertChokepointAllowed(ctx.project, ctx.pmId, ctx.studioBranch, { requestKind: "ordinary" });
  if (!closureVerdict.allowed) {
    deps.log.warn(`closure lease holds ${ctx.studioBranch}; ${it.slug} waits unchanged: ${closureVerdict.reason}`);
    return { ...base, state: "ENQUEUED", error: `closure lease: ${closureVerdict.reason}` };
  }

  // 2. IDEMPOTENT REQUEST — adopt an existing in-flight request for THIS branch (verbatim key).
  let requestId: string | null = null;
  let adopted = false;
  const existing = deps.scanRequests().filter((r) => r.workbench_branch === it.branch);
  const successful: typeof existing = [];
  const frozenResults = new Map<string, AuthoritativeDockResult | null>();
  for (const request of existing) {
    const result = Object.prototype.hasOwnProperty.call(request, "resultSnapshot")
      ? request.resultSnapshot ?? null
      : deps.readResult(request.stem);
    frozenResults.set(request.stem, result);
    if (request.authorityError || result?.authority_error) {
      return { ...base, state: "INTEGRATE_ERROR", error: `invalid canonical result authority ${request.stem}: ${request.authorityError ?? result?.authority_error}` };
    }
    if (request.terminalStatus !== "success" && result?.status !== "success") continue;
    const bindingError = successfulResultBindingError(result, request.stem, it);
    if (bindingError) {
      return { ...base, state: "INTEGRATE_ERROR", error: `unverified live success ${request.stem}: ${bindingError}` };
    }
    successful.push(request);
  }
  if (successful.length > 1) {
    return { ...base, state: "INTEGRATE_ERROR", error: `branch has multiple exact successful request/result pairs; found ${successful.length}` };
  }
  let alreadyMerged = false;
  if (successful.length === 1) {
    requestId = successful[0]!.stem;
    const exactResult = frozenResults.get(requestId)!;
    const studioCommit = exactResult.studio_commit!;
    try { alreadyMerged = deps.isAncestorOfStudio(studioCommit); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ...base, state: "INTEGRATE_ERROR", error: `cannot prove recorded studio ancestry for ${requestId}: ${detail}` };
    }
    if (!alreadyMerged) {
      return { ...base, state: "INTEGRATE_ERROR", error: `recorded studio commit for ${requestId} is not reachable from current studio` };
    }
    adopted = true;
  } else {
    // Only probe the live role ref when no successful pair can authorize a
    // retired-ref replay. A positive ancestry result without immutable merge
    // evidence is not enough to clean anything.
    try { alreadyMerged = deps.isAncestorOfStudio(it.branch); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ...base, state: "INTEGRATE_ERROR", error: `cannot prove merge ancestry for ${it.branch}: ${detail}` };
    }
    if (alreadyMerged) {
      return { ...base, state: "INTEGRATE_ERROR", error: `already-landed branch requires one exact successful request/result pair; found ${successful.length}` };
    }
    const live = existing.filter((r) => r.terminalStatus === null);
    if (live.length > 1) return { ...base, state: "INTEGRATE_ERROR", error: `multiple live merge requests bind branch ${it.branch}` };
    if (live.length === 1) { requestId = live[0]!.stem; adopted = true; }
    else {
      // no live request: issue a fresh one with --no-poll (default path execs poll -> stdout is poll JSON, not request_id)
      const r = deps.runBash(join(ctx.scriptsDir, "merge_request.ts"), [
        "--project", ctx.project, "--pm-id", ctx.pmId, "--branch", it.branch, "--task", it.task ?? it.slug,
        "--target-root", ctx.targetRoot ?? ctx.project,
        ...(it.dispatchId == null ? [] : ["--dispatch-id", String(it.dispatchId).replace(/^#/, "")]),
        "--aftercare-binding", it.dispatchId == null ? "branch_only" : "dispatch",
        "--guardian", it.guardianVerdict, ...(it.observerVerdict ? ["--observer", it.observerVerdict] : []), "--no-poll",
      ]);
      if (r.code !== 0) {
        return { ...base, state: "INTEGRATE_ERROR", error: `merge_request.ts exit ${r.code}: ${r.stderr.trim().slice(0, 300)}` };
      }
      try { requestId = JSON.parse(r.stdout.trim()).request_id ?? null; }
      catch { return { ...base, state: "INTEGRATE_ERROR", error: `merge_request.ts stdout not JSON: ${r.stdout.trim().slice(0, 200)}` }; }
      if (!requestId) return { ...base, state: "INTEGRATE_ERROR", error: "merge_request.ts returned no request_id" };
    }
  }

  // 3. AWAIT LOOP — drive the gate to a terminal result in-process (no nested subprocess).
  let status: string | null = successful.length === 1 || alreadyMerged ? frozenResults.get(requestId!)?.status ?? null : null;
  if (status === null && !alreadyMerged && requestId) {
    const started = deps.now();
    for (;;) {
      const res = deps.readResult(requestId);
      if (res?.authority_error) return { ...base, state: "INTEGRATE_ERROR", requestId, adopted, error: `invalid canonical result authority ${requestId}: ${res.authority_error}` };
      const st = res?.status;
      if (st && TERMINAL.includes(st)) {
        if (st === "success") {
          const bindingError = successfulResultBindingError(res, requestId, it);
          if (bindingError) return { ...base, state: "INTEGRATE_ERROR", requestId, adopted, error: `unverified live success ${requestId}: ${bindingError}` };
        }
        status = st;
        break;
      }
      if (deps.now() - started >= ctx.ceilingMs) { status = "timeout"; break; }
      await deps.pollOnce();
      await deps.sleep(ctx.pollMs);
    }
  }

  // 4. MAP STATUS from the exact result only. Ancestry never overrides a
  // failed/aborted/null result.
  const state: IntegrateOutcome["state"] =
    status === "success" ? "INTEGRATED"
    : (status === "failed" || status === "conflict" || status === "aborted" || status === "stale_base" || status === "environment_blocked") ? "MERGE_FAILED"
    : "ENQUEUED"; // timeout | null
  const kind = (state === "INTEGRATED" || state === "ENQUEUED") ? "complete" : "rework";

  // 5. RECORD — event + (non-complete + dispatchId) questions.md
  const ev = deps.runBash(join(ctx.scriptsDir, "dispatch_event.ts"), [
    "--project", ctx.project, "--pm-id", ctx.pmId, "--kind", kind, "--role", `${it.role ?? "worker"}(${it.slug})`,
    "--task", `${it.slug} -> ${state}${it.sha ? " @" + it.sha : ""}`, ...(it.reportPath ? ["--ref", it.reportPath] : []),
  ]);
  if (ev.code !== 0) deps.log.warn(`dispatch_event.ts exit ${ev.code} for ${it.slug}: ${ev.stderr.trim().slice(0, 200)}`);
  if (kind !== "complete" && it.dispatchId != null) {
    try { deps.writeQuestions(it.dispatchId, questionsScaffold(it, state)); }
    catch (e) { deps.log.warn(`questions.md write failed for ${it.slug}: ${(e as Error).message}`); }
  }

  // 6. CLEANUP — success only, no --force, dispatchId required (gate_held dispatchId==null = no container).
  let cleaned: IntegrateOutcome["cleaned"] = "skipped";
  if (state === "INTEGRATED" && !ctx.noCleanup) {
    if (!requestId) {
      cleaned = "failed(rc=3): exact successful request_id is missing";
    } else {
      const c = deps.runBash(join(ctx.scriptsDir, "dispatch_cleanup.ts"), [
        "--project", ctx.project, "--pm-id", ctx.pmId,
        ...(it.dispatchId == null ? [] : [
          "--id", String(it.dispatchId),
          "--checkout", join(dispatchContainer(ctx.project, ctx.pmId, String(it.dispatchId)), "checkout"),
        ]),
        "--request-id", requestId, "--target-root", ctx.targetRoot ?? ctx.project, "--delete-branch",
      ]);
      if (c.code === 0) {
        cleaned = true;
      } else if (c.outcome === "timeout" || c.timedOut || c.code === 124) {
        const timeoutMs = c.timeoutMs ?? 120_000;
        const reason = (c.stderr.split(/\r?\n/).find((l) => l.trim()) || `aftercare child timed out after ${timeoutMs}ms`).trim();
        cleaned = `failed(timeout=${timeoutMs}ms): ${reason}`;
        deps.log.warn(`land_aftercare.ts timed out for ${it.slug} after ${timeoutMs}ms: ${reason}`);
      } else if (c.outcome === "signal") {
        const reason = (c.stderr.split(/\r?\n/).find((l) => l.trim()) || `aftercare child terminated by signal ${c.signal ?? "unknown"}`).trim();
        cleaned = `failed(signal=${c.signal ?? "unknown"}): ${reason}`;
        deps.log.warn(`land_aftercare.ts terminated by signal for ${it.slug}: ${reason}`);
      } else if (c.outcome === "spawn_failure") {
        const reason = (c.stderr.split(/\r?\n/).find((l) => l.trim()) || "aftercare child spawn failed").trim();
        cleaned = `failed(spawn): ${reason}`;
        deps.log.warn(`land_aftercare.ts spawn failed for ${it.slug}: ${reason}`);
      } else {
        // W-238 (target-project dispatch, O N-5): any OTHER non-zero exit (e.g. rc=3 REFUSING an
        // in-progress merge, rc=4 guard/control-update failure) is a genuine cleanup
        // failure and must not be reported as cleaned=true — the branch is INTEGRATED
        // but the container/worktree may still be sitting there. Same class + same shape
        // as the W-235 merge_land.ts fix (8cec658f): surface "failed(rc=N): <reason>".
        const reason = (c.stderr.split(/\r?\n/).find((l) => l.trim()) || `dispatch_cleanup exited ${c.code}`).trim();
        cleaned = `failed(rc=${c.code}): ${reason}`;
        deps.log.warn(`land_aftercare.ts failed for ${it.slug} (rc=${c.code}): ${reason}`);
      }
    }
  }

  return { ...base, state, mergeStatus: status, requestId, adopted, cleaned };
}

export async function integrateItems(items: IntegrateItem[], ctx: IntegrateCtx, deps: IntegrateDeps): Promise<IntegrateResult> {
  const out: IntegrateResult = { integrated: [], enqueued: [], mergeFailed: [], integrateError: [], warnings: [] };
  for (const it of items) {                          // SERIAL — single-poller invariant
    const o = await integrateOne(it, ctx, deps);
    if (o.state === "INTEGRATED") {
      out.integrated.push({ slug: o.slug, branch: o.branch, sha: it.sha ?? null, requestId: o.requestId, merged: true, mergeStatus: o.mergeStatus, cleaned: o.cleaned, adopted: o.adopted });
      // W-238: merge succeeded but the cleanup child failed for a real reason — surface it
      // at the top level too (cleaned holds "failed(rc=N): ..."), never leave it buried
      // looking identical to a plain boolean success in a shallow consumer scan.
      if (typeof o.cleaned === "string" && o.cleaned.startsWith("failed(")) {
        out.warnings.push(`${o.slug} (${o.branch}): cleanup ${o.cleaned}`);
      }
    }
    else if (o.state === "ENQUEUED")
      out.enqueued.push({ slug: o.slug, branch: o.branch, sha: it.sha ?? null, merged: false, mergeStatus: o.mergeStatus });
    else if (o.state === "MERGE_FAILED")
      out.mergeFailed.push({ slug: o.slug, branch: o.branch, dispatchId: o.dispatchId, mergeStatus: o.mergeStatus, hasWarmRole: o.hasWarmRole });
    else
      out.integrateError.push({ slug: o.slug, error: o.error });
  }
  return out;
}

// ---- real deps + CLI ----

function resolveProject(): string {
  const p = arg("project") ?? process.env.GARELIER_PROJECT;
  if (p) return resolve(p);
  const dr = process.env.GARELIER_DISPATCH_ROOT;
  if (dr) return resolve(dr, "..", "..", "..", "..");
  return process.cwd();
}

const MAX_DOCK_CANONICAL_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_DOCK_SUMMARY_RESULT_BYTES = 1024 * 1024;

function dockResultEntryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readStableDockResultBytes(path: string, maxBytes: number, afterOpen: () => void = () => {}): string {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`merge result must be a non-reparse regular file: ${path}`);
  if (before.size > BigInt(maxBytes)) throw new Error(`merge result exceeds ${maxBytes} bytes: ${path}`);
  const fd = openSync(path, "r");
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`merge result identity changed before read: ${path}`);
    }
    afterOpen();
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (bytes.byteLength > maxBytes || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new Error(`merge result changed during read: ${path}`);
    }
    const pathAfter = lstatSync(path, { bigint: true });
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new Error(`merge result pathname changed during read: ${path}`);
    }
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}

function parseDockResultFile(path: string, maxBytes: number, afterOpen?: () => void): Record<string, unknown> | string {
  try {
    const value = JSON.parse(readStableDockResultBytes(path, maxBytes, afterOpen));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : `merge result is not an object: ${path}`;
  } catch (error) {
    return `merge result is unreadable or invalid JSON: ${path}: ${(error as Error).message}`;
  }
}

const RESULT_BINDING_FIELDS = ["request_id", "status", "workbench_branch", "workbench_tip", "studio_commit"] as const;

function resultDisagreement(
  canonical: Record<string, unknown>,
  candidate: Record<string, unknown>,
  candidateLabel: string,
): string | null {
  for (const field of RESULT_BINDING_FIELDS) {
    if (candidate[field] !== canonical[field]) return `${candidateLabel} disagrees with canonical result on ${field}`;
  }
  return null;
}

export function readAuthoritativeDockResult(
  paths: MergeGatePaths,
  stem: string,
  testHooks: { afterCanonicalOpen?: () => void; afterSummaryOpen?: () => void } = {},
): AuthoritativeDockResult | null {
  const liveCanonical = join(paths.resultsDir, `${stem}.json`);
  const archivedCanonical = join(paths.archiveDir, `${stem}.result.json`);
  const summaryPath = join(paths.resultsDir, `${stem}.summary.json`);
  const canonicalPaths = [liveCanonical, archivedCanonical].filter(dockResultEntryExists);
  if (canonicalPaths.length === 0) {
    return dockResultEntryExists(summaryPath)
      ? { authority_error: `derived summary exists without a canonical result: ${summaryPath}` }
      : null;
  }
  const parsed = canonicalPaths.map((path, index) => ({
    path,
    value: parseDockResultFile(path, MAX_DOCK_CANONICAL_RESULT_BYTES, index === 0 ? testHooks.afterCanonicalOpen : undefined),
  }));
  const invalid = parsed.find((item) => typeof item.value === "string");
  if (invalid) return { authority_error: invalid.value as string };
  const canonical = parsed[0]!.value as Record<string, unknown>;
  if (parsed.length === 2) {
    const disagreement = resultDisagreement(canonical, parsed[1]!.value as Record<string, unknown>, "second canonical result");
    if (disagreement) return { authority_error: disagreement };
  }
  if (dockResultEntryExists(summaryPath)) {
    const summary = parseDockResultFile(summaryPath, MAX_DOCK_SUMMARY_RESULT_BYTES, testHooks.afterSummaryOpen);
    if (typeof summary === "string") return { authority_error: summary };
    const disagreement = resultDisagreement(canonical, summary, "derived summary");
    if (disagreement) return { authority_error: disagreement };
  }
  return canonical as AuthoritativeDockResult;
}

export function scanAuthoritativeDockRequests(paths: MergeGatePaths): DockRequestScanRecord[] {
  const out: DockRequestScanRecord[] = [];
  const readWb = (f: string): string | null => { try { return JSON.parse(readFileSync(f, "utf8")).workbench_branch ?? null; } catch { return null; } };
  for (const dir of [paths.requestsDir, paths.archiveDir]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (dir === paths.requestsDir ? (!f.endsWith(".json") || f.endsWith(".summary.json")) : !f.endsWith(".request.json")) continue;
      const stem = f.replace(/\.request\.json$/, "").replace(/\.json$/, "");
      const result = readAuthoritativeDockResult(paths, stem);
      out.push({
        stem,
        workbench_branch: readWb(join(dir, f)),
        terminalStatus: result?.status && TERMINAL.includes(result.status) ? result.status : null,
        authorityError: result?.authority_error,
        resultSnapshot: result,
      });
    }
  }
  return out;
}

function realDeps(ctx: IntegrateCtx, config: ReturnType<typeof loadConfig>, paths: MergeGatePaths, log: Logger): IntegrateDeps {
  const project = ctx.project;
  const gitRoot = ctx.targetRoot ?? ctx.project;
  const GIT_ANCESTRY_TIMEOUT_MS = 30_000;
  return {
    runBash(scriptAbs, args) {
      const isGit = scriptAbs === "git";
      const scriptName = scriptAbs.replaceAll("\\", "/").split("/").at(-1) ?? scriptAbs;
      const timeoutMs = isGit ? 30_000
        : scriptName === "dispatch_event.ts" ? 60_000
        : scriptName === "land_aftercare.ts" || scriptName === "dispatch_cleanup.ts" ? 120_000
        : 120_000;
      const r = spawnSync(requireRuntimeExecutable(isGit ? "git" : "bun"), isGit ? args : [scriptAbs, ...args], { windowsHide: true,
        cwd: isGit ? gitRoot : project, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs,
      });
      const classified = classifyDockChildOutcome({ status: r.status, signal: r.signal, error: r.error as NodeJS.ErrnoException | undefined }, scriptName, timeoutMs);
      return { stdout: r.stdout ?? "", stderr: classified.detail || r.stderr || "", code: classified.code,
        outcome: classified.outcome, signal: classified.signal, timedOut: classified.outcome === "timeout", timeoutMs };
    },
    async pollOnce() { await pollMergeGate(project, config, log, {}); },
    readResult(stem) { return readAuthoritativeDockResult(paths, stem); },
    isAncestorOfStudio(branch) {
      const r = spawnSync(requireRuntimeExecutable("git"), ["merge-base", "--is-ancestor", branch, ctx.studioBranch], {
        windowsHide: true, cwd: gitRoot, encoding: "utf8", timeout: GIT_ANCESTRY_TIMEOUT_MS,
      });
      const error = r.error as NodeJS.ErrnoException | undefined;
      if (error?.code === "ETIMEDOUT") throw new Error(`git merge-base --is-ancestor timed out after ${GIT_ANCESTRY_TIMEOUT_MS}ms`);
      if (error) throw new Error(`git merge-base --is-ancestor spawn failed: ${error.message}`);
      if (r.signal) throw new Error(`git merge-base --is-ancestor terminated by signal ${r.signal}`);
      if (r.status === 0) return true;
      if (r.status === 1) return false;
      throw new Error(`git merge-base --is-ancestor failed with exit ${r.status ?? "unknown"}: ${(r.stderr ?? "").trim()}`);
    },
    scanRequests() { return scanAuthoritativeDockRequests(paths); },
    writeQuestions(dispatchId, content) {
      const dir = join(project, "__garelier", ctx.pmId, `_crew/dispatch${dispatchId}`);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "questions.md"), content, "utf8");
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
  };
}

async function main(): Promise<void> {
  printHelpAndExitIfRequested(
    "dock_integrate — sequential merge of a batch of ready items into studio via the merge gate.\n" +
    "usage: dock_integrate run --pm-id <id> [--project <root>] (--items <items.json> | --items-b64 <base64>)\n" +
    "       [--out <f>] [--target-root <path>] [--core <n>] [--poll-ms <n>] [--ceiling-ms <n>] [--no-cleanup]",
  );
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
    project, targetRoot: resolve(arg("target-root") ?? project), pmId, scriptsDir: resolve(arg("core") ?? join(dirname(import.meta.dir), "..", ".."), "driver", "src", "scripts"),
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
