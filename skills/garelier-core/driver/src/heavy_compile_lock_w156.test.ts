import { rmSync } from "./guard/path_guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseOwnerPid, staleReason } from "../../scripts/heavy_compile_lock.ts";

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
  mkdirSync(join(root, "__garelier", PM, "_pm"), { recursive: true });
  writeFileSync(join(root, "__garelier", PM, "_pm", "setup_config.toml"), config);
  return { root, lockDir: join(root, "__garelier", PM, "runtime", "locks", "heavy_compile") };
}

function hold(lockDir: string, pidField: string, ageMin = 0): string {
  const slot = join(lockDir, "slot-0");
  mkdirSync(slot, { recursive: true });
  const owner = join(slot, "owner");
  writeFileSync(owner, `${pidField}|held|${new Date().toISOString()}`);
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
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  // W-166: expose live stderr so a test can wait for a streamed line (the queue
  // heartbeat) instead of a fixed wall-clock sleep that races the child's poll.
  return { child, result, getStderr: () => stderr };
}

// W-166: real-subprocess grace/queue tests loop over several 1s-poll acquires; a
// fixed 1.2s sleep per iteration puts them structurally near Bun's 5000ms default
// (W-148 class). Wait for the actual "waiting reason=…" heartbeat to stream —
// deterministic and faster — bounded so a genuinely stuck child still fails.
async function waitForStderr(pending: { getStderr: () => string }, needle: string, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pending.getStderr().includes(needle)) return true;
    await Bun.sleep(50);
  }
  return pending.getStderr().includes(needle);
}

const ASYNC_SUBPROC_TIMEOUT_MS = 30_000;

describe("W-156 owner pid and reclaim fallback", () => {
  test("0, unknown, missing, and malformed owner pids parse as unknown", () => {
    for (const value of ["0", "unknown", "", "12x"]) expect(parseOwnerPid(value)).toBeNull();
    expect(parseOwnerPid(String(process.pid))).toBe(process.pid);
  });

  test("unknown/missing owner state requires grace plus compile-quiet confirmation", () => {
    const base = {
      ownerExists: true, ageMin: 5, leaseMinutes: 240, staleMinutes: 30,
      hasPid: false, ownerProcessLive: false, compileCount: 0 as number | null,
    };
    expect(staleReason(base)).toBeNull();
    expect(staleReason({ ...base, ageMin: 300, compileCount: 2 })).toBeNull();
    expect(staleReason({ ...base, ageMin: 300, compileCount: 0 })).toBe("idle-no-compile");
    expect(staleReason({ ...base, ownerExists: false, ageMin: 5 })).toBeNull();
  });

  test("acquire records unknown by default and the explicit long-lived pid when supplied", () => {
    const unknown = project("[heavy_compile]\nmax_concurrent = 1\n");
    expect(run(unknown.root, ["--mode", "acquire", "--label", "unknown-owner"]).status).toBe(0);
    expect(readFileSync(join(unknown.lockDir, "slot-0", "owner"), "utf8"))
      .toMatch(/^unknown\|unknown-owner\|/);

    const explicit = project("[heavy_compile]\nmax_concurrent = 1\n");
    expect(run(explicit.root, ["--mode", "acquire", "--label", "real-owner", "--owner-pid", String(process.pid)]).status).toBe(0);
    expect(readFileSync(join(explicit.lockDir, "slot-0", "owner"), "utf8"))
      .toMatch(new RegExp(`^${process.pid}\\|real-owner\\|`));
  });

  test("fresh pid-0/unknown/missing leases are not reclaimed inside grace", async () => {
    for (const pidField of ["0", "unknown", ""]) {
      const fixture = project("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 30\n");
      const slot = hold(fixture.lockDir, pidField, 5);
      const pending = runAsync(fixture.root, ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1"]);
      // The acquire evaluated the held fresh-lease slot, declined to reclaim it,
      // and entered the wait loop (it logs "waiting reason=slot-busy"). Waiting for
      // that line — instead of a fixed 1.2s sleep — is deterministic and skips the
      // per-iteration dead time that pushed this 3-lease loop past the 5s default.
      expect(await waitForStderr(pending, "waiting reason=slot-busy"), pending.getStderr()).toBe(true);
      expect(pending.child.exitCode).toBeNull();      // still queue-waiting, not reclaimed
      expect(existsSync(slot)).toBe(true);            // the fresh lease is untouched
      expect(pending.getStderr()).not.toContain("reclaimed stale"); // never reclaimed inside grace
      rmSync(slot, { recursive: true, force: true });
      const result = await pending.result;
      expect(result.stderr).not.toContain("reclaimed stale");
    }
  }, ASYNC_SUBPROC_TIMEOUT_MS);

  test("a real dead pid is still reclaimed immediately", () => {
    const fixture = project("[heavy_compile]\nmax_concurrent = 1\nstale_minutes = 30\n");
    hold(fixture.lockDir, "2147483647", 1);
    const result = run(fixture.root, ["--mode", "acquire", "--timeout-sec", "5", "--poll-sec", "1"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("reclaimed stale slot-0 (owner-pid-dead)");
    // W-169(d): the reclaim audit records HOW the owner pid was probed. A max-int
    // pid is dead under every interpretation (OS signal, tasklist, MSYS ps).
    expect(readFileSync(join(fixture.lockDir, "reclaim.log"), "utf8")).toContain("probe=dead");
  });
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
