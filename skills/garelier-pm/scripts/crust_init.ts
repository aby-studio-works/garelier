#!/usr/bin/env bun
// crust_init.ts — TS port of crust_init.ts (W-083). Plant-Crust initializer.
//
// Creates:
//   <workfolder>/crust.toml
//   <workfolder>/<container-id>/container.lock.toml
//   <workfolder>/<container-id>/__garelier/
//   <workfolder>/<container-id>/target/
//
// Then, unless --skip-setup is passed, runs the setup wizard from
// container/__garelier with --target-root target. CLI-frozen against
// crust_init.ts: same flags, stdout, exit codes, and generated descriptors.
import { existsSync, mkdirSync, readFileSync, copyFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { requireRuntimeExecutable } from "../../garelier-core/driver/src/scripts/_lib.ts";

const BUN = requireRuntimeExecutable("bun");
const GIT = requireRuntimeExecutable("git");

const USAGE = `Usage: crust_init.ts --workfolder <path> --container-id <id> [options]

Options:
  --workfolder-id <id>       Workfolder id written to crust.toml.
  --container-id <id>        Container id and directory name.
  --target-remote <url>      Clone target repo into <container>/target when absent.
  --target-branch <branch>   Target branch for clone/setup (default: main).
  --target-init              Initialize an empty target repo when target/ is absent.
  --pm-id <id>               PM id for setup (default: _workshop).
  --project-name <name>      Project name for setup (default: container id).
  --skip-setup               Only write Plant-Crust descriptors and directories.
  --skip-confirm             Pass --skip-confirm to setup wizard.
  --resume                   Continue an existing container after a prior failed run.
  --repair-lock              Rewrite container.lock.toml for an existing container and exit.
  --help                     Show this help.

If target/ already exists, it must be a git repository. If target/ is absent,
pass either --target-remote or --target-init.
`;

function usage(toStderr = false): void {
  (toStderr ? process.stderr : process.stdout).write(USAGE);
}

let WORKFOLDER = "";
let WORKFOLDER_ID = "";
let CONTAINER_ID = "";
let TARGET_REMOTE = "";
let TARGET_BRANCH = "main";
let PM_ID = "_workshop";
let PROJECT_NAME = "";
let TARGET_INIT = false;
let SKIP_SETUP = false;
let SKIP_CONFIRM = false;
let RESUME = false;
let REPAIR_LOCK = false;

const SCRIPT_DIR = resolve(import.meta.dir);
const SKILLS_DIR = resolve(SCRIPT_DIR, "../..");
const CORE_TEMPLATES_DIR = process.env.GARELIER_CORE_TEMPLATES_DIR || `${SKILLS_DIR}/garelier-core/templates`;
const PLANT_TS = `${SKILLS_DIR}/garelier-core/driver/src/plant.ts`;
const SETUP_WIZARD = `${SKILLS_DIR}/garelier-core/driver/src/scripts/setup_wizard.ts`;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case "--workfolder": WORKFOLDER = argv[++i]; break;
    case "--workfolder-id": WORKFOLDER_ID = argv[++i]; break;
    case "--container-id": CONTAINER_ID = argv[++i]; break;
    case "--target-remote": TARGET_REMOTE = argv[++i]; break;
    case "--target-branch": TARGET_BRANCH = argv[++i]; break;
    case "--target-init": TARGET_INIT = true; break;
    case "--pm-id": PM_ID = argv[++i]; break;
    case "--project-name": PROJECT_NAME = argv[++i]; break;
    case "--skip-setup": SKIP_SETUP = true; break;
    case "--skip-confirm": SKIP_CONFIRM = true; break;
    case "--resume": RESUME = true; break;
    case "--repair-lock": REPAIR_LOCK = true; RESUME = true; break;
    case "--help": case "-h": usage(); process.exit(0);
    default:
      process.stderr.write(`Unknown option: ${a}\n`);
      usage(true);
      process.exit(1);
  }
}

