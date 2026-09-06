import { sha256 } from "./serialization.ts";

const PROJECT_GATE_TIMEOUT_SECONDS = 7_200;

const KNOWN_ARGV_COMMANDS = new Map<string, readonly string[]>([
  ["cargo check --workspace", ["cargo", "check", "--workspace"]],
  ["cargo test --workspace", ["cargo", "test", "--workspace"]],
  ["cargo clippy --workspace -- -D warnings", ["cargo", "clippy", "--workspace", "--", "-D", "warnings"]],
  ["npm run typecheck", ["npm", "run", "typecheck"]],
  ["npm test", ["npm", "test"]],
  ["npm run lint", ["npm", "run", "lint"]],
  ["ruff check .", ["ruff", "check", "."]],
  ["pytest", ["pytest"]],
  ["go build ./...", ["go", "build", "./..."]],
  ["go vet ./...", ["go", "vet", "./..."]],
  ["go test ./...", ["go", "test", "./..."]],
]);

export interface ProjectQualityGate {
  id: string;
  scope: string[];
  runner: "argv" | "shell";
  argv: string[];
  cwd: string;
  timeout_seconds: number;
  required: boolean;
  summarize: boolean;
}

export interface ProjectQualityGatePlan {
  gates: ProjectQualityGate[];
  shellGateIds: string[];
}

/** Convert setup quality-gate strings without guessing shell tokenization. */
export function planProjectQualityGates(commands: readonly string[], stack = "custom"): ProjectQualityGatePlan {
  const seenCommands = new Set<string>();
  const seenIds = new Map<string, string>();
  const gates: ProjectQualityGate[] = [];
  const shellGateIds: string[] = [];
  for (const raw of commands) {
    const command = raw.trim();
    if (command === "" || seenCommands.has(command)) continue;
    seenCommands.add(command);
    const id = `QG-project-${sha256(command).slice("sha256:".length, "sha256:".length + 16)}`;
    const collision = seenIds.get(id);
    if (collision !== undefined && collision !== command) throw new Error(`quality gate ID collision: ${id}`);
    seenIds.set(id, command);
    const knownArgv = KNOWN_ARGV_COMMANDS.get(command);
    const runner = knownArgv ? "argv" as const : "shell" as const;
    if (runner === "shell") shellGateIds.push(id);
    gates.push({
      id,
      scope: ["source", stack === "" ? "project" : stack],
      runner,
      argv: knownArgv ? [...knownArgv] : [command],
      cwd: "${target_root}",
      timeout_seconds: PROJECT_GATE_TIMEOUT_SECONDS,
      required: true,
      summarize: true,
    });
  }
  return { gates, shellGateIds };
}
