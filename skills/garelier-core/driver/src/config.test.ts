import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  validatePmId,
  ConfigError,
  STACK_QUALITY_GATES,
  STACK_AUTOFIX,
  OBSERVER_REQUEST_KINDS,
  CONCIERGE_PHASE1_OPERATION_KINDS,
  normalizeJig,
} from "./config.ts";

const PM = "tpm";
const BASE_SECTIONS = `
[project]
name = "Test"
garelier_version = "2.9.1"

[branches]
target = "main"
target_slug = "main"
integration = "garelier/main/tpm/studio"
`;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a setup_config.toml under a fresh temp project root and load it. */
function load(body: string) {
  const root = mkdtempSync(join(tmpdir(), "symphcfg-"));
  tmpDirs.push(root);
  const pmDir = join(root, "__garelier", PM, "_pm");
  mkdirSync(pmDir, { recursive: true });
  writeFileSync(join(pmDir, "setup_config.toml"), BASE_SECTIONS + body, "utf8");
  return loadConfig(root, PM);
}

describe("validatePmId", () => {
  test("accepts valid ids", () => {
    for (const id of ["_workshop", "acme", "alice", "a", "team-one", "x_y"]) {
      expect(() => validatePmId(id)).not.toThrow();
    }
  });
  test("rejects invalid ids", () => {
    for (const id of ["", "_workspace", "_other", "Bad", "-lead", "trail-", "way_too_long_pm_identifier_here", "has space"]) {
      expect(() => validatePmId(id)).toThrow(ConfigError);
    }
  });
});

describe("quality gate (stack-driven, no Rust assumption)", () => {
  test("recognized stack with no commands → stack default set", () => {
    const c = load(`[quality_gate]\nstack = "typescript"\ncommands = []\n`);
    expect(c.qualityGate.stack).toBe("typescript");
    expect(c.qualityGate.commands).toEqual(STACK_QUALITY_GATES.typescript);
    expect(c.qualityGate.fullCommands).toEqual(STACK_QUALITY_GATES.typescript);
    expect(c.qualityGate.fastCommands).toEqual([]);
  });
  test("explicit commands win over stack default", () => {
    const c = load(`[quality_gate]\nstack = "rust"\ncommands = ["make check"]\n`);
    expect(c.qualityGate.commands).toEqual(["make check"]);
    expect(c.qualityGate.fullCommands).toEqual(["make check"]);
    expect(c.qualityGate.timeoutMinutesPerCmd).toBe(120);
    expect(c.qualityGate.fullTimeoutMinutesPerCmd).toBe(120);
    expect(c.qualityGate.fastTimeoutMinutesPerCmd).toBe(10);
  });
  test("fast/full nested gates parse; full is the legacy commands alias", () => {
    const c = load(`
[quality_gate]
stack = "typescript"
commands = ["legacy full"]
timeout_minutes_per_cmd = 90

[quality_gate.fast]
commands = ["npm run typecheck"]
timeout_minutes_per_cmd = 5

[quality_gate.full]
commands = ["npm test", "npm run lint"]
timeout_minutes_per_cmd = 30
`);
    expect(c.qualityGate.commands).toEqual(["npm test", "npm run lint"]);
    expect(c.qualityGate.fullCommands).toEqual(["npm test", "npm run lint"]);
    expect(c.qualityGate.fastCommands).toEqual(["npm run typecheck"]);
    expect(c.qualityGate.timeoutMinutesPerCmd).toBe(30);
    expect(c.qualityGate.fullTimeoutMinutesPerCmd).toBe(30);
    expect(c.qualityGate.fastTimeoutMinutesPerCmd).toBe(5);
  });
  test("autofix defaults to the stack formatter; explicit wins; unknown stack → none (DEC-049 C1)", () => {
    expect(load(`[quality_gate]\nstack = "rust"\ncommands = ["x"]\n`).qualityGate.autofixCommands)
      .toEqual(STACK_AUTOFIX.rust);                       // ["cargo fmt --all"]
    expect(load(`[quality_gate]\nstack = "go"\ncommands = ["x"]\n`).qualityGate.autofixCommands)
      .toEqual(STACK_AUTOFIX.go);
    // typescript has no default (formatter varies) -> empty unless declared
    expect(load(`[quality_gate]\nstack = "typescript"\ncommands = ["x"]\n`).qualityGate.autofixCommands)
      .toEqual([]);
    // explicit [quality_gate.autofix] wins over the stack default
    const c = load(`[quality_gate]\nstack = "rust"\ncommands = ["x"]\n\n[quality_gate.autofix]\ncommands = ["just fmt"]\n`);
    expect(c.qualityGate.autofixCommands).toEqual(["just fmt"]);
    // inline array form also wins
    expect(load(`[quality_gate]\nstack = "rust"\nautofix = ["just fmt"]\n`).qualityGate.autofixCommands)
      .toEqual(["just fmt"]);
    // explicit EMPTY list DISABLES autofix even on a stack with a default (F2)
    expect(load(`[quality_gate]\nstack = "rust"\ncommands = ["x"]\n\n[quality_gate.autofix]\ncommands = []\n`).qualityGate.autofixCommands)
      .toEqual([]);
  });
  test("nested fast with legacy commands keeps legacy as full", () => {
    const c = load(`
[quality_gate]
commands = ["legacy full"]
timeout_minutes_per_cmd = 45

[quality_gate.fast]
commands = ["quick"]
`);
    expect(c.qualityGate.commands).toEqual(["legacy full"]);
    expect(c.qualityGate.fullCommands).toEqual(["legacy full"]);
    expect(c.qualityGate.fastCommands).toEqual(["quick"]);
    expect(c.qualityGate.fullTimeoutMinutesPerCmd).toBe(45);
  });
  test("custom stack with no commands → empty (caller must supply)", () => {
    const c = load(`[quality_gate]\nstack = "custom"\ncommands = []\n`);
    expect(c.qualityGate.stack).toBe("custom");
    expect(c.qualityGate.commands).toEqual([]);
  });
  test("absent quality_gate → empty, no Rust default leaks in", () => {
    const c = load("");
    expect(c.qualityGate.commands).toEqual([]);
    expect(c.qualityGate.stack).toBeUndefined();
  });
  test("STACK_QUALITY_GATES covers the four real stacks", () => {
    for (const s of ["rust", "typescript", "python", "go"]) {
      expect(STACK_QUALITY_GATES[s].length).toBeGreaterThan(0);
    }
    expect(STACK_QUALITY_GATES.custom).toEqual([]);
    expect(STACK_QUALITY_GATES.mixed).toEqual([]);
  });
});

