#!/usr/bin/env bun
// Codex hook adapter for the Wanderer peer (DEC-076). Registered in the target
// project's .codex/hooks.json for the SessionStart and Stop events.
//
// The Wanderer runs **read-only** (`codex --sandbox read-only`) so it can never
// implement or commit — it only READS the design and TALKS. This hook, which
// runs as a trusted subprocess OUTSIDE Codex's sandbox, does the peer-channel
// writes on its behalf:
//   - SessionStart / Stop: refresh the presence heartbeat.
//   - Stop: HARVEST — if a request was surfaced last turn and this turn produced
//     a verdict-bearing assistant message or unavailable notice, relay it.
//   - Stop: SURFACE — show any new unread PM request and arm the next harvest.
// So the Wanderer never runs a command to reply; it just states its verdict.
//
// Idle wake is best-effort (Stop fires only after a completed turn). The
// reliability floor is the PM await timeout + Observer fallback (DEC-076 §4).
//
//   bun wanderer_hook.ts --project P --pm-id ID --channel C --peer PEER [--tool codex --model M]
// stdin:  the Codex hook JSON ({ hook_event_name, last_assistant_message, ... }).
// stdout: the Codex hook output contract ({ continue, systemMessage? }).

import { channelDir, writePresence, inboxFor, readLog, setReadId, appendMessage } from "./channel.ts";
import { extractReviewVerdict, isReviewReplyForRequest, UNAVAILABLE_RE } from "./wanderer_review.ts";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

const HARVEST_MIN_CHARS = 24; // ignore short acks ("ok") — a real review is long.

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function emit(out: { continue: boolean; systemMessage?: string }): void {
  process.stdout.write(JSON.stringify(out) + "\n");
}

async function readStdin(): Promise<{ hook_event_name?: string; last_assistant_message?: string | null }> {
  try { const t = await Bun.stdin.text(); return t ? JSON.parse(t) : {}; } catch { return {}; }
}

interface Pending { requestId: number; requester: string; ref?: string }
const pendingPath = (dir: string, peer: string) => join(dir, "pending", `${peer}.json`);
function readPending(dir: string, peer: string): Pending | null {
  const p = pendingPath(dir, peer);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as Pending; } catch { return null; }
}
function writePending(dir: string, peer: string, v: Pending): void {
  const d = join(dir, "pending");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  writeFileSync(pendingPath(dir, peer), JSON.stringify(v) + "\n", "utf8");
}
function clearPending(dir: string, peer: string): void {
  try { rmSync(pendingPath(dir, peer)); } catch { /* none */ }
}

