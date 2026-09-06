#!/usr/bin/env bun
// Garelier (W-193) — backlog row-length lint + note-trail sidecar nudge.
//
// A backlog row is a FIXED cost: every worker/gate reads the whole dashboard on
// pickup. When a row accretes a long "追記 (gate note trail)" it becomes a wall of
// text everyone re-reads each time — the dashboard convention is "keep rows short,
// push detail to the canonical record" (CLAUDE.md / retention.md). This mechanizes
// the convention: it flags any Open-work row whose single line exceeds a threshold
// and points at the sidecar (`control/rows/<id>.md`) the trail should move to.
//
// ADVISORY by default (exit 0, prints a warning) — the backlog legitimately holds
// long rows today, and migrating a trail to a sidecar is a PM edit, not a mechanical
// rewrite. `--strict` exits non-zero (for a project that wants a hard gate). The row
// text is never modified here.
//
// CLI:
//   bun backlog_row_length_lint.ts <backlog.md> [--max 1200] [--strict]

import { readFileSync } from "node:fs";

export const DEFAULT_MAX_ROW_CHARS = 1200;

export interface LongRow {
  id: string;        // the row's item id (e.g. "W-174"), or "?" when unlabeled
  length: number;    // the row line's character count
  lineNumber: number; // 1-based line number in the file
}

// A backlog table row is a markdown table line: `| <id> | … |`. The header
// (`| ID | Type | …`) and the separator (`| --- | …`) are skipped. Returns the rows
// whose line length exceeds `max`, sorted longest-first.
export function findLongRows(text: string, max: number = DEFAULT_MAX_ROW_CHARS): LongRow[] {
  // Guard a non-finite / non-positive max (e.g. a NaN from Number("abc")) — without
  // this, `line.length <= NaN` is always false and EVERY row would be flagged (N2).
  const limit = Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_ROW_CHARS;
  const rows: LongRow[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\|\s*\S/.test(line)) continue;                 // not a table row
    if (/^\|\s*-{2,}/.test(line)) continue;               // separator row
    const firstCell = line.match(/^\|\s*([^|]*?)\s*\|/)?.[1] ?? "";
    if (/^(id|ID)$/.test(firstCell) || firstCell === "") continue; // header / empty
    if (line.length <= limit) continue;
    // Prefer the item id token (W-123); fall back to a short first-cell label, else "?".
    const id = firstCell.match(/\b([A-Z]+-\d+)\b/)?.[1] ?? (firstCell.length > 0 && firstCell.length <= 24 ? firstCell : "?");
    rows.push({ id, length: line.length, lineNumber: i + 1 });
  }
  return rows.sort((a, b) => b.length - a.length);
}

function main(argv: string[]): number {
  const file = argv.find((a) => !a.startsWith("-"));
  if (!file) { process.stderr.write("usage: backlog_row_length_lint.ts <backlog.md> [--max 1200] [--strict]\n"); return 2; }
  const maxIdx = argv.indexOf("--max");
  let max = DEFAULT_MAX_ROW_CHARS;
  if (maxIdx >= 0) {
    const n = Number(argv[maxIdx + 1]);
    if (Number.isFinite(n) && n > 0) max = n;
    else process.stderr.write(`backlog_row_length_lint: --max '${argv[maxIdx + 1] ?? ""}' is not a positive number; using default ${DEFAULT_MAX_ROW_CHARS} (N2)\n`);
  }
  const strict = argv.includes("--strict");
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { process.stderr.write(`backlog_row_length_lint: cannot read ${file}\n`); return 2; }
  const long = findLongRows(text, max);
  if (long.length === 0) { process.stdout.write(`  ok (no backlog row exceeds ${max} chars)\n`); return 0; }
  const w = strict ? "FAIL" : "warning";
  process.stdout.write(`  ${w}: ${long.length} backlog row(s) exceed ${max} chars — move the gate/note trail to a canonical sidecar (control/rows/<id>.md), leaving a short pointer in the row (W-193, dashboard 規約):\n`);
  for (const r of long) process.stdout.write(`    ${r.id} — ${r.length} chars (line ${r.lineNumber})\n`);
  return strict ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
