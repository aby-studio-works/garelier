#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isNonSourceDirectory } from "./_lib.ts";

const CHILD_PROCESS_METHODS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory() && (name === "__garelier" || isNonSourceDirectory(root, path))) continue;
      if (st.isDirectory()) walk(path);
      else if (name.endsWith(".ts")) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

// Preserve identifiers, punctuation, and line breaks while blanking comments
// and literal contents. This keeps call offsets stable and prevents examples,
// regex `.exec()`, and shell-oracle strings from masquerading as TS spawns.
export function maskLiteralsAndComments(text: string): string {
  const chars = [...text];
  let i = 0;
  const blank = (index: number): void => { if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " "; };
  while (i < chars.length) {
    const c = chars[i];
    const n = chars[i + 1];
    if (c === "/" && n === "/") {
      blank(i++); blank(i++);
      while (i < chars.length && chars[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && n === "*") {
      blank(i++); blank(i++);
      while (i < chars.length) {
        if (chars[i] === "*" && chars[i + 1] === "/") { blank(i++); blank(i++); break; }
        blank(i++);
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      blank(i++);
      while (i < chars.length) {
        if (chars[i] === "\\") { blank(i++); if (i < chars.length) blank(i++); continue; }
        const end = chars[i] === quote;
        blank(i++);
        if (end) break;
      }
      continue;
    }
    i++;
  }
  return chars.join("");
}

function childProcessBindings(text: string): { direct: Set<string>; namespaces: Set<string> } {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  const modulePattern = String.raw`["'](?:node:)?child_process["']`;
  const named = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${modulePattern}`, "g");
  for (const match of text.matchAll(named)) {
    for (const raw of match[1].split(",")) {
      const binding = raw.trim().replace(/^type\s+/, "");
      const parsed = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(binding);
      if (parsed && CHILD_PROCESS_METHODS.includes(parsed[1] as (typeof CHILD_PROCESS_METHODS)[number])) {
        direct.add(parsed[2] ?? parsed[1]);
      }
    }
  }
  const namespace = new RegExp(String.raw`import\s*\*\s*as\s*(\w+)\s*from\s*${modulePattern}`, "g");
  for (const match of text.matchAll(namespace)) namespaces.add(match[1]);
  return { direct, namespaces };
}

function matchingParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function lineColumn(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `${line}:${column}`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function lintText(text: string, file = "input.ts"): string[] {
  const masked = maskLiteralsAndComments(text);
  const bindings = childProcessBindings(text);
  const targets = [String.raw`Bun\s*\.\s*spawn(?:Sync)?`];
  for (const name of bindings.direct) targets.push(String.raw`\b${escapeRegex(name)}`);
  for (const ns of bindings.namespaces) {
    targets.push(String.raw`\b${escapeRegex(ns)}\s*\.\s*(?:${CHILD_PROCESS_METHODS.join("|")})`);
  }
  if (targets.length === 0) return [];
  const callPattern = new RegExp(`(?:${targets.join("|")})\\s*\\(`, "g");
  const failures: string[] = [];
  for (const match of masked.matchAll(callPattern)) {
    const start = match.index;
    const open = start + match[0].lastIndexOf("(");
    const close = matchingParen(masked, open);
    if (close < 0) {
      failures.push(`${file}:${lineColumn(text, start)}: unterminated child-process call`);
      continue;
    }
    const call = masked.slice(open + 1, close);
    if (!/\bwindowsHide\s*:\s*true\b/.test(call)) {
      failures.push(`${file}:${lineColumn(text, start)}: child-process call omits windowsHide: true`);
    }
  }
  return failures;
}

export function lintSpawnWindowsHide(root: string): string[] {
  const failures: string[] = [];
  for (const file of sourceFiles(root)) {
    const rel = relative(root, file).replace(/\\/g, "/");
    failures.push(...lintText(readFileSync(file, "utf8"), rel));
  }
  return failures;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dir, "..", "..", "..", "..", ".."));
  const failures = lintSpawnWindowsHide(root);
  if (failures.length) {
    process.stderr.write(`spawn windowsHide lint: ${failures.length} violation(s)\n${failures.map((f) => `  ${f}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("spawn windowsHide lint: OK\n");
}
