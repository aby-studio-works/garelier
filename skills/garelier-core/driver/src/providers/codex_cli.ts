// Codex CLI adapter (`codex exec`). Behavior preserved verbatim from the
// pre-DEC-026 role.ts buildCodexCommand + Codex result-file parse.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getHeadlessDirective } from "../prompts.ts";
import type {
  ProviderAdapter,
  ProviderBuildOptions,
  ProviderCommand,
  ProviderParseOptions,
  ProviderOutput,
} from "./types.ts";
import { BASE_RATE_LIMIT_PATTERNS, looksRateLimitedWith, resolveSpawnCmd, exileCoordAddDir } from "./types.ts";

function escapeTomlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export const codexCliAdapter: ProviderAdapter = {
  kind: "codex-cli",

  defaultCommand() {
    return ["codex"];
  },

  async buildCommand(opts: ProviderBuildOptions): Promise<ProviderCommand> {
    const cmd = resolveSpawnCmd("codex-cli", opts, ["codex"]);
    const codexPromptFile = `${opts.promptFile}.codex`;
    const resultFile = join(opts.tmpDir, "codex-last-message.txt");
    const prompt = await readFile(opts.promptFile, "utf8");
    await writeFile(codexPromptFile, `${getHeadlessDirective()}\n\n${prompt}`, "utf8");
    // dangerous = danger-full-access (old default). reviewed = workspace-write
    // (writes confined to the project tree). safe = read-only (inspection only).
    const profile = opts.permissionProfile ?? "reviewed";
    const sandbox = profile === "dangerous"
      ? "danger-full-access"
      : profile === "reviewed"
      ? "workspace-write"
      : "read-only";
    const args: string[] = [
      "exec",
      "--cd", opts.cwd,
      "--add-dir", opts.projectRoot,
      "--add-dir", opts.skillRootDir,
      ...exileCoordAddDir(opts), // DEC-035: exile mailbox (outside projectRoot)
      "--sandbox", sandbox,
      "-c", "approval_policy=\"never\"",
      "--output-last-message", resultFile,
      "--json",
    ];
    if (opts.model && opts.model !== "codex-cli") args.push("--model", opts.model);
    if (opts.effort) args.push("-c", `model_reasoning_effort="${escapeTomlString(opts.effort)}"`);
    args.push("-");
    return { cmd, args, stdinFile: codexPromptFile, resultFile };
  },

  async parseOutput(opts: ProviderParseOptions): Promise<ProviderOutput> {
    const { stdoutRaw, resultFile } = opts;
    if (resultFile && existsSync(resultFile)) {
      try {
        const result = (await readFile(resultFile, "utf8")).trim();
        if (result) return { result };
      } catch {
        // fall through to stdout parsing
      }
    }
    return { result: stdoutRaw.trim() || undefined };
  },

  looksRateLimited(text: string | undefined): boolean {
    return looksRateLimitedWith(BASE_RATE_LIMIT_PATTERNS, text);
  },
};
