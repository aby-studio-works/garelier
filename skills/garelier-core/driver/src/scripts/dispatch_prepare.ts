#!/usr/bin/env bun
import { canonicalPath, configurePathGuardRoots, detachReparsePoints, removeTreeSync, renameSync, rmSync } from "../guard/path_guard.ts";
import { distinctiveFenceToken } from "../guard/command_guard.ts";

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crewSubdir } from "../workspace.ts";
import { git, pidAlive, resolveCommand, run, shellQuote, utcIsoSeconds } from "./_lib.ts";
import { DISPATCH_PREPARE_FLAGS } from "./cli_flag_ownership.ts";
import {
  CLAUDE_ROLE_PROMPT_CONTRACT_MARKER,
  CODEX_ROLE_PROMPT_CONTRACT_MARKER,
  DISPATCH_RESULT_STATE_FIRST_LINE_CONTRACT,
  DOCK_RUN_REQUIRED_GATE_REASON,
  codexProviderContract,
  requiredGateDelegationContract,
} from "./lane_common.ts";
import { adaptProviderRouting } from "../dispatch/provider_routing.ts";
import { longJobRoot, recoverLongJobs } from "../long_jobs.ts";
import { parse as parseToml } from "smol-toml";
import {
  assertPromptSections,
  nestTaskFileSections,
  type PromptSectionSurface,
} from "../dispatch/prompt_section_contract.ts";
import { GATE_VERDICT_TEMPLATE, seatAgentName, seatReportPath } from "./gate_agents.ts";
import {
  checkReuseIdentity,
  computeReuseHint,
  diffSpecVersions,
  findReusableRecord,
  patchContextSpecVersions,
  type ContextIdentity,
  type ReusableRecord,
} from "../dispatch/reuse.ts";
import { gatePlanFor } from "../dispatch/gate_tier.ts";
import { MACHINE_ARTIFACT_CONTRACT, renderMachineArtifact } from "../dispatch/machine_artifact.ts";
import { declaredHeavyTier } from "../dispatch/engine_aware.ts";
import {
  acquireGarelierOperationGuard,
  assertDispatchCheckpointPrecondition,
  claimDispatchControlWork,
  garelierControlRoots,
  inspectDispatchControlBinding,
  releaseDispatchControlClaim,
  type DispatchControlBinding,
} from "../control/garelier_integration.ts";
import { atomicWriteRuntimeFile } from "../control/diagnostics.ts";
import { canonicalJson, sha256 } from "../control/serialization.ts";
import { loadPlanGraphModel } from "../control/plan_graph_model.ts";
import { resolveControlNamespace } from "../control/transaction.ts";
import { readControlSession, writeControlSession } from "../control/sessions.ts";
import { readControlClaim } from "../control/claims.ts";
import {
  renderRoleSourcePointerSection,
  resolveRoleLensBinding,
  upsertRoleSourcePointerSection,
  type RoleSourcePointerOptions,
  type ResolvedRoleLensBinding,
} from "../lenses.ts";
import { resolveRoleKnowledgeBinding } from "../dispatch/knowledge_binding.ts";
import { resolveTouchedPackages } from "../context_pack.ts";
import {
  runAckLaunch,
  runAttendedSpawn,
  type AckLaunchOptions,
  type SpawnOptions,
} from "../dispatch/attended_seat.ts";
import { profileForRole } from "../guard/permission_profiles.ts";
import { resolveGateSeatCommands } from "../guard/gate_seat_commands.ts";
import { parseApprovedRemoteSpec } from "../guard/approved_remotes.ts";
import { installConciergeGuards } from "./install_concierge_guards.ts";
import {
  bindingReference,
  defaultRoleCarabiner,
  defaultRoleSeatCarabiner,
  dispatchExecutionIdentity,
  hashRoleFile,
  issueRoleAuthorization,
  issueRoleSeatAuthorization,
  roleBindingFromContext,
  roleBindingPaths,
  ROLE_RECORD_KIND,
  roleAuthorizationDigest,
  roleExecutionIdentityForBranch,
  readCurrentRoleAuthorization,
  readRoleAuthorizationFile,
  rebindRoleAdmission,
  recoverRoleAuthorization,
  roleSeatExecutionIdentity,
  resolveCanonicalRoleAcceptanceIds,
  writeRoleBindingToContext,
  type RoleAuthorization,
  type RecoverRoleAuthorizationOptions,
  type RoleKind,
} from "../dispatch/role_binding.ts";
import {
  DISPATCH_CONTAINER_LIFECYCLE,
  type DispatchContainerLifecycle,
  type ResumeTransitionResult,
  type ReworkIntegrationResult,
} from "../dispatch/container_lifecycle.ts";

export type PrepareRoleRecoveryOptions = Omit<RecoverRoleAuthorizationOptions, "issuer">;
export function prepareRoleRecovery(options: PrepareRoleRecoveryOptions): RoleAuthorization {
  return recoverRoleAuthorization({
    ...options,
    issuer: { role: "coordinator", id: "dispatch_prepare:role_recovery" },
  });
}

const HELP = `#
# dispatch_prepare.ts — zero-LLM role-dispatch scaffolding (DEC-063 Part A).
#
# Does the mechanical bookkeeping a dispatch Dock otherwise hand-builds
# (and a mid-tier model gets wrong): atomically claims the next task id, cuts an
# ISOLATED worktree off the integration branch on the role's branch family, and
# prints {id, container, checkout, branch, base_sha, context} as one JSON line for
# the dispatched role prompt. It also writes a forward-supply fact-pack (context.json,
# DEC-081 Piece 1) and an advisory pickup_pack.json (W-017) into the container so
# the dispatched role does not re-derive project facts (gate command, target_slug,
# branch names, base sha) in its cold worktree.
# Never touches an in-flight persistent role container. Dispatch containers are
# \`_crew/dispatch<id>/\`,
# with the worktree at checkout/.
#
# Usage:
#   dispatch_prepare.ts --project <control-root> --pm-id <id> --role <worker|smith|librarian|artisan|scout|observer|guardian|concierge>
#                       --slug <kebab-slug> [--base <integration-branch>] --blueprint <path>
#                         # required role context; omission remains operationally
#                         # available but emits an explicit warning in stderr + prompt
#                       [--work-id W-N] [--control-session <session_id>]
#                       [--pipeline-package PP-N] [--target-root <git-root>]
#                       [--model M] [--effort E] [--scope MARKER] [--tags CSV] [--rework]
#                       [--provider <codex|claude-code>] [--provider-transport attended-agent|claude-subprocess]
#                       [--task-file <path>]
#                         # provider is selected per task; config role metadata
#                         # never overrides --provider / --model / --effort.
#                         # OMITTED on a fresh dispatch -> claude-code (W-690);
#                         # codex requires the explicit --provider codex flag.
#                       [--reuse <agent> [--row <pointer>]]
#                         # W-191 serial WARM reuse: continue an already-spawned
#                         # role (--reuse ga-<role>-<slug>) on the NEXT row.
#                         # Emits ONLY a delta block (row pointer + the seat's warm
#                         # checkout + base + spec-diff + reuse hint) — no id claim,
#                         # no worktree, no full preamble (already delivered at first
#                         # spawn). It still binds the exact Control claim and replaces
#                         # the existing container's ready.json as its final publication.
#                         # Same-role/pm/repo only; a gate seat never reuses.
#                       [--recover-role
#                         (--recovery-dispatch <positive-id> | --recovery-branch <full-role-ref>)
#                         --recovery-reason <bindingless_migration|stall_handoff|provider_replacement|base_track>
#                         --expected-previous-digest <sha256|null>
#                         --item-authority <path> --assignment-path <path> --prompt-path <path>
#                         --initial-instructions-path <path> [--recovery-wip <path> ...]
#                         --acceptance-id <AC-ID> [--acceptance-id <AC-ID> ...]]
#                         # Coordinator-owned recovery. Role/topology, canonical
#                         # AC equality, hashes, Lens, Knowledge, issuer, generation,
#                         # and supersession are derived/validated here. The result
#                         # is a launch handoff; launch is never auto-acknowledged.
#                       [--rebind-authority --id <positive-id> --evidence <gate-verdict-path>
#                         [--candidate-sha <full-sha>] [--target-root <git-root>]]
#                         # Evidence-gated append-only admission transition. Updates
#                         # the item authority to current canonical row bytes and,
#                         # when supplied, advances an existing close receipt's
#                         # effective candidate without rewriting either record.
#                       [--touches '<glob>,<glob>'] [--depends-on '<slug|#id>,...'] [--allow-conflict]
#                       [--resource-class <heavy|light|data|review>] [--runtime-effect <none|headless|visual|aural|input>]
#                       [--heavy-tier <check|codegen>]
#                       [--bash-budget-ms <positive-ms>]
#                       [--full-gate]
#
#   dispatch_prepare.ts --attended-seat --role <role> --slug <slug> --worktree <path>
#                       [--project <control-root> --pm-id <id> ...]
#
#   ACK_LAUNCH_USAGE_BEGIN (W-620)
#   dispatch_prepare.ts --ack-launch --project <control-root> --pm-id <id>
#                       --dispatch-id <id> --agent-handle <handle> --parent-id <id>
#   ACK_LAUNCH_USAGE_END
#     Those five are ALL of it: --ack-launch accepts no other flag and every one
#     of the five is required. The block used to run on into the main form's
#     options above, so --provider read as required and a dozen optional flags
#     read as accepted; a PM passed them as written and was refused three times
#     before reading the parser. The markers above are load-bearing — a test
#     compares the flags between them against parseAttendedAckLaunchArgs in both
#     directions, so this block cannot drift from the parser again.
#
#     WHEN it is needed: only for the attended-agent transport, where the PARENT
#     agent records the launch it performed. A codex-cli seat does not need it at
#     all — dispatch_provider.ts records that launch itself — and calling it there
#     is refused as an incompatible transport.
#
# --resource-class / --runtime-effect (W-087) are the engine-aware assignment
# fields: resource_class=heavy routes the dispatch through the machine-wide heavy
# scheduler gate (one full-workspace compile at a time on the RAM-bound box);
# runtime_effect tells the close-contract check which RUN evidence to demand (a
# visual task needs a screenshot / user-verdict pointer). Omitting a field defaults
# to light/none WITH a warning — declare both on new dispatches.
#
# --heavy-tier (W-348) applies to a heavy dispatch only, and says how LONG it holds
# that slot: check (~7m, a scoped/cold cargo check) or codegen (HOURS, a full
# codegen/test run). It sizes the lock's reclaim thresholds and the watch's runaway
# ceiling; without it an hours-long job is judged against a seven-minute job's
# budgets and gets killed as a runaway mid-build.
#
# W-362: the declared tier is written to context.json (task.heavy_tier, the canon)
# AND threaded into the watch_cmd this script arms — before that it reached neither
# the watch nor the lock, so the standard path still armed a check-grade watch over
# a codegen job. DECLARE IT: an omitted tier is not a safe default but an absence.
# Every consumer leaves its own documented budgets alone when nothing was declared,
# because silence from one dispatch must not widen thresholds for the others sharing
# the machine-wide slot. The codegen fallback applies to a WRONG token, not to none.
#
# --bash-budget-ms (W-402) overrides context.json's bash_timeout_budget_ms for THIS
# dispatch only — the per-project default (600000ms, or the .claude/settings*.json-
# resolved value) is unchanged when the flag is omitted. A negative or non-numeric
# value is a usage error (dispatch_prepare fails before any worktree is cut;
# context_pack.ts independently re-validates the same value when invoked directly).
#
# QUOTE glob-valued flags with SINGLE quotes (W-054): --touches 'docs/**'. If the
# value (e.g. docs/**) is left unquoted, the invoking shell expands it against the
# cwd into multiple words BEFORE this script sees them, so the extra path words
# arrive as stray positionals and fail arg parsing ("unknown arg: docs/engine").
# This script's own expansions are all quoted; the fix is at the call site.
#
# Control session/claim lifetime (W-299): ordinary heartbeat never revives an
# expired claim. Schema-3 dispatch-bind may renew only its exact same-session
# Work claim after checking all claims for a live competing touch; it atomically
# records actor/session/time/source/reason under control/reports/claim_renewals
# and the Backlog's typed evidence_refs before moving runtime claim bytes.
# A different session is never stolen here. Claim validation and any audited
# renewal complete before a dispatch id, branch, container, or worktree is
# allocated. Every later failure compensates the exact claim and only artifacts
# created by this invocation; ready.json is the final durable publication point.
#
# --touches / --depends-on are declared conflict/dependency metadata (W-053):`;

function out(line: string): void { process.stdout.write(`${line}\n`); }
function err(line: string): void { process.stderr.write(`${line}\n`); }
class CliFailure extends Error { constructor(readonly exitCode: number) { super("dispatch_prepare failed"); } }
function fail(message: string, code = 2): never { err(message); throw new CliFailure(code); }

function enforcePromptSectionContract(input: {
  markdown: string;
  surface: PromptSectionSurface;
  sourcePath: string;
  blueprintPath: string | null;
}): void {
  try {
    assertPromptSections(input);
  } catch (error) {
    fail(`dispatch_prepare: ${error instanceof Error ? error.message : String(error)}`, 4);
  }
}
function valueAfter(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value === "") fail(`dispatch_prepare: missing value for ${argv[index]}`, 1);
  return value;
}
function text(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }
function requiredKnowledgeRefs(assignment: string): string[] {
  return [...assignment.matchAll(/^\s*-\s+Knowledge:\s*`([^`]+)`\s*$/gmi)].map((match) => match[1].trim()).filter(Boolean);
}
function controlAuthorityPath(controlRoot: string, schema: number | null, workId: string): string {
  if (schema === 3) {
    const work = loadPlanGraphModel(controlRoot).backlog.get(workId);
    if (!work) fail(`dispatch_prepare: canonical Backlog authority is missing for role binding: ${workId}`, 4);
    return resolve(controlRoot, work.path);
  }
  fail(`dispatch_prepare: role authorization requires schema 3 item authority (found ${schema ?? "none"})`, 4);
}
// W-666: `control create backlog` defaults the acceptance block to the single line
// `- [ ] Define acceptance.` (see handleV3Create in scripts/control.ts). A row still
// carrying only that line has no acceptance contract, yet dispatch used to claim it
// happily, which forced the operator to smuggle the real criteria in through the
// blueprint. The check is deliberately scoped to the extracted `## Acceptance
// criteria` SECTION rather than a whole-file grep: a row may legitimately quote the
// placeholder string in prose, and a row with a broken DUPLICATE heading (a shape
// observed in the field) must not be rejected while one of its sections carries real
// criteria.
export const PLACEHOLDER_ACCEPTANCE_LINE = "- [ ] Define acceptance.";
export function acceptanceSections(body: string): string[][] {
  const lines = body.split(/\r?\n/);
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current) sections.push(current);
      current = /^##\s+Acceptance criteria\s*$/i.test(line) ? [] : null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) sections.push(current);
  return sections.map((section) => section.map((line) => line.trim()).filter(Boolean));
}
export function placeholderAcceptanceOnly(body: string): boolean {
  const sections = acceptanceSections(body);
  if (sections.length === 0) return false;
  return sections.every((section) => section.length === 1 && section[0] === PLACEHOLDER_ACCEPTANCE_LINE);
}
function readQuoted(path: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text(path).match(new RegExp(`^\\s*${escaped}\\s*=\\s*"(.*)".*$`, "m"))?.[1] ?? "";
}
// W-191 (a): the project's STANDING prompt constraints ([prompt] standing = [...]
// in setup_config.toml) — per-project rules (fixed-point/renormalize/kill-filter,
// …) the PM would otherwise restate in every dispatch. Auto-bundled into the
// preamble so a PM prompt shrinks to "row pointer + this dispatch's ruling". Parsed
// with the real TOML reader (multi-line arrays are common) and fail-safe to [] on an
// absent section or a malformed config — a bad [prompt] never blocks a dispatch.
export function readStandingConstraints(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const t = parseToml(text(path)) as { prompt?: { standing?: unknown } };
    const s = t.prompt?.standing;
    return Array.isArray(s) ? s.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  } catch { return []; }
}

/** The provider a fresh dispatch gets when `--provider` is omitted (W-690).
 *
 * Provider stays TASK authority — config role metadata still never selects one,
 * and `--provider codex` is still honoured verbatim. What changed is the
 * omission case: it used to be `fail(... requires explicit --provider ...)`, so
 * every dispatch line had to name a provider and a slip named the wrong one.
 * The user retired codex operation on 2026-09-05, so the omission now resolves
 * to claude-code and codex requires the explicit flag.
 *
 * Which paths consult it (W-693 F-4 — the earlier blanket "reuse / rework /
 * recovery never default" was falsifiable): a fresh dispatch, and a `--rework`
 * of a READ-ONLY seat. The rework branch that sets `p.reuse = agent` is guarded
 * by `!readOnlySeat`, so a guardian/observer rework reaches the second default
 * assignment and is defaulted where it previously exited 4 — intended under
 * claude-only, and the record stays honest because `providerFromFlag` is
 * captured before the first default and reports `provider_source:
 * "framework-default"`. A rework that resolves to `--reuse`, and every recovery
 * path, still derive the provider from the canonical producer binding and are
 * never defaulted into a substitution. */
export const DEFAULT_PROVIDER = "claude-code" as const;

export interface ProviderVocabularyHit {
  term: string;
  replacement: string;
  line: number;
}

/** Report-only wording hygiene. It never changes providers, refuses a
 * dispatch, or rewrites task authority. */
export function providerVocabularyHits(markdown: string): ProviderVocabularyHit[] {
  const vocabularyPath = resolve(
    dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "knowledge", "provider_filter_vocabulary.toml",
  );
  if (!existsSync(vocabularyPath)) return [];
  let terms: Array<{ term?: unknown; replacement?: unknown }> = [];
  try {
    const parsed = parseToml(readFileSync(vocabularyPath, "utf8")) as { terms?: unknown };
    if (Array.isArray(parsed.terms)) terms = parsed.terms as Array<{ term?: unknown; replacement?: unknown }>;
  } catch { return []; }
  const lines = markdown.split(/\r?\n/);
  const hits: ProviderVocabularyHit[] = [];
  for (const entry of terms) {
    const term = typeof entry.term === "string" ? entry.term.trim() : "";
    const replacement = typeof entry.replacement === "string" ? entry.replacement.trim() : "";
    if (!term || !replacement) continue;
    for (const [index, line] of lines.entries()) {
      if (line.toLocaleLowerCase().includes(term.toLocaleLowerCase())) {
        hits.push({ term, replacement, line: index + 1 });
      }
    }
  }
  return hits;
}
// W-191 (c): the project's governance files ([prompt] spec_files in setup_config)
// whose git versions a dispatch STAMPS (spec_versions) so a later --reuse can
// mechanically diff "did a rule change since this warm seat last read it?". Same
// [prompt] section + fail-safe-to-[] parse as readStandingConstraints.
export function readSpecFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const t = parseToml(text(path)) as { prompt?: { spec_files?: unknown } };
    const s = t.prompt?.spec_files;
    return Array.isArray(s) ? s.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  } catch { return []; }
}
// W-191 (c): the current blob SHA of each spec file (`git rev-parse HEAD:<path>`),
// which changes iff the file's content changes. An untracked / absent / errored
// file is skipped (fail-open), never a crash — a bad spec_files entry must not
// block a dispatch.
function computeSpecVersions(root: string, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    const sha = gitOut(root, ["rev-parse", `HEAD:${f}`]);
    if (sha) out[f] = sha;
  }
  return out;
}
// W-192: the project's mandatory-gate policy floor, read with the EXACT condition
// the merge gate enforces (guardian_policy_check / observer_policy_check):
// enabled && require_for_all_merges. So gate_plan proposes exactly the seats the
// merge gate will require — a docs-only dispatch on a require-all project shows
// Guardian/Observer up front, never a silent 0-seat plan the merge gate refuses.
// Fail-safe to no floor on an absent / malformed config.
function readGatePolicyFloor(path: string): { requireGuardianForAllMerges: boolean; requireObserverForAllMerges: boolean } {
  const off = { requireGuardianForAllMerges: false, requireObserverForAllMerges: false };
  if (!existsSync(path)) return off;
  try {
    const t = parseToml(text(path)) as { guardian_policy?: Record<string, unknown>; observer_policy?: Record<string, unknown> };
    const gp = t.guardian_policy ?? {}, op = t.observer_policy ?? {};
    return {
      requireGuardianForAllMerges: gp.enabled === true && gp.require_for_all_merges === true,
      requireObserverForAllMerges: op.enabled === true && op.require_for_all_merges === true,
    };
  } catch { return off; }
}
function spawnCaptured(command: string[], stderr: "pipe" | "ignore" = "pipe") {
  const resolved = resolveCommand(command);
  if (!resolved) return { exitCode: 127, stdout: Buffer.from(""), stderr: Buffer.from(`required executable not found: ${command[0] ?? "<empty>"}`) };
  return Bun.spawnSync(resolved, { windowsHide: true, stdin: "inherit", stdout: "pipe", stderr });
}
function capturedText(value: Uint8Array | undefined): string { return value?.toString() ?? ""; }
function runQuiet(command: string[]): { code: number; stdout: string } {
  const child = spawnCaptured(command, "ignore");
  return { code: child.exitCode, stdout: capturedText(child.stdout).trim() };
}
function runToStderr(command: string[]): number {
  const child = spawnCaptured(command, "pipe");
  process.stderr.write(capturedText(child.stdout));
  process.stderr.write(capturedText(child.stderr));
  return child.exitCode;
}

// W-450: a dispatch checkout in this framework repository must not become
// runnable with a missing or half-copied driver dependency tree. Checking the
// directory alone is insufficient: the measured broken tree had bun-types/
// present but only package.json + README.md. Probe the entrypoints used by the
// runtime and typecheck instead; the list is intentionally independent of
// package file counts, which change between locked package versions.
export const CHECKOUT_DRIVER_DEPENDENCY_ENTRYPOINTS = [
  "node_modules/smol-toml/dist/index.js",
  "node_modules/typescript/lib/tsc.js",
  "node_modules/@types/bun/index.d.ts",
  "node_modules/bun-types/index.d.ts",
  // Three distinct bun-types entry files guarantee that the measured two-file
  // corruption is rejected regardless of which two files happened to land.
  "node_modules/bun-types/globals.d.ts",
  "node_modules/bun-types/bun.d.ts",
  "node_modules/@types/node/index.d.ts",
  "node_modules/undici-types/index.d.ts",
] as const;

export function inspectCheckoutDriverDependencies(checkout: string): {
  applicable: boolean;
  missing: string[];
} {
  const driverRoot = join(checkout, "skills", "garelier-core", "driver");
  const applicable = ["package.json", "bun.lock", "tsconfig.json"]
    .every((entry) => existsSync(join(driverRoot, entry)));
  if (!applicable) return { applicable: false, missing: [] };
  const missing = CHECKOUT_DRIVER_DEPENDENCY_ENTRYPOINTS.filter((entry) => {
    try {
      const info = statSync(join(driverRoot, entry));
      return !info.isFile() || info.size === 0;
    } catch {
      return true;
    }
  });
  return { applicable: true, missing };
}

export function ensureCheckoutDriverDependencies(
  checkout: string,
  install: (driverRoot: string) => number = (driverRoot) => runToStderr([
    process.execPath,
    "install",
    "--frozen-lockfile",
    "--cwd",
    driverRoot,
  ]),
): { applicable: boolean; repaired: boolean; missingBefore: string[] } {
  const before = inspectCheckoutDriverDependencies(checkout);
  if (!before.applicable || before.missing.length === 0) {
    return { applicable: before.applicable, repaired: false, missingBefore: before.missing };
  }

  const driverRoot = join(checkout, "skills", "garelier-core", "driver");
  err(`dispatch_prepare: driver dependencies incomplete (${before.missing.join(", ")}); repairing from the frozen lockfile`);
  const installRc = install(driverRoot);
  if (installRc !== 0) fail(`dispatch_prepare: frozen driver dependency install failed (exit ${installRc})`, installRc);

  const after = inspectCheckoutDriverDependencies(checkout);
  if (after.missing.length > 0) {
    fail(`dispatch_prepare: driver dependencies remain incomplete after frozen install (${after.missing.join(", ")})`, 1);
  }
  err(`dispatch_prepare: driver dependencies repaired and entrypoints verified (${before.missing.join(", ")})`);
  return { applicable: true, repaired: true, missingBefore: before.missing };
}

export interface DispatchCompensationState {
  binding: DispatchControlBinding | null;
  container: string;
  checkout: string;
  branch: string;
  containerOwned: boolean;
  checkoutOwned: boolean;
  branchExisted: boolean;
  startEventCompensation: string[] | null;
  published: boolean;
}

