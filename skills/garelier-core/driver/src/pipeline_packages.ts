// Blueprint Pipeline packages parser / validator / assignment renderer.
//
// PM-authored blueprints may contain a `## Pipeline packages` section. Each
// `PP-N` package is the machine-readable unit Dock can route to a role. This
// module keeps the split explicit: PM decides the intended package/role shape;
// Dock validates, dispatches, monitors, and gates it.

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  lensForRole,
  parseBlueprintLensSelection,
  parseDefaultLensSetFromSetupConfig,
  parseLensRef,
  renderEquippedLensSection,
  type LensRef,
} from "./lenses.ts";

export type PackageRole = "worker" | "scout" | "smith" | "librarian" | "artisan";
export type TestMode = "standard" | "tdd" | "test-first-waived";
export type IssueLevel = "error" | "warn";

export interface PipelinePackage {
  id: string;
  title: string;
  role: PackageRole | null;
  dispatch: string | null;
  depends_on: string[];
  trigger: string | null;
  goal: string | null;
  kind: string | null;
  inputs: string[];
  allowed_write_paths: string[];
  forbidden_write_paths: string[];
  actions: string[];
  acceptance: string[];
  expected_outputs: string[];
  deliverable: string | null;
  test_discipline: {
    mode: TestMode | null;
    scope: string | null;
    waiver_reason: string | null;
  } | null;
  data_change_guards: string[];
  notes: string[];
  source_id: string | null;
  routine_id: string | null;
  raw: string;
  line: number;
}

export interface PipelineIssue {
  level: IssueLevel;
  package_id: string | null;
  message: string;
}

export interface RenderAssignmentOptions {
  taskId?: string | number | null;
  agentId?: string | null;
  assignedAt?: string | null;
  milestone?: string | null;
  phase?: string | null;
  pmId: string;
  targetSlug?: string | null;
  targetBranch?: string | null;
  slug?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  baseSha?: string | null;
  blueprintPath?: string | null;
  smithCoverageWindow?: string | null;
  coveredWorkerMerges?: string | null;
  equippedLens?: LensRef | null;
  equippedLensSource?: string | null;
}

export interface MigrationOptions {
  now?: string | null;
  write?: boolean;
}

export interface MigrationTreeResult {
  file: string;
  status: "would-migrate" | "migrated" | "already-present" | "skipped";
  reason?: string;
}

const ROLE_SET = new Set<PackageRole>(["worker", "scout", "smith", "librarian", "artisan"]);
const TEST_MODE_SET = new Set<TestMode>(["standard", "tdd", "test-first-waived"]);

function strip(s: string): string {
  return s.trim().replace(/^`(.+)`$/, "$1").trim();
}

function stripChecklist(s: string): string {
  return s.trim().replace(/^\[[ xX]\]\s+/, "").trim();
}

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/\*\*/g, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeId(id: string): string {
  return strip(id).toUpperCase();
}

function splitRefs(v: string): string[] {
  if (!v || /^n\/?a$|^-$/i.test(v.trim())) return [];
  return v.split(/[, ]+/).map(strip).filter(Boolean);
}

function h2Section(md: string, title: string): { body: string; startLine: number } | null {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##(?!#)\s+/.test(lines[i])) { end = i; break; }
  }
  return { body: lines.slice(start + 1, end).join("\n"), startLine: start + 1 };
}

function firstParagraph(section: string): string | null {
  const lines = section.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("<!--") && !l.startsWith("-->"));
  return lines.length ? lines[0] : null;
}

function sectionBullets(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*[0-9]+\.\s+(.*)$/.exec(line);
    const item = bullet?.[1] ?? numbered?.[1];
    if (item) out.push(stripChecklist(item));
  }
  return out.filter(Boolean);
}

interface RawFields {
  scalar: Map<string, string>;
  list: Map<string, string[]>;
}

function parseFields(block: string): RawFields {
  const scalar = new Map<string, string>();
  const list = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of block.split("\n")) {
    const top = /^-\s+(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:\s*(.*)$/.exec(line);
    if (top) {
      current = normalizeKey(top[1]);
      const value = strip(top[2]);
      if (value) scalar.set(current, value);
      if (!list.has(current)) list.set(current, []);
      continue;
    }
    const nested = /^\s{2,}-\s+(.*)$/.exec(line);
    if (nested && current) {
      const item = stripChecklist(nested[1]);
      if (item) list.get(current)!.push(item);
    }
  }
  return { scalar, list };
}

