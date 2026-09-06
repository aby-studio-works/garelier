// W-083 ts-first: FRESH mode orchestration.
//
// Faithful port of the FRESH body of setup_wizard.ts (lines 2207-3486). Pure
// assembly of the already-ported, byte-verified pieces: scaffold.ts (trees),
// config_emit.ts (setup_config.toml, d1), agents_md.ts (AGENTS.md), showcase.ts,
// hooks.ts, ignores.ts, plus pmid/entries/toml/paths helpers. This module owns
// the git checks, state machine, branch creation, the settings.json /
// manifest heredocs, the completion marker, and the plan/next-steps output.
// cwd is PROJECT_ROOT (the entry chdir'd before dispatching).

import { existsSync, mkdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { git, resolveCommand, type RunResult } from "../_lib.ts";
import { commandExists, cygpathMixed, nowIso, type GarelierDirs } from "./env.ts";
import { resolvePmIdInteractively } from "./pmid.ts";
import { detectSetupState, readTomlValueFrom } from "./toml.ts";
import { crewPathFromPmRoot, crewSubdirFromPmRoot, slugifyTarget, type WizardPaths } from "./paths.ts";
import { qgDefaultsForStack } from "./entries.ts";
import { makeControlTree, makeRuntimeTree, type ScaffoldCtx } from "./scaffold.ts";
import { writeShowcaseGallery } from "./showcase.ts";
import { emitFreshSetupConfig } from "./config_emit.ts";
import { renderAgentsMd } from "./agents_md.ts";
import { registerRuntimeRecoveryHook, registerTaskMirrorHook } from "./hooks.ts";
import { writeNestedIgnores } from "./ignores.ts";
import { discoverFreshInputs } from "./fresh_discovery.ts";
import { frameworkVersion } from "../../version.ts";

// W-731: read the VERSION authority instead of carrying a hand-bumped literal.
const WIZARD_VERSION = frameworkVersion();

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
  artisanConfigured: boolean;
  artisanEnable: boolean;
  scoutIdleTask: string;
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
// A repair changes nothing that already exists, so it defaults to yes; only an
// explicit "no" aborts. (An EOF/empty answer must never mean "go ahead and
// destroy" — after W-313 there is nothing destructive left to consent to.)
function isNo(r: string): boolean {
  return /^(n|N|no|NO)$/.test(r);
}

export function runFresh(p: FreshParams): number {
  const gt = (args: string[]): RunResult => git(p.gitRoot, args);
  const verifyRef = (ref: string): boolean => gt(["rev-parse", "--verify", ref]).exitCode === 0;
  const discovered = discoverFreshInputs(p.gitRoot);
  const projectName = p.projectName.trim() || discovered.projectName;
  const stack = p.stack === "auto" ? discovered.stack : p.stack;

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
  // W-313: "partial" only means the [setup] completion marker is absent. It says
  // nothing about how much control / knowledge / runtime the namespace holds, so
  // it can never authorize deletion — fresh REPAIRS such a namespace in place.
  let repairPartial = false;
  const repairPmDir = crewPathFromPmRoot(pmRoot, "pm");

  if (existsSync(pmRoot)) {
    const state = detectSetupState(pmId);
    if (state === "complete") {
      err(`Error: PM '${pmId}' already initialized at ${pmRoot}/.`);
      err(`       Choose another --pm-id, or cd ${crewSubdirFromPmRoot(pmRoot, "pm")} and use --mode diff.`);
      return 1;
    } else if (state === "partial") {
      repairPartial = true;
      err(`Detected an incomplete install for PM '${pmId}' (a previous wizard run did not finish).`);
      err("");
      err(`Repairing in place. Everything already under ${pmRoot}/ is PRESERVED —`);
      err("the wizard never deletes a namespace, a branch, or a worktree (W-313).");
      err("");
      err("Preserved as-is:");
      for (const d of [
        "runtime", "control", "knowledge", "_crew",
      ]) {
        if (existsSync(`${pmRoot}/${d}`)) err(`  = ${pmRoot}/${d}`);
      }
      const brRes = gt(["for-each-ref", "--format=%(refname:short)", `refs/heads/garelier/*/${pmId}/studio`]);
      if (brRes.exitCode === 0) {
        for (const br of brRes.stdout.split("\n").filter((l) => l !== "")) err(`  = branch ${br}`);
      }
      const wtRes = gt(["worktree", "list", "--porcelain"]);
      if (wtRes.exitCode === 0) {
        for (const wt of wtRes.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))) {
          if (new RegExp(`__garelier/${pmId}/_crew/(workers|scouts|smiths)/`).test(wt)) err(`  = worktree ${wt}`);
        }
      }
      err("");
      err("Only what is MISSING gets added (setup_config.toml, absent runtime");
      err("directories, the completion marker). No existing file is rewritten.");
      err("To remove a namespace on purpose, run --mode teardown: it inventories what");
      err("exists and leaves the deletion decision (and the commands) to you.");
      if (!p.skipConfirm) {
        process.stderr.write("Repair this install in place? [Y/n] ");
        if (isNo(readLineSync())) {
          err("Aborted; nothing was changed.");
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
  // A repair inherits the branch pair the namespace already recorded, so it
  // cannot strand the existing state behind a second, divergent studio.
  const existingConfig = `${repairPmDir}/setup_config.toml`;
  const keepExistingConfig = repairPartial && existsSync(existingConfig);
  let target = p.target;
  if (keepExistingConfig) {
    const recordedTarget = readTomlValueFrom(existingConfig, "branches", "target");
    if (recordedTarget !== "") target = recordedTarget;
  }
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
  let studioBranch = `garelier/${targetSlug}/${pmId}/studio`;
  if (keepExistingConfig) {
    const recordedStudio = readTomlValueFrom(existingConfig, "branches", "integration");
    if (recordedStudio === "") {
      err(`Error: ${existingConfig} exists but records no [branches] integration entry.`);
      err("       It is too incomplete to repair from, and the wizard will not overwrite");
      err("       a file it did not finish writing. Inspect it, then either complete");
      err("       [branches] by hand or move the file aside, and re-run.");
      return 1;
    }
    studioBranch = recordedStudio;
  }
  let reuseStudio = false;
  if (verifyRef(studioBranch)) {
    if (!repairPartial) {
      err(`Error: branch ${studioBranch} already exists.`);
      err("       Either choose a different --pm-id, or delete the stale branch first.");
      return 1;
    }
    // It may carry unmerged work; a repair reuses it and never force-deletes it.
    reuseStudio = true;
  }

  // Resolve and normalize project quality gates before creating a branch or
  // writing either setup_config.toml or the schema-3 Dashboard quality-gate view.
  let qgCmds = [...new Set(p.qgCmds.map((command) => command.trim()).filter((command) => command !== ""))];
  if (qgCmds.length === 0) {
    qgCmds = p.stack === "auto" ? discovered.qualityGateCommands : qgDefaultsForStack(stack);
  }
  if (qgCmds.length === 0) {
    err(`Error: quality gate could not be determined safely (detected stack="${stack}").`);
    err("       No authoritative command was found in CI, AGENTS.md/CLAUDE.md, or project manifests.");
    err('       Confirm the project gate and pass one or more --quality-gate "<cmd>" overrides.');
    return 1;
  }

  // === plan + confirm (2347-2371) ===
  out(repairPartial ? "Garelier setup plan (fresh mode — repairing in place)" : "Garelier setup plan (fresh mode)");
  out("=================================");
  out(`  Project name:   ${projectName}${p.projectName.trim() ? " (override)" : " (detected)"}`);
  out(`  Control root:   ${p.projectRoot}`);
  out(`  Target root:    ${p.gitRoot}`);
  out(`  PM identifier:  ${pmId}`);
  out(`  PM root:        ${pmRoot}`);
  out(`  Target branch:  ${target}`);
  out(`  Target slug:    ${targetSlug}`);
  out(reuseStudio ? `  Will reuse branch:  ${studioBranch} (already exists)` : `  Will create branch: ${studioBranch} (from ${target})`);
  out(`  Stack:          ${stack}${p.stack === "auto" ? " (detected)" : " (override)"}`);
  out(`  Quality gate:   ${qgCmds.join(" && ")}${p.qgCmds.length > 0 ? " (override)" : ` (${discovered.gateSource})`}`);
  out("  Routing:        per-task authority; all role capabilities available");
  if (p.permissionProfile !== "") {
    out(`  Permissions:    explicit override ${p.permissionProfile}`);
  } else {
    out("  Permissions:    unchanged (not persisted by setup)");
  }

  // === canonical crew + PM directories (2373-2377) ===
  if (!repairPartial) mkdirSync(`${pmRoot}/_crew`, { recursive: true });
  const pmDir = repairPartial ? repairPmDir : crewSubdirFromPmRoot(pmRoot, "pm");
  mkdirSync(pmDir, { recursive: true });

  // === studio branch (2379-2384) ===
  out("");
  out("==> Creating integration (studio) branch...");
  if (reuseStudio) {
    out(`  = ${studioBranch} already exists — reused as-is (never force-deleted)`);
  } else {
    gt(["branch", studioBranch, target]);
    out(`  + ${studioBranch} created from ${target}`);
  }
  gt(["checkout", studioBranch]);
  out(`  + target worktree switched to ${studioBranch}`);

  // === scaffold ctx ===
  const scaffoldCtx: ScaffoldCtx = {
    pmRoot,
    pmDir,
    pmId,
    projectName,
    target,
    studioBranch,
    targetRoot: p.gitRoot,
    upgradeControlOnly,
    preserveExistingControl: repairPartial,
    coreTemplatesDir: p.coreTemplatesDir,
    now: p.now,
    stack,
    qgCmds,
  };

  // === runtime tree (2386-2443) ===
  out("");
  out(`==> Creating ${pmRoot}/runtime/ structure...`);
  makeRuntimeTree(scaffoldCtx);

  // === showcase/gallery (2445-2448) ===
  writeShowcaseGallery(pmRoot);
  out(`  + ${pmRoot}/showcase/ (gitignored) + ${pmRoot}/gallery/ (tracked, LFS) created`);

  // === control tree (2453-2718) ===
  out("");
  out(`==> Creating ${pmRoot}/control/ structure...`);
  if (!makeControlTree(scaffoldCtx)) return 1;

  // === DEC-065 (2727-2730) ===
  out("");
  out("==> Role containers: none pre-created (dispatch-native, DEC-065).");
  out("    Roles run in ephemeral _crew/dispatch<N>/ homes. Roles are");
  out("    framework capabilities selected per task; provider/model stay");
  out("    unset unless an explicit override was supplied.");

  // === policy flags (2732-2744) ===
  const obsPolicyEnabled = true;
  const grdPolicyEnabled = true;
  const conPolicyEnabled = true;

  // === permission-profile + agents-policy (2746-2769) ===
  if (p.permissionProfile !== "" && !["safe", "reviewed", "dangerous"].includes(p.permissionProfile)) {
    err(`Error: --permission-profile must be safe|reviewed|dangerous (got: ${p.permissionProfile}).`);
    return 1;
  }
  if (!["strict", "minimal"].includes(p.agentsPolicy)) {
    err(`Error: --agents-policy must be strict|minimal (got: ${p.agentsPolicy}).`);
    return 1;
  }
  if (p.permissionProfile === "dangerous") {
    out("WARNING: permission profile 'dangerous' grants full provider access");
    out("         for providers that support it (for example Claude --dangerously-skip-permissions).");
    out("         Codex-dispatched role subprocesses still use workspace-write + --add-dir.");
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
    projectName,
    now: p.now,
    pmId,
    target,
    targetSlug,
    studioBranch,
    pmDir,
    qgCmds,
    stack,
    permissionProfile: p.permissionProfile,
    obsPolicyEnabled,
    grdPolicyEnabled,
    conPolicyEnabled,
  });
  if (keepExistingConfig) {
    out(`  = ${pmDir}/setup_config.toml already present — kept byte-for-byte (repair)`);
  } else {
    writeFileSync(`${pmDir}/setup_config.toml`, configBody);
    out(`  + ${pmDir}/setup_config.toml written`);
  }

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
  if (repairPartial && existsSync(`${pmDir}/.claude/settings.json`)) {
    out(`  = ${pmDir}/.claude/settings.json already present — kept (repair)`);
  } else {
    writeFileSync(`${pmDir}/.claude/settings.json`, settingsJson);
    out(`  + ${pmDir}/.claude/settings.json written (SessionStart shows a token-free status digest)`);
  }

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
    `- ${p.now} — setup_wizard — PM ${pmId} initialized (${projectName})`,
    "",
  ].join("\n");
  if (repairPartial && existsSync(`${pmRoot}/runtime/manifest.md`)) {
    out(`  = ${pmRoot}/runtime/manifest.md already present — kept (repair)`);
  } else {
    writeFileSync(`${pmRoot}/runtime/manifest.md`, manifest);
    out(`  + ${pmRoot}/runtime/manifest.md written`);
  }

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
        projectName,
        target,
        targetSlug,
        pmId,
        stack,
        agentsPolicy: p.agentsPolicy,
        qgCmds,
      });
      writeFileSync(agentsFile, rendered);
      if (p.agentsPolicy === "minimal") {
        out(`  + ${agentsFile} created from template (stack=${stack}; agents-policy=minimal — all placeholders filled with safe defaults)`);
      } else {
        out(`  + ${agentsFile} created from template (stack=${stack}; language + quality gate pre-filled; restricted files / conventions left as placeholders — edit before launch)`);
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
  if (keepExistingConfig) {
    const current = readFileSync(`${pmDir}/setup_config.toml`, "utf8");
    if (/^\[setup\]/m.test(current) && /^complete\s*=\s*true/m.test(current)) {
      out("  = [setup] complete = true already present");
    } else {
      writeFileSync(`${pmDir}/setup_config.toml`, current + marker);
      out("  + [setup] complete = true appended to the existing setup_config.toml");
    }
  } else {
    writeFileSync(`${pmDir}/setup_config.toml`, configBody + marker);
    out("  + [setup] complete = true appended to setup_config.toml");
  }

  // === next steps (3462-3485) ===
  out("");
  out("===================================");
  out(repairPartial ? "Garelier setup complete (repaired in place; nothing was deleted)." : "Garelier setup complete (fresh).");
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
  out("  3. Continue from the current PM session:");
  out(`       cd ${pmDir}`);
  out("     No provider/model was pinned; a newly launched session uses the");
  out("     provider and model the user explicitly chooses.");
  out("     Roles run as in-session subagents in ephemeral dispatch<N>/");
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
