// Recurrence-prevention MECHANISM (not a one-off fix) for the class of bug where
// the autonomous flow silently deadlocks because the driver INSTRUCTS a role to
// run a git command it does not GRANT.
//
// Concrete origin: a producer is told to cut its branch, but GARELIER_GIT_ALLOWED_TOOLS
// granted `git checkout`/`git branch` and NOT `git switch`. A Dock-written
// assignment used the modern `git switch -c` idiom, the worker was denied, and it
// blocked at pickup — never reaching WORKING. No test caught the granted-vs-required
// drift, so it surfaced only as a stuck live run needing manual unblock.
//
// FIX: the set of git commands roles may run is externalized to a Librarian-managed
// SINGLE SOURCE OF TRUTH — skills/garelier-librarian/templates/git_command_policy.toml
// (seeded to docs/garelier/knowledge/). These tests treat that policy as
// authoritative and enforce it, so the driver grant and the role instructions can
// never drift away from it without failing CI (instead of stalling a live run).
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { GARELIER_GIT_ALLOWED_TOOLS } from "./claude_code.ts";

const POLICY_PATH = join(
  import.meta.dir, "..", "..", "..", "..",
  "garelier-librarian", "templates", "git_command_policy.toml",
);

function loadPolicy(): { allowed: string[]; forbidden: Record<string, string> } {
  const d = parseToml(readFileSync(POLICY_PATH, "utf8")) as {
    allowed?: string[]; forbidden?: Record<string, string>;
  };
  return { allowed: d.allowed ?? [], forbidden: d.forbidden ?? {} };
}

/** git subcommands the driver's protocol allowlist grants. */
function granted(): Set<string> {
  const s = new Set<string>();
  for (const t of GARELIER_GIT_ALLOWED_TOOLS) {
    const m = /^Bash\(git ([a-z][a-z-]+):/.exec(t);
    if (m) s.add(m[1]);
  }
  return s;
}

test("the Librarian git_command_policy.toml is present and non-empty (the SoT must resolve)", () => {
  expect(existsSync(POLICY_PATH)).toBe(true);
  const p = loadPolicy();
  expect(p.allowed.length).toBeGreaterThan(0);
});

test("driver git grant MIRRORS the policy `allowed` set exactly (no required gap, no drift)", () => {
  const policy = loadPolicy();
  const g = [...granted()].sort();
  const a = [...new Set(policy.allowed)].sort();
  // Every allowed command must be granted (else a producer deadlocks at the op),
  // and nothing outside the policy may be granted (else the grant drifts from the
  // single source of truth). Changing one side forces the other.
  expect(g).toEqual(a);
});

test("driver grants nothing the policy marks forbidden", () => {
  const policy = loadPolicy();
  const g = granted();
  const leaked = Object.keys(policy.forbidden).filter((c) => g.has(c));
  expect(leaked).toEqual([]);
});

test("no role instruction names a git command outside the policy (allowed ∪ forbidden)", () => {
  const policy = loadPolicy();
  // "operation" is a prose false match ("a git operation"), not a subcommand.
  const known = new Set<string>([...policy.allowed, ...Object.keys(policy.forbidden), "operation"]);
  const rels = [
    "../prompts.ts",
    "../../../garelier-worker/references/working-and-reporting.md",
    "../../../garelier-worker/references/review-rework-and-blocked.md",
    "../../../garelier-smith/SKILL.md",
    "../../../garelier-artisan/references/working-and-merging.md",
    "../../../garelier-librarian/SKILL.md",
  ];
  const instructed = new Set<string>();
  let scanned = 0;
  for (const rel of rels) {
    const p = join(import.meta.dir, rel);
    if (!existsSync(p)) continue;
    scanned++;
    for (const m of readFileSync(p, "utf8").matchAll(/\bgit ([a-z][a-z-]+)/g)) instructed.add(m[1]);
  }
  expect(scanned).toBeGreaterThan(0); // sources must resolve, or the guard is inert
  const uncovered = [...instructed].filter((c) => !known.has(c));
  expect(uncovered).toEqual([]); // a role names a git command neither granted nor documented-forbidden
});
