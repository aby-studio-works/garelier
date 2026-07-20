// Shared filesystem path fence (W-113).
//
// Every destructive driver operation goes through these wrappers.  The fence is
// checked before node:fs is called, so an empty variable, a shallow/root path,
// a symlink escape, or a path outside the configured roots fails closed.

import {
  appendFileSync as rawAppendFileSync,
  copyFileSync as rawCopyFileSync,
  existsSync,
  lstatSync as rawLstatSync,
  mkdirSync as rawMkdirSync,
  readdirSync as rawReaddirSync,
  realpathSync,
  renameSync as rawRenameSync,
  rmSync as rawRmSync,
  rmdirSync as rawRmdirSync,
  unlinkSync as rawUnlinkSync,
  writeFileSync as rawWriteFileSync,
  type MakeDirectoryOptions,
  type Mode,
  type PathLike,
  type RmDirOptions,
  type RmOptions,
  type Stats,
  type WriteFileOptions,
} from "node:fs";
import { rm as rawRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  resolve,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";

export type PathMutation = "create" | "write" | "delete";

export interface PathGuardOptions {
  /** Stable trusted roots. Never derive these from the candidate path. */
  fenceRoots?: readonly PathLike[];
  cwd?: string;
}

const configuredRoots = new Set<string>();

function pathString(value: PathLike | null | undefined, label = "path"): string {
  if (value === null || value === undefined) throw new Error(`path_guard: ${label} is empty/undefined`);
  const text = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : String(value);
  if (text.trim() === "") throw new Error(`path_guard: ${label} is empty/undefined`);
  return text;
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

function flavor(path: string, cwd = process.cwd()): typeof win32 | typeof import("node:path").posix {
  return isWindowsPath(path) || (!/^[\\/]/.test(path) && isWindowsPath(cwd)) ? win32 : require("node:path").posix;
}

/** Resolve lexical `..` and, where the path exists, every symlink. For a path
 * that does not exist yet, realpath the nearest existing ancestor and append
 * the normalized missing suffix. */
export function canonicalPath(value: PathLike, cwd = process.cwd()): string {
  const raw = pathString(value);
  const p = flavor(raw, cwd);
  let absolute = p.isAbsolute(raw) ? p.resolve(raw) : p.resolve(cwd, raw);

  // A Windows path cannot be realpathed on a POSIX host (and vice versa). The
  // lexical canonical form is still useful for deterministic fixture tests.
  if ((p === win32) !== (process.platform === "win32")) return p.normalize(absolute);

  const missing: string[] = [];
  let probe = absolute;
  while (!existsSync(probe)) {
    const parent = p.dirname(probe);
    if (parent === probe) break;
    missing.unshift(p.basename(probe));
    probe = parent;
  }
  if (existsSync(probe)) {
    try {
      const base = realpathSync.native(probe);
      absolute = missing.length ? p.join(base, ...missing) : base;
    } catch {
      // A race may remove the ancestor after existsSync. Lexical resolution is
      // still fail-closed against the fence; the fs call will report the race.
    }
  }
  return p.normalize(absolute);
}

function compareKey(path: string): string {
  return isWindowsPath(path) ? win32.normalize(path).toLowerCase() : path;
}

function pathSeparator(path: string): string {
  return isWindowsPath(path) ? "\\" : "/";
}

function inside(path: string, root: string): boolean {
  if (isWindowsPath(path) !== isWindowsPath(root)) return false;
  const p = compareKey(path);
  const r = compareKey(root).replace(/[\\/]+$/, "");
  return p === r || p.startsWith(r + pathSeparator(root));
}

function depth(path: string): number {
  const p = flavor(path);
  const root = p.parse(path).root;
  const rest = path.slice(root.length).split(/[\\/]+/).filter(Boolean);
  // Count the filesystem root as one level: C:/x and /tmp are depth 2;
  // C:/x/y and /tmp/case are depth 3 and may be fenced.
  return 1 + rest.length;
}

function containsGitComponent(path: string): boolean {
  const p = flavor(path);
  const root = p.parse(path).root;
  return path.slice(root.length).split(/[\\/]+/).some((part) => part.toLowerCase() === ".git");
}

function nearestRepoRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function envRoots(): string[] {
  const roots = [
    process.env.GARELIER_PROJECT_ROOT,
    process.env.GARELIER_TARGET_ROOT,
    process.env.GARELIER_CONTAINER,
    process.env.GARELIER_SCRATCHPAD,
  ].filter((v): v is string => Boolean(v?.trim()));
  const packed = process.env.GARELIER_PATH_GUARD_ROOTS;
  if (packed) {
    try {
      const parsed = JSON.parse(packed);
      if (Array.isArray(parsed)) roots.push(...parsed.map(String));
      else roots.push(...packed.split(process.platform === "win32" ? ";" : ":"));
    } catch {
      roots.push(...packed.split(process.platform === "win32" ? ";" : ":"));
    }
  }
  return roots;
}

export function configurePathGuardRoots(roots: readonly PathLike[]): void {
  for (const root of roots) configuredRoots.add(pathString(root, "fence root"));
}

export function defaultFenceRoots(cwd = process.cwd()): string[] {
  const roots = [cwd, nearestRepoRoot(cwd), tmpdir(), ...envRoots(), ...configuredRoots]
    .filter((v): v is string => Boolean(v));
  return [...new Set(roots.map((root) => canonicalPath(root, cwd)))];
}

export function assertPathMutation(
  value: PathLike | null | undefined,
  operation: PathMutation,
  options: PathGuardOptions = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const path = canonicalPath(pathString(value), cwd);
  const roots = (options.fenceRoots ?? defaultFenceRoots(cwd)).map((root) => canonicalPath(root, cwd));
  if (roots.length === 0) throw new Error("path_guard: no fence roots configured");
  if (depth(path) < 3) throw new Error(`path_guard: ${operation} denied for shallow/root path: ${path}`);
  if (containsGitComponent(path)) throw new Error(`path_guard: ${operation} denied for .git path: ${path}`);
  if (roots.some((root) => inside(root, path) && compareKey(root) !== compareKey(path))) {
    throw new Error(`path_guard: ${operation} denied for ancestor of a fence root: ${path}`);
  }
  if (!roots.some((root) => inside(path, root))) {
    throw new Error(`path_guard: ${operation} denied outside fence roots: ${path}`);
  }
  return path;
}

export function rmSync(path: PathLike, options?: RmOptions): void {
  assertPathMutation(path, "delete");
  rawRmSync(path, options);
}

export async function rm(path: PathLike, options?: RmOptions): Promise<void> {
  assertPathMutation(path, "delete");
  await rawRm(path, options);
}

export function unlinkSync(path: PathLike): void {
  assertPathMutation(path, "delete");
  rawUnlinkSync(path);
}

export function rmdirSync(path: PathLike, options?: RmDirOptions): void {
  assertPathMutation(path, "delete");
  if (options === undefined) rawRmdirSync(path);
  else (rawRmdirSync as (path: PathLike, options: RmDirOptions) => void)(path, options);
}

/**
 * Remove only an empty probe-created `.git` directory directly under an exact
 * launcher-approved anchor. This is the sole exception to the general `.git`
 * mutation ban: it is non-recursive, rejects files/symlinks, and raw rmdir
 * atomically refuses deletion if a race makes the directory non-empty.
 */
export interface EmptyProbeGitRemovalOptions {
  cleanupRoots: readonly PathLike[];
  protectedGitPaths?: readonly PathLike[];
  operations?: {
    lstatSync?: (path: PathLike) => Stats;
    readdirSync?: (path: PathLike) => string[];
    realpathSync?: (path: PathLike) => string;
    rmdirSync?: (path: PathLike) => void;
  };
}

export interface EmptyProbeGitRemovalResult {
  removed: boolean;
  candidate: string;
  reason: string;
}

function lexicalPath(value: PathLike, cwd = process.cwd()): string {
  const raw = pathString(value);
  const p = flavor(raw, cwd);
  return p.normalize(p.isAbsolute(raw) ? raw : p.resolve(cwd, raw));
}

function sameFsIdentity(a: Stats, b: Stats): boolean {
  if (a.dev !== 0 || a.ino !== 0 || b.dev !== 0 || b.ino !== 0) return a.dev === b.dev && a.ino === b.ino;
  return true;
}

/** Strict, non-recursive exception for launcher-created empty `.git` probes. */
export function removeEmptyProbeGitDirSync(
  candidateInput: PathLike,
  options: EmptyProbeGitRemovalOptions,
): EmptyProbeGitRemovalResult {
  const candidate = lexicalPath(candidateInput);
  const p = flavor(candidate);
  const result = (removed: boolean, reason: string): EmptyProbeGitRemovalResult => ({ removed, candidate, reason });
  const allowed = options.cleanupRoots.map((root) => p.join(canonicalPath(root), ".git"));
  if (!allowed.some((path) => compareKey(path) === compareKey(candidate))) return result(false, "outside cleanup-root allowlist");
  const parent = p.dirname(candidate);
  if (!allowed.some((path) => compareKey(p.dirname(path)) === compareKey(parent)) || p.basename(candidate).toLowerCase() !== ".git") {
    return result(false, "candidate is not exact <cleanup-root>/.git");
  }
  const protectedPaths = (options.protectedGitPaths ?? []).map((path) => lexicalPath(path));
  if (protectedPaths.some((path) => compareKey(path) === compareKey(candidate))) return result(false, "protected project/worktree git metadata");
  if (depth(parent) < 3) return result(false, "cleanup root is shallow");

  const lstat = options.operations?.lstatSync ?? rawLstatSync;
  const readdir = options.operations?.readdirSync ?? ((path: PathLike) => rawReaddirSync(path).map(String));
  const realpath = options.operations?.realpathSync ?? ((path: PathLike) => realpathSync(path));
  const rmdir = options.operations?.rmdirSync ?? rawRmdirSync;
  try {
    const first = lstat(candidate);
    if (!first.isDirectory() || first.isSymbolicLink()) return result(false, "candidate is not a normal directory");
    if (compareKey(realpath(candidate)) !== compareKey(candidate)) return result(false, "candidate is a reparse/symlink target");
    if (readdir(candidate).length !== 0) return result(false, "candidate is non-empty");
    const second = lstat(candidate);
    if (!second.isDirectory() || second.isSymbolicLink() || !sameFsIdentity(first, second)) {
      return result(false, "candidate identity changed during verification");
    }
    if (readdir(candidate).length !== 0) return result(false, "candidate became non-empty during verification");
    rmdir(candidate);
    return result(true, "removed exact empty probe directory");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    return result(false, `verification/rmdir failed (${code})`);
  }
}

export function renameSync(oldPath: PathLike, newPath: PathLike): void {
  assertPathMutation(oldPath, "delete");
  assertPathMutation(newPath, "write");
  rawRenameSync(oldPath, newPath);
}

// Creation/write wrappers are available to every driver script that creates a
// new mutation surface. The destructive-call lint is intentionally narrower;
// existing writes migrate incrementally while every new guarded path can share
// the same canonical fence contract.
export function mkdirSync(path: PathLike, options?: MakeDirectoryOptions & { recursive?: false }): string | undefined;
export function mkdirSync(path: PathLike, options: MakeDirectoryOptions & { recursive: true }): string | undefined;
export function mkdirSync(path: PathLike, options?: Mode | (MakeDirectoryOptions & { recursive?: boolean })): string | undefined {
  assertPathMutation(path, "create");
  return rawMkdirSync(path, options as any) as string | undefined;
}

export function writeFileSync(file: PathLike | number, data: string | NodeJS.ArrayBufferView, options?: WriteFileOptions): void {
  if (typeof file !== "number") assertPathMutation(file, "write");
  rawWriteFileSync(file, data, options);
}

export function appendFileSync(file: PathLike | number, data: string | Uint8Array, options?: Parameters<typeof rawAppendFileSync>[2]): void {
  if (typeof file !== "number") assertPathMutation(file, "write");
  rawAppendFileSync(file, data, options);
}

export function copyFileSync(src: PathLike, dest: PathLike, mode?: number): void {
  assertPathMutation(dest, "write");
  rawCopyFileSync(src, dest, mode);
}
