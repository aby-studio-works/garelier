import { rankModel, type RoutingResult } from "./model_routing.ts";

export const CODEX_LUNA_MODEL = "gpt-5.6-luna";

export type ProviderSubstrate =
  | "claude-agent"
  | "claude-team"
  | "claude-background"
  | "claude-headless"
  | "codex-exec";

export interface ProviderRouting {
  substrate: ProviderSubstrate;
  model: string;
  effort: string;
  source: string;
  execution: "llm" | "blocked";
  block_reason?: string;
  canonical: { model: string; effort: string; source: string };
}

export interface AdaptRoutingInput {
  substrate: ProviderSubstrate;
  seat: string;
  canonical: Pick<RoutingResult, "model" | "effort" | "source">;
  // A parent/substrate may forward its advertised selectable model ids. This is
  // deliberately optional: absence means "unknown", never a network probe.
  advertisedModels?: readonly string[];
}

const CODEX_MODEL_RE = /^(?:gpt-5\.\d|codex)/i;
export const VALID_PROVIDER_EFFORTS = new Set(["", "low", "medium", "high", "xhigh"]);

export function normalizeProviderEffort(value: string, allowInherit = true): string {
  const effort = value.trim().toLowerCase();
  if (effort === "ultra") throw new Error("provider routing: ultra effort is forbidden");
  if ((!allowInherit && !effort) || !VALID_PROVIDER_EFFORTS.has(effort)) throw new Error(`provider routing: unsupported effort '${effort}'`);
  return effort;
}

function canonicalTier(model: string): "light" | "mid" | "strong" | "unknown" {
  const rank = rankModel(model);
  if (rank === null) return "unknown";
  if (rank <= 1) return "light";
  if (rank === 2) return "mid";
  return "strong";
}

function advertisesModel(models: readonly string[] | undefined, model: string): boolean {
  const expected = model.toLowerCase();
  return models?.some((candidate) => candidate.trim().toLowerCase() === expected) ?? false;
}

export function adaptProviderRouting(input: AdaptRoutingInput): ProviderRouting {
  const canonical = {
    model: input.canonical.model.trim(),
    effort: normalizeProviderEffort(input.canonical.effort),
    source: input.canonical.source.trim(),
  };
  if (canonical.model && (canonical.model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(canonical.model))) throw new Error("provider routing: invalid canonical model token");
  if (!canonical.source || canonical.source.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/+,=-]*$/.test(canonical.source)) throw new Error("provider routing: invalid canonical source token");
  if (!input.substrate.startsWith("codex-")) {
    return {
      substrate: input.substrate,
      model: canonical.model,
      effort: canonical.effort,
      source: canonical.source,
      execution: "llm",
      canonical,
    };
  }

  let model = canonical.model;
  let mapped = "preserved";
  const gateSeat = ["guardian", "observer", "judge"].includes(input.seat.trim().toLowerCase());
  if (!model) {
    return {
      substrate: input.substrate,
      model: "",
      effort: canonical.effort,
      source: `${canonical.source}+adapter:block-inherit`,
      execution: "blocked",
      block_reason: "canonical routing resolved to inherit; Codex launch requires an explicit canonical model",
      canonical,
    };
  } else if (canonical.source.split("+")[0] === "flag") {
    // A task flag is the PM's explicit choice, not a capability probe or policy
    // request, so every seat receives it unchanged.
    return {
      substrate: input.substrate,
      model,
      effort: canonical.effort,
      source: `${canonical.source}+adapter:codex-explicit`,
      execution: "llm",
      canonical,
    };
  } else if (model.toLowerCase() === CODEX_LUNA_MODEL) {
    // A non-flag Luna selection is a capability-gated light-tier default.
    // Gate paths retain the Terra-or-stronger quality floor.
    if (gateSeat || !advertisesModel(input.advertisedModels, CODEX_LUNA_MODEL)) {
      model = "gpt-5.6-terra";
      mapped = gateSeat ? "gate-floor-terra" : "default-luna-fallback-terra";
    }
  } else if (!CODEX_MODEL_RE.test(model)) {
    // A direct dispatch flag is an attended caller's explicit provider-model
    // choice. Preserve arbitrary provider ids rather than attempting to rank or
    // translate them; only canonical tier names flow through the Luna/Terra/Sol
    // adapter.
    const tier = canonicalTier(model);
    if (tier === "unknown") {
      return {
        substrate: input.substrate,
        model: "",
        effort: canonical.effort,
        source: `${canonical.source}+adapter:block-untranslatable`,
        execution: "blocked",
        block_reason: `canonical model '${model}' cannot be translated to Codex`,
        canonical,
      };
    }
    if (tier === "strong") {
      model = "gpt-5.6-sol";
    } else if (tier === "light" && advertisesModel(input.advertisedModels, CODEX_LUNA_MODEL)) {
      model = CODEX_LUNA_MODEL;
      mapped = "canonical-light-luna";
    } else {
      // A capability list that is absent, empty, or does not name Luna is not
      // evidence that Luna is selectable. Keep the old safe Codex mapping.
      model = "gpt-5.6-terra";
      mapped = tier === "light" ? "canonical-light-fallback-terra" : `canonical-${tier}`;
    }
  }
  return {
    substrate: input.substrate,
    model,
    effort: canonical.effort,
    source: `${canonical.source}+adapter:codex-${mapped}`,
    execution: "llm",
    canonical,
  };
}
