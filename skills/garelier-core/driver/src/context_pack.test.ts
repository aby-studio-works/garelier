import { rmSync } from "./guard/path_guard.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFactPack,
  buildGateAgents,
  GATE_VERDICT_TEMPLATE,
  buildCommitTemplate,
  buildScopedCommands,
  deriveTargetSlug,
  parseQualityGate,
  parseAnchors,
  resolveTouchedPackages,
  parseCargoMetadata,
  verifyTouchedPackages,
  cargoPackages,
  resolveBashTimeoutBudgetMs,
  resolveBashTimeoutContext,
  DEFAULT_BASH_TIMEOUT_BUDGET_MS,
} from "./context_pack.ts";

describe("deriveTargetSlug (the guardrail — computed once, not re-parsed)", () => {
  test("explicit slug wins", () => {
    expect(deriveTargetSlug("develop/soft", "develop-soft")).toBe("develop-soft");
  });
  test("derives by replacing '/' with '-'", () => {
    expect(deriveTargetSlug("develop/soft", null)).toBe("develop-soft");
    expect(deriveTargetSlug("main", null)).toBe("main");
  });
  test("null target → null", () => {
    expect(deriveTargetSlug(null, null)).toBeNull();
    expect(deriveTargetSlug(null, "  ")).toBeNull();
  });
});

describe("parseQualityGate", () => {
  test("full from [quality_gate.full].commands; fast falls back to full", () => {
    const qg = parseQualityGate({ stack: "rust", full: { commands: ["cargo test"] }, timeout_minutes_per_cmd: 30 });
    expect(qg.stack).toBe("rust");
    expect(qg.full).toEqual(["cargo test"]);
    expect(qg.fast).toEqual(["cargo test"]);
    expect(qg.timeout_minutes_per_cmd).toBe(30);
  });
  test("legacy top-level `commands` is the alias for full", () => {
    const qg = parseQualityGate({ commands: ["npm test"] });
    expect(qg.full).toEqual(["npm test"]);
    expect(qg.fast).toEqual(["npm test"]);
  });
  test("explicit fast overrides; run_verify captured", () => {
    const qg = parseQualityGate({
      commands: ["npm test"],
      fast: { commands: ["npm run quick"] },
      run_verify_commands: ["npm run smoke"],
    });
    expect(qg.full).toEqual(["npm test"]);
    expect(qg.fast).toEqual(["npm run quick"]);
    expect(qg.run_verify).toEqual(["npm run smoke"]);
  });
  test("empty / missing → empty arrays, null stack/timeout", () => {
    const qg = parseQualityGate(undefined);
    expect(qg.full).toEqual([]);
    expect(qg.fast).toEqual([]);
    expect(qg.run_verify).toEqual([]);
    expect(qg.stack).toBeNull();
    expect(qg.timeout_minutes_per_cmd).toBeNull();
  });
  test("W-068: scoped defaults empty and default_gate 'full' (buildFactPack fills them)", () => {
    const qg = parseQualityGate({ commands: ["cargo test"] });
    expect(qg.scoped).toEqual([]);
    expect(qg.default_gate).toBe("full");
  });
});

describe("buildScopedCommands (W-068/W-040 — per-crate cargo default gate)", () => {
  test("unknown target info → plain cargo test (never errors on bin-only)", () => {
    expect(buildScopedCommands(["acme_cooker_magic"])).toEqual([
      "cargo check -p acme_cooker_magic",
      "cargo test -p acme_cooker_magic",
    ]);
  });
  test("lib crate → --lib, bin-only crate → --bins (W-040)", () => {
    const info = [
      { name: "libby", dir: "core/libby", hasLib: true },
      { name: "binny", dir: "apps/binny", hasLib: false },
    ];
    expect(buildScopedCommands(["libby", "binny"], info)).toEqual([
      "cargo check -p libby",
      "cargo test -p libby --lib",
      "cargo check -p binny",
      "cargo test -p binny --bins",
    ]);
  });
  test("hasLib null in info → plain cargo test", () => {
    const info = [{ name: "murky", dir: "x", hasLib: null }];
    expect(buildScopedCommands(["murky"], info)).toEqual([
      "cargo check -p murky",
      "cargo test -p murky",
    ]);
  });
  test("no packages → empty", () => {
    expect(buildScopedCommands([])).toEqual([]);
  });
});

