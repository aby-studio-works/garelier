// attended_record.ts — supply a dispatch permission record for a PM-attended
// Agent spawn (W-122).
//
// PM-attended subagents are launched directly (no dispatch_prepare
// dispatch), so command_guard.ts finds no DispatchPermissionRecord for them and
// falls back to the baseline-destructive profile — every unknown command then
// prompts (ask). This CLI writes the SAME record shape the guard already reads
// (a `guard` block inside a context-style JSON), keyed by agent name, at the
// location findDispatchPermissionRecord()'s agent-name scan looks in:
//   <root>/__garelier/<pm>/_crew/lanes/.meta/<agent>.dispatch.json
// so the attended seat resolves its role/gate/Concierge profile + trusted fence and
// (for role) takes the W-122 in-fence unknown-allow band.
//
// It never relaxes policy: it only supplies a record. The command_guard deny
// floor (out-of-fence delete, egress, secret files, forced rewrites) is
// unaffected — those classes evaluate first regardless of the seat's profile.
//
// W-155/W-206 (spawn-helper): a PM-attended agent that works the primary checkout
// (design/exec/triage — no dispatch container or isolated worktree) is a sanctioned
// PM-directed lightweight route (DEC-093), but a role record for it looks like the exact
// boundary violation the W-139 bypass-spawn detective hunts. `--pm-direct` writes
// a top-level `execution_route: "pm-direct"` marker (plus the legacy `lane_kind`
// marker during the compatibility window) so the detective DOWNGRADES that
// seat to advisory (it no longer flips the stall-scan's ok) while an UNdeclared
// role record on an unsanctioned worktree still hard-fails. This is the
// record that lets the PM keep command_guard ON for PM-direct work instead of
// falling to the baseline-destructive ask-on-everything seat.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
// W-135: route deletes through path_guard's rmSync (fence-checked) rather than
// the raw node:fs import that path_guard_lint flags as a guard bypass.
import { assertPathMutation, canonicalPath, rmSync } from "./path_guard.ts";
import {
  PERMISSION_PROFILES,
  ROLE_PERMISSION_PROFILE,
  type PermissionProfileName,
} from "./permission_profiles.ts";
import type { FrameworkRoleKind } from "../role_contracts.ts";
import {
  normalizeApprovedRemoteDestinations,
  type ApprovedRemoteDestination,
} from "./approved_remotes.ts";
// W-150: the writer and the guard's reader resolve the canonical control root
// through the SAME function, so the record's write destination and the reader's
// scan directory cannot drift apart.
import { GARELIER_DIRNAME, resolveControlRoot } from "./record_paths.ts";

/** The profiles a canonical managed-role attended seat may claim. */
export type AttendedProfile = PermissionProfileName;

export interface AttendedRecordOptions {
  agent: string;
  worktree?: string;
  profile?: AttendedProfile;
  /** Framework seat accountable for the action. Permission remains controlled
   * independently by `profile`; this field is attribution, not authority. */
  role?: FrameworkRoleKind;
  fenceRoots?: string[];
  /** Explicit filesystem root that CONTAINS `__garelier` (tests / non-derivable
   * launches). When omitted, walk up from the worktree to find it. */
  garelierRoot?: string;
  /** Explicit `__garelier/<pmId>` selector. When omitted, derive from the
   * worktree path or the sole pm under `__garelier`. */
  pmId?: string;
  /** W-206: mark the record as a deliberately-declared PM-directed route. The only
   * value is "pm-direct"; when set, the record carries a top-level `execution_route`
   * marker that downgrades the W-139 bypass-spawn detective to advisory for this
   * seat (DEC-093). Absent = an ordinary attended record — a role seat on an
   * unsanctioned worktree is then still a hard BYPASS-SPAWN. */
  executionRoute?: "pm-direct";
  /** Legacy writer API retained for the two-release compatibility window.
   * New callers use `executionRoute`; emitted records carry both field names. */
  laneKind?: "pm-direct";
  /** W-168 O4: the tool that wrote this record (e.g. "dispatch_prepare"). Stamped
   * top-level so the gate-name detective can exempt a conformant tool-written seat
   * from the hand-made-name flag. */
  spawnedVia?: string;
  /** W-159: verbatim verify commands the seat is allowed to run even under the
   * fail-closed gate profile. Written into `guard.quality_gate_commands`, which
   * command_guard reads; only a WHOLE-command verbatim match is allowed (an
   * unlisted script still fails closed). Empty when the seat runs no declared
   * verify command. */
  qualityGateCommands?: string[];
  /** W-183: supplementary cross-repo control roots this operator is authorized to
   * work in (a consuming-project PM-direct seat that also touches the garelier repo). Written
   * into `guard.additional_roots`; command_guard merges them into the effective
   * fence, so a declared cross-repo relative/bare-git op is in-fence instead of
   * falling to baseline-destructive. Validated like fence roots. */
  additionalRoots?: string[];
  /** W-305 round 2: PM-approved exact (remote name, destination) pairs for a
   * Concierge seat. They grant no authority on non-Concierge profiles. */
  approvedRemoteDestinations?: ApprovedRemoteDestination[];
}

