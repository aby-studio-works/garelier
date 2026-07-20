// W-083 ts-first: FRESH mode orchestration.
//
// Faithful port of the FRESH body of setup_wizard.ts (lines 2207-3486). Pure
// assembly of the already-ported, byte-verified pieces: scaffold.ts (trees),
// config_emit.ts (setup_config.toml, d1), agents_md.ts (AGENTS.md), showcase.ts,
// hooks.ts, ignores.ts, plus pmid/entries/toml/paths helpers. This module owns
// the git checks, state machine, branch creation, the settings.json / history /
// manifest heredocs, the completion marker, and the plan/next-steps output.
// cwd is PROJECT_ROOT (the entry chdir'd before dispatching).

import { existsSync, mkdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { git, resolveCommand, type RunResult } from "../_lib.ts";
import { commandExists, cygpathMixed, nowIso, type GarelierDirs } from "./env.ts";
import { resolvePmIdInteractively } from "./pmid.ts";
import { detectSetupState, readTomlValue } from "./toml.ts";
import { crewSubdirFromPmRoot, slugifyTarget, type WizardPaths } from "./paths.ts";
import { entryId, entryModel, entryProvider, parseEntries } from "./entries.ts";
import { qgDefaultsForStack } from "./entries.ts";
import { makeControlTree, makeRuntimeTree, type ScaffoldCtx } from "./scaffold.ts";
import { writeShowcaseGallery } from "./showcase.ts";
import { emitFreshSetupConfig } from "./config_emit.ts";
import { renderAgentsMd } from "./agents_md.ts";
import { registerRuntimeRecoveryHook, registerTaskMirrorHook } from "./hooks.ts";
import { writeNestedIgnores } from "./ignores.ts";
import { resolveCleanupTarget, cleanupPartialInstall } from "./cleanup.ts";

const WIZARD_VERSION = "2.13.1";

export interface FreshParams {
  projectRoot: string;
  gitRoot: string;
  now: string; // NOW
  dirs: GarelierDirs;
  coreTemplatesDir: string;
  pmId: string;
  projectName: string;
  target: string;
  workers: string;
  scouts: string;
  smiths: string;
  librarians: string;
  observers: string;
  guardians: string;
  concierges: string;
  artisanSpec: string;
  scoutIdleTask: string;
  defaultLane: string;
  skipConfirm: boolean;
  stack: string;
  qgCmds: string[];
  permissionProfile: string;
  agentsPolicy: string;
  wsExile: boolean;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}
function readLineSync(): string {
  const buf = Buffer.alloc(1);
  let s = "";
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch {
      break;
    }
    if (n === 0) break;
    const ch = buf.toString("utf8");
    if (ch === "\n") break;
    if (ch !== "\r") s += ch;
  }
  return s;
}
function isYes(r: string): boolean {
  return /^(y|Y|yes|YES)$/.test(r);
}

