// W-083 ts-first: fresh-mode directory scaffolder.
//
// Faithful port of the runtime + control + knowledge tree creation in the FRESH
// body of setup_wizard.ts (lines 2387-2718): mkdir trees, .gitkeep touches, the
// byte-exact README/dashboard/operations heredocs, control.toml, and the
// no-overwrite template-dir copies (control_scaffold_v3 + Librarian knowledge trees
// + lens packs). cwd-relative (runs after cd PROJECT_ROOT). config_emit.ts owns
// setup_config.toml; agents_md.ts owns AGENTS.md; this module owns the trees.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { renameSync, rmSync } from "../../guard/path_guard.ts";
import { dirname, resolve } from "node:path";
import { planProjectQualityGates } from "../../control/quality_gate_plan.ts";
import { acquireNamespaceLock, resolveControlNamespaceForLock } from "../../control/transaction.ts";
import { initializeControlGeneration, readCanonicalControlBinding } from "../../control/generation.ts";
import { loadPlanGraphModel } from "../../control/plan_graph_model.ts";

export interface ScaffoldCtx {
  pmRoot: string; // __garelier/<pm_id>
  pmDir: string; // resolved _crew/pm (crew_subdir_from_pm_root)
  pmId: string;
  projectName: string;
  target: string;
  studioBranch: string;
  targetRoot: string;
  upgradeControlOnly: boolean;
  /** W-313 repair: an existing control/ tree is authority, not scratch space. */
  preserveExistingControl: boolean;
  coreTemplatesDir: string; // GARELIER_CORE_TEMPLATES_DIR or skills/garelier-core/templates
  now: string;
  stack: string;
  qgCmds: readonly string[];
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function seedLensAtmosTemplates(coreTemplatesDir: string): void {
  const atmosLenses = "__garelier/__atmos/lenses";
  const lensesDir = `${coreTemplatesDir}/lenses`;
  if (!existsSync(lensesDir) || !statSync(lensesDir).isDirectory()) return;
  mkdirSync(atmosLenses, { recursive: true });
  for (const entry of readdirSync(lensesDir).sort()) {
    if (!entry.endsWith(".toml")) continue;
    const src = `${lensesDir}/${entry}`;
    if (!statSync(src).isFile()) continue;
    if (!existsSync(`${atmosLenses}/${entry}`)) cpSync(src, `${atmosLenses}/${entry}`);
  }
  out(`  + Lens registry + packs available at ${atmosLenses}/ (no-overwrite)`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}
function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}
function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "");
}
// cp -R "$src"/. "$dst/" : copy the CONTENTS of src into dst (dst pre-exists).
function copyTreeContents(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    cpSync(`${src}/${entry}`, `${dst}/${entry}`, { recursive: true });
  }
}

function copyMissingFiltered(src: string, dst: string, skip: ReadonlySet<string>, prefix = ""): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src).sort()) {
    const rel = prefix === "" ? entry : `${prefix}/${entry}`;
    if (skip.has(rel)) continue;
    const from = `${src}/${entry}`;
    const to = `${dst}/${entry}`;
    if (statSync(from).isDirectory()) copyMissingFiltered(from, to, skip, rel);
    else if (!existsSync(to)) cpSync(from, to);
  }
}

function reportShellGates(commands: readonly string[], stack: string): void {
  for (const id of planProjectQualityGates(commands, stack).shellGateIds) {
    err(`WARNING: ${id} is recorded as runner=shell and requires explicit trusted review.`);
  }
}

const QUALITY_GATES_MARKER_START = "<!-- garelier-generated:quality-gates:start -->";
const QUALITY_GATES_MARKER_END = "<!-- garelier-generated:quality-gates:end -->";

/**
 * Schema-3 dashboard authority is mixed: preserve every curated byte outside
 * the generated quality-gate index. Older schema-3 controls without markers
 * are deliberately left untouched rather than being reformatted by setup.
 */
