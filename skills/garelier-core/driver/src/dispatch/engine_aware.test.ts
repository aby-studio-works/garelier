import { describe, test, expect } from "bun:test";
import {
  RESOURCE_CLASSES,
  RUNTIME_EFFECTS,
  DEFAULT_RESOURCE_CLASS,
  DEFAULT_RUNTIME_EFFECT,
  normalizeResourceClass,
  normalizeRuntimeEffect,
  heavyAdmission,
  classifyHeavyAcquire,
  checkCloseContract,
  runtimeEffectDemandsRunArtifact,
  resolveReachability,
  type ReachabilityItem,
} from "./engine_aware.ts";

// W-087: the pure core of engine-aware dispatch. These pin (1) the closed
// vocabulary + back-compat normalizer for the two required assignment fields,
// (2) the heavy admission gate (the "heavy 同時起動 0" invariant), and (3) the
// close-contract checker (the W-484 "row green・到達構成未完" close refusal + the
// visual-without-verdict refusal).

// ── Part 1: schema vocabulary + normalize ────────────────────────────────────
describe("resource_class / runtime_effect vocabulary", () => {
  test("closed sets are exactly the row's vocabulary", () => {
    expect([...RESOURCE_CLASSES]).toEqual(["heavy", "light", "data", "review"]);
    expect([...RUNTIME_EFFECTS]).toEqual(["none", "headless", "visual", "aural", "input"]);
  });
});

describe("normalizeResourceClass", () => {
  test("a valid value passes through, not defaulted, no warning", () => {
    expect(normalizeResourceClass("heavy")).toEqual({ value: "heavy", defaulted: false, warning: null });
    expect(normalizeResourceClass("review")).toEqual({ value: "review", defaulted: false, warning: null });
  });
  test("unspecified (null/empty) defaults to light WITH a warning (back-compat)", () => {
    for (const raw of [null, undefined, "", "   "]) {
      const r = normalizeResourceClass(raw);
      expect(r.value).toBe(DEFAULT_RESOURCE_CLASS);
      expect(r.defaulted).toBe(true);
      expect(r.warning).toContain("unspecified");
    }
  });
  test("an unknown token defaults to light WITH a warning (never silently accepted)", () => {
    const r = normalizeResourceClass("gigantic");
    expect(r.value).toBe("light");
    expect(r.defaulted).toBe(true);
    expect(r.warning).toContain("not one of");
  });
  test("surrounding whitespace is trimmed before matching", () => {
    expect(normalizeResourceClass("  heavy  ").value).toBe("heavy");
  });
});

describe("normalizeRuntimeEffect", () => {
  test("valid values pass through", () => {
    for (const v of RUNTIME_EFFECTS) {
      expect(normalizeRuntimeEffect(v)).toEqual({ value: v, defaulted: false, warning: null });
    }
  });
  test("unspecified defaults to none WITH a warning", () => {
    const r = normalizeRuntimeEffect("");
    expect(r.value).toBe(DEFAULT_RUNTIME_EFFECT);
    expect(r.defaulted).toBe(true);
    expect(r.warning).toContain("unspecified");
  });
  test("an unknown token defaults to none WITH a warning", () => {
    const r = normalizeRuntimeEffect("holographic");
    expect(r.value).toBe("none");
    expect(r.warning).toContain("not one of");
  });
});

// ── Part 2: heavy admission gate ─────────────────────────────────────────────
describe("heavyAdmission — the heavy 同時起動 0 invariant", () => {
  test("a non-heavy class never needs a slot", () => {
    for (const rc of ["light", "data", "review"] as const) {
      expect(heavyAdmission({ resourceClass: rc, activeHeavyHolders: 5 }).state).toBe("not-heavy");
    }
  });
  test("the FIRST heavy (0 holders) is admitted", () => {
    expect(heavyAdmission({ resourceClass: "heavy", activeHeavyHolders: 0 }).state).toBe("admitted");
  });
  test("a 2nd heavy while one slot is held is QUEUED — 0 concurrent heavy starts", () => {
    // The core invariant: with the default single machine-wide slot, a 2nd heavy
    // dispatch can NEVER be admitted while the first is held.
    const r = heavyAdmission({ resourceClass: "heavy", activeHeavyHolders: 1, maxHeavySlots: 1 });
    expect(r.state).toBe("queued");
    expect(r.reason).toContain("do NOT start a 2nd concurrent heavy");
  });
  test("maxHeavySlots is floored at 1 (a 0/negative config never opens the gate wide)", () => {
    expect(heavyAdmission({ resourceClass: "heavy", activeHeavyHolders: 1, maxHeavySlots: 0 }).state).toBe("queued");
    expect(heavyAdmission({ resourceClass: "heavy", activeHeavyHolders: 0, maxHeavySlots: 0 }).state).toBe("admitted");
  });
});