function firstScalar(fields: RawFields, ...keys: string[]): string | null {
  for (const k of keys.map(normalizeKey)) {
    const v = fields.scalar.get(k);
    if (v) return v;
  }
  return null;
}

function firstList(fields: RawFields, ...keys: string[]): string[] {
  for (const k of keys.map(normalizeKey)) {
    const l = fields.list.get(k);
    if (l && l.length) return l;
    const s = fields.scalar.get(k);
    if (s) return [s];
  }
  return [];
}

function parseRole(v: string | null): PackageRole | null {
  const r = v?.trim().toLowerCase();
  return r && ROLE_SET.has(r as PackageRole) ? (r as PackageRole) : null;
}

function parseTestMode(v: string | null): TestMode | null {
  const m = v?.trim().toLowerCase();
  return m && TEST_MODE_SET.has(m as TestMode) ? (m as TestMode) : null;
}

export function parsePipelinePackages(blueprintMd: string): PipelinePackage[] {
  const section = h2Section(blueprintMd, "Pipeline packages");
  if (!section) return [];
  const lines = section.body.split("\n");
  const heads: { index: number; id: string; title: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^###\s+([A-Za-z]+-[0-9A-Za-z-]+)(?:\s*(?:[-—:])\s*(.*)|\s+(.*))?$/.exec(lines[i]);
    if (m) heads.push({ index: i, id: normalizeId(m[1]), title: (m[2] || m[3] || "").trim(), line: section.startLine + i + 1 });
  }
  const packages: PipelinePackage[] = [];
  for (let h = 0; h < heads.length; h++) {
    const head = heads[h];
    const next = heads[h + 1]?.index ?? lines.length;
    const block = lines.slice(head.index + 1, next).join("\n");
    const fields = parseFields(block);
    const roleText = firstScalar(fields, "role");
    const modeText = firstScalar(fields, "test discipline", "test mode", "code test mode");
    const mode = parseTestMode(modeText);
    packages.push({
      id: head.id,
      title: head.title || head.id,
      role: parseRole(roleText),
      dispatch: firstScalar(fields, "dispatch") ?? "immediate",
      depends_on: splitRefs(firstScalar(fields, "depends on", "depends_on") ?? ""),
      trigger: firstScalar(fields, "trigger"),
      goal: firstScalar(fields, "goal"),
      kind: firstScalar(fields, "kind", "package kind"),
      inputs: firstList(fields, "inputs"),
      allowed_write_paths: firstList(fields, "allowed write paths", "allowed_write_paths"),
      forbidden_write_paths: firstList(fields, "forbidden write paths", "forbidden_write_paths"),
      actions: firstList(fields, "do", "actions"),
      acceptance: firstList(fields, "acceptance", "acceptance criteria"),
      expected_outputs: firstList(fields, "expected outputs", "outputs"),
      deliverable: firstScalar(fields, "deliverable"),
      test_discipline: modeText
        ? { mode, scope: firstScalar(fields, "scope"), waiver_reason: firstScalar(fields, "waiver reason", "waiver_reason") }
        : null,
      data_change_guards: firstList(fields, "data-change guards", "data change guards"),
      notes: firstList(fields, "notes"),
      source_id: firstScalar(fields, "source id", "source_id"),
      routine_id: firstScalar(fields, "routine id", "routine_id"),
      raw: block,
      line: head.line,
    });
  }
  return packages;
}

function hasReal(items: string[]): boolean {
  return items.some((x) => x && !x.includes("{{") && !/^n\/?a$|^-$/i.test(strip(x)));
}

