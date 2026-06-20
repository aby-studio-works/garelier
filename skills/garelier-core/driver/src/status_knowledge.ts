// Knowledge page data for the read-only Status Web Console.
//
// Surfaces the Librarian-managed knowledge trees under the two-layer knowledge
// roots (DEC-077): the SHARED layer <project>/__garelier/__atmos/knowledge/ and
// the PER-PM layer <project>/__garelier/<pmId>/knowledge/. These are tracked
// files, so the client opens each via /api/file. Reads only; best-effort (a
// missing tree yields present:false). Resolution is shared-priority +
// per-pm-additive: on a relative-path conflict the shared layer wins.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import type {
  KnowledgeInfo,
  KnowledgeCategory,
  KnowledgeDoc,
  RoleKnowledgeEntry,
  RoleKnowledgeInfo,
} from "./status_types.ts";
import { buildKnowledgeGraph } from "./status_knowledge_graph.ts";
import { knowledgeRoots, knowledgeRelPath, resolveKnowledgeRef, hasOverrideShared } from "./knowledge_roots.ts";

const fwd = (p: string): string => p.replace(/\\/g, "/");
const relTo = (root: string, abs: string): string => {
  const r = fwd(root).replace(/\/+$/, "");
  const a = fwd(abs);
  return a.startsWith(r + "/") ? a.slice(r.length + 1) : a;
};
function mtimeIso(p: string): string | null {
  try { return new Date(statSync(p).mtimeMs).toISOString(); } catch { return null; }
}
function firstHeading(p: string): string | null {
  try {
    const h = readFileSync(p, "utf8").match(/^#\s+(.+)$/m);
    return h ? h[1].trim() : null;
  } catch { return null; }
}

const KNOWLEDGE_FILE = /\.(md|markdown|toml|ya?ml|jsonc?|txt)$/i;
const PRIMARY_DOC = /^(index\.md|role_index\.toml)$/i;
// Knowledge-root-relative location of the role index (DEC-077).
const ROLE_INDEX_REL = "role_index.toml";

function docTitle(p: string, name: string): string | null {
  if (/\.(md|markdown)$/i.test(name)) return firstHeading(p);
  return null;
}

// Recursively collect displayable knowledge files under dir (bounded depth),
// repo-relative. Markdown pages and TOML/YAML/JSON/TXT registries are all
// Librarian-owned knowledge; do not hide registries such as role_index.toml.
function collectKnowledgeDocs(root: string, dir: string, depth: number): KnowledgeDoc[] {
  if (depth < 0) return [];
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: KnowledgeDoc[] = [];
  for (const name of entries) {
    const p = `${dir}/${name}`;
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (isDir) {
      out.push(...collectKnowledgeDocs(root, p, depth - 1));
    } else if (KNOWLEDGE_FILE.test(name)) {
      out.push({ name, title: docTitle(p, name), rel: relTo(root, p), updatedAt: mtimeIso(p) });
    }
  }
  return out;
}

// Category order matches the canonical knowledge tree (DEC-029) plus any extra
// directory found on disk (e.g. external_operations), so nothing is hidden.
const CANONICAL = ["knowledge", "engineering", "quality", "review", "system", "security", "external_operations"];

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => fwd(x.trim()))
    : [];
}

// Resolve a role-index knowledge reference over the two-layer roots
// (shared-priority).
function roleIndexDoc(projectRoot: string, pmId: string | undefined, ref: string): KnowledgeDoc | null {
  const hit = resolveKnowledgeRef(projectRoot, pmId, ref);
  if (!hit) return null;
  const name = hit.repoRel.split("/").pop() ?? hit.repoRel;
  return { name, title: docTitle(hit.abs, name), rel: hit.repoRel, updatedAt: mtimeIso(hit.abs), layer: hit.layer, overridden: hit.overridden };
}

