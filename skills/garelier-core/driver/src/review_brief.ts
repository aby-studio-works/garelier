// Pickup diff-brief builder for review / integration roles (DEC-081 Piece 2).
//
// The diff-centric roles (Observer, Smith, and — for its non-security framing —
// Guardian) otherwise slurp the WHOLE diff + reports + raw gate log at pickup.
// This builds a compact, machine-readable brief — diffstat + per-file flags +
// diff-vs-report mismatch + parsed gate result + the producer report.json claims
// — so the role reads a map and opens ONLY the hunks it needs.
//
// It carries NO code content / no diff hunks — structural facts only (the token
// win and a no-leak property at once). The role keeps the VERDICT and all
// judgment (Observer/Smith/Guardian are judgment roles); the brief is advisory
// and additive — the role may ignore it and read the raw diff/reports exactly as
// today. Never reduces review rigor (DEC-081 invariants).
//
// Reuses globMatch from observer_policy_check.ts (one implementation).
//
// CLI:
//   bun review_brief.ts --role <observer|smith|guardian> --project <root>
//       --base <ref> --head <ref> [--review-sha SHA] [--config <toml>]
//       [--report-json <path>] [--gate <path>] [--out <path>]
//   Writes the brief JSON to --out (default stdout). Exit 0 on a produced brief,
//   2 on usage error. Read/compute failures fail OPEN (unknown fields + a note).

import { parse } from "smol-toml";
import { globMatch } from "./observer_policy_check.ts";

export type FileStatus = "A" | "M" | "D" | "R" | "?";
export type FileFlag = "protected" | "manifest" | "migration" | "test";
export type GateResult = "pass" | "fail" | "unknown";

export interface DiffEntry {
  path: string;
  status: FileStatus;
  added: number;
  deleted: number;
  binary: boolean;
}
export interface ReviewClaims {
  status?: string | null;
  tests?: unknown;
  risk_flags?: unknown;
  summary?: string | null;
  files_changed?: string[];
}
export interface GateInfo {
  result: GateResult;
  failing: string[];
}
export interface BriefInput {
  role: string;
  scope: { base_ref?: string | null; head_ref?: string | null; review_sha?: string | null };
  entries: DiffEntry[];
  claims: ReviewClaims | null;
  protectedGlobs: string[];
  packageBasenames: string[];
  largeDiffLines: number;
  gate?: GateInfo | null;
}
export interface BriefFile {
  path: string;
  status: FileStatus;
  added: number;
  deleted: number;
  flags: FileFlag[];
}
export interface ReviewBrief {
  schema_version: 1;
  generated_by: "review_brief.ts";
  kind: "review_brief";
  advisory: true;
  role: string;
  scope: BriefInput["scope"];
  diffstat: { files: number; added: number; deleted: number; churn: number };
  files: BriefFile[];
  report_match: { undisclosed: string[]; claimed_absent: string[] } | null;
  claims: ReviewClaims | null;
  gate: GateInfo | null;
  signals: {
    large_diff: boolean;
    touches_protected: boolean;
    touches_manifest: boolean;
    source_changed_without_tests: boolean;
  };
  note: string;
}

const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z0-9]+$|\.(test|spec)\.[a-z0-9]+$/i;
const MIGRATION_RE = /(^|\/)migrations?\/|\.sql$|(^|\/)schema(\.|\/|$)/i;

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function flagsFor(path: string, protectedGlobs: string[], packageBasenames: Set<string>): FileFlag[] {
  const flags: FileFlag[] = [];
  if (protectedGlobs.some((g) => globMatch(g, path))) flags.push("protected");
  if (packageBasenames.has(basename(path))) flags.push("manifest");
  if (MIGRATION_RE.test(path)) flags.push("migration");
  if (TEST_RE.test(path)) flags.push("test");
  return flags;
}

