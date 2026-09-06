// cwd_fence.ts — W-267: fail-closed fence against a control MUTATION landing in
// the wrong control tree because the shell's cwd was left inside a dispatch
// checkout / isolate worktree.
//
// The incident class (PM 実害 3 件 2026-07-28, #432 / #433): a garelier lane is a
// LINKED git worktree that is itself a full checkout, so it carries a COMMITTED
// `__garelier/` copy. `resolvePlant` resolves the control root by walking UP from
// the start path for the nearest `__garelier` (plant.ts, lithosphere branch), so a
// `garelier control work-create` run with cwd inside the lane resolves the INNER
// committed copy — the mutation writes into the checkout's tracked control tree and
// then rides that lane's workbench/isolate branch instead of studio. Both halves of
// the damage (foreign tree + misplaced commit) are silent; the id counter is shared,
// so the rows the primary tree then allocates come out with holes (W-674/676/677).
//
// The detection is mechanical and needs no seat knowledge: `--git-common-dir`
// resolves the SHARED `.git` even from a linked worktree, so its parent is the
// MAIN-worktree root that owns the canonical control tree. When the root a command
// actually resolved is a `__garelier` under a LINKED worktree and is not that
// canonical one, the command is addressing a committed copy — never correct for a
// mutation. Reads are unaffected (a read of the inner copy is harmless and is how a
// role inspects its own checkout).
//
// Deliberately NOT fenced:
//   - read verbs (see CONTROL_READ_COMMANDS) — cwd-independent by design;
//   - Plant-Crust mode — the container root comes from crust.toml, not from a
//     repo-relative walk-up, so the walk-up misplace class does not arise;
//   - a non-repo path (synthesized fixtures / a detached tree) — nothing to
//     compare against, so the fence stays inert rather than guessing;
//   - a main worktree whose resolved root differs from its own `__garelier`
//     (a legitimately nested project tree) — the incident class is linked
//     worktrees only, and denying nested roots would be over-deny with no
//     recorded incident behind it.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";
import { GARELIER_DIRNAME } from "../guard/record_paths.ts";
import { mainWorktreeRootFromGitDir, normalizePathFlavor, resetPathGuardRoots } from "../guard/path_guard.ts";

/** Git shape of a probed directory. Empty strings mean "not a git repo". */
export interface WorktreeShape {
  /** `git rev-parse --show-toplevel` — a LINKED worktree's own top. */
  topLevel: string;
  /** Parent of `--git-common-dir` — the MAIN worktree root that owns the
   *  canonical control tree, identical to `topLevel` in the main worktree. */
  mainWorktreeRoot: string;
}

/** Injectable git probe so the fence is testable without spawning git. */
export type WorktreeProbe = (dir: string) => WorktreeShape | null;

/** Verbs `control` serves without touching the tree. Everything else mutates and
 *  is fenced. Kept in sync with the early read dispatch in scripts/control.ts. */
export const CONTROL_READ_COMMANDS: ReadonlySet<string> = new Set([
  "context", "resume", "get", "list", "doctor", "graph", "help", "--help", "-h",
]);

export function isControlMutationCommand(command: string): boolean {
  return command.length > 0 && !CONTROL_READ_COMMANDS.has(command);
}

export interface ForeignRootInput {
  /** The control command verb (argv[0]). */
  command: string;
  /** `resolvePlant(...).garelierRoot` for the resolved `--project`. */
  garelierRoot: string | null;
  /** `resolvePlant(...).mode`; the fence applies to lithosphere only. */
  mode: string;
  probe: WorktreeProbe;
  /** Injectable existence check (tests supply a stub). */
  exists?: (path: string) => boolean;
}

export interface ForeignRootVerdict {
  foreign: boolean;
  /** The `__garelier` root the command resolved. */
  resolvedGarelierRoot?: string;
  /** The `__garelier` root the owning repo's MAIN worktree holds. */
  canonicalGarelierRoot?: string;
  /** Top of the linked worktree the resolved root sits in. */
  linkedWorktreeTop?: string;
  /** Repo root to `cd` into before retrying. */
  mainWorktreeRoot?: string;
}

function comparablePath(value: string): string {
  // W-354: the same real directory reaches this fence under a Windows and a
  // POSIX (MSYS) spelling depending on which shell produced it. Normalize
  // through the guard's ONE flavor rule before resolving, or `resolve("/c/env")`
  // invents `C:\c\env` and the two spellings of one root compare unequal.
  let out = resolve(normalizePathFlavor(value)).replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/+$/, "");
  if (process.platform === "win32") out = out.toLowerCase();
  return out;
}

const NOT_FOREIGN: ForeignRootVerdict = { foreign: false };

/**
 * Decide whether `garelierRoot` is a committed control copy inside a LINKED
 * worktree rather than the repo's canonical control tree. Pure apart from the
 * injected probe/exists, so the CLI and the tests share one rule.
 */
