// W-083 ts-first: setup_wizard agent-entry parsing + quality-gate defaults.
//
// Faithful port of normalize_agent_entry / parse_entries / entry_{id,provider,
// model} / check_agent_specs / qg_defaults_for_stack from setup_wizard.ts.
// Errors are raised as EntryError so the CLI entry point can render the exact
// stderr text and exit code (1) the bash produced.

export class EntryError extends Error {}

// Provider aliases that are NOT models; a two-field `id:<alias>` is the
// ambiguous mistake both check_agent_specs and normalize_agent_entry reject.
const PROVIDER_ALIASES_AS_MODEL = new Set([
  "codex", "codex-cli",
  "gemini", "gemini-cli", "google-gemini",
  "copilot", "github-copilot", "copilot-cli",
  "cursor", "cursor-cli", "cursor-agent",
]);

// Canonicalize a provider token or throw for an unsupported one.
function canonicalProvider(provider: string, raw: string): string {
  switch (provider) {
    case "claude":
    case "claude-code":
      return "claude-code";
    case "codex":
    case "codex-cli":
      return "codex-cli";
    case "gemini":
    case "gemini-cli":
    case "google-gemini":
      return "gemini-cli";
    case "copilot":
    case "github-copilot":
    case "copilot-cli":
      return "copilot-cli";
    case "cursor":
    case "cursor-cli":
    case "cursor-agent":
      return "cursor-cli";
    default:
      throw new EntryError(
        `Error: unsupported provider '${provider}' in agent entry '${raw}'.\n` +
        `       Expected claude-code, codex-cli, gemini-cli, copilot-cli, or cursor-cli.`,
      );
  }
}

// normalize_agent_entry: "id:model" | "id:provider:model" -> "id:provider:model".
export function normalizeAgentEntry(raw: string): string {
  const firstColon = raw.indexOf(":");
  const id = firstColon === -1 ? raw : raw.slice(0, firstColon);
  const rest = firstColon === -1 ? raw : raw.slice(firstColon + 1);
  if (rest === raw || id === "" || rest === "") {
    throw new EntryError(
      `Error: agent entry must be id:model or id:provider:model (got: ${raw}).`,
    );
  }
  let provider: string;
  let model: string;
  if (rest.includes(":")) {
    const c = rest.indexOf(":");
    provider = rest.slice(0, c);
    model = rest.slice(c + 1);
  } else {
    if (PROVIDER_ALIASES_AS_MODEL.has(rest)) {
      throw new EntryError(
        `Error: ambiguous agent entry '${raw}'. '${rest}' is a provider, not a model;\n` +
        `       id:${rest} would silently run under provider=claude-code.\n` +
        `       Use id:provider:model, e.g. ${id}:gemini-cli:gemini-default`,
      );
    }
    provider = "claude-code";
    model = rest;
  }
  provider = canonicalProvider(provider, raw);
  return `${id}:${provider}:${model}`;
}

// parse_entries: comma-separated list -> normalized "id:provider:model" tokens.
export function parseEntries(input: string): string[] {
  const out: string[] = [];
  for (const e of input.split(",")) {
    if (e === "") continue;
    out.push(normalizeAgentEntry(e));
  }
  return out;
}

export function entryId(entry: string): string {
  const i = entry.indexOf(":");
  return i === -1 ? entry : entry.slice(0, i);
}

export function entryProvider(entry: string): string {
  const rest = entry.slice(entry.indexOf(":") + 1);
  const i = rest.indexOf(":");
  return i === -1 ? rest : rest.slice(0, i);
}

export function entryModel(entry: string): string {
  const rest = entry.slice(entry.indexOf(":") + 1);
  const i = rest.indexOf(":");
  return i === -1 ? rest : rest.slice(i + 1);
}

// check_agent_specs: reject the two-field `id:<provider-alias>` mistake at the
// top level, where a bash `exit` inside a subshell would not abort the wizard.
export function checkAgentSpecs(label: string, specs: string): void {
  if (specs === "") return;
  for (const e of specs.split(",")) {
    const lastColon = e.lastIndexOf(":");
    const suffix = lastColon === -1 ? "" : e.slice(lastColon + 1);
    if (lastColon !== -1 && PROVIDER_ALIASES_AS_MODEL.has(suffix)) {
      throw new EntryError(
        `Error: ambiguous ${label} entry '${e}'. '${suffix}' is a provider, not a model;\n` +
        `       '${e}' would silently run under provider=claude-code.\n` +
        `       Use id:provider:model, e.g. ${e.slice(0, e.indexOf(":"))}:gemini-cli:gemini-default`,
      );
    }
  }
}

// qg_defaults_for_stack: mirrors STACK_QUALITY_GATES; mixed/custom emit nothing.
export function qgDefaultsForStack(stack: string): string[] {
  switch (stack) {
    case "rust":
      return [
        "cargo check --workspace",
        "cargo test --workspace",
        "cargo clippy --workspace -- -D warnings",
      ];
    case "typescript":
      return ["npm run typecheck", "npm test", "npm run lint"];
    case "python":
      return ["ruff check .", "pytest"];
    case "go":
      return ["go build ./...", "go vet ./...", "go test ./..."];
    default:
      return [];
  }
}
