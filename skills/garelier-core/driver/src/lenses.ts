// Lens Pack / Lens Group parsing and validation.
//
// A Lens changes a role's judgement focus only. It never changes the role
// contract, permissions, write paths, MUST BLOCK conditions, or handoff format.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";

export const LENS_ROLES = [
  "pm",
  "dock",
  "worker",
  "scout",
  "smith",
  "librarian",
  "guardian",
  "observer",
  "concierge",
  "artisan",
  "wanderer",
] as const;

export type LensRole = (typeof LENS_ROLES)[number];

export interface LensRef {
  packId: string;
  groupId: string;
  raw: string;
}

export interface LensRegistryPack {
  id: string;
  role: LensRole | null;
  path: string;
  status: string;
  defaultGroup: string | null;
}

export interface LensRegistry {
  schemaVersion: number;
  kind: string;
  packs: LensRegistryPack[];
}

export interface LensGroup {
  id: string;
  status: string;
  label: string;
  description: string;
  focus: Record<string, unknown>;
  limits: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface LensPack {
  id: string;
  role: LensRole | null;
  schemaVersion: number;
  status: string;
  description: string;
  groups: LensGroup[];
}

export type LensIssueLevel = "error" | "warn";

export interface LensIssue {
  level: LensIssueLevel;
  code: string;
  message: string;
  path?: string;
}

export interface LensSelection {
  source: "defaults" | "explicit" | "none";
  byRole: Map<LensRole, LensRef>;
}

export const DEFAULT_LENS_REFS: Record<LensRole, string> = {
  pm: "pm.planning:delivery_balanced",
  dock: "dock.dispatch:balanced",
  worker: "worker.implementation:minimal_patch",
  scout: "scout.investigation:source_first",
  smith: "smith.integration:compatibility",
  librarian: "librarian.source:strict",
  guardian: "guardian.risk_control:strict",
  observer: "observer.review:architecture",
  concierge: "concierge.external_ops:explicit_only",
  artisan: "artisan.creation:interface_first",
  wanderer: "wanderer.dialogue:sdd",
};

export const FORBIDDEN_LENS_FIELD_RE =
  /^(allow_protected_path|allow_external_write|allow_promote|allow_push_without_concierge|ignore_guardian|ignore_observer|ignore_role_contract|relax_must_block|change_role)$/i;

const ROLE_SET = new Set<string>(LENS_ROLES);

function issue(level: LensIssueLevel, code: string, message: string, path?: string): LensIssue {
  return { level, code, message, path };
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
}

function asRole(v: unknown): LensRole | null {
  const s = asString(v).toLowerCase();
  return ROLE_SET.has(s) ? s as LensRole : null;
}

function normalizeRoleLabel(label: string): LensRole | null {
  const s = label.trim().toLowerCase();
  return ROLE_SET.has(s) ? s as LensRole : null;
}

export function parseLensRef(raw: string): LensRef | null {
  const s = raw.trim().replace(/^`(.+)`$/, "$1").trim();
  const m = /^([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+):([a-z][a-z0-9_-]*)$/i.exec(s);
  if (!m) return null;
  return { packId: m[1].toLowerCase(), groupId: m[2].toLowerCase(), raw: s };
}

export function formatLensRef(ref: LensRef): string {
  return `${ref.packId}:${ref.groupId}`;
}

export function parseLensRegistryToml(text: string): LensRegistry {
  const doc = parse(text) as Record<string, unknown>;
  const packs = Array.isArray(doc.packs) ? doc.packs.map(asObj) : [];
  return {
    schemaVersion: asNumber(doc.schema_version),
    kind: asString(doc.kind),
    packs: packs.map((p) => ({
      id: asString(p.id).toLowerCase(),
      role: asRole(p.role),
      path: asString(p.path),
      status: asString(p.status) || "active",
      defaultGroup: asString(p.default_group).toLowerCase() || null,
    })),
  };
}

export function parseLensPackToml(text: string): LensPack {
  const doc = parse(text) as Record<string, unknown>;
  const head = asObj(doc.lens_pack);
  const groups = Array.isArray(doc.groups) ? doc.groups.map(asObj) : [];
  return {
    id: asString(head.id).toLowerCase(),
    role: asRole(head.role),
    schemaVersion: asNumber(head.schema_version),
    status: asString(head.status) || "active",
    description: asString(head.description),
    groups: groups.map((g) => ({
      id: asString(g.id).toLowerCase(),
      status: asString(g.status) || "active",
      label: asString(g.label),
      description: asString(g.description),
      focus: asObj(g.focus),
      limits: asObj(g.limits),
      raw: g,
    })),
  };
}

function findForbiddenKeys(v: unknown, prefix = ""): string[] {
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) out.push(...findForbiddenKeys(v[i], `${prefix}[${i}]`));
    return out;
  }
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (FORBIDDEN_LENS_FIELD_RE.test(k)) out.push(path);
    out.push(...findForbiddenKeys(child, path));
  }
  return out;
}

