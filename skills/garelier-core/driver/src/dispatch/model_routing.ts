// Garelier dispatch (W-026) — mechanized model/effort routing resolver.
//
// `references/model_routing.md` is the ORIGIN of the rule ("tier follows judgment
// density"): strong models on judgment-dense/terminal seats (PM, gates, judge),
// mid-tier on bounded-and-gated roles. That guidance was previously applied
// by hand. This resolver mechanizes it into a single deterministic decision the
// dispatch scaffolding (dispatch_prepare.ts) and attended gate dispatch can call,
// while keeping THREE explicit user-override channels: a dispatch flag, a
// blueprint hint, and per-seat config.
//
// Resolution order (highest wins):
//   1. --model / --effort explicit flag                     -> source "flag"
//   2. blueprint `Model-hint:` / `Effort-hint:` line        -> source "blueprint"
//   3. automatic rules (seat/scope/risk-tags/rework/type)   -> source "rule:<names>"
//   4. config per-seat default ([model_routing])            -> source "seat-default"
//   5. unresolved                                           -> source "inherit" (model "")
//
// W-846: concrete model ids live ONLY in the per-provider tier table
// `[model_routing.tiers.<provider>]`. Tier resolution, rank, the gate floor, the
// Codex translation (provider_routing.ts) and the Codex launcher aliases
// (dispatch_provider.ts) all read that table; this driver names tiers, never
// models. A defective table is refused, never defaulted.
//
// Back-compat guarantee: with NO [model_routing] section, automatic rules and
// seat defaults are OFF and the resolver returns inherit (model "") for anything
// not carried by an explicit flag or blueprint hint — dispatch behaves exactly as
// before the resolver existed. With no section there is also no tier table, so
// nothing is ranked.
//
// usage:
//   bun model_routing.ts --project <root> --pm-id <id>
//       --seat <worker|scout|smith|librarian|artisan|guardian|observer|concierge|judge>
//       [--provider claude-code|codex]
//       [--blueprint <path>] [--model <m>] [--effort <e>]
//       [--scope <marker>] [--tags <csv>] [--type <backlog-type>] [--rework]
//       [--pm-model <m>] [--format json|text]
//
// Output is one JSON line: {model, effort, source, seat, warnings}. A resolution read never hard-fails the caller
// (exit 0); a missing --seat or an unknown --provider is a usage error (exit 2), and a
// defective tier table is refused (exit 3, `REFUSED`).
import { parse } from "smol-toml";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { arg, printHelpAndExitIfRequested } from "../cli_args.ts";
import { crewSubdir } from "../workspace.ts";

// ── tiers & ranks ────────────────────────────────────────────────────────────
export type Tier = "light" | "mid" | "strong";
const TIER_ORDER: Tier[] = ["light", "mid", "strong"];

// The `dispatch_prepare --provider` vocabulary. Each provider owns one tier table.
export const ROUTING_PROVIDERS = ["claude-code", "codex"] as const;
export type RoutingProvider = typeof ROUTING_PROVIDERS[number];
// The omission default, the same rule as a fresh dispatch (dispatch_prepare.ts
// DEFAULT_PROVIDER, W-690): the jig gate-seat calls name no provider.
export const DEFAULT_ROUTING_PROVIDER: RoutingProvider = "claude-code";
export type TierTable = Readonly<Record<Tier, string>>;
export type TierTables = Readonly<Record<RoutingProvider, TierTable>>;

// Seats whose judgment is terminal/systemic (model_routing.md): gates + judge.
export const GATE_SEATS = new Set(["guardian", "observer", "judge"]);
// Risk tags that promote a role a tier (a slip here is systemic, not just gated).
export const RISK_TAGS = new Set(["schema", "determinism", "save", "security", "cooker"]);

/** A defective `[model_routing.tiers]` table. It is refused, never defaulted. */
export class RoutingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingConfigError";
  }
}

// The rank of a model id. A table-listed id ranks by the HIGHEST tier it fills
// (light=1 / mid=2 / strong=3); one id may fill several tiers of one provider.
// An id no table lists is NAMED, never ranked: every caller handles
// `not_in_table` explicitly instead of reading an unknown rank as acceptable.
// Exact id match only.
export type ModelRank =
  | { kind: "ranked"; model: string; provider: RoutingProvider; tier: Tier; rank: number }
  | { kind: "not_in_table"; model: string };

