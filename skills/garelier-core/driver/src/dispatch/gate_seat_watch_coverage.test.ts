import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";
import { scanIdleNoRegister, stallScan } from "./contract_check.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function pmRootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "garelier-gate-seat-"));
  scratch.push(root);
  mkdirSync(join(root, "_crew"), { recursive: true });
  return root;
}

/** A gate seat as dispatch_prepare shapes it: no seat worktree, the integration
 * branch, read-only. */
function gateSeat(pmRoot: string, id: string, role: "guardian" | "observer", slug: string, state = "WORKING"): string {
  const container = join(pmRoot, "_crew", `dispatch${id}`);
  mkdirSync(join(container, "lane"), { recursive: true });
  writeFileSync(join(container, "STATE.md"), `# Dispatch #${id} - ${role} ${slug}\n\n## Status\n\n${state}\n\n## Current task\n\n#${id} ${slug} (garelier/x/studio)\n`);
  writeFileSync(join(container, "context.json"), JSON.stringify({
    task: { role, slug, branch: "garelier/x/studio" }, commit_mode: "read-only",
  }));
  return container;
}

/** A work seat: its own checkout worktree is the write destination. */
function workSeat(pmRoot: string, id: string, slug: string): string {
  const container = join(pmRoot, "_crew", `dispatch${id}`);
  mkdirSync(join(container, "checkout"), { recursive: true });
  mkdirSync(join(container, "lane"), { recursive: true });
  writeFileSync(join(container, "STATE.md"), `# Dispatch #${id} - worker ${slug}\n\n## Status\n\nWORKING\n\n## Current task\n\n#${id} ${slug} (branch)\n`);
  writeFileSync(join(container, "context.json"), JSON.stringify({ task: { role: "worker", slug, base_sha: "0".repeat(40) } }));
  return container;
}

function publishVerdict(pmRoot: string, role: "guardian" | "observer", slug: string, body = "## Verdict\n\nPASS\n"): void {
  const dir = join(pmRoot, "runtime", role, "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}-${role}.md`), body);
}

const noGit = () => ({ code: 1, stdout: "" });
const noProcs = () => [];
const scanOpts = { nowMs: Date.now(), heartbeats: [], waiterLabels: new Set<string>(), spawnGraceSec: 0 };

describe("gate seat watch coverage", () => {
  test("a WORKING gate seat is never counted as unwatched", () => {
    const pmRoot = pmRootFixture();
    gateSeat(pmRoot, "427", "guardian", "verification-surface");
    workSeat(pmRoot, "426", "verification-surface");

    const scan = stallScan(pmRoot, noGit, noProcs, scanOpts);
    const gate = scan.items.find((item) => item.dispatch === "427");
    const work = scan.items.find((item) => item.dispatch === "426");

    expect(gate?.watch).toBe("not-applicable");
    expect(scan.unwatched).not.toContain("427");
    expect(scan.unwatched_detail.map((d) => d.dispatch)).not.toContain("427");
    // Counterfactual: the work seat with no heartbeat IS still unwatched, so the
    // gate-seat exclusion is not "the detector was switched off".
    expect(work?.watch).toBe("unwatched");
    expect(scan.unwatched).toContain("426");
  });

  test("publishing a verdict is the gate seat's observable progress", () => {
    const pmRoot = pmRootFixture();
    gateSeat(pmRoot, "427", "guardian", "verification-surface");

    const before = stallScan(pmRoot, noGit, noProcs, scanOpts).items.find((i) => i.dispatch === "427");
    expect(before?.gate_verdict).toBe("absent");

    publishVerdict(pmRoot, "guardian", "verification-surface");
    const after = stallScan(pmRoot, noGit, noProcs, scanOpts).items.find((i) => i.dispatch === "427");

    expect(after?.gate_verdict).toBe("published");
    // The fleet confirm fingerprint is `tip_sha|dirty_hash|dirty`; it must MOVE on
    // gate progress, otherwise a gate seat can never be distinguished from a
    // frozen one.
    expect(after?.dirty_hash).not.toBe(before?.dirty_hash);
    expect(before?.dirty_hash).toBeTruthy();
  });

  test("a gate seat that stops without a verdict is still detected", () => {
    const pmRoot = pmRootFixture();
    gateSeat(pmRoot, "427", "guardian", "verification-surface", "REPORTING");

    const idle = scanIdleNoRegister(pmRoot, noGit, noProcs, { nowMs: Date.now(), spawnGraceSec: 0, waiterLabels: new Set() });
    const entry = idle.find((item) => item.dispatch === "427");
    expect(entry?.kind).toBe("gate-no-verdict");

    const scan = stallScan(pmRoot, noGit, noProcs, scanOpts);
    expect(scan.items.find((i) => i.dispatch === "427")?.judgement).toBe("ungated-reporting");
    expect(scan.ok).toBeFalse();
  });

  test("a gate seat that published its verdict leaves the actionable set", () => {
    const pmRoot = pmRootFixture();
    gateSeat(pmRoot, "427", "guardian", "verification-surface", "REPORTING");
    publishVerdict(pmRoot, "guardian", "verification-surface");

    const scan = stallScan(pmRoot, noGit, noProcs, scanOpts);
    expect(scan.items.find((i) => i.dispatch === "427")).toBeUndefined();
    expect(scan.ok).toBeTrue();
  });
});
