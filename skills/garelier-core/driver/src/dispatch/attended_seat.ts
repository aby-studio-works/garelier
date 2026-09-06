// PM-attended seat library. Its only CLI owner is scripts/dispatch_prepare.ts.
//
// Hand-making a gate/worker seat is where names drift ("サブの名称が ga-role でなくなって
// いる") and records get forgotten (→ every command asks). This helper does all of it
// in one call: it resolves the canonical seat identity, issues the attended
// permission record (--pm-direct), and prints a spawn plan (name + profile + report
// path + verdict template + prompt skeleton). The PM only appends the task-specific
// prompt and passes name/model to the Agent tool.
//
// For a gate seat tied to a prepared dispatch (--dispatch-id), the name / report /
// verdict template are read VERBATIM from that dispatch's context.json gate_agents
// (dispatch_prepare + context_pack + this tool all derive identity from the shared
// gate_agents.ts, so they cannot drift). It never relaxes policy — it only supplies
// the record command_guard already reads; the deny floor is unaffected.

import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeAttendedRecord, type AttendedProfile } from "../guard/attended_record.ts";
import { resolveGateSeatCommands } from "../guard/gate_seat_commands.ts";
import { optionalNonEmptyArg } from "../guard/non_empty.ts";
import { assertSafeLeaf } from "../guard/path_guard.ts";
import { crewSubdir } from "../workspace.ts";
import {
  acknowledgeRoleLaunch,
  dispatchExecutionIdentity,
  RoleLaunchReplayError,
  roleBindingFromContext,
  validateRoleLaunchPending,
  type RoleBindingReference,
} from "../dispatch/role_binding.ts";
import { assertSingleVerdictPath, GATE_VERDICT_TEMPLATE, seatAgentName, seatReportPath } from "../scripts/gate_agents.ts";
import { installConciergeGuards } from "../scripts/install_concierge_guards.ts";
import { type ApprovedRemoteDestination } from "../guard/approved_remotes.ts";
import { ROLE_PERMISSION_PROFILE } from "../guard/permission_profiles.ts";
import { ROLE_SKILL_DIR, type RoleKind } from "../role_contracts.ts";
import {
  renderRoleSourcePointerSection,
  resolveRoleLensBinding,
  type RoleSourcePointerOptions,
  type ResolvedRoleLensBinding,
} from "../lenses.ts";
import { assertPromptSections } from "../dispatch/prompt_section_contract.ts";
import { gateRunRecordPath } from "./gate_run_record.ts";
import {
  dockReviewRecordPath,
  readDockReviewHandoffRecord,
  reviewGateLogPath,
  verifyDockReviewHandoffRecord,
} from "./dock_review_record.ts";
import { git } from "../scripts/_lib.ts";

/** Every managed Garelier role can be prepared before an Agent-tool spawn.
 * Wanderer is intentionally absent: it is an external session, never an Agent
 * seat (DEC-076). */
export type SpawnRole = RoleKind;

const MANAGED_SPAWN_ROLES = Object.freeze(Object.keys(ROLE_SKILL_DIR) as SpawnRole[]);

export function roleProfile(role: string): AttendedProfile {
  if (!Object.hasOwn(ROLE_SKILL_DIR, role)) {
    throw new Error(`dispatch_prepare: --role must be a managed Garelier role (${MANAGED_SPAWN_ROLES.join("|")}; got '${role}')`);
  }
  return ROLE_PERMISSION_PROFILE[role as SpawnRole];
}
export type GateRole = "guardian" | "observer";
// W-182: a type predicate (not `: boolean`), so a guarded `role` narrows to
// GateRole and `ctx.gate_agents[role]` type-checks (the latent tsc error was
// indexing the `{ guardian; observer }` map with an un-narrowed SpawnRole).
export function isGateRole(role: SpawnRole): role is GateRole { return role === "guardian" || role === "observer"; }

// O1: model comes through so the --dispatch-id plan carries the dispatch's already-
// resolved gate model (the PM does not re-supply a value the machine computed).
export interface GateAgentInfo { name: string; report: string; verdict_template: string; model?: string }
export interface DispatchContext {
  slug: string | null;
  worktree: string | null;
  branch: string | null;
  base_sha: string | null;
  gate_agents: { guardian: GateAgentInfo; observer: GateAgentInfo } | null;
  routing: { model: string | null; effort: string | null; source: string | null };
  role_binding: RoleBindingReference | null;
  role_seat_binding: RoleBindingReference | null;
  blueprint_path: string | null;
}

/** Read a dispatch container's context.json — the slug, checkout worktree, branch,
 * and the declared gate_agents (adopted verbatim for a gate seat). Null when
 * unreadable. */
