import { describe, expect, test } from "bun:test";
import { probeClaudeCapabilities, type HelpRunner } from "./claude_capabilities.ts";

function fake(top: string, agents: string, agentsExit = 0): HelpRunner {
  return (_executable, args) => {
    if (args[0] === "agents") return { exitCode: agentsExit, stdout: agents, stderr: "" };
    if (args[0] === "logs" || args[0] === "respawn") return { exitCode: agentsExit, stdout: "help", stderr: "" };
    return { exitCode: 0, stdout: top, stderr: "" };
  };
}

describe("Claude capability probe", () => {
  test("detects only help-exposed background/agents features from an exact executable", () => {
    const result = probeClaudeCapabilities("C:/exact/claude.exe", fake("--bg  --print", "--json logs respawn"));
    expect(result).toMatchObject({ executable: "C:/exact/claude.exe", background_flag: true, agents_command: true, agents_json: true, agents_logs: true, agents_respawn: true, bg_exec: false });
    expect(result.fallback.join(" ")).toContain("--bg --exec unavailable");
  });

  test("never enables a feature from a version string", () => {
    const result = probeClaudeCapabilities("C:/exact/claude.exe", fake("Claude Code 2.1.214", "", 1));
    expect(result).toMatchObject({ background_flag: false, agents_command: false, bg_exec: false, monitor_event_push: false, async_rewake: false });
  });
});
