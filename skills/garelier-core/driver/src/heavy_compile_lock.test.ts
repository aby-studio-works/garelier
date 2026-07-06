import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseHeavyCompileConfig,
  admitByRam,
  detectOomSignature,
  readMem,
  OS_MARGIN_GB,
  DEFAULT_BUILD_RAM_BUDGET_GB,
} from "../../scripts/heavy_compile_lock.ts";

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
      buildRamBudgetGb: DEFAULT_BUILD_RAM_BUDGET_GB, maxBuildRamGb: null,
    });
  });
  test("parses the RAM knobs alongside the count-only knobs (same section)", () => {
    const c = parseHeavyCompileConfig(
      "[other]\nx = 1\n\n[heavy_compile]\nenabled = true\nmax_concurrent = 6\n" +
      "lease_minutes = 120\nbuild_ram_budget_gb = 4.5\nmax_build_ram_gb = 28\n",
    );
    expect(c).toEqual({
      enabled: true, maxConcurrent: 6, leaseMinutes: 120,
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

function run(proj: string, args: string[], memEnv?: string) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (memEnv !== undefined) env.GARELIER_HC_MEM_GB = memEnv;
  else delete env.GARELIER_HC_MEM_GB;
  return spawnSync(process.execPath, [SCRIPT, "--project", proj, "--pm-id", PM, ...args],
    { encoding: "utf8", env, timeout: 20000 });
}

describe("heavy_compile_lock CLI", () => {
  test("disabled config yields OPEN", () => {
    const { proj } = mkProject("[heavy_compile]\nmax_concurrent = 0\n");
    const r = run(proj, ["--mode", "acquire"], "100,128");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("OPEN");
  });

  test("the sole build (no holders) is always admitted, even on a starved box", () => {
    const { proj } = mkProject("[heavy_compile]\nmax_concurrent = 2\nbuild_ram_budget_gb = 16\n");
    const r = run(proj, ["--mode", "acquire"], "1,2"); // 1 GB free — would fail the RAM gate
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slot-0");
  });

  test("a 2nd build with insufficient free RAM waits, then fail-opens to OPEN", () => {
    const { proj, lockDir } = mkProject("[heavy_compile]\nmax_concurrent = 2\nbuild_ram_budget_gb = 16\n");
    holdSlot(lockDir, 0); // holders = 1
    const r = run(proj, ["--mode", "acquire", "--timeout-sec", "1", "--poll-sec", "1"], "5,32");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("OPEN");
    expect(r.stderr).toContain("RAM budget");
  });

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
});
