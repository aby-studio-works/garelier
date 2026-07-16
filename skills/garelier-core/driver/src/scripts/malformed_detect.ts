#!/usr/bin/env bun
// malformed_detect.ts — malformed tool-call detection + recovery vocabulary
// (workshop W-097). Opus 4.8 intermittently emits a broken assistant turn: the
// API reports stop_reason=="tool_use" (the harness is told to expect a tool
// result) yet the message content carries ZERO tool_use blocks. The turn then
// jams — nothing runs, no result arrives, and (unattended) it cascades. The core
// value here is DETECTION: the fix ([[feedback_tool_call_no_prose_before]] — no
// prose immediately before a tool call, resend a call-only turn) is useless if no
// one notices the jam. This module is the shared signature scanner + the canonical
// recovery/self-recovery nudges, consumed by dispatch_watch (a producer subagent's
// transcript) and fleet_watch (the PM's own session transcript, the self face).
//
// SIGNALS (team-lead brief + row W-097):
//   HARD (authoritative, the first detector): the LATEST assistant turn has
//     stop_reason=="tool_use" but 0 tool_use content blocks. This is the Opus 4.8
//     2026-05-29+ regression and cannot be produced by a healthy turn. Judged on
//     the LATEST assistant turn only, so a malformed turn that was already followed
//     by a good tool call (recovered) does NOT re-fire.
//   SOFT (reinforcement, never fires alone): the model self-reports the break in
//     prose — apology / "let me resend" / "malformed" / 「申し訳」「壊れ」「再送」.
//     Apologies appear for many reasons, so soft ALONE is not a detection; it only
//     raises confidence when AND-ed with the hard signal (row (f)).

export interface MalformedFinding {
  detected: boolean; // hard signal on the latest assistant turn (the fire condition)
  hardSignal: boolean; // latest assistant turn: stop_reason=tool_use + 0 tool_use blocks
  softSignal: boolean; // apology / self-correction prose near the tail
  confidence: "none" | "medium" | "high"; // none | hard-only | hard+soft
  assistantTurns: number; // assistant turns seen in the scanned tail (0 = nothing to judge)
  detail: string; // human-readable one-liner for the RESULT/incident line
}

// Canonical recovery nudge for a PRODUCER subagent (row (b)). The PM SendMessages
// this verbatim to the jammed subagent; a bare call-only next turn clears it.
export const MALFORMED_SUBAGENT_NUDGE =
  "次 turn は prose を一切書かず、tool call 単独で再送してください。壊れた直前の turn は破棄して構いません " +
  "(malformed tool-call の回復: 謝罪文や説明を挟まず、最初の応答が tool call になるようにする)。";

// Canonical SELF-recovery nudge for the PM's own session (row (e)). Emitted by the
// external watcher when the broken party is the PM itself — it cannot self-report,
// so the watcher surfaces this for the PM's next resolved turn.
export const MALFORMED_PM_NUDGE =
  "PM 自身の直近 turn が malformed tool-call (stop_reason=tool_use なのに tool_use block 欠落) の可能性。" +
  "次 turn は prose を書かず tool call 単独で送り、壊れた turn は破棄してください。連鎖するなら subagent は " +
  "Opus 4.7 へ downgrade するか reasoning effort を下げて回避します。";

const APOLOGY_RE =
  /(申し訳|すみませ|ごめん|壊れ|再送|やり直し|apolog|sorry|my mistake|i made (an|a) (error|mistake)|let me (try|resend|re-?send|redo|correct)|malformed|that (didn'?t|did not) work)/i;

interface AssistantTurn {
  stopReason: string;
  toolUseBlocks: number;
  text: string;
}

// Normalize one transcript entry to an assistant turn, or null if it is not an
// assistant message. Handles both the Claude Code JSONL envelope
// ({type:"assistant", message:{role,content,stop_reason}}) and a bare
// Messages-API assistant object ({role:"assistant", content, stop_reason}).
function toAssistantTurn(entry: unknown): AssistantTurn | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "";
  const msg = (e.message && typeof e.message === "object" ? e.message : e) as Record<string, unknown>;
  const role = typeof msg.role === "string" ? msg.role : type;
  if (role !== "assistant") return null;
  const stopReason = typeof msg.stop_reason === "string" ? msg.stop_reason : "";
  const content = msg.content;
  let toolUseBlocks = 0;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use") toolUseBlocks++;
      else if (b.type === "text" && typeof b.text === "string") text += `${b.text}\n`;
    }
  }
  return { stopReason, toolUseBlocks, text };
}

// scanTranscriptForMalformed: read a JSONL transcript (one JSON entry per line),
// look only at the TAIL for cheapness, and judge the LATEST assistant turn. Pure
// and fixture-driven; never touches the filesystem.
export function scanTranscriptForMalformed(
  jsonl: string,
  opts: { tailLines?: number } = {},
): MalformedFinding {
  const tailLines = opts.tailLines ?? 400;
  const lines = jsonl.split(/\r?\n/).filter((l) => l.trim());
  const tail = lines.slice(-tailLines);
  const turns: AssistantTurn[] = [];
  for (const line of tail) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const turn = toAssistantTurn(parsed);
    if (turn) turns.push(turn);
  }
  const empty: MalformedFinding = {
    detected: false, hardSignal: false, softSignal: false, confidence: "none",
    assistantTurns: turns.length, detail: "no malformed signature on the latest assistant turn",
  };
  if (turns.length === 0) return empty;

  const latest = turns[turns.length - 1];
  const hardSignal = latest.stopReason === "tool_use" && latest.toolUseBlocks === 0;
  // Soft signal: apology/self-correction prose in the latest turn OR the one just
  // before it (the model often apologizes in the turn that precedes the broken
  // resend). Only meaningful as reinforcement, never a standalone fire.
  const recentText = turns.slice(-2).map((t) => t.text).join("\n");
  const softSignal = APOLOGY_RE.test(recentText);

  if (!hardSignal) {
    return { ...empty, softSignal, detail: softSignal
      ? "soft self-correction prose present but NO hard signal on the latest turn — not a detection (soft never fires alone)"
      : "no malformed signature on the latest assistant turn" };
  }
  const confidence = softSignal ? "high" : "medium";
  return {
    detected: true, hardSignal: true, softSignal, confidence,
    assistantTurns: turns.length,
    detail:
      `latest assistant turn: stop_reason=tool_use with 0 tool_use blocks (malformed, Opus 4.8 regression)` +
      `${softSignal ? " + self-correction prose (confidence high)" : " (confidence medium)"}`,
  };
}
