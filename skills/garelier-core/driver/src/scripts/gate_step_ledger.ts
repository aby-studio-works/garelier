import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { appendGuardedFileSync, assertSafeLeaf } from "../guard/path_guard.ts";
import { countScenarioCasesInSource, countTestDefinitionsInSource } from "./ci_test_inventory.ts";
import { minimalEnv } from "./spawn_env.ts";
import { requireRuntimeExecutable, resolveBashExecutable, resolveCommand } from "./_lib.ts";

export interface ToolchainVersions {
  bun: string;
  rustc: string;
  cargo: string;
}

export interface StepMetrics {
  test_count: number;
  scenario_count: number;
  wall_clock_s: number;
}

export interface StepConfigurationFile {
  path: string;
  sha256: string;
}

export interface StepExecutableIdentity {
  path: string;
  sha256: string;
}

export interface StepTestTargetEvidence {
  path: string;
  source_sha256: string;
  definition_count: number;
  scenario_count: number;
}

export interface BunTestArgvInterpretation {
  argv: string[];
  targets: string[];
  selectionFilterValues: string[];
}

export interface StepTestEvidence {
  schema_version: 2;
  runner: "gate-parent-direct";
  declared_argv_sha256: string;
  definition_count: number;
  targets: StepTestTargetEvidence[];
}

export interface StepIdentity {
  step_key: string;
  command_normalized: string;
  argv: string[];
  code_tree_hash: string;
  toolchain_versions: ToolchainVersions;
  review_sha: string;
  relevant_packages: string[];
  configuration_files: StepConfigurationFile[];
  environment_keys: string[];
  environment_sha256: string;
  executable: StepExecutableIdentity;
}

export interface StepLedgerEntry extends StepIdentity {
  schema_version: 4;
  step_name: string;
  command: string;
  cwd: string;
  exit: number;
  status: "GREEN" | "RED";
  run_id: string;
  step_index: number;
  log_sha256: string;
  result_identity: string;
  started_at: string;
  ended_at: string;
  metrics: StepMetrics;
  test_evidence?: StepTestEvidence;
}

export type StepLedgerEntryMaterial = Omit<StepLedgerEntry, "result_identity">;

export interface StepIdentityContext {
  configurationPaths?: readonly string[];
  environment?: Record<string, string | undefined>;
}

interface GitTreeEntry { object: string; path: string }

const TERMINAL_BACKLOG = new Set(["done", "cancelled", "superseded"]);
// Keep candidate-controlled timeouts inside the portable signed 32-bit timer
// range instead of accepting an argv that a runtime may clamp or reinterpret.
const MAX_BUN_TEST_TIMEOUT_MS = 2_147_483_647;

function assertBunTestTimeout(value: string | undefined): asserts value is string {
  const timeout = value !== undefined && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_BUN_TEST_TIMEOUT_MS) {
    throw new Error(`--timeout requires a positive integer from 1 to ${MAX_BUN_TEST_TIMEOUT_MS} milliseconds`);
  }
}

