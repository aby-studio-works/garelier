import { rmSync } from "./guard/path_guard.ts";
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { requireRuntimeExecutable } from "./scripts/_lib.ts";
import { loadConfig } from "./config.ts";
import { mergeGatePaths, pollMergeGate } from "./merge_gate.ts";
import { Logger } from "./log.ts";
import {
  acknowledgeRoleLaunch,
  bindingReference,
  closeRoleBinding,
  dispatchExecutionIdentity,
  issueRoleAuthorization,
  roleExecutionIdentityForBranch,
} from "./dispatch/role_binding.ts";
import { resolveRoleKnowledgeBinding } from "./dispatch/knowledge_binding.ts";
import { seedFixtureItemAuthority } from "./dispatch/fixture_item_authority.ts";

// Integration test for merge-gate.ts's already-up-to-date short-circuit (W-055,
// point 3). When a re-submitted request's workbench tip is already an ancestor
// of studio (e.g. its content was absorbed into an earlier commit), step 3's
// `git merge --no-ff --no-commit` prints "Already up to date." and writes no
// MERGE_HEAD, so step 5 would hit "nothing to commit" and abort. The gate must
// instead complete as success (idempotent re-submission).

const PM = "tpm";
const STUDIO = `garelier/t/${PM}/studio`;
const WB = `garelier/t/${PM}/workbench/#1/x`;
// merge-gate.ts spawns bun (parse/prune); give a generous budget under load.
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
// A consumed instruction ledger in its canonical machine form. The fixture has
// to decode, or every admission below refuses on the ledger and stops measuring
// what the test is named for.
const consumedLedger = (message: string) => [
  "+++", "[ledger]", "kind = 'role_instruction_ledger_v1'", "",
  "[[instruction]]", "id = 'I1'", `message = '${message}'`,
  "checked = true", "consumed = '''aggregate'''", "+++", "", "# Instruction ledger", "",
].join("\n");
let repo: string;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}, T);

function writeIn(rel: string, content: string) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// W-734: both variants are seeded, because which one a case uses is decided by
// its `dispatchBound` flag long after the branch base is built.
function w055AuthorityFiles(dispatchBound: boolean) {
  const fixture = dispatchBound
    ? `__garelier/${PM}/_crew/dispatch1`
    : `__garelier/${PM}/runtime/fixtures/w055`;
  return [
    { rel: `${fixture}/assignment.md`, content: "# W-055 fixture\n" },
    { rel: `${fixture}/prompt.md`, content: "Exercise W-055 merge admission.\n" },
    { rel: `${fixture}/${dispatchBound ? "lane/result.md" : "report.md"}`, content: "# W-055 fixture report\n" },
    { rel: `${fixture}/instructions.md`, content: consumedLedger("W-055 fixture") },
  ] as const;
}

function roleEvidence(dispatchBound: boolean) {
  const fixture = dispatchBound
    ? `__garelier/${PM}/_crew/dispatch1`
    : `__garelier/${PM}/runtime/fixtures/w055`;
  const assignment = join(repo, fixture, "assignment.md");
  const prompt = join(repo, fixture, "prompt.md");
  const report = join(repo, fixture, dispatchBound ? "lane/result.md" : "report.md");
  const ledger = join(repo, fixture, "instructions.md");
  writeIn(join(fixture, "assignment.md"), "# W-055 fixture\n");
  writeIn(join(fixture, "prompt.md"), "Exercise W-055 merge admission.\n");
  writeIn(join(fixture, dispatchBound ? "lane/result.md" : "report.md"), "# W-055 fixture report\n");
  writeIn(join(fixture, "instructions.md"), consumedLedger("W-055 fixture"));
  const identity = dispatchBound ? dispatchExecutionIdentity(1) : roleExecutionIdentityForBranch(WB);
  const authorization = issueRoleAuthorization({
    project_root: repo, pm_id: PM, identity, role: "worker", carabiner: "implementation",
    item: { work_id: "W-055", revision: "fixture", session_id: "cs-w055", authority_path: assignment },
    assignment_path: assignment, prompt_path: prompt, initial_instructions_path: ledger,
    routing: { provider: "attended-agent", model: "test-model", effort: "medium", source: "aggregate" },
    lens: { ref: null, source: "none", registry_path: null, pack_path: null },
    knowledge: resolveRoleKnowledgeBinding({ projectRoot: repo, pmId: PM, role: "worker", required: [] }),
    integration: { ref: STUDIO, base_sha: git(repo, "rev-parse", STUDIO).stdout.trim() },
    issuer: { role: "dock", id: "aggregate" },
  });
  acknowledgeRoleLaunch({
    project_root: repo, pm_id: PM, identity, generation: authorization.core.generation,
    expect_digest: authorization.core_digest, transport: "attended-agent", provider_session_id: "agent-w055",
    success_evidence: "aggregate launch", writer: { role: "attended-parent", id: "aggregate" },
  });
  closeRoleBinding({
    project_root: repo, pm_id: PM, identity, generation: authorization.core.generation,
    expect_digest: authorization.core_digest, candidate_sha: git(repo, "rev-parse", WB).stdout.trim(),
    report_path: report, ledger_path: ledger, writer: { role: "admission-controller", id: "aggregate" },
  });
  return {
    role_binding: bindingReference(authorization),
    role_report_path: report,
    ...(dispatchBound ? { dispatch_id: "1", dispatch_container: join(repo, fixture) } : {}),
  };
}

