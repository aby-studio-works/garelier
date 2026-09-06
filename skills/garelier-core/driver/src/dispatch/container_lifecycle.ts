import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { readDispatchSessionResult, resolveDispatchLaneState } from "./lane_status.ts";

export type LifecycleGit = (args: string[], cwd: string) => { code: number; stdout: string };

export type ContainerTreatment = "active" | "cleanup-ready" | "guard-hold" | "unlanded-work";
export type BranchLanding = "gated" | "reachable" | "no-changes" | "not-landed" | "no-branch" | "unknown";

export interface DispatchContainerRecord {
  id: string;
  container: string;
  checkout: string;
  checkout_present: boolean;
  state: string | null;
  role: string | null;
  slug: string | null;
  branch: string | null;
  base_sha: string | null;
  work_id: string | null;
  session_id: string | null;
  claim_owned: boolean | null;
  artifact_errors: string[];
}

export interface DispatchContainerInventoryEntry extends DispatchContainerRecord {
  worktree_registered: boolean;
  branch_present: boolean | null;
  branch_ahead: number | null;
  branch_landing: BranchLanding;
  claim_live: boolean | null;
  uncommitted: boolean | null;
  treatment: ContainerTreatment;
}

function stateField(source: string, heading: string): string | null {
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((line) => new RegExp(`^##\\s*${heading}\\b`, "i").test(line));
  if (at < 0) return null;
  for (let index = at + 1; index < lines.length; index++) {
    const value = lines[index]!.trim();
    if (value) return value;
  }
  return null;
}

function safeObject(path: string, errors: string[]): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4 * 1024 * 1024) {
      errors.push(`${path}: not a bounded regular file`);
      return null;
    }
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    errors.push(`${path}: ${(error as Error).message}`);
    return null;
  }
}

function safeBoundedText(path: string, errors: string[], maxBytes = 256 * 1024): string | null {
  if (!existsSync(path)) return null;
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) throw new Error("not a bounded regular file");
    return readFileSync(path, "utf8");
  } catch (error) {
    errors.push(`${path}: ${(error as Error).message}`);
    return null;
  }
}

/** Directory reality is the denominator. No failed-cleanup log, worktree registry,
 * or context file may hide a matching `_crew/dispatch<N>` entry. */
export function readDispatchContainerRecords(pmRoot: string): DispatchContainerRecord[] {
  const crew = join(pmRoot, "_crew");
  let entries: Dirent[];
  try { entries = readdirSync(crew, { withFileTypes: true }); }
  catch { return []; }
  const records: DispatchContainerRecord[] = [];
  for (const entry of entries) {
    const match = /^dispatch(\d+)$/.exec(entry.name);
    if (!match) continue;
    const container = join(crew, entry.name);
    const errors: string[] = [];
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      records.push({
        id: match[1]!, container, checkout: join(container, "checkout"), checkout_present: false,
        state: null, role: null, slug: null, branch: null, base_sha: null,
        work_id: null, session_id: null, claim_owned: null,
        artifact_errors: [`${container}: dispatch container is not a real directory`],
      });
      continue;
    }
    const statePath = join(container, "STATE.md");
    const stateSource = safeBoundedText(statePath, errors) ?? "";
    const laneRoot = join(container, "lane");
    const sessionSource = safeBoundedText(join(laneRoot, "session.json"), errors, 64 * 1024);
    const result = readDispatchSessionResult(
      laneRoot, sessionSource, (path) => safeBoundedText(path, errors, 64 * 1024),
    );
    if (sessionSource && !result.path) errors.push(`${join(laneRoot, "session.json")}: result_file path admission rejected`);
    const resultSource = result.source;
    const laneState = resolveDispatchLaneState({ sessionSource, resultSource, legacyStateSource: stateSource }).state;
    const current = stateField(stateSource, "Current task") ?? "";
    const header = /^#\s*Dispatch\s+#\d+\s+-\s+(\S+)\s+(.+)$/m.exec(stateSource);
    const currentMatch = /^#?\d+\s+(\S+)\s+\(([^)]+)\)/.exec(current);
    const context = safeObject(join(container, "context.json"), errors);
    const binding = safeObject(join(container, "control_binding.json"), errors);
    const task = context?.task && typeof context.task === "object" ? context.task : {};
    const control = context?.control && typeof context.control === "object" ? context.control : {};
    records.push({
      id: match[1]!, container, checkout: join(container, "checkout"),
      checkout_present: existsSync(join(container, "checkout")),
      state: laneState,
      role: typeof task.role === "string" && task.role ? task.role : header?.[1] ?? null,
      slug: typeof task.slug === "string" && task.slug ? task.slug : currentMatch?.[1] ?? header?.[2] ?? null,
      branch: typeof task.branch === "string" && task.branch ? task.branch : currentMatch?.[2] ?? null,
      base_sha: typeof task.base_sha === "string" && task.base_sha
        ? task.base_sha : typeof binding?.base_sha === "string" && binding.base_sha ? binding.base_sha : null,
      work_id: typeof control.work_id === "string" && control.work_id
        ? control.work_id : typeof binding?.work_id === "string" && binding.work_id ? binding.work_id : null,
      session_id: typeof control.session_id === "string" && control.session_id
        ? control.session_id : typeof binding?.session_id === "string" && binding.session_id ? binding.session_id : null,
      claim_owned: typeof control.claim_owned === "boolean" ? control.claim_owned : binding ? true : null,
      artifact_errors: errors,
    });
  }
  return records.sort((left, right) => Number(left.id) - Number(right.id));
}

