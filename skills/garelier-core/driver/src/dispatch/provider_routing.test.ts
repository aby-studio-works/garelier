import { describe, expect, test } from "bun:test";
import { adaptProviderRouting, codexAppSpawnDirective } from "./provider_routing.ts";

const canonical = (model = "", effort = "", source = "inherit") => ({ model, effort, source });

describe("provider routing adapter", () => {
  test("keeps canonical Claude routing unchanged", () => {
    expect(adaptProviderRouting({ substrate: "claude-agent", seat: "worker", canonical: canonical("sonnet", "high", "blueprint") }))
      .toMatchObject({ model: "sonnet", effort: "high", source: "blueprint" });
  });

  test("translates existing canonical tiers and preserves explicit Codex values", () => {
    expect(adaptProviderRouting({ substrate: "codex-exec", seat: "worker", canonical: canonical("sonnet", "high", "seat-default") }))
      .toMatchObject({ model: "gpt-5.6-terra", effort: "high", canonical: { source: "seat-default" } });
    expect(adaptProviderRouting({ substrate: "codex-app", seat: "guardian", canonical: canonical("opus", "high", "rule:gate-seat") }))
      .toMatchObject({ model: "gpt-5.6-sol", effort: "high", canonical: { source: "rule:gate-seat" } });
    expect(adaptProviderRouting({ substrate: "codex-exec", seat: "worker", canonical: canonical("gpt-5.6-sol", "xhigh", "flag") }))
      .toMatchObject({ model: "gpt-5.6-sol", effort: "xhigh", canonical: { source: "flag" } });
  });

  test("blocks canonical inherit/unknown and rejects ultra", () => {
    expect(adaptProviderRouting({ substrate: "codex-exec", seat: "worker", canonical: canonical() }))
      .toMatchObject({ execution: "blocked", model: "", block_reason: expect.any(String) });
    expect(adaptProviderRouting({ substrate: "codex-exec", seat: "worker", canonical: canonical("custom-provider-model", "high", "flag") }))
      .toMatchObject({ execution: "blocked" });
    expect(() => adaptProviderRouting({ substrate: "codex-exec", seat: "worker", canonical: canonical("gpt-5.6-sol", "ultra", "flag") }))
      .toThrow("ultra");
  });

  test("accepts multi-rule provenance and rejects command-token injection", () => {
    expect(adaptProviderRouting({ substrate: "codex-exec", seat: "worker", canonical: canonical("gpt-5.6-terra", "high", "rule:schema,security") }))
      .toMatchObject({ execution: "llm", canonical: { source: "rule:schema,security" } });
    expect(() => adaptProviderRouting({ substrate: "codex-exec", seat: "worker", canonical: canonical('gpt-5.6-terra" --danger', "high", "flag") })).toThrow("model token");
    expect(() => adaptProviderRouting({ substrate: "codex-exec", seat: "worker", canonical: canonical("gpt-5.6-terra", "high", "flag\nforged") })).toThrow("source token");
  });

  test("Codex Desktop override requires a bounded context fork", () => {
    const route = adaptProviderRouting({ substrate: "codex-app", seat: "worker", canonical: canonical("sonnet", "high", "seat-default") });
    expect(codexAppSpawnDirective(route, "ga-worker-1", "none")).toContain("fork_turns=none");
    expect(() => codexAppSpawnDirective(route, "ga-worker-1", "all")).toThrow("fork_turns");
  });
});
