import { rmSync } from "./guard/path_guard.ts";
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  parseHeavyCompileConfig,
  admitByRam,
  staleReason,
  compileProcessCount,
  detectOomSignature,
  readMem,
  mainRootFromGitDirs,
  resolveMainRoot,
  resolveReleaseTarget,
  OS_MARGIN_GB,
  DEFAULT_BUILD_RAM_BUDGET_GB,
  DEFAULT_STALE_MINUTES,
} from "../../scripts/heavy_compile_lock.ts";
import { execFileSync } from "node:child_process";

// W-070: heavy_compile_lock's RAM-budget build-lease. These pin (1) the pure
// admission math (min(cap, free-margin) vs budget*(holders+1), the single-step
// OOM tightening, the count-only disable), (2) the OOM-signature detector, (3)
// config parse of the new [heavy_compile] keys, (4) the RAM-reader test seam, and
// (5) the end-to-end CLI: first build always admitted, RAM-block -> fail-open,
// high-RAM admit, unreadable -> count-only degrade, and the oom_hint warn cycle.

// --- pure admission math -----------------------------------------------------
describe("admitByRam", () => {
  const base = {
    buildRamBudgetGb: 4, maxBuildRamGb: 100, osMarginGb: OS_MARGIN_GB, oomHint: false,
  };
  test("admits when the budget covers every holder plus the new build", () => {
    // free 30 - margin 3 = 27 available; need 4*(1+1)=8.
    expect(admitByRam({ ...base, freeGb: 30, holders: 1 })).toBe(true);
  });
  test("blocks when live free RAM cannot cover holders + new build", () => {
    // free 10 - margin 3 = 7 available; need 16*(1+1)=32.
    expect(admitByRam({ ...base, buildRamBudgetGb: 16, freeGb: 10, holders: 1 })).toBe(false);
  });
  test("the user hard cap (max_build_ram_gb) binds even when free RAM is plentiful", () => {
    // free 100 -> free-margin 97, but cap 20 wins; need 11*2=22 > 20.
    expect(admitByRam({ ...base, buildRamBudgetGb: 11, maxBuildRamGb: 20, freeGb: 100, holders: 1 })).toBe(false);
    // same cap admits a smaller budget: need 8*2=16 <= 20.
    expect(admitByRam({ ...base, buildRamBudgetGb: 8, maxBuildRamGb: 20, freeGb: 100, holders: 1 })).toBe(true);
  });
  test("a recent OOM hint shaves one build budget and can flip admit -> block", () => {
    // free 100 -> 97 available; need 48*2=96. Without OOM: 97>=96 admit.
    expect(admitByRam({ ...base, buildRamBudgetGb: 48, freeGb: 100, holders: 1, oomHint: false })).toBe(true);
    // With OOM: 97-48=49 < 96 -> block.
    expect(admitByRam({ ...base, buildRamBudgetGb: 48, freeGb: 100, holders: 1, oomHint: true })).toBe(false);
  });
  test("a non-positive budget disables RAM gating (count-only)", () => {
    expect(admitByRam({ ...base, buildRamBudgetGb: 0, freeGb: 0.1, holders: 9 })).toBe(true);
  });
  test("scales the reservation by holder count", () => {
    // free 30 -> 27 available, budget 8. holders 2 -> need 24 (ok); holders 3 -> need 32 (no).
    expect(admitByRam({ ...base, buildRamBudgetGb: 8, freeGb: 30, holders: 2 })).toBe(true);
    expect(admitByRam({ ...base, buildRamBudgetGb: 8, freeGb: 30, holders: 3 })).toBe(false);
  });
});

