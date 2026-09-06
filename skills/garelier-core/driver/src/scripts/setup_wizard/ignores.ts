import { rmSync } from "../../guard/path_guard.ts";
// W-083 ts-first: setup_wizard .claude/.gitignore helpers.
//
// Faithful port of garelier_write_claude_runtime_ignore /
// garelier_trim_claude_runtime_ignore from setup_wizard.ts (lines 144-177).
// Used by teardown (trim) and fresh/diff (write via the runtime-recovery hook).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { GarelierDirs } from "./env.ts";

const MARKER = "Garelier local Claude runtime";
const RUNTIME_BLOCK =
  "# Garelier local Claude runtime (W-035; project-root local hook state)\n" +
  "settings.local.json\n" +
  "runtime/\n" +
  "logs/\n";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

// garelier_write_claude_runtime_ignore <project-root>
export function writeClaudeRuntimeIgnore(projRoot: string): void {
  const ignore = `${projRoot}/.claude/.gitignore`;
  mkdirSync(`${projRoot}/.claude`, { recursive: true });
  if (existsSync(ignore)) {
    let raw = "";
    try {
      raw = readFileSync(ignore, "utf8");
    } catch {
      raw = "";
    }
    if (raw.includes(MARKER)) return;
    writeFileSync(ignore, `${raw}\n${RUNTIME_BLOCK}`);
  } else {
    writeFileSync(ignore, RUNTIME_BLOCK);
  }
  out(`  + ${projRoot}/.claude/.gitignore updated for local settings/runtime/logs`);
}

// garelier_trim_claude_runtime_ignore <project-root>
export function trimClaudeRuntimeIgnore(projRoot: string): void {
  const ignore = `${projRoot}/.claude/.gitignore`;
  if (!existsSync(ignore)) return;
  let raw: string;
  try {
    raw = readFileSync(ignore, "utf8");
  } catch {
    return;
  }
  if (!raw.includes(MARKER)) return;

  const lines = raw.split("\n");
  const hadTrailingNL = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadTrailingNL) lines.pop();

  const kept: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (/^# Garelier local Claude runtime/.test(line)) {
      skip = true;
      continue;
    }
    if (skip && (line === "settings.local.json" || line === "runtime/" || line === "logs/" || line === "")) {
      continue;
    }
    skip = false;
    kept.push(line);
  }
  const result = kept.length > 0 ? `${kept.join("\n")}\n` : "";
  if (result === "") {
    rmSync(ignore, { force: true });
    out(`  - removed now-empty ${projRoot}/.claude/.gitignore`);
  } else {
    writeFileSync(ignore, result);
    out(`  - removed Garelier runtime block from ${projRoot}/.claude/.gitignore`);
  }
}

// Write the nested __garelier/.gitignore and __garelier/.ignore from templates.
export function writeNestedIgnores(dirs: GarelierDirs): void {
  const tdir = process.env.GARELIER_CORE_TEMPLATES_DIR || `${dirs.skillsDir}/garelier-core/templates`;
  const giTmpl = `${tdir}/runtime_gitignore`;
  const igTmpl = `${tdir}/search_ignore`;
  mkdirSync("__garelier", { recursive: true });
  if (existsSync(giTmpl)) {
    copyFileSync(giTmpl, "__garelier/.gitignore");
    out("  + __garelier/.gitignore written (nested; project root untouched)");
  } else {
    process.stderr.write(`  ! runtime_gitignore template not found at ${giTmpl}\n`);
  }
  if (existsSync(igTmpl)) {
    copyFileSync(igTmpl, "__garelier/.ignore");
    out("  + __garelier/.ignore written (nested; project root untouched)");
  } else {
    process.stderr.write(`  ! search_ignore template not found at ${igTmpl}\n`);
  }
}
