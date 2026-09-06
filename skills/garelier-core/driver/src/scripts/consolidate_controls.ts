#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { classifyEntityCollisions, inventoryControl, sha256File, type ControlInventory, type PortableFile } from "../control/portability.ts";
import { loadPlanGraphModel } from "../control/plan_graph_model.ts";
import { assertSafeFilesystemPath, assertSafePathWithin } from "../control/roots.ts";
import { argValue, cleanCsvItem, die, hasFlag, validPmId } from "../../../scripts/script_common.ts";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: consolidate_controls.ts --from-pm-id <a,b> [--to-pm-id _workshop] [--project <root>] [--batch-id <id>] [--apply]");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (["--project", "--from-pm-id", "--to-pm-id", "--batch-id"].includes(args[i])) i++;
  else if (args[i] !== "--apply") die(`ERROR: unknown argument: ${args[i]}`);
}

const project = resolve(argValue(args, "--project", process.cwd()));
const from = argValue(args, "--from-pm-id");
const toPmId = argValue(args, "--to-pm-id", "_workshop");
const batchId = argValue(args, "--batch-id", (process.env.GARELIER_NOW ?? new Date().toISOString()).replace(/[-:]/g, "").slice(0, 8) + "-" + (process.env.GARELIER_NOW ?? new Date().toISOString()).replace(/[-:]/g, "").slice(9, 15));
const apply = hasFlag(args, "--apply");
if (!from) die("ERROR: --from-pm-id is required");
if (!validPmId(toPmId)) die(`ERROR: invalid pm_id '${toPmId}'`);
const sourceIds = [...new Set(from.split(",").map(cleanCsvItem).filter(Boolean))];
if (sourceIds.length < 1) die("ERROR: at least one source pm_id is required");
for (const id of sourceIds) if (!validPmId(id)) die(`ERROR: invalid pm_id '${id}'`);

const inventories = new Map<string, ControlInventory>();
try {
  for (const id of sourceIds) inventories.set(id, inventoryControl(project, id));
} catch (error) { die(`ERROR: source validation failed: ${(error as Error).message}`, 1); }
const destinationExists = existsSync(join(project, "__garelier", toPmId, "control"));
let destination: ControlInventory | null = null;
if (destinationExists) {
  try { destination = inventoryControl(project, toPmId); }
  catch (error) { die(`ERROR: destination validation failed: ${(error as Error).message}`, 1); }
}
const owners = new Map<string, { owner: string; file: PortableFile }[]>();
const add = (owner: string, files: PortableFile[]): void => {
  for (const file of files) {
    const entries = owners.get(file.path) ?? [];
    entries.push({ owner, file });
    owners.set(file.path, entries);
  }
};
if (destination) add(`destination:${toPmId}`, destination.files);
for (const [id, inventory] of inventories) add(`source:${id}`, inventory.files);

const pathConflicts = [...owners.entries()].flatMap(([path, entries]) => {
  const hashes = new Set(entries.map((entry) => entry.file.sha256));
  return hashes.size > 1 ? [{ path, owners: entries.map((entry) => entry.owner), revisions: entries.map((entry) => entry.file.revision) }] : [];
}).sort((a, b) => a.path.localeCompare(b.path));
const entityConflicts = [];
const accumulated: PortableFile[] = destination ? [...destination.files] : [];
for (const [id, inventory] of inventories) {
  for (const collision of classifyEntityCollisions(inventory.files, accumulated)) {
    if (collision.classification !== "identical") entityConflicts.push({ source: id, ...collision });
  }
  accumulated.push(...inventory.files);
}
entityConflicts.sort((a, b) => `${a.kind}\0${a.identity}\0${a.source}`.localeCompare(`${b.kind}\0${b.identity}\0${b.source}`));
const schema3RelationConflicts: Array<{
  classification: "owner-relation-id" | "owner-endpoint";
  owner: string;
  relation_id?: string;
  relation?: string;
  target?: string;
  entries: Array<{ source: string; owner: string; path: string; relation_id: string; relation: string; target: string; state: string }>;
}> = [];
{
  const relationRows: Array<{ source: string; owner: string; path: string; relation_id: string; relation: string; target: string; state: string }> = [];
  const collect = (source: string, pmId: string): void => {
    const root = join(project, "__garelier", pmId, "control");
    const model = loadPlanGraphModel(root);
    const errors = model.findings.filter((finding) => finding.severity === "error");
    if (errors.length) throw new Error(`schema3 control is invalid: ${errors.map((finding) => `${finding.code}:${finding.path ?? "-"}`).join(", ")}`);
    for (const edge of model.graph.historicalEdges) {
      if (!/^rel-\d{3,}$/.test(edge.relationId)) continue;
      relationRows.push({ source, owner: edge.from, path: edge.ownerPath, relation_id: edge.relationId, relation: edge.kind, target: edge.to, state: edge.state });
    }
  };
  try {
    if (destination) collect(`destination:${toPmId}`, toPmId);
    for (const id of sourceIds) collect(`source:${id}`, id);
  } catch (error) { die(`ERROR: schema3 relation validation failed: ${(error as Error).message}`, 1); }
  const conflicts = (classification: "owner-relation-id" | "owner-endpoint", key: (row: typeof relationRows[number]) => string): void => {
    const groups = new Map<string, typeof relationRows>();
    for (const row of relationRows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const values = new Set(rows.map((row) => classification === "owner-relation-id" ? `${row.relation}\0${row.target}\0${row.state}` : row.relation_id));
      if (values.size < 2) continue;
      const ordered = [...rows].sort((left, right) => `${left.source}\0${left.path}`.localeCompare(`${right.source}\0${right.path}`));
      schema3RelationConflicts.push({
        classification,
        owner: ordered[0]!.owner,
        ...(classification === "owner-relation-id" ? { relation_id: ordered[0]!.relation_id } : { relation: ordered[0]!.relation, target: ordered[0]!.target }),
        entries: ordered,
      });
    }
  };
  conflicts("owner-relation-id", (row) => `${row.owner}\0${row.relation_id}`);
  conflicts("owner-endpoint", (row) => `${row.owner}\0${row.relation}\0${row.target}\0${row.state}`);
  schema3RelationConflicts.sort((left, right) => `${left.classification}\0${left.owner}\0${left.relation_id ?? left.relation ?? ""}\0${left.target ?? ""}`.localeCompare(`${right.classification}\0${right.owner}\0${right.relation_id ?? right.relation ?? ""}\0${right.target ?? ""}`));
}
const overlaps = [...owners.values()].filter((entries) => entries.length > 1).length;
const plan = {
  schema_version: 2,
  kind: "control_consolidation_plan",
  schema: 3,
  destination: toPmId,
  destination_exists: destinationExists,
  sources: sourceIds,
  source_revisions: Object.fromEntries([...inventories].map(([id, inventory]) => [id, inventory.controlRevision])),
  destination_revision: destination?.controlRevision ?? null,
  distinct_paths: owners.size,
  identical_overlaps: overlaps - pathConflicts.length,
  path_conflicts: pathConflicts,
  entity_conflicts: entityConflicts,
  relation_conflicts: schema3RelationConflicts,
  relation_closure: "strict source PlanGraph validation and owner-relation conflict scan",
};

