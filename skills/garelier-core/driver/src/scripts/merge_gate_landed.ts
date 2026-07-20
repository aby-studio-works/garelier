// W-054 landed-check decision (extracted from merge-gate.ts so it is unit-testable).
//
// When the merge gate hits a signal / late crash with STATUS still unset,
// cleanup_and_abort must NOT report a false "aborted" if the merge commit this
// gate was running already landed on studio. Ground truth (mirrors
// dispatch_cleanup.ts's merge_status_for_branch): is the workbench branch now an
// ancestor of HEAD? If so → success (report the landed commit); else → aborted;
// an unresolved branch fails closed to aborted.
//
// This is the SAME decision the merge-gate.ts parity oracle (the retained bash
// cleanup_and_abort(), pinned by merge_gate_landed_check.test.ts) encodes, kept
// in one place so the shipped TS path is directly bun-testable.

export interface W054Outcome {
  status: "success" | "aborted";
  commit: string;
}

// gitAt runs `git -C <cwd> <args>` and returns { code, stdout }. Injected so the
// caller (merge-gate.ts) reuses its own runner and tests can drive a real repo.
import { requireRuntimeExecutable } from "./_lib.ts";
export function w054LandedOutcome(
  workbenchBranch: string,
  gitAt: (args: string[]) => { code: number; stdout: string },
): W054Outcome {
  let landedCommit = "";
  if (
    workbenchBranch &&
    gitAt(["rev-parse", "--verify", "-q", workbenchBranch]).code === 0 &&
    gitAt(["rev-parse", "--verify", "-q", "HEAD"]).code === 0 &&
    gitAt(["merge-base", "--is-ancestor", workbenchBranch, "HEAD"]).code === 0
  ) {
    const h = gitAt(["rev-parse", "HEAD"]);
    landedCommit = h.code === 0 ? h.stdout.trim() : "";
  }
  return landedCommit ? { status: "success", commit: landedCommit } : { status: "aborted", commit: "" };
}

// CLI: `merge_gate_landed.ts <repo> <workbench-branch>` prints the decision as two
// lines (status, commit) — the drive point for merge_gate_landed_check.test.ts.
if (import.meta.main) {
  const repo = process.argv[2] ?? "";
  const workbench = process.argv[3] ?? "";
  const gitAt = (args: string[]): { code: number; stdout: string } => {
    const r = Bun.spawnSync([requireRuntimeExecutable("git"), "-C", repo, ...args], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, stdout: r.stdout?.toString() ?? "" };
  };
  const o = w054LandedOutcome(workbench, gitAt);
  process.stdout.write(`${o.status}\n${o.commit}\n`);
}
