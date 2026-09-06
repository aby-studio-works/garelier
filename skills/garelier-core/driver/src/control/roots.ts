import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { PM_ID_RE } from "../config.ts";
import { resolvePlant, type PlantMode, type PlantResolution } from "../plant.ts";
import { controlRuntimeRoot, readStableControl } from "./generation.ts";

export class ControlRootError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ControlRootError";
  }
}

export interface ResolvedControlRoots {
  mode: PlantMode;
  targetRoot: string;
  garelierRoot: string;
  pmRoot: string;
  controlRoot: string;
  runtimeRoot: string;
  containerId: string | null;
}

export function assertSafePmId(pmId: string): void {
  if (pmId !== "_workshop" && !PM_ID_RE.test(pmId)) {
    throw new ControlRootError(
      "control-pm-id-unsafe",
      `unsafe pm_id ${JSON.stringify(pmId)}: use _workshop or 1-20 lowercase ASCII letters, digits, internal hyphens, or underscores`,
    );
  }
}

function comparable(path: string): string {
  let value = resolve(path).replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/$/, "");
  if (process.platform === "win32") value = value.toLowerCase();
  return value;
}

/** Reject a symlink/junction/reparse escape in the path itself or any existing ancestor. */
export function assertSafeFilesystemPath(path: string, label: string, requireLeaf = true): void {
  const absolute = resolve(path);
  const root = parsePath(absolute).root;
  const chain: string[] = [];
  for (let cursor = absolute; comparable(cursor) !== comparable(root); cursor = dirname(cursor)) chain.push(cursor);
  chain.push(root);
  chain.reverse();
  let missing = false;
  for (const entry of chain) {
    if (!existsSync(entry)) { missing = true; continue; }
    if (missing) throw new ControlRootError("control-path-race", `${label} has an existing descendant below a missing ancestor: ${entry}`);
    const info = lstatSync(entry);
    if (info.isSymbolicLink()) throw new ControlRootError("control-path-link-forbidden", `${label} contains a symlink or junction: ${entry}`);
  }
  if (requireLeaf && !existsSync(absolute)) throw new ControlRootError("control-path-missing", `${label} does not exist: ${absolute}`);
  // One leaf realpath comparison detects a reparse escape anywhere in the
  // existing chain. Avoid realpath on every ancestor: Windows sandboxes may
  // permit the project but deny realpath on an otherwise ordinary user-home
  // ancestor (EPERM), while lstat above is still sufficient to inspect it.
  const existingLeaf = [...chain].reverse().find((entry) => existsSync(entry));
  if (existingLeaf) {
    let actual: string;
    try { actual = realpathSync.native(existingLeaf); }
    catch (error) { throw new ControlRootError("control-path-realpath", `${label} cannot be resolved safely: ${(error as Error).message}`); }
    if (comparable(actual) !== comparable(existingLeaf)) {
      throw new ControlRootError("control-path-reparse-escape", `${label} resolves outside its declared path: ${existingLeaf} -> ${actual}`);
    }
  }
}

/**
 * Resolve a candidate below a trusted root and reject links/reparse escapes in
 * both the root and every existing component down to the candidate. Missing
 * destination leaves are allowed only when explicitly requested.
 */
export function assertSafePathWithin(root: string, candidate: string, label: string, requireLeaf = true): string {
  const base = resolve(root);
  const absolute = resolve(candidate);
  const rel = relative(base, absolute);
  if (absolute === base || rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(rel)) {
    throw new ControlRootError("control-path-traversal", `${label} must be a descendant of ${base}: ${absolute}`);
  }
  assertSafeFilesystemPath(base, `${label} root`);
  assertSafeFilesystemPath(absolute, label, requireLeaf);
  return absolute;
}

function plantFailure(plant: PlantResolution): never {
  const errors = plant.issues.filter((entry) => entry.level === "error");
  throw new ControlRootError(
    "control-plant-invalid",
    errors.length
      ? errors.map((entry) => `${entry.code}: ${entry.message}${entry.path ? ` (${entry.path})` : ""}`).join("\n")
      : "Plant root resolution did not produce an active control namespace; pass --container for Plant-Crust",
  );
}

