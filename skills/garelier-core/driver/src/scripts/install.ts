#!/usr/bin/env bun
//
// Garelier installer
//
// Symlinks each skills/garelier-* directory into the Claude Code and Codex CLI
// skill directories so both agents can discover them across all projects.
//
// Windows users: ensure Developer Mode is enabled
// (Settings -> Update & Security -> For Developers -> Developer Mode)
// before running this script under MSYS2 or Git Bash.
//
// TS port (W-083). CLI-frozen twin of the former install.sh. The shim
// install.sh sets GARELIER_INSTALL_ROOT to its own dir (== the old BASH_SOURCE
// SCRIPT_DIR, a git-bash path used verbatim in the printed messages) and execs
// this. Filesystem/symlink operations use NATIVE paths (bun is a native Windows
// process); the printed paths keep the git-bash form for output parity.
//
// AC6 (W-083 cross-platform): the is_windows() two-branch is preserved as
// `process.platform === "win32"` — the Windows arm creates the link with
// PowerShell New-Item SymbolicLink (needs Developer Mode); the POSIX arm uses
// `ln -s`.

import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "./_lib.ts";

const isWindows = process.platform === "win32";
const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

// --- path helpers (display form == git-bash, fs form == native) ---------------
let cygpathChecked = false;
let cygpathAvailable = false;
function hasCygpath(): boolean {
  if (!cygpathChecked) {
    cygpathChecked = true;
    cygpathAvailable = isWindows && run(["cygpath", "-w", "."], { stderr: "ignore" }).exitCode === 0;
  }
  return cygpathAvailable;
}
function cygpathW(p: string): string {
  const r = run(["cygpath", "-w", p], { stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.replace(/\r?\n$/, "") : p;
}
function cygpathU(p: string): string {
  const r = run(["cygpath", "-u", p], { stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.replace(/\r?\n$/, "") : p;
}
// Mirror the old normalize_path(): a native `C:\...`/`C:/...` becomes a git-bash
// path (for display); an already-unix path is left as-is.
function normalizePath(p: string): string {
  if (hasCygpath() && /^[A-Za-z]:[\\/]/.test(p)) return cygpathU(p);
  return p;
}
// Native filesystem form of a (display) path.
function toNative(p: string): string {
  if (isWindows && hasCygpath()) return cygpathW(p);
  return p;
}

// ROOT: display form from the shim (its own git-bash dir); fs form derived from
// this file's fixed repo-relative home (skills/garelier-core/driver/src/scripts
// -> 5 up == repo root).
const repoRootFs = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const rootDisplay =
  process.env.GARELIER_INSTALL_ROOT && process.env.GARELIER_INSTALL_ROOT !== ""
    ? process.env.GARELIER_INSTALL_ROOT
    : repoRootFs;
const sourceDisplay = `${rootDisplay}/skills`;
const sourceFs = join(repoRootFs, "skills");

// --- usage --------------------------------------------------------------------
// NB: the former heredoc was single-quoted (<<'EOF'), so these ${…} tokens are
// printed LITERALLY — do not interpolate them.
const USAGE = `Usage: install.sh [--all | --claude-only | --codex-only]

Symlinks skills/garelier-* into agent skill directories.

Default:
  --all          Install into Claude Code and Codex CLI skill roots.

Targets:
  --claude-only Install only into \${CLAUDE_HOME:-$HOME/.claude}/skills
  --codex-only  Install only into \${CODEX_HOME:-$HOME/.codex}/skills

Overrides:
  CLAUDE_HOME       Base directory for Claude Code state.
  CLAUDE_SKILLS_DIR Exact Claude Code skill directory.
  CODEX_HOME        Base directory for Codex CLI state.
  CODEX_SKILLS_DIR  Exact Codex CLI skill directory.`;
function usage(stream: (s: string) => void): void {
  stream(USAGE);
}

// --- arg parse ----------------------------------------------------------------
let installClaude = 1;
let installCodex = 1;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--all":
        installClaude = 1;
        installCodex = 1;
        break;
      case "--claude-only":
        installClaude = 1;
        installCodex = 0;
        break;
      case "--codex-only":
        installClaude = 0;
        installCodex = 1;
        break;
      case "-h":
      case "--help":
        usage(out);
        process.exit(0);
      default:
        err(`Error: unknown argument: ${a}`);
        usage(err);
        process.exit(1);
    }
  }
}

if (installClaude === 0 && installCodex === 0) {
  err("Error: no install targets selected");
  process.exit(1);
}

if (!existsSync(sourceFs) || !statSync(sourceFs).isDirectory()) {
  err(`Error: skills directory not found at ${sourceDisplay}`);
  process.exit(1);
}

// --- target skill dirs --------------------------------------------------------
function homeEnv(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}
function claudeSkillsDirDisplay(): string {
  if (process.env.CLAUDE_SKILLS_DIR) return normalizePath(process.env.CLAUDE_SKILLS_DIR);
  const home = normalizePath(process.env.CLAUDE_HOME || `${homeEnv()}/.claude`);
  return `${home}/skills`;
}
function codexSkillsDirDisplay(): string {
  if (process.env.CODEX_SKILLS_DIR) return normalizePath(process.env.CODEX_SKILLS_DIR);
  const home = normalizePath(process.env.CODEX_HOME || `${homeEnv()}/.codex`);
  return `${home}/skills`;
}

// --- symlink creation (is_windows two-branch, AC6) ----------------------------
function createSymlink(sourceNative: string, targetNative: string): void {
  if (isWindows) {
    // command -v powershell.exe
    if (run(["bash", "-c", "command -v powershell.exe >/dev/null 2>&1"], { stderr: "ignore" }).exitCode !== 0) {
      err("Error: powershell.exe is required to create native symlinks on Windows");
      process.exit(1);
    }
    const sourceWin = cygpathW(sourceNative);
    const targetWin = cygpathW(targetNative);
    const r = run(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$ErrorActionPreference = "Stop"; New-Item -ItemType SymbolicLink -Path $env:GARELIER_LINK_PATH -Target $env:GARELIER_LINK_TARGET | Out-Null',
      ],
      { env: { GARELIER_LINK_TARGET: sourceWin, GARELIER_LINK_PATH: targetWin }, stderr: "inherit" },
    );
    if (r.exitCode !== 0) process.exit(r.exitCode || 1);
  } else {
    const r = run(["ln", "-s", sourceNative, targetNative], { stderr: "inherit" });
    if (r.exitCode !== 0) process.exit(r.exitCode || 1);
  }
}

