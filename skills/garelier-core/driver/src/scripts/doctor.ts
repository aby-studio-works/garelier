// Garelier Doctor (ts-first port, W-083) — health check for one PM's install.
//
// Read-only inspection. Detects setup breakage, placeholder leakage, dangerous
// configuration, and Guardian-report secret leakage (G-14) BEFORE dispatch runs
// work. Never mutates state (never deletes lane.lock, pid files, or anything
// else).
//
// This is a bit-exact port of scripts/doctor.sh: the .sh is now a 4-line exec
// shim, and this file is the sole logic. Findings, ordering, stdout/stderr text,
// and exit codes are frozen to the shell version (CLI parity is contractual —
// W-083). See doctor/parsers.ts for why the ad-hoc TOML parsing is kept rather
// than routed through config.ts.
//
// Findings are grouped by severity:
//   P0  blocking   — must be fixed before dispatching work
//   P1  warning    — likely wrong / stale; start proceeds
//   P2  advisory   — informational
//
// Exit code: 1 if any P0 finding exists; 0 otherwise (P1/P2 only warn).

import * as fs from "node:fs";
import { pidAlive } from "./_lib.ts";
import { crewSubdirFromPmRoot } from "../workspace.ts";
import {
  readToml,
  tomlSectionPresent,
  tomlArrayBody,
  tomlArrayCount,
  listAgentIds,
  agentWorktreeForId,
  agentCheckoutForId,
  wsPointerKeyD,
  workspacePointerValue,
  pidFromContent,
  jsonStringField,
  crustContainerPaths,
  riskyProviderInTable,
} from "./doctor/parsers.ts";

// Expected repo version. Bump this per release (canonical copy: VERSION).
const EXPECTED_VERSION = "2.13.0";

// POSIX-style path helpers. The shell builds every path by string concatenation
// with `/` (PROJECT_ROOT is taken verbatim from argv / `pwd -P`, never
// re-normalized), so paths embedded in findings/errors use forward slashes.
// node's fs accepts forward slashes on Windows, so these drive file ops too.
// Using node:path would emit backslashes on win32 and break CLI parity.
function pj(...parts: string[]): string {
  return parts.join("/");
}
function pdir(p: string): string {
  const q = p.replace(/\/+$/, "");
  const i = q.lastIndexOf("/");
  if (i < 0) return q;
  if (i === 0) return "/";
  return q.slice(0, i);
}
function pbase(p: string): string {
  const q = p.replace(/\/+$/, "");
  const i = q.lastIndexOf("/");
  return i < 0 ? q : q.slice(i + 1);
}

// ---------------------------------------------------------------------------
// small filesystem / process effect helpers (faithful to the shell test ops)
// ---------------------------------------------------------------------------
function readText(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function statOf(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}
function isFile(p: string): boolean {
  return statOf(p)?.isFile() ?? false;
}
function isDir(p: string): boolean {
  return statOf(p)?.isDirectory() ?? false;
}
function pathExists(p: string): boolean {
  return statOf(p) !== undefined; // `[ -e ]` (follows symlinks; broken link -> false)
}
function listDirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
function realpath(p: string): string {
  // `pwd -P` yields forward slashes under MSYS; normalize so downstream path
  // string-building and comparisons stay POSIX-style.
  try {
    return fs.realpathSync(p).replace(/\\/g, "/");
  } catch {
    return p.replace(/\\/g, "/");
  }
}
function git(dir: string, args: string[]): { code: number; stdout: string } {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "ignore" });
  return { code: r.exitCode, stdout: r.stdout.toString() };
}
function gitOk(dir: string, args: string[]): boolean {
  return git(dir, args).code === 0;
}
function commandExists(bin: string): boolean {
  return Bun.which(bin) !== null;
}

// stdout / stderr accumulate through console; exit via process.exit (mirrors set -e).
function die(msgLines: string[]): never {
  for (const l of msgLines) console.error(l);
  process.exit(1);
}

const USAGE = `Usage: doctor.sh [--pm-id <id>] [--project <path>] [<pm_id>]

Options:
  --pm-id <id>       PM identifier to inspect. Required when more than one
                     PM exists under __garelier/ (unless $GARELIER_PM_ID
                     is set or cwd is inside a PM dir).
  --project <path>   Project root (default: current working directory).
  --container <id>   Plant-Crust container id when --project points at a
                     workfolder with crust.toml.
  -h, --help         Show this help.

Exit code is 1 if any P0 (blocking) finding exists, else 0.`;

