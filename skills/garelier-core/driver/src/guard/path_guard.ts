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
  readFileSync as rawReadFileSync,
  realpathSync,
  fstatSync as rawFstatSync,
  openSync as rawOpenSync,
  closeSync as rawCloseSync,
  writeSync as rawWriteSync,
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
  basename,
  dirname,
  join,
  resolve,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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

/** W-354: the MSYS / Git-for-Windows / Cygwin spelling of an absolute Windows
 * path — `/c/env/x` and `/cygdrive/c/env/x` both name `C:/env/x`. On this
 * platform the SAME real directory therefore reaches the guard under two
 * spellings depending on which shell produced it (`pwd` under Git Bash vs
 * `process.cwd()` under Bun), and `inside()` compares FLAVORS before it compares
 * paths — so the POSIX spelling of an in-fence path was denied while the Windows
 * spelling of that identical path was allowed.
 *
 * This is the single normalization point the position-authority ruling asks for:
 * `canonicalPath`, `lexicalPath`, `nearestRepoRoot` and (through canonicalPath)
 * `defaultFenceRoots` / `assertPathMutation` all reach it, and command_guard
 * resolves its probe base through the same export, so no second spelling rule
 * can grow beside it.
 *
 * Scoped to a win32 HOST on purpose: on a POSIX host `/c/env` is a real
 * directory and rewriting it would invent a drive that does not exist. A UNC
 * path (`\\\\server\\share`, or `//server/share`) has two leading separators and
 * never matches; a multi-character first segment (`/tmp`, `/usr`) never matches
 * either, so only the single-letter drive spelling is converted. */
const MSYS_DRIVE_SPELLING = /^(?:\/cygdrive)?\/([A-Za-z])(?=\/|$)([\s\S]*)$/;

export function normalizePathFlavor(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const match = MSYS_DRIVE_SPELLING.exec(path);
  if (!match) return path;
  return `${match[1]!.toUpperCase()}:${match[2] === "" ? "/" : match[2]}`;
}

function flavor(path: string, cwd = process.cwd()): typeof win32 | typeof import("node:path").posix {
  return isWindowsPath(path) || (!/^[\\/]/.test(path) && isWindowsPath(cwd)) ? win32 : require("node:path").posix;
}

/** Resolve lexical `..` and, where the path exists, every symlink. For a path
 * that does not exist yet, realpath the nearest existing ancestor and append
 * the normalized missing suffix. */
