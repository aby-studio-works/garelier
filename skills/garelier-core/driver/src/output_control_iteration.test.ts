// Integration: runIteration honors Output Control (DEC-028) end to end via a
// mock provider — the stored model_result is an excerpt, an over-budget response
// is warned, and a usage-summary record is written.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFinalActionKind, runIteration } from "./role.ts";
import { Logger } from "./log.ts";
import { DEFAULT_OUTPUT_CONTROL } from "./output_control.ts";

// A mock "claude-code" CLI: ignores its flags, reads the prompt from stdin, and
// emits a deliberately long JSON result so the budget check trips.
const MOCK = `
import { readFileSync } from "node:fs";
try { readFileSync(0, "utf8"); } catch {}
const result = "X".repeat(2000);
process.stdout.write(JSON.stringify({
  result,
  total_cost_usd: 0.01,
  num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 900, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
}));
process.exit(0);
`;

describe("runIteration + Output Control", () => {
  test("stores an excerpt, warns over-budget, and records usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-oc-"));
    try {
      const pmId = "tpm";
      const cwd = join(root, "checkout");
      const skillCoreDir = join(root, "skills", "garelier-core");
      const tmpDir = join(root, "tmp");
      const logFile = join(root, "worker-w1.jsonl");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(skillCoreDir, { recursive: true });
      mkdirSync(tmpDir, { recursive: true });
      const mockPath = join(root, "mock.mjs");
      writeFileSync(mockPath, MOCK, "utf8");

      const log = new Logger("worker-w1", logFile);
      const result = await runIteration({
        role: "worker",
        ctx: { projectRoot: root, pmId, workerOrScoutId: "w1", workerOrScoutCwd: cwd, worktreeDir: cwd },
        log,
        provider: "claude-code",
        tmpDir,
        projectRoot: root,
        skillCoreDir,
        spawnCmd: [process.execPath, mockPath],
        outputControl: { ...DEFAULT_OUTPUT_CONTROL, modelResultLogChars: 600 },
      });

      expect(result.outcome).toBe("ok");

      const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));

      const mr = lines.find((l) => l.event === "model_result");
      expect(mr).toBeDefined();
      expect(mr.result_chars).toBe(2000);
      expect(mr.over_budget).toBe(true); // worker = compact, soft 900 < 2000
      expect(mr.output_profile).toBe("compact");
      expect(mr.text.length).toBeLessThan(700); // excerpt, not the full 2000
      expect(mr.text).toContain("[+1400 chars");

      const warn = lines.find((l) => l.event === "output_budget_exceeded");
      expect(warn).toBeDefined();
      expect(warn.level).toBe("warn");
      expect(warn.result_chars).toBe(2000);

      const end = lines.find((l) => l.event === "iteration_end");
      expect(end).toBeDefined();
      expect(end.prompt_bytes).toBeGreaterThan(0);
      expect(end.final_action_kind).toBe("unknown");

      // usage summary written under runtime/driver/usage/<month>.jsonl
      const usageDir = join(root, "__garelier", pmId, "runtime", "driver", "usage");
      const usageFiles = readdirSync(usageDir).filter((f) => f.endsWith(".jsonl"));
      expect(usageFiles.length).toBe(1);
      const usage = JSON.parse(readFileSync(join(usageDir, usageFiles[0]), "utf8").trim());
      expect(usage.role).toBe("worker");
      expect(usage.id).toBe("w1");
      expect(usage.result_chars).toBe(2000);
      expect(usage.over_budget).toBe(true);
      expect(usage.output_tokens).toBe(900);
      expect(usage.prompt_bytes).toBeGreaterThan(0);
      expect(usage.final_action_kind).toBe("unknown");
      expect(usage.outcome).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("error_tail_chars = 0 disables the failure tail (no slice(-0) whole-string bug)", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-oc-"));
    try {
      const pmId = "tpm";
      const cwd = join(root, "checkout");
      const skillCoreDir = join(root, "skills", "garelier-core");
      const tmpDir = join(root, "tmp");
      const logFile = join(root, "worker-w1.jsonl");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(skillCoreDir, { recursive: true });
      mkdirSync(tmpDir, { recursive: true });
      // A mock that writes a long stderr and exits non-zero (failure path).
      const failMock = `
process.stderr.write("E".repeat(3000));
process.exit(7);
`;
      const mockPath = join(root, "failmock.mjs");
      writeFileSync(mockPath, failMock, "utf8");

      const log = new Logger("worker-w1", logFile);
      const result = await runIteration({
        role: "worker",
        ctx: { projectRoot: root, pmId, workerOrScoutId: "w1", workerOrScoutCwd: cwd, worktreeDir: cwd },
        log,
        provider: "claude-code",
        tmpDir,
        projectRoot: root,
        skillCoreDir,
        spawnCmd: [process.execPath, mockPath],
        outputControl: { ...DEFAULT_OUTPUT_CONTROL, errorTailChars: 0 },
      });

      expect(result.outcome).toBe("non_zero_exit");
      const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const failed = lines.find((l) => l.event === "iteration_failed");
      expect(failed).toBeDefined();
      // The bug: slice(-0) would log the full 3000-char stderr. The guard => "".
      expect(failed.stderr_tail).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("provider result text can classify a non-zero exit as rate_limited", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-oc-"));
    try {
      const pmId = "tpm";
      const cwd = join(root, "checkout");
      const skillCoreDir = join(root, "skills", "garelier-core");
      const tmpDir = join(root, "tmp");
      const logFile = join(root, "worker-w1.jsonl");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(skillCoreDir, { recursive: true });
      mkdirSync(tmpDir, { recursive: true });
      const rateLimitMock = `
process.stdout.write(JSON.stringify({ result: "You've hit your session limit · resets 1:40pm (Asia/Tokyo)" }));
process.exit(1);
`;
      const mockPath = join(root, "ratelimit.mjs");
      writeFileSync(mockPath, rateLimitMock, "utf8");

      const log = new Logger("worker-w1", logFile);
      const result = await runIteration({
        role: "worker",
        ctx: { projectRoot: root, pmId, workerOrScoutId: "w1", workerOrScoutCwd: cwd, worktreeDir: cwd },
        log,
        provider: "claude-code",
        tmpDir,
        projectRoot: root,
        skillCoreDir,
        spawnCmd: [process.execPath, mockPath],
      });

      expect(result.outcome).toBe("rate_limited");
      expect(result.errorMessage).toContain("session limit");
      const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.some((l) => l.event === "rate_limited")).toBe(true);
      expect(lines.some((l) => l.event === "iteration_failed")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("disabled output control falls back to legacy 1000-char excerpt, no warn, no usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "symph-oc-"));
    try {
      const pmId = "tpm";
      const cwd = join(root, "checkout");
      const skillCoreDir = join(root, "skills", "garelier-core");
      const tmpDir = join(root, "tmp");
      const logFile = join(root, "worker-w1.jsonl");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(skillCoreDir, { recursive: true });
      mkdirSync(tmpDir, { recursive: true });
      const mockPath = join(root, "mock.mjs");
      writeFileSync(mockPath, MOCK, "utf8");

      const log = new Logger("worker-w1", logFile);
      await runIteration({
        role: "worker",
        ctx: { projectRoot: root, pmId, workerOrScoutId: "w1", workerOrScoutCwd: cwd, worktreeDir: cwd },
        log,
        provider: "claude-code",
        tmpDir,
        projectRoot: root,
        skillCoreDir,
        spawnCmd: [process.execPath, mockPath],
        outputControl: { ...DEFAULT_OUTPUT_CONTROL, enabled: false, usageSummary: false },
      });

      const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const mr = lines.find((l) => l.event === "model_result");
      expect(mr.text.length).toBe(1000); // legacy slice(0, 1000), no marker
      expect(lines.find((l) => l.event === "output_budget_exceeded")).toBeUndefined();
      expect(() => readdirSync(join(root, "__garelier", pmId, "runtime", "driver", "usage"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies final action lines for usage telemetry", () => {
    expect(classifyFinalActionKind("done\ntransition: WORKING -> REPORTING")).toBe("transition");
    expect(classifyFinalActionKind("details\naction: committed abc123")).toBe("action");
    expect(classifyFinalActionKind("details\naction: coord_only: refreshed manifest")).toBe("coord_only");
    expect(classifyFinalActionKind("details\naction: status-only refresh")).toBe("coord_only");
    expect(classifyFinalActionKind("no action: idle")).toBe("no_action");
    expect(classifyFinalActionKind("summary only")).toBe("unknown");
  });
});
