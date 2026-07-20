import { rankModel, type RoutingResult } from "./model_routing.ts";

export type ProviderSubstrate =
  | "claude-agent"
  | "claude-team"
  | "claude-background"
  | "claude-headless"
  | "codex-app"
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
  } else if (!CODEX_MODEL_RE.test(model)) {
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
    model = tier === "strong" ? "gpt-5.6-sol" : "gpt-5.6-terra";
    mapped = `canonical-${tier}`;
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

export function codexAppSpawnDirective(
  routing: Pick<ProviderRouting, "model" | "effort" | "execution">,
  name: string,
  forkTurns = "none",
): string {
  if (routing.execution === "blocked") throw new Error("Codex Desktop spawn blocked by unresolved canonical routing");
  const override = Boolean(routing.model || routing.effort);
  if (override && (forkTurns === "all" || !/^(?:none|[1-9]\d*)$/.test(forkTurns))) {
    throw new Error("Codex Desktop override requires fork_turns=none or a positive limited fork");
  }
  return `spawn_agent(name=${name}, model=${routing.model}, reasoning_effort=${routing.effort}, fork_turns=${forkTurns}); all-history inheritance is forbidden for this routed override.`;
}
