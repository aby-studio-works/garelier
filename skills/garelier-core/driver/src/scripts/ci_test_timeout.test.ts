import { expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_REPOSITORY_TEST_DEFINITIONS,
  W327_CANONICAL_DEFINITION_CEILING,
  W383_DEFINITION_WARNING_HEADROOM,
  assertUniqueTestUnits,
  collectTestDefinitionInventory,
  countScenarioCasesInSource,
  countTestDefinitionsInSource,
  parseBunTestReport,
  scenarioBudgetAuthority,
  testDefinitionBudgetWarning,
  validateTestDefinitionBudget,
} from "./ci_test_inventory.ts";
import {
  DRIVER_UNIT_TEST_TIMEOUT_MS,
  REPOSITORY_WALK_TEST_TIMEOUT_MS,
  SHELL_ORACLE_TIMEOUT_MS,
  driverUnitTestArgs,
} from "./ci_test_timeout.ts";
import { rmSync } from "../guard/path_guard.ts";

test("W-148/W-453: CI subprocesses keep their measured timeout budgets", async () => {
  expect(DRIVER_UNIT_TEST_TIMEOUT_MS).toBeGreaterThan(9584);
  expect(driverUnitTestArgs()).toEqual(["test", `--timeout=${DRIVER_UNIT_TEST_TIMEOUT_MS}`]);
  expect(driverUnitTestArgs(12345)).toEqual(["test", "--timeout=12345"]);
  expect(SHELL_ORACLE_TIMEOUT_MS).toBe(600_000);
  await assertUnitProgress();
});

async function assertUnitProgress(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "garelier-w775-ci-progress-"));
  const childPath = join(root, "child.ts");
  const wrapperPath = join(root, "wrapper.ts");
  const release = join(root, "release");
  const ready = join(root, "ready");
  const exited = join(root, "exited");
  const resultPath = join(root, "result.json");
  const outPath = join(root, "stdout");
  const errPath = join(root, "stderr");
  const stdout = "stdout-sentinel:雪\nstdout-final\n";
  const stderr = "stderr-sentinel:星\nstderr-final\n 1 pass\n 0 fail\nRan 1 tests across 1 files. [0.01s]\n";
  // The wrapper imports the SAME production function used by CI, never ci.ts.
  // Child lifetime is independently bounded even if the wrapper dies on RED.
  writeFileSync(childPath, `
import { existsSync, writeFileSync, writeSync } from "node:fs";
const deadline = setTimeout(() => process.exit(90), 2500);
for (const [fd, text] of [[1, "stdout-sentinel:雪\\n"], [2, "stderr-sentinel:星\\n"]] as const) {
  const bytes = new TextEncoder().encode(text);
  const split = bytes.length - 3;
  writeSync(fd, bytes.subarray(0, split));
  await Bun.sleep(10);
  writeSync(fd, bytes.subarray(split));
}
writeFileSync(${JSON.stringify(ready)}, "ready");
while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
writeSync(1, "stdout-final\\n");
writeSync(2, "stderr-final\\n 1 pass\\n 0 fail\\nRan 1 tests across 1 files. [0.01s]\\n");
writeFileSync(${JSON.stringify(exited)}, "exited");
clearTimeout(deadline);
`);
  writeFileSync(wrapperPath, `
import { writeFileSync } from "node:fs";
import { runUnit } from ${JSON.stringify(new URL("./ci_unit_process.ts", import.meta.url).href)};
const result = await runUnit("W775 controlled partition", [${JSON.stringify(childPath)}], ${JSON.stringify(root)}, []);
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
`);
  const outFd = openSync(outPath, "w");
  const errFd = openSync(errPath, "w");
  let wrapper: Bun.Subprocess | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    wrapper = Bun.spawn([process.execPath, wrapperPath], {
      cwd: root, stdin: "ignore", stdout: outFd, stderr: errFd, windowsHide: true,
    });
    const ownedWrapper = wrapper;
    deadline = setTimeout(() => {
      try { ownedWrapper.kill("SIGKILL"); } catch { /* retained child already exited */ }
    }, 3500);
    const until = Date.now() + 1500;
    let visibleOut = "";
    let visibleErr = "";
    while (Date.now() < until) {
      visibleOut = readFileSync(outPath, "utf8");
      visibleErr = readFileSync(errPath, "utf8");
      if (existsSync(ready) && visibleOut.includes("stdout-sentinel:雪") && visibleErr.includes("stderr-sentinel:星")) break;
      await Bun.sleep(10);
    }
    const wasReady = existsSync(ready);
    const wasRunning = !existsSync(exited);
    writeFileSync(release, "release");
    expect(await wrapper.exited).toBe(0);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe(stderr);
    expect(result.report).toEqual(parseBunTestReport(`${stdout}\n${stderr}`));
    expect(result.parseError).toBe("");
    expect(readFileSync(outPath, "utf8")).toBe(`  --- W775 controlled partition: 1 source file(s) ---\n${stdout}`);
    expect(readFileSync(errPath, "utf8")).toBe(stderr);
    expect(wasReady, "W775_FIXTURE_STARTUP_UNCONFIRMED").toBe(true);
    expect(wasRunning, "W775_FIXTURE_EXITED_BEFORE_OBSERVATION").toBe(true);
    console.log(`W775 progress before_exit stdout=${JSON.stringify(visibleOut)} stderr=${JSON.stringify(visibleErr)} final_bytes=preserved`);
    expect(visibleOut, "W775_PROGRESS_BUFFERED: partition/stdout absent before child exit").toContain("  --- W775 controlled partition:");
    expect(visibleOut, "W775_PROGRESS_BUFFERED: stdout absent before child exit").toContain("stdout-sentinel:雪");
    expect(visibleErr, "W775_PROGRESS_BUFFERED: stderr absent before child exit").toContain("stderr-sentinel:星");
  } finally {
    writeFileSync(release, "release");
    if (wrapper) await wrapper.exited;
    if (deadline) clearTimeout(deadline);
    closeSync(outFd);
    closeSync(errFd);
    rmSync(root, { recursive: true, force: true });
  }
}

