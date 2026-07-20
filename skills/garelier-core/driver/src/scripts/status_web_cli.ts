#!/usr/bin/env bun
import { rmSync } from "../guard/path_guard.ts";
// One internal Status Web command with start|stop|status subcommands (W-094).
// The three historical entry files remain tiny compatibility adapters, so their
// command names, arguments, output, and exit codes stay unchanged.

import { existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn as nodeSpawn } from "node:child_process";
import { pidAlive, pmCandidates, requireRuntimeExecutable, resolveRuntimeExecutable } from "./_lib.ts";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");
const isWindows = process.platform === "win32";

type StatusAction = "start" | "stop" | "status";

function requireVal(argv: string[], i: number, name: string): string {
  if (i >= argv.length) { err(`missing ${name} value`); process.exit(1); }
  return argv[i];
}
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
function pidTerm(pid: string): void {
  if (isWindows) spawnSync(requireRuntimeExecutable("taskkill"), ["/PID", pid, "/T", "/F"], { windowsHide: true, encoding: "utf8" });
  else try { process.kill(Number(pid), "SIGTERM"); } catch { /* ignore */ }
}
function pidKill9(pid: string): void {
  if (isWindows) spawnSync(requireRuntimeExecutable("taskkill"), ["/PID", pid, "/T", "/F"], { windowsHide: true, encoding: "utf8" });
  else try { process.kill(Number(pid), "SIGKILL"); } catch { /* ignore */ }
}

function usage(action: StatusAction, sink: (s: string) => void): void {
  if (action === "start") {
    sink("Usage: start_status.ts [--pm-id <id>] [--project <path>] [--port <n>] [--loopback] [<pm_id>]");
    sink("");
    sink("Options:");
    sink("  --pm-id <id>       PM whose console to launch (auto-detected if exactly one).");
    sink("  --project <path>   Project root (default: current directory).");
    sink("  --port <n>         Port (default: [status_web] port or 3787).");
    sink("  --loopback         Bind 127.0.0.1 only (default is LAN-reachable 0.0.0.0).");
    sink("  --host <addr>      Explicit bind address (advanced; overrides the default).");
    sink("  -h, --help         Show this help.");
    sink("");
    sink("Stop it with: stop_status.ts --pm-id <id>");
  } else if (action === "stop") {
    sink("Usage: stop_status.ts [--pm-id <id>] [--project <path>] [<pm_id>]");
    sink("");
    sink("Options:");
    sink("  --pm-id <id>       PM whose console to stop (auto-detected if exactly one).");
    sink("  --project <path>   Project root (default: current directory).");
  } else {
    sink("Usage: status_web_status.ts [--pm-id <id>] [--project <path>] [<pm_id>]");
  }
}

interface Parsed {
  projectRoot: string;
  pmId: string;
  extra: string[];
}

function parse(action: StatusAction, argv: string[]): Parsed {
  let projectRoot = "";
  let pmId = "";
  const extra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pm-id") pmId = requireVal(argv, ++i, "--pm-id");
    else if (a === "--project") projectRoot = requireVal(argv, ++i, "--project");
    else if (action === "start" && a === "--port") extra.push("--port", requireVal(argv, ++i, "--port"));
    else if (action === "start" && (a === "--loopback" || a === "--local")) extra.push("--loopback");
    else if (action === "start" && a === "--host") extra.push("--host", requireVal(argv, ++i, "--host"));
    else if (a === "-h" || a === "--help") { usage(action, out); process.exit(0); }
    else if (a === "--") break;
    else if (a.startsWith("-")) {
      err(`Unknown option: ${a}`);
      if (action !== "status") usage(action, err);
      process.exit(1);
    } else if (!pmId) pmId = a;
    else if (!projectRoot) projectRoot = a;
    else { err(`Unexpected positional argument: ${a}`); process.exit(1); }
  }
  return { projectRoot: projectRoot || process.cwd(), pmId, extra };
}

function resolvePm(action: StatusAction, parsed: Parsed): { projectRoot: string; garelierRoot: string; pmId: string; extra: string[] } {
  const { projectRoot, extra } = parsed;
  let { pmId } = parsed;
  const garelierRoot = `${projectRoot}/__garelier`;
  if (!isDir(garelierRoot)) {
    err(action === "start"
      ? `Error: not a Garelier project root: ${projectRoot} (no __garelier/)`
      : `Error: not a Garelier project root: ${projectRoot}`);
    process.exit(1);
  }
  if (!pmId) {
    const candidates = pmCandidates(garelierRoot);
    if (candidates.length === 0) {
      err(action === "start"
        ? `Error: no Garelier control namespace under ${garelierRoot}; initialize Garelier Control or run setup_wizard.`
        : `Error: no Garelier control namespace under ${garelierRoot}.`);
      process.exit(1);
    }
    if (candidates.length === 1) pmId = candidates[0];
    else {
      err("Error: multiple PMs found — pass --pm-id <id>.");
      for (const p of candidates) err(`         - ${p}`);
      process.exit(1);
    }
  }
  return { projectRoot, garelierRoot, pmId, extra };
}

