// The framework version has ONE source: the repository `VERSION` file at the
// tree root. Every other surface derives from it.
//
// W-731: the setup wizard and the doctor each carried their own `"2.13.1"`
// string literal, so a release that bumped VERSION to 3.0.0 left them behind
// and the public CI's W-060 drift check went RED on the export tree. A literal
// that has to be hand-bumped in lockstep with another file is drift waiting to
// happen — the same shape as W-730, where a second copy of the pm_id pattern
// was free to disagree with the first. Read the authority instead of copying
// its value.
//
// The read is deliberately strict rather than defaulting to "unknown": these
// callers write the version INTO a generated `setup_config.toml` and then
// compare it back, so a silently wrong value would be recorded as fact in a
// user's project. A missing or malformed VERSION is a broken installation and
// says so.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";

const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// A FIXED number of `..` hops from `import.meta.dir` would be wrong: several
// entrypoints are bundled before they run, and in a bundle `import.meta.dir` is
// the bundle's directory, not this file's. Counting hops from `src/` then
// resolves to `skills/garelier-core/VERSION`, which does not exist, and the
// wizard refuses to start — measured against `dispatch_deadlock_w318`'s
// per-task routing case, which runs the driver bundled.
//
// So identify the root by what it CONTAINS instead of by distance: the
// repository root is the nearest ancestor holding both `VERSION` and `skills/`.
// Requiring both keeps a stray `VERSION` in some intermediate directory from
// being mistaken for the framework's.
function findVersionPath(): string {
  const root = parsePath(resolve(import.meta.dir)).root;
  for (let dir = resolve(import.meta.dir); ; dir = dirname(dir)) {
    const candidate = join(dir, "VERSION");
    if (existsSync(candidate) && existsSync(join(dir, "skills"))) return candidate;
    if (dir === root) return join(root, "VERSION");
  }
}

let cached: string | null = null;

/** The framework version, read from the repository VERSION file. */
export function frameworkVersion(): string {
  if (cached !== null) return cached;
  const versionPath = findVersionPath();
  let raw: string;
  try {
    raw = readFileSync(versionPath, "utf8");
  } catch (error) {
    throw new Error(
      `framework VERSION is unreadable at ${versionPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = raw.trim();
  if (!RELEASE_VERSION_RE.test(value)) {
    throw new Error(`framework VERSION is not a release version: ${JSON.stringify(value)} (${versionPath})`);
  }
  cached = value;
  return value;
}
