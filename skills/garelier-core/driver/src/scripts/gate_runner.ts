#!/usr/bin/env bun
// gate_runner.ts — W-157: the ONE verified heavy-gate skeleton, so a lane never
// hand-writes lock/trap/marker/log again (the #353/#354 gate deaths: a package-name
// typo + a line-14 parse error left the lock stuck with no trap, and 3 OOM/exit1
// runs had no consistent RESULT marker). The Dock seat passes only a STEP LIST
// (project-declared command strings); the runner supplies:
//   1. heavy_compile_lock acquire with a NATIVE owner pid (this Bun process's
//      process.pid is a Windows PID, so the W-169 git-bash-$$ blind spot never
//      applies — the "winpid conversion" is built in);
//   2. fail-closed release ordering (no GREEN/LOCK_RELEASED is durable before
//      the release subprocess succeeds);
//   3. serial step execution into a run-owned slice, then append-only history;
//   4. the marker contract (GATE_START / LOCK_ACQUIRED|LOCK_DISABLED /
//      STEP … EXIT n / RESULT GREEN|RED / ABORT_FAILOPEN / LOCK_RELEASED);
//   5. project-declared, run-scoped summary extraction.
//
// It also converts a codex lane's delegated required gate (--from-register): a
// codex sandbox seat cannot take heavy_compile_lock (fence-out write), so it lists
// its required gate for the Dock seat to run here (#361, user 裁定 2026-07-18: codex-
// only implementation makes this the standard path).

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { appendGuardedFileSync, assertSafeLeaf, rmSync, rmdirSync, writeGuardedFileSync } from "../guard/path_guard.ts";
import { crewSubdir } from "../workspace.ts";
import { git, pidAlive, requireRuntimeExecutable, resolveBashExecutable, resolveCommand } from "./_lib.ts";
import { gateRunRecordPath, writeGateRunRecord } from "../dispatch/gate_run_record.ts";
import { runFileBackedProcess } from "./file_backed_process.ts";
import {
  evaluate,
  findDispatchPermissionRecord,
  DEFAULT_POLICY,
  type GuardPolicy,
} from "../guard/command_guard.ts";
import { ROLE_PERMISSION_PROFILE } from "../guard/permission_profiles.ts";
import { isSecretEnvKey, hasEmbeddedCredential, minimalEnv } from "./spawn_env.ts";
import { injectLaneEnv, resolveLaneEnv, skippedLaneEnvDiagnostics, type LaneEnv, type LaneEnvContext } from "./lane_env.ts";
import {
  loadConfig,
  loadLaneEnv,
  type RegisterGateConfig,
  type RegisterOrderCheckConfig,
} from "../config.ts";
import { globMatch } from "../observer_policy_check.ts";
import { recordHeavyCompileProgress, resolveMainRoot } from "../../../scripts/heavy_compile_lock.ts";
import {
  appendStepLedger,
  assertAppendedStepEvidence,
  bunTestTargetEvidence,
  collectStepMetrics,
  completedStepLogPath,
  createStepIdentity,
  finalizeStepLedgerEntry,
  parseBunTestArgv,
  readToolchainVersions,
  stepCommandArgv,
  stepArgvSha256,
  trackingRowOpen,
  type StepIdentity,
  type StepLedgerEntry,
  type StepLedgerEntryMaterial,
  type StepTestEvidence,
} from "./gate_step_ledger.ts";

// W-249: the env-minimizer (MINIMAL_ENV_KEYS / SECRET_ENV_RE / isSecretEnvKey /
// hasEmbeddedCredential / minimalEnv) moved to spawn_env.ts so merge-gate.ts's
// own quality-gate command spawn and the codex/claude provider launchers share
// the SAME minimizer instead of each re-inventing (or, until W-249, omitting)
// one. Re-exported here so this module's own callers/tests keep importing them
// from gate_runner.ts.
export { isSecretEnvKey, hasEmbeddedCredential, minimalEnv };

export interface GateIntermittentAllowance {
  pattern: string;
  dimension: string;
  cause: string;
  trackingRow: string;
  alternateConfidenceBasis: string;
}

export interface GateStep {
  name: string;
  cmd: string;
  intermittent?: GateIntermittentAllowance;
}

export interface RegisterStepParseResult {
  steps: GateStep[];
  refusal?: string;
}

// --- step parsing ----------------------------------------------------------

/** Parse a steps file. TOML: `[[step]] name=… cmd=…` (or a top-level `steps`
 * array); JSON: `{"steps":[{name,cmd}]}` or a bare array. A step's `cmd` is a
 * project-declared shell command; `name` defaults to `step<N>`. */
export function parseSteps(content: string, format: "toml" | "json"): GateStep[] {
  let raw: unknown;
  try { raw = format === "toml" ? parseToml(content) : JSON.parse(content); }
  catch (e) { throw new Error(`gate_runner: could not parse ${format} steps: ${(e as Error).message}`); }
  const list = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>)?.step ?? (raw as Record<string, unknown>)?.steps);
  if (!Array.isArray(list)) throw new Error("gate_runner: steps file has no `step`/`steps` array");
  const steps: GateStep[] = [];
  for (const [i, entry] of list.entries()) {
    const cmd = typeof entry === "string" ? entry : String((entry as Record<string, unknown>)?.cmd ?? "");
    if (!cmd.trim()) throw new Error(`gate_runner: step ${i + 1} has an empty cmd`);
    const name = (typeof entry === "object" && entry && String((entry as Record<string, unknown>).name || "").trim())
      || `step${i + 1}`;
    const record = typeof entry === "object" && entry ? entry as Record<string, unknown> : {};
    const intermittent = typeof record.retry_pattern === "string" ? {
      pattern: record.retry_pattern,
      dimension: String(record.uncovered_dimension ?? "intermittent step result"),
      cause: String(record.uncovered_cause ?? record.retry_pattern),
      trackingRow: String(record.tracking_row ?? ""),
      alternateConfidenceBasis: String(record.alternate_confidence_basis ?? "one bounded same-run retry"),
    } : undefined;
    if (intermittent && !/^W-\d+$/.test(intermittent.trackingRow)) {
      throw new Error(`gate_runner: step ${i + 1} intermittent retry requires tracking_row = W-NNN`);
    }
    if (intermittent) {
      try { new RegExp(intermittent.pattern); }
      catch (error) { throw new Error(`gate_runner: step ${i + 1} retry_pattern is invalid: ${(error as Error).message}`); }
    }
    steps.push({ name, cmd: cmd.trim(), intermittent });
  }
  if (steps.length === 0) throw new Error("gate_runner: steps file is empty");
  return steps;
}

/** Extract the Dock gate commands a codex lane delegated in its register (#361).
 * The block is delimited by a `=== REQUIRED GATE (Dock-run) ===` line and a closing
 * `=== END REQUIRED GATE ===`; each non-empty, non-comment line inside is one step
 * (a bare project command, or `name: command …`). Empty when the block is absent. */
export function parseRegisterSteps(registerText: string): RegisterStepParseResult {
  const start = /^\s*===+\s*REQUIRED GATE\s*\(Dock-run\)\s*===+\s*$/im;
  const end = /^\s*===+\s*END REQUIRED GATE\s*===+\s*$/im;
  const lines = registerText.split(/\r?\n/);
  let inBlock = false;
  let ended = false;
  const steps: GateStep[] = [];
  for (const line of lines) {
    if (!inBlock) { if (start.test(line)) inBlock = true; continue; }
    if (end.test(line)) { ended = true; break; }
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const named = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(t);
    if (named && /\s/.test(named[2])) steps.push({ name: named[1], cmd: named[2].trim() });
    else steps.push({ name: `step${steps.length + 1}`, cmd: t });
  }
  if (!inBlock) return { steps, refusal: "required_gate_block_missing" };
  if (!ended) return { steps, refusal: "required_gate_end_marker_missing" };
  return { steps };
}

export function stepsFromRegister(registerText: string): GateStep[] {
  return parseRegisterSteps(registerText).steps;
}

/** The digest of what a register DECLARES this gate must run (W-693 F-1).
 *
 * Lives here, beside the parser, so the value can never be derived from a
 * second reading of the block: a caller that wants to know whether the declared
 * gate changed asks the same function the runner asks. It digests the PARSED
 * steps rather than the raw bytes, so reflowing prose or a comment inside the
 * block is not a change, while renaming a step, editing a command, reordering,
 * adding or dropping one is. A register whose block is absent or unterminated
 * digests its refusal reason, so "no block" and "an empty block" stay distinct
 * from any real declaration. */