export function readDispatchContext(container: string): DispatchContext | null {
  const path = join(container, "context.json");
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    return {
      slug: j?.task?.slug ?? j?.slug ?? null,
      worktree: j?.guard?.worktree ?? j?.worktree ?? null,
      branch: j?.task?.branch ?? j?.branch ?? null,
      base_sha: j?.task?.base_sha ?? null,
      gate_agents: j?.gate_agents ?? null,
      routing: {
        model: j?.routing?.model ?? null,
        effort: j?.routing?.effort ?? null,
        source: j?.routing?.source ?? null,
      },
      role_binding: roleBindingFromContext(j) ?? null,
      role_seat_binding: j?.role_seat_binding ?? null,
      blueprint_path: typeof j?.anchors?.source === "string" ? j.anchors.source : null,
    };
  } catch { return null; }
}

const MAX_REVIEW_HANDOFF_BYTES = 4 * 1024 * 1024;

export interface DockReviewHandoffInspection {
  ready: boolean;
  reason: string;
  review_sha: string | null;
  final_accounting: string;
  scanner_evidence: string | null;
  scanner_evidence_json: string | null;
  gate_log: string | null;
}

function readReviewHandoffArtifact(path: string, label: string): string {
  const safe = assertSafeLeaf(path, `Dock review handoff ${label}`);
  const info = lstatSync(safe);
  if (!info.isFile() || info.size > MAX_REVIEW_HANDOFF_BYTES) {
    throw new Error(`${label} is not a bounded regular file: ${safe}`);
  }
  return readFileSync(safe, "utf8");
}

function evidencePath(path: string): string {
  return resolve(path).replace(/\\/g, "/");
}

/**
 * A refusal that names the artifact but not its writer sends the reader looking
 * for a file format to imitate by hand — and a hand-written file at a canonical
 * path is exactly what the checks below reject. Every refusal about an artifact
 * this function does not own therefore names the writer and prints the one
 * command that regenerates it. The command is printed, never executed: telling
 * is the mechanism's job, running it is the operator's (W-628).
 */
function regenerateVia(project: string, pmId: string, dispatchId: string): string {
  return "bun skills/garelier-core/driver/src/scripts/review_prepare.ts"
    + ` --project ${project} --pm-id ${pmId} --dispatch-id ${dispatchId}`
    + " --expected-studio-sha <studio full SHA>";
}

/**
 * Mechanical postcondition for the real Dock -> Guardian/Observer handoff.
 *
 * review_prepare.ts owns all four artifacts. Gate-seat issuance consumes this
 * inspection directly, so a caller cannot bypass review preparation merely by
 * skipping the PM procedure helper. Scanner evidence is intentionally part of
 * the same postcondition, under its canonical SHA-derived basename: the final
 * accounting is not complete unless both scanner-<sha>.md and its JSON facts
 * bind the checkout's current HEAD, base, command, and cwd.
 *
 * PV-1 (OBS-RW-001): all four artifacts live under `dispatch<N>/lane/`, and
 * provider_session.ts grants the producer write access to the worktree AND its
 * whole parent container — `lane/` included. Content checks alone therefore
 * admit an artifact set the PRODUCER authored. Acceptance ends on provenance:
 * the coordinator-owned record under the PM control root's runtime tree must
 * exist, bind this dispatch identity, record the GREEN and fully-covered gate
 * run, and still digest-match every artifact read here.
 */
