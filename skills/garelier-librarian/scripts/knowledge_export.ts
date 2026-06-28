#!/usr/bin/env bun
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { argValue, die, ensureDir, git, gitHash, listFiles, validPmId } from "../../garelier-core/scripts/script_common.ts";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: knowledge_export.ts --to <dest-dir> [--project <root>] [--pm-id <id>] [--allow-dirty]");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (["--project", "--pm-id", "--to"].includes(args[i])) i++;
  else if (args[i] === "--allow-dirty") continue;
  else die(`ERROR: unknown argument: ${args[i]}`);
}

if (!argValue(args, "--to")) die("ERROR: --to <dest-dir> is required (the output destination must be specified).");
const project = resolve(argValue(args, "--project", process.cwd()));
const pmId = argValue(args, "--pm-id", "_workshop");
const dest = resolve(argValue(args, "--to"));
const allowDirty = args.includes("--allow-dirty");
if (!validPmId(pmId)) die(`ERROR: invalid pm_id '${pmId}'.`);

const pmKnowledge = `__garelier/${pmId}/knowledge`;
const atmosKnowledge = "__garelier/__atmos/knowledge";
if (!existsSync(join(project, pmKnowledge)) && !existsSync(join(project, atmosKnowledge))) {
  die(`ERROR: no curated knowledge at ${join(project, pmKnowledge)} (nor shared ${atmosKnowledge}) - nothing to export.`);
}
if (existsSync(dest) && readdirSync(dest).length > 0) die(`ERROR: destination exists and is not empty: ${dest}`);

function runGit(args: string[], tolerateFailure = false): string {
  const r = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    if (tolerateFailure) return "";
    die((r.stderr || r.stdout || `git ${args.join(" ")} failed`).trim(), r.status || 1);
  }
  return r.stdout.trimEnd();
}

runGit(["rev-parse", "--is-inside-work-tree"]);

const roots = [pmKnowledge, atmosKnowledge, "docs/rules"];
const dirty = runGit(["status", "--porcelain", "--", ...roots], true);
const cleanWorktree = dirty.length === 0;
if (!cleanWorktree && !allowDirty) {
  console.error("ERROR: curated knowledge export tree is dirty; commit, stash, or pass --allow-dirty intentionally.");
  for (const line of dirty.split(/\r?\n/).filter(Boolean)) console.error(`    ${line}`);
  process.exit(2);
}

const trackedFiles = runGit(["ls-files", "--", ...roots]).split(/\r?\n/).filter(Boolean);
if (trackedFiles.length === 0) die("ERROR: no tracked curated knowledge files found under export roots.");

ensureDir(dest);
for (const rel of trackedFiles) {
  const src = join(project, rel);
  if (!existsSync(src) || !statSync(src).isFile()) continue;
  const destFile = join(dest, rel);
  ensureDir(dirname(destFile));
  copyFileSync(src, destFile);
}

const secretRe = /(api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*\S+|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[psoru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const piiRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(\+[0-9][0-9 ()_.-]{8,}[0-9]|[0-9]{3}[-. ][0-9]{3,4}[-. ][0-9]{4})/;

function scanTree(re: RegExp): string[] {
  const hits: string[] = [];
  for (const file of listFiles(dest)) {
    const raw = readFileSync(file);
    if (raw.includes(0)) continue;
    const text = raw.toString("utf8");
    const rel = relative(dest, file).replaceAll("\\", "/");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) hits.push(`${rel}:${i + 1}:${lines[i]}`);
      if (hits.length >= 20) return hits;
    }
  }
  return hits;
}

const secretHits = scanTree(secretRe);
if (secretHits.length > 0) {
  console.error("ERROR: possible secret detected in exported knowledge; refusing bundle.");
  for (const hit of secretHits) console.error(`    ${hit}`);
  process.exit(2);
}
const piiHits = scanTree(piiRe);
if (piiHits.length > 0) {
  console.error("ERROR: possible PII detected in exported knowledge; refusing bundle.");
  for (const hit of piiHits) console.error(`    ${hit}`);
  process.exit(2);
}