// --- W-024: the pure stale-slot decision -------------------------------------
describe("staleReason", () => {
  const base = {
    ownerExists: true, ageMin: 5, leaseMinutes: 240, staleMinutes: 30,
    hasPid: false, ownerProcessLive: false, compileCount: null as number | null,
  };
  test("a fresh pid-0 (Dock) hold is a live holder (not stale)", () => {
    expect(staleReason({ ...base, ageMin: 5 })).toBeNull();
  });
  test("a missing owner file gets grace and compile-presence protection", () => {
    expect(staleReason({ ...base, ownerExists: false, ageMin: 5, compileCount: 0 })).toBeNull();
    expect(staleReason({ ...base, ownerExists: false, ageMin: 40, compileCount: 2 })).toBeNull();
    expect(staleReason({ ...base, ownerExists: false, ageMin: 40, compileCount: 0 })).toBe("owner-missing");
  });
  test("past the hard lease is stale regardless of process state (final backstop)", () => {
    // lease overrides even a live pid AND running compiles — the unconditional net.
    expect(staleReason({ ...base, ageMin: 300, hasPid: true, ownerProcessLive: true, compileCount: 4 }))
      .toBe("lease-expired");
  });
  test("a recorded-but-dead owner pid is stale fast (no age wait)", () => {
    expect(staleReason({ ...base, ageMin: 2, hasPid: true, ownerProcessLive: false }))
      .toBe("owner-pid-dead");
  });
  test("the W-024 idle path: past the short threshold, pid-0, zero compiles", () => {
    expect(staleReason({ ...base, ageMin: 40, hasPid: false, ownerProcessLive: false, compileCount: 0 }))
      .toBe("idle-no-compile");
  });
  test("misfire guard: a LIVE owner pid is never idle-reclaimed (only lease/pid-dead)", () => {
    expect(staleReason({ ...base, ageMin: 40, hasPid: true, ownerProcessLive: true, compileCount: 0 }))
      .toBeNull();
  });
  test("misfire guard: running compiles (count>0) keep an idle-looking slot live", () => {
    // a live `cargo` build keeps its parent process up, so the count never reads 0.
    expect(staleReason({ ...base, ageMin: 40, compileCount: 3 })).toBeNull();
  });
  test("misfire guard: an unreadable (null) compile count never idle-reclaims", () => {
    expect(staleReason({ ...base, ageMin: 40, compileCount: null })).toBeNull();
  });
  test("under the short threshold is live even with zero compiles", () => {
    expect(staleReason({ ...base, ageMin: 10, compileCount: 0 })).toBeNull();
  });
});

// --- W-024: the compile-process counter seam ---------------------------------
describe("compileProcessCount seam", () => {
  afterEach(() => { delete process.env.GARELIER_HC_COMPILE_PROCS; });
  test("injects a deterministic count", () => {
    process.env.GARELIER_HC_COMPILE_PROCS = "2";
    expect(compileProcessCount()).toBe(2);
    process.env.GARELIER_HC_COMPILE_PROCS = "0";
    expect(compileProcessCount()).toBe(0);
  });
  test("'unreadable' forces the null (conservative, no-idle-reclaim) path", () => {
    process.env.GARELIER_HC_COMPILE_PROCS = "unreadable";
    expect(compileProcessCount()).toBeNull();
  });
  test("a malformed override reads as unreadable (null)", () => {
    process.env.GARELIER_HC_COMPILE_PROCS = "not-a-number";
    expect(compileProcessCount()).toBeNull();
  });
});

// --- OOM signature detection -------------------------------------------------
describe("detectOomSignature", () => {
  test("exit code 137 is the OOM killer", () => {
    expect(detectOomSignature(137, "")).toBe("oom-kill-137");
  });
  test("the corrupted anon.*.llvm link symptom", () => {
    expect(detectOomSignature(0, "error: undefined symbol: anon.abc123def.llvm\n")).toBe("anon-llvm-link");
  });
  test("signal 9 / allocation-failed / OOM strings", () => {
    expect(detectOomSignature(0, "error: could not compile `x` (signal: 9, SIGKILL: kill)")).toBe("oom-kill");
    expect(detectOomSignature(0, "memory allocation of 1073741824 bytes failed")).toBe("oom-kill");
    expect(detectOomSignature(0, "rustc: out of memory")).toBe("oom-kill");
  });
  test("incremental cache corruption", () => {
    expect(detectOomSignature(0, "error: internal compiler error: incremental compilation cache is corrupt"))
      .toBe("incremental-corruption");
    expect(detectOomSignature(0, "warning: found invalid metadata files, will ignore them")).toBe("incremental-corruption");
  });
  test("benign build output does not false-positive", () => {
    expect(detectOomSignature(0, "test result: ok. 42 passed; 0 failed")).toBeNull();
    expect(detectOomSignature(null, "warning: unused variable `killedProcess`")).toBeNull();
  });
});

