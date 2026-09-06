import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, sha256 } from "./serialization.ts";
import { EVIDENCE_WRITER_STORAGE_KEY, type ControlFinding, type EvidenceReference } from "./types.ts";

const MAX_GATE_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 4096;

export interface EvidenceGitInspector {
  commitExists(commit: string): boolean;
  isReachable(commit: string, from: string): boolean;
}

function finding(code: string, entity: string, path: string | null, field: string, message: string): ControlFinding {
  return { severity: "error", code, entity, path, field, message, suggested_command: null };
}

function safeRegularFile(root: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) return null;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  const base = resolve(root);
  const target = resolve(base, ...parts);
  const rel = relative(base, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  let current = base;
  for (const part of parts) {
    current = resolve(current, part);
    if (!existsSync(current)) return null;
    const info = lstatSync(current);
    if (info.isSymbolicLink()) return null;
  }
  return lstatSync(target).isFile() ? target : null;
}

function timestamp(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function commands(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0) ? value as string[] : null;
}

function sameCommands(left: readonly string[] | null, right: readonly string[] | null): boolean {
  return Boolean(left && right && left.length === right.length && left.every((item, index) => item === right[index]));
}

function passingStepCommands(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  const passing = value.every((step) => {
    const item = object(step);
    if (item && typeof item.cmd === "string" && item.cmd) result.push(item.cmd);
    return Boolean(item) && typeof item!.cmd === "string" && Boolean(item!.cmd) && item!.exit_code === 0 && (item!.status === undefined || item!.status === "pass");
  });
  return passing ? result : null;
}

function validConfigSource(value: unknown): value is { path: string; content_hash: string } | null {
  if (value === null) return true;
  const source = object(value);
  return Boolean(source) && typeof source!.path === "string" && Boolean(source!.path)
    && typeof source!.content_hash === "string" && /^sha256:[0-9a-f]{64}$/.test(source!.content_hash);
}

