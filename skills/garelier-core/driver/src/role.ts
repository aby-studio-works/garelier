// Per-role iteration. Spawns the configured provider as a subprocess with the
// right cwd and prompt via stdin. Provider-specific command building, output
// parsing, and rate-limit detection live behind a ProviderAdapter
// (`providers/`, DEC-026) — role.ts never branches on provider kind.
//
// The driver intentionally shells out to local CLIs instead of using a
// model SDK directly:
//   - Claude Code and Codex CLI both use their own local auth/session
//     stores, so users can run Garelier with the accounts they already
//     use interactively.
//   - The provider boundary lets one PM/Dock/Worker/Scout/Smith pool mix
//     Claude and Codex agents, and lets a project switch providers when
//     one account is rate-limited.
//
// Bun.spawn passes args as an OS argv array (no shell parsing), so long
// prompts and Windows quoting edge cases stay controlled. We own cwd,
// env, stdin, stdout, and stderr explicitly.

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "./log.ts";
import { buildIterationPrompt, getHeadlessDirective, type RoleKind, type RoleContext } from "./prompts.ts";
import {
  roleOutputPolicy,
  buildOutputDirective,
  buildAuthoringDirective,
  summarizeProviderResult,
  checkOutputBudget,
  DEFAULT_OUTPUT_CONTROL,
  type OutputControlConfig,
} from "./output_control.ts";
import type { ProviderKind, PermissionProfile } from "./config.ts";
import { getProviderAdapter } from "./providers/index.ts";

export interface RoleRunResult {
  outcome: "ok" | "incomplete" | "refused" | "spawn_error" | "non_zero_exit" | "rate_limited";
  exitCode: number | null;
  durationMs: number;
  finalActionKind?: FinalActionKind;
  resultText?: string;
  costUsd?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheCreation?: number;
    cacheRead?: number;
  };
  errorMessage?: string;
  // ISO timestamp (or null) — if a provider reported a retry-after hint.
  rateLimitRetryAfter?: string | null;
}

export interface RunIterationOptions {
  role: RoleKind;
  ctx: RoleContext;
  log: Logger;
  provider: ProviderKind;
  // Absolute path to per-driver tmp dir. We write per-iteration prompt
  // files here so no provider sees argv-length-limited prompt text.
  tmpDir: string;
  projectRoot: string;
  // Absolute path of garelier-core skill dir. The sibling directory is
  // passed to Codex so it can read garelier-pm/dock/worker/scout/smith.
  skillCoreDir: string;
  // Override the spawn command. Default depends on provider:
  // ["claude"] for claude-code, ["codex"] for codex-cli.
  spawnCmd?: string[];
  // Provider model. If undefined, provider default/user config applies.
  model?: string;
  // Reasoning effort. Currently passed to Codex CLI as
  // `-c model_reasoning_effort="<effort>"`; ignored by claude-code.
  effort?: string;
  // Per-iteration spend cap. Claude Code only. Default:
  // env GARELIER_MAX_BUDGET_USD or none.
  maxBudgetUsd?: number;
  // Iteration timeout in ms. Default 6 hours.
  timeoutMs?: number;
  // Permission profile (safe | reviewed | dangerous). Controls how much
  // autonomy the provider CLI is granted. Default reviewed.
  permissionProfile?: PermissionProfile;
  // Output Control (DEC-028). Bounds the provider final-response length and the
  // stored log excerpt. Absent => DEFAULT_OUTPUT_CONTROL (enabled).
  outputControl?: OutputControlConfig;
  // DEC-049 C1: formatter WRITE commands granted to producer roles so they can
  // auto-fix formatting headless before REPORTING. Passed through to the adapter.
  autofixCommands?: string[];
}

