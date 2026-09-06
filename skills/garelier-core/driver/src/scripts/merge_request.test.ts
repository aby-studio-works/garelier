import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";
import {
  acknowledgeInstructionDelivery,
  acknowledgeRoleLaunch,
  appendRoleInstruction,
  branchExecutionIdentity,
  dispatchExecutionIdentity,
  issueRoleAuthorization,
  roleBindingPaths,
  type RoleExecutionIdentity,
  type RoleKind,
} from "../dispatch/role_binding.ts";
import { resolveRoleKnowledgeBinding } from "../dispatch/knowledge_binding.ts";
import { canonicalJson } from "../control/serialization.ts";
import {
  DISPATCH_PREPARE_FLAGS,
  MERGE_REQUEST_FLAGS,
  OTHER_TOOL_FLAG_OWNERS,
} from "./cli_flag_ownership.ts";
import { assertProviderTransportCompatible } from "../dispatch/role_binding.ts";
import { runCli as gateRunner } from "./gate_runner.ts";

const MERGE_REQUEST = join(import.meta.dir, "merge_request.ts");
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A minimal project with real merge refs: requests bind the exact workbench
 * tip, so a ref-less fixture would bypass the production integrity contract. */
function makeProject(pm = "tpm"): string {
  const root = mkdtempSync(join(tmpdir(), "merge-request-"));
  roots.push(root);
  const pmDir = join(root, "__garelier", pm, "_crew", "pm");
  mkdirSync(pmDir, { recursive: true });
  writeFileSync(join(pmDir, "setup_config.toml"), [
    "[project]",
    'name = "merge request fixture"',
    "",
    "[branches]",
    'target = "main"',
    'target_slug = "main"',
    `integration = "garelier/main/${pm}/studio"`,
    "",
    "[quality_gate]",
    'stack = "custom"',
    'commands = ["project full gate"]',
    "timeout_minutes_per_cmd = 37",
    "",
  ].join("\n"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "CI");
  writeFileSync(join(root, "fixture.txt"), "fixture\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  git("branch", `garelier/main/${pm}/studio`);
  git("branch", `garelier/main/${pm}/workbench/#1/w180`);
  git("branch", `garelier/main/${pm}/workbench/#2/held`);
  git("branch", `garelier/main/${pm}/satchel/#1/w206`);
  const dispatch = join(root, "__garelier", pm, "_crew/dispatch1");
  mkdirSync(dispatch, { recursive: true });
  writeFileSync(join(dispatch, "context.json"), JSON.stringify({ task: { id: 1, branch: `garelier/main/${pm}/workbench/#1/w180` } }));
  writeFileSync(join(dispatch, "control_binding.json"), JSON.stringify({ dispatch_id: "1" }));
  const tip = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { windowsHide: true, stdout: "pipe" }).stdout.toString().trim();
  const bind = (key: string, role: RoleKind, identity: RoleExecutionIdentity) => {
    const sourceDir = join(root, "binding-fixtures", key);
    mkdirSync(sourceDir, { recursive: true });
    const assignment = join(sourceDir, "assignment.md");
    const prompt = join(sourceDir, "prompt.md");
    const report = join(sourceDir, "report.md");
    const ledger = key === "w180" ? join(dispatch, "instructions.md") : join(sourceDir, "instructions.md");
    const ledgerTables = [[
      "[[instruction]]", "id = 'I1'", `message = '${key} initial authority'`,
      "checked = true", "consumed = 'aggregate'",
    ]];
    const renderLedger = (tables: string[][]): string => [
      "+++", "[ledger]", "kind = 'role_instruction_ledger_v1'",
      ...tables.flatMap((table) => ["", ...table]),
      "+++", "",
    ].join("\n");
    const initialLedger = renderLedger(ledgerTables);
    writeFileSync(assignment, `# ${key} assignment\n`);
    writeFileSync(prompt, `Execute ${key}.\n`);
    writeFileSync(report, `+++\n[gate]\nkind = 'role_report_v1'\n+++\n\n# ${key} report\n`);
    writeFileSync(ledger, initialLedger);
    // The authority source must exist at HEAD: issueRoleAuthorization reads it
    // with `git show HEAD:<rel>` and refuses an uncommitted one. The fixture's
    // only commit happens ABOVE, before these files are written, so every test
    // in this file failed with "item authority source is not committed at HEAD"
    // (measured RED on studio too, not introduced here). Commit the binding
    // fixture where it is created. The branches keep pointing at `tip`, so the
    // integration base_sha below stays the one they were cut from.
    git("add", `binding-fixtures/${key}`);
    git("commit", "-q", "-m", `${key} binding fixture`);
    const authorization = issueRoleAuthorization({
      project_root: root, pm_id: pm, identity, role,
      carabiner: role === "artisan" ? "end_to_end_creation" : "implementation",
      item: { work_id: key, revision: "1", session_id: `cs-${key}`, authority_path: assignment },
      assignment_path: assignment, prompt_path: prompt,
      initial_instructions_path: ledger,
      routing: { provider: "attended-agent", model: "test-model", effort: "medium", source: "aggregate" },
      lens: { ref: null, source: "none", registry_path: null, pack_path: null },
      knowledge: resolveRoleKnowledgeBinding({ projectRoot: root, pmId: pm, role, required: [] }),
      integration: { ref: `garelier/main/${pm}/studio`, base_sha: tip },
      issuer: { role: "dock", id: "aggregate" },
    });
    acknowledgeRoleLaunch({
      project_root: root, pm_id: pm, identity, generation: authorization.core.generation,
      expect_digest: authorization.core_digest, transport: "attended-agent", provider_session_id: `agent-${key}`,
      success_evidence: "aggregate launch", writer: { role: "attended-parent", id: "aggregate" },
    });
    const instruction = appendRoleInstruction({
      project_root: root, pm_id: pm, identity, generation: authorization.core.generation,
      expect_digest: authorization.core_digest, message: `Complete ${key}.`,
      issuer: { role: "coordinator", id: "aggregate" },
    });
    acknowledgeInstructionDelivery({
      project_root: root, pm_id: pm, identity, generation: authorization.core.generation,
      expect_digest: authorization.core_digest, sequence: instruction.sequence,
      provider_session_id: `agent-${key}`, evidence: "aggregate delivery",
      writer: { role: "attended-parent", id: "aggregate" },
    });
    writeFileSync(ledger, renderLedger([...ledgerTables, [
      "[[instruction]]", `id = '${instruction.ledger_token}'`,
      `message = '${instruction.message.replace(/\s+/g, " ").trim()}'`,
      `digest = '${instruction.message_digest.slice(0, 12)}'`,
      "checked = true", "consumed = 'aggregate'",
    ]]));
  };
  bind("w180", "worker", dispatchExecutionIdentity(1));
  bind("held", "worker", branchExecutionIdentity("worker", `garelier/main/${pm}/workbench/#2/held`));
  bind("w206", "artisan", branchExecutionIdentity("artisan", `garelier/main/${pm}/satchel/#1/w206`));
  return root;
}

const roleReport = (project: string, key: string): string => join(project, "binding-fixtures", key, "report.md");

/** Extract the first quoted token after `bun ` — the waiter script path. */
function waiterScriptPath(waiterCmd: string): string | undefined {
  const m = /^bun\s+"([^"]+)"/.exec(waiterCmd);
  return m?.[1];
}