// --- config parse ------------------------------------------------------------
describe("parseHeavyCompileConfig", () => {
  test("empty input keeps defaults (max_build_ram_gb resolves at runtime)", () => {
    const c = parseHeavyCompileConfig("");
    expect(c).toEqual({
      enabled: true, maxConcurrent: 1, leaseMinutes: 240,
      staleMinutes: DEFAULT_STALE_MINUTES,
      buildRamBudgetGb: DEFAULT_BUILD_RAM_BUDGET_GB, maxBuildRamGb: null,
    });
  });
  test("parses the RAM + stale knobs alongside the count-only knobs (same section)", () => {
    const c = parseHeavyCompileConfig(
      "[other]\nx = 1\n\n[heavy_compile]\nenabled = true\nmax_concurrent = 6\n" +
      "lease_minutes = 120\nstale_minutes = 15\nbuild_ram_budget_gb = 4.5\nmax_build_ram_gb = 28\n",
    );
    expect(c).toEqual({
      enabled: true, maxConcurrent: 6, leaseMinutes: 120,
      staleMinutes: 15,
      buildRamBudgetGb: 4.5, maxBuildRamGb: 28,
    });
  });
  test("a section without the RAM keys keeps their defaults", () => {
    const c = parseHeavyCompileConfig("[heavy_compile]\nmax_concurrent = 2\n");
    expect(c.maxConcurrent).toBe(2);
    expect(c.buildRamBudgetGb).toBe(DEFAULT_BUILD_RAM_BUDGET_GB);
    expect(c.maxBuildRamGb).toBeNull();
  });
});

// --- RAM reader test seam ----------------------------------------------------
describe("readMem seam", () => {
  afterEach(() => { delete process.env.GARELIER_HC_MEM_GB; });
  test("injects deterministic free/total", () => {
    process.env.GARELIER_HC_MEM_GB = "20,32";
    expect(readMem()).toEqual({ freeGb: 20, totalGb: 32 });
  });
  test("'unreadable' forces the count-only degrade path", () => {
    process.env.GARELIER_HC_MEM_GB = "unreadable";
    expect(readMem()).toBeNull();
  });
  test("a malformed override reads as unreadable", () => {
    process.env.GARELIER_HC_MEM_GB = "not-a-pair";
    expect(readMem()).toBeNull();
  });
});

// --- end-to-end CLI ----------------------------------------------------------
const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "heavy_compile_lock.ts");
const PM = "tpm";
// W-166: real git init/config/commit/worktree-add (6 spawns) plus a Bun subprocess
// legitimately runs 2-3s in isolation and overshoots Bun's 5000ms default per-test
// timeout when the whole suite (or the box) is under compile load — a timeout flake,
// not a logic failure. Give every git-worktree + subprocess test an explicit budget.
const GIT_HEAVY_TIMEOUT_MS = 30_000;
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function mkProject(configBody: string): { proj: string; lockDir: string } {
  const proj = mkdtempSync(join(tmpdir(), "garelier-hcl-"));
  tmps.push(proj);
  mkdirSync(join(proj, "__garelier", PM, "_pm"), { recursive: true });
  writeFileSync(join(proj, "__garelier", PM, "_pm", "setup_config.toml"), configBody);
  return { proj, lockDir: join(proj, "__garelier", PM, "runtime", "locks", "heavy_compile") };
}

function holdSlot(lockDir: string, i: number) {
  const slot = join(lockDir, `slot-${i}`);
  mkdirSync(slot, { recursive: true });
  // pid 0 = Dock-held (no stable pid); fresh mtime -> not stale within the lease.
  writeFileSync(join(slot, "owner"), `0|held|${new Date().toISOString()}`);
}

// W-024: a slot whose owner file is backdated `ageMin` minutes (utimesSync on the
// owner mtime, which the stale check reads) with a chosen owner pid — the rig for
// the idle-reclaim / lease-backstop / pid-liveness CLI cases.
function holdSlotAged(lockDir: string, i: number, pid: number, ageMin: number) {
  const slot = join(lockDir, `slot-${i}`);
  mkdirSync(slot, { recursive: true });
  const owner = join(slot, "owner");
  writeFileSync(owner, `${pid}|held|${new Date(Date.now() - ageMin * 60000).toISOString()}`);
  const when = new Date(Date.now() - ageMin * 60000);
  utimesSync(owner, when, when);
}

