// Deterministic Guardian SCAN draft-role (DEC-079).
//
// guardian_policy_check.ts decides WHEN a Guardian gate is required. This module
// runs the deterministic SCAN itself: it applies the Librarian-owned `security/`
// registries (secret / PII / injection patterns + false-positive exceptions) to
// the changed content and emits a REDACTED draft + a PROVISIONAL verdict. The
// Guardian AGENT keeps final authority — it reviews the draft, adjudicates every
// `needs_review` item, decides policy/escalation, and may DISCARD the draft and
// run the manual procedure (scanner-and-gates.md) unchanged.
//
// Why: today the agent reads the registries + the whole diff into context and
// pattern-matches by reasoning — a large token cost whose deterministic parts are
// exactly mechanizable. Moving them to Bun keeps the registries, the raw diff and
// raw scanner output OUT of the model; the model receives only this compact,
// redacted draft. (DEC-079; extends DEC-024 / DEC-029.)
//
// INVARIANTS (load-bearing):
//   - REDACTED / pointer-only: a finding NEVER carries the matched secret/PII
//     value — only `file:line [pattern_id]`. The draft must not become the leak.
//   - Fail-closed on secrets: an un-excepted secret match contributes BLOCK.
//   - Never the authority: the verdict here is PROVISIONAL; the agent confirms or
//     overrides. This module does not edit registries and cannot self-approve.
//   - Coverage floor: dependency/license resolution genuinely needs external
//     scanners, so this module only FLAGS those dimensions (external_required) —
//     it never reports them clean on its own.
//
// CLI: the single authority for the accepted argument set is USAGE below; the
//   parser derives nothing that USAGE does not name, and USAGE names nothing the
//   parser does not accept (W-461 AC-2 / G-2, asserted as a set equality in
//   guardian_scan.test.ts).
//   Writes the draft JSON to --out (default: stdout). Exit 0 on a produced draft,
//   2 on usage error, 3 on config/diff/internal/denominator failure.
//
// W-461 — the ZERO IS AMBIGUOUS defect. A failed run used to emit the SAME
//   `stats` block as a successful one (`lines_scanned: 0`, `findings: 0`), so the
//   tail of the output read as "a clean scan that found nothing". Two PMs, two
//   and a half weeks apart, each read a failed scan as clean twice. A draft whose
//   `scan_state` is not `complete` therefore carries `stats: null` plus an
//   `unresolved` block naming the real cause and the command to recover with; it
//   never renders in the shape of a result. An empty delta is likewise refused
//   rather than passed — its denominator is unresolved, not clean — but
//   `--allow-empty-delta` keeps a deliberately empty delta reachable, so the
//   refusal is a notice and not a narrowing.

import { existsSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { requireRuntimeExecutable, resolveRuntimeExecutable, type RunResult } from "./scripts/_lib.ts";
import { crewSubdir } from "./workspace.ts";
import { GARELIER_DIRNAME } from "./guard/record_paths.ts";
import { configurePathGuardRoots, mkdirSync as guardedMkdirSync, renameSync, unlinkSync } from "./guard/path_guard.ts";

export type Dimension = "secret" | "pii" | "injection" | "dependency" | "license";
export type Verdict = "PASS" | "PASS_WITH_NOTES" | "BLOCK" | "NO_OPINION";
export type Coverage = "scanned" | "degraded" | "external_required" | "unavailable" | "not_applicable";
export type Action = "block" | "note" | "review";
export type ScanState = "complete" | "failed";
export type ScanFailureKind = "argv" | "config" | "diff" | "internal" | "denominator";
// Pluggable secret-scanner backend (W-065). `gitleaks` is the default and keeps
// the shipped, byte-identical behavior (the in-process registry floor below);
// `betterleaks` is an opt-in external backend. See the "scanner backend
// abstraction" section for how a backend's raw output normalizes to one schema.
export type ScannerBackend = "gitleaks" | "betterleaks";
export const SCANNER_BACKENDS: readonly ScannerBackend[] = ["gitleaks", "betterleaks"];

export interface Pattern {
  id: string;
  regex: string;
  severity: string;
  action?: "block" | "note"; // injection only; secret/pii implied by dimension
}
export interface FPException {
  patternId: string;
  path: string;
}
export interface Registries {
  secret: Pattern[];
  pii: Pattern[];
  injection: Pattern[];
  fpExceptions: FPException[];
}
export interface ScanLine {
  file: string;
  line: number; // 1-based line number in the new file (diff) or the file (tree)
  text: string;
}
export interface ScanInput {
  kind: "delta_gate" | "final_gate";
  baseRef?: string;
  headRef?: string;
  reviewSha?: string;
  lines: ScanLine[]; // added lines (delta) or all text lines (tree) to scan
  changedFiles: string[]; // for dimension flagging
  packageFiles: string[]; // basenames that signal a dependency/license review
  knowledgePathRe?: RegExp; // paths whose content gets the injection light-check
  scannerBackend?: ScannerBackend; // provenance only; default gitleaks (the in-process floor)
}
export interface Finding {
  dimension: Dimension;
  file: string;
  line: number;
  finding_id: string; // the registry pattern id
  severity: string;
  matched_rule: string; // e.g. "secret_patterns:aws-access-key-id"
  redacted_pointer: string; // "file:line [pattern_id]" — NEVER the matched value
  needs_review: boolean;
  action: Action;
}
export interface Stats {
  lines_scanned: number;
  findings: number;
  needs_review: number;
  excepted: number;
  skipped: number;
}
/** W-461 AC-1: the block that replaces `stats` when nothing was scanned. It is
 * emitted LAST so that the tail of the JSON — the part a reader actually sees —
 * says the run failed, instead of showing a row of zeros indistinguishable from
 * a clean result. `recovery` is executable and is never run on the reader's
 * behalf: the tool tells, the human decides (機械化の上限, user 規約 2026-09-01). */
export interface UnresolvedDenominator {
  denominator: "UNRESOLVED";
  failure_kind: ScanFailureKind;
  message: string;
  recovery: string[];
  /** Emitted LAST so it survives in the tail however long `recovery` grows. */
  read_this_as: string;
}
export interface Draft {
  schema_version: 1;
  generated_by: "guardian_scan.ts";
  authority: "draft"; // the agent owns the final verdict (DEC-079)
  scan_state: ScanState;
  failure: { kind: ScanFailureKind; message: string } | null;
  scope: { kind: ScanInput["kind"]; base_ref?: string; head_ref?: string; review_sha?: string; secret_backend: ScannerBackend };
  coverage: Record<Dimension, Coverage>;
  provisional_verdict: Verdict;
  findings: Finding[];
  // Pattern ids that failed to compile (recall gap surfaced, never silent).
  // Any compile failure makes the whole scan failed/NO_OPINION.
  skipped_patterns: string[];
  // `null` exactly when `scan_state !== "complete"` — see `unresolved`.
  stats: Stats | null;
  unresolved?: UnresolvedDenominator;
}

const DEFAULT_KNOWLEDGE_RE =
  /(^|\/)(knowledge|inspections?|observations?|reports?)\//i;

// Translate a registry regex to a JS RegExp. Registries are authored in PCRE/RE2
// syntax (gitleaks etc.); JS RegExp REJECTS a leading inline-flag group like
// `(?i)`, so without this the pattern silently never compiles — a recall hole in
// a SECURITY tool (every injection pattern ships `(?i)`). Strip a leading
// `(?<flags>)` and move the JS-supported subset (i/m/s) onto the RegExp flags.
export function compile(p: Pattern): RegExp | null {
  try {
    let body = p.regex;
    let flags = "g"; // find every occurrence on a line
    const m = /^\(\?([a-z]+)\)/.exec(body);
    if (m) {
      flags += m[1].split("").filter((c) => "ims".includes(c)).join("");
      body = body.slice(m[0].length);
    }
    return new RegExp(body, flags);
  } catch {
    process.stderr.write(`guardian_scan: bad regex in '${p.id}' — skipped\n`);
    return null;
  }
}

function isExcepted(reg: Registries, patternId: string, file: string): boolean {
  return reg.fpExceptions.some((e) => e.patternId === patternId && e.path === file);
}

function applyPatterns(
  patterns: Pattern[],
  dimension: Dimension,
  lines: ScanLine[],
  reg: Registries,
  opts: { needsReview: boolean; defaultAction: Action; onlyPaths?: RegExp },
): { findings: Finding[]; excepted: number; skipped: string[] } {
  const findings: Finding[] = [];
  let excepted = 0;
  const skipped: string[] = [];
  const compiled = patterns.map((p) => {
    const re = compile(p);
    if (!re) skipped.push(p.id); // surfaced so a recall gap is never silent
    return { p, re };
  });
  for (const ln of lines) {
    if (opts.onlyPaths && !opts.onlyPaths.test(ln.file)) continue;
    for (const { p, re } of compiled) {
      if (!re) continue;
      re.lastIndex = 0;
      if (!re.test(ln.text)) continue; // boolean only — never capture the value
      if (isExcepted(reg, p.id, ln.file)) {
        excepted++;
        continue; // PM/owner-approved false positive — not a finding
      }
      const action: Action = dimension === "injection" ? (p.action === "block" ? "block" : "note") : opts.defaultAction;
      findings.push({
        dimension,
        file: ln.file,
        line: ln.line,
        finding_id: p.id,
        severity: p.severity || "unknown",
        matched_rule: `${dimension === "injection" ? "injection_patterns" : dimension === "pii" ? "pii_patterns" : "secret_patterns"}:${p.id}`,
        redacted_pointer: `${ln.file}:${ln.line} [${p.id}]`,
        needs_review: opts.needsReview,
        action,
      });
    }
  }
  return { findings, excepted, skipped };
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// Pure decision. Deterministic: same registries + same input → same draft.
export function scan(reg: Registries, input: ScanInput): Draft {
  const knowledgeRe = input.knowledgePathRe ?? DEFAULT_KNOWLEDGE_RE;

  const sec = applyPatterns(reg.secret, "secret", input.lines, reg, { needsReview: false, defaultAction: "block" });
  // PII is high-false-positive (Luhn/jurisdiction checks) — always agent-reviewed.
  const pii = applyPatterns(reg.pii, "pii", input.lines, reg, { needsReview: true, defaultAction: "review" });
  const inj = applyPatterns(reg.injection, "injection", input.lines, reg, {
    needsReview: false,
    defaultAction: "note",
    onlyPaths: knowledgeRe,
  });

  const findings = [...sec.findings, ...pii.findings, ...inj.findings];
  const excepted = sec.excepted + pii.excepted + inj.excepted;
  const skipped_patterns = [...sec.skipped, ...pii.skipped, ...inj.skipped];

  // Dependency / license: resolution needs external scanners (license metadata,
  // vuln advisories), so this module only FLAGS that a changed file requires that
  // review — it never clears the dimension on its own (coverage floor invariant).
  const pkgNames = new Set(input.packageFiles.map(basename));
  const touchesPackages = input.changedFiles.some((f) => pkgNames.has(basename(f)));

  // A dimension with an un-compilable pattern is "degraded" (reduced recall),
  // never silently "scanned".
  const coverage: Record<Dimension, Coverage> = {
    secret: sec.skipped.length ? "degraded" : "scanned",
    pii: pii.skipped.length ? "degraded" : "scanned",
    injection: inj.skipped.length ? "degraded" : "scanned",
    dependency: touchesPackages ? "external_required" : "not_applicable",
    license: touchesPackages ? "external_required" : "not_applicable",
  };

  // Provisional verdict (conservative; the agent finalizes):
  //   BLOCK    if any block-action finding (un-excepted secret / block injection)
  //   NO_OPINION if any needs_review finding OR any dimension still needs an
  //              external scanner — the agent must complete those
  //   PASS_WITH_NOTES if only non-blocking notes
  //   PASS     only when nothing flagged and every dimension is covered
  const hasBlock = findings.some((f) => f.action === "block");
  const hasReview = findings.some((f) => f.needs_review);
  const externalPending = coverage.dependency === "external_required" || coverage.license === "external_required";
  const hasNote = findings.some((f) => f.action === "note");

  const internalFailure = skipped_patterns.length > 0;
  let provisional_verdict: Verdict;
  if (internalFailure) provisional_verdict = "NO_OPINION";
  else if (hasBlock) provisional_verdict = "BLOCK";
  else if (hasReview || externalPending) provisional_verdict = "NO_OPINION";
  else if (hasNote) provisional_verdict = "PASS_WITH_NOTES";
  else provisional_verdict = "PASS";

  return {
    schema_version: 1,
    generated_by: "guardian_scan.ts",
    authority: "draft",
    scan_state: internalFailure ? "failed" : "complete",
    failure: internalFailure
      ? { kind: "internal", message: `pattern compilation failed: ${skipped_patterns.join(", ")}` }
      : null,
    scope: { kind: input.kind, base_ref: input.baseRef, head_ref: input.headRef, review_sha: input.reviewSha, secret_backend: input.scannerBackend ?? "gitleaks" },
    coverage,
    provisional_verdict,
    findings,
    skipped_patterns,
    // W-461 AC-1 invariant, held at the type level and everywhere a draft is
    // produced: `stats` is non-null EXACTLY when `scan_state === "complete"`.
    // A degraded scan's counts would understate a recall hole it cannot measure,
    // which is the same "0 that means two things" this row exists to remove.
    stats: internalFailure ? null : {
      lines_scanned: input.lines.length,
      findings: findings.length,
      needs_review: findings.filter((f) => f.needs_review).length,
      excepted,
      skipped: skipped_patterns.length,
    },
  };
}

// ---- registry loading -------------------------------------------------------

function patternsFrom(raw: unknown): Pattern[] {
  const arr = raw && typeof raw === "object" ? (raw as { patterns?: unknown }).patterns : undefined;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => p as Record<string, unknown>)
    .filter((p) => typeof p.id === "string" && typeof p.regex === "string")
    .map((p) => ({
      id: String(p.id),
      regex: String(p.regex),
      severity: typeof p.severity === "string" ? p.severity : "unknown",
      ...(p.action === "block" || p.action === "note" ? { action: p.action } : {}),
    }));
}

function exceptionsFrom(raw: unknown): FPException[] {
  const arr = raw && typeof raw === "object" ? (raw as { exceptions?: unknown }).exceptions : undefined;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((e) => e as Record<string, unknown>)
    .filter((e) => typeof e.pattern_id === "string" && typeof e.path === "string")
    .map((e) => ({ patternId: String(e.pattern_id), path: String(e.path) }));
}

async function readToml(path: string): Promise<Record<string, unknown>> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) throw new Error("file does not exist");
    return parse(await f.text()) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`cannot read ${path} (${(e as Error).message})`);
  }
}

