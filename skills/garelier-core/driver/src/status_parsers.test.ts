import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePipeTables, columnIndex, cell } from "./md_tables.ts";
import { parseMilestones, buildOverview } from "./status_overview.ts";
import { buildQueue } from "./status_queue.ts";
import { buildKnowledge } from "./status_knowledge.ts";
import { buildControl } from "./status_control.ts";
import { buildKnowledgeGraph } from "./status_knowledge_graph.ts";
import { files as kgFiles } from "./status_knowledge_graph.ts";
import { filesUnder as ctlFilesUnder } from "./status_control.ts";

const PM = "pm";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(): string { const r = mkdtempSync(join(tmpdir(), "symphparse-")); dirs.push(r); return r; }
function write(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

describe("md_tables", () => {
  test("extracts header + rows; ignores prose between tables", () => {
    const md = [
      "# Title", "", "| A | B |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |", "",
      "some prose", "", "| X | Y |", "|---|---|", "| z | w |",
    ].join("\n");
    const t = parsePipeTables(md);
    expect(t).toHaveLength(2);
    expect(t[0].header).toEqual(["A", "B"]);
    expect(t[0].rows).toEqual([["1", "2"], ["3", "4"]]);
    expect(t[1].rows).toEqual([["z", "w"]]);
  });
  test("columnIndex + cell address by name, tolerate reorder", () => {
    const t = parsePipeTables("| Task | Role |\n|---|---|\n| #11 | worker |").at(0)!;
    const cols = columnIndex(t.header);
    expect(cell(t.rows[0], cols, "role")).toBe("worker");
    expect(cell(t.rows[0], cols, "task")).toBe("#11");
    expect(cell(t.rows[0], cols, "missing")).toBe("");
  });
  test("no table → empty", () => {
    expect(parsePipeTables("just text\nno pipes")).toHaveLength(0);
  });
  test("single-column table is recognized; bare --- is not a separator", () => {
    const t = parsePipeTables("| col |\n| --- |\n| v |\n| w |");
    expect(t).toHaveLength(1);
    expect(t[0].header).toEqual(["col"]);
    expect(t[0].rows).toEqual([["v"], ["w"]]);
    // a "header" followed by a bare horizontal rule must NOT form a table
    expect(parsePipeTables("| x |\n---\n| y |")).toHaveLength(0);
  });
});

describe("parseMilestones", () => {
  const manifest = [
    "# Runtime Manifest", "", "## Active milestones", "",
    "### Milestone: m1-hp-p0-closure ✅",
    "- Started: 2026-05-24",
    "- Progress: 1/1 phases (5 blueprints, 5 dispatched, 5 merged) ✅",
    "", "#### Phases",
    "- [x] Phase 1: HP-P0 complete",
    "", "### Milestone: m3-hp-p2-closure",
    "- Progress: 0/1 phases (5 blueprints, 2 dispatched, 0 merged)",
    "#### Phases",
    "- [ ] Phase 1: in progress",
    "- [x] Phase 0: scaffolding",
  ].join("\n");
  test("captures closed flag, progress, and phase checklist", () => {
    const ms = parseMilestones(manifest);
    expect(ms).toHaveLength(2);
    expect(ms[0].name).toBe("m1-hp-p0-closure");
    expect(ms[0].closed).toBe(true);
    expect(ms[0].progress).toContain("1/1 phases");
    expect(ms[0].phases).toEqual([{ done: true, title: "Phase 1: HP-P0 complete" }]);
    expect(ms[1].name).toBe("m3-hp-p2-closure");
    expect(ms[1].closed).toBe(false);
    expect(ms[1].phases).toEqual([
      { done: false, title: "Phase 1: in progress" },
      { done: true, title: "Phase 0: scaffolding" },
    ]);
  });
  test("empty manifest → no milestones", () => {
    expect(parseMilestones("")).toHaveLength(0);
  });
});

describe("buildOverview", () => {
  test("milestones, blueprint list, backlog counts, dashboard link", () => {
    const root = tmp();
    const pm = `__garelier/${PM}`;
    write(root, `${pm}/runtime/manifest.md`,
      "## Active milestones\n\n### Milestone: m1 ✅\n- Progress: 1/1 phases\n#### Phases\n- [x] done\n");
    write(root, `${pm}/control/blueprints/hp-p2-1.md`, "# Lockless chunk loader\nbody");
    write(root, `${pm}/control/blueprints/hp-p2-2.md`, "# Streaming residency\nbody");
    write(root, `${pm}/runtime/backlog/pending.md`,
      "| Order | Task |\n| - | - |\n| 07 | #13 |\n| 08 | #14 |\n");
    write(root, `${pm}/runtime/backlog/in_flight.md`,
      "| Task | Agent |\n| - | - |\n| #11 | a |\n");
    write(root, `${pm}/runtime/backlog/next_id`, "25");
    write(root, `${pm}/runtime/backlog/done/x.md`, "done");
    write(root, `${pm}/control/project_dashboard/roadmap.md`, "x".repeat(300 * 1024));

    const ov = buildOverview(root, PM, null);
    expect(ov.present).toBe(true);
    expect(ov.milestones).toHaveLength(1);
    expect(ov.blueprints.map((b) => b.name)).toEqual(["hp-p2-1", "hp-p2-2"]);
    expect(ov.blueprints[0].title).toBe("Lockless chunk loader");
    expect(ov.blueprints[0].rel).toBe(`${pm}/control/blueprints/hp-p2-1.md`);
    expect(ov.backlog).toMatchObject({ pending: 2, inFlight: 1, done: 1, nextId: 25 });
    const rm = ov.dashboards.find((d) => d.name === "roadmap");
    expect(rm?.tooLargeToInline).toBe(true);
  });
});

describe("buildQueue", () => {
  test("parses in_flight/pending, role from agent, tiers + capacity", () => {
    const root = tmp();
    const pm = `__garelier/${PM}`;
    write(root, `${pm}/runtime/backlog/in_flight.md`, [
      "| Task | Agent             | Blueprint   | Milestone | Branch | Dispatched |",
      "| ---- | ----------------- | ----------- | --------- | ------ | ---------- |",
      "| #11  | worker-01 (Worker) | hp-p2-1     | m3        | br/11  | 2026-05-27 |",
      "| #12  | worker-02 (Worker) | hp-p2-2     | m3        | br/12  | 2026-05-27 |",
    ].join("\n"));
    write(root, `${pm}/runtime/backlog/pending.md`, [
      "| Order | Task | Blueprint | Milestone | Role   | Depends on |",
      "| ----- | ---- | --------- | --------- | ------ | ---------- |",
      "| 09    | #15  | hp-p2-5   | m3        | worker | —          |",
      "| 07    | #13  | hp-p2-3   | m3        | worker | —          |",
      "| 11    | #16  | phase-r4  | m4        | worker | —          |",
    ].join("\n"));
    write(root, `${pm}/runtime/manifest.md`, [
      "## Active milestones",
      "",
      "### Milestone: m2 ✅",
      "- Progress: 1/1 phases",
      "",
      "### Milestone: m3",
      "- Progress: 1/3 phases",
    ].join("\n"));
    write(root, `${pm}/runtime/backlog/next_id`, "17");
    const config = { workers: [{ id: "worker-01" }, { id: "worker-02" }] } as never;
    const q = buildQueue(root, PM, config);
    expect(q.present).toBe(true);
    expect(q.inFlight).toHaveLength(2);
    expect(q.inFlight[0]).toMatchObject({ task: "#11", agent: "worker-01", role: "worker", milestone: "m3" });
    expect(q.pending.map((p) => p.task)).toEqual(["#13", "#15", "#16"]); // sorted by Order 07,09,11
    expect(q.pending[0].order).toBe("07");
    expect(q.activeMilestone).toBe("m3");
    expect(q.activeMilestones).toEqual(["m3"]);
    expect(q.activePending.map((p) => p.task)).toEqual(["#13", "#15"]);
    expect(q.futurePending.map((p) => p.task)).toEqual(["#16"]);
    // tiers: m3 has 2 in-flight + 2 pending; m4 has 1 pending → m3 first.
    expect(q.tiers[0].name).toBe("m3");
    expect(q.tiers[0]).toMatchObject({ inFlight: 2, pending: 2 });
  });
  test("no backlog → present false", () => {
    expect(buildQueue(tmp(), PM, null).present).toBe(false);
  });
  test("all open manifest milestones are dispatchable; later milestones stay future", () => {
    const root = tmp();
    const pm = `__garelier/${PM}`;
    write(root, `${pm}/runtime/backlog/pending.md`, [
      "| Order | Task | Blueprint | Milestone | Role   | Depends on |",
      "| ----- | ---- | --------- | --------- | ------ | ---------- |",
      "| 01    | #13  | hp-p2-3   | m3        | worker | —          |",
      "| 02    | #16  | phase-r4  | m4        | worker | —          |",
      "| 03    | #19  | future-x  | m5        | worker | —          |",
    ].join("\n"));
    write(root, `${pm}/runtime/manifest.md`, [
      "## Active milestones",
      "",
      "### Milestone: m2 ✅",
      "- Progress: 1/1 phases",
      "",
      "### Milestone: m3",
      "- Progress: 1/3 phases",
      "",
      "### Milestone: m4",
      "- Progress: 0/2 phases",
    ].join("\n"));

    const q = buildQueue(root, PM, null);
    expect(q.activeMilestones).toEqual(["m3", "m4"]);
    expect(q.activePending.map((p) => p.task)).toEqual(["#13", "#16"]);
    expect(q.futurePending.map((p) => p.task)).toEqual(["#19"]);
  });
  test("role-only agent cell '(Worker)' parses to role with null agent", () => {
    const root = tmp();
    const pm = `__garelier/${PM}`;
    write(root, `${pm}/runtime/backlog/in_flight.md`, [
      "| Task | Agent     | Blueprint | Milestone |",
      "| ---- | --------- | --------- | --------- |",
      "| #11  | (Worker)  | hp-p2-1   | m3        |",
    ].join("\n"));
    const q = buildQueue(root, PM, null);
    expect(q.inFlight[0].role).toBe("worker");
    expect(q.inFlight[0].agent).toBeNull();
  });
});

describe("buildKnowledge", () => {
  test("categorizes docs/garelier trees, index first, canonical order", () => {
    const root = tmp();
    write(root, "docs/garelier/knowledge/role_index.toml", [
      "schema_version = 1",
      "",
      "[roles.worker]",
      'read_first = ["docs/garelier/engineering/index.md"]',
      'on_demand = ["docs/garelier/engineering/debugging_principles.md", "docs/garelier/system/index.md"]',
      'note = "Implementation + local quality gate."',
      "",
      "[roles.artisan]",
      'union_of = ["worker", "smith"]',
      'read_first = ["docs/garelier/security/index.md"]',
      "on_demand = []",
    ].join("\n"));
    write(root, "docs/garelier/knowledge/source_registry.toml", "[source]");
    write(root, "docs/garelier/engineering/index.md", "# Engineering index");
    write(root, "docs/garelier/engineering/debugging_principles.md", "# Debugging");
    write(root, "docs/garelier/security/index.md", "# Security index");
    write(root, "docs/garelier/security/registries/cve.md", "# CVE"); // nested
    write(root, "docs/garelier/security/registries/secret_patterns.toml", "[pattern]");

    // local-only working area (DEC-038)
    write(root, `__garelier/${PM}/runtime/librarian/drafts/d1.md`, "draft");
    write(root, `__garelier/${PM}/runtime/librarian/raw/page.html`, "<html>");

    const k = buildKnowledge(root, PM);
    expect(k.present).toBe(true);
    expect(k.categories.map((c) => c.category)).toEqual(["knowledge", "engineering", "security"]);
    expect(k.local).toMatchObject({ raw: 1, cache: 0, drafts: 1 });
    expect(k.roleIndex.present).toBe(true);
    expect(k.roleIndex.rel).toBe("docs/garelier/knowledge/role_index.toml");
    const worker = k.roleIndex.roles.find((r) => r.role === "worker")!;
    expect(worker.readFirst.map((d) => d.rel)).toEqual(["docs/garelier/engineering/index.md"]);
    expect(worker.onDemand.map((d) => d.rel)).toEqual(["docs/garelier/engineering/debugging_principles.md"]);
    expect(worker.missing).toEqual(["docs/garelier/system/index.md"]);
    expect(worker.note).toBe("Implementation + local quality gate.");
    const artisan = k.roleIndex.roles.find((r) => r.role === "artisan")!;
    expect(artisan.unionOf).toEqual(["worker", "smith"]);
    const knowledge = k.categories[0];
    expect(knowledge.docs[0].name).toBe("role_index.toml");
    expect(knowledge.docs.some((d) => d.name === "source_registry.toml")).toBe(true);
    const eng = k.categories[1];
    expect(eng.docs[0].name).toBe("index.md");          // index first
    expect(eng.indexRel).toBe("docs/garelier/engineering/index.md");
    expect(eng.docs[0].title).toBe("Engineering index");
    // nested file is collected
    const sec = k.categories[2];
    expect(sec.docs.some((d) => d.rel.endsWith("registries/cve.md"))).toBe(true);
    expect(sec.docs.some((d) => d.rel.endsWith("registries/secret_patterns.toml"))).toBe(true);
  });
  test("no docs/garelier → present false", () => {
    expect(buildKnowledge(tmp()).present).toBe(false);
  });
});

describe("buildControl", () => {
  test("builds canonical artifact graph and validates a clean control tree", () => {
    const root = tmp();
    const ctl = `__garelier/${PM}/control`;
    write(root, `${ctl}/control.toml`, [
      "schema_version = 1",
      'kind = "garelier_control"',
      `pm_id = "${PM}"`,
      'mode = "full"',
    ].join("\n"));
    for (const name of ["README", "current", "roadmap", "backlog", "decisions", "risks", "quality_gates", "notes"]) {
      write(root, `${ctl}/project_dashboard/${name}.md`, `# ${name}\n`);
    }
    write(root, `${ctl}/milestones/m1.md`, [
      "# Milestone: First",
      "## Identity",
      "- Slug: `m1`",
      "- Status: active",
      "- Started: 2026-06-07",
      "- Target: -",
      "- Shipped: -",
      "## Description",
      "x",
      "## Success criteria",
      "1. x",
      "## Blueprints",
      "- `../blueprints/b1.md` - active",
      "## Phases",
      "1. x",
      "## Risks and unknowns",
      "- none",
      "## User-visible value",
      "x",
    ].join("\n"));
    write(root, `${ctl}/blueprints/b1.md`, "# Blueprint: B1\n\n- Linked milestone: `m1`\n");
    write(root, `${ctl}/decisions/DEC-001-use-x.md`, [
      "# DEC-001: Use X",
      "- Date: 2026-06-07",
      "- Status: accepted",
      "- Scope: `docs/garelier/` and project control",
      "- Supersedes: none",
      "- Related: none",
      "## Context",
      "x",
      "## Decision",
      "x",
      "## Consequences",
      "x",
    ].join("\n"));
    write(root, `${ctl}/decisions/README.md`, "# Decision records\n");

    const c = buildControl(root, PM);
    expect(c.present).toBe(true);
    expect(c.mode).toBe("full");
    expect(c.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(c.nodes.find((n) => n.rel?.endsWith("/decisions/DEC-001-use-x.md"))?.status).toBe("accepted");
    expect(c.nodes.find((n) => n.rel?.endsWith("/decisions/README.md"))?.kind).toBe("document");
    const milestone = c.nodes.find((n) => n.kind === "milestone")!;
    const blueprint = c.nodes.find((n) => n.kind === "blueprint")!;
    expect(c.edges.some((e) => e.from === milestone.id && e.to === blueprint.id && e.relation === "includes")).toBe(true);
    expect(c.mermaid).toContain("flowchart LR");
  });

  test("flags missing marker, completed backlog, and malformed canonical records", () => {
    const root = tmp();
    const ctl = `__garelier/${PM}/control`;
    write(root, `${ctl}/project_dashboard/backlog.md`, "# Backlog\n- [x] done\n");
    write(root, `${ctl}/milestones/bad.md`, "# wrong\n");
    write(root, `${ctl}/decisions/wrong.md`, "# wrong\n");
    const c = buildControl(root, PM);
    const codes = c.findings.map((f) => f.code);
    expect(codes).toContain("missing-control-marker");
    expect(codes).toContain("completed-backlog-entry");
    expect(codes).toContain("milestone-heading");
    expect(codes).toContain("decision-filename");
  });

  test("warns when dashboard hot files do not use the standard schema", () => {
    const root = tmp();
    const ctl = `__garelier/${PM}/control`;
    write(root, `${ctl}/control.toml`, [
      "schema_version = 1",
      'kind = "garelier_control"',
      `pm_id = "${PM}"`,
      'mode = "control_only"',
    ].join("\n"));
    for (const name of ["README", "current", "roadmap", "backlog", "decisions", "risks", "quality_gates", "notes"]) {
      write(root, `${ctl}/project_dashboard/${name}.md`, `# ${name}\n`);
    }
    write(root, `${ctl}/project_dashboard/backlog.md`, [
      "# Backlog",
      "## Open work",
      "| ID | Type | Priority | Status | Owner | Milestone | Outcome | Acceptance | Detail |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| bad | task | urgent | doing | - | - | x | - | - |",
    ].join("\n"));
    write(root, `${ctl}/project_dashboard/milestones.md`, "# legacy\n");
    write(root, "docs/project_dashboard/current.md", "# duplicate\n");
    write(root, "docs/decisions/0001-duplicate.md", "# duplicate\n");

    const codes = buildControl(root, PM).findings.map((f) => f.code);
    expect(codes).toContain("dashboard-sections");
    expect(codes).toContain("dashboard-table-header");
    expect(codes).toContain("dashboard-row-value");
    expect(codes).toContain("legacy-dashboard-milestones");
    expect(codes).toContain("legacy-docs-dashboard");
    expect(codes).toContain("legacy-docs-decisions");
  });
});

describe("buildKnowledgeGraph", () => {
  test("links roles, sources, and routines to curated documents", () => {
    const root = tmp();
    write(root, "docs/garelier/knowledge/knowledge.toml", 'schema_version = 1\nkind = "garelier_knowledge"\n');
    write(root, "docs/garelier/project/index.md", "# Project Knowledge Index\n");
    write(root, "docs/garelier/project/rule.md", [
      "---",
      "knowledge_id: project.rule",
      "title: Rule",
      "category: project",
      "status: active",
      "---",
      "# Rule",
    ].join("\n"));
    write(root, "docs/garelier/runbooks/check.md", "# Runbook: Check\n");
    write(root, "docs/garelier/knowledge/role_index.toml", [
      "schema_version = 1",
      "[roles.project]",
      'read_first = ["docs/garelier/project/index.md"]',
      'on_demand = ["docs/garelier/project/rule.md"]',
    ].join("\n"));
    write(root, "docs/garelier/knowledge/source_registry.toml", [
      "[[sources]]",
      'id = "project-original"',
      'target = "docs/garelier/project/rule.md"',
    ].join("\n"));
    write(root, "docs/garelier/knowledge/routine_registry.toml", [
      "[[routines]]",
      'id = "check"',
      'manual = "docs/garelier/runbooks/check.md"',
      'source_id = "project-original"',
    ].join("\n"));

    const g = buildKnowledgeGraph(root);
    expect(g.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(g.nodes.some((n) => n.kind === "role" && n.title === "project")).toBe(true);
    expect(g.edges.some((e) => e.relation === "reads_first")).toBe(true);
    expect(g.edges.some((e) => e.relation === "targets")).toBe(true);
    expect(g.edges.some((e) => e.relation === "manual")).toBe(true);
  });

  test("flags dangling registry relationships", () => {
    const root = tmp();
    write(root, "docs/garelier/knowledge/knowledge.toml", 'kind = "garelier_knowledge"\n');
    write(root, "docs/garelier/knowledge/routine_registry.toml", [
      "[[routines]]",
      'id = "bad"',
      'manual = "docs/garelier/runbooks/missing.md"',
      'source_id = "missing"',
    ].join("\n"));
    const codes = buildKnowledgeGraph(root).findings.map((f) => f.code);
    expect(codes).toContain("missing-routine-manual");
    expect(codes).toContain("missing-routine-source");
  });
});

// W-008 regression: the status tree walkers must stay bounded (depth cap) so a
// pathological or runaway-deep tree cannot degenerate a per-request scan.
describe("bounded status walks (W-008)", () => {
  function deepTree(root: string): { shallow: string; deep: string } {
    const segs = Array.from({ length: 16 }, (_, i) => `d${i}`);
    const deepRel = segs.join("/") + "/deep.md";
    write(root, "shallow.md", "# s");
    write(root, deepRel, "# d");
    return { shallow: "shallow.md", deep: deepRel };
  }
  test("knowledge-graph files() caps depth", () => {
    const root = tmp();
    deepTree(root);
    const out = kgFiles(root).map((p) => p.replace(/\\/g, "/"));
    expect(out.some((p) => p.endsWith("/shallow.md"))).toBe(true);
    expect(out.some((p) => p.endsWith("/deep.md"))).toBe(false);
  });
  test("control filesUnder() caps depth", () => {
    const root = tmp();
    deepTree(root);
    const out = ctlFilesUnder(root).map((p) => p.replace(/\\/g, "/"));
    expect(out.some((p) => p.endsWith("/shallow.md"))).toBe(true);
    expect(out.some((p) => p.endsWith("/deep.md"))).toBe(false);
  });
});

