#!/usr/bin/env bun
// gate_runner.ts — W-157: the ONE verified heavy-gate skeleton, so a lane never
// hand-writes lock/trap/marker/log again (the #353/#354 gate deaths: a package-name
// typo + a line-14 parse error left the lock stuck with no trap, and 3 OOM/exit1
// runs had no consistent RESULT marker). The PM passes only a STEP LIST (cargo
// command strings); the runner supplies:
//   1. heavy_compile_lock acquire with a NATIVE owner pid (this Bun process's
//      process.pid is a Windows PID, so the W-169 git-bash-$$ blind spot never
//      applies — the "winpid conversion" is built in);
//   2. GUARANTEED release in a finally (no `trap` to forget — a crash mid-step
//      still releases);
//   3. serial step execution into a single full log;
//   4. the marker contract (GATE_START / LOCK_ACQUIRED|LOCK_DISABLED /
//      STEP … EXIT n / RESULT GREEN|RED / ABORT_FAILOPEN / LOCK_RELEASED);
//   5. verbatim `test result:` extraction.
//
// It also converts a codex lane's delegated required gate (--from-register): a
// codex sandbox seat cannot take heavy_compile_lock (fence-out write), so it lists
// its required cargo gate for the PM to run here (#361, user 裁定 2026-07-18: codex-
// only implementation makes this the standard path).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { resolveBashExecutable } from "./_lib.ts";
import { evaluate, DEFAULT_POLICY, type GuardPolicy } from "../guard/command_guard.ts";

export interface GateStep { name: string; cmd: string }

// --- step parsing ----------------------------------------------------------

/** Parse a steps file. TOML: `[[step]] name=… cmd=…` (or a top-level `steps`
 * array); JSON: `{"steps":[{name,cmd}]}` or a bare array. A step's `cmd` is a shell
 * command string (cargo …); `name` defaults to `step<N>`. */
export function parseSteps(content: string, format: "toml" | "json"): GateStep[] {
  let raw: unknown;
  try { raw = format === "toml" ? parseToml(content) : JSON.parse(content); }
  catch (e) { throw new Error(`gate_runner: could not parse ${format} steps: ${(e as Error).message}`); }
  const list = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>)?.step ?? (raw as Record<string, unknown>)?.steps);
  if (!Array.isArray(list)) throw new Error("gate_runner: steps file has no `step`/`steps` array");
  const steps: GateStep[] = [];
  for (const [i, entry] of list.entries()) {
    const cmd = typeof entry === "string" ? entry : String((entry as Record<string, unknown>)?.cmd ?? "");
    if (!cmd.trim()) throw new Error(`gate_runner: step ${i + 1} has an empty cmd`);
    const name = (typeof entry === "object" && entry && String((entry as Record<string, unknown>).name || "").trim())
      || `step${i + 1}`;
    steps.push({ name, cmd: cmd.trim() });
  }
  if (steps.length === 0) throw new Error("gate_runner: steps file is empty");
  return steps;
}

/** Extract the PM-run gate commands a codex lane delegated in its register (#361).
 * The block is delimited by a `=== REQUIRED GATE (PM-run) ===` line and a closing
 * `=== END REQUIRED GATE ===`; each non-empty, non-comment line inside is one step
 * (a bare `cargo …` command, or `name: cargo …`). Empty when the block is absent. */
export function stepsFromRegister(registerText: string): GateStep[] {
  const start = /^\s*===+\s*REQUIRED GATE(?:\s*\(PM-run\))?\s*===+\s*$/im;
  const end = /^\s*===+\s*END REQUIRED GATE\s*===+\s*$/im;
  const lines = registerText.split(/\r?\n/);
  let inBlock = false;
  const steps: GateStep[] = [];
  for (const line of lines) {
    if (!inBlock) { if (start.test(line)) inBlock = true; continue; }
    if (end.test(line)) break;
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const named = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(t);
    if (named && /\s/.test(named[2])) steps.push({ name: named[1], cmd: named[2].trim() });
    else steps.push({ name: `step${steps.length + 1}`, cmd: t });
  }
  return steps;
}

// --- verbatim `test result:` extraction ------------------------------------

/** The cargo/libtest `test result:` lines, verbatim, in order — the evidence the
 * PM pastes into the gate verdict (never re-summarized). */
export function extractTestResults(log: string): string[] {
  return log.split(/\r?\n/).filter((l) => /test result:/.test(l)).map((l) => l.trim());
}

// --- marker contract -------------------------------------------------------