describe("resolveTouchedPackages (W-068 — dir name → real cargo package name)", () => {
  let root = "";
  beforeAll(() => {
    // A small fixture cargo workspace:
    //   Cargo.toml                      (workspace-only, NO [package])
    //   core/enhance/cooker_magic/Cargo.toml  name = acme_cooker_magic
    //   core/collection/schema/Cargo.toml     name = acme_schema
    root = mkdtempSync(join(tmpdir(), "w068-"));
    writeFileSync(join(root, "Cargo.toml"), '[workspace]\nmembers = ["core/*/*"]\n');
    const magic = join(root, "core", "enhance", "cooker_magic");
    mkdirSync(join(magic, "src"), { recursive: true });
    writeFileSync(join(magic, "Cargo.toml"), '[package]\nname = "acme_cooker_magic"\nversion = "0.1.0"\n');
    writeFileSync(join(magic, "src", "lib.rs"), "// crate\n");
    const schema = join(root, "core", "collection", "schema");
    mkdirSync(join(schema, "src"), { recursive: true });
    writeFileSync(join(schema, "Cargo.toml"), '[package]\nname = "acme_schema"\nversion = "0.1.0"\n');
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("the recurring cooker_magic → acme_cooker_magic fix (glob touch)", () => {
    expect(resolveTouchedPackages(root, ["core/enhance/cooker_magic/**"])).toEqual(["acme_cooker_magic"]);
  });
  test("a specific file path resolves via its ancestor crate", () => {
    expect(resolveTouchedPackages(root, ["core/enhance/cooker_magic/src/lib.rs"])).toEqual(["acme_cooker_magic"]);
  });
  test("multiple touches → union, sorted, de-duped", () => {
    expect(
      resolveTouchedPackages(root, ["core/enhance/cooker_magic/src/**", "core/collection/schema/Cargo.toml"]),
    ).toEqual(["acme_cooker_magic", "acme_schema"]);
  });
  test("a prefix ABOVE crates walks down to enumerate them", () => {
    expect(resolveTouchedPackages(root, ["core/**"]).sort()).toEqual(["acme_cooker_magic", "acme_schema"]);
  });
  test("no touches / non-cargo / missing project → [] (fail-open)", () => {
    expect(resolveTouchedPackages(root, [])).toEqual([]);
    expect(resolveTouchedPackages("", ["core/**"])).toEqual([]);
    expect(resolveTouchedPackages(root, ["does/not/exist/**"])).toEqual([]);
  });
  test("forward-slash projectRoot + deep file path still resolves (separator normalization)", () => {
    // Real dispatch passes a forward-slash --project; the crate is several levels
    // above the touched file, so the walk-up boundary check must survive the
    // separator mismatch pathJoin/win32 would otherwise introduce.
    const fwd = root.replace(/\\/g, "/");
    expect(resolveTouchedPackages(fwd, ["core/enhance/cooker_magic/src/lib.rs"])).toEqual(["acme_cooker_magic"]);
  });
});

describe("W-090 touches verification (correct / warn / skip against cargo metadata)", () => {
  // A fake `cargo metadata --no-deps` document for a workspace rooted at `root`.
  // manifest_path is absolute (as cargo emits), so parseCargoMetadata recovers the
  // root-relative dir. workspace_members lists every id so the members filter passes.
  const fakeMetadata = (root: string, crates: Array<{ name: string; dir: string }>): string => {
    const packages = crates.map((c) => ({
      id: `path+file://${root}/${c.dir}#${c.name}@0.1.0`,
      name: c.name,
      manifest_path: join(root, ...c.dir.split("/"), "Cargo.toml"),
    }));
    return JSON.stringify({ packages, workspace_members: packages.map((p) => p.id) });
  };

  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "w090-"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  describe("parseCargoMetadata", () => {
    test("recovers {name, root-relative posix dir} for each workspace package", () => {
      const pkgs = parseCargoMetadata(
        fakeMetadata(root, [
          { name: "acme_bootstrap", dir: "core/engine/bootstrap" },
          { name: "acme_schema", dir: "core/collection/schema" },
        ]),
        root,
      );
      expect(pkgs).toEqual([
        { name: "acme_bootstrap", dir: "core/engine/bootstrap", hasLib: null },
        { name: "acme_schema", dir: "core/collection/schema", hasLib: null },
      ]);
    });
    test("garbage / empty / no-packages → null (skip verification, fail-open)", () => {
      expect(parseCargoMetadata("{ not json", root)).toBeNull();
      expect(parseCargoMetadata(JSON.stringify({ packages: [] }), root)).toBeNull();
      expect(parseCargoMetadata(JSON.stringify({ nope: 1 }), root)).toBeNull();
    });
    test("a full-metadata doc (deps included) keeps only workspace_members", () => {
      const meta = JSON.parse(fakeMetadata(root, [{ name: "acme_schema", dir: "core/collection/schema" }]));
      // inject a dependency crate that is NOT a workspace member
      meta.packages.push({ id: "registry+dep#serde@1", name: "serde", manifest_path: "/ext/serde/Cargo.toml" });
      const pkgs = parseCargoMetadata(JSON.stringify(meta), root);
      expect(pkgs?.map((p) => p.name)).toEqual(["acme_schema"]);
    });
  });

  describe("verifyTouchedPackages — the 3 branches", () => {
    // The real workspace layout the #178/#180/#179 harms happened against.
    const pkgs = () =>
      parseCargoMetadata(
        fakeMetadata(root, [
          { name: "acme_bootstrap", dir: "core/engine/bootstrap" },
          { name: "acme_schema", dir: "core/collection/schema" },
          { name: "acme_render", dir: "core/middleware/render" },
          { name: "acme_obs", dir: "core/middleware/observability" },
          { name: "acme_loader", dir: "core/middleware/loader" },
        ]),
        root,
      )!;

    test("CORRECT: a stale/wrong path (#178 core/driver/bootstrap) → canonical core/engine/bootstrap", () => {
      const v = verifyTouchedPackages(root, ["core/driver/bootstrap/**"], pkgs());
      expect(v.touches).toEqual(["core/engine/bootstrap"]); // corrected to the crate's real dir
      expect(v.touched_packages).toEqual(["acme_bootstrap"]);
      expect(v.touches_unverified).toEqual([]);
    });

    test("a valid ON/UNDER-crate touch is kept verbatim (not rewritten)", () => {
      const v = verifyTouchedPackages(root, ["core/collection/schema/src/lib.rs"], pkgs());
      expect(v.touches).toEqual(["core/collection/schema/src/lib.rs"]);
      expect(v.touched_packages).toEqual(["acme_schema"]);
      expect(v.touches_unverified).toEqual([]);
    });

    test("WARN: an unresolvable touch is kept in touches_unverified, never dropped (#179)", () => {
      const v = verifyTouchedPackages(root, ["docs/old/observability_path/**"], pkgs());
      expect(v.touches).toEqual([]);
      expect(v.touched_packages).toEqual([]);
      expect(v.touches_unverified).toEqual(["docs/old/observability_path/**"]);
    });

    test("#180: a 5-crate cross-crate task resolves ALL five (no silent drop of 3)", () => {
      const v = verifyTouchedPackages(
        root,
        [
          "core/engine/bootstrap/**", // member
          "core/driver/schema/**", // wrong path → corrected (basename schema)
          "core/middleware/render/**", // member
          "observability/**", // wrong path → corrected (basename observability)
          "core/middleware/loader/**", // member
        ],
        pkgs(),
      );
      expect(v.touched_packages).toEqual([
        "acme_bootstrap",
        "acme_loader",
        "acme_obs",
        "acme_render",
        "acme_schema",
      ]);
      expect(v.touches_unverified).toEqual([]);
    });

    test("an ancestor prefix (core/**) enumerates the crates under it", () => {
      const v = verifyTouchedPackages(root, ["core/**"], pkgs());
      expect(v.touches).toEqual(["core/**"]); // kept verbatim
      expect(v.touched_packages).toEqual([
        "acme_bootstrap",
        "acme_loader",
        "acme_obs",
        "acme_render",
        "acme_schema",
      ]);
    });

    test("an AMBIGUOUS basename (two crates share it) is NOT auto-corrected → unverified", () => {
      const two = parseCargoMetadata(
        fakeMetadata(root, [
          { name: "a_util", dir: "a/util" },
          { name: "b_util", dir: "b/util" },
        ]),
        root,
      )!;
      const v = verifyTouchedPackages(root, ["wrong/util/**"], two);
      expect(v.touches).toEqual([]);
      expect(v.touched_packages).toEqual([]);
      expect(v.touches_unverified).toEqual(["wrong/util/**"]);
    });

    test("SKIP: packages=null → touches pass through, packages via the fs walk (pre-W-090)", () => {
      // A real crate on disk so the fs-walk fallback resolves it exactly as before.
      const skip = mkdtempSync(join(tmpdir(), "w090-skip-"));
      const crate = join(skip, "pkg", "foo");
      mkdirSync(crate, { recursive: true });
      writeFileSync(join(crate, "Cargo.toml"), '[package]\nname = "acme_foo"\nversion = "0.1.0"\n');
      try {
        const v = verifyTouchedPackages(skip, ["pkg/foo/**"], null);
        expect(v.touches).toEqual(["pkg/foo/**"]); // unchanged
        expect(v.touched_packages).toEqual(["acme_foo"]); // fs walk (resolveTouchedPackages)
        expect(v.touches_unverified).toEqual([]);
      } finally {
        rmSync(skip, { recursive: true, force: true });
      }
    });

    test("no declared touches → all empty", () => {
      expect(verifyTouchedPackages(root, [], pkgs())).toEqual({
        touches: [],
        touched_packages: [],
        touches_unverified: [],
      });
    });
  });

  describe("cargoPackages", () => {
    test("a project with no root Cargo.toml → null (non-cargo → skip)", () => {
      const nonCargo = mkdtempSync(join(tmpdir(), "w090-noncargo-"));
      try {
        expect(cargoPackages(nonCargo)).toBeNull();
      } finally {
        rmSync(nonCargo, { recursive: true, force: true });
      }
    });
    test("GARELIER_CARGO_METADATA_FILE seam is used instead of spawning cargo", () => {
      const f = join(root, "metadata.json");
      writeFileSync(f, fakeMetadata(root, [{ name: "acme_schema", dir: "core/collection/schema" }]));
      const prev = process.env.GARELIER_CARGO_METADATA_FILE;
      process.env.GARELIER_CARGO_METADATA_FILE = f;
      try {
        expect(cargoPackages(root)).toEqual([{ name: "acme_schema", dir: "core/collection/schema", hasLib: null }]);
      } finally {
        if (prev === undefined) delete process.env.GARELIER_CARGO_METADATA_FILE;
        else process.env.GARELIER_CARGO_METADATA_FILE = prev;
      }
    });
  });

  test("buildFactPack: touches_unverified flows through (default [])", () => {
    const config = { branches: { target: "main" }, quality_gate: { commands: ["cargo test"] } };
    const withUnv = buildFactPack({
      pmId: "pm",
      projectRoot: "/p",
      config,
      task: { id: 1, role: "worker", touches: ["core/engine/bootstrap"] },
      touchedPackages: ["acme_bootstrap"],
      touchesUnverified: ["docs/old/path/**"],
    });
    expect(withUnv.task.touches_unverified).toEqual(["docs/old/path/**"]);
    const none = buildFactPack({ pmId: "pm", projectRoot: "/p", config });
    expect(none.task.touches_unverified).toEqual([]);
  });
});

describe("resolveBashTimeoutBudgetMs (W-077 — effective bash timeout budget, read precedence)", () => {
  test("reports official fallback source and read-only semantics", () => {
    expect(resolveBashTimeoutContext("", {})).toEqual({
      foreground_default_ms: 120000,
      effective_request_ceiling_ms: 600000,
      foreground_source: "claude-official-defaults",
      ceiling_source: "claude-official-defaults",
      source: "claude-official-defaults",
      read_only: true,
    });
  });
  let root = "";
  const claude = () => join(root, ".claude");
  const writeLocal = (ms: number | string) =>
    writeFileSync(join(claude(), "settings.local.json"), JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: String(ms) } }));
  const writeShared = (ms: number | string) =>
    writeFileSync(join(claude(), "settings.json"), JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: String(ms) } }));

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "w077-"));
    mkdirSync(claude(), { recursive: true });
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("no settings, no env → documented 600000 fallback", () => {
    // (no settings files written; clean env)
    expect(resolveBashTimeoutBudgetMs(root, {})).toBe(600000);
    expect(DEFAULT_BASH_TIMEOUT_BUDGET_MS).toBe(600000);
  });

  test("process env used when no settings files present", () => {
    expect(resolveBashTimeoutBudgetMs(root, { BASH_MAX_TIMEOUT_MS: "1800000" })).toBe(1800000);
  });

  test("settings.json (shared) beats process env", () => {
    writeShared(2400000);
    expect(resolveBashTimeoutBudgetMs(root, { BASH_MAX_TIMEOUT_MS: "1800000" })).toBe(2400000);
  });

  test("settings.local.json (project-local) beats settings.json and env — top precedence", () => {
    writeShared(2400000);
    writeLocal(3000000);
    expect(resolveBashTimeoutBudgetMs(root, { BASH_MAX_TIMEOUT_MS: "1800000" })).toBe(3000000);
  });

  test("fail-open: unparseable settings.local.json is skipped, falls through to shared", () => {
    writeFileSync(join(claude(), "settings.local.json"), "{ not json");
    writeShared(2400000);
    expect(resolveBashTimeoutBudgetMs(root, {})).toBe(2400000);
  });

  test("fail-open: a non-positive / non-numeric value is ignored (falls through)", () => {
    rmSync(join(claude(), "settings.local.json"), { force: true });
    rmSync(join(claude(), "settings.json"), { force: true });
    expect(resolveBashTimeoutBudgetMs(root, { BASH_MAX_TIMEOUT_MS: "0" })).toBe(600000);
    expect(resolveBashTimeoutBudgetMs(root, { BASH_MAX_TIMEOUT_MS: "nope" })).toBe(600000);
  });

  test("empty projectRoot → env or fallback only (no fs read)", () => {
    expect(resolveBashTimeoutBudgetMs("", {})).toBe(600000);
    expect(resolveBashTimeoutBudgetMs("", { BASH_MAX_TIMEOUT_MS: "900000" })).toBe(900000);
  });

  test("default and max resolve independently across local/shared/env sources", () => {
    writeFileSync(join(claude(), "settings.local.json"), JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: "300000" } }));
    writeFileSync(join(claude(), "settings.json"), JSON.stringify({ env: { BASH_DEFAULT_TIMEOUT_MS: "180000" } }));
    expect(resolveBashTimeoutContext(root, { BASH_DEFAULT_TIMEOUT_MS: "150000", BASH_MAX_TIMEOUT_MS: "900000" })).toEqual({
      foreground_default_ms: 180000,
      effective_request_ceiling_ms: 300000,
      foreground_source: "project-settings-read-only",
      ceiling_source: "project-settings-local-read-only",
      source: "project-settings-local-read-only",
      read_only: true,
    });
  });

  test("invalid keys fall through independently and foreground is capped by max", () => {
    writeFileSync(join(claude(), "settings.local.json"), JSON.stringify({ env: { BASH_DEFAULT_TIMEOUT_MS: "invalid", BASH_MAX_TIMEOUT_MS: "240000" } }));
    writeFileSync(join(claude(), "settings.json"), JSON.stringify({ env: { BASH_DEFAULT_TIMEOUT_MS: "900000", BASH_MAX_TIMEOUT_MS: "invalid" } }));
    expect(resolveBashTimeoutContext(root, { BASH_DEFAULT_TIMEOUT_MS: "180000", BASH_MAX_TIMEOUT_MS: "800000" })).toEqual({
      foreground_default_ms: 240000,
      effective_request_ceiling_ms: 240000,
      foreground_source: "project-settings-read-only+capped-by:project-settings-local-read-only",
      ceiling_source: "project-settings-local-read-only",
      source: "project-settings-local-read-only",
      read_only: true,
    });
  });

  test("process env supplies both keys read-only when settings are absent", () => {
    rmSync(join(claude(), "settings.local.json"), { force: true });
    rmSync(join(claude(), "settings.json"), { force: true });
    expect(resolveBashTimeoutContext(root, { BASH_DEFAULT_TIMEOUT_MS: "150000", BASH_MAX_TIMEOUT_MS: "360000" })).toMatchObject({
      foreground_default_ms: 150000,
      effective_request_ceiling_ms: 360000,
      foreground_source: "process-env-read-only",
      ceiling_source: "process-env-read-only",
      read_only: true,
    });
  });
});

