import { describe, expect, test } from "bun:test";
import { codexProducerContract } from "./lane_common.ts";

describe("W-104 codex producer contract", () => {
  test("shared preamble forbids git writes, pins PM base-track, and ends in a parseable plan", () => {
    const prompt = codexProducerContract({
      worktree: "/repo/__garelier/p/_crew/dispatch7/checkout",
      branch: "garelier/main/p/workbench/#7/fix",
      baseSha: "abc1234",
      subjectSuffix: "[#7]",
      trailer: "Garelier: p worker#7 {{TASK_ID}}",
      seatTrailer: "Garelier-Seat: codex gpt-5.6-sol (proxy-commit via dock seat)",
    });

    expect(prompt).toContain("NEVER run git merge, git add, git commit");
    expect(prompt).toContain("Edit worktree files only");
    expect(prompt).toContain("If the tips are identical, skip base-track");
    expect(prompt).toContain("If the tips differ, the PM must merge");
    expect(prompt).toContain("=== COMMIT PLAN ===");
    expect(prompt.trimEnd()).toEndWith("=== END COMMIT PLAN ===");
  });
});
