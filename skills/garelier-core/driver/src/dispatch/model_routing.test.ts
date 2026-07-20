import { rmSync } from "../guard/path_guard.ts";
// W-026 — model_routing.ts: the mechanized model/effort routing resolver.
// Pins the resolution ORDER (flag > blueprint > rule > seat-default > inherit),
// each automatic rule branch, the no-config back-compat guarantee, blueprint hint
// parsing, and the above-PM escalation ceiling so the router cannot silently
// regress into wrong-tier or above-PM dispatches.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveRouting,
  parseBlueprintHints,
  parseRoutingConfig,
  loadRoutingConfig,
  emptyConfig,
  rankModel,
  type RoutingConfig,
  type RoutingInput,
} from "./model_routing.ts";

// A [model_routing]-present config with the DEC-062 defaults (opus/sonnet/haiku,
// gate=strong, producer=mid, rules on, above_pm deny).
function cfg(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    present: true,
    rulesOn: true,
    abovePm: "deny",
    tiers: { light: "haiku", mid: "sonnet", strong: "opus" },
    seats: {},
    ...overrides,
  };
}
// Default the PM model to the top rank (fable) so the escalation ceiling never
// clamps in a test that is exercising the RULE/tier layer; escalation tests set
// their own pmModel/policy via resolveRouting directly.
function resolve(partial: Partial<RoutingInput> & { seat: string }): ReturnType<typeof resolveRouting> {
  return resolveRouting({ config: cfg(), pmModel: "fable", ...partial });
}

// ── resolution order ──────────────────────────────────────────────────────────
test("no [model_routing] section -> inherit (back-compat)", () => {
  const r = resolveRouting({ seat: "worker", config: emptyConfig() });
  expect(r.model).toBe("");
  expect(r.source).toBe("inherit");
});

test("explicit --model flag wins over everything", () => {
  const r = resolve({
    seat: "worker",
    flagModel: "opus",
    blueprintModel: "haiku",
    tags: ["schema"], // would otherwise promote
  });
  expect(r.model).toBe("opus");
  expect(r.source).toBe("flag");
});

test("blueprint hint wins over rules and seat default", () => {
  const r = resolve({ seat: "worker", blueprintModel: "haiku", tags: ["schema"] });
  expect(r.model).toBe("haiku");
  expect(r.source).toBe("blueprint");
});

test("seat default applies with no flag/hint/rule (producer -> mid)", () => {
  const r = resolve({ seat: "worker" });
  expect(r.model).toBe("sonnet");
  expect(r.source).toBe("seat-default");
});

test("config seat mapping overrides the built-in tier", () => {
  const r = resolveRouting({ seat: "worker", config: cfg({ seats: { worker: "strong" } }), pmModel: "fable" });
  expect(r.model).toBe("opus");
  expect(r.source).toBe("seat-default");
});

test("config seat can pin a direct model id (rules do not step it)", () => {
  // above_pm=allow isolates the seat-pin + no-rule-stepping behavior from the
  // escalation ceiling (an incomparable pinned model is clamped separately, below).
  const r = resolveRouting({
    seat: "worker",
    config: cfg({ abovePm: "allow", seats: { worker: "claude-custom-x" } }),
    tags: ["schema"],
  });
  expect(r.model).toBe("claude-custom-x");
  expect(r.source).toBe("seat-default");
});

// ── automatic rules ───────────────────────────────────────────────────────────
test("rule: gate seat forced to strong", () => {
  const r = resolve({ seat: "guardian" });
  expect(r.model).toBe("opus");
  expect(r.source).toContain("rule:gate-seat");
});

test("rule: risk tag promotes a producer mid -> strong", () => {
  const r = resolve({ seat: "worker", tags: ["determinism"] });
  expect(r.model).toBe("opus");
  expect(r.source).toBe("rule:risk-tags");
});

test("rule: engine_LARGE scope promotes a producer", () => {
  const r = resolve({ seat: "worker", scope: "engine_LARGE" });
  expect(r.model).toBe("opus");
  expect(r.source).toContain("scope-large");
});

