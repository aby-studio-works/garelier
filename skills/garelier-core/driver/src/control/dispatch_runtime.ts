import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { assertNoSymlinkPath } from "./diagnostics.ts";
import { canonicalJson, sha256 } from "./serialization.ts";
import { readDispatchSessionResult, resolveDispatchLaneState } from "../dispatch/lane_status.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";

export interface RuntimeDispatchTouches {
  id: string;
  state: string;
  touches: string[];
  work_id: string | null;
  session_id: string | null;
  container: string;
}

export interface RuntimeDispatchSnapshot {
  dispatches: RuntimeDispatchTouches[];
  revision: string;
}

export interface ReadRuntimeDispatchOptions {
  excludeIds?: readonly string[];
  /** Git root used to prove that a clean dispatch branch is already in studio. */
  targetRoot?: string;
  maxDispatches?: number;
  maxFileBytes?: number;
  maxTouches?: number;
}

function regularBoundedFile(pmRoot: string, path: string, maxBytes: number): string {
  assertNoSymlinkPath(pmRoot, path);
  if (!existsSync(path)) throw new Error(`active dispatch runtime file is missing: ${path}`);
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`active dispatch runtime path must be a regular file: ${path}`);
  if (before.size > BigInt(maxBytes)) throw new Error(`active dispatch runtime file exceeds ${maxBytes} bytes: ${path}`);
  const fd = openSync(path, "r");
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`active dispatch runtime file identity changed before read: ${path}`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (bytes.byteLength > maxBytes || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new Error(`active dispatch runtime file changed during read: ${path}`);
    }
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}

function entryExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface LogicalRetirementMarker {
  schema_version: 1;
  kind: "garelier_logical_dispatch_retirement";
  dispatch_id: string;
  container: string;
  request_id: string;
  plan_digest: string;
  journal_revision: number;
  journal_record_hash: string;
}

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
const MAX_RETIREMENT_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_RETIREMENT_REVISIONS = 512;

