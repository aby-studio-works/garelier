import { rmSync } from "./guard/path_guard.ts";
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { requireRuntimeExecutable } from "./scripts/_lib.ts";
import { gateCommandEnv, gateCommitEnv, gateEnv } from "./scripts/spawn_env.ts";

// Integration test for the PM commit-guard pre-commit hook
// (skills/garelier-core/scripts/hooks/pre-commit). It exercises the REAL hook
// script through real `git commit` invocations in a throwaway repo — the same
// path a live merge gate takes — because the W-055 failure is a hook/git
// interaction, not a pure function.
//
// W-055 root cause reproduced here: the async merge gate stages an in-flight
// merge (`git merge --no-ff --no-commit`) in the SHARED primary worktree/index.
// A CONCURRENT non-gate commit (PM/Dock) landing while MERGE_HEAD is present
// used to be exempted by the guard's blanket "MERGE_HEAD present -> exempt"
// rule and would ABSORB the gate's staged merge into its own commit (a 2-parent
// merge commit), emptying MERGE_HEAD so the gate found no merge at step 5.

const INSTALLER_SRC = join(import.meta.dir, "scripts", "install_pm_commit_guard.ts");
const STUDIO = "garelier/t/testpm/studio";
const WORKBENCH = "garelier/t/testpm/workbench/#1/x";
const LOCK_REL = "__garelier/testpm/runtime/merge_gate/locks/active.lock";
const CONFIG_REL = "__garelier/testpm/_crew/pm/setup_config.toml";
const MARKER = "GARELIER_MERGE_GATE_COMMIT";

// These tests spawn many git subprocesses; the default 5s per-test/hook budget
// is too tight on a loaded machine (e.g. ci.ts running beside a heavy build).
const T = 60_000;

type Run = { code: number; stdout: string; stderr: string };

