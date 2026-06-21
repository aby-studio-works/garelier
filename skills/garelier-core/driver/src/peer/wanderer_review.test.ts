import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerMessage } from "./channel.ts";
import { appendMessage, writePresence } from "./channel.ts";
import {
  extractReviewVerdict,
  isReviewReplyForRequest,
  isUnavailableNoticeForRequest,
  isLivenessSignal,
  runWandererGate,
  type GateResult,
} from "./wanderer_review.ts";

function msg(overrides: Partial<PeerMessage>): PeerMessage {
  return {
    id: 1,
    ts: "2026-06-18T00:00:00.000Z",
    from: "wanderer-01",
    to: "pm",
    kind: "review_reply",
    body: "PASS_WITH_NOTES: sound, but record the fallback.",
    ref: "control/blueprints/x.md",
    ...overrides,
  };
}

describe("wanderer review gate contract", () => {
  test("extracts only canonical review verdicts", () => {
    expect(extractReviewVerdict("PASS_WITH_NOTES: ok")).toBe("PASS_WITH_NOTES");
    expect(extractReviewVerdict("REWORK_RECOMMENDED until scope is split")).toBe("REWORK_RECOMMENDED");
    expect(extractReviewVerdict("looks okay to me")).toBeNull();
    expect(extractReviewVerdict("AGREE")).toBeNull();
  });

  test("accepts only verdict-bearing review replies for the requester", () => {
    expect(isReviewReplyForRequest(msg({}), "pm", "control/blueprints/x.md")).toBe(true);
    expect(isReviewReplyForRequest(msg({ kind: "advice_reply" }), "pm", "control/blueprints/x.md")).toBe(false);
    expect(isReviewReplyForRequest(msg({ body: "I need more context." }), "pm", "control/blueprints/x.md")).toBe(false);
    expect(isReviewReplyForRequest(msg({ to: "other-pm" }), "pm", "control/blueprints/x.md")).toBe(false);
    expect(isReviewReplyForRequest(msg({ ref: "control/blueprints/y.md" }), "pm", "control/blueprints/x.md")).toBe(false);
  });

  test("accepts explicit unavailable notices for Observer fallback", () => {
    expect(isUnavailableNoticeForRequest(msg({
      kind: "unavailable",
      body: "rate limited; quota exhausted",
    }), "pm", "control/blueprints/x.md")).toBe(true);
    expect(isUnavailableNoticeForRequest(msg({
      kind: "unavailable",
      body: "I am busy but can continue.",
    }), "pm", "control/blueprints/x.md")).toBe(false);
    expect(isUnavailableNoticeForRequest(msg({
      kind: "unavailable",
      body: "rate limited",
      ref: "control/blueprints/y.md",
    }), "pm", "control/blueprints/x.md")).toBe(false);
  });

  // DEC-078: liveness signal predicate.
  test("isLivenessSignal accepts ack/progress for the requester, rejects others", () => {
    expect(isLivenessSignal(msg({ kind: "ack", body: "received" }), "pm", "control/blueprints/x.md")).toBe(true);
    expect(isLivenessSignal(msg({ kind: "progress", body: "read doc" }), "pm", "control/blueprints/x.md")).toBe(true);
    expect(isLivenessSignal(msg({ kind: "review_reply" }), "pm", "control/blueprints/x.md")).toBe(false);
    expect(isLivenessSignal(msg({ kind: "ack", to: "other-pm" }), "pm", "control/blueprints/x.md")).toBe(false);
    expect(isLivenessSignal(msg({ kind: "progress", ref: "control/blueprints/y.md" }), "pm", "control/blueprints/x.md")).toBe(false);
    expect(isLivenessSignal(msg({ kind: "ack", ref: undefined }), "pm", "control/blueprints/x.md")).toBe(true); // ref-less still binds
  });
});

// ── DEC-078 liveness handshake: deterministic virtual-clock integration tests ──
// The injected `sleep` advances a virtual clock and fires scheduled Wanderer
// events; no real time elapses. The Wanderer's only mid-turn signal is a channel
// write (ack/progress/reply) or a turn-boundary presence beat.