function main(): void {
  const argv = process.argv.slice(2);

  let PROJECT_ROOT = "";
  let PM_ID = "";
  let CONTAINER_ID = "";

  // --- arg parse (mirrors the shell case/shift loop) ---
  let i = 0;
  const needValue = (flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v === "") die([`doctor.sh: ${flag}: missing value`]);
    return v as string;
  };
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--pm-id") {
      PM_ID = needValue("--pm-id");
      i += 2;
    } else if (a === "--project") {
      PROJECT_ROOT = needValue("--project");
      i += 2;
    } else if (a === "--container") {
      CONTAINER_ID = needValue("--container");
      i += 2;
    } else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (a === "--") {
      i += 1;
      break;
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      console.error(USAGE);
      process.exit(1);
    } else {
      if (PM_ID === "") PM_ID = a;
      else if (PROJECT_ROOT === "") PROJECT_ROOT = a;
      else {
        console.error(`Unexpected positional argument: ${a}`);
        process.exit(1);
      }
      i += 1;
    }
  }

  if (PROJECT_ROOT === "") PROJECT_ROOT = realpath(process.cwd());

  // --- Plant-Crust helpers ---
  const findCrustUp = (start: string): string => {
    let cur = start;
    while (cur !== "/" && cur !== "" && !/^[A-Za-z]:[\\/]?$/.test(cur)) {
      if (isFile(pj(cur, "crust.toml"))) return `${cur}/crust.toml`;
      const parent = pdir(cur);
      if (parent === cur) break;
      cur = parent;
    }
    // also test the drive-root itself once (mirrors while stopping at root)
    if (isFile(pj(cur, "crust.toml"))) return `${cur}/crust.toml`;
    return "";
  };

  // Walk up if cwd is inside __garelier/<pm_id>/... (mirror status.sh).
  if (!isDir(pj(PROJECT_ROOT, "__garelier"))) {
    let cur = PROJECT_ROOT;
    while (cur !== "/" && cur !== "") {
      const parent = pdir(cur);
      if (isDir(pj(parent, "__garelier"))) {
        PROJECT_ROOT = parent;
        break;
      }
      if (parent === cur) break;
      cur = parent;
    }
  }

  if (!isDir(pj(PROJECT_ROOT, "__garelier"))) {
    const startAbs = realpath(PROJECT_ROOT);
    const crustForSelection = findCrustUp(startAbs);
    if (crustForSelection !== "") {
      const workfolderRoot = pdir(crustForSelection);
      const containerRows = crustContainerPaths(readText(crustForSelection));
      let selectedPath = "";
      if (CONTAINER_ID !== "") {
        const row = containerRows.find((r) => r.id === CONTAINER_ID);
        if (!row) {
          console.error(
            `Error: Plant-Crust container '${CONTAINER_ID}' not found in ${crustForSelection}.`,
          );
          for (const r of containerRows) console.error(`         - ${r.id} (${r.path})`);
          process.exit(1);
        }
        selectedPath = row.path;
      } else {
        for (const r of containerRows) {
          if (r.id === "") continue;
          const cabs = realpath(pj(workfolderRoot, r.path));
          if (`${startAbs}/` === `${cabs}/` || `${startAbs}/`.startsWith(`${cabs}/`)) {
            selectedPath = r.path;
            CONTAINER_ID = r.id;
            break;
          }
        }
        if (selectedPath === "") {
          const nonEmpty = containerRows.filter((r) => r.id !== "" || r.path !== "");
          if (nonEmpty.length === 1) {
            selectedPath = nonEmpty[0].path;
            CONTAINER_ID = nonEmpty[0].id;
          } else {
            console.error(`Error: Plant-Crust workfolder detected at ${workfolderRoot}.`);
            console.error("       Pass --container <id> or run doctor from inside one container.");
            for (const r of containerRows) console.error(`         - ${r.id} (${r.path})`);
            process.exit(1);
          }
        }
      }
      PROJECT_ROOT = `${workfolderRoot}/${selectedPath}`;
    }
  }

  const GARELIER_ROOT = pj(PROJECT_ROOT, "__garelier");

  if (!isDir(GARELIER_ROOT)) {
    die([
      `Error: not a Garelier project root: ${PROJECT_ROOT}`,
      "       (no __garelier/ found here or in any parent)",
      "       Pass --project <path> explicitly.",
    ]);
  }

  // pm_id resolution: env var, then cwd inference, then single-PM autodetect.
  if (PM_ID === "") PM_ID = process.env.GARELIER_PM_ID ?? "";
  if (PM_ID === "") {
    const cwd = realpath(process.cwd());
    const grForward = GARELIER_ROOT.replace(/\\/g, "/");
    const cwdForward = cwd.replace(/\\/g, "/");
    if (`${cwdForward}/`.startsWith(`${grForward}/`)) {
      const rel = cwdForward.slice(grForward.length + 1);
      PM_ID = rel.split("/")[0];
    }
  }
  if (PM_ID === "") {
    const candidates: string[] = [];
    for (const name of listDirs(GARELIER_ROOT)) {
      if (isFile(pj(GARELIER_ROOT, name, "_pm", "setup_config.toml"))) candidates.push(name);
    }
    if (candidates.length === 0) {
      die([`Error: No Garelier PM initialized under ${GARELIER_ROOT}; run setup_wizard.`]);
    } else if (candidates.length === 1) {
      PM_ID = candidates[0];
    } else {
      const lines = [`Error: multiple PMs found under ${GARELIER_ROOT} — pass --pm-id <id>.`];
      for (const p of candidates) lines.push(`         - ${p}`);
      die(lines);
    }
  }

  const PM_ROOT = pj(GARELIER_ROOT, PM_ID);
  // Layout v2 (DEC-094) moved the PM directory under _crew/. Keep the legacy
  // flat path readable for existing and partially migrated installs.
  const PM_DIR = crewSubdirFromPmRoot(PM_ROOT, "_pm");
  const CONFIG = pj(PM_DIR, "setup_config.toml");
  let TARGET_PROJECT_ROOT = PROJECT_ROOT;
  let PLANT_MODE = "lithosphere";
  let CRUST_PATH = "";
  const CONTAINER_LOCK = pj(PROJECT_ROOT, "container.lock.toml");
  {
    let cur = PROJECT_ROOT;
    while (cur !== "/" && cur !== "") {
      if (isFile(pj(cur, "crust.toml"))) {
        CRUST_PATH = `${cur}/crust.toml`;
        break;
      }
      const parent = pdir(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  if (CRUST_PATH !== "") {
    PLANT_MODE = "crust";
    TARGET_PROJECT_ROOT = pj(PROJECT_ROOT, "target");
  }
  const AGENTS_FILE = pj(TARGET_PROJECT_ROOT, "AGENTS.md");

  if (!isFile(CONFIG)) {
    die([`Error: PM '${PM_ID}' not found: ${CONFIG} missing.`]);
  }

  const CONFIG_TEXT = readText(CONFIG);

  // === Findings accumulator ===
  const P0: string[] = [];
  const P1: string[] = [];
  const P2: string[] = [];
  const add = (sev: "P0" | "P1" | "P2", check: string, detail: string, fix: string): void => {
    const line = `[${sev}] ${check}: ${detail} — fix: ${fix}`;
    if (sev === "P0") P0.push(line);
    else if (sev === "P1") P1.push(line);
    else P2.push(line);
  };

  const rt = (section: string, key: string): string => readToml(CONFIG_TEXT, section, key);

  // Plant paths (resolved relative to this script, env-overridable).
  const DRIVER_SRC = pdir(import.meta.dir.replace(/\\/g, "/")); // .../driver/src
  const PLANT_TS = process.env.GARELIER_PLANT_TS ?? `${DRIVER_SRC}/plant.ts`;
  const LENS_TS = `${DRIVER_SRC}/lenses.ts`;

  // --- 0. Plant-Crust shape (P0/P1) ---
  if (PLANT_MODE === "crust") {
    if (!isFile(CONTAINER_LOCK)) {
      add(
        "P0",
        "plant-crust-lock",
        `crust.toml found at ${CRUST_PATH} but container.lock.toml is missing at ${CONTAINER_LOCK}`,
        "run garelier crust-init for this container, or regenerate container.lock.toml from crust.toml before dispatch",
      );
    } else {
      const r = Bun.spawnSync(
        ["bun", PLANT_TS, "validate-lock", "--crust", CRUST_PATH, "--lock", CONTAINER_LOCK],
        { stderr: "pipe", stdout: "pipe" },
      );
      if (r.exitCode !== 0) {
        const combined = r.stdout.toString() + r.stderr.toString();
        const detail = combined
          .split("\n")
          .slice(0, 5)
          .join(";")
          .replace(/;*$/, "");
        add(
          "P0",
          "plant-crust-lock-invalid",
          `container.lock.toml failed validation: ${detail}`,
          "repair the lock with garelier crust-init --repair-lock or regenerate the container",
        );
      }
    }
    if (!isDir(TARGET_PROJECT_ROOT)) {
      add(
        "P0",
        "plant-crust-target",
        `Plant-Crust target_root does not exist: ${TARGET_PROJECT_ROOT}`,
        "clone the target repository into the container target/ path, or rerun garelier crust-init with --target-remote; do not run setup inside target/",
      );
    } else if (!gitOk(TARGET_PROJECT_ROOT, ["rev-parse", "--is-inside-work-tree"])) {
      add(
        "P0",
        "plant-crust-target-git",
        `Plant-Crust target_root is not a git worktree: ${TARGET_PROJECT_ROOT}`,
        "clone the target repository into target/, or explicitly initialize it with garelier crust-init --target-init; do not run setup_wizard inside target/",
      );
    }
    if (pathExists(pj(TARGET_PROJECT_ROOT, "__garelier"))) {
      add(
        "P0",
        "plant-crust-target-garelier",
        `Plant-Crust forbids target_root/__garelier: ${TARGET_PROJECT_ROOT}/__garelier`,
        "move Garelier control back to container_root/__garelier and keep target/ free of Garelier control files",
      );
    }
    const workfolderRoot = pdir(CRUST_PATH);
    const workfolderGitignore = pj(workfolderRoot, ".gitignore");
    if (!isFile(workfolderGitignore)) {
      add(
        "P1",
        "plant-crust-workfolder-gitignore",
        `Plant-Crust workfolder has no .gitignore: ${workfolderGitignore}`,
        "copy skills/garelier-core/templates/plant_crust_gitignore to the workfolder .gitignore or add equivalent rules so */target/ is never tracked",
      );
    } else if (!readText(workfolderGitignore).includes("*/target/")) {
      add(
        "P1",
        "plant-crust-workfolder-gitignore",
        `Plant-Crust workfolder .gitignore may not ignore target clones: ${workfolderGitignore}`,
        "add the plant_crust_gitignore rules, especially */target/ and */target/**",
      );
    }
  }

  // --- 1. Placeholder leakage (P0) ---
  const placeholderSample = (text: string): string => {
    const all = text.match(/\{\{[^}]*\}\}/g) ?? [];
    const uniq = [...new Set(all)].sort();
    return uniq.slice(0, 3).join("\n").replace(/\n/g, " ") + (uniq.length > 0 ? " " : "");
  };
  if (CONFIG_TEXT.includes("{{")) {
    add(
      "P0",
      "placeholder-leak",
      `unresolved {{...}} marker in setup_config.toml (${placeholderSample(CONFIG_TEXT)})`,
      "re-run setup_wizard to substitute placeholders",
    );
  }
  if (!isFile(AGENTS_FILE)) {
    add(
      "P0",
      "agents-missing",
      `AGENTS.md not found at project root (${AGENTS_FILE})`,
      "every role reads AGENTS.md for project-specific rules; create it (re-run setup_wizard from __garelier/ with GARELIER_CORE_TEMPLATES_DIR set, or copy skills/garelier-core/templates/agents.md and fill it in)",
    );
  } else {
    const agentsText = readText(AGENTS_FILE);
    if (agentsText.includes("{{")) {
      add(
        "P0",
        "placeholder-leak",
        `unresolved {{...}} marker in AGENTS.md (${placeholderSample(agentsText)})`,
        "edit AGENTS.md and fill the remaining project-specific fields (restricted files, conventions); re-running setup_wizard will NOT fill these (it skips an existing AGENTS.md)",
      );
    }
  }

  // --- 2/3. Quality gate (P0) + stack/rust-default mismatch (P1) ---
  const qg_stack = rt("quality_gate", "stack");
  const qg_cmd_count = tomlArrayCount(CONFIG_TEXT, "quality_gate", "commands");
  const qg_body = tomlArrayBody(CONFIG_TEXT, "quality_gate", "commands");
  const qg_full_cmd_count = tomlArrayCount(CONFIG_TEXT, "quality_gate.full", "commands");
  const qg_full_body = tomlArrayBody(CONFIG_TEXT, "quality_gate.full", "commands");
  let qg_effective_cmd_count = qg_cmd_count;
  let qg_effective_body = qg_body;
  if (qg_full_cmd_count > 0) {
    qg_effective_cmd_count = qg_full_cmd_count;
    qg_effective_body = qg_full_body;
  }
  const recognized_stack = ["rust", "typescript", "python", "go"].includes(qg_stack);

  if (!tomlSectionPresent(CONFIG_TEXT, "quality_gate")) {
    add(
      "P0",
      "quality-gate",
      "[quality_gate] section missing",
      "add [quality_gate] with stack or commands (see setup_config.toml template)",
    );
  } else if (qg_stack === "custom" && qg_effective_cmd_count === 0) {
    add(
      "P0",
      "quality-gate",
      'stack = "custom" but full commands list is empty',
      "fill in [quality_gate] commands or [quality_gate.full] commands (custom stack requires explicit full commands)",
    );
  } else if (qg_effective_cmd_count === 0 && !recognized_stack) {
    add(
      "P0",
      "quality-gate",
      `no commands and unrecognized stack '${qg_stack !== "" ? qg_stack : "<unset>"}'`,
      "set stack to rust/typescript/python/go, or list explicit full commands",
    );
  }

  if (qg_effective_cmd_count > 0 && qg_stack !== "") {
    let foreign: RegExp | undefined;
    switch (qg_stack) {
      case "rust":
        foreign = /"\s*(npm|pnpm|yarn|pytest|ruff)[ "]/;
        break;
      case "typescript":
        foreign = /"\s*(cargo|pytest|ruff)[ "]/;
        break;
      case "python":
        foreign = /"\s*(cargo|npm|pnpm|yarn)[ "]/;
        break;
      case "go":
        foreign = /"\s*(cargo|npm|pnpm|yarn|pytest|ruff)[ "]/;
        break;
    }
    if (foreign && foreign.test(qg_effective_body.join("\n"))) {
      add(
        "P1",
        "quality-gate-stale",
        `commands reference a tool from another stack but stack = "${qg_stack}"`,
        "replace the leftover default commands with ones for your declared stack",
      );
    }
  }

  // --- 4. Dangerous permission profile (P1) ---
  if (rt("permissions", "profile") === "dangerous") {
    add(
      "P1",
      "permissions-dangerous",
      '[permissions] profile = "dangerous" (full provider access)',
      "confirm this is a deliberate isolated autonomous run; else use reviewed/safe",
    );
  }

  // --- 5. Protected paths unset (P2) ---
  if (tomlSectionPresent(CONFIG_TEXT, "permissions")) {
    if (tomlArrayCount(CONFIG_TEXT, "permissions", "require_pm_approval_paths") === 0) {
      add(
        "P2",
        "protected-paths",
        "[permissions] require_pm_approval_paths is empty/absent",
        "list sensitive globs (.env*, infra/**, migrations/**, deploy/**) to gate PM approval",
      );
    }
  }

  // --- 5b. Jig mode configured (DEC-062 Phase 1) (P2) ---
  const jig_enabled = rt("jig", "enabled");
  if (jig_enabled === "false") {
    add(
      "P2",
      "jig-mode",
      "[jig] enabled = false — jig is DEFAULT-ON (DEC-062 amended 2026-06-11); this is an explicit opt-out",
      "the Mode D prose tick operates; remove the key (or set true) to run templates/jig_tick.workflow.js per tick",
    );
  }

  // --- 5c. Jig Smith-window knowledge dependency (DEC-069/071) ---
  const jig_smith_every = rt("jig", "smith_batch_every");
  const jsv_home = pj(PM_ROOT, "knowledge");
  const jsv_atmos = pj(PROJECT_ROOT, "__garelier", "__atmos", "knowledge");
  const jsv_rel = "quality/integration_hardening_views.md";
  if (
    jig_enabled !== "false" &&
    jig_smith_every !== "0" &&
    (isDir(jsv_home) || isDir(jsv_atmos)) &&
    !isFile(pj(jsv_home, jsv_rel)) &&
    !isFile(pj(jsv_atmos, jsv_rel))
  ) {
    add(
      "P1",
      "jig-smith-views-missing",
      "jig Smith window is active but knowledge quality/integration_hardening_views.md is not seeded — window batches run without the V1-V7 views",
      "seed it from garelier-librarian/templates/quality/integration_hardening_views.md (knowledge-sync Librarian dispatch), or set [jig] smith_batch_every = 0 to disable the window",
    );
  }

  // --- 6. Role container layout (P1 only when half-created) ---
  const CONFIGURED_DIRS = new Set<string>();

  // DEC-035 container resolution (pointer file may exile a container).
  const workspacePaths = readText(pj(PROJECT_ROOT, "__garelier", PM_ID, "runtime", "workspace_paths"));
  const resolveContainer = (role: string, id: string, wt: string): string => {
    const key = wsPointerKeyD(role, id);
    const v = workspacePointerValue(workspacePaths, key);
    if (v !== undefined && v !== "") return v;
    return `${PROJECT_ROOT}/${wt}`;
  };

  const resolvedRoleContainers = (role: string): string[] => {
    const out: string[] = [];
    for (const id of listAgentIds(CONFIG_TEXT, role)) {
      if (id === "") continue;
      let wt = agentWorktreeForId(CONFIG_TEXT, role, id);
      if (wt === "") wt = `__garelier/${PM_ID}/_${role}/${id}`;
      out.push(resolveContainer(role, id, wt));
    }
    return out;
  };

  const checkRoleTable = (table: string, roleDir: string): void => {
    for (const id of listAgentIds(CONFIG_TEXT, table)) {
      if (id === "") continue;
      let wt = agentWorktreeForId(CONFIG_TEXT, table, id);
      if (wt === "") wt = `__garelier/${PM_ID}/${roleDir}/${id}`;
      const abs = resolveContainer(table, id, wt);
      CONFIGURED_DIRS.add(`${pbase(wt)}@${roleDir}`);
      if (!isDir(abs)) {
        // dispatch-native default (DEC-065): seat declared, no container.
      } else if (!isDir(pj(abs, "checkout"))) {
        if (agentCheckoutForId(CONFIG_TEXT, table, id) !== "false") {
          add(
            "P1",
            "worktree-layout",
            `[[${table}]] id '${id}' container exists but has no checkout/ worktree: ${abs}`,
            "remove the leftover container, or recreate the seat home via diff mode (remove the seat, then re-add it)",
          );
        }
      }
    }
  };

  checkRoleTable("workers", "_workers");
  checkRoleTable("scouts", "_scouts");
  checkRoleTable("smiths", "_smiths");
  checkRoleTable("librarians", "_librarians");
  checkRoleTable("observers", "_observers");
  checkRoleTable("guardians", "_guardians");
  checkRoleTable("concierges", "_concierges");

  // Artisan (single [artisan] block, gated by enabled = true).
  if (rt("artisan", "enabled") === "true") {
    let artisan_wt = rt("artisan", "worktree");
    if (artisan_wt === "") artisan_wt = `__garelier/${PM_ID}/_artisan`;
    CONFIGURED_DIRS.add(`${pbase(artisan_wt)}@_artisan`);
    const artisan_abs = resolveContainer("artisan", "", artisan_wt);
    if (isDir(artisan_abs) && !isDir(pj(artisan_abs, "checkout"))) {
      add(
        "P1",
        "worktree-layout",
        `[artisan] container exists but has no checkout/ worktree: ${artisan_abs}`,
        "remove the leftover container, or recreate the seat home via diff mode (remove the seat, then re-add it)",
      );
    }
  }

  // Guardian policy enabled but no [[guardians]] defined (DEC-024).
  if (rt("guardian_policy", "enabled") === "true") {
    const guardian_n = listAgentIds(CONFIG_TEXT, "guardians").filter((x) => x !== "").length;
    if (guardian_n === 0) {
      add(
        "P0",
        "guardian-policy",
        "[guardian_policy] enabled = true but no [[guardians]] are defined — the security gate is mandatory with no Guardian to satisfy it",
        "add a [[guardians]] block, or set [guardian_policy].enabled = false",
      );
    }
  }

  // Concierge policy enabled but no [[concierges]] (DEC-025) + safety guards.
  if (rt("concierge_policy", "enabled") === "true") {
    const concierge_n = listAgentIds(CONFIG_TEXT, "concierges").filter((x) => x !== "").length;
    if (concierge_n === 0) {
      add(
        "P0",
        "concierge-policy",
        "[concierge_policy] enabled = true but no [[concierges]] are defined — external operations are enabled with no Concierge to run them",
        "add a [[concierges]] block, or set [concierge_policy].enabled = false",
      );
    }
    for (const cflag of [
      "require_pm_approval",
      "require_user_instruction_for_write",
      "require_guardian_before_external_write",
      "forbid_push_garelier_branches",
      "forbid_force_push",
      "forbid_blind_git_pull",
    ]) {
      if (rt("concierge_policy", cflag) === "false") {
        add(
          "P0",
          "concierge-safety",
          `[concierge_policy].${cflag} = false weakens an external-write safety guard`,
          `set [concierge_policy].${cflag} = true (it guards against unapproved / destructive external writes)`,
        );
      }
    }
    for (const ccontainer of resolvedRoleContainers("concierges")) {
      if (ccontainer === "") continue;
      const cdir = pj(ccontainer, "checkout");
      if (!pathExists(pj(cdir, ".git"))) continue;
      const hp = git(cdir, ["config", "--get", "core.hooksPath"]).stdout.replace(/\n+$/, "");
      if (hp === "" || !isFile(pj(hp, "pre-push"))) {
        const rel = cdir.startsWith(`${PROJECT_ROOT}/`) ? cdir.slice(PROJECT_ROOT.length + 1) : cdir;
        add(
          "P0",
          "concierge-push-guard",
          `Concierge worktree ${rel} has no mechanical push guard (core.hooksPath -> a dir with pre-push)`,
          `run garelier install-concierge-guards "${cdir}" (DEC-030); the Concierge does this at pickup`,
        );
      }
    }
  }

  // Provider permission verification on write roles (DEC-033).
  for (const sec of ["workers", "smiths", "concierges"]) {
    const rp = riskyProviderInTable(CONFIG_TEXT, sec);
    if (rp.replace(/ /g, "") !== "") {
      add(
        "P2",
        "provider-verify",
        `[[${sec}]] uses ${rp} on a write/external role; its permission flags (DEC-033) are wired but version-sensitive`,
        "verify the CLI works by running it once manually; if a flag is rejected, set GARELIER_PROVIDER_<KIND>_PERMISSION=off",
      );
    }
  }
  const sol_provider = rt("artisan", "provider");
  if (/gemini|cursor/i.test(sol_provider)) {
    add(
      "P2",
      "provider-verify",
      `[artisan] uses ${sol_provider} and integrates its own satchel into studio; its permission flags (DEC-033 / DEC-045) are version-sensitive`,
      "verify with the provider smoke before relying on it; GARELIER_PROVIDER_<KIND>_PERMISSION=off falls back if a flag is rejected",
    );
  }

  // Guardian report output safety (G-14, P0, DEC-024).
  const SECRET_RE =
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[posru]_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|sk-[A-Za-z0-9]{32,}/;
  const grepQ = (file: string, re: RegExp): boolean => {
    if (!isFile(file)) return false;
    return re.test(readText(file));
  };
  // Shell pathname expansion for the single-`*` globs used below: full-segment
  // ("<dir>/*/file", "<dir>/*") and suffix ("<dir>/*.md", "<dir>/*.lock").
  // Matches shell semantics: alphabetical sort, `*` never matches a leading dot,
  // and a non-matching glob yields [] (the shell's literal-pattern word fails the
  // subsequent `[ -f ]`, so the effect is identical).
  const expandGlob = (g: string): string[] => {
    const star = g.indexOf("*");
    if (star < 0) return pathExists(g) ? [g] : [];
    const before = g.slice(0, star);
    const after = g.slice(star + 1);
    const lastSlash = before.lastIndexOf("/");
    const baseDir = before.slice(0, lastSlash);
    const segPrefix = before.slice(lastSlash + 1);
    const nextSlash = after.indexOf("/");
    const segSuffix = nextSlash < 0 ? after : after.slice(0, nextSlash);
    const rest = nextSlash < 0 ? "" : after.slice(nextSlash);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const out: string[] = [];
    for (const e of entries) {
      const name = e.name;
      if (segPrefix === "" && name.startsWith(".")) continue; // `*` skips dotfiles
      if (!name.startsWith(segPrefix) || !name.endsWith(segSuffix)) continue;
      if (name.length < segPrefix.length + segSuffix.length) continue;
      const matched = `${baseDir}/${name}`;
      if (rest === "") {
        if (pathExists(matched)) out.push(matched);
      } else if (rest.includes("*")) {
        out.push(...expandGlob(`${matched}${rest}`));
      } else {
        const candidate = `${matched}${rest}`;
        if (pathExists(candidate)) out.push(candidate);
      }
    }
    return out;
  };
  const guardianGlobs = [
    `${PM_ROOT}/_guardians/*/guardian_report.md`,
    `${PM_ROOT}/_guardians/*/checkout/guardian_report.md`,
    `${PM_ROOT}/runtime/guardian/results/*`,
    `${PM_ROOT}/runtime/guardian/inbox/*`,
  ];
  const relToProject = (p: string): string =>
    p.startsWith(`${PROJECT_ROOT}/`) ? p.slice(PROJECT_ROOT.length + 1) : p;
  for (const g of guardianGlobs) {
    for (const gfile of expandGlob(g)) {
      if (!isFile(gfile)) continue;
      if (grepQ(gfile, SECRET_RE)) {
        add(
          "P0",
          "guardian-report-leak",
          `Guardian report appears to contain an unredacted secret-like value: ${relToProject(gfile)}`,
          "redact to pointer-only per the report's REDACTION RULE; if the value is real, rotate it immediately",
        );
      }
    }
  }
  for (const gc of resolvedRoleContainers("guardians")) {
    if (gc === "") continue;
    for (const gfile of [`${gc}/guardian_report.md`, `${gc}/checkout/guardian_report.md`]) {
      if (!isFile(gfile)) continue;
      if (grepQ(gfile, SECRET_RE)) {
        add(
          "P0",
          "guardian-report-leak",
          `Guardian report appears to contain an unredacted secret-like value: ${gfile}`,
          "redact to pointer-only per the report's REDACTION RULE; if the value is real, rotate it immediately",
        );
      }
    }
  }

  // Concierge report output safety (P0, DEC-025).
  const conciergeGlobs = [
    `${PM_ROOT}/_concierges/*/concierge_report.md`,
    `${PM_ROOT}/_concierges/*/checkout/concierge_report.md`,
    `${PM_ROOT}/runtime/concierge/results/*`,
    `${PM_ROOT}/runtime/concierge/inbox/*`,
  ];
  for (const g of conciergeGlobs) {
    for (const cfile of expandGlob(g)) {
      if (!isFile(cfile)) continue;
      if (grepQ(cfile, SECRET_RE)) {
        add(
          "P0",
          "concierge-report-leak",
          `Concierge report appears to contain an unredacted secret-like value: ${relToProject(cfile)}`,
          "redact to pointer-only per the report's redaction rule; if the value is real, rotate it immediately",
        );
      }
    }
  }
  for (const cc of resolvedRoleContainers("concierges")) {
    if (cc === "") continue;
    for (const cfile of [`${cc}/concierge_report.md`, `${cc}/checkout/concierge_report.md`]) {
      if (!isFile(cfile)) continue;
      if (grepQ(cfile, SECRET_RE)) {
        add(
          "P0",
          "concierge-report-leak",
          `Concierge report appears to contain an unredacted secret-like value: ${cfile}`,
          "redact to pointer-only per the report's redaction rule; if the value is real, rotate it immediately",
        );
      }
    }
  }

  // Stray on-disk role dirs without a config entry.
  for (const roleDir of [
    "_workers",
    "_scouts",
    "_smiths",
    "_librarians",
    "_observers",
    "_guardians",
    "_concierges",
  ]) {
    const base = pj(PM_ROOT, roleDir);
    if (!isDir(base)) continue;
    for (const name of listDirs(base)) {
      if (!CONFIGURED_DIRS.has(`${name}@${roleDir}`)) {
        add(
          "P1",
          "stray-worktree",
          `${roleDir}/${name} exists on disk but has no config entry`,
          "add a config block for '" + name + "', or remove the stale worktree (git worktree remove)",
        );
      }
    }
  }

  // --- 7. Stale lane.lock (P1) ---
  const LANE_LOCK = pj(PM_ROOT, "runtime", "lane.lock");
  if (isFile(LANE_LOCK)) {
    const laneText = readText(LANE_LOCK);
    const lane_pid = pidFromContent(laneText);
    const lane_owner = jsonStringField(laneText, "owner");
    if (lane_pid !== "" && !pidAlive(lane_pid)) {
      add(
        "P1",
        "stale-lane-lock",
        `lane.lock owner '${lane_owner !== "" ? lane_owner : "?"}' pid ${lane_pid} is not alive`,
        "verify no role is mid-lane, then clear lane.lock via PM (doctor never deletes it)",
      );
    }
  }

  // --- 7b. Stale Concierge external lock (P1, DEC-025) ---
  const EXTERNAL_LOCK_DIR = pj(PM_ROOT, "runtime", "concierge", "locks");
  if (isDir(EXTERNAL_LOCK_DIR)) {
    for (const lk of expandGlob(`${EXTERNAL_LOCK_DIR}/*.lock`)) {
      if (!isFile(lk)) continue;
      const lkText = readText(lk);
      const ext_pid = pidFromContent(lkText);
      const ext_op = jsonStringField(lkText, "operation_kind");
      const ext_req = jsonStringField(lkText, "request_id");
      if (ext_pid !== "" && !pidAlive(ext_pid)) {
        add(
          "P1",
          "stale-external-lock",
          `concierge lock ${pbase(lk)} (${ext_req !== "" ? ext_req : "?"}, ${ext_op !== "" ? ext_op : "?"}) pid ${ext_pid} is not alive`,
          "a Concierge crashed holding the lock; on pickup it reconciles (SKILL §10.5) — verify the external operation's actual state before clearing",
        );
      }
    }
  }

  // --- 7c. Provider CLI availability (P1, DEC-026) ---
  if (isFile(CONFIG)) {
    // used_providers = grep -v '^#' | grep -oE 'provider="..."' | grep -oE '"..."' | tr -d '"' | sort -u
    // Under `set -o pipefail`, a config with ZERO provider lines makes the
    // middle grep exit 1 -> the whole script exits 1 here (no report). Faithful.
    const nonComment = toLinesLocal(CONFIG_TEXT).filter((l) => !/^\s*#/.test(l));
    const providerMatches: string[] = [];
    for (const l of nonComment) {
      const m = l.match(/provider\s*=\s*"[a-z-]+"/g);
      if (m) providerMatches.push(...m);
    }
    if (providerMatches.length === 0) {
      process.exit(1); // pipefail/set -e early exit (bit-exact with the shell)
    }
    const used_providers = [
      ...new Set(
        providerMatches.map((s) => {
          const q = s.match(/"[a-z-]+"/);
          return q ? q[0].replace(/"/g, "") : "";
        }),
      ),
    ].sort();
    for (const p of used_providers) {
      let pbin = "";
      switch (p) {
        case "claude-code": pbin = "claude"; break;
        case "codex-cli": pbin = "codex"; break;
        case "gemini-cli": pbin = "gemini"; break;
        case "copilot-cli": pbin = "copilot"; break;
        case "cursor-cli": pbin = "cursor-agent"; break;
        default: continue;
      }
      const envkey = `GARELIER_PROVIDER_${p.replace(/[a-z-]/g, (c) => (c === "-" ? "_" : c.toUpperCase()))}_CMD`;
      if ((process.env[envkey] ?? "") !== "") continue;
      let avail = false;
      if (p === "cursor-cli") {
        avail = commandExists("cursor-agent") || commandExists("cursor");
      } else if (commandExists(pbin)) {
        avail = true;
      }
      if (!avail) {
        add(
          "P1",
          "provider-unavailable",
          `provider '${p}' is configured but its CLI ('${pbin}') is not on PATH`,
          `install the ${p} CLI, set ${envkey} / a per-agent provider_command, or remove agents using it`,
        );
      }
    }
  }

  // --- 7d. Stale next_id id-claim lock (P1) ---
  const NEXT_ID_LOCK = pj(PM_ROOT, "runtime", "backlog", "next_id.lock");
  if (isDir(NEXT_ID_LOCK)) {
    const ownerText = readText(pj(NEXT_ID_LOCK, "owner"));
    const nid_pid = pidFromContent(ownerText);
    const nid_ts = jsonStringField(ownerText, "ts");
    if (nid_pid === "") {
      add(
        "P1",
        "stale-next-id-lock",
        "next_id.lock exists with no readable owner marker (pre-marker or crashed mid-claim)",
        `if no dispatch is in flight, recover with: rm -rf "${NEXT_ID_LOCK}" (doctor never deletes it)`,
      );
    } else if (!pidAlive(nid_pid)) {
      add(
        "P1",
        "stale-next-id-lock",
        `next_id.lock owner pid ${nid_pid} (claimed ${nid_ts !== "" ? nid_ts : "?"}) is not alive — an id claim was interrupted`,
        `no live dispatch holds it; recover with: rm -rf "${NEXT_ID_LOCK}" (doctor never deletes it)`,
      );
    }
  }

  // --- 9. Version mismatch (P2) ---
  const cfg_version = rt("project", "garelier_version");
  if (cfg_version !== "" && cfg_version !== EXPECTED_VERSION) {
    add(
      "P2",
      "version-mismatch",
      `setup_config.toml garelier_version = ${cfg_version}, expected ${EXPECTED_VERSION}`,
      "re-run setup_wizard (migrate mode) to align with the installed framework version",
    );
  }

  // --- 9b. Concurrency cap (DEC-027) ---
  if (tomlSectionPresent(CONFIG_TEXT, "concurrency")) {
    const cc_max = rt("concurrency", "max_concurrent_agents");
    if (cc_max === "0") {
      add(
        "P2",
        "concurrency-unbounded",
        "[concurrency] max_concurrent_agents = 0 (cap disabled): all detached agents may run at once",
        "set a bound (e.g. 4) if running many roles on a memory-constrained machine",
      );
    } else if (/^-/.test(cc_max)) {
      add(
        "P1",
        "concurrency-invalid",
        `[concurrency] max_concurrent_agents = ${cc_max} is negative; tooling clamps it to 0 (unbounded)`,
        "set max_concurrent_agents to a non-negative integer (0 disables the cap)",
      );
    }
  }

  // --- 9c. Output control (DEC-028) ---
  if (tomlSectionPresent(CONFIG_TEXT, "output_control")) {
    const oc_default = rt("output_control", "default_profile");
    if (oc_default !== "" && !/^(normal|compact|micro)$/.test(oc_default)) {
      add(
        "P0",
        "output-control-profile",
        `[output_control] default_profile = "${oc_default}" is not normal/compact/micro`,
        "set default_profile to normal, compact, or micro",
      );
    }
    const oc_viol = rt("output_control", "violation_mode");
    if (oc_viol !== "" && !/^(warn|fail)$/.test(oc_viol)) {
      add(
        "P0",
        "output-control-violation-mode",
        `[output_control] violation_mode = "${oc_viol}" must be warn or fail`,
        'set violation_mode = "warn" (default) or "fail" (experimental)',
      );
    } else if (oc_viol === "fail") {
      add(
        "P1",
        "output-control-violation-fail",
        '[output_control] violation_mode = "fail" is experimental: a role writing a long but legitimate warning could be failed',
        "prefer violation_mode = \"warn\" until fail-mode has been validated for your roster",
      );
    }
    const oc_logmax = rt("output_control", "driver_log_max_bytes");
    if (oc_logmax !== "" && /^[0-9]+$/.test(oc_logmax) && Number(oc_logmax) < 1048576) {
      add(
        "P0",
        "output-control-log-rotation",
        `[output_control] driver_log_max_bytes = ${oc_logmax} is below 1MB; logs would rotate constantly`,
        "set driver_log_max_bytes to at least 1048576 (1MB)",
      );
    }
    for (const prof of ["normal", "compact", "micro"]) {
      const soft = rt(`output_control.profiles.${prof}`, "soft_result_chars");
      if (soft !== "" && /^[0-9]+$/.test(soft) && Number(soft) < 200) {
        add(
          "P0",
          "output-control-soft-chars",
          `[output_control.profiles.${prof}] soft_result_chars = ${soft} is below 200 (too terse to be safe)`,
          "raise soft_result_chars to at least 200",
        );
      }
    }
    for (const role of ["guardian", "concierge"]) {
      if (rt("output_control.roles", role) === "micro") {
        add(
          "P1",
          "output-control-safety-micro",
          `[output_control.roles] ${role} = "micro" can pressure warnings / approvals / responsibility boundaries short`,
          `keep ${role} at "normal" (or "compact"); safety-critical roles should not be micro`,
        );
      }
    }
    if (rt("output_control", "enabled") === "false") {
      add(
        "P2",
        "output-control-disabled",
        "[output_control] enabled = false: provider final responses and tool logs are not bounded",
        "leave enabled = true unless you are deliberately debugging full output",
      );
    }
    if (rt("output_control", "usage_summary") === "false") {
      add(
        "P2",
        "output-control-no-usage",
        "[output_control] usage_summary = false: token / output / over-budget trends are not recorded",
        "set usage_summary = true to track which roles bloat output over time",
      );
    }
  }

  // --- 9d. Librarian role knowledge trees (DEC-029 / DEC-077) ---
  const KHOME = pj(PM_ROOT, "knowledge");
  const KATMOS = pj(PROJECT_ROOT, "__garelier", "__atmos", "knowledge");
  const kExists = (rel: string): boolean => pathExists(pj(KHOME, rel)) || pathExists(pj(KATMOS, rel));
  if (!kExists("knowledge.toml") && !isDir(KHOME) && !isDir(KATMOS)) {
    add(
      "P1",
      "knowledge-tree-absent",
      `${KHOME}/ is absent — role knowledge + status-web Knowledge/Source/Routine panels are empty`,
      `run setup_wizard to seed ${KHOME}/ (DEC-077)`,
    );
  }
  for (const ktree of ["security", "engineering", "quality", "review", "system"]) {
    if (kExists(ktree)) {
      if (!kExists(`${ktree}/index.md`)) {
        add(
          "P1",
          "knowledge-tree-index",
          `knowledge tree '${ktree}/' exists but index.md is missing`,
          `restore ${ktree}/index.md (re-run setup_wizard, or copy from garelier-librarian/templates/${ktree}/index.md)`,
        );
      }
    } else if (isDir(KHOME) || isDir(KATMOS)) {
      add(
        "P2",
        "knowledge-tree-missing",
        `knowledge tree '${ktree}/' is not seeded`,
        `run setup_wizard (it seeds Librarian role knowledge trees), or seed from garelier-librarian/templates/${ktree}/`,
      );
    }
  }

  // --- 9e. role_index closure (DEC-071 follow-up) ---
  for (const RIDX of [pj(KHOME, "role_index.toml"), pj(KATMOS, "role_index.toml")]) {
    if (!isFile(RIDX)) continue;
    const refs = [
      ...new Set(
        (readText(RIDX).match(/"[A-Za-z0-9_/.-]+\.md"/g) ?? [])
          .map((s) => s.replace(/"/g, ""))
          .map((s) => s.replace(/^__garelier\/[^/]+\/knowledge\//, "")),
      ),
    ].sort();
    let ri_missing = "";
    for (const ref of refs) {
      if (!kExists(ref)) ri_missing += ` ${ref}`;
    }
    if (ri_missing !== "") {
      add(
        "P1",
        "role-index-dangling",
        `role_index.toml names knowledge docs that do not exist:${ri_missing}`,
        "seed them from garelier-librarian/templates/ (knowledge-sync Librarian dispatch), or remove the stale entries",
      );
    }
  }

  // --- 9f. Lens registry (DEC-086) ---
  const LENS_REGISTRY = pj(PROJECT_ROOT, "__garelier", "__atmos", "lens_registry.toml");
  if (isFile(LENS_REGISTRY)) {
    if (commandExists("bun") && isFile(LENS_TS)) {
      const r = Bun.spawnSync(
        ["bun", LENS_TS, "validate-registry", "--garelier-root", pj(PROJECT_ROOT, "__garelier")],
        { stdout: "ignore", stderr: "pipe" },
      );
      const lens_out = r.stderr.toString();
      if (lens_out !== "") {
        add(
          "P1",
          "lens-registry",
          `Lens registry validation failed: ${lens_out.split("\n")[0]}`,
          "fix __garelier/__atmos/lens_registry.toml or __garelier/__atmos/lenses/*.toml; Lens must not carry authority fields",
        );
      }
    } else {
      add(
        "P2",
        "lens-registry-unchecked",
        "Lens registry exists but bun/lenses.ts is unavailable, so it was not validated",
        "run bun skills/garelier-core/driver/src/lenses.ts validate-registry --garelier-root __garelier",
      );
    }
  }

  // --- 10. Compact-handoff bloat (P2) ---
  const HANDOFF_MAX_BYTES = 16384;
  const handoffBig = findHandoffBloat(PM_ROOT, HANDOFF_MAX_BYTES).slice(0, 20);
  if (handoffBig.length > 0) {
    const hb_count = handoffBig.length;
    const hb_sample = handoffBig
      .slice(0, 3)
      .map((f) => {
        const sz = statOf(f)?.size ?? 0;
        const rel = f.startsWith(`${PROJECT_ROOT}/`) ? f.slice(PROJECT_ROOT.length + 1) : f;
        return `${rel} (${sz}B) `;
      })
      .join("");
    add(
      "P2",
      "handoff-bloat",
      `${hb_count} compact-handoff/inbox file(s) exceed ${HANDOFF_MAX_BYTES}B: ${hb_sample}`,
      "reference artifacts by path (compact_handoff.md: never paste a diff/report/blueprint body into a handoff)",
    );
  }

  // --- 11. Role worktree containers must be gitignored (P1) ---
  if (gitOk(PROJECT_ROOT, ["rev-parse", "--is-inside-work-tree"])) {
    for (const wd of [
      "_workers",
      "_scouts",
      "_smiths",
      "_librarians",
      "_observers",
      "_artisan",
      "_guardians",
      "_concierges",
    ]) {
      if (!isDir(pj(PM_ROOT, wd))) continue;
      const rel = `__garelier/${PM_ID}/${wd}`;
      if (!gitOk(PROJECT_ROOT, ["check-ignore", "-q", rel])) {
        add(
          "P1",
          "worktree-not-ignored",
          `${rel} exists but is not gitignored — its worktree content shows as untracked in the target repo`,
          "copy skills/garelier-core/templates/runtime_gitignore to __garelier/.gitignore (nested; project root untouched — it must include _librarians/ _observers/ _artisan/); re-run setup_wizard --mode migrate to do this automatically",
        );
      }
    }
  }

  // --- 12. Studio integration-branch topology (DEC-050) ---
  let studio_branch = "";
  if (gitOk(TARGET_PROJECT_ROOT, ["rev-parse", "--is-inside-work-tree"])) {
    const refs = git(TARGET_PROJECT_ROOT, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/",
    ]).stdout;
    studio_branch =
      refs
        .split("\n")
        .filter((l) => new RegExp(`^garelier/.*/${PM_ID}/studio$`).test(l))[0] ?? "";
    const head_branch = (() => {
      const r = git(TARGET_PROJECT_ROOT, ["symbolic-ref", "-q", "--short", "HEAD"]);
      return r.code === 0 ? r.stdout.replace(/\n+$/, "") : "";
    })();
    if (studio_branch === "") {
      add(
        "P2",
        "studio-branch-missing",
        `no 'garelier/<slug>/${PM_ID}/studio' branch found — integration-branch topology cannot be verified`,
        "confirm the studio branch exists (setup_wizard creates it); if the target slug changed, re-run setup_wizard --mode migrate",
      );
    } else if (head_branch === "") {
      const head_sha = (() => {
        const r = git(TARGET_PROJECT_ROOT, ["rev-parse", "--short", "HEAD"]);
        return r.code === 0 ? r.stdout.replace(/\n+$/, "") : "?";
      })();
      let extra = "";
      const lastSubject = git(TARGET_PROJECT_ROOT, ["log", "-1", "--format=%s", "HEAD"]).stdout;
      if (
        /merge .*into studio/i.test(lastSubject) &&
        !gitOk(TARGET_PROJECT_ROOT, ["merge-base", "--is-ancestor", "HEAD", studio_branch])
      ) {
        extra =
          " — this commit is a 'Merge into studio' fork NOT contained in the studio branch (a merge landed on a detached HEAD instead of advancing studio)";
      }
      add(
        "P1",
        "studio-detached-head",
        `main checkout is on a DETACHED HEAD (${head_sha}), expected studio branch '${studio_branch}'${extra}`,
        `switch the target checkout back to studio (git -C "${TARGET_PROJECT_ROOT}" switch "${studio_branch}"); if a merge landed on a detached fork, replay it onto studio via cherry-pick (DEC-050 operator-surgery)`,
      );
    } else if (head_branch !== studio_branch) {
      add(
        "P2",
        "studio-not-checked-out",
        `main checkout is on '${head_branch}', not studio '${studio_branch}' (PM/Dock operate from studio; fine if mid-promote)`,
        `if not mid-promote, switch back: git -C "${TARGET_PROJECT_ROOT}" switch "${studio_branch}"`,
      );
    }
  }

  // --- 13. Dispatch / runtime state integrity (DEC-088) ---
  const DISPATCH_EVENTS = pj(PM_ROOT, "runtime", "dispatch", "events.jsonl");
  const nowEpoch = Math.floor(Date.now() / 1000);
  const dispatchDirs = listDirs(PM_ROOT)
    .filter((n) => n.startsWith("_dispatch"))
    .sort()
    .map((n) => `${PM_ROOT}/${n}`);
  for (const d of dispatchDirs) {
    const n = pbase(d);
    const num = n.replace(/^_dispatch/, "");
    const state = `${d}/STATE.md`;
    if (!isFile(state)) continue;
    const stateText = readText(state);
    const brMatch = stateText.split("\n").map((l) => {
      const m = l.match(/.*\((garelier\/[^)]*)\).*/);
      return m ? m[1] : undefined;
    }).find((x) => x !== undefined);
    const br = brMatch ?? "";
    const mt = Math.floor((statOf(state)?.mtimeMs ?? nowEpoch * 1000) / 1000);
    const age_h = Math.floor((nowEpoch - mt) / 3600);
    let integrated = "";
    if (br !== "" && studio_branch !== "") {
      if (gitOk(TARGET_PROJECT_ROOT, ["rev-parse", "--verify", "-q", `${br}^{commit}`])) {
        if (gitOk(TARGET_PROJECT_ROOT, ["merge-base", "--is-ancestor", br, studio_branch])) {
          integrated = "integrated into studio";
        }
      } else {
        integrated = "branch missing";
      }
    }
    if (integrated !== "") {
      add(
        "P1",
        "orphan-dispatch-container",
        `${n} is still on disk but its work is done (${integrated}) — it reads as a false LIVE in status`,
        `if done, run: bash <core>/scripts/dispatch_cleanup.sh --project <root> --pm-id ${PM_ID} --id ${num} (or --sweep)`,
      );
    } else if (age_h >= 24) {
      add(
        "P2",
        "stale-dispatch-container",
        `${n} STATE.md has not advanced for ${age_h}h — likely an orphan or a stranded producer`,
        `confirm it is still running; if not, dispatch_cleanup.sh --id ${num}`,
      );
    }
    if (isFile(DISPATCH_EVENTS) && num !== "") {
      const ev = readText(DISPATCH_EVENTS);
      const hasStart = ev
        .split("\n")
        .filter((l) => new RegExp(`#${num}([^0-9]|$)`).test(l))
        .some((l) => /"kind": *"start"/.test(l));
      if (!hasStart) {
        add(
          "P1",
          "dispatch-container-no-start-event",
          `${n} has no 'start' event in events.jsonl — likely launched outside dispatch_prepare (mislabel/orphan)`,
          "launch producers via dispatch_prepare.sh/jig so the start event + produce:<slug> label are recorded (role_subagent_dispatch.md §5)",
        );
      }
    }
  }

  // DEC-089 duplicate in-flight dispatch slug.
  {
    const slugs: string[] = [];
    for (const d of dispatchDirs) {
      const st = `${d}/STATE.md`;
      if (!isFile(st)) continue;
      const lines = readText(st).split("\n");
      let f = false;
      for (const l of lines) {
        if (/^##\s*Current task/.test(l)) {
          f = true;
          continue;
        }
        if (f && l.trim() !== "") {
          const parts = l.split(/\s+/);
          slugs.push(parts[1] ?? "");
          break;
        }
      }
    }
    const counts = new Map<string, number>();
    for (const s of slugs) counts.set(s, (counts.get(s) ?? 0) + 1);
    const dups = [...counts.entries()]
      .filter(([, c]) => c > 1)
      .map(([s]) => s)
      .sort();
    for (const s of dups) {
      if (s === "") continue;
      add(
        "P1",
        "duplicate-dispatch-slug",
        `slug '${s}' has 2+ in-flight _dispatch<N> containers — a duplicate produce (the branch ids differ, so it is otherwise silent)`,
        "keep one, gate/cleanup the rest (dispatch_cleanup.sh --id <N>); dispatch_prepare refuses this without --force (DEC-089)",
      );
    }
  }

  // #6 control/runtime mixing: durable dashboard content in transient manifest.
  const MANIFEST = pj(PM_ROOT, "runtime", "manifest.md");
  if (
    isFile(MANIFEST) &&
    /^#+\s*(roadmap|backlog|decisions?|risk register|active risks?)\b/im.test(readText(MANIFEST))
  ) {
    add(
      "P2",
      "manifest-as-dashboard",
      "runtime/manifest.md carries durable dashboard headings (roadmap/backlog/decisions/risk register) — runtime/ is gitignored and lost on cleanup (a 'Milestones (snapshot)' section is fine; a roadmap/backlog/decision log is not)",
      "move durable planning content to control/project_dashboard/; keep the manifest to 'what is running now'",
    );
  }

  // #7 events.jsonl unbounded growth.
  if (isFile(DISPATCH_EVENTS)) {
    const ev_bytes = statOf(DISPATCH_EVENTS)?.size ?? 0;
    if (ev_bytes > 5242880) {
      add(
        "P2",
        "events-jsonl-bloat",
        `runtime/dispatch/events.jsonl is ${Math.floor(ev_bytes / 1048576)} MB and is read whole on every status call`,
        "rotation is size-capped by dispatch_event.sh (DEC-088 Group E); archive/truncate old generations if it predates that",
      );
    }
  }

  // --- 14. Gate-role boundary (DEC-090) ---
  for (const gdir of ["guardian", "observer"]) {
    const grt = pj(PM_ROOT, "runtime", gdir);
    if (!isDir(grt)) continue;
    for (const rep of expandGlob(`${grt}/*.md`)) {
      if (!pathExists(rep)) continue;
      if (
        /PM[ _-]?re-?verif|PM[ -]performed|executed by the PM|performed by the PM|verif[a-z]* by (the )?PM|PM 独立|PM が[^。]*検証|PM 再検証/i.test(
          readText(rep),
        )
      ) {
        add(
          "P2",
          "gate-verdict-by-pm",
          `runtime/${gdir}/${pbase(rep)} reads as PM-performed gate verification — a gate verdict must come from a gate-role agent, not the PM/Dock (DEC-090)`,
          "re-gate held/reworked branches via the jig_gate_held workflow (jig_render.sh --gate-held; Guardian->refute->Observer as gate-role agents); never hand-dispatch bare gate agents or run the validators as the gate yourself",
        );
      }
    }
  }

  // --- 15. Stranded / stalled producer (DEC-091) ---
  const anybuildRaw = psBuildCountRaw();
  for (const d of dispatchDirs) {
    if (!isDir(`${d}/checkout`)) continue;
    const st = readText(`${d}/STATE.md`);
    let status = "";
    {
      const lines = st.split("\n");
      let f = false;
      for (const l of lines) {
        if (/^##\s*Status/.test(l)) {
          f = true;
          continue;
        }
        if (f && l.trim() !== "") {
          status = l;
          break;
        }
      }
    }
    if (!/WORKING/.test(status)) continue;
    const dirty = git(`${d}/checkout`, ["status", "--porcelain"]).stdout.split("\n").filter((l) => l !== "").length;
    if (dirty > 0 && bashArithEqZero(anybuildRaw)) {
      add(
        "P2",
        "stranded-producer",
        `${pbase(d)} is WORKING with ${dirty} uncommitted file(s) and no live compile — a producer that stalled after detaching a build leaves exactly this (DEC-091)`,
        "if its agent is idle it stalled: warm-resume it (commit + crate-scoped foreground gate) or re-dispatch — the warm worktree's work survives. Use dispatch_watch.sh as the live backstop. (A producer mid-edit can match transiently; confirm idle first.)",
      );
    }
  }

  // --- 16. command_guard hook registration (P2, W-050) ---
  const cg_root = TARGET_PROJECT_ROOT !== "" ? TARGET_PROJECT_ROOT : PROJECT_ROOT;
  let cg_found = false;
  const HOME = process.env.HOME ?? "";
  for (const f of [
    pj(cg_root, ".claude", "settings.local.json"),
    pj(cg_root, ".claude", "settings.json"),
    HOME !== "" ? pj(HOME, ".claude", "settings.json") : "",
  ]) {
    if (f !== "" && isFile(f) && readText(f).includes("command_guard")) {
      cg_found = true;
      break;
    }
  }
  const cg_guard_file = `${DRIVER_SRC}/guard/command_guard.ts`;
  if (cg_found && !isFile(cg_guard_file)) {
    add(
      "P1",
      "command-guard-residue",
      `project-root settings register a command_guard hook but the guard is missing (${cg_guard_file}) — stale wiring after a move or partial teardown (W-050)`,
      "re-run setup_wizard to repair, or 'setup_wizard.sh --mode teardown' to remove the wiring cleanly",
    );
  } else if (!cg_found) {
    add(
      "P2",
      "command-guard-hook",
      `no command_guard PreToolUse hook found in the project-root settings (${cg_root}/.claude/) — attended subagents (Agent-tool spawned) would run unguarded, unless Garelier was intentionally torn down (W-050)`,
      "re-run setup_wizard to register it, or add the project-owned shim (references/command_guard.md)",
    );
  }

  // === Report ===
  console.log(`=== Garelier Doctor — PM '${PM_ID}' ===`);
  console.log(`Project: ${PROJECT_ROOT}`);
  if (TARGET_PROJECT_ROOT !== PROJECT_ROOT) console.log(`Target:  ${TARGET_PROJECT_ROOT}`);
  console.log("");

  for (const line of P0) console.log(line);
  for (const line of P1) console.log(line);
  for (const line of P2) console.log(line);

  const total = P0.length + P1.length + P2.length;
  if (total === 0) console.log("No issues found. (0 findings)");

  console.log("");
  console.log(
    `Summary: ${P0.length} P0 (blocking), ${P1.length} P1 (warning), ${P2.length} P2 (advisory).`,
  );

  process.exit(P0.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// helpers that need local file/process access (kept out of parsers.ts)
// ---------------------------------------------------------------------------

// re-export of the record splitter for the 7c non-comment filter.
function toLinesLocal(content: string): string[] {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

// find PM_ROOT -type f -size +Nc \( -name ... -o -path '*/inbox/*.md' \), pre-order.
function findHandoffBloat(pmRoot: string, minBytes: number): string[] {
  const names = new Set([
    "assignment.md",
    "report.md",
    "questions.md",
    "review.md",
    "answers.md",
    "checkpoint.md",
  ]);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // `find` uses readdir order; keep it as-returned for pre-order DFS parity.
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const matchesName = names.has(e.name);
        const matchesInbox = /\/inbox\/[^/]*\.md$/.test(full);
        if (!matchesName && !matchesInbox) continue;
        const sz = (() => {
          try {
            return fs.statSync(full).size;
          } catch {
            return 0;
          }
        })();
        if (sz > minBytes) out.push(full);
      }
    }
  };
  if (isDirSafe(pmRoot)) walk(pmRoot);
  return out;
}
function isDirSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// { ps -W || ps -e || ps aux; } | grep -ciE '<build tools>' || echo 0
// Returns the RAW captured value the shell would assign (never a clean "0":
// grep -c prints "0" AND exits nonzero on no match, so `|| echo 0` appends a
// second line -> "0\n0"). The DEC-091 comparison below preserves that quirk.
function psBuildCountRaw(): string {
  const pat =
    /cargo|rustc|cc1|gcc|g\+\+|clang|tsc|esbuild|webpack|javac|kotlinc|gradle|\bgo\b|ninja|\bmake\b|bazel|msbuild|swiftc|link\.exe/i;
  let out = "";
  let ranOk = false;
  for (const argv of [["ps", "-W"], ["ps", "-e"], ["ps", "aux"]]) {
    const r = Bun.spawnSync(argv, { stderr: "ignore" });
    if (r.exitCode === 0) {
      out = r.stdout.toString();
      ranOk = true;
      break;
    }
  }
  void ranOk;
  const count = out.split("\n").filter((l) => pat.test(l)).length;
  return count > 0 ? String(count) : "0\n0";
}

// [ "${x:-0}" -eq 0 ]: true only when x is a clean integer 0; a multi-line /
// non-integer value makes the shell `[ ]` error (exit 2) -> false.
function bashArithEqZero(raw: string): boolean {
  const v = raw === "" ? "0" : raw;
  if (v.includes("\n")) return false;
  const t = v.trim();
  if (!/^-?[0-9]+$/.test(t)) return false;
  return Number(t) === 0;
}

if (import.meta.main) main();

export { main };