function worktreePaths(gitRoot: string, git: LifecycleGit): Set<string> {
  const listed = git(["worktree", "list", "--porcelain"], gitRoot);
  if (listed.code !== 0) return new Set();
  return new Set(listed.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length).trim()).replace(/\\/g, "/").toLowerCase()));
}

function successfulGateForBranch(pmRoot: string, branch: string, branchTip: string): boolean {
  const results = join(pmRoot, "runtime", "merge_gate", "results");
  const archive = join(pmRoot, "runtime", "merge_gate", "archive");
  let names: string[];
  try { names = readdirSync(results).filter((name) => name.endsWith(".json") && !name.endsWith(".summary.json")).slice(0, 4096); }
  catch { return false; }
  for (const name of names) {
    try {
      const resultPath = join(results, name);
      if (statSync(resultPath).size > 4 * 1024 * 1024) continue;
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      if (result?.status !== "success" || typeof result.request_id !== "string"
        || result.workbench_branch !== branch || result.workbench_tip !== branchTip) continue;
      const requestPath = join(archive, `${result.request_id}.request.json`);
      if (statSync(requestPath).size > 4 * 1024 * 1024) continue;
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      if (request?.request_id === result.request_id
        && request.workbench_branch === branch && request.workbench_tip === branchTip) return true;
    } catch { /* incomplete/malformed evidence is not a successful gate */ }
  }
  return false;
}

function claimLive(pmRoot: string, record: DispatchContainerRecord, nowMs: number): boolean | null {
  if (record.claim_owned === false) return false;
  if (!record.work_id || !record.session_id) return null;
  const claim = safeObject(join(pmRoot, "runtime", "control", "claims", `${record.work_id}.json`), []);
  if (!claim) return false;
  return claim.session_id === record.session_id
    && typeof claim.expires_at === "string" && Date.parse(claim.expires_at) > nowMs;
}

export function inventoryDispatchContainers(options: {
  pmRoot: string;
  gitRoot: string;
  studioBranch: string;
  git: LifecycleGit;
  nowMs?: number;
}): DispatchContainerInventoryEntry[] {
  const worktrees = worktreePaths(options.gitRoot, options.git);
  const studioTip = options.studioBranch
    ? options.git(["rev-parse", "--verify", "-q", `${options.studioBranch}^{commit}`], options.gitRoot)
    : { code: 1, stdout: "" };
  return readDispatchContainerRecords(options.pmRoot).map((record) => {
    const normalizedCheckout = resolve(record.checkout).replace(/\\/g, "/").toLowerCase();
    const worktreeRegistered = worktrees.has(normalizedCheckout);
    let branchPresent: boolean | null = null;
    let branchAhead: number | null = null;
    let landing: BranchLanding = record.branch ? "unknown" : "no-branch";
    if (record.branch) {
      const tip = options.git(["rev-parse", "--verify", "-q", `${record.branch}^{commit}`], options.gitRoot);
      branchPresent = tip.code === 0 && /^[0-9a-f]{40,64}$/.test(tip.stdout.trim());
      if (branchPresent && record.base_sha) {
        const base = options.git(["rev-parse", "--verify", "-q", `${record.base_sha}^{commit}`], options.gitRoot);
        if (base.code === 0) {
          if (base.stdout.trim() === tip.stdout.trim()) {
            branchAhead = 0;
            landing = "no-changes";
          } else {
            const ahead = options.git(["rev-list", "--count", `${base.stdout.trim()}..${tip.stdout.trim()}`], options.gitRoot);
            if (ahead.code === 0 && /^\d+$/.test(ahead.stdout.trim())) branchAhead = Number(ahead.stdout.trim());
          }
        }
      }
      if (branchPresent && successfulGateForBranch(options.pmRoot, record.branch, tip.stdout.trim())) landing = "gated";
      else if (branchPresent && landing !== "no-changes" && studioTip.code === 0) {
        const reachable = options.git(["merge-base", "--is-ancestor", tip.stdout.trim(), studioTip.stdout.trim()], options.gitRoot);
        landing = reachable.code === 0 ? "reachable" : "not-landed";
      } else if (branchPresent === false) landing = "unknown";
    }
    let uncommitted: boolean | null = null;
    if (record.checkout_present && worktreeRegistered) {
      const status = options.git(["status", "--porcelain", "--untracked-files=all"], record.checkout);
      if (status.code === 0) uncommitted = Boolean(status.stdout.trim());
    }
    const liveClaim = claimLive(options.pmRoot, record, options.nowMs ?? Date.now());
    const operationalState = new Set(["WORKING", "REWORK", "REVIEWING", "BLOCKED"]);
    let treatment: ContainerTreatment;
    if (record.artifact_errors.length) treatment = "guard-hold";
    else if (operationalState.has(record.state ?? "") && (record.claim_owned === false || liveClaim === true)) treatment = "active";
    else if (uncommitted === true || (landing === "not-landed" && (branchAhead ?? 1) > 0)) treatment = "unlanded-work";
    else if (landing === "gated" || landing === "no-changes") treatment = "cleanup-ready";
    else treatment = "guard-hold";
    return {
      ...record,
      worktree_registered: worktreeRegistered,
      branch_present: branchPresent,
      branch_ahead: branchAhead,
      branch_landing: landing,
      claim_live: liveClaim,
      uncommitted,
      treatment,
    };
  });
}

