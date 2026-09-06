import { rmSync } from "./guard/path_guard.ts";
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { requireRuntimeExecutable } from "./scripts/_lib.ts";
import {
  acknowledgeRoleLaunch,
  bindingReference,
  closeRoleBinding,
  issueRoleAuthorization,
  roleExecutionIdentityForBranch,
} from "./dispatch/role_binding.ts";
import { resolveRoleKnowledgeBinding } from "./dispatch/knowledge_binding.ts";
import { seedFixtureItemAuthority } from "./dispatch/fixture_item_authority.ts";
import { armLongJob, failLongJob, startLongJob } from "./long_jobs.ts";

// W-076: anchor auto-fire. A completed merge (merge-gate.ts) and a completed
// dispatch_cleanup are task_mirror refresh anchors (DEC-092), so each emits a
// copyable `task_mirror --format ops` command in its result — the PM applies it
// instead of hand-crafting the session Task list. These integration tests pin
// that the hint rides the gate SUCCESS result + the cleanup JSON, and that a
// non-success gate does NOT carry it (success-only). A companion doc-pin asserts
// the unified anchor protocol in pm_playbook §11.

const SCRIPTS = join(import.meta.dir, "scripts");
const MERGE_GATE = join(SCRIPTS, "merge-gate.ts");
const CLEANUP = join(SCRIPTS, "dispatch_cleanup.ts");
const LONG_JOB_RUNNER = join(SCRIPTS, "long_job_runner.ts");
const PLAYBOOK = join(import.meta.dir, "..", "..", "references", "pm_playbook.md");
const PM = "tpm";
const STUDIO = `garelier/t/${PM}/studio`;
const WB = `garelier/t/${PM}/workbench/#1/x`;
// The scripts spawn bun (parse/prune/heavy_compile_lock); give a generous budget.
const T = 90_000;
const ANCHOR_TEMP_PREFIX = "garelier-anchor-";
const ANCHOR_TEMP_TTL_MS = 24 * 60 * 60 * 1_000;

export interface AnchorTempGcResult {
  candidates: number;
  deleted: number;
  sample: string[];
}

type AnchorTempGcLog = (line: string) => void;

