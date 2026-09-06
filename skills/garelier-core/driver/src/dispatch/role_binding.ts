// Versioned role prompt binding authority (W-387).
//
// One issuer/validator owns every Garelier role admission decision. Copies
// in ready/context/assignment/report are advisory; the canonical records live
// below runtime/dispatch/bindings and are re-read at close/request/gate time.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { canonicalJson } from "../control/serialization.ts";
import type { RoleKind } from "../role_contracts.ts";
import { renameSync, rmSync } from "../guard/path_guard.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";
import {
  extractStrictGuardianVerdict,
  extractStrictReviewSha,
  extractStrictVerdict,
} from "../merge_gate_parse.ts";
import { resolveRoleKnowledgeBinding, type RoleKnowledgeBinding } from "./knowledge_binding.ts";
import {
  machineArray,
  optionalMachineString,
  parseMachineArtifact,
  renderMachineArtifact,
  renderMachineSection,
  type MachineSection,
} from "./machine_artifact.ts";

export const ROLE_BINDING_SCHEMA_VERSION = 1 as const;
export const ROLE_RECORD_KIND = {
  bindingCore: "garelier_producer_binding_core",
  authorization: "garelier_producer_authorization",
  launch: "garelier_producer_launch",
  instruction: "garelier_producer_instruction",
  instructionDelivery: "garelier_producer_instruction_delivery",
  close: "garelier_producer_close",
  closeClaim: "garelier_producer_close_claim",
  closeGateOutcome: "garelier_producer_close_gate_outcome",
  admissionTransition: "garelier_producer_admission_transition",
  current: "garelier_producer_current",
} as const;
const ROLE_BINDING_CONTEXT_STORAGE_KEY = "producer_binding" as const;
const ROLE_RECOVERY_CARABINER_STORAGE_VALUE = "producer_recovery" as const;
export const ROLE_RECOVERY_ARCHIVE_RECORD_KIND = "garelier_producer_recovery_archive" as const;
export type { RoleKind } from "../role_contracts.ts";
export type RoleCarabiner = "implementation" | "integration_hardening" | "knowledge_maintenance" | "end_to_end_creation" | "read_only_delivery" | "external_operation" | "role_recovery";
export type ProviderTransport = "codex-cli" | "claude-subprocess" | "attended-agent" | "recorded-cli" | "lane-dispatch";
export type RoleExecutionIdentity =
  | { kind: "dispatch"; id: string }
  | { kind: "role-seat"; id: string; role: RoleKind }
  | { kind: "branch"; id: string; role: RoleKind; branch_hash: string };

export interface RoleSourceBinding {
  path: string;
  content_hash: string;
  hash_mode?: "plan_graph_item_authority_v1";
  semantic_hash?: string;
}
export interface RoleMutableSourceBinding { path: string }
export interface RoleLensBindingInput {
  ref: string | null;
  source: "explicit" | "defaults" | "none";
  registry_path: string | null;
  pack_path: string | null;
}
export interface RoleLensBinding {
  ref: string | null;
  source: "explicit" | "defaults" | "none";
  registry: RoleSourceBinding | null;
  pack: RoleSourceBinding | null;
}
export interface RoleRoutingBinding { provider: string; model: string; effort: string; source: string }
export interface RoleRecoveryInput {
  reason: "warm_reuse" | "stall_handoff" | "provider_replacement" | "base_track" | "bindingless_migration";
  supersedes_digest: string | null;
  wip: Array<{ path: string; content_hash: string }>;
  dependencies_reaudited: boolean;
  acceptance_reaudited: string[];
}
export interface RoleRecoveryBinding extends Omit<RoleRecoveryInput, "wip"> {
  wip: RoleSourceBinding[];
}
export interface RoleBindingActor { role: string; id: string }

export interface RoleBindingCore {
  schema_version: 1;
  kind: typeof ROLE_RECORD_KIND.bindingCore;
  namespace: { project_hash: string; pm_id: string };
  execution_identity: RoleExecutionIdentity;
  generation: number;
  item: { work_id: string; revision: string; session_id: string; authority: RoleSourceBinding };
  sources: {
    assignment: RoleSourceBinding;
    blueprint: RoleSourceBinding | null;
    package_id: string | null;
    prompt: RoleSourceBinding;
  };
  role: RoleKind;
  carabiner: RoleCarabiner;
  routing: RoleRoutingBinding;
  lens: RoleLensBinding;
  knowledge: RoleKnowledgeBinding;
  integration: { ref: string; base_sha: string };
  initial_instructions: RoleSourceBinding | null;
  instruction_ledger: RoleMutableSourceBinding | null;
  supersedes_digest: string | null;
  recovery: RoleRecoveryBinding | null;
}

export interface RoleAuthorization {
  schema_version: 1;
  kind: typeof ROLE_RECORD_KIND.authorization;
  binding_id: string;
  core_digest: string;
  core: RoleBindingCore;
  issuer: RoleBindingActor;
  issued_at: string;
}
type StoredRoleBindingCore = Omit<RoleBindingCore, "carabiner"> & {
  carabiner: Exclude<RoleCarabiner, "role_recovery"> | typeof ROLE_RECOVERY_CARABINER_STORAGE_VALUE;
};
type StoredRoleAuthorization = Omit<RoleAuthorization, "core"> & { core: StoredRoleBindingCore };
export interface RoleLaunchAcknowledgement {
  schema_version: 1;
  kind: typeof ROLE_RECORD_KIND.launch;
  binding_id: string;
  binding_digest: string;
  generation: number;
  transport: ProviderTransport;
  provider_session_id: string;
  prompt_hash: string;
  success_evidence: string;
  writer: RoleBindingActor;
  launched_at: string;
}
export class RoleLaunchReplayError extends Error {
  constructor() {
    super("role launch acknowledgement already exists; launch replay refused");
    this.name = "RoleLaunchReplayError";
  }
}
class RoleBindingCreateExclusiveConflictError extends Error {
  constructor(readonly path: string) {
    super(`role binding create-exclusive conflict: ${path}`);
    this.name = "RoleBindingCreateExclusiveConflictError";
  }
}
export interface RoleInstruction {
  schema_version: 1;
  kind: typeof ROLE_RECORD_KIND.instruction;
  binding_digest: string;
  generation: number;
  sequence: number;
  ledger_token: string;
  message_digest: string;
  message: string;
  source_updates?: { blueprint: RoleBlueprintUpdate };
  issuer: RoleBindingActor;
  issued_at: string;
}
export interface RoleBlueprintUpdate {
  path: string;
  commit_sha: string;
  content_hash: string;
  commit_content_hash: string;
}
export interface RoleInstructionDelivery {
  schema_version: 1;
  kind: typeof ROLE_RECORD_KIND.instructionDelivery;
  binding_digest: string;
  generation: number;
  sequence: number;
  provider_session_id: string;
  previous_provider_session_id?: string;
  evidence: string;
  writer: RoleBindingActor;
  delivered_at: string;
}
export interface RoleCloseReceipt {
  schema_version: 1;
  kind: typeof ROLE_RECORD_KIND.close;
  receipt_id: string;
  binding_id: string;
  binding_digest: string;
  generation: number;
  candidate_sha: string;
  report: RoleSourceBinding;
  final_instruction_chain_hash: string;
  checked_source_hashes: string[];
  validator_version: 1;
  receipt_nonce: string;
  writer: RoleBindingActor;
  closed_at: string;
}
export interface RoleCloseReference {
  schema_version: 1;
  receipt_id: string;
  request_id: string;
  candidate_sha: string;
}
export interface RoleCloseAdmission {
  reference: RoleBindingReference;
  close: RoleCloseReference;
}
export interface RoleCloseClaim {
  schema_version: 1;
  kind: typeof ROLE_RECORD_KIND.closeClaim;
  binding_id: string;
  binding_digest: string;
  generation: number;
  receipt_id: string;
  request_id: string;
  candidate_sha: string;
  writer: RoleBindingActor;
  claimed_at: string;
}
export type RoleCloseGateStatus = "success" | "failed" | "conflict" | "aborted" | "stale_base" | "environment_blocked";
export interface RoleCloseGateOutcome {
  schema_version: 1;
  kind: typeof ROLE_RECORD_KIND.closeGateOutcome;
  binding_id: string;
  binding_digest: string;
  generation: number;
  receipt_id: string;
  request_id: string;
  candidate_sha: string;
  status: RoleCloseGateStatus;
  invalidates_close: boolean;
  failure_reason: string | null;
  writer: RoleBindingActor;
  ended_at: string;
}
export interface RoleGateEvidenceBinding {
  /** Mutable canonical gate-result location, retained for provenance only. */
  source: RoleSourceBinding;
  /** Immutable generation-local bytes used by every later validation. */
  snapshot: RoleSourceBinding;
  role: "guardian" | "observer";
  verdict: "PASS" | "PASS_WITH_NOTES";
  review_sha: string;
  branch: string;
}
export interface RoleAdmissionTransition {
  schema_version: 1;
  kind: typeof ROLE_RECORD_KIND.admissionTransition;
  binding_id: string;
  binding_digest: string;
  generation: number;
  sequence: number;
  work_id: string;
  previous_authority: RoleSourceBinding;
  authority: RoleSourceBinding;
  previous_candidate_sha: string | null;
  candidate_sha: string | null;
  evidence: RoleGateEvidenceBinding;
  writer: RoleBindingActor;
  transitioned_at: string;
}
export interface RoleCurrentBinding {
  schema_version: 1;
  kind: typeof ROLE_RECORD_KIND.current;
  binding_id: string;
  generation: number;
  binding_digest: string;
  updated_at: string;
}

export interface IssueRoleAuthorizationOptions {
  project_root: string;
  pm_id: string;
  identity: RoleExecutionIdentity;
  role: RoleKind;
  carabiner: RoleCarabiner;
  item: { work_id: string; revision: string; session_id: string; authority_path: string };
  assignment_path: string;
  blueprint_path?: string | null;
  package_id?: string | null;
  prompt_path: string;
  routing: RoleRoutingBinding;
  lens: RoleLensBindingInput;
  knowledge: RoleKnowledgeBinding;
  integration: { ref: string; base_sha: string };
  initial_instructions_path?: string | null;
  issuer: RoleBindingActor;
  recovery?: RoleRecoveryInput | null;
}

export interface RoleBindingReference {
  schema_version: 1;
  binding_id: string;
  generation: number;
  binding_digest: string;
  identity: RoleExecutionIdentity;
}

export function roleBindingFromContext(value: unknown): RoleBindingReference | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[ROLE_BINDING_CONTEXT_STORAGE_KEY] as RoleBindingReference | null | undefined;
}

export function writeRoleBindingToContext(
  value: Record<string, unknown>,
  binding: RoleBindingReference | null,
): void {
  value[ROLE_BINDING_CONTEXT_STORAGE_KEY] = binding;
}

export interface RoleBindingPathSet {
  root: string;
  generation_dir: string;
  authorization: string;
  launch: string;
  close: string;
  close_receipts: string;
  close_claims: string;
  close_gate_outcomes: string;
  admission_transitions: string;
  current: string;
  instructions: string;
  deliveries: string;
}

const AUTHORIZERS = new Set(["pm", "dock", "attended-parent", "coordinator"]);
const LAUNCH_WRITERS = new Set(["launcher", "attended-parent"]);
const CLOSE_WRITERS = new Set(["admission-controller", "dock"]);
const CLOSE_GATE_WRITERS = new Set(["merge-gate"]);
const ADMISSION_TRANSITION_WRITERS = new Set(["pm", "dock", "coordinator"]);
const SHA_RE = /^[0-9a-f]{40,64}$/;
const FULL_COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_BLUEPRINT_UPDATE_BYTES = 2 * 1024 * 1024;
const MAX_ITEM_AUTHORITY_BYTES = 2 * 1024 * 1024;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const PROVIDER_TRANSPORT_COMPATIBILITY: Readonly<Record<string, readonly ProviderTransport[]>> = {
  "codex-cli": ["codex-cli"],
  "claude-subprocess": ["claude-subprocess"],
  "attended-agent": ["attended-agent"],
  "recorded-cli": ["recorded-cli"],
  "lane-dispatch": ["lane-dispatch"],
};

