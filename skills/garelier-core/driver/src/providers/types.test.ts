import { test, expect, describe } from "bun:test";
import { exileCoordAddDir, pathInsideOrSame } from "./types.ts";
import type { ProviderBuildOptions } from "./types.ts";

// DEC-036: in-project is the default. A role whose coordination container is
// INSIDE the project must NOT get an extra --add-dir — the launch-folder grant
// (--add-dir projectRoot) already covers ../STATE.md. Only an exiled container
// (outside the project, opt-in) needs the grant. This is the access-model hinge:
// a spurious or missing --add-dir is what broke role state transitions under
// exile, so it is worth a dedicated guard.
describe("exileCoordAddDir (DEC-036 access model)", () => {
  const base = {
    cwd: "/proj/__garelier/pm/_workers/w1/checkout",
    role: "worker" as const,
    projectRoot: "/proj",
    skillCoreDir: "/skills/garelier-core",
    tmpDir: "/tmp",
    promptFile: "/tmp/p",
    overrideFile: "/tmp/o",
    permissionProfile: "reviewed" as const,
  };

  test("in-project container -> NO --add-dir (default; covered by --add-dir projectRoot)", () => {
    const opts = { ...base, coordDir: "/proj/__garelier/pm/_workers/w1" } as ProviderBuildOptions;
    expect(exileCoordAddDir(opts)).toEqual([]);
  });

  test("path containment respects path boundaries", () => {
    expect(pathInsideOrSame("/proj/__garelier/pm", "/proj")).toBe(true);
    expect(pathInsideOrSame("/projectile/__garelier/pm", "/proj")).toBe(false);
  });

  test("exiled container (outside project) -> --add-dir <container> (opt-in)", () => {
    const opts = { ...base, coordDir: "/home/.garelier/studios/h/_workers/w1" } as ProviderBuildOptions;
    expect(exileCoordAddDir(opts)).toEqual(["--add-dir", "/home/.garelier/studios/h/_workers/w1"]);
  });

  test("no coordDir (PM/Dock, cwd is their own container) -> []", () => {
    const opts = { ...base, coordDir: undefined } as ProviderBuildOptions;
    expect(exileCoordAddDir(opts)).toEqual([]);
  });
});
