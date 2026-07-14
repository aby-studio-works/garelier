#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { argValue, autoDetectPm, copyTree, die, ensureDir, tomlScalar, validPmId } from "../../garelier-core/scripts/script_common.ts";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: knowledge_import.ts --from <bundle-dir> [--pm-id <id>] [--project <root>]");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (["--pm-id", "--project", "--from"].includes(args[i])) i++;
  else die(`ERROR: unknown argument: ${args[i]}`);
}

if (!argValue(args, "--from")) die("ERROR: --from <bundle-dir> is required (the input source must be specified).");
const project = resolve(argValue(args, "--project", process.cwd()));
const src = resolve(argValue(args, "--from"));
const explicitPm = argValue(args, "--pm-id");

const manifest = join(src, "knowledge_bundle_manifest.toml");
if (!existsSync(manifest)) die(`ERROR: not a knowledge bundle (no knowledge_bundle_manifest.toml in ${src}).`);
const kind = tomlScalar(readFileSync(manifest, "utf8"), "kind");
if (kind !== "knowledge_bundle") die(`ERROR: manifest kind is '${kind}', expected 'knowledge_bundle'.`);

const garelier = join(project, "__garelier");
if (!existsSync(garelier)) {
  if (explicitPm) mkdirSync(garelier, { recursive: true });
  else die("ERROR: no __garelier/ staging namespace; pass --pm-id (usually _workshop).");
}
const pmId = autoDetectPm(project, explicitPm);
if (!validPmId(pmId)) die(`ERROR: invalid pm_id '${pmId}'.`);

const name = basename(src).replace(/[^A-Za-z0-9._-]/g, "-");
const sourceProject = tomlScalar(readFileSync(manifest, "utf8"), "source_project") || "unknown";
const stage = join(garelier, pmId, "runtime", "librarian", "raw", `imported-${name}`);
if (existsSync(stage)) die(`ERROR: already staged at ${stage} (remove it first).`);
ensureDir(stage);
copyTree(src, stage);

const stub = join(stage, "_source_registry.stub.toml");
writeFileSync(
  stub,
  `# source_registry STUB for an imported knowledge bundle (DEC-048 section C).
# Confirm license + authority, then add to the knowledge source_registry.toml
# on a shelf branch. Defaults are deliberately conservative.
[[sources]]
id = "imported-${name}"
title = "Imported knowledge bundle from ${sourceProject}"
kind = "imported_knowledge_bundle"
source_type = "local_file"
path = "runtime/librarian/raw/imported-${name}"
owner = "pm"
update_mode = "manual"
authority = "third-party"      # confirm: official | recognized | internal | third-party
license = "unknown"            # MUST confirm before adoption: confirmed | unknown | not-adoptable
use = "inspiration-only"       # inspiration-only | allowed-summary | internal-policy-source
trust = "unreviewed"
`,
  "utf8",
);

console.log("");
console.log("==> Staged knowledge bundle into the Librarian local-only working area:");
console.log(`    ${stage}`);
console.log(`    source_registry stub: ${stub}`);
console.log("");
console.log("Next (Librarian, on a shelf branch - never a free adoption):");
console.log("  1. CONFIRM the license of each file (manifest 'license' fields are hints only).");
console.log("  2. Add the (license-confirmed) source to the knowledge source_registry.toml.");
console.log("  3. Generalize into ORIGINAL project wording with provenance; do NOT copy verbatim.");
console.log("  4. A rule CONFLICT with existing knowledge -> BLOCK + escalate to PM (never silently override).");
console.log("  5. Promote license-clean, reviewed content into the knowledge trees via Dock shelf review");
console.log("     (per-pm __garelier/<pm_id>/knowledge/ by default; shared __atmos only on an explicit project-wide decision).");
console.log("Raw staged content is gitignored (runtime/) and must never be committed as-is.");
