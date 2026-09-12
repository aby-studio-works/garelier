/**
 * Security admission for bytes that land_aftercare is about to publish from a
 * transient dispatch/runtime location into tracked Control evidence.
 *
 * This boundary is deliberately content-only and deterministic: the same
 * policy bytes and source bytes produce the same redacted record. It reuses the
 * Guardian registries/scanner, adds the two policy dimensions not represented
 * by those registries (customer-data markers and provenance/rights state), and
 * never carries a matched value into its record.
 */

import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { canonicalJson, sha256 } from "../control/serialization.ts";
import { resolveKnowledgeRef } from "../knowledge_roots.ts";
import {
  compile,
  registriesFromSources,
  scan,
  type Registries,
  type RegistrySources,
} from "../guardian_scan.ts";

export type PreservationSourceKind = "container_artifact" | "gate_run_record";

export interface PreservationSource {
  kind: PreservationSourceKind;
  /** Canonical relative identity, never an absolute host path. */
  sourcePath: string;
  bytes: Buffer;
}

export interface PreservationAdmissionBinding {
  requestId: string;
  planDigest: string;
  workId: string | null;
  dispatchId: string | null;
}

export interface PreservationAdmissionFinding {
  dimension: "secret" | "pii" | "injection" | "customer_data" | "provenance" | "inspectability" | "policy";
  finding_id: string;
  redacted_pointer: string;
}

export interface PreservationAdmissionArtifact {
  source_kind: PreservationSourceKind;
  source_path: string;
  source_hash: string;
  byte_length: number;
  destination: string;
  decision: "CLEAN" | "REJECTED";
  findings: PreservationAdmissionFinding[];
}

export interface PreservationAdmissionRecord {
  schema_version: 1;
  kind: "garelier_preservation_security_admission";
  status: "CLEAN" | "REJECTED";
  request_id: string;
  plan_digest: string;
  work_id: string | null;
  dispatch_id: string | null;
  scanner: "guardian_scan.ts";
  policy: {
    registry_files: Array<{ ref: string; content_hash: string }>;
    supplemental_rules: string[];
    errors: string[];
  };
  artifacts: PreservationAdmissionArtifact[];
  record_hash: string;
}

const REGISTRY_REFS = {
  secret: "security/registries/secret_patterns.toml",
  pii: "security/registries/pii_patterns.toml",
  injection: "security/registries/injection_patterns.toml",
  falsePositiveExceptions: "security/registries/false_positive_exceptions.toml",
} as const satisfies Record<keyof RegistrySources, string>;

const SUPPLEMENTAL_RULE_IDS = [
  "customer-data-assignment",
  "provenance-license-not-adoptable",
  "provenance-license-unknown",
  "provenance-inspiration-only",
  "provenance-external-source-unapproved",
  "provenance-raw-external-content",
] as const;

const ENCODED_COMPONENT_CHARS = 96;

function canonicalSourcePath(sourcePath: string): string {
  if (!sourcePath || sourcePath.includes("\\") || sourcePath.includes("\0")) {
    throw new Error(`preservation admission source path is unsafe: ${sourcePath}`);
  }
  if (Buffer.from(sourcePath, "utf8").toString("utf8") !== sourcePath) {
    throw new Error(`preservation admission source path is not valid Unicode: ${sourcePath}`);
  }
  const parts = sourcePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`preservation admission source path is unsafe: ${sourcePath}`);
  }
  return parts.join("/");
}

/**
 * An injective, case-insensitive-filesystem-safe mapping from source identity
 * to a bounded-component tracked path. Lowercase hexadecimal preserves every
 * UTF-8 byte; chunking prevents a long relative path from becoming one leaf.
 * Source classes have disjoint namespaces, so an unknown `run_record-*` name
 * can never alias an actual run record.
 */
