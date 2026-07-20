#!/usr/bin/env bun
// W-083 ts-first: setup_wizard entry (arg parse + validation + mode dispatch).
//
// Full TS port of garelier-core/driver/src/scripts/setup_wizard.ts (5,052 lines). This entry
// reproduces the usage text, argument parsing, top-level validation, and
// cwd/pm-id resolution byte-for-byte, then dispatches to the ported mode bodies:
// teardown.ts / fresh.ts / migrate.ts / diff.ts. The bash setup_wizard.ts is now
// a 4-line exec-bun shim, so this file IS the live implementation; parity is
// pinned by setup_wizard_crew.test.ts (through the shim) plus the byte-diff
// oracles for fresh/migrate/diff.

import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { resolveGarelierDirs, nowIso } from "./setup_wizard/env.ts";
import { checkAgentSpecs, EntryError } from "./setup_wizard/entries.ts";
import { runTeardown } from "./setup_wizard/teardown.ts";
import { maybeSetupGarelierTools } from "./setup_wizard/tools.ts";
import { runFresh } from "./setup_wizard/fresh.ts";
import { runMigrate } from "./setup_wizard/migrate.ts";
import { runDiff } from "./setup_wizard/diff.ts";

const USAGE = `Usage: setup_wizard.ts [options]

Mode:
  --mode fresh           Initialize a new PM under __garelier/<pm_id>/ (default).
  --mode diff            Add or remove agents from an existing PM.
  --mode migrate         Upgrade older layouts; per-PM flat containers move under _crew/.
  --mode teardown        Remove Garelier hook wiring (run from _crew/pm/ or legacy _pm/); worktrees
                         are listed for the W-047 two-stage removal, not deleted.

Required for fresh mode:
  --project-name "<name>"        Project name
  --workers "<id:model,...>"     Worker definitions. Also accepts
                                 "<id:provider:model,...>".
  --scouts "<id:model,...>"      Scout definitions. Also accepts
                                 "<id:provider:model,...>".

Required for diff mode:
  --workers "<id:model,...>"     Desired Worker set (must include all kept ones)
  --scouts "<id:model,...>"      Desired Scout set (must include all kept ones)
  --smiths "<id:model,...>"      Optional desired Smith set. Omit in diff
                                 mode to keep existing Smiths unchanged.
  --librarians "<id:model,...>"  Optional desired Librarian set (DEC-018).
                                 Omit to keep existing; pass "" to remove all.
  --observers "<id:model,...>"   Optional desired Observer set (DEC-019).
                                 Omit to keep existing; pass "" to remove all.
  --guardians "<id:model,...>"   Optional desired Guardian set (DEC-024).
                                 Omit to keep existing; pass "" to remove all.
  --concierges "<id:model,...>"  Optional desired Concierge set (DEC-025).
                                 Omit to keep existing; pass "" to remove all.
  --artisan                      Enable the artisan lane (DEC-017).
  --no-artisan                   Disable the artisan lane. Omit both to keep
                                 the current artisan state unchanged.

Optional:
  --pm-id <id>                   PM identifier (fresh & migrate modes).
                                 Format: _workshop or
                                 [a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?
                                 Default: _workshop for single-user projects.
                                 Shared/multi-user projects should specify a
                                 unique --pm-id explicitly.
                                 In diff mode, auto-detected from cwd.
  --target <branch>              Target branch (fresh only; default: current branch).
                                 In diff mode read from setup_config.toml.
                                 Alias: --base (deprecated).
  --target-root <path>           Fresh/diff. Target project Git root when
                                 control_root != target_root (Plant-Crust).
                                 Relative paths resolve from the directory
                                 that owns __garelier/.
  --stack <name>                 (fresh only) Tech stack driving the quality-gate
                                 default command set and AGENTS.md language:
                                 rust | typescript | python | go | mixed | custom.
                                 Default: rust. custom/mixed require --quality-gate.
  --quality-gate "<cmd>"         (fresh only, repeatable) Explicit quality-gate
                                 command; overrides the stack default set.
                                 Required when --stack is custom or mixed.
  --permission-profile <p>       (fresh only) Provider autonomy profile:
                                 safe | reviewed | dangerous. Default: reviewed.
                                 dangerous = full provider access (opt-in only).
  --agents-policy <p>            (fresh only) How AGENTS.md placeholders are
                                 handled: strict | minimal. Default: strict.
                                 strict leaves project-specific fields
                                 (restricted files, conventions) as {{...}} —
                                 doctor reports P0 and the driver won't start
                                 until you fill them. minimal fills safe initial
                                 values ("none initially" / "follow existing
                                 style") so doctor passes immediately — handy for
                                 quick trials; tighten later.
  --librarians / --observers     (fresh & diff) See the diff-mode section above;
  / --guardians / --concierges   also accepted in fresh mode to seed the set.
  --artisan / --no-artisan       Toggle the artisan lane in DIFF mode only:
                                  --artisan enables it, --no-artisan disables it
                                  (omit both to keep the current state). In FRESH
                                  mode the artisan lane is ALWAYS enabled and
                                  --no-artisan is ignored (DEC-055).
                                  Artisan is a SINGLETON — one instance only.
  --scout-idle-task <true|false> (fresh only) default: false
  --default-lane <dock|artisan>  (fresh) Lane assumed when no lane.lock
                                  is present. default: dock. "artisan" = the
                                  single-agent lane runs by default (DEC-056).
  --skip-confirm                  Skip interactive confirmation
  --allow-requeued-removal        Diff only: allow removing non-IDLE agents
                                  after PM has returned their tasks to
                                  runtime/backlog/pending.md with outcome
                                  requeued. Does not perform requeue itself.
  --help                          Show this help

Run locations:
  fresh   : __garelier/             (one level up from the new PM dir)
  diff    : __garelier/<pm_id>/_crew/pm/ (or legacy _pm/)
  migrate : __garelier/             (top level of the legacy flat layout)

Examples:

  # Fresh init from inside __garelier/:
  cd /path/to/project/__garelier
  garelier setup \\
    --project-name "My Project" \\
    --pm-id "acme" \\
    --target "main" \\
    --workers "worker-01:claude-code,worker-02:claude-code" \\
    --scouts "scout-01:claude-code"

  # Diff mode: add worker-03
  cd /path/to/project/__garelier/acme/_pm
  garelier setup \\
    --mode diff \\
    --workers "worker-01:claude-code,worker-02:claude-code,worker-03:claude-code" \\
    --scouts "scout-01:claude-code"

  # Mixed provider pool:
  garelier setup \\
    --mode diff \\
    --workers "worker-01:claude-code,worker-02:codex-cli:gpt-5-codex" \\
    --scouts "scout-01:codex-cli:gpt-5-codex"

  # Migrate a v2.0 install to v2.1:
  cd /path/to/project/__garelier
  garelier setup \\
    --mode migrate --pm-id "acme"
`;

