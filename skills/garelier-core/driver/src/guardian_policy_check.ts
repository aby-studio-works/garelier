// Mechanical Guardian-policy backstop for the merge gate (DEC-024).
//
// Like observer_policy_check.ts, but for the SECURITY gate. Dock reads
// [guardian_policy] and sets guardian_required on a merge request when a
// trigger fires; this module is the mechanical BACKSTOP for the triggers that
// are unambiguously computable from the diff — so a forgotten guardian_required
// on a merge that touches a security-sensitive path, a package manifest /
// lockfile, or a protected path is still caught by the gate, not only by the
// LLM remembering the hook.
//
// Scope (mechanizable):
//   - require_for_all_merges            → ANY merge must carry a passing Guardian
//                                         verdict (the "gate every merge"
//                                         mechanism — makes the guardian step of
//                                         worker→guardian→observer→dock
//                                         non-optional, independent of which
//                                         paths the diff touched)
//   - require_for_protected_paths       → a changed file matches a protected
//                                         glob ([permissions].require_pm_approval_paths)
//   - require_for_dependency_changes /
//     require_for_lockfile_changes      → a changed file's basename is in
//                                         [guardian_policy.package_files].paths
//   - require_for_config_infra_ci_deploy /
//     require_for_auth_security         → a changed file matches a glob in
//                                         [guardian_policy.security_sensitive_paths].paths
// The semantic verdict (is there an actual secret / vuln / forbidden license?)
// stays with the Guardian — the gate only enforces that a passing Guardian
// verdict accompanies a merge that mechanically requires one.
//
// Default-inert: [guardian_policy].enabled != true → "". A passing Guardian
// verdict already on the request → "".
//
// CLI: bun guardian_policy_check.ts <config> <projectRoot> <base> <head> <hasPassingVerdict>
//   prints the refusal reason ("" when none) to stdout; exit 0 on a successful
//   evaluation, exit 2 on usage error. Computation failures (no git, bad refs)
//   fail OPEN with a stderr warning — the §-level skill hook + request-verdict
//   gate remain the primary enforcement.

import { parse } from "smol-toml";

export interface GuardianPolicyInputs {
  enabled: boolean;
  requireForAllMerges: boolean;
  requireForProtectedPaths: boolean;
  requireForDependencyChanges: boolean;
  requireForLockfileChanges: boolean;
  requireForConfigInfraCiDeploy: boolean;
  requireForAuthSecurity: boolean;
  protectedGlobs: string[];
  securitySensitivePaths: string[];
  packageFiles: string[];
}

export interface DiffInputs {
  changedFiles: string[];
  hasPassingVerdict: boolean; // request already carried PASS / PASS_WITH_NOTES
}

const DOUBLE_STAR_SENTINEL = "__GARELIER_GLOB_DOUBLESTAR__";

function globMatch(glob: string, path: string): boolean {
  const G = (globalThis as { Bun?: { Glob: new (p: string) => { match(s: string): boolean } } }).Bun;
  if (G?.Glob) {
    try {
      return new G.Glob(glob).match(path);
    } catch {
      /* fall through */
    }
  }
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, DOUBLE_STAR_SENTINEL)
    .replace(/\*/g, "[^/]*")
    .split(DOUBLE_STAR_SENTINEL)
    .join(".*")
    .replace(/\?/g, "[^/]");
  return new RegExp("^" + body + "$").test(path);
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// Pure decision. Returns a refusal reason, or "" when the merge may proceed.
export function policyReason(policy: GuardianPolicyInputs, diff: DiffInputs): string {
  if (!policy.enabled) return "";
  if (diff.hasPassingVerdict) return ""; // the gate already ran

  if (policy.requireForAllMerges) {
    return `guardian security gate is mandatory ([guardian_policy] require_for_all_merges) but no passing Guardian verdict accompanies this merge`;
  }

  const refuse = (trigger: string, f: string, pat: string) =>
    `guardian security gate is mandatory ([guardian_policy] ${trigger}: changed file '${f}' matches '${pat}') but no passing Guardian verdict accompanies this merge`;

  if (policy.requireForProtectedPaths) {
    for (const f of diff.changedFiles)
      for (const g of policy.protectedGlobs)
        if (globMatch(g, f)) return refuse("require_for_protected_paths", f, g);
  }
  if (policy.requireForDependencyChanges || policy.requireForLockfileChanges) {
    const names = new Set(policy.packageFiles.map(basename));
    for (const f of diff.changedFiles)
      if (names.has(basename(f))) return refuse("require_for_dependency_changes", f, basename(f));
  }
  if (policy.requireForConfigInfraCiDeploy || policy.requireForAuthSecurity) {
    for (const f of diff.changedFiles)
      for (const g of policy.securitySensitivePaths)
        if (globMatch(g, f)) return refuse("security_sensitive_paths", f, g);
  }
  return "";
}