export function preservedEvidenceRelativePath(kind: PreservationSourceKind, sourcePath: string): string {
  const canonical = canonicalSourcePath(sourcePath);
  const encoded = Buffer.from(canonical, "utf8").toString("hex");
  const chunks = encoded.match(new RegExp(`.{1,${ENCODED_COMPONENT_CHARS}}`, "g"));
  if (!chunks?.length) throw new Error("preservation admission source path encoded to an empty identity");
  return [kind === "container_artifact" ? "artifacts" : "run_records", ...chunks, "payload"].join("/");
}

function stablePolicyBytes(path: string, ref: string): Buffer {
  const initial = lstatSync(path);
  if (initial.isSymbolicLink() || !initial.isFile()) throw new Error(`${ref} is not a real regular file`);
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino) {
      throw new Error(`${ref} identity changed while opening`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || bytes.length !== before.size) {
      throw new Error(`${ref} changed while reading its bound handle`);
    }
    return bytes;
  } finally { closeSync(descriptor); }
}

function inspectableText(bytes: Buffer): { text: string | null; findingId: string | null } {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return { text: null, findingId: "invalid-utf8" };
  // Tabs and line endings are the only C0 controls accepted. Terminal escapes,
  // NULs, and C1 controls can hide or rewrite what a reviewer sees.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text)) {
    return { text: null, findingId: "binary-or-control-bytes" };
  }
  return { text, findingId: null };
}

function lineOf(text: string, pattern: RegExp): number | null {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? null : index + 1;
}