describe("permissions", () => {
  test("default profile is reviewed (never dangerous) when absent", () => {
    const c = load("");
    expect(c.permissions.profile).toBe("reviewed");
    expect(c.permissions.allowNetwork).toBe(false);
    expect(c.permissions.requirePmApprovalPaths.length).toBeGreaterThan(0);
  });
  test("dangerous is honored as explicit opt-in", () => {
    const c = load(`[permissions]\nprofile = "dangerous"\n`);
    expect(c.permissions.profile).toBe("dangerous");
  });
  test("invalid profile falls back to reviewed", () => {
    const c = load(`[permissions]\nprofile = "yolo"\n`);
    expect(c.permissions.profile).toBe("reviewed");
  });
  test("custom protected/forbidden path lists parse", () => {
    const c = load(`[permissions]\nprofile = "safe"\nrequire_pm_approval_paths = ["a/**"]\nforbidden_paths = ["**/x.pem"]\n`);
    expect(c.permissions.profile).toBe("safe");
    expect(c.permissions.requirePmApprovalPaths).toEqual(["a/**"]);
    expect(c.permissions.forbiddenPaths).toEqual(["**/x.pem"]);
  });
});

describe("observer policy + observers", () => {
  test("policy is inert without configured observers", () => {
    const c = load("");
    expect(c.observerPolicy.enabled).toBe(false);
    expect(c.observerPolicy.requireForArtisanPremerge).toBe(true);
    expect(c.observerPolicy.requireForAllMerges).toBe(false);
    expect(c.observerPolicy.largeDiffLines).toBe(800);
  });
  test("configured observers auto-enable policy unless explicitly disabled", () => {
    const enabled = load(`[[observers]]\nid = "obs1"\nprovider = "claude-code"\n`);
    expect(enabled.observerPolicy.enabled).toBe(true);

    const disabled = load(`[observer_policy]\nenabled = false\n\n[[observers]]\nid = "obs1"\nprovider = "claude-code"\n`);
    expect(disabled.observerPolicy.enabled).toBe(false);
  });
  test("policy overrides parse", () => {
    const c = load(`[observer_policy]\nenabled = true\nrequire_for_all_merges = true\nlarge_diff_lines = 1200\nadvice_is_binding = true\n`);
    expect(c.observerPolicy.enabled).toBe(true);
    expect(c.observerPolicy.requireForAllMerges).toBe(true);
    expect(c.observerPolicy.largeDiffLines).toBe(1200);
    expect(c.observerPolicy.adviceIsBinding).toBe(true);
  });
  test("observers parse with kinds; disabled ones dropped; default kinds applied", () => {
    const c = load(
      `[[observers]]\nid = "obs1"\nprovider = "claude-code"\nenabled = true\nallowed_request_kinds = ["merge_review"]\n\n` +
      `[[observers]]\nid = "obs2"\nprovider = "claude-code"\nenabled = false\n\n` +
      `[[observers]]\nid = "obs3"\nprovider = "claude-code"\n`,
    );
    expect(c.observers.map((o) => o.id)).toEqual(["obs1", "obs3"]);
    expect(c.observers[0].allowedRequestKinds).toEqual(["merge_review"]);
    // obs3 omitted allowed_request_kinds → defaults to the full kind set
    expect(c.observers[1].allowedRequestKinds).toEqual([...OBSERVER_REQUEST_KINDS]);
  });
  test("OBSERVER_REQUEST_KINDS has the five canonical kinds", () => {
    expect(OBSERVER_REQUEST_KINDS).toContain("merge_review");
    expect(OBSERVER_REQUEST_KINDS).toContain("artisan_premerge_review");
    expect(OBSERVER_REQUEST_KINDS.length).toBe(5);
  });
});