function run(proj: string, args: string[], memEnv?: string, procsEnv?: string) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (memEnv !== undefined) env.GARELIER_HC_MEM_GB = memEnv;
  else delete env.GARELIER_HC_MEM_GB;
  if (procsEnv !== undefined) env.GARELIER_HC_COMPILE_PROCS = procsEnv;
  else delete env.GARELIER_HC_COMPILE_PROCS;
  return spawnSync(process.execPath, [SCRIPT, "--project", proj, "--pm-id", PM, ...args],
    { windowsHide: true, encoding: "utf8", env, timeout: 20000 });
}

function runAsync(proj: string, args: string[], memEnv?: string, procsEnv?: string) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (memEnv !== undefined) env.GARELIER_HC_MEM_GB = memEnv;
  if (procsEnv !== undefined) env.GARELIER_HC_COMPILE_PROCS = procsEnv;
  const child = spawn(process.execPath, [SCRIPT, "--project", proj, "--pm-id", PM, ...args],
    { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  // W-166: expose the live stderr so a test can wait for a specific streamed line
  // (e.g. the queue-wait heartbeat) instead of racing a fixed wall-clock sleep,
  // which flakes when Bun.sleepSync in the child overshoots under machine load.
  return { child, result, getStderr: () => stderr };
}

/** W-166: await a streamed substring on a runAsync child's stderr, bounded so a
 * genuinely stuck child fails the test rather than hanging. Load-independent:
 * it waits for the actual line, however slow the box is. */
async function waitForStderr(pending: { getStderr: () => string }, needle: string, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pending.getStderr().includes(needle)) return true;
    await Bun.sleep(50);
  }
  return pending.getStderr().includes(needle);
}

// W-058: normalize a path for comparison — realpath (dereferences the tmpdir
// symlinks git resolves through, e.g. macOS /var -> /private/var), case-fold on
// Windows. Applied to substrings too, so it trims a trailing "/slot-0" gracefully
// by falling back to the raw string when realpath cannot stat it.
function realNorm(p: string): string {
  let r = p;
  try { r = realpathSync(p); } catch { r = resolve(p); }
  r = r.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? r.toLowerCase() : r;
}

// W-058: a real main checkout plus a linked `git worktree`. The lock resolver
// must send the worktree's shared lock to `main`, never the worktree's own tree.
function mkGitMainAndWorktree(): { main: string; worktree: string } {
  const main = mkdtempSync(join(tmpdir(), "garelier-hcl-main-"));
  const wtParent = mkdtempSync(join(tmpdir(), "garelier-hcl-wt-"));
  tmps.push(main, wtParent);
  const g = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g(main, "init", "-q");
  g(main, "config", "user.email", "ci@ci");
  g(main, "config", "user.name", "ci");
  g(main, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(main, "README.md"), "# hcl\n");
  g(main, "add", "-A");
  g(main, "commit", "-qm", "init");
  const worktree = join(wtParent, "checkout");
  g(main, "worktree", "add", "-q", "--detach", worktree, "HEAD");
  return { main, worktree };
}

