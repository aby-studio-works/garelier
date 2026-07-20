import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";

const MERGE_REQUEST = join(import.meta.dir, "merge_request.ts");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A minimal project whose setup_config carries the integration branch, so
 * merge_request can write a request without a real repo. */
function makeProject(pm = "tpm"): string {
  const root = mkdtempSync(join(tmpdir(), "merge-request-"));
  roots.push(root);
  const pmDir = join(root, "__garelier", pm, "_pm");
  mkdirSync(pmDir, { recursive: true });
  writeFileSync(join(pmDir, "setup_config.toml"), '[branches]\nintegration = "garelier/main/tpm/studio"\n');
  return root;
}

/** Extract the first quoted token after `bun ` — the waiter script path. */
function waiterScriptPath(waiterCmd: string): string | undefined {
  const m = /^bun\s+"([^"]+)"/.exec(waiterCmd);
  return m?.[1];
}

// W-180: the printed waiter_cmd pointed at `garelier-core/scripts/gate_result_waiter.ts`
// (a `../../../scripts` resolve) but the file lives in THIS directory
// (driver/src/scripts) — a PM running the command verbatim hit `Module not found`
// and the merge-completion push never armed. The waiter_cmd must reference the real,
// existing script so verbatim execution resolves.
test("W-180: merge_request --no-poll emits a waiter_cmd whose script path exists (verbatim-executable)", () => {
  const project = makeProject();
  const result = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", "garelier/main/tpm/workbench/#1/w180", "--guardian", "PASS", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(0);
  const line = result.stdout.toString().trim().split(/\r?\n/).findLast((v) => v.startsWith("{"));
  expect(line).toBeTruthy();
  const parsed = JSON.parse(line!);
  const script = waiterScriptPath(parsed.waiter_cmd);
  expect(script).toBeTruthy();
  // The path a PM would run verbatim resolves to a real file.
  expect(existsSync(script!)).toBe(true);
  // Regression guard against the stale `../../../scripts` location.
  expect(script!.replace(/\\/g, "/")).toContain("driver/src/scripts/gate_result_waiter.ts");
});

// The submit-time assert fails fast if the script is ever relocated, instead of
// silently emitting a dead waiter_cmd. We prove it points at the real sibling.
test("W-180: the emitted waiter script is a real sibling of merge_request.ts", () => {
  const expected = join(import.meta.dir, "gate_result_waiter.ts");
  expect(existsSync(expected)).toBe(true);
});
