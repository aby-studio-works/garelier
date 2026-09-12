#!/usr/bin/env bun

// One operator-owned proxy unit: validate the producer COMMIT PLAN against the
// exact dirty set, commit with the authoritative plan message, and bind the
// session-authoritative result. Success is terminal; genuine REWORK resumes are
// explicit PM operations through provider_session.ts.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crewSubdir } from "../workspace.ts";
import {
  PROVIDER_TRANSPORTS,
  isProviderTransport,
  roleBindingFromContext,
  readCurrentRoleAuthorization,
  dispatchExecutionIdentity,
  validateRoleBinding,
  type ProviderTransport,
  type RoleAuthorization,
} from "../dispatch/role_binding.ts";
import { assertSafeLeaf, canonicalPath, reparseEntryOnPath } from "../guard/path_guard.ts";
import { readProviderSessionHandoff } from "./provider_session.ts";
import { git, requireRuntimeExecutable, valueAfter } from "./_lib.ts";

interface DockProxyArgs {
  project: string;
  pmId: string;
  dispatchId: string;
  result: string;
  dryRun: boolean;
}

export interface DockProxyResult {
  dispatch_id: number;
  sha: string;
  unit: number;
  result_file: string;
  status: "dry-run" | "committed";
  dry_run: boolean;
}

export interface DockProxyDeps {
  proxyCommit: (argv: string[]) => { exitCode: number; stdout: string; stderr: string };
}

export interface DockProxyReadyPaths {
  lane: string;
  shape: DockProxyLaneShape;
  /** null when the lane structurally has no provider session record. */
  sessionPath: string | null;
  initialResultPath: string;
  followupPath: string;
  followupResultPath: string;
  /** The harness-safe alternate register leaf for a lane whose register is a
   * container-root `report.md`, or null for a lane that already registers into
   * `lane/`. See `alternateRegisterLeafFor` (W-780). */
  alternateRegisterPath: string | null;
  /** The instant the lane's CURRENT generation was authorized, in epoch ms, or
   * null when the lane has no generation older than the current one to confuse
   * it with. `dockProxyRegisterCandidates` is the only reader (W-782 AC-2). */
  generationCutoffMs: number | null;
  recoverySession?: Record<string, any>;
}

function parseArgs(argv: string[]): DockProxyArgs {
  const args: DockProxyArgs = { project: "", pmId: "", dispatchId: "", result: "", dryRun: false };
  for (let index = 0; index < argv.length;) {
    switch (argv[index]) {
      case "--project": args.project = valueAfter(argv, index); index += 2; break;
      case "--pm-id": args.pmId = valueAfter(argv, index); index += 2; break;
      case "--dispatch-id": case "--id": args.dispatchId = valueAfter(argv, index); index += 2; break;
      case "--result": args.result = valueAfter(argv, index); index += 2; break;
      case "--dry-run": args.dryRun = true; index += 1; break;
      default: throw new Error(`dock_proxy: unknown arg: ${argv[index]}`);
    }
  }
  if (!args.project || !args.pmId || !/^\d+$/.test(args.dispatchId)) {
    throw new Error("dock_proxy: --project, --pm-id, and numeric --dispatch-id are required");
  }
  return args;
}