describe("artisan", () => {
  test("enabled=true → artisan config present", () => {
    const c = load(`[artisan]\nenabled = true\nid = "sol1"\nprovider = "codex-cli"\nmodel = "gpt-5-codex"\nbranch_namespace = "satchel"\n`);
    expect(c.artisan?.id).toBe("sol1");
    expect(c.artisan?.provider).toBe("codex-cli");
    expect(c.artisan?.branchNamespace).toBe("satchel");
  });
  test("enabled=false → undefined (no artisan lane)", () => {
    const c = load(`[artisan]\nenabled = false\nid = "sol1"\nprovider = "claude-code"\n`);
    expect(c.artisan).toBeUndefined();
  });
});

describe("guardian policy + guardians (DEC-024)", () => {
  test("policy is inert without configured guardians", () => {
    const c = load("");
    expect(c.guardianPolicy.enabled).toBe(false);
    expect(c.guardianPolicy.branchNamespace).toBe("gavel");
    expect(c.guardianPolicy.requireForPromote).toBe(true);
    expect(c.guardianPolicy.blockOnSecret).toBe(true);
  });
  test("configured guardians auto-enable policy unless explicitly disabled", () => {
    const enabled = load(`[[guardians]]\nid = "g1"\nprovider = "claude-code"\n`);
    expect(enabled.guardianPolicy.enabled).toBe(true);

    const disabled = load(`[guardian_policy]\nenabled = false\n\n[[guardians]]\nid = "g1"\nprovider = "claude-code"\n`);
    expect(disabled.guardianPolicy.enabled).toBe(false);
  });
});

