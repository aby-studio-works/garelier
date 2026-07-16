import { describe, test, expect } from "bun:test";
import {
  scanTranscriptForMalformed,
  MALFORMED_SUBAGENT_NUDGE,
  MALFORMED_PM_NUDGE,
} from "./malformed_detect.ts";

// W-097: the malformed tool-call signature scanner. HARD signal (authoritative):
// the LATEST assistant turn reports stop_reason=tool_use with 0 tool_use blocks
// (the Opus 4.8 regression). SOFT signal (reinforcement, never fires alone):
// apology / self-correction prose near the tail.

// Claude Code JSONL envelope: {type:"assistant", message:{role,content,stop_reason}}.
function ccAssistant(content: unknown[], stopReason: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content, stop_reason: stopReason } });
}
function ccUser(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}
const textBlock = (t: string) => ({ type: "text", text: t });
const toolBlock = (name: string) => ({ type: "tool_use", id: "tu_1", name, input: {} });

describe("scanTranscriptForMalformed — hard signal", () => {
  test("latest turn stop_reason=tool_use with 0 tool_use blocks -> detected (medium)", () => {
    const jsonl = [
      ccUser("do the thing"),
      ccAssistant([textBlock("Let me run the command.")], "tool_use"),
    ].join("\n");
    const f = scanTranscriptForMalformed(jsonl);
    expect(f.detected).toBe(true);
    expect(f.hardSignal).toBe(true);
    expect(f.softSignal).toBe(false);
    expect(f.confidence).toBe("medium");
  });

  test("hard + apology prose -> detected, confidence high, softSignal true", () => {
    const jsonl = [
      ccUser("do the thing"),
      ccAssistant([textBlock("申し訳ありません、もう一度やり直します。")], "tool_use"),
    ].join("\n");
    const f = scanTranscriptForMalformed(jsonl);
    expect(f.detected).toBe(true);
    expect(f.softSignal).toBe(true);
    expect(f.confidence).toBe("high");
  });

  test("apology in the PRIOR turn also raises the soft signal", () => {
    const jsonl = [
      ccAssistant([textBlock("Sorry, let me resend that call.")], "end_turn"),
      ccAssistant([textBlock("here goes")], "tool_use"),
    ].join("\n");
    const f = scanTranscriptForMalformed(jsonl);
    expect(f.detected).toBe(true);
    expect(f.softSignal).toBe(true);
    expect(f.confidence).toBe("high");
  });
});

describe("scanTranscriptForMalformed — non-detections", () => {
  test("healthy turn: stop_reason=tool_use WITH a tool_use block -> not detected", () => {
    const jsonl = [
      ccUser("go"),
      ccAssistant([textBlock("running"), toolBlock("Bash")], "tool_use"),
    ].join("\n");
    expect(scanTranscriptForMalformed(jsonl).detected).toBe(false);
  });

  test("recovered: a malformed turn FOLLOWED by a good tool call -> latest clean -> not detected", () => {
    const jsonl = [
      ccAssistant([textBlock("Let me run it.")], "tool_use"), // the broken turn
      ccAssistant([toolBlock("Bash")], "tool_use"), // recovered, call-only
    ].join("\n");
    const f = scanTranscriptForMalformed(jsonl);
    expect(f.detected).toBe(false);
    expect(f.hardSignal).toBe(false);
  });

  test("think-phase shape: text turns ending end_turn, no malformed signature -> not detected", () => {
    const jsonl = [
      ccUser("design-heavy row"),
      ccAssistant([textBlock("Reading the spec, considering the approach...")], "end_turn"),
    ].join("\n");
    expect(scanTranscriptForMalformed(jsonl).detected).toBe(false);
  });

  test("soft signal ALONE (apology but latest turn is a clean end_turn) -> not detected", () => {
    const jsonl = [
      ccAssistant([textBlock("Sorry about that, here is the summary.")], "end_turn"),
    ].join("\n");
    const f = scanTranscriptForMalformed(jsonl);
    expect(f.detected).toBe(false);
    expect(f.softSignal).toBe(true);
  });

  test("empty transcript -> not detected, 0 assistant turns", () => {
    const f = scanTranscriptForMalformed("");
    expect(f.detected).toBe(false);
    expect(f.assistantTurns).toBe(0);
  });

  test("unparseable lines are skipped, not fatal", () => {
    const jsonl = ["{not json", ccAssistant([toolBlock("Bash")], "tool_use")].join("\n");
    expect(scanTranscriptForMalformed(jsonl).detected).toBe(false);
  });
});

describe("scanTranscriptForMalformed — envelope shapes", () => {
  test("bare Messages-API assistant object (no type/message envelope) is understood", () => {
    const bare = JSON.stringify({ role: "assistant", content: [textBlock("no call here")], stop_reason: "tool_use" });
    expect(scanTranscriptForMalformed(bare).detected).toBe(true);
  });
});

describe("canonical nudges (row b/e)", () => {
  test("subagent nudge names the prose-free, call-only resend recovery", () => {
    expect(MALFORMED_SUBAGENT_NUDGE).toContain("tool call 単独で再送");
    expect(MALFORMED_SUBAGENT_NUDGE).toContain("破棄");
  });
  test("PM self nudge names the hard signal and the downgrade mitigation", () => {
    expect(MALFORMED_PM_NUDGE).toContain("stop_reason=tool_use");
    expect(MALFORMED_PM_NUDGE).toContain("Opus 4.7");
  });
});