export function validatePipelinePackages(packages: PipelinePackage[]): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  const ids = new Set<string>();
  const add = (level: IssueLevel, p: PipelinePackage | null, message: string) =>
    issues.push({ level, package_id: p?.id ?? null, message });

  for (const p of packages) {
    if (!/^PP-[0-9]+$/i.test(p.id)) add("error", p, "package heading must use PP-N (for example PP-1)");
    if (ids.has(p.id)) add("error", p, "duplicate package id");
    ids.add(p.id);
    if (!p.role) add("error", p, "Role must be one of worker, scout, smith, librarian, artisan");
    if (!p.goal || p.goal.includes("{{")) add("error", p, "Goal is required");
    if (!hasReal(p.inputs)) add("error", p, "Inputs are required, even for test-only or routine packages");
    if (!hasReal(p.acceptance)) add("error", p, "Acceptance criteria are required");
    if (p.depends_on.some((d) => /^PP-/i.test(d) && !ids.has(d) && !packages.some((q) => q.id === d))) {
      add("error", p, "Depends on references an unknown Pipeline package");
    }
    if (p.test_discipline) {
      if (!p.test_discipline.mode) add("error", p, "Test discipline must be standard, tdd, or test-first-waived");
      if (p.test_discipline.mode === "test-first-waived" && !p.test_discipline.waiver_reason) {
        add("error", p, "test-first-waived requires Waiver reason");
      }
      if (p.role && !["worker", "artisan"].includes(p.role)) {
        add("error", p, "Test discipline is allowed only for worker or artisan packages");
      }
    }
    if (p.role === "scout") {
      if (hasReal(p.allowed_write_paths)) add("error", p, "Scout packages are commit-free; do not set Allowed write paths");
      if (!p.deliverable && !hasReal(p.expected_outputs)) add("error", p, "Scout packages must name a Deliverable or Expected outputs path");
    }
    if (p.role === "worker" || p.role === "smith" || p.role === "librarian" || p.role === "artisan") {
      if (!hasReal(p.allowed_write_paths) && p.role !== "artisan") {
        add("error", p, `${p.role} packages need Allowed write paths for generated assignments`);
      }
    }
    if (p.role === "smith" && p.dispatch && !/after|merge|manual/i.test(p.dispatch)) {
      add("warn", p, "Smith packages normally dispatch after a Worker merge into studio");
    }
    if (p.role === "librarian" && !hasReal(p.expected_outputs) && !hasReal(p.allowed_write_paths)) {
      add("error", p, "Librarian packages must name target knowledge/runbook outputs");
    }
  }
  return issues;
}