const RECORD_SUFFIX = ".dispatch.json";

function sanitizeAgent(agent: string): string {
  const cleaned = agent.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) throw new Error(`attended_record: --agent is empty or has no usable characters: '${agent}'`);
  return cleaned;
}

/** Locate the `__garelier` directory: an explicit root's child, else the repo
 * MAIN-worktree root of `from` (W-150). A lane worktree is a full checkout that
 * carries a committed inner `__garelier`; a nearest-first walk-up stopped at it
 * and wrote the record into a nested tree the guard's reader never scans.
 * resolveControlRoot() resolves the shared gitdir's parent (or the farthest
 * ancestor when not a git repo) — the SAME resolver the reader uses — so the
 * write destination and the read scan cannot disagree. */
export function resolveGarelierDir(from: string, garelierRoot?: string): string {
  if (garelierRoot) {
    const explicit = join(resolve(garelierRoot), GARELIER_DIRNAME);
    if (!existsSync(explicit)) throw new Error(`attended_record: no __garelier under --garelier-root: ${explicit}`);
    return explicit;
  }
  const child = join(resolveControlRoot(from), GARELIER_DIRNAME);
  if (existsSync(child)) return child;
  throw new Error(`attended_record: could not find a __garelier directory for ${from} (pass --garelier-root)`);
}

/** Pick the pm id: explicit, else the `__garelier/<pm>/…` segment of the
 * worktree, else the sole subdirectory of `__garelier`. */
export function resolvePmId(garelierDir: string, worktree: string | undefined, pmId?: string): string {
  if (pmId) return pmId;
  if (worktree) {
    const parts = resolve(worktree).split(/[\\/]+/);
    const idx = parts.lastIndexOf("__garelier");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  }
  const dirs = readdirSync(garelierDir).filter((name) => {
    try { return statSync(join(garelierDir, name)).isDirectory(); } catch { return false; }
  });
  if (dirs.length === 1) return dirs[0];
  // W-155: a repo whose `__garelier` holds more than one PM namespace cannot be
  // guessed. Enumerate the candidates (sorted, so the message is stable) and show
  // the exact flag with a real example, so the operator does not have to re-list
  // the directory by hand to recover.
  const sorted = [...dirs].sort();
  const candidates = sorted.length ? sorted.join(", ") : "(none)";
  const example = sorted.length ? sorted[0] : "<pm-id>";
  throw new Error(
    `attended_record: cannot infer pm id under ${garelierDir} (${dirs.length} candidates: ${candidates}); ` +
      `pass --pm-id <id> (e.g. --pm-id ${example}).`,
  );
}

/** The append-only record path the guard's agent-name scan reads. */
export function recordPathFor(garelierDir: string, pmId: string, agent: string): string {
  return join(garelierDir, pmId, "_crew", "lanes", ".meta", `${sanitizeAgent(agent)}${RECORD_SUFFIX}`);
}

/** Reject a worktree that does not exist, is a drive root / shallow path, sits on
 * a .git component, or is not inside a git repo the PM controls. Reuses the
 * path_guard fence check (depth >= 3, no .git) with the worktree as its own root. */
