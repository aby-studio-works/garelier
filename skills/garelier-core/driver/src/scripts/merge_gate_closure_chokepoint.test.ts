import { seedFixtureItemAuthority } from "../dispatch/fixture_item_authority.ts";
import { renameSync, rmSync } from "../guard/path_guard.ts";
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { Logger } from "../log.ts";
import { mergeGatePaths, pollMergeGate } from "../merge_gate.ts";
import {
  acquireClosure, bindClosureResult, activateClosure, closeClosure, sha256Hex,
} from "../integration_closure.ts";
import {
  acknowledgeRoleLaunch, admitRoleClose, branchExecutionIdentity,
  issueRoleAuthorization, roleBindingPaths, validateRoleBinding,
  type RoleCloseAdmission,
} from "../dispatch/role_binding.ts";
import { resolveRoleKnowledgeBinding } from "../dispatch/knowledge_binding.ts";

// W-346 FR5 (Guardian N15 / blueprint CL-1): the gate PROCESS itself is a
// chokepoint — a direct `bun merge-gate.ts <request.json>` invocation cannot
// bypass an active closure lease, and while blocked the unrelated request
// waits BYTE-IDENTICAL in place (FR7): no result, no archive, no studio
// mutation, its own active.lock released. This file also pins the FR4/FR13
// placeholder-before-spawn restructure of `pollMergeGate` (the W-008
// double-spawn window): the atomic placeholder exists BEFORE the child spawn,
// and a closure-blocked request is simply not spawned.

const MERGE_GATE = join(dirname(fileURLToPath(import.meta.url)), "merge-gate.ts");
const PM = "tpm";
const STUDIO = `garelier/t/${PM}/studio`;
const WB = `garelier/t/${PM}/workbench/#1/x`;
const T = 90_000;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } }, T);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { windowsHide: true, cwd, encoding: "utf8" });
  expect(r.status ?? 1, r.stderr ?? "").toBe(0);
  return (r.stdout ?? "").trim();
}

function setupRepo(options: { requestId?: string; gateCommand?: string } = {}): {
  repo: string;
  requestPath: string;
  requestBytes: string;
  identity: ReturnType<typeof branchExecutionIdentity>;
  authorization: ReturnType<typeof issueRoleAuthorization>;
  report: string;
  ledger: string;
  admit: (requestId: string, candidateSha?: string) => RoleCloseAdmission;
  writeRequest: (requestId: string, gateCommand: string, admission: RoleCloseAdmission, candidateSha?: string) => string;
} {
  const firstRequestId = options.requestId ?? "req1";
  const firstGateCommand = options.gateCommand ?? "exit 0";
  const repo = mkdtempSync(join(tmpdir(), "garelier-mg-closure-"));
  dirs.push(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "ci@ci");
  git(repo, "config", "user.name", "ci");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "checkout", "-q", "-b", STUDIO);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", WB);
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "feature");
  git(repo, "checkout", "-q", STUDIO);
  const pmDir = join(repo, "__garelier", PM, "_crew", "pm");
  mkdirSync(pmDir, { recursive: true });
  writeFileSync(join(pmDir, "setup_config.toml"), "[guardian_policy]\nenabled = false\n");
  const reqDir = join(repo, "__garelier", PM, "runtime", "merge_gate", "requests");
  mkdirSync(reqDir, { recursive: true });
  const sourceDir = join(repo, "binding-fixture");
  mkdirSync(sourceDir, { recursive: true });
  const assignment = join(sourceDir, "assignment.md"), prompt = join(sourceDir, "prompt.md"), report = join(sourceDir, "report.md");
  // W-734: role authorization reads the item authority from HEAD, so writing it
  // into the worktree is not enough — commit it in the same step.
  seedFixtureItemAuthority(repo, [
    { rel: assignment, content: "# Bound merge fixture\n" },
    { rel: prompt, content: "Execute bound merge fixture.\n" },
    { rel: report, content: "# Bound merge report\n" },
  ]);
  const identity = branchExecutionIdentity("worker", WB);
  const authorization = issueRoleAuthorization({
    project_root: repo, pm_id: PM, identity, role: "worker", carabiner: "implementation",
    item: { work_id: "W-fixture", revision: "1", session_id: "cs-fixture", authority_path: assignment },
    assignment_path: assignment, prompt_path: prompt,
    routing: { provider: "attended-agent", model: "test-model", effort: "medium", source: "aggregate" },
    lens: { ref: null, source: "none", registry_path: null, pack_path: null },
    knowledge: resolveRoleKnowledgeBinding({ projectRoot: repo, pmId: PM, role: "worker", required: [] }),
    integration: { ref: STUDIO, base_sha: git(repo, "rev-parse", STUDIO) },
    issuer: { role: "dock", id: "aggregate" },
  });
  acknowledgeRoleLaunch({
    project_root: repo, pm_id: PM, identity, generation: authorization.core.generation,
    expect_digest: authorization.core_digest, transport: "attended-agent", provider_session_id: "agent-fixture",
    success_evidence: "aggregate launch", writer: { role: "attended-parent", id: "aggregate" },
  });
  const ledger = join(sourceDir, "instructions.md");
  const admit = (requestId: string, candidateSha = git(repo, "rev-parse", WB)): RoleCloseAdmission => admitRoleClose({
    project_root: repo, pm_id: PM, identity, generation: authorization.core.generation,
    expect_digest: authorization.core_digest, candidate_sha: candidateSha, report_path: report,
    ledger_path: ledger, request_id: requestId, writer: { role: "admission-controller", id: "aggregate" },
  });
  const writeRequest = (
    requestId: string,
    gateCommand: string,
    admission: RoleCloseAdmission,
    candidateSha = git(repo, "rev-parse", WB),
  ): string => {
    const body = JSON.stringify({
      request_id: requestId,
      workbench_branch: WB,
      workbench_tip: candidateSha,
      studio_branch: STUDIO,
      target_root: repo,
      role_report_path: report,
      role_binding: admission.reference,
      role_close: admission.close,
      quality_gate_commands: [gateCommand],
      merge_message: "merge x into studio",
    }, null, 2);
    const path = join(reqDir, `${requestId}.json`);
    writeFileSync(path, body);
    return path;
  };
  const firstAdmission = admit(firstRequestId);
  const requestPath = writeRequest(firstRequestId, firstGateCommand, firstAdmission);
  const requestBytes = readFileSync(requestPath, "utf8");
  return { repo, requestPath, requestBytes, identity, authorization, report, ledger, admit, writeRequest };
}

