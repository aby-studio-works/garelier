// Garelier peer-channel (DEC-076) — a tool-agnostic, dependency-free
// inter-session message channel. Generalizes a known public file-based
// agent-messaging technique onto Garelier's own append-only files (no SQLite,
// no MCP, no new dependency). The external advisory Wanderer peer (and any
// future peer) exchanges review/advice with the PM over it.
//
// Layout under <project>/__garelier/<pm_id>/runtime/peer/<channel>/:
//   log.jsonl              append-only message log, one JSON object per line
//   read/<peer>.json       { lastReadId } per reader (read cursor)
//   presence/<peer>.json   { peer, tool, model, pid, startedAt, beatAt }
//
// Best-effort delivery for a low-traffic two-peer advisory channel (PM ↔ one
// Wanderer): message ids are max+1 at append; concurrent writers are not
// expected. Reliability of the OVERALL design comes from the PM-side await
// timeout + Observer subagent fallback (DEC-076 §4), never from this store
// guaranteeing wake/delivery. Times are ISO-8601 (Date is available — this is a
// Bun module, not a Workflow script).

import { join } from "node:path";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
} from "node:fs";

export interface PeerMessage {
  id: number;
  ts: string;
  from: string;
  to: string;            // a peer name, or "all"
  kind: string;          // review_request | review_reply | advice_request | advice_reply | agree | note | ...
  body: string;
  ref?: string;          // optional path to an artifact / design doc under review
}

export interface Presence {
  peer: string;
  tool?: string;         // "codex" | "claude-code" | ...
  model?: string;
  pid?: number;
  startedAt: string;
  beatAt: string;
}

export function channelDir(projectRoot: string, pmId: string, channel: string): string {
  return join(projectRoot, "__garelier", pmId, "runtime", "peer", channel);
}

function ensureDir(d: string): void {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

const logPath = (dir: string) => join(dir, "log.jsonl");
const readPath = (dir: string, peer: string) => join(dir, "read", `${peer}.json`);
const presencePath = (dir: string, peer: string) => join(dir, "presence", `${peer}.json`);

/** Read and parse the append-only log; malformed lines are skipped, not fatal. */
export function readLog(dir: string): PeerMessage[] {
  const p = logPath(dir);
  if (!existsSync(p)) return [];
  const out: PeerMessage[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as PeerMessage); } catch { /* skip malformed */ }
  }
  return out;
}

/** Append a message; assigns a monotonic id (max+1) and an ISO ts if absent. */
export function appendMessage(
  projectRoot: string, pmId: string, channel: string,
  msg: Omit<PeerMessage, "id" | "ts"> & { ts?: string },
): PeerMessage {
  const dir = channelDir(projectRoot, pmId, channel);
  ensureDir(dir);
  const id = readLog(dir).reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  const full: PeerMessage = {
    id,
    ts: msg.ts ?? new Date().toISOString(),
    from: msg.from, to: msg.to, kind: msg.kind, body: msg.body,
    ...(msg.ref ? { ref: msg.ref } : {}),
  };
  appendFileSync(logPath(dir), JSON.stringify(full) + "\n", "utf8");
  return full;
}

export function lastReadId(dir: string, peer: string): number {
  const p = readPath(dir, peer);
  if (!existsSync(p)) return 0;
  try { return (JSON.parse(readFileSync(p, "utf8")).lastReadId as number) || 0; } catch { return 0; }
}

export function setReadId(dir: string, peer: string, id: number): void {
  ensureDir(join(dir, "read"));
  writeFileSync(readPath(dir, peer), JSON.stringify({ lastReadId: id }) + "\n", "utf8");
}

/** Unread messages addressed to `peer` (or "all"), excluding the peer's own. */
export function inboxFor(dir: string, peer: string): PeerMessage[] {
  const since = lastReadId(dir, peer);
  return readLog(dir).filter(
    (m) => m.id > since && m.from !== peer && (m.to === peer || m.to === "all"),
  );
}

/** Write/refresh a peer's presence heartbeat (preserves startedAt across beats). */
export function writePresence(
  projectRoot: string, pmId: string, channel: string,
  p: Omit<Presence, "beatAt" | "startedAt"> & { startedAt?: string; beatAt?: string; nowIso?: string },
): Presence {
  const dir = channelDir(projectRoot, pmId, channel);
  ensureDir(join(dir, "presence"));
  const now = p.nowIso ?? new Date().toISOString();
  let priorStart: string | undefined;
  try { priorStart = (JSON.parse(readFileSync(presencePath(dir, p.peer), "utf8")) as Presence).startedAt; } catch { /* none */ }
  const full: Presence = {
    peer: p.peer, tool: p.tool, model: p.model, pid: p.pid,
    startedAt: p.startedAt ?? priorStart ?? now,
    beatAt: p.beatAt ?? now,
  };
  writeFileSync(presencePath(dir, p.peer), JSON.stringify(full, null, 2) + "\n", "utf8");
  return full;
}

export function readPresence(dir: string, peer: string): Presence | null {
  const p = presencePath(dir, peer);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as Presence; } catch { return null; }
}

/** A peer is "present" iff its heartbeat is no older than stalenessMs. */
export function isPresent(pres: Presence | null, stalenessMs: number, nowMs: number): boolean {
  if (!pres) return false;
  const beat = Date.parse(pres.beatAt);
  if (Number.isNaN(beat)) return false;
  return nowMs - beat <= stalenessMs;
}

/**
 * Poll the log for the first message after `sinceId` addressed to `asPeer`
 * that satisfies `match`, until `timeoutMs` elapses. Returns null on timeout —
 * the caller (PM) then falls back to the Observer subagent (DEC-076 §4).
 * `nowMs` is injectable for tests.
 */
export async function awaitMessage(
  projectRoot: string, pmId: string, channel: string,
  asPeer: string, sinceId: number, match: (m: PeerMessage) => boolean,
  opts: { timeoutMs: number; pollMs: number; nowMs?: () => number },
): Promise<PeerMessage | null> {
  const dir = channelDir(projectRoot, pmId, channel);
  const now = opts.nowMs ?? (() => Date.now());
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const hit = readLog(dir).find(
      (m) => m.id > sinceId && m.from !== asPeer
        && (m.to === asPeer || m.to === "all") && match(m),
    );
    if (hit) return hit;
    if (now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}
