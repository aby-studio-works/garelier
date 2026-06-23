import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDockPulse, gatherRoles, parseClaims, parseStateMd, type PulseInput, type RoleClaims, type RoleState } from "./dock_pulse.ts";
import { _resetWorkspaceCache } from "./workspace.ts";

describe("parseStateMd", () => {
  test("parses the dispatch_prepare STATE.md shape", () => {
    const md = "# Dispatch #3 - worker add-thing\n\n## Status\n\nWORKING\n\n## Current task\n\n#3 add-thing (branch)\n";
    expect(parseStateMd(md, "dispatch")).toEqual({ role: "worker", status: "WORKING", task: "#3 add-thing (branch)" });
  });

  test("status is the first word, uppercased; role from H1 keyword", () => {
    const md = "# smith s1 — State\n\n## Status\nreporting now\n";
    const r = parseStateMd(md, "fallback");
    expect(r.role).toBe("smith");
    expect(r.status).toBe("REPORTING");
    expect(r.task).toBeNull();
  });

  test("missing Status section → UNKNOWN + fallback role", () => {
    expect(parseStateMd("# notes\nnothing here\n", "observer")).toEqual({ role: "observer", status: "UNKNOWN", task: null });
  });

  test("BLOCKED status detected", () => {
    expect(parseStateMd("# worker w1\n## Status\nBLOCKED\n", "worker").status).toBe("BLOCKED");
  });
});

function role(container: string, status: string, r = "worker", claims: RoleClaims | null = null): RoleState {
  return { container, role: r, status, task: null, claims };
}
function input(over: Partial<PulseInput> = {}): PulseInput {
  return {
    roles: [],
    inbox: [],
    resolutionsCount: 0,
    queuePendingCount: 0,
    queueNext: [],
    mergeGate: { active_lock: false, lock_slug: null, requests: 0 },
    ...over,
  };
}

describe("buildDockPulse — signals", () => {
  test("active/idle split + reporting/blocked vectors", () => {
    const p = buildDockPulse(
      input({
        roles: [
          role("_dispatch1", "WORKING"),
          role("_workers/w2", "REPORTING"),
          role("_smiths/s1", "BLOCKED", "smith"),
          role("_scouts/x", "IDLE", "scout"),
        ],
      }),
    );
    expect(p.signals.active_roles).toBe(3); // WORKING + REPORTING + BLOCKED
    expect(p.signals.idle_roles).toBe(1);
    expect(p.signals.has_reporting).toBe(true);
    expect(p.signals.reporting_roles).toEqual(["_workers/w2"]);
    expect(p.signals.has_blocked).toBe(true);
    expect(p.signals.blocked_roles).toEqual(["_smiths/s1"]);
    expect(p.advisory).toBe(true);
  });

  test("merge_in_flight + inbox_nonempty signals", () => {
    const p = buildDockPulse(
      input({
        inbox: [{ file: "001.md", summary: "worker w2 REPORTING" }],
        mergeGate: { active_lock: true, lock_slug: "add-thing", requests: 1 },
      }),
    );
    expect(p.signals.inbox_nonempty).toBe(true);
    expect(p.inbox.count).toBe(1);
    expect(p.signals.merge_in_flight).toBe(true);
    expect(p.merge_gate.lock_slug).toBe("add-thing");
  });

  test("UNKNOWN status counts as idle (not active)", () => {
    const p = buildDockPulse(input({ roles: [role("_dispatch1", "UNKNOWN")] }));
    expect(p.signals.active_roles).toBe(0);
    expect(p.signals.idle_roles).toBe(1);
  });

  test("empty runtime → all-quiet signals", () => {
    const p = buildDockPulse(input());
    expect(p.signals.active_roles).toBe(0);
    expect(p.signals.has_reporting).toBe(false);
    expect(p.signals.has_blocked).toBe(false);
    expect(p.signals.inbox_nonempty).toBe(false);
    expect(p.signals.merge_in_flight).toBe(false);
  });

  test("deterministic", () => {
    const i = input({ roles: [role("_dispatch1", "WORKING")] });
    expect(JSON.stringify(buildDockPulse(i))).toBe(JSON.stringify(buildDockPulse(i)));
  });
});

