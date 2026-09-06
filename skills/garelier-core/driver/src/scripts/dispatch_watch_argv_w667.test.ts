import { describe, expect, test } from "bun:test";
import { buildDispatchWatchArgv } from "./dispatch_prepare.ts";

const base = {
  bun: "bun",
  script: "/d/dispatch_watch.ts",
  project: "/p",
  pm: "pm1",
  id: "453",
  targetRoot: "/p",
};

describe("W-667 F-2 emitted watch_cmd runnability", () => {
  test("a read-only seat carries the branch it will be watched on", () => {
    // dispatch_watch resolves a branch from refs/heads/**/#<id>/<slug>, which a
    // scout / observer / guardian never has, so without this the emitted command
    // exits 2 with "cannot resolve branch for id <id> — pass --branch".
    const argv = buildDispatchWatchArgv({ ...base, branch: "garelier/x/pm1/studio" });
    expect(argv).toContain("--branch");
    expect(argv[argv.indexOf("--branch") + 1]).toBe("garelier/x/pm1/studio");
  });

  test("a work seat still resolves its own workbench ref", () => {
    expect(buildDispatchWatchArgv({ ...base, branch: null })).not.toContain("--branch");
    expect(buildDispatchWatchArgv(base)).not.toContain("--branch");
  });

  test("the declared-only heavy tier is unchanged", () => {
    expect(buildDispatchWatchArgv({ ...base, heavyTier: "heavy" })).toContain("--heavy-tier");
    expect(buildDispatchWatchArgv({ ...base, heavyTier: null })).not.toContain("--heavy-tier");
  });
});
