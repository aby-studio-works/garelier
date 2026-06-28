// Pipeline package dispatch planner (W-019).
//
// Read-only helper for Dock: validate a PM-authored blueprint's Pipeline
// packages and print the exact safe dispatch/render command shape for each
// package. It never dispatches, never claims ids, and never decides routing; it
// turns the PM's package contract into a mechanical checklist.

import { basename } from "node:path";
import {
  parsePipelinePackages,
  validatePipelinePackages,
  type PackageRole,
  type PipelineIssue,
  type PipelinePackage,
} from "./pipeline_packages.ts";

export type DispatchPath = "commit-bearing" | "read-only" | "legacy-fallback";
export type PlanStatus = "ready" | "blocked" | "legacy-fallback";

export interface PipelinePlanItem {
  package_id: string;
  title: string;
  role: PackageRole | null;
  dispatch: string | null;
  depends_on: string[];
  path: DispatchPath;
  status: PlanStatus;
  slug: string;
  command: string | null;
  notes: string[];
  issues: PipelineIssue[];
}

export interface PipelinePlan {
  schema_version: 1;
  generated_by: "pipeline_plan.ts";
  kind: "pipeline_dispatch_plan";
  advisory: true;
  blueprint: string;
  pm_id: string;
  project: string | null;
  target_root: string | null;
  base: string | null;
  packages: PipelinePlanItem[];
  issues: PipelineIssue[];
  summary: {
    packages: number;
    ready: number;
    blocked: number;
    legacy_fallback: boolean;
  };
  note: string;
}

const COMMIT_ROLES = new Set<PackageRole>(["worker", "smith", "librarian", "artisan"]);
const READ_ONLY_ROLES = new Set<PackageRole>(["scout"]);

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function slugify(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return cleaned || "pipeline-package";
}

function packageIssues(all: PipelineIssue[], id: string): PipelineIssue[] {
  return all.filter((i) => i.package_id === id || i.package_id == null);
}

function packageCommand(p: PipelinePackage, opts: BuildPlanOptions, slug: string): { path: DispatchPath; command: string | null; notes: string[] } {
  const project = opts.projectRoot ?? "<project>";
  const targetRoot = opts.targetRoot ? ` --target-root ${shQuote(opts.targetRoot)}` : "";
  const bp = opts.blueprintPath;
  const base = opts.base ? ` --base ${shQuote(opts.base)}` : "";
  if (p.role && COMMIT_ROLES.has(p.role)) {
    return {
      path: "commit-bearing",
      command: [
        "skills/garelier-core/scripts/dispatch_prepare.sh",
        "--project", shQuote(project),
        "--pm-id", shQuote(opts.pmId),
        "--role", shQuote(p.role),
        "--slug", shQuote(slug),
        "--blueprint", shQuote(bp),
        "--pipeline-package", shQuote(p.id),
      ].join(" ") + targetRoot + base,
      notes: ["Claims the next task id, creates the worktree, renders assignment.md, writes context.json and pickup_pack.json."],
    };
  }
  if (p.role && READ_ONLY_ROLES.has(p.role)) {
    return {
      path: "read-only",
      command: [
        "bun", "skills/garelier-core/driver/src/readonly_assignment_prep.ts",
        "--project", shQuote(project),
        "--pm-id", shQuote(opts.pmId),
        "--role", shQuote(p.role),
        "--blueprint", shQuote(bp),
        "--package", shQuote(p.id),
        "--task-id", "<task-id>",
        "--agent-id", shQuote(`${p.role}(#<task-id>)`),
        "--container", shQuote("<read-only-container>"),
      ].join(" ") + base,
      notes: ["Read-only package: renders assignment.md, context.json, and pickup_pack.json; does not create a worktree."],
    };
  }
  return { path: "legacy-fallback", command: null, notes: ["Package role is invalid; Dock cannot plan a safe dispatch path."] };
}

export interface BuildPlanOptions {
  blueprintPath: string;
  blueprintMd: string;
  pmId: string;
  projectRoot?: string | null;
  targetRoot?: string | null;
  base?: string | null;
}