export function registerGateStepsDigest(registerText: string): string {
  const parsed = parseRegisterSteps(registerText);
  const canonical = parsed.refusal
    ? `refusal:${parsed.refusal}`
    : parsed.steps.map((step) => `${step.name} ${step.cmd}`).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// --- project-declared register audit ---------------------------------------

export interface RegisterAuditInput {
  roleSteps: GateStep[];
  policy: RegisterGateConfig;
  changedPaths: string[];
  trackedPaths: string[];
}

export interface RegisterAuditResult {
  ok: boolean;
  steps: GateStep[];
  diagnostics: string[];
}

export interface CandidateRegisterGatePolicy {
  policy: RegisterGateConfig;
  diagnostics: string[];
  coverageMapChanged: boolean;
}

function repoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function canonicalCoverageMap(policy: RegisterGateConfig): string {
  const rules = policy.coverage.map((rule) => ({
    paths: [...new Set(rule.paths)].sort(),
    steps: [...new Set(rule.steps)].sort(),
  }));
  return JSON.stringify(rules.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

/** Resolve the touched-path map from the candidate checkout while retaining
 * executable gate authority (prefixes, closure, timeout, and summaries) from
 * the studio checkout. A candidate may propose new coverage for its own paths,
 * but it cannot use that proposal to self-authorize commands or weaken closure. */
export function resolveCandidateRegisterGatePolicy(
  projectRoot: string,
  pmId: string,
  candidateCheckout: string,
): CandidateRegisterGatePolicy {
  const studioPolicy = loadConfig(resolve(projectRoot), pmId).qualityGate.register;
  const candidateRoot = resolve(candidateCheckout);
  const candidateConfig = join(crewSubdir(candidateRoot, pmId, "pm"), "setup_config.toml");
  let source = "candidate_checkout";
  let candidatePolicy: RegisterGateConfig;
  if (existsSync(candidateConfig)) {
    candidatePolicy = loadConfig(candidateRoot, pmId).qualityGate.register;
  } else {
    const relativeConfig = repoPath(relative(candidateRoot, candidateConfig));
    const tracked = gitPathList(candidateRoot, ["ls-files", "--error-unmatch", "--", relativeConfig]);
    if (!tracked.error) {
      throw new Error(`candidate setup_config.toml is tracked but missing at ${candidateConfig}`);
    }
    // Some target projects keep setup_config only in the operator checkout.
    // They cannot propose a map change, so retain studio policy and say so.
    candidatePolicy = studioPolicy;
    source = "studio_fallback_candidate_untracked";
  }
  const coverageMapChanged = canonicalCoverageMap(candidatePolicy) !== canonicalCoverageMap(studioPolicy);
  return {
    policy: {
      ...studioPolicy,
      declared: studioPolicy.declared && candidatePolicy.declared,
      validationError: candidatePolicy.validationError
        ? `candidate ${candidatePolicy.validationError}`
        : studioPolicy.validationError
          ? `studio ${studioPolicy.validationError}`
          : undefined,
      coverage: candidatePolicy.coverage,
    },
    diagnostics: [
      `COVERAGE_MAP_SOURCE ${source}`,
      `COVERAGE_MAP_VS_STUDIO ${coverageMapChanged ? "CHANGED" : "UNCHANGED"}`,
    ],
    coverageMapChanged,
  };
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  return command.trimStart().startsWith(prefix);
}

function commandMentionsAny(command: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => command.includes(pattern));
}

function argvStartsWith(argv: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= argv.length && prefix.every((part, index) => argv[index] === part);
}

function argvContains(argv: readonly string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0 || sequence.length > argv.length) return false;
  return argv.some((_, index) => argvStartsWith(argv.slice(index), sequence));
}

/** Return writer patterns that cannot be assigned to distinct qualifying
 * steps. Distinctness keeps a multi-pattern writer contract from being
 * accidentally satisfied by one command that happens to contain two patterns. */
function missingWriterPatterns(
  steps: readonly { argv: string[] | null }[],
  writerPatterns: readonly string[][],
  writerExcludePatterns: readonly string[][],
): number[] {
  const candidates = steps
    .map((step, index) => ({ argv: step.argv, index }))
    .filter((step): step is { argv: string[]; index: number } => step.argv !== null)
    .filter(({ argv }) => !writerExcludePatterns.some((pattern) => argvContains(argv, pattern)));
  const stepToPattern = new Map<number, number>();
  const assign = (patternIndex: number, seen: Set<number>): boolean => {
    for (const candidate of candidates) {
      if (seen.has(candidate.index) || !argvStartsWith(candidate.argv, writerPatterns[patternIndex]!)) continue;
      seen.add(candidate.index);
      const displaced = stepToPattern.get(candidate.index);
      if (displaced === undefined || assign(displaced, seen)) {
        stepToPattern.set(candidate.index, patternIndex);
        return true;
      }
    }
    return false;
  };
  return writerPatterns.map((_, index) => index).filter((index) => !assign(index, new Set()));
}

function isUnderDeclaredRoot(path: string, roots: readonly string[]): boolean {
  const normalized = repoPath(path);
  return roots.some((root) => {
    const declared = repoPath(root);
    return declared !== "" && (normalized === declared || normalized.startsWith(`${declared}/`));
  });
}

/** Audit a worker-authored register against the project-owned declaration.
 * Closure is removed from the role-selected position and appended in the
 * declared order, so omission or early placement cannot weaken the terminal
 * whole-project check. */
export function auditRegisterGate(input: RegisterAuditInput): RegisterAuditResult {
  const { policy } = input;
  if (policy.validationError) {
    return {
      ok: false,
      steps: input.roleSteps,
      diagnostics: [`CONFIG_INVALID ${policy.validationError}`],
    };
  }
  if (!policy.declared) {
    return {
      ok: false,
      steps: input.roleSteps,
      diagnostics: ["CONFIG_MISSING [quality_gate.register]"],
    };
  }
  if (!policy.testTrees) {
    return {
      ok: false,
      steps: input.roleSteps,
      diagnostics: ["CONFIG_MISSING [quality_gate.register.test_trees]"],
    };
  }

  const errors: string[] = [];
  const evidence: string[] = [];
  const closureCommands = new Set(policy.closure.map((step) => step.cmd));
  const closureStepNames = new Set(policy.closure.map((step) => step.name));
  let roleSteps = input.roleSteps.filter((step) => !closureCommands.has(step.cmd));
  const presentSteps = new Set<string>();
  const declaredByRoleStep = new Map<GateStep, Set<string>>();

  for (const step of roleSteps) {
    const matches = policy.steps.filter((declared) =>
      declared.commandPrefixes.some((prefix) => commandMatchesPrefix(step.cmd, prefix)));
    if (matches.length === 0) {
      errors.push(`UNDECLARED_REGISTER_STEP ${step.name}: ${step.cmd}`);
      continue;
    }
    const declared = new Set(matches.map((match) => match.name));
    declaredByRoleStep.set(step, declared);
    for (const match of matches) presentSteps.add(match.name);
  }

  const supersessionPresence = new Set([...presentSteps, ...closureStepNames]);
  const activeSupersessions = policy.supersessions.filter(({ step, supersededBy }) =>
    supersessionPresence.has(step) && supersessionPresence.has(supersededBy));
  for (const { step, supersededBy } of activeSupersessions) {
    evidence.push(`STEP-SKIPPED ${step} superseded_by=${supersededBy}`);
  }
  const supersededNames = new Set(activeSupersessions.map(({ step }) => step));
  roleSteps = roleSteps.filter((step) =>
    ![...(declaredByRoleStep.get(step) ?? [])].some((name) => supersededNames.has(name)));
  const steps = [...roleSteps, ...policy.closure.map(({ name, cmd }) => ({ name, cmd }))];
  const orderSteps = steps.map((step) => ({ ...step, argv: literalCommandArgv(step.cmd) }));

  evidence.push(`STEP_ORDER_CHECKS ${policy.orderChecks.length}`);
  for (const check of policy.orderChecks) {
    const parsePatterns = (kind: string, patterns: readonly string[]): string[][] => patterns.flatMap((pattern) => {
      const argv = literalCommandArgv(pattern);
      if (!argv) errors.push(`STEP_ORDER_PATTERN_UNREPRESENTABLE ${check.name} ${kind}: ${pattern}`);
      return argv ? [argv] : [];
    });
    const writerPatterns = parsePatterns("writer", check.writerPatterns);
    const consumerPatterns = parsePatterns("consumer", check.consumerPatterns);
    const writerExcludePatterns = parsePatterns("writer-exclude", check.writerExcludePatterns);
    const consumerExcludePatterns = parsePatterns("consumer-exclude", check.consumerExcludePatterns);
    if (
      writerPatterns.length !== check.writerPatterns.length
      || consumerPatterns.length !== check.consumerPatterns.length
      || writerExcludePatterns.length !== check.writerExcludePatterns.length
      || consumerExcludePatterns.length !== check.consumerExcludePatterns.length
    ) continue;
    orderSteps.forEach((step, index) => {
      if (
        !step.argv
        && commandMentionsAny(steps[index]!.cmd, [
          ...check.writerPatterns,
          ...check.consumerPatterns,
          ...check.writerExcludePatterns,
          ...check.consumerExcludePatterns,
        ])
      ) {
        errors.push(`STEP_ORDER_UNREPRESENTABLE ${check.name} ${step.name}@${index + 1}: ${steps[index]!.cmd}`);
      }
    });
    const consumers = orderSteps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) =>
        step.argv !== null
        && consumerPatterns.some((pattern) => argvStartsWith(step.argv!, pattern))
        && !consumerExcludePatterns.some((pattern) => argvContains(step.argv!, pattern)));
    if (consumers.length === 0) {
      evidence.push(`STEP_ORDER_NOT_APPLICABLE ${check.name} consumer_steps=0`);
      continue;
    }
    const first = consumers[0]!;
    const missingIndexes = missingWriterPatterns(
      orderSteps.slice(0, first.index), writerPatterns, writerExcludePatterns,
    );
    const missing = missingIndexes.map((index) => check.writerPatterns[index]!);
    if (missing.length > 0) {
      errors.push(
        `STEP_ORDER_VIOLATION ${check.name} consumer=${first.step.name}@${first.index + 1} `
        + `missing_writers=${JSON.stringify(missing)}`,
      );
      continue;
    }
    evidence.push(
      `STEP_ORDER_OK ${check.name} consumer_steps=${consumers.length} first_consumer=${first.step.name}@${first.index + 1}`,
    );
  }

  const changedPaths = [...new Set(input.changedPaths.map(repoPath).filter(Boolean))].sort();
  evidence.push(`CHANGED_PATHS ${changedPaths.length}`);
  for (const path of changedPaths) {
    const rules = policy.coverage.filter((rule) => rule.paths.some((glob) => globMatch(glob, path)));
    if (rules.length === 0) {
      errors.push(`UNCOVERED ${path} -> no coverage rule`);
      continue;
    }
    let coveringStep = "";
    for (const rule of rules) {
      coveringStep = rule.steps.find((step) => presentSteps.has(step)) ?? "";
      if (coveringStep) break;
    }
    if (!coveringStep) {
      const closureOnly = [...new Set(rules.flatMap((rule) => rule.steps))]
        .filter((step) => closureStepNames.has(step))
        .sort();
      if (closureOnly.length > 0) {
        errors.push(`COVERED_BY_CLOSURE_ONLY ${path} -> ${closureOnly.join(", ")}`);
        continue;
      }
      const expected = [...new Set(rules.flatMap((rule) => rule.steps))].sort();
      errors.push(`UNCOVERED ${path} -> expected one of: ${expected.join(", ")}`);
      continue;
    }
    evidence.push(`COVERED ${path} -> ${coveringStep}`);
  }

  const markerPaths = [...new Set(input.trackedPaths.map(repoPath).filter((path) =>
    policy.testTrees!.markerGlobs.some((glob) => globMatch(glob, path))))].sort();
  const undeclaredTrees = markerPaths.filter((path) => !isUnderDeclaredRoot(path, policy.testTrees!.roots));
  for (const path of undeclaredTrees) errors.push(`UNDECLARED_TEST_TREE ${path}`);
  evidence.push(
    `TEST_TREE_INVENTORY markers=${markerPaths.length} roots=${policy.testTrees.roots.length} undeclared=${undeclaredTrees.length}`,
  );
  evidence.push(`SUMMARY_METRICS_REQUIRED ${policy.summaryMetrics.join(",") || "none"}`);

  for (const step of policy.closure) evidence.push(`CLOSURE_APPENDED ${step.name}: ${step.cmd}`);
  return { ok: errors.length === 0, steps, diagnostics: [...errors, ...evidence] };
}

// --- project-declared summary extraction ----------------------------------

/** Matching lines are returned verbatim and in order. Patterns are project
 * declarations; the framework carries no language/test-runner vocabulary. */
export function extractSummaryLines(log: string, patterns: readonly string[]): string[] {
  const compiled = patterns.map((pattern) => new RegExp(pattern));
  return log.split(/\r?\n/)
    .filter((line) => compiled.some((pattern) => pattern.test(line)))
    .map((line) => line.trim());
}

function oneLineError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim() || "unknown error";
}

/** Start a run on a fresh log line. A prior crash may leave a partial final
 * line; the separator preserves an unambiguous next boundary without rewriting
 * history. The leading newline is part of the same append as the marker, so a
 * concurrent partial writer cannot join text onto the boundary. */
