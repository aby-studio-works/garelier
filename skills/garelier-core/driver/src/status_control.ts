// Canonical control-contract graph + validation (DEC-044).
//
// Reads only __garelier/<pm_id>/control. The graph is derived from the tracked
// authority and must never be hand-maintained.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type {
  ControlEdge, ControlFinding, ControlInfo, ControlNode, ControlNodeKind,
} from "./status_types.ts";

const fwd = (p: string): string => p.replace(/\\/g, "/");
const text = (p: string): string => {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
};
const field = (body: string, name: string): string | null => {
  const m = body.match(new RegExp(`^[-*]\\s*${name}:\\s*(.+?)\\s*$`, "im"));
  return m ? m[1].trim().replace(/^`(.+)`$/, "$1").trim() : null;
};
const heading = (body: string): string | null => body.match(/^#\s+(.+)$/m)?.[1].trim() ?? null;
const hasSection = (body: string, name: string): boolean =>
  new RegExp(`^##\\s+${name}\\s*$`, "im").test(body);
const tableHeaders = (body: string): string[][] =>
  [...body.matchAll(/^\|(.+)\|\s*$/gm)]
    .map((m) => m[1].split("|").map((cell) => cell.trim().toLowerCase()))
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
const hasTableHeader = (body: string, headers: string[]): boolean => {
  const expected = headers.map((header) => header.toLowerCase());
  return tableHeaders(body).some((cells) =>
    cells.length === expected.length && cells.every((cell, i) => cell === expected[i]));
};
const tableRows = (body: string, headers: string[]): string[][] => {
  const lines = body.split(/\r?\n/);
  const expected = headers.map((header) => header.toLowerCase());
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("|")) continue;
    const cells = lines[i].slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length !== expected.length || !cells.every((cell, j) => cell.toLowerCase() === expected[j])) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j++) {
      const row = lines[j].slice(1, -1).split("|").map((cell) => cell.trim());
      if (row.length === headers.length) rows.push(row);
    }
    return rows;
  }
  return [];
};
const safeLabel = (s: string): string => s.replace(/"/g, "'").replace(/[\r\n]+/g, " ").slice(0, 80);

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      const p = join(dir, name);
      try {
        if (statSync(p).isDirectory()) visit(p);
        else if (name !== ".gitkeep") out.push(p);
      } catch { /* best-effort reader */ }
    }
  };
  visit(root);
  return out;
}

function classify(rel: string): ControlNodeKind {
  if (/^project_dashboard\/.+\.md$/i.test(rel)) return "dashboard";
  if (/^milestones\/[^/]+\.md$/i.test(rel)) return "milestone";
  if (/^blueprints\/[^/]+\.md$/i.test(rel)) return "blueprint";
  if (/^decisions\/(?!README\.md$)[^/]+\.md$/i.test(rel)) return "decision";
  return "document";
}

