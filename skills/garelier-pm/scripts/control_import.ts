#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  argValue,
  autoDetectPm,
  die,
  ensureDir,
  hasFlag,
  listFiles,
  tomlScalar,
  validPmId,
} from "../../garelier-core/scripts/script_common.ts";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: control_import.ts --from <bundle-dir> [--pm-id <id>] [--project <root>] [--apply]");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (["--pm-id", "--project", "--from"].includes(args[i])) i++;
  else if (args[i] === "--apply") continue;
  else die(`ERROR: unknown argument: ${args[i]}`);
}

if (!argValue(args, "--from")) die("ERROR: --from <bundle-dir> is required (the input source must be specified).");
const project = resolve(argValue(args, "--project", process.cwd()));
const src = resolve(argValue(args, "--from"));
const apply = hasFlag(args, "--apply");

if (!existsSync(join(src, "control"))) die(`ERROR: not a control bundle (no control/ under ${src}).`);
const manifest = join(src, "control_bundle_manifest.toml");
if (!existsSync(manifest)) die(`ERROR: missing control_bundle_manifest.toml in ${src}.`);
const kind = tomlScalar(readFileSync(manifest, "utf8"), "kind");
if (kind !== "control_bundle") die(`ERROR: manifest kind is '${kind}', expected 'control_bundle'.`);

const garelier = join(project, "__garelier");
const explicitPm = argValue(args, "--pm-id");
if (!existsSync(garelier)) {
  if (explicitPm) mkdirSync(garelier, { recursive: true });
  else die(`ERROR: not a Garelier project (no __garelier/): ${project}; pass --pm-id to create a control namespace.`);
}

const pmId = autoDetectPm(project, explicitPm);
if (!validPmId(pmId)) die(`ERROR: invalid pm_id '${pmId}'.`);

const dest = join(garelier, pmId, "control");
ensureDir(dest);

const newFiles: string[] = [];
const collisions: string[] = [];
for (const f of listFiles(join(src, "control")).sort()) {
  const rel = relative(join(src, "control"), f).replaceAll("\\", "/");
  if (rel === "control.toml") continue;
  if (existsSync(join(dest, rel))) collisions.push(rel);
  else newFiles.push(rel);
}

console.log("");
console.log(`==> Control import into PM '${pmId}'  (mode: ${apply ? "APPLY" : "DRY-RUN"})`);
console.log(`    new files: ${newFiles.length}   collisions (NOT overwritten): ${collisions.length}`);
if (collisions.length > 0) {
  console.log("  -- collisions (kept existing; reconcile by hand):");
  for (const c of collisions) console.log(`       ${c}`);
}

if (!apply) {
  console.log("");
  console.log(`Dry run only - nothing written. Re-run with --apply to write the ${newFiles.length} new file(s).`);
  console.log("Collisions are never auto-overwritten; resolve them manually first.");
  process.exit(0);
}

for (const rel of newFiles) {
  const target = join(dest, rel);
  ensureDir(dirname(target));
  copyFileSync(join(src, "control", rel), target);
}
const controlToml = join(dest, "control.toml");
if (!existsSync(controlToml)) {
  writeFileSync(controlToml, `schema_version = 1\nkind = "garelier_control"\npm_id = "${pmId}"\nmode = "control_only"\n`, "utf8");
}

console.log("");
console.log(`==> Wrote ${newFiles.length} new file(s) into ${dest}`);
if (collisions.length > 0) console.log(`    ${collisions.length} collision(s) left untouched - reconcile and re-run if needed.`);
console.log("Review, then commit the control/ changes (run commit-hygiene first).");
