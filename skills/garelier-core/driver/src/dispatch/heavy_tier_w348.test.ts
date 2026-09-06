import { rmSync } from "../guard/path_guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeHeavyTier, heavyTierBudget, resolveHeavyTierBudget, HEAVY_TIERS, DEFAULT_HEAVY_TIER,
  declaredHeavyTier,
} from "./engine_aware.ts";
import { buildWatchCmd } from "./contract_check.ts";
import { buildDispatchWatchArgv } from "../scripts/dispatch_prepare.ts";
import { dispatchStallMs, isDormantFor, fleetVerdictFor } from "../scripts/dispatch_watch.ts";
import { runHeavyGate, type LockRunner } from "../scripts/heavy_dispatch_gate.ts";
import { extendOnlyMinutes } from "../../../scripts/heavy_compile_lock.ts";
import { buildFactPack } from "../context_pack.ts";

const PREPARE = join(import.meta.dir, "..", "scripts", "dispatch_prepare.ts");
const CONTEXT_PACK = join(import.meta.dir, "..", "context_pack.ts");
const tmps: string[] = [];
afterEach(() => {
  for (const path of tmps.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// W-348. The measured gap this splits (dispatch #494, one box): a cold-worktree
// `cargo check` finishes in 7m08s, a full `cargo test` codegen run takes HOURS.
// Both were dispatched as `resource_class = heavy`, so the codegen job inherited
// the check job's timeouts. These figures are the reference the budgets are sized
// against, so a future retune can be checked against the evidence, not a vibe.
const CHECK_MEASURED_MIN = 7 + 8 / 60; // 7m08s
const CODEGEN_REPRESENTATIVE_MIN = 180; // "several hours", 3h taken as the representative
// The upper end of "several hours". The hard LEASE is the net of last resort, so it
// is sized against the longest plausible run of the tier, not the typical one.
const CODEGEN_LONG_RUN_MIN = 300; // 5h

const ceilingOf = (b: { watchTimeoutMinutes: number; watchMaxBuildingWindows: number }) =>
  b.watchTimeoutMinutes * b.watchMaxBuildingWindows;

describe("heavy_tier vocabulary (W-348)", () => {
  test("the two tiers are accepted verbatim, and anything else falls to the codegen-safe side", () => {
    for (const tier of HEAVY_TIERS) {
      const n = normalizeHeavyTier(tier);
      expect(n.value).toBe(tier);
      expect(n.defaulted).toBe(false);
      expect(n.warning).toBeNull();
    }
    // The safe side is codegen, and the asymmetry is the reason: mistaking a
    // codegen job for a check job KILLS a healthy multi-hour build at the runaway
    // ceiling, while mistaking a check job for a codegen job only delays noticing
    // a hung one.
    expect(DEFAULT_HEAVY_TIER).toBe("codegen");
    for (const raw of [null, undefined, "", "   ", "medium", "HEAVY"]) {
      const n = normalizeHeavyTier(raw);
      expect(n.value).toBe("codegen");
      expect(n.defaulted).toBe(true);
      expect(n.warning).toContain("heavy_tier");
    }
    // resolveHeavyTierBudget is the one-call normalize + lookup the CLIs use.
    expect(resolveHeavyTierBudget("check").budget).toEqual(heavyTierBudget("check"));
    expect(resolveHeavyTierBudget("nope").budget).toEqual(heavyTierBudget("codegen"));
    expect(resolveHeavyTierBudget("nope").defaulted).toBe(true);
  });
});

describe("per-tier budgets (W-348)", () => {
  // Regression guard on the half of this change that must NOT move. The pre-W-348
  // hard-coded numbers were tuned for check-grade work and were correct for it;
  // only the codegen row was missing. If the check row drifts, every existing
  // check dispatch silently changes reclaim/runaway behavior.
  test("check-tier reproduces the pre-W-348 defaults (lock 30/240, watch 20x3)", () => {
    const check = heavyTierBudget("check");
    expect(check.staleMinutes).toBe(30);
    expect(check.leaseMinutes).toBe(240);
    expect(check.watchTimeoutMinutes).toBe(20);
    expect(check.watchMaxBuildingWindows).toBe(3);
    // and every threshold still clears the 7m08s measurement with margin
    expect(check.lockOccupancyMinutes).toBeGreaterThan(CHECK_MEASURED_MIN);
    expect(check.watchTimeoutMinutes).toBeGreaterThan(CHECK_MEASURED_MIN);
  });

  test("codegen-tier outlasts the runs the check budgets would have cut short", () => {
    const check = heavyTierBudget("check");
    const codegen = heavyTierBudget("codegen");

    // strictly more patient on every duration axis
    expect(codegen.lockOccupancyMinutes).toBeGreaterThan(check.lockOccupancyMinutes);
    expect(codegen.staleMinutes).toBeGreaterThan(check.staleMinutes);
    expect(codegen.leaseMinutes).toBeGreaterThan(check.leaseMinutes);
    expect(codegen.watchTimeoutMinutes).toBeGreaterThan(check.watchTimeoutMinutes);
    expect(codegen.watchMaxBuildingWindows).toBeGreaterThanOrEqual(check.watchMaxBuildingWindows);

    // (a) hard lease: at 240m the check net expires DURING a 5h codegen run and
    // reclaims a healthy holder mid-build — the safety net sat below the job it is
    // supposed to outlast. The codegen net clears it.
    expect(check.leaseMinutes).toBeLessThan(CODEGEN_LONG_RUN_MIN);
    expect(codegen.leaseMinutes).toBeGreaterThanOrEqual(CODEGEN_LONG_RUN_MIN);

    // (b) runaway ceiling: 20m x 3 = 60m declares RUNAWAY (kill the process group,
    // mark FAILED) on a build that is compiling normally.
    expect(ceilingOf(check)).toBeLessThan(CODEGEN_REPRESENTATIVE_MIN);
    expect(ceilingOf(codegen)).toBeGreaterThan(CODEGEN_REPRESENTATIVE_MIN);
  });
});

describe("tier wiring (W-348)", () => {
  const capture = (): { calls: string[][]; run: LockRunner } => {
    const calls: string[][] = [];
    return {
      calls,
      run: (args) => { calls.push(args); return { stdout: "/slot/1", stderr: "", code: 0 }; },
    };
  };

  test("heavy_dispatch_gate hands the lock a DECLARED tier's reclaim thresholds, and nothing when undeclared", () => {
    const explicit = capture();
    const res = runHeavyGate(
      ["--project", "/p", "--pm-id", "pm", "--resource-class", "heavy", "--heavy-tier", "codegen"],
      explicit.run, () => {},
    );
    expect(res.code).toBe(0);
    expect(res.line).toBe("ADMITTED /slot/1");
    const budget = heavyTierBudget("codegen");
    const args = explicit.calls[0]!;
    expect(args[args.indexOf("--stale-minutes") + 1]).toBe(String(budget.staleMinutes));
    expect(args[args.indexOf("--lease-minutes") + 1]).toBe(String(budget.leaseMinutes));

    // W-362 (reverses the W-348 N2 behaviour this line used to pin): an UNDECLARED
    // tier forwards no budgets at all, so heavy_compile_lock keeps its configured
    // ones. W-348 resolved silence to codegen and forwarded it, silently moving
    // every pre-existing flag-less heavy acquire to stale 90m / lease 480m. With a
    // single machine-wide heavy slot that is not a harmless over-estimate — a dead
    // check-tier holder wedges the only slot 3x longer and blocks every other heavy
    // dispatch, and the cost falls on third parties rather than on the job that
    // over-estimated. The operator is still TOLD (the warning below), so silence is
    // visible rather than merely absorbed.
    const undeclared = capture();
    const warnings: string[] = [];
    runHeavyGate(
      ["--project", "/p", "--pm-id", "pm", "--resource-class", "heavy"],
      undeclared.run, (s) => warnings.push(s),
    );
    const undeclaredArgs = undeclared.calls[0]!;
    expect(undeclaredArgs).not.toContain("--stale-minutes");
    expect(undeclaredArgs).not.toContain("--lease-minutes");
    expect(warnings.some((w) => w.includes("heavy_tier"))).toBe(true);

    // The conservative default is NOT weakened where W-348 earned it: a declared but
    // unrecognised token still resolves to codegen and still forwards.
    const bogus = capture();
    runHeavyGate(
      ["--project", "/p", "--pm-id", "pm", "--resource-class", "heavy", "--heavy-tier", "heavy-codegen"],
      bogus.run, () => {},
    );
    const bogusArgs = bogus.calls[0]!;
    expect(bogusArgs[bogusArgs.indexOf("--lease-minutes") + 1]).toBe(String(budget.leaseMinutes));

    // The load axis is untouched by the duration axis: a non-heavy class must still
    // leave the lock entirely alone. That is what makes a separate field safer than
    // new resource_class values — a missed call site cannot silently skip the lock.
    const light = capture();
    expect(runHeavyGate(
      ["--project", "/p", "--pm-id", "pm", "--resource-class", "light", "--heavy-tier", "codegen"],
      light.run, () => {},
    ).line).toBe("NOT-HEAVY");
    expect(light.calls).toHaveLength(0);
  });

  test("heavy_compile_lock's per-acquire budget extends but never shortens", () => {
    expect(extendOnlyMinutes("480", 240).value).toBe(480);
    // never shorten: a caller must not be able to reclaim a slot out from under a
    // live build by asking for a smaller threshold than the operator configured.
    expect(extendOnlyMinutes("10", 240).value).toBe(240);
    expect(extendOnlyMinutes("", 240).value).toBe(240);
    expect(extendOnlyMinutes("nonsense", 240).value).toBe(240);
    expect(extendOnlyMinutes("-5", 240).value).toBe(240);
    expect(extendOnlyMinutes("", 240).note).toBeNull();
    expect(extendOnlyMinutes("10", 240).note).toContain("never shorten");
  });

  // M1(b): the whole chain in one oracle. The silent-degradation risk is that the
  // field is dropped at one hop and every consumer quietly falls back to a default,
  // so this drives the REAL CLIs end to end rather than trusting each hop's unit test.
  test("end-to-end: dispatch_prepare flag -> context.json -> gate / lock / watch", () => {
    // hop 1 — dispatch_prepare accepts and forwards --heavy-tier. Asserted against
    // the CLI's own advertised flag surface (it rejects an unknown arg before doing
    // any git work), not against source text, so a removed case statement fails here.
    const surface = spawnSync(process.execPath, [PREPARE, "--bogus-flag"], {
      windowsHide: true, encoding: "utf8", timeout: 30_000,
    });
    expect(`${surface.stdout ?? ""}${surface.stderr ?? ""}`).toContain("--heavy-tier");
    // W-402 (a): --bash-budget-ms is on the same advertised flag surface.
    expect(`${surface.stdout ?? ""}${surface.stderr ?? ""}`).toContain("--bash-budget-ms");

    // hop 2 — context_pack, driven with the argv dispatch_prepare builds, writes the
    // tier into a REAL context.json on disk.
    const root = mkdtempSync(join(tmpdir(), "garelier-w348-e2e-"));
    tmps.push(root);
    const out = join(root, "context.json");
    const pack = spawnSync(process.execPath, [
      CONTEXT_PACK, "--pm-id", "pm", "--project", root,
      "--resource-class", "heavy", "--heavy-tier", "codegen", "--out", out,
    ], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
    expect(pack.status).toBe(0);
    const packed = JSON.parse(readFileSync(out, "utf8")) as { task: { heavy_tier: string | null } };
    expect(packed.task.heavy_tier).toBe("codegen");

    // W-402 (a): --bash-budget-ms reflects into context.json's bash_timeout_budget_ms
    // (a REAL context.json on disk, same discipline as hop 2 above), the omitted
    // case stays at the unchanged 600000 default, and a negative/non-numeric value
    // is a usage error rather than a silent fallback.
    const bashOut = join(root, "context_bash_budget.json");
    const bashPack = spawnSync(process.execPath, [
      CONTEXT_PACK, "--pm-id", "pm", "--project", root, "--bash-budget-ms", "900000", "--out", bashOut,
    ], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
    expect(bashPack.status).toBe(0);
    const bashPacked = JSON.parse(readFileSync(bashOut, "utf8")) as { bash_timeout_budget_ms: number };
    expect(bashPacked.bash_timeout_budget_ms).toBe(900000);

    const bashDefaultOut = join(root, "context_bash_default.json");
    const bashDefaultPack = spawnSync(process.execPath, [
      CONTEXT_PACK, "--pm-id", "pm", "--project", root, "--out", bashDefaultOut,
    ], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
    expect(bashDefaultPack.status).toBe(0);
    const bashDefaultPacked = JSON.parse(readFileSync(bashDefaultOut, "utf8")) as { bash_timeout_budget_ms: number };
    expect(bashDefaultPacked.bash_timeout_budget_ms).toBe(600000);

    const bashNegative = spawnSync(process.execPath, [
      CONTEXT_PACK, "--pm-id", "pm", "--project", root, "--bash-budget-ms", "-5", "--out", join(root, "context_bash_negative.json"),
    ], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
    expect(bashNegative.status).not.toBe(0);
    const bashNonNumeric = spawnSync(process.execPath, [
      CONTEXT_PACK, "--pm-id", "pm", "--project", root, "--bash-budget-ms", "not-a-number", "--out", join(root, "context_bash_nan.json"),
    ], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
    expect(bashNonNumeric.status).not.toBe(0);

    // hop 3 — the READBACK, performed by production code (W-362).
    // This hop used to be performed by the test itself: it read
    // `packed.task.heavy_tier` and handed the value straight to runHeavyGate. That
    // made the "end-to-end chain" pass while the chain had a TEST-ONLY LINK — and
    // it did: no production code read task.heavy_tier back out at all (W-348 N1).
    // Every step below now goes through the same function production goes through,
    // so deleting the readback fails here instead of passing.
    const packedJson = readFileSync(out, "utf8");
    const tier = declaredHeavyTier(packedJson);
    expect(tier).toBe("codegen");
    const budget = heavyTierBudget(tier!);

    // (a) dispatch_prepare -> the watch it ARMS carries the tier. Without this the
    //     standard path armed a check-grade watch (20m x 3) over a multi-hour
    //     codegen job and declared it RUNAWAY at ~60m — killing the role's
    //     process group while it was compiling healthily (the W-348 harm itself).
    const armWatch = (heavyTier: string | null) => buildDispatchWatchArgv({
      bun: "bun", script: "dispatch_watch.ts", project: root, pm: "pm", id: "40",
      targetRoot: root, heavyTier,
    });
    expect(armWatch(tier).join(" ")).toContain("--heavy-tier codegen");

    // W-362 Guardian N3: the absence branch must be driven by a pack the WRITER can
    // actually emit, not by JSON the test authors itself. The previous version used
    // hand-built `{ task: {} }`, a shape context_pack could never produce for a heavy
    // dispatch — it was green while the writer folded silence into "codegen", which
    // is exactly the test-only link this commit set out to delete. Build the
    // undeclared pack through the real builder instead, so if the writer ever folds
    // absence again, these go RED.
    const undeclaredPack = JSON.stringify(buildFactPack({
      pmId: "pm", projectRoot: "/p", integration: null, config: null,
      task: { resource_class: "heavy" } as never,
    }));
    expect(declaredHeavyTier(undeclaredPack)).toBeNull();
    // The asymmetry is load-bearing, so pin it: no declaration = no flag. This
    // watch also covers non-heavy dispatches, and emitting a tier unconditionally
    // would triple fleet-wide stall-detection delay.
    expect(armWatch(declaredHeavyTier(undeclaredPack))).not.toContain("--heavy-tier");

    // (b) contract_check -> the re-arm command for a watch that LAPSED reads the
    //     tier back off the container's real context.json on disk, so the
    //     remediation cannot recreate the defect it is remediating. Both fixtures
    //     are real writer output (N3), so the two readers are proven to agree on
    //     the same bytes rather than on two hand-written shapes.
    const pmRoot = join(root, "pm");
    const container = join(pmRoot, "_crew/dispatch40");
    mkdirSync(container, { recursive: true });
    writeFileSync(join(container, "context.json"), packedJson);
    expect(buildWatchCmd(pmRoot, "40")).toContain("--heavy-tier codegen");
    writeFileSync(join(container, "context.json"), undeclaredPack);
    expect(buildWatchCmd(pmRoot, "40")).not.toContain("--heavy-tier");

    // (b2) N1(a): all THREE readback consumers must answer identically for the same
    //      container. They disagreed before — dispatch_prepare read the raw CLI flag
    //      while the other two read context.json, so an undeclared heavy dispatch
    //      armed a 60m check-grade watch while the re-arm command handed back 240m.
    for (const packJson of [packedJson, undeclaredPack]) {
      writeFileSync(join(container, "context.json"), packJson);
      const fromPrepare = armWatch(declaredHeavyTier(packJson)).includes("--heavy-tier");
      const fromContractCheck = buildWatchCmd(pmRoot, "40").includes("--heavy-tier");
      const fromWatch = dispatchStallMs(packJson, 30 * 60_000, false) !== 30 * 60_000;
      expect(fromPrepare).toBe(fromContractCheck);
      expect(fromPrepare).toBe(fromWatch);
    }

    // (b2b) prepare reads the PACK, not the raw CLI string. A declared-but-unknown
    //       token is normalized exactly once, at pack time; a prepare that re-read
    //       argv would arm the raw garbage instead. This is what makes "one canon,
    //       one answer" observable rather than merely intended.
    const bogusOut = join(root, "context_bogus.json");
    const bogusPack = spawnSync(process.execPath, [
      CONTEXT_PACK, "--pm-id", "pm", "--project", root,
      "--resource-class", "heavy", "--heavy-tier", "heavy-codegen", "--out", bogusOut,
    ], { windowsHide: true, encoding: "utf8", timeout: 60_000 });
    expect(bogusPack.status).toBe(0);
    const bogusJson = readFileSync(bogusOut, "utf8");
    expect(declaredHeavyTier(bogusJson)).toBe("codegen");
    expect(armWatch(declaredHeavyTier(bogusJson)).join(" ")).toContain("--heavy-tier codegen");
    expect(armWatch(declaredHeavyTier(bogusJson)).join(" ")).not.toContain("heavy-codegen");

    // (b3) the fleet loop's RULE APPLICATION (Guardian axis 4 — N2 lived in this
    //      previously untested region). A declared codegen dispatch quiet for 35m is
    //      NOT dormant under its own 90m threshold, and the max-run summary must say
    //      the same thing the dormancy branch does. Reading the fleet-wide value here
    //      printed verdict=REVIVE-NEEDED inside the line reporting "no dispatch
    //      crossed the threshold".
    const fleetDefaultMs = 30 * 60_000;
    const codegenStallMs = dispatchStallMs(packedJson, fleetDefaultMs, false);
    expect(codegenStallMs).toBe(90 * 60_000);
    const quiet35m = 35 * 60_000;
    expect(isDormantFor(quiet35m, codegenStallMs)).toBe(false);
    // The summary consumes the SAME decision the dormancy filter made — it takes a
    // boolean, not a threshold, so it structurally cannot hold a second one (the
    // N2 defect was exactly a second, fleet-wide threshold living here).
    expect(fleetVerdictFor({
      dormancyMs: quiet35m, intervalMs: 90_000,
      lastKind: undefined, buildProcs: 0, dormant: isDormantFor(quiet35m, codegenStallMs),
    })).toBe("STALLED");
    // the undeclared dispatch keeps the fleet default and DOES trip at 35m —
    // proving the widening is scoped to the declaration, not applied fleet-wide (AC3)
    expect(dispatchStallMs(undeclaredPack, fleetDefaultMs, false)).toBe(fleetDefaultMs);
    expect(isDormantFor(quiet35m, fleetDefaultMs)).toBe(true);
    expect(fleetVerdictFor({
      dormancyMs: quiet35m, intervalMs: 90_000,
      lastKind: undefined, buildProcs: 0, dormant: isDormantFor(quiet35m, fleetDefaultMs),
    })).toBe("REVIVE-NEEDED");
    // an explicit --stall-min overrides every tier
    expect(dispatchStallMs(packedJson, fleetDefaultMs, true)).toBe(fleetDefaultMs);

    // (c) heavy_dispatch_gate -> the reclaim thresholds it hands heavy_compile_lock
    const calls: string[][] = [];
    const run: LockRunner = (args) => { calls.push(args); return { stdout: "/slot/1", stderr: "", code: 0 }; };
    runHeavyGate(
      ["--project", root, "--pm-id", "pm", "--resource-class", "heavy", "--heavy-tier", tier!],
      run, () => {},
    );
    const args = calls[0]!;
    const staleArg = args[args.indexOf("--stale-minutes") + 1]!;
    const leaseArg = args[args.indexOf("--lease-minutes") + 1]!;
    expect(staleArg).toBe(String(budget.staleMinutes));
    expect(leaseArg).toBe(String(budget.leaseMinutes));
    expect(args[args.indexOf("--label") + 1]).toContain(":codegen");

    // (c2) W-362 N2 — and an UNDECLARED tier forwards NOTHING, leaving the lock on
    //      its configured budgets. W-348 defaulted silence to codegen and forwarded
    //      it, which moved every pre-existing flag-less heavy acquire to stale 90m /
    //      lease 480m. On a single machine-wide slot that is not a free
    //      over-estimate: a DEAD check-tier holder wedges the only heavy slot 3x
    //      longer and blocks every other heavy dispatch.
    const bare: string[][] = [];
    runHeavyGate(
      ["--project", root, "--pm-id", "pm", "--resource-class", "heavy"],
      (a) => { bare.push(a); return { stdout: "/slot/1", stderr: "", code: 0 }; }, () => {},
    );
    expect(bare[0]!).not.toContain("--stale-minutes");
    expect(bare[0]!).not.toContain("--lease-minutes");
    expect(bare[0]![bare[0]!.indexOf("--label") + 1]).not.toContain(":");
    // A declared-but-UNRECOGNISED token is still codegen — the conservative default
    // keeps the ground W-348 earned for it; it just no longer fires on silence.
    expect(declaredHeavyTier(JSON.stringify({ task: { heavy_tier: "gibberish" } }))).toBe(DEFAULT_HEAVY_TIER);

    // (d) heavy_compile_lock -> those forwarded values survive the extend-only rule
    //     against the shipped check-grade config defaults (30 / 240)
    expect(extendOnlyMinutes(staleArg, 30).value).toBe(budget.staleMinutes);
    expect(extendOnlyMinutes(leaseArg, 240).value).toBe(budget.leaseMinutes);

    // (e) dispatch_watch -> a runaway ceiling that outlasts a multi-hour codegen run
    expect(ceilingOf(budget)).toBe(budget.watchTimeoutMinutes * budget.watchMaxBuildingWindows);
    expect(ceilingOf(budget)).toBeGreaterThan(CODEGEN_REPRESENTATIVE_MIN);

    // and the pure builder agrees with the CLI on both classes
    const pure = (task: Record<string, unknown>) =>
      buildFactPack({ pmId: "pm", projectRoot: "/p", integration: null, config: null, task: task as never });
    expect(pure({ resource_class: "heavy", heavy_tier: "check" }).task.heavy_tier).toBe("check");
    // W-362 SPEC CHANGE (not a revert of W-348): an undeclared tier on a heavy
    // dispatch now packs NULL. W-348 folded it to "codegen" here, which destroyed
    // the declared/absent distinction at write time — before any reader could see
    // it — so every consumer then re-invented its own default and they disagreed
    // (Guardian N1). The codegen fallback is not gone; it moved to where it is
    // meaningful: a declared-but-unrecognised token, normalized on the raw token
    // before it ever reaches the pack. Silence is now carried as silence.
    expect(pure({ resource_class: "heavy" }).task.heavy_tier).toBeNull();
    // the duration axis does not exist for a job that never takes the slot
    for (const rc of ["light", "data", "review"]) {
      expect(pure({ resource_class: rc }).task.heavy_tier).toBeNull();
    }
  });
});