// Remove a symlink (never its target). A Windows directory symlink must go via
// rmdir (unlink EFAULTs on it); a file symlink via unlink. POSIX: unlink both.
function removeLink(p: string): void {
  if (isWindows) {
    try {
      rmdirSync(p);
      return;
    } catch {
      /* file symlink -> unlink below */
    }
  }
  unlinkSync(p);
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
// Local timestamp YYYYMMDD-HHMMSS, matching `date +%Y%m%d-%H%M%S`.
function backupStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

let lastInstalled = 0;
function installInto(label: string, skillsDirDisplay: string): void {
  const skillsDirFs = toNative(skillsDirDisplay);
  let installed = 0;

  mkdirSync(skillsDirFs, { recursive: true });

  out(`${label}: ${skillsDirDisplay}`);

  // `for skill_path in "${SOURCE_DIR}"/garelier-*` (nullglob) — sorted glob order.
  const names = readdirSync(sourceFs)
    .filter((n) => n.startsWith("garelier-"))
    .sort();
  for (const skillName of names) {
    const sourceNative = join(sourceFs, skillName);
    let isDir = false;
    try {
      isDir = statSync(sourceNative).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const targetDisplay = `${skillsDirDisplay}/${skillName}`;
    const targetNative = join(skillsDirFs, skillName);

    if (isSymlink(targetNative)) {
      // Replace existing symlink.
      removeLink(targetNative);
    } else if (pathExists(targetNative)) {
      // Back up existing real file/directory (one stamp for message + rename).
      const stamp = backupStamp();
      const backupDisplay = `${targetDisplay}.bak.${stamp}`;
      const backupNative = `${targetNative}.bak.${stamp}`;
      out(`  ! ${targetDisplay} exists. Backing up to ${backupDisplay}`);
      renameSync(targetNative, backupNative);
    }

    createSymlink(sourceNative, targetNative);
    out(`  + ${skillName}`);
    installed += 1;
  }

  if (installed === 0) {
    out(`  No skills found under ${sourceDisplay} (yet).`);
  } else {
    out(`  Installed ${installed} skill(s).`);
  }

  lastInstalled = installed;
}

let totalInstalled = 0;

if (installClaude === 1) {
  installInto("Claude Code", claudeSkillsDirDisplay());
  totalInstalled += lastInstalled;
}

if (installCodex === 1) {
  installInto("Codex CLI", codexSkillsDirDisplay());
  totalInstalled += lastInstalled;
}

out("");
if (totalInstalled === 0) {
  out(`No skills found under ${sourceDisplay} (yet).`);
  out("Add directories named 'garelier-*' under skills/ and re-run.");
} else {
  out(`Installed ${totalInstalled} skill link(s) across selected target(s).`);
  out("");
  out("Dev tip: to use the 'garelier <subcommand>' command (e.g. 'garelier doctor')");
  out("         in this symlink install, add this repo's bin/ to your PATH:");
  out(`           export PATH="${rootDisplay}/bin:$PATH"`);
  out("         (plugin installs add bin/ to PATH automatically.)");
  out("");
  out("See docs/getting_started.md to bootstrap a project.");
}
