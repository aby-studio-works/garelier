// Garelier dispatch (W-026) — mechanized model/effort routing resolver.
//
// `references/model_routing.md` is the ORIGIN of the rule ("tier follows judgment
// density"): strong models on judgment-dense/terminal seats (PM, gates, judge),
// mid-tier on bounded-and-gated producers. That guidance was previously applied
// by hand. This resolver mechanizes it into a single deterministic decision the
// dispatch scaffolding (dispatch_prepare.sh) and attended gate dispatch can call,
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
// Escalation constraint (user requirement 2026-07-02): the resolved model is
// never allowed to EXCEED the PM's own model unless `[model_routing] above_pm`
// opts in. Default `deny` clamps a would-be-higher model down to the PM's model;
// `ask` clamps for safety but flags needs_confirmation (an attended PM confirms
// with the user, then spawns the requested model itself); `allow` disables the
// ceiling. Rank order: haiku < sonnet < opus < fable/mythos. When the PM model is
// unknown, the ceiling defaults conservatively to the `mid` tier.
//
// usage:
//   bun model_routing.ts --project <root> --pm-id <id>
//       --seat <worker|scout|smith|librarian|artisan|guardian|observer|judge>
//       [--blueprint <path>] [--model <m>] [--effort <e>]
//       [--scope <marker>] [--tags <csv>] [--type <backlog-type>] [--rework]
//       [--pm-model <m>] [--format json|text]
//
// Output is one JSON line: {model, effort, source, seat, suggested_model,
// needs_confirmation, above_pm, warnings}. A resolution read never hard-fails the caller
// (exit 0); only a missing --seat is a usage error (exit 2).
import { parse } from "smol-toml";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { arg, printHelpAndExitIfRequested } from "../cli_args.ts";

// ── tiers & ranks ────────────────────────────────────────────────────────────
export type Tier = "light" | "mid" | "strong";
const TIER_ORDER: Tier[] = ["light", "mid", "strong"];
const DEFAULT_TIERS: Record<Tier, string> = { light: "haiku", mid: "sonnet", strong: "opus" };

// Seats whose judgment is terminal/systemic (model_routing.md): gates + judge.
export const GATE_SEATS = new Set(["guardian", "observer", "judge"]);
// Risk tags that promote a producer a tier (a slip here is systemic, not just gated).
export const RISK_TAGS = new Set(["schema", "determinism", "save", "security", "cooker"]);
export const ABOVE_PM_POLICIES = ["deny", "ask", "allow"] as const;
export type AbovePmPolicy = (typeof ABOVE_PM_POLICIES)[number];

// Model rank for the escalation ceiling: haiku < sonnet < opus < fable/mythos.
// Matched by case-insensitive substring so short names (`opus`) and full ids
// (`claude-opus-4-8`) both rank. A provider-custom id that matches no builtin is
// resolved through the config `tiers` (light=1/mid=2/strong=3) when it is assigned
// to a tier; otherwise null = "incomparable" (the caller treats this as the safe
// side under a deny/ask ceiling).
export function rankModel(model: string | undefined | null, tiers?: Record<Tier, string>): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("haiku")) return 1;
  if (m.includes("sonnet")) return 2;
  if (m.includes("opus")) return 3;
  if (m.includes("fable") || m.includes("mythos")) return 4;
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
// listed: gates/judge = strong, every producer = mid (model_routing.md table).
function builtinSeatTier(seat: string): Tier {
  return GATE_SEATS.has(seat) ? "strong" : "mid";
}

// ── config ───────────────────────────────────────────────────────────────────
export interface RoutingConfig {
  present: boolean; // was a [model_routing] section present at all
  rulesOn: boolean;
  abovePm: AbovePmPolicy;
  tiers: Record<Tier, string>;
  seats: Record<string, string>; // seat -> tier name OR a direct model id
}

export function emptyConfig(): RoutingConfig {
  return { present: false, rulesOn: false, abovePm: "deny", tiers: { ...DEFAULT_TIERS }, seats: {} };
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

  const rawAbove = typeof m.above_pm === "string" ? m.above_pm.trim().toLowerCase() : "";
  const abovePm = (ABOVE_PM_POLICIES as readonly string[]).includes(rawAbove)
    ? (rawAbove as AbovePmPolicy)
    : "deny";

  return { present: true, rulesOn, abovePm, tiers, seats };
}

export function loadRoutingConfig(project: string, pmId: string): RoutingConfig {
  const path = join(project, "__garelier", pmId, "_pm", "setup_config.toml");
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
  pmModel?: string; // escalation ceiling; falls back to the mid tier when absent
}

export interface RoutingResult {
  // Safe-to-spawn model. Under deny AND ask this is already clamped to the ceiling,
  // so any UNATTENDED consumer (jig / dispatch_prepare) is deny-equivalent with no
  // extra logic. "" = inherit (caller passes no --model).
  model: string;
  effort: string; // "" = inherit
  source: string; // flag | blueprint | rule:<names> | seat-default | inherit (+clamped-pm-ceiling / +needs-confirmation)
  seat: string;
  // The escalated model an ATTENDED PM may spawn after user confirmation (above_pm=ask),
  // or the model clamped away (above_pm=deny). "" when no ceiling acted.
  suggested_model: string;
  needs_confirmation: boolean; // true only under above_pm=ask when an escalation was suggested
  above_pm: AbovePmPolicy;
  // Non-blocking advisories (never change the resolution). Empty in the normal case.
  // `gate_weaker_than_producer` / `gate_below_mid`: the anti-pattern where a
  // strong producer is gated by a weaker Guardian/Observer/Judge (model_routing.md).
  warnings: string[];
}