function identityValue(md: string, label: string): string | null {
  const section = h2Section(md, "Identity");
  if (!section) return null;
  const re = new RegExp(`^-\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "im");
  const m = re.exec(section.body);
  return m ? strip(m[1].replace(/<!--.*$/, "")) : null;
}

function inferLegacyRole(md: string): PackageRole | null {
  const lane = identityValue(md, "Execution lane hint")?.toLowerCase();
  if (lane === "artisan") return "artisan";
  const hint = identityValue(md, "Preferred role hint")?.toLowerCase();
  if (hint && ROLE_SET.has(hint as PackageRole) && hint !== "auto") return hint as PackageRole;
  const expected = h2Section(md, "Expected outputs")?.body.toLowerCase() ?? "";
  const source = h2Section(md, "Source / routine mapping")?.body.toLowerCase() ?? "";
  const joined = `${expected}\n${source}\n${h2Section(md, "Goal")?.body.toLowerCase() ?? ""}`;
  if (joined.includes("satchel")) return "artisan";
  if (joined.includes("shelf") || /source id:\s*`?(?!n\/a|-)/i.test(source) || /routine id:\s*`?(?!n\/a|-)/i.test(source)) return "librarian";
  if (joined.includes("anvil") || joined.includes("post-merge hardening")) return "smith";
  if (joined.includes("inspections/") || joined.includes("investigation") || joined.includes("report failures") || joined.includes("full test pass")) return "scout";
  if (joined.includes("workbench") || joined.includes("code work")) return "worker";
  return null;
}

function inferAllowedWritePaths(role: PackageRole | null, md: string): string[] {
  if (!role || role === "scout") return [];
  const expected = h2Section(md, "Expected outputs")?.body ?? "";
  const m = /modifying\s+(.+?)(?:\.|\n|$)/i.exec(expected);
  if (m && !m[1].includes("{{")) return [strip(m[1])];
  if (role === "librarian") {
    const source = h2Section(md, "Source / routine mapping")?.body ?? "";
    const target = /^-\s+Target internal document:\s*`?([^`\n]+)`?/im.exec(source)?.[1];
    const runbook = /^-\s+Runbook \/ manual path:\s*`?([^`\n]+)`?/im.exec(source)?.[1];
    return [target, runbook].filter((x): x is string => Boolean(x && !x.includes("n/a") && !x.includes("{{")));
  }
  return [];
}

function extractTopLevelTestDiscipline(md: string): { mode: string | null; scope: string | null; waiver: string | null } | null {
  const section = h2Section(md, "Test discipline");
  if (!section) return null;
  const fields = parseFields(section.body);
  const mode = firstScalar(fields, "Code test mode", "Test discipline", "Test mode");
  if (!mode || mode.includes("{{")) return null;
  return {
    mode,
    scope: firstScalar(fields, "Scope"),
    waiver: firstScalar(fields, "Waiver reason"),
  };
}

export function migrateBlueprintToPipelinePackages(md: string, options: MigrationOptions = {}): string {
  if (h2Section(md, "Pipeline packages")) return md;
  const role = inferLegacyRole(md);
  const goal = h2Section(md, "Goal") ? firstParagraph(h2Section(md, "Goal")!.body) : null;
  const inputs = sectionBullets(h2Section(md, "Inputs")?.body ?? "");
  const acceptance = sectionBullets(h2Section(md, "Acceptance criteria")?.body ?? "");
  const expected = sectionBullets(h2Section(md, "Expected outputs")?.body ?? "");
  const dataGuards = sectionBullets(h2Section(md, "Data-change guards")?.body ?? "");
  const test = extractTopLevelTestDiscipline(md);
  const allowed = inferAllowedWritePaths(role, md);
  const source = h2Section(md, "Source / routine mapping")?.body ?? "";
  const sourceId = /^-\s+Source ID:\s*`?([^`\n]+)`?/im.exec(source)?.[1];
  const routineId = /^-\s+Routine ID:\s*`?([^`\n]+)`?/im.exec(source)?.[1];
  const testLines = test && (role === "worker" || role === "artisan")
    ? [
        `- Test discipline: ${test.mode}`,
        `- Scope: ${test.scope && !test.scope.includes("{{") ? test.scope : "-"}`,
        `- Waiver reason: ${test.waiver && !test.waiver.includes("{{") ? test.waiver : "-"}`,
      ]
    : [];
  const packageLines = [
    "## Pipeline packages",
    "",
    "<!--",
    "  Migration scaffold. Existing blueprints without this section remain valid.",
    "  Review this PP-1 package before dispatch; replace placeholders before using",
    "  `pipeline_packages.ts render-assignment`.",
    "-->",
    "",
    "### PP-1 — migrated package",
    `- Role: ${role ?? "{{worker | scout | smith | librarian | artisan}}"}`,
    "- Dispatch: immediate",
    "- Depends on: -",
    `- Goal: ${goal && !goal.includes("{{") ? goal : "{{one bounded package outcome}}"}`,
    ...(sourceId && !sourceId.includes("n/a") && !sourceId.includes("{{") ? [`- Source ID: ${sourceId}`] : []),
    ...(routineId && !routineId.includes("n/a") && !routineId.includes("{{") ? [`- Routine ID: ${routineId}`] : []),
    "- Inputs:",
    ...(inputs.length ? inputs.map((x) => `  - ${x}`) : ["  - {{path_or_source_required}}"]),
    ...(allowed.length ? ["- Allowed write paths:", ...allowed.map((x) => `  - ${x}`)] : (role && role !== "scout" ? ["- Allowed write paths:", "  - {{path_required_for_commit_producing_package}}"] : [])),
    "- Forbidden write paths:",
    "  - `__garelier/**`",
    "  - `.env*`",
    "  - `infra/**`, `deploy/**`, `.github/workflows/**`",
    "  - `migrations/**`",
    "- Do:",
    "  - {{action_required}}",
    ...testLines,
    "- Acceptance:",
    ...(acceptance.length ? acceptance.map((x) => `  - ${x}`) : ["  - {{criterion_required}}"]),
    "- Expected outputs:",
    ...(expected.length ? expected.map((x) => `  - ${x}`) : ["  - {{deliverable_or_branch_evidence_required}}"]),
    ...(dataGuards.length ? ["- Data-change guards:", ...dataGuards.map((x) => `  - ${x}`)] : []),
    "- Notes:",
    `  - Migrated on ${options.now ?? new Date().toISOString().slice(0, 10)}; PM should confirm role/routing before dispatch.`,
    "",
  ];
  const acceptanceSection = h2Section(md, "Acceptance criteria");
  if (!acceptanceSection) return `${md.trimEnd()}\n\n${packageLines.join("\n")}`;
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const insertAt = acceptanceSection.startLine - 1;
  return [...lines.slice(0, insertAt), ...packageLines, ...lines.slice(insertAt)].join("\n");
}

function looksLikeBlueprint(file: string, md: string): boolean {
  if (basename(file).toLowerCase() === "readme.md") return false;
  if (/^#\s+Blueprint\b/im.test(md)) return true;
  return /^##\s+Goal\s*$/im.test(md) && /^##\s+Acceptance criteria\s*$/im.test(md);
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name === ".git" || ent.name === "runtime" || ent.name === "node_modules" || ent.name === "archive") continue;
    const path = join(dir, ent.name);
    if (ent.isDirectory()) {
      const nested = await collectMarkdownFiles(path);
      out.push(...nested);
    }
    else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) out.push(path);
  }
  return out.sort();
}

export async function migrateBlueprintTree(blueprintsDir: string, options: MigrationOptions = {}): Promise<MigrationTreeResult[]> {
  const results: MigrationTreeResult[] = [];
  for (const file of await collectMarkdownFiles(blueprintsDir)) {
    const md = await Bun.file(file).text();
    if (!looksLikeBlueprint(file, md)) {
      results.push({ file, status: "skipped", reason: "not a blueprint" });
      continue;
    }
    if (h2Section(md, "Pipeline packages")) {
      results.push({ file, status: "already-present" });
      continue;
    }
    const migrated = migrateBlueprintToPipelinePackages(md, options);
    if (options.write) await Bun.write(file, migrated);
    results.push({ file, status: options.write ? "migrated" : "would-migrate" });
  }
  return results;
}

function mdList(items: string[], fallback = "- N/A"): string {
  const real = items.filter(Boolean);
  return real.length ? real.map((x) => `- ${x}`).join("\n") : fallback;
}

function checkboxList(items: string[], fallback: string): string {
  const real = items.filter(Boolean);
  return (real.length ? real : [fallback]).map((x) => `- [ ] ${x.replace(/^\[[ xX]\]\s+/, "")}`).join("\n");
}

function idText(v: string | number | null | undefined): string {
  if (v == null || v === "") return "{{ID}}";
  return String(v).replace(/^#/, "");
}

function branchFamily(role: PackageRole): string | null {
  if (role === "worker") return "workbench";
  if (role === "smith") return "anvil";
  if (role === "librarian") return "shelf";
  if (role === "artisan") return "satchel";
  return null;
}

function computedBranch(p: PipelinePackage, o: RenderAssignmentOptions): string {
  if (o.branch) return o.branch;
  const family = p.role ? branchFamily(p.role) : null;
  if (!family) return "N/A";
  return `garelier/${o.targetSlug ?? "{{target_slug}}"}/${o.pmId}/${family}/#${idText(o.taskId)}/${o.slug ?? p.id.toLowerCase()}`;
}

function commonHeader(p: PipelinePackage, o: RenderAssignmentOptions, type: string): string {
  return [
    "## Identity",
    "",
    `- Task ID: #${idText(o.taskId)}`,
    `- Assigned to: ${o.agentId ?? "{{agent_id}}"}`,
    `- Assigned at: ${o.assignedAt ?? new Date().toISOString()}`,
    `- Milestone: ${o.milestone ?? "-"}`,
    `- Phase: ${o.phase ?? p.id}`,
    `- Type: ${type}`,
  ].join("\n");
}

function lensBlock(role: string, o: RenderAssignmentOptions): string {
  return renderEquippedLensSection(role, o.equippedLens ?? null, o.equippedLensSource ?? null);
}

function testDisciplineBlock(p: PipelinePackage): string {
  const td = p.test_discipline;
  if (!td || p.role !== "worker") return "";
  const knowledge = td.mode === "tdd" ? "`quality/test_driven_development.md`" : "`quality/test_strategy.md`";
  return [
    "## Test discipline",
    "",
    `- Mode: ${td.mode ?? "standard"}`,
    `- Knowledge: ${knowledge}`,
    `- Waiver reason: ${td.mode === "test-first-waived" ? (td.waiver_reason ?? "{{required}}") : "-"}`,
    "",
  ].join("\n");
}

function genericAssignment(p: PipelinePackage, o: RenderAssignmentOptions): string {
  const role = p.role ?? "worker";
  const branch = computedBranch(p, o);
  const isScout = role === "scout";
  const branchBlock = isScout
    ? ["## Branch", "", "- Branch name: N/A — Scout is commit-free.", "- Branched from: current studio tip", "- Smith coverage window: N/A", "- Covered Worker merges: N/A"].join("\n")
    : ["## Branch", "", `- Branch name: \`${branch}\``, `- Branched from: \`${o.baseBranch ?? `garelier/${o.targetSlug ?? "{{target_slug}}"}/${o.pmId}/studio`}\``, `- Smith coverage window: ${role === "smith" ? (o.smithCoverageWindow ?? `${o.baseSha ?? "{{studio_base_commit}}" }..{{studio_tip_at_dispatch}}`) : "N/A"}`, `- Covered Worker merges: ${role === "smith" ? (o.coveredWorkerMerges ?? "{{#<task_id>@<merge_sha>}}") : "N/A"}`].join("\n");
  const allowed = isScout ? ["N/A — commit-free; write only the inspection draft/report named in Expected outputs."] : p.allowed_write_paths;
  const outputs = p.expected_outputs.length ? p.expected_outputs : (p.deliverable ? [p.deliverable] : []);
  const acceptance = [...p.acceptance];
  if ((role === "worker" || role === "smith") && !acceptance.some((x) => /quality gate/i.test(x))) {
    acceptance.push("Project-specific quality gate passes (see `AGENTS.md` §2)");
  }
  if (role === "worker" && p.test_discipline?.mode === "tdd") {
    acceptance.push("TDD evidence is recorded: failing test first, final green run, and refactor status");
  }
  if (isScout && outputs.length) acceptance.push("Inspection/report deliverable is written to the expected output path");

  return [
    `# Assignment: ${p.title}`,
    "",
    "<!-- Generated from blueprint Pipeline package. Dock validates/routes; role executes only this bounded package. -->",
    "",
    commonHeader(p, o, role),
    "",
    lensBlock(role, o),
    branchBlock,
    "",
    "## Goal",
    "",
    p.goal ?? "{{one outcome; one sentence}}",
    "",
    "## Allowed / forbidden write paths (contract)",
    "",
    "allowed_write_paths:",
    mdList(allowed),
    "",
    "forbidden_write_paths:",
    mdList(p.forbidden_write_paths.length ? p.forbidden_write_paths : ["`__garelier/**`", "`.env*`", "`infra/**`, `deploy/**`, `.github/workflows/**`", "`migrations/**`"]),
    "",
    "## Inputs",
    "",
    mdList([...(o.blueprintPath ? [`\`${o.blueprintPath}\` (section: Pipeline packages / ${p.id})`] : []), ...p.inputs]),
    "",
    "## Do",
    "",
    mdList(p.actions, "- {{action_required}}"),
    "",
    testDisciplineBlock(p) +
    "## Acceptance criteria",
    "",
    checkboxList(acceptance, "{{criterion_required}}"),
    "",
    "## Stop if (MUST BLOCK)",
    "",
    "- Acceptance criteria are missing or contradictory.",
    "- A required input or source file does not exist.",
    "- The change would need a forbidden / protected path or a production-data write not covered by Data-change guards.",
    "- The package cannot be completed without expanding scope beyond this assignment.",
    "- The quality-gate command is undefined for commit-producing work.",
    "",
    "## Data-change guards",
    "",
    p.data_change_guards.length ? mdList(p.data_change_guards) : "- N/A — not a data-change task.",
    "",
    "## Expected outputs",
    "",
    mdList(outputs, role === "scout" ? "- {{inspection_or_report_path_required}}" : "- branch commit(s), report.md, and evidence pointers"),
    "",
    "## Notes from Dock",
    "",
    mdList(p.notes, "- -"),
    "",
  ].join("\n");
}

function librarianAssignment(p: PipelinePackage, o: RenderAssignmentOptions): string {
  const branch = computedBranch(p, o);
  return [
    `# Librarian Assignment: ${p.title}`,
    "",
    "<!-- Generated from blueprint Pipeline package. -->",
    "",
    "## Identity",
    "",
    `- Task ID: #${idText(o.taskId)}`,
    `- Assigned to: ${o.agentId ?? "{{librarian_id}}"}`,
    `- Assigned at: ${o.assignedAt ?? new Date().toISOString()}`,
    `- Branch: \`${branch}\``,
    `- Branched from: \`${o.baseBranch ?? `garelier/${o.targetSlug ?? "{{target_slug}}"}/${o.pmId}/studio`}\``,
    "",
    lensBlock("librarian", o),
    "## Source / routine",
    "",
    `- Source ID: ${p.source_id ? `\`${p.source_id}\`` : "N/A"}`,
    `- Routine ID: ${p.routine_id ? `\`${p.routine_id}\`` : "N/A"}`,
    "",
    "## Goal",
    "",
    p.goal ?? "{{what to internalize or standardize, in one sentence}}",
    "",
    "## Inputs",
    "",
    mdList([...(o.blueprintPath ? [`\`${o.blueprintPath}\` (section: Pipeline packages / ${p.id})`] : []), ...p.inputs]),
    "",
    "## Do",
    "",
    checkboxList(p.actions, "Create/update the named knowledge, registry, runbook, or manual artifacts"),
    "",
    "## Target files",
    "",
    mdList(p.expected_outputs.length ? p.expected_outputs : p.allowed_write_paths, "- {{target_knowledge_or_runbook_path_required}}"),
    "",
    "## Constraints",
    "",
    "- Do not adopt an unregistered source.",
    "- Do not change the meaning of a rule; augmentation is OK.",
    "- No feature code; no free investigation; no QA.",
    "",
    "## Acceptance criteria",
    "",
    checkboxList(p.acceptance, "Target knowledge/runbook artifacts are updated with provenance and registry consistency"),
    "",
    "## Notes from Dock",
    "",
    mdList(p.notes, "- -"),
    "",
  ].join("\n");
}

function artisanAssignment(p: PipelinePackage, o: RenderAssignmentOptions): string {
  const branch = computedBranch(p, o);
  const td = p.test_discipline;
  const acceptance = [...p.acceptance, "Project quality gate passes (see `AGENTS.md` §2)", `Merged into \`${o.baseBranch ?? `garelier/${o.targetSlug ?? "{{target_slug}}"}/${o.pmId}/studio`}\``];
  if (td?.mode === "tdd") acceptance.push("TDD evidence is recorded: failing test first, final green run, and refactor status");
  return [
    `# Artisan Assignment: ${p.title}`,
    "",
    "<!-- Generated from blueprint Pipeline package. Written by PM/dispatch helper; read by Artisan. -->",
    "",
    "## Identity",
    "",
    `- Task ID: #${idText(o.taskId)}`,
    `- Assigned to: ${o.agentId ?? "{{artisan_id}}"}`,
    `- Assigned at: ${o.assignedAt ?? new Date().toISOString()}`,
    "- Lane: artisan",
    `- Target branch: \`${o.targetBranch ?? "{{target_branch}}"}\``,
    `- Studio branch: \`${o.baseBranch ?? `garelier/${o.targetSlug ?? "{{target_slug}}"}/${o.pmId}/studio`}\``,
    `- Satchel branch: \`${branch}\``,
    "",
    lensBlock("artisan", o),
    "## Goal",
    "",
    p.goal ?? "{{one outcome; one sentence}}",
    "",
    "## Inputs",
    "",
    mdList([...(o.blueprintPath ? [`\`${o.blueprintPath}\` (section: Pipeline packages / ${p.id})`] : []), ...p.inputs]),
    "",
    "## Do",
    "",
    mdList(p.actions, "- {{action_required}}"),
    "",
    "## Test discipline",
    "",
    `- Mode: ${td?.mode ?? "standard"}`,
    `- Knowledge: ${td?.mode === "tdd" ? "`quality/test_driven_development.md`" : "`quality/test_strategy.md`"}`,
    `- Waiver reason: ${td?.mode === "test-first-waived" ? (td.waiver_reason ?? "{{required}}") : "-"}`,
    "",
    "## Acceptance criteria",
    "",
    checkboxList(acceptance, "{{criterion_required}}"),
    "",
    "## Out of scope",
    "",
    "- Anything outside this Pipeline package unless PM updates the blueprint.",
    "",
    "## Data-change guards",
    "",
    p.data_change_guards.length ? mdList(p.data_change_guards) : "- N/A — not a data-change task.",
    "",
    "## Notes from PM",
    "",
    mdList(p.notes, "- -"),
    "",
  ].join("\n");
}

export function renderAssignment(p: PipelinePackage, options: RenderAssignmentOptions): string {
  const errors = validatePipelinePackages([p]).filter(
    (i) => i.level === "error" && !i.message.includes("Depends on references an unknown Pipeline package"),
  );
  if (errors.length) throw new Error(errors.map((i) => `${i.package_id}: ${i.message}`).join("; "));
  if (p.role === "librarian") return librarianAssignment(p, options);
  if (p.role === "artisan") return artisanAssignment(p, options);
  return genericAssignment(p, options);
}

function fail(msg: string): never {
  process.stderr.write(`pipeline_packages: ${msg}\n`);
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function readText(path: string | undefined): Promise<string> {
  if (!path) fail("--blueprint is required");
  const file = Bun.file(path);
  if (!(await file.exists())) fail(`blueprint not found: ${path}`);
  return await file.text();
}

async function resolveLensForRender(md: string, role: string): Promise<{ ref: LensRef | null; source: string | null }> {
  const explicit = flag("lens");
  if (explicit) {
    const ref = parseLensRef(explicit);
    if (!ref) fail(`--lens must be <pack_id>:<group_id>, got: ${explicit}`);
    return { ref, source: "CLI --lens" };
  }

  const blueprintSelection = parseBlueprintLensSelection(md);
  const bpRef = lensForRole(blueprintSelection, role);
  if (bpRef) return { ref: bpRef, source: "blueprint §Lens selection" };

  const configPath = flag("config");
  if (configPath) {
    const file = Bun.file(configPath);
    if (await file.exists()) {
      const cfg = await file.text();
      const defaults = parseDefaultLensSetFromSetupConfig(cfg);
      const defRef = lensForRole(defaults, role);
      if (defRef) return { ref: defRef, source: `${configPath} [lenses.defaults]` };
    }
  }
  return { ref: null, source: null };
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd || !["list", "validate", "migrate", "migrate-tree", "render-assignment"].includes(cmd)) {
    fail("usage: pipeline_packages.ts list|validate|migrate|migrate-tree|render-assignment --blueprint <path> [--package PP-N --out <path> --write ...]");
  }
  if (cmd === "migrate-tree") {
    const dir = flag("blueprints-dir") ?? flag("dir") ?? (flag("control") ? join(flag("control")!, "blueprints") : undefined);
    if (!dir) fail("--blueprints-dir <dir> or --control <control-dir> is required for migrate-tree");
    const results = await migrateBlueprintTree(dir, { write: hasFlag("write") });
    if (hasFlag("json")) {
      process.stdout.write(JSON.stringify(results, null, 2) + "\n");
      return;
    }
    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    for (const r of results) {
      process.stdout.write(`${r.status}: ${r.file}${r.reason ? ` (${r.reason})` : ""}\n`);
    }
    process.stdout.write(
      `pipeline packages migration: ${counts["would-migrate"] ?? 0} would-migrate, ${counts.migrated ?? 0} migrated, ${counts["already-present"] ?? 0} already-present, ${counts.skipped ?? 0} skipped\n`,
    );
    return;
  }
  const blueprint = flag("blueprint");
  const md = await readText(blueprint);
  const packages = parsePipelinePackages(md);
  if (cmd === "list") {
    process.stdout.write(JSON.stringify(packages, null, 2) + "\n");
    return;
  }
  if (cmd === "migrate") {
    const migrated = migrateBlueprintToPipelinePackages(md);
    const changed = migrated !== md;
    const out = flag("out");
    if (hasFlag("write")) {
      if (!blueprint) fail("--blueprint is required with --write");
      if (changed) await Bun.write(blueprint, migrated);
      process.stdout.write(changed ? `pipeline packages: migrated ${blueprint}\n` : `pipeline packages: already present in ${blueprint}\n`);
      return;
    }
    if (out) await Bun.write(out, migrated);
    else process.stdout.write(migrated);
    return;
  }
  const issues = validatePipelinePackages(packages);
  for (const i of issues) process.stderr.write(`${i.level.toUpperCase()} ${i.package_id ?? "-"}: ${i.message}\n`);
  if (cmd === "validate") {
    if (issues.some((i) => i.level === "error")) process.exit(1);
    process.stdout.write(`pipeline packages: ok (${packages.length} package${packages.length === 1 ? "" : "s"})\n`);
    return;
  }
  if (issues.some((i) => i.level === "error")) process.exit(1);
  const id = normalizeId(flag("package") ?? "");
  if (!id) fail("--package is required for render-assignment");
  const p = packages.find((x) => x.id === id);
  if (!p) fail(`package not found: ${id}`);
  const expectedRole = flag("role");
  if (expectedRole && p.role !== expectedRole) fail(`package ${id} role is ${p.role}; dispatch role is ${expectedRole}`);
  const equipped = await resolveLensForRender(md, p.role ?? expectedRole ?? "");
  const rendered = renderAssignment(p, {
    taskId: flag("task-id"),
    agentId: flag("agent-id"),
    assignedAt: flag("assigned-at"),
    milestone: flag("milestone"),
    phase: flag("phase"),
    pmId: flag("pm-id") ?? fail("--pm-id is required"),
    targetSlug: flag("target-slug"),
    targetBranch: flag("target-branch"),
    slug: flag("slug"),
    branch: flag("branch"),
    baseBranch: flag("base-branch"),
    baseSha: flag("base-sha"),
    blueprintPath: blueprint,
    smithCoverageWindow: flag("smith-coverage-window"),
    coveredWorkerMerges: flag("covered-worker-merges"),
    equippedLens: equipped.ref,
    equippedLensSource: equipped.source,
  });
  const out = flag("out");
  if (out) await Bun.write(out, rendered);
  else process.stdout.write(rendered);
}

if (import.meta.main) main();