export function rankModel(model: string, tiers: TierTables | null): ModelRank {
  const id = model.trim();
  if (tiers && id) {
    for (let index = TIER_ORDER.length - 1; index >= 0; index--) {
      const tier = TIER_ORDER[index];
      for (const provider of ROUTING_PROVIDERS) {
        if (tiers[provider][tier] === id) return { kind: "ranked", model: id, provider, tier, rank: index + 1 };
      }
    }
  }
  return { kind: "not_in_table", model: id };
}

export function isTierName(v: string): v is Tier {
  return v === "light" || v === "mid" || v === "strong";
}

export function isRoutingProvider(v: string): v is RoutingProvider {
  return (ROUTING_PROVIDERS as readonly string[]).includes(v);
}

// Built-in per-seat tier when [model_routing] is present but the seat is not
// listed: gates/judge = strong, every role = mid (model_routing.md table).
function builtinSeatTier(seat: string): Tier {
  return GATE_SEATS.has(seat) ? "strong" : "mid";
}

// ── config ───────────────────────────────────────────────────────────────────
export interface RoutingConfig {
  present: boolean; // was a [model_routing] section present at all
  rulesOn: boolean;
  tiers: TierTables | null; // null only when [model_routing] is absent
  seats: Record<string, string>; // seat -> tier name OR a direct model id
  agreementModels: string[];
  agreementEfforts: string[];
}

export function emptyConfig(): RoutingConfig {
  return { present: false, rulesOn: false, tiers: null, seats: {}, agreementModels: [], agreementEfforts: [] };
}

/** The provider's tier table. A read with no table is refused, never defaulted. */
export function tierTable(config: RoutingConfig, provider: RoutingProvider): TierTable {
  if (!config.tiers) {
    throw new RoutingConfigError(`no [model_routing.tiers.${provider}] table is declared in setup_config.toml (references/model_routing.md)`);
  }
  return config.tiers[provider];
}

function isTable(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTierTables(raw: unknown): TierTables {
  const required = ROUTING_PROVIDERS.map((provider) => `[model_routing.tiers.${provider}]`).join(" and ");
  if (!isTable(raw)) {
    throw new RoutingConfigError(`[model_routing] has no tier table; declare ${required} with light/mid/strong model ids (references/model_routing.md)`);
  }
  for (const key of Object.keys(raw)) {
    if (isTierName(key)) {
      throw new RoutingConfigError(`retired flat form \`tiers.${key} = ...\` under [model_routing]; move each id into ${required}`);
    }
    if (!isRoutingProvider(key)) {
      throw new RoutingConfigError(`[model_routing.tiers] names unknown provider '${key}' (expected ${ROUTING_PROVIDERS.join("|")})`);
    }
  }
  const owner = new Map<string, RoutingProvider>();
  const tables = {} as Record<RoutingProvider, TierTable>;
  for (const provider of ROUTING_PROVIDERS) {
    const row = raw[provider];
    if (!isTable(row)) throw new RoutingConfigError(`[model_routing.tiers.${provider}] is missing`);
    for (const key of Object.keys(row)) {
      if (!isTierName(key)) throw new RoutingConfigError(`[model_routing.tiers.${provider}] names unknown tier '${key}' (expected light|mid|strong)`);
    }
    const ids = {} as Record<Tier, string>;
    for (const tier of TIER_ORDER) {
      const value = row[tier];
      if (typeof value !== "string" || !value.trim()) {
        throw new RoutingConfigError(`[model_routing.tiers.${provider}].${tier} must be a non-empty model id`);
      }
      const id = value.trim();
      const prior = owner.get(id);
      if (prior && prior !== provider) {
        throw new RoutingConfigError(`model id '${id}' is declared under both [model_routing.tiers.${prior}] and [model_routing.tiers.${provider}]`);
      }
      owner.set(id, provider);
      ids[tier] = id;
    }
    tables[provider] = ids;
  }
  return tables;
}

export function parseRoutingConfig(parsed: Record<string, unknown>): RoutingConfig {
  const mr = parsed.model_routing;
  if (!isTable(mr)) return emptyConfig();
  const m = mr;

  const tiers = parseTierTables(m.tiers);

  const seats: Record<string, string> = {};
  if (m.seats && typeof m.seats === "object") {
    for (const [k, v] of Object.entries(m.seats as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) seats[k.toLowerCase()] = v.trim();
    }
  }

  // rules.on defaults true when the section is present (routing is the intent);
  // only an explicit `rules.on = false` disables the automatic layer.
  const rulesOn =
    m.rules && typeof m.rules === "object" ? (m.rules as Record<string, unknown>).on !== false : true;

  const agreement = isTable(m.agreement) ? m.agreement : {};
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];

  // Legacy `above_pm` is intentionally unread: it is a retired ceiling, not a
  // validation error, so existing setup_config files remain usable.
  return { present: true, rulesOn, tiers, seats, agreementModels: strings(agreement.models), agreementEfforts: strings(agreement.efforts) };
}

