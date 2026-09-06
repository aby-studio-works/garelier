#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { probePidLiveness, type PidProbeVia } from "./_lib.ts";
import { ROLE_SEAT_ENV } from "./spawn_env.ts";

export type ResidentComponent =
  | "sccache"
  | "status_web"
  | "fleet_watch"
  | "long_job_broker"
  | "merge_gate";
export type ResidentHealth = "healthy" | "absent" | "unhealthy" | "unverifiable";
export type ResidentVerdict = "PASS" | "RED" | "ENVIRONMENT_BLOCKED";

export interface ResidentObservation {
  component: ResidentComponent;
  pid: number | null;
  owner: string;
  provenance: string;
  health: ResidentHealth;
  reason: string;
  source: string;
  liveness: "alive" | "dead" | "unknown" | "not_applicable";
  livenessVia: PidProbeVia | "marker-absent" | "invalid-pid" | "probe-fixture" | "not_applicable";
  contamination: "not_proven" | "possible" | "not_applicable";
}

export interface ProbeOutcome {
  available: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ResidentPreflightResult {
  status: ResidentVerdict;
  exitCode: 0 | 1 | 3;
  reason: string;
  direct: ProbeOutcome;
  mediated: ProbeOutcome;
  components: ResidentObservation[];
  relevantComponent: ResidentComponent | null;
}

export class ResidentProcessEnvironmentError extends Error {
  readonly exitCode = 3;
}

function normalizedPath(path: string): string {
  return resolve(path).replace(/\\/g, "/").toLowerCase();
}

/** Runtime fallback for callers outside the command guard. The guard additionally
 * binds the no-daemon rule to the immutable dispatch record; this path/layout
 * check prevents an unset marker or a dispatch-container cwd from bypassing the
 * script-local refusal. */
export function isRoleSeat(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): boolean {
  if (env[ROLE_SEAT_ENV] === "1") return true;
  const path = normalizedPath(cwd);
  return /\/__garelier\/[^/]+\/_crew\/dispatch\d+(?:\/|$)/.test(path)
    || /\/__garelier\/[^/]+\/_crew\/(?:(?:workers|smiths|librarians)\/[^/]+|artisan)(?:\/|$)/.test(path);
}

export function assertOperatorResidentStart(
  component: Exclude<ResidentComponent, "sccache" | "merge_gate">,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): void {
  if (!isRoleSeat(env, cwd)) return;
  throw new ResidentProcessEnvironmentError(
    `ENVIRONMENT BLOCKED: role seat cannot start resident process '${component}'; use the operator-owned lifecycle`,
  );
}

function stringField(record: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pidField(record: Record<string, unknown>): number | null {
  const value = record.pid ?? record.host_pid;
  const pid = typeof value === "number" ? value : Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

interface MarkerDefinition {
  component: Exclude<ResidentComponent, "sccache">;
  path: string;
  absentReason: string;
  staleReason: string;
}

type PidProbeResult = { alive: boolean; via: PidProbeVia | "probe-fixture" };

function normalizePidProbe(value: boolean | PidProbeResult): PidProbeResult {
  return typeof value === "boolean"
    ? { alive: value, via: value ? "probe-fixture" : "dead" }
    : value;
}

function inspectMarker(
  definition: MarkerDefinition,
  probePid: (pid: number) => boolean | PidProbeResult,
): ResidentObservation {
  const base = {
    component: definition.component,
    source: definition.path,
    contamination: "not_proven" as const,
  };
  if (!existsSync(definition.path)) {
    return {
      ...base,
      pid: null,
      owner: "none",
      provenance: "marker-absent",
      health: "absent",
      reason: definition.absentReason,
      liveness: "not_applicable",
      livenessVia: "marker-absent",
    };
  }

  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(definition.path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("record is not an object");
    record = parsed as Record<string, unknown>;
  } catch {
    return {
      ...base,
      pid: null,
      owner: "unknown",
      provenance: "unreadable-marker",
      health: "unverifiable",
      reason: "marker exists but is unreadable; ownership and liveness are unverifiable",
      liveness: "unknown",
      livenessVia: "unknown",
    };
  }

  const pid = pidField(record);
  const owner = stringField(record, "owner", "owner_seat") || "unknown";
  const provenance = stringField(record, "provenance", "launcher_provenance") || "unrecorded";
  if (pid === null) {
    return {
      ...base,
      pid,
      owner,
      provenance,
      health: "unverifiable",
      reason: "marker has no valid named PID; liveness is unverifiable",
      liveness: "unknown",
      livenessVia: "invalid-pid",
    };
  }
  if (owner === "unknown" || provenance === "unrecorded") {
    return {
      ...base,
      pid,
      owner,
      provenance,
      health: "unverifiable",
      reason: "marker lacks recorded owner or launcher provenance",
      liveness: "unknown",
      livenessVia: "unknown",
    };
  }
  const liveness = normalizePidProbe(probePid(pid));
  if (liveness.via === "unknown") {
    return {
      ...base,
      pid,
      owner,
      provenance,
      health: "unverifiable",
      reason: "named PID liveness could not be verified",
      liveness: "unknown",
      livenessVia: liveness.via,
    };
  }
  if (!liveness.alive) {
    return {
      ...base,
      pid,
      owner,
      provenance,
      health: "unhealthy",
      reason: definition.staleReason,
      liveness: "dead",
      livenessVia: liveness.via,
    };
  }
  if (owner !== "operator" || provenance !== "operator-owned") {
    return {
      ...base,
      pid,
      owner,
      provenance,
      health: "unhealthy",
      reason: "PID is live with non-operator ownership/provenance",
      liveness: "alive",
      livenessVia: liveness.via,
    };
  }
  return {
    ...base,
    pid,
    owner,
    provenance,
    health: "healthy",
    reason: "live named PID with operator-owned provenance",
    liveness: "alive",
    livenessVia: liveness.via,
  };
}

export function inspectResidentMarkers(options: {
  projectRoot: string;
  pmId: string;
  isPidAlive?: (pid: number) => boolean | PidProbeResult;
}): ResidentObservation[] {
  const runtime = join(resolve(options.projectRoot), "__garelier", options.pmId, "runtime");
  const probe = options.isPidAlive ?? ((pid: number) => probePidLiveness(pid));
  const definitions: MarkerDefinition[] = [
    {
      component: "status_web",
      path: join(runtime, "status_web", "status_web.json"),
      absentReason: "Status Web pidfile absent; service is not running",
      staleReason: "stale pidfile: named Status Web PID is dead; this is a health failure, not proof of source/code failure or resident contamination",
    },
    {
      component: "fleet_watch",
      path: join(runtime, "driver", "fleet_watch.lock"),
      absentReason: "fleet watch lock absent; watch is not running",
      staleReason: "fleet watch lock names a dead PID",
    },
    {
      component: "long_job_broker",
      path: join(runtime, "long_jobs", ".broker.lock", "owner.json"),
      absentReason: "long-job broker lock absent; broker is not running",
      staleReason: "long-job broker lock names a dead PID",
    },
    {
      component: "merge_gate",
      path: join(runtime, "merge_gate", "locks", "active.lock"),
      absentReason: "merge-gate active lock absent; no request is active",
      staleReason: "merge-gate active lock names a dead PID; inspect request/result/log before recovery",
    },
  ];
  return definitions.map((definition) => inspectMarker(definition, probe));
}

function probeReason(probe: ProbeOutcome): string {
  if (!probe.available) return probe.stderr || "probe unavailable or intentionally not run";
  if (probe.exitCode === null) return "probe did not produce an exit status";
  if (probe.exitCode === 0) return "mediated probe succeeded";
  return `mediated probe failed (exit ${probe.exitCode})`;
}

export function evaluateResidentPreflight(options: {
  direct: ProbeOutcome;
  mediated: ProbeOutcome;
  markers: ResidentObservation[];
  commandComponent?: ResidentComponent | null;
}): ResidentPreflightResult {
  const relevantComponent = options.commandComponent === undefined ? "sccache" : options.commandComponent;
  const sccache: ResidentObservation = {
    component: "sccache",
    pid: null,
    owner: "unknown",
    provenance: "unrecorded",
    health: !options.mediated.available || options.mediated.exitCode === null
      ? "unverifiable"
      : options.mediated.exitCode === 0 ? "unverifiable" : "unhealthy",
    reason: options.mediated.available && options.mediated.exitCode === 0
      ? "sccache responded, but launcher ownership/provenance is not recorded"
      : probeReason(options.mediated),
    source: "captured failure and passive resident evidence",
    liveness: options.mediated.available && options.mediated.exitCode === 0 ? "alive" : "unknown",
    livenessVia: options.mediated.available && options.mediated.exitCode === 0 ? "not_applicable" : "unknown",
    contamination: "not_proven",
  };
  const components = [sccache, ...options.markers];
  const relevantObservation = relevantComponent === null
    ? null
    : components.find((row) => row.component === relevantComponent) ?? null;

  if (relevantComponent === null) {
    return {
      status: "RED",
      exitCode: 1,
      reason: "failed command is not mediated by a tracked resident component; unrelated resident evidence cannot override code RED",
      direct: options.direct,
      mediated: options.mediated,
      components,
      relevantComponent,
    };
  }

  if (relevantComponent === "sccache" && (!options.direct.available || options.direct.exitCode === null)) {
    return {
      status: "ENVIRONMENT_BLOCKED",
      exitCode: 3,
      reason: "direct executable baseline is unavailable or unverifiable",
      direct: options.direct,
      mediated: options.mediated,
      components,
      relevantComponent,
    };
  }
  if (relevantComponent === "sccache" && options.direct.exitCode !== 0) {
    return {
      status: "RED",
      exitCode: 1,
      reason: `direct executable baseline failed (exit ${options.direct.exitCode}); failure is not daemon-only`,
      direct: options.direct,
      mediated: options.mediated,
      components,
      relevantComponent,
    };
  }
  if (relevantComponent === "sccache"
    && (!options.mediated.available || options.mediated.exitCode === null || options.mediated.exitCode !== 0)) {
    return {
      status: "ENVIRONMENT_BLOCKED",
      exitCode: 3,
      reason: "direct executable baseline passed while the mediated path was unavailable or unhealthy",
      direct: options.direct,
      mediated: options.mediated,
      components,
      relevantComponent,
    };
  }
  if (!relevantObservation || relevantObservation.health === "absent"
    || relevantObservation.health === "unhealthy" || relevantObservation.health === "unverifiable") {
    return {
      status: "ENVIRONMENT_BLOCKED",
      exitCode: 3,
      reason: relevantObservation
        ? `${relevantObservation.component}: ${relevantObservation.reason}`
        : `${relevantComponent}: no component observation was available`,
      direct: options.direct,
      mediated: options.mediated,
      components,
      relevantComponent,
    };
  }
  return {
    status: "RED",
    exitCode: 1,
    reason: `${relevantComponent} is healthy; the failed command remains code RED`,
    direct: options.direct,
    mediated: options.mediated,
    components,
    relevantComponent,
  };
}

function simpleShellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (character === ";" || character === "|" || character === "&" || character === "\n" || character === "\r") return null;
    if (/\s/.test(character)) {
      if (current) { words.push(current); current = ""; }
      continue;
    }
    current += character;
  }
  if (quote) return null;
  if (current) words.push(current);
  return words;
}

function executableName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop()!.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

function normalizedSimpleInvocation(command: string): string[] | null {
  const words = simpleShellWords(command);
  if (!words || words.length === 0) return null;
  let index = 0;
  while (/^(?:command|exec)$/i.test(words[index] ?? "")) {
    index++;
    if (words[index] === "--") index++;
    else if ((words[index] ?? "").startsWith("-")) return null;
  }
  if (/^env$/i.test(words[index] ?? "")) {
    index++;
    while (index < words.length) {
      const word = words[index]!;
      if (word === "--") { index++; break; }
      if (/^(?:-i|--ignore-environment)$/i.test(word) || /^--(?:unset|chdir)=/i.test(word)) { index++; continue; }
      if (/^(?:-u|--unset|-C|--chdir)$/i.test(word)) { index += 2; continue; }
      if (word.startsWith("-")) return null;
      break;
    }
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;
  if (index >= words.length) return null;
  return [executableName(words[index]!), ...words.slice(index + 1)];
}

function isDirectSccacheControlCommand(command: string): boolean {
  const invocation = normalizedSimpleInvocation(command);
  if (!invocation || invocation[0] !== "sccache") return false;
  return /^(?:--show-stats|--zero-stats|--start-server|--stop-server|--dist-status|--package-toolchain|--version|-V)$/.test(invocation[1] ?? "");
}

function isSimpleRustBuildCommand(command: string): boolean {
  const invocation = normalizedSimpleInvocation(command);
  if (!invocation) return false;
  if (/^(?:cargo|rustc)$/.test(invocation[0] ?? "")) return true;
  return invocation[0] === "sccache" && executableName(invocation[1] ?? "") === "rustc";
}

export function residentComponentForCommand(command: string): ResidentComponent | null {
  const text = command.trim();
  if (isDirectSccacheControlCommand(text)) return "sccache";
  if (/(?:^|[;&|]\s*)(?:(?:bun|node|deno|tsx)\s+)?(?:["']?[^;&|\s]*[\\/])?status_web_cli\.ts["']?(?:\s|$)[\s\S]*\b(?:start|status|stop)\b/i.test(text)
    || /(?:^|[;&|]\s*)(?:(?:bun|node|deno|tsx)\s+)?(?:["']?[^;&|\s]*[\\/])?status_web\.ts["']?(?:\s|$)/i.test(text)) return "status_web";
  if (/(?:^|[;&|]\s*)(?:(?:bun|node|deno|tsx)\s+)?(?:["']?[^;&|\s]*[\\/])?fleet_watch\.ts["']?(?:\s|$)/i.test(text)) return "fleet_watch";
  if (/(?:^|[;&|]\s*)(?:(?:bun|node|deno|tsx)\s+)?(?:["']?[^;&|\s]*[\\/])?long_job_runner\.ts["']?(?:\s|$)[\s\S]*\bbroker\b/i.test(text)) return "long_job_broker";
  if (/(?:^|[;&|]\s*)(?:(?:bun|node|deno|tsx)\s+)?(?:["']?[^;&|\s]*[\\/])?merge-gate\.ts["']?(?:\s|$)/i.test(text)) return "merge_gate";
  return null;
}

const SCCACHE_COMPILE_FAILURE = /\bsccache(?:\.exe)?\s*:\s*error\s*:\s*failed to execute compile\b/i;
const SCCACHE_UNSUPPORTED_COMPILER = /\bsccache(?:\.exe)?\s*:\s*caused by\s*:\s*Compiler not supported\s*:/i;
const ABSOLUTE_COMPILER_PATH = /(?:[A-Za-z]:[\\/]|\/)(?:[^"'\r\n]*[\\/])*[^"'\r\n]*?(?:clang(?:-\d+)?|gcc(?:-\d+)?|cc|rustc)(?:\.exe)?(?=$|["':\s])/i;
const COMPILER_ENVIRONMENT_DENIAL = /\b(?:permission denied|access is denied|operation not permitted|os error (?:5|13))\b/i;

function hasCapturedCompilerBoundary(failureOutput: string): boolean {
  const compileFailure = failureOutput.search(SCCACHE_COMPILE_FAILURE);
  if (compileFailure < 0) return false;
  const mediatedWindow = failureOutput.slice(compileFailure, compileFailure + 4_096);
  const unsupportedCompiler = mediatedWindow.search(SCCACHE_UNSUPPORTED_COMPILER);
  if (unsupportedCompiler < 0) return false;
  const compilerWindow = mediatedWindow.slice(unsupportedCompiler, unsupportedCompiler + 2_048);
  const compilerPath = compilerWindow.search(ABSOLUTE_COMPILER_PATH);
  if (compilerPath < 0) return false;
  return COMPILER_ENVIRONMENT_DENIAL.test(compilerWindow.slice(compilerPath, compilerPath + 1_024));
}

/** Explicit and machine-config Cargo wrappers share one rule: only an
 * unambiguous single Rust-build exit with nearby mediator/environment evidence
 * binds to sccache. A shell compound cannot prove which segment supplied the
 * overall nonzero exit, so it remains code RED. */
export function residentComponentForFailure(command: string, failureOutput: string): ResidentComponent | null {
  const explicit = residentComponentForCommand(command);
  if (explicit !== null) return explicit;
  if (!isSimpleRustBuildCommand(command)) return null;
  return hasCapturedCompilerBoundary(failureOutput) ? "sccache" : null;
}

export function runResidentProcessPreflight(options: {
  projectRoot: string;
  pmId: string;
  command?: string;
  failureOutput?: string;
  directObservation?: ProbeOutcome;
}): ResidentPreflightResult {
  const commandComponent = options.command === undefined
    ? "sccache"
    : residentComponentForFailure(options.command, options.failureOutput ?? "");
  // Fail closed without spawning any compiler/resident client: even a nominally
  // passive sccache request can lazy-start its daemon, and rustc -Vv is still an
  // active compiler process. Classification uses only captured output, markers,
  // and an explicitly injected observation supplied by a bounded caller/test.
  const direct = options.directObservation ?? {
    available: false,
    exitCode: null,
    stdout: "",
    stderr: "active direct executable probe intentionally not run; classification is read-only",
  };
  const mediated: ProbeOutcome = {
    available: false,
    exitCode: null,
    stdout: "",
    stderr: "active sccache probe intentionally not run; classification uses captured failed-command evidence",
  };
  return evaluateResidentPreflight({
    direct,
    mediated,
    markers: inspectResidentMarkers(options),
    commandComponent,
  });
}

function value(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? "" : "";
}

export function main(argv = process.argv.slice(2)): number {
  const projectRoot = value(argv, "--project");
  const pmId = value(argv, "--pm-id");
  const format = value(argv, "--format") || "json";
  const allowed = new Set(["--project", "--pm-id", "--format"]);
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index] ?? "") || !argv[index + 1]) {
      process.stderr.write("usage: resident_process_health.ts --project <root> --pm-id <id> [--format json|text]\n");
      return 2;
    }
  }
  if (!projectRoot || !pmId || (format !== "json" && format !== "text")) {
    process.stderr.write("usage: resident_process_health.ts --project <root> --pm-id <id> [--format json|text]\n");
    return 2;
  }
  const result = runResidentProcessPreflight({ projectRoot, pmId });
  if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`RESIDENT_PROCESS_PREFLIGHT: ${result.status} — ${result.reason}\n`);
    for (const row of result.components) {
      process.stdout.write(`${row.component}\tpid=${row.pid ?? "none"}\towner=${row.owner}\tprovenance=${row.provenance}\thealth=${row.health}\treason=${row.reason}\n`);
    }
  }
  return result.exitCode;
}

if (import.meta.main) process.exit(main());
