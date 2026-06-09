import { test, expect, describe } from "bun:test";
import { buildIterationPrompt, getHeadlessDirective, type RoleKind } from "./prompts.ts";

const ctx = {
  projectRoot: "/proj",
  pmId: "pm",
  skillRootDir: "/skills",
  workerOrScoutId: "a1",
  providerKind: "codex-cli" as const,
  roleStatusSummary: "- worker w1: WORKING; container=/mail/w1\n- scout s1: IDLE; container=/mail/s1",
};

const roles: RoleKind[] = [
  "pm", "dock", "artisan", "worker", "scout", "smith", "librarian", "observer", "guardian", "concierge",
];

describe("buildIterationPrompt", () => {
  test("every role produces a non-empty prompt naming its own skill doc + pm_id", () => {
    for (const r of roles) {
      const p = buildIterationPrompt(r, ctx);
      expect(p.length).toBeGreaterThan(0);
      expect(p).toContain(`garelier-${r}/SKILL.md`);
      expect(p).toContain("pm_id=pm");
    }
  });
  test("observer prompt is read-only and lists verdicts", () => {
    const p = buildIterationPrompt("observer", ctx);
    expect(p).toContain("READ-ONLY");
    expect(p).toContain("_observers/a1");
    expect(p).toContain("PASS");
    expect(p).toContain("NO_OPINION");
    expect(p).toContain("NO commits");
  });
  test("artisan prompt mentions the satchel branch", () => {
    const p = buildIterationPrompt("artisan", ctx);
    expect(p).toContain("satchel");
    expect(p).toContain("merge satchel into studio");
    expect(p).toContain("NEVER merge to target");
  });
  test("headless directive forbids questions (dual-runner safety)", () => {
    expect(getHeadlessDirective()).toContain("no questions");
  });
  test("prompt context policy routes deeper docs on demand", () => {
    const p = buildIterationPrompt("worker", ctx);
    expect(p).toContain("Context policy (codex-cli)");
    expect(p).toContain("role_index.toml");
    expect(p).toContain("Load /skills/garelier-core/protocol.md, state_machine.md, compact_handoff.md");
    expect(p).not.toContain("Required docs");
    expect(p).not.toContain("- /skills/garelier-core/protocol.md");
  });
  test("producer prompts allow bounded batches instead of one-step churn", () => {
    for (const r of ["worker", "scout", "smith", "librarian", "artisan"] as const) {
      const p = buildIterationPrompt(r, ctx);
      expect(p).toContain("bounded batch");
      expect(p).toContain("Never pick up a second task");
      expect(p).not.toContain("advance by exactly one step");
      expect(p).not.toContain("advance state machine by exactly one step");
    }
  });
  test("producer/promote prompts distinguish fast and full quality gates", () => {
    for (const r of ["worker", "smith", "librarian", "artisan"] as const) {
      const p = buildIterationPrompt(r, ctx);
      expect(p).toContain("fast quality gate");
      expect(p).toContain("full quality gate");
      expect(p).toContain("legacy [quality_gate] commands");
    }
    const worker = buildIterationPrompt("worker", ctx);
    expect(worker).toContain("before report.md");
    const concierge = buildIterationPrompt("concierge", ctx);
    expect(concierge).toContain("full quality gate on the MERGED tree");
  });
  test("coordinator prompts forbid no-op timestamp writes", () => {
    expect(buildIterationPrompt("pm", ctx)).toContain("No-op write rule");
    expect(buildIterationPrompt("dock", ctx)).toContain("No-op write rule");
  });
  test("coordinator prompts use driver role status summary for triage", () => {
    const p = buildIterationPrompt("dock", ctx);
    expect(p).toContain("Driver role status summary");
    expect(p).toContain("- worker w1: WORKING");
    expect(p).toContain("instead of re-reading every STATE.md");
    expect(p).toContain("Read a specific role's STATE.md / assignment.md / report.md only when");
  });
  test("prompts route deliverables through compact json sidecars when available", () => {
    expect(buildIterationPrompt("worker", ctx)).toContain("compact sibling JSON summary");
    expect(buildIterationPrompt("pm", ctx)).toContain("compact JSON sidecar first");
    expect(buildIterationPrompt("dock", ctx)).toContain("compact JSON sidecar first");
  });
});

// DEC-035: Dock/PM must address role containers at their RESOLVED
// (possibly exiled) path, not the in-project `_<role>/<id>/` glob. These guard
// the silent-handoff-break regression: with a roster present the prompt scans
// the exile containers; without one it falls back to the legacy in-proj glob.
describe("DEC-035 handoff roster", () => {
  const exileWorker = "/home/.garelier/studios/proj-abc123-pm/_workers/w1";
  const exileScout = "/home/.garelier/studios/proj-abc123-pm/_scouts/s1";
  const rosterCtx = {
    ...ctx,
    roster: [
      { role: "worker" as const, id: "w1", container: exileWorker },
      { role: "scout" as const, id: "s1", container: exileScout },
    ],
  };

  test("dock prompt with a roster scans the resolved exile containers", () => {
    const p = buildIterationPrompt("dock", rosterCtx);
    expect(p).toContain(`${exileWorker}/STATE.md`);
    expect(p).toContain(`${exileScout}/STATE.md`);
    expect(p).toContain("workspace_paths");
    expect(p).toContain("DEC-035");
    expect(p).toContain("Use the driver role status summary for status triage");
    // Must NOT instruct the bare in-project glob when containers are exiled.
    expect(p).not.toContain("/proj/__garelier/pm/_workers/*/STATE.md");
  });

  test("dock prompt without a roster falls back to the in-proj glob", () => {
    const p = buildIterationPrompt("dock", ctx);
    expect(p).toContain("/proj/__garelier/pm/_workers/*/STATE.md");
  });

  test("pm prompt with a roster carries the resolved containers (for abort.md)", () => {
    const p = buildIterationPrompt("pm", rosterCtx);
    expect(p).toContain(`${exileWorker}/STATE.md`);
    expect(p).toContain("workspace_paths");
  });
});

// DEC-042 — prompt-cache discipline. The fixed per-iteration overhead (the
// appended headless directive + the docs block) must stay byte-stable so the
// server-side prompt cache (cache-read at 0.1x) absorbs it. These guard against
// a future edit injecting volatile content (timestamps/ids) into the stable
// prefix or reordering the volatile role-status summary ahead of it.
describe("DEC-042 prompt-cache discipline", () => {
  test("headless directive is deterministic and carries no volatile tokens", () => {
    expect(getHeadlessDirective()).toBe(getHeadlessDirective());
    const d = getHeadlessDirective();
    expect(d).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no ISO date
    expect(d).not.toMatch(/\d{10,}/);           // no epoch-like timestamp
  });
  test("buildIterationPrompt is deterministic for identical context", () => {
    for (const r of roles) {
      expect(buildIterationPrompt(r, ctx)).toBe(buildIterationPrompt(r, ctx));
    }
  });
  test("volatile role-status summary comes AFTER the stable docs block (cache-friendly order)", () => {
    const p = buildIterationPrompt("dock", ctx);
    const docsIdx = p.indexOf("Context policy");
    const summaryIdx = p.indexOf("Driver role status summary");
    expect(docsIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThan(docsIdx);
  });
});
