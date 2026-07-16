import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

// W-092 integration test for the public-export gate
// (scripts/make-public-export.sh). It runs the REAL export script inside a
// throwaway git repo — the script resolves its ROOT from its own location, so
// copying it into <tmprepo>/scripts/ makes it scan/archive that repo. This
// exercises the two fail-closed additions end to end:
//   (a) repo-root allowlist — a stray root entry (a producer report left at the
//       root, the actual v2.11.0/1 leak) FAILS the export instead of mirroring.
//   (b) report-file / model-chatter scan — a producer report committed into an
//       allowlisted SUBDIR (which the root check would miss) FAILS, and its
//       model-name chatter (Sonnet/Codex) is surfaced.
// A clean, all-allowlisted tree still exports green (regression floor).

const EXPORT_SRC = join(import.meta.dir, "..", "..", "..", "..", "scripts", "make-public-export.sh");

// The export spawns git subprocesses (grep/archive/init/commit); the default 5s
// budget is too tight on a loaded machine.
const T = 60_000;

type Run = { code: number; stdout: string; stderr: string };

let repo: string;
let globalCfg: string;

function git(args: string[]): Run {
  const r = spawnSync("git", args, { cwd: repo, env: { ...process.env }, encoding: "utf8" });
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
function runExport(): Run {
  // Pass the dest as a path RELATIVE to the gate ROOT (repo). A Windows absolute
  // path with backslashes confuses git-bash's tar (`tar -C`); a POSIX relative
  // path does not. The real script is invoked with a POSIX dest, so this matches.
  const name = `garelier-export-dest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const destAbs = join(repo, "..", name);
  const r = spawnSync("bun", [GATE_TS, `../${name}`], {
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
  try { rmSync(destAbs, { recursive: true, force: true }); } catch { /* ignore */ }
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "garelier-export-"));
  // Keep the isolating git config OUTSIDE the repo tree so it is not tracked
  // (a tracked stray would, correctly, trip the very allowlist under test).
  globalCfg = `${repo}.gitconfig`;
  writeFileSync(globalCfg, "");
  git(["init", "-q"]);
  git(["config", "user.email", "ci@ci"]);
  git(["config", "user.name", "ci"]);
  git(["config", "commit.gpgsign", "false"]);
  // A minimal, ALL-ALLOWLISTED publishable tree.
  writeIn("VERSION", "0.0.0-test\n");
  writeIn("README.md", "# Sample framework\n\nNothing sensitive here.\n");
  writeIn("LICENSE", "MIT\n");
  writeIn(".gitignore", "node_modules/\n");
  writeIn("docs/guide.md", "A normal doc with no secrets.\n");
  // The export script itself must live at <root>/scripts/ so it resolves ROOT
  // to this repo when invoked.
  const destScript = join(repo, "scripts", "make-public-export.sh");
  mkdirSync(dirname(destScript), { recursive: true });
  copyFileSync(EXPORT_SRC, destScript);
  chmodSync(destScript, 0o755);
  // Windows `git add` records a new file as 100644; the real repo tracks this
  // script 100755, and the export's W-060 exec-bit detective would (correctly)
  // abort on a 100644 .sh. Stage it 100755 in the index to match real-repo state.
  expect(git(["add", "-A"]).code).toBe(0);
  git(["update-index", "--chmod=+x", "--", "scripts/make-public-export.sh"]);
  const base = git(["commit", "-q", "-m", "base"]);
  if (base.code !== 0) throw new Error(base.stderr || base.stdout);
}, T);

afterEach(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(globalCfg, { force: true }); } catch { /* ignore */ }
}, T);

describe("public-export gate (W-092)", () => {
  test("a clean, all-allowlisted tree exports green", () => {
    const r = runExport();
    if (r.code !== 0) throw new Error(`expected green export, got:\n${r.stdout}\n${r.stderr}`);
    expect(r.stdout).toMatch(/Exported a clean, history-free/i);
  }, T);

  test("an RFC-reserved .invalid fixture email is allowlisted", () => {
    writeIn("docs/fixture-email.md", "Contact fixture@example.invalid for test data only.\n");
    commitAll("reserved fixture email");
    const r = runExport();
    if (r.code !== 0) throw new Error(`expected reserved-domain fixture to export, got:\n${r.stdout}\n${r.stderr}`);
    expect(r.stdout).toMatch(/Exported a clean, history-free/i);
  }, T);

  test("(i) a stray producer report at the repo ROOT FAILS the export (root allowlist)", () => {
    writeIn("fixture-REPORT.md", "Producer report body.\n");
    commitAll("stray root report");
    const r = runExport();
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/ABORT/);
    // Named by the root-allowlist scan and/or the report-file scan.
    expect(r.stdout + r.stderr).toMatch(/fixture-REPORT\.md/);
  }, T);

  test("(ii) a producer report with model-name chatter in an allowlisted SUBDIR FAILS", () => {
    // docs/ passes the root allowlist, so this exercises the report-file scan,
    // and its Sonnet/Codex chatter is surfaced.
    writeIn("docs/session-REPORT.md", "Sonnet fallback attempted; Codex attempt failed.\n");
    commitAll("subdir report with model chatter");
    const r = runExport();
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/ABORT/);
    expect(r.stdout + r.stderr).toMatch(/docs\/session-REPORT\.md/);
    expect(r.stdout + r.stderr).toMatch(/Sonnet|Codex/);
  }, T);

  test("a stray non-report root file (any unrecognized entry) also FAILS the allowlist", () => {
    writeIn("scratch-notes.txt", "left-behind scratch\n");
    commitAll("stray root file");
    const r = runExport();
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/scratch-notes\.txt/);
  }, T);
});
