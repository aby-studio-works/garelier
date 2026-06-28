// Parse __garelier/<pm_id>/_pm/setup_config.toml. Schema matches what the PM
// setup wizard generates.
//
// v2.1: pm_id is required to locate the per-PM tree. The caller resolves
// pm_id from one of (in priority order):
//   1. --pm-id <id>          CLI flag
//   2. GARELIER_PM_ID       env var
//   3. cwd path inference    (if cwd is inside __garelier/<pm_id>/...)
// and passes it to loadConfig().

import { parse } from "smol-toml";
import { readFileSync, existsSync } from "node:fs";
import {
  type OutputControlConfig,
  type OutputProfileName,
  type OutputProfileConfig,
  OUTPUT_PROFILE_NAMES,
  OUTPUT_CONTROL_ROLES,
  DEFAULT_OUTPUT_CONTROL,
  DEFAULT_OUTPUT_PROFILES,
  DEFAULT_OUTPUT_ROLES,
} from "./output_control.ts";

export interface ProjectConfig {
  name: string;
  initializedAt?: string;
  garelierVersion?: string;
}

export interface BranchConfig {
  target: string;
  targetSlug: string;
  integration: string;
}

export interface AgentDef {
  id: string;
  provider: ProviderKind;
  model: string;
  effort?: string;
  // Per-agent spawn-command override (DEC-026). Highest-priority resolution
  // for this agent's provider CLI; else GARELIER_PROVIDER_<KIND>_CMD env, else
  // the legacy shared GARELIER_SPAWN_CMD, else the adapter default.
  providerCommand?: string[];
  worktree: string;
  // DEC-021: read-only roles (scouts/observers) may run WITHOUT a worktree
  // when false — they read source via `git show <sha>:<path>` / `git grep
  // <sha>` against a fixed SHA instead of a checkout. Commit roles are always
  // true. Default true.
  checkout: boolean;
}

export type ProviderKind =
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"
  | "copilot-cli"
  | "cursor-cli";

// Artisan (artisan lane, DEC-017 / DEC-045). Singleton: one Artisan performs the
// whole dock-lane scope by itself on a `satchel` branch and integrates it into
// studio after Guardian + Observer. Mutually exclusive with the dock
// lane (runtime/lane.lock). `undefined` when [artisan] enabled != true.
export interface ArtisanConfig {
  id: string;
  provider: ProviderKind;
  model: string;
  effort?: string;
  worktree: string;
  branchNamespace: string;
}

// Observer (read-only review/advice sidecar, DEC-019). Commit-free; never
// takes lane.lock; allowed in both lanes. `enabled` defaults true; disabled
// observers are dropped at load. May carry a specialty (security/architecture/
// test/docs) and the set of request kinds it accepts.
export interface ObserverConfig extends AgentDef {
  specialty?: string;
  allowedRequestKinds: string[];
}

// When Observer review is mandatory and how it behaves ([observer_policy]).
export interface ObserverPolicyConfig {
  enabled: boolean;
  requireForAllMerges: boolean;
  requireForArtisanPremerge: boolean;
  requireForLargeDiff: boolean;
  largeDiffLines: number;
  requireForProtectedPaths: boolean;
  requireForPublicApiChange: boolean;
  requireForMigration: boolean;
  requireForAuthSecurity: boolean;
  allowWorkerDirectionRequest: boolean;
  maxParallelRequests: number;
  adviceIsBinding: boolean;
}

export const OBSERVER_REQUEST_KINDS = [
  "merge_review",
  "artisan_premerge_review",
  "direction_advice",
  "architecture_risk_review",
  "policy_consistency_review",
] as const;

// Guardian (security/privacy/dependency/license gate, DEC-024). Commit-free;
// `enabled` defaults true; disabled guardians are dropped at load.
export interface GuardianConfig extends AgentDef {
  specialty?: string;
  allowedRequestKinds: string[];
}

// When a Guardian gate is mandatory and how it blocks ([guardian_policy]).
export interface GuardianPolicyConfig {
  enabled: boolean;
  requireForAllMerges: boolean;
  branchNamespace: string;
  requireDeltaBeforeObserver: boolean;
  requireFinalBeforeMerge: boolean;
  requireForArtisanPremerge: boolean;
  requireForPromote: boolean;
  requireForDependencyChanges: boolean;
  requireForLockfileChanges: boolean;
  requireForAuthSecurity: boolean;
  requireForConfigInfraCiDeploy: boolean;
  requireForProtectedPaths: boolean;
  blockOnSecret: boolean;
  blockOnPii: boolean;
  blockOnCustomerData: boolean;
  blockOnPrivateKey: boolean;
  blockOnCriticalVulnerability: boolean;
  blockOnHighVulnerability: boolean;
  blockOnForbiddenLicense: boolean;
  blockOnUnknownLicense: boolean;
  blockWhenRequiredScannerUnavailable: boolean;
  redactEvidence: boolean;
  forbidSecretValueInReport: boolean;
  securitySensitivePaths: string[];
  packageFiles: string[];
}

export const GUARDIAN_REQUEST_KINDS = [
  "preflight",
  "delta_gate",
  "final_gate",
  "promote_gate",
  "knowledge_update_request",
] as const;

// Concierge (catch-all external-operations executor, DEC-025). Commit-bearing
// for the operations it runs (e.g. a promote merge + tag) but never implements
// source; `enabled` defaults true; disabled ones are dropped at load. Always
// has a worktree (`checkout = true`) — external operations need live git state.
export interface ConciergeConfig extends AgentDef {
  allowedOperationKinds: string[];
}

// When/how a Concierge external operation is gated ([concierge_policy]).
export interface ConciergePolicyConfig {
  enabled: boolean;
  branchNamespace: string;
  requirePmApproval: boolean;
  requireUserInstructionForWrite: boolean;
  requireLibrarianPolicySources: boolean;
  requireGuardianBeforeExternalWrite: boolean;
  requireExternalLock: boolean;
  forbidPushGarelierBranches: boolean;
  forbidForcePush: boolean;
  forbidBlindGitPull: boolean;
  redactSensitiveOutput: boolean;
  allowedExternalBranchPrefixes: string[];
  requiredKnowledgePaths: string[];
}

// All operation kinds a Concierge can be granted. Phase 1 enables the first
// two; the rest are Phase 2 (default-disabled by policy) — DEC-025.
export const CONCIERGE_OPERATION_KINDS = [
  "promote_target",
  "sync_remote",
  "create_pr",
  "update_pr",
  "close_pr",
  "create_ticket",
  "update_ticket",
  "close_ticket",
  "create_release",
  "update_release",
  "publish_artifact",
  "check_external_ci",
] as const;

