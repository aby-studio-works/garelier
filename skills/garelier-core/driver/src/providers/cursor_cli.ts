// Cursor CLI adapter (DEC-026 / DEC-033). Permission profiles are wired to
// cursor-agent's auto-run flag. Cursor's standalone CLI is the newest of the
// pool, so its flag set is the most version-sensitive — the provider smoke
// verifies it, and GARELIER_PROVIDER_CURSOR_CLI_PERMISSION=off falls back to no
// permission flag if a version rejects it (still bounded by worktree + gates).
//
// Cursor is a multi-model headless agent (it may route to Claude / OpenAI /
// Gemini internally). Garelier treats `cursor-cli` as one provider; roles using
// it should record the actual provider/model in their report. Default command is
// `cursor-agent` (override via GARELIER_PROVIDER_CURSOR_CLI_CMD / provider_command).

import { writeFile } from "node:fs/promises";
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
  wrapperPromptText,
  providerPermissionFlagsEnabled,
} from "./types.ts";

export const cursorCliAdapter: ProviderAdapter = {
  kind: "cursor-cli",

  defaultCommand() {
    return ["cursor-agent"];
  },

  async buildCommand(opts: ProviderBuildOptions): Promise<ProviderCommand> {
    const cmd = resolveSpawnCmd("cursor-cli", opts, ["cursor-agent"]);
    // Transport: short wrapper prompt via stdin → full role prompt file.
    const wrapperFile = `${opts.promptFile}.wrapper`;
    await writeFile(wrapperFile, wrapperPromptText(opts.promptFile), "utf8");
    const args: string[] = [];
    if (opts.model && opts.model !== "cursor-cli" && opts.model !== "auto") {
      args.push("--model", opts.model);
    }
    // Permission profile → cursor-agent auto-run (DEC-033): safe = no auto-run
    // (read/plan; writes not taken headless); reviewed/dangerous = --force
    // (auto-approve actions). Version-sensitive; smoke verifies, *_PERMISSION=off
    // disables. cursor-agent lacks a finer edit-only tier, so reviewed == force.
    if (providerPermissionFlagsEnabled("cursor-cli")) {
      const profile = opts.permissionProfile ?? "reviewed";
      if (profile === "reviewed" || profile === "dangerous") {
        args.push("--force");
      }
    }
    return { cmd, args, stdinFile: wrapperFile };
  },

  async parseOutput(opts: ProviderParseOptions): Promise<ProviderOutput> {
    const { stdoutRaw } = opts;
    const raw = stdoutRaw.trim();
    if (!raw) return {};
    // Try JSON; fall back to raw text. Never crash.
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const result =
        (typeof obj.result === "string" && obj.result) ||
        (typeof obj.response === "string" && obj.response) ||
        (typeof obj.text === "string" && obj.text) ||
        raw;
      return { result };
    } catch {
      return { result: raw };
    }
  },

  looksRateLimited(text: string | undefined): boolean {
    return looksRateLimitedWith(BASE_RATE_LIMIT_PATTERNS, text);
  },
};
