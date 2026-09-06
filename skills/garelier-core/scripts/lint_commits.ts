#!/usr/bin/env bun
import { requireRuntimeExecutable } from "../driver/src/scripts/_lib.ts";
// Commit-message validator (DEC-051, Conventional Commits + bound item ID).
//
// Non-mandatory layer: this is run by Garelier's own pipeline, by the framework
// ci.ts, and by an OPT-IN local commit-msg hook (install_hooks.ts). It is
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
//       is a report merge_land.ts's seat-handover preflight reads, not a gate.
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
// (commit_convention.md / dispatch_prepare.ts COMMIT_RULE). <model> is any
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
  // forward-supplies a ready-to-copy template; this surfaces a role that
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
// carries, for the seat-handover preflight (merge_land.ts) to tell a genuine
// codex-proxy dispatch apart from one where the role seat handed over to
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

// seatDenominatorIncludes (W-692): which commits the --require-seat-trailer /
// --seat-summary denominator covers.
//
// dispatch_prepare_lane_commit_plan.ts proxy-commits with `git commit`, always
// on ONE parent, in the lane checkout. A Dock base-track merge is the other
// shape entirely: TWO parents, created by the coordinator, carrying no proxy
// seat because it never was one. Requiring a seat trailer of it refused four
// correct merges on a downstream project's dispatch #538 (`fc2b98924` / `77e161068` /
// `2f3cdbd98` /
// `07aff85d7`) and made `--seat-trailer checked` a per-land ritual that
// suppressed the check it was meant to prove.
//
// The parent count is a structural git fact, not a reading of the subject: a
// base-track merge written as `chore(base-track): ...` (rather than the default
// `Merge branch ...` that isExempt already skips) is excluded for what it IS,
// and no subject wording can move a single-parent proxy commit out of the
// denominator. PM control commits are already outside it — --range walks
// --first-parent, so studio-side history reached through a merge's second
// parent is never listed.
export function seatDenominatorIncludes(parentCount: number): boolean {
  return parentCount <= 1;
}

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", cwd, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(r.stdout);
}

function shResult(cwd: string, ...args: string[]): { code: number; stdout: string } {
  const r = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", cwd, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, stdout: new TextDecoder().decode(r.stdout) };
}

// A commit message CLAIMS it filed or closed a backlog row when a `W-<digits>`
// item id and "起票" (filed/ticketed) or an English close/closed/closes verb
// appear on the SAME LINE (order-agnostic within that line — real messages
// read both "W-320 ... 起票" and "$ids close (merged ...)"). Same-line, not
// whole-message: an earlier whole-message version false-positived on a body
// line that merely RANGE-references ids ("out of this release's W-054..057
// scope") while the claim verb appeared only in the unrelated subject line.
const ITEM_ID_RE = /\bW-(\d+)\b/g;
const CLAIM_VERB_RE = /(起票|\bclose[sd]?\b)/i;