// Build a project + git repo. `alreadyMerged` controls whether the workbench is
// pre-merged into studio (empty re-merge) or still distinct (real merge).
function setup(alreadyMerged: boolean, gateCmd: string, dispatchBound = false, coreEnvName = "CARGO_INCREMENTAL") {
  repo = mkdtempSync(join(tmpdir(), "garelier-mg-"));
  roots.push(repo);
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
  if (alreadyMerged) {
    // Land the workbench first, so a later gate re-merge is a no-op.
    git(repo, "merge", "--no-ff", "--no-commit", WB);
    git(repo, "commit", "-q", "-m", `absorbed ${WB}`);
  }
  // W-734: role authorization reads the item authority from HEAD, so it has to
  // be committed before the gate runs.
  seedFixtureItemAuthority(repo, [...w055AuthorityFiles(false), ...w055AuthorityFiles(true)]);
  writeIn(`__garelier/${PM}/_crew/pm/setup_config.toml`, `[project]\nname = "merge-gate-fixture"\n\n[branches]\ntarget = "main"\nintegration = "${STUDIO}"\n\n[guardian_policy]\nenabled = false\n\n[[dispatch.env]]\nname = "PROJECT_GATE_ENV"\nvalue = "merge-child-observed"\nwhy = "fixture proves gate child delivery"\napplies_to = ["gate"]\n\n[[dispatch.env]]\nname = "${coreEnvName}"\nvalue = "project-declared-override"\nwhy = "fixture proves core-owned gate environment wins collisions"\napplies_to = ["gate"]\n\n[[dispatch.env]]\nname = "git_config_count"\nvalue = "project-declared-override"\nwhy = "fixture proves every core-owned environment key wins collisions"\napplies_to = ["gate"]\n\n[[dispatch.env]]\nname = "GIT_CONFIG_KEY_0"\nvalue = "project-declared-key"\nwhy = "fixture keeps the paired core collision observable"\napplies_to = ["gate"]\n\n[[dispatch.env]]\nname = "GIT_CONFIG_VALUE_0"\nvalue = "project-declared-value"\nwhy = "fixture keeps the paired core collision observable"\napplies_to = ["gate"]\n\n[[dispatch.env]]\nname = "PROJECT_GATE_ROLE"\nvalue = "{role}"\nwhy = "fixture proves unavailable merge-gate context is surfaced"\napplies_to = ["gate"]\n`);
  const reqDir = `__garelier/${PM}/runtime/merge_gate/requests`;
  const req = {
    request_id: "req1",
    workbench_branch: WB,
    studio_branch: STUDIO,
    target_root: repo,
    quality_gate_commands: [gateCmd],
    merge_message: `merge x into studio`,
    ...roleEvidence(dispatchBound),
  };
  writeIn(join(reqDir, "req1.json"), JSON.stringify(req, null, 2));
  return join(repo, reqDir, "req1.json");
}

function result(): Record<string, unknown> {
  const p = join(repo, `__garelier/${PM}/runtime/merge_gate/results/req1.json`);
  expect(existsSync(p)).toBe(true);
  return JSON.parse(readFileSync(p, "utf8"));
}

async function runThroughPoller(requestPath: string): Promise<void> {
  const config = loadConfig(repo, PM);
  const paths = mergeGatePaths(repo, PM);
  const polled = await pollMergeGate(repo, config, new Logger("merge-gate-empty-test"));
  expect(polled.spawnedRequestId).toBe("req1");
  const deadline = Date.now() + T - 5_000;
  while (!existsSync(join(paths.resultsDir, "req1.json")) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    await pollMergeGate(repo, config, new Logger("merge-gate-empty-test"));
  }
  expect(existsSync(join(paths.resultsDir, "req1.json"))).toBeTrue();
  expect(requestPath).toBe(join(paths.requestsDir, "req1.json"));
}

