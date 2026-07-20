// W-083 ts-first: DIFF mode orchestration.
//
// Faithful port of the DIFF body of setup_wizard.ts (lines 3896-5052). Reconciles
// the existing roster (read from setup_config.toml) against the desired sets,
// removes/adds agent worktrees, rewrites setup_config.toml (roster blocks +
// post-v2.0 sections + policy toggles), appends history, refreshes the runtime
// manifest, and (re)installs the task-mirror / runtime-recovery hooks. cwd is
// PROJECT_ROOT (the entry chdir'd before dispatching).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { git, type RunResult } from "../_lib.ts";
import { type GarelierDirs } from "./env.ts";
import {
  crewSubdirFromPmRoot,
  wsContainer,
  wsResolveContainer,
  type WizardPaths,
} from "./paths.ts";
import {
  entryId,
  entryModel,
  entryProvider,
  normalizeAgentEntry,
  parseEntries,
} from "./entries.ts";
import {
  emitEffortLine,
  readExistingBlockIds,
  readTomlBare,
  readTomlValue,
} from "./toml.ts";
import {
  createAgentWorktree,
  isAgentIdle,
  removeAgentWorktree,
  writeRoleFiles,
  writeRoleSettings,
  type RoleCtx,
} from "./roles.ts";
import { ensureLensesDefaults, integrateTargetIntoStudio, readHomeRootFromConfig, seedLensAtmosTemplates } from "./migrate.ts";
import { registerCommandGuardHook, registerRuntimeRecoveryHook, registerTaskMirrorHook } from "./hooks.ts";

export interface DiffParams {
  projectRoot: string;
  gitRoot: string;
  now: string;
  dirs: GarelierDirs;
  coreTemplatesDir: string;
  pmId: string;
  target: string;
  workers: string;
  scouts: string;
  smiths: string;
  smithsSet: boolean;
  librarians: string;
  librariansSet: boolean;
  observers: string;
  observersSet: boolean;
  guardians: string;
  guardiansSet: boolean;
  concierges: string;
  conciergesSet: boolean;
  artisanSet: boolean;
  artisanEnable: boolean;
  artisanDisable: boolean;
  artisanSpec: string;
  skipConfirm: boolean;
  allowRequeuedRemoval: boolean;
  wsExile: boolean;
  garelierHome: string;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}
