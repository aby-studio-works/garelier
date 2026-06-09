// DEC-027 / DEC-031 — detached-agent concurrency cap + priority-tier scheduling.
//
// Covers the pure cores: alive-count/budget, lease liveness, the tier mapping +
// Dock reorder (tierIndexMap / effectiveTierIndexMap), the scheduling
// decision (tier + FIFO + aging + urgent bucket), and the non-mutating
// peekChanged probe that prevents a deferred candidate from being stranded.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeAliveBudget,
  isPidAliveForLease,
  planDetachedSchedule,
  tierIndexMap,
  effectiveTierIndexMap,
  type AgentLease,
  type Candidate,
} from "./main.ts";
import { DEFAULT_CONCURRENCY_TIERS } from "./config.ts";
import { ChangeTracker } from "./state.ts";

const BOOT = 1_000_000;
const lease = (over: Partial<AgentLease> = {}): AgentLease => ({
  status: "running",
  pid: 4242,
  started_at: new Date(BOOT + 1000).toISOString(),
  ...over,
});
const alwaysAlive = () => true;
const neverAlive = () => false;

describe("isPidAliveForLease", () => {
  test("running lease with a live pid counts", () => {
    expect(isPidAliveForLease(lease({ pid: 7 }), alwaysAlive)).toBe(true);
  });
  test("running lease with a dead pid does not count", () => {
    expect(isPidAliveForLease(lease({ pid: 7 }), neverAlive)).toBe(false);
  });
  test("starting lease with no pid yet counts (spawn window)", () => {
    expect(isPidAliveForLease(lease({ status: "starting", pid: undefined, child_pid: undefined }), neverAlive)).toBe(true);
  });
  test("non-starting lease with no pid does not count", () => {
    expect(isPidAliveForLease(lease({ status: "running", pid: undefined, child_pid: undefined }), alwaysAlive)).toBe(false);
  });
  test("falls back to child_pid when pid absent", () => {
    expect(isPidAliveForLease(lease({ pid: undefined, child_pid: 99 }), alwaysAlive)).toBe(true);
  });
});

describe("computeAliveBudget", () => {
  test("budget = cap - alive", () => {
    const leases = [lease(), lease(), lease()];
    const { aliveCount, budget } = computeAliveBudget(leases, 4, BOOT, alwaysAlive);
    expect(aliveCount).toBe(3);
    expect(budget).toBe(1);
  });
  test("finished leases are not alive (reaped in phase 1)", () => {
    const leases = [lease({ status: "finished" }), lease()];
    const { aliveCount, budget } = computeAliveBudget(leases, 4, BOOT, alwaysAlive);
    expect(aliveCount).toBe(1);
    expect(budget).toBe(3);
  });
  test("dead-pid leases are not alive", () => {
    const { aliveCount } = computeAliveBudget([lease(), lease()], 4, BOOT, neverAlive);
    expect(aliveCount).toBe(0);
  });
  test("budget never goes negative when over cap", () => {
    const leases = [lease(), lease(), lease(), lease(), lease()];
    const { budget } = computeAliveBudget(leases, 4, BOOT, alwaysAlive);
    expect(budget).toBe(0);
  });
  test("cap <= 0 disables the cap (Infinity budget)", () => {
    const { budget } = computeAliveBudget([lease(), lease()], 0, BOOT, alwaysAlive);
    expect(budget).toBe(Number.POSITIVE_INFINITY);
  });
  test("pre-boot live children are flagged but still counted", () => {
    const preBoot = lease({ started_at: new Date(BOOT - 5000).toISOString() });
    const r = computeAliveBudget([preBoot, lease()], 4, BOOT, alwaysAlive);
    expect(r.aliveCount).toBe(2);
    expect(r.preBootLive).toBe(1);
  });
  test("restart with N live children: budget = cap - N, never over-launches", () => {
    // Children surviving a driver restart all predate BOOT; they must be counted
    // so the cap stays a hard bound across restarts.
    const survivors = [0, 1, 2].map((i) =>
      lease({ pid: 100 + i, started_at: new Date(BOOT - 9000).toISOString() }));
    const { aliveCount, budget } = computeAliveBudget(survivors, 4, BOOT, alwaysAlive);
    expect(aliveCount).toBe(3);
    expect(budget).toBe(1);
  });
});

