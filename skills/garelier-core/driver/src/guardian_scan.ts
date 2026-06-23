// Deterministic Guardian SCAN draft-producer (DEC-079).
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
// CLI:
//   bun guardian_scan.ts <config> <projectRoot> <base> <head> \
//       --security-root <dir> [--scope diff|tree] [--out <path>]
//   Writes the draft JSON to --out (default: stdout). Exit 0 on a produced draft,
//   2 on usage error. Read/compute failures fail OPEN with a stderr warning and a
//   NO_OPINION coverage note — the §-level skill flow remains primary enforcement.

import { parse } from "smol-toml";

export type Dimension = "secret" | "pii" | "injection" | "dependency" | "license";
export type Verdict = "PASS" | "PASS_WITH_NOTES" | "BLOCK" | "NO_OPINION";
export type Coverage = "scanned" | "degraded" | "external_required" | "unavailable" | "not_applicable";
export type Action = "block" | "note" | "review";

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
export interface Draft {
  schema_version: 1;
  generated_by: "guardian_scan.ts";
  authority: "draft"; // the agent owns the final verdict (DEC-079)
  scope: { kind: ScanInput["kind"]; base_ref?: string; head_ref?: string; review_sha?: string };
  coverage: Record<Dimension, Coverage>;
  provisional_verdict: Verdict;
  findings: Finding[];
  // Pattern ids that failed to compile (recall gap surfaced, never silent). When
  // a mandatory dimension (secret/pii) is degraded, run the external scanner /
  // manual review — do not trust a clean draft.
  skipped_patterns: string[];
  stats: { lines_scanned: number; findings: number; needs_review: number; excepted: number; skipped: number };
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
  // A degraded MANDATORY scan (secret/pii) must never produce a clean PASS — its
  // recall is reduced, so the agent has to complete it (external scanner / manual).
  const degradedMandatory = coverage.secret === "degraded" || coverage.pii === "degraded";
  const hasNote = findings.some((f) => f.action === "note");

  let provisional_verdict: Verdict;
  if (hasBlock) provisional_verdict = "BLOCK";
  else if (hasReview || externalPending || degradedMandatory) provisional_verdict = "NO_OPINION";
  else if (hasNote) provisional_verdict = "PASS_WITH_NOTES";
  else provisional_verdict = "PASS";

  return {
    schema_version: 1,
    generated_by: "guardian_scan.ts",
    authority: "draft",
    scope: { kind: input.kind, base_ref: input.baseRef, head_ref: input.headRef, review_sha: input.reviewSha },
    coverage,
    provisional_verdict,
    findings,
    skipped_patterns,
    stats: {
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
    if (!(await f.exists())) return {};
    return parse(await f.text()) as Record<string, unknown>;
  } catch (e) {
    process.stderr.write(`guardian_scan: cannot read ${path} (${(e as Error).message})\n`);
    return {};
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
  const r = Bun.spawnSync(["git", "-C", projectRoot, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.exitCode})`);
  return new TextDecoder().decode(r.stdout);
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
    let content: string;
    try {
      content = gitLines(projectRoot, ["show", `${head}:${file}`]);
    } catch {
      continue;
    }
    content.split("\n").forEach((text, i) => out.push({ file, line: i + 1, text }));
  }
  return out;
}

// ---- CLI --------------------------------------------------------------------

function fail(msg: string): never {
  process.stderr.write(`guardian_scan: ${msg}\n`);
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pathsOf(v: unknown): string[] {
  const paths = v && typeof v === "object" ? (v as { paths?: unknown }).paths : undefined;
  return Array.isArray(paths) ? paths.map(String) : [];
}

async function main(): Promise<void> {
  const [, , configPath, projectRoot, base, head] = process.argv;
  if (!configPath || !projectRoot || !base || !head) {
    fail("usage: guardian_scan.ts <config> <projectRoot> <base> <head> --security-root <dir> [--scope diff|tree] [--out <path>]");
  }
  const securityRoot = flag("security-root");
  if (!securityRoot) fail("missing --security-root <dir> (the resolved security/ knowledge tree)");
  const scope = flag("scope") === "tree" ? "tree" : "diff";
  const outPath = flag("out");

  // package_files from [guardian_policy]; default to the common manifests.
  let packageFiles = [
    "package.json", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "Cargo.toml", "Cargo.lock", "requirements.txt", "poetry.lock", "pyproject.toml", "go.mod", "go.sum", "Gemfile", "Gemfile.lock",
  ];
  try {
    const cfg = parse(await Bun.file(configPath).text()) as Record<string, unknown>;
    const gp = (cfg.guardian_policy ?? {}) as Record<string, unknown>;
    const fromCfg = pathsOf(gp.package_files);
    if (fromCfg.length) packageFiles = fromCfg;
  } catch {
    /* default package list; config is optional for the scan */
  }

  const reg = await loadRegistries(securityRoot);

  let lines: ScanLine[];
  let changedFiles: string[];
  try {
    if (scope === "tree") {
      lines = treeLines(projectRoot, head);
      changedFiles = changedFilesOf(projectRoot, base, head);
    } else {
      const diff = gitLines(projectRoot, ["diff", "--unified=0", `${base}...${head}`]);
      lines = parseAddedLines(diff);
      changedFiles = changedFilesOf(projectRoot, base, head);
    }
  } catch (e) {
    // Fail open: produce a NO_OPINION draft so the agent runs the manual path.
    process.stderr.write(`guardian_scan: ${(e as Error).message}; emitting NO_OPINION draft\n`);
    lines = [];
    changedFiles = [];
  }

  const draft = scan(reg, {
    kind: scope === "tree" ? "final_gate" : "delta_gate",
    baseRef: base,
    headRef: head,
    lines,
    changedFiles,
    packageFiles,
  });

  const json = JSON.stringify(draft, null, 2);
  if (outPath) {
    await Bun.write(outPath, json + "\n");
    process.stdout.write(`${outPath}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

if (import.meta.main) {
  void main();
}