export function loadRoutingConfig(project: string, pmId: string): RoutingConfig {
  const path = join(crewSubdir(project, pmId, "pm"), "setup_config.toml");
  if (!existsSync(path)) return emptyConfig();
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // Fail-open: an unparseable config yields inherit-everywhere, never a crash.
    return emptyConfig();
  }
  // A parseable config with a defective tier table throws RoutingConfigError.
  return parseRoutingConfig(parsed);
}

// ── Codex availability (W-846) ───────────────────────────────────────────────
// The Codex CLI's own model list is the availability authority for the codex
// tier table; the driver never probes the network.
export function codexModelsCachePath(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.CODEX_HOME ?? resolve(homedir(), ".codex"), "models_cache.json");
}

export function readCodexModelsCache(path: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the Codex CLI model list ${path}: ${(error as Error).message}`);
  }
  const models = isTable(raw) ? raw.models : undefined;
  if (!Array.isArray(models)) throw new Error(`the Codex CLI model list ${path} has no models[] array`);
  return models.flatMap((entry) => isTable(entry) && typeof entry.slug === "string" && entry.slug.trim() ? [entry.slug.trim()] : []);
}

/** Codex table ids the Codex CLI model list does not carry. */
export function unlistedCodexTierIds(tiers: TierTables, listed: readonly string[]): string[] {
  return [...new Set(TIER_ORDER.map((tier) => tiers.codex[tier]))].filter((id) => !listed.includes(id));
}

// ── blueprint hints ──────────────────────────────────────────────────────────
export interface BlueprintHints {
  model?: string;
  effort?: string;
  hasEngineLarge: boolean;
}

// Robust line grep (Identity section is the intended home, but any line matches):
// `Model-hint: <model id>` / `Effort-hint: high`. An unfilled `{{...}}` placeholder or
// an empty value is ignored so a scaffolded-but-unedited blueprint contributes
// nothing.
export function parseBlueprintHints(text: string): BlueprintHints {
  const grab = (label: string): string | undefined => {
    const re = new RegExp(`${label}\\s*:\\s*(.+)`, "i");
    for (const line of text.split(/\r?\n/)) {
      const mm = line.match(re);
      if (!mm) continue;
      let v = mm[1].trim();
      v = v.replace(/<!--.*$/, "").trim(); // strip trailing html comment
      v = v.replace(/`/g, "").trim(); // strip backticks
      const first = v.split(/\s+/)[0] ?? "";
      if (!first || first.startsWith("{{")) return undefined; // unfilled placeholder
      return first;
    }
    return undefined;
  };
  return {
    model: grab("Model-hint"),
    effort: grab("Effort-hint"),
    hasEngineLarge: /engine_LARGE/.test(text),
  };
}

// ── resolution ───────────────────────────────────────────────────────────────
export interface RoutingInput {
  seat: string;
  // The dispatch provider: a tier-based route reads this provider's table.
  provider: RoutingProvider;
  config: RoutingConfig;
  flagModel?: string;
  flagEffort?: string;
  blueprintModel?: string;
  blueprintEffort?: string;
  scope?: string; // e.g. "engine_LARGE" (from --scope)
  blueprintText?: string; // scanned for an engine_LARGE marker
  tags?: string[];
  type?: string; // backlog type (docs/research demote candidate)
  rework?: boolean;
  // Framework fallback when the task, blueprint, and indicator leave model
  // selection open. It cannot constrain an explicit task decision.
  pmModel?: string;
}

