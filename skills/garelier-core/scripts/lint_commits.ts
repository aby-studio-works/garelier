#!/usr/bin/env bun
// Commit-message validator (DEC-051, Conventional Commits + bound item ID).
//
// Non-mandatory layer: this is run by Garelier's own pipeline, by the framework
// ci.sh, and by an OPT-IN local commit-msg hook (install_hooks.{sh,ps1}). It is
// never a repo-global hook or a shared-CI gate in a target project, so it cannot
// break a non-Garelier contributor's plain `git commit`.
//
// Usage:
//   bun lint_commits.ts <commit-msg-file>     # git commit-msg hook passes the path
//   bun lint_commits.ts --last [<dir>]        # validate HEAD's message (ci)
//   bun lint_commits.ts --range <gitref> [<dir>]   # validate a..HEAD (ci)
//   echo "<msg>" | bun lint_commits.ts -      # stdin
// Exit 0 = pass, 1 = violations (printed), 2 = usage error.

const TYPES = ["feat", "fix", "refactor", "docs", "test", "chore", "build", "ci", "perf", "revert"];
const SUBJECT_MAX = 72;

// Auto-generated / tooling messages we never gate.
function isExempt(first: string): boolean {
  return /^(Merge |Revert "|fixup!|squash!|Reapply )/.test(first) || first.trim() === "";
}

export interface LintResult { ok: boolean; errors: string[]; warnings: string[] }

// Validate ONE commit message. Shape errors hard-fail; context-dependent rules
// (scope, bound item ID) warn — the message alone can't always prove they apply.
export function lintCommitMessage(msg: string): LintResult {
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
  return { ok: errors.length === 0, errors, warnings };
}

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(r.stdout);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { process.stderr.write("usage: lint_commits.ts <msg-file> | --last [dir] | --range <ref> [dir] | -\n"); process.exit(2); }
  const msgs: { id: string; msg: string }[] = [];
  if (argv[0] === "--last") {
    const dir = argv[1] ?? ".";
    msgs.push({ id: "HEAD", msg: sh(dir, "log", "-1", "--format=%B") });
  } else if (argv[0] === "--range") {
    const ref = argv[1]; const dir = argv[2] ?? ".";
    const hashes = sh(dir, "log", "--format=%H", `${ref}..HEAD`).split("\n").filter(Boolean);
    for (const h of hashes) msgs.push({ id: h.slice(0, 9), msg: sh(dir, "log", "-1", "--format=%B", h) });
  } else if (argv[0] === "-") {
    msgs.push({ id: "stdin", msg: await Bun.stdin.text() });
  } else {
    msgs.push({ id: argv[0], msg: await Bun.file(argv[0]).text() });
  }
  let failed = 0;
  for (const { id, msg } of msgs) {
    const r = lintCommitMessage(msg);
    for (const w of r.warnings) process.stderr.write(`  [warn] ${id}: ${w}\n`);
    for (const e of r.errors) process.stderr.write(`  [ERROR] ${id}: ${e}\n`);
    if (!r.ok) failed++;
  }
  if (failed > 0) { process.stderr.write(`commit lint: ${failed} message(s) failed\n`); process.exit(1); }
  process.stdout.write(`commit lint: ok (${msgs.length} checked)\n`);
}

if (import.meta.main) main();
