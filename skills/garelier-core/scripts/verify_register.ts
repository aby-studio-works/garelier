#!/usr/bin/env bun
// Garelier register claim verifier — W-059.
//
// A completion "register" (a report.md / promote.md / concierge_report.json, or
// a producer's compact REGISTER message the PM transcribes) states git facts:
// commit SHAs, a release tag, a branch tip, a clean worktree, a gate verdict.
// The 2026-07-13 incident (v2.11.3 release + #277) is the failure class this
// guards: a producer reported 3 FABRICATED commit SHAs, a tag that did not
// exist, and a gate PASS that the verdict file did not support. SHA hallucination
// is a recurring class, so the PM must be able to MECHANICALLY check a register
// against the real repo in ONE command BEFORE any external action (merge_land,
// push, tag, release).
//
// This never trusts the register's prose — it re-derives every claim from git:
//   * commit  — `git cat-file -e <sha>^{commit}` : the object actually exists.
//   * tag     — the ref exists, and (when a SHA is claimed) it peels to that commit.
//   * branch  — the ref exists, and (when a SHA is claimed) its tip equals it.
//   * worktree— `git status --porcelain` is empty (clean).
//   * gate    — the named verdict file exists AND contains the claimed verdict
//               (catches a register claiming PASS over a BLOCK / missing verdict).
//
// Two input paths:
//   1. AUTHORITATIVE CLI claims (hard — a mismatch always FAILs). The PM passes
//      the exact facts it is about to act on:
//        verify_register.ts --repo <path>
//          --commit <sha> [--commit <sha> ...]
//          --tag <name>[=<sha>] [--tag ...]
//          --branch <name>=<sha> [--branch ...]
//          --worktree-clean <path> [--worktree-clean ...]
//          --gate <verdict-file>=<VERDICT> [--gate ...]
//   2. BEST-EFFORT register parse (--register <file>): label-gated extraction of
//      SHAs / tags / branch refs from a report/promote/concierge register. SHA and
//      tag claims are hard; a branch ref pulled from a register is SOFT (WARN, not
//      FAIL) because merged workbench branches are legitimately deleted afterward.
//
// Exit code: 0 when every hard claim passed (warnings allowed), 1 when any hard
// claim FAILed, 2 on a usage error. `--format json` emits a machine record.
//
// ── Integration proposal (NOT wired here — W-059 (c)) ────────────────────────
// merge_land.sh should call this as a PRE-SUBMIT preflight: before it opens a
// merge_request, run
//     bun verify_register.ts --repo <project> \
//        --branch <workbench-branch>=<reported-tip> \
//        --gate <guardian-report>=PASS --gate <observer-report>=PASS
// and refuse the submit on a non-zero exit (like the existing --require-seat-trailer
// gate). A release/promote flow should additionally pass --tag v<version>=<sha>
// and every --commit it is about to push. Wiring is deferred to a follow-up so
// this lands as a standalone, independently testable verifier first.

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

// A git object id: short (>=7) through full SHA-1 (40) or SHA-256 (64) hex.
const SHA_RE_G = /\b[0-9a-f]{7,64}\b/gi;

export type Severity = "pass" | "warn" | "fail";
export interface ClaimResult {
  kind: "commit" | "tag" | "branch" | "worktree" | "gate";
  claim: string;          // the human-readable thing checked
  severity: Severity;
  detail: string;         // what git said
  source: "cli" | "register";
}

