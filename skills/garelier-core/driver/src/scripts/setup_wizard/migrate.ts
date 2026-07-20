import { renameSync, rmSync } from "../../guard/path_guard.ts";
// W-083 ts-first: setup_wizard flat -> crew (layout v2) migration cluster.
//
// Faithful port of crew_migration_precondition / crew_move_flat_container /
// crew_rewrite_workspace_paths / crew_rewrite_setup_config_paths /
// migrate_flat_to_crew from setup_wizard.ts (lines 1574-1689). These are the
// functions the crew regression test exercises (fixtures 4: flat -> crew move,
// worktree repair, path rewrite, idempotency + the three read-only rejections).
// cwd-relative (runs after cd PROJECT_ROOT); git operations target GIT_ROOT.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { git, type RunResult } from "../_lib.ts";
import {
  crewSubdirFromPmRoot,
  slugifyTarget,
  wsContainer,
  wsExileContainer,
  wsPointerFile,
  wsPointerKey,
  wsRolePlural,
  wsSubdir,
  wsUseExile,
  wsWritePointer,
  type WizardPaths,
} from "./paths.ts";
import { writeNestedIgnores } from "./ignores.ts";
import { writeShowcaseGallery } from "./showcase.ts";
import { resolvePmIdInteractively } from "./pmid.ts";
import { readTomlValueFrom } from "./toml.ts";
import { writeRoleClaude, writeRoleSettings, type RoleCtx } from "./roles.ts";
import { commandExists, cygpathMixed, type GarelierDirs } from "./env.ts";
import { installGuardHookFile } from "../../guard/install_hook.ts";
import { installMirrorHookFile } from "../../dispatch/install_task_mirror_hook.ts";
import { installRuntimeRecoveryHookFile } from "../../dispatch/install_runtime_recovery_hook.ts";

const WIZARD_VERSION = "2.13.1";

export interface MigrateCtx {
  pmId: string;
  gitRoot: string; // GIT_ROOT
  dirs: GarelierDirs; // for garelier_write_nested_ignores templates
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}
function gitTarget(ctx: MigrateCtx, args: string[]): RunResult {
  return git(ctx.gitRoot, args);
}

// W-111: an existing installation can still carry shell-era hook commands in
// settings files. Refresh every framework-owned entry through its canonical
// installer and rewrite SessionStart to the Bun entrypoint. User hooks and all
// unrelated settings remain untouched.
export function migrateEntrypointHooks(
  projectRoot: string,
  pmRoot: string,
  dirs: GarelierDirs,
): void {
  const rootSettings = `${projectRoot}/.claude/settings.local.json`;
  const guard = `${dirs.driverDir}/src/guard/command_guard.ts`;
  const mirror = `${dirs.skillsDir}/garelier-core/hooks/task_mirror_hook.sh`;
  const recovery = `${dirs.skillsDir}/garelier-core/hooks/runtime_recovery_hook.ts`;
  installGuardHookFile(rootSettings, guard);
  installMirrorHookFile(rootSettings, mirror);
  installRuntimeRecoveryHookFile(rootSettings, recovery);

  const settingsFiles: string[] = [];
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`;
      const st = statSync(path);
      if (st.isDirectory()) visit(path);
      else if (name === "settings.local.json") settingsFiles.push(path);
    }
  };
  visit(pmRoot);
  for (const settings of settingsFiles) installGuardHookFile(settings, guard);

  const pmSettings = `${crewSubdirFromPmRoot(pmRoot, "_pm")}/.claude/settings.json`;
  if (existsSync(pmSettings)) {
    try {
      const value = JSON.parse(readFileSync(pmSettings, "utf8")) as unknown;
      const rewrite = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) rewrite(item);
          return;
        }
        if (!node || typeof node !== "object") return;
        for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
          if (key === "command" && typeof child === "string" && child.includes("session_digest")) {
            (node as Record<string, unknown>)[key] =
              `bun \"${dirs.driverDir}/src/scripts/session_digest.ts\" 2>/dev/null || true`;
          } else rewrite(child);
        }
      };
      rewrite(value);
      writeFileSync(pmSettings, `${JSON.stringify(value, null, 2)}\n`);
    } catch {
      err(`  ! skipped malformed ${pmSettings}; hook settings need manual repair`);
    }
  }

  const legacyTrackedGuard = `${projectRoot}/.claude/hooks/garelier_command_guard_shim.${"s"}h`;
  if (existsSync(legacyTrackedGuard)) {
    rmSync(legacyTrackedGuard);
    out(`  - removed retired tracked command_guard shell shim: ${legacyTrackedGuard}`);
  }
  out("  + framework hook commands migrated to Bun TypeScript entrypoints (W-111)");
}

