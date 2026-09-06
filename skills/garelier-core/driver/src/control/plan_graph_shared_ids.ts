// W-215: cross-worktree backlog id allocation.
//
// Problem: each isolate lane (`git worktree add`) is a FULL, independent
// checkout of __garelier/<pm_id>/control/. `nextBacklogNumber` (in
// plan_graph_write.ts) derives the next W-NNN purely from the ids visible in
// the CALLER's own control tree snapshot. Two lanes cut from the same base —
// or a lane and the primary checkout — cannot see each other's new backlog
// rows until a merge, so both independently compute the same "next" number
// and collide (real incidents: W-207 / W-210 / W-213, same day). Detecting
// the collision at merge time is too late; W-215 asks for prevention at
// create time.
//
// Design (compared against two alternatives before picking this one — see
// the W-215/W-223 register entry for the full trade-off table):
//   (a) PM-issued explicit ids for every create — rejected: makes every
//       backlog create synchronous on PM availability, defeats the point of
//       letting lanes originate work independently, and doesn't fix
//       already-decentralized batch creation (W-223).
//   (b) lane-slug-namespaced ids (e.g. W-<lane>-<n>) — rejected: breaks the
//       canonical `W-\d+` shape baked into many regexes across the schema-3
//       stack (assertLifecycleV3ControlPath, controlPath, doctor findings,
//       cross-references in already-written rows) for a one-worktree-local
//       problem; far larger blast radius than the fix warrants, and a new id
//       shape needs prior user approval per repo convention.
//   (c) [CHOSEN] a monotonic counter shared by every worktree of ONE
//       repository. `git worktree add` gives each worktree its own `.git`
//       file/dir, but `git rev-parse --git-common-dir` always resolves to the
//       same physical `.git` directory for every one of them — the one git
//       primitive that IS "visible to every lane, local-machine-only" by
//       construction. Its PARENT is therefore always the same primary
//       checkout root too, from any lane. The counter file itself is NOT
//       stored inside that `.git` dir (path_guard.ts hard-denies any
//       delete/rename touching a `.git` path component, for good reason — it
//       stops agent code from ever corrupting git's own internals, and this
//       feature has no business being an exception to that). Instead it goes
//       in the PRIMARY checkout's own `__garelier/<pm_id>/runtime/control/
//       id_counters/` — a location every lane can already reach via a plain
//       filesystem relative hop (a lane's worktree is physically a
//       subdirectory of the primary tree) and one that needs no new
//       containment exception: `runtime/` is already the existing,
//       already-gitignored, already-machine-local scratch area for exactly
//       this PM.
//
// Scope limit (Guardian N5): the counter lives in gitignored, machine-local
// `runtime/`. Two different machines, or a fresh clone, share no counter and
// get no cross-worktree protection from each other — this module only solves
// the same-machine multiple-worktree case the incidents were about.
//
// Rollout limit (Guardian N6, reproduced live during this feature's own
// dogfood): the guarantee only holds once EVERY worktree that can create a
// Backlog row is running this allocator. A worktree still on old code writes
// straight from its own local model max and never touches the shared
// counter, so an id it creates in that window is invisible to the counter —
// exactly the pre-W-215 failure, just narrowed to "old code vs. new code"
// instead of "any two worktrees". Once all creators are on this allocator,
// that gap closes.
//
// Self-healing floor (Guardian N1 — corrected claim): the reserved floor is
// always max(persisted counter, the CALLER's OWN local model max, any
// explicit ids observed this call). That is NOT "never causes reuse" in
// general — it only protects against loss of the persisted counter file
// itself (corruption, pre-feature vintage, first run). If the counter is
// lost AND a sibling worktree holds an uncommitted row this caller's model
// can't see, the allocator degrades to exactly the pre-W-215 local-max
// behavior for that one call — never worse than the status quo ante, but not
// a universal no-reuse guarantee across every failure combination.
//
// Correctness vs. performance (Guardian N3): the lock below is a performance/
// liveness optimization to avoid unnecessary contention, NOT the sole source
// of correctness. Even a mistaken steal (two writers briefly both believing
// they hold the lock) cannot silently corrupt the counter: writeCounterCas
// below re-reads the counter immediately before the atomic rename and
// refuses to write if it no longer matches what this call started from,
// fail-closed rather than silently overwriting a concurrent writer's bump.
//
// This module is the only impure (fs + git) half of backlog id allocation;
// plan_graph_write.ts's nextBacklogNumber/allocateBacklogId stay pure
// in-memory-model transforms and are reused here as the local floor.