function supplementalFindings(pointer: string, text: string): PreservationAdmissionFinding[] {
  const findings: PreservationAdmissionFinding[] = [];
  const add = (dimension: "customer_data" | "provenance", findingId: string, line: number | null): void => {
    if (line === null || findings.some((item) => item.finding_id === findingId)) return;
    findings.push({ dimension, finding_id: findingId, redacted_pointer: `${pointer}:${line} [${findingId}]` });
  };

  add("customer_data", "customer-data-assignment", lineOf(text,
    /\b(?:customer(?:_id|_name|_email|_record|_data)?|production_(?:record|data)|account_number)\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s#]+)/i));
  add("provenance", "provenance-license-not-adoptable", lineOf(text,
    /\blicense\s*[:=]\s*["']?not-adoptable\b/i));
  add("provenance", "provenance-license-unknown", lineOf(text,
    /\blicense\s*[:=]\s*["']?unknown\b/i));
  add("provenance", "provenance-inspiration-only", lineOf(text,
    /\buse\s*[:=]\s*["']?inspiration-only\b/i));
  add("provenance", "provenance-raw-external-content", lineOf(text,
    /\b(?:raw_external_(?:content|text)|copied_from_external_source)\s*[:=]\s*(?:true|yes|1)\b/i));

  const externalLine = lineOf(text, /\bsource_type\s*[:=]\s*["']?(?:url|sharepoint)\b/i);
  if (externalLine !== null) {
    const confirmed = /\blicense\s*[:=]\s*["']?confirmed\b/i.test(text);
    const allowedUse = /\buse\s*[:=]\s*["']?(?:internal-policy-source|allowed-summary)\b/i.test(text);
    if (!confirmed || !allowedUse) add("provenance", "provenance-external-source-unapproved", externalLine);
  }
  return findings;
}

/** The one PII pattern whose own registry note defers the decision to a
 * checksum: `credit-card-like` is written as "13-16 digits, separators
 * optional" and its note reads "Verify with the Luhn checksum before blocking —
 * many false positives (ids, hashes)". Nothing verified it, so every 13-digit
 * millisecond timestamp a gate log prints was a high-severity PII finding, and
 * this boundary rejects the WHOLE batch on one finding: _workshop #520
 * (2026-09-10) refused its cleanup on ten hits, all of them `Date.now()` values
 * inside `lane/*.log`, and the container's claim stayed held.
 *
 * The verification lives here rather than in the registry because a registry
 * pattern is one regular expression and a checksum is not expressible as one. */
const CREDIT_CARD_FINDING_ID = "credit-card-like";

/** Luhn (ISO/IEC 7812-1) check digit over an all-digit string. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** A millisecond epoch stamp in [2001-09-09, 2033-05-18): thirteen digits, no
 * separators, leading digit 1. No payment card is issued in that space — the
 * major industry identifier 1 belongs to airlines, and every 13-digit card
 * (old-form Visa) starts with 4 — so excluding it cannot hide a card number. */
function isEpochMilliseconds(raw: string, digits: string): boolean {
  return raw === digits && digits.length === 13 && digits.startsWith("1");
}

/** Is this candidate written the way a card is written?
 *
 * A card number appears either as an unbroken digit run or in short groups
 * (4-4-4-4, 4-6-5) separated by one space or hyphen. A synthetic identifier
 * such as a merge-request id (`20260910-184727-…`) also satisfies the registry
 * regex, but its groups are the wrong shape: nothing writes a card with a
 * seven-digit group. */
function cardShaped(raw: string): boolean {
  const separators = new Set([...raw].filter((character) => character === " " || character === "-"));
  if (separators.size === 0) return true; // an unbroken digit run: the common form
  if (separators.size > 1) return false; // mixed separators are not a written card
  return raw.split(/[ -]/).filter((group) => group.length > 0).every((group) => group.length <= 6);
}

/** The registry's OWN compiled `credit-card-like` pattern, so the candidates
 * verified below are exactly the ones the scanner flagged. One rule, one
 * spelling: a registry edit changes what is verified here on the same day, and
 * there is no second copy to drift. */
function creditCardPattern(registries: Registries): RegExp | null {
  const pattern = registries.pii.find((candidate) => candidate.id === CREDIT_CARD_FINDING_ID);
  return pattern ? compile(pattern) : null;
}

/** Does this line hold a value that is actually a card number, rather than one
 * of the identifiers the registry note warns about? An absent or uncompilable
 * pattern cannot be second-guessed here, so the finding stands as it does
 * today. */
function lineHoldsCreditCard(compiled: RegExp | null, text: string): boolean {
  if (!compiled) return true;
  compiled.lastIndex = 0;
  for (const match of text.matchAll(compiled)) {
    const raw = match[0];
    const digits = raw.replace(/[ -]/g, "");
    if (!cardShaped(raw)) continue;
    if (isEpochMilliseconds(raw, digits)) continue;
    if (!luhnValid(digits)) continue;
    return true;
  }
  return false;
}

function loadPolicy(projectRoot: string, pmId: string): {
  sources: RegistrySources | null;
  files: Array<{ ref: string; content_hash: string }>;
  errors: string[];
} {
  const values: Partial<RegistrySources> = {};
  const files: Array<{ ref: string; content_hash: string }> = [];
  const errors: string[] = [];
  for (const [key, ref] of Object.entries(REGISTRY_REFS) as Array<[keyof RegistrySources, string]>) {
    try {
      const resolved = resolveKnowledgeRef(projectRoot, pmId, ref);
      if (!resolved) throw new Error("not found in the shared/per-PM knowledge roots");
      const bytes = stablePolicyBytes(resolved.abs, ref);
      values[key] = bytes.toString("utf8");
      files.push({ ref: resolved.repoRel.replaceAll("\\", "/"), content_hash: sha256(bytes) });
    } catch (error) {
      errors.push(`${ref}: ${(error as Error).message}`);
    }
  }
  files.sort((a, b) => a.ref.localeCompare(b.ref));
  if (errors.length > 0) return { sources: null, files, errors: errors.sort() };
  return { sources: values as RegistrySources, files, errors };
}

function withRecordHash(record: Omit<PreservationAdmissionRecord, "record_hash">): PreservationAdmissionRecord {
  return { ...record, record_hash: sha256(canonicalJson(record)) };
}

/** Evaluate every source as one batch. Callers record this result before any
 * tracked publication and publish only when status is exactly CLEAN. */
export function evaluatePreservationAdmission(options: {
  projectRoot: string;
  pmId: string;
  binding: PreservationAdmissionBinding;
  sources: PreservationSource[];
}): PreservationAdmissionRecord {
  const ordered = [...options.sources]
    .map((source) => ({ ...source, sourcePath: canonicalSourcePath(source.sourcePath) }))
    .sort((a, b) => `${a.kind}\0${a.sourcePath}`.localeCompare(`${b.kind}\0${b.sourcePath}`));
  const identities = new Set<string>();
  for (const source of ordered) {
    const identity = `${source.kind}\0${source.sourcePath}`;
    if (identities.has(identity)) throw new Error(`duplicate preservation source identity: ${source.kind}:${source.sourcePath}`);
    identities.add(identity);
  }

  const loaded = loadPolicy(options.projectRoot, options.pmId);
  let registries: ReturnType<typeof registriesFromSources> | null = null;
  if (loaded.sources) {
    try { registries = registriesFromSources(loaded.sources, true); }
    catch (error) { loaded.errors.push(`registry parse: ${(error as Error).message}`); }
  }

  const artifacts = ordered.map((source): PreservationAdmissionArtifact => {
    const pointer = `preservation/${source.kind}/${source.sourcePath}`;
    const findings: PreservationAdmissionFinding[] = [];
    const inspectable = inspectableText(source.bytes);
    if (inspectable.findingId) {
      findings.push({
        dimension: "inspectability",
        finding_id: inspectable.findingId,
        redacted_pointer: `${pointer}:0 [${inspectable.findingId}]`,
      });
    } else if (registries) {
      const lines = inspectable.text!.split(/\r?\n/).map((text, index) => ({ file: pointer, line: index + 1, text }));
      const draft = scan(registries, {
        kind: "final_gate",
        lines,
        changedFiles: [pointer],
        packageFiles: [],
        knowledgePathRe: /[\s\S]*/,
      });
      const cardPattern = creditCardPattern(registries);
      findings.push(...draft.findings.filter((finding) => {
        if (finding.finding_id !== CREDIT_CARD_FINDING_ID) return true;
        // The scanner reported a line of THIS artifact, so the lookup resolves;
        // a line it could not resolve keeps the finding rather than dropping it.
        const text = lines[finding.line - 1]?.text;
        return text === undefined || lineHoldsCreditCard(cardPattern, text);
      }).map((finding) => ({
        dimension: finding.dimension as "secret" | "pii" | "injection",
        finding_id: finding.finding_id,
        redacted_pointer: finding.redacted_pointer,
      })));
      if (draft.scan_state !== "complete") {
        findings.push({ dimension: "policy", finding_id: "guardian-pattern-compile-failure", redacted_pointer: `${pointer}:0 [guardian-pattern-compile-failure]` });
      }
      findings.push(...supplementalFindings(pointer, inspectable.text!));
    }
    if (loaded.errors.length > 0) {
      findings.push({ dimension: "policy", finding_id: "security-policy-unavailable", redacted_pointer: `${pointer}:0 [security-policy-unavailable]` });
    }
    return {
      source_kind: source.kind,
      source_path: source.sourcePath,
      source_hash: sha256(source.bytes),
      byte_length: source.bytes.length,
      destination: preservedEvidenceRelativePath(source.kind, source.sourcePath),
      decision: findings.length === 0 ? "CLEAN" : "REJECTED",
      findings,
    };
  });
  const status = loaded.errors.length === 0 && artifacts.every((artifact) => artifact.decision === "CLEAN")
    ? "CLEAN"
    : "REJECTED";
  return withRecordHash({
    schema_version: 1,
    kind: "garelier_preservation_security_admission",
    status,
    request_id: options.binding.requestId,
    plan_digest: options.binding.planDigest,
    work_id: options.binding.workId,
    dispatch_id: options.binding.dispatchId,
    scanner: "guardian_scan.ts",
    policy: {
      registry_files: loaded.files,
      supplemental_rules: [...SUPPLEMENTAL_RULE_IDS],
      errors: loaded.errors.sort(),
    },
    artifacts,
  });
}

export function preservationAdmissionBytes(record: PreservationAdmissionRecord): string {
  return canonicalJson(record);
}
