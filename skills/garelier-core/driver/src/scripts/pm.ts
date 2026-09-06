#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { garelierControlRoots } from "../control/garelier_integration.ts";
import { loadPlanGraphModel } from "../control/plan_graph_model.ts";
import { readControlClaim } from "../control/claims.ts";
import { resolveControlNamespace } from "../control/transaction.ts";
import { inspectDockReviewHandoff } from "../dispatch/attended_seat.ts";
import { extractVerdict } from "../merge_gate_parse.ts";
import { dockProxyRegisterLeaf } from "./dock_proxy.ts";
import { git, shellQuote } from "./_lib.ts";
import { dryRunLandAftercare } from "../dispatch/land_aftercare.ts";

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const PASSING = new Set(["PASS", "PASS_WITH_NOTES"]);
type JsonRecord = Record<string, unknown>;

export interface PmNextOptions { project: string; targetRoot?: string; pmId: string; workId: string }
export interface PmNextResult {
  schema_version: 1;
  kind: "garelier_pm_next";
  work_id: string;
  state: string;
  next_command: string;
  reason: string;
  snapshot: {
    dispatch_id: string | null; control_session: string | null;
    claim: "active" | "missing" | "other-session";
    gate: "GREEN" | "RED_OR_MISSING" | "not_applicable";
    guardian: string | null; observer: string | null;
    merge_request: string | null; merge_result: string | null; ledger_pending: number;
  };
}
interface DispatchState { id: string; container: string; checkout: string; context: JsonRecord; ready: JsonRecord }
interface MergeState { requestId: string; request: JsonRecord; result: JsonRecord | null }

