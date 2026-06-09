// DEC-042: token-efficiency aggregation tests (readEfficiency).
// Pure file read over the latest month's usage JSONL — no provider, no model
// changes. Verifies the cache-hit math, per-role sums, action-kind mix, latest-
// month selection, corrupt-line tolerance, and the empty-month safe zeros.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEfficiency } from "./status_snapshot.ts";

function runtimeWithUsage(files: Record<string, unknown[] | string>): string {
  // files: { "2026-06": [recordObjects...] } — an array of records, or a raw
  // string (to inject corrupt lines / pre-joined content).
  const runtime = mkdtempSync(join(tmpdir(), "gar-eff-"));
  const usageDir = join(runtime, "driver", "usage");
  mkdirSync(usageDir, { recursive: true });
  for (const [month, content] of Object.entries(files)) {
    const body = typeof content === "string"
      ? content
      : content.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(join(usageDir, `${month}.jsonl`), body, "utf8");
  }
  return runtime;
}

describe("readEfficiency (DEC-042)", () => {
  test("empty / missing usage dir → safe zeros", () => {
    const runtime = mkdtempSync(join(tmpdir(), "gar-eff-empty-"));
    const e = readEfficiency(runtime, null);
    expect(e.latestMonth).toBeNull();
    expect(e.totalIterations).toBe(0);
    expect(e.avgInputTokensPerIteration).toBeNull();
    expect(e.cacheHitRatio).toBeNull();
    expect(e.totalCostUsd).toBe(0);
    expect(e.topRolesByInputTokens).toEqual([]);
    expect(e.actionKindMix).toEqual([]);
  });

  test("aggregates context tokens, cache-hit ratio, per-role sums, action mix", () => {
    const runtime = runtimeWithUsage({
      "2026-06":
        [
          { role: "worker", id: "worker-01", input_tokens: 1000, cache_read: 9000, cache_write: 0, cost_usd: 0.5, final_action_kind: "action" },
          { role: "worker", id: "worker-01", input_tokens: 2000, cache_read: 8000, cache_write: 0, cost_usd: 0.5, final_action_kind: "action" },
        ]
          .map((r) => JSON.stringify(r))
          .concat(["not-json{", JSON.stringify({ role: "scout", id: "scout-01", input_tokens: 1000, cache_read: 0, cache_write: 0, cost_usd: 0.1, final_action_kind: "no_action" })])
          .concat([JSON.stringify({ role: "dock", input_tokens: 500, cache_read: 500, cache_write: 0, cost_usd: 0.05, final_action_kind: "coord_only" })])
          .join("\n") + "\n",
    });
    const e = readEfficiency(runtime, null);
    expect(e.latestMonth).toBe("2026-06");
    expect(e.totalIterations).toBe(4); // corrupt line skipped
    // context per record: 10000, 10000, 1000, 1000 → sum 22000 / 4 = 5500
    expect(e.avgInputTokensPerIteration).toBe(5500);
    // cache hit = sumCacheRead / (sumInput + sumCacheRead) = 17500 / 22000
    expect(e.cacheHitRatio).toBeCloseTo(17500 / 22000, 6);
    expect(e.totalCostUsd).toBeCloseTo(1.15, 4);
    // worker-01 dominates input tokens (20000), then scout & dock (1000 each)
    expect(e.topRolesByInputTokens[0]).toMatchObject({ role: "worker", id: "worker-01", inputTokens: 20000, count: 2 });
    expect(e.topRolesByInputTokens[0].costUsd).toBeCloseTo(1.0, 4);
    // action mix: action(2) first, then the count-1 kinds sorted by name
    expect(e.actionKindMix[0]).toEqual({ kind: "action", count: 2 });
    const counts = Object.fromEntries(e.actionKindMix.map((k) => [k.kind, k.count]));
    expect(counts).toEqual({ action: 2, coord_only: 1, no_action: 1 });
  });

  test("uses the latest month when several usage files exist", () => {
    const runtime = runtimeWithUsage({
      "2026-05": [{ role: "worker", input_tokens: 100, cache_read: 0, cost_usd: 0.01, final_action_kind: "action" }],
      "2026-06": [{ role: "smith", input_tokens: 7, cache_read: 3, cost_usd: 0.02, final_action_kind: "action" }],
    });
    const e = readEfficiency(runtime, null);
    expect(e.latestMonth).toBe("2026-06");
    expect(e.totalIterations).toBe(1);
    expect(e.topRolesByInputTokens[0].role).toBe("smith");
    expect(e.cacheHitRatio).toBeCloseTo(3 / 10, 6);
  });
});
