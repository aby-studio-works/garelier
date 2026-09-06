import { rmSync } from "./guard/path_guard.ts";
// CI guard that keeps the Status Web's per-role assumptions (role_contracts.ts)
// from drifting out of sync with the canonical role skills + the driver. This is
// the systemic recurrence-prevention for the class of bug where the status
// snapshot quietly assumes a convention a role doesn't actually follow and the
// divergence only surfaces as a bogus warning a human has to catch:
//
//   • "guardian guardian-01: REPORTING without report.md" — Guardian writes
//     guardian_report.md, not report.md;
//   • a rate_limited_cleared recovery event shown as an ACTIVE rate limit.
//
// If a role renames its report file, or a new role is added to setup_config, or
// the driver renames a rate-limit event, one of these tests fails instead of the
// console lying.

import { test, expect, describe, afterEach } from "bun:test";
import { cpSync, readFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  WORKTREE_ROLE_KINDS, ROLE_REPORT_ARTIFACT, ROLE_SKILL_DIR,
  RATE_LIMIT_EVENTS, reportArtifact,
  ALL_FRAMEWORK_ROLE_KINDS, DETACHED_ROLE_KINDS, FRAMEWORK_ROLE_CONTRACTS,
  type RoleKind,
} from "./role_contracts.ts";
import { buildSnapshot } from "./status_snapshot.ts";
import { DETACHED_ROLES, loadConfig, loadLaneEnv } from "./config.ts";
import { buildFactPack } from "./context_pack.ts";
import { statusFor } from "./dispatch/dock_status.ts";
import { injectLaneEnv, normalizeLaneEnv, resolveLaneEnv } from "./scripts/lane_env.ts";
import { adaptProviderRouting, CODEX_LUNA_MODEL } from "./dispatch/provider_routing.ts";
import { emptyConfig, parseRoutingConfig, rankModel, resolveRouting } from "./dispatch/model_routing.ts";
import { normalizeAgentEntry } from "./scripts/setup_wizard/entries.ts";
import { emitFreshSetupConfig } from "./scripts/setup_wizard/config_emit.ts";
import { emitExplicitRoutingFields } from "./scripts/setup_wizard/diff.ts";
import { readExistingBlockIds } from "./scripts/setup_wizard/toml.ts";
import { providerModelFromRoleIdentity, writeRoleClaude, type RoleCtx } from "./scripts/setup_wizard/roles.ts";
import {
  assertCodexProviderWritableRoots,
  codexProviderWritableRoots,
  codexResumeProviderArgs,
  makeSessionRecord,
  resumeExplicitSession,
  writeSessionRecord,
} from "./scripts/provider_session.ts";
import { acknowledgeAttendedRoleLaunch, runAttendedSpawn } from "./dispatch/attended_seat.ts";
import { checkRoleSeatPromptContract, roleSeatArtifactBoundary } from "./scripts/dispatch_provider.ts";
import { crewSubdir } from "./workspace.ts";
import {
  bindingReference,
  acknowledgeRoleLaunch,
  dispatchExecutionIdentity,
  issueRoleAuthorization,
  issueRoleSeatAuthorization,
  ROLE_RECORD_KIND,
  ROLE_RECOVERY_ARCHIVE_RECORD_KIND,
  roleSeatExecutionIdentity,
  validateRoleBinding,
  writeRoleBindingToContext,
} from "./dispatch/role_binding.ts";
import { resolveRoleKnowledgeBinding } from "./dispatch/knowledge_binding.ts";
import { EVIDENCE_WRITER_STORAGE_KEY } from "./control/types.ts";
import {
  GATE_PROMPT_SECTION_HEADINGS,
  GATE_PROMPT_INPUT_SECTION_HEADINGS,
  inspectPromptSections,
  PROMPT_FIELD_CONTRACTS,
  TASK_FILE_SECTION_HEADINGS,
} from "./dispatch/prompt_section_contract.ts";
import {
  extractGuardianUncoveredDimensions, extractGuardianVerdict, extractReviewSha,
  extractStrictGuardianVerdict, extractStrictVerdict, extractVerdict,
  guardianGateReason,
  resolveGuardianReviewSha, resolveGuardianVerdict,
  resolveObserverReviewSha, resolveVerdict,
} from "./merge_gate_parse.ts";

const SKILLS = join(import.meta.dir, "..", "..", "..");                 // repo/skills
const TEMPLATES = join(import.meta.dir, "..", "..", "templates");       // garelier-core/templates
const GATE_VERDICT_FIXTURES = join(import.meta.dir, "fixtures", "gate_verdict");
const skillFile = (kind: RoleKind) => join(SKILLS, ROLE_SKILL_DIR[kind], "SKILL.md");
const JIG_RENDER = join(SKILLS, "garelier-core", "driver", "src", "scripts", "jig_render.ts");

function renderJig(project: string, pmId: string, out: string, gateHeld = false) {
  const args = [JIG_RENDER, "--project", project, "--pm-id", pmId, "--out", out];
  if (gateHeld) args.push("--gate-held");
  return spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
}

