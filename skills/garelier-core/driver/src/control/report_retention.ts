import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { atomicWriteRuntimeFile, assertNoSymlinkPath, assertPathInside, assertSafeRelativePath } from "./diagnostics.ts";
import { canonicalJson, sha256 } from "./serialization.ts";
import { acquireNamespaceLock, resolveControlNamespace } from "./transaction.ts";
import { summarizePmStepGateLog } from "../dispatch/gate_step_artifacts.ts";
import {
  evaluatePreservationAdmission,
  preservationAdmissionBytes,
  preservedEvidenceSourceIdentity,
} from "../dispatch/preservation_admission.ts";

const RETAINED_MARKER = "PM_STEP_LOG_SUMMARY";
const SHA_LINE = /^SHA256 ([0-9a-f]{64})$/m;
const BYTE_LINE = /^BYTE_LENGTH ([0-9]+)$/m;
const RUNTIME_LINE = /^RAW_RUNTIME_PATH (\S+)$/m;

export interface ControlReportRetentionInspection {
  logs: number;
  retained: string[];
  raw: string[];
  bytes: number;
}

function reportLogs(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    assertNoSymlinkPath(root, directory);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      assertPathInside(root, path);
      if (entry.isSymbolicLink()) throw new Error(`control report tree contains a symlink: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (!entry.isFile()) throw new Error(`control report tree contains a non-regular entry: ${path}`);
      else {
        const item = relative(root, path).replaceAll("\\", "/");
        const encoded = preservedEvidenceSourceIdentity(item);
        if (entry.name.endsWith(".log") || (encoded?.sourcePath.endsWith(".log") ?? false)) files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

export function isRetainedControlReportLog(source: string): boolean {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  return lines[0] === RETAINED_MARKER
    && SHA_LINE.test(source)
    && BYTE_LINE.test(source)
    && RUNTIME_LINE.test(source);
}

/** Inspect every tracked Control report log, including encoded preserved
 * payloads whose source identity ends in `.log`; no mutation and no second
 * capacity policy. */
export function inspectControlReportRetention(controlRoot: string): ControlReportRetentionInspection {
  const root = resolve(controlRoot);
  const logsRoot = join(root, "reports");
  const retained: string[] = [];
  const raw: string[] = [];
  let bytes = 0;
  for (const path of reportLogs(logsRoot)) {
    const info = lstatSync(path);
    bytes += info.size;
    const item = relative(root, path).replaceAll("\\", "/");
    if (isRetainedControlReportLog(readFileSync(path, "utf8"))) retained.push(item);
    else raw.push(item);
  }
  return { logs: retained.length + raw.length, retained, raw, bytes };
}

export interface MigrateControlReportLogsOptions {
  project: string;
  targetRoot?: string;
  pmId: string;
  inspectionPath: string;
  apply: boolean;
  now?: Date;
}

export interface MigrateControlReportLogsResult {
  status: "dry_run" | "applied";
  migrated: number;
  before_bytes: number;
  after_bytes: number;
  inspection: string;
  raw_runtime_root: string;
}

/**
 * One-time conversion of historical raw Control gate logs. Complete bytes move
 * to runtime retention; tracked files become the same bounded excerpt + SHA-256
 * form used by current land preservation. A partial crash is replay-safe: an
 * already converted face is skipped and a same-content runtime leaf is reused.
 */
export function migrateControlReportLogs(options: MigrateControlReportLogsOptions): MigrateControlReportLogsResult {
  const project = resolve(options.project);
  const paths = resolveControlNamespace({ targetRoot: resolve(options.targetRoot ?? project), pmId: options.pmId });
  const inspectionRelative = assertSafeRelativePath(options.inspectionPath);
  if (!inspectionRelative.startsWith("inspections/")) {
    throw new Error("migration inspection must be under control/inspections/");
  }
  const before = inspectControlReportRetention(paths.controlRoot);
  const pmRuntimeRoot = dirname(paths.runtimeRoot);
  const runtimeRoot = join(pmRuntimeRoot, "gate", "preserved_raw", "migration");
  const inspection = join(paths.controlRoot, ...inspectionRelative.split("/"));
  const planned = before.raw.map((item) => {
    const sourcePath = join(paths.controlRoot, ...item.split("/"));
    const raw = readFileSync(sourcePath);
    const hash = sha256(raw).replace(/^sha256:/, "");
    const rawPath = join(runtimeRoot, `${hash}-${basename(item)}`);
    const runtimeRelative = relative(project, rawPath).replaceAll("\\", "/");
    const summary = summarizePmStepGateLog(
      raw,
      runtimeRelative,
      `MIGRATION source=${item} raw_sha256=${hash}`,
    );
    return { item, sourcePath, raw, rawPath, summary };
  });
  const beforeBytes = planned.reduce((sum, item) => sum + item.raw.byteLength, 0);
  const afterBytes = planned.reduce((sum, item) => sum + Buffer.byteLength(item.summary, "utf8"), 0);
  const planDigest = sha256(canonicalJson(planned.map((item) => ({
    path: item.item,
    source_hash: sha256(item.raw),
    byte_length: item.raw.byteLength,
  }))));
  const admission = evaluatePreservationAdmission({
    projectRoot: project,
    pmId: options.pmId,
    binding: {
      requestId: "control-report-retention-migration",
      planDigest,
      workId: null,
      dispatchId: null,
    },
    sources: planned.map((item) => ({
      kind: "historical_control_report_log" as const,
      sourcePath: item.item,
      bytes: item.raw,
    })),
  });
  const admissionPath = join(
    pmRuntimeRoot,
    "gate",
    "preservation_admissions",
    `migration-${admission.record_hash.replace(/^sha256:/, "")}.json`,
  );
  const result: MigrateControlReportLogsResult = {
    status: options.apply ? "applied" : "dry_run",
    migrated: planned.length,
    before_bytes: beforeBytes,
    after_bytes: afterBytes,
    inspection: relative(project, inspection).replaceAll("\\", "/"),
    raw_runtime_root: relative(project, runtimeRoot).replaceAll("\\", "/"),
  };
  if (admission.status !== "CLEAN") {
    if (options.apply) {
      atomicWriteRuntimeFile(pmRuntimeRoot, admissionPath, preservationAdmissionBytes(admission));
    }
    const pointers = admission.artifacts.flatMap((artifact) => artifact.findings.map((finding) => finding.redacted_pointer));
    throw new Error(`control report migration security admission rejected; sources retained: ${pointers.join(", ")}`);
  }
  if (!options.apply) return result;
  if (planned.length === 0 && existsSync(inspection)) return result;

  const lock = acquireNamespaceLock(paths, {
    sessionId: `control-report-retention-${process.pid}`,
    operation: "control-report-retention-migration",
    at: (options.now ?? new Date()).toISOString(),
  });
  try {
    const stable = inspectControlReportRetention(paths.controlRoot);
    if (JSON.stringify(stable.raw) !== JSON.stringify(before.raw) || stable.bytes !== before.bytes) {
      throw new Error("control report logs changed after migration planning; rerun the dry-run");
    }
    // Size/list equality is not a security binding: bytes can change in place.
    // Re-authenticate every source against the exact full-byte batch admitted
    // above before creating even the redacted admission record or a raw copy.
    for (const item of planned) {
      if (!readFileSync(item.sourcePath).equals(item.raw)) {
        throw new Error(`control report log changed after security admission: ${item.item}`);
      }
    }
    atomicWriteRuntimeFile(pmRuntimeRoot, admissionPath, preservationAdmissionBytes(admission));
    for (const item of planned) {
      if (existsSync(item.rawPath)) {
        const current = readFileSync(item.rawPath);
        if (!current.equals(item.raw)) throw new Error(`runtime migration collision: ${item.rawPath}`);
      } else {
        atomicWriteRuntimeFile(pmRuntimeRoot, item.rawPath, item.raw);
      }
      atomicWriteRuntimeFile(paths.controlRoot, item.sourcePath, item.summary);
    }
    const completed = inspectControlReportRetention(paths.controlRoot);
    if (completed.raw.length !== 0) throw new Error(`raw Control report logs remain after migration: ${completed.raw.join(", ")}`);
    const generatedAt = (options.now ?? new Date()).toISOString();
    const body = [
      "# Control report retention migration",
      "",
      `- generated_at: ${generatedAt}`,
      `- migrated_files: ${planned.length}`,
      `- before_bytes: ${beforeBytes}`,
      `- after_bytes: ${afterBytes}`,
      `- raw_runtime_root: ${result.raw_runtime_root}`,
      "- retained_format: bounded excerpt + SHA-256 + runtime raw pointer",
      `- security_admission: ${relative(project, admissionPath).replaceAll("\\", "/")}`,
      "",
      "## Migrated paths",
      "",
      ...(planned.length ? planned.map((item) => `- ${item.item}`) : ["- none (already migrated)"]),
      "",
    ].join("\n");
    atomicWriteRuntimeFile(paths.controlRoot, inspection, body);
    return result;
  } finally {
    lock.release();
  }
}
