#!/usr/bin/env bun
// PM-side Wanderer review gate (DEC-076 §3/§4 + DEC-078 liveness handshake). The
// PM calls this to get an INDEPENDENT review of a non-trivial design doc (a
// Garelier blueprint / project design spec) from the Wanderer peer — a
// separately-launched Codex/Claude Code session on a strong, often different
// model.
//
// DEC-078: a flat reply-timeout abandoned a slow-but-ALIVE review (a strong
// model's genuine review can exceed 180s, and the Codex presence heartbeat only
// refreshes at turn boundaries, so it cannot tell "slow but working" from
// "dead"). Instead the gate now EXTENDS while the Wanderer proves it is alive —
// an `ack` on receipt, then `progress` keepalives between review steps, or (for
// an old Wanderer) fresh turn-boundary presence beats — and falls back to the
// Observer only on genuine absence / silence / rate-limit. Two independent bounds
// keep it deadlock-free: a silence window since the last life signal, and an
// absolute ceiling on the whole wait. The handshake is the DEFAULT; `--legacy`
// reverts to the old flat `--timeout-ms` await.
//
//   bun wanderer_review.ts --project P --pm-id ID --doc <path> [--channel wanderer]
//       [--peer wanderer-01] [--from pm] [--prompt "<what to weigh>"]
//       [--ack-window-ms N] [--silence-window-ms N] [--ceiling-ms N]
//       [--staleness-ms N] [--poll-ms N]
//       [--no-pane-drive]   (default: drive a recorded+live Wanderer pane —
//                            nudge it, auto-confirm read-only/peer-cli prompts,
//                            count a "Working" pane as liveness; DEC-076 §6)
//       [--legacy [--timeout-ms N]]
//
// stdout (JSON): { outcome, reply?, requestId?, verdict?, reason?, signals? }
//   outcome = "reviewed"          → reply carries a valid Wanderer verdict/advice
//           = "fallback_observer" → PM must run the Observer subagent instead
// Exit: 0 reviewed; 3 fallback_observer; 2 usage error.

import {
  appendMessage, readPresence, isPresent, awaitMessage, readLog, channelDir,
  type PeerMessage,
} from "./channel.ts";
import {
  paneInfo, paneAlive, paneSend, paneEnter, paneGet,
  READ_CMDS, WRITE_CMDS, APPROVAL_RE, WORKING_RE, type PaneRec,
} from "./peer_pane.ts";

export const REVIEW_VERDICTS = [
  "PASS",
  "PASS_WITH_NOTES",
  "REWORK_RECOMMENDED",
  "BLOCK",
  "NO_OPINION",
] as const;

export type ReviewVerdict = typeof REVIEW_VERDICTS[number];

const VERDICT_RE = new RegExp(`\\b(${REVIEW_VERDICTS.join("|")})\\b`);
export const UNAVAILABLE_RE =
  /\b(rate[- ]?limit(?:ed)?|quota(?: exhausted| exceeded)?|usage limit|too many requests|429|temporarily unavailable|try again later)\b/i;

export function extractReviewVerdict(body: string): ReviewVerdict | null {
  const match = body.match(VERDICT_RE);
  return match ? match[1] as ReviewVerdict : null;
}

export function isReviewReplyForRequest(msg: PeerMessage, requester: string, expectedRef?: string): boolean {
  if (msg.kind !== "review_reply") return false;
  if (msg.to !== requester && msg.to !== "all") return false;
  if (expectedRef && msg.ref && msg.ref !== expectedRef) return false;
  return extractReviewVerdict(msg.body) !== null;
}

export function isUnavailableNoticeForRequest(msg: PeerMessage, requester: string, expectedRef?: string): boolean {
  if (msg.kind !== "unavailable") return false;
  if (msg.to !== requester && msg.to !== "all") return false;
  if (expectedRef && msg.ref && msg.ref !== expectedRef) return false;
  return UNAVAILABLE_RE.test(msg.body);
}