export const GATE_MARKERS = {
  start: (iso: string) => `GATE_START ${iso}`,
  lockAcquired: (token: string) => `LOCK_ACQUIRED token=${token}`,
  lockDisabled: () => `LOCK_DISABLED (heavy_compile disabled — running without the lock)`,
  abortFailopen: (reason: string) => `ABORT_FAILOPEN ${reason}`,
  stepPlanned: (name: string, cmd: string) => `STEP-PLANNED ${name}: ${cmd}`,
  stepStart: (name: string, iso: string) => `=== STEP ${name} START ${iso} ===`,
  stepExit: (name: string, code: number) => `=== STEP ${name} EXIT ${code} ===`,
  stepRejected: (name: string, reason: string) => `ABORT_STEP_REJECTED ${name}: ${reason}`,
  result: (green: boolean) => `RESULT ${green ? "GREEN" : "RED"}`,
  lockReleased: () => `LOCK_RELEASED`,
} as const;

// --- step validation (W-157 Guardian BLOCK) --------------------------------

// A `--from-register` step is authored by the (untrusted, sandbox-fenced) worker
// seat, so its head is restricted to the gate commands #361 actually needs
// (scoped cargo test + cooker + quality scripts); `--steps` is PM-authored and skips
// the allowlist. EVERY step (both modes) is additionally run through the real
// command_guard evaluate() BEFORE execution, at a producer seat fenced to the
// checkout — so egress / pipe-to-shell / destructive / index-mutating commands are
// DENIED exactly as at the Bash-tool layer this Bun-spawned path would otherwise
// bypass (`curl … | sh`, `rm -rf`, `git push`, `env … curl`).
const ALLOWED_REGISTER_HEAD = /^\s*(?:cargo|cargo-[\w-]+|rustfmt)\b|^\s*(?:bash\s+)?\.?\/?scripts?\/quality\//i;

const GATE_GUARD_POLICY: GuardPolicy = {
  ...DEFAULT_POLICY,
  remote_exec_guard_enabled: true, pipe_to_shell_guard_enabled: true, network_egress_guard_enabled: true,
  git_egress_guard_enabled: true, codex_raw_exec_guard_enabled: true, recursive_delete_guard_enabled: true,
  indirect_delete_guard_enabled: true, secret_file_guard_enabled: true, force_write_guard_enabled: true,
  path_fence_guard_enabled: true, process_kill_guard_enabled: true,
};

export interface StepCheck { ok: boolean; reason: string }

/** Validate ONE step before execution: (2) the register-mode head allowlist, then
 * (1) the real command_guard evaluate() at a producer seat fenced to the checkout. A
 * non-allow verdict (deny/ask) rejects the step and the gate does not run it. */
export function checkStep(cmd: string, opts: { cwd: string; requireAllowlist: boolean }): StepCheck {
  if (opts.requireAllowlist && !ALLOWED_REGISTER_HEAD.test(cmd)) {
    return { ok: false, reason: "head not in the --from-register allowlist (cargo / rustfmt / scripts/quality/) — PM must review + run it by hand" };
  }
  const d = evaluate({ command: cmd, tool: "Bash", cwd: opts.cwd, profile: "producer", fenceRoots: [opts.cwd], policy: GATE_GUARD_POLICY });
  if (d.action !== "allow") return { ok: false, reason: `command_guard ${d.action} (${d.rule})` };
  return { ok: true, reason: "" };
}

// --- executor --------------------------------------------------------------

export interface GateRunnerDeps {
  /** Acquire the heavy lock; returns the token line ("<slot>" | "OPEN" | "DISABLED"). */
  acquire: (ownerPid: string) => string;
  /** Release the lock by token (best-effort). */
  release: (token: string) => void;
  /** Run one step's shell command in `cwd`, append its output to the log, return exit code. */
  runStep: (cmd: string, cwd: string) => number;
  /** Validate a step BEFORE execution (W-157 BLOCK): allowlist + command_guard. */
  checkStep: (cmd: string) => StepCheck;
  /** Wall-clock stamp (injectable for deterministic tests). */
  now?: () => string;
  ownerPid?: string;
}

export interface GateRunOptions { steps: GateStep[]; cwd: string; logPath: string }
export interface GateRunResult { status: "GREEN" | "RED" | "ABORT_FAILOPEN"; token: string; testResults: string[]; code: number; plan: string[] }

