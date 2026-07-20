import { rmSync } from "../guard/path_guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { armLongJob, finishLongJob, longJobRoot, startLongJob } from "../long_jobs.ts";
import { evaluate, DEFAULT_POLICY } from "../guard/command_guard.ts";

const PREPARE = join(import.meta.dir, "dispatch_prepare.ts");
const PROXY_COMMIT = join(import.meta.dir, "dispatch_prepare_lane_commit_plan.ts");
const T = 60_000;
let repo = "";

function git(args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function prepare(args: string[]): Record<string, any> {
  const result = Bun.spawnSync(["bun", PREPARE, "--project", repo, "--pm-id", "p", "--role", "worker", "--base", "garelier/main/p/studio", ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const line = result.stdout.toString().trim().split(/\r?\n/).findLast((value) => value.startsWith("{"));
  if (!line) throw new Error(`missing JSON output: ${result.stdout.toString()}`);
  return JSON.parse(line);
}

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = "";
}, T);

describe("W-104/W-107 dispatch_prepare producer contract", () => {
  test("explicit codex task file synthesizes prompt and emits launch/watch commands", () => {
    repo = mkdtempSync(join(tmpdir(), "dispatch-prepare-codex-"));
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "ci@ci"]);
    git(["config", "user.name", "ci"]);
    git(["-c", "user.email=ci@ci", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["branch", "garelier/main/p/studio"]);

    const taskFile = join(repo, "task.md");
    writeFileSync(taskFile, "Implement the fixture-only Codex task.\n\nKeep this task body intact.\n");
    const output = prepare(["--slug", "codex-contract", "--producer", "codex", "--task-file", taskFile, "--model", "gpt-5.6-terra", "--effort", "high"]);
    expect(output.producer).toBe("codex");
    expect(output.model).toBe("gpt-5.6-terra");
    expect(output.commit_mode).toBe("proxy");
    expect(output.permission_profile).toBe("producer");
    expect(output.fence_roots).toEqual([resolve(output.checkout), resolve(output.container)]); // W-127: guard fence is emitted ABSOLUTE
    const context = JSON.parse(readFileSync(output.context, "utf8"));
    expect(context.guard.permission_profile).toBe("producer");
    expect(context.guard.fence_roots).toEqual([resolve(output.checkout), resolve(output.container)]); // W-127: guard fence is emitted ABSOLUTE
    expect(context.guard.worktree).toBe(resolve(output.checkout)); // W-127: worktree anchor is absolute too
    expect(output.launch_cmd).toContain(" --model 'gpt-5.6-terra'");
    expect(output.launch_cmd).toContain(`--worktree "${output.checkout}"`);
    expect(output.launch_cmd).toContain(`--project "${repo}"`);
    expect(output.launch_cmd).toContain(`--prompt "${output.container}/lane/prompt.md"`);
    expect(output.launch_cmd).toContain(`--result "${output.container}/lane/result.md"`);
    expect(output.watch_cmd).toContain("dispatch_watch.ts");
    expect(output.prompt_file).toBe(`${output.container}/lane/prompt.md`);
    expect(output.result_file).toBe(`${output.container}/lane/result.md`);
    expect(output.session_record).toBe(`${output.container}/lane/session.json`);
    expect(output.resume_instruction_file).toBe(`${output.container}/lane/followup.md`);
    expect(output.resume_result_file).toBe(`${output.container}/lane/followup.result.md`);
    expect(output.resume_cmd).toContain("provider_session.ts");
    expect(output.resume_cmd).toContain(`--record '${output.session_record}'`);
    expect(output.resume_cmd).toContain("--expected-model 'gpt-5.6-terra'");
    expect(output.resume_cmd).toContain("--expected-effort 'high'");
    expect(output.resume_cmd).toContain(`--expected-source '${output.model_source}'`);
    expect(readFileSync(output.resume_instruction_file, "utf8")).toBe("");
    expect(output.proxy_commit_cmd).toContain("dispatch_prepare_lane_commit_plan.ts");
    expect(output.prompt_preamble).toContain("NEVER run git merge, git add, git commit");
    expect(output.prompt_preamble).toContain("If the tips are identical, skip base-track");
    expect(output.prompt_preamble).toContain("=== COMMIT PLAN ===");
    expect(output.prompt_preamble).toContain(`${output.container}/lane/result.md`);
    const prompt = readFileSync(output.prompt_file, "utf8");
    expect(prompt).toContain("You are the Garelier worker for dispatch #1");
    expect(prompt).toContain("Codex producer sandbox contract");
    expect(prompt).toContain("## Task\n\nImplement the fixture-only Codex task.");
    expect(prompt).toContain("Keep this task body intact.");

    writeFileSync(join(output.checkout, "change.txt"), "change\n");
    writeFileSync(output.result_file, [
      "=== COMMIT PLAN ===",
      "files:",
      "- change.txt",
      "message:",
      "fix(dispatch): honor codex contract [#1]",
      "",
      "proxy commit must target the managed dispatch checkout",
      "",
      "Garelier: p worker#1 W-104",
      "=== END COMMIT PLAN ===",
      "",
    ].join("\n"));
    const proxyCommit = Bun.spawnSync(["bun", PROXY_COMMIT, "--project", repo, "--pm-id", "p", "--id", "1", "--result", output.result_file], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
    if (proxyCommit.exitCode !== 0) throw new Error(proxyCommit.stderr.toString());
    expect(proxyCommit.exitCode).toBe(0);
    const message = Bun.spawnSync(["git", "-C", output.checkout, "log", "-1", "--format=%B"], { windowsHide: true, stdout: "pipe", stderr: "pipe" }).stdout.toString();
    expect(message).toContain("Garelier: p worker#1 W-104");
    expect(message).toContain("Garelier-Seat: codex gpt-5.6-terra (proxy-commit via dock seat)");
  }, T);

  test("explicit codex without task file remains a prompt/launch no-op", () => {
    repo = mkdtempSync(join(tmpdir(), "dispatch-prepare-codex-no-task-"));
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.email=ci@ci", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["branch", "garelier/main/p/studio"]);

    const output = prepare(["--slug", "codex-no-task", "--producer", "codex", "--model", "gpt-5.6-terra"]);
    expect(output.producer).toBe("codex");
    expect(output.launch_cmd).toBe("");
    expect(output.prompt_file).toBe("");
    expect(output.result_file).toBe("");
    expect(output.session_record).toBe("");
    expect(output.resume_cmd).toBe("");
    expect(output.proxy_commit_cmd).toContain(`${output.container}/codex_last_message.md`);
    expect(output.watch_cmd).toContain("dispatch_watch.ts");
    expect(existsSync(join(output.container, "lane", "prompt.md"))).toBe(false);
  }, T);

  test("explicit Codex inherit blocks before branch/worktree mutation", () => {
    repo = mkdtempSync(join(tmpdir(), "dispatch-prepare-codex-block-"));
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.email=ci@ci", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["branch", "garelier/main/p/studio"]);
    const result = Bun.spawnSync(["bun", PREPARE, "--project", repo, "--pm-id", "p", "--role", "worker", "--base", "garelier/main/p/studio", "--slug", "codex-block", "--producer", "codex"], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(4);
    expect(result.stderr.toString()).toContain("canonical routing resolved to inherit");
    expect(Bun.spawnSync(["git", "-C", repo, "branch", "--list", "*codex-block*"], { windowsHide: true, stdout: "pipe" }).stdout.toString().trim()).toBe("");
    expect(existsSync(join(repo, "__garelier", "p", "_dispatch1"))).toBe(false);
  }, T);

  test("dispatch startup scan blocks FINISHED-not-ACKED long jobs before mutation", () => {
    repo = mkdtempSync(join(tmpdir(), "dispatch-prepare-long-job-recovery-"));
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.email=ci@ci", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["branch", "garelier/main/p/studio"]);
    const root = longJobRoot(repo, "p");
    mkdirSync(root, { recursive: true });
    const commandRef = join(root, "gate.command");
    writeFileSync(commandRef, "true");
    armLongJob({ root, jobId: "pending", command: "true", commandRef, cwd: repo, dispatchId: "old", agentId: "worker-old", provider: "codex-exec", wake: { armed: true, capability: "codex-task", source: "test" } });
    startLongJob(root, "pending");
    finishLongJob(root, "pending", 1, { ok: true });
    const result = Bun.spawnSync(["bun", PREPARE, "--project", repo, "--pm-id", "p", "--role", "worker", "--base", "garelier/main/p/studio", "--slug", "blocked-by-recovery"], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(4);
    expect(result.stderr.toString()).toContain("durable long-job recovery pending");
    expect(Bun.spawnSync(["git", "-C", repo, "branch", "--list", "*blocked-by-recovery*"], { windowsHide: true, stdout: "pipe" }).stdout.toString().trim()).toBe("");
  }, T);

  test("dispatch startup scan blocks ARMED-only work until its broker starts", () => {
    repo = mkdtempSync(join(tmpdir(), "dispatch-prepare-armed-long-job-"));
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.email=ci@ci", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["branch", "garelier/main/p/studio"]);
    const root = longJobRoot(repo, "p");
    mkdirSync(root, { recursive: true });
    const commandRef = join(root, "gate.command");
    writeFileSync(commandRef, "true");
    armLongJob({ root, jobId: "armed-only", command: "true", commandRef, cwd: repo, dispatchId: "old", agentId: "worker-old", provider: "codex-exec", wake: { armed: true, capability: "codex-task", source: "test" } });
    const result = Bun.spawnSync(["bun", PREPARE, "--project", repo, "--pm-id", "p", "--role", "worker", "--base", "garelier/main/p/studio", "--slug", "blocked-by-armed-job"], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(4);
    expect(result.stderr.toString()).toContain("START_BROKER");
    expect(Bun.spawnSync(["git", "-C", repo, "branch", "--list", "*blocked-by-armed-job*"], { windowsHide: true, stdout: "pipe" }).stdout.toString().trim()).toBe("");
  }, T);

  test("omitted producer preserves the Claude preamble and additive JSON shape", () => {
    repo = mkdtempSync(join(tmpdir(), "dispatch-prepare-claude-"));
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.email=ci@ci", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["branch", "garelier/main/p/studio"]);

    const output = prepare(["--slug", "claude-contract"]);
    expect(output.producer).toBe("claude");
    expect(output.proxy_commit_cmd).toBe("");
    expect(output.prompt_preamble).toContain("At pickup, base-track FIRST");
    expect(output.prompt_preamble).not.toContain("Codex producer sandbox contract");
    // W-170: the process-kill worktree-filter guidance is in the preamble.
    expect(output.prompt_preamble).toContain("Process kill (W-170)");
    expect(output.prompt_preamble).toContain("indiscriminate name/image bulk kill");
    // W-146: the register + progress messages must be SENT via SendMessage — a
    // named teammate's plain-text final output is not reliably delivered to the lead.
    expect(output.prompt_preamble).toContain("Delivery (W-146)");
    expect(output.prompt_preamble).toContain("SendMessage");
    expect(output.prompt_preamble).toContain("Plain text is not a completion signal");
    // W-173 (3): the filter TOKEN the preamble recommends must actually PASS the
    // guard — extract it from the generated preamble (not hardcoded) and drive the
    // real evaluate() with process_kill on. A worker who follows the advice must
    // not be re-denied (the self-defeating bug this fixes).
    const tokenMatch = output.prompt_preamble.match(/-like '\*([^*']+)\*'/);
    expect(tokenMatch, "preamble must recommend a -like '*<token>*' filter").not.toBeNull();
    const recommended = `Get-Process | Where-Object { $_.CommandLine -like '*${tokenMatch[1]}*' } | Stop-Process`;
    const fenceRoots = [resolve(`${output.container}/checkout`), resolve(output.container)];
    const verdict = evaluate({
      command: recommended, tool: "PowerShell", role: "worker",
      profile: "producer", fenceRoots,
      policy: { ...DEFAULT_POLICY, process_kill_guard_enabled: true },
    });
    expect(verdict.action, "the preamble's own recommended kill must pass the guard").toBe("allow");
  }, T);

  test("legacy external-model auto-route keeps its explicit self-commit override", () => {
    repo = mkdtempSync(join(tmpdir(), "dispatch-prepare-legacy-"));
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.email=ci@ci", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["branch", "garelier/main/p/studio"]);

    const output = prepare(["--slug", "legacy-codex", "--model", "codex-ci-model", "--commit-mode", "self"]);
    expect(output.producer).toBe("codex");
    expect(output.commit_mode).toBe("self");
    expect(output.launch_cmd).toBe("");
    expect(output.prompt_preamble).toContain("At pickup, base-track FIRST");
    expect(output.prompt_preamble).not.toContain("Codex producer sandbox contract");
  }, T);
});
