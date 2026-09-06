import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  configurePathGuardRoots,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "../guard/path_guard.ts";
import { run } from "../scripts/_lib.ts";

export interface CheckoutWriteProbe {
  ok: boolean;
  target: string;
  kind: "tracked-file-open" | "create-delete";
  error: string;
}

export interface CheckoutAclPreflightResult {
  checked: boolean;
  repaired: boolean;
  probe: CheckoutWriteProbe | null;
}

interface CheckoutAclPreflightDependencies {
  platform?: NodeJS.Platform;
  trackedFiles?: string[];
  workspaceSid?: string;
  codexHome?: string;
  probe?: (checkout: string, trackedFiles: string[], workspaceSid: string) => CheckoutWriteProbe;
  writeProbe?: (checkout: string, trackedFiles: string[]) => CheckoutWriteProbe;
  repair?: (checkout: string, workspaceSid: string) => void;
  log?: (message: string) => void;
}

interface CodexCapabilityState extends Record<string, unknown> {
  workspace: string;
  readonly: string;
  workspace_by_cwd: Record<string, string>;
}

const SID_PATTERN = /^S-1-5-21-(\d{1,10})-(\d{1,10})-(\d{1,10})-(\d{1,10})$/;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

function randomCapabilitySid(): string {
  const bytes = randomBytes(16);
  return `S-1-5-21-${bytes.readUInt32LE(0)}-${bytes.readUInt32LE(4)}-${bytes.readUInt32LE(8)}-${bytes.readUInt32LE(12)}`;
}

function validCapabilitySid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SID_PATTERN.exec(value);
  return match !== null && match.slice(1).every((part) => Number(part) <= 0xffff_ffff);
}

export function canonicalCodexWorkspaceKey(checkout: string): string {
  return realpathSync(checkout).replaceAll("\\", "/").toLowerCase();
}

function parseCapabilityState(path: string): CodexCapabilityState {
  if (!existsSync(path)) {
    return {
      workspace: randomCapabilitySid(),
      readonly: randomCapabilitySid(),
      workspace_by_cwd: {},
    };
  }

  const source = readFileSync(path, "utf8").trim();
  if (!source) throw new Error(`Codex capability SID state is empty: ${path}`);
  if (!source.startsWith("{")) {
    if (!validCapabilitySid(source)) throw new Error(`Codex capability SID state is invalid: ${path}`);
    return {
      workspace: source,
      readonly: randomCapabilitySid(),
      workspace_by_cwd: {},
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(source) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`could not parse Codex capability SID state ${path}: ${errorMessage(error)}`);
  }
  if (!validCapabilitySid(parsed.workspace) || !validCapabilitySid(parsed.readonly)) {
    throw new Error(`Codex capability SID state has an invalid workspace/readonly SID: ${path}`);
  }
  const rawMap = parsed.workspace_by_cwd;
  if (rawMap !== undefined && (rawMap === null || typeof rawMap !== "object" || Array.isArray(rawMap))) {
    throw new Error(`Codex capability SID state has an invalid workspace_by_cwd map: ${path}`);
  }
  const workspaceByCwd = { ...(rawMap as Record<string, string> | undefined) };
  for (const [key, sid] of Object.entries(workspaceByCwd)) {
    if (!key || !validCapabilitySid(sid)) {
      throw new Error(`Codex capability SID state has an invalid workspace_by_cwd entry: ${path}`);
    }
  }
  return { ...parsed, workspace_by_cwd: workspaceByCwd } as CodexCapabilityState;
}

export function assertExistingCapabilityEntriesPreserved(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  statePath: string,
): void {
  const changed = Object.entries(before).filter(([key, sid]) => after[key] !== sid);
  if (changed.length > 0) {
    throw new Error(
      `Codex capability SID persistence lost or changed ${changed.length} pre-existing workspace mapping(s) in ${statePath}; refusing to continue after detecting a lost update`,
    );
  }
}

/**
 * Resolve the exact synthetic SID that Codex will put in the restricted token
 * for this checkout. Codex creates the same random S-1-5-21 SID and persists it
 * under the canonical CWD key. Creating a missing entry here makes pre-launch
 * repair and the later Codex token use one identity.
 */
export function ensureCodexWorkspaceCapabilitySid(checkout: string, codexHome: string): string {
  // cap_sid is Codex-owned state. Declare only its owning home as an explicit
  // interop fence: relocating the file would split the SID used here from the
  // SID Codex loads later, leaving a dangling ACE while this probe false-greens.
  configurePathGuardRoots([codexHome]);
  const statePath = resolve(codexHome, "cap_sid");
  const state = parseCapabilityState(statePath);
  const key = canonicalCodexWorkspaceKey(checkout);
  const existing = state.workspace_by_cwd[key];
  if (existing) return existing;

  const entriesBeforeWrite = { ...state.workspace_by_cwd };
  const sid = randomCapabilitySid();
  state.workspace_by_cwd[key] = sid;
  mkdirSync(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.garelier-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, statePath);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve the state-write failure */ }
    throw new Error(`could not persist the Codex workspace capability SID for ${checkout}: ${errorMessage(error)}`);
  }
  const persistedState = parseCapabilityState(statePath);
  assertExistingCapabilityEntriesPreserved(entriesBeforeWrite, persistedState.workspace_by_cwd, statePath);
  const persisted = persistedState.workspace_by_cwd[key];
  if (persisted !== sid) {
    throw new Error(`Codex workspace capability SID changed during persistence for ${checkout}; refusing an ACL repair with an unbound SID`);
  }
  return sid;
}