test("rule: engine_LARGE detected from blueprint text", () => {
  const r = resolve({ seat: "worker", blueprintText: "...scope: engine_LARGE ..." });
  expect(r.source).toContain("scope-large");
});

test("rule: --rework promotes", () => {
  const r = resolve({ seat: "worker", rework: true });
  expect(r.model).toBe("opus");
  expect(r.source).toContain("rework");
});

test("rule: docs type demotes mid -> light when nothing promotes", () => {
  const r = resolve({ seat: "worker", type: "docs" });
  expect(r.model).toBe("haiku");
  expect(r.source).toContain("type-light");
});

test("rule: docs type does NOT demote when a promote rule also fired", () => {
  const r = resolve({ seat: "worker", type: "docs", tags: ["security"] });
  expect(r.model).toBe("opus");
  expect(r.source).toContain("risk-tags");
  expect(r.source).not.toContain("type-light");
});

test("rules disabled (rules.on=false) -> pure seat default", () => {
  const r = resolveRouting({ seat: "worker", config: cfg({ rulesOn: false }), tags: ["schema"] });
  expect(r.model).toBe("sonnet");
  expect(r.source).toBe("seat-default");
});

test("promotions cap at strong (already strong seat + rework stays strong)", () => {
  const r = resolveRouting({ seat: "smith", config: cfg({ seats: { smith: "strong" } }), rework: true, pmModel: "fable" });
  expect(r.model).toBe("opus");
});

// ── effort ─────────────────────────────────────────────────────────────────────
test("effort: flag > blueprint > inherit", () => {
  expect(resolve({ seat: "worker", flagEffort: "high", blueprintEffort: "low" }).effort).toBe("high");
  expect(resolve({ seat: "worker", blueprintEffort: "low" }).effort).toBe("low");
  expect(resolve({ seat: "worker" }).effort).toBe("");
});

// ── escalation ceiling (above_pm) ───────────────────────────────────────────────
test("above_pm=deny: resolved model clamped down to the PM model", () => {
  // gate seat wants strong (opus); PM is sonnet -> clamp to sonnet.
  const r = resolveRouting({ seat: "guardian", config: cfg({ abovePm: "deny" }), pmModel: "sonnet" });
  expect(r.model).toBe("sonnet");
  expect(r.suggested_model).toBe("opus");
  expect(r.needs_confirmation).toBe(false);
  expect(r.source).toContain("+clamped-pm-ceiling");
});

test("above_pm=ask: clamps for safety but flags needs_confirmation + suggested", () => {
  const r = resolveRouting({ seat: "guardian", config: cfg({ abovePm: "ask" }), pmModel: "sonnet" });
  expect(r.model).toBe("sonnet");
  expect(r.suggested_model).toBe("opus");
  expect(r.needs_confirmation).toBe(true);
  expect(r.source).toContain("+needs-confirmation");
});

test("above_pm=allow: no ceiling, escalation honored", () => {
  const r = resolveRouting({ seat: "guardian", config: cfg({ abovePm: "allow" }), pmModel: "sonnet" });
  expect(r.model).toBe("opus");
  expect(r.suggested_model).toBe("");
  expect(r.needs_confirmation).toBe(false);
});

test("escalation: PM model unknown -> conservative mid-tier ceiling", () => {
  // No pmModel: opus desired is clamped to the mid tier (sonnet) under deny.
  const r = resolveRouting({ seat: "guardian", config: cfg({ abovePm: "deny" }) });
  expect(r.model).toBe("sonnet");
  expect(r.suggested_model).toBe("opus");
});

test("escalation: within-ceiling model is untouched", () => {
  // producer -> sonnet; PM opus -> no clamp.
  const r = resolveRouting({ seat: "worker", config: cfg(), pmModel: "opus" });
  expect(r.model).toBe("sonnet");
  expect(r.suggested_model).toBe("");
  expect(r.source).toBe("seat-default");
});