describe("concierge policy + concierges (DEC-025)", () => {
  test("policy is inert without configured concierges", () => {
    const c = load("");
    expect(c.conciergePolicy.enabled).toBe(false);
    expect(c.conciergePolicy.branchNamespace).toBe("clipboard");
    expect(c.conciergePolicy.forbidPushGarelierBranches).toBe(true);
    expect(c.conciergePolicy.forbidForcePush).toBe(true);
    expect(c.conciergePolicy.forbidBlindGitPull).toBe(true);
    expect(c.conciergePolicy.requireGuardianBeforeExternalWrite).toBe(true);
    expect(c.conciergePolicy.allowedExternalBranchPrefixes).toEqual(["publish/", "pr/", "release/"]);
    expect(c.conciergePolicy.requiredKnowledgePaths.length).toBeGreaterThan(0);
  });
  test("configured concierges auto-enable policy unless explicitly disabled", () => {
    const enabled = load(`[[concierges]]\nid = "cg1"\nprovider = "claude-code"\n`);
    expect(enabled.conciergePolicy.enabled).toBe(true);

    const disabled = load(`[concierge_policy]\nenabled = false\n\n[[concierges]]\nid = "cg1"\nprovider = "claude-code"\n`);
    expect(disabled.conciergePolicy.enabled).toBe(false);
  });
  test("policy overrides parse (including required_knowledge as a paths table)", () => {
    const c = load(
      `[concierge_policy]\nenabled = true\nforbid_force_push = false\nallowed_external_branch_prefixes = ["pub/"]\n\n` +
      `[concierge_policy.required_knowledge]\npaths = ["docs/x.md"]\n`,
    );
    expect(c.conciergePolicy.enabled).toBe(true);
    expect(c.conciergePolicy.forbidForcePush).toBe(false);
    expect(c.conciergePolicy.allowedExternalBranchPrefixes).toEqual(["pub/"]);
    expect(c.conciergePolicy.requiredKnowledgePaths).toEqual(["docs/x.md"]);
  });
  test("concierges parse: disabled dropped; default ops = Phase 1; explicit ops win; checkout forced true", () => {
    const c = load(
      `[[concierges]]\nid = "cg1"\nprovider = "claude-code"\nenabled = true\nallowed_operation_kinds = ["promote_target"]\n\n` +
      `[[concierges]]\nid = "cg2"\nprovider = "claude-code"\nenabled = false\n\n` +
      `[[concierges]]\nid = "cg3"\nprovider = "claude-code"\ncheckout = false\n`,
    );
    expect(c.concierges.map((x) => x.id)).toEqual(["cg1", "cg3"]);
    expect(c.concierges[0].allowedOperationKinds).toEqual(["promote_target"]);
    // cg3 omitted allowed_operation_kinds → defaults to the Phase 1 subset
    expect(c.concierges[1].allowedOperationKinds).toEqual([...CONCIERGE_PHASE1_OPERATION_KINDS]);
    // checkout is forced true even when config says false (external ops need git state)
    expect(c.concierges[1].checkout).toBe(true);
  });
  test("CONCIERGE_PHASE1_OPERATION_KINDS is exactly the two Phase 1 ops", () => {
    expect([...CONCIERGE_PHASE1_OPERATION_KINDS]).toEqual(["promote_target", "sync_remote"]);
  });
});

describe("role rosters + provider validation", () => {
  test("workers/scouts/smiths/librarians/observers all parse", () => {
    const c = load(
      `[[workers]]\nid = "w1"\nprovider = "claude-code"\n\n` +
      `[[scouts]]\nid = "s1"\nprovider = "claude-code"\n\n` +
      `[[smiths]]\nid = "sm1"\nprovider = "codex-cli"\nmodel = "gpt-5-codex"\n\n` +
      `[[librarians]]\nid = "lib1"\nprovider = "claude-code"\nenabled = true\n\n` +
      `[[observers]]\nid = "ob1"\nprovider = "claude-code"\n`,
    );
    expect(c.workers.map((w) => w.id)).toEqual(["w1"]);
    expect(c.smiths[0].provider).toBe("codex-cli");
    expect(c.librarians.map((l) => l.id)).toEqual(["lib1"]);
    expect(c.observers.map((o) => o.id)).toEqual(["ob1"]);
  });
  test("unsupported provider throws ConfigError", () => {
    expect(() => load(`[[workers]]\nid = "w1"\nprovider = "gpt4all"\n`)).toThrow(ConfigError);
  });
  test("missing [branches] target throws", () => {
    const root = mkdtempSync(join(tmpdir(), "symphcfg-"));
    tmpDirs.push(root);
    const pmDir = join(root, "__garelier", PM, "_pm");
    mkdirSync(pmDir, { recursive: true });
    writeFileSync(join(pmDir, "setup_config.toml"), `[project]\nname = "X"\n`, "utf8");
    expect(() => loadConfig(root, PM)).toThrow(ConfigError);
  });
});

