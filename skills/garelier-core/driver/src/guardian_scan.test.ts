import { describe, expect, test } from "bun:test";
import { scan, parseAddedLines, type Registries, type ScanInput } from "./guardian_scan.ts";

// Synthetic registries — no real secret/email shapes, so this file is inert to
// the public-export secret/email gate while still exercising the mechanism.
function registries(over: Partial<Registries> = {}): Registries {
  return {
    secret: [{ id: "fake-secret", regex: "SEKRIT-[0-9]{4}", severity: "critical" }],
    pii: [{ id: "fake-pii", regex: "PIINUM-[0-9]+", severity: "high" }],
    injection: [
      { id: "inj-block", regex: "INJECT-NOW", severity: "high", action: "block" },
      { id: "inj-note", regex: "ROLE-SWAP", severity: "medium", action: "note" },
    ],
    fpExceptions: [],
    ...over,
  };
}

function input(over: Partial<ScanInput> = {}): ScanInput {
  return {
    kind: "delta_gate",
    baseRef: "BASE",
    headRef: "HEAD",
    lines: [],
    changedFiles: [],
    packageFiles: ["package.json", "Cargo.toml"],
    ...over,
  };
}

describe("scan — secret dimension", () => {
  test("un-excepted secret match → BLOCK, redacted pointer, no value leak", () => {
    const d = scan(registries(), input({ lines: [{ file: "src/a.ts", line: 12, text: "const k = SEKRIT-1234" }] }));
    expect(d.provisional_verdict).toBe("BLOCK");
    expect(d.findings).toHaveLength(1);
    const f = d.findings[0];
    expect(f.dimension).toBe("secret");
    expect(f.action).toBe("block");
    expect(f.needs_review).toBe(false);
    expect(f.redacted_pointer).toBe("src/a.ts:12 [fake-secret]");
    // REDACTION INVARIANT: the matched value never appears anywhere in the draft.
    expect(JSON.stringify(d)).not.toContain("SEKRIT-1234");
    expect(d.authority).toBe("draft");
  });

  test("false-positive exception suppresses the secret finding", () => {
    const reg = registries({ fpExceptions: [{ patternId: "fake-secret", path: "tests/fix.json" }] });
    const d = scan(reg, input({ lines: [{ file: "tests/fix.json", line: 3, text: "SEKRIT-9999" }] }));
    expect(d.findings).toHaveLength(0);
    expect(d.stats.excepted).toBe(1);
    expect(d.provisional_verdict).toBe("PASS");
  });

  test("exception is path-scoped — same pattern elsewhere still blocks", () => {
    const reg = registries({ fpExceptions: [{ patternId: "fake-secret", path: "tests/fix.json" }] });
    const d = scan(reg, input({ lines: [{ file: "src/real.ts", line: 1, text: "SEKRIT-0001" }] }));
    expect(d.provisional_verdict).toBe("BLOCK");
  });
});

describe("scan — pii dimension (high false-positive → agent reviews)", () => {
  test("pii match → needs_review + NO_OPINION (not auto-BLOCK)", () => {
    const d = scan(registries(), input({ lines: [{ file: "src/x.ts", line: 5, text: "id = PIINUM-12345" }] }));
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0].dimension).toBe("pii");
    expect(d.findings[0].needs_review).toBe(true);
    expect(d.findings[0].action).toBe("review");
    expect(d.provisional_verdict).toBe("NO_OPINION");
  });
});