function referencedPaths(body: string): string[] {
  return [...body.matchAll(/`([^`\n]+\.(?:md|toml))`/g)].map((m) => fwd(m[1]));
}

export function buildControl(projectRoot: string, pmId: string): ControlInfo {
  const root = join(projectRoot, "__garelier", pmId, "control");
  const rootRel = `__garelier/${pmId}/control`;
  const findings: ControlFinding[] = [];
  const nodes: ControlNode[] = [];
  const edges: ControlEdge[] = [];
  if (!existsSync(root)) {
    return { present: false, rootRel, pmId, mode: null, counts: {}, nodes, edges, findings, mermaid: "flowchart LR\n  empty[\"No control tree\"]" };
  }
  if (existsSync(join(projectRoot, "docs", "project_dashboard"))) {
    findings.push({
      severity: "warning",
      code: "legacy-docs-dashboard",
      message: "docs/project_dashboard is a parallel management surface; migrate durable state into the selected control namespace and retain explanatory docs only.",
      rel: "docs/project_dashboard",
    });
  }
  if (existsSync(join(projectRoot, "docs", "decisions"))) {
    findings.push({
      severity: "warning",
      code: "legacy-docs-decisions",
      message: "docs/decisions is a parallel decision authority; migrate decision bodies into the selected control namespace.",
      rel: "docs/decisions",
    });
  }

  const markerPath = join(root, "control.toml");
  const marker = text(markerPath);
  const tomlValue = (name: string): string | null =>
    marker.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;
  const markerPm = tomlValue("pm_id");
  const mode = tomlValue("mode");
  if (!marker) findings.push({ severity: "error", code: "missing-control-marker", message: "control.toml is required.", rel: null });
  else {
    if (tomlValue("kind") !== "garelier_control") findings.push({ severity: "error", code: "invalid-control-kind", message: 'control.toml kind must be "garelier_control".', rel: `${rootRel}/control.toml` });
    if (markerPm !== pmId) findings.push({ severity: "error", code: "pm-id-mismatch", message: `control.toml pm_id must be "${pmId}".`, rel: `${rootRel}/control.toml` });
    if (!["full", "control_only"].includes(mode ?? "")) findings.push({ severity: "error", code: "invalid-control-mode", message: "control.toml mode must be full or control_only.", rel: `${rootRel}/control.toml` });
  }

  nodes.push({ id: "control", kind: "control", title: pmId, status: mode, rel: `${rootRel}/control.toml` });
  const allFiles = filesUnder(root);
  const categories = new Map<string, string>();
  const nodeByRel = new Map<string, string>();
  let seq = 0;
  for (const abs of allFiles) {
    const rel = fwd(relative(root, abs));
    if (rel === "control.toml") continue;
    const top = rel.includes("/") ? rel.split("/")[0] : "root";
    if (!categories.has(top)) {
      const id = `cat-${seq++}`;
      categories.set(top, id);
      nodes.push({ id, kind: "category", title: top, status: null, rel: null });
      edges.push({ from: "control", to: id, relation: "contains" });
    }
    const body = text(abs);
    const kind = classify(rel);
    const id = `file-${seq++}`;
    const status = field(body, "Status");
    nodes.push({ id, kind, title: heading(body) ?? basename(rel), status, rel: `${rootRel}/${rel}` });
    nodeByRel.set(rel, id);
    edges.push({ from: categories.get(top)!, to: id, relation: "contains" });

    if (kind === "milestone") validateMilestone(rel, body, findings, rootRel);
    if (kind === "decision") validateDecision(rel, body, findings, rootRel);
  }

  const requiredDashboards = ["README.md", "current.md", "roadmap.md", "backlog.md", "decisions.md", "risks.md", "quality_gates.md", "notes.md"];
  for (const name of requiredDashboards) {
    const rel = `project_dashboard/${name}`;
    if (!nodeByRel.has(rel)) findings.push({ severity: "error", code: "missing-dashboard-file", message: `Required dashboard file is missing: ${rel}`, rel: null });
  }
  validateDashboard(root, rootRel, nodeByRel, findings);
  const backlogRel = "project_dashboard/backlog.md";
  const backlog = text(join(root, backlogRel));
  if (/\[[xX]\]/.test(backlog)) findings.push({ severity: "error", code: "completed-backlog-entry", message: "Backlog must contain open work only; delete completed [x] entries and use git history.", rel: `${rootRel}/${backlogRel}` });
  const decisionsIndex = text(join(root, "project_dashboard", "decisions.md"));
  if (/^##\s+DEC-\d+/m.test(decisionsIndex)) findings.push({ severity: "warning", code: "decision-body-in-index", message: "Dashboard decisions.md must index canonical decision files, not contain decision bodies.", rel: `${rootRel}/project_dashboard/decisions.md` });

  // Add semantic edges after every artifact has an id.
  for (const abs of allFiles) {
    const rel = fwd(relative(root, abs));
    const from = nodeByRel.get(rel);
    if (!from || !rel.endsWith(".md")) continue;
    const body = text(abs);
    for (const ref of referencedPaths(body)) {
      const normalized = ref.replace(/^(\.\.\/)+/, "").replace(/^control\//, "");
      const to = nodeByRel.get(normalized);
      if (!to || to === from) continue;
      const relation = normalized.startsWith("blueprints/")
        ? (rel.startsWith("milestones/") ? "includes" : "depends")
        : "related";
      if (!edges.some((e) => e.from === from && e.to === to && e.relation === relation)) {
        edges.push({ from, to, relation });
      }
    }
    if (rel.startsWith("blueprints/")) {
      const milestone = field(body, "Linked milestone");
      const target = milestone ? nodeByRel.get(`milestones/${milestone}.md`) : undefined;
      if (target && !edges.some((e) => e.from === target && e.to === from && e.relation === "includes")) {
        edges.push({ from: target, to: from, relation: "includes" });
      }
    }
  }

  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  return { present: true, rootRel, pmId, mode, counts, nodes, edges, findings, mermaid: toMermaid(nodes, edges) };
}

function validateDashboard(root: string, rootRel: string, nodeByRel: Map<string, string>, findings: ControlFinding[]): void {
  const warn = (name: string, code: string, message: string): void => {
    findings.push({ severity: "warning", code, message, rel: `${rootRel}/project_dashboard/${name}` });
  };
  const dashboard = (name: string): string =>
    nodeByRel.has(`project_dashboard/${name}`) ? text(join(root, "project_dashboard", name)) : "";
  const requireSections = (name: string, sections: string[]): void => {
    const body = dashboard(name);
    if (!body) return;
    const missing = sections.filter((section) => !hasSection(body, section));
    if (missing.length > 0) warn(name, "dashboard-sections", `${name} is missing standard section(s): ${missing.join(", ")}.`);
  };
  const requireTable = (name: string, headers: string[]): void => {
    const body = dashboard(name);
    if (body && !hasTableHeader(body, headers)) {
      warn(name, "dashboard-table-header", `${name} requires table header: ${headers.join(" | ")}.`);
    }
  };

  requireSections("README.md", ["Authority", "Rules", "File roles"]);
  requireSections("current.md", ["Active focus", "Next actions", "Blockers", "Read first"]);
  requireSections("roadmap.md", ["Direction", "Active milestones", "Planned milestones", "Out of scope"]);
  requireSections("backlog.md", ["Open work"]);
  requireSections("decisions.md", ["Decision index"]);
  requireSections("risks.md", ["Active risks"]);
  requireSections("quality_gates.md", ["Required commands", "Review conditions"]);
  requireSections("notes.md", ["Scratch"]);

  requireTable("backlog.md", ["ID", "Type", "Priority", "Status", "Owner", "Milestone", "Outcome", "Acceptance", "Detail"]);
  requireTable("decisions.md", ["ID", "Status", "Title", "Record"]);
  requireTable("risks.md", ["ID", "Severity", "Likelihood", "Risk", "Trigger", "Mitigation", "Owner", "Detail"]);
  requireTable("quality_gates.md", ["ID", "Scope", "Command", "Required"]);
  requireTable("notes.md", ["ID", "Note", "Promote to", "Review by"]);

  const backlogHeaders = ["ID", "Type", "Priority", "Status", "Owner", "Milestone", "Outcome", "Acceptance", "Detail"];
  const backlogRows = tableRows(dashboard("backlog.md"), backlogHeaders);
  const backlogIds = new Set<string>();
  for (const row of backlogRows) {
    const [id, type, priority, status] = row;
    if (!/^W-\d{3,}$/.test(id)) warn("backlog.md", "dashboard-row-value", `Backlog ID must match W-NNN: ${id || "(empty)"}.`);
    else if (backlogIds.has(id)) warn("backlog.md", "dashboard-row-value", `Backlog ID must be unique: ${id}.`);
    backlogIds.add(id);
    if (!["feature", "bug", "maintenance", "research", "decision", "docs"].includes(type)) warn("backlog.md", "dashboard-row-value", `Backlog ${id || "row"} has invalid Type: ${type || "(empty)"}.`);
    if (!["critical", "high", "normal", "low"].includes(priority)) warn("backlog.md", "dashboard-row-value", `Backlog ${id || "row"} has invalid Priority: ${priority || "(empty)"}.`);
    if (!["triage", "ready", "blocked", "deferred"].includes(status)) warn("backlog.md", "dashboard-row-value", `Backlog ${id || "row"} has invalid Status: ${status || "(empty)"}.`);
  }
  const riskHeaders = ["ID", "Severity", "Likelihood", "Risk", "Trigger", "Mitigation", "Owner", "Detail"];
  const riskIds = new Set<string>();
  for (const row of tableRows(dashboard("risks.md"), riskHeaders)) {
    const [id, severity, likelihood] = row;
    if (!/^R-\d{3,}$/.test(id)) warn("risks.md", "dashboard-row-value", `Risk ID must match R-NNN: ${id || "(empty)"}.`);
    else if (riskIds.has(id)) warn("risks.md", "dashboard-row-value", `Risk ID must be unique: ${id}.`);
    riskIds.add(id);
    if (!["critical", "high", "medium", "low"].includes(severity)) warn("risks.md", "dashboard-row-value", `Risk ${id || "row"} has invalid Severity: ${severity || "(empty)"}.`);
    if (!["critical", "high", "medium", "low"].includes(likelihood)) warn("risks.md", "dashboard-row-value", `Risk ${id || "row"} has invalid Likelihood: ${likelihood || "(empty)"}.`);
  }

  const maxLines: Record<string, number> = {
    "README.md": 160,
    "current.md": 120,
    "roadmap.md": 300,
    "backlog.md": 400,
    "decisions.md": 300,
    "risks.md": 400,
    "quality_gates.md": 400,
    "notes.md": 120,
  };
  for (const [name, max] of Object.entries(maxLines)) {
    const body = dashboard(name);
    const lines = body ? body.split(/\r?\n/).length : 0;
    if (lines > max) warn(name, "dashboard-hot-file-large", `${name} has ${lines} lines; keep this hot file at or below ${max} lines and move detail to canonical artifacts.`);
  }
  if (nodeByRel.has("project_dashboard/milestones.md")) {
    warn("milestones.md", "legacy-dashboard-milestones", "Move milestone bodies to control/milestones/<slug>.md and index them from roadmap.md.");
  }
}

function validateMilestone(rel: string, body: string, findings: ControlFinding[], rootRel: string): void {
  const add = (code: string, message: string): void => {
    findings.push({ severity: "error", code, message, rel: `${rootRel}/${rel}` });
  };
  const slug = field(body, "Slug");
  if (!/^#\s+Milestone:\s+.+$/m.test(body)) add("milestone-heading", "Milestone heading must be '# Milestone: <title>'.");
  if (!slug) add("milestone-slug", "Milestone requires Identity field Slug.");
  else if (`${slug}.md` !== basename(rel)) add("milestone-slug-filename", `Milestone slug "${slug}" must match filename.`);
  if (!["planned", "active", "shipped", "abandoned"].includes(field(body, "Status") ?? "")) add("milestone-status", "Milestone Status must be planned, active, shipped, or abandoned.");
  for (const section of ["Identity", "Description", "Success criteria", "Blueprints", "Risks and unknowns", "User-visible value"]) {
    if (!hasSection(body, section)) add("milestone-section", `Milestone requires section: ${section}.`);
  }
}

function validateDecision(rel: string, body: string, findings: ControlFinding[], rootRel: string): void {
  const add = (code: string, message: string): void => {
    findings.push({ severity: "error", code, message, rel: `${rootRel}/${rel}` });
  };
  const fileId = basename(rel).match(/^(DEC-\d+)-/)?.[1] ?? null;
  const headId = body.match(/^#\s+(DEC-\d+):/m)?.[1] ?? null;
  if (!fileId) add("decision-filename", "Decision filename must be DEC-NNN-<slug>.md.");
  if (!headId) add("decision-heading", "Decision heading must be '# DEC-NNN: <title>'.");
  if (fileId && headId && fileId !== headId) add("decision-id-mismatch", "Decision heading id must match filename id.");
  for (const name of ["Date", "Status", "Scope", "Supersedes", "Related"]) if (!field(body, name)) add("decision-field", `Decision requires field: ${name}.`);
  if (!["proposed", "accepted", "superseded", "rejected"].includes(field(body, "Status") ?? "")) add("decision-status", "Decision Status must be proposed, accepted, superseded, or rejected.");
  for (const section of ["Context", "Decision", "Consequences"]) if (!hasSection(body, section)) add("decision-section", `Decision requires section: ${section}.`);
}

function toMermaid(nodes: ControlNode[], edges: ControlEdge[]): string {
  const lines = ["flowchart LR"];
  for (const n of nodes) {
    const suffix = n.status ? `\\n[${n.status}]` : "";
    lines.push(`  ${n.id}["${safeLabel(n.title)}${safeLabel(suffix)}"]`);
  }
  for (const e of edges) lines.push(`  ${e.from} -->|${e.relation}| ${e.to}`);
  return lines.join("\n");
}
