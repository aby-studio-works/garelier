import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { renameSync, rmSync } from "../guard/path_guard.ts";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson } from "./serialization.ts";

export type ControlDiagnosticOperation = "transaction" | "generation-recovery" | "session-open" | "session-heartbeat" | "session-close" | "claim" | "claim-release";

export interface ControlDiagnostic {
  schema_version: 1;
  operation: ControlDiagnosticOperation;
  status: "ok" | "error" | "dry_run";
  pm_id: string;
  session_id: string | null;
  at: string;
  control_revision: string | null;
  entity: string | null;
  changed_paths: string[];
  reason: string | null;
  error: { name: string; message: string } | null;
}

export interface AtomicRuntimeWriteHooks {
  afterMovePrevious?(previousPath: string, targetPath: string): void;
}

export interface DiagnosticWriteResult {
  path: string | null;
  error: string | null;
}

export function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new Error(`${label} contains unsafe characters: ${value}`);
}

export function assertSafeRelativePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) throw new Error(`unsafe relative path: ${path}`);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe relative path: ${path}`);
  return parts.join("/");
}

export function assertPathInside(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`path escapes namespace root: ${candidate}`);
}

export function assertNoSymlinkPath(root: string, candidate: string, includeCandidate = true): void {
  const base = resolve(root);
  const target = resolve(candidate);
  assertPathInside(base, target);
  const rel = relative(base, target);
  const parts = rel ? rel.split(/[\\/]/) : [];
  let cursor = base;
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink path is forbidden: ${cursor}`);
  const limit = includeCandidate ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < limit; index++) {
    cursor = join(cursor, parts[index]!);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink path is forbidden: ${cursor}`);
  }
}

export function ensureSafeDirectory(root: string, directory: string): void {
  const base = resolve(root);
  const target = resolve(directory);
  assertPathInside(base, target);
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  if (lstatSync(base).isSymbolicLink() || !lstatSync(base).isDirectory()) throw new Error(`runtime root must be a real directory: ${base}`);
  const rel = relative(base, target);
  let cursor = base;
  for (const part of rel ? rel.split(/[\\/]/) : []) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`runtime directory must be a real directory: ${cursor}`);
  }
}

export function atomicWriteRuntimeFile(runtimeRoot: string, path: string, source: string, hooks?: AtomicRuntimeWriteHooks): void {
  const target = resolve(path);
  assertPathInside(runtimeRoot, target);
  assertNoSymlinkPath(runtimeRoot, target, false);
  ensureSafeDirectory(runtimeRoot, dirname(target));
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile())) throw new Error(`runtime target must be a regular file: ${target}`);
  const artifact = basename(target);
  const temporary = join(dirname(target), `.${artifact}.${randomUUID()}.tmp`);
  const previous = join(dirname(target), `.${artifact}.${randomUUID()}.previous`);
  let movedPrevious = false;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, source, "utf8"); } finally { closeSync(descriptor); }
    if (existsSync(target)) {
      renameSync(target, previous);
      movedPrevious = true;
      hooks?.afterMovePrevious?.(previous, target);
    }
    renameSync(temporary, target);
    if (movedPrevious) rmSync(previous, { force: true });
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    if (movedPrevious && existsSync(previous)) {
      if (existsSync(target)) rmSync(target, { force: true });
      renameSync(previous, target);
    }
    throw error;
  }
}

export function writeControlDiagnostic(runtimeRoot: string, diagnostic: ControlDiagnostic): DiagnosticWriteResult {
  try {
    ensureSafeDirectory(runtimeRoot, join(runtimeRoot, "diagnostics"));
    const stamp = diagnostic.at.replace(/[^0-9A-Za-z]/g, "");
    const filename = `${stamp}-${process.pid}-${randomUUID()}.json`;
    const path = join(runtimeRoot, "diagnostics", filename);
    atomicWriteRuntimeFile(runtimeRoot, path, canonicalJson(diagnostic));
    return { path, error: null };
  } catch (error) {
    return { path: null, error: error instanceof Error ? error.message : String(error) };
  }
}