// git worktree list --porcelain -> absolute worktree paths.
function worktreePaths(ctx: MigrateCtx): string[] {
  const r = gitTarget(ctx, ["worktree", "list", "--porcelain"]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

// Mirror the bash case globs `*"/$pm_root/_<role>/"*/checkout` and
// `*"/$pm_root/_artisan/checkout"`: a worktree ending in /checkout that contains
// the role container path (glob * spans any characters, including slashes).
function isRoleCheckout(wt: string, pmRoot: string): boolean {
  if (!wt.endsWith("/checkout")) return false;
  for (const role of ["_workers", "_scouts", "_smiths", "_librarians", "_observers", "_guardians", "_concierges"]) {
    if (wt.includes(`/${pmRoot}/${role}/`)) return true;
  }
  return wt.endsWith(`/${pmRoot}/_artisan/checkout`);
}

// crew_migration_precondition <pm-root>: 0 (ok) or throws-style false. Emits the
// bash's exact stderr and returns false on the first blocking signal (dispatch
// container, then merge-gate lock, then dirty role worktree).
export function crewMigrationPrecondition(ctx: MigrateCtx, pmRoot = `__garelier/${ctx.pmId}`): boolean {
  // dispatch containers: _dispatch<N>...
  if (existsSync(pmRoot)) {
    for (const entry of readdirSync(pmRoot)) {
      if (/^_dispatch[0-9]/.test(entry) && statSync(`${pmRoot}/${entry}`).isDirectory()) {
        err(`Error: cannot migrate layout while dispatch container exists: ${pmRoot}/${entry}`);
        return false;
      }
    }
  }
  // merge-gate lock: any file under runtime/merge_gate/locks/
  const lock = `${pmRoot}/runtime/merge_gate/locks`;
  if (existsSync(lock) && statSync(lock).isDirectory() && dirHasFile(lock)) {
    err(`Error: cannot migrate layout while a merge-gate lock exists under ${lock}/.`);
    return false;
  }
  // dirty registered role worktrees.
  for (const wt of worktreePaths(ctx)) {
    if (!isRoleCheckout(wt, pmRoot)) continue;
    const st = git(wt, ["status", "--porcelain"]);
    if (st.exitCode === 0 && st.stdout.length > 0) {
      err(`Error: cannot migrate layout while role worktree is dirty: ${wt}`);
      return false;
    }
  }
  return true;
}

function dirHasFile(dir: string): boolean {
  let found = false;
  const walk = (d: string): void => {
    if (found) return;
    for (const entry of readdirSync(d)) {
      const p = `${d}/${entry}`;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        found = true;
        return;
      }
      if (found) return;
    }
  };
  walk(dir);
  return found;
}

// crew_move_flat_container <flat-name> <crew-name>
export function crewMoveFlatContainer(ctx: MigrateCtx, pmRoot: string, flatName: string, crewName: string): void {
  const src = `${pmRoot}/${flatName}`;
  const dst = `${pmRoot}/_crew/${crewName}`;
  if (!existsSync(src)) return;
  mkdirSync(dirname(dst), { recursive: true });
  const tracked =
    gitTarget(ctx, ["ls-files", "--error-unmatch", src]).exitCode === 0 ||
    gitTarget(ctx, ["ls-files", src]).stdout.split("\n").some((l) => l !== "");
  if (tracked) {
    gitTarget(ctx, ["mv", src, dst]);
    out(`  + git mv ${src} -> ${dst}`);
  } else {
    renameSync(src, dst);
    out(`  + mv ${src} -> ${dst}`);
  }
}

// crew_rewrite_workspace_paths: rewrite the gitignored role-home pointer file.
export function crewRewriteWorkspacePaths(pmRoot: string, pmId: string): void {
  const pf = `${pmRoot}/runtime/workspace_paths`;
  if (!existsSync(pf)) return;
  const raw = readFileSync(pf, "utf8");
  const hadTrailingNL = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (hadTrailingNL) lines.pop();
  const roles = ["workers", "scouts", "smiths", "librarians", "observers", "guardians", "concierges"];
  const outLines: string[] = [];
  for (const line of lines) {
    if (line === "" || line.startsWith("#")) {
      outLines.push(line);
      continue;
    }
    const eq = line.indexOf("=");
    const key = eq === -1 ? line : line.slice(0, eq);
    let value = eq === -1 ? "" : line.slice(eq + 1);
    for (const old of roles) {
      value = value.split(`__garelier/${pmId}/_${old}/`).join(`__garelier/${pmId}/_crew/${old}/`);
    }
    value = value.split(`__garelier/${pmId}/_artisan`).join(`__garelier/${pmId}/_crew/artisan`);
    outLines.push(`${key}=${value}`);
  }
  writeFileSync(pf, `${outLines.join("\n")}\n`);
  out(`  + ${pf} rewritten for crew containers`);
}

// crew_rewrite_setup_config_paths: rewrite worktree = paths in setup_config.toml.
export function crewRewriteSetupConfigPaths(pmRoot: string, pmId: string): void {
  const toml = `${crewSubdirFromPmRoot(pmRoot, "_pm")}/setup_config.toml`;
  if (!existsSync(toml)) return;
  let body = readFileSync(toml, "utf8");
  for (const old of ["workers", "scouts", "smiths", "librarians", "observers", "guardians", "concierges"]) {
    body = body.split(`__garelier/${pmId}/_${old}/`).join(`__garelier/${pmId}/_crew/${old}/`);
  }
  body = body.split(`__garelier/${pmId}/_artisan`).join(`__garelier/${pmId}/_crew/artisan`);
  writeFileSync(toml, body);
  out(`  + ${toml} worktree paths rewritten for crew containers`);
}

// Recursively collect directories named "checkout" under root.
function findCheckoutDirs(root: string): string[] {
  const acc: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = `${d}/${entry}`;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === "checkout") acc.push(p);
        walk(p);
      }
    }
  };
  walk(root);
  return acc;
}

// migrate_flat_to_crew: the whole flat -> _crew move + repair + rewrite + verify.
// Returns false on precondition/verification failure (caller aborts non-zero).
export function migrateFlatToCrew(ctx: MigrateCtx): boolean {
  const pmRoot = `__garelier/${ctx.pmId}`;
  if (existsSync(`${pmRoot}/_crew`) && statSync(`${pmRoot}/_crew`).isDirectory()) {
    out(`  = already crew layout: ${pmRoot}/_crew`);
    return true;
  }
  if (!(existsSync(`${pmRoot}/_pm`) && statSync(`${pmRoot}/_pm`).isDirectory())) return true;
  if (!crewMigrationPrecondition(ctx, pmRoot)) return false;

  out("==> Migrating role containers to layout v2 (_crew/)...");
  mkdirSync(`${pmRoot}/_crew`, { recursive: true });
  const moves: Array<[string, string]> = [
    ["_pm", "pm"],
    ["_dock", "dock"],
    ["_workers", "workers"],
    ["_scouts", "scouts"],
    ["_smiths", "smiths"],
    ["_artisan", "artisan"],
    ["_librarians", "librarians"],
    ["_observers", "observers"],
    ["_guardians", "guardians"],
    ["_concierges", "concierges"],
  ];
  for (const [flat, crew] of moves) crewMoveFlatContainer(ctx, pmRoot, flat, crew);

  const repairs = findCheckoutDirs(`${pmRoot}/_crew`);
  // bash: `git_target worktree repair ...` — no redirect; git's own
  // "repair: gitdir incorrect: ..." diagnostics flow to the terminal.
  const repairOpts = { stdout: "inherit" as const, stderr: "inherit" as const };
  if (repairs.length > 0) git(ctx.gitRoot, ["worktree", "repair", ...repairs], repairOpts);
  else git(ctx.gitRoot, ["worktree", "repair"], repairOpts);
  out(`  + git worktree repair completed from ${ctx.gitRoot}`);

  crewRewriteWorkspacePaths(pmRoot, ctx.pmId);
  crewRewriteSetupConfigPaths(pmRoot, ctx.pmId);
  writeNestedIgnores(ctx.dirs);

  if (!existsSync(`${crewSubdirFromPmRoot(pmRoot, "_pm")}/setup_config.toml`)) {
    err("Error: crew-layout verification failed: PM config is missing.");
    return false;
  }
  for (const old of [
    "_pm", "_dock", "_workers", "_scouts", "_smiths",
    "_artisan", "_librarians", "_observers", "_guardians", "_concierges",
  ]) {
    if (existsSync(`${pmRoot}/${old}`)) {
      err(`Error: crew-layout verification failed: flat container remains: ${pmRoot}/${old}`);
      return false;
    }
  }
  out("  + crew-layout verification passed");
  return true;
}