// Validate schema-3 Backlog commit claims against the bound Garelier trailer
// and canonical Markdown record. Findings stay advisory because claim wording
// remains contextual.
export function checkBacklogRowClaim(dir: string, ref: string, msg: string): string[] {
  const warnings: string[] = [];
  const lines = msg.replace(/\r\n?/g, "\n").split("\n").filter((l) => !l.startsWith("#"));
  const first = lines[0] ?? "";
  if (isExempt(first) && !lines.some((line) => /^Garelier:/.test(line.trim()))) return warnings;
  const ids = new Set<string>();
  for (const line of lines) {
    if (!CLAIM_VERB_RE.test(line)) continue;
    for (const m of line.matchAll(ITEM_ID_RE)) ids.add(`W-${m[1]}`);
  }

  // Schema 3 binds the commit to a canonical Backlog record through its
  // Garelier trailer.
  const trailer = lines.map((line) => line.trim()).find((line) => line.startsWith("Garelier:"));
  const trailerFields = trailer?.match(/^Garelier:\s+(\S+)\s+(\S+)(?:\s+(W-\d+))?\s*$/);
  if (trailerFields) {
    const pmId = trailerFields[1];
    const markerPath = `__garelier/${pmId}/control/control.toml`;
    const marker = shResult(dir, "show", `${ref}:${markerPath}`);
    const schema = marker.code === 0 ? marker.stdout.match(/^\s*schema_version\s*=\s*(\d+)\s*$/m)?.[1] : undefined;
    if (schema === "3") {
      const trailerBacklog = trailerFields[3] ?? "";
      if (!trailerBacklog) {
        warnings.push(`schema-v3 Garelier trailer must end with the bound Backlog ID${ids.size ? ` (expected one of: ${[...ids].join(", ")})` : ""}`);
        return warnings;
      }
      if (ids.size && !ids.has(trailerBacklog)) warnings.push(`schema-v3 trailer binds ${trailerBacklog}, but the commit claim names ${[...ids].join(", ")}`);
      const validatedIds = ids.size ? ids : new Set([trailerBacklog]);
      const backlogRoot = `__garelier/${pmId}/control/backlog`;
      const allBacklog = sh(dir, "ls-tree", "-r", "--name-only", ref, "--", backlogRoot).split(/\r?\n/).filter(Boolean);
      for (const id of validatedIds) {
        const paths = allBacklog.filter((path) => new RegExp(`/${id}(?:-[^/]*)?\\.md$`).test(path));
        if (paths.length !== 1) {
          warnings.push(`schema-v3 commit claims ${id}, but expected exactly one canonical Backlog record at ${ref} (found ${paths.length})`);
          continue;
        }
        const source = shResult(dir, "show", `${ref}:${paths[0]}`).stdout;
        if (!source.startsWith("+++\n")
          || !/^\s*schema_version\s*=\s*3\s*$/m.test(source)
          || !/^\s*kind\s*=\s*"garelier_backlog"\s*$/m.test(source)
          || !new RegExp(`^\\s*id\\s*=\\s*"${id}"\\s*$`, "m").test(source)) {
          warnings.push(`schema-v3 canonical Backlog record identity is invalid for ${id}: ${paths[0]}`);
        }
        const diff = ids.size ? sh(dir, "show", "--format=", "--unified=0", ref, "--", ...paths) : "";
        if (ids.size && !diff.includes(paths[0])) {
          warnings.push(`commit message claims 起票/close of ${id} but the diff does not touch its canonical schema-v3 Backlog record`);
        }
      }
      return warnings;
    }
    if (schema) {
      warnings.push(`Garelier control declares unsupported schema_version ${schema}; only schema_version 3 is accepted`);
      return warnings;
    }
  }

  if (!trailerFields && ids.size > 0) {
    const markerPaths = sh(dir, "ls-tree", "-r", "--name-only", ref, "--", "__garelier")
      .split(/\r?\n/).filter((path) => /^__garelier\/[^/]+\/control\/control\.toml$/.test(path));
    const v3Namespaces = markerPaths.flatMap((path) => {
      const marker = shResult(dir, "show", `${ref}:${path}`);
      if (marker.code !== 0 || !/^\s*schema_version\s*=\s*3\s*$/m.test(marker.stdout)) return [];
      return [path.split("/")[1]];
    });
    if (v3Namespaces.length > 0) {
      warnings.push("schema-v3 Backlog claim has no parseable `Garelier: <pm_id> <actor> <W-id>` trailer");
      return warnings;
    }
  }

  return warnings;
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
  // `diffRef` is set ONLY when there is a real, already-made commit to diff
  // (--last / --range) — the backlog-row-claim check (below) needs an actual
  // diff, unlike the shape-only lintCommitMessage rules, so a commit-msg-hook
  // invocation (a msg-file path, or "-"/stdin, both pre-commit) skips it.
  // `parents` (W-692) is the seat-trailer denominator input; see
  // seatDenominatorIncludes. A pre-commit invocation (msg file / stdin) has no
  // commit to count parents on and is treated as the single-parent case, which
  // is what a commit-msg hook is about to create.
  const msgs: { id: string; msg: string; dir?: string; diffRef?: string; parents?: number }[] = [];
  const parentCount = (dir: string, ref: string): number =>
    sh(dir, "log", "-1", "--format=%P", ref).trim().split(/\s+/).filter(Boolean).length;
  if (argv[0] === "--last") {
    const dir = argv[1] ?? ".";
    msgs.push({ id: "HEAD", msg: sh(dir, "log", "-1", "--format=%B"), dir, diffRef: "HEAD", parents: parentCount(dir, "HEAD") });
  } else if (argv[0] === "--range") {
    const ref = argv[1]; const dir = argv[2] ?? ".";
    // --first-parent (W-042 round-3 observer): a bare two-dot range walks BOTH
    // parents of a merge commit, so a base-tracking merge (dispatch_prepare.ts's
    // mandatory "merge the studio tip into your branch" pickup step, DEC-039
    // forward-integration) pulls in unrelated commits that landed on studio via
    // the merge's second parent — lint then false-positives on THEIR trailers.
    // --first-parent walks only the branch's own line of history (the merge
    // commit itself is exempt via isExempt()'s `^Merge ` match either way).
    // The only caller of --range in this repo (merge_land.ts's seat-trailer
    // preflight) wants exactly this — the branch's own commits, not studio's —
    // so this is unconditional, not a new flag.
    const hashes = sh(dir, "log", "--first-parent", "--format=%H", `${ref}..HEAD`).split("\n").filter(Boolean);
    for (const h of hashes) {
      msgs.push({ id: h.slice(0, 9), msg: sh(dir, "log", "-1", "--format=%B", h), dir, diffRef: h, parents: parentCount(dir, h) });
    }
  } else if (argv[0] === "-") {
    msgs.push({ id: "stdin", msg: await Bun.stdin.text() });
  } else {
    msgs.push({ id: argv[0], msg: await Bun.file(argv[0]).text() });
  }
  // One denominator, both consumers (W-692): the handover report and the
  // requirement must count the same commits, or a branch carrying base-track
  // merges reports total > self and never reaches the handover branch it
  // qualifies for.
  const seatMsgs = msgs.filter(({ parents }) => seatDenominatorIncludes(parents ?? 0));
  if (seatSummary) {
    let proxy = 0, self = 0, missing = 0;
    for (const { msg } of seatMsgs) {
      const c = classifyTrailer(msg);
      if (c === "proxy") proxy++; else if (c === "self") self++; else missing++;
    }
    process.stdout.write(`${JSON.stringify({ total: seatMsgs.length, proxy, self, missing })}\n`);
    process.exit(0);
  }
  let failed = 0;
  for (const { id, msg, dir, diffRef, parents } of msgs) {
    const r = lintCommitMessage(msg, {
      requireSeatTrailer: requireSeatTrailer && seatDenominatorIncludes(parents ?? 0),
    });
    const rowClaimWarnings = dir && diffRef ? checkBacklogRowClaim(dir, diffRef, msg) : [];
    for (const w of [...r.warnings, ...rowClaimWarnings]) process.stderr.write(`  [warn] ${id}: ${w}\n`);
    for (const e of r.errors) process.stderr.write(`  [ERROR] ${id}: ${e}\n`);
    if (!r.ok) failed++;
  }
  if (failed > 0) { process.stderr.write(`commit lint: ${failed} message(s) failed\n`); process.exit(1); }
  process.stdout.write(`commit lint: ok (${msgs.length} checked)\n`);
}

if (import.meta.main) main();