/** The gate log lives in the producer lane and is append-only, so it cannot
 * use the staged writer. GDN-B14 still applies to the leaf: check it once,
 * fail closed, before this run appends anything to it. */
function beginRunLog(logPath: string, runId: string, startedAt: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendGuardedFileSync(logPath, `\n${GATE_MARKERS.start(runId, startedAt)}\n`, "gate log");
}

class RunSliceWriter {
  private readonly chunks: Buffer[] = [];
  private byteLength = 0;
  private closed = false;
  private atLineStart = true;

  write(text: string): void {
    if (this.closed) throw new Error("gate_runner: run slice is already closed");
    const chunk = Buffer.from(text, "utf8");
    this.chunks.push(chunk);
    this.byteLength += chunk.byteLength;
    if (chunk.byteLength > 0) this.atLineStart = chunk[chunk.byteLength - 1] === 0x0a;
  }

  line(line: string): void {
    if (!this.atLineStart) this.write("\n");
    this.write(line + "\n");
  }

  /** Bytes written so far, so a caller can freeze a sub-range of its own
   * slice BEFORE it appends evidence that must stay out of that range. */
  get offset(): number {
    return this.byteLength;
  }

  close(): { data: Buffer; endOffset: number } {
    if (this.closed) throw new Error("gate_runner: run slice is already closed");
    this.closed = true;
    return {
      data: Buffer.concat(this.chunks, this.byteLength),
      endOffset: this.byteLength,
    };
  }
}

/** Extract declared summary lines from a run-owned byte range. The caller
 * freezes `endOffset` when its private writer closes, so ambient appends to the
 * shared history can never enter this slice. */
export function extractSummaryLinesFromRange(
  data: Uint8Array,
  patterns: readonly string[],
  startOffset: number,
  endOffset: number,
): string[] {
  if (patterns.length === 0 || endOffset <= startOffset) return [];
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const compiled = patterns.map((pattern) => new RegExp(pattern));
  const lines: string[] = [];
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const consume = (text: string, final: boolean): void => {
    pending += text;
    const complete = pending.split("\n");
    pending = final ? "" : (complete.pop() ?? "");
    for (const raw of complete) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (compiled.some((pattern) => pattern.test(line))) lines.push(line.trim());
    }
  };

  let position = startOffset;
  while (position < endOffset) {
    const next = Math.min(position + 64 * 1024, endOffset);
    consume(decoder.write(bytes.subarray(position, next)), false);
    position = next;
  }
  consume(decoder.end(), true);
  return lines;
}

// --- marker contract -------------------------------------------------------

export const GATE_MARKERS = {
  start: (runId: string, startedAt: string) =>
    `GATE_START run_id=${runId} started_at=${startedAt}`,
  end: (runId: string) => `GATE_END run_id=${runId}`,
  lockAcquired: (token: string) => `LOCK_ACQUIRED token=${token}`,
  lockDisabled: () => `LOCK_DISABLED (heavy_compile disabled — running without the lock)`,
  attribution: (agentName: string, source: string) =>
    `GATE_ATTRIBUTION seat=dock agent=${agentName} external_record=${source}`,
  abortFailopen: (reason: string) => `ABORT_FAILOPEN ${reason}`,
  acquireFailed: (reason: string) => `ACQUIRE_FAILED ${reason}`,
  stepPlanned: (name: string, cmd: string) => `STEP-PLANNED ${name}: ${cmd}`,
  stepStart: (name: string, iso: string) => `=== STEP ${name} START ${iso} ===`,
  stepPid: (name: string, pid: number) => `STEP_PID ${name}: pid=${pid}`,
  stepTimeout: (name: string, timeoutMs: number) => `STEP_TIMEOUT ${name}: timeout_ms=${timeoutMs}`,
  stepExit: (name: string, code: number) => `=== STEP ${name} EXIT ${code} ===`,
  stepUncovered: (name: string) => `STEP ${name} UNCOVERED (0 selected)`,
  stepRejected: (name: string, reason: string) => `ABORT_STEP_REJECTED ${name}: ${reason}`,
  runFailed: (reason: string) => `RUN_FAILED ${reason}`,
  lockReleaseFailed: (reason: string) => `LOCK_RELEASE_FAILED ${reason}`,
  result: (green: boolean) => `RESULT ${green ? "GREEN" : "RED"}`,
  lockReleased: () => `LOCK_RELEASED`,
} as const;

/** Test fixtures that intentionally print failure-shaped text bracket it with
 * these markers. The gate keeps the raw lines in its durable log, but excludes
 * them from the operator-facing failure diagnosis so a negative oracle is not
 * misattributed as the failing production step (W-594 / W-563 N-3). */