// ---- migrate mode-body path (a) tail helpers (2093-2141) ----

// rewrite_setup_config_version: bump garelier_version / wizard_version to current.
export function rewriteSetupConfigVersion(toml: string): void {
  if (!existsSync(toml)) return;
  const lines = readFileSync(toml, "utf8").split("\n").map((line) => {
    if (/^garelier_version = "[0-9][0-9.]*"/.test(line)) return `garelier_version = "${WIZARD_VERSION}"`;
    if (/^wizard_version = "[0-9][0-9.]*"/.test(line)) return `wizard_version = "${WIZARD_VERSION}"`;
    return line;
  });
  writeFileSync(toml, lines.join("\n"));
}

const LENS_DEFAULTS_BLOCK =
  `
# === Lens defaults (focus only; never authority) ===
[lenses.defaults]
pm = "pm.planning:delivery_balanced"
dock = "dock.dispatch:balanced"
worker = "worker.implementation:reuse_first"
scout = "scout.investigation:source_first"
smith = "smith.integration:adversarial_personas"
librarian = "librarian.source:strict"
guardian = "guardian.risk_control:strict"
observer = "observer.review:over_engineering"
concierge = "concierge.external_ops:explicit_only"
artisan = "artisan.creation:reuse_first"
wanderer = "wanderer.dialogue:sdd"
`;

// ensure_lenses_defaults: append the [lenses.defaults] block if absent.
export function ensureLensesDefaults(toml: string): void {
  if (!existsSync(toml)) return;
  const body = readFileSync(toml, "utf8");
  if (body.split("\n").some((l) => /^\[lenses\.defaults\]/.test(l))) return;
  writeFileSync(toml, body + LENS_DEFAULTS_BLOCK);
}

// seed_lens_atmos_templates: copy lens registry + packs into __garelier/__atmos/lenses
// (no-overwrite, silent — unlike the fresh scaffold variant which echoes).
// W-188 (g): the registry now lives under __atmos/lenses/ alongside the packs. An
// existing project with the legacy __atmos/lens_registry.toml is MIGRATED in place:
// the file is moved under lenses/ and its `lenses/x.toml` pack paths are rewritten
// to siblings (`x.toml`). If a legacy file is present, no fresh seed is done — the
// project's own (possibly PM-edited) registry is preserved, only relocated.
export function seedLensAtmosTemplates(coreTemplatesDir: string): void {
  const atmosLenses = "__garelier/__atmos/lenses";
  const legacyRegistry = "__garelier/__atmos/lens_registry.toml";
  const newRegistry = `${atmosLenses}/lens_registry.toml`;

  if (existsSync(legacyRegistry) && !existsSync(newRegistry)) {
    // Relocate the project's own registry, rewriting `path = "lenses/x"` → `path = "x"`.
    const body = readFileSync(legacyRegistry, "utf8").replace(/^(\s*path\s*=\s*")lenses\//gm, "$1");
    mkdirSync(atmosLenses, { recursive: true });
    writeFileSync(newRegistry, body);
    rmSync(legacyRegistry, { force: true });
  }

  const lensesDir = `${coreTemplatesDir}/lenses`;
  if (existsSync(lensesDir) && statSync(lensesDir).isDirectory()) {
    mkdirSync(atmosLenses, { recursive: true });
    for (const entry of readdirSync(lensesDir).sort()) {
      if (!entry.endsWith(".toml")) continue;
      const src = `${lensesDir}/${entry}`;
      if (!statSync(src).isFile()) continue;
      if (!existsSync(`${atmosLenses}/${entry}`)) cpSync(src, `${atmosLenses}/${entry}`);
    }
  }
}

// ===================================================================
// DEC-020/035/036 role-worktree relocation cluster (sh 1896-2091).
// ===================================================================

interface MigCounters {
  done: number;
  skip: number;
  fail: number;
}

// [workspace] home_root read fresh (bash ws_use_exile reads it inline). "" when
// the config is absent (matches the bash gate on ws_subdir _pm/setup_config.toml).
export function readHomeRootFromConfig(pmId: string): string {
  const cfg = `${wsSubdir(pmId, "_pm")}/setup_config.toml`;
  if (!existsSync(cfg)) return "";
  return readTomlValueFrom(cfg, "workspace", "home_root");
}

function gt(rc: RoleCtx, args: string[]): RunResult {
  return git(rc.paths.gitRoot, args);
}

// `mv src dst 2>/dev/null || true`, tolerating a cross-fs rename via copy+remove.
function mvTolerant(src: string, dst: string): void {
  if (!existsSync(src)) return;
  try {
    renameSync(src, dst);
  } catch {
    try {
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } catch {
      // best-effort, matches the bash `|| true`
    }
  }
}

function realOrEmpty(p: string): string {
  try {
    return realpathSync(p).replace(/\\/g, "/");
  } catch {
    return "";
  }
}

// Extract provider/model from a role CLAUDE.md identity line (head -n1).
function provModelFromClaude(container: string): { prov: string; model: string } {
  let prov = "claude-code";
  let model = "claude-code";
  const cm = `${container}/CLAUDE.md`;
  if (existsSync(cm)) {
    let line = "";
    try {
      line = readFileSync(cm, "utf8").split("\n")[0] ?? "";
    } catch {
      line = "";
    }
    const p = line.match(/provider: ([^,]*),/);
    const m = line.match(/model: ([^)]*)\)/);
    if (p && p[1]) prov = p[1];
    if (m && m[1]) model = m[1];
  }
  return { prov, model };
}

