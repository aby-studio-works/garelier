// Lens Pack / Lens Group parsing and validation.
//
// A Lens changes a role's judgement focus only. It never changes the role
// contract, permissions, write paths, MUST BLOCK conditions, or handoff format.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  worker: "worker.implementation:reuse_first",
  scout: "scout.investigation:source_first",
  smith: "smith.integration:adversarial_personas",
  librarian: "librarian.source:strict",
  guardian: "guardian.risk_control:strict",
  observer: "observer.review:over_engineering",
  concierge: "concierge.external_ops:explicit_only",
  artisan: "artisan.creation:reuse_first",
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

export interface ResolvedRoleLensBinding {
  ref: string | null;
  source: "explicit" | "defaults" | "none";
  registry_path: string | null;
  pack_path: string | null;
}

export interface RoleSourcePointerOptions {
  blueprintPath?: string | null;
  lens: ResolvedRoleLensBinding;
}

const ROLE_SOURCE_POINTER_END = "<!-- /Role source pointers -->";
const LEGACY_ROLE_SOURCE_POINTER_LINE = /^- (?:Blueprint|Lens pack|Lens group|Lens focus|Read before starting):(?:\s|$)/;

/** Resolve the exact Lens sources a role authorization must bind. Explicit
 * `N/A`/`none` is a valid selection. A concrete ref fails closed unless its
 * active registry + pack resolve; the authorization hashes both files. */
export function resolveRoleLensBinding(options: {
  projectRoot: string;
  pmId: string;
  role: string;
  assignmentMd?: string | null;
  blueprintMd?: string | null;
  setupConfigPath?: string | null;
}): ResolvedRoleLensBinding {
  const role = normalizeRoleLabel(options.role);
  if (!role) throw new Error(`role Lens role is unknown: ${options.role}`);
  let ref: LensRef | null = null;
  let source: ResolvedRoleLensBinding["source"] = "none";
  const assignment = options.assignmentMd ?? "";
  const equipped = assignment.match(/^\s*-\s+Lens Group:\s*(.+?)\s*$/mi)?.[1]?.replace(/^`|`$/g, "").trim();
  const equippedSource = assignment.match(/^\s*-\s+Source:\s*(.+?)\s*$/mi)?.[1]?.trim() ?? "";
  if (equipped && !/^(?:N\/?A|none|null)$/i.test(equipped)) {
    ref = parseLensRef(equipped);
    if (!ref) throw new Error(`equipped role Lens ref is malformed: ${equipped}`);
    source = /default/i.test(equippedSource) ? "defaults" : "explicit";
  } else if (equipped && /^(?:N\/?A|none|null)$/i.test(equipped)) {
    return { ref: null, source: "none", registry_path: null, pack_path: null };
  } else if (options.blueprintMd) {
    const selection = parseBlueprintLensSelection(options.blueprintMd);
    ref = lensForRole(selection, role);
    if (ref) source = selection.source === "defaults" ? "defaults" : "explicit";
  }
  if (!ref && options.setupConfigPath && existsSync(options.setupConfigPath)) {
    const defaults = parseDefaultLensSetFromSetupConfig(readFileSync(options.setupConfigPath, "utf8"));
    ref = lensForRole(defaults, role);
    if (ref) source = "defaults";
  }
  if (!ref) return { ref: null, source: "none", registry_path: null, pack_path: null };

  const garelierRoot = join(resolve(options.projectRoot), "__garelier");
  const loaded = loadLensRegistryFromRoot(garelierRoot);
  const selection: LensSelection = { source, byRole: new Map([[role, ref]]) };
  const errors = [...loaded.issues, ...validateLensSelection(selection, loaded.registry, loaded.packs)].filter((entry) => entry.level === "error");
  if (errors.length) throw new Error(`role Lens resolution failed: ${errors.map((entry) => `${entry.code}: ${entry.message}`).join("; ")}`);
  const registryEntry = loaded.registry.packs.find((entry) => entry.id === ref!.packId);
  if (!registryEntry) throw new Error(`role Lens pack is not registered: ${ref.packId}`);
  return {
    ref: formatLensRef(ref),
    source,
    registry_path: loaded.registryPath,
    pack_path: join(dirname(loaded.registryPath), registryEntry.path),
  };
}

/** Render the role-visible, content-bearing pointers for the exact sources
 * already selected by dispatch. The selected group description is included so
 * changing a Lens pack changes the prompt, while the pack path + group ref let
 * the role read the full bound source before starting. */
