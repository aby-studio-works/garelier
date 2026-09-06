import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rmSync } from "../guard/path_guard.ts";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { parse as parseToml } from "smol-toml";
import { assertNoSymlinkPath, atomicWriteRuntimeFile, ensureSafeDirectory, type AtomicRuntimeWriteHooks } from "./diagnostics.ts";
import type { ControlNamespacePaths } from "./transaction.ts";
import { canonicalJson, sha256 } from "./serialization.ts";

const MAX_GENERATION_BYTES = 4 * 1024;
const DEFAULT_ATTEMPTS = 16;
const MAX_ATTEMPTS = 2_000;
const RETRY_MS = 5;
const GENERATION_TRANSITION_RE = /^\.generation\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:tmp|previous)$/i;
const GENERATION_SENTINEL_NAME = "generation.initialized.json";
// W-211: durable "this runtime location was activated at least once" evidence, written once
// by initializeControlGeneration and NEVER removed by generation.json's own replace/rename
// cycle (unlike generation.json itself, which is the thing that can legitimately go missing
// mid-transaction or be lost to an external deletion). Distinct from the pre-existing
// GENERATION_SENTINEL_NAME above is an older runtime generation sentinel
// artifact (only ever read/archived here, never written by current code — confirmed via
// `git log -S` on this file; it predates and is unrelated to this marker). Directory
// existence (`existsSync(runtimeRoot)`) is NOT a safe proxy for "was activated" — acquiring
// the namespace lock, opening a session, or writing a diagnostic all create runtimeRoot (or
// subdirectories under it) as an incidental side effect, before generation is ever read, on
// a location that has never actually had a generation established.
const GENERATION_ACTIVATION_MARKER_NAME = "generation.activated.json";

export class ControlGenerationError extends Error {
  constructor(readonly code: string, message: string, readonly generation: number | null = null) {
    super(message);
    this.name = "ControlGenerationError";
  }
}

interface GenerationRecord {
  schema_version: 2;
  kind: "garelier_control_generation";
  control_schema_version?: 3;
  storage?: "plan_graph_markdown";
  incarnation: string;
  generation: number;
  state: "writing" | "stable";
  operation: string;
  session_id: string;
  updated_at: string;
}

interface LegacyGenerationRecord extends Omit<GenerationRecord, "schema_version" | "incarnation"> { schema_version: 1 }

export interface ControlGenerationSnapshot {
  incarnation: string | null;
  generation: number;
  legacy: boolean;
  controlSchemaVersion: 3 | null;
  storage: "plan_graph_markdown" | null;
}

export type CanonicalControlBinding = { controlSchemaVersion: 3; storage: "plan_graph_markdown" };

export interface StableControlReadOptions {
  controlRoot: string;
  runtimeRoot?: string;
  attempts?: number;
}

export interface ControlGenerationLease {
  incarnation: string;
  odd: number;
  even: number;
  settle(): void;
}

function generationActivationMarkerPath(runtimeRoot: string): string {
  return join(resolve(runtimeRoot), GENERATION_ACTIVATION_MARKER_NAME);
}

/**
 * W-211: idempotently record that this runtime location has been activated at
 * least once. Safe to call whenever generation.json is confirmed to exist
 * (freshly created or found already present by a concurrent caller) — this is
 * a small write-once identity file, not part of the generation
 * counter/incarnation protocol, so re-writing identical content on a
 * concurrent race is harmless (last writer wins, same bytes either way in
 * practice; even if not, only the marker's mere EXISTENCE is ever read back).
 */
function markControlGenerationActivated(runtimeRoot: string, binding: CanonicalControlBinding, at: string): void {
  const marker = generationActivationMarkerPath(runtimeRoot);
  if (existsSync(marker) && !lstatSync(marker).isSymbolicLink() && lstatSync(marker).isFile()) return;
  atomicWriteRuntimeFile(resolve(runtimeRoot), marker, canonicalJson({
    schema_version: 1,
    kind: "garelier_control_generation_activation",
    control_schema_version: binding.controlSchemaVersion,
    storage: binding.storage,
    activated_at: at,
  }));
}