// W-180: the printed waiter_cmd pointed at `garelier-core/scripts/gate_result_waiter.ts`
// (a `../../../scripts` resolve) but the file lives in THIS directory
// (driver/src/scripts) — a PM running the command verbatim hit `Module not found`
// and the merge-completion push never armed. The waiter_cmd must reference the real,
// existing script so verbatim execution resolves.
test("W-180: merge_request --no-poll emits a waiter_cmd whose script path exists (verbatim-executable)", () => {
  const project = makeProject();
  const branch = "garelier/main/tpm/workbench/#1/w180";
  const reportPath = roleReport(project, "w180");
  const ledgerPath = join(project, "__garelier", "tpm", "_crew/dispatch1", "instructions.md");
  const bindingPaths = roleBindingPaths(project, "tpm", dispatchExecutionIdentity(1), 1);
  const submit = () => Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", branch, "--report", reportPath, "--guardian", "PASS", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  expect(existsSync(bindingPaths.close)).toBe(false);
  const result = submit();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(existsSync(bindingPaths.close)).toBe(true);
  const exactClose = readFileSync(bindingPaths.close, "utf8");
  const close = JSON.parse(exactClose);
  expect(close.writer.role).toBe("admission-controller");
  expect(close.candidate_sha).toMatch(/^[0-9a-f]{40}$/);
  const line = result.stdout.toString().trim().split(/\r?\n/).findLast((v) => v.startsWith("{"));
  expect(line).toBeTruthy();
  const parsed = JSON.parse(line!);
  const script = waiterScriptPath(parsed.waiter_cmd);
  expect(script).toBeTruthy();
  // The path a PM would run verbatim resolves to a real file.
  expect(existsSync(script!)).toBe(true);
  // Regression guard against the stale `../../../scripts` location.
  expect(script!.replace(/\\/g, "/")).toContain("driver/src/scripts/gate_result_waiter.ts");
  const request = JSON.parse(readFileSync(parsed.request_file, "utf8"));
  expect(request.request_id).toMatch(/^\d{8}-\d{6}-[0-9a-f-]{36}-1-w180$/);
  expect(request.dispatch_id).toBe("1");
  expect(request.dispatch_container.replace(/\\/g, "/")).toBe(join(project, "__garelier", "tpm", "_crew/dispatch1").replace(/\\/g, "/"));
  expect(request.aftercare_binding).toBe("dispatch");
  expect(request.quality_gate_timeout_minutes_per_cmd).toBe(37);
  expect(request.role_binding).toMatchObject({ generation: 1, binding_digest: close.binding_digest });

  const repeated = submit();
  expect(repeated.exitCode, repeated.stderr.toString()).toBe(0);
  expect(readFileSync(bindingPaths.close, "utf8")).toBe(exactClose);

  const expectAdmissionRefusal = (needle: string) => {
    const refused = submit();
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.toString()).toContain(needle);
  };
  const exactReport = readFileSync(reportPath, "utf8");
  writeFileSync(reportPath, "# forged report\n");
  expectAdmissionRefusal("report hash");
  writeFileSync(reportPath, exactReport);

  const exactLedger = readFileSync(ledgerPath, "utf8");
  // A well-formed but wrong digest: the ledger still decodes, so admission
  // refuses on the digest mismatch rather than on the artifact's grammar.
  writeFileSync(ledgerPath, exactLedger.replace(/digest = '[0-9a-f]{12}'/, "digest = 'ffffffffffff'"));
  expectAdmissionRefusal("role ledger");
  writeFileSync(ledgerPath, exactLedger);

  const instructionPath = join(bindingPaths.instructions, "000001.json");
  const exactInstruction = readFileSync(instructionPath, "utf8");
  const forgedInstruction = JSON.parse(exactInstruction);
  forgedInstruction.message = "forged instruction";
  writeFileSync(instructionPath, canonicalJson(forgedInstruction));
  expectAdmissionRefusal("forged instruction");
  writeFileSync(instructionPath, exactInstruction);

  for (const [field, value, needle] of [["generation", 2, "mismatched"], ["writer", { role: "worker", id: "forged" }, "self-issued"]] as const) {
    const forgedClose = JSON.parse(exactClose);
    forgedClose[field] = value;
    writeFileSync(bindingPaths.close, canonicalJson(forgedClose));
    expectAdmissionRefusal(needle);
    writeFileSync(bindingPaths.close, exactClose);
  }

  const oldTip = close.candidate_sha as string;
  const advanced = Bun.spawnSync(["git", "-C", project, "commit", "-q", "--allow-empty", "-m", "advance candidate"]);
  expect(advanced.exitCode).toBe(0);
  const move = Bun.spawnSync(["git", "-C", project, "branch", "-f", branch, "HEAD"]);
  expect(move.exitCode).toBe(0);
  expectAdmissionRefusal("candidate SHA");
  const restore = Bun.spawnSync(["git", "-C", project, "branch", "-f", branch, oldTip]);
  expect(restore.exitCode).toBe(0);

  const whitespaceCli = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "   ",
      "--branch", "garelier/main/tpm/workbench/#2/held", "--aftercare-binding", "branch_only", "--guardian", "PASS", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  expect(whitespaceCli.exitCode).toBe(2);
  expect(whitespaceCli.stderr.toString()).toContain("no quality_gate_commands");

  const setup = join(project, "__garelier", "tpm", "_crew", "pm", "setup_config.toml");
  writeFileSync(setup, `${readFileSync(setup, "utf8")}\n[merge_gate]\nmerge_gate_commands = ["   "]\n`);
  const whitespaceConfig = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm",
      "--branch", "garelier/main/tpm/workbench/#2/held", "--aftercare-binding", "branch_only", "--guardian", "PASS", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  expect(whitespaceConfig.exitCode).toBe(2);
  expect(whitespaceConfig.stderr.toString()).toContain("no quality_gate_commands");

  const held = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", "garelier/main/tpm/workbench/#2/held", "--report", roleReport(project, "held"), "--aftercare-binding", "branch_only", "--guardian", "PASS", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  expect(held.exitCode, held.stderr.toString()).toBe(0);
  const heldRequest = JSON.parse(readFileSync(JSON.parse(held.stdout.toString().trim()).request_file, "utf8"));
  expect(heldRequest.aftercare_binding).toBe("branch_only");
  expect(heldRequest.dispatch_id).toBeNull();
  expect(heldRequest.dispatch_container).toBeNull();
  expect(heldRequest.request_id).not.toBe(request.request_id);

  const discarded = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", "garelier/main/tpm/workbench/#1/w180", "--aftercare-binding", "branch_only", "--guardian", "PASS", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  expect(discarded.exitCode).toBe(2);
  expect(discarded.stderr.toString()).toContain("cannot discard a live dispatch/container binding");

  writeFileSync(setup, readFileSync(setup, "utf8").replace("timeout_minutes_per_cmd = 37", "timeout_minutes_per_cmd = 0"));
  const invalidTimeout = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", "garelier/main/tpm/workbench/#2/held", "--aftercare-binding", "branch_only", "--guardian", "PASS", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  expect(invalidTimeout.exitCode).toBe(2);
  expect(invalidTimeout.stderr.toString()).toContain("timeout must be a positive integer number of minutes");
}, 30_000);

