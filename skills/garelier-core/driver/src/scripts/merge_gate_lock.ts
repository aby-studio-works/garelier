// W-175: pure active-lock classification for the merge gate. Extracted so the
// dead-pid reclaim (f) and the exit-reason strings (g) are unit-testable without
// spawning a real gate. merge-gate.ts's acquireActiveLock wraps this with the
// file I/O; the test drives it with a mock liveness probe. W-169 (f): the atomic
// acquire itself is extracted here too, so real 2-process mutual exclusion is
// testable end-to-end (not just the classification in isolation).

import { readFileSync, writeFileSync } from "node:fs";

export interface ActiveLockState {
  pid: string;
  request_id: string;
}
export type LockAction = "create" | "proceed" | "reclaim" | "different" | "second";
export interface LockVerdict {
  action: LockAction;
  reason: string;
}

/** Decide what a starting runner should do given the existing active.lock (null =
 * absent). `isAlive(pid)` probes the lock owner's liveness — a DEAD owner's lock is
 * reclaimed (W-175 f) instead of stalling the queue; a LIVE owner is respected
 * (queue serialization / W-076 second-runner). Every branch carries a one-line
 * reason so no exit is silent (W-175 g). */
export function classifyActiveLock(
  existing: ActiveLockState | null,
  myPid: string,
  myReq: string,
  isAlive: (pid: string) => boolean,
): LockVerdict {
  if (!existing) return { action: "create", reason: `created (request_id=${myReq}, pid=${myPid || "?"})` };
  const lpid = existing.pid;
  const lreq = existing.request_id;
  // Driver/orchestrator wrote it for THIS gate (same pid) → adopt and proceed.
  if (lpid && myPid && lpid === myPid) {
    return { action: "proceed", reason: `adopted (driver wrote it for THIS gate: request_id=${myReq}, pid=${myPid})` };
  }
  // Same request, a DIFFERENT pid → a concurrent second runner (W-076) when the
  // holder is LIVE, else a stale lock left by a crashed prior runner → reclaim.
  if (lreq && lreq === myReq && lpid && myPid && lpid !== myPid) {
    return isAlive(lpid)
      ? { action: "second", reason: `SECOND RUNNER — request ${myReq} already held by LIVE pid ${lpid} (mine=${myPid}); exiting without staging (W-076)` }
      : { action: "reclaim", reason: `stale lock reclaimed — request ${myReq} was held by DEAD pid ${lpid} (mine=${myPid}); proceeding (W-175 f)` };
  }
  // A DIFFERENT request holds the lock → queue serialization when the holder is
  // LIVE; a provably-DEAD pid means a crashed prior request left the lock, so
  // reclaim it and drain the queue. An empty/unknown pid keeps the conservative
  // exit (never reclaim on an unprovable owner).
  if (lreq && lreq !== myReq) {
    return lpid && !isAlive(lpid)
      ? { action: "reclaim", reason: `stale lock reclaimed — a DIFFERENT request '${lreq}' held it via DEAD pid ${lpid} (mine=${myReq}); proceeding so the queue drains (W-175 f)` }
      : { action: "different", reason: `held by a DIFFERENT request '${lreq}' (pid '${lpid}', mine=${myReq}) — not staging on top of it, exiting (queue serialization)` };
  }
  // Ambiguous (missing pid or request_id) → fail-open, same as before.
  return { action: "proceed", reason: `present but ownership ambiguous (req='${lreq}' pid='${lpid}' mine='${myPid || "?"}') — proceeding (fail-open)` };
}

/** W-175 R1: does the active.lock, as read RIGHT NOW, belong to me? Used to make
 * dead-lock reclaim atomic — after overwriting the lock the runner re-reads it and,
 * if a concurrent reclaimer's write landed last, backs off (loser) instead of two
 * runners both staging a `git merge` (shared-index clobber) — and to re-verify
 * ownership one more time immediately before the destructive merge (pre-stage).
 * Ownership is by request_id (with the pid as a tiebreaker when both are known). */
export function ownsActiveLock(lockReqId: string, lockPid: string, myReqId: string, myPid: string): boolean {
  if (!myReqId || lockReqId !== myReqId) return false;
  return !lockPid || !myPid || lockPid === myPid;
}

/** Read one field from an active.lock JSON file; "" when absent/unreadable. */
export function readLockField(lockPath: string, key: string): string {
  try {
    const j = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    const v = j[key];
    return v == null ? "" : String(v);
  } catch { return ""; }
}

export interface AcquireActiveLockOptions {
  lockPath: string;
  requestId: string;
  ownerPid: string;
  lockBody: string;                     // the JSON to write into active.lock
  isAlive: (pid: string) => boolean;
  log?: (msg: string) => void;
}

/** W-169 (f) / W-175: the atomic active-lock acquire. Returns 0 proceed / 10
 * different-or-lost-reclaim / 11 second-runner. The `wx` (noclobber) create is the
 * OS-atomic arbiter: exactly one racer creates the file; a loser reads the LIVE
 * different owner and backs off (10), so two runners never both stage a `git
 * merge`. A provably-DEAD owner is reclaimed, then re-read for atomicity (a
 * concurrent reclaimer's write winning => back off 10). Extracted from merge-gate.ts
 * so real multi-process mutual exclusion is testable, not only the classification. */
export function acquireActiveLockAt(o: AcquireActiveLockOptions): number {
  const log = o.log ?? (() => {});
  try {
    writeFileSync(o.lockPath, o.lockBody, { flag: "wx" });
    log(`created (request_id=${o.requestId}, pid=${o.ownerPid || "?"})`);
    return 0;
  } catch { /* already exists — inspect ownership */ }
  const existing = { request_id: readLockField(o.lockPath, "request_id"), pid: readLockField(o.lockPath, "pid") };
  const v = classifyActiveLock(existing, o.ownerPid, o.requestId, o.isAlive);
  log(v.reason);
  switch (v.action) {
    case "reclaim": {
      try { writeFileSync(o.lockPath, o.lockBody); } catch { /* best-effort */ }
      if (!ownsActiveLock(readLockField(o.lockPath, "request_id"), readLockField(o.lockPath, "pid"), o.requestId, o.ownerPid)) {
        log(`LOST reclaim race — now held by req='${readLockField(o.lockPath, "request_id")}' pid='${readLockField(o.lockPath, "pid")}' (mine=${o.requestId}/${o.ownerPid}); backing off to the queue (W-175 R1)`);
        return 10;
      }
      log(`reclaim confirmed for request ${o.requestId} (pid=${o.ownerPid})`);
      return 0;
    }
    case "different": return 10;
    case "second": return 11;
    default: return 0; // create / proceed
  }
}

/** W-175 b: merge_land self-heal decision. While block-waiting for its own gate
 * result, a submitter should re-spawn (re-poll) the gate when its request has NOT
 * produced a result AND no LIVE runner holds the active lock — i.e. a prior gate
 * crashed without draining and nothing picked the queue up. A live lock owner means
 * a runner is working, so keep waiting instead of piling on. */
export function shouldRepollStalledGate(resultExists: boolean, lockOwnerLive: boolean): boolean {
  return !resultExists && !lockOwnerLive;
}
