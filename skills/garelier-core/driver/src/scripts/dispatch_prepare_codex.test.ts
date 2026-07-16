import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREPARE = join(import.meta.dir, "dispatch_prepare.ts");
const PROXY_COMMIT = join(import.meta.dir, "..", "..", "..", "scripts", "dispatch_prepare_lane_commit_plan.sh");
const T = 60_000;
let repo = "";

function git(args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function prepare(args: string[]): Record<string, any> {
  const result = Bun.spawnSync(["bun", PREPARE, "--project", repo, "--pm-id", "p", "--role", "worker", "--base", "garelier/main/p/studio", ...args], { stdout: "pipe", stderr: "pipe" });
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
    const output = prepare(["--slug", "codex-contract", "--producer", "codex", "--task-file", taskFile]);
    expect(output.producer).toBe("codex");
    expect(output.model).toBe("");
    expect(output.commit_mode).toBe("proxy");
    expect(output.launch_cmd).not.toContain(" --model ");
    expect(output.launch_cmd).toContain(`--worktree "${output.checkout}"`);
    expect(output.launch_cmd).toContain(`--project "${repo}"`);
    expect(output.launch_cmd).toContain(`--prompt "${output.container}/lane/prompt.md"`);
    expect(output.launch_cmd).toContain(`--result "${output.container}/lane/result.md"`);
    expect(output.watch_cmd).toBe(`while [ ! -s "${output.container}/lane/result.md" ]; do sleep 30; done`);
    expect(output.prompt_file).toBe(`${output.container}/lane/prompt.md`);
    expect(output.result_file).toBe(`${output.container}/lane/result.md`);
    expect(output.proxy_commit_cmd).toContain("dispatch_prepare_lane_commit_plan.sh");
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
    const proxyCommit = Bun.spawnSync(["bash", PROXY_COMMIT, "--project", repo, "--pm-id", "p", "--id", "1", "--result", output.result_file], { stdout: "pipe", stderr: "pipe" });
    if (proxyCommit.exitCode !== 0) throw new Error(proxyCommit.stderr.toString());
    expect(proxyCommit.exitCode).toBe(0);
    const message = Bun.spawnSync(["git", "-C", output.checkout, "log", "-1", "--format=%B"], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
    expect(message).toContain("Garelier: p worker#1 W-104");
    expect(message).toContain("Garelier-Seat: codex config-default (proxy-commit via dock seat)");
  }, T);

  test("explicit codex without task file remains a prompt/launch no-op", () => {
    repo = mkdtempSync(join(tmpdir(), "dispatch-prepare-codex-no-task-"));
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.email=ci@ci", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "init"]);
    git(["branch", "garelier/main/p/studio"]);

    const output = prepare(["--slug", "codex-no-task", "--producer", "codex"]);
    expect(output.producer).toBe("codex");
    expect(output.launch_cmd).toBe("");
    expect(output.prompt_file).toBe("");
    expect(output.result_file).toBe("");
    expect(output.proxy_commit_cmd).toContain(`${output.container}/codex_last_message.md`);
    expect(output.watch_cmd).toContain("dispatch_watch.sh");
    expect(existsSync(join(output.container, "lane", "prompt.md"))).toBe(false);
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
