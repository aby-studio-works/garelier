// Workflow page data for the read-only Status Web Console.
//
// W-020: show how PM-authored Pipeline packages move through dispatch without
// turning Status Web into an executor. This reads blueprints, STATE.md,
// assignment.md, report artifacts, and dispatch events only.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parsePipelinePackages, validatePipelinePackages } from "./pipeline_packages.ts";
import type {
  DispatchEvent,
  WorkflowFinding,
  WorkflowInfo,
  WorkflowPackageInfo,
  WorkflowPackageStatus,
} from "./status_types.ts";

const ACTIVE_STATES = new Set(["ASSIGNED", "WORKING", "REPORTING", "REVIEWING", "REWORK", "OBSERVING", "CHECKING"]);
const BLOCKED_STATES = new Set(["BLOCKED", "FAILED", "ABORTED"]);
const DONE_EVENTS = new Set(["complete", "done", "merged"]);

const fwd = (p: string): string => p.replace(/\\/g, "/");
const cleanRoot = (root: string): string => fwd(root).replace(/\/+$/, "");
const nz = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);

function relTo(root: string, abs: string): string {
  const r = cleanRoot(root);
  const a = fwd(abs);
  return a.startsWith(r + "/") ? a.slice(r.length + 1) : a;
}

function readText(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

function listMarkdown(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".md"))
      .map((n) => join(dir, n))
      .filter((p) => {
        try { return statSync(p).isFile(); } catch { return false; }
      })
      .sort();
  } catch {
    return [];
  }
}

function parseEvents(runtime: string): DispatchEvent[] {
  const file = join(runtime, "dispatch", "events.jsonl");
  if (!existsSync(file)) return [];
  const out: DispatchEvent[] = [];
  for (const line of readText(file).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      out.push({
        ts: o.ts != null ? String(o.ts) : null,
        role: String(o.role ?? "?"),
        kind: String(o.kind ?? "note"),
        task: o.task != null ? String(o.task) : null,
        ref: o.ref != null ? String(o.ref) : null,
      });
    } catch { /* skip malformed event */ }
  }
  return out;
}

function eventMatchesPackage(e: DispatchEvent, packageId: string, blueprintRel: string): boolean {
  const hay = `${e.role}\n${e.kind}\n${e.task ?? ""}\n${e.ref ?? ""}`;
  const idRe = new RegExp(`(^|[^A-Z0-9-])${packageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9-]|$)`, "i");
  return idRe.test(hay) || hay.toLowerCase().includes(blueprintRel.toLowerCase());
}

function assignmentPackageId(md: string): string | null {
  return (
    md.match(/Pipeline packages\s*\/\s*(PP-[0-9]+)/i)?.[1] ??
    md.match(/Package\s*ID\s*:\s*(PP-[0-9]+)/i)?.[1] ??
    null
  )?.toUpperCase() ?? null;
}