test("W-327/W-383: source inventory counts registrations, warns at headroom, and fails closed above the ceiling", () => {
  const source = `
    import { expect, it, test } from "bun:test";
    test("plain", () => expect(true).toBe(true));
    it.each([[1], [2]])("table %s", () => {});
    scenario("aggregate", () => {});
    const fixture = 'test("not executable", () => {})';
  `;
  expect(countTestDefinitionsInSource(source, "fixture.test.ts")).toBe(2);
  expect(countScenarioCasesInSource(source, "fixture.test.ts")).toBe(1);
  // The drift pin. A PM re-pin of the ceiling is a deliberate act and must move
  // THIS line — 290 -> 247 by the 2026-09-05 ruling (W-677 / #466).
  expect(W327_CANONICAL_DEFINITION_CEILING).toBe(247);
  const fixtureDefinitions = (count: number) => Array.from(
    { length: count },
    (_, index) => `test("fixture ${index}", () => {});`,
  ).join("\n");
  // W-677: every OTHER number here derives from the constant, so a re-pin edits
  // one line instead of seven hand-kept literals that silently disagree. What is
  // still measured is the behaviour, not the arithmetic: exactly at the ceiling
  // passes, one below the warning threshold is silent, the threshold itself
  // warns in this exact wording, and one above the ceiling throws.
  const ceiling = W327_CANONICAL_DEFINITION_CEILING;
  const warningAt = ceiling - W383_DEFINITION_WARNING_HEADROOM;
  const atCeiling = countTestDefinitionsInSource(fixtureDefinitions(ceiling), "ceiling.test.ts");
  const atWarning = countTestDefinitionsInSource(fixtureDefinitions(warningAt), "warning.test.ts");
  const aboveCeiling = countTestDefinitionsInSource(fixtureDefinitions(ceiling + 1), "over.test.ts");
  expect(validateTestDefinitionBudget(atCeiling, ceiling)).toBe(ceiling);
  expect(testDefinitionBudgetWarning(atWarning - 1, ceiling)).toBeUndefined();
  expect(testDefinitionBudgetWarning(atWarning, ceiling)).toBe(
    `test-definition count ${warningAt} is within ${W383_DEFINITION_WARNING_HEADROOM} of ceiling ${ceiling}`,
  );
  expect(() => validateTestDefinitionBudget(aboveCeiling, ceiling)).toThrow(
    `test-definition budget exceeded: ${ceiling + 1} > ${ceiling}`,
  );
  expect(validateTestDefinitionBudget(MAX_REPOSITORY_TEST_DEFINITIONS)).toBe(
    MAX_REPOSITORY_TEST_DEFINITIONS,
  );
  expect(() => validateTestDefinitionBudget(MAX_REPOSITORY_TEST_DEFINITIONS + 1)).toThrow(
    "test-definition budget exceeded",
  );

  const repositoryRoot = resolve(import.meta.dir, "..", "..", "..", "..", "..");
  const ci = new URL("./ci.ts", import.meta.url);
  const ciSource = readFileSync(ci, "utf8");
  const repositoryInventory = collectTestDefinitionInventory(repositoryRoot);
  const scenarioAuthority = scenarioBudgetAuthority(repositoryRoot);
  const result = spawnSync(process.execPath, [fileURLToPath(ci), "--inventory-only"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, GARELIER_CI_ROOT: repositoryRoot },
    windowsHide: true,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toMatch(
    new RegExp(
      `${repositoryInventory.definitions} definitions / ${repositoryInventory.files.length} files; ` +
      `scenario census ${repositoryInventory.scenarioCases}/${repositoryInventory.scenarioCases}; ` +
      `immutable authority ${scenarioAuthority.scenarioCases}@[0-9a-f]{40}; ` +
      `ceiling ${W327_CANONICAL_DEFINITION_CEILING}, permanent max ${MAX_REPOSITORY_TEST_DEFINITIONS}; duplicate units 0`,
    ),
  );
  // RED counterfactual: removing either reporter call from ci.ts makes these
  // assertions fail, so the test cannot pass on inventory helper behavior alone.
  expect(ciSource).toContain(
    "scenario census ${inventory.scenarioCases}/${W604_CANONICAL_SCENARIO_COUNT}; " +
    "immutable authority ${scenarioAuthority.scenarioCases}@${scenarioAuthority.ref}",
  );
  expect(ciSource).toContain("if (budgetWarning) out(`  WARN: ${budgetWarning}`);");

  const root = mkdtempSync(join(tmpdir(), "ci-test-inventory-"));
  try {
    const sourceDir = join(root, "src");
    const nestedCheckout = join(root, "__garelier", "_workshop", "_crew", "dispatch1", "checkout");
    // W-398: __garelier/*/runtime/ is gitignored transient state (retention.md)
    // that can hold a leaked snapshot copy of driver source (e.g. an Observer
    // base-red comparison snapshot) with no .git marker to stop the walk — the
    // exact shape that doubled the merge-gate budget to 544 (272 real + 272 from
    // a runtime/observer/results/.../base-red-*/ copy). Assert it never counts.
    const runtimeLeak = join(root, "__garelier", "_workshop", "runtime", "observer", "results", "brief", "base-red-aCWMFj", "src");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(join(nestedCheckout, "src"), { recursive: true });
    mkdirSync(runtimeLeak, { recursive: true });
    writeFileSync(join(sourceDir, "root.test.ts"), 'test("root", () => {});\n');
    writeFileSync(join(nestedCheckout, ".git"), "gitdir: C:/repo/.git/worktrees/dispatch1\n");
    writeFileSync(join(nestedCheckout, "src", "nested.test.ts"), 'test("nested", () => {});\n');
    writeFileSync(join(runtimeLeak, "root.test.ts"), 'test("root", () => {});\n');

    const trackedFiles = ["src/root.test.ts"];
    const inventory = () => collectTestDefinitionInventory(root, { listTrackedFiles: () => trackedFiles });
    expect(inventory().files).toEqual([
      { path: "src/root.test.ts", definitions: 1 },
    ]);
    expect(inventory().scenarioCases).toBe(0);

    // W-584 r2: an index entry whose worktree file was deleted must fail with
    // the exact path and actionable unstaged-deletion guidance.
    trackedFiles.push("src/deleted.test.ts");
    expect(inventory).toThrow(
      "test-definition inventory tracked test path is missing from the worktree: src/deleted.test.ts " +
      "(possible unstaged deletion; stage an intentional deletion before rerunning CI)",
    );
    trackedFiles.pop();

    // W-584: ignored/untracked scratch is outside the denominator both while
    // present and after removal; adding the same path to the tracked set is the
    // discriminating positive arm and must increase the count.
    const scratch = join(root, "showcase", "scratch.test.ts");
    mkdirSync(join(root, "showcase"), { recursive: true });
    writeFileSync(scratch, 'test("scratch", () => {});\n');
    expect(inventory().definitions).toBe(1);
    const withUntrackedScratch = inventory().definitions;
    rmSync(scratch, { force: true });
    expect(inventory().definitions).toBe(1);
    const afterScratchRemoval = inventory().definitions;
    writeFileSync(scratch, 'test("tracked scratch", () => {});\n');
    trackedFiles.push("showcase/scratch.test.ts");
    expect(inventory().definitions).toBe(2);
    const withTrackedScratch = inventory().definitions;
    let unavailableFailure = "";
    try {
      collectTestDefinitionInventory(root, {
        listTrackedFiles: () => { throw new Error("git unavailable fixture"); },
      });
    } catch (error) {
      unavailableFailure = error instanceof Error ? error.message : String(error);
    }
    expect(unavailableFailure).toBe(
      "test-definition inventory UNCOVERED: cannot enumerate Git-tracked files: git unavailable fixture",
    );
    console.log(`W-584 untracked-present definitions=${withUntrackedScratch}`);
    console.log(`W-584 untracked-removed definitions=${afterScratchRemoval}`);
    console.log(`W-584 tracked-added definitions=${withTrackedScratch}`);
    console.log(`W-584 git-unavailable=${unavailableFailure}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // The report parser and unit-name uniqueness are part of the same canonical
  // inventory contract; keeping them here removes a pass-only standalone unit.
  const report = `
src\\safe.test.ts:
(pass) allow path
src\\broken.test.ts:
(fail) fail-closed path
1 test failed:
(fail) fail-closed path
 244 pass
 1 fail
Ran 245 tests across 42 files. [9.50s]
`;
  expect(parseBunTestReport(report)).toEqual({
    testCount: 245,
    fileCount: 42,
    failedFiles: ["src\\broken.test.ts"],
    failedCases: ["fail-closed path"],
  });
  expect(assertUniqueTestUnits(["driver-suite", "post-smoke"])).toEqual([
    "driver-suite",
    "post-smoke",
  ]);
  expect(() => assertUniqueTestUnits(["driver-suite", "driver-suite"])).toThrow(
    "duplicate test unit",
  );
}, REPOSITORY_WALK_TEST_TIMEOUT_MS);
