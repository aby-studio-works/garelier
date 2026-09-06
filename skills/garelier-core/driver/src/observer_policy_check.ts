// Mechanical Observer-policy backstop for the merge gate (DEC-019).
//
// §7.5 makes Observer review a skill-level decision: Dock reads
// [observer_policy] and sets observer_required on the merge request when a
// trigger fires. This module is the mechanical BACKSTOP for the triggers that
// are unambiguously computable from the diff — so a forgotten observer_required
// on a large or protected-path merge is still caught by the gate, not only by
// the LLM remembering the hook.
//
// Scope (mechanizable, dock-lane merges into studio):
//   - require_for_all_merges   → ANY merge must carry a passing Observer verdict
//                                (the "review every merge" mechanism — makes the
//                                worker→guardian→observer→dock order
//                                non-optional; small/benign diffs no longer slip
//                                through review-less)
//   - require_for_large_diff   → churn (added+deleted) >= large_diff_lines
//   - require_for_protected_paths → a changed file matches a protected glob
//                                   ([permissions].require_pm_approval_paths)
// The semantic triggers (public API / migration / auth-security) stay with the
// skill layer — they need content/intent judgment the gate cannot make. The
// artisan_premerge trigger is the Artisan's own responsibility because it
// integrates satchel→studio itself rather than through this Dock merge gate.
//
// Default-inert: when [observer_policy].enabled != true, this returns "" (no
// behavior change). When a passing Observer verdict is already present on the
// request, this also returns "" (review happened).
//
// CLI: bun observer_policy_check.ts <config> <projectRoot> <base> <head> <hasPassingVerdict>
//   prints the refusal reason ("" when none) to stdout; exit 0 always on a
//   successful evaluation, exit 2 on a usage error. Config/git/internal
//   failures print a machine-readable required/BLOCKED result so the merge
//   gate fails closed.

import { parse } from "smol-toml";
import { requireRuntimeExecutable } from "./scripts/_lib.ts";

export interface PolicyInputs {
  enabled: boolean;
  requireForAllMerges: boolean;
  requireForLargeDiff: boolean;
  largeDiffLines: number;
  requireForProtectedPaths: boolean;
  protectedGlobs: string[];
}

export interface DiffInputs {
  churn: number; // added + deleted lines introduced by the merge
  changedFiles: string[];
  hasPassingVerdict: boolean; // request already carried PASS / PASS_WITH_NOTES
}

// Placeholder for `**` while translating a glob to a regex, so the subsequent
// `*` → `[^/]*` step does not touch it. A plain readable string (no special
// chars, will not occur in a real path glob).
const DOUBLE_STAR_SENTINEL = "__GARELIER_GLOB_DOUBLESTAR__";

// Match a path against a protected glob. Uses Bun.Glob when available (handles
// **, *, ?); falls back to a minimal translation for tests/non-Bun contexts.
// Exported so review_brief.ts (DEC-081 Piece 2) reuses one implementation.
export function globMatch(glob: string, path: string): boolean {
  const G = (globalThis as { Bun?: { Glob: new (p: string) => { match(s: string): boolean } } }).Bun;
  if (G?.Glob) {
    try {
      return new G.Glob(glob).match(path);
    } catch {
      /* fall through */
    }
  }
  // Minimal fallback: ** → .*, * → [^/]*, ? → [^/]
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, DOUBLE_STAR_SENTINEL)
    .replace(/\*/g, "[^/]*")
    .split(DOUBLE_STAR_SENTINEL)
    .join(".*")
    .replace(/\?/g, "[^/]");
  return new RegExp("^" + body + "$").test(path);
}

// Pure decision. Returns a refusal reason, or "" when the merge may proceed.
export function policyReason(policy: PolicyInputs, diff: DiffInputs): string {
  if (!policy.enabled) return "";
  if (diff.hasPassingVerdict) return ""; // independent review already happened

  if (policy.requireForAllMerges) {
    return `observer review is mandatory ([observer_policy] require_for_all_merges) but no passing Observer verdict accompanies this merge`;
  }
  if (policy.requireForLargeDiff && diff.churn >= policy.largeDiffLines) {
    return `observer review is mandatory ([observer_policy] require_for_large_diff: ${diff.churn} changed lines >= large_diff_lines ${policy.largeDiffLines}) but no passing Observer verdict accompanies this merge`;
  }
  if (policy.requireForProtectedPaths && policy.protectedGlobs.length > 0) {
    for (const f of diff.changedFiles) {
      for (const g of policy.protectedGlobs) {
        if (globMatch(g, f)) {
          return `observer review is mandatory ([observer_policy] require_for_protected_paths: changed file '${f}' matches protected glob '${g}') but no passing Observer verdict accompanies this merge`;
        }
      }
    }
  }
  return "";
}

