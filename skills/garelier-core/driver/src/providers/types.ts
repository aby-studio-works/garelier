// Provider Adapter contract (DEC-026). Each provider CLI (Claude Code, Codex
// CLI, …) is isolated behind a ProviderAdapter so role.ts owns only the
// provider-agnostic iteration loop (prompt, cwd, spawn, timeout, logging) and
// never branches on provider kind. New providers are added as new adapters,
// never as `if (provider === ...)` in role.ts.

import type { ProviderKind, PermissionProfile } from "../config.ts";
import type { RoleKind } from "../prompts.ts";

export interface ProviderBuildOptions {
  cwd: string;
  role: RoleKind;
  projectRoot: string;
  skillCoreDir: string;
  skillRootDir: string;
  tmpDir: string;
  promptFile: string;
  overrideFile: string;
  // DEC-035: the role's coordination container (mailbox = parent of cwd). When
  // it sits OUTSIDE projectRoot (an exile home), adapters must `--add-dir` it so
  // the role can write ../STATE.md / ../report.md under a write-sandbox profile.
  // Undefined for PM/Dock (cwd is already their container, inside projectRoot).
  coordDir?: string;
  // DEC-021: false means a read-only role has no checkout and reads source via
  // git show/grep against projectRoot. Undefined is the default checkout=true.
  checkout?: boolean;
  // Spawn-command resolution: providerCommand (per-agent / per-provider env)
  // wins, then the legacy shared spawnCmd, then adapter.defaultCommand().
  spawnCmd?: string[];
  providerCommand?: string[];
  model?: string;
  effort?: string;
  maxBudgetUsd?: number;
  permissionProfile: PermissionProfile;
  // DEC-049 C1: deterministic formatter WRITE commands (e.g. `cargo fmt --all`)
  // the producer is allowed to run headless so it can auto-fix formatting before
  // REPORTING instead of failing the merge gate. Adapters that gate Bash by an
  // allowlist (claude-code `reviewed`) grant these for producer roles only.
  autofixCommands?: string[];
}

export interface ProviderCommand {
  cmd: string[];
  args: string[];
  // If set, stdin is read from this file instead of the role prompt file
  // (Codex prepends the headless directive into a `*.codex` file).
  stdinFile?: string;
  // If set, the provider writes its final message here (Codex
  // `--output-last-message`); parseOutput reads it.
  resultFile?: string;
  env?: Record<string, string>;
}

// DEC-035: when the role's coordination container is an exile home OUTSIDE
// projectRoot, grant the provider write access to it (else it cannot write
// ../STATE.md / ../report.md under a write-sandbox profile). Returns the
// `--add-dir <coordDir>` args, or [] when the container is inside projectRoot
// (legacy in-proj layout, already covered by --add-dir projectRoot).
export function pathInsideOrSame(child: string, parent: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/g, "");
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}/`);
}

export function exileCoordAddDir(opts: ProviderBuildOptions): string[] {
  return opts.coordDir && !pathInsideOrSame(opts.coordDir, opts.projectRoot)
    ? ["--add-dir", opts.coordDir]
    : [];
}

export interface ProviderParseOptions {
  stdoutRaw: string;
  stderrRaw: string;
  resultFile?: string;
}

export interface ProviderOutput {
  result?: string;
  costUsd?: number;
  numTurns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface ProviderAdapter {
  kind: ProviderKind;
  // Default spawn command when neither providerCommand nor spawnCmd is given.
  defaultCommand(): string[];
  buildCommand(opts: ProviderBuildOptions): Promise<ProviderCommand>;
  parseOutput(opts: ProviderParseOptions): Promise<ProviderOutput>;
  // True if the provider's stderr/stdout tail looks rate-limited.
  looksRateLimited(text: string | undefined): boolean;
}

// Provider-agnostic rate-limit signals. Different CLIs surface this
// differently; match on multiple stable substrings. Adapters may extend this
// with provider-specific patterns.
export const BASE_RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[_ -]?limit/i,
  /session[_ -]?limit/i,
  /usage[_ -]?limit/i,
  /hit your .*limit/i,
  /\b429\b/,
  /quota[_ -]?exceeded/i,
  /too[_ -]?many[_ -]?requests/i,
  /\bRateLimitError\b/,
  /overloaded/i,
];

export function looksRateLimitedWith(patterns: RegExp[], text: string | undefined): boolean {
  if (!text) return false;
  return patterns.some((re) => re.test(text));
}

// The env var that overrides a provider's spawn command, e.g.
// GARELIER_PROVIDER_GEMINI_CLI_CMD="npx @google/gemini-cli".
export function providerCmdEnvKey(kind: ProviderKind): string {
  return `GARELIER_PROVIDER_${kind.toUpperCase().replace(/-/g, "_")}_CMD`;
}

// Escape hatch for providers whose permission/sandbox CLI flags are version-
// sensitive (Gemini, Cursor — DEC-026 / DEC-033). By default the adapter passes its
// permission flags so the profile (safe/reviewed/dangerous) is enforced at the
// provider level. If a CLI version rejects a flag (the provider smoke catches
// this), set GARELIER_PROVIDER_<KIND>_PERMISSION=off to fall back to no
// permission flags — the agent is then still bounded by Garelier's worktree +
// gates. Returns true when the adapter SHOULD pass its permission flags.
export function providerPermissionFlagsEnabled(kind: ProviderKind): boolean {
  const v = process.env[`GARELIER_PROVIDER_${kind.toUpperCase().replace(/-/g, "_")}_PERMISSION`];
  if (v == null) return true;
  return !/^(off|0|false|no|none)$/i.test(v.trim());
}

// Minimal quote-aware argv split for an env-provided command string. TOML
// arrays are preferred (Windows-quoting safe); this is the env fallback.
export function splitArgv(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out.filter((t) => t !== "");
}

// A short wrapper prompt that points a provider at the full role prompt file
// (used by providers whose primary prompt transport is an argv arg, to avoid
// argv-length limits — Copilot / Cursor). Requires the prompt file's dir on the
// provider's allowed read paths.
export function wrapperPromptText(absPromptFile: string): string {
  return [
    "Read and execute the complete Garelier role prompt from this file:",
    absPromptFile,
    "",
    "Follow the Garelier role protocol exactly. Write all durable results to the",
    "files that prompt instructs. End with the single status line it requires.",
  ].join("\n");
}

// Resolve the spawn command for a build (DEC-026 resolution order):
//   1. per-agent providerCommand   2. GARELIER_PROVIDER_<KIND>_CMD env
//   3. legacy shared spawnCmd       4. adapter default
export function resolveSpawnCmd(kind: ProviderKind, opts: ProviderBuildOptions, fallback: string[]): string[] {
  if (opts.providerCommand && opts.providerCommand.length > 0) return opts.providerCommand;
  const env = process.env[providerCmdEnvKey(kind)];
  if (env && env.trim()) return splitArgv(env);
  if (opts.spawnCmd && opts.spawnCmd.length > 0) return opts.spawnCmd;
  return fallback;
}
