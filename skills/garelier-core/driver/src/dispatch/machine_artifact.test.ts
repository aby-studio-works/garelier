// W-638 / W-637 / W-636 / W-634: the machine face of every parsed dispatch
// artifact is TOML front matter under [section] / [[array]] tables.
//
// Every check below is two-directional: the passing case alone could be met by
// deleting the check, and the failing case alone could be met by rejecting
// everything.
//
// ONE `test()` for seven oracles (PM ruling 2026-09-02). The definition census
// (ci_test_inventory.ts) is a monotonic budget: studio alone is 289 against a
// 290 ceiling whose purpose is to keep 10 definitions in reserve under the
// permanent 300 maximum, so this bundle may spend +1 and no more. The seven
// oracles are named in the section comments below and NOT ONE ASSERTION WAS
// DROPPED to pay for it — the fold costs failure granularity, not coverage:
// Bun stops at the first failing `expect`, so a RED here names the section by
// its assertion text rather than by a test name, and later sections of the same
// run stay unmeasured until it is fixed. That cost is real and is the reason
// the earlier rounds of this lane kept them apart; the budget overrules it.
import { describe, expect, test } from "bun:test";
import {
  MachineArtifactError,
  assertSectionedTables,
  machineArray,
  machineString,
  optionalMachineString,
  parseMachineArtifact,
  renderMachineArtifact,
  tomlValue,
  tryParseMachineArtifact,
} from "./machine_artifact.ts";

// The verbatim consumed value from a downstream project's
// `_crew/dispatch429/instructions.md`
// M5 - the entry whose nested parenthesis made `merge_land --dispatch-id 429`
// report "checked entry has no consumption evidence" after every gate had
// passed. The container was cleaned up; this text is the row-quoted original
// (control/backlog/open/W-637-*.md, "role が書いた M5").
const REAL_M5_CONSUMED = "result.md へ 124 byte の STATE= 行を prepend (本文は heading 以降 byte 不変、11 section 保持)、STATE.md を REPORTING へ。artifact:__garelier/aby_works/_crew/dispatch429/lane/result.md";

// The regex this change retires (role_binding.ts:1826 before the cutover).
const RETIRED_CONSUMED_PARSER = /\s*\(consumed:\s*([^)\r\n]+)\)\s*$/;

