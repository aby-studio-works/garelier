import { test, expect } from "bun:test";
import { trackedShowcaseFiles } from "./showcase_tracked_lint.ts";

// W-165: the detective must flag a committed showcase file (the RED fixture) and
// leave every legitimate tracked path — including the gallery/ sibling and a
// source file that merely has "showcase" in its name — alone.

test("RED: a tracked showcase file is detected", () => {
  const lsFiles = [
    "skills/garelier-core/SKILL.md",
    "__garelier/_workshop/showcase/tmp/w111-resume.md",
    "__garelier/aby_works/showcase/screenshots/w516_conveyor/mk1_color.png",
    "__garelier/_workshop/control/project_dashboard/backlog.md",
  ].join("\n");
  expect(trackedShowcaseFiles(lsFiles)).toEqual([
    "__garelier/_workshop/showcase/tmp/w111-resume.md",
    "__garelier/aby_works/showcase/screenshots/w516_conveyor/mk1_color.png",
  ]);
});

test("GREEN: gallery/, showcase-named source, and normal tracked files are exempt", () => {
  const lsFiles = [
    "__garelier/_workshop/gallery/keep.png",                                   // tracked sibling, exempt
    "skills/garelier-core/driver/src/scripts/setup_wizard/showcase.ts",         // source file, not under __garelier/*/showcase/
    "skills/garelier-core/driver/src/scripts/showcase_tracked_lint.ts",         // this lint itself
    "__garelier/_workshop/control/operations/command_guard_policy.toml",
  ].join("\n");
  expect(trackedShowcaseFiles(lsFiles)).toEqual([]);
});

test("backslash-separated paths are normalized", () => {
  expect(trackedShowcaseFiles("__garelier\\_workshop\\showcase\\tmp\\w113-task.md"))
    .toEqual(["__garelier\\_workshop\\showcase\\tmp\\w113-task.md"]);
});

test("empty / blank input yields no findings", () => {
  expect(trackedShowcaseFiles("")).toEqual([]);
  expect(trackedShowcaseFiles("\n  \n")).toEqual([]);
});
