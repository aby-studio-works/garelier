#!/usr/bin/env bun

// One operator-owned proxy unit: validate the producer COMMIT PLAN against the
// exact dirty set, commit with the authoritative plan message, and bind the
// session-authoritative result. Success is terminal; genuine REWORK resumes are
// explicit PM operations through provider_session.ts.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crewSubdir } from "../workspace.ts";
import {
  PROVIDER_TRANSPORTS,
  isProviderTransport,
  roleBindingFromContext,
  type ProviderTransport,
} from "../dispatch/role_binding.ts";
import { canonicalPath } from "../guard/path_guard.ts";
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
  sessionPath: string;
  initialResultPath: string;
  followupPath: string;
  followupResultPath: string;
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

function jsonFile<T>(path: string, label: string): T {
  if (!existsSync(path)) throw new Error(`dock_proxy: ${label} not found: ${path}`);
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { throw new Error(`dock_proxy: ${label} is not valid JSON: ${path}`); }
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
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
  if (raw.split(/[\\/]+/).includes("..")) {
    throw new Error(`dock_proxy: ready.json ${key} must not contain '..' path segments`);
  }
  const actual = canonicalPath(raw);
  const lexicalExpected = resolve(expected);
  const canonicalExpected = resolve(canonicalLane, basename(lexicalExpected));
  if (!sameCanonicalPath(actual, canonicalExpected)) {
    throw new Error(`dock_proxy: ready.json ${key} does not match the canonical lane path: ${actual}`);
  }
  return canonicalExpected;
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

function registerLeafFor(resolvedContainer: string, transport: ProviderTransport): string {
  return registersInContainerRoot(transport)
    ? join(resolvedContainer, "report.md")
    : join(resolvedContainer, "lane", "result.md");
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
  return registerLeafFor(resolve(container), resolveDockProxyProviderTransport(ready));
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
  const claudeResult = registersInContainerRoot(transport);
  const initialResult = registerLeafFor(resolvedContainer, transport);
  const followupResult = claudeResult ? initialResult : join(lane, "followup.result.md");
  if (!sameCanonicalPath(canonicalContainer, expectedContainer)
    || !sameCanonicalPath(canonicalLane, expectedLane)) {
    throw new Error("dock_proxy: dispatch container/lane must not traverse a symlink or reparse point");
  }
  return {
    lane: canonicalLane,
    sessionPath: canonicalReadyPath(ready, "session_record", join(lane, "session.json"), canonicalLane),
    initialResultPath: canonicalReadyPath(
      ready, "result_file", initialResult, claudeResult ? canonicalContainer : canonicalLane,
    ),
    followupPath: canonicalReadyPath(ready, "resume_instruction_file", join(lane, "followup.md"), canonicalLane),
    followupResultPath: canonicalReadyPath(
      ready, "resume_result_file", followupResult, claudeResult ? canonicalContainer : canonicalLane,
    ),
  };
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
  for (const candidate of [admitted.followupResultPath, admitted.initialResultPath]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `dock_proxy: no admitted producer register exists (${admitted.followupResultPath}; ${admitted.initialResultPath})`,
  );
}

/** The one entry both provider shapes go through: the session record decides
 * when a lane has one, ready.json decides when it structurally cannot. Either
 * way the result is one of the two admitted lane leaves. */
export function resolveDockProxyRegisterPath(
  admitted: DockProxyReadyPaths,
  session: Record<string, any> | null,
): string {
  return session ? resolveDockProxySessionResultPath(session, admitted) : resolveDockProxyReadyRegisterPath(admitted);
}

/** Resolve the exact producer result selected by the canonical session and
 * require it to be one of the two ready.json-admitted lane leaves. */
export function resolveDockProxySessionResultPath(
  session: Record<string, any>,
  admitted: DockProxyReadyPaths,
): string {
  const raw = String(session.result_file ?? "");
  if (!raw) throw new Error("dock_proxy: session result_file is required");
  const resultPath = canonicalPath(raw);
  if (!sameCanonicalPath(resultPath, admitted.initialResultPath)
    && !sameCanonicalPath(resultPath, admitted.followupResultPath)) {
    throw new Error(`dock_proxy: session result_file is not an admitted canonical result path: ${resultPath}`);
  }
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
  const context = jsonFile<Record<string, any>>(resolve(container, "context.json"), "context.json");
  const ready = jsonFile<Record<string, any>>(resolve(container, "ready.json"), "ready.json");
  // ready.json is producer-visible handoff data. Resolve every path through the
  // shared symlink/reparse-aware canonicalizer and require the exact lane-owned
  // destination before any read, commit, or binder receives Dock authority.
  const admitted = admitDockProxyReadyPaths(project, container, ready);
  const { sessionPath } = admitted;
  const session = jsonFile<Record<string, any>>(sessionPath, "session.json");
  if (context.routing?.commit_mode !== "proxy" || ready.commit_mode !== "proxy") {
    throw new Error(`dock_proxy: dispatch #${args.dispatchId} is not canonical proxy mode`);
  }
  if (session.status !== "ready") throw new Error(`dock_proxy: provider session is not ready (status=${String(session.status)})`);
  const binding = roleBindingFromContext(context);
  if (!binding) throw new Error("dock_proxy: context has no canonical role binding");
  const sessionResultPath = resolveDockProxySessionResultPath(session, admitted);
  const resultPath = args.result
    ? (() => {
      const explicit = canonicalPath(args.result);
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
