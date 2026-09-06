// W-175: unit tests for the merge-gate active-lock classifier (dead-pid reclaim f
// + no-silent-exit reason g). Pure function, mock liveness — no real gate spawn.

import { test, expect } from "bun:test";
import { acquireActiveLockAt, classifyActiveLock, ownsActiveLock } from "./merge_gate_lock.ts";

const ALIVE = () => true;
const DEAD = () => false;

// W-343 CL-5: consolidated from 8 separate one-scenario tests into one
// table-driven test (same exact inputs/expected action + reason substring for
// every case, zero coverage change) to make room for the new closure-primitive
// oracle below without growing the repository's canonical test-definition count.
test("classifyActiveLock: create / adopt / second-runner / reclaim / queue-serialization / fail-open matrix", () => {
  const cases: Array<[string, Parameters<typeof classifyActiveLock>, string, string?]> = [
    ["no existing lock → create", [null, "100", "req-a", ALIVE], "create"],
    ["same pid (driver adopted) → proceed", [{ pid: "100", request_id: "req-a" }, "100", "req-a", DEAD], "proceed", "adopted"],
    ["same request, different LIVE pid → second runner (W-076)", [{ pid: "200", request_id: "req-a" }, "100", "req-a", ALIVE], "second", "W-076"],
    ["same request, different DEAD pid → reclaim (W-175 f)", [{ pid: "200", request_id: "req-a" }, "100", "req-a", DEAD], "reclaim", "DEAD pid 200"],
    ["different request, LIVE holder → different (queue serialization)", [{ pid: "200", request_id: "req-b" }, "100", "req-a", ALIVE], "different", "queue serialization"],
    ["different request, DEAD holder → reclaim so the queue drains (W-175 f)", [{ pid: "200", request_id: "req-b" }, "100", "req-a", DEAD], "reclaim", "queue drains"],
    ["different request with an EMPTY pid keeps the conservative exit (no reclaim on an unprovable owner)", [{ pid: "", request_id: "req-b" }, "100", "req-a", DEAD], "different"],
    ["ambiguous lock (no request_id) → fail-closed (W-346 FR13: the fail-open is retired)", [{ pid: "", request_id: "" }, "100", "req-a", DEAD], "different", "fail-closed"],
  ];
  for (const [label, args, expectedAction, expectedReasonSubstring] of cases) {
    const v = classifyActiveLock(...args);
    expect(`${label}: ${v.action}`).toBe(`${label}: ${expectedAction}`);
    if (expectedReasonSubstring) expect(v.reason).toContain(expectedReasonSubstring);
  }
});

