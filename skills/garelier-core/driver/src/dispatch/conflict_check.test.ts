import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globOverlap,
  overlappingPairs,
  parseCsvList,
  computeConflicts,
  computeUnmetDeps,
  buildTouchMap,
  buildWarning,
  scanActiveDispatches,
  runCheck,
  type ActiveDispatch,
} from "./conflict_check.ts";

describe("globOverlap (heuristic — false-positive leaning)", () => {
  // [a, b, expected] table (W-053 gate: 10+ cases; prefix / basename / no-overlap).
  const cases: Array<[string, string, boolean]> = [
    // identical paths overlap
    ["core/mid/stage_transition.rs", "core/mid/stage_transition.rs", true],
    // directory glob contains a concrete file under it (prefix rule)
    ["src/**", "src/foo.rs", true],
    ["src/", "src/deep/nested/x.rs", true],
    // same concrete basename in different dirs, one via ** (basename rule) —
    // the W-073/W-074 stage_transition.rs collision shape
    ["**/stage_transition.rs", "core/engine/stage_transition.rs", true],
    // trailing slash / ./ normalization still overlaps
    ["./src/a.rs", "src/a.rs", true],
    // Windows backslashes normalize before comparison
    ["src\\ui\\hud.rs", "src/ui/**", true],
    // match-all overlaps anything
    ["**", "totally/unrelated/path.rs", true],
    // NO overlap: sibling files in the same dir (W-051/W-056 file-separation shape)
    ["core/supply/mod.rs", "core/loop/strengthen.rs", false],
    ["src/a.rs", "src/b.rs", false],
    // NO overlap: prefix must be at a path-segment boundary, not a substring
    ["src/foo", "src/foobar/x.rs", false],
    // NO overlap: distinct concrete basenames under a shared ancestor
    ["core/ui/hud.rs", "core/ui/menu.rs", false],
    // wildcard basenames alone do NOT overlap (would make every .rs collide)
    ["a/*.rs", "b/*.rs", false],
    // empty / whitespace declarations never overlap
    ["   ", "src/a.rs", false],
  ];
  for (const [a, b, expected] of cases) {
    test(`${a} vs ${b} -> ${expected}`, () => {
      expect(globOverlap(a, b)).toBe(expected);
      expect(globOverlap(b, a)).toBe(expected); // symmetric
    });
  }
});

describe("overlappingPairs", () => {
  test("reports the specific colliding declarations, deduped", () => {
    const pairs = overlappingPairs(["src/**", "docs/x.md"], ["src/a.rs", "src/b.rs"]);
    expect(pairs).toEqual(["src/** ~ src/a.rs", "src/** ~ src/b.rs"]);
  });
  test("identical path shows once without the ~ form", () => {
    expect(overlappingPairs(["src/a.rs"], ["src/a.rs"])).toEqual(["src/a.rs"]);
  });
  test("no overlap -> empty", () => {
    expect(overlappingPairs(["a.rs"], ["b.rs"])).toEqual([]);
  });
});

describe("parseCsvList", () => {
  test("trims, drops empties", () => {
    expect(parseCsvList(" a , ,b,c ")).toEqual(["a", "b", "c"]);
  });
  test("null/empty -> []", () => {
    expect(parseCsvList(null)).toEqual([]);
    expect(parseCsvList("")).toEqual([]);
    expect(parseCsvList(undefined)).toEqual([]);
  });
});

const active: ActiveDispatch[] = [
  { dispatch: "1", slug: "recipe-filter", state: "WORKING", touches: ["core/recipe/**"], depends_on: [] },
  { dispatch: "2", slug: "supply-fix", state: "REPORTING", touches: ["core/supply/mod.rs"], depends_on: [] },
  { dispatch: "3", slug: "stage-a", state: "WORKING", touches: ["core/engine/stage_transition.rs"], depends_on: [] },
];

describe("computeConflicts", () => {
  test("flags an overlapping active dispatch and lists the pairs", () => {
    const c = computeConflicts(["**/stage_transition.rs"], active);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ dispatch: "3", slug: "stage-a", state: "WORKING" });
    expect(c[0].overlapping.length).toBeGreaterThan(0);
  });
  test("excludes self by id", () => {
    expect(computeConflicts(["core/recipe/x.rs"], active, "1")).toEqual([]);
  });
  test("no declared touches -> no conflicts", () => {
    expect(computeConflicts([], active)).toEqual([]);
  });
  test("non-overlapping touches -> no conflicts", () => {
    expect(computeConflicts(["docs/only.md"], active)).toEqual([]);
  });
});