function docsFromRolePaths(
  projectRoot: string,
  pmId: string | undefined,
  paths: string[],
): { docs: KnowledgeDoc[]; missing: string[] } {
  const docs: KnowledgeDoc[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const krel = knowledgeRelPath(raw) ?? fwd(raw).replace(/^\.?\//, "");
    if (seen.has(krel)) continue;
    seen.add(krel);
    const doc = roleIndexDoc(projectRoot, pmId, raw);
    if (doc) docs.push(doc);
    else missing.push(krel);
  }
  return { docs, missing };
}

function roleRecords(data: unknown): Array<[string, Record<string, unknown>]> {
  const root = asRecord(data);
  const roles = root ? root.roles : null;
  if (Array.isArray(roles)) {
    return roles
      .map((r, i): [string, Record<string, unknown>] | null => {
        const body = asRecord(r);
        if (!body) return null;
        const id = typeof body.role === "string" ? body.role : typeof body.id === "string" ? body.id : `role-${i + 1}`;
        return [id, body];
      })
      .filter((x): x is [string, Record<string, unknown>] => !!x);
  }
  const table = asRecord(roles);
  if (!table) return [];
  return Object.entries(table)
    .map(([role, body]): [string, Record<string, unknown>] | null => {
      const rec = asRecord(body);
      return rec ? [role, rec] : null;
    })
    .filter((x): x is [string, Record<string, unknown>] => !!x);
}

function emptyRoleIndex(): RoleKnowledgeInfo {
  return { present: false, rel: null, roles: [] };
}

// Build the role index over the two-layer roots (DEC-077). role_index.toml
// entries are UNIONED across the layers, shared-first: a role present in both
// layers merges its read_first/on_demand (shared entries first, deduped by
// knowledge-relative path), and a per-pm-only role is added. Each referenced
// knowledge path is resolved over both roots with shared-priority
// (override_shared honored).
function buildRoleIndex(projectRoot: string, pmId: string | undefined): RoleKnowledgeInfo {
  const layers: Array<{ data: unknown }> = [];
  let firstRel: string | null = null;
  let parseError: string | undefined;
  for (const r of knowledgeRoots(projectRoot, pmId)) {
    const p = `${r.abs}/${ROLE_INDEX_REL}`;
    if (!existsSync(p)) continue;
    if (firstRel == null) firstRel = relTo(projectRoot, p);
    try {
      layers.push({ data: parseToml(readFileSync(p, "utf8")) as unknown });
    } catch (e) {
      if (!parseError) parseError = (e as Error).message;
    }
  }
  if (firstRel == null) return emptyRoleIndex();
  if (!layers.length) return { present: true, rel: firstRel, roles: [], error: parseError };

  // Merge role records shared-first, preserving first-seen role order.
  type Merged = { readFirst: string[]; onDemand: string[]; unionOf: string[]; note: string | null };
  const merged = new Map<string, Merged>();
  const order: string[] = [];
  for (const { data } of layers) {
    for (const [role, body] of roleRecords(data)) {
      let m = merged.get(role);
      if (!m) { m = { readFirst: [], onDemand: [], unionOf: [], note: null }; merged.set(role, m); order.push(role); }
      m.readFirst.push(...strArray(body.read_first));
      m.onDemand.push(...strArray(body.on_demand));
      m.unionOf.push(...strArray(body.union_of));
      if (!m.note) {
        const n = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
        if (n) m.note = n;
      }
    }
  }
  const roles: RoleKnowledgeEntry[] = order.map((role) => {
    const m = merged.get(role)!;
    const first = docsFromRolePaths(projectRoot, pmId, m.readFirst);
    const demand = docsFromRolePaths(projectRoot, pmId, m.onDemand);
    return {
      role,
      readFirst: first.docs,
      onDemand: demand.docs,
      missing: [...first.missing, ...demand.missing],
      unionOf: [...new Set(m.unionOf)],
      note: m.note,
    };
  });
  return parseError
    ? { present: true, rel: firstRel, roles, error: parseError }
    : { present: true, rel: firstRel, roles };
}

// Count files in the Librarian's local-only working area (DEC-038), if present.
function localArea(root: string, pmId: string): { raw: number; cache: number; drafts: number } | undefined {
  const base = `${root}/__garelier/${pmId}/runtime/librarian`;
  if (!existsSync(base)) return undefined;
  const count = (sub: string): number => {
    try { return readdirSync(`${base}/${sub}`).filter((n) => !n.startsWith(".")).length; }
    catch { return 0; }
  };
  return { raw: count("raw"), cache: count("cache"), drafts: count("drafts") };
}

export function buildKnowledge(projectRoot: string, pmId?: string): KnowledgeInfo {
  const root = fwd(projectRoot);
  const local = pmId ? localArea(root, pmId) : undefined;
  const roleIndex = buildRoleIndex(root, pmId);
  const graph = buildKnowledgeGraph(root, pmId);

  const roots = knowledgeRoots(root, pmId);
  if (!roots.some((r) => existsSync(r.abs))) {
    return { present: false, categories: [], roleIndex, local, graph };
  }

  // Union category directories across both roots, then collect docs over both
  // roots per category with shared-priority on relative-path conflict.
  const dirSet = new Set<string>();
  for (const r of roots) {
    if (!existsSync(r.abs)) continue;
    try {
      for (const n of readdirSync(r.abs)) {
        try { if (statSync(`${r.abs}/${n}`).isDirectory()) dirSet.add(n); } catch { /* skip */ }
      }
    } catch { /* skip root */ }
  }
  const dirs = [...dirSet];

  // Canonical order first, then any remaining directories alphabetically.
  const ordered = [
    ...CANONICAL.filter((c) => dirs.includes(c)),
    ...dirs.filter((d) => !CANONICAL.includes(d)).sort(),
  ];

  const categories: KnowledgeCategory[] = [];
  for (const c of ordered) {
    // Merge docs from shared then per-pm; shared wins on a knowledge-relative
    // path by default, EXCEPT a per-pm topic with `override_shared: true`, which
    // wins for that id and is tagged overridden (DEC-077).
    const byKnowledgeRel = new Map<string, KnowledgeDoc>();
    const ownerLayer = new Map<string, "shared" | "pm">();
    for (const r of roots) {
      const dir = `${r.abs}/${c}`;
      if (!existsSync(dir)) continue;
      for (const d of collectKnowledgeDocs(root, dir, 2)) {
        // knowledge-relative path = repo-rel with the root prefix stripped.
        const krel = relTo(r.abs, `${root}/${d.rel}`);
        if (!byKnowledgeRel.has(krel)) {
          byKnowledgeRel.set(krel, { ...d, layer: r.layer }); // shared first wins
          ownerLayer.set(krel, r.layer);
        } else if (r.layer === "pm" && ownerLayer.get(krel) === "shared"
                   && hasOverrideShared(`${root}/${d.rel}`)) {
          byKnowledgeRel.set(krel, { ...d, layer: "pm", overridden: true });
          ownerLayer.set(krel, "pm");
        }
      }
    }
    const docs = [...byKnowledgeRel.values()];
    if (!docs.length) continue;
    docs.sort((a, b) => {
      if (PRIMARY_DOC.test(a.name) && !PRIMARY_DOC.test(b.name)) return -1;
      if (PRIMARY_DOC.test(b.name) && !PRIMARY_DOC.test(a.name)) return 1;
      return a.rel.localeCompare(b.rel);
    });
    const index = docs.find((d) => d.name === "index.md");
    categories.push({ category: c, indexRel: index ? index.rel : null, docs });
  }

  return { present: categories.length > 0, categories, roleIndex, local, graph };
}