const COORD_FILES = [
  "STATE.md", "assignment.md", "report.md", "review.md", "questions.md", "answers.md",
  "under_review.md", "merged.md", "abort.md", "track-target.md", "committed.md", "acked.md",
  "guardian_report.md", "concierge_report.md", "archive", "checkpoints",
];

// migrate_role_to_checkout <role> <id> <legacy>: in-project -> exile home.
function migrateRoleToCheckout(rc: RoleCtx, c: MigCounters, role: string, id: string, legacy: string): void {
  const exile = wsExileContainer(rc.paths, role, id, rc.homeRootFromConfig);
  if (existsSync(`${exile}/checkout`)) {
    wsWritePointer(rc.paths.pmId, role, id, exile);
    if (existsSync(legacy) && legacy !== exile) {
      try {
        rmSync(legacy, { recursive: true, force: true });
      } catch {
        /* || true */
      }
    }
    return;
  }
  if (!existsSync(legacy)) return;

  let wt = "";
  if (existsSync(`${legacy}/checkout/.git`)) wt = `${legacy}/checkout`;
  else if (existsSync(`${legacy}/.git`)) wt = legacy;

  if (wt !== "") {
    const st = git(wt, ["status", "--porcelain", "--untracked-files=no"]);
    if (st.exitCode === 0 && st.stdout.length > 0) {
      err(`  ! ${legacy} has uncommitted tracked changes — commit them, then re-run migrate`);
      c.skip++;
      return;
    }
  }

  const { prov, model } = provModelFromClaude(legacy);
  mkdirSync(exile, { recursive: true });
  if (wt !== "") {
    if (gt(rc, ["worktree", "move", wt, `${exile}/checkout`]).exitCode !== 0) {
      const sha = git(wt, ["rev-parse", "HEAD"]).stdout.trim();
      gt(rc, ["worktree", "remove", "--force", wt]);
      if (gt(rc, ["worktree", "add", "--detach", `${exile}/checkout`, sha || rc.studioBranch]).exitCode !== 0) {
        err(`  ! could not relocate worktree for ${legacy} to ${exile}`);
        c.fail++;
        return;
      }
    }
  }
  for (const f of ["CLAUDE.md", ...COORD_FILES]) mvTolerant(`${legacy}/${f}`, `${exile}/${f}`);
  for (const f of COORD_FILES) {
    if (existsSync(`${exile}/checkout/${f}`) && !existsSync(`${exile}/${f}`)) {
      mvTolerant(`${exile}/checkout/${f}`, `${exile}/${f}`);
    }
  }
  wsWritePointer(rc.paths.pmId, role, id, exile);
  writeRoleClaude(rc, role, id, prov, model);
  try {
    rmSync(legacy, { recursive: true, force: true });
  } catch {
    /* || true */
  }
  gt(rc, ["worktree", "prune"]);
  out(`  + ${legacy} -> ${exile}`);
  c.done++;
}

// run_dec020_nesting: nest every worktree role under PM_ROOT into exile home.
function runDec020Nesting(rc: RoleCtx, c: MigCounters): boolean {
  const pmRoot = `__garelier/${rc.paths.pmId}`;
  out("");
  out("==> DEC-035: relocating role worktrees to the machine-local studio home ...");
  for (const base of ["_workers", "_scouts", "_smiths", "_librarians", "_observers", "_guardians", "_concierges"]) {
    const role = base.slice(1);
    const roleBase = crewSubdirFromPmRoot(pmRoot, base);
    if (!existsSync(roleBase)) continue;
    for (const entry of readdirSync(roleBase)) {
      const d = `${roleBase}/${entry}`;
      if (!statSync(d).isDirectory()) continue;
      migrateRoleToCheckout(rc, c, role, entry, `${roleBase}/${entry}`);
    }
  }
  const artisanBase = crewSubdirFromPmRoot(pmRoot, "_artisan");
  if (existsSync(artisanBase)) migrateRoleToCheckout(rc, c, "artisan", "", artisanBase);
  out(`  DEC-035 relocate: ${c.done} relocated, ${c.skip} skipped (uncommitted), ${c.fail} failed`);
  return c.fail === 0;
}

// migrate_role_to_inproject <role> <id> <exile>: exile home -> in-project.
function migrateRoleToInproject(rc: RoleCtx, c: MigCounters, role: string, id: string, exile: string): void {
  const inproj = wsContainer(rc.paths, role, id, rc.homeRootFromConfig);
  const pf = wsPointerFile(rc.paths.pmId);
  const key = wsPointerKey(rc.paths.pmId, role, id);

  const dropPointer = (): void => {
    if (!existsSync(pf)) return;
    try {
      const kept = readFileSync(pf, "utf8").split("\n").filter((l) => !l.startsWith(`${key}=`));
      writeFileSync(pf, kept.join("\n"));
    } catch {
      /* || true */
    }
  };

  if (existsSync(`${inproj}/checkout/.git`)) {
    const inprojReal = realOrEmpty(inproj);
    const exileReal = realOrEmpty(exile);
    const sameContainer = inprojReal !== "" && inprojReal === exileReal;
    dropPointer();
    if (existsSync(exile) && !sameContainer) {
      try {
        rmSync(exile, { recursive: true, force: true });
      } catch {
        /* || true */
      }
    }
    return;
  }
  if (!existsSync(`${exile}/checkout/.git`)) return;

  const st = git(`${exile}/checkout`, ["status", "--porcelain", "--untracked-files=no"]);
  if (st.exitCode === 0 && st.stdout.length > 0) {
    err(`  ! ${exile} has uncommitted tracked changes — commit them, then re-run migrate`);
    c.skip++;
    return;
  }

  const { prov, model } = provModelFromClaude(exile);
  mkdirSync(inproj, { recursive: true });
  if (gt(rc, ["worktree", "move", `${exile}/checkout`, `${inproj}/checkout`]).exitCode !== 0) {
    const sha = git(`${exile}/checkout`, ["rev-parse", "HEAD"]).stdout.trim();
    gt(rc, ["worktree", "remove", "--force", `${exile}/checkout`]);
    if (gt(rc, ["worktree", "add", "--detach", `${inproj}/checkout`, sha || rc.studioBranch]).exitCode !== 0) {
      err(`  ! could not relocate worktree ${exile} -> ${inproj}`);
      c.fail++;
      return;
    }
  }
  for (const f of COORD_FILES) mvTolerant(`${exile}/${f}`, `${inproj}/${f}`);
  dropPointer();
  writeRoleSettings(rc, `${inproj}/checkout`);
  writeRoleClaude(rc, role, id, prov, model);
  try {
    rmSync(exile, { recursive: true, force: true });
  } catch {
    /* || true */
  }
  gt(rc, ["worktree", "prune"]);
  c.done++;
  out(`  + ${exile} -> ${inproj}`);
}