// The submit-time assert fails fast if the script is ever relocated, instead of
// silently emitting a dead waiter_cmd. We prove it points at the real sibling.
test("W-180: the emitted waiter script is a real sibling of merge_request.ts", () => {
  const expected = join(import.meta.dir, "gate_result_waiter.ts");
  expect(existsSync(expected)).toBe(true);
});

test("W-206: artisan route and expected studio SHA are persisted in the request", () => {
  const project = makeProject();
  const sha = "a".repeat(40);
  const result = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", "garelier/main/tpm/satchel/#1/w206", "--guardian", "PASS",
      "--report", roleReport(project, "w206"), "--execution-route", "artisan", "--expected-studio-sha", sha, "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(result.stdout.toString().trim());
  const request = JSON.parse(readFileSync(out.request_file, "utf8"));
  expect(request.execution_route).toBe("artisan");
  expect(request.expected_studio_sha).toBe(sha);
  expect(request.aftercare_binding).toBe("branch_only");
}, 30_000);

test("W-206: malformed retired-route request fields fail before writing", () => {
  const project = makeProject();
  const result = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", "b", "--guardian", "PASS", "--execution-route", "fixed", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("--execution-route must be dock or artisan");

  const mismatch = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", "garelier/main/tpm/workbench/#1/w180", "--dispatch-id", "2", "--guardian", "PASS", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  expect(mismatch.exitCode).toBe(2);
  expect(mismatch.stderr.toString()).toContain("does not match branch dispatch identity");

  for (const protectedOrArbitrary of ["main", "garelier/main/tpm/studio"]) {
    const rejected = Bun.spawnSync(
      ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
        "--branch", protectedOrArbitrary, "--aftercare-binding", "branch_only", "--guardian", "PASS", "--no-poll"],
      { windowsHide: true, stdout: "pipe", stderr: "pipe" },
    );
    expect(rejected.exitCode).toBe(2);
    expect(rejected.stderr.toString()).toContain("role branch");
  }

  const contextPath = join(project, "__garelier", "tpm", "_crew/dispatch1", "context.json");
  writeFileSync(contextPath, JSON.stringify({ task: { id: 1, branch: "garelier/main/tpm/workbench/#1/wrong" } }));
  const contextMismatch = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", "garelier/main/tpm/workbench/#1/w180", "--guardian", "PASS", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  expect(contextMismatch.exitCode).toBe(2);
  expect(contextMismatch.stderr.toString()).toContain("context task id/branch");

  writeFileSync(contextPath, JSON.stringify({ task: { id: 1, branch: "garelier/main/tpm/workbench/#1/w180" } }));
  writeFileSync(join(project, "__garelier", "tpm", "_crew/dispatch1", "control_binding.json"), JSON.stringify({ dispatch_id: "2" }));
  const bindingMismatch = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", "garelier/main/tpm/workbench/#1/w180", "--guardian", "PASS", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  expect(bindingMismatch.exitCode).toBe(2);
  expect(bindingMismatch.stderr.toString()).toContain("control binding dispatch_id");
}, 30_000);

