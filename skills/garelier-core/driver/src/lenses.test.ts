import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LENS_REFS,
  formatLensRef,
  parseBlueprintLensSelection,
  parseDefaultLensSetFromSetupConfig,
  parseLensPackToml,
  parseLensRef,
  parseLensRegistryToml,
  renderEquippedLensSection,
  validateLensPack,
  validateLensRegistry,
  validateLensSelection,
} from "./lenses.ts";

const registryToml = `
schema_version = 1
kind = "garelier_lens_registry"

[[packs]]
id = "worker.implementation"
role = "worker"
path = "lenses/worker.implementation.toml"
status = "active"
default_group = "minimal_patch"

[[packs]]
id = "guardian.risk_control"
role = "guardian"
path = "lenses/guardian.risk_control.toml"
status = "active"
default_group = "strict"
`;

const workerPackToml = `
[lens_pack]
id = "worker.implementation"
role = "worker"
schema_version = 1
status = "active"
description = "Worker implementation focus."

[[groups]]
id = "minimal_patch"
status = "active"
label = "Minimal patch"
description = "Prefer a small, local change."

[groups.focus]
primary = "minimal_change"
secondary = "existing_patterns"

[groups.limits]
may_not_override_role_contract = true
may_not_relax_must_block = true
`;

const guardianPackToml = `
[lens_pack]
id = "guardian.risk_control"
role = "guardian"
schema_version = 1
status = "active"
description = "Guardian safety focus."

[[groups]]
id = "strict"
status = "active"
label = "Strict"
description = "Block on ambiguity."

[groups.focus]
primary = "safety"

[groups.decision]
default_on_ambiguity = "block"

[groups.limits]
may_not_override_role_contract = true
may_not_relax_must_block = true
may_not_fix_code = true
`;

describe("Lens refs and selections", () => {
  test("parses pack:group refs and blueprint Lens selection", () => {
    expect(formatLensRef(parseLensRef("`worker.implementation:minimal_patch`")!)).toBe("worker.implementation:minimal_patch");
    const selection = parseBlueprintLensSelection([
      "# Blueprint",
      "",
      "## Lens selection",
      "- Source: explicit",
      "- Worker: `worker.implementation:minimal_patch`",
      "- Guardian: `guardian.risk_control:strict`",
      "",
      "## Acceptance criteria",
      "- done",
    ].join("\n"));
    expect(selection.source).toBe("explicit");
    expect(formatLensRef(selection.byRole.get("worker")!)).toBe("worker.implementation:minimal_patch");
    expect(formatLensRef(selection.byRole.get("guardian")!)).toBe("guardian.risk_control:strict");
  });

  test("parses default Lens Set from setup_config.toml", () => {
    const selection = parseDefaultLensSetFromSetupConfig(`
[lenses.defaults]
worker = "${DEFAULT_LENS_REFS.worker}"
guardian = "${DEFAULT_LENS_REFS.guardian}"
`);
    expect(selection.source).toBe("defaults");
    expect(formatLensRef(selection.byRole.get("worker")!)).toBe(DEFAULT_LENS_REFS.worker);
  });
});

describe("Lens registry validation", () => {
  test("validates registry, packs, and selections", () => {
    const registry = parseLensRegistryToml(registryToml);
    const packs = new Map([
      ["worker.implementation", parseLensPackToml(workerPackToml)],
      ["guardian.risk_control", parseLensPackToml(guardianPackToml)],
    ]);
    const issues = validateLensRegistry(registry, (path) => {
      if (path.includes("worker")) return packs.get("worker.implementation")!;
      if (path.includes("guardian")) return packs.get("guardian.risk_control")!;
      return null;
    });
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);

    const selection = parseBlueprintLensSelection([
      "## Lens selection",
      "- Source: explicit",
      "- Worker: `worker.implementation:minimal_patch`",
      "- Guardian: `guardian.risk_control:strict`",
    ].join("\n"));
    expect(validateLensSelection(selection, registry, packs).filter((i) => i.level === "error")).toHaveLength(0);
  });

  test("rejects role mismatch and forbidden authority fields", () => {
    const registry = parseLensRegistryToml(registryToml);
    const badPack = parseLensPackToml(workerPackToml.replace("[groups.limits]", "[groups.limits]\nallow_promote = true"));
    const packIssues = validateLensPack(badPack);
    expect(packIssues.some((i) => i.code === "forbidden-field")).toBe(true);

    const packs = new Map([
      ["worker.implementation", parseLensPackToml(workerPackToml)],
      ["guardian.risk_control", parseLensPackToml(guardianPackToml)],
    ]);
    const selection = parseBlueprintLensSelection([
      "## Lens selection",
      "- Guardian: `worker.implementation:minimal_patch`",
    ].join("\n"));
    expect(validateLensSelection(selection, registry, packs).some((i) => i.code === "selection-role-mismatch")).toBe(true);
  });

  test("renders assignment Equipped lens section without changing authority", () => {
    const section = renderEquippedLensSection("worker", parseLensRef("worker.implementation:minimal_patch"), "blueprint");
    expect(section).toContain("## Equipped lens");
    expect(section).toContain("Lens Group: `worker.implementation:minimal_patch`");
    expect(section).toContain("Contract override: forbidden");
  });
});