describe("computeUnmetDeps", () => {
  test("depends_on a still-in-flight dispatch by #id is unmet", () => {
    const u = computeUnmetDeps(["#3"], active);
    expect(u).toEqual([{ dep: "#3", dispatch: "3", slug: "stage-a", state: "WORKING" }]);
  });
  test("depends_on by slug matches too", () => {
    expect(computeUnmetDeps(["supply-fix"], active)[0].dispatch).toBe("2");
  });
  test("depends_on an absent (cleaned-up) dispatch is met -> not reported", () => {
    expect(computeUnmetDeps(["#99", "never-dispatched"], active)).toEqual([]);
  });
});

describe("buildTouchMap", () => {
  test("computes pairwise conflicts_with across active dispatches", () => {
    const overlapping: ActiveDispatch[] = [
      { dispatch: "1", slug: "a", state: "WORKING", touches: ["core/x.rs"], depends_on: [] },
      { dispatch: "2", slug: "b", state: "WORKING", touches: ["core/**"], depends_on: ["#1"] },
      { dispatch: "3", slug: "c", state: "WORKING", touches: ["docs/y.md"], depends_on: [] },
    ];
    const map = buildTouchMap(overlapping);
    expect(map.find((m) => m.dispatch === "1")?.conflicts_with).toEqual(["2"]);
    expect(map.find((m) => m.dispatch === "2")?.conflicts_with).toEqual(["1"]);
    expect(map.find((m) => m.dispatch === "3")?.conflicts_with).toEqual([]);
  });
});

describe("buildWarning", () => {
  test("empty when clean", () => {
    expect(buildWarning([], [])).toBe("");
  });
  test("single-line, quote-free, and mentions --allow-conflict", () => {
    const w = buildWarning(
      [{ dispatch: "3", slug: "stage-a", state: "WORKING", overlapping: ["a ~ b"] }],
      [{ dep: "#2", dispatch: "2", slug: "supply-fix", state: "REPORTING" }],
    );
    expect(w).not.toContain('"');
    expect(w).not.toContain("\n");
    expect(w).toContain("--allow-conflict");
    expect(w).toContain("#3");
    expect(w).toContain("#2");
  });
});

describe("scanActiveDispatches + runCheck (filesystem)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "conflict-check-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeDispatch(n: number, slug: string, status: string, touches: string[], dependsOn: string[] = []): void {
    const c = join(root, `_dispatch${n}`);
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, "STATE.md"), `# Dispatch #${n}\n\n## Status\n\n${status}\n`);
    writeFileSync(
      join(c, "context.json"),
      JSON.stringify({ task: { slug, touches, depends_on: dependsOn } }),
    );
  }

  test("reads slug/state/touches/depends_on from each container", () => {
    writeDispatch(1, "a", "WORKING", ["src/**"], ["#0"]);
    writeDispatch(2, "b", "REPORTING", ["docs/x.md"]);
    const scanned = scanActiveDispatches(root);
    expect(scanned).toHaveLength(2);
    expect(scanned[0]).toMatchObject({ dispatch: "1", slug: "a", state: "WORKING", touches: ["src/**"], depends_on: ["#0"] });
    expect(scanned[1]).toMatchObject({ dispatch: "2", slug: "b", state: "REPORTING" });
  });

  test("runCheck finds an overlap against an on-disk active dispatch, excluding self", () => {
    writeDispatch(1, "a", "WORKING", ["core/engine/stage_transition.rs"]);
    writeDispatch(2, "self", "WORKING", ["**/stage_transition.rs"]);
    const r = runCheck(root, ["**/stage_transition.rs"], [], "2");
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].dispatch).toBe("1");
    expect(r.warning).toContain("--allow-conflict");
  });

  test("runCheck is clean (no warning) when nothing overlaps", () => {
    writeDispatch(1, "a", "WORKING", ["core/engine/stage_transition.rs"]);
    const r = runCheck(root, ["docs/only.md"], [], null);
    expect(r.conflicts).toEqual([]);
    expect(r.unmet_deps).toEqual([]);
    expect(r.warning).toBe("");
  });

  test("missing pm-root -> empty scan (best-effort)", () => {
    expect(scanActiveDispatches(join(root, "nope"))).toEqual([]);
  });
});
