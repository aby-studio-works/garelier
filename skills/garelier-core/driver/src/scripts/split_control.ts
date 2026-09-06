#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadPlanGraphModel } from "../control/plan_graph_model.ts";
import { assertPortableRelativePath, inventoryControl, sha256File } from "../control/portability.ts";
import { assertSafeFilesystemPath, assertSafePathWithin } from "../control/roots.ts";
import { argValue, die, hasFlag, validPmId } from "../../../scripts/script_common.ts";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: split_control.ts --to-pm-id <id> --select <control-relative-path>... [--from-pm-id _workshop] [--project <root>] [--batch-id <id>] [--apply]");
  process.exit(0);
}
const project = resolve(argValue(args, "--project", process.cwd()));
const fromPmId = argValue(args, "--from-pm-id", "_workshop");
const toPmId = argValue(args, "--to-pm-id");
const stamp = process.env.GARELIER_NOW ?? new Date().toISOString();
const batchId = argValue(args, "--batch-id", stamp.replace(/[-:]/g, "").slice(0, 8) + "-" + stamp.replace(/[-:]/g, "").slice(9, 15));
const apply = hasFlag(args, "--apply");
const selections: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (["--project", "--from-pm-id", "--to-pm-id", "--batch-id"].includes(args[i])) i++;
  else if (args[i] === "--select") selections.push(args[++i] ?? "");
  else if (args[i] !== "--apply") die(`ERROR: unknown argument: ${args[i]}`);
}
if (!validPmId(fromPmId)) die(`ERROR: invalid source pm_id '${fromPmId}'`);
if (!toPmId || !validPmId(toPmId)) die("ERROR: valid --to-pm-id is required");
if (fromPmId === toPmId) die("ERROR: source and destination pm_id must differ");
if (selections.length === 0) die("ERROR: at least one --select is required");

let inventory;
try { inventory = inventoryControl(project, fromPmId); }
catch (error) { die(`ERROR: source validation failed: ${(error as Error).message}`, 1); }
const byRel = new Map(inventory.files.map((file) => [file.path.slice("control/".length), file]));
const selected = new Set<string>();
for (const raw of selections) {
  let rel: string;
  try { rel = assertPortableRelativePath(raw, ""); }
  catch (error) { die(`ERROR: ${(error as Error).message}`); }
  const matches = [...byRel.keys()].filter((path) => path === rel || path.startsWith(`${rel}/`));
  if (matches.length === 0) die(`ERROR: selection matched no portable control files: ${raw}`);
  for (const path of matches) selected.add(path);
}

const direct = new Set(selected);
const dependencyEdges: { from: string; to: string; relation: string }[] = [];
if (inventory.schemaVersion === 3) {
  const controlRoot = join(project, "__garelier", fromPmId, "control");
  const model = loadPlanGraphModel(controlRoot);
  const errors = model.findings.filter((finding) => finding.severity === "error");
  if (errors.length) die(`ERROR: schema3 source validation failed: ${errors.map((finding) => `${finding.code}:${finding.path ?? "-"}`).join(", ")}`, 1);

  const pathByEntity = new Map<string, string>();
  const addEntity = (entity: string, path: string): void => { pathByEntity.set(entity, path); };
  for (const record of model.roadmaps.values()) addEntity(`roadmap:${record.slug}`, record.path);
  for (const record of model.milestones.values()) addEntity(`milestone:${record.slug}`, record.path);
  for (const record of model.backlog.values()) addEntity(`backlog:${record.id}`, record.path);
  for (const record of model.backlogViews.values()) addEntity(`backlog-view:${record.slug}`, record.path);
  for (const record of model.checkpoints.values()) addEntity(`checkpoint:${record.id}`, record.path);
  for (const record of model.notes) addEntity(`note:${record.id}`, record.path);
  for (const record of model.decisions.values()) addEntity(`decision:${record.id}`, record.path);
  for (const record of model.blueprints.values()) addEntity(`blueprint:${record.id}`, record.path);

  const normaliseBacklog = (value: string): string => /^W-\d+$/.test(value) ? `backlog:${value}` : value;
  const semanticEdges: Array<{ from: string; to: string; relation: string }> = model.graph.edges.map((edge) => ({ from: edge.from, to: edge.to, relation: edge.kind }));
  for (const record of model.backlog.values()) {
    const from = `backlog:${record.id}`;
    for (const target of record.blockedBy) semanticEdges.push({ from, to: normaliseBacklog(target), relation: "backlog-blocked-by" });
    for (const target of record.related) semanticEdges.push({ from, to: normaliseBacklog(target), relation: "backlog-related" });
    if (record.replacement) semanticEdges.push({ from, to: normaliseBacklog(record.replacement), relation: "backlog-replacement" });
  }
  for (const record of [...model.decisions.values(), ...model.blueprints.values()]) {
    for (const target of record.related) semanticEdges.push({ from: `${record.kind}:${record.id}`, to: normaliseBacklog(target), relation: `${record.kind}-related` });
  }
  for (const record of model.notes) {
    for (const target of record.related) semanticEdges.push({ from: `note:${record.id}`, to: normaliseBacklog(target), relation: "note-related" });
  }
  if (model.current) {
    for (const id of model.current.checkpointCandidates) semanticEdges.push({ from: "current", to: `checkpoint:${id}`, relation: "current-checkpoint" });
  }

  const namespaceFiles = ["control.toml", "project_dashboard/current.md", "project_dashboard/notes.md"];
  for (const path of namespaceFiles) if (byRel.has(path)) selected.add(path);
  const selectedEntity = (entity: string): boolean => entity === "current"
    ? selected.has("project_dashboard/current.md")
    : Boolean(pathByEntity.get(entity) && selected.has(pathByEntity.get(entity)!));
  const add = (from: string, to: string, relation: string): void => {
    const fromPath = from === "current" ? "project_dashboard/current.md" : pathByEntity.get(from);
    const toPath = pathByEntity.get(to);
    if (!fromPath || !toPath || !byRel.has(fromPath) || !byRel.has(toPath)) return;
    dependencyEdges.push({ from: fromPath, to: toPath, relation });
    selected.add(toPath);
  };
  let changed = true;
  while (changed) {
    const before = selected.size;
    for (const edge of semanticEdges) {
      if (selectedEntity(edge.from)) add(edge.from, edge.to, edge.relation);
      if (selectedEntity(edge.to)) add(edge.to, edge.from, edge.relation);
    }
    changed = selected.size !== before;
  }
}

