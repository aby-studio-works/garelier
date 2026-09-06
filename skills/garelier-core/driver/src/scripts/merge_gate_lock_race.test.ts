import { seedFixtureItemAuthority } from "../dispatch/fixture_item_authority.ts";
import { rmSync } from "../guard/path_guard.ts";
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  acknowledgeRoleLaunch,
  bindingReference,
  closeRoleBinding,
  issueRoleAuthorization,
  roleExecutionIdentityForBranch,
  type RoleKind,
} from "../dispatch/role_binding.ts";
import { resolveRoleKnowledgeBinding } from "../dispatch/knowledge_binding.ts";

// W-169 (f): the arbiter-wiring unit tests (merge_gate_lock.test.ts) exercise
// classifyActiveLock in isolation. This complements them with a REAL two-process
// race on the actual `wx` (noclobber) create — the OS-atomic arbiter — to prove
// end-to-end mutual exclusion: exactly one racer proceeds, the other backs off,
// so two runners never both stage a `git merge`. The assertion is order-
// independent (exactly-one-winner), so it does not flake on process-start jitter
// (the W-148 class the scoping note warns against).

const LOCK_MODULE = join(dirname(fileURLToPath(import.meta.url)), "merge_gate_lock.ts");
const MERGE_GATE = join(dirname(fileURLToPath(import.meta.url)), "merge-gate.ts");
const GATE_RESULT_WAITER = join(dirname(fileURLToPath(import.meta.url)), "gate_result_waiter.ts");
const STUDIO = "garelier/t/tpm/studio";
const ARTISAN_BRANCH = "garelier/t/tpm/satchel/#1/w206";
const DOCK_BRANCH = "garelier/t/tpm/workbench/#2/w206";

// A minimal driver: acquire the shared lock with a distinct request id and this
// process's own (live) pid, then print the numeric rc. isAlive is fixed true —
// both racers ARE live, so the arbiter is purely the atomic create (a loser reads
// the winner's LIVE different-request lock → "different" → 10).
function driverSource(lockPath: string, reqId: string): string {
  return [
    `import { acquireActiveLockAt } from ${JSON.stringify(LOCK_MODULE)};`,
    `const rc = acquireActiveLockAt({`,
    `  lockPath: ${JSON.stringify(lockPath)},`,
    `  requestId: ${JSON.stringify(reqId)},`,
    `  ownerPid: String(process.pid),`,
    `  lockBody: JSON.stringify({ pid: process.pid, request_id: ${JSON.stringify(reqId)} }) + "\\n",`,
    `  isAlive: () => true,`,
    `});`,
    `process.stdout.write(String(rc));`,
  ].join("\n");
}