test("escalation: incomparable custom desired -> safe-side clamp to mid (deny)", () => {
  // A model that ranks nowhere (builtin or tier) cannot be proven within the
  // ceiling, so deny clamps it to the mid tier.
  const r = resolveRouting({
    seat: "worker",
    config: cfg({ abovePm: "deny", seats: { worker: "my-private-model" } }),
    pmModel: "sonnet",
  });
  expect(r.model).toBe("sonnet");
  expect(r.suggested_model).toBe("my-private-model");
});

test("escalation: tier-assigned custom model ranks and is compared, not force-clamped", () => {
  // strong tier IS this custom model -> it ranks strong(3); PM opus(3) -> within ceiling.
  const r = resolveRouting({
    seat: "guardian",
    config: cfg({ abovePm: "deny", tiers: { light: "haiku", mid: "sonnet", strong: "big-x" } }),
    pmModel: "opus",
  });
  expect(r.model).toBe("big-x");
  expect(r.suggested_model).toBe("");
});

// ── gate-weaker-than-producer advisory (addendum 2) ─────────────────────────────
test("warning: normal config (strong gate, mid producer) -> no warnings", () => {
  const r = resolveRouting({
    seat: "guardian",
    config: cfg({ seats: { worker: "mid" } }),
    pmModel: "fable",
  });
  expect(r.model).toBe("opus"); // gate-seat rule -> strong
  expect(r.warnings).toEqual([]);
});

test("warning: explicit weak gate + strong producer -> gate_weaker_than_producer", () => {
  // rules off so the gate-seat promote does not override the explicit weak seat.
  const r = resolveRouting({
    seat: "guardian",
    config: cfg({ rulesOn: false, abovePm: "allow", seats: { guardian: "light", worker: "strong" } }),
    pmModel: "fable",
  });
  expect(r.model).toBe("haiku");
  expect(r.warnings).toContain("gate_weaker_than_producer");
});

test("warning: escalation clamp pulls gate below producer -> gate_weaker_than_producer", () => {
  // PM=haiku clamps the strong gate to haiku while the producer is explicitly opus.
  const r = resolveRouting({
    seat: "guardian",
    config: cfg({ abovePm: "deny", seats: { worker: "strong" } }),
    pmModel: "haiku",
  });
  expect(r.model).toBe("haiku");
  expect(r.warnings).toContain("gate_weaker_than_producer");
});

test("warning: weak gate, no producer peer -> gate_below_mid fallback", () => {
  const r = resolveRouting({
    seat: "observer",
    config: cfg({ rulesOn: false, abovePm: "allow", seats: { observer: "light" } }),
    pmModel: "fable",
  });
  expect(r.model).toBe("haiku");
  expect(r.warnings).toContain("gate_below_mid");
});

test("warning: judge seat is also checked (weaker than worker)", () => {
  const r = resolveRouting({
    seat: "judge",
    config: cfg({ rulesOn: false, abovePm: "allow", seats: { judge: "light", worker: "strong" } }),
    pmModel: "fable",
  });
  expect(r.model).toBe("haiku");
  expect(r.warnings).toContain("gate_weaker_than_producer");
});

test("warning: gate resolved above worker -> no warning (worker=mid, gate=strong)", () => {
  const r = resolveRouting({ seat: "guardian", config: cfg({ seats: { worker: "mid" } }), pmModel: "fable" });
  expect(r.model).toBe("opus");
  expect(r.warnings).toEqual([]);
});

test("warning: producer seats never carry gate warnings", () => {
  const r = resolveRouting({ seat: "worker", config: cfg({ seats: { worker: "light" } }), pmModel: "fable" });
  expect(r.warnings).toEqual([]);
});

// ── warnings (gate_weaker_than_producer / gate_below_mid, non-blocking) ─────────
test("warnings: gate_weaker_than_producer fires when a pinned-weak gate resolves below a configured producer", () => {
  // Direct model pins bypass the gate-forced-strong rule, so a real inversion
  // (weak Guardian + strong Worker) can be configured and must be flagged.
  const r = resolveRouting({
    seat: "guardian",
    config: cfg({ seats: { guardian: "haiku", worker: "opus" } }),
    pmModel: "fable",
  });
  expect(r.model).toBe("haiku"); // warnings never change the resolution
  expect(r.warnings).toEqual(["gate_weaker_than_producer"]);
});

