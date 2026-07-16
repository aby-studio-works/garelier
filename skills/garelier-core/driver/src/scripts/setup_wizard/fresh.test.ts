// W-083 ts-first: fresh-mode integration regression test. The definitive proof
// is a full bash-vs-TS byte diff of the generated __garelier tree + AGENTS.md
// (IDENTICAL after timestamp/repo-path normalization); this pins the end-to-end
// invariants (tree present, completion marker, AGENTS.md, manifest/history)
// against regression without needing the bash.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../_lib.ts";
import { resolveGarelierDirs, nowIso } from "./env.ts";
import { runFresh, type FreshParams } from "./fresh.ts";

const dirs = resolveGarelierDirs();
const coreTemplatesDir = `${dirs.skillsDir}/garelier-core/templates`;

let temp = "";
let prevCwd = "";
afterEach(() => {
  if (prevCwd) process.chdir(prevCwd);
  prevCwd = "";
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.email", "f@x.invalid"]);
  git(path, ["config", "user.name", "Fx"]);
  writeFileSync(join(path, "README.md"), "x\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "-q", "-m", "init"]);
}

describe("runFresh (end-to-end regression)", () => {
  test("clean fresh init writes the full tree + completion marker + AGENTS.md", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-fresh-"));
    const repo = join(temp, "proj");
    initRepo(repo);
    mkdirSync(join(repo, "__garelier"), { recursive: true });
    prevCwd = process.cwd();
    process.chdir(repo);

    const p: FreshParams = {
      projectRoot: repo,
      gitRoot: repo,
      now: nowIso(),
      dirs,
      coreTemplatesDir,
      pmId: "pm1",
      projectName: "Crew fixture",
      target: "main",
      workers: "worker-01:claude-code:claude-code",
      scouts: "scout-01:claude-code:claude-code",
      smiths: "smith-01:claude-code:claude-code",
      librarians: "librarian-01:claude-code:claude-code",
      observers: "observer-01:claude-code:claude-code",
      guardians: "guardian-01:claude-code:claude-code",
      concierges: "concierge-01:claude-code:claude-code",
      artisanSpec: "",
      scoutIdleTask: "false",
      defaultLane: "dock",
      skipConfirm: true,
      stack: "custom",
      qgCmds: ["true"],
      permissionProfile: "reviewed",
      agentsPolicy: "minimal",
      wsExile: false,
    };
    expect(runFresh(p)).toBe(0);

    const pmDir = join(repo, "__garelier/pm1/_crew/pm");
    const cfg = readFileSync(join(pmDir, "setup_config.toml"), "utf8");
    expect(cfg).toContain("[setup]\ncomplete = true\n");
    expect(cfg).toContain('wizard_version = "2.13.0"');
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(pmDir, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(pmDir, "history.md"))).toBe(true);
    expect(existsSync(join(repo, "__garelier/pm1/runtime/manifest.md"))).toBe(true);
    expect(existsSync(join(repo, "__garelier/pm1/control/control.toml"))).toBe(true);
    expect(existsSync(join(repo, "__garelier/__atmos/lens_registry.toml"))).toBe(true);
    // studio branch created + checked out.
    expect(git(repo, ["rev-parse", "--verify", "garelier/main/pm1/studio"]).exitCode).toBe(0);
  });

  test("refuses a target repository with no commits", () => {
    temp = mkdtempSync(join(tmpdir(), "garelier-wiz-fresh-"));
    const repo = join(temp, "empty");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    mkdirSync(join(repo, "__garelier"), { recursive: true });
    prevCwd = process.cwd();
    process.chdir(repo);
    const p = { projectRoot: repo, gitRoot: repo, now: nowIso(), dirs, coreTemplatesDir, pmId: "pm1", projectName: "P", target: "main", workers: "w:claude-code:claude-code", scouts: "s:claude-code:claude-code", smiths: "", librarians: "", observers: "", guardians: "", concierges: "", artisanSpec: "", scoutIdleTask: "false", defaultLane: "dock", skipConfirm: true, stack: "custom", qgCmds: ["true"], permissionProfile: "reviewed", agentsPolicy: "minimal", wsExile: false } satisfies FreshParams;
    expect(runFresh(p)).toBe(1);
  });
});