export function stepCommandArgv(command: string): string[] {
  const argv: string[] = [];
  let token = "", started = false, quote: "'" | '"' | "" = "", escaped = false;
  const push = (): void => { if (started) argv.push(token); token = ""; started = false; };
  for (const char of command.trim()) {
    if (escaped) { token += char; started = true; escaped = false; continue; }
    if (quote === "'") {
      if (char === "'") quote = "";
      else token += char;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      else if (char === "\\") escaped = true;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "\\") { escaped = true; started = true; continue; }
    if (/\s/.test(char)) { push(); continue; }
    if (/[#|&;<>`$(){}\r\n]/.test(char)) throw new Error("gate step command is not a closed literal argv");
    token += char;
    started = true;
  }
  if (quote || escaped) throw new Error("gate step command has an unterminated quote or escape");
  push();
  if (argv.length === 0) throw new Error("gate step command is empty");
  return argv;
}

export function stepArgvSha256(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

export function stepIdentityKey(identity: Pick<StepIdentity,
  "argv" | "code_tree_hash" | "toolchain_versions" | "configuration_files"
  | "environment_keys" | "environment_sha256" | "executable"
>): string {
  return createHash("sha256").update(JSON.stringify({
    argv: identity.argv,
    code_tree_hash: identity.code_tree_hash,
    toolchain_versions: identity.toolchain_versions,
    configuration_files: identity.configuration_files,
    environment_keys: identity.environment_keys,
    environment_sha256: identity.environment_sha256,
    executable: identity.executable,
  })).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(assertSafeLeaf(path, "gate identity file"))).digest("hex");
}

interface ExecutableDigestCacheEntry {
  identity: string;
  digest: string;
}
const EXECUTABLE_DIGEST_CACHE = new Map<string, ExecutableDigestCacheEntry>();

function statIdentity(stat: NonNullable<ReturnType<typeof statSync>>): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function sha256Executable(path: string): string {
  const lexical = resolve(path);
  const canonical = realpathSync(lexical);
  const samePath = process.platform === "win32"
    ? lexical.toLowerCase() === canonical.toLowerCase()
    : lexical === canonical;
  const stat = lstatSync(canonical);
  if (!samePath || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`gate executable is not a canonical regular file: ${path}`);
  }
  const identity = statIdentity(stat);
  const cached = EXECUTABLE_DIGEST_CACHE.get(canonical);
  if (cached?.identity === identity) return cached.digest;
  const digest = createHash("sha256").update(readFileSync(canonical)).digest("hex");
  const after = statSync(canonical);
  if (!after || statIdentity(after) !== identity) throw new Error(`gate executable changed while hashing: ${path}`);
  EXECUTABLE_DIGEST_CACHE.set(canonical, { identity, digest });
  return digest;
}

function containedRelative(root: string, candidate: string, label: string): string {
  const rel = relative(resolve(root), resolve(candidate)).replace(/\\/g, "/");
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error(`${label} is outside the checkout`);
  return rel;
}

function configurationFiles(cwd: string, paths: readonly string[]): StepConfigurationFile[] {
  void cwd;
  return [...new Set(paths.map((path) => resolve(path)))].sort().map((path) => ({
    path: realpathSync(assertSafeLeaf(path, "gate configuration")),
    sha256: sha256File(path),
  }));
}

export function gateEnvironmentSha256(environment: Record<string, string | undefined>): string {
  const entries = Object.entries(environment)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function gateEnvironmentKeys(environment: Record<string, string | undefined>): string[] {
  return Object.entries(environment)
    .filter(([, value]) => typeof value === "string")
    .map(([key]) => process.platform === "win32" ? key.toUpperCase() : key)
    .sort((left, right) => left.localeCompare(right));
}

function executableIdentity(argv: readonly string[], environment: Record<string, string | undefined>): StepExecutableIdentity {
  const builtins = new Set([".", ":", "break", "cd", "continue", "eval", "exec", "exit", "export", "false", "if", "printf", "pwd", "read", "readonly", "return", "set", "shift", "source", "test", "true", "trap", "unset"]);
  const command = argv[0]!.toLowerCase().replace(/\.exe$/, "") === "bun"
    ? process.execPath
    : builtins.has(argv[0]!)
      ? resolveBashExecutable({ env: environment })
      : resolveCommand([...argv], { env: environment })?.[0];
  if (!command) throw new Error(`gate executable is not resolvable: ${argv[0]}`);
  const path = realpathSync(command);
  return { path, sha256: sha256Executable(path) };
}

function commandOutput(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: minimalEnv(),
    timeout: 30_000,
  });
  if (result.exitedDueToTimeout || (result.exitCode ?? 1) !== 0) return "unavailable";
  return (result.stdout?.toString() ?? "").trim().split(/\r?\n/)[0] || "unavailable";
}

export function readToolchainVersions(cwd: string): ToolchainVersions {
  return {
    bun: commandOutput([process.execPath, "--version"], cwd),
    rustc: commandOutput(["rustc", "--version"], cwd),
    cargo: commandOutput(["cargo", "--version"], cwd),
  };
}

