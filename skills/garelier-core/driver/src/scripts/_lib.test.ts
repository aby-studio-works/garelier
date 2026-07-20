import { rmSync } from "../guard/path_guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerSpawnEpoch, jsonEscape, pmCandidates, readTomlQuoted, readTomlScalar, readTomlStringArray, shellQuote, utcCompact, withinSpawnGrace } from "./_lib.ts";

let temp = "";
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

describe("script compatibility helpers", () => {
  test("JSON escaping matches the shell helpers", () => {
    expect(jsonEscape('a\\b"c\nnext')).toBe('a\\\\b\\"c\\nnext');
  });

  test("reads the shell scripts' intentionally narrow TOML shapes", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-script-lib-"));
    const path = join(temp, "setup_config.toml");
    writeFileSync(path,
      '[branches]\nintegration = "garelier/main/tpm/studio"\n' +
      '[merge_gate]\ngate_ceiling_minutes = 12 # bounded\n' +
      'preflight_commands = ["echo one", "echo two"]\n');
    expect(readTomlQuoted(path, "integration")).toBe("garelier/main/tpm/studio");
    expect(readTomlScalar(path, "merge_gate", "gate_ceiling_minutes")).toBe("12");
    expect(readTomlStringArray(path, "preflight_commands")).toEqual(["echo one", "echo two"]);
  });

  test("UTC request prefix keeps the legacy second-resolution form", () => {
    expect(utcCompact(new Date("2026-07-16T09:08:07Z"))).toBe("20260716-090807");
  });

  test("shell quoting preserves both legacy serialization styles", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote("echo", "printf-q")).toBe("echo");
    expect(shellQuote("status hello", "printf-q")).toBe("status\\ hello");
  });

  test("PM candidates recognize both setup and control-only namespaces", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-script-lib-"));
    mkdirSync(join(temp, "zeta", "_pm"), { recursive: true });
    writeFileSync(join(temp, "zeta", "_pm", "setup_config.toml"), "");
    mkdirSync(join(temp, "alpha", "control"), { recursive: true });
    writeFileSync(join(temp, "alpha", "control", "control.toml"), "");
    mkdirSync(join(temp, "ignored"), { recursive: true });
    expect(pmCandidates(temp)).toEqual(["alpha", "zeta"]);
  });
});

describe("W-143 spawn/resume grace", () => {
  test("containerSpawnEpoch reads the LATER of dispatched_at / resumed_at, null when absent", () => {
    // Injectable reader keyed off the marker filename (containerSpawnEpoch resolve()s
    // the path, so match on the basename — no temp files needed).
    const c = "/c/container";
    const both = (p: string) => (/dispatched_at$/.test(p) ? "1700\n" : /resumed_at$/.test(p) ? "1900\n" : null);
    const dispatchedOnly = (p: string) => (/dispatched_at$/.test(p) ? "1700 (dispatched)" : null);
    const garbage = (p: string) => (/dispatched_at$/.test(p) ? "not-a-number" : null);
    // no markers -> null (a legacy/test container is NEVER in grace)
    expect(containerSpawnEpoch(c, { read: () => null })).toBeNull();
    // resumed_at (later) wins when both present
    expect(containerSpawnEpoch(c, { read: both })).toBe(1900);
    // resumed_at absent -> dispatched_at (leading int parsed out of trailing prose)
    expect(containerSpawnEpoch(c, { read: dispatchedOnly })).toBe(1700);
    // unparseable content -> null for that marker
    expect(containerSpawnEpoch(c, { read: garbage })).toBeNull();
    // empty container path -> null
    expect(containerSpawnEpoch("", { read: both })).toBeNull();
  });

  test("withinSpawnGrace: fresh anchor is inside, old anchor is out, null/0 disable it", () => {
    const now = 10_000;
    expect(withinSpawnGrace(now - 100, now, 600)).toBe(true);   // 100s < 600s grace
    expect(withinSpawnGrace(now - 700, now, 600)).toBe(false);  // 700s >= grace -> fires
    expect(withinSpawnGrace(now, now, 600)).toBe(true);         // just spawned
    expect(withinSpawnGrace(null, now, 600)).toBe(false);       // no marker -> never in grace
    expect(withinSpawnGrace(now - 100, now, 0)).toBe(false);    // grace disabled -> legacy fire
  });
});
