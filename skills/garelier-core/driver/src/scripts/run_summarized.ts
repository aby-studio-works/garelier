#!/usr/bin/env bun
// TS-first port of scripts/run_summarized.sh (W-043b). Behaviour frozen:
// flags / stdout summary format / exit code (== the wrapped command's) /
// log-file + status-file path & format match the shell 1:1. The --help block
// reproduces the shell's `sed -n '2,15p'` header verbatim.

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { shellQuote } from "./_lib.ts";

const out = (s: string) => process.stdout.write(s);
const outln = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

// Verbatim reproduction of run_summarized.sh lines 2-15 (the old `-h` output).
const HELP = `#
# run_summarized.sh — inbound output discipline (W-043b; rtk concept
# https://github.com/rtk-ai/rtk generalized — no external binary, bash only).
# Runs a command, keeps its FULL output in a log file, and prints only a
# compact structured summary to stdout: exit code, a recognized-pattern
# digest (cargo test \`test result:\` lines / build-style error+warning counts
# / fmt-diff presence / generic line-count+tail fallback), the log path, and
# — never omitted — the first 20 failure/error lines reproduced VERBATIM, so
# gate-relevant detail is never hidden from the caller. This is the inbound
# counterpart to the outbound "Inter-agent compressed register"
# (garelier-core/output_control.md).
#
# Usage:
#   run_summarized.sh --log-dir <dir> --slug <slug> [--status-file <path>] -- <command...>
`;

function utcCompact(): string {
  // date -u +%Y%m%dT%H%M%SZ
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function utcIso(): string {
  // date -u +%Y-%m-%dT%H:%M:%SZ
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let logDir = "", slug = "", statusFile = "";
  let cmd: string[] = [];

  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log-dir") { logDir = reqVal(argv, ++i); }
    else if (a === "--slug") { slug = reqVal(argv, ++i); }
    else if (a === "--status-file") { statusFile = reqVal(argv, ++i); }
    else if (a === "--") { cmd = argv.slice(i + 1); break; }
    else if (a === "-h" || a === "--help") { out(HELP); process.exit(0); }
    else {
      err(`run_summarized: unknown arg: ${a}`);
      err("run_summarized: valid flags: --log-dir --slug --status-file -- <command...> (-h/--help)");
      process.exit(2);
    }
  }

  if (!logDir || !slug) { err("run_summarized: --log-dir and --slug are required"); process.exit(2); }
  if (cmd.length === 0) { err("run_summarized: no command given (put it after --)"); process.exit(2); }

  try { mkdirSync(logDir, { recursive: true }); }
  catch { err(`run_summarized: cannot create log dir: ${logDir}`); process.exit(2); }

  const ts = utcCompact();
  const logFile = `${logDir}/${ts}-${slug}.log`;

  if (statusFile) {
    try { mkdirSync(dirname(statusFile), { recursive: true }); }
    catch { err(`run_summarized: cannot create status dir: ${dirname(statusFile)}`); process.exit(2); }
    writeFileSync(statusFile,
      `START=${utcIso()}\n` +
      `CMD=${cmd.map((part) => shellQuote(part, "printf-q")).map((s) => s + " ").join("")}\n` +
      `LOG=${logFile}\n`, "utf8");
  }

  // "$@" >"$LOG_FILE" 2>&1 ; EXIT_CODE=$?
  let exitCode = 0;
  const fd = openSync(logFile, "w");
  try {
    const proc = Bun.spawn({ cmd, stdin: "ignore", stdout: fd, stderr: fd });
    exitCode = await proc.exited;
  } catch (e) {
    // command not found / not executable: bash routes the error to the log and
    // yields 127.
    appendFileSync(logFile, `run_summarized: ${cmd[0]}: ${(e as Error).message}\n`);
    exitCode = 127;
  } finally {
    closeSync(fd);
  }

  if (statusFile) {
    appendFileSync(statusFile, `END=${utcIso()}\nEXIT=${exitCode}\n`);
  }

  const content = readFileSync(logFile, "utf8");
  const newlineCount = (content.match(/\n/g) ?? []).length;
  const lines = content.split(/\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  outln(`run_summarized: exit=${exitCode} lines=${newlineCount} log=${logFile}`);

  // --- recognized-pattern summary (each independent; more than one may fire) --
  let matched = false;

  const testResultLines = lines.filter((l) => /^test result:/.test(l));
  if (testResultLines.length > 0) {
    matched = true;
    outln("-- test result --");
    for (const l of testResultLines) outln(l);
  }

  const errN = lines.filter((l) => /^error(\[|:| )?/.test(l)).length;
  const warnN = lines.filter((l) => /^warning(:|\[)/.test(l)).length;
  if (errN > 0 || warnN > 0) {
    matched = true;
    outln(`-- build diagnostics -- errors=${errN} warnings=${warnN}`);
  }

  if (lines.some((l) => /^Diff in |^\+\+\+ |^--- /.test(l))) {
    matched = true;
    outln("-- fmt/diff -- formatting differences present");
  }

  if (!matched) {
    outln(`-- summary -- ${newlineCount} lines; last 5:`);
    for (const l of lines.slice(-5)) outln(l);
  }

  // --- failure/error lines, VERBATIM, first 20 -----------------------------
  const failLines = lines.filter((l) => /error|FAILED|panicked|Error:/.test(l)).slice(0, 20);
  if (failLines.length > 0) {
    outln("-- failure/error lines (first 20, verbatim) --");
    for (const l of failLines) outln(l);
  }

  process.exit(exitCode);
}

function reqVal(argv: string[], i: number): string {
  if (i >= argv.length) { err("run_summarized: missing value for flag"); process.exit(2); }
  return argv[i];
}

main();
