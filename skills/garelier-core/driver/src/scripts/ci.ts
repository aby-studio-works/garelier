#!/usr/bin/env bun
//
// Garelier repo CI gate. Run from anywhere; resolves the repo root from its
// own location. Mirrors what .github/workflows/ci.yml runs:
//
//   1. driver typecheck (tsc --noEmit)
//   2. driver unit tests (bun test)
//   3. repository shell allowlist: task_mirror_hook is the sole shell file
//   4. wizard fresh-setup smoke in a throwaway git repo, then driver
//      loadConfig parse of the generated config
//   … (all subsequent integration smokes / lints)
//
// Exits non-zero if any step fails.
//
// TS port (W-083, Wave D). ci is the EXECUTOR of verification oracles, so each
// integration smoke / lint runs its shell body verbatim through bash.exe
// (contract §5) — this guarantees byte-for-byte step-verdict parity with the
// former shell CI. What ci OWNS in TS is the runner + the shim-form gate that
// REPLACES the old `bash -n` step (blueprint Wave D). The two wizard smokes get
// the canonical `_crew/pm` setup path.
//
// Canonical invocation: bun skills/garelier-core/driver/src/scripts/ci.ts

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { requireRuntimeExecutable, resolveBashLaunch, run, runBash } from "./_lib.ts";
import { runFileBackedProcess } from "./file_backed_process.ts";
import {
  TARGET_REPORTED_TEST_MAX,
  TARGET_REPORTED_TEST_MIN,
  W327_CANONICAL_DEFINITION_CEILING,
  W604_CANONICAL_SCENARIO_COUNT,
  assertUniqueTestUnits,
  collectTestDefinitionInventory,
  parseBunTestReport,
  scenarioBudgetAuthority,
  testDefinitionBudgetWarning,
  validateTestDefinitionBudget,
  validateScenarioBudget,
} from "./ci_test_inventory.ts";
import { SHELL_ORACLE_TIMEOUT_MS, driverUnitTestArgs } from "./ci_test_timeout.ts";

const ROOT =
  process.env.GARELIER_CI_ROOT && process.env.GARELIER_CI_ROOT !== ""
    ? resolve(process.env.GARELIER_CI_ROOT)
    : resolve(import.meta.dir, "..", "..", "..", "..", "..");
const DRIVER = join(ROOT, "skills", "garelier-core", "driver");
const INVENTORY_ONLY = process.argv.includes("--inventory-only");
const ARTIFACT_HYGIENE_ONLY = process.argv.includes("--artifact-hygiene-only");
const SHELL_ORACLE_CAPTURE_ROOT = join(tmpdir(), "garelier-ci-shell");

let fail = 0;
const out = (s: string) => process.stdout.write(`${s}\n`);
function step(name: string): void {
  out("");
  out(`=== ${name} ===`);
}

function dependencyArtifactPaths(): string[] {
  const nodeModules = join(DRIVER, "node_modules");
  if (!existsSync(nodeModules)) return [];
  return readdirSync(nodeModules)
    .filter((name) =>
      name === ".garelier-ci-shell"
      || name.startsWith("install-smoke-")
      || name.toLowerCase().endsWith(".log"))
    .sort()
    .map((name) => relative(ROOT, join(nodeModules, name)).replace(/\\/g, "/"));
}

