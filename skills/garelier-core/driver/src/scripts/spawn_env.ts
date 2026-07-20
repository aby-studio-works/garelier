// gateEnv — the single source of truth for the merge gate's child-process env.
//
// W-123: on Windows Bun an in-process `process.env.X = ...` / `delete
// process.env.X` does NOT propagate to spawnSync/spawn children — the child
// inherits the env snapshotted at process start, not the mutated one (proven:
// `bun -e 'process.env.X="1"; spawnSync(["sh","-c","echo ${X:-UNSET}"])'` →
// UNSET). merge-gate.ts historically relied on top-level `process.env`
// mutations (GARELIER_MERGE_GATE_COMMIT / GIT_TERMINAL_PROMPT set, RUSTC_WRAPPER
// deleted) reaching git and the quality-gate compile. On Windows Bun they did
// not, so (a) the gate's own merge commit was blocked by the commit_guard hook
// AFTER a full quality-gate pass (real abort, aby_works #347, 2026-07-17) and
// (b) the quality gate compiled through sccache from a stale RUSTC_WRAPPER
// (broken-rlib #346 class). The fix is to pass an EXPLICIT env object — a spread
// of the current process.env DOES carry mutations to the child — at every
// spawn. Centralized here so the marker set can never drift between call sites.
//
// A key whose value is `undefined` is dropped from the child env by Bun (proven:
// `{ ...process.env, RW: undefined }` → child sees RW UNSET), which is exactly
// the unset semantics the RUSTC wrappers need.

/** The child-process env for every merge-gate spawn: the commit marker + no
 * interactive git prompt + the RUSTC wrappers unset, layered over the current
 * process env. Extra overrides win last. */
export function gateEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    GARELIER_MERGE_GATE_COMMIT: "1",
    GIT_TERMINAL_PROMPT: "0",
    RUSTC_WRAPPER: undefined,
    RUSTC_WORKSPACE_WRAPPER: undefined,
    ...overrides,
  };
}
