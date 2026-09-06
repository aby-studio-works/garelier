import { createHash } from "node:crypto";
import { EVIDENCE_WRITER_STORAGE_KEY } from "./types.ts";

const KEY_ORDER = [
  "schema_version", "kind", "id", "slug", "revision", "title", "state", "status", "type", "priority",
  "severity", "likelihood", "milestone", "labels", "outcome", "acceptance", "relations", "refs", "resume",
  "risk", "trigger", "mitigation_work", "owner", "review_at", "accepted_rationale", "objective", "now", "next",
  "read_first", "constraints", "date", "started", "target", "shipped", "work_ids", "blueprint_paths", "decision_ids",
  "acceptance_ids", "gates", "review_conditions", "created_at", "updated_at", "closed_at", "closed_reason", "evidence",
  "legacy", "last_mutation", "updated_by", "integrity", "parent", "depends_on", "blocked_by", "supersedes", "related",
  "blueprints", "decisions", "reports", "paths", "next_action", "known_good", "remaining", "text", "root", "path",
  "commit", "observed_at", EVIDENCE_WRITER_STORAGE_KEY, "summary", "uri", "content_hash", "agent", "session_id", "command", "reason",
  "scope", "runner", "argv", "cwd", "timeout_seconds", "required", "summarize", "algorithm", "value",
] as const;

const KEY_RANK = new Map<string, number>(KEY_ORDER.map((key, index) => [key, index]));

function keyCompare(a: string, b: string): number {
  const ar = KEY_RANK.get(a) ?? Number.MAX_SAFE_INTEGER;
  const br = KEY_RANK.get(b) ?? Number.MAX_SAFE_INTEGER;
  return ar === br ? (a < b ? -1 : a > b ? 1 : 0) : ar - br;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(keyCompare)) out[key] = ordered(source[key]);
  return out;
}

export function sha256(payload: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(ordered(value), null, 2)}\n`;
}