// W-376: anchor integration fixtures can be interrupted before afterAll runs.
// Sweep only direct temp children whose name has the exact anchor prefix and
// whose own mtime is at least 24h old; other temp entries, links, and fresh
// anchors are deliberately out of scope.
export function sweepStaleAnchorTempDirs(
  now = Date.now(),
  tempRoot = tmpdir(),
  log: AnchorTempGcLog = console.info,
): AnchorTempGcResult {
  const root = resolve(tempRoot);
  const candidates: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(ANCHOR_TEMP_PREFIX)) continue;
    const candidate = join(root, entry.name);
    try {
      const stat = lstatSync(candidate);
      if (
        dirname(candidate) === root
        && basename(candidate).startsWith(ANCHOR_TEMP_PREFIX)
        && stat.isDirectory()
        && !stat.isSymbolicLink()
        && now - stat.mtimeMs >= ANCHOR_TEMP_TTL_MS
      ) candidates.push(candidate);
    } catch {
      // A concurrent test may remove its own temporary directory after readdir.
    }
  }
  // W-756: the sweep reports which entries it is about to delete, so that
  // report has to name the SAME three entries wherever it runs. `readdirSync`
  // hands back filesystem enumeration order — sorted for free on NTFS, an
  // arbitrary permutation on ext4 — which made the logged sample (and the
  // deletion order behind it) a property of the filesystem rather than of the
  // sweep. Ordering by name here is what makes the line reproducible.
  candidates.sort((left, right) => {
    const [a, b] = [basename(left), basename(right)];
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const sample = candidates.slice(0, 3).map((path) => basename(path));
  log(`[W-376] garelier-anchor GC candidates=${candidates.length} sample=${sample.join(",") || "none"}`);

  let deleted = 0;
  for (const candidate of candidates) {
    try {
      const stat = lstatSync(candidate);
      if (
        dirname(candidate) !== root
        || !basename(candidate).startsWith(ANCHOR_TEMP_PREFIX)
        || !stat.isDirectory()
        || stat.isSymbolicLink()
        || now - stat.mtimeMs < ANCHOR_TEMP_TTL_MS
      ) continue;
      rmSync(candidate, { recursive: true, force: true });
      deleted++;
    } catch {
      // A concurrent cleanup wins; leave it out of the deleted count.
    }
  }
  return { candidates: candidates.length, deleted, sample };
}

export function runAnchorFixtureStartup(
  tempRoot = tmpdir(),
  now = Date.now(),
  log: AnchorTempGcLog = console.info,
): AnchorTempGcResult {
  return sweepStaleAnchorTempDirs(now, tempRoot, log);
}

type Run = { code: number; stdout: string; stderr: string };
const GIT = requireRuntimeExecutable("git");
function run(cwd: string, executable: string, args: string[]): Run {
  const r = spawnSync(executable, args, { windowsHide: true, cwd, encoding: "utf8", env: process.env });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function git(cwd: string, ...args: string[]): Run {
  return run(cwd, GIT, args);
}
function runBun(cwd: string, script: string, ...args: string[]): Run {
  return run(cwd, process.execPath, [script, ...args]);
}

let repo: string;
let studioBase: string;
let workbenchBase: string;

function writeIn(rel: string, content: string) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const W076_FIXTURE_DIR = `__garelier/${PM}/runtime/fixtures/w076`;
// W-734: one declaration, consumed twice — seeded into the branch base so the
// authority resolves at HEAD, and rewritten per case so the worktree matches.
const W076_AUTHORITY_FILES = [
  { rel: `${W076_FIXTURE_DIR}/assignment.md`, content: "# W-076 fixture\n" },
  { rel: `${W076_FIXTURE_DIR}/prompt.md`, content: "Exercise W-076 merge admission.\n" },
  { rel: `${W076_FIXTURE_DIR}/report.md`, content: "# W-076 fixture report\n" },
  {
    rel: `${W076_FIXTURE_DIR}/instructions.md`,
    content: "+++\n[ledger]\nkind = 'role_instruction_ledger_v1'\n\n[[instruction]]\nid = 'I1'\nmessage = 'W-076 fixture'\nchecked = true\nconsumed = 'aggregate'\n+++\n",
  },
] as const;

function roleEvidence() {
  const fixture = W076_FIXTURE_DIR;
  const assignment = join(repo, fixture, "assignment.md");
  const prompt = join(repo, fixture, "prompt.md");
  const report = join(repo, fixture, "report.md");
  const ledger = join(repo, fixture, "instructions.md");
  for (const file of W076_AUTHORITY_FILES) writeIn(file.rel, file.content);
  const identity = roleExecutionIdentityForBranch(WB);
  const authorization = issueRoleAuthorization({
    project_root: repo, pm_id: PM, identity, role: "worker", carabiner: "implementation",
    item: { work_id: "W-076", revision: "fixture", session_id: "cs-w076", authority_path: assignment },
    assignment_path: assignment, prompt_path: prompt, initial_instructions_path: ledger,
    routing: { provider: "attended-agent", model: "test-model", effort: "medium", source: "aggregate" },
    lens: { ref: null, source: "none", registry_path: null, pack_path: null },
    knowledge: resolveRoleKnowledgeBinding({ projectRoot: repo, pmId: PM, role: "worker", required: [] }),
    integration: { ref: STUDIO, base_sha: git(repo, "rev-parse", STUDIO).stdout.trim() },
    issuer: { role: "dock", id: "aggregate" },
  });
  acknowledgeRoleLaunch({
    project_root: repo, pm_id: PM, identity, generation: authorization.core.generation,
    expect_digest: authorization.core_digest, transport: "attended-agent", provider_session_id: "agent-w076",
    success_evidence: "aggregate launch", writer: { role: "attended-parent", id: "aggregate" },
  });
  closeRoleBinding({
    project_root: repo, pm_id: PM, identity, generation: authorization.core.generation,
    expect_digest: authorization.core_digest, candidate_sha: git(repo, "rev-parse", WB).stdout.trim(),
    report_path: report, ledger_path: ledger, writer: { role: "admission-controller", id: "aggregate" },
  });
  return { role_binding: bindingReference(authorization), role_report_path: report };
}

// A minimal project + git repo with a studio and a distinct workbench branch.
function baseRepo() {
  repo = mkdtempSync(join(tmpdir(), "garelier-anchor-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "ci@ci");
  git(repo, "config", "user.name", "ci");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "checkout", "-q", "-b", STUDIO);
  writeIn("base.txt", "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", WB);
  writeIn("feature.txt", "feature\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "feature");
  git(repo, "checkout", "-q", STUDIO);
  // W-734: the item authority must be IN the seed commit — role authorization
  // reads it from HEAD, and every beforeEach resets hard to studioBase.
  seedFixtureItemAuthority(repo, W076_AUTHORITY_FILES);
  studioBase = git(repo, "rev-parse", STUDIO).stdout.trim();
  workbenchBase = git(repo, "rev-parse", WB).stdout.trim();
}

function mergeRequest(gateCmd: string): string {
  writeIn(`__garelier/${PM}/_crew/pm/setup_config.toml`, "[guardian_policy]\nenabled = false\n");
  const reqDir = `__garelier/${PM}/runtime/merge_gate/requests`;
  const req = {
    request_id: "req1",
    workbench_branch: WB,
    studio_branch: STUDIO,
    target_root: repo,
    quality_gate_commands: [gateCmd],
    merge_message: `merge x into studio`,
    ...roleEvidence(),
  };
  writeIn(join(reqDir, "req1.json"), JSON.stringify(req, null, 2));
  return join(repo, reqDir, "req1.json");
}

function mergeResult(): Record<string, unknown> {
  const p = join(repo, `__garelier/${PM}/runtime/merge_gate/results/req1.json`);
  expect(existsSync(p)).toBe(true);
  return JSON.parse(readFileSync(p, "utf8"));
}

beforeAll(() => {
  runAnchorFixtureStartup();
  baseRepo();
}, T);

beforeEach(() => {
  // Merge-gate and cleanup cases share one immutable two-branch seed. Restore
  // refs/index/untracked runtime exactly before each real-process assertion.
  git(repo, "merge", "--abort");
  const checkout = git(repo, "checkout", "-q", "-f", STUDIO);
  if (checkout.code !== 0) throw new Error(checkout.stderr || checkout.stdout);
  const reset = git(repo, "reset", "-q", "--hard", studioBase);
  if (reset.code !== 0) throw new Error(reset.stderr || reset.stdout);
  git(repo, "worktree", "prune");
  const restoreWorkBench = git(repo, "update-ref", `refs/heads/${WB}`, workbenchBase);
  if (restoreWorkBench.code !== 0) throw new Error(restoreWorkBench.stderr || restoreWorkBench.stdout);
  const clean = git(repo, "clean", "-q", "-ffd");
  if (clean.code !== 0) throw new Error(clean.stderr || clean.stdout);
}, T);

afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } }, T);

describe("merge-gate.ts task_mirror anchor hint (W-076)", () => {
  test("a SUCCESS result carries a copyable task_mirror ops command", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "garelier-w376-anchor-sweep-"));
    const now = Date.now();
    const stale = Array.from({ length: 256 }, (_, index) => join(fixtureRoot, `${ANCHOR_TEMP_PREFIX}fixture-${index}`));
    const fresh = join(fixtureRoot, `${ANCHOR_TEMP_PREFIX}fresh`);
    const unrelated = join(fixtureRoot, "not-an-anchor");
    try {
      for (const path of stale) {
        mkdirSync(path);
        utimesSync(path, new Date(now - ANCHOR_TEMP_TTL_MS - 1), new Date(now - ANCHOR_TEMP_TTL_MS - 1));
      }
      mkdirSync(fresh);
      mkdirSync(unrelated);
      const startedAt = performance.now();
      const startupLog: string[] = [];
      const gc = runAnchorFixtureStartup(fixtureRoot, now, (line) => startupLog.push(line));
      const elapsedMs = performance.now() - startedAt;
      expect(gc).toEqual({ candidates: 256, deleted: 256, sample: stale.map((path) => basename(path)).sort().slice(0, 3) });
      expect(startupLog).toEqual([`[W-376] garelier-anchor GC candidates=256 sample=${stale.map((path) => basename(path)).sort().slice(0, 3).join(",")}`]);
      expect(elapsedMs).toBeLessThan(T);
      expect(stale.every((path) => !existsSync(path))).toBe(true);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
    const reqPath = mergeRequest("true"); // gate passes -> real merge succeeds
    const r = runBun(repo, MERGE_GATE, reqPath);
    expect(r.code).toBe(0);
    const res = mergeResult();
    expect(res.status).toBe("success");
    const hint = res.task_mirror_hint as string;
    expect(typeof hint).toBe("string");
    expect(hint).toContain("task_mirror.ts");
    expect(hint).toContain(`--pm-id ${PM}`);
    expect(hint).toContain("--project");
    expect(hint).toContain("--format ops");
    // The summary JSON carries it too (same success-only rule).
    const sum = JSON.parse(readFileSync(
      join(repo, `__garelier/${PM}/runtime/merge_gate/results/req1.summary.json`), "utf8"));
    expect(sum.task_mirror_hint).toBe(hint);
  }, T);

  test("a FAILED result does NOT carry the hint (success-only)", () => {
    const reqPath = mergeRequest("exit 1"); // gate fails -> merge fails
    runBun(repo, MERGE_GATE, reqPath);
    const res = mergeResult();
    expect(res.status).toBe("failed");
    expect(res.task_mirror_hint).toBeUndefined();
  }, T);
});

