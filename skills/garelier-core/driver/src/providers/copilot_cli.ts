// GitHub Copilot CLI adapter (DEC-026, Phase 4). v1 — finalized by provider smoke.
//
// Copilot has strong GitHub / MCP / external-tool integration — useful but
// dangerous. Garelier maps its permission profiles to a strict tool
// allow/deny list and keeps external write OUT of normal roles (only Concierge,
// after PM approval + Guardian gate, performs external operations). `--allow-all`
// / `--yolo` are never used here. EXPERIMENTAL flag stability: verified by the
// provider smoke; all flags isolated in this adapter.

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
  exileCoordAddDir,
} from "./types.ts";

function permissionArgs(profile: string): string[] {
  // safe = plan / read-only; reviewed = workspace edits + safe git reads, no
  // push/pull/reset/clean; dangerous = autopilot with minimal explicit allows
  // (still no --allow-all / --yolo). Built-in MCPs disabled outside dangerous.
  if (profile === "safe") {
    return [
      "--mode", "plan",
      "--available-tools", "read",
      "--deny-tool", "write",
      "--deny-tool", "shell",
      "--disable-builtin-mcps",
    ];
  }
  if (profile === "dangerous") {
    return ["--mode", "autopilot"];
  }
  // reviewed (default)
  return [
    "--mode", "autopilot",
    "--available-tools", "read,write,shell",
    "--allow-tool", "write",
    "--allow-tool", "shell(git status:*)",
    "--allow-tool", "shell(git diff:*)",
    "--allow-tool", "shell(git grep:*)",
    "--allow-tool", "shell(git show:*)",
    "--deny-tool", "shell(git push)",
    "--deny-tool", "shell(git pull)",
    "--deny-tool", "shell(git reset:*)",
    "--deny-tool", "shell(git clean:*)",
    "--disable-builtin-mcps",
  ];
}

export const copilotCliAdapter: ProviderAdapter = {
  kind: "copilot-cli",

  defaultCommand() {
    return ["copilot"];
  },

  async buildCommand(opts: ProviderBuildOptions): Promise<ProviderCommand> {
    const cmd = resolveSpawnCmd("copilot-cli", opts, ["copilot"]);
    // Transport: a short wrapper prompt (via stdin) points Copilot at the full
    // role prompt file, avoiding argv-length limits. The prompt file's dir must
    // be readable, so add tmpDir / projectRoot / skillRootDir.
    const wrapperFile = `${opts.promptFile}.wrapper`;
    await writeFile(wrapperFile, wrapperPromptText(opts.promptFile), "utf8");
    const profile = opts.permissionProfile ?? "reviewed";
    const args: string[] = [
      "--output-format", "json",
      "--no-ask-user",
      "--no-remote",
      "--add-dir", opts.tmpDir,
      "--add-dir", opts.projectRoot,
      "--add-dir", opts.skillRootDir,
      ...exileCoordAddDir(opts), // DEC-035: exile mailbox (outside projectRoot)
      ...permissionArgs(profile),
    ];
    if (opts.model && opts.model !== "copilot-cli" && opts.model !== "auto") {
      args.push("--model", opts.model);
    } else {
      args.push("--model", "auto");
    }
    return { cmd, args, stdinFile: wrapperFile };
  },

  async parseOutput(opts: ProviderParseOptions): Promise<ProviderOutput> {
    const { stdoutRaw } = opts;
    const raw = stdoutRaw.trim();
    if (!raw) return {};
    // Copilot output may be JSONL: read line by line, keep the last assistant/
    // final-answer-like message. Never crash — fall back to the raw tail.
    let result: string | undefined;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        const candidate =
          (typeof obj.result === "string" && obj.result) ||
          (typeof obj.response === "string" && obj.response) ||
          (typeof obj.content === "string" && obj.content) ||
          (typeof obj.message === "string" && obj.message) ||
          undefined;
        if (candidate) result = candidate;
      } catch {
        // ignore non-JSON lines
      }
    }
    return { result: result ?? raw };
  },

  looksRateLimited(text: string | undefined): boolean {
    return looksRateLimitedWith(BASE_RATE_LIMIT_PATTERNS, text);
  },
};
