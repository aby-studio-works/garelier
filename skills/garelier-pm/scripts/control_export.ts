#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { argValue, autoDetectPm, copyTree, die, git, gitHash, listFiles, validPmId } from "../../garelier-core/scripts/script_common.ts";

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
if (existsSync(dest) && readdirSync(dest).length > 0) die(`ERROR: destination exists and is not empty: ${dest}`);

const pmId = autoDetectPm(project, argValue(args, "--pm-id"));
if (!validPmId(pmId)) die(`ERROR: invalid pm_id '${pmId}'.`);
const control = join(project, "__garelier", pmId, "control");
if (!existsSync(control)) die(`ERROR: no control/ tree at ${control}`);

copyTree(control, join(dest, "control"));

const version = existsSync(join(project, "VERSION")) ? readFileSync(join(project, "VERSION"), "utf8").trim() : "unknown";
let sha = "nogit";
try { sha = git(project, ["rev-parse", "--short", "HEAD"]); } catch {}
const now = process.env.GARELIER_NOW ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const man = join(dest, "control_bundle_manifest.toml");
const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

let body = `# Control bundle manifest (DEC-048 section B) - a snapshot of a PM's tracked control/ authority.
schema_version = 1
kind = "control_bundle"
pm_id = "${esc(pmId)}"
source_project = "${esc(basename(project))}"
garelier_version = "${esc(version)}"
source_git_sha = "${esc(sha)}"
generated_at = "${esc(now)}"
excluded = ["runtime/ (gitignored, machine-local)"]

# Per-file content ids (git blob sha; verify on import). Paths are bundle-relative.
`;
let count = 0;
for (const f of listFiles(join(dest, "control")).sort()) {
  const rel = `control/${relative(join(dest, "control"), f).replaceAll("\\", "/")}`;
  body += `[[files]]\npath = "${esc(rel)}"\nblob = "${esc(gitHash(f, project))}"\n\n`;
  count++;
}
writeFileSync(man, body, "utf8");
console.log("");
console.log(`==> Exported PM '${pmId}' control/ (${count} files) to:`);
console.log(`    ${dest}`);
console.log(`    manifest: ${man}`);
console.log("Next: review it. To publish outside the sandbox use Concierge (Guardian-gated);");
console.log("to hand it to another PM use the request_intake/ mechanism (DEC-006).");
