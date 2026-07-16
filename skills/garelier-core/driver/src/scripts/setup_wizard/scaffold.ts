// W-083 ts-first: fresh-mode directory scaffolder.
//
// Faithful port of the runtime + control + knowledge tree creation in the FRESH
// body of setup_wizard.sh (lines 2387-2718): mkdir trees, .gitkeep touches, the
// byte-exact README/dashboard/operations heredocs, control.toml, and the
// no-overwrite template-dir copies (control_scaffold + Librarian knowledge trees
// + lens packs). cwd-relative (runs after cd PROJECT_ROOT). config_emit.ts owns
// setup_config.toml; agents_md.ts owns AGENTS.md; this module owns the trees.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ScaffoldCtx {
  pmRoot: string; // __garelier/<pm_id>
  pmDir: string; // resolved _crew/pm (crew_subdir_from_pm_root)
  pmId: string;
  projectName: string;
  target: string;
  studioBranch: string;
  upgradeControlOnly: boolean;
  coreTemplatesDir: string; // GARELIER_CORE_TEMPLATES_DIR or skills/garelier-core/templates
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
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
  for (const d of [
    "control/project_dashboard", "control/operations",
    "control/blueprints/archive", "control/delegation",
    "control/inspections/tech", "control/inspections/market", "control/inspections/status",
    "control/request_intake/templates",
    "control/scheduled_jobs/templates", "control/scheduled_jobs/examples",
    "control/decisions",
    "control/reports/promote", "control/reports/benchmark", "control/reports/data_audit",
    "control/reports/requests", "control/reports/delegated_requests",
    "control/reports/notifications", "control/reports/scheduled_jobs",
    "control/observations",
  ]) {
    mkdirSync(`${r}/${d}`, { recursive: true });
  }
  for (const k of [
    "control/observations/.gitkeep", "control/blueprints/archive/.gitkeep",
    "control/inspections/tech/.gitkeep", "control/inspections/market/.gitkeep",
    "control/inspections/status/.gitkeep", "control/reports/promote/.gitkeep",
    "control/reports/benchmark/.gitkeep", "control/reports/data_audit/.gitkeep",
    "control/reports/requests/.gitkeep", "control/reports/delegated_requests/.gitkeep",
    "control/reports/notifications/.gitkeep", "control/reports/scheduled_jobs/.gitkeep",
  ]) {
    touch(`${r}/${k}`);
  }

  const coreTemplates = ctx.coreTemplatesDir;
  if (!ctx.upgradeControlOnly) {
    write(`${r}/control/README.md`,
`# Garelier Control — PM: ${ctx.pmId}

This tree holds the persistent project authority for PM \`${ctx.pmId}\`:
project dashboard, operations rules, blueprints, inspections, request
intake, delegation, scheduled jobs, decisions, and reports.

Sibling \`${r}/runtime/\` holds transient execution state.

For the read order and authority order, see
\`project_dashboard/README.md\` and the individual operations files.
`);
    write(`${r}/control/project_dashboard/README.md`,
`# Project Dashboard

Persistent planning state for this PM. The order of authority
(highest first):

1. ../operations/  (safety rules)
2. quality_gates.md
3. decisions.md
4. current.md
5. roadmap.md
6. backlog.md
7. notes.md  (lowest authority)

\`notes.md\` is unsorted scratch; promote validated entries to a
higher-authority file and trim notes when they outgrow.
`);
    write(`${r}/control/project_dashboard/current.md`, "# Current\n\n(populate when the project starts work)\n");
    write(`${r}/control/project_dashboard/roadmap.md`, "# Roadmap\n\n(populate as milestones are defined)\n");
    write(`${r}/control/project_dashboard/backlog.md`, "# Backlog\n\n(populate as work items accumulate)\n");
    write(`${r}/control/project_dashboard/decisions.md`, "# Decisions\n\n(append settled judgments here; reference DECs when applicable)\n");
    write(`${r}/control/project_dashboard/risks.md`, "# Risks\n\n(populate as risks are identified)\n");
    write(`${r}/control/project_dashboard/quality_gates.md`,
`# Quality Gates

Completion criteria that bind review and promote. See AGENTS.md §2
for the project's quality-gate commands.
`);
    write(`${r}/control/project_dashboard/notes.md`,
`# Notes

Unsorted scratch. Lowest authority. Promote validated entries to
the appropriate higher-authority file.
`);
    write(`${r}/control/operations/README.md`,
`# Operations

Highest-authority rules. Editing these is a Garelier-wide change.

- runbook.md             — startup/shutdown/monitoring
- promote_checklist.md   — what must hold before studio → target
- recovery.md            — driver crashes, marker collisions, etc.
- data_change_policy.md  — guardrails for any data-mutating task
`);
    write(`${r}/control/operations/runbook.md`,
`# Runbook

Project: ${ctx.projectName}
PM:            ${ctx.pmId}
Target branch: ${ctx.target}
Studio branch: ${ctx.studioBranch}

(Add project-specific startup/shutdown notes here.)
`);
    write(`${r}/control/operations/promote_checklist.md`,
`# Promote Checklist

Before promoting studio to target:

- [ ] Studio branch is clean.
- [ ] All workbench branches are merged or explicitly abandoned.
- [ ] Required tests passed.
- [ ] Quality gates in project_dashboard/quality_gates.md are satisfied.
- [ ] Active risks are reviewed.
- [ ] Runtime manifest is consistent with reality.
- [ ] Smith hardening targets remaining is 0, or PM recorded an explicit user waiver.
- [ ] No production data write is pending.
- [ ] User explicitly approved this promote.
`);
    write(`${r}/control/operations/recovery.md`,
`# Recovery

Procedures for recovering from driver crashes, state inconsistency,
and marker-file corruption. See the framework recovery template for
the full procedure.
`);
    write(`${r}/control/operations/data_change_policy.md`,
`# Data Change Policy

Any task that mutates external data must:

- Run in a dry-run mode that prints intended changes.
- Provide before/after counts and sample changed records.
- Include a rollback plan in the blueprint and report.
- Show explicit user approval (timestamp + words) in \`_pm/history.md\`.
- Not commit secrets.
- Treat customer-facing notifications as data-changing; allowlisted
  scheduled-job operational email must be audited in reports/notifications/.

Dock refuses the merge gate if any of the above is missing.
`);
    const controlScaffold = `${coreTemplates}/control_scaffold`;
    if (existsSync(controlScaffold) && statSync(controlScaffold).isDirectory()) {
      copyTreeContents(controlScaffold, `${r}/control`);
      out("  + control_scaffold templates copied");
    } else {
      err(`ERROR: canonical control_scaffold template not found at ${controlScaffold}`);
      return false;
    }
  } else {
    out("  = existing small-starter control preserved");
  }

  write(`${r}/control/control.toml`,
`schema_version = 1
kind = "garelier_control"
pm_id = "${ctx.pmId}"
mode = "full"
`);

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

  // Shared __atmos lens tier (no-overwrite).
  const atmosRoot = "__garelier/__atmos";
  const lensRegistry = `${coreTemplates}/lens_registry.toml`;
  if (existsSync(lensRegistry) && statSync(lensRegistry).isFile() && !existsSync(`${atmosRoot}/lens_registry.toml`)) {
    mkdirSync(atmosRoot, { recursive: true });
    cpSync(lensRegistry, `${atmosRoot}/lens_registry.toml`);
    out(`  + Lens registry seeded at ${atmosRoot}/lens_registry.toml`);
  }
  const lensesDir = `${coreTemplates}/lenses`;
  if (existsSync(lensesDir) && statSync(lensesDir).isDirectory()) {
    mkdirSync(`${atmosRoot}/lenses`, { recursive: true });
    for (const entry of readdirSync(lensesDir).sort()) {
      if (!entry.endsWith(".toml")) continue;
      const src = `${lensesDir}/${entry}`;
      if (!statSync(src).isFile()) continue;
      if (!existsSync(`${atmosRoot}/lenses/${entry}`)) cpSync(src, `${atmosRoot}/lenses/${entry}`);
    }
    out(`  + Lens packs available at ${atmosRoot}/lenses/ (no-overwrite)`);
  }
}