const TIERS = tierIndexMap(DEFAULT_CONCURRENCY_TIERS); // role -> tier index
const cand = (key: string, role: string, age = 0, urgent = false): Candidate =>
  ({ key, role: role as Candidate["role"], paths: [], age, urgent, launchArgs: {} as Candidate["launchArgs"] });

describe("tierIndexMap / effectiveTierIndexMap (DEC-031)", () => {
  test("default mapping: gates top, worker+scout+artisan share a tier, empty demotion tier", () => {
    expect(TIERS.concierge).toBe(0);
    expect(TIERS.guardian).toBe(0);
    expect(TIERS.observer).toBe(0);
    expect(TIERS.smith).toBe(1);
    expect(TIERS.librarian).toBe(1);
    expect(TIERS.worker).toBe(2);
    expect(TIERS.scout).toBe(2);              // co-equal with worker (FIFO decides)
    expect(TIERS.artisan).toBe(2);            // same tier (never competes with them)
    // tier 3 is the reserved demotion lane — no role maps to it
    expect(Object.values(TIERS)).not.toContain(3);
  });

  test("Dock reorders ONLY the producer band; gates stay top, artisan sinks below", () => {
    // Promote worker to the top producer tier; regroup smith/librarian after it.
    const eff = effectiveTierIndexMap(DEFAULT_CONCURRENCY_TIERS, [["worker"], ["smith", "librarian"], ["scout"]]);
    expect(eff.guardian).toBe(0);             // gate tier fixed at top
    expect(eff.worker).toBe(1);               // worker promoted to the top producer tier
    expect(eff.smith).toBe(2);
    expect(eff.librarian).toBe(2);            // still co-equal with smith
    expect(eff.scout).toBe(3);
    // artisan is not a producer: it drops below the reordered producer band
    expect(eff.artisan).toBeGreaterThan(eff.scout);
  });

  test("override ignores non-producer roles (gates, artisan) and unknowns", () => {
    const eff = effectiveTierIndexMap(DEFAULT_CONCURRENCY_TIERS, [["artisan", "bogus", "scout"], ["worker"]]);
    expect(eff.concierge).toBe(0);            // gates fixed
    expect(eff.scout).toBe(1);                // scout is the only valid producer in group 1 -> top producer tier
    expect(eff.worker).toBe(2);
    expect(eff.artisan).toBeGreaterThan(eff.worker); // artisan never reorderable, sinks to bottom
  });

  test("omitted producers keep a tier (appended in default order), artisan last", () => {
    const eff = effectiveTierIndexMap(DEFAULT_CONCURRENCY_TIERS, [["scout"]]); // only scout specified
    expect(eff.scout).toBe(1);                // scout promoted to the top producer tier
    for (const r of ["smith", "librarian", "worker"]) {
      expect(eff[r]).toBeGreaterThan(eff.scout);
      expect(eff[r]).toBeLessThan(eff.artisan);   // artisan sinks below all producers
    }
  });
});

