// W-343: proves `applyLandingFinalization` / `finalizeLongMergeEvidence` call
// the new closure finalize-order guard (FR9) BEFORE touching anything else.
// Absent any closure lease this is a pure no-op — the guard call fails on the
// SAME pre-existing error class (config/schema) any call with an incomplete
// fixture would already hit, so these fixtures deliberately stop short of a
// full valid Control tree: the guard runs first and must fail on ITS OWN
// deferred-finalize reason, proving the wiring, before Control validation
// would ever run.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rmSync } from "../guard/path_guard.ts"; // W-343 REWORK M6: path_guard lint forbids a raw node:fs destructive import
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLandingFinalization, finalizeLongMergeEvidence } from "./landing_finalize.ts";
import { acquireClosure, bindClosureResult, activateClosure, sha256Hex } from "../integration_closure.ts";

const STUDIO_BRANCH = "garelier/main/p/studio";

function makeProject(): { projectRoot: string; cleanup(): void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "landing-finalize-closure-"));
  const pmDir = join(projectRoot, "__garelier", "p", "_crew", "pm");
  mkdirSync(pmDir, { recursive: true });
  writeFileSync(
    join(pmDir, "setup_config.toml"),
    `[project]\nname="p"\n\n[branches]\nintegration="${STUDIO_BRANCH}"\ntarget="main"\n\n[prompt]\nspec_files=["AGENTS.md"]\n`,
  );
  return { projectRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
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
    const roots = { projectRoot, targetRoot: projectRoot, pmId: "p", controlRoot: join(projectRoot, "control"), runtimeRoot: join(projectRoot, "__garelier", "p", "runtime") };
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
    const roots = { projectRoot, targetRoot: projectRoot, pmId: "p", controlRoot: join(projectRoot, "control"), runtimeRoot: join(projectRoot, "__garelier", "p", "runtime") };
    expect(() => finalizeLongMergeEvidence({
      roots, workId: "W-998", sessionId: "cs_1", requestPath: "x", resultPath: "y", reportPath: "z", studioCommit: "c".repeat(40),
    })).toThrow(/finalize is deferred/);
  } finally {
    cleanup();
  }
});

test("the finalize guard is a no-op for a Work NOT bound to the active closure lease, or with none active", () => {
  const { projectRoot, cleanup } = makeProject();
  try {
    activeLeaseFor(projectRoot, "W-999");
    const roots = { projectRoot, targetRoot: projectRoot, pmId: "p", controlRoot: join(projectRoot, "control"), runtimeRoot: join(projectRoot, "__garelier", "p", "runtime") };
    // A DIFFERENT Work than the one the lease is bound to must fail on normal
    // Control validation (missing project_dashboard etc.), never on "deferred".
    expect(() => applyLandingFinalization({
      roots, workId: "W-001", expectedPlanDigest: "irrelevant", expectedControlRevision: "irrelevant",
    })).not.toThrow(/finalize is deferred/);
  } finally {
    cleanup();
  }
});
