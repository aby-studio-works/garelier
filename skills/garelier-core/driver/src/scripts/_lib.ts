import { existsSync, readFileSync, readdirSync } from "node:fs";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function run(
  command: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdout?: "pipe" | "inherit" | "ignore";
    stderr?: "pipe" | "inherit" | "ignore";
  } = {},
): RunResult {
  const stdout = options.stdout ?? "pipe";
  const stderr = options.stderr ?? "pipe";
  const child = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: "inherit",
    stdout,
    stderr,
  });
  return {
    exitCode: child.exitCode,
    stdout: stdout === "pipe" ? child.stdout?.toString() ?? "" : "",
    stderr: stderr === "pipe" ? child.stderr?.toString() ?? "" : "",
  };
}

export function git(cwd: string, args: string[], options: Parameters<typeof run>[1] = {}): RunResult {
  return run(["git", "-C", cwd, ...args], options);
}

export function valueAfter(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value === "") {
    throw new Error(`missing value for ${argv[index]}`);
  }
  return value;
}

export function die(message: string, code = 2): never {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  process.exit(code);
}

export function printHelp(help: string): never {
  process.stdout.write(help.endsWith("\n") ? help : `${help}\n`);
  process.exit(0);
}

export function jsonEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}

export function emitJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Cross-platform process liveness for native pidfiles and runtime locks. */
export function pidAlive(pid: string | number): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
  }
  if (process.platform === "win32") {
    const r = Bun.spawnSync(["tasklist", "/FI", `PID eq ${n}`], { stdout: "pipe", stderr: "ignore" });
    return new RegExp(`\\b${n}\\b`).test(r.stdout?.toString() ?? "");
  }
  return false;
}

/** Sorted PM namespaces recognized by both legacy and control-only layouts. */
export function pmCandidates(garelierRoot: string): string[] {
  try {
    return readdirSync(garelierRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) =>
        existsSync(`${garelierRoot}/${name}/_pm/setup_config.toml`) ||
        existsSync(`${garelierRoot}/${name}/control/control.toml`))
      .sort();
  } catch {
    return [];
  }
}

export type ShellQuoteStyle = "single" | "printf-q";

/** Shell quoting used by command serialization; styles preserve legacy output. */
export function shellQuote(value: string, style: ShellQuoteStyle = "single"): string {
  if (style === "single") return `'${value.replace(/'/g, "'\\''")}'`;
  if (value === "") return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
  return value.replace(/[^A-Za-z0-9_./:=@%+,-]/g, (char) =>
    char === "\n" ? "$'\\n'" : `\\${char}`);
}

export function resolveProjectPm(
  project: string,
  pmId: string,
  options: { envFallback?: boolean; defaultProject?: string } = {},
): { project: string; pmId: string } {
  const envFallback = options.envFallback ?? false;
  return {
    project: project || (envFallback ? process.env.GARELIER_PROJECT ?? "" : "") || options.defaultProject || "",
    pmId: pmId || (envFallback ? process.env.GARELIER_PM_ID ?? "" : ""),
  };
}

export function readTomlScalar(path: string, section: string, key: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  let current = "";
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (heading) {
      current = heading[1];
      continue;
    }
    if (current !== section) continue;
    const match = line.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`));
    if (!match) continue;
    return match[1].replace(/\s*#.*$/, "").replace(/[\s"]/g, "");
  }
  return "";
}

export function readTomlQuoted(path: string, key: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"(.*)".*$`);
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(re);
    if (match) return match[1];
  }
  return "";
}

export function readTomlStringArray(path: string, key: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[(.*)\\].*$`);
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(re);
    if (!match || match[1] === "") continue;
    return [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  }
  return [];
}

export function utcCompact(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export function utcIsoSeconds(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