function gitOutput(cwd: string, args: string[]): string {
  const result = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", cwd, ...args], {
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: minimalEnv(),
    timeout: 30_000,
  });
  if (result.exitedDueToTimeout) throw new Error(`git ${args.join(" ")} timed out`);
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr?.toString() ?? "").trim()}`);
  }
  return result.stdout?.toString() ?? "";
}

function trackedTree(cwd: string): { reviewSha: string; entries: GitTreeEntry[] } {
  const reviewSha = gitOutput(cwd, ["rev-parse", "HEAD"]).trim();
  const status = gitOutput(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status.trim()) throw new Error("gate step identity requires a clean checkout");
  const entries = gitOutput(cwd, ["ls-tree", "-r", "--full-tree", "HEAD"])
    .split(/\r?\n/)
    .flatMap((line): GitTreeEntry[] => {
      const match = /^\d+\s+\S+\s+([0-9a-f]{40,64})\t(.+)$/.exec(line);
      if (!match) return [];
      const path = match[2]!.replace(/\\/g, "/");
      if (path === "__garelier" || path.startsWith("__garelier/")
        || path === "showcase" || path.startsWith("showcase/")) return [];
      return [{ object: match[1]!, path }];
    });
  return { reviewSha, entries };
}

interface CargoMetadataPackage {
  id: string;
  name: string;
  manifest_path: string;
  source: string | null;
}
interface CargoMetadataNode { id: string; dependencies: string[] }
interface CargoMetadata {
  packages: CargoMetadataPackage[];
  workspace_members: string[];
  resolve?: { nodes: CargoMetadataNode[] } | null;
}

function cargoPackageNames(argv: readonly string[]): string[] | null {
  if (argv[0] !== "cargo") return null;
  if (argv.includes("--workspace") || argv.includes("--all")) return [];
  const names: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if ((arg === "-p" || arg === "--package") && argv[index + 1]) names.push(argv[++index]!);
    else if (arg.startsWith("--package=")) names.push(arg.slice("--package=".length));
  }
  return names;
}

/** Resolve the workspace package closure from Cargo itself for observational
 * identity disclosure. An empty returned set means a workspace-wide Cargo
 * command; null means a non-Cargo command. */
export function cargoRelevantPackages(command: string, cwd: string): Set<string> | null {
  const argv = stepCommandArgv(command);
  const selectedNames = cargoPackageNames(argv);
  if (selectedNames === null) return null;
  const metadataRaw = commandOutput(["cargo", "metadata", "--format-version", "1"], cwd);
  if (metadataRaw === "unavailable") return new Set();
  let metadata: CargoMetadata;
  try { metadata = JSON.parse(metadataRaw) as CargoMetadata; }
  catch { return new Set(); }
  const workspace = new Set(metadata.workspace_members ?? []);
  if (selectedNames.length === 0) return workspace;
  const selected = new Set(metadata.packages
    .filter((item) => selectedNames.includes(item.name))
    .map((item) => item.id));
  const nodes = new Map((metadata.resolve?.nodes ?? []).map((node) => [node.id, node.dependencies]));
  const pending = [...selected];
  while (pending.length > 0) {
    const id = pending.pop()!;
    for (const dependency of nodes.get(id) ?? []) {
      if (!workspace.has(dependency) || selected.has(dependency)) continue;
      selected.add(dependency);
      pending.push(dependency);
    }
  }
  return selected;
}

function relevantTreeEntries(
  cwd: string,
  command: string,
  entries: readonly GitTreeEntry[],
): { entries: GitTreeEntry[]; packages: string[] } {
  const relevant = cargoRelevantPackages(command, cwd);
  if (relevant === null || relevant.size === 0) return { entries: [...entries], packages: [] };
  const metadataRaw = commandOutput(["cargo", "metadata", "--format-version", "1"], cwd);
  let metadata: CargoMetadata;
  try { metadata = JSON.parse(metadataRaw) as CargoMetadata; }
  catch { return { entries: [...entries], packages: [] }; }
  // Cargo metadata is useful descriptive evidence, not a complete build-input
  // graph: include!(), build scripts, generated inputs, and tools may consume
  // any tracked path. The observational identity therefore describes the
  // complete eligible tracked tree (trackedTree excludes only control/showcase).
  return {
    entries: [...entries],
    packages: metadata.packages.filter((item) => relevant.has(item.id)).map((item) => item.name).sort(),
  };
}

export function createStepIdentity(
  command: string,
  cwd: string,
  versions: ToolchainVersions = readToolchainVersions(cwd),
  context: StepIdentityContext = {},
): StepIdentity {
  const argv = stepCommandArgv(command);
  const normalized = JSON.stringify(argv);
  const tree = trackedTree(cwd);
  const relevant = relevantTreeEntries(cwd, command, tree.entries);
  const environment = context.environment ?? minimalEnv();
  const configuration = configurationFiles(cwd, context.configurationPaths ?? []);
  const executable = executableIdentity(argv, environment);
  const codeTreeHash = createHash("sha256")
    .update(relevant.entries.map((entry) => `${entry.object}\t${entry.path}`).join("\n"))
    .digest("hex");
  const identityMaterial = {
    argv,
    code_tree_hash: codeTreeHash,
    toolchain_versions: versions,
    configuration_files: configuration,
    environment_keys: gateEnvironmentKeys(environment),
    environment_sha256: gateEnvironmentSha256(environment),
    executable,
  };
  const stepKey = stepIdentityKey(identityMaterial);
  return {
    step_key: stepKey,
    command_normalized: normalized,
    argv,
    code_tree_hash: codeTreeHash,
    toolchain_versions: versions,
    review_sha: tree.reviewSha,
    relevant_packages: relevant.packages,
    configuration_files: configuration,
    environment_keys: gateEnvironmentKeys(environment),
    environment_sha256: gateEnvironmentSha256(environment),
    executable,
  };
}

export function appendStepLedger(path: string, entry: StepLedgerEntry): void {
  if (!parseStepLedgerEntry(entry)) throw new Error("gate step ledger entry failed schema validation");
  mkdirSync(dirname(resolve(path)), { recursive: true });
  appendGuardedFileSync(resolve(path), `${JSON.stringify(entry)}\n`, "gate step ledger");
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function digest(value: unknown, length = 64): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function exactKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === allowed.length && keys.every((key, index) => key === [...allowed].sort()[index]);
}

function validConfiguration(value: unknown): value is StepConfigurationFile[] {
  return Array.isArray(value) && value.every((item) => {
    const record = item as Partial<StepConfigurationFile>;
    return exactKeys(item, ["path", "sha256"]) && typeof record.path === "string" && isAbsolute(record.path)
      && /[\\/]__garelier[\\/][^\\/]+[\\/]_crew[\\/]pm[\\/]setup_config\.toml$/i.test(record.path)
      && digest(record.sha256);
  });
}

function validTestEvidence(value: unknown): value is StepTestEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<StepTestEvidence>;
  return exactKeys(value, [
    "schema_version", "runner", "declared_argv_sha256", "definition_count", "targets",
  ]) && evidence.schema_version === 2 && evidence.runner === "gate-parent-direct"
    && digest(evidence.declared_argv_sha256) && integer(evidence.definition_count)
    && Array.isArray(evidence.targets) && evidence.targets.length > 0
    && evidence.targets.every((item) => exactKeys(item, [
      "path", "source_sha256", "definition_count", "scenario_count",
    ]) && typeof item.path === "string" && item.path.length > 0
      && !isAbsolute(item.path) && !item.path.split("/").some((part) => part === "" || part === "." || part === "..")
      && digest(item.source_sha256) && integer(item.definition_count) && integer(item.scenario_count));
}

export function parseStepLedgerEntry(value: unknown): StepLedgerEntry | null {
  if (!value || typeof value !== "object") return null;
  const allowed = new Set([
    "schema_version", "step_key", "command_normalized", "argv", "code_tree_hash", "toolchain_versions",
    "review_sha", "relevant_packages", "configuration_files", "environment_keys", "environment_sha256", "executable",
    "step_name", "command", "cwd", "exit", "status", "run_id", "step_index", "log_sha256",
    "result_identity", "started_at", "ended_at", "metrics", "test_evidence",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const entry = value as Partial<StepLedgerEntry>;
  if (entry.schema_version !== 4 || !digest(entry.step_key) || typeof entry.command_normalized !== "string"
    || !strings(entry.argv) || entry.argv.length === 0 || entry.command_normalized !== JSON.stringify(entry.argv)
    || !digest(entry.code_tree_hash) || !exactKeys(entry.toolchain_versions, ["bun", "rustc", "cargo"])
    || ![entry.toolchain_versions.bun, entry.toolchain_versions.rustc, entry.toolchain_versions.cargo].every((item) => typeof item === "string")
    || typeof entry.review_sha !== "string" || !/^[0-9a-f]{40,64}$/.test(entry.review_sha)
    || !strings(entry.relevant_packages) || !validConfiguration(entry.configuration_files)
    || !strings(entry.environment_keys) || entry.environment_keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    || !digest(entry.environment_sha256) || !exactKeys(entry.executable, ["path", "sha256"])
    || typeof entry.executable.path !== "string"
    || !isAbsolute(entry.executable.path) || !digest(entry.executable.sha256)
    || typeof entry.step_name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(entry.step_name)
    || typeof entry.command !== "string" || entry.command.length === 0 || typeof entry.cwd !== "string" || !isAbsolute(entry.cwd)
    || !integer(entry.exit) || (entry.status !== "GREEN" && entry.status !== "RED")
    || typeof entry.run_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(entry.run_id)
    || !integer(entry.step_index, 1) || !digest(entry.log_sha256) || !digest(entry.result_identity)
    || typeof entry.started_at !== "string" || !Number.isFinite(Date.parse(entry.started_at))
    || typeof entry.ended_at !== "string" || !Number.isFinite(Date.parse(entry.ended_at))
    || !exactKeys(entry.metrics, ["test_count", "scenario_count", "wall_clock_s"])
    || !integer(entry.metrics.test_count) || !integer(entry.metrics.scenario_count)
    || typeof entry.metrics.wall_clock_s !== "number" || !Number.isFinite(entry.metrics.wall_clock_s) || entry.metrics.wall_clock_s < 0
    || (entry.test_evidence !== undefined && !validTestEvidence(entry.test_evidence))) return null;
  if ((entry.status === "GREEN") !== (entry.exit === 0)) return null;
  try {
    if (JSON.stringify(stepCommandArgv(entry.command)) !== JSON.stringify(entry.argv)
      || entry.step_key !== stepIdentityKey(entry as StepIdentity)) return null;
  } catch { return null; }
  if (entry.test_evidence && (entry.metrics.test_count !== entry.test_evidence.definition_count
    || entry.metrics.scenario_count !== entry.test_evidence.targets.reduce((sum, item) => sum + item.scenario_count, 0))) return null;
  const parsed = entry as StepLedgerEntry;
  const { result_identity, ...material } = parsed;
  if (result_identity !== stepResultIdentity(material)) return null;
  return parsed;
}

export function completedStepLogPath(ledgerPath: string, runId: string, stepIndex: number): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId) || !integer(stepIndex, 1)) {
    throw new Error("gate evidence run/step identity is invalid");
  }
  const root = resolve(dirname(resolve(ledgerPath)), "runs");
  const candidate = resolve(root, runId, "steps", `${String(stepIndex).padStart(3, "0")}.log`);
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("gate evidence path escaped its run-owned root");
  }
  return candidate;
}

export function stepResultIdentity(entry: StepLedgerEntryMaterial): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

export function finalizeStepLedgerEntry(material: StepLedgerEntryMaterial): StepLedgerEntry {
  const result_identity = stepResultIdentity(material);
  return { ...material, result_identity };
}

export function assertAppendedStepEvidence(
  ledgerPath: string,
  entry: StepLedgerEntry,
  completedLog: Uint8Array,
): void {
  if (!parseStepLedgerEntry(entry)) throw new Error("parent-authored ledger entry failed identity validation");
  const ledger = readFileSync(assertSafeLeaf(resolve(ledgerPath), "gate step ledger post-append evidence"));
  const entryBytes = Buffer.from(`${JSON.stringify(entry)}\n`);
  if (ledger.length < entryBytes.length || !ledger.subarray(ledger.length - entryBytes.length).equals(entryBytes)) {
    throw new Error("parent-authored ledger bytes changed after append");
  }
  const log = readFileSync(assertSafeLeaf(
    completedStepLogPath(ledgerPath, entry.run_id, entry.step_index),
    "gate completed-step post-append evidence",
  ));
  if (!log.equals(Buffer.from(completedLog))) {
    throw new Error("parent-authored completed-step log bytes changed after write");
  }
}

/** Interpret only the Bun test argv forms that the parent can authenticate.
 * The returned argv is the original literal argv used for sealing; targets and
 * selection-filter values are classified without changing execution input. */
export function parseBunTestArgv(command: string): BunTestArgvInterpretation | null {
  const argv = stepCommandArgv(command);
  if (argv[0]?.toLowerCase().replace(/\.exe$/, "") !== "bun" || argv[1] !== "test") return null;
  const targets: string[] = [];
  const selectionFilterValues: string[] = [];
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-t" || arg === "--test-name-pattern") {
      const value = argv[index + 1];
      if (value === undefined || value === "") throw new Error(`${arg} requires a value`);
      if (value.startsWith("-")) throw new Error(`${arg} requires a non-option value`);
      selectionFilterValues.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--test-name-pattern=")) {
      const value = arg.slice("--test-name-pattern=".length);
      if (!value) throw new Error("--test-name-pattern requires a value");
      selectionFilterValues.push(value);
      continue;
    }
    if (arg === "--timeout") {
      const value = argv[index + 1];
      assertBunTestTimeout(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      assertBunTestTimeout(arg.slice("--timeout=".length));
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unsupported Bun test option: ${arg}`);
    if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg)) {
      throw new Error(`unsupported Bun test positional argument: ${arg}`);
    }
    targets.push(arg);
  }
  if (targets.length === 0) throw new Error("Bun test command requires at least one explicit tracked test target");
  return { argv, targets, selectionFilterValues };
}

