// Shared test helper (W-166 N-4) — await a streamed substring on a child's live
// stderr. Extracted from heavy_compile_lock.test.ts / heavy_compile_lock_w156.test.ts,
// which each carried a byte-identical copy.
//
// Real-subprocess grace/queue tests must wait for the ACTUAL streamed line (e.g. the
// "waiting reason=…" queue heartbeat) rather than a fixed wall-clock sleep — a fixed
// sleep races the child's poll and flakes under machine load (the W-148 class). This
// subscribes to stderr data until the needle appears, bounded so a genuinely stuck child
// FAILS the test instead of hanging. Load-independent: it waits for the line however
// slow the box is.

export interface StderrSource {
  getStderr: () => string;
  onStderr: (listener: () => void) => () => void;
}

export function waitForStderr(pending: StderrSource, needle: string, timeoutMs = 20000): Promise<boolean> {
  if (pending.getStderr().includes(needle)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (matched: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(matched);
    };
    timer = setTimeout(() => finish(pending.getStderr().includes(needle)), timeoutMs);
    unsubscribe = pending.onStderr(() => {
      if (pending.getStderr().includes(needle)) finish(true);
    });
    // Close the subscribe/check race without a polling interval.
    if (pending.getStderr().includes(needle)) finish(true);
  });
}