function assertEach<T>(
  values: readonly T[],
  label: (value: T) => string,
  assertion: (value: T) => void,
): void {
  const failures: Error[] = [];
  for (const value of values) {
    try {
      assertion(value);
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      failures.push(new Error(`${label(value)}: ${detail}`));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} role contract(s) failed`);
}

test("role_contracts: routing, gate report, and Jig admission boundaries derive from canonical contracts", () => {
  expect(DETACHED_ROLES).toBe(DETACHED_ROLE_KINDS);
  const detached = new Set<string>(DETACHED_ROLE_KINDS);
  for (const role of ALL_FRAMEWORK_ROLE_KINDS) {
    expect(detached.has(role), role).toBe(
      FRAMEWORK_ROLE_CONTRACTS[role].scheduling === "detached",
    );
  }
  // Provider-neutral setup is absence-preserving. No environment, two-field
  // roster shorthand, rewrite, or migration may silently select Claude Code;
  // Fable/Mythos are design vocabulary, not builtin model ranks.
  expect(rankModel("fable")).toBeNull();
  expect(rankModel("mythos")).toBeNull();
  expect(rankModel("fable", { strong: "opus", mid: "sonnet", light: "haiku" })).toBeNull();
  expect(() => normalizeAgentEntry("worker-01:opus")).toThrow("id:provider:model");
  expect(normalizeAgentEntry("worker-01")).toBe("worker-01::");
  expect(normalizeAgentEntry("worker-01:codex-cli:")).toBe("worker-01:codex-cli:");
  expect(normalizeAgentEntry("worker-01:codex-cli:gpt-5.6-terra"))
    .toBe("worker-01:codex-cli:gpt-5.6-terra");
  expect(() => normalizeAgentEntry("worker-01:claude:")).toThrow("unsupported provider 'claude'");

  const neutralRoot = mkdtempSync(join(tmpdir(), "rc-provider-neutral-"));
  const previousCwd = process.cwd();
  try {
    const pmDir = join(neutralRoot, "__garelier", "pn", "_crew", "pm");
    const workerDir = join(neutralRoot, "__garelier", "pn", "_crew", "workers", "worker-01");
    mkdirSync(pmDir, { recursive: true });
    mkdirSync(workerDir, { recursive: true });
    const setupConfig = join(pmDir, "setup_config.toml");
    writeFileSync(setupConfig,
      '[project]\nname = "Neutral"\n\n' +
      '[branches]\ntarget = "main"\nintegration = "garelier/main/pn/studio"\n\n' +
      '[[dispatch.env]]\nname = "PROJECT_CHECKOUT"\nvalue = "{checkout}"\nwhy = "child needs its own checkout"\napplies_to = ["producer", "gate"]\n\n' +
      '[[dispatch.env]]\nname = "DISPATCH_CONTEXT"\nvalue = "{project}|{container}|{dispatch_id}|{role}|{slug}"\nwhy = "child needs dispatch identity"\n\n' +
      '[runner]\n\n[[workers]]\nid = "worker-01"\n', "utf8");
    expect(loadConfig(neutralRoot, "pn").runner).toEqual({
      pm: { provider: undefined, model: undefined, effort: undefined },
      dock: { provider: undefined, model: undefined, effort: undefined },
    });
    const neutralSetup = readFileSync(setupConfig, "utf8");
    writeFileSync(setupConfig, neutralSetup.replace("[runner]\n", '[runner]\npm_provider = "claude"\n'));
    expect(() => loadConfig(neutralRoot, "pn")).toThrow('unsupported provider "claude"');
    writeFileSync(setupConfig, neutralSetup);
    writeFileSync(setupConfig, `${neutralSetup}\n[lane_env]\nPROJECT_CHECKOUT = "{checkout}"\n`, "utf8");
    expect(() => loadConfig(neutralRoot, "pn")).toThrow("[lane_env] is no longer supported; migrate declarations to [[dispatch.env]]");
    expect(() => loadLaneEnv(neutralRoot, "pn")).toThrow("[lane_env] is no longer supported; migrate declarations to [[dispatch.env]]");
    writeFileSync(setupConfig, neutralSetup, "utf8");
    const laneEnv = loadConfig(neutralRoot, "pn").laneEnv;
    expect(resolveLaneEnv(laneEnv, { checkout: "/checkout", project: "/project", container: "/container", dispatchId: "9", role: "worker", slug: "neutral" }, "producer")).toEqual({
      values: { PROJECT_CHECKOUT: "/checkout", DISPATCH_CONTEXT: "/project|/container|9|worker|neutral" }, skipped: [],
    });
    const fact = buildFactPack({ pmId: "pn", projectRoot: "/project", config: {
      dispatch: { env: [
        { name: "PROJECT_CHECKOUT", value: "{checkout}", why: "child needs its own checkout", applies_to: ["producer", "gate"] },
        { name: "DISPATCH_CONTEXT", value: "{project}|{container}|{dispatch_id}|{role}|{slug}", why: "child needs dispatch identity" },
      ] },
    }, checkout: "/checkout", gateCheckout: "/gate-checkout", dispatchContainer: "/container", task: { id: 9, role: "worker", slug: "neutral" } });
    expect(fact.dispatch_env).toEqual({
      producer: [
        { name: "PROJECT_CHECKOUT", value: "/checkout", why: "child needs its own checkout", applies_to: ["producer", "gate"] },
        { name: "DISPATCH_CONTEXT", value: "/project|/container|9|worker|neutral", why: "child needs dispatch identity", applies_to: ["producer"] },
      ],
      gate: [{ name: "PROJECT_CHECKOUT", value: "/gate-checkout", why: "child needs its own checkout", applies_to: ["producer", "gate"] }],
      skipped: { producer: [], gate: [] },
    });
    expect(resolveLaneEnv(laneEnv, { checkout: "/checkout", project: "/project", container: "/container", dispatchId: "9", role: "worker", slug: "neutral" }, "gate"))
      .toEqual({ values: { PROJECT_CHECKOUT: "/checkout" }, skipped: [] });
    expect(resolveLaneEnv(laneEnv, { checkout: "", project: "/project", container: "/container", dispatchId: "9", role: "worker", slug: "neutral" }, "producer"))
      .toMatchObject({ values: { DISPATCH_CONTEXT: "/project|/container|9|worker|neutral" }, skipped: [{ name: "PROJECT_CHECKOUT", why: "child needs its own checkout", unavailablePlaceholders: ["checkout"] }] });
    expect(injectLaneEnv({ GARELIER_PRODUCER_SEAT: "1" }, { GARELIER_PRODUCER_SEAT: "overridden", PROJECT_CHECKOUT: "/checkout" }, { GARELIER_PRODUCER_SEAT: "1" }))
      .toEqual({ GARELIER_PRODUCER_SEAT: "1", PROJECT_CHECKOUT: "/checkout" });
    expect(injectLaneEnv({ GARELIER_MERGE_GATE_COMMIT: undefined }, { garelier_merge_gate_commit: "project-declared-override" }, { GARELIER_MERGE_GATE_COMMIT: undefined }))
      .toEqual({ GARELIER_MERGE_GATE_COMMIT: undefined });
    expect(injectLaneEnv({ PROJECT_RULE: "ambient", PROJECT_PATH: "ambient" }, { project_rule: "declared", project_path: "declared" }))
      .toEqual({ project_rule: "declared", project_path: "declared" });
    expect(() => normalizeLaneEnv({ env: [{ name: "INVALID", value: "{unknown}", why: "test" }] }, "fixture.toml"))
      .toThrow("allowed placeholders: {checkout}, {project}, {container}, {dispatch_id}, {role}, {slug}");
    expect(() => normalizeLaneEnv({ env: [{ name: "MISSING_WHY", value: "value" }] }, "fixture.toml"))
      .toThrow(".why is required and must not be empty");
    expect(() => normalizeLaneEnv({ env: [{ name: "EMPTY", value: "", why: "test" }] }, "fixture.toml"))
      .toThrow(".value expands to an empty string");
    expect(() => normalizeLaneEnv({ env: [{ name: "CASE", value: "one", why: "test" }, { name: "case", value: "two", why: "test" }] }, "fixture.toml"))
      .toThrow("duplicates \"case\" case-insensitively");
    expect(statusFor(neutralRoot, "pn").dispatch_env).toEqual([
      { name: "PROJECT_CHECKOUT", why: "child needs its own checkout", applies_to: ["producer", "gate"] },
      { name: "DISPATCH_CONTEXT", why: "child needs dispatch identity", applies_to: ["producer"] },
    ]);

    process.chdir(neutralRoot);
    expect(readExistingBlockIds("pn", "workers")).toEqual(["worker-01::"]);
    const roleCtx: RoleCtx = {
      paths: { pmId: "pn", projectRoot: neutralRoot, gitRoot: neutralRoot,
        wsExile: false, garelierHome: "" },
      studioBranch: "garelier/main/pn/studio", now: "2026-08-10T00:00:00Z",
      dirs: { skillsDir: SKILLS, driverDir: join(SKILLS, "garelier-core", "driver") },
      coreTemplatesDir: TEMPLATES, homeRootFromConfig: "",
    };
    writeRoleClaude(roleCtx, "workers", "worker-01", "", "");
    const identity = readFileSync(join(workerDir, "CLAUDE.md"), "utf8");
    expect(identity.split("\n")[0]).toBe("You are worker worker-01 in a Garelier project.");
    expect(identity).not.toContain("provider:");
    expect(identity).not.toContain("model:");
    expect(providerModelFromRoleIdentity(workerDir)).toEqual({ prov: "", model: "" });
    writeFileSync(join(workerDir, "CLAUDE.md"),
      "You are worker worker-01 (provider: codex-cli, model: gpt-5.6-terra) in a Garelier project.\n");
    expect(providerModelFromRoleIdentity(workerDir))
      .toEqual({ prov: "codex-cli", model: "gpt-5.6-terra" });
    writeRoleClaude(roleCtx, "workers", "worker-01", "codex-cli", "");
    expect(providerModelFromRoleIdentity(workerDir)).toEqual({ prov: "codex-cli", model: "" });
    writeRoleClaude(roleCtx, "workers", "worker-01", "", "gpt-5.6-terra");
    expect(providerModelFromRoleIdentity(workerDir)).toEqual({ prov: "", model: "gpt-5.6-terra" });
  } finally {
    process.chdir(previousCwd);
    rmSync(neutralRoot, { recursive: true, force: true });
  }

  const freshConfig = emitFreshSetupConfig({
    ctx: { pmId: "pn", projectRoot: "/project", gitRoot: "/project",
      wsExile: false, garelierHome: "" },
    projectName: "Neutral", now: "2026-08-10T00:00:00Z", pmId: "pn",
    target: "main", targetSlug: "main", studioBranch: "garelier/main/pn/studio",
    pmDir: "__garelier/pn/_crew/pm", qgCmds: [], stack: "custom",
    permissionProfile: "safe", obsPolicyEnabled: true, grdPolicyEnabled: true,
    conPolicyEnabled: false,
  });
  expect(freshConfig).not.toMatch(/^\s*(?:pm|dock)_provider\s*=/m);
  expect(freshConfig).not.toMatch(/^\s*(?:pm|dock)_model\s*=/m);
  expect(freshConfig).not.toContain("inherit the current session");
  expect(freshConfig).toContain("# [[dispatch.env]]");
  expect(freshConfig).toContain('name = "PROJECT_CHECKOUT"');
  expect(emitExplicitRoutingFields("", "")).toEqual([]);
  expect(emitExplicitRoutingFields("codex-cli", "gpt-5.6-terra")).toEqual([
    'provider = "codex-cli"', 'model = "gpt-5.6-terra"',
  ]);

  const setupWizardSources = [
    "scripts/setup_wizard/diff.ts",
  ].map((path) => readFileSync(join(import.meta.dir, path), "utf8")).join("\n");
  expect(setupWizardSources).not.toContain('|| "claude-code"');
  expect(setupWizardSources).not.toContain('let prov = "claude-code"');
  expect(setupWizardSources).not.toMatch(/^\s*['"]provider = "claude-code"/m);
  expect(setupWizardSources).not.toMatch(/^\s*['"]model = "claude-code"/m);
  const prepareSource = readFileSync(join(import.meta.dir, "scripts", "dispatch_prepare.ts"), "utf8");
  const roleBindingSource = readFileSync(join(import.meta.dir, "dispatch", "role_binding.ts"), "utf8");
  const reuseSource = readFileSync(join(import.meta.dir, "dispatch", "reuse.ts"), "utf8");
  expect(ROLE_RECORD_KIND.bindingCore).toBe("garelier_producer_binding_core");
  expect(ROLE_RECORD_KIND.authorization).toBe("garelier_producer_authorization");
  expect(ROLE_RECORD_KIND.launch).toBe("garelier_producer_launch");
  expect(ROLE_RECORD_KIND.instruction).toBe("garelier_producer_instruction");
  expect(ROLE_RECORD_KIND.instructionDelivery).toBe("garelier_producer_instruction_delivery");
  expect(ROLE_RECORD_KIND.close).toBe("garelier_producer_close");
  expect(ROLE_RECORD_KIND.closeClaim).toBe("garelier_producer_close_claim");
  expect(ROLE_RECORD_KIND.closeGateOutcome).toBe("garelier_producer_close_gate_outcome");
  expect(ROLE_RECORD_KIND.admissionTransition).toBe("garelier_producer_admission_transition");
  expect(ROLE_RECORD_KIND.current).toBe("garelier_producer_current");
  expect(roleBindingSource).toContain('const ROLE_BINDING_CONTEXT_STORAGE_KEY = "producer_binding" as const;');
  expect(roleBindingSource).toContain('const ROLE_RECOVERY_CARABINER_STORAGE_VALUE = "producer_recovery" as const;');
  expect(ROLE_RECOVERY_ARCHIVE_RECORD_KIND).toBe("garelier_producer_recovery_archive");
  expect(EVIDENCE_WRITER_STORAGE_KEY).toBe("producer");
  const retiredProviderFlag = ["--pro", "ducer"].join("");
  const retiredRoleBags = [
    ["PRO", "DUCER_ROLES"].join(""),
    ["ROLE_SEAT", "_ROLES"].join(""),
    ["GATE", "_ROLES"].join(""),
  ];
  expect(prepareSource).not.toMatch(/opus\|fable\|mythos/);
  expect(prepareSource).not.toContain('const role = p.role ||');
  expect(prepareSource).not.toContain('modelSelectsCodex');
  expect(prepareSource).not.toContain('"session-default"');
  expect(prepareSource).not.toMatch(/suggestedModel|needsConfirmation|needs_confirmation|above_pm/);
  // W-690: omitting --provider on a fresh dispatch resolves to claude-code
  // instead of refusing. Both directions are asserted so restoring the retired
  // refusal, or letting the default drift to codex, fails here.
  expect(prepareSource).toContain('export const DEFAULT_PROVIDER = "claude-code" as const;');
  expect(prepareSource).not.toContain("normal dispatch requires explicit --provider");
  expect(prepareSource).not.toContain(retiredProviderFlag);
  for (const retiredBag of retiredRoleBags) {
    expect(`${roleBindingSource}\n${reuseSource}\n${prepareSource}`).not.toContain(retiredBag);
  }
  expect(FRAMEWORK_ROLE_CONTRACTS.wanderer.execution).toBe("external-advisory");
  const independentRoleResult = spawnSync(process.execPath, [
    join(import.meta.dir, "scripts", "dispatch_prepare.ts"),
    "--attended-seat", "--role", "wanderer", "--provider", "codex",
  ], { encoding: "utf8", windowsHide: true });
  expect(independentRoleResult.status).toBe(1);
  expect(independentRoleResult.stderr).toContain("--role must be a managed Garelier role");
  expect(independentRoleResult.stderr).toContain("got 'wanderer'");
  process.stdout.write("W568_MEMBERSHIP_SETS retired=0 membership_tests=explicit-per-role result=PASS\n");
  const retiredFlagResult = spawnSync(process.execPath, [
    join(import.meta.dir, "scripts", "dispatch_prepare.ts"), retiredProviderFlag, "codex",
  ], { encoding: "utf8", windowsHide: true });
  expect(retiredFlagResult.status).not.toBe(0);
  expect(retiredFlagResult.stderr).toContain(`unknown arg: ${retiredProviderFlag}`);
  const retiredBindingModule = join(
    import.meta.dir,
    "dispatch",
    `${["pro", "ducer"].join("")}_binding.ts`,
  );
  const retiredModuleResult = spawnSync(process.execPath, [retiredBindingModule], {
    encoding: "utf8",
    windowsHide: true,
  });
  expect(retiredModuleResult.status).not.toBe(0);
  expect(retiredModuleResult.stderr).toContain("Module not found");
  process.stdout.write("W568_RETIRED_ALIAS module=REFUSED alias=0 fallback=0 warning=0 result=PASS\n");
  for (const provider of ["codex", "claude-code"]) {
    const acceptedProvider = spawnSync(process.execPath, [
      join(import.meta.dir, "scripts", "dispatch_prepare.ts"),
      "--attended-seat", "--provider", provider,
    ], { encoding: "utf8", windowsHide: true });
    expect(acceptedProvider.status).toBe(2);
    expect(acceptedProvider.stderr).toContain("--attended-seat requires --role");
    expect(acceptedProvider.stderr).not.toContain("--provider must be");
  }
  const unknownProvider = spawnSync(process.execPath, [
    join(import.meta.dir, "scripts", "dispatch_prepare.ts"),
    "--attended-seat", "--provider", "claude",
  ], { encoding: "utf8", windowsHide: true });
  expect(unknownProvider.status).toBe(2);
  expect(unknownProvider.stderr).toContain("--provider must be codex|claude-code (got 'claude')");
  process.stdout.write("W568_PROVIDER_VALUES accepted=codex,claude-code unknown=claude:REFUSED retired_flag=REFUSED result=PASS\n");
  const routingReference = readFileSync(join(import.meta.dir, "..", "..", "references", "model_routing.md"), "utf8");
  expect(routingReference).not.toContain("opus <\nfable/mythos");
  expect(routingReference).toContain("`fable`) blocks the Codex route");
  expect(routingReference).not.toContain("an explicit external model implies Codex");
  expect(routingReference).not.toContain("existing in-session Claude dispatch transport");
  // W-690: the doc face of the provider default. Provider is still task
  // authority (config/role metadata never select one); what changed is the
  // omission case, and the record must keep a default distinguishable from a
  // decision. Both directions: the retired "requires explicit" wording must be
  // gone, and the two `provider_source` values must both be documented.
  expect(routingReference).not.toContain("A fresh dispatch requires explicit per-task");
  expect(routingReference).toContain("a fresh dispatch that names no provider resolves\nto **`claude-code`**");
  expect(routingReference).toContain("`codex` requires the explicit `--provider codex` flag");
  expect(routingReference).toContain("`framework-default` when the default filled it in");
  const setupReference = readFileSync(join(import.meta.dir, "..", "..", "..", "garelier-pm", "references", "setup.md"), "utf8");
  expect(setupReference).not.toContain("Provider/model routing inherits the current user session");
  expect(setupReference).not.toContain("leaves provider/model unset for runtime inheritance");
  expect(setupReference).toContain("Fresh dispatch supplies provider/model/effort explicitly per task");

  // Inspect the repository tree itself: a diff-only census cannot see legacy
  // scaffold files that were forgotten and therefore never changed.
  const legacyControlScaffold = join(TEMPLATES, "control_scaffold_v2");
  const legacyControlScaffoldFiles = existsSync(legacyControlScaffold)
    ? readdirSync(legacyControlScaffold, { encoding: "utf8", recursive: true })
      .filter((path) => statSync(join(legacyControlScaffold, path)).isFile())
      .sort()
    : [];
  expect(legacyControlScaffoldFiles).toEqual([]);

  // W-452 follow-up: output authority must be reachable from every row in the
  // PM's six-row role pre-read denominator without six copies of the rule.
  const outputContractName = "blueprint-output-contract.md";
  const outputContract = readFileSync(join(SKILLS, "garelier-core", "references", outputContractName), "utf8");
  expect(outputContract).toContain("The blueprint is the authority for **what** the result is");
  expect(outputContract).toContain("Artifact kind");
  expect(outputContract).toContain("Format");
  expect(outputContract).toContain("Mandatory elements");
  expect(outputContract).toContain("Destination kind");
  expect(outputContract).toContain("PM does not proxy-commit");
  expect(outputContract).toContain("do not return `PASS` / `PASS_WITH_NOTES`");
  expect(outputContract).toContain("Librarian verifies");
  expect(outputContract).toContain("Concierge verifies");
  const outputReaders = [
    join(SKILLS, "garelier-core", "references", "worker_field_manual.md"),
    join(SKILLS, "garelier-core", "references", "gate_field_manual.md"),
    join(SKILLS, "garelier-smith", "SKILL.md"),
    join(SKILLS, "garelier-librarian", "SKILL.md"),
    join(SKILLS, "garelier-artisan", "SKILL.md"),
    join(SKILLS, "garelier-concierge", "SKILL.md"),
  ];
  expect(outputReaders).toHaveLength(6);
  assertEach(outputReaders, (path) => path, (path) => {
    expect(readFileSync(path, "utf8")).toContain(outputContractName);
  });
  // W-538 (studio fc8c2118) moved the blueprint-authority contract OUT of
  // garelier-pm/SKILL.md — the SKILL is now an index — and into this reference,
  // but left these four assertions reading the old file, so they went RED on
  // studio itself (measured: the string count in SKILL.md goes 1 -> 0 across that
  // land, while this test file is byte-unchanged from base). Retargeted to where
  // W-538 put the content; all four strings are asserted against the same file.
  const pmSkill = readFileSync(join(SKILLS, "garelier-pm", "references", "pm_blueprint_authority.md"), "utf8");
  expect(pmSkill).toContain("Every blueprint states these eight things");
  expect(pmSkill).toContain("**Output definition**");
  expect(pmSkill).toContain("A prompt/task file may carry the concrete destination path only");
  expect(pmSkill).toContain("PM does not\nproxy-commit");
  for (const path of [
    join(SKILLS, "garelier-pm", "templates", "blueprint.md"),
    join(TEMPLATES, "control_scaffold_v3", "templates", "blueprint.md"),
  ]) {
    const template = readFileSync(path, "utf8");
    expect(template).toContain("## Output definition");
    expect(template).toContain("Artifact kind:");
    expect(template).toContain("Mandatory elements:");
    expect(template).toContain("Destination kind:");
    expect(template).toContain("Concrete path: resolved by the dispatch prompt/task file");
  }
  for (const path of [
    "scripts/make-public-export.ts",
    "../../references/attended-gate-dispatch.md",
    "../../references/design_campaign_playbook.md",
    "../../references/dispatch_prompt_craft.md",
    "../../references/pm_playbook.md",
    "../../../garelier-observer/references/refuter-verify.md",
  ]) {
    expect(readFileSync(join(import.meta.dir, path), "utf8")).not.toMatch(/\bfable\b/i);
  }

  const canonical = { model: "haiku", effort: "low", source: "seat-default" };
  const fallback = adaptProviderRouting({ substrate: "codex-exec", seat: "worker", canonical });
  expect(fallback.model).toBe("gpt-5.6-terra");
  expect(fallback.source).toContain("canonical-light-fallback-terra");
  const advertised = adaptProviderRouting({
    substrate: "codex-exec", seat: "worker", canonical,
    advertisedModels: ["gpt-5.6-terra", CODEX_LUNA_MODEL],
  });
  expect(advertised.model).toBe(CODEX_LUNA_MODEL);
  expect(advertised.source).toContain("canonical-light-luna");
  expect(adaptProviderRouting({
    substrate: "codex-exec", seat: "worker",
    canonical: { model: "vendor-custom-id", effort: "high", source: "flag" },
  }).execution).toBe("llm");
  expect(adaptProviderRouting({
    substrate: "codex-exec", seat: "guardian",
    canonical: { model: CODEX_LUNA_MODEL, effort: "low", source: "flag" },
    advertisedModels: [CODEX_LUNA_MODEL],
  })).toMatchObject({ model: CODEX_LUNA_MODEL, execution: "llm" });
  expect(adaptProviderRouting({
    substrate: "codex-exec", seat: "worker",
    canonical: { model: CODEX_LUNA_MODEL, effort: "low", source: "flag" },
  })).toMatchObject({ model: CODEX_LUNA_MODEL, execution: "llm" });
  const legacyCeilingConfig = parseRoutingConfig({ model_routing: {
    above_pm: "deny", agreement: { models: ["sonnet"], efforts: ["high"] },
  } });
  const fablePmOpusFlag = resolveRouting({
    seat: "worker", config: legacyCeilingConfig, flagModel: "opus", flagEffort: "xhigh", pmModel: "fable",
  });
  expect(fablePmOpusFlag).toMatchObject({ model: "opus", effort: "xhigh", source: "flag" });
  expect(fablePmOpusFlag).not.toHaveProperty("suggested_model");
  expect(fablePmOpusFlag).not.toHaveProperty("needs_confirmation");
  expect(fablePmOpusFlag).not.toHaveProperty("above_pm");
  expect(fablePmOpusFlag.warnings).toEqual([
    "flag_outside_agreed_model_range", "flag_outside_agreed_effort_range",
  ]);
  expect(resolveRouting({ seat: "worker", config: emptyConfig(), pmModel: "fable" }))
    .toMatchObject({ model: "fable", source: "pm-default" });
  expect(adaptProviderRouting({
    substrate: "codex-exec", seat: "worker",
    canonical: { model: "fable", effort: "high", source: "pm-default" },
  })).toMatchObject({ execution: "blocked", block_reason: "canonical model 'fable' cannot be translated to Codex" });
  expect(resolveRouting({
    seat: "observer", config: emptyConfig(), flagModel: CODEX_LUNA_MODEL,
  })).toMatchObject({ model: CODEX_LUNA_MODEL, source: "flag", warnings: ["gate_flag_below_recommended_floor"] });
  expect(resolveRouting({
    seat: "concierge", config: emptyConfig(), flagModel: "gpt-5.6-sol", flagEffort: "high",
  })).toMatchObject({ model: "gpt-5.6-sol", effort: "high", source: "flag", warnings: [] });
  expect(resolveRouting({
    seat: "observer", config: parseRoutingConfig({ model_routing: {
      rules: { on: false }, seats: { observer: "light" },
    } }),
  })).toMatchObject({ model: "sonnet", source: "seat-default+gate-floor-mid" });
  expect(adaptProviderRouting({
    substrate: "codex-exec", seat: "worker",
    canonical: { model: CODEX_LUNA_MODEL, effort: "low", source: "blueprint" },
  }).model).toBe("gpt-5.6-terra");
  const sessionRoot = mkdtempSync(join(tmpdir(), "rc-provider-session-"));
  try {
    const attendedRoot = join(sessionRoot, "attended-root");
    const attendedWorktree = join(attendedRoot, "checkout");
    mkdirSync(join(attendedRoot, "__garelier", "acme"), { recursive: true });
    mkdirSync(join(attendedWorktree, ".git"), { recursive: true });
    expect(() => runAttendedSpawn({
      role: "worker", slug: "w-344", model: "opus", effort: "high",
      taskRef: "task.md", worktree: attendedWorktree, garelierRoot: attendedRoot, pmId: "acme",
    }, attendedWorktree)).toThrow("canonical dispatch role_binding");
    const dispatchContainer = crewSubdir(attendedRoot, "acme", "dispatch1");
    mkdirSync(dispatchContainer, { recursive: true });
    const assignment = join(attendedRoot, "task.md");
    const prompt = join(dispatchContainer, "prompt.md");
    writeFileSync(assignment, "# Bound attended task\n");
    writeFileSync(prompt, "Execute the bound attended task.\n");
    // issueRoleAuthorization reads the item authority with `git show HEAD:<rel>`
    // and refuses an uncommitted one, but this fixture never made attendedRoot a
    // repository — so the whole test died on "item authority source is not
    // committed at HEAD: task.md" before reaching a single assertion. Measured RED
    // on studio as well; not introduced here.
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "ci@example.invalid"],
      ["config", "user.name", "CI"],
      ["add", "task.md"],
      ["commit", "-q", "-m", "attended task authority"],
    ]) {
      const result = Bun.spawnSync(["git", "-C", attendedRoot, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, args.join(" ")).toBe(0);
    }
    const roleAuthorizationOptions = {
      project_root: attendedRoot, pm_id: "acme", identity: dispatchExecutionIdentity(1),
      role: "worker", carabiner: "implementation",
      item: { work_id: "W-344", revision: "1", session_id: "cs-attended", authority_path: assignment },
      assignment_path: assignment, prompt_path: prompt,
      routing: { provider: "attended-agent", model: "opus", effort: "high", source: "automatic" },
      lens: { ref: null, source: "none", registry_path: null, pack_path: null },
      knowledge: resolveRoleKnowledgeBinding({ projectRoot: attendedRoot, pmId: "acme", role: "worker", required: [] }),
      integration: { ref: "garelier/main/acme/studio", base_sha: "a".repeat(40) },
      issuer: { role: "dock", id: "aggregate" },
    } satisfies Parameters<typeof issueRoleAuthorization>[0];
    const authorization = issueRoleAuthorization(roleAuthorizationOptions);
    expect(() => issueRoleAuthorization(roleAuthorizationOptions))
      .toThrow("a current role binding already exists; issue role_recovery for a replacement generation");
    const seatPrompt = join(dispatchContainer, "guardian-prompt.md");
    writeFileSync(seatPrompt, "[Garelier role-seat contract v1]\nrole=guardian\nDeliver the verdict.\n");
    const guardianIdentity = roleSeatExecutionIdentity(1, "guardian");
    const guardianBinding = issueRoleSeatAuthorization({
      project_root: attendedRoot, pm_id: "acme", identity: guardianIdentity,
      role: "guardian", carabiner: "read_only_delivery",
      item: { work_id: "W-344", revision: "1", session_id: "cs-attended", authority_path: assignment },
      assignment_path: assignment, prompt_path: seatPrompt,
      routing: { provider: "codex-cli", model: "gpt-5.6-sol", effort: "high", source: "flag+adapter:codex-explicit" },
      lens: { ref: null, source: "none", registry_path: null, pack_path: null },
      knowledge: resolveRoleKnowledgeBinding({ projectRoot: attendedRoot, pmId: "acme", role: "guardian", required: [] }),
      integration: { ref: "garelier/main/acme/studio", base_sha: "a".repeat(40) },
      issuer: { role: "dock", id: "aggregate" },
    });
    expect(guardianBinding.binding_id).not.toBe(authorization.binding_id);
    acknowledgeRoleLaunch({
      project_root: attendedRoot, pm_id: "acme", identity: guardianIdentity,
      generation: guardianBinding.core.generation, expect_digest: guardianBinding.core_digest,
      transport: "codex-cli", provider_session_id: "guardian-thread-1",
      success_evidence: "fixture role-seat launch", writer: { role: "launcher", id: "aggregate" },
    });
    const guardianRound2 = issueRoleSeatAuthorization({
      project_root: attendedRoot, pm_id: "acme", identity: guardianIdentity,
      role: "guardian", carabiner: "read_only_delivery",
      item: { work_id: "W-344", revision: "1", session_id: "cs-attended", authority_path: assignment },
      assignment_path: assignment, prompt_path: seatPrompt,
      routing: { provider: "codex-cli", model: "gpt-5.6-sol", effort: "high", source: "flag+adapter:codex-explicit" },
      lens: { ref: null, source: "none", registry_path: null, pack_path: null },
      knowledge: resolveRoleKnowledgeBinding({ projectRoot: attendedRoot, pmId: "acme", role: "guardian", required: [] }),
      integration: { ref: "garelier/main/acme/studio", base_sha: "a".repeat(40) },
      issuer: { role: "dock", id: "aggregate" },
    });
    expect(guardianRound2.core.generation).toBe(guardianBinding.core.generation + 1);
    expect(() => validateRoleBinding({
      project_root: attendedRoot, pm_id: "acme", identity: guardianIdentity,
      stage: "authorization", generation: guardianBinding.core.generation,
      expected_digest: guardianBinding.core_digest,
    })).toThrow("superseded");
    expect(validateRoleBinding({
      project_root: attendedRoot, pm_id: "acme", identity: dispatchExecutionIdentity(1), stage: "authorization",
      generation: authorization.core.generation, expected_digest: authorization.core_digest,
    }).authorization.binding_id).toBe(authorization.binding_id);
    const storedContext: Record<string, unknown> = {
      task: { slug: "w-344", branch: "garelier/main/acme/workbench/#1/w-344" },
      guard: { worktree: attendedWorktree },
      routing: { model: "opus", effort: "high", source: "automatic" },
    };
    writeRoleBindingToContext(storedContext, bindingReference(authorization));
    writeFileSync(join(dispatchContainer, "context.json"), `${JSON.stringify(storedContext, null, 2)}\n`);
    const routedWorkSeat = runAttendedSpawn({
      role: "worker", project: attendedRoot, dispatchId: "1",
      taskRef: "task.md", garelierRoot: attendedRoot, pmId: "acme",
    }, attendedWorktree);
    expect(routedWorkSeat.role_binding).toEqual(bindingReference(authorization));
    acknowledgeAttendedRoleLaunch({
      project: attendedRoot, pmId: "acme", dispatchId: "1", generation: authorization.core.generation,
      bindingDigest: authorization.core_digest, agentHandle: "agent-1", parentId: "aggregate",
    });
    expect(validateRoleBinding({
      project_root: attendedRoot, pm_id: "acme", identity: dispatchExecutionIdentity(1),
      stage: "resume", provider_session_id: "agent-1",
    }).launch?.transport).toBe("attended-agent");

    // W-353: the policy-mandatory scanners must reach the gate seat's permission
    // record. Before this, dispatch_prepare wrote every gate record with an empty
    // quality_gate_commands, so a mandatory command matching no preset was denied
    // profile_unknown — policy demanded a scan the seat could not run.
    const pmRoot = join(attendedRoot, "__garelier", "acme");
    mkdirSync(join(pmRoot, "_crew", "pm"), { recursive: true });
    writeFileSync(
      join(pmRoot, "_crew", "pm", "setup_config.toml"),
      // A pre-W-297 spelling, exactly like the live consuming-project config that failed.
      '[guardian_tools]\nsecret_scan = "gitleaks dir --no-banner --redact ."\n' +
        'pii_scan = "pii-audit --format json"\nsast_scan = "node -e evil()"\n' +
        'dependency_scan = "dep-audit"\nlicense_scan = "off"\n\n' +
        '[lenses.defaults]\nguardian = "guardian.risk_control:strict"\n',
    );
    const canonicalSecretScan =
      "gitleaks dir . --no-banner --redact --report-format json --report-path -";
    // W-745: seed from the packs the framework SHIPS, not from the ambient
    // repo's `__garelier/__atmos/lenses`. The dogfooding tree is excluded from
    // `make-public-export.ts`'s export tree by design, so copying it lstat-ENOENT'd
    // there while passing in the dev checkout. `seedLensAtmosTemplates` copies the
    // same source at setup; the fixture owns its control root.
    cpSync(join(SKILLS, "garelier-core", "templates", "lenses"),
      join(attendedRoot, "__garelier", "__atmos", "lenses"), { recursive: true });
    const attendedBlueprint = join(attendedRoot, "__garelier", "acme", "control", "blueprints", "w436.md");
    mkdirSync(join(attendedBlueprint, ".."), { recursive: true });
    writeFileSync(attendedBlueprint, [
      "# W-436 fixture", "", "## Lens selection",
      "- guardian: `guardian.risk_control:strict`",
      "- observer: `observer.review:over_engineering`", "",
    ].join("\n"));

    // W-544: the human A-0 tables and executable heading/field contracts are one
    // closed enumeration. Bounded markers keep this assertion independent from
    // surrounding prose while making a one-sided doc/code edit fail CI.
    const gateManual = readFileSync(
      join(SKILLS, "garelier-core", "references", "gate_field_manual.md"),
      "utf8",
    );
    const manualContracts = (surface: "gate_prompt" | "gate_prompt_input" | "task_file") => {
      const start = `<!-- prompt-section-contract:${surface}:start -->`;
      const end = `<!-- prompt-section-contract:${surface}:end -->`;
      expect(gateManual).toContain(start);
      expect(gateManual).toContain(end);
      const body = gateManual.slice(gateManual.indexOf(start) + start.length, gateManual.indexOf(end));
      return [...body.matchAll(/^\| `## ([^`]+)` \| .* \| `([^`]+)` \|$/gm)].map((match) => ({
        heading: match[1]!, contract: match[2]!,
      }));
    };
    const surfaceHeadings = {
      gate_prompt: GATE_PROMPT_SECTION_HEADINGS,
      gate_prompt_input: GATE_PROMPT_INPUT_SECTION_HEADINGS,
      task_file: TASK_FILE_SECTION_HEADINGS,
    } as const;
    for (const [surface, headings] of Object.entries(surfaceHeadings)) {
      const contracts = manualContracts(surface as keyof typeof surfaceHeadings);
      expect(contracts.map(({ heading }) => heading)).toEqual([...headings]);
      expect(contracts.filter(({ contract }) => contract !== "none")).toEqual([...PROMPT_FIELD_CONTRACTS]);
    }
    const legacyGateHeading = ["PM", "run gate"].join("-");
    const legacyGateContract = ["pm", "run", "gate", "log", "path", "and", "status"].join("_");
    const parity = (
      headings: readonly string[],
      contracts: readonly { heading: string; contract: string }[],
    ) => contracts.map(({ heading }) => heading).join("\n") === headings.join("\n") &&
      contracts.filter(({ contract }) => contract !== "none")
        .map(({ heading, contract }) => `${heading}:${contract}`).join("\n") ===
      PROMPT_FIELD_CONTRACTS.map(({ heading, contract }) => `${heading}:${contract}`).join("\n");
    const taskContracts = manualContracts("task_file");
    const simulatedCodeOnlyDoc = taskContracts.map((entry) => entry.heading === "Dock gate"
      ? { heading: legacyGateHeading, contract: legacyGateContract }
      : entry);
    const simulatedDocOnlyCode = [...TASK_FILE_SECTION_HEADINGS].map((heading) =>
      heading === "Dock gate" ? legacyGateHeading : heading);
    expect(parity(TASK_FILE_SECTION_HEADINGS, simulatedCodeOnlyDoc)).toBeFalse();
    expect(parity(simulatedDocOnlyCode, taskContracts)).toBeFalse();
    process.stdout.write("W567_PARITY code_only=RED doc_only=RED\n");

    // W-708 AC-3: the closed allowlist that refused these three headings (the
    // exact set recorded from dispatch #109's gate prompt) and a `## QG-*` step
    // heading is retired — free-form sections cost a round each and caught no
    // blueprint duplication the other checks miss.
    const w109DuplicatedPrompt = join(attendedRoot, "w109-duplicated-gate-prompt.md");
    writeFileSync(w109DuplicatedPrompt, [
      "# Guardian gate — dispatch #109", "",
      "## QG-9 gate step", "", "PM 選定 step をここに書く。", "",
      "## この row の目的", "", "W-445 の背景を prompt に再掲する。", "",
      "## Guardian として特に見る点", "", "Gate 重点を prompt に再掲する。", "",
      "## 経緯 (参考)", "", "role の経緯を prompt に再掲する。", "",
      "## Review SHA", "", `review_sha: ${"a".repeat(40)}`, "",
      "## Dock gate", "", "log: gate.log; GREEN", "",
    ].join("\n"));
    const freeHeadingSeat = runAttendedSpawn({
      role: "guardian", slug: "w-451-free-headings", worktree: attendedWorktree,
      project: attendedRoot, garelierRoot: attendedRoot, pmId: "acme",
      blueprint: attendedBlueprint, promptFile: w109DuplicatedPrompt,
    }, attendedWorktree);
    expect(freeHeadingSeat.prompt_skeleton).toContain("## QG-9 gate step");
    expect(inspectPromptSections(freeHeadingSeat.prompt_skeleton, "gate_prompt").missing).toEqual([]);

    // W-544 P-13c / W-708 AC-3 (b): mechanism-owned headings are valid only
    // after composition, never in the PM-authored attended input surface. This
    // pair is the whole closed part of the section contract now.
    const mechanismOwnedPrompt = join(attendedRoot, "w544-mechanism-owned-input.md");
    writeFileSync(mechanismOwnedPrompt, [
      "# Invalid attended input", "",
      "## Role source pointers", "", "PM-authored duplicate", "",
      "## Task", "", "PM-authored duplicate", "",
    ].join("\n"));
    expect(() => runAttendedSpawn({
      role: "guardian", slug: "w-544-input-refuse", worktree: attendedWorktree,
      project: attendedRoot, garelierRoot: attendedRoot, pmId: "acme",
      blueprint: attendedBlueprint, promptFile: mechanismOwnedPrompt,
    }, attendedWorktree)).toThrow("## Role source pointers, ## Task");
    // A composed prompt that LOST the mechanism heading every composer emits is
    // the other side of the same rule.
    expect(inspectPromptSections(
      "# Guardian gate\n\n## Seat\n\nga-guardian-x\n",
      "gate_prompt",
    ).missing).toEqual(["Role source pointers"]);

    // W-451 counterfactual 2: a prompt composed of the canonical section set
    // remains launchable. Keep this in the existing aggregate definition so the
    // permanent executable-test count stays flat.
    const validGatePrompt = join(attendedRoot, "w451-valid-gate-prompt.md");
    writeFileSync(validGatePrompt, [
      "# Guardian gate — W-451", "",
      "## Seat", "", "ga-guardian-w451", "",
      "## Dispatch", "", "dispatch #112", "",
      "## Blueprint", "", attendedBlueprint, "",
      // The Output section must name the seat's OWN derived verdict path (the
      // seat below is dispatched with slug `w-353`). A prompt that names any
      // other path for the same role is refused at spawn, so the seat is never
      // handed two candidates to choose between.
      "## Output", "", "runtime/guardian/results/w-353-guardian.md", "",
      "## Review SHA", "", `review_sha: ${"a".repeat(40)}`, "",
      "## Verdict", "", "PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION", "",
      "## Dock gate", "", "log: gate.log; GREEN", "",
    ].join("\n"));

    const gateSeat = runAttendedSpawn({
      role: "guardian", slug: "w-353", worktree: attendedWorktree,
      project: attendedRoot, garelierRoot: attendedRoot, pmId: "acme",
      blueprint: attendedBlueprint, promptFile: validGatePrompt,
    }, attendedWorktree);
    const attendedInspection = inspectPromptSections(gateSeat.prompt_skeleton, "gate_prompt");
    expect(attendedInspection.forbidden).toEqual([]);
    expect(attendedInspection.invalidFields).toEqual([]);
    expect(attendedInspection.headings).toContain("Role source pointers");
    expect(attendedInspection.headings).toContain("Dock gate");
    expect(gateSeat.prompt_skeleton).toContain("## Dock gate");
    expect(gateSeat.prompt_skeleton).toContain(attendedBlueprint);
    expect(gateSeat.prompt_skeleton).toContain(join(attendedRoot, "__garelier", "__atmos", "lenses", "guardian.risk_control.toml"));
    expect(gateSeat.prompt_skeleton).toContain("guardian.risk_control:strict");
    expect(gateSeat.prompt_skeleton).toContain("Block when security, privacy, dependency, or license evidence is insufficient");
    // The secret entry is RE-RENDERED canonically: transcribing the configured
    // spelling verbatim would hand the seat a command the guard still refuses.
    // W-353 F3: it is also the ONLY key transcribed. The other scan keys have no
    // canonical form, so they could only be copied verbatim — an arbitrary head
    // from a git-tracked config landing in the seat's authorized list. The
    // surface was removed rather than narrowed, so this asserts the WHOLE list,
    // not just the presence of the secret entry.
    expect(gateSeat.quality_gate_commands).toEqual([canonicalSecretScan]);
    expect(gateSeat.scanner_config_drift?.join(" ")).toContain("secret_scan");
    // W-353 N3: the printed cwd-safe form must QUOTE the worktree, or it denies
    // itself on any path containing a space (isPlainChangeDirectory treats an
    // unquoted whitespace operand as ambiguous).
    expect(gateSeat.quality_gate_commands_cwd_safe).toEqual([
      `cd "${gateSeat.worktree}" && ${canonicalSecretScan}`,
    ]);
    expect(gateSeat.record_path).not.toBeNull();
    const gateRecord = JSON.parse(readFileSync(gateSeat.record_path!, "utf8"));
    expect(gateRecord.guard.role).toBe("guardian");
    expect(gateRecord.guard.quality_gate_commands).toEqual([canonicalSecretScan]);
    // No configured non-gitleaks command reaches the seat by any route.
    const declared = (gateRecord.guard.quality_gate_commands as string[]).join(" ");
    for (const configured of ["pii-audit", "node -e", "dep-audit", "off"]) {
      expect(declared, `must not transcribe '${configured}'`).not.toContain(configured);
    }
    // Default fence stays the pm control root, which already contains the
    // verdict/draft home.
    expect(gateSeat.fence_roots).toEqual([pmRoot]);

    // The live regression: an EXPLICIT --fence-root used to REPLACE the pm root,
    // leaving a checkout-fenced seat with nowhere its `guardian_scan --out <draft>`
    // could legally land. The results directory is now unioned in, not replaced.
    const fencedSeat = runAttendedSpawn({
      role: "guardian", slug: "w-353-fenced", worktree: attendedWorktree,
      garelierRoot: attendedRoot, pmId: "acme", fenceRoots: [attendedWorktree],
    }, attendedWorktree);
    expect(fencedSeat.prompt_skeleton).toContain("Blueprint: N/A — WARNING: --blueprint was not specified");
    expect(fencedSeat.prompt_skeleton).toContain("guardian.risk_control:strict");
    expect(fencedSeat.prompt_skeleton).toContain("Block when security, privacy, dependency, or license evidence is insufficient");
    expect(fencedSeat.warnings).toContain("dispatch_prepare: WARNING — --blueprint was not specified; proceeding without a blueprint pointer");
    const draftRoot = join(pmRoot, "runtime", "guardian", "results");
    expect(fencedSeat.fence_roots).toHaveLength(2);
    expect(fencedSeat.fence_roots.some((root) => root.includes("checkout"))).toBe(true);
    expect(existsSync(draftRoot)).toBe(true);

    // A work seat is unaffected: it declares no scanner and keeps its own fence.
    const workSeat = routedWorkSeat;
    expect(workSeat.quality_gate_commands).toBeUndefined();
    expect(workSeat.fence_roots).toEqual([workSeat.worktree]);

    const route = { model: "gpt-5.6-sol", effort: "high", source: "test-authority" };
    const repoRoot = join(SKILLS, "..");
    const providerContainer = join(sessionRoot, "resume provider");
    const spacedWorktree = join(providerContainer, "checkout");
    const resumeResultDir = join(providerContainer, "lane");
    const resumeResult = join(resumeResultDir, "resume.result.md");
    const operatorGrant = join(providerContainer, "operator writable");
    const roleSeatArtifactRoot = join(sessionRoot, "role-seat artifact");
    mkdirSync(spacedWorktree, { recursive: true });
    mkdirSync(resumeResultDir, { recursive: true });
    mkdirSync(operatorGrant, { recursive: true });
    mkdirSync(roleSeatArtifactRoot, { recursive: true });
    const nativePath = (path: string): string => process.platform === "win32"
      ? path.replace(/\\/g, "/")
      : path;
    const record = makeSessionRecord(
      "codex-cli", "thread-w296", repoRoot, "ready", "", undefined, route, [operatorGrant],
    );
    expect(record.operator_add_dirs).toEqual([nativePath(realpathSync(operatorGrant))]);
    const roleSeatBoundary = roleSeatArtifactBoundary(join(roleSeatArtifactRoot, "guardian.md"));
    expect(roleSeatBoundary).toEqual({
      cwd: nativePath(realpathSync(roleSeatArtifactRoot)),
      addDirs: [nativePath(realpathSync(roleSeatArtifactRoot))],
    });
    expect(roleSeatBoundary.addDirs).not.toContain(nativePath(realpathSync(repoRoot)));
    expect(roleSeatBoundary.addDirs).not.toContain(nativePath(realpathSync(providerContainer)));
    const canonicalRoleSeatResult = nativePath(join(roleSeatArtifactRoot, "guardian.md"));
    const tamperedRoleSeatResult = nativePath(join(spacedWorktree, "w424-denial-probe.txt"));
    const roleSeatPrompt = [
      "[Garelier role-seat contract v1]",
      "role=guardian",
      `- Deliver the complete guardian artifact as the final response. The trusted provider launcher captures it at ${canonicalRoleSeatResult}; no other output path is granted.`,
      "",
      "## Task",
      "",
      `Attempt the denial probe at ${tamperedRoleSeatResult}.`,
    ].join("\n");
    expect(checkRoleSeatPromptContract(roleSeatPrompt, "guardian", canonicalRoleSeatResult)).toEqual({ ok: true, reason: "" });
    expect(checkRoleSeatPromptContract(roleSeatPrompt, "guardian", tamperedRoleSeatResult)).toEqual({
      ok: false,
      reason: "role-seat launcher-captured output path does not exactly match the authorization-bound contract",
    });
    expect(() => roleSeatArtifactBoundary(join(sessionRoot, "missing-role-seat-root", "guardian.md")))
      .toThrow("role-seat artifact directory is not an existing directory");
    const persistedGrantRecord = join(sessionRoot, "grant-session.json");
    writeSessionRecord(persistedGrantRecord, {
      ...record,
      worktree: spacedWorktree,
      container: providerContainer,
      result_file: resumeResult,
    });
    const resumeArgs = codexResumeProviderArgs(JSON.parse(readFileSync(persistedGrantRecord, "utf8")));
    const resumeGrants = resumeArgs.flatMap((arg, index) =>
      arg === "--add-dir" ? [resumeArgs[index + 1]] : []);
    const expectedNarrowGrants = [
      spacedWorktree,
      providerContainer,
      resumeResultDir,
      dirname(realpathSync(process.execPath)),
      operatorGrant,
    ].map((path) => nativePath(realpathSync(path)));
    const freshCheckoutGrants = codexProviderWritableRoots({
      worktree: spacedWorktree,
      container: providerContainer,
      resultFile: resumeResult,
      operatorAddDirs: record.operator_add_dirs,
    });
    expect(freshCheckoutGrants).toEqual(expectedNarrowGrants);
    expect(resumeGrants).toEqual(freshCheckoutGrants);
    expect(resumeArgs.indexOf("resume")).toBe(1 + (2 * expectedNarrowGrants.length));
    expect(() => assertCodexProviderWritableRoots(
      [...freshCheckoutGrants, nativePath(realpathSync(repoRoot))],
      freshCheckoutGrants,
    )).toThrow("bypassed the shared provider builder");
    const oneShot = makeSessionRecord(
      "codex-cli", "thread-w424-one-shot", repoRoot, "ready", resumeResult,
      undefined, route, [], { container: providerContainer, resumable: false },
    );
    expect(oneShot).toMatchObject({ container: providerContainer, resumable: false });
    expect(() => codexResumeProviderArgs(oneShot)).toThrow("one-shot role-seat session cannot be resumed");
    const ledger = join(providerContainer, "instructions.md");
    const fixtureResumeRole = (): "written" | "refused" => {
      if (!resumeGrants.includes(nativePath(realpathSync(providerContainer)))) return "refused";
      writeFileSync(ledger, "- [x] resume role consumed the instruction\n");
      return "written";
    };
    expect(fixtureResumeRole()).toBe("written");
    expect(readFileSync(ledger, "utf8")).toContain("resume role consumed");

    // W-485: the write GRANT and the injected PROMPT must describe the same
    // range. The grant has always included the container (the assertion above is
    // exactly that: a role writes its own instructions.md there), while the
    // injected prompt said "NEVER create/edit/delete files, outside your worktree
    // cwd" — so a role read its own required artifacts as forbidden. Both
    // producers are text producers, so both are checked as text, and the check is
    // two-sided: the grant contains the container AND both prompts say so.
    expect(freshCheckoutGrants).toContain(nativePath(realpathSync(providerContainer)));
    const codexPrompt = readFileSync(join(SKILLS, "garelier-core/driver/src/scripts/dispatch_provider.ts"), "utf8");
    const claudePrompt = readFileSync(join(SKILLS, "garelier-core/driver/src/scripts/dispatch_prepare.ts"), "utf8");
    // W-485 r2 (oracle strength): an earlier revision asserted only that each
    // source file CONTAINS "instructions.md", which every one of these files does
    // for a dozen unrelated reasons — deleting the prompt sentence would not have
    // turned it red, so it measured nothing. Each sentence below exists ONLY in
    // the injected prompt it belongs to and appears exactly ONCE, so removing or
    // weakening that sentence fails this test.
    const grantSentences = [
      ["codex", codexPrompt, "canonical artifact\n  files directly under your dispatch container"],
      ["claude", claudePrompt, "The ONE other writable place is your own dispatch container's canonical artifacts"],
    ] as const;
    for (const [label, source, sentence] of grantSentences) {
      const occurrences = source.split(sentence).length - 1;
      expect(occurrences, `${label} prompt states the container write grant exactly once`).toBe(1);
      // ...and does NOT carry the contradicting absolute wording any more.
      expect(source, `${label} prompt no longer forbids every write outside the worktree`)
        .not.toContain("NEVER create/edit/delete files, outside\n  your worktree cwd");
      // The deny side is unchanged and still stated.
      expect(source, `${label} prompt still forbids the primary checkout`).toContain("primary checkout");
    }
    expect(resumeGrants).not.toContain(nativePath(realpathSync(repoRoot)));
    expect(resumeGrants).not.toContain(nativePath(realpathSync(SKILLS)));
    expect(() => codexProviderWritableRoots({
      worktree: spacedWorktree,
      container: repoRoot,
      resultFile: resumeResult,
    })).toThrow("container must be the worktree parent");
    expect(resumeArgs).toContain(route.model);
    expect(resumeArgs).toContain(`model_reasoning_effort=\"${route.effort}\"`);
    expect(resumeArgs).not.toContain(route.source);

    const recordFile = join(sessionRoot, "session.json");
    const resultFile = join(sessionRoot, "result.md");
    const forgedWorktree = join(sessionRoot, "forged checkout");
    mkdirSync(forgedWorktree);
    writeSessionRecord(recordFile, record);
    const mismatch = resumeExplicitSession({
      recordFile,
      instructionFile: join(sessionRoot, "unused-instruction.md"),
      resultFile,
      worktree: forgedWorktree,
      expectedRouting: route,
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.fallback?.reason).toBe("worktree_identity_mismatch");
    expect(existsSync(join(sessionRoot, "locks"))).toBe(false);

  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
  }

  // Gate verdict grammar (W-638). Each oracle below is the front-matter form of
  // the retired body-regex oracle it replaces; the ones that only existed
  // because the field shared a surface with prose are gone with the surface.
  const gv = (result: string, sha = "a".repeat(40), extra = ""): string =>
    `+++\n[verdict]\nresult = '${result}'\nreview_sha = '${sha}'\n${extra}+++\n`;

  expect(extractVerdict(gv("PASS"))).toBe("PASS");
  expect(extractVerdict(gv("PASS", "b".repeat(64)))).toBe("PASS");
  expect(extractVerdict(gv("REWORK_RECOMMENDED"))).toBe("REWORK_RECOMMENDED");
  expect(extractGuardianVerdict(gv("PASS"))).toBe("PASS");
  // Guardian's enum does not include REWORK_RECOMMENDED (DEC-024 §9).
  expect(extractGuardianVerdict(gv("REWORK_RECOMMENDED"))).toBeNull();
  // W-057: whole-token match only — no truncation, no substring coercion, and
  // an untouched template menu is not a verdict.
  expect(extractVerdict(gv("PASSED"))).toBeNull();
  expect(extractVerdict(gv("BLOCKING"))).toBeNull();
  expect(extractVerdict(gv("{{PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION}}"))).toBeNull();
  // A duplicate key is a TOML error, so the "two canonical markers are
  // ambiguous" oracle now fails at decode instead of needing its own rule.
  expect(extractVerdict(`+++\n[verdict]\nresult = 'PASS'\nresult = 'BLOCK'\nreview_sha = '${"a".repeat(40)}'\n+++\n`)).toBeNull();
  // A verdict that binds to no commit can never gate a merge.
  expect(extractGuardianVerdict(`+++\n[verdict]\nresult = 'PASS'\n+++\n`)).toBeNull();
  expect(extractGuardianVerdict(gv("PASS", "a".repeat(7)))).toBeNull();
  expect(extractReviewSha(gv("PASS", "A".repeat(40)))).toBeNull();
  expect(extractReviewSha(gv("PASS", "a".repeat(39)))).toBeNull();
  // Fail-closed on the retired form: a body-regex report is not readable, and
  // prose that merely mentions a verdict never becomes one.
  expect(extractVerdict(`verdict: PASS\nreview_sha: ${"a".repeat(40)}\n\n## Verdict\n\nPASS\n`)).toBeNull();
  expect(extractGuardianVerdict("## Verdict\n\nPASS\n")).toBeNull();
  expect(extractVerdict("Guardian verdict: PASS — no blockers\n")).toBeNull();
  // No VALUE is read from the prose below the closing +++, so a contradictory
  // token in the findings cannot change or void the verdict.
  expect(extractVerdict(`${gv("PASS")}\n## Verdict\n\nBLOCK\n\nverdict: BLOCK\n`)).toBe("PASS");
  for (const [name, expected] of [
    ["w380-w381-dispatch-runtime-safety-guardian.md", "PASS"],
    ["w365-gate-seat-scanner-reach-guardian.md", "PASS"],
    ["w409-readmit-rework-guardian.md", "BLOCK"],
  ] as const) {
    expect(extractGuardianVerdict(readFileSync(join(GATE_VERDICT_FIXTURES, name), "utf8"))).toBe(expected);
  }
  // There is one reader now: strict and non-strict agree on every input, so a
  // report the canonical grammar refuses can no longer gate a merge through a
  // looser fallback.
  for (const name of ["w380-w381-dispatch-runtime-safety-guardian.md", "w365-gate-seat-scanner-reach-guardian.md", "w409-readmit-rework-guardian.md"]) {
    const source = readFileSync(join(GATE_VERDICT_FIXTURES, name), "utf8");
    expect(extractStrictGuardianVerdict(source)).toBe(extractGuardianVerdict(source));
  }
  expect(extractStrictVerdict(gv("PASS"))).toBe(extractVerdict(gv("PASS")));
  expect(resolveVerdict({ observer_report_path: "observer.md", observer_verdict: "PASS" }, () => "## Verdict\n\nPASS\n")).toBeNull();
  expect(resolveGuardianVerdict({ guardian_report_path: "guardian.md", guardian_verdict: "PASS" }, () => gv("PASS", "a".repeat(7)))).toBeNull();
  expect(resolveObserverReviewSha(
    { observer_report_path: "observer.md", observer_review_sha: "a".repeat(40) },
    () => gv("PASS", "a".repeat(7)),
  )).toBeNull();
  expect(resolveGuardianReviewSha(
    { guardian_report_path: "guardian.md", guardian_review_sha: "a".repeat(40) },
    () => `review_sha: ${"a".repeat(7)}\n`,
  )).toBeNull();
  const guardianSha = "c".repeat(40);
  // `[[uncovered]]` tables carry the disclosure. Everything the W-370 / W-619
  // oracles asserted still holds; what changes is that a finding EXISTS exactly
  // when a table exists, instead of being inferred from prose.
  const guardianVerdict = (tables: string[][] = [], prose = ""): string => {
    const front = tables.map((fields) => `\n[[uncovered]]\n${fields.join("\n")}\n`).join("");
    return `+++\n[verdict]\nresult = 'PASS'\nreview_sha = '${guardianSha}'\n${front}+++\n${prose ? `\n${prose}\n` : ""}`;
  };
  const secretPiiTable = [
    "dimension = 'secret_pii'",
    "cause = '''cross-repo seat binding is unavailable'''",
    "tracking_row = 'W-365'",
    "alternate_confidence_basis = '''full manual diff review'''",
  ];
  const completeUncoveredGuardian = guardianVerdict([secretPiiTable]);
  expect(extractGuardianUncoveredDimensions(completeUncoveredGuardian)).toEqual({
    complete: true,
    secretPiiUncovered: true,
  });
  // W-619 [UC-1] — a declared finding missing three of its four fields is still
  // incomplete. The retired grammar got this wrong in BOTH directions: it keyed
  // on the uppercase word UNCOVERED, so a half-written lowercase disclosure
  // passed while a correct verdict that merely mentioned the word was refused.
  expect(extractGuardianUncoveredDimensions(guardianVerdict([["dimension = 'legacy_note'"]])))
    .toEqual({ complete: false, secretPiiUncovered: false });
  expect(extractGuardianUncoveredDimensions(guardianVerdict([secretPiiTable, [
    "dimension = 'license_provenance'",
    "cause = '''registry source is pending'''",
    "tracking_row = 'W-371'",
    "alternate_confidence_basis = '''dependency allowlist review'''",
  ]]))).toEqual({ complete: true, secretPiiUncovered: true });
  const guardianReq = { guardian_required: true, guardian_report_path: "guardian.md" };
  expect(guardianGateReason(guardianReq, () => completeUncoveredGuardian)).toBe("");
  expect(guardianGateReason(guardianReq, () => guardianVerdict([[
    "dimension = 'secret_pii'",
    "cause = '''cross-repo seat binding is unavailable'''",
    "alternate_confidence_basis = '''full manual diff review'''",
  ]]))).toContain("incomplete UNCOVERED disclosure");
  // W-619 [UC-2] / R-1 — a verdict with ZERO declared findings passes the
  // disclosure check no matter what its prose says. This exact shape used to be
  // refused, so a correct verdict was thrown away and a Guardian seat re-run
  // with instructions to avoid writing a word — a workaround that then spread
  // into two other bundles' output definitions. The WORD is no longer read, so
  // that failure mode is structurally gone. (The retired four-field GRAMMAR is
  // still read, and refused — the case below this loop.)
  for (const zeroFindingProse of [
    "UNCOVERED dimension disclosure:",
    "No UNCOVERED dimensions: every dimension was scanned.",
    "UNCOVERED UNCOVERED UNCOVERED",
    "there are no uncovered dimensions to disclose",
  ]) {
    expect(guardianGateReason(guardianReq, () => guardianVerdict([], zeroFindingProse)), zeroFindingProse).toBe("");
  }
  // ...but the retired GRAMMAR in prose is refused, not ignored. UC-2 above is
  // about the WORD `UNCOVERED`; this is about the four retired field spellings.
  // A verdict with new-form front matter and an old-form prose disclosure is a
  // MIXED artifact: the typed reader finds no `[[uncovered]]` table and answers
  // "complete, no secret/PII", so a Guardian who believes they declared
  // `secret_pii` silently loses the hard stop. Counterfactual, on byte-identical
  // input: the retired reader at 0526c2e5 returns
  // `{ complete: true, secretPiiUncovered: true }` for `mixedFormDisclosure`
  // (hard stop FIRES); without the explicit reject the typed reader returns
  // `{ complete: true, secretPiiUncovered: false }` (hard stop GONE). Refusing
  // is the only answer that is not silently weaker than the form it replaced
  // (DEC-046: no compat layer, the retired form is not read).
  const mixedFormDisclosure = [
    "uncovered_dimension: secret_pii",
    "uncovered_cause: cross-repo seat binding is unavailable",
    "uncovered_tracking_row: W-365",
    "alternate_confidence_basis: full manual diff review",
  ].join("\n");
  expect(extractGuardianUncoveredDimensions(guardianVerdict([], mixedFormDisclosure)))
    .toEqual({ complete: false, secretPiiUncovered: false });
  expect(guardianGateReason(guardianReq, () => guardianVerdict([], mixedFormDisclosure)))
    .toContain("incomplete UNCOVERED disclosure");
  // A single orphan retired field line is enough — a half-written retired
  // disclosure must not pass by omitting its header either.
  expect(guardianGateReason(guardianReq, () => guardianVerdict([], "uncovered_cause: scanner seat could not bind")))
    .toContain("incomplete UNCOVERED disclosure");
  // The reject is keyed on the retired grammar, not on the substring: the same
  // words inside a `[[uncovered]]` table's own values stay complete.
  expect(extractGuardianUncoveredDimensions(guardianVerdict([[
    "dimension = 'secret_pii'",
    "cause = '''the retired form wrote uncovered_dimension: secret_pii here'''",
    "tracking_row = 'W-365'",
    "alternate_confidence_basis = '''full manual diff review'''",
  ]]))).toEqual({ complete: true, secretPiiUncovered: true });
  // ...and the refusal is UNCONDITIONAL, not reachable only through the
  // zero-table branch. One BENIGN `[[uncovered]]` table beside the same retired
  // prose used to restore `complete: true` and drop `secretPiiUncovered` to
  // false — on input where the retired reader answers `true`, i.e. exactly the
  // hard stop this reject exists to preserve, removable by declaring an
  // unrelated finding.
  const benignTable = [
    "dimension = 'dependency'",
    "cause = '''vendor tree is not fetched in this seat'''",
    "tracking_row = 'W-365'",
    "alternate_confidence_basis = '''lockfile diff review'''",
  ];
  expect(extractGuardianUncoveredDimensions(guardianVerdict([benignTable], mixedFormDisclosure)))
    .toEqual({ complete: false, secretPiiUncovered: false });
  expect(guardianGateReason(guardianReq, () => guardianVerdict([benignTable], mixedFormDisclosure)))
    .toContain("incomplete UNCOVERED disclosure");
  // The same holds when the declared table IS the secret/PII one: a report may
  // not carry a typed finding and a retired-form finding at once.
  expect(guardianGateReason(guardianReq, () => guardianVerdict([secretPiiTable], mixedFormDisclosure)))
    .toContain("incomplete UNCOVERED disclosure");
  // R-2 — the fail-closed half is untouched: a declared finding missing one of
  // the four fields still refuses. If the check had merely been relaxed to
  // "never complain", this would pass.
  expect(guardianGateReason(guardianReq, () => guardianVerdict([[
    "dimension = 'secret_pii'",
    "cause = '''cross-repo seat binding is unavailable'''",
    "tracking_row = 'W-365'",
  ]]))).toContain("incomplete UNCOVERED disclosure");
  // An empty value is not a disclosure either.
  expect(guardianGateReason(guardianReq, () => guardianVerdict([[
    "dimension = 'secret_pii'",
    "cause = ''",
    "tracking_row = 'W-365'",
    "alternate_confidence_basis = '''full manual diff review'''",
  ]]))).toContain("incomplete UNCOVERED disclosure");
  // A tracking row still has to be a real row id.
  expect(guardianGateReason(guardianReq, () => guardianVerdict([[
    "dimension = 'secret_pii'",
    "cause = '''cross-repo seat binding is unavailable'''",
    "tracking_row = 'pending'",
    "alternate_confidence_basis = '''full manual diff review'''",
  ]]))).toContain("incomplete UNCOVERED disclosure");
  const mergeGateSource = readFileSync(join(SKILLS, "garelier-core", "driver", "src", "scripts", "merge-gate.ts"), "utf8");
  expect(mergeGateSource).toMatch(/"guardian_policy_check\.ts",\s*"guardian_policy",\s*HAS_PASSING_GUARDIAN_VERDICT,\s*GUARDIAN_REPORT_PATH,/);

  const jigTick = readFileSync(join(TEMPLATES, "jig_tick.workflow.js"), "utf8");
  const providerGuard = jigTick.indexOf("jig tick requires args.admission.provider=codex|claude-code");
  expect(providerGuard).toBeGreaterThan(-1);
  expect(providerGuard).toBeLessThan(jigTick.indexOf("phase('Dispatch')"));
  expect(jigTick.match(/--provider \$\{selectedProvider\}/g)).toHaveLength(2);
  const planner = jigTick.match(/\/\/ BEGIN JIG_ADMISSION_PLANNER\n([\s\S]*?)\/\/ END JIG_ADMISSION_PLANNER/)?.[1];
  expect(planner).toBeDefined();
  const planJigAdmission = new Function(`${planner}\nreturn planJigAdmission;`)() as
    (input: Record<string, unknown>) => {
      budget: number; diagnosticFallback: boolean;
      items: Array<{ slug: string }>; overCap: Array<{ slug: string; parked: string }>;
    };
  const measured = planJigAdmission({
    admission: {
      provider_available_slots: 3,
      host: { cpu_available_slots: 2, memory_available_slots: 4, io_available_slots: 3 },
    },
    items: [
      { slug: "normal", resource_class: "normal" },
      { slug: "heavy", resource_class: "heavy" },
      { slug: "light", resource_class: "light" },
    ],
  });
  expect(measured.diagnosticFallback).toBe(false);
  expect(measured.budget).toBe(2);
  expect(measured.items.map((item) => item.slug)).toEqual(["normal", "light"]);
  expect(measured.overCap.map((item) => item.slug)).toEqual(["heavy"]);
  const saturated = planJigAdmission({
    admission: {
      provider_available_slots: 0,
      host: { cpu_available_slots: 2, memory_available_slots: 2, io_available_slots: 2 },
    },
    items: [{ slug: "normal", resource_class: "normal" }],
  });
  expect(saturated.diagnosticFallback).toBe(false);
  expect(saturated.budget).toBe(0);
  expect(saturated.items).toEqual([]);
  expect(saturated.overCap[0]?.parked).toContain("capacity exhausted");
  const partialZero = planJigAdmission({
    admission: { provider_available_slots: 0, host: { cpu_available_slots: 3 } },
    items: [{ slug: "normal", resource_class: "normal" }],
  });
  expect(partialZero.diagnosticFallback).toBe(false);
  expect(partialZero.budget).toBe(0);
  expect(partialZero.items).toEqual([]);
  const partialMeasured = planJigAdmission({
    admission: { host: { memory_available_slots: 2 } },
    items: [
      { slug: "normal", resource_class: "normal" },
      { slug: "light", resource_class: "light" },
      { slug: "next", resource_class: "normal" },
    ],
  });
  expect(partialMeasured.diagnosticFallback).toBe(false);
  expect(partialMeasured.budget).toBe(2);
  expect(partialMeasured.items.map((item) => item.slug)).toEqual(["normal", "light"]);
  const diagnostic = planJigAdmission({
    items: [
      { slug: "heavy", resource_class: "heavy" },
      { slug: "normal", resource_class: "normal" },
      { slug: "next", resource_class: "light" },
    ],
  });
  expect(diagnostic.diagnosticFallback).toBe(true);
  expect(diagnostic.items.map((item) => item.slug)).toEqual(["normal"]);
  expect(diagnostic.overCap.map((item) => item.slug)).toEqual(["heavy", "next"]);
  expect(diagnostic.overCap.every((item) => item.parked.includes("telemetry unavailable"))).toBe(true);
  expect(readFileSync(join(SKILLS, "garelier-core", "references", "jig.md"), "utf8"))
    .toContain("provider_available_slots");
  const autonomousMode = readFileSync(join(SKILLS, "garelier-pm", "references", "autonomous-mode.md"), "utf8");
  expect(autonomousMode).toContain("args.admission.provider_available_slots");
  expect(autonomousMode).not.toContain("fan_out_cap");

  const jigRoot = mkdtempSync(join(tmpdir(), "rc-jig-render-"));
  try {
    const pmRoot = join(jigRoot, "__garelier", "pm");
    const v2Config = join(pmRoot, "_crew", "pm", "setup_config.toml");
    mkdirSync(join(pmRoot, "_crew", "pm"), { recursive: true });
    writeFileSync(v2Config, "[jig]\nmax_rework_rounds = 7\nsmith_batch_every = 9\n", "utf8");
    const v2Out = join(jigRoot, "v2.workflow.js");
    const v2 = renderJig(jigRoot, "pm", v2Out);
    expect(v2.status).toBe(0);
    expect(readFileSync(v2Out, "utf8")).toContain("const MAX_REWORK = 7");

    const gateHeldOut = join(jigRoot, "gate-held.workflow.js");
    const gateHeld = renderJig(jigRoot, "pm", gateHeldOut, true);
    expect(gateHeld.status).toBe(0);
    expect(gateHeld.stdout).toContain('"template":"gate_held"');

    rmSync(v2Config);
    const missing = renderJig(jigRoot, "pm", join(jigRoot, "missing.workflow.js"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain(`${jigRoot}/__garelier/pm/_crew/pm/setup_config.toml`);
  } finally {
    rmSync(jigRoot, { recursive: true, force: true });
  }
});

