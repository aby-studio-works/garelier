import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";
import { sha256 } from "./serialization.ts";
import { validateGateEvidence } from "./evidence_validation.ts";
import type { BacklogRecord, PlanGraphControlModel } from "./plan_graph_types.ts";
import { planGraphEvidenceReferences } from "./plan_graph_write.ts";
import type { ControlFinding, EvidenceReference } from "./types.ts";

const GIT = requireRuntimeExecutable("git");
const GIT_TIMEOUT_MS = 30_000;

export interface GitHistoryEntry {
  commit: string;
  message: string;
}

export interface GitInspector {
  commitExists(commit: string): boolean;
  isReachable(commit: string, from: string): boolean;
  message(commit: string): string;
  history(from: string): GitHistoryEntry[];
}

export interface ReconcileOptions {
  git?: GitInspector;
  historyRef?: string;
}

function runGit(root: string, args: string[]) {
  const result = spawnSync(GIT, ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT") throw new Error(`git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`);
  if (error) throw new Error(`git ${args.join(" ")} spawn failed: ${error.message}`);
  if (result.signal) throw new Error(`git ${args.join(" ")} terminated by signal ${result.signal}`);
  if (result.status === null) throw new Error(`git ${args.join(" ")} ended without an exit status`);
  return result;
}

function gitRun(root: string, args: string[], allowFailure = false): string {
  const result = runGit(root, args);
  if (result.status !== 0) {
    if (allowFailure) return "";
    throw new Error(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

export function nativeGitInspector(targetRoot: string): GitInspector {
  return {
    commitExists: (commit) => Boolean(gitRun(targetRoot, ["cat-file", "-e", `${commit}^{commit}`], true) || gitRun(targetRoot, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], true)),
    isReachable: (commit, from) => {
      const args = ["merge-base", "--is-ancestor", commit, from];
      const result = runGit(targetRoot, args);
      if (result.status === 0) return true;
      if (result.status === 1) return false;
      throw new Error(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
    },
    message: (commit) => gitRun(targetRoot, ["show", "-s", "--format=%B", commit]),
    history: (from) => {
      const source = gitRun(targetRoot, ["log", "--format=%H%x1f%B%x1e", from]);
      return source.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
        const split = record.indexOf("\x1f");
        return { commit: record.slice(0, split), message: record.slice(split + 1) };
      });
    },
  };
}

function finding(severity: ControlFinding["severity"], code: string, entity: string | null, path: string | null, field: string | null, message: string, suggested: string | null = null): ControlFinding {
  return { severity, code, entity, path, field, message, suggested_command: suggested };
}

function safeEvidencePath(root: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const candidate = resolve(root, ...path.split("/"));
  const rel = relative(resolve(root), candidate);
  return !rel.startsWith("..") && !isAbsolute(rel) ? candidate : null;
}

function trailers(message: string): { pmId: string; actor: string; item: string }[] {
  return message.split(/\r?\n/).flatMap((line) => {
    const match = /^Garelier:\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pmId: match[1]!, actor: match[2]!, item: match[3]!.trim() }] : [];
  });
}

interface ReconcileRoots {
  targetRoot: string;
  controlRoot: string;
}

function validatePathEvidence(model: ReconcileRoots, entity: string, evidence: EvidenceReference, out: ControlFinding[], git?: GitInspector, historyRef = "HEAD"): void {
  if (evidence.kind === "gate") {
    out.push(...validateGateEvidence(model, entity, evidence, { git, historyRef }));
    return;
  }
  if (!evidence.path) return;
  const root = evidence.root === "target" ? model.targetRoot : model.controlRoot;
  const absolute = safeEvidencePath(root, evidence.path);
  const field = `evidence.${evidence.kind}.path`;
  if (!absolute) {
    out.push(finding("error", "reconcile-evidence-path-unsafe", entity, evidence.path, field, "evidence path is absolute or traverses its declared root"));
    return;
  }
  if (!existsSync(absolute)) {
    out.push(finding("error", "reconcile-evidence-path-missing", entity, evidence.path, field, "evidence path does not exist as a regular file"));
    return;
  }
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isFile()) {
    out.push(finding("error", "reconcile-evidence-path-missing", entity, evidence.path, field, "evidence path does not exist as a regular file"));
    return;
  }
  if (info.size > 2 * 1024 * 1024) {
    out.push(finding("error", "reconcile-evidence-too-large", entity, evidence.path, field, "evidence file exceeds the 2097152-byte reconcile cap"));
    return;
  }
  let source: Buffer;
  try { source = readFileSync(absolute); }
  catch (error) {
    out.push(finding("error", "reconcile-evidence-read-failed", entity, evidence.path, field, `evidence cannot be read: ${(error as Error).message}`));
    return;
  }
  if (evidence.content_hash && sha256(source) !== evidence.content_hash) {
    out.push(finding("error", "reconcile-evidence-content-mismatch", entity, evidence.path, field, `evidence content does not match ${evidence.content_hash}`));
    return;
  }
}


