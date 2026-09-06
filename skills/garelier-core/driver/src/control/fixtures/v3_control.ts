import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function document(frontmatter: string[], body: string): string {
  return `+++\n${frontmatter.join("\n")}\n+++\n${body}`;
}

export const V3_REQUIRED_DASHBOARD_FILES = [
  "README.md",
  "current.md",
  "roadmap.md",
  "backlog.md",
  "decisions.md",
  "risks.md",
  "quality_gates.md",
  "notes.md",
] as const;

export function writeV3Fixture(root: string, workCount = 2, pmId = "pm1"): string {
  const control = join(root, "__garelier", pmId, "control");
  for (const path of ["project_dashboard", "backlog/open", "checkpoints/active"]) {
    mkdirSync(join(control, path), { recursive: true });
  }
  writeFileSync(join(control, "control.toml"), [
    "schema_version = 3",
    'kind = "garelier_control"',
    `pm_id = "${pmId}"`,
    'mode = "control_only"',
    'storage = "plan_graph_markdown"',
    "",
    "[control]",
    "max_resume_bytes = 24576",
    "",
  ].join("\n"));
  const ids = Array.from({ length: workCount }, (_, index) => `W-${String(index + 1).padStart(3, "0")}`);
  const dashboard = join(control, "project_dashboard");
  for (const [name, body] of Object.entries({
    "README.md": "# Project Dashboard\n\nSchema 3 integration fixture.\n",
    "roadmap.md": "# Roadmap\n\nNo curated roadmap entries.\n",
    "backlog.md": "# Backlog\n\nCanonical Backlog records live under `control/backlog/`.\n",
    "decisions.md": "# Decisions\n\nNo curated decision entries.\n",
    "risks.md": "# Risks\n\nNo curated risk entries.\n",
    "quality_gates.md": "# Quality gates\n\nNo curated quality-gate entries.\n",
  })) {
    writeFileSync(join(dashboard, name), body);
  }
  writeFileSync(join(control, "project_dashboard", "current.md"), [
    "# Current",
    "",
    "## Standing instructions",
    "",
    "Preserve canonical lifecycle.",
    "",
    "## Current position",
    "",
    "Runtime integration fixture.",
    "",
    "## Active checkpoints",
    "",
    "- Primary checkpoint: `checkpoint:CP-001`",
    "- `checkpoint:CP-001`",
    "",
    "## Blockers and decisions required",
    "",
    "- None.",
    "",
    "## Read first",
    "",
    ...ids.map((id) => `- \`backlog:${id}\``),
    "",
  ].join("\n"));
  writeFileSync(join(dashboard, "notes.md"), "# Notes\n");
  const lifecycle = [
    'created = "2026-07-22T10:00:00.000Z"',
    'updated = "2026-07-22T11:00:00.000Z"',
    'status_changed = "2026-07-22T11:00:00.000Z"',
    'transition_reason = "fixture initialization"',
  ];
  for (const id of ids) {
    writeFileSync(join(control, "backlog", "open", `${id}-runtime.md`), document([
      "schema_version = 3",
      'kind = "garelier_backlog"',
      `id = "${id}"`,
      'status = "ready"',
      ...lifecycle,
    ], [
      `# ${id}: Runtime integration`,
      "",
      "## Acceptance criteria",
      "",
      "- [ ] Bind dispatch and merge evidence.",
      "",
      "## Current position",
      "",
      "Ready for dispatch.",
      "",
      "## Exact next action",
      "",
      `Claim ${id}.`,
      "",
      "## Evidence",
      "",
      "- None recorded.",
      "",
    ].join("\n")));
  }
  writeFileSync(join(control, "checkpoints", "active", "CP-001-runtime.md"), document([
    "schema_version = 3",
    'kind = "garelier_checkpoint"',
    'id = "CP-001"',
    'status = "active"',
    ...lifecycle,
    `backlog = [${ids.map((id) => `"${id}"`).join(", ")}]`,
    'branch = "codex/w205-runtime-v3"',
    `head = "${"1".repeat(40)}"`,
    'working_tree = "clean"',
  ], [
    "# CP-001: Runtime integration",
    "",
    "## Current position",
    "",
    "### Last completed",
    "",
    "Lifecycle CLI landed.",
    "",
    "### Exact next action",
    "",
    "Dispatch canonical Backlog.",
    "",
    "## Blockers / external decisions",
    "",
    "- None.",
    "",
    "## Read first on resume",
    "",
    ...ids.map((id) => `- \`backlog:${id}\``),
    "",
    "## Resume verification",
    "",
    "Run the integration test.",
    "",
  ].join("\n")));
  const runtime = join(root, "__garelier", pmId, "runtime", "control");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "generation.json"), `${JSON.stringify({
    schema_version: 2,
    kind: "garelier_control_generation",
    control_schema_version: 3,
    storage: "plan_graph_markdown",
    incarnation: "33333333-3333-4333-8333-333333333333",
    generation: 0,
    state: "stable",
    operation: "fixture",
    session_id: "fixture",
    updated_at: "2026-07-22T11:00:00.000Z",
  })}\n`);
  return control;
}