// The report filename(s) a skill names immediately after a write/emit/produce
// verb — i.e. the file the role is instructed to WRITE, distinct from a template
// reference like "(`templates/observer_report.md`)" which is the format, not the
// write target.
function writeTargets(skill: string): string[] {
  const re = /(?:write|writes|emit|emits|produce|produces|create|creates)\s+`?([a-z_]*report\.md)`?/gi;
  return [...skill.matchAll(re)].map((m) => m[1].toLowerCase());
}

describe("role_contracts: report artifact is grounded in each role's skill", () => {
  test("every worktree role's SoT artifact matches its skill write instruction", () => {
    assertEach(WORKTREE_ROLE_KINDS, String, (kind) => {
        const f = skillFile(kind);
        expect(existsSync(f)).toBe(true);
        const skill = readFileSync(f, "utf8");
        const artifact = ROLE_REPORT_ARTIFACT[kind];

        // (a) grounding: the SoT artifact is actually named in the skill (catches
        //     a typo'd SoT entry).
        expect(skill).toContain(artifact);

        // (b) anti-drift: every role-PREFIXED report write-target the skill names
        //     must equal the SoT artifact. This is exactly the Guardian/Concierge
        //     deviation — the old "report.md for everyone" assumption would fail
        //     here because Guardian's write target is `guardian_report.md`.
        const prefixed = writeTargets(skill).filter((t) => /_report\.md$/.test(t));
        for (const t of prefixed) expect(t).toBe(artifact);

        // (c) if the SoT artifact is itself role-prefixed, the skill must instruct
        //     writing it (so the SoT can't claim a prefixed name the role doesn't).
        if (/_report\.md$/.test(artifact)) {
          expect(writeTargets(skill)).toContain(artifact);
        }
    });
  });
});

