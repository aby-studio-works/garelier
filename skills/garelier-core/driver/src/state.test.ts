import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAgentState,
  healRoleStateResidue,
  isAgentActive,
  observerInterestPaths,
  dockInterestPaths,
  workerInterestPaths,
  scoutInterestPaths,
  smithInterestPaths,
  librarianInterestPaths,
  guardianInterestPaths,
  conciergeInterestPaths,
  artisanInterestPaths,
  pmInterestPaths,
  ChangeTracker,
  statusSignal,
  contentSignal,
  type Signal,
} from "./state.ts";

// Interest builders may return semantic Signals ({id,value}) alongside bare
// mtime paths; tests that assert on watched LOCATIONS extract the ids.
const sigIds = (sigs: Signal[]): string[] => sigs.map((s) => (typeof s === "string" ? s : s.id));
import { workspacePointerPath, _resetWorkspaceCache } from "./workspace.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function stateFile(status: string): string {
  const d = mkdtempSync(join(tmpdir(), "symphst-")); dirs.push(d);
  const f = join(d, "STATE.md");
  writeFileSync(f, `# x\n\n## Status\n${status}\n\n## Last activity\nnow\n`);
  return f;
}

describe("readAgentState / normalizeStatus", () => {
  test("parses observer states OBSERVING and ACKED", () => {
    expect(readAgentState(stateFile("OBSERVING")).status).toBe("OBSERVING");
    expect(readAgentState(stateFile("ACKED")).status).toBe("ACKED");
  });
  test("classic states still parse", () => {
    expect(readAgentState(stateFile("WORKING")).status).toBe("WORKING");
    expect(readAgentState(stateFile("MERGED")).status).toBe("MERGED");
  });
  test("unknown status → NO_STATE; missing file → NO_STATE", () => {
    expect(readAgentState(stateFile("WAT")).status).toBe("NO_STATE");
    expect(readAgentState("/no/such/STATE.md").status).toBe("NO_STATE");
  });
  test("extracts Current task — what the role is working on", () => {
    const d = mkdtempSync(join(tmpdir(), "symphst-ct-")); dirs.push(d);
    const f = join(d, "STATE.md");
    writeFileSync(f, "# Scout scout-01\n\n## Status\nWORKING\n\n## Current task\n#25 — server_room flake repro\n\n## Last activity\nnow\n");
    expect(readAgentState(f).currentTask).toBe("#25 — server_room flake repro");
    // absent section → undefined (not "")
    expect(readAgentState(stateFile("IDLE")).currentTask).toBeUndefined();
  });
});

describe("isAgentActive", () => {
  test("OBSERVING is active; ACKED and IDLE are not", () => {
    expect(isAgentActive("OBSERVING")).toBe(true);
    expect(isAgentActive("ACKED")).toBe(false);
    expect(isAgentActive("IDLE")).toBe(false);
    expect(isAgentActive("WORKING")).toBe(true);
  });
});

describe("interest paths", () => {
  test("observerInterestPaths covers state/assignment/acked/abort/requests/lane.lock", () => {
    const joined = observerInterestPaths("/root", "pm", "ob1").join("|");
    expect(joined).toContain("_observers/ob1/STATE.md");
    expect(joined).toContain("_observers/ob1/assignment.md");
    expect(joined).toContain("_observers/ob1/acked.md");
    expect(joined).toContain("_observers/ob1/abort.md");
    expect(joined).toContain("runtime/observer/requests");
    expect(joined).toContain("runtime/lane.lock");
  });
  test("dockInterestPaths includes observer STATE when observerIds given", () => {
    const joined = sigIds(dockInterestPaths("/root", "pm", [], [], [], [], ["ob1"])).join("|");
    expect(joined).toContain("_observers/ob1/STATE.md");
  });
  test("PM/Dock interest paths ignore derived hot indexes", () => {
    const pm = sigIds(pmInterestPaths("/root", "pm")).join("|");
    expect(pm).not.toContain("runtime/manifest.md");

    const dock = sigIds(dockInterestPaths("/root", "pm", ["w1"], [], [], [], [])).join("|");
    expect(dock).not.toContain("runtime/manifest.md");
    expect(dock).not.toContain("_pm/history.md");
    expect(dock).toContain("runtime/merge_gate/results");
    expect(dock).toContain("_workers/w1/STATE.md");
  });
});