function fwd(value: string): string { return value.replace(/\\/g, "/"); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function hashRoleFile(path: string): string { return hash(readFileSync(path)); }
function requireText(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${label} is required`);
  return clean;
}
/** The canonical transport vocabulary, derived from the compatibility table so
 * a new transport cannot be added there and forgotten here. */
export const PROVIDER_TRANSPORTS: readonly ProviderTransport[] =
  Object.keys(PROVIDER_TRANSPORT_COMPATIBILITY).sort() as ProviderTransport[];

export function isProviderTransport(value: unknown): value is ProviderTransport {
  return typeof value === "string" && Object.hasOwn(PROVIDER_TRANSPORT_COMPATIBILITY, value);
}

export function assertProviderTransportCompatible(provider: string, transport: ProviderTransport): void {
  const allowed = PROVIDER_TRANSPORT_COMPATIBILITY[provider];
  if (!allowed?.includes(transport)) {
    // W-620 AL-3: say whether the caller has something to DO, not just that this
    // combination is wrong. A PM who reached this through `--ack-launch` on a
    // codex-cli seat went looking for the ack_cmd to run; there is none, because
    // dispatch_provider.ts records that launch itself. "Not applicable" and
    // "applicable but you did it wrong" are different answers and the message
    // used to give only the second.
    const notApplicable = transport === "attended-agent" && provider.startsWith("codex")
      ? " — a codex seat needs no ack-launch at all: dispatch_provider.ts records its own launch, so there is no ack_cmd to run here."
      : "";
    throw new Error(
      `role launch transport ${transport} is incompatible with bound provider ${provider}${notApplicable}`,
    );
  }
}
function requireSchema(value: unknown, kind: string): asserts value is { schema_version: 1; kind: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${kind} record is malformed`);
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) throw new Error(`${kind} schema_version is unsupported or malformed`);
  if (record.kind !== kind) throw new Error(`${kind} record kind is malformed`);
}
function projectRelative(projectRoot: string, path: string): string {
  const root = realpathSync(resolve(projectRoot));
  if (!existsSync(path)) throw new Error(`role binding source is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`role binding source is not a file: ${path}`);
  const real = realpathSync(resolve(path));
  const rel = fwd(relative(root, real));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`role binding source escapes project root: ${path}`);
  return rel;
}
function source(projectRoot: string, path: string): RoleSourceBinding {
  const rel = projectRelative(projectRoot, path);
  return { path: rel, content_hash: hashRoleFile(resolve(projectRoot, rel)) };
}
interface TomlLexicalState {
  multiline: '"""' | "'''" | null;
  squareDepth: number;
  braceDepth: number;
}

const PLAN_GRAPH_ITEM_LIFECYCLE_KEYS = new Set([
  "status", "updated", "status_changed", "transition_reason", "evidence_refs",
]);

function tomlStateIsTopLevel(state: TomlLexicalState): boolean {
  return state.multiline === null && state.squareDepth === 0 && state.braceDepth === 0;
}

function scanTomlLine(line: string, previous: TomlLexicalState): TomlLexicalState {
  const state = { ...previous };
  const source = line.replace(/\r?\n$/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (state.multiline) {
      if (state.multiline === '"""' && char === "\\") {
        index += 1;
      } else if (source.startsWith(state.multiline, index)) {
        index += 2;
        state.multiline = null;
      }
      continue;
    }
    if (char === "#") break;
    if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
      state.multiline = source.slice(index, index + 3) as TomlLexicalState["multiline"];
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      for (index += 1; index < source.length; index++) {
        if (quote === '"' && source[index] === "\\") index += 1;
        else if (source[index] === quote) break;
      }
      continue;
    }
    if (char === "[") state.squareDepth += 1;
    else if (char === "]") state.squareDepth -= 1;
    else if (char === "{") state.braceDepth += 1;
    else if (char === "}") state.braceDepth -= 1;
  }
  return state;
}

function tomlTopLevelAssignmentKey(line: string): string | null {
  const source = line.replace(/\r?\n$/, "");
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (quote === '"' && char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return null;
    else if (char === "=") {
      const keySource = source.slice(0, index).trim();
      if (!keySource) return null;
      try {
        const marker = "__garelier_authority_key__";
        const decoded = parseToml(`${keySource} = ${JSON.stringify(marker)}`) as Record<string, unknown>;
        const keys = Object.keys(decoded);
        return keys.length === 1 && decoded[keys[0]!] === marker ? keys[0]! : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function tomlTableHeaderRoot(line: string): string | null {
  const source = line.replace(/\r?\n$/, "").trim();
  if (!source.startsWith("[")) return null;
  try {
    const decoded = parseToml(source) as Record<string, unknown>;
    const keys = Object.keys(decoded);
    return keys.length === 1 ? keys[0]! : null;
  } catch {
    return null;
  }
}

function planGraphItemAuthorityFrontmatter(
  frontmatter: string,
  parsed: Record<string, unknown>,
): string | null {
  // Preserve the v1 raw-byte normalization while advancing only at TOML
  // structural boundaries; table-shaped text inside values remains authority.
  const lines = frontmatter.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  if (lines.join("") !== frontmatter) return null;
  const kept: string[] = [];
  let lexical: TomlLexicalState = { multiline: null, squareDepth: 0, braceDepth: 0 };
  let inTable = false;
  let inEvidenceRefs = false;
  let skippingTopLevelValue = false;
  for (const line of lines) {
    if (line === "") continue;
    const startsAtTopLevel = tomlStateIsTopLevel(lexical);
    const nextLexical = scanTomlLine(line, lexical);
    if (skippingTopLevelValue) {
      skippingTopLevelValue = !tomlStateIsTopLevel(nextLexical);
      lexical = nextLexical;
      continue;
    }
    const tableRoot = startsAtTopLevel ? tomlTableHeaderRoot(line) : null;
    if (tableRoot !== null) {
      inTable = true;
      inEvidenceRefs = tableRoot === "evidence_refs" && Array.isArray(parsed.evidence_refs);
      if (inEvidenceRefs) {
        while (kept.length > 0 && kept.at(-1)!.trim() === "") kept.pop();
        lexical = nextLexical;
        continue;
      }
    }
    if (inEvidenceRefs) {
      lexical = nextLexical;
      continue;
    }
    if (!inTable && startsAtTopLevel) {
      const key = tomlTopLevelAssignmentKey(line);
      const isLifecycle = key !== null
        && PLAN_GRAPH_ITEM_LIFECYCLE_KEYS.has(key)
        && Object.hasOwn(parsed, key)
        && (key !== "evidence_refs" || Array.isArray(parsed.evidence_refs));
      if (isLifecycle) {
        skippingTopLevelValue = !tomlStateIsTopLevel(nextLexical);
        lexical = nextLexical;
        continue;
      }
    }
    kept.push(line);
    lexical = nextLexical;
  }
  // The delimiter-leading EOL is outside `frontmatter`; removing a trailing
  // evidence table must not reintroduce that EOL into semantic authority.
  return kept.join("").replace(/\r?\n$/, "");
}
function planGraphItemSemanticHash(body: string): string | null {
  const frontmatter = /^(\+\+\+\r?\n)([\s\S]*?)(\r?\n\+\+\+(?:\r?\n|$))/.exec(body);
  if (!frontmatter) return null;
  let parsed: Record<string, unknown>;
  try { parsed = parseToml(frontmatter[2]) as Record<string, unknown>; }
  catch { return null; }
  if (parsed.schema_version !== 3 || parsed.kind !== "garelier_backlog") return null;
  const normalizedFrontmatter = planGraphItemAuthorityFrontmatter(frontmatter[2], parsed);
  if (normalizedFrontmatter === null) return null;
  return hash(frontmatter[1] + normalizedFrontmatter + frontmatter[3] + body.slice(frontmatter[0].length));
}
function committedItemAuthority(projectRoot: string, path: string): { path: string; bytes: Buffer } {
  const rel = projectRelative(projectRoot, path);
  const shown = spawnSync(requireRuntimeExecutable("git"), ["-C", projectRoot, "show", `HEAD:${rel}`], {
    encoding: null, windowsHide: true, maxBuffer: MAX_ITEM_AUTHORITY_BYTES,
  });
  if (shown.status !== 0) throw new Error(`item authority source is not committed at HEAD: ${rel}`);
  const bytes = Buffer.from(shown.stdout ?? []);
  if (bytes.length >= MAX_ITEM_AUTHORITY_BYTES) throw new Error(`item authority source exceeds the bounded read limit: ${rel}`);
  return { path: rel, bytes };
}
function itemAuthoritySource(projectRoot: string, path: string): RoleSourceBinding {
  const committed = committedItemAuthority(projectRoot, path);
  const bound: RoleSourceBinding = { path: committed.path, content_hash: hash(committed.bytes) };
  const semanticHash = planGraphItemSemanticHash(committed.bytes.toString("utf8"));
  return semanticHash === null ? bound : {
    ...bound,
    hash_mode: "plan_graph_item_authority_v1",
    semantic_hash: semanticHash,
  };
}
function assertSourceCurrent(
  projectRoot: string,
  expected: RoleSourceBinding,
  label: string,
  deliveredHashes: ReadonlySet<string> = new Set(),
): string {
  const path = resolve(projectRoot, expected.path);
  if (!existsSync(path)) throw new Error(`${label} source changed: missing ${expected.path}`);
  projectRelative(projectRoot, path);
  const actual = hashRoleFile(path);
  if (actual !== expected.content_hash && !deliveredHashes.has(actual)) throw new Error(`${label} source changed: ${expected.path}`);
  return actual;
}
function assertItemAuthorityCurrent(projectRoot: string, expected: RoleSourceBinding): void {
  const path = resolve(projectRoot, expected.path);
  if (!existsSync(path)) throw new Error(`item authority source changed: missing ${expected.path}`);
  projectRelative(projectRoot, path);
  const committed = committedItemAuthority(projectRoot, path);
  const actual = hash(committed.bytes);
  if (actual === expected.content_hash) return;
  if (expected.hash_mode !== "plan_graph_item_authority_v1" || !expected.semantic_hash) {
    throw new Error(`item authority source changed: ${expected.path}`);
  }
  const semanticHash = planGraphItemSemanticHash(committed.bytes.toString("utf8"));
  if (semanticHash !== expected.semantic_hash) throw new Error(`item authority source changed: ${expected.path}`);
}
interface CommittedBlueprint {
  path: string;
  commit_sha: string;
  content_hash: string;
  bytes: Buffer;
}
function blueprintAtCommit(projectRoot: string, expected: RoleSourceBinding, commitSha: string): CommittedBlueprint {
  const commit = requireText(commitSha, "blueprint update commit");
  if (!FULL_COMMIT_SHA_RE.test(commit)) throw new Error("blueprint update requires a full lowercase commit SHA");
  const git = requireRuntimeExecutable("git");
  const kind = spawnSync(git, ["-C", projectRoot, "cat-file", "-t", commit], {
    encoding: "utf8", windowsHide: true, maxBuffer: 1024,
  });
  if (kind.status !== 0 || kind.stdout?.trim() !== "commit") {
    throw new Error(`blueprint update commit is not a local commit object: ${commit}`);
  }
  const shown = spawnSync(git, ["-C", projectRoot, "show", `${commit}:${expected.path}`], {
    encoding: null, windowsHide: true, maxBuffer: MAX_BLUEPRINT_UPDATE_BYTES,
  });
  if (shown.status !== 0) {
    throw new Error(`blueprint update commit does not contain the bound path: ${expected.path}`);
  }
  const bytes = Buffer.from(shown.stdout ?? []);
  if (bytes.length >= MAX_BLUEPRINT_UPDATE_BYTES) throw new Error("blueprint update exceeds the bounded read limit");
  return { path: expected.path, commit_sha: commit, content_hash: hash(bytes), bytes };
}
function normalizeBlueprintLineEndings(bytes: Buffer): Buffer {
  const normalized = Buffer.allocUnsafe(bytes.length);
  let write = 0;
  for (let read = 0; read < bytes.length; read++) {
    if (bytes[read] === 13 && bytes[read + 1] === 10) continue;
    normalized[write++] = bytes[read];
  }
  return normalized.subarray(0, write);
}
function pendingBlueprintUpdate(
  projectRoot: string,
  expected: RoleSourceBinding | null,
  commitSha: string | undefined,
): RoleBlueprintUpdate | null {
  if (!commitSha) return null;
  try {
    if (!expected) throw new Error("blueprint update was supplied for a role with no bound blueprint");
    const committed = blueprintAtCommit(projectRoot, expected, commitSha);
    const current = readFileSync(resolve(projectRoot, expected.path));
    if (!normalizeBlueprintLineEndings(current).equals(normalizeBlueprintLineEndings(committed.bytes))) {
      throw new Error("blueprint update commit does not match the current bound blueprint path");
    }
    return {
      path: committed.path,
      commit_sha: committed.commit_sha,
      content_hash: hash(current),
      commit_content_hash: committed.content_hash,
    };
  } catch (error) {
    throw new RoleResumePreflightError(`blueprint update rejected: ${(error as Error).message}`);
  }
}
function blueprintUpdatePointer(update: RoleBlueprintUpdate): string {
  return [
    "[Canonical blueprint update]",
    `- path: ${JSON.stringify(update.path)}`,
    `- commit_sha: ${update.commit_sha}`,
    `- content_hash: ${update.content_hash}`,
    `- commit_content_hash: ${update.commit_content_hash}`,
    `- Read before acting: git show ${JSON.stringify(`${update.commit_sha}:${update.path}`)}`,
  ].join("\n");
}
function validateDeliveredBlueprintUpdate(
  projectRoot: string,
  expected: RoleSourceBinding | null,
  instruction: RoleInstruction,
): RoleBlueprintUpdate | null {
  const updates = instruction.source_updates;
  if (updates === undefined) return null;
  if (!updates || typeof updates !== "object" || Array.isArray(updates)
    || Object.keys(updates).length !== 1 || !("blueprint" in updates)) {
    throw new Error("role instruction source_updates is malformed");
  }
  if (!expected) throw new Error("role instruction updates an unbound blueprint");
  const claimed = updates.blueprint;
  if (!claimed || typeof claimed !== "object" || Array.isArray(claimed)
    || claimed.path !== expected.path || typeof claimed.commit_sha !== "string"
    || typeof claimed.content_hash !== "string" || typeof claimed.commit_content_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(claimed.content_hash)) {
    throw new Error("role instruction blueprint update is malformed or changes the bound path");
  }
  const committed = blueprintAtCommit(projectRoot, expected, claimed.commit_sha);
  if (committed.path !== claimed.path || committed.commit_sha !== claimed.commit_sha
    || committed.content_hash !== claimed.commit_content_hash) {
    throw new Error("role instruction blueprint update does not match its committed bytes");
  }
  if (!instruction.message.endsWith(blueprintUpdatePointer(claimed))) {
    throw new Error("role instruction message does not carry its blueprint update pointer");
  }
  return claimed;
}
function projectHash(projectRoot: string): string { return hash(fwd(realpathSync(resolve(projectRoot)))); }
function bindingId(projectRoot: string, pmId: string, identity: RoleExecutionIdentity): string {
  return hash(canonicalJson({ project_hash: projectHash(projectRoot), pm_id: pmId, execution_identity: identity }));
}
function bindingsRoot(projectRoot: string, pmId: string): string {
  return join(resolve(projectRoot), "__garelier", pmId, "runtime", "dispatch", "bindings");
}
function initialInstructionsRoot(projectRoot: string, pmId: string): string {
  return join(resolve(projectRoot), "__garelier", pmId, "runtime", "dispatch", "initial-instructions");
}
function initialInstructionsSnapshotPath(projectRoot: string, pmId: string, contentHash: string): string {
  return join(initialInstructionsRoot(projectRoot, pmId), `${contentHash}.md`);
}
function writeExclusiveBytes(path: string, body: Buffer, label: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (readFileSync(path).equals(body)) return;
    throw new Error(`${label} digest collision: ${path}`);
  }
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, body, { flag: "wx" });
    try { renameSync(temp, path); }
    catch (error) {
      if (existsSync(path) && readFileSync(path).equals(body)) return;
      throw error;
    }
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}
export function snapshotRoleInitialInstructions(options: {
  project_root: string; pm_id: string; ledger_path: string;
}): { authority: RoleSourceBinding; ledger: RoleMutableSourceBinding } {
  const projectRoot = realpathSync(resolve(options.project_root));
  const ledgerPath = resolve(options.ledger_path);
  const ledger = { path: projectRelative(projectRoot, ledgerPath) };
  const body = readFileSync(ledgerPath);
  const contentHash = hash(body);
  const snapshotPath = initialInstructionsSnapshotPath(projectRoot, options.pm_id, contentHash);
  writeExclusiveBytes(snapshotPath, body, "role initial-instruction snapshot");
  return { authority: source(projectRoot, snapshotPath), ledger };
}

export function dispatchExecutionIdentity(id: string | number): RoleExecutionIdentity {
  const value = String(id).replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`dispatch execution identity requires a positive dispatch id: ${id}`);
  return { kind: "dispatch", id: value };
}
export function roleSeatExecutionIdentity(id: string | number, role: RoleKind): RoleExecutionIdentity {
  const value = String(id).replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`role-seat execution identity requires a positive dispatch id: ${id}`);
  if (role !== "scout" && role !== "observer" && role !== "guardian" && role !== "concierge") {
    throw new Error(`role-seat execution identity has an unsupported role: ${role}`);
  }
  return { kind: "role-seat", id: value, role };
}
/**
 * Resolve a numbered role from its branch or immediate dispatch container.
 * A detached HEAD reports an empty branch and falls back to the container; when
 * both sources resolve, they must identify the same dispatch.
 */
export function dispatchIdForRoleCheckout(fullBranchRef: string, checkout: string): string | null {
  const branch = fullBranchRef.trim();
  const branchId = /\/(?:workbench|anvil|shelf|satchel)\/#([1-9][0-9]*)\//.exec(branch)?.[1] ?? null;
  const containerId = /^dispatch([1-9][0-9]*)$/.exec(basename(dirname(requireText(checkout, "role checkout"))))?.[1] ?? null;
  if (branchId && containerId && branchId !== containerId) {
    throw new Error(`role branch dispatch identity ${branchId} does not match immediate container ${containerId}`);
  }
  return branchId ?? containerId;
}
export function branchExecutionIdentity(role: RoleKind, fullBranchRef: string): RoleExecutionIdentity {
  requireText(fullBranchRef, "full branch ref");
  return { kind: "branch", id: `${role}:${hash(fullBranchRef)}`, role, branch_hash: hash(fullBranchRef) };
}
export function roleForBranch(fullBranchRef: string): RoleKind {
  const branch = requireText(fullBranchRef, "full branch ref");
  const family = /^garelier\/[^/]+\/[^/]+\/(workbench|anvil|shelf|satchel)\//.exec(branch)?.[1];
  if (family === "workbench") return "worker";
  if (family === "anvil") return "smith";
  if (family === "shelf") return "librarian";
  if (family === "satchel") return "artisan";
  throw new Error(`role branch topology is unsupported: ${branch}`);
}
export function roleExecutionIdentityForBranch(fullBranchRef: string): RoleExecutionIdentity {
  return branchExecutionIdentity(roleForBranch(fullBranchRef), fullBranchRef);
}
export function assertRoleBranchIdentity(identity: RoleExecutionIdentity, actualBranch: string): void {
  if (identity.kind !== "branch" || identity.branch_hash !== hash(requireText(actualBranch, "actual role branch"))) {
    throw new Error("role branch execution identity does not match the checked-out branch");
  }
}
export function defaultRoleCarabiner(role: RoleKind): RoleCarabiner {
  if (role === "worker") return "implementation";
  if (role === "smith") return "integration_hardening";
  if (role === "librarian") return "knowledge_maintenance";
  if (role === "artisan") return "end_to_end_creation";
  throw new Error(`role is unsupported: ${role}`);
}
export function defaultRoleSeatCarabiner(role: RoleKind): RoleCarabiner {
  if (role === "scout" || role === "observer" || role === "guardian") return "read_only_delivery";
  if (role === "concierge") return "external_operation";
  throw new Error(`role-seat role is unsupported: ${role}`);
}

export function roleBindingPaths(projectRoot: string, pmId: string, identity: RoleExecutionIdentity, generation?: number): RoleBindingPathSet {
  const root = join(bindingsRoot(projectRoot, pmId), bindingId(projectRoot, pmId, identity));
  const generationDir = generation === undefined ? root : join(root, `generation-${generation}`);
  return {
    root,
    generation_dir: generationDir,
    authorization: join(generationDir, "authorization.json"),
    launch: join(generationDir, "launch.json"),
    close: join(generationDir, "close.json"),
    close_receipts: join(generationDir, "close-receipts"),
    close_claims: join(generationDir, "close-claims"),
    close_gate_outcomes: join(generationDir, "close-gate-outcomes"),
    admission_transitions: join(generationDir, "admission-transitions"),
    current: join(root, "current.json"),
    instructions: join(generationDir, "instructions"),
    deliveries: join(generationDir, "instruction-delivery"),
  };
}

function readCanonical<T>(path: string, kind: string): T {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { throw new Error(`${kind} record is missing: ${path}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${kind} record is malformed JSON: ${path}`); }
  requireSchema(parsed, kind);
  if (raw !== canonicalJson(parsed)) throw new Error(`${kind} record is not canonical JSON: ${path}`);
  return parsed as T;
}
function roleCoreToStorage(core: RoleBindingCore): StoredRoleBindingCore {
  return {
    ...core,
    carabiner: core.carabiner === "role_recovery"
      ? ROLE_RECOVERY_CARABINER_STORAGE_VALUE
      : core.carabiner,
  };
}
function roleCoreFromStorage(core: StoredRoleBindingCore): RoleBindingCore {
  const storedCarabiner: unknown = core.carabiner;
  if (storedCarabiner !== "implementation"
    && storedCarabiner !== "integration_hardening"
    && storedCarabiner !== "knowledge_maintenance"
    && storedCarabiner !== "end_to_end_creation"
    && storedCarabiner !== "read_only_delivery"
    && storedCarabiner !== "external_operation"
    && storedCarabiner !== ROLE_RECOVERY_CARABINER_STORAGE_VALUE) {
    throw new Error(`${ROLE_RECORD_KIND.authorization} carabiner is malformed`);
  }
  const carabiner = storedCarabiner === ROLE_RECOVERY_CARABINER_STORAGE_VALUE
    ? "role_recovery"
    : storedCarabiner;
  return { ...core, carabiner };
}
function roleAuthorizationToStorage(authorization: RoleAuthorization): StoredRoleAuthorization {
  return { ...authorization, core: roleCoreToStorage(authorization.core) };
}
export function roleAuthorizationDigest(core: RoleBindingCore): string {
  return hash(canonicalJson(roleCoreToStorage(core)));
}
export function readRoleAuthorizationFile(path: string): RoleAuthorization {
  const stored = readCanonical<StoredRoleAuthorization>(path, ROLE_RECORD_KIND.authorization);
  return { ...stored, core: roleCoreFromStorage(stored.core) };
}
function writeExclusiveCanonical(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = canonicalJson(value);
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === body) return;
    throw new RoleBindingCreateExclusiveConflictError(path);
  }
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, body, { flag: "wx" });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

function roleCloseReceiptId(receipt: Omit<RoleCloseReceipt, "receipt_id">): string {
  return hash(canonicalJson(receipt));
}

function normalizeRoleCloseReceipt(receipt: RoleCloseReceipt, path: string): RoleCloseReceipt {
  const raw = receipt as RoleCloseReceipt & { receipt_id?: unknown };
  if (typeof raw.receipt_id !== "string") {
    // Compatibility for pre-W-447 immutable close.json receipts. Their bytes
    // remain untouched; the digest of those bytes is their stable receipt id.
    return { ...receipt, receipt_id: hash(canonicalJson(receipt)) };
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.receipt_id)) throw new Error(`${ROLE_RECORD_KIND.close} receipt_id is malformed: ${path}`);
  return receipt;
}

function assertRoleCloseReceiptId(receipt: RoleCloseReceipt): void {
  const { receipt_id: receiptId, ...core } = receipt;
  // A legacy receipt obtains its id from its complete old bytes and therefore
  // has no id field in the on-disk core. New receipts bind every frozen field.
  if (roleCloseReceiptId(core) !== receiptId) {
    throw new Error(`${ROLE_RECORD_KIND.close} receipt_id does not bind the receipt`);
  }
}

function readRoleCloseReceipts(paths: RoleBindingPathSet): RoleCloseReceipt[] {
  const files = [
    ...(existsSync(paths.close) ? [paths.close] : []),
    ...(existsSync(paths.close_receipts)
      ? readdirSync(paths.close_receipts).filter((entry) => entry.endsWith(".json")).sort()
        .map((entry) => join(paths.close_receipts, entry))
      : []),
  ];
  const receipts = files.map((path) => normalizeRoleCloseReceipt(
    readCanonical<RoleCloseReceipt>(path, ROLE_RECORD_KIND.close), path,
  ));
  const ids = new Set<string>();
  for (const receipt of receipts) {
    if (ids.has(receipt.receipt_id)) throw new Error(`duplicate role close receipt id: ${receipt.receipt_id}`);
    ids.add(receipt.receipt_id);
  }
  return receipts;
}

function readRoleCloseClaims(paths: RoleBindingPathSet): RoleCloseClaim[] {
  if (!existsSync(paths.close_claims)) return [];
  const claims = readdirSync(paths.close_claims).filter((entry) => entry.endsWith(".json")).sort()
    .map((entry) => {
      const claim = readCanonical<RoleCloseClaim>(join(paths.close_claims, entry), ROLE_RECORD_KIND.closeClaim);
      if (entry !== `${claim.request_id}.json`) throw new Error("role close claim filename does not match its request id");
      return claim;
    });
  const requests = new Set<string>();
  const receipts = new Set<string>();
  for (const claim of claims) {
    if (!REQUEST_ID_RE.test(claim.request_id) || !/^[0-9a-f]{64}$/.test(claim.receipt_id)) {
      throw new Error("role close claim identity is malformed");
    }
    if (requests.has(claim.request_id) || receipts.has(claim.receipt_id)) {
      throw new Error("role close claim duplicates a request or receipt");
    }
    requests.add(claim.request_id);
    receipts.add(claim.receipt_id);
  }
  return claims;
}

function readRoleCloseGateOutcomes(paths: RoleBindingPathSet): RoleCloseGateOutcome[] {
  if (!existsSync(paths.close_gate_outcomes)) return [];
  return readdirSync(paths.close_gate_outcomes).filter((entry) => entry.endsWith(".json")).sort()
    .map((entry) => {
      const outcome = readCanonical<RoleCloseGateOutcome>(
        join(paths.close_gate_outcomes, entry), ROLE_RECORD_KIND.closeGateOutcome,
      );
      const statuses: RoleCloseGateStatus[] = ["success", "failed", "conflict", "aborted", "stale_base", "environment_blocked"];
      if (!REQUEST_ID_RE.test(outcome.request_id) || !/^[0-9a-f]{64}$/.test(outcome.receipt_id)
        || !statuses.includes(outcome.status) || outcome.invalidates_close !== (outcome.status !== "success")) {
        throw new Error("role close gate outcome is malformed");
      }
      if (entry !== `${outcome.request_id}.json`) {
        throw new Error("role close gate outcome filename does not match its request id");
      }
      return outcome;
    });
}

function assertRoleCloseIdentity(receipt: RoleCloseReceipt, current: RoleCurrentBinding): void {
  if (receipt.binding_id !== current.binding_id || receipt.binding_digest !== current.binding_digest
    || receipt.generation !== current.generation || !CLOSE_WRITERS.has(receipt.writer.role)) {
    throw new Error("role close receipt is missing, self-issued, or mismatched");
  }
}

function readValidatedRoleCloseState(paths: RoleBindingPathSet, current: RoleCurrentBinding): {
  receipts: RoleCloseReceipt[];
  claims: RoleCloseClaim[];
  outcomes: RoleCloseGateOutcome[];
} {
  const receipts = readRoleCloseReceipts(paths);
  const claims = readRoleCloseClaims(paths);
  const outcomes = readRoleCloseGateOutcomes(paths);
  const receiptById = new Map(receipts.map((receipt) => [receipt.receipt_id, receipt]));
  const claimByRequest = new Map(claims.map((claim) => [claim.request_id, claim]));
  for (const receipt of receipts) {
    assertRoleCloseIdentity(receipt, current);
    assertRoleCloseReceiptId(receipt);
  }
  for (const claim of claims) {
    const receipt = receiptById.get(claim.receipt_id);
    if (!receipt || claim.binding_id !== current.binding_id || claim.binding_digest !== current.binding_digest
      || claim.generation !== current.generation || claim.candidate_sha !== receipt.candidate_sha
      || !CLOSE_WRITERS.has(claim.writer.role)) {
      throw new Error("role close claim is missing, self-issued, or mismatched");
    }
  }
  for (const outcome of outcomes) {
    const claim = claimByRequest.get(outcome.request_id);
    if (!claim || outcome.binding_id !== current.binding_id || outcome.binding_digest !== current.binding_digest
      || outcome.generation !== current.generation || outcome.receipt_id !== claim.receipt_id
      || outcome.candidate_sha !== claim.candidate_sha || !CLOSE_GATE_WRITERS.has(outcome.writer.role)) {
      throw new Error("role close gate outcome is missing, self-issued, or mismatched");
    }
  }
  return { receipts, claims, outcomes };
}
function withBindingLock<T>(root: string, action: () => T): T {
  mkdirSync(root, { recursive: true });
  const lock = join(root, ".lock");
  try { mkdirSync(lock); } catch { throw new Error(`role binding is busy: ${root}`); }
  try { return action(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
function readCurrent(projectRoot: string, pmId: string, identity: RoleExecutionIdentity): RoleCurrentBinding | null {
  const path = roleBindingPaths(projectRoot, pmId, identity).current;
  return existsSync(path) ? readCanonical<RoleCurrentBinding>(path, ROLE_RECORD_KIND.current) : null;
}
function writeCurrent(path: string, current: RoleCurrentBinding): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try { writeFileSync(temp, canonicalJson(current), { flag: "wx" }); renameSync(temp, path); }
  finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
}

function regexEscape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function gateEvidenceRole(pmId: string, path: string): "guardian" | "observer" {
  const roleMatch = new RegExp(`^__garelier/${regexEscape(pmId)}/runtime/(guardian|observer)/results/[^/]+-(guardian|observer)\\.md$`).exec(path);
  if (!roleMatch || roleMatch[1] !== roleMatch[2]) {
    throw new Error("role admission rebind evidence must be a canonical Guardian/Observer verdict path");
  }
  return roleMatch[1] as "guardian" | "observer";
}
function gateEvidenceFields(
  body: string,
  role: "guardian" | "observer",
  expectedBranch: string,
  expectedReviewSha: string,
): Omit<RoleGateEvidenceBinding, "source" | "snapshot"> {
  const verdict = role === "guardian" ? extractStrictGuardianVerdict(body) : extractStrictVerdict(body);
  if (verdict !== "PASS" && verdict !== "PASS_WITH_NOTES") {
    throw new Error("role admission rebind evidence is not a passing canonical gate verdict");
  }
  const reviewSha = extractStrictReviewSha(body);
  if (!reviewSha || reviewSha !== expectedReviewSha) {
    throw new Error(`role admission rebind evidence does not cover candidate ${expectedReviewSha}`);
  }
  // The bound branch used to be a `- Branch: \`x\`` bullet counted across the
  // whole document, so a branch named in a quoted example was a second match and
  // a verdict that mentioned one could not be used as rebind evidence at all.
  const branch = optionalMachineString(parseMachineArtifact(body, "gate evidence"), "verdict", "branch", "gate evidence");
  if (branch !== expectedBranch) {
    throw new Error(`role admission rebind evidence does not target bound branch ${expectedBranch}`);
  }
  return { role, verdict, review_sha: reviewSha, branch: expectedBranch };
}
function gateEvidence(
  projectRoot: string,
  pmId: string,
  evidencePath: string,
  expectedBranch: string,
  expectedReviewSha: string,
): { evidence: Omit<RoleGateEvidenceBinding, "snapshot">; body: Buffer } {
  const path = projectRelative(projectRoot, evidencePath);
  const role = gateEvidenceRole(pmId, path);
  const body = readFileSync(resolve(projectRoot, path));
  return {
    evidence: {
      source: { path, content_hash: hash(body) },
      ...gateEvidenceFields(body.toString("utf8"), role, expectedBranch, expectedReviewSha),
    },
    body,
  };
}
function admissionEvidenceSnapshotPath(admissionTransitionsRoot: string, contentHash: string): string {
  return join(admissionTransitionsRoot, "evidence", `${contentHash}.md`);
}

function validateGateEvidence(
  projectRoot: string,
  pmId: string,
  expected: RoleGateEvidenceBinding,
  admissionTransitionsRoot: string,
): void {
  if (!expected || typeof expected !== "object") {
    throw new Error("role admission rebind evidence record is malformed or changed");
  }
  assertSourceBindingShape(expected.source, "role admission evidence provenance");
  assertSourceBindingShape(expected.snapshot, "role admission evidence snapshot");
  const role = gateEvidenceRole(pmId, expected.source.path);
  const expectedSnapshotPath = admissionEvidenceSnapshotPath(
    admissionTransitionsRoot,
    expected.snapshot.content_hash,
  );
  const snapshotPath = projectRelative(projectRoot, expectedSnapshotPath);
  if (role !== expected.role || expected.snapshot.path !== snapshotPath
    || expected.snapshot.content_hash !== expected.source.content_hash) {
    throw new Error("role admission rebind evidence record is malformed or changed");
  }
  assertSourceCurrent(projectRoot, expected.snapshot, "role admission evidence snapshot");
  const fields = gateEvidenceFields(
    readFileSync(resolve(projectRoot, expected.snapshot.path), "utf8"),
    role,
    expected.branch,
    expected.review_sha,
  );
  if (canonicalJson(fields) !== canonicalJson({
    role: expected.role,
    verdict: expected.verdict,
    review_sha: expected.review_sha,
    branch: expected.branch,
  })) throw new Error("role admission rebind evidence record is malformed or changed");
}

function assertSourceBindingShape(binding: RoleSourceBinding, label: string): void {
  if (!binding || typeof binding.path !== "string" || !binding.path
    || !/^[0-9a-f]{64}$/.test(binding.content_hash)) throw new Error(`${label} is malformed`);
  if (binding.hash_mode === undefined && binding.semantic_hash === undefined) return;
  if (binding.hash_mode !== "plan_graph_item_authority_v1" || !binding.semantic_hash
    || !/^[0-9a-f]{64}$/.test(binding.semantic_hash)) throw new Error(`${label} hash mode is malformed`);
}

/**
 * Candidate rebinds are validated structurally here (well-formed SHAs, no
 * no-op hop, no forked predecessor) without reading close state: this
 * generation may carry several independent close receipts (multi-attempt
 * close/claim/gate-outcome, W-447), so "the" seed candidate cannot be
 * resolved until a specific receipt is known. Each receipt's own chain is
 * walked on demand by effectiveCandidateSha at the point of use (merge
 * admission, rebind write).
 */
function readAdmissionTransitions(
  projectRoot: string,
  pmId: string,
  identity: RoleExecutionIdentity,
  current: RoleCurrentBinding,
  authorization: RoleAuthorization,
): RoleAdmissionTransition[] {
  const paths = roleBindingPaths(projectRoot, pmId, identity, current.generation);
  const files = existsSync(paths.admission_transitions)
    ? readdirSync(paths.admission_transitions).filter((entry) => /^\d{6}\.json$/.test(entry)).sort()
    : [];
  const transitions: RoleAdmissionTransition[] = [];
  let authority = authorization.core.item.authority;
  const seenPredecessorCandidates = new Set<string>();
  for (let index = 0; index < files.length; index++) {
    const sequence = index + 1;
    if (files[index] !== `${String(sequence).padStart(6, "0")}.json`) {
      throw new Error("role admission transition chain is not contiguous");
    }
    const transition = readCanonical<RoleAdmissionTransition>(
      join(paths.admission_transitions, files[index]),
      ROLE_RECORD_KIND.admissionTransition,
    );
    if (transition.binding_id !== current.binding_id || transition.binding_digest !== current.binding_digest
      || transition.generation !== current.generation || transition.sequence !== sequence
      || transition.work_id !== authorization.core.item.work_id
      || !ADMISSION_TRANSITION_WRITERS.has(transition.writer?.role)
      || typeof transition.writer.id !== "string" || !transition.writer.id.trim()
      || typeof transition.transitioned_at !== "string" || !Number.isFinite(Date.parse(transition.transitioned_at))) {
      throw new Error("role admission transition identity or writer is mismatched");
    }
    assertSourceBindingShape(transition.previous_authority, "role admission previous authority");
    assertSourceBindingShape(transition.authority, "role admission authority");
    if (canonicalJson(transition.previous_authority) !== canonicalJson(authority)) {
      throw new Error("role admission authority transition predecessor is stale");
    }
    if (transition.authority.path !== transition.previous_authority.path) {
      throw new Error("role admission authority transition changed the bound source path");
    }
    const authorityChanged = canonicalJson(transition.authority) !== canonicalJson(authority);
    authority = transition.authority;
    const candidateChanged = transition.candidate_sha !== null || transition.previous_candidate_sha !== null;
    if (candidateChanged) {
      if (!transition.candidate_sha || !transition.previous_candidate_sha
        || !SHA_RE.test(transition.candidate_sha) || !SHA_RE.test(transition.previous_candidate_sha)) {
        throw new Error("role close-candidate transition is malformed");
      }
      if (transition.candidate_sha === transition.previous_candidate_sha) {
        throw new Error("role close-candidate transition predecessor is stale or unchanged");
      }
      if (seenPredecessorCandidates.has(transition.previous_candidate_sha)) {
        throw new Error("role close-candidate transition forks an existing chain");
      }
      seenPredecessorCandidates.add(transition.previous_candidate_sha);
    }
    if (!authorityChanged && !candidateChanged) throw new Error("role admission transition changes no authority");
    validateGateEvidence(
      projectRoot,
      pmId,
      transition.evidence,
      paths.admission_transitions,
    );
    transitions.push(transition);
  }
  return transitions;
}

function effectiveItemAuthority(authorization: RoleAuthorization, transitions: RoleAdmissionTransition[]): RoleSourceBinding {
  return transitions.at(-1)?.authority ?? authorization.core.item.authority;
}

/** Walks the (fork-free, per-readAdmissionTransitions-validated) candidate
 * chain starting from one specific close receipt's own candidate_sha. A
 * transition that targets a different receipt's candidate never matches and
 * is simply not applied here. */
function effectiveCandidateSha(seedCandidateSha: string, transitions: RoleAdmissionTransition[]): string {
  let candidate = seedCandidateSha;
  for (const transition of transitions) {
    if (transition.candidate_sha !== null && transition.previous_candidate_sha === candidate) {
      candidate = transition.candidate_sha;
    }
  }
  return candidate;
}

function normalizeLens(projectRoot: string, lens: RoleLensBindingInput): RoleLensBinding {
  if (lens.source === "none") {
    if (lens.ref !== null || lens.registry_path !== null || lens.pack_path !== null) throw new Error("Lens source none cannot carry a ref or registry");
    return { ref: null, source: "none", registry: null, pack: null };
  }
  if (!lens.ref) throw new Error(`Lens source ${lens.source} requires a resolved ref`);
  if (!lens.registry_path || !lens.pack_path) throw new Error(`Lens ${lens.ref} requires canonical registry and pack sources`);
  return { ref: lens.ref, source: lens.source, registry: source(projectRoot, lens.registry_path), pack: source(projectRoot, lens.pack_path) };
}
function normalizeKnowledge(projectRoot: string, role: RoleKind, value: RoleKnowledgeBinding): RoleKnowledgeBinding {
  if (value.schema_version !== 1 || value.role !== role || !Array.isArray(value.required) || !Array.isArray(value.triggered)
    || !Array.isArray(value.indexes) || !Array.isArray(value.documents)) {
    throw new Error("role Knowledge binding is malformed or belongs to another role");
  }
  const check = (entry: { path: string; content_hash: string }, label: string) => {
    const path = resolve(projectRoot, entry.path);
    projectRelative(projectRoot, path);
    if (hashRoleFile(path) !== entry.content_hash) throw new Error(`${label} changed during authorization: ${entry.path}`);
  };
  value.indexes.forEach((entry) => check(entry, "Knowledge index"));
  value.documents.forEach((entry) => check(entry, "Knowledge document"));
  return JSON.parse(JSON.stringify(value)) as RoleKnowledgeBinding;
}
function acceptanceIdsFromMarkdown(markdown: string, label: string): string[] {
  const frontmatter = /^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+/m.exec(markdown)?.[1] ?? "";
  const declared = /^\s*acceptance_ids\s*=\s*\[([^\]]*)\]\s*$/m.exec(frontmatter)?.[1];
  const heading = /^##\s+Acceptance criteria\s*$/mi.exec(markdown);
  let section = "";
  if (heading) {
    const tail = markdown.slice(heading.index + heading[0].length);
    const next = /^##\s/m.exec(tail);
    section = next ? tail.slice(0, next.index) : tail;
  }
  const declaredIds = declared === undefined
    ? []
    : [...declared.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const ids = declaredIds.length > 0
    ? declaredIds
    : [...section.matchAll(/\bAC-[A-Za-z0-9][A-Za-z0-9._-]*\b/g)].map((match) => match[0]);
  if (ids.length === 0) {
    throw new Error(`canonical acceptance IDs are missing from ${label}: both frontmatter acceptance_ids and ## Acceptance criteria are empty; add canonical AC-* IDs to either source before producer recovery`);
  }
  if (ids.some((id) => !/^AC-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))) throw new Error(`canonical acceptance ID is malformed in ${label}`);
  if (new Set(ids).size !== ids.length) throw new Error(`canonical acceptance IDs contain duplicates in ${label}`);
  return ids;
}