function run(repo: string, cmd: string, env: Record<string, string | undefined> = {}): Run {
  const r = spawnSync(requireRuntimeExecutable("bash"), ["-c", cmd], { windowsHide: true,
    cwd: repo,
    env: { ...process.env, [MARKER]: undefined, ...env },
    encoding: "utf8",
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
}

function git(repo: string, args: string, env: Record<string, string | undefined> = {}): Run {
  return run(repo, `git ${args}`, env);
}

function gitArgs(cwd: string, args: string[], env: Record<string, string | undefined> = {}): Run {
  const r = spawnSync(requireRuntimeExecutable("git"), args, { windowsHide: true,
    cwd,
    env: { ...process.env, [MARKER]: undefined, ...env },
    encoding: "utf8",
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
}

function bunArgs(cwd: string, args: string[], env: Record<string, string | undefined> = {}): Run {
  const r = spawnSync(process.execPath, args, { windowsHide: true,
    cwd,
    env: { ...process.env, [MARKER]: undefined, ...env },
    encoding: "utf8",
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
}

let repo: string;
let linkedRoots: string[] = [];
let studioBase: string;
let workbenchBase: string;

function writeFileIn(rel: string, content: string) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function setMode(mode: "block" | "warn" | "off") {
  writeFileIn(CONFIG_REL, `[setup]\ncommit_guard = "${mode}"\n`);
}

function setLockPresent(present: boolean) {
  const abs = join(repo, LOCK_REL);
  if (present) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify({ pid: 999999, request_id: "req-1" }));
  } else if (existsSync(abs)) {
    rmSync(abs);
  }
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "garelier-guard-"));
  linkedRoots = [];
  git(repo, "init -q");
  git(repo, "config user.email ci@ci");
  git(repo, "config user.name ci");
  git(repo, "config commit.gpgsign false");
  git(repo, `checkout -q -b ${STUDIO}`);
  // Guard mode = block (the mode the incident asked to restore).
  writeFileIn(CONFIG_REL, "[setup]\ncommit_guard = \"block\"\n");
  writeFileIn("base.txt", "base\n");
  git(repo, "add -A");
  git(repo, 'commit -q -m base', { [MARKER]: "1" }); // seed commit; marker so the guard never interferes with setup
  // A workbench branch with its own change, to make a real merge.
  git(repo, `checkout -q -b ${WORKBENCH}`);
  writeFileIn("feature.txt", "feature\n");
  git(repo, "add -A");
  git(repo, "commit -q -m feature", { [MARKER]: "1" });
  git(repo, `checkout -q ${STUDIO}`);
  // Install the REAL hook through the REAL installer.
  const install = bunArgs(repo, [INSTALLER_SRC, repo]);
  if (install.code !== 0) throw new Error(install.stderr || install.stdout || `installer exited ${install.code}`);
  expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(true);
  studioBase = git(repo, `rev-parse ${STUDIO}`).stdout.trim();
  workbenchBase = git(repo, `rev-parse ${WORKBENCH}`).stdout.trim();
}, T);

function restoreSeed(): void {
  // Restore the exact shared two-branch seed without reinstalling the real hook.
  for (const linked of linkedRoots) {
    try { gitArgs(repo, ["worktree", "remove", "--force", linked]); } catch { /* ignore */ }
    try { rmSync(linked, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  linkedRoots = [];
  git(repo, "merge --abort");
  const checkout = git(repo, `checkout -q -f ${STUDIO}`);
  if (checkout.code !== 0) throw new Error(checkout.stderr || checkout.stdout);
  const reset = git(repo, `reset -q --hard ${studioBase}`);
  if (reset.code !== 0) throw new Error(reset.stderr || reset.stdout);
  const clean = git(repo, "clean -q -ffd");
  if (clean.code !== 0) throw new Error(clean.stderr || clean.stdout);
  const restoreWorkBench = git(repo, `update-ref refs/heads/${WORKBENCH} ${workbenchBase}`);
  if (restoreWorkBench.code !== 0) throw new Error(restoreWorkBench.stderr || restoreWorkBench.stdout);
}

beforeEach(() => restoreSeed(), T);

afterAll(() => {
  for (const linked of linkedRoots) {
    try { gitArgs(repo, ["worktree", "remove", "--force", linked]); } catch { /* ignore */ }
    try { rmSync(linked, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
}, T);

function startGateMerge() {
  // The gate's step 3: leaves MERGE_HEAD + a staged merge in the shared index.
  const r = git(repo, `merge --no-ff --no-commit ${WORKBENCH}`);
  expect(r.stderr + r.stdout).toContain("stopped before committing");
  expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
}

describe("commit-guard hook (W-055)", () => {
  test("a concurrent NON-gate commit does NOT absorb the gate's in-flight merge", () => {
    setLockPresent(true);
    startGateMerge();
    // A concurrent PM/Dock commit (no gate marker) stages an UNRELATED file and
    // commits. It must be refused — otherwise it swallows the gate's merge.
    writeFileIn("dashboard.md", "pm edit\n");
    git(repo, "add dashboard.md");
    const formalGateEnv = gateCommandEnv({ [MARKER]: "1" });
    expect(formalGateEnv[MARKER]).toBeUndefined();
    const r = git(repo, 'commit -m "dashboard"', formalGateEnv);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/absorb|in-flight merge|race guard/i);
    // The gate's merge must survive untouched.
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  }, T);

  test("the absorb block is HARD — a foreign commit is refused even in warn mode", () => {
    setMode("warn");
    setLockPresent(true);
    startGateMerge();
    writeFileIn("dashboard.md", "pm edit\n");
    git(repo, "add dashboard.md");
    const r = git(repo, 'commit -m "dashboard"');
    expect(r.code).not.toBe(0); // warn does NOT downgrade the absorb case
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  }, T);

  test("the absorb block is HARD — a foreign commit is refused even in off mode", () => {
    setMode("off");
    setLockPresent(true);
    startGateMerge();
    writeFileIn("dashboard.md", "pm edit\n");
    git(repo, "add dashboard.md");
    const r = git(repo, 'commit -m "dashboard"');
    expect(r.code).not.toBe(0); // off does NOT disable the absorb case
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(true);
  }, T);

  test("the gate commits its OWN in-flight merge with the marker even while the lock is held", () => {
    setLockPresent(true);
    startGateMerge();
    expect(gateEnv({ [MARKER]: "1" })[MARKER]).toBeUndefined();
    const commitEnv = gateCommitEnv();
    expect(commitEnv[MARKER]).toBe("1");
    const r2 = git(repo, 'commit -m "merge x into studio"', commitEnv);
    expect(r2.code).toBe(0);
    const parents = git(repo, "rev-list --parents -n 1 HEAD").stdout.trim().split(/\s+/);
    expect(parents.length).toBe(3); // commit + 2 parents = a real merge commit
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, T);

  test("a plain non-merge commit while the lock is held is still blocked (original race guard preserved)", () => {
    setLockPresent(true);
    writeFileIn("x.txt", "x\n");
    git(repo, "add x.txt");
    const r = git(repo, 'commit -m "x"');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/race guard|merge gate lock/i);
  }, T);

  test("with NO lock present a normal merge commit is allowed (exemption preserved)", () => {
    setLockPresent(false);
    startGateMerge();
    const r = git(repo, 'commit -m "user merge"');
    expect(r.code).toBe(0);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, T);
});

describe("commit-guard hook self-scope (W-158)", () => {
  test("a linked worktree commit on a workbench branch is not blocked by the main-worktree guard", () => {
    const linked = `${repo}-linked`;
    linkedRoots.push(linked);

    const addWt = gitArgs(repo, ["worktree", "add", "-q", linked, WORKBENCH]);
    if (addWt.code !== 0) throw new Error(addWt.stderr || addWt.stdout);

    writeFileSync(join(linked, "linked.txt"), "linked worktree edit\n");
    expect(git(linked, "add linked.txt").code).toBe(0);
    const r = git(linked, 'commit -m "linked worktree edit"');

    if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  }, T);

  test("a main worktree commit on a non-studio branch is still blocked", () => {
    expect(git(repo, `checkout -q ${WORKBENCH}`).code).toBe(0);

    writeFileIn("main-wrong-branch.txt", "main worktree edit\n");
    expect(git(repo, "add main-wrong-branch.txt").code).toBe(0);
    const r = git(repo, 'commit -m "main wrong branch"');

    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not an integration|non-studio branch|misplace guard/i);
  }, T);
});

// W-092: fail-closed commit boundary. The guard rejects a commit that stages a
// transient dev artifact that must never be tracked — the class that leaked to
// the public repo (a role report) plus the runtime/agent trees. It runs on
// EVERY worktree (before the main-worktree self-scope), because a role
// LINKED worktree is exactly where a stray report gets committed.
describe("commit-guard hook forbidden paths (W-092)", () => {
  const cases: Array<[string, string]> = [
    ["merge-gate/agent runtime state", ".claude/runtime/merge_gate/state.json"],
    ["a role report at the repo root", "W-999-REPORT.md"],
    ["an agent config tree (.agents/)", ".agents/config.toml"],
    ["an agent config tree (.codex/)", ".codex/config.toml"],
  ];

  test("every forbidden path class is rejected", () => {
    const failures: Error[] = [];
    for (const [label, rel] of cases) {
      try {
        writeFileIn(rel, "transient dev artifact\n");
        expect(git(repo, `add ${rel}`).code).toBe(0);
        const r = git(repo, `commit -m "stage ${rel}"`);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toMatch(/must never be tracked|W-092/i);
        expect(r.stderr).toContain(rel);
      } catch (error) {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error);
        failures.push(new Error(`${label} (${rel}): ${detail}`));
      } finally {
        restoreSeed();
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} forbidden path class(es) failed`);
    }
  }, T);

  test("the one-off override (GARELIER_ALLOW_FORBIDDEN_PATHS=1) lets it through", () => {
    writeFileIn("W-999-REPORT.md", "report\n");
    expect(git(repo, "add W-999-REPORT.md").code).toBe(0);
    const r = git(repo, 'commit -m "override"', { GARELIER_ALLOW_FORBIDDEN_PATHS: "1" });
    expect(r.code).toBe(0);
  }, T);

  test("a normal file at the root is NOT a false positive", () => {
    // A plain root .md that is not report-shaped must commit fine.
    writeFileIn("NOTES.md", "normal notes\n");
    expect(git(repo, "add NOTES.md").code).toBe(0);
    const r = git(repo, 'commit -m "normal notes"');
    expect(r.code).toBe(0);
  }, T);

  test("the guard fires on a LINKED role worktree too (the real leak path)", () => {
    const linked = `${repo}-fp-linked`;
    linkedRoots.push(linked);
    const addWt = gitArgs(repo, ["worktree", "add", "-q", linked, WORKBENCH]);
    if (addWt.code !== 0) throw new Error(addWt.stderr || addWt.stdout);

    writeFileSync(join(linked, "W-999-REPORT.md"), "role report left in a worktree\n");
    expect(git(linked, "add W-999-REPORT.md").code).toBe(0);
    const r = git(linked, 'commit -m "stray report in linked worktree"');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/must never be tracked|W-092/i);
  }, T);
});
