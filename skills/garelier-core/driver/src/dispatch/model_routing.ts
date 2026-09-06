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
// Back-compat guarantee: with NO [model_routing] section, automatic rules and
// seat defaults are OFF and the resolver returns inherit (model "") for anything
// not carried by an explicit flag or blueprint hint — dispatch behaves exactly as
// before the resolver existed.
//
// usage:
//   bun model_routing.ts --project <root> --pm-id <id>
//       --seat <worker|scout|smith|librarian|artisan|guardian|observer|concierge|judge>
//       [--blueprint <path>] [--model <m>] [--effort <e>]
//       [--scope <marker>] [--tags <csv>] [--type <backlog-type>] [--rework]
//       [--pm-model <m>] [--format json|text]
//
// Output is one JSON line: {model, effort, source, seat, warnings}. A resolution read never hard-fails the caller
// (exit 0); only a missing --seat is a usage error (exit 2).
import { parse } from "smol-toml";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { arg, printHelpAndExitIfRequested } from "../cli_args.ts";
import { crewSubdir } from "../workspace.ts";

// ── tiers & ranks ────────────────────────────────────────────────────────────
export type Tier = "light" | "mid" | "strong";
const TIER_ORDER: Tier[] = ["light", "mid", "strong"];
const DEFAULT_TIERS: Record<Tier, string> = { light: "haiku", mid: "sonnet", strong: "opus" };

// Seats whose judgment is terminal/systemic (model_routing.md): gates + judge.
export const GATE_SEATS = new Set(["guardian", "observer", "judge"]);
// Risk tags that promote a role a tier (a slip here is systemic, not just gated).
export const RISK_TAGS = new Set(["schema", "determinism", "save", "security", "cooker"]);
// Model rank for tier translation and non-blocking gate advisories.
// Matched by case-insensitive substring so short names (`opus`) and full ids
// (`claude-opus-4-8`) both rank. A provider-custom id that matches no builtin is
// resolved through the config `tiers` (light=1/mid=2/strong=3) when it is assigned
// to a tier; otherwise null = "incomparable" for advisory comparisons.
export function rankModel(model: string | undefined | null, tiers?: Record<Tier, string>): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("gpt-5.6-luna")) return 1;
  if (m.includes("gpt-5.6-terra")) return 2;
  if (m.includes("gpt-5.6-sol")) return 3;
  if (m.includes("haiku")) return 1;
  if (m.includes("sonnet")) return 2;
  if (m.includes("opus")) return 3;
  // Unknown builtin — resolve via a tier assignment (config tiers.* = this model).
  if (tiers) {
    const t = model.trim();
    if (t === tiers.strong) return 3;
    if (t === tiers.mid) return 2;
    if (t === tiers.light) return 1;
  }
  return null;
}

function isTierName(v: string): v is Tier {
  return v === "light" || v === "mid" || v === "strong";
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
  tiers: Record<Tier, string>;
  seats: Record<string, string>; // seat -> tier name OR a direct model id
  agreementModels: string[];
  agreementEfforts: string[];
}

export function emptyConfig(): RoutingConfig {
  return { present: false, rulesOn: false, tiers: { ...DEFAULT_TIERS }, seats: {}, agreementModels: [], agreementEfforts: [] };
}

export function parseRoutingConfig(parsed: Record<string, unknown>): RoutingConfig {
  const mr = parsed.model_routing;
  if (!mr || typeof mr !== "object" || Array.isArray(mr)) return emptyConfig();
  const m = mr as Record<string, unknown>;

  const tiers: Record<Tier, string> = { ...DEFAULT_TIERS };
  if (m.tiers && typeof m.tiers === "object") {
    const t = m.tiers as Record<string, unknown>;
    for (const k of TIER_ORDER) {
      if (typeof t[k] === "string" && (t[k] as string).trim()) tiers[k] = (t[k] as string).trim();
    }
  }

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

  const agreement = m.agreement && typeof m.agreement === "object" && !Array.isArray(m.agreement)
    ? m.agreement as Record<string, unknown>
    : {};
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
  try {
    return parseRoutingConfig(parse(readFileSync(path, "utf8")) as Record<string, unknown>);
  } catch {
    // Fail-open: an unparseable config yields inherit-everywhere, never a crash.
    return emptyConfig();
  }
}

