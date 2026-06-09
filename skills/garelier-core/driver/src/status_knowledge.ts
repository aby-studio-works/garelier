// Knowledge page data for the read-only Status Web Console.
//
// Surfaces the Librarian-managed knowledge trees under
// <project>/docs/garelier/<category>/ (DEC-029) as a categorized index.
// These are tracked files, so the client opens each via /api/file. Reads only;
// best-effort (a missing tree yields present:false).

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
const ROLE_INDEX_REL = "docs/garelier/knowledge/role_index.toml";

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

function roleIndexDoc(root: string, rel: string): KnowledgeDoc | null {
  const clean = fwd(rel).replace(/^\.?\//, "");
  if (!clean.startsWith("docs/garelier/") || clean.includes("..")) return null;
  const p = `${root}/${clean}`;
  if (!existsSync(p)) return null;
  const name = clean.split("/").pop() ?? clean;
  return { name, title: docTitle(p, name), rel: clean, updatedAt: mtimeIso(p) };
}

function docsFromRolePaths(root: string, paths: string[]): { docs: KnowledgeDoc[]; missing: string[] } {
  const docs: KnowledgeDoc[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const rel = fwd(raw).replace(/^\.?\//, "");
    if (seen.has(rel)) continue;
    seen.add(rel);
    const doc = roleIndexDoc(root, rel);
    if (doc) docs.push(doc);
    else missing.push(rel);
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

function buildRoleIndex(root: string): RoleKnowledgeInfo {
  const p = `${root}/${ROLE_INDEX_REL}`;
  if (!existsSync(p)) return emptyRoleIndex();
  try {
    const data = parseToml(readFileSync(p, "utf8")) as unknown;
    const roles: RoleKnowledgeEntry[] = roleRecords(data).map(([role, body]) => {
      const first = docsFromRolePaths(root, strArray(body.read_first));
      const demand = docsFromRolePaths(root, strArray(body.on_demand));
      const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
      return {
        role,
        readFirst: first.docs,
        onDemand: demand.docs,
        missing: [...first.missing, ...demand.missing],
        unionOf: strArray(body.union_of),
        note,
      };
    });
    return { present: true, rel: ROLE_INDEX_REL, roles };
  } catch (e) {
    return { present: true, rel: ROLE_INDEX_REL, roles: [], error: (e as Error).message };
  }
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
  const base = `${root}/docs/garelier`;
  const local = pmId ? localArea(root, pmId) : undefined;
  const roleIndex = buildRoleIndex(root);
  const graph = buildKnowledgeGraph(root);
  if (!existsSync(base)) return { present: false, categories: [], roleIndex, local, graph };

  let dirs: string[] = [];
  try {
    dirs = readdirSync(base).filter((n) => {
      try { return statSync(`${base}/${n}`).isDirectory(); } catch { return false; }
    });
  } catch { return { present: false, categories: [], roleIndex, local, graph }; }

  // Canonical order first, then any remaining directories alphabetically.
  const ordered = [
    ...CANONICAL.filter((c) => dirs.includes(c)),
    ...dirs.filter((d) => !CANONICAL.includes(d)).sort(),
  ];

  const categories: KnowledgeCategory[] = [];
  for (const c of ordered) {
    const dir = `${base}/${c}`;
    const docs = collectKnowledgeDocs(root, dir, 2);
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
