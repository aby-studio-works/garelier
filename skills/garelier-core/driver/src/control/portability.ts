import { createHash } from "node:crypto";
import { constants, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadPlanGraphModel } from "./plan_graph_model.ts";
import { DEFAULT_STORE_LIMITS } from "./types.ts";
import { assertSafeFilesystemPath, assertSafePathWithin, assertSafePmId } from "./roots.ts";
import { controlRuntimeRoot, readStableControl } from "./generation.ts";

export type PortableControlSchema = 3;

export interface PortableFile {
  path: string;
  absolutePath: string;
  bytes: number;
  sha256: string;
  gitBlob: string;
  revision: number | null;
  identity: string | null;
  kind: string | null;
}

export interface ControlBundleManifest {
  schemaVersion: 2;
  kind: "garelier_control_bundle_v2";
  controlSchemaVersion: PortableControlSchema;
  pmId: string;
  controlRevision: string;
  manifestBytes: number;
  manifestSha256: string;
  provenance: "garelier_self_authored" | "external";
  persistentAuthority: "review_required";
  files: PortableFile[];
}

export interface ControlInventory {
  schemaVersion: PortableControlSchema;
  controlRevision: string;
  files: PortableFile[];
}

const V3_EXCLUDED_ROOT_DIRS = new Set(["runtime", "cache", "caches", "view", "views"]);
const SUPPORT_ROOT_DIRS = new Set(["operations", "inspections", "observations", "reports", "delegation", "request_intake", "scheduled_jobs", "templates"]);

interface RawManifestFile {
  path?: unknown;
  bytes?: unknown;
  sha256?: unknown;
  blob?: unknown;
  revision?: unknown;
  identity?: unknown;
  entity_kind?: unknown;
}

const posix = (path: string): string => path.replaceAll("\\", "/");
const sha = (algorithm: "sha1" | "sha256", payload: Uint8Array | string): string => createHash(algorithm).update(payload).digest("hex");

export function sha256File(path: string): string {
  return sha("sha256", readFileSync(path));
}

export function gitBlobFile(path: string): string {
  const payload = readFileSync(path);
  const header = Buffer.from(`blob ${payload.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(payload).digest("hex");
}

export function assertPortableRelativePath(path: string, prefix = "control/"): string {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`unsafe bundle path: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || !path.startsWith(prefix)) {
    throw new Error(`unsafe bundle path: ${path}`);
  }
  return path;
}

function walkRegularFiles(root: string): string[] {
  if (!existsSync(root)) throw new Error(`missing directory: ${root}`);
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`bundle root must be a real directory: ${root}`);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`symlink is forbidden in a control bundle: ${absolute}`);
      if (info.isDirectory()) walk(absolute);
      else if (info.isFile()) files.push(absolute);
      else throw new Error(`non-regular bundle entry is forbidden: ${absolute}`);
    }
  };
  walk(root);
  return files;
}

export function schemaFromControlToml(controlRoot: string): PortableControlSchema {
  const marker = join(controlRoot, "control.toml");
  if (!existsSync(marker)) throw new Error(`missing control.toml: ${marker}`);
  const decoded = parseToml(readFileSync(marker, "utf8")) as Record<string, unknown>;
  if (decoded.kind !== "garelier_control") throw new Error(`unknown control kind: ${String(decoded.kind)}`);
  if (decoded.schema_version !== 3) {
    throw new Error(`unsupported control schema: ${String(decoded.schema_version)}; only schema_version 3 is accepted`);
  }
  if (decoded.storage !== "plan_graph_markdown") {
    throw new Error(`schema v3 requires storage = plan_graph_markdown, got ${String(decoded.storage)}`);
  }
  return decoded.schema_version;
}

