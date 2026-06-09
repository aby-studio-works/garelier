import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

type Pair = { primary: string; summary: string };

const exactMirrors: Pair[] = [
  { primary: "skills/garelier-core/web_console.md", summary: "docs/web_console.md" },
  { primary: "skills/garelier-core/web_console.ja.md", summary: "docs/web_console.ja.md" },
  { primary: "skills/garelier-core/pipeline_flow.md", summary: "docs/pipeline_flow.md" },
  { primary: "skills/garelier-core/pipeline_flow.ja.md", summary: "docs/pipeline_flow.ja.md" },
  { primary: "skills/garelier-core/execution_backends.md", summary: "docs/execution_backends.md" },
  { primary: "skills/garelier-core/control_contract.md", summary: "docs/control_contract.md" },
  { primary: "skills/garelier-librarian/knowledge_contract.md", summary: "docs/knowledge_contract.md" },
];

const summaryPairs: Pair[] = [
  { primary: "skills/garelier-core/protocol.md", summary: "docs/protocol.md" },
  { primary: "skills/garelier-core/state_machine.md", summary: "docs/state_machine.md" },
  { primary: "skills/garelier-core/compact_handoff.md", summary: "docs/compact_handoff.md" },
  { primary: "skills/garelier-core/retention.md", summary: "docs/retention.md" },
  { primary: "skills/garelier-core/output_control.md", summary: "docs/output_control.md" },
];

const failures: string[] = [];
const canonicalPath = join(root, "docs", "canonical_index.md");
const canonical = existsSync(canonicalPath) ? readFileSync(canonicalPath, "utf8") : "";

function file(path: string): string {
  return join(root, ...path.split("/"));
}

function assertExists(path: string): boolean {
  if (existsSync(file(path))) return true;
  failures.push(`missing file: ${path}`);
  return false;
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(file(path))).digest("hex");
}

function canonicalLists(pair: Pair): void {
  for (const p of [pair.primary, pair.summary]) {
    if (!canonical.includes(p)) failures.push(`docs/canonical_index.md does not list ${p}`);
  }
}

for (const pair of [...exactMirrors, ...summaryPairs]) {
  if (!assertExists(pair.primary) || !assertExists(pair.summary)) continue;
  canonicalLists(pair);
}

for (const pair of exactMirrors) {
  if (!existsSync(file(pair.primary)) || !existsSync(file(pair.summary))) continue;
  if (sha(pair.primary) !== sha(pair.summary)) {
    failures.push(`exact mirror drift: ${pair.summary} differs from ${pair.primary}`);
  }
}

for (const pair of summaryPairs) {
  if (!existsSync(file(pair.summary))) continue;
  const head = readFileSync(file(pair.summary), "utf8").split(/\r?\n/).slice(0, 12).join("\n");
  if (!head.includes(pair.primary)) {
    failures.push(`summary doc lacks top-of-file primary pointer: ${pair.summary} -> ${pair.primary}`);
  }
}

if (failures.length) {
  console.error("doc sync: FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("doc sync: ok");