export function compensateFailedDispatch(
  state: DispatchCompensationState,
  roots: ReturnType<typeof garelierControlRoots>,
  gitRoot: string,
  namespaceLock: Parameters<typeof releaseDispatchControlClaim>[3],
): string[] {
  if (state.published) return [];
  const failures: string[] = [];
  if (state.checkoutOwned && state.checkout && existsSync(state.checkout)) {
    // W-380: git's own recursive removal follows a Windows junction out of the
    // tree, so every link is detached before git is handed the checkout.
    const detachment = detachReparsePoints(state.checkout);
    if (detachment.failed.length > 0) {
      failures.push(`worktree removal refused: ${detachment.failed.length} reparse point(s) could not be detached first (a recursive delete can follow a link out of the checkout): ${detachment.failed.map((entry) => `${entry.path} (${entry.reason})`).join("; ")}`);
    } else {
      const removed = git(gitRoot, ["worktree", "remove", "--force", state.checkout]);
      if (removed.exitCode !== 0) failures.push(`worktree removal failed: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`);
    }
  }
  if (state.containerOwned && state.container && existsSync(state.container)) {
    try { removeTreeSync(state.container); }
    catch (error) { failures.push(`container removal failed: ${(error as Error).message}`); }
  }
  if (state.branch && !state.branchExisted && gitOut(gitRoot, ["rev-parse", "--verify", `refs/heads/${state.branch}`])) {
    const removed = git(gitRoot, ["branch", "-D", state.branch]);
    if (removed.exitCode !== 0) failures.push(`branch removal failed: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`);
  }
  if (state.binding) {
    try {
      releaseDispatchControlClaim(roots, state.binding.work_id, state.binding.session_id, namespaceLock);
    } catch (error) {
      failures.push(`claim release failed: ${(error as Error).message}`);
    }
  }
  if (state.startEventCompensation) {
    const eventRc = runToStderr(state.startEventCompensation);
    if (eventRc !== 0) failures.push(`start-event compensation failed: exit ${eventRc}`);
  }
  return failures;
}

export function publishDispatchReady(
  container: string,
  ready: Record<string, unknown>,
  markPublished: () => void,
  emit: (source: string) => void = (source) => { process.stdout.write(source); },
): void {
  const source = `${JSON.stringify(ready)}\n`;
  atomicWriteRuntimeFile(container, `${container}/ready.json`, source);
  markPublished();
  try { emit(source); } catch { /* the durable marker is the success result */ }
}
function posixish(path: string): string { return path.replace(/\\/g, "/"); }

function advertisedCodexModels(configPath: string): string[] {
  if (!existsSync(configPath)) return [];
  try {
    const value = (parseToml(text(configPath)) as { runner?: { codex_advertised_models?: unknown } })
      .runner?.codex_advertised_models;
    return Array.isArray(value)
      ? value.filter((model): model is string => typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(model))
      : [];
  } catch { return []; }
}

// W-224/W-227: this is the dispatch_prepare twin of the launcher choke point in
// dispatch_provider.ts. heavy_compile_lock.ts is always forbidden because
// its lock lives outside every role grant. Other garelier-core script/driver
// references are forbidden only when their canonical target is not inside the
// current dispatch anchor. The pre-mutation task-file check anchors at the
// canonical --project repo; the rendered-assignment check anchors at the
// canonical worktree created for the dispatch.
export const CODEX_FORBIDDEN_HEAVY_LOCK = /heavy_compile_lock\.ts/i;
export const CODEX_GARELIER_CORE_PATH = /garelier-core[\\/](?:scripts|driver)[\\/]/i;