function recordMetadata(path: string, source: string): Pick<PortableFile, "revision" | "identity" | "kind"> {
  try {
    if (path.endsWith(".json")) {
      const value = JSON.parse(source) as Record<string, unknown>;
      const identity = typeof value.id === "string" ? value.id : typeof value.slug === "string" ? value.slug : null;
      return {
        revision: typeof value.revision === "number" && Number.isInteger(value.revision) ? value.revision : null,
        identity,
        kind: typeof value.kind === "string" ? value.kind : null,
      };
    }
    if (path.endsWith(".md") && source.startsWith("<!-- garelier-meta\n")) {
      const end = source.indexOf("-->");
      const value = JSON.parse(source.slice("<!-- garelier-meta\n".length, end).trim()) as Record<string, unknown>;
      return {
        revision: typeof value.revision === "number" && Number.isInteger(value.revision) ? value.revision : null,
        identity: typeof value.id === "string" ? value.id : typeof value.slug === "string" ? value.slug : null,
        kind: typeof value.kind === "string" ? value.kind : null,
      };
    }
    if (path.endsWith(".md") && source.startsWith("+++\n")) {
      const end = source.indexOf("\n+++\n", 4);
      if (end < 0) return { revision: null, identity: null, kind: null };
      const value = parseToml(source.slice(4, end)) as Record<string, unknown>;
      return {
        revision: typeof value.revision === "number" && Number.isInteger(value.revision) ? value.revision : null,
        identity: typeof value.id === "string" ? value.id : typeof value.slug === "string" ? value.slug : null,
        kind: typeof value.kind === "string" ? value.kind : null,
      };
    }
  } catch {
    // The schema/model loader owns structural diagnostics; per-file portability metadata is optional.
  }
  return { revision: null, identity: null, kind: null };
}

function portableFile(controlRoot: string, absolutePath: string): PortableFile {
  const rel = `control/${posix(relative(controlRoot, absolutePath))}`;
  assertPortableRelativePath(rel);
  const source = readFileSync(absolutePath, "utf8");
  const metadata = recordMetadata(rel, source);
  return {
    path: rel,
    absolutePath,
    bytes: lstatSync(absolutePath).size,
    sha256: sha256File(absolutePath),
    gitBlob: gitBlobFile(absolutePath),
    ...metadata,
  };
}

