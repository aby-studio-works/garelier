// W-622 (blueprint §2.1) — which tool owns which flag.
//
// merge_land is a composition macro: it forwards every argument it does not
// recognize to merge_request.ts. That is a promise it could not check, because
// the accepted set on the other side existed only as a hard-coded English
// sentence inside a refusal message. So `--rebind-authority` — a dispatch_prepare
// flag — passed merge_land, was forwarded, and died one process later as
// `merge_request: unknown arg`. Read at the terminal, that names the wrong tool.
//
// This module publishes the inventories the delegator needs to check its promise
// BEFORE spawning, and to say which tool a misplaced flag actually belongs to.
// The switch statements remain the executable authority; the corresponding tests
// assert each inventory and its parser agree in BOTH directions, so a flag can
// neither be advertised without being accepted nor accepted without being listed.
//
// Deliberately NOT a registry every script must enroll in: it holds only the
// inventories that cross a delegation boundary, which is the only place the
// mismatch can hide.

/** dispatch_prepare.ts's accepted flags (`-h`/`--help` omitted: every entrypoint
 * handles those and they never cross a delegation boundary). */
export const DISPATCH_PREPARE_FLAGS: readonly string[] = [
  "--project", "--target-root", "--pm-id", "--role", "--slug", "--base",
  "--blueprint", "--pipeline-package", "--work-id", "--control-session",
  "--provider", "--provider-transport", "--task-file", "--reuse", "--row",
  "--recover-role", "--recovery-dispatch", "--recovery-branch", "--recovery-reason",
  "--expected-previous-digest", "--item-authority", "--assignment-path",
  "--prompt-path", "--initial-instructions-path", "--recovery-wip",
  "--acceptance-id", "--rebind-authority", "--id", "--evidence", "--candidate-sha",
  "--approved-remote", "--model", "--effort", "--commit-mode", "--resource-class",
  "--runtime-effect", "--heavy-tier", "--bash-budget-ms", "--scope", "--tags",
  "--touches", "--depends-on", "--allow-conflict", "--full-gate", "--rework",
  "--force", "--attended-seat", "--ack-launch",
];

/** merge_request.ts's accepted flags — the set merge_land's forwarding promise
 * is measured against. Lives here rather than in merge_request.ts so merge_land
 * can check the promise without importing the delegate it is about to spawn. */
export const MERGE_REQUEST_FLAGS: readonly string[] = [
  "--project", "--target-root", "--pm-id", "--branch", "--task", "--work-id",
  "--control-session", "--report", "--dispatch-id", "--aftercare-binding",
  "--execution-route", "--expected-studio-sha", "--guardian", "--observer",
  "--guardian-report", "--observer-report", "--guardian-review-sha",
  "--observer-review-sha", "--message", "--studio", "--core", "--quality-gate",
  "--preflight", "--refuter-verdict", "--refuter-report", "--high-stakes",
  "--notify", "--no-poll",
];

/** merge_land.ts's own flags — the ones it consumes rather than forwards. */
export const MERGE_LAND_FLAGS: readonly string[] = [
  "--project", "--pm-id", "--target-root", "--branch", "--guardian", "--observer",
  "--work-id", "--control-session", "--report", "--seat-trailer", "--dispatch-id",
  "--id", "--no-pull", "--close-row", "--max-wait", "--poll-interval", "--batch",
  "--message",
];

/** Flags that belong to a tool OTHER than the two a merge_land invocation can
 * reach, keyed by flag.
 *
 * A flag any of the reachable tools accepts (`--project`, `--work-id`, …) is not
 * misplaced and must not be reported as such — the exclusions below are what
 * keep this a pointer rather than a guess. Derived from the inventories above so
 * it cannot drift out of step with them. */
export const OTHER_TOOL_FLAG_OWNERS: Readonly<Record<string, string>> = Object.fromEntries(
  DISPATCH_PREPARE_FLAGS
    .filter((flag) => !MERGE_LAND_FLAGS.includes(flag) && !MERGE_REQUEST_FLAGS.includes(flag))
    .map((flag) => [flag, "dispatch_prepare.ts"]),
);
