// Claude Code adapter (`claude -p`). Behavior preserved verbatim from the
// pre-DEC-026 role.ts buildClaudeCommand + Claude JSON parse.

import type {
  ProviderAdapter,
  ProviderBuildOptions,
  ProviderCommand,
  ProviderParseOptions,
  ProviderOutput,
} from "./types.ts";
import { BASE_RATE_LIMIT_PATTERNS, looksRateLimitedWith, pathInsideOrSame, resolveSpawnCmd } from "./types.ts";

// Garelier's protocol REQUIRES driver-spawned roles to run a fixed set of git
// operations: base tracking (Dock §8.0), merge-gate CONFLICT resolution
// (Dock §8.1.B — `git checkout` studio + `git merge --no-ff --no-commit` +
// resolve + `git commit`), forward-integration / drift-resync (Worker/Smith
// §8.5/§8.6), and each role's own commits. In the `reviewed` profile
// (`--permission-mode acceptEdits`) Claude auto-accepts file EDITS but still
// gates Bash on the project's `.claude/settings.local.json` allowlist — so a
// stripped or incomplete allowlist silently blocks Dock from resolving a
// merge conflict (it falls back to bouncing the Worker to REWORK, which then
// cannot run `git merge` either → deadlock needing manual PM merge-assist).
// Grant the protocol's git command set here so conflict resolution works
// independent of the fragile project allowlist. `--allowedTools` is additive
// (union with settings.json), so the project's own allowlist (cargo, etc.) is
// unaffected. Deliberately EXCLUDES `git push` (protocol is local-only;
// Concierge owns external pushes), `git rebase` (protocol is merge-never-rebase),
// and `git reset --hard` (kept out of the blanket grant; clean-shutdown resets
// are driver-mediated). `Bash(git merge:*)` already covers `git merge --abort`.
// SINGLE SOURCE OF TRUTH for the allowed/forbidden split is the Librarian policy
// `skills/garelier-librarian/templates/git_command_policy.toml`. This list MUST
// mirror its `allowed` set and grant nothing in `forbidden`; `providers/
// git_allowlist_coverage.test.ts` fails CI if they drift (DEC-048 capability
// invariant). Change the policy and this list together.
export const GARELIER_GIT_ALLOWED_TOOLS: readonly string[] = [
  // read-only inspection (every role inspects git)
  "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)",
  "Bash(git rev-parse:*)", "Bash(git rev-list:*)", "Bash(git merge-base:*)",
  "Bash(git merge-tree:*)", "Bash(git for-each-ref:*)", "Bash(git cat-file:*)",
  "Bash(git ls-files:*)", "Bash(git branch:*)", "Bash(git fetch:*)",
  "Bash(git worktree:*)", "Bash(git remote:*)",
  // local mutation the merge / base-tracking / commit protocol needs.
  // `git switch` AND `git checkout` are both granted: a Worker/Smith cuts its
  // own workbench/anvil branch at pickup, and the assignment template uses the
  // modern `git switch -c <branch> <tip>` form — without `git switch` the
  // producer cannot enter WORKING (it can commit but not create its branch),
  // which silently blocks every new task. `git checkout` stays for `-b` and the
  // base-tracking / merge protocol.
  "Bash(git switch:*)", "Bash(git checkout:*)", "Bash(git merge:*)", "Bash(git add:*)",
  "Bash(git commit:*)", "Bash(git restore:*)", "Bash(git mv:*)",
  "Bash(git rm:*)", "Bash(git stash:*)", "Bash(git cherry-pick:*)",
];

// Guardian's default mandatory secret scanner is gitleaks. Claude Code's
// reviewed mode auto-accepts edits, but Bash still needs an allowlist entry; a
// missing scanner grant blocks every Guardian final gate even when gitleaks is
// installed. Keep this role-scoped so normal producer roles do not gain scanner
// command grants they never need.
export const GARELIER_GUARDIAN_ALLOWED_TOOLS: readonly string[] = [
  "Bash(gitleaks:*)",
  "Bash(gitleaks detect:*)",
  "Bash(gitleaks dir:*)",
  "Bash(gitleaks git:*)",
];

const COORD_ONLY_PROJECT_ROLES = new Set(["worker", "smith", "artisan"]);

