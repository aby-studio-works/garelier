#!/usr/bin/env bun
/**
 * instruction_ledger_lint — the role's own check, run BEFORE reaching REPORTING.
 *
 * Without it the first reader of a broken ledger is admission, and the round trip
 * costs a resume: the role reports, the PM's scan refuses, the role is woken to
 * fix a line it could have fixed in place. This does not repair anything and
 * never edits the ledger — it tells, and the role fixes (告知まで, 自動修復なし).
 *
 * It shares its predicates with the admission scan via
 * `../dispatch/instruction_ledger.ts`. That sharing is the point: a rule change
 * there moves BOTH verdicts on the same input. Restating the same regex here
 * would look identical and be worthless.
 *
 *   bun skills/garelier-core/driver/src/scripts/instruction_ledger_lint.ts \
 *     --ledger <container>/instructions.md [--register <container>/lane/result.md]
 *
 * exit 0 = ready to REPORT. exit 1 = findings printed, one per line.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LEDGER_CONSUMED_LINE_RE,
  parseUnconsumedLedger,
  parseUnevidencedLedger,
} from "../dispatch/instruction_ledger.ts";

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main(argv: string[]): number {
  const ledgerArg = arg(argv, "ledger");
  if (!ledgerArg) {
    process.stderr.write("usage: instruction_ledger_lint.ts --ledger <instructions.md> [--register <result.md>]\n");
    return 2;
  }
  const ledgerPath = resolve(ledgerArg);
  if (!existsSync(ledgerPath)) {
    process.stderr.write(`instruction_ledger_lint: ledger not found: ${ledgerPath}\n`);
    return 2;
  }
  const ledger = readFileSync(ledgerPath, "utf8");
  const findings: string[] = [];

  for (const entry of parseUnconsumedLedger(ledger)) {
    findings.push(`UNCONSUMED ${entry} — set \`checked = true\` and add \`consumed = '''…'''\` before REPORTING`);
  }
  for (const row of parseUnevidencedLedger(ledger)) {
    findings.push(`NO-EVIDENCE ${row.id} — ${row.problem}`);
  }

  const registerArg = arg(argv, "register");
  if (registerArg) {
    const registerPath = resolve(registerArg);
    if (!existsSync(registerPath)) {
      process.stderr.write(`instruction_ledger_lint: register not found: ${registerPath}\n`);
      return 2;
    }
    // Only lines that already look like a consumption declaration are judged.
    // A register with no such line is not a finding here: the ledger checks above
    // already own "did the role consume the entries".
    const lines = readFileSync(registerPath, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.includes("(consumed:")) continue;
      if (!LEDGER_CONSUMED_LINE_RE.test(line)) {
        findings.push(
          `BAD-CONSUMED-LINE ${registerPath}:${index + 1} — the \`(consumed: …)\` block must be one line, `
          + "end the line, and contain no inner ASCII parenthesis. A nested `(` truncates the evidence "
          + "value, and only the first entry gets reported",
        );
      }
    }
  }

  if (findings.length === 0) {
    process.stdout.write("LEDGER_LINT OK\n");
    return 0;
  }
  for (const finding of findings) process.stdout.write(`LEDGER_LINT ${finding}\n`);
  process.stdout.write(`LEDGER_LINT RESULT RED (${findings.length} finding${findings.length === 1 ? "" : "s"})\n`);
  return 1;
}

process.exit(main(process.argv.slice(2)));