export function runFresh(p: FreshParams): number {
  const gt = (args: string[]): RunResult => git(p.gitRoot, args);
  const verifyRef = (ref: string): boolean => gt(["rev-parse", "--verify", ref]).exitCode === 0;

  // === git preconditions (2211-2218) ===
  if (gt(["rev-parse", "--is-inside-work-tree"]).exitCode !== 0) {
    err(`Error: target root ${p.gitRoot} is not inside a git repository.`);
    return 1;
  }
  if (gt(["rev-parse", "HEAD"]).exitCode !== 0) {
    err("Error: target repository has no commits. Make at least one commit first.");
    return 1;
  }

  // === pm_id + existing-layout state machine (2220-2294) ===
  const pmId = resolvePmIdInteractively(p.pmId, p.skipConfirm);
  const pmRoot = `__garelier/${pmId}`;
  let upgradeControlOnly = false;

  if (existsSync(pmRoot)) {
    const state = detectSetupState(pmId);
    if (state === "complete") {
      err(`Error: PM '${pmId}' already initialized at ${pmRoot}/.`);
      err(`       Choose another --pm-id, or cd ${crewSubdirFromPmRoot(pmRoot, "_pm")} and use --mode diff.`);
      return 1;
    } else if (state === "partial") {
      err(`Detected a partial install for PM '${pmId}' (wizard was interrupted).`);
      err("");
      err(`Found leftovers under ${pmRoot}/:`);
      for (const d of [
        "runtime", "control", "_crew", "_pm", "_dock", "_workers", "_scouts", "_smiths",
      ]) {
        if (existsSync(`${pmRoot}/${d}`)) err(`  - ${pmRoot}/${d}`);
      }
      const brRes = gt(["for-each-ref", "--format=%(refname:short)", `refs/heads/garelier/*/${pmId}/studio`]);
      if (brRes.exitCode === 0) {
        for (const br of brRes.stdout.split("\n").filter((l) => l !== "")) err(`  - branch ${br}`);
      }
      const wtRes = gt(["worktree", "list", "--porcelain"]);
      if (wtRes.exitCode === 0) {
        for (const wt of wtRes.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))) {
          if (new RegExp(`__garelier/${pmId}/_(workers|scouts|smiths)/`).test(wt)) err(`  - worktree ${wt}`);
        }
      }
      err("");
      const cleanupTarget = resolveCleanupTarget({ pmId, gitRoot: p.gitRoot, target: p.target });
      if (cleanupTarget === "") {
        err("Error: cannot determine a non-Garelier branch to switch to.");
        err("       Pass --target <branch> explicitly to recover.");
        return 1;
      }
      let studioToDelete = "";
      if (existsSync(`${crewSubdirFromPmRoot(pmRoot, "_pm")}/setup_config.toml`)) {
        studioToDelete = readTomlValue(pmId, "branches", "integration");
      }
      if (studioToDelete === "") studioToDelete = `garelier/${slugifyTarget(cleanupTarget)}/${pmId}/studio`;
      const doClean = (): boolean => cleanupPartialInstall({ pmId, gitRoot: p.gitRoot, target: p.target }, cleanupTarget, studioToDelete);
      if (p.skipConfirm) {
        err("Auto-cleaning (--skip-confirm passed).");
        if (!doClean()) return 1;
      } else {
        err(`Cleanup target: ${cleanupTarget} (real branch to switch to)`);
        err(`Studio to delete: ${studioToDelete}`);
        process.stderr.write("Clean these up and continue with fresh init? [y/N] ");
        if (isYes(readLineSync())) {
          if (!doClean()) return 1;
        } else {
          err("Aborted. Resolve the partial install manually then re-run.");
          return 1;
        }
      }
    } else if (state === "starter") {
      upgradeControlOnly = true;
      err(`Detected a Garelier small starter at ${pmRoot}/.`);
      err("Its existing control and knowledge will be preserved while full Garelier is added.");
    }
    // "absent": PM dir exists but empty — allowed, nothing to do.
  }

  // === target + studio branch (2296-2316) ===
  let target = p.target;
  if (target === "") {
    target = gt(["symbolic-ref", "--short", "HEAD"]).stdout.trim();
    if (target === "") {
      err("Error: cannot determine current branch (detached HEAD?). Pass --target <branch>.");
      return 1;
    }
  }
  if (!verifyRef(target)) {
    err(`Error: target branch '${target}' does not exist.`);
    return 1;
  }
  const targetSlug = slugifyTarget(target);
  const studioBranch = `garelier/${targetSlug}/${pmId}/studio`;
  if (verifyRef(studioBranch)) {
    err(`Error: branch ${studioBranch} already exists.`);
    err("       Either choose a different --pm-id, or delete the stale branch first.");
    return 1;
  }

  // === entries + artisan (2318-2345) ===
  const workerEntries = parseEntries(p.workers);
  const scoutEntries = parseEntries(p.scouts);
  const smithEntries = parseEntries(p.smiths);
  const librarianEntries = parseEntries(p.librarians);
  const observerEntries = parseEntries(p.observers);
  const guardianEntries = parseEntries(p.guardians);
  const conciergeEntries = parseEntries(p.concierges);
  let artisanId = "artisan-01";
  let artisanProvider = "claude-code";
  let artisanModel = "claude-code";
  if (p.artisanSpec !== "") {
    const arr = parseEntries(p.artisanSpec);
    if (arr.length > 1) {
      err(`Error: the Artisan is a singleton — only one --artisan entry is allowed (got ${arr.length}). (DEC-017/DEC-056)`);
      return 1;
    }
    if (arr.length > 0) {
      artisanId = entryId(arr[0]);
      artisanProvider = entryProvider(arr[0]);
      artisanModel = entryModel(arr[0]);
    }
  }

  // === plan + confirm (2347-2371) ===
  out("Garelier setup plan (fresh mode)");
  out("=================================");
  out(`  Project name:   ${p.projectName}`);
  out(`  Control root:   ${p.projectRoot}`);
  out(`  Target root:    ${p.gitRoot}`);
  out(`  PM identifier:  ${pmId}`);
  out(`  PM root:        ${pmRoot}`);
  out(`  Target branch:  ${target}`);
  out(`  Target slug:    ${targetSlug}`);
  out(`  Will create branch: ${studioBranch} (from ${target})`);
  out(`  Workers (${workerEntries.length}):`);
  for (const e of workerEntries) out(`      + ${e}`);
  out(`  Scouts (${scoutEntries.length}):`);
  for (const e of scoutEntries) out(`      + ${e}`);
  out(`  Smiths (${smithEntries.length}):`);
  for (const e of smithEntries) out(`      + ${e}`);
  out("");
  if (!p.skipConfirm) {
    process.stdout.write("Proceed? [y/N] ");
    if (!isYes(readLineSync())) {
      out("Aborted.");
      return 0;
    }
  }

  // === layout v2 + PM dir (2373-2377) ===
  mkdirSync(`${pmRoot}/_crew`, { recursive: true });
  const pmDir = crewSubdirFromPmRoot(pmRoot, "_pm");
  mkdirSync(pmDir, { recursive: true });

  // === studio branch (2379-2384) ===
  out("");
  out("==> Creating integration (studio) branch...");
  gt(["branch", studioBranch, target]);
  out(`  + ${studioBranch} created from ${target}`);
  gt(["checkout", studioBranch]);
  out(`  + target worktree switched to ${studioBranch}`);

  // === scaffold ctx ===
  const scaffoldCtx: ScaffoldCtx = {
    pmRoot,
    pmDir,
    pmId,
    projectName: p.projectName,
    target,
    studioBranch,
    upgradeControlOnly,
    coreTemplatesDir: p.coreTemplatesDir,
  };

  // === runtime tree (2386-2443) ===
  out("");
  out(`==> Creating ${pmRoot}/runtime/ structure...`);
  makeRuntimeTree(scaffoldCtx);

  // === showcase/gallery (2445-2448) ===
  writeShowcaseGallery(pmRoot);
  out(`  + ${pmRoot}/showcase/ (gitignored) + ${pmRoot}/gallery/ (tracked, LFS) created`);

  // === pm dir history/archive (2450-2451) ===
  mkdirSync(`${pmDir}/history/archive`, { recursive: true });
  if (!existsSync(`${pmDir}/history/archive/.gitkeep`)) writeFileSync(`${pmDir}/history/archive/.gitkeep`, "");

  // === control tree (2453-2718) ===
  out("");
  out(`==> Creating ${pmRoot}/control/ structure...`);
  if (!makeControlTree(scaffoldCtx)) return 1;

  // === DEC-065 (2727-2730) ===
  out("");
  out("==> Role containers: none pre-created (dispatch-native, DEC-065).");
  out("    Producers run in ephemeral _crew/dispatch<N>/ homes; roster entries");
  out("    in setup_config.toml are seat defaults (model routing).");

  // === policy flags (2732-2744) ===
  const obsPolicyEnabled = observerEntries.length > 0;
  const grdPolicyEnabled = guardianEntries.length > 0;
  const conPolicyEnabled = conciergeEntries.length > 0;

  // === permission-profile + agents-policy + QG resolution (2746-2769) ===
  if (!["safe", "reviewed", "dangerous"].includes(p.permissionProfile)) {
    err(`Error: --permission-profile must be safe|reviewed|dangerous (got: ${p.permissionProfile}).`);
    return 1;
  }
  if (!["strict", "minimal"].includes(p.agentsPolicy)) {
    err(`Error: --agents-policy must be strict|minimal (got: ${p.agentsPolicy}).`);
    return 1;
  }
  let qgCmds = p.qgCmds;
  if (qgCmds.length === 0) qgCmds = qgDefaultsForStack(p.stack);
  if (qgCmds.length === 0) {
    err(`Error: quality gate has no commands. stack="${p.stack}" has no default set.`);
    err('       Pass --stack rust|typescript|python|go, or one or more --quality-gate "<cmd>".');
    err("       (stack=custom and stack=mixed always require explicit --quality-gate.)");
    return 1;
  }
  if (p.permissionProfile === "dangerous") {
    out("WARNING: permission profile 'dangerous' grants full provider access");
    out("         for providers that support it (for example Claude --dangerously-skip-permissions).");
    out("         Codex producer subprocesses still use workspace-write + --add-dir.");
    out("         Use only in an isolated environment. Recorded in setup_config.toml.");
  }

  // === setup_config.toml (2771-3253) ===
  out("");
  out(`==> Generating ${pmDir}/setup_config.toml...`);
  const wizardPaths: WizardPaths = {
    pmId,
    projectRoot: p.projectRoot,
    gitRoot: p.gitRoot,
    wsExile: p.wsExile,
    garelierHome: process.env.GARELIER_HOME ?? "",
  };
  const configBody = emitFreshSetupConfig({
    ctx: wizardPaths,
    projectName: p.projectName,
    now: p.now,
    pmId,
    target,
    targetSlug,
    studioBranch,
    pmDir,
    workerEntries,
    scoutEntries,
    smithEntries,
    librarianEntries,
    observerEntries,
    guardianEntries,
    conciergeEntries,
    scoutIdleTask: p.scoutIdleTask,
    defaultLane: p.defaultLane,
    artisanEnable: true,
    artisanId,
    artisanProvider,
    artisanModel,
    qgCmds,
    stack: p.stack,
    permissionProfile: p.permissionProfile,
    obsPolicyEnabled,
    grdPolicyEnabled,
    conPolicyEnabled,
  });
  writeFileSync(`${pmDir}/setup_config.toml`, configBody);
  out(`  + ${pmDir}/setup_config.toml written`);

  // === settings.json (3255-3276) ===
  out("");
  out(`==> Generating ${pmDir}/.claude/settings.json (SessionStart digest)...`);
  mkdirSync(`${pmDir}/.claude`, { recursive: true });
  const settingsJson = [
    "{",
    '  "hooks": {',
    '    "SessionStart": [',
    "      {",
    '        "hooks": [',
    "          {",
    '            "type": "command",',
    '            "command": "bun \\"$HOME/.claude/skills/garelier-core/driver/src/scripts/session_digest.ts\\" 2>/dev/null || true"',
    "          }",
    "        ]",
    "      }",
    "    ]",
    "  }",
    "}",
    "",
  ].join("\n");
  writeFileSync(`${pmDir}/.claude/settings.json`, settingsJson);
  out(`  + ${pmDir}/.claude/settings.json written (SessionStart shows a token-free status digest)`);

  // === command_guard hook at project root (3278-3298) ===
  if (commandExists("bun")) {
    let cgGuard = `${p.dirs.driverDir}/src/guard/command_guard.ts`;
    if (commandExists("cygpath")) cgGuard = cygpathMixed(cgGuard);
    const inst = require_run([
      "bun",
      `${p.dirs.driverDir}/src/guard/install_hook.ts`,
      `${p.gitRoot}/.claude/settings.local.json`,
      cgGuard,
    ]);
    if (inst === 0) {
      out(`  + command_guard PreToolUse hook registered at ${p.gitRoot}/.claude/settings.local.json (attended-subagent coverage)`);
    }
  } else {
    out("  = bun not found; skipped project-root command_guard hook (install bun, then re-run the wizard)");
  }

  // === task_mirror + runtime_recovery hooks (3300-3303) ===
  registerTaskMirrorHook(p.projectRoot, p.dirs);
  registerRuntimeRecoveryHook(p.projectRoot, p.dirs);

  // === history.md (3305-3329) ===
  out("");
  out(`==> Generating ${pmDir}/history.md...`);
  const history = [
    `# Garelier PM History — ${pmId}`,
    "",
    "Hot index of blueprints PM has dispatched. PM appends here while",
    "entries are active/recent, then rotates old completed entries into",
    "_pm/history/archive/YYYY-MM.md per garelier-core/retention.md.",
    "",
    "Entries are numbered sequentially. The number is also the",
    'user-visible reference for re-execution ("re-run #042").',
    "",
    "## Archived history",
    "",
    "(none yet)",
    "",
    `## #001 — ${p.now} — Project initialized`,
    "- Blueprint: -",
    "- Milestone: -",
    "- Outcome: setup-only (no blueprint dispatched)",
    `- Notes: PM "${pmId}" for project "${p.projectName}" initialized by setup_wizard. target=${target}, integration=${studioBranch}`,
    "",
    "<!-- Next entry number: 2 -->",
    "",
  ].join("\n");
  writeFileSync(`${pmDir}/history.md`, history);
  out(`  + ${pmDir}/history.md written`);

  // === manifest.md (3331-3368) ===
  out("");
  out(`==> Generating initial ${pmRoot}/runtime/manifest.md...`);
  const manifest = [
    `# Runtime Manifest — ${pmId}`,
    "",
    `Last updated: ${p.now}`,
    "Updated by: setup_wizard",
    `Garelier version: ${WIZARD_VERSION}`,
    `PM: ${pmId}`,
    `Target branch: ${target}`,
    `Integration (studio) branch: ${studioBranch}`,
    "",
    "## Active milestones",
    "",
    "(none yet — PM will define after setup)",
    "",
    "## Dispatch execution",
    "",
    "Execution state is derived (DEC-064 W-011): see `backlog/in_flight.md`",
    "(generated) and `dispatch/events.jsonl`. This file tracks milestones,",
    "backlog totals, escalations, and recent activity only.",
    "",
    "## Backlog summary",
    "",
    "- Pending: 0 items",
    "- In flight: 0 items",
    "- Smith hardening targets remaining: 0 (pending 0, active 0)",
    "- Done this milestone: 0 items",
    "",
    "## Open escalations",
    "",
    "(none)",
    "",
    "## Recent activity",
    "",
    `- ${p.now} — setup_wizard — PM ${pmId} initialized (${p.projectName})`,
    "",
  ].join("\n");
  writeFileSync(`${pmRoot}/runtime/manifest.md`, manifest);
  out(`  + ${pmRoot}/runtime/manifest.md written`);

  // === nested ignores (3370-3372) ===
  out("");
  out("==> Writing nested __garelier/.gitignore + .ignore (DEC-051; root untouched)...");
  writeNestedIgnores(p.dirs);

  // === AGENTS.md (3374-3442) ===
  out("");
  out("==> Creating target AGENTS.md skeleton...");
  const agentsFile = `${p.gitRoot}/AGENTS.md`;
  if (existsSync(agentsFile)) {
    out(`  ~ ${agentsFile} already exists (skipping)`);
  } else {
    const agentsTemplate = `${p.coreTemplatesDir}/agents.md`;
    if (existsSync(agentsTemplate)) {
      const rendered = renderAgentsMd(readFileSync(agentsTemplate, "utf8"), {
        projectName: p.projectName,
        target,
        targetSlug,
        pmId,
        stack: p.stack,
        agentsPolicy: p.agentsPolicy,
        qgCmds,
      });
      writeFileSync(agentsFile, rendered);
      if (p.agentsPolicy === "minimal") {
        out(`  + ${agentsFile} created from template (stack=${p.stack}; agents-policy=minimal — all placeholders filled with safe defaults)`);
      } else {
        out(`  + ${agentsFile} created from template (stack=${p.stack}; language + quality gate pre-filled; restricted files / conventions left as placeholders — edit before launch)`);
      }
    } else {
      err(`  ! agents.md template not found at ${agentsTemplate}`);
    }
  }

  // === completion marker (3444-3460) ===
  out("");
  out("==> Writing setup completion marker...");
  const marker = [
    "",
    "# === Setup completion marker ===",
    "#",
    "# Written as the wizard's last step. PM treats this project as",
    "# fully initialized only when [setup] complete = true is present.",
    "# Absence of this section indicates a partial (interrupted) install",
    "# and the wizard will offer to clean up before retrying fresh init.",
    "",
    "[setup]",
    "complete = true",
    `completed_at = "${nowIso()}"`,
    `wizard_version = "${WIZARD_VERSION}"`,
    "",
  ].join("\n");
  writeFileSync(`${pmDir}/setup_config.toml`, configBody + marker);
  out("  + [setup] complete = true appended to setup_config.toml");

  // === next steps (3462-3485) ===
  out("");
  out("===================================");
  out("Garelier setup complete (fresh).");
  out("===================================");
  out("");
  out("Next steps:");
  out(`  1. Edit ${agentsFile} and replace the remaining project-specific {{...}}`);
  out("     fields (restricted files §3, conventions §10). Doctor flags any");
  out("     remaining {{placeholder}} as P0 — do not arm the dispatch loop");
  out("     until it is clean. Language and quality gate are pre-filled.");
  out("  2. Commit the initial state (local-only — do NOT push):");
  if (p.gitRoot === p.projectRoot) {
    out(`       git add AGENTS.md __garelier/.gitignore __garelier/.ignore ${pmDir}/ ${pmRoot}/control/ ${pmRoot}/gallery/`);
    out(`       git commit -m 'Garelier: initialize PM ${pmId} (v${WIZARD_VERSION})'`);
  } else {
    out(`       (control) cd ${p.projectRoot} && git add __garelier/.gitignore __garelier/.ignore ${pmDir}/ ${pmRoot}/control/ ${pmRoot}/gallery/`);
    out(`       (target)  cd ${p.gitRoot} && git add AGENTS.md`);
    out("       commit each repository with your project convention");
  }
  out(`     (${studioBranch} stays local per protocol.md §6.5; only <target> is pushed at promote.)`);
  out("  3. Launch the PM/Dock session with the configured provider:");
  out(`       cd ${pmDir} && claude   # or codex after reading the PM skill docs`);
  out("     Producers run as in-session subagents in ephemeral dispatch<N>/");
  out("     homes; no separate Dock session is needed (DEC-061/065).");
  return 0;
}

// Local run helper (stdout to /dev/null, exit code only), matching the bash
// `bun "$installer" ... >/dev/null` for the command_guard installer.
function require_run(command: string[]): number {
  const resolved = resolveCommand(command);
  if (!resolved) return 127;
  const child = Bun.spawnSync(resolved, { windowsHide: true, stdin: "inherit", stdout: "ignore", stderr: "inherit" });
  return child.exitCode;
}