// Turn declared autofix commands into `--allowedTools` grants so a producer can
// run its formatter headless (DEC-049 C1). Keep the binary plus a non-flag
// subcommand: "cargo fmt --all" -> Bash(cargo fmt:*), "go fmt ./..." ->
// Bash(go fmt:*), "ruff format ." -> Bash(ruff format:*), "gofmt -w ." ->
// Bash(gofmt:*). De-duped; empty/blank commands ignored.
export function autofixAllowedTools(cmds: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const cmd of cmds ?? []) {
    const toks = cmd.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    let prefix = toks[0];
    if (toks[1] && !toks[1].startsWith("-") && !/[\/.]/.test(toks[1])) prefix += ` ${toks[1]}`;
    // A comma (or the close-paren) would corrupt the comma-joined --allowedTools
    // string / the Bash(...) wrapper; never emit a malformed grant from a
    // mis-declared command.
    if (/[,)]/.test(prefix)) continue;
    out.add(`Bash(${prefix}:*)`);
  }
  return [...out];
}

function addDirArgs(dirs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push("--add-dir", dir);
  }
  return out;
}

export function claudeCodeAddDirArgs(opts: ProviderBuildOptions): string[] {
  const canUseCoordInsteadOfProject =
    !!opts.coordDir &&
    opts.checkout !== false &&
    COORD_ONLY_PROJECT_ROLES.has(opts.role);
  const dirs: string[] = [];
  dirs.push(canUseCoordInsteadOfProject ? opts.coordDir! : opts.projectRoot);
  dirs.push(opts.skillCoreDir);
  if (opts.coordDir && !pathInsideOrSame(opts.coordDir, opts.projectRoot)) {
    dirs.push(opts.coordDir);
  }
  return addDirArgs(dirs);
}

interface ClaudeJsonResult {
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export const claudeCodeAdapter: ProviderAdapter = {
  kind: "claude-code",

  defaultCommand() {
    return ["claude"];
  },

  async buildCommand(opts: ProviderBuildOptions): Promise<ProviderCommand> {
    const cmd = resolveSpawnCmd("claude-code", opts, ["claude"]);
    // dangerous = full autonomy (old default). reviewed = auto-accept edits but
    // not arbitrary commands. safe = default prompting (most restrictive; suited
    // to attended review rather than long headless runs).
    const profile = opts.permissionProfile ?? "reviewed";
    const allowedTools = opts.role === "guardian"
      ? [...GARELIER_GIT_ALLOWED_TOOLS, ...GARELIER_GUARDIAN_ALLOWED_TOOLS]
      : COORD_ONLY_PROJECT_ROLES.has(opts.role) && opts.autofixCommands?.length
      // DEC-049 C1: producers may run their declared formatter so a fmt nit is
      // fixed before REPORTING, not at the (expensive) merge gate.
      ? [...GARELIER_GIT_ALLOWED_TOOLS, ...autofixAllowedTools(opts.autofixCommands)]
      : GARELIER_GIT_ALLOWED_TOOLS;
    const permArgs = profile === "dangerous"
      ? ["--dangerously-skip-permissions"]
      : profile === "reviewed"
      ? ["--permission-mode", "acceptEdits",
         // Grant the Garelier protocol's git command set (merge/conflict
         // resolution, base tracking, commits) on top of the project allowlist,
         // so a stripped/incomplete settings.local.json can't silently block
         // Dock's §8.1.B conflict resolution. See GARELIER_GIT_ALLOWED_TOOLS.
         "--allowedTools", allowedTools.join(",")]
      : ["--permission-mode", "default"];
    const args: string[] = [
      ...claudeCodeAddDirArgs(opts),
      ...permArgs,
      "--append-system-prompt-file", opts.overrideFile,
      "--output-format", "json",
      "-p",
    ];
    if (opts.model && opts.model !== "claude-code") args.unshift("--model", opts.model);
    if (typeof opts.maxBudgetUsd === "number") args.unshift("--max-budget-usd", String(opts.maxBudgetUsd));
    return { cmd, args };
  },

  async parseOutput(opts: ProviderParseOptions): Promise<ProviderOutput> {
    const { stdoutRaw } = opts;
    try {
      if (stdoutRaw.trim()) {
        const obj = JSON.parse(stdoutRaw) as ClaudeJsonResult;
        return {
          result: obj.result,
          costUsd: obj.total_cost_usd,
          numTurns: obj.num_turns,
          usage: obj.usage,
        };
      }
    } catch {
      return { result: stdoutRaw };
    }
    return {};
  },

  looksRateLimited(text: string | undefined): boolean {
    return looksRateLimitedWith(BASE_RATE_LIMIT_PATTERNS, text);
  },
};