export interface RoutingResult {
  // Resolved model. Every explicit flag is forwarded verbatim; a gate-seat
  // light flag carries a 2026-07-16 doctrine warning. "" means inherit.
  model: string;
  effort: string; // "" = inherit
  source: string; // flag | blueprint | rule:<names> | seat-default | pm-default | inherit (+ gate-floor-mid)
  seat: string;
  // Non-blocking advisories (never change the resolution). Empty in the normal case.
  // `gate_weaker_than_role` / `gate_below_mid`: the anti-pattern where a
  // strong role is gated by a weaker Guardian/Observer/Judge (model_routing.md).
  // `model_not_in_tier_table`: a gate-seat model no tier table lists, so its
  // rank (and every rank-based check) is unknown.
  warnings: string[];
}

// Rank of a seat's configured value: a tier name resolves through the provider's
// table, else it is a direct model id. null when unset.
function seatRank(value: string | undefined, input: RoutingInput): ModelRank | null {
  if (!value) return null;
  const model = isTierName(value) ? tierTable(input.config, input.provider)[value] : value;
  return rankModel(model, input.config.tiers);
}

// Non-blocking advisory: a gate seat (Guardian/Observer/Judge) resolved WEAKER than
// the roles it gates lets a bad merge through (model_routing.md anti-pattern).
// Compare the gate's resolved rank against the role default — `seats.worker`'s
// resolved rank -> `gate_weaker_than_role`; when `seats.worker` is not
// configured or ranked the comparison cannot be made, so fall back to flagging a
// gate below the mid tier -> `gate_below_mid`.
function computeWarnings(input: RoutingInput, resolvedModel: string): string[] {
  if (!GATE_SEATS.has(input.seat.toLowerCase())) return [];
  // An explicit gate selection receives its dedicated doctrine advisory below;
  // do not combine it with default-route quality advisories.
  if (input.flagModel?.trim()) return [];
  const gate = rankModel(resolvedModel, input.config.tiers);
  // Inherit, or a model no table lists (named by `model_not_in_tier_table`).
  if (gate.kind !== "ranked") return [];

  const worker = seatRank(input.config.seats["worker"], input);
  if (worker?.kind === "ranked") {
    return gate.rank < worker.rank ? ["gate_weaker_than_role"] : [];
  }
  const mid = rankModel(tierTable(input.config, input.provider).mid, input.config.tiers);
  return mid.kind === "ranked" && gate.rank < mid.rank ? ["gate_below_mid"] : [];
}

interface RuleOutcome {
  tier: Tier;
  fired: string[];
}

// Automatic rules applied on top of a seat's base TIER (step 3). Promotions stack
// and cap at strong; a gate/judge seat is forced to strong; a docs/research type
// demotes one tier ONLY when nothing promoted.
function applyRules(baseTier: Tier, input: RoutingInput): RuleOutcome {
  const baseIdx = TIER_ORDER.indexOf(baseTier);
  const fired: string[] = [];
  const isGate = GATE_SEATS.has(input.seat);
  if (isGate) fired.push("gate-seat");

  let promotes = 0;
  const scopeLarge =
    input.scope === "engine_LARGE" || /engine_LARGE/.test(input.blueprintText ?? "");
  if (scopeLarge) { promotes++; fired.push("scope-large"); }
  const hasRisk = (input.tags ?? []).some((t) => RISK_TAGS.has(t.trim().toLowerCase()));
  if (hasRisk) { promotes++; fired.push("risk-tags"); }
  if (input.rework) { promotes++; fired.push("rework"); }

  let idx = Math.min(TIER_ORDER.length - 1, baseIdx + promotes);
  if (isGate) idx = TIER_ORDER.length - 1; // strong

  if (fired.length === 0) {
    const t = (input.type ?? "").trim().toLowerCase();
    if (t === "docs" || t === "research") {
      idx = Math.max(0, baseIdx - 1);
      fired.push("type-light");
    }
  }
  return { tier: TIER_ORDER[idx], fired };
}

