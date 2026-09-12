// The single append point for the incidents.jsonl stream shared by command_guard
// and the runtime recovery hook.
//
// WHY IT COALESCES. Every writer here records a CAUSE the PM has to adjudicate,
// but each one fires per occurrence — and the occurrences of one unresolved cause
// are unbounded. A single mis-located dispatch record was re-rejected on every
// guard invocation for ten days: 103,214 byte-identical records, 95 MB, and a PM
// actionable list in which one cause displaced everything else. Recording the same
// cause in full N times adds no information after the first; the volume itself is
// the only new fact, and a counter carries that.
//
// SO: the FIRST occurrence of a cause is written in full to incidents.jsonl (the
// evidence is never summarised away), and every later occurrence updates a tally
// beside it — count, first seen, last seen. The stream therefore grows with the
// number of DISTINCT causes, and readers that count its records are counting
// causes. A genuinely different record_path, reason, rule, or command is a
// different key and gets its own full record.
//
// WHAT A COALESCED REPEAT KEEPS, precisely — the earlier wording ("nothing is
// lost") over-claimed. The repeat's own RECORD is not appended; what survives is
// the count, the first and last timestamps, and BOTH ids (the first occurrence's,
// which names the record in the stream, and the most recent one's, which is what a
// caller minted for the occurrence it just saw). What is not kept is the per-repeat
// body — the verbatim command and reason of occurrence N are assumed identical to
// occurrence 1, which is exactly what the key asserts.
//
// Best-effort throughout, exactly like the callers: reporting must never disturb a
// guard verdict or a hook response, so every failure degrades to "append anyway"
// rather than "lose the incident".

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// W-113: the destructive operations in this module (replacing the stream with
// the kept lines, dropping a tally whose record has just been closed) go through
// the shared fence like every other.
import { renameSync, rmSync } from "./path_guard.ts";

export const INCIDENTS_FILE = "incidents.jsonl";
export const INCIDENT_REPEATS_DIR = "incident_repeats";

export interface IncidentRepeatTally {
  schema: "garelier.incident-repeat";
  version: 1;
  repeat_key: string;
  kind: string;
  /** The id of the FIRST occurrence — the one whose full record is in the stream. */
  incident_id: string;
  /**
   * The id of the MOST RECENT occurrence. A repeat is not appended to the stream,
   * so its caller-minted id would otherwise name nothing: the recovery hook tells
   * an agent to "review incidents.jsonl for <id>" using a freshly minted id on
   * every failure, and only the first of those is ever written there. Keeping the
   * latest id here means every id a caller emits resolves to a real record — the
   * first occurrence in the stream, this tally for the rest.
   */
  last_incident_id: string;
  count: number;
  first_at: string;
  last_at: string;
}

/**
 * The identity of a CAUSE. Callers pass the fields that make two occurrences the
 * same problem — never a timestamp, an incident id, or anything else that is
 * unique per occurrence, or the coalescing silently does nothing.
 */
export function incidentRepeatKey(kind: string, parts: readonly unknown[]): string {
  const material = [kind, ...parts.map((part) => (part === undefined || part === null ? "" : String(part)))].join("\0");
  return `${kind}:${createHash("sha1").update(material).digest("hex").slice(0, 32)}`;
}