import { closeSync, existsSync, lstatSync, openSync, readFileSync, writeFileSync as rawWriteFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { configurePathGuardRoots, mkdirSync, renameSync, unlinkSync } from "../guard/path_guard.ts";
import { resolveRuntimeExecutable } from "../scripts/_lib.ts";
import { nextBacklogNumber } from "./plan_graph_write.ts";
import type { PlanGraphControlModel } from "./plan_graph_types.ts";

export class SharedIdAllocatorError extends Error {
  constructor(readonly code: string, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SharedIdAllocatorError";
  }
}

// The critical section here is a single small JSON read+write (microseconds)
// — nothing like the multi-step control transaction this coordinates with.
// A bounded retry-with-backoff plus staleness-checked lock stealing is
// proportionate; borrowing the full generation-recovery journal machinery
// (built for the much larger control-transaction crash window) would be a
// disproportionate amount of new surface for this.
const LOCK_RETRY_ATTEMPTS = 80;
const LOCK_RETRY_DELAY_MS = 25; // ~2s bounded wait before giving up
// Guardian N3: a cross-host lock can never be liveness-checked at all, so it
// only ever expires by age; a short TTL is safe for a microsecond critical
// section.
const LOCK_CROSS_HOST_STALE_MS = 10_000;
// Guardian N3: the same-host pid-liveness check is an EARLY-STEAL
// optimization only, not the sole staleness signal — a lock survives crashes
// AND reboots (it lives in gitignored runtime/), and after a reboot pids are
// reassigned from low numbers, so a stale lock's recorded pid has a real
// chance of matching an unrelated live process (`process.kill(pid, 0)`
// succeeds, or a different-user process throws EPERM — both previously read
// as "still alive", so the same-host branch had NO age backstop at all: a
// permanently un-stealable lock, i.e. W-231's exact defect class reproduced
// in a brand-new lock domain). Every lock — same-host or not — is always
// judged against an age backstop; pid liveness can only make that happen
// SOONER, never prevent it. The threshold is generous (10 minutes) because
// this branch should essentially never fire outside true pid-recycling.
const LOCK_SAME_HOST_STALE_MS = 10 * 60 * 1000;

function pause(ms: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

/**
 * Resolves the directory git shares across every worktree of one repository.
 * Returns null outside a git repo (or when git itself is unavailable) — id
 * allocation then falls back to the single-worktree-local behavior, which is
 * correct there: without git there is no second worktree to collide with.
 */
export function resolveGitCommonDir(targetRoot: string): string | null {
  const git = resolveRuntimeExecutable("git");
  if (!git) return null;
  const result = spawnSync(git, ["-C", targetRoot, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(targetRoot, raw);
}

/**
 * Resolves the primary checkout root shared by every worktree of the same
 * repository (the common `.git` dir's parent). Returns null for a topology
 * this can't confidently place (no git, or a common dir not literally named
 * `.git` — e.g. a bare/submodule layout) — callers fall back to the local-
 * worktree-only floor in that case, same as the no-git case.
 */
export function resolveSharedPrimaryRoot(targetRoot: string): string | null {
  const gitCommonDir = resolveGitCommonDir(targetRoot);
  if (!gitCommonDir || basename(gitCommonDir).toLowerCase() !== ".git") return null;
  return dirname(gitCommonDir);
}

interface CounterLockInfo {
  token?: unknown;
  pid?: unknown;
  hostname?: unknown;
  acquired_at?: unknown;
}

function forceRemoveLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* raced with another stealer, or already gone; either outcome is fine */ }
}

// Filesystem mtime, not the JSON payload's `acquired_at` field, is the
// staleness clock — mtime is set by the OS at write time regardless of what
// the writer's own clock/content claims, survives reboots, and cannot be
// stale itself the way a torn/partial write of the JSON body theoretically
// could be. Guardian N3.
function lockAgeMs(lockPath: string): number {
  try { return Date.now() - lstatSync(lockPath).mtimeMs; }
  catch { return Number.POSITIVE_INFINITY; } // can't stat it — steal-eligible; the read that follows fails closed if it's genuinely gone
}

function stealIfAbandoned(lockPath: string): boolean {
  let info: CounterLockInfo;
  try { info = JSON.parse(readFileSync(lockPath, "utf8")) as CounterLockInfo; }
  catch { forceRemoveLock(lockPath); return true; } // corrupt/torn lock file — never a legitimate live holder
  const sameHost = info.hostname === hostname();
  if (sameHost && Number.isInteger(info.pid)) {
    // Early-steal optimization only — see the LOCK_SAME_HOST_STALE_MS note
    // above. A confirmed-dead pid steals immediately; anything else (alive,
    // or EPERM under another user) falls through to the age backstop below
    // instead of returning "still held" the way this branch used to.
    try { process.kill(info.pid as number, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") { forceRemoveLock(lockPath); return true; }
    }
  }
  const staleAfterMs = sameHost ? LOCK_SAME_HOST_STALE_MS : LOCK_CROSS_HOST_STALE_MS;
  if (lockAgeMs(lockPath) > staleAfterMs) {
    forceRemoveLock(lockPath);
    return true;
  }
  return false;
}

// F1 (Guardian): every destructive fs call (unlink/rename) in this module
// must route through guard/path_guard.ts, same as every other consumer in
// the driver (merge_gate.ts, long_jobs.ts). The guard's default fence roots
// are scoped to the calling process's OWN cwd/repo, which for a lane is the
// lane's own tree — not the sibling primary checkout this module
// deliberately targets. `configurePathGuardRoots` is the guard's own,
// already-exported mechanism for declaring an additional fence root; calling
// it here (idempotent — a Set) makes the exception explicit and auditable
// instead of silently opting out of the fence, and still gets every one of
// the guard's real protections (shallow-path deny, `.git`-component deny,
// fence-root-ancestor deny) for this directory.
function counterPathsFor(targetRoot: string, pmId: string): { counterPath: string; lockPath: string } | null {
  const primaryRoot = resolveSharedPrimaryRoot(targetRoot);
  if (!primaryRoot) return null;
  const counterDir = join(primaryRoot, "__garelier", pmId, "runtime", "control", "id_counters");
  configurePathGuardRoots([counterDir]);
  const counterPath = join(counterDir, "backlog.json");
  return { counterPath, lockPath: `${counterPath}.lock` };
}

function acquireCounterLock(lockPath: string): { release(): void } {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    let descriptor: number | null = null;
    try {
      // O_EXCL create is inherently non-destructive (can never clobber an
      // existing file), so this stays a raw node:fs call — consistent with
      // transaction.ts's own namespace-lock acquisition, which does the same.
      descriptor = openSync(lockPath, "wx", 0o600);
      rawWriteFileSync(descriptor, JSON.stringify({ token, pid: process.pid, hostname: hostname(), acquired_at: new Date().toISOString() }), "utf8");
      closeSync(descriptor);
      descriptor = null;
      return {
        release(): void {
          try {
            const current = JSON.parse(readFileSync(lockPath, "utf8")) as CounterLockInfo;
            if (current.token !== token) return; // already stolen/replaced; nothing to release
            unlinkSync(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
        },
      };
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw new SharedIdAllocatorError("id-lock-failed", `could not acquire shared id counter lock: ${(error as Error).message}`, error);
      if (stealIfAbandoned(lockPath)) continue; // retry immediately after a successful steal
      pause(LOCK_RETRY_DELAY_MS);
    }
  }
  throw new SharedIdAllocatorError("id-lock-contended", `shared id counter is locked: ${lockPath}`);
}

interface SharedIdCounterFile {
  schema_version: 1;
  kind: string;
  next: number;
  updated_at: string;
}

function readCounter(counterPath: string): number {
  if (!existsSync(counterPath)) return 0;
  try {
    const data = JSON.parse(readFileSync(counterPath, "utf8")) as Partial<SharedIdCounterFile>;
    return Number.isInteger(data.next) && (data.next as number) >= 0 ? (data.next as number) : 0;
  } catch {
    // Corrupt file (e.g. a kill mid-write, before the atomic rename below
    // existed). Self-heal: treat as absent — see the header note on what
    // this actually guarantees vs. what it does not (Guardian N1).
    return 0;
  }
}

// N2 (Guardian): the previous version wrote the counter with plain
// `writeFileSync` (open "w" = truncate-then-write) — a kill between the
// truncate and the write left a 0-byte file, which is indistinguishable from
// "never written" and silently drops the persisted floor. Write to a unique
// temp file (create-only, never overwrites anything) and `renameSync`
// (guarded, atomic on both POSIX and NTFS) into place instead: a kill can
// only land before the temp file is fully written (harmless — the real
// counterPath is untouched) or after the rename (the whole new value is
// live) — never a torn write of the live file.
//
// `expectedCurrent` is a compare-and-swap guard (Guardian N3's "id
// uniqueness is protected by the counter, not the lock" principle): the lock
// makes a concurrent writer during normal operation impossible, but this
// re-check narrows the residual window even for the extreme case of a
// mistaken lock steal (two callers briefly believing they both hold it) —
// if the counter no longer holds the value this call started from, someone
// else's write already landed, and blindly overwriting it could reissue an
// id. Fail closed (throw, caller's transaction aborts and can retry) instead
// of silently clobbering a concurrent writer's bump.
function writeCounterCas(counterPath: string, kind: string, expectedCurrent: number, next: number): void {
  const observed = readCounter(counterPath);
  if (observed !== expectedCurrent) {
    throw new SharedIdAllocatorError(
      "id-counter-cas-conflict",
      `shared id counter changed concurrently (expected ${expectedCurrent}, found ${observed}) — retry`,
    );
  }
  mkdirSync(dirname(counterPath), { recursive: true });
  const payload: SharedIdCounterFile = { schema_version: 1, kind, next, updated_at: new Date().toISOString() };
  const tmpPath = `${counterPath}.tmp-${randomUUID()}`;
  rawWriteFileSync(tmpPath, JSON.stringify(payload), "utf8"); // create-only write to a fresh unique path — never destructive
  renameSync(tmpPath, counterPath); // guarded — atomic replace, the sole point this can observably "commit"
}

function backlogNumber(id: string): number {
  const match = /^W-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function sequentialBacklogIds(start: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `W-${String(start + index).padStart(3, "0")}`);
}

export interface ReserveBacklogIdsOptions {
  /** The caller's own (possibly stale, lane-local) control model snapshot. */
  model: PlanGraphControlModel;
  targetRoot: string;
  pmId: string;
  /** Number of NEW auto-allocated ids to reserve. May be 0 (see below). */
  count: number;
  /**
   * Explicit ids used elsewhere in the same call (e.g. a batch row that set
   * `id` by hand, or the single explicit `--id` in a non-batch create). These
   * never get an id back from this function, but they DO raise the shared
   * counter's floor so a LATER auto-allocation (in this lane, another lane,
   * or after a merge) can never reissue a number an explicit id already used.
   */
  observedIds?: Iterable<string>;
}

/**
 * Reserves `count` sequential, monotonically-increasing, never-before-issued
 * backlog ids. With `count: 0` this is a floor-only maintenance call (used
 * for explicit-id creates) that returns `[]`.
 *
 * SIGKILL note (ties into W-223): the reservation itself is a single lock+
 * read+CAS-write+unlock, atomic and crash-safe on its own (see writeCounterCas
 * above for the write; a kill mid-lock-acquisition just leaves nothing
 * created). If the CALLER is killed after reserving but before the control
 * transaction that consumes the id(s) commits, the reserved number(s) are
 * simply never written to any backlog row — a gap, not a collision. That
 * satisfies "ids are never reused" without needing the reservation and the
 * control transaction to be one atomic unit.
 */
// The auto-id start point is deliberately computed WITHOUT the observed
// explicit ids folded in — an explicit id elsewhere in the same batch (e.g. a
// deliberately-chosen high number) must not push unrelated auto rows in that
// SAME batch up to meet it; that would turn one unrelated explicit id into a
// large, pointless gap for every plain auto row beside it. The observed ids
// only ever raise the counter's PERSISTED floor, for calls that come after
// this one. What must never happen is the auto range and an explicit id
// actually overlapping — checked explicitly below and rejected (fail-closed)
// rather than silently avoided, since silently shifting the start to dodge it
// would reintroduce the same "surprise gap" this split is avoiding.
function assertNoObservedOverlap(start: number, count: number, observedIds: readonly string[]): void {
  const end = start + count; // exclusive
  for (const id of observedIds) {
    const n = backlogNumber(id);
    if (n >= start && n < end) throw new SharedIdAllocatorError("id-collision", `explicit id ${id} collides with an id about to be auto-reserved in the same call`);
  }
}

export function reserveBacklogIds(options: ReserveBacklogIdsOptions): string[] {
  if (!Number.isInteger(options.count) || options.count < 0) throw new SharedIdAllocatorError("id-count-invalid", "reserve count must be a non-negative integer");
  const observedIds = [...(options.observedIds ?? [])];
  const observedFloor = observedIds.reduce((max, id) => Math.max(max, backlogNumber(id) + 1), 0);
  const modelFloor = nextBacklogNumber(options.model);
  const paths = counterPathsFor(options.targetRoot, options.pmId);
  if (!paths) {
    // No git (or no worktree-sharable common dir): nothing else can be
    // concurrently allocating against this control tree, so the local model
    // floor is already authoritative.
    assertNoObservedOverlap(modelFloor, options.count, observedIds);
    return options.count === 0 ? [] : sequentialBacklogIds(modelFloor, options.count);
  }
  const lock = acquireCounterLock(paths.lockPath);
  try {
    const current = readCounter(paths.counterPath);
    const start = Math.max(current, modelFloor);
    assertNoObservedOverlap(start, options.count, observedIds);
    const floor = Math.max(start + options.count, observedFloor);
    if (floor > current) writeCounterCas(paths.counterPath, "backlog", current, floor);
    return options.count === 0 ? [] : sequentialBacklogIds(start, options.count);
  } finally {
    lock.release();
  }
}