function outLine(s: string): void {
  process.stdout.write(`${s}\n`);
}
function errLine(s: string): void {
  process.stderr.write(`${s}\n`);
}
function usageToStdout(): void {
  process.stdout.write(USAGE);
}
function usageToStderr(): void {
  process.stderr.write(USAGE);
}

interface Options {
  mode: string;
  projectName: string;
  target: string;
  targetRoot: string;
  workers: string;
  scouts: string;
  smiths: string;
  smithsSet: boolean;
  scoutIdleTask: string;
  defaultLane: string;
  defaultLaneSet: boolean;
  skipConfirm: boolean;
  allowRequeuedRemoval: boolean;
  pmId: string;
  stack: string;
  qgCmds: string[];
  permissionProfile: string;
  agentsPolicy: string;
  librarians: string;
  librariansSet: boolean;
  observers: string;
  observersSet: boolean;
  guardians: string;
  guardiansSet: boolean;
  concierges: string;
  conciergesSet: boolean;
  artisanEnable: boolean;
  artisanDisable: boolean;
  artisanSet: boolean;
  artisanSpec: string;
  wsExile: boolean;
}

function defaults(): Options {
  return {
    mode: "fresh",
    projectName: "",
    target: "",
    targetRoot: "",
    workers: "",
    scouts: "",
    smiths: "",
    smithsSet: false,
    scoutIdleTask: "false",
    defaultLane: "dock",
    defaultLaneSet: false,
    skipConfirm: false,
    allowRequeuedRemoval: false,
    pmId: "",
    stack: "rust",
    qgCmds: [],
    permissionProfile: "reviewed",
    agentsPolicy: "strict",
    librarians: "",
    librariansSet: false,
    observers: "",
    observersSet: false,
    guardians: "",
    guardiansSet: false,
    concierges: "",
    conciergesSet: false,
    artisanEnable: false,
    artisanDisable: false,
    artisanSet: false,
    artisanSpec: "",
    wsExile: false,
  };
}