function errExit(lines: string[], code = 1): never {
  for (const l of lines) process.stderr.write(l + "\n");
  process.exit(code);
}

if (!WORKFOLDER) errExit(["Error: --workfolder is required."]);
if (!CONTAINER_ID) errExit(["Error: --container-id is required."]);
// unsafe: any char outside [A-Za-z0-9._-], a leading '.', or a '/' or '\'.
if (!/^[A-Za-z0-9._-]+$/.test(CONTAINER_ID) || CONTAINER_ID.startsWith(".")) {
  errExit([`Error: unsafe --container-id '${CONTAINER_ID}'.`]);
}

mkdirSync(WORKFOLDER, { recursive: true });
WORKFOLDER = realpathSync(WORKFOLDER);
if (!WORKFOLDER_ID) {
  WORKFOLDER_ID = basename(WORKFOLDER).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  if (!WORKFOLDER_ID) WORKFOLDER_ID = "workfolder";
}
if (!PROJECT_NAME) PROJECT_NAME = CONTAINER_ID;

const CONTAINER_ROOT = `${WORKFOLDER}/${CONTAINER_ID}`;
const GARELIER_ROOT = `${CONTAINER_ROOT}/__garelier`;
const TARGET_ROOT = `${CONTAINER_ROOT}/target`;

