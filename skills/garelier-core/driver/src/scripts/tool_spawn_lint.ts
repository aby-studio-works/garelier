#!/usr/bin/env bun
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isNonSourceDirectory } from "./_lib.ts";

export interface BareToolSpawn {
  file: string;
  line: number;
  tool: string;
}

const TOOL = "bash|sh|ps|kill|which|chmod|mv|rm|bun|npm|npx|git|gitleaks|rg|pwsh|powershell|codex|claude|claude-code|cygpath|tasklist|taskkill";
const DIRECT_SPAWN = new RegExp(
  `(?:Bun\\.spawn(?:Sync)?|spawnSync|nodeSpawn|execFileSync)\\s*\\(\\s*(?:\\[\\s*)?["'](${TOOL})["']`,
  "g",
);
const INSTALL_RUN = /(?:\[\s*["']bunx["']|["'`]bunx\s|\[\s*["']bun["']\s*,\s*["']x["'])/g;

function withoutComments(source: string): string {
  let out = "";
  let block = false;
  for (const line of source.split("\n")) {
    let clean = "";
    for (let i = 0; i < line.length;) {
      if (block) {
        const end = line.indexOf("*/", i);
        if (end < 0) { i = line.length; continue; }
        block = false; i = end + 2; continue;
      }
      if (line.startsWith("/*", i)) { block = true; i += 2; continue; }
      if (line.startsWith("//", i)) break;
      clean += line[i++];
    }
    out += `${clean}\n`;
  }
  return out;
}

export function lintBareToolSpawns(root: string): BareToolSpawn[] {
  const violations: BareToolSpawn[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && (entry.name === "runtime" || isNonSourceDirectory(root, path))) continue;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name === "tool_spawn_lint.ts") continue;
      const source = withoutComments(readFileSync(path, "utf8"));
      DIRECT_SPAWN.lastIndex = 0;
      for (let match = DIRECT_SPAWN.exec(source); match; match = DIRECT_SPAWN.exec(source)) {
        violations.push({
          file: relative(root, path).replace(/\\/g, "/"),
          line: source.slice(0, match.index).split("\n").length,
          tool: match[1],
        });
      }
      INSTALL_RUN.lastIndex = 0;
      for (let match = INSTALL_RUN.exec(source); match; match = INSTALL_RUN.exec(source)) {
        violations.push({
          file: relative(root, path).replace(/\\/g, "/"),
          line: source.slice(0, match.index).split("\n").length,
          tool: "install-run",
        });
      }
    }
  };
  walk(resolve(root));
  return violations;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."));
  const violations = lintBareToolSpawns(root);
  for (const item of violations) process.stderr.write(`${item.file}:${item.line}: bare ${item.tool} spawn; use the central absolute-path resolver\n`);
  process.exit(violations.length ? 1 : 0);
}
