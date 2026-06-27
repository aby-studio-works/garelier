// Read-only assignment prep (W-017/W-019).
//
// Scout pipeline packages need assignment.md + compact pickup context, but no
// worktree. This helper keeps that path mechanical and separate from
// dispatch_prepare, which intentionally rejects read-only roles.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildFactPack } from "./context_pack.ts";
import { parsePipelinePackages, renderAssignment, validatePipelinePackages } from "./pipeline_packages.ts";
import { buildRolePickupPack } from "./role_pickup_pack.ts";
import { parse as parseToml } from "smol-toml";

async function readText(path: string): Promise<string> {
  const f = Bun.file(path);
  if (!(await f.exists())) throw new Error(`not found: ${path}`);
  return await f.text();
}

function roleIndexPath(project: string, pmId: string): string {
  const shared = join(project, "__garelier", "__atmos", "knowledge", "role_index.toml");
  const pm = join(project, "__garelier", pmId, "knowledge", "role_index.toml");
  return (existsSync(shared) ? shared : pm).replace(/\\/g, "/");
}

export interface ReadOnlyPrepResult {
  schema_version: 1;
  generated_by: "readonly_assignment_prep.ts";
  kind: "readonly_assignment_prep";
  advisory: true;
  role: "scout";
  package_id: string;
  container: string;
  assignment: string;
  context: string;
  pickup_pack: string;
}

export interface ReadOnlyPrepOptions {
  projectRoot: string;
  pmId: string;
  role: "scout";
  blueprintPath: string;
  packageId: string;
  container: string;
  taskId: string;
  agentId?: string | null;
  baseBranch?: string | null;
}

export async function prepareReadOnlyAssignment(opts: ReadOnlyPrepOptions): Promise<ReadOnlyPrepResult> {
  mkdirSync(opts.container, { recursive: true });
  const bp = await readText(opts.blueprintPath);
  const packages = parsePipelinePackages(bp);
  const issues = validatePipelinePackages(packages);
  if (issues.some((i) => i.level === "error")) throw new Error(`invalid pipeline packages: ${issues.map((i) => `${i.package_id ?? "-"} ${i.message}`).join("; ")}`);
  const p = packages.find((x) => x.id === opts.packageId);
  if (!p) throw new Error(`package not found: ${opts.packageId}`);
  if (p.role !== opts.role) throw new Error(`package ${opts.packageId} role is ${p.role}; prep role is ${opts.role}`);
  const assignment = join(opts.container, "assignment.md").replace(/\\/g, "/");
  const contextPath = join(opts.container, "context.json").replace(/\\/g, "/");
  const configPath = join(opts.projectRoot, "__garelier", opts.pmId, "_pm", "setup_config.toml");
  let config: Record<string, unknown> | null = null;
  try {
    const cfg = await readText(configPath);
    config = parseToml(cfg) as Record<string, unknown>;
  } catch { /* fail-open context */ }
  const context = buildFactPack({
    pmId: opts.pmId,
    projectRoot: opts.projectRoot,
    integration: opts.baseBranch ?? null,
    config,
    blueprintMd: bp,
    blueprintPath: opts.blueprintPath,
    task: { id: Number(opts.taskId), role: opts.role, slug: p.title, base_branch: opts.baseBranch ?? null },
  });
  await Bun.write(contextPath, JSON.stringify(context, null, 2) + "\n");
  const rendered = renderAssignment(p, {
    taskId: opts.taskId,
    agentId: opts.agentId ?? `${opts.role}(#${opts.taskId})`,
    pmId: opts.pmId,
    slug: p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
    baseBranch: opts.baseBranch ?? null,
    blueprintPath: opts.blueprintPath,
  });
  await Bun.write(assignment, rendered);
  const pickup = buildRolePickupPack({
    role: opts.role,
    assignmentPath: assignment,
    assignmentMd: rendered,
    contextPath,
    roleIndexPath: roleIndexPath(opts.projectRoot, opts.pmId),
  });
  const pickupPath = join(opts.container, "pickup_pack.json").replace(/\\/g, "/");
  await Bun.write(pickupPath, JSON.stringify(pickup, null, 2) + "\n");
  return { schema_version: 1, generated_by: "readonly_assignment_prep.ts", kind: "readonly_assignment_prep", advisory: true, role: opts.role, package_id: opts.packageId, container: opts.container, assignment, context: contextPath, pickup_pack: pickupPath };
}

function fail(msg: string): never {
  process.stderr.write(`readonly_assignment_prep: ${msg}\n`);
  process.exit(2);
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const role = flag("role") ?? "scout";
  if (role !== "scout") fail("only --role scout is supported for Pipeline package read-only prep");
  const result = await prepareReadOnlyAssignment({
    projectRoot: flag("project") ?? fail("--project is required"),
    pmId: flag("pm-id") ?? fail("--pm-id is required"),
    role: "scout",
    blueprintPath: flag("blueprint") ?? fail("--blueprint is required"),
    packageId: (flag("package") ?? fail("--package is required")).toUpperCase(),
    container: flag("container") ?? fail("--container is required"),
    taskId: flag("task-id") ?? fail("--task-id is required"),
    agentId: flag("agent-id") ?? null,
    baseBranch: flag("base") ?? null,
  });
  const out = flag("out");
  const json = JSON.stringify(result, null, 2) + "\n";
  if (out) await Bun.write(out, json);
  else process.stdout.write(json);
}

if (import.meta.main) {
  void main().catch((e) => { process.stderr.write(`readonly_assignment_prep: ${(e as Error).message}\n`); process.exit(1); });
}