export const NEGATIVE_ORACLE_START = "=== GARELIER NEGATIVE ORACLE START ===";
export const NEGATIVE_ORACLE_END = "=== GARELIER NEGATIVE ORACLE END ===";
const FAILURE_SUMMARY_START = "=== FAILURE SUMMARY ===";
const FAILURE_SUMMARY_END = "=== END FAILURE SUMMARY ===";
const FAILURE_LINE_RE = /error\[E|panicked at|test result: FAILED|FAILED|error:|Error:/;
const FAILURE_ERROR_LINE_LIMIT = 20;

interface FailedStepEvidence {
  name: string;
  command: string;
  exit: number;
  tail: string[];
  errors: string[];
}

class StepFailureCollector {
  private pending = "";
  private negativeOracle = false;
  readonly tail: string[] = [];
  readonly errors: string[] = [];

  write(text: string, final = false): void {
    const parts = (this.pending + text).split(/\r?\n/);
    const trailing = parts.pop() ?? "";
    this.pending = final ? "" : trailing;
    for (const line of parts) this.line(line);
    if (final && trailing) this.line(trailing);
  }

  private line(line: string): void {
    if (line.includes(NEGATIVE_ORACLE_START)) { this.negativeOracle = true; return; }
    if (line.includes(NEGATIVE_ORACLE_END)) { this.negativeOracle = false; return; }
    if (this.negativeOracle) return;
    this.tail.push(line);
    if (this.tail.length > 20) this.tail.shift();
    if (FAILURE_LINE_RE.test(line) && this.errors.length < FAILURE_ERROR_LINE_LIMIT) this.errors.push(line);
  }
}

function failureSummaryLines(failures: readonly FailedStepEvidence[], runFailure = ""): string[] {
  const lines = [FAILURE_SUMMARY_START];
  if (failures.length === 0) {
    // A RED run with no failing step failed somewhere else (acquire, step
    // identity, batch cleanup, or an exception in the loop). Naming it here puts
    // the reason in the CALLER's message, not only in the durable log — a caller
    // that has the log path but not the log itself could otherwise only guess.
    lines.push(runFailure ? `RUN_FAILED ${runFailure}` : "(no non-zero step exits; inspect gate diagnostics above)");
  }
  for (const failure of failures) {
    lines.push(`STEP ${failure.name}`);
    lines.push(`command: ${failure.command}`);
    lines.push(`exit: ${failure.exit}`);
    lines.push("tail (last 20 lines):");
    lines.push(...(failure.tail.length > 0 ? failure.tail : ["(no output)"]));
    lines.push("error lines:");
    lines.push(...(failure.errors.length > 0 ? failure.errors : ["(none matched)"]));
  }
  lines.push(FAILURE_SUMMARY_END);
  return lines;
}

export interface AuditRedOptions {
  logPath: string;
  diagnostics: readonly string[];
  refusal?: string;
  plan?: readonly string[];
  now?: () => string;
  runId?: () => string;
}

function auditRefusalReason(diagnostics: readonly string[]): string {
  const violations = diagnostics.map((line) => line.trim()).filter((line) => /^(?:REGISTER_REFUSED|CONFIG_(?:INVALID|MISSING)|UNDECLARED_REGISTER_STEP|STEP_ORDER_|UNCOVERED\s|COVERED_BY_CLOSURE_ONLY|UNDECLARED_TEST_TREE|REGISTER_AUDIT_ERROR|DOCK_ATTRIBUTION_ERROR)/.test(line));
  const first = violations.find((line) => line.startsWith("UNDECLARED_REGISTER_STEP"))
    ?? violations.filter((line) => line.startsWith("UNCOVERED ")).at(-1)
    ?? violations[0]
    ?? diagnostics.find((line) => line.trim())?.trim()
    ?? "register_audit_failed";
  const undeclared = /^UNDECLARED_REGISTER_STEP\s+[^:]+:\s*(.*)$/.exec(first);
  if (undeclared) return `undeclared_step:${undeclared[1]!.replace(/\s+/g, "_").slice(0, 160)}`;
  const uncovered = /^UNCOVERED\s+(.+?)\s+->/.exec(first);
  if (uncovered) return `uncovered_path:${uncovered[1]}`;
  return first.toLowerCase().replace(/[^a-z0-9._:/-]+/g, "_").slice(0, 200);
}

/** Persist a pre-execution register-audit refusal with a run boundary and the
 * exact violation evidence. A refusal never takes the lock or runs a command,
 * but it is a terminal, machine-visible RESULT (W-600 AC-4c). */
export function recordAuditRed(opts: AuditRedOptions): { runId: string; startedAt: string; message: string } {
  const startedAt = (opts.now ?? (() => new Date().toISOString()))();
  const runId = (opts.runId ?? randomUUID)();
  const plan = [...(opts.plan ?? [])];
  const diagnostics = [...opts.diagnostics];
  const refusal = opts.refusal ?? auditRefusalReason(diagnostics);
  const writer = new RunSliceWriter();
  for (const line of plan) writer.line(line);
  for (const line of diagnostics) writer.line(line);
  writer.line(`RESULT REFUSED reason=${refusal}`);
  writer.line(GATE_MARKERS.end(runId));
  const slice = writer.close();
  let logError = "";
  try {
    beginRunLog(opts.logPath, runId, startedAt);
    appendGuardedFileSync(opts.logPath, slice.data, "gate log");
  } catch (error) {
    logError = `AUDIT_LOG_ERROR ${(error as Error).message}`;
  }
  return {
    runId,
    message: [
      ...plan,
      ...diagnostics,
      `RESULT REFUSED reason=${refusal}`,
      ...(logError ? [logError] : []),
      `RUN_ID ${runId}`,
      `STARTED_AT ${startedAt}`,
      `log=${resolve(opts.logPath)}`,
    ].join("\n"),
    startedAt,
  };
}

// --- step validation (W-157 Guardian BLOCK) --------------------------------

// A `--from-register` step is authored by the (untrusted, sandbox-fenced) worker
// seat, so its command prefix must match a project-owned declaration;
// `--steps` and automatically appended project closure steps skip that prefix
// check. EVERY step is additionally run through the real
// command_guard evaluate() BEFORE execution, at a role seat fenced to the
// checkout — so egress / pipe-to-shell / destructive / index-mutating commands are
// DENIED exactly as at the Bash-tool layer this Bun-spawned path would otherwise
// bypass (`curl … | sh`, `rm -rf`, `git push`, `env … curl`).
const GATE_GUARD_POLICY: GuardPolicy = {
  ...DEFAULT_POLICY,
  remote_exec_guard_enabled: true, pipe_to_shell_guard_enabled: true, network_egress_guard_enabled: true,
  git_egress_guard_enabled: true, codex_raw_exec_guard_enabled: true, recursive_delete_guard_enabled: true,
  indirect_delete_guard_enabled: true, secret_file_guard_enabled: true, force_write_guard_enabled: true,
  path_fence_guard_enabled: true, process_kill_guard_enabled: true,
  control_misplace_guard_enabled: true,
};

export interface StepCheck { ok: boolean; reason: string }

export interface GateStepRunResult {
  exitCode: number;
  testEvidence?: StepTestEvidence;
}

/** Validate ONE step before execution: (2) the register-mode project prefixes, then
 * (1) the real command_guard evaluate() at a role seat fenced to the checkout. A
 * non-allow verdict (deny/ask) rejects the step and the gate does not run it. */
export function checkStep(
  cmd: string,
  opts: { cwd: string; allowedCommandPrefixes?: readonly string[] },
): StepCheck {
  if (
    opts.allowedCommandPrefixes !== undefined &&
    !opts.allowedCommandPrefixes.some((prefix) => commandMatchesPrefix(cmd, prefix))
  ) {
    return {
      ok: false,
      reason: "command prefix is not declared by [quality_gate.register.steps] — PM must review the project policy",
    };
  }
  const d = evaluate({ command: cmd, tool: "Bash", cwd: opts.cwd, profile: "role", fenceRoots: [opts.cwd], policy: GATE_GUARD_POLICY });
  if (d.action !== "allow") return { ok: false, reason: `command_guard ${d.action} (${d.rule})` };
  return { ok: true, reason: "" };
}

// --- executor --------------------------------------------------------------

export interface GateRunnerDeps {
  /** Acquire the heavy lock; returns the token line ("<slot>" | "OPEN" | "DISABLED"). */
  acquire: (ownerPid: string) => string;
  /** Release the lock by token; throw unless release is confirmed successful. */
  release: (token: string) => void;
  /** Record verified gate-log growth for the held lock; throw when the hold is lost. */
  progress?: (token: string) => void;
  /** Run one step in `cwd`, writing output only through the run-owned sink. */
  runStep: (
    cmd: string,
    cwd: string,
    writeOutput: (text: string) => void,
    timeoutMs: number,
    recordPid: (pid: number) => void,
    recordProgress: () => void,
  ) => number | GateStepRunResult | Promise<number | GateStepRunResult>;
  /** Stable step identity and append-only completion ledger (W-605). */
  identifyStep?: (step: GateStep, cwd: string) => StepIdentity | Promise<StepIdentity>;
  appendLedger?: (path: string, entry: StepLedgerEntry) => void;
  /** Tracking rows make an intermittent retry self-expiring. */
  trackingRowOpen?: (row: string) => boolean;
  /** Gate/Smith resource-priority lifecycle. Hooks are production-owned and
   * injectable so a contract test never touches the machine-wide lock root. */
  beginBatch?: (kind: "gate" | "smith", runId: string) => void | Promise<void>;
  beforeStep?: (kind: "gate" | "smith", step: GateStep) => void | Promise<void>;
  endBatch?: (kind: "gate" | "smith", runId: string) => void | Promise<void>;
  /** Sweep stale holders before acquiring. This makes a prior dead gate-runner
   * visible/reclaimable at startup instead of relying on a later waiter. */
  sweepStale?: () => void;
  /** Validate a step BEFORE execution (W-157 BLOCK): allowlist + command_guard. */
  checkStep: (cmd: string) => StepCheck;
  /** Wall-clock stamp (injectable for deterministic tests). */
  now?: () => string;
  /** Unique run id (injectable only for deterministic tests). */
  runId?: () => string;
  ownerPid?: string;
  /** W-710: the commit `cwd` resolves to. Probed once before the first step and
   * once after the last, so the run record can state whether the tree it
   * measured stayed one commit. Returns "" when `cwd` is not a repository. */
  headProbe?: (cwd: string) => string;
}

const CARGO_TEST_VALUE_OPTIONS = new Set([
  "--bench", "--bin", "--color", "--config", "--example", "--exclude",
  "--features", "--jobs", "--manifest-path", "--message-format", "--package",
  "--profile", "--target", "--target-dir", "--test", "-F", "-j", "-p", "-Z",
]);

function executableName(path: string): string {
  return basename(path).toLowerCase().replace(/\.exe$/, "");
}

/** A filtered test step promises that at least one test is selected. Keep this
 * predicate on the command itself: the worker register cannot self-assert a
 * coverage flag that would let a stale filter opt out of detection. */
function hasTestSelectionFilter(command: string): boolean {
  const argv = literalCommandArgv(command);
  if (!argv) return false;
  const executable = executableName(argv[0]!);
  if (executable === "cargo") {
    const testIndex = argv[1]?.startsWith("+") ? 2 : 1;
    if (argv[testIndex] !== "test") return false;
    const args = argv.slice(testIndex + 1);
    if (args.includes("--exact")) return true;
    const separator = args.indexOf("--");
    const cargoArgs = separator < 0 ? args : args.slice(0, separator);
    for (let index = 0; index < cargoArgs.length; index += 1) {
      const arg = cargoArgs[index]!;
      if (CARGO_TEST_VALUE_OPTIONS.has(arg)) { index += 1; continue; }
      if (arg.startsWith("-")) continue;
      return true;
    }
    return false;
  }
  if (executable === "bun" && argv[1] === "test") {
    return (parseBunTestArgv(command)?.selectionFilterValues.length ?? 0) > 0;
  }
  return false;
}

function bunTestCommand(command: string): boolean {
  const argv = literalCommandArgv(command);
  return argv?.[0]?.toLowerCase().replace(/\.exe$/, "") === "bun" && argv[1] === "test";
}

/** The parent calls this only after its exact direct Bun child exits. Counts
 * come from tracked source parsed by the parent; child output and child-created
 * files have no authority over target identity, counts, or GREEN reuse. */
export function runnerAuthenticatedTestResult(
  command: string,
  cwd: string,
  exitCode: number,
): GateStepRunResult {
  if (exitCode !== 0) return { exitCode };
  const invocation = parseBunTestArgv(command);
  if (!invocation) throw new Error("parent test evidence requires an explicit Bun test command");
  const targets = bunTestTargetEvidence(invocation, cwd);
  if (targets.length === 0) throw new Error("parent test evidence requires explicit tracked test targets");
  return {
    exitCode,
    testEvidence: {
      schema_version: 2,
      runner: "gate-parent-direct",
      declared_argv_sha256: stepArgvSha256(invocation.argv),
      definition_count: targets.reduce((sum, target) => sum + target.definition_count, 0),
      targets,
    },
  };
}

function runnerEvidenceMatches(command: string, cwd: string, evidence: StepTestEvidence | undefined): boolean {
  try {
    const invocation = parseBunTestArgv(command);
    if (!invocation || !evidence
      || evidence.declared_argv_sha256 !== stepArgvSha256(invocation.argv)) return false;
    const targets = bunTestTargetEvidence(invocation, cwd);
    return JSON.stringify(evidence.targets) === JSON.stringify(targets)
      && evidence.definition_count === targets.reduce((sum, target) => sum + target.definition_count, 0);
  } catch { return false; }
}

interface TestSelectionObservation {
  pending: string;
  sawCount: boolean;
  selectedAny: boolean;
}

function observeTestSelection(
  observation: TestSelectionObservation,
  text: string,
  final = false,
): void {
  const complete = (observation.pending + text).split(/\r?\n/);
  observation.pending = final ? "" : (complete.pop() ?? "");
  for (const raw of complete) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const match = /^\s*running\s+(\d+)\s+tests?\s*$/i.exec(line)
      ?? /\b(\d+)\s+passed;.*?\b\d+\s+filtered out\b/i.exec(line)
      ?? /^\s*Ran\s+(\d+)\s+tests?\b/i.exec(line)
      ?? /^\s*(\d+)\s+pass(?:ed)?\s*$/i.exec(line);
    if (!match) continue;
    observation.sawCount = true;
    if (Number(match[1]) > 0) observation.selectedAny = true;
  }
}

/** Dispatcher-owned proof that the process invoking the gate occupies Dock.
 * gate_runner only consumes this record; it never mints or widens a permission
 * record as a side effect of running verification. */
