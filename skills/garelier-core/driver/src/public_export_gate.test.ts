import { resetPathGuardRoots, rmSync, unlinkSync } from "./guard/path_guard.ts";
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  adoptReleaseLockForResume,
  assertPushedWorkflowCanTurnGreen,
  canonicalReleaseLockPath,
  releasePlanSteps,
  releaseWorkflowBlobsMatch,
  releaseFinalizeAction,
  resolveReleaseResumeRoute,
  resolveResumePushedSha,
  waitForPushedCiRun,
} from "./scripts/concierge_release.ts";

// W-092 integration test for the public-export gate
// (skills/garelier-core/driver/src/scripts/make-public-export.ts). It runs the REAL export script inside a
// throwaway git repo — the script resolves its ROOT from its own location, so
// copying it into <tmprepo>/scripts/ makes it scan/archive that repo. This
// exercises the two fail-closed additions end to end:
//   (a) repo-root allowlist — a stray root entry (a role report left at the
//       root, the actual v2.11.0/1 leak) FAILS the export instead of mirroring.
//   (b) report-file / model-chatter scan — a role report committed into an
//       allowlisted SUBDIR (which the root check would miss) FAILS, and its
//       model-name chatter (Sonnet/Codex) is surfaced.
// A clean, all-allowlisted tree still exports green (regression floor).

// The export spawns git subprocesses (grep/archive/init/commit); the default 5s
// budget is too tight on a loaded machine.
const T = 60_000;

type Run = { code: number; stdout: string; stderr: string };

let repo: string;
let globalCfg: string;
let baseSha: string;