export function buildPipelinePlan(opts: BuildPlanOptions): PipelinePlan {
  const packages = parsePipelinePackages(opts.blueprintMd);
  if (packages.length === 0) {
    return {
      schema_version: 1,
      generated_by: "pipeline_plan.ts",
      kind: "pipeline_dispatch_plan",
      advisory: true,
      blueprint: opts.blueprintPath,
      pm_id: opts.pmId,
      project: opts.projectRoot ?? null,
      target_root: opts.targetRoot ?? null,
      base: opts.base ?? null,
      packages: [{
        package_id: "legacy",
        title: basename(opts.blueprintPath),
        role: null,
        dispatch: null,
        depends_on: [],
        path: "legacy-fallback",
        status: "legacy-fallback",
        slug: slugify(basename(opts.blueprintPath).replace(/\.md$/i, "")),
        command: null,
        notes: ["No ## Pipeline packages section. Dock must use the legacy blueprint-to-assignment path."],
        issues: [],
      }],
      issues: [],
      summary: { packages: 0, ready: 0, blocked: 0, legacy_fallback: true },
      note: "Advisory dispatch plan only. PM-authored packages stay authoritative; Dock still reviews reports and gates merges.",
    };
  }

  const issues = validatePipelinePackages(packages);
  const items = packages.map((p): PipelinePlanItem => {
    const localIssues = packageIssues(issues, p.id);
    const blocked = localIssues.some((i) => i.level === "error");
    const slug = slugify(`${p.id}-${p.title}`);
    const cmd = packageCommand(p, opts, slug);
    return {
      package_id: p.id,
      title: p.title,
      role: p.role,
      dispatch: p.dispatch,
      depends_on: p.depends_on,
      path: cmd.path,
      status: blocked ? "blocked" : "ready",
      slug,
      command: blocked ? null : cmd.command,
      notes: cmd.notes,
      issues: localIssues,
    };
  });
  return {
    schema_version: 1,
    generated_by: "pipeline_plan.ts",
    kind: "pipeline_dispatch_plan",
    advisory: true,
    blueprint: opts.blueprintPath,
    pm_id: opts.pmId,
    project: opts.projectRoot ?? null,
    target_root: opts.targetRoot ?? null,
    base: opts.base ?? null,
    packages: items,
    issues,
    summary: {
      packages: packages.length,
      ready: items.filter((i) => i.status === "ready").length,
      blocked: items.filter((i) => i.status === "blocked").length,
      legacy_fallback: false,
    },
    note: "Advisory dispatch plan only. Commands are safe shapes for Dock; they do not run here.",
  };
}

export function renderPlanMarkdown(plan: PipelinePlan): string {
  const lines = [
    `# Pipeline dispatch plan`,
    "",
    `- Blueprint: \`${plan.blueprint}\``,
    `- PM: \`${plan.pm_id}\``,
    ...(plan.target_root ? [`- Target root: \`${plan.target_root}\``] : []),
    `- Packages: ${plan.summary.packages}`,
    `- Ready: ${plan.summary.ready}`,
    `- Blocked: ${plan.summary.blocked}`,
    `- Legacy fallback: ${plan.summary.legacy_fallback ? "yes" : "no"}`,
    "",
    "| Package | Role | Path | Status | Depends on | Command |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const p of plan.packages) {
    lines.push(`| ${p.package_id} | ${p.role ?? "-"} | ${p.path} | ${p.status} | ${p.depends_on.join(", ") || "-"} | ${p.command ? `\`${p.command.replace(/\|/g, "\\|")}\`` : "-"} |`);
    for (const issue of p.issues) lines.push(`| ${p.package_id} | ${issue.level} | issue | ${p.status} | - | ${issue.message.replace(/\|/g, "\\|")} |`);
  }
  lines.push("", plan.note, "");
  return lines.join("\n");
}

function fail(msg: string): never {
  process.stderr.write(`pipeline_plan: ${msg}\n`);
  process.exit(2);
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const blueprint = flag("blueprint") ?? fail("--blueprint is required");
  const pmId = flag("pm-id") ?? fail("--pm-id is required");
  const md = await Bun.file(blueprint).text();
  const plan = buildPipelinePlan({
    blueprintPath: blueprint,
    blueprintMd: md,
    pmId,
    projectRoot: flag("project") ?? null,
    targetRoot: flag("target-root") ?? null,
    base: flag("base") ?? null,
  });
  const out = flag("out");
  const body = hasFlag("json") || flag("format") === "json"
    ? JSON.stringify(plan, null, 2) + "\n"
    : renderPlanMarkdown(plan);
  if (out) await Bun.write(out, body);
  else process.stdout.write(body);
  if (plan.summary.blocked > 0) process.exit(1);
}

if (import.meta.main) {
  void main();
}
