#!/usr/bin/env bun
// Detached Worker / Scout / Smith iteration runner.
//
// main.ts launches this process with a launch JSON file and immediately
// returns to the driver poll loop. The child performs exactly one provider
// iteration, writes the normal per-role JSONL log, then records its outcome
// into the role lease file under runtime/driver/pids/.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Logger } from "./log.ts";
import { runIteration } from "./role.ts";
import type { RunnerDef } from "./config.ts";
import type { RoleContext, DetachedAgentRole } from "./prompts.ts";
import type { PermissionProfile } from "./config.ts";
import type { OutputControlConfig } from "./output_control.ts";

interface AgentLaunch {
  key: string;
  role: DetachedAgentRole;
  sourceLabel: string;
  runner: RunnerDef;
  ctx: RoleContext;
  logFile: string;
  leaseFile: string;
  tmpDir: string;
  projectRoot: string;
  skillCoreDir: string;
  spawnCmd?: string[];
  maxBudgetUsd?: number;
  permissionProfile?: PermissionProfile;
  outputControl?: OutputControlConfig;
  autofixCommands?: string[];
}

function parseArgs(argv: string[]): string {
  const idx = argv.indexOf("--launch");
  if (idx < 0 || !argv[idx + 1]) {
    process.stderr.write("usage: agent_child.ts --launch <launch.json>\n");
    process.exit(2);
  }
  return argv[idx + 1];
}

function readLaunch(path: string): AgentLaunch {
  return JSON.parse(readFileSync(path, "utf8")) as AgentLaunch;
}

function patchLease(path: string, patch: Record<string, unknown>): void {
  let prev: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      prev = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      prev = {};
    }
  }
  const next = { ...prev, ...patch };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, path);
}

async function main(): Promise<void> {
  const launchPath = parseArgs(process.argv.slice(2));
  const launch = readLaunch(launchPath);
  const log = new Logger(launch.sourceLabel, launch.logFile,
    launch.outputControl
      ? { maxBytes: launch.outputControl.driverLogMaxBytes, keepFiles: launch.outputControl.driverLogKeepFiles }
      : undefined); // DEC-028 rotation for per-agent JSONL

  patchLease(launch.leaseFile, {
    status: "running",
    child_pid: process.pid,
    child_started_at: new Date().toISOString(),
  });

  try {
    const result = await runIteration({
      role: launch.role,
      ctx: launch.ctx,
      log,
      provider: launch.runner.provider,
      tmpDir: launch.tmpDir,
      projectRoot: launch.projectRoot,
      skillCoreDir: launch.skillCoreDir,
      spawnCmd: launch.spawnCmd,
      model: launch.runner.model,
      effort: launch.runner.effort,
      maxBudgetUsd: launch.maxBudgetUsd,
      permissionProfile: launch.permissionProfile,
      outputControl: launch.outputControl,
      autofixCommands: launch.autofixCommands,
    });

    patchLease(launch.leaseFile, {
      status: "finished",
      ended_at: new Date().toISOString(),
      outcome: result.outcome,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      final_action_kind: result.finalActionKind ?? null,
      error_message: result.errorMessage?.slice(0, 1000) ?? null,
      cost_usd: result.costUsd ?? null,
      tokens: result.tokens ?? null,
    });
  } catch (e) {
    const message = (e as Error).stack ?? (e as Error).message;
    patchLease(launch.leaseFile, {
      status: "finished",
      ended_at: new Date().toISOString(),
      outcome: "child_error",
      exit_code: null,
      error_message: message.slice(0, 1000),
    });
    log.error("agent_child_error", { message });
  }
}

main().catch((e) => {
  process.stderr.write(`agent_child fatal: ${(e as Error).stack ?? (e as Error).message}\n`);
  process.exit(1);
});
