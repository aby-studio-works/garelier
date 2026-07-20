import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, posix as posixPath, resolve, win32 as win32Path } from "node:path";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string[]) => RunResult;

export interface BashResolutionOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  isFile?: (path: string) => boolean;
  canonicalizeFile?: (path: string) => string | null;
  processExecPath?: string;
  runtimeTools?: RuntimeToolName[];
}

function envValue(env: Record<string, string | undefined>, name: string): string {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] ?? "" : "";
}

function absoluteForPlatform(path: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32Path.isAbsolute(path) : posixPath.isAbsolute(path);
}

function canonicalExecutable(path: string, options: NativeExecutableOptions): string | null {
  const platform = options.platform ?? process.platform;
  const candidate = path.trim().replace(/^"|"$/g, "");
  if (!candidate || !absoluteForPlatform(candidate, platform)) return null;
  if (options.canonicalizeFile) {
    const canonical = options.canonicalizeFile(candidate);
    return canonical && absoluteForPlatform(canonical, platform) ? canonical : null;
  }
  // Test seams that provide a synthetic isFile predicate have no real file to
  // realpath. Production never supplies the seam and always takes the strict
  // canonical branch below.
  if (options.isFile) return options.isFile(candidate) ? candidate : null;
  try {
    const canonical = realpathSync.native(candidate);
    return absoluteForPlatform(canonical, platform) && statSync(canonical).isFile() ? canonical : null;
  } catch { return null; }
}

/**
 * Resolve the Bash executable used for shell-sensitive driver launches.
 *
 * Every platform returns a verified absolute Bash path. Windows cannot rely on
 * ordinary PATH lookup: PowerShell sessions
 * commonly have Git for Windows installed without Git's `bin` directory on
 * PATH. Prefer an explicit GARELIER_BASH override, then PATH, then the standard
 * Git for Windows install roots.
 */
export function resolveBashExecutable(options: BashResolutionOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  if (platform !== "win32") {
    const override = envValue(env, "GARELIER_BASH").trim().replace(/^"|"$/g, "");
    const pinned = canonicalExecutable(override, { ...options, platform, env });
    if (pinned) return pinned;
    return resolveNativeExecutable("bash", { ...options, platform, env });
  }
  const candidates: string[] = [];
  const add = (candidate: string): void => {
    const path = candidate.trim().replace(/^"|"$/g, "");
    if (path && !candidates.some((existing) => existing.toLowerCase() === path.toLowerCase())) candidates.push(path);
  };

  add(envValue(env, "GARELIER_BASH"));

  for (const dir of envValue(env, "PATH").split(";").filter(Boolean)) {
    add(win32Path.join(dir.trim().replace(/^"|"$/g, ""), "bash.exe"));
  }

  const gitRoots: string[] = [];
  const addGitRoot = (root: string): void => {
    if (root && !gitRoots.some((existing) => existing.toLowerCase() === root.toLowerCase())) gitRoots.push(root);
  };
  for (const key of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
    const root = envValue(env, key);
    if (root) addGitRoot(win32Path.join(root, "Git"));
  }
  const localAppData = envValue(env, "LOCALAPPDATA");
  if (localAppData) addGitRoot(win32Path.join(localAppData, "Programs", "Git"));
  const systemDrive = envValue(env, "SystemDrive") || "C:";
  addGitRoot(win32Path.join(systemDrive, "Program Files", "Git"));
  addGitRoot(win32Path.join(systemDrive, "Program Files (x86)", "Git"));

  for (const root of gitRoots) {
    add(win32Path.join(root, "bin", "bash.exe"));
    add(win32Path.join(root, "usr", "bin", "bash.exe"));
  }

  for (const candidate of candidates) {
    const canonical = canonicalExecutable(candidate, { ...options, platform, env });
    if (canonical) return canonical;
  }
  return null;
}

export interface BashLaunch {
  executable: string;
  env: Record<string, string | undefined>;
}

export interface NativeExecutableOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  isFile?: (path: string) => boolean;
  canonicalizeFile?: (path: string) => string | null;
  processExecPath?: string;
}

