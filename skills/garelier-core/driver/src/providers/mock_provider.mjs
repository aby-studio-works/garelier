#!/usr/bin/env node
// Mock provider CLI for the provider smoke (DEC-026). NOT a real provider.
//
// Usage (via a providerCommand / GARELIER_PROVIDER_<KIND>_CMD override):
//   <runtime> mock_provider.mjs <kind> <...adapter args>
//
// Reads the prompt from stdin and emits a short result in <kind>'s output shape
// so the adapter's parseOutput can extract it — exercising the full
// build → spawn → parse round-trip without a real CLI. Honors a safe profile by
// never writing project files (it only writes the codex result file it is told
// to). Exit 0 on success.

import { readFileSync, writeFileSync } from "node:fs";

const kind = process.argv[2] ?? "claude-code";
const args = process.argv.slice(3);

let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {
  /* no stdin */
}
const echo = `MOCK[${kind}] ok: ${stdin.replace(/\s+/g, " ").trim().slice(0, 60)}`;

// Codex-style: write the final message to the file after --output-last-message.
const olmIdx = args.indexOf("--output-last-message");
if (olmIdx >= 0 && args[olmIdx + 1]) {
  try { writeFileSync(args[olmIdx + 1], echo, "utf8"); } catch { /* ignore */ }
}

function emit(s) { process.stdout.write(s); }

switch (kind) {
  case "claude-code":
    emit(JSON.stringify({ result: echo, total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } }));
    break;
  case "codex-cli":
    emit(echo); // also written to the result file above
    break;
  case "gemini-cli":
    emit(JSON.stringify({ response: echo, usage: { input_tokens: 1, output_tokens: 1 } }));
    break;
  case "copilot-cli":
    emit(JSON.stringify({ type: "log", message: "start" }) + "\n" + JSON.stringify({ result: echo }) + "\n");
    break;
  case "cursor-cli":
    emit(JSON.stringify({ result: echo }));
    break;
  default:
    emit(echo);
}
process.exit(0);
