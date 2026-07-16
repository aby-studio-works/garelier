// W-083 ts-first: setup_wizard environment/context helpers.
//
// Skills/driver-dir resolution (DEC-053 order), timestamp, and the small shell
// shims the bash used (cygpath -m, command -v). Ported from setup_wizard.sh
// lines 101-117 / helpers.

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { run } from "../_lib.ts";

export interface GarelierDirs {
  skillsDir: string;
  driverDir: string;
}

// Resolve the skills dir holding garelier-* (DEC-053: cache-safe + dual-mode).
//   1. ${CLAUDE_PLUGIN_ROOT}/skills (plugin runtime)
//   2. script-relative self-location — this file lives at
//      garelier-core/driver/src/scripts/setup_wizard/, four dirs up from its own
//      dir is the skills root; verified by garelier-core/SKILL.md presence.
//   3. legacy $HOME/.claude/skills (dev symlink last resort)
export function resolveGarelierDirs(): GarelierDirs {
  // import.meta.dir is .../garelier-core/driver/src/scripts/setup_wizard.
  // Climb to the skills root: setup_wizard -> scripts -> src -> driver ->
  // garelier-core -> skills (dirname of scripts, then four more).
  // Normalize to forward slashes: import.meta.dir is a native Windows path
  // (backslashes) but the wizard emits and consumes forward-slash paths, so the
  // resolved dirs stay consistent with the rest of the wizard (and bun/git/fs
  // all accept forward slashes on Windows).
  const scriptsDir = dirname(import.meta.dir).replace(/\\/g, "/"); // .../garelier-core/driver/src/scripts
  const selfSkills = dirname(dirname(dirname(dirname(scriptsDir)))); // .../skills
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  let skillsDir: string;
  if (pluginRoot && existsSync(`${pluginRoot}/skills/garelier-core/SKILL.md`)) {
    skillsDir = `${pluginRoot}/skills`;
  } else if (existsSync(`${selfSkills}/garelier-core/SKILL.md`)) {
    skillsDir = selfSkills;
  } else {
    skillsDir = `${process.env.HOME ?? ""}/.claude/skills`;
  }
  return { skillsDir, driverDir: `${skillsDir}/garelier-core/driver` };
}

// date -u +"%Y-%m-%dT%H:%M:%SZ"
export function nowIso(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function commandExists(name: string): boolean {
  return Bun.which(name) !== null;
}

// cygpath -m equivalent: prefer the real tool (matches MSYS symlink resolution),
// else the pure /c/... -> C:/... rewrite, else passthrough.
export function cygpathMixed(p: string): string {
  if (commandExists("cygpath")) {
    const r = run(["cygpath", "-m", p]);
    if (r.exitCode === 0) {
      const out = r.stdout.trim();
      if (out) return out;
    }
  }
  const m = p.match(/^\/([A-Za-z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  return p;
}