export function resolveCanonicalRoleAcceptanceIds(assignmentPath: string, blueprintPath?: string | null): string[] {
  if (blueprintPath) return acceptanceIdsFromMarkdown(readFileSync(blueprintPath, "utf8"), "blueprint authority");
  return acceptanceIdsFromMarkdown(readFileSync(assignmentPath, "utf8"), "assignment authority");
}

function normalizeRecovery(
  projectRoot: string,
  recovery: RoleRecoveryInput | null | undefined,
  canonicalAcceptanceIds: string[],
): RoleRecoveryBinding | null {
  if (!recovery) return null;
  if (recovery.supersedes_digest !== null && !/^[0-9a-f]{64}$/.test(recovery.supersedes_digest)) throw new Error("role_recovery requires a canonical supersedes_digest or an explicit bindingless migration");
  if (!recovery.dependencies_reaudited) throw new Error("role_recovery requires dependency re-audit evidence");
  if (canonicalJson(recovery.acceptance_reaudited) !== canonicalJson(canonicalAcceptanceIds)) {
    throw new Error(`role_recovery acceptance re-audit must exactly equal canonical IDs: ${canonicalAcceptanceIds.join(",")}`);
  }
  // W-501 / W-550: an interrupted role may legitimately have an empty
  // declared touch set and no file delta yet. Identity, predecessor, canonical
  // acceptance, and dependency re-audit remain mandatory; absence of WIP is not
  // evidence that the same container/session cannot resume.
  const wip = recovery.wip.map((entry) => {
    const actual = source(projectRoot, entry.path);
    if (actual.content_hash !== entry.content_hash) throw new Error(`role_recovery WIP inventory hash mismatch: ${actual.path}`);
    return actual;
  });
  return { ...recovery, wip };
}