describe("heavy_compile_lock CLI", () => {
  test("disabled config yields DISABLED", () => {
    const { proj } = mkProject("[heavy_compile]\nmax_concurrent = 0\n");
    const r = run(proj, ["--mode", "acquire"], "100,128");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("DISABLED");
  });

  test("the sole build (no holders) is always admitted, even on a starved box", () => {
    const { proj } = mkProject("[heavy_compile]\nmax_concurrent = 2\nbuild_ram_budget_gb = 16\n");
    const r = run(proj, ["--mode", "acquire"], "1,2"); // 1 GB free — would fail the RAM gate
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slot-0");
  });

  test("a 2nd build with insufficient free RAM queue-waits past the heartbeat", async () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 2\nbuild_ram_budget_gb = 16\n");
    holdSlot(lockDir, 0); // holders = 1
    const pending = runAsync(proj, ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1"], "5,32");
    // Wait for the heartbeat to actually stream (the process is genuinely blocked
    // and has looped past its first timeout) BEFORE freeing the slot. The old
    // fixed 1.2s sleep raced the child's 1s poll: under load Bun.sleepSync overshot
    // and the acquire grabbed the freed slot before line 614 logged, dropping the
    // heartbeat. Now the assertion is load-independent.
    expect(await waitForStderr(pending, "still waiting reason=ram-budget"), pending.getStderr()).toBe(true);
    expect(pending.child.exitCode).toBeNull(); // still queue-waiting, not yet acquired
    rmSync(join(lockDir, "slot-0"), { recursive: true, force: true });
    const r = await pending.result;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slot-0");
    expect(r.stderr).toContain("waiting reason=ram-budget");
    expect(r.stderr).toContain("still waiting reason=ram-budget");
  }, GIT_HEAVY_TIMEOUT_MS);

  test("W-143 (#354): a queue-waiting acquire leaves a waiter heartbeat, cleared on acquire", async () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\n");
    holdSlot(lockDir, 0); // holders = 1, ceiling 1 -> a 2nd acquire queue-waits on slot-busy
    const waitersDir = join(lockDir, "waiters");
    const pending = runAsync(proj, ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1", "--label", "feat-queue"], "100,128");
    // Block until it has genuinely looped into the wait (heartbeat streamed).
    expect(await waitForStderr(pending, "waiting reason=slot-busy"), pending.getStderr()).toBe(true);
    // The waiter heartbeat exists and carries the --label so the stall scan can
    // correlate it to the dispatch slug (contract_check readActiveLockWaiterLabels).
    const names = existsSync(waitersDir) ? readdirSync(waitersDir).filter((n) => n.endsWith(".json")) : [];
    expect(names.length).toBe(1);
    expect(readFileSync(join(waitersDir, names[0]), "utf8")).toContain('"label":"feat-queue"');
    // Free the slot -> the waiter acquires and MUST clear its heartbeat on exit.
    rmSync(join(lockDir, "slot-0"), { recursive: true, force: true });
    const r = await pending.result;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slot-0");
    const after = existsSync(waitersDir) ? readdirSync(waitersDir).filter((n) => n.endsWith(".json")) : [];
    expect(after).toEqual([]); // heartbeat removed on the acquiring exit (process.on exit)
  }, GIT_HEAVY_TIMEOUT_MS);

  test("a 2nd build with ample free RAM is admitted to the next slot", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 2\nbuild_ram_budget_gb = 16\n");
    holdSlot(lockDir, 0);
    const r = run(proj, ["--mode", "acquire"], "100,128");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slot-1");
  });

  test("unreadable RAM degrades to count-only (2nd slot still granted)", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 2\nbuild_ram_budget_gb = 16\n");
    holdSlot(lockDir, 0);
    const r = run(proj, ["--mode", "acquire"], "unreadable");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slot-1");
  });

  test("release with an OOM exit code records a hint; the next acquire warns", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 2\nbuild_ram_budget_gb = 16\n");
    const rel = run(proj, ["--mode", "release", "--token", "OPEN", "--build-exit", "137"]);
    expect(rel.status).toBe(0);
    expect(existsSync(join(lockDir, "oom_hint"))).toBe(true);
    const acq = run(proj, ["--mode", "acquire"], "100,128");
    expect(acq.status).toBe(0);
    expect(acq.stderr).toContain("recent OOM detected");
    expect(acq.stdout).toContain("slot-0");
  });

  test("release scanning a build log with the anon.*.llvm symptom records a hint", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\n");
    const logFile = join(proj, "build.log");
    writeFileSync(logFile, "Compiling ...\nerror: undefined symbol: anon.9f8e.llvm\n");
    const rel = run(proj, ["--mode", "release", "--token", "OPEN", "--build-exit", "1", "--build-log", logFile]);
    expect(rel.status).toBe(0);
    expect(existsSync(join(lockDir, "oom_hint"))).toBe(true);
  });

  test("a clean build release records no hint (no false warn next time)", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\n");
    const rel = run(proj, ["--mode", "release", "--token", "OPEN", "--build-exit", "0"]);
    expect(rel.status).toBe(0);
    expect(existsSync(join(lockDir, "oom_hint"))).toBe(false);
    const acq = run(proj, ["--mode", "acquire"], "100,128");
    expect(acq.stderr).not.toContain("recent OOM detected");
  });

  // --- W-024: stale-slot auto-reclaim (the 90-min gate-stall fix) -------------
  test("a stale idle slot (pid-0, aged past stale_minutes, zero compiles) is auto-reclaimed + logged", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 30\n");
    holdSlotAged(lockDir, 0, 0, 40); // the BLOCKED-worker / pid-0 Dock-hold, 40 min old
    const r = run(proj, ["--mode", "acquire", "--poll-sec", "1", "--timeout-sec", "20"], "100,128", "0");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slot-0"); // reclaimed, then granted to the waiter
    expect(r.stderr).toContain("reclaimed stale slot-0 (idle-no-compile)");
    // the reclaim is audited to reclaim.log (never silent).
    const log = join(lockDir, "reclaim.log");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("idle-no-compile");
  });

  test("misfire guard: a slot with a LIVE owner pid is NOT reclaimed while queue-waiting", async () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 30\n");
    holdSlotAged(lockDir, 0, process.pid, 40); // owner pid is this live test process
    const pending = runAsync(proj, ["--mode", "acquire", "--poll-sec", "1", "--timeout-sec", "1"], "100,128", "0");
    await Bun.sleep(1200);
    expect(pending.child.exitCode).toBeNull();
    expect(existsSync(join(lockDir, "slot-0"))).toBe(true);
    rmSync(join(lockDir, "slot-0"), { recursive: true, force: true });
    const r = await pending.result;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slot-0");
    expect(r.stderr).not.toContain("reclaimed stale");
  }, GIT_HEAVY_TIMEOUT_MS);

  test("misfire guard: running compiles (count>0) keep an aged pid-0 slot held", async () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 30\n");
    holdSlotAged(lockDir, 0, 0, 40);
    const pending = runAsync(proj, ["--mode", "acquire", "--poll-sec", "1", "--timeout-sec", "1"], "100,128", "3");
    await Bun.sleep(1200);
    expect(pending.child.exitCode).toBeNull();
    expect(existsSync(join(lockDir, "slot-0"))).toBe(true);
    rmSync(join(lockDir, "slot-0"), { recursive: true, force: true });
    const r = await pending.result;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slot-0");
    expect(r.stderr).not.toContain("reclaimed stale");
  }, GIT_HEAVY_TIMEOUT_MS);

  test("the hard lease backstop still reclaims regardless of compile activity", () => {
    // lease_minutes=1: a slot aged 5 min is past the lease and reclaimed even with
    // the compile seam reporting active builds — the unconditional final net.
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 1\nlease_minutes = 1\nstale_minutes = 30\n");
    holdSlotAged(lockDir, 0, process.pid, 5);
    const r = run(proj, ["--mode", "acquire", "--poll-sec", "1", "--timeout-sec", "20"], "100,128", "5");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slot-0");
    expect(r.stderr).toContain("reclaimed stale slot-0 (lease-expired)");
  });

  test("sweep mode reclaims a stale idle slot and reports the count", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 2\nstale_minutes = 30\n");
    holdSlotAged(lockDir, 0, 0, 45);
    const r = run(proj, ["--mode", "sweep"], undefined, "0");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("swept=1");
    expect(existsSync(join(lockDir, "slot-0"))).toBe(false);
    expect(readFileSync(join(lockDir, "reclaim.log"), "utf8")).toContain("idle-no-compile");
  });
});

