#!/usr/bin/env bun
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { classifyEntityCollisions, inventoryControl, isPersistentSupportFile, readAndVerifyBundle, schemaFromControlToml, sha256File, snapshotVerifiedBundle, type PortableFile } from "../../garelier-core/driver/src/control/portability.ts";
import { assertSafeFilesystemPath, assertSafePathWithin } from "../../garelier-core/driver/src/control/roots.ts";
import { loadPlanGraphModel } from "../../garelier-core/driver/src/control/plan_graph_model.ts";
import { acquireNamespaceLock, resolveControlNamespaceForLock, type NamespaceLock } from "../../garelier-core/driver/src/control/transaction.ts";
import { beginControlGeneration, initializeControlGeneration, type ControlGenerationLease } from "../../garelier-core/driver/src/control/generation.ts";
import { argValue, autoDetectPm, die, hasFlag, validPmId } from "../../garelier-core/scripts/script_common.ts";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("usage: control_import.ts --from <bundle-dir> [--pm-id <id>] [--project <root>] [--apply] [--trust-persistent-authority]");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (["--pm-id", "--project", "--from"].includes(args[i])) i++;
  else if (["--apply", "--trust-persistent-authority"].includes(args[i])) continue;
  else die(`ERROR: unknown argument: ${args[i]}`);
}

if (!argValue(args, "--from")) die("ERROR: --from <bundle-dir> is required (the input source must be specified).");
const project = resolve(argValue(args, "--project", process.cwd()));
const src = resolve(argValue(args, "--from"));
const apply = hasFlag(args, "--apply");
const trustPersistentAuthority = hasFlag(args, "--trust-persistent-authority");
const explicitPm = argValue(args, "--pm-id");

let manifest: ReturnType<typeof readAndVerifyBundle>;
try { manifest = readAndVerifyBundle(src); }
catch (error) { die(`ERROR: invalid control bundle: ${(error as Error).message}`, 1); }
if (trustPersistentAuthority && manifest.provenance !== "garelier_self_authored") {
  die("ERROR: --trust-persistent-authority requires a current Garelier self-authored bundle; legacy/external bundles remain quarantined.", 1);
}

const garelierRoot = join(project, "__garelier");
let pmId: string;
if (explicitPm) pmId = explicitPm;
else {
  if (!existsSync(garelierRoot)) die(`ERROR: not a Garelier project (no __garelier/): ${project}; pass --pm-id to create a control namespace.`);
  pmId = autoDetectPm(project);
}
if (!validPmId(pmId)) die(`ERROR: invalid pm_id '${pmId}'.`);

try {
  assertSafeFilesystemPath(project, "control import project root");
  assertSafePathWithin(project, garelierRoot, "control import Garelier root", false);
  assertSafePathWithin(project, join(garelierRoot, pmId), "control import PM root", false);
} catch (error) { die(`ERROR: unsafe import destination: ${(error as Error).message}`, 1); }
const dest = join(garelierRoot, pmId, "control");
const destMarker = join(dest, "control.toml");
const incoming = manifest.files.filter((file) => file.path !== "control/control.toml");
const persistentSupport = incoming.filter((file) => isPersistentSupportFile(file.path));
const authorityIncoming = trustPersistentAuthority ? incoming : incoming.filter((file) => !isPersistentSupportFile(file.path));
const authorityPaths = new Set(authorityIncoming.map((file) => file.path));

interface ImportAnalysis {
  existingFiles: PortableFile[];
  identical: string[];
  pathCollisions: string[];
  newFiles: PortableFile[];
  quarantinedFiles: PortableFile[];
  entityCollisions: ReturnType<typeof classifyEntityCollisions>;
  blocked: boolean;
  destinationSchema: 3 | null;
}