// Rank of a seat's configured value: a tier name resolves through tiers, else it is
// a direct model id. null when unset/unrankable.
function seatRank(value: string | undefined, tiers: Record<Tier, string>): number | null {
  if (!value) return null;
  return isTierName(value) ? rankModel(tiers[value], tiers) : rankModel(value, tiers);
}

// Non-blocking advisory: a gate seat (Guardian/Observer/Judge) resolved WEAKER than
// the producers it gates lets a bad merge through (model_routing.md anti-pattern).
// Compare the gate's resolved rank against the producer default — `seats.worker`'s
// resolved rank -> `gate_weaker_than_producer`; when `seats.worker` is not
// configured the comparison cannot be made, so fall back to flagging a gate below
// the mid tier -> `gate_below_mid`. `above_pm` only bounds the ceiling — it does not
// constrain this relative comparison, so the warning can fire even when the resolved
// model is within the PM ceiling.
function computeWarnings(input: RoutingInput, resolvedModel: string): string[] {
  if (!GATE_SEATS.has(input.seat.toLowerCase())) return [];
  const tiers = input.config.tiers;
  const gateRank = rankModel(resolvedModel, tiers);
  if (gateRank === null) return []; // inherit or unrankable — nothing to compare

  const workerRank = seatRank(input.config.seats["worker"], tiers);
  if (workerRank !== null) {
    return gateRank < workerRank ? ["gate_weaker_than_producer"] : [];
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
  // No [model_routing] section => inherit (back-compat: no automatic routing).
  if (!input.config.present) return { model: "", source: "inherit" };

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

  // 5. inherit.
  return { model: "", source: "inherit" };
}

function resolveEffort(input: RoutingInput): string {
  if (input.flagEffort && input.flagEffort.trim()) return input.flagEffort.trim();
  if (input.blueprintEffort && input.blueprintEffort.trim()) return input.blueprintEffort.trim();
  return "";
}

interface EscalationOutcome {
  model: string;
  source: string;
  suggested: string;
  needsConfirmation: boolean;
}

// Produce the clamped/flagged outcome for a model that must not pass the ceiling.
// `model` is always the SAFE value; under ask it additionally carries the escalated
// `suggested` + needsConfirmation for an attended PM to spawn after user approval.
function clamp(resolved: { model: string; source: string }, safeModel: string, policy: AbovePmPolicy): EscalationOutcome {
  if (policy === "ask") {
    return {
      model: safeModel,
      source: `${resolved.source}+needs-confirmation`,
      suggested: resolved.model,
      needsConfirmation: true,
    };
  }
  // deny (default): clamp to the ceiling; the escalated model is reported for visibility.
  return { model: safeModel, source: `${resolved.source}+clamped-pm-ceiling`, suggested: resolved.model, needsConfirmation: false };
}

// Apply the above-PM ceiling to an already-resolved model. `allow` short-circuits;
// otherwise the ceiling is the PM model (when rankable) or the conservative `mid`
// tier (when the PM model is unknown). A desired model that cannot be ranked at all
// is clamped to the mid tier under deny/ask — the safe side, since we cannot prove
// it is within the ceiling.
function applyEscalation(resolved: { model: string; source: string }, input: RoutingInput): EscalationOutcome {
  const policy = input.config.abovePm;
  const tiers = input.config.tiers;
  const base: EscalationOutcome = { model: resolved.model, source: resolved.source, suggested: "", needsConfirmation: false };
  if (policy === "allow") return base;
  if (!resolved.model) return base; // inherit — nothing to clamp

  const desiredRank = rankModel(resolved.model, tiers);
  // Incomparable desired: cannot prove it is within the ceiling -> safe-side clamp
  // to the mid tier (unless it already IS the mid tier by identity).
  if (desiredRank === null) {
    if (resolved.model.trim() === tiers.mid) return base;
    return clamp(resolved, tiers.mid, policy);
  }

  // Ceiling: the PM's model when known/rankable, else conservatively the mid tier.
  const pmRank = rankModel(input.pmModel, tiers);
  const ceilingModel = pmRank !== null ? input.pmModel!.trim() : tiers.mid;
  const ceilingRank = pmRank !== null ? pmRank : rankModel(tiers.mid, tiers);
  if (ceilingRank === null || desiredRank <= ceilingRank) return base; // within ceiling

  return clamp(resolved, ceilingModel, policy);
}

export function resolveRouting(input: RoutingInput): RoutingResult {
  const model = resolveModel(input);
  const escalated = applyEscalation(model, input);
  return {
    model: escalated.model,
    effort: resolveEffort(input),
    source: escalated.source,
    seat: input.seat,
    suggested_model: escalated.suggested,
    needs_confirmation: escalated.needsConfirmation,
    above_pm: input.config.abovePm,
    warnings: computeWarnings(input, escalated.model),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const VALID_SEATS = new Set([
  "worker", "scout", "smith", "librarian", "artisan", "guardian", "observer", "judge",
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

  if (format === "text") {
    console.log(
      `seat=${result.seat} model=${result.model || "(inherit)"} effort=${result.effort || "(inherit)"} ` +
        `source=${result.source} above_pm=${result.above_pm}` +
        (result.suggested_model ? ` suggested=${result.suggested_model}` : "") +
        (result.needs_confirmation ? " NEEDS_CONFIRMATION" : "") +
        (result.warnings.length ? ` warnings=${result.warnings.join(",")}` : ""),
    );
  } else {
    console.log(JSON.stringify(result));
  }
  // A routing read never hard-fails dispatch.
  process.exit(0);
}

if (import.meta.main) main();
