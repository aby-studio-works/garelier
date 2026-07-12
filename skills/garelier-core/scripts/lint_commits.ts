#!/usr/bin/env bun
// Commit-message validator (DEC-051, Conventional Commits + bound item ID).
//
// Non-mandatory layer: this is run by Garelier's own pipeline, by the framework
// ci.sh, and by an OPT-IN local commit-msg hook (install_hooks.sh). It is
// never a repo-global hook or a shared-CI gate in a target project, so it cannot
// break a non-Garelier contributor's plain `git commit`.
//
// Usage:
//   bun lint_commits.ts <commit-msg-file>     # git commit-msg hook passes the path
//   bun lint_commits.ts --last [<dir>]        # validate HEAD's message (ci)
//   bun lint_commits.ts --range <gitref> [<dir>]   # validate a..HEAD (ci)
//       --first-parent always (W-042 round-3): walks only the checked-out
//       branch's own history, not a base-tracking merge's second-parent
//       (studio-side) ancestry — see the inline comment at the --range branch.
//   echo "<msg>" | bun lint_commits.ts -      # stdin
//   ... --require-seat-trailer                # opt-in flag, combine with any mode above:
//       a missing/malformed `Garelier-Seat: codex <model> (proxy-commit via
//       dock seat)` trailer becomes a hard ERROR instead of being unchecked.
//       Default behavior is unchanged unless this flag is passed (guardian
//       W-042 finding 2 — the Dock uses this to validate a commit_mode=proxy
//       dispatch's proxy-committed SHA).
//   ... --seat-summary                        # workshop W-051, combine with --range only:
//       instead of pass/fail, prints ONE JSON line classifying every commit in
//       the range as proxy (has a well-formed Garelier-Seat trailer) / self (has
//       a Garelier: marker trailer but no Garelier-Seat line) / missing (neither)
//       — {"total":N,"proxy":N,"self":N,"missing":N}. Never fails (exit 0) — it
//       is a report merge_land.sh's seat-handover preflight reads, not a gate.
// Exit 0 = pass, 1 = violations (printed), 2 = usage error.

const TYPES = ["feat", "fix", "refactor", "docs", "test", "chore", "build", "ci", "perf", "revert", "release"];
const SUBJECT_MAX = 72;

// Auto-generated / tooling messages we never gate.
function isExempt(first: string): boolean {
  return /^(Merge |Revert "|fixup!|squash!|Reapply )/.test(first) || first.trim() === "";
}

export interface LintResult { ok: boolean; errors: string[]; warnings: string[] }
export interface LintOptions { requireSeatTrailer?: boolean }

// Well-formed `Garelier-Seat: codex <model> (proxy-commit via dock seat)` line
// (commit_convention.md / dispatch_prepare.sh COMMIT_RULE). <model> is any
// non-space token; the parenthetical suffix is fixed text, not a placeholder.
const SEAT_TRAILER_RE = /^Garelier-Seat:\s+codex\s+\S+\s+\(proxy-commit via dock seat\)\s*$/;

// Validate ONE commit message. Shape errors hard-fail; context-dependent rules
// (scope, bound item ID) warn — the message alone can't always prove they apply.
export function lintCommitMessage(msg: string, opts: LintOptions = {}): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Drop trailing comment lines (git editor template) and normalize newlines.
  const lines = msg.replace(/\r\n?/g, "\n").split("\n").filter((l) => !l.startsWith("#"));
  const first = lines[0] ?? "";
  if (isExempt(first)) return { ok: true, errors, warnings };

  // First line: <type>(<scope>)?(!)?: <summary>
  const m = first.match(/^([a-z]+)(\(([^)]+)\))?(!)?: (.+)$/);
  if (!m) {
    errors.push(`first line must be "<type>(<scope>): <summary>" — got: ${first.slice(0, 80)}`);
  } else {
    const [, type, , scope, , summary] = m;
    if (!TYPES.includes(type)) errors.push(`unknown type "${type}" (allowed: ${TYPES.join(", ")})`);
    if (!scope) warnings.push("no scope — prefer type(scope): (skill or area)");
    if (!summary.trim()) errors.push("empty summary");
    if (summary.trim().endsWith(".")) warnings.push("summary should not end with a period");
    // Bound item ID (unbounded width per control_contract ID numbering).
    const hasItemId = /\b(DEC|W|R|J)-[0-9]{3,}\b|#[0-9]{3,}\b|\bm[0-9]+[a-z0-9-]*\b/.test(first);
    if (!hasItemId) warnings.push("no bound item ID (e.g. [DEC-051] / [W-006 / m6]); required when the change touches a decision, milestone, blueprint, or target-project work");
  }
  // Length is a soft nudge, never a block (avoids CI fragility + false blocks).
  if (first.length > SUBJECT_MAX) warnings.push(`first line ${first.length} > ${SUBJECT_MAX} chars (prefer ≤ ${SUBJECT_MAX})`);
  if (lines.length > 1 && lines[1].trim() !== "") errors.push("missing blank line after the first line");

  // Body must not paste diffs/logs/file dumps (compact handoff).
  const body = lines.slice(2);
  for (const l of body) {
    if (/^(diff --git |@@ |index [0-9a-f]{4,}\.\.|\+\+\+ |--- )/.test(l) || /^[0-9a-f]{40}\b/.test(l)) {
      errors.push(`body looks like a pasted diff/log ("${l.slice(0, 40)}…") — reference a path/SHA instead`);
      break;
    }
  }

  // Garelier marker trailer (commit_convention.md § Garelier marker): every
  // Garelier-produced commit ends with `Garelier: <pm_id> <actor> <item-id>`.
  // WARN, never a hard error: history predates it and CI checks only HEAD, so a
  // warn cannot fail a pre-trailer or non-Garelier plain commit. The pipeline
  // forward-supplies a ready-to-copy template; this surfaces a producer that
  // dropped it. Promotion to a hard error is a future decision (DEC).
  if (!lines.some((l) => /^Garelier:\s+\S+\s+\S+/.test(l))) {
    warnings.push("no `Garelier:` marker trailer (e.g. `Garelier: <pm_id> worker#42 W-006`); required on Garelier-produced commits — see commit_convention.md");
  }

  // Opt-in: --require-seat-trailer promotes a missing/malformed Garelier-Seat
  // trailer to a hard error. Off by default (guardian W-042 finding 2); the
  // Dock passes this flag when validating a commit_mode=proxy dispatch's SHA.
  if (opts.requireSeatTrailer && !lines.some((l) => SEAT_TRAILER_RE.test(l))) {
    errors.push('missing/malformed `Garelier-Seat: codex <model> (proxy-commit via dock seat)` trailer — required by --require-seat-trailer for proxy-committed dispatches');
  }
  return { ok: errors.length === 0, errors, warnings };
}