describe("classifyHeavyAcquire — mapping heavy_compile_lock output for a dispatch", () => {
  test("a real slot token is admitted", () => {
    const r = classifyHeavyAcquire("/main/__garelier/pm/runtime/locks/heavy_compile/slot-0", false);
    expect(r.state).toBe("admitted");
    expect(r.reason).toContain("slot-0");
  });
  test("OPEN is ABORTED even when an older caller labels it timed-out", () => {
    expect(classifyHeavyAcquire("OPEN", true).state).toBe("aborted");
  });
  test("OPEN/empty is ABORTED; only explicit DISABLED bypasses serialization", () => {
    expect(classifyHeavyAcquire("OPEN", false).state).toBe("aborted");
    expect(classifyHeavyAcquire("", false).state).toBe("aborted");
    expect(classifyHeavyAcquire("DISABLED", false).state).toBe("admitted");
  });
});

// ── Part 3: close-contract 照合 ──────────────────────────────────────────────
describe("runtimeEffectDemandsRunArtifact", () => {
  test("only `none` skips the RUN artifact requirement", () => {
    expect(runtimeEffectDemandsRunArtifact("none")).toBe(false);
    for (const rt of ["headless", "visual", "aural", "input"] as const) {
      expect(runtimeEffectDemandsRunArtifact(rt)).toBe(true);
    }
  });
});

describe("checkCloseContract", () => {
  test("a fully satisfied close passes (all constructs landed, artifact present)", () => {
    const r = checkCloseContract({
      runtimeEffect: "headless",
      reachability: [
        { kind: "crate", name: "acme_engine_aware", present: true },
        { kind: "consumer", name: "register_engine_aware", present: true },
      ],
      runArtifactPresent: true,
      visualVerdictPointer: null,
    });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  // THE W-484 FIXTURE: row green (functional AC met), but a named 到達構成 crate
  // never landed — close must be REFUSED (the false-done class §2-10).
  test("W-484: row green but a named crate did not land -> close REFUSED", () => {
    const r = checkCloseContract({
      runtimeEffect: "none",
      reachability: [
        { kind: "crate", name: "acme_extracted_crate", present: false }, // the unmet extraction
        { kind: "consumer", name: "wired_consumer", present: true },
      ],
      runArtifactPresent: null,
      visualVerdictPointer: null,
    });
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].rule).toBe("unreachable-construct");
    expect(r.violations[0].subject).toBe("acme_extracted_crate");
    expect(r.violations[0].detail).toContain("W-484");
  });

  test("W-484 variant: a named consumer is unreachable (grep found nothing) -> refused", () => {
    const r = checkCloseContract({
      runtimeEffect: "none",
      reachability: [{ kind: "consumer", name: "dead_registration", present: false }],
      runArtifactPresent: null,
      visualVerdictPointer: null,
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0].rule).toBe("unreachable-construct");
  });

  test("a headless task with no RUN artifact is refused", () => {
    const r = checkCloseContract({
      runtimeEffect: "headless",
      reachability: [],
      runArtifactPresent: false,
      visualVerdictPointer: null,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toEqual(["run-artifact-missing"]);
  });

  // A visual task with no screenshot / user-verdict pointer fires BOTH the
  // run-artifact and the visual-verdict rule — screenshotless visual never closes.
  test("a visual task with no screenshot / user-verdict pointer is refused", () => {
    const r = checkCloseContract({
      runtimeEffect: "visual",
      reachability: [],
      runArtifactPresent: false,
      visualVerdictPointer: null,
    });
    expect(r.ok).toBe(false);
    const rules = r.violations.map((v) => v.rule).sort();
    expect(rules).toContain("visual-no-verdict");
    expect(rules).toContain("run-artifact-missing");
  });

  test("a visual task WITH a screenshot pointer + run artifact closes", () => {
    const r = checkCloseContract({
      runtimeEffect: "visual",
      reachability: [],
      runArtifactPresent: true,
      visualVerdictPointer: "runtime/run/shot-001.png",
    });
    expect(r.ok).toBe(true);
  });

  test("an empty/whitespace visual pointer does not satisfy the verdict rule", () => {
    const r = checkCloseContract({
      runtimeEffect: "visual",
      reachability: [],
      runArtifactPresent: true,
      visualVerdictPointer: "   ",
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("visual-no-verdict");
  });

  test("a data/none task with all constructs landed closes with no RUN requirement", () => {
    const r = checkCloseContract({
      runtimeEffect: "none",
      reachability: [{ kind: "artifact", name: "generated/index.json", present: true }],
      runArtifactPresent: null,
      visualVerdictPointer: null,
    });
    expect(r.ok).toBe(true);
  });
});

describe("resolveReachability seam", () => {
  test("crate/artifact resolve via exists, consumer via grep", () => {
    const q = {
      exists: (name: string) => name === "present_crate",
      grep: (name: string) => name === "wired_symbol",
    };
    const decls = [
      { kind: "crate" as const, name: "present_crate" },
      { kind: "crate" as const, name: "absent_crate" },
      { kind: "consumer" as const, name: "wired_symbol" },
      { kind: "consumer" as const, name: "dead_symbol" },
    ];
    const out: ReachabilityItem[] = resolveReachability(decls, q);
    expect(out).toEqual([
      { kind: "crate", name: "present_crate", present: true },
      { kind: "crate", name: "absent_crate", present: false },
      { kind: "consumer", name: "wired_symbol", present: true },
      { kind: "consumer", name: "dead_symbol", present: false },
    ]);
  });
});
