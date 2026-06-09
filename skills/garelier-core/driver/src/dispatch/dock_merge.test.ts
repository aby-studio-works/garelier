// Garelier dispatch (DEC-052) — Dock-bay merge CLI tests. Covers status (pure
// reads) + poll on an empty queue (no spawn). The merge mechanics themselves are
// covered by merge_gate.test.ts (pollMergeGate with an injected spawnFn).
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const here = import.meta.dir;

async function runDock(args: string[], project: string) {
  const p = Bun.spawn(["bun", "run", join(here, "dock_merge.ts"), ...args], {
    cwd: here, env: { ...process.env, GARELIER_PROJECT: project }, stdout: "pipe", stderr: "pipe",
  });
  return { out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: await p.exited };
}

test("status: empty merge gate -> nulls/empties", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-dock-"));
  try {
    const r = await runDock(["status", "--pm-id", "demo"], project);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.active).toBeNull();
    expect(s.pending).toEqual([]);
    expect(s.results).toEqual([]);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("status: surfaces existing result + active lock", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-dock-"));
  try {
    const base = join(project, "__garelier", "demo", "runtime", "merge_gate");
    mkdirSync(join(base, "results"), { recursive: true });
    mkdirSync(join(base, "locks"), { recursive: true });
    writeFileSync(join(base, "results", "0001.json"), JSON.stringify({ verdict: "PASS" }));
    writeFileSync(join(base, "locks", "active.lock"), JSON.stringify({ pid: 123, request_id: "r1" }));
    const r = await runDock(["status", "--pm-id", "demo"], project);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.results).toContain("0001.json");
    expect((s.active as any).request_id).toBe("r1");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("poll: missing config -> graceful exit 1 with a clear message (no crash)", async () => {
  // The happy-path merge spawning is covered by merge_gate.test.ts (pollMergeGate
  // with an injected spawnFn); here we assert dock_merge fails cleanly when the
  // PM config is absent rather than throwing an opaque error.
  const project = mkdtempSync(join(tmpdir(), "garelier-dock-"));
  try {
    const r = await runDock(["poll", "--pm-id", "demo"], project);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot load config");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("bad usage -> exit 2", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-dock-"));
  try {
    const r = await runDock(["frobnicate", "--pm-id", "demo"], project);
    expect(r.code).toBe(2);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