function git(args: string[]): Run {
  const r = spawnSync("git", args, { windowsHide: true, cwd: repo, env: { ...process.env }, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeIn(rel: string, content: string) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commitAll(msg: string) {
  expect(git(["add", "-A"]).code).toBe(0);
  const c = git(["commit", "-q", "-m", msg]);
  if (c.code !== 0) throw new Error(c.stderr || c.stdout);
}

// The gate logic now lives in the driver TS twin (W-083). Invoke it directly
// with GARELIER_EXPORT_ROOT pointing at the throwaway repo: the former shim,
// copied alone into <repo>/scripts/, cannot resolve the driver .ts from a repo
// that has no driver tree, so this replaces the copied-shim invocation with a
// direct .ts run. Every fixture and assertion below is unchanged — the gate
// still scans/archives the throwaway repo end to end (the W-060 exec-bit path
// is still exercised via the copied shim staged 100755 in beforeEach).
const GATE_TS = join(import.meta.dir, "scripts", "make-public-export.ts");
const RELEASE_TS = join(import.meta.dir, "scripts", "concierge_release.ts");
const GIT_GUARD_TS = join(import.meta.dir, "scripts", "concierge_git_guard.ts");

// Run the real export gate against the throwaway repo, isolated from any
// machine-global git config (so e.g. commit.gpgsign cannot break the dest
// repo's single commit).
function runExport(keepDest = false): Run & { dest?: string } {
  // Pass the dest as a path relative to the gate ROOT (repo). W-254: the
  // script no longer hands DEST to tar as a `-C`/`-f` argv path at all — it
  // resolves DEST to an absolute path and passes it only via spawn `cwd`, so
  // an absolute Windows dest would work here too now. Kept relative purely as
  // a fixture convenience (DEST lands as a sibling of the throwaway repo).
  const name = `garelier-export-dest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const destAbs = join(repo, "..", name);
  const r = spawnSync("bun", [GATE_TS, `../${name}`], { windowsHide: true,
    cwd: repo,
    env: {
      ...process.env,
      GARELIER_EXPORT_ROOT: repo,
      GIT_CONFIG_GLOBAL: globalCfg,
      GIT_CONFIG_SYSTEM: globalCfg,
      GIT_CONFIG_NOSYSTEM: "1",
    },
    encoding: "utf8",
  });
  if (!keepDest) {
    try { rmSync(destAbs, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(keepDest ? { dest: destAbs } : {}) };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "garelier-export-"));
  // Keep the isolating git config OUTSIDE the repo tree so it is not tracked
  // (a tracked stray would, correctly, trip the very allowlist under test).
  globalCfg = `${repo}.gitconfig`;
  writeFileSync(globalCfg, "");
  git(["init", "-q"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["config", "user.email", "ci@ci"]);
  git(["config", "user.name", "ci"]);
  git(["config", "commit.gpgsign", "false"]);
  // A minimal, ALL-ALLOWLISTED publishable tree.
  writeIn("VERSION", "0.0.0-test\n");
  writeIn("README.md", "# Sample framework\n\nNothing sensitive here.\n");
  writeIn("LICENSE", "MIT\n");
  writeIn(".gitignore", "node_modules/\n");
  writeIn("docs/guide.md", "A normal doc with no secrets.\n");
  // Keep the executable TS entry in the fixture index so mode preservation is
  // exercised against the post-W-111 layout.
  const destScript = join(repo, "scripts", "fixture-entry.ts");
  mkdirSync(dirname(destScript), { recursive: true });
  writeFileSync(destScript, "#!/usr/bin/env bun\n");
  chmodSync(destScript, 0o755);
  // Windows `git add` records a new file as 100644; the real repo tracks this
  // script 100755, and the export's W-060 exec-bit detective would (correctly)
  // abort on a 100644 .ts. Stage it 100755 in the index to match real-repo state.
  expect(git(["add", "-A"]).code).toBe(0);
  git(["update-index", "--chmod=+x", "--", "scripts/fixture-entry.ts"]);
  const base = git(["commit", "-q", "-m", "base"]);
  if (base.code !== 0) throw new Error(base.stderr || base.stdout);
  baseSha = git(["rev-parse", "HEAD"]).stdout.trim();
}, T);

beforeEach(() => {
  // Preserve the exact allowlisted index (including executable modes) while
  // avoiding a fresh git repository and base commit for every export case.
  const reset = git(["reset", "-q", "--hard", baseSha]);
  if (reset.code !== 0) throw new Error(reset.stderr || reset.stdout);
  const clean = git(["clean", "-q", "-ffd"]);
  if (clean.code !== 0) throw new Error(clean.stderr || clean.stdout);
});

afterAll(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(globalCfg, { force: true }); } catch { /* ignore */ }
}, T);

describe("public-export gate (W-092)", () => {
  test("preserves historical CHANGELOG lines while scanning every exported path for private identifiers", () => {
    const privateProjectName = ["Su", "ture"].join("");
    const changelog =
      `  escaped/code-span-aware column counts. A synthetic ${privateProjectName}-scale fixture fixes\n` +
      `  ${privateProjectName}規模fixtureで277 candidate、同一header 5個、8/10/11列の不正行を固定し、\n`;
    writeIn("CHANGELOG.md", changelog);
    commitAll("historical changelog fixture");

    const green = runExport(true);
    try {
      if (green.code !== 0 || !green.dest) {
        throw new Error(`expected historical CHANGELOG to export green, got:\n${green.stdout}\n${green.stderr}`);
      }
      expect(readFileSync(join(green.dest, "CHANGELOG.md"), "utf8")).toBe(changelog);
      expect(green.stdout).toMatch(/Exported a clean, history-free/i);
    } finally {
      if (green.dest) try { rmSync(green.dest, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    writeIn("skills/fixture-private-id.test.ts", `export const fixture = ${JSON.stringify(privateProjectName)};\n`);
    writeIn(
      "skills/garelier-core/driver/src/scripts/make-public-export.ts",
      `export const fixture = ${JSON.stringify(privateProjectName)};\n`,
    );
    commitAll("private identifier coverage fixtures");

    const red = runExport();
    expect(red.code).not.toBe(0);
    expect(red.stdout + red.stderr).toMatch(/skills\/fixture-private-id\.test\.ts/);
    expect(red.stdout + red.stderr).toMatch(/skills\/garelier-core\/driver\/src\/scripts\/make-public-export\.ts/);
  }, T);

  test("carries every dev-index 100755 path into the exported commit", () => {
    // Include both the shell shim and a non-shell executable. The latter makes
    // the assertion prove the W-110 full-set contract rather than the old
    // `.ts`/`bin` heuristic.
    writeIn("bin/fixture-tool", "#!/usr/bin/env bash\necho fixture\n");
    expect(git(["add", "bin/fixture-tool"]).code).toBe(0);
    expect(git(["update-index", "--chmod=+x", "--", "bin/fixture-tool"]).code).toBe(0);
    const c = git(["commit", "-q", "-m", "fixture executable"]);
    if (c.code !== 0) throw new Error(c.stderr || c.stdout);

    const r = runExport(true);
    try {
      if (r.code !== 0 || !r.dest) throw new Error(`expected green export, got:\n${r.stdout}\n${r.stderr}`);
      const sourceModes = git(["ls-files", "-s"]).stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("100755 "))
        .map((line) => line.slice(line.indexOf("\t") + 1))
        .sort();
      const exported = spawnSync("git", ["-C", r.dest, "ls-files", "-s"], { windowsHide: true, encoding: "utf8" });
      expect(exported.status).toBe(0);
      const exportModes = (exported.stdout ?? "")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("100755 "))
        .map((line) => line.slice(line.indexOf("\t") + 1))
        .sort();
      expect(exportModes).toEqual(sourceModes);
      expect(exportModes).toContain("bin/fixture-tool");
      expect(r.stdout).toMatch(/Export mode self-check passed/);
    } finally {
      if (r.dest) try { rmSync(r.dest, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, T);

  test("an RFC-reserved .invalid fixture email is allowlisted", () => {
    writeIn("docs/fixture-email.md", "Contact fixture@example.invalid for test data only.\n");
    commitAll("reserved fixture email");
    const r = runExport();
    if (r.code !== 0) throw new Error(`expected reserved-domain fixture to export, got:\n${r.stdout}\n${r.stderr}`);
    expect(r.stdout).toMatch(/Exported a clean, history-free/i);
  }, T);

  // (i) at the repo ROOT the root allowlist names it; (ii) in an allowlisted
  // SUBDIR only the report-file scan can, and its model chatter is surfaced.
  // Same contract, two locations (+1 folded case).
  test("a role report FAILS the export wherever it sits, and its model chatter is named", () => {
    writeIn("fixture-REPORT.md", "Role report body.\n");
    commitAll("stray root report");
    const root = runExport();
    expect(root.code).not.toBe(0);
    expect(root.stdout + root.stderr).toMatch(/ABORT/);
    expect(root.stdout + root.stderr).toMatch(/fixture-REPORT\.md/);

    const reset = git(["reset", "-q", "--hard", baseSha]);
    if (reset.code !== 0) throw new Error(reset.stderr || reset.stdout);
    const clean = git(["clean", "-q", "-ffd"]);
    if (clean.code !== 0) throw new Error(clean.stderr || clean.stdout);

    writeIn("docs/session-REPORT.md", "Sonnet fallback attempted; Codex attempt failed.\n");
    commitAll("subdir report with model chatter");
    const subdir = runExport();
    expect(subdir.code).not.toBe(0);
    expect(subdir.stdout + subdir.stderr).toMatch(/ABORT/);
    expect(subdir.stdout + subdir.stderr).toMatch(/docs\/session-REPORT\.md/);
    expect(subdir.stdout + subdir.stderr).toMatch(/Sonnet|Codex/);
  }, T);

  // W-755. The release wrapper is the export gate's only consumer, and the
  // measured v3.0.0 failure was in the steps immediately after it: the CI watch
  // asked GitHub once, 3 seconds before the run existed, then finalized the
  // request as failed with public main already pushed and no way back in.
  // The final fixture stays local but crosses the real CLI process boundary,
  // including a local bare remote and canonical-shaped runtime authority files.
  test("W-755/W-762 a pushed release resumes at CI or takes the approved guarded re-push route", () => {
    const PUSHED = "a".repeat(40);
    const OTHER = "b".repeat(40);
    const LOCK_SOURCE = "c".repeat(40);
    const APPROVED_SOURCE = "d".repeat(40);

    // (a) The bound. The run appears on the 3rd ask; the wait must reach it,
    // and the two intervening misses must have cost exactly two sleeps.
    const slept: number[] = [];
    let clock = 0;
    let asks = 0;
    const found = waitForPushedCiRun({
      listRunId: () => (++asks >= 3 ? "34036202735" : ""),
      sleep: (ms) => { slept.push(ms); clock += ms; },
      now: () => clock,
    }, 120_000, 5_000);
    expect(found).toBe("34036202735");
    expect(asks).toBe(3);
    expect(slept).toEqual([5_000, 5_000]);

    // Counterfactual: with the budget spent there is exactly ONE ask and no
    // wait — the pre-W-755 behaviour, reachable only by removing the bound.
    let unboundedAsks = 0;
    expect(waitForPushedCiRun({
      listRunId: () => { unboundedAsks += 1; return ""; },
      sleep: () => { throw new Error("a spent budget must not sleep"); },
      now: () => 0,
    }, 0, 5_000)).toBeNull();
    expect(unboundedAsks).toBe(1);

    // (b) The finalize rule. A failure with no prepared/pushed SHA may write .done.
    expect(releaseFinalizeAction("failed", null)).toBe("write-done");
    expect(releaseFinalizeAction("complete", PUSHED)).toBe("write-done");
    expect(releaseFinalizeAction("failed", PUSHED)).toBe("keep-pushed-for-resume");

    // (c) The resume binding. A lock written before this row records no pushed
    // SHA (the real v3.0.0 lock is still status=active), so the remote proves
    // the push; a lock that records one is believed over the remote. Either
    // way the local clone must still sit exactly there.
    expect(resolveResumePushedSha({ status: "active" }, PUSHED, PUSHED)).toBe(PUSHED);
    expect(resolveResumePushedSha({ status: "pushed", pushed_sha: PUSHED }, PUSHED, PUSHED)).toBe(PUSHED);
    expect(() => resolveResumePushedSha({ status: "pushed", pushed_sha: PUSHED }, PUSHED, OTHER))
      .toThrow(/condition \(d\).*public clone HEAD .* is not pushed SHA/);
    expect(() => resolveResumePushedSha({ status: "active" }, "", PUSHED))
      .toThrow(/condition \(d\).*no pushed SHA and the remote main head is unreadable/);

    // (d) W-762 route selection. An unchanged approval is exactly the old
    // W-755 CI-watch route. A changed, freshly approved source takes the
    // existing export/sync/guarded-push path only when (a)-(e) are all proved.
    const failedRun = { databaseId: 34036202735, status: "completed", conclusion: "failure" };
    const pushedLock = {
      status: "pushed",
      source_sha: LOCK_SOURCE,
      pushed_sha: PUSHED,
    };
    expect(resolveReleaseResumeRoute(pushedLock, LOCK_SOURCE, failedRun)).toBe("watch");
    expect(resolveReleaseResumeRoute(pushedLock, APPROVED_SOURCE, failedRun)).toBe("repush");
    expect(releasePlanSteps("repush", PUSHED))
      .toContain("export -> public sync -> guarded publish push -> CI watch -> tag -> release");

    // Counterfactual (e): a successful old run forbids a replacement push and
    // names the exact failed predicate instead of falling into either route.
    expect(() => resolveReleaseResumeRoute(pushedLock, APPROVED_SOURCE, {
      databaseId: 34036202736,
      status: "completed",
      conclusion: "success",
    })).toThrow(/RELEASE_RESUME_CONDITION_FAILED.*condition \(e\).*not failed/);
    expect(() => resolveReleaseResumeRoute({
      status: "active",
      source_sha: LOCK_SOURCE,
    }, APPROVED_SOURCE, null)).toThrow(/condition \(a\).*condition \(d\)/);
    expect(() => resolveReleaseResumeRoute({
      status: "pushed",
      source_sha: "not-a-sha",
      pushed_sha: PUSHED,
    }, APPROVED_SOURCE, null)).toThrow(/condition \(b\) cannot be proved/);

    // AC-762-2's one-point detector: only failed-run + workflow-blob mismatch
    // produces the typed A/B diagnosis; the same blob keeps the CI watch.
    writeIn(".github/workflows/ci.yml", "name: pushed\nruns-on: ubuntu-latest\n");
    commitAll("pushed workflow fixture");
    const pushedWorkflowSha = git(["rev-parse", "HEAD"]).stdout.trim();
    writeIn(".github/workflows/ci.yml", "name: approved\nruns-on: windows-latest\n");
    commitAll("approved workflow fixture");
    const approvedWorkflowSha = git(["rev-parse", "HEAD"]).stdout.trim();
    expect(releaseWorkflowBlobsMatch(repo, pushedWorkflowSha, repo, approvedWorkflowSha)).toBe(false);
    expect(releaseWorkflowBlobsMatch(repo, approvedWorkflowSha, repo, approvedWorkflowSha)).toBe(true);
    expect(() => assertPushedWorkflowCanTurnGreen(
      failedRun,
      releaseWorkflowBlobsMatch(repo, pushedWorkflowSha, repo, approvedWorkflowSha),
      PUSHED,
      LOCK_SOURCE,
    )).toThrow(/RELEASE_PUSHED_WORKFLOW_STALE.*Exit A:.*Exit B:/);
    expect(() => assertPushedWorkflowCanTurnGreen(
      failedRun,
      releaseWorkflowBlobsMatch(repo, approvedWorkflowSha, repo, approvedWorkflowSha),
      PUSHED,
      LOCK_SOURCE,
    )).not.toThrow();

    // (e) Process-boundary orchestration: the real CLI reads real authority and
    // lock files, selects the route, runs the real export/sync engine, and pushes
    // through the real guard to a local bare remote. No production port is
    // replaceable; only `gh` (the external service boundary) is a fake process.
    const home = mkdtempSync(join(tmpdir(), "garelier-w762-"));
    try {
      const source = join(home, "source");
      const publish = join(home, "publish");
      const publicRemote = join(home, "public.git");
      const fakeBin = join(home, "bin");
      const fakeGhSource = join(home, "fake-gh.ts");
      const fakeGh = join(fakeBin, process.platform === "win32" ? "gh.exe" : "gh");
      const fixtureGitConfig = join(home, "gitconfig");
      const guardMarker = join(home, "guard.log");
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(fixtureGitConfig, "");

      const gitAt = (cwd: string, args: string[]): Run => {
        const result = spawnSync("git", args, {
          windowsHide: true,
          cwd,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: fixtureGitConfig,
            GIT_CONFIG_SYSTEM: fixtureGitConfig,
            GIT_CONFIG_NOSYSTEM: "1",
          },
          encoding: "utf8",
        });
        return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      };
      const mustGit = (cwd: string, args: string[]): string => {
        const result = gitAt(cwd, args);
        if (result.code !== 0) throw new Error(result.stderr || result.stdout);
        return result.stdout.trim();
      };
      const writeAt = (root: string, rel: string, content: string): void => {
        const path = join(root, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      };
      const commitAt = (root: string, message: string): string => {
        mustGit(root, ["add", "-A"]);
        mustGit(root, ["commit", "-q", "-m", message]);
        return mustGit(root, ["rev-parse", "HEAD"]);
      };

      mkdirSync(source, { recursive: true });
      mustGit(source, ["init", "-q"]);
      mustGit(source, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      mustGit(source, ["config", "user.email", "ci@ci"]);
      mustGit(source, ["config", "user.name", "ci"]);
      mustGit(source, ["config", "commit.gpgsign", "false"]);
      writeAt(source, "VERSION", "9.9.9\n");
      writeAt(source, "CHANGELOG.md", "# Changelog\n\n## [9.9.9] - fixture\n\n- process-boundary release fixture\n");
      writeAt(source, "README.md", "# old approved source\n");
      writeAt(source, "LICENSE", "MIT\n");
      writeAt(source, ".gitignore", "node_modules/\n__garelier/\n");
      writeAt(source, ".github/workflows/ci.yml", "name: source-old\n");
      const fixtureExport = "skills/garelier-core/driver/src/scripts/make-public-export.ts";
      const fixtureGuard = "skills/garelier-core/driver/src/scripts/concierge_git_guard.ts";
      writeAt(source, fixtureExport, [
        "const script = process.env.GARELIER_REAL_EXPORT_SCRIPT!;",
        "const result = Bun.spawnSync([process.execPath, script, ...process.argv.slice(2)], {",
        "  cwd: process.cwd(),",
        "  env: { ...process.env, GARELIER_EXPORT_ROOT: process.env.GARELIER_RELEASE_ROOT! },",
        "  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',",
        "});",
        "process.exit(result.exitCode);",
        "",
      ].join("\n"));
      writeAt(source, fixtureGuard, [
        "import { appendFileSync, readFileSync } from 'node:fs';",
        "import { pathToFileURL } from 'node:url';",
        "appendFileSync(process.env.GARELIER_GUARD_MARKER!, JSON.stringify({",
        "  argv: process.argv.slice(2).join(' '),",
        "  lock: JSON.parse(readFileSync(process.env.GARELIER_RELEASE_LOCK!, 'utf8')),",
        "}) + '\\n');",
        "await import(pathToFileURL(process.env.GARELIER_REAL_GUARD_SCRIPT!).href);",
        "",
      ].join("\n"));
      chmodSync(join(source, fixtureExport), 0o755);
      chmodSync(join(source, fixtureGuard), 0o755);
      mustGit(source, ["add", "-A"]);
      mustGit(source, ["update-index", "--chmod=+x", "--", fixtureExport, fixtureGuard]);
      mustGit(source, ["commit", "-q", "-m", "old approved source"]);
      const lockSourceSha = mustGit(source, ["rev-parse", "HEAD"]);
      writeAt(source, "README.md", "# newly approved source\n");
      writeAt(source, ".github/workflows/ci.yml", "name: source-approved\n");
      const approvedSourceSha = commitAt(source, "newly approved source");

      expect(spawnSync("git", ["init", "--bare", "-q", publicRemote], { windowsHide: true }).status).toBe(0);
      mkdirSync(publish, { recursive: true });
      mustGit(publish, ["init", "-q"]);
      mustGit(publish, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      mustGit(publish, ["config", "user.email", "ci@ci"]);
      mustGit(publish, ["config", "user.name", "ci"]);
      mustGit(publish, ["config", "commit.gpgsign", "false"]);
      writeAt(publish, "README.md", "# pushed public tree\n");
      writeAt(publish, ".github/workflows/ci.yml", "name: pushed-stale\n");
      const pushedSha = commitAt(publish, "pushed public tree");
      mustGit(publish, ["remote", "add", "origin", publicRemote]);
      mustGit(publish, ["push", "-q", "-u", "origin", "main"]);

      writeFileSync(fakeGhSource, [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'run' && args[1] === 'list') {",
        "  if (args.includes('--jq')) console.log('34036202739');",
        "  else if (process.env.GARELIER_FAKE_GH_MODE === 'none') console.log('[]');",
        "  else if (process.env.GARELIER_FAKE_GH_MODE === 'success')",
        "    console.log(JSON.stringify([{ databaseId: 34036202738, status: 'completed', conclusion: 'success' }]));",
        "  else console.log(JSON.stringify([{ databaseId: 34036202735, status: 'completed', conclusion: 'failure' }]));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'run' && args[1] === 'watch') process.exit(0);",
        "if (args[0] === 'release' && args[1] === 'create') process.exit(0);",
        "console.error('unexpected fake gh argv: ' + args.join(' '));",
        "process.exit(2);",
        "",
      ].join("\n"));
      const compiledGh = spawnSync(process.execPath, ["build", "--compile", fakeGhSource, "--outfile", fakeGh], {
        windowsHide: true, encoding: "utf8",
      });
      if ((compiledGh.status ?? 1) !== 0) throw new Error(compiledGh.stderr || compiledGh.stdout);
      chmodSync(fakeGh, 0o755);

      const pmId = "tpm";
      const requestId = "rel-w762-fixture";
      const agentName = "ga-concierge-w762-fixture";
      const guardianPath = join(source, "__garelier", pmId, "runtime", "guardian", "results", "w762-guardian.md");
      const approvalPath = join(
        source, "__garelier", pmId, "runtime", "concierge", "requests",
        `framework_release__${requestId}.approval.json`,
      );
      const permissionPath = join(
        source, "__garelier", pmId, "_crew", "lanes", ".meta", `${agentName}.dispatch.json`,
      );
      const lockPath = canonicalReleaseLockPath(source, pmId, "v9.9.9");
      const commonDir = resolve(source, mustGit(source, ["rev-parse", "--git-common-dir"]));
      const writeGuardian = (sha: string): void => writeAt(
        source,
        guardianPath.slice(source.length + 1),
        `+++\n[verdict]\nresult = 'PASS'\nreview_sha = '${sha}'\n+++\n\nPASS\n`,
      );
      const writeApproval = (sha: string, pathOverrides: Record<string, string> = {}): void => writeAt(
        source,
        approvalPath.slice(source.length + 1),
        JSON.stringify({
          schema_version: 1,
          request_id: requestId,
          operation_kind: "framework_release",
          approval_status: "approved",
          requested_by: "user",
          approved_by: "fixture",
          user_approval_ref: "W-762-process-boundary",
          pm_id: pmId,
          control_root: source,
          git_common_dir: commonDir,
          agent_name: agentName,
          permission_record: permissionPath,
          guardian_report: guardianPath,
          release_tag: "v9.9.9",
          source_sha: sha,
          publish_repo: publish,
          expected_publish_sha: pushedSha,
          github_repo: "example/garelier",
          target_remote: "origin",
          approved_remote_url: publicRemote,
          allow_unattended_confirmations: true,
          ...pathOverrides,
        }, null, 2) + "\n",
      );
      writeAt(source, permissionPath.slice(source.length + 1), JSON.stringify({
        schema_version: 1,
        source: "attended_record",
        spawned_via: "dispatch_prepare",
        guard: {
          permission_profile: "concierge",
          role: "concierge",
          agent_name: agentName,
          worktree: source,
          approved_remote_destinations: [{ name: "origin", url: publicRemote }],
        },
      }, null, 2) + "\n");
      writeAt(source, lockPath.slice(source.length + 1), JSON.stringify({
        request_id: requestId,
        operation_kind: "framework_release",
        target_remote: "origin",
        target_ref: "v9.9.9",
        source_sha: lockSourceSha,
        pushed_sha: pushedSha,
        pushed_at: "2026-09-12T00:00:00.000Z",
        pid: 2_147_483_647,
        nonce: "fixture-old-owner",
        started_at: "2026-09-12T00:00:00.000Z",
        status: "pushed",
        repushed_from: [],
      }, null, 2) + "\n");
      writeFileSync(`${lockPath}.done`, JSON.stringify({
        request_id: requestId,
        operation_kind: "framework_release",
        lock_path: lockPath,
        owner_pid: 2_147_483_647,
        nonce: "fixture-old-owner",
        outcome: "failed",
        completed_at: "2026-09-12T00:01:00.000Z",
        status: "done",
      }, null, 2) + "\n");

      const argsFor = (dryRun = false, resumeId = requestId) => [
        RELEASE_TS,
        "--approval-ledger", approvalPath,
        "--permission-record", permissionPath,
        "--guardian-report", guardianPath,
        "--external-lock", lockPath,
        "--publish-repo", publish,
        "--repo", "example/garelier",
        "--resume", resumeId,
        "--yes",
        ...(dryRun ? ["--dry-run"] : []),
      ];
      const runCli = (
        role: string,
        ghMode: "failed" | "success" | "none",
        dryRun = false,
        resumeId = requestId,
      ): Run => {
        const result = spawnSync(process.execPath, argsFor(dryRun, resumeId), {
          windowsHide: true,
          cwd: source,
          env: {
            ...process.env,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
            GIT_CONFIG_GLOBAL: fixtureGitConfig,
            GIT_CONFIG_SYSTEM: fixtureGitConfig,
            GIT_CONFIG_NOSYSTEM: "1",
            GARELIER_ROLE: role,
            GARELIER_PM_ID: pmId,
            GARELIER_AGENT_NAME: agentName,
            GARELIER_RELEASE_ROOT: source,
            GARELIER_REAL_EXPORT_SCRIPT: GATE_TS,
            GARELIER_REAL_GUARD_SCRIPT: GIT_GUARD_TS,
            GARELIER_GUARD_MARKER: guardMarker,
            GARELIER_RELEASE_LOCK: lockPath,
            GARELIER_FAKE_GH_MODE: ghMode,
          },
          encoding: "utf8",
        });
        return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      };
      const readLock = () => JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
      const markerText = (): string => {
        try { return readFileSync(guardMarker, "utf8"); } catch { return ""; }
      };
      const releaseState = () => ({
        lock: readFileSync(lockPath, "utf8"),
        done: readFileSync(`${lockPath}.done`, "utf8"),
        publishHead: mustGit(publish, ["rev-parse", "HEAD"]),
        publishStatus: mustGit(publish, ["status", "--porcelain"]),
        publishTags: mustGit(publish, ["tag", "--list"]),
        remoteMain: mustGit(publicRemote, ["rev-parse", "refs/heads/main"]),
        remoteTags: mustGit(publicRemote, ["for-each-ref", "--format=%(refname)", "refs/tags"]),
        guardMarker: markerText(),
      });
      const expectZeroWrites = (before: ReturnType<typeof releaseState>, noTag = true): void => {
        const after = releaseState();
        expect(after).toEqual(before);
        if (noTag) {
          expect(after.publishTags).toBe("");
          expect(after.remoteTags).toBe("");
        }
      };
      const selectSource = (sha: string): void => {
        mustGit(source, ["reset", "-q", "--hard", sha]);
        writeApproval(sha);
        writeGuardian(sha);
      };

      selectSource(approvedSourceSha);
      const initialLock = readFileSync(lockPath, "utf8");

      // Three independent authority counterfactuals cross the real process
      // boundary. Each refusal leaves both lock files, the clean publish clone,
      // bare remote main/tags, and the guarded-push marker unchanged.
      const absentLedgerState = releaseState();
      unlinkSync(approvalPath);
      const absentLedger = runCli("concierge", "failed");
      expect(absentLedger.code).toBe(2);
      expect(absentLedger.stdout + absentLedger.stderr).toMatch(/approval ledger does not exist/);
      expect(existsSync(approvalPath)).toBe(false);
      expectZeroWrites(absentLedgerState);
      writeApproval(approvedSourceSha);

      writeGuardian(lockSourceSha);
      const staleGuardianState = releaseState();
      const staleGuardian = runCli("concierge", "failed");
      expect(staleGuardian.code).toBe(2);
      expect(staleGuardian.stdout + staleGuardian.stderr)
        .toMatch(/RELEASE_RESUME_CONDITION_FAILED.*condition \(c\).*Guardian reviewed/s);
      expectZeroWrites(staleGuardianState);
      writeGuardian(approvedSourceSha);

      const roleMismatchState = releaseState();
      const roleMismatch = runCli("worker", "failed");
      expect(roleMismatch.code).toBe(2);
      expect(roleMismatch.stdout + roleMismatch.stderr).toMatch(/requires GARELIER_ROLE=concierge/);
      expectZeroWrites(roleMismatchState);

      // W-863: each ledger-bound path accepts an existing 8.3 alias on
      // Windows, but a different existing leaf and a missing leaf both refuse.
      const pathRows = [
        { key: "control_root", canonical: source, other: publish },
        { key: "git_common_dir", canonical: commonDir, other: source },
        { key: "permission_record", canonical: permissionPath, other: guardianPath },
        { key: "guardian_report", canonical: guardianPath, other: permissionPath },
      ];
      for (const { key, canonical, other } of pathRows) {
        const before = releaseState();
        for (const value of [other, join(source, "missing-w863", key)]) {
          writeApproval(approvedSourceSha, { [key]: value });
          const refused = runCli("concierge", "failed", true);
          expect(refused.code).toBe(2);
          expect(refused.stdout + refused.stderr).toContain(`approval ledger ${key} does not match the live release context`);
          expectZeroWrites(before);
        }
        if (process.platform === "win32") {
          const short = spawnSync("cmd.exe", ["/d", "/c", `for %I in (${canonical}) do @echo %~sI`], {
            windowsHide: true, encoding: "utf8",
          });
          expect(short.status).toBe(0);
          const alias = short.stdout.trim();
          expect(alias).not.toBe("");
          writeApproval(approvedSourceSha, { [key]: alias });
          const accepted = runCli("concierge", "failed", true);
          expect(accepted.code, `${key}: ${alias}: ${accepted.stdout}${accepted.stderr}`).toBe(0);
          expectZeroWrites(before);
        }
        writeApproval(approvedSourceSha);
      }

      // W-755 ownership boundary: a request named only on argv cannot adopt a
      // lock belonging to another canonical request.
      const otherRequestState = releaseState();
      expect(() => adoptReleaseLockForResume(
        lockPath,
        lockPath,
        "rel-w762-other-request",
      )).toThrow(/release lock belongs to request rel-w762-fixture, not rel-w762-other-request/);
      expectZeroWrites(otherRequestState);
      const otherRequest = runCli("concierge", "failed", false, "rel-w762-other-request");
      expect(otherRequest.code).toBe(2);
      expect(otherRequest.stdout + otherRequest.stderr)
        .toMatch(/release lock belongs to request rel-w762-fixture, not rel-w762-other-request/);
      expectZeroWrites(otherRequestState);

      // AC-762-3(i): all five conditions select the export/sync/guarded-push
      // plan through the real CLI. The dry-run performs no durable mutation.
      const repushPlan = runCli("concierge", "failed", true);
      expect(repushPlan.code).toBe(0);
      expect(repushPlan.stdout)
        .toContain("export -> public sync -> guarded publish push -> CI watch -> tag -> release");
      expect(readFileSync(lockPath, "utf8")).toBe(initialLock);

      // AC-762-3(ii): condition (b) false selects the unchanged CI-watch route.
      selectSource(lockSourceSha);
      const watchPlan = runCli("concierge", "none", true);
      expect(watchPlan.code).toBe(0);
      expect(watchPlan.stdout).toContain(`RESUME at pushed main ${pushedSha} -> CI watch`);
      expect(watchPlan.stdout).toContain("no export, sync commit, push, lock adoption, tag, or release write");

      // AC-762-3(iii): a successful run makes condition (e) false.
      selectSource(approvedSourceSha);
      const successfulRun = runCli("concierge", "success", true);
      expect(successfulRun.code).not.toBe(0);
      expect(successfulRun.stdout + successfulRun.stderr)
        .toMatch(/RELEASE_RESUME_CONDITION_FAILED.*condition \(e\).*not failed/s);

      // AC-762-3(iv): only the unchanged/watch route compares the fixed workflow
      // blob and diagnoses a pushed commit that cannot become green.
      selectSource(lockSourceSha);
      const staleWorkflow = runCli("concierge", "failed", true);
      expect(staleWorkflow.code).not.toBe(0);
      expect(staleWorkflow.stdout + staleWorkflow.stderr)
        .toMatch(/RELEASE_PUSHED_WORKFLOW_STALE.*Exit A:.*Exit B:/s);

      // Every deterministic lock update refusal precedes the guarded push. A bad
      // history shape therefore leaves the lock and bare remote byte-for-byte at
      // their old values and produces no guard marker.
      selectSource(approvedSourceSha);
      writeFileSync(lockPath, JSON.stringify({ ...readLock(), repushed_from: {} }, null, 2) + "\n");
      const badLock = readFileSync(lockPath, "utf8");
      const badHistory = runCli("concierge", "failed");
      expect(badHistory.code).not.toBe(0);
      expect(badHistory.stdout + badHistory.stderr)
        .toMatch(/RELEASE_LOCK_UPDATE_INVALID.*repushed_from.*array/s);
      expect(readFileSync(lockPath, "utf8")).toBe(badLock);
      expect(mustGit(publicRemote, ["rev-parse", "refs/heads/main"])).toBe(pushedSha);
      expect(markerText()).toBe("");

      // Restored valid history drives the complete real route. The remote moves,
      // the main push is observed at the real guard process boundary, and the
      // lock is already advanced when that irreversible operation begins.
      writeFileSync(lockPath, JSON.stringify({ ...readLock(), repushed_from: [] }, null, 2) + "\n");
      const released = runCli("concierge", "failed");
      expect(released.code).toBe(0);
      const remoteMain = mustGit(publicRemote, ["rev-parse", "refs/heads/main"]);
      const localMain = mustGit(publish, ["rev-parse", "HEAD"]);
      expect(remoteMain).toBe(localMain);
      expect(remoteMain).not.toBe(pushedSha);
      const guardEntries = markerText().trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
        argv: string;
        lock: Record<string, unknown>;
      });
      const mainGuard = guardEntries.find((entry) => entry.argv === "push origin main");
      expect(mainGuard).toBeDefined();
      expect(mainGuard?.lock.source_sha).toBe(approvedSourceSha);
      expect(mainGuard?.lock.pushed_sha).toBe(remoteMain);
      const repushedBody = readLock();
      expect(repushedBody.source_sha).toBe(approvedSourceSha);
      expect(repushedBody.pushed_sha).toBe(remoteMain);
      expect(repushedBody.repushed_from).toEqual([
        expect.objectContaining({ source_sha: lockSourceSha, pushed_sha: pushedSha }),
      ]);
      const completed = JSON.parse(readFileSync(`${lockPath}.done`, "utf8")) as Record<string, unknown>;
      expect(completed.outcome).toBe("complete");
      expect(typeof completed.superseded_completed_at).toBe("string");

      // W-755 terminal boundary: once `.done` says complete, the same request
      // cannot adopt the lock again or repeat any external write.
      const completedState = releaseState();
      expect(() => adoptReleaseLockForResume(lockPath, lockPath, requestId))
        .toThrow(/release request rel-w762-fixture is already finalized as complete/);
      expectZeroWrites(completedState, false);
      const completedResume = runCli("concierge", "failed");
      expect(completedResume.code).toBe(2);
      expect(completedResume.stdout + completedResume.stderr)
        .toMatch(/release request rel-w762-fixture is already finalized as complete/);
      expectZeroWrites(completedState, false);
      const completedDryRun = runCli("concierge", "failed", true);
      expect(completedDryRun.code).toBe(2);
      expect(completedDryRun.stdout + completedDryRun.stderr)
        .toMatch(/release request rel-w762-fixture is already finalized as complete/);
      expectZeroWrites(completedState, false);
    } finally {
      resetPathGuardRoots();
      rmSync(home, { recursive: true, force: true });
    }
  }, T);
});
