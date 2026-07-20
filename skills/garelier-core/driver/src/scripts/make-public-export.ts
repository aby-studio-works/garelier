#!/usr/bin/env bun
//
// Make a publishable, HISTORY-FREE export of the Garelier framework.
//
// Why: the development repo's git history and commit authors carry personal
// info (author email, pre-genericization diffs). Rather than rewrite history,
// this exports the CURRENT tracked tree as a single commit with a neutral
// author into a fresh directory — so the published repo has no history to leak.
//
// It refuses to export if, in the to-be-published tree, it finds: a secret, a
// real email, a private identifier (the project name / a dev handle), a leftover
// personal-or-other-project term, or a reference/link INTO the excluded
// __garelier/ tree (which would become a dead link after publish). The repo's
// own self-PM dashboard (__garelier/) is excluded by default — it is dogfooding
// state, not part of the distributed framework — so scans for things that should
// not LEAVE the repo only inspect the publish set.
//
// Usage:
//   skills/garelier-core/driver/src/scripts/make-public-export.ts <dest-dir> [author-name] [author-email]
//
// Example:
//   skills/garelier-core/driver/src/scripts/make-public-export.ts /tmp/garelier-public "Garelier" "noreply@example.com"
//
// TS port (W-083). CLI-frozen twin of the former bash script: the shim
// skills/garelier-core/driver/src/scripts/make-public-export.ts sets GARELIER_EXPORT_ROOT to the repo root
// (its own location) and execs this. ROOT falls back to this file's own
// repo-relative location so a direct `bun make-public-export.ts` still works.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run, runBash, git, die, shellQuote } from "./_lib.ts";

// ROOT: the shim exports GARELIER_EXPORT_ROOT from its own location (== the old
// `dirname "$0"/..`); a direct invocation falls back to this file's fixed
// repo-relative home (skills/garelier-core/driver/src/scripts/ -> 5 up).
const ROOT =
  process.env.GARELIER_EXPORT_ROOT && process.env.GARELIER_EXPORT_ROOT !== ""
    ? resolve(process.env.GARELIER_EXPORT_ROOT)
    : resolve(import.meta.dir, "..", "..", "..", "..", "..");

const argv = process.argv.slice(2);
const DEST = argv[0];
if (DEST === undefined || DEST === "") {
  // Match the former `${1:?usage…}` bash behaviour: exit status 1.
  die("usage: make-public-export.ts <dest-dir> [author-name] [author-email]", 1);
}
const AUTHOR_NAME = argv[1] && argv[1] !== "" ? argv[1] : "Garelier";
const AUTHOR_EMAIL = argv[2] && argv[2] !== "" ? argv[2] : "noreply@example.com";

let VERSION = "0.0.0";
try {
  const v = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  if (v !== "") VERSION = v;
} catch {
  /* default 0.0.0 */
}

const TEST_FIXTURE = ":(exclude)*.test.ts";

// Operate from ROOT so a relative DEST resolves against it (the old script did
// `cd "$ROOT"` before touching DEST).
process.chdir(ROOT);

// This gate file itself is excluded from the private-identifier / dead-link
// scans: like the former .ts, it necessarily spells the deny terms and the
// __garelier/ path patterns as code. Its repo-relative path is fixed.
const SELF = "skills/garelier-core/driver/src/scripts/make-public-export.ts";

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

out("==> Publish gate: scanning tracked tree for sensitive content");
let fail = 0;
function note(title: string, body: string): void {
  out("");
  out(`  !! ${title}`);
  for (const line of body.split("\n")) out(`     ${line}`);
  fail = 1;
}

// git grep helper: returns matching lines (stdout); exit 1 (no match) and any
// error are treated as empty, matching the old `2>/dev/null || true`.
function grepLines(pattern: string, pathspecs: string[], flags = "-nIE"): string {
  const r = git(ROOT, ["grep", flags, pattern, "--", ...pathspecs], { stderr: "ignore" });
  return r.stdout.replace(/\n$/, "");
}