function issueBoundAuthorization(options: IssueRoleAuthorizationOptions, seatReplacement: boolean): RoleAuthorization {
  const projectRoot = realpathSync(resolve(options.project_root));
  const branchRole = options.role === "worker" || options.role === "smith" || options.role === "librarian" || options.role === "artisan";
  const seatRole = options.role === "scout" || options.role === "observer" || options.role === "guardian" || options.role === "concierge";
  if ((!seatReplacement && !branchRole) || (seatReplacement && !seatRole)) {
    throw new Error(`${seatReplacement ? "role-seat" : "role"} role is unsupported: ${options.role}`);
  }
  if (!AUTHORIZERS.has(options.issuer.role)) throw new Error(`role authorization issuer role is forbidden: ${options.issuer.role}`);
  if (!options.pm_id.trim()) throw new Error("role authorization pm_id is required");
  if (!SHA_RE.test(options.integration.base_sha)) throw new Error("role authorization requires a full integration base SHA");
  const defaultCarabiner = seatReplacement ? defaultRoleSeatCarabiner(options.role) : defaultRoleCarabiner(options.role);
  if (options.carabiner !== "role_recovery" && options.carabiner !== defaultCarabiner) {
    throw new Error(`carabiner ${options.carabiner} is not on the ${options.role} role rack`);
  }
  const paths = roleBindingPaths(projectRoot, options.pm_id, options.identity);
  return withBindingLock(paths.root, () => {
    const previous = readCurrent(projectRoot, options.pm_id, options.identity);
    const generation = previous ? previous.generation + 1 : 1;
    const canonicalAcceptanceIds = options.carabiner === "role_recovery"
      ? resolveCanonicalRoleAcceptanceIds(options.assignment_path, options.blueprint_path)
      : [];
    const recovery = normalizeRecovery(projectRoot, options.recovery, canonicalAcceptanceIds);
    if (options.carabiner === "role_recovery") {
      if (!recovery) throw new Error("role_recovery authorization requires recovery evidence");
      if (previous && recovery.supersedes_digest !== previous.binding_digest) throw new Error("role_recovery does not supersede the current binding digest");
      if (!previous && (recovery.reason !== "bindingless_migration" || recovery.supersedes_digest !== null)) {
        throw new Error("bindingless role recovery requires bindingless_migration with no superseded digest");
      }
      if (previous && recovery.reason === "bindingless_migration") throw new Error("bindingless_migration cannot replace an existing role generation");
    } else if (recovery) {
      throw new Error("recovery evidence is valid only with the role_recovery carabiner");
    } else if (previous && !seatReplacement) {
      throw new Error("a current role binding already exists; issue role_recovery for a replacement generation");
    } else if (previous && !existsSync(roleBindingPaths(projectRoot, options.pm_id, options.identity, previous.generation).launch)) {
      throw new Error("a current role-seat binding is unlaunched; refusing replacement generation");
    }
    const supersedes = previous?.binding_digest ?? recovery?.supersedes_digest ?? null;
    if (previous && recovery && recovery.supersedes_digest !== previous.binding_digest) throw new Error("recovery supersession is stale");
    const promptSource = source(projectRoot, options.prompt_path);
    if (readFileSync(resolve(projectRoot, promptSource.path), "utf8").trim() === "") throw new Error("role prompt is empty; authorization refused");
    const initialInstructions = options.initial_instructions_path
      ? snapshotRoleInitialInstructions({
        project_root: projectRoot, pm_id: options.pm_id, ledger_path: options.initial_instructions_path,
      })
      : null;
    const itemAuthority = itemAuthoritySource(projectRoot, options.item.authority_path);
    const assignment = source(projectRoot, options.assignment_path);
    const sharedPlanGraphAssignment = itemAuthority.hash_mode === "plan_graph_item_authority_v1"
      && assignment.path === itemAuthority.path;
    const core: RoleBindingCore = {
      schema_version: 1,
      kind: ROLE_RECORD_KIND.bindingCore,
      namespace: { project_hash: projectHash(projectRoot), pm_id: options.pm_id },
      execution_identity: options.identity,
      generation,
      item: {
        work_id: requireText(options.item.work_id, "role work id"),
        revision: requireText(options.item.revision, "role work revision"),
        session_id: requireText(options.item.session_id, "role control session"),
        authority: itemAuthority,
      },
      sources: {
        assignment: sharedPlanGraphAssignment ? itemAuthority : assignment,
        blueprint: options.blueprint_path ? source(projectRoot, options.blueprint_path) : null,
        package_id: options.package_id?.trim() || null,
        prompt: promptSource,
      },
      role: options.role,
      carabiner: options.carabiner,
      routing: {
        provider: requireText(options.routing.provider, "provider"),
        model: requireText(options.routing.model, "role model"),
        effort: requireText(options.routing.effort, "role effort"),
        source: requireText(options.routing.source, "role routing source"),
      },
      lens: normalizeLens(projectRoot, options.lens),
      knowledge: normalizeKnowledge(projectRoot, options.role, options.knowledge),
      integration: { ref: requireText(options.integration.ref, "integration ref"), base_sha: options.integration.base_sha },
      initial_instructions: initialInstructions?.authority ?? null,
      instruction_ledger: initialInstructions?.ledger ?? null,
      supersedes_digest: supersedes,
      recovery,
    };
    const digest = roleAuthorizationDigest(core);
    const authorization: RoleAuthorization = {
      schema_version: 1,
      kind: ROLE_RECORD_KIND.authorization,
      binding_id: basename(paths.root),
      core_digest: digest,
      core,
      issuer: options.issuer,
      issued_at: new Date().toISOString(),
    };
    const generationPaths = roleBindingPaths(projectRoot, options.pm_id, options.identity, generation);
    if (existsSync(generationPaths.generation_dir)) throw new Error(`role binding generation already exists: ${generation}`);
    mkdirSync(generationPaths.generation_dir, { recursive: false });
    try {
      writeExclusiveCanonical(generationPaths.authorization, roleAuthorizationToStorage(authorization));
      writeCurrent(generationPaths.current, {
        schema_version: 1, kind: ROLE_RECORD_KIND.current, binding_id: authorization.binding_id,
        generation, binding_digest: digest, updated_at: new Date().toISOString(),
      });
    } catch (error) {
      rmSync(generationPaths.generation_dir, { recursive: true, force: true });
      throw error;
    }
    return authorization;
  });
}

export function issueRoleAuthorization(options: IssueRoleAuthorizationOptions): RoleAuthorization {
  return issueBoundAuthorization(options, false);
}

/** Read-only/Concierge seats reuse the canonical binding machinery under a
 * role-qualified identity. A fresh round advances only that role-seat binding;
 * it never supersedes or replays the dispatch role identity. */
export function issueRoleSeatAuthorization(options: IssueRoleAuthorizationOptions): RoleAuthorization {
  if (options.identity.kind !== "role-seat" || options.identity.role !== options.role) {
    throw new Error("role-seat authorization identity does not match its role");
  }
  if (options.carabiner === "role_recovery" || options.recovery) {
    throw new Error("role-seat authorization cannot use role_recovery");
  }
  return issueBoundAuthorization(options, true);
}

export interface RecoverRoleAuthorizationOptions extends Omit<IssueRoleAuthorizationOptions, "identity" | "role" | "carabiner" | "recovery"> {
  execution:
    | { kind: "dispatch"; id: string | number; role: RoleKind }
    | { kind: "branch"; branch: string };
  expected_previous_digest: string | null;
  recovery: Omit<RoleRecoveryInput, "supersedes_digest">;
}

export function recoverRoleAuthorization(options: RecoverRoleAuthorizationOptions): RoleAuthorization {
  const { execution, expected_previous_digest, recovery, ...binding } = options;
  const role = execution.kind === "branch" ? roleForBranch(execution.branch) : execution.role;
  if (role !== "worker" && role !== "smith" && role !== "librarian" && role !== "artisan") {
    throw new Error(`role recovery role is unsupported: ${role}`);
  }
  const identity = execution.kind === "branch"
    ? roleExecutionIdentityForBranch(execution.branch)
    : dispatchExecutionIdentity(execution.id);
  const previous = readCurrent(resolve(options.project_root), options.pm_id, identity);
  if ((previous?.binding_digest ?? null) !== expected_previous_digest) {
    throw new Error("role recovery expected previous generation/digest is stale");
  }
  return issueRoleAuthorization({
    ...binding,
    identity,
    role,
    carabiner: "role_recovery",
    recovery: { ...recovery, supersedes_digest: expected_previous_digest },
  });
}

export function bindingReference(authorization: RoleAuthorization): RoleBindingReference {
  return {
    schema_version: 1,
    binding_id: authorization.binding_id,
    generation: authorization.core.generation,
    binding_digest: authorization.core_digest,
    identity: authorization.core.execution_identity,
  };
}

/** Immutable-authority lookup for recovery and launch acknowledgement. It
 * proves canonical record integrity/currentness but deliberately does not
 * require source paths to retain their launch-time bytes. Recovery replaces a
 * stale generation; acknowledgement records the historical launch already
 * admitted against the immutable core. */
export function readCurrentRoleAuthorization(options: {
  project_root: string; pm_id: string; identity: RoleExecutionIdentity;
}): RoleAuthorization {
  const projectRoot = realpathSync(resolve(options.project_root));
  const current = readCurrent(projectRoot, options.pm_id, options.identity);
  if (!current) throw new Error("no current role binding exists; bindingless migration requires an explicit recovered source inventory");
  const authorization = readRoleAuthorizationFile(
    roleBindingPaths(projectRoot, options.pm_id, options.identity, current.generation).authorization,
  );
  if (authorization.binding_id !== current.binding_id || authorization.core_digest !== current.binding_digest
    || authorization.core.generation !== current.generation
    || roleAuthorizationDigest(authorization.core) !== authorization.core_digest) {
    throw new Error("current role binding record does not match canonical authorization");
  }
  return authorization;
}

