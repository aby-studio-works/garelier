import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";
import { assertSingleVerdictPath, seatReportPath, verdictPathsFor } from "./gate_agents.ts";
import { duplicateDispatch } from "./dispatch_prepare.ts";
import { observerGateReason } from "../merge_gate_parse.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function scratchDir(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `garelier-verdict-path-${label}-`));
  scratch.push(path);
  return path;
}

function containerFixture(root: string, id: string, slug: string, role: string, state = "WORKING"): void {
  const dir = join(root, `dispatch${id}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "STATE.md"), `# Dispatch #${id} - ${role} ${slug}\n\n## Status\n\n${state}\n\n## Current task\n\n#${id} ${slug} (branch)\n`);
  writeFileSync(join(dir, "context.json"), JSON.stringify({ task: { role, slug } }));
}

const PASSING_VERDICT = [
  "+++", "[verdict]", "result = 'PASS'",
  "review_sha = '0123456789abcdef0123456789abcdef01234567'", "+++", "",
  "# Observer review", "", "## Verdict", "", "PASS", "",
].join("\n");

describe("gate verdict path identity", () => {
  test("the derived path carries the role exactly once for a branch slug", () => {
    expect(seatReportPath("guardian", "w1042-audit-effective")).toBe("runtime/guardian/results/w1042-audit-effective-guardian.md");
    // A slug that already ends in the role gains a SECOND role segment. That is
    // the mechanism behind the two-path prompts: the derivation is correct, the
    // input was a slug that had already been renamed to avoid a collision.
    expect(seatReportPath("guardian", "w1042-audit-effective-guardian")).toBe("runtime/guardian/results/w1042-audit-effective-guardian-guardian.md");
  });

  test("a gate seat on a producer's slug is not a duplicate dispatch", () => {
    const root = scratchDir("dup");
    containerFixture(root, "431", "w1042-audit-effective", "worker");

    // The reason operators renamed gate slugs in the first place.
    expect(duplicateDispatch(root, "dispatch", "w1042-audit-effective", "worker")?.name).toBe("dispatch431");
    // A different role on the same slug is the designed producer/gate pairing.
    expect(duplicateDispatch(root, "dispatch", "w1042-audit-effective", "guardian")).toBeUndefined();
    expect(duplicateDispatch(root, "dispatch", "w1042-audit-effective", "observer")).toBeUndefined();
  });

  test("a container whose role cannot be read stays a duplicate", () => {
    const root = scratchDir("dup-unreadable");
    containerFixture(root, "431", "w1042-audit-effective", "worker");
    writeFileSync(join(root, "dispatch431", "context.json"), "{ not json");
    expect(duplicateDispatch(root, "dispatch", "w1042-audit-effective", "guardian")?.name).toBe("dispatch431");
  });

  test("a prompt may name the OTHER role's verdict but not a second one of its own", () => {
    const declared = seatReportPath("observer", "w1042-audit-effective");
    const ownAndOther = [
      `- Write the verdict to C:/repo/__garelier/pm/${declared}; no other output path is granted.`,
      `- Read the Guardian verdict at \`C:/repo/__garelier/pm/${seatReportPath("guardian", "w1042-audit-effective")}\`.`,
    ].join("\n");

    expect(verdictPathsFor(ownAndOther, "observer")).toHaveLength(1);
    expect(() => assertSingleVerdictPath(ownAndOther, "observer", declared, "<fixture>")).not.toThrow();

    const twoOwnPaths = `${ownAndOther}\n- Output: runtime/observer/results/w1042-audit-effective-observer-observer.md\n`;
    expect(() => assertSingleVerdictPath(twoOwnPaths, "observer", declared, "<fixture>"))
      .toThrow(/names 2 different observer verdict path/);
  });

  test("the merge gate finds a verdict at the derived path and not at another", () => {
    const pmRoot = scratchDir("merge");
    const declared = seatReportPath("observer", "w1042-audit-effective");
    const declaredAbs = join(pmRoot, ...declared.split("/"));
    mkdirSync(join(pmRoot, "runtime", "observer", "results"), { recursive: true });
    writeFileSync(declaredAbs, PASSING_VERDICT);
    const readReport = (path: string): string | null => {
      try { return readFileSync(path, "utf8"); } catch { return null; }
    };

    // (a) the verdict written at the derived path IS found.
    expect(observerGateReason({ observer_required: true, observer_report_path: declaredAbs }, readReport)).toBe("");

    // (b) the same verdict written to the doubled-suffix path is NOT found at the
    //     derived path — a seat that picked the other name leaves the gate with no
    //     verdict, which is what makes "the seat chose correctly" an unsafe
    //     mechanism rather than a guarantee.
    const strayAbs = join(pmRoot, ...seatReportPath("observer", "w1042-audit-effective-observer").split("/"));
    writeFileSync(strayAbs, PASSING_VERDICT);
    rmSync(declaredAbs, { force: true });
    expect(observerGateReason({ observer_required: true, observer_report_path: declaredAbs }, readReport))
      .toContain("no Observer verdict found");
  });
});
