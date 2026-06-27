// Role doc diet audit (W-021).
//
// Reports prompt-surface size and compact read-first hooks for role skills.
// Warning-only: this is a maintenance signal, not a contributor gate.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RoleDocDietItem {
  skill: string;
  entrypoint_words: number;
  reference_words: number;
  largest_reference: string | null;
  largest_reference_words: number;
  has_compact_hook: boolean;
  warnings: string[];
}

export interface RoleDocDietReport {
  schema_version: 1;
  generated_by: "role_doc_diet.ts";
  kind: "role_doc_diet";
  advisory: true;
  root: string;
  roles: RoleDocDietItem[];
  warnings: number;
  note: string;
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function files(dir: string): string[] {
  try { return readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isFile()); } catch { return []; }
}

export function buildRoleDocDiet(root: string): RoleDocDietReport {
  const skillsDir = join(root, "skills");
  const roles: RoleDocDietItem[] = [];
  for (const name of readdirSync(skillsDir).filter((n) => n.startsWith("garelier-")).sort()) {
    const skill = join(skillsDir, name, "SKILL.md");
    if (!existsSync(skill)) continue;
    const entry = readFileSync(skill, "utf8");
    const refs = files(join(skillsDir, name, "references")).filter((p) => p.endsWith(".md"));
    let refWords = 0;
    let largest: string | null = null;
    let largestWords = 0;
    for (const f of refs) {
      const w = words(readFileSync(f, "utf8"));
      refWords += w;
      if (w > largestWords) { largestWords = w; largest = f.replace(/\\/g, "/"); }
    }
    const compactHook = /context\.json|pickup_pack|report\.json|review_brief|guardian_scan|dock_pulse|compact JSON/i.test(entry);
    const warnings: string[] = [];
    if (words(entry) > 1800) warnings.push("entrypoint over 1800 words");
    if (largestWords > 3500) warnings.push("largest reference over 3500 words");
    if (!compactHook && !/control-(project|library)$/.test(name)) warnings.push("no compact read-first hook detected");
    roles.push({
      skill: name,
      entrypoint_words: words(entry),
      reference_words: refWords,
      largest_reference: largest,
      largest_reference_words: largestWords,
      has_compact_hook: compactHook,
      warnings,
    });
  }
  return {
    schema_version: 1,
    generated_by: "role_doc_diet.ts",
    kind: "role_doc_diet",
    advisory: true,
    root,
    roles,
    warnings: roles.reduce((n, r) => n + r.warnings.length, 0),
    note: "Warning-only prompt-surface audit. Use for maintenance planning; do not block unrelated contributors.",
  };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const root = flag("root") ?? process.cwd();
  const report = buildRoleDocDiet(root);
  if (process.argv.includes("--markdown")) {
    process.stdout.write("| Skill | Entry words | Reference words | Largest ref | Warnings |\n| --- | ---: | ---: | --- | --- |\n");
    for (const r of report.roles) {
      process.stdout.write(`| ${r.skill} | ${r.entrypoint_words} | ${r.reference_words} | ${r.largest_reference ?? "-"} | ${r.warnings.join("; ") || "-"} |\n`);
    }
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
}