export function inspectDockReviewHandoff(args: {
  project: string;
  pmId: string;
  dispatchId: string;
}): DockReviewHandoffInspection {
  const container = crewSubdir(args.project, args.pmId, `dispatch${args.dispatchId}`);
  const lane = resolve(container, "lane");
  const finalAccounting = resolve(lane, "final_accounting.md");
  const missing = (reason: string, reviewSha: string | null = null): DockReviewHandoffInspection => ({
    ready: false,
    reason,
    review_sha: reviewSha,
    final_accounting: finalAccounting,
    scanner_evidence: reviewSha ? resolve(lane, `scanner-${reviewSha.slice(0, 12)}.md`) : null,
    scanner_evidence_json: reviewSha ? resolve(lane, `scanner-${reviewSha.slice(0, 12)}.md.json`) : null,
    gate_log: reviewSha ? reviewGateLogPath(lane, reviewSha) : null,
  });
  const regenerate = regenerateVia(args.project, args.pmId, args.dispatchId);
  /** Refusal about an artifact written elsewhere: say who writes it and how to redo it. */
  const missingArtifact = (
    reason: string,
    writer: string,
    reviewSha: string | null = null,
  ): DockReviewHandoffInspection =>
    missing(`${reason} (written by ${writer}, not by hand; regenerate: ${regenerate})`, reviewSha);

  const ctx = readDispatchContext(container);
  if (!ctx?.worktree || !ctx.branch || !ctx.base_sha) {
    return missing("context.json does not declare worktree, branch, and base SHA");
  }
  const checkout = resolve(ctx.worktree);
  const headProbe = git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const reviewSha = headProbe.stdout.trim();
  if (headProbe.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(reviewSha)) {
    return missing("checkout HEAD is not a resolvable full commit SHA");
  }
  const baseProbe = git(checkout, ["rev-parse", "--verify", `${ctx.base_sha}^{commit}`]);
  const baseSha = baseProbe.stdout.trim();
  if (baseProbe.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
    return missing("declared base is not a resolvable full commit SHA", reviewSha);
  }

  const scannerEvidence = resolve(lane, `scanner-${reviewSha.slice(0, 12)}.md`);
  const scannerJson = `${scannerEvidence}.json`;
  const gateLog = reviewGateLogPath(lane, reviewSha);
  try {
    const guardianScanPath = resolve(lane, "secret-scan.md");
    const guardianScan = JSON.parse(readReviewHandoffArtifact(guardianScanPath, "Guardian scan")) as Record<string, any>;
    if (guardianScan.scan_state !== "complete" || guardianScan.scope?.base_ref !== baseSha
      || guardianScan.scope?.head_ref !== reviewSha) {
      return missingArtifact("Guardian scan does not bind the current review base and HEAD", "skills/garelier-core/driver/src/guardian_scan.ts via review_prepare.ts", reviewSha);
    }

    readReviewHandoffArtifact(scannerEvidence, "canonical scanner evidence");
    const scanner = JSON.parse(readReviewHandoffArtifact(scannerJson, "canonical scanner evidence JSON")) as Record<string, any>;
    const declaredScanner = resolveGateSeatCommands(resolve(args.project, "__garelier", args.pmId));
    if (declaredScanner.commands.length !== 1 || declaredScanner.drift.length > 0
      || scanner.schema_version !== 1 || scanner.generated_by !== "scanner_evidence.ts"
      || scanner.base !== baseSha || scanner.head !== reviewSha || scanner.exit !== 0
      || scanner.scanner_command !== declaredScanner.commands[0]
      || typeof scanner.cwd !== "string" || !scanner.cwd.trim()
      || resolve(scanner.cwd) !== checkout) {
      return missingArtifact("canonical scanner evidence does not bind the current review metadata", "skills/garelier-core/driver/src/scripts/scanner_evidence.ts", reviewSha);
    }

    const runRecordPath = gateRunRecordPath(args.project, args.pmId, gateLog);
    // W-710: the log must be readable (it is digested evidence), but this seat
    // does not PARSE it. Whether the run was GREEN, which run it was, and which
    // commit it measured are all fields of the Dock review record verified
    // below — coordinator-owned, outside the producer's write fence, and bound
    // to the log's exact bytes. Re-deriving the same verdict from producer-
    // writable prose added a second, weaker answer to a question the seal
    // already answers.
    readReviewHandoffArtifact(gateLog, "canonical gate log");

    const accounting = readReviewHandoffArtifact(finalAccounting, "final accounting");
    const requiredFacts = [
      `- Branch: \`${ctx.branch}\``,
      `- Declared base SHA: \`${baseSha}\``,
      `- Proxy / review SHA: \`${reviewSha}\``,
      `- Guardian scan: \`${evidencePath(guardianScanPath)}\``,
      `- Mandatory scanner evidence: \`${evidencePath(scannerEvidence)}\``,
      `- Mandatory scanner evidence JSON: \`${evidencePath(scannerJson)}\``,
      `- Gate log: \`${evidencePath(gateLog)}\``,
      "- Gate result: GREEN (exit 0)",
    ];
    const absent = requiredFacts.find((fact) => !accounting.includes(fact));
    if (absent) return missingArtifact(`final accounting is missing bound fact: ${absent}`, "skills/garelier-core/driver/src/scripts/review_prepare.ts", reviewSha);
    const coverage = /^- Coverage: (.+)$/m.exec(accounting)?.[1];
    if (!coverage || !/^COVERED \((\d+) of \1 changed paths\)$/.test(coverage)) {
      return missing(`final accounting coverage is not complete: ${coverage ?? "missing"}`, reviewSha);
    }
    const coverageMapSource = /^- Coverage map source: (.+)$/m.exec(accounting)?.[1];
    if (!coverageMapSource || !/^(?:candidate checkout|studio fallback \(candidate config untracked\))$/.test(coverageMapSource)) {
      return missing(`final accounting coverage-map source is invalid: ${coverageMapSource ?? "missing"}`, reviewSha);
    }
    const coverageMapVsStudio = /^- Coverage map vs studio: (CHANGED|UNCHANGED)$/m.exec(accounting)?.[1];
    if (!coverageMapVsStudio) {
      return missing("final accounting does not bind candidate/studio coverage-map relation", reviewSha);
    }

    // Provenance is the last and decisive check: everything above is producer-
    // writable, this is not.
    const recordPath = dockReviewRecordPath(args.project, args.pmId, args.dispatchId);
    const record = readDockReviewHandoffRecord(recordPath);
    if (!record) {
      return missing(
        `no coordinator-owned Dock review record at ${evidencePath(recordPath)}; the lane artifacts were not produced by review_prepare.ts`,
        reviewSha,
      );
    }
    const provenance = verifyDockReviewHandoffRecord({
      record,
      dispatchId: args.dispatchId,
      branch: ctx.branch,
      baseSha,
      reviewSha,
      // W-710: the run record is part of the consumed evidence exactly when the
      // run wrote one, derived with the same existence test review_prepare uses.
      // A producer that deletes it, or forges one after the seal, changes this
      // set away from the sealed one and the comparison fails the seat closed.
      evidence: [guardianScanPath, scannerEvidence, scannerJson, gateLog, finalAccounting,
        ...(existsSync(runRecordPath) ? [runRecordPath] : [])],
    });
    if (!provenance.ok) return missing(provenance.reason, reviewSha);
  } catch (error) {
    return missing(error instanceof Error ? error.message : String(error), reviewSha);
  }
  return {
    ready: true,
    reason: "Dock review handoff binds current HEAD, scans, gate, and final accounting",
    review_sha: reviewSha,
    final_accounting: finalAccounting,
    scanner_evidence: scannerEvidence,
    scanner_evidence_json: scannerJson,
    gate_log: gateLog,
  };
}

