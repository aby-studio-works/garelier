#!/usr/bin/env bun
import { rmSync, configurePathGuardRoots } from "../guard/path_guard.ts";
// Attended public-release pipeline (W-110).  This deliberately makes a public
// tag impossible until the pushed public main commit has a green GitHub Actions
// run: v2.13.0 demonstrated that tagging before CI creates a public false green.

import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git, run, runBash, die, printHelp, shellQuote, resolveCommand } from "./_lib.ts";

const ROOT = process.env.GARELIER_RELEASE_ROOT && process.env.GARELIER_RELEASE_ROOT !== ""
  ? resolve(process.env.GARELIER_RELEASE_ROOT)
  : resolve(import.meta.dir, "..", "..", "..", "..", "..");
const EXPORT = join(ROOT, "skills", "garelier-core", "driver", "src", "scripts", "make-public-export.ts");

type Config = { publishRepo?: string; githubRepo?: string };
type Options = { publishRepo: string; githubRepo: string; yes: boolean; dryRun: boolean; config: string };

const HELP = `Usage: skills/garelier-core/driver/src/scripts/release.ts --publish-repo <path> [options]

Creates a history-free public release from VERSION and CHANGELOG.md.

Options:
  --publish-repo <path>  Existing clean public clone (or GARELIER_PUBLISH_REPO)
  --repo <owner/name>    GitHub repository (or config githubRepo)
  --config <file>        JSON config: {"publishRepo":"...","githubRepo":"..."}
  --dry-run              Validate export, source inputs, and public clone; write nothing persistent
  --yes                  Skip attended confirmations before push, tag, and release creation
  -h, --help             Show this help
`;

function parse(): Options {
  let publishRepo = process.env.GARELIER_PUBLISH_REPO ?? "";
  let githubRepo = process.env.GARELIER_PUBLISH_REPO_SLUG ?? "";
  let yes = false;
  let dryRun = false;
  let config = "";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--publish-repo") publishRepo = argv[++i] ?? "";
    else if (arg === "--repo") githubRepo = argv[++i] ?? "";
    else if (arg === "--config") config = argv[++i] ?? "";
    else if (arg === "--yes") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "-h" || arg === "--help") printHelp(HELP);
    else die(`release: unknown argument '${arg}'\n${HELP}`);
  }
  if (config) {
    let parsed: Config;
    try { parsed = JSON.parse(readFileSync(resolve(config), "utf8")) as Config; }
    catch (error) { die(`release: cannot read JSON config '${config}': ${String(error)}`); }
    publishRepo ||= parsed.publishRepo ?? "";
    githubRepo ||= parsed.githubRepo ?? "";
  }
  if (!publishRepo) die("release: --publish-repo (or GARELIER_PUBLISH_REPO/config publishRepo) is required");
  return { publishRepo: resolve(publishRepo), githubRepo, yes, dryRun, config };
}