function activeLease(repo: string) {
  const rec = acquireClosure(repo, PM, STUDIO, {
    owner_session: "closure-owner", base_studio_sha: git(repo, "rev-parse", STUDIO),
    origin_request_digest: sha256Hex("some-other-origin-request"),
  });
  const fence = { lease_id: rec.lease_id, nonce: rec.nonce, fencing_epoch: rec.fencing_epoch };
  bindClosureResult(repo, PM, fence, sha256Hex("origin-result"), git(repo, "rev-parse", STUDIO));
  activateClosure(repo, PM, fence);
  return fence;
}

test("merge-gate.ts itself refuses under an active closure lease — request waits byte-identical (FR5/FR7), and lands after close", () => {
  const { repo, requestPath, requestBytes, admit } = setupRepo();
  const fence = activeLease(repo);
  const studioBefore = git(repo, "rev-parse", STUDIO);
  const p = mergeGatePaths(repo, PM);

  const blocked = spawnSync(process.execPath, [MERGE_GATE, requestPath], { windowsHide: true, cwd: repo, encoding: "utf8", env: process.env });
  expect(blocked.status ?? 1, blocked.stderr ?? "").toBe(0);
  expect(blocked.stderr).toContain("closure lease blocks request req1");
  // FR7: no result, no archive, request bytes untouched, studio unmoved, lock released.
  expect(existsSync(join(p.resultsDir, "req1.json"))).toBe(false);
  expect(existsSync(join(p.archiveDir, "req1.request.json"))).toBe(false);
  expect(readFileSync(requestPath, "utf8")).toBe(requestBytes);
  expect(git(repo, "rev-parse", STUDIO)).toBe(studioBefore);
  expect(existsSync(p.activeLock)).toBe(false);

  // After the lease closes, the SAME untouched request lands normally.
  closeClosure(repo, PM, fence, "verification complete");
  const landed = spawnSync(process.execPath, [MERGE_GATE, requestPath], { windowsHide: true, cwd: repo, encoding: "utf8", env: process.env });
  expect(landed.status ?? 1, landed.stderr ?? "").toBe(0);
  const result = JSON.parse(readFileSync(join(p.resultsDir, "req1.json"), "utf8")) as { status: string };
  expect(result.status).toBe("success");
  expect(git(repo, "rev-parse", STUDIO)).not.toBe(studioBefore);

  // W-447 predicate 1: a successful close remains frozen. Even a later
  // workbench commit cannot mint a replacement receipt for this binding.
  git(repo, "checkout", "-q", WB);
  writeFileSync(join(repo, "after-success.txt"), "must remain refused\n");
  git(repo, "add", "after-success.txt");
  git(repo, "commit", "-q", "-m", "candidate after successful close");
  const afterSuccess = git(repo, "rev-parse", WB);
  git(repo, "checkout", "-q", STUDIO);
  expect(() => admit("success-freeze-next", afterSuccess)).toThrow("successful gate outcome");

  // W-447 predicates 2/3 + counterfactual: before RED, another candidate is
  // refused. The append-only RED outcome invalidates only that receipt, so a
  // fixed commit can obtain a new close without role_recovery and land.
  const red = setupRepo({ requestId: "red-1", gateCommand: "exit 7" });
  expect(() => red.admit("red-too-early", "e".repeat(40))).toThrow("candidate SHA");
  const failed = spawnSync(process.execPath, [MERGE_GATE, red.requestPath], {
    windowsHide: true, cwd: red.repo, encoding: "utf8", env: process.env,
  });
  expect(failed.status ?? 1, failed.stderr ?? "").toBe(0);
  expect(JSON.parse(readFileSync(join(mergeGatePaths(red.repo, PM).resultsDir, "red-1.json"), "utf8")).status).toBe("failed");
  const closePaths = roleBindingPaths(red.repo, PM, red.identity, red.authorization.core.generation);
  const redOutcomePath = join(closePaths.close_gate_outcomes, "red-1.json");
  const redOutcome = JSON.parse(readFileSync(redOutcomePath, "utf8"));
  expect(redOutcome).toMatchObject({ request_id: "red-1", status: "failed", invalidates_close: true });

  git(red.repo, "checkout", "-q", WB);
  writeFileSync(join(red.repo, "fix.txt"), "fixed after RED\n");
  git(red.repo, "add", "fix.txt");
  git(red.repo, "commit", "-q", "-m", "fix after RED");
  const fixedCandidate = git(red.repo, "rev-parse", WB);
  git(red.repo, "checkout", "-q", STUDIO);
  const hiddenOutcomePath = `${redOutcomePath}.counterfactual`;
  renameSync(redOutcomePath, hiddenOutcomePath);
  expect(() => red.admit("red-2-counterfactual", fixedCandidate)).toThrow("candidate SHA");
  renameSync(hiddenOutcomePath, redOutcomePath);
  const retryAdmission = red.admit("red-2", fixedCandidate);
  const retryPath = red.writeRequest("red-2", "exit 0", retryAdmission, fixedCandidate);
  const retried = spawnSync(process.execPath, [MERGE_GATE, retryPath], {
    windowsHide: true, cwd: red.repo, encoding: "utf8", env: process.env,
  });
  expect(retried.status ?? 1, retried.stderr ?? "").toBe(0);
  expect(JSON.parse(readFileSync(join(mergeGatePaths(red.repo, PM).resultsDir, "red-2.json"), "utf8")).status).toBe("success");

  // W-447 predicate 4: concurrent submits receive distinct immutable close
  // receipts. RED for one request cannot invalidate the other's valid receipt.
  const concurrent = setupRepo({ requestId: "race-red", gateCommand: "exit 9" });
  const sameCandidate = git(concurrent.repo, "rev-parse", WB);
  const survivor = concurrent.admit("race-green", sameCandidate);
  const survivorPath = concurrent.writeRequest("race-green", "exit 0", survivor, sameCandidate);
  const raceRed = spawnSync(process.execPath, [MERGE_GATE, concurrent.requestPath], {
    windowsHide: true, cwd: concurrent.repo, encoding: "utf8", env: process.env,
  });
  expect(raceRed.status ?? 1, raceRed.stderr ?? "").toBe(0);
  expect(validateRoleBinding({
    project_root: concurrent.repo, pm_id: PM, identity: concurrent.identity, stage: "merge_gate",
    generation: concurrent.authorization.core.generation, expected_digest: concurrent.authorization.core_digest,
    candidate_sha: sameCandidate, report_path: concurrent.report, ledger_path: concurrent.ledger,
    close_reference: survivor.close,
  }).close?.receipt_id).toBe(survivor.close.receipt_id);
  const raceGreen = spawnSync(process.execPath, [MERGE_GATE, survivorPath], {
    windowsHide: true, cwd: concurrent.repo, encoding: "utf8", env: process.env,
  });
  expect(raceGreen.status ?? 1, raceGreen.stderr ?? "").toBe(0);
  expect(JSON.parse(readFileSync(join(mergeGatePaths(concurrent.repo, PM).resultsDir, "race-green.json"), "utf8")).status).toBe("success");
}, T);