export interface SpawnPlan {
  role: SpawnRole;
  profile: AttendedProfile;
  name: string;
  slug: string;
  model: string | null;
  report_path: string;
  verdict_template: string | null;
  worktree: string;
  fence_roots: string[];
  approved_remote_destinations: ApprovedRemoteDestination[];
  record_path: string | null;
  prompt_skeleton: string;
  /** W-353: the policy-mandatory scanner commands this seat is authorized to run
   * verbatim (gate seats only). Printed so the gate runs what the machine
   * declared instead of retyping `[guardian_tools]` prose that the guard may not
   * accept. */
  quality_gate_commands?: string[];
  /** W-353: configured-vs-authorized mismatches worth the PM's attention. */
  scanner_config_drift?: string[];
  /** W-353: the cwd-reset-resistant form of each declared command. The harness
   * resets a seat's shell cwd between calls, and a declared scanner is bound to
   * the reviewed worktree — so a BARE invocation fails closed after a reset.
   * Prefixing the `cd` rebases the segment and is what the seat should actually
   * run. Printed because the guard cannot infer intent from a reset cwd. */
  quality_gate_commands_cwd_safe?: string[];
  role_binding?: RoleBindingReference;
  warnings?: string[];
  acknowledge_launch?: {
    project: string;
    pm_id: string;
    dispatch_id: string;
    generation: number;
    binding_digest: string;
    transport: "attended-agent";
  };
}

export interface PromptOrientation {
  project?: string;
  pmId?: string;
  branch?: string | null;
  worktree: string;
  reportPath: string;
  verdictTemplate: string | null;
  blueprintPath?: string | null;
  lens?: ResolvedRoleLensBinding;
  promptBody?: string | null;
}

/** The prompt骨格: an ORIENTATION line (repo root / pm_id / branch / worktree — the
 * mechanical per-dispatch context, O2) + the garelier skill invocation + the
 * read-only / commit contract + the report path + the W-146 delivery rule. A PM
 * tail is accepted only through --prompt-file after W-451 validation. */
export function buildPromptSkeleton(role: SpawnRole, slug: string, o: PromptOrientation): string {
  const orient = [
    o.project ? `repo=${o.project}` : "",
    o.pmId ? `pm_id=${o.pmId}` : "",
    o.branch ? `branch=${o.branch}` : "",
    `worktree=${o.worktree}`,
  ].filter(Boolean).join(" | ");
  const lines = [
    `Use the ${ROLE_SKILL_DIR[role]} skill for this ${role} seat (dispatch ${slug}).`,
    `- Orientation: ${orient}`,
    ...renderRoleSourcePointerSection({
      blueprintPath: o.blueprintPath,
      lens: o.lens ?? { ref: null, source: "none", registry_path: null, pack_path: null },
    }).trimEnd().split("\n"),
    isGateRole(role)
      ? `- Repository/worktree is read-only: no edits or commits. The designated verdict output ${o.reportPath} is the only write target.`
      : role === "concierge"
      ? `- Execute only the PM-approved external operation. Target/non-garelier pushes are permitted; never push garelier/*, force-push, or run blind git pull.`
      : `- Work ONLY inside your assigned worktree; commit with the row trailer; do not push.`,
    // W-187: the command_guard resolves this seat's permission record against the
    // CONTROL ROOT of the command's cwd. Running git/test/build from another repo's
    // cwd finds no record → baseline-destructive → every commit/test/build denied
    // (실측: a 45-minute diagnosis). Pin the cwd contract up front.
    `- cwd contract (W-187): run EVERY git / test / build command with your shell cwd INSIDE this worktree — start each with \`cd ${o.worktree}\` (or the repo it lives under). The guard resolves your permission record from the cwd's repo; a foreign cwd strands you at baseline-destructive and denies every commit/test/build. If a command MUST target another repo, use an absolute \`git -C <abs>\` / \`cd <abs>\` so the guard can find your record there.`,
  ];
  if (o.verdictTemplate) lines.push(`- Write the verdict using the template at ${o.verdictTemplate}.`);
  lines.push(
    `- Delivery (W-146): SEND the register AND every progress message via SendMessage to the PM — plain text alone is not a completion signal.`,
    `- Token budget (W-190): your register is a POINTER + DELTA. The FILE is canonical (${o.reportPath}${o.verdictTemplate ? " + the verdict file" : ""}); the message carries the verdict token + file:line evidence pointers, NEVER a restatement of the diff, the row text, or the checkpoints — reference a checkpoint by its NUMBER. Do NOT re-send a register you already sent: the PM's register_received marker (or a wake) confirms receipt; an unacknowledged register means WAIT for a wake, not a verbatim resend.`,
  );
  const promptBody = o.promptBody?.trim();
  if (promptBody) lines.push("", promptBody);
  else lines.push(`- Prompt body (W-451): do not append task-specific prose here. Put review criteria in the blueprint; pass dispatch-only content through dispatch_prepare.ts --prompt-file so the closed section contract is checked before spawn.`);
  return lines.join("\n");
}