// Least-privilege default per Concierge: only the Phase 1 operations.
export const CONCIERGE_PHASE1_OPERATION_KINDS = [
  "promote_target",
  "sync_remote",
] as const;

export interface RunnerDef {
  provider: ProviderKind;
  model?: string;
  effort?: string;
}

export interface RunnerConfig {
  pm: RunnerDef;
  dock: RunnerDef;
  defaultAgent: RunnerDef;
}

export interface AutonomyConfig {
  enabled: boolean;
  autoApproveBlueprints: boolean;
  autoApproveMilestones: boolean;
  // Max parallel producer subagents per Mode-D tick (replaces the retired DEC-027
  // lease counter; a convention, not an enforced lease).
  fanOutCap: number;
  // Glob set of engine-core / protected paths that HARD-gate to the human PM in
  // Mode D (the gate detector parks a thread whose change would touch these).
  protectedPaths: string[];
}

// Detached roles the concurrency cap schedules (DEC-027 / DEC-031). PM and Dock
// are foreground and never capped/counted.
export const DETACHED_ROLES = [
  "artisan", "concierge", "guardian", "smith", "observer", "worker", "librarian", "scout",
] as const;

// Default priority TIERS (DEC-031), highest first. NOTE: "tier" is the launch
// PRIORITY ordering — distinct from the artisan/dock execution LANES (DEC
// 0017, mutual exclusion). Within a tier, the longest-waiting agent runs first
// (FIFO). PM/Dock/merge-gate are uncapped and not listed.
//
// Above ALL of these sits a RESERVED "urgent" lane (normally empty): a per-task
// `urgent.md` marker (PM/Dock-written for a user "do this first") promotes
// that one instance above every role tier — so it never competes with the gate
// tier and never preempts (running agents finish; it takes the next free slot).
// The role tiers below are:
//   gates       — concierge/guardian/observer: external + safety + review that
//                 UNBLOCK the pipeline / that the user is waiting on. Fixed top.
//   smith,librarian   — hardening + knowledge (Dock-reorderable).
//   worker,scout,artisan — producers. Worker/Scout (dock lane) FIFO when both
//                 run; Artisan (its own lane) never competes with them, so all
//                 three share one tier. Worker/Scout are reorderable; Artisan is not.
//   []          — a RESERVED empty bottom tier: Dock can DEMOTE a producer
//                 into it at runtime (e.g. park Smith below the Workers while they
//                 finish a big batch, then restore it) via the tier-order hint.
export const DEFAULT_CONCURRENCY_TIERS: string[][] = [
  ["concierge", "guardian", "observer"],
  ["smith", "librarian"],
  ["worker", "scout", "artisan"],
  [],
];

// The dock-lane producer roles Dock dispatches and may reprioritize at
// runtime (DEC-031). The gate tier (top) and artisan (bottom) are FIXED — gates
// are PM/gate-dispatched and artisan is PM-dispatched, not Dock's to reorder.
export const DOCK_REORDERABLE_ROLES = ["smith", "librarian", "worker", "scout"] as const;

// [concurrency]: a memory bound on concurrent detached provider children +
// priority tiers + FIFO-within-tier + anti-starvation aging. All fields optional.
export interface ConcurrencyConfig {
  // Max detached provider CLI children alive at once across ALL detached roles.
  // 0 = unlimited. Default 4.
  maxConcurrentAgents: number;
  // Priority tiers (DEC-031), highest first; each tier is a group of co-equal
  // roles. Unknown role names are dropped; any missing detached role is appended
  // to the last tier so it always has SOME tier.
  tiers: string[][];
  // A candidate deferred (eligible but no slot) for >= this many consecutive
  // cycles is promoted to the front this cycle — the cross-tier starvation
  // breaker so a low tier cannot be starved by saturated upper tiers. 0 =
  // disabled (pure tier order). Default 3.
  starvationCycles: number;
}

// Read-only Status Web Console settings ([status_web]).
export interface StatusWebConfig {
  enabled: boolean;
  host: string;
  port: number;
  autoRefreshSeconds: number;
  readOnly: boolean;
  showSourceUrls: boolean;
}

export interface SetupComplete {
  complete: boolean;
  completedAt?: string;
  wizardVersion?: string;
}

export interface QualityGateConfig {
  // Project stack the gate targets (rust | typescript | python | go | mixed
  // | custom). Informational + drives the default command set when commands
  // are not explicitly listed. Garelier targets any large app, not just Rust.
  stack?: string;
  // Commands run by merge-gate.sh after `git merge --no-ff --no-commit`.
  // Each command is a single shell line. Failure of any aborts the merge.
  // Back-compat alias for `fullCommands`.
  commands: string[];
  // Fast commands are for bounded implementation batches. They may be empty.
  fastCommands: string[];
  // Full commands are authoritative for merge/promote/reporting gates.
  fullCommands: string[];
  // Back-compat alias for `fullTimeoutMinutesPerCmd`.
  timeoutMinutesPerCmd: number;
  fastTimeoutMinutesPerCmd: number;
  fullTimeoutMinutesPerCmd: number;
  // Deterministic auto-FIX commands (formatters: `cargo fmt --all`, `gofmt -w`,
  // `ruff format`). A producer runs these ONCE before the check gate so a
  // formatting nit is fixed at the source instead of failing the (expensive)
  // merge gate and forcing a rework cycle. The driver also grants these to the
  // producer's allowedTools (DEC-049 C1). Empty = no autofix for this stack.
  autofixCommands: string[];
}

// Default quality-gate command sets per stack. Used only when [quality_gate]
// lists no explicit commands. `mixed` and `custom` intentionally have no
// default — the project must spell out commands (the wizard/doctor enforce
// that `custom` is non-empty before setup is considered complete).
export const STACK_QUALITY_GATES: Record<string, string[]> = {
  rust: [
    "cargo check --workspace",
    "cargo test --workspace",
    "cargo clippy --workspace -- -D warnings",
  ],
  typescript: ["npm ci", "npm run typecheck", "npm test", "npm run lint"],
  python: ["python -m pip install -e .", "ruff check .", "pytest"],
  go: ["go build ./...", "go vet ./...", "go test ./..."],
  mixed: [],
  custom: [],
};

// Default deterministic auto-FIX (formatter WRITE) commands per stack (DEC-049
// C1). The producer runs these before its check gate and they are granted to its
// allowedTools. Only well-known deterministic formatters are defaulted;
// typescript varies (prettier / biome / eslint --fix) so it must be declared.
export const STACK_AUTOFIX: Record<string, string[]> = {
  rust: ["cargo fmt --all"],
  typescript: [],
  python: ["ruff format ."],
  go: ["go fmt ./..."],
  mixed: [],
  custom: [],
};

