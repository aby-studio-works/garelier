// Output Control (DEC-028) pure-function tests.

import { describe, expect, test } from "bun:test";
import {
  roleOutputPolicy,
  buildOutputDirective,
  buildAuthoringDirective,
  summarizeProviderResult,
  checkOutputBudget,
  DEFAULT_OUTPUT_CONTROL,
  type OutputControlConfig,
} from "./output_control.ts";

describe("buildAuthoringDirective (DEC-049 — language + terse two-tier)", () => {
  test("ja + terse: forces Japanese prose, preserves machine tokens, terse read-first + complete full", () => {
    const d = buildAuthoringDirective("ja", true);
    expect(d).toContain("Japanese");
    expect(d).toContain("VERBATIM");          // machine tokens preserved
    expect(d).toContain("report.json");        // the terse read-first surface
    expect(d).toMatch(/TERSE/);
    expect(d).toMatch(/FULL form/);
    expect(d).toContain("pointer");            // reference, never paste bodies
  });
  test("auto + not terse → empty (legacy behavior, no forcing)", () => {
    expect(buildAuthoringDirective("auto", false)).toBe("");
  });
  test("en without terse → English prose, no terse clauses", () => {
    const d = buildAuthoringDirective("en", false);
    expect(d).toContain("English");
    expect(d).not.toMatch(/TERSE/);
  });
  test("auto + terse → terse clauses only, no language clause", () => {
    const d = buildAuthoringDirective("auto", true);
    expect(d).toMatch(/TERSE/);
    expect(d).not.toContain("Japanese");
    expect(d).not.toContain("English");
  });
  test("default config is ja-agnostic (auto) but terse-on (cost-favoring)", () => {
    expect(DEFAULT_OUTPUT_CONTROL.language).toBe("auto");
    expect(DEFAULT_OUTPUT_CONTROL.terse).toBe(true);
  });
});

describe("roleOutputPolicy", () => {
  test("resolves a role's override profile", () => {
    const p = roleOutputPolicy(DEFAULT_OUTPUT_CONTROL, "scout");
    expect(p.profile).toBe("micro");
    expect(p.softResultChars).toBe(500);
  });
  test("guardian/concierge default to normal (safety not pressured short)", () => {
    expect(roleOutputPolicy(DEFAULT_OUTPUT_CONTROL, "guardian").profile).toBe("normal");
    expect(roleOutputPolicy(DEFAULT_OUTPUT_CONTROL, "concierge").profile).toBe("normal");
    expect(roleOutputPolicy(DEFAULT_OUTPUT_CONTROL, "concierge").softResultChars).toBe(1600);
  });
  test("falls back to defaultProfile for an unmapped role", () => {
    const cfg: OutputControlConfig = { ...DEFAULT_OUTPUT_CONTROL, roles: {} };
    expect(roleOutputPolicy(cfg, "worker").profile).toBe(cfg.defaultProfile);
  });
});

describe("buildOutputDirective", () => {
  test("micro guidance is 1-3 lines / pointer-first", () => {
    const text = buildOutputDirective(roleOutputPolicy(DEFAULT_OUTPUT_CONTROL, "scout"));
    expect(text).toContain("1-3 lines");
    expect(text).toContain("read: pointer");
  });
  test("never asks to abbreviate code/paths/SHAs or hide risks", () => {
    const text = buildOutputDirective(roleOutputPolicy(DEFAULT_OUTPUT_CONTROL, "worker"));
    expect(text).toContain("Do not abbreviate code symbols, file paths, commands, URLs, error text, dates, numbers, or commit SHAs");
    expect(text).toContain("Do not hide risks, blockers, warnings, required approvals, or responsibility boundaries");
  });
  test("includes the role's soft budget", () => {
    const text = buildOutputDirective(roleOutputPolicy(DEFAULT_OUTPUT_CONTROL, "pm"));
    expect(text).toContain("1600");
  });
});

describe("summarizeProviderResult", () => {
  test("undefined for empty / whitespace", () => {
    expect(summarizeProviderResult(undefined, 600)).toBeUndefined();
    expect(summarizeProviderResult("   \n ", 600)).toBeUndefined();
  });
  test("returns the full trimmed text when within the cap", () => {
    expect(summarizeProviderResult("  hello  ", 600)).toBe("hello");
  });
  test("truncates with a [+N chars] marker when over the cap", () => {
    const long = "x".repeat(1000);
    const out = summarizeProviderResult(long, 600)!;
    expect(out.startsWith("x".repeat(600))).toBe(true);
    expect(out).toContain("[+400 chars");
    expect(out.length).toBeLessThan(long.length + 80);
  });
});

describe("checkOutputBudget", () => {
  const policy = roleOutputPolicy(DEFAULT_OUTPUT_CONTROL, "scout"); // soft 500
  test("under budget", () => {
    const r = checkOutputBudget("short", policy);
    expect(r.overBudget).toBe(false);
    expect(r.resultChars).toBe(5);
  });
  test("over budget", () => {
    const r = checkOutputBudget("y".repeat(600), policy);
    expect(r.overBudget).toBe(true);
    expect(r.softResultChars).toBe(500);
  });
  test("undefined result is 0 chars, not over budget", () => {
    expect(checkOutputBudget(undefined, policy).overBudget).toBe(false);
  });
});