// DEC-078: a non-terminal liveness signal — `ack` (posted as the Wanderer's first
// action on receiving a review_request) or `progress` (posted between review
// steps). Proves the Wanderer is alive and working so the PM extends instead of
// falling back on slowness.
export function isLivenessSignal(msg: PeerMessage, requester: string, expectedRef?: string): boolean {
  if (msg.kind !== "ack" && msg.kind !== "progress") return false;
  if (msg.to !== requester && msg.to !== "all") return false;
  if (expectedRef && msg.ref && msg.ref !== expectedRef) return false;
  return true;
}

export interface GateResult {
  outcome: "reviewed" | "fallback_observer";
  requestId?: number;
  verdict?: ReviewVerdict | null;
  reply?: PeerMessage;
  reason?: string;
  signals?: number;       // liveness signals (ack/progress) seen before the outcome
}

export interface GateOptions {
  project: string; pmId: string; channel: string; peer: string; from: string;
  doc: string; prompt: string;
  stalenessMs: number; pollMs: number;
  ackWindowMs: number; silenceWindowMs: number; ceilingMs: number;
  legacyTimeoutMs?: number;                 // when set (--legacy), run the old flat-timeout path
  drivePane?: boolean;                       // default true: drive a recorded+live Wanderer pane (DEC-076 §6)
  nowMs?: () => number;                     // injectable clock (tests)
  sleep?: (ms: number) => Promise<void>;    // injectable sleep (tests)
}