export interface DockGateAttribution {
  seat: "dock";
  agentName: string;
  recordPath: string;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathContains(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (
    !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\")
  );
}

/** Resolve Dock attribution from the record selected by the launching seat.
 * The record must have been issued by dispatch_prepare outside this process and
 * live in the PM's protected attended-record directory. A missing, mismatched,
 * self-issued, or relocated record blocks the gate before execution. */
export function resolveDockGateAttribution(opts: {
  projectRoot: string;
  pmId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): DockGateAttribution {
  const env = opts.env ?? process.env;
  const role = env.GARELIER_ROLE?.trim();
  const agentName = env.GARELIER_AGENT_NAME?.trim();
  const selectedPath = env.GARELIER_DISPATCH_RECORD?.trim();
  if (role !== "dock") {
    throw new Error("external Dock attribution requires GARELIER_ROLE=dock");
  }
  if (!agentName) {
    throw new Error("external Dock attribution requires GARELIER_AGENT_NAME");
  }
  if (!selectedPath) {
    throw new Error("external Dock attribution requires GARELIER_DISPATCH_RECORD");
  }

  const record = findDispatchPermissionRecord(opts.projectRoot, agentName, env);
  if (!record || !samePath(record.source, selectedPath)) {
    throw new Error("selected external Dock dispatch record is missing or rejected");
  }
  // attended_record historically wrote the permission profile into guard.role
  // (for Dock: "baseline-destructive"). Do not make that compatibility field a
  // second, impossible role predicate. The dispatcher-owned Dock identity is the
  // canonical ga-dock-* agent bound to this exact protected record; profile,
  // location, and provenance are independently checked below.
  if (record.agent_name !== agentName || !/^ga-dock-[a-z0-9][a-z0-9-]*$/.test(agentName)) {
    throw new Error("external dispatch record does not bind a canonical Dock agent");
  }
  if (record.permission_profile !== ROLE_PERMISSION_PROFILE.dock) {
    throw new Error("external Dock dispatch record has the wrong permission profile");
  }
  if (!record.worktree || !pathContains(record.worktree, opts.cwd)) {
    throw new Error("gate cwd is outside the externally bound Dock worktree");
  }

  const recordPath = resolve(record.source);
  const attendedRoot = resolve(
    opts.projectRoot, "__garelier", opts.pmId, "_crew", "lanes", ".meta",
  );
  if (!samePath(dirname(recordPath), attendedRoot) || !basename(recordPath).endsWith(".dispatch.json")) {
    throw new Error("external Dock attribution is not a canonical PM attended record");
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`external Dock attribution record is unreadable: ${(error as Error).message}`);
  }
  if (raw.source !== "attended_record" || raw.spawned_via !== "dispatch_prepare") {
    throw new Error("external Dock attribution was not issued by dispatch_prepare");
  }
  return { seat: "dock", agentName, recordPath };
}

export interface GateRunOptions {
  steps: GateStep[];
  cwd: string;
  logPath: string;
  summaryPatterns?: readonly string[];
  /** Valid declarations omitted because this gate path lacks their context. */
  diagnostics?: readonly string[];
  /** Project policy budget, derived from quality_gate.timeout_minutes_per_cmd. */
  timeoutMs: number;
  /** W-567: external, dispatcher-issued proof that the caller occupies Dock. */
  dockAttribution?: DockGateAttribution;
  /** A resume request is recorded for disclosure only. Candidate-controlled
   * steps always execute because this runner has no immutable executor. */
  ledgerPath?: string;
  /** W-710: where this run writes its own record (heads + cwd + run id). Chosen
   * by the caller, like ledgerPath, so the runner never writes gate evidence
   * into the tree it is measuring. Absent = no record is written. */
  runRecordPath?: string;
  resumeRequested?: boolean;
  batchKind?: "gate" | "smith";
}
export interface GateRunResult {
  status: "GREEN" | "RED" | "ABORT_FAILOPEN";
  runId: string;
  startedAt: string;
  token: string;
  summaryLines: string[];
  failureSummaryLines: string[];
  code: number;
  plan: string[];
  sliceEndOffset: number;
  executedSteps: number;
  skippedGreenSteps: number;
  metrics: { schema_version: 1; test_count: number; finished_seconds: number; duplicate_test_names: number };
}

/** Run the gate: PRE-EXEC ECHO the planned steps → VALIDATE every step (project
 * prefix policy + command_guard) → acquire → serial steps → confirmed release →
 * markers → extract. A
 * rejected step aborts BEFORE any lock/execution (RESULT RED, no command runs — the
 * fenced worker's register can never proxy an unreviewed command). The UUID
 * boundary is durable before validation/acquire; terminal evidence is appended
 * only after a successful release. OPEN from acquire = infrastructure ABORT;
 * DISABLED = run without the lock. */
export async function runGate(opts: GateRunOptions, deps: GateRunnerDeps): Promise<GateRunResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const runId = (deps.runId ?? randomUUID)();
  let executedSteps = 0;
  const skippedGreenSteps = (opts.diagnostics ?? []).filter((line) => line.startsWith("STEP-SKIPPED ")).length;
  let testCount = 0;
  let finishedSeconds = 0;
  const testNames = new Map<string, number>();
  const observeSummaryMetrics = (output: string, evidence?: StepTestEvidence): void => {
    testCount += evidence?.definition_count ?? 0;
    for (const match of output.matchAll(/\bfinished in\s+([0-9]+(?:\.[0-9]+)?)s\b/gi)) {
      finishedSeconds += Number(match[1]);
    }
    for (const line of output.split(/\r?\n/)) {
      const name = /^\s*test\s+(.+?)\s+\.\.\.\s+(?:ok|FAILED)\s*$/i.exec(line)?.[1]
        ?? /^\s*\((?:pass|fail)\)\s+(.+?)(?:\s+\[[0-9.]+m?s\])?\s*$/i.exec(line)?.[1];
      if (name) testNames.set(name, (testNames.get(name) ?? 0) + 1);
    }
  };
  const summaryMetrics = () => ({
    schema_version: 1 as const,
    test_count: testCount,
    finished_seconds: Math.round(finishedSeconds * 1000) / 1000,
    duplicate_test_names: [...testNames.values()].filter((count) => count > 1).length,
  });
  // W-710: the tree this run measures, probed around the steps rather than
  // echoed into the log for a regex to find later.
  const headProbe = deps.headProbe ?? ((cwd: string): string => {
    const probe = git(cwd, ["rev-parse", "HEAD"]);
    const sha = probe.stdout.trim();
    return probe.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : "";
  });
  const startHead = headProbe(opts.cwd);
  try {
    beginRunLog(opts.logPath, runId, startedAt);
  } catch {
    return {
      status: "RED",
      runId,
      startedAt,
      token: "",
      summaryLines: [],
      failureSummaryLines: [],
      code: 1,
      plan: [],
      sliceEndOffset: 0,
      executedSteps,
      skippedGreenSteps,
      metrics: summaryMetrics(),
    };
  }

  const writer = new RunSliceWriter();
  const failures: FailedStepEvidence[] = [];
  const plan = opts.steps.map((s) => GATE_MARKERS.stepPlanned(s.name, s.cmd));
  for (const line of plan) writer.line(line);
  if (opts.dockAttribution) {
    writer.line(GATE_MARKERS.attribution(
      opts.dockAttribution.agentName,
      opts.dockAttribution.recordPath,
    ));
  }
  for (const line of opts.diagnostics ?? []) writer.line(line);

  const finish = (
    status: GateRunResult["status"],
    code: number,
    token: string,
    runFailure = "",
  ): GateRunResult => {
    // W-710: the run's own record of the tree it measured. Written on every
    // terminal path, BEFORE the terminal markers so a failure to write it is
    // disclosed in the log rather than swallowed, and replacing any earlier
    // record for this log — so "the run this log ends with" has exactly one
    // answer even when two runs were appended to the same file.
    //
    // A failure here is DISCLOSED, not fatal. Unlike the log (without which the
    // run left no evidence at all), the record is evidence ABOUT a run that did
    // happen, and its absence already costs everything it would have bought:
    // `review_prepare` cannot reuse a run it cannot place on a commit, and the
    // seal's `gate_start_head` / `gate_end_head` stay empty, so no P-9 claim can
    // be made from it. Turning an otherwise GREEN gate RED here would invent a
    // new failure class for a fact nothing downstream is allowed to assume.
    try {
      if (opts.runRecordPath) {
        writeGateRunRecord({
          path: opts.runRecordPath,
          logPath: opts.logPath, runId, startedAt, endedAt: now(),
          cwd: opts.cwd, startHead, endHead: headProbe(opts.cwd),
          status, exit: code,
        });
      }
    } catch (error) {
      writer.line(GATE_MARKERS.runFailed(`gate run record: ${oneLineError(error)}`));
    }
    writer.line(`GATE_SUMMARY_METRICS ${JSON.stringify(summaryMetrics())}`);
    writer.line(`GATE_STEP_CENSUS executed=${executedSteps} skipped_green=${skippedGreenSteps}`);
    writer.line(GATE_MARKERS.result(status === "GREEN"));
    // Freeze the summary range at the RESULT marker, BEFORE the failure block.
    // That block echoes the failing step's own tail and error lines verbatim, so
    // every declared summary pattern the step already printed ("26 pass",
    // "Ran 27 tests ...") matches a SECOND time inside this same run slice, and
    // the Dock tail then shows one run's counts repeated as if the gate had run
    // twice. GREEN never carried a failure block, which is why only RED leaked.
    const summaryEndOffset = writer.offset;
    const failureSummary = status === "GREEN" ? [] : failureSummaryLines(failures, runFailure);
    for (const line of failureSummary) writer.line(line);
    writer.line(GATE_MARKERS.end(runId));
    const slice = writer.close();
    let durableStatus = status;
    let durableCode = code;
    try {
      appendGuardedFileSync(opts.logPath, slice.data, "gate log");
    } catch {
      durableStatus = "RED";
      durableCode = 1;
    }
    let summaryLines: string[] = [];
    try {
      summaryLines = extractSummaryLinesFromRange(
        slice.data,
        opts.summaryPatterns ?? [],
        0,
        summaryEndOffset,
      );
    } catch { /* empty summary is fail-safe evidence */ }
    return {
      status: durableStatus,
      runId,
      startedAt,
      token,
      summaryLines,
      failureSummaryLines: failureSummary,
      code: durableCode,
      plan,
      sliceEndOffset: slice.endOffset,
      executedSteps,
      skippedGreenSteps,
      metrics: summaryMetrics(),
    };
  };

  for (const step of opts.steps) {
    let v: StepCheck;
    try {
      v = deps.checkStep(step.cmd);
    } catch (error) {
      writer.line(GATE_MARKERS.runFailed(`validation: ${oneLineError(error)}`));
      return finish("RED", 1, "");
    }
    if (!v.ok) {
      writer.line(GATE_MARKERS.stepRejected(step.name, v.reason));
      return finish("RED", 1, "");
    }
    if (bunTestCommand(step.cmd)) {
      try {
        const invocation = parseBunTestArgv(step.cmd);
        if (!invocation) throw new Error("Bun test command could not be interpreted");
        bunTestTargetEvidence(invocation, opts.cwd);
      } catch (error) {
        writer.line(GATE_MARKERS.stepRejected(step.name, `Bun test argv: ${oneLineError(error)}`));
        return finish("RED", 1, "");
      }
    }
  }

