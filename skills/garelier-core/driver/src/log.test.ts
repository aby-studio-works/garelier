// Logger size-based rotation (DEC-028).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "./log.ts";

describe("Logger rotation", () => {
  test("rolls the active file once it passes maxBytes and keeps N files", () => {
    const dir = mkdtempSync(join(tmpdir(), "symph-log-"));
    try {
      const path = join(dir, "driver.jsonl");
      // maxBytes tiny so a single record trips rotation on the NEXT emit.
      const log = new Logger("driver", path, { maxBytes: 50, keepFiles: 2 });

      log.info("e1", { n: 1 }); // file created, < 50 bytes? a record is > 50 bytes
      // First emit rotates nothing (no file yet at emit start). After it, the file
      // exists and likely already exceeds 50 bytes, so the next emit rotates.
      log.info("e2", { n: 2 });
      log.info("e3", { n: 3 });

      // Active file exists; at least one rotated file exists.
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.1`)).toBe(true);

      // keepFiles = 2 → never more than .1 and .2.
      expect(existsSync(`${path}.3`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no rotation config => unbounded append (legacy behavior)", () => {
    const dir = mkdtempSync(join(tmpdir(), "symph-log-"));
    try {
      const path = join(dir, "driver.jsonl");
      const log = new Logger("driver", path); // no rotation
      for (let i = 0; i < 20; i++) log.info("e", { n: i });
      expect(existsSync(`${path}.1`)).toBe(false);
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("child inherits rotation from the parent logger", () => {
    const dir = mkdtempSync(join(tmpdir(), "symph-log-"));
    try {
      const parentPath = join(dir, "driver.jsonl");
      const parent = new Logger("driver", parentPath, { maxBytes: 40, keepFiles: 3 });
      const childPath = join(dir, "worker.jsonl");
      const child = parent.child("worker", childPath);
      child.info("a", { x: 1 });
      child.info("b", { x: 2 });
      child.info("c", { x: 3 });
      expect(existsSync(`${childPath}.1`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maxBytes <= 0 disables rotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "symph-log-"));
    try {
      const path = join(dir, "driver.jsonl");
      const log = new Logger("driver", path, { maxBytes: 0, keepFiles: 5 });
      for (let i = 0; i < 30; i++) log.info("e", { n: i });
      expect(existsSync(`${path}.1`)).toBe(false);
      expect(statSync(path).size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// W-091: the human-readable line MUST go to stderr, never stdout — stdout is
// reserved for a CLI's machine JSON (dock_merge poll, contract_check, …). A log
// line on stdout produced `<logline>\n{json}`, which broke JSON.parse (mis-read
// "no gate spawned", defeated the W-086 waiter_cmd splice). Pin the stream so the
// pollution cannot silently return.
describe("Logger stream separation (W-091)", () => {
  function capture(fn: () => void): { out: string[]; err: string[] } {
    const out: string[] = [], err: string[] = [];
    const origLog = console.log, origErr = console.error;
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
    try { fn(); } finally { console.log = origLog; console.error = origErr; }
    return { out, err };
  }

  test("info/warn/error human lines go to stderr and NEVER stdout", () => {
    const { out, err } = capture(() => {
      const log = new Logger("dock-merge"); // no jsonlPath → human line only
      log.info("merge_gate_spawned", { pid: 123 });
      log.warn("merge_gate_subprocess_died", { pid: 456 });
      log.error("merge_gate_spawn_failed", { error: "boom" });
    });
    expect(out).toHaveLength(0); // stdout is untouched — safe for a CLI's JSON
    expect(err.some((l) => l.includes("merge_gate_spawned") && l.includes("pid=123"))).toBe(true);
    expect(err.some((l) => l.includes("[WARN]") && l.includes("merge_gate_subprocess_died"))).toBe(true);
    expect(err.some((l) => l.includes("[ERROR]") && l.includes("merge_gate_spawn_failed"))).toBe(true);
  });

  test("a CLI can print machine JSON to stdout alongside a log line without polluting it", () => {
    const { out, err } = capture(() => {
      const log = new Logger("dock-merge");
      log.info("merge_gate_spawned", { pid: 999 });        // → stderr
      console.log(JSON.stringify({ spawned: "req-1" }));    // → stdout (the CLI output)
    });
    expect(out).toHaveLength(1);
    expect(() => JSON.parse(out[0])).not.toThrow();          // stdout is a single clean JSON line
    expect(JSON.parse(out[0])).toMatchObject({ spawned: "req-1" });
    expect(err.some((l) => l.includes("merge_gate_spawned"))).toBe(true);
  });
});
