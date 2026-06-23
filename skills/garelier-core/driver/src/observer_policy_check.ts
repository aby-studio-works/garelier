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
//   successful evaluation, exit 2 on a usage error. Computation failures
//   (no git, bad refs) fail OPEN with a stderr warning — the primary
//   enforcement is still the §7.5 skill hook + the request-verdict gate.

import { parse } from "smol-toml";

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

async function main(): Promise<void> {
  const [, , configPath, projectRoot, base, head, hasVerdictArg] = process.argv;
  if (!configPath || !projectRoot || !base || !head) {
    fail("usage: observer_policy_check.ts <config> <projectRoot> <base> <head> <hasPassingVerdict>");
  }
  const hasPassingVerdict = hasVerdictArg === "true";

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
    // Cannot read policy → fail open (skill hook is the primary enforcement).
    process.stderr.write(`observer_policy_check: cannot read config (${(e as Error).message}); skipping backstop\n`);
    process.stdout.write("");
    return;
  }

  if (!policy.enabled || hasPassingVerdict) {
    process.stdout.write("");
    return;
  }

  // Compute the merge's diff (base...head = what head introduces since the
  // merge-base). Fail open if git is unavailable or the refs don't resolve.
  let churn = 0;
  const changedFiles: string[] = [];
  try {
    const r = Bun.spawnSync(["git", "-C", projectRoot, "diff", "--numstat", `${base}...${head}`]);
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
      process.stderr.write(`observer_policy_check: git diff failed (exit ${r.exitCode}); skipping backstop\n`);
      process.stdout.write("");
      return;
    }
  } catch (e) {
    process.stderr.write(`observer_policy_check: git unavailable (${(e as Error).message}); skipping backstop\n`);
    process.stdout.write("");
    return;
  }

  process.stdout.write(policyReason(policy, { churn, changedFiles, hasPassingVerdict }));
}

if (import.meta.main) {
  void main();
}
