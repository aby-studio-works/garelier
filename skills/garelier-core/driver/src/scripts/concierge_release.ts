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

interface Options {
  approvalLedger: string;
  permissionRecord: string;
  guardianReport: string;
  externalLock: string;
  publishRepo: string;
  githubRepo: string;
  dryRun: boolean;
  yes: boolean;
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

export function markReleaseLockDone(
  acquired: AcquiredReleaseLock,
  outcome: "complete" | "failed",
): void {
  const existing = readExternalLock(acquired.path);
  if (
    existing.pid !== acquired.ownerPid
    || existing.request_id !== acquired.requestId
    || existing.nonce !== acquired.nonce
    || existing.status !== "active"
  ) {
    throw new Error("concierge_release: release lock ownership changed before finalization");
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
  if (livePublishSha !== expectedPublishSha) {
    die(`concierge_release: public clone drift: approved ${expectedPublishSha}, live ${livePublishSha}`);
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

function runAuthorizedRelease(options: AuthorizedReleaseOptions): void {
  if (!existsSync(EXPORT)) die(`release: export script not found: ${EXPORT}`);
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
    const runId = mustRelease(
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
    ).stdout.trim();
    if (!/^\d+$/.test(runId)) {
      die(`ABORT: no GitHub Actions run found for pushed main ${publicSha}; do not tag`);
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
  } finally {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export function runConciergeRelease(argv: string[]): void {
  const options = parse(argv);
  const authorization = validateAuthorization(options);
  console.log("==> CONCIERGE RELEASE PLAN");
  console.log(`request=${authorization.requestId}; source_sha=${authorization.sourceSha}`);
  console.log(
    `destination=origin=${authorization.remoteUrl}; github_repo=${options.githubRepo}; tag=${authorization.tag}`,
  );
  console.log("steps: export -> publish push -> CI watch -> tag -> release");
  console.log(`mode=${options.dryRun ? "dry-run (no external write)" : "approved external write"}`);

  const releaseOptions: AuthorizedReleaseOptions = {
    publishRepo: options.publishRepo,
    githubRepo: options.githubRepo,
    dryRun: options.dryRun,
    yes: options.yes,
  };
  if (options.dryRun) {
    runAuthorizedRelease(releaseOptions);
    return;
  }

  let acquired: AcquiredReleaseLock;
  try {
    const expectedLock = canonicalReleaseLockPath(
      authorization.controlRoot,
      authorization.pmId,
      authorization.tag,
    );
    acquired = acquireReleaseLock(options.externalLock, expectedLock, {
      requestId: authorization.requestId,
      sourceSha: authorization.sourceSha,
      targetRemote: "origin",
      tag: authorization.tag,
    });
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  let finalized = false;
  const finalize = (outcome: "complete" | "failed"): void => {
    if (finalized) return;
    markReleaseLockDone(acquired, outcome);
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