function trackedProbeTarget(checkout: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.includes("\0")) return null;
  const candidate = resolve(checkout, path);
  const rel = relative(checkout, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) return null;
  try {
    const info = lstatSync(candidate);
    return !info.isSymbolicLink() && info.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Open one existing tracked file for read/write without changing its contents.
 * The fallback create/delete probe covers repositories with no tracked files.
 */
export function probeCheckoutWriteAccess(checkout: string, trackedFiles: string[]): CheckoutWriteProbe {
  for (const path of trackedFiles) {
    const target = trackedProbeTarget(checkout, path);
    if (!target) continue;
    try {
      const fd = openSync(target, constants.O_RDWR);
      closeSync(fd);
      return { ok: true, target, kind: "tracked-file-open", error: "" };
    } catch (error) {
      return { ok: false, target, kind: "tracked-file-open", error: errorMessage(error) };
    }
  }

  const target = resolve(checkout, `.garelier-write-probe-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    closeSync(fd);
    fd = null;
    unlinkSync(target);
    return { ok: true, target, kind: "create-delete", error: "" };
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* preserve the write-probe failure */ }
    }
    try { if (existsSync(target)) unlinkSync(target); } catch { /* preserve the write-probe failure */ }
    return { ok: false, target, kind: "create-delete", error: errorMessage(error) };
  }
}

export const WINDOWS_ACL_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$checkout = [Environment]::GetEnvironmentVariable('GARELIER_ACL_CHECKOUT_TARGET', 'Process')
$target = [Environment]::GetEnvironmentVariable('GARELIER_ACL_PROBE_TARGET', 'Process')
$rawSid = [Environment]::GetEnvironmentVariable('GARELIER_ACL_WORKSPACE_SID', 'Process')
if ([String]::IsNullOrWhiteSpace($checkout) -or -not [IO.Directory]::Exists($checkout)) {
  throw 'GARELIER_ACL_CHECKOUT_TARGET is not an existing directory'
}
if ([String]::IsNullOrWhiteSpace($target)) {
  throw 'GARELIER_ACL_PROBE_TARGET is empty'
}
$sid = [Security.Principal.SecurityIdentifier]::new($rawSid)
$sections = [Security.AccessControl.AccessControlSections]::Access
$acl = if ([IO.Directory]::Exists($target)) {
  [IO.Directory]::GetAccessControl($target, $sections)
} elseif ([IO.File]::Exists($target)) {
  [IO.File]::GetAccessControl($target, $sections)
} else {
  throw "ACL probe target does not exist: $target"
}
$required = [int][Security.AccessControl.FileSystemRights]::Modify
$allowed = 0
$denied = 0
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -ne $sid.Value) {
    continue
  }
  $bits = [int]$rule.FileSystemRights
  if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) {
    $denied = $denied -bor $bits
  } else {
    $allowed = $allowed -bor $bits
  }
}
if (($denied -band $required) -ne 0 -or ($allowed -band $required) -ne $required) {
  [Console]::Error.WriteLine(("workspace SID lacks effective Modify ACL on {0}: allowed={1} denied={2}" -f $target, $allowed, $denied))
  exit 7
}
`;

export const WINDOWS_ACL_REPAIR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$checkout = [Environment]::GetEnvironmentVariable('GARELIER_ACL_CHECKOUT_TARGET', 'Process')
$rawSid = [Environment]::GetEnvironmentVariable('GARELIER_ACL_WORKSPACE_SID', 'Process')
if ([String]::IsNullOrWhiteSpace($checkout) -or -not [IO.Directory]::Exists($checkout)) {
  throw 'GARELIER_ACL_CHECKOUT_TARGET is not an existing directory'
}
$sid = [Security.Principal.SecurityIdentifier]::new($rawSid)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [Security.AccessControl.FileSystemRights]::Modify,
  $inheritance,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
$acl = [IO.Directory]::GetAccessControl(
  $checkout,
  [Security.AccessControl.AccessControlSections]::Access
)
$acl.SetAccessRule($rule)
[IO.Directory]::SetAccessControl($checkout, $acl)
`;

function powershellAclCommand(script: string, checkout: string, workspaceSid: string, target?: string): ReturnType<typeof run> {
  return run([
    "powershell",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    env: {
      GARELIER_ACL_CHECKOUT_TARGET: checkout,
      GARELIER_ACL_WORKSPACE_SID: workspaceSid,
      ...(target ? { GARELIER_ACL_PROBE_TARGET: target } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function capabilityProbeTarget(checkout: string, trackedFiles: string[]): { target: string; kind: CheckoutWriteProbe["kind"] } {
  for (const path of trackedFiles) {
    const target = trackedProbeTarget(checkout, path);
    if (target) return { target, kind: "tracked-file-open" };
  }
  return { target: checkout, kind: "create-delete" };
}

export function probeCheckoutCapabilityAccess(
  checkout: string,
  trackedFiles: string[],
  workspaceSid: string,
): CheckoutWriteProbe {
  const target = capabilityProbeTarget(checkout, trackedFiles);
  const result = powershellAclCommand(WINDOWS_ACL_PROBE_SCRIPT, checkout, workspaceSid, target.target);
  if (result.exitCode === 0) return { ok: true, ...target, error: "" };
  const detail = (result.stderr.trim() || result.stdout.trim() || `PowerShell exit ${result.exitCode}`).slice(0, 2_000);
  return { ok: false, ...target, error: detail };
}

function repairWindowsCheckoutAcl(checkout: string, workspaceSid: string): void {
  const result = powershellAclCommand(WINDOWS_ACL_REPAIR_SCRIPT, checkout, workspaceSid);
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || "no diagnostic output").slice(0, 2_000);
    throw new Error(`workspace-capability ACL repair failed (PowerShell exit ${result.exitCode}): ${detail}`);
  }
}

function trackedFilesForCheckout(checkout: string): string[] {
  const result = run(["git", "-C", checkout, "ls-files", "-z"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || "no diagnostic output").slice(0, 2_000);
    throw new Error(`could not enumerate tracked files for the checkout write probe (git exit ${result.exitCode}): ${detail}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

export function shouldPreflightWindowsCheckout(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * Detect a missing current-seat ACL, repair the checkout root with an
 * inheritable Modify ACE for the exact Codex workspace capability SID, then
 * verify both that SID's effective ACL and an ordinary tracked-file write-open.
 * Repair failure never degrades to a warning.
 */
export function ensureWindowsCheckoutWritable(
  checkout: string,
  dependencies: CheckoutAclPreflightDependencies = {},
): CheckoutAclPreflightResult {
  const platform = dependencies.platform ?? process.platform;
  if (!shouldPreflightWindowsCheckout(platform)) return { checked: false, repaired: false, probe: null };

  const trackedFiles = dependencies.trackedFiles ?? trackedFilesForCheckout(checkout);
  const workspaceSid = dependencies.workspaceSid ?? ensureCodexWorkspaceCapabilitySid(
    checkout,
    dependencies.codexHome ?? process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
  );
  if (!validCapabilitySid(workspaceSid)) {
    throw new Error("checkout ACL preflight received an invalid Codex workspace capability SID");
  }
  const probe = dependencies.probe ?? probeCheckoutCapabilityAccess;
  const writeProbe = dependencies.writeProbe ?? probeCheckoutWriteAccess;
  const repair = dependencies.repair ?? repairWindowsCheckoutAcl;
  const log = dependencies.log ?? (() => {});
  const before = probe(checkout, trackedFiles, workspaceSid);
  if (before.ok) {
    const hostProbe = writeProbe(checkout, trackedFiles);
    if (!hostProbe.ok) {
      throw new Error(`checkout capability ACL is present but the host write probe failed (${hostProbe.kind}: ${hostProbe.target}: ${hostProbe.error})`);
    }
    log(`Windows checkout capability/write probe passed (${before.kind}: ${before.target})`);
    return { checked: true, repaired: false, probe: hostProbe };
  }

  log(`Windows checkout capability probe failed (${before.kind}: ${before.target}: ${before.error}); applying an inheritable Modify ACE for the current Codex workspace SID`);
  try {
    repair(checkout, workspaceSid);
  } catch (error) {
    throw new Error(`checkout ACL auto-repair could not run after write-probe failure at ${before.target}: ${errorMessage(error)}`);
  }

  const after = probe(checkout, trackedFiles, workspaceSid);
  if (!after.ok) {
    throw new Error(`checkout remains unwritable after workspace-capability ACL auto-repair (${after.kind}: ${after.target}: ${after.error})`);
  }
  const hostProbe = writeProbe(checkout, trackedFiles);
  if (!hostProbe.ok) {
    throw new Error(`workspace-capability ACL repair passed but the host write probe failed (${hostProbe.kind}: ${hostProbe.target}: ${hostProbe.error})`);
  }
  log(`Windows checkout ACL auto-repair succeeded; capability and write verification probes passed (${after.kind}: ${after.target})`);
  return { checked: true, repaired: true, probe: hostProbe };
}
