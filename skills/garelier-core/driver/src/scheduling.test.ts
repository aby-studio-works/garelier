import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observerShouldRun,
  workerLikeShouldRun,
  artisanShouldRun,
  scoutShouldRun,
  readLaneLock,
  failureBackoffMs,
  FAILURE_CIRCUIT_THRESHOLD,
  rateLimitBackoffMs,
  coordinatorIdleBackoffMs,
  COORD_IDLE_GUARD_THRESHOLD,
  buildRoleStatusSummary,
} from "./main.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp() { const d = mkdtempSync(join(tmpdir(), "symphsch-")); dirs.push(d); return d; }

describe("observerShouldRun (DEC-019 sidecar)", () => {
  test("IDLE waits unless an assignment is present", () => {
    const d = tmp();
    expect(observerShouldRun(d, "IDLE", false)).toBe(false);
    expect(observerShouldRun(d, "IDLE", true)).toBe(true);
  });
  test("ASSIGNED and OBSERVING run", () => {
    const d = tmp();
    expect(observerShouldRun(d, "ASSIGNED", true)).toBe(true);
    expect(observerShouldRun(d, "OBSERVING", false)).toBe(true);
  });
  test("REPORTING waits for acked.md, then runs to archive", () => {
    const d = tmp();
    expect(observerShouldRun(d, "REPORTING", false)).toBe(false);
    writeFileSync(join(d, "acked.md"), "ok");
    expect(observerShouldRun(d, "REPORTING", false)).toBe(true);
  });
  test("ACKED runs (archive then IDLE)", () => {
    expect(observerShouldRun(tmp(), "ACKED", false)).toBe(true);
  });
  test("BLOCKED waits for answers.md", () => {
    const d = tmp();
    expect(observerShouldRun(d, "BLOCKED", false)).toBe(false);
    writeFileSync(join(d, "answers.md"), "a");
    expect(observerShouldRun(d, "BLOCKED", false)).toBe(true);
  });
  test("abort.md forces a run from any state", () => {
    const d = tmp();
    writeFileSync(join(d, "abort.md"), "stop");
    expect(observerShouldRun(d, "IDLE", false)).toBe(true);
  });
  test("ABORTED (no abort.md) does not run", () => {
    expect(observerShouldRun(tmp(), "ABORTED", true)).toBe(false);
  });
});

describe("observer-only states never trigger commit-producing roles", () => {
  test("workerLikeShouldRun ignores OBSERVING/ACKED", () => {
    const d = tmp();
    expect(workerLikeShouldRun(d, "OBSERVING", true, false)).toBe(false);
    expect(workerLikeShouldRun(d, "ACKED", true, false)).toBe(false);
  });
  test("artisanShouldRun ignores OBSERVING/ACKED", () => {
    const d = tmp();
    expect(artisanShouldRun(d, "OBSERVING", true)).toBe(false);
    expect(artisanShouldRun(d, "ACKED", true)).toBe(false);
  });
  test("scoutShouldRun ignores OBSERVING/ACKED", () => {
    expect(scoutShouldRun(tmp(), "OBSERVING", true, false)).toBe(false);
  });
});

describe("readLaneLock (lane exclusivity, DEC-017)", () => {
  test("reads a written lane.lock", () => {
    const root = tmp();
    const rt = join(root, "__garelier", "pm", "runtime");
    mkdirSync(rt, { recursive: true });
    writeFileSync(join(rt, "lane.lock"), JSON.stringify({ lane: "artisan", owner: "sol1", pid: 4242 }));
    const lock = readLaneLock(root, "pm");
    expect(lock?.lane).toBe("artisan");
    expect(lock?.pid).toBe(4242);
  });
  test("absent lock → null", () => {
    expect(readLaneLock(tmp(), "pm")).toBeNull();
  });
});

describe("failure circuit breaker (failureBackoffMs)", () => {
  test("no backoff below the threshold (retry next poll as before)", () => {
    for (let n = 0; n < FAILURE_CIRCUIT_THRESHOLD; n++) {
      expect(failureBackoffMs(n)).toBe(0);
    }
  });
  test("backoff doubles from the threshold, capped at 30m", () => {
    expect(failureBackoffMs(FAILURE_CIRCUIT_THRESHOLD)).toBe(1 * 60 * 1000); // 1m
    expect(failureBackoffMs(FAILURE_CIRCUIT_THRESHOLD + 1)).toBe(2 * 60 * 1000); // 2m
    expect(failureBackoffMs(FAILURE_CIRCUIT_THRESHOLD + 2)).toBe(4 * 60 * 1000); // 4m
    expect(failureBackoffMs(FAILURE_CIRCUIT_THRESHOLD + 3)).toBe(8 * 60 * 1000); // 8m
    expect(failureBackoffMs(FAILURE_CIRCUIT_THRESHOLD + 4)).toBe(16 * 60 * 1000); // 16m
    // 2^5 = 32 > 30 cap
    expect(failureBackoffMs(FAILURE_CIRCUIT_THRESHOLD + 5)).toBe(30 * 60 * 1000); // 30m cap
    expect(failureBackoffMs(FAILURE_CIRCUIT_THRESHOLD + 50)).toBe(30 * 60 * 1000); // still capped
  });
});

