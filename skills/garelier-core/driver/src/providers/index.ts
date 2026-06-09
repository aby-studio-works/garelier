// Provider Adapter Registry (DEC-026). role.ts resolves an adapter by kind and
// never branches on provider. New providers register here; do not add
// `if (provider === ...)` to role.ts.

import type { ProviderKind } from "../config.ts";
import type { ProviderAdapter } from "./types.ts";
import { claudeCodeAdapter } from "./claude_code.ts";
import { codexCliAdapter } from "./codex_cli.ts";
import { geminiCliAdapter } from "./gemini_cli.ts";
import { copilotCliAdapter } from "./copilot_cli.ts";
import { cursorCliAdapter } from "./cursor_cli.ts";

export * from "./types.ts";

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
  "claude-code": claudeCodeAdapter,
  "codex-cli": codexCliAdapter,
  "gemini-cli": geminiCliAdapter,
  "copilot-cli": copilotCliAdapter,
  "cursor-cli": cursorCliAdapter,
};

export function getProviderAdapter(kind: ProviderKind): ProviderAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`unsupported provider: ${kind}`);
  return adapter;
}

export function registeredProviderKinds(): ProviderKind[] {
  return Object.keys(ADAPTERS) as ProviderKind[];
}
