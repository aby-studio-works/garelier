import { rmSync } from "../guard/path_guard.ts";
// DEC-083 — dock_status.ts one-shot status. A status read must NEVER hard-fail
// the caller: a project with no/broken config yields ok:false + warnings + exit 0.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const here = import.meta.dir;

async function runStatus(args: string[], project: string) {
  const p = Bun.spawn(["bun", "run", join(here, "dock_status.ts"), ...args], { windowsHide: true,
    cwd: here, env: { ...process.env, GARELIER_PROJECT: project }, stdout: "pipe", stderr: "pipe",
  });
  return { out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: await p.exited };
}

test("missing config -> ok:false + warnings, but exit 0 (never crashes the caller)", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-status-"));
  try {
    const r = await runStatus(["--pm-id", "demo", "--format", "json"], project);
    expect(r.code).toBe(0);                       // status read must not hard-fail
    const s = JSON.parse(r.out);
    expect(s.ok).toBe(false);
    expect(Array.isArray(s.warnings)).toBe(true);
    expect(s.warnings.length).toBeGreaterThan(0);
    expect(s.driver).toBeDefined();               // derived block always present
    expect(s.pmId).toBe("demo");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("text format emits the --- PM: --- block", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-status-"));
  try {
    const r = await runStatus(["--pm-id", "demo", "--format", "text"], project);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--- PM: demo");
    expect(r.out).toContain("plant:");
    expect(r.out).toContain("driver:");
    expect(r.out).toContain("gate:");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("no --pm-id and no --all-pms -> usage exit 2", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-status-"));
  try {
    const r = await runStatus(["--format", "json"], project);
    expect(r.code).toBe(2);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("W-164: an open guard report surfaces in pmAction (count + needed + item)", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-status-"));
  try {
    const pm = join(project, "__garelier", "demo", "_crew", "pm");
    mkdirSync(pm, { recursive: true });
    writeFileSync(join(pm, "setup_config.toml"), "[project]\nname=\"Demo\"\n");
    const hooks = join(project, "__garelier", "demo", "runtime", "hooks");
    mkdirSync(hooks, { recursive: true });
    // one open guard deny + one non-guard incident (must be ignored) + one resolved guard (dropped).
    writeFileSync(join(hooks, "incidents.jsonl"),
      JSON.stringify({ kind: "guard_deny", status: "open", rule: "recursive_delete", action: "deny", command: "rm -rf /x", created_at: new Date().toISOString() }) + "\n" +
      JSON.stringify({ kind: "bash_command_failed", status: "open", agent_id: "a" }) + "\n" +
      JSON.stringify({ kind: "guard_ask", status: "resolved", rule: "force_write", action: "ask", command: "git reset --hard", created_at: new Date().toISOString() }) + "\n");
    const r = await runStatus(["--pm-id", "demo", "--format", "json"], project);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.pmAction.guardReports).toBe(1);
    expect(s.pmAction.needed).toBe(true);
    expect((s.pmAction.items || []).some((i: { kind?: string }) => i.kind === "guard_report")).toBe(true);
    const r2 = await runStatus(["--pm-id", "demo", "--format", "text"], project);
    expect(r2.out).toContain("guard=1");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("W-175: a stalled merge-gate request (aged, no live runner) surfaces in pmAction", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-status-"));
  try {
    const pm = join(project, "__garelier", "demo", "_crew", "pm");
    mkdirSync(pm, { recursive: true });
    writeFileSync(join(pm, "setup_config.toml"), "[project]\nname=\"Demo\"\n");
    const reqDir = join(project, "__garelier", "demo", "runtime", "merge_gate", "requests");
    mkdirSync(reqDir, { recursive: true });
    const reqFile = join(reqDir, "20260719-000000-42.json");
    writeFileSync(reqFile, "{}"); // a queued request, no result, no active.lock
    const old = new Date(Date.now() - 20 * 60 * 1000); // > 10 min stall threshold
    utimesSync(reqFile, old, old);
    const r = await runStatus(["--pm-id", "demo", "--format", "json"], project);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.pmAction.mergeStalled).toBe(1);
    expect(s.pmAction.needed).toBe(true);
    expect((s.pmAction.items || []).some((i: { kind?: string }) => i.kind === "merge_stalled")).toBe(true);
    const r2 = await runStatus(["--pm-id", "demo", "--format", "text"], project);
    expect(r2.out).toContain("mergeStalled=1");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("W-176 c: N+ guard asks from one agent surface as a record-supply gap in pmAction", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-status-"));
  try {
    const pm = join(project, "__garelier", "demo", "_crew", "pm");
    mkdirSync(pm, { recursive: true });
    writeFileSync(join(pm, "setup_config.toml"), "[project]\nname=\"Demo\"\n");
    const hooks = join(project, "__garelier", "demo", "runtime", "hooks");
    mkdirSync(hooks, { recursive: true });
    // 3 open guard_ask from the SAME agent (the threshold) → a record-supply gap.
    const ask = (rule: string) => JSON.stringify({ kind: "guard_ask", status: "open", rule, action: "ask", resolved_agent: "ga-worker-x", command: "rm -rf build", created_at: new Date().toISOString() });
    writeFileSync(join(hooks, "incidents.jsonl"), [ask("force_write"), ask("secret_file"), ask("indirect_delete")].join("\n") + "\n");
    const r = await runStatus(["--pm-id", "demo", "--format", "json"], project);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.pmAction.recordSupplyGaps).toBe(1);
    expect(s.pmAction.needed).toBe(true);
    expect((s.pmAction.items || []).some((i: { kind?: string }) => i.kind === "record_supply_gap")).toBe(true);
    const r2 = await runStatus(["--pm-id", "demo", "--format", "text"], project);
    expect(r2.out).toContain("recordGap=1");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("--all-pms discovers a crew-layout PM", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-status-"));
  try {
    const pm = join(project, "__garelier", "demo", "_crew", "pm");
    mkdirSync(pm, { recursive: true });
    writeFileSync(join(pm, "setup_config.toml"), "[project]\nname=\"Demo\"\n");
    const r = await runStatus(["--all-pms", "--format", "json"], project);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).pms).toHaveLength(1);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
