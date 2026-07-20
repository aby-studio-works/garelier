import { rmSync } from "../../guard/path_guard.ts";
// W-083 ts-first: parity test for the flat -> crew migration cluster. Rebuilds
// the setup_wizard_crew.test.ts migrate fixture (a real git repo with a role
// worktree, tracked PM/Dock files, and a workspace_paths pointer) and drives the
// TS migrateFlatToCrew / crewMigrationPrecondition directly, asserting the same
// outcomes the bash crew test asserts (moves, repair, rewrite, verify,
// idempotency, and the three read-only rejections).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../_lib.ts";
import { resolveGarelierDirs } from "./env.ts";
import {
  crewMigrationPrecondition,
  ensureLensesDefaults,
  migrateFlatToCrew,
  migrateEntrypointHooks,
  rewriteSetupConfigVersion,
  seedLensAtmosTemplates,
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
  test("migrates installed hook commands and removes the retired tracked shim", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-hooks-"));
    const repo = join(temp, "project");
    const pmRoot = join(repo, "__garelier/pm1");
    const roleSettings = join(pmRoot, "_crew/workers/w1/checkout/.claude/settings.local.json");
    const pmSettings = join(pmRoot, "_crew/pm/.claude/settings.json");
    const rootSettings = join(repo, ".claude/settings.local.json");
    const legacyGuard = join(repo, `.claude/hooks/garelier_command_guard_shim.${"s"}h`);
    for (const file of [roleSettings, pmSettings, rootSettings, legacyGuard]) {
      mkdirSync(join(file, ".."), { recursive: true });
    }
    const oldExt = `.${"s"}h`;
    writeFileSync(rootSettings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: `bash command_guard${oldExt}` }] }] } }));
    writeFileSync(roleSettings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: `bash command_guard${oldExt}` }] }] } }));
    writeFileSync(pmSettings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: `bash session_digest${oldExt}` }] }] } }));
    writeFileSync(legacyGuard, "retired\n");

    migrateEntrypointHooks(repo, pmRoot, dirs);

    const root = readFileSync(rootSettings, "utf8");
    const role = readFileSync(roleSettings, "utf8");
    const pm = readFileSync(pmSettings, "utf8");
    expect(root).toContain("task_mirror_hook");
    expect(root).toContain("runtime_recovery_hook.ts");
    expect(root).toContain("command_guard.ts");
    expect(role).toContain("command_guard.ts");
    expect(pm).toContain("bun \\\"");
    expect(pm).toContain("session_digest.ts");
    expect(root.replace(/task_mirror_hook[^\"]*/g, "")).not.toContain(oldExt);
    expect(role).not.toContain(oldExt);
    expect(pm).not.toContain(oldExt);
    expect(existsSync(legacyGuard)).toBe(false);
  });

  test("rewriteSetupConfigVersion bumps garelier/wizard version lines only", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-ver-"));
    const toml = join(temp, "setup_config.toml");
    writeFileSync(
      toml,
      ['name = "x"', 'garelier_version = "2.9.0"', 'pm_id = "pm1"', 'wizard_version = "2.9.0"', ""].join("\n"),
    );
    rewriteSetupConfigVersion(toml);
    expect(readFileSync(toml, "utf8")).toBe(
      ['name = "x"', 'garelier_version = "2.13.1"', 'pm_id = "pm1"', 'wizard_version = "2.13.1"', ""].join("\n"),
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

  // W-188 (g): the lens registry moved from __atmos/lens_registry.toml to
  // __atmos/lenses/lens_registry.toml. Migrate relocates an existing project's own
  // registry and rewrites its `lenses/x` pack paths to siblings `x`.
  test("seedLensAtmosTemplates relocates a legacy lens registry and rewrites pack paths", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-lensmove-"));
    prevCwd = process.cwd();
    process.chdir(temp);
    const legacy = join(temp, "__garelier/__atmos/lens_registry.toml");
    mkdirSync(join(temp, "__garelier/__atmos"), { recursive: true });
    // A PM-edited registry: a custom status must survive the move verbatim.
    writeFileSync(
      legacy,
      ['schema_version = 1', 'kind = "garelier_lens_registry"', '', '[[packs]]', 'id = "worker.implementation"',
        'role = "worker"', 'path = "lenses/worker.implementation.toml"', 'status = "custom_edited"', ''].join("\n"),
    );

    // coreTemplatesDir points at the real templates so the pack files come along.
    seedLensAtmosTemplates(join(import.meta.dir, "../../../../templates"));

    const moved = join(temp, "__garelier/__atmos/lenses/lens_registry.toml");
    expect(existsSync(moved)).toBe(true);
    expect(existsSync(legacy)).toBe(false); // legacy file removed, no __atmos clutter
    const body = readFileSync(moved, "utf8");
    expect(body).toContain('path = "worker.implementation.toml"'); // lenses/ prefix stripped
    expect(body).not.toContain('path = "lenses/'); // no stale prefix
    expect(body).toContain('status = "custom_edited"'); // PM edit preserved, not re-seeded
  });

  test("seedLensAtmosTemplates fresh-seeds under __atmos/lenses when no legacy exists", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-lensfresh-"));
    prevCwd = process.cwd();
    process.chdir(temp);
    mkdirSync(join(temp, "__garelier/__atmos"), { recursive: true });

    seedLensAtmosTemplates(join(import.meta.dir, "../../../../templates"));

    expect(existsSync(join(temp, "__garelier/__atmos/lenses/lens_registry.toml"))).toBe(true);
    expect(existsSync(join(temp, "__garelier/__atmos/lens_registry.toml"))).toBe(false);
    expect(existsSync(join(temp, "__garelier/__atmos/lenses/pm.planning.toml"))).toBe(true);
  });
});
