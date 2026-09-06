import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface FreshDiscovery {
  projectName: string;
  stack: "rust" | "typescript" | "python" | "go" | "mixed" | "custom";
  qualityGateCommands: string[];
  gateSource: "ci" | "project-doc" | "manifest" | "none";
}

const COMMAND_RE = /^(?:cargo|bun|npm|pnpm|yarn|deno|ruff|pytest|python\s+-m\s+pytest|go|make|just|dotnet|mvn|gradle)\b/i;
const INSTALL_RE = /\b(?:install|add|update|upgrade|download)\b/i;
const PLACEHOLDER_RE = /<[^>]+>|\{\{[^}]+\}\}/;
const POWERSHELL_EXPRESSION_RE = /\b(?:iex|invoke-expression|powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/i;

function read(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function unique(commands: string[]): string[] {
  return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function stripInlineComment(raw: string): string {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote !== null) {
      if (char === quote && !isEscaped(raw, i)) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

function isSafeSingleCommand(command: string): boolean {
  if (/[\r\n\0]/.test(command) || command.includes("$(") || command.includes("`")) return false;
  if (POWERSHELL_EXPRESSION_RE.test(command)) return false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote !== null) {
      if (char === quote && !isEscaped(command, i)) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (";&|<>".includes(char)) return false;
    if (char === "." && (i === 0 || /\s/.test(command[i - 1])) && /\s/.test(command[i + 1] ?? "")) return false;
  }
  return quote === null;
}

export function acceptedCommand(raw: string): string | null {
  if (/[\r\n\0]/.test(raw)) return null;
  const command = stripInlineComment(raw)
    .trim()
    .replace(/^[-*]\s+/, "")
    .trim();
  if (!isSafeSingleCommand(command) || !COMMAND_RE.test(command) || INSTALL_RE.test(command) || PLACEHOLDER_RE.test(command)) return null;
  return command;
}

function projectDocCommands(root: string): string[] {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const lines = read(join(root, name)).split(/\r?\n/);
    let inQualitySection = false;
    let qualityHeadingLevel = 0;
    let fence: string[] | null = null;
    for (const line of lines) {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading && fence === null) {
        const level = heading[1].length;
        if (inQualitySection && level <= qualityHeadingLevel) break;
        if (/quality\s*gate|quality checks?|品質ゲート|品質確認/i.test(heading[2])) {
          inQualitySection = true;
          qualityHeadingLevel = level;
        }
        continue;
      }
      if (!inQualitySection) continue;
      if (/^\s*```/.test(line)) {
        if (fence === null) {
          fence = [];
        } else {
          const commands = unique(fence.map(acceptedCommand).filter((command): command is string => command !== null));
          // The first command fence is the primary documented gate. Never
          // accumulate later conditional runtime/benchmark fences into it.
          return commands;
        }
        continue;
      }
      if (fence !== null) fence.push(line);
    }
  }
  return [];
}

function ciCommands(root: string): string[] {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const commands: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    for (const line of read(join(dir, entry.name)).split(/\r?\n/)) {
      const match = line.match(/^\s*(?:-\s+)?run:\s*(?![|>])(.+?)\s*$/);
      if (!match) continue;
      const command = acceptedCommand(match[1].replace(/^["']|["']$/g, ""));
      if (command) commands.push(command);
    }
  }
  return unique(commands);
}

function packageJson(root: string): { name: string; commands: string[] } {
  const body = read(join(root, "package.json"));
  if (!body) return { name: "", commands: [] };
  try {
    const value = JSON.parse(body) as { name?: unknown; scripts?: unknown; packageManager?: unknown };
    const scripts = value.scripts && typeof value.scripts === "object"
      ? value.scripts as Record<string, unknown>
      : {};
    const packageManager = typeof value.packageManager === "string"
      ? value.packageManager.split("@")[0]
      : existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))
        ? "bun"
        : existsSync(join(root, "pnpm-lock.yaml"))
          ? "pnpm"
          : existsSync(join(root, "yarn.lock"))
            ? "yarn"
            : "npm";
    const commands = ["typecheck", "test", "lint"]
      .filter((script) => typeof scripts[script] === "string" && String(scripts[script]).trim() !== "")
      .map((script) => `${packageManager} run ${script}`);
    return {
      name: typeof value.name === "string" ? value.name : "",
      commands,
    };
  } catch {
    return { name: "", commands: [] };
  }
}

function tomlName(body: string): string {
  const header = body.match(/^\s*\[(?:package|project)\]\s*$/m);
  if (!header || header.index === undefined) return "";
  const afterHeader = body.slice(header.index + header[0].length);
  const nextSection = afterHeader.search(/^\s*\[/m);
  const project = nextSection >= 0 ? afterHeader.slice(0, nextSection) : afterHeader;
  return project.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] ?? "";
}

function manifestCommands(root: string, stacks: string[], pkg: { commands: string[] }): string[] {
  const commands: string[] = [];
  if (stacks.includes("rust")) commands.push("cargo check --workspace", "cargo test --workspace", "cargo clippy --workspace --all-targets -- -D warnings");
  if (stacks.includes("typescript")) commands.push(...pkg.commands);
  if (stacks.includes("go")) commands.push("go build ./...", "go vet ./...", "go test ./...");
  if (stacks.includes("python")) {
    const pyproject = read(join(root, "pyproject.toml"));
    if (/\bpytest\b/i.test(pyproject) || existsSync(join(root, "pytest.ini"))) commands.push("python -m pytest");
    if (/\bruff\b/i.test(pyproject) || existsSync(join(root, "ruff.toml"))) commands.unshift("ruff check .");
  }
  return unique(commands);
}

export function discoverFreshInputs(root: string): FreshDiscovery {
  const stacks: Array<"rust" | "typescript" | "python" | "go"> = [];
  const cargo = read(join(root, "Cargo.toml"));
  const pyproject = read(join(root, "pyproject.toml"));
  const goMod = read(join(root, "go.mod"));
  const pkg = packageJson(root);
  if (cargo) stacks.push("rust");
  if (existsSync(join(root, "package.json"))) stacks.push("typescript");
  if (pyproject || existsSync(join(root, "setup.py"))) stacks.push("python");
  if (goMod) stacks.push("go");

  const ci = ciCommands(root);
  const docs = projectDocCommands(root);
  const manifests = manifestCommands(root, stacks, pkg);
  const qualityGateCommands = docs.length > 0 ? docs : ci.length > 0 ? ci : manifests;
  const gateSource = docs.length > 0 ? "project-doc" : ci.length > 0 ? "ci" : manifests.length > 0 ? "manifest" : "none";
  const stack = stacks.length === 1 ? stacks[0] : stacks.length > 1 ? "mixed" : "custom";
  const projectName =
    pkg.name
    || tomlName(cargo)
    || tomlName(pyproject)
    || goMod.match(/^\s*module\s+(\S+)/m)?.[1]?.split("/").pop()
    || basename(root);

  return { projectName, stack, qualityGateCommands, gateSource };
}
