#!/usr/bin/env bun
/**
 * PM-delegated mandatory scanner evidence writer.
 *
 * The gate seat's `guard.mandatory_scanner.evidence_contract` requires a file
 * the Guardian can CITE — not a summary in the task file:
 *
 *   "PM executes in the reviewed checkout with explicit base/head SHAs;
 *    evidence records command, comparison metadata, head, and redacted output;
 *    Guardian cites the evidence file and refuses a SHA mismatch."
 *
 * A summary of version/exit/findings does NOT bind the run to a review, so the
 * Guardian cannot tell which checkout was actually scanned. Two gate seats
 * BLOCKed on exactly that in one day (2026-08-23). This script accepts only the
 * shared scannerCommand() whole-tree argv, verifies checkout HEAD, and writes
 * all required run facts. The base is comparison metadata; the scanner itself
 * always scans the whole tree at the exact head. Arbitrary shell replacement
 * is not supported.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { requireRuntimeExecutable, resolveCommand } from "./_lib.ts";
import { existsSync, mkdirSync } from "node:fs";
import { writeGuardedFileSync } from "../guard/path_guard.ts";
import { dirname, resolve } from "node:path";
import { normalizeScannerReport, scannerCommand } from "../guardian_scan.ts";

function scannerField(item: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) if (item[name] !== undefined) return item[name];
  return undefined;
}

/** The shared normalizer is intentionally tolerant for advisory Guardian input.
 * Mandatory evidence has a stricter contract: every emitted entry must be a
 * recognizable finding, otherwise an exit-0 scanner could become zero findings. */
function normalizeMandatoryScannerReport(raw: string): ReturnType<typeof normalizeScannerReport> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("scanner_evidence: scanner output is not valid JSON"); }
  if (!Array.isArray(parsed)) throw new Error("scanner_evidence: scanner output must be a JSON array");
  parsed.forEach((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`scanner_evidence: scanner finding ${index} is not an object`);
    }
    const item = value as Record<string, unknown>;
    const file = scannerField(item, ["File", "file", "path"]);
    const line = scannerField(item, ["StartLine", "startLine", "line"]);
    const rule = scannerField(item, ["RuleID", "ruleID", "ruleId", "rule"]);
    const severity = scannerField(item, ["Severity", "severity"]);
    const validLine = typeof line === "number"
      ? Number.isInteger(line) && line >= 0
      : typeof line === "string" && /^\d+$/.test(line);
    if (typeof file !== "string" || !file.trim() || !validLine || typeof rule !== "string" || !rule.trim()
      || (severity !== undefined && typeof severity !== "string")) {
      throw new Error(`scanner_evidence: scanner finding ${index} has a malformed schema`);
    }
  });
  const normalized = normalizeScannerReport(raw);
  if (normalized.length !== parsed.length) {
    throw new Error("scanner_evidence: scanner findings could not be normalized without loss");
  }
  return normalized;
}

const argv = process.argv.slice(2);
const flag = (name: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : "";
};

const checkout = flag("checkout");
const base = flag("base");
const head = flag("head");
const out = flag("out");
const command = flag("command");

export function canonicalScannerArgv(commandText: string): string[] {
  const accepted = (["gitleaks", "betterleaks"] as const).map((backend) =>
    scannerCommand(backend, { subcommand: "dir", target: "." }));
  const argv = accepted.find((candidate) => candidate.join(" ") === commandText);
  if (!argv) {
    throw new Error("scanner_evidence: --command must exactly match shared scannerCommand() whole-tree argv");
  }
  return argv;
}

if (!checkout || !base || !head || !out || !command) {
  console.error(
    "scanner_evidence: --checkout <dir> --base <sha> --head <sha> --command <canonical-cmd> --out <file>",
  );
  process.exit(2);
}

const shaLike = /^[0-9a-f]{40}$/;
for (const [name, value] of [["base", base], ["head", head]] as const) {
  if (!shaLike.test(value)) {
    console.error(`scanner_evidence: --${name} must be a full 40-hex SHA (got: ${value})`);
    process.exit(2);
  }
}

let scannerArgv: string[];
try { scannerArgv = canonicalScannerArgv(command); }
catch (error) { console.error((error as Error).message); process.exit(2); }

