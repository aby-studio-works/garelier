#!/usr/bin/env bun

// PM-side composition for a committed dispatch review candidate. Every stage
// reuses a canonical helper; this file adds ordering, SHA/evidence admission,
// and fail-fast behavior only.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crewSubdir } from "../workspace.ts";
import { resolveGateSeatCommands } from "../guard/gate_seat_commands.ts";
import { runAttendedSpawn, type SpawnPlan } from "../dispatch/attended_seat.ts";
import { registerGateStepsDigest, runCli as runGateCli } from "./gate_runner.ts";
import { git, requireRuntimeExecutable, valueAfter } from "./_lib.ts";
import { rmSync } from "../guard/path_guard.ts";
import { admitDockProxyReadyPaths, resolveDockProxyRegisterPath } from "./dock_proxy.ts";
import { atomicWriteRuntimeFile } from "../control/diagnostics.ts";
import { gateRunRecordPath, readGateRunRecord } from "../dispatch/gate_run_record.ts";
import {
  digestReviewEvidence,
  dockReviewRecordPath,
  readDockReviewHandoffRecord,
  reviewEvidenceKey,
  reviewGateLogPath,
  writeDockReviewHandoffRecord,
} from "../dispatch/dock_review_record.ts";

export interface ReviewPrepareArgs {
  project: string;
  pmId: string;
  dispatchId: string;
  expectedStudioSha: string;
  /** W-693: execute a NEW gate run even when the Dock record already seals a
   * GREEN run over these log bytes. Off by default — see decideGateRun. */
  rerunGate?: boolean;
}

export interface ReviewPrepareDeps {
  runScript: (
    script: string,
    args: string[],
    env?: Record<string, string>,
  ) => { exitCode: number; stdout: string; stderr: string };
  prepareDockSeat: (opts: Parameters<typeof runAttendedSpawn>[0]) => SpawnPlan;
  runGate: typeof runGateCli;
  scripts?: Partial<Record<"bind" | "guardian" | "scannerEvidence" | "identity" | "gate" | "finalAccounting", string>>;
}

export interface ReviewPrepareResult {
  dispatch_id: number;
  review_sha: string;
  base_sha: string;
  expected_studio_sha: string;
  retired_evidence: string[];
  secret_scan: string;
  scanner_evidence: string;
  scanner_evidence_json: string;
  final_accounting: string;
  identity_scrub: "ran" | "not-applicable";
  dock_record: string;
  /** The coordinator-owned completion record outside the producer's fence. */
  dock_review_record: string;
  /** W-691: which checkout's review_prepare.ts/gate_runner.ts produced this
   * seal — `studio` (installed) or `candidate` (the dispatch's own checkout). */
  gate_script_source: string;
  /** W-693: whether this seal binds a run it executed, or the run an earlier
   * Dock record already sealed over the same log bytes. */
  gate_run_source: "executed" | "reused";
  gate: { code: number; message: string };
}

export interface ReviewGateAccounting {
  gate_result: string;
  coverage: string;
  uncovered_paths: string[];
  coverage_map_source: string;
  coverage_map_vs_studio: string;
}

export interface ExecutedGateRun {
  /** The run's own `GATE_START run_id=` token. */
  run_id: string;
  status: "GREEN" | "RED";
  /** The run slice from GATE_START up to (not including) the first step output
   * or terminal marker — the plan echo, the Dock attribution line, and the
   * register-audit diagnostics gate_runner writes there. */
  header: string;
}

/** Where a run slice stops being gate_runner's own pre-execution evidence and
 * becomes step stdout / terminal markers. `writer.line` emits the plan, the
 * attribution and the diagnostics in that order BEFORE the first step start,
 * so the prefix above this boundary is exactly the audit evidence a reused run
 * must be summarized from. */
const GATE_RUN_HEADER_END_RE = /^(?:=== STEP |GATE_SUMMARY_METRICS |GATE_STEP_CENSUS |RESULT |GATE_END )/m;

function lastExecutedGateRun(gateLogSource: string): ExecutedGateRun | undefined {
  const starts = [...gateLogSource.matchAll(/^GATE_START .*$/gm)].map((match) => match.index!);
  for (let index = starts.length - 1; index >= 0; index--) {
    const run = gateLogSource.slice(starts[index], starts[index + 1] ?? gateLogSource.length);
    const canonical = /^GATE_STEP_CENSUS .*\r?\nRESULT (GREEN|RED)\r?$/m.exec(run)?.[1];
    // Small fixtures predate the census marker. Accept only an unambiguous
    // terminal run so arbitrary step stdout cannot outrank a canonical run.
    const fallback = [...run.matchAll(/^RESULT (GREEN|RED)\r?$/gm)];
    const status = canonical
      ?? (fallback.length === 1 && /^GATE_END run_id=/m.test(run) ? fallback[0]![1] : undefined);
    if (!status) continue;
    const boundary = GATE_RUN_HEADER_END_RE.exec(run)?.index ?? run.length;
    return {
      run_id: /^GATE_START run_id=(\S+)/m.exec(run)?.[1] ?? "",
      status: status as "GREEN" | "RED",
      header: run.slice(0, boundary),
    };
  }
  return undefined;
}

function latestExecutedGateResult(gateLogSource: string): "GREEN" | "RED" | undefined {
  return lastExecutedGateRun(gateLogSource)?.status;
}