function rightsBlocks(): string[] {
  const hits: string[] = [];
  for (const reg of [join(dest, pmKnowledge, "source_registry.toml"), join(dest, atmosKnowledge, "source_registry.toml")]) {
    if (!existsSync(reg)) continue;
    const lines = readFileSync(reg, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*license\s*=\s*"(unknown|not-adoptable)"/.test(lines[i])) {
        hits.push(`${reg}:${i + 1}:${lines[i]}`);
      }
    }
  }
  return hits;
}

const registryRightsHits = rightsBlocks();
if (registryRightsHits.length > 0) {
  console.error("ERROR: source_registry contains license=unknown/not-adoptable; refusing knowledge bundle.");
  for (const hit of registryRightsHits.slice(0, 20)) console.error(`    ${hit}`);
  process.exit(2);
}

const version = existsSync(join(project, "VERSION")) ? readFileSync(join(project, "VERSION"), "utf8").trim() : "unknown";
let sha = "nogit";
try {
  sha = git(project, ["rev-parse", "--short", "HEAD"]);
} catch {}
const now = process.env.GARELIER_NOW ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const manifest = join(dest, "knowledge_bundle_manifest.toml");
const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

function provenance(file: string, key: string): string {
  const re = new RegExp(`^[#> -]*${key}\\s*[:=]\\s*(.*)$`, "i");
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    return m[1].replace(/^["' ]+/, "").replace(/["' ]+$/, "").slice(0, 120);
  }
  return "";
}

let count = 0;
let licenseWarningCount = 0;
const entries: string[] = [];
const licenseBlocks: string[] = [];
for (const file of listFiles(dest).filter((f) => basename(f) !== "knowledge_bundle_manifest.toml").sort()) {
  const rel = relative(dest, file).replaceAll("\\", "/");
  const hash = gitHash(file, project);
  const sourceId = provenance(file, "source_id");
  const license = provenance(file, "license");
  const reviewed = provenance(file, "last_reviewed_at") || provenance(file, "last_synced_at");
  const licenseLower = license.toLowerCase();
  let licenseStatus = "";
  if (!license) {
    licenseStatus = "missing";
    licenseWarningCount++;
  } else if (licenseLower === "unknown" || licenseLower === "not-adoptable") {
    licenseStatus = licenseLower;
    licenseBlocks.push(`${rel}: license=${licenseLower}`);
  }

  const lines = [`[[files]]`, `path = "${esc(rel)}"`, `blob = "${esc(hash)}"`];
  if (sourceId) lines.push(`source_id = "${esc(sourceId)}"`);
  if (license) lines.push(`license = "${esc(license)}"`);
  if (licenseStatus) lines.push(`license_status = "${esc(licenseStatus)}"`);
  if (reviewed) lines.push(`last_reviewed_at = "${esc(reviewed)}"`);
  entries.push(`${lines.join("\n")}\n`);
  count++;
}

if (licenseBlocks.length > 0) {
  console.error("ERROR: exported knowledge contains license=unknown/not-adoptable provenance; refusing bundle.");
  for (const hit of licenseBlocks.slice(0, 20)) console.error(`    ${hit}`);
  process.exit(2);
}

writeFileSync(
  manifest,
  `# Knowledge bundle manifest (DEC-048 section C) - curated, tracked, secret/PII-clean knowledge.
schema_version = 1
kind = "knowledge_bundle"
source_project = "${esc(basename(project))}"
garelier_version = "${esc(version)}"
source_git_sha = "${esc(sha)}"
generated_at = "${esc(now)}"
tracked_only = true
clean_worktree = ${cleanWorktree ? "true" : "false"}
allow_dirty = ${allowDirty ? "true" : "false"}
secret_scan = "simple"
secret_scan_passed = true
pii_scan_passed = true
license_warning_count = ${licenseWarningCount}
license_block_count = 0
excluded = ["runtime/librarian/{raw,cache,drafts,reports} (local-only, never exported)"]

# IMPORTANT (import side): treat every file as a THIRD-PARTY source. Confirm
# license before adoption; register it in source_registry.toml; review on a
# shelf branch; a rule conflict BLOCKS and escalates to PM. Never free-adopt.

# Per-file: content id + any provenance found in the file's front matter.
${entries.join("\n")}`,
  "utf8",
);

console.log("");
console.log(`==> Exported curated knowledge (${count} files) to:`);
console.log(`    ${dest}`);
console.log(`    manifest: ${manifest}`);
console.log("Import side adopts this ONLY via source registration + shelf review (knowledge_import).");