/** Resolve one executable from an explicit PATH snapshot. */
export function resolveNativeExecutable(name: string, options: NativeExecutableOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const pathValue = envValue(env, "PATH");
  const separators = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32"
    ? (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase())
    : [""];
  const hasExtension = platform === "win32" && /\.[A-Za-z0-9]+$/.test(name);
  for (const dir of pathValue.split(separators).filter(Boolean)) {
    const clean = dir.trim().replace(/^"|"$/g, "");
    const pathApi = platform === "win32" ? win32Path : posixPath;
    if (!pathApi.isAbsolute(clean)) continue;
    const candidates = hasExtension
      ? [pathApi.join(clean, name)]
      : [...extensions.map((ext) => pathApi.join(clean, `${name}${ext}`)), pathApi.join(clean, name)];
    for (const candidate of candidates) {
      const canonical = canonicalExecutable(candidate, { ...options, platform, env });
      if (canonical) return canonical;
    }
  }
  return null;
}

export type RuntimeToolName = "bash" | "bun" | "cargo" | "uv" | "go" | "node" | "ruby" | "pandoc" | "drawio" | "gitleaks" | "git" | "pwsh" | "rg" | "codex" | "claude" | "cygpath" | "tasklist" | "taskkill";

const RUNTIME_TOOL_NAMES = new Set<RuntimeToolName>([
  "bash", "bun", "cargo", "uv", "go", "node", "ruby", "pandoc", "drawio", "gitleaks", "git", "pwsh", "rg", "codex", "claude", "cygpath", "tasklist", "taskkill",
]);