// Timeout is positioned as a STUCKNESS detector, not a deadline for
// honest work. Real implementation iterations on large codebases can
// legitimately run for hours (build/test/gate cycles). Six hours means
// the only thing that triggers it is a genuine hang.
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export async function runIteration(opts: RunIterationOptions): Promise<RoleRunResult> {
  const {
    role,
    ctx,
    log,
    provider,
    tmpDir,
    projectRoot,
    skillCoreDir,
    spawnCmd,
    model,
    effort,
    maxBudgetUsd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    permissionProfile = "reviewed",
    outputControl = DEFAULT_OUTPUT_CONTROL,
    autofixCommands,
  } = opts;

  // Output Control policy for this role (DEC-028).
  const outPolicy = roleOutputPolicy(outputControl, role);

  // ---- Write per-iteration prompt file -----------------------------------
  await mkdir(tmpDir, { recursive: true });
  const overrideFile = join(tmpDir, "headless_override.txt");
  await writeFile(overrideFile, getHeadlessDirective(), "utf8");

  const skillRootDir = dirname(skillCoreDir);
  const promptCtx: RoleContext = { ...ctx, skillRootDir, providerKind: provider };
  const promptText = buildIterationPrompt(role, promptCtx);
  // Append the output-control directive to the prompt body so it reaches EVERY
  // provider uniformly (all adapters transport the prompt file). This keeps the
  // provider's screen-facing final response short while durable detail goes to
  // the role's official files — it does NOT change role-state parsing.
  const directives: string[] = [];
  if (outputControl.enabled) directives.push(buildOutputDirective(outPolicy));
  // Authoring directive (DEC-049): language + terse two-tier shape. Independent
  // of the length budget; "" when nothing is configured.
  const authoring = buildAuthoringDirective(outputControl.language, outputControl.terse);
  if (authoring) directives.push(authoring);
  const fullPrompt = directives.length
    ? `${promptText}\n\n${directives.join("\n\n")}\n`
    : promptText;
  const promptBytes = Buffer.byteLength(fullPrompt, "utf8");
  const promptFile = join(tmpDir, `${role}${ctx.workerOrScoutId ? "-" + ctx.workerOrScoutId : ""}.prompt`);
  await writeFile(promptFile, fullPrompt, "utf8");

  // DEC-020: the provider runs in the git worktree (= <container>/checkout).
  // worktreeDir is set by main.ts; fall back to <container>/checkout, then to
  // the role default. PM/Dock have no worktree — their default cwd stands.
  // DEC-021: a read-only role with checkout=false has NO worktree — its cwd is
  // the coordination container (it reads source via git show/grep).
  const cwd =
    ctx.checkout === false
      ? (ctx.workerOrScoutCwd ?? roleDefaultCwd(role, projectRoot, ctx.pmId))
      : (ctx.worktreeDir ??
         (ctx.workerOrScoutCwd ? `${ctx.workerOrScoutCwd}/checkout` : undefined) ??
         roleDefaultCwd(role, projectRoot, ctx.pmId));

  log.info("iteration_start", {
    role,
    provider,
    pm_id: ctx.pmId,
    id: ctx.workerOrScoutId,
    cwd,
    model: model ?? null,
    effort: effort ?? null,
    prompt_bytes: promptBytes,
  });

  // DEC-026: the provider is isolated behind an adapter; role.ts never
  // branches on provider kind.
  const adapter = getProviderAdapter(provider);
  const providerCmd = await adapter.buildCommand({
    cwd,
    role,
    projectRoot,
    skillCoreDir,
    skillRootDir,
    tmpDir,
    promptFile,
    overrideFile,
    coordDir: ctx.workerOrScoutCwd, // DEC-035: exile mailbox -> --add-dir in adapters
    checkout: ctx.checkout,
    spawnCmd,
    model,
    effort,
    maxBudgetUsd,
    permissionProfile,
    autofixCommands,
  });

  // ---- Spawn -------------------------------------------------------------
  const t0 = Date.now();
  const stdinFile = providerCmd.stdinFile ?? promptFile;
  const stdinBytes = await Bun.file(stdinFile).arrayBuffer();
  let proc;
  try {
    proc = Bun.spawn([...providerCmd.cmd, ...providerCmd.args], {
      cwd,
      stdin: new Uint8Array(stdinBytes),
      stdout: "pipe",
      stderr: "pipe",
      // GARELIER_DRIVER marks every provider session the driver spawns
      // headlessly. The PM's _pm/.claude/settings.json SessionEnd hook
      // (touch runtime/driver/stop) is meant ONLY for the user's INTERACTIVE
      // PM `/quit`; under supervise_pm=true the driver runs PM headlessly each
      // poll, and without this marker every headless PM SessionEnd would touch
      // the stop file and kill the driver after one iteration. The hook gates
      // on this var being absent. Do not remove. See the SessionEnd hook in
      // setup_wizard.{sh,ps1} and ../../../../__garelier/<pm_id>/control/decisions/DEC-002-autonomous-mode-via-per-iteration-claude-p-driver.md.
      env: { ...process.env, GARELIER_DRIVER: "1", ...(providerCmd.env ?? {}) },
      // Windows: keep the headless provider CLI (`claude -p`, codex, …) from
      // popping its own console window. No-op on POSIX.
      windowsHide: true,
    });
  } catch (e) {
    const msg = (e as Error).message;
    log.error("spawn_failed", { provider, error: msg });
    return {
      outcome: "spawn_error",
      exitCode: null,
      durationMs: Date.now() - t0,
      errorMessage: msg,
    };
  }

  // ---- Timeout -----------------------------------------------------------
  const timer = setTimeout(() => {
    log.warn("iteration_timeout", { provider, timeout_ms: timeoutMs });
    try { proc.kill(); } catch { /* ignore */ }
  }, timeoutMs);

  const [stdoutRaw, stderrRaw] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const durationMs = Date.now() - t0;

  // ---- Parse output ------------------------------------------------------
  const parsed = await adapter.parseOutput({ stdoutRaw, stderrRaw, resultFile: providerCmd.resultFile });
  const finalActionKind = classifyFinalActionKind(parsed.result);

  // ---- Output Control (DEC-028): excerpt the stored result, warn if long ----
  // We NEVER truncate parsed.result itself — role-state decisions still see the
  // full response. Only the JSONL-stored excerpt is bounded, and an over-budget
  // response is WARNED (observation), not failed (violation_mode "warn").
  const budget = checkOutputBudget(parsed.result, outPolicy);
  const excerpt = outputControl.enabled
    ? summarizeProviderResult(parsed.result, outputControl.modelResultLogChars)
    : (parsed.result?.trim() ? parsed.result.trim().slice(0, 1000) : undefined);
  if (excerpt) {
    log.info("model_result", {
      text: excerpt,
      result_chars: budget.resultChars,
      output_profile: outPolicy.profile,
      soft_result_chars: outPolicy.softResultChars,
      over_budget: budget.overBudget,
    });
  }
  if (outputControl.enabled && budget.overBudget) {
    log.warn("output_budget_exceeded", {
      role,
      provider,
      id: ctx.workerOrScoutId,
      result_chars: budget.resultChars,
      soft_result_chars: outPolicy.softResultChars,
      profile: outPolicy.profile,
    });
  }

  const errTail = outputControl.errorTailChars;
  if (exitCode !== 0) {
    // Guard the zero case: slice(-0) === slice(0) returns the WHOLE string, so a
    // configured error_tail_chars = 0 (a valid "disable the tail" value) would
    // otherwise log the full stderr/stdout — the opposite of the intent.
    const stderrTail = errTail > 0 ? stderrRaw.slice(-errTail) : "";
    const stdoutTail = errTail > 0 ? stdoutRaw.slice(-errTail) : "";
    const resultTail = errTail > 0 ? (parsed.result ?? "").slice(-errTail) : "";
    const failureTail = stderrTail || stdoutTail || resultTail;
    const rateLimited =
      adapter.looksRateLimited(stderrTail) ||
      adapter.looksRateLimited(stdoutTail) ||
      adapter.looksRateLimited(resultTail);
    if (rateLimited) {
      log.error("rate_limited", {
        provider,
        exit_code: exitCode,
        duration_ms: durationMs,
        stderr_tail: stderrTail,
        stdout_tail: stdoutTail,
        result_tail: resultTail,
        prompt_bytes: promptBytes,
        final_action_kind: finalActionKind,
      });
      return {
        outcome: "rate_limited",
        exitCode,
        durationMs,
        finalActionKind,
        resultText: parsed.result,
        errorMessage: failureTail,
      };
    }
    log.error("iteration_failed", {
      provider,
      exit_code: exitCode,
      duration_ms: durationMs,
      stderr_tail: stderrTail,
      prompt_bytes: promptBytes,
      final_action_kind: finalActionKind,
    });
    return {
      outcome: "non_zero_exit",
      exitCode,
      durationMs,
      finalActionKind,
      resultText: parsed.result,
      errorMessage: failureTail,
    };
  }

  log.info("iteration_end", {
    provider,
    duration_ms: durationMs,
    cost_usd: parsed.costUsd,
    num_turns: parsed.numTurns,
    input_tokens: parsed.usage?.input_tokens,
    output_tokens: parsed.usage?.output_tokens,
    cache_read: parsed.usage?.cache_read_input_tokens,
    cache_write: parsed.usage?.cache_creation_input_tokens,
    result_chars: budget.resultChars,
    output_profile: outPolicy.profile,
    over_budget: budget.overBudget,
    prompt_bytes: promptBytes,
    final_action_kind: finalActionKind,
  });

  // DEC-028: append a monthly usage-summary record so token / output / over-
  // budget trends are inspectable per role+provider (gitignored runtime path).
  if (outputControl.usageSummary) {
    await recordUsageSummary(projectRoot, ctx.pmId, {
      ts: new Date().toISOString(),
      role,
      id: ctx.workerOrScoutId ?? null,
      provider,
      profile: outPolicy.profile,
      duration_ms: durationMs,
      input_tokens: parsed.usage?.input_tokens ?? null,
      output_tokens: parsed.usage?.output_tokens ?? null,
      cache_read: parsed.usage?.cache_read_input_tokens ?? null,
      cache_write: parsed.usage?.cache_creation_input_tokens ?? null,
      cost_usd: parsed.costUsd ?? null,
      result_chars: budget.resultChars,
      soft_result_chars: outPolicy.softResultChars,
      over_budget: budget.overBudget,
      prompt_bytes: promptBytes,
      final_action_kind: finalActionKind,
      outcome: "ok",
    }, log);
  }

  return {
    outcome: "ok",
    exitCode: 0,
    durationMs,
    finalActionKind,
    resultText: parsed.result,
    costUsd: parsed.costUsd,
    tokens: parsed.usage
      ? {
          input: parsed.usage.input_tokens,
          output: parsed.usage.output_tokens,
          cacheCreation: parsed.usage.cache_creation_input_tokens,
          cacheRead: parsed.usage.cache_read_input_tokens,
        }
      : undefined,
  };
}