function fail(msg: string): never {
  process.stderr.write(`guardian_policy_check: ${msg}\n`);
  process.exit(2);
}
function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}
function pathsOf(v: unknown): string[] {
  const paths = v && typeof v === "object" ? (v as { paths?: unknown }).paths : undefined;
  return Array.isArray(paths) ? paths.map(String) : [];
}

async function main(): Promise<void> {
  const [, , configPath, projectRoot, base, head, hasVerdictArg] = process.argv;
  if (!configPath || !projectRoot || !base || !head) {
    fail("usage: guardian_policy_check.ts <config> <projectRoot> <base> <head> <hasPassingVerdict>");
  }
  const hasPassingVerdict = hasVerdictArg === "true";

  let policy: GuardianPolicyInputs;
  try {
    const cfg = parse(await Bun.file(configPath).text()) as Record<string, unknown>;
    const gp = (cfg.guardian_policy ?? {}) as Record<string, unknown>;
    const perms = (cfg.permissions ?? {}) as Record<string, unknown>;
    const protectedGlobs = Array.isArray(perms.require_pm_approval_paths)
      ? (perms.require_pm_approval_paths as unknown[]).map(String)
      : [];
    policy = {
      enabled: bool(gp.enabled, false),
      requireForAllMerges: bool(gp.require_for_all_merges, false),
      requireForProtectedPaths: bool(gp.require_for_protected_paths, false),
      requireForDependencyChanges: bool(gp.require_for_dependency_changes, false),
      requireForLockfileChanges: bool(gp.require_for_lockfile_changes, false),
      requireForConfigInfraCiDeploy: bool(gp.require_for_config_infra_ci_deploy, false),
      requireForAuthSecurity: bool(gp.require_for_auth_security, false),
      protectedGlobs,
      securitySensitivePaths: pathsOf(gp.security_sensitive_paths),
      packageFiles: pathsOf(gp.package_files),
    };
  } catch (e) {
    process.stderr.write(`guardian_policy_check: cannot read config (${(e as Error).message}); skipping backstop\n`);
    process.stdout.write("");
    return;
  }

  if (!policy.enabled || hasPassingVerdict) {
    process.stdout.write("");
    return;
  }

  const changedFiles: string[] = [];
  try {
    const r = Bun.spawnSync(["git", "-C", projectRoot, "diff", "--name-only", `${base}...${head}`]);
    if (r.exitCode === 0) {
      for (const line of new TextDecoder().decode(r.stdout).split("\n")) {
        const f = line.trim();
        if (f) changedFiles.push(f);
      }
    } else {
      process.stderr.write(`guardian_policy_check: git diff failed (exit ${r.exitCode}); skipping backstop\n`);
      process.stdout.write("");
      return;
    }
  } catch (e) {
    process.stderr.write(`guardian_policy_check: git unavailable (${(e as Error).message}); skipping backstop\n`);
    process.stdout.write("");
    return;
  }

  process.stdout.write(policyReason(policy, { changedFiles, hasPassingVerdict }));
}

if (import.meta.main) {
  void main();
}