// --- W-058: the shared lock must resolve to the MAIN repository root ----------
// A caller inside a linked git worktree (a dispatch checkout, `--project .`) must
// share the SAME lock as the merge gate / interactive Dock — never a worktree-
// local one under its own gitignored runtime/, which would silently break the
// cross-layer heavy-compile serialization (the OOM guard).

describe("mainRootFromGitDirs (pure)", () => {
  test("main checkout (git-dir == git-common-dir) keeps project (null)", () => {
    expect(mainRootFromGitDirs("/repo/.git", "/repo/.git")).toBeNull();
  });
  test("linked worktree (dirs differ) resolves to the parent of the common .git", () => {
    // main root is the parent of the shared .git the common-dir points at.
    expect(mainRootFromGitDirs("/repo/.git/worktrees/wt", "/repo/.git")).toBe(resolve("/repo"));
  });
  test("a common-dir not named .git (bare / unexpected) is left alone (null)", () => {
    expect(mainRootFromGitDirs("/repo/.git/worktrees/wt", "/some/bare.git")).toBeNull();
  });
  test("empty inputs are safe (null)", () => {
    expect(mainRootFromGitDirs("", "/repo/.git")).toBeNull();
    expect(mainRootFromGitDirs("/repo/.git", "")).toBeNull();
  });
});