function validateDurableMerge(gate: Record<string, unknown>, entity: string, evidencePath: string, evidence: EvidenceReference): ControlFinding[] {
  if (gate.kind !== "merge_gate_evidence") return [];
  const out: ControlFinding[] = [];
  const fail = (code: string, field: string, message: string) => out.push(finding(code, entity, evidencePath, field, message));
  const request = object(gate.request), requestPayload = object(request?.payload);
  const result = object(gate.payload);
  const execution = object(gate.execution);
  const controlSchemaVersion = gate.control_schema_version ?? requestPayload?.control_schema_version;
  if (gate.schema_version !== 1 || controlSchemaVersion !== 3
    || typeof gate.session_id !== "string" || !gate.session_id) {
    fail("merge-evidence-binding-invalid", "evidence.gate.session_id", "durable merge evidence requires evidence schema, Control schema, and session binding");
  }
  if (!request || !requestPayload || request.payload_hash !== sha256(canonicalJson(request.payload))) fail("merge-evidence-request-seal-mismatch", "evidence.gate.request.payload_hash", "durable merge request payload seal is missing or invalid");
  const requestId = requestPayload?.request_id;
  if (!requestPayload || requestPayload.control_schema_version !== controlSchemaVersion || requestPayload.work_id !== entity || requestPayload.control_session_id !== gate.session_id || requestId !== gate.gate_id) {
    fail("merge-evidence-request-binding-mismatch", "evidence.gate.request", "durable merge request is not bound to gate/work/session");
  }
  if (!result || result.request_id !== requestId || result.work_id !== entity || result.control_session_id !== gate.session_id
    || result.status !== "success" || result.studio_commit !== evidence.commit) {
    fail("merge-evidence-result-binding-mismatch", "evidence.gate.payload", "durable merge result is stale, forged, failed, or not bound to request/work/session/commit with all-zero passing steps");
  }
  const requestPreflight = commands(requestPayload?.preflight ?? []);
  const requestGate = commands(requestPayload?.quality_gate_commands);
  const resultRequestedPreflight = commands(result?.requested_preflight_commands);
  const resultRequestedGate = commands(result?.requested_quality_gate_commands);
  const effectiveGate = commands(result?.effective_gate_commands);
  const preflightSteps = passingStepCommands(result?.preflight_steps);
  const gateSteps = passingStepCommands(result?.gate_steps);
  const gateMode = result?.gate_mode;
  const requestConfig = requestPayload?.merge_gate_config ?? null;
  const resultConfig = result?.merge_gate_config ?? null;
  if (requestPayload?.gate_mode !== "normal"
    || !sameCommands(commands(requestPayload?.requested_preflight_commands), requestPreflight)
    || !sameCommands(commands(requestPayload?.requested_quality_gate_commands), requestGate)
    || !sameCommands(commands(requestPayload?.effective_gate_commands), requestGate)
    || (gateMode !== "normal" && gateMode !== "data_only")
    || !sameCommands(resultRequestedPreflight, requestPreflight) || !sameCommands(resultRequestedGate, requestGate)
    || !sameCommands(preflightSteps, requestPreflight) || !sameCommands(gateSteps, effectiveGate)
    || (gateMode === "normal" && !sameCommands(effectiveGate, requestGate))
    || (gateMode === "data_only" && (!effectiveGate || effectiveGate.length === 0))
    || !validConfigSource(requestConfig) || !validConfigSource(resultConfig)
    || canonicalJson(requestConfig) !== canonicalJson(resultConfig)) {
    fail("merge-evidence-command-binding-mismatch", "evidence.gate.execution", "durable merge evidence does not exactly bind gate mode, requested/effective ordered commands, passing steps, and config source hash");
  }
  if (!execution || execution.gate_mode !== gateMode
    || !sameCommands(commands(execution.requested_preflight_commands), resultRequestedPreflight)
    || !sameCommands(commands(execution.requested_quality_gate_commands), resultRequestedGate)
    || !sameCommands(commands(execution.effective_gate_commands), effectiveGate)
    || canonicalJson(execution.config_source ?? null) !== canonicalJson(resultConfig)
    || execution.payload_hash !== gate.payload_hash) {
    fail("merge-evidence-execution-seal-mismatch", "evidence.gate.execution", "durable execution binding is missing, stale, or not sealed to the result payload");
  }
  if (request && (request.gate_mode !== gateMode
    || !sameCommands(commands(request.requested_preflight_commands), requestPreflight)
    || !sameCommands(commands(request.requested_quality_gate_commands), requestGate)
    || !sameCommands(commands(request.effective_gate_commands), effectiveGate)
    || canonicalJson(request.config_source ?? null) !== canonicalJson(requestConfig))) {
    fail("merge-evidence-request-command-seal-mismatch", "evidence.gate.request", "durable request binding is missing or does not seal the resolved command/config binding");
  }
  const reviews = object(gate.reviews);
  for (const role of ["guardian", "observer"] as const) {
    if (requestPayload?.[`${role}_required`] !== true) continue;
    const review = object(reviews?.[role]);
    const requestedSha = requestPayload?.[`${role}_review_sha`];
    const bindingPayload = review ? {
      required: review.required,
      verdict: review.verdict,
      review_sha: review.review_sha,
      requested_sha: review.requested_sha,
      resolved_target_sha: review.resolved_target_sha,
      verdict_bound_by: review.verdict_bound_by,
      content_hash: review.content_hash,
    } : null;
    if (!review || !["PASS", "PASS_WITH_NOTES"].includes(String(review.verdict)) || typeof review.review_sha !== "string"
      || typeof requestedSha !== "string" || review.requested_sha !== requestedSha
      || !/^[0-9a-f]{40,64}$/.test(requestedSha) || review.review_sha !== requestedSha
      || typeof review.resolved_target_sha !== "string" || !/^[0-9a-f]{40,64}$/.test(review.resolved_target_sha)
      || (review.verdict_bound_by !== "sha" && review.verdict_bound_by !== "tree")
      || (review.verdict_bound_by === "sha" && review.resolved_target_sha !== requestedSha)
      || result?.[`${role}_review_sha`] !== requestedSha
      || result?.[`${role}_resolved_target_sha`] !== review.resolved_target_sha
      || result?.[`${role}_verdict_bound_by`] !== review.verdict_bound_by
      || typeof review.content_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(review.content_hash)
      || review.payload_hash !== sha256(canonicalJson(bindingPayload))) {
      fail("merge-evidence-review-binding-mismatch", `evidence.gate.reviews.${role}`, `durable ${role} evidence lacks a sealed passing review SHA/verdict binding`);
    }
  }
  return out;
}