// The fatal death-spiral fix: a rate-limited role must PARK for a self-expiring
// window, not re-launch (and re-hit) every poll. Unlike the failure breaker this
// arms on the FIRST hit (a limit means "wait"), and every value is finite so a
// cleared limit always resumes (no hard stall).
describe("rate-limit per-role brake (rateLimitBackoffMs)", () => {
  test("arms on the FIRST hit (no free retry — a limit means wait)", () => {
    expect(rateLimitBackoffMs(0)).toBe(0);
    expect(rateLimitBackoffMs(1)).toBe(1 * 60 * 1000); // 1m on the very first hit
  });
  test("doubles per consecutive hit, capped at 30m, always finite (self-expiring)", () => {
    expect(rateLimitBackoffMs(2)).toBe(2 * 60 * 1000);
    expect(rateLimitBackoffMs(3)).toBe(4 * 60 * 1000);
    expect(rateLimitBackoffMs(4)).toBe(8 * 60 * 1000);
    expect(rateLimitBackoffMs(5)).toBe(16 * 60 * 1000);
    expect(rateLimitBackoffMs(6)).toBe(30 * 60 * 1000); // 2^5=32 -> 30m cap
    const big = rateLimitBackoffMs(100);
    expect(big).toBe(30 * 60 * 1000);                   // still capped
    expect(Number.isFinite(big)).toBe(true);            // never an infinite/permanent park
  });
});

describe("coordinator no-action loop guard", () => {
  test("starts after the threshold and caps at 5m", () => {
    for (let n = 0; n < COORD_IDLE_GUARD_THRESHOLD; n++) {
      expect(coordinatorIdleBackoffMs(n)).toBe(0);
    }
    expect(coordinatorIdleBackoffMs(COORD_IDLE_GUARD_THRESHOLD)).toBe(1 * 60 * 1000);
    expect(coordinatorIdleBackoffMs(COORD_IDLE_GUARD_THRESHOLD + 1)).toBe(2 * 60 * 1000);
    expect(coordinatorIdleBackoffMs(COORD_IDLE_GUARD_THRESHOLD + 2)).toBe(4 * 60 * 1000);
    expect(coordinatorIdleBackoffMs(COORD_IDLE_GUARD_THRESHOLD + 3)).toBe(5 * 60 * 1000);
    expect(coordinatorIdleBackoffMs(COORD_IDLE_GUARD_THRESHOLD + 20)).toBe(5 * 60 * 1000);
  });
});

describe("buildRoleStatusSummary", () => {
  test("renders compact per-role status lines from resolved containers", () => {
    const summary = buildRoleStatusSummary([
      { role: "worker", id: "w1", container: "/home/x/_workers/w1" },
      { role: "artisan", id: "", container: "/home/x/_artisan" },
    ], (stateFile) => {
      if (stateFile.includes("_workers")) {
        return { status: "WORKING", lastActivity: "2026-06-02T12:00:00Z  implementing UI" };
      }
      return { status: "IDLE" };
    });
    expect(summary).toContain("- worker w1: WORKING; last=2026-06-02T12:00:00Z implementing UI; container=/home/x/_workers/w1");
    expect(summary).toContain("- artisan: IDLE; container=/home/x/_artisan");
    expect(summary).not.toContain("assignment.md");
    expect(summary).not.toContain("report.md");
  });
  test("inlines the deliverable-sidecar digest for a role that reported (DEC-049 D)", () => {
    const summary = buildRoleStatusSummary(
      [{ role: "worker", id: "w1", container: "/home/x/_workers/w1" }],
      () => ({ status: "REPORTING" as const }),
      (reportPath) => reportPath.endsWith("/report.md")
        ? {
            schemaVersion: 1 as const, assignmentId: null, taskId: "#7", role: "worker",
            status: "REPORTING", verdict: null, summary: "wired rollback caller",
            commits: [], filesChanged: [], tests: { unit: "pass" }, riskFlags: {}, needs: [],
          }
        : null,
    );
    expect(summary).toContain("worker w1: REPORTING");
    expect(summary).toContain("wired rollback caller"); // report essence inlined, no full-body read
    expect(summary).toContain("tests unit:pass");
    expect(summary).toContain("↳");
  });
  test("no sidecar → just the status line (no digest)", () => {
    const summary = buildRoleStatusSummary(
      [{ role: "worker", id: "w1", container: "/x/_workers/w1" }],
      () => ({ status: "WORKING" as const }),
      () => null,
    );
    expect(summary).toContain("worker w1: WORKING");
    expect(summary).not.toContain("↳");
  });
  // DEC-042 context-diet guard: a coordinator wake must never inline a full
  // report/STATE body. lastActivity is capped at 120 and the sidecar digest at
  // 400, so the per-role line stays small no matter how large the source is.
  test("bounds lastActivity and the sidecar digest (no full-body inline)", () => {
    const hugeActivity = "x".repeat(5000);
    const hugeSummary = "y".repeat(5000);
    const summary = buildRoleStatusSummary(
      [{ role: "worker", id: "w1", container: "/x/_workers/w1" }],
      () => ({ status: "REPORTING" as const, lastActivity: hugeActivity }),
      () => ({
        schemaVersion: 1 as const, assignmentId: null, taskId: "#9", role: "worker",
        status: "REPORTING", verdict: null, summary: hugeSummary,
        commits: [], filesChanged: [], tests: {}, riskFlags: {}, needs: [],
      }),
    );
    expect(summary.length).toBeLessThan(700);
    expect(summary).not.toContain("x".repeat(121)); // lastActivity capped at 120
    expect(summary).not.toContain("y".repeat(401));  // digest capped at 400
  });
});
