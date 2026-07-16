// W-083 ts-first: parity tests for the setup_wizard foundation modules.
//
// The resolver block mirrors the exact sequence in
// garelier-pm/scripts/setup_wizard_crew.test.sh (the three-tier resolver
// fixtures), asserting the TS twins produce the same relative paths the bash
// functions do. The entry/TOML blocks pin the other shared helpers.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wsResolveContainer } from "./paths.ts";
import {
  checkAgentSpecs,
  EntryError,
  entryId,
  entryModel,
  entryProvider,
  normalizeAgentEntry,
  parseEntries,
  qgDefaultsForStack,
} from "./entries.ts";
import { readTomlBareFrom, readTomlValueFrom, tomlScalarValue } from "./toml.ts";

let temp = "";
let prevCwd = "";
afterEach(() => {
  if (prevCwd) process.chdir(prevCwd);
  prevCwd = "";
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

describe("three-tier container resolver (crew regression parity)", () => {
  test("legacy / crew / pointer / on-disk-legacy precedence", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-resolver-"));
    prevCwd = process.cwd();
    process.chdir(temp);
    const pm = "pm1";

    mkdirSync(join("__garelier", pm, "runtime"), { recursive: true });
    expect(wsResolveContainer(pm, "workers", "w1")).toBe("__garelier/pm1/_workers/w1");
    expect(wsResolveContainer(pm, "artisan", "")).toBe("__garelier/pm1/_artisan");

    mkdirSync(join("__garelier", pm, "_crew"), { recursive: true });
    expect(wsResolveContainer(pm, "workers", "w1")).toBe("__garelier/pm1/_crew/workers/w1");
    expect(wsResolveContainer(pm, "artisan", "")).toBe("__garelier/pm1/_crew/artisan");

    writeFileSync(join("__garelier", pm, "runtime", "workspace_paths"), "worker.w1=/abs/home/_workers/w1\n");
    expect(wsResolveContainer(pm, "workers", "w1")).toBe("/abs/home/_workers/w1");
    rmSync(join("__garelier", pm, "runtime", "workspace_paths"));

    mkdirSync(join("__garelier", pm, "_workers", "w9"), { recursive: true });
    expect(wsResolveContainer(pm, "workers", "w9")).toBe("__garelier/pm1/_workers/w9");
    expect(wsResolveContainer(pm, "workers", "w1")).toBe("__garelier/pm1/_crew/workers/w1");
  });
});

describe("agent entry parsing (normalize_agent_entry parity)", () => {
  test("two-field id:model defaults provider to claude-code", () => {
    expect(normalizeAgentEntry("worker-01:claude-code")).toBe("worker-01:claude-code:claude-code");
    expect(normalizeAgentEntry("worker-01:my-model")).toBe("worker-01:claude-code:my-model");
  });
  test("three-field id:provider:model canonicalizes the provider", () => {
    expect(normalizeAgentEntry("w:codex:codex")).toBe("w:codex-cli:codex");
    expect(normalizeAgentEntry("w:google-gemini:g")).toBe("w:gemini-cli:g");
    expect(normalizeAgentEntry("w:cursor-agent:c")).toBe("w:cursor-cli:c");
  });
  test("ambiguous two-field id:provider is rejected", () => {
    expect(() => normalizeAgentEntry("w:codex-cli")).toThrow(EntryError);
    expect(() => normalizeAgentEntry("w:gemini")).toThrow(EntryError);
  });
  test("empty / malformed entries and unsupported providers throw", () => {
    expect(() => normalizeAgentEntry("noModel")).toThrow(EntryError);
    expect(() => normalizeAgentEntry("id:")).toThrow(EntryError);
    expect(() => normalizeAgentEntry("id:bogus:m")).toThrow(EntryError);
  });
  test("parseEntries skips empties and normalizes each", () => {
    expect(parseEntries("a:m,,b:claude:n")).toEqual(["a:claude-code:m", "b:claude-code:n"]);
  });
  test("entry field extractors", () => {
    expect(entryId("a:b:c")).toBe("a");
    expect(entryProvider("a:b:c")).toBe("b");
    expect(entryModel("a:b:c")).toBe("c");
    expect(entryModel("a:b:c:d")).toBe("c:d");
  });
  test("checkAgentSpecs rejects the top-level id:provider mistake", () => {
    expect(() => checkAgentSpecs("workers", "worker-01:codex")).toThrow(EntryError);
    checkAgentSpecs("workers", "worker-01:codex-cli:gpt-5-codex"); // valid, no throw
    checkAgentSpecs("workers", ""); // empty, no throw
  });
  test("qgDefaultsForStack matches STACK_QUALITY_GATES shape", () => {
    expect(qgDefaultsForStack("rust")).toHaveLength(3);
    expect(qgDefaultsForStack("typescript")).toHaveLength(4);
    expect(qgDefaultsForStack("custom")).toEqual([]);
    expect(qgDefaultsForStack("mixed")).toEqual([]);
  });
});

describe("TOML readers", () => {
  test("scalar / bare / block-id / scoped-scalar / effort parity", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-toml-"));
    const toml = join(temp, "cfg.toml");
    writeFileSync(
      toml,
      [
        "[branches]",
        'target = "main/soft"',
        'integration = "garelier/main-soft/pm1/studio"',
        "",
        "[artisan]",
        "enabled = true   # inline comment",
        "",
        "[[workers]]",
        'id = "w1"',
        'provider = "codex-cli"',
        'model = "codex"',
        'effort = "high"',
        "",
        "[[workers]]",
        'id = "w2"',
        'model = "claude-code"',
        "",
        "[guardian_tools]",
        'secret_scan = "gitleaks dir --no-banner --redact"',
        "",
      ].join("\n"),
    );

    expect(readTomlValueFrom(toml, "branches", "target")).toBe("main/soft");
    expect(readTomlValueFrom(toml, "branches", "integration")).toBe("garelier/main-soft/pm1/studio");
    expect(readTomlValueFrom(toml, "branches", "missing")).toBe("");
    expect(readTomlBareFrom(toml, "artisan", "enabled")).toBe("true");
    expect(tomlScalarValue(toml, "guardian_tools", "secret_scan")).toBe("gitleaks dir --no-banner --redact");
  });
});
