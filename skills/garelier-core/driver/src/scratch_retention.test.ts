import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SCRATCH_KEEP_DAYS,
  pmScratchDir,
  pruneScratch,
  readScratchKeepDaysConfig,
} from "./scratch_retention.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "scratch-ret-"));
  dirs.push(d);
  return d;
}

/** Write a file and back-date its mtime by `ageDays`. */
function writeAged(dir: string, name: string, body: string, ageDays: number): void {
  const p = join(dir, name);
  writeFileSync(p, body);
  const t = (Date.now() - ageDays * MS_PER_DAY) / 1000;
  utimesSync(p, t, t);
}

describe("readScratchKeepDaysConfig", () => {
  test("default 14 when no config / no [retention] key", () => {
    const root = tmp();
    expect(readScratchKeepDaysConfig(root, "pm")).toBe(DEFAULT_SCRATCH_KEEP_DAYS);
    mkdirSync(join(root, "__garelier", "pm", "_pm"), { recursive: true });
    writeFileSync(join(root, "__garelier", "pm", "_pm", "setup_config.toml"), "[branches]\ntarget = \"main\"\n");
    expect(readScratchKeepDaysConfig(root, "pm")).toBe(14);
  });

  test("reads a configured value; a configured 0 disables (not overridden)", () => {
    const root = tmp();
    const cfg = join(root, "__garelier", "pm", "_pm");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "setup_config.toml"), "[retention]\nscratch_keep_days = 7\n");
    expect(readScratchKeepDaysConfig(root, "pm")).toBe(7);
    writeFileSync(join(cfg, "setup_config.toml"), "[retention]\nscratch_keep_days = 0\n");
    expect(readScratchKeepDaysConfig(root, "pm")).toBe(0);
  });
});

describe("pruneScratch", () => {
  test("dry-run (default) lists old entries but deletes nothing", () => {
    const dir = tmp();
    writeAged(dir, "old.log", "x".repeat(100), 30);
    writeAged(dir, "fresh.log", "y", 1);
    const out = pruneScratch(dir, 14);
    expect(out.apply).toBe(false);
    expect(out.totalBefore).toBe(2);
    expect(out.candidates.map((c) => c.name)).toEqual(["old.log"]);
    expect(out.bytesCandidate).toBe(100);
    expect(out.pruned).toEqual([]);
    expect(out.bytesFreed).toBe(0);
    // Nothing was actually removed.
    expect(existsSync(join(dir, "old.log"))).toBe(true);
    expect(existsSync(join(dir, "fresh.log"))).toBe(true);
  });

  test("apply removes only entries older than the cutoff, keeps fresh ones", () => {
    const dir = tmp();
    writeAged(dir, "old.log", "aaa", 30);
    writeAged(dir, "fresh.log", "bbb", 3);
    const out = pruneScratch(dir, 14, { apply: true });
    expect(out.apply).toBe(true);
    expect(out.pruned).toEqual(["old.log"]);
    expect(out.bytesFreed).toBe(3);
    expect(existsSync(join(dir, "old.log"))).toBe(false);
    expect(existsSync(join(dir, "fresh.log"))).toBe(true);
  });

  test("prunes an old subdirectory recursively and counts its bytes", () => {
    const dir = tmp();
    const sub = join(dir, "run-123");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "a.png"), "1234567890");
    writeFileSync(join(sub, "b.log"), "12345");
    // Back-date the subdir itself so its mtime is past the cutoff.
    const t = (Date.now() - 40 * MS_PER_DAY) / 1000;
    utimesSync(sub, t, t);
    const out = pruneScratch(dir, 14, { apply: true });
    expect(out.pruned).toEqual(["run-123"]);
    expect(out.bytesFreed).toBe(15);
    expect(existsSync(sub)).toBe(false);
  });

  test("no-op when keepDays <= 0 (disabled)", () => {
    const dir = tmp();
    writeAged(dir, "old.log", "x", 90);
    const out = pruneScratch(dir, 0, { apply: true });
    expect(out.candidates).toEqual([]);
    expect(out.pruned).toEqual([]);
    expect(existsSync(join(dir, "old.log"))).toBe(true);
  });

  test("no-op when the scratch dir is absent", () => {
    const dir = tmp();
    const out = pruneScratch(join(dir, "does-not-exist"), 14, { apply: true });
    expect(out.totalBefore).toBe(0);
    expect(out.candidates).toEqual([]);
  });

  test("nowMs override drives the cutoff deterministically", () => {
    const dir = tmp();
    writeAged(dir, "e.log", "z", 10); // 10 days old
    // With a 14-day window it is fresh; advance now by 10 days -> it is 20 days old.
    expect(pruneScratch(dir, 14).candidates).toEqual([]);
    const future = Date.now() + 10 * MS_PER_DAY;
    expect(pruneScratch(dir, 14, { nowMs: future }).candidates.map((c) => c.name)).toEqual(["e.log"]);
  });

  test("pmScratchDir resolves the canonical runtime/pm/scratch path", () => {
    expect(pmScratchDir("/proj", "acme").replace(/\\/g, "/")).toBe(
      "/proj/__garelier/acme/runtime/pm/scratch",
    );
  });
});
