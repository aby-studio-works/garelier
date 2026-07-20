import { rmSync } from "../guard/path_guard.ts";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  makeSessionRecord,
  parseClaudeSessionId,
  parseCodexSessionId,
  providerChildEnv,
  resumeExplicitSession,
  writeSessionRecord,
} from "./provider_session.ts";

test("provider child env preserves host timeout variables verbatim", () => {
  const base = { BASH_MAX_TIMEOUT_MS: "123456", BASH_DEFAULT_TIMEOUT_MS: "654321", PATH: "x" };
  const env = providerChildEnv("claude-code", "C:/Program Files/Git/bin/bash.exe", base);
  expect(env.BASH_MAX_TIMEOUT_MS).toBe("123456");
  expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe("654321");
  if (process.platform === "win32") expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe("C:/Program Files/Git/bin/bash.exe");
});

let root = "";
const ROUTE = { model: "gpt-5.6-terra", effort: "high", source: "rule:schema,security+adapter:codex-preserved" };
setDefaultTimeout(30_000);

function git(repo: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function repo(name = "work tree"): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q"]);
  git(path, ["config", "user.email", "ci@ci"]);
  git(path, ["config", "user.name", "ci"]);
  writeFileSync(join(path, "seed.txt"), "seed\n");
  git(path, ["add", "seed.txt"]);
  git(path, ["commit", "-qm", "init"]);
  return path;
}

function fakeCli(name: "codex" | "claude", body: string): string {
  const bin = join(root, "fake bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
  return bin;
}

function env(bin: string, extra: Record<string, string> = {}): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === "path") ?? "PATH";
  return { [key]: `${bin}${delimiter}${process.env[key] ?? ""}`, ...extra };
}

function files(worktree: string): { record: string; instruction: string; result: string } {
  const lane = join(root, "dispatch lane");
  mkdirSync(lane, { recursive: true });
  const instruction = join(lane, "followup.md");
  writeFileSync(instruction, "Inspect the exact failure and report the SHA.\n");
  return { record: join(lane, "session.json"), instruction, result: join(lane, "result.md") };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

test("W-146: exact Codex thread.started and Claude session_id capture only", () => {
  expect(parseCodexSessionId('{"type":"thread.started","thread_id":"thread-123"}')).toBe("thread-123");
  expect(parseCodexSessionId('{"type":"turn.started","thread_id":"wrong"}')).toBe("");
  expect(parseCodexSessionId('{"type":"thread.started","session_id":"wrong-field"}')).toBe("");
  expect(parseClaudeSessionId('{"session_id":"claude-456","result":"ok"}')).toBe("claude-456");
  expect(parseClaudeSessionId('{"thread_id":"wrong-field"}')).toBe("");
});

test("W-146: Claude headless JSON capture hook persists id and extracts result", () => {
  root = mkdtempSync(join(tmpdir(), "provider-session-capture-"));
  const worktree = repo();
  const f = files(worktree);
  const input = join(root, "claude.initial.json");
  writeFileSync(input, '{"session_id":"captured-claude-id","result":"initial result"}\n');
  const script = join(import.meta.dir, "provider_session.ts");
  const child = Bun.spawnSync([
    "bun", script, "capture", "--provider", "claude-code", "--worktree", worktree,
    "--record", f.record, "--input", input, "--result", f.result,
    "--model", ROUTE.model, "--effort", ROUTE.effort, "--model-source", ROUTE.source,
  ], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(f.record, "utf8")).session_id).toBe("captured-claude-id");
  expect(readFileSync(f.result, "utf8")).toBe("initial result");
});

test("W-146: Codex resumes exact id with stdin instruction and no last/continue", () => {
  root = mkdtempSync(join(tmpdir(), "provider session codex "));
  const worktree = repo();
  const f = files(worktree);
  const argsFile = join(root, "codex args.txt");
  const stdinFile = join(root, "codex stdin.txt");
  const bin = fakeCli("codex", 'printf "%s\\n" "$@" > "$ARGS_FILE"\ncat > "$STDIN_FILE"\nprintf "codex resumed\\n"');
  writeSessionRecord(f.record, makeSessionRecord("codex-cli", "codex-explicit-id", worktree, "ready", f.result, undefined, ROUTE));

  const outcome = resumeExplicitSession({ recordFile: f.record, instructionFile: f.instruction, resultFile: f.result, expectedRouting: ROUTE, env: env(bin, { ARGS_FILE: argsFile, STDIN_FILE: stdinFile }) });

  expect(outcome.ok).toBe(true);
  expect(readFileSync(argsFile, "utf8").trim().split(/\r?\n/)).toEqual([
    "exec", "resume", "codex-explicit-id", "--model", "gpt-5.6-terra", "-c", 'model_reasoning_effort="high"', "-",
  ]);
  expect(readFileSync(stdinFile, "utf8")).toContain("Inspect the exact failure");
  expect(readFileSync(argsFile, "utf8")).not.toContain("--last");
  expect(readFileSync(argsFile, "utf8")).not.toContain("--continue");
  expect(readFileSync(f.result, "utf8")).toBe("codex resumed\n");
});

