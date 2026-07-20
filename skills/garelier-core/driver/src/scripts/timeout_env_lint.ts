#!/usr/bin/env bun
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(process.argv[2] || resolve(import.meta.dir, "../../.."));
const findings: string[] = [];
const timeoutName = "BASH_(?:MAX|DEFAULT)_TIMEOUT_MS";
const forbidden = [
  new RegExp(`process\\.env\\.${timeoutName}\\s*=`),
  new RegExp(`env\\[['\"]${timeoutName}['\"]\\]\\s*=`),
  new RegExp(`${timeoutName}.{0,50}(?:MAY|should|recommend|suggest).{0,20}(?:raise|increase|set)`, "i"),
  new RegExp(`${timeoutName}.{0,40}(?:引き上げ|上げる|設定推奨)`),
];

function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { walk(path); continue; }
    if (![".ts", ".md", ".toml"].includes(extname(path)) || /\.test\.ts$/.test(path) || entry.name === "timeout_env_lint.ts") continue;
    const text = readFileSync(path, "utf8");
    for (const pattern of forbidden) if (pattern.test(text)) findings.push(`${path}: ${pattern}`);
  }
}

walk(root);
if (findings.length) {
  process.stderr.write(`timeout_env_lint: forbidden timeout mutation/suggestion\n${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("timeout_env_lint: OK (read-only timeout policy)\n");
