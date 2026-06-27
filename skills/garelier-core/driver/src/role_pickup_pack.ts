// Role pickup pack (W-017).
//
// Advisory, fail-open orientation pack for a role at assignment pickup. It
// compacts the assignment headings, dispatch context facts, and role_index
// pointers into one JSON surface. It never replaces raw reads and never carries
// a verdict or decision.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

export type PickupRole = "worker" | "scout" | "smith" | "artisan" | "librarian" | "concierge";

export interface PickupSection {
  heading: string;
  items: string[];
  text: string | null;
}
export interface RolePickupPack {
  schema_version: 1;
  generated_by: "role_pickup_pack.ts";
  kind: "role_pickup_pack";
  advisory: true;
  role: PickupRole;
  sources: {
    assignment: string;
    context: string | null;
    role_index: string | null;
  };
  task: {
    id: string | null;
    title: string | null;
    package_id: string | null;
    test_mode: string | null;
  };
  dispatch_context: unknown;
  assignment: {
    goal: string | null;
    inputs: string[];
    do: string[];
    acceptance: string[];
    allowed_write_paths: string[];
    forbidden_write_paths: string[];
    expected_outputs: string[];
    prepared_context: string[];
  };
  knowledge: {
    read_first: string[];
    on_demand: string[];
    missing: string[];
  };
  warnings: string[];
  note: string;
}

const ROLE_SET = new Set<PickupRole>(["worker", "scout", "smith", "artisan", "librarian", "concierge"]);

function strip(s: string): string {
  return s.trim().replace(/^[-*]\s+/, "").replace(/^\[[ xX]\]\s+/, "").trim();
}

function h2Sections(md: string): Map<string, PickupSection> {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = new Map<string, PickupSection>();
  let current: { key: string; heading: string; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.body.join("\n").trim();
    const items = current.body
      .map((l) => (/^\s*[-*]\s+(.+)$/.exec(l)?.[1] ?? /^\s*\d+\.\s+(.+)$/.exec(l)?.[1] ?? null))
      .filter((x): x is string => !!x)
      .map(strip)
      .filter(Boolean);
    out.set(current.key, { heading: current.heading, items, text: body || null });
  };
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      current = { key: h[1].toLowerCase().trim(), heading: h[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return out;
}

function firstLine(section: PickupSection | undefined): string | null {
  if (!section?.text) return null;
  return section.text.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
}

function sectionItems(sections: Map<string, PickupSection>, ...names: string[]): string[] {
  for (const name of names) {
    const s = sections.get(name.toLowerCase());
    if (s?.items.length) return s.items;
    if (s?.text) return [s.text];
  }
  return [];
}

function roleIndexPaths(path: string | null, role: PickupRole): { read_first: string[]; on_demand: string[]; missing: string[]; warning?: string } {
  if (!path) return { read_first: [], on_demand: [], missing: [] };
  try {
    if (!existsSync(path)) return { read_first: [], on_demand: [], missing: [], warning: `role_index not found: ${path}` };
    const data = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
    const roles = data.roles && typeof data.roles === "object" ? data.roles as Record<string, unknown> : {};
    const body = roles[role] && typeof roles[role] === "object" ? roles[role] as Record<string, unknown> : {};
    const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(String).filter(Boolean) : [];
    return { read_first: arr(body.read_first), on_demand: arr(body.on_demand), missing: [] };
  } catch (e) {
    return { read_first: [], on_demand: [], missing: [], warning: `role_index parse failed: ${(e as Error).message}` };
  }
}

function readJson(path: string | null): { value: unknown; warning?: string } {
  if (!path) return { value: null };
  try {
    if (!existsSync(path)) return { value: null, warning: `context not found: ${path}` };
    return { value: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (e) {
    return { value: null, warning: `context parse failed: ${(e as Error).message}` };
  }
}

export interface BuildPickupPackOptions {
  role: PickupRole;
  assignmentPath: string;
  assignmentMd: string;
  contextPath?: string | null;
  roleIndexPath?: string | null;
}

export function buildRolePickupPack(opts: BuildPickupPackOptions): RolePickupPack {
  const sections = h2Sections(opts.assignmentMd);
  const warnings: string[] = [];
  const context = readJson(opts.contextPath ?? null);
  if (context.warning) warnings.push(context.warning);
  const knowledge = roleIndexPaths(opts.roleIndexPath ?? null, opts.role);
  if (knowledge.warning) warnings.push(knowledge.warning);
  const title = opts.assignmentMd.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const packageId =
    opts.assignmentMd.match(/Pipeline packages\s*\/\s*(PP-[0-9]+)/i)?.[1]?.toUpperCase() ??
    opts.assignmentMd.match(/Package\s*ID\s*:\s*(PP-[0-9]+)/i)?.[1]?.toUpperCase() ??
    null;
  return {
    schema_version: 1,
    generated_by: "role_pickup_pack.ts",
    kind: "role_pickup_pack",
    advisory: true,
    role: opts.role,
    sources: { assignment: opts.assignmentPath, context: opts.contextPath ?? null, role_index: opts.roleIndexPath ?? null },
    task: {
      id: opts.assignmentMd.match(/#([0-9]+)/)?.[1] ?? null,
      title,
      package_id: packageId,
      test_mode: opts.assignmentMd.match(/-\s*Mode:\s*([A-Za-z0-9_-]+)/i)?.[1]?.toLowerCase() ?? null,
    },
    dispatch_context: context.value,
    assignment: {
      goal: firstLine(sections.get("goal")),
      inputs: sectionItems(sections, "inputs"),
      do: sectionItems(sections, "do", "actions"),
      acceptance: sectionItems(sections, "acceptance", "acceptance criteria"),
      allowed_write_paths: sectionItems(sections, "allowed write paths"),
      forbidden_write_paths: sectionItems(sections, "forbidden write paths"),
      expected_outputs: sectionItems(sections, "expected outputs"),
      prepared_context: sectionItems(sections, "prepared context", "prepared context packs"),
    },
    knowledge: { read_first: knowledge.read_first, on_demand: knowledge.on_demand, missing: knowledge.missing },
    warnings,
    note: "Advisory pickup map. Read this first, then open assignment.md and any raw code/policy/evidence the task requires. Missing or stale pack means read raw and continue.",
  };
}

function fail(msg: string): never {
  process.stderr.write(`role_pickup_pack: ${msg}\n`);
  process.exit(2);
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const roleRaw = flag("role") ?? fail("--role is required");
  if (!ROLE_SET.has(roleRaw as PickupRole)) fail("--role must be worker|scout|smith|artisan|librarian|concierge");
  const assignment = flag("assignment") ?? fail("--assignment is required");
  const md = await Bun.file(assignment).text();
  const pack = buildRolePickupPack({
    role: roleRaw as PickupRole,
    assignmentPath: assignment,
    assignmentMd: md,
    contextPath: flag("context") ?? null,
    roleIndexPath: flag("role-index") ?? null,
  });
  const json = JSON.stringify(pack, null, 2) + "\n";
  const out = flag("out");
  if (out) await Bun.write(out, json);
  else process.stdout.write(json);
}

if (import.meta.main) {
  void main();
}