function inventoryRevision(files: readonly PortableFile[]): string {
  const payload = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}\0sha256:${file.sha256}\n`).join("");
  return `sha256:${sha("sha256", payload)}`;
}

function assertPortableCaps(files: readonly PortableFile[]): void {
  let total = 0;
  for (const file of files) {
    if (file.bytes > DEFAULT_STORE_LIMITS.maxArtifactBytes) throw new Error(`portable file exceeds ${DEFAULT_STORE_LIMITS.maxArtifactBytes} bytes: ${file.path}`);
    total += file.bytes;
    if (total > DEFAULT_STORE_LIMITS.maxTotalBytes) throw new Error(`portable control exceeds ${DEFAULT_STORE_LIMITS.maxTotalBytes} bytes`);
  }
  if (files.length > DEFAULT_STORE_LIMITS.maxEntities) throw new Error(`portable file count exceeds ${DEFAULT_STORE_LIMITS.maxEntities}`);
}

function inventoryControlSnapshot(project: string, pmId: string, controlRoot: string): ControlInventory {
  const schemaVersion = schemaFromControlToml(controlRoot);
  const model = loadPlanGraphModel(controlRoot);
  const errors = model.findings.filter((finding) => finding.severity === "error");
  if (errors.length > 0) {
    throw new Error(`schema v3 control is invalid: ${errors.map((finding) => `${finding.code}:${finding.path ?? "-"}`).join(", ")}`);
  }
  const files = walkRegularFiles(controlRoot)
    .filter((path) => !V3_EXCLUDED_ROOT_DIRS.has(posix(relative(controlRoot, path)).split("/", 1)[0]))
    .map((path) => portableFile(controlRoot, path))
    .sort((a, b) => a.path.localeCompare(b.path));
  assertPortableCaps(files);
  return { schemaVersion, controlRevision: inventoryRevision(files), files };
}

export function inventoryControl(project: string, pmId: string): ControlInventory {
  assertSafePmId(pmId);
  const projectRoot = resolve(project);
  assertSafeFilesystemPath(projectRoot, "portable project root");
  const controlRoot = assertSafePathWithin(projectRoot, join(projectRoot, "__garelier", pmId, "control"), "portable control root");
  return readStableControl({ controlRoot, runtimeRoot: controlRuntimeRoot(controlRoot) },
    () => inventoryControlSnapshot(project, pmId, controlRoot));
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`manifest ${name} must be a non-negative integer`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`manifest ${name} must be a non-empty string`);
  return value;
}

export function readAndVerifyBundle(bundleRoot: string): ControlBundleManifest {
  bundleRoot = resolve(bundleRoot);
  assertSafeFilesystemPath(bundleRoot, "control bundle root");
  assertSafePathWithin(bundleRoot, join(bundleRoot, "control"), "control bundle payload");
  const manifestPath = join(bundleRoot, "control_bundle_manifest.toml");
  if (!existsSync(manifestPath)) throw new Error(`missing control_bundle_manifest.toml in ${bundleRoot}`);
  if (lstatSync(manifestPath).isSymbolicLink()) throw new Error("bundle manifest cannot be a symlink");
  const manifestPayload = readFileSync(manifestPath);
  const manifestBytes = manifestPayload.byteLength;
  const manifestSha256 = sha("sha256", manifestPayload);
  const raw = parseToml(manifestPayload.toString("utf8")) as Record<string, unknown>;
  const kind = raw.kind;
  const manifestSchema = raw.schema_version;
  if (kind !== "garelier_control_bundle_v2" || manifestSchema !== 2) {
    throw new Error(`unsupported bundle kind/schema: ${String(kind)}/${String(manifestSchema)}`);
  }
  if (raw.provenance !== undefined && raw.provenance !== "garelier_self_authored" && raw.provenance !== "external") {
    throw new Error(`unsupported bundle provenance: ${String(raw.provenance)}`);
  }
  if (raw.persistent_authority !== undefined && raw.persistent_authority !== "review_required") {
    throw new Error(`unsupported persistent authority policy: ${String(raw.persistent_authority)}`);
  }
  if (raw.provenance === "garelier_self_authored" && raw.persistent_authority !== "review_required") {
    throw new Error("self-authored bundle must declare persistent_authority = review_required");
  }
  const controlSchemaVersion = raw.control_schema_version as unknown;
  if (controlSchemaVersion !== 3) throw new Error(`unsupported bundled control schema: ${String(controlSchemaVersion)}; only schema_version 3 is accepted`);
  const rows = raw.files;
  if (!Array.isArray(rows)) throw new Error("manifest files must be an array of tables");
  const seen = new Set<string>();
  const files = rows.map((item, index): PortableFile => {
    const row = item as RawManifestFile;
    const path = assertPortableRelativePath(string(row.path, `files[${index}].path`));
    if (seen.has(path)) throw new Error(`duplicate manifest path: ${path}`);
    seen.add(path);
    const absolutePath = join(bundleRoot, ...path.split("/"));
    if (!existsSync(absolutePath)) throw new Error(`manifest file is missing: ${path}`);
    const info = lstatSync(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`manifest path is not a regular file: ${path}`);
    const actualBytes = info.size;
    const actualSha = sha256File(absolutePath);
    const actualBlob = gitBlobFile(absolutePath);
    if (row.bytes !== undefined && integer(row.bytes, `files[${index}].bytes`) !== actualBytes) throw new Error(`byte count mismatch: ${path}`);
    if (row.sha256 !== undefined && string(row.sha256, `files[${index}].sha256`) !== actualSha) throw new Error(`SHA-256 mismatch: ${path}`);
    if (row.blob !== undefined && string(row.blob, `files[${index}].blob`) !== actualBlob) throw new Error(`git blob mismatch: ${path}`);
    if (row.sha256 === undefined && row.blob === undefined) throw new Error(`manifest file has no content digest: ${path}`);
    if (manifestSchema === 2 && (row.sha256 === undefined || row.bytes === undefined)) throw new Error(`v2 manifest requires SHA-256 and bytes: ${path}`);
    return {
      path,
      absolutePath,
      bytes: actualBytes,
      sha256: actualSha,
      gitBlob: actualBlob,
      revision: row.revision === undefined ? null : integer(row.revision, `files[${index}].revision`),
      identity: row.identity === undefined ? null : string(row.identity, `files[${index}].identity`),
      kind: row.entity_kind === undefined ? null : string(row.entity_kind, `files[${index}].entity_kind`),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));

  const diskFiles = walkRegularFiles(join(bundleRoot, "control"))
    .map((path) => `control/${posix(relative(join(bundleRoot, "control"), path))}`)
    .sort((left, right) => left.localeCompare(right));
  const manifestFiles = files.map((file) => file.path);
  if (diskFiles.length !== manifestFiles.length || diskFiles.some((path, index) => path !== manifestFiles[index])) {
    throw new Error("bundle control/ contents do not exactly match the manifest");
  }
  assertPortableCaps(files);
  const controlMarker = files.find((file) => file.path === "control/control.toml");
  if (!controlMarker) throw new Error("bundle is missing control/control.toml");
  const actualControlSchema = schemaFromControlToml(join(bundleRoot, "control"));
  if (actualControlSchema !== controlSchemaVersion) throw new Error("manifest and control.toml schema disagree");
  const pmId = string(raw.pm_id, "pm_id");
  assertSafePmId(pmId);
  const revision = typeof raw.control_revision === "string" ? raw.control_revision : inventoryRevision(files);
  if (!/^sha256:[0-9a-f]{64}$/.test(revision)) throw new Error("manifest control_revision must be sha256:<64 lowercase hex>");
  const bundledConfig = parseToml(readFileSync(join(bundleRoot, "control", "control.toml"), "utf8")) as Record<string, unknown>;
  if (bundledConfig.pm_id !== pmId) throw new Error("manifest pm_id and control.toml pm_id disagree");
  const model = loadPlanGraphModel(join(bundleRoot, "control"));
  const errors = model.findings.filter((finding) => finding.severity === "error");
  if (errors.length > 0) {
    throw new Error(`schema v3 bundle is invalid: ${errors.map((finding) => `${finding.code}:${finding.path ?? "-"}`).join(", ")}`);
  }
  const actualRevision = inventoryRevision(files);
  if (revision !== actualRevision) throw new Error(`control revision mismatch: manifest=${revision} actual=${actualRevision}`);
  if (lstatSync(manifestPath).size !== manifestBytes || sha256File(manifestPath) !== manifestSha256) throw new Error("bundle manifest changed during verification");
  return {
    schemaVersion: 2,
    kind: "garelier_control_bundle_v2",
    controlSchemaVersion,
    pmId,
    controlRevision: revision,
    manifestBytes,
    manifestSha256,
    provenance: raw.provenance === "garelier_self_authored" ? "garelier_self_authored" : "external",
    persistentAuthority: "review_required",
    files,
  };
}

export function renderBundleManifest(input: {
  inventory: ControlInventory;
  pmId: string;
  sourceProject: string;
  garelierVersion: string;
  sourceGitSha: string;
  generatedAt: string;
}): string {
  const { inventory } = input;
  const quote = (value: string): string => JSON.stringify(value);
  const lines = [
    "# Garelier Control portable bundle. Runtime, cache, and generated views are excluded.",
    "schema_version = 2",
    'kind = "garelier_control_bundle_v2"',
    `control_schema_version = ${inventory.schemaVersion}`,
    `pm_id = ${quote(input.pmId)}`,
    `control_revision = ${quote(inventory.controlRevision)}`,
    `source_project = ${quote(input.sourceProject)}`,
    `garelier_version = ${quote(input.garelierVersion)}`,
    `source_git_sha = ${quote(input.sourceGitSha)}`,
    `generated_at = ${quote(input.generatedAt)}`,
    'provenance = "garelier_self_authored"',
    'persistent_authority = "review_required"',
    'excluded = ["runtime/", "cache/", "generated views/"]',
    "",
  ];
  for (const file of inventory.files) {
    lines.push("[[files]]", `path = ${quote(file.path)}`, `bytes = ${file.bytes}`, `sha256 = ${quote(file.sha256)}`, `blob = ${quote(file.gitBlob)}`);
    if (file.revision !== null) lines.push(`revision = ${file.revision}`);
    if (file.identity !== null) lines.push(`identity = ${quote(file.identity)}`);
    if (file.kind !== null) lines.push(`entity_kind = ${quote(file.kind)}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function isPersistentSupportFile(path: string): boolean {
  const rel = assertPortableRelativePath(path).slice("control/".length);
  return SUPPORT_ROOT_DIRS.has(rel.split("/", 1)[0]);
}