test("W-146: Claude resumes exact id with -p prompt and canonical result", () => {
  root = mkdtempSync(join(tmpdir(), "provider session claude "));
  const worktree = repo();
  const f = files(worktree);
  const argsFile = join(root, "claude args.txt");
  const bin = fakeCli("claude", 'printf "%s\\n" "$@" > "$ARGS_FILE"\nprintf \'%s\\n\' \'{"session_id":"claude-explicit-id","result":"claude resumed"}\'');
  writeSessionRecord(f.record, makeSessionRecord("claude-code", "claude-explicit-id", worktree, "ready", f.result, undefined, ROUTE));

  const outcome = resumeExplicitSession({ recordFile: f.record, instructionFile: f.instruction, resultFile: f.result, expectedRouting: ROUTE, env: env(bin, { ARGS_FILE: argsFile }) });

  expect(outcome.ok).toBe(true);
  expect(readFileSync(argsFile, "utf8").trim().split(/\r?\n/)).toEqual([
    "-p", "Inspect the exact failure and report the SHA.", "--resume", "claude-explicit-id", "--output-format", "json",
  ]);
  expect(readFileSync(f.result, "utf8")).toBe("claude resumed");
});

test("W-146: live session lock refuses a concurrent resume without launching", () => {
  root = mkdtempSync(join(tmpdir(), "provider-session-lock-"));
  const worktree = repo();
  const f = files(worktree);
  const called = join(root, "called");
  const bin = fakeCli("codex", `touch "${called.replace(/\\/g, "/")}"`);
  const record = makeSessionRecord("codex-cli", "busy-id", worktree, "ready", f.result, undefined, ROUTE);
  writeSessionRecord(f.record, record);
  const digest = createHash("sha256").update("codex-cli\0busy-id").digest("hex").slice(0, 32);
  const lock = join(root, "locks", `${digest}.lock`);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    schema: "garelier.provider-session-lock", version: 1, provider: "codex-cli", session_id: "busy-id",
    pid: process.pid, nonce: "live", started_at: new Date().toISOString(),
  }));

  const outcome = resumeExplicitSession({ recordFile: f.record, instructionFile: f.instruction, resultFile: f.result, expectedRouting: ROUTE, lockDir: join(root, "locks"), env: env(bin) });
  expect(outcome.ok).toBe(false);
  expect(outcome.status).toBe("busy");
  expect(outcome.fallback?.reason).toContain("locked");
  expect(existsSync(called)).toBe(false);
});

test("W-146: stale lock is reclaimed and provider failure releases the new lock", () => {
  root = mkdtempSync(join(tmpdir(), "provider-session-stale-"));
  const worktree = repo();
  const f = files(worktree);
  const bin = fakeCli("codex", 'echo "provider broke" >&2\nexit 9');
  writeSessionRecord(f.record, makeSessionRecord("codex-cli", "stale-id", worktree, "ready", f.result, undefined, ROUTE));
  const digest = createHash("sha256").update("codex-cli\0stale-id").digest("hex").slice(0, 32);
  const lockRoot = join(root, "locks");
  const lock = join(lockRoot, `${digest}.lock`);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    schema: "garelier.provider-session-lock", version: 1, provider: "codex-cli", session_id: "stale-id",
    pid: 2_000_000_000, nonce: "stale", started_at: "2000-01-01T00:00:00.000Z",
  }));

  const outcome = resumeExplicitSession({ recordFile: f.record, instructionFile: f.instruction, resultFile: f.result, expectedRouting: ROUTE, lockDir: lockRoot, env: env(bin) });
  expect(outcome.ok).toBe(false);
  expect(outcome.exit_code).toBe(9);
  expect(outcome.fallback?.reason).toBe("provider_resume_failed");
  expect(readdirSync(lockRoot)).toEqual([]);
});