export function validateWorktree(worktree: string): string {
  const path = canonicalPath(worktree);
  let stats;
  try { stats = statSync(path); } catch { throw new Error(`attended_record: --worktree does not exist: ${path}`); }
  if (!stats.isDirectory()) throw new Error(`attended_record: --worktree is not a directory: ${path}`);
  // Refuses drive roots / shallow paths (depth < 3) and any .git component.
  assertPathMutation(path, "write", { cwd: path, fenceRoots: [path] });
  // Must live inside a git repo (a worktree has a `.git` file or dir at some
  // ancestor) — a proxy for "a repo the PM controls".
  let dir = path;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return path;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`attended_record: --worktree is not inside a git repository: ${path}`);
}

export function buildRecord(opts: Required<Pick<AttendedRecordOptions, "agent">> & {
  worktree: string;
  profile: AttendedProfile;
  role?: FrameworkRoleKind;
  fenceRoots: string[];
  executionRoute?: "pm-direct";
  laneKind?: "pm-direct";
  spawnedVia?: string;
  qualityGateCommands?: string[];
  additionalRoots?: string[];
  approvedRemoteDestinations?: ApprovedRemoteDestination[];
}): Record<string, unknown> {
  // W-159: dedupe + drop blanks so the record carries a clean verbatim list.
  const qualityGateCommands = [
    ...new Set((opts.qualityGateCommands ?? []).map((c) => c.trim()).filter((c) => c.length > 0)),
  ];
  // W-183: dedupe cross-repo roots (already validated + canonicalized by the caller).
  const additionalRoots = [...new Set(opts.additionalRoots ?? [])];
  const approvedRemoteDestinations =
    normalizeApprovedRemoteDestinations(opts.approvedRemoteDestinations);
  const executionRoute = opts.executionRoute ?? opts.laneKind;
  return {
    schema_version: 1,
    source: "attended_record",
    ...(opts.spawnedVia ? { spawned_via: opts.spawnedVia } : {}), // W-168 O4

    // W-206: a deliberately-declared PM-directed route marks itself here (top-level,
    // beside `source`). The W-139 bypass-spawn detective (contract_check.ts
    // scanBypassSpawns) reads this marker and downgrades a role record that
    // carries it to advisory. Omitted when not declared, so an undeclared
    // role seat on an unsanctioned worktree stays a hard BYPASS-SPAWN.
    ...(executionRoute
      ? {
          execution_route: executionRoute,
          // Read compatibility for pre-W-206 consumers; remove only after the
          // documented two-release window.
          lane_kind: executionRoute,
        }
      : {}),
    guard: {
      permission_profile: opts.profile,
      fence_roots: opts.fenceRoots,
      role: opts.role ?? opts.profile,
      agent_name: opts.agent,
      worktree: opts.worktree,
      // W-159: the field command_guard's permissionRecordFrom() reads (a flat
      // string list). The gate seat's own row-verify commands ride the
      // whole-command verbatim allow (isDeclaredWholeCommand); an unlisted
      // command still fails closed. Empty = no declared verify command.
      quality_gate_commands: qualityGateCommands,
      // W-183: extra repo control roots this operator is authorized to work in;
      // command_guard merges them into the effective fence. Omitted when none, so
      // an ordinary single-repo seat's record is unchanged.
      ...(additionalRoots.length ? { additional_roots: additionalRoots } : {}),
      ...(opts.profile === "concierge"
        ? { approved_remote_destinations: approvedRemoteDestinations }
        : {}),
    },
    attended: { written_at: new Date().toISOString() },
  };
}

export interface WriteResult { path: string; record: Record<string, unknown>; }