// Permission profile (how much autonomy the provider CLI is granted).
// `dangerous` is the old always-full-access behavior; it must be explicit
// opt-in. Default is `reviewed`.
export type PermissionProfile = "safe" | "reviewed" | "dangerous";

// `profile` is the only driver-ENFORCED field (it sets the provider permission
// args — claude/codex sandbox + approval flags). The rest are POLICY VALUES the
// driver only RECORDS; they take effect only when surfaced to agents
// (AGENTS.md / role skills) or fed to the Guardian gate — the driver does not
// itself block on them. Honest current state: requirePmApprovalPaths IS consumed
// by the Guardian/Observer policy check; allowNetwork / allowDestructiveCommands /
// allowSecretRead / forbiddenPaths are ADVISORY-ONLY today (not yet wired into the
// AGENTS.md template or Guardian — roadmap), so do not rely on them as hard
// controls.
export interface PermissionConfig {
  profile: PermissionProfile;
  allowNetwork: boolean;             // advisory-only (recorded; not gate-enforced yet)
  allowDestructiveCommands: boolean; // advisory-only (recorded; not gate-enforced yet)
  allowSecretRead: boolean;          // advisory-only (recorded; not gate-enforced yet)
  // Glob paths that require PM approval before an agent writes them.
  // Consumed by the Guardian/Observer policy check.
  requirePmApprovalPaths: string[];
  // Glob paths agents must never read or write. Advisory-only today (recorded;
  // not yet enforced by the gate) — wiring tracked on the roadmap.
  forbiddenPaths: string[];
}

// DEC-062 Mode E "Jig" — DEFAULT ON since 2026-06-11 (operator decision):
// an absent [jig] block or absent `enabled` key means ENABLED; `enabled =
// false` is the explicit opt-out (the Mode D prose tick then operates).
// Unknown review_depth values fall back to the DEC-062 defaults.
export type JigReviewDepth = "gate" | "gate+refute" | "nversion";
export interface JigConfig {
  enabled: boolean;
  fanOutCap: number;
  maxReworkRounds: number;
  criticalProducers: number;
  // DEC-069: a Smith window-hardening batch becomes due after this many
  // merges into studio since the last hardened tip (0 = disabled).
  smithBatchEvery: number;
  reviewDepth: { low: JigReviewDepth; normal: JigReviewDepth; critical: JigReviewDepth };
}
const JIG_DEPTHS = new Set(["gate", "gate+refute", "nversion"]);
export function normalizeJig(v: unknown): JigConfig {
  const j = (v ?? {}) as Record<string, unknown>;
  const rd = (j.review_depth ?? {}) as Record<string, unknown>;
  const depth = (x: unknown, dflt: JigReviewDepth): JigReviewDepth =>
    typeof x === "string" && JIG_DEPTHS.has(x) ? (x as JigReviewDepth) : dflt;
  const num = (x: unknown, dflt: number): number =>
    typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : dflt;
  return {
    enabled: j.enabled !== false, // default ON (opt-out)
    fanOutCap: num(j.fan_out_cap, 3),
    maxReworkRounds: num(j.max_rework_rounds, 2),
    criticalProducers: num(j.critical_producers, 3),
    // 0 disables; any other non-finite/negative input falls back to 5.
    smithBatchEvery: j.smith_batch_every === 0 ? 0 : num(j.smith_batch_every, 5),
    reviewDepth: {
      low: depth(rd.low, "gate"),
      normal: depth(rd.normal, "gate+refute"),
      critical: depth(rd.critical, "nversion"),
    },
  };
}

export interface SetupConfig {
  pmId: string;
  project: ProjectConfig;
  branches: BranchConfig;
  runner: RunnerConfig;
  workers: AgentDef[];
  scouts: AgentDef[];
  smiths: AgentDef[];
  librarians: AgentDef[];
  observers: ObserverConfig[];
  observerPolicy: ObserverPolicyConfig;
  guardians: GuardianConfig[];
  guardianPolicy: GuardianPolicyConfig;
  concierges: ConciergeConfig[];
  conciergePolicy: ConciergePolicyConfig;
  artisan?: ArtisanConfig;
  defaultLane: "dock" | "artisan";
  autonomy: AutonomyConfig;
  jig: JigConfig;
  concurrency: ConcurrencyConfig;
  outputControl: OutputControlConfig;
  qualityGate: QualityGateConfig;
  statusWeb: StatusWebConfig;
  permissions: PermissionConfig;
  setup?: SetupComplete;
}

export class ConfigError extends Error {}

// pm_id format per DEC-006 §2.6, plus the single-user default `_workshop`
// established by DEC-044. `_workshop` is legal in both full and starter mode.
const PM_ID_RE = /^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$/;

export function validatePmId(pmId: string): void {
  if (pmId !== "_workshop" && !PM_ID_RE.test(pmId)) {
    throw new ConfigError(
      `invalid pm_id "${pmId}": must be "_workshop" or match ${PM_ID_RE.source} ` +
      `(1-20 chars, lowercase ASCII + digits + internal hyphens or underscores, git-ref-safe)`,
    );
  }
}