async function withSafeDirectoryEnv(runWithEnv: () => Promise<void>): Promise<void> {
  const names = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "PROJECT_GATE_ENV"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "safe.directory";
  process.env.GIT_CONFIG_VALUE_0 = repo;
  process.env.PROJECT_GATE_ENV = "ambient-must-not-win";
  try {
    await runWithEnv();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("merge-gate.ts already-up-to-date short-circuit (W-055)", () => {
  test("W-389: dispatch ledger stays at the container root while an already-merged request skips the gate", async () => {
    // The gate command would FAIL if executed — proving the short-circuit skips it.
    const reqPath = setup(true, "exit 1", true);
    const studioBefore = git(repo, "rev-parse", STUDIO).stdout.trim();
    await runThroughPoller(reqPath);
    const res = result();
    expect(res.status, JSON.stringify(res)).toBe("success");
    // Studio must not have advanced (no new merge commit).
    expect(git(repo, "rev-parse", STUDIO).stdout.trim()).toBe(studioBefore);
    // Gate marker: an empty gate_steps array means the quality gate never ran.
    expect(res.gate_steps).toEqual([]);

    const expectLedgerRefusal = async (mutate: (requestPath: string) => void, needle: string) => {
      const requestPath = setup(true, "exit 1", true);
      mutate(requestPath);
      await runThroughPoller(requestPath);
      const refused = result();
      expect(refused.status).toBe("failed");
      expect(String(refused.failure_reason)).toContain("role binding backstop refused queued request");
      expect(String(refused.failure_reason)).toContain(needle);
    };

    await expectLedgerRefusal(() => {
      rmSync(join(repo, `__garelier/${PM}/_crew/dispatch1/instructions.md`));
    }, "missing");

    await expectLedgerRefusal(() => {
      writeIn(`__garelier/${PM}/_crew/dispatch1/instructions.md`, consumedLedger("drifted ledger"));
    }, "instruction ledger");

    await expectLedgerRefusal((requestPath) => {
      const outside = mkdtempSync(join(tmpdir(), "garelier-mg-outside-"));
      roots.push(outside);
      writeFileSync(join(outside, "instructions.md"), consumedLedger("W-055 fixture"));
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      request.dispatch_container = outside;
      writeFileSync(requestPath, JSON.stringify(request, null, 2));
    }, "escapes project root");

    await expectLedgerRefusal((requestPath) => {
      const dispatch = join(repo, `__garelier/${PM}/_crew/dispatch1`);
      const alias = join(repo, `__garelier/${PM}/_crew/dispatch1-alias`);
      symlinkSync(dispatch, alias, process.platform === "win32" ? "junction" : "dir");
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      request.dispatch_container = alias;
      writeFileSync(requestPath, JSON.stringify(request, null, 2));
    }, "path does not match authorization");
  }, T);

  test("a real (non-empty) merge still runs the gate — a failing gate fails the merge", async () => {
    // A non-dispatch request retains the legacy report-sibling ledger behavior.
    const reqPath = setup(false, "exit 1");
    await runThroughPoller(reqPath);
    const res = result();
    const gateSteps = res.gate_steps as Array<Record<string, unknown>>;
    expect(res.status).toBe("failed");
    expect(res.failure_reason).toBe("quality gate command failed: 'exit 1' (exit 1)");
    expect(String(res.failure_reason)).not.toContain("role binding backstop");
    expect(res.effective_gate_commands).toEqual(["exit 1"]);
    expect(gateSteps).toHaveLength(1);
    expect(gateSteps[0]).toMatchObject({ cmd: "exit 1", exit_code: 1 });
    expect(res.dispatch_env_diagnostics).toEqual(['DISPATCH_ENV_SKIPPED name="PROJECT_GATE_ROLE" why="fixture proves unavailable merge-gate context is surfaced" unavailable_placeholders=role unavailable_reason="placeholder context is not established on this merge-gate path"']);
    expect(readFileSync(join(repo, `__garelier/${PM}/runtime/merge_gate/logs/req1.log`), "utf8")).toContain('DISPATCH_ENV_SKIPPED name="PROJECT_GATE_ROLE"');

    const nativeEnvProbe = (): string => process.platform === "win32"
      ? `pwsh -NoProfile -Command '$core = [Environment]::GetEnvironmentVariable("CARGO_INCREMENTAL"); $project = [Environment]::GetEnvironmentVariable("PROJECT_GATE_ENV"); $count = [Environment]::GetEnvironmentVariable("GIT_CONFIG_COUNT"); $key = [Environment]::GetEnvironmentVariable("GIT_CONFIG_KEY_0"); $value = [Environment]::GetEnvironmentVariable("GIT_CONFIG_VALUE_0"); if ($core -ne "0" -or $project -ne "merge-child-observed" -or $count -ne "1" -or $key -ne "safe.directory" -or $value -ne "${repo}") { exit 1 }'`
      : 'test "$PROJECT_GATE_ENV" = "merge-child-observed" && test "$CARGO_INCREMENTAL" = "0" && test "$GIT_CONFIG_COUNT" = "1" && test "$GIT_CONFIG_KEY_0" = "safe.directory" && test "$GIT_CONFIG_VALUE_0" = "$PWD"';
    for (const declaredName of ["CARGO_INCREMENTAL", "cargo_incremental"]) {
      const envReqPath = setup(false, "exit 1", false, declaredName);
      const request = JSON.parse(readFileSync(envReqPath, "utf8")) as { quality_gate_commands: string[] };
      request.quality_gate_commands = [nativeEnvProbe()];
      writeFileSync(envReqPath, JSON.stringify(request, null, 2));
      await withSafeDirectoryEnv(async () => { await runThroughPoller(envReqPath); });
      const envResult = result();
      expect(envResult.status, JSON.stringify(envResult)).toBe("success");
    }
  }, T);
});