export function reconcilePlanGraphGit(
  model: PlanGraphControlModel,
  options: ReconcileOptions & { targetRoot: string; pmId: string },
): ControlFinding[] {
  const out: ControlFinding[] = [];
  const historyRef = options.historyRef ?? "HEAD";
  const roots = { targetRoot: options.targetRoot, controlRoot: model.controlRoot };
  let git: GitInspector;
  let history: GitHistoryEntry[];
  try { git = options.git ?? nativeGitInspector(options.targetRoot); history = git.history(historyRef); }
  catch (error) { return [finding("error", "reconcile-git-unavailable", options.pmId, null, null, `git history cannot be read: ${(error as Error).message}`)]; }
  const messageCache = new Map<string, string>();
  for (const work of [...model.backlog.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    let evidence: EvidenceReference[];
    try { evidence = planGraphEvidenceReferences(work); }
    catch (error) {
      out.push(finding("error", "reconcile-evidence-refs-invalid", work.id, work.path, "evidence_refs", (error as Error).message));
      continue;
    }
    const commits = [...new Set(evidence.filter((item) => item.kind === "commit" && item.commit).map((item) => item.commit!))].sort();
    if (work.status === "done" && commits.length === 0) {
      out.push(finding("error", "reconcile-done-implementation-commit-missing", work.id, work.path, "evidence_refs", "done Backlog has no implementation commit evidence"));
    }
    const terminal = ["done", "cancelled", "superseded"].includes(work.status);
    if (terminal !== work.path.startsWith("backlog/archive/")) {
      out.push(finding("error", "reconcile-backlog-storage-state-mismatch", work.id, work.path, "status", `Backlog ${work.status} does not match its canonical open/archive path`));
    }
    for (const commit of commits) {
      if (!git.commitExists(commit)) {
        out.push(finding("error", "reconcile-commit-missing", work.id, work.path, "evidence_refs.commit", `commit does not exist: ${commit}`));
        continue;
      }
      if (!git.isReachable(commit, historyRef)) out.push(finding("error", "reconcile-commit-unreachable", work.id, work.path, "evidence_refs.commit", `commit ${commit} is not reachable from ${historyRef}`));
      let message = messageCache.get(commit);
      if (message === undefined) { message = git.message(commit); messageCache.set(commit, message); }
      const parsed = trailers(message);
      if (!parsed.length) out.push(finding("error", "reconcile-trailer-missing", work.id, work.path, "evidence_refs.commit", `commit ${commit} has no Garelier trailer`));
      else if (!parsed.some((trailer) => trailer.pmId === options.pmId && trailer.item.split(/\s+/).includes(work.id))) {
        out.push(finding("error", "reconcile-trailer-work-mismatch", work.id, work.path, "evidence_refs.commit", `commit ${commit} trailer does not bind ${options.pmId}/${work.id}`));
      }
    }
    for (const item of evidence) validatePathEvidence(roots, work.id, item, out, git, historyRef);
    let reports: string[] = [];
    try { reports = reportReferences(work); }
    catch (error) {
      out.push(finding("error", "reconcile-report-refs-invalid", work.id, work.path, "report_refs", (error as Error).message));
    }
    for (const path of reports) {
      validatePathEvidence(roots, work.id, {
        kind: "report",
        root: "control",
        path,
        observed_at: work.updated,
        writer: "control",
        summary: path,
      }, out);
    }
  }
  for (const entry of history) {
    for (const trailer of trailers(entry.message)) {
      if (trailer.pmId !== options.pmId) continue;
      for (const workId of trailer.item.match(/\bW-\d+\b/g) ?? []) {
        const work = model.backlog.get(workId);
        if (work && !["done", "cancelled", "superseded"].includes(work.status)) {
          out.push(finding("warning", "reconcile-merged-trailer-open-work", workId, work.path, "status", `reachable commit ${entry.commit} binds open Backlog ${workId}`));
        }
      }
    }
  }
  return out.sort((a, b) => `${a.severity}\0${a.code}\0${a.entity ?? ""}\0${a.path ?? ""}`.localeCompare(`${b.severity}\0${b.code}\0${b.entity ?? ""}\0${b.path ?? ""}`));
}

function reportReferences(work: BacklogRecord): string[] {
  const value = work.frontmatter.report_refs;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Backlog ${work.id} report_refs must be an array of paths`);
  }
  return value as string[];
}
