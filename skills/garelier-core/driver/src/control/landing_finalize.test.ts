// W-343/W-859: prove both landing entrypoints enforce the FR9 closure order.
// applyLandingFinalization checks before planning; finalizeLongMergeEvidence
// checks after authenticating the request, result, and landed Git history so
// an already-recorded replay can finish after the producer container is gone.
// The fixtures reach each entrypoint's actual guard without bypassing Control
// namespace or evidence validation.

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rmSync } from "../guard/path_guard.ts"; // W-343 REWORK M6: path_guard lint forbids a raw node:fs destructive import
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLandingFinalization, finalizeLongMergeEvidence } from "./landing_finalize.ts";
import { acquireClosure, bindClosureResult, activateClosure, sha256Hex } from "../integration_closure.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";
import { writeV3Fixture } from "./fixtures/v3_control.ts";

const STUDIO_BRANCH = "garelier/main/p/studio";

function makeProject(): { projectRoot: string; cleanup(): void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "landing-finalize-closure-"));
  const pmDir = join(projectRoot, "__garelier", "p", "_crew", "pm");
  mkdirSync(pmDir, { recursive: true });
  writeFileSync(
    join(pmDir, "setup_config.toml"),
    `[project]\nname="p"\n\n[branches]\nintegration="${STUDIO_BRANCH}"\ntarget="main"\n\n[prompt]\nspec_files=["AGENTS.md"]\n`,
  );
  writeV3Fixture(projectRoot, 2, "p");
  return { projectRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

function gitFixture(projectRoot: string, ...args: string[]): string {
  const result = spawnSync(requireRuntimeExecutable("git"), ["-C", projectRoot, ...args], {
    encoding: "utf8", windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function activeLeaseFor(projectRoot: string, workId: string) {
  const rec = acquireClosure(projectRoot, "p", STUDIO_BRANCH, {
    owner_session: "s1",
    base_studio_sha: "a".repeat(40),
    origin_request_digest: sha256Hex("origin"),
    closure_work_id: workId,
  });
  const fence = { lease_id: rec.lease_id, nonce: rec.nonce, fencing_epoch: rec.fencing_epoch };
  bindClosureResult(projectRoot, "p", fence, sha256Hex("result"), "b".repeat(40));
  activateClosure(projectRoot, "p", fence);
}

test("applyLandingFinalization refuses out-of-order finalize while its bound closure lease is active (FR9)", () => {
  const { projectRoot, cleanup } = makeProject();
  try {
    activeLeaseFor(projectRoot, "W-999");
    const roots = { projectRoot, targetRoot: projectRoot, pmId: "p", controlRoot: join(projectRoot, "__garelier", "p", "control"), runtimeRoot: join(projectRoot, "__garelier", "p", "runtime", "control") };
    expect(() => applyLandingFinalization({
      roots, workId: "W-999", expectedPlanDigest: "irrelevant", expectedControlRevision: "irrelevant",
    })).toThrow(/finalize is deferred/);
  } finally {
    cleanup();
  }
});

test("finalizeLongMergeEvidence refuses out-of-order finalize while its bound closure lease is active (FR9)", () => {
  const { projectRoot, cleanup } = makeProject();
  try {
    activeLeaseFor(projectRoot, "W-998");
    const roots = { projectRoot, targetRoot: projectRoot, pmId: "p", controlRoot: join(projectRoot, "__garelier", "p", "control"), runtimeRoot: join(projectRoot, "__garelier", "p", "runtime", "control") };
    gitFixture(projectRoot, "init", "-q");
    gitFixture(projectRoot, "-c", "user.name=CI", "-c", "user.email=ci@ci", "commit", "--allow-empty", "-qm", "fixture");
    gitFixture(projectRoot, "branch", STUDIO_BRANCH);
    const studioCommit = gitFixture(projectRoot, "rev-parse", "HEAD");
    const requestPath = join(projectRoot, "request.json");
    const resultPath = join(projectRoot, "result.json");
    writeFileSync(requestPath, JSON.stringify({ request_id: "r1", work_id: "W-998", control_session_id: "cs_1", workbench_tip: studioCommit }));
    writeFileSync(resultPath, JSON.stringify({ request_id: "r1", work_id: "W-998", control_session_id: "cs_1", status: "success", workbench_tip: studioCommit, studio_commit: studioCommit }));
    expect(() => finalizeLongMergeEvidence({
      roots, workId: "W-998", sessionId: "cs_1", requestPath, resultPath, reportPath: "z", studioCommit,
    })).toThrow(/finalize is deferred/);
  } finally {
    cleanup();
  }
});

test("the finalize guard is a no-op for a Work NOT bound to the active closure lease, or with none active", () => {
  const { projectRoot, cleanup } = makeProject();
  try {
    activeLeaseFor(projectRoot, "W-999");
    const roots = { projectRoot, targetRoot: projectRoot, pmId: "p", controlRoot: join(projectRoot, "__garelier", "p", "control"), runtimeRoot: join(projectRoot, "__garelier", "p", "runtime", "control") };
    // A DIFFERENT Work than the one the lease is bound to reaches normal
    // Control validation, never the closure's "deferred" refusal.
    expect(() => applyLandingFinalization({
      roots, workId: "W-001", expectedPlanDigest: "irrelevant", expectedControlRevision: "irrelevant",
    })).not.toThrow(/finalize is deferred/);
  } finally {
    cleanup();
  }
});
