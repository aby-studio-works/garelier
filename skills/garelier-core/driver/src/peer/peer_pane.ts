// Shared peer-pane helpers (DEC-076). One implementation of the terminal-pane
// plumbing used by BOTH the Wanderer launcher/driver and the PM review gate, so
// nudging, liveness, and read-approval/write-refusal behave identically wherever
// a Wanderer pane is driven. Pure multiplexer glue (wezterm / tmux) — no target
// or project coupling. When no multiplexer is available every call degrades to a
// safe no-op / false, so callers that find no live pane simply fall back to the
// passive channel handshake (the Observer floor is never weakened by this file).

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface PaneRec {
  mux: string;
  paneId: string;
}

function run(cmd: string[]): { code: number; out: string } {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, out: new TextDecoder().decode(p.stdout) };
  } catch {
    return { code: 1, out: "" };
  }
}

// A recorded Wanderer pane (written by wanderer_launch.ts). null = none recorded.
export function paneInfo(dir: string): PaneRec | null {
  const p = join(dir, "pane.json");
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, "utf8"));
    if (!r || !r.mux || r.paneId == null) return null;
    return { mux: String(r.mux), paneId: String(r.paneId) };
  } catch {
    return null;
  }
}

// Is the recorded pane still a live pane in its multiplexer? (mirrors the check
// in wanderer_launch.ts). false on any error / unknown mux — caller treats the
// pane as absent and uses the passive path.
export function paneAlive(mux: string, paneId: string): boolean {
  if (mux === "wezterm") {
    const r = run(["wezterm", "cli", "list", "--format", "json"]);
    if (r.code !== 0) return false;
    try {
      return (JSON.parse(r.out) as Array<{ pane_id: number }>).some(
        (p) => String(p.pane_id) === paneId,
      );
    } catch {
      return false;
    }
  }
  if (mux === "tmux") {
    const r = run(["tmux", "list-panes", "-a", "-F", "#{pane_id}"]);
    return r.code === 0 && r.out.split("\n").includes(paneId);
  }
  return false;
}

// Type text into the pane and submit it as a turn.
export function paneSend(mux: string, id: string, text: string): void {
  if (mux === "tmux") {
    run(["tmux", "send-keys", "-t", id, text, "Enter"]);
    return;
  }
  run(["wezterm", "cli", "send-text", "--pane-id", id, "--no-paste", text]);
  run(["wezterm", "cli", "send-text", "--pane-id", id, "--no-paste", "\r"]);
}

// Submit a bare Enter (e.g. to confirm an approval prompt's default).
export function paneEnter(mux: string, id: string): void {
  if (mux === "tmux") {
    run(["tmux", "send-keys", "-t", id, "Enter"]);
    return;
  }
  run(["wezterm", "cli", "send-text", "--pane-id", id, "--no-paste", "\r"]);
}

// Capture the pane's current visible text.
export function paneGet(mux: string, id: string): string {
  if (mux === "tmux") return run(["tmux", "capture-pane", "-t", id, "-p"]).out;
  return run(["wezterm", "cli", "get-text", "--pane-id", id]).out;
}

// Read-only command escalations that are SAFE to auto-approve when an advisory,
// read-only peer (the Wanderer) asks to run them — plus the peer cli itself
// (ack / progress / review_reply / unavailable are the Wanderer's ONLY writes,
// and they target the peer-channel, not the project).
export const READ_CMDS =
  /Get-Content|Select-String|\brg\b|Test-Path|Resolve-Path|\bcat\b|\bls\b|\bdir\b|\btype\b|\bfind\b|peer\/cli\.ts|cli\.ts (send|presence|read)/;

// Project-mutating / repo commands a read-only advisory peer must NEVER be
// auto-approved to run; an attempt is surfaced, never confirmed.
export const WRITE_CMDS =
  /Set-Content|Out-File|Add-Content|Remove-Item|New-Item|Move-Item|Rename-Item|Set-ItemProperty|git\s+(commit|add|push|checkout|reset|merge)|cargo\s|npm\s|>>|\s>\s/;

// A pane showing a "run this command?" approval prompt.
export const APPROVAL_RE = /Would you like to run|Allow command|Approve|don't ask again/i;

// A pane that is mid-turn (the model is actively thinking) — proof of life even
// when no turn-boundary heartbeat has been written yet.
export const WORKING_RE = /Working \(|esc to interrupt/i;