describe("gatherRoles — in-project + exiled union (DEC-036)", () => {
  test("scans in-project containers AND exiled ones from the pointer", () => {
    const project = mkdtempSync(join(tmpdir(), "dp-proj-"));
    const exiledHome = mkdtempSync(join(tmpdir(), "dp-exile-"));
    const pmRoot = join(project, "__garelier", "pm");

    // in-project worker
    mkdirSync(join(pmRoot, "_workers", "w1"), { recursive: true });
    writeFileSync(join(pmRoot, "_workers", "w1", "STATE.md"), "# worker w1\n## Status\nWORKING\n");

    // exiled worker OUTSIDE the project, recorded in the gitignored pointer
    const exiledContainer = join(exiledHome, "_workers", "exiled-a");
    mkdirSync(exiledContainer, { recursive: true });
    writeFileSync(join(exiledContainer, "STATE.md"), "# worker exiled-a\n## Status\nREPORTING\n");
    // report.json claims are inlined into the pulse for triage.
    writeFileSync(
      join(exiledContainer, "report.json"),
      JSON.stringify({ status: "done", tests: { full: "passed" }, risk_flags: { security: true }, summary: "did x", files_changed: ["a.ts", "b.ts"] }),
    );
    mkdirSync(join(pmRoot, "runtime"), { recursive: true });
    writeFileSync(join(pmRoot, "runtime", "workspace_paths"), `worker.exiled-a=${exiledContainer}\n`);

    _resetWorkspaceCache();
    const roles = gatherRoles(pmRoot, project, "pm");

    const byStatus = Object.fromEntries(roles.map((r) => [r.role + ":" + r.status, r.container]));
    expect(roles).toHaveLength(2);
    expect(byStatus["worker:WORKING"]).toContain("w1");
    const exiled = roles.find((r) => r.status === "REPORTING")!;
    expect(exiled.role).toBe("worker");
    expect(exiled.container).toContain("exiled");
    // claims lifted from the exiled container's report.json
    expect(exiled.claims?.status).toBe("done");
    expect(exiled.claims?.files_changed_count).toBe(2);
    // in-project w1 has no report.json → null claims
    expect(roles.find((r) => r.container.includes("w1"))!.claims).toBeNull();
  });
});

describe("parseClaims + risk_flagged signal", () => {
  test("parseClaims compacts report.json; counts files_changed", () => {
    const c = parseClaims(JSON.stringify({ status: "done", verdict: "PASS", tests: { full: "passed" }, risk_flags: { security: true }, summary: "ok", files_changed: ["a", "b", "c"] }));
    expect(c).toEqual({ status: "done", verdict: "PASS", tests: { full: "passed" }, risk_flags: { security: true }, summary: "ok", files_changed_count: 3 });
  });
  test("parseClaims → null on absent / bad JSON", () => {
    expect(parseClaims(null)).toBeNull();
    expect(parseClaims("not json")).toBeNull();
  });
  test("risk_flagged_roles surfaces roles whose claims have a true risk flag", () => {
    const risky = role("_dispatch1", "REPORTING", "worker", { status: "done", verdict: null, tests: null, risk_flags: { security: true, data_change: false }, summary: null, files_changed_count: 1 });
    const safe = role("_workers/w2", "REPORTING", "worker", { status: "done", verdict: null, tests: null, risk_flags: { security: false }, summary: null, files_changed_count: 0 });
    const p = buildDockPulse(input({ roles: [risky, safe] }));
    expect(p.signals.risk_flagged_roles).toEqual(["_dispatch1"]);
  });
});