// DEC-035 (load-bearing — "silent-death risk"): the driver fires agents by
// polling these paths. They MUST resolve to the role's RESOLVED container, so
// that under exile the driver watches the machine-local home, not an empty
// in-project dir. Without this the driver never fires for an exiled role.
describe("interest paths resolve exiled containers (DEC-035)", () => {
  // makeLines receives the freshly-created home path so callers can build the
  // pointer entries without a temporal-dead-zone reference to `home`.
  function projWithPointer(makeLines: (home: string) => string[]): { root: string; home: string } {
    const root = mkdtempSync(join(tmpdir(), "symphst-ws-")).replace(/\\/g, "/");
    dirs.push(root);
    mkdirSync(join(root, "__garelier", "pm", "runtime"), { recursive: true });
    const home = mkdtempSync(join(tmpdir(), "symphst-home-")).replace(/\\/g, "/");
    dirs.push(home);
    writeFileSync(workspacePointerPath(root, "pm"), ["# ptr", ...makeLines(home), ""].join("\n"));
    _resetWorkspaceCache();
    return { root, home };
  }

  test("worker/scout/smith/librarian/guardian/concierge STATE poll the exile home", () => {
    const { root, home } = projWithPointer((h) => [
      `worker.w1=${h}/_workers/w1`,
      `scout.s1=${h}/_scouts/s1`,
      `smith.sm1=${h}/_smiths/sm1`,
      `librarian.l1=${h}/_librarians/l1`,
      `guardian.g1=${h}/_guardians/g1`,
      `concierge.c1=${h}/_concierges/c1`,
    ]);
    const cases: Array<[string[], string]> = [
      [workerInterestPaths(root, "pm", "w1"), `${home}/_workers/w1/STATE.md`],
      [scoutInterestPaths(root, "pm", "s1"), `${home}/_scouts/s1/STATE.md`],
      [smithInterestPaths(root, "pm", "sm1"), `${home}/_smiths/sm1/STATE.md`],
      [librarianInterestPaths(root, "pm", "l1"), `${home}/_librarians/l1/STATE.md`],
      [guardianInterestPaths(root, "pm", "g1"), `${home}/_guardians/g1/STATE.md`],
      [conciergeInterestPaths(root, "pm", "c1"), `${home}/_concierges/c1/STATE.md`],
    ];
    for (const [paths, expected] of cases) {
      expect(paths).toContain(expected);
      // and NOT the in-project path (would be polled-but-empty under exile)
      expect(paths.join("|")).not.toContain(`${root}/__garelier/pm/_`);
    }
  });

  test("artisan + dock scan resolve the exile home", () => {
    const { root, home } = projWithPointer((h) => [
      `artisan=${h}/_artisan`,
      `worker.w1=${h}/_workers/w1`,
    ]);
    expect(artisanInterestPaths(root, "pm")).toContain(`${home}/_artisan/STATE.md`);
    const orch = sigIds(dockInterestPaths(root, "pm", ["w1"], [], [], [], [])).join("|");
    expect(orch).toContain(`${home}/_workers/w1/STATE.md`);
    expect(orch).not.toContain(`${root}/__garelier/pm/_workers/w1`);
  });

  test("an id absent from the pointer falls back to the in-proj path (mixed install)", () => {
    const { root } = projWithPointer((h) => [`worker.w1=${h}/_workers/w1`]);
    // w2 has no pointer entry -> legacy in-proj container.
    expect(workerInterestPaths(root, "pm", "w2")).toContain(
      `${root}/__garelier/pm/_workers/w2/STATE.md`,
    );
  });
});

describe("healRoleStateResidue (driver self-heal of cross-role STATE residue)", () => {
  function fileWith(header: string, status = "REPORTING"): string {
    const d = mkdtempSync(join(tmpdir(), "symphheal-")); dirs.push(d);
    const f = join(d, "STATE.md");
    writeFileSync(f, `# ${header}\n\n## Status\n${status}\n\n## Last activity\nnow\n`);
    return f;
  }

  test("rewrites a different KNOWN role's residue to a fresh IDLE state", () => {
    // A Worker's STATE.md left in a scout container reads REPORTING for the scout.
    const f = fileWith("Worker worker-01 — State", "REPORTING");
    expect(readAgentState(f).status).toBe("REPORTING");      // residue misread before heal
    expect(healRoleStateResidue(f, "scout", "scout-01")).toBe("worker"); // returns cleared kind
    expect(readAgentState(f).status).toBe("IDLE");           // healed to IDLE
  });

  test("leaves a matching-role STATE untouched (no rewrite)", () => {
    const f = fileWith("Scout scout-01 — State", "WORKING");
    expect(healRoleStateResidue(f, "scout", "scout-01")).toBeNull();
    expect(readAgentState(f).status).toBe("WORKING");
  });

  test("does NOT heal when the header word is not a known role kind", () => {
    const f = fileWith("x", "WORKING");                       // template stub header
    expect(healRoleStateResidue(f, "scout", "scout-01")).toBeNull();
    expect(readAgentState(f).status).toBe("WORKING");
  });

  test("missing file → null (nothing to heal)", () => {
    expect(healRoleStateResidue(join(tmpdir(), "nope-symphheal", "STATE.md"), "scout", "x")).toBeNull();
  });

  test("healed file names the correct role in its heading", () => {
    const f = fileWith("Smith smith-02 — State", "MERGED");
    healRoleStateResidue(f, "guardian", "guardian-01");
    const head = readFileSync(f, "utf8");
    expect(head.startsWith("# Guardian guardian-01 — State")).toBe(true);
  });
});