function toolOverrideName(name: string): string {
  return `GARELIER_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function standardRuntimeCandidates(name: RuntimeToolName, options: NativeExecutableOptions): string[] {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const userProfile = envValue(env, "USERPROFILE");
  const localAppData = envValue(env, "LOCALAPPDATA");
  const programFiles = envValue(env, "ProgramFiles") || "C:\\Program Files";
  const systemRoot = envValue(env, "SystemRoot") || "C:\\Windows";
  const candidates: string[] = [];
  const add = (path: string): void => { if (path && !candidates.some((x) => x.toLowerCase() === path.toLowerCase())) candidates.push(path); };
  if (name === "bun") {
    const running = options.processExecPath ?? process.execPath;
    if (/^bun(?:\.exe)?$/i.test(basename(running))) add(running);
    if (userProfile) add(win32Path.join(userProfile, ".bun", "bin", "bun.exe"));
  }
  if (name === "cargo" && userProfile) add(win32Path.join(userProfile, ".cargo", "bin", "cargo.exe"));
  if (name === "uv" && userProfile) add(win32Path.join(userProfile, ".local", "bin", "uv.exe"));
  if (name === "go") add(win32Path.join(programFiles, "Go", "bin", "go.exe"));
  if (name === "node") add(win32Path.join(programFiles, "nodejs", "node.exe"));
  if (name === "ruby") {
    const systemDrive = envValue(env, "SystemDrive") || "C:";
    for (const version of ["34", "33", "32", "31", "30"]) add(win32Path.join(systemDrive, `Ruby${version}-x64`, "bin", "ruby.exe"));
  }
  if (name === "pandoc") {
    if (localAppData) add(win32Path.join(localAppData, "Pandoc", "pandoc.exe"));
    add(win32Path.join(programFiles, "Pandoc", "pandoc.exe"));
  }
  if (name === "drawio") add(win32Path.join(programFiles, "draw.io", "draw.io.exe"));
  if (name === "git") add(win32Path.join(programFiles, "Git", "cmd", "git.exe"));
  if (name === "pwsh") add(win32Path.join(programFiles, "PowerShell", "7", "pwsh.exe"));
  if (name === "cygpath") {
    const bash = resolveBashExecutable(options);
    if (bash) {
      const bashDir = win32Path.dirname(bash);
      add(win32Path.basename(bashDir).toLowerCase() === "bin" && win32Path.basename(win32Path.dirname(bashDir)).toLowerCase() === "git"
        ? win32Path.join(bashDir, "..", "usr", "bin", "cygpath.exe")
        : win32Path.join(bashDir, "cygpath.exe"));
    }
  }
  if (name === "tasklist" || name === "taskkill") add(win32Path.join(systemRoot, "System32", `${name}.exe`));
  if (name === "rg" || name === "gitleaks" || name === "codex" || name === "claude") {
    if (localAppData) add(win32Path.join(localAppData, "Microsoft", "WinGet", "Links", `${name}.exe`));
    if (userProfile) add(win32Path.join(userProfile, ".local", "bin", `${name}.exe`));
  }
  return candidates;
}

/** Resolve an executable Garelier actually invokes. This is path resolution
 * only: explicit GARELIER_* override, PATH, then narrow OS-standard locations. */
export function resolveRuntimeExecutable(name: RuntimeToolName, options: NativeExecutableOptions = {}): string | null {
  if (name === "bash") return resolveBashExecutable(options as BashResolutionOptions);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const override = envValue(env, toolOverrideName(name)).trim().replace(/^"|"$/g, "");
  const pinned = canonicalExecutable(override, { ...options, platform, env });
  if (pinned) return pinned;
  const fromPath = resolveNativeExecutable(name, { ...options, platform, env });
  if (fromPath) return fromPath;
  if (platform !== "win32") return null;
  for (const candidate of standardRuntimeCandidates(name, { ...options, platform, env })) {
    const canonical = canonicalExecutable(candidate, { ...options, platform, env });
    if (canonical) return canonical;
  }
  return null;
}

/** Resolve the first executable of a configured command. Unknown commands get
 * the same override/PATH treatment but no guessed standard installation path. */
export function resolveCommand(command: string[], options: NativeExecutableOptions = {}): string[] | null {
  const raw = command[0];
  if (!raw) return null;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  if (/[\\/]/.test(raw)) {
    const exact = raw.trim().replace(/^"|"$/g, "");
    const canonical = canonicalExecutable(exact, options);
    return canonical ? [canonical, ...command.slice(1)] : null;
  }
  const lower = raw.replace(/\.exe$/i, "").toLowerCase();
  const executable = RUNTIME_TOOL_NAMES.has(lower as RuntimeToolName)
    ? resolveRuntimeExecutable(lower as RuntimeToolName, { ...options, env })
    : (() => {
      const override = envValue(env, toolOverrideName(lower)).trim().replace(/^"|"$/g, "");
      const pinned = canonicalExecutable(override, options);
      if (pinned) return pinned;
      return resolveNativeExecutable(raw, { ...options, env });
    })();
  if (!executable) return null;
  return [executable, ...command.slice(1)];
}

export function resolveBunExecutable(options: NativeExecutableOptions = {}): string | null {
  return resolveRuntimeExecutable("bun", options);
}

export function requireRuntimeExecutable(name: RuntimeToolName, options: NativeExecutableOptions = {}): string {
  const executable = resolveRuntimeExecutable(name, options);
  if (!executable) throw new Error(`required executable not found: ${name}`);
  return executable;
}

function prependExecutableDir(env: Record<string, string | undefined>, executable: string, platform: NodeJS.Platform): void {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = env[pathKey] ?? "";
  const separator = platform === "win32" ? ";" : ":";
  // W-114 (Linux parity): derive the bin dir with the TARGET platform's path API,
  // not node's real `dirname`. On a Linux CI host node's posix `dirname` sees a
  // Windows executable path (`C:\…\bash.exe`) as one backslash-laden component and
  // returns ".", so the prepended PATH entries were wrong there. Selecting the API
  // by the injected `platform` keeps this pure and correct on both hosts.
  const bin = (platform === "win32" ? win32Path : posixPath).dirname(executable);
  const entries = current.split(separator).filter(Boolean);
  const key = (value: string) => platform === "win32" ? value.replace(/^"|"$/g, "").toLowerCase() : value;
  if (!entries.some((entry) => key(entry) === key(bin))) env[pathKey] = current ? `${bin}${separator}${current}` : bin;
}

/** Resolve the shell executable and make that same Bash visible to commands
 * launched inside it. The PATH addition matters for configured commands such
 * as `bash script/check.sh`: a PowerShell parent can locate Git Bash only via
 * the standard-install fallback while its inherited PATH still lacks `bash`. */
export function resolveBashLaunch(options: BashResolutionOptions = {}): BashLaunch | null {
  const platform = options.platform ?? process.platform;
  const source = options.env ?? (process.env as Record<string, string | undefined>);
  const executable = resolveBashExecutable({ ...options, platform, env: source });
  if (!executable) return null;
  const env = { ...source };
  if (platform === "win32") {
    prependExecutableDir(env, executable, platform);
    const bun = resolveBunExecutable({ ...options, platform, env: source });
    if (bun) prependExecutableDir(env, bun, platform);
    for (const name of options.runtimeTools ?? []) {
      const tool = resolveRuntimeExecutable(name, { ...options, platform, env: source });
      if (tool) prependExecutableDir(env, tool, platform);
    }
  }
  return { executable, env };
}

export interface ProcessCountOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
}

function firstCsvField(line: string): string {
  if (!line.startsWith('"')) return line.split(",", 1)[0]?.trim() ?? "";
  let field = "";
  for (let i = 1; i < line.length; i++) {
    if (line[i] !== '"') { field += line[i]; continue; }
    if (line[i + 1] === '"') { field += '"'; i++; continue; }
    break;
  }
  return field;
}

function psProcessTokens(runner: CommandRunner): string[][] {
  let snapshot = "";
  for (const command of [["ps", "-W"], ["ps", "-e"], ["ps", "aux"]]) {
    try {
      const result = runner(command);
      if (result.exitCode === 0) { snapshot = result.stdout; break; }
    } catch { /* try the next POSIX ps form */ }
  }
  return snapshot.split(/\r?\n/).map((line) =>
    line.trim().split(/\s+/).filter(Boolean).map((token) => token.replace(/^.*[\\/]/, "")));
}

/** Count compile/build processes without requiring POSIX `ps` on Windows. */
export function compileProcessCount(pattern: string, options: ProcessCountOptions = {}): number {
  let regex: RegExp;
  try { regex = new RegExp(`^(?:${pattern})$`, "i"); } catch { return 0; }

  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? run;
  const count = (processes: string[][]): number => processes.filter((tokens) =>
    !tokens.some((token) => /sccache/i.test(token)) && tokens.some((token) => regex.test(token))).length;

  if (platform === "win32") {
    // tasklist is the primary Windows probe (W-143): it needs no POSIX `ps` and
    // enumerates native compiler image names (cargo.exe, rustc.exe, …), which the
    // default proc-regex matches via its `(\.exe)?` alternatives.
    try {
      const result = runner(["tasklist", "/FO", "CSV", "/NH"]);
      if (result.exitCode === 0) {
        const native = count(result.stdout.split(/\r?\n/).map(firstCsvField).filter(Boolean).map((name) => [name]));
        // Only native PE processes appear in tasklist; MSYS/cygwin build helpers
        // (and the oracle's `sleep` proxy) are invisible to it. When tasklist
        // matches nothing, consult Git Bash `ps` — always present on a Garelier
        // Windows host — so those still register. A strict superset: it can only
        // raise a zero to the true count, never manufacture a false STALLED.
        if (native > 0) return native;
      }
    } catch { /* tasklist unavailable — fall through to the POSIX probe */ }
    return count(psProcessTokens(runner));
  }

  return count(psProcessTokens(runner));
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
}

export function run(
  command: string[],
  options: RunOptions = {},
): RunResult {
  const stdout = options.stdout ?? "pipe";
  const stderr = options.stderr ?? "pipe";
  const childEnv = options.env ? { ...process.env, ...options.env } : { ...process.env };
  const resolvedCommand = resolveCommand(command, { env: childEnv });
  if (!resolvedCommand) return { exitCode: 127, stdout: "", stderr: `tool not found: ${command[0] ?? "<empty>"}` };
  const child = Bun.spawnSync(resolvedCommand, { windowsHide: true,
    cwd: options.cwd,
    // W-123: pass an explicit SNAPSHOT of process.env, not the live object. On
    // Windows Bun a child inherits the env captured at process start, so an
    // in-process mutation never reaches a
    // default-inherit child; spreading process.env here carries the current
    // values through. `undefined` override values drop the key from the child.
    env: childEnv,
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

/** Run through the centrally resolved Git Bash and its child PATH. */
export function runBash(args: string[], options: RunOptions = {}): RunResult {
  const requestedEnv = options.env ? { ...process.env, ...options.env } : { ...process.env };
  const shell = resolveBashLaunch({ env: requestedEnv });
  if (!shell) return { exitCode: 127, stdout: "", stderr: "Git Bash not found" };
  return run([shell.executable, ...args], { ...options, env: shell.env });
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
export type PidProbeVia = "os-signal" | "tasklist" | "msys-ps" | "unknown" | "dead";

export interface PidProbeOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  kill?: (pid: number, signal: 0) => void;
}

// W-169: a Git Bash `$$` is an MSYS pid — invisible to Windows process tools
// (`process.kill` / `tasklist` operate on Windows PIDs), so a probe that only asks
// Windows reads a LIVE git-bash lock owner as dead and reclaims its slot (the
// heavy_compile_lock mutual-exclusion break, 2026-07-19 18:21, owner=1620).
// Multiplex the probe across every pid interpretation: OS signal → Windows
// tasklist → MSYS `ps` (the pid in column 1). "dead" is returned ONLY when every
// interpretation misses, so the failure direction is fail-ALIVE (a false reclaim
// is impossible from a probe miss); callers may still grace-extend an unresolved
// pid. `via` names the winning probe for reclaim-log traceability (d).
export function probePidLiveness(pid: string | number, options: PidProbeOptions = {}): { alive: boolean; via: PidProbeVia } {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { alive: false, via: "dead" };
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? run;
  const kill = options.kill ?? ((p: number, s: 0) => process.kill(p, s));
  try { kill(n, 0); return { alive: true, via: "os-signal" }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return { alive: true, via: "os-signal" }; }
  if (platform === "win32") {
    let probed = false; // (W-169 b) did ANY process-list tool actually run?
    try {
      const r = runner(["tasklist", "/FI", `PID eq ${n}`]);
      if (r.exitCode === 0) { probed = true; if (new RegExp(`\\b${n}\\b`).test(r.stdout)) return { alive: true, via: "tasklist" }; }
    } catch { /* tool unavailable — try the MSYS probe */ }
    const ps = msysProbe(n, runner);
    if (ps.ran) probed = true;
    if (ps.found) return { alive: true, via: "msys-ps" };
    // W-169 (b): if NEITHER Windows nor MSYS process tooling could run, the pid is
    // unconvertible/unprobeable — treat it as alive (grace) rather than reclaiming
    // on an unproven owner. Only a pid absent from a tool that DID run is "dead".
    if (!probed) return { alive: true, via: "unknown" };
  }
  return { alive: false, via: "dead" };
}

// A pid is alive as an MSYS process when it appears in `ps` column 1 (the MSYS
// PID). Bare `ps` lists MSYS processes only; `ps -W` is the fallback form.
// `ran` reports whether any `ps` form succeeded (so the caller can tell "absent"
// from "could not probe").
function msysProbe(n: number, runner: CommandRunner): { found: boolean; ran: boolean } {
  for (const command of [["ps"], ["ps", "-W"]]) {
    try {
      const r = runner(command);
      if (r.exitCode !== 0) continue;
      for (const line of r.stdout.split(/\r?\n/)) {
        if (line.trim().split(/\s+/)[0] === String(n)) return { found: true, ran: true };
      }
      return { found: false, ran: true }; // ps succeeded but the pid is not a live MSYS process
    } catch { /* try the next ps form */ }
  }
  return { found: false, ran: false }; // no ps form could run
}

export function pidAlive(pid: string | number, options: PidProbeOptions = {}): boolean {
  return probePidLiveness(pid, options).alive;
}

// W-143: spawn/resume grace. A producer's FIRST minutes — premise-reading, docs,
// a codex think phase — legitimately look identical to a stall (commit 0, flat
// STATE/report fingerprint, 0 compile procs), so both watchdogs false-fired
// IDLE-DONE / working-stalled during that phase (2026-07-18 ×3: #351/#352, and the
// #352 resume-read phase). The reference is the dispatch container's `dispatched_at`
// marker (epoch seconds, written by dispatch_prepare at spawn) and a `resumed_at`
// marker (epoch, touched on a resume) — the LATER of the two is the grace anchor.
// ABSENT markers => null => NEVER in grace: a legacy container or a test fixture
// that writes no marker behaves EXACTLY as before, so the grace is strictly
// additive (opt-in via the marker's presence), never a new way to miss a real stall.
export interface GraceMarkerOptions { read?: (path: string) => string | null }

function readEpochMarker(path: string, read: (p: string) => string | null): number | null {
  const raw = read(path);
  if (raw === null) return null;
  const m = raw.trim().match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The grace anchor epoch (seconds) for a dispatch container: the LATER of its
 * `dispatched_at` and `resumed_at` markers, or null when neither is present. */
export function containerSpawnEpoch(container: string, options: GraceMarkerOptions = {}): number | null {
  if (!container) return null;
  const read = options.read ?? ((p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } });
  const dispatched = readEpochMarker(resolve(container, "dispatched_at"), read);
  const resumed = readEpochMarker(resolve(container, "resumed_at"), read);
  if (dispatched === null && resumed === null) return null;
  return Math.max(dispatched ?? 0, resumed ?? 0);
}

/** True while a dispatch is still inside its spawn/resume grace window. A null
 * anchor (no marker) or a non-positive grace disables it (fail toward the legacy
 * "fire" behaviour — grace only ever DELAYS, never SUPPRESSES, a real stall). */
export function withinSpawnGrace(spawnEpoch: number | null, nowSec: number, graceSec: number): boolean {
  if (spawnEpoch === null || graceSec <= 0) return false;
  return nowSec - spawnEpoch < graceSec;
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