describe("parseAnchors (blueprint Context pack, DEC-071)", () => {
  const bp = [
    "# Blueprint",
    "## Goal",
    "do a thing",
    "## Context pack",
    "- Entry points: src/a.ts:42 — the handler",
    "- Invariants: the queue stays FIFO",
    "- Local verify: bun test src/a.test.ts",
    "## Functional requirements",
    "- stuff",
  ].join("\n");

  test("extracts the three anchors and marks filled", () => {
    const a = parseAnchors(bp, "BP.md");
    expect(a.entry_points).toBe("src/a.ts:42 — the handler");
    expect(a.invariants).toBe("the queue stays FIFO");
    expect(a.local_verify).toBe("bun test src/a.test.ts");
    expect(a.filled).toBe(true);
    expect(a.source).toBe("BP.md");
  });

  test("unfilled {{placeholder}} counts as missing", () => {
    const md = ["## Context pack", "- Entry points: {{path}}", "- Invariants: real invariant", "## Next"].join("\n");
    const a = parseAnchors(md, null);
    expect(a.entry_points).toBeNull();
    expect(a.invariants).toBe("real invariant");
    expect(a.filled).toBe(true); // invariants is filled
  });

  test("no Context pack section → all null, filled false", () => {
    const a = parseAnchors("# Blueprint\n## Goal\nx\n", null);
    expect(a.entry_points).toBeNull();
    expect(a.invariants).toBeNull();
    expect(a.local_verify).toBeNull();
    expect(a.filled).toBe(false);
  });

  test("Context pack as the LAST section (no following heading) still parses", () => {
    const md = ["## Goal", "g", "## Context pack", "- Entry points: only/path.ts"].join("\n");
    const a = parseAnchors(md, null);
    expect(a.entry_points).toBe("only/path.ts");
  });
});