// run_relocate_to_inproject: bring every EXILED role back into the project.
function runRelocateToInproject(rc: RoleCtx, c: MigCounters): boolean {
  out("");
  out("==> DEC-036: relocating role worktrees back into the project ...");
  const pf = wsPointerFile(rc.paths.pmId);
  if (!existsSync(pf)) {
    out("  no workspace_paths pointer — already in-project");
    return true;
  }
  // Snapshot entries (the pointer is rewritten as they are dropped).
  let raw = "";
  try {
    raw = readFileSync(pf, "utf8");
  } catch {
    raw = "";
  }
  const entries = raw.split("\n").filter((l) => !/^\s*#/.test(l) && !/^\s*$/.test(l));
  for (const line of entries) {
    const eq = line.indexOf("=");
    const key = eq === -1 ? line : line.slice(0, eq);
    const val = eq === -1 ? "" : line.slice(eq + 1);
    let role: string;
    let id: string;
    if (key === "artisan") {
      role = "artisan";
      id = "";
    } else {
      const dot = key.indexOf(".");
      const rsing = dot === -1 ? key : key.slice(0, dot);
      id = dot === -1 ? "" : key.slice(dot + 1);
      role = wsRolePlural(rsing);
    }
    migrateRoleToInproject(rc, c, role, id, val);
  }
  // Remove the pointer file if only the comment header remains.
  if (existsSync(pf)) {
    let after = "";
    try {
      after = readFileSync(pf, "utf8");
    } catch {
      after = "";
    }
    const remaining = after.split("\n").filter((l) => !/^\s*#/.test(l) && !/^\s*$/.test(l));
    if (remaining.length === 0) {
      try {
        rmSync(pf, { force: true });
      } catch {
        /* || true */
      }
    }
  }
  out(`  DEC-036 relocate: ${c.done} relocated, ${c.skip} skipped (uncommitted), ${c.fail} failed`);
  return c.fail === 0;
}

// run_relocate: exile is opt-in; default relocates BACK in-project.
function runRelocate(rc: RoleCtx, c: MigCounters): boolean {
  if (wsUseExile(rc.paths, rc.homeRootFromConfig)) return runDec020Nesting(rc, c);
  return runRelocateToInproject(rc, c);
}

// integrate_target_into_studio: fast-forward / merge <target> into studio.
// Returns 0 on success, 3 on conflict (aborted). Shared with DIFF (exported).
export function integrateTargetIntoStudio(gitRoot: string, target: string, studioBranch: string): number {
  const g = (args: string[]): RunResult => git(gitRoot, args);
  g(["checkout", studioBranch]);
  if (g(["merge-base", "--is-ancestor", target, "HEAD"]).exitCode === 0) return 0;
  if (g(["merge", "--no-edit", target]).exitCode === 0) {
    out(`  + integrated ${target} into ${studioBranch}`);
    return 0;
  }
  g(["merge", "--abort"]);
  err(`  ! merge of ${target} into ${studioBranch} had conflicts`);
  err("  ! PM must resolve manually (see DEC-001 §2.5) then re-run.");
  return 3;
}

// ===================================================================
// MIGRATE mode body (sh 3487-3894).
// ===================================================================

export interface MigrateParams {
  projectRoot: string; // PROJECT_ROOT (== cwd; entry chdir'd here)
  gitRoot: string; // GIT_ROOT (== projectRoot for migrate; --target-root rejected)
  now: string;
  dirs: GarelierDirs;
  coreTemplatesDir: string;
  pmId: string; // may be "" -> resolved interactively
  skipConfirm: boolean;
  wsExile: boolean; // WS_EXILE / --exile
  garelierHome: string; // GARELIER_HOME
}

function confirmProceed(skipConfirm: boolean, prompt = "Proceed? [y/N] "): boolean {
  if (skipConfirm) return true;
  process.stdout.write(prompt);
  const r = readLineSyncMigrate();
  return /^(y|Y|yes|YES)$/.test(r);
}
function readLineSyncMigrate(): string {
  const fs = require("node:fs") as typeof import("node:fs");
  const buf = Buffer.alloc(1);
  const bytes: number[] = [];
  for (;;) {
    let n = 0;
    try {
      n = fs.readSync(0, buf, 0, 1, null);
    } catch {
      break;
    }
    if (n === 0) break;
    if (buf[0] === 0x0a) break;
    bytes.push(buf[0]);
  }
  return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
}

export function runMigrate(p: MigrateParams): number {
  if (git(p.gitRoot, ["rev-parse", "--is-inside-work-tree"]).exitCode !== 0) {
    err(`Error: ${p.projectRoot} is not inside a git repository.`);
    return 1;
  }

  const buildRc = (pmId: string, studioBranch: string): RoleCtx => ({
    paths: {
      pmId,
      projectRoot: p.projectRoot,
      gitRoot: p.gitRoot,
      wsExile: p.wsExile,
      garelierHome: p.garelierHome,
    },
    studioBranch,
    now: p.now,
    dirs: p.dirs,
    coreTemplatesDir: p.coreTemplatesDir,
    homeRootFromConfig: readHomeRootFromConfig(pmId),
  });

  // --- Path (a): per-PM (v2.1) layout, possibly not yet _crew/DEC-035 nested. ---
  if (!existsSync("__garelier/_pm/setup_config.toml")) {
    const pmId = resolvePmIdInteractively(p.pmId, p.skipConfirm);
    const pmRoot = `__garelier/${pmId}`;
    let pmDir = crewSubdirFromPmRoot(pmRoot, "_pm");
    if (!existsSync(`${pmDir}/setup_config.toml`)) {
      err("Error: no Garelier install found to migrate.");
      err("       Expected a flat v2.0 layout (__garelier/_pm/setup_config.toml)");
      err(`       or a per-PM layout (${pmDir}/setup_config.toml).`);
      return 1;
    }
    const mctx: MigrateCtx = { pmId, gitRoot: p.gitRoot, dirs: p.dirs };
    if (!existsSync(`${pmRoot}/_crew`)) {
      if (!crewMigrationPrecondition(mctx, pmRoot)) return 1;
    }
    const wsExileNow = wsUseExile(
      { pmId, projectRoot: p.projectRoot, gitRoot: p.gitRoot, wsExile: p.wsExile, garelierHome: p.garelierHome },
      readHomeRootFromConfig(pmId),
    );
    if (wsExileNow) {
      out("Garelier migration: relocating role worktrees to the machine-local studio home (exile, opt-in)");
    } else {
      out("Garelier migration: relocating role worktrees back into the project (DEC-036, default)");
    }
    out(`  Project root:  ${p.projectRoot}`);
    out(`  PM identifier: ${pmId}`);
    out("");
    out("  Each role worktree is moved between its in-project container");
    out(`  (__garelier/${pmId}/_<role>/<id>/checkout) and its machine-local exile`);
    out("  home; coordination files (STATE.md, assignment.md, …) ride along. Roles");
    out("  with uncommitted tracked changes are skipped — commit them, then re-run.");
    if (!confirmProceed(p.skipConfirm)) {
      out("Aborted.");
      return 0;
    }
    if (!migrateFlatToCrew(mctx)) return 1;
    pmDir = crewSubdirFromPmRoot(pmRoot, "_pm");
    const rc = buildRc(pmId, "");
    const counters: MigCounters = { done: 0, skip: 0, fail: 0 };
    const relocRc = runRelocate(rc, counters) ? 0 : 1;
    rewriteSetupConfigVersion(`${pmDir}/setup_config.toml`);
    ensureLensesDefaults(`${pmDir}/setup_config.toml`);
    seedLensAtmosTemplates(p.coreTemplatesDir);
    migrateEntrypointHooks(p.projectRoot, `${p.projectRoot}/${pmRoot}`, p.dirs);
    out("");
    out(`Relocation and setup_config.toml version update done for pm_id=${pmId}. Review with: git status`);
    return relocRc;
  }

  // --- Path (b): flat v2.0 (__garelier/_pm/...) -> per-PM (v2.1). ---
  const oldTarget = readTomlValueFrom("__garelier/_pm/setup_config.toml", "branches", "target");
  const oldTargetSlug = readTomlValueFrom("__garelier/_pm/setup_config.toml", "branches", "target_slug");
  const oldStudio = readTomlValueFrom("__garelier/_pm/setup_config.toml", "branches", "integration");
  if (oldTarget === "" || oldTargetSlug === "" || oldStudio === "") {
    err("Error: could not read [branches] from __garelier/_pm/setup_config.toml.");
    return 1;
  }

  const pmId = resolvePmIdInteractively(p.pmId, p.skipConfirm);
  const pmRoot = `__garelier/${pmId}`;
  if (existsSync(pmRoot)) {
    err(`Error: ${pmRoot}/ already exists; pick a different --pm-id.`);
    return 1;
  }
  const newStudio = `garelier/${oldTargetSlug}/${pmId}/studio`;
  if (git(p.gitRoot, ["rev-parse", "--verify", newStudio]).exitCode === 0) {
    err(`Error: target branch ${newStudio} already exists; pick a different --pm-id.`);
    return 1;
  }

  out("Garelier migration plan (v2.0 → v2.1)");
  out("======================================");
  out(`  Project root:        ${p.projectRoot}`);
  out(`  PM identifier:       ${pmId}`);
  out(`  Old studio branch:   ${oldStudio}`);
  out(`  New studio branch:   ${newStudio}`);
  out("");
  out("  Filesystem moves (git-tracked via git mv):");
  out(`    __garelier/_pm        -> ${pmRoot}/_pm`);
  out(`    __garelier/_dock -> ${pmRoot}/_dock`);
  out(`    __garelier/control    -> ${pmRoot}/control`);
  out("");
  out("  Worktree moves (git worktree move):");
  const listDirs = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter((e) => statSync(`${dir}/${e}`).isDirectory()) : [];
  for (const wid of listDirs("__garelier/_workers")) out(`    __garelier/_workers/${wid} -> ${pmRoot}/_workers/${wid}`);
  for (const sid of listDirs("__garelier/_scouts")) out(`    __garelier/_scouts/${sid} -> ${pmRoot}/_scouts/${sid}`);
  for (const smid of listDirs("__garelier/_smiths")) out(`    __garelier/_smiths/${smid} -> ${pmRoot}/_smiths/${smid}`);
  if (existsSync("__garelier/runtime")) {
    out("  Plain mv (gitignored):");
    out(`    __garelier/runtime -> ${pmRoot}/runtime`);
  }
  out("");
  out("  Branch renames (git branch -m):");
  out(`    ${oldStudio} -> ${newStudio}`);
  const workbenchRefs = (): string[] => {
    const r = git(p.gitRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/garelier/${oldTargetSlug}/workbench/*`,
    ]);
    return r.exitCode === 0 ? r.stdout.split("\n").filter((l) => l !== "") : [];
  };
  for (const br of workbenchRefs()) {
    const suffix = br.slice(`garelier/${oldTargetSlug}/workbench/`.length);
    out(`    ${br} -> garelier/${oldTargetSlug}/${pmId}/workbench/${suffix}`);
  }
  out("");
  if (!confirmProceed(p.skipConfirm)) {
    out("Aborted.");
    return 0;
  }

  mkdirSync(pmRoot, { recursive: true });
  out("");
  out("==> Moving tracked directories via git mv...");
  for (const d of ["_pm", "_dock", "control"]) {
    if (existsSync(`__garelier/${d}`)) {
      git(p.gitRoot, ["mv", `__garelier/${d}`, `${pmRoot}/${d}`]);
      out(`  + git mv __garelier/${d} -> ${pmRoot}/${d}`);
    }
  }

  out("");
  out("==> Moving worktrees via git worktree move...");
  const rmdirQuiet = (d: string): void => {
    try {
      rmSync(d, { recursive: false });
    } catch {
      /* rmdir ... || true (only removes if empty) */
    }
  };
  if (existsSync("__garelier/_workers")) {
    mkdirSync(`${pmRoot}/_workers`, { recursive: true });
    for (const wid of listDirs("__garelier/_workers")) {
      git(p.gitRoot, ["worktree", "move", `__garelier/_workers/${wid}`, `${pmRoot}/_workers/${wid}`]);
      out(`  + worker ${wid} -> ${pmRoot}/_workers/${wid}`);
    }
    rmdirQuiet("__garelier/_workers");
  }
  if (existsSync("__garelier/_scouts")) {
    mkdirSync(`${pmRoot}/_scouts`, { recursive: true });
    for (const sid of listDirs("__garelier/_scouts")) {
      git(p.gitRoot, ["worktree", "move", `__garelier/_scouts/${sid}`, `${pmRoot}/_scouts/${sid}`]);
      out(`  + scout ${sid} -> ${pmRoot}/_scouts/${sid}`);
    }
    rmdirQuiet("__garelier/_scouts");
  }
  if (existsSync("__garelier/_smiths")) {
    mkdirSync(`${pmRoot}/_smiths`, { recursive: true });
    for (const smid of listDirs("__garelier/_smiths")) {
      git(p.gitRoot, ["worktree", "move", `__garelier/_smiths/${smid}`, `${pmRoot}/_smiths/${smid}`]);
      out(`  + smith ${smid} -> ${pmRoot}/_smiths/${smid}`);
    }
    rmdirQuiet("__garelier/_smiths");
  }

  out("");
  out("==> Moving runtime/ (gitignored)...");
  if (existsSync("__garelier/runtime")) {
    renameSync("__garelier/runtime", `${pmRoot}/runtime`);
    out(`  + mv __garelier/runtime -> ${pmRoot}/runtime`);
  }

  out("");
  out("==> Renaming branches...");
  if (git(p.gitRoot, ["rev-parse", "--verify", oldStudio]).exitCode === 0) {
    git(p.gitRoot, ["branch", "-m", oldStudio, newStudio]);
    out(`  + ${oldStudio} -> ${newStudio}`);
  }
  for (const br of workbenchRefs()) {
    const suffix = br.slice(`garelier/${oldTargetSlug}/workbench/`.length);
    const newBr = `garelier/${oldTargetSlug}/${pmId}/workbench/${suffix}`;
    git(p.gitRoot, ["branch", "-m", br, newBr]);
    out(`  + ${br} -> ${newBr}`);
  }

  out("");
  let pmDir = crewSubdirFromPmRoot(pmRoot, "_pm");
  out(`==> Patching ${pmDir}/setup_config.toml...`);
  const toml = `${pmDir}/setup_config.toml`;
  patchMigrateToml(toml, pmId, pmRoot, oldStudio, newStudio);
  rewriteSetupConfigVersion(toml);
  ensureLensesDefaults(toml);
  seedLensAtmosTemplates(p.coreTemplatesDir);
  out(`  + ${toml} updated (pm_id, integration, worktree paths, version)`);
  appendMigratePostV20Blocks(toml, pmRoot);

  out("");
  out("==> Migrating ignores to nested __garelier/ form (DEC-051; root untouched)...");
  writeNestedIgnores(p.dirs);

  writeShowcaseGallery(pmRoot);
  out(`  + ${pmRoot}/showcase/ (gitignored) + ${pmRoot}/gallery/ (tracked, LFS) ensured`);

  const mctx: MigrateCtx = { pmId, gitRoot: p.gitRoot, dirs: p.dirs };
  if (!migrateFlatToCrew(mctx)) return 1;
  pmDir = crewSubdirFromPmRoot(pmRoot, "_pm");

  const rc = buildRc(pmId, newStudio);
  const counters: MigCounters = { done: 0, skip: 0, fail: 0 };
  runRelocate(rc, counters); // `|| true`
  migrateEntrypointHooks(p.projectRoot, `${p.projectRoot}/${pmRoot}`, p.dirs);

  out("");
  out("===================================");
  out("Garelier migration complete (v2.0 -> v2.1 + DEC-020).");
  out("===================================");
  out("");
  out("Worktrees:");
  const wl = git(p.gitRoot, ["worktree", "list"]);
  if (wl.exitCode === 0) {
    for (const l of wl.stdout.replace(/\n$/, "").split("\n")) out(`  ${l}`);
  }
  out("");
  out("Next steps:");
  out("  1. Review the changes:");
  out("       git status");
  out("       git diff --stat");
  out("  2. Commit the migration (local-only — do NOT push the studio branch):");
  out("       git add -A");
  out(`       git commit -m 'Garelier: migrate to v2.1 (per-PM namespace, pm_id=${pmId})'`);
  out("  3. Launch this PM from its new directory:");
  out(`       cd ${pmDir} && claude`);
  return 0;
}

// Insert [pm] after [project] (if absent), rewrite integration + worktree paths.
function patchMigrateToml(toml: string, pmId: string, pmRoot: string, oldStudio: string, newStudio: string): void {
  let body = readFileSync(toml, "utf8");
  const hadTrailingNL = body.endsWith("\n");
  let lines = body.split("\n");
  if (hadTrailingNL) lines.pop();

  if (!lines.some((l) => /^\[pm\]/.test(l))) {
    const outLines: string[] = [];
    let inProject = false;
    let inserted = false;
    for (const line of lines) {
      if (/^\[project\]/.test(line)) {
        outLines.push(line);
        inProject = true;
        continue;
      }
      if (/^\[/.test(line)) {
        if (inProject && !inserted) {
          outLines.push("[pm]");
          outLines.push(`pm_id = "${pmId}"`);
          outLines.push("");
          inserted = true;
        }
        inProject = false;
        outLines.push(line);
        continue;
      }
      outLines.push(line);
    }
    if (inProject && !inserted) {
      outLines.push("");
      outLines.push("[pm]");
      outLines.push(`pm_id = "${pmId}"`);
    }
    lines = outLines;
  }

  // sed: integration + worktree base rewrites (line-anchored on ^).
  lines = lines.map((line) => {
    if (line === `integration = "${oldStudio}"`) return `integration = "${newStudio}"`;
    let l = line;
    l = l.replace(/^worktree = "__garelier\/_workers\//, `worktree = "${pmRoot}/_workers/`);
    l = l.replace(/^worktree = "__garelier\/_scouts\//, `worktree = "${pmRoot}/_scouts/`);
    l = l.replace(/^worktree = "__garelier\/_smiths\//, `worktree = "${pmRoot}/_smiths/`);
    return l;
  });

  writeFileSync(toml, `${lines.join("\n")}\n`);
}

// Append post-v2.0 blocks (artisan/librarian/status_web/concurrency/lanes/
// output_control) to a migrated config that predates them.
function appendMigratePostV20Blocks(toml: string, pmRoot: string): void {
  const body = (): string => readFileSync(toml, "utf8");
  const append = (lines: string[]): void => writeFileSync(toml, `${body()}${lines.join("\n")}\n`);
  const has = (re: RegExp): boolean => body().split("\n").some((l) => re.test(l));

  if (!/\[artisan\]/.test(body())) {
    append([
      "",
      "# === Artisan (artisan lane) ===",
      "#",
      "# The Artisan performs the combined Dock + Worker + Scout + Smith +",
      "# Librarian scope by ITSELF on a `satchel` branch, then passes",
      "# Guardian + Observer and integrates into `studio` (DEC-045).",
      "# Mutually exclusive with the dock",
      "# lane (arbitrated by runtime/lane.lock). Disabled by default.",
      "[artisan]",
      "enabled = false",
      'id = "artisan-01"',
      'provider = "claude-code"',
      'model = "claude-code"',
      '# effort = "xhigh"',
      `worktree = "${pmRoot}/_artisan"`,
      'branch_namespace = "satchel"',
    ]);
    out("  + appended [artisan] block (DEC-017)");
  }
  if (!has(/^#?\s*\[\[librarians\]\]/)) {
    append([
      "",
      "# === Librarian definitions (dock lane) ===",
      "#",
      "# One [[librarians]] block per Librarian instance. Knowledge /",
      "# registry / runbook work on a `shelf` branch, merged through",
      "# Dock review. Dock-subordinate; never dispatched by PM.",
      "# [[librarians]]",
      '# id = "librarian-01"',
      '# provider = "claude-code"',
      '# model = "claude-code"',
      "# enabled = true",
      `# worktree = "${pmRoot}/_librarians/librarian-01"`,
      '# branch_namespace = "shelf"',
    ]);
    out("  + appended [[librarians]] example (DEC-018)");
  }
  if (!/\[status_web\]/.test(body())) {
    append([
      "",
      "# === Status Web Console (read-only) ===",
      "#",
      "# A local, read-only browser view of Garelier state. Zero AI",
      "# tokens — it only reads runtime files. Start with",
      "# `bun run status -- --pm-id <pm_id>` from the driver directory.",
      "# Binds to loopback only and never mutates state.",
      "[status_web]",
      "enabled = false",
      'host = "127.0.0.1"',
      "port = 3787",
      "auto_refresh_seconds = 5",
      "read_only = true",
      "show_source_urls = true",
    ]);
    out("  + appended [status_web] block");
  }
  if (!/\[concurrency\]/.test(body())) {
    append([
      "",
      "# === Concurrency cap (DEC-027) ===",
      "#",
      "# Under dispatch-only the HARD cap is [jig] fan_out_cap; the driver-era",
      "# per-poll counting is gone. These values remain DOCK GUIDANCE for what to",
      "# dispatch next under contention and for codex exec budgeting. PM, Dock,",
      "# and the merge-gate subprocess are NOT counted.",
      "[concurrency]",
      "max_concurrent_agents = 4",
      'tiers = [["concierge", "guardian", "observer"], ["smith", "librarian"], ["worker", "scout", "artisan"], []]',
      "starvation_cycles = 3",
    ]);
    out("  + appended [concurrency] block (DEC-027)");
  }
  if (!/\[lanes\]/.test(body())) {
    append([
      "",
      "# === Lane selection (DEC-056) ===",
      "#",
      '# Lane assumed when runtime/lane.lock is absent. "dock"',
      '# (default) = the parallel pipeline; "artisan" = the single-agent',
      "# Artisan lane. An explicit lane.lock still overrides this per task.",
      "[lanes]",
      'default = "dock"',
    ]);
    out("  + appended [lanes] block (DEC-056)");
  }
  if (!/\[output_control\]/.test(body())) {
    append([
      "",
      "# === Output control (DEC-028) ===",
      "#",
      "# Keeps provider FINAL responses short and driver logs from bloating, on top",
      "# of compact-handoff + retention. Over-budget responses are WARNED, not failed.",
      "[output_control]",
      "enabled = true",
      'default_profile = "compact"',
      'violation_mode = "warn"',
      "model_result_log_chars = 600",
      "error_tail_chars = 500",
      "driver_log_max_bytes = 10485760",
      "driver_log_keep_files = 10",
      "usage_summary = true",
      "",
      "[output_control.profiles.normal]",
      "soft_result_chars = 1600",
      "max_bullets = 8",
      "[output_control.profiles.compact]",
      "soft_result_chars = 900",
      "max_bullets = 5",
      "[output_control.profiles.micro]",
      "soft_result_chars = 500",
      "max_bullets = 3",
      "",
      "[output_control.roles]",
      'pm = "normal"',
      'dock = "compact"',
      'worker = "compact"',
      'smith = "compact"',
      'artisan = "compact"',
      'scout = "micro"',
      'observer = "micro"',
      'librarian = "compact"',
      'guardian = "normal"',
      'concierge = "normal"',
    ]);
    out("  + appended [output_control] block (DEC-028)");
  }
}