console.log(`Control consolidation plan: ${sourceIds.join(",")} -> ${toPmId}`);
console.log(`Schema: v${plan.schema}; distinct paths: ${plan.distinct_paths}; path conflicts: ${pathConflicts.length}; entity conflicts: ${entityConflicts.length}; relation conflicts: ${schema3RelationConflicts.length}`);
for (const conflict of pathConflicts) console.log(`  PATH-CONFLICT ${conflict.path}: ${conflict.owners.join(", ")}`);
for (const conflict of entityConflicts) console.log(`  ENTITY-CONFLICT ${conflict.kind}:${conflict.identity} ${conflict.classification}`);
for (const conflict of schema3RelationConflicts) console.log(`  RELATION-CONFLICT ${conflict.classification} ${conflict.owner}:${conflict.relation_id ?? `${conflict.relation}->${conflict.target}`}`);
if (!apply) {
  console.log("Dry run only. Re-run with --apply to create a deterministic gitignored staging batch; source controls remain unchanged.");
  process.exit(0);
}

const batchRoot = join(project, "__garelier", toPmId, "runtime", "import", "consolidation", batchId);
try {
  assertSafeFilesystemPath(project, "consolidation project root");
  assertSafePathWithin(project, batchRoot, "consolidation staging root", false);
} catch (error) { die(`ERROR: unsafe consolidation staging path: ${(error as Error).message}`, 1); }
if (existsSync(batchRoot)) die(`ERROR: batch already exists: ${batchRoot}`);
for (const [id, inventory] of inventories) {
  for (const file of inventory.files) {
    if (sha256File(file.absolutePath) !== file.sha256) die(`ERROR: source changed before staging: ${id}/${file.path}`, 1);
    const target = join(batchRoot, "sources", id, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    try { assertSafePathWithin(project, dirname(target), `consolidation parent for ${id}/${file.path}`); }
    catch (error) { die(`ERROR: unsafe consolidation staging path: ${(error as Error).message}`, 1); }
    copyFileSync(file.absolutePath, target);
    if (sha256File(file.absolutePath) !== file.sha256 || sha256File(target) !== file.sha256) die(`ERROR: source changed during staging: ${id}/${file.path}`, 1);
  }
}
mkdirSync(join(batchRoot, "drafts"), { recursive: true });
mkdirSync(join(batchRoot, "reports"), { recursive: true });
writeFileSync(join(batchRoot, "reports", "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
writeFileSync(join(batchRoot, "reports", "plan.md"), `# Control Consolidation Staging Report\n\n- Destination: \`${toPmId}\`\n- Sources: ${sourceIds.join(", ")}\n- Schema: v${plan.schema}\n- Path conflicts: ${pathConflicts.length}\n- Entity/revision conflicts: ${entityConflicts.length}\n\nSee \`plan.json\` for the deterministic typed reconciliation plan. Source namespaces remain unchanged; destination control is not written.\n`, "utf8");
console.log(`Staged consolidation batch: ${batchRoot}`);