describe("buildGateAgents (W-040 — same names/paths dispatch_prepare.ts emits)", () => {
  test("derives ga-guardian-<slug> / ga-observer-<slug> + runtime results paths + verdict_template", () => {
    const g = buildGateAgents("do-x");
    expect(g).toEqual({
      guardian: { name: "ga-guardian-do-x", report: "runtime/guardian/results/do-x-guardian.md", verdict_template: GATE_VERDICT_TEMPLATE },
      observer: { name: "ga-observer-do-x", report: "runtime/observer/results/do-x-observer.md", verdict_template: GATE_VERDICT_TEMPLATE },
    });
  });
  // W-020: the emitted `report` path MUST equal the path contract_check.ts --gate
  // (checkGate) and scanIdleNoRegister/gateVerdictPublished read, else the marker
  // the gate role writes and the marker the checker looks for drift apart. Pin the
  // exact runtime/<role>/results/<slug>-<role>.md shape both sides construct.
  test("report path matches the contract_check gate-verdict formula (single canonical path)", () => {
    const slug = "do-x";
    const g = buildGateAgents(slug)!;
    for (const role of ["guardian", "observer"] as const) {
      expect(g[role].report).toBe(`runtime/${role}/results/${slug}-${role}.md`);
    }
  });
  test("verdict_template points at the canonical gate_verdict.md template", () => {
    expect(GATE_VERDICT_TEMPLATE).toBe("skills/garelier-core/templates/gate_verdict.md");
  });
  test("null slug -> null (nothing to derive a name from)", () => {
    expect(buildGateAgents(null)).toBeNull();
  });
});