export interface SpawnOptions {
  role: string;
  slug?: string;
  project?: string;
  pmId?: string;
  garelierRoot?: string;
  dispatchId?: string;
  worktree?: string;
  fenceRoots?: string[];
  approvedRemoteDestinations?: ApprovedRemoteDestination[];
  model?: string;
  effort?: string;
  provider?: "codex" | "claude-code";
  taskRef?: string;
  blueprint?: string;
  promptFile?: string;
}

/** The PM control root that holds runtime/<role>/results — the gate seat's verdict
 * fence. Derived from --project/--pm-id, else the `__garelier/<pm>` ancestor of the
 * worktree. */
function pmControlRoot(opts: SpawnOptions, worktree: string): string | null {
  const base = opts.garelierRoot ?? opts.project;
  if (base && opts.pmId) return resolve(base, "__garelier", opts.pmId);
  const parts = resolve(worktree).split(/[\\/]+/);
  const idx = parts.lastIndexOf("__garelier");
  if (idx >= 0 && parts[idx + 1]) return parts.slice(0, idx + 2).join("/");
  return null;
}

export function runAttendedSpawn(opts: SpawnOptions, cwd = process.cwd()): SpawnPlan {
  const profile = roleProfile(opts.role); // validates role
  const role = opts.role as SpawnRole;
  if (role !== "concierge" && (opts.approvedRemoteDestinations?.length ?? 0) > 0) {
    throw new Error("dispatch_prepare: --approved-remote is valid only with --role concierge");
  }
  let slug = opts.slug ?? "";
  let worktree = opts.worktree ?? "";
  let branch: string | null = null;
  let gateInfo: GateAgentInfo | null = null;
  let routing: DispatchContext["routing"] = { model: null, effort: null, source: null };
  let roleBinding: RoleBindingReference | null = null;
  let contextBlueprint: string | null = null;

  if (opts.dispatchId) {
    if (!opts.project) throw new Error("dispatch_prepare: --dispatch-id requires --project");
    if (!opts.pmId) throw new Error("dispatch_prepare: --dispatch-id requires --pm-id");
    const container = crewSubdir(opts.project, opts.pmId, `dispatch${opts.dispatchId}`);
    const ctx = readDispatchContext(container);
    if (!ctx) throw new Error(`dispatch_prepare: no readable context.json under dispatch ${opts.dispatchId} (${join(container, "context.json")})`);
    if (!slug) slug = ctx.slug ?? "";
    if (!worktree) worktree = ctx.worktree ?? join(container, "checkout");
    branch = ctx.branch;
    routing = ctx.routing;
    roleBinding = ctx.role_binding;
    contextBlueprint = ctx.blueprint_path;
    // Gate seats adopt the dispatch's DECLARED gate_agents entry verbatim — the
    // single fix for hand-made names (user 指摘 2026-07-19). Issuance itself is
    // also the real Dock handoff choke point: no Guardian/Observer seat exists
    // until review_prepare's SHA-bound artifacts satisfy the postcondition.
    if (isGateRole(role)) {
      const handoff = inspectDockReviewHandoff({
        project: opts.project,
        pmId: opts.pmId,
        dispatchId: opts.dispatchId,
      });
      if (!handoff.ready) {
        throw new Error(
          `dispatch_prepare: Dock review handoff postcondition failed for dispatch ${opts.dispatchId}: ${handoff.reason}; `
          + "run review_prepare.ts before issuing a Guardian/Observer seat",
        );
      }
      if (ctx.gate_agents) gateInfo = ctx.gate_agents[role];
    }
  }
  if (!slug) throw new Error("dispatch_prepare: --slug is required (or --dispatch-id with a slug in its context.json)");
  if (!worktree) throw new Error("dispatch_prepare: --worktree is required (or --dispatch-id to derive the checkout)");

  const warnings: string[] = [];
  const projectRoot = opts.project ?? opts.garelierRoot ?? null;
  const blueprintInput = opts.blueprint ?? contextBlueprint;
  let blueprintPath: string | null = null;
  let blueprintMd: string | null = null;
  let promptBody: string | null = null;
  let lens: ResolvedRoleLensBinding = { ref: null, source: "none", registry_path: null, pack_path: null };
  if (!blueprintInput) {
    warnings.push("dispatch_prepare: WARNING — --blueprint was not specified; proceeding without a blueprint pointer");
  } else {
    const candidate = resolve(projectRoot ?? cwd, blueprintInput);
    if (!existsSync(candidate)) {
      warnings.push(`dispatch_prepare: WARNING — blueprint is not readable: ${candidate}; proceeding without a blueprint pointer`);
    } else {
      blueprintPath = candidate;
      blueprintMd = readFileSync(blueprintPath, "utf8");
    }
  }
  if (opts.promptFile) {
    const promptFile = resolve(projectRoot ?? cwd, opts.promptFile);
    if (!existsSync(promptFile)) {
      throw new Error(`dispatch_prepare: --prompt-file is not readable: ${promptFile}`);
    }
    promptBody = readFileSync(promptFile, "utf8");
    assertPromptSections({
      markdown: promptBody,
      surface: isGateRole(role) ? "gate_prompt_input" : "task_file",
      sourcePath: promptFile,
      blueprintPath,
    });
  }
  if (!projectRoot || !opts.pmId) {
    if (blueprintPath) {
      warnings.push("dispatch_prepare: WARNING — Lens pointer resolution requires --project/--garelier-root and --pm-id; proceeding with the blueprint pointer only");
    }
  } else {
    try {
      lens = resolveRoleLensBinding({
        projectRoot,
        pmId: opts.pmId,
        role,
        blueprintMd,
        setupConfigPath: join(crewSubdir(projectRoot, opts.pmId, "pm"), "setup_config.toml"),
      });
    } catch (error) {
      warnings.push(`dispatch_prepare: WARNING — Lens pointer resolution failed: ${(error as Error).message}; proceeding without a Lens pointer`);
    }
  }

  const name = gateInfo?.name ?? seatAgentName(role, slug);
  const reportPath = gateInfo?.report ?? seatReportPath(role, slug);
  const verdictTemplate = profile === "gate" ? (gateInfo?.verdict_template ?? GATE_VERDICT_TEMPLATE) : null;
  // O1: prefer the dispatch's already-resolved gate model; --model overrides.
  const model = optionalNonEmptyArg(opts.model)[0]
    ?? optionalNonEmptyArg(gateInfo?.model)[0]
    ?? optionalNonEmptyArg(routing.model)[0]
    ?? null;
  const resolvedWorktree = resolve(worktree);
  // A role permission record is not launch authority. The attended parent
  // must prove that it is launching the exact current generation before any
  // record is minted, then acknowledge the successful Agent-tool handle using
  // acknowledgeAttendedRoleLaunch below. Gate/read-only seats are outside
  // the role-binding protocol.
  if (role === "worker") {
    if (!opts.project || !opts.pmId || !opts.dispatchId || !roleBinding) {
      throw new Error("dispatch_prepare: worker launch requires a canonical dispatch role_binding");
    }
    if (roleBinding.identity.kind !== "dispatch" || roleBinding.identity.id !== opts.dispatchId) {
      throw new Error("dispatch_prepare: worker role_binding identity does not match --dispatch-id");
    }
    validateRoleLaunchPending({
      project_root: opts.project, pm_id: opts.pmId,
      identity: dispatchExecutionIdentity(opts.dispatchId),
      generation: roleBinding.generation, expected_digest: roleBinding.binding_digest,
    });
  }

  // Fence: a work seat writes in its checkout; a gate seat is read-only and only
  // writes its verdict + DEC-079 scan draft under the PM control root
  // (runtime/<role>/results).
  let fenceRoots = opts.fenceRoots?.length ? opts.fenceRoots : undefined;
  let qualityGateCommands: string[] | undefined;
  let scannerDrift: string[] | undefined;
  if (isGateRole(role)) {
    const pmRoot = pmControlRoot(opts, worktree);
    if (pmRoot) {
      // W-353: an EXPLICIT --fence-root used to REPLACE the pm root outright, so a
      // seat fenced to its (read-only by contract) checkout had nowhere a
      // `guardian_scan.ts --out <draft>` could legally land — the DEC-079 draft
      // path did not structurally exist, and the seat fell to profile_path_fence.
      // Union the results directory in instead of replacing, so the caller's fence
      // still holds AND the verdict/draft home always does. mkdir here because the
      // gate profile denies mkdir at the seat itself.
      const resultsRoot = join(pmRoot, "runtime", role, "results");
      mkdirSync(resultsRoot, { recursive: true });
      fenceRoots = fenceRoots ? [...fenceRoots, resultsRoot] : [pmRoot];
      // W-353: transcribe the policy-mandatory scanners into the record. Without
      // this the list is always empty and every mandatory command that matches no
      // preset is denied profile_unknown — policy demands a scan the seat cannot run.
      const declared = resolveGateSeatCommands(pmRoot);
      qualityGateCommands = declared.commands;
      scannerDrift = declared.drift;
    }
  }

  const promptSkeleton = buildPromptSkeleton(role, slug, {
    project: opts.project, pmId: opts.pmId, branch, worktree: resolvedWorktree, reportPath, verdictTemplate,
    blueprintPath, lens, promptBody,
  });
  if (isGateRole(role)) {
    const promptSource = opts.promptFile
      ? resolve(projectRoot ?? cwd, opts.promptFile)
      : `<generated attended ${role} prompt>`;
    assertPromptSections({
      markdown: promptSkeleton,
      surface: "gate_prompt",
      sourcePath: promptSource,
      blueprintPath,
    });
    assertSingleVerdictPath(promptSkeleton, role, reportPath, promptSource);
  }

  // F1: prompt text is not a safety mechanism. Install the unconditional
  // pre-push ref/fast-forward backstop BEFORE minting a Concierge record; any
  // install failure leaves no new record and fails the spawn closed.
  if (role === "concierge") installConciergeGuards(worktree);

  const { path: recordPath, record } = writeAttendedRecord(
    {
      agent: name, worktree, profile, role, fenceRoots,
      garelierRoot: opts.garelierRoot ?? opts.project, pmId: opts.pmId,
      laneKind: role === "concierge" ? undefined : "pm-direct",
      // O4: stamp dispatch_prepare's own records so the gate-name detective can exempt
      // a conformant ad-hoc (no --dispatch-id) gate seat instead of false-flagging it.
      spawnedVia: "dispatch_prepare",
      approvedRemoteDestinations: opts.approvedRemoteDestinations,
      qualityGateCommands,
    },
    cwd,
  );
  const resolvedFence = ((record.guard as Record<string, unknown>)?.fence_roots as string[]) ?? [];
  const approvedRemoteDestinations =
    ((record.guard as Record<string, unknown>)?.approved_remote_destinations as ApprovedRemoteDestination[] | undefined) ?? [];

  return {
    role, profile, name, slug, model,
    report_path: reportPath, verdict_template: verdictTemplate,
    worktree: resolvedWorktree, fence_roots: resolvedFence,
    approved_remote_destinations: approvedRemoteDestinations,
    record_path: recordPath,
    prompt_skeleton: promptSkeleton,
    ...(warnings.length ? { warnings } : {}),
    ...(qualityGateCommands?.length ? { quality_gate_commands: qualityGateCommands } : {}),
    ...(qualityGateCommands?.length
      ? {
        // The path is QUOTED. isPlainChangeDirectory (command_guard.ts) rejects an
        // unquoted operand containing whitespace as ambiguous, so an unquoted form
        // made the printed "cwd-safe" command deny ITSELF on any path with a space
        // — and a spaced path (`C:\Program Files\…`, `…\My Project\…`) is exactly
        // when the operator most needs the printed form. Fail-closed, so never
        // unsafe, but it did not work, which is what AC(a) asks for.
        quality_gate_commands_cwd_safe: qualityGateCommands.map(
          (c) => `cd "${resolvedWorktree}" && ${c}`,
        ),
      }
      : {}),
    ...(scannerDrift?.length ? { scanner_config_drift: scannerDrift } : {}),
    ...(roleBinding && opts.project && opts.pmId && opts.dispatchId ? {
      role_binding: roleBinding,
      acknowledge_launch: {
        project: opts.project, pm_id: opts.pmId, dispatch_id: opts.dispatchId,
        generation: roleBinding.generation, binding_digest: roleBinding.binding_digest,
        transport: "attended-agent" as const,
      },
    } : {}),
  };
}

