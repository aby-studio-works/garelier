import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function rel(path: string): string {
  return join(root, path);
}

function read(path: string): string {
  return readFileSync(rel(path), "utf8");
}

function requireFile(path: string): boolean {
  if (!existsSync(rel(path))) {
    fail(`missing required file: ${path}`);
    return false;
  }
  return true;
}

function parseSourceBlocks(toml: string): Record<string, string>[] {
  const blocks: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[sources]]") {
      if (current) blocks.push(current);
      current = {};
      continue;
    }
    if (!current || line.startsWith("#") || line === "") continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))/);
    if (!m) continue;
    current[m[1]] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  if (current) blocks.push(current);
  return blocks;
}

const policyPath = "skills/garelier-librarian/templates/security/provenance_rights_policy.md";
const securityIndexPath = "skills/garelier-librarian/templates/security/index.md";
const roleIndexPath = "skills/garelier-librarian/templates/role_index.toml";
const sourceRegistryPath = "skills/garelier-librarian/templates/source_registry.toml";

const policyOk = requireFile(policyPath);
const securityIndexOk = requireFile(securityIndexPath);
const roleIndexOk = requireFile(roleIndexPath);
const sourceRegistryOk = requireFile(sourceRegistryPath);
requireFile("skills/garelier-librarian/references/source-sync.md");
requireFile("skills/garelier-librarian/scripts/knowledge_export.sh");
requireFile("skills/garelier-librarian/scripts/knowledge_export.ps1");

if (policyOk) {
  const policy = read(policyPath);
  for (const phrase of [
    "Curated Garelier knowledge must be original project wording",
    'license = "unknown"',
    'license = "not-adoptable"',
    "Concierge + Guardian",
  ]) {
    if (!policy.includes(phrase)) fail(`${policyPath} missing policy marker: ${phrase}`);
  }
}

if (securityIndexOk && !read(securityIndexPath).includes("provenance_rights_policy.md")) {
  fail(`${securityIndexPath} does not list provenance_rights_policy.md`);
}
if (roleIndexOk && !read(roleIndexPath).includes("security/provenance_rights_policy.md")) {
  fail(`${roleIndexPath} does not expose provenance_rights_policy.md on demand`);
}
if (!read("skills/garelier-librarian/references/source-sync.md").includes("provenance_rights_policy.md")) {
  fail("source-sync reference does not apply provenance_rights_policy.md");
}

if (sourceRegistryOk) {
  const sources = parseSourceBlocks(read(sourceRegistryPath));
  const externalTypes = new Set(["url", "sharepoint"]);
  const authorityValues = new Set(["official", "recognized", "internal", "third-party"]);
  const licenseValues = new Set(["confirmed", "unknown", "not-adoptable"]);
  const useValues = new Set(["internal-policy-source", "allowed-summary", "inspiration-only"]);
  for (const s of sources) {
    if (!externalTypes.has((s.source_type ?? "").toLowerCase())) continue;
    const id = s.id || "(missing id)";
    for (const field of ["authority", "license", "use", "last_reviewed_at"]) {
      if (!(field in s)) fail(`external source ${id} is missing ${field}`);
    }
    if (s.authority && !authorityValues.has(s.authority)) {
      fail(`external source ${id} has invalid authority=${s.authority}`);
    }
    if (s.license && !licenseValues.has(s.license)) {
      fail(`external source ${id} has invalid license=${s.license}`);
    }
    if (s.use && !useValues.has(s.use)) {
      fail(`external source ${id} has invalid use=${s.use}`);
    }
    if (s.license === "unknown" && s.use !== "inspiration-only") {
      fail(`external source ${id} with license=unknown must use inspiration-only`);
    }
    if (s.license === "not-adoptable" && s.use !== "inspiration-only") {
      fail(`external source ${id} with license=not-adoptable must use inspiration-only`);
    }
    if (s.last_synced_at && !s.last_reviewed_at) {
      fail(`external source ${id} has last_synced_at but no last_reviewed_at`);
    }
  }
}

for (const script of [
  "skills/garelier-librarian/scripts/knowledge_export.sh",
  "skills/garelier-librarian/scripts/knowledge_export.ps1",
]) {
  const text = read(script);
  if (!text.includes("license_block_count")) {
    fail(`${script} does not record license_block_count`);
  }
  if (!text.includes("license=unknown/not-adoptable")) {
    fail(`${script} does not refuse unknown/not-adoptable licenses`);
  }
}

if (failures.length) {
  console.error("knowledge safety: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("knowledge safety: ok");