export function renderRoleSourcePointerSection(options: RoleSourcePointerOptions): string {
  const blueprint = options.blueprintPath?.trim() || null;
  const lines = [
    "## Role source pointers",
    "",
    blueprint
      ? `- Blueprint: \`${blueprint}\` — read before starting.`
      : "- Blueprint: N/A — WARNING: --blueprint was not specified; proceeding without a blueprint pointer.",
  ];
  const lens = options.lens;
  if (!lens.ref) {
    lines.push("- Lens pack: N/A", "- Lens group: N/A");
  } else {
    if (!lens.pack_path) throw new Error(`role Lens ${lens.ref} has no resolved pack path`);
    const ref = parseLensRef(lens.ref);
    if (!ref) throw new Error(`role Lens ref is malformed: ${lens.ref}`);
    const pack = parseLensPackToml(readFileSync(lens.pack_path, "utf8"));
    const group = pack.groups.find((candidate) => candidate.id === ref.groupId);
    if (!group) throw new Error(`role Lens group ${lens.ref} is missing from ${lens.pack_path}`);
    const focus = group.description.replace(/\s+/g, " ").trim();
    lines.push(
      `- Lens pack: \`${lens.pack_path}\``,
      `- Lens group: \`${lens.ref}\``,
      `- Lens focus: ${focus}`,
      "- Read before starting: read the blueprint and the selected Lens group. The Lens changes judgment focus only; it cannot change permissions, write paths, MUST BLOCK conditions, or handoff format.",
    );
  }
  lines.push(ROLE_SOURCE_POINTER_END);
  return `${lines.join("\n")}\n`;
}

/** Replace an earlier pointer block rather than preserving stale recovery/warm
 * reuse pointers. The explicit terminator bounds new prompts; the known-line
 * fallback safely updates prompts emitted before that terminator existed. If no
 * block exists, prepend the current one. */
export function upsertRoleSourcePointerSection(source: string, options: RoleSourcePointerOptions): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+Role source pointers\s*$/.test(line));
  const block = renderRoleSourcePointerSection(options).trimEnd().split("\n");
  if (start < 0) return `${block.join("\n")}\n\n${source}`;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line === ROLE_SOURCE_POINTER_END) { end += 1; break; }
    if (line.trim() === "" || LEGACY_ROLE_SOURCE_POINTER_LINE.test(line)) { end += 1; continue; }
    break;
  }
  lines.splice(start, end - start, ...block);
  return lines.join("\n");
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

/** W-188 (g): the lens registry now lives at `__atmos/lenses/lens_registry.toml`
 * (alongside its packs, so `__atmos/` holds only subdirs, not a stray file). The
 * former direct-under-`__atmos/` location is still READ for existing projects that
 * have not re-run the setup wizard — new path wins, legacy is the fallback. Pack
 * `path` fields resolve relative to the registry's OWN dir either way, so a legacy
 * registry (paths like `lenses/x.toml`, dir `__atmos/`) and a migrated one (paths
 * like `x.toml`, dir `__atmos/lenses/`) both resolve correctly. Returns the path
 * used plus whether it was the legacy location, so callers can warn. */
export function resolveLensRegistryPath(garelierRoot: string): { path: string; legacy: boolean } | null {
  const current = join(garelierRoot, "__atmos", "lenses", "lens_registry.toml");
  if (existsSync(current)) return { path: current, legacy: false };
  const legacy = join(garelierRoot, "__atmos", "lens_registry.toml");
  if (existsSync(legacy)) return { path: legacy, legacy: true };
  return null;
}

export function loadLensRegistryFromRoot(garelierRoot: string): { registry: LensRegistry; packs: Map<string, LensPack>; issues: LensIssue[]; registryPath: string; legacy: boolean } {
  const resolved = resolveLensRegistryPath(garelierRoot);
  if (!resolved) {
    // No registry at either location: read the canonical (new) path so callers
    // that expect a "file not found" throw keep getting one, with the new path
    // named in the error.
    readFileSync(join(garelierRoot, "__atmos", "lenses", "lens_registry.toml"), "utf8");
    throw new Error("unreachable"); // readFileSync above always throws here
  }
  if (resolved.legacy) {
    process.stderr.write(`lenses: legacy lens registry is unsupported at ${resolved.path}; expected __atmos/lenses/\n`);
  }
  const registryPath = resolved.path;
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
  return { registry, packs, issues, registryPath, legacy: resolved.legacy };
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