// The #1 cost driver: a coordinator (PM/Dock) used to wake (~$1+/iteration,
// 1M+ cache_read) on a producer's STATE.md heartbeat re-stamp and conclude "no
// action". These tests pin the semantic-wake contract: wake on PROGRESS (a real
// transition / handoff / new merge result), never on heartbeat/log churn — while
// preserving the load-bearing invariants (a new merge result / report MUST wake
// Dock; a dropped signal would stall the pipeline).
describe("semantic wake signals (wake on progress, not heartbeat churn)", () => {
  function workerProj(status: string): { root: string; container: string; stateFile: string } {
    const root = mkdtempSync(join(tmpdir(), "symphwake-")).replace(/\\/g, "/"); dirs.push(root);
    _resetWorkspaceCache();
    const container = join(root, "__garelier", "pm", "_workers", "w1");
    mkdirSync(container, { recursive: true });
    mkdirSync(join(root, "__garelier", "pm", "runtime", "merge_gate", "results"), { recursive: true });
    const stateFile = join(container, "STATE.md");
    writeFileSync(stateFile, `# Worker w1\n\n## Status\n${status}\n\n## Last activity\nt0\n`);
    return { root, container, stateFile };
  }
  const orch = (root: string): Signal[] => dockInterestPaths(root, "pm", ["w1"], [], [], [], []);

  test("statusSignal ignores heartbeat churn, changes on a real transition", () => {
    const { stateFile } = workerProj("WORKING");
    const v0 = statusSignal(stateFile);
    writeFileSync(stateFile, `# Worker w1\n\n## Status\nWORKING\n\n## Last activity\nMUCH-LATER\n`);
    expect(statusSignal(stateFile)).toEqual(v0);          // heartbeat only -> same signal
    writeFileSync(stateFile, `# Worker w1\n\n## Status\nREPORTING\n\n## Last activity\nx\n`);
    expect(statusSignal(stateFile)).not.toEqual(v0);      // transition -> changed
  });

  test("Dock does NOT wake on a producer's heartbeat re-stamp", () => {
    const { root, stateFile } = workerProj("WORKING");
    const t = new ChangeTracker();
    expect(t.hasChanged("dock", orch(root))).toBe(true);   // first call: no snapshot
    expect(t.hasChanged("dock", orch(root))).toBe(false);  // nothing changed
    writeFileSync(stateFile, `# Worker w1\n\n## Status\nWORKING\n\n## Last activity\nLATER\n`);
    expect(t.hasChanged("dock", orch(root))).toBe(false);  // heartbeat only -> NO wake
  });

  test("Dock DOES wake on a real status transition", () => {
    const { root, stateFile } = workerProj("WORKING");
    const t = new ChangeTracker();
    t.hasChanged("dock", orch(root));
    writeFileSync(stateFile, `# Worker w1\n\n## Status\nREPORTING\n\n## Last activity\nx\n`);
    expect(t.hasChanged("dock", orch(root))).toBe(true);
  });

  test("Dock DOES wake on a producer report.md handoff (status-lag belt-and-suspenders)", () => {
    const { root, container } = workerProj("WORKING");
    const t = new ChangeTracker();
    t.hasChanged("dock", orch(root));
    writeFileSync(join(container, "report.md"), "done\n");
    expect(t.hasChanged("dock", orch(root))).toBe(true);
  });

  test("Dock DOES wake on a new merge-gate result (load-bearing invariant)", () => {
    const { root } = workerProj("WORKING");
    const t = new ChangeTracker();
    t.hasChanged("dock", orch(root));
    writeFileSync(join(root, "__garelier", "pm", "runtime", "merge_gate", "results", "15-x.request.json"), "{}");
    expect(t.hasChanged("dock", orch(root))).toBe(true);
  });

  test("Dock DOES wake on a new blueprint (load-bearing invariant)", () => {
    const { root } = workerProj("WORKING");
    const bp = join(root, "__garelier", "pm", "control", "blueprints");
    mkdirSync(bp, { recursive: true });
    const t = new ChangeTracker();
    t.hasChanged("dock", orch(root));
    writeFileSync(join(bp, "BP-9-x.md"), "# bp\n");
    expect(t.hasChanged("dock", orch(root))).toBe(true);
  });

  test("Dock DOES wake on a Guardian gate verdict (status -> REPORTING) — the #15 stall", () => {
    // Regression: with semantic wake, a Guardian gate PASS (its verdict lives in
    // the guardian CONTAINER, not a results inbox) must wake Dock so it acks
    // the gate + submits the merge gate. Before this fix, guardian was not in
    // Dock's interest, so a PASS left Dock asleep and the task stalled.
    const { root } = workerProj("WORKING");
    const g = join(root, "__garelier", "pm", "_guardians", "g1");
    mkdirSync(g, { recursive: true });
    const sf = join(g, "STATE.md");
    writeFileSync(sf, "# guardian g1\n\n## Status\nCHECKING\n\n## Last activity\nnow\n");
    const orchG = (): Signal[] => dockInterestPaths(root, "pm", ["w1"], [], [], [], [], ["g1"], []);
    const t = new ChangeTracker();
    t.hasChanged("dock", orchG());
    expect(t.hasChanged("dock", orchG())).toBe(false);   // quiescent
    writeFileSync(sf, "# guardian g1\n\n## Status\nREPORTING\n\n## Last activity\nx\n");
    expect(t.hasChanged("dock", orchG())).toBe(true);    // gate verdict wakes Dock
  });

  test("PM DOES wake on a new inbox item, NOT on an unrelated touch (load-bearing invariant)", () => {
    const { root } = workerProj("WORKING");
    const inbox = join(root, "__garelier", "pm", "runtime", "pm", "inbox");
    mkdirSync(inbox, { recursive: true });
    const dash = join(root, "__garelier", "pm", "control", "project_dashboard");
    mkdirSync(dash, { recursive: true });
    writeFileSync(join(dash, "roadmap.md"), "# Roadmap\n- M1\n");
    writeFileSync(join(dash, "current.md"), "# Current\n- doing M1\n");
    const pm = () => pmInterestPaths(root, "pm");
    const t = new ChangeTracker();
    expect(t.hasChanged("pm", pm())).toBe(true);    // first: no snapshot
    expect(t.hasChanged("pm", pm())).toBe(false);   // quiescent
    writeFileSync(join(inbox, "20260603-req.json"), "{}");
    expect(t.hasChanged("pm", pm())).toBe(true);    // new delegated request -> wake
  });

  // STALL regression (adversarial review): a dashboard line that merely CONTAINS
  // a date (milestone target, dated decision/note) must NOT be treated as churn —
  // editing it must wake PM. Only a dedicated "Last updated" stamp line is
  // suppressed. PM has no heartbeat floor, so a missed wake is a permanent stall.
  describe("contentSignal (PM dashboard — suppress stamp churn, never stall a real edit)", () => {
    function roadmap(body: string): string {
      const d = mkdtempSync(join(tmpdir(), "symphwake-pm-")).replace(/\\/g, "/"); dirs.push(d);
      const f = join(d, "roadmap.md"); writeFileSync(f, body); return f;
    }
    test("a dedicated 'Last updated' stamp re-stamp does NOT wake PM", () => {
      const f = roadmap("# Roadmap\n\n- M1: ship\nLast updated: 2026-06-03T00:00:00Z\n");
      const v0 = contentSignal(f);
      writeFileSync(f, "# Roadmap\n\n- M1: ship\nLast updated: 2026-06-03T23:30:00Z\n");
      expect(contentSignal(f)).toEqual(v0);
    });
    test("editing a DATED milestone line (text change) WAKES PM", () => {
      const f = roadmap("# Roadmap\n\n- M2: ship auth (target 2026-07-01)\n");
      const v0 = contentSignal(f);
      writeFileSync(f, "# Roadmap\n\n- M2: ship auth + SSO (target 2026-09-01)\n");
      expect(contentSignal(f)).not.toEqual(v0);           // would have stalled before the fix
    });
    test("a date-only change on a content line WAKES PM (no embedded-date neutralization)", () => {
      const f = roadmap("# Roadmap\n\n- M2: ship auth (target 2026-07-01)\n");
      const v0 = contentSignal(f);
      writeFileSync(f, "# Roadmap\n\n- M2: ship auth (target 2026-09-01)\n");
      expect(contentSignal(f)).not.toEqual(v0);
    });
    test("appending a new (dated) directive line WAKES PM", () => {
      const f = roadmap("# Roadmap\n\n- M1: ship\n");
      const v0 = contentSignal(f);
      writeFileSync(f, "# Roadmap\n\n- M1: ship\n- USER: prioritize billing by 2026-08-01\n");
      expect(contentSignal(f)).not.toEqual(v0);
    });
    test("a genuine non-dated edit WAKES PM", () => {
      const f = roadmap("# Roadmap\n\n- M1: ship\n");
      const v0 = contentSignal(f);
      writeFileSync(f, "# Roadmap\n\n- M1: ship\n- M2: NEW MILESTONE\n");
      expect(contentSignal(f)).not.toEqual(v0);
    });
  });
});
