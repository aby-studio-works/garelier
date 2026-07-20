import { rmSync } from "../../guard/path_guard.ts";
// W-083 ts-first: regression test for the fresh-mode scaffolder. The definitive
// byte parity is proven by a live bash-vs-TS diff of the whole control/runtime/
// knowledge/__atmos trees (control + knowledge + atmos IDENTICAL; runtime differs
// only by manifest.md, which the later fresh orchestration writes). This test
// pins the directory set and the interpolated heredocs against regression.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeControlTree, makeRuntimeTree, type ScaffoldCtx } from "./scaffold.ts";

let temp = "";
let prevCwd = "";
afterEach(() => {
  if (prevCwd) process.chdir(prevCwd);
  prevCwd = "";
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

function setup(): ScaffoldCtx {
  temp = mkdtempSync(join(tmpdir(), "garelier-wiz-scaffold-"));
  // control_scaffold is a REQUIRED template dir; provide an empty one so
  // makeControlTree succeeds without the real Librarian template trees.
  mkdirSync(join(temp, "templates", "control_scaffold"), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(temp);
  mkdirSync("__garelier/pm1/_crew/pm", { recursive: true });
  return {
    pmRoot: "__garelier/pm1",
    pmDir: "__garelier/pm1/_crew/pm",
    pmId: "pm1",
    projectName: "Crew fixture",
    target: "main",
    studioBranch: "garelier/main/pm1/studio",
    upgradeControlOnly: false,
    coreTemplatesDir: join(temp, "templates"),
  };
}

describe("makeRuntimeTree", () => {
  test("creates the runtime tree, librarian README, and .gitkeep set", () => {
    const ctx = setup();
    makeRuntimeTree(ctx);
    for (const d of [
      "runtime/dock/inbox-archive", "runtime/merge_gate/locks", "runtime/observer/results",
      "runtime/guardian/inbox", "runtime/concierge/archive", "runtime/librarian/drafts",
      "runtime/requests/failed", "runtime/scheduled_jobs/runs",
    ]) {
      expect(existsSync(join(ctx.pmRoot, d))).toBe(true);
    }
    expect(existsSync(join(ctx.pmRoot, "runtime/dock/inbox/.gitkeep"))).toBe(true);
    expect(readFileSync(join(ctx.pmRoot, "runtime/librarian/README.md"), "utf8")).toContain(
      "# Librarian local-only working area (NOT committed)",
    );
  });
});

describe("makeControlTree", () => {
  test("returns true, writes interpolated heredocs + control.toml byte-exact", () => {
    const ctx = setup();
    expect(makeControlTree(ctx)).toBe(true);

    expect(readFileSync(join(ctx.pmRoot, "control/README.md"), "utf8")).toBe(
      `# Garelier Control — PM: pm1\n\n` +
        "This tree holds the persistent project authority for PM `pm1`:\n" +
        "project dashboard, operations rules, blueprints, inspections, request\n" +
        "intake, delegation, scheduled jobs, decisions, and reports.\n\n" +
        "Sibling `__garelier/pm1/runtime/` holds transient execution state.\n\n" +
        "For the read order and authority order, see\n" +
        "`project_dashboard/README.md` and the individual operations files.\n",
    );
    expect(readFileSync(join(ctx.pmRoot, "control/operations/runbook.md"), "utf8")).toBe(
      "# Runbook\n\nProject: Crew fixture\nPM:            pm1\nTarget branch: main\n" +
        "Studio branch: garelier/main/pm1/studio\n\n(Add project-specific startup/shutdown notes here.)\n",
    );
    expect(readFileSync(join(ctx.pmRoot, "control/control.toml"), "utf8")).toBe(
      'schema_version = 1\nkind = "garelier_control"\npm_id = "pm1"\nmode = "full"\n',
    );
    // quality_gates.md references AGENTS.md §2 (quoted heredoc).
    expect(readFileSync(join(ctx.pmRoot, "control/project_dashboard/quality_gates.md"), "utf8")).toContain(
      "See AGENTS.md §2",
    );
  });

  test("returns false when the required control_scaffold template is missing", () => {
    const ctx = setup();
    ctx.coreTemplatesDir = join(temp, "no-such-templates");
    expect(makeControlTree(ctx)).toBe(false);
  });

  test("upgradeControlOnly skips the seeded control docs", () => {
    const ctx = setup();
    ctx.upgradeControlOnly = true;
    expect(makeControlTree(ctx)).toBe(true);
    expect(existsSync(join(ctx.pmRoot, "control/README.md"))).toBe(false);
    expect(existsSync(join(ctx.pmRoot, "control/control.toml"))).toBe(true); // always written
  });
});
