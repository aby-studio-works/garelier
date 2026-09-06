import { rmSync } from "./guard/path_guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { waitForStderr } from "./child_stderr_wait.ts";
import { systemProcessStartTimeMs } from "./integration_closure.ts";
import { parseOwnerPid, staleReason, describeLostSlotFromLog } from "../../scripts/heavy_compile_lock.ts";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "heavy_compile_lock.ts");
const PM = "tpm";
const tmps: string[] = [];

afterEach(() => {
  for (const path of tmps.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function project(config: string): { root: string; lockDir: string } {
  const root = mkdtempSync(join(tmpdir(), "garelier-hcl-w156-"));
  tmps.push(root);
  mkdirSync(join(root, "__garelier", PM, "_crew", "pm"), { recursive: true });
  writeFileSync(join(root, "__garelier", PM, "_crew", "pm", "setup_config.toml"), config);
  return { root, lockDir: join(root, "__garelier", PM, "runtime", "locks", "heavy_compile") };
}

function processIdentity(pidField: string): string {
  const pid = parseOwnerPid(pidField);
  if (pid === null) return "unknown";
  const startMs = systemProcessStartTimeMs(pid);
  return startMs === null ? "unknown" : `${hostname()}:${pid}:${startMs}`;
}

function hold(lockDir: string, pidField: string, ageMin = 0, slotIndex = 0,
  identity = processIdentity(pidField)): string {
  const slot = join(lockDir, `slot-${slotIndex}`);
  mkdirSync(slot, { recursive: true });
  const owner = join(slot, "owner");
  writeFileSync(owner, `${pidField}|held|${new Date().toISOString()}|${identity}`);
  if (ageMin > 0) {
    const time = new Date(Date.now() - ageMin * 60_000);
    utimesSync(owner, time, time);
  }
  return slot;
}

function env(mem = "100,128", compiles = "0"): Record<string, string> {
  return {
    ...process.env,
    GARELIER_HC_MEM_GB: mem,
    GARELIER_HC_COMPILE_PROCS: compiles,
  } as Record<string, string>;
}

function run(root: string, args: string[], mem = "100,128", compiles = "0") {
  return spawnSync(process.execPath, [SCRIPT, "--project", root, "--pm-id", PM, ...args], {
    windowsHide: true, encoding: "utf8", env: env(mem, compiles), timeout: 10_000,
  });
}

function runAsync(root: string, args: string[], mem = "100,128", compiles = "0") {
  const child = spawn(process.execPath, [SCRIPT, "--project", root, "--pm-id", PM, ...args], {
    windowsHide: true, env: env(mem, compiles), stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const stderrListeners = new Set<() => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    for (const listener of stderrListeners) listener();
  });
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  // W-166: expose live stderr so a test can wait for a streamed line (the queue
  // heartbeat) instead of a fixed wall-clock sleep that races the child's poll.
  return {
    child,
    result,
    getStderr: () => stderr,
    onStderr: (listener: () => void) => {
      stderrListeners.add(listener);
      return () => { stderrListeners.delete(listener); };
    },
  };
}
// waitForStderr is the shared helper (W-166 N-4): see ./child_stderr_wait.ts.

const ASYNC_SUBPROC_TIMEOUT_MS = 30_000;

describe("W-156 owner pid and reclaim fallback", () => {
  // W-677: the 3 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("0, unknown, missing, and malformed owner pids parse as unknown (+2 folded cases)", () => {
    // case: 0, unknown, missing, and malformed owner pids parse as unknown
    {
      for (const value of ["0", "unknown", "", "12x"]) expect(parseOwnerPid(value)).toBeNull();
      expect(parseOwnerPid(String(process.pid))).toBe(process.pid);
    }
    // case: unknown/missing owner state requires grace plus compile-quiet confirmation
    {
      const base = {
        ownerExists: true, ageMin: 5, leaseMinutes: 240, staleMinutes: 30,
        hasPid: false, ownerProcessLive: false, compileCount: 0 as number | null,
        logProgressFreshMin: null as number | null,
      };
      expect(staleReason(base)).toBeNull();
      expect(staleReason({ ...base, ageMin: 300, compileCount: 2 })).toBeNull();
      expect(staleReason({ ...base, ageMin: 300, compileCount: 0 })).toBe("idle-no-compile");
      expect(staleReason({ ...base, ownerExists: false, ageMin: 5 })).toBeNull();
      expect(staleReason({ ...base, hasPid: true, ownerProcessLive: true, ageMin: 40, logProgressFreshMin: 40 }))
        .toBe("owner-live-idle");
      expect(staleReason({ ...base, hasPid: true, ownerProcessLive: true, ageMin: 40, logProgressFreshMin: 2 }))
        .toBeNull();
    }
    // case: acquire records unknown by default and the explicit long-lived pid when supplied
    {
      const unknown = project("[heavy_compile]\nmax_concurrent = 1\n");
      expect(run(unknown.root, ["--mode", "acquire", "--label", "unknown-owner"]).status).toBe(0);
      expect(readFileSync(join(unknown.lockDir, "slot-0", "owner"), "utf8"))
        .toMatch(/^unknown\|unknown-owner\|/);

      const explicit = project("[heavy_compile]\nmax_concurrent = 1\n");
      expect(run(explicit.root, ["--mode", "acquire", "--label", "real-owner", "--owner-pid", String(process.pid)]).status).toBe(0);
      const ownerFields = readFileSync(join(explicit.lockDir, "slot-0", "owner"), "utf8").split("|");
      expect(ownerFields.slice(0, 2)).toEqual([String(process.pid), "real-owner"]);
      expect(ownerFields[3]).toBe(processIdentity(String(process.pid)));
    }
  });

  test("fresh pid-0/unknown/missing leases are not reclaimed inside grace", async () => {
    const fixture = project("[heavy_compile]\nmax_concurrent = 3\nstale_minutes = 30\n");
    const slots = ["0", "unknown", ""].map((pidField, slotIndex) =>
      hold(fixture.lockDir, pidField, 5, slotIndex));
    // One real acquire evaluates every occupied slot before queueing. This keeps
    // all three malformed-owner boundaries without paying three Bun startups.
    const pending = runAsync(fixture.root, ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1"]);
    expect(await waitForStderr(pending, "waiting reason=slot-busy"), pending.getStderr()).toBe(true);
    expect(pending.child.exitCode).toBeNull();
    for (const slot of slots) {
      expect(existsSync(slot)).toBe(true);
    }
    expect(pending.getStderr()).not.toContain("reclaimed stale");
    for (const slot of slots) rmSync(slot, { recursive: true, force: true });
    const result = await pending.result;
    expect(result.stderr).not.toContain("reclaimed stale");
  }, ASYNC_SUBPROC_TIMEOUT_MS);

  test("dead and exact stale-live holders reclaim, recycled pids and compiling holders stay", async () => {
    const fixture = project("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 30\n");
    hold(fixture.lockDir, "2147483647", 1);
    const result = run(fixture.root, ["--mode", "acquire", "--timeout-sec", "5", "--poll-sec", "1"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("reclaimed stale slot-0 (owner-pid-dead)");
    // W-169(d): the reclaim audit records HOW the owner pid was probed. A max-int
    // pid is dead under every interpretation (OS signal, tasklist, MSYS ps).
    expect(readFileSync(join(fixture.lockDir, "reclaim.log"), "utf8")).toContain("probe=dead");

    const staleLive = project("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 1\nlease_minutes = 240\n");
    const staleHolder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      windowsHide: true, stdio: "ignore",
    });
    try {
      const staleSlot = hold(staleLive.lockDir, String(staleHolder.pid), 2);
      const staleProgress = join(staleSlot, "progress");
      writeFileSync(staleProgress, "stale\n");
      const staleTime = new Date(Date.now() - 2 * 60_000);
      utimesSync(staleProgress, staleTime, staleTime);
      const reclaimed = run(staleLive.root, ["--mode", "acquire", "--timeout-sec", "5", "--poll-sec", "1"]);
      expect(reclaimed.status, reclaimed.stderr).toBe(0);
      expect(reclaimed.stderr).toContain("reclaimed stale slot-0 (owner-live-idle)");
      expect(reclaimed.stderr).toContain("holder_stop=confirmed");
      process.stdout.write(`W560_IDLE_RECLAIM status=${reclaimed.status} ${reclaimed.stderr.trim().replace(/\r?\n/g, " | ")}\n`);
      await new Promise<void>((resolve, reject) => {
        if (staleHolder.exitCode !== null) return resolve();
        const timer = setTimeout(() => reject(new Error("exact stale holder did not exit")), 5_000);
        staleHolder.once("close", () => { clearTimeout(timer); resolve(); });
      });
    } finally {
      if (staleHolder.exitCode === null) staleHolder.kill();
    }

    const recycled = project("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 1\nlease_minutes = 240\n");
    const recycledProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      windowsHide: true, stdio: "ignore",
    });
    try {
      const observedStart = systemProcessStartTimeMs(recycledProcess.pid!);
      expect(observedStart).not.toBeNull();
      const staleIdentity = `${hostname()}:${recycledProcess.pid}:${observedStart! - 3_600_000}`;
      const recycledSlot = hold(recycled.lockDir, String(recycledProcess.pid), 2, 0, staleIdentity);
      const staleProgress = join(recycledSlot, "progress");
      writeFileSync(staleProgress, "stale\n");
      const staleTime = new Date(Date.now() - 2 * 60_000);
      utimesSync(staleProgress, staleTime, staleTime);
      const pending = runAsync(recycled.root, ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1"]);
      expect(await waitForStderr(pending, "process identity mismatch", 5_000), pending.getStderr()).toBe(true);
      expect(recycledProcess.exitCode).toBeNull();
      expect(existsSync(recycledSlot)).toBe(true);
      expect(readFileSync(join(recycled.lockDir, "reclaim.log"), "utf8"))
        .toContain("holder_stop=identity-mismatch");
      process.stdout.write(
        `W562_PID_REUSE_REFUSAL same_pid=${recycledProcess.pid} identity_match=false holder_alive=true reclaimed=false\n`,
      );
      rmSync(recycledSlot, { recursive: true, force: true });
      expect((await pending.result).status).toBe(0);

      const unconfirmed = project("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 1\nlease_minutes = 240\n");
      const unconfirmedSlot = hold(unconfirmed.lockDir, String(recycledProcess.pid), 2, 0, "unknown");
      const unconfirmedProgress = join(unconfirmedSlot, "progress");
      writeFileSync(unconfirmedProgress, "stale\n");
      utimesSync(unconfirmedProgress, staleTime, staleTime);
      const unconfirmedPending = runAsync(unconfirmed.root, ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1"]);
      expect(await waitForStderr(unconfirmedPending, "process identity could not be confirmed", 5_000), unconfirmedPending.getStderr()).toBe(true);
      expect(recycledProcess.exitCode).toBeNull();
      expect(existsSync(unconfirmedSlot)).toBe(true);
      expect(readFileSync(join(unconfirmed.lockDir, "reclaim.log"), "utf8"))
        .toContain("holder_stop=identity-unconfirmed");
      rmSync(unconfirmedSlot, { recursive: true, force: true });
      expect((await unconfirmedPending.result).status).toBe(0);
    } finally {
      if (recycledProcess.exitCode === null) recycledProcess.kill();
    }

    const compilingLive = project("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 1\nlease_minutes = 240\n");
    const compilingHolder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      windowsHide: true, stdio: "ignore",
    });
    try {
      const compilingSlot = hold(compilingLive.lockDir, String(compilingHolder.pid), 2);
      const compilingProgress = join(compilingSlot, "progress");
      writeFileSync(compilingProgress, "stale\n");
      const compilingTime = new Date(Date.now() - 2 * 60_000);
      utimesSync(compilingProgress, compilingTime, compilingTime);
      const pending = runAsync(
        compilingLive.root, ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1"],
        "100,128", "6",
      );
      expect(await waitForStderr(pending, "waiting reason=slot-busy"), pending.getStderr()).toBe(true);
      expect(existsSync(compilingSlot)).toBe(true);
      expect(compilingHolder.exitCode).toBeNull();
      expect(pending.getStderr()).not.toContain("reclaimed stale");
      rmSync(compilingSlot, { recursive: true, force: true });
      const acquired = await pending.result;
      expect(acquired.status, acquired.stderr).toBe(0);
      process.stdout.write(
        `W560_ACTIVE_KEEP holder_alive=${compilingHolder.exitCode === null} reclaimed=false waiter_status=${acquired.status} `
        + `${pending.getStderr().trim().replace(/\r?\n/g, " | ")}\n`,
      );
    } finally {
      if (compilingHolder.exitCode === null) compilingHolder.kill();
    }
  }, ASYNC_SUBPROC_TIMEOUT_MS);
});