function checkDependencyArtifactHygiene(): boolean {
  out(`CI: shell oracle capture root=${SHELL_ORACLE_CAPTURE_ROOT}`);
  try {
    const artifacts = dependencyArtifactPaths();
    if (artifacts.length === 0) {
      out("CI: dependency artifact hygiene passed (0 artifacts).");
      return true;
    }
    out(`CI: dependency artifact hygiene found ${artifacts.length} artifact(s)`);
    for (const path of artifacts) out(`  ${path}`);
    return false;
  } catch (error) {
    out(`CI: dependency artifact hygiene scan failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

if (ARTIFACT_HYGIENE_ONLY) {
  process.exit(checkDependencyArtifactHygiene() ? 0 : 1);
}

// W-026: fail FAST + CLEARLY when the driver deps are missing.
if (!existsSync(join(DRIVER, "node_modules"))) {
  out(`CI: driver dependencies are not installed (${DRIVER}/node_modules is missing).`);
  out("    Driver dependencies are missing. Provision them outside Garelier, then re-run ci.ts.");
  out("    Garelier does not install, update, or download toolchain/dependency prerequisites.");
  out("    (node_modules is gitignored, so a fresh 'git worktree add' has none — W-026.)");
  process.exit(1);
}

// ── bash-block runner ─────────────────────────────────────────────────────────
// Route an oracle body to bash.exe verbatim. The body echoes its own "  ok"/
// "  FAIL" line(s) and signals failure by exiting non-zero (ci.ts's `fail=1` is
// rewritten to `exit 1`). ROOT/DRIVER/WS/CA/CB/CD are injected via a preamble so
// the bodies stay verbatim.
//
// REQUIRED BODY SHAPE for a `set -e` oracle — stand the subshell ALONE and
// branch on its captured status:
//
//     (
//         set -e
//         ...assertions...
//     )
//     ORACLE_RC=$?
//     if [ "$ORACLE_RC" -eq 0 ]; then echo "  ok (...)"; else echo "  FAIL: ..."; exit 1; fi
//
// NEVER `if ( set -e; ... ); then`. Bash ignores errexit for any command in an
// `if` condition and propagates that suppression INTO the subshell, so only the
// LAST command in the body decides the branch and every earlier failing
// assertion is silently skipped over — a fail-OPEN oracle that prints "ok".
// Measured (bash 5.2.37): `if ( set -e; false; echo reached; true ); then` prints
// both `reached` and the then-branch. This is how the run_summarized oracle's
// real `bun -e` failure (gate_runner's run-scoped summary regression) reached
// `CI: all checks passed.` The run_summarized body below greps this file to keep
// the idiom from coming back.
const PRE = [
  "set -uo pipefail",
  `ROOT=${JSON.stringify(ROOT)}`,
  `DRIVER="$ROOT/skills/garelier-core/driver"`,
  "WS=_workshop; CA=alpha; CB=beta; CD=delta",
  `cd "$ROOT"`,
  "init_schema3_fixture() {",
  "  local fixture_root=\"$1\" fixture_pm=\"$2\" fixture_count=\"$3\" fixture_session=\"$4\"",
  "  bun -e 'import { join } from \"node:path\"; import { pathToFileURL } from \"node:url\"; const [repoRoot, root, pmId, count, sessionId] = process.argv.slice(1); const load = (path) => import(pathToFileURL(join(repoRoot, path)).href); const [{ writeV3Fixture }, { garelierControlRoots }, { openControlSession }, { planGraphRuntimeCallbacks }] = await Promise.all([load(\"skills/garelier-core/driver/src/control/fixtures/v3_control.ts\"), load(\"skills/garelier-core/driver/src/control/garelier_integration.ts\"), load(\"skills/garelier-core/driver/src/control/sessions.ts\"), load(\"skills/garelier-core/driver/src/control/plan_graph_write.ts\")]); writeV3Fixture(root, Number(count), pmId); const roots = garelierControlRoots(root, root, pmId); openControlSession({ targetRoot: root, controlRoot: roots.controlRoot, runtimeRoot: roots.runtimeRoot, pmId, sessionId, agent: \"ci\", cwd: root, runtimeCallbacks: planGraphRuntimeCallbacks });' \"$ROOT\" \"$fixture_root\" \"$fixture_pm\" \"$fixture_count\" \"$fixture_session\"",
  "}",
  // W-731: dispatch_prepare refuses a normal dispatch that carries no prompt
  // source (W-451) — without one it would mint a claim, a container and a
  // worktree only to hand back spawn_directive=BLOCK. Every smoke below that is
  // NOT testing that refusal has to supply one, so they share this fixture
  // rather than four copies of the same here-doc. Writing the file is all the
  // fixture owes: the smokes assert on the preamble and the container, not on
  // the task body.
  // W-730 r2: shared, because a step that hands a path to `bun` needs the native
  // spelling on Windows and more than one step now does.
  "json_path() {",
  "  case \"$(uname -s)\" in",
  "    MINGW*|MSYS*) cygpath -m \"$1\" ;;",
  "    *) printf '%s/%s\\n' \"$(cd \"$(dirname \"$1\")\" && pwd -P)\" \"$(basename \"$1\")\" ;;",
  "  esac",
  "}",
  "init_task_file() {",
  "  local fixture_root=\"$1\"",
  "  printf '## Task\\n\\nci smoke prompt source (W-731).\\n' > \"$fixture_root/ci_smoke_task.md\"",
  "}",
  // W-731: once a prompt source exists the run reaches two more contracts these
  // fixtures never had to satisfy while they were refused at the first gate.
  // (1) role authorization reads the work item's row out of `HEAD`, so a fixture
  // that only WRITES the schema-3 tree is refused: `item authority source is not
  // committed at HEAD`. A real project has its backlog committed, so commit it
  // and move the studio branch onto it. (2) a recorded Claude CLI dispatch also
  // requires an explicit model, a non-empty effort and a model source; the
  // aggregate's own harness already supplies `claude-test` / `high` for exactly
  // this reason, so use the same pair here rather than inventing a second one.
  "commit_fixture_control() {",
  "  local fixture_root=\"$1\"",
  "  git -C \"$fixture_root\" add -A",
  "  git -C \"$fixture_root\" -c user.email=ci@ci -c user.name=ci commit -q -m 'fixture: schema-3 control tree'",
  "  git -C \"$fixture_root\" branch -f 'garelier/main/tpm/studio' HEAD",
  "}",
  "",
].join("\n");
// Quality-gate 3-value contract. A shell oracle that cannot MEASURE its
// dimension in this environment must say so instead of guessing: it prints a
// line starting with UNCOVERED_MARKER and exits UNCOVERED_EXIT. Both are
// required, so an unrelated tool that happens to exit 3 still fails closed.
// UNCOVERED is not a pass and not a failure: it is counted, named in the
// summary, and carried into the register as a disclosure with a tracking row.
const UNCOVERED_MARKER = "  UNCOVERED:";
const UNCOVERED_EXIT = 3;
type StepOutcome = "ok" | "fail" | "uncovered";

async function sh(body: string): Promise<StepOutcome> {
  const shell = resolveBashLaunch();
  if (!shell) return "fail";
  const captured = await (async () => {
    try {
      return await runFileBackedProcess(
        {
          command: [shell.executable, "-s"],
          captureRoot: SHELL_ORACLE_CAPTURE_ROOT,
          capturePrefix: ".oracle-",
          cwd: ROOT,
          env: shell.env,
          stdin: new TextEncoder().encode(PRE + body),
        },
        async (proc) => {
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            try { proc.kill("SIGKILL"); } catch { /* child already exited */ }
          }, SHELL_ORACLE_TIMEOUT_MS);
          try {
            const exitCode = await proc.exited;
            return { exitCode, signalCode: proc.signalCode, timedOut };
          } finally {
            clearTimeout(timer);
          }
        },
      );
    } catch (error) {
      out(`  FAIL: shell oracle could not start: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  })();
  if (!captured) return "fail";
  if (captured.stdout) process.stdout.write(captured.stdout);
  if (captured.stderr) process.stderr.write(captured.stderr);
  if (captured.result.timedOut) {
    out(`  FAIL: shell oracle timed out after ${SHELL_ORACLE_TIMEOUT_MS}ms`);
    return "fail";
  }
  if (captured.result.signalCode) {
    out(`  FAIL: shell oracle terminated by signal ${captured.result.signalCode}`);
    return "fail";
  }
  if (captured.result.exitCode === UNCOVERED_EXIT && captured.stdout.includes(UNCOVERED_MARKER)) {
    return "uncovered";
  }
  return captured.result.exitCode === 0 ? "ok" : "fail";
}

// ── steps ─────────────────────────────────────────────────────────────────────
type Step = { name: string; body?: string; fn?: () => boolean | Promise<boolean> };
const steps: Step[] = [];
const S = (name: string, body: string) => steps.push({ name, body });
const F = (name: string, fn: () => boolean | Promise<boolean>) => steps.push({ name, fn });

// 1. dependency-tree artifact hygiene
F("driver dependency-tree artifact hygiene (W-385)", checkDependencyArtifactHygiene);

// 2. driver typecheck
F("driver typecheck (tsc --noEmit)", () => {
  const tsc = join(DRIVER, "node_modules", "typescript", "lib", "tsc.js");
  if (!existsSync(tsc)) { out(`  FAIL: local TypeScript is missing: ${tsc}`); return false; }
  const ok = run([requireRuntimeExecutable("node"), tsc, "--noEmit"], { cwd: DRIVER, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

// W-327: the permanent repository ceiling prevents test-count inflation, while
// the lower canonical ceiling makes a new oracle replace/consolidate an existing
// definition in the same change. The unit registry also rejects a post-driver
// `bun test` invocation of any file already covered by the canonical driver suite.
F("test-definition budget + CI test-unit inventory (W-327)", () => {
  try {
    const inventory = collectTestDefinitionInventory(ROOT);
    validateTestDefinitionBudget(inventory.definitions, W327_CANONICAL_DEFINITION_CEILING);
    const scenarioAuthority = scenarioBudgetAuthority(ROOT);
    validateScenarioBudget(inventory.scenarioCases, W604_CANONICAL_SCENARIO_COUNT, scenarioAuthority.scenarioCases);
    const budgetWarning = testDefinitionBudgetWarning(inventory.definitions, W327_CANONICAL_DEFINITION_CEILING);

    const driverPrefix = relative(ROOT, DRIVER).replace(/\\/g, "/") + "/";
    const canonicalUnits = inventory.files
      .map((file) => file.path)
      .filter((path) => path.startsWith(driverPrefix));

    const shellOraclePath = join(DRIVER, "src", "scripts", "shell_oracles.test.ts");
    if (existsSync(shellOraclePath)) {
      const source = readFileSync(shellOraclePath, "utf8");
      for (const match of source.matchAll(/^import\s+"([^"]+\.(?:test|spec)\.[cm]?[jt]sx?)";/gm)) {
        canonicalUnits.push(relative(ROOT, resolve(dirname(shellOraclePath), match[1]!)).replace(/\\/g, "/"));
      }
    }

    const ciSource = readFileSync(join(DRIVER, "src", "scripts", "ci.ts"), "utf8");
    const postDriverUnits = [...ciSource.matchAll(/bun test "\$ROOT\/([^"]+\.(?:test|spec)\.[cm]?[jt]sx?)"/g)]
      .map((match) => match[1]!);
    assertUniqueTestUnits([...canonicalUnits, ...postDriverUnits]);
    out(`  ok (${inventory.definitions} definitions / ${inventory.files.length} files; scenario census ${inventory.scenarioCases}/${W604_CANONICAL_SCENARIO_COUNT}; immutable authority ${scenarioAuthority.scenarioCases}@${scenarioAuthority.ref}; ceiling ${W327_CANONICAL_DEFINITION_CEILING}, permanent max 300; duplicate units 0)`);
    if (budgetWarning) out(`  WARN: ${budgetWarning}`);
    return true;
  } catch (error) {
    out(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
});

// Test-only focused entrypoint for the inventory reporter. It executes the
// same registered CI step and preserves the production full-CI default.
if (INVENTORY_ONLY) {
  const inventoryStep = steps.at(-1)!;
  step(inventoryStep.name);
  const ok = await inventoryStep.fn!();
  out("");
  out(ok ? "CI: inventory check passed." : "CI: FAILURES above.");
  process.exit(ok ? 0 : 1);
}

// 2. driver unit tests. W-148 keeps the realistic per-test timeout. W-327
// captures the Bun report so a failed run retries only the failed FILE units;
// the former whole-suite retry is forbidden. The reported count is an
// independent fail-closed check because dynamic table definitions can expand
// beyond the static source inventory. Only audited, mkdtemp-isolated files run
// in two bounded parallel shards; shared refs/locks and shell oracles stay serial.
F("driver unit tests (bun test, W-148 realistic timeout)", async () => {
  const wallStartedAt = performance.now();
  const args = driverUnitTestArgs();

  const parallelShards = [
    {
      name: "isolated fixture shard A",
      files: ["src/commit_guard_hook.test.ts"],
    },
    {
      name: "isolated fixture shard B",
      files: [
        "src/dispatch/base_tracking_scan.test.ts",
        "src/public_export_gate.test.ts",
      ],
    },
  ] as const;

  const driverPrefix = relative(ROOT, DRIVER).replace(/\\/g, "/") + "/";
  let driverFiles: string[];
  try {
    driverFiles = collectTestDefinitionInventory(ROOT).files
      .map((file) => file.path)
      .filter((path) => path.startsWith(driverPrefix))
      .map((path) => path.slice(driverPrefix.length));
  } catch (error) {
    out(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const parallelFiles = parallelShards.flatMap((shard) => [...shard.files]);
  const discovered = new Set(driverFiles.map((path) => path.toLowerCase()));
  const missing = parallelFiles.filter((path) => !discovered.has(path.toLowerCase()));
  if (missing.length > 0) {
    out(`  FAIL: audited parallel test unit missing from inventory: ${missing.join(", ")}`);
    return false;
  }
  const selected = new Set(parallelFiles.map((path) => path.toLowerCase()));
  const serialFiles = driverFiles.filter((path) => !selected.has(path.toLowerCase()));
  try {
    assertUniqueTestUnits([...serialFiles, ...parallelFiles]);
    if (serialFiles.length + parallelFiles.length !== driverFiles.length) {
      throw new Error("bounded test partition does not cover the canonical driver inventory exactly once");
    }
  } catch (error) {
    out(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const runUnit = async (name: string, files: readonly string[]) => {
    const child = Bun.spawn([process.execPath, ...args, ...files], {
      cwd: DRIVER,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ] as const);
    out(`  --- ${name}: ${files.length} source file(s) ---`);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    try {
      return { name, exitCode, stdout, stderr, report: parseBunTestReport(`${stdout}\n${stderr}`), parseError: "" };
    } catch (error) {
      return {
        name,
        exitCode,
        stdout,
        stderr,
        report: null,
        parseError: error instanceof Error ? error.message : String(error),
      };
    }
  };

  // At most two Bun processes overlap. The serial partition starts only after
  // both isolated shards complete, so shared Git/lock/shell state never overlaps.
  const parallelRuns = await Promise.all(
    parallelShards.map((shard) => runUnit(shard.name, shard.files)),
  );
  const serialRuns = serialFiles.length > 0
    ? [await runUnit("serial shared-state partition", serialFiles)]
    : [];
  const initialRuns = [...parallelRuns, ...serialRuns];
  const parseFailures = initialRuns.filter((item) => item.report === null);
  if (parseFailures.length > 0) {
    for (const item of parseFailures) out(`  FAIL: ${item.name}: ${item.parseError}`);
    return false;
  }
  const reports = initialRuns.map((item) => item.report!);
  const testCount = reports.reduce((sum, report) => sum + report.testCount, 0);
  const fileCount = reports.reduce((sum, report) => sum + report.fileCount, 0);
  const countOk = testCount >= TARGET_REPORTED_TEST_MIN && testCount <= TARGET_REPORTED_TEST_MAX
    && reports.every((report) => report.testCount >= report.fileCount);
  if (!countOk) {
    out(`  FAIL: runtime test census ${testCount} is invalid for ${fileCount} files; permitted=${TARGET_REPORTED_TEST_MIN}-${TARGET_REPORTED_TEST_MAX}`);
  }

  let ok = initialRuns.every((item) => item.exitCode === 0);
  let retryUnits: string[] = [];
  if (!ok) {
    const failedRuns = initialRuns.filter((item) => item.exitCode !== 0);
    const recoverable = failedRuns.every((item) => item.report!.failedFiles.length > 0);
    retryUnits = [...new Set(failedRuns.flatMap((item) => item.report!.failedFiles))];
    const failedCases = failedRuns.flatMap((item) => item.report!.failedCases);
    if (!recoverable || retryUnits.length === 0) {
      out("  FAIL: a failed partition exposed no failed test file; refusing a whole-suite or whole-shard retry");
      ok = false;
    } else {
      out(`  warning: retrying failed test files ONCE (${retryUnits.join(", ")}; failed cases: ${failedCases.join(" | ")})`);
      const retry = run(["bun", ...args, ...retryUnits], { cwd: DRIVER });
      if (retry.stdout) process.stdout.write(retry.stdout);
      if (retry.stderr) process.stderr.write(retry.stderr);
      ok = retry.exitCode === 0;
    }
  }
  const wallClockSeconds = Math.round((performance.now() - wallStartedAt) / 100) / 10;
  out(`  GATE_TEST_CENSUS ${JSON.stringify({
    test_count: testCount,
    test_count_scope: "full_runtime",
    scenario_count: W604_CANONICAL_SCENARIO_COUNT,
    wall_clock_s: wallClockSeconds,
    executed_files: driverFiles.length,
    duplicate_units: 0,
  })}`);
  out(ok && countOk
    ? `  ok (${testCount} tests / ${fileCount} files; ${initialRuns.length} initial invocations, bounded parallel=2; retry units ${retryUnits.length})`
    : "  FAIL");
  return ok && countOk;
});

// 2b. pm_id authority — the framework's own default id (W-730). This is the
// acceptance oracle for W-730 and it deliberately stands OUTSIDE the release
// smoke below. That smoke opens with the W-608 coverage preflight, which exits
// 3 (UNCOVERED) whenever the control root resolves outside the checkout — which
// is ALWAYS true in a linked worktree, i.e. in every lane gate. An oracle placed
// after it can never appear in a gate log, so the one check that proves W-730
// would have been the one check that never ran.
//
// Nothing here needs the real control root: the run is pointed at a disposable
// one through GARELIER_RELEASE_ROOT, so it measures the same thing from any
// checkout. Given a non-canonical ledger the entrypoint must get PAST pm_id
// validation and name the canonical path it wanted, which contains _workshop.
// Before W-730 a second pm_id regex refused the id outright and this stage was
// never reached.
S(
  "concierge_release pm_id authority — default id _workshop reaches the ledger stage (W-730)",
  `
WROOT="$(mktemp -d)"
(
    set -e
    WPM=_workshop
    mkdir -p "$WROOT/__garelier/$WPM"
    git init -q "$WROOT"
    tr -d '\\r\\n' < "$ROOT/VERSION" > "$WROOT/VERSION"
    printf '%s' '{"schema_version":1,"request_id":"CXO-ci-workshop","operation_kind":"framework_release","approval_status":"approved","requested_by":"user","approved_by":"ci-fixture","user_approval_ref":"ci-smoke"}' > "$WROOT/ledger.json"
    WLEDGER_JSON="$(json_path "$WROOT/ledger.json")"
    WROOT_JSON="$(json_path "$WROOT")"
    WOUT="$(GARELIER_RELEASE_ROOT="$WROOT_JSON" GARELIER_ROLE=concierge \\
      GARELIER_PM_ID=_workshop GARELIER_AGENT_NAME=ga-concierge-ci-workshop \\
      bun "$DRIVER/src/scripts/concierge_release.ts" \\
      --approval-ledger "$WLEDGER_JSON" \\
      --permission-record "$WLEDGER_JSON" \\
      --guardian-report "$WLEDGER_JSON" \\
      --publish-repo "$WROOT_JSON" --repo example/garelier --dry-run 2>&1 || true)"
    printf 'W730_ORACLE default_id=_workshop out=%s\\n' "$WOUT"
    case "$WOUT" in
      *"approval ledger must be the canonical PM-owned request"*) : ;;
      *) echo "  FAIL: default pm_id _workshop refused before the canonical-path check: $WOUT" >&2 ; exit 1 ;;
    esac
    case "$WOUT" in
      *_workshop*) : ;;
      *) echo "  FAIL: the canonical path the _workshop run named carries no _workshop segment: $WOUT" >&2 ; exit 1 ;;
    esac
    # The rejection direction still holds: a traversal id is refused outright,
    # so the oracle above measures acceptance and not a disabled check.
    BADOUT="$(GARELIER_RELEASE_ROOT="$WROOT_JSON" GARELIER_ROLE=concierge \\
      GARELIER_PM_ID=../escape GARELIER_AGENT_NAME=ga-concierge-ci-workshop \\
      bun "$DRIVER/src/scripts/concierge_release.ts" \\
      --approval-ledger "$WLEDGER_JSON" \\
      --permission-record "$WLEDGER_JSON" \\
      --guardian-report "$WLEDGER_JSON" \\
      --publish-repo "$WROOT_JSON" --repo example/garelier --dry-run 2>&1 || true)"
    printf 'W730_ORACLE traversal_id=../escape out=%s\\n' "$BADOUT"
    case "$BADOUT" in
      *"invalid pm_id"*) : ;;
      *) echo "  FAIL: a traversal pm_id was not refused: $BADOUT" >&2 ; exit 1 ;;
    esac
)
W730_RC=$?
rm -rf "$WROOT"
if [ "$W730_RC" -eq 0 ]; then
    echo "  ok (default id _workshop reaches the canonical-ledger stage; traversal id still refused)"
else
    echo "  FAIL: concierge_release pm_id authority oracle"; exit 1
fi
`,
);

// 3. export mode self-check smoke (W-110/W-195). This runs the canonical
// Concierge release entrypoint in dry-run mode against a disposable public
// clone. It exercises authorization routing plus the real history-free export
// and dev-index/export-index 100755 comparison without acquiring a release
// lock, pushing, tagging, or requiring GitHub credentials.
S(
  "Concierge release dry-run export mode self-check smoke (W-110/W-195)",
  `
# 3-value preflight (W-608). concierge_release resolves its control root with
# guard/record_paths.ts resolveControlRoot, which deliberately takes the
# OUTERMOST tree that owns __garelier -- for a linked worktree that is the main
# repo, not this checkout. This body can only place its approval-ledger fixture
# under $ROOT, so from a worktree the canonical path never matches and the tool
# correctly refuses. That is a gap in THIS oracle, not a defect in the product,
# and no gate running inside a lane can close it: writing the fixture where the
# product looks would mean writing outside the checkout. So the dimension is
# reported UNCOVERED rather than guessed either way. The check calls the product
# function itself, so it cannot drift from the rule it is predicting. Run at the
# primary checkout the two roots coincide and the oracle measures normally.
RELEASE_COVERAGE="$(bun -e 'const { resolveControlRoot } = await import("./skills/garelier-core/driver/src/guard/record_paths.ts"); const { resolve } = await import("node:path"); const root = resolve(process.argv[1]); const control = resolveControlRoot(root); const same = process.platform === "win32" ? control.toLowerCase() === root.toLowerCase() : control === root; process.stdout.write(same ? "covered" : "uncovered " + control);' "$ROOT")"
RELEASE_CONTROL_ROOT="$(printf %s "$RELEASE_COVERAGE" | sed -n "s/^uncovered //p")"
case "$RELEASE_COVERAGE" in
    covered) : ;;
    "uncovered "*)
        echo "  UNCOVERED: control root $RELEASE_CONTROL_ROOT is outside the gate checkout $ROOT; run at the primary checkout"
        exit 3 ;;
    *)
        echo "  FAIL: could not resolve the release control root: $RELEASE_COVERAGE"
        exit 1 ;;