function analyzeDestination(): ImportAnalysis {
  let existingFiles: PortableFile[] = [];
  let destinationSchema: 3 | null = null;
  if (existsSync(dest)) {
    const info = lstatSync(dest);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`destination control path must be a real directory: ${dest}`);
    if (!existsSync(destMarker)) throw new Error(`existing destination has no control.toml: ${dest}`);
    const parsed = schemaFromControlToml(dest);
    destinationSchema = parsed;
    if (destinationSchema !== manifest.controlSchemaVersion) {
      throw new Error(`schema mismatch: bundle is v${manifest.controlSchemaVersion}, destination is v${destinationSchema}`);
    }
    existingFiles = inventoryControl(project, pmId).files;
  }
  const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
  const identical: string[] = [];
  const pathCollisions: string[] = [];
  const newFiles: PortableFile[] = [];
  for (const file of incoming) {
    const current = existingByPath.get(file.path);
    if (!current) {
      if (authorityPaths.has(file.path)) newFiles.push(file);
    } else if (current.sha256 === file.sha256) identical.push(file.path);
    else pathCollisions.push(file.path);
  }
  const quarantinedFiles = trustPersistentAuthority ? [] : persistentSupport.filter((file) => !existingByPath.has(file.path));
  const entityCollisions = classifyEntityCollisions(incoming, existingFiles).filter((collision) => collision.classification !== "identical");
  return {
    existingFiles, identical, pathCollisions, newFiles, quarantinedFiles, entityCollisions,
    blocked: pathCollisions.length > 0 || entityCollisions.length > 0,
    destinationSchema,
  };
}

function printAnalysis(analysis: ImportAnalysis): void {
  console.log("");
  console.log(`==> Control import into PM '${pmId}' (mode: ${apply ? "APPLY" : "DRY-RUN"})`);
  console.log(`    bundle: schema v${manifest.controlSchemaVersion}, revision ${manifest.controlRevision}`);
  console.log(`    provenance: ${manifest.provenance}; persistent authority: ${trustPersistentAuthority ? "explicitly trusted" : "review required / quarantined"}`);
  console.log(`    new authority files: ${analysis.newFiles.length}   quarantined support files: ${analysis.quarantinedFiles.length}   identical: ${analysis.identical.length}   collisions: ${analysis.pathCollisions.length + analysis.entityCollisions.length}`);
  for (const file of analysis.quarantinedFiles) console.log(`  QUARANTINE ${file.path}`);
  for (const path of analysis.pathCollisions.sort()) console.log(`  PATH-CONFLICT ${path}`);
  for (const collision of analysis.entityCollisions) {
    console.log(`  ENTITY-CONFLICT ${collision.kind}:${collision.identity} ${collision.classification} incoming-r${collision.incomingRevision ?? "?"} existing-r${collision.existingRevision ?? "?"} (${collision.incomingPath} vs ${collision.existingPath})`);
  }
}

function waitAtTestBarrier(): void {
  const configured = process.env.GARELIER_TEST_CONTROL_IMPORT_BARRIER;
  if (!configured || process.env.NODE_ENV !== "test") return;
  const barrier = resolve(configured);
  assertSafePathWithin(project, barrier, "control import test barrier");
  const ready = join(barrier, "ready");
  const release = join(barrier, "release");
  writeFileSync(ready, "ready\n", "utf8");
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  while (!existsSync(release)) {
    if (Date.now() >= deadline) throw new Error("control import test barrier timed out");
    Atomics.wait(waitCell, 0, 0, 20);
  }
}

if (!apply) {
  let analysis: ImportAnalysis;
  try { analysis = analyzeDestination(); }
  catch (error) { die(`ERROR: destination validation failed: ${(error as Error).message}`, 1); }
  printAnalysis(analysis);
  console.log("");
  console.log("Dry run only - nothing written, including directories.");
  console.log(analysis.blocked ? "Resolve every reported collision before --apply." : `Re-run with --apply to write ${analysis.newFiles.length} authority file(s) and quarantine ${analysis.quarantinedFiles.length} support file(s).`);
  process.exit(0);
}