export type GateRunDecision =
  | { mode: "execute"; reason: string }
  | { mode: "reuse"; run: ExecutedGateRun };

/** W-693 / W-711: which gate run this seal binds.
 *
 * `review_prepare` used to execute a gate on EVERY invocation, so the seal
 * always carried a run created after the producer wrote its register — the
 * report quoted run X, the seal bound run Y, and the Observer refused the pair
 * as mismatched evidence. Re-reporting produced run Z and the same refusal:
 * #394 spent r43 and r44 inside that loop with the code already reviewed. The
 * loop is in the ORDER, not in either artifact, so the order is what changes:
 * a seal binds the run that is already sealed over these log bytes, and
 * executing a new one is the explicit request (`--rerun-gate`).
 *
 * `sealedRunId` is what makes that safe. `lane/gate-<sha>.log` sits inside the
 * producer's write fence (PV-1, dock_review_record.ts), so "the log says GREEN"
 * proves shape, not provenance — reusing on the log alone would let a producer
 * author a GREEN run and have the gate skipped entirely. Reuse is therefore
 * gated on the coordinator record OUTSIDE that fence still naming the same run
 * over the same log bytes; without it the gate simply runs.
 *
 * W-711 (DEC-100 ruling 2) removed the producer's part in this. The decision
 * used to ALSO require the register to quote `[gate] gate_run_id`, and refused
 * when it quoted nothing or quoted a different run. That put a hand-copied run
 * id on the critical path of a decision made entirely from two artifacts the
 * driver owns — the Dock record and its digest of the log — so a producer that
 * forgot the quote lost a round to a value that was never evidence: quoting the
 * run the Dock already sealed proves nothing the record does not prove better,
 * and quoting a DIFFERENT one is caught by the digest either way. The register
 * may still carry run ids in prose; nothing reads them.
 *
 * The decision is now total: every input state maps to `execute` or `reuse`,
 * and there is no state in which the Dock stops to ask the producer for a
 * value. The branch table is tabulated in `gate_field_manual.md` §A-8b. */
export function decideGateRun(input: {
  gateLogSource: string;
  /** The run id an existing, identity-and-digest-verified Dock review record
   * binds for this exact review SHA; "" when there is none. */
  sealedRunId: string;
  /** The register's declared REQUIRED GATE steps as that record sealed them. */
  sealedRequiredBlockDigest: string;
  /** The register's declared REQUIRED GATE steps as they stand NOW. */
  declaredRequiredBlockDigest: string;
  rerunRequested: boolean;
}): GateRunDecision {
  if (input.rerunRequested) return { mode: "execute", reason: "--rerun-gate requested" };
  const run = lastExecutedGateRun(input.gateLogSource);
  if (!run) return { mode: "execute", reason: "no terminal gate run in the review log" };
  if (run.status !== "GREEN") return { mode: "execute", reason: `last gate run ${run.run_id || "<unnamed>"} is ${run.status}` };
  if (!run.run_id) return { mode: "execute", reason: "last GREEN gate run carries no run_id to bind" };
  if (!input.sealedRunId) {
    return { mode: "execute", reason: `no Dock review record binds GREEN run ${run.run_id} over these log bytes` };
  }
  if (input.sealedRunId !== run.run_id) {
    return { mode: "execute", reason: `Dock review record binds run ${input.sealedRunId}, the log's last GREEN run is ${run.run_id}` };
  }
  // W-693 F-1. Reuse REPLAYS the sealed run's register audit — the declared
  // steps, their order, the coverage verdict — because gate_runner is the only
  // consumer of the register and reuse does not call it. The register is
  // producer-writable and the reuse flow exists precisely BECAUSE the producer
  // edits it between two Dock calls, so replaying an audit over a register that
  // no longer declares the same gate would re-issue GREEN for steps nothing
  // ran. Same argument as the gate log, applied to the second artifact the
  // decision trusts: bind it, and execute when it moved.
  if (input.sealedRequiredBlockDigest !== input.declaredRequiredBlockDigest) {
    return {
      mode: "execute",
      reason: "the register's declared REQUIRED GATE steps changed since the sealed run;"
        + " a replayed audit would not cover them",
    };
  }
  return { mode: "reuse", run };
}

/** The `gate.message` shape summarizeReviewGateAccounting consumes, rebuilt
 * from a run the log already holds. Coverage/diagnostic lines come from that
 * run's own header, never from the current process, so a reused seal reports
 * the reused run's audit rather than an empty one. */
function reusedGateMessage(run: ExecutedGateRun, gateLog: string): string {
  return `${run.header}SEAT reused-run\nRUN_ID ${run.run_id}\nRESULT ${run.status}\nlog=${gateLog}`;
}

/**
 * Keep the executed gate verdict distinct from the register coverage audit.
 * An audit refusal is recorded as RESULT REFUSED and may follow a completed
 * RESULT GREEN/RED run in the same canonical log; it must not rename that run.
 */
