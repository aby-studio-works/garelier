// W-167: documentation-contract test for the PM/Dock output registers. Verifies
// only the load-bearing contract MARKERS (not a whole-text snapshot) so ordinary
// wording edits do not churn the test, while a register regression (a dropped
// politeness rule, a resurrected conflict phrase) fails fast. Paths resolve from
// import.meta.dir via node:path so the test is OS-independent.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// import.meta.dir = <repo>/skills/garelier-core/driver/src → repo root is 4 up.
const REPO = join(import.meta.dir, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const pmSkill = read("skills/garelier-pm/SKILL.md");
const pmReference = read("skills/garelier-pm/references/conversation-and-templates.md");
const dockSkill = read("skills/garelier-dock/SKILL.md");
const outputControlDoc = read("skills/garelier-core/output_control.md");

test("PM SKILL keeps polite register + delta-only concision markers", () => {
  expect(pmSkill).toContain("polite ですます調");
  expect(pmSkill).toContain("request echo");
  expect(pmSkill).toContain("1–3 short bullets");
});

test("PM reference dropped the verbose closing-recap phrase", () => {
  expect(pmReference).not.toContain("summarize what you did and what's next");
});

test("Dock SKILL declares the compact Final response register", () => {
  expect(dockSkill).toContain("## Final response register");
  expect(dockSkill).toContain("default 1–3 lines");
  expect(dockSkill).toContain("exact PM decision required");
});

test("output_control doc scopes the inter-agent register away from PM prose", () => {
  expect(outputControlDoc).toContain("polite concise register");
  expect(outputControlDoc).toContain("headroom, not a target to fill");
  expect(outputControlDoc).not.toContain("never PM's user-facing output");
});