describe("role_contracts: every provisionable role is handled by the status layer", () => {
  test("fresh setup_config exposes every role without a fixed role array", () => {
    const cfg = readFileSync(join(TEMPLATES, "setup_config.toml"), "utf8");
    const arrayKeys = new Set(
      [...cfg.matchAll(/^\s*\[\[(\w+)\]\]/gm)].map((m) => m[1]),
    );
    expect(arrayKeys).toEqual(new Set());
    for (const kind of WORKTREE_ROLE_KINDS) {
      expect(ROLE_REPORT_ARTIFACT[kind]).toBeTruthy();
    }
  });

  test("every worktree role kind has an artifact and an existing skill", () => {
    for (const kind of WORKTREE_ROLE_KINDS) {
      expect(reportArtifact(kind)).toBeTruthy();
      expect(existsSync(skillFile(kind))).toBe(true);
    }
  });
});

describe("role_contracts: rate-limit event classification", () => {
  // The driver emitter was deleted under DEC-066 (dispatch-only); the
  // classification itself is still consumed by the Status Web snapshot.
  test("the recovery event is classified cleared (not active)", () => {
    expect(RATE_LIMIT_EVENTS.cleared).toContain("rate_limited_cleared");
    expect(RATE_LIMIT_EVENTS.active as readonly string[]).not.toContain("rate_limited_cleared");
  });
});