/**
 * Backfill the activation marker for a runtime location that already has a
 * real, durable generation.json but predates this marker's introduction
 * (every location that existed before this fix, including live in-use ones —
 * not just fresh worktrees). Cheap in the steady state: a single `existsSync`
 * once the marker is present, which it will be after the first read post-
 * upgrade. Best-effort: a read must never fail because a backfill write raced
 * with a concurrent reader/writer or the location is read-only.
 */
function backfillActivationMarker(snapshot: ControlGenerationSnapshot, controlRoot: string, runtimeRoot: string): ControlGenerationSnapshot {
  if (snapshot.legacy || existsSync(generationActivationMarkerPath(runtimeRoot))) return snapshot;
  try {
    const binding = readCanonicalControlBinding(controlRoot);
    markControlGenerationActivated(runtimeRoot, binding, new Date().toISOString());
  } catch { /* best-effort; the snapshot itself is already valid regardless */ }
  return snapshot;
}

/**
 * Activate the first stable generation for a newly installed transactional
 * namespace. The caller must hold the namespace lock and must call this only
 * after the complete control directory has become visible atomically. The one
 * sanctioned exception is bootstrapping a runtime location that has never been
 * activated (per `generationActivationMarkerPath` — see
 * `readControlGenerationSnapshot`'s fresh-worktree fallback, or
 * setup_wizard/scaffold.ts's fresh/upgrade paths): the activation marker can
 * only ever exist under a runtime root that a REAL prior `initializeControlGeneration`
 * call touched, so its absence means no writer has ever raced here, and this
 * function's own re-probe before writing already tolerates a concurrent
 * bootstrapper regardless.
 */
export function initializeControlGeneration(
  paths: Pick<ControlNamespacePaths, "controlRoot" | "runtimeRoot">,
  owner: { sessionId: string; operation: string; at: string; incarnation?: string },
): ControlGenerationSnapshot {
  const binding = readCanonicalControlBinding(paths.controlRoot);
  const path = controlGenerationPath(paths.runtimeRoot);
  const probe = generationProbe(paths.runtimeRoot, path);
  if (probe.kind === "present") {
    markControlGenerationActivated(paths.runtimeRoot, binding, owner.at);
    return verifyGenerationBinding(probe.snapshot, paths.controlRoot);
  }
  const incarnation = owner.incarnation ?? randomUUID();
  if (!UUID_RE.test(incarnation)) throw new ControlGenerationError("control-generation-incarnation", "planned generation incarnation must be a UUID");
  writeControlGenerationFile(paths.runtimeRoot, renderGeneration({
    schema_version: 2,
    kind: "garelier_control_generation",
    control_schema_version: binding.controlSchemaVersion,
    storage: binding.storage,
    incarnation,
    generation: 0,
    state: "stable",
    operation: owner.operation,
    session_id: owner.sessionId,
    updated_at: owner.at,
  }));
  const initialized = generationProbe(paths.runtimeRoot, path);
  if (initialized.kind !== "present") {
    throw new ControlGenerationError("control-generation-initialize", "new control generation was not durably readable");
  }
  markControlGenerationActivated(paths.runtimeRoot, binding, owner.at);
  return verifyGenerationBinding(initialized.snapshot, paths.controlRoot);
}

export function controlRuntimeRoot(controlRoot: string): string {
  return join(dirname(resolve(controlRoot)), "runtime", "control");
}

