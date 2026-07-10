import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDiffPaths,
  patchContextTouchesActual,
  computeTouchesActual,
  readBaseShaFromContext,
  recordTouches,
  type GitRunner,
} from "./record_touches.ts";

// A stub git that returns a fixed name-only diff for `diff --name-only <base> HEAD`.
const stubGit = (out: string, code = 0): GitRunner => (args) =>
  args[0] === "diff" ? { code, stdout: out } : { code: 1, stdout: "" };

const tmps: string[] = [];
function mkContext(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-"));
  tmps.push(dir);
  const p = join(dir, "context.json");
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return p;
}
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("parseDiffPaths", () => {
  test("dedupes, trims, drops blanks, sorts", () => {
    expect(parseDiffPaths("b.rs\n\na.rs\nb.rs\n  c.rs  \n")).toEqual(["a.rs", "b.rs", "c.rs"]);
  });
  test("empty diff -> empty array", () => {
    expect(parseDiffPaths("")).toEqual([]);
    expect(parseDiffPaths("\n\n")).toEqual([]);
  });
});

describe("patchContextTouchesActual", () => {
  test("sets task.touches_actual, preserves every other field + 2-space shape", () => {
    const src = JSON.stringify({ task: { slug: "x", touches: ["a"], base_sha: "abc" }, project: { pm_id: "p" } }, null, 2) + "\n";
    const out = patchContextTouchesActual(src, ["core/x.rs", "core/y.rs"]);
    const parsed = JSON.parse(out);
    expect(parsed.task.touches_actual).toEqual(["core/x.rs", "core/y.rs"]);
    expect(parsed.task.touches).toEqual(["a"]); // declared prediction preserved
    expect(parsed.task.slug).toBe("x");
    expect(parsed.project.pm_id).toBe("p");
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('  "task"'); // 2-space indent
  });
  test("creates task object when absent", () => {
    const out = patchContextTouchesActual("{}", ["z.rs"]);
    expect(JSON.parse(out).task.touches_actual).toEqual(["z.rs"]);
  });
  test("throws on invalid JSON (caller treats as leave-as-is)", () => {
    expect(() => patchContextTouchesActual("{not json", [])).toThrow();
  });
});

describe("computeTouchesActual", () => {
  test("returns the parsed diff on git success", () => {
    expect(computeTouchesActual("/co", "abc", stubGit("b.rs\na.rs\n"))).toEqual(["a.rs", "b.rs"]);
  });
  test("null on git failure (leaves the pack untouched)", () => {
    expect(computeTouchesActual("/co", "abc", stubGit("", 1))).toBeNull();
  });
  test("null on empty base sha", () => {
    expect(computeTouchesActual("/co", "", stubGit("a.rs"))).toBeNull();
  });
});

describe("readBaseShaFromContext", () => {
  test("reads task.base_sha", () => {
    expect(readBaseShaFromContext(mkContext({ task: { base_sha: "deadbee" } }))).toBe("deadbee");
  });
  test("null when absent / unreadable", () => {
    expect(readBaseShaFromContext(mkContext({ task: {} }))).toBeNull();
    expect(readBaseShaFromContext("/no/such/context.json")).toBeNull();
  });
});

describe("recordTouches (end to end with a stub git)", () => {
  test("records actual touches into the file; falls back to context base_sha", () => {
    const ctx = mkContext({ task: { slug: "p2a", base_sha: "base123", touches: ["factory/**", "dispatch/**"] } });
    const res = recordTouches(ctx, "/co", null, stubGit("core/canonical/state.rs\ncore/canonical/pack.rs\n"));
    expect(res.ok).toBe(true);
    expect(res.recorded).toEqual(["core/canonical/pack.rs", "core/canonical/state.rs"]);
    const written = JSON.parse(readFileSync(ctx, "utf8"));
    // The MEASURED set is recorded alongside — not overwriting — the stale prediction.
    expect(written.task.touches_actual).toEqual(["core/canonical/pack.rs", "core/canonical/state.rs"]);
    expect(written.task.touches).toEqual(["factory/**", "dispatch/**"]);
  });
  test("--base-sha override wins over context base_sha", () => {
    const ctx = mkContext({ task: { base_sha: "ignored" } });
    let seenBase = "";
    const spy: GitRunner = (args) => { if (args[0] === "diff") seenBase = args[2]; return { code: 0, stdout: "a.rs" }; };
    recordTouches(ctx, "/co", "override99", spy);
    expect(seenBase).toBe("override99");
  });
  test("ok=false + no write when base_sha missing", () => {
    const ctx = mkContext({ task: {} });
    const before = readFileSync(ctx, "utf8");
    const res = recordTouches(ctx, "/co", null, stubGit("a.rs"));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("base_sha");
    expect(readFileSync(ctx, "utf8")).toBe(before); // untouched
  });
  test("ok=false + no write when git fails", () => {
    const ctx = mkContext({ task: { base_sha: "b" } });
    const before = readFileSync(ctx, "utf8");
    const res = recordTouches(ctx, "/co", null, stubGit("", 1));
    expect(res.ok).toBe(false);
    expect(readFileSync(ctx, "utf8")).toBe(before);
  });
  test("ok=false when context.json missing", () => {
    expect(recordTouches("/no/such.json", "/co", "b", stubGit("a")).ok).toBe(false);
  });
});