function summarizeReviewGateAccounting(
  gate: { code: number; message: string },
  gateLogSource: string,
): ReviewGateAccounting {
  const executed = latestExecutedGateResult(gateLogSource);
  const gateResult = executed === "GREEN"
    ? "GREEN (exit 0)"
    : executed === "RED"
      ? `RED (exit ${gate.code === 0 ? 1 : gate.code})`
      : "UNKNOWN (no terminal executed result)";

  const messageLines = gate.message.split(/\r?\n/);
  const auditEnd = messageLines.findIndex((line) => /^(?:SEAT |RESULT (?:GREEN|RED|REFUSED)\b)/.test(line));
  const diagnostics = auditEnd < 0 ? messageLines : messageLines.slice(0, auditEnd);
  const uncoveredPaths = [...new Set(diagnostics.flatMap((line) => {
    const uncovered = /^UNCOVERED\s+(.+?)\s+->/.exec(line);
    if (uncovered) return [uncovered[1]!];
    const closureOnly = /^COVERED_BY_CLOSURE_ONLY\s+(.+?)\s+->/.exec(line);
    if (closureOnly) return [closureOnly[1]!];
    const undeclaredTree = /^UNDECLARED_TEST_TREE\s+(.+)$/.exec(line);
    return undeclaredTree ? [undeclaredTree[1]!] : [];
  }))].sort();
  const changedPathMatches = diagnostics.flatMap((line) => {
    const match = /^CHANGED_PATHS\s+(\d+)$/.exec(line);
    return match ? [Number(match[1])] : [];
  });
  const changedPaths = changedPathMatches.at(-1);
  const coverage = uncoveredPaths.length > 0
    ? `UNCOVERED (${uncoveredPaths.length} of ${changedPaths ?? uncoveredPaths.length} changed paths)`
    : changedPaths !== undefined
      ? `COVERED (${changedPaths} of ${changedPaths} changed paths)`
      : "UNKNOWN (changed-path audit missing)";
  const coverageMapSource = diagnostics.flatMap((line) => {
    if (line === "COVERAGE_MAP_SOURCE candidate_checkout") return ["candidate checkout"];
    if (line === "COVERAGE_MAP_SOURCE studio_fallback_candidate_untracked") {
      return ["studio fallback (candidate config untracked)"];
    }
    return [];
  }).at(-1) ?? "UNKNOWN";
  const coverageMapVsStudio = diagnostics.flatMap((line) => {
    const match = /^COVERAGE_MAP_VS_STUDIO (CHANGED|UNCHANGED)$/.exec(line);
    return match ? [match[1]!] : [];
  }).at(-1) ?? "UNKNOWN";
  return {
    gate_result: gateResult,
    coverage,
    uncovered_paths: uncoveredPaths,
    coverage_map_source: coverageMapSource,
    coverage_map_vs_studio: coverageMapVsStudio,
  };
}

function parseArgs(argv: string[]): ReviewPrepareArgs {
  const out: ReviewPrepareArgs = { project: "", pmId: "", dispatchId: "", expectedStudioSha: "" };
  for (let index = 0; index < argv.length;) {
    switch (argv[index]) {
      case "--project": out.project = valueAfter(argv, index); index += 2; break;
      case "--pm-id": out.pmId = valueAfter(argv, index); index += 2; break;
      case "--dispatch-id": case "--id": out.dispatchId = valueAfter(argv, index); index += 2; break;
      case "--expected-studio-sha": out.expectedStudioSha = valueAfter(argv, index); index += 2; break;
      case "--rerun-gate": out.rerunGate = true; index += 1; break;
      default: throw new Error(`review_prepare: unknown arg: ${argv[index]}`);
    }
  }
  if (!out.project || !out.pmId || !/^\d+$/.test(out.dispatchId) || !/^[0-9a-f]{40}$/.test(out.expectedStudioSha)) {
    throw new Error("review_prepare: --project, --pm-id, numeric --dispatch-id, and --expected-studio-sha <full-sha> are required");
  }
  return out;
}

function defaultDeps(): ReviewPrepareDeps {
  return {
    runScript: (script, args, env) => {
      const result = Bun.spawnSync([requireRuntimeExecutable("bun"), script, ...args], {
        windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
      };
    },
    prepareDockSeat: runAttendedSpawn,
    runGate: runGateCli,
  };
}

function requireStage(result: { exitCode: number; stdout: string; stderr: string }, stage: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`review_prepare: ${stage} failed (exit=${result.exitCode}): ${(result.stderr || result.stdout).trim()}`);
  }
}

function resolveFullSha(checkout: string, ref: string, label: string): string {
  const result = git(checkout, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`review_prepare: ${label} does not resolve to a full commit SHA`);
  return sha;
}