test("warnings: empty for a normal gate resolution (default gate-seat rule forces strong)", () => {
  const r = resolve({ seat: "guardian" });
  expect(r.warnings).toEqual([]);
});

test("warnings: gate_below_mid fires as a fallback when no producer seat is configured", () => {
  const r = resolveRouting({
    seat: "observer",
    config: cfg({ seats: { observer: "haiku" } }), // no worker/smith/... peer to compare against
    pmModel: "fable",
  });
  expect(r.warnings).toEqual(["gate_below_mid"]);
});

test("warnings: judge seat is covered by the same gate comparison as guardian/observer", () => {
  // Producer comparison anchors on seats.worker (rework final spec).
  const r = resolveRouting({
    seat: "judge",
    config: cfg({ rulesOn: false, abovePm: "allow", seats: { judge: "haiku", worker: "opus" } }),
    pmModel: "fable",
  });
  expect(r.warnings).toEqual(["gate_weaker_than_producer"]);
});

test("warnings: reversal gate=haiku / worker=sonnet fires gate_weaker_than_producer", () => {
  const r = resolveRouting({
    seat: "guardian",
    config: cfg({ rulesOn: false, abovePm: "allow", seats: { guardian: "light", worker: "mid" } }),
    pmModel: "fable",
  });
  expect(r.model).toBe("haiku");
  expect(r.warnings).toEqual(["gate_weaker_than_producer"]);
});

// ── blueprint hint parsing ──────────────────────────────────────────────────────
test("parseBlueprintHints reads Model-hint / Effort-hint, ignores placeholders", () => {
  const h = parseBlueprintHints("## Identity\n- Model-hint: opus  <!-- note -->\n- Effort-hint: `high`\n");
  expect(h.model).toBe("opus");
  expect(h.effort).toBe("high");
  const unfilled = parseBlueprintHints("- Model-hint: {{opus | sonnet}}\n");
  expect(unfilled.model).toBeUndefined();
  expect(parseBlueprintHints("no hints here").model).toBeUndefined();
});

test("parseBlueprintHints detects engine_LARGE marker", () => {
  expect(parseBlueprintHints("scope engine_LARGE").hasEngineLarge).toBe(true);
  expect(parseBlueprintHints("small").hasEngineLarge).toBe(false);
});

// ── config parsing ──────────────────────────────────────────────────────────────
test("parseRoutingConfig: absent section -> not present, inherit-everywhere", () => {
  expect(parseRoutingConfig({}).present).toBe(false);
});

test("parseRoutingConfig: reads tiers/seats/rules/above_pm", () => {
  const c = parseRoutingConfig({
    model_routing: {
      tiers: { strong: "opus", mid: "sonnet", light: "haiku" },
      seats: { Worker: "mid", guardian: "strong" },
      rules: { on: false },
      above_pm: "ask",
    },
  });
  expect(c.present).toBe(true);
  expect(c.rulesOn).toBe(false);
  expect(c.abovePm).toBe("ask");
  expect(c.seats.worker).toBe("mid"); // lowercased key
  expect(c.tiers.strong).toBe("opus");
});

test("parseRoutingConfig: invalid above_pm -> deny default", () => {
  expect(parseRoutingConfig({ model_routing: { above_pm: "bogus" } }).abovePm).toBe("deny");
});

test("rankModel ranks short names and full ids (haiku<sonnet<opus<fable)", () => {
  expect(rankModel("haiku")).toBe(1);
  expect(rankModel("sonnet")).toBe(2);
  expect(rankModel("claude-opus-4-8")).toBe(3);
  expect(rankModel("fable")).toBe(4);
  expect(rankModel("mythos")).toBe(4);
  expect(rankModel("custom-x")).toBeNull();
  expect(rankModel("")).toBeNull();
});