function extractId(entry: string): string {
  const i = entry.indexOf(":");
  return i === -1 ? entry : entry.slice(0, i);
}
// printf '%s\n' a b ... | sort -u | grep -v '^$' : dedup + C-order sort + no empties.
function sortUnique(...arrs: string[][]): string[] {
  const set = new Set<string>();
  for (const a of arrs) for (const e of a) if (e !== "") set.add(e);
  return [...set].sort();
}
function readLineSync(): string {
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
function isYes(r: string): boolean {
  return /^(y|Y|yes|YES)$/.test(r);
}

interface Reconcile {
  add: string[];
  remove: string[];
  kept: string[];
}
// Split desired vs existing by id (existing/desired hold "id:provider:model").
function reconcile(desired: string[], existing: string[]): Reconcile {
  const add: string[] = [];
  const kept: string[] = [];
  const remove: string[] = [];
  const exIds = existing.map(extractId);
  const deIds = desired.map(extractId);
  for (const d of desired) {
    if (exIds.includes(extractId(d))) kept.push(d);
    else add.push(d);
  }
  for (const e of existing) {
    if (!deIds.includes(extractId(e))) remove.push(e);
  }
  return { add, remove, kept };
}

export function runDiff(p: DiffParams): number {
  const pmId = p.pmId;
  const pmRoot = `__garelier/${pmId}`;
  const pmDir = crewSubdirFromPmRoot(pmRoot, "_pm");

  if (!existsSync(`${pmDir}/setup_config.toml`)) {
    err(`Error: ${pmDir}/setup_config.toml not found. Use --mode fresh to initialize.`);
    return 1;
  }
  if (!existsSync(`${pmRoot}/runtime`)) {
    err(`Error: ${pmRoot}/runtime/ not found. Use --mode fresh to initialize.`);
    return 1;
  }

  let target = p.target;
  if (target === "") target = readTomlValue(pmId, "branches", "target");
  const targetSlug = readTomlValue(pmId, "branches", "target_slug");
  const studioBranch = readTomlValue(pmId, "branches", "integration");
  if (target === "" || targetSlug === "" || studioBranch === "") {
    err(`Error: could not read [branches] from ${pmDir}/setup_config.toml.`);
    return 1;
  }

  const paths: WizardPaths = {
    pmId,
    projectRoot: p.projectRoot,
    gitRoot: p.gitRoot,
    wsExile: p.wsExile,
    garelierHome: p.garelierHome,
  };
  const rc: RoleCtx = {
    paths,
    studioBranch,
    now: p.now,
    dirs: p.dirs,
    coreTemplatesDir: p.coreTemplatesDir,
    homeRootFromConfig: readHomeRootFromConfig(pmId),
  };
  const gt = (args: string[]): RunResult => git(p.gitRoot, args);
  const container = (role: string, id: string): string => wsContainer(paths, role, id, rc.homeRootFromConfig);

  const existingWorkers = readExistingBlockIds(pmId, "workers");
  const existingScouts = readExistingBlockIds(pmId, "scouts");
  const existingSmiths = readExistingBlockIds(pmId, "smiths");
  const existingLibrarians = readExistingBlockIds(pmId, "librarians");
  const existingObservers = readExistingBlockIds(pmId, "observers");
  const existingGuardians = readExistingBlockIds(pmId, "guardians");
  const existingConcierges = readExistingBlockIds(pmId, "concierges");

  const desiredWorkers = parseEntries(p.workers);
  const desiredScouts = parseEntries(p.scouts);
  const desiredSmiths = p.smithsSet ? parseEntries(p.smiths) : existingSmiths;
  const desiredLibrarians = p.librariansSet ? parseEntries(p.librarians) : existingLibrarians;
  const desiredObservers = p.observersSet ? parseEntries(p.observers) : existingObservers;
  const desiredGuardians = p.guardiansSet ? parseEntries(p.guardians) : existingGuardians;
  const desiredConcierges = p.conciergesSet ? parseEntries(p.concierges) : existingConcierges;

  // Artisan (DEC-017): single toggle, not a set.
  let artisanExistingEnabled = readTomlBare(pmId, "artisan", "enabled");
  if (artisanExistingEnabled !== "true") artisanExistingEnabled = "false";
  const artisanWtExists = existsSync(wsResolveContainer(pmId, "artisan", ""));
  let artisanDesiredEnabled = artisanExistingEnabled;
  if (p.artisanSet) artisanDesiredEnabled = p.artisanDisable ? "false" : "true";
  let artisanChange = "none";
  if (p.artisanSet && artisanDesiredEnabled !== artisanExistingEnabled) {
    artisanChange = artisanDesiredEnabled === "true" ? "enable" : "disable";
  }

  const rW = reconcile(desiredWorkers, existingWorkers);
  const rS = reconcile(desiredScouts, existingScouts);
  const rSM = reconcile(desiredSmiths, existingSmiths);
  const rLIB = reconcile(desiredLibrarians, existingLibrarians);
  const rOBS = reconcile(desiredObservers, existingObservers);
  const rGRD = reconcile(desiredGuardians, existingGuardians);
  const rCON = reconcile(desiredConcierges, existingConcierges);

  const blocked: string[] = [];
  const checkBlocked = (role: string, removals: string[]): void => {
    for (const e of removals) {
      const id = extractId(e);
      if (!isAgentIdle(rc, role, id)) blocked.push(`${role}:${id}`);
    }
  };
  checkBlocked("workers", rW.remove);
  checkBlocked("scouts", rS.remove);
  checkBlocked("smiths", rSM.remove);
  checkBlocked("librarians", rLIB.remove);
  checkBlocked("observers", rOBS.remove);
  checkBlocked("guardians", rGRD.remove);
  checkBlocked("concierges", rCON.remove);
  if (artisanChange === "disable" && artisanWtExists) {
    if (!isAgentIdle(rc, "artisan", "")) blocked.push("artisan:artisan");
  }

  // --- Plan output ---
  out("Garelier setup plan (diff mode)");
  out("================================");
  out(`  Project root:       ${p.projectRoot}`);
  out(`  PM identifier:      ${pmId}`);
  out(`  PM root:            ${pmRoot}`);
  out(`  Target branch:      ${target}`);
  out(`  Integration branch: ${studioBranch}`);
  out("");
  const planRole = (title: string, r: Reconcile, none: string): void => {
    out(title);
    for (const e of r.kept) out(`    = ${e} (kept)`);
    for (const e of r.add) out(`    + ${e} (add)`);
    for (const e of r.remove) out(`    - ${e} (remove)`);
    if (r.kept.length === 0 && r.add.length === 0 && r.remove.length === 0) out(`    ${none}`);
    out("");
  };
  planRole("  Workers (existing → desired):", rW, "(no workers)");
  planRole("  Scouts (existing → desired):", rS, "(no scouts)");
  planRole("  Smiths (existing -> desired):", rSM, "(no smiths)");
  planRole("  Librarians (existing -> desired):", rLIB, "(no librarians)");
  planRole("  Observers (existing -> desired):", rOBS, "(no observers)");
  planRole("  Guardians (existing -> desired):", rGRD, "(no guardians)");
  planRole("  Concierges (existing -> desired):", rCON, "(no concierges)");
  out("  Artisan lane:");
  if (artisanChange === "enable") out(`    + enable (was: enabled=${artisanExistingEnabled})`);
  else if (artisanChange === "disable") out(`    - disable (was: enabled=${artisanExistingEnabled})`);
  else out(`    = enabled=${artisanExistingEnabled} (unchanged)`);
  out("");

  if (blocked.length > 0 && !p.allowRequeuedRemoval) {
    err("  ERROR: cannot remove the following agents (state is not IDLE):");
    for (const b of blocked) err(`    - ${b}`);
    err("");
    err("  Wait for these agents to complete their current work, or");
    err("  clean-stop abort / retire-and-requeue their tasks via PM, then re-run.");
    err("  Use --allow-requeued-removal only after PM has restored the tasks to pending.");
    return 2;
  }
  if (blocked.length > 0) {
    err("  WARNING: removing non-IDLE agents because --allow-requeued-removal was set.");
    err("  This assumes PM already moved their task rows from in_flight.md to pending.md");
    err("  and recorded Outcome: requeued.");
    for (const b of blocked) err(`    - ${b}`);
    err("");
  }

  const nothing =
    rW.add.length === 0 && rW.remove.length === 0 &&
    rS.add.length === 0 && rS.remove.length === 0 &&
    rSM.add.length === 0 && rSM.remove.length === 0 &&
    rLIB.add.length === 0 && rLIB.remove.length === 0 &&
    rOBS.add.length === 0 && rOBS.remove.length === 0 &&
    rGRD.add.length === 0 && rGRD.remove.length === 0 &&
    rCON.add.length === 0 && rCON.remove.length === 0 &&
    artisanChange === "none";
  if (nothing) {
    out("No changes required. Setup matches desired state.");
    return 0;
  }

  if (!p.skipConfirm) {
    process.stdout.write("Apply this diff? [y/N] ");
    if (!isYes(readLineSync())) {
      out("Aborted.");
      return 0;
    }
  }

  gt(["checkout", studioBranch]);

  const anyAdd =
    rW.add.length > 0 || rS.add.length > 0 || rSM.add.length > 0 ||
    rLIB.add.length > 0 || rOBS.add.length > 0 || rGRD.add.length > 0 ||
    rCON.add.length > 0 || artisanChange === "enable";
  if (anyAdd) {
    out("");
    out(`==> Integrating ${target} into ${studioBranch} (base tracking)...`);
    if (integrateTargetIntoStudio(p.gitRoot, target, studioBranch) !== 0) return 3;
  }

  // --- Remove agents ---
  out("");
  out("==> Removing agents...");
  const removeSet = (role: string, singular: string, removals: string[]): void => {
    for (const e of removals) {
      const id = extractId(e);
      removeAgentWorktree(rc, role, id);
      out(`  - removed ${singular} ${id}`);
    }
  };
  removeSet("workers", "worker", rW.remove);
  removeSet("scouts", "scout", rS.remove);
  removeSet("smiths", "smith", rSM.remove);
  removeSet("librarians", "librarian", rLIB.remove);
  removeSet("observers", "observer", rOBS.remove);
  removeSet("guardians", "guardian", rGRD.remove);
  removeSet("concierges", "concierge", rCON.remove);
  if (artisanChange === "disable" && artisanWtExists) {
    removeAgentWorktree(rc, "artisan", "");
    out("  - disabled artisan lane");
  }

  // --- Add agents ---
  out("");
  out("==> Adding agents...");
  const addSet = (role: string, singular: string, adds: string[]): void => {
    for (const e of adds) {
      const id = entryId(e);
      const provider = entryProvider(e);
      const model = entryModel(e);
      createAgentWorktree(rc, role, id, provider, model);
      out(`  + added ${singular} ${id} (${provider}:${model})`);
    }
  };
  addSet("workers", "worker", rW.add);
  addSet("scouts", "scout", rS.add);
  addSet("smiths", "smith", rSM.add);
  addSet("librarians", "librarian", rLIB.add);
  if (rOBS.add.length > 0) {
    for (const d of [
      `${pmRoot}/runtime/observer/inbox`, `${pmRoot}/runtime/observer/requests`,
      `${pmRoot}/runtime/observer/results`, `${pmRoot}/runtime/observer/locks`,
    ]) mkdirSync(d, { recursive: true });
    mkdirSync(`${pmRoot}/control/observations`, { recursive: true });
    if (!existsSync(`${pmRoot}/control/observations/.gitkeep`)) writeFileSync(`${pmRoot}/control/observations/.gitkeep`, "");
  }
  addSet("observers", "observer", rOBS.add);
  if (rGRD.add.length > 0) {
    for (const d of [
      `${pmRoot}/runtime/guardian/inbox`, `${pmRoot}/runtime/guardian/requests`,
      `${pmRoot}/runtime/guardian/results`, `${pmRoot}/runtime/guardian/locks`,
    ]) mkdirSync(d, { recursive: true });
  }
  addSet("guardians", "guardian", rGRD.add);
  if (rCON.add.length > 0) {
    for (const d of [
      `${pmRoot}/runtime/concierge/inbox`, `${pmRoot}/runtime/concierge/requests`,
      `${pmRoot}/runtime/concierge/results`, `${pmRoot}/runtime/concierge/locks`,
      `${pmRoot}/runtime/concierge/archive`,
    ]) mkdirSync(d, { recursive: true });
  }
  addSet("concierges", "concierge", rCON.add);
  if (artisanChange === "enable" && !artisanWtExists) {
    let solId: string;
    let solProv: string;
    let solModel: string;
    if (p.artisanSpec !== "") {
      const norm = normalizeAgentEntry(p.artisanSpec);
      solId = entryId(norm);
      solProv = entryProvider(norm);
      solModel = entryModel(norm);
    } else {
      solId = readTomlValue(pmId, "artisan", "id") || "artisan-01";
      solProv = readTomlValue(pmId, "artisan", "provider") || "claude-code";
      solModel = readTomlValue(pmId, "artisan", "model") || "claude-code";
    }
    const solC = container("artisan", "");
    mkdirSync(solC, { recursive: true });
    // bash: `git_target worktree add ... >/dev/null` — stderr (Preparing worktree) inherited.
    git(p.gitRoot, ["worktree", "add", "--detach", `${solC}/checkout`, studioBranch], {
      stdout: "ignore",
      stderr: "inherit",
    });
    // ws_use_exile && ws_write_pointer — handled by createAgentWorktree elsewhere;
    // here the bash inlines it. Match: only write pointer when exile is on.
    // (createAgentWorktree isn't used for artisan; identity id != container id.)
    writeRoleSettings(rc, `${solC}/checkout`);
    writeRoleFiles(rc, "artisan", solId, solProv, solModel);
    out(`  + enabled artisan lane (${solId} ${solProv}:${solModel} at ${solC})`);
  }

  // --- setup_config.toml rewrite ---
  out("");
  out(`==> Updating ${pmDir}/setup_config.toml...`);
  rewriteSetupConfig(pmDir, {
    pmId, container, kept: { rW, rS, rSM, rLIB, rOBS, rGRD, rCON },
    artisanPresentToggle: p.artisanSet ? artisanDesiredEnabled : null,
    guardiansSet: p.guardiansSet,
    conciergesSet: p.conciergesSet,
    desiredGrdCount: rGRD.kept.length + rGRD.add.length,
    desiredConCount: rCON.kept.length + rCON.add.length,
    desiredLibCount: rLIB.kept.length + rLIB.add.length,
  });
  ensureLensesDefaults(`${pmDir}/setup_config.toml`);
  seedLensAtmosTemplates(p.coreTemplatesDir);
  out("  + setup_config.toml updated");

  // --- history.md ---
  appendDiffHistory(pmDir, p.now, {
    adds: buildChangeList([
      ["worker", rW.add], ["scout", rS.add], ["smith", rSM.add],
      ["librarian", rLIB.add], ["observer", rOBS.add], ["guardian", rGRD.add],
      ["concierge", rCON.add],
    ], artisanChange === "enable" ? "artisan lane" : ""),
    rems: buildChangeList([
      ["worker", rW.remove], ["scout", rS.remove], ["smith", rSM.remove],
      ["librarian", rLIB.remove], ["observer", rOBS.remove], ["guardian", rGRD.remove],
      ["concierge", rCON.remove],
    ], artisanChange === "disable" ? "artisan lane" : ""),
  });

  // --- manifest.md ---
  out("");
  out(`==> Updating ${pmRoot}/runtime/manifest.md...`);
  updateManifest(pmRoot, p.now, { rW, rS, rSM });

  registerTaskMirrorHook(p.projectRoot, p.dirs);
  registerRuntimeRecoveryHook(p.projectRoot, p.dirs);
  registerCommandGuardHook(p.gitRoot, p.dirs);

  out("");
  out("===================================");
  out("Garelier setup complete (diff).");
  out("===================================");
  out("");
  out("Worktrees:");
  const wl = gt(["worktree", "list"]);
  if (wl.exitCode === 0) {
    for (const l of wl.stdout.replace(/\n$/, "").split("\n")) out(`  ${l}`);
  }
  return 0;
}

// "worker w1, scout s1, ..." with the artisan-lane tail appended; "none" if empty.
function buildChangeList(groups: Array<[string, string[]]>, artisanTail: string): string {
  const parts: string[] = [];
  for (const [singular, arr] of groups) for (const e of arr) parts.push(`${singular} ${e}`);
  if (artisanTail !== "") parts.push(artisanTail);
  return parts.length === 0 ? "none" : parts.join(", ");
}

interface KeptSets {
  rW: Reconcile; rS: Reconcile; rSM: Reconcile;
  rLIB: Reconcile; rOBS: Reconcile; rGRD: Reconcile; rCON: Reconcile;
}
interface RewriteOpts {
  pmId: string;
  container: (role: string, id: string) => string;
  kept: KeptSets;
  artisanPresentToggle: string | null; // desired enabled value when --artisan given
  guardiansSet: boolean;
  conciergesSet: boolean;
  desiredGrdCount: number;
  desiredConCount: number;
  desiredLibCount: number;
}

function rewriteSetupConfig(pmDir: string, o: RewriteOpts): void {
  const toml = `${pmDir}/setup_config.toml`;
  const orig = readFileSync(toml, "utf8");
  const hadTrailingNL = orig.endsWith("\n");
  let lines = orig.split("\n");
  if (hadTrailingNL) lines.pop();

  // Strip every [[workers]]..[[concierges]] roster block (header + body until
  // the next section header).
  const rosterHdr = /^\[\[(workers|scouts|smiths|librarians|observers|guardians|concierges)\]\]/;
  const stripped: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (rosterHdr.test(line)) {
      skip = true;
      continue;
    }
    if (/^\[/.test(line)) skip = false;
    if (!skip) stripped.push(line);
  }

  const present = (re: RegExp): boolean => stripped.some((l) => re.test(l));
  const artisanPresent = present(/^\[artisan\]/);
  const statuswebPresent = present(/^\[status_web\]/);
  const concurrencyPresent = present(/^\[concurrency\]/);
  const outputctlPresent = present(/^\[output_control\]/);
  const librariansPresent = present(/^#?\s*\[\[librarians\]\]/);
  const guardiansHdrPresent = present(/^#?\s*\[\[guardians\]\]/);
  const guardianPolicyPresent = present(/^\[guardian_policy\]/);
  const conciergesHdrPresent = present(/^#?\s*\[\[concierges\]\]/);
  const conciergePolicyPresent = present(/^\[concierge_policy\]/);

  // Roster blocks emitted at the ###AGENTS_HERE### marker (before [milestones]).
  const roster = emitRoster(o, {
    artisanPresent,
    librariansPresent,
    guardiansHdrPresent,
    conciergesHdrPresent,
    statuswebPresent,
    concurrencyPresent,
    outputctlPresent,
  });

  // Insert the roster at the first [milestones]; if none, no insertion (matches
  // the awk that only prints the marker when it sees [milestones]).
  const marked: string[] = [];
  let inserted = false;
  for (const line of stripped) {
    if (!inserted && /^\[milestones\]/.test(line)) {
      marked.push(...roster);
      inserted = true;
    }
    marked.push(line);
  }

  let result = `${marked.join("\n")}\n`;

  // Append guardian/concierge policy sections when absent.
  if (!guardianPolicyPresent) result += `${GUARDIAN_POLICY_BLOCK.join("\n")}\n`;
  if (!conciergePolicyPresent) result += `${CONCIERGE_POLICY_BLOCK.join("\n")}\n`;

  // Sync [guardian_policy].enabled / [concierge_policy].enabled when the flag was
  // explicitly passed.
  if (o.guardiansSet) {
    result = toggleSectionEnabled(result, "guardian_policy", o.desiredGrdCount > 0 ? "true" : "false");
  }
  if (o.conciergesSet) {
    result = toggleSectionEnabled(result, "concierge_policy", o.desiredConCount > 0 ? "true" : "false");
  }
  if (o.artisanPresentToggle !== null) {
    result = toggleSectionEnabled(result, "artisan", o.artisanPresentToggle);
  }

  writeFileSync(toml, result);
}

// awk in_section && ^enabled= -> enabled = <val> (first section table match).
function toggleSectionEnabled(body: string, section: string, val: string): string {
  const hadTrailingNL = body.endsWith("\n");
  const lines = body.split("\n");
  if (hadTrailingNL) lines.pop();
  let inSec = false;
  const outLines = lines.map((line) => {
    if (new RegExp(`^\\[${section}\\]`).test(line)) {
      inSec = true;
      return line;
    }
    if (/^\[/.test(line)) inSec = false;
    if (inSec && /^enabled\s*=/.test(line)) return `enabled = ${val}`;
    return line;
  });
  return `${outLines.join("\n")}${hadTrailingNL ? "\n" : ""}`;
}

interface RosterFlags {
  artisanPresent: boolean;
  librariansPresent: boolean;
  guardiansHdrPresent: boolean;
  conciergesHdrPresent: boolean;
  statuswebPresent: boolean;
  concurrencyPresent: boolean;
  outputctlPresent: boolean;
}

function emitRoster(o: RewriteOpts, f: RosterFlags): string[] {
  const L: string[] = [];
  const eff = (section: string, id: string): string => emitEffortLine(o.pmId, section, id);
  const k = o.kept;

  for (const e of sortUniqueEntries(k.rW.kept, k.rW.add)) {
    const id = entryId(e), provider = entryProvider(e), model = entryModel(e);
    L.push("[[workers]]", `id = "${id}"`, `provider = "${provider}"`, `model = "${model}"`,
      eff("workers", id), `worktree = "${o.container("workers", id)}"`, "");
  }
  for (const e of sortUniqueEntries(k.rS.kept, k.rS.add)) {
    const id = entryId(e), provider = entryProvider(e), model = entryModel(e);
    L.push("[[scouts]]", `id = "${id}"`, `provider = "${provider}"`, `model = "${model}"`,
      eff("scouts", id), `worktree = "${o.container("scouts", id)}"`,
      "idle_task = false", "idle_interval_hours = 24", "");
  }
  for (const e of sortUniqueEntries(k.rSM.kept, k.rSM.add)) {
    const id = entryId(e), provider = entryProvider(e), model = entryModel(e);
    L.push("[[smiths]]", `id = "${id}"`, `provider = "${provider}"`, `model = "${model}"`,
      eff("smiths", id), `worktree = "${o.container("smiths", id)}"`, "");
  }
  for (const e of sortUniqueEntries(k.rLIB.kept, k.rLIB.add)) {
    const id = entryId(e), provider = entryProvider(e), model = entryModel(e);
    L.push("[[librarians]]", `id = "${id}"`, `provider = "${provider}"`, `model = "${model}"`,
      "enabled = true", eff("librarians", id), `worktree = "${o.container("librarians", id)}"`,
      'branch_namespace = "shelf"', "");
  }
  for (const e of sortUniqueEntries(k.rOBS.kept, k.rOBS.add)) {
    const id = entryId(e), provider = entryProvider(e), model = entryModel(e);
    L.push("[[observers]]", `id = "${id}"`, `provider = "${provider}"`, `model = "${model}"`,
      "enabled = true", eff("observers", id), `worktree = "${o.container("observers", id)}"`,
      'allowed_request_kinds = ["merge_review", "artisan_premerge_review", "direction_advice", "architecture_risk_review", "policy_consistency_review"]', "");
  }
  for (const e of sortUniqueEntries(k.rGRD.kept, k.rGRD.add)) {
    const id = entryId(e), provider = entryProvider(e), model = entryModel(e);
    L.push("[[guardians]]", `id = "${id}"`, `provider = "${provider}"`, `model = "${model}"`,
      "enabled = true", eff("guardians", id), "checkout = true", `worktree = "${o.container("guardians", id)}"`,
      'allowed_request_kinds = ["preflight", "delta_gate", "final_gate", "promote_gate", "knowledge_update_request"]', "");
  }
  for (const e of sortUniqueEntries(k.rCON.kept, k.rCON.add)) {
    const id = entryId(e), provider = entryProvider(e), model = entryModel(e);
    L.push("[[concierges]]", `id = "${id}"`, `provider = "${provider}"`, `model = "${model}"`,
      "enabled = true", eff("concierges", id), "checkout = true", `worktree = "${o.container("concierges", id)}"`,
      'branch_namespace = "clipboard"', 'allowed_operation_kinds = ["promote_target", "sync_remote"]', "");
  }
  if (!f.artisanPresent) {
    L.push(
      "# === Artisan (artisan lane) ===", "#",
      "# The Artisan performs the combined Dock + Worker + Scout + Smith +",
      "# Librarian scope by ITSELF on a `satchel` branch, then passes",
      "# Guardian + Observer and integrates into `studio` (DEC-045).",
      "# Mutually exclusive with the dock",
      "# lane (arbitrated by runtime/lane.lock). Disabled by default.",
      "[artisan]", "enabled = false", 'id = "artisan-01"',
      'provider = "claude-code"', 'model = "claude-code"', '# effort = "xhigh"',
      `worktree = "${o.container("artisan", "")}"`, 'branch_namespace = "satchel"', "");
  }
  if (!f.librariansPresent && o.desiredLibCount === 0) {
    L.push(
      "# === Librarian definitions (dock lane) ===", "#",
      "# One [[librarians]] block per Librarian instance. Librarians do",
      "# knowledge / registry / runbook work (external-info sync, internal",
      "# rules, runbooks, source_registry/routine_registry) on a `shelf`",
      "# branch, merged through Dock review. Dock-subordinate;",
      "# never dispatched directly by PM.",
      "# [[librarians]]", '# id = "librarian-01"', '# provider = "claude-code"',
      '# model = "claude-code"', "# enabled = true",
      `# worktree = "${o.container("librarians", "librarian-01")}"`, '# branch_namespace = "shelf"', "");
  }
  if (!f.guardiansHdrPresent && o.desiredGrdCount === 0) {
    L.push(
      "# === Guardian definitions (security/privacy/dependency/license gate, DEC-024) ===", "#",
      "# One [[guardians]] block per Guardian. Commit-free; runs on an",
      "# ephemeral `gavel` branch; gated by [guardian_policy] below.",
      "# [[guardians]]", '# id = "guardian-01"', '# provider = "claude-code"',
      '# model = "claude-code"', "# enabled = true", "# checkout = true",
      `# worktree = "${o.container("guardians", "guardian-01")}"`,
      '# allowed_request_kinds = ["preflight", "delta_gate", "final_gate", "promote_gate", "knowledge_update_request"]', "");
  }
  if (!f.conciergesHdrPresent && o.desiredConCount === 0) {
    L.push(
      "# === Concierge definitions (external operations executor, DEC-025) ===", "#",
      "# One [[concierges]] block per Concierge. Always checkout=true (external",
      "# operations need live git state); runs on a `clipboard` branch; gated",
      "# by [concierge_policy] below.",
      "# [[concierges]]", '# id = "concierge-01"', '# provider = "claude-code"',
      '# model = "claude-code"', "# enabled = true", "# checkout = true",
      `# worktree = "${o.container("concierges", "concierge-01")}"`,
      '# branch_namespace = "clipboard"', '# allowed_operation_kinds = ["promote_target", "sync_remote"]', "");
  }
  if (!f.statuswebPresent) {
    L.push(
      "# === Status Web Console (read-only) ===", "#",
      "# A local, read-only browser view of Garelier state (lane, roles,",
      "# branches, merge gate, recent reports, warnings, source/routine",
      "# registries). Zero AI tokens — it only reads runtime files. Start it",
      "# with `bun run status -- --pm-id <pm_id>` from the driver directory.",
      "# It binds to loopback only and never mutates state.",
      "[status_web]",
      "enabled = false              # informational; the standalone command runs regardless",
      'host = "127.0.0.1"           # loopback only; non-loopback values are rejected',
      "port = 3787", "auto_refresh_seconds = 5",
      "read_only = true             # phase 1 is read-only; no operation UI",
      "show_source_urls = true      # false => show only the host of source registry URLs", "");
  }
  if (!f.concurrencyPresent) {
    L.push(
      "# === Concurrency cap (DEC-027) ===", "#",
      "# Under dispatch-only the HARD cap is [jig] fan_out_cap; the driver-era",
      "# per-poll counting is gone. These values remain DOCK GUIDANCE for what to",
      "# dispatch next under contention and for codex exec budgeting. PM, Dock,",
      "# and the merge-gate subprocess are NOT counted.",
      "[concurrency]", "max_concurrent_agents = 4",
      'tiers = [["concierge", "guardian", "observer"], ["smith", "librarian"], ["worker", "scout", "artisan"], []]',
      "starvation_cycles = 3", "");
  }
  if (!f.outputctlPresent) {
    L.push(
      "# === Output control (DEC-028) ===", "#",
      "# Keeps provider FINAL responses short and driver logs from bloating, on top",
      "# of compact-handoff + retention. Over-budget responses are WARNED, not failed.",
      "[output_control]", "enabled = true", 'default_profile = "compact"',
      'violation_mode = "warn"', "model_result_log_chars = 600", "error_tail_chars = 500",
      "driver_log_max_bytes = 10485760", "driver_log_keep_files = 10", "usage_summary = true", "",
      "[output_control.profiles.normal]", "soft_result_chars = 1600", "max_bullets = 8",
      "[output_control.profiles.compact]", "soft_result_chars = 900", "max_bullets = 5",
      "[output_control.profiles.micro]", "soft_result_chars = 500", "max_bullets = 3", "",
      "[output_control.roles]", 'pm = "normal"', 'dock = "compact"', 'worker = "compact"',
      'smith = "compact"', 'artisan = "compact"', 'scout = "micro"', 'observer = "micro"',
      'librarian = "compact"', 'guardian = "normal"', 'concierge = "normal"', "");
  }
  return L;
}

// printf '%s\n' kept... adds... | sort -u | grep -v '^$'
function sortUniqueEntries(kept: string[], add: string[]): string[] {
  return sortUnique(kept, add);
}

function appendDiffHistory(pmDir: string, now: string, ch: { adds: string; rems: string }): void {
  const hist = `${pmDir}/history.md`;
  let body = "";
  try {
    body = readFileSync(hist, "utf8");
  } catch {
    body = "";
  }
  // next_num from "<!-- Next entry number: N" (default 2).
  const m = body.match(/<!-- Next entry number: (\d+)/);
  const nextNum = m ? parseInt(m[1], 10) : 2;
  // Drop the "Next entry number:" line(s).
  const kept = body.split("\n").filter((l) => !l.includes("Next entry number:"));
  // grep -v strips the marker line; the file had a trailing newline so the join
  // reproduces it. The bash `> file` then `>> file` appends the new block.
  let out2 = kept.join("\n");
  const num3 = String(nextNum).padStart(3, "0");
  const block = [
    "",
    `## #${num3} — ${now} — Agent set updated`,
    "- Blueprint: -",
    "- Milestone: -",
    "- Outcome: setup-change",
    `- Notes: diff-mode wizard. Added: ${ch.adds}. Removed: ${ch.rems}.`,
    "",
    `<!-- Next entry number: ${nextNum + 1} -->`,
  ].join("\n");
  writeFileSync(hist, `${out2}${block}\n`);
  out(`  + ${pmDir}/history.md appended (entry #${num3})`);
}

function updateManifest(pmRoot: string, now: string, sets: { rW: Reconcile; rS: Reconcile; rSM: Reconcile }): void {
  const mf = `${pmRoot}/runtime/manifest.md`;
  let body = "";
  try {
    body = readFileSync(mf, "utf8");
  } catch {
    body = "";
  }
  const legacy = body.split("\n").some((l) => /^## Active Workers/.test(l));
  if (!legacy) {
    // Modern derived manifest: append a Recent activity line, dedup to the first
    // Recent activity section, restamp Last updated / Updated by.
    body = `${body}\n## Recent activity\n\n- ${now} — setup_wizard --mode diff — Agent set updated\n`;
    body = dedupRecentActivity(body);
    body = restampManifest(body, now);
    writeFileSync(mf, body);
    out("  + manifest.md updated (derived execution state — no roster tables, W-011)");
    return;
  }

  // Legacy roster-table manifest: rebuild the Workers/Scouts/Smiths tables.
  const hadTrailingNL = body.endsWith("\n");
  const src = body.split("\n");
  if (hadTrailingNL) src.pop();
  const tmp: string[] = [];
  let inW = false, inS = false, inSm = false, skipped = false, sawSmiths = false;
  for (const line of src) {
    if (/^## Active Workers/.test(line)) { inW = true; inS = false; inSm = false; tmp.push(line); continue; }
    if (/^## Active Scouts/.test(line)) { inW = false; inS = true; inSm = false; tmp.push(line); continue; }
    if (/^## Active Smiths/.test(line)) { inW = false; inS = false; inSm = true; sawSmiths = true; tmp.push(line); continue; }
    if (/^## Backlog summary/.test(line) && !sawSmiths) {
      tmp.push("## Active Smiths", "", "SMITHS_TABLE_PLACEHOLDER", "");
      sawSmiths = true;
    }
    if (/^## /.test(line) && !/^## Active/.test(line)) { inW = false; inS = false; inSm = false; }
    if (inW && /^\| /.test(line)) { skipped = true; continue; }
    if (inS && /^\| /.test(line)) { skipped = true; continue; }
    if (inSm && /^\| /.test(line)) { skipped = true; continue; }
    if (inW && /^$/.test(line) && skipped) { tmp.push("WORKERS_TABLE_PLACEHOLDER", line); skipped = false; inW = false; continue; }
    if (inS && /^$/.test(line) && skipped) { tmp.push("SCOUTS_TABLE_PLACEHOLDER", line); skipped = false; inS = false; continue; }
    if (inSm && /^$/.test(line) && skipped) { tmp.push("SMITHS_TABLE_PLACEHOLDER", line); skipped = false; inSm = false; continue; }
    tmp.push(line);
  }

  const workersTable = ["| Worker | State | Milestone | Phase | Task |", "| ------ | ----- | --------- | ----- | ---- |"];
  for (const e of sortUnique(sets.rW.kept, sets.rW.add)) workersTable.push(`| ${e.split(":")[0]} | IDLE | - | - | - |`);
  const scoutsTable = ["| Scout | State | Investigation |", "| ----- | ----- | ------------- |"];
  for (const e of sortUnique(sets.rS.kept, sets.rS.add)) scoutsTable.push(`| ${e.split(":")[0]} | IDLE | - |`);
  const smithsTable = ["| Smith | State | Focus | Task |", "| ----- | ----- | ----- | ---- |"];
  for (const e of sortUnique(sets.rSM.kept, sets.rSM.add)) smithsTable.push(`| ${e.split(":")[0]} | IDLE | - | - |`);

  const rebuilt: string[] = [];
  for (const line of tmp) {
    if (line === "WORKERS_TABLE_PLACEHOLDER") rebuilt.push(...workersTable);
    else if (line === "SCOUTS_TABLE_PLACEHOLDER") rebuilt.push(...scoutsTable);
    else if (line === "SMITHS_TABLE_PLACEHOLDER") rebuilt.push(...smithsTable);
    else rebuilt.push(line);
  }
  rebuilt.push("", "## Recent activity", "", `- ${now} — setup_wizard --mode diff — Agent set updated`);
  let joined = dedupRecentActivity(`${rebuilt.join("\n")}\n`);
  joined = restampManifest(joined, now);
  writeFileSync(mf, joined);
  out("  + manifest.md tables regenerated (legacy roster-table manifest)");
}

// awk: keep only the FIRST "## Recent activity" section (drop later ones).
function dedupRecentActivity(body: string): string {
  const hadTrailingNL = body.endsWith("\n");
  const lines = body.split("\n");
  if (hadTrailingNL) lines.pop();
  const out2: string[] = [];
  let count = 0;
  let skipUntil = false;
  for (const line of lines) {
    if (/^## Recent activity/.test(line)) {
      count++;
      if (count === 1) skipUntil = true;
    }
    if (skipUntil && /^## /.test(line) && !/^## Recent activity/.test(line)) skipUntil = false;
    if (!skipUntil) out2.push(line);
  }
  return `${out2.join("\n")}${hadTrailingNL ? "\n" : ""}`;
}

function restampManifest(body: string, now: string): string {
  return body
    .replace(/^Last updated: .*$/m, `Last updated: ${now}`)
    .replace(/^Updated by: .*$/m, "Updated by: setup_wizard (diff mode)");
}

const GUARDIAN_POLICY_BLOCK = [
  "",
  "# === Guardian policy (DEC-024) ===",
  "#",
  "# Guardian is the security GATE: commit-free, on an ephemeral `gavel`",
  "# branch, reads Librarian-owned security knowledge",
  "# (the knowledge security/ tree) and emits PASS / PASS_WITH_NOTES / BLOCK /",
  "# NO_OPINION. Disabled by default; enable + add [[guardians]] blocks.",
  "[guardian_policy]",
  "enabled = false",
  "require_for_all_merges = true         # security-gate EVERY merge (guardian step of worker->guardian->observer->dock); false = gate only on the mechanical triggers below",
  'branch_namespace = "gavel"',
  "# Gate timings (delta is the core; preflight/final are staged).",
  "require_delta_before_observer = true",
  "require_final_before_merge = true",
  "require_for_artisan_premerge = true",
  "require_for_promote = true",
  "# Mechanical triggers (when a gate is mandatory).",
  "require_for_dependency_changes = true",
  "require_for_lockfile_changes = true",
  "require_for_auth_security = true",
  "require_for_config_infra_ci_deploy = true",
  "require_for_protected_paths = true",
  "# Blocking rules.",
  "block_on_secret = true",
  "block_on_pii = true",
  "block_on_customer_data = true",
  "block_on_private_key = true",
  "block_on_critical_vulnerability = true",
  "block_on_high_vulnerability = true",
  "block_on_forbidden_license = true",
  "block_on_unknown_license = false",
  "block_when_required_scanner_unavailable = true",
  "# Output safety.",
  "redact_evidence = true",
  "forbid_secret_value_in_report = true",
  "",
  "[guardian_policy.security_sensitive_paths]",
  'paths = [".env*", "**/*.pem", "**/*.key", "**/*secret*", "**/*credential*", "infra/**", "deploy/**", ".github/workflows/**", "migrations/**"]',
  "",
  "[guardian_policy.package_files]",
  'paths = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.toml", "Cargo.lock", "requirements.txt", "pyproject.toml", "poetry.lock", "go.mod", "go.sum"]',
  "",
  "# Scanner commands. Empty = Guardian uses available project tools and",
  "# reports NO_OPINION/BLOCK per policy if a required command is missing.",
  "# If gitleaks cannot be used, PM may set:",
  "#   block_when_required_scanner_unavailable = false",
  '#   secret_scan = "off"',
  "# Guardian then runs in degraded mode and must report that scanner coverage",
  "# was intentionally disabled; it must not claim full secret-scanner coverage.",
  "[guardian_tools]",
  'secret_scan = "gitleaks dir --no-banner --redact"',
  'pii_scan = ""',
  'dependency_scan = ""',
  'license_scan = ""',
  'sast_scan = ""',
];

const CONCIERGE_POLICY_BLOCK = [
  "",
  "# === Concierge policy (external operations executor, DEC-025) ===",
  "#",
  "# Concierge EXECUTES PM-approved operations that leave Garelier's local",
  "# sandbox (Phase 1: promote_target + read-only sync_remote). Reads",
  "# Librarian-owned external_operations/ and consumes the",
  "# Guardian promote_gate verdict. Disabled by default; enable + add",
  "# [[concierges]] blocks. Enabling does NOT auto-push — external writes",
  "# still require an explicit user instruction behind the PM assignment.",
  "[concierge_policy]",
  "enabled = false",
  'branch_namespace = "clipboard"',
  "require_pm_approval = true",
  "require_user_instruction_for_write = true",
  "require_librarian_policy_sources = true",
  "require_guardian_before_external_write = true",
  "require_external_lock = true",
  "forbid_push_garelier_branches = true",
  "forbid_force_push = true",
  "forbid_blind_git_pull = true",
  "redact_sensitive_output = true",
  "# Remote-visible work uses these prefixes — never garelier/* (Phase 2).",
  'allowed_external_branch_prefixes = ["publish/", "pr/", "release/"]',
  "",
  "[concierge_policy.required_knowledge]",
  "paths = [",
  '    "external_operations/external_operations_policy.md",',
  '    "external_operations/git_remote_policy.md",',
  '    "external_operations/promote_policy.md",',
  '    "external_operations/rollback_policy.md",',
  "]",
];