// Resolve every tool through the central absolute-path resolver. Execute the
// scanner directly: accepting a shell string would reintroduce an arbitrary
// command-substitution surface behind PM/Dock authority.
const GIT = requireRuntimeExecutable("git");
const resolvedScanner = resolveCommand(scannerArgv);
if (!resolvedScanner) {
  console.error(`scanner_evidence: scanner executable not found: ${scannerArgv[0]}`);
  process.exit(2);
}
const scannerExecutable = resolvedScanner[0]!;
const scannerRunArgs = resolvedScanner.slice(1);

const cwd = resolve(checkout);
if (!existsSync(cwd)) {
  console.error(`scanner_evidence: checkout not found: ${cwd}`);
  process.exit(2);
}

// Refuse review metadata the checkout cannot resolve: an evidence file naming
// SHAs outside this repository would bind the scan to the wrong universe.
for (const sha of [base, head]) {
  const probe = spawnSync(GIT, ["-C", cwd, "cat-file", "-e", `${sha}^{commit}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.status !== 0) {
    console.error(`scanner_evidence: ${sha} is not a commit in ${cwd}`);
    process.exit(2);
  }
}
const headProbe = spawnSync(GIT, ["-C", cwd, "rev-parse", "HEAD"], {
  encoding: "utf8",
  windowsHide: true,
});
if (headProbe.status !== 0 || (headProbe.stdout ?? "").trim() !== head) {
  console.error(`scanner_evidence: checkout HEAD does not match --head ${head}`);
  process.exit(2);
}

const version = Bun.spawnSync([scannerExecutable, "version"], {
  cwd,
  windowsHide: true,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const run = Bun.spawnSync([scannerExecutable, ...scannerRunArgs], {
  cwd,
  windowsHide: true,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const stdout = run.stdout.toString().trim();
const stderr = run.stderr.toString().trim();
const exit = run.exitCode;
const runAt = new Date().toISOString();
const stdoutSha256 = createHash("sha256").update(stdout).digest("hex");
let normalized: ReturnType<typeof normalizeScannerReport>;
try { normalized = normalizeMandatoryScannerReport(stdout); }
catch (error) { console.error((error as Error).message); process.exit(2); }
const targetFindings = normalized.filter((finding) => finding.file.replace(/\\/g, "/").startsWith("target/")).length;
const outsideTargetFindings = normalized.length - targetFindings;

const comparisonStat = spawnSync(GIT, ["-C", cwd, "diff", "--shortstat", base, head], {
  encoding: "utf8",
  windowsHide: true,
});

const body = `# mandatory secret scanner — PM-delegated evidence

| fact | value |
| :--- | :--- |
| command | \`${command}\` |
| cwd | \`${cwd}\` |
| scan scope | whole tree (\`.\`) at verified head |
| comparison base (metadata only) | \`${base}\` |
| verified review head | \`${head}\` |
| run at | ${runAt} |
| version | ${version.stdout.toString().trim() || "(unavailable)"} |
| exit code | **${exit}** |
| stdout sha256 | \`${stdoutSha256}\` |
| findings under target/ | ${targetFindings} |
| findings outside target/ | ${outsideTargetFindings} |
| candidate diff (metadata only) | ${(comparisonStat.stdout ?? "").trim() || "(unavailable)"} |

## redacted output (verbatim stdout)

\`\`\`
${stdout || "(empty)"}
\`\`\`

## verbatim stderr

\`\`\`
${stderr || "(empty)"}
\`\`\`
`;

mkdirSync(dirname(resolve(out)), { recursive: true });
// GDN-B14: the evidence path is derived from the review SHA and lands in the
// producer lane, so it is predictable and pre-placeable. Both artifacts go
// through the guarded writer, which refuses a symlink, reparse point or
// hard-linked leaf instead of writing a PM-authority payload through it.
writeGuardedFileSync(resolve(out), body, "scanner_evidence");
writeGuardedFileSync(resolve(`${out}.json`), JSON.stringify({
  schema_version: 1,
  generated_by: "scanner_evidence.ts",
  argv: resolvedScanner,
  scanner_command: command,
  cwd,
  base,
  head,
  scan_scope: "whole-tree-at-head",
  base_role: "comparison-metadata",
  run_at: runAt,
  exit,
  stdout_sha256: stdoutSha256,
  finding_counts: {
    total: normalized.length,
    under_target: targetFindings,
    outside_target: outsideTargetFindings,
  },
}, null, 2) + "\n", "scanner_evidence");
console.log(`scanner_evidence: wrote ${resolve(out)} (exit=${exit})`);
process.exit(exit === 0 ? 0 : 1);