const files = [...selected].sort().map((path) => byRel.get(path)!);
dependencyEdges.sort((a, b) => `${a.from}\0${a.relation}\0${a.to}`.localeCompare(`${b.from}\0${b.relation}\0${b.to}`));
const uniqueEdges = dependencyEdges.filter((edge, index) => index === 0 || JSON.stringify(edge) !== JSON.stringify(dependencyEdges[index - 1]));
const plan = {
  schema_version: 2,
  kind: "control_split_plan",
  control_schema: inventory.schemaVersion,
  control_revision: inventory.controlRevision,
  source: fromPmId,
  destination: toPmId,
  requested: [...direct].sort(),
  dependency_added: [...selected].filter((path) => !direct.has(path)).sort(),
  files: files.map((file) => ({ path: file.path.slice("control/".length), bytes: file.bytes, sha256: file.sha256, identity: file.identity, revision: file.revision })),
  relation_edges: uniqueEdges,
};

console.log(`Control split plan: ${fromPmId} -> ${toPmId}`);
console.log(`Schema: v${inventory.schemaVersion}; requested files: ${direct.size}; dependency closure added: ${plan.dependency_added.length}; total: ${files.length}`);
for (const file of files) console.log(`  ${file.path.slice("control/".length)}`);
console.log("Source control will remain unchanged. Destination control will not be written directly.");
if (!apply) {
  console.log("Dry run only. Re-run with --apply to create a deterministic gitignored staging batch.");
  process.exit(0);
}

const batchRoot = join(project, "__garelier", toPmId, "runtime", "import", "split", batchId);
try {
  assertSafeFilesystemPath(project, "split project root");
  assertSafePathWithin(project, batchRoot, "split staging root", false);
} catch (error) { die(`ERROR: unsafe split staging path: ${(error as Error).message}`, 1); }
if (existsSync(batchRoot)) die(`ERROR: batch already exists: ${batchRoot}`);
for (const file of files) {
  if (sha256File(file.absolutePath) !== file.sha256) die(`ERROR: source changed before staging: ${file.path}`, 1);
  const target = join(batchRoot, "source", ...file.path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  try { assertSafePathWithin(project, dirname(target), `split parent for ${file.path}`); }
  catch (error) { die(`ERROR: unsafe split staging path: ${(error as Error).message}`, 1); }
  copyFileSync(file.absolutePath, target);
  if (sha256File(file.absolutePath) !== file.sha256 || sha256File(target) !== file.sha256) die(`ERROR: source changed during staging: ${file.path}`, 1);
}
mkdirSync(join(batchRoot, "drafts"), { recursive: true });
mkdirSync(join(batchRoot, "reports"), { recursive: true });
writeFileSync(join(batchRoot, "reports", "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
writeFileSync(join(batchRoot, "reports", "plan.md"), `# Control Split Staging Report\n\n- Source: \`${fromPmId}\`\n- Destination: \`${toPmId}\`\n- Schema: v${inventory.schemaVersion}\n- Requested: ${direct.size}\n- Dependency closure added: ${plan.dependency_added.length}\n\nSee \`plan.json\` for exact files, hashes, revisions, and relation edges. Source authority remains unchanged; destination control is not written.\n`, "utf8");
console.log(`Staged split batch: ${batchRoot}`);