function env() {
  const project = mkdtempSync(join(tmpdir(), "wgate-"));
  return { project, pmId: "p", channel: "wanderer", peer: "wanderer-01", from: "pm", doc: "control/blueprints/x.md" };
}
type Env = ReturnType<typeof env>;
const iso = (t: number) => new Date(t).toISOString();

function post(e: Env, kind: string, body: string): void {
  appendMessage(e.project, e.pmId, e.channel, { from: e.peer, to: e.from, kind, body, ref: e.doc });
}
function beat(e: Env, t: number): void {
  writePresence(e.project, e.pmId, e.channel, { peer: e.peer, beatAt: iso(t) });
}

async function runGate(
  e: Env,
  opts: { ackWindowMs: number; silenceWindowMs: number; ceilingMs: number; stalenessMs?: number; pollMs?: number; legacyTimeoutMs?: number },
  events: Array<{ at: number; fn: () => void }>,
): Promise<GateResult & { endedAt: number }> {
  let t = 0;
  const fired = new Set<number>();
  const apply = (): void => { events.forEach((ev, i) => { if (ev.at <= t && !fired.has(i)) { fired.add(i); ev.fn(); } }); };
  apply(); // fire t<=0 events (initial presence) before the gate's presence pre-gate reads
  const r = await runWandererGate({
    project: e.project, pmId: e.pmId, channel: e.channel, peer: e.peer, from: e.from,
    doc: e.doc, prompt: "review",
    stalenessMs: opts.stalenessMs ?? 120_000,
    pollMs: opts.pollMs ?? 10,
    ackWindowMs: opts.ackWindowMs, silenceWindowMs: opts.silenceWindowMs, ceilingMs: opts.ceilingMs,
    legacyTimeoutMs: opts.legacyTimeoutMs,
    nowMs: () => t,
    sleep: async (ms: number) => { t += ms; apply(); },
  });
  return { ...r, endedAt: t };
}