export function controlGenerationPath(runtimeRoot: string): string {
  return join(resolve(runtimeRoot), "generation.json");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readCanonicalControlBinding(controlRoot: string): CanonicalControlBinding {
  const path = join(resolve(controlRoot), "control.toml");
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ControlGenerationError("control-binding-missing", `control.toml is missing: ${path}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > 64 * 1024) throw new ControlGenerationError("control-binding-unsafe", `control.toml is unsafe: ${path}`);
  let raw: Record<string, unknown>;
  try { raw = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>; }
  catch (error) { throw new ControlGenerationError("control-binding-malformed", `control.toml is malformed: ${(error as Error).message}`); }
  if (raw.schema_version === 3 && raw.storage === "plan_graph_markdown") return { controlSchemaVersion: 3, storage: "plan_graph_markdown" };
  if (raw.schema_version === 1 || raw.schema_version === 2) {
    throw new ControlGenerationError(
      "control-binding-unsupported-schema",
      `control schema_version ${raw.schema_version} is unsupported; only schema_version 3 with storage plan_graph_markdown is accepted`,
    );
  }
  throw new ControlGenerationError(
    "control-binding-unsupported",
    `unsupported canonical control binding: schema_version=${String(raw.schema_version)} storage=${String(raw.storage)}`,
  );
}

function parseGeneration(source: string, path: string): GenerationRecord | LegacyGenerationRecord {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch (error) { throw new ControlGenerationError("control-generation-malformed", `Control generation is malformed at ${path}: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlGenerationError("control-generation-malformed", `Control generation must be an object: ${path}`);
  const record = value as Record<string, unknown>;
  if ((record.schema_version !== 1 && record.schema_version !== 2) || record.kind !== "garelier_control_generation"
    || typeof record.generation !== "number" || !Number.isSafeInteger(record.generation) || record.generation < 0
    || (record.state !== "writing" && record.state !== "stable")
    || typeof record.operation !== "string" || typeof record.session_id !== "string" || typeof record.updated_at !== "string") {
    throw new ControlGenerationError("control-generation-malformed", `Control generation has invalid fields: ${path}`);
  }
  const generation = record.generation as number;
  if ((generation % 2 === 1) !== (record.state === "writing")) {
    throw new ControlGenerationError("control-generation-parity", `Control generation parity/state mismatch at ${path}`, generation);
  }
  if (record.schema_version === 2 && (typeof record.incarnation !== "string" || !UUID_RE.test(record.incarnation))) {
    throw new ControlGenerationError("control-generation-malformed", `Control generation incarnation is invalid: ${path}`, generation);
  }
  const hasSchemaBinding = record.control_schema_version !== undefined || record.storage !== undefined;
  if (hasSchemaBinding && !(record.control_schema_version === 3 && record.storage === "plan_graph_markdown")) {
    throw new ControlGenerationError("control-generation-binding", `Control generation canonical binding is invalid: ${path}`, generation);
  }
  return record as unknown as GenerationRecord | LegacyGenerationRecord;
}

type GenerationProbe = { kind: "missing" | "transient" } | { kind: "present"; snapshot: ControlGenerationSnapshot; source: string };
function generationSentinelPath(runtimeRoot: string): string { return join(runtimeRoot, GENERATION_SENTINEL_NAME); }

function defaultControlRoot(runtimeRoot: string): string {
  return join(dirname(dirname(resolve(runtimeRoot))), "control");
}

function transactionalControlActivated(controlRoot: string): boolean {
  try { readCanonicalControlBinding(controlRoot); return true; }
  catch (error) {
    if (error instanceof ControlGenerationError && error.code === "control-binding-missing") return false;
    throw error;
  }
}

function generationTransitionExists(runtimeRoot: string): boolean {
  try { return readdirSync(runtimeRoot, { withFileTypes: true }).some((entry) => GENERATION_TRANSITION_RE.test(entry.name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ControlGenerationError("control-generation-io", `Cannot inspect control generation transitions at ${runtimeRoot}: ${(error as Error).message}`);
  }
}

function generationProbe(runtimeRoot: string, path: string): GenerationProbe {
  try { assertNoSymlinkPath(runtimeRoot, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "transient" };
    throw error;
  }
  let before;
  try { before = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new ControlGenerationError("control-generation-io", `Cannot inspect control generation at ${path}: ${(error as Error).message}`);
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new ControlGenerationError("control-generation-file-type", `Control generation must be a regular file: ${path}`);
  if (before.size > MAX_GENERATION_BYTES) throw new ControlGenerationError("control-generation-too-large", `Control generation exceeds ${MAX_GENERATION_BYTES} bytes: ${path}`);
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "transient" };
    throw new ControlGenerationError("control-generation-io", `Cannot read control generation at ${path}: ${(error as Error).message}`);
  }
  let after;
  try { after = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "transient" };
    throw new ControlGenerationError("control-generation-io", `Cannot verify control generation at ${path}: ${(error as Error).message}`);
  }
  if (after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { kind: "transient" };
  const record = parseGeneration(source, path);
  return {
    kind: "present",
    source,
    snapshot: {
      incarnation: record.schema_version === 2 ? record.incarnation : null,
      generation: record.generation,
      legacy: record.schema_version === 1,
      controlSchemaVersion: record.schema_version === 2 ? record.control_schema_version ?? null : null,
      storage: record.schema_version === 2 ? record.storage ?? null : null,
    },
  };
}

function verifyGenerationBinding(snapshot: ControlGenerationSnapshot, controlRoot: string): ControlGenerationSnapshot {
  const binding = readCanonicalControlBinding(controlRoot);
  if (snapshot.controlSchemaVersion === null && snapshot.storage === null) {
    if (binding.controlSchemaVersion === 3 && !snapshot.legacy) {
      throw new ControlGenerationError("control-generation-binding-missing", "Schema-3 generation records require an explicit canonical control binding.", snapshot.generation);
    }
    return snapshot;
  }
  if (snapshot.controlSchemaVersion !== binding.controlSchemaVersion || snapshot.storage !== binding.storage) {
    throw new ControlGenerationError(
      "control-generation-binding-mismatch",
      `Generation is bound to schema ${snapshot.controlSchemaVersion}/${snapshot.storage}, canonical control is ${binding.controlSchemaVersion}/${binding.storage}.`,
      snapshot.generation,
    );
  }
  return snapshot;
}

export function readControlGenerationSnapshot(runtimeRoot: string, attempts = DEFAULT_ATTEMPTS, controlRoot = defaultControlRoot(runtimeRoot)): ControlGenerationSnapshot {
  const root = resolve(runtimeRoot);
  const path = controlGenerationPath(root);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) throw new ControlGenerationError("control-generation-attempts", `generation read attempts must be 1..${MAX_ATTEMPTS}`);
  const cutoverMarker = join(root, "recovery", "schema3-cutover.json");
  if (existsSync(cutoverMarker)) {
    assertNoSymlinkPath(root, cutoverMarker);
    const active = writerLockExists(root);
    throw new ControlGenerationError(
      active ? "control-generation-busy" : "control-generation-recovery-required",
      active
        ? "Schema-3 cutover is in progress; retry after the namespace writer settles."
        : "Schema-3 cutover recovery marker exists without a live writer; explicit cutover recovery is required.",
    );
  }
  let observedTransition = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const first = generationProbe(root, path);
    if (first.kind === "present") return backfillActivationMarker(verifyGenerationBinding(first.snapshot, controlRoot), controlRoot, root);
    if (first.kind === "transient" || generationTransitionExists(root)) {
      observedTransition = true;
      pause();
      continue;
    }
    const second = generationProbe(root, path);
    if (second.kind === "present") return backfillActivationMarker(verifyGenerationBinding(second.snapshot, controlRoot), controlRoot, root);
    if (second.kind === "transient" || generationTransitionExists(root)) {
      observedTransition = true;
      pause();
      continue;
    }
    if (!observedTransition && !transactionalControlActivated(controlRoot)) {
      return { incarnation: null, generation: 0, legacy: true, controlSchemaVersion: null, storage: null };
    }
    // Freshly checked-out worktree/lane: canonical schema-3 control is already
    // committed and visible at controlRoot, but this runtime location has never been
    // ACTIVATED (per generationActivationMarkerPath — W-211). Directory existence is
    // NOT the signal: acquiring the namespace lock, opening a session, or writing a
    // diagnostic all create runtimeRoot (or subdirectories under it) as an incidental
    // side effect before generation is ever read, so a lock/session/diagnostic write
    // that happens to run first in the SAME command would otherwise falsify a
    // directory-existence check on a location that has never actually had a
    // generation established. The activation marker is written ONLY by
    // initializeControlGeneration (fresh or backfilled on the first successful read
    // of a pre-existing generation.json above). A crash-interrupted writer is still
    // caught even on a pre-marker tree, marker or not: atomicWriteRuntimeFile leaves a
    // `.tmp`/`.previous` transition file behind on a hard crash between renames, which
    // generationTransitionExists detects and observedTransition gates on above. The one
    // residual window this leaves open (Guardian N1, non-blocking): a location that
    // predates this marker, has NEVER had a single successful read under this code yet,
    // and loses generation.json to something OTHER than a crash (external deletion,
    // partial restore) has no marker to prove prior activation and is misread as
    // "never activated" here instead of requiring explicit recovery. That window is
    // narrow and self-closing — any one successful read of the pre-existing
    // generation.json backfills the marker permanently — but it is real until then, so
    // this only self-heals the genuinely "never activated" case and stays fail-closed
    // once the marker exists, seeding generation 0/stable durably so future reads (this
    // process and others) see a real file instead of a fabricated snapshot.
    if (!observedTransition && !existsSync(generationActivationMarkerPath(root))) {
      return initializeControlGeneration({ controlRoot, runtimeRoot: root }, {
        sessionId: "cs_generation_bootstrap", operation: "generation-read-bootstrap", at: new Date().toISOString(),
      });
    }
    pause();
  }
  const active = writerLockExists(root);
  const code = transactionalControlActivated(controlRoot) && !active ? "control-generation-recovery-required" : "control-generation-busy";
  throw new ControlGenerationError(
    code,
    code === "control-generation-recovery-required"
      ? "Generation was initialized but generation.json is missing without a live writer; explicit generation recovery is required."
      : `Control generation replacement did not settle within ${attempts} bounded attempts; retry after the active writer completes.`,
  );
}

/** Counter-only compatibility API. Stable readers compare full snapshots. */
export function readControlGeneration(runtimeRoot: string, attempts = DEFAULT_ATTEMPTS, controlRoot = defaultControlRoot(runtimeRoot)): number {
  return readControlGenerationSnapshot(runtimeRoot, attempts, controlRoot).generation;
}

/**
 * Force the fresh-worktree bootstrap fallback (above) to run before any other
 * write touches `runtimeRoot` (W-211). `readControlGenerationSnapshot`'s own
 * fallback only fires when `runtimeRoot` is provably untouched; a command that
 * writes runtime state itself (e.g. `session-open`'s namespace lock + session
 * record) before it ever reads the generation would otherwise falsify that
 * signal by the time the read happens, in the same invocation, on the same
 * genuinely-fresh worktree. Call this for schema-3 session-open (control.ts),
 * or any future command that writes
 * before it reads. Deliberately NOT wired into the shared
 * `acquireNamespaceLock` primitive: every OTHER lock acquisition (claim, write
 * transactions) requires an already-open `--session`, and opening that session
 * already bootstraps generation, so a blanket fix there would add a redundant
 * generation read (and its retry budget) to every lock acquisition for no
 * behavioral gain — call this explicitly only at the entry points that can be
 * first to touch a truly virgin runtime location.
 */
export function ensureControlGenerationBootstrapped(controlRoot: string, runtimeRoot: string): void {
  readControlGenerationSnapshot(runtimeRoot, DEFAULT_ATTEMPTS, controlRoot);
}

function writerLockExists(runtimeRoot: string): boolean {
  const path = join(resolve(runtimeRoot), "locks", "namespace.lock");
  if (!existsSync(path)) return false;
  assertNoSymlinkPath(resolve(runtimeRoot), path);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_GENERATION_BYTES) return false;
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; hostname?: unknown };
    if (!Number.isInteger(lock.pid) || (lock.pid as number) < 1 || lock.hostname !== hostname()) return false;
    try { process.kill(lock.pid as number, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  } catch { return false; }
}