const pmRoot = dirname(dest);
const pmRootExisted = existsSync(pmRoot);
const quarantineId = manifest.controlRevision.replace(/^sha256:/, "").slice(0, 16);
const quarantineDest = join(pmRoot, "runtime", "import", "quarantine", quarantineId);
let analysis: ImportAnalysis | null = null;
let namespaceLock: NamespaceLock | null = null;
let generation: ControlGenerationLease | null = null;
let canonicalResolved = false;
let staging: string | null = null;
let backupControl: string | null = null;
let quarantineStaging: string | null = null;
let swapped = false;
let quarantineInstalled = false;
try {
  const lockPaths = resolveControlNamespaceForLock({ targetRoot: project, pmId, allowMissingControl: true });
  namespaceLock = acquireNamespaceLock(lockPaths, {
    sessionId: `control-import-${process.pid}`,
    operation: "control-import",
    at: new Date().toISOString(),
  });
  // Re-check all path components after the lock directories have been created.
  resolveControlNamespaceForLock({ targetRoot: project, pmId, allowMissingControl: true });
  analysis = analyzeDestination();
  printAnalysis(analysis);
  if (analysis.blocked) throw new Error("import refused because collisions require explicit reconciliation; no files were written");
  if (analysis.quarantinedFiles.length && existsSync(quarantineDest)) throw new Error(`quarantine batch already exists: ${quarantineDest}`);
  waitAtTestBarrier();

  assertSafePathWithin(project, pmRoot, "control import PM root");
  staging = mkdtempSync(join(pmRoot, ".control-import-"));
  assertSafePathWithin(pmRoot, staging, "control import staging");
  const stagedControl = join(staging, "control");
  backupControl = join(staging, "previous-control");
  const snapshotRoot = join(staging, "verified-bundle");
  quarantineStaging = join(staging, "quarantine");

  const frozen = snapshotVerifiedBundle(src, snapshotRoot);
  if (frozen.manifest.manifestSha256 !== manifest.manifestSha256 || frozen.manifest.controlRevision !== manifest.controlRevision || frozen.manifest.pmId !== manifest.pmId) {
    throw new Error("bundle identity changed between validation and snapshot");
  }
  const frozenByPath = new Map(frozen.manifest.files.map((file) => [file.path, file]));
  mkdirSync(stagedControl, { recursive: true });
  for (const file of analysis.existingFiles) {
    if (lstatSync(file.absolutePath).isSymbolicLink() || sha256File(file.absolutePath) !== file.sha256) throw new Error(`destination changed while staging: ${file.path}`);
    const relativePath = file.path.slice("control/".length);
    const target = join(stagedControl, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.absolutePath, target);
    if (sha256File(file.absolutePath) !== file.sha256 || sha256File(target) !== file.sha256) throw new Error(`destination changed during staging: ${file.path}`);
  }
  for (const file of analysis.newFiles) {
    const frozenFile = frozenByPath.get(file.path);
    if (!frozenFile) throw new Error(`verified snapshot is missing ${file.path}`);
    const relativePath = file.path.slice("control/".length);
    const target = join(stagedControl, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(frozenFile.absolutePath, target);
    if (sha256File(target) !== file.sha256) throw new Error(`staged authority copy mismatch: ${file.path}`);
  }
  if (analysis.quarantinedFiles.length) {
    for (const file of analysis.quarantinedFiles) {
      const frozenFile = frozenByPath.get(file.path);
      if (!frozenFile) throw new Error(`verified snapshot is missing ${file.path}`);
      const target = join(quarantineStaging!, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(frozenFile.absolutePath, target);
      if (sha256File(target) !== file.sha256) throw new Error(`quarantine copy mismatch: ${file.path}`);
    }
    writeFileSync(join(quarantineStaging, "REVIEW_REQUIRED.json"), `${JSON.stringify({
      schema_version: 1,
      kind: "garelier_import_quarantine",
      source_pm_id: manifest.pmId,
      control_revision: manifest.controlRevision,
      provenance: manifest.provenance,
      authority: "none",
      files: analysis.quarantinedFiles.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    }, null, 2)}\n`, "utf8");
  }

  if (!existsSync(join(stagedControl, "control.toml"))) {
    const markerSource = readFileSync(join(snapshotRoot, "control", "control.toml"), "utf8")
      .replace(/^pm_id\s*=\s*.*$/m, `pm_id = ${JSON.stringify(pmId)}`)
      .replace(/^mode\s*=\s*.*$/m, 'mode = "control_only"');
    writeFileSync(join(stagedControl, "control.toml"), markerSource, "utf8");
  }

  const staged = loadPlanGraphModel(stagedControl);
  const stagedErrors = staged.findings.filter((finding) => finding.severity === "error");
  if (stagedErrors.length) throw new Error(stagedErrors.map((finding) => `${finding.code}: ${finding.message}`).join("\n"));

  // The inventory and every staged destination byte were captured while the
  // namespace lock was held. Re-inventory immediately before the directory
  // swap so an out-of-band writer cannot be silently overwritten either.
  const current = analyzeDestination();
  const inventoryKey = (files: PortableFile[]): string => files
    .map((file) => `${file.path}\0${file.sha256}\0${file.bytes}`)
    .sort()
    .join("\n");
  if (current.destinationSchema !== analysis.destinationSchema || inventoryKey(current.existingFiles) !== inventoryKey(analysis.existingFiles)) {
    throw new Error("destination revision/source inventory changed during import; abort and re-plan");
  }

  assertSafePathWithin(project, dest, "control import destination", existsSync(dest));
  generation = existsSync(dest)
    ? beginControlGeneration(lockPaths, { sessionId: `control-import-${process.pid}`, operation: "control-import", at: new Date().toISOString() })
    : null;
  canonicalResolved = true;
  if (existsSync(dest)) {
    renameSync(dest, backupControl);
    canonicalResolved = false;
  }
  try {
    renameSync(stagedControl, dest);
    swapped = true;
    if (!generation) {
      initializeControlGeneration(lockPaths, {
        sessionId: `control-import-${process.pid}`,
        operation: "control-import-create",
        at: new Date().toISOString(),
      });
    }
    const installed = loadPlanGraphModel(dest);
    const installedErrors = installed.findings.filter((finding) => finding.severity === "error");
    if (installedErrors.length) throw new Error(installedErrors.map((finding) => `${finding.code}: ${finding.message}`).join("\n"));
    if (process.env.NODE_ENV === "test" && process.env.GARELIER_TEST_CONTROL_IMPORT_FAIL_AFTER_SWAP === "1") {
      throw new Error("injected post-swap import failure");
    }
    if (analysis.quarantinedFiles.length) {
      const quarantineParent = dirname(quarantineDest);
      assertSafePathWithin(project, quarantineParent, "control import quarantine parent", false);
      mkdirSync(quarantineParent, { recursive: true });
      assertSafePathWithin(project, quarantineParent, "control import quarantine parent");
      assertSafePathWithin(project, quarantineDest, "control import quarantine destination", false);
      renameSync(quarantineStaging, quarantineDest);
      quarantineInstalled = true;
    }
    canonicalResolved = true;
    generation?.settle();
  } catch (error) {
    if (quarantineInstalled && existsSync(quarantineDest)) renameSync(quarantineDest, quarantineStaging!);
    if (swapped && existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    if (backupControl && existsSync(backupControl)) renameSync(backupControl, dest);
    swapped = false;
    canonicalResolved = true;
    throw error;
  }
} catch (error) {
  if (swapped) {
    if (quarantineInstalled && existsSync(quarantineDest)) rmSync(quarantineDest, { recursive: true, force: true });
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    if (backupControl && existsSync(backupControl)) renameSync(backupControl, dest);
    canonicalResolved = true;
  }
  console.error(`ERROR: import failed and the destination was rolled back: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  if (staging && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  try { if (canonicalResolved) generation?.settle(); }
  catch (error) {
    console.error(`ERROR: import canonical state was resolved but its Control generation could not be marked stable: ${(error as Error).message}`);
    process.exitCode = 1;
  }
  try { namespaceLock?.release(); }
  catch (error) {
    console.error(`ERROR: import completed but the Control namespace lock could not be released safely: ${(error as Error).message}`);
    process.exitCode = 1;
  }
  if (!pmRootExisted) {
    try { rmdirSync(pmRoot); } catch {}
  }
}

if (process.exitCode) process.exit(process.exitCode);

console.log("");
console.log(`==> Wrote ${analysis!.newFiles.length} new file(s) into ${dest}`);
if (analysis!.quarantinedFiles.length) console.log(`==> Quarantined ${analysis!.quarantinedFiles.length} review-required support file(s) at ${quarantineDest}`);
console.log("Review, validate, then commit the control/ changes (run commit-hygiene first).");