export function validateLensPack(pack: LensPack, path?: string): LensIssue[] {
  const issues: LensIssue[] = [];
  if (!pack.id) issues.push(issue("error", "pack-id", "lens_pack.id is required", path));
  if (!pack.role) issues.push(issue("error", "pack-role", "lens_pack.role must be a known role", path));
  if (pack.schemaVersion !== 1) issues.push(issue("error", "pack-schema", "lens_pack.schema_version must be 1", path));
  if (!["active", "deprecated", "inactive"].includes(pack.status)) {
    issues.push(issue("error", "pack-status", `lens_pack.status is invalid: ${pack.status}`, path));
  }
  const seen = new Set<string>();
  for (const g of pack.groups) {
    if (!g.id) issues.push(issue("error", "group-id", `${pack.id}: groups[].id is required`, path));
    if (seen.has(g.id)) issues.push(issue("error", "group-duplicate", `${pack.id}: duplicate group '${g.id}'`, path));
    seen.add(g.id);
    if (!["active", "deprecated", "inactive"].includes(g.status)) {
      issues.push(issue("error", "group-status", `${pack.id}:${g.id} status is invalid: ${g.status}`, path));
    }
    if (!g.label) issues.push(issue("error", "group-label", `${pack.id}:${g.id} label is required`, path));
    if (!g.description) issues.push(issue("error", "group-description", `${pack.id}:${g.id} description is required`, path));
    if (!g.focus || Object.keys(g.focus).length === 0) {
      issues.push(issue("error", "group-focus", `${pack.id}:${g.id} focus is required`, path));
    }
    if (g.limits.may_not_override_role_contract !== true) {
      issues.push(issue("error", "contract-override", `${pack.id}:${g.id} must set limits.may_not_override_role_contract = true`, path));
    }
    if (g.limits.may_not_relax_must_block !== true) {
      issues.push(issue("error", "must-block-relax", `${pack.id}:${g.id} must set limits.may_not_relax_must_block = true`, path));
    }
  }
  for (const bad of findForbiddenKeys(pack)) {
    issues.push(issue("error", "forbidden-field", `${pack.id || "lens pack"} contains forbidden field '${bad}'`, path));
  }
  if (pack.groups.length === 0) issues.push(issue("error", "groups-empty", `${pack.id || "lens pack"} has no groups`, path));
  return issues;
}

