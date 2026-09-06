// The gate run's own record of WHERE it ran and WHAT the tree was, written by
// gate_runner.ts into the PM runtime tree beside the step ledger (W-710).
//
// The facts a review needs about a run — its id, its cwd, and the commit the
// checkout resolved to before the first step and after the last one — used to
// exist only as prose in the log: `review_prepare` recovered the run id with a
// `GATE_START run_id=` regex over a producer-writable file, and the "did the
// checkout move under the gate" question (blueprint w613 P-9 / W-571) had no
// answer at all, because the proposed `GATE_START head=` / `GATE_HEAD_END`
// markers would have been more prose for the same parser to guess at. #394
// spent r34..r40 on exactly that class of mismatch.
//
// A record is one JSON object per run log: typed fields, no parser, and a digest
// the Dock seal can bind. A second run over the same log REPLACES it, so "the
// run this log ends with" has one answer even when two runs were appended
// (#394 r32 / #538 r12).
//
// It does NOT live beside the log. A log path is chosen by the caller and may
// sit INSIDE the very tree the gate measures; an untracked sibling there makes
// `gate step identity requires a clean checkout` fail on the next run, which is
// a gate turning itself RED with its own evidence. The step ledger already
// solved this by living under the PM runtime root, so the record lives there
// too — which also puts it outside every producer-writable root, like the Dock
// review record it is sealed into.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertSafeLeaf, writeGuardedFileSync } from "../guard/path_guard.ts";

export const GATE_RUN_RECORD_KIND = "garelier_gate_run";
export const GATE_RUN_RECORD_GENERATOR = "gate_runner.ts";

const MAX_RECORD_BYTES = 256 * 1024;

export interface GateRunRecord {
  schema_version: 1;
  kind: typeof GATE_RUN_RECORD_KIND;
  generated_by: typeof GATE_RUN_RECORD_GENERATOR;
  run_id: string;
  started_at: string;
  ended_at: string;
  /** The directory the steps ran in, absolute and POSIX-slashed. */
  cwd: string;
  /** `git rev-parse HEAD` in `cwd` BEFORE the first step. "" when the probe
   * could not resolve a commit (a non-repository cwd, e.g. a fixture). */
  start_head: string;
  /** The same probe AFTER the last step. A difference from `start_head` means
   * the tree moved under the run, so nothing it measured describes one commit. */
  end_head: string;
  status: string;
  exit: number;
  /** The run log this record belongs to, absolute and POSIX-slashed. */
  log: string;
}

/** The record's home: the PM runtime tree's gate root, the same place
 * `defaultStepLedgerPath` puts the step ledger. Named for the log it describes
 * plus a digest of that log's full path, so two logs that share a basename
 * cannot share a record. One spelling for the writer and every reader. */
export function gateRunRecordPath(project: string, pmId: string, logPath: string): string {
  const log = resolve(logPath).replace(/\\/g, "/");
  const digest = createHash("sha256").update(log).digest("hex").slice(0, 12);
  return join(resolve(project), "__garelier", pmId, "runtime", "gate", "run_records", `${basename(log)}.${digest}.json`);
}

export interface WriteGateRunRecordInput {
  /** Destination, from `gateRunRecordPath`. Passed in rather than derived so a
   * runner never has to know the PM identity to write its own evidence. */
  path: string;
  logPath: string;
  runId: string;
  startedAt: string;
  endedAt: string;
  cwd: string;
  startHead: string;
  endHead: string;
  status: string;
  exit: number;
}

export function writeGateRunRecord(input: WriteGateRunRecordInput): string {
  const path = resolve(input.path);
  const record: GateRunRecord = {
    schema_version: 1,
    kind: GATE_RUN_RECORD_KIND,
    generated_by: GATE_RUN_RECORD_GENERATOR,
    run_id: input.runId,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    cwd: resolve(input.cwd).replace(/\\/g, "/"),
    start_head: input.startHead,
    end_head: input.endHead,
    status: input.status,
    exit: input.exit,
    log: resolve(input.logPath).replace(/\\/g, "/"),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeGuardedFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "gate run record");
  return path;
}

/** Null when no record exists at this path, or it is not the canonical shape.
 * Both mean the same thing to a reader: this run stated nothing about its own
 * tree, so nothing may be concluded from its absence of complaint. */
export function readGateRunRecord(path: string): GateRunRecord | null {
  if (!existsSync(path)) return null;
  let parsed: Record<string, unknown>;
  try {
    const safe = assertSafeLeaf(path, "gate run record");
    const info = lstatSync(safe);
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null;
    parsed = JSON.parse(readFileSync(safe, "utf8")) as Record<string, unknown>;
  } catch { return null; }
  if (parsed.schema_version !== 1 || parsed.kind !== GATE_RUN_RECORD_KIND
    || parsed.generated_by !== GATE_RUN_RECORD_GENERATOR) return null;
  const strings = ["run_id", "started_at", "ended_at", "cwd", "start_head", "end_head", "status", "log"] as const;
  if (strings.some((field) => typeof parsed[field] !== "string")) return null;
  if (typeof parsed.exit !== "number" || !Number.isInteger(parsed.exit)) return null;
  return parsed as unknown as GateRunRecord;
}
