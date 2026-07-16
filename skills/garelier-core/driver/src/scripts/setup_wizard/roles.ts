// W-083 ts-first: role-worktree writers shared by MIGRATE (relocate) and DIFF
// (add/remove agents).
//
// Faithful port of write_role_settings / is_agent_idle / role_meta /
// write_role_claude / write_role_files / create_agent_worktree /
// remove_agent_worktree from setup_wizard.sh (lines 1698-1894). FRESH mode does
// NOT use these (DEC-065 dispatch-native pre-creates no containers); the callers
// are the migrate relocate cluster and the diff mode body. cwd is PROJECT_ROOT;
// git operations target GIT_ROOT (git_target).

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { git, type RunResult } from "../_lib.ts";
import { commandExists, cygpathMixed, type GarelierDirs } from "./env.ts";
import {
  wsContainer,
  wsPointerFile,
  wsPointerKey,
  wsResolveContainer,
  wsUseExile,
  wsWritePointer,
  type WizardPaths,
} from "./paths.ts";

export interface RoleCtx {
  paths: WizardPaths; // pmId, projectRoot, gitRoot, wsExile, garelierHome
  studioBranch: string; // STUDIO_BRANCH
  now: string; // NOW
  dirs: GarelierDirs; // GARELIER_DRIVER_DIR / GARELIER_SKILLS_DIR
  coreTemplatesDir: string; // GARELIER_CORE_TEMPLATES_DIR
  // [workspace] home_root read from config (":in-project:" / "" / abs), read
  // fresh by the caller so a mid-migrate config move is reflected. The bash
  // ws_use_exile reads it inline via `read_toml_value workspace home_root`.
  homeRootFromConfig: string;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}
function gitTarget(ctx: RoleCtx, args: string[]): RunResult {
  return git(ctx.paths.gitRoot, args);
}
// ${role%s}: strip a single trailing 's' (workers -> worker; artisan unchanged).
function singular(role: string): string {
  return role.endsWith("s") ? role.slice(0, -1) : role;
}

// write_role_settings <checkout>: settings.local.json (claudeMdExcludes +
// command_guard PreToolUse hook), then keep the file out of the worktree's
// tracked/untracked view via info/exclude.
export function writeRoleSettings(ctx: RoleCtx, checkout: string): void {
  let absproj = ctx.paths.projectRoot;
  let guardpath = `${ctx.dirs.driverDir}/src/guard/command_guard.ts`;
  if (commandExists("cygpath")) {
    absproj = cygpathMixed(absproj);
    guardpath = cygpathMixed(guardpath);
  }
  mkdirSync(`${checkout}/.claude`, { recursive: true });
  const body = `{
  "claudeMdExcludes": [
    "${absproj}/CLAUDE.md",
    "${absproj}/.claude/CLAUDE.md",
    "${absproj}/.claude/rules/**"
  ],
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell|Shell",
        "hooks": [
          { "type": "command", "command": "bun \\"${guardpath}\\"" }
        ]
      }
    ]
  }
}
`;
  writeFileSync(`${checkout}/.claude/settings.local.json`, body);
  // Linked worktree: .git is a FILE -> resolve worktree info/exclude and append
  // the ignore line once. (A directory .git means a non-worktree checkout.)
  const dotgit = `${checkout}/.git`;
  if (existsSync(dotgit) && statSync(dotgit).isFile()) {
    const r = git(checkout, ["rev-parse", "--git-path", "info/exclude"]);
    if (r.exitCode === 0) {
      const gd = r.stdout.trim();
      if (gd !== "") {
        mkdirSync(dirname(gd), { recursive: true });
        let cur = "";
        try {
          cur = readFileSync(gd, "utf8");
        } catch {
          cur = "";
        }
        const has = cur.split("\n").some((l) => l === ".claude/settings.local.json");
        if (!has) {
          const sep = cur === "" || cur.endsWith("\n") ? "" : "\n";
          writeFileSync(gd, `${cur}${sep}.claude/settings.local.json\n`);
        }
      }
    }
  }
}

// is_agent_idle <role> <id>: STATE.md "## Status" line reads IDLE. Matches the
// bash return codes (0 = idle; 1 = not idle / half-broken container).
export function isAgentIdle(ctx: RoleCtx, role: string, id: string): boolean {
  const container = wsResolveContainer(ctx.paths.pmId, role, id);
  if (!existsSync(container)) return true; // never-created seat holds no work
  const stateFile = `${container}/STATE.md`;
  if (!existsSync(stateFile)) return false; // container without STATE.md: not idle
  let body = "";
  try {
    body = readFileSync(stateFile, "utf8");
  } catch {
    return false;
  }
  // grep -A1 '^## Status' | tail -n+2 | head -n1 | tr -d space | == "IDLE"
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^## Status/.test(lines[i])) {
      const next = lines[i + 1] ?? "";
      return next.replace(/\s/g, "") === "IDLE";
    }
  }
  return false;
}

export interface RoleMeta {
  skill: string;
  extra: string;
  dir: string;
}

