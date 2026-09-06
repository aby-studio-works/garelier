#!/usr/bin/env bun
// Canonical framework public-release entrypoint (W-195). The release engine is
// deliberately import-only: this wrapper binds it to a PM-approved Concierge
// ledger, an attended permission record, an exact remote destination, and a
// fresh Guardian verdict before the engine can reach any external write.

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync as rawWriteFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validatePmId } from "../config.ts";
import { normalizeApprovedRemoteDestinations } from "../guard/approved_remotes.ts";
import { recordPathFor } from "../guard/attended_record.ts";
import {
  configurePathGuardRoots,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "../guard/path_guard.ts";
import { resolveControlRoot } from "../guard/record_paths.ts";
import { extractReviewSha, extractVerdict } from "../merge_gate_parse.ts";
import {
  die,
  git,
  printHelp,
  run,
  runBash,
  shellQuote,
} from "./_lib.ts";
import {
  assertSyncMaterialized,
  removeStaleTrackedFiles,
  syncTreeViaTar,
} from "./release.ts";

const ROOT = process.env.GARELIER_RELEASE_ROOT && process.env.GARELIER_RELEASE_ROOT !== ""
  ? resolve(process.env.GARELIER_RELEASE_ROOT)
  : resolve(import.meta.dir, "..", "..", "..", "..", "..");
const SHA = /^[0-9a-f]{40,64}$/;
const PASSING = new Set(["PASS", "PASS_WITH_NOTES"]);
const EXPORT = join(ROOT, "skills", "garelier-core", "driver", "src", "scripts", "make-public-export.ts");

// W-755: GitHub creates the workflow run for a push a few seconds AFTER the
// push returns. The measured v3.0.0 release asked once at 13:28:27.962Z and the
// run was created at 13:28:30Z, so the single query saw nothing and the release
// aborted with public main already updated. These bound the wait for that run
// to appear: query immediately, then every interval until the budget is spent.
export const CI_RUN_POLL_INTERVAL_MS = 5_000;
export const CI_RUN_POLL_BUDGET_MS = 120_000;

export interface CiRunPollDeps {
  /** One `gh run list --commit <sha> --jq .[0].databaseId`; "" when absent. */
  listRunId: () => string;
  sleep: (ms: number) => void;
  now: () => number;
}

/** The run id for the pushed SHA, or null when it never appeared inside the
 * budget. The first query happens before any wait, so a budget of 0 is exactly
 * the pre-W-755 behaviour (ask once, then abort) — that is what makes the
 * bound refutable rather than merely configurable. */
export function waitForPushedCiRun(
  deps: CiRunPollDeps,
  budgetMs: number = CI_RUN_POLL_BUDGET_MS,
  intervalMs: number = CI_RUN_POLL_INTERVAL_MS,
): string | null {
  const started = deps.now();
  for (;;) {
    const id = deps.listRunId().trim();
    if (/^\d+$/.test(id)) return id;
    if (deps.now() - started >= budgetMs) return null;
    deps.sleep(intervalMs);
  }
}

/** Blocking wait with no timer plumbing and no busy loop. */
function blockingSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface Options {
  approvalLedger: string;
  permissionRecord: string;
  guardianReport: string;
  externalLock: string;
  publishRepo: string;
  githubRepo: string;
  dryRun: boolean;
  yes: boolean;
  /** W-755: resume the named already-pushed request from the CI watch. */
  resume: string;
}

const HELP = `Usage: skills/garelier-core/driver/src/scripts/concierge_release.ts [options]

Runs the framework public-release engine only from an approved Concierge seat.

Required:
  --approval-ledger <json>   PM-authored, user-approved framework_release ledger
  --permission-record <json> dispatch_prepare Concierge permission record
  --guardian-report <md>     passing Guardian verdict bound to source_sha
  --publish-repo <path>      exact approved public clone
  --repo <owner/name>        exact approved GitHub repository

Execution:
  --dry-run                  Print and validate the complete plan; no external write
  --external-lock <json>     Canonical current-PID release lock (required without --dry-run)
  --resume <request_id>      Resume an already-pushed release from the CI watch:
                             no re-export, no re-push. Requires the canonical
                             lock for that request and a publish clone whose
                             HEAD is exactly the SHA that was pushed.
  --yes                      Skip the release engine's attended confirmations
  -h, --help                 Show this help
`;

function parse(argv: string[]): Options {
  const options: Options = {
    approvalLedger: "",
    permissionRecord: "",
    guardianReport: "",
    externalLock: "",
    publishRepo: "",
    githubRepo: "",
    dryRun: false,
    yes: false,
    resume: "",
  };
  const next = (i: number, arg: string): string => {
    const value = argv[i + 1];
    if (!value) die(`concierge_release: ${arg} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--approval-ledger") options.approvalLedger = next(i++, arg);
    else if (arg === "--permission-record") options.permissionRecord = next(i++, arg);
    else if (arg === "--guardian-report") options.guardianReport = next(i++, arg);
    else if (arg === "--external-lock") options.externalLock = next(i++, arg);
    else if (arg === "--publish-repo") options.publishRepo = next(i++, arg);
    else if (arg === "--repo") options.githubRepo = next(i++, arg);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--resume") options.resume = next(i++, arg);
    else if (arg === "--yes") options.yes = true;
    else if (arg === "-h" || arg === "--help") printHelp(HELP);
    else die(`concierge_release: unknown argument '${arg}'\n${HELP}`);
  }
  for (const [flag, value] of [
    ["--approval-ledger", options.approvalLedger],
    ["--permission-record", options.permissionRecord],
    ["--guardian-report", options.guardianReport],
    ["--publish-repo", options.publishRepo],
    ["--repo", options.githubRepo],
  ] as const) {
    if (!value) die(`concierge_release: ${flag} is required`);
  }
  if (!options.dryRun && !options.externalLock) {
    die("concierge_release: --external-lock is required for an external-write release");
  }
  if (options.resume && options.dryRun) {
    die("concierge_release: --resume is an external-write continuation; it cannot be combined with --dry-run");
  }
  options.approvalLedger = resolve(options.approvalLedger);
  options.permissionRecord = resolve(options.permissionRecord);
  options.guardianReport = resolve(options.guardianReport);
  options.externalLock = options.externalLock ? resolve(options.externalLock) : "";
  options.publishRepo = resolve(options.publishRepo);
  return options;
}

function readRecord(path: string, label: string): Record<string, unknown> {
  if (!existsSync(path)) die(`concierge_release: ${label} does not exist: ${path}`);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      die(`concierge_release: ${label} must be a JSON object: ${path}`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    die(`concierge_release: cannot read ${label} '${path}': ${String(error)}`);
  }
}

function text(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    die(`concierge_release: ${label}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function gitValue(repo: string, args: string[], label: string): string {
  const result = git(repo, args);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    die(`concierge_release: ${label}${detail ? `\n${detail}` : ""}`, result.exitCode || 1);
  }
  return result.stdout.trim();
}

// pm_id has ONE authority: config.ts::validatePmId (DEC-006 §2.6 plus the
// DEC-044 single-user default `_workshop`). This wrapper only re-labels the
// refusal so it keeps this entrypoint's stderr convention; it does NOT restate
// the pattern. A second pattern here is exactly what made the release wrapper
// reject the framework's own default id while every other seat accepted it
// (W-730). The accepted alphabet is [a-z0-9_-] with a `_workshop` special case,
// so every id that gets through is one safe path segment and no `..` survives.
function assertReleasePmId(pmId: string): void {
  try {
    validatePmId(pmId);
  } catch (error) {
    throw new Error(`concierge_release: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function safeRequestId(requestId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestId) || requestId.includes("..")) {
    throw new Error(`concierge_release: invalid approval request_id '${requestId}'`);
  }
  return requestId;
}

function safeAgentName(agentName: string): string {
  if (
    !/^ga-concierge-[A-Za-z0-9._-]+$/.test(agentName)
    || agentName.includes("..")
  ) {
    throw new Error(`concierge_release: invalid GARELIER_AGENT_NAME '${agentName}'`);
  }
  return agentName;
}

export interface ReleaseAuthorityPaths {
  approvalLedger: string;
  permissionRecord: string;
  guardianRoot: string;
}

export function canonicalReleaseAuthorityPaths(
  controlRoot: string,
  pmId: string,
  requestId: string,
  agentName: string,
): ReleaseAuthorityPaths {
  const garelierDir = join(resolve(controlRoot), "__garelier");
  assertReleasePmId(pmId);
  return {
    approvalLedger: join(
      garelierDir,
      pmId,
      "runtime",
      "concierge",
      "requests",
      `framework_release__${safeRequestId(requestId)}.approval.json`,
    ),
    permissionRecord: recordPathFor(garelierDir, pmId, safeAgentName(agentName)),
    guardianRoot: join(garelierDir, pmId, "runtime", "guardian", "results"),
  };
}

export function canonicalReleaseLockPath(
  controlRoot: string,
  pmId: string,
  tag: string,
): string {
  const sanitizedTag = tag.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!sanitizedTag) throw new Error("concierge_release: release tag has no usable lock identity");
  assertReleasePmId(pmId);
  return join(
    resolve(controlRoot),
    "__garelier",
    pmId,
    "runtime",
    "concierge",
    "locks",
    `release__${sanitizedTag}.lock`,
  );
}

interface ReleaseLockFields {
  requestId: string;
  sourceSha: string;
  targetRemote: string;
  tag: string;
}

export interface AcquiredReleaseLock {
  path: string;
  donePath: string;
  requestId: string;
  ownerPid: number;
  nonce: string;
}

function readExternalLock(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`concierge_release: cannot read external lock '${path}': ${String(error)}`);
  }
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireReleaseLock(
  path: string,
  expectedPath: string,
  fields: ReleaseLockFields,
  ownerPid = process.pid,
): AcquiredReleaseLock {
  if (resolve(path) !== resolve(expectedPath)) {
    throw new Error(
      `concierge_release: external lock must be the canonical current-PM release lock: ${expectedPath}`,
    );
  }
  const lockDir = dirname(expectedPath);
  const donePath = `${expectedPath}.done`;
  configurePathGuardRoots([lockDir]);
  mkdirSync(lockDir, { recursive: true });
  if (existsSync(donePath)) {
    throw new Error(
      `concierge_release: canonical release lock is already finalized: ${donePath}`,
    );
  }
  const nonce = randomUUID();
  const body = {
    request_id: fields.requestId,
    operation_kind: "framework_release",
    target_remote: fields.targetRemote,
    target_ref: fields.tag,
    source_sha: fields.sourceSha,
    pid: ownerPid,
    nonce,
    started_at: new Date().toISOString(),
    status: "active",
  };
  try {
    writeFileSync(expectedPath, JSON.stringify(body, null, 2) + "\n", { flag: "wx" });
    return {
      path: expectedPath,
      donePath,
      requestId: fields.requestId,
      ownerPid,
      nonce,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(`concierge_release: cannot atomically acquire release lock: ${String(error)}`);
    }
  }

  const existing = readExternalLock(expectedPath);
  const pid = existing.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    throw new Error("concierge_release: existing canonical release lock has no valid owner pid");
  }
  if (pidIsLive(pid as number)) {
    throw new Error(
      `concierge_release: canonical release lock is held by another live pid ${pid}; current pid is ${ownerPid}`,
    );
  }
  throw new Error(
    `concierge_release: canonical release lock is stale (owner pid ${pid}); recover it before release`,
  );
}

/** W-755: the push is the point of no return — public main is updated and no
 * later refusal can take it back. Recording it in the lock is what lets a
 * failure after this point stay RESUMABLE instead of being finalized as a
 * dead request: `.done` is now written only for a release that never pushed,
 * or for one that completed tag + release. */
export function markReleaseLockPushed(acquired: AcquiredReleaseLock, pushedSha: string): void {
  if (!SHA.test(pushedSha)) {
    throw new Error(`concierge_release: pushed SHA is not a full lowercase SHA: ${pushedSha}`);
  }
  const existing = readExternalLock(acquired.path);
  assertLockOwnership(existing, acquired, ["active", "pushed"]);
  writeLockBody(acquired.path, {
    ...existing,
    status: "pushed",
    pushed_sha: pushedSha,
    pushed_at: new Date().toISOString(),
  });
}

/** W-755: the resumable predicate, kept in one place so the CLI, the docs and
 * the refutation all read the same rule. `pushed_sha` is present only for a
 * release that ran the W-755 code; an older lock (the measured v3.0.0 one is
 * still `status: "active"`) proves the push through the remote instead, which
 * is why `remoteMainSha` is required and why the caller must additionally
 * require the local publish HEAD to equal the answer. */
export function resolveResumePushedSha(
  lockBody: Record<string, unknown>,
  remoteMainSha: string,
  localPublishSha: string,
): string {
  const recorded = lockBody.pushed_sha;
  const candidate = typeof recorded === "string" && SHA.test(recorded) ? recorded : remoteMainSha;
  if (!SHA.test(candidate)) {
    throw new Error("concierge_release: cannot resume: the lock records no pushed SHA and the remote main head is unreadable");
  }
  if (remoteMainSha !== candidate) {
    throw new Error(
      `concierge_release: cannot resume: the remote main head is ${remoteMainSha || "unreadable"}, not the recorded pushed SHA ${candidate}`,
    );
  }
  if (localPublishSha !== candidate) {
    throw new Error(
      `concierge_release: cannot resume: public clone HEAD ${localPublishSha || "unreadable"} is not the pushed SHA ${candidate}`,
    );
  }
  return candidate;
}

/** W-755: the one rule that decides whether a failing release is terminal.
 *
 * Kept as its own predicate because it is the whole point of the row: before
 * the push a failure has written nothing outward and `.done` correctly closes
 * the request; after the push, writing `.done` strands an updated public main
 * with no way back in, which is exactly what happened to v3.0.0. */
export function releaseFinalizeAction(
  outcome: "complete" | "failed",
  pushedSha: string | null,
): "write-done" | "keep-pushed-for-resume" {
  return outcome === "failed" && pushedSha !== null ? "keep-pushed-for-resume" : "write-done";
}

function assertLockOwnership(
  existing: Record<string, unknown>,
  acquired: AcquiredReleaseLock,
  allowedStatus: readonly string[],
): void {
  if (
    existing.pid !== acquired.ownerPid
    || existing.request_id !== acquired.requestId
    || existing.nonce !== acquired.nonce
    || typeof existing.status !== "string"
    || !allowedStatus.includes(existing.status)
  ) {
    throw new Error("concierge_release: release lock ownership changed before finalization");
  }
}

/** Replace the lock body in place. The lock file's identity is the critical
 * section; its BODY is owner-stamped and re-checked before every write, so a
 * plain rewrite cannot silently adopt another owner's lock. */
function writeLockBody(path: string, body: Record<string, unknown>): void {
  configurePathGuardRoots([dirname(path)]);
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
}

/** W-755: adopt an existing, un-finalized (or failed-finalized) release lock for
 * `--resume`. Never creates a lock — a resume with nothing pushed has nothing
 * to resume. */
export function adoptReleaseLockForResume(
  path: string,
  expectedPath: string,
  requestId: string,
  ownerPid = process.pid,
): { acquired: AcquiredReleaseLock; body: Record<string, unknown>; supersedesFailedDone: boolean } {
  if (resolve(path) !== resolve(expectedPath)) {
    throw new Error(
      `concierge_release: external lock must be the canonical current-PM release lock: ${expectedPath}`,
    );
  }
  if (!existsSync(expectedPath)) {
    throw new Error(`concierge_release: nothing to resume: no canonical release lock at ${expectedPath}`);
  }
  const donePath = `${expectedPath}.done`;
  const body = readExternalLock(expectedPath);
  if (body.request_id !== requestId) {
    throw new Error(
      `concierge_release: release lock belongs to request ${String(body.request_id)}, not ${requestId}`,
    );
  }
  let supersedesFailedDone = false;
  if (existsSync(donePath)) {
    const done = readExternalLock(donePath);
    if (done.request_id !== requestId) {
      throw new Error(`concierge_release: finalized release lock belongs to another request: ${donePath}`);
    }
    if (done.outcome !== "failed") {
      throw new Error(
        `concierge_release: release request ${requestId} is already finalized as ${String(done.outcome)}; there is nothing to resume`,
      );
    }
    supersedesFailedDone = true;
  }
  const pid = body.pid;
  if (Number.isInteger(pid) && (pid as number) > 0 && (pid as number) !== ownerPid && pidIsLive(pid as number)) {
    throw new Error(
      `concierge_release: canonical release lock is held by another live pid ${pid}; current pid is ${ownerPid}`,
    );
  }
  const nonce = randomUUID();
  const adopted: AcquiredReleaseLock = { path: expectedPath, donePath, requestId, ownerPid, nonce };
  writeLockBody(expectedPath, {
    ...body,
    pid: ownerPid,
    nonce,
    status: "pushed",
    resumed_at: new Date().toISOString(),
  });
  return { acquired: adopted, body, supersedesFailedDone };
}

export function markReleaseLockDone(
  acquired: AcquiredReleaseLock,
  outcome: "complete" | "failed",
  supersedeFailedDone = false,
): void {
  const existing = readExternalLock(acquired.path);
  assertLockOwnership(existing, acquired, ["active", "pushed"]);
  if (supersedeFailedDone && existsSync(acquired.donePath)) {
    const prior = readExternalLock(acquired.donePath);
    if (prior.request_id !== acquired.requestId || prior.outcome !== "failed") {
      throw new Error("concierge_release: release lock completion was already claimed by another owner");
    }
    writeLockBody(acquired.donePath, {
      request_id: acquired.requestId,
      operation_kind: "framework_release",
      lock_path: acquired.path,
      owner_pid: acquired.ownerPid,
      nonce: acquired.nonce,
      outcome,
      completed_at: new Date().toISOString(),
      superseded_completed_at: prior.completed_at ?? null,
      status: "done",
    });
    return;
  }
  const completion = {
    request_id: acquired.requestId,
    operation_kind: "framework_release",
    lock_path: acquired.path,
    owner_pid: acquired.ownerPid,
    nonce: acquired.nonce,
    outcome,
    completed_at: new Date().toISOString(),
    status: "done",
  };
  try {
    writeFileSync(acquired.donePath, JSON.stringify(completion, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(`concierge_release: cannot atomically finalize release lock: ${String(error)}`);
    }
    const prior = readExternalLock(acquired.donePath);
    if (
      prior.request_id === acquired.requestId
      && prior.owner_pid === acquired.ownerPid
      && prior.nonce === acquired.nonce
      && prior.outcome === outcome
      && prior.status === "done"
    ) {
      return;
    }
    throw new Error("concierge_release: release lock completion was already claimed by another owner");
  }
}

function validateAuthorization(
  options: Options,
  /** W-755: on a resume the publish clone legitimately sits AHEAD of the
   * ledger's `expected_publish_sha` — the sync commit that was pushed is the
   * reason there is anything to resume. The caller supplies the SHA the clone
   * must equal instead; every other authority check is unchanged, so a resume
   * is not a weaker route, only a differently-bound one. */
  expectedPublishOverride: string | null = null,
): {
  requestId: string;
  sourceSha: string;
  remoteUrl: string;
  tag: string;
  controlRoot: string;
  pmId: string;
} {
  if ((process.env.GARELIER_ROLE ?? "").toLowerCase() !== "concierge") {
    die("concierge_release: canonical route requires GARELIER_ROLE=concierge");
  }
  const pmId = process.env.GARELIER_PM_ID ?? "";
  if (!pmId) die("concierge_release: GARELIER_PM_ID is required");
  const agentName = process.env.GARELIER_AGENT_NAME ?? "";
  if (!agentName) die("concierge_release: GARELIER_AGENT_NAME is required");
  const controlRoot = resolveControlRoot(ROOT);
  const gitCommonDir = resolve(
    ROOT,
    gitValue(ROOT, ["rev-parse", "--git-common-dir"], "cannot resolve framework repository identity"),
  );
  const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    die(`concierge_release: VERSION is not a release version: '${version}'`);
  }
  const tag = `v${version}`;

  const approval = readRecord(options.approvalLedger, "approval ledger");
  if (approval.schema_version !== 1) die("concierge_release: approval ledger schema_version must be 1");
  if (text(approval, "operation_kind", "approval ledger") !== "framework_release") {
    die("concierge_release: approval ledger operation_kind must be framework_release");
  }
  if (text(approval, "approval_status", "approval ledger") !== "approved") {
    die("concierge_release: approval ledger requires approval_status=approved");
  }
  if (text(approval, "requested_by", "approval ledger") !== "user") {
    die("concierge_release: approval ledger requested_by must be user");
  }
  text(approval, "approved_by", "approval ledger");
  text(approval, "user_approval_ref", "approval ledger");
  const requestId = text(approval, "request_id", "approval ledger");
  let authorityPaths: ReleaseAuthorityPaths;
  try {
    authorityPaths = canonicalReleaseAuthorityPaths(controlRoot, pmId, requestId, agentName);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (options.approvalLedger !== resolve(authorityPaths.approvalLedger)) {
    die(
      `concierge_release: approval ledger must be the canonical PM-owned request: ${authorityPaths.approvalLedger}`,
    );
  }
  if (options.permissionRecord !== resolve(authorityPaths.permissionRecord)) {
    die(
      `concierge_release: permission record must be the canonical attended record: ${authorityPaths.permissionRecord}`,
    );
  }
  if (dirname(options.guardianReport) !== resolve(authorityPaths.guardianRoot)) {
    die(
      `concierge_release: Guardian report must be under the canonical PM Guardian results root: ${authorityPaths.guardianRoot}`,
    );
  }
  for (const [key, expected] of [
    ["pm_id", pmId],
    ["control_root", controlRoot],
    ["git_common_dir", gitCommonDir],
    ["agent_name", agentName],
    ["permission_record", options.permissionRecord],
    ["guardian_report", options.guardianReport],
    ["release_tag", tag],
  ] as const) {
    const actual = text(approval, key, "approval ledger");
    const pathBound = key === "control_root"
      || key === "git_common_dir"
      || key === "permission_record"
      || key === "guardian_report";
    if ((pathBound ? resolve(actual) : actual) !== expected) {
      die(`concierge_release: approval ledger ${key} does not match the live release context`);
    }
  }
  const sourceSha = text(approval, "source_sha", "approval ledger");
  const expectedPublishSha = text(approval, "expected_publish_sha", "approval ledger");
  if (!SHA.test(sourceSha) || !SHA.test(expectedPublishSha)) {
    die("concierge_release: approval ledger source_sha and expected_publish_sha must be full lowercase SHAs");
  }
  if (resolve(text(approval, "publish_repo", "approval ledger")) !== options.publishRepo) {
    die("concierge_release: --publish-repo does not match the approved destination");
  }
  if (text(approval, "github_repo", "approval ledger") !== options.githubRepo) {
    die("concierge_release: --repo does not match the approved destination");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(options.githubRepo)) {
    die("concierge_release: approved github_repo must be owner/name");
  }
  if (options.yes && approval.allow_unattended_confirmations !== true) {
    die("concierge_release: --yes requires allow_unattended_confirmations=true in the approval ledger");
  }
  const remote = text(approval, "target_remote", "approval ledger");
  if (remote !== "origin") die("concierge_release: framework release target_remote must be origin");
  const remoteUrl = text(approval, "approved_remote_url", "approval ledger");

  const liveSourceSha = gitValue(ROOT, ["rev-parse", "HEAD"], "cannot read framework source SHA");
  if (liveSourceSha !== sourceSha) {
    die(`concierge_release: source drift: approved ${sourceSha}, live ${liveSourceSha}`);
  }
  const livePublishSha = gitValue(options.publishRepo, ["rev-parse", "HEAD"], "cannot read public clone SHA");
  const requiredPublishSha = expectedPublishOverride ?? expectedPublishSha;
  if (livePublishSha !== requiredPublishSha) {
    die(
      expectedPublishOverride
        ? `concierge_release: cannot resume: public clone HEAD ${livePublishSha} is not the pushed SHA ${requiredPublishSha}`
        : `concierge_release: public clone drift: approved ${expectedPublishSha}, live ${livePublishSha}`,
    );
  }
  const liveRemoteUrl = gitValue(
    options.publishRepo,
    ["remote", "get-url", remote],
    `cannot read public clone remote '${remote}'`,
  );
  if (liveRemoteUrl !== remoteUrl) {
    die(`concierge_release: live remote is not the approved destination: ${remote}=${liveRemoteUrl}`);
  }

  const permission = readRecord(options.permissionRecord, "permission record");
  if (permission.source !== "attended_record" || permission.spawned_via !== "dispatch_prepare") {
    die("concierge_release: permission record must be issued by dispatch_prepare");
  }
  const guard = permission.guard;
  if (!guard || typeof guard !== "object" || Array.isArray(guard)) {
    die("concierge_release: permission record.guard must be an object");
  }
  const guardRecord = guard as Record<string, unknown>;
  if (
    guardRecord.permission_profile !== "concierge"
    || guardRecord.role !== "concierge"
    || typeof guardRecord.agent_name !== "string"
    || !guardRecord.agent_name.startsWith("ga-concierge-")
    || typeof guardRecord.worktree !== "string"
    || resolve(guardRecord.worktree) !== ROOT
  ) {
    die("concierge_release: permission record is not an attended Concierge record");
  }
  if (agentName !== guardRecord.agent_name) {
    die(`concierge_release: permission record belongs to ${guardRecord.agent_name}, not ${agentName}`);
  }
  const destinations = normalizeApprovedRemoteDestinations(guardRecord.approved_remote_destinations);
  if (!destinations.some((destination) => destination.name === remote && destination.url === remoteUrl)) {
    die(`concierge_release: permission record lacks approved destination ${remote}=${remoteUrl}`);
  }

  if (!existsSync(options.guardianReport)) {
    die(`concierge_release: Guardian report does not exist: ${options.guardianReport}`);
  }
  const guardianText = readFileSync(options.guardianReport, "utf8");
  const verdict = extractVerdict(guardianText);
  const reviewSha = extractReviewSha(guardianText);
  if (!verdict || !PASSING.has(verdict)) {
    die("concierge_release: Guardian verdict must be PASS or PASS_WITH_NOTES");
  }
  if (reviewSha !== sourceSha) {
    die(`concierge_release: Guardian verdict is stale: reviewed ${reviewSha ?? "none"}, source ${sourceSha}`);
  }

  return { requestId, sourceSha, remoteUrl, tag, controlRoot, pmId };
}

interface AuthorizedReleaseOptions {
  publishRepo: string;
  githubRepo: string;
  yes: boolean;
  dryRun: boolean;
  /** W-755: called the moment public main is pushed, before anything that can
   * still fail. Recording the push is what makes a later failure resumable. */
  onPushed?: (publicSha: string) => void;
  /** W-755: resume entry — public main is already at this SHA, so the export,
   * the sync commit and the push are skipped and the run starts at the CI
   * watch. */
  resumeFromPushedSha?: string;
}

function failReleaseCommand(label: string, result: ReturnType<typeof run>): never {
  const detail = (result.stderr || result.stdout).trim();
  die(`ABORT: ${label}${detail ? `\n${detail}` : ""}`, result.exitCode || 1);
}

function mustRelease(
  label: string,
  command: string[],
  cwd?: string,
): ReturnType<typeof run> {
  const result = run(command, { cwd });
  if (result.exitCode !== 0) failReleaseCommand(label, result);
  return result;
}

function mustReleaseGit(
  label: string,
  repo: string,
  args: string[],
): ReturnType<typeof run> {
  const result = git(repo, args);
  if (result.exitCode !== 0) failReleaseCommand(label, result);
  return result;
}

function releaseStatus(repo: string): string {
  return mustReleaseGit("cannot inspect git status", repo, ["status", "--porcelain"]).stdout.trim();
}

function releaseExecutablePaths(repo: string): string[] {
  return mustReleaseGit("cannot read executable modes", repo, ["ls-files", "-s", "-z"]).stdout
    .split("\0")
    .flatMap((entry) => {
      const tab = entry.indexOf("\t");
      return tab >= 0 && entry.startsWith("100755 ") ? [entry.slice(tab + 1)] : [];
    })
    .sort();
}

function releaseChangelogSection(version: string): string {
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[${escaped}\\].*$`, "m").exec(changelog);
  if (!heading || heading.index === undefined) {
    die(`ABORT: CHANGELOG.md has no section for [${version}]`);
  }
  const after = heading.index + heading[0].length;
  const next = /^## /m.exec(changelog.slice(after));
  return changelog.slice(heading.index, next ? after + next.index : changelog.length).trimEnd() + "\n";
}

function confirmRelease(action: string, options: AuthorizedReleaseOptions): void {
  if (options.yes) {
    console.log(`--yes: confirmed ${action}`);
    return;
  }
  const question = `Proceed with ${action}? [y/N] `;
  const response = runBash(
    ["-c", `read -r -p ${shellQuote(question)} answer; [[ "$answer" =~ ^[Yy]$ ]]`],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (response.exitCode !== 0) die(`ABORT: ${action} was not confirmed`, 1);
}

/** Everything after the push: wait for the run GitHub creates for that SHA,
 * watch it green, then tag and release. Shared by the first attempt and by
 * `--resume`, so a resume cannot drift into a second, different tail. */
function watchCiThenTagAndRelease(
  options: AuthorizedReleaseOptions,
  tag: string,
  notes: string,
  notesFile: string,
  publicSha: string,
): void {
  const runId = waitForPushedCiRun({
    listRunId: () => mustRelease(
      "cannot find GitHub Actions run for pushed main",
      [
        "gh",
        "run",
        "list",
        "--repo",
        options.githubRepo,
        "--branch",
        "main",
        "--commit",
        publicSha,
        "--limit",
        "1",
        "--json",
        "databaseId",
        "--jq",
        ".[0].databaseId",
      ],
    ).stdout.trim(),
    sleep: blockingSleep,
    now: () => Date.now(),
  });
  if (runId === null) {
    die(
      `ABORT: no GitHub Actions run found for pushed main ${publicSha} within ${CI_RUN_POLL_BUDGET_MS / 1000}s; do not tag.`
      + ` public main IS pushed — recover with: concierge_release --resume <request_id> (see external-operations.md §5).`,
    );
  }
  console.log(`==> Waiting for public CI run ${runId} to finish green`);
  mustRelease(
    "public CI is red; stopped before tag/release",
    ["gh", "run", "watch", runId, "--repo", options.githubRepo, "--exit-status"],
  );

  confirmRelease(`create annotated public tag ${tag} after green CI`, options);
  mustReleaseGit(
    "cannot create release tag",
    options.publishRepo,
    ["tag", "-a", tag, "-m", `Garelier ${tag}`],
  );
  confirmRelease(`push public tag ${tag}`, options);
  mustReleaseGit("public tag push failed", options.publishRepo, ["push", "origin", tag]);
  rawWriteFileSync(notesFile, notes);
  confirmRelease(`create GitHub release ${tag}`, options);
  mustRelease(
    "GitHub release creation failed",
    [
      "gh",
      "release",
      "create",
      tag,
      "--repo",
      options.githubRepo,
      "--title",
      `Garelier ${tag}`,
      "--notes-file",
      notesFile,
    ],
  );
  console.log(`==> Release complete: ${tag}`);
}

function runAuthorizedRelease(options: AuthorizedReleaseOptions): void {
  const resuming = typeof options.resumeFromPushedSha === "string" && options.resumeFromPushedSha !== "";
  if (!resuming && !existsSync(EXPORT)) die(`release: export script not found: ${EXPORT}`);
  if (!existsSync(options.publishRepo)) {
    die(`release: publish repo does not exist: ${options.publishRepo}`);
  }
  mustReleaseGit(
    "publish repo is not a Git worktree",
    options.publishRepo,
    ["rev-parse", "--is-inside-work-tree"],
  );
  const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    die(`release: VERSION is not a release version: '${version}'`);
  }
  const tag = `v${version}`;
  const notes = releaseChangelogSection(version);
  const branch = mustReleaseGit(
    "cannot read public branch",
    options.publishRepo,
    ["branch", "--show-current"],
  ).stdout.trim();
  if (branch !== "main") {
    die(`ABORT: public clone must be on main, found '${branch || "detached HEAD"}'`);
  }
  if (releaseStatus(options.publishRepo) !== "") {
    die("ABORT: public clone is dirty; recover or commit it before release");
  }

  const temp = mkdtempSync(join(tmpdir(), "garelier-release-"));
  const exportDir = join(temp, "export");
  const notesFile = join(temp, `release-notes-${tag}.md`);
  try {
    if (resuming) {
      // W-755 resume entry. Everything up to and including the push already
      // happened and cannot be repeated: public main is at this SHA, the
      // caller has proved the clone still sits exactly there, and re-running
      // the export would only invent a second chance to change what was
      // published. The run therefore starts where it stopped — the CI watch.
      console.log(`==> Resuming release ${tag} from the CI watch for pushed main ${options.resumeFromPushedSha}`);
      watchCiThenTagAndRelease(options, tag, notes, notesFile, options.resumeFromPushedSha!);
      return;
    }
    console.log(`==> Release ${tag}: validating history-free export`);
    mustRelease("public export failed", ["bun", EXPORT, exportDir], ROOT);
    const exportModes = releaseExecutablePaths(exportDir);
    if (options.dryRun) {
      const devDirty = releaseStatus(ROOT);
      if (devDirty) {
        console.log("DRY-RUN note: development worktree is dirty; a real release will refuse it.");
      }
      console.log(
        `DRY-RUN: version=${version}; changelog section found; export mode self-check passed (${exportModes.length} executable path(s)).`,
      );
      console.log(`DRY-RUN: would sync '${exportDir}' to '${options.publishRepo}' via tar --exclude=.git.`);
      console.log(
        "DRY-RUN: would commit the public sync, prompt before push main, then gh run watch --exit-status for that main SHA.",
      );
      console.log(
        `DRY-RUN: only after green CI, would prompt before git tag -a ${tag}, tag push, and gh release create using extracted CHANGELOG notes.`,
      );
      return;
    }
    if (releaseStatus(ROOT) !== "") {
      die("ABORT: development worktree is dirty; release only committed source");
    }

    console.log("==> Syncing export to public clone (tar stream --exclude=.git)");
    removeStaleTrackedFiles(options.publishRepo, exportDir);
    syncTreeViaTar(exportDir, options.publishRepo);
    try {
      assertSyncMaterialized(exportDir, options.publishRepo);
    } catch (error) {
      die(
        `ABORT: ${(error as Error).message}. Refusing to commit a gutted public tree.`,
      );
    }
    mustReleaseGit("cannot stage public sync", options.publishRepo, ["add", "-A"]);
    for (const path of exportModes) {
      mustReleaseGit(
        `cannot restore +x on ${path}`,
        options.publishRepo,
        ["update-index", "--chmod=+x", "--", path],
      );
    }
    const publicModes = releaseExecutablePaths(options.publishRepo);
    if (JSON.stringify(publicModes) !== JSON.stringify(exportModes)) {
      die("ABORT: public sync changed the export executable-mode set");
    }
    const staged = git(options.publishRepo, ["diff", "--cached", "--quiet"]);
    if (staged.exitCode === 1) {
      mustReleaseGit(
        "cannot commit public sync",
        options.publishRepo,
        ["commit", "-m", `chore(release): Garelier ${tag}`],
      );
    } else if (staged.exitCode !== 0) {
      failReleaseCommand("cannot inspect staged public sync", staged);
    } else {
      console.log("==> Public clone already matches export; no sync commit needed");
    }

    const publicSha = mustReleaseGit(
      "cannot read public main SHA",
      options.publishRepo,
      ["rev-parse", "HEAD"],
    ).stdout.trim();
    confirmRelease(`push public main (${publicSha})`, options);
    mustReleaseGit("public main push failed", options.publishRepo, ["push", "origin", "main"]);
    // W-755: the irreversible external write has landed. Record it BEFORE the
    // CI watch, so every refusal from here on leaves a resumable request
    // instead of a finalized dead one.
    options.onPushed?.(publicSha);
    watchCiThenTagAndRelease(options, tag, notes, notesFile, publicSha);
  } finally {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** W-755: bind a `--resume` to the request that was actually pushed.
 *
 * The lock path is derived from the tag exactly as a first attempt derives it,
 * so a resume cannot point itself at some other request's lock. The pushed SHA
 * comes from the lock when it records one and otherwise from the remote's own
 * main head — a release that failed BEFORE this row landed (the measured
 * v3.0.0 one) has a lock that still says `status: "active"`, and the only
 * durable proof that its push happened is the remote. Either way the local
 * publish clone must equal that SHA, which is checked in validateAuthorization
 * so the refusal reads with all the other authority refusals. */
function readResumeBinding(options: Options): { expectedLock: string; pushedSha: string } {
  const pmId = process.env.GARELIER_PM_ID ?? "";
  if (!pmId) die("concierge_release: GARELIER_PM_ID is required");
  const controlRoot = resolveControlRoot(ROOT);
  const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  const expectedLock = canonicalReleaseLockPath(controlRoot, pmId, `v${version}`);
  if (resolve(options.externalLock) !== resolve(expectedLock)) {
    die(`concierge_release: external lock must be the canonical current-PM release lock: ${expectedLock}`);
  }
  if (!existsSync(expectedLock)) {
    die(`concierge_release: nothing to resume: no canonical release lock at ${expectedLock}`);
  }
  let body: Record<string, unknown>;
  try {
    body = readExternalLock(expectedLock);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (body.request_id !== options.resume) {
    die(
      `concierge_release: release lock belongs to request ${String(body.request_id)}, not ${options.resume}`,
    );
  }
  const remoteMain = gitValue(
    options.publishRepo,
    ["ls-remote", "origin", "refs/heads/main"],
    "cannot read the public remote main head",
  ).split(/\s+/)[0] ?? "";
  const localPublish = gitValue(options.publishRepo, ["rev-parse", "HEAD"], "cannot read public clone SHA");
  try {
    return { expectedLock, pushedSha: resolveResumePushedSha(body, remoteMain, localPublish) };
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
}

export function runConciergeRelease(argv: string[]): void {
  const options = parse(argv);
  // W-755: a resume must prove the SAME authority as a first attempt; only the
  // publish-clone binding differs, because the clone legitimately sits at the
  // SHA that was already pushed rather than at the ledger's pre-release one.
  // Reading that binding is deliberately READ-ONLY and the lock is adopted only
  // after validateAuthorization has passed: a caller who cannot prove the role,
  // the ledger and the Guardian verdict must not be able to re-stamp the lock
  // of a real in-flight release on the way to being refused.
  const resumeBinding = options.resume ? readResumeBinding(options) : null;
  const authorization = validateAuthorization(options, resumeBinding?.pushedSha ?? null);
  if (resumeBinding && authorization.requestId !== options.resume) {
    die(
      `concierge_release: --resume ${options.resume} does not match the approval ledger request ${authorization.requestId}`,
    );
  }
  console.log("==> CONCIERGE RELEASE PLAN");
  console.log(`request=${authorization.requestId}; source_sha=${authorization.sourceSha}`);
  console.log(
    `destination=origin=${authorization.remoteUrl}; github_repo=${options.githubRepo}; tag=${authorization.tag}`,
  );
  console.log(
    resumeBinding
      ? `steps: RESUME at pushed main ${resumeBinding.pushedSha} -> CI watch -> tag -> release`
      : "steps: export -> publish push -> CI watch -> tag -> release",
  );
  console.log(`mode=${options.dryRun ? "dry-run (no external write)" : "approved external write"}`);

  if (options.dryRun) {
    runAuthorizedRelease({
      publishRepo: options.publishRepo,
      githubRepo: options.githubRepo,
      dryRun: true,
      yes: options.yes,
    });
    return;
  }

  let acquired: AcquiredReleaseLock;
  let supersedesFailedDone = false;
  try {
    const expectedLock = canonicalReleaseLockPath(
      authorization.controlRoot,
      authorization.pmId,
      authorization.tag,
    );
    if (resumeBinding) {
      const adopted = adoptReleaseLockForResume(options.externalLock, expectedLock, authorization.requestId);
      acquired = adopted.acquired;
      supersedesFailedDone = adopted.supersedesFailedDone;
      // Record what the read-only binding proved, so a second resume reads it
      // from the lock instead of re-deriving it from the remote.
      markReleaseLockPushed(acquired, resumeBinding.pushedSha);
    } else {
      acquired = acquireReleaseLock(options.externalLock, expectedLock, {
        requestId: authorization.requestId,
        sourceSha: authorization.sourceSha,
        targetRemote: "origin",
        tag: authorization.tag,
      });
    }
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  // W-755: `pushedSha` is the whole resumability decision. While it is null the
  // release has written nothing outward and a failure is genuinely terminal, so
  // `.done` is correct. Once it is set, public main carries the release commit
  // and finalizing would strand it: the lock stays at `status = "pushed"` and
  // the operator continues with --resume.
  let pushedSha: string | null = resumeBinding?.pushedSha ?? null;
  const releaseOptions: AuthorizedReleaseOptions = {
    publishRepo: options.publishRepo,
    githubRepo: options.githubRepo,
    dryRun: false,
    yes: options.yes,
    resumeFromPushedSha: resumeBinding?.pushedSha,
    onPushed: (sha) => {
      pushedSha = sha;
      markReleaseLockPushed(acquired, sha);
    },
  };

  let finalized = false;
  const finalize = (outcome: "complete" | "failed"): void => {
    if (finalized) return;
    if (releaseFinalizeAction(outcome, pushedSha) === "keep-pushed-for-resume") {
      finalized = true;
      process.stderr.write(
        `concierge_release: public main is pushed (${pushedSha}) but tag/release did not complete.`
        + ` The release lock stays at status=pushed and is NOT finalized;`
        + ` continue with: concierge_release --resume ${acquired.requestId}\n`,
      );
      return;
    }
    markReleaseLockDone(acquired, outcome, supersedesFailedDone);
    finalized = true;
  };
  const onExit = (code: number): void => {
    try {
      finalize(code === 0 ? "complete" : "failed");
    } catch (error) {
      process.stderr.write(
        `concierge_release: could not finalize release lock: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (code === 0) process.exitCode = 3;
    }
  };
  process.once("exit", onExit);
  try {
    runAuthorizedRelease(releaseOptions);
    finalize("complete");
  } finally {
    finalize("failed");
    process.off("exit", onExit);
  }
}

if (import.meta.main) {
  runConciergeRelease(process.argv.slice(2));
}