function pause(): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, RETRY_MS);
}

/**
 * Accept a read only when the full callback ran between the same stable even
 * generation. The callback may throw while a writer is between renames; such
 * an error is retried only when the generation proves the snapshot unstable.
 */
export function readStableControl<T>(options: StableControlReadOptions, callback: () => T): T {
  const runtimeRoot = resolve(options.runtimeRoot ?? controlRuntimeRoot(options.controlRoot));
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new ControlGenerationError("control-generation-attempts", `stable read attempts must be 1..${MAX_ATTEMPTS}`);
  }
  let lastGeneration: number | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = readControlGenerationSnapshot(runtimeRoot, DEFAULT_ATTEMPTS, options.controlRoot);
    lastGeneration = before.generation;
    if (before.generation % 2 === 1) { pause(); continue; }
    let value: T | undefined;
    let readError: unknown;
    try { value = callback(); } catch (error) { readError = error; }
    const after = readControlGenerationSnapshot(runtimeRoot, DEFAULT_ATTEMPTS, options.controlRoot);
    lastGeneration = after.generation;
    if (before.incarnation === after.incarnation && before.generation === after.generation && after.generation % 2 === 0) {
      if (readError) throw readError;
      return value as T;
    }
    pause();
  }
  const active = writerLockExists(runtimeRoot);
  const code = lastGeneration !== null && lastGeneration % 2 === 1 && !active
    ? "control-generation-recovery-required"
    : "control-generation-busy";
  throw new ControlGenerationError(
    code,
    code === "control-generation-recovery-required"
      ? `Control generation ${lastGeneration} is odd without a live namespace lock; a writer likely crashed. Run control doctor, inspect canonical state, then use the explicit generation recovery procedure.`
      : `Control changed during ${attempts} bounded read attempts; retry after the active writer completes.`,
    lastGeneration,
  );
}