// role_meta <role> <id>: skill name, scout-only extra CLAUDE line, container dir.
export function roleMeta(ctx: RoleCtx, role: string, id: string): RoleMeta {
  let skill = "";
  let extra = "";
  switch (role) {
    case "workers": skill = "garelier-worker"; break;
    case "scouts":
      skill = "garelier-scout";
      extra = `Inspections to:   ${ctx.paths.projectRoot}/__garelier/${ctx.paths.pmId}/control/inspections/`;
      break;
    case "smiths": skill = "garelier-smith"; break;
    case "librarians": skill = "garelier-librarian"; break;
    case "observers": skill = "garelier-observer"; break;
    case "guardians": skill = "garelier-guardian"; break;
    case "concierges": skill = "garelier-concierge"; break;
    case "artisan": skill = "garelier-artisan"; break;
  }
  const dir = wsResolveContainer(ctx.paths.pmId, role, id);
  return { skill, extra, dir };
}

// write_role_claude <role> <id> <provider> <model>: the role CLAUDE.md only
// (absolute-path addressing; DEC-020/035). Does NOT touch STATE.md.
export function writeRoleClaude(ctx: RoleCtx, role: string, id: string, provider: string, model: string): void {
  const meta = roleMeta(ctx, role, id);
  const lines: string[] = [
    `You are ${singular(role)} ${id} (provider: ${provider}, model: ${model}) in a Garelier project.`,
    `PM identifier:       ${ctx.paths.pmId}`,
    "Your working directory (cwd) is this git worktree — the target project tree.",
    "Garelier coordination files are in the PARENT dir (one ../ up).",
    `Primary checkout (where __garelier/ lives): ${ctx.paths.projectRoot}`,
    `Runtime directory:   ${ctx.paths.projectRoot}/__garelier/${ctx.paths.pmId}/runtime/`,
    `Control directory:   ${ctx.paths.projectRoot}/__garelier/${ctx.paths.pmId}/control/`,
    "Your assignment file: ../assignment.md",
    "Your state file: ../STATE.md",
  ];
  if (meta.extra !== "") lines.push(meta.extra);
  lines.push("");
  lines.push(`Follow the ${meta.skill} skill.`);
  writeFileSync(`${meta.dir}/CLAUDE.md`, `${lines.join("\n")}\n`);
}

// write_role_files <role> <id> <provider> <model>: CLAUDE.md + a fresh IDLE
// STATE.md. Used when CREATING a seat (diff add); migrate uses write_role_claude
// alone so it never resets STATE.md.
export function writeRoleFiles(ctx: RoleCtx, role: string, id: string, provider: string, model: string): void {
  const meta = roleMeta(ctx, role, id);
  writeRoleClaude(ctx, role, id, provider, model);
  const state = `# ${singular(role)} ${id} — State

## Status
IDLE

## Current branch
(detached HEAD at ${ctx.studioBranch})

## Current task
(none)

## Last activity
${ctx.now} — Initialized by setup wizard

## Recent log
- ${ctx.now} Initialized by setup wizard

## Next planned action
Wait for assignment.
`;
  writeFileSync(`${meta.dir}/STATE.md`, state);
}

// create_agent_worktree <role> <id> <provider> <model>.
export function createAgentWorktree(ctx: RoleCtx, role: string, id: string, provider: string, model: string): void {
  const path = wsContainer(ctx.paths, role, id, ctx.homeRootFromConfig);
  mkdirSync(path, { recursive: true });
  // bash: `git_target worktree add ... >/dev/null` — stdout dropped, git's
  // "Preparing worktree (detached HEAD ...)" stderr flows to the terminal.
  git(ctx.paths.gitRoot, ["worktree", "add", "--detach", `${path}/checkout`, ctx.studioBranch], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (wsUseExile(ctx.paths, ctx.homeRootFromConfig)) wsWritePointer(ctx.paths.pmId, role, id, path);
  writeRoleSettings(ctx, `${path}/checkout`);
  // DEC-030: a Concierge ships with the mechanical push guard installed.
  if (role === "concierges") {
    const ct = process.env.GARELIER_CORE_TEMPLATES_DIR ?? `${ctx.dirs.skillsDir}/garelier-core/templates`;
    const guard = `${ct.replace(/\/templates$/, "")}/scripts/install_concierge_guards.sh`;
    if (existsSync(guard)) {
      const r = Bun.spawnSync(["bash", guard, `${path}/checkout`], { stdout: "ignore", stderr: "ignore" });
      if (r.exitCode !== 0) {
        err(`  ! could not install Concierge push guard for ${id} (DEC-030); it installs at pickup`);
      }
    }
  }
  writeRoleFiles(ctx, role, id, provider, model);
}

// remove_agent_worktree <role> <id>.
export function removeAgentWorktree(ctx: RoleCtx, role: string, id: string): void {
  const path = wsResolveContainer(ctx.paths.pmId, role, id);
  gitTarget(ctx, ["worktree", "remove", "--force", `${path}/checkout`]);
  gitTarget(ctx, ["worktree", "remove", "--force", path]);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  // Drop the pointer entry and prune stale registrations.
  const pf = wsPointerFile(ctx.paths.pmId);
  const key = wsPointerKey(ctx.paths.pmId, role, id);
  if (existsSync(pf)) {
    try {
      const kept = readFileSync(pf, "utf8").split("\n").filter((l) => !l.startsWith(`${key}=`));
      writeFileSync(pf, kept.join("\n"));
    } catch {
      // best-effort, matches the bash `|| true`
    }
  }
  gitTarget(ctx, ["worktree", "prune"]);
}

export { singular as roleSingular };
