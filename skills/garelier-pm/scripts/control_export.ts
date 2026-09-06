#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { inventoryControl, renderBundleManifest, sha256File } from "../../garelier-core/driver/src/control/portability.ts";
import { assertSafeFilesystemPath, assertSafePathWithin } from "../../garelier-core/driver/src/control/roots.ts";
import { requireRuntimeExecutable } from "../../garelier-core/driver/src/scripts/_lib.ts";
import { argValue, autoDetectPm, die, validPmId } from "../../garelier-core/scripts/script_common.ts";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: control_export.ts --to <dest-dir> [--pm-id <id>] [--project <root>]");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (["--pm-id", "--project", "--to"].includes(args[i])) i++;
  else die(`ERROR: unknown argument: ${args[i]}`);
}
if (!argValue(args, "--to")) die("ERROR: --to <dest-dir> is required (the output destination must be specified).");
const project = resolve(argValue(args, "--project", process.cwd()));
const dest = resolve(argValue(args, "--to"));
try { assertSafeFilesystemPath(dest, "control export destination", false); }
catch (error) { die(`ERROR: unsafe export destination: ${(error as Error).message}`, 1); }
if (existsSync(dest)) {
  const info = lstatSync(dest);
  if (info.isSymbolicLink() || !info.isDirectory()) die(`ERROR: destination must be a real directory: ${dest}`);
  if (readdirSync(dest).length > 0) die(`ERROR: destination exists and is not empty: ${dest}`);
}

const pmId = autoDetectPm(project, argValue(args, "--pm-id"));
if (!validPmId(pmId)) die(`ERROR: invalid pm_id '${pmId}'.`);

let inventory;
try { inventory = inventoryControl(project, pmId); }
catch (error) { die(`ERROR: control export validation failed: ${(error as Error).message}`, 1); }

const version = existsSync(join(project, "VERSION")) ? readFileSync(join(project, "VERSION"), "utf8").trim() : "unknown";
let sourceGitSha = "nogit";
const rev = spawnSync(requireRuntimeExecutable("git"), ["rev-parse", "--short", "HEAD"], { cwd: project, encoding: "utf8", windowsHide: true });
if (rev.status === 0 && rev.stdout.trim()) sourceGitSha = rev.stdout.trim();
const generatedAt = process.env.GARELIER_NOW ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const manifest = renderBundleManifest({ inventory, pmId, sourceProject: basename(project), garelierVersion: version, sourceGitSha, generatedAt });

mkdirSync(dest, { recursive: true });
try { assertSafeFilesystemPath(dest, "control export destination"); }
catch (error) { die(`ERROR: unsafe export destination: ${(error as Error).message}`, 1); }
for (const file of inventory.files) {
  const target = join(dest, ...file.path.split("/"));
  if (sha256File(file.absolutePath) !== file.sha256) die(`ERROR: control source changed before export: ${file.path}`, 1);
  mkdirSync(dirname(target), { recursive: true });
  try { assertSafePathWithin(dest, dirname(target), `control export parent for ${file.path}`); }
  catch (error) { die(`ERROR: unsafe export path: ${(error as Error).message}`, 1); }
  copyFileSync(file.absolutePath, target);
  if (sha256File(file.absolutePath) !== file.sha256 || sha256File(target) !== file.sha256) die(`ERROR: control source changed during export: ${file.path}`, 1);
}
const manifestPath = join(dest, "control_bundle_manifest.toml");
writeFileSync(manifestPath, manifest, { encoding: "utf8", flag: "wx" });

console.log("");
console.log(`==> Exported PM '${pmId}' schema v${inventory.schemaVersion} canonical control (${inventory.files.length} files) to:`);
console.log(`    ${dest}`);
console.log(`    control revision: ${inventory.controlRevision}`);
console.log(`    manifest: ${manifestPath}`);
console.log("Next: review it. To publish outside the sandbox use Concierge (Guardian-gated);");
console.log("to hand it to another PM use the request_intake/ mechanism (DEC-006).");
