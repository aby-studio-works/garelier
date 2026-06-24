#!/usr/bin/env bun
// PM-side Wanderer drive (DEC-076 §6/§7). One minimal-token review round against
// a running Wanderer pane: pass only a FILE POINTER (the Wanderer reads the doc
// itself — the PM never loads the content), nudge the pane, auto-approve READ
// command escalations while REFUSING writes (the Windows elevated read-only
// sandbox asks per read, error 1312), capture only the verdict block, and relay
// it to the peer-channel. Call again with a follow-up --ask for the next round.
//
//   bun wanderer_drive.ts --project P --pm-id ID --doc <ref> [--ask "<short follow-up>"]
//       [--channel C --peer PEER] [--pane N] [--max-sec 360]
// stdout (JSON): { outcome, verdict?, relayedId?, note }
// Exit: 0 reviewed; 2 write-attempt blocked (manual); 3 fallback_observer.

import { channelDir, readPresence, isPresent, appendMessage } from "./channel.ts";
import { UNAVAILABLE_RE } from "./wanderer_review.ts";
import {
  paneInfo, paneSend, paneEnter, paneGet, READ_CMDS, WRITE_CMDS, APPROVAL_RE, WORKING_RE,
} from "./peer_pane.ts";

function flag(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }
function out(o: object): void { process.stdout.write(JSON.stringify(o) + "\n"); }

async function main(): Promise<void> {
  const project = flag("project"); const pmId = flag("pm-id"); const doc = flag("doc");
  if (!project || !pmId || !doc) { process.stderr.write("wanderer_drive: --project, --pm-id, --doc required\n"); process.exit(2); }
  const channel = flag("channel") ?? "wanderer";
  const peer = flag("peer") ?? "wanderer-01";
  const ask = flag("ask") ?? "";
  const maxSec = flag("max-sec") ? Number(flag("max-sec")) : 360;
  const dir = channelDir(project, pmId, channel);

  // Reuse the running Wanderer pane; never block on an absent one.
  const pane = flag("pane") ? { mux: flag("mux") ?? "wezterm", paneId: flag("pane")! } : paneInfo(dir);
  if (!pane) { out({ outcome: "fallback_observer", note: "no Wanderer pane recorded — launch one or use the Observer." }); process.exit(3); }
  if (!isPresent(readPresence(dir, peer), 120_000, Date.now())) {
    out({ outcome: "fallback_observer", note: `Wanderer '${peer}' absent (stale heartbeat) — use the Observer.` });
    process.exit(3);
  }

  // FILE-POINTER prompt — only the path crosses the wire; the Wanderer reads it.
  const prompt =
    `As the read-only Wanderer, review ${doc} (read it yourself) and reply with a VERDICT ` +
    `(PASS / PASS_WITH_NOTES / REWORK_RECOMMENDED / BLOCK — or AGREE to sign off) + concise advice.` +
    (ask ? ` ${ask}` : "");
  paneSend(pane.mux, pane.paneId, prompt);

  // Drive loop: approve read escalations, refuse writes, capture the verdict.
  // DEC-082 fix-3: a Codex pane can silently drop the first send (idle, no echo,
  // a half-rendered TUI). If we observe NO progress — no working spinner, no
  // approval prompt, no verdict — for RENUDGE_MS, RE-SEND the prompt (bounded by
  // MAX_RENUDGE) to wake an idle Wanderer instead of letting the whole window
  // expire on a nudge that never landed. Any real activity resets the timer.
  const deadline = Date.now() + maxSec * 1000;
  const RENUDGE_MS = 20_000;
  const MAX_RENUDGE = 3;
  let lastApprovedAt = 0;
  let lastProgressAt = Date.now();
  let reNudges = 0;
  while (Date.now() < deadline) {
    const screen = paneGet(pane.mux, pane.paneId);
    const tail = screen.split("\n").slice(-24).join("\n");
    if (UNAVAILABLE_RE.test(tail)) {
      appendMessage(project, pmId, channel, {
        from: peer, to: "pm", kind: "unavailable", body: tail.trim(), ref: doc,
      });
      out({ outcome: "fallback_observer", note: "Wanderer appears rate-limited/unavailable — use the Observer.", tail });
      process.exit(3);
    }
    if (APPROVAL_RE.test(tail)) {
      lastProgressAt = Date.now();
      if (WRITE_CMDS.test(tail)) { out({ outcome: "write_blocked", note: "Wanderer attempted a non-read command — refused. Inspect the pane.", tail }); process.exit(2); }
      if (READ_CMDS.test(tail) && Date.now() - lastApprovedAt > 1500) { paneEnter(pane.mux, pane.paneId); lastApprovedAt = Date.now(); }
      await Bun.sleep(2500); continue;
    }
    if (WORKING_RE.test(screen)) { lastProgressAt = Date.now(); await Bun.sleep(5000); continue; }
    // Idle + a verdict present → done.
    const m = screen.match(/Verdict:[\s\S]*?(?=\n[›>]| {2}\d+[hd] \d+% left|$)/);
    if (m && /(PASS|REWORK_RECOMMENDED|BLOCK|AGREE|NO_OPINION)/.test(m[0])) {
      const verdict = m[0].replace(/[ \t]+$/gm, "").trim();
      const rec = appendMessage(project, pmId, channel, { from: peer, to: "pm", kind: "review_reply", body: verdict, ref: doc });
      out({ outcome: "reviewed", verdict, relayedId: rec.id, note: "minimal-token file-pointer review; reads auto-approved, writes refused." });
      return;
    }
    // Idle with no verdict, no spinner, no prompt — the send may have been dropped.
    if (Date.now() - lastProgressAt > RENUDGE_MS && reNudges < MAX_RENUDGE) {
      paneSend(pane.mux, pane.paneId, prompt);
      reNudges += 1;
      lastProgressAt = Date.now();
    }
    await Bun.sleep(4000);
  }
  out({ outcome: "timeout", note: `no verdict within ${maxSec}s — Wanderer may be stuck or rate-limited; consider the Observer.` });
  process.exit(3);
}

main().catch((e) => { process.stderr.write(`wanderer_drive: ${e?.message ?? e}\n`); process.exit(1); });
