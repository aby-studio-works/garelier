import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";
import { PROCESS_TABLE_PROBE, describeCheckoutHolders } from "./dispatch_cleanup.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("W-667 M6 the checkout holder probe never runs a shell", () => {
  test("the probe argv is a constant with no shell and no path in it", () => {
    // Platform-independent counterfactual: the old code BUILT this argv from the
    // checkout path and handed it to a shell, so this assertion fails against it
    // on any platform, including the Windows host where the POSIX branch that
    // carried the injection never executes.
    expect(PROCESS_TABLE_PROBE).not.toContain("-c");
    expect(PROCESS_TABLE_PROBE[0]).not.toBe("sh");
    for (const part of PROCESS_TABLE_PROBE) expect(part).not.toContain("grep");
    expect(Object.isFrozen(PROCESS_TABLE_PROBE) || Array.isArray(PROCESS_TABLE_PROBE)).toBeTrue();
  });

  test("a path carrying shell metacharacters cannot execute an embedded command", () => {
    // The first version of this probe interpolated the path into `sh -c` inside
    // single quotes and escaped a quote as `'''`, which closes the literal —
    // everything after it ran as shell code. This path would have created the
    // marker; it must not, and the probe must still answer.
    const root = mkdtempSync(join(tmpdir(), "garelier-w667-probe-"));
    scratch.push(root);
    const marker = join(root, "pwned");
    const hostile = `${join(root, "checkout")}'; touch '${marker}`;

    const answer = describeCheckoutHolders(hostile);

    expect(existsSync(marker)).toBeFalse();
    expect(readdirSync(root)).not.toContain("pwned");
    expect(typeof answer).toBe("string");
    expect(answer.startsWith(";")).toBeTrue();
  });

  test("a path nothing is holding reports the stale-registration remedy", () => {
    const root = mkdtempSync(join(tmpdir(), "garelier-w667-probe-"));
    scratch.push(root);
    const answer = describeCheckoutHolders(join(root, "never-referenced-by-any-process"));
    expect(answer).toContain("git worktree prune");
    expect(answer).not.toContain("handle-release lag");
  });

  test("a reported holder is pid and process name only, never its command line", () => {
    // Probe a path every process in this run does reference: the checkout root
    // of this very test process. Whatever comes back must be two fields.
    const answer = describeCheckoutHolders(process.cwd());
    if (!answer.includes("processes referencing this path:")) return;
    const listed = answer.split("processes referencing this path: ")[1]!;
    for (const holder of listed.split(" | ")) {
      expect(holder.trim().split(/\s+/).length).toBe(2);
      expect(holder).not.toContain("--");
    }
  });
});