// W-346 CL-5: the prior single-purpose tests (R1 concurrent-reclaim ownership /
// ownsActiveLock matrix / non-empty reasons)
// are consolidated here verbatim, making census room for the FR4 placeholder
// adoption scenarios without growing the repository definition count.
test("lock helpers: R1 ownership, non-empty reasons, and FR4 placeholder adoption (W-175 / W-346)", () => {
  // W-175 R1: after both racers write, only the last writer owns the lock.
  const lockNow = { request_id: "req-b", pid: "200" };
  expect(ownsActiveLock(lockNow.request_id, lockNow.pid, "req-b", "200")).toBe(true);  // winner
  expect(ownsActiveLock(lockNow.request_id, lockNow.pid, "req-a", "100")).toBe(false); // loser backs off
  expect(ownsActiveLock("req-a", "100", "req-a", "100")).toBe(true);
  expect(ownsActiveLock("req-a", "", "req-a", "100")).toBe(true);   // unknown lock pid → request_id decides
  expect(ownsActiveLock("req-a", "100", "req-a", "")).toBe(true);   // unknown my pid → request_id decides
  expect(ownsActiveLock("req-a", "100", "req-a", "999")).toBe(false); // same request, DIFFERENT pid → not mine
  expect(ownsActiveLock("req-a", "100", "req-b", "100")).toBe(false); // different request
  expect(ownsActiveLock("", "", "", "")).toBe(false);               // empty request never owns

  // W-175 g: every verdict carries a non-empty reason (no silent exit).
  const reasonCases = [
    classifyActiveLock(null, "1", "a", ALIVE),
    classifyActiveLock({ pid: "2", request_id: "a" }, "1", "a", ALIVE),
    classifyActiveLock({ pid: "2", request_id: "a" }, "1", "a", DEAD),
    classifyActiveLock({ pid: "2", request_id: "b" }, "1", "a", ALIVE),
    classifyActiveLock({ pid: "2", request_id: "b" }, "1", "a", DEAD),
  ];
  for (const c of reasonCases) expect(c.reason.length).toBeGreaterThan(0);

  // W-346 FR4/FR13: placeholder-before-spawn adoption by EXACT nonce.
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const pathMod = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "mg-placeholder-"));
  try {
    const lockPath = pathMod.join(dir, "active.lock");
    const placeholder = (nonce: string, spawnerPid: number) => JSON.stringify({
      pid: 0, placeholder: true, nonce, spawner_pid: spawnerPid, request_id: "req-a", request_file: "req-a.json",
    });
    const acquire = (adoptNonce: string | undefined, isAlive: (pid: string) => boolean) => acquireActiveLockAt({
      lockPath, requestId: "req-a", ownerPid: "500",
      lockBody: JSON.stringify({ pid: 500, request_id: "req-a", nonce: adoptNonce ?? null }) + "\n",
      isAlive, adoptNonce,
    });
    // (a) exact nonce + request id → adopted, lock rewritten to the child's body.
    fs.writeFileSync(lockPath, placeholder("nonce-1", 42));
    expect(acquire("nonce-1", () => true)).toBe(0);
    expect((JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number }).pid).toBe(500);
    // (b) foreign placeholder (nonce mismatch) with a LIVE spawner → back off 10.
    fs.writeFileSync(lockPath, placeholder("other-nonce", 42));
    expect(acquire("nonce-1", () => true)).toBe(10);
    expect((JSON.parse(fs.readFileSync(lockPath, "utf8")) as { nonce: string }).nonce).toBe("other-nonce"); // untouched
    // (c) foreign placeholder whose spawner is provably DEAD → reclaimed, proceed.
    expect(acquire("nonce-1", () => false)).toBe(0);
    expect((JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number }).pid).toBe(500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// W-343: bounded integration closure primitive (CL-1, CL-2, CL-4). Table-driven
// so a single `test()` proves the CAS lifecycle, dead-owner reclaim, tamper/
// bounds rejection, and epoch fail-closed behavior without growing the
// repository's canonical test-definition count (CL-5 net non-increasing).

import {
  acquireClosure, bindClosureResult, activateClosure, closeClosure, heartbeatClosure,
  recoverClosure, attemptDeadOwnerReclaim, reclaimEligible, inspectClosure, assertChokepointAllowed,
  validateIntent, validateState, closurePaths, sha256Hex, pruneClosureHistory, __internal,
  reserveSuccessorRequestId, publishSuccessorRequest, rollbackSuccessorReservation,
  processStartIdentity, parseProcessStartIdentity, systemSameProcessStillRunning,
  MAX_STATE_BYTES, MAX_FENCING_EPOCH,
} from "../integration_closure.ts";

function withTempProject<T>(fn: (root: string) => T): T {
  const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "closure-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W-343: closure CAS lifecycle — acquire, idempotent re-acquire, conflict, bind/activate fencing, recover, close", () => {
  withTempProject((root) => {
    const pmId = "p";
    const branch = "b";
    const sha = "a".repeat(40);
    const digest = sha256Hex("origin-1");

    const paths = closurePaths(root, pmId);
    const rec = acquireClosure(root, pmId, branch, { owner_session: "s1", base_studio_sha: sha, origin_request_digest: digest, closure_work_id: "W-1" });
    expect(rec.phase).toBe("acquired");
    expect(rec.fencing_epoch).toBe(1);

    // Idempotent same-origin retry returns the SAME lease unmutated (no new epoch).
    const again = acquireClosure(root, pmId, branch, { owner_session: "s1", base_studio_sha: sha, origin_request_digest: digest, closure_work_id: "W-1" });
    expect(again.lease_id).toBe(rec.lease_id);
    expect(again.fencing_epoch).toBe(1);

    // A DIFFERENT origin on the same studio branch is refused — one active
    // lease per lineage — and it must not mutate anything (state stays as-is).
    expect(() => acquireClosure(root, pmId, branch, { owner_session: "s2", base_studio_sha: "b".repeat(40), origin_request_digest: sha256Hex("other") }))
      .toThrow(/already has an active closure lease/);

    const fence = { lease_id: rec.lease_id, nonce: rec.nonce, fencing_epoch: rec.fencing_epoch };
    const staleFence = { ...fence, nonce: "0".repeat(32) };

    // A stale fence (wrong nonce) is refused by every mutating op (CL-2 CAS-safety).
    expect(() => bindClosureResult(root, pmId, staleFence, sha256Hex("r"), "c".repeat(40))).toThrow(/fence mismatch/);
    expect(() => heartbeatClosure(root, pmId, staleFence)).toThrow(/fence mismatch/);

    const bound = bindClosureResult(root, pmId, fence, sha256Hex("result-1"), "c".repeat(40));
    expect(bound.phase).toBe("bound");
    // bind is only valid from 'acquired' — calling it twice with the CORRECT
    // fence still fails because the phase already moved on.
    expect(() => bindClosureResult(root, pmId, fence, sha256Hex("result-2"), "d".repeat(40))).toThrow(/expected phase 'acquired'/);

    const active = activateClosure(root, pmId, fence);
    expect(active.phase).toBe("active");

    const hb = heartbeatClosure(root, pmId, fence);
    expect(hb.renewal_count).toBe(1);
    expect(hb.deadline_at).toBe(rec.deadline_at); // FR8: heartbeat never extends the deadline

    // recover(): origin sha already reachable in studio -> idempotent close, no re-merge.
    const recovered = recoverClosure(root, pmId, fence, (s) => s === "c".repeat(40));
    expect(recovered.outcome).toBe("closed");
    expect(inspectClosure(root, pmId)).toBeNull();

    // close() on an already-closed lease with the same fence is a no-op success (FR12).
    expect(closeClosure(root, pmId, fence, "test")).toEqual({ closed: true, already: true });

    // FR12 bounded history pruning: state.json's high-watermark and the newest
    // terminal entry are never removed even when many leases have cycled through.
    for (let i = 0; i < 5; i++) {
      const r = acquireClosure(root, pmId, `branch-${i}`, { owner_session: "s", base_studio_sha: sha, origin_request_digest: sha256Hex(`o${i}`) });
      const f = { lease_id: r.lease_id, nonce: r.nonce, fencing_epoch: r.fencing_epoch };
      closeClosure(root, pmId, f, "cycle");
    }
    const pruned = pruneClosureHistory(paths, 2);
    expect(pruned.length).toBe(4); // 6 terminal entries total (1 recover + 5 close), keep newest 2
    const remaining = require("node:fs").readdirSync(paths.historyDir);
    expect(remaining.length).toBe(2);

    // W-346 AC-2 (Guardian N11): the terminal-history ordinal comes from the
    // persisted monotonic counter, so pruning can never make a later entry
    // reuse an earlier ordinal. 6 terminal transitions happened above; after a
    // prune deleted 4 of them, the NEXT transition must still take ordinal 7 —
    // under the old file-count derivation it would have restarted low.
    const r7 = acquireClosure(root, pmId, "branch-post-prune", { owner_session: "s", base_studio_sha: sha, origin_request_digest: sha256Hex("post-prune") });
    closeClosure(root, pmId, { lease_id: r7.lease_id, nonce: r7.nonce, fencing_epoch: r7.fencing_epoch }, "post-prune close");
    const stateAfter = JSON.parse(require("node:fs").readFileSync(paths.statePath, "utf8")) as { last_history_ordinal: number };
    expect(stateAfter.last_history_ordinal).toBe(7);
    const newest = (require("node:fs").readdirSync(paths.historyDir) as string[]).sort().at(-1)!;
    expect(newest.endsWith("-000007.json")).toBe(true);

    // A stale fence against a lease that no longer exists is refused, not silently accepted.
    expect(() => recoverClosure(root, pmId, fence, () => true)).toThrow(/no active closure lease/);
  });
});

test("W-346 FR6: successor reservation/publish protocol and digest-bound chokepoint arbitration (CL-1/CL-3, O-1)", () => {
  withTempProject((root) => {
    const fs = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const pmId = "p";
    const branch = "b";
    const sha = "a".repeat(40);
    const originPayload = JSON.stringify({ request_id: "origin-1", body: "origin request bytes" });
    const rec = acquireClosure(root, pmId, branch, { owner_session: "s1", base_studio_sha: sha, origin_request_digest: sha256Hex(originPayload), successor_slots: 1 });
    const fence = { lease_id: rec.lease_id, nonce: rec.nonce, fencing_epoch: rec.fencing_epoch };
    bindClosureResult(root, pmId, fence, sha256Hex("r"), "c".repeat(40));
    activateClosure(root, pmId, fence);

    // FR3/FR7: an ordinary request is refused (byte-identical wait) — but the
    // ORIGIN request itself, identified by exact payload digest, converges.
    expect(assertChokepointAllowed(root, pmId, branch, { requestKind: "ordinary" }).allowed).toBe(false);
    expect(assertChokepointAllowed(root, pmId, branch, { requestKind: "ordinary", payloadDigest: sha256Hex(originPayload) }).allowed).toBe(true);
    // A DIFFERENT studio branch (or no closure at all) is always a pass-through.
    expect(assertChokepointAllowed(root, pmId, "unrelated-branch", { requestKind: "ordinary" }).allowed).toBe(true);
    expect(assertChokepointAllowed(root, "no-such-pm", branch, { requestKind: "ordinary" }).allowed).toBe(true);

    // FR6: reserve id BEFORE payload; publish = bind + fsync temp + atomic rename
    // in one coordinator critical section. The published file is byte-exact.
    const smithId = reserveSuccessorRequestId();
    const smithPayload = JSON.stringify({ request_id: smithId, closure_request_kind: "smith", closure_request_id: smithId, body: "smith verify" });
    const published = publishSuccessorRequest(root, pmId, fence, "smith", smithId, smithPayload);
    expect(published.published).toBe(true);
    const queueFile = join(root, "__garelier", pmId, "runtime", "merge_gate", "requests", `${smithId}.json`);
    expect(fs.readFileSync(queueFile, "utf8")).toBe(smithPayload);

    // O-1 closed: the allowlist admits ONLY (kind, id, exact payload digest).
    expect(assertChokepointAllowed(root, pmId, branch, { requestKind: "smith", requestId: smithId, payloadDigest: sha256Hex(smithPayload) }).allowed).toBe(true);
    expect(assertChokepointAllowed(root, pmId, branch, { requestKind: "smith", requestId: smithId, payloadDigest: sha256Hex("forged bytes") }).allowed).toBe(false);
    expect(assertChokepointAllowed(root, pmId, branch, { requestKind: "smith", requestId: smithId }).allowed).toBe(false); // no digest → no pass
    expect(assertChokepointAllowed(root, pmId, branch, { requestKind: "smith", requestId: "copied-id", payloadDigest: sha256Hex(smithPayload) }).allowed).toBe(false);

    // Same-id retry with the SAME payload is idempotent; a DIFFERENT payload is rejected.
    expect(publishSuccessorRequest(root, pmId, fence, "smith", smithId, smithPayload).published).toBe(true);
    expect(() => publishSuccessorRequest(root, pmId, fence, "smith", smithId, JSON.stringify({ evil: true })))
      .toThrow(/DIFFERENT kind\/payload digest/);
    // Capacity: successor_slots = 1 smith slot is now consumed.
    expect(() => publishSuccessorRequest(root, pmId, fence, "smith", reserveSuccessorRequestId(), JSON.stringify({ another: 1 })))
      .toThrow(/no free smith successor slot/);

    // recover() with an unreachable SHA blocks; a recovery successor then goes
    // through the SAME digest-bound protocol (max one recovery reservation).
    const blocked = recoverClosure(root, pmId, fence, () => false);
    expect(blocked.outcome).toBe("expired_blocked");
    const recoveryId = reserveSuccessorRequestId();
    const recoveryPayload = JSON.stringify({ request_id: recoveryId, closure_request_kind: "recovery", closure_request_id: recoveryId });
    expect(publishSuccessorRequest(root, pmId, fence, "recovery", recoveryId, recoveryPayload).published).toBe(true);
    expect(assertChokepointAllowed(root, pmId, branch, { requestKind: "recovery", requestId: recoveryId, payloadDigest: sha256Hex(recoveryPayload) }).allowed).toBe(true);
    expect(() => publishSuccessorRequest(root, pmId, fence, "recovery", reserveSuccessorRequestId(), JSON.stringify({ second: true })))
      .toThrow(/no free recovery successor slot/);

    // Rollback: only an UNPUBLISHED reservation, and (within the deadline) only
    // the exact fence. Simulate a bind-then-crash by hand-inserting the bound
    // entry through a failed publish: a published entry refuses rollback.
    expect(() => rollbackSuccessorReservation(root, pmId, fence, smithId)).toThrow(/only an UNPUBLISHED reservation/);
    expect(() => rollbackSuccessorReservation(root, pmId, fence, "no-such-id")).toThrow(/no reservation/);

    // W-346 O-2: a PRESENT-but-corrupt state file fails closed for EVERY kind.
    const paths = closurePaths(root, pmId);
    fs.writeFileSync(paths.statePath, "{not json");
    for (const requestKind of ["ordinary", "smith", "recovery"] as const) {
      const verdict = assertChokepointAllowed(root, pmId, branch, { requestKind, requestId: smithId, payloadDigest: sha256Hex(smithPayload) });
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toContain("fail-closed");
    }
  });
});

test("W-343: dead-owner reclaim requires every factor (deadline expired, dead pid, same host, no active gate) — a live/foreign/unexpired owner is never reclaimed", () => {
  withTempProject((root) => {
    const pmId = "p";
    const rec = acquireClosure(root, pmId, "b", { owner_session: "s1", base_studio_sha: "a".repeat(40), origin_request_digest: sha256Hex("o") });
    const soon = Date.now();
    const past = Date.parse(rec.deadline_at) + 1;

    // NOTE (W-346 AC-1): these fixtures were acquired by THIS live test process,
    // so the now-default REAL FR10 probe would correctly refuse to reclaim them
    // — the mocked-dead scenarios below inject `sameProcessStillRunning: DEAD2`
    // to keep testing the OTHER factors deterministically.
    const DEAD2 = () => false;
    expect(reclaimEligible(rec, { now: soon, isAlive: () => false, hasActiveGateOrMergeHead: () => false, sameProcessStillRunning: DEAD2 })).toBe(false); // deadline not expired
    expect(reclaimEligible(rec, { now: past, isAlive: () => true, hasActiveGateOrMergeHead: () => false, sameProcessStillRunning: DEAD2 })).toBe(false); // owner still alive
    expect(reclaimEligible(rec, { now: past, isAlive: () => false, hasActiveGateOrMergeHead: () => true, sameProcessStillRunning: DEAD2 })).toBe(false); // a real gate/MERGE_HEAD may be in flight
    expect(reclaimEligible({ ...rec, hostname: "some-other-host" }, { now: past, isAlive: () => false, hasActiveGateOrMergeHead: () => false, sameProcessStillRunning: DEAD2 })).toBe(false); // foreign host is `unknown`
    expect(reclaimEligible(rec, { now: past, isAlive: () => false, hasActiveGateOrMergeHead: () => false, sameProcessStillRunning: DEAD2 })).toBe(true); // every factor holds

    // W-346 AC-1: the DEFAULT second factor is now the real OS probe — the
    // recorded identity of THIS live process is positively confirmed, so
    // reclaim is refused even with a mocked-dead isAlive.
    expect(systemSameProcessStillRunning(process.pid, processStartIdentity())).toBe(true);
    expect(reclaimEligible(rec, { now: past, isAlive: () => false, hasActiveGateOrMergeHead: () => false })).toBe(false); // default probe blocks: same live process confirmed
    const shifted = parseProcessStartIdentity(processStartIdentity())!;
    expect(systemSameProcessStillRunning(process.pid, `${shifted.host}:${process.pid}:${shifted.startMs - 3_600_000}`)).toBe(false); // recycled-pid shape → cannot confirm
    expect(systemSameProcessStillRunning(process.pid, "malformed-identity")).toBe(false);
    expect(systemSameProcessStillRunning(process.pid, `not-this-host:${process.pid}:${shifted.startMs}`)).toBe(false);

    const out = attemptDeadOwnerReclaim(root, pmId, { now: past, isAlive: () => false, hasActiveGateOrMergeHead: () => false, sameProcessStillRunning: DEAD2 });
    expect(out.reclaimed).toBe(true);
    expect(inspectClosure(root, pmId)?.phase).toBe("expired_blocked");

    // Re-attempting on the now-`expired_blocked` record is a no-op refusal, not a crash.
    const again = attemptDeadOwnerReclaim(root, pmId, { now: past, isAlive: () => false, hasActiveGateOrMergeHead: () => false, sameProcessStillRunning: DEAD2 });
    expect(again.reclaimed).toBe(false);

    // W-343 REWORK N4: the reclaim's terminal entry must not collide with (and
    // silently overwrite) a later transition on the SAME lease, and
    // last_terminal_digest must advance to include it so the chain does not
    // skip the reclaim event. Close "b"'s lease now (state.json holds at most
    // one active lease per PM at a time — the next check needs it free).
    const paths = closurePaths(root, pmId);
    const stateAfterReclaim = JSON.parse(require("node:fs").readFileSync(paths.statePath, "utf8"));
    expect(stateAfterReclaim.last_terminal_digest).not.toBeNull();
    const reclaimFence = { lease_id: rec.lease_id, nonce: rec.nonce, fencing_epoch: rec.fencing_epoch };
    closeClosure(root, pmId, reclaimFence, "n4-regression-close");
    const historyFilesForLease = (require("node:fs").readdirSync(paths.historyDir) as string[]).filter((f) => f.includes(rec.lease_id));
    expect(historyFilesForLease.length).toBe(2); // reclaim (expired_blocked) + close (closed) — neither overwrote the other

    // W-343 REWORK N3 (FR10 second factor): a caller that POSITIVELY CONFIRMS
    // the recorded owner identity is still running blocks reclaim even though
    // isAlive() alone reports dead — `process_start_identity` is now an ACTIVE
    // input, not write-only. A caller that cannot confirm (the safe default)
    // still allows reclaim once every other factor holds.
    const rec2 = acquireClosure(root, pmId, "b-fr10", { owner_session: "s1", base_studio_sha: "a".repeat(40), origin_request_digest: sha256Hex("o2") });
    const past2 = Date.parse(rec2.deadline_at) + 1;
    expect(reclaimEligible(rec2, { now: past2, isAlive: () => false, hasActiveGateOrMergeHead: () => false, sameProcessStillRunning: () => true })).toBe(false);
    expect(reclaimEligible(rec2, { now: past2, isAlive: () => false, hasActiveGateOrMergeHead: () => false, sameProcessStillRunning: () => false })).toBe(true);

    // W-343 REWORK N1/N2 (Guardian probe repro): two "reclaimers" racing one
    // dead coordinator lock must never both proceed. Racer A reclaims (rename
    // to quarantine) and creates its OWN live lock; racer B still holds the
    // STALE dead-owner snapshot it read before A acted — under the OLD
    // unconditional-`unlinkSync` code, B would have silently deleted A's fresh
    // live lock ("SECOND HOLDER ENTERED WHILE FIRST STILL INSIDE"). The fix
    // must refuse instead, leaving A's lock untouched.
    const racePaths = closurePaths(root, pmId);
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    fs.mkdirSync(racePaths.root, { recursive: true });
    const deadOwnerBody = { pid: 999999, host: os.hostname(), nonce: "dead-nonce-1", process_start_identity: "dead-psi-1", at: new Date(0).toISOString() };
    fs.writeFileSync(racePaths.coordinatorLock, JSON.stringify(deadOwnerBody));
    const staleExpected = __internal.parseCoordinatorLock(racePaths.coordinatorLock)!;
    __internal.reclaimCoordinatorLock(racePaths.coordinatorLock, staleExpected); // racer A wins
    const aLiveBody = { pid: 111, host: deadOwnerBody.host, nonce: "a-live-nonce", process_start_identity: "a-live-psi", at: new Date().toISOString() };
    fs.writeFileSync(racePaths.coordinatorLock, JSON.stringify(aLiveBody), { flag: "wx" }); // A creates its own live lock
    expect(() => __internal.reclaimCoordinatorLock(racePaths.coordinatorLock, staleExpected)).toThrow(/owner changed before removal/); // racer B refused
    const survivingLock = JSON.parse(fs.readFileSync(racePaths.coordinatorLock, "utf8"));
    expect(survivingLock.nonce).toBe("a-live-nonce"); // A's live lock is untouched
    fs.unlinkSync(racePaths.coordinatorLock);

    // A dead lock with NO racing rewrite reclaims cleanly (the common case, not just the race).
    fs.writeFileSync(racePaths.coordinatorLock, JSON.stringify(deadOwnerBody));
    const soleExpected = __internal.parseCoordinatorLock(racePaths.coordinatorLock)!;
    expect(() => __internal.reclaimCoordinatorLock(racePaths.coordinatorLock, soleExpected)).not.toThrow();
    expect(fs.existsSync(racePaths.coordinatorLock)).toBe(false);
  });
});

test("W-343: validation is fail-closed — malformed intents, tampered/oversize/path-unsafe records are all rejected, and the fencing epoch never regresses past its safe ceiling", () => {
  withTempProject((root) => {
    const { writeFileSync, mkdirSync, symlinkSync } = require("node:fs") as typeof import("node:fs");
    const pmId = "p";
    const digest = sha256Hex("o");
    const badIntents: Array<[string, Parameters<typeof validateIntent>[0]]> = [
      ["bad sha", { owner_session: "s", base_studio_sha: "not-a-sha", origin_request_digest: digest }],
      ["bad digest", { owner_session: "s", base_studio_sha: "a".repeat(40), origin_request_digest: "short" }],
      ["bad work id", { owner_session: "s", base_studio_sha: "a".repeat(40), origin_request_digest: digest, closure_work_id: "not-a-work-id" }],
      ["deadline too large", { owner_session: "s", base_studio_sha: "a".repeat(40), origin_request_digest: digest, max_deadline_ms: 5 * 60 * 60 * 1000 }],
      ["deadline zero", { owner_session: "s", base_studio_sha: "a".repeat(40), origin_request_digest: digest, max_deadline_ms: 0 }],
      ["too many successor slots", { owner_session: "s", base_studio_sha: "a".repeat(40), origin_request_digest: digest, successor_slots: 999 }],
      ["bad protocol version", { owner_session: "s", base_studio_sha: "a".repeat(40), origin_request_digest: digest, protocol_version: 2 as 1 }],
    ];
    for (const [label, intent] of badIntents) {
      expect(() => validateIntent(intent), label).toThrow();
    }

    const rec = acquireClosure(root, pmId, "b", { owner_session: "s1", base_studio_sha: "a".repeat(40), origin_request_digest: digest });
    const paths = closurePaths(root, pmId);

    // Tamper: hand-edit a field after the digest was computed -> rejected.
    const raw = JSON.parse(require("node:fs").readFileSync(paths.statePath, "utf8"));
    raw.active.owner_session = "hacked";
    expect(() => validateState(raw)).toThrow(/digest does not match/);

    // Oversize state file -> rejected without ever parsing its contents.
    const bigRoot = root + "-big";
    mkdirSync(closurePaths(bigRoot, pmId).root, { recursive: true });
    writeFileSync(closurePaths(bigRoot, pmId).statePath, "x".repeat(MAX_STATE_BYTES + 1));
    expect(() => inspectClosure(bigRoot, pmId)).toThrow(/exceeds/);
    require("node:fs").rmSync(bigRoot, { recursive: true, force: true });

    // A symlinked state.json is refused (path/symlink tampering, Guardian focus item I2).
    //
    // W-343 REWORK N9 (Guardian, non-blocking evidence-quality note): on a
    // Windows host WITHOUT Developer Mode / SeCreateSymbolicLinkPrivilege,
    // `symlinkSync` itself throws EPERM before a link ever exists, so the
    // `toThrow(/regular non-symlink file/)` assertion below never actually
    // executes here and this run still reports green — it does NOT evidence
    // the symlink-rejection dimension on such a host. That is a known,
    // accepted gap in THIS test's platform coverage, not a gap in the
    // reviewed code: `readStableJsonFile`'s `lstat`-before-`open` + dev/ino
    // stability check (this file's sibling `integration_closure.ts`) was
    // independently confirmed TOCTOU-resistant by inspection. Making this
    // assertion unconditionally exercised would need either an elevated/
    // Developer-Mode CI runner or a POSIX runner — out of scope for this
    // change; recorded here per the Guardian gate rather than silently
    // reported as covered.
    const symlinkRoot = root + "-sym";
    const realTarget = symlinkRoot + "-target.json";
    mkdirSync(closurePaths(symlinkRoot, pmId).root, { recursive: true });
    writeFileSync(realTarget, "{}");
    try {
      symlinkSync(realTarget, closurePaths(symlinkRoot, pmId).statePath);
      expect(() => inspectClosure(symlinkRoot, pmId)).toThrow(/regular non-symlink file/);
    } catch (e) {
      if (!/EPERM|not permitted/i.test((e as Error).message)) throw e; // symlink creation needs a privilege this CI host may lack (see note above)
    } finally {
      require("node:fs").rmSync(symlinkRoot, { recursive: true, force: true });
      require("node:fs").rmSync(realTarget, { force: true });
    }

    // Epoch high-watermark fail-closed: hand-craft a state already at the ceiling.
    const exhaustedRoot = root + "-exhausted";
    mkdirSync(closurePaths(exhaustedRoot, pmId).root, { recursive: true });
    writeFileSync(closurePaths(exhaustedRoot, pmId).statePath, JSON.stringify({ schema_version: 1, last_fencing_epoch: MAX_FENCING_EPOCH, last_history_ordinal: 0, last_terminal_digest: null, active: null }));
    expect(() => acquireClosure(exhaustedRoot, pmId, "b", { owner_session: "s", base_studio_sha: "a".repeat(40), origin_request_digest: digest }))
      .toThrow(/fencing epoch exhausted/);
    require("node:fs").rmSync(exhaustedRoot, { recursive: true, force: true });
  });
});
