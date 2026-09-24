/**
 * A terminal state produced by the attended physical-GC path that existed
 * before `container_removed` became a journal state.  These records are live,
 * hash-chain-authenticated machine state, not a legacy wire format: physical
 * removal already happened while the last durable journal revision still says
 * `views_refreshed` (or, for an earlier cut, `container_retired`).
 */
export function isAttendedGcTerminal(
  journal: {
    state?: unknown;
    pending_step?: unknown;
    envelope?: { physical_gc_pending?: unknown } | null;
  },
  containerPresent: boolean,
): boolean {
  return !containerPresent
    && (journal.state === "container_retired" || journal.state === "views_refreshed")
    && journal.pending_step === null
    && journal.envelope?.physical_gc_pending === true;
}
