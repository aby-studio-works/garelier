#!/usr/bin/env bun
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { argValue, cleanCsvItem, copyTree, die, ensureDir, gitHash, hasFlag, listFiles, scriptDir, validPmId } from "../../garelier-core/scripts/script_common.ts";

const args = process.argv.slice(2);
const here = scriptDir(import.meta.url);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: consolidate_controls.ts --from-pm-id <a,b> [--to-pm-id _workshop] [--project <root>] [--batch-id <id>] [--apply]");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (["--project", "--from-pm-id", "--to-pm-id", "--batch-id"].includes(a)) i++;
  else if (a === "--apply") {}
  else die(`ERROR: unknown argument: ${a}`);
}

const project = resolve(argValue(args, "--project", process.cwd()));
const fromPmIds = argValue(args, "--from-pm-id");
const toPmId = argValue(args, "--to-pm-id", "_workshop");
const batchId = argValue(args, "--batch-id", new Date().toISOString().replace(/[-:]/g, "").slice(0, 8) + "-" + new Date().toISOString().replace(/[-:]/g, "").slice(9, 15));
const apply = hasFlag(args, "--apply");
if (!fromPmIds) die("ERROR: --from-pm-id is required");
if (!validPmId(toPmId)) die(`ERROR: invalid pm_id '${toPmId}'`);

const owners = new Map<string, string[]>();
const hashes = new Map<string, string>();
const conflicts = new Set<string>();
const destRoot = join(project, "__garelier", toPmId, "control");

const note = (rel: string, owner: string, hash: string) => {
  const prev = owners.get(rel);
  if (prev) {
    prev.push(owner);
    if (hashes.get(rel) !== hash) conflicts.add(rel);
  } else {
    owners.set(rel, [owner]);
    hashes.set(rel, hash);
  }
};

if (existsSync(destRoot)) {
  for (const f of listFiles(destRoot)) note(relative(destRoot, f), `destination:${toPmId}`, gitHash(f));
}

const sources = fromPmIds.split(",").map(cleanCsvItem).filter(Boolean);
for (const id of sources) {
  if (!validPmId(id)) die(`ERROR: invalid pm_id '${id}'`);
  const root = join(project, "__garelier", id, "control");
  if (!existsSync(root)) die(`ERROR: source control tree not found: ${root}`);
  for (const f of listFiles(root)) note(relative(root, f), `source:${id}`, gitHash(f));
}

let overlaps = 0;
for (const ownerList of owners.values()) if (ownerList.length > 1) overlaps++;
console.log(`Control consolidation plan: ${fromPmIds} -> ${toPmId}`);
console.log(`Destination exists: ${existsSync(destRoot) ? "true" : "false"}`);
for (const rel of conflicts) console.log(`  CONFLICT ${rel}: ${owners.get(rel)!.join(", ")}`);
const identical = overlaps - conflicts.size;
console.log(`Distinct paths: ${owners.size}; identical overlaps: ${identical}; conflicts requiring reconciliation: ${conflicts.size}`);
if (!apply) {
  console.log("Dry run only. Re-run with --apply to create a gitignored staging batch; source controls remain unchanged.");
  process.exit(0);
}

if (!existsSync(destRoot)) {
  const r = spawnSync("bun", [join(here, "init_control.ts"), "--project", project, "--pm-id", toPmId], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const batchRoot = join(project, "__garelier", toPmId, "runtime", "import", "consolidation", batchId);
if (existsSync(batchRoot)) die(`ERROR: batch already exists: ${batchRoot}`);
ensureDir(join(batchRoot, "sources"));
ensureDir(join(batchRoot, "drafts"));
ensureDir(join(batchRoot, "reports"));
for (const id of sources) {
  const src = join(project, "__garelier", id, "control");
  const dest = join(batchRoot, "sources", id, "control");
  copyTree(src, dest);
}

const conflictLines = conflicts.size ? [...conflicts].map((rel) => `- \`${rel}\`: ${owners.get(rel)!.join(", ")}`).join("\n") : "- None";
writeFileSync(join(batchRoot, "reports", "plan.md"), `# Control Consolidation Staging Report

- Destination: \`${toPmId}\`
- Sources: ${fromPmIds}
- Batch: \`${batchId}\`
- Distinct paths: ${owners.size}
- Identical overlaps ignored: ${identical}
- Conflicts requiring semantic reconciliation: ${conflicts.size}

## Conflicts

${conflictLines}

## Rules

- Source namespaces are snapshots only and remain unchanged.
- Destination control is the base authority.
- Normalize into drafts; do not overwrite destination files.
- Resolve policy/decision conflicts with the owner.
`, "utf8");
console.log(`Staged consolidation batch: ${batchRoot}`);
console.log("Next: normalize into drafts, reconcile conflicts, validate, then promote reviewed control changes.");