function updateGeneratedQualityGates(path: string, commands: readonly string[], stack: string): void {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf(QUALITY_GATES_MARKER_START);
  const end = source.indexOf(QUALITY_GATES_MARKER_END);
  if (start < 0 || end < 0 || end < start) return;
  const rows = planProjectQualityGates(commands, stack).gates.map((gate) => {
    const command = gate.argv.join(" ").replaceAll("|", "\\|").replaceAll("`", "\\`");
    return `| ${gate.id} | ${gate.scope.join(", ")} | \`${command}\` | ${gate.required ? "yes" : "no"} |`;
  });
  const generated = [
    QUALITY_GATES_MARKER_START,
    "| ID | Scope | Command | Required |",
    "| --- | --- | --- | --- |",
    ...rows,
    QUALITY_GATES_MARKER_END,
  ].join("\n");
  writeFileSync(path, `${source.slice(0, start)}${generated}${source.slice(end + QUALITY_GATES_MARKER_END.length)}`);
}

// ---- runtime tree (2387-2443) ----
const LIBRARIAN_RUNTIME_README =
  `# Librarian local-only working area (NOT committed)

Gitignored (under \`runtime/\`). Holds the Librarian's machine-local working
material; nothing here is shared or committed.

- \`raw/\`    — raw external pulls (fetched pages, downloads) before review.
- \`cache/\`  — sync caches keyed by source (see knowledge/source_registry.toml).
- \`drafts/\` — pre-publication drafts of knowledge files.

**Curated, shareable knowledge is promoted to the TRACKED knowledge trees**
\`<category>/\` (engineering / quality / review / system / security /
external_operations) via a \`shelf\` branch reviewed by Dock.
Never commit raw external content with unknown license or PII — see
knowledge \`security/commit_hygiene_policy.md\` + \`license_policy.md\`.
`;

export function makeRuntimeTree(ctx: ScaffoldCtx): void {
  const r = ctx.pmRoot;
  const dirs = [
    "runtime/dock/inbox", "runtime/dock/inbox-archive",
    "runtime/dock/outbox", "runtime/dock/outbox-archive",
    "runtime/dock/escalation", "runtime/dock/escalation-archive",
    "runtime/pm/inbox", "runtime/pm/inbox-archive", "runtime/pm/resolutions",
    "runtime/backlog/done", "runtime/backlog/archive", "runtime/backlog/requeued",
    "runtime/driver",
    "runtime/requests/inbox", "runtime/requests/processing",
    "runtime/requests/processed", "runtime/requests/rejected",
    "runtime/requests/failed", "runtime/requests/locks",
    "runtime/scheduled_jobs/locks", "runtime/scheduled_jobs/runs",
    "runtime/merge_gate/requests", "runtime/merge_gate/results",
    "runtime/merge_gate/logs", "runtime/merge_gate/locks",
    "runtime/merge_gate/archive",
    "runtime/observer/inbox", "runtime/observer/requests",
    "runtime/observer/results", "runtime/observer/locks",
    "runtime/guardian/inbox", "runtime/guardian/requests",
    "runtime/guardian/results", "runtime/guardian/locks",
    "runtime/concierge/inbox", "runtime/concierge/requests",
    "runtime/concierge/results", "runtime/concierge/locks",
    "runtime/concierge/archive",
    "runtime/librarian/raw", "runtime/librarian/cache", "runtime/librarian/drafts",
  ];
  for (const d of dirs) mkdirSync(`${r}/${d}`, { recursive: true });
  if (!existsSync(`${r}/runtime/librarian/README.md`)) {
    writeFileSync(`${r}/runtime/librarian/README.md`, LIBRARIAN_RUNTIME_README);
  }
  for (const k of [
    "runtime/dock/inbox/.gitkeep", "runtime/dock/outbox/.gitkeep",
    "runtime/dock/escalation/.gitkeep", "runtime/pm/inbox/.gitkeep",
    "runtime/backlog/done/.gitkeep", "runtime/backlog/requeued/.gitkeep",
    "runtime/requests/inbox/.gitkeep", "runtime/requests/rejected/.gitkeep",
    "runtime/scheduled_jobs/locks/.gitkeep",
  ]) {
    touch(`${r}/${k}`);
  }
  out(`  + ${r}/runtime/ tree created`);
}

