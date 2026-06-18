import { describe, expect, test } from "bun:test";
import type { PeerMessage } from "./channel.ts";
import {
  extractReviewVerdict,
  isReviewReplyForRequest,
  isUnavailableNoticeForRequest,
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
});