test("W-206: artisan route fails closed without expected studio SHA", () => {
  const project = makeProject();
  const result = Bun.spawnSync(
    ["bun", MERGE_REQUEST, "--project", project, "--pm-id", "tpm", "--quality-gate", "bun test",
      "--branch", "garelier/main/tpm/satchel/#1/w206", "--guardian", "PASS",
      "--execution-route", "artisan", "--no-poll"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("artisan requires --expected-studio-sha");
}, 30_000);

// ── W-622 (blueprint §2.1) — a delegated flag must be accepted by the delegate ──
//
// merge_land forwards every argument it does not recognize to merge_request, and
// its banner promises "…any other merge_request.ts flag…". It could not check
// that promise: the accepted set on the other side existed only as an English
// sentence inside a refusal message. `--rebind-authority` (a dispatch_prepare
// flag) therefore passed merge_land, was forwarded, and died one process later
// as `merge_request: unknown arg` — a message naming the wrong tool.
//
// The inventories are now data, and the parsers are checked against them in BOTH
// directions. G-2's actual requirement is set equality, not "the list looks right".

/** The `--flags` a script's argv switch really accepts, read out of its source.
 * Derived from the executable authority (the `case` labels), never restated, so
 * a flag added to a parser without being listed turns these RED. */
function parserFlags(file: string): string[] {
  const source = readFileSync(join(import.meta.dir, file), "utf8");
  const start = source.indexOf("for (let i = 0; i < argv.length;");
  expect(start).toBeGreaterThan(-1);
  // Stop at the parser's own refusal branch; later `case "--x"` labels in the
  // file belong to unrelated switches and are not part of the argv surface.
  const end = source.indexOf("unknown arg", start);
  expect(end).toBeGreaterThan(start);
  const flags = new Set(
    Array.from(source.slice(start, end).matchAll(/case\s+"(--[a-z][a-z0-9-]*)"/g), (m) => m[1]!),
  );
  // `--help` is handled by every entrypoint and never crosses a delegation
  // boundary, so it is outside the forwarded surface these inventories describe.
  flags.delete("--help");
  return [...flags].sort();
}

test("W-622: merge_request's flag inventory and its parser are the same set, both directions", () => {
  expect(parserFlags("merge_request.ts")).toEqual([...MERGE_REQUEST_FLAGS].sort());
  // Negative oracle: an inventory that merely contains the parser's flags would
  // also satisfy a one-directional check.
  expect(parserFlags("merge_request.ts")).not.toEqual([...MERGE_REQUEST_FLAGS, "--rebind-authority"].sort());
});

/** dispatch_prepare selects a MODE from these before its argv switch runs
 * (`argv.includes(...)` at the top of main), so they are accepted without ever
 * appearing as a `case` label. Named here rather than silently tolerated: the
 * assertions below prove each really is handled, so this list cannot be used to
 * excuse a flag that is merely listed and never read. */
const DISPATCH_PREPARE_MODE_SELECTORS = ["--attended-seat", "--ack-launch"] as const;

test("W-622: dispatch_prepare's flag inventory and its parser are the same set, both directions", () => {
  const fromSwitch = parserFlags("dispatch_prepare.ts");
  const inventory = [...DISPATCH_PREPARE_FLAGS].sort();
  expect([...fromSwitch, ...DISPATCH_PREPARE_MODE_SELECTORS].sort()).toEqual(inventory);
  // The mode selectors are accounted for, not waved through: each is dispatched
  // on before the switch, in this file.
  const source = readFileSync(join(import.meta.dir, "dispatch_prepare.ts"), "utf8");
  for (const selector of DISPATCH_PREPARE_MODE_SELECTORS) {
    expect(source).toContain(`argv.includes("${selector}")`);
  }
  // Negative oracle: one flag more on either side must break the equality.
  expect([...fromSwitch, ...DISPATCH_PREPARE_MODE_SELECTORS, "--no-poll"].sort()).not.toEqual(inventory);
  expect([...fromSwitch, ...DISPATCH_PREPARE_MODE_SELECTORS].sort()).not.toEqual([...inventory, "--no-poll"].sort());
});

test("W-622: merge_land refuses a flag its delegate cannot accept, naming the owning tool", () => {
  const root = makeProject();
  // R-2's concrete target: `--rebind-authority` through merge_land. It used to be
  // forwarded and rejected by merge_request; it is now refused HERE, by the tool
  // that was actually asked, with the owner named.
  const refused = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "merge_land.ts"),
      "--project", root, "--pm-id", "pm1", "--branch", "garelier/main/pm1/workbench/#1/x",
      "--rebind-authority"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  const stderr = refused.stderr.toString();
  expect(refused.exitCode).toBe(2);
  expect(stderr).toContain("not a merge_request flag: --rebind-authority");
  expect(stderr).toContain("dispatch_prepare.ts");
  // G-3: an argv error never exits 0.
  expect(refused.exitCode).not.toBe(0);

  // R-4 — nothing that used to forward has stopped forwarding. Every flag the
  // delegate accepts still passes merge_land's check; only flags it never
  // accepted are stopped, one process earlier. Asserted over the WHOLE inventory
  // rather than a sample, so a narrowing anywhere in it is caught.
  for (const flag of MERGE_REQUEST_FLAGS) {
    expect(OTHER_TOOL_FLAG_OWNERS[flag]).toBeUndefined();
  }
  const forwarded = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "merge_land.ts"),
      "--project", root, "--pm-id", "pm1", "--branch", "garelier/main/pm1/workbench/#1/x",
      // --task and --high-stakes are merge_request-only: merge_land has no case
      // for either, so both reach the forwarding branch this check guards.
      "--task", "T-1", "--high-stakes"],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  expect(forwarded.stderr.toString()).not.toContain("not a merge_request flag");

  // ── W-692: merge_land's seat-trailer denominator ────────────────────────────
  //
  // The preflight delegates to lint_commits.ts --range --require-seat-trailer,
  // which used to demand a `Garelier-Seat:` trailer of EVERY commit on the
  // branch. A lane that cannot merge itself (W-077) is base-tracked by the Dock,
  // and a downstream project's dispatch #538 saw four such merges (`fc2b98924` / `77e161068` / `2f3cdbd98`
  // / `07aff85d7`) were each refused as a malformed proxy commit. The escape was
  // `--seat-trailer checked` on every land — an override that suppresses the
  // check it was supposed to prove.
  const seatRoot = makeProject("seatpm");
  const seatGit = (...args: string[]): string => {
    const result = Bun.spawnSync(["git", "-C", seatRoot, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  seatGit("config", "commit.gpgsign", "false");
  const seatBase = seatGit("rev-parse", "HEAD");
  const proxyMessage = (summary: string, seat: boolean): string => [
    `feat(core): ${summary} [#9]`, "",
    "Garelier: seatpm worker#9 W-009",
    ...(seat ? ["Garelier-Seat: codex gpt-test (proxy-commit via dock seat)"] : []),
  ].join("\n");
  seatGit("checkout", "-q", "-b", "seat-lane");
  seatGit("commit", "-q", "--allow-empty", "-m", proxyMessage("proxy commit", true));
  // Studio moves, and the Dock base-tracks it into the lane. Four of them, the
  // measured count, all with the project's `chore(base-track):` subject rather
  // than git's default `Merge branch ...` (which isExempt already skipped —
  // which is exactly why a subject-text rule would have looked like it worked).
  for (let index = 1; index <= 4; index++) {
    seatGit("checkout", "-q", "main");
    writeFileSync(join(seatRoot, `studio-${index}.txt`), `studio ${index}\n`);
    seatGit("add", ".");
    seatGit("commit", "-q", "-m", `chore(core): studio move ${index}`);
    seatGit("checkout", "-q", "seat-lane");
    seatGit("merge", "--no-ff", "-m", `chore(base-track): studio move ${index} を取り込み [#9]`, "main");
  }
  const lintSeat = (): { code: number; err: string } => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "..", "..", "scripts", "lint_commits.ts"),
        "--range", seatBase, seatRoot, "--require-seat-trailer"],
      { windowsHide: true, stdout: "pipe", stderr: "pipe" },
    );
    return { code: result.exitCode ?? 1, err: result.stderr.toString() };
  };
  // Every base-track merge carries two parents, so none of them is in the
  // denominator: the branch passes with no override at all.
  expect(seatGit("rev-list", "--first-parent", "--merges", "--count", `${seatBase}..HEAD`)).toBe("4");
  expect(lintSeat().code).toBe(0);

  // (b) detection is intact: strip the seat trailer from a real proxy commit —
  // a single-parent commit carrying the lane trailer — and it is still refused.
  seatGit("commit", "-q", "--allow-empty", "-m", proxyMessage("proxy commit without its seat", false));
  const stripped = lintSeat();
  expect(stripped.code).toBe(1);
  expect(stripped.err).toContain("missing/malformed `Garelier-Seat: codex <model> (proxy-commit via dock seat)` trailer");
  // And the refusal names ONLY that commit: the four merges did not become
  // findings, so the operator is not asked to reason about them.
  expect(stripped.err.split("\n").filter((line) => line.includes("[ERROR]"))).toHaveLength(1);
}, 60_000);