export function canonicalPath(value: PathLike, cwd = process.cwd()): string {
  const raw = normalizePathFlavor(pathString(value));
  cwd = normalizePathFlavor(cwd);
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
  let dir = resolve(normalizePathFlavor(cwd));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The ONE rule that turns a repository's COMMON git directory into the main
 * worktree root: the standard layout is `<main>/.git`, so the root is that
 * directory's parent; a bare or relocated gitdir IS the root.
 *
 * `control/cwd_fence.ts` and `command_guard.ts` each open-coded this from
 * `git rev-parse --git-common-dir`, and an earlier revision of this bundle added
 * a THIRD copy (a `.git`-pointer reader named `mainWorktreeRoot`). Three copies
 * of one layout assumption is three places for it to drift, which is what the
 * position-authority ruling forbids; the two real call sites now share this one,
 * and the third was deleted rather than kept as an unfired guard — the control
 * route it was written for already declares the control root it resolved, which
 * covers every path that route writes.
 */
export function mainWorktreeRootFromGitDir(gitDir: string): string {
  return basename(gitDir).toLowerCase() === ".git" ? dirname(gitDir) : gitDir;
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

/** W-467: drop every root added by `configurePathGuardRoots`.
 *
 * `configuredRoots` is module state with an `add` and no counterpart, so in a
 * process that runs more than one operation — the in-process scenario runner,
 * the CLI test suites, a launcher that prepares several containers — the fence
 * only ever GREW. A root that one operation legitimately needed stayed trusted
 * for every operation afterwards, so the second run of a scenario that MUST be
 * refused was allowed by a root the first run had added. The reset is the
 * caller's boundary, not an automatic widening: nothing here adds a root. */
export function resetPathGuardRoots(): void {
  configuredRoots.clear();
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
  const cwd = normalizePathFlavor(options.cwd ?? process.cwd());
  const path = canonicalPath(pathString(value), cwd);
  const explicitRoots = options.fenceRoots !== undefined;
  const roots = (options.fenceRoots ?? defaultFenceRoots(cwd)).map((root) => canonicalPath(root, cwd));
  if (roots.length === 0) throw new Error("path_guard: no fence roots configured");
  if (depth(path) < 3) throw new Error(`path_guard: ${operation} denied for shallow/root path: ${path}`);
  if (containsGitComponent(path)) throw new Error(`path_guard: ${operation} denied for .git path: ${path}`);
  if (roots.some((root) => inside(root, path) && compareKey(root) !== compareKey(path))) {
    throw new Error(`path_guard: ${operation} denied for ancestor of a fence root: ${path}`);
  }
  if (!roots.some((root) => inside(path, root))) {
    // W-545/W-575 (GF-12): name where the fence CAME FROM. A refusal that shows
    // only the rejected path leaves the operator unable to tell a genuinely
    // out-of-scope write from a fence that shrank because the session cwd was
    // left inside a lane checkout — the two look identical at the call site.
    // Nothing is widened here; only the origin is reported.
    const origin = explicitRoots
      ? "caller-supplied fence roots (dispatch record)"
      : `session cwd (${cwd})`;
    throw new Error(
      `path_guard: ${operation} denied outside fence roots: ${path}`
      + ` [fence origin: ${origin}; roots: ${roots.join(", ")}]`,
    );
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

export interface ReparsePointDetachment {
  /** Link entries whose LINK was removed; their targets were not touched. */
  detached: string[];
  /** Links/dirs the walk could not resolve or detach. A recursive delete must
   *  NOT proceed past these — an undetached link is exactly the hazard. */
  failed: { path: string; reason: string }[];
}

function detachLinkEntry(path: string): void {
  // Order matters and differs per platform. POSIX: `unlink` removes a symlink
  // to anything, `rmdir` answers ENOTDIR. Windows: `unlink` refuses a junction
  // or directory symlink (EPERM), while RemoveDirectory detaches the reparse
  // point WITHOUT touching what it points at. Trying unlink first and falling
  // back to rmdir covers both without branching on process.platform.
  try {
    rawUnlinkSync(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  try {
    rawRmdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/**
 * Remove every reparse point inside `root` — POSIX symlinks, Windows symlinks,
 * and Windows junctions — deleting the LINK ENTRY and never descending into
 * what it points at.
 *
 * W-380: a recursive tree delete is only as safe as the weakest remover on the
 * path, and the removers disagree. Bun's `rmSync(recursive)` lstats each entry
 * and unlinks a link without following it. `git worktree remove` does not:
 * git.exe's own recursive removal WALKS THROUGH a Windows junction. Measured on
 * this platform, removing a worktree holding a junction left the junction's
 * target directory present but EMPTIED — every file under it deleted, outside
 * the tree that was being removed. That is how a measured incident destroyed a
 * primary checkout's dependency tree when a dispatch container was cleaned up:
 * the container's recursive delete reached out through a junction someone had
 * placed inside it.
 *
 * git.exe's traversal cannot be configured, so the fix is to leave it no link
 * to traverse: detach every reparse point first, then run the recursive delete
 * over a tree that contains none. Any caller that hands a tree to an EXTERNAL
 * recursive remover must call this before doing so; callers deleting through
 * `removeTreeSync` get it already.
 *
 * Fence note: when `root` is ITSELF a link, the fence is evaluated against its
 * canonical target rather than the link entry. That errs strict (a link aimed
 * outside the fence roots is refused rather than detached), which is the safe
 * direction for a destructive call.
 */
export function detachReparsePoints(root: PathLike, options: PathGuardOptions = {}): ReparsePointDetachment {
  const start = lexicalPath(pathString(root), options.cwd ?? process.cwd());
  const detachment: ReparsePointDetachment = { detached: [], failed: [] };

  let rootStat: Stats;
  try {
    rootStat = rawLstatSync(start);
  } catch (error) {
    // Nothing there is nothing to detach; the caller's delete is a no-op too.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return detachment;
    detachment.failed.push({ path: start, reason: `cannot lstat: ${(error as Error).message}` });
    return detachment;
  }

  assertPathMutation(start, "delete", options);

  const detach = (path: string): void => {
    try {
      detachLinkEntry(path);
      detachment.detached.push(path);
    } catch (error) {
      detachment.failed.push({ path, reason: `cannot detach link: ${(error as Error).message}` });
    }
  };

  if (rootStat.isSymbolicLink()) {
    detach(start);
    return detachment;
  }
  // A plain file holds no entries; only a real directory is walked. Without
  // this, readdir would answer ENOTDIR and be recorded as a failure, which
  // would make removeTreeSync refuse to delete an ordinary file.
  if (!rootStat.isDirectory()) return detachment;

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = rawReaddirSync(dir).map(String);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      detachment.failed.push({ path: dir, reason: `cannot read directory: ${(error as Error).message}` });
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stat: Stats;
      try {
        stat = rawLstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        detachment.failed.push({ path, reason: `cannot lstat: ${(error as Error).message}` });
        continue;
      }
      // A reparse point is detached, never entered — this is the whole point.
      if (stat.isSymbolicLink()) detach(path);
      else if (stat.isDirectory()) walk(path);
    }
  };
  walk(start);
  return detachment;
}

/**
 * Recursively delete a tree that may contain reparse points, without any
 * remover reaching outside it (W-380). Detaches every link first and REFUSES
 * the delete if any link could not be detached — proceeding would hand a live
 * link to the recursive remover, which is the failure this exists to prevent.
 */
export function removeTreeSync(path: PathLike, options: PathGuardOptions = {}): void {
  const detachment = detachReparsePoints(path, options);
  if (detachment.failed.length > 0) {
    const detail = detachment.failed.map((entry) => `${entry.path} (${entry.reason})`).join("; ");
    throw new Error(
      `path_guard: refusing to recursively delete ${pathString(path)} — ${detachment.failed.length} reparse point(s)/entries could not be detached first, and a recursive delete can follow a link out of the tree: ${detail}`,
    );
  }
  // Re-check immediately before deletion and retain the caller's explicit
  // fence. Calling the public rmSync wrapper here used to recompute the fence
  // from process.cwd(), rejecting an otherwise-authorized owned tree whenever
  // the launcher was operating from another checkout.
  const guarded = assertPathMutation(path, "delete", options);
  rawRmSync(guarded, { recursive: true, force: true });
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
  const raw = normalizePathFlavor(pathString(value));
  cwd = normalizePathFlavor(cwd);
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

/** GDN-B14: the single writer for a privileged process writing INTO a fence
 * another principal can also write to (Dock/PM writing into a producer lane).
 *
 * canonicalPath already resolves symlinks and reparse points, but a HARD LINK
 * shares an inode without appearing anywhere in the resolved path, so a
 * canonical-path check alone still lets a planted leaf carry a privileged
 * write through to a file outside the fence. These are the leaf properties a
 * path check cannot see, so they are checked on the leaf itself and every one
 * of them fails CLOSED:
 *
 *   - the leaf resolves to itself (no symlink or reparse point on the path),
 *   - it is a regular file (not a directory, device, or link),
 *   - its link count is exactly 1 (no hard link sharing the inode).
 *
 * Refusing is the point: silently writing elsewhere, or silently replacing the
 * planted leaf, would leave the attempt invisible. */
function inspectSafeLeaf(target: PathLike, label: string): { path: string; stat: Stats | null } {
  const path = pathString(target);
  const canonical = canonicalPath(path);
  if (compareKey(canonical) !== compareKey(resolve(path))) {
    throw new Error(`${label}: refused, path resolves through a link or reparse point: ${path} -> ${canonical}`);
  }
  // Only "the leaf is not there yet" is a safe reason to see no stat. Any other
  // lstat failure - a permission error, an I/O error, a reparse point the OS
  // refuses to describe - tells us the guard could not establish what it is
  // about to write to, so it must refuse rather than fall through as "missing".
  let info: Stats | null = null;
  try {
    info = rawLstatSync(canonical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new Error(`${label}: refused, cannot inspect destination leaf (${code ?? "unknown error"}): ${canonical}`);
    }
    info = null;
  }
  if (info) {
    if (info.isSymbolicLink()) throw new Error(`${label}: refused, destination leaf is a symbolic link: ${canonical}`);
    if (!info.isFile()) throw new Error(`${label}: refused, destination leaf is not a regular file: ${canonical}`);
    if (info.nlink !== 1) throw new Error(`${label}: refused, destination leaf has ${info.nlink} hard links: ${canonical}`);
  }
  return { path: canonical, stat: info };
}

/** GDN-B14 (r5): append to a descriptor, never to a path.
 *
 * assertSafeLeaf checks a PATH. Appending afterwards re-resolves that path, so
 * anything swapped in between - a hard link to a file outside the fence being
 * the dangerous one - receives the privileged bytes even though the check
 * passed. The gate log is append-only and cannot use the staged writer, so the
 * identity is re-established ON THE OPEN DESCRIPTOR (regular file, exactly one
 * link, same inode and device as the pre-check) and the bytes go to that same
 * descriptor. Nothing between the check and the write can redirect them. */
export function appendGuardedFileSync(target: PathLike, data: string | NodeJS.ArrayBufferView, label = "guarded append"): void {
  const pre = inspectSafeLeaf(target, label);
  assertPathMutation(pre.path, "write");
  const fd = rawOpenSync(pre.path, pre.stat ? "a" : "ax");
  try {
    const opened = rawFstatSync(fd);
    if (!opened.isFile()) throw new Error(`${label}: refused, opened descriptor is not a regular file: ${pre.path}`);
    if (opened.nlink !== 1) throw new Error(`${label}: refused, opened descriptor has ${opened.nlink} hard links: ${pre.path}`);
    if (pre.stat && (opened.ino !== pre.stat.ino || opened.dev !== pre.stat.dev)) {
      throw new Error(`${label}: refused, destination leaf was replaced between the check and the open: ${pre.path}`);
    }
    rawWriteSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  } finally {
    rawCloseSync(fd);
  }
}

export function assertSafeLeaf(target: PathLike, label = "guarded write"): string {
  return inspectSafeLeaf(target, label).path;
}

/** Write through assertSafeLeaf, then publish by exclusive-create + rename.
 * The payload is never written through the destination leaf, so even a leaf
 * swapped in after the check cannot receive the bytes: rename replaces the
 * directory entry instead of writing through whatever it points at. */
export function writeGuardedFileSync(target: PathLike, data: string | NodeJS.ArrayBufferView, label = "guarded write"): void {
  const canonical = assertSafeLeaf(target, label);
  assertPathMutation(canonical, "write");
  const staging = join(dirname(canonical), `.${randomUUID()}.staged`);
  let fd: number | undefined;
  try {
    fd = rawOpenSync(staging, "wx");
    rawWriteSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    rawCloseSync(fd);
    fd = undefined;
    assertSafeLeaf(canonical, label);
    rawRenameSync(staging, canonical);
  } finally {
    if (fd !== undefined) { try { rawCloseSync(fd); } catch { /* already closed */ } }
    try { if (existsSync(staging)) rawUnlinkSync(staging); } catch { /* published or already gone */ }
  }
}

export function copyFileSync(src: PathLike, dest: PathLike, mode?: number): void {
  assertPathMutation(dest, "write");
  rawCopyFileSync(src, dest, mode);
}
