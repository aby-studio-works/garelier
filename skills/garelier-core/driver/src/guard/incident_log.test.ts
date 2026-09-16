import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "./path_guard.ts";
import {
  appendIncident,
  incidentRepeatKey,
  INCIDENTS_FILE,
  readIncidentRepeats,
  resolveIncidents,
  RESOLVED_DIR,
  totalOccurrences,
  main,
} from "./incident_log.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function runtimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "garelier-incidents-"));
  scratch.push(dir);
  return dir;
}

function lines(dir: string): string[] {
  try { return readFileSync(join(dir, INCIDENTS_FILE), "utf8").split("\n").filter(Boolean); }
  catch { return []; }
}

/** The measured shape: one mis-located dispatch record re-rejected on every guard
 * invocation, byte-identical every time. */
function rejection(recordPath: string, reason: string, at: string) {
  return {
    incident_id: `gri-guardrec-${at}`,
    kind: "guard_record_rejected",
    status: "open",
    created_at: at,
    record_path: recordPath,
    reason,
  };
}
const REASON = "record worktree does not resolve under its dispatch container";
const OTHER_REASON = "record profile is not a known permission profile";

describe("incident stream coalescing", () => {
  // W-677: the 8 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("a thousand identical rejections record one line, not a thousand (+7 folded cases)", async () => {
    // case: a thousand identical rejections record one line, not a thousand
    {
      const dir = runtimeDir();
      const path = "_crew/dispatch792/context.json";
      for (let i = 0; i < 1000; i++) {
        const record = rejection(path, REASON, new Date(Date.UTC(2026, 7, 19, 0, 0, i)).toISOString());
        appendIncident(dir, record, incidentRepeatKey(record.kind, [path, REASON]));
      }

      expect(lines(dir)).toHaveLength(1);

      // The fact survives: how many, from when, until when.
      const repeats = [...readIncidentRepeats(dir).values()];
      expect(repeats).toHaveLength(1);
      expect(repeats[0]).toMatchObject({
        kind: "guard_record_rejected",
        count: 1000,
        first_at: "2026-08-19T00:00:00.000Z",
        last_at: "2026-08-19T00:16:39.000Z",
      });
    }
    // case: a different record_path or a different reason is still recorded on its own
    {
      const dir = runtimeDir();
      const cases: Array<[string, string]> = [
        ["_crew/dispatch792/context.json", REASON],
        ["_crew/dispatch793/context.json", REASON],
        ["_crew/dispatch792/context.json", OTHER_REASON],
      ];
      for (const [path, reason] of cases) {
        for (let i = 0; i < 200; i++) {
          const record = rejection(path, reason, new Date(Date.UTC(2026, 7, 20, 0, 0, i)).toISOString());
          appendIncident(dir, record, incidentRepeatKey(record.kind, [path, reason]));
        }
      }

      // Three causes, 600 occurrences: the line count follows causes, not volume.
      expect(lines(dir)).toHaveLength(3);
      const records = lines(dir).map((line) => JSON.parse(line) as { repeat_key?: string });
      expect(new Set(records.map((record) => record.repeat_key)).size).toBe(3);
      expect(totalOccurrences(records, readIncidentRepeats(dir))).toBe(600);
    }
    // case: the first occurrence is written in full and carries its repeat key
    {
      const dir = runtimeDir();
      const record = rejection("_crew/dispatch792/context.json", REASON, "2026-08-19T00:00:00.000Z");
      const key = incidentRepeatKey(record.kind, ["_crew/dispatch792/context.json", REASON]);

      expect(appendIncident(dir, record, key)).toBe("recorded");
      expect(appendIncident(dir, record, key)).toBe("coalesced");

      const written = JSON.parse(lines(dir)[0]!) as Record<string, unknown>;
      expect(written).toMatchObject({ ...record, repeat_key: key });
    }
    // case: a caller with no stable key keeps the unconditional append
    {
      const dir = runtimeDir();
      for (let i = 0; i < 5; i++) appendIncident(dir, rejection("p", REASON, `2026-08-19T00:00:0${i}.000Z`));
      expect(lines(dir)).toHaveLength(5);
      expect(readIncidentRepeats(dir).size).toBe(0);
    }
    // case: an unwritable tally records the occurrence in full rather than dropping it
    {
      const dir = runtimeDir();
      // A FILE where the tally directory must go: the tally can never be written, so
      // coalescing must degrade to recording, never to silence.
      writeFileSync(join(dir, "incident_repeats"), "not a directory\n");
      const record = rejection("_crew/dispatch792/context.json", REASON, "2026-08-19T00:00:00.000Z");
      const key = incidentRepeatKey(record.kind, ["_crew/dispatch792/context.json", REASON]);

      expect(appendIncident(dir, record, key)).toBe("recorded");
      expect(appendIncident(dir, record, key)).toBe("recorded");
      expect(lines(dir)).toHaveLength(2);
    }
    // case: every id a caller emits resolves to a real record
    {
      // A repeat is not appended, so the id the caller minted for it names nothing in
      // the stream. The tally has to carry it, or an operator told to "review
      // incidents.jsonl for <id>" is sent to look for something that was never written.
      const dir = runtimeDir();
      const path = "_crew/dispatch792/context.json";
      const key = incidentRepeatKey("guard_record_rejected", [path, REASON]);
      const first = rejection(path, REASON, "2026-08-19T00:00:00.000Z");
      const latest = rejection(path, REASON, "2026-08-19T00:05:00.000Z");
      appendIncident(dir, first, key);
      appendIncident(dir, { ...rejection(path, REASON, "2026-08-19T00:02:00.000Z") }, key);
      appendIncident(dir, latest, key);

      const tally = readIncidentRepeats(dir).get(key)!;
      expect(tally.count).toBe(3);
      // The first occurrence's id names the record that IS in the stream.
      expect(tally.incident_id).toBe(first.incident_id);
      expect(JSON.parse(lines(dir)[0]!).incident_id).toBe(first.incident_id);
      // The latest occurrence's id is the one a caller just minted and announced.
      expect(tally.last_incident_id).toBe(latest.incident_id);
      expect(tally.last_incident_id).not.toBe(tally.incident_id);
    }
    // case: a tally written before last_incident_id existed still reads
    {
      // Forward-compatibility: an older tally identifies its cause by the first id
      // alone; dropping it would discard a real count rather than degrade.
      const dir = runtimeDir();
      const key = incidentRepeatKey("guard_record_rejected", ["p", REASON]);
      mkdirSync(join(dir, "incident_repeats"), { recursive: true });
      writeFileSync(join(dir, "incident_repeats", `${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`), `${JSON.stringify({
        schema: "garelier.incident-repeat", version: 1, repeat_key: key, kind: "guard_record_rejected",
        incident_id: "gri-legacy", count: 7, first_at: "2026-08-19T00:00:00.000Z", last_at: "2026-08-19T00:09:00.000Z",
      })}
  `);

      const tally = readIncidentRepeats(dir).get(key)!;
      expect(tally.count).toBe(7);
      expect(tally.last_incident_id).toBe("gri-legacy");
    }
    // case: an id a caller was TOLD resolves the cause it names (W-758 形 1)
    {
      // The hook mints a fresh id per occurrence and prints it, but only the
      // first occurrence is a line in the stream. If resolution accepted only
      // the line's own id, every id an agent was actually shown for a repeated
      // cause would close nothing — which is the shape that left 163 records
      // open. Both the first and the latest id name the same record.
      const dir = runtimeDir();
      const path = "_crew/dispatch792/context.json";
      const key = incidentRepeatKey("guard_record_rejected", [path, REASON]);
      const first = rejection(path, REASON, "2026-08-19T00:00:00.000Z");
      const latest = rejection(path, REASON, "2026-08-19T00:05:00.000Z");
      appendIncident(dir, first, key);
      appendIncident(dir, latest, key);
      const other = rejection("_crew/dispatch793/context.json", REASON, "2026-08-19T00:06:00.000Z");
      appendIncident(dir, other, incidentRepeatKey(other.kind, ["_crew/dispatch793/context.json", REASON]));

      const outcome = resolveIncidents(dir, [latest.incident_id], "mis-located record deleted", () => new Date("2026-09-11T00:00:00.000Z"));
      expect(outcome.resolved).toHaveLength(1);
      expect(outcome.unmatched).toEqual([]);
      // The tally's count survives the tally: the volume was the only fact a
      // coalesced repeat carried.
      expect(outcome.resolved[0]).toMatchObject({
        incident_id: first.incident_id, status: "resolved", occurrences: 2,
        resolved_reason: "mis-located record deleted", resolved_at: "2026-09-11T00:00:00.000Z",
      });
      expect(readIncidentRepeats(dir).has(key)).toBeFalse();
      // Only the named cause moves. The other record is untouched, in place.
      expect(lines(dir)).toHaveLength(1);
      expect(JSON.parse(lines(dir)[0]!).incident_id).toBe(other.incident_id);
      expect(readFileSync(join(dir, RESOLVED_DIR, INCIDENTS_FILE), "utf8")).toContain(first.incident_id);
      // Refutation, both directions: an id that names nothing is REPORTED rather
      // than counted as closed, and a resolution with no reason is not one.
      expect(resolveIncidents(dir, ["gri-not-here"], "x").unmatched).toEqual(["gri-not-here"]);
      expect(lines(dir)).toHaveLength(1);
      expect(() => resolveIncidents(dir, [other.incident_id], "  ")).toThrow(/--reason is required/);
      expect(lines(dir)).toHaveLength(1);
    }
    // case: the repeat key ignores nothing that distinguishes a cause
    {
      expect(incidentRepeatKey("guard_deny", ["rule", "deny", "cmd", "/a"]))
        .toBe(incidentRepeatKey("guard_deny", ["rule", "deny", "cmd", "/a"]));
      expect(incidentRepeatKey("guard_deny", ["rule", "deny", "cmd", "/a"]))
        .not.toBe(incidentRepeatKey("guard_deny", ["rule", "deny", "cmd", "/b"]));
      expect(incidentRepeatKey("guard_deny", ["rule"])).not.toBe(incidentRepeatKey("guard_ask", ["rule"]));
    }
    // W-789: the CLI can address the shared atmos store explicitly. Without
    // --dir, a named PM resolved only its runtime/hooks store and reported this
    // real record unmatched. The explicit path remains fenced to the two
    // canonical incident-store shapes.
    {
      const project = mkdtempSync(join(tmpdir(), "garelier-incident-atmos-"));
      scratch.push(project);
      const atmos = join(project, "__garelier", "__atmos", "guard", "unresolved");
      mkdirSync(atmos, { recursive: true });
      const incident = rejection("_crew/dispatch9/context.json", REASON, "2026-09-12T00:00:00.000Z");
      appendIncident(atmos, incident);
      expect(await main(["resolve", incident.incident_id, "--reason", "owner reviewed", "--dir", atmos])).toBe(0);
      expect(lines(atmos)).toEqual([]);
      expect(readFileSync(join(atmos, RESOLVED_DIR, INCIDENTS_FILE), "utf8")).toContain(incident.incident_id);
      expect(await main(["resolve", incident.incident_id, "--reason", "x", "--dir", project])).toBe(2);
    }
  }, 120000);
});