export function validateLensRegistry(
  registry: LensRegistry,
  loadPack: (path: string) => LensPack | null,
): LensIssue[] {
  const issues: LensIssue[] = [];
  if (registry.kind !== "garelier_lens_registry") {
    issues.push(issue("error", "registry-kind", `lens registry kind must be garelier_lens_registry, got '${registry.kind || "<empty>"}'`));
  }
  if (registry.schemaVersion !== 1) {
    issues.push(issue("error", "registry-schema", "lens registry schema_version must be 1"));
  }
  const seen = new Set<string>();
  for (const entry of registry.packs) {
    if (!entry.id) issues.push(issue("error", "registry-pack-id", "registry packs[].id is required", entry.path));
    if (seen.has(entry.id)) issues.push(issue("error", "registry-pack-duplicate", `duplicate lens pack '${entry.id}'`, entry.path));
    seen.add(entry.id);
    if (!entry.role) issues.push(issue("error", "registry-pack-role", `${entry.id}: packs[].role must be a known role`, entry.path));
    if (!entry.path) issues.push(issue("error", "registry-pack-path", `${entry.id}: packs[].path is required`, entry.path));
    if (!["active", "deprecated", "inactive"].includes(entry.status)) {
      issues.push(issue("error", "registry-pack-status", `${entry.id}: status is invalid: ${entry.status}`, entry.path));
    }
    const pack = entry.path ? loadPack(entry.path) : null;
    if (!pack) {
      issues.push(issue("error", "registry-pack-missing", `${entry.id}: lens pack file is missing`, entry.path));
      continue;
    }
    issues.push(...validateLensPack(pack, entry.path));
    if (pack.id !== entry.id) issues.push(issue("error", "registry-pack-id-mismatch", `${entry.path}: pack id '${pack.id}' does not match registry id '${entry.id}'`, entry.path));
    if (pack.role !== entry.role) issues.push(issue("error", "registry-pack-role-mismatch", `${entry.id}: pack role '${pack.role}' does not match registry role '${entry.role}'`, entry.path));
    if (entry.defaultGroup && !pack.groups.some((g) => g.id === entry.defaultGroup)) {
      issues.push(issue("error", "registry-default-group", `${entry.id}: default_group '${entry.defaultGroup}' is not defined`, entry.path));
    }
  }
  return issues;
}

export function parseDefaultLensSetFromSetupConfig(text: string): LensSelection {
  const doc = parse(text) as Record<string, unknown>;
  const defaults = asObj(asObj(doc.lenses).defaults);
  const byRole = new Map<LensRole, LensRef>();
  for (const [k, v] of Object.entries(defaults)) {
    const role = normalizeRoleLabel(k);
    const ref = typeof v === "string" ? parseLensRef(v) : null;
    if (role && ref) byRole.set(role, ref);
  }
  return { source: byRole.size ? "defaults" : "none", byRole };
}

export function parseBlueprintLensSelection(md: string): LensSelection {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Lens selection\s*$/i.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return { source: "none", byRole: new Map() };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##(?!#)\s+/.test(lines[i])) { end = i; break; }
  }
  const byRole = new Map<LensRole, LensRef>();
  let source: LensSelection["source"] = "explicit";
  for (const line of lines.slice(start + 1, end)) {
    const m = /^\s*-\s+([^:]+):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    if (/^source$/i.test(key)) {
      source = /default/i.test(value) ? "defaults" : "explicit";
      continue;
    }
    const role = normalizeRoleLabel(key);
    const ref = parseLensRef(value);
    if (role && ref) byRole.set(role, ref);
  }
  return { source: byRole.size ? source : "none", byRole };
}

export function validateLensSelection(
  selection: LensSelection,
  registry: LensRegistry,
  packById: Map<string, LensPack>,
): LensIssue[] {
  const issues: LensIssue[] = [];
  const registryById = new Map(registry.packs.map((p) => [p.id, p]));
  for (const [role, ref] of selection.byRole.entries()) {
    const entry = registryById.get(ref.packId);
    if (!entry) {
      issues.push(issue("error", "selection-pack-missing", `${role}: lens pack '${ref.packId}' is not registered`));
      continue;
    }
    if (entry.role !== role) {
      issues.push(issue("error", "selection-role-mismatch", `${role}: lens pack '${ref.packId}' belongs to role '${entry.role}'`));
    }
    if (entry.status !== "active") {
      issues.push(issue("error", "selection-pack-inactive", `${role}: lens pack '${ref.packId}' is ${entry.status}`));
    }
    const pack = packById.get(ref.packId);
    const group = pack?.groups.find((g) => g.id === ref.groupId);
    if (!group) {
      issues.push(issue("error", "selection-group-missing", `${role}: lens group '${formatLensRef(ref)}' is not defined`));
      continue;
    }
    if (group.status !== "active") {
      issues.push(issue("error", "selection-group-inactive", `${role}: lens group '${formatLensRef(ref)}' is ${group.status}`));
    }
  }
  return issues;
}

