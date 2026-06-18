import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelDir, appendMessage, inboxFor, lastReadId, setReadId,
  writePresence, readPresence, isPresent, awaitMessage,
} from "./channel.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "garelier-peer-"));
}
const PM = "aby_works";
const CH = "wanderer";

describe("peer-channel store", () => {
  test("append assigns monotonic ids and ISO ts", () => {
    const p = tmpProject();
    const a = appendMessage(p, PM, CH, { from: "pm", to: "wanderer-01", kind: "review_request", body: "review DEC-076" });
    const b = appendMessage(p, PM, CH, { from: "wanderer-01", to: "pm", kind: "review_reply", body: "PASS_WITH_NOTES" });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("inbox returns unread messages addressed to the peer, not its own", () => {
    const p = tmpProject();
    const dir = channelDir(p, PM, CH);
    appendMessage(p, PM, CH, { from: "pm", to: "wanderer-01", kind: "review_request", body: "q1" });
    appendMessage(p, PM, CH, { from: "wanderer-01", to: "pm", kind: "review_reply", body: "own — excluded" });
    appendMessage(p, PM, CH, { from: "pm", to: "all", kind: "note", body: "broadcast" });

    const inbox = inboxFor(dir, "wanderer-01");
    expect(inbox.map((m) => m.body)).toEqual(["q1", "broadcast"]); // not its own reply
  });

  test("read cursor suppresses already-read messages", () => {
    const p = tmpProject();
    const dir = channelDir(p, PM, CH);
    const m1 = appendMessage(p, PM, CH, { from: "pm", to: "wanderer-01", kind: "review_request", body: "q1" });
    expect(inboxFor(dir, "wanderer-01")).toHaveLength(1);
    setReadId(dir, "wanderer-01", m1.id);
    expect(lastReadId(dir, "wanderer-01")).toBe(1);
    expect(inboxFor(dir, "wanderer-01")).toHaveLength(0);
    appendMessage(p, PM, CH, { from: "pm", to: "wanderer-01", kind: "review_request", body: "q2" });
    expect(inboxFor(dir, "wanderer-01").map((m) => m.body)).toEqual(["q2"]);
  });

  test("presence heartbeat: fresh = present, stale = absent, preserves startedAt", () => {
    const p = tmpProject();
    const dir = channelDir(p, PM, CH);
    const t0 = "2026-06-18T00:00:00.000Z";
    const first = writePresence(p, PM, CH, { peer: "wanderer-01", tool: "codex", model: "strong", nowIso: t0 });
    const t1 = "2026-06-18T00:00:30.000Z";
    const beat = writePresence(p, PM, CH, { peer: "wanderer-01", tool: "codex", nowIso: t1 });
    expect(beat.startedAt).toBe(first.startedAt); // startedAt preserved across beats
    expect(beat.beatAt).toBe(t1);

    const pres = readPresence(dir, "wanderer-01");
    const beatMs = Date.parse(t1);
    expect(isPresent(pres, 120_000, beatMs + 60_000)).toBe(true);   // 60s old < 120s
    expect(isPresent(pres, 120_000, beatMs + 200_000)).toBe(false); // 200s old > 120s
    expect(isPresent(null, 120_000, beatMs)).toBe(false);
  });

  test("awaitMessage resolves on a matching reply and times out otherwise", async () => {
    const p = tmpProject();
    // already-present matching reply (id 1) found immediately
    appendMessage(p, PM, CH, { from: "wanderer-01", to: "pm", kind: "review_reply", body: "PASS" });
    const hit = await awaitMessage(p, PM, CH, "pm", 0, (m) => m.kind === "review_reply", { timeoutMs: 1000, pollMs: 10 });
    expect(hit?.body).toBe("PASS");

    // no reply after sinceId → timeout returns null
    const miss = await awaitMessage(p, PM, CH, "pm", 1, (m) => m.kind === "review_reply", { timeoutMs: 60, pollMs: 10 });
    expect(miss).toBeNull();
  });
});
