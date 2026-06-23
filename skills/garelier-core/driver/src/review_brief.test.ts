import { describe, expect, test } from "bun:test";
import {
  buildReviewBrief,
  parseNameStatus,
  parseNumstat,
  mergeEntries,
  parseGate,
  type BriefInput,
  type DiffEntry,
} from "./review_brief.ts";

function input(over: Partial<BriefInput> = {}): BriefInput {
  return {
    role: "observer",
    scope: { base_ref: "BASE", head_ref: "HEAD", review_sha: "sha1" },
    entries: [],
    claims: null,
    protectedGlobs: ["migrations/**", ".github/workflows/**"],
    packageBasenames: ["package.json", "Cargo.toml"],
    largeDiffLines: 400,
    gate: null,
    ...over,
  };
}
function e(path: string, status: DiffEntry["status"], added = 0, deleted = 0): DiffEntry {
  return { path, status, added, deleted, binary: false };
}

describe("buildReviewBrief — diffstat + flags", () => {
  test("aggregates churn and flags files (no code content)", () => {
    const b = buildReviewBrief(
      input({
        entries: [e("src/a.ts", "M", 10, 4), e("Cargo.toml", "M", 2, 1), e("migrations/001.sql", "A", 30, 0)],
      }),
    );
    expect(b.diffstat).toEqual({ files: 3, added: 42, deleted: 5, churn: 47 });
    expect(b.files.find((f) => f.path === "Cargo.toml")!.flags).toContain("manifest");
    const mig = b.files.find((f) => f.path === "migrations/001.sql")!;
    expect(mig.flags).toContain("protected"); // migrations/** glob
    expect(mig.flags).toContain("migration"); // .sql / migrations path
    expect(b.signals.touches_manifest).toBe(true);
    expect(b.signals.touches_protected).toBe(true);
    expect(b.advisory).toBe(true);
    // No code content embedded — the brief is structural.
    expect(JSON.stringify(b)).not.toContain("function");
  });

  test("large_diff signal trips at threshold", () => {
    const small = buildReviewBrief(input({ entries: [e("a.ts", "M", 100, 50)], largeDiffLines: 400 }));
    expect(small.signals.large_diff).toBe(false);
    const big = buildReviewBrief(input({ entries: [e("a.ts", "M", 300, 200)], largeDiffLines: 400 }));
    expect(big.signals.large_diff).toBe(true);
  });

  test("source_changed_without_tests signal", () => {
    const noTests = buildReviewBrief(input({ entries: [e("src/a.ts", "M", 5, 0)] }));
    expect(noTests.signals.source_changed_without_tests).toBe(true);
    const withTests = buildReviewBrief(input({ entries: [e("src/a.ts", "M", 5, 0), e("src/a.test.ts", "A", 9, 0)] }));
    expect(withTests.signals.source_changed_without_tests).toBe(false);
    expect(withTests.files.find((f) => f.path === "src/a.test.ts")!.flags).toContain("test");
  });
});

describe("buildReviewBrief — diff-vs-report match", () => {
  test("flags undisclosed and claimed-absent files", () => {
    const b = buildReviewBrief(
      input({
        entries: [e("src/a.ts", "M", 1, 0), e("src/secret.ts", "A", 5, 0)],
        claims: { files_changed: ["src/a.ts", "src/ghost.ts"] },
      }),
    );
    expect(b.report_match).toEqual({
      undisclosed: ["src/secret.ts"], // in diff, not claimed
      claimed_absent: ["src/ghost.ts"], // claimed, not in diff
    });
  });

  test("null when report has no files_changed", () => {
    const b = buildReviewBrief(input({ entries: [e("a.ts", "M", 1, 0)], claims: { summary: "x" } }));
    expect(b.report_match).toBeNull();
  });

  test("clean match → empty arrays", () => {
    const b = buildReviewBrief(input({ entries: [e("a.ts", "M", 1, 0)], claims: { files_changed: ["a.ts"] } }));
    expect(b.report_match).toEqual({ undisclosed: [], claimed_absent: [] });
  });
});

describe("parseNameStatus", () => {
  test("A/M/D + rename → new path with status R", () => {
    const txt = ["A\tsrc/new.ts", "M\tsrc/mod.ts", "D\tsrc/gone.ts", "R096\tsrc/old.ts\tsrc/renamed.ts"].join("\n");
    expect(parseNameStatus(txt)).toEqual([
      { status: "A", path: "src/new.ts" },
      { status: "M", path: "src/mod.ts" },
      { status: "D", path: "src/gone.ts" },
      { status: "R", path: "src/renamed.ts" },
    ]);
  });
});

describe("parseNumstat", () => {
  test("counts + binary detection", () => {
    const txt = ["10\t4\tsrc/a.ts", "-\t-\tassets/logo.png"].join("\n");
    const m = parseNumstat(txt);
    expect(m.get("src/a.ts")).toEqual({ added: 10, deleted: 4, binary: false });
    expect(m.get("assets/logo.png")).toEqual({ added: 0, deleted: 0, binary: true });
  });
  test("rename `{old => new}` resolves to new path", () => {
    const m = parseNumstat("3\t1\tsrc/{old.ts => new.ts}");
    expect(m.get("src/new.ts")).toEqual({ added: 3, deleted: 1, binary: false });
  });
});

describe("mergeEntries", () => {
  test("joins status with churn; missing numstat → zeros", () => {
    const ns = [{ status: "M" as const, path: "a.ts" }, { status: "A" as const, path: "b.ts" }];
    const num = new Map([["a.ts", { added: 5, deleted: 2, binary: false }]]);
    expect(mergeEntries(ns, num)).toEqual([
      { path: "a.ts", status: "M", added: 5, deleted: 2, binary: false },
      { path: "b.ts", status: "A", added: 0, deleted: 0, binary: false },
    ]);
  });
});

describe("parseGate (best-effort orientation)", () => {
  test("failure markers → fail", () => {
    expect(parseGate("running\nFAIL: dispatch smoke\nmore").result).toBe("fail");
    expect(parseGate("error: boom").result).toBe("fail");
  });
  test("success marker, no failures → pass", () => {
    expect(parseGate("CI: all checks passed\n359 pass").result).toBe("pass");
  });
  test("'0 fail' is not a failure", () => {
    expect(parseGate("359 pass\n0 fail").result).toBe("pass");
  });
  test("ambiguous → unknown", () => {
    expect(parseGate("some neutral output").result).toBe("unknown");
  });
});