export interface VerifiedBundleSnapshot {
  root: string;
  manifest: ControlBundleManifest;
}

/**
 * Freeze a verified bundle into a same-filesystem staging directory. Every
 * source is checked immediately before and after its exclusive copy; callers
 * subsequently consume only this snapshot, never the mutable input bundle.
 */
export function snapshotVerifiedBundle(
  bundleRoot: string,
  snapshotRoot: string,
  options: { afterSourceCheck?: (path: string) => void } = {},
): VerifiedBundleSnapshot {
  const sourceRoot = resolve(bundleRoot);
  const targetRoot = resolve(snapshotRoot);
  const targetParent = dirname(targetRoot);
  assertSafeFilesystemPath(sourceRoot, "control bundle source");
  assertSafeFilesystemPath(targetParent, "bundle snapshot parent");
  assertSafePathWithin(targetParent, targetRoot, "bundle snapshot", false);
  if (existsSync(targetRoot)) throw new Error(`bundle snapshot already exists: ${targetRoot}`);
  const verified = readAndVerifyBundle(sourceRoot);
  mkdirSync(targetRoot, { recursive: false });
  assertSafePathWithin(targetParent, targetRoot, "bundle snapshot");

  const manifestSource = join(sourceRoot, "control_bundle_manifest.toml");
  const entries = [
    { path: "control_bundle_manifest.toml", absolutePath: manifestSource, bytes: verified.manifestBytes, sha256: verified.manifestSha256 },
    ...verified.files,
  ];
  for (const entry of entries) {
    const before = lstatSync(entry.absolutePath);
    if (before.isSymbolicLink() || !before.isFile() || before.size !== entry.bytes || sha256File(entry.absolutePath) !== entry.sha256) {
      throw new Error(`bundle source changed before snapshot copy: ${entry.path}`);
    }
    options.afterSourceCheck?.(entry.path);
    const target = join(targetRoot, ...entry.path.split("/"));
    if (resolve(dirname(target)) === targetRoot) assertSafeFilesystemPath(targetRoot, "bundle snapshot root");
    else assertSafePathWithin(targetRoot, dirname(target), `bundle snapshot parent for ${entry.path}`, false);
    mkdirSync(dirname(target), { recursive: true });
    if (resolve(dirname(target)) === targetRoot) assertSafeFilesystemPath(targetRoot, "bundle snapshot root");
    else assertSafePathWithin(targetRoot, dirname(target), `bundle snapshot parent for ${entry.path}`);
    copyFileSync(entry.absolutePath, target, constants.COPYFILE_EXCL);
    const after = lstatSync(entry.absolutePath);
    const targetInfo = lstatSync(target);
    if (after.isSymbolicLink() || !after.isFile() || after.size !== entry.bytes || sha256File(entry.absolutePath) !== entry.sha256) {
      throw new Error(`bundle source changed during snapshot copy: ${entry.path}`);
    }
    if (!targetInfo.isFile() || targetInfo.size !== entry.bytes || sha256File(target) !== entry.sha256) {
      throw new Error(`bundle snapshot copy mismatch: ${entry.path}`);
    }
    chmodSync(target, 0o444);
  }
  return { root: targetRoot, manifest: readAndVerifyBundle(targetRoot) };
}

