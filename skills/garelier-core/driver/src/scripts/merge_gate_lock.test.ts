// W-175: unit tests for the merge-gate active-lock classifier (dead-pid reclaim f
// + no-silent-exit reason g). Pure function, mock liveness — no real gate spawn.

import { test, expect } from "bun:test";
import { classifyActiveLock, shouldRepollStalledGate, ownsActiveLock } from "./merge_gate_lock.ts";

const ALIVE = () => true;
const DEAD = () => false;

test("no existing lock → create", () => {
  const v = classifyActiveLock(null, "100", "req-a", ALIVE);
  expect(v.action).toBe("create");
});

test("same pid (driver adopted) → proceed", () => {
  const v = classifyActiveLock({ pid: "100", request_id: "req-a" }, "100", "req-a", DEAD);
  expect(v.action).toBe("proceed");
  expect(v.reason).toContain("adopted");
});

test("same request, different LIVE pid → second runner (W-076)", () => {
  const v = classifyActiveLock({ pid: "200", request_id: "req-a" }, "100", "req-a", ALIVE);
  expect(v.action).toBe("second");
  expect(v.reason).toContain("W-076");
});

test("same request, different DEAD pid → reclaim (W-175 f)", () => {
  const v = classifyActiveLock({ pid: "200", request_id: "req-a" }, "100", "req-a", DEAD);
  expect(v.action).toBe("reclaim");
  expect(v.reason).toContain("DEAD pid 200");
});

test("different request, LIVE holder → different (queue serialization)", () => {
  const v = classifyActiveLock({ pid: "200", request_id: "req-b" }, "100", "req-a", ALIVE);
  expect(v.action).toBe("different");
  expect(v.reason).toContain("queue serialization");
});

test("different request, DEAD holder → reclaim so the queue drains (W-175 f)", () => {
  const v = classifyActiveLock({ pid: "200", request_id: "req-b" }, "100", "req-a", DEAD);
  expect(v.action).toBe("reclaim");
  expect(v.reason).toContain("queue drains");
});

test("different request with an EMPTY pid keeps the conservative exit (no reclaim on an unprovable owner)", () => {
  const v = classifyActiveLock({ pid: "", request_id: "req-b" }, "100", "req-a", DEAD);
  expect(v.action).toBe("different");
});

test("ambiguous lock (no request_id) → proceed (fail-open)", () => {
  const v = classifyActiveLock({ pid: "", request_id: "" }, "100", "req-a", DEAD);
  expect(v.action).toBe("proceed");
  expect(v.reason).toContain("fail-open");
});

test("shouldRepollStalledGate: re-poll only when no result AND no live runner (W-175 b)", () => {
  expect(shouldRepollStalledGate(false, false)).toBe(true);   // no result, dead/absent lock → re-spawn
  expect(shouldRepollStalledGate(false, true)).toBe(false);   // a live runner is working → keep waiting
  expect(shouldRepollStalledGate(true, false)).toBe(false);   // result already landed → done
  expect(shouldRepollStalledGate(true, true)).toBe(false);
});

test("W-175 R1: concurrent reclaim — after both write, only the last writer owns the lock", () => {
  // Two runners (req-a pid 100, req-b pid 200) both reclaim the same dead lock;
  // req-b's write lands last, so the lock reads {req-b, 200}. The winner owns it,
  // the loser (req-a) does not → backs off. Exactly one proceeds to the merge.
  const lockNow = { request_id: "req-b", pid: "200" };
  expect(ownsActiveLock(lockNow.request_id, lockNow.pid, "req-b", "200")).toBe(true);  // winner
  expect(ownsActiveLock(lockNow.request_id, lockNow.pid, "req-a", "100")).toBe(false); // loser backs off
});

test("W-175 R1: ownsActiveLock matches by request_id, with pid as a tiebreaker", () => {
  expect(ownsActiveLock("req-a", "100", "req-a", "100")).toBe(true);
  expect(ownsActiveLock("req-a", "", "req-a", "100")).toBe(true);   // unknown lock pid → request_id decides
  expect(ownsActiveLock("req-a", "100", "req-a", "")).toBe(true);   // unknown my pid → request_id decides
  expect(ownsActiveLock("req-a", "100", "req-a", "999")).toBe(false); // same request, DIFFERENT pid → not mine
  expect(ownsActiveLock("req-a", "100", "req-b", "100")).toBe(false); // different request
  expect(ownsActiveLock("", "", "", "")).toBe(false);               // empty request never owns
});

test("every verdict carries a non-empty reason (no silent exit, W-175 g)", () => {
  const cases = [
    classifyActiveLock(null, "1", "a", ALIVE),
    classifyActiveLock({ pid: "2", request_id: "a" }, "1", "a", ALIVE),
    classifyActiveLock({ pid: "2", request_id: "a" }, "1", "a", DEAD),
    classifyActiveLock({ pid: "2", request_id: "b" }, "1", "a", ALIVE),
    classifyActiveLock({ pid: "2", request_id: "b" }, "1", "a", DEAD),
  ];
  for (const c of cases) expect(c.reason.length).toBeGreaterThan(0);
});