interface UsageSummaryRecord {
  ts: string;
  role: RoleKind;
  id: string | null;
  provider: ProviderKind;
  profile: string;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost_usd: number | null;
  result_chars: number;
  soft_result_chars: number;
  over_budget: boolean;
  prompt_bytes: number;
  final_action_kind: FinalActionKind;
  outcome: string;
}

export type FinalActionKind = "transition" | "action" | "coord_only" | "no_action" | "unknown";

export function classifyFinalActionKind(result: string | undefined): FinalActionKind {
  const last = (result ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (!last) return "unknown";
  if (/^transition\s*:/i.test(last)) return "transition";
  if (/^no action\s*:/i.test(last)) return "no_action";
  const action = last.match(/^action\s*:\s*(.*)$/i);
  if (action) {
    const body = action[1] ?? "";
    if (
      /^(coordination|coord)[ _-]?only\b/i.test(body) ||
      /^(status|manifest|history|backlog|retention)[ _-]?only\b/i.test(body) ||
      /\b(coordination|status|manifest|history|backlog|retention)[ _-]?only\b/i.test(body)
    ) {
      return "coord_only";
    }
    return "action";
  }
  return "unknown";
}

// Append one usage record to runtime/driver/usage/YYYY-MM.jsonl. Best-effort: a
// usage-log failure must never break a role iteration, so errors are logged and
// swallowed. The month partition is retention-friendly.
async function recordUsageSummary(
  projectRoot: string,
  pmId: string,
  record: UsageSummaryRecord,
  log: Logger,
): Promise<void> {
  try {
    const month = record.ts.slice(0, 7); // YYYY-MM
    const dir = join(projectRoot, "__garelier", pmId, "runtime", "driver", "usage");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${month}.jsonl`), JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    log.warn("usage_summary_write_failed", { error: (e as Error).message });
  }
}

function roleDefaultCwd(role: RoleKind, projectRoot: string, pmId: string): string {
  switch (role) {
    case "pm":        return `${projectRoot}/__garelier/${pmId}/_pm`;
    case "dock": return `${projectRoot}/__garelier/${pmId}/_dock`;
    case "artisan":   return `${projectRoot}/__garelier/${pmId}/_artisan`;
    case "worker":    return `${projectRoot}/__garelier/${pmId}/_workers`; // overridden via ctx.workerOrScoutCwd
    case "scout":     return `${projectRoot}/__garelier/${pmId}/_scouts`;
    case "smith":     return `${projectRoot}/__garelier/${pmId}/_smiths`;
    case "librarian": return `${projectRoot}/__garelier/${pmId}/_librarians`; // overridden via ctx.workerOrScoutCwd
    case "observer":  return `${projectRoot}/__garelier/${pmId}/_observers`; // overridden via ctx.workerOrScoutCwd
    case "guardian":  return `${projectRoot}/__garelier/${pmId}/_guardians`; // overridden via ctx.workerOrScoutCwd
    case "concierge": return `${projectRoot}/__garelier/${pmId}/_concierges`; // overridden via ctx.workerOrScoutCwd
  }
}
