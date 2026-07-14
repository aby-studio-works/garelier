#!/usr/bin/env bun
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { argValue, die, ensureDir, hasFlag, listFiles, safeRelSelection, scriptDir, validPmId } from "../../garelier-core/scripts/script_common.ts";

const args = process.argv.slice(2);
const here = scriptDir(import.meta.url);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: split_control.ts --to-pm-id <id> --select <control-relative-path>... [--from-pm-id _workshop] [--project <root>] [--apply]");
  process.exit(0);
}
const project = resolve(argValue(args, "--project", process.cwd()));
const fromPmId = argValue(args, "--from-pm-id", "_workshop");
const toPmId = argValue(args, "--to-pm-id");
const batchId = argValue(args, "--batch-id", new Date().toISOString().replace(/[-:]/g, "").slice(0, 8) + "-" + new Date().toISOString().replace(/[-:]/g, "").slice(9, 15));
const apply = hasFlag(args, "--apply");
const selects: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (["--project", "--from-pm-id", "--to-pm-id", "--batch-id"].includes(a)) i++;
  else if (a === "--select") selects.push(args[++i] ?? "");
  else if (a === "--apply") {}
  else die(`ERROR: unknown argument: ${a}`);
}

if (!validPmId(fromPmId)) die(`ERROR: invalid source pm_id '${fromPmId}'`);
if (!toPmId || !validPmId(toPmId)) die("ERROR: valid --to-pm-id is required");
if (fromPmId === toPmId) die("ERROR: source and destination pm_id must differ");
if (selects.length === 0) die("ERROR: at least one --select is required");

const sourceRoot = join(project, "__garelier", fromPmId, "control");
if (!existsSync(sourceRoot)) die(`ERROR: source control tree not found: ${sourceRoot}`);

let files: string[] = [];
for (const selection of selects) {
  safeRelSelection(selection);
  const candidate = join(sourceRoot, selection);
  if (existsSync(candidate)) {
    const statFiles = listFiles(candidate);
    files.push(...(statFiles.length ? statFiles : [candidate]));
  } else {
    die(`ERROR: selection matched no files: ${selection}`);
  }
}
files = [...new Set(files)].sort();

console.log(`Control split plan: ${fromPmId} -> ${toPmId}`);
console.log(`Selected files: ${files.length}`);
for (const f of files) console.log(`  ${relative(sourceRoot, f)}`);
console.log("Source control will remain unchanged. Destination control will not be written directly.");
if (!apply) {
  console.log("Dry run only. Re-run with --apply to create a gitignored staging batch.");
  process.exit(0);
}

const destRoot = join(project, "__garelier", toPmId, "control");
if (!existsSync(destRoot)) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("bun", [join(here, "init_control.ts"), "--project", project, "--pm-id", toPmId], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const batchRoot = join(project, "__garelier", toPmId, "runtime", "import", "split", batchId);
if (existsSync(batchRoot)) die(`ERROR: batch already exists: ${batchRoot}`);
ensureDir(join(batchRoot, "source", "control"));
ensureDir(join(batchRoot, "drafts"));
ensureDir(join(batchRoot, "reports"));

for (const f of files) {
  const rel = relative(sourceRoot, f);
  const dest = join(batchRoot, "source", "control", rel);
  ensureDir(dirname(dest));
  copyFileSync(f, dest);
}

const selected = files.map((f) => `- \`${relative(sourceRoot, f)}\``).join("\n");
writeFileSync(join(batchRoot, "reports", "plan.md"), `# Control Split Staging Report

- Source: \`${fromPmId}\`
- Destination: \`${toPmId}\`
- Batch: \`${batchId}\`
- Selected files: ${files.length}

## Selected

${selected}

## Required review

- Find references into and out of the selected set.
- Rebuild destination dashboard summaries; do not copy source hot files wholesale.
- Resolve decision IDs, ownership, policies, and quality gates.
- Preserve source until destination validation and approved cutover.
`, "utf8");
console.log(`Staged split batch: ${batchRoot}`);
console.log("Next: analyze dependencies, normalize drafts, validate, and promote reviewed destination control changes.");