// classifyTrailer (workshop W-051): which commit trailer shape a message
// carries, for the seat-handover preflight (merge_land.sh) to tell a genuine
// codex-proxy dispatch apart from one where the producer seat handed over to
// a Claude self-commit mid-flight (context.json still says commit_mode=proxy,
// but the LATER commits on the branch carry ordinary self-mode trailers, not
// the proxy `Garelier-Seat:` line). "proxy" wins over "self" when a commit
// somehow carries both (should not happen in practice, but proxy is the
// stricter/more-specific signal). "missing" = neither trailer line present —
// deliberately NOT treated as "self", so a commit that dropped its trailer
// entirely cannot masquerade as evidence of a clean handover.
export function classifyTrailer(msg: string): "proxy" | "self" | "missing" {
  const lines = msg.replace(/\r\n?/g, "\n").split("\n").filter((l) => !l.startsWith("#"));
  if (lines.some((l) => SEAT_TRAILER_RE.test(l))) return "proxy";
  if (lines.some((l) => /^Garelier:\s+\S+\s+\S+/.test(l))) return "self";
  return "missing";
}

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(r.stdout);
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const requireSeatTrailer = rawArgv.includes("--require-seat-trailer");
  const seatSummary = rawArgv.includes("--seat-summary");
  const argv = rawArgv.filter((a) => a !== "--require-seat-trailer" && a !== "--seat-summary");
  if (argv.length === 0) { process.stderr.write("usage: lint_commits.ts <msg-file> | --last [dir] | --range <ref> [dir] | - [--require-seat-trailer] [--seat-summary]\n"); process.exit(2); }
  if (seatSummary && argv[0] !== "--range") {
    process.stderr.write("lint_commits: --seat-summary requires --range <ref> [dir]\n");
    process.exit(2);
  }
  const msgs: { id: string; msg: string }[] = [];
  if (argv[0] === "--last") {
    const dir = argv[1] ?? ".";
    msgs.push({ id: "HEAD", msg: sh(dir, "log", "-1", "--format=%B") });
  } else if (argv[0] === "--range") {
    const ref = argv[1]; const dir = argv[2] ?? ".";
    // --first-parent (W-042 round-3 observer): a bare two-dot range walks BOTH
    // parents of a merge commit, so a base-tracking merge (dispatch_prepare.sh's
    // mandatory "merge the studio tip into your branch" pickup step, DEC-039
    // forward-integration) pulls in unrelated commits that landed on studio via
    // the merge's second parent — lint then false-positives on THEIR trailers.
    // --first-parent walks only the branch's own line of history (the merge
    // commit itself is exempt via isExempt()'s `^Merge ` match either way).
    // The only caller of --range in this repo (merge_land.sh's seat-trailer
    // preflight) wants exactly this — the branch's own commits, not studio's —
    // so this is unconditional, not a new flag.
    const hashes = sh(dir, "log", "--first-parent", "--format=%H", `${ref}..HEAD`).split("\n").filter(Boolean);
    for (const h of hashes) msgs.push({ id: h.slice(0, 9), msg: sh(dir, "log", "-1", "--format=%B", h) });
  } else if (argv[0] === "-") {
    msgs.push({ id: "stdin", msg: await Bun.stdin.text() });
  } else {
    msgs.push({ id: argv[0], msg: await Bun.file(argv[0]).text() });
  }
  if (seatSummary) {
    let proxy = 0, self = 0, missing = 0;
    for (const { msg } of msgs) {
      const c = classifyTrailer(msg);
      if (c === "proxy") proxy++; else if (c === "self") self++; else missing++;
    }
    process.stdout.write(`${JSON.stringify({ total: msgs.length, proxy, self, missing })}\n`);
    process.exit(0);
  }
  let failed = 0;
  for (const { id, msg } of msgs) {
    const r = lintCommitMessage(msg, { requireSeatTrailer });
    for (const w of r.warnings) process.stderr.write(`  [warn] ${id}: ${w}\n`);
    for (const e of r.errors) process.stderr.write(`  [ERROR] ${id}: ${e}\n`);
    if (!r.ok) failed++;
  }
  if (failed > 0) { process.stderr.write(`commit lint: ${failed} message(s) failed\n`); process.exit(1); }
  process.stdout.write(`commit lint: ok (${msgs.length} checked)\n`);
}

if (import.meta.main) main();