// Pure. Deterministic: same inputs → same brief.
export function buildReviewBrief(inp: BriefInput): ReviewBrief {
  const pkg = new Set(inp.packageBasenames.map(basename));
  const files: BriefFile[] = inp.entries.map((e) => ({
    path: e.path,
    status: e.status,
    added: e.added,
    deleted: e.deleted,
    flags: flagsFor(e.path, inp.protectedGlobs, pkg),
  }));

  const added = files.reduce((s, f) => s + (f.added || 0), 0);
  const deleted = files.reduce((s, f) => s + (f.deleted || 0), 0);
  const churn = added + deleted;

  // diff-vs-report (the mechanical part of the Observer §9 "diff matches report"
  // check): files in the diff but absent from report.json.files_changed, and
  // files claimed changed but absent from the diff.
  let report_match: ReviewBrief["report_match"] = null;
  if (inp.claims && Array.isArray(inp.claims.files_changed)) {
    const diffPaths = new Set(files.map((f) => f.path));
    const claimed = new Set(inp.claims.files_changed);
    report_match = {
      undisclosed: [...diffPaths].filter((p) => !claimed.has(p)).sort(),
      claimed_absent: [...claimed].filter((p) => !diffPaths.has(p)).sort(),
    };
  }

  const touches_protected = files.some((f) => f.flags.includes("protected"));
  const touches_manifest = files.some((f) => f.flags.includes("manifest"));
  const sourceChanged = files.some(
    (f) => (f.status === "A" || f.status === "M") && !f.flags.includes("test"),
  );
  const testChanged = files.some((f) => (f.status === "A" || f.status === "M") && f.flags.includes("test"));

  return {
    schema_version: 1,
    generated_by: "review_brief.ts",
    kind: "review_brief",
    advisory: true,
    role: inp.role,
    scope: inp.scope,
    diffstat: { files: files.length, added, deleted, churn },
    files,
    report_match,
    claims: inp.claims,
    gate: inp.gate ?? null,
    signals: {
      large_diff: inp.largeDiffLines > 0 && churn >= inp.largeDiffLines,
      touches_protected,
      touches_manifest,
      source_changed_without_tests: sourceChanged && !testChanged,
    },
    note: "context brief, not a verdict (DEC-081); advisory — open the hunks you need; you keep the verdict and may read the raw diff / reports. No code content is included.",
  };
}

// ---- parsing ----------------------------------------------------------------

// `git diff --name-status base...head` → [{status, path}]. Handles renames
// (`R<score>\told\tnew`) by reporting the new path with status R.
export function parseNameStatus(text: string): { status: FileStatus; path: string }[] {
  const out: { status: FileStatus; path: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = (parts[0]?.[0] ?? "?") as string;
    const status: FileStatus =
      code === "A" || code === "M" || code === "D" || code === "R" ? (code as FileStatus) : "?";
    const path = status === "R" ? parts[parts.length - 1] : parts[1];
    if (path) out.push({ status, path });
  }
  return out;
}

// `git diff --numstat base...head` → Map<path, {added, deleted, binary}>. Binary
// files show `-\t-` → binary:true, 0 churn. Rename rows (`old => new` or
// `{a => b}`) resolve to the new path.
export function parseNumstat(text: string): Map<string, { added: number; deleted: number; binary: boolean }> {
  const map = new Map<string, { added: number; deleted: number; binary: boolean }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const a = parts[0];
    const d = parts[1];
    let path = parts.slice(2).join("\t");
    if (path.includes(" => ")) {
      // "old => new" or "pre/{old => new}/post"
      path = path.replace(/\{[^}]*=>\s*([^}]*)\}/, "$1").replace(/^.*=>\s*/, "").trim();
    }
    const binary = a === "-" || d === "-";
    map.set(path, { added: binary ? 0 : parseInt(a, 10) || 0, deleted: binary ? 0 : parseInt(d, 10) || 0, binary });
  }
  return map;
}

export function mergeEntries(
  nameStatus: { status: FileStatus; path: string }[],
  numstat: Map<string, { added: number; deleted: number; binary: boolean }>,
): DiffEntry[] {
  return nameStatus.map((ns) => {
    const n = numstat.get(ns.path) ?? { added: 0, deleted: 0, binary: false };
    return { path: ns.path, status: ns.status, added: n.added, deleted: n.deleted, binary: n.binary };
  });
}