/** Run the gate: PRE-EXEC ECHO the planned steps → VALIDATE every step (allowlist +
 * command_guard) → acquire → (finally release) → serial steps → markers → extract. A
 * rejected step aborts BEFORE any lock/execution (RESULT RED, no command runs — the
 * fenced worker's register can never proxy an unreviewed command). The lock is
 * released in `finally`, so a crash mid-step never leaks it (the #354 stuck-lock
 * class). OPEN from acquire = infrastructure ABORT; DISABLED = run without the lock. */
export function runGate(opts: GateRunOptions, deps: GateRunnerDeps): GateRunResult {
  const now = deps.now ?? (() => new Date().toISOString());
  const log = (line: string) => { try { appendFileSync(opts.logPath, line + "\n"); } catch { /* best-effort */ } };
  try { mkdirSync(dirname(opts.logPath), { recursive: true }); } catch { /* ignore */ }
  log(GATE_MARKERS.start(now()));

  // Pre-exec echo (PM-visible) + validate BEFORE taking the lock or running anything.
  const plan = opts.steps.map((s) => GATE_MARKERS.stepPlanned(s.name, s.cmd));
  for (const line of plan) log(line);
  for (const step of opts.steps) {
    const v = deps.checkStep(step.cmd);
    if (!v.ok) {
      log(GATE_MARKERS.stepRejected(step.name, v.reason));
      log(GATE_MARKERS.result(false));
      return { status: "RED", token: "", testResults: [], code: 1, plan };
    }
  }

  const token = deps.acquire(deps.ownerPid ?? String(process.pid)).trim();
  if (token === "OPEN" || token === "") {
    log(GATE_MARKERS.abortFailopen(token === "OPEN" ? "reason=lock-infra (heavy_compile_lock returned OPEN)" : "reason=empty-token"));
    return { status: "ABORT_FAILOPEN", token, testResults: [], code: 3, plan };
  }
  const locked = token !== "DISABLED";
  log(locked ? GATE_MARKERS.lockAcquired(token) : GATE_MARKERS.lockDisabled());

  let green = true;
  try {
    for (const step of opts.steps) {
      log(GATE_MARKERS.stepStart(step.name, now()));
      const code = deps.runStep(step.cmd, opts.cwd);
      log(GATE_MARKERS.stepExit(step.name, code));
      if (code !== 0) green = false;
    }
  } finally {
    if (locked) { deps.release(token); log(GATE_MARKERS.lockReleased()); }
  }
  log(GATE_MARKERS.result(green));
  const testResults = (() => { try { return extractTestResults(readFileSync(opts.logPath, "utf8")); } catch { return []; } })();
  return { status: green ? "GREEN" : "RED", token, testResults, code: green ? 0 : 1, plan };
}

// --- CLI -------------------------------------------------------------------

// heavy_compile_lock.ts lives in the CORE scripts dir (garelier-core/scripts/), NOT
// this driver/src/scripts/ dir. W-157 dogfood bug (#376 gate): the old
// `resolve(dirname, "heavy_compile_lock.ts")` pointed at a nonexistent sibling, so
// the acquire spawn failed instantly → empty stdout → empty token → ABORT_FAILOPEN
// (fail-closed as designed, but the gate could never run). Resolve it the SAME way
// merge-gate.ts's CORE_SCRIPTS_DIR does: up out of driver/src/scripts/ to
// garelier-core/, then into scripts/.
export const HEAVY_LOCK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "heavy_compile_lock.ts");

// W-157 BLOCK (4): a step runs with a MINIMAL env allowlist, never the PM's full
// process.env — so a step (even a validated one) can never read tokens/keys from the
// inherited environment (`env … | curl …` exfiltration).
const MINIMAL_ENV_KEYS = /^(?:PATH|Path|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TEMP|TMP|TMPDIR|SystemRoot|SystemDrive|ComSpec|windir|CARGO(?:_\w+)?|RUSTUP(?:_\w+)?|RUSTFLAGS|RUST_\w+|RUSTC\w*|CC|CXX|AR|MSYSTEM|MINGW\w*|LANG|LC_\w+|NUMBER_OF_PROCESSORS)$/;
// W-157 O elevation: a blanket secret drop that OVERRIDES the allowlist. The guard
// only inspects the shell string, so a compiled step (build.rs, a test body, a
// cargo credential-provider) that reads an env var and egresses directly is invisible
// to it — env minimisation is the ONLY defense there. So even an allowlisted var
// (e.g. `CARGO_REGISTRY_TOKEN` matches `CARGO_\w+`) is dropped if its name carries a
// credential marker. Fail-closed: match wins, the var is never forwarded.
const SECRET_ENV_RE = /_TOKEN|_SECRET|_PASSWORD|_KEY|_CREDENTIAL/i;
export function isSecretEnvKey(key: string): boolean { return SECRET_ENV_RE.test(key); }
function minimalEnv(): Record<string, string> {
  const out: Record<string, string> = { CARGO_INCREMENTAL: "0" };
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && MINIMAL_ENV_KEYS.test(k) && !SECRET_ENV_RE.test(k)) out[k] = v;
  }
  return out;
}