function object(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function json(path: string): JsonRecord {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_JSON_BYTES) throw new Error(`PM state input is not a bounded regular JSON file: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`PM state input is not a JSON object: ${path}`);
  return value as JsonRecord;
}
function command(parts: string[]): string { return parts.map((part) => shellQuote(part)).join(" "); }

function dispatchForWork(project: string, pmId: string, workId: string): DispatchState | null {
  const crew = join(project, "__garelier", pmId, "_crew");
  if (!existsSync(crew)) return null;
  const found: DispatchState[] = [];
  for (const entry of readdirSync(crew, { withFileTypes: true })) {
    const id = /^dispatch(\d+)$/.exec(entry.name)?.[1];
    if (!id || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const container = join(crew, entry.name);
    const contextPath = join(container, "context.json");
    if (!existsSync(contextPath)) continue;
    const context = json(contextPath);
    const task = object(context.task);
    if (object(context.control).work_id !== workId || ["guardian", "observer", "dock"].includes(String(task.role ?? ""))) continue;
    const readyPath = join(container, "ready.json");
    found.push({ id, container, checkout: join(container, "checkout"), context, ready: existsSync(readyPath) ? json(readyPath) : {} });
  }
  return found.sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
}

function mergeForWork(project: string, pmId: string, workId: string, dispatchId: string | null): MergeState | null {
  const root = join(project, "__garelier", pmId, "runtime", "merge_gate");
  const candidates: Array<{ requestId: string; path: string; mtime: number }> = [];
  for (const subdir of ["requests", "archive"]) {
    const dir = join(root, subdir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const requestId = subdir === "requests" ? /^(.*)\.json$/.exec(entry.name)?.[1] : /^(.*)\.request\.json$/.exec(entry.name)?.[1];
      if (!requestId || !entry.isFile() || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      const request = json(path);
      if (request.work_id !== workId || (dispatchId !== null && String(request.dispatch_id ?? "") !== dispatchId)) continue;
      candidates.push({ requestId, path, mtime: statSync(path).mtimeMs });
    }
  }
  const selected = candidates.sort((a, b) => b.mtime - a.mtime)[0];
  if (!selected) return null;
  const resultPath = join(root, "results", `${selected.requestId}.json`);
  return { requestId: selected.requestId, request: json(selected.path), result: existsSync(resultPath) ? json(resultPath) : null };
}

function verdict(pmRoot: string, path: unknown): string | null {
  if (typeof path !== "string" || !path) return null;
  const absolute = resolve(pmRoot, path);
  return existsSync(absolute) ? extractVerdict(readFileSync(absolute, "utf8")) : null;
}
function pendingLedger(container: string): number {
  const path = join(container, "instructions.md");
  return existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter((line) => /^\s*[-*]\s+\[ \]\s+(?:I|M)\d+\b/.test(line)).length : 0;
}
export function computePmNext(options: PmNextOptions): PmNextResult {
  const project = resolve(options.project), targetRoot = resolve(options.targetRoot ?? project);
  const pmRoot = join(project, "__garelier", options.pmId);
  if (!loadPlanGraphModel(join(pmRoot, "control")).backlog.has(options.workId)) throw new Error(`canonical Backlog does not contain ${options.workId}`);
  const dispatch = dispatchForWork(project, options.pmId, options.workId);
  const session = dispatch && typeof object(dispatch.context.control).session_id === "string" ? String(object(dispatch.context.control).session_id) : null;
  const claimRecord = readControlClaim(resolveControlNamespace(garelierControlRoots(project, targetRoot, options.pmId)), options.workId);
  const claim: PmNextResult["snapshot"]["claim"] = !claimRecord ? "missing" : !session || claimRecord.session_id !== session ? "other-session" : "active";
  const merge = mergeForWork(project, options.pmId, options.workId, dispatch?.id ?? null);
  const pending = dispatch ? pendingLedger(dispatch.container) : 0;
  let gate: PmNextResult["snapshot"]["gate"] = "RED_OR_MISSING";
  let guardian: string | null = null, observer: string | null = null;
  const snapshot = (): PmNextResult["snapshot"] => ({
    dispatch_id: dispatch?.id ?? null, control_session: session, claim, gate,
    guardian, observer, merge_request: merge?.requestId ?? null,
    merge_result: typeof merge?.result?.status === "string" ? merge.result.status : null, ledger_pending: pending,
  });
  const result = (state: string, nextCommand: string, reason: string): PmNextResult => ({
    schema_version: 1, kind: "garelier_pm_next", work_id: options.workId,
    state, next_command: nextCommand, reason, snapshot: snapshot(),
  });

  if (merge?.result?.status === "success") {
    gate = "not_applicable";
    const plan = dryRunLandAftercare({
      project,
      targetRoot,
      pmId: options.pmId,
      requestId: merge.requestId,
      dispatchId: dispatch?.id ?? null,
    }).plan;
    const args = ["bun", "skills/garelier-core/driver/src/dispatch/land_aftercare.ts", "apply", "--project", project,
      "--target-root", targetRoot, "--pm-id", options.pmId, "--request-id", merge.requestId,
      "--expect-plan-digest", plan.plan_digest];
    if (dispatch) args.push("--dispatch-id", dispatch.id);
    return result("post_land", command(args), "a SHA-bound successful merge result exists; replay idempotent aftercare to finalize Control and cleanup");
  }
  if (merge && !merge.result) {
    gate = "not_applicable";
    return result("merge_wait", command(["bun", "skills/garelier-core/driver/src/dispatch/dock_merge.ts", "await", "--pm-id", options.pmId,
      "--project", project, "--request-id", merge.requestId]), "the merge request has no terminal result; use Dock's single-poller await path");
  }
  if (!dispatch) {
    gate = "not_applicable";
    return result("dispatch_missing", command(["garelier", "control", "get", options.workId, "--project", project, "--pm-id", options.pmId, "--format", "json"]),
      "no live implementation dispatch is bound; inspect canonical state before choosing an execution route");
  }
  // W-641: this fallback used to hard-code the codex leaf, so a claude lane
  // whose dispatch carried no task body (empty ready.result_file) always looked
  // like it had produced nothing. Share the one derivation instead. A ready.json
  // that cannot name its transport is not a lane whose register we can locate,
  // so it stays "no captured result" rather than guessing.
  const readyResult = typeof dispatch.ready.result_file === "string" && dispatch.ready.result_file
    ? dispatch.ready.result_file
    : (() => {
      try { return dockProxyRegisterLeaf(dispatch.container, dispatch.ready); }
      catch { return ""; }
    })();
  if (!existsSync(readyResult)) {
    const launch = typeof dispatch.ready.launch_cmd === "string" ? dispatch.ready.launch_cmd : "";
    return result("producer_launch", launch || command(["garelier", "status", "--project", project, "--pm-id", options.pmId]),
      launch ? "the producer has no captured result; run its canonical launch command" : "the producer has no captured result or launch command; inspect status");
  }
  if (pending > 0) {
    const resume = typeof dispatch.ready.resume_cmd === "string" ? dispatch.ready.resume_cmd : "";
    return result("ledger_pending", resume || command(["garelier", "status", "--project", project, "--pm-id", options.pmId]),
      `${pending} digest-bound instruction ledger entr${pending === 1 ? "y is" : "ies are"} pending; resume the producer to consume them`);
  }
  const handoff = inspectDockReviewHandoff({ project, pmId: options.pmId, dispatchId: dispatch.id });
  if (!handoff.ready) {
    const integration = loadConfig(project, options.pmId).branches.integration;
    const studioProbe = git(dispatch.checkout, ["rev-parse", "--verify", `${integration}^{commit}`]);
    const studioSha = studioProbe.stdout.trim();
    if (studioProbe.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(studioSha)) {
      throw new Error(`canonical integration branch ${integration} does not resolve to a full commit SHA in ${dispatch.checkout}`);
    }
    return result("review_prepare", command(["bun", "skills/garelier-core/driver/src/scripts/review_prepare.ts",
      "--project", project, "--pm-id", options.pmId, "--dispatch-id", dispatch.id,
      "--expected-studio-sha", studioSha]), `Dock review handoff postcondition is not satisfied: ${handoff.reason}`);
  }
  gate = "GREEN";
  const agents = object(dispatch.context.gate_agents);
  guardian = verdict(pmRoot, object(agents.guardian).report);
  observer = verdict(pmRoot, object(agents.observer).report);
  const role = !guardian || !PASSING.has(guardian) ? "guardian" : !observer || !PASSING.has(observer) ? "observer" : null;
  if (role) return result(`${role}_seat`, command(["garelier", "dispatch-prepare", "--attended-seat", "--role", role, "--dispatch-id", dispatch.id,
    "--project", project, "--pm-id", options.pmId]), `${role} lacks a passing canonical verdict; derive its exact seat plan from context.json`);
  return result("land", command(["bun", "skills/garelier-core/driver/src/scripts/merge_land.ts", "--project", project, "--target-root", targetRoot,
    "--pm-id", options.pmId, "--dispatch-id", dispatch.id]), "gate GREEN and both canonical verdict files pass; run the composed land path");
}

function valueAfter(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`missing value for ${argv[index]}`);
  return value;
}
export function main(argv = process.argv.slice(2)): number {
  const subcommand = argv[0] ?? "";
  let project = process.cwd(), targetRoot = "", pmId = "_workshop", workId = "", format = "text";
  for (let index = 1; index < argv.length;) {
    switch (argv[index]) {
      case "--project": project = valueAfter(argv, index); index += 2; break;
      case "--target-root": targetRoot = valueAfter(argv, index); index += 2; break;
      case "--pm-id": pmId = valueAfter(argv, index); index += 2; break;
      case "--work": workId = valueAfter(argv, index); index += 2; break;
      case "--format": format = valueAfter(argv, index); index += 2; break;
      default: throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (subcommand !== "next" || !/^W-\d+$/.test(workId) || !["text", "json"].includes(format)) throw new Error("usage: garelier pm next --work W-NNN [--project <root>] [--target-root <root>] [--pm-id <id>] [--format text|json]");
  loadConfig(resolve(project), pmId);
  const next = computePmNext({ project, targetRoot: targetRoot || undefined, pmId, workId });
  process.stdout.write(format === "json" ? `${JSON.stringify(next)}\n` : `STATE ${next.state}\nREASON ${next.reason}\nNEXT_COMMAND: ${next.next_command}\n`);
  return 0;
}
if (import.meta.main) {
  try { process.exit(main()); }
  catch (error) { process.stderr.write(`garelier pm: ${(error as Error).message}\n`); process.exit(2); }
}
