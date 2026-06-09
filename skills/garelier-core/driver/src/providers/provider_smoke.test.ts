import { test, expect, describe, afterEach } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProviderSmoke } from "./provider_smoke.ts";
import type { ProviderKind } from "../config.ts";

const mockPath = join(import.meta.dir, "mock_provider.mjs");
const KINDS: ProviderKind[] = ["claude-code", "codex-cli", "gemini-cli", "copilot-cli", "cursor-cli"];

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("provider smoke (mock round-trip, all 5 providers)", () => {
  for (const kind of KINDS) {
    test(`${kind}: build → spawn mock → parse round-trips (exit 0, result extracted)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "provsmk-")); dirs.push(dir);
      const res = await runProviderSmoke(kind, {
        tmpDir: dir,
        prompt: "SMOKE-PING",
        providerCommand: [process.execPath, mockPath, kind],
      });
      expect(res.exitCode).toBe(0);
      expect(res.ok).toBe(true);
      expect(res.result).toContain(`MOCK[${kind}]`);
    });
  }
});