esac
PTMP="$(mktemp -d)"
# W-730: the pm_id this fixture mints must satisfy the SAME rule the product
# enforces — config.ts's PM_ID_RE, which caps an id at 20 characters. The old
# \`ci-release-smoke-$$\` is a 17-character prefix, so it passed only while the
# shell PID had three digits or fewer; at four digits it became 21 and the
# release entrypoint refused it. Under \`set -e\` that failed the whole check, so
# the very gate the release checklist mandates could not reach "CI: ok", and it
# did so intermittently because the outcome rode on the PID width.
#
# The product rule is correct and stays; the FIXTURE id is what changes. Keep the
# prefix short and bound the PID width instead of assuming it: 7 + at most 6
# leaves 13 characters, so no PID can push this over the cap.
CI_SMOKE_PID="$(printf %s "$$" | tail -c 6)"
PM_ID="ci-rel-$CI_SMOKE_PID"
REQUEST_ID="CXO-ci-release-smoke-$$"
AGENT_NAME="ga-concierge-ci-release-smoke-$$"
PMROOT="$ROOT/__garelier/$PM_ID"
APPROVAL="$PMROOT/runtime/concierge/requests/framework_release__$REQUEST_ID.approval.json"
PERMISSION="$PMROOT/_crew/lanes/.meta/$AGENT_NAME.dispatch.json"
GUARDIAN="$PMROOT/runtime/guardian/results/$REQUEST_ID-guardian.md"
(
    set -e
    git init -q "$PTMP"
    git -C "$PTMP" symbolic-ref HEAD refs/heads/main
    git -C "$PTMP" config user.email ci@ci
    git -C "$PTMP" config user.name ci
    printf '# public fixture\\n' > "$PTMP/README.md"
    git -C "$PTMP" add README.md
    git -C "$PTMP" commit -qm init
    REMOTE_URL="https://example.invalid/garelier.git"
    git -C "$PTMP" remote add origin "$REMOTE_URL"
    SOURCE_SHA="$(git -C "$ROOT" rev-parse HEAD)"
    PUBLISH_SHA="$(git -C "$PTMP" rev-parse HEAD)"
    GIT_COMMON_RAW="$(git -C "$ROOT" rev-parse --git-common-dir)"
    GIT_COMMON_DIR="$(cd "$ROOT" && cd "$GIT_COMMON_RAW" && pwd -P)"
    RELEASE_TAG="v$(tr -d '\\r\\n' < "$ROOT/VERSION")"
    mkdir -p "$(dirname "$APPROVAL")" "$(dirname "$PERMISSION")" "$(dirname "$GUARDIAN")"
    CONTROL_ROOT_JSON="$(json_path "$ROOT")"
    GIT_COMMON_JSON="$(json_path "$GIT_COMMON_DIR")"
    PERMISSION_JSON="$(json_path "$PERMISSION")"
    GUARDIAN_JSON="$(json_path "$GUARDIAN")"
    PUBLISH_JSON="$(json_path "$PTMP")"
    cat > "$APPROVAL" <<EOF
{"schema_version":1,"request_id":"$REQUEST_ID","operation_kind":"framework_release","approval_status":"approved","requested_by":"user","approved_by":"ci-fixture","user_approval_ref":"ci-smoke","pm_id":"$PM_ID","control_root":"$CONTROL_ROOT_JSON","git_common_dir":"$GIT_COMMON_JSON","agent_name":"$AGENT_NAME","permission_record":"$PERMISSION_JSON","guardian_report":"$GUARDIAN_JSON","release_tag":"$RELEASE_TAG","source_sha":"$SOURCE_SHA","publish_repo":"$PUBLISH_JSON","expected_publish_sha":"$PUBLISH_SHA","github_repo":"example/garelier","target_remote":"origin","approved_remote_url":"$REMOTE_URL"}
EOF
    cat > "$PERMISSION" <<EOF
{"schema_version":1,"source":"attended_record","spawned_via":"dispatch_prepare","guard":{"permission_profile":"concierge","role":"concierge","agent_name":"$AGENT_NAME","worktree":"$CONTROL_ROOT_JSON","approved_remote_destinations":[{"name":"origin","url":"$REMOTE_URL"}]}}
EOF
    cat > "$GUARDIAN" <<EOF
+++
[verdict]
result = 'PASS'
review_sha = '$SOURCE_SHA'
+++

## Verdict

PASS
EOF
    GARELIER_ROLE=concierge GARELIER_PM_ID="$PM_ID" GARELIER_AGENT_NAME="$AGENT_NAME" \\
      bun "$DRIVER/src/scripts/concierge_release.ts" \\
      --approval-ledger "$APPROVAL" \\
      --permission-record "$PERMISSION" \\
      --guardian-report "$GUARDIAN" \\
      --publish-repo "$PTMP" --repo example/garelier --dry-run
    test "$(git -C "$PTMP" rev-parse HEAD)" = "$PUBLISH_SHA"
    test -z "$(git -C "$PTMP" status --porcelain)"
    ! grep -Eq 'bun[[:space:]]+skills/garelier-core/driver/src/scripts/release\\.ts' \
      "$ROOT/scripts/references/release_runbook.md"
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then
    echo "  ok"
else
    echo "  FAIL"
    rm -rf "$PTMP" "$PMROOT"
    exit 1
fi
rm -rf "$PTMP" "$PMROOT"
`,
);

// 4. W-111 permanent shell allowlist. Scan the filesystem rather than only the
// index so an untracked shell file cannot bypass the gate.
F("shell allowlist (task_mirror_hook only; W-111)", () => {
  const allowed = "skills/garelier-core/hooks/task_mirror_hook.sh";
  const found: string[] = [];
  const walk = (dir: string, rel = ""): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules" || (rel === "" && name === "__garelier")) continue;
      const path = join(dir, name);
      const next = rel ? `${rel}/${name}` : name;
      const st = statSync(path);
      if (st.isDirectory()) walk(path, next);
      else if (name.endsWith(`.${"s"}h`)) found.push(next.replace(/\\/g, "/"));
    }
  };
  walk(ROOT);
  found.sort();
  if (found.length !== 1 || found[0] !== allowed) {
    out(`  FAIL: shell allowlist mismatch: ${found.join(", ") || "(none)"}`);
    return false;
  }
  const syntax = runBash(["-n", join(ROOT, allowed)], { stderr: "inherit" }).exitCode === 0;
  out(syntax ? `  ok (${allowed} is the sole shell file and parses)` : `  FAIL: ${allowed} syntax`);
  return syntax;
});

// W-112: console-less Windows parents must not let child processes allocate a
// transient console window. The AST lint covers Bun and node:child_process
// calls in production code and test fixtures; windowsHide is a no-op elsewhere.
F("spawn windowsHide lint (W-112)", () => {
  const lint = join(DRIVER, "src", "scripts", "spawn_windows_hide_lint.ts");
  const ok = run(["bun", lint, ROOT], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

F("bare tool spawn lint (Windows/POSIX path resolution)", () => {
  const lint = join(DRIVER, "src", "scripts", "tool_spawn_lint.ts");
  const ok = run(["bun", lint, join(ROOT, "skills")], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

// W-113: destructive filesystem operations must pass the canonical path fence.
F("path_guard raw destructive fs lint (W-113)", () => {
  const lint = join(DRIVER, "src", "scripts", "path_guard_lint.ts");
  const ok = run(["bun", lint, join(DRIVER, "src")], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

// W-165: showcase/ is a gitignored, transient deliverable drop-zone (retention.md
// § Showcase, W-085). A committed file there is a convention breach — detect it.
F("tracked showcase lint (W-165)", () => {
  const lint = join(DRIVER, "src", "scripts", "showcase_tracked_lint.ts");
  const ok = run(["bun", lint, ROOT], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

// W-310: skills/ is read directly on GitHub, not only through
// make-public-export.ts's publish-time gate — a developer-private identifier
// (project name / dev handle) left in skills/ is visible long before any
// export happens. Rerun the export gate's own deny-list on every CI pass.
F("identity scrub lint (skills/ published surface; W-310)", () => {
  const lint = join(DRIVER, "src", "scripts", "identity_scrub_lint.ts");
  const ok = run(["bun", lint, ROOT], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
  out(ok ? "  ok" : "  FAIL");
  return ok;
});

// W-193: backlog rows are a fixed cost every worker/gate re-reads on pickup. This
// flags any row whose line exceeds the threshold so its gate/note trail is moved to
// a canonical sidecar (control/rows/<id>.md). ADVISORY — warn mode never fails CI
// (the migration is a PM edit; the backlog legitimately holds long rows today).
F("backlog row-length lint (advisory; W-193)", () => {
  const lint = join(DRIVER, "src", "scripts", "backlog_row_length_lint.ts");
  const backlog = join(ROOT, "__garelier", "_workshop", "control", "project_dashboard", "backlog.md");
  if (!existsSync(backlog)) { out("  ok (no _workshop backlog to lint)"); return true; }
  run(["bun", lint, backlog], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }); // prints its own ok/warning line
  return true; // advisory: never fails CI
});

// 4. install.ts smoke
S(
  "install.ts smoke (Claude Code + Codex skill roots)",
  `
ITMP="$(mktemp -d)"
(
    set -e
    export CLAUDE_HOME="$ITMP/claude"
    export CODEX_HOME="$ITMP/codex"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/install.ts" >/dev/null
    for root in "$CLAUDE_HOME/skills" "$CODEX_HOME/skills"; do
        for skill in garelier-core garelier-pm garelier-worker; do
            [ -L "$root/$skill" ] || { echo "missing symlink: $root/$skill" >&2; exit 1; }
            [ -f "$root/$skill/SKILL.md" ] || { echo "missing SKILL.md through symlink: $root/$skill" >&2; exit 1; }
        done
    done
    bun "$ROOT/skills/garelier-core/driver/src/scripts/install.ts" --codex-only >/dev/null
    [ -L "$CODEX_HOME/skills/garelier-pm" ]
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then
    echo "  ok"
else
    echo "  FAIL"
    rm -rf "$ITMP"
    exit 1
fi
rm -rf "$ITMP"
`,
);

// 5. wizard fresh-setup smoke — EXILE opt-in. Fresh writes `_crew/pm`, so the
//    diff-mode cd resolves the canonical PM directory.
S(
  "wizard fresh-setup smoke — EXILE opt-in (throwaway git repo)",
  `
crewpm() { echo "$1/_crew/pm"; }
TMP="$(mktemp -d)"
WSHOME="$(mktemp -d)"   # DEC-036: opt into exile via an isolated GARELIER_HOME (never touches ~/.garelier)
(
    set -e
    cd "$TMP"
    git init -q
    git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git config user.email ci@ci; git config user.name ci
    echo "# ci" > README.md; git add -A; git commit -qm init >/dev/null
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    export GARELIER_HOME="$WSHOME"
    mkdir __garelier; cd __garelier
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode fresh --skip-confirm \\
        --pm-id ci --project-name CI --target main \\
        --stack typescript >/dev/null
    cd "$TMP"
    PTR="$TMP/__garelier/ci/runtime/workspace_paths"
    resolve_c() { [ -f "$PTR" ] && awk -v k="$1" 'index($0,k"=")==1{print substr($0,length(k)+2);exit}' "$PTR" || true; }
    for d in runtime/observer/requests control/observations; do
        [ -e "__garelier/ci/$d" ] || { echo "missing __garelier/ci/$d" >&2; exit 1; }
    done
    for kv in worker.w1 scout.s1 librarian.lib1 observer.obs1 artisan; do
        [ -n "$(resolve_c "$kv")" ] && { echo "fresh wrote a pointer entry for $kv (DEC-065: no pre-created containers)" >&2; exit 1; }
    done
    for r in _crew/dock _crew/workers _crew/scouts _crew/smiths _crew/librarians _crew/observers _crew/guardians _crew/concierges _crew/artisan; do
        [ -e "__garelier/ci/$r" ] && { echo "fresh pre-created role dir $r (DEC-065: dispatch-native)" >&2; exit 1; }
    done
    [ -f "__garelier/.gitignore" ] || { echo "nested __garelier/.gitignore not written" >&2; exit 1; }
    grep -qE '^\\*/runtime/$' "__garelier/.gitignore" || { echo "nested __garelier/.gitignore missing */runtime/ rule" >&2; exit 1; }
    grep -qE '^\\*/_crew/librarians/$' "__garelier/.gitignore" || { echo "nested __garelier/.gitignore missing worktree rules (librarians/)" >&2; exit 1; }
    git check-ignore -q "__garelier/ci/runtime" || { echo "git does not honor nested __garelier/.gitignore for runtime/" >&2; exit 1; }
    [ -f "__garelier/.ignore" ] || { echo "nested __garelier/.ignore not written" >&2; exit 1; }
    if [ -f .gitignore ] && grep -qi "garelier" .gitignore; then
        echo "project root .gitignore must stay Garelier-free (DEC-051 nested ignores)" >&2; exit 1
    fi
    if [ -f .gitignore ] && grep -qE '^/(STATE|assignment|report|under_review|merged|abort|track-target)\\.md$|^/archive/$' .gitignore; then
        echo "retired root-anchored coordination rules still present in root .gitignore" >&2; exit 1
    fi
    if grep -qE '^/(STATE|assignment|report|under_review|merged|abort|track-target)\\.md$|^/archive/$' "__garelier/.gitignore"; then
        echo "retired root-anchored coordination rules leaked into nested __garelier/.gitignore" >&2; exit 1
    fi
    [ -f "__garelier/ci/knowledge/security/security_policy.md" ] || { echo "security scaffold not seeded at __garelier/ci/knowledge/security/" >&2; exit 1; }
    [ -f "__garelier/ci/knowledge/security/registries/secret_patterns.toml" ] || { echo "security registries not seeded" >&2; exit 1; }
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); if(c.observers.length||!c.artisan||c.qualityGate.stack!=="typescript"){throw new Error("generated config did not parse as expected");}' "$TMP"
    cd "$(crewpm "$TMP/__garelier/ci")"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode diff --skip-confirm \\
        --workers "w1:claude-code:" --scouts "s1:claude-code:" \\
        --librarians "lib2:claude-code:" --observers "" --no-artisan >/dev/null
    cd "$TMP"
    lib2c="$(resolve_c librarian.lib2)"
    [ -n "$lib2c" ] || { echo "diff: pointer has no entry for librarian.lib2" >&2; exit 1; }
    case "$lib2c" in "$TMP"/*) echo "diff: lib2 container is INSIDE the project ($lib2c) — exile (opt-in) requires it outside" >&2; exit 1 ;; esac
    [ -d "$lib2c/checkout" ] || { echo "diff: missing exile worktree $lib2c/checkout" >&2; exit 1; }
    [ -f "$lib2c/STATE.md" ]  || { echo "diff: coordination STATE.md not at exile container $lib2c" >&2; exit 1; }
    [ -f "$lib2c/CLAUDE.md" ] || { echo "diff: coordination CLAUDE.md not at exile container $lib2c" >&2; exit 1; }
    [ -e "$lib2c/checkout/STATE.md" ] && { echo "diff: STATE.md leaked INTO worktree $lib2c/checkout" >&2; exit 1; }
    git worktree list --porcelain | grep -qF "$lib2c/checkout" || { echo "diff: exile worktree not registered: $lib2c/checkout" >&2; exit 1; }
    grep -q "../STATE.md" "$lib2c/CLAUDE.md" || { echo "diff: role CLAUDE.md missing ../STATE.md" >&2; exit 1; }
    [ -n "$(resolve_c librarian.lib1)" ] && { echo "diff: lib1 pointer not removed" >&2; exit 1; }
    [ -n "$(resolve_c artisan)" ] && { echo "diff: artisan pointer not removed" >&2; exit 1; }
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); const libs=(c.librarians??[]).map(l=>l.id); if(libs.join()!=="lib2"||(c.observers??[]).length!==0||c.artisan){throw new Error("diff-mode config did not parse as expected: "+JSON.stringify(libs));}' "$TMP"
    printf '\\nlocal tracked edit\\n' >> "$lib2c/checkout/README.md"
    printf 'local untracked edit\\n' > "$lib2c/checkout/untracked.txt"
    cd "$(crewpm "$TMP/__garelier/ci")"
    DIRTY_OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode diff --skip-confirm \\
        --workers "w1:claude-code:" --scouts "s1:claude-code:" \\
        --librarians "" --observers "" --no-artisan 2>&1)"
    printf '%s\\n' "$DIRTY_OUT" | grep -qF "skipped librarian lib2: worktree has uncommitted changes" || {
        echo "diff: dirty removal was not diagnosed" >&2; exit 1;
    }
    printf '%s\\n' "$DIRTY_OUT" | grep -qF "tracked=1, untracked=1" || {
        echo "diff: dirty summary did not classify tracked + untracked changes" >&2; exit 1;
    }
    [ -f "$lib2c/checkout/untracked.txt" ] || { echo "diff: dirty untracked file was deleted" >&2; exit 1; }
    grep -qF "local tracked edit" "$lib2c/checkout/README.md" || { echo "diff: dirty tracked edit was deleted" >&2; exit 1; }
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); const libs=(c.librarians??[]).map(l=>l.id); if(libs.join()!=="lib2"){throw new Error("dirty-skipped role must remain configured for a safe retry: "+JSON.stringify(libs));}' "$TMP"
    git -C "$lib2c/checkout" cat-file --filters --path=README.md HEAD:README.md > "$lib2c/checkout/README.md"
    rm "$lib2c/checkout/untracked.txt"
    exclude="$(git -C "$lib2c/checkout" rev-parse --git-path info/exclude)"
    printf 'ignored-local.txt\\n' >> "$exclude"
    printf 'ignored local edit\\n' > "$lib2c/checkout/ignored-local.txt"
    cd "$(crewpm "$TMP/__garelier/ci")"
    IGNORED_OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode diff --skip-confirm \\
        --workers "w1:claude-code:" --scouts "s1:claude-code:" \\
        --librarians "" --observers "" --no-artisan 2>&1)"
    printf '%s\\n' "$IGNORED_OUT" | grep -qF "tracked=0, untracked=0, ignored=1" || {
        echo "diff: ignored dirty path was not diagnosed" >&2; exit 1;
    }
    [ -f "$lib2c/checkout/ignored-local.txt" ] || { echo "diff: ignored dirty file was deleted" >&2; exit 1; }
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); const libs=(c.librarians??[]).map(l=>l.id); if(libs.join()!=="lib2"){throw new Error("ignored-dirty role must remain configured for a safe retry: "+JSON.stringify(libs));}' "$TMP"
    rm "$lib2c/checkout/ignored-local.txt"
    settings="$lib2c/checkout/.claude/settings.local.json"
    cp "$settings" "$TMP/canonical-settings.local.json"
    bun -e 'const p=process.argv[1]; const s=await Bun.file(p).json(); s.userSetting="keep"; s.hooks.PostToolUse=[{matcher:"Bash",hooks:[{type:"command",command:"printf user-hook"}]}]; await Bun.write(p,JSON.stringify(s,null,2)+"\\n");' "$settings"
    cp "$settings" "$TMP/user-settings.local.json"
    cd "$(crewpm "$TMP/__garelier/ci")"
    SETTINGS_OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode diff --skip-confirm \\
        --workers "w1:claude-code:" --scouts "s1:claude-code:" \\
        --librarians "" --observers "" --no-artisan 2>&1)"
    printf '%s\\n' "$SETTINGS_OUT" | grep -qF "tracked=0, untracked=0, ignored=1" || {
        echo "diff: user-extended settings.local.json was not diagnosed" >&2; exit 1;
    }
    cmp "$settings" "$TMP/user-settings.local.json" || {
        echo "diff: user key/hook in settings.local.json was deleted or changed" >&2; exit 1;
    }
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); const libs=(c.librarians??[]).map(l=>l.id); if(libs.join()!=="lib2"){throw new Error("settings-dirty role must remain configured for a safe retry: "+JSON.stringify(libs));}' "$TMP"
    cp "$TMP/canonical-settings.local.json" "$settings"
    cd "$(crewpm "$TMP/__garelier/ci")"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode diff --skip-confirm \\
        --workers "w1:claude-code:" --scouts "s1:claude-code:" \\
        --librarians "" --observers "" --no-artisan >/dev/null
    [ ! -e "$lib2c" ] || { echo "diff: clean role container was not removed on retry" >&2; exit 1; }
    [ -z "$(resolve_c librarian.lib2)" ] || { echo "diff: clean role pointer was not removed on retry" >&2; exit 1; }
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then echo "  ok fresh-setup + diff + loadConfig parse"; else echo "  FAIL wizard smoke"; rm -rf "$TMP" "$WSHOME"; exit 1; fi
rm -rf "$TMP" "$WSHOME"
`,
);

// 6. wizard fresh capabilities
S(
  "wizard fresh capabilities — every role available without fixed metadata",
  `
TMP="$(mktemp -d)"; WSHOME="$(mktemp -d)"
(
    set -e
    cd "$TMP"
    git init -q; git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git config user.email ci@ci; git config user.name ci
    echo "# ci" > README.md; git add -A; git commit -qm init >/dev/null
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    export GARELIER_HOME="$WSHOME"
    mkdir __garelier; cd __garelier
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode fresh --skip-confirm \\
        --pm-id ci --project-name CI --target main --stack typescript >/dev/null
    cd "$DRIVER"
    bun -e 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(process.argv[1],"ci"); const roles=["workers","scouts","smiths","librarians","observers","guardians","concierges"]; const fixed=roles.filter(r=>(c[r]??[]).length!==0); if(fixed.length||!c.artisan){throw new Error("expected no fixed role metadata and an available artisan capability; fixed="+fixed.join(",")+" artisan="+!!c.artisan);}' "$TMP"
    SETUP="$TMP/__garelier/ci/_crew/pm/setup_config.toml"
    ! grep -qE '^\\[\\[(workers|scouts|smiths|librarians|observers|guardians|concierges)\\]\\]$|^\\[artisan\\]$' "$SETUP"
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then echo "  ok (no flags -> every role available, no fixed metadata)"; else echo "  FAIL fresh-capabilities smoke"; rm -rf "$TMP" "$WSHOME"; exit 1; fi
rm -rf "$TMP" "$WSHOME"
`,
);

// 7. wizard on-demand container smoke — IN-PROJECT default (`_crew/pm`).
S(
  "wizard on-demand container smoke — IN-PROJECT default (DEC-036/065)",
  `
crewpm() { echo "$1/_crew/pm"; }
ITMP="$(mktemp -d)"
(
    set -e
    unset GARELIER_HOME
    cd "$ITMP"
    git init -q
    git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git config user.email ci@ci; git config user.name ci
    printf '# mainline\\n' > CLAUDE.md; git add -A; git commit -qm init >/dev/null
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    mkdir __garelier; cd __garelier
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode fresh --skip-confirm \\
        --pm-id ci --project-name CI --target main \\
        --stack typescript >/dev/null
    cd "$ITMP"
    for r in _crew/dock _crew/workers _crew/scouts _crew/artisan; do
        [ -e "__garelier/ci/$r" ] && { echo "fresh pre-created role dir $r (DEC-065)" >&2; exit 1; }
    done
    cd "$(crewpm "$ITMP/__garelier/ci")"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" --mode diff --skip-confirm \\
        --workers "w2:claude-code:" --scouts "s1:claude-code:" --artisan >/dev/null
    cd "$ITMP"
    INATIVE="$(command -v cygpath >/dev/null 2>&1 && cygpath -m "$ITMP" 2>/dev/null || printf '%s' "$ITMP")"
    [ -e "__garelier/ci/runtime/workspace_paths" ] && { echo "in-project default wrote a workspace_paths pointer (should not)" >&2; exit 1; }
    dir="__garelier/ci/_crew/workers/w2"
    [ -e "$ITMP/$dir/checkout/.git" ] || { echo "in-project worktree missing: $dir/checkout" >&2; exit 1; }
    [ -f "$ITMP/$dir/STATE.md" ]      || { echo "container STATE.md missing: $dir" >&2; exit 1; }
    s="$ITMP/$dir/checkout/.claude/settings.local.json"
    [ -f "$s" ] || { echo "claudeMdExcludes settings missing: $s" >&2; exit 1; }
    grep -qF "$INATIVE/CLAUDE.md" "$s" || { echo "claudeMdExcludes does not exclude the target CLAUDE.md: $s" >&2; exit 1; }
    if git -C "$ITMP/$dir/checkout" status --porcelain | grep -q "settings.local.json"; then
        echo "settings.local.json leaks as untracked in $dir/checkout" >&2; exit 1
    fi
    if [ -e "__garelier/ci/_crew/workers/w1" ]; then
        echo "diff created an unrequested container for w1" >&2; exit 1
    fi
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then echo "  ok dispatch-native fresh + on-demand diff add: in-project container, no pointer, claudeMdExcludes, no untracked leak"; else echo "  FAIL in-project on-demand smoke"; rm -rf "$ITMP"; exit 1; fi
rm -rf "$ITMP"
`,
);

// 8. doctor smoke (safety gate)
S(
  "doctor smoke (safety gate)",
  `
WIZ="$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts"
DOCTOR="$ROOT/skills/garelier-core/driver/src/scripts/doctor.ts"
crewpm() { echo "$1/_crew/pm"; }
DTMP="$(mktemp -d)"
(
    set -e
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    export GARELIER_HOME="$DTMP/.garelier-home"
    init_repo() {
        cd "$1"; git init -q
        git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
        git config user.email ci@ci; git config user.name ci
        echo "# ci" > README.md; git add -A; git commit -qm init >/dev/null
    }
    A="$DTMP/strict"; mkdir -p "$A"; init_repo "$A"
    ( cd "$A" && mkdir __garelier && cd __garelier && \\
      bun "$WIZ" --mode fresh --skip-confirm --pm-id ci --project-name S --target main \\
        --stack typescript >/dev/null )
    if bun "$DOCTOR" --pm-id ci --project "$A" >/dev/null 2>&1; then
        echo "expected doctor P0 (AGENTS placeholders) on strict setup, got exit 0" >&2; exit 1
    fi
    rm -f "$A/AGENTS.md"
    out="$(bun "$DOCTOR" --pm-id ci --project "$A" 2>&1 || true)"
    case "$out" in *agents-missing*) : ;; *) echo "expected agents-missing P0 when AGENTS.md absent" >&2; exit 1 ;; esac
    if bun "$DOCTOR" --pm-id ci --project "$A" >/dev/null 2>&1; then
        echo "expected nonzero exit for missing AGENTS.md" >&2; exit 1
    fi
    B="$DTMP/min"; mkdir -p "$B"; init_repo "$B"
    ( cd "$B" && mkdir __garelier && cd __garelier && \\
      bun "$WIZ" --mode fresh --skip-confirm --pm-id ci --project-name M --target main \\
        --stack typescript --agents-policy minimal >/dev/null )
    if ! bun "$DOCTOR" --pm-id ci --project "$B" >/dev/null 2>&1; then
        echo "expected doctor exit 0 after --agents-policy minimal" >&2
        bun "$DOCTOR" --pm-id ci --project "$B" >&2 || true; exit 1
    fi
    CFG="$(crewpm "$B/__garelier/ci")/setup_config.toml"
    printf '\n[permissions]\nprofile = "dangerous"\n' >> "$CFG"
    out="$(bun "$DOCTOR" --pm-id ci --project "$B" 2>&1 || true)"
    case "$out" in *permissions-dangerous*) : ;; *) echo "expected permissions-dangerous P1 finding" >&2; exit 1 ;; esac
    sed -i.bak 's/^profile = "dangerous"/profile = "reviewed"/' "$CFG" && rm -f "$CFG.bak"
    awk '
        /^\\[quality_gate\\]/ { print "[quality_gate]"; print "stack = \\"custom\\""; print "commands = ["; print "]"; skip=1; next }
        skip && /^\\]/ { skip=0; next }
        skip { next }
        { print }
    ' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
    if bun "$DOCTOR" --pm-id ci --project "$B" >/dev/null 2>&1; then
        echo "expected doctor P0 for custom stack with empty commands" >&2; exit 1
    fi
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then echo "  ok doctor: strict P0 / missing-AGENTS P0 / minimal clean / dangerous P1 / custom-empty P0"; else echo "  FAIL doctor smoke"; rm -rf "$DTMP"; exit 1; fi
rm -rf "$DTMP"
`,
);

// 9. DEC-036 doctor reaches canonical containers
S(
  "DEC-036 doctor reaches exiled containers (P0 leak scan)",
  `
DTMP="$(mktemp -d)"; DHOME="$(mktemp -d)"
(
    set -e
    cd "$DTMP"
    git init -q
    git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
    git config user.email ci@ci; git config user.name ci
    echo "# ci" > README.md; git add -A; git commit -qm init >/dev/null
    mkdir -p "__garelier/ci/_crew/pm" "__garelier/ci/runtime"
    {
        printf '[branches]\\ntarget = "main"\\n'
        printf '[[guardians]]\\nid = "g1"\\nprovider = "claude-code"\\nmodel = "claude-code"\\n'
        printf '[guardian_policy]\\nenabled = true\\n'
    } > "__garelier/ci/_crew/pm/setup_config.toml"
    GC="$DHOME/studios/exile-ci/_crew/guardians/g1"
    mkdir -p "$GC"
    # Native Bun cannot resolve Git Bash's /tmp spelling on Windows. Real
    # wizard pointers use the native/mixed absolute spelling, so do the same.
    GC_DISPLAY="$(cd "$GC" && (pwd -W 2>/dev/null || pwd))"
    printf 'guardian.g1=%s\\n' "$GC_DISPLAY" > "__garelier/ci/runtime/workspace_paths"
    printf 'verdict: BLOCK\\nleaked: AKIAIOSFODNN7EXAMPLE\\n' > "$GC/guardian_report.md"
    out="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/doctor.ts" --pm-id ci --project "$DTMP" 2>&1 || true)"
    printf '%s' "$out" | grep -q "guardian-report-leak" \\
        || { echo "doctor missed the secret in the EXILED guardian report" >&2; exit 1; }
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then echo "  ok doctor resolves exiled containers (P0 guardian-report-leak fires)"; else echo "  FAIL doctor exile-scan smoke"; rm -rf "$DTMP" "$DHOME"; exit 1; fi
rm -rf "$DTMP" "$DHOME"
`,
);

// 11. deprecated-path lint
S(
  "deprecated-path lint",
  `
dead="docs/$(printf '%s' project_state)/"
hits="$(git -C "$ROOT" grep -nI -e "$dead" \\
    -- ':(exclude)__garelier/$WS/control/decisions/*' ':(exclude)CHANGELOG.md' ':(exclude)ci.ts' \\
       ':(exclude)__garelier/*' 2>/dev/null || true)"
if [ -n "$hits" ]; then
    echo "  FAIL: retired path '$dead' found in shipped content:"
    echo "$hits" | sed 's/^/    /'
    exit 1
else
    echo "  ok (no retired '$dead' in shipped content)"
fi
`,
);

// 12. inclusive-language lint
S(
  "inclusive-language lint (banned terms in shipped content)",
  `
banned="$(git -C "$ROOT" grep -nIw -i -e ma"ster" -e sl"ave" -e white"list" -e black"list" \\
    -- skills docs scripts README.md CLAUDE.md AGENTS.md 2>/dev/null || true)"
if [ -n "$banned" ]; then
    echo "  FAIL: banned term found in shipped content (use main / allowlist / denylist):"
    echo "$banned" | sed 's/^/    /'
    exit 1
else
    echo "  ok (no banned inclusive-language terms in shipped content)"
fi
`,
);

// 13. skill YAML frontmatter validation
S(
  "skill YAML frontmatter validation",
  `
if bun "$ROOT/scripts/check_skill_frontmatter.ts"; then
    echo "  ok"
else
    echo "  FAIL"
    exit 1
fi
`,
);

// 14. executable bit check
S(
  "executable bit check (shell exception + bin, executable TS shebangs)",
  `
nonexec="$(git -C "$ROOT" ls-files --stage -- 'skills/garelier-core/hooks/task_mirror_hook.sh' 'bin/garelier' | awk '$1!="100755"{print "    "$1" "$4}')"
if [ -n "$nonexec" ]; then
    echo "  FAIL: these tracked executables are missing the +x bit (git update-index --chmod=+x):"
    echo "$nonexec"
    exit 1
fi
bad_ts="$(git -C "$ROOT" ls-files --stage -- '*.ts' | awk '$1=="100755"{print $4}' | while IFS= read -r f; do head -1 "$ROOT/$f" | grep -qx '#!/usr/bin/env bun' || echo "    $f"; done)"
if [ -n "$bad_ts" ]; then
    echo "  FAIL: executable TypeScript files without the Bun shebang:"
    echo "$bad_ts"
    exit 1
fi
echo "  ok (shell exception + bin are 100755; executable TS files use the Bun shebang)"
`,
);

// 15. skill slash-menu visibility
S(
  "skill slash-menu visibility (only user entry points are user-invocable)",
  `
entry=" garelier-pm "
vis=0
while IFS= read -r f; do
    sk="$(basename "$(dirname "$f")")"
    case "$entry" in *" $sk "*) continue ;; esac
    if ! grep -qE '^user-invocable:[[:space:]]*false[[:space:]]*$' "$ROOT/$f"; then
        echo "  FAIL: $sk is internal — its SKILL.md must set 'user-invocable: false'"; vis=1
    fi
done < <(git -C "$ROOT" ls-files -- 'skills/garelier-*/SKILL.md')
if [ "$vis" -eq 0 ]; then echo "  ok (sole entry point pm invocable; 11 internal skills hidden)"; else exit 1; fi
`,
);

// 16. DEC-036 exile-path lint
S(
  "DEC-036 exile-path lint (role SKILLs must not hardcode relative hops)",
  `
dec035=0
hop_hits="$(git -C "$ROOT" grep -nIE 'is \`\\.\\./\\.\\./\\.\\.' \\
    -- 'skills/garelier-*/SKILL.md' 'skills/garelier-*/references/*' 2>/dev/null || true)"
if [ -n "$hop_hits" ]; then
    echo "  FAIL: role SKILL/reference instructs a fixed relative hop (breaks under DEC-035 exile):"
    echo "$hop_hits" | sed 's/^/    /'
    echo "    -> address primary/runtime/control via the role's CLAUDE.md absolute paths"
    dec035=1
fi
if [ "$dec035" -eq 0 ]; then echo "  ok (no fixed relative hops in role SKILLs; handoff resolver wired)"; else exit 1; fi
`,
);

// 17. doc drift check
S(
  "doc drift check (version + DEC index)",
  `
drift=0
VER="$(tr -d '[:space:]' < "$ROOT/VERSION")"
if ! grep -qF "## [$VER]" "$ROOT/CHANGELOG.md"; then
    echo "  FAIL: CHANGELOG.md has no '## [$VER]' section (VERSION=$VER)"; drift=1
fi
if ! grep -qF "$VER" "$ROOT/README.md"; then
    echo "  FAIL: README.md does not mention VERSION $VER"; drift=1
fi
for mf in .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
    if ! grep -qF "\\"version\\": \\"$VER\\"" "$ROOT/$mf"; then
        echo "  FAIL: $mf does not declare \\"version\\": \\"$VER\\""; drift=1
    fi
done
if [ -e "$ROOT/docs/decisions" ]; then
    echo "  FAIL: docs/decisions is a duplicate decision authority; migrate records into __garelier/$WS/control/decisions"; drift=1
fi
record_ids="$(for f in "$ROOT"/__garelier/$WS/control/decisions/DEC-[0-9]*-*.md; do
    [ -e "$f" ] || continue
    basename "$f"
done | sed -E 's/^(DEC-[0-9]+)-.*/\\1/' | sort)"
dec_file="$ROOT/__garelier/$WS/control/project_dashboard/decisions.md"
if [ -f "$dec_file" ]; then
    index_ids="$(grep -oE '^\\| DEC-[0-9]+' "$dec_file" | grep -oE 'DEC-[0-9]+' | sort)"
    missing="$(comm -23 <(printf '%s\\n' "$record_ids") <(printf '%s\\n' "$index_ids") | tr '\\n' ' ')"
    orphan="$(comm -13 <(printf '%s\\n' "$record_ids") <(printf '%s\\n' "$index_ids") | tr '\\n' ' ')"
    if [ -n "$missing" ]; then echo "  FAIL: decisions.md is missing canonical records:$missing"; drift=1; fi
    if [ -n "$orphan" ]; then echo "  FAIL: decisions.md indexes missing records:$orphan"; drift=1; fi