function changedPaths(checkout: string, from: string, to: string, label: string): string[] {
  // Disable rename collapsing so both the source deletion and destination add
  // participate in the authority intersection. `-z` keeps every Git-valid
  // path byte-safe (including whitespace and newlines) without quote parsing.
  const result = git(checkout, ["diff", "--no-renames", "--name-only", "-z", `${from}..${to}`, "--"]);
  if (result.exitCode !== 0) throw new Error(`review_prepare: cannot enumerate ${label}`);
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

function retireStaleReviewEvidence(lane: string, reviewSha: string): string[] {
  const fixedLegacy = new Set(["base_sha.txt", "gitleaks.json", "gitleaks.stderr"]);
  const retired: string[] = [];
  for (const entry of readdirSync(lane)) {
    const shaEvidence = /^gitleaks-([0-9a-f]{9,40})(?:\..+)?$/.exec(entry);
    if (!fixedLegacy.has(entry) && (!shaEvidence || reviewSha.startsWith(shaEvidence[1]!))) continue;
    rmSync(resolve(lane, entry), { force: true });
    retired.push(entry);
  }
  return retired.sort();
}

/** W-691: the candidate paths that make the candidate its OWN gate authority.
 *
 * A dispatch that changes `gate_runner.ts` / `review_prepare.ts` / the markers
 * they emit declares a gate contract the STUDIO-installed script does not
 * implement. #394 ran the studio script against such a candidate for r34..r40:
 * the log carried none of the candidate's markers, the Observer read that as
 * "no formal GREEN consumable under the candidate's own contract", and the lane
 * reported PRE_LAND_UNATTAINABLE seven times. Nothing in the artifacts said
 * WHICH script produced them, so the mismatch was invisible until a PM
 * remembered the branch. Delegating (and recording the source either way) makes
 * the seal state its own provenance. */
const CANDIDATE_REVIEW_PREPARE = ["skills", "garelier-core", "driver", "src", "scripts", "review_prepare.ts"] as const;

/** W-743: the announcement that this run handed the gate+seal to the CANDIDATE's
 * own review_prepare.ts (§2-1d). Exported because `land_pipeline.ts` has to tell
 * that normal route apart from a refusal: it read the announcement as the
 * refusal detail and halted a land whose delegated gate had already sealed. A
 * copied literal on the reader's side agrees on the day it is written; this
 * keeps the two in one place. */
export const REVIEW_PREPARE_DELEGATION_MARKER = "delegated gate+seal to ";

/** W-693 F-2 / W-711 AC-5: the paths a candidate's gate contract is IMPLEMENTED
 * in, DERIVED from the one constant that names the delegate rather than kept by
 * hand.
 *
 * The hand-kept form listed three prefixes and started with `driver/src/`, so
 * `driver/tsconfig.json` and `driver/package.json` — which decide whether the
 * candidate's own scripts RUN at all — were outside the denominator: a candidate
 * that changed only those declared a gate contract nothing delegated to, which
 * is the W-691 symptom with no warning. Every prefix below now falls out of the
 * delegate's own path:
 *
 *   - the RUNNABLE PACKAGE (`…/driver/`, the delegate's path minus
 *     `src/scripts/<file>`): its sources plus the manifests and compiler config
 *     that make them executable. `node_modules/` is git-ignored, so an installed
 *     dependency never appears in a candidate diff.
 *   - the sibling asset trees that package reads BY PATH, under the same skill
 *     root: `templates/` (`renderFinalAccounting` asserts the template's
 *     `{{…}}` key set EQUALS the values it is given, so a template-only change
 *     makes the studio script throw on a placeholder mismatch) and `scripts/`
 *     (`lint_commits.ts`, which `merge_land` shells out to for the seat-trailer
 *     contract).
 *
 * This is a derivation from the delegate, not an import closure: a by-path read
 * that moved OUT of these two asset trees would still need its root added here.
 * The check below keeps that honest by pinning the shape of the constant. */
function candidateGateContractPrefixes(): readonly string[] {
  const segments = CANDIDATE_REVIEW_PREPARE;
  if (segments.length !== 6 || segments[3] !== "src" || segments[4] !== "scripts") {
    throw new Error("review_prepare: the gate-contract denominator cannot be derived from the delegate path");
  }
  const runnablePackage = segments.slice(0, 3).join("/");
  const skillRoot = segments.slice(0, 2).join("/");
  return [`${runnablePackage}/`, `${skillRoot}/templates/`, `${skillRoot}/scripts/`];
}
/** Set on the delegated child so it runs the gate instead of delegating again,
 * and records `candidate` as the source. An older candidate that predates this
 * contract simply ignores an unknown environment variable — which is why the
 * hand-off is an env var and not a new flag it would refuse to parse. */
const GATE_SCRIPT_SOURCE_ENV = "GARELIER_REVIEW_PREPARE_GATE_SCRIPT_SOURCE";

export interface SealedReuseAnchor {
  run_id: string;
  required_block_digest: string;
}

/** What an existing Dock review record binds for THIS review, or null.
 *
 * The record lives in the PM control root's `runtime/` tree, outside the roots
 * a producer is granted. Under the codex transport that grant is
 * `codexProviderWritableRoots()`; a claude-code producer is spawned with no
 * `--sandbox` / `--add-dir` at all and is contained instead by the installed
 * `guard/command_guard.ts` + `guard/path_guard.ts` fence roots (its worktree and
 * container). Fork A makes claude-code the default, so the second mechanism is
 * the one holding on the default path — the record is out of fence under both,
 * and a gate-skipping decision should name the containment that actually
 * applies to the path it defaults to (W-693 F-5).
 *
 * Accepted only when the record names this exact dispatch identity at a GREEN
 * exit AND its recorded digest still matches the gate log's current bytes. That
 * last check is the point: the log is producer-writable, so an appended or
 * replaced run must not look like the one the Dock sealed. Any doubt returns
 * null and the caller executes a gate. */
function sealedReuseAnchor(input: {
  project: string;
  pmId: string;
  dispatchId: string;
  branch: string;
  baseSha: string;
  reviewSha: string;
  gateLog: string;
}): SealedReuseAnchor | null {
  const record = readDockReviewHandoffRecord(dockReviewRecordPath(input.project, input.pmId, input.dispatchId));
  if (!record) return null;
  if (record.dispatch_id !== input.dispatchId || record.branch !== input.branch
    || record.base_sha !== input.baseSha || record.review_sha !== input.reviewSha) return null;
  if (record.gate_exit !== 0 || !record.gate_result.startsWith("GREEN")) return null;
  const recorded = record.evidence_digests[reviewEvidenceKey(input.gateLog)];
  if (!recorded) return null;
  try {
    if (digestReviewEvidence(input.gateLog) !== recorded) return null;
  } catch { return null; }
  // W-710: reuse a run only when that run said which tree it measured, and said
  // this one. A sealed run whose record is absent or whose heads disagree is not
  // an error here — it simply cannot be reused, so the gate runs again.
  if (record.gate_start_head !== input.reviewSha || record.gate_end_head !== input.reviewSha) return null;
  const runRecord = readGateRunRecord(gateRunRecordPath(input.project, input.pmId, input.gateLog));
  if (!runRecord || runRecord.run_id !== record.gate_run_id
    || runRecord.start_head !== record.gate_start_head || runRecord.end_head !== record.gate_end_head) return null;
  return { run_id: record.gate_run_id, required_block_digest: record.gate_required_block_digest };
}

/** The digest of the REQUIRED GATE steps the register declares right now.
 * Read once, before anything runs, and used for BOTH the reuse decision and the
 * seal this run writes, so the two can never describe different bytes. */
function declaredRequiredBlockDigest(registerPath: string): string {
  return registerGateStepsDigest(existsSync(registerPath) ? readFileSync(registerPath, "utf8") : "");
}

/** The binder's per-artifact `driver_overwrote=<fields>` census, as one line for
 * the final accounting (W-709 F-1).
 *
 * Read from the binder's own stdout rather than recomputed here: one producer of
 * the fact, one spelling. "none" is reported explicitly — an accounting that
 * simply omitted the line when nothing was overwritten would leave a reader
 * unable to tell "nothing to report" from "this Dock run did not look". */
export function summarizeDriverOverwrites(binderStdout: string): string {
  const overwrites = binderStdout.split(/\r?\n/).flatMap((line) => {
    const match = /^(\S+):\s.*\bdriver_overwrote=(\S+)/.exec(line.trim());
    return match && match[2] !== "none" ? [`${match[1]} ${match[2]}`] : [];
  });
  return overwrites.length > 0 ? overwrites.join("; ") : "none";
}

function samePathValue(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function renderFinalAccounting(template: string, values: Record<string, string>): string {
  const declared = [...template.matchAll(/\{\{([a-z_]+)\}\}/g)].map((match) => match[1]!);
  const expected = Object.keys(values).sort();
  if ([...new Set(declared)].sort().join("\n") !== expected.join("\n")
    || declared.length !== expected.length) {
    throw new Error("review_prepare: final accounting template placeholder set is invalid");
  }
  let rendered = template;
  for (const [name, value] of Object.entries(values)) rendered = rendered.replace(`{{${name}}}`, value);
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

export async function runReviewPrepare(
  args: ReviewPrepareArgs,
  deps: ReviewPrepareDeps = defaultDeps(),
): Promise<ReviewPrepareResult> {
  const project = resolve(args.project);
  const container = crewSubdir(project, args.pmId, `dispatch${args.dispatchId}`);
  const checkout = resolve(container, "checkout");
  const lane = resolve(container, "lane");
  const contextPath = resolve(container, "context.json");
  if (!existsSync(contextPath)) throw new Error(`review_prepare: context.json not found: ${contextPath}`);
  const context = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, any>;
  const readyPath = resolve(container, "ready.json");
  if (!existsSync(readyPath)) throw new Error(`review_prepare: ready.json not found: ${readyPath}`);
  const ready = JSON.parse(readFileSync(readyPath, "utf8")) as Record<string, any>;
  const admitted = admitDockProxyReadyPaths(project, container, ready);
  // A provider session record exists only on provider-subprocess lanes. On a
  // `commit_mode: self` lane (claude-code / pm-direct) there is none and never
  // will be, so requiring one made Dock review preparation unrunnable for every
  // such lane. Read it where it exists; fall back to ready.json's admitted
  // leaves where it structurally cannot. Both routes end at the same two paths.
  const session = existsSync(admitted.sessionPath)
    ? JSON.parse(readFileSync(admitted.sessionPath, "utf8")) as Record<string, any>
    : null;
  const resultPath = resolveDockProxyRegisterPath(admitted, session);
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const scripts = {
    bind: deps.scripts?.bind ?? resolve(scriptDir, "bind_review_sha.ts"),
    guardian: deps.scripts?.guardian ?? resolve(scriptDir, "..", "guardian_scan.ts"),
    scannerEvidence: deps.scripts?.scannerEvidence ?? resolve(scriptDir, "scanner_evidence.ts"),
    identity: deps.scripts?.identity ?? resolve(scriptDir, "identity_scrub_lint.ts"),
    gate: deps.scripts?.gate ?? resolve(scriptDir, "gate_runner.ts"),
    finalAccounting: deps.scripts?.finalAccounting ?? resolve(scriptDir, "../../../templates/final_accounting.md"),
  };
  for (const [stage, path] of Object.entries(scripts)) {
    if (stage === "identity") continue;
    if (!existsSync(path)) throw new Error(`review_prepare: required ${stage} script not found: ${path}`);
  }
  const reviewSha = resolveFullSha(checkout, "HEAD", "review HEAD");
  const baseRef = String(context.task?.base_sha ?? "").trim();
  if (!baseRef) throw new Error("review_prepare: context.task.base_sha is required");
  const baseSha = resolveFullSha(checkout, baseRef, "dispatch base");
  if (reviewSha === baseSha) throw new Error("review_prepare: review HEAD equals dispatch base; review commit is missing");
  const ancestry = git(checkout, ["merge-base", "--is-ancestor", baseSha, reviewSha]);
  if (ancestry.exitCode !== 0) {
    throw new Error(`review_prepare: dispatch base ${baseSha} is not an ancestor of review HEAD ${reviewSha}`);
  }
  const expectedStudioSha = resolveFullSha(checkout, args.expectedStudioSha, "expected studio");
  const authorityAncestry = git(checkout, ["merge-base", "--is-ancestor", baseSha, expectedStudioSha]);
  if (authorityAncestry.exitCode !== 0) {
    throw new Error(`review_prepare: expected studio ${expectedStudioSha} is not descended from dispatch base ${baseSha}`);
  }
  const studioMergeBase = git(checkout, ["merge-base", expectedStudioSha, reviewSha]);
  if (studioMergeBase.exitCode !== 0 || studioMergeBase.stdout.trim() !== expectedStudioSha) {
    const candidatePaths = new Set(changedPaths(checkout, baseSha, reviewSha, "candidate paths"));
    const drift = changedPaths(checkout, baseSha, expectedStudioSha, "expected studio drift");
    const overlaps = drift.filter((path) => candidatePaths.has(path));
    if (overlaps.length > 0) {
      throw new Error(
        `review_prepare: review HEAD ${reviewSha} does not contain overlapping expected studio authority ${expectedStudioSha}: ${overlaps.join(",")}`,
      );
    }
  }
  // W-691: decide, and record, WHICH checkout's gate scripts produce this seal.
  const selfScript = resolve(scriptDir, "review_prepare.ts");
  const candidateScript = resolve(checkout, ...CANDIDATE_REVIEW_PREPARE);
  const delegatedSource = (process.env[GATE_SCRIPT_SOURCE_ENV] ?? "").trim();
  let gateScriptSource = "studio";
  if (delegatedSource === "candidate" || samePathValue(selfScript, candidateScript)) {
    // Either the studio script delegated to us, or the PM invoked the candidate
    // script directly (the #394 workaround). Both mean: this IS the candidate.
    gateScriptSource = "candidate";
  } else {
    const driverChanges = changedPaths(checkout, baseSha, reviewSha, "candidate gate-contract paths")
      .filter((path) => candidateGateContractPrefixes().some((prefix) => path.startsWith(prefix)));
    if (driverChanges.length > 0) {
      if (existsSync(candidateScript)) {
        const delegated = deps.runScript(candidateScript, [
          "--project", project, "--pm-id", args.pmId, "--dispatch-id", args.dispatchId,
          "--expected-studio-sha", expectedStudioSha,
          ...(args.rerunGate ? ["--rerun-gate"] : []),
        ], { [GATE_SCRIPT_SOURCE_ENV]: "candidate" });
        process.stderr.write(
          `review_prepare: candidate changes ${driverChanges.length} gate-contract path(s); ${REVIEW_PREPARE_DELEGATION_MARKER}${candidateScript}\n`,
        );
        if (delegated.stderr) process.stderr.write(delegated.stderr);
        const lastLine = delegated.stdout.trim().split(/\r?\n/).at(-1) ?? "";
        let parsed: ReviewPrepareResult | undefined;
        try { parsed = JSON.parse(lastLine) as ReviewPrepareResult; } catch { parsed = undefined; }
        if (!parsed || typeof parsed !== "object" || parsed.review_sha !== reviewSha) {
          throw new Error(
            `review_prepare: candidate review_prepare.ts produced no bindable result (exit=${delegated.exitCode}): `
            + `${(delegated.stderr || delegated.stdout).trim() || "<no output>"}`,
          );
        }
        return parsed;
      }
      // Fork D fallback: an older candidate has no script to delegate to. Run
      // here, but say so — a seal that silently used studio scripts against a
      // candidate gate contract is what cost #394 seven rounds.
      gateScriptSource = `studio (candidate driver changed but ${candidateScript.replace(/\\/g, "/")} is absent)`;
      process.stderr.write(
        `review_prepare: WARNING candidate changes ${driverChanges.length} gate-contract path(s) but has no ${CANDIDATE_REVIEW_PREPARE.join("/")};`
        + " running the studio-installed gate scripts — a candidate-defined gate contract will NOT be satisfied by this run\n",
      );
    }
  }

  const gateLog = reviewGateLogPath(lane, reviewSha);
  // W-693 / W-711: bind the run the Dock already sealed over these exact log
  // bytes, or execute one. Both inputs are coordinator-owned; the producer
  // register contributes only its declared gate steps, whose digest is bound in
  // the same record.
  const sealed = sealedReuseAnchor({
    project, pmId: args.pmId, dispatchId: args.dispatchId,
    branch: String(context.task?.branch ?? ""), baseSha, reviewSha, gateLog,
  });
  const requiredBlockDigest = declaredRequiredBlockDigest(resultPath);
  const gateDecision = decideGateRun({
    gateLogSource: existsSync(gateLog) ? readFileSync(gateLog, "utf8") : "",
    sealedRunId: sealed?.run_id ?? "",
    sealedRequiredBlockDigest: sealed?.required_block_digest ?? "",
    declaredRequiredBlockDigest: requiredBlockDigest,
    rerunRequested: Boolean(args.rerunGate),
  });
  const retiredEvidence = retireStaleReviewEvidence(lane, reviewSha);

  // W-709 F-1: the binder ANNOUNCES which driver-owned `[gate]` fields it
  // replaced, and that announcement is the whole contract that replaced a
  // refusal. It arrives on the binder's stdout, which `requireStage` reads only
  // when the stage FAILED — so on the producer-commits route (the route W-709's
  // harm story comes from) the announcement was written to a pipe and dropped:
  // no artifact, no seal, no reader. Carry it into the Dock-owned accounting,
  // which the seal digests, so the overwrite is visible exactly where the rest
  // of the Dock's findings are.
  const bind = deps.runScript(scripts.bind, [
    "--container", container, "--review", reviewSha, "--base", baseSha, "--gate-log", gateLog,
    "--result", resultPath, "--replace",
  ]);
  requireStage(bind, "bind_review_sha");
  const driverOwnedOverwrites = summarizeDriverOverwrites(bind.stdout);

  const secretScan = resolve(lane, "secret-scan.md");
  requireStage(deps.runScript(scripts.guardian, [
    "--project", checkout, "--base", baseSha, "--head", reviewSha,
    "--config", resolve(project, "__garelier", args.pmId, "_crew", "pm", "setup_config.toml"),
    "--security-root", resolve(checkout, "__garelier", args.pmId, "knowledge", "security"),
    "--scope", "diff", "--out", secretScan,
  ]), "guardian_scan");
  const scan = JSON.parse(readFileSync(secretScan, "utf8")) as Record<string, any>;
  if (scan.scan_state !== "complete" || scan.scope?.base_ref !== baseSha || scan.scope?.head_ref !== reviewSha) {
    throw new Error(
      `review_prepare: guardian scan evidence is stale or incomplete (base_ref=${String(scan.scope?.base_ref)}, head_ref=${String(scan.scope?.head_ref)})`,
    );
  }

  const pmRoot = resolve(project, "__garelier", args.pmId);
  const declaredScanner = resolveGateSeatCommands(pmRoot);
  if (declaredScanner.commands.length !== 1 || declaredScanner.drift.length > 0) {
    throw new Error(`review_prepare: canonical mandatory scanner command is unavailable (${declaredScanner.drift.join("; ") || "no declaration"})`);
  }
  const scannerCommand = declaredScanner.commands[0]!;
  const scannerEvidence = resolve(lane, `scanner-${reviewSha.slice(0, 12)}.md`);
  requireStage(deps.runScript(scripts.scannerEvidence, [
    "--checkout", checkout, "--base", baseSha, "--head", reviewSha,
    "--command", scannerCommand, "--out", scannerEvidence,
  ]), "scanner_evidence");
  const scannerJson = `${scannerEvidence}.json`;
  const scannerFacts = JSON.parse(readFileSync(scannerJson, "utf8")) as Record<string, any>;
  if (scannerFacts.head !== reviewSha || scannerFacts.base !== baseSha || scannerFacts.exit !== 0
    || scannerFacts.scanner_command !== scannerCommand) {
    throw new Error("review_prepare: mandatory scanner evidence does not bind the review metadata and exact head");
  }

  let identityScrub: "ran" | "not-applicable" = "not-applicable";
  if (existsSync(scripts.identity)) {
    requireStage(deps.runScript(scripts.identity, [checkout]), "identity_scrub_lint");
    identityScrub = "ran";
  }

  const dock = deps.prepareDockSeat({
    role: "dock", slug: `${String(context.task?.slug ?? `dispatch-${args.dispatchId}`)}-review`,
    project, pmId: args.pmId, dispatchId: args.dispatchId, worktree: checkout,
  });
  if (!dock.record_path) throw new Error("review_prepare: Dock attended seat did not produce a permission record");
  const register = resultPath;
  const gate = gateDecision.mode === "reuse"
    ? { code: 0, message: reusedGateMessage(gateDecision.run, gateLog) }
    : await deps.runGate([
      "--project", project, "--pm-id", args.pmId, "--cwd", checkout,
      "--from-register", register, "--log", gateLog,
    ], {
      ...process.env,
      GARELIER_ROLE: "dock",
      GARELIER_AGENT_NAME: dock.name,
      GARELIER_DISPATCH_RECORD: dock.record_path,
    });
  if (gate.code === 0) {
    requireStage(deps.runScript(scripts.bind, [
      "--container", container, "--review", reviewSha, "--base", baseSha,
      "--result", resultPath, "--replace", "--gate-log", gateLog, "--gate-result", "GREEN",
    ]), "bind_review_sha GREEN stamp");
  }
  // W-710: what the run itself recorded about the tree it measured. Read once
  // and used for three things: the seal's run id, the seal's P-9 heads, and the
  // refusal below. Nothing here parses the log for any of them.
  //
  // A run whose checkout moved between its first and last step measured two
  // commits, so no seal over it describes one review — the same class #394
  // spent r34..r40 on, which the proposed `GATE_START head=` log markers would
  // have left to a regex. Refused BEFORE the seal is written, so the handoff is
  // simply absent rather than wrong. A run that recorded no head at all (a cwd
  // that is not a repository) asserts nothing and is not refused; it cannot be
  // reused either, because sealedReuseAnchor requires the heads to equal this
  // review.
  const runRecordPath = gateRunRecordPath(project, args.pmId, gateLog);
  const runRecord = readGateRunRecord(runRecordPath);
  if (runRecord && (runRecord.start_head !== runRecord.end_head
    || (runRecord.start_head !== "" && runRecord.start_head !== reviewSha))) {
    throw new Error(
      `review_prepare: gate run ${runRecord.run_id || "<unnamed>"} measured`
      + ` ${runRecord.start_head || "<unknown>"}..${runRecord.end_head || "<unknown>"} in ${runRecord.cwd},`
      + ` not the review commit ${reviewSha}; the checkout moved under the gate, so no seal can bind this run`
      + " (re-run the gate on a still checkout).",
    );
  }
  const finalAccounting = resolve(lane, "final_accounting.md");
  const gateLogSource = existsSync(gateLog) ? readFileSync(gateLog, "utf8") : "";
  const gateAccounting = summarizeReviewGateAccounting(gate, gateLogSource);
  const uncoveredPaths = gateAccounting.uncovered_paths.length > 0
    ? `- Uncovered paths:\n${gateAccounting.uncovered_paths.map((path) => `  - \`${path}\``).join("\n")}`
    : "- Uncovered paths: none";
  atomicWriteRuntimeFile(lane, finalAccounting, renderFinalAccounting(
    readFileSync(scripts.finalAccounting, "utf8"),
    {
      branch: String(context.task?.branch ?? ""),
      base_sha: baseSha,
      review_sha: reviewSha,
      producer_result: resultPath.replace(/\\/g, "/"),
      guardian_scan: secretScan.replace(/\\/g, "/"),
      scanner_evidence: scannerEvidence.replace(/\\/g, "/"),
      scanner_evidence_json: scannerJson.replace(/\\/g, "/"),
      gate_log: gateLog.replace(/\\/g, "/"),
      gate_result: gateAccounting.gate_result,
      coverage: gateAccounting.coverage,
      coverage_details: uncoveredPaths,
      coverage_map_source: gateAccounting.coverage_map_source,
      coverage_map_vs_studio: gateAccounting.coverage_map_vs_studio,
      driver_owned_overwrites: driverOwnedOverwrites,
      gate_script_source: gateScriptSource,
      gate_run_source: gateDecision.mode === "reuse"
        ? `reused (Dock-sealed run ${gateDecision.run.run_id})`
        : `executed (${gateDecision.reason})`,
      gate_summary: gate.message.replace(/[\r\n]+/g, " ").trim() || "none",
    },
  ));
  // PV-1 (OBS-RW-001): every artifact above lives under `dispatch<N>/lane/`,
  // which provider_session.ts grants the producer write access to. Their
  // contents therefore prove shape, not authorship. Seal the run with a record
  // in the PM control root's runtime tree — outside every producer-writable
  // root — that binds this dispatch identity, the exact gate run, its separated
  // result/coverage outcome, and the digest of each artifact as the Dock wrote
  // it. Gate-seat issuance requires this record, so a producer-authored lane
  // cannot advance the handoff. Written last: nothing may change afterwards
  // without invalidating a digest.
  const dockReviewRecord = writeDockReviewHandoffRecord({
    project, pmId: args.pmId, dispatchId: args.dispatchId,
    branch: String(context.task?.branch ?? ""),
    baseSha, reviewSha,
    // W-710: the run id comes from the run record, not from a `GATE_START
    // run_id=` regex over the log. A log with two appended runs has two of those
    // markers and the regex bound whichever came last in the FILE; the record is
    // one object that the last run replaced, so there is one answer.
    gateRunId: runRecord?.run_id ?? "",
    gateRequiredBlockDigest: requiredBlockDigest,
    gateStartHead: runRecord?.start_head ?? "",
    gateEndHead: runRecord?.end_head ?? "",
    gateExit: gate.code,
    gateResult: gateAccounting.gate_result,
    coverage: gateAccounting.coverage,
    coverageMapSource: gateAccounting.coverage_map_source,
    coverageMapVsStudio: gateAccounting.coverage_map_vs_studio,
    dockSeat: dock.name,
    dockRecord: dock.record_path,
    // W-710: the run record joins the digested evidence when the run wrote one,
    // so a later rewrite of the heads or the run id is detected like any other
    // handoff artifact. `attended_seat` derives the same set with the same
    // existence test; either direction of tampering changes the set and fails
    // the seat closed.
    evidence: [secretScan, scannerEvidence, scannerJson, gateLog, finalAccounting,
      ...(runRecord ? [runRecordPath] : [])],
  });
  return {
    dispatch_id: Number(args.dispatchId), review_sha: reviewSha, base_sha: baseSha,
    expected_studio_sha: expectedStudioSha,
    retired_evidence: retiredEvidence,
    secret_scan: secretScan, scanner_evidence: scannerEvidence, scanner_evidence_json: scannerJson,
    final_accounting: finalAccounting,
    identity_scrub: identityScrub, dock_record: dock.record_path,
    dock_review_record: dockReviewRecord,
    gate_script_source: gateScriptSource,
    gate_run_source: gateDecision.mode === "reuse" ? "reused" : "executed",
    gate,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const result = await runReviewPrepare(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.gate.code;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