// Best-effort gate parse: failure markers win; else a success marker → pass; else
// unknown. The agent always re-checks — this only orients.
export function parseGate(text: string): GateInfo {
  const failing = text
    .split("\n")
    .filter((l) => /(\bFAIL\b|\berror\b|\bfailed\b|✗)/i.test(l) && !/0 (errors|failures|fail)\b/i.test(l))
    .map((l) => l.trim())
    .slice(0, 20);
  const pass = /(all checks passed|\bpassed\b|✓|\b0 fail\b|build succeeded)/i.test(text);
  const result: GateResult = failing.length ? "fail" : pass ? "pass" : "unknown";
  return { result, failing };
}

// ---- CLI --------------------------------------------------------------------

function fail(msg: string): never {
  process.stderr.write(`review_brief: ${msg}\n`);
  process.exit(2);
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function gitText(projectRoot: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", projectRoot, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.exitCode})`);
  return new TextDecoder().decode(r.stdout);
}
function pathsOf(v: unknown): string[] {
  const paths = v && typeof v === "object" ? (v as { paths?: unknown }).paths : undefined;
  return Array.isArray(paths) ? paths.map(String) : [];
}
async function readMaybe(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    const f = Bun.file(path);
    return (await f.exists()) ? await f.text() : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const role = flag("role");
  const projectRoot = flag("project");
  const base = flag("base");
  const head = flag("head");
  if (!role || !projectRoot || !base || !head) {
    fail("usage: review_brief.ts --role <observer|smith|guardian> --project <root> --base <ref> --head <ref> [--review-sha SHA] [--config <toml>] [--report-json <path>] [--gate <path>] [--out <path>]");
  }

  // Config-derived policy inputs (all optional / best-effort).
  let protectedGlobs: string[] = [];
  let packageBasenames = ["package.json", "bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.toml", "Cargo.lock", "requirements.txt", "pyproject.toml", "go.mod", "go.sum", "Gemfile", "Gemfile.lock"];
  let largeDiffLines = 400;
  const cfgText = await readMaybe(flag("config"));
  if (cfgText) {
    try {
      const cfg = parse(cfgText) as Record<string, unknown>;
      const perms = (cfg.permissions ?? {}) as Record<string, unknown>;
      if (Array.isArray(perms.require_pm_approval_paths)) protectedGlobs = (perms.require_pm_approval_paths as unknown[]).map(String);
      const gp = (cfg.guardian_policy ?? {}) as Record<string, unknown>;
      const pf = pathsOf(gp.package_files);
      if (pf.length) packageBasenames = pf;
      const op = (cfg.observer_policy ?? {}) as Record<string, unknown>;
      if (typeof op.large_diff_lines === "number") largeDiffLines = op.large_diff_lines;
    } catch { /* fail-open: defaults */ }
  }

  // Claims from the producer report.json.
  let claims: ReviewClaims | null = null;
  const reportText = await readMaybe(flag("report-json"));
  if (reportText) {
    try {
      const r = JSON.parse(reportText) as Record<string, unknown>;
      claims = {
        status: (r.status as string) ?? null,
        tests: r.tests ?? null,
        risk_flags: r.risk_flags ?? null,
        summary: (r.summary as string) ?? null,
        files_changed: Array.isArray(r.files_changed) ? (r.files_changed as unknown[]).map(String) : undefined,
      };
    } catch { /* leave null */ }
  }

  const gateText = await readMaybe(flag("gate"));
  const gate = gateText != null ? parseGate(gateText) : null;

  let entries: DiffEntry[] = [];
  try {
    const ns = parseNameStatus(gitText(projectRoot, ["diff", "--name-status", `${base}...${head}`]));
    const num = parseNumstat(gitText(projectRoot, ["diff", "--numstat", `${base}...${head}`]));
    entries = mergeEntries(ns, num);
  } catch (e) {
    process.stderr.write(`review_brief: ${(e as Error).message}; emitting empty diff brief (read raw)\n`);
  }

  const brief = buildReviewBrief({
    role,
    scope: { base_ref: base, head_ref: head, review_sha: flag("review-sha") ?? null },
    entries,
    claims,
    protectedGlobs,
    packageBasenames,
    largeDiffLines,
    gate,
  });

  const json = JSON.stringify(brief, null, 2);
  const out = flag("out");
  if (out) {
    await Bun.write(out, json + "\n");
    process.stdout.write(`${out}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

if (import.meta.main) {
  void main();
}