/** Called by the attended parent only after collaboration.spawn_agent returns a
 * real handle. Merely printing a plan never acknowledges launch. */
export function acknowledgeAttendedRoleLaunch(input: {
  project: string; pmId: string; dispatchId: string; generation: number;
  bindingDigest: string; agentHandle: string; parentId: string;
}): void {
  acknowledgeRoleLaunch({
    project_root: input.project, pm_id: input.pmId,
    identity: dispatchExecutionIdentity(input.dispatchId), generation: input.generation,
    expect_digest: input.bindingDigest, transport: "attended-agent",
    provider_session_id: input.agentHandle,
    success_evidence: `collaboration.spawn_agent:${input.agentHandle}`,
    writer: { role: "attended-parent", id: input.parentId },
  });
}

// --- --ack-launch CLI (W-394) ------------------------------------------------
//
// acknowledgeAttendedRoleLaunch above was library-export-only: the attended
// parent (an Agent-tool spawn, with no shell of its own to run a bun script
// against a library function) had no CLI entry to call it from, so a real
// target-project dispatch hit merge_request admission refuse x2 and the PM
// worked around it with a hand-written bun one-off. This wraps the SAME function in a
// CLI, and resolves generation/binding_digest itself from the dispatch
// container's own context.json role_binding (dispatch_prepare already
// stamps it there — see readDispatchContext above) instead of asking the
// caller to hand-carry them. The launch already passed live-source admission in
// runAttendedSpawn; the later ack records that historical launch against its
// immutable generation/digest and does not re-read a blueprint that a later
// gate round may legitimately have revised (W-581).