test("pollMergeGate: atomic placeholder exists BEFORE spawn (FR4), closure-blocked requests are not spawned, dead-spawner placeholders reclaim", async () => {
  // Uses the watchdog-test scaffolding shape: a config-only project root, an
  // injected spawnFn, and a request that never really runs.
  const root = mkdtempSync(join(tmpdir(), "garelier-w346-poll-"));
  dirs.push(root);
  const pmDir = join(root, "__garelier", PM, "_crew", "pm");
  mkdirSync(pmDir, { recursive: true });
  writeFileSync(join(pmDir, "setup_config.toml"), `
[project]
name = "Test"

[branches]
target = "main"
integration = "${STUDIO}"

[quality_gate]
stack = "typescript"
commands = []
`, "utf8");
  const config = loadConfig(root, PM);
  const p = mergeGatePaths(root, PM);
  mkdirSync(p.requestsDir, { recursive: true });
  const requestBytes = JSON.stringify({ request_id: "001-a", studio_branch: STUDIO, target_root: root });
  writeFileSync(join(p.requestsDir, "001-a.json"), requestBytes);
  const dummyScript = join(root, "dummy-merge-gate.ts");
  writeFileSync(dummyScript, "// stub\n");
  const log = new Logger("test", join(root, "driver.jsonl"));

  // (a) FR4: at the instant spawnFn runs, the active.lock ALREADY exists as a
  // placeholder carrying a nonce — the double-spawn window is closed — and the
  // child env carries the exact same nonce for adoption.
  const seen: { lock?: Record<string, unknown>; envNonce?: string } = {};
  const result = await pollMergeGate(root, config, log, {
    scriptOverride: dummyScript,
    spawnFn: (_s, _args, _cwd, env) => {
      seen.lock = JSON.parse(readFileSync(p.activeLock, "utf8")) as Record<string, unknown>;
      seen.envNonce = env.GARELIER_MERGE_GATE_LOCK_NONCE;
      return 4242;
    },
  });
  expect(result.spawnedRequestId).toBe("001-a");
  expect(seen.lock?.placeholder).toBe(true);
  expect(seen.lock?.request_id).toBe("001-a");
  expect(typeof seen.lock?.nonce).toBe("string");
  expect(seen.envNonce).toBe(seen.lock?.nonce as string);
  const afterSpawn = JSON.parse(readFileSync(p.activeLock, "utf8")) as Record<string, unknown>;
  expect(afterSpawn.pid).toBe(4242);
  expect(afterSpawn.nonce).toBe(seen.lock?.nonce as string);
  expect(afterSpawn.placeholder).toBeUndefined();

  // (b) a placeholder whose spawner is DEAD (crashed between placeholder write
  // and spawn) is reclaimed and the request re-spawned; a LIVE spawner's
  // placeholder is left alone.
  writeFileSync(p.activeLock, JSON.stringify({ pid: 0, placeholder: true, nonce: "stale", spawner_pid: 2_147_483_647, request_id: "001-a", request_file: "001-a.json", started_at: new Date().toISOString() }));
  const reclaimed = await pollMergeGate(root, config, log, { scriptOverride: dummyScript, spawnFn: () => 4243 });
  expect(reclaimed.spawnedRequestId).toBe("001-a");
  writeFileSync(p.activeLock, JSON.stringify({ pid: 0, placeholder: true, nonce: "live", spawner_pid: process.pid, request_id: "001-a", request_file: "001-a.json", started_at: new Date().toISOString() }));
  const leftAlone = await pollMergeGate(root, config, log, { scriptOverride: dummyScript, spawnFn: () => { throw new Error("must not spawn over a live in-flight placeholder"); } });
  expect(leftAlone.spawnedRequestId).toBeUndefined();
  try { rmSync(p.activeLock, { force: true }); } catch { /* cleanup */ }

  // (c) FR5: a closure lease on this studio blocks the spawn — the request
  // stays queued byte-identical and NO lock is taken. (No git repo here, so
  // the lease is seeded with a literal SHA rather than the activeLease helper.)
  const sha = "a".repeat(40);
  const rec = acquireClosure(root, PM, STUDIO, { owner_session: "closure-owner", base_studio_sha: sha, origin_request_digest: sha256Hex("origin") });
  const fence = { lease_id: rec.lease_id, nonce: rec.nonce, fencing_epoch: rec.fencing_epoch };
  bindClosureResult(root, PM, fence, sha256Hex("result"), sha);
  activateClosure(root, PM, fence);
  const blocked = await pollMergeGate(root, config, log, { scriptOverride: dummyScript, spawnFn: () => { throw new Error("must not spawn under closure"); } });
  expect(blocked.spawnedRequestId).toBeUndefined();
  expect(readFileSync(join(p.requestsDir, "001-a.json"), "utf8")).toBe(requestBytes);
  expect(existsSync(p.activeLock)).toBe(false);
  const historyDirs = readdirSync(join(root, "__garelier", PM, "runtime", "merge_gate"));
  expect(historyDirs).toContain("closure");
}, T);