// ── W-620 — `--ack-launch`'s banner and its parser are the same set ──────────
//
// The banner's ack-launch stanza used to run on into the main dispatch form's
// options, so it advertised `--provider` as REQUIRED and about a dozen optional
// flags as accepted. parseAttendedAckLaunchArgs accepts exactly five and throws
// `unknown argument … for --ack-launch` on everything else. A PM passed the
// documented flags and was refused three times before reading the parser.
test("W-620: the --ack-launch banner and parseAttendedAckLaunchArgs agree in both directions", () => {
  const source = readFileSync(join(import.meta.dir, "dispatch_prepare.ts"), "utf8");

  const bannerStart = source.indexOf("ACK_LAUNCH_USAGE_BEGIN");
  const bannerEnd = source.indexOf("ACK_LAUNCH_USAGE_END");
  expect(bannerStart).toBeGreaterThan(-1);
  expect(bannerEnd).toBeGreaterThan(bannerStart);
  const banner = [...new Set(
    Array.from(source.slice(bannerStart, bannerEnd).matchAll(/--([a-z][a-z0-9-]*)/g), (m) => `--${m[1]!}`),
  )].sort();

  const parserStart = source.indexOf("function parseAttendedAckLaunchArgs");
  expect(parserStart).toBeGreaterThan(-1);
  const parserEnd = source.indexOf("for --ack-launch", parserStart);
  expect(parserEnd).toBeGreaterThan(parserStart);
  const parser = [...new Set(
    Array.from(source.slice(parserStart, parserEnd).matchAll(/case\s+"(--[a-z][a-z0-9-]*)"/g), (m) => m[1]!),
  )].sort();

  expect(banner).toEqual(parser);
  // The set is small enough to name, and naming it catches a change that keeps
  // the two sides equal by removing a flag from both.
  expect(parser).toEqual(["--ack-launch", "--agent-handle", "--dispatch-id", "--parent-id", "--pm-id", "--project"]);
  // Negative oracle in both directions: one flag more on either side must break.
  expect([...banner, "--provider"].sort()).not.toEqual(parser);
  expect(banner).not.toEqual([...parser, "--provider"].sort());

  // AL-2: the banner states WHEN ack-launch applies, not only what it takes.
  const stanza = source.slice(bannerEnd, bannerEnd + 1200);
  expect(stanza).toContain("attended-agent");
  expect(stanza).toContain("codex-cli");
});