export function readDockProxyJson<T>(path: string, label: string, readText = (safe: string) => readFileSync(safe, "utf8")): T {
  if (reparseEntryOnPath(path)) throw new Error(`dock_proxy: ${label} traverses a symlink or reparse point`);
  const safe = assertSafeLeaf(path, `dock_proxy: ${label}`);
  if (!existsSync(safe)) throw new Error(`dock_proxy: ${label} not found: ${safe}`);
  try {
    const value = JSON.parse(readText(safe));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected JSON object");
    return value as T;
  }
  catch { throw new Error(`dock_proxy: ${label} is not valid JSON: ${path}`); }
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * The ONE admission check an admitted lane leaf gets, whatever named it
 * (W-782 AC-1 / W-780 Guardian G1).
 *
 * Three properties, and every admitted leaf carries all three: no `..` segment,
 * no symlink / junction / reparse point ANYWHERE on the path including the leaf
 * itself, and a canonical form that is the exact lane-owned destination. Before
 * W-782 the container-derived `alternateRegisterPath` was joined straight onto
 * the container root and returned, so it was the one admitted leaf with none of
 * them — "admitted leaf" meant two different things depending on which leaf you
 * held, and `resolveDockProxyReadyRegisterPath` would follow a reparse point
 * planted at `<container>/lane/register.md` and return it as the register.
 *
 * `malformed` covers both the reparse check and a non-string ready.json value,
 * because a caller cannot act differently on the two: either way the value does
 * not name the place it claims to.
 */
function admitLaneLeaf(raw: string, expected: string, canonicalRoot: string, label: string, malformed: boolean): string {
  if (raw.split(/[\\/]+/).includes("..")) {
    throw new Error(`dock_proxy: ${label} must not contain '..' path segments`);
  }
  const actual = canonicalPath(raw);
  if (malformed || reparseEntryOnPath(raw)) {
    throw new Error(`dock_proxy: ${label} must not contain a malformed path or symlink/reparse point`);
  }
  const canonicalExpected = resolve(canonicalRoot, basename(resolve(expected)));
  if (!sameCanonicalPath(actual, canonicalExpected)) {
    throw new Error(`dock_proxy: ${label} does not match the canonical lane path: ${actual}`);
  }
  return canonicalExpected;
}

function canonicalReadyPath(
  ready: Record<string, any>,
  key: string,
  expected: string,
  canonicalLane: string,
): string {
  const raw = ready[key] === undefined || ready[key] === null || ready[key] === ""
    ? expected
    : String(ready[key]);
  // ready.json adds only the producer-controlled indirection on top of the
  // shared check; `typeof null === "object"` is deliberate — an explicit null
  // is a malformed pointer, not an absent one.
  return admitLaneLeaf(raw, expected, canonicalLane, `ready.json ${key}`, typeof ready[key] === "object");
}

/**
 * The ONE place a Dock-side reader learns which provider shape a lane has.
 *
 * `dispatch_prepare.ts` writes `provider_transport` into ready.json for every
 * lane it prepares and is the only writer of that key, so it is present on a
 * lane of any transport — including the already-dispatched ones a fix has to
 * recover (W-641). The former source (`context.routing.provider`) is written
 * into the role AUTHORIZATION, never into context.json's `routing`, so every
 * reader silently fell back to `"codex-cli"` and refused claude lanes at
 * admission. There is no default here: a missing or unknown transport is a
 * refusal, not a guess.
 *
 * ready.json sits inside the producer's container fence, but naming a
 * transport cannot redirect anything: both leaves this selects between are
 * derived from the container layout and are already producer-authored, so the
 * worst a rewritten transport can do is make admission refuse.
 */
export function resolveDockProxyProviderTransport(ready: Record<string, any>): ProviderTransport {
  const declared = ready.provider_transport;
  if (!isProviderTransport(declared)) {
    throw new Error(
      `dock_proxy: ready.json provider_transport must be one of ${PROVIDER_TRANSPORTS.join(", ")} (got ${JSON.stringify(declared ?? null)})`,
    );
  }
  return declared;
}

/** Claude lanes (attended-agent / claude-subprocess) put the register at
 * `<container>/report.md`; codex puts it at `<container>/lane/result.md`. This
 * mirrors dispatch_prepare's own `providerResult` branch and is the ONLY place
 * the split is written down. */
function registersInContainerRoot(transport: ProviderTransport): boolean {
  return transport === "claude-subprocess" || transport === "attended-agent";
}

/**
 * The ONE admission decision for a lane: `recovered` × `transport` (W-687 AC-5).
 *
 * A provider session record is written by a provider SUBPROCESS. The
 * attended-agent transport has no subprocess — `provider_session.ts` never runs
 * for it, and `--ack-launch` writes the current generation's `launch.json`
 * instead — so requiring `lane/recovery.session.json` from a recovered attended
 * lane demanded an artifact with no writer. That is exactly what stopped
 * `review_prepare.ts` on `_workshop` #520 with `ENOENT … lane/recovery.session.json`
 * after the lane had already registered.
 *
 * Every reader (review_prepare / land_pipeline / fleet_watch / dock_proxy's own
 * commit unit / land_aftercare) asks THIS function rather than re-deriving the
 * split, so a second reader cannot decide differently — the pre-W-641 shape of
 * that same bug is what made every claude lane look like it had no register.
 *
 * It never loosens the subprocess transports: codex-cli and claude-subprocess
 * keep requiring their session record, recovered or not.
 */
export interface DockProxyLaneShape {
  transport: ProviderTransport;
  recovered: boolean;
  /** A provider subprocess writes `lane/session.json` (or, after a recovery,
   * `lane/recovery.session.json`) for this lane. False for attended-agent,
   * where the current generation's launch acknowledgement is the authority. */
  providerSessionRecord: boolean;
  /** The lane's CAPTURED register leaf is `<container>/report.md` rather than a
   * `lane/` leaf. A recovered subprocess lane registers into
   * `lane/recovery.result.md`; a recovered ATTENDED lane registers where every
   * other attended lane does, because the same agent writes it the same way.
   *
   * True here also means the PRODUCER's own leaf is `lane/register.md`
   * (`dockProxyProducerRegisterLeaf`): where the capture lands in the container
   * root, that file is the driver's and the producer authors the lane leaf
   * instead (W-735). Where this is false, the captured leaf IS the producer's. */
  registerInContainerRoot: boolean;
}

export function dockProxyLaneShape(transport: ProviderTransport, recovered: boolean): DockProxyLaneShape {
  const attended = transport === "attended-agent";
  return {
    transport,
    recovered,
    providerSessionRecord: !attended,
    registerInContainerRoot: registersInContainerRoot(transport) && (attended || !recovered),
  };
}

/** The lane leaves `dispatch_prepare --recover-role` publishes for a transport,
 * and therefore the exact leaves admission expects back from `ready.json`. One
 * derivation for the writer and the reader: two spellings of "where a recovery
 * registers" is what made `ready.json` and the aftercare disagree (AC-3/AC-4). */
export function dockProxyRecoveryLeaves(container: string, transport: ProviderTransport): {
  resultPath: string;
  sessionRecordPath: string | null;
} {
  const shape = dockProxyLaneShape(transport, true);
  const resolved = resolve(container);
  return {
    resultPath: registerLeafFor(resolved, shape),
    sessionRecordPath: shape.providerSessionRecord ? join(resolved, "lane", "recovery.session.json") : null,
  };
}

function registerLeafFor(resolvedContainer: string, shape: DockProxyLaneShape): string {
  if (shape.registerInContainerRoot) return join(resolvedContainer, "report.md");
  return shape.recovered
    ? join(resolvedContainer, "lane", "recovery.result.md")
    : join(resolvedContainer, "lane", "result.md");
}

/**
 * The leaf the PRODUCER of a container-root lane writes (W-780 / W-735).
 *
 * The harness that runs an attended lane refuses, by name, to let the agent
 * write a file called `report.md` — measured verbatim twice on aby_works #716:
 * "Subagents should return findings as text, not write report files. Include
 * this content in your final response instead." The lane had already done the
 * work; the only thing missing was a filename it was allowed to type.
 *
 * W-735 (PM 裁定 2026-09-11) makes that the ONE path such a producer writes,
 * rather than a second spelling to fall back to. `<container>/report.md` on
 * these lanes is the LAUNCHER's capture of the final response and is written by
 * the driver (the scaffold, the capture, and `land_pipeline`'s transcription) —
 * a producer that also writes it is writing the driver's file, which is how
 * "keep two files byte-identical" became a rule that could only be broken.
 * Nothing is loosened by naming it: like every other leaf here it is DERIVED
 * from the container layout, never read out of producer-controlled `ready.json`.
 *
 * It is null for a lane whose register leaf is ALREADY in `lane/` (codex-cli,
 * and a recovered claude-subprocess lane): there the captured leaf and the
 * producer leaf are the same file, so a second spelling would only add
 * ambiguity.
 */
export function dockProxyProducerRegisterLeaf(container: string, transport: ProviderTransport, recovered = false): string {
  const resolved = resolve(container);
  const shape = dockProxyLaneShape(transport, recovered);
  return alternateRegisterLeafFor(resolved, shape) ?? registerLeafFor(resolved, shape);
}

/** The same answer as a container-RELATIVE leaf name, for the one caller that
 * must not re-spell the container: the role prompt prints the container path it
 * was given, and `resolve()` would rewrite a bare `/container` fixture into
 * `C:/container` on Windows. Both functions read the same rule, so the file the
 * producer is TOLD to write and the file admission LOOKS for cannot diverge. */
export function dockProxyProducerRegisterLeafName(transport: ProviderTransport, recovered = false): string {
  return relative(resolve("/c"), dockProxyProducerRegisterLeaf("/c", transport, recovered)).replace(/\\/g, "/");
}

function alternateRegisterLeafFor(resolvedContainer: string, shape: DockProxyLaneShape): string | null {
  return shape.registerInContainerRoot ? join(resolvedContainer, "lane", "register.md") : null;
}

/**
 * The container-derived register leaf for a lane, for readers that only need to
 * know WHERE the register is rather than to admit a full handoff (pm.ts's
 * status readout). Sharing this derivation is the point of W-641: a second,
 * codex-shaped guess of `lane/result.md` is what made every claude lane look
 * like it had never produced a result.
 *
 * ready.json's own `result_file` still wins when it is set; this answers the
 * case where dispatch_prepare left it empty (a lane prepared with no task body).
 */
export function dockProxyRegisterLeaf(container: string, ready: Record<string, any>): string {
  return registerLeafFor(resolve(container), dockProxyLaneShape(resolveDockProxyProviderTransport(ready), false));
}

/** Admit every producer-controlled ready.json path before a Dock-owned reader,
 * commit, or binder receives it. fleet_watch shares this boundary so
 * discovery cannot read a path that dock_proxy would later refuse. The
 * provider shape is derived from `ready` here rather than passed in, so the
 * three call sites cannot disagree about it. */
export function admitDockProxyReadyPaths(
  project: string,
  container: string,
  ready: Record<string, any>,
): DockProxyReadyPaths {
  const transport = resolveDockProxyProviderTransport(ready);
  const resolvedProject = resolve(project);
  const resolvedContainer = resolve(container);
  const lane = resolve(resolvedContainer, "lane");
  const containerRelative = relative(resolvedProject, resolvedContainer);
  if (!containerRelative || isAbsolute(containerRelative)
    || containerRelative.split(/[\\/]+/).includes("..")) {
    throw new Error("dock_proxy: dispatch container must be contained by the project root");
  }
  const canonicalProject = canonicalPath(resolvedProject);
  const expectedContainer = resolve(canonicalProject, containerRelative);
  const canonicalContainer = canonicalPath(resolvedContainer);
  const expectedLane = resolve(expectedContainer, "lane");
  const canonicalLane = canonicalPath(lane);
  if (!sameCanonicalPath(canonicalContainer, expectedContainer)
    || !sameCanonicalPath(canonicalLane, expectedLane)
    || reparseEntryOnPath(resolvedContainer) || reparseEntryOnPath(lane)) {
    throw new Error("dock_proxy: dispatch container/lane must not traverse a symlink or reparse point");
  }
  // Recovery is an immutable current authorization, never a filename guess.
  // Both published views must name that current authorization; historical
  // predecessor authority cannot substitute for the recovery publication.
  const contextPath = join(canonicalContainer, "context.json");
  if (reparseEntryOnPath(contextPath) || reparseEntryOnPath(join(canonicalContainer, "ready.json"))) {
    throw new Error("dock_proxy: context/ready must not traverse a symlink or reparse point");
  }
  const context = existsSync(contextPath) ? readDockProxyJson<Record<string, any>>(contextPath, "context.json") : {};
  const binding = roleBindingFromContext(context);
  let recovered = false;
  let recoverySession: Record<string, any> | undefined;
  const layout = containerRelative.replaceAll("\\", "/").match(/^__garelier\/([^/]+)\/_crew\/dispatch(\d+)$/);
  if (binding && !layout) throw new Error("dock_proxy: invalid canonical dispatch context/ready layout");
  const authorityOptions = layout
    ? { project_root: canonicalProject, pm_id: layout[1]!, identity: dispatchExecutionIdentity(layout[2]!) }
    : undefined;
  let authorization: ReturnType<typeof readCurrentRoleAuthorization> | undefined;
  if (authorityOptions) {
    try { authorization = readCurrentRoleAuthorization(authorityOptions); }
    catch (error) {
      // Reuse dispatch_prepare's canonical absence contract. Corrupt authority
      // cannot downgrade a numbered producer to a bindingless attended lane.
      if (binding || !(error as Error).message.startsWith("no current role binding exists")) throw error;
    }
  }
  if (authorization && authorityOptions && layout) {
    if (!binding) throw new Error("dock_proxy: current role authorization requires context role binding");
    recovered = authorization.core.carabiner === "role_recovery";
    if (binding.schema_version !== 1 || binding.binding_id !== authorization.binding_id
      || binding.identity?.kind !== "dispatch" || String(binding.identity.id) !== layout[2]) {
      throw new Error("dock_proxy: context role identity is mismatched");
    }
    if (binding.binding_id !== authorization.binding_id || binding.generation !== authorization.core.generation
      || binding.binding_digest !== authorization.core_digest) throw new Error("dock_proxy: context role binding is stale or mismatched");
    if (recovered) {
      if ((ready.role_binding?.binding_id !== undefined && ready.role_binding.binding_id !== binding.binding_id)
        || (ready.role_binding?.identity !== undefined
          && (ready.role_binding.identity.kind !== "dispatch" || String(ready.role_binding.identity.id) !== layout[2]))) {
        throw new Error("dock_proxy: recovery ready role identity is mismatched");
      }
      if (ready.role_binding?.generation !== binding.generation || ready.role_binding?.binding_digest !== binding.binding_digest) {
        throw new Error("dock_proxy: recovery ready role binding is stale or mismatched");
      }
      // Worktree/branch identity is a property of the recovered CONTAINER, not
      // of the transport: both routes below admit the same lane, so both check it.
      const candidateBranch = git(join(canonicalContainer, "checkout"), ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (candidateBranch.exitCode !== 0 || candidateBranch.stdout.trim() !== context.task?.branch
        || (context.guard?.worktree !== undefined
          && (!sameCanonicalPath(canonicalPath(context.guard.worktree), join(canonicalContainer, "checkout"))
            || reparseEntryOnPath(context.guard.worktree)))) {
        throw new Error("dock_proxy: recovered context worktree/branch identity mismatch");
      }
      if (dockProxyLaneShape(transport, true).providerSessionRecord) {
        const sessionPath = canonicalReadyPath(ready, "session_record", join(lane, "recovery.session.json"), canonicalLane);
        assertSafeLeaf(sessionPath, "dock_proxy: recovery session");
        recoverySession = readProviderSessionHandoff(sessionPath, join(canonicalContainer, "checkout"), authorization.core.routing);
        if (recoverySession.status !== "ready") throw new Error("dock_proxy: recovered provider session is not ready");
        if (recoverySession.ownership_id !== `launch-${binding.binding_digest}`
          || recoverySession.provider !== (transport === "codex-cli" ? "codex-cli" : "claude-code")) {
          throw new Error("dock_proxy: recovered provider session ownership/transport mismatch");
        }
        validateRoleBinding({ ...authorityOptions, stage: "resume", generation: binding.generation,
          expected_digest: binding.binding_digest, expected_transport: transport, provider_session_id: recoverySession.session_id });
      } else {
        // attended-agent: the launch acknowledgement IS the resume authority.
        // `validateRoleBinding` reads the CURRENT generation's `launch.json` and
        // refuses by name when it is absent ("role launch acknowledgement is
        // missing"), when the generation/digest it records is superseded, or
        // when its transport is not the one this lane declares — so admitting
        // without a session record does not admit without authority.
        validateRoleBinding({ ...authorityOptions, stage: "resume", generation: binding.generation,
          expected_digest: binding.binding_digest, expected_transport: transport });
      }
    }
  }
  const shape = dockProxyLaneShape(transport, recovered);
  const alternateRegister = alternateRegisterLeafFor(canonicalContainer, shape);
  const registerRoot = shape.registerInContainerRoot ? canonicalContainer : canonicalLane;
  const initialResult = registerLeafFor(resolvedContainer, shape);
  const followupResult = shape.registerInContainerRoot ? initialResult : join(lane, "followup.result.md");
  // Recovery's published resume command initially reuses recovery.result.md.
  // A later explicit follow-up captures the fixed followup leaf in that same session.
  const resumeResult = recovered && ready.resume_result_file === ready.result_file ? initialResult : followupResult;
  canonicalReadyPath(ready, "resume_result_file", resumeResult, registerRoot);
  const admittedFollowup = canonicalReadyPath({}, "resume_result_file", followupResult, registerRoot);
  return {
    lane: canonicalLane,
    shape,
    // A lane with no session-record writer has no session path to admit: a
    // pointer at an artifact nothing writes is not evidence, and no reader may
    // read one. `readDockProxyLaneSession` is where that absence is consumed.
    sessionPath: shape.providerSessionRecord
      ? canonicalReadyPath(ready, "session_record", join(lane, recovered ? "recovery.session.json" : "session.json"), canonicalLane)
      : null,
    initialResultPath: canonicalReadyPath(ready, "result_file", initialResult, registerRoot),
    followupPath: canonicalReadyPath(ready, "resume_instruction_file", join(lane, "followup.md"), canonicalLane),
    followupResultPath: admittedFollowup,
    // Container-derived, so it is admitted without ready.json naming it: the
    // producer reaches for this leaf only when the harness has just refused the
    // other one, which is precisely when it cannot publish a new pointer. It
    // goes through the SAME leaf admission as every other one (W-782 AC-1).
    alternateRegisterPath: alternateRegister
      && admitLaneLeaf(alternateRegister, alternateRegister, canonicalLane, "alternate register leaf", false),
    generationCutoffMs: dockProxyGenerationCutoffMs(authorization ?? null),
    ...(recoverySession ? { recoverySession } : {}),
  };
}

/**
 * The provider session record an admitted lane has, or null when it
 * structurally has none. The ONE place a reader asks that question, so
 * discovery, review preparation, and landing cannot answer it differently.
 */
export function readDockProxyLaneSession(
  admitted: DockProxyReadyPaths,
  readText?: (safe: string) => string,
): Record<string, any> | null {
  if (admitted.recoverySession) return admitted.recoverySession;
  if (!admitted.sessionPath || !existsSync(admitted.sessionPath)) return null;
  return readDockProxyJson<Record<string, any>>(admitted.sessionPath, "session.json", readText);
}

/**
 * Resolve the producer register on a lane that has NO provider session record.
 *
 * A session record is a provider-SUBPROCESS artifact. A `commit_mode: self`
 * lane (claude-code / pm-direct execution route) never produces one, so a
 * reader that requires it is codex-shaped and cannot serve those lanes at all.
 * The pointer then comes from ready.json instead — which is safe, and is NOT a
 * weakening: admitDockProxyReadyPaths RETURNS leaves derived from the container
 * layout (`resolve(canonicalLane, basename(expected))`) and merely requires
 * ready.json to agree with them, so a producer editing ready.json inside its
 * own container fence cannot redirect this to a path of its choosing — it can
 * only make admission refuse.
 *
 * Ordering mirrors what a session record would have said: after a resume the
 * canonical register is the followup leaf and the initial leaf is the earlier
 * round, so the followup wins whenever it exists.
 */
export function resolveDockProxyReadyRegisterPath(admitted: DockProxyReadyPaths): string {
  const candidates = dockProxyRegisterCandidates(admitted);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Name the leaf that was dropped as well as the ones that were searched: a
  // stale alternate is the one case where the lane HAS a register file and is
  // still refused, so an operator who is not told would read "no register" as
  // "nothing was written".
  const stale = admitted.alternateRegisterPath && !candidates.includes(admitted.alternateRegisterPath)
    ? ` (ignored ${admitted.alternateRegisterPath}: written before the current generation)`
    : "";
  throw new Error(`dock_proxy: no admitted producer register exists (${candidates.join("; ")})${stale}`);
}

/**
 * The admitted register leaves of a lane, in the order a reader must prefer
 * them — the ONE place the search order AND the generation rule live, read by
 * both routes into a lane (W-782 AC-2 / W-780 Guardian G2).
 *
 * ORDER. The producer leaf (`lane/register.md`) is consulted FIRST and the
 * captured `report.md` second — one order, and the same one W-735 writes into
 * every field manual: the producer authors `lane/register.md`, the launcher captures the
 * final response into `report.md`, and when both exist the authored one is the
 * register while the capture is a copy of the same final message.
 *
 * The mechanism under that preference is asymmetric existence rather than taste.
 * `report.md` is SCAFFOLDED by dispatch_prepare, so on an attended lane it
 * exists from the moment the lane is prepared and its presence proves nothing
 * about authorship — selecting it over an authored `lane/register.md` would bind
 * the placeholder. Nothing but the producer ever writes `lane/register.md`, so
 * its existence IS authorship.
 *
 * GENERATION. "Its existence is authorship" holds for ONE generation only.
 * `dispatch_prepare --recover-role` rewrites the lane's pointers and deletes no
 * lane leaf, so a `lane/register.md` authored in generation N survives into
 * generation N+1 — where, on existence alone, it would outrank the register the
 * recovered lane actually wrote. W-781 makes two-generation containers the
 * expected case rather than a rare one. So on a lane that HAS an earlier
 * generation, the alternate is preferred only when it was written at or after
 * the current generation's authorization; an alternate that does not exist yet
 * is not stale, and a lane still on generation 1 is unfiltered.
 */
export function dockProxyRegisterCandidates(admitted: DockProxyReadyPaths): string[] {
  const ordered = [
    alternateIsCurrentGeneration(admitted) ? admitted.alternateRegisterPath : null,
    admitted.followupResultPath,
    admitted.initialResultPath,
  ].filter((path): path is string => typeof path === "string" && path.length > 0);
  // A container-root lane's followup and initial leaves are the same file.
  return ordered.filter((path, index) =>
    ordered.findIndex((other) => sameCanonicalPath(path, other)) === index);
}

/**
 * The instant an alternate leaf must have been written at or after to count as
 * THIS generation's, or null when the lane has no earlier generation whose
 * leaves could be mistaken for it.
 *
 * A lane still on generation 1 is unfiltered: there is nothing older to confuse
 * it with, so its selection is byte-for-byte what it was before W-782.
 *
 * An `issued_at` this cannot parse is NOT "no cutoff". A null there disables the
 * ordering rule for the whole lane and silently restores pre-W-782 selection,
 * where a `lane/register.md` authored in generation 1 outranks the register the
 * recovered lane actually wrote (W-780 Guardian G2) — the one thing the cutoff
 * exists to prevent, and with no message saying the rule stopped applying. The
 * field is driver-written (`new Date().toISOString()`), so a value that is not a
 * date means the record is damaged; a damaged authorization is refused by name,
 * never interpreted (W-783 AC-2, from W-782 Guardian N-2).
 *
 * `issued_at` is a SIBLING of `core`, and `roleAuthorizationDigest` hashes the
 * core alone — so this one input to the ordering rule is not covered by the
 * record's own integrity check (W-782 Guardian N-1). Closing that moves every
 * existing record's digest, which needs a drained-fleet landing window, so it is
 * deliberately NOT done here and is carried by W-784 instead.
 */
export function dockProxyGenerationCutoffMs(authorization: RoleAuthorization | null): number | null {
  if (!authorization || authorization.core.generation <= 1) return null;
  const cutoff = Date.parse(authorization.issued_at);
  if (!Number.isFinite(cutoff)) {
    throw new Error(
      "dock_proxy: role authorization issued_at is not a parseable instant, so the generation "
      + `${authorization.core.generation} cutoff cannot be applied: ${JSON.stringify(authorization.issued_at)}`,
    );
  }
  return cutoff;
}

function alternateIsCurrentGeneration(admitted: DockProxyReadyPaths): boolean {
  if (admitted.alternateRegisterPath === null) return false;
  if (admitted.generationCutoffMs === null) return true;
  // Three answers, not two: at-or-after the cutoff, before it, and CANNOT TELL.
  // The third used to be folded into the first by `catch { return true; }`, so
  // any failure re-admitted the leaf — which on a leaf that does exist is the
  // stale generation-1 register the cutoff exists to drop, selected silently
  // (W-782 Observer N-2). Everything this cannot date is now refused BY NAME,
  // the same shape the stale-leaf refusal below already uses (W-783 AC-1).
  let entry;
  try { entry = lstatSync(admitted.alternateRegisterPath, { throwIfNoEntry: false }); }
  catch (error) {
    // A permission or IO error, or a path lstat rejects outright. Note that on
    // Windows the OS reports most path-SHAPE failures (a component that is not a
    // directory, an invalid name) as "no entry", so they arrive below as absent
    // rather than here; this branch is where a leaf that exists but cannot be
    // read lands.
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      "dock_proxy: alternate register leaf cannot be dated against the generation cutoff: "
      + `${admitted.alternateRegisterPath} (${code ?? (error as Error).message})`,
    );
  }
  // Absent is not stale, and `throwIfNoEntry: false` makes that the ONE case
  // answered without a stat — the API contract rather than an error class read
  // back out of a catch. A leaf the producer has not written yet is not a
  // leftover generation, and `resolveDockProxyReadyRegisterPath`'s existence
  // search drops it without naming it as ignored.
  if (!entry) return true;
  // An entry that is not a regular file has no register mtime to compare: it
  // dates a DIRECTORY, and the existence search downstream would then hand that
  // directory back as the register, while the session route already refuses the
  // same thing (`resolveDockProxySessionResultPath` requires `isFile`). One
  // rule, one spelling. Scoped to the cutoff deliberately — this asks whether
  // the leaf can be dated as THIS generation's register, not whether an
  // un-generationed lane's leaf is well formed.
  if (!entry.isFile()) {
    throw new Error(
      "dock_proxy: alternate register leaf is not a regular file, so it cannot be dated against "
      + `the generation cutoff: ${admitted.alternateRegisterPath}`,
    );
  }
  return entry.mtimeMs >= admitted.generationCutoffMs;
}

/** The one entry both provider shapes go through: the session record decides
 * when a lane has one, ready.json decides when it structurally cannot. Either
 * way the result is one of the admitted lane leaves. */
export function resolveDockProxyRegisterPath(
  admitted: DockProxyReadyPaths,
  session: Record<string, any> | null,
): string {
  return admitted.recoverySession ? resolveDockProxySessionResultPath(admitted.recoverySession, admitted)
    : session ? resolveDockProxySessionResultPath(session, admitted) : resolveDockProxyReadyRegisterPath(admitted);
}

/** Resolve the exact producer result selected by the canonical session and
 * require it to be one of the ready.json-admitted lane leaves. */
export function resolveDockProxySessionResultPath(
  session: Record<string, any>,
  admitted: DockProxyReadyPaths,
): string {
  const raw = String(session.result_file ?? "");
  if (!raw) throw new Error("dock_proxy: session result_file is required");
  const resultPath = canonicalPath(raw);
  if (typeof session.result_file !== "string" || raw.split(/[\\/]+/).includes("..") || reparseEntryOnPath(raw)) {
    throw new Error("dock_proxy: session result_file is malformed or traverses a symlink/reparse point");
  }
  // The admitted SET is exactly the one `resolveDockProxyReadyRegisterPath`
  // searches — the same call, not a second listing of the same three leaves —
  // otherwise "admitted leaf" would mean two different things on the two routes
  // into the same lane (W-780 / W-782).
  if (!dockProxyRegisterCandidates(admitted).some((candidate) => sameCanonicalPath(resultPath, candidate))) {
    throw new Error(`dock_proxy: session result_file is not an admitted canonical result path: ${resultPath}`);
  }
  if (!existsSync(resultPath) || !lstatSync(resultPath).isFile()) throw new Error("dock_proxy: session result_file is not a regular captured result");
  return resultPath;
}

function defaultDeps(): DockProxyDeps {
  const proxyScript = resolve(dirname(fileURLToPath(import.meta.url)), "dispatch_prepare_lane_commit_plan.ts");
  return {
    proxyCommit: (argv) => {
      const result = Bun.spawnSync([requireRuntimeExecutable("bun"), proxyScript, ...argv], {
        windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      return {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
      };
    },
  };
}

export function runDockProxy(args: DockProxyArgs, deps: DockProxyDeps = defaultDeps()): DockProxyResult {
  const project = resolve(args.project);
  const container = crewSubdir(project, args.pmId, `dispatch${args.dispatchId}`);
  const worktree = resolve(container, "checkout");
  const context = readDockProxyJson<Record<string, any>>(resolve(container, "context.json"), "context.json");
  const ready = readDockProxyJson<Record<string, any>>(resolve(container, "ready.json"), "ready.json");
  // ready.json is producer-visible handoff data. Resolve every path through the
  // shared symlink/reparse-aware canonicalizer and require the exact lane-owned
  // destination before any read, commit, or binder receives Dock authority.
  const admitted = admitDockProxyReadyPaths(project, container, ready);
  if (context.routing?.commit_mode !== "proxy" || ready.commit_mode !== "proxy") {
    throw new Error(`dock_proxy: dispatch #${args.dispatchId} is not canonical proxy mode`);
  }
  // Proxy commit is a provider-SUBPROCESS unit: it commits what a captured
  // session produced. A lane whose transport writes no session record has
  // nothing for this unit to read, and is refused by that name.
  let session = admitted.recoverySession;
  if (!session) {
    if (!admitted.sessionPath) {
      throw new Error(`dock_proxy: dispatch #${args.dispatchId} transport ${admitted.shape.transport} writes no provider session record`);
    }
    session = readDockProxyJson<Record<string, any>>(admitted.sessionPath, "session.json");
  }
  if (session.status !== "ready") throw new Error(`dock_proxy: provider session is not ready (status=${String(session.status)})`);
  const binding = roleBindingFromContext(context);
  if (!binding) throw new Error("dock_proxy: context has no canonical role binding");
  const sessionResultPath = resolveDockProxySessionResultPath(session, admitted);
  const resultPath = args.result
    ? (() => {
      const explicit = canonicalPath(args.result);
      if (reparseEntryOnPath(args.result)) throw new Error("dock_proxy: --result traverses a symlink or reparse point");
      if (!sameCanonicalPath(explicit, sessionResultPath)) {
        throw new Error(`dock_proxy: --result does not match the session-authoritative result path: ${explicit}`);
      }
      return explicit;
    })()
    : sessionResultPath;

  const commitArgs = [
    "--project", project, "--pm-id", args.pmId, "--id", args.dispatchId,
    "--result", resultPath, ...(args.dryRun ? ["--dry-run"] : []),
  ];
  const committed = deps.proxyCommit(commitArgs);
  if (committed.exitCode !== 0) {
    throw new Error(`dock_proxy: proxy commit refused (exit=${committed.exitCode}): ${(committed.stderr || committed.stdout).trim()}`);
  }
  if (args.dryRun) {
    return {
      dispatch_id: Number(args.dispatchId), sha: "(dry-run)", unit: 0,
      result_file: resultPath, status: "dry-run", dry_run: true,
    };
  }

  const sha = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("dock_proxy: committed HEAD is not a full SHA");
  const base = String(context.task?.base_sha ?? ready.base_sha ?? "");
  const unitText = git(worktree, ["rev-list", "--count", `${base}..${sha}`]).stdout.trim();
  const unit = Number(unitText);
  if (!Number.isSafeInteger(unit) || unit < 1) throw new Error(`dock_proxy: invalid committed unit count: ${unitText}`);
  return {
    dispatch_id: Number(args.dispatchId), sha, unit, result_file: resultPath,
    status: "committed", dry_run: false,
  };
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const result = runDockProxy(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(main());
