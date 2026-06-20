// Derived cross-registry knowledge graph + contract validation (DEC-044).
//
// DEC-077: the graph runs over the TWO-LAYER knowledge roots — the SHARED layer
// <project>/__garelier/__atmos/knowledge/ and the PER-PM layer
// <project>/__garelier/<pmId>/knowledge/. Documents and registries are unioned
// across both roots; on a knowledge-relative-path conflict the SHARED layer wins
// and the per-pm copy is flagged `shadowed-by-shared`. Registry references
// (role_index, source_registry, routine_registry) resolve over both roots,
// shared-first.

import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  KnowledgeGraphEdge, KnowledgeGraphFinding, KnowledgeGraphInfo, KnowledgeGraphNode,
} from "./status_types.ts";
import { knowledgeRoots, knowledgeRelPath, hasOverrideShared } from "./knowledge_roots.ts";

const fwd = (p: string): string => p.replace(/\\/g, "/");
const read = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(fwd) : [];
const safe = (s: string): string => s.replace(/"/g, "'").replace(/[\r\n]+/g, " ").slice(0, 80);

// Bounded, symlink-skipping walk (same guards as status_server's garelierFiles:
// lstat + never follow a symlink, depth + entry caps) — a cyclic or
// out-of-tree symlink under a knowledge root must not hang or escape the walk.
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

export function buildKnowledgeGraph(projectRoot: string, pmId?: string): KnowledgeGraphInfo {
  const root = fwd(projectRoot);
  const roots = knowledgeRoots(root, pmId);
  const findings: KnowledgeGraphFinding[] = [];
  // The synthetic root node points at the shared layer's marker.
  const sharedKnowledgeRel = relTo(root, `${roots[0].abs}/knowledge.toml`);
  const nodes: KnowledgeGraphNode[] = [{ id: "knowledge", kind: "knowledge", title: "knowledge", rel: sharedKnowledgeRel }];
  const edges: KnowledgeGraphEdge[] = [];
  const pathNode = new Map<string, string>();        // knowledge-relative path -> node id
  const seenKnowledgeRel = new Map<string, "shared" | "pm">(); // knowledge-relative path -> layer that owns it
  const categoryNode = new Map<string, string>();
  let seq = 0;

  // addDoc takes the absolute file path + the root it was found under so we can
  // compute a knowledge-relative key (shared & per-pm collapse onto the same key).
  const addDoc = (absPath: string, rootAbs: string, layer: "shared" | "pm"): string => {
    const krel = relTo(rootAbs, fwd(absPath));
    const known = pathNode.get(krel);
    if (known) {
      // A per-pm doc whose knowledge-relative path already exists in shared is
      // shadowed (shared-priority) — UNLESS it sets `override_shared: true`, in
      // which case the override is intentional and honored: re-point the node to
      // the per-pm file so lookups and role edges resolve to what a role actually
      // reads (matching resolveKnowledgeRef). Either way, no duplicate node.
      if (layer === "pm" && seenKnowledgeRel.get(krel) === "shared") {
        if (hasOverrideShared(absPath)) {
          const node = nodes.find((n) => n.id === known);
          if (node) { node.rel = relTo(root, fwd(absPath)); node.overridden = true; }
          seenKnowledgeRel.set(krel, "pm");
        } else {
          findings.push({
            severity: "warning", code: "shadowed-by-shared",
            message: `Per-pm knowledge "${krel}" is shadowed by the shared (__atmos) layer.`,
            rel: relTo(root, fwd(absPath)),
          });
        }
      }
      return known;
    }
    const repoRel = relTo(root, fwd(absPath));
    const id = `doc-${seq++}`;
    const body = read(absPath);
    const title = body.match(/^#\s+(.+)$/m)?.[1].trim() ?? basename(krel);
    nodes.push({ id, kind: "document", title, rel: repoRel });
    pathNode.set(krel, id);
    seenKnowledgeRel.set(krel, layer);
    // Category = the first path segment of the knowledge-relative path.
    const cat = krel.includes("/") ? krel.split("/")[0] : "rules";
    if (!categoryNode.has(cat)) {
      const cid = `cat-${seq++}`;
      categoryNode.set(cat, cid);
      nodes.push({ id: cid, kind: "category", title: cat, rel: null });
      edges.push({ from: "knowledge", to: cid, relation: "contains" });
    }
    edges.push({ from: categoryNode.get(cat)!, to: id, relation: "contains" });
    if (/\.(md|markdown)$/i.test(krel) &&
        !/(?:^|\/)index\.md$/i.test(krel) &&
        !/(?:^|\/)(?:runbooks|manuals|external_operations\/runbooks|external_operations\/templates|security\/templates)\//i.test(krel) &&
        !body.startsWith("---\n")) {
      findings.push({ severity: "warning", code: "legacy-knowledge-format", message: "New or materially updated topic documents should use canonical knowledge front matter.", rel: repoRel });
    }
    return id;
  };

  if (!roots.some((r) => existsSync(r.abs))) {
    return { nodes: [], edges: [], findings, counts: {}, mermaid: 'flowchart LR\n  empty["No curated knowledge"]' };
  }
  // Shared first so it owns each knowledge-relative path on conflict.
  for (const r of roots) {
    if (!existsSync(r.abs)) continue;
    for (const abs of files(r.abs)) addDoc(abs, r.abs, r.layer);
  }
  // Project rules (docs/rules) remain a project-root tree, surfaced as-is.
  const rules = join(root, "docs", "rules");
  if (existsSync(rules)) {
    for (const abs of files(rules)) {
      const repoRel = fwd(relative(root, abs));
      if (pathNode.has(repoRel)) continue;
      const id = `doc-${seq++}`;
      const body = read(abs);
      const title = body.match(/^#\s+(.+)$/m)?.[1].trim() ?? basename(repoRel);
      nodes.push({ id, kind: "document", title, rel: repoRel });
      pathNode.set(repoRel, id);
      if (!categoryNode.has("rules")) {
        const cid = `cat-${seq++}`;
        categoryNode.set("rules", cid);
        nodes.push({ id: cid, kind: "category", title: "rules", rel: null });
        edges.push({ from: "knowledge", to: cid, relation: "contains" });
      }
      edges.push({ from: categoryNode.get("rules")!, to: id, relation: "contains" });
    }
  }

  // Resolve a registry reference to a known document node, over both layers.
  // Accepts knowledge-relative and knowledge-root-prefixed forms.
  const lookupDoc = (ref: string): string | undefined => {
    const krel = knowledgeRelPath(ref);
    if (krel == null) return undefined;
    return pathNode.get(krel) ?? pathNode.get(fwd(ref).replace(/^\.?\//, ""));
  };

  // Resolve a registry file across the roots (shared-first); returns the first
  // that exists with its repo-relative path for findings.
  const resolveRegistry = (name: string): { abs: string; rel: string } | null => {
    for (const r of roots) {
      const abs = `${r.abs}/${name}`;
      if (existsSync(abs)) return { abs, rel: relTo(root, abs) };
    }
    // Default to the shared layer path for "missing" findings.
    return null;
  };

  const markerHit = resolveRegistry("knowledge.toml");
  const markerRel = markerHit ? markerHit.rel : sharedKnowledgeRel;
  const marker = markerHit ? toml(markerHit.abs, findings, markerRel) : null;
  if (!marker) findings.push({ severity: "warning", code: "missing-knowledge-marker", message: "knowledge.toml is required for schema-versioned knowledge management.", rel: null });
  else if (marker.kind !== "garelier_knowledge") findings.push({ severity: "error", code: "invalid-knowledge-kind", message: 'knowledge.toml kind must be "garelier_knowledge".', rel: markerRel });

  const sourceHit = resolveRegistry("source_registry.toml");
  const sourceRel = sourceHit ? sourceHit.rel : relTo(root, `${roots[0].abs}/source_registry.toml`);
  for (const s of tables(sourceHit ? toml(sourceHit.abs, findings, sourceRel) : null, "sources")) {
    const idRaw = typeof s.id === "string" ? s.id : `source-${seq}`;
    const id = `source-${seq++}`;
    nodes.push({ id, kind: "source", title: idRaw, rel: sourceRel });
    const target = typeof s.target === "string" ? fwd(s.target) : null;
    if (target) {
      const to = lookupDoc(target);
      if (to) edges.push({ from: id, to, relation: "targets" });
      else findings.push({ severity: "warning", code: "missing-source-target", message: `Source "${idRaw}" target is missing: ${target}`, rel: sourceRel });
    }
  }

  const routineHit = resolveRegistry("routine_registry.toml");
  const routineRel = routineHit ? routineHit.rel : relTo(root, `${roots[0].abs}/routine_registry.toml`);
  for (const r of tables(routineHit ? toml(routineHit.abs, findings, routineRel) : null, "routines")) {
    const idRaw = typeof r.id === "string" ? r.id : `routine-${seq}`;
    const id = `routine-${seq++}`;
    nodes.push({ id, kind: "routine", title: idRaw, rel: routineRel });
    const manual = typeof r.manual === "string" ? fwd(r.manual) : null;
    if (manual) {
      const to = lookupDoc(manual);
      if (to) edges.push({ from: id, to, relation: "manual" });
      else findings.push({ severity: "error", code: "missing-routine-manual", message: `Routine "${idRaw}" manual is missing: ${manual}`, rel: routineRel });
    }
    const source = typeof r.source_id === "string" ? r.source_id : null;
    const sourceNode = source ? nodes.find((n) => n.kind === "source" && n.title === source) : null;
    if (source && sourceNode) edges.push({ from: id, to: sourceNode.id, relation: "uses_source" });
    else if (source) findings.push({ severity: "error", code: "missing-routine-source", message: `Routine "${idRaw}" references unknown source: ${source}`, rel: routineRel });
  }

  const roleHit = resolveRegistry("role_index.toml");
  const roleRel = roleHit ? roleHit.rel : relTo(root, `${roots[0].abs}/role_index.toml`);
  const roles = tables(roleHit ? toml(roleHit.abs, findings, roleRel) : null, "roles");
  for (const r of roles) {
    const role = typeof r.id === "string" ? r.id : `role-${seq}`;
    const id = `role-${seq++}`;
    nodes.push({ id, kind: "role", title: role, rel: roleRel });
    for (const [key, relation] of [["read_first", "reads_first"], ["on_demand", "reads"]] as const) {
      for (const target of strings(r[key])) {
        const to = lookupDoc(target);
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

// Local relTo helper (knowledge-relative / repo-relative path math).
function relTo(rootAbs: string, abs: string): string {
  const r = fwd(rootAbs).replace(/\/+$/, "");
  const a = fwd(abs);
  return a.startsWith(r + "/") ? a.slice(r.length + 1) : a;
}
