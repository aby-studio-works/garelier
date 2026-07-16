// W-083 ts-first: regression test for AGENTS.md templating. Byte parity against
// the live bash on the real template is proven by an external diff (IDENTICAL);
// this pins the four mechanisms (base sub, minimal sub, multi-line collapse,
// quality-gate expansion) against regression with a compact fixture.

import { describe, expect, test } from "bun:test";
import { renderAgentsMd } from "./agents_md.ts";

const FIXTURE = [
  "# {{project_name}} — {{pm_id}}",
  "Branch garelier/{{target_slug}}/{{pm_id}}/studio, lang {{e.g., Rust, TypeScript, Python}}.",
  "Build: {{e.g., cargo build, npm run build}} / Test: {{e.g., cargo test, npm test}}",
  "Asset: {{e.g., a project-specific asset/integrity check, or none}}",
  "Gate:",
  "{{quality_gate_command_1}}",
  "{{quality_gate_command_2}}",
  "Restricted: {{file_path_or_glob}} owner {{worker_id}} — {{reason}}",
  "- {{convention_1}}",
  "- {{convention_2}}",
  "Docs: {{e.g., Specification documents are bilingual JP/EN. Code comments are",
  "in English. Adjust to this project.}}",
  "End.",
  "",
].join("\n");

describe("renderAgentsMd", () => {
  test("strict: fills base + gate, leaves project-specific placeholders", () => {
    const out = renderAgentsMd(FIXTURE, {
      projectName: "Proj",
      target: "main",
      targetSlug: "main",
      pmId: "pm1",
      stack: "rust",
      agentsPolicy: "strict",
      qgCmds: ["cargo check", "cargo test"],
    });
    expect(out).toContain("# Proj — pm1");
    expect(out).toContain("lang Rust.");
    expect(out).toContain("Build: cargo build --workspace / Test: cargo test --workspace");
    // gate expansion: two commands, second placeholder line dropped.
    expect(out).toContain("Gate:\ncargo check\ncargo test\nRestricted:");
    // strict leaves these as-is.
    expect(out).toContain("{{file_path_or_glob}}");
    expect(out).toContain("{{convention_1}}");
    expect(out).toContain("bilingual JP/EN"); // multi-line block untouched
  });

  test("minimal: fills project-specific placeholders + collapses the multi-line block", () => {
    const out = renderAgentsMd(FIXTURE, {
      projectName: "Proj",
      target: "main",
      targetSlug: "main",
      pmId: "pm1",
      stack: "custom",
      agentsPolicy: "minimal",
      qgCmds: ["true"],
    });
    expect(out).toContain("lang (edit: project language(s)).");
    expect(out).toContain("Restricted: (none initially) owner - — add conflict-prone files here as they emerge");
    expect(out).toContain("- Follow the existing project style and conventions.");
    expect(out).toContain("- (add project-specific conventions as they emerge)");
    // The multi-line {{...}} block (both lines) collapses to the single
    // sentence, losing the "Docs: " prefix (awk replaces the whole line).
    expect(out).toContain("\nFollow the existing documentation language conventions.\nEnd.\n");
    expect(out).not.toContain("bilingual JP/EN");
    expect(out).not.toContain("Docs: {{");
  });
});