describe("provider pool expansion (DEC-026)", () => {
  test("normalizeProvider accepts gemini / copilot / cursor aliases", () => {
    const c = load(
      `[[workers]]\nid = "g1"\nprovider = "gemini"\n\n` +
      `[[smiths]]\nid = "cp1"\nprovider = "github-copilot"\nmodel = "auto"\n\n` +
      `[[observers]]\nid = "cu1"\nprovider = "cursor-agent"\nenabled = true\ncheckout = false\n\n` +
      `[[scouts]]\nid = "g2"\nprovider = "google-gemini"\n`,
    );
    expect(c.workers[0].provider).toBe("gemini-cli");
    expect(c.smiths[0].provider).toBe("copilot-cli");
    expect(c.observers[0].provider).toBe("cursor-cli");
    expect(c.scouts.find((s) => s.id === "g2")?.provider).toBe("gemini-cli");
  });
  test("default model: gemini → gemini-default, copilot/cursor → auto", () => {
    const c = load(
      `[[workers]]\nid = "g"\nprovider = "gemini-cli"\n\n` +
      `[[smiths]]\nid = "cp"\nprovider = "copilot-cli"\n\n` +
      `[[scouts]]\nid = "cu"\nprovider = "cursor-cli"\n`,
    );
    expect(c.workers[0].model).toBe("gemini-default");
    expect(c.smiths[0].model).toBe("auto");
    expect(c.scouts[0].model).toBe("auto");
  });
  test("unsupported provider error lists all five providers", () => {
    try {
      load(`[[workers]]\nid = "x"\nprovider = "gpt4all"\n`);
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("claude-code");
      expect(msg).toContain("codex-cli");
      expect(msg).toContain("gemini-cli");
      expect(msg).toContain("copilot-cli");
      expect(msg).toContain("cursor-cli");
    }
  });
  test("provider_command parses as array or whitespace-split string", () => {
    const c = load(
      `[[workers]]\nid = "a"\nprovider = "gemini-cli"\nprovider_command = ["npx", "@google/gemini-cli"]\n\n` +
      `[[workers]]\nid = "b"\nprovider = "copilot-cli"\nprovider_command = "npx copilot"\n\n` +
      `[[workers]]\nid = "c"\nprovider = "claude-code"\n`,
    );
    expect(c.workers[0].providerCommand).toEqual(["npx", "@google/gemini-cli"]);
    expect(c.workers[1].providerCommand).toEqual(["npx", "copilot"]);
    expect(c.workers[2].providerCommand).toBeUndefined();
  });
  test("mixed provider roster parses across roles", () => {
    const c = load(
      `[[workers]]\nid = "w-claude"\nprovider = "claude-code"\n\n` +
      `[[workers]]\nid = "w-codex"\nprovider = "codex-cli"\nmodel = "gpt-5-codex"\n\n` +
      `[[workers]]\nid = "w-gemini"\nprovider = "gemini-cli"\n`,
    );
    expect(c.workers.map((w) => w.provider)).toEqual(["claude-code", "codex-cli", "gemini-cli"]);
  });
});

describe("concurrency tiers (DEC-027 / DEC-031)", () => {
  const flat = (tiers: string[][]) => tiers.flat();

  test("defaults when [concurrency] is absent — gates top, producers share a tier, empty demotion tier", () => {
    const c = load(``);
    expect(c.concurrency.maxConcurrentAgents).toBe(4);
    expect(c.concurrency.starvationCycles).toBe(3);
    expect(c.concurrency.tiers).toEqual([
      ["concierge", "guardian", "observer"],
      ["smith", "librarian"],
      ["worker", "scout", "artisan"],
      [],   // reserved demotion lane
    ]);
  });

  test("an explicit empty (demotion) tier is kept", () => {
    const c = load(`[concurrency]\ntiers = [["worker"], []]\n`);
    // worker tier 0, empty demotion tier kept; missing roles append to the last
    // (empty) tier — so the demotion tier is only guaranteed empty when every role
    // is placed (the default does that).
    expect(c.concurrency.tiers[0]).toEqual(["worker"]);
    expect(c.concurrency.tiers.length).toBe(2);
  });

  test("explicit values are read and floored/clamped to >= 0", () => {
    const c = load(`[concurrency]\nmax_concurrent_agents = 6\nstarvation_cycles = 2\n`);
    expect(c.concurrency.maxConcurrentAgents).toBe(6);
    expect(c.concurrency.starvationCycles).toBe(2);
  });

  test("negative values clamp to 0 (cap 0 = unlimited)", () => {
    const c = load(`[concurrency]\nmax_concurrent_agents = -3\nstarvation_cycles = -1\n`);
    expect(c.concurrency.maxConcurrentAgents).toBe(0);
    expect(c.concurrency.starvationCycles).toBe(0);
  });

  test("custom tiers are honored; missing roles append to the last tier", () => {
    const c = load(`[concurrency]\ntiers = [["worker"], ["scout"]]\n`);
    expect(c.concurrency.tiers[0]).toEqual(["worker"]);
    expect(c.concurrency.tiers[1][0]).toBe("scout");
    // every detached role present exactly once across all tiers, no duplicates
    const all = flat(c.concurrency.tiers);
    expect(new Set(all).size).toBe(8);
    expect(all).toContain("artisan");           // appended to the last tier
    expect(c.concurrency.tiers[c.concurrency.tiers.length - 1]).toContain("artisan");
  });

  test("unknown and duplicate tier entries are dropped; case-insensitive", () => {
    const c = load(`[concurrency]\ntiers = [["worker", "bogus", "worker"], ["SCOUT", "worker"]]\n`);
    const all = flat(c.concurrency.tiers);
    expect(all.filter((r) => r === "worker")).toHaveLength(1); // dup dropped
    expect(all).not.toContain("bogus");
    expect(all).toContain("scout");                            // SCOUT lowercased
    expect(new Set(all).size).toBe(8);
    expect(c.concurrency.tiers[0]).toEqual(["worker"]);        // worker stays in tier 0
  });
});

