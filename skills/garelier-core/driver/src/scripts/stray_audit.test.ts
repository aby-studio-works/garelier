import { rmSync } from "../guard/path_guard.ts";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditStrays, main, type Stray } from "./stray_audit.ts";

// W-084(d): the audit names the four measured stray classes and stays silent on
// a clean tree. Fixtures are plain directory trees (no git init) so the
// deterministic classes fire without a repo; the git-only
// root-gitignored-unknown class is covered separately.

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "stray-audit-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function classes(strays: Stray[]): string[] {
  return strays.map((s) => s.class).sort();
}

describe("auditStrays — four measured classes", () => {
  // Build the tree that reproduces all four field-measured classes at once.
  function seedFourClasses(): void {
    // class 4: repo root report
    writeFileSync(join(root, "W-084-REPORT.md"), "producer report placed at the repo root\n");
    // legit tracked-shaped root entries that must NOT be flagged
    writeFileSync(join(root, "Cargo.toml"), "[package]\nname='x'\n");
    mkdirSync(join(root, "src"));
    // class 3: target/ place-and-forget (debug is cargo-standard, kept)
    mkdirSync(join(root, "target", "debug"), { recursive: true });
    mkdirSync(join(root, "target", "audio_preview"), { recursive: true });
    writeFileSync(join(root, "target", "audio_preview", "clip.wav"), "x");
    mkdirSync(join(root, "target", "wasm32-unknown-unknown"), { recursive: true }); // triple, kept
    // class 2: cwd-relative .claude under the real pm dir (control/runtime kept)
    mkdirSync(join(root, "__garelier", "tpm", "control"), { recursive: true });
    mkdirSync(join(root, "__garelier", "tpm", "runtime"), { recursive: true });
    mkdirSync(join(root, "__garelier", "tpm", ".claude", "runtime"), { recursive: true });
    // class 1: a wrong pm_id dir
    mkdirSync(join(root, "__garelier", "tpm", "_dispatch3"), { recursive: true }); // dispatch pattern, kept
    mkdirSync(join(root, "__garelier", "tpm-wrong", "runtime"), { recursive: true });
  }

  test("flags exactly the four classes, nothing legit", () => {
    seedFourClasses();
    const strays = auditStrays(root, "tpm");
    expect(classes(strays)).toEqual([
      "pm-child-stray",     // .claude under __garelier/tpm/
      "root-report",        // W-084-REPORT.md
      "target-stray",       // target/audio_preview
      "wrong-pm-id-dir",    // __garelier/tpm-wrong
    ]);
    // The stray names are the offenders, not the allowlisted neighbours.
    const byClass = Object.fromEntries(strays.map((s) => [s.class, s.name]));
    expect(byClass["root-report"]).toBe("W-084-REPORT.md");
    expect(byClass["target-stray"]).toBe("audio_preview");
    expect(byClass["pm-child-stray"]).toBe(".claude");
    expect(byClass["wrong-pm-id-dir"]).toBe("tpm-wrong");
    // A wrong-pm dir is not descended into (no double counting of its children).
    expect(strays.filter((s) => s.path.includes("tpm-wrong")).length).toBe(1);
  });

  test("clean tree yields zero strays", () => {
    writeFileSync(join(root, "Cargo.toml"), "[package]\nname='x'\n");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "target", "debug"), { recursive: true });
    mkdirSync(join(root, "target", "release"), { recursive: true });
    mkdirSync(join(root, "__garelier", "tpm", "control"), { recursive: true });
    mkdirSync(join(root, "__garelier", "tpm", "runtime"), { recursive: true });
    mkdirSync(join(root, "__garelier", "tpm", "_crew", "pm"), { recursive: true });
    mkdirSync(join(root, "__garelier", "tpm", "_dispatch1"), { recursive: true });
    expect(auditStrays(root, "tpm")).toEqual([]);
  });

  test("in a git repo, a gitignored non-allowlisted root entry is named; tracked/allowlisted are not", () => {
    const g = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { windowsHide: true, stdout: "ignore", stderr: "ignore" });
    if (g(["init", "-q"]).exitCode !== 0) return; // git unavailable — covered by other cases
    g(["config", "user.email", "ci@ci"]);
    g(["config", "user.name", "ci"]);
    writeFileSync(join(root, ".gitignore"), "build_junk/\n");
    writeFileSync(join(root, "Cargo.toml"), "[package]\nname='x'\n"); // tracked-shaped
    mkdirSync(join(root, "build_junk"));                              // gitignored pile
    writeFileSync(join(root, "build_junk", "out.bin"), "x");
    g(["add", "Cargo.toml", ".gitignore"]);
    g(["commit", "-q", "-m", "init"]);
    const strays = auditStrays(root, "");
    expect(classes(strays)).toEqual(["root-gitignored-unknown"]);
    expect(strays[0].name).toBe("build_junk");
  });

  test("without --pm-id, the wrong-pm-id class is skipped but pm-child strays still fire", () => {
    mkdirSync(join(root, "__garelier", "tpm", ".claude"), { recursive: true });
    mkdirSync(join(root, "__garelier", "other", "runtime"), { recursive: true });
    const strays = auditStrays(root, "");
    // Every __garelier child dir is treated as a real pm dir → only pm-child
    // strays, no wrong-pm-id-dir (can't tell which pm_id is correct).
    expect(classes(strays)).toEqual(["pm-child-stray"]);
    expect(strays[0].name).toBe(".claude");
  });
});

describe("main — CLI contract", () => {
  test("exit 1 + JSON when strays found, exit 0 when clean, exit 2 on usage error", () => {
    writeFileSync(join(root, "run-REPORT.md"), "x");
    const capture: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (s: string) => { capture.push(String(s)); return true; };
    try {
      expect(main(["--project", root, "--format", "json"])).toBe(1);
      const parsed = JSON.parse(capture.join(""));
      expect(parsed.count).toBe(1);
      expect(parsed.strays[0].class).toBe("root-report");

      capture.length = 0;
      const clean = mkdtempSync(join(tmpdir(), "stray-clean-"));
      expect(main(["--project", clean, "--format", "text"])).toBe(0);
      expect(capture.join("")).toContain("clean (0 strays)");
      rmSync(clean, { recursive: true, force: true });
    } finally {
      process.stdout.write = orig;
    }
    // usage errors (exit 2) — no --project, bad --format
    expect(main([])).toBe(2);
    expect(main(["--project", root, "--format", "xml"])).toBe(2);
  });

  test("the Bun TypeScript entrypoint is self-contained", () => {
    const entry = resolve(import.meta.dir, "stray_audit.ts");
    expect(existsSync(entry)).toBe(true);
    expect(readFileSync(entry, "utf8").startsWith("#!/usr/bin/env bun")).toBe(true);
  });
});
