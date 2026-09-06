// W-083 ts-first: setup_wizard agent-entry parsing + quality-gate defaults.
//
// Faithful port of normalize_agent_entry / parse_entries / entry_{id,provider,
// model} / check_agent_specs / qg_defaults_for_stack from setup_wizard.ts.
// Errors are raised as EntryError so the CLI entry point can render the exact
// stderr text and exit code (1) the bash produced.

export class EntryError extends Error {}

// Canonicalize a provider token or throw for an unsupported one.
function canonicalProvider(provider: string, raw: string): string {
  switch (provider) {
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

// normalize_agent_entry: provider-neutral "id" or explicit
// "id:provider:model" -> the internal three-field form. Two-field shorthand is
// forbidden because it would require guessing whether the suffix is a model or
// provider.
export function normalizeAgentEntry(raw: string): string {
  const firstColon = raw.indexOf(":");
  if (firstColon === -1) {
    if (raw === "") {
      throw new EntryError("Error: agent entry id must be non-empty.");
    }
    return `${raw}::`;
  }
  const id = raw.slice(0, firstColon);
  const rest = raw.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  if (id === "" || secondColon === -1) {
    throw new EntryError(
      `Error: agent entry must be id or id:provider:model; two-field shorthand is not allowed (got: ${raw}).`,
    );
  }
  let provider = rest.slice(0, secondColon);
  const model = rest.slice(secondColon + 1);
  if (provider !== "") provider = canonicalProvider(provider, raw);
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

// check_agent_specs: validate every explicit entry at the CLI boundary.
export function checkAgentSpecs(label: string, specs: string): void {
  if (specs === "") return;
  for (const e of specs.split(",")) {
    try {
      normalizeAgentEntry(e);
    } catch (error) {
      if (error instanceof EntryError) {
        throw new EntryError(`Error: invalid ${label} entry '${e}'.\n       ${error.message}`);
      }
      throw error;
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