describe("buildCommitTemplate (W-051 — ready-to-copy Garelier trailer)", () => {
  test("fills pm_id, <role>#<id> actor, and #<id> item id; subject stays a placeholder", () => {
    const t = buildCommitTemplate("acme", "worker", 162);
    expect(t).toBe("<type>(<scope>): <summary>  [#162]\n\nGarelier: acme worker#162 #162");
  });
  test("null when role or id is absent", () => {
    expect(buildCommitTemplate("pm", null, 1)).toBeNull();
    expect(buildCommitTemplate("pm", "worker", null)).toBeNull();
  });
});

describe("buildFactPack", () => {
  test("carries the dispatch permission profile and concrete fence roots", () => {
    const p = buildFactPack({
      pmId: "pm",
      projectRoot: "/p",
      task: { role: "worker" },
      guard: { permission_profile: "producer", fence_roots: ["/p/worktree"], worktree: "/p/worktree" },
    });
    expect(p.guard).toEqual({
      permission_profile: "producer",
      fence_roots: ["/p/worktree"],
      role: "worker",
      agent_name: null,
      worktree: "/p/worktree",
    });
  });
  const config = {
    branches: { target: "develop/soft", target_slug: "develop-soft", integration: "garelier/develop-soft/pm/studio" },
    quality_gate: { stack: "rust", commands: ["cargo test"], timeout_minutes_per_cmd: 60 },
  };

  test("assembles project facts + task + gate; advisory flag set", () => {
    const p = buildFactPack({
      pmId: "pm",
      projectRoot: "/proj",
      integration: "garelier/develop-soft/pm/studio",
      config,
      task: { id: 7, role: "worker", slug: "do-x", branch: "garelier/develop-soft/pm/workbench/#7/do-x", base_sha: "abc123" },
    });
    expect(p.advisory).toBe(true);
    expect(p.kind).toBe("dispatch_fact_pack");
    expect(p.project.target).toBe("develop/soft");
    expect(p.project.target_slug).toBe("develop-soft");
    expect(p.project.target_branch).toBe("develop/soft");
    expect(p.project.integration_branch).toBe("garelier/develop-soft/pm/studio");
    expect(p.quality_gate.full).toEqual(["cargo test"]);
    expect(p.task.id).toBe(7);
    expect(p.task.base_branch).toBe("garelier/develop-soft/pm/studio"); // defaults to integration
    expect(p.task.base_sha).toBe("abc123");
    expect(p.gate_agents).toEqual({
      guardian: { name: "ga-guardian-do-x", report: "runtime/guardian/results/do-x-guardian.md", verdict_template: GATE_VERDICT_TEMPLATE },
      observer: { name: "ga-observer-do-x", report: "runtime/observer/results/do-x-observer.md", verdict_template: GATE_VERDICT_TEMPLATE },
    });
    expect(p.commit_template).toBe("<type>(<scope>): <summary>  [#7]\n\nGarelier: pm worker#7 #7");
    // bug_fix_discipline (W-052): constant pointer, present on every dispatch.
    expect(p.bug_fix_discipline).toContain("garelier-core/references/debugging_discipline.md");
    expect(p.bug_fix_discipline).toContain("root cause only");
    // bash_timeout_budget_ms (W-077): defaults to the documented ceiling when the
    // resolver did not pass one in.
    expect(p.bash_timeout_budget_ms).toBe(600000);
  });

  test("W-077: bashTimeoutBudgetMs input is forward-supplied verbatim", () => {
    const p = buildFactPack({ pmId: "pm", projectRoot: "/p", config, bashTimeoutBudgetMs: 2400000 });
    expect(p.bash_timeout_budget_ms).toBe(2400000);
  });

  test("W-068: touchedPackages → task.touched_packages + scoped gate + default_gate 'scoped'", () => {
    const p = buildFactPack({
      pmId: "pm",
      projectRoot: "/p",
      config,
      task: { id: 3, role: "worker", slug: "fix", touches: ["core/enhance/cooker_magic/**"] },
      touchedPackages: ["acme_cooker_magic"],
    });
    expect(p.task.touched_packages).toEqual(["acme_cooker_magic"]);
    expect(p.quality_gate.scoped).toEqual([
      "cargo check -p acme_cooker_magic",
      "cargo test -p acme_cooker_magic",
    ]);
    expect(p.quality_gate.default_gate).toBe("scoped");
    // full is still forward-supplied (merge gate territory), just not the default.
    expect(p.quality_gate.full).toEqual(["cargo test"]);
  });

  test("W-068: no resolved packages → scoped empty, default_gate falls back to 'full'", () => {
    const p = buildFactPack({ pmId: "pm", projectRoot: "/p", config, task: { id: 4, role: "worker" } });
    expect(p.task.touched_packages).toEqual([]);
    expect(p.quality_gate.scoped).toEqual([]);
    expect(p.quality_gate.default_gate).toBe("full");
  });

  test("W-068: --full-gate opt-in forces default_gate 'full' even with resolved packages", () => {
    const p = buildFactPack({
      pmId: "pm",
      projectRoot: "/p",
      config,
      task: { id: 5, role: "worker" },
      touchedPackages: ["acme_cooker_magic"],
      fullGate: true,
    });
    expect(p.quality_gate.scoped.length).toBeGreaterThan(0); // still supplied
    expect(p.quality_gate.default_gate).toBe("full");
  });

  test("W-053: touches/depends_on forward-supplied under task; default to empty", () => {
    const withDecl = buildFactPack({
      pmId: "pm",
      projectRoot: "/p",
      config,
      task: { id: 9, role: "worker", slug: "x", touches: ["src/**"], depends_on: ["#8"] },
    });
    expect(withDecl.task.touches).toEqual(["src/**"]);
    expect(withDecl.task.depends_on).toEqual(["#8"]);
    const noDecl = buildFactPack({ pmId: "pm", projectRoot: "/p", config });
    expect(noDecl.task.touches).toEqual([]);
    expect(noDecl.task.depends_on).toEqual([]);
  });

  test("W-087: resource_class/runtime_effect forward-supplied under task; default to light/none", () => {
    const withFields = buildFactPack({
      pmId: "pm",
      projectRoot: "/p",
      config,
      task: { id: 9, role: "worker", slug: "x", resource_class: "heavy", runtime_effect: "visual" },
    });
    expect(withFields.task.resource_class).toBe("heavy");
    expect(withFields.task.runtime_effect).toBe("visual");
    // buildFactPack is pure: an omitting caller falls back to the least-constraining
    // defaults (the CLI boundary is where the warning fires).
    const noFields = buildFactPack({ pmId: "pm", projectRoot: "/p", config });
    expect(noFields.task.resource_class).toBe("light");
    expect(noFields.task.runtime_effect).toBe("none");
  });

  test("explicit --integration wins over config", () => {
    const p = buildFactPack({ pmId: "pm", projectRoot: "/p", integration: "OVERRIDE/studio", config });
    expect(p.project.integration_branch).toBe("OVERRIDE/studio");
  });

  test("fail-open: null config → unknown facts, no throw, advisory note present", () => {
    const p = buildFactPack({ pmId: "pm", projectRoot: "/p", config: null });
    expect(p.project.target).toBeNull();
    expect(p.project.target_slug).toBeNull();
    expect(p.quality_gate.full).toEqual([]);
    expect(p.anchors.filled).toBe(false);
    expect(p.note).toContain("advisory");
    expect(p.gate_agents).toBeNull(); // no task.slug supplied
    // bug_fix_discipline is a constant, so it survives a null config / task.
    expect(p.bug_fix_discipline).toContain("debugging_discipline.md");
  });

  test("W-084(c): note is pointer-form and stays compact (no re-inlined hot-rules)", () => {
    const p = buildFactPack({ pmId: "pm", projectRoot: "/p", config });
    // Still advisory (the fail-open contract above).
    expect(p.note).toContain("advisory");
    // It POINTS at the authoritative homes instead of restating the rules —
    // the same rules the role SKILL / these references already carry and the
    // producer already reads, so reachability is unchanged (W-084(c)).
    expect(p.note).toContain("role_subagent_dispatch.md §6"); // W-077 budget / watch+wake
    expect(p.note).toContain("output_control.md");            // W-042 / W-043b register + run_summarized
    expect(p.note).toContain("SKILL");                        // role SKILL boundaries (W-034/037/068)
    // Regression guard: the note was 1,668 B of inlined hot-rules before
    // W-084(c) and every dispatch pays for it — keep it a compact pointer.
    expect(Buffer.byteLength(p.note, "utf8")).toBeLessThan(1100);
  });

  test("derives target_slug when config omits it", () => {
    const p = buildFactPack({
      pmId: "pm",
      projectRoot: "/p",
      config: { branches: { target: "release/2.0" } },
    });
    expect(p.project.target_slug).toBe("release-2.0");
  });
});