// ── git helpers (never throw; a non-zero git exit is data, not a crash) ───────
function git(repo: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// Expand any committish to its full commit SHA, or null when it does not resolve.
export function resolveCommit(repo: string, ref: string): string | null {
  const r = git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 && r.out ? r.out : null;
}

// Two object ids name the same commit when the SHORTER is a prefix of the longer
// (git short SHAs), after both are lowercased.
function shaMatch(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long.startsWith(short);
}

export function verifyCommit(repo: string, sha: string, source: "cli" | "register"): ClaimResult {
  const full = resolveCommit(repo, sha);
  return full
    ? { kind: "commit", claim: sha, severity: "pass", detail: `exists (${full})`, source }
    : { kind: "commit", claim: sha, severity: "fail", detail: "no such commit object in repo", source };
}

export function verifyTag(repo: string, tag: string, expectSha: string | null, source: "cli" | "register"): ClaimResult {
  const ref = git(repo, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
  if (ref.code !== 0 || !ref.out) {
    return { kind: "tag", claim: tag, severity: "fail", detail: "tag ref does not exist", source };
  }
  // Peel to the commit the tag ultimately names (handles annotated tags).
  const peeled = resolveCommit(repo, tag);
  if (!peeled) {
    return { kind: "tag", claim: tag, severity: "fail", detail: "tag exists but does not peel to a commit", source };
  }
  if (expectSha && !shaMatch(expectSha, peeled)) {
    return { kind: "tag", claim: `${tag}=${expectSha}`, severity: "fail",
      detail: `tag points to ${peeled}, not the claimed ${expectSha}`, source };
  }
  return { kind: "tag", claim: expectSha ? `${tag}=${expectSha}` : tag, severity: "pass",
    detail: `tag -> ${peeled}`, source };
}

export function verifyBranch(repo: string, name: string, expectSha: string | null,
                             source: "cli" | "register"): ClaimResult {
  // Accept a plain branch name (refs/heads/<name>) or an already-qualified ref.
  const candidates = [`refs/heads/${name}`, name];
  let tip: string | null = null;
  for (const c of candidates) {
    const r = git(repo, ["rev-parse", "--verify", "--quiet", `${c}^{commit}`]);
    if (r.code === 0 && r.out) { tip = r.out; break; }
  }
  if (!tip) {
    // A register-derived branch absence is SOFT: merged workbench branches are
    // deleted as designed, so this is a warning, not proof of fabrication. A
    // CLI-asserted branch is hard (the PM is about to act on that exact tip).
    const severity: Severity = source === "cli" ? "fail" : "warn";
    return { kind: "branch", claim: expectSha ? `${name}=${expectSha}` : name, severity,
      detail: source === "cli" ? "branch ref does not exist" : "branch ref not present (may be a merged/deleted branch)", source };
  }
  if (expectSha && !shaMatch(expectSha, tip)) {
    return { kind: "branch", claim: `${name}=${expectSha}`, severity: "fail",
      detail: `branch tip is ${tip}, not the claimed ${expectSha}`, source };
  }
  return { kind: "branch", claim: expectSha ? `${name}=${expectSha}` : name, severity: "pass",
    detail: `tip ${tip}`, source };
}

export function verifyWorktreeClean(worktree: string, source: "cli" | "register"): ClaimResult {
  if (!existsSync(worktree)) {
    return { kind: "worktree", claim: worktree, severity: "fail", detail: "worktree path does not exist", source };
  }
  const r = git(worktree, ["status", "--porcelain"]);
  if (r.code !== 0) {
    return { kind: "worktree", claim: worktree, severity: "fail", detail: `not a git worktree (${r.err || "git status failed"})`, source };
  }
  return r.out === ""
    ? { kind: "worktree", claim: worktree, severity: "pass", detail: "clean", source }
    : { kind: "worktree", claim: worktree, severity: "fail",
        detail: `dirty: ${r.out.split(/\r?\n/).length} uncommitted/untracked path(s)`, source };
}

// A gate claim is `<verdict-file>=<VERDICT>`: the file must exist and physically
// contain the claimed verdict token (whole word, case-insensitive). This catches
// a register asserting PASS over a verdict file that says BLOCK, or one that was
// never written. The verdict vocabulary is garelier-core's gate verdicts.
export function verifyGate(file: string, verdict: string, source: "cli" | "register"): ClaimResult {
  const claim = `${file}=${verdict}`;
  if (!existsSync(file) || !statSync(file).isFile()) {
    return { kind: "gate", claim, severity: "fail", detail: "verdict file does not exist", source };
  }
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { /* unreadable */ }
  const re = new RegExp(`\\b${verdict.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(text)
    ? { kind: "gate", claim, severity: "pass", detail: `verdict file contains ${verdict}`, source }
    : { kind: "gate", claim, severity: "fail", detail: `verdict file does NOT contain ${verdict}`, source };
}

// ── best-effort register parse ────────────────────────────────────────────────
export interface ParsedRegister { shas: string[]; tags: string[]; branches: string[]; }

// SHA-claim LABEL contexts: a commit id counts only when it appears in a field/
// key-like position, never merely on a line that happens to contain the word
// "commit" in prose ("...without a commit label..."). Each pattern is a label
// followed by a `:`/`=` delimiter (or a JSON key / a promote "Source: ... (sha)").
const SHA_LABELS: RegExp[] = [
  /\blast\s+commit\b\s*[:=]/i,          // report.md  "Last commit: <sha>"
  /\bcommit\s*[_-]?\s*sha\b/i,          // "commit_sha" / "commit sha"
  /\bcommit\b\s*[:=]/i,                 // "commit: <sha>" / "commit = <sha>"
  /\bsha\b\s*[:=]/i,                    // promote.md "Final target SHA: <sha>"
  /target_(?:before|after)_sha/i,       // concierge return values
  /"commits"\s*:/i,                     // report.json  "commits": ["<sha>", ...]
  /\bsource\b\s*[:=].*\(/i,             // promote.md "Source: …/studio (<sha>)"
];

// Label-gated extraction so prose hex/version words do not become false claims:
//   * SHAs    only in a labeled field context (see SHA_LABELS).
//   * tags    from a line naming a tag (Tag name:, "tag": ...), keeping v-prefixed
//             or bare ref tokens.
//   * branches from a line naming a branch (Branch:, "review_target"/"branch"),
//             keeping ref-path-looking tokens (contain a slash).
export function parseRegister(text: string): ParsedRegister {
  const shas = new Set<string>();
  const tags = new Set<string>();
  const branches = new Set<string>();
  const strip = (s: string) => s.replace(/^[`"'\s]+|[`"',.;)\s]+$/g, "");

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // SHA-bearing lines: only lines whose commit/sha reference is in a labeled
    // field position. Extract every hex token on such a line (a JSON commits
    // array may carry several).
    if (SHA_LABELS.some((re) => re.test(line))) {
      const m = line.match(SHA_RE_G);
      if (m) for (const h of m) shas.add(h.toLowerCase());
    }

    // Tag lines.
    const tagLabel = line.match(/\btag(?:\s*name)?\b[^:=]*[:=]\s*(.+)$/i)
      || line.match(/"tag"\s*:\s*(.+)$/i);
    if (tagLabel) {
      const tok = strip(tagLabel[1].split(/\s+/)[0] || "");
      // keep version-ish or non-placeholder tokens; drop template markers.
      if (tok && !tok.includes("{{") && /[0-9A-Za-z]/.test(tok)) tags.add(tok);
    }

    // Branch lines: keep ref-path-looking tokens (must contain a slash so a bare
    // word like "branch" or "main" mention is not treated as a claim).
    const brLabel = line.match(/\bbranch\b[^:=]*[:=]\s*(.+)$/i)
      || line.match(/"(?:review_target|branch)"\s*:\s*(.+)$/i);
    if (brLabel) {
      const tok = strip(brLabel[1].split(/\s+/)[0] || "");
      if (tok && tok.includes("/") && !tok.includes("{{")) branches.add(tok);
    }
  }
  return {
    shas: [...shas],
    tags: [...tags],
    branches: [...branches],
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
interface CliArgs {
  repo: string;
  commits: string[];
  tags: string[];       // "name" or "name=sha"
  branches: string[];   // "name=sha" or "name"
  worktrees: string[];
  gates: string[];      // "file=VERDICT"
  register: string | null;
  format: "text" | "json";
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { repo: ".", commits: [], tags: [], branches: [], worktrees: [], gates: [], register: null, format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "--repo": a.repo = next(); break;
      case "--commit": a.commits.push(next()); break;
      case "--tag": a.tags.push(next()); break;
      case "--branch": a.branches.push(next()); break;
      case "--worktree-clean": a.worktrees.push(next()); break;
      case "--gate": a.gates.push(next()); break;
      case "--register": a.register = next(); break;
      case "--format": a.format = next() === "json" ? "json" : "text"; break;
      default:
        if (flag.startsWith("--")) throw new Error(`unknown flag: ${flag}`);
    }
  }
  return a;
}

// Split "key=value" on the FIRST '=' (a verdict-file path never contains '=',
// and a SHA/verdict never does either).
function splitEq(s: string): [string, string | null] {
  const i = s.indexOf("=");
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
}

export function runVerification(a: CliArgs): ClaimResult[] {
  const results: ClaimResult[] = [];
  for (const c of a.commits) results.push(verifyCommit(a.repo, c, "cli"));
  for (const t of a.tags) { const [name, sha] = splitEq(t); results.push(verifyTag(a.repo, name, sha, "cli")); }
  for (const b of a.branches) { const [name, sha] = splitEq(b); results.push(verifyBranch(a.repo, name, sha, "cli")); }
  for (const w of a.worktrees) results.push(verifyWorktreeClean(w, "cli"));
  for (const g of a.gates) { const [file, verdict] = splitEq(g); results.push(verifyGate(file, verdict ?? "PASS", "cli")); }

  if (a.register) {
    if (!existsSync(a.register)) {
      results.push({ kind: "commit", claim: a.register, severity: "fail", detail: "register file does not exist", source: "register" });
    } else {
      const parsed = parseRegister(readFileSync(a.register, "utf8"));
      for (const s of parsed.shas) results.push(verifyCommit(a.repo, s, "register"));
      for (const t of parsed.tags) results.push(verifyTag(a.repo, t, null, "register"));
      for (const b of parsed.branches) results.push(verifyBranch(a.repo, b, null, "register"));
    }
  }
  return results;
}

export function summarize(results: ClaimResult[]): { pass: number; warn: number; fail: number; ok: boolean } {
  let pass = 0, warn = 0, fail = 0;
  for (const r of results) {
    if (r.severity === "pass") pass++;
    else if (r.severity === "warn") warn++;
    else fail++;
  }
  return { pass, warn, fail, ok: fail === 0 };
}

function main() {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e: any) {
    console.error(`verify_register: ${e?.message ?? e}`);
    process.exit(2);
  }
  const hasClaims = args.commits.length || args.tags.length || args.branches.length
    || args.worktrees.length || args.gates.length || args.register;
  if (!hasClaims) {
    console.error("verify_register: nothing to verify — pass --commit/--tag/--branch/--worktree-clean/--gate and/or --register.");
    console.error("  example: verify_register.ts --repo . --commit <sha> --tag v2.11.3=<sha> --gate runtime/guardian/results/x-guardian.md=PASS");
    process.exit(2);
  }

  const results = runVerification(args);
  const sum = summarize(results);

  if (args.format === "json") {
    console.log(JSON.stringify({ ok: sum.ok, summary: sum, results }, null, 2));
  } else {
    const mark = (s: Severity) => (s === "pass" ? "PASS" : s === "warn" ? "WARN" : "FAIL");
    for (const r of results) {
      console.log(`  [${mark(r.severity)}] ${r.kind}: ${r.claim} — ${r.detail}${r.source === "register" ? " (from register)" : ""}`);
    }
    console.log(`verify_register: ${sum.ok ? "OK" : "FAILED"} — ${sum.pass} pass, ${sum.warn} warn, ${sum.fail} fail`);
    if (!sum.ok) console.log("  Do NOT proceed with the external action; the register does not match the repo.");
  }
  process.exit(sum.ok ? 0 : 1);
}

if (import.meta.main) main();