function markerPmId(controlRoot: string): string | null {
  const marker = join(controlRoot, "control.toml");
  if (!existsSync(marker)) return null;
  const match = readFileSync(marker, "utf8").match(/^\s*pm_id\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m);
  return match?.[1] ?? null;
}

function resolveControlRootsSnapshot(startPath: string, pmId: string, containerId?: string): ResolvedControlRoots {
  assertSafePmId(pmId);
  const plant = resolvePlant(startPath, containerId);
  if (plant.issues.some((entry) => entry.level === "error")) plantFailure(plant);
  if (!plant.targetRoot || !plant.garelierRoot || !plant.controlRoot) plantFailure(plant);

  const targetRoot = resolve(plant.targetRoot);
  const garelierRoot = resolve(plant.garelierRoot);
  const pmRoot = join(garelierRoot, pmId);
  const controlRoot = join(pmRoot, "control");
  const runtimeRoot = join(pmRoot, "runtime", "control");

  assertSafeFilesystemPath(targetRoot, "target root");
  assertSafeFilesystemPath(plant.controlRoot, "Plant control root");
  assertSafeFilesystemPath(garelierRoot, "Garelier root");
  assertSafeFilesystemPath(pmRoot, "PM namespace");
  assertSafeFilesystemPath(controlRoot, "control root");
  assertSafeFilesystemPath(runtimeRoot, "control runtime root", false);

  const markerId = markerPmId(controlRoot);
  if (markerId !== null && markerId !== pmId) {
    throw new ControlRootError("control-namespace-identity", `control.toml pm_id ${JSON.stringify(markerId)} does not match requested namespace ${JSON.stringify(pmId)}`);
  }
  return { mode: plant.mode, targetRoot, garelierRoot, pmRoot, controlRoot, runtimeRoot, containerId: plant.containerId };
}

export function resolveControlRoots(startPath: string, pmId: string, containerId?: string): ResolvedControlRoots {
  assertSafePmId(pmId);
  const plant = resolvePlant(startPath, containerId);
  if (!plant.garelierRoot) return resolveControlRootsSnapshot(startPath, pmId, containerId);
  const controlRoot = join(plant.garelierRoot, pmId, "control");
  return readStableControl({ controlRoot, runtimeRoot: controlRuntimeRoot(controlRoot) },
    () => resolveControlRootsSnapshot(startPath, pmId, containerId));
}

/**
 * W-222: recovery-only counterpart to resolveControlRoots. The normal path
 * wraps root discovery in readStableControl so every ordinary command
 * retries until it observes a settled (even) generation before trusting the
 * resolved paths — appropriate everywhere else, but it is exactly the read a
 * crashed-writer recovery command cannot get past: an odd generation with no
 * live namespace lock is the condition `control generation-recover` exists to
 * fix, and readStableControl's own fail-closed contract throws
 * "...odd without a live namespace lock..." for that case (generation.ts
 * readStableControl), before generation-recover's own plan/apply logic ever
 * runs. resolveControlRootsSnapshot itself never reads generation.json or any
 * transactional model file — only control.toml's pm_id marker plus
 * filesystem shape — so it does not need generation stability at all; the
 * actual staleness/liveness checks for recovery are performed later, and far
 * more precisely (namespace lock owner PID + recovery epoch lineage), by
 * acquireRecoveryLock in generation_recovery.ts. Used ONLY by the
 * `generation-recover` CLI entry point; every other command keeps calling
 * resolveControlRoots and keeps its existing fail-closed gate untouched.
 */
export function resolveControlRootsForRecovery(startPath: string, pmId: string, containerId?: string): ResolvedControlRoots {
  assertSafePmId(pmId);
  return resolveControlRootsSnapshot(startPath, pmId, containerId);
}