describe("output control (DEC-028)", () => {
  test("defaults when [output_control] is absent", () => {
    const c = load(``);
    expect(c.outputControl.enabled).toBe(true);
    expect(c.outputControl.defaultProfile).toBe("compact");
    expect(c.outputControl.violationMode).toBe("warn");
    expect(c.outputControl.modelResultLogChars).toBe(600);
    expect(c.outputControl.roles.scout).toBe("micro");
    expect(c.outputControl.roles.guardian).toBe("normal");
    expect(c.outputControl.profiles.compact.softResultChars).toBe(900);
  });

  test("role override is read; guardian = micro is allowed (doctor warns, not a config error)", () => {
    const c = load(`[output_control.roles]\nworker = "micro"\nguardian = "micro"\n`);
    expect(c.outputControl.roles.worker).toBe("micro");
    expect(c.outputControl.roles.guardian).toBe("micro");
  });

  test("profile override merges over defaults", () => {
    const c = load(`[output_control.profiles.compact]\nsoft_result_chars = 1200\nmax_bullets = 6\n`);
    expect(c.outputControl.profiles.compact.softResultChars).toBe(1200);
    expect(c.outputControl.profiles.compact.maxBullets).toBe(6);
    expect(c.outputControl.profiles.micro.softResultChars).toBe(500); // untouched
  });

  test("model_result_log_chars is clamped to [100, 5000]", () => {
    expect(load(`[output_control]\nmodel_result_log_chars = 10\n`).outputControl.modelResultLogChars).toBe(100);
    expect(load(`[output_control]\nmodel_result_log_chars = 99999\n`).outputControl.modelResultLogChars).toBe(5000);
  });

  test("unknown default_profile is a ConfigError", () => {
    expect(() => load(`[output_control]\ndefault_profile = "tiny"\n`)).toThrow(ConfigError);
  });

  test("invalid violation_mode is a ConfigError", () => {
    expect(() => load(`[output_control]\nviolation_mode = "explode"\n`)).toThrow(ConfigError);
  });

  test("soft_result_chars < 200 is a ConfigError", () => {
    expect(() => load(`[output_control.profiles.micro]\nsoft_result_chars = 50\n`)).toThrow(ConfigError);
  });

  test("a role mapped to an unknown profile is a ConfigError", () => {
    expect(() => load(`[output_control.roles]\nworker = "nope"\n`)).toThrow(ConfigError);
  });

  test("unknown role key is dropped (kept defaults), not an error", () => {
    const c = load(`[output_control.roles]\nbogusrole = "micro"\n`);
    expect(c.outputControl.roles.bogusrole).toBeUndefined();
    expect(c.outputControl.roles.worker).toBe("compact");
  });
  test("authoring: language + terse parse; defaults auto/true (DEC-049)", () => {
    const def = load(``);
    expect(def.outputControl.language).toBe("auto");
    expect(def.outputControl.terse).toBe(true);
    const c = load(`[output_control]\nlanguage = "ja"\nterse = false\n`);
    expect(c.outputControl.language).toBe("ja");
    expect(c.outputControl.terse).toBe(false);
    // an unknown language falls back to the default (auto), not an error
    expect(load(`[output_control]\nlanguage = "klingon"\n`).outputControl.language).toBe("auto");
  });
});