function tallyPath(dir: string, repeatKey: string): string {
  return join(dir, INCIDENT_REPEATS_DIR, `${repeatKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

function readTally(path: string): IncidentRepeatTally | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as IncidentRepeatTally;
    if (value.schema !== "garelier.incident-repeat" || !Number.isInteger(value.count) || value.count <= 0) return null;
    // A tally written before `last_incident_id` existed still identifies its cause;
    // fall back to the first occurrence's id rather than discarding the count.
    return { ...value, last_incident_id: value.last_incident_id || value.incident_id };
  } catch { return null; }
}

/**
 * Append one incident, coalescing repeats of the same cause.
 *
 * Returns "recorded" when the full record was written (a cause seen for the first
 * time) and "coalesced" when only the tally advanced. A caller that cannot supply
 * a stable key passes none and gets the previous unconditional-append behaviour.
 */
export function appendIncident(
  dir: string,
  record: Record<string, unknown>,
  repeatKey?: string,
): "recorded" | "coalesced" {
  const at = typeof record.created_at === "string" ? record.created_at : new Date().toISOString();
  const write = (): "recorded" => {
    appendFileSync(join(dir, INCIDENTS_FILE), `${JSON.stringify(repeatKey ? { ...record, repeat_key: repeatKey } : record)}\n`);
    return "recorded";
  };
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!repeatKey) return write();
  const path = tallyPath(dir, repeatKey);
  const existing = readTally(path);
  const incidentId = typeof record.incident_id === "string" ? record.incident_id : "";
  const tally: IncidentRepeatTally = existing
    ? { ...existing, count: existing.count + 1, last_at: at, last_incident_id: incidentId || existing.last_incident_id }
    : {
      schema: "garelier.incident-repeat", version: 1, repeat_key: repeatKey,
      kind: typeof record.kind === "string" ? record.kind : "unknown",
      incident_id: incidentId,
      last_incident_id: incidentId,
      count: 1, first_at: at, last_at: at,
    };
  try {
    const repeatsDir = join(dir, INCIDENT_REPEATS_DIR);
    if (!existing && !existsSync(repeatsDir)) mkdirSync(repeatsDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(tally, null, 2)}\n`);
  } catch {
    // The tally is the ONLY thing that makes a repeat safe to drop. If it cannot
    // be written, fall back to recording the occurrence in full rather than
    // losing it.
    return write();
  }
  return existing ? "coalesced" : write();
}

/** Every recorded tally under one runtime dir, keyed by repeat_key. */
export function readIncidentRepeats(dir: string): Map<string, IncidentRepeatTally> {
  const out = new Map<string, IncidentRepeatTally>();
  const root = join(dir, INCIDENT_REPEATS_DIR);
  if (!existsSync(root)) return out;
  let names: string[];
  try { names = readdirSync(root).filter((name) => name.endsWith(".json")); } catch { return out; }
  for (const name of names) {
    const tally = readTally(join(root, name));
    if (tally) out.set(tally.repeat_key, tally);
  }
  return out;
}

/** Total occurrences behind a set of recorded incidents — the volume a coalesced
 * stream no longer carries as line count. Records without a repeat_key count once. */
export function totalOccurrences(
  records: ReadonlyArray<{ repeat_key?: unknown }>,
  repeats: ReadonlyMap<string, IncidentRepeatTally>,
): number {
  let total = 0;
  for (const record of records) {
    const key = typeof record.repeat_key === "string" ? record.repeat_key : "";
    total += (key ? repeats.get(key)?.count : undefined) ?? 1;
  }
  return total;
}

// ── resolution (W-758 形 1) ───────────────────────────────────────────────────
//
// Until now this module could only APPEND. Every record therefore carried
// `status: "open"` for as long as the file existed, while the recovery hook told
// each agent to "recover before continuing" — an instruction with no operation
// behind it. 163 records were open on 2026-09-06, the oldest from 2026-08-17.
//
// The missing half is deliberately small and deliberately MANUAL: a person reads
// the record, decides it is dealt with, and says so with a reason. Nothing here
// resolves anything by itself — an automatic resolver would only reproduce the
// present state, where the stream says "open" and means nothing (user 2026-09-06:
// 機械化は告知まで、判断と自動修復は人に残す).

export const RESOLVED_DIR = "resolved";

/** One resolved record as it is written to `resolved/incidents.jsonl`: the
 * original record verbatim, plus who/when/why and the occurrence count the tally
 * was carrying, so dropping the tally loses no measurement. */
export interface ResolvedIncidentRecord extends Record<string, unknown> {
  status: "resolved";
  resolved_at: string;
  resolved_reason: string;
  occurrences: number;
}

