#!/usr/bin/env bun
// Garelier dispatch (W-088) — anti-false-green evidence lint CLI.
//
// Reads a machine-readable acceptance-evidence document (the schema in
// dispatch/evidence.ts) and reports whether it trips any of the four
// false-green rules the four real-harm fixtures (W-455/W-480/W-481/W-346)
// each represent.
//
// Usage:
//   evidence_lint.sh --evidence <path> [--format json|text]
//
// exit 0 = no violations, exit 1 = violation(s), exit 2 = usage error
// (missing/unreadable/non-JSON/not-an-evidence-document --evidence).
//
// json output: one line { ok, checked, violations:[{rule,evidence_id,detail}] }.

import { existsSync, readFileSync } from "node:fs";
import { arg, printHelpAndExitIfRequested } from "../cli_args.ts";
import { lintEvidence, normalizeEvidenceDoc, type EvidenceLintResult } from "../dispatch/evidence.ts";

const USAGE = "usage: evidence_lint.sh --evidence <path> [--format json|text]";

function renderText(result: EvidenceLintResult): string {
  const lines: string[] = [];
  lines.push(result.ok
    ? `OK: ${result.checked} evidence record(s), no false-green violations`
    : `VIOLATION: ${result.violations.length} issue(s) across ${result.checked} evidence record(s)`);
  for (const v of result.violations) {
    lines.push(`  [${v.rule}] ${v.evidence_id}: ${v.detail}`);
  }
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv;
  printHelpAndExitIfRequested(USAGE, argv);

  const path = arg("evidence", argv);
  const format = arg("format", argv) ?? "json";
  if (!path) {
    process.stderr.write(`evidence_lint: --evidence <path> required\n${USAGE}\n`);
    process.exit(2);
    return;
  }
  if (format !== "json" && format !== "text") {
    process.stderr.write(`evidence_lint: --format must be json|text (got ${format})\n${USAGE}\n`);
    process.exit(2);
    return;
  }
  if (!existsSync(path)) {
    process.stderr.write(`evidence_lint: evidence file not found: ${path}\n`);
    process.exit(2);
    return;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    process.stderr.write(`evidence_lint: ${path} is not valid JSON: ${(e as Error).message}\n`);
    process.exit(2);
    return;
  }

  const records = normalizeEvidenceDoc(doc);
  if (records === null) {
    process.stderr.write(`evidence_lint: ${path} is not an evidence document (expected a record with a 'source', an array, or { evidence: [...] })\n`);
    process.exit(2);
    return;
  }

  const result = lintEvidence(records);
  process.stdout.write((format === "json" ? JSON.stringify(result) : renderText(result)) + "\n");
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.main) main();