export interface AckLaunchOptions {
  project: string; pmId: string; dispatchId: string; agentHandle: string; parentId: string;
}
export interface AckLaunchResult {
  binding_id: string; generation: number; binding_digest: string;
  provider_session_id: string; launched_at: string;
}

/** Resolves the dispatch's canonical role_binding from its context.json (the
 * same field runAttendedSpawn's --dispatch-id path already reads) and
 * acknowledges the launch through the unchanged library function. Never mints
 * or accepts a hand-carried generation/digest — only the dispatch's own
 * current context can supply them. */
export function runAckLaunch(opts: AckLaunchOptions): AckLaunchResult {
  const container = crewSubdir(opts.project, opts.pmId, `dispatch${opts.dispatchId}`);
  const ctx = readDispatchContext(container);
  if (!ctx) throw new Error(`dispatch_prepare: no readable context.json under dispatch ${opts.dispatchId} (${join(container, "context.json")})`);
  const binding = ctx.role_binding ?? ctx.role_seat_binding;
  if (!binding) {
    throw new Error(`dispatch_prepare: dispatch ${opts.dispatchId} context.json carries no role or role-seat binding`);
  }
  if ((binding.identity.kind !== "dispatch" && binding.identity.kind !== "role-seat") || binding.identity.id !== opts.dispatchId) {
    throw new Error("dispatch_prepare: dispatch context role_binding identity does not match --dispatch-id");
  }
  try {
    acknowledgeRoleLaunch({
      project_root: opts.project, pm_id: opts.pmId, identity: binding.identity,
      generation: binding.generation, expect_digest: binding.binding_digest,
      transport: "attended-agent", provider_session_id: opts.agentHandle,
      success_evidence: `collaboration.spawn_agent:${opts.agentHandle}`,
      writer: { role: "attended-parent", id: opts.parentId },
    });
  } catch (error) {
    if (error instanceof RoleLaunchReplayError) {
      throw new Error([
        `dispatch_prepare: launch acknowledgement refused: ${error.message}`,
        "next action: resume only the provider_session_id already recorded in the current generation's launch.json; do not rerun launch_cmd or ack_cmd",
        "if this invocation returned a different provider handle, stop that duplicate session and investigate before reporting or merge admission",
      ].join("; "));
    }
    throw new Error([
      `dispatch_prepare: launch acknowledgement refused: ${(error as Error).message}`,
      "next action: run the current generation's launch_cmd and then its ack_cmd",
      "if no runnable current generation exists, run dispatch_prepare --recover-role; each --recovery-wip declares one file for preservation, and omission declares an empty WIP inventory",
      "provider_session resume, direct binding-library calls, and merge-admission bypass do not replace launch authority",
    ].join("; "));
  }
  return {
    binding_id: binding.binding_id, generation: binding.generation, binding_digest: binding.binding_digest,
    provider_session_id: opts.agentHandle, launched_at: new Date().toISOString(),
  };
}

// --- W-168 (c) detective: hand-made gate seat names ------------------------

/** A gate-seat attended record whose name looks like a gate seat (`ga-guardian-*`
 * / `ga-observer-*`) but is NOT among the DECLARED dispatch gate_agents names AND
 * was NOT written by dispatch_prepare is a HAND-MADE name — the drift this tool
 * removes (user 指摘: "サブの名称が ga-role でなくなっている"). O4: a record stamped
 * `spawned_via: "dispatch_prepare"` is conformant by construction (dispatch_prepare
 * always uses seatAgentName), so an ad-hoc gate seat created WITHOUT --dispatch-id
 * is exempt and does not false-flag pmAction NEEDED. Pure: the caller supplies the
 * canonical set (from each dispatch's context.json gate_agents) and the records. */
export function mismatchedGateRecords(
  canonicalGateNames: Set<string>,
  records: Array<{ name: string; profile?: string; spawnedVia?: string }>,
): string[] {
  return records
    .filter((r) => (r.profile === undefined || r.profile === "gate")
      && r.spawnedVia !== "dispatch_prepare"
      && /^ga-(?:guardian|observer)-\S+/.test(r.name)
      && !canonicalGateNames.has(r.name))
    .map((r) => r.name);
}