// 1. Secret-shaped strings. Known redact()-test dummies are excluded so the
//    secret-redaction tests don't trip the gate; everything else is fatal.
{
  const raw = grepLines(
    "AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{20,}",
    [".", ":(exclude)*.test.ts"],
  );
  // AKIAIOSFODNN7EXAMPLE is AWS's published, non-functional documentation example
  // key, used here only as a scanner test fixture — allowlisted like the example
  // emails below (genuine false positive, not a real secret).
  const secrets = raw
    .split("\n")
    .filter((l) => l !== "" && !l.includes("AKIAIOSFODNN7EXAMPLE"))
    .join("\n");
  if (secrets) note("secret-shaped strings found:", secrets);
}

// 2. Real email addresses (generic/example/reserved-domain/noreply ones are fine).
{
  const raw = grepLines("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", [".", TEST_FIXTURE]);
  const allow = /example\.(com|org)|@[A-Za-z0-9.-]+\.(?:invalid|test|example)(?![A-Za-z0-9.-])|noreply|anthropic|@ci|ci@ci|your-?(domain|email)|@company|@host|@garelier|@</i;
  const emails = raw
    .split("\n")
    .filter((l) => l !== "" && !allow.test(l))
    .join("\n");
  if (emails) note("non-generic email addresses found:", emails);
}

// 3. Optional project-local deny regex for private identifiers. Keep the regex
//    outside this repo so the gate does not itself leak the terms it checks.
{
  const deny = process.env.GARELIER_PUBLIC_EXPORT_DENY_RE;
  if (deny && deny !== "") {
    const terms = grepLines(deny, ["."], "-nIiE");
    if (terms) note("leftover personal/other-project terms found:", terms);
  } else {
    out("  (no GARELIER_PUBLIC_EXPORT_DENY_RE set; skipped custom private-term scan)");
  }
}

// Scans 4 and 5 inspect only the PUBLISH SET (the tree the export below ships):
// the __garelier/ dogfooding tree is excluded at export time, so references to it
// and private terms that live only inside it are not published and not our concern
// here. They scope with the same ':(exclude)__garelier' pathspec git archive uses.
const PUB = ":(exclude)__garelier";

// 4. Built-in private-identifier deny (always on; complements the optional regex
//    above). Catches bare developer usernames and the private project name that
//    are not email-shaped — case-insensitive SUBSTRING match (NOT whole-word):
//    a whole-word matcher false-negatives on underscore-joined identifiers like
//    a private-name token joined with an underscore (the underscore is a word
//    char, so a whole-word token never ends on a word boundary and slips
//    through). These deny tokens never appear
//    legitimately in the framework, so a substring match has no real false
//    positives and closes the underscore-evasion hole.
//    This gate file itself is excluded ($SELF): it necessarily spells the deny
//    terms as code, like section 1 excludes its own secret-redaction dummies.
{
  const builtinPattern = ["sut", "ure|rifu"].join("");
  const builtin = grepLines(builtinPattern, [".", PUB, `:(exclude)${SELF}`], "-nIiE");
  if (builtin) {
    note("private identifiers (project name / dev handle) found in a to-be-published file:", builtin);
  }
}

// 5. Link-check: a published file must not reference/link INTO the excluded
//    __garelier/ tree (those become dead links in the public repo). Catches
//    markdown links '](__garelier/', the dogfood pm_id '__garelier/_workshop',
//    and concrete '__garelier/<id>/control' paths. The framework legitimately
//    documents the '__garelier/<pm_id>/' CONCEPT, so the placeholder '<pm_id>'
//    form is intentionally not matched — only concrete paths into the tree are.
//    This gate file is excluded ($SELF): it spells the path patterns as code.
{
  const deadlinks = grepLines(
    "\\]\\(__garelier/|__garelier/_workshop|__garelier/[A-Za-z0-9_-]+/control",
    [".", PUB, TEST_FIXTURE, `:(exclude)${SELF}`],
  );
  if (deadlinks) {
    note(
      "references/links into the EXCLUDED __garelier/ tree (dead links after publish — fix these before export):",
      deadlinks,
    );
  }
}