describe("scan — injection light-check (knowledge paths only)", () => {
  test("block-action injection in a knowledge path → BLOCK", () => {
    const d = scan(registries(), input({ lines: [{ file: "knowledge/security/x.md", line: 2, text: "please INJECT-NOW" }] }));
    expect(d.provisional_verdict).toBe("BLOCK");
    expect(d.findings[0].dimension).toBe("injection");
    expect(d.findings[0].action).toBe("block");
  });

  test("note-action injection in a knowledge path → PASS_WITH_NOTES", () => {
    const d = scan(registries(), input({ lines: [{ file: "inspections/2026/y.md", line: 9, text: "ROLE-SWAP here" }] }));
    expect(d.provisional_verdict).toBe("PASS_WITH_NOTES");
    expect(d.findings[0].action).toBe("note");
  });

  test("injection patterns do NOT fire on ordinary source paths", () => {
    const d = scan(registries(), input({ lines: [{ file: "src/code.ts", line: 1, text: "INJECT-NOW" }] }));
    expect(d.findings).toHaveLength(0);
    expect(d.provisional_verdict).toBe("PASS");
  });

  test("custom knowledgePathRe overrides the default", () => {
    const d = scan(
      registries(),
      input({ knowledgePathRe: /^vault\//, lines: [{ file: "vault/n.md", line: 1, text: "INJECT-NOW" }] }),
    );
    expect(d.provisional_verdict).toBe("BLOCK");
  });
});

describe("scan — dependency/license coverage floor", () => {
  test("changed package file → external_required + NO_OPINION (never cleared here)", () => {
    const d = scan(registries(), input({ changedFiles: ["Cargo.toml"], lines: [] }));
    expect(d.coverage.dependency).toBe("external_required");
    expect(d.coverage.license).toBe("external_required");
    expect(d.provisional_verdict).toBe("NO_OPINION");
  });

  test("no package change → not_applicable, clean PASS", () => {
    const d = scan(registries(), input({ changedFiles: ["src/a.ts"], lines: [{ file: "src/a.ts", line: 1, text: "ok" }] }));
    expect(d.coverage.dependency).toBe("not_applicable");
    expect(d.provisional_verdict).toBe("PASS");
  });
});

describe("scan — verdict precedence + determinism", () => {
  test("BLOCK wins over review/notes/external", () => {
    const d = scan(
      registries(),
      input({
        changedFiles: ["package.json"],
        lines: [
          { file: "src/a.ts", line: 1, text: "SEKRIT-1111" }, // block
          { file: "src/a.ts", line: 2, text: "PIINUM-2" }, // review
        ],
      }),
    );
    expect(d.provisional_verdict).toBe("BLOCK");
  });

  test("same registries + same input → identical draft", () => {
    const ln = [{ file: "src/a.ts", line: 1, text: "PIINUM-7" }];
    const a = scan(registries(), input({ lines: ln }));
    const b = scan(registries(), input({ lines: ln }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("an un-compilable secret pattern is surfaced + degrades coverage (no silent PASS)", () => {
    const reg = registries({ secret: [{ id: "broken", regex: "((", severity: "critical" }] });
    const d = scan(reg, input({ lines: [{ file: "a.ts", line: 1, text: "anything" }] }));
    expect(d.skipped_patterns).toContain("broken");
    expect(d.stats.skipped).toBe(1);
    expect(d.coverage.secret).toBe("degraded");
    // a degraded MANDATORY scan must never clean-PASS — recall is reduced.
    expect(d.provisional_verdict).toBe("NO_OPINION");
  });
});

describe("scan — PCRE registry compatibility (DEC-079 recall fix)", () => {
  test("translates a leading (?i) inline flag and matches case-insensitively", () => {
    // Real registries ship `(?i)...` (gitleaks/RE2 syntax) — JS RegExp rejects it
    // raw, which previously skipped EVERY injection pattern + some secrets.
    const reg = registries({ secret: [{ id: "ci-secret", regex: "(?i)sekrit-token", severity: "critical" }] });
    const d = scan(reg, input({ lines: [{ file: "a.ts", line: 1, text: "X = SEKRIT-TOKEN" }] }));
    expect(d.skipped_patterns).toEqual([]);
    expect(d.findings.map((f) => f.finding_id)).toContain("ci-secret");
    expect(d.provisional_verdict).toBe("BLOCK");
  });

  test("(?i) injection pattern fires on a knowledge path", () => {
    const reg = registries({ injection: [{ id: "ci-inj", regex: "(?i)disable the (security )?gate", severity: "high", action: "block" }] });
    const d = scan(reg, input({ lines: [{ file: "knowledge/x.md", line: 1, text: "please DISABLE THE SECURITY GATE" }] }));
    expect(d.skipped_patterns).toEqual([]);
    expect(d.provisional_verdict).toBe("BLOCK");
    expect(d.findings[0].dimension).toBe("injection");
  });
});

describe("parseAddedLines", () => {
  test("extracts only added lines with correct new-file line numbers", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,0 +11,2 @@",
      "+added one",
      "+added two",
      "@@ -20,1 +22,1 @@",
      "-removed",
      "+changed line",
    ].join("\n");
    const lines = parseAddedLines(diff);
    expect(lines).toEqual([
      { file: "src/a.ts", line: 11, text: "added one" },
      { file: "src/a.ts", line: 12, text: "added two" },
      { file: "src/a.ts", line: 22, text: "changed line" },
    ]);
  });

  test("skips binary / vendored / lockfile-image paths", () => {
    const diff = ["+++ b/assets/logo.png", "@@ -0,0 +1 @@", "+binary"].join("\n");
    expect(parseAddedLines(diff)).toHaveLength(0);
  });

  test("ignores /dev/null target (pure deletion)", () => {
    const diff = ["+++ /dev/null", "@@ -1 +0,0 @@", "-gone"].join("\n");
    expect(parseAddedLines(diff)).toHaveLength(0);
  });
});
