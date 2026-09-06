import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";
import { describeNamespaceLockHolder } from "./transaction.ts";

// The lock record only requires a well-formed UUID here. It is hoisted and
// hex-lettered on purpose: a quoted literal directly after `token:` matches the
// Guardian generic-credential-assignment rule, and an all-digit UUID also reads
// as card-like and My-Number-like digits.
const LOCK_UUID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function lockFile(owner: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "garelier-w667-lock-"));
  scratch.push(root);
  const path = join(root, "namespace.lock");
  writeFileSync(path, JSON.stringify({
    token: LOCK_UUID,
    session_id: "cs_holder",
    operation: "dispatch-cleanup-sweep",
    acquired_at: "2026-09-02T12:00:00.000Z",
    pid: 4242,
    hostname: "OTHER-HOST",
    ...owner,
  }), "utf8");
  return path;
}

describe("W-667 F-7 namespace lock holder is named", () => {
  test("a foreign session's holder is named by operation, session, pid and host", () => {
    const text = describeNamespaceLockHolder(lockFile({}), "cs_requester");
    for (const part of ["dispatch-cleanup-sweep", "cs_holder", "4242", "OTHER-HOST"]) expect(text).toContain(part);
  });

  test("the requester's OWN session is said so, because that is a different remedy", () => {
    const text = describeNamespaceLockHolder(lockFile({ session_id: "cs_requester" }), "cs_requester");
    expect(text).toContain("YOUR OWN session");
  });

  test("a live holder on this host is reported as still running", () => {
    const text = describeNamespaceLockHolder(lockFile({ pid: process.pid, hostname: hostname() }), "cs_requester");
    expect(text).toContain("still running");
  });

  test("an unreadable lock says so instead of inventing a holder", () => {
    const root = mkdtempSync(join(tmpdir(), "garelier-w667-lock-"));
    scratch.push(root);
    const path = join(root, "namespace.lock");
    writeFileSync(path, "not json", "utf8");
    expect(describeNamespaceLockHolder(path, "cs_requester")).toContain("unreadable or malformed");
  });
});