export interface LifecycleGitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type LifecycleGitCommand = (args: string[], cwd: string) => LifecycleGitCommandResult;

export interface ReworkIntegrationOptions {
  checkout: string;
  branch: string;
  studioSha: string;
  container: string;
  git: LifecycleGitCommand;
}

export interface ReworkIntegrationResult {
  status: "integrated" | "blocked" | "worker-conflict-route";
  branch: string;
  conflicts: string[];
}

export interface ResumeTransitionResult {
  statePath: string;
  previousState: string;
  publishedState: string;
  markerPath: string;
  previousMarker: string | null;
}

export interface OwnedDiscardInput {
  repositoryOwned: boolean;
  pathsOwned: boolean;
  historyRewrite: boolean;
}

export interface SiblingAuthorityInput {
  dispatchId: string;
  workId: string;
  sessionId: string;
  records: readonly DispatchContainerRecord[];
}

/**
 * The production lifecycle surface. Callers do not verify evidence after an
 * unrelated mutation: they invoke these callables to perform or authorize the
 * transition itself. Tests may replace one callable with a no-op and inspect
 * the resulting files/refs, which makes each counterfactual independent from a
 * verifier or assertion.
 */
export interface DispatchContainerLifecycle {
  continueRework(options: ReworkIntegrationOptions): ReworkIntegrationResult;
  resume(container: string): ResumeTransitionResult;
  landCleanup<T>(apply: () => T): T;
  authorizeOwnedDiscard(input: OwnedDiscardInput): boolean;
  preserveSiblingAuthority(input: SiblingAuthorityInput): boolean;
  consumeAbort(container: string): boolean;
}

export function dispatchContainerState(container: string): string {
  const source = readFileSync(join(container, "STATE.md"), "utf8");
  return stateField(source, "Status") ?? "";
}

export function writeDispatchContainerState(container: string, status: string): void {
  const path = join(container, "STATE.md");
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024) {
    throw new Error(`dispatch STATE.md is not a bounded regular file: ${path}`);
  }
  const source = readFileSync(path, "utf8");
  const pattern = /(^##\s*Status\s*\r?\n(?:\r?\n)*)([^\r\n]+)/m;
  if (!pattern.test(source)) throw new Error(`dispatch STATE.md has no writable Status field: ${path}`);
  writeFileSync(path, source.replace(pattern, `$1${status}`));
}

function conflictsFrom(result: LifecycleGitCommandResult): string[] {
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
}

function blockRework(container: string, detail: string): ReworkIntegrationResult {
  writeFileSync(join(container, "questions.md"), `# Rework base integration blocked\n\n${detail}\n`);
  writeDispatchContainerState(container, "BLOCKED");
  return { status: "blocked", branch: "", conflicts: [] };
}