export interface EntityCollision {
  identity: string;
  kind: string;
  incomingPath: string;
  existingPath: string;
  incomingRevision: number | null;
  existingRevision: number | null;
  classification: "identical" | "incoming-newer" | "incoming-stale" | "revision-conflict" | "identity-conflict";
}

export function classifyEntityCollisions(incoming: readonly PortableFile[], existing: readonly PortableFile[]): EntityCollision[] {
  const byIdentity = new Map<string, PortableFile>();
  for (const file of existing) if (file.identity && file.kind) byIdentity.set(`${file.kind}\0${file.identity}`, file);
  const out: EntityCollision[] = [];
  for (const file of incoming) {
    if (!file.identity || !file.kind) continue;
    const current = byIdentity.get(`${file.kind}\0${file.identity}`);
    if (!current) continue;
    let classification: EntityCollision["classification"];
    if (current.sha256 === file.sha256) classification = "identical";
    else if (current.path !== file.path) classification = "identity-conflict";
    else if (file.revision === null || current.revision === null || file.revision === current.revision) classification = "revision-conflict";
    else classification = file.revision > current.revision ? "incoming-newer" : "incoming-stale";
    out.push({
      identity: file.identity,
      kind: file.kind,
      incomingPath: file.path,
      existingPath: current.path,
      incomingRevision: file.revision,
      existingRevision: current.revision,
      classification,
    });
  }
  return out.sort((a, b) => `${a.kind}\0${a.identity}`.localeCompare(`${b.kind}\0${b.identity}`));
}