describe("machine artifact front matter", () => {
  test("the front-matter contract: sectioned tables, three fault reports, and byte-exact round-trip", () => {
    // R-1: a rendered artifact has no top-level bare key, and adding one is rejected.
    const rendered = renderMachineArtifact([{ name: "lane", fields: [["state", "REPORTING"]] }], "prose");
    // Forward: every front-matter line that assigns a value is inside a table.
    const front = rendered.split("+++")[1]!;
    expect(front.split("\n").filter((line) => /^[a-z_]+ *=/.test(line) === false || line.includes("="))
      .some((line) => /^\[/.test(line))).toBe(true);
    expect(() => parseMachineArtifact(rendered, "lane")).not.toThrow();

    // Counterfactual: one bare key at the top of the SAME front matter fails.
    const withBareKey = rendered.replace("[lane]", "state = 'REPORTING'\n\n[lane]");
    expect(() => parseMachineArtifact(withBareKey, "lane")).toThrow(/top-level bare key/);

    // R-1b: assertSectionedTables sees a bare key that a `^key =` grep cannot.
    // An inline table is a bare key even though the value spans no line of its own.
    expect(() => assertSectionedTables({ lane: { state: "x" } }, "lane")).not.toThrow();
    expect(() => assertSectionedTables({ state: "REPORTING", lane: { state: "x" } }, "lane"))
      .toThrow(/1 top-level bare key\(s\) \(state\)/);

    // R-6: the retired body-regex form is rejected by name; the new form passes.
    const legacy = "# Register - #429 w1030\n\nSTATE=REPORTING; done\n";
    const failure = tryParseMachineArtifact(legacy, "lane/result.md");
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.fault).toBe("legacy_form");
      expect(failure.message).toContain("retired body-regex form");
    }
    const current = renderMachineArtifact([{ name: "lane", fields: [["state", "REPORTING"]] }], "# Register - #429\n");
    const parsed = tryParseMachineArtifact(current, "lane/result.md");
    expect(parsed.ok).toBe(true);

    // AC-4 / V-3: absent, malformed and legacy are three different reports.
    const artifact = parseMachineArtifact(
      renderMachineArtifact([{ name: "lane", fields: [["state", "REPORTING"]] }], ""),
      "lane/result.md",
    );
    // Present-and-decoded, field simply not set.
    expect(optionalMachineString(artifact, "lane", "review_sha", "lane/result.md")).toBeNull();
    try {
      machineString(artifact, "lane", "review_sha", "lane/result.md");
      throw new Error("expected an absent-field error");
    } catch (error) {
      expect((error as MachineArtifactError).fault).toBe("absent");
      expect((error as Error).message).toContain("has no [lane] review_sha");
    }
    // Present but undecodable: a DIFFERENT report, not "absent".
    const broken = tryParseMachineArtifact("+++\n[lane\nstate = 'REPORTING'\n+++\n", "lane/result.md");
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.fault).toBe("malformed");
      expect(broken.message).toContain("front matter did not decode");
      expect(broken.message).not.toContain("has no [lane]");
    }
    // No file at all: a third report.
    const missing = tryParseMachineArtifact(null, "lane/result.md");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.fault).toBe("missing");

    // AC-7 / V-5: the real #429 M5 value round-trips, and the retired parser could not read it.
    // Counterfactual on the DEFECT: the retired regex genuinely fails this value.
    expect(RETIRED_CONSUMED_PARSER.exec(`- [x] M5 note (consumed: ${REAL_M5_CONSUMED})`)).toBeNull();

    // Forward: the same bytes survive emit -> parse with no rewording.
    const ledger = renderMachineArtifact([
      { name: "ledger", fields: [["dispatch", "#429"]] },
      { name: "instruction", array: true, fields: [["id", "M5"], ["checked", true], ["consumed", REAL_M5_CONSUMED]] },
    ], "");
    const entry = machineArray(parseMachineArtifact(ledger, "instructions.md"), "instruction", "instructions.md")[0]!;
    expect(entry.consumed).toBe(REAL_M5_CONSUMED);
    expect(entry.checked).toBe(true);

    // V-5: every character class that broke a writer survives emit -> parse unchanged.
    const hostile: Record<string, string> = {
      nested_parens: REAL_M5_CONSUMED,
      backtick_command_substitution: "double-quoted `whoami` inside evidence",
      literal_cr: "carriage\r\nreturn",
      triple_single_quote: "contains ''' inside",
      trailing_apostrophe: "ends with an apostrophe'",
      front_matter_delimiter: "before\n+++\nafter",
      toml_lookalike: "executed = 4\nskipped_green = 0",
      double_quotes: 'he said "stop"',
    };
    for (const [name, value] of Object.entries(hostile)) {
      const probe = renderMachineArtifact([{ name: "probe", fields: [["value", value]] }], "");
      expect(machineString(parseMachineArtifact(probe, name), "probe", "value", name)).toBe(value);
    }

    // tomlValue prefers literal strings so a writer never escapes anything.
    expect(tomlValue("plain")).toBe("'plain'");
    expect(tomlValue("has (parens) and `ticks`")).toBe("'has (parens) and `ticks`'");
    expect(tomlValue("two\nlines")).toBe("'''\ntwo\nlines'''");
    // Only the cases a literal string cannot carry fall back to escaping.
    expect(tomlValue("ends'")).toStartWith('"');
    expect(tomlValue("has ''' inside")).toStartWith('"');
  });
});