function extractPromptPathTokens(value: string): string[] {
  return value
    .split(/[\s`'"()]+/)
    .filter(Boolean)
    .map((token) => token.replace(/^[,;:]+|[,;:.]+$/g, ""));
}

function nativePromptPath(value: string): string {
  if (process.platform !== "win32" || !/^\/[A-Za-z]\//.test(value)) return value;
  const converted = spawnCaptured(["cygpath", "-m", value], "ignore");
  return converted.exitCode === 0 ? capturedText(converted.stdout).trim() : "";
}

function resolvesInsideCanonicalAnchor(candidate: string, anchor: string): boolean {
  const nativeCandidate = nativePromptPath(candidate);
  if (!nativeCandidate) return false;
  let canonicalAnchor = "";
  let canonicalCandidate = "";
  try {
    canonicalAnchor = canonicalPath(anchor);
    canonicalCandidate = canonicalPath(nativeCandidate, canonicalAnchor);
  } catch {
    return false;
  }
  const rel = relative(canonicalAnchor, canonicalCandidate);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return false;
  try {
    if (statSync(canonicalCandidate).isFile()) return true;
  } catch { /* fall through to the W-226 directory fallback */ }
  try {
    return statSync(dirname(canonicalCandidate)).isDirectory();
  } catch {
    return false;
  }
}

export function codexForbidsDirectInvoke(text: string, canonicalAnchor: string): boolean {
  if (CODEX_FORBIDDEN_HEAVY_LOCK.test(text)) return true;
  for (const token of extractPromptPathTokens(text)) {
    if (!CODEX_GARELIER_CORE_PATH.test(token)) continue;
    if (!resolvesInsideCanonicalAnchor(token, canonicalAnchor)) return true;
  }
  return false;
}
function shellCommand(argv: string[]): string { return argv.map((value) => shellQuote(value)).join(" "); }

export function dispatchPrepareNextCommand(
  argv: string[],
  options: { remove?: readonly string[]; replace?: Readonly<Record<string, string>> } = {},
): string {
  const remove = new Set(options.remove ?? []);
  const recovered: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (remove.has(arg)) continue;
    const replacement = options.replace?.[arg];
    if (replacement !== undefined) {
      recovered.push(arg, replacement);
      index += 1;
      continue;
    }
    recovered.push(arg);
  }
  return shellCommand([
    process.execPath,
    posixish(resolve(dirname(fileURLToPath(import.meta.url)), "dispatch_prepare.ts")),
    ...recovered,
  ]);
}

export function missingControlBindingNextCommand(project: string, pmId: string): string {
  return shellCommand(["garelier", "control", "session-open", "--agent", "dock", "--project", project, "--pm-id", pmId]);
}

export function staleClaimNextCommand(options: {
  project: string;
  pmId: string;
  workId: string;
  sessionId: string;
  touches: string;
  slug: string;
}): string {
  return shellCommand([
    "garelier", "control", "claim", options.workId,
    "--session", options.sessionId,
    ...(options.touches.trim() ? ["--touches", options.touches] : []),
    "--steal", "--reason", `fresh dispatch for ${options.slug} replaces stale claim`,
    "--project", options.project, "--pm-id", options.pmId,
  ]);
}

export function providerEffortRecoveryCommand(argv: string[], effort = "xhigh"): string {
  const recovered = [...argv];
  const index = recovered.indexOf("--effort");
  if (index >= 0 && recovered[index + 1]) recovered[index + 1] = effort;
  else recovered.push("--effort", effort);
  return shellCommand([process.execPath, posixish(resolve(dirname(fileURLToPath(import.meta.url)), "dispatch_prepare.ts")), ...recovered]);
}

interface Parsed {
  project: string; targetRoot: string; pm: string; role: string; slug: string; base: string;
  blueprint: string; pipelinePackage: string; inModel: string; inEffort: string; inScope: string;
  inTags: string; inTouches: string; inDepends: string; inCommitMode: string;
  inResourceClass: string; inRuntimeEffect: string; inHeavyTier: string; inBashBudgetMs: string; provider: string; providerTransport: string; taskFile: string;
  reuse: string; row: string;
  workId: string; controlSession: string;
  recoverRole: boolean; recoveryDispatch: string; recoveryBranch: string; recoveryReason: string;
  rebindAuthority: boolean; dispatchId: string; evidence: string; candidateSha: string;
  expectedPreviousDigest: string; expectedPreviousDigestSet: boolean;
  itemAuthority: string; assignmentPath: string; promptPath: string; initialInstructionsPath: string;
  recoveryWip: string[]; acceptanceIds: string[];
  approvedRemotes: string[];
  allowConflict: boolean; fullGate: boolean; rework: boolean; force: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const p: Parsed = {
    project: "", targetRoot: "", pm: "", role: "", slug: "", base: "", blueprint: "",
    pipelinePackage: "", inModel: "", inEffort: "", inScope: "", inTags: "", inTouches: "",
    inDepends: "", inCommitMode: "", inResourceClass: "", inRuntimeEffect: "", inHeavyTier: "", inBashBudgetMs: "", provider: "", providerTransport: "",
    taskFile: "", reuse: "", row: "",
    workId: "", controlSession: "",
    recoverRole: false, recoveryDispatch: "", recoveryBranch: "", recoveryReason: "",
    rebindAuthority: false, dispatchId: "", evidence: "", candidateSha: "",
    expectedPreviousDigest: "", expectedPreviousDigestSet: false,
    itemAuthority: "", assignmentPath: "", promptPath: "", initialInstructionsPath: "",
    recoveryWip: [], acceptanceIds: [], approvedRemotes: [],
    allowConflict: false, fullGate: false, rework: false, force: false,
  };
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": p.project = valueAfter(argv, i); i += 2; break;
      case "--target-root": p.targetRoot = valueAfter(argv, i); i += 2; break;
      case "--pm-id": p.pm = valueAfter(argv, i); i += 2; break;
      case "--role": p.role = valueAfter(argv, i); i += 2; break;
      case "--slug": p.slug = valueAfter(argv, i); i += 2; break;
      case "--base": p.base = valueAfter(argv, i); i += 2; break;
      case "--blueprint": p.blueprint = valueAfter(argv, i); i += 2; break;
      case "--pipeline-package": p.pipelinePackage = valueAfter(argv, i); i += 2; break;
      case "--model": p.inModel = valueAfter(argv, i); i += 2; break;
      case "--effort": p.inEffort = valueAfter(argv, i); i += 2; break;
      case "--scope": p.inScope = valueAfter(argv, i); i += 2; break;
      case "--tags": p.inTags = valueAfter(argv, i); i += 2; break;
      case "--touches": p.inTouches = valueAfter(argv, i); i += 2; break;
      case "--depends-on": p.inDepends = valueAfter(argv, i); i += 2; break;
      case "--commit-mode": p.inCommitMode = valueAfter(argv, i); i += 2; break;
      case "--resource-class": p.inResourceClass = valueAfter(argv, i); i += 2; break;
      case "--runtime-effect": p.inRuntimeEffect = valueAfter(argv, i); i += 2; break;
      case "--heavy-tier": p.inHeavyTier = valueAfter(argv, i); i += 2; break;
      case "--bash-budget-ms": p.inBashBudgetMs = valueAfter(argv, i); i += 2; break;
      case "--provider": p.provider = valueAfter(argv, i); i += 2; break;
      case "--provider-transport": p.providerTransport = valueAfter(argv, i); i += 2; break;
      case "--task-file": p.taskFile = valueAfter(argv, i); i += 2; break;
      case "--reuse": p.reuse = valueAfter(argv, i); i += 2; break;
      case "--row": p.row = valueAfter(argv, i); i += 2; break;
      case "--work-id": p.workId = valueAfter(argv, i); i += 2; break;
      case "--control-session": p.controlSession = valueAfter(argv, i); i += 2; break;
      case "--recover-role": p.recoverRole = true; i++; break;
      case "--rebind-authority": p.rebindAuthority = true; i++; break;
      case "--id": p.dispatchId = valueAfter(argv, i); i += 2; break;
      case "--evidence": p.evidence = valueAfter(argv, i); i += 2; break;
      case "--candidate-sha": p.candidateSha = valueAfter(argv, i); i += 2; break;
      case "--recovery-dispatch": p.recoveryDispatch = valueAfter(argv, i); i += 2; break;
      case "--recovery-branch": p.recoveryBranch = valueAfter(argv, i); i += 2; break;
      case "--recovery-reason": p.recoveryReason = valueAfter(argv, i); i += 2; break;
      case "--expected-previous-digest": p.expectedPreviousDigest = valueAfter(argv, i); p.expectedPreviousDigestSet = true; i += 2; break;
      case "--item-authority": p.itemAuthority = valueAfter(argv, i); i += 2; break;
      case "--assignment-path": p.assignmentPath = valueAfter(argv, i); i += 2; break;
      case "--prompt-path": p.promptPath = valueAfter(argv, i); i += 2; break;
      case "--initial-instructions-path": p.initialInstructionsPath = valueAfter(argv, i); i += 2; break;
      case "--recovery-wip": p.recoveryWip.push(valueAfter(argv, i)); i += 2; break;
      case "--acceptance-id": p.acceptanceIds.push(valueAfter(argv, i)); i += 2; break;
      case "--approved-remote": p.approvedRemotes.push(valueAfter(argv, i)); i += 2; break;
      case "--allow-conflict": p.allowConflict = true; i++; break;
      case "--full-gate": p.fullGate = true; i++; break;
      case "--rework": p.rework = true; i++; break;
      case "--force": p.force = true; i++; break;
      case "-h": case "--help": out(HELP); process.exit(0);
      default:
        err(`dispatch_prepare: unknown arg: ${argv[i]}`);
        if (existsSync(argv[i])) err(`dispatch_prepare: hint: '${argv[i]}' is an existing path — a glob-valued flag was almost certainly left UNQUOTED, so the shell expanded it into multiple words before this script ran (e.g. --touches docs/** became --touches docs/main docs/engine …). Single-quote the value so no pathname expansion happens: --touches 'docs/**' (same for --depends-on). See W-054.`);
        // W-622 / G-2: derived from the published inventory, never restated, so
        // adding a `case` without listing the flag turns the paired test RED.
        fail(`dispatch_prepare: valid flags: ${DISPATCH_PREPARE_FLAGS.join(" ")} -h/--help`);
    }
  }
  return p;
}

function parseAttendedSeatArgs(argv: string[]): SpawnOptions {
  const out: SpawnOptions = { role: "" };
  const fenceRoots: string[] = [];
  const approvedRemoteDestinations: ReturnType<typeof parseApprovedRemoteSpec>[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`dispatch_prepare: ${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--role": out.role = next(); break;
      case "--slug": out.slug = next(); break;
      case "--project": out.project = next(); break;
      case "--pm-id": out.pmId = next(); break;
      case "--garelier-root": out.garelierRoot = next(); break;
      case "--dispatch-id": out.dispatchId = next(); break;
      case "--worktree": out.worktree = next(); break;
      case "--fence-root": fenceRoots.push(next()); break;
      case "--approved-remote": approvedRemoteDestinations.push(parseApprovedRemoteSpec(next())); break;
      case "--model": out.model = next(); break;
      case "--effort": out.effort = next(); break;
      case "--provider": {
        const provider = next();
        if (provider !== "codex" && provider !== "claude-code") {
          throw new Error(`dispatch_prepare: --provider must be codex|claude-code (got '${provider}')`);
        }
        out.provider = provider;
        break;
      }
      case "--task-ref": out.taskRef = next(); break;
      case "--blueprint": out.blueprint = next(); break;
      case "--prompt-file": out.promptFile = next(); break;
      default: throw new Error(`dispatch_prepare: unknown argument '${arg}'`);
    }
  }
  if (fenceRoots.length) out.fenceRoots = fenceRoots;
  if (approvedRemoteDestinations.length) out.approvedRemoteDestinations = approvedRemoteDestinations;
  return out;
}

function parseAttendedAckLaunchArgs(argv: string[]): Partial<AckLaunchOptions> {
  const out: Partial<AckLaunchOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`dispatch_prepare: ${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--ack-launch": break;
      case "--project": out.project = next(); break;
      case "--pm-id": out.pmId = next(); break;
      case "--dispatch-id": out.dispatchId = next(); break;
      case "--agent-handle": out.agentHandle = next(); break;
      case "--parent-id": out.parentId = next(); break;
      default: throw new Error(`dispatch_prepare: unknown argument '${arg}' for --ack-launch`);
    }
  }
  return out;
}

function runAttendedSeatCli(argv: string[]): { code: number; message: string } {
  if (argv.includes("--ack-launch")) {
    let options: Partial<AckLaunchOptions>;
    try { options = parseAttendedAckLaunchArgs(argv); } catch (error) { return { code: 2, message: String(error) }; }
    for (const [flag, value] of [["--project", options.project], ["--pm-id", options.pmId], ["--dispatch-id", options.dispatchId], ["--agent-handle", options.agentHandle], ["--parent-id", options.parentId]] as const) {
      if (!value) return { code: 2, message: `dispatch_prepare: --ack-launch requires ${flag}` };
    }
    try { return { code: 0, message: JSON.stringify(runAckLaunch(options as AckLaunchOptions), null, 2) }; }
    catch (error) { return { code: 1, message: String(error) }; }
  }
  let options: SpawnOptions;
  try { options = parseAttendedSeatArgs(argv); } catch (error) { return { code: 2, message: String(error) }; }
  if (!options.role) return { code: 2, message: "dispatch_prepare: --attended-seat requires --role" };
  try { return { code: 0, message: JSON.stringify(runAttendedSpawn(options), null, 2) }; }
  catch (error) { return { code: 1, message: String(error) }; }
}

function containerRole(dispatchRoot: string, name: string): string {
  try {
    const pack = JSON.parse(text(resolve(dispatchRoot, name, "context.json"))) as { task?: { role?: unknown } };
    return pack.task?.role ? String(pack.task.role) : "";
  } catch { return ""; }
}

/**
 * A duplicate is the SAME ROLE already in flight on the same slug — producing a
 * second one would silently duplicate the work.
 *
 * The role is part of the key because a gate seat reviewing a producer's work is
 * SUPPOSED to carry that producer's slug: the seat's identity (agent name, verdict
 * path, prompt) is derived as `<role>` + `<slug>`, so a shared slug yields distinct
 * seats, and the branch slug is what ties a verdict to the branch it reviewed.
 * Matching on slug alone refused exactly that pairing, which forced operators to
 * invent role-suffixed slugs for gate seats — and a slug that already ends in the
 * role makes the derived verdict path `<slug>-<role>-<role>.md`, a second path for
 * one seat that the seat then has to choose between. Keying on (role, slug) removes
 * the reason to rename, so the seat has one derived path again.
 */
export function duplicateDispatch(dispatchRoot: string, prefix: string, slug: string, role: string): { name: string; state: string } | undefined {
  let names: string[] = [];
  try { names = readdirSync(dispatchRoot).filter((name) => name.startsWith(prefix)).sort(); } catch { return undefined; }
  for (const name of names) {
    const statePath = resolve(dispatchRoot, name, "STATE.md");
    if (!existsSync(statePath)) continue;
    const raw = text(statePath);
    const task = raw.match(/^##\s*Current task\s*$[\s\S]*?^\s*\S+\s+(\S+)/m)?.[1] ?? "";
    if (task !== slug) continue;
    const existing = containerRole(dispatchRoot, name);
    // An unreadable role stays a duplicate: fail closed rather than allow a second
    // dispatch of work whose role could not be established.
    if (existing && role && existing !== role) continue;
    const state = raw.match(/^##\s*Status\s*$[\s\S]*?^\s*(\S+)/m)?.[1]?.replace(/\s/g, "") ?? "?";
    return { name, state };
  }
  return undefined;
}

function rollbackReusableResume(publication: ResumeTransitionResult): void {
  if (readFileSync(publication.statePath, "utf8") !== publication.publishedState) {
    throw new Error("warm-reuse STATE.md changed before rollback");
  }
  writeFileSync(publication.statePath, publication.previousState);
  if (publication.previousMarker === null) rmSync(publication.markerPath, { force: true });
  else writeFileSync(publication.markerPath, publication.previousMarker);
}

interface NextIdLockOwner {
  pid: number;
  ts: string;
  kind: "next_id";
  nonce: string;
}

interface NextIdLockObservation {
  owner: NextIdLockOwner | null;
  source: string | null;
  device: bigint;
  inode: bigint;
  mtimeMs: number;
}

const INCOMPLETE_NEXT_ID_LOCK_STALE_MS = 1_000;

function observeNextIdLock(lock: string): NextIdLockObservation | null {
  const ownerPath = `${lock}/owner`;
  try {
    const directory = lstatSync(lock, { bigint: true });
    if (directory.isSymbolicLink() || !directory.isDirectory()) return null;
    const mtimeMs = Number(directory.mtimeMs);
    if (!Number.isFinite(mtimeMs)) return null;
    if (!existsSync(ownerPath)) return { owner: null, source: null, device: directory.dev, inode: directory.ino, mtimeMs };
    const file = lstatSync(ownerPath, { bigint: true });
    if (file.isSymbolicLink() || !file.isFile() || file.size > 64n * 1024n) return null;
    const source = readFileSync(ownerPath, "utf8");
    let value: Record<string, unknown>;
    try { value = JSON.parse(source) as Record<string, unknown>; }
    catch { return { owner: null, source, device: directory.dev, inode: directory.ino, mtimeMs }; }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || value.kind !== "next_id"
      || typeof value.ts !== "string" || !Number.isFinite(Date.parse(value.ts))
      || typeof value.nonce !== "string" || !/^[0-9a-f-]{36}$/.test(value.nonce)) {
      return { owner: null, source, device: directory.dev, inode: directory.ino, mtimeMs };
    }
    return { owner: value as unknown as NextIdLockOwner, source, device: directory.dev, inode: directory.ino, mtimeMs };
  } catch { return null; }
}

function readNextIdLockOwner(lock: string): { owner: NextIdLockOwner; source: string; device: bigint; inode: bigint } | null {
  const observed = observeNextIdLock(lock);
  return observed?.owner && observed.source !== null
    ? { owner: observed.owner, source: observed.source, device: observed.device, inode: observed.inode }
    : null;
}

function reclaimDeadNextIdLock(lock: string): boolean {
  const observed = observeNextIdLock(lock);
  if (!observed) return false;
  const deadOwner = observed.owner !== null && !pidAlive(observed.owner.pid);
  const staleIncomplete = observed.owner === null
    && Date.now() - observed.mtimeMs >= INCOMPLETE_NEXT_ID_LOCK_STALE_MS;
  if (!deadOwner && !staleIncomplete) return false;
  const current = observeNextIdLock(lock);
  if (!current || current.source !== observed.source || current.device !== observed.device
    || current.inode !== observed.inode || current.mtimeMs !== observed.mtimeMs
    || Boolean(current.owner) !== Boolean(observed.owner)) return false;
  if (current.owner && pidAlive(current.owner.pid)) return false;
  const quarantine = `${lock}.reclaimed-${process.pid}-${randomUUID()}`;
  try { renameSync(lock, quarantine); }
  catch { return false; }
  try {
    const moved = lstatSync(quarantine, { bigint: true });
    if (moved.dev !== observed.device || moved.ino !== observed.inode) {
      throw new Error(`next_id lock reclaim identity changed after rename: ${quarantine}`);
    }
    removeTreeSync(quarantine);
    return true;
  } catch (error) {
    try { if (!existsSync(lock) && existsSync(quarantine)) renameSync(quarantine, lock); } catch { /* preserve quarantine for inspection */ }
    throw error;
  }
}

function releaseNextIdLock(lock: string, nonce: string): void {
  const current = readNextIdLockOwner(lock);
  if (!current || current.owner.pid !== process.pid || current.owner.nonce !== nonce) return;
  const quarantine = `${lock}.released-${process.pid}-${nonce}`;
  try { renameSync(lock, quarantine); }
  catch { return; }
  try { removeTreeSync(quarantine); } catch { /* next acquisition is no longer blocked */ }
}

export async function claimId(project: string, pm: string): Promise<string> {
  const idFile = `${project}/__garelier/${pm}/runtime/backlog/next_id`;
  mkdirSync(dirname(idFile), { recursive: true });
  const lock = `${idFile}.lock`;
  let acquired = false;
  const nonce = randomUUID();
  for (let tries = 0; tries < 50; tries++) {
    try {
      mkdirSync(lock);
      try {
        const owner: NextIdLockOwner = { pid: process.pid, ts: utcIsoSeconds(), kind: "next_id", nonce };
        writeFileSync(`${lock}/owner`, `${JSON.stringify(owner)}\n`, { flag: "wx" });
      } catch (error) {
        try { removeTreeSync(lock); } catch { /* surface the original publication failure */ }
        throw error;
      }
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (reclaimDeadNextIdLock(lock)) continue;
      await Bun.sleep(100);
    }
  }
  if (!acquired) {
    err(`dispatch_prepare: could not lock ${lock} after 5s`);
    fail(`dispatch_prepare: next_id lock has a live or unverifiable owner; retained for inspection at ${lock}/owner`, 1);
  }
  try {
    if (!existsSync(idFile)) writeFileSync(idFile, "1\n");
    const id = text(idFile).replace(/[^0-9]/g, "");
    if (!id) fail(`dispatch_prepare: ${idFile} is not a number`, 1);
    writeFileSync(idFile, `${Number(id) + 1}\n`);
    return id;
  } finally { releaseNextIdLock(lock, nonce); }
}

function reportScaffold(id: string, slug: string, role: string, branch: string): string {
  // `bind_review_sha` writes `[gate] review_sha` / `declared_base_sha` /
  // `gate_log` into BOTH producer artifacts, so the report carries the same
  // front matter the lane result does. Its prose sections stay below the
  // closing `+++`.
  //
  // W-709: the scaffold does NOT seed `declared_base_sha`. It used to write the
  // SHORT base SHA here, which the binder then compared against the full base it
  // resolves itself and refused as `declared_base_sha changes from … to …` — the
  // driver seeding a value its own binder rejected. The field is driver-owned:
  // nothing writes it before `bind_review_sha` derives it.
  return renderMachineArtifact(
    [{ name: "gate", fields: [["branch", branch]] }],
    `# Report - #${id} ${slug} (${role})\n\n` +
    `<!-- Register-canonical (W-019): if the harness blocks writing this file, your compact\n` +
    `     register message IS the canonical record - the PM transcribes it here at cleanup via\n` +
    `     \`dispatch_cleanup.ts --report-from-file <path>\`. Do not stall completion on this write. -->\n\n` +
    `## Status\n\n(REPORTING | BLOCKED)\n\n` +
    `## Summary\n\n(what changed and why - compact; reference paths/SHAs, never paste diffs)\n\n` +
    `## Gates\n\n(commands run + results)\n\n` +
    `## Evidence\n\n(red->green proof, measurements, writer-audit conclusions)\n\n` +
    `## Context pack gaps\n\n(facts you had to rediscover that the assignment/blueprint should have carried - exact paths, invariants, verify commands; "none" when the context pack sufficed - DEC-071)\n`,
  );
}

function instructionLedger(id: string, slug: string): string {
  return renderMachineArtifact(
    [{ name: "ledger", fields: [["dispatch", `#${id}`], ["slug", slug]] }],
    `# Instruction ledger - #${id} ${slug}\n\n` +
    `W-092 - guards the "PM scope-change crosses the dispatched role's completion register" class.\n\n` +
    `PM: append ONE \`[[instruction]]\` table per added instruction, above the closing \`+++\`; never rewrite\n` +
    `a prior entry. Each table carries \`id = 'I<n>'\`, \`message = '''<one line>'''\` and \`checked = false\`.\n\n` +
    `Dispatched role: BEFORE REPORTING, set \`checked = true\` on EVERY entry and add\n` +
    `\`consumed = '''artifact:<project-relative-path> | commit:<40hex>'''\`. The value is a TOML string:\n` +
    `parentheses, backticks, quotes and newlines are ordinary characters and need no escaping, so never\n` +
    `reword evidence to suit the parser. Use \`'''...'''\` for anything multi-line.\n\n` +
    `Scope: only Codex proxy transcription rejects \`consumed = 'register'\` and requires artifact/commit;\n` +
    `a producer writing its own ledger may use any non-empty consumed evidence.\n\n` +
    `Do NOT reach REPORTING while any entry is \`checked = false\`; state "ledger N/N consumed" in your register.\n\n` +
    `W-041 - instructions can ALSO arrive as teammate MESSAGES (SendMessage), which do NOT land in this\n` +
    `file by themselves. Dispatched role: on receiving a message-borne instruction, APPEND a\n` +
    `\`[[instruction]]\` table with \`id = 'M<n>'\` yourself BEFORE acting, then check it off like any entry -\n` +
    `so the ledger stays the single audit surface and the PM never mistakes a consumed message for a\n` +
    `dropped one.\n\n` +
    `(no instructions yet - the PM appends \`[[instruction]]\` tables to the front matter as scope changes)\n`,
  );
}

function routing(project: string, pm: string, seat: string, extras: string[]): Record<string, any> | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const path = resolve(moduleDir, "../dispatch/model_routing.ts");
  const r = runQuiet(["bun", path, "--project", project, "--pm-id", pm, "--seat", seat, ...extras]);
  if (r.code !== 0) return undefined;
  try { return JSON.parse(r.stdout); } catch { return undefined; }
}

function commitRule(commitMode: string, id: string, pm: string, role: string, model: string): string {
  if (commitMode === "proxy") return `- Commit (PROXY mode — W-042): you CANNOT run git add / git commit / git stash in this worktree (the sandbox denies writes to its gitdir; .git here is a pointer into the parent repo's protected .git/worktrees/). NEVER attempt them. Instead, at each commit-worthy milestone write a COMMIT PLAN into your report: the exact file list + the full commit message (subject ends with [#${id}]; blank line; then this trailer VERBATIM, replacing {{TASK_ID}} with the bound backlog id, e.g. W-123):
    Garelier: ${pm} ${role}#${id} {{TASK_ID}}
    Garelier-Seat: codex ${model} (proxy-commit via dock seat)
  BOTH trailer lines are mandatory — the Garelier-Seat line is the provenance marker so the Dock/reviewers always see the commit is codex-produced and proxy-committed: the git committer is the dock-seat occupant (often the PM sitting in the Dock seat), NOT the author of the change. Explain WHY in the body; never paste diffs. git READ commands (status/log/diff) are fine.
  Dock-side duties on a proxy commit (guardian W-042): (1) BEFORE committing, diff the worktree's ACTUAL changed files against the dispatch's declared --touches scope and reconcile any out-of-scope path — refuse or escalate (never commit blind) on hooks-adjacent / CI-workflow / .gitattributes / .gitignore / validator files not covered by the declared scope; (2) the Dock writes the Garelier-Seat trailer FROM THE DISPATCH JSON (commit_mode/model), overwriting the plan's line if they disagree — the dispatched role's trailer text is advisory, the dispatch record is authoritative; (3) AFTER committing (guardian round-2 N1), the Dock self-checks with 'bun skills/garelier-core/scripts/lint_commits.ts --last --require-seat-trailer <checkout>' — a non-zero exit means the trailer it just wrote is missing/malformed; fix it (amend or a follow-up commit) before reporting the commit onward. merge_land.ts also re-checks this at land time from context.json's commit_mode, so a forgotten self-check is still caught, but do not rely on that as your check.`;
  return `- Commit: the subject ends with [#${id}]; end the message with a blank line then this trailer VERBATIM, replacing {{TASK_ID}} with the bound backlog id (e.g. W-123):
    Garelier: ${pm} ${role}#${id} {{TASK_ID}}
  Explain WHY the change is needed; never paste diffs.`;
}

export function promptPreamble(p: Parsed, id: string, branch: string, baseSha: string, container: string, commitMode: string, model: string, provider: string, resultPath = "", standing: string[] = [], sourcePointers: RoleSourcePointerOptions = {
  blueprintPath: p.blueprint || null,
  lens: { ref: null, source: "none", registry_path: null, pack_path: null },
}): string {
  // W-191 (a): the project's standing constraints, bundled once so the PM never
  // restates them per dispatch. Empty => no block (a project with no [prompt]).
  const standingBlock = standing.length
    ? standing.map((c) => `- Standing constraint (project, W-191): ${c}`).join("\n") + "\n"
    : "";
  const baseTrack = commitMode === "proxy"
    ? `- Branch: ${branch}. Base-track is handled by the DOCK SEAT at proxy-commit time (W-072): the sandbox denies gitdir writes, so 'git merge' here dies at ORIG_HEAD.lock — do NOT attempt it and do NOT stall on it. If you notice the studio tip moved past your base (${baseSha}) while working, note it in your report; the Dock seat merges and resolves conflicts before the gate.`
    : `- Branch: ${branch}. At pickup, base-track FIRST: merge the studio tip into your branch (merge, never rebase) and resolve any conflicts yourself before implementing. When parallel lanes exist, base-track AGAIN immediately before merge submission, so that the whole-project quality-gate command the Dock seat runs from your REQUIRED GATE block executes on that tracked tree (W-372): a branch-bound self-gate cannot see a semantic conflict that exists only in the merge result, so a passing scoped check on a stale base proves nothing about the merge. merge_land warns (not blocks) when your recorded base is behind the studio tip at submit time — do not wait for that warning before re-checking (the DEC-083 dock_integrate route does not warn yet — W-378). A whole-project check is heavy and may serialize behind the heavy-compile lock if another lane is mid-submit at the same time; budget for that wait.`;
  const terminate = commitMode === "proxy"
    ? "- Register-terminate (W-085): your LAST turn MUST end with the compact register message (final STATE, branch + commit plan submitted (Dock commits — PROXY mode, no SHA yet), report path, gate result, any BLOCKED question) - a commit-plan/STATE update alone is not a completion signal."
    : "- Register-terminate (W-085): your LAST turn MUST end with the compact register message (final STATE, branch + commit SHA, report path, gate result, any BLOCKED question) - a commit/STATE update alone is not a completion signal.";
  const runtimeRecovery = provider === "codex" && commitMode === "proxy"
    ? "- Runtime recovery: include one `GARELIER_RUNTIME_STATUS: {\"runtime_ok\": true|false, ...}` marker immediately BEFORE the final COMMIT PLAN block; `=== END COMMIT PLAN ===` remains the result's final line."
    : `- ${CLAUDE_ROLE_PROMPT_CONTRACT_MARKER} MUST be exactly one \`GARELIER_RUNTIME_STATUS: {"runtime_ok": true|false, ...}\` marker.`;
  const commitContract = provider === "codex" && commitMode === "proxy"
    ? codexProviderContract({
      worktree: `${container}/checkout`,
      branch,
      baseSha,
      subjectSuffix: `[#${id}]`,
      trailer: `Garelier: ${p.pm} ${p.role}#${id} {{TASK_ID}}`,
      seatTrailer: `Garelier-Seat: codex ${model || "config-default"} (proxy-commit via dock seat)`,
    })
    : `${baseTrack}\n${requiredGateDelegationContract(DOCK_RUN_REQUIRED_GATE_REASON)}\n${commitRule(commitMode, id, p.pm, p.role, model)}`;
  const resultStateContract = provider === "codex" && commitMode === "proxy"
    ? ""
    : `\n- ${DISPATCH_RESULT_STATE_FIRST_LINE_CONTRACT}`;
  const resultContract = resultPath
    ? `\n- Result/report contract: your final response is captured at ${resultPath}. The launcher overwrites that file with the final response, and gate_runner may consume it with --from-register. Include every item required by the blueprint Output definition; this container-local file is the canonical provider result when no reporting channel exists.`
    : "";
  const deliveryContract = resultPath
    ? `- Delivery: when a reporting channel (Dock / team-lead) exists, the register AND every progress message MUST be SENT via SendMessage. When no reporting channel exists, the recorded CLI-captured canonical provider result named above is the valid completion record. Plain uncaptured final output remains a non-signal.`
    : `- Delivery (W-146): when a reporting channel (Dock / team-lead) exists, the register AND every progress message MUST be SENT via SendMessage. Without a reporting channel and without a recorded CLI result path, completion is BLOCKED. Plain uncaptured final output remains a non-signal.`;
  return `You are the Garelier ${p.role} for dispatch #${id} (${p.slug}).
${renderRoleSourcePointerSection(sourcePointers)}
- QA scope: first-party project and this repository only. A counterfactual proves that an existing test or gate detects the defect; it is not an instruction to affect a third-party system. Phrase refutations as oracle detection evidence.
- Work ONLY inside your checkout worktree: ${container}/checkout - never edit the parent repo / primary checkout. The ONE other writable place is your own dispatch container's canonical artifacts (${container}/report.md, ${container}/STATE.md, ${container}/instructions.md, ${container}/lane/) - writing those IS how you report, and the launcher's write grant has always covered them (W-485). Nothing else under the container, and nothing outside these two, is writable.
${standingBlock}- Showcase/scratch hygiene (W-165): transient artifacts (screenshots, previews, throwaway logs/notes) go under \`__garelier/${p.pm}/showcase/<topic>/\` in a NAMED subfolder, never directly under \`showcase/\`. \`showcase/\` is gitignored and MUST NOT be git-added/committed (a CI lint fails on any tracked showcase file). Durable findings belong in report.md/STATE.md or an inspection summary (summary + source path + repro), not a committed raw dump. Only the user promotes \`showcase/\` → tracked \`gallery/\`.
- Process kill (W-170): to stop YOUR OWN build, kill by explicit PID or filter to your worktree path (\`... | Where-Object { $_.CommandLine -like '*${distinctiveFenceToken(`${container}/checkout`) || `${container}/checkout`}*' } | Stop-Process\`, \`pkill -f '${container}/checkout'\`). NEVER an indiscriminate name/image bulk kill (\`Get-Process cargo,rustc | Stop-Process\`, \`taskkill /IM\`, \`pkill cargo\`) — it stops OTHER lanes' builds (the #371 incident killed the primary's post-merge verify).
${commitContract}${resultStateContract}${resultContract}
- Instruction ledger (W-092): before REPORTING, open instructions.md and set \`checked = true\` on EVERY \`[[instruction]]\` table, each with a non-empty \`consumed = '''…'''\`. The value is a TOML string, so parentheses, backticks, quotes and newlines are ordinary characters that need no escaping — never reword evidence to suit the parser; use \`'''...'''\` for anything multi-line. Only Codex proxy transcription rejects \`consumed = 'register'\` and requires \`artifact:<project-relative-path> | commit:<40hex>\`; a producer writing its own ledger may use any non-empty \`consumed\` evidence. Do not reach REPORTING while any entry is \`checked = false\`. State "ledger N/N consumed" in your register.
${terminate}
${deliveryContract}
- Codex child completion (W-330): a child completion is delivered to its parent automatically. The parent MUST NOT poll a completed child merely to reconfirm completion. This does not prohibit waiting for a running shell/tool process, a durable broker, a merge-gate waiter, or an explicit monitor.
- Caller timeouts (W-330): every timeout-capable command execution specifies a bounded caller timeout selected from the command's verified budget and recovery plan; never rely on a short default. A \`garelier control\` mutation sets at least 60 seconds; merge/land sets at least 120 seconds. After a timeout, do not replay a mutation: read canonical state first. Record any longer verification budget and ceiling in the assignment/runbook.
- Heavy discipline: preserve every required gate as ONE whole command. If it exceeds the read-only foreground budget, write a durable command_ref inside that PM's runtime/long_jobs root, arm the long-job ledger with a reliable wake, then launch the ONE single-flight broker through the operator-owned tracked background facility. Individual jobs are never separate tracked waiters. A normal FINISHED wake means read result/log and ACK; never rerun it.
- Background self-check (W-363): whether a job is an armed long job OR a plain run_in_background, its completion notification CAN be lost (measured: 7+ times in one 24h session a background job finished and the seat was never re-woken, each recovered only by a PM manual wake). Do not trust the notification alone. If \`dispatch_watch\` is armed for you and reports \`BG-COMPLETION-UNACKED\`, that names a job your long-job ledger shows FINISHED that you have not read or ACKed yet — on ANY wake (a real notification, a PM nudge, or a resume), your FIRST action is to check every outstanding background job's result/log/ledger state BEFORE doing anything else, never assume "nothing happened yet."
- Recovery: after foreground timeout, FAILED, or stale/lost RUNNING, inspect recorded runner/child pid, log, exit evidence, cwd/worktree, and command digest. Only after no live orphan remains may the SAME whole command be explicitly rearmed as the next attempt. Never split the gate, partially resume it, or change timeout settings.
${runtimeRecovery}
- Timeout settings are input-only context. Do not write settings, alter timeout environment variables, inject them into child env, or suggest raising them.
- End EVERY turn one of two ways: (a) the compact register, or (b) a progress message WITH a background job still running. Falling silent at a milestone (commit, compile start, report) is a stall and a violation. NEGATIVE EXAMPLE (W-200, the single most frequent silent-idle shape, 2026-07-20): you START a build/test then end the turn to "wait" for it WITHOUT a live background job — there is nothing to wake you, so you sit idle forever. A waiting turn is only legal when a background job is actually running (form (b)); if you have no background job you have nothing to wait for, so DO NOT end the turn to wait — either launch the job in the background first, or send a progress message naming the remaining steps + your next concrete action.
- Instructions may arrive as teammate MESSAGES mid-flight (W-041): append each to the container instructions.md ledger yourself as an \`[[instruction]]\` table with \`id = 'M<n>'\`, \`message = '''<one line> (via message)'''\` and \`checked = false\`, placed above the closing \`+++\`, BEFORE acting; set \`checked = true\` with \`consumed\` when consumed, and count them in your register (ledger N/N + messages M/M consumed).
- Output control (output_control.md): your final response and every progress message use the compressed register - no greeting/thanks/request-echo/self-narration, fragments fine; durable detail goes in report.md/STATE.md NOT the response; an id/SHA/path reference replaces re-explaining it. NEVER shorten code symbols, paths, commands, error text, numbers, SHAs, or risks/blockers/warnings. The register-terminate rule above is still mandatory - compressed does not mean omitted.
- Token budget: progress registers are POINTER + DELTA, never a restatement. That rule applies to report.md / STATE.md / verdict-file pointers and progress messages; it does not permit omitting any blueprint-required content from the CLI-captured final response that becomes lane/result.md and gate input. Do NOT re-send a progress register already sent: if a message crosses in flight, reply with the crossed msg-id + a ONE-LINE delta.
- Do NOT push any branch; the operator integrates it through the merge gate.`;
}

function roleSeatPreamble(
  role: RoleKind,
  id: string,
  projectRoot: string,
  outputPath: string,
  launcherCaptured: boolean,
  sourcePointers: RoleSourcePointerOptions,
): string {
  const readonly = role !== "concierge";
  return `[Garelier role-seat contract v1]
role=${role}
${renderRoleSourcePointerSection(sourcePointers)}
- QA scope: first-party project and this repository only. A counterfactual proves that an existing test or gate detects the defect; it is not an instruction to affect a third-party system. Phrase refutations as oracle detection evidence.
- Repository: ${posixish(resolve(projectRoot))}
- ${readonly
    ? "The repository has no write grant: inspect it, but do not create, edit, delete, stage, commit, merge, or restore repository files. Only the designated artifact directory is writable."
    : "Use only the assigned clipboard worktree. Preserve external.lock, approved-remote, and non-force-push constraints; do not implement code."}
- ${launcherCaptured
    ? `Deliver the complete ${role} artifact as the final response. The trusted provider launcher captures it at ${posixish(resolve(outputPath))}; no other output path is granted.`
    : `Write the complete ${role} artifact directly to ${posixish(resolve(outputPath))}; no other output path is granted.`}
${role === "guardian" ? "- Mandatory scanners use the PM-delegated, SHA-bound evidence route in context.json guard.mandatory_scanner; do not request or add a repository write grant." : ""}
- Binding: dispatch #${id} role-seat identity is independent from the role identity. Never reuse a role generation.
- Raw provider invocation remains forbidden; launch only through the emitted provider route.`;
}

function canonicalRecoveryFile(projectRoot: string, value: string, label: string): string {
  if (!value) fail(`dispatch_prepare: role recovery requires ${label}`, 4);
  const path = canonicalPath(value, projectRoot);
  const rel = relative(projectRoot, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`dispatch_prepare: role recovery ${label} escapes the project: ${value}`, 4);
  }
  try {
    if (!statSync(path).isFile()) fail(`dispatch_prepare: role recovery ${label} is not a file: ${value}`, 4);
  } catch {
    fail(`dispatch_prepare: role recovery ${label} is missing: ${value}`, 4);
  }
  return path;
}

function recoveryReason(value: string): RecoverRoleAuthorizationOptions["recovery"]["reason"] {
  switch (value) {
    case "bindingless_migration":
    case "stall_handoff":
    case "provider_replacement":
    case "base_track":
      return value;
    default:
      fail(`dispatch_prepare: role recovery reason is unsupported: ${value}`, 4);
  }
}

function currentRoleAuthorizationOrNull(
  projectRoot: string,
  pmId: string,
  identity: ReturnType<typeof dispatchExecutionIdentity> | ReturnType<typeof roleExecutionIdentityForBranch>,
): RoleAuthorization | null {
  try {
    return readCurrentRoleAuthorization({ project_root: projectRoot, pm_id: pmId, identity });
  } catch (error) {
    if ((error as Error).message.startsWith("no current role binding exists")) return null;
    throw error;
  }
}

function recoveryDispatchId(p: Parsed): string {
  if (p.recoveryDispatch) return p.recoveryDispatch;
  const id = /\/#([1-9][0-9]*)\//.exec(p.recoveryBranch.replace(/\\/g, "/"))?.[1];
  if (!id) fail("dispatch_prepare: role recovery branch has no canonical dispatch number", 4);
  return id;
}

function recoveryWorktree(gitRoot: string, branch: string, fallback: string): string {
  if (!branch) return fallback;
  let worktree = "";
  for (const line of gitOut(gitRoot, ["worktree", "list", "--porcelain"]).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}` && worktree) return canonicalPath(worktree);
    if (line === "") worktree = "";
  }
  return fallback;
}

interface RecoveryControlBindingRecord {
  schema_version: 3;
  dispatch_id: string;
  work_id: string;
  session_id: string;
  touches: string[];
  base_sha: string;
}

interface ValidatedRecoveryDispatchContext {
  baseSha: string;
  declaredTouches: string[];
}

function recoveryControlTouches(worktree: string, wip: Array<{ path: string }>): string[] {
  const touches = wip.map((entry) => {
    const rel = relative(worktree, entry.path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`schema-bound role recovery WIP escapes the recovered worktree: ${entry.path}`);
    }
    return rel.replace(/\\/g, "/");
  });
  if (new Set(touches).size !== touches.length) throw new Error("schema-bound role recovery WIP contains duplicate touches");
  return touches.sort();
}

function declaredTouchContainsWip(declaredTouch: string, wipTouch: string): boolean {
  const rel = relative(declaredTouch, wipTouch);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readRecoveryChainAuthorization(options: {
  projectRoot: string;
  pmId: string;
  identity: RoleAuthorization["core"]["execution_identity"];
  bindingId: string;
  generation: number;
}): RoleAuthorization {
  const paths = roleBindingPaths(options.projectRoot, options.pmId, options.identity, options.generation);
  const path = paths.authorization;
  let authorization: RoleAuthorization;
  try {
    authorization = readRoleAuthorizationFile(path);
  } catch (error) {
    throw new Error(`role predecessor authorization is missing or unreadable at generation ${options.generation}: ${(error as Error).message}`);
  }
  const digest = roleAuthorizationDigest(authorization.core);
  if (authorization.schema_version !== 1 || authorization.kind !== ROLE_RECORD_KIND.authorization
    || options.bindingId !== basename(paths.root) || authorization.binding_id !== options.bindingId || authorization.core_digest !== digest
    || authorization.core?.schema_version !== 1 || authorization.core?.kind !== ROLE_RECORD_KIND.bindingCore
    || authorization.core.namespace?.pm_id !== options.pmId
    || authorization.core.generation !== options.generation
    || canonicalJson(authorization.core.execution_identity) !== canonicalJson(options.identity)) {
    throw new Error(`role predecessor authorization is non-canonical or forged at generation ${options.generation}`);
  }
  return authorization;
}

function validateRecoveryRolePredecessor(options: {
  projectRoot: string;
  pmId: string;
  identity: RoleAuthorization["core"]["execution_identity"];
  current: RoleAuthorization;
  contextBinding: unknown;
}): void {
  const contextBinding = options.contextBinding as ReturnType<typeof bindingReference>;
  const currentReference = bindingReference(options.current);
  if (!contextBinding || typeof contextBinding !== "object"
    || !Number.isSafeInteger(contextBinding.generation) || contextBinding.generation < 1
    || contextBinding.generation >= currentReference.generation
    || contextBinding.binding_id !== currentReference.binding_id
    || !/^[0-9a-f]{64}$/.test(contextBinding.binding_digest)
    || canonicalJson(contextBinding.identity) !== canonicalJson(currentReference.identity)) {
    throw new Error("role recovery context predecessor identity/generation/digest is invalid");
  }
  let previousDigest = "";
  for (let generation = contextBinding.generation; generation <= currentReference.generation; generation++) {
    const authorization = readRecoveryChainAuthorization({
      projectRoot: options.projectRoot,
      pmId: options.pmId,
      identity: options.identity,
      bindingId: currentReference.binding_id,
      generation,
    });
    if (generation === contextBinding.generation) {
      if (canonicalJson(bindingReference(authorization)) !== canonicalJson(contextBinding)) {
        throw new Error("role recovery context predecessor reference is forged or mismatched");
      }
    } else if (authorization.core.carabiner !== "role_recovery" || !authorization.core.recovery
      || authorization.core.supersedes_digest !== previousDigest
      || authorization.core.recovery.supersedes_digest !== previousDigest) {
      throw new Error(`role recovery context predecessor chain is not direct at generation ${generation}`);
    }
    if (generation > contextBinding.generation
      && existsSync(roleBindingPaths(options.projectRoot, options.pmId, options.identity, generation).launch)) {
      throw new Error(`role recovery context predecessor chain generation ${generation} was launched`);
    }
    previousDigest = authorization.core_digest;
  }
  if (previousDigest !== currentReference.binding_digest
    || canonicalJson(readRecoveryChainAuthorization({
      projectRoot: options.projectRoot,
      pmId: options.pmId,
      identity: options.identity,
      bindingId: currentReference.binding_id,
      generation: currentReference.generation,
    })) !== canonicalJson(options.current)) {
    throw new Error("role recovery context predecessor chain does not end at current authorization");
  }
}

function validateRecoveryDispatchContext(options: {
  path: string;
  controlBindingPath: string;
  gitRoot: string;
  schema: 3;
  dispatchId: string;
  workId: string;
  sessionId: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  touches: string[];
  roleBinding: ReturnType<typeof bindingReference> | null;
  rolePredecessor: {
    projectRoot: string;
    pmId: string;
    identity: RoleAuthorization["core"]["execution_identity"];
    current: RoleAuthorization;
  } | null;
}): ValidatedRecoveryDispatchContext | null {
  if (!existsSync(options.path)) return null;
  let rawContext: string;
  let context: Record<string, any>;
  try {
    rawContext = readFileSync(options.path, "utf8");
    context = JSON.parse(rawContext) as Record<string, any>;
  }
  catch (error) { throw new Error(`existing recovery context is unreadable: ${(error as Error).message}`); }
  const contextTouches = recoveryContextPaths(options.gitRoot, context.task?.touches, "recovery context touches", true);
  const contextUnverifiedTouches = context.task && Object.hasOwn(context.task, "touches_unverified")
    ? recoveryContextPaths(options.gitRoot, context.task.touches_unverified, "recovery context unverified touches", true)
    : [];
  const verified = new Set(contextTouches);
  const overlap = contextUnverifiedTouches.filter((path) => verified.has(path));
  if (overlap.length) throw new Error(`recovery context verified/unverified touches overlap: ${overlap.join(",")}`);
  const declaredTouches = [...contextTouches, ...contextUnverifiedTouches].sort();
  if (options.touches.some((wip) => !declaredTouches.some((declared) => declaredTouchContainsWip(declared, wip)))) {
    throw new Error("schema-bound role recovery WIP is outside declared touch union");
  }
  if (options.touches.length > 0
    && declaredTouches.some((declared) => !options.touches.some((wip) => declaredTouchContainsWip(declared, wip)))) {
    throw new Error("recovery context declared touch has no recovery WIP");
  }
  if (contextUnverifiedTouches.length > 0) {
    for (const path of contextTouches) {
      if (resolveTouchedPackages(options.gitRoot, [path]).length === 0) {
        throw new Error(`recovery context verified touch is not package-resolvable: ${path}`);
      }
    }
    for (const path of contextUnverifiedTouches) {
      if (resolveTouchedPackages(options.gitRoot, [path]).length !== 0) {
        throw new Error(`recovery context unverified touch resolves to a package: ${path}`);
      }
    }
  }
  const contextBaseSha = resolveCommit(options.gitRoot, context.task?.base_sha, "recovery context base");
  if (contextBaseSha !== options.baseSha
    && git(options.gitRoot, ["merge-base", "--is-ancestor", contextBaseSha, options.baseSha], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    throw new Error("recovery context base is not an ancestor of the current integration base");
  }
  const contextRoleBinding = roleBindingFromContext(context);
  const roleBindingMatches = !options.roleBinding
    || canonicalJson(contextRoleBinding) === canonicalJson(options.roleBinding);
  if (!roleBindingMatches) {
    if (!options.rolePredecessor) throw new Error("existing recovery context role binding does not match current authorization");
    validateRecoveryRolePredecessor({
      ...options.rolePredecessor,
      contextBinding: contextRoleBinding,
    });
  }
  if (String(context.task?.id ?? "") !== options.dispatchId || context.task?.branch !== options.branch
    || context.task?.base_branch !== options.baseRef
    || context.control?.schema_version !== options.schema || context.control?.work_id !== options.workId
    || context.control?.session_id !== options.sessionId) {
    throw new Error("existing recovery context does not exactly bind dispatch/schema/Work/session/branch/ref");
  }
  let rawControlBinding: string | null = null;
  const controlBindingExists = existsSync(options.controlBindingPath);
  if (controlBindingExists) {
    let controlBinding: RecoveryControlBindingRecord;
    try {
      rawControlBinding = readFileSync(options.controlBindingPath, "utf8");
      controlBinding = JSON.parse(rawControlBinding) as RecoveryControlBindingRecord;
    } catch (error) {
      throw new Error(`existing recovery control binding is unreadable: ${(error as Error).message}`);
    }
    const bindingTouches = recoveryContextPaths(options.gitRoot, controlBinding.touches, "recovery control-binding touches", true);
    const bindingBaseSha = resolveCommit(options.gitRoot, controlBinding.base_sha, "recovery control-binding base");
    const bindingBaseFollowsContext = bindingBaseSha === contextBaseSha
      || git(options.gitRoot, ["merge-base", "--is-ancestor", contextBaseSha, bindingBaseSha], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    const bindingBaseIsCurrentOrAncestor = bindingBaseSha === options.baseSha
      || git(options.gitRoot, ["merge-base", "--is-ancestor", bindingBaseSha, options.baseSha], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    if (canonicalJson(controlBinding) !== canonicalJson({
      schema_version: options.schema,
      dispatch_id: options.dispatchId,
      work_id: options.workId,
      session_id: options.sessionId,
      touches: bindingTouches,
      base_sha: controlBinding.base_sha,
    }) || canonicalJson(bindingTouches) !== canonicalJson(declaredTouches)
      || !bindingBaseFollowsContext || !bindingBaseIsCurrentOrAncestor) {
      throw new Error("existing recovery control binding does not exactly match context/WIP authority");
    }
  }
  let snapshotsUnchanged = false;
  try {
    snapshotsUnchanged = readFileSync(options.path, "utf8") === rawContext
      && existsSync(options.controlBindingPath) === controlBindingExists
      && (!controlBindingExists || readFileSync(options.controlBindingPath, "utf8") === rawControlBinding);
  } catch { /* a disappearing snapshot is a locked-validation change */ }
  if (!snapshotsUnchanged) {
    throw new Error("recovery context/control-binding changed during locked validation");
  }
  return { baseSha: contextBaseSha, declaredTouches };
}

function readRecoveryControlBinding(path: string): RecoveryControlBindingRecord | null {
  if (!existsSync(path)) return null;
  let current: unknown;
  try { current = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`existing control binding is unreadable: ${(error as Error).message}`); }
  return current as RecoveryControlBindingRecord;
}

function readExactRecoveryControlBinding(path: string, expected: RecoveryControlBindingRecord): boolean {
  const current = readRecoveryControlBinding(path);
  if (!current) return false;
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error("existing control binding conflicts with recovered dispatch/schema/Work/session/touches/base");
  }
  return true;
}

interface RecoveryControlBindingPublication {
  kind: "unchanged" | "created" | "advanced";
  previous: RecoveryControlBindingRecord | null;
}

function writePrivateRecoveryControlBinding(path: string, expected: RecoveryControlBindingRecord): void {
  let descriptor = -1;
  try {
    descriptor = openSync(path, "wx");
    writeFileSync(descriptor, `${JSON.stringify(expected, null, 2)}\n`);
    closeSync(descriptor);
    descriptor = -1;
  } finally {
    if (descriptor >= 0) try { closeSync(descriptor); } catch { /* retain the primary write error */ }
  }
}

function publishRecoveryControlBinding(options: {
  path: string;
  expected: RecoveryControlBindingRecord;
  gitRoot: string;
  contextBaseSha: string | null;
}): RecoveryControlBindingPublication {
  const { path, expected } = options;
  const current = readRecoveryControlBinding(path);
  if (current && canonicalJson(current) === canonicalJson(expected)) {
    return { kind: "unchanged", previous: null };
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writePrivateRecoveryControlBinding(temporary, expected);
    if (current) {
      const priorBase = typeof current.base_sha === "string" ? current.base_sha : "";
      const exactPriorShape = canonicalJson(current) === canonicalJson({ ...expected, base_sha: priorBase });
      const coherentContext = options.contextBaseSha === null || options.contextBaseSha === priorBase;
      const forwardAdvance = /^[0-9a-f]{40,64}$/.test(priorBase) && priorBase !== expected.base_sha
        && git(options.gitRoot, ["merge-base", "--is-ancestor", priorBase, expected.base_sha], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
      if (!exactPriorShape || !coherentContext || !forwardAdvance) {
        throw new Error("existing control binding conflicts with recovered dispatch/schema/Work/session/touches/base");
      }
      if (canonicalJson(readRecoveryControlBinding(path)) !== canonicalJson(current)) {
        throw new Error("existing control binding changed before fast-forward publication");
      }
      renameSync(temporary, path);
      return { kind: "advanced", previous: current };
    }
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as { code?: string }).code === "EEXIST" && readExactRecoveryControlBinding(path, expected)) {
        return { kind: "unchanged", previous: null };
      }
      throw error;
    }
    return { kind: "created", previous: null };
  } finally {
    rmSync(temporary, { force: true });
  }
}

function rollbackRecoveryControlBinding(
  path: string,
  expected: RecoveryControlBindingRecord,
  publication: RecoveryControlBindingPublication,
): void {
  if (publication.kind === "unchanged") return;
  if (!readExactRecoveryControlBinding(path, expected)) {
    throw new Error("published recovery control binding disappeared before rollback");
  }
  if (publication.kind === "created") {
    rmSync(path, { force: false });
    return;
  }
  const temporary = `${path}.rollback-${process.pid}-${Date.now()}`;
  try {
    writePrivateRecoveryControlBinding(temporary, publication.previous!);
    if (!readExactRecoveryControlBinding(path, expected)) {
      throw new Error("published recovery control binding changed before rollback");
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

interface WarmReuseScopeExpansion {
  touchesExpanded: boolean;
  oldTouches: string[];
  nextTouches: string[];
  previousContext: Record<string, any>;
  nextContext: Record<string, any>;
  previousControlBinding: RecoveryControlBindingRecord;
  nextControlBinding: RecoveryControlBindingRecord;
}

function sortedUniquePaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  const normalized = value.map((entry) => entry.replace(/\\/g, "/"));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicate paths`);
  return normalized.sort();
}

const RECOVERY_CONTEXT_PATH_LIMIT = 4_096;
const RECOVERY_CONTEXT_PATH_LENGTH_LIMIT = 4_096;

function recoveryContextPaths(gitRoot: string, value: unknown, label: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > RECOVERY_CONTEXT_PATH_LIMIT) {
    throw new Error(`${label} must be a bounded${allowEmpty ? "" : " non-empty"} string array`);
  }
  if (value.length === 0) return [];
  if (value.some((entry) => typeof entry === "string" && entry.includes("\\"))) {
    throw new Error(`${label} contains a non-canonical path`);
  }
  const paths = sortedUniquePaths(value, label);
  for (const path of paths) {
    if (path !== path.trim() || path.length > RECOVERY_CONTEXT_PATH_LENGTH_LIMIT || path.includes("\0")
      || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
      throw new Error(`${label} contains a non-canonical path`);
    }
    const absolute = canonicalPath(path, gitRoot);
    const rel = relative(canonicalPath(gitRoot), absolute).replace(/\\/g, "/");
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || rel !== path) {
      throw new Error(`${label} contains a non-canonical path`);
    }
  }
  return paths;
}

