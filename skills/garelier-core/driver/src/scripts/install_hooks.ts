#!/usr/bin/env bun
// OPT-IN local git hooks for Garelier (DEC-051 commit-message lint) — TS port of
// install_hooks.sh (W-083).
//
// Installs a commit-msg hook into THIS clone's .git/hooks only. It does NOT set
// core.hooksPath and commits nothing, so it never affects other contributors,
// non-Garelier users, or other-skill users. It is per-developer and reversible:
//   rm .git/hooks/commit-msg
// The installed hook also self-disables when bun is unavailable, so it can never
// block a plain `git commit` in a non-Garelier environment.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

function gitToplevel(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write((r.stderr || "git rev-parse --show-toplevel failed").trimEnd() + "\n");
    process.exit(r.status || 1);
  }
  return r.stdout.trimEnd();
}

const ROOT = args[0] && args[0].length > 0 ? args[0] : gitToplevel();
const HOOKS = `${ROOT}/.git/hooks`;
const SKILL = process.env.GARELIER_CORE_DIR || `${process.env.HOME}/.claude/skills/garelier-core`;
mkdirSync(HOOKS, { recursive: true });

const commitMsg = `${HOOKS}/commit-msg`;
if (existsSync(commitMsg)) {
  let body = "";
  try { body = readFileSync(commitMsg, "utf8"); } catch {}
  if (!body.includes("Garelier commit-msg lint")) {
    process.stderr.write(`Refusing to overwrite an existing non-Garelier commit-msg hook at ${commitMsg}.\n`);
    process.exit(1);
  }
}

// Byte-exact reproduction of the original heredoc (<<EOF): $SKILL is expanded,
// \$1 stays literal, and the block ends with a trailing newline.
const hook =
  `#!/usr/bin/env bash\n` +
  `# Garelier commit-msg lint (opt-in, DEC-051). Remove this file to disable.\n` +
  `command -v bun >/dev/null 2>&1 || exit 0   # no bun -> skip (never block a non-Garelier env)\n` +
  `exec bun "${SKILL}/scripts/lint_commits.ts" "$1"\n`;
writeFileSync(commitMsg, hook);
try { chmodSync(commitMsg, 0o755); } catch {}

console.log(`Installed opt-in commit-msg hook -> ${commitMsg}`);
console.log(`  (per-developer, local only; remove the file to disable; never affects others)`);
