import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "./log.ts";
import { gcEphemeralBranches, parseWorktreePorcelain, type GitRunner } from "./branch_gc.ts";

const log = new Logger("test", join(mkdtempSync(join(tmpdir(), "symph-gc-")), "driver.jsonl"));

function cfg(over: Record<string, unknown> = {}) {
  return {
    pmId: "aby",
    branches: { integration: "garelier/dev/aby/studio" },
    guardians: [{ id: "guardian-01" }],
    observers: [{ id: "observer-01" }],
    scouts: [{ id: "scout-01" }],
    ...over,
  } as never;
}

/** Build an injectable git runner from canned outputs; records branch -D + detach calls. */
function fakeGit(opts: {
  worktrees?: string;
  refs?: Record<string, string[]>;        // prefix (refs/heads/...) -> branch names
  deletes: string[];
  detaches: string[];
  failDelete?: Set<string>;
}): GitRunner {
  return (args, cwd) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return { code: 0, stdout: opts.worktrees ?? "", stderr: "" };
    }
    if (args[0] === "for-each-ref") {
      const pattern = args[args.length - 1]!;
      const names = opts.refs?.[pattern] ?? [];
      return { code: 0, stdout: names.join("\n"), stderr: "" };
    }
    if (args[0] === "checkout" && args[1] === "--detach") {
      opts.detaches.push(cwd); // cwd = worktree path
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "branch" && args[1] === "-D") {
      const b = args[2]!;
      if (opts.failDelete?.has(b)) return { code: 1, stdout: "", stderr: `error: branch '${b}' checked out` };
      opts.deletes.push(b);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("parseWorktreePorcelain", () => {
  test("extracts (path, branch) pairs and detached entries", () => {
    const out = parseWorktreePorcelain(
      "worktree /main\nHEAD abc\nbranch refs/heads/garelier/dev/aby/studio\n\n" +
      "worktree /g/checkout\nHEAD def\nbranch refs/heads/garelier/dev/aby/gavel/#15/x\n\n" +
      "worktree /s/checkout\nHEAD 999\ndetached\n",
    );
    expect(out).toEqual([
      { path: "/main", branch: "garelier/dev/aby/studio" },
      { path: "/g/checkout", branch: "garelier/dev/aby/gavel/#15/x" },
      { path: "/s/checkout", branch: null },
    ]);
  });
});

describe("gcEphemeralBranches", () => {
  test("detaches the owning worktree then deletes a leftover gavel branch when guardian is IDLE", () => {
    const deletes: string[] = [], detaches: string[] = [];
    const git = fakeGit({
      worktrees: "worktree /g/checkout\nbranch refs/heads/garelier/dev/aby/gavel/#15/x\n",
      refs: { "refs/heads/garelier/dev/aby/gavel/": ["garelier/dev/aby/gavel/#15/x"] },
      deletes, detaches,
    });
    const out = gcEphemeralBranches("/proj", cfg(), log, { git, statusOf: () => "IDLE" });
    expect(out).toEqual(["garelier/dev/aby/gavel/#15/x"]);
    expect(detaches).toEqual(["/g/checkout"]);   // detached the worktree first
    expect(deletes).toContain("garelier/dev/aby/gavel/#15/x");
  });

  test("skips a kind whose role is still busy (live gate)", () => {
    const deletes: string[] = [], detaches: string[] = [];
    const git = fakeGit({
      refs: { "refs/heads/garelier/dev/aby/gavel/": ["garelier/dev/aby/gavel/#16/y"] },
      deletes, detaches,
    });
    const statusOf = (c: string) => (c.includes("_guardians") ? "CHECKING" : "IDLE");
    const out = gcEphemeralBranches("/proj", cfg(), log, { git, statusOf });
    expect(out).not.toContain("garelier/dev/aby/gavel/#16/y");
    expect(deletes).toHaveLength(0);
  });

  test("deletes a not-checked-out ephemeral branch without detaching", () => {
    const deletes: string[] = [], detaches: string[] = [];
    const git = fakeGit({
      worktrees: "worktree /main\nbranch refs/heads/garelier/dev/aby/studio\n",
      refs: { "refs/heads/garelier/dev/aby/spyglass/": ["garelier/dev/aby/spyglass/#9/z"] },
      deletes, detaches,
    });
    const out = gcEphemeralBranches("/proj", cfg(), log, { git, statusOf: () => "IDLE" });
    expect(out).toEqual(["garelier/dev/aby/spyglass/#9/z"]);
    expect(detaches).toHaveLength(0);
  });

  test("does not touch workbench/anvil/studio (only gavel/monocle/spyglass)", () => {
    const deletes: string[] = [];
    const git = fakeGit({
      // for-each-ref is only ever queried for the three ephemeral prefixes; a
      // workbench prefix is never requested, so it can never be deleted.
      refs: { "refs/heads/garelier/dev/aby/gavel/": [], "refs/heads/garelier/dev/aby/monocle/": [], "refs/heads/garelier/dev/aby/spyglass/": [] },
      deletes, detaches: [],
    });
    const out = gcEphemeralBranches("/proj", cfg(), log, { git, statusOf: () => "IDLE" });
    expect(out).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });
});
