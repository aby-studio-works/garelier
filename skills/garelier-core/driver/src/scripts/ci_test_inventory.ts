import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { requireRuntimeExecutable } from "./_lib.ts";

export const MAX_REPOSITORY_TEST_DEFINITIONS = 300;
// 247 = PM裁定 (2026-09-05, W-677 / #466): 統廃合後の実測 237 の上に、2026-08-12 の
// W-383 裁定が 300 permanent maximum に対して使ったのと同じ 10 definitions の予備を
// 置く。ratchet は実測に追従して締め直す — 290 のままでは headroom が 53 空き、
// budget が「増やさない」ことを測らなくなる。次の引上げにも PM 裁定が必須で、
// 300 は永久上限。
export const W327_CANONICAL_DEFINITION_CEILING = 247;
// W-604: scenario registrations are a monotonic budget, not free capacity.
// A consolidation lowers this exact census in the same change; an addition
// must delete/merge an existing scenario so the value cannot rise.
// W-677 re-pin: 103 -> 102. The census must EQUAL this constant, so a
// consolidation lowers it in the same change (three same-family scenario runs in
// command_guard.test.ts were folded into one registration each, 111 -> 102).
// The immutable authority ceiling is unchanged, and 102 sits under it.
export const W604_CANONICAL_SCENARIO_COUNT = 102;
export const W383_DEFINITION_WARNING_HEADROOM = 8;
export const TARGET_REPORTED_TEST_MIN = 220;
export const TARGET_REPORTED_TEST_MAX = 270;

export interface TestDefinitionFile {
  path: string;
  definitions: number;
}

export interface TestDefinitionInventory {
  root: string;
  files: TestDefinitionFile[];
  definitions: number;
  scenarioCases: number;
}

export interface BunTestReport {
  testCount: number;
  fileCount: number;
  failedFiles: string[];
  failedCases: string[];
}

export interface TestDefinitionInventoryOptions {
  listTrackedFiles?: (root: string) => readonly string[];
}

export interface ScenarioBudgetAuthority {
  ref: string;
  scenarioCases: number;
}

function registrationRoot(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return registrationRoot(expression.expression);
  if (ts.isElementAccessExpression(expression)) return registrationRoot(expression.expression);
  if (ts.isCallExpression(expression)) return registrationRoot(expression.expression);
  return undefined;
}

