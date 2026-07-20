#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DESTRUCTIVE = new Set(["rm", "rmSync", "unlink", "unlinkSync", "rmdir", "rmdirSync", "rename", "renameSync"]);

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (name.endsWith(".ts")) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

export function lintRawDestructiveFs(root: string): string[] {
  const failures: string[] = [];
  const guard = resolve(root, "guard", "path_guard.ts");
  for (const file of files(root)) {
    if (resolve(file) === guard) continue;
    const text = readFileSync(file, "utf8");
    const rel = relative(root, file).replace(/\\/g, "/");
    const named = /import\s*\{([^}]*)\}\s*from\s*["']node:fs(?:\/promises)?["']/g;
    for (const match of text.matchAll(named)) {
      for (const raw of match[1].split(",")) {
        const binding = raw.trim().replace(/^type\s+/, "");
        const source = binding.split(/\s+as\s+/)[0]?.trim();
        if (DESTRUCTIVE.has(source)) failures.push(`${rel}: raw node:fs ${source} import bypasses path_guard`);
      }
    }
    const namespaces = [...text.matchAll(/import\s*\*\s*as\s+(\w+)\s*from\s*["']node:fs(?:\/promises)?["']/g)];
    for (const ns of namespaces) {
      const name = ns[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${name}\\s*\\.\\s*(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|rename|renameSync)\\s*\\(`).test(text)) {
        failures.push(`${rel}: namespace node:fs destructive call bypasses path_guard`);
      }
    }
  }
  return failures;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dir, ".."));
  const failures = lintRawDestructiveFs(root);
  if (failures.length) {
    process.stderr.write(`path_guard lint: ${failures.length} violation(s)\n${failures.map((x) => `  ${x}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("path_guard lint: OK\n");
}