// ---- control tree (2454-2718) ----
export function makeControlTree(ctx: ScaffoldCtx): boolean {
  const r = ctx.pmRoot;
  const marker = `${r}/control/control.toml`;
  // W-313: repairing an incomplete install must not reformat, re-seal, or
  // re-scaffold a control namespace that already holds work. Read-only identity
  // check, then hands off — control's own CLI owns every mutation of this tree.
  if (ctx.preserveExistingControl && existsSync(`${r}/control`)) {
    if (!existsSync(marker)) {
      err(`ERROR: ${r}/control/ exists without ${marker}.`);
      err("       The wizard will not scaffold over a control directory it cannot identify,");
      err("       and it will not delete one. Inspect the directory and either restore its");
      err("       control.toml or move the directory aside, then re-run.");
      return false;
    }
    const source = readFileSync(marker, "utf8");
    try {
      readCanonicalControlBinding(resolve(`${r}/control`));
    } catch (error) {
      err(`ERROR: existing control namespace is not canonical schema 3: ${(error as Error).message}`);
      return false;
    }
    if (!new RegExp(`^pm_id\\s*=\\s*"${ctx.pmId}"\\s*$`, "m").test(source)) {
      err(`ERROR: ${marker} belongs to a different PM than '${ctx.pmId}'; refusing to touch it.`);
      return false;
    }
    out("  = existing control/ preserved as-is (repair: nothing rewritten, nothing removed)");
    if (!existsSync(`${r}/runtime/control/generation.json`)) {
      err(`WARNING: ${r}/runtime/control/generation.json is missing. Control mutations stay`);
      err("         blocked until it is recovered — run the control doctor to reinitialize it.");
    }
    seedKnowledge(ctx);
    out(`  + ${r}/control/ tree preserved`);
    return true;
  }
  if (ctx.upgradeControlOnly) {
    if (!existsSync(marker)) {
      err(`ERROR: existing small-starter marker is missing: ${marker}`);
      return false;
    }
    const source = readFileSync(marker, "utf8");
    if (/^schema_version\s*=\s*3\s*$/m.test(source)) {
      const controlRoot = resolve(`${r}/control`), runtimeRoot = resolve(`${r}/runtime/control`);
      const hadGeneration = existsSync(`${runtimeRoot}/generation.json`);
      const qualityGatesPath = `${controlRoot}/project_dashboard/quality_gates.md`;
      const qualityGatesSource = existsSync(qualityGatesPath) ? readFileSync(qualityGatesPath, "utf8") : null;
      try {
        if (!new RegExp(`^pm_id\\s*=\\s*"${ctx.pmId}"\\s*$`, "m").test(source)
          || !/^mode\s*=\s*"control_only"\s*$/m.test(source)) throw new Error("starter identity/mode mismatch");
        const before = loadPlanGraphModel(controlRoot);
        if (before.findings.some((finding) => finding.severity === "error")) throw new Error("starter schema-3 control is invalid");
        write(marker, source.replace(/^mode\s*=\s*"control_only"\s*$/m, 'mode = "full"'));
        updateGeneratedQualityGates(qualityGatesPath, ctx.qgCmds, ctx.stack);
        const after = loadPlanGraphModel(controlRoot);
        if (after.findings.some((finding) => finding.severity === "error")) throw new Error("upgraded schema-3 control is invalid");
        if (!existsSync(`${runtimeRoot}/generation.json`)) initializeControlGeneration(resolveControlNamespaceForLock({ targetRoot: ctx.targetRoot, pmId: ctx.pmId, controlRoot, runtimeRoot }), { sessionId: "cs_setup_upgrade", operation: "setup-wizard-upgrade", at: ctx.now });
      } catch (error) {
        // Revert only setup-owned changes, retaining every starter artifact when
        // strict validation or generation initialization rejects the upgrade.
        try {
          write(marker, source);
          if (qualityGatesSource !== null) write(qualityGatesPath, qualityGatesSource);
          if (!hadGeneration) rmSync(`${runtimeRoot}/generation.json`, { force: true });
        } catch { /* report the original failure; the caller can inspect the starter */ }
        err(`ERROR: invalid schema-v3 starter: ${(error as Error).message}`);
        return false;
      }
    } else {
      const version = /^schema_version\s*=\s*(\d+)\s*$/m.exec(source)?.[1] ?? "unknown";
      err(`ERROR: control schema_version ${version} is unsupported; only schema_version 3 is accepted`);
      return false;
    }
    out("  = existing small-starter control preserved and mode upgraded to full");
  } else {
    const controlScaffold = `${ctx.coreTemplatesDir}/control_scaffold_v3`;
    if (!existsSync(controlScaffold) || !statSync(controlScaffold).isDirectory()) {
      err(`ERROR: canonical schema-3 control_scaffold template not found at ${controlScaffold}`);
      return false;
    }
    const paths = resolveControlNamespaceForLock({ targetRoot: ctx.targetRoot, pmId: ctx.pmId, controlRoot: resolve(`${r}/control`), runtimeRoot: resolve(`${r}/runtime/control`), allowMissingControl: true });
    const lock = acquireNamespaceLock(paths, { sessionId: "cs_setup_fresh", operation: "setup-wizard-fresh", at: ctx.now });
    let canonicalResolved = false;
    const stagingControl = resolve(`${r}/.control-setup-staging-${process.pid}`);
    const generationExisted = existsSync(`${paths.runtimeRoot}/generation.json`);
    let installed = false;
    try {
    if (existsSync(paths.controlRoot)) throw new Error(`fresh setup control namespace already exists: ${paths.controlRoot}`);
    if (existsSync(stagingControl)) throw new Error(`setup staging path already exists: ${stagingControl}`);
    mkdirSync(stagingControl);
    copyMissingFiltered(controlScaffold, stagingControl, new Set(["control.toml"]));
    for (const rel of [
      "milestones",
      "risks/open", "risks/archive",
      "decisions", "inspections/tech", "inspections/market", "inspections/status",
      "observations", "reports/promote", "reports/benchmark", "reports/data_audit", "reports/requests",
      "reports/delegated_requests", "reports/notifications", "reports/scheduled_jobs",
    ]) touch(`${stagingControl}/${rel}/.gitkeep`);
    const controlTemplate = readFileSync(`${controlScaffold}/control.toml`, "utf8");
    if (!controlTemplate.includes("{{PM_ID}}") || !controlTemplate.includes("{{MODE}}")) {
      throw new Error("schema-3 control scaffold marker template is missing substitutions");
    }
    write(`${stagingControl}/control.toml`, controlTemplate.replaceAll("{{PM_ID}}", ctx.pmId).replaceAll("{{MODE}}", "full"));
    for (const required of ["README.md", "current.md", "roadmap.md", "backlog.md", "decisions.md", "risks.md", "quality_gates.md", "notes.md"]) {
      if (!existsSync(`${stagingControl}/project_dashboard/${required}`)) throw new Error(`Dashboard scaffold is missing ${required}`);
    }
    updateGeneratedQualityGates(`${stagingControl}/project_dashboard/quality_gates.md`, ctx.qgCmds, ctx.stack);
    renameSync(stagingControl, paths.controlRoot);
    installed = true;
    const model = loadPlanGraphModel(paths.controlRoot);
    if (model.findings.some((finding) => finding.severity === "error")) throw new Error("installed schema-3 control is invalid");
    initializeControlGeneration(paths, { sessionId: "cs_setup_fresh", operation: "setup-wizard-fresh", at: ctx.now });
    if (process.env.NODE_ENV === "test" && process.env.GARELIER_TEST_SETUP_FAIL_AFTER_SWAP === "1") {
      throw new Error("injected setup failure after control + generation initialization");
    }
    canonicalResolved = true;
    reportShellGates(ctx.qgCmds, ctx.stack);
    out("  + schema-3 plan-graph control scaffold copied");
    } catch (error) {
      if (!canonicalResolved) {
        try {
          if (installed && existsSync(paths.controlRoot)) rmSync(paths.controlRoot, { recursive: true, force: true });
          if (!generationExisted) rmSync(`${paths.runtimeRoot}/generation.json`, { force: true });
          canonicalResolved = !existsSync(paths.controlRoot);
        } catch { /* unresolved canonical state intentionally leaves generation odd */ }
      }
      err(`ERROR: schema-3 fresh control initialization failed: ${(error as Error).message}`);
      return false;
    } finally {
      if (existsSync(stagingControl)) rmSync(stagingControl, { recursive: true, force: true });
      lock.release();
    }
  }

  seedKnowledge(ctx);
  out(`  + ${r}/control/ tree created`);
  return true;
}

