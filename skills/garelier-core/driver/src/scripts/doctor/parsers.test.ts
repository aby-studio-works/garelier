import { describe, expect, test } from "bun:test";
import {
  toLines,
  readToml,
  tomlSectionPresent,
  tomlArrayBody,
  tomlArrayCount,
  listAgentIds,
  agentWorktreeForId,
  agentCheckoutForId,
  wsPointerKeyD,
  workspacePointerValue,
  pidFromContent,
  jsonStringField,
  crustContainerPaths,
  riskyProviderInTable,
} from "./parsers.ts";

const CFG = `[project]
name = "Demo"
garelier_version = "2.10.0"

[pm]
pm_id = "p1"

[[workers]]
id = "worker-01"
provider = "claude-code"
worktree = "__garelier/p1/_workers/worker-01"

[[workers]]
id = "worker-02"
provider = "gemini-cli"
worktree = "__garelier/p1/_workers/worker-02"

[quality_gate]
stack = "custom"
commands = [
    "cargo check",  # inline comment "with quotes"
    # "npm ci",
    "cargo test",
]

[permissions]
profile = "dangerous"   # trailing comment
require_pm_approval_paths = []

[[guardians]]
id = "guardian-01"
checkout = false
`;

describe("toLines", () => {
  test("trailing newline does not create an empty record; interior blank does", () => {
    expect(toLines("a\nb\n")).toEqual(["a", "b"]);
    expect(toLines("a\nb")).toEqual(["a", "b"]);
    expect(toLines("a\n\nb\n")).toEqual(["a", "", "b"]);
    expect(toLines("")).toEqual([]);
  });
});

describe("readToml", () => {
  test("scalar read, quote + trailing-comment strip", () => {
    expect(readToml(CFG, "project", "name")).toBe("Demo");
    expect(readToml(CFG, "project", "garelier_version")).toBe("2.10.0");
    expect(readToml(CFG, "permissions", "profile")).toBe("dangerous");
    expect(readToml(CFG, "quality_gate", "stack")).toBe("custom");
  });
  test("absent key/section -> empty string", () => {
    expect(readToml(CFG, "project", "nope")).toBe("");
    expect(readToml(CFG, "nosuch", "x")).toBe("");
  });
  test("only the matching bare [section] header counts (not a subsection)", () => {
    const c = `[a]\nk = "1"\n[a.sub]\nk = "2"\n`;
    expect(readToml(c, "a", "k")).toBe("1");
    expect(readToml(c, "a.sub", "k")).toBe("2");
  });
});

describe("tomlSectionPresent", () => {
  test("bare header only", () => {
    expect(tomlSectionPresent(CFG, "permissions")).toBe(true);
    expect(tomlSectionPresent(CFG, "quality_gate.full")).toBe(false);
    expect(tomlSectionPresent(CFG, "workers")).toBe(false); // [[workers]] is not [workers]
  });
});

describe("tomlArrayBody / tomlArrayCount", () => {
  test("multi-line array body captured through closing bracket", () => {
    const body = tomlArrayBody(CFG, "quality_gate", "commands");
    expect(body[0]).toBe("commands = [");
    expect(body[body.length - 1]).toBe("]");
  });
  test("count ignores commented elements but counts inline-commented quoted strings only before #", () => {
    // "cargo check" (the inline `# comment "with quotes"` part is stripped),
    // the fully-commented `# "npm ci"` line contributes 0, "cargo test" = 2.
    expect(tomlArrayCount(CFG, "quality_gate", "commands")).toBe(2);
  });
  test("empty array -> 0", () => {
    expect(tomlArrayCount(CFG, "permissions", "require_pm_approval_paths")).toBe(0);
  });
});

describe("listAgentIds", () => {
  test("ids from every [[section]] block", () => {
    expect(listAgentIds(CFG, "workers")).toEqual(["worker-01", "worker-02"]);
    expect(listAgentIds(CFG, "guardians")).toEqual(["guardian-01"]);
    expect(listAgentIds(CFG, "scouts")).toEqual([]);
  });
  test("a [[block]] with no id line yields no id", () => {
    expect(listAgentIds("[[guardians]]\n", "guardians")).toEqual([]);
  });
});

describe("agentWorktreeForId / agentCheckoutForId", () => {
  test("worktree resolved per id", () => {
    expect(agentWorktreeForId(CFG, "workers", "worker-02")).toBe("__garelier/p1/_workers/worker-02");
    expect(agentWorktreeForId(CFG, "workers", "nope")).toBe("");
  });
  test("checkout bare-bool with whitespace stripped", () => {
    expect(agentCheckoutForId(CFG, "guardians", "guardian-01")).toBe("false");
    expect(agentCheckoutForId(CFG, "workers", "worker-01")).toBe("");
  });
});

describe("wsPointerKeyD", () => {
  test("plural role -> singular.id, artisan special", () => {
    expect(wsPointerKeyD("workers", "worker-01")).toBe("worker.worker-01");
    expect(wsPointerKeyD("concierges", "c1")).toBe("concierge.c1");
    expect(wsPointerKeyD("artisan", "")).toBe("artisan");
    expect(wsPointerKeyD("gnomes", "g1")).toBe("gnome.g1"); // ${1%s} fallback
  });
});

describe("workspacePointerValue", () => {
  test("value after first line starting with key=", () => {
    const pf = "worker.worker-01=C:/exiled/worker-01\nartisan=C:/exiled/artisan\n";
    expect(workspacePointerValue(pf, "worker.worker-01")).toBe("C:/exiled/worker-01");
    expect(workspacePointerValue(pf, "artisan")).toBe("C:/exiled/artisan");
    expect(workspacePointerValue(pf, "missing")).toBeUndefined();
  });
});

describe("pidFromContent", () => {
  test("pure-number file", () => {
    expect(pidFromContent("999999\n")).toBe("999999");
  });
  test("json pid / child_pid", () => {
    expect(pidFromContent('{"owner":"dock","pid":1234}\n')).toBe("1234");
    expect(pidFromContent('{"child_pid": 55}')).toBe("55");
  });
  test("no pid -> empty", () => {
    expect(pidFromContent('{"owner":"dock"}')).toBe("");
  });
});

describe("jsonStringField", () => {
  test("first matching string field", () => {
    expect(jsonStringField('{"owner":"dock","operation_kind":"push"}', "owner")).toBe("dock");
    expect(jsonStringField('{"operation_kind": "sync_remote"}', "operation_kind")).toBe("sync_remote");
    expect(jsonStringField("{}", "owner")).toBe("");
  });
});

describe("crustContainerPaths", () => {
  test("id/path rows; path defaults to id", () => {
    const c = `[[containers]]
id = "main"
path = "c1"

[[containers]]
id = "solo"
`;
    expect(crustContainerPaths(c)).toEqual([
      { id: "main", path: "c1" },
      { id: "solo", path: "solo" },
    ]);
  });
});

describe("riskyProviderInTable", () => {
  test("gemini/cursor values, sorted-unique, trailing space each", () => {
    expect(riskyProviderInTable(CFG, "workers")).toBe("gemini-cli ");
    expect(riskyProviderInTable(CFG, "guardians")).toBe("");
  });
});