function parseRetirementMarker(source: string, path: string): LogicalRetirementMarker {
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) { throw new Error(`logical retirement marker is invalid JSON at ${path}: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`logical retirement marker must be an object: ${path}`);
  const marker = value as Record<string, unknown>;
  if (marker.schema_version !== 1 || marker.kind !== "garelier_logical_dispatch_retirement"
    || typeof marker.dispatch_id !== "string" || !SAFE_ID_RE.test(marker.dispatch_id)
    || typeof marker.container !== "string" || typeof marker.request_id !== "string" || !SAFE_ID_RE.test(marker.request_id)
    || typeof marker.plan_digest !== "string" || !HASH_RE.test(marker.plan_digest)
    || !Number.isSafeInteger(marker.journal_revision) || (marker.journal_revision as number) < 0
    || typeof marker.journal_record_hash !== "string" || !HASH_RE.test(marker.journal_record_hash)) {
    throw new Error(`logical retirement marker is malformed: ${path}`);
  }
  return marker as unknown as LogicalRetirementMarker;
}

export function isRuntimeDispatchLogicallyRetired(
  pmRoot: string,
  dispatchId: string,
  container: string,
  maxFileBytes = 256 * 1024,
): boolean {
  const dispatch: DispatchDirectory = { id: dispatchId, container, completelyEmpty: false };
  const markerPath = join(pmRoot, "runtime", "land_aftercare", "retired_dispatches", `${dispatch.id}.json`);
  if (!entryExists(markerPath)) return false;
  const marker = parseRetirementMarker(regularBoundedFile(pmRoot, markerPath, Math.min(maxFileBytes, 64 * 1024)), markerPath);
  if (marker.dispatch_id !== dispatch.id || resolve(marker.container) !== resolve(dispatch.container)) {
    throw new Error(`logical retirement marker dispatch/container binding changed: ${markerPath}`);
  }
  const revisionDir = join(pmRoot, "runtime", "land_aftercare", "journals", `${marker.request_id}.json.revisions`);
  assertNoSymlinkPath(pmRoot, revisionDir);
  const revisionInfo = lstatSync(revisionDir);
  if (revisionInfo.isSymbolicLink() || !revisionInfo.isDirectory()) throw new Error(`logical retirement journal store must be a real directory: ${revisionDir}`);
  const entries = readdirSync(revisionDir);
  const revisionNames = entries.filter((entry) => /^\d{12}\.json$/.test(entry)).sort();
  if (revisionNames.length === 0 || revisionNames.length > MAX_RETIREMENT_REVISIONS) {
    throw new Error(`logical retirement journal revision count is invalid: ${revisionNames.length}`);
  }
  for (const entry of entries) {
    if (/^\.\d{12}\.json\.[A-Za-z0-9-]+\.tmp$/.test(entry) || /^\d{12}\.json$/.test(entry)) continue;
    throw new Error(`unknown logical retirement journal artifact: ${entry}`);
  }
  let genesisPlan = "";
  let genesisDigest = "";
  let previousHash: string | null = null;
  let frozenReceipt = "";
  let retirementRecord: Record<string, unknown> | null = null;
  for (let index = 0; index < revisionNames.length; index++) {
    const path = join(revisionDir, revisionNames[index]!);
    let parsed: unknown;
    try { parsed = JSON.parse(regularBoundedFile(pmRoot, path, MAX_RETIREMENT_JOURNAL_BYTES)); }
    catch (error) { throw new Error(`logical retirement journal revision is invalid at ${path}: ${(error as Error).message}`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`logical retirement journal revision must be an object: ${path}`);
    const record = parsed as Record<string, unknown>;
    const plan = record.plan as Record<string, unknown> | undefined;
    if (record.schema_version !== 1 || record.kind !== "garelier_land_aftercare_journal"
      || record.request_id !== marker.request_id || record.revision !== index
      || Number(revisionNames[index]!.slice(0, 12)) !== index || !plan) {
      throw new Error(`logical retirement journal identity/sequence changed at revision ${index}`);
    }
    const { record_hash: _recordHash, ...hashPayload } = record;
    if (record.previous_revision_hash !== previousHash || record.record_hash !== sha256(canonicalJson(hashPayload))) {
      throw new Error(`logical retirement journal hash chain changed at revision ${index}`);
    }
    const planBytes = canonicalJson(plan);
    if (index === 0) { genesisPlan = planBytes; genesisDigest = String(plan.plan_digest ?? ""); }
    if (planBytes !== genesisPlan || plan.plan_digest !== genesisDigest || record.genesis_plan_digest !== genesisDigest) {
      throw new Error(`logical retirement journal frozen plan changed at revision ${index}`);
    }
    const receiptBytes = canonicalJson(record.provider_receipt ?? null);
    if (frozenReceipt === "" && record.provider_receipt !== null) frozenReceipt = receiptBytes;
    if (frozenReceipt !== "" && receiptBytes !== frozenReceipt) throw new Error(`logical retirement journal provider receipt changed at revision ${index}`);
    previousHash = String(record.record_hash);
    if (index === marker.journal_revision) retirementRecord = record;
  }
  if (!retirementRecord || retirementRecord.record_hash !== marker.journal_record_hash) {
    throw new Error(`logical retirement marker journal revision/hash is absent: ${markerPath}`);
  }
  const plan = retirementRecord.plan as Record<string, unknown>;
  const envelope = retirementRecord.envelope as Record<string, unknown> | undefined;
  const snapshot = plan.container_snapshot as Record<string, unknown> | undefined;
  const identity = snapshot?.identity as Record<string, unknown> | undefined;
  const containerInfo = lstatSync(dispatch.container);
  if (!(retirementRecord.state === "container_retired" || retirementRecord.state === "views_refreshed")
    || retirementRecord.pending_step !== null || plan.dispatch_id !== dispatch.id || resolve(String(plan.container ?? "")) !== resolve(dispatch.container)
    || plan.plan_digest !== marker.plan_digest || envelope?.physical_gc_pending !== true || envelope.retirement_tombstone !== null
    || String(containerInfo.dev) !== identity?.device || String(containerInfo.ino) !== identity?.inode) {
    throw new Error(`logical retirement marker is not bound to the retained container terminal state: ${markerPath}`);
  }
  const snapshotEntries = Array.isArray(snapshot?.entries) ? snapshot.entries as Array<Record<string, unknown>> : [];
  for (const name of ["STATE.md", "context.json"]) {
    const expected = snapshotEntries.find((entry) => entry.path === name);
    const path = join(dispatch.container, name);
    if (!expected && plan.force_remove === true) continue;
    if (!expected || typeof expected.content_hash !== "string"
      || sha256(regularBoundedFile(pmRoot, path, maxFileBytes)) !== expected.content_hash) {
      throw new Error(`logical retirement retained ${name} does not match its authenticated snapshot: ${path}`);
    }
  }
  return true;
}

interface RuntimeDispatchContext extends Pick<RuntimeDispatchTouches, "touches" | "work_id" | "session_id"> {
  branch: string | null;
  integration: string | null;
}

function contextFrom(source: string, path: string, maxTouches: number): RuntimeDispatchContext {
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch (error) { throw new Error(`active dispatch context is invalid JSON at ${path}: ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`active dispatch context must be an object: ${path}`);
  const root = parsed as Record<string, unknown>;
  const task = root.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error(`active dispatch context.task must be an object: ${path}`);
  const rawTouches = (task as Record<string, unknown>).touches;
  if (!Array.isArray(rawTouches) || rawTouches.some((touch) => typeof touch !== "string")) {
    throw new Error(`active dispatch context.task.touches must be a string array: ${path}`);
  }
  if (rawTouches.length > maxTouches) throw new Error(`active dispatch declares more than ${maxTouches} touches: ${path}`);
  const branchValue = (task as Record<string, unknown>).branch;
  const integrationValue = (task as Record<string, unknown>).base_branch;
  if (branchValue !== undefined && typeof branchValue !== "string") throw new Error(`active dispatch context.task.branch must be a string: ${path}`);
  if (integrationValue !== undefined && typeof integrationValue !== "string") throw new Error(`active dispatch context.task.base_branch must be a string: ${path}`);
  const control = root.control;
  let workId: string | null = null;
  let sessionId: string | null = null;
  if (control !== undefined) {
    if (!control || typeof control !== "object" || Array.isArray(control)) throw new Error(`active dispatch context.control must be an object: ${path}`);
    const record = control as Record<string, unknown>;
    if (record.work_id !== undefined && typeof record.work_id !== "string") throw new Error(`active dispatch context.control.work_id must be a string: ${path}`);
    if (record.session_id !== undefined && typeof record.session_id !== "string") throw new Error(`active dispatch context.control.session_id must be a string: ${path}`);
    workId = typeof record.work_id === "string" ? record.work_id : null;
    sessionId = typeof record.session_id === "string" ? record.session_id : null;
  }
  return {
    touches: [...new Set(rawTouches)].sort(), work_id: workId, session_id: sessionId,
    branch: typeof branchValue === "string" && branchValue ? branchValue : null,
    integration: typeof integrationValue === "string" && integrationValue ? integrationValue : null,
  };
}