describe("planDetachedSchedule (DEC-031 tiers + FIFO)", () => {
  test("launches in tier order up to budget, defers the rest", () => {
    // guardian (T0) then smith (T1) beat scout (T2, the shared producer tier).
    const candidates = [
      cand("scout:s1", "scout"),
      cand("guardian:g1", "guardian"),
      cand("smith:sm1", "smith"),
    ];
    const { launch, defer } = planDetachedSchedule(candidates, 2, TIERS, 3);
    expect(launch.map((c) => c.key)).toEqual(["guardian:g1", "smith:sm1"]);
    expect(defer.map((c) => c.key)).toEqual(["scout:s1"]);
  });

  test("during the artisan lane, gates preempt the artisan (artisan is bottom)", () => {
    // Only artisan + gates are candidates in the artisan lane; with 1 slot the
    // guardian gate runs before the artisan.
    const candidates = [cand("artisan:x", "artisan"), cand("guardian:g1", "guardian")];
    const { launch } = planDetachedSchedule(candidates, 1, TIERS, 3);
    expect(launch.map((c) => c.key)).toEqual(["guardian:g1"]);
  });

  test("budget 0 defers everything", () => {
    const { launch, defer } = planDetachedSchedule([cand("worker:w1", "worker")], 0, TIERS, 3);
    expect(launch).toHaveLength(0);
    expect(defer).toHaveLength(1);
  });

  test("Infinity budget launches everything", () => {
    const all = [cand("worker:w1", "worker"), cand("scout:s1", "scout"), cand("observer:o1", "observer")];
    const { launch, defer } = planDetachedSchedule(all, Number.POSITIVE_INFINITY, TIERS, 3);
    expect(launch).toHaveLength(3);
    expect(defer).toHaveLength(0);
  });

  test("FIFO within a tier: the longest-waiting same-role instance runs first", () => {
    const candidates = [cand("worker:w1", "worker", 0), cand("worker:w2", "worker", 2)];
    const { launch } = planDetachedSchedule(candidates, 1, TIERS, 3);
    expect(launch.map((c) => c.key)).toEqual(["worker:w2"]);
  });

  test("aged candidate is promoted ahead of a higher-tier fresh one (cross-tier breaker)", () => {
    const candidates = [cand("guardian:g1", "guardian", 0), cand("scout:s1", "scout", 3)];
    const { launch } = planDetachedSchedule(candidates, 1, TIERS, 3);
    expect(launch.map((c) => c.key)).toEqual(["scout:s1"]);
  });

  test("aging disabled (starvationCycles 0) keeps strict tier order", () => {
    const candidates = [cand("guardian:g1", "guardian", 0), cand("scout:s1", "scout", 99)];
    const { launch } = planDetachedSchedule(candidates, 1, TIERS, 0);
    expect(launch.map((c) => c.key)).toEqual(["guardian:g1"]);
  });

  test("a PM/user-flagged URGENT scout jumps above its role tier (and even gates)", () => {
    // "investigate XXX with a Scout first" => urgent scout outranks a fresh guardian.
    const candidates = [cand("guardian:g1", "guardian", 0), cand("scout:s1", "scout", 0, true)];
    const { launch } = planDetachedSchedule(candidates, 1, TIERS, 3);
    expect(launch.map((c) => c.key)).toEqual(["scout:s1"]);
  });

  test("urgent beats the aging breaker; among urgents, tier then FIFO decides", () => {
    const candidates = [
      cand("scout:s1", "scout", 5),               // aged but not urgent
      cand("worker:w1", "worker", 0, true),       // urgent producer
      cand("guardian:g1", "guardian", 0, true),   // urgent gate (higher tier)
    ];
    const { launch } = planDetachedSchedule(candidates, 2, TIERS, 3);
    // both urgents first, gate (tier 0) before worker (tier 2); aged scout last
    expect(launch.map((c) => c.key)).toEqual(["guardian:g1", "worker:w1"]);
  });

  test("same tier + same age falls back to deterministic key order", () => {
    const candidates = [cand("worker:w2", "worker", 1), cand("worker:w1", "worker", 1)];
    const { launch } = planDetachedSchedule(candidates, 1, TIERS, 3);
    expect(launch.map((c) => c.key)).toEqual(["worker:w1"]);
  });

  test("does not mutate the input array order", () => {
    const candidates = [cand("scout:s1", "scout"), cand("guardian:g1", "guardian")];
    planDetachedSchedule(candidates, 1, TIERS, 3);
    expect(candidates.map((c) => c.key)).toEqual(["scout:s1", "guardian:g1"]);
  });
});

describe("ChangeTracker.peekChanged (stranding fix)", () => {
  test("peek is non-mutating; only hasChanged commits the snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "symph-peek-"));
    try {
      const file = join(dir, "interest.md");
      writeFileSync(file, "v1");
      const t = new ChangeTracker();

      // First probes: no snapshot yet → changed. Two peeks in a row both stay
      // true, proving peek did not commit a baseline.
      expect(t.peekChanged("k", [file])).toBe(true);
      expect(t.peekChanged("k", [file])).toBe(true);

      // Commit the baseline.
      expect(t.hasChanged("k", [file])).toBe(true);

      // Now unchanged: peek sees the committed snapshot.
      expect(t.peekChanged("k", [file])).toBe(false);

      // A real change flips peek back to true (without consuming it).
      writeFileSync(file, "v2-much-longer-content-to-bump-mtime");
      // mtime resolution can be coarse; force a distinct mtime.
      const future = new Date(Date.now() + 5000);
      try { require("node:fs").utimesSync(file, future, future); } catch { /* ignore */ }
      expect(t.peekChanged("k", [file])).toBe(true);
      expect(t.peekChanged("k", [file])).toBe(true); // still true — peek didn't consume it
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