fi
if [ "$drift" -eq 0 ]; then echo "  ok (VERSION $VER reflected; DEC index in sync)"; else exit 1; fi
`,
);

// 18. two-layer documentation sync
S(
  "two-layer documentation sync",
  `
if bun "$ROOT/scripts/check_doc_sync.ts"; then
    echo "  ok"
else
    echo "  FAIL"; exit 1
fi
`,
);

// 19. commit lint
S(
  "commit lint (framework repo only)",
  `
cl=0
bun "$ROOT/skills/garelier-core/scripts/lint_commits.ts" --last "$ROOT" || cl=1
if [ "$cl" -eq 0 ]; then echo "  ok"; else echo "  FAIL"; exit 1; fi
`,
);

// 20. control / knowledge contract graph tests
S(
  "control / knowledge contract graph tests",
  `
(
    set -e
    CTMP="$(mktemp -d)"
    trap 'rm -rf "$CTMP"' EXIT
    git -C "$CTMP" init -q -b main
    git -C "$CTMP" config user.email ci@ci
    git -C "$CTMP" config user.name ci
    printf '# graph\\n' > "$CTMP/README.md"
    git -C "$CTMP" add README.md
    git -C "$CTMP" commit -qm init
    # W-314: control-only retired. \`garelier setup\` is the sole initializer of
    # BOTH the control tree and the knowledge tree.
    mkdir -p "$CTMP/__garelier"
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    ( cd "$CTMP/__garelier" && bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" \\
        --mode fresh --skip-confirm --pm-id _workshop --project-name Graph \\
        --target main --stack typescript --agents-policy minimal >/dev/null )
    test -f "$CTMP/__garelier/$WS/control/control.toml"
    test -f "$CTMP/__garelier/$WS/knowledge/knowledge.toml"
    bun "$ROOT/skills/garelier-core/scripts/control_graph.ts" --project "$CTMP" --pm-id _workshop --validate >/dev/null
    bun "$ROOT/skills/garelier-core/scripts/knowledge_graph.ts" --project "$CTMP" --pm-id _workshop --validate >/dev/null
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then
    echo "  ok (setup wizard initializes _workshop control + knowledge; both graphs validate)"
else
    echo "  FAIL"; exit 1
fi
`,
);

// 21. Garelier Control lifecycle smoke
S(
  "Garelier Control lifecycle smoke",
  `
(
    set -e
    LTMP="$(mktemp -d)"
    trap 'rm -rf "$LTMP"' EXIT
    git -C "$LTMP" init -q -b main
    git -C "$LTMP" config user.email ci@ci
    git -C "$LTMP" config user.name ci
    printf '# lifecycle\\n' > "$LTMP/README.md"
    git -C "$LTMP" add README.md
    git -C "$LTMP" commit -qm init
    # W-314: namespaces come from the setup wizard (control-only init retired).
    mkdir -p "$LTMP/__garelier"
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    for id in alpha beta; do
        ( cd "$LTMP/__garelier" && bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" \\
            --mode fresh --skip-confirm --pm-id "$id" --project-name Lifecycle \\
            --target main --stack typescript --agents-policy minimal >/dev/null )
    done
    write_decision() {
        path="$1"; id="$2"; title="$3"
        {
            printf '%s\\n' '+++' 'schema_version = 3' 'kind = "garelier_decision"'
            printf 'id = "%s"\\nstatus = "proposed"\\n' "$id"
            printf '%s\\n' 'created = "2026-08-01T00:00:00.000Z"' 'updated = "2026-08-01T00:00:00.000Z"' 'related = []' '+++' ''
            printf '# %s: %s\\n\\n## Context\\n\\nFixture.\\n\\n## Decision\\n\\nFixture.\\n\\n## Consequences\\n\\nFixture.\\n' "$id" "$title"
        } > "$path"
    }
    write_decision "$LTMP/__garelier/$CA/control/decisions/DEC-901-alpha.md" DEC-901 Alpha
    write_decision "$LTMP/__garelier/$CB/control/decisions/DEC-902-beta.md" DEC-902 Beta
    bun "$ROOT/skills/garelier-core/driver/src/scripts/consolidate_controls.ts" \\
        --project "$LTMP" --from-pm-id alpha,beta --to-pm-id _workshop --apply >/dev/null
    test -f "$LTMP/__garelier/$WS/runtime/import/consolidation/"*/reports/plan.md
    bun "$ROOT/skills/garelier-core/driver/src/scripts/split_control.ts" \\
        --project "$LTMP" --from-pm-id alpha --to-pm-id gamma \\
        --select decisions/DEC-901-alpha.md --apply >/dev/null
    test -f "$LTMP/__garelier/gamma/runtime/import/split/"*/source/control/decisions/DEC-901-alpha.md
    bun "$ROOT/skills/garelier-pm/scripts/control_export.ts" \\
        --project "$LTMP" --pm-id alpha --to "$LTMP/control-bundle" >/dev/null
    bun "$ROOT/skills/garelier-pm/scripts/control_import.ts" \\
        --project "$LTMP" --pm-id delta --from "$LTMP/control-bundle" --apply >/dev/null
    test -f "$LTMP/__garelier/$CD/control/decisions/DEC-901-alpha.md"
    # W-314: the knowledge tree is seeded by the setup wizard, so it exists in
    # the namespaces the wizard actually ran for ($CA/$CB) - NOT in $WS, which
    # in this fixture is produced by consolidate_controls.ts and holds a control
    # tree only (consolidate/split/control_import never touch knowledge/).
    # The bundle round-trip therefore names $CA explicitly instead of relying on
    # knowledge_export.ts's _workshop default.
    test -f "$LTMP/__garelier/$CA/knowledge/knowledge.toml"
    git -C "$LTMP" add __garelier
    [ -f "$LTMP/.gitignore" ] && git -C "$LTMP" add .gitignore || true
    git -C "$LTMP" commit -qm starters
    # knowledge_export.ts exports TRACKED files under <pm-id>/knowledge. Assert
    # that precondition here so a future fixture change fails at this line
    # rather than inside the exporter.
    test -n "$(git -C "$LTMP" ls-files -- "__garelier/$CA/knowledge")"
    bun "$ROOT/skills/garelier-librarian/scripts/knowledge_export.ts" \\
        --project "$LTMP" --pm-id "$CA" --to "$LTMP/knowledge-bundle" >/dev/null
    bun "$ROOT/skills/garelier-librarian/scripts/knowledge_import.ts" \\
        --project "$LTMP" --pm-id delta --from "$LTMP/knowledge-bundle" >/dev/null
    test -f "$LTMP/__garelier/$CD/runtime/librarian/raw/imported-knowledge-bundle/_source_registry.stub.toml"
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then
    echo "  ok (consolidate / split / control bundle / knowledge bundle)"
else
    echo "  FAIL"; exit 1
fi
`,
);

// 22. (removed by W-314) "small starter -> full _workshop upgrade smoke".
// The step built its fixture with init_control.ts / init_library.ts, the
// control-only starter scripts. control-only is retired (DEC-097) and those
// scripts are deleted, so nothing in the repo can produce a small starter and
// the step's premise is gone. The upgrade code path itself
// (setup_wizard/scaffold.ts makeControlTree with upgradeControlOnly) is
// retained for namespaces that already exist on disk, and is covered by the
// `upgradeControlOnly` unit tests in setup_wizard/scaffold.test.ts.
// Fresh-setup coverage is step 5.

// 23. dispatch prepare/cleanup smoke
// W-363 が W-200/W-363 doctrine を統合改稿するため、移行期間は両形受理 — land 後に新形へ tighten 可
S(
  "dispatch prepare/cleanup smoke (DEC-063)",
  `
DT="$(mktemp -d)"
(
    set -e
    cd "$DT"
    git init -q -b main .
    git -c user.email=ci@ci -c user.name=ci commit -q --allow-empty -m init
    git branch "garelier/main/tpm/studio"
    init_task_file "$DT"
    set +e
    MISSING_OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$DT" --pm-id tpm --role worker --slug missing-schema --base "garelier/main/tpm/studio" --provider claude-code --model claude-test --effort high --task-file "$DT/ci_smoke_task.md" 2>&1)"
    MISSING_RC=$?
    set -e
    [ "$MISSING_RC" -eq 4 ]
    echo "$MISSING_OUT" | grep -qF 'dispatch_prepare: unsupported control schema_version missing; only schema_version 3 is accepted'
    init_schema3_fixture "$DT" tpm 2 cs_ci
    commit_fixture_control "$DT"
    OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$DT" --pm-id tpm --role worker --slug ci-smoke --base "garelier/main/tpm/studio" --provider claude-code --model claude-test --effort high --work-id W-001 --control-session cs_ci --task-file "$DT/ci_smoke_task.md")"
    echo "$OUT" | grep -q '"branch":"garelier/main/tpm/workbench/#1/ci-smoke"'
    echo "$OUT" | grep -q '"prompt_preamble":"You are the Garelier worker for dispatch #1 (ci-smoke)'
    echo "$OUT" | grep -q 'Garelier: tpm worker#1 {{TASK_ID}}'
    echo "$OUT" | grep -q 'Branch: garelier/main/tpm/workbench/#1/ci-smoke. At pickup, base-track'
    { echo "$OUT" | grep -q 'preserve every required gate as ONE whole command' || { echo "  FAIL check: heavy-discipline gate line absent from preamble" >&2; false; }; }
    { echo "$OUT" | grep -qE 'Falling silent at a milestone|Turn termination . background self-check .W-200/W-363.' || { echo "  FAIL check: falling-silent stall line absent from preamble" >&2; false; }; }
    echo "$OUT" | grep -q '"gate_agents":{"guardian":{"name":"ga-guardian-ci-smoke","model":"","report":"runtime/guardian/results/ci-smoke-guardian.md","verdict_template":"skills/garelier-core/templates/gate_verdict.md","work_id":"W-001"},"observer":{"name":"ga-observer-ci-smoke","model":"","report":"runtime/observer/results/ci-smoke-observer.md","verdict_template":"skills/garelier-core/templates/gate_verdict.md","work_id":"W-001"}}'
    [ "$(cat "$DT/__garelier/tpm/runtime/backlog/next_id")" = "2" ]
    git -C "$DT/__garelier/tpm/_crew/dispatch1/checkout" branch --show-current | grep -q "workbench/#1/ci-smoke"
    grep -q '"kind":"start"' "$DT/__garelier/tpm/runtime/dispatch/events.jsonl"
    grep -q '| #1 ci-smoke | dispatch1 (worker) |' "$DT/__garelier/tpm/runtime/backlog/in_flight.md"
    grep -q '^# Report - #1 ci-smoke' "$DT/__garelier/tpm/_crew/dispatch1/report.md"
    [ -f "$DT/__garelier/tpm/_crew/dispatch1/context.json" ]
    grep -q 'dispatch_fact_pack' "$DT/__garelier/tpm/_crew/dispatch1/context.json"
    grep -q 'workbench/#1/ci-smoke' "$DT/__garelier/tpm/_crew/dispatch1/context.json"
    grep -q '"gate_agents"' "$DT/__garelier/tpm/_crew/dispatch1/context.json"
    grep -q 'ga-guardian-ci-smoke' "$DT/__garelier/tpm/_crew/dispatch1/context.json"
    ! bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_cleanup.ts" --project "$DT" --pm-id tpm --id 1 --checkout "$DT/__garelier/tpm/_crew/dispatch1/checkout" --delete-branch >/dev/null 2>&1
    [ -n "$(git -C "$DT" branch --list "*workbench*")" ]
    bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_cleanup.ts" --project "$DT" --pm-id tpm --id 1 --checkout "$DT/__garelier/tpm/_crew/dispatch1/checkout" --delete-branch --force-remove >/dev/null
    [ -z "$(git -C "$DT" branch --list "*workbench*")" ]
    grep -q '"kind":"cleanup"' "$DT/__garelier/tpm/runtime/dispatch/events.jsonl"
    ! grep -q '| #1 ci-smoke' "$DT/__garelier/tpm/runtime/backlog/in_flight.md"
    grep -q '^# #1 ci-smoke - archived by dispatch_cleanup' "$DT/__garelier/tpm/runtime/backlog/done/1-ci-smoke.md"
    [ ! -e "$DT/__garelier/tpm/_crew/dispatch1" ]
    SCOUT_OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$DT" --pm-id tpm --role scout --slug s --base "garelier/main/tpm/studio" --provider claude-code --model claude-test --effort high --work-id W-002 --control-session cs_ci --task-file "$DT/ci_smoke_task.md")"
    echo "$SCOUT_OUT" | grep -q '"has_worktree":false'
    echo "$SCOUT_OUT" | grep -q '"permission_profile":"scout"'
    echo "$SCOUT_OUT" | grep -q '"branch":"garelier/main/tpm/studio"'
    [ ! -e "$DT/__garelier/tpm/_crew/dispatch2/checkout" ]
)
DISPATCH_SMOKE_RC=$?
if [ "$DISPATCH_SMOKE_RC" -eq 0 ]; then
    echo "  ok (prepare/cleanup worktree role + common-entry no-worktree Scout dispatch)"
else
    echo "  FAIL: dispatch prepare/cleanup smoke"; rm -rf "$DT" 2>/dev/null || true; exit 1
fi
rm -rf "$DT" 2>/dev/null || true
`,
);

// 24. dispatch prepare — codex proxy-commit seat mode smoke
S(
  "dispatch prepare — codex proxy-commit seat mode smoke (W-042)",
  `
CT="$(mktemp -d)"
(
    set -e
    cd "$CT"
    git init -q -b main .
    git -c user.email=ci@ci -c user.name=ci commit -q --allow-empty -m init
    git branch "garelier/main/tpm/studio"
    init_task_file "$CT"
    init_schema3_fixture "$CT" tpm 1 cs_ci
    commit_fixture_control "$CT"
    OUT_PROXY="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$CT" --pm-id tpm --role worker --slug codex-proxy --base "garelier/main/tpm/studio" --provider codex --model codex-ci-smoke-model --effort high --work-id W-001 --control-session cs_ci --task-file "$CT/ci_smoke_task.md")"
    echo "$OUT_PROXY" | grep -q '"commit_mode":"proxy"'
    echo "$OUT_PROXY" | grep -q 'Commit (PROXY mode — W-042): you CANNOT run git add / git commit / git stash'
    echo "$OUT_PROXY" | grep -q 'Garelier-Seat: codex codex-ci-smoke-model (proxy-commit via dock seat)'
    echo "$OUT_PROXY" | grep -q 'commit plan submitted (Dock commits — PROXY mode, no SHA yet)'
    echo "$OUT_PROXY" | grep -q 'Output control (output_control.md): your final response and every progress message use the compressed register'
    if bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$CT" --pm-id tpm --role worker --slug codex-self --base "garelier/main/tpm/studio" --provider codex --model codex-ci-smoke-model --effort high --commit-mode self --work-id W-001 --control-session cs_ci --task-file "$CT/ci_smoke_task.md" >/dev/null 2>self.err; then
      echo "FAIL: explicit Codex self commit bypassed the proxy floor" >&2; exit 1
    fi
    grep -q "resolved Codex commit mode 'self' is forbidden" self.err
    if GARELIER_EXTERNAL_SEAT_COMMIT=self bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$CT" --pm-id tpm --role worker --slug codex-env-self --base "garelier/main/tpm/studio" --provider codex --model codex-ci-smoke-model --effort high --work-id W-001 --control-session cs_ci --task-file "$CT/ci_smoke_task.md" >/dev/null 2>env-self.err; then
      echo "FAIL: Codex self-commit environment override bypassed the proxy floor" >&2; exit 1
    fi
    grep -q "resolved Codex commit mode 'self' is forbidden" env-self.err
    [ -z "$(git -C "$CT" branch --list '*codex-self*' '*codex-env-self*')" ]
    [ "$(cat "$CT/__garelier/tpm/runtime/backlog/next_id")" = "2" ]
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then
    echo "  ok (explicit codex -> proxy JSON key + PROXY preamble + Garelier-Seat trailer + output-control block; explicit/env self rejected before id/branch/worktree mutation)"
else
    echo "  FAIL: dispatch prepare codex proxy-commit seat mode smoke"; rm -rf "$CT" 2>/dev/null || true; exit 1
fi
rm -rf "$CT" 2>/dev/null || true
`,
);

// 25. merge_land seat-trailer preflight smoke
S(
  "merge_land seat-trailer preflight smoke (guardian round-2 N1)",
  `
ST="$(mktemp -d)"
(
    set -e
    cd "$ST"
    git init -q -b main .
    git -c user.email=ci@ci -c user.name=ci commit -q --allow-empty -m init
    git branch "garelier/main/tpm/studio"
    init_task_file "$ST"
    init_schema3_fixture "$ST" tpm 4 cs_ci
    commit_fixture_control "$ST"
    bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$ST" --pm-id tpm --role worker --slug seat-missing --base "garelier/main/tpm/studio" --provider codex --model codex-ci-seat-model --effort high --work-id W-001 --control-session cs_ci --task-file "$ST/ci_smoke_task.md" >/dev/null
    bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$ST" --pm-id tpm --role worker --slug seat-stripped --base "garelier/main/tpm/studio" --provider codex --model codex-ci-seat-model2 --effort high --work-id W-002 --control-session cs_ci --task-file "$ST/ci_smoke_task.md" >/dev/null
    bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$ST" --pm-id tpm --role worker --slug seat-gone --base "garelier/main/tpm/studio" --provider codex --model codex-ci-seat-model3 --effort high --work-id W-003 --control-session cs_ci --task-file "$ST/ci_smoke_task.md" >/dev/null
    bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$ST" --pm-id tpm --role worker --slug seat-corrupt --base "garelier/main/tpm/studio" --provider codex --model codex-ci-seat-model4 --effort high --work-id W-004 --control-session cs_ci --task-file "$ST/ci_smoke_task.md" >/dev/null
    grep -q '"commit_mode": "proxy"' "$ST/__garelier/tpm/_crew/dispatch1/context.json"
    git -C "$ST/__garelier/tpm/_crew/dispatch1/checkout" -c user.email=ci@ci -c user.name=ci \\
        commit -q --allow-empty -m "feat(core): x [#1]"
    set +e
    OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --dispatch-id 1 --no-pull 2>&1)"
    RC=$?
    set -e
    [ "$RC" -eq 2 ]
    echo "$OUT" | grep -q "fail --require-seat-trailer"
    echo "$OUT" | grep -q "missing/malformed .Garelier-Seat: codex <model> (proxy-commit via dock seat). trailer"
    echo "$OUT" | grep -q "COMMIT_RULE duty 2/3"
    [ ! -d "$ST/__garelier/tpm/runtime/merge_gate/requests" ] || [ -z "$(ls -A "$ST/__garelier/tpm/runtime/merge_gate/requests" 2>/dev/null)" ]
    grep -q '"commit_mode": "proxy"' "$ST/__garelier/tpm/_crew/dispatch2/context.json"
    bun - "$ST/__garelier/tpm/_crew/dispatch2/context.json" <<'BUN'
const path = process.argv[2];
const context = await Bun.file(path).json();
delete context.routing.commit_mode;
await Bun.write(path, JSON.stringify(context, null, 2) + String.fromCharCode(10));
BUN
    if grep -q "commit_mode" "$ST/__garelier/tpm/_crew/dispatch2/context.json"; then
      echo "FAIL: commit_mode strip did not actually remove the key" >&2; exit 1
    fi
    grep -q '"model": "codex-ci-seat-model2"' "$ST/__garelier/tpm/_crew/dispatch2/context.json"
    git -C "$ST/__garelier/tpm/_crew/dispatch2/checkout" -c user.email=ci@ci -c user.name=ci \\
        commit -q --allow-empty -m "feat(core): y [#2]"
    set +e
    OUT2="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --dispatch-id 2 --no-pull 2>&1)"
    RC2=$?
    set -e
    [ "$RC2" -eq 2 ]
    echo "$OUT2" | grep -q "fail --require-seat-trailer"
    echo "$OUT2" | grep -q "codex-model-inferred"
    B3="garelier/main/tpm/workbench/#3/seat-gone"
    git -C "$ST/__garelier/tpm/_crew/dispatch3/checkout" -c user.email=ci@ci -c user.name=ci \\
        commit -q --allow-empty -m "feat(core): z [#3]

Garelier: tpm worker#3 W-003
Garelier-Seat: codex codex-ci-seat-model3 (proxy-commit via dock seat)"
    mv "$ST/__garelier/tpm/_crew/dispatch3/checkout" "$ST/__garelier/tpm/_crew/dispatch3/checkout.unresolved"
    set +e
    OUT3="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --branch "$B3" --dispatch-id 3 --work-id W-003 --control-session cs_ci --no-pull 2>&1)"
    RC3=$?
    set -e
    [ "$RC3" -eq 2 ]
    echo "$OUT3" | grep -qF "container/context.json is unresolvable ("
    echo "$OUT3" | grep -q "seat-trailer checked"
    # W-731: merge_land prints its USAGE banner on any refusal, and the banner
    # spells this phrase too. Both greps are anchored on the "(" that only the
    # real diagnostic carries, so the oracle reads the error, not the help.
    set +e
    OUT3B="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --branch "$B3" --dispatch-id 3 --work-id W-003 --control-session cs_ci --no-pull --seat-trailer skip 2>&1)"
    set -e
    if echo "$OUT3B" | grep -qF "container/context.json is unresolvable ("; then
      echo "FAIL: --seat-trailer skip override did not suppress the unresolvable-container error" >&2; exit 1
    fi
    echo "$OUT3B" | grep -q "seat-trailer check skipped for dispatch #3 — container unresolvable"
    grep -q '"commit_mode": "proxy"' "$ST/__garelier/tpm/_crew/dispatch4/context.json"
    printf '{}' > "$ST/__garelier/tpm/_crew/dispatch4/context.json"
    git -C "$ST/__garelier/tpm/_crew/dispatch4/checkout" -c user.email=ci@ci -c user.name=ci \\
        commit -q --allow-empty -m "feat(core): w [#4]

Garelier: tpm worker#4 W-004"
    set +e
    OUT4="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --dispatch-id 4 --work-id W-004 --control-session cs_ci --no-pull 2>&1)"
    RC4=$?
    set -e
    [ "$RC4" -eq 2 ]
    echo "$OUT4" | grep -q "exists but its content is unreadable"
    echo "$OUT4" | grep -q "neither routing.commit_mode nor routing.model resolved"
    set +e
    OUT4B="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/merge_land.ts" --project "$ST" --pm-id tpm --dispatch-id 4 --work-id W-004 --control-session cs_ci --no-pull --seat-trailer checked 2>&1)"
    set -e
    if echo "$OUT4B" | grep -q "exists but its content is unreadable"; then
      echo "FAIL: --seat-trailer checked override did not suppress the content-unreadable error" >&2; exit 1
    fi
    echo "$OUT4B" | grep -q "seat-trailer check skipped for dispatch #4 — context.json content unreadable"
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then
    echo "  ok (schema-3 proxy dispatch with a Garelier-Seat-less commit is refused by merge_land pre-submit before any merge_request submit; stripped commit_mode remains valid JSON and is still caught via model fallback; unresolvable checkout fails closed without --seat-trailer, proceeds with it; corrupted-{} content also fails closed and proceeds with an override)"
else
    echo "  FAIL: merge_land seat-trailer preflight smoke"; rm -rf "$ST" 2>/dev/null || true; exit 1
fi
rm -rf "$ST" 2>/dev/null || true
`,
);



// 28. dispatch preamble runtime marker smoke
S(
  "dispatch preamble runtime marker smoke (W-035)",
  `
PT="$(mktemp -d)"
(
    set -e
    cd "$PT"
    git init -q -b main .
    git -c user.email=ci@ci -c user.name=ci commit -q --allow-empty -m init
    git branch "garelier/main/tpm/studio"
    init_task_file "$PT"
    init_schema3_fixture "$PT" tpm 1 cs_ci
    commit_fixture_control "$PT"
    OUT="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/dispatch_prepare.ts" --project "$PT" --pm-id tpm --role worker --slug runtime-preamble --base "garelier/main/tpm/studio" --provider claude-code --model claude-test --effort high --work-id W-001 --control-session cs_ci --task-file "$PT/ci_smoke_task.md")"
    # W-114: echo WHICH assertion fails (a bare "FAIL: …smoke" is undiagnosable
    # from a remote CI log). Both greps were wrong on EVERY platform, unnoticed
    # because nobody runs the full ci.ts locally. (1) dispatch_prepare emits the
    # preamble as a JSON field (emitJsonLine -> JSON.stringify), so the marker's
    # inner quotes are escaped to \\" — the plain '{"runtime_ok"' pattern never
    # matched. Use a quote-agnostic BRE ('.*' spans the \\" escaping). (2) the
    # timeout-rerun rule was reworded from "do not immediately re-run" to the
    # recovery/rearm wording (dispatch_prepare.ts §Recovery).
    echo "$OUT" | grep -q 'GARELIER_RUNTIME_STATUS: {.*runtime_ok' || { echo "  FAIL check: runtime-status marker line absent from preamble" >&2; exit 1; }
    echo "$OUT" | grep -q 'may the SAME whole command be explicitly rearmed' || { echo "  FAIL check: timeout rearm-discipline line absent from preamble" >&2; exit 1; }
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then
    echo "  ok (runtime status marker + timeout rearm discipline)"
else
    echo "  FAIL: dispatch preamble runtime marker smoke"; rm -rf "$PT" 2>/dev/null || true; exit 1
fi
rm -rf "$PT" 2>/dev/null || true
`,
);

// 29. run_summarized smoke
S(
  "run_summarized smoke (W-043b, inbound output discipline)",
  `
RT="$(mktemp -d)"
(
    set -e
    OUT1="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --log-dir "$RT/logs" --slug ok -- echo "hello")"
    echo "$OUT1" | grep -q "exit=0"
    LOGF1="$(echo "$OUT1" | sed -n 's/.*log=//p')"
    [ -f "$LOGF1" ]
    grep -q "^hello$" "$LOGF1"
    STATUS1="$RT/status/ok.status"
    OUT1S="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --log-dir "$RT/logs" --slug status-ok --status-file "$STATUS1" -- echo "status hello")"
    echo "$OUT1S" | grep -q "exit=0"
    grep -q '^START=' "$STATUS1"
    grep -q '^CMD=echo status\\\\ hello ' "$STATUS1"
    grep -q '^LOG=' "$STATUS1"
    grep -q '^END=' "$STATUS1"
    grep -q '^EXIT=0$' "$STATUS1"
    set +e
    OUT2="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --log-dir "$RT/logs" --slug fail -- bash -c 'echo "error: boom" >&2; exit 3')"
    RC2=$?
    set -e
    [ "$RC2" -eq 3 ]
    echo "$OUT2" | grep -q "exit=3"
    echo "$OUT2" | grep -q "error: boom"
    FIXTURE="$RT/cargo_fixture.txt"
    {
        for i in $(seq 1 50); do echo "test t$i ... ok"; done
        echo "test t51 ... FAILED"
        echo "test result: FAILED. 50 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s"
    } > "$FIXTURE"
    OUT3="$(bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --log-dir "$RT/logs" --slug cargo-test -- cat "$FIXTURE")"
    echo "$OUT3" | grep -q "test result: FAILED"
    echo "$OUT3" | grep -q "t51 ... FAILED"
    ! bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --log-dir "$RT/logs" 2>/dev/null
    ! bun "$ROOT/skills/garelier-core/driver/src/scripts/run_summarized.ts" --bogus x 2>/dev/null
    # W-303: keep this inside the existing summary aggregate (definition +0).
    # Three append-only runs cover RED→GREEN and GREEN→RED with one fixed clock,
    # so uniqueness cannot accidentally rely on timestamp resolution.
    bun -e '
      import { appendFileSync, readFileSync } from "node:fs";
      import { runGate } from "./skills/garelier-core/driver/src/scripts/gate_runner.ts";
      const logPath = process.argv[1];
      const steps = [{ name: "summary", cmd: "scripts/quality/summary" }];
      const run = async (status, label, mode = {}) => runGate(
        { steps, cwd: process.cwd(), logPath, summaryPatterns: ["^SUMMARY "], timeoutMs: 60_000 },
        {
          now: () => "2026-07-31T01:02:03.000Z",
          acquire: () => {
            if (mode.acquireFail) {
              appendFileSync(logPath, "ACQUIRE_ATTEMPT_FAILED scope=" + label + "\\n");
              throw new Error("acquire exploded");
            }
            return mode.locked ? "slot-0" : "DISABLED";
          },
          release: () => {
            if (mode.releaseFail) {
              appendFileSync(logPath, "RELEASE_ATTEMPT_FAILED scope=" + label + "\\n");
              throw new Error("release exploded");
            }
            appendFileSync(logPath, "RELEASE_SUCCEEDED scope=" + label + "\\n");
          },
          checkStep: () => ({ ok: true, reason: "" }),
          runStep: (_cmd, _cwd, writeOutput) => {
            if (mode.concurrent) appendFileSync(logPath, "SUMMARY status=FAILED scope=concurrent-writer\\n");
            writeOutput("SUMMARY status=" + status + " scope=" + label + "\\n");
            return status === "ok" ? 0 : 1;
          },
        },
      );
      appendFileSync(logPath, "PARTIAL CRASH WITHOUT NEWLINE");
      const red1 = await run("FAILED", "red-before-green", { concurrent: true });
      const green = await run("ok", "green-current", { locked: true });
      const red2 = await run("FAILED", "red-current");
      const acquireRed = await run("ok", "acquire-failure", { acquireFail: true });
      const releaseRed = await run("ok", "release-failure", { locked: true, releaseFail: true });
      const runs = [red1, green, red2, acquireRed, releaseRed];
      if (new Set(runs.map((item) => item.runId)).size !== runs.length) throw new Error("run ids are not unique");
      if (runs.some((item) => !item.startedAt)) throw new Error("startedAt missing from run result");
      if (green.summaryLines.join("\\n") !== "SUMMARY status=ok scope=green-current") throw new Error("GREEN summary leaked another run: " + JSON.stringify(green.summaryLines));
      if (red2.summaryLines.join("\\n") !== "SUMMARY status=FAILED scope=red-current") throw new Error("RED summary leaked another run: " + JSON.stringify(red2.summaryLines));
      if (red1.summaryLines.join("\\n") !== "SUMMARY status=FAILED scope=red-before-green") throw new Error("concurrent append entered current slice: " + JSON.stringify(red1.summaryLines));
      if (acquireRed.status !== "RED") throw new Error("acquire failure was not RED");
      if (releaseRed.status !== "RED") throw new Error("release failure was not RED");
      const log = readFileSync(logPath);
      for (const item of runs) {
        const marker = "GATE_START run_id=" + item.runId + " started_at=" + item.startedAt;
        const markerOffset = log.indexOf(Buffer.from(marker));
        if (markerOffset < 0) throw new Error("append-only run boundary missing: " + marker);
        if (markerOffset > 0 && log[markerOffset - 1] !== 0x0a) throw new Error("run boundary did not recover a partial prior line");
        const bodyStart = log.indexOf(Buffer.from("STEP-PLANNED summary: scripts/quality/summary\\n"), markerOffset);
        const endMarker = Buffer.from("GATE_END run_id=" + item.runId + "\\n");
        const bodyEnd = log.indexOf(endMarker, bodyStart) + endMarker.byteLength;
        if (bodyStart < 0 || bodyEnd - bodyStart !== item.sliceEndOffset) throw new Error("run-owned end offset mismatch: " + item.runId);
      }
      const text = log.toString("utf8");
      const acquireStart = text.indexOf("GATE_START run_id=" + acquireRed.runId);
      const acquireAttempt = text.indexOf("ACQUIRE_ATTEMPT_FAILED scope=acquire-failure", acquireStart);
      const acquireFailure = text.indexOf("ACQUIRE_FAILED acquire exploded", acquireAttempt);
      if (!(acquireStart < acquireAttempt && acquireAttempt < acquireFailure)) throw new Error("acquire failure lost pre-acquire attribution");
      const greenRelease = text.indexOf("RELEASE_SUCCEEDED scope=green-current");
      const greenReleased = text.indexOf("LOCK_RELEASED", greenRelease);
      const greenResult = text.indexOf("RESULT GREEN", greenReleased);
      if (!(greenRelease < greenReleased && greenReleased < greenResult)) throw new Error("GREEN preceded successful release");
      const releaseAttempt = text.indexOf("RELEASE_ATTEMPT_FAILED scope=release-failure");
      const releaseFailure = text.indexOf("LOCK_RELEASE_FAILED release exploded", releaseAttempt);
      const releaseResult = text.indexOf("RESULT RED", releaseFailure);
      const releaseEnd = text.indexOf("GATE_END run_id=" + releaseRed.runId, releaseResult);
      if (!(releaseAttempt < releaseFailure && releaseFailure < releaseResult && releaseResult < releaseEnd)) throw new Error("release failure ordering is not durable RED");
      if (text.slice(releaseAttempt, releaseEnd).includes("LOCK_RELEASED") || text.slice(releaseAttempt, releaseEnd).includes("RESULT GREEN")) throw new Error("release failure claimed release/GREEN");
    ' "$RT/gate-runner.log"
    ! grep -q 'readFileSync(opts.logPath' "$ROOT/skills/garelier-core/driver/src/scripts/gate_runner.ts"
    # Recurrence guard: an "if ( set -e ... ); then" condition subshell silently
    # disables errexit, so only the LAST command decided the verdict and every
    # earlier oracle failure was swallowed. Stand the subshell alone and branch
    # on its captured status instead.
    ! grep -qE '^if [(]$' "$ROOT/skills/garelier-core/driver/src/scripts/ci.ts"
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then
    echo "  ok (success/failure/cargo-test-style + run-scoped gate summarized; full output kept in append-only logs; bad args rejected)"
else
    echo "  FAIL: run_summarized smoke"; rm -rf "$RT" 2>/dev/null || true; exit 1
fi
rm -rf "$RT" 2>/dev/null || true
`,
);

// 30. Status Web smoke
S(
  "Status Web smoke",
  `
(
    set -e
    STMP="$(mktemp -d)"
    cleanup_status_smoke() {
        if [ -f "$STMP/__garelier/$WS/runtime/status_web/status_web.json" ]; then
            GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \\
                bun "$ROOT/skills/garelier-core/driver/src/scripts/stop_status.ts" \\
                --project "$STMP" >/dev/null 2>&1 || true
        fi
        # stop_status waits for shutdown, but Windows can retain the server cwd
        # for a short interval after process exit. Retry the disposable cleanup.
        cd / 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            rm -rf "$STMP" 2>/dev/null && break
            sleep 0.2
        done
        [ ! -e "$STMP" ]
    }
    trap cleanup_status_smoke EXIT
    git -C "$STMP" init -q -b main
    git -C "$STMP" config user.email ci@ci
    git -C "$STMP" config user.name ci
    printf '# status\\n' > "$STMP/README.md"
    git -C "$STMP" add README.md
    git -C "$STMP" commit -qm init
    mkdir -p "$STMP/__garelier"
    export GARELIER_CORE_TEMPLATES_DIR="$ROOT/skills/garelier-core/templates"
    ( cd "$STMP/__garelier" && bun "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts" \\
        --mode fresh --skip-confirm --pm-id _workshop --project-name Status \\
        --target main --stack typescript --agents-policy minimal >/dev/null )
    cd "$STMP"
    set +e
    GARELIER_ROLE_SEAT=1 GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \\
        bun "$ROOT/skills/garelier-core/driver/src/scripts/start_status.ts" \\
        --project "$STMP" --loopback >"$STMP/role-status.out" 2>"$STMP/role-status.err"
    ROLE_STATUS_RC=$?
    set -e
    [ "$ROLE_STATUS_RC" -eq 3 ]
    grep -q "ENVIRONMENT BLOCKED" "$STMP/role-status.err"
    [ ! -f "$STMP/__garelier/$WS/runtime/status_web/status_web.json" ]
    GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \\
        bun "$ROOT/skills/garelier-core/driver/src/scripts/start_status.ts" \\
        --project "$STMP" --loopback >/dev/null
    STATUS_PIDFILE="$STMP/__garelier/$WS/runtime/status_web/status_web.json"
    STATUS_URL="$(bun -e 'const x=JSON.parse(await Bun.file(process.argv[1]).text()); if(x.owner!=="operator"||x.provenance!=="operator-owned") process.exit(1); console.log(x.url.replace(/\\/$/, ""))' "$STATUS_PIDFILE")"
    bun -e 'const u=process.argv[1]; const h=await fetch(u+"/api/health").then(r=>r.json()); const c=await fetch(u+"/api/control").then(r=>r.json()); if(!h.ok||!c.ok) process.exit(1)' "$STATUS_URL"
    GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \\
        bun "$ROOT/skills/garelier-core/driver/src/scripts/status_web_status.ts" \\
        --project "$STMP" >/dev/null
    GARELIER_CORE_DIR="$ROOT/skills/garelier-core" \\
        bun "$ROOT/skills/garelier-core/driver/src/scripts/stop_status.ts" \\
        --project "$STMP" >/dev/null
)
ORACLE_RC=$?
if [ "$ORACLE_RC" -eq 0 ]; then
    echo "  ok (role start refused; operator start / provenance / status / API / stop)"
else
    echo "  FAIL"; exit 1
fi
`,
);

// 31. knowledge provenance/rights safety lint
S(
  "knowledge provenance/rights safety lint",
  `
if bun "$ROOT/scripts/check_knowledge_safety.ts"; then
    echo "  ok"
else
    echo "  FAIL"; exit 1
fi
`,
);


// 32. role knowledge trees lint
S(
  "role knowledge trees lint (DEC-029)",
  `
kt=0
for forbidden in garelier-security-guide garelier-debugging garelier-code-review \\
                 garelier-quality-guide garelier-user-review garelier-system-thinking; do
    if [ -d "$ROOT/skills/$forbidden" ]; then
        echo "  FAIL: forbidden knowledge-as-Skill directory exists: skills/$forbidden (use the knowledge trees under __garelier/<pm_id>/knowledge/ instead)"; kt=1
    fi
done
for tree in engineering quality review system; do
    if [ ! -f "$ROOT/skills/garelier-librarian/templates/$tree/index.md" ]; then
        echo "  FAIL: missing Librarian template index: skills/garelier-librarian/templates/$tree/index.md"; kt=1
    fi
done
if [ ! -f "$ROOT/skills/garelier-librarian/templates/security/index.md" ]; then
    echo "  FAIL: missing security tree index: skills/garelier-librarian/templates/security/index.md"; kt=1
fi
for tree in engineering quality review system; do
    if ! grep -qF "$tree/index.md" "$ROOT/docs/canonical_index.md"; then
        echo "  FAIL: docs/canonical_index.md does not list the $tree/index.md knowledge tree"; kt=1
    fi
done
RI="$ROOT/skills/garelier-librarian/templates/role_index.toml"
if [ ! -f "$RI" ]; then
    echo "  FAIL: missing role index: skills/garelier-librarian/templates/role_index.toml (DEC-048)"; kt=1
else
    for ref in $(grep -oE '"[A-Za-z0-9_/.-]+\\.md"' "$RI" 2>/dev/null | tr -d '"' | sed -E 's#^__garelier/[^/]+/knowledge/##' | sort -u); do
        tpl="$ROOT/skills/garelier-librarian/templates/$ref"
        if [ ! -f "$tpl" ]; then
            echo "  FAIL: role_index.toml names a knowledge doc with no template: $ref"; kt=1
        fi
    done
fi
if [ ! -f "$ROOT/skills/garelier-librarian/templates/knowledge_query.md" ]; then
    echo "  FAIL: missing knowledge_query template: skills/garelier-librarian/templates/knowledge_query.md (DEC-048)"; kt=1
fi
if [ ! -f "$ROOT/skills/garelier-librarian/templates/git_command_policy.toml" ]; then
    echo "  FAIL: missing git command policy: skills/garelier-librarian/templates/git_command_policy.toml (DEC-048)"; kt=1
fi
if [ "$kt" -eq 0 ]; then echo "  ok (no forbidden Skills; tree indexes present; canonical_index lists trees; role_index + git_command_policy present)"; else exit 1; fi
`,
);

// 33. knowledge doc reverse reachability lint
S(
  "knowledge doc reverse reachability lint (DEC-090, W-074)",
  `
krr=0
bun "$ROOT/scripts/check_knowledge_reachability.ts" || krr=1
if [ "$krr" -eq 0 ]; then echo "  ok"; else echo "  FAIL"; exit 1; fi
`,
);














// 47. version-drift check
S(
  "version-drift check (W-060, VERSION is the single source)",
  `
VD_V="$(tr -d '[:space:]' < "$ROOT/VERSION")"
vd=0
vd_check() {
    if [ -z "$2" ]; then
        echo "  FAIL: $1 — no version literal found (surface moved? update ci.ts W-060 list)"; vd=1
    elif [ "$2" != "$VD_V" ]; then
        echo "  FAIL: $1 — '$2' != VERSION '$VD_V'"; vd=1
    fi
}
for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
    vd_check "$f" "$(grep -oE '"version": *"[0-9]+\\.[0-9]+\\.[0-9]+"' "$ROOT/$f" 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | sort -u | tr '\\n' ' ' | sed 's/ $//')"
done
vd_check "README.md (license line)" "$(grep -oE 'Garelier v[0-9]+\\.[0-9]+\\.[0-9]+' "$ROOT/README.md" 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | sort -u | tr '\\n' ' ' | sed 's/ $//')"
vd_check "README.ja.md (license line)" "$(grep -oE 'Garelier v[0-9]+\\.[0-9]+\\.[0-9]+' "$ROOT/README.ja.md" 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | sort -u | tr '\\n' ' ' | sed 's/ $//')"
# W-731: the setup wizard and the doctor no longer CARRY a version — they read
# the VERSION authority through src/version.ts. A hand-bumped literal is what
# left them on an old version while VERSION moved on, turning the public CI RED
# on the export tree. So this surface is checked in the opposite direction from
# the ones above: assert the literal is ABSENT and the authority is still
# consumed, which makes drift impossible rather than merely detectable one
# release later.
# Held as an ARRAY, not a space-joined string: these are paths built from $ROOT,
# and an unquoted expansion word-splits a $ROOT containing a space into fragments
# and reports a spurious FAIL.
VD_TS_FILES=(
  "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard.ts"
  "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard/config_emit.ts"
  "$ROOT/skills/garelier-core/driver/src/scripts/setup_wizard/fresh.ts"
  "$ROOT/skills/garelier-core/driver/src/scripts/doctor.ts"
)
VD_TS_LITERAL="$(grep -hE 'WIZARD_VERSION = |garelier_version = |wizard_version = |EXPECTED_VERSION = |Garelier version: |Garelier Setup Wizard|initialize PM .*\\(v[0-9]' "\${VD_TS_FILES[@]}" 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | sort -u | tr '\\n' ' ' | sed 's/ $//')"
if [ -n "$VD_TS_LITERAL" ]; then
    echo "  FAIL: setup_wizard / doctor carry a hardcoded version literal ('$VD_TS_LITERAL'); read VERSION through src/version.ts instead (W-731)"; vd=1
fi
# CALLS the authority, not merely mentions it: a file that imports frameworkVersion
# and never invokes it would drift exactly as silently as a literal.
for vdf in "\${VD_TS_FILES[@]}"; do
    case "$vdf" in *setup_wizard.ts) continue ;; esac
    if ! grep -q 'frameworkVersion(' "$vdf" 2>/dev/null; then
        echo "  FAIL: $vdf no longer calls the VERSION authority (frameworkVersion()); that surface would drift silently (W-731)"; vd=1
    fi
done
# The authority must EXPORT the reader and name the VERSION file. Pinning an
# internal expression instead would break on a correct refactor of version.ts.
if ! grep -q 'export function frameworkVersion' "$ROOT/skills/garelier-core/driver/src/version.ts" 2>/dev/null \\
  || ! grep -q '"VERSION"' "$ROOT/skills/garelier-core/driver/src/version.ts" 2>/dev/null; then
    echo "  FAIL: src/version.ts no longer exports a reader of the VERSION file; the single version authority is gone (W-731)"; vd=1
fi
if [ "$vd" -eq 0 ]; then
    echo "  ok (plugin.json / marketplace.json / README / README.ja all = $VD_V; setup_wizard + doctor derive it from VERSION)"
else
    echo "  FAIL: version drift — bump every surface with the release (W-060)"; exit 1
fi
`,
);

// ── run ───────────────────────────────────────────────────────────────────────
const uncoveredSteps: string[] = [];
for (const s of steps) {
  step(s.name);
  const outcome: StepOutcome = s.fn ? ((await s.fn()) ? "ok" : "fail") : await sh(s.body!);
  if (outcome === "fail") fail = 1;
  else if (outcome === "uncovered") uncoveredSteps.push(s.name);
}

out("");
// An UNCOVERED dimension is disclosed by name, never folded into the pass
// count. The exit code still tracks FAIL alone: a dimension nobody could
// measure here is not evidence of a defect, and silently failing on it would
// push the next author toward a skip flag. The register carries it forward.
for (const name of uncoveredSteps) out(`CI: UNCOVERED ${name}`);
out(`${fail === 0 ? "CI: all checks passed." : "CI: FAILURES above."} UNCOVERED ${uncoveredSteps.length}.`);
process.exit(fail);