  let green = true;
  let runError = "";
  let releaseError = "";
  let token = "";
  const batchKind = opts.batchKind ?? "gate";
  const ledgerPath = opts.ledgerPath ? resolve(opts.ledgerPath) : undefined;
  if (opts.resumeRequested) {
    writer.line("STEP_REUSE_DISABLED reason=no_immutable_execution_boundary requested_resume=true");
  }
  let batchStarted = false;
  try {
    await deps.beginBatch?.(batchKind, runId);
    batchStarted = true;
    for (const [stepIndex, step] of opts.steps.entries()) {
      const intermittentPattern = step.intermittent ? new RegExp(step.intermittent.pattern) : null;
      const intermittentTrackingOpen = step.intermittent
        ? deps.trackingRowOpen?.(step.intermittent.trackingRow) === true
        : false;
      await deps.beforeStep?.(batchKind, step);
      try {
        deps.sweepStale?.();
        token = deps.acquire(deps.ownerPid ?? String(process.pid)).trim();
      } catch (error) {
        writer.line(GATE_MARKERS.acquireFailed(oneLineError(error)));
        runError = `acquire: ${oneLineError(error)}`;
        green = false;
        break;
      }
      if (token === "OPEN" || token === "") {
        writer.line(GATE_MARKERS.abortFailopen(token === "OPEN" ? "reason=lock-infra (heavy_compile_lock returned OPEN)" : "reason=empty-token"));
        return finish("ABORT_FAILOPEN", 3, token);
      }
      const locked = token !== "DISABLED";
      writer.line(locked ? GATE_MARKERS.lockAcquired(token) : GATE_MARKERS.lockDisabled());
      let identity: StepIdentity | undefined;
      if (ledgerPath) {
        try {
          identity = await (deps.identifyStep?.(step, opts.cwd) ?? createStepIdentity(step.cmd, opts.cwd));
        } catch (error) {
          if (locked) {
            try {
              deps.release(token);
              writer.line(GATE_MARKERS.lockReleased());
            } catch (releaseFailure) {
              releaseError = oneLineError(releaseFailure);
              writer.line(GATE_MARKERS.lockReleaseFailed(releaseError));
            }
          }
          // Recorded, not written here: the one `RUN_FAILED` line for this run is
          // emitted after the loop from `runError`, which also carries the reason
          // into the caller's message. Writing it inline as well put the same
          // line in the log twice.
          runError = `step identity ${step.name}: ${oneLineError(error)}`;
          green = false;
          break;
        }
      }
      executedSteps += 1;
      const stepStartedAt = now();
      const wallStartedAt = performance.now();
      writer.line(GATE_MARKERS.stepStart(step.name, stepStartedAt));

      const executeAttempt = async () => {
        const selection = { pending: "", sawCount: false, selectedAny: false };
        const collector = new StepFailureCollector();
        let output = "";
        const rawResult = await deps.runStep(
          step.cmd,
          opts.cwd,
          (text) => {
            if (locked && deps.progress && text.length > 0) deps.progress(token);
            observeTestSelection(selection, text);
            collector.write(text);
            output += text;
            writer.write(text);
          },
          opts.timeoutMs,
          (pid) => writer.line(GATE_MARKERS.stepPid(step.name, pid)),
          () => { if (locked && deps.progress) deps.progress(token); },
        );
        observeTestSelection(selection, "", true);
        collector.write("", true);
        const result = typeof rawResult === "number" ? { exitCode: rawResult } : rawResult;
        observeSummaryMetrics(output, result.testEvidence);
        return { code: result.exitCode, testEvidence: result.testEvidence, selection, collector, output };
      };

      let attempt: Awaited<ReturnType<typeof executeAttempt>>;
      try {
        attempt = await executeAttempt();
      } catch (error) {
        if (locked) {
          try {
            deps.release(token);
            writer.line(GATE_MARKERS.lockReleased());
          } catch (releaseFailure) {
            releaseError = oneLineError(releaseFailure);
            writer.line(GATE_MARKERS.lockReleaseFailed(releaseError));
          }
        }
        throw error;
      }
      let disclosedIntermittent = false;
      if (attempt.code !== 0 && step.intermittent && intermittentPattern!.test(attempt.output)) {
        if (intermittentTrackingOpen) {
          writer.line(`STEP-RETRY ${step.name} first_exit=${attempt.code} pattern=${JSON.stringify(step.intermittent.pattern)} tracking_row=${step.intermittent.trackingRow}`);
          try {
            attempt = await executeAttempt();
          } catch (error) {
            if (locked) {
              try {
                deps.release(token);
                writer.line(GATE_MARKERS.lockReleased());
              } catch (releaseFailure) {
                releaseError = oneLineError(releaseFailure);
                writer.line(GATE_MARKERS.lockReleaseFailed(releaseError));
              }
            }
            throw error;
          }
          if (attempt.code === 0) {
            disclosedIntermittent = true;
            writer.line(
              `UNCOVERED dimension=${JSON.stringify(step.intermittent.dimension)} `
              + `cause=${JSON.stringify(step.intermittent.cause)} tracking_row=${step.intermittent.trackingRow} `
              + `alternate_confidence_basis=${JSON.stringify(step.intermittent.alternateConfidenceBasis)}`,
            );
          }
        } else {
          writer.line(`INTERMITTENT_ALLOWLIST_EXPIRED ${step.name} tracking_row=${step.intermittent.trackingRow}`);
        }
      }
      if (attempt.code === 124) writer.line(GATE_MARKERS.stepTimeout(step.name, opts.timeoutMs));
      writer.line(GATE_MARKERS.stepExit(step.name, attempt.code));
      let stepGreen = attempt.code === 0;
      if (hasTestSelectionFilter(step.cmd) && attempt.selection.sawCount && !attempt.selection.selectedAny) {
        writer.line(GATE_MARKERS.stepUncovered(step.name));
        stepGreen = false;
      }
      if (stepGreen && identity && ledgerPath && bunTestCommand(step.cmd)
        && !runnerEvidenceMatches(step.cmd, opts.cwd, attempt.testEvidence)) {
        writer.line(`STEP_AUTHENTICATION_FAILED ${step.name}: parent-owned direct-execution/target evidence missing or mismatched`);
        stepGreen = false;
      }

      let stepReleaseError = "";
      if (locked) {
        try {
          deps.release(token);
          writer.line(GATE_MARKERS.lockReleased());
        } catch (error) {
          stepReleaseError = oneLineError(error);
          releaseError = stepReleaseError;
          writer.line(GATE_MARKERS.lockReleaseFailed(stepReleaseError));
          stepGreen = false;
        }
      }
      const stepEndedAt = now();
      if (identity && ledgerPath) {
        const stepLogPath = completedStepLogPath(ledgerPath, runId, stepIndex + 1);
        let logSha256 = "";
        let completedBytes = Buffer.alloc(0);
        try {
          mkdirSync(dirname(stepLogPath), { recursive: true });
          const completedLog = [
            `STEP ${step.name}`,
            `command: ${step.cmd}`,
            `started_at: ${stepStartedAt}`,
            `ended_at: ${stepEndedAt}`,
            `exit: ${stepGreen ? 0 : (attempt.code || 1)}`,
            `RESULT ${stepGreen ? "GREEN" : "RED"}`,
            ...(attempt.testEvidence ? [`RUNNER_TEST_EVIDENCE ${JSON.stringify(attempt.testEvidence)}`] : []),
            "--- output ---",
            attempt.output,
          ].join("\n");
          writeGuardedFileSync(stepLogPath, completedLog, "gate completed-step log");
          completedBytes = Buffer.from(completedLog);
          const writtenBytes = readFileSync(assertSafeLeaf(stepLogPath, "gate completed-step evidence"));
          if (!writtenBytes.equals(completedBytes)) {
            throw new Error("completed-step log changed outside the parent writer boundary");
          }
          logSha256 = createHash("sha256").update(completedBytes).digest("hex");
        } catch (error) {
          writer.line(GATE_MARKERS.runFailed(`completed-step log: ${oneLineError(error)}`));
          stepGreen = false;
        }
        if (logSha256) {
          const entryMaterial: StepLedgerEntryMaterial = {
            schema_version: 4,
            ...identity,
            step_name: step.name,
            command: step.cmd,
            cwd: resolve(opts.cwd),
            exit: stepGreen ? 0 : (attempt.code || 1),
            status: stepGreen ? "GREEN" : "RED",
            run_id: runId,
            step_index: stepIndex + 1,
            log_sha256: logSha256,
            started_at: stepStartedAt,
            ended_at: stepEndedAt,
            metrics: collectStepMetrics(attempt.testEvidence, (performance.now() - wallStartedAt) / 1000),
            ...(attempt.testEvidence ? { test_evidence: attempt.testEvidence } : {}),
          };
          const entry = finalizeStepLedgerEntry(entryMaterial);
          try {
            (deps.appendLedger ?? appendStepLedger)(ledgerPath, entry);
            assertAppendedStepEvidence(ledgerPath, entry, completedBytes);
          }
          catch (error) {
            writer.line(GATE_MARKERS.runFailed(`step ledger: ${oneLineError(error)}`));
            stepGreen = false;
          }
        }
      }
      if (!stepGreen) {
        green = false;
        failures.push({
          name: step.name,
          command: step.cmd,
          exit: attempt.code || 1,
          tail: [...attempt.collector.tail],
          errors: [...attempt.collector.errors],
        });
      }
      if (disclosedIntermittent) writer.line(`STEP ${step.name} retry_outcome=GREEN disclosure=UNCOVERED`);
      if (stepReleaseError) break;
    }
  } catch (error) {
    green = false;
    runError = oneLineError(error);
  } finally {
    if (batchStarted) {
      try { await deps.endBatch?.(batchKind, runId); }
      catch (error) {
        runError = `batch cleanup: ${oneLineError(error)}`;
        green = false;
      }
    }
  }
  if (runError) writer.line(GATE_MARKERS.runFailed(runError));
  if (releaseError) return finish("RED", 1, token, releaseError);
  return finish(green ? "GREEN" : "RED", green ? 0 : 1, token, runError);
}

// --- CLI -------------------------------------------------------------------

// heavy_compile_lock.ts lives in the CORE scripts dir (garelier-core/scripts/), NOT
// this driver/src/scripts/ dir. W-157 dogfood bug (#376 gate): the old
// `resolve(dirname, "heavy_compile_lock.ts")` pointed at a nonexistent sibling, so
// the acquire spawn failed instantly → empty stdout → empty token → ABORT_FAILOPEN
// (fail-closed as designed, but the gate could never run). Resolve it the SAME way
// merge-gate.ts's CORE_SCRIPTS_DIR does: up out of driver/src/scripts/ to
// garelier-core/, then into scripts/.
export const HEAVY_LOCK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "heavy_compile_lock.ts");

// Keep queued gates observable without shortening the configured hard lease or
// imposing a gate-runner-only acquire deadline (W-421 follow-up).
export const HEAVY_LOCK_HEARTBEAT_SECS = 60;

// W-157 BLOCK (4): a step runs with a MINIMAL env allowlist, never the PM's full
// process.env — so a step (even a validated one) can never read tokens/keys from
// the inherited environment (`env … | curl …` exfiltration). See spawn_env.ts
// (MINIMAL_ENV_KEYS / SECRET_ENV_RE / hasEmbeddedCredential / minimalEnv, W-249)
// for the allowlist, the name/value secret drops, and their history (W-236/W-237/W-241).

/** Parse the complete closed command form accepted by order checks and direct
 * execution. Every token is literal; quoting, escaping, assignments, and shell
 * operators are outside the grammar and therefore fail closed. */
function literalCommandArgv(command: string): string[] | null {
  try { return stepCommandArgv(command); }
  catch { return null; }
}

/** Resolve a shell-free external invocation for direct execution. Builtins stay
 * on Git Bash; a plain external command runs as the recorded child itself. */
function directGateCommand(
  command: string,
  env: Record<string, string | undefined>,
): string[] | null {
  const argv = literalCommandArgv(command);
  if (!argv) return null;
  if (new Set([".", ":", "break", "cd", "continue", "eval", "exec", "exit", "export", "false", "if", "printf", "pwd", "read", "readonly", "return", "set", "shift", "source", "test", "true", "trap", "unset"]).has(argv[0]!)) return null;
  if (argv[0]?.toLowerCase().replace(/\.exe$/, "") === "bun") {
    return [process.execPath, ...argv.slice(1)];
  }
  return resolveCommand(argv, { env });
}