describe("wanderer liveness handshake (DEC-078)", () => {
  // F1 — the bug: the legacy flat timeout abandons a reply that lands after it.
  // (Legacy reuses awaitMessage's real setTimeout, so this runs in real — tiny — time.)
  test("F1a legacy: a reply after the flat timeout is abandoned (fallback)", async () => {
    const e = env();
    beat(e, Date.now());
    const timer = setTimeout(() => post(e, "review_reply", "PASS: fine"), 400);
    const r = await runWandererGate({
      project: e.project, pmId: e.pmId, channel: e.channel, peer: e.peer, from: e.from,
      doc: e.doc, prompt: "review", stalenessMs: 120_000, pollMs: 10,
      ackWindowMs: 1, silenceWindowMs: 1, ceilingMs: 1, legacyTimeoutMs: 80,
    });
    clearTimeout(timer);
    expect(r.outcome).toBe("fallback_observer");
  });

  // F1 — the fix: ack + progress keepalives keep the gate engaged past the old
  // flat timeout, so the genuine (slow) verdict is captured.
  test("F1b handshake: ack+progress keepalive extends past the old timeout → reviewed", async () => {
    const e = env();
    const r = await runGate(e, { ackWindowMs: 100, silenceWindowMs: 200, ceilingMs: 5_000 }, [
      { at: 0, fn: () => beat(e, 0) },
      { at: 20, fn: () => post(e, "ack", "received, reviewing") },
      { at: 150, fn: () => post(e, "progress", "read doc; checking scope") },
      { at: 300, fn: () => post(e, "progress", "checking policy consistency") },
      { at: 450, fn: () => post(e, "review_reply", "REWORK_RECOMMENDED: split the scope") },
    ]);
    expect(r.outcome).toBe("reviewed");
    expect(r.verdict).toBe("REWORK_RECOMMENDED");
    expect(r.signals).toBe(3); // ack + 2 progress
  });

  // F2 — never receives: present at start but no ack/progress/new beat → bounded fallback.
  test("F2 no receipt within the ack window → fallback", async () => {
    const e = env();
    const r = await runGate(e, { ackWindowMs: 100, silenceWindowMs: 200, ceilingMs: 5_000 }, [
      { at: 0, fn: () => beat(e, 0) },
    ]);
    expect(r.outcome).toBe("fallback_observer");
    expect(r.reason).toContain("no ack/progress");
    expect(r.endedAt).toBeLessThanOrEqual(110);
  });

  // F3 + F5 — engaged then silent: a FROZEN (even still-fresh) presence beat does
  // NOT extend (strictly-newer rule), so death is detected within the silence window.
  test("F3/F5 ack then silence (frozen fresh beat does not extend) → fallback", async () => {
    const e = env();
    const r = await runGate(e, { ackWindowMs: 100, silenceWindowMs: 200, ceilingMs: 5_000 }, [
      { at: 0, fn: () => beat(e, 0) },
      { at: 20, fn: () => post(e, "ack", "received") },
      // no further signals; presence stays frozen at beat(0) (still fresh, not newer)
    ]);
    expect(r.outcome).toBe("fallback_observer");
    expect(r.reason).toContain("silent");
    expect(r.signals).toBe(1);
    expect(r.endedAt).toBeLessThanOrEqual(20 + 200 + 20);
  });

  // F4 — explicit rate-limit notice → immediate fallback.
  test("F4 explicit unavailable → fallback", async () => {
    const e = env();
    const r = await runGate(e, { ackWindowMs: 100, silenceWindowMs: 200, ceilingMs: 5_000 }, [
      { at: 0, fn: () => beat(e, 0) },
      { at: 20, fn: () => post(e, "unavailable", "rate limited; quota exhausted") },
    ]);
    expect(r.outcome).toBe("fallback_observer");
    expect(r.reason).toContain("unavailable");
  });

  // F9 — backward-compat: an OLD Wanderer that posts no ack/progress but takes
  // turn boundaries (fresh, strictly-newer presence beats) stays engaged and replies.
  test("F9 old Wanderer kept alive by turn-boundary beats → reviewed", async () => {
    const e = env();
    const r = await runGate(e, { ackWindowMs: 30, silenceWindowMs: 50, ceilingMs: 5_000 }, [
      { at: 0, fn: () => beat(e, 0) },
      { at: 20, fn: () => beat(e, 20) },   // new beat = receipt
      { at: 60, fn: () => beat(e, 60) },   // extends
      { at: 100, fn: () => beat(e, 100) }, // extends
      { at: 130, fn: () => post(e, "review_reply", "PASS: ok") },
    ]);
    expect(r.outcome).toBe("reviewed");
    expect(r.verdict).toBe("PASS");
    expect(r.signals).toBe(0); // no ack/progress; beats only
  });

  // F9 legacy — a fast reply on the legacy path still works (reviewed). Real time.
  test("F9 legacy: a reply within the flat timeout → reviewed", async () => {
    const e = env();
    beat(e, Date.now());
    setTimeout(() => post(e, "review_reply", "BLOCK: unsafe"), 20);
    const r = await runWandererGate({
      project: e.project, pmId: e.pmId, channel: e.channel, peer: e.peer, from: e.from,
      doc: e.doc, prompt: "review", stalenessMs: 120_000, pollMs: 10,
      ackWindowMs: 1, silenceWindowMs: 1, ceilingMs: 1, legacyTimeoutMs: 1_000,
    });
    expect(r.outcome).toBe("reviewed");
    expect(r.verdict).toBe("BLOCK");
  });

  // F10 — a verdict reply in the same tick as a progress wins (terminal-first).
  test("F10 reply wins over a same-tick progress (terminal-first)", async () => {
    const e = env();
    const r = await runGate(e, { ackWindowMs: 100, silenceWindowMs: 200, ceilingMs: 5_000 }, [
      { at: 0, fn: () => beat(e, 0) },
      { at: 20, fn: () => { post(e, "progress", "almost done"); post(e, "review_reply", "PASS: ok"); } },
    ]);
    expect(r.outcome).toBe("reviewed");
    expect(r.verdict).toBe("PASS");
  });

  // Presence pre-gate: absent at start → immediate fallback, no wait.
  test("absent Wanderer (no presence) → immediate fallback", async () => {
    const e = env();
    const r = await runGate(e, { ackWindowMs: 100, silenceWindowMs: 200, ceilingMs: 5_000 }, []);
    expect(r.outcome).toBe("fallback_observer");
    expect(r.reason).toContain("absent");
    expect(r.endedAt).toBe(0);
  });
});