function start(argv: string[]): never {
  const { projectRoot, garelierRoot, pmId, extra } = resolvePm("start", parse("start", argv));
  const selfCoreDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const skillDir = process.env.GARELIER_CORE_DIR
    || (process.env.CLAUDE_PLUGIN_ROOT ? `${process.env.CLAUDE_PLUGIN_ROOT}/skills/garelier-core` : "")
    || (existsSync(`${selfCoreDir}/SKILL.md`) ? selfCoreDir : "")
    || `${process.env.HOME}/.claude/skills/garelier-core`;
  const entryPoint = `${skillDir}/driver/src/status_web.ts`;
  const pidFile = `${garelierRoot}/${pmId}/runtime/status_web/status_web.json`;
  const logDir = `${garelierRoot}/${pmId}/runtime/status_web`;
  const stdoutLog = `${logDir}/status_web.stdout.log`;

  if (!isFile(`${garelierRoot}/${pmId}/_pm/setup_config.toml`) && !isFile(`${garelierRoot}/${pmId}/control/control.toml`)) {
    err(`Error: Garelier namespace '${pmId}' not found.`); process.exit(1);
  }
  if (!isFile(entryPoint)) {
    err(`Error: status_web entry not found at ${entryPoint}`);
    err("       Reinstall the garelier-core skill (or set GARELIER_CORE_DIR).");
    process.exit(1);
  }
  const bun = resolveRuntimeExecutable("bun");
  if (!bun) {
    err("Error: required Bun executable is unavailable."); process.exit(1);
  }
  if (existsSync(pidFile)) {
    const existing = readFileSync(pidFile, "utf8").match(/"pid":\s*([0-9]+)/)?.[1] ?? "";
    if (existing && pidAlive(existing)) {
      err(`Status console already running for PM '${pmId}' (pid ${existing}).`);
      err(`  Stop it first: stop_status.ts --pm-id ${pmId}`);
      process.exit(1);
    }
    rmSync(pidFile, { force: true });
  }
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(stdoutLog, "a");
  const child = nodeSpawn(bun, ["run", entryPoint, "--project", projectRoot, "--pm-id", pmId, ...extra], {
    cwd: projectRoot,
    env: { ...process.env, GARELIER_PM_ID: pmId, GARELIER_CORE_DIR: skillDir },
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  for (let n = 0; n < 10; n++) { if (existsSync(pidFile)) break; Bun.sleepSync(300); }
  let url = "";
  try { url = readFileSync(pidFile, "utf8").match(/"url":\s*"([^"]+)"/)?.[1] ?? ""; } catch { /* not ready */ }
  out(`Status console launched (PID ${child.pid}, detached) for PM '${pmId}'.`);
  if (url) out(`  URL:   ${url}`);
  out(`  Log:   ${stdoutLog}`);
  out(`  Stop:  stop_status.ts --pm-id ${pmId}`);
  process.exit(0);
}

function stop(argv: string[]): never {
  const { garelierRoot, pmId } = resolvePm("stop", parse("stop", argv));
  const pidFile = `${garelierRoot}/${pmId}/runtime/status_web/status_web.json`;
  if (!isFile(pidFile)) {
    out(`No status console pidfile for PM '${pmId}' — not running. Nothing to stop.`); process.exit(0);
  }
  const pid = readFileSync(pidFile, "utf8").match(/"pid":\s*([0-9]+)/)?.[1] ?? "";
  if (!pid) {
    out(`Pidfile present but no pid parsed; removing stale ${pidFile}.`);
    rmSync(pidFile, { force: true }); process.exit(0);
  }
  if (!pidAlive(pid)) {
    out(`Status console (pid ${pid}) is not alive; removing stale pidfile.`);
    rmSync(pidFile, { force: true }); process.exit(0);
  }
  pidTerm(pid);
  for (let n = 0; n < 10; n++) { if (!pidAlive(pid)) break; Bun.sleepSync(300); }
  if (pidAlive(pid)) { pidKill9(pid); Bun.sleepSync(300); }
  rmSync(pidFile, { force: true });
  out(`Status console stopped for PM '${pmId}' (pid ${pid}).`);
  process.exit(0);
}

function status(argv: string[]): never {
  const { garelierRoot, pmId } = resolvePm("status", parse("status", argv));
  const pidFile = `${garelierRoot}/${pmId}/runtime/status_web/status_web.json`;
  if (!isFile(pidFile)) {
    out(`Status console for PM '${pmId}': DOWN (no pidfile).`); process.exit(1);
  }
  const raw = readFileSync(pidFile, "utf8");
  const pid = raw.match(/"pid":\s*([0-9]+)/)?.[1] ?? "";
  const url = raw.match(/"url":\s*"([^"]+)"/)?.[1] ?? "";
  if (pid && pidAlive(pid)) {
    out(`Status console for PM '${pmId}': UP (pid ${pid}).`);
    if (url) out(`  URL: ${url}`);
    process.exit(0);
  }
  out(`Status console for PM '${pmId}': DOWN (stale pidfile, pid ${pid || "?"} not alive).`);
  process.exit(1);
}

export function statusWebMain(argv = process.argv.slice(2)): never {
  const action = argv[0] as StatusAction;
  if (action === "start") return start(argv.slice(1));
  if (action === "stop") return stop(argv.slice(1));
  if (action === "status") return status(argv.slice(1));
  err("usage: status_web_cli.ts start|stop|status [args...]");
  process.exit(2);
}

if (import.meta.main) statusWebMain();