export function detectForeignControlRoot(input: ForeignRootInput): ForeignRootVerdict {
  if (!isControlMutationCommand(input.command)) return NOT_FOREIGN;
  if (input.mode !== "lithosphere") return NOT_FOREIGN;
  if (!input.garelierRoot) return NOT_FOREIGN;

  const exists = input.exists ?? existsSync;
  const resolvedGarelierRoot = resolve(input.garelierRoot);
  // The checkout that OWNS the resolved `__garelier` — that is the repo whose
  // worktree shape decides whether this root is the canonical one.
  const shape = input.probe(dirname(resolvedGarelierRoot));
  if (!shape?.topLevel || !shape.mainWorktreeRoot) return NOT_FOREIGN;

  const linkedWorktreeTop = resolve(shape.topLevel);
  const mainWorktreeRoot = resolve(shape.mainWorktreeRoot);
  // Main worktree: whatever it resolved is that repo's own business.
  if (comparablePath(linkedWorktreeTop) === comparablePath(mainWorktreeRoot)) return NOT_FOREIGN;

  const canonicalGarelierRoot = join(mainWorktreeRoot, GARELIER_DIRNAME);
  if (comparablePath(canonicalGarelierRoot) === comparablePath(resolvedGarelierRoot)) return NOT_FOREIGN;
  // No canonical tree to redirect to — stay inert rather than deny with no fix.
  if (!exists(canonicalGarelierRoot)) return NOT_FOREIGN;

  return { foreign: true, resolvedGarelierRoot, canonicalGarelierRoot, linkedWorktreeTop, mainWorktreeRoot };
}

/** The operator-facing refusal, naming both roots and the exact recovery. */
export function foreignCwdMessage(verdict: ForeignRootVerdict, command: string, pmId: string): string {
  return [
    `control ${command} refused (W-267 cwd fence): the resolved control root is a COMMITTED copy inside a linked worktree, not this repo's canonical control tree.`,
    `  resolved  : ${verdict.resolvedGarelierRoot}`,
    `  canonical : ${verdict.canonicalGarelierRoot}`,
    `  worktree  : ${verdict.linkedWorktreeTop} (a dispatch checkout / isolate lane)`,
    `Mutating there writes the checkout's tracked control tree and rides that lane's branch instead of studio.`,
    `Fix: cd ${verdict.mainWorktreeRoot} and re-run, or pass --project ${verdict.mainWorktreeRoot} (--pm-id ${pmId}).`,
    `Override only when the lane's own committed control tree is genuinely the target: --allow-foreign-cwd.`,
  ].join("\n");
}

/** Memo for the slow path: a worktree's shape cannot change mid-process, and the
 *  CLI is exercised many times per process by the test suite. */
const probeCache = new Map<string, WorktreeShape | null>();

/** W-467: the memo above is module state with no counterpart, exactly like the
 * path-guard root set. Within ONE process the same directory path can legitimately
 * change shape between operations — a fixture that was a plain directory in the
 * first scenario is a linked worktree in the second, or a checkout is created and
 * removed — and the memo then answers the second scenario with the first one's
 * shape, so a mutation that must be refused is allowed. Cleared at the same
 * caller boundary as the fence roots. */
export function resetWorktreeProbeCache(): void {
  probeCache.clear();
}

/** W-467: the ONE boundary call that drops every piece of accumulated
 * position state — the path-guard's configured roots and this worktree memo.
 * A caller that runs more than one independent operation in a process (the
 * in-process scenario runner, a launcher preparing several containers, a CLI
 * test suite) calls this BETWEEN operations. It only ever narrows: nothing here
 * adds a root or a cached shape, so it can never turn a refusal into an allow. */
export function resetPositionState(): void {
  resetPathGuardRoots();
  resetWorktreeProbeCache();
}

/**
 * Production probe.
 *
 * Fast path first: a MAIN worktree has a `.git` DIRECTORY, a LINKED worktree has a
 * `.git` FILE. Only the linked shape can be the misplace class, so the overwhelmingly
 * common case is answered from a single `lstat` with no subprocess at all. This is
 * not a micro-optimization — spawning `git rev-parse` on every mutation DOUBLED
 * control.test.ts (23s -> 49s) and pushed four tests past their 5s budget.
 *
 * A missing `.git` means the directory holding `__garelier` is not a checkout root,
 * which the incident class never is (a lane carries `__garelier` at its worktree
 * top), so it yields null and leaves the fence inert.
 */
export function gitWorktreeProbe(dir: string): WorktreeShape | null {
  const cached = probeCache.get(dir);
  if (cached !== undefined) return cached;
  const shape = probeUncached(dir);
  probeCache.set(dir, shape);
  return shape;
}

function probeUncached(dir: string): WorktreeShape | null {
  let dotGit;
  try { dotGit = lstatSync(join(dir, ".git")); } catch { return null; }
  if (dotGit.isDirectory()) {
    const root = resolve(dir);
    return { topLevel: root, mainWorktreeRoot: root };
  }
  try {
    const out = execFileSync(
      requireRuntimeExecutable("git"),
      ["-C", dir, "rev-parse", "--show-toplevel", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true },
    );
    const [topLevel = "", commonDir = ""] = out.trim().split(/\r?\n/).map((line) => line.trim());
    if (!topLevel || !commonDir) return null;
    // `--git-common-dir` is reported relative to `dir`; the gitdir's parent is the
    // main-worktree root in the standard `.git`-in-worktree layout.
    const gitDir = resolve(dir, commonDir);
    return { topLevel: resolve(topLevel), mainWorktreeRoot: mainWorktreeRootFromGitDir(gitDir) };
  } catch {
    return null;
  }
}