// 6. Repo-root allowlist (W-092). git archive below ships EVERY root entry (it
//    drops only __garelier/). A stray file left at the repo root therefore
//    mirrors straight to the public repo — the W-092 incident, where producer
//    reports (W-035/W-038-REPORT.md) placed at root were published in v2.11.0/1.
//    Only a KNOWN set of root entries may publish; any other top-level entry is
//    a hard FAIL, never a silent skip (a silent drop would make the next such
//    leak undetectable — the whole point of the incident). Extend ALLOWED_ROOT
//    deliberately if a genuinely new root artifact is added to the framework.
const ALLOWED_ROOT = new Set([
  ".claude-plugin",
  ".github",
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.ja.md",
  "VERSION",
  "assets",
  "bin",
  "docs",
  "scripts",
  "skills",
]);
{
  const tracked = git(ROOT, ["ls-files", "--", ".", PUB], { stderr: "ignore" }).stdout;
  const roots = new Set<string>();
  for (const line of tracked.split("\n")) {
    if (line === "") continue;
    roots.add(line.split("/")[0]);
  }
  const strays = [...roots].filter((r) => !ALLOWED_ROOT.has(r)).sort().join("\n");
  if (strays) {
    note(
      "unrecognized repo-root entrie(s) in the publish set — not in the export allowlist; a stray here mirrors to the public repo (W-092). Move it under __garelier/<pm>/ (dev-only), delete it, or extend ALLOWED_ROOT if it is a legitimate new framework artifact:",
      strays,
    );
  }
}

// 7. Producer report files never publish (W-092). Producer/worker report dumps
//    (*-REPORT.md) are dev-side artifacts that carried operational model-fallback
//    chatter (e.g. "Sonnet fallback / Codex attempt") in the incident. The root
//    allowlist (6) stops one left at the ROOT; this also catches one committed
//    into an allowlisted SUBDIR (docs/, skills/, …), which the root-only check
//    would miss. Model-name tokens (Sonnet/Opus/Haiku/Fable/Codex/gpt-N) are
//    legitimately discussed throughout the framework's own docs — it openly
//    supports Claude Code + Codex CLI and documents model tiers — so the
//    model-name scan is deliberately SCOPED to this must-never-publish file
//    class rather than run blanket over all docs (a blanket scan would
//    false-positive on CHANGELOG/AGENTS/references and break every real export).
{
  const listed = git(ROOT, ["ls-files", "--", ".", PUB], { stderr: "ignore" }).stdout;
  const reportRe = /(^|\/)[^/]+-report\.md$/i;
  const reportFiles = listed.split("\n").filter((f) => f !== "" && reportRe.test(f));
  if (reportFiles.length > 0) {
    let chatter = "";
    for (const f of reportFiles) {
      const hit = grepLines("\\b(sonnet|opus|haiku|fable|codex)\\b|gpt-[0-9]", [f], "-nIiE");
      if (hit) chatter += (chatter ? "\n" : "") + hit;
    }
    let detail = reportFiles.join("\n");
    if (chatter) {
      detail = `${reportFiles.join("\n")}\n-- model-name chatter within them (must not leave the repo):\n${chatter}`;
    }
    note(
      "producer report file(s) in the publish set — dev-only artifacts that must never publish; move under __garelier/<pm>/ or delete before export (W-092):",
      detail,
    );
  }
}

if (fail !== 0) {
  out("");
  out("ABORT: sensitive content in the tracked tree — not exporting.");
  out("Fix the findings above (or extend the allowlist if they are genuine");
  out("false positives) and re-run.");
  process.exit(1);
}
out("  ok (no secrets / real emails / private identifiers / leftover terms / dead links into __garelier/)");

// Refuse to clobber a non-empty destination.
if (existsSync(DEST)) {
  let entries: string[] = [];
  try {
    entries = readdirSync(DEST);
  } catch {
    entries = [];
  }
  if (entries.length > 0) {
    err(`ABORT: destination '${DEST}' exists and is not empty.`);
    process.exit(1);
  }
}
mkdirSync(DEST, { recursive: true });

out("==> Exporting tracked tree (excluding __garelier/ dogfooding state)");
// git archive emits only tracked files; the pathspec drops the self-PM tree.
// The archive|tar pipeline moves a binary tar stream, so run it through bash
// verbatim (contract §5: composite pipelines route to bash.exe).
{
  // Git Bash accepts C:/... but a native C:\\... path loses backslashes while
  // bash parses the command string. Quote after normalizing so direct Windows
  // callers (including release.ts's temporary export) are safe and portable.
  const archiveDest = shellQuote(DEST.replaceAll("\\", "/"));
  const cmd = `git archive --format=tar HEAD -- . ':(exclude)__garelier' | tar -x -C ${archiveDest}`;
  const r = runBash(["-c", cmd], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode || 1);
}

