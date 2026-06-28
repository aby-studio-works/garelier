// Plant mode resolver and Plant-Crust lock validation.
//
// Plant-Lithosphere is the existing project-in layout:
//   control_root == target_root
// Plant-Crust is an external-management layout:
//   workfolder_root/crust.toml
//   workfolder_root/<container>/__garelier/
//   workfolder_root/<container>/target/
//   control_root != target_root

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "smol-toml";

export type PlantMode = "lithosphere" | "crust";
export type PlantIssueLevel = "error" | "warn";

export interface PlantIssue {
  level: PlantIssueLevel;
  code: string;
  message: string;
  path?: string;
}

export interface CrustPolicy {
  garelierFilesInTarget: string;
  readSiblingContainers: string;
  defaultWriteMode: string;
  pushMode: string;
}

export interface CrustContainer {
  id: string;
  path: string;
  extraKeys?: string[];
}

export interface CrustConfig {
  kind: string;
  schemaVersion: number;
  workfolderId: string;
  containers: CrustContainer[];
  extraTopLevelKeys?: string[];
  plantExtraKeys?: string[];
}

export interface ContainerLock {
  schemaVersion: number;
  plantKind: string;
  workfolderId: string;
  containerId: string;
  crustContainerHash: string;
  containerPath: string;
  garelierPath: string;
  targetPath: string;
  targetRemote: string;
  targetBranch: string;
  targetCount: number;
  policy: CrustPolicy;
}

export interface PlantResolution {
  mode: PlantMode;
  workfolderRoot: string | null;
  containerId: string | null;
  containerRoot: string | null;
  controlRoot: string | null;
  garelierRoot: string | null;
  targetRoot: string | null;
  issues: PlantIssue[];
  containers?: CrustContainerView[];
}

export interface AddCrustContainerOptions {
  workfolderId?: string;
  containerId: string;
  containerPath?: string;
}

export interface AddCrustContainerResult {
  crustPath: string;
  container: CrustContainer;
  hash: string;
  containerCount: number;
}

export interface WriteContainerLockOptions {
  containerId: string;
  lockPath: string;
  targetPath?: string;
  targetRemote?: string;
  targetBranch: string;
}

export interface WriteContainerLockResult {
  lockPath: string;
  container: CrustContainer;
  hash: string;
}

export interface CrustContainerView {
  id: string;
  path: string;
  containerRoot: string;
  garelierRoot: string;
  targetRoot: string;
  lockPath: string;
  issues: PlantIssue[];
}