describe("legacy [execution] block (axis removed with the driver, DEC-066)", () => {
  test("a stray [execution] section is tolerated (ignored, not an error)", () => {
    // The execution-backend axis only configured the deleted headless driver; the
    // block is tolerated so pre-DEC-066 configs still parse. Codex routing is now
    // per-role (provider = "codex-cli"), not here.
    const c = load(`[execution]\nbackend = "headless"\n\n[[workers]]\nid = "w1"\n`);
    expect(c.workers[0].provider).toBe("claude-code");
  });
});

describe("lane default + artisan singleton (DEC-056)", () => {
  test("default lane is dock when [lanes] absent", () => {
    expect(load(``).defaultLane).toBe("dock");
  });
  test('[lanes] default = "artisan" parses', () => {
    expect(load(`[lanes]\ndefault = "artisan"\n`).defaultLane).toBe("artisan");
  });
  test('[lanes] default = "dock" parses', () => {
    expect(load(`[lanes]\ndefault = "dock"\n`).defaultLane).toBe("dock");
  });
  test("invalid [lanes] default → ConfigError", () => {
    expect(() => load(`[lanes]\ndefault = "solo"\n`)).toThrow(ConfigError);
  });
  test("a single [artisan] table is accepted", () => {
    const c = load(`[artisan]\nenabled = true\nid = "artisan-01"\nprovider = "claude-code"\nmodel = "claude-code"\n`);
    expect(c.artisan?.id).toBe("artisan-01");
  });
  test("multiple [[artisan]] entries → ConfigError (singleton)", () => {
    expect(() => load(
      `[[artisan]]\nenabled = true\nid = "a-01"\nprovider = "claude-code"\nmodel = "claude-code"\n\n` +
      `[[artisan]]\nenabled = true\nid = "a-02"\nprovider = "claude-code"\nmodel = "claude-code"\n`,
    )).toThrow(ConfigError);
  });
});

// DEC-062 Phase 1: [jig] block parsing.
describe("normalizeJig (DEC-062)", () => {
  test("absent block yields ENABLED defaults (default-on, opt-out)", () => {
    expect(normalizeJig(undefined)).toEqual({
      enabled: true, fanOutCap: 3, maxReworkRounds: 2, criticalProducers: 3,
      smithBatchEvery: 5,
      reviewDepth: { low: "gate", normal: "gate+refute", critical: "nversion" },
    });
  });
  test("smith_batch_every: explicit, zero-disables, garbage falls back (DEC-069)", () => {
    expect(normalizeJig({ smith_batch_every: 8 }).smithBatchEvery).toBe(8);
    expect(normalizeJig({ smith_batch_every: 0 }).smithBatchEvery).toBe(0);
    expect(normalizeJig({ smith_batch_every: -3 }).smithBatchEvery).toBe(5);
    expect(normalizeJig({ smith_batch_every: "six" }).smithBatchEvery).toBe(5);
  });
  test("enabled=false is the explicit opt-out", () => {
    expect(normalizeJig({ enabled: false }).enabled).toBe(false);
  });
  test("explicit values parse; unknown depth falls back", () => {
    const j = normalizeJig({
      enabled: true, fan_out_cap: 5, max_rework_rounds: 1, critical_producers: 2,
      review_depth: { low: "gate+refute", normal: "bogus", critical: "gate" },
    });
    expect(j.enabled).toBe(true);
    expect(j.fanOutCap).toBe(5);
    expect(j.maxReworkRounds).toBe(1);
    expect(j.criticalProducers).toBe(2);
    expect(j.reviewDepth).toEqual({ low: "gate+refute", normal: "gate+refute", critical: "gate" });
  });
  test("non-positive and non-numeric knobs fall back", () => {
    const j = normalizeJig({ fan_out_cap: -1, max_rework_rounds: "two", critical_producers: 0 });
    expect(j.fanOutCap).toBe(3);
    expect(j.maxReworkRounds).toBe(2);
    expect(j.criticalProducers).toBe(3);
  });
});

