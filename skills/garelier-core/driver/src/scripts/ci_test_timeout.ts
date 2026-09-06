// Garelier CI (W-148) — realistic per-test timeout for the driver unit-test step.
//
// Root cause of the recurring 1-2 spurious failures on every full `bun test` run:
// tests that spawn a real subprocess (bun/git) or walk the repo tree probabilistically
// exceed bun's DEFAULT 5000ms per-test budget when a heavy compile runs in parallel on
// the RAM-bound box (measured overruns: 5007ms / 7480ms / 9584ms — different tests fall
// on different runs, so a point fix is impossible; the BUDGET is the cause). bunfig.toml
// `[test] timeout` is NOT honored by bun (probed 2026-07-21), so the only lever is the
// CLI `--timeout`. ci.ts supplies this realistic budget; a green test's runtime is
// unchanged (the budget is a CEILING before a HANG fails, not a delay), so standalone
// timing is unaffected — only a starved subprocess gets the headroom it needs.
//
// Kept in its own module so a unit test can import the constant/helper WITHOUT running
// ci.ts's top-level side effects (the node_modules preflight that may process.exit).

// 6x the default 5000ms — covers the worst measured overrun (9584ms) with margin,
// while still failing a genuinely hung test in bounded time.
export const DRIVER_UNIT_TEST_TIMEOUT_MS = 30000;

// Shell-backed CI oracles may contain bounded integration work. Keep the
// production budget importable so tests assert the contract rather than pinning
// ci.ts implementation text (W-453).
export const SHELL_ORACLE_TIMEOUT_MS = 600_000;

// W-737: the per-scenario failure deadline for the aggregate's heavyweight
// subprocess scenarios (`register gate audit …`, `W617 lifecycle bundle
// regression`). Same root cause as DRIVER_UNIT_TEST_TIMEOUT_MS one level down:
// the budget, not any one scenario, was the defect. Both scenarios spawn dozens
// of real bun/git child processes, and on a box that also compiles they ran past
// a 40,000ms deadline three times running (2026-09-06 #470: worker ×2, Dock ×1,
// each over 100s) while the SAME scenario passes standalone — a machine-speed
// threshold deciding pass/fail ("wall clock is not a verdict").
//
// The value is 2x the largest measurement taken under a parallel cargo build,
// rounded up. Measured on this box 2026-09-06 with `cargo check --workspace`
// alongside and rustc process counts sampled every 30s for the whole window,
// via `GARELIER_TEST_TIMING=1` W318_TIMING `scenario_ms`:
//
//   register gate audit          106,913ms (light load) / 120,649ms (heavy)
//   W617 lifecycle bundle regr.  100,750ms (idle) / 122,633ms / 280,906ms
//
// and one run where W617 did not finish inside a 300,000ms deadline at all
// (elapsed 318,427ms at the cut-off). The spread on one machine is ~3x, which
// is the whole point: the budget was the defect, not any one scenario. 660,000
// is 2x that largest observed elapsed, rounded up to the minute.
//
// This is a CEILING before a hang fails, not a delay: a green scenario's
// runtime is unchanged. `group()` derives each group's timeout as
// `max(longestCase + 30_000, …)` so the group always outlasts its longest case;
// a cap applied on top of that would make this constant unreachable.
export const AGGREGATE_SCENARIO_DEADLINE_MS = 660_000;

// W-737: a test that WALKS the whole repository — and, in the inventory test's
// case, additionally spawns a process that walks it again — is not the class
// DRIVER_UNIT_TEST_TIMEOUT_MS sizes. That budget covers a test that spawns one
// subprocess; a double repo walk is bounded by tree size, not by process
// startup. Measured on this box with an idle machine: the W-327 inventory test
// takes 26,460ms against the 30,000ms it used to borrow, a 12 percent margin
// that timed out twice today in the development checkout while passing in the
// export tree, whose tree is smaller because it carries no dogfooding state.
// The same justification is already written at the other two walkers
// (path_guard_lint, timeout_env_lint), so all three take this.
export const REPOSITORY_WALK_TEST_TIMEOUT_MS = 4 * DRIVER_UNIT_TEST_TIMEOUT_MS;

// A bounded wait for one OBSERVATION inside such a scenario (a trace/pid file
// the child writes). Derived from the deadline above so the two cannot drift:
// waiting must stay well inside the scenario's own budget, or a genuinely
// missing artifact reports as a deadline instead of as the assertion that names
// it. #466 r2 measured the other half of the same race — `taskkillTrace` read as
// "" because the assertion outran the child's write under load, failing on an
// ASSERTION rather than a timeout.
//
// That sentence is a CHECKABLE INVARIANT, not a hope, and round 2 shipped it
// false (#474 Guardian): the budget is an eighth of the group constant, so it
// only stays inside a case whose own deadline IS that constant. A case still
// declaring 40,000 gave the observation 2.06x its enclosing budget, which made
// the named `live step did not start` diagnosis unreachable — a genuinely
// missing observation would die on the case race first, reporting a generic
// timeout instead. The invariant to preserve when adding a call site:
//
//   every scenario containing an observation wait declares
//   AGGREGATE_SCENARIO_DEADLINE_MS as its own case deadline
//
// so the wait is 1/8 of the case budget and the assertion always wins the race.
// Census that holds it (2026-09-06, round 4, corrected): this budget is read at
// SIX places in the aggregate — five `awaitObservation` calls and one direct
// `traceDeadline` — and they sit in TWO scenarios, not three: "W-385 keeps CI
// artifacts outside dependencies and gate logs in PM runtime" (three of them,
// inline) and "W617 lifecycle bundle regression" (the other three, reached
// through `assertW387RoleBindingAuthorityAndRecovery`). Both declare the
// constant as their case deadline. The three scenarios still declaring 40,000
// contain no observation wait.
export function aggregateObservationWaitMs(): number {
  return Math.round(AGGREGATE_SCENARIO_DEADLINE_MS / 8);
}

// The argv for the driver unit-test invocation: `bun test --timeout=<ms>`.
export function driverUnitTestArgs(timeoutMs: number = DRIVER_UNIT_TEST_TIMEOUT_MS): string[] {
  return ["test", `--timeout=${timeoutMs}`];
}