describe("verified compile and gate-log liveness (progress + probe)", () => {
  // W-677: the 8 cases of this describe shared one fixture and are
  // folded into one definition. Every assertion is kept verbatim, each case in
  // its own block under the name it used to carry.
  test("fresh gate-log growth suppresses owner-pid-dead only when real progress exists (+7 folded cases)", () => {
    // case: fresh gate-log growth suppresses owner-pid-dead only when real progress exists
    {
      const deadPidDown = {
        ownerExists: true, ageMin: 21, leaseMinutes: 240, staleMinutes: 30,
        hasPid: true, ownerProcessLive: false, compileCount: 0 as number | null,
      };
      expect(staleReason({ ...deadPidDown, logProgressFreshMin: null })).toBe("owner-pid-dead");
      expect(staleReason({ ...deadPidDown, logProgressFreshMin: 2 })).toBeNull();
      expect(staleReason({ ...deadPidDown, logProgressFreshMin: 45 })).toBe("owner-pid-dead");
      expect(staleReason({ ...deadPidDown, compileCount: 6, logProgressFreshMin: null })).toBeNull();
    }
    // case: fresh gate-log growth also suppresses idle-no-compile and owner-missing
    {
      const idleUnknown = {
        ownerExists: true, ageMin: 300, leaseMinutes: 240, staleMinutes: 30,
        hasPid: false, ownerProcessLive: false, compileCount: 0 as number | null,
      };
      expect(staleReason({ ...idleUnknown, logProgressFreshMin: null })).toBe("idle-no-compile");
      expect(staleReason({ ...idleUnknown, logProgressFreshMin: 1 })).toBeNull();
      const missing = { ...idleUnknown, ownerExists: false };
      expect(staleReason({ ...missing, logProgressFreshMin: null })).toBe("owner-missing");
      expect(staleReason({ ...missing, logProgressFreshMin: 1 })).toBeNull();
    }
    // case: lease-expired stays an UNCONDITIONAL hard cap — log growth does not extend it
    {
      // The lease is
      // the safety net against a runaway forever-held slot regardless of process/
      // progress state. A live pid past the lease still reclaims with fresh growth.
      const pastLease = {
        ownerExists: true, ageMin: 500, leaseMinutes: 240, staleMinutes: 30,
        hasPid: true, ownerProcessLive: true, compileCount: null as number | null,
      };
      expect(staleReason({ ...pastLease, logProgressFreshMin: 1 })).toBe("lease-expired");
    }
    // case: acquire does not seed progress, and --mode progress records it
    {
      const fixture = project("[heavy_compile]\nmax_concurrent = 1\n");
      const result = run(fixture.root, ["--mode", "acquire", "--label", "seat-a"]);
      expect(result.status).toBe(0);
      const token = result.stdout.trim();
      const progressPath = join(token, "progress");
      expect(existsSync(progressPath)).toBe(false);

      const progress = run(fixture.root, ["--mode", "progress", "--token", token]);
      expect(progress.status).toBe(0);
      expect(progress.stdout).toContain("progress-ok slot-0");
      expect(readFileSync(progressPath, "utf8")).toContain("T");
    }
    // case: --mode probe truthfully reports HELD without side effects, then LOST after reclaim
    {
      // Five sequential Bun subprocess spawns comfortably exceed bun:test's 5s
      // default — the same reasoning ASYNC_SUBPROC_TIMEOUT_MS documents above.
      const fixture = project("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 30\n");
      const result = run(fixture.root, ["--mode", "acquire", "--label", "seat-b"]);
      const token = result.stdout.trim();
      const progressPath = join(token, "progress");
      expect(run(fixture.root, ["--mode", "progress", "--token", token]).status).toBe(0);
      const before = readFileSync(progressPath, "utf8");

      const probe1 = run(fixture.root, ["--mode", "probe", "--token", token]);
      expect(probe1.status).toBe(0);
      expect(probe1.stdout).toContain("HELD slot-0");
      expect(readFileSync(progressPath, "utf8")).toBe(before); // probe never writes

      // Simulate a reclaim happening elsewhere (owner pid dead, no log-growth cover).
      // Remove the whole slot so hold() creates a dead-pid holder without progress.
      rmSync(token, { recursive: true, force: true });
      hold(fixture.lockDir, "2147483647", 40); // ageMin 40 > staleMinutes 30, dead pid
      // --mode sweep only reclaims — unlike acquire, it never re-grabs the freed
      // slot for itself, so the slot stays genuinely empty afterward (an acquire
      // here would reclaim AND immediately re-acquire the same slot path, making
      // the "LOST" assertion below vacuous).
      const sweepResult = run(fixture.root, ["--mode", "sweep"]);
      expect(sweepResult.stdout.trim()).toBe("swept=1");

      const probe2 = run(fixture.root, ["--mode", "probe", "--token", token]);
      expect(probe2.status).toBe(1);
      expect(probe2.stdout).toContain("LOST slot-0");
      expect(probe2.stderr).toContain("reclaimed reason=owner-pid-dead");

      const progress2 = run(fixture.root, ["--mode", "progress", "--token", token]);
      expect(progress2.status).toBe(1);
      expect(progress2.stdout).toContain("progress-lost slot-0");
    }
    // case: describeLostSlotFromLog finds the last matching reclaim line, or says so plainly
    {
      const log = [
        "2026-08-05T15:00:00.000Z\treclaim\tslot-0\towner-pid-dead\tprobe=dead\towner=123|a|t",
        "2026-08-05T15:28:31.000Z\treclaim\tslot-0\tidle-no-compile\tprobe=unknown\towner=unknown|b|t",
      ].join("\n");
      expect(describeLostSlotFromLog(log, "slot-0")).toBe("reclaimed reason=idle-no-compile at=2026-08-05T15:28:31.000Z");
      expect(describeLostSlotFromLog(log, "slot-1")).toContain("no reclaim record found");
      expect(describeLostSlotFromLog("", "slot-0")).toContain("no reclaim record found");
    }
    // case: reclaim.log records the full liveness signal breakdown, not just the reason
    {
      const fixture = project("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 30\n");
      hold(fixture.lockDir, "2147483647", 40, 0);
      const result = run(fixture.root, ["--mode", "acquire", "--timeout-sec", "5", "--poll-sec", "1"], "100,128", "0");
      expect(result.status).toBe(0);
      const log = readFileSync(join(fixture.lockDir, "reclaim.log"), "utf8");
      expect(log).toContain("pid_alive=false");
      expect(log).toContain("log_progress_fresh=false");
      expect(log).toContain("compile_active=false");
      expect(log).toContain("owner_pid=2147483647");
      expect(log).toContain("owner_label=held"); // the hold() helper's literal label
    }
    // case: an unlabeled acquire no longer collides on a shared generic bucket
    {
      const a = project("[heavy_compile]\nmax_concurrent = 1\n");
      const b = project("[heavy_compile]\nmax_concurrent = 1\n");
      const ra = run(a.root, ["--mode", "acquire"]);
      const rb = run(b.root, ["--mode", "acquire"]);
      const ownerA = readFileSync(join(a.lockDir, "slot-0", "owner"), "utf8");
      const ownerB = readFileSync(join(b.lockDir, "slot-0", "owner"), "utf8");
      expect(ra.status).toBe(0);
      expect(rb.status).toBe(0);
      expect(ownerA).not.toContain("|heavy-compile|"); // no more shared generic default
      expect(ownerA).not.toBe(ownerB); // two different CLI pids => distinguishable labels
    }
  }, ASYNC_SUBPROC_TIMEOUT_MS);
});

