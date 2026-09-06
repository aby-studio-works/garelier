// Canonical two-layer Knowledge resolver for role authorization (W-387).
//
// The pickup pack remains advisory. This module resolves the same role read-set
// from tracked shared/per-PM Knowledge, hashes the selected bytes, and rejects
// unsafe/missing references before an authorization can be issued.

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { knowledgeRelPath, knowledgeRoots, resolveKnowledgeRef, type KnowledgeLayer } from "../knowledge_roots.ts";
import { matchRoleIndexTriggers, type RoleIndexTrigger } from "../role_pickup_pack.ts";

export interface RoleKnowledgeDocument {
  layer: KnowledgeLayer;
  path: string;
  knowledge_path: string;
  content_hash: string;
  overridden: boolean;
}
export interface RoleKnowledgeIndex {
  layer: KnowledgeLayer;
  path: string;
  content_hash: string;
}

export interface RoleKnowledgeBinding {
  schema_version: 1;
  role: string;
  required: string[];
  triggered: string[];
  indexes: RoleKnowledgeIndex[];
  documents: RoleKnowledgeDocument[];
}

export interface ResolveRoleKnowledgeOptions {
  projectRoot: string;
  pmId: string;
  role: string;
  assignmentMd?: string;
  required?: string[];
}

function fwd(value: string): string { return value.replace(/\\/g, "/"); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()) : [];
}
function repoRelative(projectRoot: string, path: string): string {
  const rel = fwd(relative(resolve(projectRoot), resolve(path)));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`role knowledge path escapes project root: ${path}`);
  }
  return rel;
}
function assertCanonicalFile(projectRoot: string, root: string, path: string): void {
  if (!existsSync(path)) throw new Error(`required role knowledge is missing: ${repoRelative(projectRoot, path)}`);
  const stat = lstatSync(path);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`role knowledge is not a file: ${repoRelative(projectRoot, path)}`);
  const realRoot = realpathSync(root);
  const real = realpathSync(path);
  const rel = fwd(relative(realRoot, real));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`role knowledge symlink escapes its canonical layer: ${repoRelative(projectRoot, path)}`);
  }
}

/** Resolve the role's shared + per-PM read_first sets, followed by explicit
 * task-required refs. Shared index entries are ordered first; duplicates are
 * resolved once through DEC-077 precedence. An absent registry with no required
 * refs is a valid empty Knowledge binding. */
export function resolveRoleKnowledgeBinding(options: ResolveRoleKnowledgeOptions): RoleKnowledgeBinding {
  const projectRoot = resolve(options.projectRoot);
  const roots = knowledgeRoots(projectRoot, options.pmId);
  const readFirst: string[] = [];
  const triggers: RoleIndexTrigger[] = [];
  const indexes: RoleKnowledgeIndex[] = [];
  for (const root of roots) {
    const indexPath = resolve(root.abs, "role_index.toml");
    if (!existsSync(indexPath)) continue;
    assertCanonicalFile(projectRoot, root.abs, indexPath);
    const bytes = readFileSync(indexPath);
    let parsed: Record<string, unknown>;
    try { parsed = parseToml(bytes.toString("utf8")) as Record<string, unknown>; }
    catch (error) { throw new Error(`role knowledge role_index parse failed (${repoRelative(projectRoot, indexPath)}): ${(error as Error).message}`); }
    const roles = parsed.roles && typeof parsed.roles === "object" ? parsed.roles as Record<string, unknown> : {};
    const role = roles[options.role] && typeof roles[options.role] === "object" ? roles[options.role] as Record<string, unknown> : {};
    readFirst.push(...strings(role.read_first));
    triggers.push(...(Array.isArray(parsed.triggers) ? parsed.triggers : [])
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .map((entry) => ({ when: strings(entry.when), read: strings(entry.read) }))
      .filter((entry) => entry.when.length > 0 && entry.read.length > 0));
    indexes.push({ layer: root.layer, path: repoRelative(projectRoot, indexPath), content_hash: sha256(bytes) });
  }
  const triggered = matchRoleIndexTriggers(options.assignmentMd ?? "", triggers, readFirst);
  const required = (options.required ?? []).map((raw) => {
    const normalized = knowledgeRelPath(raw);
    if (!normalized) throw new Error(`role knowledge reference is non-canonical: ${raw}`);
    return normalized;
  });
  const refs = [...readFirst, ...triggered, ...required];

  const seen = new Set<string>();
  const documents: RoleKnowledgeDocument[] = [];
  for (const raw of refs) {
    const normalized = knowledgeRelPath(raw);
    if (!normalized) throw new Error(`role knowledge reference is non-canonical: ${raw}`);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const selected = resolveKnowledgeRef(projectRoot, options.pmId, raw);
    if (!selected) throw new Error(`required role knowledge is missing: ${normalized}`);
    const root = roots.find((entry) => entry.layer === selected.layer);
    if (!root) throw new Error(`role knowledge resolved to unknown layer: ${selected.layer}`);
    assertCanonicalFile(projectRoot, root.abs, selected.abs);
    documents.push({
      layer: selected.layer,
      path: repoRelative(projectRoot, selected.abs),
      knowledge_path: selected.knowledgeRel,
      content_hash: sha256(readFileSync(selected.abs)),
      overridden: selected.overridden,
    });
  }
  return {
    schema_version: 1,
    role: options.role,
    required: [...new Set(required)],
    triggered: [...new Set(triggered.map((entry) => knowledgeRelPath(entry)).filter((entry): entry is string => !!entry))],
    indexes,
    documents,
  };
}
