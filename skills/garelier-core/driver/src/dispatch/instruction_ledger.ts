// Shared instruction-ledger predicates (W-092 / W-531).
//
// Two seats have to agree on what "consumed" means: the admission scan that the
// PM runs (`contract_check.ts` UNCONSUMED-INSTRUCTIONS) and the self-check a role
// runs before REPORTING (`instruction_ledger_lint.ts`). If each spelled the rule
// out separately, the two could drift and the role would pass its own check and
// then be refused at admission — the exact round this file exists to remove.
//
// Sharing is only real when changing the rule HERE changes BOTH verdicts on the
// same input. Two copies of the same regex in two files look identical and are
// not shared: that is the counterfactual W-531 AC-4 asks for.

import { machineArray, tryParseMachineArtifact } from "./machine_artifact.ts";

/**
 * The register line that declares consumption, e.g.
 *   `I0001 digest:0123456789ab (consumed: artifact:path/to/report.md)`
 *
 * The `(consumed: …)` block must be ONE line, end the line, and contain no inner
 * ASCII parenthesis. A nested `(` makes the trailing `)` ambiguous, so the
 * transcriber reads a truncated evidence value and reports only the first entry
 * it could parse — the failure then looks identical to "no evidence at all".
 */
export const LEDGER_CONSUMED_LINE_RE = /\(consumed:\s*([^()\r\n]+)\)\s*$/;

/** An `[[instruction]]` table is consumed when `checked` is exactly `true`. */
export function isLedgerRowConsumed(row: Record<string, unknown>): boolean {
  return row.checked === true;
}

/**
 * `consumed` evidence is accepted when it is a non-empty string. Only Codex
 * proxy transcription narrows this further to `artifact:` / `commit:`; a
 * producer writing its own ledger may use any non-empty evidence.
 */
export function isLedgerEvidenceAcceptable(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Every `[[instruction]]` table that is NOT consumed, rendered as `<id> <message>`.
 *
 * Best-effort by contract: an unreadable or untyped ledger yields no entry.
 * Scanning for `- [ ]` checklist lines silently found nothing once the ledger
 * became typed, which would have retired the detector without any error — a
 * detector reporting "nothing open" is indistinguishable from a clean ledger.
 */
export function parseUnconsumedLedger(text: string): string[] {
  const parsed = tryParseMachineArtifact(text, "instruction ledger");
  if (!parsed.ok) return [];
  let rows: Record<string, unknown>[];
  try { rows = machineArray(parsed.artifact, "instruction", "instruction ledger"); }
  catch { return []; }
  return rows
    .filter((row) => !isLedgerRowConsumed(row))
    .map((row) => {
      const id = typeof row.id === "string" ? row.id : "?";
      const message = typeof row.message === "string" ? row.message.replace(/\s+/g, " ").trim() : "";
      return message ? `${id} ${message}` : id;
    });
}

export interface LedgerRowFinding { id: string; problem: string }

/**
 * Rows that are checked off but carry no usable evidence. Kept separate from
 * `parseUnconsumedLedger` because the two answer different questions: that one
 * asks "did the role act on this?", this one asks "can anyone verify that it did?".
 */
export function parseUnevidencedLedger(text: string): LedgerRowFinding[] {
  const parsed = tryParseMachineArtifact(text, "instruction ledger");
  if (!parsed.ok) return [];
  let rows: Record<string, unknown>[];
  try { rows = machineArray(parsed.artifact, "instruction", "instruction ledger"); }
  catch { return []; }
  const out: LedgerRowFinding[] = [];
  for (const row of rows) {
    if (!isLedgerRowConsumed(row)) continue;
    const id = typeof row.id === "string" ? row.id : "?";
    if (!isLedgerEvidenceAcceptable(row.consumed)) {
      out.push({ id, problem: "checked = true but `consumed` is missing or empty" });
    }
  }
  return out;
}