export interface AcknowledgeRoleLaunchOptions {
  project_root: string; pm_id: string; identity: RoleExecutionIdentity; generation: number; expect_digest: string;
  transport: ProviderTransport; provider_session_id: string; success_evidence: string; writer: RoleBindingActor;
}
export function acknowledgeRoleLaunch(options: AcknowledgeRoleLaunchOptions): RoleLaunchAcknowledgement {
  if (!LAUNCH_WRITERS.has(options.writer.role)) throw new Error(`role launch writer role is forbidden: ${options.writer.role}`);
  // Launchers validate live sources immediately before starting a provider.
  // The acknowledgement may arrive only after that provider returns, when a PM
  // has legitimately advanced the same blueprint for a later gate round. Bind
  // the historical fact to the immutable current generation/digest; do not
  // reinterpret it through mutable source-path freshness.
  const authorization = readCurrentRoleAuthorization(options);
  if (authorization.core.generation !== options.generation) {
    throw new Error(`role binding generation ${options.generation} is superseded by generation ${authorization.core.generation}`);
  }
  if (authorization.core_digest !== options.expect_digest) {
    throw new Error("role binding digest is superseded or replayed");
  }
  assertProviderTransportCompatible(authorization.core.routing.provider, options.transport);
  const record: RoleLaunchAcknowledgement = {
    schema_version: 1, kind: ROLE_RECORD_KIND.launch, binding_id: authorization.binding_id,
    binding_digest: options.expect_digest, generation: options.generation, transport: options.transport,
    provider_session_id: requireText(options.provider_session_id, "provider session id"),
    prompt_hash: authorization.core.sources.prompt.content_hash,
    success_evidence: requireText(options.success_evidence, "launch success evidence"), writer: options.writer,
    launched_at: new Date().toISOString(),
  };
  const launchPath = roleBindingPaths(options.project_root, options.pm_id, options.identity, options.generation).launch;
  if (existsSync(launchPath)) throw new RoleLaunchReplayError();
  try {
    writeExclusiveCanonical(launchPath, record);
  } catch (error) {
    if (error instanceof RoleBindingCreateExclusiveConflictError && error.path === launchPath) {
      throw new RoleLaunchReplayError();
    }
    throw error;
  }
  return record;
}

export interface AppendRoleInstructionOptions {
  project_root: string; pm_id: string; identity: RoleExecutionIdentity; generation: number; expect_digest: string;
  message: string; blueprint_update_commit?: string; issuer: RoleBindingActor;
}

function roleInstructionLedgerToken(
  projectRoot: string,
  authorization: RoleAuthorization,
  generationSequence: number,
): string {
  const initial = authorization.core.initial_instructions;
  const entries = initial
    ? roleLedgerEntries(
      readFileSync(resolve(projectRoot, initial.path), "utf8"),
      "role initial-instruction snapshot",
    )
    : [];
  const lastHistoricalToken = entries.reduce((highest, entry) => {
    const match = /^I(\d+)$/.exec(entry.identity);
    if (!match) return highest;
    const value = BigInt(match[1]!);
    return value > highest ? value : highest;
  }, BigInt(0));
  return `I${String(lastHistoricalToken + BigInt(generationSequence)).padStart(4, "0")}`;
}

export function appendRoleInstruction(options: AppendRoleInstructionOptions): RoleInstruction {
  if (!AUTHORIZERS.has(options.issuer.role)) throw new Error(`role instruction issuer role is forbidden: ${options.issuer.role}`);
  const paths = roleBindingPaths(options.project_root, options.pm_id, options.identity, options.generation);
  return withBindingLock(paths.root, () => {
    const checked = validateRoleBinding({
      ...options, stage: "resume", expected_digest: options.expect_digest,
      blueprint_update_commit: options.blueprint_update_commit,
    });
    mkdirSync(paths.instructions, { recursive: true });
    const sequence = readdirSync(paths.instructions).filter((entry) => /^\d{6}\.json$/.test(entry)).length + 1;
    const requestedMessage = requireText(options.message, "role instruction message");
    const message = checked.pending_blueprint_update
      ? `${requestedMessage.trimEnd()}\n\n${blueprintUpdatePointer(checked.pending_blueprint_update)}`
      : requestedMessage;
    const record: RoleInstruction = {
      schema_version: 1, kind: ROLE_RECORD_KIND.instruction, binding_digest: options.expect_digest,
      generation: options.generation, sequence,
      ledger_token: roleInstructionLedgerToken(options.project_root, checked.authorization, sequence),
      message_digest: hash(message), message,
      ...(checked.pending_blueprint_update ? { source_updates: { blueprint: checked.pending_blueprint_update } } : {}),
      issuer: options.issuer, issued_at: new Date().toISOString(),
    };
    writeExclusiveCanonical(join(paths.instructions, `${String(sequence).padStart(6, "0")}.json`), record);
    return record;
  });
}

/** The pending `[[instruction]]` entry a canonical delivery materializes. */
export function roleInstructionLedgerEntry(instruction: RoleInstruction): RoleLedgerEntry {
  return {
    identity: instruction.ledger_token,
    text: instruction.message.replace(/\s+/g, " ").trim(),
    checked: false,
    consumed: null,
    digest: instruction.message_digest.slice(0, 12),
  };
}

/** The exact `[[instruction]]` block a delivery materializes, quoted into
 * prompts and resume pointers so the role sees the entry it must check off. */
export function roleInstructionLedgerLine(instruction: RoleInstruction): string {
  return renderMachineSection(ledgerEntrySection(roleInstructionLedgerEntry(instruction)));
}

export function roleInstructionResumePointer(instruction: RoleInstruction): string {
  return [
    instruction.message,
    "",
    "[Canonical instruction ledger pointer]",
    `ledger_token: ${instruction.ledger_token}`,
    `message_digest: ${instruction.message_digest.slice(0, 12)}`,
    `Pending ledger entry already materialized in instructions.md:\n${roleInstructionLedgerLine(instruction)}`,
    `After completing this instruction, set that entry's \`checked = true\` and add \`consumed = '''<evidence>'''\` (artifact:<project-relative-path> or commit:<40hex>). The value is a TOML string - parentheses, backticks and newlines need no escaping.`,
  ].join("\n");
}

/** Recoverable resume-input rejection. Unlike a generation/digest/source
 * mismatch, this class must not invalidate the active binding or provider
 * session: the coordinator can repair the input and retry the same generation. */
export class RoleResumePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleResumePreflightError";
  }
}

