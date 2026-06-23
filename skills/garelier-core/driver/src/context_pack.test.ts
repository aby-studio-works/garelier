import { describe, expect, test } from "bun:test";
import { buildFactPack, deriveTargetSlug, parseQualityGate, parseAnchors } from "./context_pack.ts";

describe("deriveTargetSlug (the guardrail — computed once, not re-parsed)", () => {
  test("explicit slug wins", () => {
    expect(deriveTargetSlug("develop/soft", "develop-soft")).toBe("develop-soft");
  });
  test("derives by replacing '/' with '-'", () => {
    expect(deriveTargetSlug("develop/soft", null)).toBe("develop-soft");
    expect(deriveTargetSlug("main", null)).toBe("main");
  });
  test("null target → null", () => {
    expect(deriveTargetSlug(null, null)).toBeNull();
    expect(deriveTargetSlug(null, "  ")).toBeNull();
  });
});

describe("parseQualityGate", () => {
  test("full from [quality_gate.full].commands; fast falls back to full", () => {
    const qg = parseQualityGate({ stack: "rust", full: { commands: ["cargo test"] }, timeout_minutes_per_cmd: 30 });
    expect(qg.stack).toBe("rust");
    expect(qg.full).toEqual(["cargo test"]);
    expect(qg.fast).toEqual(["cargo test"]);
    expect(qg.timeout_minutes_per_cmd).toBe(30);
  });
  test("legacy top-level `commands` is the alias for full", () => {
    const qg = parseQualityGate({ commands: ["npm test"] });
    expect(qg.full).toEqual(["npm test"]);
    expect(qg.fast).toEqual(["npm test"]);
  });
  test("explicit fast overrides; run_verify captured", () => {
    const qg = parseQualityGate({
      commands: ["npm test"],
      fast: { commands: ["npm run quick"] },
      run_verify_commands: ["npm run smoke"],
    });
    expect(qg.full).toEqual(["npm test"]);
    expect(qg.fast).toEqual(["npm run quick"]);
    expect(qg.run_verify).toEqual(["npm run smoke"]);
  });
  test("empty / missing → empty arrays, null stack/timeout", () => {
    const qg = parseQualityGate(undefined);
    expect(qg.full).toEqual([]);
    expect(qg.fast).toEqual([]);
    expect(qg.run_verify).toEqual([]);
    expect(qg.stack).toBeNull();
    expect(qg.timeout_minutes_per_cmd).toBeNull();
  });
});

describe("parseAnchors (blueprint Context pack, DEC-071)", () => {
  const bp = [
    "# Blueprint",
    "## Goal",
    "do a thing",
    "## Context pack",
    "- Entry points: src/a.ts:42 — the handler",
    "- Invariants: the queue stays FIFO",
    "- Local verify: bun test src/a.test.ts",
    "## Functional requirements",
    "- stuff",
  ].join("\n");

  test("extracts the three anchors and marks filled", () => {
    const a = parseAnchors(bp, "BP.md");
    expect(a.entry_points).toBe("src/a.ts:42 — the handler");
    expect(a.invariants).toBe("the queue stays FIFO");
    expect(a.local_verify).toBe("bun test src/a.test.ts");
    expect(a.filled).toBe(true);
    expect(a.source).toBe("BP.md");
  });

  test("unfilled {{placeholder}} counts as missing", () => {
    const md = ["## Context pack", "- Entry points: {{path}}", "- Invariants: real invariant", "## Next"].join("\n");
    const a = parseAnchors(md, null);
    expect(a.entry_points).toBeNull();
    expect(a.invariants).toBe("real invariant");
    expect(a.filled).toBe(true); // invariants is filled
  });

  test("no Context pack section → all null, filled false", () => {
    const a = parseAnchors("# Blueprint\n## Goal\nx\n", null);
    expect(a.entry_points).toBeNull();
    expect(a.invariants).toBeNull();
    expect(a.local_verify).toBeNull();
    expect(a.filled).toBe(false);
  });

  test("Context pack as the LAST section (no following heading) still parses", () => {
    const md = ["## Goal", "g", "## Context pack", "- Entry points: only/path.ts"].join("\n");
    const a = parseAnchors(md, null);
    expect(a.entry_points).toBe("only/path.ts");
  });
});

describe("buildFactPack", () => {
  const config = {
    branches: { target: "develop/soft", target_slug: "develop-soft", integration: "garelier/develop-soft/pm/studio" },
    quality_gate: { stack: "rust", commands: ["cargo test"], timeout_minutes_per_cmd: 60 },
  };

  test("assembles project facts + task + gate; advisory flag set", () => {
    const p = buildFactPack({
      pmId: "pm",
      projectRoot: "/proj",
      integration: "garelier/develop-soft/pm/studio",
      config,
      task: { id: 7, role: "worker", slug: "do-x", branch: "garelier/develop-soft/pm/workbench/#7/do-x", base_sha: "abc123" },
    });
    expect(p.advisory).toBe(true);
    expect(p.kind).toBe("dispatch_fact_pack");
    expect(p.project.target).toBe("develop/soft");
    expect(p.project.target_slug).toBe("develop-soft");
    expect(p.project.target_branch).toBe("develop/soft");
    expect(p.project.integration_branch).toBe("garelier/develop-soft/pm/studio");
    expect(p.quality_gate.full).toEqual(["cargo test"]);
    expect(p.task.id).toBe(7);
    expect(p.task.base_branch).toBe("garelier/develop-soft/pm/studio"); // defaults to integration
    expect(p.task.base_sha).toBe("abc123");
  });

  test("explicit --integration wins over config", () => {
    const p = buildFactPack({ pmId: "pm", projectRoot: "/p", integration: "OVERRIDE/studio", config });
    expect(p.project.integration_branch).toBe("OVERRIDE/studio");
  });

  test("fail-open: null config → unknown facts, no throw, advisory note present", () => {
    const p = buildFactPack({ pmId: "pm", projectRoot: "/p", config: null });
    expect(p.project.target).toBeNull();
    expect(p.project.target_slug).toBeNull();
    expect(p.quality_gate.full).toEqual([]);
    expect(p.anchors.filled).toBe(false);
    expect(p.note).toContain("advisory");
  });

  test("derives target_slug when config omits it", () => {
    const p = buildFactPack({
      pmId: "pm",
      projectRoot: "/p",
      config: { branches: { target: "release/2.0" } },
    });
    expect(p.project.target_slug).toBe("release-2.0");
  });
});
