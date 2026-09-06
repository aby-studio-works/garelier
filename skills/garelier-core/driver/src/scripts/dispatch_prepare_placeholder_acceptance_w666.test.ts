import { describe, expect, test } from "bun:test";
import { PLACEHOLDER_ACCEPTANCE_LINE, placeholderAcceptanceOnly } from "./dispatch_prepare.ts";

function row(sections: string): string {
  return ["+++", 'kind = "garelier_backlog"', "+++", "", "# W-001: Demo", "", sections, ""].join("\n");
}

describe("W-666 placeholder acceptance refusal", () => {
  test("a row whose acceptance section is only the create-time placeholder is refused", () => {
    expect(placeholderAcceptanceOnly(row([
      "## Acceptance criteria",
      "",
      PLACEHOLDER_ACCEPTANCE_LINE,
      "",
      "## Current position",
      "",
      "Created; awaiting triage.",
    ].join("\n")))).toBe(true);
  });

  test("a single real criterion is enough to pass", () => {
    expect(placeholderAcceptanceOnly(row([
      "## Acceptance criteria",
      "",
      "- [ ] AC-1: the emitted watch_cmd runs verbatim and exits 0",
      "",
      "## Evidence",
    ].join("\n")))).toBe(false);
  });

  test("the placeholder OUTSIDE the section is not a match (no whole-file grep)", () => {
    expect(placeholderAcceptanceOnly(row([
      "## Acceptance criteria",
      "",
      "- [ ] AC-1: reject a row that still reads `- [ ] Define acceptance.`",
      "",
      "## Notes",
      "",
      PLACEHOLDER_ACCEPTANCE_LINE,
    ].join("\n")))).toBe(false);
  });

  test("a broken duplicate section passes while one section carries criteria", () => {
    expect(placeholderAcceptanceOnly(row([
      "## Acceptance criteria",
      "",
      "- [ ] AC-1: real criterion",
      "",
      "## Acceptance criteria",
      "",
      PLACEHOLDER_ACCEPTANCE_LINE,
      "",
      "## Evidence",
    ].join("\n")))).toBe(false);
  });

  test("a row with no acceptance section at all is not this check's business", () => {
    expect(placeholderAcceptanceOnly(row("## Current position\n\nCreated."))).toBe(false);
  });
});
