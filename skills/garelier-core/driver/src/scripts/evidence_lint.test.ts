import { rmSync } from "../guard/path_guard.ts";
// W-088 — anti-false-green evidence lint: the four real-harm fixtures RED, a
// valid evidence document green, and the CLI exit-code contract (0 ok / 1
// violation / 2 usage).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lintEvidence,
  lintEvidenceRecord,
  normalizeEvidenceDoc,
  type EvidenceRecord,
  type EvidenceRuleCode,
} from "../dispatch/evidence.ts";

const FIXTURES = join(import.meta.dir, "..", "dispatch", "fixtures", "evidence");
const CLI = join(import.meta.dir, "evidence_lint.ts");

function loadFixture(name: string): EvidenceRecord[] {
  const doc = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
  const records = normalizeEvidenceDoc(doc);
  if (records === null) throw new Error(`${name}.json is not an evidence document`);
  return records;
}

// One fixture per real-harm class, each expected to trip exactly its rule.
const RED_FIXTURES: Array<{ name: string; rule: EvidenceRuleCode; harm: string }> = [
  { name: "w455_swallowed_exit", rule: "pipe-no-exit-propagation", harm: "W-455 swallowed exit" },
  { name: "w480_self_ref_census", rule: "reject-no-negative", harm: "W-480 self-referential census" },
  { name: "w481_literal_golden", rule: "literal-oracle", harm: "W-481 literal golden" },
  { name: "w346_unreachable_registration", rule: "unreachable-claimed-used", harm: "W-346 unreachable registration" },
];

describe("lintEvidence — four false-green fixtures RED", () => {
  for (const { name, rule, harm } of RED_FIXTURES) {
    test(`${harm} fixture (${name}) is a violation via ${rule}`, () => {
      const result = lintEvidence(loadFixture(name));
      expect(result.ok).toBe(false);
      expect(result.violations.map((v) => v.rule)).toContain(rule);
    });
  }

  test("valid evidence document is green", () => {
    const result = lintEvidence(loadFixture("green_valid"));
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.checked).toBe(3);
  });
});

describe("lintEvidenceRecord — rules fire only when the record makes the claim", () => {
  test("literal source that is NOT oracle-grade is fine", () => {
    const rec: EvidenceRecord = { source: "literal", oracle_grade: false };
    expect(lintEvidenceRecord(rec, 0)).toEqual([]);
  });

  test("piped evidence with pipefail is fine; with none is a violation", () => {
    expect(lintEvidenceRecord({ source: "runtime", piped: true, exit_propagation: "pipefail" }, 0)).toEqual([]);
    const bad = lintEvidenceRecord({ source: "runtime", piped: true }, 0);
    expect(bad.map((v) => v.rule)).toEqual(["pipe-no-exit-propagation"]);
  });

  test("non-piped evidence never trips the pipe rule regardless of exit_propagation", () => {
    expect(lintEvidenceRecord({ source: "runtime", piped: false }, 0)).toEqual([]);
    expect(lintEvidenceRecord({ source: "runtime" }, 0)).toEqual([]);
  });

  test("asserts_rejection with a negative_case is fine; without is a violation", () => {
    expect(lintEvidenceRecord({ source: "test", asserts_rejection: true, negative_case: true }, 0)).toEqual([]);
    const bad = lintEvidenceRecord({ source: "test", asserts_rejection: true }, 0);
    expect(bad.map((v) => v.rule)).toEqual(["reject-no-negative"]);
  });

  test("claims_used with a reachable consumer is fine; unreachable is a violation", () => {
    expect(lintEvidenceRecord({ source: "static", claims_used: true, consumer_reachability: true }, 0)).toEqual([]);
    const bad = lintEvidenceRecord({ source: "static", claims_used: true, consumer_reachability: false }, 0);
    expect(bad.map((v) => v.rule)).toEqual(["unreachable-claimed-used"]);
  });

  test("missing / unknown source is a structural violation and short-circuits", () => {
    const missing = lintEvidenceRecord({} as EvidenceRecord, 0);
    expect(missing.map((v) => v.rule)).toEqual(["invalid-source"]);
    const unknown = lintEvidenceRecord({ source: "guess" as EvidenceRecord["source"], oracle_grade: true }, 0);
    expect(unknown.map((v) => v.rule)).toEqual(["invalid-source"]);
  });

  test("a record can trip multiple rules at once", () => {
    const rec: EvidenceRecord = {
      source: "literal",
      oracle_grade: true,
      piped: true,
      exit_propagation: "none",
    };
    const rules = lintEvidenceRecord(rec, 0).map((v) => v.rule).sort();
    expect(rules).toEqual(["literal-oracle", "pipe-no-exit-propagation"]);
  });
});

describe("normalizeEvidenceDoc — accepted shapes", () => {
  test("single record, bare array, and { evidence: [...] } all normalize", () => {
    expect(normalizeEvidenceDoc({ source: "runtime" })).toHaveLength(1);
    expect(normalizeEvidenceDoc([{ source: "runtime" }, { source: "test" }])).toHaveLength(2);
    expect(normalizeEvidenceDoc({ evidence: [{ source: "runtime" }] })).toHaveLength(1);
  });

  test("a non-evidence object is rejected (null)", () => {
    expect(normalizeEvidenceDoc({ hello: "world" })).toBeNull();
    expect(normalizeEvidenceDoc("string")).toBeNull();
    expect(normalizeEvidenceDoc(42)).toBeNull();
  });
});

describe("evidence_lint CLI — exit-code contract", () => {
  function run(args: string[]): { code: number; stdout: string; stderr: string } {
    const r = spawnSync("bun", [CLI, ...args], { windowsHide: true, encoding: "utf8" });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("green fixture exits 0", () => {
    const r = run(["--evidence", join(FIXTURES, "green_valid.json")]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  for (const { name, rule } of RED_FIXTURES) {
    test(`${name} exits 1 (${rule})`, () => {
      const r = run(["--evidence", join(FIXTURES, `${name}.json`)]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout).violations.map((v: { rule: string }) => v.rule)).toContain(rule);
    });
  }

  test("--format text renders a human summary", () => {
    const r = run(["--evidence", join(FIXTURES, "w481_literal_golden.json"), "--format", "text"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("literal-oracle");
  });

  test("missing --evidence exits 2", () => {
    expect(run([]).code).toBe(2);
  });

  test("nonexistent evidence path exits 2", () => {
    expect(run(["--evidence", join(tmpdir(), "does-not-exist-w088.json")]).code).toBe(2);
  });

  test("bad --format exits 2", () => {
    expect(run(["--evidence", join(FIXTURES, "green_valid.json"), "--format", "yaml"]).code).toBe(2);
  });

  test("non-JSON and non-evidence documents exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "w088-"));
    try {
      const notJson = join(dir, "bad.json");
      writeFileSync(notJson, "this is not json {");
      expect(run(["--evidence", notJson]).code).toBe(2);

      const notEvidence = join(dir, "other.json");
      writeFileSync(notEvidence, JSON.stringify({ hello: "world" }));
      expect(run(["--evidence", notEvidence]).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