function defaultDeps(
  project: string,
  pmId: string,
  label: string,
  cwd: string,
  allowedCommandPrefixes: readonly string[] | undefined,
  trustedCommands: ReadonlySet<string>,
  laneEnv: LaneEnv,
  captureRoot: string,
): GateRunnerDeps {
  const bun = process.execPath;
  const resolvedBash = resolveBashExecutable();
  const bash = resolvedBash ?? "bash";
  const gitKill = resolvedBash && isAbsolute(resolvedBash)
    ? resolve(dirname(resolvedBash), "..", "usr", "bin", "kill.exe")
    : undefined;
  const killOwnedTree = (pid: number): boolean => {
    if (process.platform === "win32") {
      // Exact PID + /T is intentionally the only Windows kill form here. It
      // cannot affect a different gate or another lane's compiler by image/name.
      const killed = Bun.spawnSync([requireRuntimeExecutable("taskkill"), "/PID", String(pid), "/T", "/F"], {
        windowsHide: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      if (killed.exitCode === 0) return true;
      // Role sandboxes can deny taskkill while Git-for-Windows still owns
      // the exact native child. `-W` makes the numeric identity unambiguously a
      // Windows PID; this is never an image/name or lane-wide kill.
      if (gitKill && existsSync(gitKill)) {
        return Bun.spawnSync([gitKill, "-fW", String(pid)], {
          windowsHide: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
        }).exitCode === 0;
      }
      return false;
    }
    try { process.kill(pid, "SIGKILL"); return true; } catch { return false; }
  };
  const heavyLockDir = join(resolveMainRoot(project), "__garelier", pmId, "runtime", "locks", "heavy_compile");
  const heavyWaitPath = join(resolveMainRoot(project), "__garelier", pmId, "runtime", "locks", "heavy.wait");
  const waitMarker = (runId: string) => join(heavyWaitPath, `${runId.replace(/[^A-Za-z0-9_.-]+/g, "_")}.json`);
  let toolchainVersions: ReturnType<typeof readToolchainVersions> | undefined;
  const identityInherited = minimalEnv();
  const identityEnvironment = injectLaneEnv(identityInherited, laneEnv, {
    CARGO_INCREMENTAL: identityInherited.CARGO_INCREMENTAL,
  });
  const setupConfigPath = join(resolveMainRoot(project), "__garelier", pmId, "_crew", "pm", "setup_config.toml");
  const captureSizes = new Map<string, number>();
  const captureOutputProgressed = (): boolean => {
    let progressed = false;
    const seen = new Set<string>();
    if (existsSync(captureRoot)) {
      for (const entry of readdirSync(captureRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(".gate-step-")) continue;
        for (const stream of ["stdout", "stderr"]) {
          const path = resolve(captureRoot, entry.name, stream);
          let size = 0;
          try { size = statSync(path).size; } catch { continue; }
          seen.add(path);
          const previous = captureSizes.get(path);
          if (size > (previous ?? 0)) progressed = true;
          captureSizes.set(path, size);
        }
      }
    }
    for (const path of captureSizes.keys()) if (!seen.has(path)) captureSizes.delete(path);
    return progressed;
  };
  return {
    beginBatch: (kind, runId) => {
      if (kind !== "gate") return;
      mkdirSync(heavyWaitPath, { recursive: true });
      writeGuardedFileSync(
        waitMarker(runId),
        `${JSON.stringify({ schema_version: 1, pid: process.pid, run_id: runId, created_at: new Date().toISOString() })}\n`,
        "gate priority marker",
      );
    },
    beforeStep: async (kind) => {
      if (kind !== "smith") return;
      const deadline = Date.now() + 10 * 60_000;
      while (existsSync(heavyWaitPath)) {
        let liveWaiters = 0;
        for (const entry of readdirSync(heavyWaitPath, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const marker = join(heavyWaitPath, entry.name);
          let ownerPid = 0;
          try { ownerPid = Number(JSON.parse(readFileSync(marker, "utf8")).pid ?? 0); }
          catch { /* malformed marker is stale */ }
          if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !pidAlive(ownerPid)) {
            rmSync(marker, { force: true });
          } else {
            liveWaiters += 1;
          }
        }
        if (liveWaiters === 0) {
          try { rmdirSync(heavyWaitPath); } catch { /* a gate added a marker; rescan */ }
          if (!existsSync(heavyWaitPath)) break;
        }
        if (Date.now() >= deadline) throw new Error(`gate priority wait exceeded 600000ms: ${heavyWaitPath}`);
        await Bun.sleep(250);
      }
    },
    endBatch: (kind, runId) => {
      if (kind !== "gate" || !existsSync(heavyWaitPath)) return;
      rmSync(waitMarker(runId), { force: true });
      try {
        if (readdirSync(heavyWaitPath).length === 0) rmdirSync(heavyWaitPath);
      } catch { /* another gate owns the remaining marker or removed the directory */ }
    },
    sweepStale: () => {
      const r = Bun.spawnSync([bun, HEAVY_LOCK, "--project", project, "--pm-id", pmId, "--mode", "sweep"], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
      if ((r.exitCode ?? 1) !== 0) throw new Error(`heavy_compile_lock sweep exit=${r.exitCode ?? 1}`);
    },
    acquire: (ownerPid) => {
      const r = Bun.spawnSync([bun, HEAVY_LOCK, "--project", project, "--pm-id", pmId, "--mode", "acquire", "--label", label, "--owner-pid", ownerPid, "--timeout-sec", String(HEAVY_LOCK_HEARTBEAT_SECS)], {
        windowsHide: true, stdout: "pipe", stderr: "pipe",
      });
      return (r.stdout?.toString() ?? "").trim().split(/\r?\n/).pop() ?? "";
    },
    release: (token) => {
      const r = Bun.spawnSync(
        [bun, HEAVY_LOCK, "--project", project, "--pm-id", pmId, "--mode", "release", "--token", token],
        { windowsHide: true, stdout: "pipe", stderr: "pipe" },
      );
      if ((r.exitCode ?? 1) !== 0) {
        const detail = (r.stderr?.toString() ?? r.stdout?.toString() ?? "").trim();
        throw new Error(`heavy_compile_lock release exit=${r.exitCode ?? 1}${detail ? `: ${detail}` : ""}`);
      }
    },
    progress: (token) => {
      const progressed = captureOutputProgressed();
      if (!progressed) return;
      const result = recordHeavyCompileProgress(token, heavyLockDir);
      if (result.kind === "open" || result.kind === "recorded") return;
      if (result.kind === "invalid") throw new Error(`heavy_compile_lock progress exit=2: ${result.reason}`);
      if (result.kind === "write-error") throw new Error(`heavy_compile_lock progress exit=2: progress write failed for ${result.slot}: ${result.reason}`);
      throw new Error(`heavy_compile_lock progress exit=1: progress-lost ${result.slot}: not held`);
    },
    checkStep: (cmd) => checkStep(cmd, {
      cwd,
      allowedCommandPrefixes: trustedCommands.has(cmd) ? undefined : allowedCommandPrefixes,
    }),
    identifyStep: (step, stepCwd) => {
      toolchainVersions ??= readToolchainVersions(stepCwd);
      return createStepIdentity(step.cmd, stepCwd, toolchainVersions, {
        configurationPaths: existsSync(setupConfigPath) ? [setupConfigPath] : [],
        environment: identityEnvironment,
      });
    },
    trackingRowOpen: (row) => trackingRowOpen(
      join(resolveMainRoot(project), "__garelier", pmId, "control"),
      row,
    ),
    runStep: async (cmd, stepCwd, writeOutput, timeoutMs, recordPid, recordProgress) => {
      // Run-owned files make output completion independent of inherited pipe EOF:
      // a late native grandchild can no longer keep this runner awaiting a pipe
      // after the recorded child exits (W-421 S2). A shell-free invocation runs
      // directly, so the recorded PID is the actual command and the fallback kill
      // remains exact even when Windows taskkill is denied by a sandbox.
      // dispatch.env is deliberately applied after minimalEnv() scrubs inherited
      // secrets, so an explicit project value is not confused with host state.
      const inherited = minimalEnv();
      const childEnv = injectLaneEnv(inherited, laneEnv, {
        CARGO_INCREMENTAL: inherited.CARGO_INCREMENTAL,
      });
      const direct = directGateCommand(cmd, childEnv);
      const command = direct ?? [bash, "-c", cmd];
      const captured = await runFileBackedProcess(
        {
          command,
          captureRoot,
          capturePrefix: ".gate-step-",
          cwd: stepCwd,
          env: childEnv,
          stdin: "ignore",
          onSpawn: (proc) => recordPid(proc.pid),
          onCapturePoll: recordProgress,
          onOutput: (stdout, stderr) => writeOutput(stdout + stderr),
        },
        async (proc) => {
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            if (!killOwnedTree(proc.pid)) {
              // The Bun handle is still this runner's exact child; use it only as
              // a fallback when the OS tree-kill command was unavailable/denied.
              try { proc.kill("SIGKILL"); } catch { /* child already exited */ }
            }
          }, timeoutMs);
          try {
            const code = await proc.exited;
            return timedOut ? 124 : code;
          } finally {
            clearTimeout(timer);
          }
        },
      );
      if (!(direct && bunTestCommand(cmd))) return captured.result;
      try {
        return runnerAuthenticatedTestResult(cmd, stepCwd, captured.result);
      } catch (error) {
        writeOutput(`RUNNER_EVIDENCE_ERROR class=${error instanceof Error ? error.name : "NonError"}\n`);
        return { exitCode: captured.result || 1 };
      }
    },
    ownerPid: String(process.pid), // Bun's pid is the NATIVE Windows PID (W-169: no git-bash $$ blind spot)
  };
}

const GIT_PATH_LIST_TIMEOUT_MS = 30_000;

export function defaultGateLogPath(project: string, pmId: string): string {
  return join(resolve(project), "__garelier", pmId, "runtime", "gate_runner", "gate_runner.log");
}

export function defaultStepLedgerPath(project: string, pmId: string): string {
  return join(resolve(project), "__garelier", pmId, "runtime", "gate", "step_ledger.jsonl");
}

/** The production runner owns one observational ledger destination. Candidate
 * resume arguments never select evidence input or a write destination. */
export function observationalStepLedgerPath(project: string, pmId: string): string {
  return assertSafeLeaf(defaultStepLedgerPath(project, pmId), "gate step ledger path");
}

function gateContextFromRegister(cwd: string, fromRegister?: string): LaneEnvContext {
  const checkout = resolve(cwd);
  let container = dirname(checkout);
  let dispatchId = "", role = "", slug = "";
  if (fromRegister) {
    const register = resolve(fromRegister);
    const candidates = [
      join(dirname(register), "context.json"),
      join(dirname(register), "..", "context.json"),
    ];
    for (const contextPath of candidates) {
      if (!existsSync(contextPath)) continue;
      try {
        const context = JSON.parse(readFileSync(contextPath, "utf8")) as {
          task?: { id?: unknown; role?: unknown; slug?: unknown };
        };
        container = dirname(contextPath);
        if (typeof context.task?.id === "string" || typeof context.task?.id === "number") dispatchId = String(context.task.id);
        if (typeof context.task?.role === "string") role = context.task.role;
        if (typeof context.task?.slug === "string") slug = context.task.slug;
      } catch { /* an absent/unreadable context remains unavailable and observable */ }
      break;
    }
  }
  return { checkout, project: "", container, dispatchId, role, slug };
}

function gitPathList(cwd: string, args: string[]): { paths: string[]; error?: string } {
  const result = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", cwd, ...args], {
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
    env: minimalEnv(),
    timeout: GIT_PATH_LIST_TIMEOUT_MS,
  });
  if (result.exitedDueToTimeout) {
    return { paths: [], error: `git ${args.join(" ")} timed out after ${GIT_PATH_LIST_TIMEOUT_MS}ms` };
  }
  if (result.signalCode) {
    return { paths: [], error: `git ${args.join(" ")} terminated by signal ${result.signalCode}` };
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.stderr?.toString() ?? "").trim();
    return { paths: [], error: `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}` };
  }
  return {
    paths: (result.stdout?.toString() ?? "").split(/\r?\n/).map(repoPath).filter(Boolean),
  };
}