export function writeAttendedRecord(opts: AttendedRecordOptions, cwd = process.cwd()): WriteResult {
  const agent = sanitizeAgent(opts.agent);
  if (!opts.worktree) throw new Error("attended_record: --worktree is required to write a record");
  if (opts.role && !Object.hasOwn(ROLE_PERMISSION_PROFILE, opts.role)) {
    throw new Error(`attended_record: unknown framework role '${opts.role}'`);
  }
  const profile = opts.profile ?? (opts.role ? ROLE_PERMISSION_PROFILE[opts.role] : "role");
  if (!(profile in PERMISSION_PROFILES)) {
    throw new Error(`attended_record: unknown permission profile '${profile}'`);
  }
  if (opts.role && ROLE_PERMISSION_PROFILE[opts.role] !== profile) {
    throw new Error(
      `attended_record: role '${opts.role}' requires permission profile '${ROLE_PERMISSION_PROFILE[opts.role]}' (got '${profile}')`,
    );
  }
  const executionRoute = opts.executionRoute ?? opts.laneKind;
  // W-139: a role-profile attended record is a legitimate PM-directed-route
  // exception, but it is easy to reach for by habit after a run of gate
  // (guardian/observer) attended_record calls, silently bypassing
  // dispatch_prepare.ts (dock) / workspace_isolate.ts (control repo, isolated
  // worktree) — the live incident this row fixes. Advisory only: it never
  // blocks the write (the PM-directed route IS a sanctioned use of this profile);
  // the W-139 detective (contract_check.ts --stall-scan BYPASS-SPAWN) is what
  // catches an actually-unsanctioned worktree after the fact. gate is silent —
  // it is the ordinary, expected attended_record use and needs no warning.
  // W-155/W-206: an explicit `--pm-direct` declaration IS the sanctioned PM-directed
  // path, so it suppresses the nudge — the advice ("use dispatch_prepare /
  // workspace_isolate instead") does not apply to this route, and nagging
  // the sanctioned path is the friction this row removes. Undeclared role
  // usage still gets the nudge.
  // W-240: workspace_isolate.ts's own isolate mode IS "use workspace_isolate
  // instead" — the nudge would be telling the caller to do the exact thing it
  // just did. It stamps `spawnedVia: "workspace_isolate"` (not `pm-direct`,
  // deliberately: this seat is NOT the DEC-093 PM-directed exception — it is a
  // Dock-untracked-but-worktree-sanctioned isolate role, and tagging it
  // pm-direct would (a) downgrade a LEAKED record's BYPASS-SPAWN finding to
  // advisory (W-139) and (b) demote its process_kill protection from deny to
  // ask, both real regressions caught in review — see workspace_isolate.ts),
  // so the nudge is suppressed on that provenance alone.
  if (profile === "role" && executionRoute !== "pm-direct" && opts.spawnedVia !== "workspace_isolate") {
    process.stderr.write(
      "attended_record: --profile role は dispatch_prepare (Dock orchestration) / workspace_isolate (control repo, isolated worktree) 経由が正規経路です。attended_record role は PM-directed lightweight route の例外用途に限ります (W-139) — worker/smith/librarian/artisan の通常タスクなら dispatch_prepare.ts か workspace_isolate.ts を使ってください。\n",
    );
  }
  const worktree = validateWorktree(opts.worktree);
  const validateRoot = (root: string): string => {
    // Each root is validated the same way: no drive roots / shallow / .git.
    const canon = canonicalPath(root);
    assertPathMutation(canon, "write", { cwd: canon, fenceRoots: [canon] });
    return canon;
  };
  const fenceRoots = (opts.fenceRoots?.length ? opts.fenceRoots : [worktree]).map(validateRoot);
  // W-183: cross-repo roots are validated by the SAME depth/.git floor as fence
  // roots, so a shallow or .git-touching additional root is rejected up front.
  const additionalRoots = (opts.additionalRoots ?? []).map(validateRoot);
  const approvedRemoteDestinations =
    normalizeApprovedRemoteDestinations(opts.approvedRemoteDestinations);
  if (profile !== "concierge" && approvedRemoteDestinations.length > 0) {
    throw new Error("attended_record: approved remote destinations require --profile concierge");
  }

  const garelierDir = resolveGarelierDir(opts.garelierRoot ?? worktree, opts.garelierRoot);
  const pmId = resolvePmId(garelierDir, worktree, opts.pmId);
  const path = recordPathFor(garelierDir, pmId, agent);
  const record = buildRecord({
    agent,
    worktree,
    profile,
    role: opts.role,
    fenceRoots,
    executionRoute,
    spawnedVia: opts.spawnedVia,
    qualityGateCommands: opts.qualityGateCommands,
    additionalRoots,
    approvedRemoteDestinations,
  });

  assertPathMutation(path, "write", { cwd, fenceRoots: [garelierDir] });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return { path, record };
}