function countRegistrationsInSource(source: string, path: string, names: readonly string[]): number {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const root = registrationRoot(node.expression);
      const isInnerRegistrationCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (root !== undefined && names.includes(root) && !isInnerRegistrationCall) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

export function countTestDefinitionsInSource(source: string, path: string): number {
  return countRegistrationsInSource(source, path, ["test", "it"]);
}

export function countScenarioCasesInSource(source: string, path: string): number {
  return countRegistrationsInSource(source, path, ["scenario"]);
}

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function listGitTrackedFiles(root: string): string[] {
  const result = spawnSync(
    requireRuntimeExecutable("git"),
    ["-C", root, "ls-files", "-z", "--"],
    { encoding: null, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr ?? []).toString("utf8").trim().slice(0, 500);
    throw new Error(`git ls-files exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return Buffer.from(result.stdout ?? []).toString("utf8").split("\0").filter(Boolean);
}

export function collectTestDefinitionInventory(
  root: string,
  options: TestDefinitionInventoryOptions = {},
): TestDefinitionInventory {
  const absoluteRoot = resolve(root);
  const files: TestDefinitionFile[] = [];
  let scenarioCases = 0;
  let trackedFiles: readonly string[];
  try {
    trackedFiles = (options.listTrackedFiles ?? listGitTrackedFiles)(absoluteRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`test-definition inventory UNCOVERED: cannot enumerate Git-tracked files: ${detail}`);
  }
  for (const trackedPath of [...new Set(trackedFiles)].sort((a, b) => a.localeCompare(b))) {
    const normalized = trackedPath.replace(/\\/g, "/");
    if (!isTestFile(normalized)) continue;
    const segments = normalized.split("/");
    if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
      || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`test-definition inventory received an invalid tracked path: ${trackedPath}`);
    }
    const path = join(absoluteRoot, ...segments);
    const repoRelative = relative(absoluteRoot, path).replace(/\\/g, "/");
    if (!repoRelative || repoRelative === ".." || repoRelative.startsWith("../")) {
      throw new Error(`test-definition inventory received an out-of-root tracked path: ${trackedPath}`);
    }
    if (!existsSync(path)) {
      throw new Error(
        `test-definition inventory tracked test path is missing from the worktree: ${normalized} ` +
        "(possible unstaged deletion; stage an intentional deletion before rerunning CI)",
      );
    }
    const source = readFileSync(path, "utf8");
    const definitions = countTestDefinitionsInSource(source, path);
    scenarioCases += countScenarioCasesInSource(source, path);
    if (definitions > 0) {
      files.push({
        path: repoRelative,
        definitions,
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root: absoluteRoot,
    files,
    definitions: files.reduce((sum, file) => sum + file.definitions, 0),
    scenarioCases,
  };
}

export function testDefinitionBudgetWarning(
  definitions: number,
  ceiling: number = W327_CANONICAL_DEFINITION_CEILING,
): string | undefined {
  if (definitions >= ceiling - W383_DEFINITION_WARNING_HEADROOM) {
    return `test-definition count ${definitions} is within ${W383_DEFINITION_WARNING_HEADROOM} of ceiling ${ceiling}`;
  }
  return undefined;
}

export function validateTestDefinitionBudget(
  definitions: number,
  ceiling: number = MAX_REPOSITORY_TEST_DEFINITIONS,
): number {
  if (!Number.isSafeInteger(definitions) || definitions < 0) {
    throw new Error(`invalid test-definition count: ${definitions}`);
  }
  if (!Number.isSafeInteger(ceiling) || ceiling < 0 || ceiling > MAX_REPOSITORY_TEST_DEFINITIONS) {
    throw new Error(
      `invalid test-definition ceiling: ${ceiling} (permanent maximum ${MAX_REPOSITORY_TEST_DEFINITIONS})`,
    );
  }
  if (definitions > ceiling) {
    throw new Error(
      `test-definition budget exceeded: ${definitions} > ${ceiling} (permanent maximum ${MAX_REPOSITORY_TEST_DEFINITIONS})`,
    );
  }
  return definitions;
}

export function validateScenarioBudget(
  scenarios: number,
  canonical: number,
  authorityCeiling: number,
): number {
  if (!Number.isSafeInteger(scenarios) || scenarios < 0) throw new Error(`invalid scenario count: ${scenarios}`);
  if (!Number.isSafeInteger(canonical) || canonical < 0) throw new Error(`invalid candidate scenario count: ${canonical}`);
  if (!Number.isSafeInteger(authorityCeiling) || authorityCeiling < 0) throw new Error(`invalid scenario authority ceiling: ${authorityCeiling}`);
  if (scenarios !== canonical) {
    throw new Error(
      `scenario census changed: ${scenarios} != canonical ${canonical}; additions must consolidate an existing scenario, reductions must lower the canonical census in the same change`,
    );
  }
  if (canonical > authorityCeiling) {
    throw new Error(`scenario budget raised by candidate: ${canonical} > immutable authority ${authorityCeiling}`);
  }
  return scenarios;
}

function gitBytes(root: string, args: readonly string[]): Buffer {
  const result = spawnSync(
    requireRuntimeExecutable("git"),
    ["-C", root, ...args],
    { encoding: null, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr ?? []).toString("utf8").trim().slice(0, 500);
    throw new Error(`git ${args.join(" ")} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return Buffer.from(result.stdout ?? []);
}

/** W-604's lowest committed guard census is the immutable authority. A
 * consolidation may lower it, but complete history prevents a later candidate
 * from raising the constant alongside a new scenario. */
export function scenarioBudgetAuthority(root: string): ScenarioBudgetAuthority {
  const absoluteRoot = resolve(root);
  const shallow = gitBytes(absoluteRoot, ["rev-parse", "--is-shallow-repository"])
    .toString("utf8").trim();
  if (shallow !== "false") {
    throw new Error(`scenario authority requires complete Git history (is_shallow=${shallow || "unknown"})`);
  }
  const sourcePath = relative(
    absoluteRoot,
    resolve(import.meta.dir, "ci_test_inventory.ts"),
  ).replace(/\\/g, "/");
  if (!sourcePath || sourcePath === ".." || sourcePath.startsWith("../")) {
    throw new Error("scenario authority source is outside the repository");
  }
  const history = gitBytes(absoluteRoot, [
    "log", "--reverse", "--format=%H", "-G", "^export const W604_CANONICAL_SCENARIO_COUNT", "--", sourcePath,
  ]).toString("utf8").split(/\r?\n/).filter(Boolean);
  if (history.length === 0) throw new Error("scenario authority commit is missing");
  let authority: ScenarioBudgetAuthority | null = null;
  for (const ref of history) {
    if (!/^[0-9a-f]{40,64}$/.test(ref)) throw new Error("scenario authority commit is malformed");
    const mergeBase = gitBytes(absoluteRoot, ["merge-base", "HEAD", ref]).toString("utf8").trim();
    if (mergeBase !== ref) throw new Error("scenario authority commit is not an ancestor of HEAD");
    const tracked = gitBytes(absoluteRoot, ["ls-tree", "-r", "--name-only", "-z", ref])
      .toString("utf8").split("\0").filter((path) => path && isTestFile(path));
    let scenarioCases = 0;
    for (const path of tracked) {
      const source = gitBytes(absoluteRoot, ["show", `${ref}:${path}`]).toString("utf8");
      scenarioCases += countScenarioCasesInSource(source, path);
    }
    if (!authority || scenarioCases < authority.scenarioCases) authority = { ref, scenarioCases };
  }
  return authority!;
}

export function parseBunTestReport(output: string): BunTestReport {
  let currentFile = "";
  const failedFiles = new Set<string>();
  const failedCases: string[] = [];
  let inFailureSummary = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^\d+\s+tests?\s+failed:$/.test(line)) {
      inFailureSummary = true;
      currentFile = "";
      continue;
    }
    const file = /^(.+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
    if (file) {
      currentFile = file[1]!;
      continue;
    }
    const failure = /^\(fail\)\s+(.+?)(?:\s+\[[^\]]+\])?$/.exec(line);
    if (failure) {
      if (inFailureSummary) continue;
      if (currentFile) failedFiles.add(currentFile);
      failedCases.push(failure[1]!);
    }
  }
  const summary = /Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?\./g;
  let match: RegExpExecArray | null;
  let latest: RegExpExecArray | null = null;
  while ((match = summary.exec(output)) !== null) latest = match;
  if (!latest) throw new Error("Bun test report is missing its reported test/file count");
  return {
    testCount: Number.parseInt(latest[1]!, 10),
    fileCount: Number.parseInt(latest[2]!, 10),
    failedFiles: [...failedFiles],
    failedCases,
  };
}

export function assertUniqueTestUnits(units: string[]): string[] {
  const seen = new Set<string>();
  for (const unit of units) {
    const normalized = unit.replace(/\\/g, "/").toLowerCase();
    if (seen.has(normalized)) throw new Error(`duplicate test unit: ${unit}`);
    seen.add(normalized);
  }
  return units;
}