// W-066: is THIS merge high-stakes (does the refuter apply)? Returns a non-empty
// reason when the mechanically-computable require_for_* SUBSET fires, or "" when
// not. Two differences from policyReason, both deliberate:
//   1. It does NOT short-circuit on diff.hasPassingVerdict — a high-stakes merge
//      by definition ALREADY carries a passing Observer verdict; the refuter sits
//      ON TOP of that verdict, so "verdict present" must NOT suppress the check.
//   2. It does NOT count require_for_all_merges. That trigger is "review every
//      merge", not a high-stakes signal; counting it would make every daily merge
//      high-stakes and fire the refuter constantly — the exact opposite of the
//      cost design ("日常 merge は不焚"). Only large_diff and protected_paths — the
//      genuinely high-stakes, mechanizable subset — count here. The semantic
//      triggers (migration / public API / auth-security) are not diff-computable
//      and reach this layer via the request's explicit `high_stakes` flag instead.
export function highStakesReason(policy: PolicyInputs, diff: DiffInputs): string {
  if (!policy.enabled) return "";
  if (policy.requireForLargeDiff && diff.churn >= policy.largeDiffLines) {
    return `require_for_large_diff (${diff.churn} changed lines >= large_diff_lines ${policy.largeDiffLines})`;
  }
  if (policy.requireForProtectedPaths && policy.protectedGlobs.length > 0) {
    for (const f of diff.changedFiles) {
      for (const g of policy.protectedGlobs) {
        if (globMatch(g, f)) {
          return `require_for_protected_paths (changed file '${f}' matches protected glob '${g}')`;
        }
      }
    }
  }
  return "";
}

function fail(msg: string): never {
  process.stderr.write(`observer_policy_check: ${msg}\n`);
  process.exit(2);
}

function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

type PolicyFailureKind = "config" | "git" | "internal";

function blockedResult(failureKind: PolicyFailureKind, reason: string): string {
  return JSON.stringify({
    schema_version: 1,
    check: "observer_policy",
    status: "BLOCKED",
    required: true,
    failure_kind: failureKind,
    reason,
  });
}

function emitBlocked(failureKind: PolicyFailureKind, reason: string): void {
  process.stderr.write(`observer_policy_check: ${reason}\n`);
  process.stdout.write(blockedResult(failureKind, reason));
}

async function main(): Promise<void> {
  const [, , configPath, projectRoot, base, head, hasVerdictArg, modeArg] = process.argv;
  if (!configPath || !projectRoot || !base || !head) {
    fail("usage: observer_policy_check.ts <config> <projectRoot> <base> <head> <hasPassingVerdict> [mode]");
  }
  const hasPassingVerdict = hasVerdictArg === "true";
  // W-066: optional 6th arg. Default (absent) = the DEC-019 Observer gate mode
  // (existing callers pass 5 args, unchanged). "high-stakes" = report whether the
  // require_for_* subset makes this merge high-stakes for the refuter — which
  // does NOT short-circuit on a passing verdict (a high-stakes merge already has
  // one) and does NOT count require_for_all_merges.
  const highStakesMode = modeArg === "high-stakes";

  // Read [observer_policy] + [permissions] from the PM's setup_config.toml.
  let policy: PolicyInputs;
  try {
    const cfg = parse(await Bun.file(configPath).text()) as Record<string, unknown>;
    const op = (cfg.observer_policy ?? {}) as Record<string, unknown>;
    const perms = (cfg.permissions ?? {}) as Record<string, unknown>;
    const globs = Array.isArray(perms.require_pm_approval_paths)
      ? (perms.require_pm_approval_paths as unknown[]).map(String)
      : [];
    policy = {
      enabled: bool(op.enabled, false),
      requireForAllMerges: bool(op.require_for_all_merges, false),
      requireForLargeDiff: bool(op.require_for_large_diff, false),
      largeDiffLines: num(op.large_diff_lines, 800),
      requireForProtectedPaths: bool(op.require_for_protected_paths, false),
      protectedGlobs: globs,
    };
  } catch (e) {
    emitBlocked("config", `cannot read config (${(e as Error).message})`);
    return;
  }

  // The gate mode short-circuits when a passing verdict is already present
  // (review happened). High-stakes mode does NOT — it sits on top of that
  // verdict — so it only short-circuits on a disabled policy.
  if (!policy.enabled || (!highStakesMode && hasPassingVerdict)) {
    process.stdout.write("");
    return;
  }

  // Compute the merge's diff (base...head = what head introduces since the
  // merge-base). A missing executable or unresolved ref is not evidence that
  // review is unnecessary, so the backstop fails closed.
  let churn = 0;
  const changedFiles: string[] = [];
  try {
    const r = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", projectRoot, "diff", "--numstat", `${base}...${head}`], { windowsHide: true });
    if (r.exitCode === 0) {
      const text = new TextDecoder().decode(r.stdout);
      for (const line of text.split("\n")) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!m) continue;
        const added = m[1] === "-" ? 0 : parseInt(m[1], 10);
        const deleted = m[2] === "-" ? 0 : parseInt(m[2], 10);
        churn += added + deleted;
        changedFiles.push(m[3]);
      }
    } else {
      emitBlocked("git", `git diff failed (exit ${r.exitCode})`);
      return;
    }
  } catch (e) {
    emitBlocked("git", `git unavailable (${(e as Error).message})`);
    return;
  }

  const diff = { churn, changedFiles, hasPassingVerdict };
  process.stdout.write(highStakesMode ? highStakesReason(policy, diff) : policyReason(policy, diff));
}

if (import.meta.main) {
  await main().catch((e) => {
    emitBlocked("internal", `unexpected internal failure (${(e as Error).message})`);
  });
}