describe("W-156 queue wait and OPEN contract", () => {
  test("RAM-budget rejection keeps waiting and reports reason=ram-budget", async () => {
    const fixture = project("[heavy_compile]\nmax_concurrent = 2\nbuild_ram_budget_gb = 16\n");
    const slot = hold(fixture.lockDir, "unknown");
    const pending = runAsync(
      fixture.root,
      ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1"],
      "5,32",
    );
    // Wait for the heartbeat to actually stream before freeing the slot — the old
    // fixed 1.2s sleep raced the child's 1s poll (under load Bun.sleepSync overshot
    // and the acquire grabbed the freed slot before the "still waiting" heartbeat
    // logged, dropping it).
    expect(await waitForStderr(pending, "still waiting reason=ram-budget"), pending.getStderr()).toBe(true);
    expect(pending.child.exitCode).toBeNull();
    rmSync(slot, { recursive: true, force: true });
    const result = await pending.result;
    expect(result.stdout).not.toContain("OPEN");
    expect(result.stderr).toContain("waiting reason=ram-budget");
    expect(result.stderr).toContain("still waiting reason=ram-budget");
  }, ASYNC_SUBPROC_TIMEOUT_MS);

  test("slot contention reports reason=slot-busy and keeps waiting", async () => {
    const fixture = project("[heavy_compile]\nmax_concurrent = 1\n");
    const slot = hold(fixture.lockDir, "unknown");
    const pending = runAsync(fixture.root, ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1"]);
    expect(await waitForStderr(pending, "waiting reason=slot-busy"), pending.getStderr()).toBe(true);
    expect(pending.child.exitCode).toBeNull();
    rmSync(slot, { recursive: true, force: true });
    const result = await pending.result;
    expect(result.stderr).toContain("waiting reason=slot-busy");
  }, ASYNC_SUBPROC_TIMEOUT_MS);

  test("an unusable lock directory returns OPEN with reason=lock-infra", () => {
    const fixture = project("[heavy_compile]\nmax_concurrent = 1\n");
    mkdirSync(dirname(fixture.lockDir), { recursive: true });
    writeFileSync(fixture.lockDir, "not-a-directory");
    const result = run(fixture.root, ["--mode", "acquire"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("OPEN");
    expect(result.stderr).toContain("reason=lock-infra");
  });
});

describe("W-381 dead-owner reclaim is independent of RAM admission", () => {
  // Counterfactual: with the reclaim inside the RAM-admission branch (its
  // position before this row), a false `ramOk` skipped the whole slot pass, so
  // NOTHING here ever reclaimed slot-0 — the acquire queued behind a dead owner
  // until a human removed the slot dir by hand. Every assertion below fails
  // against that arrangement: no "reclaimed stale slot-0" line is streamed, the
  // slot dir survives, the acquire never completes, and reclaim.log carries no
  // scan trace at all.
  //
  // Two slots are load-bearing. A dead owner is not counted as a holder, so
  // with max_concurrent = 1 `holders` is 0, the RAM gate is skipped by the
  // never-block-the-sole-build rule, and the old code reclaimed fine. The
  // defect needs a LIVE holder to push holders above 0 and engage the gate —
  // which is exactly the measured shape: a busy box, one real build running,
  // and a dead owner squatting the other slot.
  test("a dead owner is reclaimed while RAM admission is refusing, and the scan is traced", async () => {
    const fixture = project("[heavy_compile]\nmax_concurrent = 2\nstale_minutes = 30\nbuild_ram_budget_gb = 16\n");
    const live = hold(fixture.lockDir, String(process.pid), 1, 1);
    const dead = hold(fixture.lockDir, "2147483647", 1, 0);
    // free 4GB - 3GB OS margin = 1GB of budget against a 16GB build: ramOk false.
    const pending = runAsync(fixture.root, ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1"], "4,128", "0");

    expect(await waitForStderr(pending, "reclaimed stale slot-0"), pending.getStderr()).toBe(true);
    expect(existsSync(dead)).toBe(false);
    // The reclaim did not come from a lucky admission: the acquire is still
    // queue-waiting on the RAM budget it could not satisfy.
    expect(await waitForStderr(pending, "waiting reason=ram-budget"), pending.getStderr()).toBe(true);
    expect(pending.child.exitCode).toBeNull();

    // Freeing the live holder drops holders to 0, where the RAM gate steps
    // aside, so the child completes instead of needing a kill.
    rmSync(live, { recursive: true, force: true });
    const result = await pending.result;
    expect(result.status, result.stderr).toBe(0);

    const log = readFileSync(join(fixture.lockDir, "reclaim.log"), "utf8");
    expect(log).toContain("\treclaim\tslot-0\towner-pid-dead");
    // The decision trace: the first acquire iteration evaluated the slots under
    // a REFUSING RAM verdict and reclaimed. Without this line a later
    // regression that stops running the check looks the same as a run with
    // nothing to reclaim.
    expect(log).toContain("\tscan\titeration=1\tram_ok=false");
    expect(log).toContain("reclaimed=slot-0");
    expect(log).toContain("evaluated=slot-0=owner-pid-dead,slot-1=held");
  }, ASYNC_SUBPROC_TIMEOUT_MS);
});