describe("resolveMainRoot seam + real worktree", () => {
  afterEach(() => { delete process.env.GARELIER_HC_MAIN_ROOT; });

  test("the GARELIER_HC_MAIN_ROOT seam injects the resolved root", () => {
    expect(resolveMainRoot("/anything")).toBe("/anything"); // no seam, not a repo => unchanged
    process.env.GARELIER_HC_MAIN_ROOT = "/injected/root";
    expect(resolveMainRoot("/anything")).toBe("/injected/root");
    process.env.GARELIER_HC_MAIN_ROOT = ""; // empty => keep project (fail-open)
    expect(resolveMainRoot("/anything")).toBe("/anything");
  });

  test("a non-git path fails open to the project unchanged", () => {
    const d = mkdtempSync(join(tmpdir(), "garelier-nogit-"));
    tmps.push(d);
    expect(realNorm(resolveMainRoot(d))).toBe(realNorm(d));
  });

  test("resolves a linked worktree to the main root (real git)", () => {
    const { main, worktree } = mkGitMainAndWorktree();
    // main checkout resolves to itself (git-dir == common-dir).
    expect(realNorm(resolveMainRoot(main))).toBe(realNorm(main));
    // the linked worktree resolves to the MAIN root, not itself.
    expect(realNorm(resolveMainRoot(worktree))).toBe(realNorm(main));
    expect(realNorm(resolveMainRoot(worktree))).not.toBe(realNorm(worktree));
  }, GIT_HEAVY_TIMEOUT_MS);
});

describe("heavy_compile_lock CLI — worktree shares the main-root lock (W-058)", () => {
  test("acquire from a linked worktree creates the lock at the MAIN root, not the worktree", () => {
    const { main, worktree } = mkGitMainAndWorktree();
    // config lives at the main root (where the shared lock belongs).
    mkdirSync(join(main, "__garelier", PM, "_pm"), { recursive: true });
    writeFileSync(join(main, "__garelier", PM, "_pm", "setup_config.toml"),
      "[heavy_compile]\nmax_concurrent = 2\nbuild_ram_budget_gb = 16\n");

    const mainLock = join(main, "__garelier", PM, "runtime", "locks", "heavy_compile");
    const wtLock = join(worktree, "__garelier", PM, "runtime", "locks", "heavy_compile");

    const r = run(worktree, ["--mode", "acquire"], "100,128");
    expect(r.status).toBe(0);
    // redirect is announced (never a silent worktree-local lock).
    expect(r.stderr).toContain("linked worktree");
    // the granted slot is under the MAIN root, and NOT under the worktree.
    expect(existsSync(join(mainLock, "slot-0"))).toBe(true);
    expect(existsSync(wtLock)).toBe(false);
    // the printed token path points at the main-root lock dir.
    expect(realNorm(r.stdout.trim())).toContain(realNorm(mainLock));
  }, GIT_HEAVY_TIMEOUT_MS);
});

// --- W-058 (release side): release resolves the REAL main-root owner ----------
// A worktree-local / mismatched token must not silently no-op while the actual
// main-root owner stays and blocks the pipeline (downstream #285, 2026-07-13).