/** Validate the one canonical gate-result file bound by an EvidenceReference. */
export function validateGateEvidence(
  model: { targetRoot: string; controlRoot: string },
  entity: string,
  evidence: EvidenceReference,
  options: { git?: EvidenceGitInspector; historyRef?: string } = {},
): ControlFinding[] {
  if (evidence.kind !== "gate") return [];
  const field = "evidence.gate";
  const out: ControlFinding[] = [];
  const evidencePath = evidence.path ?? null;
  if (!evidence.id || !evidence.commit || !evidence.root || !evidence.path) {
    return [finding("gate-evidence-binding-missing", entity, evidencePath, field, "gate evidence requires gate ID, full commit, root, and canonical result path")];
  }
  if (!timestamp(evidence.observed_at) || typeof evidence.writer !== "string" || !evidence.writer.trim() || !evidence.summary.trim() || Buffer.byteLength(evidence.summary, "utf8") > MAX_SUMMARY_BYTES) {
    out.push(finding("gate-evidence-reference-invalid", entity, evidencePath, field, "gate evidence requires a timestamp, writer, and bounded non-empty summary"));
  }
  const root = evidence.root === "target" ? model.targetRoot : model.controlRoot;
  const absolute = safeRegularFile(root, evidence.path);
  if (!absolute) return [...out, finding("gate-evidence-file-unsafe", entity, evidencePath, `${field}.path`, "gate result must be an existing regular non-symlink file below its declared root")];
  const info = lstatSync(absolute);
  if (info.size > MAX_GATE_BYTES) return [...out, finding("gate-evidence-file-too-large", entity, evidencePath, `${field}.path`, `gate result exceeds ${MAX_GATE_BYTES} bytes`)];
  const source = readFileSync(absolute);
  if (!evidence.content_hash) out.push(finding("gate-evidence-content-hash-missing", entity, evidencePath, `${field}.content_hash`, "gate evidence must seal the exact result bytes with content_hash"));
  else if (sha256(source) !== evidence.content_hash) out.push(finding("gate-evidence-content-mismatch", entity, evidencePath, `${field}.content_hash`, "gate result bytes do not match evidence content_hash"));
  let gate: Record<string, unknown> | null = null;
  try { gate = object(JSON.parse(source.toString("utf8"))); } catch { /* finding below */ }
  if (!gate) return [...out, finding("gate-result-invalid", entity, evidencePath, field, "gate result must be a JSON object")];
  const scope = gate.work_id ?? gate.scope_id ?? gate.entity_id;
  if (scope !== entity) out.push(finding("gate-result-scope-mismatch", entity, evidencePath, `${field}.work_id`, `gate result must bind entity ${entity}`));
  if (gate.gate_id !== evidence.id) out.push(finding("gate-result-id-mismatch", entity, evidencePath, `${field}.gate_id`, `gate result must bind gate ${evidence.id}`));
  if (gate.status !== "pass" || gate.exit_code !== 0) out.push(finding("gate-result-not-pass", entity, evidencePath, `${field}.status`, "gate result must explicitly record status=pass and exit_code=0"));
  if (gate.commit !== evidence.commit) out.push(finding("gate-result-commit-mismatch", entity, evidencePath, `${field}.commit`, `gate result must bind exact commit ${evidence.commit}`));
  if (!timestamp(gate.observed_at) || !timestamp(gate.executed_at)) out.push(finding("gate-result-time-missing", entity, evidencePath, `${field}.observed_at`, "gate result requires valid observed_at and executed_at timestamps"));
  const gateWriter = gate[EVIDENCE_WRITER_STORAGE_KEY];
  if (typeof gateWriter !== "string" || !gateWriter.trim() || gateWriter !== evidence.writer) out.push(finding("gate-result-writer-mismatch", entity, evidencePath, `${field}.writer`, "gate result writer must be non-empty and match the EvidenceReference"));
  const summary = typeof gate.summary === "string" ? gate.summary : "";
  const hasBoundedSummary = summary.trim().length > 0 && Buffer.byteLength(summary, "utf8") <= MAX_SUMMARY_BYTES;
  const hasContentHash = typeof gate.content_hash === "string" && /^sha256:[0-9a-f]{64}$/.test(gate.content_hash);
  let hasLog = false;
  if (typeof gate.log_path === "string") hasLog = safeRegularFile(root, gate.log_path) !== null;
  if (!hasBoundedSummary && !hasLog && !hasContentHash) out.push(finding("gate-result-output-missing", entity, evidencePath, `${field}.summary`, "gate result requires a bounded summary, safe regular log_path, or content_hash"));
  if ("payload" in gate || "payload_hash" in gate) {
    if (typeof gate.payload_hash !== "string" || gate.payload_hash !== sha256(canonicalJson(gate.payload))) {
      out.push(finding("gate-result-payload-mismatch", entity, evidencePath, `${field}.payload_hash`, "gate result payload_hash does not seal its canonical payload"));
    }
  }
  out.push(...validateDurableMerge(gate, entity, evidencePath!, evidence));
  if (options.git) {
    if (!options.git.commitExists(evidence.commit)) out.push(finding("gate-result-commit-missing", entity, evidencePath, `${field}.commit`, `gate commit does not exist: ${evidence.commit}`));
    else if (!options.git.isReachable(evidence.commit, options.historyRef ?? "HEAD")) out.push(finding("gate-result-commit-unreachable", entity, evidencePath, `${field}.commit`, `gate commit is not reachable from ${options.historyRef ?? "HEAD"}`));
  }
  return out;
}