describe("role_contracts: no false REPORTING-without-report for any role", () => {
  const roots: string[] = [];
  afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function roleProject(kind: RoleKind, withArtifact: boolean) {
    const plural = `${kind}s`;
    const root = mkdtempSync(join(tmpdir(), "rc-")); roots.push(root);
    const pm = join(root, "__garelier", "pm");
    mkdirSync(join(pm, "_crew", "pm"), { recursive: true });
    writeFileSync(join(pm, "_crew", "pm", "setup_config.toml"),
      `[project]\nname = "X"\ngarelier_version = "2.10.0"\n\n` +
      `[branches]\ntarget = "main"\ntarget_slug = "main"\nintegration = "garelier/main/pm/studio"\n\n` +
      `[[${plural}]]\nid = "r1"\nprovider = "claude-code"\nenabled = true\n`, "utf8");
    const c = join(pm, "_crew", plural, "r1");
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, "STATE.md"), `# ${kind} r1\n\n## Status\nREPORTING\n\n## Last activity\nnow\n`, "utf8");
    if (withArtifact) writeFileSync(join(c, ROLE_REPORT_ARTIFACT[kind]), "ok\n", "utf8");
    mkdirSync(join(pm, "runtime", "merge_gate", "results"), { recursive: true });
    return { root, config: loadConfig(root, "pm") };
  }

  test("every REPORTING role with its artifact has no warning", () => {
    assertEach(WORKTREE_ROLE_KINDS, String, (kind) => {
      const { root, config } = roleProject(kind, true);
      const r = buildSnapshot(root, "pm", config).roles.find((x) => x.kind === kind);
      expect(r?.state).toBe("REPORTING");
      expect(r?.warnings ?? []).toHaveLength(0);
    });
  });

  test("every REPORTING role without its artifact gets an artifact-specific warning", () => {
    assertEach(WORKTREE_ROLE_KINDS, String, (kind) => {
      const { root, config } = roleProject(kind, false);
      const r = buildSnapshot(root, "pm", config).roles.find((x) => x.kind === kind);
      expect(r?.warnings.some((m) => m.includes(ROLE_REPORT_ARTIFACT[kind]))).toBe(true);
    });
  });
});