const TOKEN_RE = /(gh[posru]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{24,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/;
const CONTAINER_ID_RE = /^[A-Za-z0-9._-]+$/;

function issue(level: PlantIssueLevel, code: string, message: string, path?: string): PlantIssue {
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

function relSafe(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.split(/[\\/]+/).includes("..");
}

function childPathSafe(path: string): boolean {
  if (!relSafe(path) || path === ".") return false;
  const parts = path.split(/[\\/]+/);
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

function validContainerId(id: string): boolean {
  return !!id && CONTAINER_ID_RE.test(id) && !id.startsWith(".");
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => `${JSON.stringify(k)}:${stableJson(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function parseCrustToml(text: string): CrustConfig {
  const doc = parse(text) as Record<string, unknown>;
  const plant = asObj(doc.plant);
  const containers = Array.isArray(doc.containers) ? doc.containers.map(asObj) : [];
  const allowedTopLevel = new Set(["plant", "containers"]);
  const allowedPlantKeys = new Set(["kind", "schema_version", "workfolder_id"]);
  const allowedContainerKeys = new Set(["id", "path"]);
  return {
    kind: asString(plant.kind),
    schemaVersion: asNumber(plant.schema_version),
    workfolderId: asString(plant.workfolder_id),
    containers: containers.map((c) => {
      const id = asString(c.id);
      const containerPath = asString(c.path);
      return {
        id,
        path: containerPath || id,
        extraKeys: Object.keys(c).filter((k) => !allowedContainerKeys.has(k)).sort(),
      };
    }),
    extraTopLevelKeys: Object.keys(doc).filter((k) => !allowedTopLevel.has(k)).sort(),
    plantExtraKeys: Object.keys(plant).filter((k) => !allowedPlantKeys.has(k)).sort(),
  };
}

export function parseContainerLockToml(text: string): ContainerLock {
  const doc = parse(text) as Record<string, unknown>;
  const lock = asObj(doc.lock);
  const paths = asObj(doc.paths);
  const target = asObj(doc.target);
  const policy = asObj(doc.policy);
  return {
    schemaVersion: asNumber(lock.schema_version),
    plantKind: asString(lock.plant_kind),
    workfolderId: asString(lock.workfolder_id),
    containerId: asString(lock.container_id),
    crustContainerHash: asString(lock.crust_container_hash),
    containerPath: asString(paths.container_path),
    garelierPath: asString(paths.garelier_path),
    targetPath: asString(paths.target_path),
    targetRemote: asString(target.remote),
    targetBranch: asString(target.branch),
    targetCount: asNumber(target.count),
    policy: {
      garelierFilesInTarget: asString(policy.garelier_files_in_target),
      readSiblingContainers: asString(policy.read_sibling_containers),
      defaultWriteMode: asString(policy.default_write_mode),
      pushMode: asString(policy.push_mode),
    },
  };
}

export function hashCrustContainerEntry(container: CrustContainer): string {
  const stable = {
    id: container.id,
    path: container.path,
  };
  return `sha256:${createHash("sha256").update(stableJson(stable)).digest("hex")}`;
}

function tomlString(v: string): string {
  return JSON.stringify(v);
}

function safeIdFromPath(path: string): string {
  const id = basename(resolve(path)).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return id || "workfolder";
}

function renderCrustHeader(workfolderId: string): string {
  return `[plant]
kind = "crust"
schema_version = 1
workfolder_id = ${tomlString(workfolderId)}
`;
}

function renderCrustContainerEntry(container: CrustContainer): string {
  const lines = ["", "[[containers]]", `id = ${tomlString(container.id)}`];
  if (container.path && container.path !== container.id) lines.push(`path = ${tomlString(container.path)}`);
  return `${lines.join("\n")}\n`;
}

export function addCrustContainerToText(existingText: string | null, crustPath: string, opts: AddCrustContainerOptions): { text: string; config: CrustConfig; container: CrustContainer; hash: string } {
  const container: CrustContainer = {
    id: opts.containerId.trim(),
    path: (opts.containerPath || opts.containerId).trim(),
  };
  if (!container.id) throw new Error("container id is required");
  if (!validContainerId(container.id)) throw new Error(`unsafe container id: ${container.id}`);
  if (!childPathSafe(container.path)) throw new Error(`unsafe container path: ${container.path}`);

  let nextText: string;
  if (existingText === null) {
    const workfolderId = (opts.workfolderId || safeIdFromPath(dirname(crustPath))).trim();
    nextText = renderCrustHeader(workfolderId) + renderCrustContainerEntry(container);
  } else {
    const current = parseCrustToml(existingText);
    if (opts.workfolderId && current.workfolderId && opts.workfolderId !== current.workfolderId) {
      throw new Error(`workfolder id mismatch: crust.toml has "${current.workfolderId}", requested "${opts.workfolderId}"`);
    }
    if (current.containers.some((c) => c.id === container.id)) {
      throw new Error(`container already exists in crust.toml: ${container.id}`);
    }
    nextText = existingText.replace(/[ \t\r\n]*$/, "\n") + renderCrustContainerEntry(container);
  }

  const nextConfig = parseCrustToml(nextText);
  const issues = validateCrustConfig(nextConfig).filter((i) => i.level === "error");
  if (issues.length > 0) {
    throw new Error(`crust.toml would be invalid after add-container:\n${issues.map((i) => `  ${i.code}: ${i.message}`).join("\n")}`);
  }
  const added = nextConfig.containers.find((c) => c.id === container.id);
  if (!added) throw new Error(`internal error: added container not found: ${container.id}`);
  return { text: nextText, config: nextConfig, container: added, hash: hashCrustContainerEntry(added) };
}

function renderContainerLockToml(crust: CrustConfig, container: CrustContainer, opts: WriteContainerLockOptions): string {
  const lock: ContainerLock = {
    schemaVersion: 1,
    plantKind: "crust",
    workfolderId: crust.workfolderId,
    containerId: container.id,
    crustContainerHash: hashCrustContainerEntry(container),
    containerPath: container.path,
    garelierPath: "__garelier",
    targetPath: opts.targetPath || "target",
    targetRemote: (opts.targetRemote || "").trim(),
    targetBranch: opts.targetBranch.trim(),
    targetCount: 1,
    policy: {
      garelierFilesInTarget: "forbidden",
      readSiblingContainers: "forbidden",
      defaultWriteMode: "patch",
      pushMode: "explicit_only",
    },
  };
  const issues = validateContainerLock(lock, crust).filter((i) => i.level === "error");
  if (issues.length > 0) {
    throw new Error(`container.lock.toml would be invalid:\n${issues.map((i) => `  ${i.code}: ${i.message}`).join("\n")}`);
  }
  return `[lock]
schema_version = 1
plant_kind = "crust"
workfolder_id = ${tomlString(lock.workfolderId)}
container_id = ${tomlString(lock.containerId)}
crust_container_hash = ${tomlString(lock.crustContainerHash)}

[paths]
container_path = ${tomlString(lock.containerPath)}
garelier_path = ${tomlString(lock.garelierPath)}
target_path = ${tomlString(lock.targetPath)}

[target]
remote = ${tomlString(lock.targetRemote)}
branch = ${tomlString(lock.targetBranch)}
count = 1

[policy]
garelier_files_in_target = ${tomlString(lock.policy.garelierFilesInTarget)}
read_sibling_containers = ${tomlString(lock.policy.readSiblingContainers)}
default_write_mode = ${tomlString(lock.policy.defaultWriteMode)}
push_mode = ${tomlString(lock.policy.pushMode)}
`;
}

export function writeContainerLock(crustPath: string, opts: WriteContainerLockOptions): WriteContainerLockResult {
  const absCrust = resolve(crustPath);
  const crust = parseCrustToml(readFileSync(absCrust, "utf8"));
  const crustIssues = validateCrustConfig(crust).filter((i) => i.level === "error");
  if (crustIssues.length > 0) {
    throw new Error(`crust.toml is invalid:\n${crustIssues.map((i) => `  ${i.code}: ${i.message}`).join("\n")}`);
  }
  const container = crust.containers.find((c) => c.id === opts.containerId);
  if (!container) throw new Error(`container not found in crust.toml: ${opts.containerId}`);
  const text = renderContainerLockToml(crust, container, opts);
  writeFileSync(resolve(opts.lockPath), text, "utf8");
  return { lockPath: resolve(opts.lockPath), container, hash: hashCrustContainerEntry(container) };
}

export function addCrustContainer(crustPath: string, opts: AddCrustContainerOptions): AddCrustContainerResult {
  const abs = resolve(crustPath);
  const existingText = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  const result = addCrustContainerToText(existingText, abs, opts);
  writeFileSync(abs, result.text, "utf8");
  return {
    crustPath: abs,
    container: result.container,
    hash: result.hash,
    containerCount: result.config.containers.length,
  };
}

export function validateCrustConfig(config: CrustConfig): PlantIssue[] {
  const issues: PlantIssue[] = [];
  if (config.kind !== "crust") issues.push(issue("error", "crust-kind", `[plant].kind must be "crust", got "${config.kind || "<empty>"}"`));
  if (config.schemaVersion !== 1) issues.push(issue("error", "crust-schema", "[plant].schema_version must be 1"));
  if (!config.workfolderId) issues.push(issue("error", "workfolder-id", "[plant].workfolder_id is required"));
  if (config.extraTopLevelKeys?.length) issues.push(issue("error", "crust-extra-keys", `crust.toml only supports [plant] and [[containers]]; remove: ${config.extraTopLevelKeys.join(", ")}`));
  if (config.plantExtraKeys?.length) issues.push(issue("error", "plant-extra-keys", `[plant] only supports kind, schema_version, and workfolder_id; remove: ${config.plantExtraKeys.join(", ")}`));

  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const c of config.containers) {
    if (!c.id) issues.push(issue("error", "container-id", "containers[].id is required"));
    if (c.id && !validContainerId(c.id)) issues.push(issue("error", "container-id", `${c.id}: id must match [A-Za-z0-9._-]+ and must not start with "."`));
    if (c.extraKeys?.length) issues.push(issue("error", "container-extra-keys", `${c.id || "<unknown>"}: [[containers]] only supports id and path; remove: ${c.extraKeys.join(", ")}`));
    if (ids.has(c.id)) issues.push(issue("error", "container-duplicate", `duplicate container id "${c.id}"`));
    ids.add(c.id);
    if (paths.has(c.path)) issues.push(issue("error", "container-path-duplicate", `duplicate container path "${c.path}"`));
    paths.add(c.path);
    if (!childPathSafe(c.path)) issues.push(issue("error", "container-path", `${c.id}: path must be a safe relative child path, not "." or a traversal`));
  }
  if (config.containers.length === 0) issues.push(issue("error", "containers-empty", "Plant-Crust needs at least one [[containers]] entry"));
  return issues;
}

export function validateContainerLock(lock: ContainerLock, crust: CrustConfig): PlantIssue[] {
  const issues: PlantIssue[] = [];
  if (lock.schemaVersion !== 1) issues.push(issue("error", "lock-schema", "[lock].schema_version must be 1"));
  if (lock.plantKind !== "crust") issues.push(issue("error", "lock-kind", "[lock].plant_kind must be crust"));
  if (lock.workfolderId !== crust.workfolderId) issues.push(issue("error", "lock-workfolder", "container lock workfolder_id does not match crust.toml"));
  const c = crust.containers.find((x) => x.id === lock.containerId);
  if (!c) {
    issues.push(issue("error", "lock-container-missing", `container_id "${lock.containerId}" is not present in crust.toml`));
    return issues;
  }
  if (lock.containerPath !== c.path) issues.push(issue("error", "lock-container-path", "container_path does not match crust.toml"));
  if (lock.garelierPath !== "__garelier") issues.push(issue("error", "lock-garelier-path", 'garelier_path must be "__garelier" in Plant-Crust v1'));
  if (lock.targetPath !== "target") issues.push(issue("error", "lock-target-path", 'target_path must be "target" in Plant-Crust v1'));
  if (lock.targetCount !== 1) issues.push(issue("error", "lock-target-count", "target.count must be 1"));
  if (!lock.targetBranch) issues.push(issue("error", "lock-target-branch", "target.branch is required"));
  const wantHash = hashCrustContainerEntry(c);
  if (lock.crustContainerHash !== wantHash) issues.push(issue("error", "lock-hash", "crust_container_hash does not match crust.toml container entry"));
  const flat = JSON.stringify(lock);
  if (TOKEN_RE.test(flat)) issues.push(issue("error", "lock-secret", "container.lock.toml contains a token-shaped secret"));
  for (const [name, value] of [
    ["container_path", lock.containerPath],
    ["garelier_path", lock.garelierPath],
    ["target_path", lock.targetPath],
  ]) {
    if (!childPathSafe(value)) issues.push(issue("error", "lock-relative-path", `${name} must be a safe relative child path`));
  }
  if (lock.policy.garelierFilesInTarget !== "forbidden") issues.push(issue("error", "lock-target-garelier-policy", "lock policy must forbid Garelier files in target"));
  if (lock.policy.readSiblingContainers !== "forbidden") issues.push(issue("error", "lock-sibling-policy", "lock policy must forbid sibling container reads"));
  if (lock.policy.defaultWriteMode !== "patch") issues.push(issue("error", "lock-write-policy", "lock default_write_mode must be patch"));
  if (lock.policy.pushMode !== "explicit_only") issues.push(issue("error", "lock-push-policy", "lock push_mode must be explicit_only"));
  return issues;
}

export function listCrustContainers(crustPath: string): { crustPath: string; workfolderRoot: string; containers: CrustContainerView[]; issues: PlantIssue[] } {
  const absCrust = resolve(crustPath);
  const workfolderRoot = dirname(absCrust);
  let crust: CrustConfig;
  try {
    crust = parseCrustToml(readFileSync(absCrust, "utf8"));
  } catch (e) {
    return {
      crustPath: absCrust,
      workfolderRoot,
      containers: [],
      issues: [issue("error", "crust-parse", `crust.toml could not be parsed: ${e instanceof Error ? e.message : String(e)}`, absCrust)],
    };
  }
  const issues = validateCrustConfig(crust);
  const containers = crust.containers.map((container) => {
    const containerRoot = join(workfolderRoot, container.path);
    const lockPath = join(containerRoot, "container.lock.toml");
    let targetRoot = join(containerRoot, "target");
    const cIssues: PlantIssue[] = [];
    if (!existsSync(lockPath)) {
      cIssues.push(issue("error", "container-lock-missing", "container.lock.toml is required", lockPath));
    } else {
      try {
        const lock = parseContainerLockToml(readFileSync(lockPath, "utf8"));
        targetRoot = join(containerRoot, lock.targetPath || "target");
        cIssues.push(...validateContainerLock(lock, crust));
      } catch (e) {
        cIssues.push(issue("error", "container-lock-parse", `container.lock.toml could not be parsed: ${e instanceof Error ? e.message : String(e)}`, lockPath));
      }
    }
    return {
      id: container.id,
      path: container.path,
      containerRoot,
      garelierRoot: join(containerRoot, "__garelier"),
      targetRoot,
      lockPath,
      issues: cIssues,
    };
  });
  return { crustPath: absCrust, workfolderRoot, containers, issues };
}

function findUp(start: string, name: string): string | null {
  let cur = resolve(start);
  while (true) {
    const p = join(cur, name);
    if (existsSync(p)) return p;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function resolvePlant(startPath: string, containerId?: string): PlantResolution {
  const start = resolve(startPath);
  const crustPath = findUp(start, "crust.toml");
  const issues: PlantIssue[] = [];
  if (crustPath) {
    const workfolderRoot = dirname(crustPath);
    let crust: CrustConfig;
    try {
      crust = parseCrustToml(readFileSync(crustPath, "utf8"));
    } catch (e) {
      issues.push(issue("error", "crust-parse", `crust.toml could not be parsed: ${e instanceof Error ? e.message : String(e)}`, crustPath));
      return {
        mode: "crust",
        workfolderRoot,
        containerId: containerId ?? null,
        containerRoot: null,
        controlRoot: null,
        garelierRoot: null,
        targetRoot: null,
        issues,
        containers: [],
      };
    }
    issues.push(...validateCrustConfig(crust));
    let container: CrustContainer | undefined;
    if (containerId) {
      container = crust.containers.find((c) => c.id === containerId);
      if (!container) issues.push(issue("error", "active-container", `Plant-Crust container not found: ${containerId}`));
    }
    else {
      const matches = crust.containers.filter((c) => isInside(join(workfolderRoot, c.path), start));
      if (matches.length === 1) container = matches[0];
      else if (matches.length > 1) issues.push(issue("error", "active-container", "multiple Plant-Crust containers match cwd; pass container_id"));
    }
    if (!container) {
      return {
        mode: "crust",
        workfolderRoot,
        containerId: containerId ?? null,
        containerRoot: null,
        controlRoot: null,
        garelierRoot: null,
        targetRoot: null,
        issues,
        containers: listCrustContainers(crustPath).containers,
      };
    }
    const containerRoot = join(workfolderRoot, container.path);
    const lockPath = join(containerRoot, "container.lock.toml");
    let targetRoot = join(containerRoot, "target");
    if (!existsSync(lockPath)) {
      issues.push(issue("error", "container-lock-missing", "container.lock.toml is required", lockPath));
    } else {
      try {
        const lock = parseContainerLockToml(readFileSync(lockPath, "utf8"));
        targetRoot = join(containerRoot, lock.targetPath || "target");
        issues.push(...validateContainerLock(lock, crust));
      } catch (e) {
        issues.push(issue("error", "container-lock-parse", `container.lock.toml could not be parsed: ${e instanceof Error ? e.message : String(e)}`, lockPath));
      }
    }
    const garelierRoot = join(containerRoot, "__garelier");
    if (resolve(targetRoot) === resolve(containerRoot)) {
      issues.push(issue("error", "target-root-overlap", "target_root must not equal control_root", targetRoot));
    }
    if (isInside(garelierRoot, targetRoot)) {
      issues.push(issue("error", "target-root-overlap", "target_root must not be inside garelier_root", targetRoot));
    }
    if (isInside(targetRoot, garelierRoot)) {
      issues.push(issue("error", "target-root-overlap", "garelier_root must not be inside target_root", garelierRoot));
    }
    if (!existsSync(targetRoot)) issues.push(issue("error", "target-missing", "target_root does not exist", targetRoot));
    else {
      try {
        if (!statSync(join(targetRoot, ".git")).isDirectory() && !statSync(join(targetRoot, ".git")).isFile()) {
          issues.push(issue("error", "target-git", "target_root is not a git repository", targetRoot));
        }
      } catch {
        issues.push(issue("error", "target-git", "target_root is not a git repository", targetRoot));
      }
      if (existsSync(join(targetRoot, "__garelier"))) {
        issues.push(issue("error", "target-garelier", "Plant-Crust forbids target_root/__garelier", join(targetRoot, "__garelier")));
      }
    }
    return {
      mode: "crust",
      workfolderRoot,
      containerId: container.id,
      containerRoot,
      controlRoot: containerRoot,
      garelierRoot,
      targetRoot,
      issues,
    };
  }

  const garelierPath = findUp(start, "__garelier");
  const projectRoot = garelierPath ? dirname(garelierPath) : start;
  return {
    mode: "lithosphere",
    workfolderRoot: null,
    containerId: null,
    containerRoot: null,
    controlRoot: projectRoot,
    garelierRoot: join(projectRoot, "__garelier"),
    targetRoot: projectRoot,
    issues,
  };
}

function fail(msg: string): never {
  process.stderr.write(`plant: ${msg}\n`);
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd || !["resolve", "list-containers", "validate-workfolder", "add-container", "write-lock", "hash", "validate-crust", "validate-lock"].includes(cmd)) {
    fail("usage: plant.ts resolve --start <path> [--container <id>] | list-containers --crust <path> | validate-workfolder --crust <path> | add-container --crust <path> --container-id <id> [--workfolder-id <id>] [--container-path <path>] | write-lock --crust <path> --lock <path> --container <id> --target-branch <branch> [--target-remote <url>] | validate-crust --crust <path> | validate-lock --crust <path> --lock <path> | hash --crust <path> --container <id>");
  }
  if (cmd === "resolve") {
    const res = resolvePlant(flag("start") ?? process.cwd(), flag("container"));
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    if (res.issues.some((i) => i.level === "error")) process.exit(1);
    return;
  }
  const crustPath = flag("crust") ?? fail("--crust is required");
  if (cmd === "list-containers" || cmd === "validate-workfolder") {
    const result = listCrustContainers(crustPath);
    if (cmd === "list-containers") {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (result.issues.concat(result.containers.flatMap((c) => c.issues)).some((i) => i.level === "error")) process.exit(1);
      return;
    }
    for (const i of result.issues) process.stderr.write(`${i.level.toUpperCase()} ${i.code}: ${i.message}\n`);
    for (const c of result.containers) {
      for (const i of c.issues) process.stderr.write(`${i.level.toUpperCase()} ${c.id} ${i.code}: ${i.message}\n`);
    }
    const allIssues = result.issues.concat(result.containers.flatMap((c) => c.issues));
    if (allIssues.some((i) => i.level === "error")) process.exit(1);
    process.stdout.write(`workfolder: ok (${result.containers.length} container${result.containers.length === 1 ? "" : "s"})\n`);
    return;
  }
  if (cmd === "add-container") {
    try {
      const result = addCrustContainer(crustPath, {
        workfolderId: flag("workfolder-id"),
        containerId: flag("container-id") ?? fail("--container-id is required"),
        containerPath: flag("container-path"),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (cmd === "write-lock") {
    try {
      const result = writeContainerLock(crustPath, {
        lockPath: flag("lock") ?? fail("--lock is required"),
        containerId: flag("container") ?? fail("--container is required"),
        targetPath: flag("target-path"),
        targetRemote: flag("target-remote"),
        targetBranch: flag("target-branch") ?? fail("--target-branch is required"),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  let crust: CrustConfig;
  try {
    crust = parseCrustToml(await Bun.file(crustPath).text());
  } catch (e) {
    process.stderr.write(`ERROR crust-parse: crust.toml could not be parsed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  if (cmd === "validate-crust") {
    const issues = validateCrustConfig(crust);
    for (const i of issues) process.stderr.write(`${i.level.toUpperCase()} ${i.code}: ${i.message}\n`);
    if (issues.some((i) => i.level === "error")) process.exit(1);
    process.stdout.write(`crust: ok (${crust.containers.length} container${crust.containers.length === 1 ? "" : "s"})\n`);
    return;
  }
  if (cmd === "hash") {
    const id = flag("container") ?? fail("--container is required");
    const c = crust.containers.find((x) => x.id === id) ?? fail(`container not found: ${id}`);
    process.stdout.write(hashCrustContainerEntry(c) + "\n");
    return;
  }
  const lockPath = flag("lock") ?? fail("--lock is required");
  const issues = validateCrustConfig(crust);
  try {
    issues.push(...validateContainerLock(parseContainerLockToml(await Bun.file(lockPath).text()), crust));
  } catch (e) {
    issues.push(issue("error", "container-lock-parse", `container.lock.toml could not be parsed: ${e instanceof Error ? e.message : String(e)}`, lockPath));
  }
  for (const i of issues) process.stderr.write(`${i.level.toUpperCase()} ${i.code}: ${i.message}\n`);
  if (issues.some((i) => i.level === "error")) process.exit(1);
  process.stdout.write("container lock: ok\n");
}

if (import.meta.main) main();