function runProcess(args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { windowsHide: true, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function waitForFile(path: string, label: string, timeoutMs = 10_000): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let watcher: ReturnType<typeof watch> | undefined;
    const timer = setTimeout(() => {
      watcher?.close();
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    const finish = () => {
      if (!existsSync(path)) return;
      clearTimeout(timer);
      watcher?.close();
      resolve();
    };
    watcher = watch(dirname(path), finish);
    finish();
  });
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    windowsHide: true,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

// W-734: the item authority has to be IN the base commit. This test asserts
// studio never advances (`rev-parse STUDIO` must still equal the base SHA), so
// committing the fixture later — after that SHA is captured — would both break
// the assertion and desynchronise the authorization's declared base.
function w206AuthorityFiles(root: string, key: string) {
  const fixture = join(root, "__garelier", "tpm", "runtime", "fixtures", key);
  return [
    { rel: join(fixture, "assignment.md"), content: `# ${key} fixture\n` },
    { rel: join(fixture, "prompt.md"), content: `Exercise ${key} merge admission.\n` },
    { rel: join(fixture, "report.md"), content: `# ${key} fixture report\n` },
    {
      rel: join(fixture, "instructions.md"),
      content: [
        "+++", "[ledger]", "kind = 'role_instruction_ledger_v1'", "",
        "[[instruction]]", "id = 'I1'", `message = '${key} fixture'`,
        "checked = true", "consumed = '''aggregate'''", "+++", "", "# Instruction ledger", "",
      ].join("\n"),
    },
  ];
}

function roleEvidence(options: {
  root: string;
  branch: string;
  role: RoleKind;
  key: string;
  candidate: string;
  studioBase: string;
}) {
  const fixture = join(options.root, "__garelier", "tpm", "runtime", "fixtures", options.key);
  mkdirSync(fixture, { recursive: true });
  const assignment = join(fixture, "assignment.md");
  const prompt = join(fixture, "prompt.md");
  const report = join(fixture, "report.md");
  const ledger = join(fixture, "instructions.md");
  // W-734: the authority is already committed into the base (see setup below);
  // rewrite the same bytes so the worktree matches what HEAD carries.
  for (const file of w206AuthorityFiles(options.root, options.key)) {
    writeFileSync(file.rel, file.content);
  }
  const identity = roleExecutionIdentityForBranch(options.branch);
  const authorization = issueRoleAuthorization({
    project_root: options.root, pm_id: "tpm", identity, role: options.role,
    carabiner: options.role === "artisan" ? "end_to_end_creation" : "implementation",
    item: { work_id: `W-206-${options.key}`, revision: "fixture", session_id: `cs-${options.key}`, authority_path: assignment },
    assignment_path: assignment, prompt_path: prompt, initial_instructions_path: ledger,
    routing: { provider: "attended-agent", model: "test-model", effort: "medium", source: "aggregate" },
    lens: { ref: null, source: "none", registry_path: null, pack_path: null },
    knowledge: resolveRoleKnowledgeBinding({ projectRoot: options.root, pmId: "tpm", role: options.role, required: [] }),
    integration: { ref: STUDIO, base_sha: options.studioBase },
    issuer: { role: "dock", id: "aggregate" },
  });
  acknowledgeRoleLaunch({
    project_root: options.root, pm_id: "tpm", identity, generation: authorization.core.generation,
    expect_digest: authorization.core_digest, transport: "attended-agent", provider_session_id: `agent-${options.key}`,
    success_evidence: "aggregate launch", writer: { role: "attended-parent", id: "aggregate" },
  });
  closeRoleBinding({
    project_root: options.root, pm_id: "tpm", identity, generation: authorization.core.generation,
    expect_digest: authorization.core_digest, candidate_sha: options.candidate,
    report_path: report, ledger_path: ledger, writer: { role: "admission-controller", id: "aggregate" },
  });
  return { role_binding: bindingReference(authorization), role_report_path: report };
}

test("W-169 (f)/W-337: real lock racers serialize and schema-3 waiter observes Control settlement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mg-race-"));
  try {
    const lockPath = join(dir, "active.lock");
    const d1 = join(dir, "d1.ts"); writeFileSync(d1, driverSource(lockPath, "req-A"));
    const d2 = join(dir, "d2.ts"); writeFileSync(d2, driverSource(lockPath, "req-B"));

    const [p1, p2] = await Promise.all([runProcess([d1]), runProcess([d2])]);
    const rc1 = p1.stdout.trim();
    const rc2 = p2.stdout.trim();

    // Exactly one winner (rc 0) and one back-off (rc 10/11) — never two winners.
    expect([rc1, rc2].filter((r) => r === "0").length, `rc1=${rc1} rc2=${rc2}`).toBe(1);
    expect([rc1, rc2].filter((r) => r === "10" || r === "11").length, `rc1=${rc1} rc2=${rc2}`).toBe(1);

    // The surviving lock belongs to the winner (a real request id, well-formed).
    expect(existsSync(lockPath)).toBe(true);
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { request_id: string };
    expect(["req-A", "req-B"]).toContain(held.request_id);

    const project = join(dir, "project");
    const pmRoot = join(project, "__garelier", "tpm");
    const resultPath = join(pmRoot, "runtime", "merge_gate", "results", "req-control.json");
    const namespaceLock = join(pmRoot, "runtime", "control", "locks", "namespace.lock");
    mkdirSync(dirname(resultPath), { recursive: true });
    mkdirSync(dirname(namespaceLock), { recursive: true });
    const studioCommit = "a".repeat(40);
    writeFileSync(resultPath, JSON.stringify({
      request_id: "req-control",
      status: "success",
      studio_commit: studioCommit,
      control_schema_version: 3,
      control_update: null,
    }));
    writeFileSync(namespaceLock, JSON.stringify({ operation: "merge-evidence", request_id: "req-control" }));

    let waiterFinished = false;
    const waiter = runProcess([
      GATE_RESULT_WAITER, "--project", project, "--pm-id", "tpm", "--request-id", "req-control",
      "--max-wait", "3", "--poll-interval", "1",
    ]).then((outcome) => { waiterFinished = true; return outcome; });
    await Bun.sleep(200);
    expect(waiterFinished).toBe(false);
    expect(existsSync(namespaceLock)).toBe(true);
    writeFileSync(resultPath, JSON.stringify({
      request_id: "req-control",
      status: "success",
      studio_commit: studioCommit,
      control_schema_version: 3,
      control_update: { status: "ok", state: "verification", released: true },
    }));
    rmSync(namespaceLock, { force: false });
    const settled = await waiter;
    expect(settled.code, settled.stderr).toBe(0);
    expect(settled.stdout).toBe(`MERGE_RESULT: success req-control ${studioCommit}\n`);

    writeFileSync(resultPath, JSON.stringify({
      request_id: "req-control",
      status: "success",
      studio_commit: studioCommit,
      control_schema_version: 3,
      control_update: null,
    }));
    writeFileSync(namespaceLock, JSON.stringify({ operation: "merge-evidence", request_id: "req-control" }));
    const timedOut = await runProcess([
      GATE_RESULT_WAITER, "--project", project, "--pm-id", "tpm", "--request-id", "req-control",
      "--max-wait", "1", "--poll-interval", "1",
    ]);
    expect(timedOut.code).toBe(125);
    expect(timedOut.stdout).toContain("MERGE_CONTROL_SETTLEMENT_TIMEOUT: req-control waited 1s");
    expect(timedOut.stdout).toContain("do not re-submit it or reclaim runtime/control/locks/namespace.lock");
    expect(existsSync(namespaceLock)).toBe(true);
    expect(JSON.parse(readFileSync(resultPath, "utf8")).control_update).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("W-206: Dock and Artisan requests serialize through one real-repo active.lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "mg-route-race-"));
  try {
    git(root, "init");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, "add", "base.txt");
    git(root, "commit", "-m", "base");
    git(root, "branch", "-M", STUDIO);
    // W-734: both roles' authority rides the base commit, before the SHA this
    // test pins as "studio must not advance" is captured.
    seedFixtureItemAuthority(root, [
      ...w206AuthorityFiles(root, "artisan"),
      ...w206AuthorityFiles(root, "dock"),
    ]);
    const expectedStudioSha = git(root, "rev-parse", "HEAD");

    git(root, "checkout", "-b", ARTISAN_BRANCH);
    writeFileSync(join(root, "artisan.txt"), "artisan\n");
    git(root, "add", "artisan.txt");
    git(root, "commit", "-m", "artisan");
    const artisanTip = git(root, "rev-parse", "HEAD");

    git(root, "checkout", STUDIO);
    git(root, "checkout", "-b", DOCK_BRANCH);
    writeFileSync(join(root, "dock.txt"), "dock\n");
    git(root, "add", "dock.txt");
    git(root, "commit", "-m", "dock");
    const dockTip = git(root, "rev-parse", "HEAD");
    git(root, "checkout", STUDIO);

    const mergeGateRoot = join(root, "__garelier", "tpm", "runtime", "merge_gate");
    const requests = join(mergeGateRoot, "requests");
    const results = join(mergeGateRoot, "results");
    const lockPath = join(mergeGateRoot, "locks", "active.lock");
    const gateStarted = join(root, "artisan-gate.started");
    const gateRelease = join(root, "artisan-gate.release");
    mkdirSync(requests, { recursive: true });
    mkdirSync(join(root, "__garelier", "tpm", "_crew", "pm"), { recursive: true });
    writeFileSync(join(root, "__garelier", "tpm", "_crew", "pm", "setup_config.toml"), "[guardian_policy]\nenabled = false\n");
    writeFileSync(join(root, "hold-artisan-gate.ts"), [
      `import { existsSync, watch, writeFileSync } from "node:fs";`,
      `import { dirname } from "node:path";`,
      `writeFileSync(${JSON.stringify(gateStarted)}, "started\\n");`,
      `const release = ${JSON.stringify(gateRelease)};`,
      `if (!existsSync(release)) await new Promise((resolve, reject) => {`,
      `  let watcher;`,
      `  const timer = setTimeout(() => { watcher?.close(); reject(new Error("release deadline")); }, 15_000);`,
      `  const finish = () => { if (!existsSync(release)) return; clearTimeout(timer); watcher?.close(); resolve(); };`,
      `  watcher = watch(dirname(release), finish);`,
      `  finish();`,
      `});`,
    ].join("\n"));

    const artisanRequest = join(requests, "req-artisan.json");
    const dockRequest = join(requests, "req-dock.json");
    writeFileSync(artisanRequest, JSON.stringify({
      request_id: "req-artisan",
      workbench_branch: ARTISAN_BRANCH,
      studio_branch: STUDIO,
      target_root: root,
      merge_message: "merge artisan",
      guardian_verdict: "PASS",
      execution_route: "artisan",
      expected_studio_sha: expectedStudioSha,
      quality_gate_commands: ["bun hold-artisan-gate.ts"],
      ...roleEvidence({
        root, branch: ARTISAN_BRANCH, role: "artisan", key: "artisan",
        candidate: artisanTip, studioBase: expectedStudioSha,
      }),
    }));
    writeFileSync(dockRequest, JSON.stringify({
      request_id: "req-dock",
      workbench_branch: DOCK_BRANCH,
      studio_branch: STUDIO,
      target_root: root,
      merge_message: "merge dock",
      guardian_verdict: "PASS",
      execution_route: "dock",
      quality_gate_commands: ["true"],
      ...roleEvidence({
        root, branch: DOCK_BRANCH, role: "worker", key: "dock",
        candidate: dockTip, studioBase: expectedStudioSha,
      }),
    }));

    // Both requests exist together. Artisan intentionally reaches its gate first
    // and holds the production lock while Dock makes a real concurrent attempt.
    const artisanRun = runProcess([MERGE_GATE, artisanRequest], root);
    await Promise.race([
      waitForFile(gateStarted, "Artisan gate readiness", 30_000),
      artisanRun.then((outcome) => {
        const resultPath = join(results, "req-artisan.json");
        const result = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "<no result>";
        throw new Error(`Artisan exited before gate readiness: code=${outcome.code}\n${outcome.stderr || outcome.stdout}\n${result}`);
      }),
    ]);
    expect(existsSync(lockPath)).toBe(true);

    const dockFirstAttempt = await runProcess([MERGE_GATE, dockRequest], root);
    expect(dockFirstAttempt.code, dockFirstAttempt.stderr).toBe(0);
    expect(dockFirstAttempt.stderr).toContain("queued behind a live active.lock");
    expect(existsSync(join(results, "req-dock.json"))).toBe(false);
    expect(git(root, "rev-parse", STUDIO)).toBe(expectedStudioSha);
    const held = JSON.parse(readFileSync(lockPath, "utf8")) as { request_id: string };
    expect(held.request_id).toBe("req-artisan");

    writeFileSync(gateRelease, "release\n");
    const artisanFinished = await artisanRun;
    expect(artisanFinished.code, artisanFinished.stderr).toBe(0);
    const artisanOutcome = JSON.parse(readFileSync(join(results, "req-artisan.json"), "utf8"));
    expect(artisanOutcome.status).toBe("success");
    expect(artisanOutcome.execution_route).toBe("artisan");
    expect(artisanOutcome.expected_studio_sha).toBe(expectedStudioSha);
    expect(git(root, "merge-base", "--is-ancestor", artisanTip, STUDIO)).toBe("");
    expect(existsSync(dockRequest)).toBe(true);

    // The queued Dock request is processed only after Artisan released the same
    // lock. Both route-tagged requests land, but never share the integration slot.
    const dockRetry = await runProcess([MERGE_GATE, dockRequest], root);
    expect(dockRetry.code, dockRetry.stderr).toBe(0);
    const dockOutcome = JSON.parse(readFileSync(join(results, "req-dock.json"), "utf8"));
    expect(dockOutcome.status).toBe("success");
    expect(dockOutcome.execution_route).toBe("dock");
    expect(git(root, "merge-base", "--is-ancestor", dockTip, STUDIO)).toBe("");
    expect(git(root, "merge-base", "--is-ancestor", artisanTip, STUDIO)).toBe("");
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