export async function loadRegistries(securityRoot: string): Promise<Registries> {
  const reg = `${securityRoot}/registries`;
  const [secret, pii, injection, fp] = await Promise.all([
    readToml(`${reg}/secret_patterns.toml`),
    readToml(`${reg}/pii_patterns.toml`),
    readToml(`${reg}/injection_patterns.toml`),
    readToml(`${reg}/false_positive_exceptions.toml`),
  ]);
  return {
    secret: patternsFrom(secret),
    pii: patternsFrom(pii),
    injection: patternsFrom(injection),
    fpExceptions: exceptionsFrom(fp),
  };
}

// ---- scanner backend abstraction (W-065) ------------------------------------
//
// The secret dimension can be produced by a pluggable EXTERNAL scanner backend,
// selected by `[guardian_tools].scanner_backend` (default `gitleaks`). The
// deterministic in-process registry scan above (`scan()`) is the shipped default
// and stays byte-identical — this section is ADDITIVE. A backend runs OUT of
// process (the Guardian agent invokes it per scanner-and-gates.md §2); this
// module owns the two backend-neutral primitives so every backend flows through
// ONE schema: a command builder (argv) and a JSON→NormalizedSecretMatch mapper.
//
// betterleaks (github.com/betterleaks/betterleaks, MIT, v1.6.1) is an opt-in
// backend. LOAD-BEARING INVARIANT (W-065 / W-058 egress guard): its async HTTP
// token-liveness validation MUST stay OFF — Guardian is a read-only, non-network
// gate. Per the official docs validation is OFF by default and only turned ON by
// `--validation` (betterleaks docs/config.md: "By default, validation is
// disabled. Enable it with the `--validation` flag."), so the enforcement here
// is the inverse of a disable-flag: `scannerCommand` NEVER emits `--validation`
// (nor `--validation-env-vars`) for the betterleaks backend, and guards that a
// future edit cannot reintroduce them. Verified flags used below — verbs
// `dir`/`git`, `--report-format json`, `--report-path -` (stdout), `--redact` —
// are from the betterleaks README + docs/scanning.md (v1.6.1).

// The common, backend-neutral secret finding (the normalize target). It is
// SECRET-MASKED: `redacted_pointer` carries `file:line [rule]`, NEVER the value.
export interface NormalizedSecretMatch {
  file: string;
  line: number;
  rule: string; // backend rule id
  severity: string;
  redacted_pointer: string; // "file:line [rule]" — never the matched value
}

// Read `[guardian_tools].scanner_backend`. Anything other than an explicit
// `"betterleaks"` (missing key, unknown value, wrong type) resolves to
// `gitleaks` — fail-safe to the shipped, byte-identical behavior.
export function resolveScannerBackend(config: unknown): ScannerBackend {
  const gt = config && typeof config === "object" ? (config as { guardian_tools?: unknown }).guardian_tools : undefined;
  const raw = gt && typeof gt === "object" ? (gt as { scanner_backend?: unknown }).scanner_backend : undefined;
  return raw === "betterleaks" ? "betterleaks" : "gitleaks";
}

export interface ScannerCommandOpts {
  subcommand: "dir" | "git"; // Guardian scans a working dir (delta/tree) or a git range
  target: string; // dir path or repo path
  range?: string; // commit range — git subcommand only
  reportPath?: string; // default "-" → stdout
}

// Flags that would make the betterleaks backend reach the network. They must
// never appear in a Guardian invocation (see the invariant above).
export const FORBIDDEN_NETWORK_FLAGS: readonly string[] = ["--validation", "--validation-env-vars"];

export interface GitleaksProbe {
  status: "READY" | "BLOCK" | "SKIP";
  executable: string | null;
  version: string;
  reason: string;
}

export function probeGitleaks(options: {
  required?: boolean;
  resolve?: () => string | null;
  runner?: (command: string[]) => RunResult;
} = {}): GitleaksProbe {
  const required = options.required ?? true;
  const executable = (options.resolve ?? (() => resolveRuntimeExecutable("gitleaks")))();
  if (!executable) return {
    status: required ? "BLOCK" : "SKIP", executable: null, version: "",
    reason: required ? "mandatory gitleaks executable is unavailable" : "optional gitleaks executable is unavailable",
  };
  const runner = options.runner ?? ((command) => {
    const result = Bun.spawnSync(command, { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: result.stdout?.toString() ?? "", stderr: result.stderr?.toString() ?? "" };
  });
  const result = runner([executable, "version"]);
  if (result.exitCode !== 0) return {
    status: required ? "BLOCK" : "SKIP", executable, version: "",
    reason: `gitleaks version probe failed (exit ${result.exitCode})`,
  };
  return { status: "READY", executable, version: result.stdout.trim(), reason: "" };
}

// Build the argv for a secret scan. Both backends emit a JSON report to stdout
// with redaction; the betterleaks path is asserted offline.
export function scannerCommand(backend: ScannerBackend, o: ScannerCommandOpts): string[] {
  const reportPath = o.reportPath ?? "-";
  const argv: string[] =
    backend === "betterleaks"
      ? // betterleaks: verbs + flags are official-verified (README + docs/scanning.md).
        ["betterleaks", o.subcommand, o.target, "--report-format", "json", "--report-path", reportPath, "--redact"]
      : // gitleaks (default): the modern form already documented in scanner-and-gates.md.
        ["gitleaks", o.subcommand, o.target, "--no-banner", "--redact", "--report-format", "json", "--report-path", reportPath];
  if (o.subcommand === "git" && o.range) argv.push("--log-opts", o.range);
  if (backend === "betterleaks") {
    // Belt-and-braces: the offline invariant must survive future edits.
    for (const bad of FORBIDDEN_NETWORK_FLAGS) {
      if (argv.includes(bad)) {
        throw new Error(`guardian_scan: betterleaks backend must stay offline — '${bad}' is forbidden (W-065 / W-058)`);
      }
    }
  }
  return argv;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function asLine(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// Normalize a backend's JSON report into the common schema. gitleaks and
// betterleaks share a JSON finding shape; field names are read defensively
// (PascalCase / camelCase). REDACTION: the matched value (`Secret` / `Match`)
// is NEVER copied — only a `file:line [rule]` pointer is kept, so a normalized
// finding can never become the leak.
export function normalizeScannerReport(rawJson: string): NormalizedSecretMatch[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: NormalizedSecretMatch[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const file = asString(o.File ?? o.file ?? o.path);
    if (!file) continue;
    const line = asLine(o.StartLine ?? o.startLine ?? o.line);
    const rule = asString(o.RuleID ?? o.ruleID ?? o.ruleId ?? o.rule) || "unknown";
    const severity = asString(o.Severity ?? o.severity) || "unknown";
    out.push({ file, line, rule, severity, redacted_pointer: `${file}:${line} [${rule}]` });
  }
  return out;
}

// The in-process gitleaks-backend `Finding`s share the same normalized schema —
// this projection makes that explicit so both backends are comparable.
export function toNormalizedSecretMatch(f: Finding): NormalizedSecretMatch {
  return { file: f.file, line: f.line, rule: f.finding_id, severity: f.severity, redacted_pointer: f.redacted_pointer };
}

// ---- diff / tree extraction -------------------------------------------------

const BINARY_OR_VENDORED = /(^|\/)(node_modules|\.git)\/|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|exe|dll|so|dylib|wasm|woff2?|ttf|eot|mp4|mov|lock)$/i;

// Parse `git diff --unified=0 base...head` into added lines with new-file line
// numbers. Only `+` lines (additions) are scanned — a Guardian gate cares about
// what the change INTRODUCES.
export function parseAddedLines(diff: string): ScanLine[] {
  const out: ScanLine[] = [];
  let file = "";
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /\+(\d+)/.exec(raw);
      newLine = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (file && !BINARY_OR_VENDORED.test(file)) out.push({ file, line: newLine, text: raw.slice(1) });
      newLine++;
      continue;
    }
    // context/removed lines don't exist with --unified=0, but be safe:
    if (!raw.startsWith("-") && !raw.startsWith("\\")) newLine++;
  }
  return out;
}

