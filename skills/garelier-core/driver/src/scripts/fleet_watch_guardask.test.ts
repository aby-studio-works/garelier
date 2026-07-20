import { rmSync } from "../guard/path_guard.ts";
// W-179 (c): fleet_watch surfaces a RECENT unresolved command_guard ask as
// FLEET-ATTENTION (the 7h ask-storm class). These pin the two pure helpers that
// read the guard_ask incidents (W-164 maybeWriteGuardReport) and select the pending
// (unsurfaced, in-window) ones.
import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGuardAskIncidents, selectPendingGuardAsks, guardAskSeenSet } from "./fleet_watch.ts";

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmpFile(name: string, body: string): string {
  const d = mkdtempSync(join(tmpdir(), "fleet-guardask-")); tmps.push(d);
  const p = join(d, name); writeFileSync(p, body); return p;
}

test("readGuardAskIncidents: keeps guard_ask, skips other kinds / malformed, dedups across paths", () => {
  const a = tmpFile("incidents.jsonl", [
    JSON.stringify({ kind: "guard_ask", incident_id: "g1", created_at: "2026-07-20T10:00:00Z", command: "for f in *; do head $f; done", cwd: "/w", resolved_agent: "ga-worker-x", rule: "profile_unknown" }),
    JSON.stringify({ kind: "guard_deny", incident_id: "d1", command: "rm -rf /" }),        // not an ask
    JSON.stringify({ kind: "missing_marker", incident_id: "m1" }),                          // unrelated
    "{ not json",                                                                            // malformed -> skipped
    "",                                                                                      // blank -> skipped
  ].join("\n"));
  const b = tmpFile("incidents2.jsonl", [
    JSON.stringify({ kind: "guard_ask", incident_id: "g1", created_at: "2026-07-20T10:00:00Z", command: "dup", cwd: "/w", rule: "x" }), // same id as a -> deduped
    JSON.stringify({ kind: "guard_ask", incident_id: "g2", created_at: "2026-07-20T10:05:00Z", command: "grep x f", cwd: "/w", agent_id: "hash123", rule: "profile_unknown" }),
  ].join("\n"));
  const asks = readGuardAskIncidents([a, b]);
  expect(asks.map((x) => x.incident_id)).toEqual(["g1", "g2"]); // deduped, only guard_ask
  expect(asks[0].command).toBe("for f in *; do head $f; done"); // first-seen wins on dedup
  expect(asks[1].agent).toBe("hash123");                        // agent_id fallback when no resolved_agent
  expect(readGuardAskIncidents(["/no/such/file.jsonl"])).toEqual([]); // missing file -> empty
});

test("selectPendingGuardAsks: filters by seen-set and the recency window", () => {
  const now = Math.floor(Date.parse("2026-07-20T10:10:00Z") / 1000);
  const asks = [
    { incident_id: "recent", created_at: "2026-07-20T10:05:00Z", command: "c", cwd: "/w", agent: null, rule: "r" },   // 5m ago -> in 30m window
    { incident_id: "old", created_at: "2026-07-20T09:00:00Z", command: "c", cwd: "/w", agent: null, rule: "r" },      // 70m ago -> stale
    { incident_id: "seen", created_at: "2026-07-20T10:08:00Z", command: "c", cwd: "/w", agent: null, rule: "r" },     // recent but already surfaced
    { incident_id: "bad-ts", created_at: "not-a-date", command: "c", cwd: "/w", agent: null, rule: "r" },             // unparseable -> excluded
  ];
  const pending = selectPendingGuardAsks(asks, new Set(["seen"]), now, 30 * 60);
  expect(pending.map((a) => a.incident_id)).toEqual(["recent"]);
  // window 0 disables (nothing is < 0s old) — but a MISSING-timestamp ask still surfaces
  // (it cannot be aged out; see the (d)(ii) test below), so exclude it here.
  expect(selectPendingGuardAsks(asks, new Set(), now, 0)).toEqual([]);
});

test("W-179 (d)(ii): a MISSING created_at surfaces conservatively (fail-to-surface, not fail-to-silence)", () => {
  const now = Math.floor(Date.parse("2026-07-20T10:10:00Z") / 1000);
  const asks = [
    { incident_id: "no-ts", created_at: "", command: "c", cwd: "/w", agent: null, rule: "r" },          // absent → surface
    { incident_id: "blank-ts", created_at: "   ", command: "c", cwd: "/w", agent: null, rule: "r" },     // whitespace → surface
    { incident_id: "garbage-ts", created_at: "not-a-date", command: "c", cwd: "/w", agent: null, rule: "r" }, // present-but-garbage → still excluded
    { incident_id: "recent", created_at: "2026-07-20T10:05:00Z", command: "c", cwd: "/w", agent: null, rule: "r" },
  ];
  // a timestamp-less ask is surfaced even with a 0-length window (it can't be aged out).
  expect(selectPendingGuardAsks(asks, new Set(), now, 0).map((a) => a.incident_id).sort()).toEqual(["blank-ts", "no-ts"]);
  // and it is EXCLUDED once seen (so it fires once, not forever).
  expect(selectPendingGuardAsks(asks, new Set(["no-ts", "blank-ts"]), now, 30 * 60).map((a) => a.incident_id)).toEqual(["recent"]);
});

test("W-179 (d)(iii): guardAskSeenSet persists exactly what selectPendingGuardAsks surfaces — no re-fire loop", () => {
  const now = Math.floor(Date.parse("2026-07-20T10:10:00Z") / 1000);
  const window = 30 * 60;
  const asks = [
    { incident_id: "recent", created_at: "2026-07-20T10:05:00Z", command: "c", cwd: "/w", agent: null, rule: "r" }, // in window
    { incident_id: "no-ts", created_at: "", command: "c", cwd: "/w", agent: null, rule: "r" },                      // timestamp-less
    { incident_id: "old", created_at: "2026-07-20T09:00:00Z", command: "c", cwd: "/w", agent: null, rule: "r" },    // stale
  ];
  // 1st pass: fresh seen-set surfaces the two pending, and the persisted keep-set covers
  // exactly the surfaced ids (so neither re-fires).
  const firstPending = selectPendingGuardAsks(asks, new Set(), now, window);
  expect(firstPending.map((a) => a.incident_id).sort()).toEqual(["no-ts", "recent"]);
  const keep = guardAskSeenSet(asks, now, window);
  // every surfaced id is persisted — the closure that prevents the re-fire loop.
  for (const p of firstPending) expect(keep).toContain(p.incident_id);
  expect(keep).not.toContain("old"); // a stale ask is not remembered (can re-fire after aging)
  // 2nd pass with the persisted seen-set: nothing re-surfaces.
  expect(selectPendingGuardAsks(asks, new Set(keep), now, window)).toEqual([]);
});
