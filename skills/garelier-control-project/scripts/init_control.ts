#!/usr/bin/env bun
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  argValue,
  copyMissingTree,
  die,
  ensureDir,
  scriptDir,
  stripLegacyRootGitignore,
  touch,
  validPmId,
} from "../../garelier-core/scripts/script_common.ts";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: init_control.ts [--project <root>] [--pm-id <id>]");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (["--project", "--pm-id"].includes(args[i])) i++;
  else die(`ERROR: unknown argument: ${args[i]}`);
}

const project = resolve(argValue(args, "--project", process.cwd()));
const pmId = argValue(args, "--pm-id", "_workshop");
if (pmId === "_workspace") die("ERROR: '_workspace' is forbidden; use '_workshop'.");
if (!validPmId(pmId)) die(`ERROR: invalid pm_id '${pmId}'`);

const here = scriptDir(import.meta.url);
const localTemplates = resolve(here, "../../garelier-core/templates/control_scaffold");
const templates = process.env.GARELIER_CORE_TEMPLATES_DIR
  ? join(process.env.GARELIER_CORE_TEMPLATES_DIR, "control_scaffold")
  : existsSync(localTemplates)
    ? localTemplates
    : join(process.env.HOME ?? "", ".claude", "skills", "garelier-core", "templates", "control_scaffold");
if (!existsSync(templates)) die(`ERROR: canonical control scaffold not found: ${templates}`);

const pmRoot = join(project, "__garelier", pmId);
const control = join(pmRoot, "control");
const runtimeImport = join(pmRoot, "runtime", "import");
ensureDir(control);
for (const rel of ["raw", "drafts", "reports"]) ensureDir(join(runtimeImport, rel));

for (const rel of [
  "blueprints/archive",
  "decisions",
  "inspections/tech",
  "inspections/market",
  "inspections/status",
  "observations",
  "reports/promote",
  "reports/benchmark",
  "reports/data_audit",
  "reports/requests",
  "reports/delegated_requests",
  "reports/notifications",
  "reports/scheduled_jobs",
  "reports/handoffs",
  "reports/diagnostics",
  "delegation",
  "request_intake/templates",
  "scheduled_jobs/templates",
  "scheduled_jobs/examples",
]) {
  ensureDir(join(control, rel));
  touch(join(control, rel, ".gitkeep"));
}

copyMissingTree(templates, control);

const controlToml = join(control, "control.toml");
if (existsSync(controlToml)) {
  writeFileSync(controlToml, readFileSync(controlToml, "utf8").replaceAll("{{pm_id}}", pmId), "utf8");
} else {
  writeFileSync(controlToml, `schema_version = 1\nkind = "garelier_control"\npm_id = "${pmId}"\nmode = "control_only"\n`, "utf8");
}

const nestedGitignore = join(project, "__garelier", ".gitignore");
if (!existsSync(nestedGitignore)) {
  const coreTemplates = resolve(here, "../../garelier-core/templates");
  const runtimeGitignore = join(coreTemplates, "runtime_gitignore");
  ensureDir(dirname(nestedGitignore));
  if (existsSync(runtimeGitignore)) copyFileSync(runtimeGitignore, nestedGitignore);
  else writeFileSync(nestedGitignore, "# Garelier nested .gitignore (control-only)\n*/runtime/\n", "utf8");
}
stripLegacyRootGitignore(project);

console.log(`Initialized control namespace '${pmId}' at ${control}`);
console.log("Existing files were preserved; runtime/import is gitignored staging.");
