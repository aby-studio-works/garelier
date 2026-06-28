import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function die(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

export function argValue(args: string[], name: string, fallback = ""): string {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function validPmId(id: string): boolean {
  return id === "_workshop" || /^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$/.test(id);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function touch(path: string): void {
  ensureDir(dirname(path));
  if (!existsSync(path)) writeFileSync(path, "");
}

export function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

export function copyMissingTree(srcRoot: string, destRoot: string): void {
  for (const src of listFiles(srcRoot)) {
    const rel = relative(srcRoot, src);
    const dest = join(destRoot, rel);
    if (!existsSync(dest)) {
      ensureDir(dirname(dest));
      copyFileSync(src, dest);
    }
  }
}

export function copyTree(srcRoot: string, destRoot: string): void {
  for (const src of listFiles(srcRoot)) {
    const rel = relative(srcRoot, src);
    const dest = join(destRoot, rel);
    ensureDir(dirname(dest));
    copyFileSync(src, dest);
  }
}

export function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) die((r.stderr || r.stdout || `git ${args.join(" ")} failed`).trim(), r.status || 1);
  return r.stdout.trimEnd();
}

export function gitHash(path: string, cwd = process.cwd()): string {
  return git(cwd, ["hash-object", path]).trim();
}

export function stripLegacyRootGitignore(project: string): void {
  const file = join(project, ".gitignore");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  if (!text.includes("Garelier transient state")) return;
  const next = text
    .split(/\r?\n/)
    .filter((line) => line !== "# Garelier transient state" && !/^__garelier\/\*\/runtime\/\s*$/.test(line))
    .join("\n");
  if (/\S/.test(next)) writeFileSync(file, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  else rmSync(file, { force: true });
}

export function selfDir(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}

export function scriptDir(metaUrl: string): string {
  return resolve(selfDir(metaUrl));
}

export function safeRelSelection(selection: string): void {
  if (selection.startsWith("/") || selection.includes("../") || selection.startsWith("../") || selection.endsWith("/..")) {
    die(`ERROR: selection must be control-relative and cannot contain '..': ${selection}`);
  }
}

export function cleanCsvItem(v: string): string {
  return v.trim();
}

export function pathBase(p: string): string {
  return basename(p);
}

export function tomlScalar(text: string, key: string): string {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m");
  return re.exec(text)?.[1] ?? "";
}

export function autoDetectPm(project: string, explicit = ""): string {
  if (explicit) return explicit;
  const root = join(project, "__garelier");
  if (!existsSync(root)) die(`ERROR: not a Garelier project (no __garelier/): ${project}`);
  const cands: string[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const d = join(root, ent.name);
    if (existsSync(join(d, "_pm", "setup_config.toml")) || existsSync(join(d, "control", "control.toml")) || existsSync(join(d, "runtime", "librarian"))) {
      cands.push(ent.name);
    }
  }
  if (cands.length === 1) {
    console.log(`  auto-detected pm-id: ${cands[0]}`);
    return cands[0];
  }
  if (cands.length === 0) die(`ERROR: no control namespace under ${root}; pass --pm-id.`);
  die(`ERROR: multiple PMs under ${root}; pass --pm-id <id>.`);
}