export function loadConfig(projectRoot: string, pmId: string): SetupConfig {
  validatePmId(pmId);
  const path = `${projectRoot}/__garelier/${pmId}/_pm/setup_config.toml`;
  if (!existsSync(path)) {
    throw new ConfigError(`setup_config.toml not found at ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (e) {
    throw new ConfigError(`failed to parse ${path}: ${(e as Error).message}`);
  }
  return normalize(parsed as Record<string, unknown>, path, pmId);
}

function normalizeQualityGate(raw: unknown): QualityGateConfig {
  // No Rust assumption. Explicit commands win; otherwise fall back to the
  // declared stack's default set; otherwise empty (the dispatching Dock
  // can still pass commands in the merge-request JSON).
  const qg = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  const fast = (qg.fast && typeof qg.fast === "object") ? (qg.fast as Record<string, unknown>) : {};
  const full = (qg.full && typeof qg.full === "object") ? (qg.full as Record<string, unknown>) : {};
  const stack = typeof qg.stack === "string" && qg.stack.trim() !== ""
    ? qg.stack.trim().toLowerCase()
    : undefined;
  const commandList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).filter((s) => s.trim().length > 0) : [];
  const explicit = commandList(qg.commands);
  const fastCommands = commandList(fast.commands);
  const explicitFull = commandList(full.commands);
  const stackDefault = stack && stack in STACK_QUALITY_GATES ? STACK_QUALITY_GATES[stack] : [];
  const fullCommands = explicitFull.length > 0
    ? explicitFull
    : explicit.length > 0
    ? explicit
    : stackDefault;
  const timeout = (obj: Record<string, unknown>, key: string, fallback: number): number =>
    typeof obj[key] === "number" ? Number(obj[key]) : fallback;
  const legacyTimeout = timeout(qg, "timeout_minutes_per_cmd", 120);
  const fastTimeout = timeout(fast, "timeout_minutes_per_cmd", 10);
  const fullTimeout = timeout(full, "timeout_minutes_per_cmd", legacyTimeout);
  // Autofix: a PRESENT commands key (`autofix = [...]` array form, or
  // `[quality_gate.autofix] commands = [...]`) is AUTHORITATIVE even when empty —
  // `commands = []` explicitly DISABLES autofix. Only its ABSENCE falls back to
  // the stack default. (The template ships the section fully commented so the
  // default applies until the operator opts in/out.)
  const autofixObj = (qg.autofix && typeof qg.autofix === "object" && !Array.isArray(qg.autofix))
    ? (qg.autofix as Record<string, unknown>)
    : {};
  const autofixKeyPresent = Array.isArray(qg.autofix) || autofixObj.commands !== undefined;
  const autofixCommands = autofixKeyPresent
    ? commandList(Array.isArray(qg.autofix) ? qg.autofix : autofixObj.commands)
    : (stack && stack in STACK_AUTOFIX ? STACK_AUTOFIX[stack] : []);
  return {
    stack,
    commands: fullCommands,
    fastCommands,
    fullCommands,
    timeoutMinutesPerCmd: fullTimeout,
    fastTimeoutMinutesPerCmd: fastTimeout,
    fullTimeoutMinutesPerCmd: fullTimeout,
    autofixCommands,
  };
}

function normalize(raw: Record<string, unknown>, path: string, pmId: string): SetupConfig {
  const project = (raw.project ?? {}) as Record<string, unknown>;
  const branches = (raw.branches ?? {}) as Record<string, unknown>;
  const runnerRaw = (raw.runner ?? {}) as Record<string, unknown>;
  const autonomy = (raw.autonomy ?? {}) as Record<string, unknown>;
  const setup = raw.setup as Record<string, unknown> | undefined;

  if (!project.name) throw new ConfigError(`${path}: [project] name missing`);
  if (!branches.target) throw new ConfigError(`${path}: [branches] target missing`);
  if (!branches.integration) throw new ConfigError(`${path}: [branches] integration missing`);

  const runner = normalizeRunner(runnerRaw, path);

  const workers = normalizeAgents(raw.workers, "workers", "_workers", path, pmId, runner);
  const scouts = normalizeAgents(raw.scouts, "scouts", "_scouts", path, pmId, runner);
  const smiths = normalizeAgents(raw.smiths, "smiths", "_smiths", path, pmId, runner);
  // Librarians carry an `enabled` flag (default true); skip disabled ones.
  const rawLibrarians = Array.isArray(raw.librarians)
    ? (raw.librarians as Array<Record<string, unknown>>).filter((l) => l.enabled !== false)
    : [];
  const librarians = normalizeAgents(rawLibrarians, "librarians", "_librarians", path, pmId, runner);
  // Observers carry an `enabled` flag (default true); skip disabled ones.
  const rawObservers = Array.isArray(raw.observers)
    ? (raw.observers as Array<Record<string, unknown>>).filter((o) => o.enabled !== false)
    : [];
  const observersBase = normalizeAgents(rawObservers, "observers", "_observers", path, pmId, runner);
  const observers: ObserverConfig[] = observersBase.map((a, i) => {
    const o = rawObservers[i];
    const kinds = Array.isArray(o.allowed_request_kinds)
      ? (o.allowed_request_kinds as unknown[]).map(String).filter((k) => k.trim() !== "")
      : [];
    return {
      ...a,
      specialty: typeof o.specialty === "string" && o.specialty.trim() !== ""
        ? String(o.specialty).trim()
        : undefined,
      allowedRequestKinds: kinds.length > 0 ? kinds : [...OBSERVER_REQUEST_KINDS],
    };
  });
  const observerPolicy = normalizeObserverPolicy(raw.observer_policy, observers.length > 0);
  // Guardians carry an `enabled` flag (default true); skip disabled ones (DEC-024).
  const rawGuardians = Array.isArray(raw.guardians)
    ? (raw.guardians as Array<Record<string, unknown>>).filter((g) => g.enabled !== false)
    : [];
  const guardiansBase = normalizeAgents(rawGuardians, "guardians", "_guardians", path, pmId, runner);
  const guardians: GuardianConfig[] = guardiansBase.map((a, i) => {
    const g = rawGuardians[i];
    const kinds = Array.isArray(g.allowed_request_kinds)
      ? (g.allowed_request_kinds as unknown[]).map(String).filter((k) => k.trim() !== "")
      : [];
    return {
      ...a,
      specialty: typeof g.specialty === "string" && g.specialty.trim() !== ""
        ? String(g.specialty).trim()
        : undefined,
      allowedRequestKinds: kinds.length > 0 ? kinds : [...GUARDIAN_REQUEST_KINDS],
    };
  });
  const guardianPolicy = normalizeGuardianPolicy(raw.guardian_policy, guardians.length > 0);
  // Concierges carry an `enabled` flag (default true); skip disabled ones (DEC-025).
  const rawConcierges = Array.isArray(raw.concierges)
    ? (raw.concierges as Array<Record<string, unknown>>).filter((c) => c.enabled !== false)
    : [];
  const conciergesBase = normalizeAgents(rawConcierges, "concierges", "_concierges", path, pmId, runner);
  const concierges: ConciergeConfig[] = conciergesBase.map((a, i) => {
    const c = rawConcierges[i];
    const kinds = Array.isArray(c.allowed_operation_kinds)
      ? (c.allowed_operation_kinds as unknown[]).map(String).filter((k) => k.trim() !== "")
      : [];
    return {
      ...a,
      // Concierge always has a worktree — external operations need live git state.
      checkout: true,
      allowedOperationKinds: kinds.length > 0 ? kinds : [...CONCIERGE_PHASE1_OPERATION_KINDS],
    };
  });
  const conciergePolicy = normalizeConciergePolicy(raw.concierge_policy, concierges.length > 0);
  const artisan = normalizeArtisan(raw.artisan, path, pmId, runner);

  return {
    pmId,
    project: {
      name: String(project.name),
      initializedAt: project.initialized_at ? String(project.initialized_at) : undefined,
      garelierVersion: project.garelier_version ? String(project.garelier_version) : undefined,
    },
    branches: {
      target: String(branches.target),
      targetSlug: String(branches.target_slug ?? String(branches.target).replace(/\//g, "-")),
      integration: String(branches.integration),
    },
    runner,
    workers,
    scouts,
    smiths,
    librarians,
    observers,
    observerPolicy,
    guardians,
    guardianPolicy,
    concierges,
    conciergePolicy,
    artisan,
    defaultLane: normalizeDefaultLane(raw.lanes, path),
    autonomy: {
      enabled: autonomy.enabled === true,
      autoApproveBlueprints: autonomy.auto_approve_blueprints === true,
      autoApproveMilestones: autonomy.auto_approve_milestones === true,
      // Driver-era keys (driver_poll_interval_seconds / supervise_pm / mode)
      // were deleted with the driver (DEC-066); old configs carrying them are
      // simply ignored.
      fanOutCap: typeof autonomy.fan_out_cap === "number" && autonomy.fan_out_cap > 0
        ? autonomy.fan_out_cap
        : 3,
      protectedPaths: Array.isArray(autonomy.protected_paths)
        ? autonomy.protected_paths.filter((x): x is string => typeof x === "string")
        : [],
    },
    jig: normalizeJig(raw.jig),
    concurrency: normalizeConcurrency(raw.concurrency),
    outputControl: normalizeOutputControl(raw.output_control, path),
    qualityGate: normalizeQualityGate(raw.quality_gate),
    statusWeb: normalizeStatusWeb(raw.status_web),
    permissions: normalizePermissions(raw.permissions),
    setup: setup
      ? {
          complete: setup.complete === true,
          completedAt: setup.completed_at ? String(setup.completed_at) : undefined,
          wizardVersion: setup.wizard_version ? String(setup.wizard_version) : undefined,
        }
      : undefined,
  };
}

function normalizeAgents(
  rawAgents: unknown,
  section: "workers" | "scouts" | "smiths" | "librarians" | "observers" | "guardians" | "concierges",
  dirName: "_workers" | "_scouts" | "_smiths" | "_librarians" | "_observers" | "_guardians" | "_concierges",
  path: string,
  pmId: string,
  runner: RunnerConfig,
): AgentDef[] {
  return ((rawAgents ?? []) as Array<Record<string, unknown>>).map((agent, i) => {
    if (!agent.id) throw new ConfigError(`${path}: [[${section}]][${i}] id missing`);
    const provider = normalizeProvider(
      agent.provider,
      `${path}: [[${section}]][${i}] provider`,
      runner.defaultAgent.provider,
    );
    const inheritedModel = provider === runner.defaultAgent.provider ? runner.defaultAgent.model : undefined;
    return {
      id: String(agent.id),
      provider,
      model: normalizeModel(agent.model, provider) ?? inheritedModel ?? "",
      effort: normalizeEffort(agent.effort) ?? runner.defaultAgent.effort,
      providerCommand: normalizeProviderCommand(agent.provider_command),
      worktree: String(agent.worktree ?? `__garelier/${pmId}/${dirName}/${agent.id}`),
      // DEC-021: default true; only scouts/observers honor `checkout = false`.
      checkout: typeof agent.checkout === "boolean" ? agent.checkout : true,
    };
  });
}

function normalizeObserverPolicy(raw: unknown, defaultEnabled = false): ObserverPolicyConfig {
  const d: ObserverPolicyConfig = {
    enabled: defaultEnabled,
    requireForAllMerges: false,
    requireForArtisanPremerge: true,
    requireForLargeDiff: true,
    largeDiffLines: 800,
    requireForProtectedPaths: true,
    requireForPublicApiChange: true,
    requireForMigration: true,
    requireForAuthSecurity: true,
    allowWorkerDirectionRequest: true,
    maxParallelRequests: 1,
    adviceIsBinding: false,
  };
  if (!raw || typeof raw !== "object") return d;
  const p = raw as Record<string, unknown>;
  const bool = (v: unknown, dv: boolean) => (typeof v === "boolean" ? v : dv);
  const num = (v: unknown, dv: number) => (typeof v === "number" ? v : dv);
  return {
    enabled: bool(p.enabled, d.enabled),
    requireForAllMerges: bool(p.require_for_all_merges, d.requireForAllMerges),
    requireForArtisanPremerge: bool(p.require_for_artisan_premerge, d.requireForArtisanPremerge),
    requireForLargeDiff: bool(p.require_for_large_diff, d.requireForLargeDiff),
    largeDiffLines: num(p.large_diff_lines, d.largeDiffLines),
    requireForProtectedPaths: bool(p.require_for_protected_paths, d.requireForProtectedPaths),
    requireForPublicApiChange: bool(p.require_for_public_api_change, d.requireForPublicApiChange),
    requireForMigration: bool(p.require_for_migration, d.requireForMigration),
    requireForAuthSecurity: bool(p.require_for_auth_security, d.requireForAuthSecurity),
    allowWorkerDirectionRequest: bool(p.allow_worker_direction_request, d.allowWorkerDirectionRequest),
    maxParallelRequests: num(p.max_parallel_requests, d.maxParallelRequests),
    adviceIsBinding: bool(p.advice_is_binding, d.adviceIsBinding),
  };
}

function normalizeGuardianPolicy(raw: unknown, defaultEnabled = false): GuardianPolicyConfig {
  const d: GuardianPolicyConfig = {
    enabled: defaultEnabled,
    requireForAllMerges: false,
    branchNamespace: "gavel",
    requireDeltaBeforeObserver: true,
    requireFinalBeforeMerge: true,
    requireForArtisanPremerge: true,
    requireForPromote: true,
    requireForDependencyChanges: true,
    requireForLockfileChanges: true,
    requireForAuthSecurity: true,
    requireForConfigInfraCiDeploy: true,
    requireForProtectedPaths: true,
    blockOnSecret: true,
    blockOnPii: true,
    blockOnCustomerData: true,
    blockOnPrivateKey: true,
    blockOnCriticalVulnerability: true,
    blockOnHighVulnerability: true,
    blockOnForbiddenLicense: true,
    blockOnUnknownLicense: false,
    blockWhenRequiredScannerUnavailable: true,
    redactEvidence: true,
    forbidSecretValueInReport: true,
    securitySensitivePaths: [".env*", "**/*.pem", "**/*.key", "**/*secret*", "**/*credential*", "infra/**", "deploy/**", ".github/workflows/**", "migrations/**"],
    packageFiles: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.toml", "Cargo.lock", "requirements.txt", "pyproject.toml", "poetry.lock", "go.mod", "go.sum"],
  };
  if (!raw || typeof raw !== "object") return d;
  const p = raw as Record<string, unknown>;
  const bool = (v: unknown, dv: boolean) => (typeof v === "boolean" ? v : dv);
  const strArr = (v: unknown, dv: string[]) => {
    const paths = v && typeof v === "object" ? (v as { paths?: unknown }).paths : undefined;
    return Array.isArray(paths) ? paths.map(String) : dv;
  };
  return {
    enabled: bool(p.enabled, d.enabled),
    requireForAllMerges: bool(p.require_for_all_merges, d.requireForAllMerges),
    branchNamespace: typeof p.branch_namespace === "string" ? p.branch_namespace : d.branchNamespace,
    requireDeltaBeforeObserver: bool(p.require_delta_before_observer, d.requireDeltaBeforeObserver),
    requireFinalBeforeMerge: bool(p.require_final_before_merge, d.requireFinalBeforeMerge),
    requireForArtisanPremerge: bool(p.require_for_artisan_premerge, d.requireForArtisanPremerge),
    requireForPromote: bool(p.require_for_promote, d.requireForPromote),
    requireForDependencyChanges: bool(p.require_for_dependency_changes, d.requireForDependencyChanges),
    requireForLockfileChanges: bool(p.require_for_lockfile_changes, d.requireForLockfileChanges),
    requireForAuthSecurity: bool(p.require_for_auth_security, d.requireForAuthSecurity),
    requireForConfigInfraCiDeploy: bool(p.require_for_config_infra_ci_deploy, d.requireForConfigInfraCiDeploy),
    requireForProtectedPaths: bool(p.require_for_protected_paths, d.requireForProtectedPaths),
    blockOnSecret: bool(p.block_on_secret, d.blockOnSecret),
    blockOnPii: bool(p.block_on_pii, d.blockOnPii),
    blockOnCustomerData: bool(p.block_on_customer_data, d.blockOnCustomerData),
    blockOnPrivateKey: bool(p.block_on_private_key, d.blockOnPrivateKey),
    blockOnCriticalVulnerability: bool(p.block_on_critical_vulnerability, d.blockOnCriticalVulnerability),
    blockOnHighVulnerability: bool(p.block_on_high_vulnerability, d.blockOnHighVulnerability),
    blockOnForbiddenLicense: bool(p.block_on_forbidden_license, d.blockOnForbiddenLicense),
    blockOnUnknownLicense: bool(p.block_on_unknown_license, d.blockOnUnknownLicense),
    blockWhenRequiredScannerUnavailable: bool(p.block_when_required_scanner_unavailable, d.blockWhenRequiredScannerUnavailable),
    redactEvidence: bool(p.redact_evidence, d.redactEvidence),
    forbidSecretValueInReport: bool(p.forbid_secret_value_in_report, d.forbidSecretValueInReport),
    securitySensitivePaths: strArr(p.security_sensitive_paths, d.securitySensitivePaths),
    packageFiles: strArr(p.package_files, d.packageFiles),
  };
}

function normalizeConciergePolicy(raw: unknown, defaultEnabled = false): ConciergePolicyConfig {
  const d: ConciergePolicyConfig = {
    enabled: defaultEnabled,
    branchNamespace: "clipboard",
    requirePmApproval: true,
    requireUserInstructionForWrite: true,
    requireLibrarianPolicySources: true,
    requireGuardianBeforeExternalWrite: true,
    requireExternalLock: true,
    forbidPushGarelierBranches: true,
    forbidForcePush: true,
    forbidBlindGitPull: true,
    redactSensitiveOutput: true,
    allowedExternalBranchPrefixes: ["publish/", "pr/", "release/"],
    // Knowledge-relative (DEC-077): resolved over the per-pm knowledge layer then
    // the optional shared __atmos tier; not pinned to a specific layer.
    requiredKnowledgePaths: [
      "external_operations/external_operations_policy.md",
      "external_operations/git_remote_policy.md",
      "external_operations/promote_policy.md",
      "external_operations/rollback_policy.md",
    ],
  };
  if (!raw || typeof raw !== "object") return d;
  const p = raw as Record<string, unknown>;
  const bool = (v: unknown, dv: boolean) => (typeof v === "boolean" ? v : dv);
  const arr = (v: unknown, dv: string[]) =>
    Array.isArray(v) ? v.map(String).filter((s) => s.trim() !== "") : dv;
  // requiredKnowledgePaths reads either a bare array or a { paths = [...] } table.
  const reqKnowledge = (() => {
    if (Array.isArray(p.required_knowledge)) return p.required_knowledge.map(String);
    const nested = p.required_knowledge && typeof p.required_knowledge === "object"
      ? (p.required_knowledge as { paths?: unknown }).paths
      : undefined;
    return Array.isArray(nested) ? nested.map(String) : d.requiredKnowledgePaths;
  })();
  return {
    enabled: bool(p.enabled, d.enabled),
    branchNamespace: typeof p.branch_namespace === "string" ? p.branch_namespace : d.branchNamespace,
    requirePmApproval: bool(p.require_pm_approval, d.requirePmApproval),
    requireUserInstructionForWrite: bool(p.require_user_instruction_for_write, d.requireUserInstructionForWrite),
    requireLibrarianPolicySources: bool(p.require_librarian_policy_sources, d.requireLibrarianPolicySources),
    requireGuardianBeforeExternalWrite: bool(p.require_guardian_before_external_write, d.requireGuardianBeforeExternalWrite),
    requireExternalLock: bool(p.require_external_lock, d.requireExternalLock),
    forbidPushGarelierBranches: bool(p.forbid_push_garelier_branches, d.forbidPushGarelierBranches),
    forbidForcePush: bool(p.forbid_force_push, d.forbidForcePush),
    forbidBlindGitPull: bool(p.forbid_blind_git_pull, d.forbidBlindGitPull),
    redactSensitiveOutput: bool(p.redact_sensitive_output, d.redactSensitiveOutput),
    allowedExternalBranchPrefixes: arr(p.allowed_external_branch_prefixes, d.allowedExternalBranchPrefixes),
    requiredKnowledgePaths: reqKnowledge,
  };
}

const PERMISSION_PROFILES: PermissionProfile[] = ["safe", "reviewed", "dangerous"];

function normalizePermissions(raw: unknown): PermissionConfig {
  const d: PermissionConfig = {
    profile: "reviewed",
    allowNetwork: false,
    allowDestructiveCommands: false,
    allowSecretRead: false,
    requirePmApprovalPaths: [
      ".env*", "infra/**", "migrations/**", ".github/workflows/**", "deploy/**",
    ],
    forbiddenPaths: ["**/*.pem", "**/*secret*", "**/id_rsa"],
  };
  if (!raw || typeof raw !== "object") return d;
  const p = raw as Record<string, unknown>;
  const rawProfile = typeof p.profile === "string" ? p.profile.trim().toLowerCase() : "";
  const profile = (PERMISSION_PROFILES as string[]).includes(rawProfile)
    ? (rawProfile as PermissionProfile)
    : d.profile;
  return {
    profile,
    allowNetwork: p.allow_network === true,
    allowDestructiveCommands: p.allow_destructive_commands === true,
    allowSecretRead: p.allow_secret_read === true,
    requirePmApprovalPaths: Array.isArray(p.require_pm_approval_paths)
      ? p.require_pm_approval_paths.map(String)
      : d.requirePmApprovalPaths,
    forbiddenPaths: Array.isArray(p.forbidden_paths)
      ? p.forbidden_paths.map(String)
      : d.forbiddenPaths,
  };
}

function normalizeConcurrency(raw: unknown): ConcurrencyConfig {
  const def = [...DETACHED_ROLES] as string[];
  const c = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  const max = typeof c.max_concurrent_agents === "number" ? Math.max(0, Math.floor(c.max_concurrent_agents)) : 4;
  const star = typeof c.starvation_cycles === "number" ? Math.max(0, Math.floor(c.starvation_cycles)) : 3;

  // Tiers = array of role groups, highest priority first. Drop unknown roles and
  // dedupe across tiers; append any omitted detached role to the last tier so it
  // always has a tier. EMPTY tiers are KEPT (a reserved demotion lane is a valid,
  // intentionally-empty tier). Absent => default tier model.
  const seen = new Set<string>();
  const tiers: string[][] = [];
  const rawTiers = Array.isArray(c.tiers) ? c.tiers : DEFAULT_CONCURRENCY_TIERS;
  for (const tierRaw of rawTiers) {
    const tier: string[] = [];
    for (const r of (Array.isArray(tierRaw) ? tierRaw : [tierRaw]).map((x) => String(x).trim().toLowerCase())) {
      if (def.includes(r) && !seen.has(r)) { seen.add(r); tier.push(r); }
    }
    tiers.push(tier); // keep empty tiers (reserved demotion lane)
  }
  if (tiers.length === 0) tiers.push([]); // guarantee a last tier to append into
  const missing = def.filter((r) => !seen.has(r));
  if (missing.length) tiers[tiers.length - 1].push(...missing);

  return { maxConcurrentAgents: max, tiers, starvationCycles: star };
}

// [output_control] (DEC-028). Absent => defaults (enabled). Unknown profile name
// or violation_mode is a hard ConfigError; guardian/concierge = "micro" is allowed
// here (doctor warns). soft_result_chars < 200 is a ConfigError (too terse to be
// safe); model_result_log_chars is clamped to [100, 5000].
function isProfileName(v: unknown): v is OutputProfileName {
  return typeof v === "string" && (OUTPUT_PROFILE_NAMES as readonly string[]).includes(v);
}

function normalizeOutputControl(raw: unknown, path: string): OutputControlConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_OUTPUT_CONTROL };
  if (typeof raw !== "object") {
    throw new ConfigError(`[output_control] must be a table in ${path}`);
  }
  const c = raw as Record<string, unknown>;

  const defaultProfile = c.default_profile === undefined ? DEFAULT_OUTPUT_CONTROL.defaultProfile : c.default_profile;
  if (!isProfileName(defaultProfile)) {
    throw new ConfigError(`[output_control] default_profile "${String(c.default_profile)}" is not one of ${OUTPUT_PROFILE_NAMES.join(", ")} (${path})`);
  }

  const violationMode = c.violation_mode === undefined ? DEFAULT_OUTPUT_CONTROL.violationMode : c.violation_mode;
  if (violationMode !== "warn" && violationMode !== "fail") {
    throw new ConfigError(`[output_control] violation_mode "${String(c.violation_mode)}" must be "warn" or "fail" (${path})`);
  }

  // Profiles: start from defaults, overlay any [output_control.profiles.<name>].
  const profiles: Record<OutputProfileName, OutputProfileConfig> = {
    normal: { ...DEFAULT_OUTPUT_PROFILES.normal },
    compact: { ...DEFAULT_OUTPUT_PROFILES.compact },
    micro: { ...DEFAULT_OUTPUT_PROFILES.micro },
  };
  const rawProfiles = (c.profiles && typeof c.profiles === "object") ? c.profiles as Record<string, unknown> : {};
  for (const [name, body] of Object.entries(rawProfiles)) {
    if (!isProfileName(name)) {
      throw new ConfigError(`[output_control.profiles.${name}] is not a known profile (${OUTPUT_PROFILE_NAMES.join(", ")}) (${path})`);
    }
    const pb = (body && typeof body === "object") ? body as Record<string, unknown> : {};
    if (pb.soft_result_chars !== undefined) {
      const v = Number(pb.soft_result_chars);
      if (!Number.isFinite(v) || v < 200) {
        throw new ConfigError(`[output_control.profiles.${name}] soft_result_chars must be a number >= 200 (got ${String(pb.soft_result_chars)}) (${path})`);
      }
      profiles[name].softResultChars = Math.floor(v);
    }
    if (pb.max_bullets !== undefined) {
      const v = Number(pb.max_bullets);
      if (Number.isFinite(v) && v > 0) profiles[name].maxBullets = Math.floor(v);
    }
  }

  // Roles: start from defaults, overlay [output_control.roles]. Unknown role KEY
  // is dropped (doctor flags the typo); unknown profile VALUE is a ConfigError.
  const roles: Record<string, OutputProfileName> = { ...DEFAULT_OUTPUT_ROLES };
  const rawRoles = (c.roles && typeof c.roles === "object") ? c.roles as Record<string, unknown> : {};
  const knownRoles = OUTPUT_CONTROL_ROLES as readonly string[];
  for (const [role, prof] of Object.entries(rawRoles)) {
    if (!knownRoles.includes(role)) continue; // typo: keep default, doctor warns
    if (!isProfileName(prof)) {
      throw new ConfigError(`[output_control.roles] ${role} = "${String(prof)}" is not a known profile (${OUTPUT_PROFILE_NAMES.join(", ")}) (${path})`);
    }
    roles[role] = prof;
  }

  const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, Math.floor(v)));
  };

  return {
    enabled: c.enabled !== false, // default true
    defaultProfile,
    violationMode,
    modelResultLogChars: clamp(c.model_result_log_chars, 100, 5000, DEFAULT_OUTPUT_CONTROL.modelResultLogChars),
    errorTailChars: clamp(c.error_tail_chars, 0, 100000, DEFAULT_OUTPUT_CONTROL.errorTailChars),
    driverLogMaxBytes: typeof c.driver_log_max_bytes === "number" && c.driver_log_max_bytes > 0
      ? Math.floor(c.driver_log_max_bytes)
      : DEFAULT_OUTPUT_CONTROL.driverLogMaxBytes,
    driverLogKeepFiles: clamp(c.driver_log_keep_files, 1, 1000, DEFAULT_OUTPUT_CONTROL.driverLogKeepFiles),
    usageSummary: c.usage_summary !== false, // default true
    // DEC-049 authoring control: human-facing prose language + terse two-tier.
    language: (c.language === "ja" || c.language === "en" || c.language === "both" || c.language === "auto")
      ? c.language : DEFAULT_OUTPUT_CONTROL.language,
    terse: c.terse !== false, // default true (cost-favoring)
    profiles,
    roles,
  };
}

function normalizeStatusWeb(raw: unknown): StatusWebConfig {
  const d: StatusWebConfig = {
    enabled: false, host: "0.0.0.0", port: 3787,
    autoRefreshSeconds: 5, readOnly: true, showSourceUrls: true,
  };
  if (!raw || typeof raw !== "object") return d;
  const s = raw as Record<string, unknown>;
  const host = typeof s.host === "string" && /^[A-Za-z0-9.:[\]-]+$/.test(s.host.trim())
    ? s.host.trim()
    : d.host;
  return {
    enabled: s.enabled === true,
    host,
    port: typeof s.port === "number" ? s.port : d.port,
    autoRefreshSeconds: typeof s.auto_refresh_seconds === "number" ? s.auto_refresh_seconds : d.autoRefreshSeconds,
    readOnly: s.read_only !== false,
    showSourceUrls: s.show_source_urls !== false,
  };
}

function normalizeArtisan(
  raw: unknown,
  path: string,
  pmId: string,
  runner: RunnerConfig,
): ArtisanConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  // The Artisan is a singleton (DEC-017/DEC-056): exactly one or none, never
  // multiple. A TOML `[[artisan]]` array (or any list) is a hard config error.
  if (Array.isArray(raw)) {
    throw new ConfigError(
      `${path}: the Artisan is a singleton — use a single [artisan] table, not [[artisan]] / multiple entries (DEC-017)`,
    );
  }
  const s = raw as Record<string, unknown>;
  if (s.enabled !== true) return undefined; // disabled = no artisan lane
  const provider = normalizeProvider(
    s.provider,
    `${path}: [artisan] provider`,
    runner.defaultAgent.provider,
  );
  const inheritedModel = provider === runner.defaultAgent.provider ? runner.defaultAgent.model : undefined;
  return {
    id: String(s.id ?? "artisan-01"),
    provider,
    model: normalizeModel(s.model, provider) ?? inheritedModel ?? "",
    effort: normalizeEffort(s.effort) ?? runner.defaultAgent.effort,
    worktree: String(s.worktree ?? `__garelier/${pmId}/_artisan`),
    branchNamespace: String(s.branch_namespace ?? "satchel"),
  };
}

// [lanes] default — the lane the driver runs when runtime/lane.lock is absent
// (DEC-056). "dock" (default) = the parallel pipeline; "artisan" = the
// single-agent lane runs by default (small-scale / one-agent projects). An
// explicit lane.lock still overrides this per-task either way.
function normalizeDefaultLane(raw: unknown, path: string): "dock" | "artisan" {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "dock";
  const v = (raw as Record<string, unknown>).default;
  if (v === undefined || v === null || v === "") return "dock";
  const s = String(v).toLowerCase();
  if (s !== "dock" && s !== "artisan") {
    throw new ConfigError(`${path}: [lanes] default must be "dock" or "artisan" (got: ${String(v)})`);
  }
  return s;
}

function normalizeRunner(raw: Record<string, unknown>, path: string): RunnerConfig {
  const defaultProvider = normalizeProvider(
    raw.default_agent_provider,
    `${path}: [runner] default_agent_provider`,
    "claude-code",
  );
  const defaultAgent: RunnerDef = {
    provider: defaultProvider,
    model: normalizeModel(raw.default_agent_model, defaultProvider),
    effort: normalizeEffort(raw.default_agent_effort),
  };
  const pmProvider = normalizeProvider(raw.pm_provider, `${path}: [runner] pm_provider`, defaultProvider);
  const dockProvider = normalizeProvider(
    raw.dock_provider,
    `${path}: [runner] dock_provider`,
    defaultProvider,
  );
  return {
    pm: {
      provider: pmProvider,
      model: normalizeModel(raw.pm_model, pmProvider),
      effort: normalizeEffort(raw.pm_effort),
    },
    dock: {
      provider: dockProvider,
      model: normalizeModel(raw.dock_model, dockProvider),
      effort: normalizeEffort(raw.dock_effort),
    },
    defaultAgent,
  };
}

function normalizeEffort(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return String(raw).trim();
}

function normalizeProvider(raw: unknown, label: string, fallback: ProviderKind): ProviderKind {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "claude" || v === "claude-code") return "claude-code";
  if (v === "codex" || v === "codex-cli") return "codex-cli";
  if (v === "gemini" || v === "gemini-cli" || v === "google-gemini") return "gemini-cli";
  if (v === "copilot" || v === "github-copilot" || v === "copilot-cli") return "copilot-cli";
  if (v === "cursor" || v === "cursor-cli" || v === "cursor-agent") return "cursor-cli";
  throw new ConfigError(`${label}: unsupported provider "${raw}" (expected claude-code, codex-cli, gemini-cli, copilot-cli, or cursor-cli)`);
}

function normalizeModel(raw: unknown, provider: ProviderKind): string | undefined {
  if (raw === undefined || raw === null || raw === "") return defaultModelForProvider(provider);
  const s = String(raw);
  // A model equal to the provider name (or the provider's "use default" token)
  // means "use the CLI's configured default".
  if (provider === "claude-code" && s === "claude-code") return undefined;
  if (provider === "codex-cli" && s === "codex-cli") return undefined;
  if (provider === "gemini-cli" && (s === "gemini-cli" || s === "gemini-default")) return undefined;
  if (provider === "copilot-cli" && (s === "copilot-cli" || s === "auto")) return "auto";
  if (provider === "cursor-cli" && (s === "cursor-cli" || s === "auto")) return "auto";
  return s;
}

function defaultModelForProvider(provider: ProviderKind): string | undefined {
  switch (provider) {
    case "claude-code":
      return undefined;
    case "codex-cli":
      return undefined;
    case "gemini-cli":
      return "gemini-default";
    case "copilot-cli":
      return "auto";
    case "cursor-cli":
      return "auto";
  }
}

// provider_command: array of argv tokens (preferred, Windows-quoting safe) or a
// whitespace-split string. Empty/absent → undefined.
function normalizeProviderCommand(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const arr = raw.map(String).map((s) => s.trim()).filter((s) => s !== "");
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof raw === "string") {
    const arr = raw.trim().split(/\s+/).filter((s) => s !== "");
    return arr.length > 0 ? arr : undefined;
  }
  return undefined;
}