function renderGeneration(record: GenerationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function writeControlGenerationFile(runtimeRoot: string, source: string, hooks?: AtomicRuntimeWriteHooks): void {
  const root = resolve(runtimeRoot);
  const path = controlGenerationPath(root);
  if (Buffer.byteLength(source) > MAX_GENERATION_BYTES) throw new ControlGenerationError("control-generation-too-large", `Control generation exceeds ${MAX_GENERATION_BYTES} bytes: ${path}`);
  const record = parseGeneration(source, path);
  if (record.schema_version !== 2) throw new ControlGenerationError("control-generation-legacy-write", "New generation writes must use schema v2 with an incarnation UUID.");
  atomicWriteRuntimeFile(root, path, source, hooks);
}

/** Explicit recovery primitive. Caller must hold the namespace lock and strictly validate canonical control first. */
export function reinitializeMissingControlGeneration(paths: ControlNamespacePaths, owner: { sessionId: string; at: string }): ControlGenerationSnapshot {
  const path = controlGenerationPath(paths.runtimeRoot);
  const probe = generationProbe(paths.runtimeRoot, path);
  if (probe.kind === "present") throw new ControlGenerationError("control-generation-recovery-not-missing", `generation.json already exists: ${path}`, probe.snapshot.generation);
  const binding = readCanonicalControlBinding(paths.controlRoot);
  const incarnation = randomUUID();
  writeControlGenerationFile(paths.runtimeRoot, renderGeneration({
    schema_version: 2, kind: "garelier_control_generation",
    control_schema_version: binding.controlSchemaVersion, storage: binding.storage,
    incarnation, generation: 1, state: "writing",
    operation: "generation-recovery-reinitialize", session_id: owner.sessionId, updated_at: owner.at,
  }));
  writeControlGenerationFile(paths.runtimeRoot, renderGeneration({
    schema_version: 2, kind: "garelier_control_generation",
    control_schema_version: binding.controlSchemaVersion, storage: binding.storage,
    incarnation, generation: 2, state: "stable",
    operation: "generation-recovery-reinitialize", session_id: owner.sessionId, updated_at: new Date().toISOString(),
  }));
  return {
    incarnation,
    generation: 2,
    legacy: false,
    controlSchemaVersion: binding.controlSchemaVersion,
    storage: binding.storage,
  };
}

function archiveLegacyGeneration(paths: ControlNamespacePaths, probe: GenerationProbe): void {
  const candidates: Array<{ name: string; bytes: Buffer }> = [];
  if (probe.kind === "present" && probe.snapshot.legacy) candidates.push({ name: "generation.json", bytes: Buffer.from(probe.source) });
  const sentinel = generationSentinelPath(paths.runtimeRoot);
  if (existsSync(sentinel)) {
    assertNoSymlinkPath(paths.runtimeRoot, sentinel);
    const info = lstatSync(sentinel);
    if (!info.isFile() || info.size > MAX_GENERATION_BYTES) throw new ControlGenerationError("control-generation-file-type", `Legacy generation sentinel must be a small regular file: ${sentinel}`);
    candidates.push({ name: GENERATION_SENTINEL_NAME, bytes: readFileSync(sentinel) });
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  const identity = sha256(Buffer.concat(candidates.flatMap((item) => [Buffer.from(`${item.name}\0${item.bytes.length}\0`), item.bytes]))).slice(7);
  const directory = join(paths.runtimeRoot, "migration", "archive", identity);
  ensureSafeDirectory(paths.runtimeRoot, directory);
  const files = candidates.map((item) => ({ path: item.name, sha256: sha256(item.bytes), bytes: item.bytes.length }));
  const manifest = canonicalJson({ schema_version: 1, kind: "garelier_control_generation_legacy_archive", files });
  for (const item of candidates) {
    const target = join(directory, item.name);
    if (existsSync(target)) {
      if (!lstatSync(target).isFile() || !readFileSync(target).equals(item.bytes)) throw new ControlGenerationError("control-generation-archive-conflict", `Legacy archive conflicts with source bytes: ${target}`);
    } else writeFileSync(target, item.bytes, { flag: "wx" });
  }
  const manifestPath = join(directory, "manifest.json");
  if (existsSync(manifestPath)) {
    if (readFileSync(manifestPath, "utf8") !== manifest) throw new ControlGenerationError("control-generation-archive-conflict", `Legacy archive manifest conflicts: ${manifestPath}`);
  } else writeFileSync(manifestPath, manifest, { flag: "wx" });
  if (existsSync(sentinel)) rmSync(sentinel);
}

/** Caller must hold the namespace lock. */
export function beginControlGeneration(
  paths: ControlNamespacePaths,
  owner: {
    sessionId: string;
    operation: string;
    at: string;
    incarnation?: string;
    pendingBinding?: CanonicalControlBinding;
  },
): ControlGenerationLease {
  const binding = owner.pendingBinding ?? readCanonicalControlBinding(paths.controlRoot);
  const path = controlGenerationPath(paths.runtimeRoot);
  const probe = generationProbe(paths.runtimeRoot, path);
  const current = readControlGenerationSnapshot(paths.runtimeRoot, DEFAULT_ATTEMPTS, paths.controlRoot);
  if (current.generation % 2 === 1) {
    throw new ControlGenerationError("control-generation-recovery-required", `Control generation ${current.generation} is already odd; inspect/recover the interrupted writer before mutating.`, current.generation);
  }
  if (current.generation > Number.MAX_SAFE_INTEGER - 2) throw new ControlGenerationError("control-generation-overflow", "Control generation counter is exhausted", current.generation);
  if (current.legacy || existsSync(generationSentinelPath(paths.runtimeRoot))) archiveLegacyGeneration(paths, probe);
  const incarnation = current.legacy ? (owner.incarnation ?? randomUUID()) : current.incarnation!;
  if (!UUID_RE.test(incarnation)) throw new ControlGenerationError("control-generation-incarnation", "planned generation incarnation must be a UUID");
  const odd = current.generation + 1;
  const even = current.generation + 2;
  writeControlGenerationFile(paths.runtimeRoot, renderGeneration({
    schema_version: 2, kind: "garelier_control_generation",
    control_schema_version: binding.controlSchemaVersion, storage: binding.storage,
    incarnation, generation: odd, state: "writing",
    operation: owner.operation, session_id: owner.sessionId, updated_at: owner.at,
  }));
  let settled = false;
  return {
    incarnation,
    odd,
    even,
    settle(): void {
      if (settled) return;
      const current = readControlGenerationSnapshot(paths.runtimeRoot, DEFAULT_ATTEMPTS, paths.controlRoot);
      if (current.incarnation === incarnation && current.generation === even) { settled = true; return; }
      if (current.incarnation !== incarnation || current.generation !== odd) throw new ControlGenerationError("control-generation-lease-stale", `generation lease expected ${incarnation}/${odd}, found ${current.incarnation}/${current.generation}`, current.generation);
      writeControlGenerationFile(paths.runtimeRoot, renderGeneration({
        schema_version: 2, kind: "garelier_control_generation",
        control_schema_version: binding.controlSchemaVersion, storage: binding.storage,
        incarnation, generation: even, state: "stable",
        operation: owner.operation, session_id: owner.sessionId, updated_at: new Date().toISOString(),
      }));
      settled = true;
    },
  };
}
