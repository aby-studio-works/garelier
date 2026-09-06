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