export function bunTestTargetEvidence(
  invocation: BunTestArgvInterpretation,
  cwd: string,
): StepTestTargetEvidence[] {
  return [...new Set(invocation.targets)].map((raw) => {
    const absolute = resolve(cwd, raw);
    const path = containedRelative(cwd, absolute, "gate test target");
    gitOutput(cwd, ["ls-files", "--error-unmatch", "--", path]);
    const source = readFileSync(assertSafeLeaf(absolute, "gate test target"), "utf8");
    return {
      path,
      source_sha256: createHash("sha256").update(source).digest("hex"),
      definition_count: countTestDefinitionsInSource(source, path),
      scenario_count: countScenarioCasesInSource(source, path),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function collectStepMetrics(testEvidence: StepTestEvidence | undefined, wallClockSeconds: number): StepMetrics {
  return {
    test_count: testEvidence?.definition_count ?? 0,
    scenario_count: testEvidence?.targets.reduce((sum, target) => sum + target.scenario_count, 0) ?? 0,
    wall_clock_s: Math.round(Math.max(0, wallClockSeconds) * 1000) / 1000,
  };
}

export function trackingRowOpen(controlRoot: string, row: string): boolean {
  const normalized = row.replace(/^backlog:/, "");
  const candidates = [resolve(controlRoot, "backlog", "open")];
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    const result = Bun.spawnSync([
      requireRuntimeExecutable("git"), "-C", resolve(controlRoot, "..", "..", ".."),
      "ls-files", "--", relative(resolve(controlRoot, "..", "..", ".."), root).replace(/\\/g, "/"),
    ], { windowsHide: true, stdout: "pipe", stderr: "ignore", env: minimalEnv(), timeout: 30_000 });
    const files = (result.stdout?.toString() ?? "").split(/\r?\n/)
      .map((path) => resolve(controlRoot, "..", "..", "..", path)).filter((path) => existsSync(path));
    const file = files.find((path) => readFileSync(path, "utf8").includes(`id = "${normalized}"`));
    if (!file) continue;
    const status = /^status\s*=\s*"([^"]+)"/m.exec(readFileSync(file, "utf8"))?.[1] ?? "";
    return status !== "" && !TERMINAL_BACKLOG.has(status);
  }
  return false;
}