function resolveModel(input: RoutingInput): { model: string; source: string } {
  // 1. explicit flag.
  if (input.flagModel && input.flagModel.trim()) return { model: input.flagModel.trim(), source: "flag" };
  // 2. blueprint hint.
  if (input.blueprintModel && input.blueprintModel.trim()) {
    return { model: input.blueprintModel.trim(), source: "blueprint" };
  }
  // No [model_routing] section => no indicator routing. Fall back to the PM
  // model when it is known; otherwise the caller inherits it.
  if (!input.config.present) {
    return input.pmModel?.trim()
      ? { model: input.pmModel.trim(), source: "pm-default" }
      : { model: "", source: "inherit" };
  }

  const seatVal = input.config.seats[input.seat.toLowerCase()];
  let baseTier: Tier | null = null;
  let directModel: string | null = null;
  if (seatVal) {
    if (isTierName(seatVal)) baseTier = seatVal;
    else directModel = seatVal; // a seat pinned straight to a model id
  } else {
    baseTier = builtinSeatTier(input.seat);
  }

  // 3. automatic rules (tier-based seats only; a direct-model seat is fixed).
  if (input.config.rulesOn && baseTier) {
    const r = applyRules(baseTier, input);
    if (r.fired.length > 0) {
      return { model: tierTable(input.config, input.provider)[r.tier], source: `rule:${r.fired.join(",")}` };
    }
  }

  // 4. per-seat default (config seat mapping or built-in tier).
  if (directModel) return { model: directModel, source: "seat-default" };
  if (baseTier) return { model: tierTable(input.config, input.provider)[baseTier], source: "seat-default" };

  // 5. same AI as the PM. An empty PM model means the caller inherits it.
  if (input.pmModel?.trim()) return { model: input.pmModel.trim(), source: "pm-default" };
  return { model: "", source: "inherit" };
}

function resolveEffort(input: RoutingInput): string {
  if (input.flagEffort && input.flagEffort.trim()) return input.flagEffort.trim();
  if (input.blueprintEffort && input.blueprintEffort.trim()) return input.blueprintEffort.trim();
  return "";
}

function agreementWarnings(input: RoutingInput, model: string, effort: string): string[] {
  const warnings: string[] = [];
  const includes = (values: string[], value: string) => values.some((item) => item.toLowerCase() === value.toLowerCase());
  if (input.flagModel?.trim() && input.config.agreementModels.length > 0 && !includes(input.config.agreementModels, model)) {
    warnings.push("flag_outside_agreed_model_range");
  }
  if (input.flagEffort?.trim() && input.config.agreementEfforts.length > 0 && !includes(input.config.agreementEfforts, effort)) {
    warnings.push("flag_outside_agreed_effort_range");
  }
  return warnings;
}

function gateFlagWarnings(input: RoutingInput): string[] {
  const flag = input.flagModel?.trim();
  if (!flag || !GATE_SEATS.has(input.seat.toLowerCase())) return [];
  const rank = rankModel(flag, input.config.tiers);
  return rank.kind === "ranked" && rank.rank === 1 ? ["gate_flag_below_recommended_floor"] : [];
}

/** Floor a gate seat model at `floor`: a model ranked below it becomes that tier
 * of `provider`'s table. Throws RoutingConfigError when no table exists. */
export function floorGateModel(model: string, floor: Tier, config: RoutingConfig, provider: RoutingProvider): string {
  const floorModel = tierTable(config, provider)[floor];
  const current = rankModel(model, config.tiers);
  return current.kind === "ranked" && current.rank >= TIER_ORDER.indexOf(floor) + 1 ? model : floorModel;
}

