// DEC-083 — dock_status.ts one-shot status. A status read must NEVER hard-fail
// the caller: a project with no/broken config yields ok:false + warnings + exit 0.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const here = import.meta.dir;

async function runStatus(args: string[], project: string) {
  const p = Bun.spawn(["bun", "run", join(here, "dock_status.ts"), ...args], {
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
