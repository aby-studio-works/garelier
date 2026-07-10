#!/usr/bin/env bun
// runtime_recovery_hook.ts — Claude Code runtime recovery hook (workshop W-035).
//
// This hook must never become the reason a Claude session stops. It accepts the
// official hook JSON on stdin, writes best-effort local runtime state under the
// current project cwd, and emits only supported hook response JSON.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;

const RUNTIME_DIR = ".claude/runtime/garelier";
const INCIDENTS_FILE = "incidents.jsonl";
const STATE_FILE = "state.json";
const POLICY =
  "Garelier runtime policy: long-running commands write a log file; final subagent output must end with GARELIER_RUNTIME_STATUS.";
const RECOVERY_PREFIX = "GARELIER_RUNTIME_INCIDENT";
const ESCALATION_PREFIX = "GARELIER_PM_ESCALATION";

interface OpenIncident {
  incident_id: string;
  kind: string;
  agent_id: string;
  attempts: number;
}

interface State {
  open_by_agent_id: Record<string, OpenIncident>;
}

interface Incident extends Json {
  incident_id: string;
  kind: string;
  agent_id: string;
}

function main(): void {
  try {
    const raw = readStdin();
    if (!raw.trim()) return;
    let event: Json;
    try {
      event = JSON.parse(raw) as Json;
    } catch {
      return;
    }
    const name = eventName(event);
    if (name === "SubagentStart") return emitContext("SubagentStart", POLICY);
    if (name === "PostToolUseFailure") return handleFailure(event);
    if (name === "PostToolUse") return handlePostToolUse(event);
    if (name === "SubagentStop") return handleSubagentStop(event);
  } catch {
    // Fail shut for the hook itself: no output, exit 0.
  }
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function eventName(event: Json): string {
  return str(event.hook_event_name) || str(event.event_name) || str(event.event) || "";
}

function isShellTool(event: Json): boolean {
  const tool = str(event.tool_name);
  return tool === "Bash" || tool === "PowerShell";
}

function handleFailure(event: Json): void {
  if (!isShellTool(event)) return;
  const cwd = baseCwd(event);
  const incident = buildIncident(event, isTimeout(str(event.error_message)) ? "bash_command_timeout" : "bash_command_failed");
  appendIncident(cwd, incident);
  if (incident.agent_id) {
    const state = readState(cwd);
    state.open_by_agent_id[incident.agent_id] = {
      incident_id: incident.incident_id,
      kind: incident.kind,
      agent_id: incident.agent_id,
      attempts: 0,
    };
    writeState(cwd, state);
  }
  emitContext(
    "PostToolUseFailure",
    `${RECOVERY_PREFIX}: ${incident.incident_id}. Review .claude/runtime/garelier/incidents.jsonl, recover before continuing, and finish with GARELIER_RUNTIME_STATUS.`,
  );
}

function handlePostToolUse(event: Json): void {
  if (!isShellTool(event)) return;
  const text = collectText(event.tool_response);
  if (!isSpill(text)) return;
  const cwd = baseCwd(event);
  const incident = buildIncident(event, "bash_output_spilled");
  appendIncident(cwd, incident);
  emitContext(
    "PostToolUse",
    `${RECOVERY_PREFIX}: ${incident.incident_id}. Bash output was truncated or saved aside; this is not a command failure, but inspect the log/output before relying on the result.`,
  );
}

function handleSubagentStop(event: Json): void {
  const agentId = str(event.agent_id);
  if (!agentId) return;
  const cwd = baseCwd(event);
  const state = readState(cwd);
  const open = state.open_by_agent_id[agentId];
  if (!open) return;
  const last = str(event.last_assistant_message);
  if (runtimeOk(last)) {
    delete state.open_by_agent_id[agentId];
    writeState(cwd, state);
    return;
  }
  open.attempts = (open.attempts || 0) + 1;
  state.open_by_agent_id[agentId] = open;
  writeState(cwd, state);

  const reason =
    `${RECOVERY_PREFIX}: ${open.incident_id}. Recover the runtime incident, inspect incidents.jsonl, ` +
    `then end with GARELIER_RUNTIME_STATUS: {"runtime_ok": true, "incident_id": "${open.incident_id}"}`;
  if (open.attempts <= 2) {
    emitBlock(reason);
  } else {
    emitContext(
      "SubagentStop",
      `${ESCALATION_PREFIX}: runtime incident ${open.incident_id} still open after 2 recovery blocks; PM must classify rerun safety before further action.`,
    );
  }
}

function buildIncident(event: Json, kind: string): Incident {
  const now = new Date().toISOString();
  return {
    incident_id: `gri-${now.replace(/[^0-9TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    status: "open",
    created_at: now,
    session_id: str(event.session_id),
    cwd: str(event.cwd),
    agent_id: str(event.agent_id),
    agent_type: str(event.agent_type),
    tool_name: str(event.tool_name),
    tool_input: event.tool_input ?? null,
    exit_code: numberOrNull(event.exit_code),
    error_message: str(event.error_message),
  };
}

function baseCwd(event: Json): string {
  return normalizeCwd(str(event.cwd) || ".");
}

function normalizeCwd(cwd: string): string {
  if (/^\/[a-zA-Z]\//.test(cwd)) return `${cwd[1].toUpperCase()}:/${cwd.slice(3)}`;
  return cwd;
}

function runtimeDir(cwd: string): string {
  return join(cwd, RUNTIME_DIR);
}

function appendIncident(cwd: string, incident: Json): void {
  try {
    const dir = runtimeDir(cwd);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, INCIDENTS_FILE), JSON.stringify(incident) + "\n", "utf8");
  } catch {
    // best effort only
  }
}

function readState(cwd: string): State {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeDir(cwd), STATE_FILE), "utf8")) as Partial<State>;
    if (parsed && typeof parsed === "object" && parsed.open_by_agent_id && typeof parsed.open_by_agent_id === "object") {
      return { open_by_agent_id: parsed.open_by_agent_id as Record<string, OpenIncident> };
    }
  } catch {
    // broken/missing state is reset; the hook must not fail the session.
  }
  return { open_by_agent_id: {} };
}

function writeState(cwd: string, state: State): void {
  try {
    const dir = runtimeDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // best effort only
  }
}

function emitContext(hookEventName: string, additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext,
      },
    }) + "\n",
  );
}

function emitBlock(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

function isTimeout(message: string): boolean {
  return /\b(timed out|timeout|time[- ]?out|exceeded|deadline|time limit)\b/i.test(message);
}

function isSpill(text: string): boolean {
  return /(output (was )?(truncated|too large|exceeded)|saved (to|as).*(log|file)|maximum output|showing (first|last)|remaining output|omitted)/i.test(
    text,
  );
}

function runtimeOk(text: string): boolean {
  const marker = text.match(/GARELIER_RUNTIME_STATUS:\s*(\{[^\n\r]*\})/);
  if (!marker) return false;
  try {
    const parsed = JSON.parse(marker[1]) as { runtime_ok?: unknown };
    return parsed.runtime_ok === true;
  } catch {
    return false;
  }
}

function collectText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(collectText).join("\n");
  if (typeof value === "object") {
    const out: string[] = [];
    for (const v of Object.values(value as Record<string, unknown>)) out.push(collectText(v));
    return out.join("\n");
  }
  return "";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

if (import.meta.main) main();