export function resolveRouting(input: RoutingInput): RoutingResult {
  const resolved = resolveModel(input);
  const effort = resolveEffort(input);
  const rank = GATE_SEATS.has(input.seat.toLowerCase()) && resolved.model
    ? rankModel(resolved.model, input.config.tiers)
    : null;
  // A machine-resolved light-tier gate model is lifted to the mid tier of the
  // SAME provider's table, so the floored id stays in the resolved vocabulary.
  const floored = !input.flagModel?.trim() && rank?.kind === "ranked" && rank.rank === 1
    ? tierTable(input.config, rank.provider).mid
    : null;
  const model = floored ?? resolved.model;
  return {
    model,
    effort,
    source: floored ? `${resolved.source}+gate-floor-mid` : resolved.source,
    seat: input.seat,
    warnings: [
      ...computeWarnings(input, model),
      ...agreementWarnings(input, model, effort),
      ...gateFlagWarnings(input),
      ...(rank?.kind === "not_in_table" ? ["model_not_in_tier_table"] : []),
    ],
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const VALID_SEATS = new Set([
  "worker", "scout", "smith", "librarian", "artisan", "guardian", "observer", "concierge", "judge",
]);

function resolveProject(): string {
  const p = arg("project") ?? process.env.GARELIER_PROJECT;
  return p ? resolve(p) : process.cwd();
}

function main(): void {
  printHelpAndExitIfRequested(
    "model_routing — resolve the model/effort for a dispatch seat.\n" +
    "usage: model_routing --seat <role> [--pm-id <id>] [--project <path>] [--format json|text]\n" +
    "       [--provider claude-code|codex] [--type <t>] [--scope <s>] [--effort <e>] [--model <m>]\n" +
    "       [--pm-model <m>] [--blueprint <path>] [--tags <csv>] [--rework]",
  );
  const seat = (arg("seat") ?? "").trim().toLowerCase();
  if (!seat || !VALID_SEATS.has(seat)) {
    console.error(`model_routing: --seat <${[...VALID_SEATS].join("|")}> required`);
    process.exit(2);
    return;
  }
  const provider = (arg("provider") ?? DEFAULT_ROUTING_PROVIDER).trim();
  if (!isRoutingProvider(provider)) {
    console.error(`model_routing: --provider must be ${ROUTING_PROVIDERS.join("|")} (got '${provider}')`);
    process.exit(2);
    return;
  }
  const project = resolveProject();
  const pmId = arg("pm-id") ?? process.env.GARELIER_PM_ID;
  const format = (arg("format") ?? "json").toLowerCase();

  let config: RoutingConfig;
  try {
    config = pmId ? loadRoutingConfig(project, pmId) : emptyConfig();
  } catch (error) {
    if (!(error instanceof RoutingConfigError)) throw error;
    console.error(`model_routing: REFUSED — ${error.message}`);
    process.exit(3);
    return;
  }

  let hints: BlueprintHints = { hasEngineLarge: false };
  const blueprint = arg("blueprint");
  if (blueprint && existsSync(blueprint)) {
    try { hints = parseBlueprintHints(readFileSync(blueprint, "utf8")); } catch { /* fail-open */ }
  }

  const tags = (arg("tags") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const result = resolveRouting({
    seat,
    provider,
    config,
    flagModel: arg("model"),
    flagEffort: arg("effort"),
    blueprintModel: hints.model,
    blueprintEffort: hints.effort,
    scope: arg("scope"),
    blueprintText: hints.hasEngineLarge ? "engine_LARGE" : "",
    tags,
    type: arg("type"),
    rework: process.argv.includes("--rework"),
    pmModel: arg("pm-model") ?? process.env.GARELIER_PM_MODEL,
  });

  if (result.warnings.includes("gate_flag_below_recommended_floor")) {
    console.error("model_routing: WARNING — 2026-07-16 doctrine recommends a mid-tier-or-stronger model for a gate verdict; forwarding the explicit --model verbatim.");
  }
  if (result.warnings.includes("model_not_in_tier_table")) {
    console.error(`model_routing: WARNING — gate seat model '${result.model}' is not listed in [model_routing.tiers]; its rank is unknown, so the gate floor and the weaker-than-role check cannot apply.`);
  }

  if (format === "text") {
    console.log(
      `seat=${result.seat} model=${result.model || "(inherit)"} effort=${result.effort || "(inherit)"} ` +
        `source=${result.source}` +
        (result.warnings.length ? ` warnings=${result.warnings.join(",")}` : ""),
    );
  } else {
    console.log(JSON.stringify(result));
  }
  // A routing read never hard-fails dispatch.
  process.exit(0);
}

if (import.meta.main) main();