function manualInstructionLedgerText(_token: string, message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

/** Read-only admission for the producer-visible ledger mutation performed by
 * materializeRoleInstructionLedgerEntry. It validates the complete current
 * ledger and the exact hypothetical next entry before session.json leaves
 * ready. A manually prepared same-token/same-message pending row is adopted;
 * every other duplicate remains a fail-closed input error. */
export function preflightRoleInstructionLedgerEntry(options: {
  project_root: string;
  pm_id: string;
  identity: RoleExecutionIdentity;
  generation: number;
  expect_digest: string;
  message: string;
  blueprint_update_commit?: string;
}): { ledger_path: string; line: string; token: string } {
  try {
    const projectRoot = realpathSync(resolve(options.project_root));
    const authorization = readCurrentRoleAuthorization({
      project_root: projectRoot, pm_id: options.pm_id, identity: options.identity,
    });
    if (authorization.core.generation !== options.generation) {
      throw new Error(`role binding generation ${options.generation} is superseded by generation ${authorization.core.generation}`);
    }
    if (authorization.core_digest !== options.expect_digest) {
      throw new Error("role binding digest is superseded or replayed");
    }
    const boundLedger = authorization.core.instruction_ledger;
    if (!boundLedger) throw new Error("role instruction delivery requires a bound mutable ledger");
    const paths = roleBindingPaths(projectRoot, options.pm_id, options.identity, options.generation);
    const sequence = existsSync(paths.instructions)
      ? readdirSync(paths.instructions).filter((entry) => /^\d{6}\.json$/.test(entry)).length + 1
      : 1;
    const requestedMessage = requireText(options.message, "role instruction message");
    const update = pendingBlueprintUpdate(
      projectRoot,
      authorization.core.sources.blueprint,
      options.blueprint_update_commit,
    );
    const message = update
      ? `${requestedMessage.trimEnd()}\n\n${blueprintUpdatePointer(update)}`
      : requestedMessage;
    const token = roleInstructionLedgerToken(projectRoot, authorization, sequence);
    const digest = hash(message);
    const expected: RoleLedgerEntry = {
      identity: token,
      text: manualInstructionLedgerText(token, message),
      checked: false,
      consumed: null,
      digest: digest.slice(0, 12),
    };
    const line = renderMachineSection(ledgerEntrySection(expected));
    const ledgerPath = resolve(projectRoot, boundLedger.path);
    if (projectRelative(projectRoot, ledgerPath) !== boundLedger.path) {
      throw new Error("role instruction ledger delivery path is non-canonical");
    }
    const original = readFileSync(ledgerPath, "utf8");
    const entries = roleLedgerEntries(original, "role mutable instruction ledger");
    const header = roleLedgerHeader(original, "role mutable instruction ledger");
    const body = parseMachineArtifact(original, "role mutable instruction ledger").body;
    const existingIndex = entries.findIndex((entry) => entry.identity === token);
    const existing = existingIndex >= 0 ? entries[existingIndex]! : null;
    // A hand-prepared row carries the same message with no canonical digest.
    const adoptable = existing !== null && existing.digest === null && existing.text === expected.text && !existing.checked;
    if (existing && !adoptable && (existing.text !== expected.text || existing.digest !== expected.digest)) {
      throw new Error(`role instruction ledger delivery conflicts with existing ledger entry: ${token}`);
    }
    const nextEntries = existing
      ? entries.map((entry, index) => index === existingIndex ? { ...entry, digest: expected.digest } : entry)
      : [...entries, expected];
    const next = renderRoleLedger(header, nextEntries, body);
    const snapshot = readFileSync(resolve(projectRoot, authorization.core.initial_instructions!.path), "utf8");
    validateInitialInstructionLedger(snapshot, next, false);
    return { ledger_path: ledgerPath, line, token };
  } catch (error) {
    if (error instanceof RoleResumePreflightError) throw error;
    throw new RoleResumePreflightError((error as Error).message);
  }
}

/** Materialize the producer-visible pending [[instruction]] entry from the canonical
 * instruction record. The message digest remains over the instruction message;
 * neither the ledger line nor the delivery envelope can redefine authority. */
export function materializeRoleInstructionLedgerEntry(options: {
  project_root: string;
  pm_id: string;
  identity: RoleExecutionIdentity;
  generation: number;
  expect_digest: string;
  instruction: RoleInstruction;
}): { ledger_path: string; line: string } {
  const projectRoot = realpathSync(resolve(options.project_root));
  // This runs before the provider receives and acknowledges the instruction,
  // so the immutable authorization is the strongest canonical proof available.
  // A resume-stage validation would circularly require the delivery record that
  // this materialization enables the provider to create.
  const authorization = readCurrentRoleAuthorization({
    project_root: projectRoot, pm_id: options.pm_id, identity: options.identity,
  });
  if (authorization.core.generation !== options.generation) {
    throw new Error(`role binding generation ${options.generation} is superseded by generation ${authorization.core.generation}`);
  }
  if (authorization.core_digest !== options.expect_digest) {
    throw new Error("role binding digest is superseded or replayed");
  }
  const boundLedger = authorization.core.instruction_ledger;
  if (!boundLedger) throw new Error("role instruction delivery requires a bound mutable ledger");
  const rootPaths = roleBindingPaths(projectRoot, options.pm_id, options.identity);
  return withBindingLock(rootPaths.root, () => {
    const current = readCurrent(projectRoot, options.pm_id, options.identity);
    if (!current || current.generation !== options.generation || current.binding_digest !== options.expect_digest) {
      throw new Error("role instruction ledger delivery targets a superseded generation or digest");
    }
    const paths = roleBindingPaths(projectRoot, options.pm_id, options.identity, options.generation);
    const instructionPath = join(paths.instructions, `${String(options.instruction.sequence).padStart(6, "0")}.json`);
    const canonical = readCanonical<RoleInstruction>(instructionPath, ROLE_RECORD_KIND.instruction);
    if (canonicalJson(canonical) !== canonicalJson(options.instruction)
      || canonical.message_digest !== hash(canonical.message)) {
      throw new Error("role instruction ledger delivery does not match the canonical instruction");
    }
    const ledgerPath = resolve(projectRoot, boundLedger.path);
    if (projectRelative(projectRoot, ledgerPath) !== boundLedger.path) {
      throw new Error("role instruction ledger delivery path is non-canonical");
    }
    const original = readFileSync(ledgerPath, "utf8");
    const entries = roleLedgerEntries(original, "role mutable instruction ledger");
    const header = roleLedgerHeader(original, "role mutable instruction ledger");
    const body = parseMachineArtifact(original, "role mutable instruction ledger").body;
    const expected = roleInstructionLedgerEntry(canonical);
    const line = roleInstructionLedgerLine(canonical);
    const existingIndex = entries.findIndex((entry) => entry.identity === canonical.ledger_token);
    const snapshot = readFileSync(resolve(projectRoot, authorization.core.initial_instructions!.path), "utf8");
    if (existingIndex >= 0) {
      const existing = entries[existingIndex]!;
      // A PM hand-written entry carries the same text but no canonical digest.
      // Adopting it means stamping the digest, never rewriting the message.
      if (existing.digest === null && existing.text === expected.text && !existing.checked) {
        const adopted = entries.map((entry, index) => index === existingIndex ? { ...entry, digest: expected.digest } : entry);
        const next = renderRoleLedger(header, adopted, body);
        validateInitialInstructionLedger(snapshot, next, false);
        writeFileSync(ledgerPath, next);
        return { ledger_path: ledgerPath, line };
      }
      if (existing.text !== expected.text || existing.digest !== expected.digest) {
        throw new Error(`role instruction ledger delivery conflicts with existing ledger entry: ${canonical.ledger_token}`);
      }
      return { ledger_path: ledgerPath, line };
    }
    const next = renderRoleLedger(header, [...entries, expected], body);
    validateInitialInstructionLedger(snapshot, next, false);
    writeFileSync(ledgerPath, next);
    return { ledger_path: ledgerPath, line };
  });
}

export interface AcknowledgeInstructionDeliveryOptions {
  project_root: string; pm_id: string; identity: RoleExecutionIdentity; generation: number; expect_digest: string;
  sequence: number; provider_session_id: string; previous_provider_session_id?: string; evidence: string; writer: RoleBindingActor;
}
export function acknowledgeInstructionDelivery(options: AcknowledgeInstructionDeliveryOptions): RoleInstructionDelivery {
  if (!LAUNCH_WRITERS.has(options.writer.role)) throw new Error(`instruction delivery writer role is forbidden: ${options.writer.role}`);
  const paths = roleBindingPaths(options.project_root, options.pm_id, options.identity, options.generation);
  return withBindingLock(paths.root, () => {
    validateRoleBinding({
      ...options, stage: "instruction_delivery", expected_digest: options.expect_digest,
      delivery_sequence: options.sequence,
    });
    const launch = readCanonical<RoleLaunchAcknowledgement>(paths.launch, ROLE_RECORD_KIND.launch);
    if (launch.binding_digest !== options.expect_digest || launch.generation !== options.generation || !LAUNCH_WRITERS.has(launch.writer.role)) {
      throw new Error("instruction delivery provider session does not match the canonical launch acknowledgement");
    }
    const instructionPath = join(paths.instructions, `${String(options.sequence).padStart(6, "0")}.json`);
    const instruction = readCanonical<RoleInstruction>(instructionPath, ROLE_RECORD_KIND.instruction);
    if (instruction.binding_digest !== options.expect_digest || instruction.sequence !== options.sequence) throw new Error("instruction delivery does not match the canonical instruction");
    const record: RoleInstructionDelivery = {
      schema_version: 1, kind: ROLE_RECORD_KIND.instructionDelivery, binding_digest: options.expect_digest,
      generation: options.generation, sequence: options.sequence,
      provider_session_id: requireText(options.provider_session_id, "instruction delivery provider session id"),
      ...(options.previous_provider_session_id
        ? { previous_provider_session_id: requireText(options.previous_provider_session_id, "instruction delivery previous provider session id") }
        : {}),
      evidence: requireText(options.evidence, "instruction delivery evidence"), writer: options.writer,
      delivered_at: new Date().toISOString(),
    };
    writeExclusiveCanonical(join(paths.deliveries, `${String(options.sequence).padStart(6, "0")}.json`), record);
    return record;
  });
}

export type RoleValidationStage = "authorization" | "resume" | "instruction_delivery" | "reporting" | "close" | "merge_request" | "merge_gate";
export interface ValidateRoleBindingOptions {
  project_root: string; pm_id: string; identity: RoleExecutionIdentity; stage: RoleValidationStage;
  generation?: number; expected_digest?: string; provider_session_id?: string; previous_provider_session_id?: string; expected_transport?: ProviderTransport;
  candidate_sha?: string; report_path?: string; ledger_path?: string;
  blueprint_update_commit?: string; delivery_sequence?: number; close_reference?: RoleCloseReference;
  /**
   * Post-land recovery may revalidate one exact current item-authority hash
   * after its caller proves the landed merge. No other source is overridden.
   */
  item_authority_hash_override?: string;
}
export interface RoleValidationResult {
  ok: true;
  reference: RoleBindingReference;
  authorization: RoleAuthorization;
  launch: RoleLaunchAcknowledgement | null;
  close: RoleCloseReceipt | null;
  final_instruction_chain_hash: string;
  checked_source_hashes: string[];
  pending_blueprint_update: RoleBlueprintUpdate | null;
}

interface RoleLedgerEntry {
  identity: string;
  text: string;
  checked: boolean;
  consumed: string | null;
  /** First 12 hex of the canonical instruction's message digest. Null for a
   * PM-hand-written entry that the canonical delivery has not yet adopted. */
  digest: string | null;
}

function assertInstructionConsumptionReference(value: string, label: string): void {
  if (/^commit:[0-9a-f]{40}$/.test(value)) return;
  if (value.startsWith("artifact:")) {
    const path = value.slice("artifact:".length);
    const segments = path.split("/");
    if (path && path === fwd(path) && !isAbsolute(path) && !/^[A-Za-z]:/.test(path)
      && !path.startsWith("/") && !path.endsWith("/")
      && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")) return;
  }
  throw new Error(`${label} must name artifact:<project-relative-path> or commit:<40hex>`);
}

/**
 * The ledger's machine face is `[[instruction]]` TOML front matter.
 *
 * The retired form put `digest:` and `(consumed: …)` inside a Markdown
 * checklist line, so a `)` inside the evidence ended the match early and the
 * caller reported "no consumption evidence" for an entry that had plenty. Each
 * field is now its own typed TOML value: evidence content cannot reach the
 * grammar at all, and a decode failure is reported as a decode failure.
 *
 * Every malformed entry is collected and reported together - stopping at the
 * first one made #430 look like a single-entry fix when 9 of 10 entries were
 * affected.
 */
function roleLedgerEntries(body: string, label: string): RoleLedgerEntry[] {
  const artifact = parseMachineArtifact(body, label);
  const rows = machineArray(artifact, "instruction", label);
  const entries: RoleLedgerEntry[] = [];
  const identities = new Set<string>();
  const faults: string[] = [];
  rows.forEach((row, index) => {
    const position = `[[instruction]] #${index + 1}`;
    const identity = typeof row.id === "string" ? row.id : "";
    if (!/^[IM]\d+$/.test(identity)) {
      faults.push(`${position} has no canonical I<n>/M<n> id`);
      return;
    }
    if (identities.has(identity)) {
      faults.push(`${identity} is declared more than once`);
      return;
    }
    identities.add(identity);
    if (typeof row.message !== "string" || row.message.trim() === "") {
      faults.push(`${identity} has no message`);
      return;
    }
    if (typeof row.checked !== "boolean") {
      faults.push(`${identity} checked must be a TOML boolean (true/false), not ${JSON.stringify(row.checked ?? null)}`);
      return;
    }
    if (row.digest !== undefined && (typeof row.digest !== "string" || !/^[0-9a-f]{12}$/.test(row.digest))) {
      faults.push(`${identity} digest must be the canonical 12-hex message digest`);
      return;
    }
    const consumed = row.consumed === undefined ? null
      : typeof row.consumed === "string" ? row.consumed.trim() : undefined;
    if (consumed === undefined) {
      faults.push(`${identity} consumed must be a TOML string`);
      return;
    }
    if (!row.checked && consumed !== null && consumed !== "") {
      faults.push(`${identity} is unchecked but carries consumption evidence`);
      return;
    }
    if (row.checked && (consumed === null || consumed === "")) {
      faults.push(`${identity} is checked with no consumption evidence (the field is empty, not unreadable)`);
      return;
    }
    entries.push({
      identity,
      text: row.message,
      checked: row.checked,
      consumed: row.checked ? consumed : null,
      digest: typeof row.digest === "string" ? row.digest : null,
    });
  });
  if (faults.length > 0) {
    throw new Error(`${label} has ${faults.length} malformed entr${faults.length === 1 ? "y" : "ies"}: ${faults.join("; ")}`);
  }
  return entries;
}

function ledgerEntrySection(entry: RoleLedgerEntry): MachineSection {
  const fields: Array<readonly [string, string | boolean]> = [["id", entry.identity], ["message", entry.text]];
  if (entry.digest) fields.push(["digest", entry.digest]);
  fields.push(["checked", entry.checked]);
  if (entry.checked && entry.consumed) fields.push(["consumed", entry.consumed]);
  return { name: "instruction", array: true, fields };
}

/** Re-render the whole ledger from its typed entries. The retired form patched
 * individual lines with a regex, which is what let a rewritten line silently
 * change shape; a full render keeps one emitter for every writer. */
function renderRoleLedger(header: MachineSection, entries: readonly RoleLedgerEntry[], body: string): string {
  return renderMachineArtifact([header, ...entries.map(ledgerEntrySection)], body);
}

function roleLedgerHeader(source: string, label: string): MachineSection {
  const artifact = parseMachineArtifact(source, label);
  const ledger = artifact.data.ledger;
  const fields: Array<readonly [string, string]> = [];
  if (ledger && typeof ledger === "object" && !Array.isArray(ledger)) {
    for (const [key, value] of Object.entries(ledger as Record<string, unknown>)) {
      if (typeof value === "string") fields.push([key, value]);
    }
  }
  return { name: "ledger", fields: fields.length > 0 ? fields : [["kind", "role_instruction_ledger_v1"]] };
}

function validateInitialInstructionLedger(
  snapshot: string,
  ledger: string,
  requireConsumed: boolean,
): void {
  const initial = roleLedgerEntries(snapshot, "role initial-instruction snapshot");
  const current = roleLedgerEntries(ledger, "role mutable instruction ledger");
  if (current.length < initial.length) {
    throw new Error("role mutable instruction ledger deleted an initial [[instruction]] entry");
  }
  for (let index = 0; index < initial.length; index++) {
    const expected = initial[index];
    const actual = current[index];
    if (actual.identity !== expected.identity || actual.text !== expected.text) {
      throw new Error(`role mutable instruction ledger rewrote or reordered initial [[instruction]] entry: ${expected.identity}`);
    }
    if (expected.checked && !actual.checked) {
      throw new Error(`role mutable instruction ledger unchecked an initially consumed entry: ${expected.identity}`);
    }
    if (expected.checked && actual.consumed !== expected.consumed) {
      throw new Error(`role mutable instruction ledger rewrote initial consumption evidence: ${expected.identity}`);
    }
  }
  if (requireConsumed) {
    const pending = current.filter((entry) => !entry.checked);
    if (pending.length > 0) {
      throw new Error(`role mutable instruction ledger has ${pending.length} unconsumed entries`);
    }
  }
}

function validateAuthorizationSources(
  projectRoot: string,
  authorization: RoleAuthorization,
  deliveredBlueprintHashes: ReadonlySet<string> = new Set(),
  itemAuthorityHashOverride?: string,
  itemAuthority: RoleSourceBinding | null = authorization.core.item.authority,
): string[] {
  const core = authorization.core;
  const expected = roleAuthorizationDigest(core);
  if (expected !== authorization.core_digest) throw new Error("role authorization digest mismatch");
  if (core.schema_version !== 1 || core.kind !== ROLE_RECORD_KIND.bindingCore) throw new Error("role binding core version is unsupported or malformed");
  assertSourceBindingShape(core.sources.assignment, "role assignment");
  const sharedPlanGraphAssignment = core.item.authority.hash_mode === "plan_graph_item_authority_v1"
    && core.sources.assignment.path === core.item.authority.path;
  const currentKnowledge = resolveRoleKnowledgeBinding({
    projectRoot,
    pmId: core.namespace.pm_id,
    role: core.role,
    assignmentMd: readFileSync(resolve(projectRoot, core.sources.assignment.path), "utf8"),
    required: core.knowledge.required,
  });
  if (canonicalJson(currentKnowledge) !== canonicalJson(core.knowledge)) {
    throw new Error("role Knowledge authority paths or hashes changed after authorization");
  }
  if (Boolean(core.initial_instructions) !== Boolean(core.instruction_ledger)) {
    throw new Error("role initial-instruction snapshot / mutable ledger binding is missing or malformed");
  }
  if (core.initial_instructions && core.instruction_ledger) {
    const expectedSnapshot = fwd(relative(projectRoot, initialInstructionsSnapshotPath(
      projectRoot, core.namespace.pm_id, core.initial_instructions.content_hash,
    )));
    if (core.initial_instructions.path !== expectedSnapshot) {
      throw new Error("role initial-instruction authority is not the canonical content-addressed snapshot");
    }
    const ledgerPath = resolve(projectRoot, core.instruction_ledger.path);
    if (projectRelative(projectRoot, ledgerPath) !== core.instruction_ledger.path) {
      throw new Error("role mutable instruction ledger path is non-canonical");
    }
    roleLedgerEntries(
      readFileSync(resolve(projectRoot, core.initial_instructions.path), "utf8"),
      "role initial-instruction snapshot",
    );
  }
  const hashes: string[] = [];
  const authority = itemAuthority ?? (sharedPlanGraphAssignment ? core.item.authority : null);
  if (authority) {
    assertSourceBindingShape(authority, "role item authority");
    if (itemAuthorityHashOverride) {
      hashes.push(assertSourceCurrent(projectRoot, authority, "item authority", new Set([itemAuthorityHashOverride])));
    } else {
      assertItemAuthorityCurrent(projectRoot, authority);
      hashes.push(authority.content_hash);
    }
  }
  const sources: Array<[RoleSourceBinding | null, string, ReadonlySet<string> | undefined]> = [
    [sharedPlanGraphAssignment ? null : core.sources.assignment, "assignment", undefined],
    [core.sources.blueprint, "blueprint", deliveredBlueprintHashes],
    [core.sources.prompt, "prompt", undefined],
    [core.lens.registry, "Lens registry", undefined],
    [core.lens.pack, "Lens pack", undefined],
    [core.initial_instructions, "initial instructions", undefined],
  ];
  for (const entry of core.knowledge.indexes) sources.push([entry, "Knowledge index", undefined]);
  for (const entry of core.knowledge.documents) sources.push([entry, "Knowledge document", undefined]);
  for (const [entry, label, deliveredHashes] of sources) {
    if (!entry) continue;
    hashes.push(assertSourceCurrent(projectRoot, entry, label, deliveredHashes));
  }
  return hashes;
}
function validateMutableInstructionLedger(
  projectRoot: string,
  authorization: RoleAuthorization,
  ledgerPath: string | undefined,
  requireConsumed: boolean,
): string | undefined {
  const bound = authorization.core.instruction_ledger;
  if (!bound) return undefined;
  if (!ledgerPath) {
    if (requireConsumed) throw new Error("role mutable instruction ledger is required for reporting/close/merge admission");
    return undefined;
  }
  const canonicalPath = resolve(projectRoot, bound.path);
  if (projectRelative(projectRoot, ledgerPath) !== bound.path || resolve(ledgerPath) !== canonicalPath) {
    throw new Error("role mutable instruction ledger path does not match authorization");
  }
  const ledger = readFileSync(canonicalPath, "utf8");
  const snapshot = readFileSync(resolve(projectRoot, authorization.core.initial_instructions!.path), "utf8");
  validateInitialInstructionLedger(snapshot, ledger, requireConsumed);
  return canonicalPath;
}
function validateInstructionChain(
  projectRoot: string,
  paths: RoleBindingPathSet,
  launch: RoleLaunchAcknowledgement,
  blueprint: RoleSourceBinding | null,
  ledgerPath?: string,
  pendingDeliverySequence?: number,
): { chain_hash: string; blueprint_updates: RoleBlueprintUpdate[]; provider_session_id: string } {
  const files = existsSync(paths.instructions) ? readdirSync(paths.instructions).filter((entry) => /^\d{6}\.json$/.test(entry)).sort() : [];
  const digests: string[] = [];
  const blueprintUpdates: RoleBlueprintUpdate[] = [];
  const ledger = ledgerPath && existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  const ledgerEntries = ledgerPath ? roleLedgerEntries(ledger, "role mutable instruction ledger") : [];
  let providerSessionId = launch.provider_session_id;
  if (pendingDeliverySequence !== undefined
    && (!Number.isInteger(pendingDeliverySequence) || pendingDeliverySequence < 1 || pendingDeliverySequence !== files.length)) {
    throw new Error("role instruction delivery sequence is not the current instruction tail");
  }
  for (let index = 0; index < files.length; index++) {
    const sequence = index + 1;
    if (files[index] !== `${String(sequence).padStart(6, "0")}.json`) throw new Error("role instruction chain is not contiguous");
    const instruction = readCanonical<RoleInstruction>(join(paths.instructions, files[index]), ROLE_RECORD_KIND.instruction);
    if (instruction.sequence !== sequence || instruction.generation !== launch.generation || instruction.binding_digest !== launch.binding_digest) throw new Error("role instruction chain identity mismatch");
    if (!AUTHORIZERS.has(instruction.issuer.role) || instruction.message_digest !== hash(instruction.message)) throw new Error("role instruction chain contains a forged instruction");
    const update = validateDeliveredBlueprintUpdate(projectRoot, blueprint, instruction);
    if (update) blueprintUpdates.push(update);
    const deliveryPath = join(paths.deliveries, files[index]);
    if (sequence === pendingDeliverySequence) {
      if (existsSync(deliveryPath)) throw new Error("role instruction delivery replay refused");
    } else {
      const delivery = readCanonical<RoleInstructionDelivery>(deliveryPath, ROLE_RECORD_KIND.instructionDelivery);
      const sameSession = delivery.provider_session_id === providerSessionId;
      const validRollover = !sameSession && delivery.previous_provider_session_id === providerSessionId;
      if (delivery.sequence !== sequence || delivery.generation !== launch.generation || delivery.binding_digest !== launch.binding_digest
        || (!sameSession && !validRollover) || (sameSession && delivery.previous_provider_session_id !== undefined)
        || !LAUNCH_WRITERS.has(delivery.writer.role)) {
        throw new Error("role instruction delivery is missing or forged");
      }
      providerSessionId = delivery.provider_session_id;
    }
    if (ledgerPath) {
      const entry = ledgerEntries.find((candidate) => candidate.identity === instruction.ledger_token);
      if (!entry?.checked || entry.digest !== instruction.message_digest.slice(0, 12) || !entry.consumed) {
        throw new Error(`role ledger does not prove canonical instruction consumption: ${instruction.ledger_token}`);
      }
      // Direct-ledger writers already bind consumption to the canonical token
      // and digest. Preserve their established evidence vocabulary; the
      // stricter artifact/commit rule belongs only to PM proxy transcription.
    }
    digests.push(instruction.message_digest);
  }
  return { chain_hash: hash(canonicalJson(digests)), blueprint_updates: blueprintUpdates, provider_session_id: providerSessionId };
}

export interface TranscribeCodexRegisterConsumptionOptions {
  project_root: string;
  pm_id: string;
  identity: RoleExecutionIdentity;
  result_text: string;
  expected_digest?: string;
  /** Deterministic concurrency seam: runs after the canonical instruction
   * snapshot is validated while the binding root lock is still held. */
  after_instruction_snapshot?: () => void;
}
export interface TranscribeCodexRegisterConsumptionResult {
  ledger_path: string;
  appended: string[];
}

/**
 * Codex Desktop may be fenced to its checkout while its mutable instruction
 * ledger is in the dispatch container.  Its completion register therefore
 * declares consumption instead of editing that ledger.  The proxy is the only
 * trusted writer: it binds each declaration to the canonical instruction chain
 * and appends the exact digest-bearing ledger entry once.
 */
export function transcribeCodexRegisterConsumption(
  options: TranscribeCodexRegisterConsumptionOptions,
): TranscribeCodexRegisterConsumptionResult {
  const projectRoot = realpathSync(resolve(options.project_root));
  const declarations = new Map<string, { digest: string; consumed: string }>();
  // The register declares consumption in its own `[[instruction]]` front-matter
  // tables. The retired form matched a `(consumed: …)` tail on a prose line,
  // so a `)` inside the evidence truncated the value and the token silently
  // failed to register. Faults are collected and reported together: stopping at
  // the first one hid 8 of 9 affected entries in #430.
  const register = parseMachineArtifact(options.result_text, "Codex register");
  const faults: string[] = [];
  machineArray(register, "instruction", "Codex register").forEach((row, index) => {
    const token = typeof row.id === "string" ? row.id : "";
    if (!/^I\d+$/.test(token)) {
      faults.push(`[[instruction]] #${index + 1} has no canonical I<n> id`);
      return;
    }
    if (declarations.has(token)) {
      faults.push(`${token} is declared more than once`);
      return;
    }
    if (typeof row.digest !== "string" || !/^[0-9a-f]{12}$/.test(row.digest)) {
      faults.push(`${token} has no canonical 12-hex digest`);
      return;
    }
    const consumed = typeof row.consumed === "string" ? row.consumed.trim() : "";
    if (!consumed) {
      faults.push(`${token} has an empty consumption reference`);
      return;
    }
    try {
      assertInstructionConsumptionReference(consumed, `Codex register consumption for ${token}`);
    } catch (error) {
      faults.push((error as Error).message);
      return;
    }
    declarations.set(token, { digest: row.digest, consumed });
  });
  if (faults.length > 0) {
    throw new Error(`Codex register consumption has ${faults.length} malformed declaration(s): ${faults.join("; ")}`);
  }

  const rootPaths = roleBindingPaths(projectRoot, options.pm_id, options.identity);
  return withBindingLock(rootPaths.root, () => {
    const checked = validateRoleBinding({
      project_root: projectRoot, pm_id: options.pm_id, identity: options.identity,
      stage: "resume", expected_digest: options.expected_digest,
    });
    if (checked.authorization.core.routing.provider !== "codex-cli") {
      throw new Error("register consumption transcription is only valid for a Codex-dispatched role");
    }
    const boundLedger = checked.authorization.core.instruction_ledger;
    const launch = checked.launch;
    if (!boundLedger || !launch) {
      throw new Error("Codex register consumption requires a bound ledger and launch acknowledgement");
    }
    const ledgerPath = resolve(projectRoot, boundLedger.path);
    if (projectRelative(projectRoot, ledgerPath) !== boundLedger.path) {
      throw new Error("Codex register consumption ledger path is non-canonical");
    }

    const paths = roleBindingPaths(projectRoot, options.pm_id, options.identity, checked.reference.generation);
    // Verify the full chain and every delivery while holding the same root lock
    // that serializes generation replacement and the ledger write.
    validateInstructionChain(projectRoot, paths, launch, checked.authorization.core.sources.blueprint);
    const files = existsSync(paths.instructions)
      ? readdirSync(paths.instructions).filter((entry) => /^\d{6}\.json$/.test(entry)).sort()
      : [];
    const instructions: RoleInstruction[] = files.map((file, index) => {
      const expected = `${String(index + 1).padStart(6, "0")}.json`;
      if (file !== expected) throw new Error("role instruction chain is not contiguous");
      return readCanonical<RoleInstruction>(join(paths.instructions, file), ROLE_RECORD_KIND.instruction);
    });
    options.after_instruction_snapshot?.();

    const snapshot = readFileSync(resolve(projectRoot, checked.authorization.core.initial_instructions!.path), "utf8");
    const original = readFileSync(ledgerPath, "utf8");
    validateInitialInstructionLedger(snapshot, original, false);
    const initialEntries = roleLedgerEntries(snapshot, "role initial-instruction snapshot");
    const initialByIdentity = new Map(initialEntries.map((entry) => [entry.identity, entry]));
    const entries = roleLedgerEntries(original, "role mutable instruction ledger");
    const byIdentity = new Map(entries.map((entry) => [entry.identity, entry]));
    const currentByIdentity = new Map<string, RoleInstruction>();
    for (const instruction of instructions) {
      if (!/^I\d+$/.test(instruction.ledger_token) || currentByIdentity.has(instruction.ledger_token)) {
        throw new Error("role instruction chain contains a malformed or duplicate ledger token");
      }
      if (initialByIdentity.has(instruction.ledger_token)) {
        throw new Error(`role instruction ledger token collides with signed initial history: ${instruction.ledger_token}`);
      }
      currentByIdentity.set(instruction.ledger_token, instruction);
    }
    for (const entry of entries) {
      if (!initialByIdentity.has(entry.identity) && !currentByIdentity.has(entry.identity)) {
        throw new Error(`role mutable instruction ledger contains no signed initial or current instruction: ${entry.identity}`);
      }
    }
    for (const token of declarations.keys()) {
      if (currentByIdentity.has(token)) continue;
      const initial = initialByIdentity.get(token);
      const mutable = byIdentity.get(token);
      if (!initial) {
        throw new Error(`Codex register consumption names no canonical instruction: ${token}`);
      }
      if (!initial.checked || !mutable?.checked || mutable.text !== initial.text
        || mutable.consumed !== initial.consumed) {
        throw new Error(`Codex register consumption conflicts with historical ledger entry: ${token}`);
      }
      if (initial.digest === null || declarations.get(token)!.digest !== initial.digest) {
        throw new Error(`Codex register consumption digest mismatch: ${token}`);
      }
      if (declarations.get(token)!.consumed !== initial.consumed) {
        throw new Error(`Codex register consumption reference mismatch: ${token}`);
      }
    }
    for (const instruction of instructions) {
      const declaration = declarations.get(instruction.ledger_token);
      if (!declaration) throw new Error(`Codex register does not declare consumption for canonical instruction: ${instruction.ledger_token}`);
      if (declaration.digest !== instruction.message_digest.slice(0, 12)) {
        throw new Error(`Codex register consumption digest mismatch: ${instruction.ledger_token}`);
      }
    }
    const appended: string[] = [];
    const nextEntries = [...entries];
    for (const instruction of instructions) {
      const declaration = declarations.get(instruction.ledger_token)!;
      const expected = roleInstructionLedgerEntry(instruction);
      const index = nextEntries.findIndex((entry) => entry.identity === instruction.ledger_token);
      if (index >= 0) {
        const existing = nextEntries[index]!;
        if (existing.text !== expected.text || existing.digest !== expected.digest) {
          throw new Error(`Codex register consumption conflicts with existing ledger entry: ${instruction.ledger_token}`);
        }
        if (existing.checked) {
          if (existing.consumed !== declaration.consumed) {
            throw new Error(`Codex register consumption conflicts with existing ledger entry: ${instruction.ledger_token}`);
          }
          continue;
        }
        nextEntries[index] = { ...existing, checked: true, consumed: declaration.consumed };
        appended.push(instruction.ledger_token);
        continue;
      }
      nextEntries.push({ ...expected, checked: true, consumed: declaration.consumed });
      appended.push(instruction.ledger_token);
    }
    const next = appended.length > 0
      ? renderRoleLedger(
        roleLedgerHeader(original, "role mutable instruction ledger"),
        nextEntries,
        parseMachineArtifact(original, "role mutable instruction ledger").body,
      )
      : original;
    validateInitialInstructionLedger(snapshot, next, true);
    if (next !== original) {
      writeFileSync(ledgerPath, next);
    }
    return { ledger_path: ledgerPath, appended };
  });
}

export function validateRoleBinding(options: ValidateRoleBindingOptions): RoleValidationResult {
  const projectRoot = realpathSync(resolve(options.project_root));
  const current = readCurrent(projectRoot, options.pm_id, options.identity);
  if (!current) throw new Error("no current binding exists for this role execution identity; bindingless work requires role_recovery");
  if (options.generation !== undefined && current.generation !== options.generation) throw new Error(`role binding generation ${options.generation} is superseded by generation ${current.generation}`);
  if (options.expected_digest && current.binding_digest !== options.expected_digest) throw new Error("role binding digest is superseded or replayed");
  const paths = roleBindingPaths(projectRoot, options.pm_id, options.identity, current.generation);
  const authorization = readRoleAuthorizationFile(paths.authorization);
  if (authorization.binding_id !== current.binding_id || authorization.core_digest !== current.binding_digest || authorization.core.generation !== current.generation) throw new Error("current role binding record does not match authorization");
  if (canonicalJson(authorization.core.execution_identity) !== canonicalJson(options.identity)) throw new Error("role execution identity replay detected");
  if (options.item_authority_hash_override !== undefined
    && (options.stage !== "merge_gate" || authorization.core.carabiner !== "role_recovery"
      || !/^[0-9a-f]{64}$/.test(options.item_authority_hash_override))) {
    throw new Error("role item-authority hash override is valid only for an exact role_recovery merge_gate hash");
  }
  if (options.blueprint_update_commit && options.stage !== "resume") {
    throw new Error("a pending blueprint update is valid only during explicit resume admission");
  }
  if (options.stage === "instruction_delivery" && options.delivery_sequence === undefined) {
    throw new Error("role instruction delivery validation requires its sequence");
  }
  if (options.stage !== "instruction_delivery" && options.delivery_sequence !== undefined) {
    throw new Error("role instruction delivery sequence is valid only during delivery admission");
  }
  if (options.previous_provider_session_id !== undefined && options.stage !== "instruction_delivery") {
    throw new Error("a previous provider session id is valid only during instruction delivery admission");
  }
  const admissionTransitions = readAdmissionTransitions(projectRoot, options.pm_id, options.identity, current, authorization);
  let launch: RoleLaunchAcknowledgement | null = null;
  if (options.stage !== "authorization") {
    if (!existsSync(paths.launch)) throw new Error("role launch acknowledgement is missing");
    launch = readCanonical<RoleLaunchAcknowledgement>(paths.launch, ROLE_RECORD_KIND.launch);
    if (launch.binding_id !== current.binding_id || launch.binding_digest !== current.binding_digest || launch.generation !== current.generation || launch.prompt_hash !== authorization.core.sources.prompt.content_hash || !LAUNCH_WRITERS.has(launch.writer.role)) {
      throw new Error("role launch acknowledgement is missing, self-issued, or mismatched");
    }
    assertProviderTransportCompatible(authorization.core.routing.provider, launch.transport);
    if (options.expected_transport && launch.transport !== options.expected_transport) throw new Error("role launch transport does not match the active provider session");
  }
  const requireConsumedLedger = options.stage === "reporting" || options.stage === "close"
    || options.stage === "merge_request" || options.stage === "merge_gate";
  const ledgerPath = validateMutableInstructionLedger(projectRoot, authorization, options.ledger_path, requireConsumedLedger);
  const instructionChain = launch
    ? validateInstructionChain(
      projectRoot,
      paths,
      launch,
      authorization.core.sources.blueprint,
      ledgerPath,
      options.stage === "instruction_delivery" ? options.delivery_sequence : undefined,
    )
    : { chain_hash: hash(canonicalJson([])), blueprint_updates: [], provider_session_id: "" };
  if (options.provider_session_id) {
    const sameSession = options.provider_session_id === instructionChain.provider_session_id;
    const validRollover = options.stage === "instruction_delivery"
      && options.previous_provider_session_id === instructionChain.provider_session_id
      && options.provider_session_id !== options.previous_provider_session_id;
    if (!sameSession && !validRollover) throw new Error("provider session replay detected");
    if (sameSession && options.previous_provider_session_id !== undefined) {
      throw new Error("provider session rollover predecessor is unexpected");
    }
  }
  const pendingUpdate = pendingBlueprintUpdate(
    projectRoot,
    authorization.core.sources.blueprint,
    options.blueprint_update_commit,
  );
  const deliveredBlueprintHashes = new Set(instructionChain.blueprint_updates.map((entry) => entry.content_hash));
  if (pendingUpdate) deliveredBlueprintHashes.add(pendingUpdate.content_hash);
  const checkedSourceHashes = validateAuthorizationSources(
    projectRoot,
    authorization,
    deliveredBlueprintHashes,
    options.item_authority_hash_override,
    effectiveItemAuthority(authorization, admissionTransitions),
  );
  checkedSourceHashes.push(...admissionTransitions.map((transition) => transition.evidence.source.content_hash));
  const finalInstructionChainHash = instructionChain.chain_hash;
  let close: RoleCloseReceipt | null = null;
  if (options.stage === "merge_request" || options.stage === "merge_gate") {
    const { receipts, claims, outcomes } = readValidatedRoleCloseState(paths, current);
    if (receipts.length === 0) throw new Error(`${ROLE_RECORD_KIND.close} record is missing: ${paths.close}`);
    const receiptById = new Map(receipts.map((receipt) => [receipt.receipt_id, receipt]));
    const claimByRequest = new Map(claims.map((claim) => [claim.request_id, claim]));
    const outcomeByRequest = new Map(outcomes.map((outcome) => [outcome.request_id, outcome]));
    if (options.close_reference) {
      // Canonical request-claim admission: claims freeze the receipt's own
      // (never transitioned) candidate_sha, so this path is intentionally
      // transition-unaware (matches the pre-W-409 freeze check exactly).
      const reference = options.close_reference;
      if (reference.schema_version !== 1 || !REQUEST_ID_RE.test(reference.request_id)
        || !/^[0-9a-f]{64}$/.test(reference.receipt_id) || reference.candidate_sha !== options.candidate_sha) {
        throw new Error("role close reference is malformed or does not match the candidate");
      }
      const claim = claimByRequest.get(reference.request_id);
      if (!claim || claim.receipt_id !== reference.receipt_id || claim.candidate_sha !== reference.candidate_sha) {
        throw new Error("role close reference does not match its canonical request claim");
      }
      const outcome = outcomeByRequest.get(reference.request_id);
      if (outcome?.invalidates_close) {
        throw new Error(`role close receipt was invalidated by gate outcome ${outcome.status} for ${reference.request_id}`);
      }
      close = receiptById.get(reference.receipt_id) ?? null;
      if (!close) throw new Error("role close receipt is missing, self-issued, or mismatched");
      // Load-bearing freeze check: invalidation selects another immutable receipt;
      // it never relaxes the candidate comparison on the selected receipt.
      if (!options.candidate_sha || close.candidate_sha !== options.candidate_sha) throw new Error("role candidate SHA does not match the close receipt");
    } else {
      // Direct candidate admission is admission-transition aware: a receipt
      // whose candidate was rebound (W-409) is matched by its effective SHA.
      const matching = receipts.filter(
        (receipt) => effectiveCandidateSha(receipt.candidate_sha, admissionTransitions) === options.candidate_sha,
      );
      if (matching.length === 0) throw new Error("role candidate SHA does not match the close receipt or its admission transition chain");
      close = matching.find((receipt) => {
        const claim = claims.find((entry) => entry.receipt_id === receipt.receipt_id);
        return !claim || !outcomeByRequest.get(claim.request_id)?.invalidates_close;
      }) ?? null;
      if (!close) throw new Error("role close receipt was invalidated by its gate outcome");
      if (!options.candidate_sha || effectiveCandidateSha(close.candidate_sha, admissionTransitions) !== options.candidate_sha) {
        throw new Error("role candidate SHA does not match the close receipt or its admission transition chain");
      }
    }
    if (!close) throw new Error("role close receipt is missing, self-issued, or mismatched");
    if (!options.report_path) throw new Error("role report path is required for merge admission");
    const report = source(projectRoot, options.report_path);
    if (report.content_hash !== close.report.content_hash || report.path !== close.report.path) throw new Error("role report hash does not match the close receipt");
    if (close.final_instruction_chain_hash !== finalInstructionChainHash) throw new Error("role final instruction chain hash does not match the close receipt");
  }
  return {
    ok: true,
    reference: bindingReference(authorization),
    authorization,
    launch,
    close,
    final_instruction_chain_hash: finalInstructionChainHash,
    checked_source_hashes: checkedSourceHashes,
    pending_blueprint_update: pendingUpdate,
  };
}

/** Initial launch admission. A completed launch is immutable evidence, not a
 * reusable ticket for starting another provider process. */
export function validateRoleLaunchPending(options: Omit<ValidateRoleBindingOptions, "stage">): RoleValidationResult {
  const checked = validateRoleBinding({ ...options, stage: "authorization" });
  const paths = roleBindingPaths(options.project_root, options.pm_id, options.identity, checked.authorization.core.generation);
  if (existsSync(paths.launch)) throw new Error("role launch acknowledgement already exists; launch replay refused");
  return checked;
}

export interface RebindRoleAdmissionOptions {
  project_root: string;
  pm_id: string;
  identity: RoleExecutionIdentity;
  generation: number;
  expect_digest: string;
  work_id: string;
  authority_path: string;
  evidence_path: string;
  expected_branch: string;
  expected_review_sha: string;
  candidate_sha?: string | null;
  /** Identifies which close receipt is being superseded when this
   * generation carries more than one eligible receipt (W-447). Optional
   * when exactly one eligible receipt exists; ambiguity without it fails
   * closed. */
  from_candidate_sha?: string | null;
  writer: RoleBindingActor;
}

/**
 * Append an evidence-bound admission transition without replacing the immutable
 * launch authorization or close receipt. The binding digest therefore remains
 * stable while the audit chain names every authority/candidate predecessor.
 */
export function rebindRoleAdmission(options: RebindRoleAdmissionOptions): RoleAdmissionTransition {
  if (!ADMISSION_TRANSITION_WRITERS.has(options.writer.role)) {
    throw new Error(`role admission transition writer role is forbidden: ${options.writer.role}`);
  }
  if (!SHA_RE.test(options.expected_review_sha)) throw new Error("role admission rebind requires a full reviewed SHA");
  if (options.candidate_sha && !SHA_RE.test(options.candidate_sha)) {
    throw new Error("role admission rebind requires a full candidate SHA");
  }
  if (options.candidate_sha && options.candidate_sha !== options.expected_review_sha) {
    throw new Error("role admission rebind candidate SHA must equal the reviewed SHA");
  }
  if (options.from_candidate_sha && !SHA_RE.test(options.from_candidate_sha)) {
    throw new Error("role admission rebind requires a full source candidate SHA");
  }
  requireText(options.writer.id, "role admission transition writer id");
  const projectRoot = realpathSync(resolve(options.project_root));
  const rootPaths = roleBindingPaths(projectRoot, options.pm_id, options.identity);
  return withBindingLock(rootPaths.root, () => {
    const current = readCurrent(projectRoot, options.pm_id, options.identity);
    if (!current) throw new Error("no current binding exists for this role execution identity");
    if (current.generation !== options.generation || current.binding_digest !== options.expect_digest) {
      throw new Error("role admission rebind targets a superseded generation or digest");
    }
    const paths = roleBindingPaths(projectRoot, options.pm_id, options.identity, current.generation);
    const authorization = readRoleAuthorizationFile(paths.authorization);
    if (authorization.binding_id !== current.binding_id || authorization.core_digest !== current.binding_digest
      || authorization.core.generation !== current.generation
      || canonicalJson(authorization.core.execution_identity) !== canonicalJson(options.identity)) {
      throw new Error("current role binding record does not match authorization");
    }
    if (authorization.core.item.work_id !== options.work_id) {
      throw new Error(`role admission rebind work_id does not match bound work ${authorization.core.item.work_id}`);
    }
    const transitions = readAdmissionTransitions(projectRoot, options.pm_id, options.identity, current, authorization);
    validateAuthorizationSources(projectRoot, authorization, new Set(), undefined, null);
    const launch = readCanonical<RoleLaunchAcknowledgement>(paths.launch, ROLE_RECORD_KIND.launch);
    if (launch.binding_id !== current.binding_id || launch.binding_digest !== current.binding_digest
      || launch.generation !== current.generation || launch.prompt_hash !== authorization.core.sources.prompt.content_hash
      || !LAUNCH_WRITERS.has(launch.writer.role)) {
      throw new Error("role launch acknowledgement is missing, self-issued, or mismatched");
    }
    assertProviderTransportCompatible(authorization.core.routing.provider, launch.transport);

    const previousAuthority = effectiveItemAuthority(authorization, transitions);
    const authority = itemAuthoritySource(projectRoot, options.authority_path);
    if (authority.path !== previousAuthority.path) {
      throw new Error(`role admission rebind cannot change the bound authority path: ${previousAuthority.path}`);
    }
    const authorityChanged = canonicalJson(previousAuthority) !== canonicalJson(authority);
    let previousCandidateSha: string | null = null;
    let candidateSha: string | null = null;
    if (options.candidate_sha) {
      const { receipts, claims, outcomes } = readValidatedRoleCloseState(paths, current);
      const eligible = receipts.filter((receipt) => {
        const claim = claims.find((entry) => entry.receipt_id === receipt.receipt_id);
        return !claim || !outcomes.find((entry) => entry.request_id === claim.request_id)?.invalidates_close;
      });
      let fromCandidate: string;
      if (options.from_candidate_sha) {
        if (!eligible.some((receipt) => receipt.candidate_sha === options.from_candidate_sha)) {
          throw new Error(`role admission rebind source candidate does not match any eligible close receipt: ${options.from_candidate_sha}`);
        }
        fromCandidate = options.from_candidate_sha;
      } else {
        if (eligible.length === 0) throw new Error("role admission rebind found no eligible close receipt to supersede");
        if (eligible.length > 1) throw new Error("role admission rebind requires from_candidate_sha: more than one close receipt is eligible");
        fromCandidate = eligible[0].candidate_sha;
      }
      previousCandidateSha = effectiveCandidateSha(fromCandidate, transitions);
      if (previousCandidateSha !== fromCandidate) {
        throw new Error("role admission rebind source candidate is already superseded by a later transition");
      }
      candidateSha = options.candidate_sha;
      if (candidateSha === previousCandidateSha) throw new Error("role admission rebind changes no close candidate");
    }
    if (!authorityChanged && candidateSha === null) throw new Error("role admission rebind changes no authority or close candidate");
    const sequence = transitions.length + 1;
    const preparedEvidence = gateEvidence(
      projectRoot,
      options.pm_id,
      options.evidence_path,
      requireText(options.expected_branch, "role admission rebind branch"),
      options.expected_review_sha,
    );
    const evidenceSnapshotPath = admissionEvidenceSnapshotPath(
      paths.admission_transitions,
      hash(preparedEvidence.body),
    );
    writeExclusiveBytes(
      evidenceSnapshotPath,
      preparedEvidence.body,
      "role admission evidence snapshot",
    );
    const evidence: RoleGateEvidenceBinding = {
      ...preparedEvidence.evidence,
      snapshot: source(projectRoot, evidenceSnapshotPath),
    };
    const transition: RoleAdmissionTransition = {
      schema_version: 1,
      kind: ROLE_RECORD_KIND.admissionTransition,
      binding_id: current.binding_id,
      binding_digest: current.binding_digest,
      generation: current.generation,
      sequence,
      work_id: authorization.core.item.work_id,
      previous_authority: previousAuthority,
      authority,
      previous_candidate_sha: previousCandidateSha,
      candidate_sha: candidateSha,
      evidence,
      writer: options.writer,
      transitioned_at: new Date().toISOString(),
    };
    writeExclusiveCanonical(
      join(paths.admission_transitions, `${String(sequence).padStart(6, "0")}.json`),
      transition,
    );
    return transition;
  });
}

export interface CloseRoleBindingOptions {
  project_root: string; pm_id: string; identity: RoleExecutionIdentity; generation: number; expect_digest: string;
  candidate_sha: string; report_path: string; ledger_path: string; writer: RoleBindingActor;
}
export interface AdmitRoleCloseOptions extends CloseRoleBindingOptions { request_id?: string }

function sameFrozenClose(
  receipt: RoleCloseReceipt,
  candidateSha: string,
  report: RoleSourceBinding,
  checked: RoleValidationResult,
  transitions: RoleAdmissionTransition[],
): boolean {
  return effectiveCandidateSha(receipt.candidate_sha, transitions) === candidateSha
    && canonicalJson(receipt.report) === canonicalJson(report)
    && receipt.final_instruction_chain_hash === checked.final_instruction_chain_hash
    && canonicalJson(receipt.checked_source_hashes) === canonicalJson(checked.checked_source_hashes);
}

export function admitRoleClose(options: AdmitRoleCloseOptions): RoleCloseAdmission {
  if (!CLOSE_WRITERS.has(options.writer.role)) throw new Error(`role close writer role is forbidden: ${options.writer.role}`);
  if (!SHA_RE.test(options.candidate_sha)) throw new Error("role close requires a full candidate SHA");
  if (options.request_id !== undefined && !REQUEST_ID_RE.test(options.request_id)) {
    throw new Error("role close request id is malformed");
  }
  const projectRoot = realpathSync(resolve(options.project_root));
  const paths = roleBindingPaths(projectRoot, options.pm_id, options.identity, options.generation);
  return withBindingLock(paths.root, () => {
    const checked = validateRoleBinding({
      project_root: projectRoot, pm_id: options.pm_id, identity: options.identity,
      stage: "close", generation: options.generation, expected_digest: options.expect_digest,
      ledger_path: options.ledger_path,
    });
    const current = readCurrent(projectRoot, options.pm_id, options.identity)!;
    const admissionTransitions = readAdmissionTransitions(
      projectRoot, options.pm_id, options.identity, current, checked.authorization,
    );
    const report = source(projectRoot, options.report_path);
    const { receipts, claims, outcomes } = readValidatedRoleCloseState(paths, current);
    const receiptById = new Map(receipts.map((receipt) => [receipt.receipt_id, receipt]));
    const claimByRequest = new Map(claims.map((claim) => [claim.request_id, claim]));
    const claimByReceipt = new Map(claims.map((claim) => [claim.receipt_id, claim]));
    const outcomeByRequest = new Map(outcomes.map((outcome) => [outcome.request_id, outcome]));

    if (options.request_id) {
      const priorClaim = claimByRequest.get(options.request_id);
      if (priorClaim) {
        const priorReceipt = receiptById.get(priorClaim.receipt_id);
        if (!priorReceipt || !sameFrozenClose(priorReceipt, options.candidate_sha, report, checked, admissionTransitions)) {
          throw new Error("role close request replay does not match its immutable receipt");
        }
        const priorOutcome = outcomeByRequest.get(options.request_id);
        if (priorOutcome?.invalidates_close) {
          throw new Error(`role close receipt was invalidated by gate outcome ${priorOutcome.status} for ${options.request_id}`);
        }
        return {
          reference: checked.reference,
          close: { schema_version: 1, receipt_id: priorReceipt.receipt_id, request_id: options.request_id, candidate_sha: priorReceipt.candidate_sha },
        };
      }
    }

    if (outcomes.some((outcome) => outcome.status === "success")) {
      throw new Error("role close binding has a successful gate outcome and remains frozen");
    }
    const blocking = receipts.filter((receipt) => {
      const claim = claimByReceipt.get(receipt.receipt_id);
      return !claim || !outcomeByRequest.has(claim.request_id);
    });
    if (blocking.some((receipt) => effectiveCandidateSha(receipt.candidate_sha, admissionTransitions) !== options.candidate_sha)) {
      throw new Error("role candidate SHA does not match the close receipt or its admission transition chain");
    }
    if (blocking.some((receipt) => receipt.report.path !== report.path || receipt.report.content_hash !== report.content_hash)) {
      throw new Error("role report hash does not match the close receipt");
    }
    if (blocking.some((receipt) => receipt.final_instruction_chain_hash !== checked.final_instruction_chain_hash)) {
      throw new Error("role final instruction chain hash does not match the close receipt");
    }

    let receipt = blocking.find((entry) => !claimByReceipt.has(entry.receipt_id)
      && sameFrozenClose(entry, options.candidate_sha, report, checked, admissionTransitions));
    if (!receipt && !options.request_id) {
      receipt = blocking.find((entry) => sameFrozenClose(entry, options.candidate_sha, report, checked, admissionTransitions));
    }
    if (!receipt) {
      const core: Omit<RoleCloseReceipt, "receipt_id"> = {
        schema_version: 1, kind: ROLE_RECORD_KIND.close, binding_id: checked.authorization.binding_id,
        binding_digest: options.expect_digest, generation: options.generation, candidate_sha: options.candidate_sha,
        report, final_instruction_chain_hash: checked.final_instruction_chain_hash,
        checked_source_hashes: checked.checked_source_hashes, validator_version: 1,
        receipt_nonce: randomUUID(), writer: options.writer, closed_at: new Date().toISOString(),
      };
      receipt = { ...core, receipt_id: roleCloseReceiptId(core) };
      const receiptPath = existsSync(paths.close) ? join(paths.close_receipts, `${receipt.receipt_id}.json`) : paths.close;
      writeExclusiveCanonical(receiptPath, receipt);
    }

    const requestId = options.request_id;
    if (requestId) {
      const claim: RoleCloseClaim = {
        schema_version: 1, kind: ROLE_RECORD_KIND.closeClaim, binding_id: checked.authorization.binding_id,
        binding_digest: options.expect_digest, generation: options.generation, receipt_id: receipt.receipt_id,
        request_id: requestId, candidate_sha: receipt.candidate_sha, writer: options.writer,
        claimed_at: new Date().toISOString(),
      };
      writeExclusiveCanonical(join(paths.close_claims, `${requestId}.json`), claim);
      return {
        reference: checked.reference,
        close: { schema_version: 1, receipt_id: receipt.receipt_id, request_id: requestId, candidate_sha: receipt.candidate_sha },
      };
    }
    return {
      reference: checked.reference,
      close: { schema_version: 1, receipt_id: receipt.receipt_id, request_id: "unclaimed", candidate_sha: receipt.candidate_sha },
    };
  });
}

export function closeRoleBinding(options: CloseRoleBindingOptions): RoleCloseReceipt {
  const admission = admitRoleClose(options);
  const paths = roleBindingPaths(options.project_root, options.pm_id, options.identity, options.generation);
  const receipt = readRoleCloseReceipts(paths).find((entry) => entry.receipt_id === admission.close.receipt_id);
  if (!receipt) throw new Error("role close receipt disappeared after creation");
  return receipt;
}

export interface RecordRoleCloseGateOutcomeOptions {
  project_root: string; pm_id: string; identity: RoleExecutionIdentity;
  generation: number; expect_digest: string; close_reference: RoleCloseReference;
  request_id: string; status: RoleCloseGateStatus; failure_reason?: string | null; writer: RoleBindingActor;
}
export function recordRoleCloseGateOutcome(options: RecordRoleCloseGateOutcomeOptions): RoleCloseGateOutcome {
  if (!CLOSE_GATE_WRITERS.has(options.writer.role)) throw new Error(`role close gate-outcome writer role is forbidden: ${options.writer.role}`);
  const statuses: RoleCloseGateStatus[] = ["success", "failed", "conflict", "aborted", "stale_base", "environment_blocked"];
  if (!statuses.includes(options.status)) throw new Error("role close gate outcome status is malformed");
  if (!REQUEST_ID_RE.test(options.request_id) || options.request_id !== options.close_reference.request_id) {
    throw new Error("role close gate outcome request id is malformed or mismatched");
  }
  const projectRoot = realpathSync(resolve(options.project_root));
  const paths = roleBindingPaths(projectRoot, options.pm_id, options.identity, options.generation);
  return withBindingLock(paths.root, () => {
    const authorization = readRoleAuthorizationFile(paths.authorization);
    if (authorization.core_digest !== options.expect_digest || authorization.core.generation !== options.generation
      || canonicalJson(authorization.core.execution_identity) !== canonicalJson(options.identity)) {
      throw new Error("role close gate outcome does not match authorization");
    }
    const receipts = readRoleCloseReceipts(paths);
    const receipt = receipts.find((entry) => entry.receipt_id === options.close_reference.receipt_id);
    const claim = readRoleCloseClaims(paths).find((entry) => entry.request_id === options.request_id);
    if (!receipt || !claim || claim.receipt_id !== receipt.receipt_id
      || claim.candidate_sha !== options.close_reference.candidate_sha) {
      throw new Error("role close gate outcome does not match the canonical receipt claim");
    }
    const outcome: RoleCloseGateOutcome = {
      schema_version: 1, kind: ROLE_RECORD_KIND.closeGateOutcome, binding_id: authorization.binding_id,
      binding_digest: options.expect_digest, generation: options.generation, receipt_id: receipt.receipt_id,
      request_id: options.request_id, candidate_sha: receipt.candidate_sha, status: options.status,
      invalidates_close: options.status !== "success", failure_reason: options.failure_reason?.trim() || null,
      writer: options.writer, ended_at: new Date().toISOString(),
    };
    writeExclusiveCanonical(join(paths.close_gate_outcomes, `${options.request_id}.json`), outcome);
    return outcome;
  });
}
