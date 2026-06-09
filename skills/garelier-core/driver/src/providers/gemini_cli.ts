// Gemini CLI adapter (DEC-026 / DEC-033). First-class: permission profiles are wired
// to Gemini's approval-mode + sandbox flags.
//
// Flag stability: Gemini CLI option names vary by installed version. ALL provider-
// specific flags live in this adapter; the provider smoke (provider_smoke.ts)
// verifies them, and fixes belong here only. If your installed version rejects a
// permission flag, set GARELIER_PROVIDER_GEMINI_CLI_PERMISSION=off to fall back to
// no permission flags (still bounded by Garelier's worktree + gates).

import type {
  ProviderAdapter,
  ProviderBuildOptions,
  ProviderCommand,
  ProviderParseOptions,
  ProviderOutput,
} from "./types.ts";
import {
  BASE_RATE_LIMIT_PATTERNS,
  looksRateLimitedWith,
  resolveSpawnCmd,
  providerPermissionFlagsEnabled,
} from "./types.ts";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export const geminiCliAdapter: ProviderAdapter = {
  kind: "gemini-cli",

  defaultCommand() {
    return ["gemini"];
  },

  async buildCommand(opts: ProviderBuildOptions): Promise<ProviderCommand> {
    const cmd = resolveSpawnCmd("gemini-cli", opts, ["gemini"]);
    // Transport: full role prompt via stdin (role.ts pipes the prompt file);
    // JSON output for structured result + usage.
    const args: string[] = ["--output-format", "json"];
    if (opts.model && opts.model !== "gemini-cli" && opts.model !== "gemini-default") {
      args.unshift("--model", opts.model);
    }
    // Permission profile → Gemini approval-mode + sandbox (DEC-033):
    //   safe      = read/plan; no auto-approve so headless writes are not taken.
    //   reviewed  = auto-approve workspace edits, sandboxed.
    //   dangerous = full auto (yolo) in a deliberately isolated environment.
    // Version-sensitive; the smoke verifies, and the *_PERMISSION=off env disables.
    if (providerPermissionFlagsEnabled("gemini-cli")) {
      const profile = opts.permissionProfile ?? "reviewed";
      if (profile === "dangerous") {
        args.push("--yolo");
      } else if (profile === "reviewed") {
        args.push("--approval-mode", "auto_edit", "--sandbox");
      } else {
        args.push("--approval-mode", "default");
      }
    }
    return { cmd, args };
  },

  async parseOutput(opts: ProviderParseOptions): Promise<ProviderOutput> {
    const { stdoutRaw } = opts;
    const raw = stdoutRaw.trim();
    if (!raw) return {};
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const result = str(obj.response) ?? str(obj.result) ?? str(obj.text) ?? raw;
      const usage = (obj.usage ?? (obj.stats as Record<string, unknown> | undefined)?.usage ?? {}) as Record<string, unknown>;
      return {
        result,
        usage: {
          input_tokens: num(usage.input_tokens) ?? num(usage.prompt_tokens),
          output_tokens: num(usage.output_tokens) ?? num(usage.candidates_tokens),
        },
      };
    } catch {
      // Defensive: never crash on an unexpected shape.
      return { result: raw };
    }
  },

  looksRateLimited(text: string | undefined): boolean {
    return looksRateLimitedWith(BASE_RATE_LIMIT_PATTERNS, text);
  },
};