async function main(): Promise<void> {
  const project = flag("project");
  const pmId = flag("pm-id");
  const channel = flag("channel") ?? "wanderer";
  const peer = flag("peer") ?? "wanderer-01";
  if (!project || !pmId) { emit({ continue: true }); return; }

  const input = await readStdin();

  // A turn boundary proves the Wanderer session is alive → heartbeat.
  writePresence(project, pmId, channel, {
    peer, tool: flag("tool") ?? "codex", model: flag("model"), pid: process.pid,
  });

  if (input.hook_event_name === "SessionStart") {
    // Deliver the Wanderer ROLE via the hook itself — NOT via the project's
    // AGENTS.md (which would couple the target project to Garelier).
    emit({
      continue: true,
      systemMessage:
        `Wanderer peer '${peer}' online for ${pmId}.\n` +
        `ROLE — you are an EXTERNAL ADVISORY reviewer of the PM's design work (Garelier ` +
        `blueprints / project design specs) over a peer-channel. You are NOT a subagent; you ` +
        `make NO commits, NO code edits, and NO decisions — advisory only, the PM/user decide. ` +
        `You run READ-ONLY: do not implement anything.\n` +
        `WHEN a PM request is surfaced here (a peer-inbox message carrying a 'ref' file), READ ` +
        `the ref and judge it independently: soundness (correct? assumptions valid?), scope ` +
        `(right-sized, no over-engineering?), policy consistency, and risk. Then simply STATE ` +
        `exactly one verdict token (PASS / PASS_WITH_NOTES / REWORK_RECOMMENDED / BLOCK / NO_OPINION) + ` +
        `concise advice (the hook relays your spoken verdict automatically).\n` +
        `LIVENESS — on a long review the PM only sees you alive via turn-boundary beats or your own ` +
        `channel posts, and falls back to the Observer after ~90s of silence; so FIRST run the peer ` +
        `cli 'cli.ts send ... --kind ack --ref <ref>', then a '--kind progress' line about once a ` +
        `minute while you think. Those channel sends (ack / progress / review_reply / unavailable) ` +
        `are the only commands you run — never write the project.`,
    });
    return;
  }

  // Stop (or unspecified).
  const dir = channelDir(project, pmId, channel);

  // (1) HARVEST: if a prior turn surfaced a request and the Wanderer has not
  // already replied to it explicitly, relay only a verdict-bearing review reply
  // or an explicit unavailability notice. Intermediate "I'll check" text keeps
  // the pending request armed for the next Stop hook.
  const pending = readPending(dir, peer);
  if (pending) {
    const alreadyReplied = readLog(dir).some(
      (m) => m.from === peer && m.id > pending.requestId
        && isReviewReplyForRequest(m, pending.requester, pending.ref),
    );
    const said = (input.last_assistant_message ?? "").trim();
    if (alreadyReplied) {
      clearPending(dir, peer);
    } else if (UNAVAILABLE_RE.test(said)) {
      appendMessage(project, pmId, channel, {
        from: peer, to: pending.requester, kind: "unavailable", body: said,
        ...(pending.ref ? { ref: pending.ref } : {}),
      });
      clearPending(dir, peer);
    } else if (said.length >= HARVEST_MIN_CHARS && extractReviewVerdict(said)) {
      appendMessage(project, pmId, channel, {
        from: peer, to: pending.requester, kind: "review_reply", body: said,
        ...(pending.ref ? { ref: pending.ref } : {}),
      });
      clearPending(dir, peer);
    }
  }

  // (2) SURFACE: show any new unread PM request and arm the next harvest.
  const msgs = inboxFor(dir, peer);
  if (msgs.length === 0) {
    // DEC-082 fix-3: no NEW request, but if a prior request is still pending
    // (surfaced once, not yet answered), REMIND each turn — a Wanderer that takes
    // turns without producing a verdict must not let the request slip silently.
    const stillPending = readPending(dir, peer);
    if (stillPending) {
      emit({
        continue: true,
        systemMessage:
          `Peer reminder — PM request #${stillPending.requestId} is STILL awaiting your verdict` +
          `${stillPending.ref ? ` (ref: ${stillPending.ref})` : ""}. Read the ref and STATE exactly one ` +
          `verdict token (PASS / PASS_WITH_NOTES / REWORK_RECOMMENDED / BLOCK / NO_OPINION) + concise advice, ` +
          `or run the peer cli 'send ... --kind unavailable' if you cannot review it. Advisory only — read-only.`,
      });
      return;
    }
    emit({ continue: true });
    return;
  }
  const maxId = readLog(dir).reduce((m, x) => Math.max(m, x.id || 0), 0);
  setReadId(dir, peer, maxId); // mark surfaced so it is not re-shown every turn
  const req = msgs[msgs.length - 1]; // arm harvest for the latest request
  writePending(dir, peer, { requestId: req.id, requester: req.from || "pm", ...(req.ref ? { ref: req.ref } : {}) });
  const lines = msgs.map(
    (m) => `- #${m.id} [${m.kind}] from ${m.from}: ${m.body}${m.ref ? ` (ref: ${m.ref})` : ""}`,
  );
  emit({
    continue: true,
    systemMessage:
      `Peer inbox — ${msgs.length} request(s) from the PM:\n${lines.join("\n")}\n\n` +
      `Read each 'ref' and review it independently (soundness / scope / policy / risk; advisory ` +
      `only — read-only, no commits, no code edits). Then simply STATE exactly one verdict token ` +
      `(PASS / PASS_WITH_NOTES / REWORK_RECOMMENDED / BLOCK / NO_OPINION) + concise advice ` +
      `(the hook relays your spoken verdict automatically). LIVENESS — on a long review, FIRST run ` +
      `the peer cli 'cli.ts send ... --kind ack --ref <ref>', then a '--kind progress' line about ` +
      `once a minute while you think, or the PM falls back to the Observer after ~90s of silence. ` +
      `Those channel sends are the only commands you run — never write the project.`,
  });
}

main().catch(() => emit({ continue: true }));