// The DEC-078 liveness gate. Posts the review request, then either runs the
// legacy flat await (when legacyTimeoutMs is set) or the receipt-window +
// engaged-loop handshake. ALWAYS terminates — presence pre-gate, bounded receipt
// window, silence window since the last life signal, and an absolute ceiling —
// so the PM never blocks (DEC-076 §4 Observer fallback remains the floor).
export async function runWandererGate(o: GateOptions): Promise<GateResult> {
  const now = o.nowMs ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dir = channelDir(o.project, o.pmId, o.channel);
  const fb = (reason: string, extra?: Partial<GateResult>): GateResult =>
    ({ outcome: "fallback_observer", reason, ...extra });

  // DEC-076 §6 pane drive. When a Wanderer pane is recorded AND live, the gate
  // (a) NUDGES it after posting so an idle Codex takes a turn and its Stop hook
  // harvests the inbox, (b) auto-confirms READ-only / peer-cli approval prompts
  // (the read-only sandbox prompts on the very cli the Wanderer must run to post
  // ack/reply) while REFUSING any write, and (c) treats an actively-"Working"
  // pane as proof of life so a genuinely-busy-but-channel-silent Wanderer is not
  // abandoned before the ceiling. With no pane recorded this is fully inert and
  // the gate is byte-for-byte the old passive handshake. The Observer fallback
  // (DEC-076 §4) remains the floor: a dead/absent/hung pane still yields to it.
  const drive = o.drivePane !== false;
  const pane: PaneRec | null = drive ? paneInfo(dir) : null;
  const paneOk = (): boolean => pane != null && paneAlive(pane.mux, pane.paneId);
  let lastApprovedAt = 0;
  // Returns true iff the pane currently shows life (an approval prompt we handled,
  // or an in-progress turn). Confirms read-only/peer-cli prompts, refuses writes.
  const tendPane = (nowT: number): boolean => {
    if (!pane) return false;
    let tail: string;
    try { tail = paneGet(pane.mux, pane.paneId).split("\n").slice(-24).join("\n"); }
    catch { return false; }
    if (!tail.trim()) return false;
    if (APPROVAL_RE.test(tail)) {
      if (WRITE_CMDS.test(tail)) return false;             // never auto-approve a write
      if (READ_CMDS.test(tail) && nowT - lastApprovedAt > 1500) {
        paneEnter(pane.mux, pane.paneId); lastApprovedAt = nowT;
      }
      return true;                                          // an approval prompt = alive
    }
    return WORKING_RE.test(tail);                           // mid-turn = alive
  };

  // 1. presence pre-gate — never block on an absent/stale Wanderer (DEC-076 §4),
  // UNLESS a recorded pane is demonstrably alive (a live pane is stronger proof
  // than a turn-boundary heartbeat that simply lapsed mid-review).
  const presAtStart = readPresence(dir, o.peer);
  if (!isPresent(presAtStart, o.stalenessMs, now()) && !paneOk()) {
    return fb(`Wanderer '${o.peer}' absent (no fresh heartbeat, no live pane) — use the Observer subagent.`);
  }
  const beat0Raw = presAtStart ? Date.parse(presAtStart.beatAt) : NaN;
  const beat0 = Number.isNaN(beat0Raw) ? Number.NEGATIVE_INFINITY : beat0Raw;

  // 2. post the review request.
  const req = appendMessage(o.project, o.pmId, o.channel, {
    from: o.from, to: o.peer, kind: "review_request", body: o.prompt, ref: o.doc,
  });

  // 2b. NUDGE a live pane (minimal-token pointer only — the Wanderer reads the
  // ref itself) so an idle Codex takes a turn and harvests the inbox; without a
  // live pane this is skipped and the gate relies on the passive handshake.
  if (paneOk()) {
    paneSend(pane!.mux, pane!.paneId,
      `Check your peer inbox now: a review_request (ref ${o.doc}) is pending. ` +
      `Read it and reply with your verdict via the peer cli (ack first, then review_reply).`);
  }

  // 2a. LEGACY flat-timeout path (byte-for-byte old behavior; --legacy).
  if (o.legacyTimeoutMs != null) {
    const reply = await awaitMessage(
      o.project, o.pmId, o.channel, o.from, req.id,
      (m) => isReviewReplyForRequest(m, o.from, o.doc) || isUnavailableNoticeForRequest(m, o.from, o.doc),
      { timeoutMs: o.legacyTimeoutMs, pollMs: o.pollMs, nowMs: now },
    );
    if (!reply) return fb(`Wanderer did not provide a valid review verdict within ${o.legacyTimeoutMs}ms — use the Observer subagent.`, { requestId: req.id });
    if (isUnavailableNoticeForRequest(reply, o.from, o.doc)) return fb(`Wanderer unavailable (${reply.body}) — use the Observer subagent.`, { requestId: req.id, reply });
    return { outcome: "reviewed", requestId: req.id, verdict: extractReviewVerdict(reply.body), reply };
  }

  // 3. HANDSHAKE mode (default).
  const ceilingDeadline = now() + o.ceilingMs;
  let sinceId = req.id;       // monotonic cursor: only consider messages after this
  let beatHW = beat0;         // only a STRICTLY-NEWER fresh beat counts as new life
  let signals = 0;

  type Hit =
    | { k: "reply"; m: PeerMessage } | { k: "unavailable"; m: PeerMessage }
    | { k: "liveness"; m: PeerMessage } | { k: "beat"; beatMs: number } | { k: "timeout" };

  // Poll until `deadlineMs` for (terminal-first) a verdict reply, an unavailable
  // notice, a liveness ack/progress, or a strictly-newer fresh presence beat.
  const poll = async (deadlineMs: number): Promise<Hit> => {
    let effective = Math.min(deadlineMs, ceilingDeadline);
    for (;;) {
      const log = readLog(dir);
      const fresh = (m: PeerMessage): boolean => m.id > sinceId && m.from !== o.from;
      const reply = log.find((m) => fresh(m) && isReviewReplyForRequest(m, o.from, o.doc));
      if (reply) return { k: "reply", m: reply };
      const unav = log.find((m) => fresh(m) && isUnavailableNoticeForRequest(m, o.from, o.doc));
      if (unav) return { k: "unavailable", m: unav };
      const live = log.find((m) => fresh(m) && isLivenessSignal(m, o.from, o.doc));
      if (live) return { k: "liveness", m: live };
      const pres = readPresence(dir, o.peer);
      if (pres && isPresent(pres, o.stalenessMs, now())) {
        const b = Date.parse(pres.beatAt);
        if (!Number.isNaN(b) && b > beatHW) return { k: "beat", beatMs: b };
      }
      // A live, working pane (or one we just cleared a read-only approval on)
      // extends this wait toward the absolute ceiling, so a busy-but-channel-
      // silent Wanderer is not abandoned. The ceiling stays the firm bound: a
      // hung pane stops being "working", effective stops advancing, and the gate
      // yields to the Observer (silence window) or the ceiling. Inert with no pane.
      if (pane && now() < ceilingDeadline && tendPane(now())) {
        effective = Math.min(now() + o.silenceWindowMs, ceilingDeadline);
      }
      if (now() >= effective) return { k: "timeout" };
      await sleep(o.pollMs);
    }
  };

  // 3a. RECEIPT WINDOW — first proof of life (ack/progress/new beat) OR a fast
  // direct reply/unavailable. None within the window → never received / dead.
  const r = await poll(Math.min(now() + o.ackWindowMs, ceilingDeadline));
  if (r.k === "unavailable") return fb(`Wanderer unavailable (${r.m.body}) — use the Observer subagent.`, { requestId: req.id, reply: r.m, signals });
  if (r.k === "reply") return { outcome: "reviewed", requestId: req.id, verdict: extractReviewVerdict(r.m.body), reply: r.m, signals };
  if (r.k === "timeout") return fb(`Wanderer gave no ack/progress within ${o.ackWindowMs}ms — treat as not received; use the Observer subagent.`, { requestId: req.id, signals });
  if (r.k === "liveness") { sinceId = r.m.id; signals++; }
  else { beatHW = r.beatMs; }   // r.k === "beat"
  let lastSignalAt = now();

  // 3b. ENGAGED LOOP — extend on each life signal; bounded by the silence window
  // since the last signal AND the absolute ceiling.
  for (;;) {
    if (now() >= ceilingDeadline) {
      return fb(`Wanderer alive but did not conclude within the ${o.ceilingMs}ms ceiling — use the Observer subagent.`, { requestId: req.id, signals });
    }
    const e = await poll(Math.min(lastSignalAt + o.silenceWindowMs, ceilingDeadline));
    if (e.k === "unavailable") return fb(`Wanderer unavailable (${e.m.body}) — use the Observer subagent.`, { requestId: req.id, reply: e.m, signals });
    if (e.k === "reply") return { outcome: "reviewed", requestId: req.id, verdict: extractReviewVerdict(e.m.body), reply: e.m, signals };
    if (e.k === "timeout") {
      const reason = now() >= ceilingDeadline
        ? `Wanderer alive but did not conclude within the ${o.ceilingMs}ms ceiling — use the Observer subagent.`
        : `Wanderer went silent for ${o.silenceWindowMs}ms after its last signal — treat as died mid-review; use the Observer subagent.`;
      return fb(reason, { requestId: req.id, signals });
    }
    if (e.k === "liveness") { sinceId = e.m.id; signals++; }
    else { beatHW = e.beatMs; }   // e.k === "beat"
    lastSignalAt = now();
  }
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean { return process.argv.includes(`--${name}`); }
function numFlag(name: string, dflt: number): number {
  const v = flag(name);
  return v !== undefined ? Number(v) : dflt;
}

function out(o: object): void { process.stdout.write(JSON.stringify(o) + "\n"); }

async function main(): Promise<void> {
  const project = flag("project");
  const pmId = flag("pm-id");
  const doc = flag("doc");
  if (!project || !pmId || !doc) {
    process.stderr.write("wanderer_review: --project, --pm-id, --doc are required\n");
    process.exit(2);
  }
  const result = await runWandererGate({
    project, pmId, doc,
    channel: flag("channel") ?? "wanderer",
    peer: flag("peer") ?? "wanderer-01",
    from: flag("from") ?? "pm",
    prompt: flag("prompt") ?? "Independently review this design for soundness, scope, and policy consistency. Reply with exactly one verdict token: PASS, PASS_WITH_NOTES, REWORK_RECOMMENDED, BLOCK, or NO_OPINION, followed by concise advice.",
    stalenessMs: numFlag("staleness-ms", 120_000),
    pollMs: numFlag("poll-ms", 3_000),
    ackWindowMs: numFlag("ack-window-ms", 45_000),
    silenceWindowMs: numFlag("silence-window-ms", 90_000),
    ceilingMs: numFlag("ceiling-ms", 900_000),
    legacyTimeoutMs: hasFlag("legacy") ? numFlag("timeout-ms", 180_000) : undefined,
    drivePane: !hasFlag("no-pane-drive"),
  });
  out(result);
  process.exit(result.outcome === "reviewed" ? 0 : 3);
}

if (import.meta.main) {
  main().catch((e) => { process.stderr.write(`wanderer_review: ${e?.message ?? e}\n`); process.exit(1); });
}