// W-068 note: this export writes its OWN single commit with a neutral author,
// so development-side commit trailers (AI co-author lines, session URLs) can
// never leak through THIS path. The second path — a direct commit on the
// public clone — is guarded by machine-local commit-msg/pre-push hooks there
// (see the workshop public_release_runbook.md, W-068).
out("==> Initializing a single-commit history with a neutral author");
// W-060: Windows filesystems carry no executable bit, so `git add -A` in the
// fresh export repo records EVERY file as 100644 — all ~57 executables (each
// .ts + bin/garelier) shipped 100755->100644 in v2.11.3 and the public CI's
// executable-bit check went red on main + the tag. The DEV index is the truth
// for modes: collect every path staged 100755 there and re-apply the bit in the
// export index before committing.
function executablePaths(repo: string): string[] {
  const staged = git(repo, ["ls-files", "-s", "-z"], { stderr: "ignore" }).stdout;
  const paths: string[] = [];
  for (const entry of staged.split("\0")) {
    if (entry === "") continue;
    // format: "<mode> <hash> <stage>\t<path>"; -z keeps unusual file names
    // unambiguous and lets this compare the index rather than filesystem modes.
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const mode = entry.slice(0, entry.indexOf(" "));
    const path = entry.slice(tab + 1);
    if (mode === "100755" && !path.startsWith("__garelier/")) paths.push(path);
  }
  return paths.sort();
}

const execList = executablePaths(ROOT);

{
  const destAbs = resolve(ROOT, DEST);
  const dgit = (args: string[], opts = {}) => git(destAbs, args, { stderr: "ignore", ...opts });
  if (git(destAbs, ["init", "-q"]).exitCode !== 0) {
    err("ABORT: git init failed in destination");
    process.exit(1);
  }
  git(destAbs, ["symbolic-ref", "HEAD", "refs/heads/main"], { stderr: "ignore" });
  dgit(["add", "-A"]);
  // W-060: propagate the dev-index executable bit (see execList above).
  if (execList.length > 0) {
    let applied = 0;
    for (const f of execList) {
      if (git(destAbs, ["ls-files", "--error-unmatch", "--", f], { stderr: "ignore" }).exitCode === 0) {
        if (git(destAbs, ["update-index", "--chmod=+x", "--", f], { stderr: "ignore" }).exitCode === 0) {
          applied += 1;
        }
      }
    }
    out(`==> Restored the executable bit on ${applied} exported file(s) from the dev index (W-060)`);
  }
  // W-110 self-check: compare the full dev/export 100755 sets before commit.
  // This is deliberately not a `.ts`/`bin` heuristic: any future executable is
  // covered, and the check reads Git's index on both sides so Windows working
  // tree mode reporting cannot make a false green.
  {
    const exported = executablePaths(destAbs);
    const missing = execList.filter((path) => !exported.includes(path));
    const unexpected = exported.filter((path) => !execList.includes(path));
    if (missing.length > 0 || unexpected.length > 0) {
      err("ABORT: exported 100755 set differs from the dev index (W-110):");
      for (const path of missing) err(`  missing +x: ${path}`);
      for (const path of unexpected) err(`  unexpected +x: ${path}`);
      process.exit(1);
    }
    out(`==> Export mode self-check passed: ${execList.length} dev 100755 path(s) exactly match export index (W-110)`);
  }
  // Conventional-commits compliant so the published repo's own ci.ts commit
  // lint (lint_commits.ts --last) passes on the first public CI run.
  const commit = git(
    destAbs,
    ["-c", `user.name=${AUTHOR_NAME}`, "-c", `user.email=${AUTHOR_EMAIL}`, "commit", "-qm", `chore(release): Garelier v${VERSION}`],
    { stderr: "inherit" },
  );
  if (commit.exitCode !== 0) process.exit(commit.exitCode || 1);
}

out("");
out("===================================================================");
out(`Exported a clean, history-free Garelier v${VERSION} to:`);
out(`  ${DEST}`);
out(`  (single commit, author: ${AUTHOR_NAME} <${AUTHOR_EMAIL}>)`);
out("===================================================================");
out("Next: review it, then publish from there (e.g. add a public remote and");
out("push). The development repo's history (with personal info) stays local.");
