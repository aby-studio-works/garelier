import { resetPathGuardRoots, rmSync } from "./guard/path_guard.ts";
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  acquireReleaseLock,
  adoptReleaseLockForResume,
  canonicalReleaseLockPath,
  markReleaseLockDone,
  markReleaseLockPushed,
  releaseFinalizeAction,
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
  // Every assertion below is on this module's own state machine — nothing here
  // touches a remote, a clone, or the framework's own runtime tree.
  test("W-755 a pushed release stays resumable: the CI-run wait is bounded, .done is withheld after a push, and --resume rebinds to the pushed SHA", () => {
    const PUSHED = "a".repeat(40);
    const OTHER = "b".repeat(40);

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

    // (b) The finalize rule. Only a failure that never pushed may write .done.
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
      .toThrow(/public clone HEAD .* is not the pushed SHA/);
    expect(() => resolveResumePushedSha({ status: "active" }, "", PUSHED))
      .toThrow(/no pushed SHA and the remote main head is unreadable/);

    // (d) The lock lifecycle end to end, on a throwaway tree.
    const home = mkdtempSync(join(tmpdir(), "garelier-w755-"));
    try {
      const lockPath = canonicalReleaseLockPath(home, "tpm", "v9.9.9");
      const donePath = `${lockPath}.done`;
      const requestId = "rel-w755-fixture";
      const acquired = acquireReleaseLock(lockPath, lockPath, {
        requestId, sourceSha: "c".repeat(40), targetRemote: "origin", tag: "v9.9.9",
      });
      markReleaseLockPushed(acquired, PUSHED);
      const pushedBody = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
      expect(pushedBody.status).toBe("pushed");
      expect(pushedBody.pushed_sha).toBe(PUSHED);
      // The whole defect in one assertion: a post-push failure leaves no .done.
      expect(existsSync(donePath)).toBe(false);

      // The measured v3.0.0 state: finalized failed. Resume must still adopt it.
      markReleaseLockDone(acquired, "failed");
      expect(JSON.parse(readFileSync(donePath, "utf8")).outcome).toBe("failed");
      const adopted = adoptReleaseLockForResume(lockPath, lockPath, requestId);
      expect(adopted.supersedesFailedDone).toBe(true);
      expect(adopted.body.pushed_sha).toBe(PUSHED);
      expect(() => adoptReleaseLockForResume(lockPath, lockPath, "rel-some-other-request"))
        .toThrow(/belongs to request/);

      markReleaseLockDone(adopted.acquired, "complete", adopted.supersedesFailedDone);
      const completed = JSON.parse(readFileSync(donePath, "utf8")) as Record<string, unknown>;
      expect(completed.outcome).toBe("complete");
      expect(completed.request_id).toBe(requestId);
      expect(typeof completed.superseded_completed_at).toBe("string");

      // A completed request is not resumable again.
      expect(() => adoptReleaseLockForResume(lockPath, lockPath, requestId))
        .toThrow(/already finalized as complete/);
    } finally {
      // acquireReleaseLock adds the fixture's lock directory to the process
      // fence, which correctly forbids deleting anything ABOVE it — including
      // this throwaway root. Dropping the fixture's own roots is what lets the
      // test leave nothing behind (the earlier release-lock tests were deleted
      // for leaving exactly this residue).
      resetPathGuardRoots();
      rmSync(home, { recursive: true, force: true });
    }
  }, T);
});
