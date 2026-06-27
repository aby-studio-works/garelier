// Review/gate prep wrapper (W-018).
//
// Generates the advisory review brief and, for Guardian, a redacted scan draft,
// then records their paths in the assignment. This wires existing deterministic
// helpers into a single Dock/Artisan prep step without changing role verdict
// authority.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewBrief, mergeEntries, parseGate, parseNameStatus, parseNumstat, type DiffEntry, type ReviewClaims } from "./review_brief.ts";

export type PrepRole = "observer" | "guardian" | "smith";
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

export interface ReviewGatePrepResult {
  schema_version: 1;
  generated_by: "review_gate_prep.ts";
  kind: "review_gate_prep";
  advisory: true;
  role: PrepRole;
  assignment: string | null;
  review_brief: string;
  guardian_scan_draft: string | null;
  updated_assignment: boolean;
  warnings: string[];
  note: string;
}

function gitText(projectRoot: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", projectRoot, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.exitCode})`);
  return new TextDecoder().decode(r.stdout);
}

function readMaybe(path: string | null | undefined): string | null {
  if (!path) return null;
  try { return existsSync(path) ? readFileSync(path, "utf8") : null; } catch { return null; }
}

function parseClaims(path: string | null | undefined): ReviewClaims | null {
  const txt = readMaybe(path);
  if (!txt) return null;
  try {
    const r = JSON.parse(txt) as Record<string, unknown>;
    return {
      status: typeof r.status === "string" ? r.status : null,
      tests: r.tests ?? null,
      risk_flags: r.risk_flags ?? null,
      summary: typeof r.summary === "string" ? r.summary : null,
      files_changed: Array.isArray(r.files_changed) ? r.files_changed.map(String) : undefined,
    };
  } catch { return null; }
}

function appendPreparedContext(assignment: string, paths: string[]): boolean {
  if (!assignment || !existsSync(assignment)) return false;
  const current = readFileSync(assignment, "utf8");
  if (/^##\s+Prepared context\s*$/im.test(current)) return false;
  const block = [
    "",
    "## Prepared context",
    "",
    ...paths.map((p) => `- \`${p}\``),
    "",
    "These generated files are advisory maps only. Read raw diffs, reports, and policy files as needed; verdict authority remains with this role.",
    "",
  ].join("\n");
  writeFileSync(assignment, current.replace(/\s*$/, "\n") + block, "utf8");
  return true;
}

export interface BuildReviewGatePrepOptions {
  role: PrepRole;
  projectRoot: string;
  base: string;
  head: string;
  outDir: string;
  assignmentPath?: string | null;
  configPath?: string | null;
  securityRoot?: string | null;
  reportJsonPath?: string | null;
  gatePath?: string | null;
  reviewSha?: string | null;
  updateAssignment?: boolean;
}

export function buildReviewGatePrep(opts: BuildReviewGatePrepOptions): ReviewGatePrepResult {
  mkdirSync(opts.outDir, { recursive: true });
  const warnings: string[] = [];
  let entries: DiffEntry[] = [];
  try {
    const ns = parseNameStatus(gitText(opts.projectRoot, ["diff", "--name-status", `${opts.base}...${opts.head}`]));
    const num = parseNumstat(gitText(opts.projectRoot, ["diff", "--numstat", `${opts.base}...${opts.head}`]));
    entries = mergeEntries(ns, num);
  } catch (e) {
    warnings.push((e as Error).message);
  }
  const brief = buildReviewBrief({
    role: opts.role,
    scope: { base_ref: opts.base, head_ref: opts.head, review_sha: opts.reviewSha ?? null },
    entries,
    claims: parseClaims(opts.reportJsonPath),
    protectedGlobs: [],
    packageBasenames: ["package.json", "Cargo.toml", "Cargo.lock", "package-lock.json", "bun.lock"],
    largeDiffLines: 400,
    gate: readMaybe(opts.gatePath) ? parseGate(readMaybe(opts.gatePath)!) : null,
  });
  const briefPath = join(opts.outDir, `${opts.role}_review_brief.json`).replace(/\\/g, "/");
  writeFileSync(briefPath, JSON.stringify(brief, null, 2) + "\n", "utf8");

  let scanPath: string | null = null;
  if (opts.role === "guardian") {
    scanPath = join(opts.outDir, "guardian_scan_draft.json").replace(/\\/g, "/");
    const args = [
      join(SRC_DIR, "guardian_scan.ts"),
      opts.configPath ?? join(opts.projectRoot, "__garelier", "_missing", "_pm", "setup_config.toml"),
      opts.projectRoot,
      opts.base,
      opts.head,
      "--security-root",
      opts.securityRoot ?? join(opts.projectRoot, "__garelier", "_missing", "knowledge", "security"),
      "--out",
      scanPath,
    ];
    const r = Bun.spawnSync(["bun", ...args]);
    if (r.exitCode !== 0) {
      warnings.push(`guardian_scan unavailable; manual Guardian scan required (exit ${r.exitCode})`);
      writeFileSync(scanPath, JSON.stringify({
        schema_version: 1,
        generated_by: "review_gate_prep.ts",
        kind: "guardian_scan_draft",
        advisory: true,
        provisional_verdict: "NO_OPINION",
        findings: [],
        note: "guardian_scan.ts did not complete; Guardian must run the manual security/privacy/dependency/license gate.",
      }, null, 2) + "\n", "utf8");
    }
  }

  const prepared = [briefPath, ...(scanPath ? [scanPath] : [])];
  const updated = opts.updateAssignment ? appendPreparedContext(opts.assignmentPath ?? "", prepared) : false;
  return {
    schema_version: 1,
    generated_by: "review_gate_prep.ts",
    kind: "review_gate_prep",
    advisory: true,
    role: opts.role,
    assignment: opts.assignmentPath ?? null,
    review_brief: briefPath,
    guardian_scan_draft: scanPath,
    updated_assignment: updated,
    warnings,
    note: "Generated context only. Guardian/Observer/Smith keep judgment authority and may read raw diffs/reports.",
  };
}

function fail(msg: string): never {
  process.stderr.write(`review_gate_prep: ${msg}\n`);
  process.exit(2);
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const role = flag("role") as PrepRole | undefined;
  if (!role || !["observer", "guardian", "smith"].includes(role)) fail("--role must be observer|guardian|smith");
  const result = buildReviewGatePrep({
    role,
    projectRoot: flag("project") ?? fail("--project is required"),
    base: flag("base") ?? fail("--base is required"),
    head: flag("head") ?? fail("--head is required"),
    outDir: flag("out-dir") ?? fail("--out-dir is required"),
    assignmentPath: flag("assignment") ?? null,
    configPath: flag("config") ?? null,
    securityRoot: flag("security-root") ?? null,
    reportJsonPath: flag("report-json") ?? null,
    gatePath: flag("gate") ?? null,
    reviewSha: flag("review-sha") ?? null,
    updateAssignment: hasFlag("update-assignment"),
  });
  const json = JSON.stringify(result, null, 2) + "\n";
  const out = flag("out");
  if (out) await Bun.write(out, json);
  else process.stdout.write(json);
}

if (import.meta.main) {
  void main();
}