function resolveCommit(gitRoot: string, value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{7,64}$/.test(value)) throw new Error(`${label} is not a Git commit id`);
  const commits = new Set<string>();
  for (const object of gitOut(gitRoot, ["rev-parse", `--disambiguate=${value}`]).split(/\r?\n/).filter(Boolean)) {
    const peeled = git(gitRoot, ["rev-parse", "--verify", `${object}^{commit}`], { stdout: "pipe", stderr: "ignore" });
    if (peeled.exitCode !== 0) continue;
    const exact = peeled.stdout.trim();
    if (/^[0-9a-f]{40,64}$/.test(exact)) commits.add(exact);
  }
  if (commits.size === 0) throw new Error(`${label} does not resolve to a Git commit`);
  if (commits.size !== 1) throw new Error(`${label} is ambiguous in this repository`);
  return [...commits][0];
}

function readJsonRecord(path: string, label: string): Record<string, any> {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${label} is missing or unreadable: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a JSON object`);
  return value as Record<string, any>;
}

function assertRegularRuntimeTarget(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`runtime target must be a regular file: ${path}`);
}

function findRecoveryReusableRecord(
  dispatchRoot: string,
  dispatchPrefix: string,
  agent: string,
): ReusableRecord | null {
  let names: string[];
  try { names = readdirSync(dispatchRoot); }
  catch { return null; }
  const escaped = dispatchPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idRe = new RegExp(`^${escaped}(\\d+)$`);
  let best: ReusableRecord | null = null;
  for (const name of names) {
    const match = name.match(idRe);
    if (!match) continue;
    const dispatchId = Number(match[1]);
    const contextPath = join(dispatchRoot, name, "context.json");
    if (!existsSync(contextPath)) continue;
    let context: Record<string, any>;
    try { context = readJsonRecord(contextPath, "role-recovery reusable context"); }
    catch { continue; }
    const guard = context.guard && typeof context.guard === "object" ? context.guard : {};
    const task = context.task && typeof context.task === "object" ? context.task : {};
    const project = context.project && typeof context.project === "object" ? context.project : {};
    const role = typeof guard.role === "string" && guard.role ? guard.role : task.role;
    const slug = typeof task.slug === "string" ? task.slug : "";
    if (typeof role !== "string" || !role || !slug || seatAgentName(role, slug) !== agent) continue;
    const specVersions: Record<string, string> = {};
    if (context.spec_versions && typeof context.spec_versions === "object") {
      for (const [key, value] of Object.entries(context.spec_versions)) {
        if (typeof value === "string") specVersions[key] = value;
      }
    }
    const strings = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
    const identity: ContextIdentity = {
      agentName: agent,
      role,
      pmId: typeof project.pm_id === "string" ? project.pm_id : "",
      projectRoot: typeof project.project_root === "string" ? project.project_root : "",
      additionalRoots: strings(guard.additional_roots),
      checkout: typeof guard.worktree === "string" ? guard.worktree : "",
      branch: typeof task.branch === "string" ? task.branch : "",
      baseBranch: typeof task.base_branch === "string" ? task.base_branch : "",
      baseSha: typeof task.base_sha === "string" ? task.base_sha : "",
      touches: strings(task.touches),
      touchedPackages: strings(task.touched_packages),
      specVersions,
    };
    if (!best || dispatchId > best.dispatchId) best = { dispatchId, contextPath, identity };
  }
  return best;
}

function validateWarmReuseScopeExpansion(options: {
  contextPath: string;
  controlBindingPath: string;
  reviewPath: string;
  gitRoot: string;
  schema: 3;
  dispatchId: string;
  workId: string;
  sessionId: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  requestedTouches: string[];
  actualTouches: string[];
  roleBinding: ReturnType<typeof bindingReference>;
  roleBaseSha: string;
}): WarmReuseScopeExpansion | null {
  const context = readJsonRecord(options.contextPath, "warm-reuse context");
  const oldTouches = sortedUniquePaths(context.task?.touches, "warm-reuse context touches");
  const requestedTouches = sortedUniquePaths(options.requestedTouches, "warm-reuse requested touches");
  const touchesExpanded = canonicalJson(oldTouches) !== canonicalJson(requestedTouches);
  const oldSet = new Set(oldTouches);
  const removals = oldTouches.filter((path) => !requestedTouches.includes(path));
  const additions = requestedTouches.filter((path) => !oldSet.has(path));
  const oldBase = resolveCommit(options.gitRoot, context.task?.base_sha, "warm-reuse context base");
  const roleBase = resolveCommit(options.gitRoot, options.roleBaseSha, "warm-reuse role base");
  const contextPrecedesRole = oldBase !== roleBase
    && git(options.gitRoot, ["merge-base", "--is-ancestor", oldBase, roleBase], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (oldBase !== roleBase && !contextPrecedesRole) {
    throw new Error("warm-reuse context base does not match the current role authority");
  }
  if (roleBase !== options.baseSha
    && git(options.gitRoot, ["merge-base", "--is-ancestor", roleBase, options.baseSha], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    throw new Error("warm-reuse context base is not an ancestor of the current integration base");
  }
  if (touchesExpanded && removals.length > 0 && !contextPrecedesRole) {
    throw new Error("warm-reuse touch shrink is forbidden");
  }
  const actualTouches = sortedUniquePaths(options.actualTouches, "warm-reuse actual WIP");
  if (touchesExpanded && canonicalJson(actualTouches) !== canonicalJson(requestedTouches)) {
    throw new Error("warm-reuse requested touches do not exactly equal actual branch WIP");
  }
  if (touchesExpanded && removals.length > 0 && additions.length > 0) {
    throw new Error("warm-reuse touch replacement is forbidden");
  }
  if (String(context.task?.id ?? "") !== options.dispatchId || context.task?.branch !== options.branch
    || context.task?.base_branch !== options.baseRef || context.control?.schema_version !== options.schema
    || context.control?.work_id !== options.workId || context.control?.session_id !== options.sessionId
    || canonicalJson(roleBindingFromContext(context)) !== canonicalJson(options.roleBinding)) {
    throw new Error("warm-reuse context does not exactly bind dispatch/schema/Work/session/branch/ref/role");
  }
  const previousControlBinding = readJsonRecord(options.controlBindingPath, "warm-reuse control binding") as RecoveryControlBindingRecord;
  const bindingBase = resolveCommit(options.gitRoot, previousControlBinding.base_sha, "warm-reuse control-binding base");
  if (canonicalJson(previousControlBinding) !== canonicalJson({
    schema_version: options.schema,
    dispatch_id: options.dispatchId,
    work_id: options.workId,
    session_id: options.sessionId,
    touches: oldTouches,
    base_sha: previousControlBinding.base_sha,
  }) || bindingBase !== oldBase) {
    throw new Error("warm-reuse control binding does not exactly match the old context authority");
  }
  if (!touchesExpanded && oldBase === options.baseSha) return null;
  if (touchesExpanded) {
    const review = readJsonRecord(options.reviewPath, "warm-reuse Dock review authority");
    const allowlist = sortedUniquePaths(review.allowlist, "warm-reuse Dock review allowlist");
    if (String(review.assignment_id ?? "") !== options.dispatchId || review.task_id !== options.workId
      || review.role !== "dock" || review.status !== "rework" || review.verdict !== "REWORK") {
      throw new Error("warm-reuse Dock review authority does not bind this dispatch/Work rework");
    }
    const allowed = new Set(allowlist);
    const unauthorized = additions.filter((path) => !allowed.has(path));
    if (unauthorized.length) throw new Error(`warm-reuse touch expansion is not authorized by Dock review: ${unauthorized.join(",")}`);
  }
  const nextControlBinding: RecoveryControlBindingRecord = {
    schema_version: options.schema,
    dispatch_id: options.dispatchId,
    work_id: options.workId,
    session_id: options.sessionId,
    touches: requestedTouches,
    base_sha: options.baseSha,
  };
  const nextContext = structuredClone(context);
  nextContext.task.touches = requestedTouches;
  nextContext.task.base_branch = options.baseRef;
  nextContext.task.base_sha = options.baseSha;
  return { touchesExpanded, oldTouches, nextTouches: requestedTouches, previousContext: context, nextContext, previousControlBinding, nextControlBinding };
}

function replaceExactRuntimeJson(options: {
  root: string;
  path: string;
  expected: Record<string, any>;
  replacement: Record<string, any>;
  label: string;
}): void {
  const current = readJsonRecord(options.path, options.label);
  if (canonicalJson(current) !== canonicalJson(options.expected)) throw new Error(`${options.label} changed before CAS publication`);
  atomicWriteRuntimeFile(options.root, options.path, canonicalJson(options.replacement));
}

function restoreWarmReuseClaim(options: {
  controlRoots: ReturnType<typeof garelierControlRoots>;
  workId: string;
  sessionId: string;
  expectedCurrent: Record<string, any> | null;
  previousClaim: Record<string, any> | null;
  previousSession: ReturnType<typeof readControlSession>;
}): void {
  const namespace = resolveControlNamespace(options.controlRoots);
  const current = readControlClaim(namespace, options.workId);
  if (canonicalJson(current) !== canonicalJson(options.expectedCurrent)) {
    throw new Error("warm-reuse claim changed before rollback");
  }
  const claimPath = join(namespace.runtimeRoot, "claims", `${options.workId}.json`);
  if (options.previousClaim) atomicWriteRuntimeFile(namespace.runtimeRoot, claimPath, canonicalJson(options.previousClaim));
  else if (current) rmSync(claimPath, { force: false });
  writeControlSession(namespace, options.previousSession);
}

interface WarmReuseRolePublication {
  authorization: RoleAuthorization;
  previousCurrent: Record<string, any>;
}

function rollbackWarmReuseRoleAuthorization(options: {
  projectRoot: string;
  pmId: string;
  identity: ReturnType<typeof dispatchExecutionIdentity> | ReturnType<typeof roleExecutionIdentityForBranch>;
  publication: WarmReuseRolePublication;
}): void {
  const paths = roleBindingPaths(
    options.projectRoot, options.pmId, options.identity, options.publication.authorization.core.generation,
  );
  const currentPaths = roleBindingPaths(options.projectRoot, options.pmId, options.identity);
  const current = readJsonRecord(currentPaths.current, "warm-reuse role current");
  if (current.binding_id !== options.publication.authorization.binding_id
    || current.binding_digest !== options.publication.authorization.core_digest
    || current.generation !== options.publication.authorization.core.generation) {
    throw new Error("warm-reuse role current changed before rollback");
  }
  const authorization = readJsonRecord(paths.authorization, "warm-reuse role authorization");
  if (canonicalJson(authorization) !== canonicalJson(options.publication.authorization)) {
    throw new Error("warm-reuse role authorization changed before rollback");
  }
  const entries = readdirSync(paths.generation_dir).sort();
  if (canonicalJson(entries) !== canonicalJson(["authorization.json"])) {
    throw new Error("warm-reuse role generation gained side effects before rollback");
  }
  const retired = `${paths.generation_dir}.rollback-${process.pid}-${Date.now()}`;
  renameSync(paths.generation_dir, retired);
  try {
    replaceExactRuntimeJson({
      root: currentPaths.root,
      path: currentPaths.current,
      expected: current,
      replacement: options.publication.previousCurrent,
      label: "warm-reuse role current rollback",
    });
  } catch (error) {
    renameSync(retired, paths.generation_dir);
    throw error;
  }
  removeTreeSync(retired);
}

function canonicalRecoveryPrompt(options: {
  parsed: Parsed;
  projectRoot: string;
  config: string;
  role: RoleKind;
  routing: RoleAuthorization["core"]["routing"];
  sourcePath: string;
  branch: string;
  baseSha: string;
  container: string;
  dispatchId: string;
  resultPath: string;
  blueprintPath: string | null;
  lens: ResolvedRoleLensBinding;
}): string {
  const source = readFileSync(options.sourcePath, "utf8");
  const provider = options.routing.provider === "codex-cli" ? "codex" : "claude-code";
  const pointers = {
    blueprintPath: options.blueprintPath,
    lens: options.lens,
  };
  let body: string;
  if (provider === "codex" && !source.includes(CODEX_ROLE_PROMPT_CONTRACT_MARKER)) {
    body = `${promptPreamble(
      { ...options.parsed, role: options.role, slug: basename(options.branch) || `recovery-${options.dispatchId}` },
      options.dispatchId,
      options.branch,
      options.baseSha,
      options.container,
      "proxy",
      options.routing.model,
      provider,
      options.resultPath,
      readStandingConstraints(options.config),
      pointers,
    ).trimEnd()}\n\n## Task\n\n${source.trim()}\n`;
  } else {
    body = upsertRoleSourcePointerSection(source, pointers);
  }
  const runtimeRoot = join(options.projectRoot, "__garelier", options.parsed.pm, "runtime");
  const promptRoot = join(runtimeRoot, "dispatch", "prompts");
  configurePathGuardRoots([promptRoot]);
  const promptPath = join(promptRoot, `${sha256(body).replace(/^sha256:/, "")}.md`);
  if (existsSync(promptPath)) {
    if (readFileSync(promptPath, "utf8") !== body) fail("dispatch_prepare: canonical recovery prompt digest collision", 4);
  } else {
    atomicWriteRuntimeFile(runtimeRoot, promptPath, body);
  }
  return promptPath;
}

