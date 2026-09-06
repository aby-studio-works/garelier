import { rmSync } from "./guard/path_guard.ts";
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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

// End-to-end integration test for the W-066 refuter gate in merge-gate.ts: the
// opt-in adversarial-verify layer on top of the Observer verdict. Drives the
// actual merge-gate.ts against a real temp git repo (like
// merge_gate_empty_merge.test.ts) and reads the result JSON, pinning the four
// behaviors the deliverable calls out:
//   - refuter UPHELD           → merge proceeds, no advisory warning
//   - refuter REFUTED          → merge HELD (status failed), studio unchanged
//   - refuter absent + high-stakes → merge proceeds + advisory warning recorded
//   - refuter absent + low-stakes  → merge proceeds, behavior unchanged (no warn)

const MERGE_GATE = join(import.meta.dir, "scripts", "merge-gate.ts");
const PM = "tpm";
const STUDIO = `garelier/t/${PM}/studio`;
const WB = `garelier/t/${PM}/workbench/#1/x`;
// merge-gate.ts spawns bun (parse/prune + the high-stakes read); generous budget.
const T = 90_000;

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

const W066_FIXTURE_DIR = `__garelier/${PM}/runtime/fixtures/w066`;
// W-734: one declaration, consumed twice — seeded into the branch base so the
// authority resolves at HEAD, and rewritten per case so the worktree matches.
const W066_AUTHORITY_FILES = [
  { rel: `${W066_FIXTURE_DIR}/assignment.md`, content: "# W-066 fixture\n" },
  { rel: `${W066_FIXTURE_DIR}/prompt.md`, content: "Exercise W-066 merge admission.\n" },
  { rel: `${W066_FIXTURE_DIR}/report.md`, content: "# W-066 fixture report\n" },
  {
    rel: `${W066_FIXTURE_DIR}/instructions.md`,
    content: "+++\n[ledger]\nkind = 'role_instruction_ledger_v1'\n\n[[instruction]]\nid = 'I1'\nmessage = 'W-066 fixture'\nchecked = true\nconsumed = 'aggregate'\n+++\n",
  },
] as const;

function roleEvidence() {
  const fixture = W066_FIXTURE_DIR;
  const assignment = join(repo, fixture, "assignment.md");
  const prompt = join(repo, fixture, "prompt.md");
  const report = join(repo, fixture, "report.md");
  const ledger = join(repo, fixture, "instructions.md");
  for (const file of W066_AUTHORITY_FILES) writeIn(file.rel, file.content);
  const identity = roleExecutionIdentityForBranch(WB);
  const authorization = issueRoleAuthorization({
    project_root: repo, pm_id: PM, identity, role: "worker", carabiner: "implementation",
    item: { work_id: "W-066", revision: "fixture", session_id: "cs-w066", authority_path: assignment },
    assignment_path: assignment, prompt_path: prompt, initial_instructions_path: ledger,
    routing: { provider: "attended-agent", model: "test-model", effort: "medium", source: "aggregate" },
    lens: { ref: null, source: "none", registry_path: null, pack_path: null },
    knowledge: resolveRoleKnowledgeBinding({ projectRoot: repo, pmId: PM, role: "worker", required: [] }),
    integration: { ref: STUDIO, base_sha: git(repo, "rev-parse", STUDIO).stdout.trim() },
    issuer: { role: "dock", id: "aggregate" },
  });
  acknowledgeRoleLaunch({
    project_root: repo, pm_id: PM, identity, generation: authorization.core.generation,
    expect_digest: authorization.core_digest, transport: "attended-agent", provider_session_id: "agent-w066",
    success_evidence: "aggregate launch", writer: { role: "attended-parent", id: "aggregate" },
  });
  closeRoleBinding({
    project_root: repo, pm_id: PM, identity, generation: authorization.core.generation,
    expect_digest: authorization.core_digest, candidate_sha: git(repo, "rev-parse", WB).stdout.trim(),
    report_path: report, ledger_path: ledger, writer: { role: "admission-controller", id: "aggregate" },
  });
  return { role_binding: bindingReference(authorization), role_report_path: report };
}

// A real (non-empty) workbench→studio merge with a passing quality gate. Extra
// request fields (refuter_verdict / high_stakes / …) are merged into the JSON.
function setupRepo() {
  repo = mkdtempSync(join(tmpdir(), "garelier-mg-refuter-"));
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
  seedFixtureItemAuthority(repo, W066_AUTHORITY_FILES);
  studioBase = git(repo, "rev-parse", STUDIO).stdout.trim();
  workbenchBase = git(repo, "rev-parse", WB).stdout.trim();
}

function setup(extra: Record<string, unknown>) {
  // beforeEach restored the immutable branch seed; only the request varies.
  writeIn(`__garelier/${PM}/_crew/pm/setup_config.toml`, "[guardian_policy]\nenabled = false\n");
  const reqDir = `__garelier/${PM}/runtime/merge_gate/requests`;
  const req = {
    request_id: "req1",
    workbench_branch: WB,
    studio_branch: STUDIO,
    target_root: repo,
    quality_gate_commands: ["true"], // passing gate
    merge_message: "merge x into studio",
    ...roleEvidence(),
    ...extra,
  };
  writeIn(join(reqDir, "req1.json"), JSON.stringify(req, null, 2));
  return join(repo, reqDir, "req1.json");
}

function result(): Record<string, unknown> {
  const p = join(repo, `__garelier/${PM}/runtime/merge_gate/results/req1.json`);
  expect(existsSync(p)).toBe(true);
  return JSON.parse(readFileSync(p, "utf8"));
}

beforeAll(() => { setupRepo(); }, T);

beforeEach(() => {
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

afterAll(() => {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
}, T);

describe("merge-gate.ts refuter gate (W-066)", () => {
  test("refuter UPHELD → merge proceeds, no advisory warning", () => {
    const reqPath = setup({ refuter_verdict: "UPHELD" });
    const r = runBun(repo, MERGE_GATE, reqPath);
    expect(r.code).toBe(0);
    const res = result();
    expect(res.status).toBe("success");
    expect(res.refuter_warning).toBeNull();
  }, T);

  test("refuter REFUTED → merge HELD (failed), studio not advanced", () => {
    const reqPath = setup({ refuter_verdict: "REFUTED" });
    const studioBefore = git(repo, "rev-parse", STUDIO).stdout.trim();
    runBun(repo, MERGE_GATE, reqPath);
    const res = result();
    expect(res.status).toBe("failed");
    expect(String(res.failure_reason)).toContain("REFUTED");
    // The gate exits before step 1 — studio must not have advanced.
    expect(git(repo, "rev-parse", STUDIO).stdout.trim()).toBe(studioBefore);
  }, T);

  test("refuter absent + high-stakes flag → merge proceeds + advisory warning recorded", () => {
    const reqPath = setup({ high_stakes: true }); // no refuter_verdict
    const r = runBun(repo, MERGE_GATE, reqPath);
    expect(r.code).toBe(0);
    const res = result();
    expect(res.status).toBe("success"); // advisory is NON-blocking
    expect(String(res.refuter_warning)).toContain("without a refuter verdict");
  }, T);

  test("refuter absent + low-stakes → merge proceeds, behavior unchanged (no warn)", () => {
    const reqPath = setup({}); // no refuter_verdict, no high_stakes
    const r = runBun(repo, MERGE_GATE, reqPath);
    expect(r.code).toBe(0);
    const res = result();
    expect(res.status).toBe("success");
    expect(res.refuter_warning).toBeNull();
  }, T);
});