export function continueReworkOnSameBranch(options: ReworkIntegrationOptions): ReworkIntegrationResult {
  const branchBefore = options.git(["branch", "--show-current"], options.checkout);
  if (branchBefore.code !== 0 || branchBefore.stdout.trim() !== options.branch) {
    throw new Error("rework checkout is not on its bound workbench branch");
  }
  if (!existsSync(join(options.container, "review.md"))) {
    throw new Error("rework container is missing the review.md trigger");
  }

  const mergeHead = options.git(["rev-parse", "--verify", "-q", "MERGE_HEAD"], options.checkout);
  if (mergeHead.code === 0 && mergeHead.stdout.trim()) {
    const conflicts = conflictsFrom(options.git(["diff", "--name-only", "--diff-filter=U"], options.checkout));
    if (conflicts.length > 0) {
      if (existsSync(join(options.container, "answers.md"))) {
        return { status: "worker-conflict-route", branch: options.branch, conflicts };
      }
      const result = blockRework(
        options.container,
        `Resolve the existing studio integration conflicts on this same branch after answers.md resumes the Worker: ${conflicts.join(", ")}`,
      );
      return { ...result, branch: options.branch, conflicts };
    }
    if (dispatchContainerState(options.container) === "BLOCKED" && !existsSync(join(options.container, "answers.md"))) {
      return { ...blockRework(options.container, "The interrupted studio merge is resolved but answers.md is required before resuming it."), branch: options.branch };
    }
    const committed = options.git(["commit", "--no-edit"], options.checkout);
    if (committed.code !== 0) {
      return { ...blockRework(options.container, `Could not finish the interrupted studio merge: ${committed.stderr.trim() || `git exited ${committed.code}`}`), branch: options.branch };
    }
  } else {
    const ancestor = options.git(["merge-base", "--is-ancestor", options.studioSha, "HEAD"], options.checkout);
    if (ancestor.code !== 0) {
      const merged = options.git(["merge", "--no-edit", options.studioSha], options.checkout);
      if (merged.code !== 0) {
        const conflicts = conflictsFrom(options.git(["diff", "--name-only", "--diff-filter=U"], options.checkout));
        if (conflicts.length === 0) {
          throw new Error(`Studio integration failed without a conflict set: ${merged.stderr.trim() || `git exited ${merged.code}`}`);
        }
        const result = blockRework(
          options.container,
          `Studio integration conflicts require Worker resolution on this same branch after answers.md: ${conflicts.join(", ")}`,
        );
        return { ...result, branch: options.branch, conflicts };
      }
    }
  }

  const branchAfter = options.git(["branch", "--show-current"], options.checkout);
  if (branchAfter.code !== 0 || branchAfter.stdout.trim() !== options.branch) {
    throw new Error("rework integration changed the bound workbench branch");
  }
  const ancestorAfter = options.git(["merge-base", "--is-ancestor", options.studioSha, "HEAD"], options.checkout);
  if (ancestorAfter.code !== 0) throw new Error("rework integration did not make studio an ancestor of the workbench tip");
  return { status: "integrated", branch: options.branch, conflicts: [] };
}

export function resumeDispatchContainer(container: string): ResumeTransitionResult {
  const current = dispatchContainerState(container);
  if (current === "BLOCKED" && !existsSync(join(container, "answers.md"))) {
    throw new Error("BLOCKED container resume requires the existing answers.md trigger");
  }
  if (current !== "REWORK" && current !== "BLOCKED" && current !== "REPORTING" && current !== "WORKING") {
    throw new Error(`container is not resumable from state ${current || "<missing>"}`);
  }
  const statePath = join(container, "STATE.md");
  const markerPath = join(container, "resumed_at");
  const previousState = readFileSync(statePath, "utf8");
  const previousMarker = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null;
  writeDispatchContainerState(container, "WORKING");
  const publishedState = readFileSync(statePath, "utf8");
  writeFileSync(markerPath, `${Math.floor(Date.now() / 1000)}\n`);
  return { statePath, previousState, publishedState, markerPath, previousMarker };
}

export function consumeDispatchAbort(container: string): boolean {
  if (!existsSync(join(container, "abort.md"))) return false;
  if (dispatchContainerState(container) !== "ABORTED") writeDispatchContainerState(container, "ABORTED");
  return true;
}

export const DISPATCH_CONTAINER_LIFECYCLE: DispatchContainerLifecycle = {
  continueRework: continueReworkOnSameBranch,
  resume: resumeDispatchContainer,
  landCleanup: <T>(apply: () => T): T => apply(),
  authorizeOwnedDiscard: (input) => input.repositoryOwned && input.pathsOwned && !input.historyRewrite,
  preserveSiblingAuthority: (input) => input.records.some((record) => record.id !== input.dispatchId
    && record.work_id === input.workId && record.session_id === input.sessionId && record.claim_owned !== false),
  consumeAbort: consumeDispatchAbort,
};