export interface IncidentResolution {
  resolved: ResolvedIncidentRecord[];
  /** Ids that matched no record in this dir — named, never silently counted as done. */
  unmatched: string[];
  /** Records still in `incidents.jsonl` after this call. */
  remaining: number;
  /**
   * Tally files whose record was closed but which could not be deleted (a fence
   * refusal, a permission error). NOT swallowed: a tally that outlives its record
   * keeps advancing a count for a cause an operator has already closed, and the
   * next occurrence of it coalesces into a closed cause instead of opening a new
   * record. Surfaced so the person who ran the command can delete it by hand.
   */
  orphaned_tallies: string[];
}

/**
 * Resolve incidents BY ID: move their records out of `incidents.jsonl` into
 * `resolved/incidents.jsonl` with a human reason attached.
 *
 * An id may name either the first occurrence (whose full record is in the
 * stream) or the most recent occurrence of a coalesced cause (whose id lives in
 * the tally). Both are accepted, because both are ids the machinery has printed
 * at an agent — the recovery hook mints a fresh one per failure and names it in
 * the message, and only the first of those is ever a line in the stream.
 *
 * The tally is deleted with the record it belongs to: its count is folded into
 * `occurrences` first, so the volume survives, and a LATER occurrence of the
 * same cause then starts a fresh full record rather than silently advancing the
 * count of something an operator has already closed.
 *
 * CONCURRENCY. The stream is rewritten (kept lines only) and the rewrite is
 * atomic — a temp file in the same directory, then a rename — so a reader never
 * sees a half-written stream and a crash mid-resolve leaves the original intact.
 * What atomicity cannot give back is an APPEND that lands between the read and
 * the rename: `appendIncident` opens the file by name, so that record is written
 * to the file being replaced and is lost. That is an operational rule, not a
 * lock: run this when no lane is appending, which the CLI help and the recovery
 * hook's message both say.
 */
export function resolveIncidents(
  dir: string,
  ids: readonly string[],
  reason: string,
  now: () => Date = () => new Date(),
): IncidentResolution {
  if (!reason.trim()) throw new Error("incident resolve: --reason is required (a resolution with no reason is not one)");
  const wanted = new Set(ids);
  if (wanted.size === 0) throw new Error("incident resolve: at least one incident id is required");
  const streamPath = join(dir, INCIDENTS_FILE);
  const raw = existsSync(streamPath) ? readFileSync(streamPath, "utf8") : "";
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const repeats = readIncidentRepeats(dir);
  const at = now().toISOString();
  const kept: string[] = [];
  const resolved: ResolvedIncidentRecord[] = [];
  const matchedIds = new Set<string>();
  const matchedKeys = new Set<string>();
  for (const line of lines) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; }
    catch { kept.push(line); continue; } // an unparseable line is not a record to close
    const incidentId = typeof record.incident_id === "string" ? record.incident_id : "";
    const repeatKey = typeof record.repeat_key === "string" ? record.repeat_key : "";
    const tally = repeatKey ? repeats.get(repeatKey) : undefined;
    const namedBy = [incidentId, tally?.incident_id ?? "", tally?.last_incident_id ?? ""]
      .filter((id) => id.length > 0).find((id) => wanted.has(id));
    if (!namedBy) { kept.push(line); continue; }
    matchedIds.add(namedBy);
    if (repeatKey) matchedKeys.add(repeatKey);
    resolved.push({
      ...record,
      status: "resolved",
      resolved_at: at,
      resolved_reason: reason,
      occurrences: tally?.count ?? 1,
    });
  }
  const orphanedTallies: string[] = [];
  if (resolved.length > 0) {
    const resolvedDir = join(dir, RESOLVED_DIR);
    mkdirSync(resolvedDir, { recursive: true });
    // The resolved record is durable BEFORE the stream loses it: if the rewrite
    // below never happens, the record is in both files (visible, resolvable
    // again) rather than in neither.
    appendFileSync(join(resolvedDir, INCIDENTS_FILE), `${resolved.map((record) => JSON.stringify(record)).join("\n")}\n`);
    // Atomic rewrite: same directory (so the rename cannot cross a device), then
    // one rename. A reader either sees the whole old stream or the whole new one.
    const temp = `${streamPath}.resolve-${process.pid}-${Date.now()}.tmp`;
    writeFileSync(temp, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    renameSync(temp, streamPath);
    for (const key of matchedKeys) {
      const path = tallyPath(dir, key);
      try { rmSync(path, { force: true }); }
      // Reported, not swallowed: a tally that outlives its closed record keeps
      // counting, and the next occurrence coalesces into a cause nobody is
      // watching any more.
      catch { orphanedTallies.push(path); }
    }
  }
  return {
    resolved,
    unmatched: [...wanted].filter((id) => !matchedIds.has(id)),
    remaining: kept.length,
    orphaned_tallies: orphanedTallies,
  };
}