describe("dispatch_cleanup.ts task_mirror anchor hint (W-076)", () => {
  test("the cleanup JSON carries a copyable task_mirror ops command", () => {
    // Stand up a _crew/dispatch1 container worktree on the workbench branch, then
    // clean it up (worktree-only — no --delete-branch, so the merged-guard is inert).
    const container = `__garelier/${PM}/_crew/dispatch1`;
    mkdirSync(join(repo, container), { recursive: true });
    expect(git(repo, "worktree", "add", join(container, "checkout"), WB).code).toBe(0);
    const ledger = join(repo, `__garelier/${PM}/runtime/long_jobs`);
    mkdirSync(ledger, { recursive: true });
    const command = "bun role.ts --dispatch 1\n";
    const commandRef = join(ledger, "cleanup.command.txt");
    writeFileSync(commandRef, command);
    armLongJob({
      root: ledger, jobId: "cleanup-terminal", command, commandRef, dispatchId: "1", agentId: "fixture", provider: "codex",
      cwd: join(repo, container, "checkout"), wake: { armed: true, capability: "codex-task", source: "aggregate" },
    });
    startLongJob(ledger, "cleanup-terminal");
    failLongJob(ledger, "cleanup-terminal", 1, "fixture failure");
    const r = runBun(repo, CLEANUP, "--project", repo, "--pm-id", PM, "--id", "1", "--checkout", join(repo, container, "checkout"));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    const hint = out.task_mirror_hint as string;
    expect(typeof hint).toBe("string");
    expect(hint).toContain("task_mirror.ts");
    expect(hint).toContain(`--pm-id ${PM}`);
    expect(hint).toContain(`--project ${repo}`);
    expect(hint).toContain("--format ops");
    expect(out.long_jobs_retired).toEqual([expect.objectContaining({
      job_id: "cleanup-terminal", prior_state: "FAILED",
    })]);
    expect(existsSync(out.long_jobs_retired[0].evidence_path)).toBe(true);
    const startupScan = runBun(repo, LONG_JOB_RUNNER, "startup-scan", "--root", ledger);
    expect(startupScan.code).toBe(0);
    expect(JSON.parse(startupScan.stdout.trim()).actions).toEqual([]);
  }, T);
});

describe("pm_playbook §11 unified anchor protocol (W-076 doc pin)", () => {
  test("§11 defines the single anchor bundle + the hand-craft hot-rule", () => {
    const doc = readFileSync(PLAYBOOK, "utf8");
    // Retitled to the unified anchor protocol.
    expect(doc).toContain("## 11. anchor protocol");
    // All four anchors are rows of ONE table.
    expect(doc).toContain("| merge 完了 |");
    expect(doc).toContain("| cleanup 完了 |");
    // The bundle names its two scans.
    expect(doc).toContain("task_mirror --format ops");
    expect(doc).toContain("contract_check --stall-scan");
    // The hand-craft-forbidden hot-rule (DEC-092).
    expect(doc).toContain("hand-craft 禁止、DEC-092");
    // The result/cleanup JSON hint is referenced as the copyable command.
    expect(doc).toContain("task_mirror_hint");
  });
});