export interface RemoveResult { path: string; removed: boolean; }

export function removeAttendedRecord(opts: AttendedRecordOptions, cwd = process.cwd()): RemoveResult {
  const agent = sanitizeAgent(opts.agent);
  const anchor = opts.garelierRoot ?? opts.worktree ?? cwd;
  const garelierDir = resolveGarelierDir(anchor, opts.garelierRoot);
  const pmId = resolvePmId(garelierDir, opts.worktree, opts.pmId);
  const path = recordPathFor(garelierDir, pmId, agent);
  if (!existsSync(path)) return { path, removed: false };
  assertPathMutation(path, "delete", { cwd, fenceRoots: [garelierDir] });
  rmSync(path);
  return { path, removed: true };
}

// --- CLI -------------------------------------------------------------------

interface ParsedArgs {
  agent?: string;
  worktree?: string;
  profile?: string;
  role?: string;
  fenceRoots: string[];
  garelierRoot?: string;
  pmId?: string;
  remove?: string;
  pmDirect?: boolean;
  qualityGateCommands: string[];
  additionalRoots: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { fenceRoots: [], qualityGateCommands: [], additionalRoots: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`attended_record: ${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--agent": out.agent = next(); break;
      case "--worktree": out.worktree = next(); break;
      case "--profile": out.profile = next(); break;
      case "--role": out.role = next(); break;
      case "--fence-root": out.fenceRoots.push(next()); break;
      case "--garelier-root": out.garelierRoot = next(); break;
      case "--pm-id": out.pmId = next(); break;
      case "--pm-direct": out.pmDirect = true; break; // W-206: declare a PM-directed execution route
      case "--quality-gate": out.qualityGateCommands.push(next()); break; // W-159: repeatable verbatim verify command
      case "--additional-root": out.additionalRoots.push(next()); break; // W-183: repeatable cross-repo authorized root
      case "--remove": out.remove = next(); break;
      default: throw new Error(`attended_record: unknown argument '${arg}'`);
    }
  }
  return out;
}

export function runCli(argv: string[], cwd = process.cwd()): { code: number; message: string } {
  let parsed: ParsedArgs;
  try { parsed = parseArgs(argv); } catch (err) { return { code: 2, message: String(err) }; }

  try {
    if (parsed.remove !== undefined) {
      const { path, removed } = removeAttendedRecord(
        { agent: parsed.remove, worktree: parsed.worktree, garelierRoot: parsed.garelierRoot, pmId: parsed.pmId },
        cwd,
      );
      return { code: 0, message: removed ? `attended_record: removed ${path}` : `attended_record: no record at ${path}` };
    }
    if (!parsed.agent) return { code: 2, message: "attended_record: --agent is required" };
    if (!parsed.worktree) return { code: 2, message: "attended_record: --worktree is required" };
    const { path } = writeAttendedRecord(
      {
        agent: parsed.agent,
        worktree: parsed.worktree,
        profile: parsed.profile as AttendedProfile | undefined,
        role: parsed.role as FrameworkRoleKind | undefined,
        fenceRoots: parsed.fenceRoots,
        garelierRoot: parsed.garelierRoot,
        pmId: parsed.pmId,
        executionRoute: parsed.pmDirect ? "pm-direct" : undefined,
        qualityGateCommands: parsed.qualityGateCommands,
        additionalRoots: parsed.additionalRoots,
      },
      cwd,
    );
    return { code: 0, message: `attended_record: wrote ${path}` };
  } catch (err) {
    return { code: 1, message: String(err) };
  }
}

if (import.meta.main) {
  const { code, message } = runCli(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(message + "\n");
  process.exit(code);
}