function main(argv: string[]): number {
  const o = defaults();

  // === Argument parsing (setup_wizard.ts lines 333-367) ===
  let i = 0;
  const need = (flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) {
      errLine(`Unknown option: ${flag}`);
      usageToStderr();
      process.exit(1);
    }
    return v;
  };
  while (i < argv.length) {
    const a = argv[i];
    switch (a) {
      case "--mode": o.mode = need(a); i += 2; break;
      case "--project-name": o.projectName = need(a); i += 2; break;
      case "--pm-id": o.pmId = need(a); i += 2; break;
      case "--target": o.target = need(a); i += 2; break;
      case "--target-root": o.targetRoot = need(a); i += 2; break;
      case "--base": o.target = need(a); i += 2; break; // deprecated alias
      case "--workers": o.workers = need(a); i += 2; break;
      case "--scouts": o.scouts = need(a); i += 2; break;
      case "--smiths": o.smiths = need(a); o.smithsSet = true; i += 2; break;
      case "--stack": o.stack = need(a); i += 2; break;
      case "--quality-gate": o.qgCmds.push(need(a)); i += 2; break;
      case "--permission-profile": o.permissionProfile = need(a); i += 2; break;
      case "--agents-policy": o.agentsPolicy = need(a); i += 2; break;
      case "--librarians": o.librarians = need(a); o.librariansSet = true; i += 2; break;
      case "--observers": o.observers = need(a); o.observersSet = true; i += 2; break;
      case "--guardians": o.guardians = need(a); o.guardiansSet = true; i += 2; break;
      case "--concierges": o.concierges = need(a); o.conciergesSet = true; i += 2; break;
      case "--artisan": {
        o.artisanEnable = true;
        o.artisanSet = true;
        // Optional inline spec; only consume $2 when it isn't another flag.
        const next = argv[i + 1];
        if (next !== undefined && next !== "" && !next.startsWith("-")) {
          o.artisanSpec = next;
          i += 2;
        } else {
          i += 1;
        }
        break;
      }
      case "--no-artisan": o.artisanDisable = true; o.artisanSet = true; i += 1; break;
      case "--exile": o.wsExile = true; i += 1; break;
      case "--scout-idle-task": o.scoutIdleTask = need(a); i += 2; break;
      case "--default-lane": o.defaultLane = need(a); o.defaultLaneSet = true; i += 2; break;
      case "--skip-confirm": o.skipConfirm = true; i += 1; break;
      case "--allow-requeued-removal": o.allowRequeuedRemoval = true; i += 1; break;
      case "--help":
      case "-h":
        usageToStdout();
        process.exit(0);
        break;
      default:
        errLine(`Unknown option: ${a}`);
        usageToStderr();
        process.exit(1);
    }
  }

  // Guard the ambiguous `id:provider` mistake at the TOP level (lines 391-398).
  try {
    checkAgentSpecs("workers", o.workers);
    checkAgentSpecs("scouts", o.scouts);
    checkAgentSpecs("smiths", o.smiths);
    checkAgentSpecs("librarians", o.librarians);
    checkAgentSpecs("observers", o.observers);
    checkAgentSpecs("guardians", o.guardians);
    checkAgentSpecs("concierges", o.concierges);
    checkAgentSpecs("artisan", o.artisanSpec);
  } catch (e) {
    if (e instanceof EntryError) {
      errLine(e.message);
      process.exit(1);
    }
    throw e;
  }

  // Mode validation (lines 413-438).
  switch (o.mode) {
    case "fresh":
      if (o.projectName === "") {
        errLine("Error: fresh mode requires --project-name.");
        usageToStderr();
        process.exit(1);
      }
      break;
    case "diff":
      if (o.workers === "" || o.scouts === "") {
        errLine("Error: diff mode requires --workers and --scouts (the desired final set).");
        usageToStderr();
        process.exit(1);
      }
      break;
    case "migrate":
      break;
    case "teardown":
      break;
    default:
      errLine(`Error: --mode must be 'fresh', 'diff', 'migrate', or 'teardown' (got: ${o.mode}).`);
      process.exit(1);
  }

  // default-lane validation (lines 440-451).
  if (o.defaultLane !== "dock" && o.defaultLane !== "artisan") {
    errLine(`Error: --default-lane must be 'dock' or 'artisan' (got: ${o.defaultLane}).`);
    process.exit(1);
  }
  if (o.mode !== "fresh" && o.defaultLaneSet) {
    errLine(
      "Error: --default-lane only applies to --mode fresh. In diff/migrate, edit '[lanes] default' in setup_config.toml directly (DEC-056).",
    );
    process.exit(1);
  }
  if (o.targetRoot !== "" && o.mode === "migrate") {
    errLine("Error: --target-root does not apply to --mode migrate.");
    process.exit(1);
  }

  // Fresh-mode defaults: EXACTLY ONE of every role (DEC-055; lines 465-477).
  if (o.mode === "fresh") {
    if (o.workers === "") o.workers = "worker-01:claude-code:claude-code";
    if (o.scouts === "") o.scouts = "scout-01:claude-code:claude-code";
    if (o.smiths === "") o.smiths = "smith-01:claude-code:claude-code";
    if (o.librarians === "") o.librarians = "librarian-01:claude-code:claude-code";
    if (o.observers === "") o.observers = "observer-01:claude-code:claude-code";
    if (o.guardians === "") o.guardians = "guardian-01:claude-code:claude-code";
    if (o.concierges === "") o.concierges = "concierge-01:claude-code:claude-code";
    o.artisanEnable = true;
  }

  // === Determine project root and pm_id from cwd (lines 498-538) ===
  // Prefer the MSYS-style $PWD (Git Bash sets it) so path-bearing output matches
  // the bash `$(pwd)`; fall back to process.cwd() when unset.
  const cwd = process.env.PWD ?? process.cwd();
  const cwdBase = basename(cwd);
  const cwdParentBase = basename(dirname(cwd));

  let projectRoot = "";
  if (o.mode === "fresh" || o.mode === "migrate") {
    if (cwdBase !== "__garelier") {
      errLine(`Error: --mode ${o.mode} must run from the project's __garelier/ directory.`);
      errLine(`Current directory: ${cwd}`);
      process.exit(1);
    }
    projectRoot = dirname(cwd);
  } else {
    // diff | teardown run from the resolved PM container.
    let pmIdFromCwd = "";
    if (cwdBase === "_pm") {
      pmIdFromCwd = cwdParentBase;
      const grandparent = basename(dirname(dirname(cwd)));
      if (grandparent !== "__garelier") {
        errLine(`Error: --mode ${o.mode} must run from a PM container (got: ${cwd}).`);
        process.exit(1);
      }
      projectRoot = dirname(dirname(dirname(cwd)));
    } else if (cwdBase === "pm" && cwdParentBase === "_crew") {
      pmIdFromCwd = basename(dirname(dirname(cwd)));
      if (basename(dirname(dirname(dirname(cwd)))) !== "__garelier") {
        errLine(`Error: --mode ${o.mode} must run from a PM container (got: ${cwd}).`);
        process.exit(1);
      }
      projectRoot = dirname(dirname(dirname(dirname(cwd))));
    } else {
      errLine(`Error: --mode ${o.mode} must run from __garelier/<pm_id>/_pm/ or _crew/pm/.`);
      errLine(`Current directory: ${cwd}`);
      process.exit(1);
    }
    if (o.pmId === "") {
      o.pmId = pmIdFromCwd;
    } else if (o.pmId !== pmIdFromCwd) {
      errLine(`Error: --pm-id (${o.pmId}) does not match cwd PM (${pmIdFromCwd}).`);
      process.exit(1);
    }
  }

  if (o.targetRoot === "" && o.mode === "diff" && existsSync(`${projectRoot}/container.lock.toml`)) {
    o.targetRoot = "target";
  }

  const { skillsDir, driverDir } = resolveGarelierDirs();

  // === Teardown (W-050) — exits before GIT_ROOT resolution + tool setup. ===
  if (o.mode === "teardown") {
    return runTeardown({ projectRoot, pmId: o.pmId, skillsDir, driverDir });
  }

  // === Shared pre-mode setup (sh 544 cd, 606-614 GIT_ROOT, 620 NOW, 1031 tools) ===
  // The bash cd's into PROJECT_ROOT before the mode bodies; the ported fresh/
  // migrate/diff use cwd-relative __garelier/ paths, so match that here.
  process.chdir(projectRoot);
  let gitRoot: string;
  if (o.targetRoot !== "") {
    gitRoot = /^\//.test(o.targetRoot) || /^[A-Za-z]:[/\\]/.test(o.targetRoot)
      ? o.targetRoot
      : `${projectRoot}/${o.targetRoot}`;
    gitRoot = gitRoot.replace(/\\/g, "/");
  } else {
    gitRoot = projectRoot;
  }
  const now = nowIso();
  const coreTemplatesDir = process.env.GARELIER_CORE_TEMPLATES_DIR ?? `${skillsDir}/garelier-core/templates`;

  maybeSetupGarelierTools({
    mode: o.mode,
    pmId: o.pmId,
    guardians: o.guardians,
    guardiansSet: o.guardiansSet,
    driverDir,
  });

  if (o.mode === "fresh") {
    return runFresh({
      projectRoot,
      gitRoot,
      now,
      dirs: { skillsDir, driverDir },
      coreTemplatesDir,
      pmId: o.pmId,
      projectName: o.projectName,
      target: o.target,
      workers: o.workers,
      scouts: o.scouts,
      smiths: o.smiths,
      librarians: o.librarians,
      observers: o.observers,
      guardians: o.guardians,
      concierges: o.concierges,
      artisanSpec: o.artisanSpec,
      scoutIdleTask: o.scoutIdleTask,
      defaultLane: o.defaultLane,
      skipConfirm: o.skipConfirm,
      stack: o.stack,
      qgCmds: o.qgCmds,
      permissionProfile: o.permissionProfile,
      agentsPolicy: o.agentsPolicy,
      wsExile: o.wsExile,
    });
  }

  if (o.mode === "migrate") {
    return runMigrate({
      projectRoot,
      gitRoot,
      now,
      dirs: { skillsDir, driverDir },
      coreTemplatesDir,
      pmId: o.pmId,
      skipConfirm: o.skipConfirm,
      wsExile: o.wsExile,
      garelierHome: process.env.GARELIER_HOME ?? "",
    });
  }

  // diff mode.
  return runDiff({
    projectRoot,
    gitRoot,
    now,
    dirs: { skillsDir, driverDir },
    coreTemplatesDir,
    pmId: o.pmId,
    target: o.target,
    workers: o.workers,
    scouts: o.scouts,
    smiths: o.smiths,
    smithsSet: o.smithsSet,
    librarians: o.librarians,
    librariansSet: o.librariansSet,
    observers: o.observers,
    observersSet: o.observersSet,
    guardians: o.guardians,
    guardiansSet: o.guardiansSet,
    concierges: o.concierges,
    conciergesSet: o.conciergesSet,
    artisanSet: o.artisanSet,
    artisanEnable: o.artisanEnable,
    artisanDisable: o.artisanDisable,
    artisanSpec: o.artisanSpec,
    skipConfirm: o.skipConfirm,
    allowRequeuedRemoval: o.allowRequeuedRemoval,
    wsExile: o.wsExile,
    garelierHome: process.env.GARELIER_HOME ?? "",
  });
}

process.exit(main(process.argv.slice(2)));