test("W-146: wrong worktree identity and forbidden pseudo-id never launch", () => {
  root = mkdtempSync(join(tmpdir(), "provider-session-identity-"));
  const worktree = repo("first");
  const other = repo("second");
  const f = files(worktree);
  const called = join(root, "called");
  const bin = fakeCli("codex", `touch "${called.replace(/\\/g, "/")}"`);
  writeSessionRecord(f.record, makeSessionRecord("codex-cli", "identity-id", worktree, "ready", f.result, undefined, ROUTE));
  const wrong = resumeExplicitSession({ recordFile: f.record, instructionFile: f.instruction, resultFile: f.result, expectedRouting: ROUTE, worktree: other, env: env(bin) });
  expect(wrong.fallback?.reason).toBe("worktree_identity_mismatch");
  expect(existsSync(called)).toBe(false);

  writeSessionRecord(f.record, makeSessionRecord("codex-cli", "--last", worktree, "ready", f.result, undefined, ROUTE));
  const forbidden = resumeExplicitSession({ recordFile: f.record, instructionFile: f.instruction, resultFile: f.result, expectedRouting: ROUTE, env: env(bin) });
  expect(forbidden.fallback?.reason).toBe("explicit_session_id_missing_or_forbidden");
  expect(existsSync(called)).toBe(false);

  const invalidProvider = makeSessionRecord("codex-cli", "provider-id", worktree, "ready", f.result, undefined, ROUTE) as any;
  invalidProvider.provider = "unknown-provider";
  writeFileSync(f.record, `${JSON.stringify(invalidProvider)}\n`);
  const wrongProvider = resumeExplicitSession({ recordFile: f.record, instructionFile: f.instruction, resultFile: f.result, expectedRouting: ROUTE, env: env(bin) });
  expect(wrongProvider.fallback?.reason).toBe("session_record_missing_or_invalid");
  expect(existsSync(called)).toBe(false);
});

test("W-146: tampered model, effort, or source blocks before provider spawn", () => {
  root = mkdtempSync(join(tmpdir(), "provider-session-route-"));
  const worktree = repo();
  const f = files(worktree);
  const called = join(root, "called");
  const bin = fakeCli("codex", `touch "${called.replace(/\\/g, "/")}"`);
  for (const routing of [
    { ...ROUTE, model: "gpt-5.6-sol" },
    { ...ROUTE, effort: "ultra" },
    { ...ROUTE, source: "blueprint\nforged" },
  ]) {
    const record = makeSessionRecord("codex-cli", "route-id", worktree, "ready", f.result, undefined, ROUTE) as any;
    record.routing = routing;
    writeFileSync(f.record, `${JSON.stringify(record)}\n`);
    const outcome = resumeExplicitSession({
      recordFile: f.record, instructionFile: f.instruction, resultFile: f.result,
      expectedRouting: ROUTE, env: env(bin),
    });
    expect(["routing_authority_mismatch", "session_record_missing_or_invalid"]).toContain(outcome.fallback!.reason);
    expect(existsSync(called)).toBe(false);
  }
});

test("W-146: missing and expired sessions return explicit fresh-dispatch metadata", () => {
  root = mkdtempSync(join(tmpdir(), "provider-session-fallback-"));
  const worktree = repo();
  const f = files(worktree);
  const missing = resumeExplicitSession({ recordFile: f.record, instructionFile: f.instruction, resultFile: f.result, expectedRouting: ROUTE });
  expect(missing.status).toBe("missing");
  expect(missing.fallback?.action).toBe("fresh_dispatch_required");
  expect(JSON.parse(readFileSync(f.result, "utf8")).fallback.reason).toBe("session_record_missing_or_invalid");

  const record = makeSessionRecord("claude-code", "expired-id", worktree, "expired", f.result, {
    required: true, reason: "session_expired", action: "fresh_dispatch_required",
  }, ROUTE);
  writeSessionRecord(f.record, record);
  const expired = resumeExplicitSession({ recordFile: f.record, instructionFile: f.instruction, resultFile: f.result, expectedRouting: ROUTE });
  expect(expired.status).toBe("expired");
  expect(expired.fallback?.action).toBe("fresh_dispatch_required");
});
