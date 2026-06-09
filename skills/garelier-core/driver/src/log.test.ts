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