// ---- knowledge + lens seeding (2629-2718), all no-overwrite ----
function seedKnowledge(ctx: ScaffoldCtx): void {
  const r = ctx.pmRoot;
  const coreTemplates = ctx.coreTemplatesDir;
  const pmKnowledge = `${r}/knowledge`;
  const librarianTemplates =
    process.env.GARELIER_LIBRARIAN_TEMPLATES_DIR || coreTemplates.replace("garelier-core", "garelier-librarian");

  const seedTree = (name: string, label: string): void => {
    const src = `${librarianTemplates}/${name}`;
    const dst = `${pmKnowledge}/${name}`;
    if (existsSync(src) && statSync(src).isDirectory() && !existsSync(dst)) {
      mkdirSync(dst, { recursive: true });
      copyTreeContents(src, dst);
      out(label);
    }
  };
  seedTree("security", `  + Guardian security knowledge seeded at ${pmKnowledge}/security/ (edit per project)`);
  for (const ktree of ["engineering", "quality", "review", "system"]) {
    seedTree(ktree, `  + Librarian ${ktree} knowledge seeded at ${pmKnowledge}/${ktree}/ (edit per project)`);
  }
  seedTree("external_operations", `  + Concierge external-operations knowledge seeded at ${pmKnowledge}/external_operations/ (edit per project)`);
  seedTree("runbooks", `  + Librarian runbooks seeded at ${pmKnowledge}/runbooks/ (edit per project)`);

  const seedFile = (name: string, label: string): void => {
    const src = `${librarianTemplates}/${name}`;
    const dst = `${pmKnowledge}/${name}`;
    if (existsSync(src) && statSync(src).isFile() && !existsSync(dst)) {
      mkdirSync(pmKnowledge, { recursive: true });
      cpSync(src, dst);
      out(label);
    }
  };
  seedFile("role_index.toml", `  + Role knowledge index seeded at ${pmKnowledge}/role_index.toml (DEC-048)`);
  seedFile("git_command_policy.toml", `  + Git command policy seeded at ${pmKnowledge}/git_command_policy.toml (DEC-048)`);
  for (const reg of ["source_registry", "routine_registry"]) {
    seedFile(`${reg}.toml`, `  + Librarian registry seeded at ${pmKnowledge}/${reg}.toml`);
  }
  seedFile("knowledge.toml", `  + Knowledge contract marker seeded at ${pmKnowledge}/knowledge.toml`);

  // Shared __atmos lens tier (no-overwrite). W-188 (g): both the registry and its
  // packs live under __atmos/lenses/ so __atmos/ holds only subdirs, no stray file.
  seedLensAtmosTemplates(coreTemplates);
}
