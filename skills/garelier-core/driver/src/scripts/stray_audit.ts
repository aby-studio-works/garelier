#!/usr/bin/env bun
//
// stray_audit.ts — name the gitignored piles git can't warn you about (W-084(d)).
//
// dispatch_cleanup removes checkouts and (W-084(a)) orphaned scratch, but a
// role or tool can still drop output OUTSIDE any lane — a report at the repo
// root, a build-output dir under `target/`, a `.claude/` written cwd-relative, a
// dir under a wrong pm_id. Those land in gitignored space, so `git status` never
// shows them and they accumulate silently (a live project measured 1.8GB).
//
// This audit enumerates three TOP-LEVEL surfaces and flags allowlist-outside
// entries — it REPORTS for human review, it does not delete. Covers the four
// measured classes:
//   1. wrong pm_id dir     — `__garelier/<X>/` where X != the real pm_id
//   2. cwd-relative .claude — a non-allowlisted entry under `__garelier/<pm>/`
//   3. target/ stray        — a non-cargo-standard entry under `target/`
//   4. repo root report     — a `*-REPORT.md` (or gitignored unknown) at the root
//
// CLI: stray_audit.ts --project <root> [--pm-id <id>] [--format json|text]
//   json (default): one JSON object { project, pm_id, strays:[…], count }.
//   text:           one human line per stray + a trailing count.
// Exit: 0 when clean, 1 when any stray is found (usable as a gate), 2 on a
// usage error.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { git } from "./_lib.ts";

const HELP = `stray_audit.ts — detect gitignored stray output git can't warn about (W-084(d)).

Usage:
  stray_audit.ts --project <root> [--pm-id <id>] [--format json|text]

Flags:
  --project <root>   project root to audit (required)
  --pm-id <id>       the real pm_id; enables the wrong-pm-id-dir class
  --format json|text output format (default json)
  -h, --help         this help

Exit: 0 clean, 1 strays found, 2 usage error.`;

export interface Stray {
  surface: "root" | "target" | "garelier" | "pm";
  class: "root-report" | "root-gitignored-unknown" | "target-stray" | "wrong-pm-id-dir" | "pm-child-stray";
  name: string;
  path: string;
  reason: string;
}

// Root entries that are legitimate even when gitignored (target/, node_modules/,
// __garelier/, editor dirs, …). A TRACKED project dir (core/, apps/) is never
// gitignored, so it is never flagged; this list only shields gitignored-but-fine
// entries from the root-gitignored-unknown class.
const ROOT_ALLOWLIST = new Set([
  "target", "Cargo.toml", "Cargo.lock", "src", "tests", "benches", "examples",
  "build.rs", "rust-toolchain.toml", "rust-toolchain", ".cargo",
  ".git", ".gitignore", ".gitattributes", ".github", ".vscode", ".idea", ".editorconfig",
  "__garelier", "showcase", "gallery", "node_modules", ".claude", ".codex", ".agents",
  "README.md", "LICENSE", "CHANGELOG.md", "AGENTS.md", "CLAUDE.md",
  "docs", "assets", "mods", "scripts", "bin",
]);

// Cargo-standard children of target/. A cross-compile triple dir (wasm32-…,
// x86_64-…) is also allowed. Anything else is a place-and-forget stray.
const TARGET_ALLOWLIST = new Set([
  "debug", "release", "doc", "tmp", "package", "CACHEDIR.TAG",
  ".rustc_info.json", ".cargo-lock", ".fingerprint",
]);
const TARGET_TRIPLE = /^(wasm32|wasm64|x86_64|i686|aarch64|arm|armv7|thumbv7|riscv|riscv32|riscv64|s390x|powerpc|powerpc64|mips|mipsel|loongarch64|sparc64|nvptx64)[\w.-]*$/;

// Fixed sibling set under `__garelier/<pm>/`. All role and dispatch
// containers are below `_crew/`; any other PM child is stray.
const PM_CHILD_ALLOWLIST = new Set([
  "_crew", "control", "runtime", "knowledge", "showcase", "gallery",
  "AGENTS.md", ".gitignore",
]);
const RESERVED_GARELIER_NAMESPACES = new Set(["__atmos"]);
const ROOT_REPORT = /-REPORT\.md$/i;

function dirEntries(path: string): string[] {
  try { return readdirSync(path).sort((a, b) => a.localeCompare(b)); } catch { return []; }
}

function isGitRepo(root: string): boolean {
  return existsSync(resolve(root, ".git"));
}

