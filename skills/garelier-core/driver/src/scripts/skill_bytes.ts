#!/usr/bin/env bun
// skill_bytes.ts — measure the PM's fixed read and prove every section moved out
// of `garelier-pm/SKILL.md` is still reachable in one hop from its index (W-599).
//
// Why a script and not a grep: the denominator must come from outside the thing
// being judged. A grep over SKILL.md can only see the rows SKILL.md chose to
// write, so deleting a row makes the census smaller and the check greener. Here
// the denominator is the set of reference files that carry an `absorbed-from`
// marker naming the section they took. Delete an index row and the marker is
// still there, so the file becomes unreachable and this exits non-zero.
//
//   bun skills/garelier-core/driver/src/scripts/skill_bytes.ts --project <root>
//   … --max-skill-bytes 8192   (default)
//   … --format json

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ABSORBED_MARKER = /<!--\s*absorbed-from:\s*garelier-pm\/SKILL\.md\s+(##[^>]*?)\s*-->/;
const DEFAULT_MAX_SKILL_BYTES = 8192;

/** Files a PM seat loads before it has read a single project file. */
const FIXED_READ = [
  "skills/garelier-pm/SKILL.md",
  "skills/garelier-core/SKILL.md",
];

type Row = { path: string; bytes: number };
type Unreachable = { file: string; section: string };

function parseArgs(argv: string[]): { project: string; maxSkillBytes: number; json: boolean } {
  let project = process.cwd();
  let maxSkillBytes = DEFAULT_MAX_SKILL_BYTES;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") { project = argv[i + 1] ?? project; i += 1; continue; }
    if (arg === "--max-skill-bytes") {
      const raw = argv[i + 1];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--max-skill-bytes expects a positive integer, got: ${raw}`);
      maxSkillBytes = parsed; i += 1; continue;
    }
    if (arg === "--format") { json = (argv[i + 1] ?? "") === "json"; i += 1; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { project: resolve(project), maxSkillBytes, json };
}

function byteLength(path: string): number {
  return statSync(path).size;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * The denominator: every reference file that declares it absorbed a section of
 * garelier-pm/SKILL.md. Derived from the reference tree, never from SKILL.md.
 */
function absorbedSections(project: string): Array<{ file: string; section: string }> {
  const root = join(project, "skills", "garelier-pm", "references");
  return walk(root)
    .map((file) => {
      const match = ABSORBED_MARKER.exec(readFileSync(file, "utf8"));
      return match ? { file: relative(project, file).replaceAll("\\", "/"), section: match[1].trim() } : null;
    })
    .filter((entry): entry is { file: string; section: string } => entry !== null)
    .sort((a, b) => a.file.localeCompare(b.file));
}

function main(): number {
  const { project, maxSkillBytes, json } = parseArgs(process.argv.slice(2));

  const fixed: Row[] = FIXED_READ.map((path) => ({ path, bytes: byteLength(join(project, path)) }));
  const pmSkillPath = join(project, "skills", "garelier-pm", "SKILL.md");
  const pmSkillBytes = byteLength(pmSkillPath);
  const pmSkillText = readFileSync(pmSkillPath, "utf8");

  const absorbed = absorbedSections(project);
  const unreachable: Unreachable[] = [];
  for (const entry of absorbed) {
    // One hop = the SKILL.md index names the file. `references/<name>` is the
    // spelling the routing table uses; accept the full repo-relative form too.
    const short = entry.file.replace(/^skills\/garelier-pm\//, "");
    if (!pmSkillText.includes(short) && !pmSkillText.includes(entry.file)) {
      unreachable.push({ file: entry.file, section: entry.section });
    }
  }

  const sizeOk = pmSkillBytes <= maxSkillBytes;
  const reachOk = unreachable.length === 0;
  const ok = sizeOk && reachOk;

  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok,
      pm_skill_bytes: pmSkillBytes,
      max_skill_bytes: maxSkillBytes,
      size_ok: sizeOk,
      fixed_read: fixed,
      fixed_read_total_bytes: fixed.reduce((sum, row) => sum + row.bytes, 0),
      absorbed_sections: absorbed.length,
      unreachable,
    }, null, 2)}\n`);
  } else {
    process.stdout.write("SKILL_BYTES fixed read (PM seat, before any project file)\n");
    for (const row of fixed) process.stdout.write(`  ${String(row.bytes).padStart(7)}  ${row.path}\n`);
    process.stdout.write(`  ${String(fixed.reduce((s, r) => s + r.bytes, 0)).padStart(7)}  TOTAL\n`);
    process.stdout.write(`SKILL_BYTES garelier-pm/SKILL.md = ${pmSkillBytes} B (max ${maxSkillBytes}) ${sizeOk ? "GREEN" : "RED"}\n`);
    process.stdout.write(`SKILL_BYTES absorbed sections = ${absorbed.length}, unreachable = ${unreachable.length} ${reachOk ? "GREEN" : "RED"}\n`);
    for (const entry of unreachable) {
      process.stdout.write(`  UNREACHABLE ${entry.file} (absorbed ${entry.section}) — no index row in garelier-pm/SKILL.md\n`);
    }
    process.stdout.write(`SKILL_BYTES RESULT ${ok ? "GREEN" : "RED"}\n`);
  }
  return ok ? 0 : 1;
}

process.exit(main());