function assignmentBlueprintRel(projectRoot: string, md: string): string | null {
  const raw = md.match(/`([^`\r\n]+?\.md)`\s*\(section:\s*Pipeline packages\s*\//i)?.[1];
  if (!raw) return null;
  const norm = fwd(raw);
  const root = cleanRoot(projectRoot);
  return norm.startsWith(root + "/") ? norm.slice(root.length + 1) : norm.replace(/^\.?\//, "");
}

function stateStatus(md: string): string | null {
  return nz(md.match(/##\s*Status\s*\r?\n\s*([A-Za-z_ -]+)/)?.[1])?.toUpperCase() ?? null;
}

interface ContainerSignal {
  packageId: string;
  blueprintRel: string | null;
  state: string | null;
  containerRel: string;
  assignmentRel: string | null;
  reportRel: string | null;
}

function pushContainer(out: ContainerSignal[], projectRoot: string, dir: string): void {
  const assignment = join(dir, "assignment.md");
  if (!existsSync(assignment)) return;
  const md = readText(assignment);
  const packageId = assignmentPackageId(md);
  if (!packageId) return;
  const stateMd = readText(join(dir, "STATE.md"));
  const reportMd = join(dir, "report.md");
  const reportJson = join(dir, "report.json");
  const reportRel = existsSync(reportMd) ? relTo(projectRoot, reportMd) : existsSync(reportJson) ? relTo(projectRoot, reportJson) : null;
  out.push({
    packageId,
    blueprintRel: assignmentBlueprintRel(projectRoot, md),
    state: stateStatus(stateMd),
    containerRel: relTo(projectRoot, dir),
    assignmentRel: relTo(projectRoot, assignment),
    reportRel,
  });
}

function scanContainers(projectRoot: string, pmRoot: string): ContainerSignal[] {
  const out: ContainerSignal[] = [];
  try {
    for (const name of readdirSync(pmRoot)) {
      const abs = join(pmRoot, name);
      if (/^_dispatch\d+$/.test(name)) {
        pushContainer(out, projectRoot, abs);
        continue;
      }
      if (name === "_artisan") {
        pushContainer(out, projectRoot, abs);
        continue;
      }
      if (!/^_(workers|scouts|smiths|librarians|guardians|observers|concierges)$/.test(name)) continue;
      let ids: string[] = [];
      try { ids = readdirSync(abs); } catch { continue; }
      for (const id of ids) pushContainer(out, projectRoot, join(abs, id));
    }
  } catch { /* no PM root */ }
  return out;
}

function containerKey(signal: ContainerSignal): string {
  return `${signal.blueprintRel ?? ""}\u0000${signal.packageId}`;
}

function statusFrom(signal: ContainerSignal | null, events: DispatchEvent[], issues: string[]): WorkflowPackageStatus {
  if (issues.length > 0) return "blocked";
  const st = (signal?.state ?? "").toUpperCase();
  if (BLOCKED_STATES.has(st)) return "blocked";
  if (ACTIVE_STATES.has(st)) return "active";
  if (signal?.reportRel) return "done";
  if (events.some((e) => DONE_EVENTS.has(String(e.kind || "").toLowerCase()))) return "done";
  return "planned";
}

function sortStatus(a: WorkflowPackageInfo, b: WorkflowPackageInfo): number {
  if (a.blueprintRel !== b.blueprintRel) return a.blueprintRel.localeCompare(b.blueprintRel);
  const an = Number(a.packageId.replace(/\D+/g, ""));
  const bn = Number(b.packageId.replace(/\D+/g, ""));
  return (Number.isFinite(an) ? an : 9999) - (Number.isFinite(bn) ? bn : 9999);
}

export function buildWorkflow(projectRoot: string, pmId: string): WorkflowInfo {
  const root = cleanRoot(projectRoot);
  const pmRoot = join(root, "__garelier", pmId);
  const blueprintsDir = join(pmRoot, "control", "blueprints");
  const runtime = join(pmRoot, "runtime");
  const events = parseEvents(runtime);
  const containers = scanContainers(root, pmRoot);
  const byExact = new Map<string, ContainerSignal>();
  const byPackage = new Map<string, ContainerSignal[]>();
  for (const c of containers) {
    byExact.set(containerKey(c), c);
    const arr = byPackage.get(c.packageId) ?? [];
    arr.push(c);
    byPackage.set(c.packageId, arr);
  }

  const findings: WorkflowFinding[] = [];
  const packages: WorkflowPackageInfo[] = [];
  for (const file of listMarkdown(blueprintsDir)) {
    const md = readText(file);
    const parsed = parsePipelinePackages(md);
    if (parsed.length === 0) continue;
    const rel = relTo(root, file);
    const issues = validatePipelinePackages(parsed);
    for (const issue of issues) {
      findings.push({ severity: issue.level === "error" ? "error" : "warning", rel, packageId: issue.package_id, message: issue.message });
    }
    for (const p of parsed) {
      const localIssues = issues.filter((i) => i.package_id === p.id && i.level === "error").map((i) => i.message);
      const exact = byExact.get(`${rel}\u0000${p.id}`);
      const candidates = byPackage.get(p.id) ?? [];
      const signal = exact ?? (candidates.length === 1 ? candidates[0] : null);
      const recentEvents = events.filter((e) => eventMatchesPackage(e, p.id, rel)).slice(-8).reverse();
      packages.push({
        blueprint: basename(file).replace(/\.md$/i, ""),
        blueprintRel: rel,
        packageId: p.id,
        title: p.title,
        role: p.role,
        dispatch: p.dispatch,
        dependsOn: p.depends_on,
        status: statusFrom(signal, recentEvents, localIssues),
        state: signal?.state ?? null,
        container: signal?.containerRel ?? null,
        assignmentRel: signal?.assignmentRel ?? null,
        reportRel: signal?.reportRel ?? null,
        expectedOutputs: p.expected_outputs,
        issues: localIssues,
        recentEvents,
      });
    }
  }
  packages.sort(sortStatus);
  const counts: Record<WorkflowPackageStatus, number> = { planned: 0, active: 0, blocked: 0, done: 0 };
  for (const p of packages) counts[p.status]++;
  return { present: packages.length > 0, packages, counts, findings };
}