function git(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(GIT, args, { windowsHide: true, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Parse a container's `path` (or its id when path is empty) from crust.toml.
function crustContainerPath(crustPath: string, want: string): string {
  const lines = readFileSync(crustPath, "utf8").split(/\r?\n/);
  const clean = (v: string): string =>
    v.replace(/^[^=]*=[ \t]*/, "").replace(/[ \t]*#.*$/, "").replace(/^"/, "").replace(/"$/, "");
  let inContainer = false, cid = "", cpath = "", found = false, result = "";
  const flush = () => {
    if (cid === want) { if (cpath === "") cpath = cid; result = cpath; found = true; }
  };
  for (const line of lines) {
    if (/^\[\[containers\]\]/.test(line)) { if (inContainer && !found) flush(); inContainer = true; cid = ""; cpath = ""; continue; }
    if (/^\[/.test(line)) { if (inContainer && !found) flush(); inContainer = false; cid = ""; cpath = ""; continue; }
    if (inContainer && /^[ \t]*id[ \t]*=/.test(line)) { cid = clean(line); continue; }
    if (inContainer && /^[ \t]*path[ \t]*=/.test(line)) { cpath = clean(line); continue; }
  }
  if (inContainer && !found) flush();
  return result;
}

mkdirSync(GARELIER_ROOT, { recursive: true });

if (!existsSync(TARGET_ROOT)) {
  if (TARGET_REMOTE) {
    const r = spawnSync(GIT, ["clone", "--branch", TARGET_BRANCH, TARGET_REMOTE, TARGET_ROOT], { windowsHide: true, stdio: "inherit" });
    if ((r.status ?? 1) !== 0) process.exit(r.status || 1);
  } else if (TARGET_INIT) {
    mkdirSync(TARGET_ROOT, { recursive: true });
    spawnSync(GIT, ["-C", TARGET_ROOT, "init"], { windowsHide: true, stdio: "inherit" });
    spawnSync(GIT, ["-C", TARGET_ROOT, "checkout", "-B", TARGET_BRANCH], { windowsHide: true, stdio: "ignore" });
    const commit = spawnSync(GIT, ["-C", TARGET_ROOT, "commit", "--allow-empty", "-m", "chore: initialize target"], { windowsHide: true, stdio: "ignore" });
    if ((commit.status ?? 1) !== 0) {
      errExit([
        "Error: target repo initialized but initial empty commit failed.",
        `Fix git user.name/user.email, create the first commit, then rerun with --skip-setup or rerun setup from ${GARELIER_ROOT}.`,
      ]);
    }
  } else {
    errExit([
      `Error: ${TARGET_ROOT} does not exist.`,
      "Pass --target-remote <url>, --target-init, or create target/ first.",
    ]);
  }
}

if (!existsSync(`${TARGET_ROOT}/.git`)) {
  errExit([`Error: target root is not a git repository: ${TARGET_ROOT}`]);
}
if (existsSync(`${TARGET_ROOT}/__garelier`)) {
  errExit([`Error: Plant-Crust forbids target_root/__garelier: ${TARGET_ROOT}/__garelier`]);
}
if (git(["-C", TARGET_ROOT, "rev-parse", "HEAD"]).status !== 0) {
  errExit(["Error: target repository has no commits. Create one before setup."]);
}
if (git(["-C", TARGET_ROOT, "rev-parse", "--verify", TARGET_BRANCH]).status !== 0) {
  errExit([`Error: target branch '${TARGET_BRANCH}' does not exist in ${TARGET_ROOT}.`]);
}

// add-container: capture stderr only (the .ts did 2>&1 >/dev/null).
const add = spawnSync(BUN, [
  PLANT_TS, "add-container",
  "--crust", `${WORKFOLDER}/crust.toml`,
  "--workfolder-id", WORKFOLDER_ID,
  "--container-id", CONTAINER_ID,
  "--container-path", CONTAINER_ID,
], { windowsHide: true, encoding: "utf8" });
if ((add.status ?? 1) !== 0) {
  const addOutput = add.stderr ?? "";
  if (RESUME && addOutput.includes("container already exists")) {
    const existingPath = crustContainerPath(`${WORKFOLDER}/crust.toml`, CONTAINER_ID);
    if (existingPath !== CONTAINER_ID) {
      errExit([`Error: existing container '${CONTAINER_ID}' uses path '${existingPath}'; crust-init resume only supports path '${CONTAINER_ID}'.`]);
    }
  } else {
    process.stderr.write(addOutput.endsWith("\n") || addOutput === "" ? addOutput : addOutput + "\n");
    process.exit(1);
  }
}

const writeLock = spawnSync(BUN, [
  PLANT_TS, "write-lock",
  "--crust", `${WORKFOLDER}/crust.toml`,
  "--lock", `${CONTAINER_ROOT}/container.lock.toml`,
  "--container", CONTAINER_ID,
  "--target-remote", TARGET_REMOTE,
  "--target-branch", TARGET_BRANCH,
], { windowsHide: true, stdio: ["inherit", "ignore", "inherit"] });
if ((writeLock.status ?? 1) !== 0) process.exit(writeLock.status || 1);

if (REPAIR_LOCK) {
  console.log(`Plant-Crust lock repaired: ${CONTAINER_ROOT}/container.lock.toml`);
  process.exit(0);
}
if (existsSync(`${CORE_TEMPLATES_DIR}/plant_crust_gitignore`) && !existsSync(`${WORKFOLDER}/.gitignore`)) {
  copyFileSync(`${CORE_TEMPLATES_DIR}/plant_crust_gitignore`, `${WORKFOLDER}/.gitignore`);
}

console.log("Plant-Crust initialized:");
console.log(`  workfolder: ${WORKFOLDER}`);
console.log(`  container:  ${CONTAINER_ROOT}`);
console.log(`  control:    ${GARELIER_ROOT}`);
console.log(`  target:     ${TARGET_ROOT}`);

if (SKIP_SETUP) process.exit(0);

const SETUP_ARGS = ["--mode", "fresh", "--pm-id", PM_ID, "--project-name", PROJECT_NAME, "--target", TARGET_BRANCH, "--target-root", "target"];
if (SKIP_CONFIRM) SETUP_ARGS.push("--skip-confirm");

console.log("");
console.log("Running Garelier setup inside Plant-Crust container...");
const wiz = spawnSync(BUN, [SETUP_WIZARD, ...SETUP_ARGS], { windowsHide: true, cwd: GARELIER_ROOT, stdio: "inherit" });
process.exit(wiz.status ?? (wiz.signal ? 1 : 0));
