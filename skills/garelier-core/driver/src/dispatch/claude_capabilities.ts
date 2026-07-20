import { resolveBashExecutable, resolveRuntimeExecutable } from "../scripts/_lib.ts";

export interface ClaudeCapabilities {
  executable: string;
  probed: true;
  background_flag: boolean;
  agents_command: boolean;
  agents_json: boolean;
  agents_logs: boolean;
  agents_respawn: boolean;
  bg_exec: boolean;
  monitor_event_push: boolean;
  async_rewake: boolean;
  fallback: string[];
}

export type HelpRunner = (executable: string, args: string[]) => { exitCode: number; stdout: string; stderr: string };

function realRunner(executable: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const bash = resolveBashExecutable();
  if (!bash) return { exitCode: 127, stdout: "", stderr: "Git Bash not found" };
  const result = Bun.spawnSync([bash, "-c", 'exec "$1" "${@:2}"', "garelier-claude-probe", executable, ...args], {
    windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function has(text: string, pattern: RegExp): boolean { return pattern.test(text); }

export function probeClaudeCapabilities(executable: string, runner: HelpRunner = realRunner): ClaudeCapabilities {
  const top = runner(executable, ["--help"]);
  const agents = runner(executable, ["agents", "--help"]);
  const logs = runner(executable, ["logs", "--help"]);
  const respawn = runner(executable, ["respawn", "--help"]);
  const topText = `${top.stdout}\n${top.stderr}`;
  const agentsText = agents.exitCode === 0 ? `${agents.stdout}\n${agents.stderr}` : "";
  const capabilities: ClaudeCapabilities = {
    executable,
    probed: true,
    background_flag: top.exitCode === 0 && has(topText, /(?:^|\s)--bg(?:\s|,|$)/m),
    agents_command: agents.exitCode === 0,
    agents_json: has(agentsText, /(?:^|\s)--json(?:\s|,|$)/m),
    agents_logs: logs.exitCode === 0,
    agents_respawn: respawn.exitCode === 0,
    bg_exec: top.exitCode === 0 && has(topText, /(?:^|\s)--exec(?:\s|,|$)/m),
    monitor_event_push: has(`${topText}\n${agentsText}`, /\bMonitor\b.*\bevent|\bevent.*\bMonitor\b/i),
    async_rewake: has(`${topText}\n${agentsText}`, /\basyncRewake\b/),
    fallback: [],
  };
  if (!capabilities.bg_exec) capabilities.fallback.push("--bg --exec unavailable: use the durable long-job broker; do not infer from version");
  if (!capabilities.monitor_event_push) capabilities.fallback.push("Monitor event push unavailable: broker completion/startup scan is primary");
  if (!capabilities.async_rewake) capabilities.fallback.push("asyncRewake unavailable: no auxiliary hook wake");
  return capabilities;
}

export function probeInstalledClaude(): ClaudeCapabilities | null {
  const executable = resolveRuntimeExecutable("claude");
  return executable ? probeClaudeCapabilities(executable) : null;
}

if (import.meta.main) {
  const result = probeInstalledClaude();
  process.stdout.write(`${JSON.stringify(result ?? { probed: false, reason: "claude executable not found" }, null, 2)}\n`);
  process.exit(result ? 0 : 3);
}