// ── blueprint hints ──────────────────────────────────────────────────────────
export interface BlueprintHints {
  model?: string;
  effort?: string;
  hasEngineLarge: boolean;
}

// Robust line grep (Identity section is the intended home, but any line matches):
// `Model-hint: opus` / `Effort-hint: high`. An unfilled `{{...}}` placeholder or
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
  warnings: string[];
}

// Rank of a seat's configured value: a tier name resolves through tiers, else it is
// a direct model id. null when unset/unrankable.
function seatRank(value: string | undefined, tiers: Record<Tier, string>): number | null {
  if (!value) return null;
  return isTierName(value) ? rankModel(tiers[value], tiers) : rankModel(value, tiers);
}

// Non-blocking advisory: a gate seat (Guardian/Observer/Judge) resolved WEAKER than
// the roles it gates lets a bad merge through (model_routing.md anti-pattern).
// Compare the gate's resolved rank against the role default — `seats.worker`'s
// resolved rank -> `gate_weaker_than_role`; when `seats.worker` is not
// configured the comparison cannot be made, so fall back to flagging a gate below
// the mid tier -> `gate_below_mid`.
function computeWarnings(input: RoutingInput, resolvedModel: string): string[] {
  if (!GATE_SEATS.has(input.seat.toLowerCase())) return [];
  // An explicit gate selection receives its dedicated doctrine advisory below;
  // do not combine it with default-route quality advisories.
  if (input.flagModel?.trim()) return [];
  const tiers = input.config.tiers;
  const gateRank = rankModel(resolvedModel, tiers);
  if (gateRank === null) return []; // inherit or unrankable — nothing to compare

  const workerRank = seatRank(input.config.seats["worker"], tiers);
  if (workerRank !== null) {
    return gateRank < workerRank ? ["gate_weaker_than_role"] : [];
  }
  const midRank = rankModel(tiers.mid, tiers);
  return midRank !== null && gateRank < midRank ? ["gate_below_mid"] : [];
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
      return { model: input.config.tiers[r.tier], source: `rule:${r.fired.join(",")}` };
    }
  }

  // 4. per-seat default (config seat mapping or built-in tier).
  if (directModel) return { model: directModel, source: "seat-default" };
  if (baseTier) return { model: input.config.tiers[baseTier], source: "seat-default" };

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

function gateFloorModel(tiers: Record<Tier, string>): string {
  return (rankModel(tiers.mid, tiers) ?? 0) > 1 ? tiers.mid : DEFAULT_TIERS.mid;
}

function gateFlagWarnings(input: RoutingInput): string[] {
  const flag = input.flagModel?.trim();
  if (!flag || !GATE_SEATS.has(input.seat.toLowerCase())) return [];
  if (rankModel(flag, input.config.tiers) === 1) {
    return ["gate_flag_below_recommended_floor"];
  }
  return [];
}

export function resolveRouting(input: RoutingInput): RoutingResult {
  const resolved = resolveModel(input);
  const effort = resolveEffort(input);
  const gateFloor = !input.flagModel?.trim() && GATE_SEATS.has(input.seat.toLowerCase()) && rankModel(resolved.model, input.config.tiers) === 1;
  const model = gateFloor ? gateFloorModel(input.config.tiers) : resolved.model;
  return {
    model,
    effort,
    source: gateFloor ? `${resolved.source}+gate-floor-mid` : resolved.source,
    seat: input.seat,
    warnings: [...computeWarnings(input, model), ...agreementWarnings(input, model, effort), ...gateFlagWarnings(input)],
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
    "       [--type <t>] [--scope <s>] [--effort <e>] [--model <m>] [--pm-model <m>]\n" +
    "       [--blueprint <path>] [--tags <csv>] [--rework]",
  );
  const seat = (arg("seat") ?? "").trim().toLowerCase();
  if (!seat || !VALID_SEATS.has(seat)) {
    console.error(`model_routing: --seat <${[...VALID_SEATS].join("|")}> required`);
    process.exit(2);
    return;
  }
  const project = resolveProject();
  const pmId = arg("pm-id") ?? process.env.GARELIER_PM_ID;
  const format = (arg("format") ?? "json").toLowerCase();

  const config = pmId ? loadRoutingConfig(project, pmId) : emptyConfig();

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
    console.error("model_routing: WARNING — 2026-07-16 doctrine recommends Terra-or-stronger for a gate verdict; forwarding the explicit --model verbatim.");
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