function runRoleRecoveryMode(options: {
  parsed: Parsed;
  gitRoot: string;
  canonicalProjectRoot: string;
  controlRoots: ReturnType<typeof garelierControlRoots>;
  controlSchema: number | null;
  config: string;
  namespaceLock: ReturnType<typeof acquireGarelierOperationGuard>["lock"];
}): number {
  const { parsed: p } = options;
  if (Boolean(p.recoveryDispatch) === Boolean(p.recoveryBranch)) {
    fail("dispatch_prepare: role recovery requires exactly one of --recovery-dispatch or --recovery-branch", 4);
  }
  if (p.role) fail("dispatch_prepare: role recovery role is derived from canonical identity; --role is forbidden", 4);
  if (!p.workId || !p.controlSession) fail("dispatch_prepare: role recovery requires --work-id and --control-session", 4);
  if (!p.expectedPreviousDigestSet) fail("dispatch_prepare: role recovery requires --expected-previous-digest <sha256|null>", 4);
  const expectedPreviousDigest = p.expectedPreviousDigest === "null"
    ? null
    : /^[0-9a-f]{64}$/.test(p.expectedPreviousDigest)
    ? p.expectedPreviousDigest
    : fail("dispatch_prepare: role recovery expected previous digest must be sha256 or literal null", 4);
  if (p.acceptanceIds.length === 0) fail("dispatch_prepare: role recovery requires the re-audited canonical --acceptance-id set", 4);
  const identity = p.recoveryBranch
    ? roleExecutionIdentityForBranch(p.recoveryBranch)
    : dispatchExecutionIdentity(p.recoveryDispatch);
  const previous = currentRoleAuthorizationOrNull(options.canonicalProjectRoot, p.pm, identity);
  if (p.recoveryDispatch && !previous) {
    fail("dispatch_prepare: dispatch recovery requires an existing current authorization; bindingless migration uses a full role branch identity", 4);
  }
  if ((previous?.core_digest ?? null) !== expectedPreviousDigest) {
    fail("dispatch_prepare: role recovery expected previous generation/digest is stale", 4);
  }
  const boundRole = identity.kind === "branch" ? identity.role : previous!.core.role;
  if (boundRole !== "worker" && boundRole !== "smith" && boundRole !== "librarian" && boundRole !== "artisan") {
    fail(`dispatch_prepare: role recovery cannot target role-seat binding ${boundRole}`, 4);
  }
  const role = boundRole as RoleKind;
  const execution: RecoverRoleAuthorizationOptions["execution"] = p.recoveryBranch
    ? { kind: "branch", branch: p.recoveryBranch }
    : { kind: "dispatch", id: p.recoveryDispatch, role };

  let itemAuthority: string;
  if (options.controlSchema === 3) {
    itemAuthority = controlAuthorityPath(options.controlRoots.controlRoot, options.controlSchema, p.workId);
    if (p.itemAuthority && canonicalRecoveryFile(options.canonicalProjectRoot, p.itemAuthority, "item authority") !== canonicalPath(itemAuthority)) {
      fail("dispatch_prepare: role recovery item authority does not match canonical Control authority", 4);
    }
  } else {
    itemAuthority = canonicalRecoveryFile(options.canonicalProjectRoot, p.itemAuthority, "item authority");
  }
  const assignmentPath = canonicalRecoveryFile(options.canonicalProjectRoot, p.assignmentPath, "assignment");
  const blueprintPath = p.blueprint ? canonicalRecoveryFile(options.canonicalProjectRoot, p.blueprint, "blueprint") : null;
  const recoverySourcePromptPath = canonicalRecoveryFile(options.canonicalProjectRoot, p.promptPath, "prompt");
  const initialInstructionsPath = canonicalRecoveryFile(options.canonicalProjectRoot, p.initialInstructionsPath, "initial instructions");
  const wip = p.recoveryWip.map((value) => {
    const path = canonicalRecoveryFile(options.canonicalProjectRoot, value, "WIP");
    return { path, content_hash: hashRoleFile(path) };
  });

  let base = p.base;
  if (!base) {
    if (!existsSync(options.config)) fail(`dispatch_prepare: role recovery has no --base and no ${options.config}`, 4);
    base = readQuoted(options.config, "integration");
  }
  if (!base.endsWith("/studio")) fail(`dispatch_prepare: integration branch must end in /studio: ${base}`, 4);
  const baseSha = gitOut(options.gitRoot, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/.test(baseSha)) fail(`dispatch_prepare: role recovery integration ref does not resolve: ${base}`, 4);

  let routing: RoleAuthorization["core"]["routing"];
  if (previous) {
    if (p.provider || p.providerTransport || p.inModel || p.inEffort) {
      fail("dispatch_prepare: replacement routing is derived from the current authorization; provider/transport/model/effort substitution is forbidden", 4);
    }
    routing = previous.core.routing;
  } else {
    if (!p.provider || !p.inModel || !p.inEffort) {
      fail("dispatch_prepare: bindingless recovery requires --provider, --model, and --effort", 4);
    }
    if (p.provider === "codex" && p.providerTransport) {
      fail("dispatch_prepare: codex recovery cannot select a Claude provider transport", 4);
    }
    routing = {
      provider: p.provider === "codex" ? "codex-cli" : p.providerTransport || "attended-agent",
      model: p.inModel,
      effort: p.inEffort,
      source: "dispatch_prepare:role_recovery",
    };
  }

  const dispatchId = recoveryDispatchId(p);
  const defaultContainer = crewSubdir(options.canonicalProjectRoot, p.pm, `dispatch${dispatchId}`);
  const defaultWorktree = join(defaultContainer, "checkout");
  const branch = p.recoveryBranch
    || gitOut(defaultWorktree, ["branch", "--show-current"])
    || gitOut(options.gitRoot, ["branch", "--show-current"]);
  const worktree = recoveryWorktree(options.gitRoot, branch, defaultWorktree);
  const container = dirname(worktree);
  const resultPath = join(container, "lane", "recovery.result.md");
  const sessionRecordPath = join(container, "lane", "recovery.session.json");
  const assignmentMd = readFileSync(assignmentPath, "utf8");
  const blueprintMd = blueprintPath ? readFileSync(blueprintPath, "utf8") : null;
  const lens = resolveRoleLensBinding({
    projectRoot: options.canonicalProjectRoot, pmId: p.pm, role,
    assignmentMd, blueprintMd, setupConfigPath: options.config,
  });
  const promptPath = canonicalRecoveryPrompt({
    parsed: p,
    projectRoot: options.canonicalProjectRoot,
    config: options.config,
    role,
    routing,
    sourcePath: recoverySourcePromptPath,
    branch,
    baseSha,
    container,
    dispatchId,
    resultPath,
    blueprintPath,
    lens,
  });
  const knowledge = resolveRoleKnowledgeBinding({
    projectRoot: options.canonicalProjectRoot, pmId: p.pm, role, assignmentMd,
    required: requiredKnowledgeRefs(assignmentMd),
  });
  let recoveryControlBinding: RecoveryControlBindingRecord | null = null;
  let recoveryBindingPublication: RecoveryControlBindingPublication | null = null;
  let recoveryClaimCreated = false;
  const recoveryBindingPath = join(container, "control_binding.json");
  if (options.controlSchema === 3) {
    if (canonicalPath(container) !== canonicalPath(defaultContainer)) {
      throw new Error(`schema-bound role recovery worktree is not in canonical dispatch #${dispatchId} container`);
    }
    if (routing.provider === "codex-cli" && !existsSync(worktree)) {
      throw new Error(`recovered Codex worktree is missing: ${worktree}`);
    }
    const wipTouches = recoveryControlTouches(worktree, wip);
    const recoveryContext = validateRecoveryDispatchContext({
      path: join(container, "context.json"), controlBindingPath: recoveryBindingPath,
      gitRoot: options.gitRoot, schema: options.controlSchema, dispatchId,
      workId: p.workId, sessionId: p.controlSession, branch, baseRef: base, baseSha, touches: wipTouches,
      roleBinding: previous ? bindingReference(previous) : null,
      rolePredecessor: previous ? {
        projectRoot: options.canonicalProjectRoot,
        pmId: p.pm,
        identity,
        current: previous,
      } : null,
    });
    const touches = recoveryContext?.declaredTouches ?? wipTouches;
    const contextBaseSha = recoveryContext?.baseSha ?? null;
    const before = inspectDispatchControlBinding(options.controlRoots, p.workId, p.controlSession, options.namespaceLock);
    recoveryClaimCreated = !before.claim;
    try {
      const claimed = claimDispatchControlWork({
        roots: options.controlRoots, workId: p.workId, sessionId: p.controlSession,
        touches, dispatchId, rework: p.rework, namespaceLock: options.namespaceLock,
      });
      recoveryControlBinding = {
        schema_version: claimed.schema_version, dispatch_id: dispatchId,
        work_id: claimed.work_id, session_id: claimed.session_id,
        touches: claimed.touches, base_sha: baseSha,
      };
      recoveryBindingPublication = publishRecoveryControlBinding({
        path: recoveryBindingPath, expected: recoveryControlBinding,
        gitRoot: options.gitRoot, contextBaseSha,
      });
    } catch (error) {
      if (recoveryClaimCreated) {
        try { releaseDispatchControlClaim(options.controlRoots, p.workId, p.controlSession, options.namespaceLock); }
        catch (releaseError) { throw new Error(`recovery claim/control-binding publication failed and claim rollback failed: ${(releaseError as Error).message}`, { cause: error }); }
      }
      throw error;
    }
  }
  let authorization: RoleAuthorization;
  try {
    authorization = prepareRoleRecovery({
      project_root: options.canonicalProjectRoot,
      pm_id: p.pm,
      execution,
      expected_previous_digest: expectedPreviousDigest,
      item: {
        work_id: p.workId,
        revision: hashRoleFile(itemAuthority),
        session_id: p.controlSession,
        authority_path: itemAuthority,
      },
      assignment_path: assignmentPath,
      blueprint_path: blueprintPath,
      package_id: p.pipelinePackage || null,
      prompt_path: promptPath,
      routing,
      lens,
      knowledge,
      integration: { ref: base, base_sha: baseSha },
      initial_instructions_path: initialInstructionsPath,
      recovery: {
        reason: recoveryReason(p.recoveryReason),
        wip,
        dependencies_reaudited: true,
        acceptance_reaudited: p.acceptanceIds,
      },
    });
  } catch (error) {
    if (recoveryBindingPublication && recoveryBindingPublication.kind !== "unchanged") {
      try {
        if (!recoveryControlBinding) throw new Error("published recovery control binding has no rollback authority");
        rollbackRecoveryControlBinding(recoveryBindingPath, recoveryControlBinding, recoveryBindingPublication);
      } catch (rollbackError) {
        throw new Error(`role authorization failed and control-binding rollback failed: ${(rollbackError as Error).message}`, { cause: error });
      }
    }
    if (recoveryClaimCreated) {
      try { releaseDispatchControlClaim(options.controlRoots, p.workId, p.controlSession, options.namespaceLock); }
      catch (rollbackError) { throw new Error(`role authorization failed and claim rollback failed: ${(rollbackError as Error).message}`, { cause: error }); }
    }
    throw error;
  }
  const binding = bindingReference(authorization);
  let launchCmd = "";
  if (authorization.core.routing.provider === "codex-cli" || authorization.core.routing.provider === "claude-subprocess") {
    if (!existsSync(worktree)) fail(`dispatch_prepare: recovered provider worktree is missing: ${worktree}`, 4);
    const providerScript = posixish(resolve(dirname(fileURLToPath(import.meta.url)), "dispatch_provider.ts"));
    launchCmd = shellCommand([
      posixish(process.execPath), providerScript,
      "--provider", authorization.core.routing.provider === "codex-cli" ? "codex" : "claude-code",
      "--worktree", worktree, "--project", options.canonicalProjectRoot,
      "--prompt", promptPath, "--result", resultPath, "--session-record", sessionRecordPath,
      "--model", authorization.core.routing.model, "--effort", authorization.core.routing.effort,
      "--model-source", authorization.core.routing.source,
      "--pm-id", p.pm, "--binding-generation", String(binding.generation),
      "--binding-digest", binding.binding_digest,
      ...(p.recoveryBranch ? ["--binding-branch-ref", p.recoveryBranch] : []),
    ]);
  }
  out(JSON.stringify({
    mode: "role_recovery",
    runnable: false,
    runnable_reason: "replacement authorization issued; an actual launcher or nonrole attended parent must acknowledge successful launch",
    role_binding: binding,
    control_binding: recoveryControlBinding,
    launch_handoff: {
      role,
      transport: authorization.core.routing.provider,
      prompt_path: authorization.core.sources.prompt.path,
      worktree,
      context_path: join(container, "context.json"),
      result_path: resultPath,
      session_record_path: sessionRecordPath,
      launch_cmd: launchCmd,
      generation: binding.generation,
      binding_digest: binding.binding_digest,
      acknowledgement_required: true,
      acknowledged: false,
    },
  }));
  return 0;
}