test("rankModel resolves a provider-custom id through the config tiers", () => {
  const tiers = { light: "haiku", mid: "sonnet", strong: "big-x" } as const;
  expect(rankModel("big-x", tiers)).toBe(3); // strong tier
  expect(rankModel("big-x")).toBeNull(); // no tiers -> incomparable
});

test("loadRoutingConfig: missing file -> empty config (fail-open)", () => {
  const c = loadRoutingConfig(join(tmpdir(), "garelier-mr-nope-xyz"), "demo");
  expect(c.present).toBe(false);
});

test("loadRoutingConfig: reads a real setup_config.toml", () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-mr-"));
  try {
    const dir = join(project, "__garelier", "demo", "_pm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "setup_config.toml"),
      [
        "[project]",
        'name = "x"',
        "[branches]",
        'target = "main"',
        'integration = "garelier/main/demo/studio"',
        "[model_routing]",
        "above_pm = \"allow\"",
        "[model_routing.seats]",
        'worker = "strong"',
      ].join("\n"),
    );
    const c = loadRoutingConfig(project, "demo");
    expect(c.present).toBe(true);
    expect(c.abovePm).toBe("allow");
    expect(c.seats.worker).toBe("strong");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// ── CLI smoke (exit codes, matches contract_check.test.ts subprocess pattern) ─────
const here = import.meta.dir;
async function runCli(args: string[]) {
  const p = Bun.spawn(["bun", "run", join(here, "model_routing.ts"), ...args], { windowsHide: true,
    cwd: here, stdout: "pipe", stderr: "pipe",
  });
  return { out: await new Response(p.stdout).text(), code: await p.exited };
}

test("CLI: missing/invalid --seat -> usage exit 2", async () => {
  expect((await runCli([])).code).toBe(2);
  expect((await runCli(["--seat", "bogus"])).code).toBe(2);
});

test("CLI: no config -> inherit JSON, exit 0", async () => {
  const project = mkdtempSync(join(tmpdir(), "garelier-mr-cli-"));
  try {
    const r = await runCli(["--seat", "worker", "--project", project, "--pm-id", "demo"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.model).toBe("");
    expect(j.source).toBe("inherit");
    expect(j.seat).toBe("worker");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("CLI: explicit --model wins, exit 0", async () => {
  const r = await runCli(["--seat", "worker", "--model", "opus", "--pm-model", "opus"]);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.model).toBe("opus");
  expect(j.source).toBe("flag");
});

// --- W-040: external seat (codex) pass-through ------------------------------

test("CLI: --model codex passes through verbatim as external_seat (no ceiling clamp)", async () => {
  const r = await runCli(["--seat", "worker", "--model", "codex", "--pm-model", "opus"]);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.model).toBe("codex");
  expect(j.source).toBe("external_seat");
  expect(j.needs_confirmation).toBe(false);
});

test("CLI: --model gpt-5.5-codex also recognized as external seat", async () => {
  const r = await runCli(["--seat", "worker", "--model", "gpt-5.5-codex", "--pm-model", "sonnet"]);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.model).toBe("gpt-5.5-codex");
  expect(j.source).toBe("external_seat");
});

// --- W-050: real codex model names (no "codex" substring) also external-seat ---

test("CLI: --model gpt-5.6-sol recognized as external seat (no ceiling clamp)", async () => {
  const r = await runCli(["--seat", "worker", "--model", "gpt-5.6-sol", "--pm-model", "sonnet"]);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.model).toBe("gpt-5.6-sol");
  expect(j.source).toBe("external_seat");
});

test("CLI: --model gpt-5.6-terra recognized as external seat (no ceiling clamp)", async () => {
  const r = await runCli(["--seat", "worker", "--model", "gpt-5.6-terra", "--pm-model", "sonnet"]);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.model).toBe("gpt-5.6-terra");
  expect(j.source).toBe("external_seat");
});

test("CLI: --model gpt-5.5 (bare) recognized as external seat", async () => {
  const r = await runCli(["--seat", "worker", "--model", "gpt-5.5", "--pm-model", "sonnet"]);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.model).toBe("gpt-5.5");
  expect(j.source).toBe("external_seat");
});
