// DEC-057: dispatch-activity aggregation tests (readDispatchActivity).
// Pure file read — no provider, no mutation. Verifies the in-progress derivation
// from role STATE, the newest-first event log (capped at 20), the "showing N of
// M" total, corrupt-line tolerance, and the empty/missing-file safe zeros.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDispatchActivity } from "./status_snapshot.ts";
import type { RoleInfo } from "./status_types.ts";

function role(kind: string, id: string | null, state: string, task: string | null = null): RoleInfo {
  return {
    kind: kind as RoleInfo["kind"], id, provider: null, model: null,
    state, branch: null, task, warnings: [],
  };
}

function runtimeWithEvents(content: string | unknown[] | null): string {
  const runtime = mkdtempSync(join(tmpdir(), "gar-disp-"));
  if (content != null) {
    const dir = join(runtime, "dispatch");
    mkdirSync(dir, { recursive: true });
    const body = typeof content === "string"
      ? content
      : content.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(join(dir, "events.jsonl"), body, "utf8");
  }
  return runtime;
}

describe("readDispatchActivity (DEC-057)", () => {
  test("no events file + idle roles → empty, safe zeros", () => {
    const runtime = runtimeWithEvents(null);
    const d = readDispatchActivity(runtime, [role("worker", "worker-01", "IDLE")]);
    expect(d.inProgress).toEqual([]);
    expect(d.recent).toEqual([]);
    expect(d.eventsTotal).toBe(0);
  });

  test("in-progress = roles with an active dispatch state (case-insensitive)", () => {
    const runtime = runtimeWithEvents(null);
    const roles = [
      role("worker", "worker-01", "working", "#12 fix flake"),
      role("scout", "scout-01", "IDLE"),
      role("smith", "smith-01", "BLOCKED", "#9 hardening"),
      role("dock", null, "WORKING"),         // no id → excluded
      role("artisan", "artisan", "REPORTING"),
    ];
    const d = readDispatchActivity(runtime, roles);
    expect(d.inProgress).toEqual([
      { role: "worker-01", state: "WORKING", task: "#12 fix flake" },
      { role: "smith-01", state: "BLOCKED", task: "#9 hardening" },
      { role: "artisan", state: "REPORTING", task: null },
    ]);
  });

  test("recent events are newest-first and tolerate corrupt lines", () => {
    const runtime = runtimeWithEvents(
      [
        JSON.stringify({ ts: "2026-06-08T01:00:00Z", role: "worker-01", kind: "start", task: "#12", ref: null }),
        "not-json{",
        JSON.stringify({ ts: "2026-06-08T02:00:00Z", role: "worker-01", kind: "complete", task: "#12", ref: "runtime/worker/worker-01/report.md" }),
      ].join("\n") + "\n",
    );
    const d = readDispatchActivity(runtime, []);
    expect(d.eventsTotal).toBe(3); // raw non-empty line count (incl. the corrupt one)
    expect(d.recent.map((e) => e.kind)).toEqual(["complete", "start"]); // corrupt line dropped from display, newest first
    expect(d.recent[0]).toMatchObject({ role: "worker-01", kind: "complete", ref: "runtime/worker/worker-01/report.md" });
  });

  test("caps recent at the newest 20 while reporting the full total", () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      ({ ts: `2026-06-08T00:${String(i).padStart(2, "0")}:00Z`, role: "worker-01", kind: "note", task: `t${i}`, ref: null }));
    const runtime = runtimeWithEvents(events);
    const d = readDispatchActivity(runtime, []);
    expect(d.eventsTotal).toBe(25);
    expect(d.recent.length).toBe(20);
    // newest first → t24 leads, the slice kept t5..t24
    expect(d.recent[0].task).toBe("t24");
    expect(d.recent[d.recent.length - 1].task).toBe("t5");
  });

  test("missing fields degrade to safe defaults", () => {
    const runtime = runtimeWithEvents([{ role: "scout-01" }]);
    const d = readDispatchActivity(runtime, []);
    expect(d.recent[0]).toEqual({ ts: null, role: "scout-01", kind: "note", task: null, ref: null });
  });
});