function runRoleAuthorityRebindMode(p: Parsed, gitRoot: string, canonicalProjectRoot: string): number {
  if (!/^[1-9][0-9]*$/.test(p.dispatchId)) fail("dispatch_prepare: --rebind-authority requires --id <positive-id>", 4);
  if (!p.evidence) fail("dispatch_prepare: --rebind-authority requires --evidence <gate-verdict-path>", 4);
  if (p.recoverRole) fail("dispatch_prepare: --rebind-authority and --recover-role are mutually exclusive", 4);
  const container = crewSubdir(canonicalProjectRoot, p.pm, `dispatch${p.dispatchId}`);
  let context: { task?: { id?: unknown; branch?: unknown } };
  let controlBinding: { dispatch_id?: unknown; work_id?: unknown; session_id?: unknown };
  try {
    context = JSON.parse(readFileSync(join(container, "context.json"), "utf8"));
    controlBinding = JSON.parse(readFileSync(join(container, "control_binding.json"), "utf8"));
  } catch (error) {
    fail(`dispatch_prepare: authority rebind cannot read dispatch #${p.dispatchId} context/control binding: ${(error as Error).message}`, 4);
  }
  const branch = typeof context.task?.branch === "string" ? context.task.branch : "";
  const workId = typeof controlBinding.work_id === "string" ? controlBinding.work_id : "";
  const sessionId = typeof controlBinding.session_id === "string" ? controlBinding.session_id : "";
  const identity = dispatchExecutionIdentity(p.dispatchId);
  const contextRoleBinding = roleBindingFromContext(context);
  if (String(context.task?.id ?? "") !== p.dispatchId || String(controlBinding.dispatch_id ?? "") !== p.dispatchId
    || !branch || !workId || !sessionId || !contextRoleBinding
    || canonicalJson(contextRoleBinding.identity) !== canonicalJson(identity)
    || typeof contextRoleBinding.generation !== "number"
    || typeof contextRoleBinding.binding_digest !== "string") {
    fail(`dispatch_prepare: authority rebind dispatch #${p.dispatchId} context/control binding is incomplete or mismatched`, 4);
  }
  if (!branch.includes(`/#${p.dispatchId}/`)) {
    fail(`dispatch_prepare: authority rebind branch does not carry dispatch #${p.dispatchId}: ${branch}`, 4);
  }
  const tip = gitOut(gitRoot, ["rev-parse", "--verify", `${branch}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/.test(tip)) fail(`dispatch_prepare: authority rebind cannot resolve bound branch tip: ${branch}`, 4);
  if (p.candidateSha && p.candidateSha !== tip) {
    fail(`dispatch_prepare: --candidate-sha must equal bound branch tip ${tip}`, 4);
  }
  const controlRoots = garelierControlRoots(canonicalProjectRoot, gitRoot, p.pm);
  let guard: ReturnType<typeof acquireGarelierOperationGuard>;
  try { guard = acquireGarelierOperationGuard(controlRoots, sessionId, "role-authority-rebind"); }
  catch (error) { fail(`dispatch_prepare: authority rebind could not acquire Control guard: ${(error as Error).message}`, 4); }
  try {
    if (guard.schema !== 3) {
      fail(`dispatch_prepare: authority rebind requires Control schema 3 (found ${guard.schema ?? "none"})`, 4);
    }
    const inspected = inspectDispatchControlBinding(controlRoots, workId, sessionId, guard.lock);
    if (!inspected.claim || inspected.claim.session_id !== sessionId || Date.parse(inspected.claim.expires_at) <= Date.now()) {
      const mergeLand = posixish(resolve(dirname(fileURLToPath(import.meta.url)), "merge_land.ts"));
      fail(
        `dispatch_prepare: authority rebind requires the live bound claim for ${workId} (${sessionId})\n` +
        `NEXT_COMMAND: ${shellCommand([process.execPath, mergeLand, "--project", canonicalProjectRoot, "--target-root", gitRoot, "--pm-id", p.pm, "--dispatch-id", p.dispatchId])}`,
        4,
      );
    }
    const transition = rebindRoleAdmission({
      project_root: canonicalProjectRoot,
      pm_id: p.pm,
      identity,
      generation: contextRoleBinding.generation,
      expect_digest: contextRoleBinding.binding_digest,
      work_id: workId,
      authority_path: controlAuthorityPath(controlRoots.controlRoot, guard.schema, workId),
      evidence_path: canonicalPath(p.evidence, canonicalProjectRoot),
      expected_branch: branch,
      expected_review_sha: p.candidateSha || tip,
      candidate_sha: p.candidateSha || null,
      writer: { role: "coordinator", id: "dispatch_prepare:rebind-authority" },
    });
    out(JSON.stringify({
      rebind_authority: true,
      dispatch_id: p.dispatchId,
      work_id: workId,
      binding_digest: transition.binding_digest,
      generation: transition.generation,
      sequence: transition.sequence,
      authority: transition.authority,
      candidate_sha: transition.candidate_sha,
      evidence: transition.evidence.source.path,
    }));
    return 0;
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    fail(`dispatch_prepare: authority rebind refused: ${(error as Error).message}`, 4);
  } finally {
    guard.release();
  }
}

export async function main(
  argv = process.argv.slice(2),
  lifecycle: DispatchContainerLifecycle = DISPATCH_CONTAINER_LIFECYCLE,
): Promise<number> {
  if (argv.includes("--ack-launch") || argv.includes("--attended-seat")) {
    const { code, message } = runAttendedSeatCli(argv.filter((arg) => arg !== "--attended-seat"));
    (code === 0 ? process.stdout : process.stderr).write(`${message}\n`);
    return code;
  }
  const p = parseArgs(argv);
  if (!p.project || !p.pm || (!p.recoverRole && !p.rebindAuthority && (!p.role || !p.slug))) {
    fail("dispatch_prepare: --project and --pm-id are required; normal dispatch also requires --role and --slug");
  }
  if (p.provider && p.provider !== "codex" && p.provider !== "claude-code") {
    fail(`dispatch_prepare: --provider must be codex|claude-code (got '${p.provider}')`);
  }
  if (p.providerTransport && p.providerTransport !== "attended-agent" && p.providerTransport !== "claude-subprocess") fail(`dispatch_prepare: --provider-transport must be attended-agent|claude-subprocess (got '${p.providerTransport}')`);
  // W-402: fail fast, BEFORE any claim/worktree/container is created, on a
  // negative or non-numeric --bash-budget-ms. Omitted -> untouched (context_pack.ts
  // keeps resolving the project default; see ctxArgs below).
  if (p.inBashBudgetMs) {
    const bashBudgetMs = Number(p.inBashBudgetMs);
    if (!Number.isFinite(bashBudgetMs) || bashBudgetMs <= 0) {
      fail(`dispatch_prepare: --bash-budget-ms must be a positive number (got '${p.inBashBudgetMs}')`, 1);
    }
  }
  // W-690: whether the PM NAMED a provider, captured before the default fills
  // it in. The dispatch record must not report a framework default as task
  // authority — provider stays per-task authority, and the record has to say
  // which of the two this dispatch actually was.
  const providerFromFlag = Boolean(p.provider);
  if (!p.recoverRole && !p.rebindAuthority && !p.reuse && !p.rework && !p.provider) {
    p.provider = DEFAULT_PROVIDER;
  }
  // W-667 F-1: a normal dispatch with NO prompt source used to run to completion —
  // allocating the Control claim, the dispatch id, the container and an 8k-file
  // worktree — and only then return `spawn_directive = "BLOCK: no provider prompt
  // was generated"`, leaving the operator to clean up a container that could never
  // spawn (3 wasted containers in one 2026-09-02 session, 2 of them undeletable
  // under a Windows handle lock). The prompt body is `--task-file` or the
  // assignment rendered from `--pipeline-package`; with neither, the outcome is
  // known here, BEFORE any side effect. Same mode predicate as the --provider
  // requirement above: reuse/rework/recovery continue an existing container that
  // already carries its assignment.md.
  if (!p.recoverRole && !p.rebindAuthority && !p.reuse && !p.rework && !p.taskFile && !p.pipelinePackage) {
    fail(
      "dispatch_prepare: normal dispatch requires a prompt source; without one this run would create a claim, a container and a worktree and then return spawn_directive=BLOCK. "
        + "NEXT_COMMAND: rerun the same dispatch_prepare with --task-file <path to the prompt markdown> (or --pipeline-package <id> together with --blueprint <path>).",
      4,
    );
  }
  let taskBody = "";
  if (p.taskFile) {
    try { taskBody = readFileSync(p.taskFile, "utf8"); }
    catch { fail(`dispatch_prepare: --task-file is not readable: ${p.taskFile}`); }
    if (p.blueprint) {
      enforcePromptSectionContract({
        markdown: taskBody,
        surface: "task_file",
        sourcePath: p.taskFile,
        blueprintPath: p.blueprint,
      });
    }
  }
  if (!p.blueprint) {
    err("dispatch_prepare: WARNING — --blueprint was not specified; proceeding without a blueprint pointer so dispatch operations remain available.");
  } else if (!existsSync(p.blueprint) && !p.pipelinePackage) {
    err(`dispatch_prepare: WARNING — blueprint is not readable: ${p.blueprint}; proceeding without a blueprint pointer so dispatch operations remain available.`);
    p.blueprint = "";
  }
  const gitRoot = p.targetRoot || p.project;
  const canonicalProjectRoot = canonicalPath(p.project);
  if (p.rebindAuthority) return runRoleAuthorityRebindMode(p, gitRoot, canonicalProjectRoot);
  const controlRoots = garelierControlRoots(p.project, gitRoot, p.pm);
  let guard: ReturnType<typeof acquireGarelierOperationGuard>;
  try { guard = acquireGarelierOperationGuard(controlRoots, p.controlSession || `dispatch-prepare-${process.pid}`, "dispatch-prepare"); }
  catch (error) { fail(`dispatch_prepare: ${(error as Error).message}`, 4); }
  try {
  const controlSchema = guard.schema;
  if (controlSchema === 3) {
    if (!p.workId || !p.controlSession) {
      err(`NEXT_COMMAND: ${missingControlBindingNextCommand(p.project, p.pm)}`);
      fail(`dispatch_prepare: schema v${controlSchema} requires --work-id W-N and --control-session <session_id>`, 4);
    }
    try {
      const inspected = inspectDispatchControlBinding(controlRoots, p.workId, p.controlSession, guard.lock);
      if (inspected.claim && inspected.claim.session_id !== p.controlSession && Date.parse(inspected.claim.expires_at) > Date.now()) {
        fail(`dispatch_prepare: Work ${p.workId} is already claimed by session ${inspected.claim.session_id}`, 4);
      }
    } catch (error) {
      fail(`dispatch_prepare: schema-v${controlSchema} Work/Backlog binding rejected: ${(error as Error).message}`, 4);
    }
    // W-666: refuse a row whose acceptance section is still the create-time
    // placeholder, and do it here — before the claim, the container and the
    // worktree (the PF-1 position), not at review time.
    const rowPath = controlAuthorityPath(controlRoots.controlRoot, controlSchema, p.workId);
    if (placeholderAcceptanceOnly(text(rowPath))) {
      fail(
        `dispatch_prepare: Backlog ${p.workId} has no acceptance criteria — ${rowPath} carries only the create-time placeholder "${PLACEHOLDER_ACCEPTANCE_LINE}" under "## Acceptance criteria". `
          + `NEXT_COMMAND: garelier control backlog update ${p.workId} --set-acceptance '<criterion>' [--set-acceptance '<criterion>' ...] --session <sid> --expect-control-revision <rev> --expect-revision <updated-ms> `
          + `(--set-acceptance REPLACES the whole list), then rerun this dispatch_prepare.`,
        4,
      );
    }
    // W-667 F-8: surface the Checkpoint precondition at the same pre-allocation
    // point instead of at claim time, after routing and the assignment render.
    try { assertDispatchCheckpointPrecondition(controlRoots, p.workId); }
    catch (error) { fail(`dispatch_prepare: ${(error as Error).message}`, 4); }
  } else {
    fail(`dispatch_prepare: unsupported control schema_version ${controlSchema ?? "missing"}; only schema_version 3 is accepted`, 4);
  }
  const pmRoot = `${p.project}/__garelier/${p.pm}`;
  const pmContainer = crewSubdir(p.project, p.pm, "pm");
  const dispatch0 = crewSubdir(p.project, p.pm, "dispatch0");
  const dispatchRoot = dirname(dispatch0);
  const dispatchPrefix = basename(dispatch0).replace(/0$/, "");
  const dispatchContainer = (id: string): string => crewSubdir(p.project, p.pm, `dispatch${id}`);
  const config = `${pmContainer}/setup_config.toml`;
  if (p.recoverRole) {
    try {
      return runRoleRecoveryMode({ parsed: p, gitRoot, canonicalProjectRoot, controlRoots, controlSchema, config, namespaceLock: guard.lock });
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      fail(`dispatch_prepare: role recovery refused: ${(error as Error).message}`, 4);
    }
  }
  if (!/^[a-z0-9-]+$/.test(p.slug)) fail("dispatch_prepare: --slug must be kebab-case [a-z0-9-]");

  const family: Record<string, string> = { worker: "workbench", smith: "anvil", librarian: "shelf", artisan: "satchel", concierge: "clipboard" };
  const roleSeat = p.role === "scout" || p.role === "observer" || p.role === "guardian" || p.role === "concierge"
    ? p.role
    : null;
  const readOnlySeat = roleSeat !== null && roleSeat !== "concierge";
  if (p.role !== "concierge" && p.approvedRemotes.length > 0) {
    fail("dispatch_prepare: --approved-remote is valid only with --role concierge");
  }
  let approvedRemoteDestinations: ReturnType<typeof parseApprovedRemoteSpec>[] = [];
  try { approvedRemoteDestinations = p.approvedRemotes.map(parseApprovedRemoteSpec); }
  catch (error) { fail(`dispatch_prepare: invalid --approved-remote: ${(error as Error).message}`); }
  // W-191 (d): a gate seat never reuses — give the DEC-090 independence reason
  // BEFORE the generic read-only reject below, so `--reuse --role guardian` explains
  // WHY (a gate's read must be independent), not just "no worktree needed".
  if (p.reuse && (p.role === "guardian" || p.role === "observer")) {
    fail(`dispatch_prepare: --reuse: role '${p.role}' is a GATE seat — gate seats never reuse a warm context (DEC-090: a Guardian/Observer read must be INDEPENDENT). Spawn a FRESH gate seat.`, 1);
  }
  if (!readOnlySeat && !family[p.role]) fail(`dispatch_prepare: unknown role: ${p.role} (worker|smith|librarian|artisan|scout|observer|guardian|concierge)`);

  if (!p.base) {
    if (!existsSync(config)) fail(`dispatch_prepare: no --base and no ${config}`);
    p.base = readQuoted(config, "integration");
    if (!p.base) fail(`dispatch_prepare: [branches] integration not found in ${config}`);
  }
  const targetBranch = existsSync(config) ? readQuoted(config, "target") : "";
  if (p.pipelinePackage && p.role === "artisan" && !targetBranch) fail(`dispatch_prepare: [branches] target not found in ${config}`);
  if (!p.base.endsWith("/studio")) {
    const integration = existsSync(config) ? readQuoted(config, "integration") : "";
    err(`NEXT_COMMAND: ${dispatchPrepareNextCommand(argv, { replace: { "--base": integration || "<integration/studio>" } })}`);
    fail(`dispatch_prepare: integration branch must end in /studio: ${p.base}`);
  }
  const durableBaseSha = gitOut(gitRoot, ["rev-parse", "--verify", `${p.base}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/.test(durableBaseSha)) {
    fail(`dispatch_prepare: integration branch does not resolve to an exact commit: ${p.base}`, 4);
  }

  // W-540: review.md is the existing contract trigger for REWORK. Infer the
  // already-bound warm container from role+slug so the ordinary rework command
  // does not require an extra transport-only --reuse spelling or allocate a new
  // branch/container.
  if (p.rework && !p.reuse && !readOnlySeat) {
    const agent = seatAgentName(p.role, p.slug);
    const candidate = findRecoveryReusableRecord(dispatchRoot, dispatchPrefix, agent);
    const candidateContainer = candidate ? dirname(candidate.contextPath) : "";
    if (candidateContainer && lifecycle.consumeAbort(candidateContainer)) {
      fail(`dispatch_prepare: --rework refused because abort.md transitioned the existing container to ABORTED`, 4);
    }
    const state = candidate ? text(join(candidateContainer, "STATE.md")).match(/^##\s*Status\s*$[\s\S]*?^\s*(\S+)/m)?.[1] ?? "" : "";
    const resumable = state === "REWORK" || (state === "BLOCKED" && existsSync(join(candidateContainer, "answers.md")));
    if (!candidate || !resumable || !existsSync(join(candidateContainer, "review.md"))) {
      err(`NEXT_COMMAND: ${dispatchPrepareNextCommand(argv, { remove: ["--rework"], replace: { "--slug": `${p.slug}-fresh` } })}`);
      fail(`dispatch_prepare: --rework requires one existing same-role/slug container in STATE=REWORK with review.md; no new branch/container was created`, 4);
    }
    p.reuse = agent;
  }
  if (!p.reuse && !p.provider) p.provider = DEFAULT_PROVIDER;

  // W-191 (b): serial WARM reuse. `--reuse <agent>` continues an already-spawned
  // role on the NEXT row: locate its prior dispatch record, enforce the (d)/(e)
  // reuse guards (same role, same pm, same repo scope; never a gate seat), and emit
  // ONLY a delta block (row pointer + the seat's warm checkout + base) instead of the
  // full preamble a second time. It claims NO dispatch id and cuts NO worktree — the
  // warm seat keeps working in its existing checkout. The identity guards run before
  // mutation; after them, the exact Control claim and replacement ready.json use the
  // same compensation/publication contract as a fresh dispatch.
  if (p.reuse) {
    const found = findReusableRecord(dispatchRoot, dispatchPrefix, p.reuse)
      ?? (p.rework ? findRecoveryReusableRecord(dispatchRoot, dispatchPrefix, p.reuse) : null);
    if (!found) fail(`dispatch_prepare: --reuse: no reusable dispatch record for agent '${p.reuse}' under ${dispatchRoot} — nothing to continue. Spawn a fresh seat (omit --reuse).`, 1);
    if (lifecycle.consumeAbort(dirname(found.contextPath))) {
      fail(`dispatch_prepare: --reuse refused because abort.md transitioned the existing container to ABORTED`, 4);
    }
    const check = checkReuseIdentity(found.identity, { role: p.role, pmId: p.pm, projectRoot: gitRoot });
    if (!check.ok) fail(`dispatch_prepare: ${check.error}`, 1);
    const rowPointer = p.row || p.slug;
    // W-191 (c): diff the governance files the prior seat stamped against current,
    // and attach `git diff` for the CHANGED files only — no change ⇒ nothing sent.
    const specFiles = readSpecFiles(config);
    const currentSpec = computeSpecVersions(gitRoot, specFiles);
    const SPEC_DIFF_CAP = 6000;
    const specDiff = diffSpecVersions(found.identity.specVersions ?? {}, currentSpec).map((c) => {
      const entry: Record<string, unknown> = { ...c };
      if (c.status === "changed" && c.old_sha && c.new_sha) {
        let diff = gitOut(gitRoot, ["diff", c.old_sha, c.new_sha]);
        entry.repro = `git -C ${gitRoot} diff ${c.old_sha} ${c.new_sha}`;
        if (diff.length > SPEC_DIFF_CAP) diff = `${diff.slice(0, SPEC_DIFF_CAP)}\n…(truncated; run the repro command for the full diff)`;
        entry.diff = diff;
      }
      return entry;
    });
    // W-191 (f): overlap-based reuse recommendation (soft signal; the hard (d)/(e)
    // rules already passed above). New touched_packages aren't resolved on the reuse
    // path (no cargo-metadata pass), so the hint compares declared touches.
    let nextTouches: string[];
    try {
      nextTouches = sortedUniquePaths(p.inTouches.split(",").map((s) => s.trim()).filter(Boolean), "warm-reuse requested touches");
    } catch (error) {
      fail(`dispatch_prepare: warm-reuse role binding refused: ${(error as Error).message}`, 4);
    }
    const reuseHint = computeReuseHint(
      { touches: found.identity.touches, touchedPackages: found.identity.touchedPackages },
      { touches: nextTouches, touchedPackages: [] },
    );
    let controlBinding: DispatchControlBinding | null = null;
    let published = false;
    let claimAfter: Record<string, any> | null = null;
    let claimBefore: Record<string, any> | null = null;
    let sessionBefore: ReturnType<typeof readControlSession> | null = null;
    let scopeExpansion: WarmReuseScopeExpansion | null = null;
    let scopeControlPublished = false;
    let scopeContextPublished = false;
    let rolePublication: WarmReuseRolePublication | null = null;
    let resumePublication: ResumeTransitionResult | null = null;
    let reworkIntegration: ReworkIntegrationResult | null = null;
    let reuseRoleIdentity: ReturnType<typeof dispatchExecutionIdentity> | ReturnType<typeof roleExecutionIdentityForBranch> = dispatchExecutionIdentity(found.dispatchId);
    try {
    const reuseContainer = dirname(found.contextPath);
    const boundContext = readJsonRecord(found.contextPath, "warm-reuse context");
    const boundRoleBinding = roleBindingFromContext(boundContext);
    if (boundRoleBinding?.identity?.kind === "branch") {
      const branchIdentity = roleExecutionIdentityForBranch(found.identity.branch);
      if (canonicalJson(boundRoleBinding.identity) !== canonicalJson(branchIdentity)) {
        throw new Error("warm-reuse context role branch identity does not match the reusable checkout");
      }
      reuseRoleIdentity = branchIdentity;
    } else if (canonicalJson(boundRoleBinding?.identity) !== canonicalJson(reuseRoleIdentity)) {
      throw new Error("warm-reuse context role dispatch identity does not match the reusable checkout");
    }
    const priorAuthorization = readCurrentRoleAuthorization({
      project_root: p.project, pm_id: p.pm, identity: reuseRoleIdentity,
    });
    const itemAuthority = controlSchema === 3
      ? controlAuthorityPath(controlRoots.controlRoot, controlSchema, p.workId)
      : fail("dispatch_prepare: warm reuse requires schema-3 control authority", 4);
    const assignmentMd = readFileSync(itemAuthority, "utf8");
    const blueprintMd = p.blueprint && existsSync(p.blueprint) ? readFileSync(p.blueprint, "utf8") : null;
    const lens = resolveRoleLensBinding({
      projectRoot: p.project, pmId: p.pm, role: p.role, assignmentMd, blueprintMd, setupConfigPath: config,
    });
    const knowledge = resolveRoleKnowledgeBinding({
      projectRoot: p.project, pmId: p.pm, role: p.role, assignmentMd, required: requiredKnowledgeRefs(assignmentMd),
    });
    const changed = new Set<string>();
    for (const line of gitOut(found.identity.checkout, ["diff", "--name-only", `${priorAuthorization.core.integration.base_sha}...HEAD`]).split(/\r?\n/)) {
      if (line.trim()) changed.add(line.trim());
    }
    for (const args of [["diff", "--name-only"], ["diff", "--cached", "--name-only"]]) {
      for (const line of gitOut(found.identity.checkout, args).split(/\r?\n/)) {
        if (line.trim()) changed.add(line.trim());
      }
    }
    for (const line of gitOut(found.identity.checkout, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/)) {
      if (line.trim()) changed.add(line.trim());
    }
    // Touch authority comes from the complete Git changed-path census, not
    // only from files that can still be hashed. A missing path is a deletion
    // tombstone and must remain visible to exact-scope admission.
    const actualTouches = sortedUniquePaths([...changed], "warm-reuse actual WIP");
    const wip = actualTouches.flatMap((path) => {
      const absolute = resolve(found.identity.checkout, path);
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`warm-reuse WIP path must be a regular file or tracked deletion: ${path}`);
      }
      return [{ path: absolute, content_hash: hashRoleFile(absolute) }];
    });
    if (controlSchema === 3) {
      scopeExpansion = validateWarmReuseScopeExpansion({
        contextPath: found.contextPath,
        controlBindingPath: join(reuseContainer, "control_binding.json"),
        reviewPath: join(reuseContainer, "review.json"),
        gitRoot,
        schema: controlSchema,
        dispatchId: String(found.dispatchId),
        workId: p.workId,
        sessionId: p.controlSession,
        branch: found.identity.branch,
        baseRef: p.base,
        baseSha: durableBaseSha,
        requestedTouches: nextTouches,
        actualTouches,
        roleBinding: bindingReference(priorAuthorization),
        roleBaseSha: priorAuthorization.core.integration.base_sha,
      });
      const inspected = inspectDispatchControlBinding(controlRoots, p.workId, p.controlSession, guard.lock);
      claimBefore = inspected.claim ? structuredClone(inspected.claim) : null;
      sessionBefore = readControlSession(resolveControlNamespace(controlRoots), p.controlSession);
      if (scopeExpansion?.touchesExpanded) {
        if (!p.rework) throw new Error("warm-reuse touch expansion requires --rework");
        const state = inspected.work.status;
        if (state !== "active") throw new Error("warm-reuse touch expansion requires an already-active Control item");
        if (claimBefore && (claimBefore.session_id !== p.controlSession
          || canonicalJson(sortedUniquePaths(claimBefore.touches, "warm-reuse claim touches")) !== canonicalJson(scopeExpansion.oldTouches))) {
          throw new Error("warm-reuse claim does not exactly match the old same-session context authority");
        }
      }
      try {
        controlBinding = claimDispatchControlWork({
          roots: controlRoots, workId: p.workId, sessionId: p.controlSession, touches: nextTouches,
          dispatchId: String(found.dispatchId), rework: p.rework, namespaceLock: guard.lock,
        });
        claimAfter = structuredClone(inspectDispatchControlBinding(controlRoots, p.workId, p.controlSession, guard.lock).claim);
      } catch (error) {
        fail(`dispatch_prepare: schema-v${controlSchema} claim rejected: ${(error as Error).message}`, 4);
      }
      if (scopeExpansion && canonicalJson(controlBinding.touches) !== canonicalJson(scopeExpansion.nextTouches)) {
        throw new Error("warm-reuse claim publication does not match the authorized touch expansion");
      }
    }
    const reusePrompt = join(reuseContainer, "lane", `reuse-${p.workId}.md`);
    mkdirSync(dirname(reusePrompt), { recursive: true });
    writeFileSync(reusePrompt, `${taskBody.trim() || assignmentMd}\n\nRow pointer: ${rowPointer}\n`);
    const resultPath = join(reuseContainer, "lane", "recovery.result.md");
    const sessionRecordPath = join(reuseContainer, "lane", "recovery.session.json");
    const promptPath = scopeExpansion ? canonicalRecoveryPrompt({
      parsed: p,
      projectRoot: p.project,
      config,
      role: p.role as RoleKind,
      routing: priorAuthorization.core.routing,
      sourcePath: reusePrompt,
      branch: found.identity.branch,
      baseSha: durableBaseSha,
      container: reuseContainer,
      dispatchId: String(found.dispatchId),
      resultPath,
      blueprintPath: p.blueprint || null,
      lens,
    }) : reusePrompt;
    if (scopeExpansion) {
      // Preflight both CAS targets before issuing a replacement authorization or
      // integrating studio. The CAS repeats these checks at publication time;
      // this early pass prevents a known-invalid target from advancing the branch.
      assertRegularRuntimeTarget(found.contextPath);
      assertRegularRuntimeTarget(join(reuseContainer, "control_binding.json"));
      replaceExactRuntimeJson({
        root: reuseContainer,
        path: join(reuseContainer, "control_binding.json"),
        expected: scopeExpansion.previousControlBinding,
        replacement: scopeExpansion.nextControlBinding,
        label: "warm-reuse control binding",
      });
      scopeControlPublished = true;
    }
    const rolePaths = roleBindingPaths(p.project, p.pm, reuseRoleIdentity);
    const previousRoleCurrent = readJsonRecord(rolePaths.current, "warm-reuse previous role current");
    const recoveryAuthorization = prepareRoleRecovery({
      project_root: p.project, pm_id: p.pm,
      execution: reuseRoleIdentity.kind === "branch"
        ? { kind: "branch", branch: found.identity.branch }
        : { kind: "dispatch", id: found.dispatchId, role: p.role as RoleKind },
      expected_previous_digest: priorAuthorization.core_digest,
      item: {
        work_id: p.workId, revision: controlBinding ? String(controlBinding.work_revision) : hashRoleFile(itemAuthority),
        session_id: p.controlSession, authority_path: itemAuthority,
      },
      assignment_path: itemAuthority, blueprint_path: p.blueprint || null,
      package_id: p.pipelinePackage || null, prompt_path: promptPath,
      routing: priorAuthorization.core.routing, lens, knowledge,
      integration: { ref: p.base, base_sha: durableBaseSha },
      initial_instructions_path: join(reuseContainer, "instructions.md"),
      recovery: {
        reason: "warm_reuse",
        wip, dependencies_reaudited: true,
        acceptance_reaudited: resolveCanonicalRoleAcceptanceIds(itemAuthority, p.blueprint || null),
      },
    });
    const recoveryBinding = bindingReference(recoveryAuthorization);
    rolePublication = {
      authorization: recoveryAuthorization,
      previousCurrent: previousRoleCurrent,
    };
    if (p.rework) {
      reworkIntegration = lifecycle.continueRework({
        checkout: found.identity.checkout,
        branch: found.identity.branch,
        studioSha: durableBaseSha,
        container: reuseContainer,
        git: (args, cwd) => {
          const result = git(cwd, args, { stdout: "pipe", stderr: "pipe" });
          return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        },
      });
    }
    let recoveryLaunchCmd = "";
    if (recoveryAuthorization.core.routing.provider === "codex-cli" || recoveryAuthorization.core.routing.provider === "claude-subprocess") {
      const providerScript = posixish(resolve(dirname(fileURLToPath(import.meta.url)), "dispatch_provider.ts"));
      recoveryLaunchCmd = shellCommand([
        posixish(process.execPath), providerScript,
        "--provider", recoveryAuthorization.core.routing.provider === "codex-cli" ? "codex" : "claude-code",
        "--worktree", found.identity.checkout, "--project", p.project,
        "--prompt", promptPath, "--result", resultPath, "--session-record", sessionRecordPath,
        "--model", recoveryAuthorization.core.routing.model, "--effort", recoveryAuthorization.core.routing.effort,
        "--model-source", recoveryAuthorization.core.routing.source,
        "--pm-id", p.pm, "--binding-generation", String(recoveryBinding.generation),
        "--binding-digest", recoveryBinding.binding_digest,
        ...(reuseRoleIdentity.kind === "branch" ? ["--binding-branch-ref", found.identity.branch] : []),
      ]);
    }
    const launchHandoff = {
      role: p.role,
      transport: recoveryAuthorization.core.routing.provider,
      prompt_path: recoveryAuthorization.core.sources.prompt.path,
      worktree: found.identity.checkout,
      context_path: found.contextPath,
      result_path: resultPath,
      session_record_path: sessionRecordPath,
      launch_cmd: recoveryLaunchCmd,
      generation: recoveryBinding.generation,
      binding_digest: recoveryBinding.binding_digest,
      acknowledgement_required: true,
      acknowledged: false,
    };
    if (scopeExpansion) {
      const finalContext = structuredClone(scopeExpansion.nextContext);
      writeRoleBindingToContext(finalContext, recoveryBinding);
      replaceExactRuntimeJson({
        root: reuseContainer,
        path: found.contextPath,
        expected: scopeExpansion.previousContext,
        replacement: finalContext,
        label: "warm-reuse context",
      });
      scopeExpansion.nextContext = finalContext;
      scopeContextPublished = true;
      if (reworkIntegration?.status !== "blocked") resumePublication = lifecycle.resume(reuseContainer);
      published = true;
      out(JSON.stringify({
        mode: "role_recovery",
        reuse: true,
        agent: p.reuse,
        dispatch_id: found.dispatchId,
        checkout: found.identity.checkout,
        branch: found.identity.branch,
        base: p.base,
        base_sha: durableBaseSha,
        row_pointer: rowPointer,
        control_binding: scopeExpansion.nextControlBinding,
        role_binding: recoveryBinding,
        lifecycle: reworkIntegration,
        blocked: reworkIntegration?.status === "blocked",
        runnable: false,
        runnable_reason: reworkIntegration?.status === "blocked"
          ? "studio integration is BLOCKED; Dock must write answers.md, then rerun --rework to publish the Worker conflict-resolution route"
          : "replacement authorization issued after canonical scope refresh; the launcher or attended parent must acknowledge successful launch",
        launch_handoff: reworkIntegration?.status === "blocked" ? null : launchHandoff,
      }));
      return 0;
    }
    try {
      const context = JSON.parse(readFileSync(found.contextPath, "utf8")) as Record<string, unknown>;
      writeRoleBindingToContext(context, recoveryBinding);
      writeFileSync(found.contextPath, `${JSON.stringify(context, null, 2)}\n`);
    } catch (error) {
      fail(`dispatch_prepare: warm-reuse context binding publication failed: ${(error as Error).message}`, 4);
    }
    const ready = {
      reuse: true,
      agent: p.reuse,
      dispatch_id: found.dispatchId,
      checkout: found.identity.checkout,
      branch: found.identity.branch,
      base: p.base,
      base_sha: found.identity.baseSha,
      row_pointer: rowPointer,
      control_binding: controlBinding,
      spec_diff: specDiff,
      spec_contract: specDiff.length
        ? "Spec update: the spec_diff entries below are governance changes since your last row — read each diff and apply it as a rule update to how you work THIS row (it supersedes the version you were briefed on)."
        : "",
      reuse_hint: reuseHint,
      runnable: false,
      runnable_reason: reworkIntegration?.status === "blocked"
        ? "studio integration is BLOCKED; Dock must write answers.md, then rerun --rework to publish the Worker conflict-resolution route"
        : "replacement role authorization issued; attended parent must acknowledge successful warm handoff before work resumes",
      role_binding: recoveryBinding,
      lifecycle: reworkIntegration,
      blocked: reworkIntegration?.status === "blocked",
      launch_handoff: reworkIntegration?.status === "blocked" ? null : launchHandoff,
      // W-191 G note (i): a reused seat gets NO full preamble, so the register-
      // terminate rule (delivered once at first spawn) must be RE-STATED here — a
      // warm seat that falls silent at a milestone looks IDLE and draws spurious
      // wakes / a near seat-swap (W-200 silent-idle, W-085).
      register_terminate: "Register-terminate (W-085): your LAST turn for THIS row MUST end with the compact register (final STATE, branch + commit SHA / plan, report path, gate result, any BLOCKED) SENT via SendMessage — a commit/STATE update or plain text alone is not a completion signal (W-146/W-200).",
      reuse_note: reworkIntegration?.status === "worker-conflict-route"
        ? `REWORK conflict-resolution reuse of ${p.reuse} (dispatch #${found.dispatchId}) — the studio merge is paused with conflicts on this same branch; resolve them in the existing checkout, finish the merge, then continue the row.`
        : p.rework
        ? `REWORK reuse of ${p.reuse} (dispatch #${found.dispatchId}) — the dispatch mechanism verified ${p.base} is integrated on this same branch; read review.md and the row (verbatim) before implementing.`
        : `WARM reuse of ${p.reuse} (dispatch #${found.dispatchId}) — the full contract was delivered at its first spawn; work row ${rowPointer} in the existing checkout. Base-track first (merge ${p.base} into ${found.identity.branch}), then read the row (verbatim) before implementing.`,
    };
    if (reworkIntegration?.status !== "blocked") resumePublication = lifecycle.resume(reuseContainer);
    publishDispatchReady(reuseContainer, ready, () => { published = true; });
    return 0;
    } catch (error) {
      const rollbackFailures: string[] = [];
      if (!published && resumePublication) {
        try { rollbackReusableResume(resumePublication); }
        catch (rollbackError) { rollbackFailures.push(`resume_state: ${(rollbackError as Error).message}`); }
      }
      if (!published && scopeExpansion && scopeContextPublished) {
        try {
          replaceExactRuntimeJson({
            root: dirname(found.contextPath), path: found.contextPath,
            expected: scopeExpansion.nextContext, replacement: scopeExpansion.previousContext,
            label: "warm-reuse context rollback",
          });
        } catch (rollbackError) { rollbackFailures.push(`context: ${(rollbackError as Error).message}`); }
      }
      if (!published && rolePublication) {
        try {
          rollbackWarmReuseRoleAuthorization({
            projectRoot: p.project, pmId: p.pm, identity: reuseRoleIdentity, publication: rolePublication,
          });
        } catch (rollbackError) { rollbackFailures.push(`role_binding: ${(rollbackError as Error).message}`); }
      }
      if (!published && scopeExpansion && scopeControlPublished) {
        try {
          replaceExactRuntimeJson({
            root: dirname(found.contextPath), path: join(dirname(found.contextPath), "control_binding.json"),
            expected: scopeExpansion.nextControlBinding, replacement: scopeExpansion.previousControlBinding,
            label: "warm-reuse control-binding rollback",
          });
        } catch (rollbackError) { rollbackFailures.push(`control_binding: ${(rollbackError as Error).message}`); }
      }
      if (!published && controlBinding && sessionBefore) {
        try {
          restoreWarmReuseClaim({
            controlRoots, workId: controlBinding.work_id, sessionId: controlBinding.session_id,
            expectedCurrent: claimAfter, previousClaim: claimBefore, previousSession: sessionBefore,
          });
        } catch (rollbackError) { rollbackFailures.push(`claim: ${(rollbackError as Error).message}`); }
      }
      if (rollbackFailures.length) {
        fail(`dispatch_prepare: warm-reuse failed and authority rollback was incomplete (${rollbackFailures.join("; ")}): ${(error as Error).message}`, 4);
      }
      fail(`dispatch_prepare: warm-reuse role binding refused: ${(error as Error).message}`, 4);
    }
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const driverSrc = resolve(moduleDir, "..");
  const coreScripts = moduleDir;
  const bunExecutable = posixish(process.execPath);
  const pipelineArgs = targetBranch ? ["--target-branch", targetBranch] : [];
  if (p.pipelinePackage) {
    if (!p.blueprint) fail("dispatch_prepare: --pipeline-package requires --blueprint");
    const rc = run(["bun", resolve(driverSrc, "pipeline_packages.ts"), "render-assignment", "--blueprint", p.blueprint, "--package", p.pipelinePackage, "--role", p.role, "--task-id", "0", "--agent-id", `${p.role}(#0)`, "--pm-id", p.pm, "--slug", p.slug, ...pipelineArgs, "--base-branch", p.base, "--config", config], { stdout: "ignore", stderr: "inherit" });
    if (rc.exitCode !== 0) fail(`dispatch_prepare: invalid pipeline package ${p.pipelinePackage} for role ${p.role}`, 1);
  }
  if (p.blueprint && existsSync(p.blueprint)) {
    const bp = text(p.blueprint);
    if (/^##\s+Review sign-off\s*$/m.test(bp) && !/^[-*]?\s*Verdict:\s*(PASS|PASS_WITH_NOTES|REWORK_RECOMMENDED|BLOCK|NO_OPINION)\b/m.test(bp)) {
      err(`dispatch_prepare: WARNING — blueprint '${p.blueprint}' declares a '## Review sign-off' footer (DEC-076 high-stakes) but records no design-review Verdict. Route it through Wanderer->Observer and fill the sign-off before dispatch (W-067). Proceeding (advisory).`);
    }
  }

  // Session/startup recovery scan runs before any id claim, branch, or worktree
  // mutation. FINISHED-not-ACKED, stale RUNNING, or wake-invalid work must be
  // handled before a fresh dispatch can hide it.
  const longJobRecovery = recoverLongJobs(longJobRoot(p.project, p.pm));
  if (longJobRecovery.length > 0) {
    fail(`dispatch_prepare: durable long-job recovery pending before dispatch: ${JSON.stringify(longJobRecovery)}`, 4);
  }

  let model = "", effort = "", modelSource = "";
  let pmModel = process.env.GARELIER_PM_MODEL ?? "";
  if (!pmModel && existsSync(config)) pmModel = readQuoted(config, "pm_model");
  const routeExtras: string[] = [];
  if (p.blueprint) routeExtras.push("--blueprint", p.blueprint);
  if (p.inModel) routeExtras.push("--model", p.inModel);
  if (p.inEffort) routeExtras.push("--effort", p.inEffort);
  if (p.inScope) routeExtras.push("--scope", p.inScope);
  if (p.inTags) routeExtras.push("--tags", p.inTags);
  if (p.rework) routeExtras.push("--rework");
  if (pmModel) routeExtras.push("--pm-model", pmModel);
  const route = routing(p.project, p.pm, p.role, routeExtras);
  if (route) {
    model = String(route.model ?? ""); effort = String(route.effort ?? ""); modelSource = String(route.source ?? "");
    const warnings = Array.isArray(route.warnings) ? route.warnings : [];
    if (warnings.some((warning: unknown) => warning === "gate_flag_below_recommended_floor")) {
      err("dispatch_prepare: WARNING — 2026-07-16 doctrine recommends Terra-or-stronger for a gate verdict; dispatching the explicit --model verbatim.");
    }
    if (warnings.some((warning: unknown) =>
      warning === "flag_outside_agreed_model_range" || warning === "flag_outside_agreed_effort_range")) {
      err("dispatch_prepare: WARNING — explicit model/effort flag is outside configured [model_routing.agreement] range; dispatching it verbatim.");
    }
  } else err("dispatch_prepare: model routing best-effort skipped (bun/model_routing unavailable)");

  // Fresh dispatch provider authority is the explicit task flag. Recovery and
  // warm reuse return earlier after deriving provider authority from bindings.
  const provider = p.provider!;
  if (p.providerTransport && provider === "codex") fail("dispatch_prepare: --provider-transport is valid only with a Claude provider", 4);
  const claudeTransport = provider === "codex" ? "" : (p.providerTransport || "attended-agent");
  const codexAdvertisedModels = advertisedCodexModels(config);
  if (provider === "codex") {
    let adapted;
    try {
      adapted = adaptProviderRouting({ substrate: "codex-exec", seat: p.role, canonical: { model, effort, source: modelSource || "inherit" }, advertisedModels: codexAdvertisedModels });
    } catch (error) {
      const message = (error as Error).message;
      if (/provider routing: unsupported effort 'max'/.test(message)) {
        err(`dispatch_prepare: provider routing refused: ${message}`);
        err(`NEXT_COMMAND: ${providerEffortRecoveryCommand(argv)}`);
        throw new CliFailure(4);
      }
      throw error;
    }
    if (adapted.execution === "blocked") fail(`dispatch_prepare: ${adapted.block_reason}`, 4);
    model = adapted.model; effort = adapted.effort; modelSource = adapted.source;
  }
  if (provider !== "codex" && p.taskFile && (!model || !effort || !modelSource)) {
    fail("dispatch_prepare: recorded Claude CLI dispatch requires explicit model, non-empty effort, and model source", 4);
  }

  // Resolve the final mode before cleanup, id claim, branch creation, or
  // worktree mutation. Codex's sandbox cannot safely self-commit, so neither an
  // explicit flag nor the legacy environment override may lower this floor.
  const requestedCommitMode = provider === "codex" && !roleSeat
    ? p.inCommitMode || process.env.GARELIER_EXTERNAL_SEAT_COMMIT || "proxy"
    : "self";
  if (provider === "codex" && !roleSeat && requestedCommitMode !== "proxy") {
    fail(`dispatch_prepare: resolved Codex commit mode '${requestedCommitMode}' is forbidden; Codex-dispatched roles require proxy commit mode`);
  }
  const commitMode = roleSeat ? "read-only" : provider === "codex" ? "proxy" : "self";

  // W-224 fail-closed, BEFORE any worktree/branch mutation (same tier as the
  // routing-inherit / commit-mode blocks above): a --task-file body that
  // instructs the Codex-dispatched role to invoke a garelier-core helper directly can
  // never succeed in the sandbox (cross-repo, no --add-dir grant). This is the
  // early source (--task-file is fully read at dispatch start); a
  // pipeline/blueprint-rendered assignment.md is checked further below, right
  // after it is rendered (that source cannot exist this early).
  if (provider === "codex" && !roleSeat && taskBody && codexForbidsDirectInvoke(taskBody, canonicalProjectRoot)) {
    fail(`dispatch_prepare: --task-file instructs the Codex-dispatched role to invoke a garelier-core helper (heavy_compile_lock.ts or a garelier-core/scripts|driver path) that does not resolve inside the canonical dispatch anchor (${canonicalProjectRoot}). Codex cannot self-run an unreachable cross-repo helper or heavy gate; delegate it instead: the worker emits a '=== REQUIRED GATE (Dock-run) ===' block and the Dock seat runs it via gate_runner.ts --from-register (see this dispatch's emitted codex_knowledge.dock_gate_commands, and codex_worker_playbook.md).`, 4);
  }

  run(["bun", resolve(moduleDir, "dispatch_cleanup.ts"), "--project", p.project, "--pm-id", p.pm, "--target-root", gitRoot, "--sweep"], { stdout: "ignore", stderr: "inherit" });
  if (!p.force) {
    const duplicate = duplicateDispatch(dispatchRoot, dispatchPrefix, p.slug, p.role);
    if (duplicate) fail(`dispatch_prepare: role '${p.role}' on slug '${p.slug}' already has an in-flight dispatch (${duplicate.name}, state ${duplicate.state || "?"}) — producing another would silently duplicate it. Gate or dispatch_cleanup that one first (it is the same work), or pass --force for a deliberate parallel. (A DIFFERENT role on the same slug — a gate seat reviewing this producer — is not a duplicate and needs no rename.)`);
  }

  // W-282: perform the COMPLETE claim/binding operation before allocating the
  // dispatch id or mutating branch/container/worktree state. The earlier
  // inspectDispatchControlBinding call is intentionally only a cheap identity
  // guard; touch conflicts and stale-claim policy live in claimWork and used to
  // reject down near emitJsonLine, after a worktree already existed.
  // W-424: no-worktree read-only seats bind the Work as immutable authority but
  // do not own, renew, or release its role claim. Renewing an expired
  // same-session claim writes audit evidence into the Work and invalidates the
  // role authorization that the gate is supposed to review.
  let controlBinding: DispatchControlBinding | null = null;
  if (controlSchema === 3 && !readOnlySeat) {
    try {
      controlBinding = claimDispatchControlWork({
        roots: controlRoots,
        workId: p.workId,
        sessionId: p.controlSession,
        touches: p.inTouches.split(",").map((value) => value.trim()).filter(Boolean),
        rework: p.rework,
        namespaceLock: guard.lock,
      });
    } catch (error) {
      if ((error as Error).message.includes("stale claim requires --steal with a non-empty reason")) {
        err(`NEXT_COMMAND: ${staleClaimNextCommand({
          project: p.project,
          pmId: p.pm,
          workId: p.workId,
          sessionId: p.controlSession,
          touches: p.inTouches,
          slug: p.slug,
        })}`);
      }
      fail(`dispatch_prepare: schema-v${controlSchema} claim rejected: ${(error as Error).message}`, 4);
    }
  }

  const compensation: DispatchCompensationState = {
    binding: controlBinding,
    container: "",
    checkout: "",
    branch: "",
    containerOwned: false,
    checkoutOwned: false,
    branchExisted: false,
    startEventCompensation: null,
    published: false,
  };
  try {
  const id = await claimId(p.project, p.pm);
  const container = dispatchContainer(id);
  compensation.container = container;
  compensation.checkout = `${container}/checkout`;
  if (existsSync(container)) fail(`dispatch_prepare: container already exists: ${container}`, 1);
  const branch = readOnlySeat
    ? p.base
    : `${p.base.slice(0, -"studio".length)}${family[p.role]}/#${id}/${p.slug}`;
  const checkout = readOnlySeat ? gitRoot : `${container}/checkout`;
  compensation.branch = branch;
  compensation.checkout = checkout;
  compensation.branchExisted = readOnlySeat || Boolean(gitOut(gitRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]));
  mkdirSync(container, { recursive: true });
  compensation.containerOwned = true;
  if (controlBinding) {
    try {
      writeFileSync(`${container}/control_binding.json`, `${JSON.stringify({
        schema_version: controlBinding.schema_version,
        dispatch_id: String(id),
        work_id: controlBinding.work_id,
        session_id: controlBinding.session_id,
        touches: controlBinding.touches,
        base_sha: durableBaseSha,
      }, null, 2)}\n`);
    } catch (error) {
      try {
        releaseDispatchControlClaim(controlRoots, controlBinding.work_id, controlBinding.session_id, guard.lock);
      } catch { /* the primary error below remains actionable */ }
      try { rmSync(container, { recursive: true, force: true }); } catch { /* report original binding failure */ }
      fail(`dispatch_prepare: could not persist pre-context control binding for dispatch #${id}; claim was rolled back: ${(error as Error).message}`, 4);
    }
  }
  if (!readOnlySeat) {
    const addRc = runToStderr(["git", "-C", gitRoot, "worktree", "add", checkout, "-b", branch, p.base]);
    if (addRc !== 0) fail(`dispatch_prepare: worktree allocation failed for ${branch}`, addRc);
    compensation.checkoutOwned = true;
    ensureCheckoutDriverDependencies(checkout);
    if (roleSeat === "concierge") installConciergeGuards(checkout);
  }
  const baseSha = gitOut(gitRoot, ["rev-parse", "--short", p.base]);
  writeFileSync(`${container}/STATE.md`, `# Dispatch #${id} - ${p.role} ${p.slug}\n\n## Status\n\nWORKING\n\n## Current task\n\n#${id} ${p.slug} (${branch})\n`);
  writeFileSync(`${container}/report.md`, reportScaffold(id, p.slug, p.role, branch));
  writeFileSync(`${container}/instructions.md`, instructionLedger(id, p.slug));
  // W-143 spawn grace anchor: the epoch a role was dispatched. Both watchdogs
  // (dispatch_watch, contract_check --stall-scan) read it so a fresh role's
  // premise-read / think phase (commit 0, flat fingerprint, 0 compile procs — a
  // stall's shape) is not woken until the grace elapses. A resume touches
  // `resumed_at` alongside it (see dispatch_watch --mark-resumed).
  writeFileSync(`${container}/dispatched_at`, `${Math.floor(Date.now() / 1000)}\n`);

  const permissionProfile = profileForRole(p.role);
  const seatResultRoot = resolve(pmRoot, "runtime", p.role, "results");
  if (readOnlySeat) mkdirSync(seatResultRoot, { recursive: true });
  const fenceRoots = readOnlySeat
    ? [seatResultRoot]
    : [resolve(checkout), resolve(container)]; // W-127: ABSOLUTE — context.json stores verbatim; the guard fence compares absolute targets, so a relative `./…` false-denied every in-worktree write (#349)

  // O1 (W-168): resolve the gate seat models BEFORE writing context.json so the
  // pack's gate_agents carries them — dispatch_prepare then supplies the model the
  // machine already computed instead of the PM re-supplying it by hand.
  let guardianModel = "", observerModel = "";
  for (const seat of ["guardian", "observer"]) {
    const gateRoute = routing(p.project, p.pm, seat, pmModel ? ["--pm-model", pmModel] : []);
    const gateModel = String(gateRoute?.model ?? "");
    if (seat === "guardian") guardianModel = gateModel; else observerModel = gateModel;
  }

  // W-192 (a): classify this dispatch's risk tier from its declared touches + tags
  // and decide the gate seats mechanically (DEC-093's practice: docs-only → PM diff
  // review / test-only → 1 seat / code → G+O / security → G+O at the opus floor).
  // Emitted as `gate_plan`; the existing gate_agents map keeps BOTH seat identities
  // (dispatch_prepare / contract_check resolve either), so this is non-breaking — the
  // plan is the authoritative "which seats to actually spawn".
  const gatePlanTouches = p.inTouches.split(",").map((s) => s.trim()).filter(Boolean);
  const gatePlanTags = p.inTags.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  // W-192: apply the project's mandatory-gate policy floor so a docs-only/test-only
  // plan on a require-all-merges project shows the mandated seats up front (matching
  // what the merge gate will enforce) instead of a silent 0-seat proposal.
  const gatePlan = gatePlanFor(gatePlanTouches, gatePlanTags, readGatePolicyFloor(config));
  // Security floors both gate models at opus.
  if (gatePlan.gate_model_floor === "opus") {
    const atOrAboveOpus = (m: string) => /opus/i.test(m);
    if (!atOrAboveOpus(guardianModel)) guardianModel = "opus";
    if (!atOrAboveOpus(observerModel)) observerModel = "opus";
  }

  let context = `${container}/context.json`;
  const ctxArgs = ["--config", config, "--pm-id", p.pm, "--project", gitRoot, "--integration", p.base, "--task-id", id, "--role", p.role, "--slug", p.slug, "--branch", branch, "--base-sha", baseSha, "--commit-mode", commitMode, "--permission-profile", permissionProfile, "--fence-roots", fenceRoots.join(","), "--agent-name", seatAgentName(p.role, p.slug), "--worktree", resolve(checkout), "--gate-checkout", gitRoot, "--container", resolve(container), "--out", context];
  if (guardianModel) ctxArgs.push("--gate-model-guardian", guardianModel);
  if (observerModel) ctxArgs.push("--gate-model-observer", observerModel);
  if (p.blueprint) ctxArgs.push("--blueprint", p.blueprint);
  if (model) ctxArgs.push("--model", model);
  if (effort) ctxArgs.push("--effort", effort);
  if (modelSource) ctxArgs.push("--model-source", modelSource);
  if (p.inTouches) ctxArgs.push("--touches", p.inTouches);
  if (p.inDepends) ctxArgs.push("--depends-on", p.inDepends);
  if (p.inResourceClass) ctxArgs.push("--resource-class", p.inResourceClass);
  if (p.inRuntimeEffect) ctxArgs.push("--runtime-effect", p.inRuntimeEffect);
  if (p.inHeavyTier) ctxArgs.push("--heavy-tier", p.inHeavyTier);
  if (p.inBashBudgetMs) ctxArgs.push("--bash-budget-ms", p.inBashBudgetMs);
  if (p.fullGate) ctxArgs.push("--full-gate");
  const contextBuild = run(["bun", resolve(driverSrc, "context_pack.ts"), ...ctxArgs], { stdout: "pipe", stderr: "pipe" });
  if (contextBuild.exitCode !== 0) {
    fail(`dispatch_prepare: dispatch.env/context.json refused: ${(contextBuild.stderr.toString() || contextBuild.stdout.toString()).trim()}`, 1);
  }
  // W-191 (c): stamp the current git version of each governance file into
  // context.json so a later `--reuse` of THIS agent can diff what changed since.
  // Post-patch (the record_touches.ts pattern) so context_pack.ts stays unchanged;
  // best-effort — a write failure leaves the pack without spec_versions (an empty
  // baseline the next reuse treats as "everything added", still safe).
  const specFiles = readSpecFiles(config);
  if (context && specFiles.length) {
    try { writeFileSync(context, patchContextSpecVersions(readFileSync(context, "utf8"), computeSpecVersions(gitRoot, specFiles))); }
    catch { /* best effort */ }
  }
  if (context && controlSchema === 3) {
    try {
      const parsed = JSON.parse(readFileSync(context, "utf8")) as Record<string, unknown>;
      parsed.control = {
        schema_version: controlSchema,
        work_id: p.workId,
        session_id: p.controlSession,
        claim_owned: !readOnlySeat,
      };
      parsed.task = {
        ...(parsed.task as Record<string, unknown>),
        touch_conflicts: controlBinding?.touch_conflicts ?? [],
      };
      writeFileSync(context, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch (error) {
      fail(`dispatch_prepare: could not bind schema-v${controlSchema} Work/Backlog into context.json: ${(error as Error).message}`, 4);
    }
  }
  if (context && roleSeat === "concierge") {
    try {
      const parsed = JSON.parse(readFileSync(context, "utf8")) as Record<string, any>;
      parsed.guard = { ...(parsed.guard ?? {}), approved_remote_destinations: approvedRemoteDestinations };
      writeFileSync(context, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch (error) {
      fail(`dispatch_prepare: could not bind Concierge approved remotes into context.json: ${(error as Error).message}`, 4);
    }
  }
  if (context && roleSeat === "guardian") {
    try {
      const parsed = JSON.parse(readFileSync(context, "utf8")) as Record<string, any>;
      const scanner = resolveGateSeatCommands(pmRoot);
      parsed.guard = {
        ...(parsed.guard ?? {}),
        mandatory_scanner: {
          route: "pm-delegated",
          executor: "pm",
          commands: scanner.commands,
          config_path: scanner.configPath,
          config_drift: scanner.drift,
          evidence_contract: "PM executes in the reviewed checkout with explicit base/head SHAs; evidence records command, range, base, head, and redacted output; Guardian cites the evidence file and refuses a SHA mismatch.",
          reference: "skills/garelier-guardian/references/scanner-and-gates.md#delegated-scan--the-only-sanctioned-path-when-the-seat-cannot-run-it-w-353",
          added_write_grants: [],
        },
      };
      writeFileSync(context, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch (error) {
      fail(`dispatch_prepare: could not bind Guardian mandatory-scanner delegation into context.json: ${(error as Error).message}`, 4);
    }
  }

  if (p.pipelinePackage) {
    let targetSlug = "";
    if (p.base.startsWith("garelier/")) targetSlug = p.base.slice("garelier/".length).split("/")[0];
    const args = ["bun", resolve(driverSrc, "pipeline_packages.ts"), "render-assignment", "--blueprint", p.blueprint, "--package", p.pipelinePackage, "--role", p.role, "--task-id", id, "--agent-id", `${p.role}(#${id})`, "--pm-id", p.pm, "--target-slug", targetSlug, ...pipelineArgs, "--slug", p.slug, "--branch", branch, "--base-branch", p.base, "--base-sha", baseSha, "--config", config, "--out", `${container}/assignment.md`];
    if (run(args, { stdout: "inherit", stderr: "inherit" }).exitCode !== 0) fail(`dispatch_prepare: failed to render assignment for ${p.pipelinePackage}`, 1);
  }
  if (taskBody && !existsSync(`${container}/assignment.md`)) {
    writeFileSync(`${container}/assignment.md`, `${taskBody.trimEnd()}\n`);
  }
  if (controlSchema === 3) {
    const assignment = `${container}/assignment.md`;
    const binding = `<!-- garelier-control-v${controlSchema} work_id=${p.workId} session_id=${p.controlSession} -->\n\n`;
    if (existsSync(assignment)) writeFileSync(assignment, `${binding}${readFileSync(assignment, "utf8")}`);
    else if (taskBody) writeFileSync(assignment, `${binding}${taskBody}`);
    writeFileSync(`${container}/report.md`, `${binding}${readFileSync(`${container}/report.md`, "utf8")}`);
  }

  let pickup = `${container}/pickup_pack.json`;
  if (existsSync(`${container}/assignment.md`)) {
    let roleIndex = `${p.project}/__garelier/__atmos/knowledge/role_index.toml`;
    if (!existsSync(roleIndex)) roleIndex = `${p.project}/__garelier/${p.pm}/knowledge/role_index.toml`;
    const pickupArgs = ["--role", p.role, "--assignment", `${container}/assignment.md`, "--out", pickup];
    if (context) pickupArgs.push("--context", context);
    if (existsSync(roleIndex)) pickupArgs.push("--role-index", roleIndex);
    if (run(["bun", resolve(driverSrc, "role_pickup_pack.ts"), ...pickupArgs], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
      err("dispatch_prepare: pickup_pack.json best-effort skipped (bun/role_pickup_pack unavailable)"); pickup = "";
    }
  } else pickup = "";

  const agentName = seatAgentName(p.role, p.slug);
  const guardianName = seatAgentName("guardian", p.slug);
  const observerName = seatAgentName("observer", p.slug);
  // guardianModel / observerModel resolved above (O1, before the context.json write).
  const gateTemplate = GATE_VERDICT_TEMPLATE;
  const commitTemplate = `<type>(<scope>): <summary>  [#${id}]\n\nGarelier: ${p.pm} ${p.role}#${id} #${id}`;
  const bugFixDiscipline = "bug fix discipline: observe -> hypothesize -> verify -> fix the confirmed root cause only; reproduction test RED->GREEN first (instrumentation-log before/after when a test is impossible, e.g. visual/GPU); no guess fix / symptom-silencing guard / shotgun fix. Full rule: garelier-core/references/debugging_discipline.md (W-052).";

  let conflictCheck: any = { touches: [], depends_on: [], conflicts: [], unmet_deps: [], warning: "" };
  if (p.inTouches || p.inDepends) {
    const ccArgs = ["check", "--pm-root", pmRoot, "--self", id];
    if (p.inTouches) ccArgs.push("--touches", p.inTouches);
    if (p.inDepends) ccArgs.push("--depends-on", p.inDepends);
    const cc = runQuiet(["bun", resolve(driverSrc, "dispatch/conflict_check.ts"), ...ccArgs]);
    try {
      if (cc.code === 0 && cc.stdout) conflictCheck = JSON.parse(cc.stdout);
      else throw new Error();
      if (conflictCheck.warning && !p.allowConflict) err(`dispatch_prepare: [conflict_check] ${conflictCheck.warning}`);
    } catch { err("dispatch_prepare: conflict_check best-effort skipped (bun/conflict_check unavailable)"); }
  }

  const watchScript = posixish(resolve(coreScripts, "dispatch_watch.ts"));
  // W-362: the declared tier must reach the watch, or the whole W-348 split is
  // inert on the path that actually arms it — a heavy CODEGEN dispatch prepared
  // through the standard path would arm a CHECK-grade watch (20m x 3) and be
  // declared RUNAWAY at ~60m, killed mid-build, while compiling healthily. That
  // is the W-348 harm itself, and before this it was still reachable by default
  // because the tier only ever reached context.json.
  //
  // Appended ONLY when declared: dispatch_watch's flag-absent behaviour is a
  // documented asymmetry (it runs over every dispatch, most of them non-heavy,
  // so no flag = its own defaults, never a codegen widening). Emitting the flag
  // unconditionally would defeat that.
  //
  // Read back from context.json (written above), NOT from the raw CLI flag
  // `p.inHeavyTier`. Guardian N1(a): with the CLI as the source here and
  // context.json as the source in contract_check / dispatch_watch, the same
  // container answered differently at the same moment — prepare armed a 60m
  // check-grade watch while contract_check's re-arm handed back 240m. One canon,
  // one answer: whatever was packed is exactly what gets armed.
  const watchCmd = shellCommand(buildDispatchWatchArgv({
    bun: bunExecutable, script: watchScript, project: p.project, pm: p.pm, id, targetRoot: gitRoot,
    heavyTier: context ? declaredHeavyTier(readTextOrEmpty(context)) : null,
    // W-667 F-2: only the seats that have no workbench ref to resolve.
    branch: readOnlySeat ? branch : null,
  }));
  let launchCmd = "";
  let roleAuthorization: RoleAuthorization | null = null;
  // W-394: hoisted so the attended-agent spawn_directive / ack_cmd built below
  // (well outside the `if (providerTaskBody)` block that issues authorization)
  // can read it without recomputing bindingReference from a possibly-null
  // roleAuthorization.
  let roleBinding: ReturnType<typeof bindingReference> | null = null;
  let promptPath = "", providerResult = "", sessionRecord = "", resumeInstruction = "", resumeResult = "", resumeCmd = "";
  const assignmentPath = `${container}/assignment.md`;
  const assignmentMd = existsSync(assignmentPath) ? readFileSync(assignmentPath, "utf8") : "";
  const assignmentTask = assignmentMd.trim();
  const providerTaskBody = taskBody.trim() || assignmentTask;
  if (provider === "codex") {
    for (const hit of providerVocabularyHits(providerTaskBody)) {
      out(`PROVIDER_VOCABULARY_HIT line=${hit.line} term=${JSON.stringify(hit.term)} neutral=${JSON.stringify(hit.replacement)} action=report-only`);
    }
  }
  const canonicalWorktree = canonicalPath(checkout);
  if (provider === "codex" && !roleSeat && assignmentTask && codexForbidsDirectInvoke(assignmentTask, canonicalWorktree)) {
    fail(`dispatch_prepare: the rendered assignment instructs the Codex-dispatched role to invoke a garelier-core helper (heavy_compile_lock.ts or a garelier-core/scripts|driver path) that does not resolve inside the canonical dispatch anchor (${canonicalWorktree}). Codex cannot self-run an unreachable cross-repo helper or heavy gate; delegate it instead: the worker emits a '=== REQUIRED GATE (Dock-run) ===' block and the Dock seat runs it via gate_runner.ts --from-register (see this dispatch's emitted codex_knowledge.dock_gate_commands, and codex_worker_playbook.md).`, 4);
  }
  if (providerTaskBody) {
    const laneDir = `${container}/lane`;
    promptPath = `${laneDir}/prompt.md`;
    providerResult = readOnlySeat
      ? join(seatResultRoot, `${p.slug}-${p.role}.md`)
      : roleSeat === "concierge"
      ? `${container}/concierge_report.md`
      : provider === "codex"
      ? `${laneDir}/result.md`
      : `${container}/report.md`;
    sessionRecord = `${laneDir}/session.json`;
    resumeInstruction = `${laneDir}/followup.md`;
    resumeResult = provider === "codex" ? `${laneDir}/followup.result.md` : providerResult;
    mkdirSync(laneDir, { recursive: true });
    // Explicit PM-initiated REWORK instructions use this slot. A successful
    // proxy commit never writes it and never resumes the provider merely to
    // acknowledge bookkeeping.
    writeFileSync(resumeInstruction, "");
  }
  let lens: ResolvedRoleLensBinding = { ref: null, source: "none", registry_path: null, pack_path: null };
  if (promptPath && !existsSync(assignmentPath)) {
    fail("dispatch_prepare: role prompt exists without a canonical assignment; runnable=false and authorization refused", 4);
  }
  try {
    lens = resolveRoleLensBinding({
      projectRoot: p.project,
      pmId: p.pm,
      role: p.role,
      assignmentMd,
      blueprintMd: p.blueprint ? readFileSync(p.blueprint, "utf8") : null,
      setupConfigPath: config,
    });
  } catch (error) {
    fail(`dispatch_prepare: role Lens resolution refused: ${(error as Error).message}`, 4);
  }
  const standing = readStandingConstraints(config); // W-191 (a): project [prompt] standing constraints
  const sourcePointers = { blueprintPath: p.blueprint || null, lens };
  const preamble = roleSeat
    ? roleSeatPreamble(
      roleSeat, id, gitRoot, providerResult,
      provider === "codex" || claudeTransport === "claude-subprocess",
      sourcePointers,
    )
    : promptPreamble(p, id, branch, baseSha, container, commitMode, model, provider, providerResult, standing, sourcePointers);
  if (promptPath) {
    const promptTaskBody = p.role === "guardian" || p.role === "observer"
      ? nestTaskFileSections(providerTaskBody)
      : providerTaskBody;
    // W-667 F-9: effort travels differently per transport. Codex takes `--effort`
    // natively on the launch command; the attended-agent transport has no such
    // argument — the Agent tool that spawns the seat accepts a model but no
    // effort — so a dispatch that resolved `effort = xhigh` silently applied
    // nothing while the docs read as though routing had taken effect. The only
    // channel an attended seat actually reads is its prompt, so the resolved
    // effort is stated there, at the top, where the role sees it first.
    const effortLine = claudeTransport === "attended-agent" && effort
      ? `> Effort: ${effort}. This transport has no effort argument — the resolved routing is carried here, in the prompt, and you are expected to work at it.\n\n`
      : "";
    const renderedPrompt = `${effortLine}${preamble.trimEnd()}\n\n## Task\n\n${promptTaskBody}\n`;
    if (p.role === "guardian" || p.role === "observer") {
      // The task-file surface was checked before allocation; re-check the
      // mechanism-composed prompt against the wider generated surface.
      enforcePromptSectionContract({
        markdown: renderedPrompt,
        surface: "gate_prompt",
        sourcePath: promptPath,
        blueprintPath: p.blueprint || null,
      });
    }
    writeFileSync(promptPath, renderedPrompt);
    try {
      const knowledge = resolveRoleKnowledgeBinding({
        projectRoot: p.project, pmId: p.pm, role: p.role, assignmentMd, required: requiredKnowledgeRefs(assignmentMd),
      });
      const itemAuthority = controlSchema === 3
        ? controlAuthorityPath(controlRoots.controlRoot, controlSchema, p.workId)
        : assignmentPath;
      const itemRevision = controlBinding ? String(controlBinding.work_revision) : hashRoleFile(itemAuthority);
      const authorizationInput = {
        project_root: p.project,
        pm_id: p.pm,
        identity: roleSeat ? roleSeatExecutionIdentity(id, roleSeat) : dispatchExecutionIdentity(id),
        role: p.role as RoleKind,
        carabiner: roleSeat ? defaultRoleSeatCarabiner(roleSeat) : defaultRoleCarabiner(p.role as RoleKind),
        item: { work_id: p.workId || `dispatch:${id}`, revision: itemRevision, session_id: p.controlSession || `legacy:${id}`, authority_path: itemAuthority },
        assignment_path: assignmentPath,
        blueprint_path: p.blueprint || null,
        package_id: p.pipelinePackage || null,
        prompt_path: promptPath,
        routing: { provider: provider === "codex" ? "codex-cli" : claudeTransport, model, effort, source: modelSource },
        lens,
        knowledge,
        integration: { ref: p.base, base_sha: durableBaseSha },
        initial_instructions_path: `${container}/instructions.md`,
        issuer: { role: "dock", id: `dispatch_prepare:${process.pid}` },
      };
      roleAuthorization = roleSeat
        ? issueRoleSeatAuthorization(authorizationInput)
        : issueRoleAuthorization(authorizationInput);
      if (context) {
        const packed = JSON.parse(readFileSync(context, "utf8")) as Record<string, unknown>;
        if (roleSeat) packed.role_seat_binding = bindingReference(roleAuthorization);
        else writeRoleBindingToContext(packed, bindingReference(roleAuthorization));
        writeFileSync(context, `${JSON.stringify(packed, null, 2)}\n`);
      }
      if (pickup && existsSync(pickup)) {
        const pickupPack = JSON.parse(readFileSync(pickup, "utf8")) as Record<string, unknown>;
        if (roleSeat) pickupPack.role_seat_binding = bindingReference(roleAuthorization);
        else pickupPack.role_binding = bindingReference(roleAuthorization);
        writeFileSync(pickup, `${JSON.stringify(pickupPack, null, 2)}\n`);
      }
    } catch (error) {
      fail(`dispatch_prepare: role authorization refused: ${(error as Error).message}`, 4);
    }
    roleBinding = bindingReference(roleAuthorization);
    if (provider === "codex" || (claudeTransport === "claude-subprocess" && model && effort && modelSource)) {
      const providerScript = posixish(resolve(coreScripts, "dispatch_provider.ts"));
      const command = [
        bunExecutable, providerScript, "--provider", provider === "codex" ? "codex" : "claude-code",
        "--worktree", checkout, "--project", p.project, "--prompt", promptPath,
        "--result", providerResult, "--session-record", sessionRecord, "--role", p.role, "--slug", p.slug,
      ];
      if (roleSeat) command.push("--seat-role", roleSeat, "--seat-dispatch-id", id, "--context", context);
      if (model) command.push("--model", model);
      if (effort) command.push("--effort", effort);
      if (modelSource) command.push("--model-source", modelSource);
      command.push("--pm-id", p.pm, "--binding-generation", String(roleBinding.generation), "--binding-digest", roleBinding.binding_digest);
      if (p.targetRoot && gitRoot !== p.project) command.push("--target-root", gitRoot);
      launchCmd = shellCommand(command);
      err("dispatch_prepare: recorded provider seat — launch ONLY via the emitted dispatch_provider.ts command");
    }
    if (launchCmd && !roleSeat) {
      const sessionScript = posixish(resolve(coreScripts, "provider_session.ts"));
      resumeCmd = shellCommand([bunExecutable, sessionScript, "resume", "--record", sessionRecord, "--instruction", resumeInstruction, "--result", resumeResult, "--worktree", `${container}/checkout`, "--expected-model", model, "--expected-effort", effort, "--expected-source", modelSource, "--project", p.project, "--pm-id", p.pm, "--dispatch-id", id, "--role", p.role, "--slug", p.slug, "--binding-generation", String(roleBinding.generation), "--binding-digest", roleBinding.binding_digest]);
    }
  }
  const noPromptBlock = "BLOCK: no provider prompt was generated; prepare a real task/assignment prompt before spawning any provider";
  // W-394: the attended parent (Agent tool spawn) is the only party that can
  // ever know the real returned agent handle, so this cmd is emitted as a
  // TEMPLATE — project/pm-id/dispatch-id are already resolved here, but
  // --agent-handle / --parent-id are appended by the parent after spawn
  // returns. Generation/binding_digest are NOT in this command: the CLI
  // resolves them itself from this dispatch's own context.json role_binding
  // (dispatch_prepare.ts --ack-launch), so nothing here can go stale if a
  // role_recovery later replaces the generation.
  const ackCmd = provider !== "codex" && claudeTransport === "attended-agent" && roleBinding
    ? shellCommand([bunExecutable, posixish(resolve(coreScripts, "dispatch_prepare.ts")), "--ack-launch", "--dispatch-id", id, "--project", p.project, "--pm-id", p.pm])
    : "";
  const ackDirectiveSuffix = ackCmd
    ? ` After the Agent tool call returns a real handle, acknowledge the launch (required before merge admission): run \`${ackCmd} --agent-handle <returned agent id/handle> --parent-id <your session/pm id>\` (see ack_cmd; binding generation/digest resolve automatically from this dispatch's context.json, W-394).`
    : "";
  const spawnDirective = !promptPath
    ? noPromptBlock
    : provider === "codex"
    ? (launchCmd
      ? `Codex provider: use ONLY launch_cmd. If it fits bash_timeout_budget_ms, run it directly and wait; otherwise arm the unchanged launch_cmd as ONE durable long-job command and start the single-flight broker. Never use raw codex exec or an ad-hoc background waiter.`
      : `Codex provider: launch_cmd is intentionally empty because no task/assignment prompt was available; use the existing manual handoff path.`)
    : claudeTransport === "claude-subprocess"
    ? (launchCmd
      ? "Claude subprocess provider: use only launch_cmd; failed send/result requires a fresh role generation, never a same-generation retry."
      : "BLOCK: recorded Claude subprocess requires a task/assignment plus explicit model and non-empty effort")
    : model
    ? `Agent tool call for this dispatch MUST set model=${model} and name=${agentName} explicitly - omitting model silently inherits the PARENT PM session's model instead of this resolved routing decision (source=${modelSource}). See workflow-naming.md section 5 for the name convention.${ackDirectiveSuffix}`
    : `model resolved to inherit (empty, source=${modelSource}) - the Agent tool call still needs name=${agentName} explicitly; passing no model here is correct, but confirm that is intentional before spawning.${ackDirectiveSuffix}`;
  const providerTaskMessage = promptPath
    ? roleSeat
      ? `Execute Garelier ${p.role} dispatch #${id}. Read ${promptPath} and ${context}; inspect ${checkout} without repository writes and deliver only the designated artifact.`
      : `Execute Garelier ${p.role} dispatch #${id}. Read ${promptPath} and ${context}; work only in ${checkout}; finish with the compact register.`
    : "";
  const claudeParentDirective = promptPath ? `${spawnDirective} Task message: ${JSON.stringify(providerTaskMessage)}` : noPromptBlock;
  const longJobRunner = posixish(resolve(coreScripts, "long_job_runner.ts"));
  const longJobPolicy = {
    ledger_root: posixish(longJobRoot(p.project, p.pm)),
    runner: longJobRunner,
    whole_command_only: true,
    command_ref_required: true,
    launch_once: true,
    tracked_transport: "single-flight-broker",
    wake_must_be_armed_before_launch: true,
    completion_action: "read result/log then ACK exact job_id+attempt; no rerun",
    recovery_action: "audit pid/log/exit/cwd/digest, then rearm same whole command once",
    timeout_settings: "read-only; never write/change/suggest/inject",
  };
  const proxyResult = providerResult || `${container}/codex_last_message.md`;
  const proxyCommitCmd = provider === "codex" && commitMode === "proxy"
    ? shellCommand([bunExecutable, posixish(resolve(coreScripts, "dock_proxy.ts")), "--project", p.project, "--pm-id", p.pm, "--dispatch-id", id])
    : "";

  const w071Ids: string[] = [];
  for (const tag of p.inTags.replace(/,/g, " ").split(/\s+/).filter(Boolean)) if (/^W-\d+/.test(tag)) w071Ids.push(tag);
  const slugMatch = p.slug.match(/^w(\d+)/);
  const slugId = slugMatch ? `W-${slugMatch[1]}` : "";
  if (slugId && !w071Ids.includes(slugId)) w071Ids.push(slugId);
  let stalePremise = "";
  for (const item of w071Ids) {
    const r = git(gitRoot, ["log", "--grep", `\\[${item}\\]`, "--grep", `${item} `, "--oneline", "-5", p.base, "--"]);
    const hits = r.exitCode === 0 ? r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 5).join(";") : "";
    if (hits) stalePremise += `${item} already appears in ${p.base} history — verify the row is not stale before launching: ${hits}; `;
  }
  if (stalePremise) err(`dispatch_prepare: [stale_premise] ${stalePremise}-- read the commits (git log --grep '<id>') and the row's acceptance before launching; abandon + cleanup if the work already landed (W-071).`);

  // W-224: bundle codex-specific operating knowledge AT THE DECISION POINT
  // (provider resolved to "codex") instead of relying on the PM to remember
  // codex_worker_playbook.md — the reachability defect that let a hand-written
  // target-project prompt reinvent (incorrectly) a mechanism dispatch_prepare
  // already solves. dock_gate_commands is the same command set the worker would
  // otherwise self-run (quality_gate[default_gate]): codex's sandbox cannot
  // acquire heavy_compile_lock (W-157/#361), so these are the Dock seat's queue.
  let codexKnowledge: Record<string, unknown> | null = null;
  if (provider === "codex") {
    let gateCommands: string[] = [];
    if (context && existsSync(context)) {
      try {
        const parsedCtx = JSON.parse(readFileSync(context, "utf8")) as {
          quality_gate?: { default_gate?: "scoped" | "fast" | "full"; scoped?: string[]; fast?: string[]; full?: string[] };
        };
        const qg = parsedCtx.quality_gate;
        if (qg) gateCommands = (qg.default_gate === "scoped"
          ? qg.scoped ?? []
          : qg.default_gate === "fast"
          ? qg.fast ?? []
          : qg.full ?? [])
          .map((command) => String(command).trim())
          .filter(Boolean);
      } catch { /* best-effort - context.json is itself best-effort upstream */ }
    }
    // O1 (Observer, 2026-07-27): gate_runner.ts lives in the SAME directory as
    // this script (driver/src/scripts/), not garelier-core/scripts/ - the
    // hand-written string this replaced was the exact wrong-path shape
    // a real target-project incident hit (in the mirror direction). Resolve it absolutely, like
    // read_first.path just above: a relative "skills/garelier-core/..."
    // string only resolves with cwd = the framework repo root, but the
    // primary consumer of codex_knowledge is a TARGET PROJECT PM
    // whose cwd is the target repo, not this one.
    const gateRunnerPath = posixish(resolve(moduleDir, "gate_runner.ts"));
    codexKnowledge = {
      read_first: {
        path: posixish(resolve(moduleDir, "..", "..", "..", "references", "codex_worker_playbook.md")),
        summary: "heavy build lock = the Dock seat runs the delegated gate via gate_runner.ts (codex sandbox cannot acquire heavy_compile_lock, W-157/#361) - NEVER instruct a codex prompt to invoke heavy_compile_lock.ts or any garelier-core script path directly (cross-repo, no --add-dir grant, unreachable); prompt must be self-contained (codex cannot read Garelier skills); when hand-invoking codex directly outside launch_cmd, omit --model rather than guessing a name; cold builds serialize behind other heavy lanes (sccache is unavailable in-sandbox).",
      },
      dock_gate_commands: gateCommands,
      dock_gate_note: gateCommands.length
        ? `codex cannot self-run these (sandbox cannot take heavy_compile_lock). First issue the Dock seat outside gate_runner with dispatch_prepare.ts --attended-seat --role dock --slug <slug> --worktree <checkout> --project <project> --pm-id <pm>; bind its JSON name / record_path as GARELIER_ROLE=dock, GARELIER_AGENT_NAME, and GARELIER_DISPATCH_RECORD. Run via: bun ${gateRunnerPath} --project <project> --pm-id <pm> --cwd <checkout> --from-register <result file>. gate_runner never issues a permission record and blocks before execution when that external binding is absent or mismatched. --from-register requires the complete project-owned [quality_gate.register] policy: declared command prefixes, touched-path coverage, terminal whole-project closure, run-summary patterns, and test-tree marker/root inventory. Missing or unsatisfied declarations block GREEN; every accepted command still passes command_guard under the lock.`
        : "no quality_gate commands were resolved for this dispatch (scoped, fast, and full all empty) - re-check --touches / the project's [quality_gate] config before assuming there is no Dock gate to run.",
    };
  }
  const taskLabel = `#${id} ${p.slug} dispatched${p.pipelinePackage ? ` [${p.pipelinePackage}]` : ""}`;
  compensation.startEventCompensation = [
    "bun", resolve(coreScripts, "dispatch_event.ts"),
    "--project", p.project, "--pm-id", p.pm, "--kind", "cleanup",
    "--role", `${p.role}(#${id})`, "--task", `${taskLabel} (pre-ready compensated)`,
  ];
  const eventRc = runToStderr(["bun", resolve(coreScripts, "dispatch_event.ts"), "--project", p.project, "--pm-id", p.pm, "--kind", "start", "--role", `${p.role}(#${id})`, "--task", taskLabel]);
  if (eventRc !== 0) fail(`dispatch_prepare: start event failed for dispatch #${id}`, eventRc);
  const ready = {
    id: Number(id), container, checkout, has_worktree: !readOnlySeat, branch, base_sha: baseSha,
    target_root: gitRoot, context, pickup_pack: pickup, label: `${p.role}:${p.slug}`, name: `${p.role}(#${id})`,
    control_binding: controlBinding,
    agent_name: agentName, model, effort, model_source: modelSource,
    codex_advertised_models: codexAdvertisedModels,
    dispatch_env: JSON.parse(readFileSync(context, "utf8")).dispatch_env,
    spawn_directive: spawnDirective, provider, provider_transport: provider === "codex" ? "codex-cli" : claudeTransport,
    // W-394: the attended parent completes this template with --agent-handle
    // (the real handle the Agent tool call returned) + --parent-id, after a
    // successful spawn. Empty for any non-(attended-agent Claude worker) route.
    ack_cmd: ackCmd,
    runnable: roleAuthorization !== null && Boolean(promptPath),
    runnable_reason: roleAuthorization !== null ? `canonical ${roleSeat ? "role-seat" : "role"} authorization issued; launch acknowledgement pending` : "no non-empty role prompt/assignment; authorization not issued",
    role_binding: !roleSeat && roleAuthorization ? bindingReference(roleAuthorization) : null,
    role_seat_binding: roleSeat && roleAuthorization ? bindingReference(roleAuthorization) : null,
    provider_source: providerFromFlag ? "task-flag" : "framework-default",
    commit_mode: commitMode,
    codex_knowledge: codexKnowledge,
    provider_parent_routes: {
      claude_code_parent: !promptPath
        ? { transport: "blocked", directive: noPromptBlock }
        : provider !== "codex" && claudeTransport === "attended-agent"
        ? {
          transport: "Agent/Workflow",
          name: agentName,
          model,
          effort,
          message: providerTaskMessage,
          prompt_file: promptPath,
          context,
          checkout,
          role: p.role,
          dispatch_id: Number(id),
          completion_contract: roleSeat
            ? "write only the designated role artifact; do not mutate repository files"
            : "finish with the compact register; write the report, STATE, and instruction ledger required by the prompt",
          directive: claudeParentDirective,
        }
        : provider !== "codex" && claudeTransport === "claude-subprocess"
        ? { transport: "recorded-cli", launch_cmd: launchCmd, directive: launchCmd ? spawnDirective : "BLOCK: no provider prompt was emitted" }
        : { transport: "blocked", directive: "BLOCK: configured provider is Codex CLI; use codex_cli" },
      codex_cli: !promptPath
        ? { transport: "blocked", directive: noPromptBlock }
        : provider === "codex"
        ? { transport: "recorded-cli", launch_cmd: launchCmd, directive: launchCmd ? spawnDirective : noPromptBlock }
        : { transport: "blocked", directive: "BLOCK: configured provider is Claude; use claude_code_parent and do not substitute Codex CLI" },
    },
    long_job_policy: longJobPolicy,
    watch_wake_directive: "watch_cmd observes dispatch liveness; over-budget command completion uses one long-job broker transport, not one tracked waiter per job",
    permission_profile: permissionProfile, fence_roots: fenceRoots,
    commit_template: commitTemplate, bug_fix_discipline: bugFixDiscipline,
    launch_cmd: launchCmd, watch_cmd: watchCmd, prompt_file: promptPath, result_file: providerResult,
    session_record: sessionRecord, resume_cmd: resumeCmd,
    resume_instruction_file: resumeInstruction, resume_result_file: resumeResult,
    proxy_commit_cmd: proxyCommitCmd, prompt_preamble: preamble, stale_premise_warning: stalePremise, conflict_check: conflictCheck,
    gate_agents: {
      guardian: { name: guardianName, model: guardianModel, report: seatReportPath("guardian", p.slug), verdict_template: gateTemplate, work_id: p.workId || undefined },
      observer: { name: observerName, model: observerModel, report: seatReportPath("observer", p.slug), verdict_template: gateTemplate, work_id: p.workId || undefined },
    },
    // W-192 (a): the risk-tier gate decision — spawn EXACTLY gate_plan.seats (the
    // gate_agents map above carries both identities regardless). docs-only ⇒ seats:[]
    // + pm_review_only (PM diff-reviews it); security ⇒ opus floor (already applied
    // to the gate_agents models above).
    gate_plan: gatePlan,
  };
  publishDispatchReady(container, ready, () => { compensation.published = true; });
  // W-622 [LD-8] — say who commits, in the output the dispatcher actually reads.
  //
  // commit_mode has always been in context.json and ready.json, which means it is
  // known only to someone who opens them. A PM carried a codex lane's procedure
  // over to a claude-code lane and instructed the producer "do not commit, I will
  // proxy-commit" — on a lane whose commit_mode was `self`. The producer measured
  // it and corrected the instruction. One stderr line ahead of the JSON removes
  // the whole class; it changes nothing about how commits are routed.
  err(
    `dispatch_prepare: commit_mode=${commitMode} — `
    + (commitMode === "proxy"
      ? "the Dock proxy-commits this lane; the role must NOT commit."
      : "the role commits in its own checkout; there is no proxy commit and no Garelier-Seat proxy trailer."),
  );
  return 0;
  } catch (error) {
    const failures = compensateFailedDispatch(compensation, controlRoots, gitRoot, guard.lock);
    if (failures.length) err(`dispatch_prepare: compensation incomplete: ${failures.join("; ")}`);
    throw error;
  }
  } finally { guard.release(); }
}

function gitOut(root: string, args: string[]): string {
  const r = git(root, args); return r.exitCode === 0 ? r.stdout.trim() : "";
}

// Best-effort read: an unreadable context.json means "no declaration", which is the
// same conservative outcome as a dispatch that declared nothing.
function readTextOrEmpty(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

// W-362: the argv for the watch command dispatch_prepare arms alongside a
// dispatch, extracted so the tier propagation is verifiable directly against the
// production builder instead of against a test's own re-implementation of the hop
// (the W-348 N1b "test-only link"). `contract_check.buildWatchCmd` reconstructs
// this same shape for a watch that lapsed; the two must stay in step.
export function buildDispatchWatchArgv(a: {
  bun: string; script: string; project: string; pm: string; id: string;
  targetRoot: string; heavyTier?: string | null; branch?: string | null;
}): string[] {
  const argv = [a.bun, a.script, "--project", a.project, "--pm-id", a.pm, "--id", a.id, "--target-root", a.targetRoot];
  // W-667 F-2: a read-only seat (scout / observer / guardian) never gets a
  // workbench branch, so dispatch_watch's `refs/heads/**/#<id>/<slug>` lookup
  // finds nothing and exits 2 with "cannot resolve branch for id <id> — pass
  // --branch". The emitted command could not run as emitted, and the operator
  // supplied the studio branch by hand every time. Whoever emits a command owns
  // its runnability: the seat's branch is known here, so pass it.
  if (a.branch) argv.push("--branch", a.branch);
  // Declared-only (see the call site): dispatch_watch treats an absent flag as
  // "use my documented defaults", and it watches non-heavy dispatches too.
  if (a.heavyTier) argv.push("--heavy-tier", a.heavyTier);
  return argv;
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch (error) { process.exit(error instanceof CliFailure ? error.exitCode : 1); }
}