function defaultDeps(project: string, pmId: string, label: string, cwd: string, logPath: string, requireAllowlist: boolean): GateRunnerDeps {
  const bun = process.execPath;
  const bash = resolveBashExecutable() ?? "bash";
  return {
    acquire: (ownerPid) => {
      const r = Bun.spawnSync([bun, HEAVY_LOCK, "--project", project, "--pm-id", pmId, "--mode", "acquire", "--label", label, "--owner-pid", ownerPid, "--timeout-sec", "900"], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
      return (r.stdout?.toString() ?? "").trim().split(/\r?\n/).pop() ?? "";
    },
    release: (token) => {
      Bun.spawnSync([bun, HEAVY_LOCK, "--project", project, "--pm-id", pmId, "--mode", "release", "--token", token], { windowsHide: true, stdout: "ignore", stderr: "ignore" });
    },
    checkStep: (cmd) => checkStep(cmd, { cwd, requireAllowlist }),
    runStep: (cmd, stepCwd) => {
      // Run the (already-validated) command via Git Bash with the minimal env, and
      // append its combined output to the full log for verbatim `test result:` extraction.
      const r = Bun.spawnSync([bash, "-c", cmd], { windowsHide: true, cwd: stepCwd, stdout: "pipe", stderr: "pipe", env: minimalEnv() });
      try { appendFileSync(logPath, (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "")); } catch { /* best-effort */ }
      return r.exitCode ?? 1;
    },
    ownerPid: String(process.pid), // Bun's pid is the NATIVE Windows PID (W-169: no git-bash $$ blind spot)
  };
}

export function runCli(argv: string[]): { code: number; message: string } {
  const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const project = flag("project"); const pmId = flag("pm-id"); const label = flag("label") ?? "gate";
  const cwd = flag("cwd"); const stepsFile = flag("steps"); const fromRegister = flag("from-register");
  const logPath = flag("log") ?? (cwd ? `${cwd}/target/gate_runner.log` : "gate_runner.log");
  if (!project || !pmId) return { code: 2, message: "gate_runner: --project and --pm-id are required" };
  if (!cwd) return { code: 2, message: "gate_runner: --cwd (the checkout to run the gate in) is required" };
  if (!stepsFile && !fromRegister) return { code: 2, message: "gate_runner: one of --steps <file> or --from-register <path> is required" };

  let steps: GateStep[];
  try {
    if (stepsFile) {
      if (!existsSync(stepsFile)) return { code: 2, message: `gate_runner: --steps file not found: ${stepsFile}` };
      const fmt = /\.json$/i.test(stepsFile) ? "json" : "toml";
      steps = parseSteps(readFileSync(stepsFile, "utf8"), fmt);
    } else {
      if (!existsSync(fromRegister!)) return { code: 2, message: `gate_runner: --from-register file not found: ${fromRegister}` };
      steps = stepsFromRegister(readFileSync(fromRegister!, "utf8"));
      if (steps.length === 0) return { code: 2, message: `gate_runner: no '=== REQUIRED GATE (PM-run) ===' block with commands in ${fromRegister}` };
    }
  } catch (e) { return { code: 2, message: String(e) }; }

  const rcwd = resolve(cwd);
  // --from-register steps are worker-authored -> allowlist + guard; --steps are
  // PM-authored -> guard only (allowlist-exempt).
  const requireAllowlist = !!fromRegister;
  const result = runGate({ steps, cwd: rcwd, logPath: resolve(logPath) }, defaultDeps(project, pmId, label, rcwd, resolve(logPath), requireAllowlist));
  const tail = result.testResults.slice(-12).join("\n");
  return {
    code: result.code,
    // Pre-exec echo (the exact steps that ran / were rejected) so the PM can eyeball
    // the worker-authored gate before trusting the result.
    message: `${result.plan.join("\n")}\nRESULT ${result.status}\nlog=${resolve(logPath)}\n${tail}`,
  };
}

if (import.meta.main) {
  const { code, message } = runCli(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(message + "\n");
  process.exit(code);
}
