#!/usr/bin/env bun
// PM-side Wanderer review gate (DEC-076 §3/§4). The PM calls this to get an
// INDEPENDENT review of a non-trivial design doc (a Garelier blueprint / project
// design spec) from the Wanderer peer — a separately-launched Codex/Claude Code
// session on a strong, often different model. If the Wanderer is absent or
// silent past the timeout, this signals the PM to fall back to the Observer
// subagent. Advisory only: the PM/user make the final decision and the
// mutual-agreement sign-off.
//
//   bun wanderer_review.ts --project P --pm-id ID --doc <path> [--channel wanderer]
//       [--peer wanderer-01] [--from pm] [--prompt "<what to weigh>"]
//       [--timeout-ms N] [--staleness-ms N] [--poll-ms N]
//
// stdout (JSON): { outcome, reply?, requestId?, reason }
//   outcome = "reviewed"          → reply carries the Wanderer's verdict/advice
//           = "fallback_observer" → PM must run the Observer subagent instead
// Exit: 0 reviewed; 3 fallback_observer; 2 usage error.

import { appendMessage, readPresence, isPresent, awaitMessage, channelDir } from "./channel.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
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
  const channel = flag("channel") ?? "wanderer";
  const peer = flag("peer") ?? "wanderer-01";
  const from = flag("from") ?? "pm";
  const prompt = flag("prompt") ?? "Independently review this design for soundness, scope, and policy consistency.";
  const timeoutMs = flag("timeout-ms") ? Number(flag("timeout-ms")) : 180_000;
  const stalenessMs = flag("staleness-ms") ? Number(flag("staleness-ms")) : 120_000;
  const pollMs = flag("poll-ms") ? Number(flag("poll-ms")) : 3_000;

  // 1. Presence gate — never block on an absent Wanderer (DEC-076 §4).
  const pres = readPresence(channelDir(project, pmId, channel), peer);
  if (!isPresent(pres, stalenessMs, Date.now())) {
    out({ outcome: "fallback_observer", reason: `Wanderer '${peer}' absent (no fresh heartbeat) — use the Observer subagent.` });
    process.exit(3);
  }

  // 2. Post the review request.
  const req = appendMessage(project, pmId, channel, {
    from, to: peer, kind: "review_request", body: prompt, ref: doc,
  });

  // 3. Await the reply after this request, else fall back on timeout.
  const reply = await awaitMessage(
    project, pmId, channel, from, req.id,
    (m) => m.kind === "review_reply" || m.kind === "agree" || m.kind === "advice_reply",
    { timeoutMs, pollMs },
  );
  if (!reply) {
    out({ outcome: "fallback_observer", requestId: req.id, reason: `Wanderer silent past ${timeoutMs}ms — use the Observer subagent.` });
    process.exit(3);
  }
  out({ outcome: "reviewed", requestId: req.id, reply });
}

main().catch((e) => { process.stderr.write(`wanderer_review: ${e?.message ?? e}\n`); process.exit(1); });