// `git check-ignore -q <name>` exits 0 when the path is gitignored. Only called
// inside a git repo; a git failure is treated as "not ignored" (fail-open — the
// audit must never crash on a weird checkout).
function isGitIgnored(root: string, name: string): boolean {
  return git(root, ["check-ignore", "-q", "--", name], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

export function auditStrays(project: string, pmId: string): Stray[] {
  const strays: Stray[] = [];
  const gitRepo = isGitRepo(project);

  // ── Surface 1: repo root ──────────────────────────────────────────────────
  for (const name of dirEntries(project)) {
    const full = resolve(project, name);
    if (ROOT_REPORT.test(name) && statSafe(full)?.isFile()) {
      strays.push({ surface: "root", class: "root-report", name, path: full, reason: "role report dropped at repo root (belongs in a lane / showcase)" });
      continue;
    }
    if (gitRepo && !ROOT_ALLOWLIST.has(name) && isGitIgnored(project, name)) {
      strays.push({ surface: "root", class: "root-gitignored-unknown", name, path: full, reason: "gitignored root entry outside the known allowlist (git can't warn about it)" });
    }
  }

  // ── Surface 2: target/ ────────────────────────────────────────────────────
  const targetDir = resolve(project, "target");
  if (statSafe(targetDir)?.isDirectory()) {
    for (const name of dirEntries(targetDir)) {
      if (TARGET_ALLOWLIST.has(name) || TARGET_TRIPLE.test(name)) continue;
      strays.push({ surface: "target", class: "target-stray", name, path: resolve(targetDir, name), reason: "non-cargo-standard entry under target/ (place-and-forget output)" });
    }
  }

  // ── Surface 3: __garelier/ ────────────────────────────────────────────────
  const garelierDir = resolve(project, "__garelier");
  if (statSafe(garelierDir)?.isDirectory()) {
    for (const name of dirEntries(garelierDir)) {
      const pmDir = resolve(garelierDir, name);
      if (!statSafe(pmDir)?.isDirectory()) continue;
      if (RESERVED_GARELIER_NAMESPACES.has(name)) continue;
      if (pmId && name !== pmId) {
        strays.push({ surface: "garelier", class: "wrong-pm-id-dir", name, path: pmDir, reason: `__garelier/${name} is not the configured pm_id (${pmId}) — likely a pm_id-resolution failure` });
        continue; // don't descend into a wrong-pm dir; the whole dir is the stray
      }
      // Children of a real pm dir (either the named pmId, or every pm dir when
      // pmId was not supplied) are checked against the fixed sibling set.
      for (const child of dirEntries(pmDir)) {
        if (PM_CHILD_ALLOWLIST.has(child)) continue;
        strays.push({ surface: "pm", class: "pm-child-stray", name: child, path: resolve(pmDir, child), reason: `non-allowlisted entry under __garelier/${name}/ (e.g. a cwd-relative .claude)` });
      }
    }
  }

  return strays;
}

function statSafe(path: string): ReturnType<typeof statSync> | null {
  try { return statSync(path); } catch { return null; }
}

function render(project: string, pmId: string, strays: Stray[], format: string): string {
  if (format === "text") {
    if (strays.length === 0) return "stray_audit: clean (0 strays)";
    const lines = strays.map((s) => `  [${s.class}] ${s.path}\n      ${s.reason}`);
    return `stray_audit: ${strays.length} stray(s) found under ${project}\n${lines.join("\n")}`;
  }
  return JSON.stringify({ project, pm_id: pmId || null, strays, count: strays.length });
}

export function main(argv = process.argv.slice(2)): number {
  let project = "", pmId = "", format = "json";
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": project = argv[i + 1] ?? ""; i += 2; break;
      case "--pm-id": pmId = argv[i + 1] ?? ""; i += 2; break;
      case "--format": format = argv[i + 1] ?? ""; i += 2; break;
      case "-h": case "--help": process.stdout.write(`${HELP}\n`); return 0;
      default:
        process.stderr.write(`stray_audit: unknown arg: ${argv[i]}\n`);
        return 2;
    }
  }
  if (!project) { process.stderr.write("stray_audit: --project <root> is required\n"); return 2; }
  if (format !== "json" && format !== "text") { process.stderr.write(`stray_audit: --format must be json|text (got '${format}')\n`); return 2; }
  if (!existsSync(project)) { process.stderr.write(`stray_audit: project root not found: ${project}\n`); return 2; }

  const strays = auditStrays(resolve(project), pmId);
  process.stdout.write(`${render(project, pmId, strays, format)}\n`);
  return strays.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main());
