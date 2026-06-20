// DEC-077: two-layer knowledge roots — per-pm home + optional shared `__atmos`.
//
// Garelier curated knowledge lives in TWO tracked layers under `__garelier/`:
//
//   PER-PM (the home; seeded at setup): <projectRoot>/__garelier/<pmId>/knowledge
//   SHARED (OPTIONAL, on demand):       <projectRoot>/__garelier/__atmos/knowledge
//
// The per-pm layer is where the bundled templates are seeded and where a pm/dev
// keeps its knowledge. The shared `__atmos` tier is created ONLY when the user
// decides to share knowledge project-wide — it does NOT exist at first setup, so
// every resolver treats it as optional.
//
// RESOLUTION (for a knowledge-relative path present in more than one layer):
//   - DEFAULT: the SHARED (`__atmos`) layer wins — shared knowledge is canonical
//     project-wide; the per-pm layer is otherwise additive (adds ids absent from
//     shared). This honors "never silently change the meaning of a shared rule".
//   - PER-TOPIC OVERRIDE: a per-pm topic whose YAML front matter sets
//     `override_shared: true` wins over the shared copy for THAT knowledge id — an
//     explicit, auditable opt-in so a pm can prefer its own version of one topic.
//
// Knowledge-relative paths (e.g. `engineering/index.md`, `role_index.toml`) are
// stored relative to a knowledge root. A registry / role_index entry that carries
// a full repo-relative `__garelier/<layer>/knowledge/...` prefix is normalized
// back to the knowledge-relative form.

import { existsSync, openSync, readSync, closeSync } from "node:fs";

const fwd = (p: string): string => p.replace(/\\/g, "/");

export type KnowledgeLayer = "shared" | "pm";

export interface KnowledgeRoot {
  /** "shared" (`__atmos`) or "pm" (`<pmId>`). */
  layer: KnowledgeLayer;
  /** Absolute, forward-slashed root directory (…/knowledge). */
  abs: string;
}

const SHARED_REL = "__garelier/__atmos/knowledge";
const pmRel = (pmId: string): string => `__garelier/${pmId}/knowledge`;

/**
 * The knowledge roots for (projectRoot, pmId). Ordered SHARED first (canonical),
 * then PER-PM (additive). The per-pm root is omitted when no pmId is supplied;
 * the shared root may not exist on disk (it is created on demand). Roots are
 * returned regardless of existence — consumers check per file. Precedence on a
 * same-path conflict is decided by resolveKnowledgeRef (shared wins unless the
 * per-pm topic sets `override_shared: true`), NOT by this order alone.
 */
export function knowledgeRoots(projectRoot: string, pmId?: string): KnowledgeRoot[] {
  const root = fwd(projectRoot).replace(/\/+$/, "");
  const roots: KnowledgeRoot[] = [{ layer: "shared", abs: `${root}/${SHARED_REL}` }];
  if (pmId && pmId.trim()) roots.push({ layer: "pm", abs: `${root}/${pmRel(pmId.trim())}` });
  return roots;
}

/**
 * Does this knowledge file opt to override the shared layer? True when its YAML
 * front matter (the leading `---` block) carries `override_shared: true`. Cheap,
 * dependency-free head read; only meaningful for Markdown topics. Returns false
 * for missing / non-front-matter / non-flagged files.
 */
export function hasOverrideShared(abs: string): boolean {
  let fd: number;
  try { fd = openSync(abs, "r"); } catch { return false; }
  try {
    const buf = Buffer.alloc(2048);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString("utf8", 0, n).replace(/^﻿/, "");
    if (!/^\s*---\r?\n/.test(head)) return false; // no front matter
    const end = head.indexOf("\n---", 3);
    const fm = end >= 0 ? head.slice(0, end) : head;
    return /(^|\r?\n)\s*override_shared\s*:\s*true\s*(\r?\n|$)/.test(fm);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Normalize a knowledge reference to the form relative to a knowledge root.
 * Accepts the knowledge-relative form (`engineering/index.md`) and a full
 * repo-relative form carrying a knowledge-root prefix
 * (`__garelier/__atmos/knowledge/role_index.toml` → `role_index.toml`).
 * Returns null when the reference escapes its root (contains `..`) or is absolute.
 */
export function knowledgeRelPath(ref: string): string | null {
  if (!ref) return null;
  let clean = fwd(ref).replace(/^\.?\//, "").replace(/^\/+/, "");
  if (/^[A-Za-z]:\//.test(clean)) return null; // absolute windows path
  // Collapse a knowledge-root prefix if the ref carries one, so registry /
  // role_index entries resolve whether they store a knowledge-relative path
  // (`engineering/index.md`) or a full repo-relative one
  // (`__garelier/__atmos/knowledge/...` or `__garelier/<pmId>/knowledge/...`).
  clean = clean.replace(/^__garelier\/[^/]+\/knowledge\//, "");
  if (!clean || clean.split("/").some((part) => part === "..")) return null;
  return clean;
}

/**
 * Resolve a knowledge-relative path against the two layers with the DEC-077
 * precedence: the SHARED (`__atmos`) copy wins by default, EXCEPT when a per-pm
 * copy exists and sets `override_shared: true` in its front matter — then the
 * per-pm copy wins for that path (`overridden: true`). Falls back to whichever
 * single layer has the file. Returns null when the ref is unsafe or absent from
 * every layer.
 */
export function resolveKnowledgeRef(
  projectRoot: string,
  pmId: string | undefined,
  ref: string,
): { layer: KnowledgeLayer; abs: string; repoRel: string; knowledgeRel: string; overridden: boolean } | null {
  const krel = knowledgeRelPath(ref);
  if (krel == null) return null;
  const root = fwd(projectRoot).replace(/\/+$/, "");
  const repoRelOf = (abs: string): string => (abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs);

  let shared: string | null = null;
  let pm: string | null = null;
  for (const r of knowledgeRoots(projectRoot, pmId)) {
    const abs = `${r.abs}/${krel}`;
    if (!existsSync(abs)) continue;
    if (r.layer === "shared") shared = abs;
    else pm = abs;
  }

  // per-pm topic may opt to win over shared for this id
  if (pm && shared && hasOverrideShared(pm)) {
    return { layer: "pm", abs: pm, repoRel: repoRelOf(pm), knowledgeRel: krel, overridden: true };
  }
  if (shared) return { layer: "shared", abs: shared, repoRel: repoRelOf(shared), knowledgeRel: krel, overridden: false };
  if (pm) return { layer: "pm", abs: pm, repoRel: repoRelOf(pm), knowledgeRel: krel, overridden: false };
  return null;
}
