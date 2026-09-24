import { rankModel, type RoutingResult, type TierTables } from "./model_routing.ts";

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
  canonical: Pick<RoutingResult, "model" | "effort" | "source">;
  // W-846: the project's `[model_routing.tiers.<provider>]` tables (null when the
  // project declares none). A non-flag Codex route is translated ONLY through
  // them; the adapter holds no model id of its own.
  tiers: TierTables | null;
}

export const VALID_PROVIDER_EFFORTS = new Set(["", "low", "medium", "high", "xhigh"]);

export function normalizeProviderEffort(value: string, allowInherit = true): string {
  const effort = value.trim().toLowerCase();
  if (effort === "ultra") throw new Error("provider routing: ultra effort is forbidden");
  if ((!allowInherit && !effort) || !VALID_PROVIDER_EFFORTS.has(effort)) throw new Error(`provider routing: unsupported effort '${effort}'`);
  return effort;
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

  const model = canonical.model;
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
  }
  if (canonical.source.split("+")[0] === "flag") {
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
  }
  // A non-flag model is placed by the tier table alone: a codex-table id is kept,
  // another provider's id becomes the codex id of the same tier, and an id no
  // table lists blocks — it is never ranked by its spelling or mapped to a default.
  const tiers = input.tiers;
  const rank = rankModel(model, tiers);
  if (!tiers || rank.kind !== "ranked") {
    return {
      substrate: input.substrate,
      model: "",
      effort: canonical.effort,
      source: `${canonical.source}+adapter:block-untranslatable`,
      execution: "blocked",
      block_reason: tiers
        ? `canonical model '${model}' cannot be translated to Codex: no [model_routing.tiers.<provider>] row lists it`
        : `canonical model '${model}' cannot be translated to Codex: the project declares no [model_routing.tiers] table`,
      canonical,
    };
  }
  const preserved = rank.provider === "codex";
  return {
    substrate: input.substrate,
    model: preserved ? model : tiers.codex[rank.tier],
    effort: canonical.effort,
    source: `${canonical.source}+adapter:codex-${preserved ? "preserved" : `canonical-${rank.tier}`}`,
    execution: "llm",
    canonical,
  };
}