function gitProbe(root: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(requireRuntimeExecutable("git"), ["-C", root, ...args], {
    windowsHide: true, encoding: "utf8", timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/** A retained container stops participating in claim conflicts only after Git
 * binds its declared branch to the checkout's symbolic branch and exact HEAD,
 * proves that commit reachable from the configured integration branch, and
 * finds no uncommitted bytes. Missing, detached, mismatched, dirty, or
 * indeterminate identity remains active so unlanded work stays fail-closed. */
function isLandedCleanDispatch(
  pmRoot: string,
  targetRoot: string | undefined,
  integrationBranch: string | undefined,
  container: string,
  context: RuntimeDispatchContext,
): boolean {
  if (!targetRoot || !integrationBranch || !context.branch || context.integration !== integrationBranch) return false;
  const checkout = join(container, "checkout");
  if (!entryExists(checkout)) return false;
  assertNoSymlinkPath(pmRoot, checkout);
  const info = lstatSync(checkout);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`active dispatch checkout must be a real directory: ${checkout}`);

  const declared = gitProbe(targetRoot, ["rev-parse", "--verify", `${context.branch}^{commit}`]);
  if (declared.error || declared.status !== 0) return false;
  const declaredHead = declared.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(declaredHead)) return false;
  const checkedBranch = gitProbe(checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (checkedBranch.error || checkedBranch.status !== 0 || checkedBranch.stdout.trim() !== context.branch) return false;
  const checkedHeadProbe = gitProbe(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (checkedHeadProbe.error || checkedHeadProbe.status !== 0) return false;
  const checkedHead = checkedHeadProbe.stdout.trim();
  if (checkedHead !== declaredHead) return false;
  const ancestry = gitProbe(targetRoot, ["merge-base", "--is-ancestor", declaredHead, integrationBranch]);
  if (ancestry.error || ancestry.status !== 0) return false;

  const status = gitProbe(checkout, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.error || status.status !== 0) return false;
  return status.stdout.length === 0;
}

/** W-617 (a) — the landed-clean test, run on a container whose lane state could
 * NOT be resolved.
 *
 * `isLandedCleanDispatch` needs the context, and reading the context is itself a
 * fail-closed operation: a partial shell has no `context.json` and the read
 * throws. That is the right default when the container might still hold work,
 * which is why the ordinary path resolves the lane state first. But a container
 * whose branch is ALREADY an ancestor of the integration branch, with a clean
 * worktree, holds nothing a claim needs to protect — and refusing it because its
 * lane bookkeeping rotted is how a landed container ends up blocking the next
 * dispatch until a PM removes it by hand.
 *
 * Every failure here (missing context, unparseable context, git unavailable)
 * answers "cannot prove it landed" = false, so the refusal below still fires.
 * Proving landing is the ONLY thing that can silence it. */
function landedCleanWithoutLaneState(
  pmRoot: string,
  targetRoot: string | undefined,
  integrationBranch: string | undefined,
  container: string,
  maxFileBytes: number,
  maxTouches: number,
): boolean {
  if (!targetRoot || !integrationBranch) return false;
  try {
    const contextPath = join(container, "context.json");
    const context = contextFrom(regularBoundedFile(pmRoot, contextPath, maxFileBytes), contextPath, maxTouches);
    return isLandedCleanDispatch(pmRoot, targetRoot, integrationBranch, container, context);
  } catch {
    return false;
  }
}

/** W-617 / G-1 extended — name the cause that is actually blocking, and the
 * command that resolves it.
 *
 * The pre-fix refusal said only "active dispatch lane has no canonical
 * STATE/session/result state". A PM reading that on a container which had, in
 * fact, two unlanded commits spent the next steps looking at STATE.md and
 * session.json — neither of which was the reason the container mattered. A
 * failure that names the wrong cause costs more than one that names none.
 *
 * The added lines are DIAGNOSIS ONLY: nothing here removes, repairs, or retries
 * anything. The recovery command is printed for a human to run or not run. */
function unresolvedLaneStateDiagnosis(
  pmRoot: string,
  targetRoot: string | undefined,
  integrationBranch: string | undefined,
  container: string,
  id: string,
  maxFileBytes: number,
  maxTouches: number,
): string[] {
  const lines: string[] = [];
  let branch: string | undefined;
  try {
    const contextPath = join(container, "context.json");
    branch = contextFrom(regularBoundedFile(pmRoot, contextPath, maxFileBytes), contextPath, maxTouches).branch ?? undefined;
  } catch {
    lines.push("this container has no readable context.json, so its identity cannot be established from here");
  }
  if (branch && targetRoot && integrationBranch) {
    const unlanded = gitProbe(targetRoot, ["rev-list", "--count", `${integrationBranch}..${branch}`]);
    const count = unlanded.error || unlanded.status !== 0 ? null : Number(unlanded.stdout.trim());
    if (count !== null && Number.isFinite(count)) {
      lines.push(count > 0
        // THIS is what a PM needs to read first: the container is not stale
        // bookkeeping, it is holding work that exists nowhere else.
        ? `it holds UNLANDED work: '${branch}' has ${count} commit(s) not in '${integrationBranch}'. Land them through the merge gate rather than reclaiming this container.`
        : `'${branch}' is fully contained in '${integrationBranch}', so no commit would be lost — but the container could not be proven clean (uncommitted changes, a moved HEAD, or a missing checkout).`);
    } else {
      lines.push(`'${branch}' does not resolve in ${targetRoot}, so landing cannot be proven from here`);
    }
  }
  lines.push(
    "inspect first: " +
    `git -C ${container}/checkout status --porcelain=v1 --untracked-files=all && git -C ${container}/checkout log --oneline ${integrationBranch ?? "<integration>"}..HEAD`,
  );
  lines.push(
    "then, if you decide the container is disposable: " +
    `bun skills/garelier-core/driver/src/scripts/dispatch_cleanup.ts --project <project-root> --pm-id ${basename(resolve(pmRoot))} --id ${id} --force-remove`,
  );
  return lines;
}

interface DispatchDirectory {
  id: string;
  container: string;
  completelyEmpty: boolean;
}

function dispatchDirectories(pmRoot: string): DispatchDirectory[] {
  const root = join(pmRoot, "_crew");
  const found = new Map<string, DispatchDirectory>();
  if (!existsSync(root)) return [];
  assertNoSymlinkPath(pmRoot, root);
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`dispatch runtime root must be a real directory: ${root}`);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const match = entry.name.match(/^dispatch(\d+)$/);
    if (!match) continue;
    const container = join(root, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`dispatch runtime container must be a real directory: ${container}`);
    assertNoSymlinkPath(pmRoot, container);
    const id = match[1]!;
    // A crash can leave the directory shell created by dispatch_prepare before
    // any coordination artifact exists. Ignore ONLY a bounded, successfully
    // inventoried, truly empty real directory. One unknown entry, symlink,
    // partial artifact, or inventory failure remains active/unknown and flows
    // into the fail-closed STATE/context checks below.
    const contents = readdirSync(container, { withFileTypes: true });
    const completelyEmpty = contents.length === 0;
    found.set(id, { id, container, completelyEmpty });
  }
  return [...found.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export function readRuntimeDispatchSnapshot(pmRoot: string, options: ReadRuntimeDispatchOptions = {}): RuntimeDispatchSnapshot {
  const excluded = new Set((options.excludeIds ?? []).map((id) => String(id).replace(/^#/, "")));
  const maxDispatches = options.maxDispatches ?? 256;
  const maxFileBytes = options.maxFileBytes ?? 256 * 1024;
  const maxTouches = options.maxTouches ?? 256;
  let integrationBranch: string | undefined;
  if (options.targetRoot) {
    try { integrationBranch = loadConfig(resolve(options.targetRoot), basename(resolve(pmRoot))).branches.integration; }
    catch { /* unavailable authority cannot prove landing; retain every dispatch below */ }
  }
  const candidates = dispatchDirectories(pmRoot)
    .filter(({ id, completelyEmpty }) => !excluded.has(id) && !completelyEmpty);
  if (candidates.length > maxDispatches) throw new Error(`dispatch runtime container count exceeds ${maxDispatches}`);
  const directories = candidates
    .filter((dispatch) => !isRuntimeDispatchLogicallyRetired(pmRoot, dispatch.id, dispatch.container, maxFileBytes));
  const dispatches = directories.map(({ id, container }): RuntimeDispatchTouches | null => {
    const statePath = join(container, "STATE.md");
    const laneRoot = join(container, "lane");
    const sessionPath = join(laneRoot, "session.json");
    const sessionSource = entryExists(sessionPath) ? regularBoundedFile(pmRoot, sessionPath, maxFileBytes) : null;
    const resultSource = readDispatchSessionResult(laneRoot, sessionSource, (path) =>
      entryExists(path) ? regularBoundedFile(pmRoot, path, maxFileBytes) : null).source;
    const legacySource = entryExists(statePath) ? regularBoundedFile(pmRoot, statePath, maxFileBytes) : null;
    const state = resolveDispatchLaneState({ sessionSource, resultSource, legacyStateSource: legacySource }).state;
    if (!state) {
      // W-617 (a): the claim denominator is "containers holding unlanded work",
      // not "containers with tidy bookkeeping". A landed, clean container is
      // excluded here for the same reason it is excluded below — there is
      // nothing left in it to protect — and only landing can reach this branch.
      if (landedCleanWithoutLaneState(pmRoot, options.targetRoot, integrationBranch, container, maxFileBytes, maxTouches)) return null;
      throw new Error([
        `active dispatch lane has no canonical STATE/session/result state: ${container}`,
        ...unresolvedLaneStateDiagnosis(pmRoot, options.targetRoot, integrationBranch, container, id, maxFileBytes, maxTouches),
      ].join("\n  "));
    }
    // Resolve lifecycle state before the landed-only identity exception. This
    // keeps partial dispatch shells fail-closed with the canonical STATE
    // refusal while the empty-shell filter above remains the sole exception.
    const contextPath = join(container, "context.json");
    const context = contextFrom(regularBoundedFile(pmRoot, contextPath, maxFileBytes), contextPath, maxTouches);
    if (isLandedCleanDispatch(pmRoot, options.targetRoot, integrationBranch, container, context)) return null;
    const { branch: _branch, integration: _integration, ...identity } = context;
    return { id, state, ...identity, container };
  }).filter((entry): entry is RuntimeDispatchTouches => entry !== null);
  const revision = `sha256:${createHash("sha256").update(JSON.stringify(dispatches)).digest("hex")}`;
  return { dispatches, revision };
}