function failCommand(label: string, result: ReturnType<typeof run>): never {
  const detail = (result.stderr || result.stdout).trim();
  die(`ABORT: ${label}${detail ? `\n${detail}` : ""}`, result.exitCode || 1);
}
function must(label: string, command: string[], cwd?: string): ReturnType<typeof run> {
  const result = run(command, { cwd });
  if (result.exitCode !== 0) failCommand(label, result);
  return result;
}
function mustGit(label: string, repo: string, args: string[]): ReturnType<typeof run> {
  const result = git(repo, args);
  if (result.exitCode !== 0) failCommand(label, result);
  return result;
}
function status(repo: string): string {
  return mustGit("cannot inspect git status", repo, ["status", "--porcelain"]).stdout.trim();
}
function executablePaths(repo: string): string[] {
  return mustGit("cannot read executable modes", repo, ["ls-files", "-s", "-z"]).stdout
    .split("\0")
    .flatMap((entry) => {
      const tab = entry.indexOf("\t");
      return tab >= 0 && entry.startsWith("100755 ") ? [entry.slice(tab + 1)] : [];
    })
    .sort();
}
function changelogSection(version: string): string {
  const text = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[${escaped}\\].*$`, "m").exec(text);
  if (!heading || heading.index === undefined) die(`ABORT: CHANGELOG.md has no section for [${version}]`);
  const after = heading.index + heading[0].length;
  const next = /^## /m.exec(text.slice(after));
  return text.slice(heading.index, next ? after + next.index : text.length).trimEnd() + "\n";
}
function confirm(action: string, options: Options): void {
  if (options.yes) {
    console.log(`--yes: confirmed ${action}`);
    return;
  }
  const question = `Proceed with ${action}? [y/N] `;
  const response = runBash(["-c", `read -r -p ${shellQuote(question)} answer; [[ "$answer" =~ ^[Yy]$ ]]`], { stdout: "inherit", stderr: "inherit" });
  if (response.exitCode !== 0) die(`ABORT: ${action} was not confirmed`, 1);
}
export function removeStaleTrackedFiles(publicRepo: string, exportRepo: string): void {
  // W-114: the publish clone is a SIBLING of the dev repo, so it is not covered by
  // path_guard's default fence roots (cwd / nearest repo root / tmp). Register the
  // resolved publish repo as a stable trusted root so this script's OWN cleanup of
  // its stale tracked files is not self-denied. Scope-limited to this one root —
  // path_guard's `.git` and shallow/traversal protections are untouched, and the
  // per-path traversal guard below still runs.
  configurePathGuardRoots([publicRepo]);
  const exported = new Set(mustGit("cannot list export files", exportRepo, ["ls-files", "-z"]).stdout.split("\0").filter(Boolean));
  const publicFiles = mustGit("cannot list public files", publicRepo, ["ls-files", "-z"]).stdout.split("\0").filter(Boolean);
  for (const path of publicFiles) {
    if (exported.has(path)) continue;
    // Git supplies normalized tracked paths; still reject traversal before an
    // attended release mutates the public clone.
    if (path === ".git" || path.startsWith(".git/") || path.includes("..") || path.startsWith("/")) {
      die(`ABORT: unsafe tracked path while syncing public repo: ${path}`);
    }
    rmSync(join(publicRepo, path), { recursive: true, force: true });
  }
}

/** W-114: sync `exportDir`'s tree into `publishRepo` via a tar STREAM.
 *
 * The archive is piped create.stdout -> extract.stdin (no archive file on disk),
 * and each tar chdirs through its spawn `cwd` (a real OS chdir) while operating on
 * the relative operand `.`. This keeps every Windows drive-letter / backslash path
 * OUT of tar's argv — which is essential because GNU tar (Git Bash /usr/bin/tar,
 * what `resolveCommand("tar")` picks on the release host) breaks on both forms:
 *   - a `-f C:\…` argument is parsed as a remote `[user@]host:file` (the drive
 *     letter becomes the host): "Cannot connect to C: resolve failed";
 *   - a `-C C:\…\dir` argument has its backslashes swallowed as escapes, so the
 *     chdir SILENTLY fails and extract writes NOTHING — the deletions-only sync
 *     that gutted the public tree (W-114 run: publish commit was 73 deletions,
 *     0 additions). The earlier argv form (`-C <abs>` + relative `-f`) was clean
 *     to eyeball but still hit the `-C` backslash failure — proving an argv pin
 *     cannot catch this class; only a filesystem round-trip can.
 * bsdtar (System32 tar.exe) has neither misfeature, so a cwd + `.` + `-f -` form
 * is portable across both tars and both OSes. Throws (die) on any tar failure or
 * an empty archive. Exported for the round-trip regression test. */
export function syncTreeViaTar(exportDir: string, publishRepo: string): void {
  const createCmd = resolveCommand(["tar", "-cf", "-", "--exclude=.git", "."]);
  const extractCmd = resolveCommand(["tar", "-xf", "-"]);
  if (!createCmd || !extractCmd) return die("release: tar not found on PATH");
  const created = Bun.spawnSync(createCmd, {
    cwd: exportDir, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  if (created.exitCode !== 0) return die(`release: tar create failed: ${created.stderr?.toString().trim() ?? ""}`);
  const archive = created.stdout;
  if (!archive || archive.byteLength === 0) {
    return die("release: tar create produced an empty archive — refusing an empty public sync");
  }
  const extracted = Bun.spawnSync(extractCmd, {
    cwd: publishRepo, stdin: archive, stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  if (extracted.exitCode !== 0) return die(`release: tar extract failed: ${extracted.stderr?.toString().trim() ?? ""}`);
}

/** W-114 post-sync sanity: confirm the extract actually MATERIALIZED the export
 * tree in the publish clone. A silently no-op extract (the GNU-tar backslash-`-C`
 * failure) leaves `publishRepo` missing the export's files while removeStale has
 * already deleted the stale ones — a commit that is deletions-only. Verify every
 * top-level export entry (except `.git`) now exists under `publishRepo`. Throws on
 * the first missing entry; the CLI turns that into an ABORT. Exported for the
 * deletions-only regression test (reproduces the gutted-tree publish commit). */
export function assertSyncMaterialized(exportDir: string, publishRepo: string): void {
  for (const entry of readdirSync(exportDir)) {
    if (entry === ".git") continue;
    if (!existsSync(join(publishRepo, entry))) {
      throw new Error(
        `public sync did not materialize '${entry}' in the publish clone — the tar extract wrote nothing (W-114 deletions-only guard)`,
      );
    }
  }
}

if (import.meta.main) {
const options = parse();
if (!existsSync(EXPORT)) die(`release: export script not found: ${EXPORT}`);
if (!existsSync(options.publishRepo)) die(`release: publish repo does not exist: ${options.publishRepo}`);
mustGit("publish repo is not a Git worktree", options.publishRepo, ["rev-parse", "--is-inside-work-tree"]);
const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) die(`release: VERSION is not a release version: '${version}'`);
const tag = `v${version}`;
const notes = changelogSection(version);
const branch = mustGit("cannot read public branch", options.publishRepo, ["branch", "--show-current"]).stdout.trim();
if (branch !== "main") die(`ABORT: public clone must be on main, found '${branch || "detached HEAD"}'`);
if (status(options.publishRepo) !== "") die("ABORT: public clone is dirty; recover or commit it before release");

const temp = mkdtempSync(join(tmpdir(), "garelier-release-"));
const exportDir = join(temp, "export");
const notesFile = join(temp, `release-notes-${tag}.md`);
try {
  console.log(`==> Release ${tag}: validating history-free export`);
  must("public export failed", ["bun", EXPORT, exportDir], ROOT);
  const exportModes = executablePaths(exportDir);
  if (options.dryRun) {
    const devDirty = status(ROOT);
    if (devDirty) console.log("DRY-RUN note: development worktree is dirty; a real release will refuse it.");
    console.log(`DRY-RUN: version=${version}; changelog section found; export mode self-check passed (${exportModes.length} executable path(s)).`);
    console.log(`DRY-RUN: would sync '${exportDir}' to '${options.publishRepo}' via tar --exclude=.git.`);
    console.log("DRY-RUN: would commit the public sync, prompt before push main, then gh run watch --exit-status for that main SHA.");
    console.log(`DRY-RUN: only after green CI, would prompt before git tag -a ${tag}, tag push, and gh release create using extracted CHANGELOG notes.`);
    process.exit(0);
  }
  if (status(ROOT) !== "") die("ABORT: development worktree is dirty; release only committed source");

  console.log("==> Syncing export to public clone (tar stream --exclude=.git)");
  removeStaleTrackedFiles(options.publishRepo, exportDir);
  syncTreeViaTar(exportDir, options.publishRepo);
  // W-114: fail LOUD if the extract wrote nothing, before staging — never commit a
  // gutted (deletions-only) public tree.
  try {
    assertSyncMaterialized(exportDir, options.publishRepo);
  } catch (e) {
    die(`ABORT: ${(e as Error).message}. Refusing to commit a gutted public tree.`);
  }
  mustGit("cannot stage public sync", options.publishRepo, ["add", "-A"]);
  for (const path of exportModes) mustGit(`cannot restore +x on ${path}`, options.publishRepo, ["update-index", "--chmod=+x", "--", path]);
  const publicModes = executablePaths(options.publishRepo);
  if (JSON.stringify(publicModes) !== JSON.stringify(exportModes)) die("ABORT: public sync changed the export executable-mode set");
  const staged = git(options.publishRepo, ["diff", "--cached", "--quiet"]);
  if (staged.exitCode === 1) {
    mustGit("cannot commit public sync", options.publishRepo, ["commit", "-m", `chore(release): Garelier ${tag}`]);
  } else if (staged.exitCode !== 0) {
    failCommand("cannot inspect staged public sync", staged);
  } else {
    console.log("==> Public clone already matches export; no sync commit needed");
  }

  const publicSha = mustGit("cannot read public main SHA", options.publishRepo, ["rev-parse", "HEAD"]).stdout.trim();
  confirm(`push public main (${publicSha})`, options);
  mustGit("public main push failed", options.publishRepo, ["push", "origin", "main"]);
  if (!options.githubRepo) {
    options.githubRepo = must("cannot resolve GitHub repository; pass --repo", ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], options.publishRepo).stdout.trim();
  }
  const runId = must("cannot find GitHub Actions run for pushed main", ["gh", "run", "list", "--repo", options.githubRepo, "--branch", "main", "--commit", publicSha, "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"]).stdout.trim();
  if (!/^\d+$/.test(runId)) die(`ABORT: no GitHub Actions run found for pushed main ${publicSha}; do not tag`);
  console.log(`==> Waiting for public CI run ${runId} to finish green`);
  must("public CI is red; stopped before tag/release", ["gh", "run", "watch", runId, "--repo", options.githubRepo, "--exit-status"]);

  confirm(`create annotated public tag ${tag} after green CI`, options);
  mustGit("cannot create release tag", options.publishRepo, ["tag", "-a", tag, "-m", `Garelier ${tag}`]);
  confirm(`push public tag ${tag}`, options);
  mustGit("public tag push failed", options.publishRepo, ["push", "origin", tag]);
  writeFileSync(notesFile, notes);
  confirm(`create GitHub release ${tag}`, options);
  must("GitHub release creation failed", ["gh", "release", "create", tag, "--repo", options.githubRepo, "--title", `Garelier ${tag}`, "--notes-file", notesFile]);
  console.log(`==> Release complete: ${tag}`);
} finally {
  try { rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
}