// AL-3 — refusing is not enough when the answer is "there is nothing to do".
test("W-620: a codex seat is told ack-launch is unnecessary, not merely incompatible", () => {
  const refusal = (() => {
    try {
      assertProviderTransportCompatible("codex-cli", "attended-agent");
      return "";
    } catch (error) { return (error as Error).message; }
  })();
  expect(refusal).toContain("incompatible with bound provider codex-cli");
  expect(refusal).toContain("needs no ack-launch at all");
  expect(refusal).toContain("no ack_cmd to run");

  // R-4 / negative half: a genuinely wrong-but-applicable pairing keeps the
  // plain refusal. Adding the "not applicable" note to every mismatch would
  // satisfy the assertions above while making the new sentence meaningless.
  const stillPlain = (() => {
    try {
      assertProviderTransportCompatible("claude-code", "recorded-cli");
      return "";
    } catch (error) { return (error as Error).message; }
  })();
  expect(stillPlain).toContain("incompatible with bound provider claude-code");
  expect(stillPlain).not.toContain("needs no ack-launch");

  // …and the pairing a codex seat actually uses still passes.
  expect(() => assertProviderTransportCompatible("codex-cli", "codex-cli")).not.toThrow();
});

// ── W-620 (blueprint §2.2) — gate_runner's usage and its exit codes ──────────
test("W-620: gate_runner prints usage for --help and names every missing argument at once", async () => {
  // --help was not handled at all: asking for help produced the first
  // missing-argument complaint instead, and --steps' value shape (a FILE, not an
  // inline command) appeared nowhere until the file was already missing.
  const help = await gateRunner(["--help"]);
  expect(help.code).toBe(0);
  expect(help.message).toContain("--steps <file.toml|file.json>");
  expect(help.message).toContain("never an inline command");

  // L-4 shape: three omissions, one run. Disclosing them one at a time costs the
  // caller a round trip per argument.
  const missing = await gateRunner(["--cwd", "."]);
  expect(missing.code).toBe(2);
  for (const required of ["--project <control-root>", "--pm-id <id>", "--steps <file>"]) {
    expect(missing.message).toContain(required);
  }
  expect(missing.message).toContain("usage: gate_runner.ts");

  // A flag-shaped value means the value was omitted. Consuming it silently makes
  // the run proceed against a control root literally named "--pm-id".
  const swallowed = await gateRunner(["--project", "--pm-id", "x", "--cwd", ".", "--steps", "s.toml"]);
  expect(swallowed.code).toBe(2);
  expect(swallowed.message).toContain("--project <control-root>");

  // G-3, measured rather than assumed. The bundle recorded gate_runner as exiting
  // 0 on an argv error; it does not, and did not on studio either — that reading
  // came from `$?` after a pipeline, which reports the LAST command's status.
  // Keeping the real oracle here so the claim is checkable rather than recalled.
  for (const argv of [["--help"], ["--cwd", "."], []]) {
    const result = await gateRunner(argv);
    expect(typeof result.code).toBe("number");
    expect(result.code).toBe(argv[0] === "--help" ? 0 : 2);
  }

  // R-4: --steps still accepts exactly what it always did — a path — and still
  // reports a missing one the same way. Nothing about the accepted set moved.
  const stepsMissing = await gateRunner(["--project", ".", "--pm-id", "_workshop", "--cwd", ".", "--steps", "no-such-steps.toml"]);
  expect(stepsMissing.code).toBe(2);
  expect(stepsMissing.message).toContain("--steps file not found: no-such-steps.toml");
}, 60_000);