function collectRegisterPaths(cwd: string, diffBase: string): {
  changedPaths: string[];
  trackedPaths: string[];
  errors: string[];
} {
  const committed = gitPathList(cwd, ["diff", "--name-only", "--relative", `${diffBase}...HEAD`]);
  const working = gitPathList(cwd, ["diff", "--name-only", "--relative", "HEAD"]);
  const tracked = gitPathList(cwd, ["ls-files", "-co", "--exclude-standard"]);
  return {
    changedPaths: [...new Set([...committed.paths, ...working.paths])].sort(),
    trackedPaths: [...new Set(tracked.paths)].sort(),
    errors: [committed.error, working.error, tracked.error].filter((error): error is string => !!error),
  };
}

/** W-620 (blueprint §2.2) — gate_runner had no usage output at all.
 *
 * `--steps` takes a FILE, and nothing said so until the file was missing; a PM
 * passed an inline command string twice before reading the parser. `-h`/`--help`
 * was not handled either, so asking for help produced the first missing-argument
 * complaint instead. Naming the value shapes here is the whole fix — nothing
 * about what is accepted changes. */
export const GATE_RUNNER_USAGE = [
  "usage: gate_runner.ts --project <control-root> --pm-id <id> --cwd <checkout>",
  "                      (--steps <file.toml|file.json> | --from-register <path>)",
  "                      [--label <name>] [--log <path>] [--batch-kind gate|smith]",
  "                      [--resume-from-ledger]",
  "",
  "--steps takes a PATH to a steps file (.toml or .json), never an inline command.",
  "--from-register takes a PATH to the register the steps are read out of.",
  "--cwd is the checkout the gate runs in; --project is the control root.",
].join("\n");

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; message: string }> {
  if (argv.includes("-h") || argv.includes("--help")) return { code: 0, message: GATE_RUNNER_USAGE };
  // A flag-shaped value means the intended value was omitted. Taking it silently
  // makes `--project --pm-id x` run against a control root literally named
  // "--pm-id", which then fails somewhere far from the typo.
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    return value === undefined || value.startsWith("--") ? undefined : value;
  };
  const project = flag("project"); const pmId = flag("pm-id"); const label = flag("label") ?? "gate";
  const cwd = flag("cwd"); const stepsFile = flag("steps"); const fromRegister = flag("from-register");
  const explicitLogPath = flag("log");
  const explicitResume = argv.includes("--resume-from-ledger");
  const batchKindRaw = flag("batch-kind") ?? "gate";
  if (argv.includes("--resume-evidence-seal") || argv.includes("--full")) {
    return { code: 2, message: "gate_runner: reusable step evidence is unsupported without an immutable execution boundary" };
  }
  // Report every missing requirement at once. Disclosing them one per run costs
  // the caller a round trip per argument (control-transition L-4, same shape).
  const missing = [
    ["--project <control-root>", project],
    ["--pm-id <id>", pmId],
    ["--cwd <checkout>", cwd],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (!stepsFile && !fromRegister) missing.push("--steps <file> or --from-register <path>");
  if (missing.length) {
    return { code: 2, message: `gate_runner: missing required argument(s): ${missing.join(", ")}\n${GATE_RUNNER_USAGE}` };
  }
  // The list above is the check; these restate it for the type system only.
  if (!project || !pmId || !cwd) return { code: 2, message: `gate_runner: missing required argument(s)\n${GATE_RUNNER_USAGE}` };
  const projectRoot = resolve(project);
  if (batchKindRaw !== "gate" && batchKindRaw !== "smith") {
    return { code: 2, message: `gate_runner: --batch-kind must be gate or smith (got ${batchKindRaw})` };
  }
  const batchKind = batchKindRaw as "gate" | "smith";
  const logPath = explicitLogPath ?? defaultGateLogPath(projectRoot, pmId);
  let ledgerPath: string;
  try {
    ledgerPath = observationalStepLedgerPath(projectRoot, pmId);
  } catch (error) {
    return { code: 2, message: `gate_runner: ${(error as Error).message}` };
  }
  const auditRed = (
    diagnostics: readonly string[],
    plan: readonly string[] = [],
    refusal?: string,
  ): { code: number; message: string } => ({
    code: 1,
    message: recordAuditRed({ logPath: resolve(logPath), diagnostics, plan, refusal }).message,
  });

  let steps: GateStep[];
  let allowedCommandPrefixes: string[] | undefined;
  let trustedCommands = new Set<string>();
  let summaryPatterns: string[] = [];
  let auditDiagnostics: string[] = [];
  let timeoutMs = 0;
  let laneEnv: LaneEnv;
  let laneDiagnostics: string[] = [];
  try {
    const context = gateContextFromRegister(cwd, fromRegister);
    context.project = projectRoot;
    const resolution = resolveLaneEnv(loadLaneEnv(projectRoot, pmId), context, "gate");
    laneEnv = resolution.values;
    laneDiagnostics = skippedLaneEnvDiagnostics(resolution.skipped, "gate");
    if (stepsFile) {
      if (!existsSync(stepsFile)) return { code: 2, message: `gate_runner: --steps file not found: ${stepsFile}` };
      const fmt = /\.json$/i.test(stepsFile) ? "json" : "toml";
      steps = parseSteps(readFileSync(stepsFile, "utf8"), fmt);
    } else {
      if (!existsSync(fromRegister!)) return { code: 2, message: `gate_runner: --from-register file not found: ${fromRegister}` };
      const parsed = parseRegisterSteps(readFileSync(fromRegister!, "utf8"));
      steps = parsed.steps;
      if (parsed.refusal) {
        return auditRed(
          [...laneDiagnostics, `REGISTER_REFUSED ${parsed.refusal}`],
          steps.map((step) => GATE_MARKERS.stepPlanned(step.name, step.cmd)),
          parsed.refusal,
        );
      }
      if (steps.length === 0) return auditRed([...laneDiagnostics, "REGISTER_REFUSED required_gate_commands_empty"], [], "required_gate_commands_empty");
      const config = loadConfig(projectRoot, pmId);
      const timeoutMinutes = config.qualityGate.timeoutMinutesPerCmd;
      if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
        return auditRed([...laneDiagnostics, `CONFIG_INVALID quality_gate.timeout_minutes_per_cmd must be a positive number (got ${timeoutMinutes})`]);
      }
      timeoutMs = Math.ceil(timeoutMinutes * 60_000);
      const candidatePolicy = resolveCandidateRegisterGatePolicy(projectRoot, pmId, resolve(cwd));
      const policy = candidatePolicy.policy;
      if (!policy.declared) {
        return auditRed([...laneDiagnostics, ...candidatePolicy.diagnostics, "CONFIG_MISSING [quality_gate.register]"]);
      }
      if (policy.validationError) {
        return auditRed([...laneDiagnostics, ...candidatePolicy.diagnostics, `CONFIG_INVALID ${policy.validationError}`]);
      }
      const paths = collectRegisterPaths(resolve(cwd), config.branches.integration);
      if (paths.errors.length > 0) {
        return auditRed([...laneDiagnostics, ...paths.errors.map((error) => `REGISTER_AUDIT_ERROR ${error}`)]);
      }
      const audit = auditRegisterGate({
        roleSteps: steps,
        policy,
        changedPaths: paths.changedPaths,
        trackedPaths: paths.trackedPaths,
      });
      auditDiagnostics = [...candidatePolicy.diagnostics, ...audit.diagnostics];
      if (!audit.ok) {
        const plan = audit.steps.map((step) => GATE_MARKERS.stepPlanned(step.name, step.cmd));
        return auditRed([...laneDiagnostics, ...auditDiagnostics], plan);
      }
      steps = audit.steps;
      allowedCommandPrefixes = policy.steps.flatMap((step) => step.commandPrefixes);
      trustedCommands = new Set(policy.closure.map((step) => step.cmd));
      summaryPatterns = policy.summaryPatterns;
    }
  } catch (e) { return { code: 2, message: String(e) }; }

  // --steps is Dock-authored but still must be bounded by the project policy.
  if (timeoutMs === 0) {
    const config = loadConfig(resolve(project), pmId);
    const timeoutMinutes = config.qualityGate.timeoutMinutesPerCmd;
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
      return auditRed([`CONFIG_INVALID quality_gate.timeout_minutes_per_cmd must be a positive number (got ${timeoutMinutes})`]);
    }
    timeoutMs = Math.ceil(timeoutMinutes * 60_000);
  }

  const rcwd = resolve(cwd);
  // --from-register role steps are project-prefix checked + guarded;
  // project closure and Dock-authored --steps remain prefix-exempt but guarded.
  let dockAttribution: DockGateAttribution;
  try {
    dockAttribution = resolveDockGateAttribution({ projectRoot, pmId, cwd: rcwd, env });
  } catch (error) {
    return auditRed([`DOCK_ATTRIBUTION_ERROR ${(error as Error).message}`]);
  }
  const result = await runGate(
    {
      steps, cwd: rcwd, logPath: resolve(logPath), summaryPatterns,
      diagnostics: [...laneDiagnostics, ...auditDiagnostics], timeoutMs,
      dockAttribution,
      ledgerPath,
      runRecordPath: gateRunRecordPath(projectRoot, pmId, resolve(logPath)),
      resumeRequested: explicitResume,
      batchKind,
    },
    defaultDeps(
      project, pmId, label, rcwd, allowedCommandPrefixes, trustedCommands,
      laneEnv, dirname(resolve(logPath)),
    ),
  );
  const tail = result.summaryLines.slice(-12).join("\n");
  return {
    code: result.code,
    // Pre-exec echo (the exact steps that ran / were rejected) so the Dock seat can eyeball
    // the worker-authored gate before trusting the result.
    message: `${result.plan.join("\n")}\n${auditDiagnostics.join("\n")}\n${laneDiagnostics.join("\n")}\nSEAT ${dockAttribution.seat}\nATTRIBUTION_AGENT ${dockAttribution.agentName}\nEXTERNAL_DOCK_RECORD ${dockAttribution.recordPath}\nRUN_ID ${result.runId}\nSTARTED_AT ${result.startedAt}\nRESULT ${result.status}\n${result.failureSummaryLines.join("\n")}\nlog=${resolve(logPath)}\n${tail}`,
  };
}

if (import.meta.main) {
  const { code, message } = await runCli(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(message + "\n");
  process.exit(code);
}
