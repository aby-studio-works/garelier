import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { sha256 } from "./serialization.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";

const MAX_GIT_OUTPUT_BYTES = 512 * 1024;
const MAX_CAPTURED_PATHS = 4_096;

export interface CheckpointGitCapture {
  branch: string;
  head: string;
  workingTree: "clean" | "dirty";
  staged: string[];
  modified: string[];
  untracked: string[];
  statusHash: string;
}

export interface CheckpointGitCaptureOptions {
  excludeRoots?: string[];
}

function git(root: string, args: string[], allowEmpty = false): Buffer {
  const result = spawnSync(requireRuntimeExecutable("git"), ["-C", root, ...args], {
    encoding: null,
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.status !== 0 && !allowEmpty) {
    const detail = Buffer.from(result.stderr ?? []).toString("utf8").trim().slice(0, 240);
    throw new Error(`checkpoint git capture failed (${args.join(" ")}): ${detail || `exit ${result.status}`}`);
  }
  return result.status === 0 ? Buffer.from(result.stdout ?? []) : Buffer.alloc(0);
}

function excludedPrefixes(root: string, excludeRoots: string[]): string[] {
  return excludeRoots.flatMap((excluded) => {
    const candidate = relative(resolve(root), resolve(excluded)).replace(/\\/g, "/").replace(/\/+$/, "");
    return !candidate || candidate === ".." || candidate.startsWith("../") || isAbsolute(candidate) ? [] : [candidate];
  });
}

function nulPaths(output: Buffer, label: string, excluded: string[]): string[] {
  const paths = output.toString("utf8").split("\0").filter(Boolean)
    .map((path) => path.replace(/\\/g, "/"))
    .filter((path) => !excluded.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)));
  if (paths.length > MAX_CAPTURED_PATHS) throw new Error(`checkpoint git capture exceeds ${MAX_CAPTURED_PATHS} ${label} paths`);
  for (const path of paths) {
    if (path.includes("\r") || path.includes("\n") || path.includes("\0")) {
      throw new Error(`checkpoint git capture returned an unsafe ${label} path`);
    }
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

export function captureCheckpointGit(root: string, options: CheckpointGitCaptureOptions = {}): CheckpointGitCapture {
  const excluded = excludedPrefixes(root, options.excludeRoots ?? []);
  const head = git(root, ["rev-parse", "--verify", "HEAD"]).toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error("checkpoint git capture returned an invalid HEAD");
  const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"], true).toString("utf8").trim() || "(detached)";
  const staged = nulPaths(git(root, ["diff", "--cached", "--name-only", "-z"]), "staged", excluded);
  const modified = nulPaths(git(root, ["diff", "--name-only", "-z"]), "modified", excluded);
  const untracked = nulPaths(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]), "untracked", excluded);
  const canonical = JSON.stringify({ branch, head, staged, modified, untracked });
  return {
    branch,
    head,
    workingTree: staged.length || modified.length || untracked.length ? "dirty" : "clean",
    staged,
    modified,
    untracked,
    statusHash: sha256(canonical),
  };
}

export function renderCheckpointGitCapture(capture: CheckpointGitCapture): string {
  const lines = (label: string, values: string[]): string[] => [
    `${label} (${values.length}):`,
    ...(values.length ? values.map((path) => `- \`${path.replace(/`/g, "\\`")}\``) : ["- None."]),
  ];
  return [
    `Branch: \`${capture.branch}\``,
    `HEAD: \`${capture.head}\``,
    `Working tree: \`${capture.workingTree}\``,
    `Status hash: \`${capture.statusHash}\``,
    "",
    ...lines("Staged paths", capture.staged),
    "",
    ...lines("Modified paths", capture.modified),
    "",
    ...lines("Untracked paths", capture.untracked),
  ].join("\n");
}