function gitLines(projectRoot: string, args: string[]): string {
  const r = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", projectRoot, ...args], { windowsHide: true });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.exitCode})`);
  return new TextDecoder().decode(r.stdout);
}

/** Canonical comparable form: symlinks and Windows 8.3 short names resolved, so
 * two spellings of the SAME directory compare equal. Falls back to a plain
 * resolve when the path cannot be realpath'd. */
function canonicalDir(value: string): string {
  let path: string;
  try { path = realpathSync(resolve(value)); } catch { path = resolve(value); }
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** W-353 (AC b): bind the scan to the repository it claims to review.
 *
 * THE RULE THIS ENFORCES, and the mistake it corrects: **a baseline must come
 * from OUTSIDE the thing it is supposed to bind.** A check whose reference is
 * derived from its own subject can only ever confirm the subject is
 * self-consistent — it cannot say the subject is the RIGHT one.
 *
 * The first attempt got exactly that wrong. It compared
 * `git -C <projectRoot> rev-parse --show-toplevel` against `projectRoot` itself,
 * so it answered only "is this path its own repo root?". That closed the
 * SUBDIRECTORY case (`git -C` walks UP to the enclosing repo, silently widening
 * scope), but an UNRELATED yet perfectly valid repository root passes it
 * trivially — resolved == projectRoot — and the scan then covers a tree nobody
 * asked about while reporting `scan_state: complete`. Demonstrated on two real
 * repositories, not argued.
 *
 * The external authority available here is `--security-root`: it points into the
 * PM control tree (`<project>/__garelier/<pmId>/…`), which is a DIFFERENT
 * argument resolved from the operator's own project, not from the tree being
 * scanned. Requiring the security root to live under `<projectRoot>/__garelier/`
 * therefore ties the scanned repo to the PM whose policy is driving the scan.
 *
 * Known limit, stated rather than left to be discovered: an operator who moves
 * BOTH arguments to another project is consistent and passes. Binding to the
 * seat's own permission record (the `gitleaksSeatIsBound` shape) is what closes
 * that, and a standalone CLI has no agent identity to resolve one with — the
 * cross-repo seat-binding gap is W-365. This function does not silently pass
 * that case: when no binding can be established it FAILS CLOSED and names why. */
function assertProjectBinding(projectRoot: string, securityRoot: string): void {
  const resolved = gitLines(projectRoot, ["rev-parse", "--show-toplevel"]).trim();
  if (!resolved) throw new Error(`cannot resolve a git toplevel for ${resolve(projectRoot)}`);
  if (canonicalDir(resolved) !== canonicalDir(projectRoot)) {
    throw new Error(
      `--project ${resolve(projectRoot)} is not a git repository toplevel (git resolved ${resolve(resolved)}); ` +
      "the scan would cover a different tree than the one under review",
    );
  }
  // The external cross-check: the control tree driving this scan must belong to
  // the repository being scanned.
  const garelierRoot = canonicalDir(join(projectRoot, GARELIER_DIRNAME));
  const security = canonicalDir(securityRoot);
  if (security !== garelierRoot && !security.startsWith(garelierRoot + "/")) {
    throw new Error(
      `--security-root ${resolve(securityRoot)} does not live under ${resolve(join(projectRoot, GARELIER_DIRNAME))}, ` +
      `so the repository named by --project ${resolve(projectRoot)} cannot be bound to the PM control tree driving this scan. ` +
      "Refusing rather than scanning an unrelated repository and reporting it complete (W-353 AC b; " +
      "seat-record binding for genuine cross-repo work is W-365).",
    );
  }
}

function changedFilesOf(projectRoot: string, base: string, head: string): string[] {
  return gitLines(projectRoot, ["diff", "--name-only", `${base}...${head}`])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Whole-tree lines at <head> for a final gate (the merge candidate, not just the
// diff). Skips binary/vendored files.
function treeLines(projectRoot: string, head: string): ScanLine[] {
  const files = gitLines(projectRoot, ["ls-tree", "-r", "--name-only", head])
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => f && !BINARY_OR_VENDORED.test(f));
  const out: ScanLine[] = [];
  for (const file of files) {
    const content = gitLines(projectRoot, ["show", `${head}:${file}`]);
    content.split("\n").forEach((text, i) => out.push({ file, line: i + 1, text }));
  }
  return out;
}

// ---- CLI --------------------------------------------------------------------

class CliError extends Error {}

interface CliOptions {
  configPath?: string;
  projectRoot: string;
  base: string;
  head: string;
  pmId?: string;
  securityRoot: string;
  scope: "diff" | "tree";
  outPath?: string;
  /** Opt in to recording a genuinely empty delta as a clean PASS. Default false:
   * an empty denominator is refused, because "nothing changed" and "the scan
   * never resolved a denominator" produced byte-identical output before W-461. */
  allowEmptyDelta?: boolean;
}

const VALUE_FLAGS = new Set([
  "config",
  "project",
  "base",
  "head",
  "pm-id",
  "security-root",
  "scope",
  "out",
]);
/** Flags that take no value. Kept separate from VALUE_FLAGS so `--allow-empty-delta`
 * is not mistaken for a flag that swallowed the next argument. */
const BOOLEAN_FLAGS = new Set(["allow-empty-delta"]);
/** Mode selectors handled in `main` before `parseCli` ever runs. */
const MODE_FLAGS = new Set(["probe-gitleaks", "optional", "sweep-stale-drafts"]);

/** W-461 AC-2 / G-2 — the ONE place the accepted argument set is written down.
 *
 * The pre-fix banner read
 *   `… [--pm-id <id> | --config <path>] --security-root <dir> …`
 * which puts the REQUIRED `--security-root` behind the optional group, so it
 * reads as "resolved from --pm-id". It is not, and never was: `resolveConfigPath`
 * infers a pm-id FROM the security root, not the other way round. A PM followed
 * the banner and got `lines_scanned: 0` three times before reading the parser.
 *
 * `guardian_scan.test.ts` asserts that the `--flags` named here and the flags the
 * parser accepts are the same set in BOTH directions, so a flag can no longer be
 * documented without being accepted (the merge_land → merge_request shape) or
 * accepted without being documented (the gate_runner `--steps` shape). */
export const USAGE = [
  "usage:",
  "  guardian_scan.ts --project <root> --base <ref> --head <ref> --security-root <dir>",
  "      [--pm-id <id> | --config <path>] [--scope diff|tree] [--out <path>] [--allow-empty-delta]",
  "  guardian_scan.ts <config> <projectRoot> <base> <head> --security-root <dir>",
  "      [--scope diff|tree] [--out <path>] [--allow-empty-delta]",
  "  guardian_scan.ts --probe-gitleaks [--optional]",
  "  guardian_scan.ts --sweep-stale-drafts --project <root> --pm-id <id>",
  "",
  "--security-root is REQUIRED in scan mode and is NEVER derived from --pm-id or",
  "--config. It names the Librarian security registries directory, normally",
  "<project>/__garelier/<pm-id>/knowledge/security (it must contain",
  "registries/secret_patterns.toml and must live under <project>/__garelier/).",
  "--allow-empty-delta records a deliberately empty delta as a PASS; without it an",
  "empty denominator is refused rather than reported clean (W-461).",
].join("\n");

/** Every flag the parsers accept, in any mode. Paired with USAGE by the set-equality
 * test; changing one without the other turns that test RED. */
export const ACCEPTED_FLAGS: readonly string[] = [
  ...VALUE_FLAGS, ...BOOLEAN_FLAGS, ...MODE_FLAGS,
].sort();

/** The `--flags` USAGE actually names. Exported so the test derives both sides
 * mechanically rather than restating a list a third time. */
export function usageFlags(usage: string = USAGE): string[] {
  return [...new Set(Array.from(usage.matchAll(/--([a-z][a-z0-9-]*)/g), (m) => m[1]))].sort();
}

function parseCli(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      if (flags.has(name)) throw new CliError(`duplicate flag --${name}`);
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new CliError(`unknown flag --${name}`);
    if (values.has(name)) throw new CliError(`duplicate flag --${name}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new CliError(`missing value for --${name}`);
    values.set(name, value);
  }

  let positionalConfig: string | undefined;
  let positionalProject: string | undefined;
  let positionalBase: string | undefined;
  let positionalHead: string | undefined;
  if (positional.length === 4) {
    [positionalConfig, positionalProject, positionalBase, positionalHead] = positional;
  } else if (positional.length === 1) {
    [positionalConfig] = positional;
  } else if (positional.length !== 0) {
    throw new CliError("expected either no positional arguments, <config>, or <config> <projectRoot> <base> <head>");
  }

  const merge = (name: string, positionalValue?: string): string | undefined => {
    const flagged = values.get(name);
    if (flagged && positionalValue) throw new CliError(`duplicate ${name}: positional value and --${name}`);
    return flagged ?? positionalValue;
  };
  const projectRoot = merge("project", positionalProject);
  const base = merge("base", positionalBase);
  const head = merge("head", positionalHead);
  const configPath = merge("config", positionalConfig);
  if (configPath && values.has("pm-id")) {
    throw new CliError("--config and --pm-id are mutually exclusive");
  }
  const securityRoot = values.get("security-root");
  // W-461 / control-transition L-4: report EVERY missing requirement at once. The
  // one-at-a-time form makes the caller pay a round trip per argument.
  const missing = [
    ["--project <root>", projectRoot],
    ["--base <ref>", base],
    ["--head <ref>", head],
    ["--security-root <dir>", securityRoot],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new CliError(`missing required argument(s): ${missing.join(", ")}\n${USAGE}`);
  }
  const scope = values.get("scope") ?? "diff";
  if (scope !== "diff" && scope !== "tree") throw new CliError("--scope must be diff|tree");
  return {
    configPath,
    projectRoot: projectRoot as string,
    base: base as string,
    head: head as string,
    pmId: values.get("pm-id"),
    securityRoot: securityRoot as string,
    scope,
    outPath: values.get("out"),
    allowEmptyDelta: flags.has("allow-empty-delta"),
  };
}

function inferredPmId(projectRoot: string, path: string): string | undefined {
  const garelierRoot = resolve(projectRoot, "__garelier");
  const rel = relative(garelierRoot, resolve(path));
  if (!rel || rel.startsWith("..") || resolve(garelierRoot, rel) === garelierRoot) return undefined;
  const [pmId] = rel.split(/[\\/]/);
  return pmId || undefined;
}

function configFor(projectRoot: string, pmId: string): string {
  return `${crewSubdir(projectRoot, pmId, "pm")}/setup_config.toml`;
}

function resolveConfigPath(opts: CliOptions): string {
  if (opts.configPath) {
    const explicit = resolve(opts.configPath);
    if (!existsSync(explicit)) throw new Error(`config not found at ${explicit}`);
    return explicit;
  }

  const exactPmId =
    opts.pmId ??
    process.env.GARELIER_PM_ID ??
    inferredPmId(opts.projectRoot, opts.securityRoot) ??
    inferredPmId(opts.projectRoot, process.cwd());
  if (exactPmId) {
    const exact = configFor(opts.projectRoot, exactPmId);
    if (!existsSync(exact)) throw new Error(`config not found at ${exact}`);
    return exact;
  }

  const garelierRoot = resolve(opts.projectRoot, "__garelier");
  const candidates = existsSync(garelierRoot)
    ? readdirSync(garelierRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => configFor(opts.projectRoot, entry.name))
      .filter(existsSync)
    : [];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) throw new Error(`no setup_config.toml found below ${garelierRoot}`);
  throw new Error(`config is ambiguous below ${garelierRoot}; pass --pm-id or --config`);
}

// ---- W-379: bind the atomic --out write to the PM's OWN trusted results
// dirs, not to ambient env/cwd -----------------------------------------------
//
// `writeDraftAtomic`'s rename/unlink go through path_guard's guarded wrappers
// (renameSync/unlinkSync), which fence a path against
// `defaultFenceRoots(cwd)` = [cwd, nearestRepoRoot(cwd), tmpdir(),
// ...GARELIER_* env vars, ...configuredRoots] when no explicit fenceRoots are
// supplied. That is a DIFFERENT, narrower fence than the one command_guard
// already resolves for the calling seat (dispatch_prepare.ts unions
// `<pmRoot>/runtime/<role>/results` into the seat's OWN fenceRoots at spawn
// time) — this script's process never sees that union, so its internal
// rename/delete was denied "outside fence roots" at every location tried
// (W-379: primary runtime dir / gavel container / results dir), regardless of
// what the seat's Bash-tool-level guard already permitted.
//
// The fix mirrors dispatch_prepare.ts's OWN computation
// (`join(pmRoot, "runtime", role, "results")`) rather than trusting the
// candidate `--out` path itself: pmId is derived from the ALREADY-RESOLVED
// `configPath` (an external authority — the same one `assertProjectBinding`
// above already ties the scan to), never from `--out`, so this cannot be
// pointed at an arbitrary attacker-chosen directory by the `--out` value
// alone.
function trustedResultsRoots(projectRoot: string, pmId: string | undefined): string[] {
  if (!pmId) return [];
  const pmRoot = join(projectRoot, GARELIER_DIRNAME, pmId);
  return [join(pmRoot, "runtime", "guardian", "results"), join(pmRoot, "runtime", "observer", "results")];
}

/** Register the PM's canonical guardian/observer results dirs as path_guard
 * trusted roots for THIS process, so the atomic --out write below can rename
 * its tmp file into place without depending on ambient GARELIER_* env vars or
 * the process's actual cwd being inside the fence. A no-op when pmId cannot
 * be resolved (falls back to the pre-W-379 ambient-fence behavior, unchanged
 * — never a regression, only an added capability). */
function registerTrustedResultsRoots(projectRoot: string, configPath: string): void {
  const pmId = inferredPmId(projectRoot, configPath);
  const roots = trustedResultsRoots(projectRoot, pmId);
  if (roots.length) configurePathGuardRoots(roots);
}

// A stale atomic-write tmp left behind by a rename that failed BEFORE this
// fix (W-379): `<outPath>.tmp-<pid>-<uuid>`. Narrowed to the two DOCUMENTED
// --out basenames, not any tmp-shaped suffix in general, so this can never
// sweep an unrelated file that happens to share the tmp naming scheme:
//   - `guardian_scan_draft.json` — the automated name review_gate_prep.ts
//     itself builds for a Guardian role (verified: review_gate_prep.ts:126,
//     `join(opts.outDir, "guardian_scan_draft.json")`).
//   - `<slug>-scan-draft.json` — a branch-slug-prefixed name, mirroring the
//     `<slug>-guardian.md` convention gate_field_manual.md §A-1 documents for
//     the final report; the EXACT shape W-379's incident report observed as
//     residue (`*-scan-draft.json.tmp-14936-*`).
// A `--out` target with any other basename is never swept, tmp-suffixed or
// not — this is a targeted cleanup for the two known conventions, not a
// general "anything under a trusted root that looks like a tmp file" sweep.
const STALE_SCAN_DRAFT_TMP_RE =
  /^(?:guardian_scan_draft|.+-scan-draft)\.json\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One-time (or PM-invoked) cleanup for the residue the pre-fix bug left
 * behind: a `writeDraftAtomic` tmp whose rename never completed. Scoped to
 * the SAME trusted results roots the write path now uses — never an
 * arbitrary caller-supplied directory — and only ever deletes a file whose
 * name matches the exact tmp suffix `writeDraftAtomic` generates. Returns the
 * removed paths (for the caller to report), swallowing per-file errors so one
 * unreadable/already-gone entry does not abort the sweep. */
export function sweepStaleScanDrafts(roots: readonly string[]): string[] {
  const removed: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!STALE_SCAN_DRAFT_TMP_RE.test(name)) continue;
      const candidate = join(root, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        unlinkSync(candidate);
        removed.push(candidate);
      } catch {
        // Already gone, or a fence/permission race — never fatal to the sweep.
      }
    }
  }
  return removed;
}

function pathsOf(v: unknown): string[] {
  const paths = v && typeof v === "object" ? (v as { paths?: unknown }).paths : undefined;
  return Array.isArray(paths) ? paths.map(String) : [];
}

/** Best-effort recovery of the arguments that DID parse, for a run that failed to
 * parse overall. Deliberately tolerant — its only consumer is the recovery text,
 * so a wrong guess costs a less specific hint, never a wrong decision. */
function salvageArgv(argv: string[]): Partial<Pick<CliOptions, "projectRoot" | "pmId" | "securityRoot" | "base" | "head">> {
  const pick = (flag: string): string | undefined => {
    const at = argv.lastIndexOf(`--${flag}`);
    const value = at >= 0 ? argv[at + 1] : undefined;
    return value && !value.startsWith("--") ? value : undefined;
  };
  return {
    projectRoot: pick("project"),
    pmId: pick("pm-id"),
    securityRoot: pick("security-root"),
    base: pick("base"),
    head: pick("head"),
  };
}

function requestedOutPaths(argv: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--out") continue;
    const value = argv[i + 1];
    if (value && !value.startsWith("--") && !paths.includes(value)) paths.push(value);
  }
  return paths;
}

function failureDraft(
  kind: ScanFailureKind,
  message: string,
  opts?: Partial<Pick<CliOptions, "base" | "head" | "scope">>,
  scannerBackend: ScannerBackend = "gitleaks",
): Draft {
  return {
    schema_version: 1,
    generated_by: "guardian_scan.ts",
    authority: "draft",
    scan_state: "failed",
    failure: { kind, message },
    scope: {
      kind: opts?.scope === "tree" ? "final_gate" : "delta_gate",
      base_ref: opts?.base,
      head_ref: opts?.head,
      secret_backend: scannerBackend,
    },
    coverage: {
      secret: "unavailable",
      pii: "unavailable",
      injection: "unavailable",
      dependency: "unavailable",
      license: "unavailable",
    },
    provisional_verdict: "NO_OPINION",
    findings: [],
    skipped_patterns: [],
    stats: null,
  };
}

/** W-461 AC-1 / G-4 — the executable next step for each way a scan can refuse.
 *
 *告知であって自動修復ではない: these strings are printed for the operator, never
 * run here. Each one is a command or an argument the caller can actually paste;
 * "something is wrong" without a next step is what sent a PM to read the parser. */
export function recoveryFor(
  kind: ScanFailureKind,
  message: string,
  opts?: Partial<Pick<CliOptions, "projectRoot" | "pmId" | "securityRoot" | "base" | "head">>,
): string[] {
  const project = opts?.projectRoot ? resolve(opts.projectRoot) : "<project-root>";
  const pmId = opts?.pmId ?? inferredPmId(opts?.projectRoot ?? ".", opts?.securityRoot ?? ".") ?? "<pm-id>";
  const canonicalSecurityRoot = join(project, GARELIER_DIRNAME, pmId, "knowledge", "security");
  switch (kind) {
    case "argv":
      // One array element per line: a single embedded multi-line string renders as
      // an unreadable `\n`-run in the JSON tail, which is where this gets read.
      return [
        ...USAGE.split("\n"),
        `example: bun guardian_scan.ts --project ${project} --base ${opts?.base ?? "<base-ref>"} --head ${opts?.head ?? "<head-ref>"} --security-root ${canonicalSecurityRoot}`,
      ];
    case "config":
      return [
        `pass the PM config explicitly: --config ${join(project, GARELIER_DIRNAME, pmId, "_crew", "pm", "setup_config.toml")}`,
        "or name the PM whose policy drives this scan: --pm-id <id>",
      ];
    case "internal":
      return message.includes("registries")
        ? [
          `--security-root must contain registries/secret_patterns.toml; the Librarian copy is normally ${canonicalSecurityRoot}`,
          `check it with: ls ${join(String(opts?.securityRoot ?? canonicalSecurityRoot), "registries")}`,
        ]
        : ["re-run with the same arguments and capture stderr; the failure above is internal to the scan, not an input error"];
    case "diff":
      return [
        `verify both refs resolve in the scanned repo: git -C ${project} rev-parse ${opts?.base ?? "<base>"} ${opts?.head ?? "<head>"}`,
        "a ref that starts with '-' is read as a git option; pass the resolved SHA instead",
      ];
    case "denominator":
      return [
        `check what the delta actually contains: git -C ${project} diff --name-only ${opts?.base ?? "<base>"}...${opts?.head ?? "<head>"}`,
        "a PROXY lane has no commits of its own — scan the branch that carries them, or point --base/--head at the landed range",
        "if the delta is deliberately empty, say so explicitly: --allow-empty-delta",
      ];
  }
}

/** W-461 AC-1 — a draft that did not complete never renders in the shape of a
 * result. `stats` goes to null and an `unresolved` block is appended LAST, so the
 * tail of the output (the part that gets read) states the failure and its
 * recovery instead of a row of zeros. */
export function withUnresolvedDenominator(draft: Draft, recovery: string[]): Draft {
  if (draft.scan_state === "complete") return draft;
  const kind = draft.failure?.kind ?? "internal";
  const message = draft.failure?.message ?? "scan failed";
  const { stats: _dropped, unresolved: _replaced, ...rest } = draft;
  return {
    ...rest,
    stats: null,
    unresolved: {
      denominator: "UNRESOLVED",
      failure_kind: kind,
      message,
      recovery,
      // LAST, deliberately, and it says both things a reader needs.
      // `recovery` can run to a dozen lines (an argv failure prints the whole
      // usage block), which pushed every earlier field of this object out of the
      // last fifteen lines — the exact window AC-1 is about. The verdict has to
      // sit AFTER the variable-length part or the tail stops carrying it. Caught
      // by the tail assertion in guardian_scan.test.ts, which is what it is for.
      read_this_as:
        "UNRESOLVED denominator — FAILED SCAN. Nothing was scanned. " +
        "This is NOT a clean result and MUST NOT be reported as coverage.",
    },
  };
}

function writeDraftAtomic(outPath: string, json: string): void {
  const tempPath = `${outPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    // W-379: dispatch_prepare.ts pre-creates the results dir for a properly
    // dispatched gate seat, but this script has no such guarantee from every
    // caller (a direct invocation, a test fixture, a future ad-hoc spawn) --
    // ensure the directory exists here too, through the SAME guarded API as
    // the rename below, so a missing directory fails closed to the fence
    // (never a plain ENOENT with no actionable message) rather than assuming
    // an external mkdir already ran. Only when it is actually missing: an
    // ALREADY-existing --out directory (e.g. the repo root itself, a
    // pre-W-379 supported location) must not take the guarded create path at
    // all -- path_guard's "ancestor of a fence root" protection correctly
    // refuses to `create` a path that is an ANCESTOR of one of the newly
    // registered trusted roots (the repo root is an ancestor of
    // <repo>/__garelier/<pmId>/runtime/guardian/results once that is
    // registered), and re-creating a directory that already exists has
    // nothing to gain from routing through that check.
    if (!existsSync(dirname(outPath))) guardedMkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(tempPath, json, { encoding: "utf8", flag: "wx" });
    renameSync(tempPath, outPath);
  } catch (e) {
    try { unlinkSync(tempPath); } catch { /* temp may not exist */ }
    throw e;
  }
}

async function emitDraft(
  draft: Draft,
  outPath: string | readonly string[] | undefined,
  exitCode: number,
  recovery?: string[],
): Promise<number> {
  // Single choke point for W-461 AC-1: EVERY emitted draft passes through here,
  // so no failure path can reintroduce the success-shaped stats block.
  const emitted = draft.scan_state === "complete"
    ? draft
    : withUnresolvedDenominator(draft, recovery ?? recoveryFor(draft.failure?.kind ?? "internal", draft.failure?.message ?? ""));
  const json = JSON.stringify(emitted, null, 2) + "\n";
  const outPaths = typeof outPath === "string" ? [outPath] : [...(outPath ?? [])];
  for (const path of outPaths) writeDraftAtomic(path, json);
  if (outPaths.length && exitCode === 0) process.stdout.write(`${outPaths[0]}\n`);
  else process.stdout.write(json);
  return exitCode;
}

async function failClosed(
  kind: ScanFailureKind,
  message: string,
  opts?: Partial<Pick<CliOptions, "base" | "head" | "scope" | "outPath" | "projectRoot" | "pmId" | "securityRoot">>
    & { outPaths?: string[] },
  scannerBackend: ScannerBackend = "gitleaks",
  exitCode = kind === "argv" ? 2 : 3,
): Promise<number> {
  const recovery = recoveryFor(kind, message, opts);
  // stderr carries the cause AND the way out; G-4 forbids stopping at "what is
  // wrong" when the next command is derivable here.
  process.stderr.write(`guardian_scan: ${message}\n`);
  for (const step of recovery) process.stderr.write(`guardian_scan: recovery: ${step}\n`);
  return emitDraft(
    failureDraft(kind, message, opts, scannerBackend),
    opts?.outPaths ?? opts?.outPath,
    exitCode,
    recovery,
  );
}

/** W-379: a standalone cleanup entry for the stale atomic-write tmps the
 * pre-fix bug left behind (`*-scan-draft.json.tmp-<pid>-<uuid>` under
 * `runtime/guardian/results` / `runtime/observer/results`). Deliberately
 * simple and explicit -- `--project`/`--pm-id` are REQUIRED here (no cwd or
 * securityRoot inference), since this is an operator-invoked, one-time
 * cleanup, not part of the scan's hot path. */
async function sweepStaleDraftsMain(argv: string[]): Promise<number> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sweep-stale-drafts") continue;
    if (arg === "--project" || arg === "--pm-id") {
      const value = argv[++i];
      if (!value) {
        process.stderr.write(`guardian_scan: missing value for ${arg}\n`);
        return 2;
      }
      values.set(arg.slice(2), value);
      continue;
    }
    process.stderr.write("guardian_scan: --sweep-stale-drafts accepts only --project <root> --pm-id <id>\n");
    return 2;
  }
  const projectRoot = values.get("project");
  const pmId = values.get("pm-id");
  if (!projectRoot || !pmId) {
    process.stderr.write("guardian_scan: --sweep-stale-drafts requires --project <root> --pm-id <id>\n");
    return 2;
  }
  const roots = trustedResultsRoots(resolve(projectRoot), pmId);
  // Same registration as the scan path (registerTrustedResultsRoots): the
  // sweep's own unlinkSync call is path_guard-guarded too, so it must not
  // depend on the operator's ambient cwd either.
  if (roots.length) configurePathGuardRoots(roots);
  const removed = sweepStaleScanDrafts(roots);
  process.stdout.write(`${JSON.stringify({ removed, roots }, null, 2)}\n`);
  return 0;
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--sweep-stale-drafts")) return sweepStaleDraftsMain(argv);
  if (argv.includes("--probe-gitleaks")) {
    const unexpected = argv.filter((arg) => arg !== "--probe-gitleaks" && arg !== "--optional");
    if (
      unexpected.length ||
      argv.filter((arg) => arg === "--probe-gitleaks").length !== 1 ||
      argv.filter((arg) => arg === "--optional").length > 1
    ) {
      return failClosed(
        "argv",
        "probe mode accepts only one --probe-gitleaks and optional --optional",
        { outPaths: requestedOutPaths(argv) },
      );
    }
    const probe = probeGitleaks({ required: !argv.includes("--optional") });
    process.stdout.write(`${JSON.stringify(probe)}\n`);
    return probe.status === "BLOCK" ? 3 : 0;
  }

  let opts: CliOptions;
  try {
    opts = parseCli(argv);
  } catch (e) {
    // G-4: even a rejected argv usually carries enough to spell the corrected
    // command out concretely. Salvage what parsed so the recovery names real
    // paths instead of `<project-root>` placeholders the caller has to fill in.
    return failClosed("argv", (e as Error).message, {
      outPaths: requestedOutPaths(argv),
      ...salvageArgv(argv),
    });
  }

  let configPath: string;
  try {
    configPath = resolveConfigPath(opts);
  } catch (e) {
    return failClosed("config", (e as Error).message, opts);
  }
  // W-379: best-effort. registerTrustedResultsRoots only ADDS a trusted
  // rename/delete destination for THIS process's atomic --out write; it never
  // narrows anything, so a failure here must not fail the scan itself --
  // worst case is a fall-back to the pre-W-379 ambient-fence behavior.
  try {
    registerTrustedResultsRoots(opts.projectRoot, configPath);
  } catch {
    // Non-fatal by design (see comment above).
  }

  // package_files from [guardian_policy]; default to the common manifests.
  let packageFiles = [
    "package.json", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "Cargo.toml", "Cargo.lock", "requirements.txt", "poetry.lock", "pyproject.toml", "go.mod", "go.sum", "Gemfile", "Gemfile.lock",
  ];
  let scannerBackend: ScannerBackend = "gitleaks";
  try {
    const cfg = parse(await Bun.file(configPath).text()) as Record<string, unknown>;
    const gp = (cfg.guardian_policy ?? {}) as Record<string, unknown>;
    const fromCfg = pathsOf(gp.package_files);
    if (fromCfg.length) packageFiles = fromCfg;
    scannerBackend = resolveScannerBackend(cfg);
  } catch (e) {
    return failClosed("config", `cannot read ${configPath} (${(e as Error).message})`, opts);
  }

  let reg: Registries;
  try {
    reg = await loadRegistries(opts.securityRoot);
  } catch (e) {
    return failClosed("internal", (e as Error).message, opts, scannerBackend);
  }

  let lines: ScanLine[];
  let changedFiles: string[];
  try {
    assertProjectBinding(opts.projectRoot, opts.securityRoot);
    if (opts.scope === "tree") {
      lines = treeLines(opts.projectRoot, opts.head);
      changedFiles = changedFilesOf(opts.projectRoot, opts.base, opts.head);
    } else {
      const diff = gitLines(opts.projectRoot, ["diff", "--unified=0", `${opts.base}...${opts.head}`]);
      lines = parseAddedLines(diff);
      changedFiles = changedFilesOf(opts.projectRoot, opts.base, opts.head);
    }
  } catch (e) {
    return failClosed("diff", (e as Error).message, opts, scannerBackend);
  }

  // W-461 AC-3 — the denominator, not the findings, is what a PROXY lane lacks.
  // A lane whose deliverable is uncommitted resolves `--base studio --head HEAD`
  // to nothing, and the pre-fix output (PASS, lines_scanned 0) was indistinguishable
  // from "scanned everything, found nothing". Refuse instead — and name the opt-in
  // that keeps a deliberately empty delta reachable, so this stays a notice rather
  // than a narrowing of what the caller may ask for.
  if (!opts.allowEmptyDelta && lines.length === 0 && changedFiles.length === 0) {
    return failClosed(
      "denominator",
      `no content to scan: ${opts.scope === "tree" ? `\`${opts.head}\` resolves to an empty tree` : `\`${opts.base}...${opts.head}\` resolves to an empty delta`} ` +
      "(0 changed files, 0 lines). An unresolved denominator is not a clean scan — " +
      "a PROXY lane with no commits produces exactly this shape. Pass --allow-empty-delta to record it as deliberately empty.",
      opts,
      scannerBackend,
    );
  }

  let draft: Draft;
  try {
    draft = scan(reg, {
      kind: opts.scope === "tree" ? "final_gate" : "delta_gate",
      baseRef: opts.base,
      headRef: opts.head,
      lines,
      changedFiles,
      packageFiles,
      scannerBackend,
    });
  } catch (e) {
    return failClosed("internal", `scan failed (${(e as Error).message})`, opts, scannerBackend);
  }
  if (draft.scan_state === "failed") {
    const message = draft.failure?.message ?? "scan failed";
    process.stderr.write(`guardian_scan: ${message}\n`);
    return emitDraft(draft, opts.outPath, 3);
  }
  return emitDraft(draft, opts.outPath, 0);
}

if (import.meta.main) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(async (e) => {
    process.exitCode = await failClosed("internal", `unexpected failure (${(e as Error).message})`);
  });
}
