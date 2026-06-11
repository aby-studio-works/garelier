// Derived cross-registry knowledge graph + contract validation (DEC-044).

import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  KnowledgeGraphEdge, KnowledgeGraphFinding, KnowledgeGraphInfo, KnowledgeGraphNode,
} from "./status_types.ts";

const fwd = (p: string): string => p.replace(/\\/g, "/");
const read = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(fwd) : [];
const safe = (s: string): string => s.replace(/"/g, "'").replace(/[\r\n]+/g, " ").slice(0, 80);

// Bounded, symlink-skipping walk (same guards as status_server's garelierFiles:
// lstat + never follow a symlink, depth + entry caps) — a cyclic or
// out-of-tree symlink under docs/garelier/ must not hang or escape the walk.
export function files(dir: string): string[] {
  const out: string[] = [];
  const MAX_DEPTH = 12, MAX_ENTRIES = 5000;
  const visit = (d: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries.sort()) {
      if (out.length >= MAX_ENTRIES) return;
      const p = join(d, name);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) visit(p, depth + 1);
        else out.push(p);
      } catch { /* best effort */ }
    }
  };
  visit(dir, 0);
  return out;
}

function toml(path: string, findings: KnowledgeGraphFinding[], rel?: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try { return rec(parseToml(read(path)) as unknown); }
  catch (e) {
    findings.push({ severity: "error", code: "invalid-toml", message: (e as Error).message, rel: rel ?? fwd(path) });
    return null;
  }
}

function tables(data: Record<string, unknown> | null, key: string): Record<string, unknown>[] {
  const v = data?.[key];
  if (Array.isArray(v)) return v.map(rec).filter((x): x is Record<string, unknown> => !!x);
  const r = rec(v);
  return r ? Object.entries(r).map(([id, body]) => ({ id, ...(rec(body) ?? {}) })) : [];
}

export function buildKnowledgeGraph(projectRoot: string): KnowledgeGraphInfo {
  const root = fwd(projectRoot);
  const base = join(root, "docs", "garelier");
  const findings: KnowledgeGraphFinding[] = [];
  const nodes: KnowledgeGraphNode[] = [{ id: "knowledge", kind: "knowledge", title: "docs/garelier", rel: "docs/garelier/knowledge/knowledge.toml" }];
  const edges: KnowledgeGraphEdge[] = [];
  const pathNode = new Map<string, string>();
  const categoryNode = new Map<string, string>();
  let seq = 0;
  const addDoc = (rel: string): string => {
    const known = pathNode.get(rel);
    if (known) return known;
    const id = `doc-${seq++}`;
    const body = read(join(root, rel));
    const title = body.match(/^#\s+(.+)$/m)?.[1].trim() ?? basename(rel);
    nodes.push({ id, kind: "document", title, rel });
    pathNode.set(rel, id);
    const parts = rel.split("/");
    const cat = parts[0] === "docs" && parts[1] === "garelier" ? parts[2] : "rules";
    if (!categoryNode.has(cat)) {
      const cid = `cat-${seq++}`;
      categoryNode.set(cat, cid);
      nodes.push({ id: cid, kind: "category", title: cat, rel: null });
      edges.push({ from: "knowledge", to: cid, relation: "contains" });
    }
    edges.push({ from: categoryNode.get(cat)!, to: id, relation: "contains" });
    if (/\.(md|markdown)$/i.test(rel) &&
        !/\/index\.md$/i.test(rel) &&
        !/\/(?:runbooks|manuals|external_operations\/runbooks|external_operations\/templates|security\/templates)\//i.test(rel) &&
        !body.startsWith("---\n")) {
      findings.push({ severity: "warning", code: "legacy-knowledge-format", message: "New or materially updated topic documents should use canonical knowledge front matter.", rel });
    }
    return id;
  };

  if (!existsSync(base)) return { nodes: [], edges: [], findings, counts: {}, mermaid: 'flowchart LR\n  empty["No curated knowledge"]' };
  for (const abs of files(base)) addDoc(fwd(relative(root, abs)));
  const rules = join(root, "docs", "rules");
  if (existsSync(rules)) for (const abs of files(rules)) addDoc(fwd(relative(root, abs)));

  const markerRel = "docs/garelier/knowledge/knowledge.toml";
  const marker = toml(join(root, markerRel), findings, markerRel);
  if (!marker) findings.push({ severity: "warning", code: "missing-knowledge-marker", message: "knowledge.toml is required for schema-versioned knowledge management.", rel: null });
  else if (marker.kind !== "garelier_knowledge") findings.push({ severity: "error", code: "invalid-knowledge-kind", message: 'knowledge.toml kind must be "garelier_knowledge".', rel: markerRel });

  const sourceRel = "docs/garelier/knowledge/source_registry.toml";
  for (const s of tables(toml(join(root, sourceRel), findings, sourceRel), "sources")) {
    const idRaw = typeof s.id === "string" ? s.id : `source-${seq}`;
    const id = `source-${seq++}`;
    nodes.push({ id, kind: "source", title: idRaw, rel: sourceRel });
    const target = typeof s.target === "string" ? fwd(s.target) : null;
    if (target) {
      const to = pathNode.get(target);
      if (to) edges.push({ from: id, to, relation: "targets" });
      else findings.push({ severity: "warning", code: "missing-source-target", message: `Source "${idRaw}" target is missing: ${target}`, rel: sourceRel });
    }
  }

  const routineRel = "docs/garelier/knowledge/routine_registry.toml";
  for (const r of tables(toml(join(root, routineRel), findings, routineRel), "routines")) {
    const idRaw = typeof r.id === "string" ? r.id : `routine-${seq}`;
    const id = `routine-${seq++}`;
    nodes.push({ id, kind: "routine", title: idRaw, rel: routineRel });
    const manual = typeof r.manual === "string" ? fwd(r.manual) : null;
    if (manual) {
      const to = pathNode.get(manual);
      if (to) edges.push({ from: id, to, relation: "manual" });
      else findings.push({ severity: "error", code: "missing-routine-manual", message: `Routine "${idRaw}" manual is missing: ${manual}`, rel: routineRel });
    }
    const source = typeof r.source_id === "string" ? r.source_id : null;
    const sourceNode = source ? nodes.find((n) => n.kind === "source" && n.title === source) : null;
    if (source && sourceNode) edges.push({ from: id, to: sourceNode.id, relation: "uses_source" });
    else if (source) findings.push({ severity: "error", code: "missing-routine-source", message: `Routine "${idRaw}" references unknown source: ${source}`, rel: routineRel });
  }

  const roleRel = "docs/garelier/knowledge/role_index.toml";
  const roles = tables(toml(join(root, roleRel), findings, roleRel), "roles");
  for (const r of roles) {
    const role = typeof r.id === "string" ? r.id : `role-${seq}`;
    const id = `role-${seq++}`;
    nodes.push({ id, kind: "role", title: role, rel: roleRel });
    for (const [key, relation] of [["read_first", "reads_first"], ["on_demand", "reads"]] as const) {
      for (const target of strings(r[key])) {
        const to = pathNode.get(target);
        if (to) edges.push({ from: id, to, relation });
        else findings.push({ severity: "error", code: "missing-role-knowledge", message: `Role "${role}" references missing knowledge: ${target}`, rel: roleRel });
      }
    }
  }

  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  const mermaid = ["flowchart LR", ...nodes.map((n) => `  ${n.id}["${safe(n.title)}"]`), ...edges.map((e) => `  ${e.from} -->|${e.relation}| ${e.to}`)].join("\n");
  return { nodes, edges, findings, counts, mermaid };
}