describe("resolveReleaseTarget (pure)", () => {
  const LOCK = join("/main", "__garelier", "tpm", "runtime", "locks", "heavy_compile");
  // canonical slot path built the SAME way the function does (join), so the
  // injected "exists" set and the expected paths match on any OS separator.
  const canon = (n: string) => join(LOCK, n);
  const has = (...present: string[]) => (p: string) => present.includes(p);
  test("token=OPEN is a no-op (nothing was held)", () => {
    expect(resolveReleaseTarget("OPEN", LOCK, has()).kind).toBe("open");
  });
  test("an empty token is invalid (no silent success)", () => {
    expect(resolveReleaseTarget("", LOCK, has()).kind).toBe("invalid");
  });
  test("a non-slot token is invalid", () => {
    expect(resolveReleaseTarget(join("/some", "random", "path"), LOCK, has()).kind).toBe("invalid");
    expect(resolveReleaseTarget("garbage", LOCK, has()).kind).toBe("invalid");
  });
  test("the incident case: a WORKTREE-local token path remaps to the held main-root slot", () => {
    const canonical = canon("slot-0");
    const wtToken = join("/main", "wt", "__garelier", "tpm", "runtime", "locks", "heavy_compile", "slot-0"); // absent literal
    const r = resolveReleaseTarget(wtToken, LOCK, has(canonical));
    expect(r).toEqual({ kind: "remove", path: canonical, remapped: true });
  });
  test("a literal main-root token that exists removes it (not remapped)", () => {
    const canonical = canon("slot-1");
    expect(resolveReleaseTarget(canonical, LOCK, has(canonical)))
      .toEqual({ kind: "remove", path: canonical, remapped: false });
  });
  test("a bare slot name resolves to the canonical main-root slot", () => {
    const canonical = canon("slot-2");
    expect(resolveReleaseTarget("slot-2", LOCK, has(canonical)))
      .toEqual({ kind: "remove", path: canonical, remapped: true });
  });
  test("a mismatched slot (held slot differs) is ABSENT -> hard error, never a false release", () => {
    const r = resolveReleaseTarget("slot-5", LOCK, has(canon("slot-0")));
    expect(r.kind).toBe("absent");
    if (r.kind === "absent") expect(r.slot).toBe("slot-5");
  });
});

describe("heavy_compile_lock CLI — release resolves the main-root owner (W-058 release side)", () => {
  test("release from a linked worktree deletes the MAIN-root owner (no silent no-op)", () => {
    const { main, worktree } = mkGitMainAndWorktree();
    const mainLock = join(main, "__garelier", PM, "runtime", "locks", "heavy_compile");
    holdSlot(mainLock, 0); // the stuck main-root owner
    // The worker's token names a worktree-local path that does NOT exist on disk.
    const wtToken = join(worktree, "__garelier", PM, "runtime", "locks", "heavy_compile", "slot-0");
    expect(existsSync(wtToken)).toBe(false);

    const r = run(worktree, ["--mode", "release", "--token", wtToken]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("released");
    // the real main-root owner is gone.
    expect(existsSync(join(mainLock, "slot-0"))).toBe(false);
  }, GIT_HEAVY_TIMEOUT_MS);

  test("a BARE relative token 'slot-0' releases the held main-root slot (the #285 symptom)", () => {
    // #285: the worker ran `release --token slot-0` with a relative token; the
    // old code did existsSync("slot-0") (cwd-relative, absent) -> silent no-op.
    // The token must resolve against the main-root lock and free the real owner.
    const { main } = mkGitMainAndWorktree();
    const mainLock = join(main, "__garelier", PM, "runtime", "locks", "heavy_compile");
    holdSlot(mainLock, 0);
    const r = run(main, ["--mode", "release", "--token", "slot-0"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("released");
    expect(existsSync(join(mainLock, "slot-0"))).toBe(false);
  }, GIT_HEAVY_TIMEOUT_MS);

  test("a mismatched token (no such held slot) errors non-zero and removes nothing", () => {
    const { main } = mkGitMainAndWorktree();
    mkdirSync(join(main, "__garelier", PM, "_pm"), { recursive: true });
    const mainLock = join(main, "__garelier", PM, "runtime", "locks", "heavy_compile");
    holdSlot(mainLock, 0); // slot-0 is held; the caller releases the wrong slot

    const r = run(main, ["--mode", "release", "--token", "slot-5"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("NOT a silent success");
    // the actual held owner is untouched.
    expect(existsSync(join(mainLock, "slot-0"))).toBe(true);
  }, GIT_HEAVY_TIMEOUT_MS);

  test("token=OPEN release stays a clean no-op (exit 0)", () => {
    const { proj } = mkProject("[heavy_compile]\nmax_concurrent = 1\n");
    const r = run(proj, ["--mode", "release", "--token", "OPEN"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("released");
  });
});
