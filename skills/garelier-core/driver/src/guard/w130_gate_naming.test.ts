// W-130: ad-hoc gate seat naming fallback. When NO dispatch/lane/gate_agents
// record resolves, a garelier-named gate reviewer (ga-guardian/observer/refuter-*)
// still gets a gate-profile record fenced to the nearest target root — safe
// direction only (read-only chains allow, mutations deny, producers unchanged).
// W-133: a bare-hash agent_id keys no record; the command's trusted absolute cd
// target into a dispatch checkout adopts that container's record (fence bounds it).

import { rmSync } from "./path_guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluate, findDispatchPermissionRecord } from "./command_guard.ts";

const temps: string[] = [];
function tmpProject(): string {
  const d = mkdtempSync(join(tmpdir(), "w130-")).replace(/\\/g, "/");
  mkdirSync(`${d}/__garelier/pmx`, { recursive: true });
  temps.push(d);
  return d;
}

// Build a dispatch container with a producer context.json + checkout dir; returns
// the checkout path. Fence = the checkout, so the adopted record bounds mutations.
function makeContainer(proj: string, id: string): string {
  const container = `${proj}/__garelier/pmx/_crew/dispatch${id}`;
  const checkout = `${container}/checkout`;
  mkdirSync(checkout, { recursive: true });
  writeFileSync(`${container}/context.json`, JSON.stringify({
    task: { role: "worker" },
    project: { project_root: proj },
    guard: { permission_profile: "producer", fence_roots: [checkout], agent_name: `ga-worker-${id}`, worktree: checkout },
  }));
  return checkout;
}
afterEach(() => {
  while (temps.length) {
    const d = temps.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("gate seat naming fallback (W-130)", () => {
  test("ga-observer-* with no record → synthesized gate seat fenced to the target root", () => {
    const proj = tmpProject();
    const rec = findDispatchPermissionRecord(proj, "ga-observer-dec040-design-review", {});
    expect(rec).not.toBeNull();
    expect(rec!.permission_profile).toBe("gate");
    // path_guard canonicalizes flavor-aware (W-036), so the fence root may come
    // back with native (back)slashes; compare separator-normalized.
    expect(rec!.fence_roots.map((r) => r.replace(/\\/g, "/"))).toEqual([proj]);
    expect(rec!.role).toBe("observer");
  });

  test("ga-observer-* no-record + read-only chain → allow", () => {
    const proj = tmpProject();
    const rec = findDispatchPermissionRecord(proj, "ga-observer-x", {})!;
    const d = evaluate({
      command: `cd ${proj} && git log --oneline -5`,
      role: rec.role,
      worktree: rec.worktree,
      cwd: proj,
      profile: rec.permission_profile,
      fenceRoots: rec.fence_roots,
    });
    expect(d.action).toBe("allow");
  });

  test("ga-observer-* no-record + mkdir → deny (gate discipline)", () => {
    const proj = tmpProject();
    const rec = findDispatchPermissionRecord(proj, "ga-observer-x", {})!;
    const d = evaluate({
      command: `mkdir ${proj}/newdir`,
      role: rec.role,
      worktree: rec.worktree,
      cwd: proj,
      profile: rec.permission_profile,
      fenceRoots: rec.fence_roots,
    });
    expect(d.action).toBe("deny");
  });

  test("ga-guardian-* and ga-refuter-* are likewise promoted", () => {
    const proj = tmpProject();
    expect(findDispatchPermissionRecord(proj, "ga-guardian-w496", {})!.role).toBe("guardian");
    expect(findDispatchPermissionRecord(proj, "ga-refuter-x", {})!.role).toBe("refuter");
  });

  test("ga-worker-* with no record is NOT promoted (stays baseline / null record)", () => {
    const proj = tmpProject();
    expect(findDispatchPermissionRecord(proj, "ga-worker-x", {})).toBeNull();
  });

  test("a non-garelier name with no record is NOT promoted", () => {
    const proj = tmpProject();
    expect(findDispatchPermissionRecord(proj, "random-observer", {})).toBeNull();
  });
});

describe("bare-hash payload → cd-target record fallback (W-133)", () => {
  const HASH = "ab3c4ca546985fbaa"; // a real payload's hash-only agent_id, keys no record

  test("no agent match + cd into a dispatch checkout → adopts that container's record", () => {
    const proj = tmpProject();
    const checkout = makeContainer(proj, "5");
    const rec = findDispatchPermissionRecord(proj, HASH, {}, `cd ${checkout} && git status`);
    expect(rec).not.toBeNull();
    expect(rec!.permission_profile).toBe("producer");
    expect(rec!.fence_roots.map((r) => r.replace(/\\/g, "/"))).toEqual([checkout]);
  });

  test("no agent match + cd into checkout + read-only chain → allow (RED→GREEN)", () => {
    const proj = tmpProject();
    const checkout = makeContainer(proj, "5");
    const command = `cd ${checkout} && git status`;
    const rec = findDispatchPermissionRecord(proj, HASH, {}, command)!;
    const d = evaluate({
      command,
      role: rec.role,
      worktree: rec.worktree,
      cwd: checkout,
      profile: rec.permission_profile,
      fenceRoots: rec.fence_roots,
    });
    expect(d.action).toBe("allow");
  });

  test("no agent match + NO cd → baseline (null record, unchanged)", () => {
    const proj = tmpProject();
    makeContainer(proj, "5");
    expect(findDispatchPermissionRecord(proj, HASH, {}, "git status")).toBeNull();
  });

  test("cd into a DIFFERENT container → that container's record (fence protects)", () => {
    const proj = tmpProject();
    makeContainer(proj, "5");
    const checkoutB = makeContainer(proj, "6");
    const rec = findDispatchPermissionRecord(proj, HASH, {}, `cd ${checkoutB} && ls`);
    expect(rec).not.toBeNull();
    expect(rec!.fence_roots.map((r) => r.replace(/\\/g, "/"))).toEqual([checkoutB]);
  });
});
