// W-083 ts-first: parity test for the flat -> crew migration cluster. Rebuilds
// the setup_wizard_crew.test.sh migrate fixture (a real git repo with a role
// worktree, tracked PM/Dock files, and a workspace_paths pointer) and drives the
// TS migrateFlatToCrew / crewMigrationPrecondition directly, asserting the same
// outcomes the bash crew test asserts (moves, repair, rewrite, verify,
// idempotency, and the three read-only rejections).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../_lib.ts";
import { resolveGarelierDirs } from "./env.ts";
import {
  crewMigrationPrecondition,
  ensureLensesDefaults,
  migrateFlatToCrew,
  rewriteSetupConfigVersion,
  type MigrateCtx,
} from "./migrate.ts";

const dirs = resolveGarelierDirs();

let temp = "";
let prevCwd = "";
afterEach(() => {
  if (prevCwd) process.chdir(prevCwd);
  prevCwd = "";
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.email", "fixture@example.invalid"]);
  git(path, ["config", "user.name", "Garelier Fixture"]);
  writeFileSync(join(path, "README.md"), "fixture\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "-q", "-m", "fixture root"]);
}

// Build the crew test's flat per-PM migrate fixture under `repo`.
function buildMigrateFixture(repo: string): void {
  initRepo(repo);
  mkdirSync(join(repo, "__garelier/pm1/_pm"), { recursive: true });
  mkdirSync(join(repo, "__garelier/pm1/_dock"), { recursive: true });
  mkdirSync(join(repo, "__garelier/pm1/runtime"), { recursive: true });
  const posix = repo.replace(/\\/g, "/");
  writeFileSync(
    join(repo, "__garelier/pm1/_pm/setup_config.toml"),
    [
      "[project]",
      'name = "Migrate fixture"',
      'garelier_version = "2.11.0"',
      "",
      "[pm]",
      'pm_id = "pm1"',
      "",
      "[branches]",
      'target = "main"',
      'target_slug = "main"',
      'integration = "garelier/main/pm1/studio"',
      "",
      "[workspace]",
      'home_root = ":in-project:"',
      "",
      "[[workers]]",
      'id = "w1"',
      'provider = "codex-cli"',
      'model = "codex"',
      `worktree = "${posix}/__garelier/pm1/_workers/w1"`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(repo, "__garelier/pm1/_pm/sentinel.txt"), "pm sentinel\n");
  writeFileSync(join(repo, "__garelier/pm1/_dock/sentinel.txt"), "dock sentinel\n");
  git(repo, ["add", "__garelier/pm1/_pm", "__garelier/pm1/_dock"]);
  git(repo, ["commit", "-q", "-m", "flat layout fixture"]);
  git(repo, ["branch", "garelier/main/pm1/studio", "main"]);
  git(repo, ["branch", "garelier/main/pm1/workbench/#1/migrate", "garelier/main/pm1/studio"]);
  mkdirSync(join(repo, "__garelier/pm1/_workers/w1"), { recursive: true });
  git(repo, ["worktree", "add", "-q", join(repo, "__garelier/pm1/_workers/w1/checkout"), "garelier/main/pm1/workbench/#1/migrate"]);
  writeFileSync(join(repo, "__garelier/pm1/_workers/w1/mailbox.txt"), "worker mailbox sentinel\n");
  writeFileSync(join(repo, "__garelier/pm1/runtime/workspace_paths"), `worker.w1=${posix}/__garelier/pm1/_workers/w1\n`);
}

describe("migrateFlatToCrew (crew test fixture 4 parity)", () => {
  test("moves containers, repairs the worktree, rewrites paths, verifies, idempotent", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-migrate-"));
    const repo = join(temp, "migrate");
    buildMigrateFixture(repo);
    prevCwd = process.cwd();
    process.chdir(repo);
    const ctx: MigrateCtx = { pmId: "pm1", gitRoot: repo, dirs };

    expect(migrateFlatToCrew(ctx)).toBe(true);

    expect(readFileSync(join(repo, "__garelier/pm1/_crew/pm/sentinel.txt"), "utf8")).toBe("pm sentinel\n");
    expect(readFileSync(join(repo, "__garelier/pm1/_crew/dock/sentinel.txt"), "utf8")).toBe("dock sentinel\n");
    expect(readFileSync(join(repo, "__garelier/pm1/_crew/workers/w1/mailbox.txt"), "utf8")).toBe("worker mailbox sentinel\n");

    const newCheckout = join(repo, "__garelier/pm1/_crew/workers/w1/checkout");
    expect(git(newCheckout, ["status", "--porcelain"]).exitCode).toBe(0);
    expect(
      git(repo, ["worktree", "list", "--porcelain"]).stdout.includes("/_crew/workers/w1/checkout"),
    ).toBe(true);
    expect(readFileSync(join(repo, "__garelier/pm1/_crew/pm/setup_config.toml"), "utf8")).toContain("/_crew/workers/w1");
    // workspace_paths pointer rewritten to the crew container.
    expect(readFileSync(join(repo, "__garelier/pm1/runtime/workspace_paths"), "utf8")).toContain("/_crew/workers/w1");

    // No flat role containers remain.
    for (const flat of ["_pm", "_dock", "_workers", "_scouts", "_smiths", "_artisan"]) {
      expect(existsSync(join(repo, "__garelier/pm1", flat))).toBe(false);
    }

    // Idempotent second run.
    expect(migrateFlatToCrew(ctx)).toBe(true);
    expect(existsSync(join(repo, "__garelier/pm1/_crew/workers/w1/checkout/.git"))).toBe(true);
  });
});

describe("crewMigrationPrecondition (read-only rejections)", () => {
  function freshFixture(): { repo: string } {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-precond-"));
    const repo = join(temp, "migrate");
    buildMigrateFixture(repo);
    prevCwd = process.cwd();
    process.chdir(repo);
    return { repo };
  }

  test("rejects an active dispatch container", () => {
    const { repo } = freshFixture();
    mkdirSync(join(repo, "__garelier/pm1/_dispatch1"), { recursive: true });
    writeFileSync(join(repo, "__garelier/pm1/_dispatch1/sentinel.txt"), "active\n");
    expect(crewMigrationPrecondition({ pmId: "pm1", gitRoot: repo, dirs }, "__garelier/pm1")).toBe(false);
  });

  test("rejects a merge-gate lock", () => {
    const { repo } = freshFixture();
    mkdirSync(join(repo, "__garelier/pm1/runtime/merge_gate/locks"), { recursive: true });
    writeFileSync(join(repo, "__garelier/pm1/runtime/merge_gate/locks/active.lock"), "locked\n");
    expect(crewMigrationPrecondition({ pmId: "pm1", gitRoot: repo, dirs }, "__garelier/pm1")).toBe(false);
  });

  test("rejects a dirty registered role worktree", () => {
    const { repo } = freshFixture();
    writeFileSync(join(repo, "__garelier/pm1/_workers/w1/checkout/README.md"), "fixture\ndirty\n");
    expect(crewMigrationPrecondition({ pmId: "pm1", gitRoot: repo, dirs }, "__garelier/pm1")).toBe(false);
  });

  test("passes a clean flat fixture", () => {
    const { repo } = freshFixture();
    expect(crewMigrationPrecondition({ pmId: "pm1", gitRoot: repo, dirs }, "__garelier/pm1")).toBe(true);
  });
});

describe("migrate path-(a) tail helpers", () => {
  test("rewriteSetupConfigVersion bumps garelier/wizard version lines only", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-ver-"));
    const toml = join(temp, "setup_config.toml");
    writeFileSync(
      toml,
      ['name = "x"', 'garelier_version = "2.9.0"', 'pm_id = "pm1"', 'wizard_version = "2.9.0"', ""].join("\n"),
    );
    rewriteSetupConfigVersion(toml);
    expect(readFileSync(toml, "utf8")).toBe(
      ['name = "x"', 'garelier_version = "2.13.0"', 'pm_id = "pm1"', 'wizard_version = "2.13.0"', ""].join("\n"),
    );
  });

  test("ensureLensesDefaults appends the block once (idempotent)", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-lens-"));
    const toml = join(temp, "setup_config.toml");
    writeFileSync(toml, '[project]\nname = "x"\n');
    ensureLensesDefaults(toml);
    const after = readFileSync(toml, "utf8");
    expect(after).toContain("[lenses.defaults]");
    expect(after).toContain('wanderer = "wanderer.dialogue:sdd"');
    ensureLensesDefaults(toml); // second call is a no-op
    expect(readFileSync(toml, "utf8")).toBe(after);
  });
});