export function lensForRole(selection: LensSelection, role: string): LensRef | null {
  const r = normalizeRoleLabel(role);
  return r ? selection.byRole.get(r) ?? null : null;
}

export function renderEquippedLensSection(role: string, ref: LensRef | null, source: string | null): string {
  const lens = ref ? `\`${formatLensRef(ref)}\`` : "N/A";
  const src = source ?? (ref ? "resolved Lens selection" : "no explicit Lens selection; PM defaults may apply");
  return [
    "## Equipped lens",
    "",
    "<!--",
    "  Lens affects focus and judgment within the existing Role Contract only.",
    "  It cannot change permissions, write paths, MUST BLOCK conditions, or handoff format.",
    "-->",
    "",
    `- Role: ${role}`,
    `- Lens Group: ${lens}`,
    `- Source: ${src}`,
    "- Contract override: forbidden",
    "",
  ].join("\n");
}

export function loadLensRegistryFromRoot(garelierRoot: string): { registry: LensRegistry; packs: Map<string, LensPack>; issues: LensIssue[] } {
  const registryPath = join(garelierRoot, "__atmos", "lens_registry.toml");
  const text = readFileSync(registryPath, "utf8");
  const registry = parseLensRegistryToml(text);
  const packs = new Map<string, LensPack>();
  const issues = validateLensRegistry(registry, (rel) => {
    const abs = join(dirname(registryPath), rel);
    if (!existsSync(abs)) return null;
    const pack = parseLensPackToml(readFileSync(abs, "utf8"));
    packs.set(pack.id, pack);
    return pack;
  });
  return { registry, packs, issues };
}

function fail(msg: string): never {
  process.stderr.write(`lenses: ${msg}\n`);
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd || !["parse-blueprint", "defaults", "validate-registry"].includes(cmd)) {
    fail("usage: lenses.ts parse-blueprint --blueprint <path> | defaults --config <path> | validate-registry --garelier-root <path>");
  }
  if (cmd === "parse-blueprint") {
    const path = flag("blueprint") ?? fail("--blueprint is required");
    const selection = parseBlueprintLensSelection(await Bun.file(path).text());
    process.stdout.write(JSON.stringify(Object.fromEntries([...selection.byRole.entries()].map(([r, v]) => [r, formatLensRef(v)])), null, 2) + "\n");
    return;
  }
  if (cmd === "defaults") {
    const path = flag("config") ?? fail("--config is required");
    const selection = parseDefaultLensSetFromSetupConfig(await Bun.file(path).text());
    process.stdout.write(JSON.stringify(Object.fromEntries([...selection.byRole.entries()].map(([r, v]) => [r, formatLensRef(v)])), null, 2) + "\n");
    return;
  }
  const root = flag("garelier-root") ?? fail("--garelier-root is required");
  const { registry, packs, issues } = loadLensRegistryFromRoot(root);
  for (const i of issues) process.stderr.write(`${i.level.toUpperCase()} ${i.code}: ${i.message}${i.path ? ` (${i.path})` : ""}\n`);
  if (issues.some((i) => i.level === "error")) process.exit(1);
  process.stdout.write(`lens registry: ok (${registry.packs.length} packs, ${packs.size} loaded)\n`);
}

if (import.meta.main) main();