/** `garelier incident resolve <id…> --reason <text>` — the ONE operation the
 * recovery hook's message names. Kept on this module rather than a new script or
 * bin: the stream's only writer already lives here, so the reader that closes a
 * record cannot look somewhere else than the writer wrote. */
async function main(argv: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "resolve") {
    process.stderr.write(
      "usage: garelier incident resolve <incident-id…> --reason <text>\n"
      + "  Closes the named records: each moves to <runtime dir>/resolved/incidents.jsonl with the\n"
      + "  reason attached, and its repeat tally's count is folded in first.\n"
      + "  Run it when no lane is appending to the stream: the rewrite is atomic, but a record\n"
      + "  appended between the read and the rename is written to the replaced file and lost.\n"
      + "  GARELIER_PM_ID selects the pm whose runtime dir is read when the cwd does not.\n",
    );
    return 2;
  }
  const ids: string[] = [];
  let reason = "";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--reason") { reason = rest[++i] ?? ""; continue; }
    if (arg.startsWith("--")) { process.stderr.write(`incident resolve: unknown option ${arg}\n`); return 2; }
    ids.push(arg);
  }
  // The dir is resolved exactly as the WRITER resolves it (`guardRuntimeDir`),
  // so "where do I close it" can never drift from "where was it written".
  // Imported lazily: command_guard imports this module, and only the CLI needs
  // the dependency back.
  const { guardRuntimeDir } = await import("./command_guard.ts");
  const dir = guardRuntimeDir(process.cwd(), process.env);
  if (!dir) {
    process.stderr.write("incident resolve: no __garelier root resolves from this cwd, so there is no incident stream here\n");
    return 4;
  }
  let outcome: IncidentResolution;
  try { outcome = resolveIncidents(dir, ids, reason); }
  catch (error) { process.stderr.write(`incident resolve: ${(error as Error).message}\n`); return 2; }
  process.stdout.write(`${JSON.stringify({
    dir, resolved: outcome.resolved.length, occurrences: outcome.resolved.reduce((sum, record) => sum + record.occurrences, 0),
    unmatched: outcome.unmatched, remaining: outcome.remaining,
    // Empty on the normal path. Non-empty means a closed record's tally is still
    // on disk and still counting — delete those paths by hand.
    orphaned_tallies: outcome.orphaned_tallies,
  })}\n`);
  // An id that named nothing HERE is an operator-visible outcome, not a success:
  // the record may be under another pm's runtime dir (GARELIER_PM_ID selects it).
  // An orphaned tally is likewise a thing left undone, not a clean exit.
  return outcome.unmatched.length > 0 || outcome.orphaned_tallies.length > 0 ? 3 : 0;
}

// No top-level await: this module is imported by command_guard and the recovery
// hook, and an async module there would make every importer async too.
if (import.meta.main) {
  void main(process.argv.slice(2)).then((code) => { process.exit(code); });
}
