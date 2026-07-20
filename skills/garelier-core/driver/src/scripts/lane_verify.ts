#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { die, emitJsonLine, requireRuntimeExecutable, resolveBashLaunch, valueAfter } from "./_lib.ts";
import { captureStep, laneWorktree, posix, tailLines, validateSlug, type StepResult } from "./lane_common.ts";

const HELP = `#
# lane_verify.ts — exit-safe canonical lane verification runner (W-095 (b)).
#
# Runs a lane's verification steps and prints a VERBATIM per-step summary so a
# hand-assembled "green" (the false-green class — real incident 2026-07-16) is
# impossible: every step's REAL exit code is captured directly from the process
# (no shell pipe, so no PIPESTATUS masking), and the runner exits non-zero if any
# step fails. Its own summary is the evidence to paste into a report.
#
# Default steps for a framework/control-repo lane (auto-detected when
# <worktree>/skills/garelier-core/driver exists):
#   1. local TypeScript tsc --noEmit (in the lane worktree's driver)
#   2. bun test [--test-filter S]  (in the lane worktree's driver)
# Add lane-specific steps:
#   --test <path>   a *.test.ts fixture, run with bun test in the worktree (repeatable)
#   --cmd <string>  an arbitrary command run via 'bash -c' in the worktree (repeatable)
#
# Usage:
#   lane_verify.ts --repo <path> --slug <kebab> [--pm-id <id>] [--worktree <dir>]
#                  [--test-filter <substr>] [--no-driver-gate]
#                  [--test <path>]... [--cmd <string>]... [--json]
#
# Exit 0 iff EVERY step passed; otherwise 1. --json also emits a machine summary.`;

interface Args {
  repo: string; slug: string; pm: string; worktree: string; testFilter: string;
  driverGate: boolean; test: string[]; cmd: string[]; json: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = { repo: "", slug: "", pm: "", worktree: "", testFilter: "", driverGate: true, test: [], cmd: [], json: false };
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--repo": a.repo = valueAfter(argv, i); i += 2; break;
      case "--slug": a.slug = valueAfter(argv, i); i += 2; break;
      case "--pm-id": a.pm = valueAfter(argv, i); i += 2; break;
      case "--worktree": a.worktree = valueAfter(argv, i); i += 2; break;
      case "--test-filter": a.testFilter = valueAfter(argv, i); i += 2; break;
      case "--no-driver-gate": a.driverGate = false; i++; break;
      case "--test": a.test.push(valueAfter(argv, i)); i += 2; break;
      case "--cmd": a.cmd.push(valueAfter(argv, i)); i += 2; break;
      case "--json": a.json = true; i++; break;
      case "-h": case "--help": process.stdout.write(`${HELP}\n`); process.exit(0);
      default: die(`lane_verify: unknown arg: ${argv[i]}\nlane_verify: see --help for valid flags`);
    }
  }
  return a;
}

interface StepReport { name: string; code: number; pass: boolean; tail: string; }

function runStep(name: string, command: string[], cwd: string, results: StepReport[], env?: Record<string, string | undefined>): void {
  const r: StepResult = captureStep(command, cwd, env);
  results.push({ name, code: r.code, pass: r.code === 0, tail: tailLines(r.output, 12) });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parse(argv);
  a.repo = posix(a.repo);
  a.worktree = posix(a.worktree);
  if (!a.repo && !a.worktree) die("lane_verify: --repo (with --slug) or --worktree is required");
  let worktree = a.worktree;
  if (!worktree) {
    try { validateSlug(a.slug); } catch (e) { die(`lane_verify: ${(e as Error).message}`); }
    try { worktree = laneWorktree(a.repo, a.slug, a.pm, true); }
    catch (error) { die(`lane_verify: ${(error as Error).message}`); }
  }
  if (!existsSync(worktree)) die(`lane_verify: worktree does not exist: ${worktree}`);

  const results: StepReport[] = [];
  const driverDir = `${worktree}/skills/garelier-core/driver`;
  const hasDriver = existsSync(driverDir);

  if (a.driverGate && hasDriver) {
    const tsc = `${driverDir}/node_modules/typescript/lib/tsc.js`;
    if (!existsSync(tsc)) results.push({ name: "tsc --noEmit (driver)", code: 127, pass: false, tail: `local TypeScript is missing: ${tsc}` });
    else runStep("tsc --noEmit (driver)", [requireRuntimeExecutable("node"), tsc, "--noEmit"], driverDir, results);
    const testCmd = ["bun", "test"];
    if (a.testFilter) testCmd.push("--test-name-pattern", a.testFilter);
    runStep(`bun test (driver)${a.testFilter ? ` [filter: ${a.testFilter}]` : ""}`, testCmd, driverDir, results);
  } else if (a.driverGate && !hasDriver) {
    process.stderr.write(`lane_verify: no driver at ${driverDir}; skipping the driver gate (pass --cmd/--test for this lane's checks).\n`);
  }

  for (const testPath of a.test) {
    if (!existsSync(testPath)) { results.push({ name: `bun test ${testPath}`, code: 127, pass: false, tail: `file not found: ${testPath}` }); continue; }
    runStep(`bun test ${testPath}`, ["bun", "test", testPath], worktree, results);
  }
  for (const c of a.cmd) {
    const shell = resolveBashLaunch();
    if (!shell) results.push({ name: `cmd: ${c}`, code: 127, pass: false, tail: "Git Bash not found" });
    else runStep(`cmd: ${c}`, [shell.executable, "-c", c], worktree, results, shell.env);
  }

  if (results.length === 0) die("lane_verify: no steps to run (driver gate skipped and no --test/--cmd given)", 2);

  const failures = results.filter((r) => !r.pass);
  const total = results.length;
  const out = process.stdout;
  out.write(`=== lane_verify: ${a.slug || worktree} ===\n`);
  results.forEach((r, i) => {
    out.write(`[${i + 1}/${total}] ${r.name} ... ${r.pass ? "PASS" : `FAIL (exit ${r.code})`}\n`);
  });
  for (const r of failures) {
    out.write(`------ ${r.name} (verbatim tail) ------\n${r.tail}\n---------------------------------------\n`);
  }
  out.write(`lane_verify: ${total - failures.length}/${total} passed — ${failures.length === 0 ? "PASS" : "FAIL"}\n`);

  if (a.json) emitJsonLine({ worktree, total, passed: total - failures.length, failed: failures.length, verdict: failures.length === 0 ? "PASS" : "FAIL", steps: results.map((r) => ({ name: r.name, code: r.code, pass: r.pass })) });
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
