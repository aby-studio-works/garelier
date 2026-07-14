#!/usr/bin/env bun
/**
 * rename_tracked_token.ts — ordered, case-aware, NUL-safe token replacer.
 *
 * Framework-maintenance tool for renaming vocabulary/paths across the repo
 * (e.g. the Symphorie→Garelier rebrand, DEC-050). Used together with the
 * Librarian runbook `tracked_path_rename_migration.md`, which covers the
 * BRANCH strategy (the part that actually bites — see that runbook first).
 *
 * Why a dedicated tool (lessons from DEC-050):
 *   1. ORDER MATTERS. Pass longest/most-specific stems first so a later bare
 *      rule cannot corrupt an earlier match (e.g. "orchestration"→"coordination"
 *      MUST run before "orchestra"→"dock", else you get "docktion"). This tool
 *      applies the pairs in the given array order, verbatim.
 *   2. NUL-SAFE. A naive replacer that skips any file containing a NUL byte will
 *      silently MISS source files that use an intentional NUL (e.g. a cache-key
 *      separator `${a}\0${b}`), AND `git grep` hides them too (it skips binary).
 *      This tool round-trips through latin1 (1 byte = 1 char, lossless) so such
 *      files are patched byte-exact, the NUL preserved. Only files with a
 *      known-binary extension (or, as a backstop, a high NUL density) are skipped.
 *
 * Usage:
 *   bun scripts/rename_tracked_token.ts <repo-root> <rules.json> [options]
 *
 *   <rules.json>  JSON array of ordered [from, to] pairs, e.g.
 *                 [["orchestration","coordination"],["Orchestra","Dock"],
 *                  ["orchestra","dock"], ...]
 *                 Provide every case variant explicitly (Title/UPPER/lower) —
 *                 replacement is case-SENSITIVE on purpose (preserves casing).
 *
 * Options:
 *   --files-from <listfile>   newline-separated paths (relative to repo-root).
 *                             Default: `git ls-files -z` (tracked files).
 *   --dry                     report only; write nothing.
 *   --include <ext,ext>       extra extensions to TREAT AS TEXT (override skip).
 *
 * Exit code: 0 on success, 2 on usage/IO error.
 *
 * NOTE: this only does the mechanical text replacement. File/dir RENAMES
 * (git mv), branch renames, worktree repair, symlink re-pointing and the
 * single-shared-rename-ancestor branch strategy are operator steps — see the
 * runbook. Always run with `--dry` first and review `git diff`.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// Extensions that are genuinely binary — never text-replace these.
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "bmp", "pdf", "zip", "gz", "tgz",
  "bz2", "xz", "7z", "rar", "jar", "class", "wasm", "woff", "woff2", "ttf", "otf",
  "eot", "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac", "exe", "dll", "so",
  "dylib", "bin", "o", "a", "lib", "pdb", "node",
]);

function fail(msg: string): never {
  console.error(`rename_tracked_token: ${msg}`);
  process.exit(2);
}

const root = process.argv[2];
const rulesPath = process.argv[3];
if (!root || !rulesPath) fail("usage: bun rename_tracked_token.ts <repo-root> <rules.json> [--files-from <f>] [--dry] [--include ext,ext]");
const dry = process.argv.includes("--dry");
const ffIdx = process.argv.indexOf("--files-from");
const filesFrom = ffIdx >= 0 ? process.argv[ffIdx + 1] : null;
const incIdx = process.argv.indexOf("--include");
const extraText = new Set((incIdx >= 0 ? (process.argv[incIdx + 1] ?? "") : "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

let rules: Array<[string, string]>;
try {
  rules = JSON.parse(readFileSync(rulesPath, "utf8"));
  if (!Array.isArray(rules) || rules.some((r) => !Array.isArray(r) || r.length !== 2 || typeof r[0] !== "string" || typeof r[1] !== "string")) {
    throw new Error("rules must be an array of [from, to] string pairs");
  }
} catch (e) {
  fail(`cannot read rules: ${(e as Error).message}`);
}

function applyAll(s: string): string {
  for (const [from, to] of rules) {
    if (from && s.includes(from)) s = s.split(from).join(to);
  }
  return s;
}

function ext(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1]! : "";
}

let files: string[];
if (filesFrom) {
  files = readFileSync(filesFrom, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
} else {
  const out = execSync("git ls-files -z", { cwd: root, encoding: "buffer", maxBuffer: 1 << 28 });
  files = out.toString("utf8").split("\0").map((s) => s.trim()).filter(Boolean);
}

let changed = 0;
let skippedBinary = 0;
const changedList: string[] = [];
for (const rel of files) {
  const abs = `${root}/${rel}`;
  let buf: Buffer;
  try { buf = readFileSync(abs); } catch { continue; }
  const e = ext(rel);
  if (BINARY_EXT.has(e) && !extraText.has(e)) { skippedBinary++; continue; }
  // Backstop: treat as binary if NUL density is high (a real binary with an
  // unlisted extension), but DO process files with a rare/intentional NUL.
  let nul = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) nul++;
  if (!extraText.has(e) && buf.length > 0 && nul / buf.length > 0.01) { skippedBinary++; continue; }
  // latin1 = byte-exact round-trip (preserves NUL + any UTF-8 bytes 1:1; the
  // ASCII tokens we replace never overlap UTF-8 continuation bytes).
  const orig = buf.toString("latin1");
  const next = applyAll(orig);
  if (next !== orig) {
    if (!dry) writeFileSync(abs, Buffer.from(next, "latin1"));
    changed++;
    changedList.push(rel);
  }
}
console.log(`changed ${changed} files (skipped ${skippedBinary} binary)${dry ? " [DRY RUN]" : ""}`);
for (const f of changedList) console.log("  " + f);
