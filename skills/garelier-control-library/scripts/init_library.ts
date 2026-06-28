#!/usr/bin/env bun
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  argValue,
  die,
  ensureDir,
  scriptDir,
  stripLegacyRootGitignore,
  validPmId,
} from "../../garelier-core/scripts/script_common.ts";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: init_library.ts [--project <root>] [--pm-id <id>]");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (["--project", "--pm-id"].includes(args[i])) i++;
  else die(`ERROR: unknown argument: ${args[i]}`);
}

const project = resolve(argValue(args, "--project", process.cwd()));
const pmId = argValue(args, "--pm-id", "_workshop");
if (pmId === "_workspace") die("ERROR: use '_workshop', not '_workspace'.");
if (!validPmId(pmId)) die(`ERROR: invalid pm_id '${pmId}'`);

const here = scriptDir(import.meta.url);
const localTemplates = resolve(here, "../../garelier-librarian/templates");
const templates = process.env.GARELIER_LIBRARIAN_TEMPLATES_DIR ?? (existsSync(localTemplates) ? localTemplates : join(process.env.HOME ?? "", ".claude", "skills", "garelier-librarian", "templates"));
if (!existsSync(templates)) die(`ERROR: Librarian templates not found: ${templates}`);
const starterTemplates = resolve(here, "../templates");

const knowledge = join(project, "__garelier", pmId, "knowledge");
const category = join(knowledge, "project");
const runtime = join(project, "__garelier", pmId, "runtime", "librarian");
for (const dir of [knowledge, category, join(runtime, "raw"), join(runtime, "cache"), join(runtime, "drafts"), join(runtime, "reports")]) ensureDir(dir);

const knowledgeToml = join(knowledge, "knowledge.toml");
if (!existsSync(knowledgeToml)) copyFileSync(join(templates, "knowledge.toml"), knowledgeToml);
for (const name of ["role_index.toml", "source_registry.toml", "routine_registry.toml"]) {
  const dest = join(knowledge, name);
  if (!existsSync(dest)) copyFileSync(join(starterTemplates, name), dest);
}

const index = join(category, "index.md");
if (!existsSync(index)) {
  const tmpl = readFileSync(join(templates, "knowledge_index.md"), "utf8")
    .replaceAll("{{Category}}", "Project")
    .replaceAll("{{category}}", "project")
    .replaceAll("{{knowledge/policy owner}}", "user / project owner")
    .replaceAll("{{condition}}", "project-specific knowledge is needed")
    .replaceAll("{{on change / scheduled review}}", "on change");
  writeFileSync(index, tmpl, "utf8");
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

console.log(`Initialized Garelier library at ${knowledge}`);
console.log(`Local staging: ${runtime}`);
console.log("(Shared __atmos tier is created on demand when you share knowledge project-wide.)");
