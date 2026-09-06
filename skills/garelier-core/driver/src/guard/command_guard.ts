// command_guard.ts — the enforcement point for the safety policy (W-050).
//
// Runs as a Claude Code PreToolUse hook for the Bash / PowerShell tools: it is
// handed the command string BEFORE execution and returns a JSON decision
// (allow / ask / deny + reason). It mechanically enforces what the prose
// references only describe:
//   - references/deletion_and_forcewrite_safety.md  (deletion + forced-write)
//   - references/injection_and_egress.md            (egress = Concierge only)
//   - references/package_policy.md                  (W-049 supply-chain)
//
// Design: table-driven regex classification. This is NOT a full shell parser —
// it deliberately targets a small set of high-risk command classes and errs
// toward deny/ask on them. The evaluate() core is pure and unit-tested; the CLI
// wrapper at the bottom does stdin/stdout + policy loading. On any internal
// error the wrapper falls back to "ask" (fail-safe, never fail-open).

import { parse } from "smol-toml";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync, lstatSync, realpathSync, mkdirSync, appendFileSync } from "node:fs";
import { basename, resolve, sep, dirname, isAbsolute, join, relative } from "node:path";
import { pidAlive, requireRuntimeExecutable } from "../scripts/_lib.ts";
import { assertPathMutation, mainWorktreeRootFromGitDir, normalizePathFlavor } from "./path_guard.ts";
import { dispatchContainer } from "../workspace.ts";
import { resolvePlant } from "../plant.ts";
import {
  QUALITY_GATE_PRESETS,
  READ_ONLY_INSPECTION_PRESETS,
} from "./quality_gate_presets.ts";
import {
  PERMISSION_PROFILES,
  profileForRole,
  type PermissionProfileName,
} from "./permission_profiles.ts";
import {
  approvedUrlsFor,
  normalizeApprovedRemoteDestinations,
  type ApprovedRemoteDestination,
} from "./approved_remotes.ts";
// W-150: the record READER and WRITER (attended_record.ts) share one control-root
// resolver, so a written record is always found where the reader scans.
import { ancestorGareilerRoots, resolveControlRoot } from "./record_paths.ts";
import { appendIncident, incidentRepeatKey } from "./incident_log.ts";
import {
  DISPATCH_CONTAINER_LIFECYCLE,
  type DispatchContainerLifecycle,
} from "../dispatch/container_lifecycle.ts";

export type Action = "allow" | "ask" | "deny";

export interface Decision {
  action: Action;
  /** stable rule id, e.g. "pipe_to_shell" */
  rule: string;
  reason: string;
  /** W-179 (d2): set when PM resolution mode converted an ASK into this fail-closed
   * DENY. The PM must adjudicate it (allow/deny the pattern for the profile); the
   * guard report marks it `pm_pending`. Absent for an ordinary deny/ask/allow. */
  pmConverted?: boolean;
}

export interface GuardInput {
  command: string;
  /** tool name from the hook (Bash / PowerShell / Shell). */
  tool?: string;
  /** GARELIER_ROLE, lowercased by the caller (e.g. "worker", "concierge"). */
  role?: string;
  /** GARELIER_CONTAINER — the role's own worktree root; recursive deletes are
   *  allowed only under here. A trusted env value, never the hook session cwd. */
  containerDir?: string;
  /** The dispatch record's own worktree (W-119). Preferred fence anchor over
   *  the hook's session cwd, which can leak in from a different dispatch. */
  worktree?: string;
  cwd?: string;
  policy?: GuardPolicy;
  /** Dispatch-bound profile. Omitted keeps the legacy policy-only evaluator. */
  profile?: PermissionProfileName;
  /** True only when the profile came from a resolved dispatch permission record.
   * This immutable seat identity is authoritative for role-only lifecycle
   * restrictions; ambient role/profile env and cwd are not. */
  dispatchRecordBacked?: boolean;
  fenceRoots?: string[];
  /** Target-project root from a trusted dispatch fact pack. */
  targetRoot?: string;
  /** Resolved project quality-gate commands from the dispatch fact pack. */
  qualityGateCommands?: string[];
  /** W-206: the declared execution route (`pm-direct` marks an attended
   * PM-directed lightweight seat).
   *  A PM-direct seat gets `ask` (attended judgment) where a role seat
   *  gets `deny` for an indiscriminate process kill. */
  executionRoute?: string;
  /** @deprecated Two-release source-compatibility alias. New callers set
   * `executionRoute`; conflicting values fail closed. */
  laneKind?: string;
  /** W-187: an agent name WAS present on the hook payload but NO dispatch record
   *  resolved from this cwd, so the seat fell to `baseline-destructive`. This is the
   *  fingerprint of the cwd-mismatch class (a commit-bearing PM-direct seat running
   *  git/test/build with its shell cwd in a DIFFERENT repo than the one its record
   *  lives under — the guard resolves the record against the cwd's control root, so a
   *  foreign cwd finds nothing). Set by main(); when a `profile_unknown` deny fires
   *  in this state the reason carries the diagnostic cwd-contract hint so the 45-min
   *  "why is every command denied" diagnosis becomes zero. */
  seatRecordUnresolved?: boolean;
  /** W-187: the resolved agent name (resolveAgentName), surfaced only so the
   *  cwd-mismatch hint can name the stranded seat. */
  agentName?: string;
  /** W-575/W-545: where `cwd` above CAME FROM. `dispatch_record` = the seat's own
   *  record named its worktree, so the verdict is identical from every shell tool;
   *  `session_cwd` = nothing but the ambient shell position was available. Purely
   *  diagnostic — it changes no decision, it only lets a fail-closed refusal say
   *  which of the two inputs produced the position it judged. */
  positionOrigin?: "dispatch_record" | "session_cwd";
  /** W-575: the record file the position came from, named in that diagnostic. */
  positionRecordPath?: string;
  /** W-267: git facts for the repo a `git commit` segment targets. Injected by
   *  main() so `evaluate` itself stays free of subprocess calls; absent leaves the
   *  control-misplace rule inert. */
  commitRepo?: CommitRepoProbe;
  /** W-305/F4: configured URLs for a named git remote. Injected by main() so a
   *  Concierge may use an already-known remote but cannot repoint one to an
   *  arbitrary destination. A probe miss fails closed. */
  remoteUrlProbe?: GitRemoteUrlProbe;
  /** W-318: canonical full ref for a merge source. Resolution precedes lane
   * classification so Git's shorthand search order cannot disguise a remote or
   * tag as an ordinary local branch. A probe miss fails closed. */
  canonicalRefProbe?: GitCanonicalRefProbe;
  /** W-318: real Git topology for a canonical local merge source: whether the
   * source is already in integration, plus every lane whose history contains
   * it. This distinguishes target tracking at a shared zero-change tip from an
   * unpublished historical lane commit hidden behind an alias. */
  mergeSourceTopologyProbe?: GitMergeSourceTopologyProbe;
  /** W-305 round 2: exact remote name/destination pairs approved by the PM in
   * the resolved Concierge dispatch record. */
  approvedRemoteDestinations?: ApprovedRemoteDestination[];
  /** Ambient environment selector names inherited by the hook process. Values
   * are intentionally omitted and must never reach diagnostics. */
  gitEnvironmentContext?: string[];
  /** Non-empty ambient gitleaks config selector names. Values are deliberately
   * omitted so config contents/paths never reach traces or diagnostics. */
  gitleaksConfigEnvironment?: string[];
  /** W-365: the record's W-183 `additional_roots` (attended_record
   * --additional-root), carried separately from `fenceRoots` so the scanner
   * cwd-binding checks (gitleaksSeatIsBound / declaredSeatCwdIsBound) can
   * treat an explicitly-declared cross-repo root as a second bindable seat
   * root, not just a write-fence extension. Undeclared = seat's own worktree
   * only, unchanged from pre-W-365 behavior. */
  additionalRoots?: string[];
  /** W-431 (identity approach, PM 2026-08-17): verify IDENTITY only -- never
   * read-and-interpret content -- for the Bash-script path carried by the
   * matched declaration entry under the command's runtime Git worktree. True
   * only when the declaration-derived path is git-tracked
   * AND its current on-disk bytes hash to the same blob HEAD has for that
   * path. The install guard calls this seam only when the complete command
   * exactly matches a declared gate command; false keeps the wrapper opaque
   * and fail-closed, exactly like an unresolvable wrapper always has. */
  shellScriptProbe?: ShellScriptProbe;
}

export interface DeclaredShellScriptIdentity {
  /** The authoritative qualityGateCommands entry, not the input command. */
  command: string;
  /** The repository path named directly by that declaration. */
  scriptPath: string;
}

type DeclaredCommandMatch = {
  command: string;
  /** Runtime cwd established by the one authorized cwd-safe spelling. */
  runtimeCwd: string | undefined;
  shellScript:
    | { kind: "none" }
    | { kind: "outside_identity" }
    | { kind: "identity"; value: DeclaredShellScriptIdentity };
};

export type ShellScriptProbe = (
  declaration: DeclaredShellScriptIdentity,
  runtimeCwd: string | undefined,
) => boolean;

/** W-267: what the control-misplace rule needs to know about a commit's repo. */
export interface CommitRepoFacts {
  /** `git rev-parse --show-toplevel` — a linked worktree's own top. */
  topLevel: string;
  /** Parent of `--git-common-dir` — the MAIN worktree root. */
  mainWorktreeRoot: string;
  /** `git symbolic-ref --short HEAD`; empty when detached. */
  headRef: string;
  /** `git diff --cached --name-only`, repo-relative. */
  stagedPaths: string[];
  /** The repository's integration-branch active.lock exists. */
  mergeGateActive?: boolean;
  /** Trusted Plant/control-root discovery failed, so active-gate absence is unproven. */
  mergeGateProbeError?: string;
}

export type CommitRepoProbe = (dir: string) => CommitRepoFacts | null;
export type GitRemoteUrlProbe = (dir: string, remote: string) => string[] | null;
export type GitCanonicalRefProbe = (dir: string, ref: string) => string | null;
export interface GitMergeSourceTopology {
  sourceTip: string;
  integrationTip: string;
  sourceInIntegration: boolean;
  containingLaneRefs: string[];
}
export type GitMergeSourceTopologyProbe = (dir: string, ref: string, integrationRef: string) => GitMergeSourceTopology | null;

export interface DispatchPermissionRecord {
  permission_profile: PermissionProfileName;
  /** Effective fence — the declared fence_roots PLUS any W-183 additional_roots
   *  (both carry the same record-level trust), so every downstream fence check
   *  honors a declared cross-repo binding with no further threading. */
  fence_roots: string[];
  /** W-183: the supplementary cross-repo roots that were merged into fence_roots,
   *  retained separately for reporting/clarity. Empty when none declared. */
  additional_roots?: string[];
  approved_remote_destinations?: ApprovedRemoteDestination[];
  role?: string;
  agent_name?: string;
  worktree?: string;
  /** Resolved project commands from context.json; they override presets. */
  quality_gate_commands: string[];
  project_root?: string;
  /** W-206: resolved top-level `execution_route` marker. Current field wins,
   *  legacy `lane_kind` is the fallback, and a mismatch fails closed. */
  execution_route?: string;
  /** Legacy marker retained in the reader shape for the two-release
   * compatibility window. Safety decisions use `execution_route`. */
  lane_kind?: string;
  source: string;
}

/** W-179 (d3): the PM-grown per-profile pattern lists. Three regex lists per
 * profile. `deny` adds a hard block; `ask` adds an attended pause (in pm mode it
 * becomes a deny like every other ask); `allow` is the learning-loop escape — it
 * relaxes the fail-closed unknown band and any ask for a matching command, but NEVER
 * a family/profile deny (strictest-wins keeps deny 先勝ち). */
export interface ProjectProfileRuleSet {
  allow: string[];
  ask: string[];
  deny: string[];
}
export type ProjectProfileRules = Partial<Record<PermissionProfileName, ProjectProfileRuleSet>>;

/** Per-class action override + the network allow-list. */
export interface GuardPolicy {
  enabled: boolean;
  /** W-179 (d1): behavior when the guard would ASK. "ask" (framework default)
   * surfaces an attended ask to the user. "pm" emits NO user-facing ask — every ask
   * (resolution-miss fail-closed AND a profile-internal family ask such as
   * force_write) becomes a fail-closed deny + a PM-readable pending report + an
   * escalate-to-PM instruction. It never synthesizes a new allow (deny+report only). */
  resolution_mode: "ask" | "pm";
  /** W-179 (d3): PM-grown per-profile deny/ask/allow pattern lists (the learning
   * loop). Consulted inside the profile judgment across the profile chain. Empty by
   * default = no effect. Generic framework feature (a garelier-publish user grows
   * their own project's lists the same way). */
  profile_rules: ProjectProfileRules;
  /** Optional all-seat install/update/download deny floor. Default false. */
  install_guard_enabled: boolean;
  /** Optional remote-package immediate-execution deny (bunx / uvx / npx <pkg> /
   *  pipx run / pnpm dlx / uv run --with / deno run <remote>). Per-family opt-in
   *  flag, default false — same config path as install_guard_enabled. Framework
   *  default off (passthrough); a project turns it on (W-163; unified with the
   *  other family flags by W-164). */
  remote_exec_guard_enabled: boolean;
  // W-164: per-family enable flags for the remaining guard families. Same
  // opt-in / default-false / config-path shape as install_guard_enabled (W-160)
  // and remote_exec_guard_enabled (W-163). Framework ships every flag OFF
  // (a family with its flag off contributes NO decision = passthrough); a
  // consuming project (the target project / garelier) turns them on in its policy TOML. Each
  // flag gates exactly one legacy rule family (grouped where the family spans two
  // rule ids: network egress covers network_egress + network_offlist). The two
  // existing flags above are NOT renamed (compat). `enabled: false` still short-
  // circuits everything to allow; these flags only decide which families are live
  // when the guard itself is enabled.
  /** pipe-to-shell (`curl … | sh`). Default false. */
  pipe_to_shell_guard_enabled: boolean;
  /** network egress + off-list GET (`network_egress` / `network_offlist`). Default false. */
  network_egress_guard_enabled: boolean;
  /** git egress (`git push` / `fetch` / `pull` / `remote add|set-url`). Default false. */
  git_egress_guard_enabled: boolean;
  /** raw `codex exec` outside dispatch_provider.ts (`codex_raw_exec`). Default false. */
  codex_raw_exec_guard_enabled: boolean;
  /** recursive delete outside the own worktree (`recursive_delete`). Default false. */
  recursive_delete_guard_enabled: boolean;
  /** indirect delete/reset/clean via shell indirection (`indirect_delete`). Default false. */
  indirect_delete_guard_enabled: boolean;
  /** delete/overwrite of a DB / secret file (`secret_file`). Default false. */
  secret_file_guard_enabled: boolean;
  /** forced git history/tree rewrite (`force_write`). Default false. */
  force_write_guard_enabled: boolean;
  /** dispatch-profile per-segment path fence (`profile_path_fence`). Default false. */
  path_fence_guard_enabled: boolean;
  /** indiscriminate process kill by name/image (`process_kill`, W-170). Default false. */
  process_kill_guard_enabled: boolean;
  /** attended-seat control commit on a lane branch (`control_misplace`, W-267). Default false. */
  control_misplace_guard_enabled: boolean;
  /** hand-merging a lane branch into the integration branch (`merge_gate_bypass`, W-318). Default false. */
  merge_gate_bypass_guard_enabled: boolean;
  /** Hosts a non-Concierge role may GET from. Default empty = deny all off-list. */
  network_allow_domains: string[];
  /** Override the action for any class; omit to keep the built-in default. */
  actions: Partial<Record<RuleId, Action>>;
}

export type RuleId =
  | "pipe_to_shell"
  | "network_egress"
  | "network_offlist"
  | "git_egress"
  | "install_run"
  | "remote_package_exec"
  | "tool_install_update"
  | "codex_raw_exec"
  | "recursive_delete"
  | "indirect_delete"
  | "force_write"
  | "secret_file"
  | "process_kill"
  | "control_misplace"
  | "merge_gate_bypass"
  | "merge_gate_index_mutation";

export const DEFAULT_POLICY: GuardPolicy = {
  enabled: true,
  install_guard_enabled: false,
  remote_exec_guard_enabled: false,
  // W-164: every family flag ships OFF (framework default). Consuming projects
  // turn them on. Keep this list in sync with the GuardPolicy fields above and
  // the policyFromToml parse below.
  pipe_to_shell_guard_enabled: false,
  network_egress_guard_enabled: false,
  git_egress_guard_enabled: false,
  codex_raw_exec_guard_enabled: false,
  recursive_delete_guard_enabled: false,
  indirect_delete_guard_enabled: false,
  secret_file_guard_enabled: false,
  force_write_guard_enabled: false,
  path_fence_guard_enabled: false,
  process_kill_guard_enabled: false,
  control_misplace_guard_enabled: false,
  merge_gate_bypass_guard_enabled: false,
  network_allow_domains: [],
  actions: {},
  // W-179 (d1, user 裁定第 6 報 2026-07-20): when the guard is active, the DEFAULT
  // resolution mode is "pm" (guard-emitted asks become fail-closed deny + PM report,
  // never a user prompt). "ask" is the explicit opt-out. This is orthogonal to
  // `enabled`: a disabled guard (or a family whose flag is off) still does nothing —
  // the enable/family gate runs first, and pm mode only decides what an ACTUAL ask
  // becomes. Project lists start empty; a project grows profile_rules.
  resolution_mode: "pm",
  profile_rules: {},
};

const ESCALATE = "If this is genuinely required, do not work around it — escalate to the PM.";
// W-179 (d2): the deny reason appended when PM resolution mode converts an ask. The
// agent must NOT work around it — it SendMessages the PM, who adjudicates by growing
// the profile's allow/deny list.
const PM_MODE_ESCALATE =
  "PM 解決モード: guard は user に ask を出さず fail-closed deny とした。回避せず PM へ SendMessage で escalate せよ。PM が profile の allow/deny list で裁定する (pending report は incidents.jsonl / dock_status pmAction)。";
const ESCALATE_EGRESS =
  "External sends go through the Concierge only (DEC-025); escalate to the PM instead of sending directly.";

/** W-187: the diagnostic appended to a `profile_unknown` deny when a named seat
 * resolved NO record from this cwd (→ baseline-destructive). The guard resolves a
 * seat's dispatch record against the CONTROL ROOT of the command's cwd (the nearest
 * `__garelier` ancestor / shared gitdir, record_paths.resolveControlRoot), so a
 * commit-bearing PM-direct seat that runs git/test/build with its shell cwd in a
 * DIFFERENT repo than the one holding its record finds nothing and is stranded at
 * the strictest baseline seat — every commit/test/build denied. Naming the cwd and
 * the fix turns the (실측 45-minute) diagnosis into a one-line read of the deny. */
/** W-575/W-545 (GF-12): name the ORIGIN of the position the guard judged.
 *
 * The profile, the fence roots and every git probe base all descend from one
 * position input. When that input is the seat's dispatch record the verdict is
 * the same from the Bash tool and the PowerShell tool; when it is the ambient
 * session cwd the verdict follows whatever directory the shell happened to be
 * left in. A refusal that shows neither reads the same in both cases, which is
 * what made the PowerShell false-deny a multi-hour diagnosis. Diagnostic only. */
function positionOriginHint(input: GuardInput): string {
  if (input.positionOrigin === "dispatch_record") {
    return ` 位置の由来: dispatch record (${input.positionRecordPath ?? "record"}) の worktree`
      + ` = ${input.cwd ?? "?"} — shell tool (Bash / PowerShell) に依らず同一。`;
  }
  if (input.positionOrigin === "session_cwd") {
    return ` 位置の由来: session cwd (${input.cwd ?? "?"}) — 席の dispatch record が解決できず、`
      + `shell の現在地だけが位置入力になっている。席の record を解決させる `
      + `(GARELIER_DISPATCH_RECORD を export する / 席自身の worktree を cwd にする) と判定が変わりうる。`;
  }
  return "";
}

function cwdRecordHint(agentName: string, cwd: string): string {
  const who = agentName ? `席 '${agentName}'` : "この席";
  return (
    ` 診断 (W-187): ${who} の dispatch record が現在の cwd (${cwd || "?"}) から解決できず ` +
    `baseline-destructive に落ちています。command_guard は record を cwd の control root ` +
    `(最寄り __garelier 祖先 / 共有 gitdir) 基準で探すため、席の record が別 repo の ` +
    `__garelier 配下にある場合 (例: PM 直 spawn の worker 席で別 project を cwd にして ` +
    `git/test/build を実行) この deny になります。是正: 席自身の worktree を cwd にして ` +
    `実行する (command 先頭で cd <worktree>)、絶対 cd/git -C <own-repo> を使う、または ` +
    `launcher が attended_record --additional-root <own-repo> で cross-repo を宣言する。`
  );
}

const SEVERITY: Record<Action, number> = { allow: 1, ask: 2, deny: 3 };

// --- helpers ---------------------------------------------------------------

/** Remove heredoc document bodies before safety classification. The opener is
 * retained, while body text is data rather than shell syntax. */
function withoutHeredocBodies(command: string): string {
  const out: string[] = [];
  let marker: { value: string; tabs: boolean } | null = null;
  for (const line of command.split(/\r?\n/)) {
    if (marker) {
      const candidate = marker.tabs ? line.replace(/^\t+/, "") : line;
      if (candidate.trimEnd() === marker.value) marker = null;
      continue;
    }
    out.push(line);
    const found = /<<(-?)(?:\s*)(["']?)([A-Za-z_][A-Za-z0-9_]*)(?:\2)/.exec(line);
    if (found) marker = { value: found[3], tabs: found[1] === "-" };
  }
  return out.join("\n");
}

// Filesystem-mutation command verbs (delete / move / copy / create / write). The
// single source of truth for "what is a mutation command", shared by the three
// places that must never disagree: MUTATION_HINT (does this segment mutate?),
// mutationTargets (which paths does it touch?), and stripQuotedProse (whose quoted
// args must survive prose-stripping?). A verb present in one list but missing from
// another is exactly the drift that let `mkdir -p "<path>"` lose its quoted path
// to prose and surface an empty mutation target → false deny (W-128).
const MUTATION_VERBS =
  "rm|del|rd|rmdir|Remove-Item|mv|move|Move-Item|cp|copy|Copy-Item|mkdir|touch|Set-Content|Out-File|New-Item|tee";

// W-164: the remote-package runner heads. Their quoted args are load-bearing
// (`bunx "cowsay"` — the package name), exactly like a git / curl / rm quoted
// arg, so stripQuotedProse must NOT blank them; without this a quoted package
// name was replaced with `""` before the remote_package_exec regex could see it.
const REMOTE_EXEC_HEADS = "bunx|npx|uvx|pipx|pnpm|npm|bun|deno|uv";

// W-170: process-kill command heads. Their quoted args are load-bearing — the
// fence filter that scopes a kill to the own worktree (`Where-Object { $_.CommandLine
// -like '*dispatch371*' }`, `pkill -f '<fence path>'`) lives in a quoted argument,
// so stripQuotedProse must NOT blank it or the guard cannot tell a fence-scoped
// kill from an indiscriminate one. `Where-Object` is a pipeline stage that carries
// the filter; the kill verbs proper are `Stop-Process` / `taskkill` / `pkill` /
// `killall` / `Get-Process` (the name selector piped into Stop-Process).
// W-173: include the PowerShell aliases (spps=Stop-Process, gps=Get-Process,
// kill=Stop-Process) so an alias-headed scoped kill's quoted fence filter also
// survives classification (else it would be over-denied). `killall` precedes
// `kill` so the longer alias wins the alternation.
const PROCESS_KILL_HEADS = "Stop-Process|Get-Process|Where-Object|taskkill|pkill|killall|spps|gps|kill";

/** Quoted prose after a non-command head is data, not an invocation. Preserve
 * quoted arguments to a real command (notably `rm -rf ".git"`) so protection
 * for destructive paths never weakens; preserve substitutions because they run.
 * The head set is the mutation verbs (W-128 aligns it with MUTATION_VERBS so a
 * `mkdir`/`mv`/`cp`/`touch`/`tee` quoted path is not blanked) plus the network /
 * git / cd commands whose quoted args are equally load-bearing, and the
 * remote-package runners (W-164, so a quoted package name survives). */
function stripQuotedProse(segment: string): string {
  const gitContext = gitInvocationContext(segment);
  // W-172: a git READ-ONLY search subcommand (grep / log / shortlog) carries a
  // quoted PATTERN that is search DATA, not a URL/path/ref — so unlike other git
  // commands it is NOT load-bearing, and its quoted metachars must be blanked so a
  // literal `git grep '>>'` / `git grep '<('` is not mistaken for a real redirect
  // or process substitution (and denied by segmentEscapesReadOnly).
  const isGitSearch = gitContext.isGit && /^\s*git\s+(?:grep|log|shortlog)\b/i.test(gitContext.normalized);
  // retag-site:w431-deferred-exec chain:W-431>W-521 -- `trap`/`alias` are not
  // in this load-bearing head list, so `trap 'curl ... | sh' EXIT` /
  // `alias g='curl ... | sh'` fall through to the blanket single-quote blank
  // below: their deferred-code payload becomes `""` before classificationCommand
  // ever sees it, and the whole command reaches the unknown-band allow for a
  // fenced role/profile. Measured live at this tip (PM 2026-08-17,
  // role profile): both return allow/profile_unknown. This is a
  // non-declared-command site (identity verification for declared scripts,
  // added by this same row, never touches it) -- W-521 owns closing deferred
  // static execution generally; this predicate's job is prose-vs-invocation
  // classification, not resolving what a deferred payload will later run.
  const commandHead = new RegExp(
    `^\\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s]+)\\s+)*(?:(?:sudo|command|env)\\s+)*(?:${MUTATION_VERBS}|${REMOTE_EXEC_HEADS}|${PROCESS_KILL_HEADS}|git|curl|wget|iwr|invoke-webrequest|invoke-restmethod|cd)\\b`,
    "i",
  );
  if (!isGitSearch && (gitContext.isGit || commandHead.test(segment))) return segment;
  // Quoted content is data. W-172: single-quoted content is ALWAYS literal (the
  // shell runs no substitution inside '…'), so blank it even when it holds
  // `$(`/backtick — a literal `grep '$('` is a search pattern, not a live
  // substitution. Double-quoted content DOES expand `$(…)`/backtick, so preserve
  // those (segmentEscapesReadOnly and the egress rules must still see a real
  // substitution); benign double quotes are still blanked.
  return segment.replace(/(['"])(?:\\.|(?!\1)[\s\S])*\1/g, (quoted) =>
    quoted[0] === '"' && /\$\(|`/.test(quoted) ? quoted : '""',
  );
}

/** W-217 (G1): a quoted EMPTY string (`''` / `""`) contributes ZERO characters
 * once the shell resolves the token — so `--ou''t` and `--out` are the SAME
 * command to the real interpreter, and a regex classifier that does not
 * collapse these first can be evaded by splitting a sensitive keyword
 * mid-token with an empty quote pair (실측: guardian_scan review found this
 * defeats a naive `--out` exclusion). Collapsing every `''`/`""` occurrence is
 * always safe — it only ever makes an obscured mutation MORE visible to the
 * classifier (fail-closed direction), never less, and it mirrors real shell
 * word-concatenation exactly (a genuinely non-empty quoted argument, e.g.
 * `'--out'`, is untouched — only the EMPTY-content form disappears). Looped so
 * a multi-split token (`--o''u''t`) fully collapses. Applied to EVERY segment
 * in `classificationCommand`/`classificationForDeny` (after `stripQuotedProse`,
 * which is what decides whether quotes even survive to this point), so every
 * downstream consumer — presets, `hasWriteFormFlag`, `writeFormTargets`,
 * `MUTATION_HINT`, `mutationTargets` — sees ONE canonical form; a second
 * hand-kept collapse elsewhere would risk the exact two-copies drift this
 * codebase's write-form vocabulary comments (W-178) already warn about. */
function collapseEmptyQuotePairs(text: string): string {
  let s = text, prev: string;
  do { prev = s; s = s.replace(/''|""/g, ""); } while (s !== prev);
  return s;
}

interface ShellPart {
  segment: string;
  separator: string;
}

/** Split shell separators outside ordinary quotes.  Separators are retained by
 * the internal form because pipe-to-shell classification needs to distinguish
 * `|` from a mere command sequence. */
function splitShellParts(text: string): ShellPart[] {
  const parts: ShellPart[] = [];
  let current = "";
  let quote = "";
  const push = (separator = "") => {
    const value = current.trim();
    if (value) parts.push({ segment: value, separator });
    current = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      current += c;
      if (c === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') { quote = c; current += c; continue; }
    if (c === ";" || c === "\n" || c === "|") {
      const separator = c === "|" && text[i + 1] === "|" ? "||" : c;
      if (separator === "||") i++;
      push(separator);
      continue;
    }
    if (c === "&") {
      if (text[i + 1] === "&") { i++; push("&&"); continue; }
      // O-2: a lone `&` backgrounds the preceding command — it IS a command
      // boundary, so `<read-only-head> & <egress>` must split (curl after the `&`
      // then gets its own egress check). Exclude the redirect forms that also use
      // `&`: `&>`/`&>>` (next is `>`) and `>&`/`<&`/`2>&1` (prev is `>` or `<`).
      const prev = text[i - 1], next = text[i + 1];
      if (next !== ">" && prev !== ">" && prev !== "<") { push("&"); continue; }
    }
    current += c;
  }
  push();
  return parts;
}

/** Split a classification command on shell separators outside ordinary quotes
 * so a rule matching one real segment is not hidden by the rest. */
function splitShellSegments(text: string): string[] {
  return splitShellParts(text).map(({ segment }) => segment);
}

/** True when `child` is at or under `parent`. Flavor-agnostic string compare
 * (normalize `\`→`/`, lowercase, trim trailing slash) so it decides the same way
 * on POSIX and Windows hosts (W-036 posture), like isFenceScopedKill. Both must be
 * absolute. W-174: used to reject a dispatch record whose file was planted inside
 * the checkout it grants. */
function pathIsInside(child: string, parent: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const c = norm(child), p = norm(parent);
  return p.length > 0 && (c === p || c.startsWith(p + "/"));
}

function classificationCommand(command: string): string {
  // Decide whether quotes are prose *after* structural segmentation.  Doing it
  // on a whole `echo ... && rm -rf ".git"` line would treat the actual rm
  // argument as echo prose and weaken the destructive-path checks.
  // W-217 (G1): collapseEmptyQuotePairs runs FIRST, on the RAW segment, before
  // stripQuotedProse decides what is prose — so a token-split evasion
  // (`--ou''t`) collapses to its real form (`--out`) before any other rule
  // sees it, and stripQuotedProse's OWN synthetic `""` redaction placeholder
  // (inserted for a non-load-bearing head like `echo`) is produced afterward
  // and is never itself re-collapsed.
  return splitShellParts(withoutHeredocBodies(command))
    .map(({ segment, separator }) => `${stripQuotedProse(collapseEmptyQuotePairs(segment))}${separator}`)
    .join("");
}

/** classificationCommand with each segment's leading git global options collapsed
 * (stripGitGlobalOpts), so a profile deny rule keyed on `git <subcommand>` also
 * matches `git -C <path> <subcommand>` (W-150). Deliberately separate from
 * classificationCommand, whose raw form the `-C` record-target extraction still
 * reads for cross-repo record lookup. */
function classificationForDeny(command: string): string {
  return splitShellParts(withoutHeredocBodies(command))
    .map(({ segment, separator }) => `${stripGitGlobalOpts(stripQuotedProse(collapseEmptyQuotePairs(segment)))}${separator}`)
    .join("");
}

export function splitSegments(command: string): string[] {
  return splitShellSegments(classificationCommand(command));
}

function cleanHost(raw: string): string {
  let h = raw.trim();
  const at = h.lastIndexOf("@");
  if (at >= 0) h = h.slice(at + 1); // strip user:pass@
  h = h.replace(/:\d+$/, ""); // strip :port
  h = h.replace(/[\/.,'"()]+$/, "");
  return h.toLowerCase();
}

export function extractHosts(command: string): string[] {
  const hosts: string[] = [];
  const push = (h: string) => {
    const c = cleanHost(h);
    if (c && !hosts.includes(c)) hosts.push(c);
  };
  let m: RegExpExecArray | null;
  const urlRe = /\bhttps?:\/\/([^\/\s'"\\]+)/gi;
  while ((m = urlRe.exec(command))) push(m[1]);
  // bare domain args, e.g. `curl example.com/x` (no scheme)
  const bareRe = /(?:^|\s)((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?=[\/\s:'"]|$)/gi;
  while ((m = bareRe.exec(command))) push(m[1]);
  return hosts;
}

function hostAllowed(host: string, allow: string[]): boolean {
  return allow.some((a) => {
    const d = a.trim().toLowerCase().replace(/^\*?\.?/, "");
    return d.length > 0 && (host === d || host.endsWith("." + d));
  });
}

/** Non-flag tokens that look like filesystem targets in a segment. */
function pathTokens(segment: string): string[] {
  const toks = segment.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) ?? [];
  return toks
    .map((t) => t.replace(/^['"]|['"]$/g, ""))
    .filter((t, i) => i > 0 && !t.startsWith("-") && t.length > 0);
}

// Absolute-path detection must not depend on the host OS's `path` module: a
// Windows drive-letter path (`C:\...` / `C:/...`) or UNC path (`\\server\...`)
// is absolute regardless of whether the guard process itself runs on Windows
// or POSIX (W-036). The flavor-aware fence membership in path_guard's
// assertPathMutation gives the same allow/deny verdict on every host.
function isAbsolutePath(p: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
}

// A target whose eventual filesystem location cannot be proven statically:
// a home shortcut, a shell variable / substitution, a glob, or a parent
// escape. These fail closed rather than being resolved against any base.
function isUnverifiableTarget(p: string): boolean {
  return /^[.~]/.test(p) || /[$*?`]/.test(p) || p.includes("..");
}

/** Trusted own-worktree roots — a delete/overwrite is "inside" only within one
 * of these. Sourced from the dispatch record worktree, GARELIER_CONTAINER, and
 * any dispatch fence roots; NEVER the hook's session cwd, which in incident #348
 * leaked in from another dispatch and false-blocked an own-worktree delete
 * (W-119). Kept as raw strings so path_guard's flavor-aware canonicalization
 * decides POSIX vs Windows semantics (W-036) rather than this host's `resolve`. */
function ownWorktreeRoots(input: GuardInput): string[] {
  return [...new Set(
    [input.worktree, input.containerDir, ...(input.fenceRoots ?? [])]
      .filter((v): v is string => Boolean(v && v.trim())),
  )];
}

/** The absolute directory a single `cd` segment switches to, if it is a plain
 * absolute literal. A relative or shell-expanded `cd` would itself depend on the
 * ambient cwd we refuse to trust, so it yields nothing. */
function absoluteCdTarget(segment: string): string | undefined {
  const m = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i.exec(stripInertRedirects(segment).trim());
  if (!m) return undefined;
  const path = m[1] ?? m[2] ?? m[3] ?? "";
  if (!path || /[$*?~`]/.test(path) || !isAbsolutePath(path)) return undefined;
  return path;
}

/** Per-segment command-location base: the last absolute `cd` that ran BEFORE
 * that segment. Deliberately has no dispatch-root fallback — callers that judge
 * where the command itself runs must not substitute the seat's declared root. */
function segmentCdBases(segments: string[]): (string | undefined)[] {
  const bases: (string | undefined)[] = [];
  let activeCd: string | undefined;
  for (const seg of segments) {
    bases.push(activeCd);
    const cd = absoluteCdTarget(seg);
    if (cd) activeCd = cd;
  }
  return bases;
}

/** Per-segment resolution base for fenced path mutations: the command's last
 * absolute `cd`, else the first trusted root. A `cd` only affects the segments
 * after it, so `cd /foreign && rm -rf x && cd /own` resolves the delete against
 * /foreign and cannot be laundered "inside" by the trailing `cd` (W-119 R1).
 * Undefined when nothing trusted resolves, so relative targets fail closed. */
function segmentBases(segments: string[], roots: string[]): (string | undefined)[] {
  return segmentCdBases(segments).map((base) => base ?? roots[0]);
}

/** True when a command target is provably inside a trusted own-worktree root.
 * A relative target resolves against `base` (the segment's own preceding `cd` or
 * a trusted root), never the hook session cwd. An unverifiable target, or one
 * with no trusted root to check against, fails closed. Absolute targets are
 * judged directly against the fence by the flavor-aware path_guard check (W-036). */
function withinOwnWorktree(target: string, base: string | undefined, roots: string[]): boolean {
  if (roots.length === 0) return false;
  if (isUnverifiableTarget(target)) return false;
  if (!isAbsolutePath(target) && !base) return false;
  try {
    assertPathMutation(target, "delete", { cwd: base ?? roots[0], fenceRoots: roots });
    return true;
  } catch {
    return false;
  }
}

/** Drop redirects that carry no file write — the null device or an fd
 * duplication (`2>/dev/null`, `>/dev/null 2>&1`). They must not make an
 * otherwise read-only inspection segment look like a mutation (W-120). A
 * redirect to a real path is left intact and still fails the read-only class. */
function stripInertRedirects(segment: string): string {
  let s = segment;
  let prev: string;
  do {
    prev = s;
    s = s
      .replace(/\s*(?:&>|[0-9]*>>?)\s*(?:\/dev\/null|NUL)\s*$/i, "")
      .replace(/\s*[0-9]*>&[0-9]+\s*$/i, "");
  } while (s !== prev);
  return s.trim();
}

/** Collapse git's pre-subcommand GLOBAL options so a rule keyed on
 * `git <subcommand>` still fires on `git -C <path> <subcommand>` (W-150). The
 * argument-taking globals (`-C <dir>`, `-c <k=v>`, `--git-dir`, `--work-tree`,
 * `--namespace`, `--super-prefix`, `--exec-path`, in `<opt> <val>` or `<opt>=<val>`
 * form) sit BETWEEN `git` and the subcommand and otherwise let `git -C <repo> push`
 * (or `reset --hard`, etc.) slip past the egress / force deny floor — the exact
 * form the W-150 cross-repo record lookup now routes through the role
 * unknown-allow band. Only the LEADING run of globals is removed, so a subcommand's
 * own later `-C` (e.g. `git diff -C`) is untouched; a non-git segment is returned
 * unchanged. */
/** A quote-aware shell tokenizer that ALSO keeps each token's SOURCE span, so a
 * caller can strip a leading run of tokens yet reconstruct the tail from the raw
 * string with its original quoting intact. `text` is the unquoted token (for
 * comparing option names/values); `start`/`end` bound the token in the source. */
function shellTokensWithPos(s: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    let text = "";
    let quote = "";
    while (i < s.length && (quote || !/\s/.test(s[i]))) {
      const c = s[i];
      if (quote) { if (c === quote) quote = ""; else text += c; i++; }
      else if (c === '"' || c === "'") { quote = c; i++; }
      else { text += c; i++; }
    }
    out.push({ text, start, end: i });
  }
  return out;
}

function isGitExecutableToken(token: string): boolean {
  const basename = token.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^(?:git|git\.exe|git\.cmd)$/i.test(basename);
}

interface GitInvocationContext {
  isGit: boolean;
  /** The pattern-matching form with the leading global-option run removed. */
  normalized: string;
  /** Git's effective repository search directory after every `-C`, in order. */
  probeDir?: string;
  /** True when at least one `-C` supplied the effective directory. */
  explicitChdir: boolean;
  /** Fail-closed reason for a context the live probes cannot reproduce safely. */
  probeError?: string;
}

const GIT_FLAG_GLOBAL = /^(?:-p|-P|--paginate|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-lazy-fetch|--no-advice)$/;
const GIT_VALUE_GLOBAL = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env)$/;
const GIT_ATTACHED_LONG = /^--(git-dir|work-tree|namespace|super-prefix|exec-path|config-env)=/;
const PROBE_OUTPUT_ONLY_ENV = /^(?:LANG|LANGUAGE|LC_[A-Z0-9_]+|NO_COLOR|TERM|COLORTERM)$/i;
const AMBIENT_NON_PARITY_REPOSITORY_ENV = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)$/i;
const PROBE_OUTPUT_ONLY_GIT_CONFIG = /^core\.quotepath(?:=.*)?$/i;

function isProbeOutputOnlySelector(name: string): boolean {
  return PROBE_OUTPUT_ONLY_ENV.test(name);
}

function isAmbientNonParityRepositorySelector(name: string): boolean {
  return AMBIENT_NON_PARITY_REPOSITORY_ENV.test(name);
}

function gitSelectorMutations(segment: string): string[] {
  const names = new Set<string>();
  const note = (name: string | undefined): void => {
    if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !isProbeOutputOnlySelector(name)) {
      names.add(name.toUpperCase());
    }
  };
  const noteDynamic = (): void => { names.add("DYNAMIC_ENVIRONMENT_SELECTOR"); };
  const tokens = shellTokensWithPos(segment).map(({ text }) => text);
  const head = tokens[0]?.toLowerCase();
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/;

  const opaqueShellState = /^\s*(?:(?:(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)|function\s+[A-Za-z_][A-Za-z0-9_]*)\s*\{|[({]|(?:if|then|elif|else|for|while|until|case|select|do)\b)/i.test(segment)
    || /^(?:alias|unalias|trap|shopt|enable)$/i.test(head ?? "")
    || /^\s*(?:command|builtin)\s+(?:export|unset|readonly|declare|typeset|set|source|\.)\b/i.test(segment);
  if (opaqueShellState) noteDynamic();
  if (/^(?:source|\.|eval|iex|invoke-expression)$/.test(head ?? "")) noteDynamic();
  if (tokens.length > 0 && tokens.every((token) => assignment.test(token))) {
    for (const token of tokens) note(assignment.exec(token)?.[1]);
  }
  if (/^(?:export|readonly|declare|typeset|unset|unsetenv)$/.test(head ?? "")) {
    for (const token of tokens.slice(1).filter((token) => !/^-[A-Za-z-]+$/.test(token))) {
      const name = assignment.exec(token)?.[1] ?? (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token) ? token : undefined);
      if (name) note(name);
      else noteDynamic();
    }
  } else if (/^(?:setenv|set|setx)$/.test(head ?? "")) {
    const token = tokens.slice(1).find((candidate) => !/^-[A-Za-z-]+$/.test(candidate));
    if (token) {
      const name = assignment.exec(token)?.[1] ?? (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token) ? token : undefined);
      if (name) note(name);
      else noteDynamic();
    } else {
      noteDynamic();
    }
  }

  let staticPowerShellMutation = false;
  for (const match of segment.matchAll(/\$(?:\{env:([A-Za-z_][A-Za-z0-9_]*)\}|env:([A-Za-z_][A-Za-z0-9_]*))\s*(?:[+\-]?=|\+\+|--)/gi)) {
    staticPowerShellMutation = true;
    note(match[1] ?? match[2]);
  }
  if (/\$(?:\{env:[^}]+\}|env:[^\s=]+)\s*(?:[+\-]?=|\+\+|--)/i.test(segment) && !staticPowerShellMutation) {
    noteDynamic();
  }

  const envCmdlet = /\b(?:Set-Item|New-Item|Remove-Item|Clear-Item|Rename-Item|Move-Item|Copy-Item|Set-Content|Add-Content)\b/i.test(segment) && /\bEnv:/i.test(segment);
  let staticCmdletMutation = false;
  for (const match of segment.matchAll(/\b(?:Set-Item|New-Item|Remove-Item|Clear-Item|Rename-Item|Move-Item|Copy-Item|Set-Content|Add-Content)\s+(?:-Path\s+)?["']?Env:([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    staticCmdletMutation = true;
    note(match[1]);
  }
  if (envCmdlet && !staticCmdletMutation) noteDynamic();

  const processMutationCall = /\[(?:System\.)?Environment\]\s*::\s*SetEnvironmentVariable\s*\(/i.test(segment);
  const processMutation = /\[(?:System\.)?Environment\]\s*::\s*SetEnvironmentVariable\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\1/i.exec(segment);
  if (processMutation) {
    note(processMutation[2]);
  } else if (processMutationCall) {
    noteDynamic();
  }
  return [...names];
}

interface GitInvocationHead {
  gitAt: number;
  names: string[];
  wrapperError?: string;
  opaqueAddEquivalent?: boolean;
  splitString?: string;
}

function gitInvocationHead(
  tokens: ReturnType<typeof shellTokensWithPos>,
  segment: string,
): GitInvocationHead | null {
  const names = new Set<string>();
  let wrapperError: string | undefined;
  const noteSelector = (name: string): void => {
    if (!isProbeOutputOnlySelector(name)) names.add(name.toUpperCase());
  };
  const markOpaque = (wrapper: string): void => {
    wrapperError ??= `${wrapper} uses an unsupported or opaque wrapper option`;
  };
  const splitStringHead = (value: string, tail: string): GitInvocationHead | null => {
    if (!/[$`\\\r\n]/.test(value)) {
      return {
        gitAt: -1,
        names: [...names],
        wrapperError,
        splitString: value + tail,
      };
    }
    return {
      gitAt: -1,
      names: [...names],
      wrapperError: "env split-string uses dynamic or unsupported syntax",
      opaqueAddEquivalent: true,
    };
  };
  const opaqueWrapper = (wrapper: string, from: number): GitInvocationHead | null => {
    const gitAt = tokens.findIndex(({ text }, index) => index >= from && isGitExecutableToken(text));
    return gitAt < 0
      ? null
      : {
          gitAt,
          names: [...names],
          wrapperError: `${wrapper} uses an unsupported or opaque wrapper option`,
          opaqueAddEquivalent: tokens.some(({ text }, index) =>
            index > gitAt && /^(?:add|stage)$/i.test(text)),
        };
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!.text;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token);
    if (assignment) {
      noteSelector(assignment[1]);
      i++;
      continue;
    }
    if (isGitExecutableToken(token)) {
      return { gitAt: i, names: [...names], wrapperError };
    }

    const wrapper = token.toLowerCase();
    if (!/^(?:env|command|sudo)$/.test(wrapper)) return null;
    i++;

    if (wrapper === "env") {
      while (i < tokens.length) {
        const option = tokens[i]!.text;
        if (option === "--") {
          i++;
          break;
        }
        const envAssignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(option);
        if (envAssignment) {
          noteSelector(envAssignment[1]);
          i++;
          continue;
        }
        if (/^(?:-i|--ignore-environment)$/i.test(option)) {
          names.add("CLEARED_ENVIRONMENT");
          i++;
          continue;
        }
        if (/^(?:-u|--unset)$/i.test(option)) {
          const name = tokens[i + 1]?.text;
          if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            names.add("DYNAMIC_ENVIRONMENT_SELECTOR");
          } else {
            noteSelector(name);
          }
          i += name === undefined ? 1 : 2;
          continue;
        }
        const attachedUnset = /^--unset=([A-Za-z_][A-Za-z0-9_]*)$/i.exec(option);
        if (attachedUnset) {
          noteSelector(attachedUnset[1]);
          i++;
          continue;
        }
        if (/^(?:-S|--split-string)$/.test(option)) {
          const value = tokens[i + 1];
          if (!value) return null;
          return splitStringHead(value.text, segment.slice(value.end));
        }
        const attachedSplit = /^(?:-S(.+)|--split-string=(.+))$/.exec(option);
        if (attachedSplit) {
          return splitStringHead(
            attachedSplit[1] ?? attachedSplit[2],
            segment.slice(tokens[i]!.end),
          );
        }
        if (/^(?:-a|-C|--argv0|--chdir)$/i.test(option)) {
          markOpaque(wrapper);
          i += tokens[i + 1] === undefined ? 1 : 2;
          continue;
        }
        if (/^(?:-[aC].+|--(?:argv0|chdir)=.+)$/i.test(option)) {
          markOpaque(wrapper);
          i++;
          continue;
        }
        if (option.startsWith("-")) return opaqueWrapper(wrapper, i + 1);
        break;
      }
      continue;
    }

    while (i < tokens.length) {
      const option = tokens[i]!.text;
      if (option === "--") {
        i++;
        break;
      }
      const supported = wrapper === "command"
        ? option === "-p"
        : /^(?:-n|--non-interactive)$/.test(option);
      if (supported) {
        i++;
        continue;
      }
      if (wrapper === "sudo" && /^(?:-u|-g|--user|--group)$/i.test(option)) {
        markOpaque(wrapper);
        i += tokens[i + 1] === undefined ? 1 : 2;
        continue;
      }
      if (wrapper === "sudo" && /^(?:-[ug].+|--(?:user|group)=.+)$/i.test(option)) {
        markOpaque(wrapper);
        i++;
        continue;
      }
      if (option.startsWith("-")) return opaqueWrapper(wrapper, i + 1);
      break;
    }
  }
  return null;
}

/** W-312: parse Git's invocation head ONCE for both classification and live-probe
 * location. This replaces the old split implementation (`stripGitGlobalOpts`
 * plus an unrelated `-C` regex), which normalized `git -C … push` correctly but
 * still probed remotes/provenance at cwd.
 *
 * Supported location semantics:
 * - no `-C`: use the shell segment's actual base;
 * - one or more `-C`: apply them left-to-right, with a relative value resolved
 *   against the previous effective directory (Git's documented behavior).
 *
 * Command-introduced environment selectors default to unsupported: loader and
 * TLS variables can redirect behavior without a Git-specific name, and future
 * selectors must fail closed automatically. Only reviewed locale/color/terminal
 * mutations are output-only. Ambient process state is different: the probe and
 * later Git inherit it identically, so only repository-location selectors that
 * decouple the parsed `-C` fence from Git's actual repository are rejected.
 * Diagnostics contain selector names only, never values. */
function gitInvocationContext(
  segment: string,
  shellBase?: string,
  unsafeContext: string[] = [],
): GitInvocationContext {
  const tokens = shellTokensWithPos(segment);
  const head = gitInvocationHead(tokens, segment);
  if (!head) return { isGit: false, normalized: segment, explicitChdir: false };
  if (head.splitString !== undefined) {
    const splitContext = gitInvocationContext(
      `env ${head.splitString}`,
      shellBase,
      [...unsafeContext, ...head.names],
    );
    if (!splitContext.isGit) {
      return { isGit: false, normalized: segment, explicitChdir: false };
    }
    splitContext.probeError ??= head.wrapperError;
    return splitContext;
  }
  if (head.opaqueAddEquivalent) {
    return {
      isGit: true,
      normalized: "git add",
      probeDir: shellBase ? resolve(shellBase) : undefined,
      explicitChdir: false,
      probeError: head.wrapperError,
    };
  }
  const gitAt = head.gitAt;

  const aliasDefs = new Map<string, string>();
  const noteAlias = (kv: string | undefined): void => {
    if (!kv) return;
    const match = /^alias\.([^=\s]+)=([\s\S]+)$/i.exec(kv);
    if (match) aliasDefs.set(match[1].toLowerCase(), match[2]);
  };
  const contextNames = new Set<string>(unsafeContext.map((name) => name.toUpperCase()));
  for (const name of head.names) contextNames.add(name);

  let probeDir = shellBase ? resolve(shellBase) : undefined;
  let explicitChdir = false;
  let probeError = head.wrapperError
    ?? (contextNames.size > 0
      ? `Git-affecting selector context (${[...contextNames].sort().join(" + ")}) cannot be replayed safely for live probes`
      : undefined);
  const markUnsupported = (name: string): void => {
    probeError ??= `Git-affecting selector context (${name}) cannot be replayed safely for live probes`;
  };
  const applyChdir = (value: string | undefined): void => {
    explicitChdir = true;
    if (value === undefined) {
      probeError ??= "Git -C is missing its directory value";
      probeDir = undefined;
      return;
    }
    if (/[$*?~`]/.test(value)) {
      probeError ??= "Git -C uses a dynamic directory that cannot be resolved for live probes";
      probeDir = undefined;
      return;
    }
    if (value === "") return;
    if (isAbsolutePath(value)) {
      probeDir = resolve(value);
      return;
    }
    if (!probeDir) {
      probeError ??= "relative Git -C has no resolved shell base";
      return;
    }
    probeDir = resolve(probeDir, value);
  };

  let i = gitAt + 1;
  for (; i < tokens.length; i++) {
    const token = tokens[i].text;
    if (GIT_FLAG_GLOBAL.test(token)) {
      if (token === "--bare") markUnsupported("--bare");
      if (token === "--no-replace-objects") markUnsupported("--no-replace-objects");
      continue;
    }
    if (GIT_VALUE_GLOBAL.test(token)) {
      const value = tokens[i + 1]?.text;
      if (token === "-C") applyChdir(value);
      else if (token === "-c") {
        noteAlias(value);
        if (!value || !PROBE_OUTPUT_ONLY_GIT_CONFIG.test(value)) markUnsupported("-c");
      } else if (token === "--git-dir" || token === "--work-tree") {
        markUnsupported(token);
      } else if (token === "--config-env" || token === "--namespace"
        || token === "--exec-path" || token === "--super-prefix") {
        markUnsupported(token);
      }
      if (value === undefined) probeError ??= `Git global option ${token} is missing its value`;
      i++;
      continue;
    }
    if (token.startsWith("-C") && token.length > 2) {
      applyChdir(token.slice(2));
      continue;
    }
    if (token.startsWith("-c") && token.length > 2) {
      const value = token.slice(2);
      noteAlias(value);
      if (!PROBE_OUTPUT_ONLY_GIT_CONFIG.test(value)) markUnsupported("-c");
      continue;
    }
    const attachedLong = GIT_ATTACHED_LONG.exec(token);
    if (attachedLong) {
      const name = `--${attachedLong[1]}`;
      if (name === "--git-dir" || name === "--work-tree" || name === "--config-env"
        || name === "--namespace" || name === "--exec-path" || name === "--super-prefix") {
        markUnsupported(name);
      }
      continue;
    }
    break;
  }

  if (i >= tokens.length) {
    return { isGit: true, normalized: "git", probeDir, explicitChdir, probeError };
  }
  const sub = tokens[i];
  const aliasValue = aliasDefs.get(sub.text.toLowerCase());
  const tail = segment.slice(sub.end);
  return {
    isGit: true,
    normalized: `git ${aliasValue ?? sub.text}${tail}`,
    probeDir,
    explicitChdir,
    probeError,
  };
}

function gitInvocationContexts(
  command: string,
  segments: string[],
  shellBases: (string | undefined)[],
  ambientContext: string[] = [],
): GitInvocationContext[] {
  const rawSegments = splitShellSegments(withoutHeredocBodies(command));
  const inherited = new Set(
    ambientContext
      .filter(isAmbientNonParityRepositorySelector)
      .map((name) => name.toUpperCase()),
  );
  const aligned = rawSegments.length === segments.length;
  return segments.map((segment, i) => {
    const context = gitInvocationContext(
      segment,
      shellBases[i],
      aligned ? [...inherited] : [...inherited, "UNALIGNED_SHELL_CONTEXT"],
    );
    if (aligned) {
      for (const name of gitSelectorMutations(rawSegments[i]!)) inherited.add(name);
    }
    return context;
  });
}

function stripGitGlobalOpts(segment: string): string {
  return gitInvocationContext(segment).normalized;
}

function gitSubcommandArgs(segment: string, subcommand: string): string[] | null {
  const tokens = shellTokensWithPos(segment).map(({ text }) => text);
  const gitAt = tokens.findIndex(isGitExecutableToken);
  if (gitAt < 0 || tokens[gitAt + 1]?.toLowerCase() !== subcommand) return null;
  return tokens.slice(gitAt + 2);
}

/** W-523: an owner may discard tracked working-tree bytes inside its own
 * dispatch worktree. The delimiter is mandatory so branch switching can never
 * enter this narrow exception; index/history mutations and out-of-fence paths
 * continue through the ordinary force-write deny/ask floor. */
function ownedWorkingTreeDiscard(
  input: GuardInput,
  context: GitInvocationContext,
  segment: string,
  lifecycle: DispatchContainerLifecycle,
): boolean {
  if (!context.isGit || context.probeError || !context.probeDir) return false;
  const identityRoots = [input.worktree, input.containerDir]
    .filter((value): value is string => Boolean(value && value.trim()));
  if (identityRoots.length === 0) return false;
  const roots = [...new Set(identityRoots)];
  if (!withinOwnWorktree(context.probeDir, undefined, roots)) return false;

  const restoreArgs = gitSubcommandArgs(segment, "restore");
  const checkoutArgs = restoreArgs ? null : gitSubcommandArgs(segment, "checkout");
  const args = restoreArgs ?? checkoutArgs;
  if (!args) return false;
  const delimiter = args.indexOf("--");
  if (delimiter < 0 || delimiter === args.length - 1) return false;
  const prefix = args.slice(0, delimiter);
  if (restoreArgs) {
    if (!prefix.every((value) => value === "--worktree" || value === "-W" || value === "--source=HEAD")) return false;
  } else if (prefix.length !== 0) {
    return false;
  }
  const paths = args.slice(delimiter + 1);
  const pathsOwned = paths.length > 0
    && paths.every((path) => !path.startsWith("-") && withinOwnWorktree(path, context.probeDir, roots));
  return lifecycle.authorizeOwnedDiscard({
    repositoryOwned: true,
    pathsOwned,
    historyRewrite: false,
  });
}

interface GitProbeRepo {
  repo?: string;
  error?: string;
}

function gitProbeLocation(context: GitInvocationContext): string {
  return context.probeDir
    ? `resolved probe repository '${context.probeDir}'${context.explicitChdir ? " from Git -C" : " from the shell context"}`
    : "unresolved probe repository";
}

/** Resolve a live-probe repository from the SAME parsed invocation used for
 * pattern matching. Remote egress additionally requires the repository itself
 * to be inside the dispatch's trusted worktree fence: the pre-push backstop is
 * installed per worktree, so allowing a foreign `git -C` target would silently
 * drop that second layer (W-309). */
function gitProbeRepo(
  input: GuardInput,
  context: GitInvocationContext,
  requireTrustedWorktree: boolean,
): GitProbeRepo {
  const location = gitProbeLocation(context);
  if (!context.isGit) return { error: `${location}: command is not a canonical Git invocation` };
  if (context.probeError) return { error: `${location}: ${context.probeError}` };
  if (!context.probeDir) return { error: `${location}: no shell cwd or Git -C base was available` };
  if (requireTrustedWorktree) {
    // A dispatch may carry supplementary fence roots for approved data/output
    // paths. Those roots do NOT prove the per-worktree pre-push hook is installed.
    // Prefer the actual worktree/container identity; retain fenceRoots only as a
    // source-compatible fallback for direct evaluator callers with no record.
    const identityRoots = [input.worktree, input.containerDir]
      .filter((value): value is string => Boolean(value && value.trim()));
    const roots = identityRoots.length > 0 ? [...new Set(identityRoots)] : (input.fenceRoots ?? []);
    if (roots.length === 0) return { error: `${location}: no trusted worktree fence was available` };
    if (!withinOwnWorktree(context.probeDir, undefined, roots)) {
      return { error: `${location}: repository is outside the trusted worktree fence` };
    }
  }
  return { repo: context.probeDir };
}

interface NamedRemoteResult {
  urls: string[];
  error?: string;
}

function namedRemoteUrls(input: GuardInput, repo: string, remote: string): NamedRemoteResult {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) return { urls: [] };
  const approved = approvedUrlsFor(input.approvedRemoteDestinations, remote);
  let live: string[] = [];
  if (input.remoteUrlProbe) {
    try {
      live = input.remoteUrlProbe(repo, remote) ?? [];
    } catch {
      live = [];
    }
  }
  // The live probe remains the ordinary configured-remote authority. The only
  // way to authorize a not-yet-configured destination is the exact (name,url)
  // pair carried by the resolved PM-issued record.
  const urls = [...new Set([
    ...live,
    ...approved,
  ])];
  return {
    urls,
    error: urls.length === 0
      ? `resolved probe repository '${repo}': remote lookup failed or the named remote is not configured`
      : undefined,
  };
}

function explicitSafePush(input: GuardInput, segment: string, repo: string): string | null {
  const args = gitSubcommandArgs(segment, "push");
  if (!args) return "push arguments could not be parsed";
  const positional: string[] = [];
  let afterOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterOptions && arg === "--") { afterOptions = true; continue; }
    if (!afterOptions && /^(?:--all|--mirror)$/.test(arg)) return "implicit --all/--mirror push is forbidden";
    if (!afterOptions && /^(?:--force(?:-with-lease)?|-f)$/.test(arg)) return "force push is forbidden";
    if (!afterOptions && /^(?:-u|--set-upstream|--tags|--follow-tags|--atomic|--dry-run|--porcelain|-q|--quiet|-v|--verbose|--no-verify)$/.test(arg)) continue;
    // Promote needs none of these opaque channels. In particular, --exec /
    // --receive-pack may execute their value for a local approved remote, while
    // push-options are interpreted beyond this guard. Deny both split and `=`
    // forms instead of pretending their arbitrary values are safe refspec data.
    if (!afterOptions && (
      /^-o(?:.+)?$/.test(arg)
      || /^(?:--push-option|--receive-pack|--exec)(?:=|$)/.test(arg)
    )) return "opaque push execution/options are forbidden";
    if (!afterOptions && arg.startsWith("-")) return "unknown push option is forbidden";
    positional.push(arg);
  }
  // Require a named, already-configured remote plus at least one literal
  // refspec. `git push`, `git push origin`, `HEAD`, variables, --all, and
  // --mirror cannot prove which remote branch receives data and fail closed.
  if (positional.length < 2) return "named remote and explicit refspec are required";
  const remote = namedRemoteUrls(input, repo, positional[0]);
  if (remote.urls.length === 0) return remote.error ?? "named remote could not be verified";
  for (const raw of positional.slice(1)) {
    if (!raw || raw.startsWith("+") || /[$*?`~^]/.test(raw)) return "expanded or force refspec is forbidden";
    const colon = raw.indexOf(":");
    const source = colon >= 0 ? raw.slice(0, colon) : raw;
    const destination = colon >= 0 ? raw.slice(colon + 1) : raw;
    if (!source || !destination || /^HEAD$/i.test(destination) || source.includes("@{")) return "ambiguous refspec is forbidden";
    let resolvedSource = source;
    if (/^(?:HEAD|@)$/i.test(source)) {
      resolvedSource = (repo && input.commitRepo?.(repo)?.headRef) || "";
      if (!resolvedSource) return `resolved probe repository '${repo}': current branch lookup failed`;
    } else if (/^[A-Z][A-Z0-9_]*$/.test(source)) {
      // The current probe resolves only the checked-out branch, so requiring a
      // live refs/heads lookup here would falsely deny ordinary `main`-style
      // sources. Fail closed on Git's unqualified pseudo-ref naming class;
      // an all-uppercase branch remains expressible as refs/heads/<name>.
      return "unqualified pseudo-ref source is forbidden";
    }
    const sourceBranch = resolvedSource.replace(/^refs\/heads\//i, "");
    if (/^garelier\//i.test(sourceBranch)) return "garelier source refs are forbidden";
    if (/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]*$/i.test(destination)) continue;
    const branch = destination.replace(/^refs\/heads\//i, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return "invalid destination ref is forbidden";
    if (branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".lock")) return "invalid destination ref is forbidden";
    if (/^garelier\//i.test(branch)) return "garelier destination refs are forbidden";
  }
  return null;
}

function conciergeGitEgressDecision(
  input: GuardInput,
  context: GitInvocationContext,
): Decision | null {
  const deny = (reason: string): Decision => ({
    action: "deny",
    rule: "concierge_git_egress",
    reason: `${reason} ${ESCALATE_EGRESS}`,
  });
  const gitSegment = context.normalized;
  const probe = gitProbeRepo(input, context, true);
  if (!probe.repo) return deny(`Concierge git probe failed: ${probe.error ?? gitProbeLocation(context)}.`);
  if (RE.gitPushAny.test(gitSegment)) {
    const unsafe = explicitSafePush(input, gitSegment, probe.repo);
    return unsafe
      ? deny(`Concierge push requires a named configured remote and an explicit non-garelier refspec; ${unsafe}.`)
      : null;
  }
  if (/\bgit\s+pull\b/i.test(gitSegment)) return null; // profile_concierge_pull is the hard deny.
  if (/\bgit\s+fetch\b/i.test(gitSegment)) {
    const args = gitSubcommandArgs(gitSegment, "fetch") ?? [];
    const remote = args.find((arg) => !arg.startsWith("-"));
    const configured = remote ? namedRemoteUrls(input, probe.repo, remote) : { urls: [] };
    return configured.urls.length > 0
      ? null
      : deny(`Concierge fetch requires a named configured remote; ${configured.error ?? "direct or unresolved destinations are forbidden"}.`);
  }
  if (RE.gitRemoteWrite.test(gitSegment)) {
    const tokens = shellTokensWithPos(gitSegment).map(({ text }) => text);
    const remoteAt = tokens.findIndex((token, i) => token.toLowerCase() === "remote" && /^(?:git|git\.exe|git\.cmd)$/i.test(tokens[i - 1] ?? ""));
    const operation = tokens[remoteAt + 1]?.toLowerCase();
    const remote = tokens[remoteAt + 2] ?? "";
    const url = tokens[remoteAt + 3] ?? "";
    if (remoteAt < 0 || !/^(?:add|set-url)$/.test(operation ?? "") || !remote || !url || tokens.length !== remoteAt + 4) {
      return deny("Concierge remote mutation must use the explicit form `git remote add|set-url <name> <url>`.");
    }
    if (namedRemoteUrls(input, probe.repo, remote).urls.includes(url)) return null;
    return deny("Concierge remote URLs must be either the remote's already-configured URL or an exact PM-approved record destination.");
  }
  return deny("Concierge git egress command is not an approved promote operation.");
}

// --- rule tables -----------------------------------------------------------

const RE = {
  pipeToShell:
    /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod|fetch)\b[\s\S]*?\|\s*(sudo\s+)?(sh|bash|zsh|dash|ash|pwsh|powershell|python[0-9.]*|perl|ruby|node)\b/i,
  netTool: /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b/i,
  uploadFlags:
    /(?:^|\s)(-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|-d\b|--data\b|--data-[a-z]+\b|-F\b|--form\b|-T\b|--upload-file\b|-Method\s+(?:Post|Put|Patch|Delete)|-Body\b|-InFile\b|-Form\b)/i,
  // W-163: remote-package immediate-execution family — a runner that fetches an
  // EXTERNAL package and executes it in ONE step, before anyone can inspect it.
  // Enforced in Rule 3 below behind the per-family opt-in flag
  // `remote_exec_guard_enabled` (default false; same config path as the opt-in
  // install/update/download floor install_guard_enabled, W-160 — the two are
  // independent family flags, unified with the rest by W-164):
  // bunx / uvx / `npx <pkg>` / `bun x <pkg>` / pipx run / pnpm dlx /
  // `npm exec <pkg>` / `pnpm exec <pkg>` / `uv run --with <pkg>` /
  // `deno run <remote http(s) url>`. Runner forms with a package argument keep a
  // local-path exclusion (`(?!-|\.\/|\.\\|\/)`, applied AFTER an optional quote so
  // a quoted local path `bunx "./x.ts"` is still excluded) so a genuinely LOCAL
  // script that fetches nothing (`bunx ./x.ts`, `npx ./x.js`) is not caught.
  // W-164 folded the gate notes' false-negatives in: leading flags are skipped
  // (`npx -y pkg`, `npx --yes pkg`), the two-token `bun x <pkg>` alias, quoted
  // names (`bunx "cowsay"`), and `npm exec` / `pnpm exec`. `uv run` matches only
  // its `--with` remote-fetch form; `deno run` matches only when the FIRST
  // non-flag token is an http(s) specifier (W-164 anchor — so a local script that
  // merely passes a URL argument, `deno run ./x.ts --api https://…`, is left
  // alone). Plain local runners (`bun run`, `npm run`, `bun x.ts`, `uv run x.py`,
  // `deno run ./x.ts`) stay untouched.
  remotePackageExec:
    /\b(?:bunx|npx|bun\s+x)\s+(?:-\S+\s+)*["']?(?!-|\.\/|\.\\|\/)[a-z0-9@][^\s]*|\b(?:uvx|pipx\s+run|pnpm\s+dlx|(?:npm|pnpm)\s+exec)\b|\buv\s+run\b[^\n;]*--with\b|\bdeno\s+run\b(?:\s+-\S+)*\s+https?:\/\//i,
  comprehensiveInstallRun: /\b(uvx|bunx|npx|pipx\s+run|pnpm\s+dlx)\b/i,
  toolInstallUpdate: /^\s*(?:(?:sudo|command|env)\s+)*(?:(?:npm|npm\.cmd|pnpm|yarn|bun)\s+(?:ci|install|add|update|upgrade)\b|(?:python[0-9.]*\s+-m\s+)?pip[0-9.]*\s+install\b|uv\s+(?:pip\s+install|tool\s+(?:install|upgrade))\b|cargo\s+install\b|go\s+install\b|gem\s+(?:install|update)\b|rustup\s+(?:update|toolchain\s+install|component\s+add)\b|dotnet\s+tool\s+(?:install|update)\b|winget\s+(?:install|upgrade|download)\b|choco\s+(?:install|upgrade|update)\b|brew\s+(?:install|upgrade|update)\b|scoop\s+(?:install|update)\b|apt(?:-get)?\s+(?:install|update|upgrade|dist-upgrade)\b|(?:dnf|yum)\s+(?:install|update|upgrade)\b|pacman\s+-S)/i,
  installerAcquisition: /\b(?:curl|wget|iwr|invoke-webrequest)\b[\s\S]*(?:https?:\/\/\S*(?:install|setup|bootstrap)[^\s]*\.(?:sh|ps1|py|zip|tar\.gz|tgz)|https?:\/\/\S+\.(?:exe|msi|dmg|pkg|deb|rpm)(?:\?\S*)?|(?:-o|--output|-OutFile)\s+\S+\.(?:exe|msi|dmg|pkg|deb|rpm|sh|ps1))/i,
  // W-039: raw `codex exec` (vs the dispatch_provider.ts wrapper).
  codexExec: /(?:^|[\s"'/\\])codex(?:\.exe|\.cmd)?["']?\s+exec\b/i,
  codexSandboxReadOnly: /--sandbox[=\s]+["']?read-only\b/i,
  codexSandboxDanger: /--sandbox[=\s]+["']?danger-full-access\b/i,
  rmRecursive: /^\s*(?:(?:sudo|command)\s+)?rm\s+(?:-\S+\s+)*-\S*r/i, // rm with an r flag (recursive)
  psRemoveRecurse: /^\s*Remove-Item\b[\s\S]*-Recurse\b/i,
  rdRecurse: /^\s*(?:rd|rmdir)\b[\s\S]*\/s\b/i,
  // W-058: any push / fetch / pull / remote-write reaches a remote = egress.
  gitPushAny: /\bgit\s+push\b/i,
  gitFetchPull: /\bgit\s+(?:fetch|pull)\b/i,
  gitRemoteWrite: /\bgit\s+remote\s+(?:add|set-url)\b/i,
  gitPushForce: /\bgit\s+push\b[^\n;]*(?:--force\b|--force-with-lease\b|\s-f\b)/i,
  gitResetHard: /\bgit\s+reset\b[^\n;]*--hard\b/i,
  gitCleanForce: /\bgit\s+clean\b[^\n;]*\s-\S*f/i,
  gitBranchWord: /\bgit\s+branch\b/i,
  gitAmend: /\bgit\s+commit\b[^\n;]*--amend\b/i,
  gitWorktreeRmForce: /\bgit\s+worktree\s+remove\b[^\n;]*--force\b/i,
  gitRestore: /\bgit\s+restore\b/i, // discards working-tree changes
  // `git restore --staged <path>` only unstages (mutates the index, never the
  // working tree) — non-destructive, so it must not fall to force_write. Only a
  // restore that touches the working tree (default, or an explicit --worktree/-W)
  // discards edits. Exempt staged-only (W-134).
  gitRestoreStagedOnly: /\bgit\s+restore\b(?=[^\n;]*\s(?:--staged|-S)\b)(?![^\n;]*\s(?:--worktree|-W)\b)/i,
  gitCheckoutDiscard: /\bgit\s+checkout\b[^\n;]*\s--(\s|$)/i, // `checkout -- <path>` (not branch switch)
  // W-059: destructive command family + shell indirection heuristic. A
  // one-level `$VAR` / `$(...)` / backtick can materialize a `-rf` / `--hard` /
  // `-fdx` flag or an out-of-container target only at shell-expansion time,
  // after the literal-flag rules have already scanned the raw text.
  destructiveCmd: /^\s*(?:(?:sudo|command)\s+)?(?:rm|del|rd|rmdir|Remove-Item)\b|^\s*git\s+(?:reset|clean)\b/i,
  shellIndirection: /\$[A-Za-z0-9_{(]|`/,
  secretName: /(\.db|\.sqlite3?|\.env(?:\.[a-z0-9_-]+)?|credentials)\b/i,
  overwriteRedirect: /(?<!>)>(?!>)\s*("[^"]+"|'[^']+'|[^\s&|]+)/,
  psOverwrite: /\b(Set-Content|Out-File|New-Item)\b/i,
  overwriteCp: /\b(cp\s+-\S*f|mv|tee)\b/i,
  deleteCmd: /^\s*(?:(?:sudo|command)\s+)?(?:rm|del|Remove-Item)\b/i,
  // W-170/W-173: process-kill detection, evaluated PER STATEMENT (a `|` pipeline
  // stays one statement; `;` / `&&` / `||` / newline split statements) so a decoy
  // fence token in one statement cannot launder a bulk kill in another, and a
  // stray `-Id` elsewhere cannot neutralize a name kill. PowerShell aliases are
  // covered: `spps` = Stop-Process, `gps` = Get-Process, `kill` = Stop-Process.
  psStopVerb: /\b(?:Stop-Process|spps)\b/i,          // explicit PS stop verb
  psKillAliasByName: /\bkill\s+-Name\b/i,            // `kill -Name x` (PS alias, not POSIX `kill <pid>`)
  psGetProcess: /\b(?:Get-Process|gps)\b/i,          // name selector (aliased)
  psPipeToKill: /\|\s*(?:Stop-Process|spps|kill)\b/i, // `Get-Process … | kill` / `… | spps`
  killById: /-Id\b/i,                                 // a PID selector IN THIS statement → PID-scoped
  taskkillImage: /\btaskkill\b[\s\S]*?\/IM\b/i,       // /IM <image> = name bulk (vs /PID)
  pkillByName: /\b(?:pkill|killall)\b/i,              // always name-based (fence via -f <path>)
};

function withAction(policy: GuardPolicy, rule: RuleId, fallback: Action): Action {
  return policy.actions[rule] ?? fallback;
}

/** W-179 (d3): does any project pattern match? A malformed user regex never matches
 * (it must not throw and fail-open the whole evaluate). */
function matchesAnyPattern(patterns: readonly string[] | undefined, text: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const pattern of patterns) {
    try { if (new RegExp(pattern, "i").test(text)) return true; } catch { /* a bad pattern never matches */ }
  }
  return false;
}

// W-170 process-kill family ---------------------------------------------------

/** A distinctive path segment of a fence root — one that uniquely names this
 * dispatch (contains a digit, length ≥ 4: `_crew/dispatch9`, `dispatch371`, `w170-…`),
 * so a kill filter referencing it (`-like '*_crew/dispatch9*'`) proves the kill is
 * scoped to the own worktree. Generic segments (`checkout`, `_crew`, `lanes`) have
 * no digit and are excluded to keep the fence-scope test from false-allowing.
 * EXPORTED (W-173) so dispatch_prepare's preamble recommends the EXACT token the
 * guard accepts — the two drifting apart is the self-defeating bug W-173 fixes. */
export function distinctiveFenceToken(root: string): string {
  const leaf = root.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  for (let i = leaf.length - 1; i >= 0; i--) {
    if (leaf[i].length >= 4 && /\d/.test(leaf[i])) return leaf[i];
  }
  return "";
}

/** True when a process-kill STATEMENT filters to the own worktree — it contains a
 * full fence-root path, or a distinctive fence segment (`_crew/dispatch9`), in the SAME
 * statement as the kill (a `-like '*…*'` CommandLine filter or a `pkill -f <path>`).
 * W-173: called per statement, so a fence token in a DIFFERENT statement cannot
 * launder this kill. Fails closed (false) with no fence resolved. */
function isFenceScopedKill(statement: string, fenceRoots: string[]): boolean {
  if (fenceRoots.length === 0) return false;
  const norm = statement.replace(/\\/g, "/").toLowerCase();
  for (const root of fenceRoots) {
    const r = root.replace(/\\/g, "/").toLowerCase();
    if (r && norm.includes(r)) return true;
    const token = distinctiveFenceToken(root);
    if (token && norm.includes(token)) return true;
  }
  return false;
}

/** W-173: split a classified command into STATEMENTS for per-statement kill
 * analysis. A `|` keeps a pipeline together (one statement); `;` / `&&` / `||` /
 * newline are statement boundaries. Prevents a decoy statement's fence token (or a
 * stray `-Id`) from laundering a bulk kill in another statement. */
function splitKillStatements(command: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  for (const { segment, separator } of splitShellParts(command)) {
    current.push(segment);
    if (separator !== "|") { // ";" / "\n" / "&&" / "||" / "" → statement boundary
      statements.push(current.join(" | "));
      current = [];
    }
  }
  if (current.length) statements.push(current.join(" | "));
  return statements;
}

/** W-173: drop a trailing `#` comment from a statement before kill analysis, so a
 * comment neither injects a fake kill token nor a fake fence token — `pkill cargo
 * #dispatch371` must NOT be laundered as fence-scoped. Quote-aware (a `#` inside
 * quotes is data, e.g. a `-like '…#dispatch<N>…'` pattern) and word-start-only (a
 * `#` mid-token like `path#hash` is not a comment). */
function stripStatementComment(statement: string): string {
  let quote = "";
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < statement.length) { i++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(statement[i - 1]))) return statement.slice(0, i);
  }
  return statement;
}

/** True when a single statement is an INDISCRIMINATE name/image bulk kill. A
 * PID selector IN THIS statement (`Stop-Process -Id`, `taskkill /PID`, POSIX
 * `kill <pid>`) makes it PID-scoped → not bulk. PowerShell aliases covered
 * (spps/gps/kill). */
function statementIsBulkKill(statement: string): boolean {
  const byId = RE.killById.test(statement); // PID-scoped in THIS statement
  const psBulk =
    !byId &&
    (RE.psStopVerb.test(statement) || // Stop-Process / spps (by name or piped)
      RE.psKillAliasByName.test(statement) || // `kill -Name x`
      (RE.psGetProcess.test(statement) && RE.psPipeToKill.test(statement))); // `Get-Process … | kill`
  return psBulk || RE.taskkillImage.test(statement) || RE.pkillByName.test(statement);
}

/** W-170/W-173: the process-kill decision, evaluated PER STATEMENT. Returns a
 * decision for the FIRST statement that is an INDISCRIMINATE name/image bulk kill
 * (`Get-Process cargo,rustc | Stop-Process`, `taskkill /IM cargo.exe`, `pkill rustc`,
 * `gps cargo | spps`) NOT scoped to the own worktree. A PID-scoped kill and a
 * fence-filtered kill are out of scope (null → allow). A role seat gets
 * deny (it must not stop another role's build — the #371 incident); a PM-direct /
 * PM / record-less seat gets ask (attended judgment). */
function processKillDecision(command: string, input: GuardInput, policy: GuardPolicy): Decision | null {
  const fenceRoots = ownWorktreeRoots(input);
  const offending = splitKillStatements(command)
    .map(stripStatementComment) // W-173: a `#` comment cannot launder a bulk kill
    .find((stmt) => statementIsBulkKill(stmt) && !isFenceScopedKill(stmt, fenceRoots));
  if (!offending) return null; // no unscoped bulk kill statement → allow
  const currentRoute = input.executionRoute;
  const legacyRoute = input.laneKind;
  const executionRoute =
    currentRoute !== undefined && legacyRoute !== undefined && currentRoute !== legacyRoute
      ? undefined
      : currentRoute ?? legacyRoute;
  const roleSeat =
    (input.profile === "role" || input.profile === "scout" ||
      (input.role ?? "").toLowerCase() === "worker") &&
    executionRoute !== "pm-direct";
  const base: Action = roleSeat ? "deny" : "ask";
  const action = policy.actions.process_kill ?? base;
  // Recommend the EXACT token the guard accepts (distinctiveFenceToken), so a
  // worker who follows the advice is NOT re-denied (W-173 (3)).
  const token = fenceRoots[0] ? distinctiveFenceToken(fenceRoots[0]) : "";
  const example = fenceRoots[0]
    ? `filter to your own worktree — e.g. \`Get-Process | Where-Object { $_.CommandLine -like '*${token || fenceRoots[0]}*' } | Stop-Process\` or \`pkill -f '${fenceRoots[0]}'\` — or kill by explicit PID`
    : `filter the kill to your own dispatch worktree path (CommandLine -like / pkill -f <path>), or kill by explicit PID`;
  return {
    action,
    rule: "process_kill",
    reason: `Indiscriminate process kill by name/image can stop OTHER roles' builds — the #371 incident killed the primary's post-merge verify. ${example}. ${ESCALATE}`,
  };
}

/** A path inside some PM's canonical control tree (`__garelier/<pm>/control/…`). */
const CONTROL_TREE_PATH = /(?:^|[\\/])__garelier[\\/][^\\/]+[\\/]control[\\/]/;

/** Flags whose VALUE is prose, not a path — excluded before scanning a `git
 * commit` segment for control pathspecs so a commit message that merely mentions
 * a control path cannot trip the rule. */
const COMMIT_PROSE_FLAG = /^(?:-m|--message|-F|--file|--author|--date|-C|--reuse-message|-c|--reedit-message|--fixup|--squash|--trailer)$/;

/** Control-tree pathspecs named on a `git commit` command line. Read alongside
 * the staged set, because the pathspec form (`git commit -- <path>`) stages
 * nothing until git runs and would otherwise be invisible at PreToolUse time. */
function commitControlPathspecs(gitSegment: string): string[] {
  const tokens = shellTokensWithPos(gitSegment).map((token) => token.text);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (COMMIT_PROSE_FLAG.test(token)) { i++; continue; }
    // Attached form (`-m"msg"` / `--message=msg`) — value is prose, skip whole token.
    if (/^(?:-m|--message=|-F|--file=)/.test(token) && token.length > 2) continue;
    if (CONTROL_TREE_PATH.test(token)) out.push(token);
  }
  return out;
}

/** True when the seat's dispatch record OWNS the worktree the commit targets — a
 * role committing on its own branch, which stays allowed. Path CONTAINMENT is
 * deliberately not used: a lane lives UNDER the primary checkout, so a PM-direct
 * record anchored at the primary would "contain" every lane. Only an exact
 * worktree-top match proves ownership. */
function seatOwnsCommitWorktree(input: GuardInput, topLevel: string): boolean {
  const currentRoute = input.executionRoute;
  const legacyRoute = input.laneKind;
  // Match processKillDecision's fail-closed conflict handling: an ambiguous
  // route marker cannot establish the ownership exemption.
  if (currentRoute !== undefined && legacyRoute !== undefined && currentRoute !== legacyRoute) return false;
  const executionRoute = currentRoute ?? legacyRoute;
  if (executionRoute === "pm-direct") return false;
  if (input.profile !== "role" && input.profile !== "scout") return false;
  const worktree = input.worktree;
  if (!worktree) return false;
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  return norm(worktree) === norm(topLevel);
}

/** W-267 — an ATTENDED seat committing control-tree paths onto a lane branch.
 *
 * The incident class: a PM shell whose cwd was left in a dispatch checkout /
 * isolate lane runs `git commit` there. The lane is a LINKED worktree on a
 * workbench/isolate branch, so the control rows land on that branch and in the
 * checkout's committed control copy instead of studio — silently, and needing a
 * revert + primary redo (#432 / #433, 2026-07-28).
 *
 * Scope is deliberately narrow, because over-deny here would block ordinary PM
 * work: the rule fires ONLY on a linked worktree (the primary is already covered
 * by the scripts/hooks/pre-commit misplace guard), ONLY off an integration branch
 * (one whose name ends in `/studio`), ONLY when control-tree paths are in the commit,
 * and ONLY for a seat that does not own that worktree. A role committing its
 * own branch — including control paths its assignment authorizes — is untouched.
 */
function controlMisplaceDecision(
  contexts: GitInvocationContext[],
  input: GuardInput,
  policy: GuardPolicy,
): Decision | null {
  if (!policy.control_misplace_guard_enabled) return null;
  const probe = input.commitRepo;
  for (const context of contexts) {
    const gitSeg = context.normalized;
    if (!/^\s*git\s+commit\b/i.test(gitSeg)) continue;
    const resolved = gitProbeRepo(input, context, false);
    if (!resolved.repo || !probe) {
      return {
        action: policy.actions.control_misplace ?? "deny",
        rule: "control_misplace",
        reason:
          `W-267 misplace guard could not resolve commit provenance at ${gitProbeLocation(context)}: ` +
          `${resolved.error ?? "commit repository probe is unavailable"}. ${ESCALATE}`,
      };
    }
    const dir = resolved.repo;
    const facts = probe(dir);
    if (!facts?.topLevel || !facts.mainWorktreeRoot) {
      return {
        action: policy.actions.control_misplace ?? "deny",
        rule: "control_misplace",
        reason:
          `W-267 misplace guard could not read commit provenance at ${gitProbeLocation(context)}: ` +
          `repository shape probe failed. ${ESCALATE}`,
      };
    }
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    // Primary worktree — the sh pre-commit hook owns that case; do not double-guard.
    if (norm(facts.topLevel) === norm(facts.mainWorktreeRoot)) continue;
    if (/\/studio$/.test(facts.headRef)) continue;
    if (seatOwnsCommitWorktree(input, facts.topLevel)) continue;
    const touched = [...facts.stagedPaths, ...commitControlPathspecs(gitSeg)]
      .filter((path) => CONTROL_TREE_PATH.test(path));
    if (!touched.length) continue;
    const sample = touched.slice(0, 3).join(", ");
    return {
      action: policy.actions.control_misplace ?? "deny",
      rule: "control_misplace",
      reason:
        `W-267 misplace guard: this seat is committing control-tree path(s) (${sample}${touched.length > 3 ? ", …" : ""}) ` +
        `onto '${facts.headRef || "<detached>"}' in the LINKED worktree ${facts.topLevel}, which it does not own. ` +
        `Control rows belong on the integration (*/studio) branch in ${facts.mainWorktreeRoot}; committing here buries them on a lane branch ` +
        `and in that checkout's committed control copy (the #432 / #433 incidents). ` +
        `Fix: cd ${facts.mainWorktreeRoot} and re-run the commit there. ${ESCALATE}`,
    };
  }
  return null;
}

/** `git merge` flags that consume the NEXT token, so its value is never mistaken
 * for the merged-from ref. */
const MERGE_VALUE_FLAG = /^(?:-m|-s|-X|-F|-S|--message|--strategy|--strategy-option|--file|--into-name|--gpg-sign)$/;

/** Source refs named on a `git merge` command line. `control` marks the
 * non-merging control forms (`--abort` / `--continue` / `--quit`), which start no
 * integration and are never the bypass. */
function mergeSourceRefs(gitSegment: string): { refs: string[]; control: boolean } {
  const tokens = shellTokensWithPos(gitSegment).map((token) => token.text);
  const at = tokens.findIndex((token) => token === "merge");
  if (at < 0) return { refs: [], control: false };
  const refs: string[] = [];
  for (let i = at + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^--(?:abort|continue|quit)$/.test(token)) return { refs: [], control: true };
    if (MERGE_VALUE_FLAG.test(token)) { i++; continue; }
    if (token === "--" || token.startsWith("-")) continue;
    refs.push(token);
  }
  return { refs, control: false };
}

function normalizeLocalMergeRef(
  dir: string,
  ref: string,
  probe: GitCanonicalRefProbe | undefined,
): { ref: string; unknownAlias: boolean } {
  const canonical = probe?.(dir, ref) ?? "";
  if (canonical.startsWith("refs/heads/")) {
    const short = canonical.slice("refs/heads/".length);
    return short ? { ref: short, unknownAlias: false } : { ref, unknownAlias: true };
  }
  // This is the complete classification boundary: only a source Git resolves to
  // refs/heads/* is a local branch. Remote-tracking refs, tags, notes, replace
  // refs, ambiguous/unresolved names, revision expressions, and any future
  // namespace all fail closed without a growing list of shorthand spellings.
  return { ref: canonical || ref, unknownAlias: true };
}

/**
 * W-318 — a hand-run `git merge` INTO the integration branch, which is exactly
 * how the merge gate gets bypassed.
 *
 * The incident class: the merge gate serializes studio integration and is what
 * produces the `runtime/merge_gate/results/` record every downstream step reads.
 * A PM running `git merge --no-ff <lane-branch>` on studio gets the commits in
 * with no result file, no Guardian/Observer binding, and no row evidence — and
 * nothing anywhere detected or warned about it. Three times in one day.
 *
 * Scope is deliberately narrow so ordinary work is untouched. It fires ONLY when
 * HEAD is the integration branch (a ref name ending in `/studio`), so a role
 * base-tracking (`git merge studio` on its own workbench branch) and a Concierge promote
 * (studio merged into the target branch) never match. On studio, the merged-from
 * ref is first resolved through Git's own lookup and then classified:
 *   - a canonical `refs/heads/garelier/…` lane branch → deny;
 *   - anything not canonicalized to `refs/heads/*`, or no ref → ask;
 *   - another canonical local branch → inspect topology: deny when its
 *     unpublished source commit belongs to a lane history, allow when already
 *     reachable from studio (including target tracking at a shared base) or
 *     unrelated to every lane.
 */
function mergeGateBypassDecision(
  contexts: GitInvocationContext[],
  input: GuardInput,
  policy: GuardPolicy,
): Decision | null {
  if (!policy.merge_gate_bypass_guard_enabled) return null;
  const probe = input.commitRepo;
  for (const context of contexts) {
    const gitSeg = context.normalized;
    // W-539: `\b` after `merge` is a WORD boundary, and `e`->`-` crosses one — so
    // the trigger also fired on every `git merge-*` PLUMBING command
    // (`merge-base`, `merge-file`, `merge-tree`, `merge-index`). None of those
    // moves a ref, which is the entire thing this rule exists to catch, and
    // `mergeSourceRefs` cannot even parse them (it looks for a token equal to
    // `merge`), so they reached the provenance probe with no refs and were denied
    // as unresolvable provenance — a merge-gate bypass verdict on a command that
    // cannot merge. `(?=\s|$)` anchors the subcommand to the exact word.
    if (!/^\s*git\s+merge(?=\s|$)/i.test(gitSeg)) continue;
    const { refs, control } = mergeSourceRefs(gitSeg);
    if (control) continue;
    const resolved = gitProbeRepo(input, context, false);
    if (!resolved.repo || !probe) {
      return {
        action: withAction(policy, "merge_gate_bypass", "deny"),
        rule: "merge_gate_bypass",
        reason:
          `W-318 merge-gate bypass check could not resolve provenance at ${gitProbeLocation(context)}: ` +
          `${resolved.error ?? "commit repository probe is unavailable"}. ${ESCALATE}`,
      };
    }
    const dir = resolved.repo;
    const facts = probe(dir);
    if (!facts) {
      return {
        action: withAction(policy, "merge_gate_bypass", "deny"),
        rule: "merge_gate_bypass",
        reason:
          `W-318 merge-gate bypass check could not read provenance at ${gitProbeLocation(context)}: ` +
          `repository shape probe failed. ${ESCALATE}`,
      };
    }
    if (!facts.headRef || !/\/studio$/.test(facts.headRef)) continue;
    const normalized = refs.map((source) => normalizeLocalMergeRef(dir, source, input.canonicalRefProbe));
    const lane = normalized.filter((source) => !source.unknownAlias && /^garelier\//.test(source.ref) && !/\/studio$/.test(source.ref));
    let unknownAlias = normalized.some((source) => source.unknownAlias);
    let aliasedLane: { source: string; laneRef: string } | null = null;
    for (let sourceIndex = 0; sourceIndex < refs.length; sourceIndex++) {
      if (normalized[sourceIndex]?.unknownAlias) continue;
      const topology = input.mergeSourceTopologyProbe?.(dir, refs[sourceIndex]!, facts.headRef) ?? null;
      if (topology === null) {
        unknownAlias = true;
        continue;
      }
      // A source already reachable from studio cannot bypass its merge gate:
      // merging it is a no-op/target-tracking update. This exemption must win
      // over a zero-change lane that happens to share the same base commit.
      if (topology.sourceInIntegration) continue;
      const laneRef = topology.containingLaneRefs.find((ref) => ref.startsWith("refs/heads/garelier/") && !ref.endsWith("/studio"));
      if (laneRef) {
        aliasedLane = { source: refs[sourceIndex]!, laneRef: laneRef.slice("refs/heads/".length) };
        break;
      }
    }
    const fix =
      `The merge gate is what serializes studio integration and writes the result record every later step reads ` +
      `(dispatch_cleanup, the row's merge evidence, the Guardian/Observer binding). Merging by hand produces none of it and wedges the ` +
      `dispatch container (W-318). Use merge_land.ts --dispatch-id <n> instead. ${ESCALATE}`;
    if (lane.length || aliasedLane) {
      const source = aliasedLane?.source ?? lane[0]!.ref;
      const identity = aliasedLane ? ` (unpublished commit contained by lane '${aliasedLane.laneRef}')` : "";
      return {
        action: withAction(policy, "merge_gate_bypass", "deny"),
        rule: "merge_gate_bypass",
        reason: `W-318 merge-gate bypass: merging lane source '${source}'${identity} directly into the integration branch '${facts.headRef}' in ${facts.topLevel}. ${fix}`,
      };
    }
    if (!refs.length || unknownAlias || normalized.some((source) => /^[0-9a-f]{7,40}$/i.test(source.ref))) {
      return {
        action: withAction(policy, "merge_gate_bypass", "ask"),
        rule: "merge_gate_bypass",
        reason:
          `W-318 merge-gate bypass check: this merges ${refs.length ? `'${refs[0]}'` : "an unnamed source"} into the integration branch ` +
          `'${facts.headRef}' in ${facts.topLevel}, and the guard cannot tell from the command line whether that source is a gated lane branch. ${fix}`,
      };
    }
  }
  return null;
}

/**
 * W-286 — `git add` mutates the same shared studio index that an active merge
 * gate will commit. The commit hook is too late: it can refuse the user's
 * commit while leaving those bytes staged for the gate's later merge commit.
 *
 * This is an invariant, not a policy-tunable family. It is deliberately scoped
 * to the primary worktree while HEAD is an integration branch ending in
 * `/studio` and its active.lock exists;
 * role/linked-worktree indexes remain independent and are untouched.
 */
function mergeGateIndexMutationDecision(
  contexts: GitInvocationContext[],
  input: GuardInput,
): Decision | null {
  const probe = input.commitRepo;
  for (const context of contexts) {
    if (!/^\s*git\s+(?:add|stage)(?:\s|$)/i.test(context.normalized)) continue;
    const resolved = gitProbeRepo(input, context, false);
    if (!resolved.repo || !probe) {
      return {
        action: "deny",
        rule: "merge_gate_index_mutation",
        reason:
          `W-286 active merge gate index check could not reproduce the target of this add-equivalent Git invocation at ` +
          `${gitProbeLocation(context)}: ${resolved.error ?? "commit repository probe is unavailable"}. ` +
          `Refusing because the command could target a shared studio index while its gate is active. ` +
          `Use the canonical \`git -C <repo> add ...\` form after the gate finishes. ${ESCALATE}`,
      };
    }
    const facts = probe(resolved.repo);
    if (!facts) {
      return {
        action: "deny",
        rule: "merge_gate_index_mutation",
        reason:
          `W-286 active merge gate index check could not read repository provenance at ${gitProbeLocation(context)}. ` +
          `Refusing because index ownership is unproven. ${ESCALATE}`,
      };
    }
    if (facts.mergeGateProbeError) {
      return {
        action: "deny",
        rule: "merge_gate_index_mutation",
        reason:
          `W-286 active merge gate index check could not resolve the trusted control root for ${facts.topLevel}: ` +
          `${facts.mergeGateProbeError}. Refusing because active-gate absence is unproven. ${ESCALATE}`,
      };
    }
    if (!facts.mergeGateActive || !/\/studio$/.test(facts.headRef)) continue;
    const norm = (value: string) => value.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    if (norm(facts.topLevel) !== norm(facts.mainWorktreeRoot)) continue;
    return {
      action: "deny",
      rule: "merge_gate_index_mutation",
      reason:
        `W-286 active merge gate: git add would mutate the shared studio index in ${facts.topLevel} while ` +
        "`runtime/merge_gate/locks/active.lock` exists. Wait for the gate to finish, then stage the work on its intended branch; " +
        `the guard does not stash or unstage existing index state. ${ESCALATE}`,
    };
  }
  return null;
}

/**
 * W-274 — forced `git branch` detection, with the flag read CASE-SENSITIVELY.
 *
 * The old single pattern was `/\bgit\s+branch\b[^\n;]*\s-\S*[fD]/i`. The trailing
 * `/i` applied to `[fD]` as well, so lowercase `-d` matched the `D` class and every
 * ordinary `git branch -d <merged-branch>` was classified force_write and asked.
 * That is wrong on git's own semantics: `-d` is the SAFE delete — git itself refuses
 * to delete a branch that is not fully merged — while `-D` is the force that
 * overrides exactly that refusal. Only `-D`, `-f`/`--force`, and combined short
 * forms carrying them are destructive.
 *
 * The `git branch` WORD stays case-insensitive so an uppercase evasion
 * (`GIT BRANCH -D`) is still caught; only the flag comparison is case-sensitive.
 */
function isGitBranchForce(segment: string): boolean {
  if (!RE.gitBranchWord.test(segment)) return false;
  // Never look past a statement break, matching the old `[^\n;]*` bound.
  const statement = segment.split(/[\n;]/, 1)[0] ?? "";
  for (const { text } of shellTokensWithPos(statement)) {
    if (!text.startsWith("-")) continue;
    if (/^--force\b/.test(text)) return true;
    if (text.startsWith("--")) continue; // other long options are not force
    const flags = text.slice(1);
    // `D` is compared case-sensitively (this is the whole fix); `f` is force in
    // either case, so it keeps the case-insensitive test.
    if (flags.includes("D") || /[fF]/.test(flags)) return true;
  }
  return false;
}

function normalizedToolInvocation(segment: string): { invocation: string; opaquePrefix: boolean } {
  let rest = segment.trim();
  let opaquePrefix = false;
  for (;;) {
    const callOperator = /^&\s+/.exec(rest);
    if (callOperator) { rest = rest.slice(callOperator[0].length); continue; }
    // P-5 (blueprint w431-declared-gate-command-identity.md): `builtin` was
    // added here in an earlier W-431 round to help the declared-script
    // content-parsing predicate, but this function is GENERAL -- used for
    // both declared and non-declared commands -- so that addition changed
    // non-declared command classification too (e.g. `builtin npm install`
    // started denying as tool_install_update for an ordinary role
    // command). The predicate it was added for is deleted (identity
    // verification never parses content at all), and the current blueprint's
    // scope explicitly excludes changing non-declared command judgment.
    // Reverted to the pre-W-431 wrapper set.
    const wrapper = /^(sudo|command|exec)\s+/i.exec(rest);
    if (wrapper) {
      rest = rest.slice(wrapper[0].length);
      if (/^--\s+/.test(rest)) rest = rest.replace(/^--\s+/, "");
      else if (/^-/.test(rest)) { opaquePrefix = true; break; }
      continue;
    }
    const envHead = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+/.exec(rest);
    const envPath = envHead?.[1] ?? envHead?.[2] ?? envHead?.[3] ?? "";
    const envName = envPath.replace(/\\/g, "/").split("/").pop()!.replace(/\.(?:exe|cmd|bat)$/i, "");
    if (/^env$/i.test(envName)) {
      rest = rest.slice(envHead![0].length);
      for (;;) {
        const endOptions = /^--\s+/.exec(rest);
        if (endOptions) { rest = rest.slice(endOptions[0].length); break; }
        const ignoreEnvironment = /^(?:-i|--ignore-environment)(?:\s+|$)/i.exec(rest);
        if (ignoreEnvironment) { rest = rest.slice(ignoreEnvironment[0].length); continue; }
        if (/^-/.test(rest)) { opaquePrefix = true; break; }
        break;
      }
      if (opaquePrefix) break;
      continue;
    }
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s]*)\s+/.exec(rest);
    if (assignment) { rest = rest.slice(assignment[0].length); continue; }
    break;
  }
  const head = /^(?:"([^"]+)"|'([^']+)'|(\S+))([\s\S]*)$/.exec(rest);
  if (!head) return { invocation: rest, opaquePrefix };
  const path = head[1] ?? head[2] ?? head[3];
  const name = path.replace(/\\/g, "/").split("/").pop()!.replace(/\.(?:exe|cmd|bat)$/i, "");
  return { invocation: `${name}${head[4]}`, opaquePrefix };
}

const STATIC_WRAPPER = /^(bash|sh|zsh|dash|cmd|pwsh|powershell)(?:\s|$)/i;

/** W-431 identity verification (PM 2026-08-17, blueprint
 * `w431-declared-gate-command-identity.md`). Five gate rounds each found a
 * new way past a "read the tracked script, then decide it's safe by
 * inspecting the text" predicate -- coproc, builtin, case-arm, `xargs`
 * argument delegation, glob expansion, heredoc delimiters, quoted-argument
 * classification blind spots. Closing the class needs a full Bash grammar
 * implementation this file does not have and should not grow. So this
 * function does not read the script for content at all -- it verifies
 * IDENTITY: (2) the path is git-tracked, non-symlink, inside the seat's own
 * worktree, and (3) the file's CURRENT on-disk bytes hash to the exact same
 * blob HEAD already has for that path (`git hash-object` == `git rev-parse
 * HEAD:<path>` -- condition 1, the command string matching a declared entry
 * verbatim, is verified by the caller before this is ever reached). No
 * shell/Bash construct inside the file changes this outcome, because nothing
 * in the file is ever parsed as shell syntax by this function -- there is
 * no body left to defeat. The trust boundary moves to "content already
 * committed to HEAD has been reviewed," which is the boundary the merge gate
 * already enforces; this adds no new one. A working-tree edit that has not
 * (yet) landed at that same blob -- however benign -- fails closed exactly
 * like an untracked file, because HEAD is the only content this guard has
 * any basis to trust. */
export function gitTrackedScriptIdentityVerified(
  declaration: DeclaredShellScriptIdentity,
  runtimeCwd: string | undefined,
): boolean {
  const scriptPath = declaration.scriptPath;
  if (!runtimeCwd || !scriptPath || /[\0\r\n~$*?`{}\[\]!]/.test(scriptPath)) return false;
  const pathParts = scriptPath.replace(/\\/g, "/").split("/");
  if (pathParts.includes("..")) return false;

  const gitEnv = { ...process.env };
  for (const name of Object.keys(gitEnv)) if (/^GIT_/i.test(name)) delete gitEnv[name];
  gitEnv.GIT_TERMINAL_PROMPT = "0";
  gitEnv.GIT_CONFIG_NOSYSTEM = "1";
  gitEnv.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  const git = (cwd: string, args: string[]): string | null => {
    try {
      return execFileSync(requireRuntimeExecutable("git"), [
        "-c", "safe.directory=*",
        "-c", "core.fsmonitor=false",
        "--no-replace-objects",
        "--literal-pathspecs",
        "-C", cwd,
        ...args,
      ], {
        encoding: "utf8",
        env: gitEnv,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        windowsHide: true,
      });
    } catch { return null; }
  };

  const rootText = git(runtimeCwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!rootText) return false;
  try {
    const canonicalPath = (path: string): string => {
      const real = realpathSync.native(resolve(path));
      if (real.startsWith("\\\\?\\UNC\\")) return `\\\\${real.slice(8)}`;
      return real.startsWith("\\\\?\\") ? real.slice(4) : real;
    };
    const root = canonicalPath(rootText);
    const canonicalRuntimeCwd = canonicalPath(runtimeCwd);
    const runtimePath = relative(root, canonicalRuntimeCwd);
    if (isAbsolute(runtimePath) || runtimePath === ".." || runtimePath.startsWith(`..${sep}`)) return false;
    const candidate = resolve(runtimeCwd, scriptPath);
    const info = lstatSync(candidate);
    // P-4 (blueprint w431-declared-gate-command-identity.md, PM correction):
    // a size cap is a 4th condition the blueprint's 3 do not name. Removed --
    // `git hash-object` cost scales with the file, but that is a resource
    // question, not part of the identity contract, and adding conditions
    // beyond the 3 is exactly what Observer's over-engineering lens flags.
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const canonical = canonicalPath(candidate);
    const comparablePath = (path: string): string => {
      const value = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
      return process.platform === "win32" ? value.toLowerCase() : value;
    };
    // Reject a symlink/junction in any path component, not only at the leaf.
    if (comparablePath(candidate) !== comparablePath(canonical)) return false;
    const trackedPath = relative(root, canonical);
    if (!trackedPath || isAbsolute(trackedPath) || trackedPath === ".." || trackedPath.startsWith(`..${sep}`)) return false;
    const repoPath = trackedPath.replace(/\\/g, "/");
    // Condition 3: the file's current on-disk bytes must hash to the SAME
    // blob HEAD has for this path -- not merely "present in the index",
    // which can diverge from both HEAD (staged-but-not-committed) and the
    // working tree (edited-after-add without a re-add). `--no-filters` is
    // load-bearing: Bash executes the raw on-disk bytes, while a repository
    // clean filter could otherwise erase a working-tree-only payload before
    // `hash-object` compares it with HEAD.
    const headBlob = git(root, ["rev-parse", "-q", "--verify", `HEAD:${repoPath}`])?.trim() ?? "";
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(headBlob)) return false;
    const workingHash = git(root, ["hash-object", "--no-filters", "--", canonical])?.trim() ?? "";
    return workingHash.length > 0 && workingHash.toLowerCase() === headBlob.toLowerCase();
  } catch {
    return false;
  }
}

function staticWrapperPayload(invocation: string): string | null {
  const head = /^(bash|sh|zsh|dash)(?:\s+(?:--noprofile|--norc|--posix|--restricted|-r|-s|-l|-i|-n|-v|-x))*\s+-(?:c|lc|cl)\s+([\s\S]+)$/i.exec(invocation)
    ?? /^(cmd)(?:\s+(?:\/d|\/q|\/s|\/a|\/u|\/e:(?:on|off)|\/f:(?:on|off)))*\s+\/c\s+([\s\S]+)$/i.exec(invocation)
    ?? /^(pwsh|powershell)(?:\s+(?:-NoProfile|-NonInteractive|-NoLogo|-Sta|-Mta|-ExecutionPolicy\s+\S+|-WorkingDirectory\s+\S+|-InputFormat\s+\S+|-OutputFormat\s+\S+|-WindowStyle\s+\S+))*\s+(?:-Command|-c)\s+([\s\S]+)$/i.exec(invocation);
  if (!head) return null;
  const payload = head[2].trim();
  const doubleQuoted = /^"((?:\\.|[^"\\])*)"$/.exec(payload);
  if (doubleQuoted) return doubleQuoted[1].replace(/\\(["\\])/g, "$1");
  const singleQuoted = /^'([^']*)'$/.exec(payload);
  if (singleQuoted) return singleQuoted[1];
  return head[1].toLowerCase() === "cmd" || /^(?:pwsh|powershell)$/i.test(head[1]) ? payload : /^\S+$/.test(payload) ? payload : null;
}

function normalizedToolInvocations(
  segment: string,
  maxDepth = 64,
): { invocations: string[]; opaqueWrapper: boolean } {
  const invocations: string[] = [];
  let current = segment;
  for (let depth = 0; depth <= maxDepth; depth++) {
    const normalized = normalizedToolInvocation(current);
    invocations.push(normalized.invocation);
    if (normalized.opaquePrefix) return { invocations, opaqueWrapper: true };
    const isWrapper = STATIC_WRAPPER.test(normalized.invocation);
    const payload = staticWrapperPayload(normalized.invocation);
    if (payload === null) return { invocations, opaqueWrapper: isWrapper };
    if (depth === maxDepth) return { invocations, opaqueWrapper: true };
    current = payload;
  }
  return { invocations, opaqueWrapper: true };
}

const MUTATION_HINT = new RegExp(
  `\\b(?:${MUTATION_VERBS}|git\\s+(?:add|commit|push|reset|clean|restore|checkout))\\b|(?<!>)>(?!>)`,
  "i",
);

function normalizedCommand(command: string): string {
  return command.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[ \t]+/g, " ");
}

function commandRuntimeBases(segments: string[], initialCwd: string | undefined): (string | undefined)[] {
  const bases: (string | undefined)[] = [];
  let active = initialCwd;
  for (const segment of segments) {
    bases.push(active);
    const cleaned = stripInertRedirects(segment).trim();
    if (!/^(?:cd|chdir|pushd|set-location|push-location|sl)(?:\s|$)/i.test(cleaned)) continue;
    const match = /^(?:cd|chdir|pushd|set-location|push-location|sl)(?:\s+(?:(?:-Path|-LiteralPath)\s+)?(?:"([^"]+)"|'([^']+)'|(\S+)))?\s*$/i.exec(cleaned);
    if (!match) {
      active = undefined;
      continue;
    }
    const operand = match[1] ?? match[2] ?? match[3] ?? "";
    if (!operand || /[$*?~`]/.test(operand)) {
      active = undefined;
    } else if (isAbsolutePath(operand)) {
      active = operand;
    } else {
      active = active ? resolve(active, operand) : undefined;
    }
  }
  return bases;
}

function isGitleaksInvocation(segment: string): boolean {
  return normalizedToolInvocations(segment).invocations.some(
    (invocation) => /^gitleaks(?:\s|$)/i.test(invocation),
  );
}

/** Canonical comparable directory form, shared by every seat-binding check so
 * they cannot disagree on when two spellings name the same directory. */
function normalizedSeatDir(value: string): string {
  const normalized = resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** W-353: a DECLARED command runs in the seat's reviewed worktree or not at all.
 *
 * W-297 bound gitleaks to the seat's worktree, but `gitleaksSeatIsBound` returns
 * true for EVERY non-gitleaks segment — so once `[guardian_tools]` is transcribed
 * into the record, the other declared scanners (pii / dependency / license /
 * sast) became reachable with NO cwd binding at all: run from a foreign cwd they
 * would scan a DIFFERENT tree and return it clean. That is the same
 * silent-wrong-target shape the guardian_scan toplevel binding closes, and
 * leaving it open only for non-gitleaks tools would make the guard fail-closed
 * for one scanner and fail-OPEN for the other four. The binding is therefore on
 * the declared route itself, not on one tool's name.
 *
 * A leading `cd <worktree>` rebases the segment (segmentBases/commandRuntimeBases
 * already model that), so the cwd-reset-resistant compound form stays allowed
 * while a bare invocation from a reset cwd fails closed. Presets are deliberately
 * NOT covered: a role's `cargo test` legitimately runs outside a scan target
 * (W-206), and a role that loses this match still reaches the W-122 in-fence
 * band — the binding bites exactly where it must, on the fail-closed gate seat. */
/** W-365: the roots a declared scanner's cwd is allowed to bind to -- the
 * seat's own worktree, plus any W-183 additional_roots the launcher
 * explicitly declared (attended_record --additional-root <target-repo>).
 * This is the seat-identity half of the cross-repo gap the row's Outcome
 * names: the binding used to compare only against input.worktree, so a
 * Guardian reviewing a DIFFERENT project's checkout could never bind, even
 * when the PM had explicitly declared that project as an authorized
 * additional root for the seat's fence. additionalRoots is empty unless the
 * launcher declared it, so an UNdeclared foreign repo still fails closed
 * exactly as before -- this only adds capability, an empty additionalRoots
 * list reduces to the pre-W-365 single-worktree check. */
function boundSeatRoots(input: GuardInput): string[] {
  return [input.worktree, ...(input.additionalRoots ?? [])].filter(
    (root): root is string => Boolean(root && root.trim().length > 0),
  );
}

/** The declared root runtimeBase actually matches, or undefined when it
 * matches none -- callers that need to scope a config-file exclusion check
 * (e.g. .gitleaks.toml) to the MATCHED root, not always the seat's own
 * worktree, read this instead of re-deriving the comparison themselves. */
function matchingBoundRoot(input: GuardInput, runtimeBase: string | undefined): string | undefined {
  if (!runtimeBase) return undefined;
  const normalizedBase = normalizedSeatDir(runtimeBase);
  return boundSeatRoots(input).find((root) => normalizedSeatDir(root) === normalizedBase);
}

function declaredSeatCwdIsBound(input: GuardInput, runtimeBase: string | undefined): boolean {
  return Boolean(matchingBoundRoot(input, runtimeBase));
}

function gitleaksSeatIsBound(
  segment: string,
  input: GuardInput,
  runtimeBase: string | undefined,
): boolean {
  if (!isGitleaksInvocation(segment)) return true;
  if ((input.gitleaksConfigEnvironment ?? []).length > 0) return false;
  if (/(?:^|\s)(?:GITLEAKS_CONFIG|GITLEAKS_CONFIG_TOML)=(?:"[^"]*"|'[^']*'|\S+)/i.test(segment)) return false;
  const bound = matchingBoundRoot(input, runtimeBase);
  if (!bound) return false;
  return !existsSync(join(bound, ".gitleaks.toml"))
    && !existsSync(join(bound, ".gitleaksignore"));
}

function outputsStayWithinFence(segment: string, input: GuardInput): boolean {
  const roots = [...(input.fenceRoots ?? []), ...(input.targetRoot ? [input.targetRoot] : [])];
  // W-206: anchor the output-fence check on the seat's WORKTREE, not the ambient hook
  // payload cwd. The harness RESETS the Bash session cwd between calls (실측 2026-07-21),
  // and W-119 already forbids trusting that ambient cwd — but this check keyed on it,
  // so the SAME preset quality-gate command (`cargo test -p X --lib Y`) flipped
  // allow/deny purely by which cwd the call happened to land in (ga-worker-waved-nibbles:
  // one variant allowed twice, three others profile_unknown-denied, same seat/fence).
  // A fenced role runs in its worktree by contract, so its default build outputs
  // (`target/`, `.`) are in-fence there; only an EXPLICIT --target-dir/--out-dir names a
  // path that must be independently proven in-fence. Fall back to input.cwd only when no
  // worktree resolved (a record-less seat), preserving the old behavior there.
  const base = input.worktree ?? input.cwd;
  if (roots.length === 0 || !base) return false;
  try {
    // Default build outputs (target/, node_modules/, coverage/, etc.) land under the
    // command's runtime cwd = the seat's worktree. An explicit output directory must
    // independently stay in the fence.
    assertPathMutation(".", "write", { cwd: base, fenceRoots: roots });
    const outputFlags = /(?:--target-dir|--out-dir|--outdir|--outDir|--outfile)\s+("[^"]+"|'[^']+'|\S+)/g;
    for (const match of segment.matchAll(outputFlags)) {
      assertPathMutation(match[1].replace(/^['"]|['"]$/g, ""), "write", { cwd: base, fenceRoots: roots });
    }
    // W-297: gitleaks JSON is supported only on stdout (`--report-path -`).
    // This is a scanner-specific contract, not a generic output flag: unrelated
    // PM-declared tools retain their exact-command behavior.
    if (isGitleaksInvocation(segment)) {
      const reportPaths = /--report-path(?:=|\s+)("[^"]+"|'[^']+'|\S+)/g;
      for (const match of segment.matchAll(reportPaths)) {
        if (match[1].replace(/^['"]|['"]$/g, "") !== "-") return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isCanonicalGitleaksInvocation(segment: string): boolean {
  const invocation = normalizedCommand(stripInertRedirects(collapseEmptyQuotePairs(segment)));
  const preset = READ_ONLY_INSPECTION_PRESETS.find(({ id }) => id === "gitleaks-readonly");
  return Boolean(preset && new RegExp(preset.pattern, "i").test(invocation));
}

/** W-365: true when `segment` is either a plain `cd`, itself a gitleaks
 * invocation, or a static shell wrapper (bash -c / powershell -Command /
 * etc.) whose OWN inner segments (after unwrapping, recursively) are ALL
 * themselves one of those three shapes. This is a pure SHAPE check -- it
 * proves nothing about cwd-binding or canonical grammar, both still enforced
 * separately below -- used only to decide whether a gitleaks-containing
 * command may ride a non-gitleaks segment alongside it at all.
 *
 * Checking a wrapper's OWN inner segments (not just excluding the wrapper
 * outright and deferring to its later, independent recursive
 * declaredCommandStaysHermetic call) closes a gap a first attempt at this
 * left open: `cd <worktree> && powershell -Command 'si Env:GITLEAKS_CONFIG
 * x'; gitleaks ...` -- deferring let the `si Env:...` segment through
 * because, evaluated on its OWN, it re-satisfies cwd-binding (the `cd` did
 * its job) and never itself contains the literal word "gitleaks" (`\b` does
 * not cross the `_` in `GITLEAKS_CONFIG`, so that recursive call's own
 * `containsGitleaks` gate never re-fires). Evaluating the wrapper's inner
 * segments HERE, at the point where a sibling segment DOES carry gitleaks,
 * is what catches it. */
function isGitleaksShapeSafeSegment(segment: string, depth = 0): boolean {
  if (depth > 16) return false;
  if (isPlainChangeDirectory(segment)) return true;
  if (isGitleaksInvocation(segment)) return true;
  const normalized = normalizedToolInvocation(segment);
  if (!STATIC_WRAPPER.test(normalized.invocation)) return false;
  const payload = staticWrapperPayload(normalized.invocation);
  if (payload === null) return false;
  const innerSegments = splitShellSegments(withoutHeredocBodies(payload));
  return innerSegments.length > 0
    && innerSegments.every((inner) => isGitleaksShapeSafeSegment(inner, depth + 1));
}

// W-431 history (retired 2026-08-17, blueprint
// `w431-declared-gate-command-identity.md`): five gate rounds each defeated a
// predicate here that tried to read a declared tracked script's body and
// decide, by inspecting the text, whether it was safe -- coproc, builtin, a
// case-arm early-return, `xargs`-style argument delegation, glob expansion,
// heredoc delimiters, and quoted-argument classification blind spots were
// each found and closed in turn, and each closure opened room for the next.
// The predicates that did this (`declaredExecutableHeadsAreStatic`,
// `segmentHasLiveDynamicToken`) are gone, not fixed again: closing the whole
// class needs a full Bash grammar implementation this file does not have and
// should not grow. `gitTrackedScriptIdentityVerified` above replaces the
// entire approach -- a declared tracked script is trusted by IDENTITY
// (git-tracked + current bytes hash to HEAD's blob), never by reading and
// judging its content, so no construct inside the file can defeat this the
// way all seven of the above did.

function declaredCommandStaysHermetic(
  command: string,
  input: GuardInput,
  initialCwd: string | undefined,
  depth = 0,
): boolean {
  if (depth > 16) return false;
  const containsGitleaks = /\bgitleaks(?:\.exe)?\b/i.test(collapseEmptyQuotePairs(command));
  if (containsGitleaks && /(?:\$\(|<\(|>\(|`)/.test(command)) return false;
  if (containsGitleaks
    && /(?:^|[\s;])(?:\$env:)?(?:GITLEAKS_CONFIG|GITLEAKS_CONFIG_TOML)\s*=/i.test(command)) {
    return false;
  }
  const segments = splitShellSegments(withoutHeredocBodies(command));
  // W-365: a blanket `segments.length !== 1` used to deny EVERY multi-segment
  // command that so much as mentioned "gitleaks", including the documented
  // `cd <worktree> && gitleaks <canonical>` cwd-reset-resistant form the
  // comment on declaredSeatCwdIsBound above describes as the supported shape
  // -- the harness resets a seat's shell cwd between Bash calls (W-353), so
  // that compound is how a seat survives the reset, not an edge case.
  //
  // The replacement is narrower than "every segment passes its own check",
  // which a first attempt at this fix got wrong: the per-segment loop below
  // validates cwd-binding and file-write targets, but NOT that a non-cd,
  // non-gitleaks segment is otherwise benign. `si Env:GITLEAKS_CONFIG
  // custom.toml; gitleaks dir . ...` (PowerShell's Set-Item alias, which the
  // dedicated `=`-syntax env-assignment regex above does not match) sets no
  // file and does not change cwd, so it slipped past every OTHER check when
  // the count restriction alone was removed -- a real regression caught by
  // the existing W-297 fixture. isGitleaksShapeSafeSegment (above) keeps the
  // shape closed instead: every segment of a gitleaks-containing command must
  // be `cd`, itself a gitleaks invocation, or a wrapper whose OWN inner
  // segments are all one of those (validated for canonical grammar + binding
  // by the per-segment loop just below) -- nothing else may ride along, even
  // hidden inside a wrapper. This still allows `cd <worktree> &&
  // gitleaks <canonical>` (bare or wrapped in `bash -lc '...'`) and still
  // denies `gitleaks ... && curl evil` / `si Env:GITLEAKS_CONFIG x;
  // gitleaks ...` / the same wrapped inside `powershell -Command '...'` /
  // any third segment, because none of those reduce to only cd-or-gitleaks
  // leaves.
  if (containsGitleaks && segments.some((segment) => !isGitleaksShapeSafeSegment(segment))) {
    return false;
  }
  if (containsGitleaks && segments.some((segment) => gitSelectorMutations(segment).some(
    (name) => /^(?:GITLEAKS_CONFIG|GITLEAKS_CONFIG_TOML|DYNAMIC_ENVIRONMENT_SELECTOR)$/.test(name),
  ))) {
    return false;
  }
  const runtimeBases = commandRuntimeBases(segments, initialCwd);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (!outputsStayWithinFence(segment, input)) return false;
    const normalized = normalizedToolInvocation(segment);
    const wrapper = STATIC_WRAPPER.test(normalized.invocation);
    if (wrapper) {
      const payload = staticWrapperPayload(normalized.invocation);
      if (payload === null) {
        if (/\bgitleaks\b/i.test(collapseEmptyQuotePairs(segment))) return false;
        continue;
      }
      const wrapperBase = /^(?:pwsh|powershell)\b[\s\S]*\s-WorkingDirectory(?:\s|$)/i.test(normalized.invocation)
        ? undefined
        : runtimeBases[index];
      if (!declaredCommandStaysHermetic(payload, input, wrapperBase, depth + 1)) return false;
      continue;
    }
    const segmentContainsGitleaks = /\bgitleaks(?:\.exe)?\b/i.test(collapseEmptyQuotePairs(segment));
    if (segmentContainsGitleaks && !isGitleaksInvocation(segment)) return false;
    if (isGitleaksInvocation(segment)) {
      if (!isCanonicalGitleaksInvocation(segment)) return false;
      if (!gitleaksSeatIsBound(segment, input, runtimeBases[index])) return false;
    }
    // W-353: bind EVERY executing segment of a declared command to the reviewed
    // worktree, not just the gitleaks one. A bare `cd` is the rebasing segment
    // itself (its own base is still the pre-cd one), so it is exempt — that is
    // what makes `cd <worktree> && <scanner>` the cwd-reset-resistant form.
    if (!isPlainChangeDirectory(segment) && !declaredSeatCwdIsBound(input, runtimeBases[index])) {
      return false;
    }
  }
  return true;
}

function qualityGateSegmentIsAllowed(
  segment: string,
  input: GuardInput,
  runtimeBase: string | undefined,
): boolean {
  // W-382 (AC-2): same env-prefix normalization as the read-only inspection path,
  // so `FOO="x" bun test f.test.ts` and `bun test f.test.ts` cannot disagree. The
  // strip refuses any assignment that could re-point the head or the repository,
  // and a substitution in a value keeps the segment opaque.
  const normalized = stripEnvAssignmentPrefix(normalizedCommand(segment));
  const preset = QUALITY_GATE_PRESETS.some(({ pattern }) => new RegExp(pattern, "i").test(normalized));
  return preset
    && outputsStayWithinFence(segment, input)
    && gitleaksSeatIsBound(segment, input, runtimeBase);
}

// W-159: a PM-declared verify command the gate seat must run is frequently a
// COMPOUND or a non-preset script (a project census `bash scripts/census.sh`, a
// `cd checkout && bun test && tsc --noEmit` chain) — the WHOLE invocation is the
// unit the PM listed in the record's quality_gate_commands, so the per-segment
// per-segment preset match never recognizes it and the seat
// fails closed to deny (실측: census Guardian / W-156 gate seats, 2026-07-19). A
// gate seat can then not run its own row's verification. Allow the command when
// the WHOLE normalized command EXACTLY matches a listed entry (verbatim only —
// an unlisted or partially-matching script still fails closed; this is the
// laundering floor) and its outputs stay inside the dispatch fence. This only
// suppresses the fail-closed `profile_unknown` band: the deny floor
// (gate_mutation, egress, delete, secret, force, process_kill) is evaluated
// separately and each outranks this under strictest-wins, so a listed entry can
// never launder a deny-floor command (`cd x && git push` still denies).
// PROFILE-AGNOSTIC (W-159 O1): the allow is not scoped to the gate profile — any
// profile carrying a declared list gets it, and in practice only the gate seat
// carries one. Narrowing to gate would not close the forge surface (the deny
// floor already binds every profile), so the check stays profile-independent.
/** W-431 P-13: the single command-identity predicate shared by every declared
 * admission path. Executed bytes may be either the declaration itself or
 * exactly `cd "<seat worktree>" && <declaration>`. The latter is accepted only
 * when its quoted operand resolves to this seat's worktree. No segment,
 * wrapper, payload, or nested-command matching occurs here. */
function matchingDeclaredCommand(input: GuardInput): DeclaredCommandMatch | undefined {
  const configured = input.qualityGateCommands ?? [];
  if (configured.length === 0) return undefined;

  const rawInput = (input.command ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
  let command = configured.find((entry) => normalizedCommand(entry) === normalizedCommand(rawInput));
  let runtimeCwd = input.cwd;

  if (command === undefined) {
    const doubleQuoted = /^cd[ \t]+"([^"$`\r\n]*)"[ \t]+&&[ \t]+([\s\S]+)$/.exec(rawInput);
    const singleQuoted = /^cd[ \t]+'([^'\r\n]*)'[ \t]+&&[ \t]+([\s\S]+)$/.exec(rawInput);
    const cwdSafe = doubleQuoted ?? singleQuoted;
    if (cwdSafe) {
      command = configured.find((entry) => normalizedCommand(entry) === normalizedCommand(cwdSafe[2]!));
      const operand = cwdSafe[1]!;
      const resolvedOperand = isAbsolutePath(operand)
        ? operand
        : input.cwd ? resolve(input.cwd, operand) : undefined;
      if (command !== undefined && input.worktree && resolvedOperand
        && normalizedSeatDir(resolvedOperand) === normalizedSeatDir(input.worktree)) {
        runtimeCwd = input.worktree;
      } else if (command !== undefined) {
        return { command, runtimeCwd, shellScript: { kind: "outside_identity" } };
      }
    } else {
      const unquoted = /^cd[ \t]+\S+[ \t]+&&[ \t]+([\s\S]+)$/.exec(rawInput);
      const attempted = unquoted
        ? configured.find((entry) => normalizedCommand(entry) === normalizedCommand(unquoted[1]!))
        : undefined;
      if (attempted !== undefined) {
        return { command: attempted, runtimeCwd, shellScript: { kind: "outside_identity" } };
      }
    }
  }
  if (command === undefined) return undefined;

  const declaration = normalizedCommand(command);
  const directBash = /^(?:(bash(?:\.exe)?)|&\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'))\s+((?!-)[A-Za-z0-9_./-]+)(?:\s+(?:[-A-Za-z0-9_./:=+,%@\\]+|"[-A-Za-z0-9_./:=+,%@\\ ]+"|'[-A-Za-z0-9_./:=+,%@\\ ]+'))*$/i.exec(declaration);
  if (directBash) {
    // P-14: direct identity is interpreter head + execution repository +
    // tracked/HEAD script. A declaration that lets PowerShell/cmd expand the
    // quoted executable does not statically identify the interpreter. The
    // repository relation is checked here before the script probe validates
    // the third component against that same runtime cwd.
    const quotedHead = directBash[2] ?? directBash[3];
    const staticBashHead = directBash[1] !== undefined
      || (quotedHead !== undefined
        && /[\\/]bash(?:\.exe)?$/i.test(quotedHead)
        && !/[$`]/.test(quotedHead)
        && !/%[^%\r\n]+%/.test(quotedHead));
    if (!staticBashHead || !declaredSeatCwdIsBound(input, runtimeCwd)) {
      return { command, runtimeCwd, shellScript: { kind: "outside_identity" } };
    }
    return {
      command,
      runtimeCwd,
      shellScript: { kind: "identity", value: { command, scriptPath: directBash[4]! } },
    };
  }

  // Ordinary non-shell scanner commands retain declared admission. Shell
  // wrappers/delegation never do, even when their complete text is declared.
  const namesShellExecutable = /(?:^|[\\/\s"';&|()<>])(?:bash|sh|zsh|dash)(?:\.exe)?(?=$|[\s"';&|()<>])/i.test(declaration);
  const ordinaryDirectCommand = /^[A-Za-z0-9_./:-]+(?:[ \t]+[-A-Za-z0-9_./:=+,%@]+)*$/.test(declaration);
  return {
    command,
    runtimeCwd,
    shellScript: {
      kind: ordinaryDirectCommand && !namesShellExecutable
        ? "none"
        : "outside_identity",
    },
  };
}

function declaredWholeCommandStaysHermetic(
  input: GuardInput,
  declaredCommand: DeclaredCommandMatch | undefined,
): boolean {
  return declaredCommand !== undefined
    && declaredCommand.shellScript.kind !== "outside_identity"
    && declaredCommandStaysHermetic(input.command ?? "", input, input.cwd);
}

/** Every declaration-derived profile admission consumes the one P-13 identity
 * match above. Classification can constrain it but cannot create safety. */
function declaredCommandAdmissionIsSafe(
  input: GuardInput,
  declaredCommand: DeclaredCommandMatch | undefined,
): boolean {
  return declaredWholeCommandStaysHermetic(input, declaredCommand)
    && outputsStayWithinFence(input.command ?? "", input)
    && gitleaksSeatIsBound(input.command ?? "", input, declaredCommand?.runtimeCwd);
}

function isHeredocDocumentWrite(segment: string): boolean {
  return /^cat\s+>(?!>)\s+(?:"[^"]+"|'[^']+'|\S+)\s+<<-?\s*(?:"[A-Za-z_][A-Za-z0-9_]*"|'[A-Za-z_][A-Za-z0-9_]*'|[A-Za-z_][A-Za-z0-9_]*|"")\s*$/i.test(segment);
}

/** A static command class grants only local inspection. Redirects and known
 * mutation tokens always remain outside this class, so their profile decision
 * continues to apply. The M1 heredoc document form is retained separately: its
 * body is data, not shell syntax, and it is already covered by its fixture. */
function isFencedChangeDirectory(segment: string, input: GuardInput): boolean {
  const match = /^cd\s+(.+?)\s*$/i.exec(segment);
  if (!match || !input.cwd) return false;
  const operand = match[1].trim();
  // Keep the accepted form intentionally small: `cd <path>` or a single
  // quoted path.  Flags have shell-specific semantics and multiple unquoted
  // tokens would make the actual destination ambiguous.
  if (operand.startsWith("-")) return false;
  const quoted = /^(['"])([\s\S]*)\1$/.exec(operand);
  if (!quoted && /\s/.test(operand)) return false;
  const rawPath = quoted ? quoted[2] : operand;
  // A shell expansion, home shortcut, or glob is resolved by the shell rather
  // than by the guard.  Do not grant the read-only exception when its eventual
  // directory cannot be proven from the dispatch fence.
  if (!rawPath || /[$`*?~]/.test(rawPath)) return false;
  const roots = input.fenceRoots ?? [];
  if (roots.length === 0) return false;
  const destination = resolve(input.cwd, rawPath);
  return roots.some((root) => {
    const fence = resolve(root);
    return destination === fence || destination.startsWith(fence + sep);
  });
}

// W-178: the write-form INDICATORS — which flags/operators write. Two consumers
// derive from ONE definition: hasWriteFormFlag (the read-only escape boolean) and
// writeFormTargets (the fence path extractor), so they can never disagree on WHICH
// forms write (`sort -bo` bundled evasion). W-178-fix: the ESCAPE is
// target-INDEPENDENT — stripQuotedProse (W-172) blanks a QUOTED target yet the
// operator/flag is a real write, so `grep x >> "/etc/x"` / `sort -bo "/etc/x"` must
// still escape read-only even though no target survives to extract. Only the fence
// extraction needs the resolvable path.
// W-178 rework#2 + N1: ONE operator CORE per write form, so the escape (presence
// test) and the extractor (core + capture group) can never disagree on WHICH forms
// write. The sort `-o` core had two hand-kept copies: the escape's trailing-char
// lookahead missed an ATTACHED filename starting with a letter (`sort -boC:\…` /
// `sort -bo$OUT`) that the extractor DID capture — escape=false → read-only allow, a
// regression. N1: the `>>` append and find write-predicate cores are shared the same
// way, and a superset corpus test pins hasWriteFormFlag ⊇ writeFormTargets so a
// future extractor-only edit can never leave the escape behind.
const WF_APPEND_CORE = String.raw`>>`;
// W-217 (G1): the `put`/`file`/`dir` suffix is now OPTIONAL — bare `--out
// <path>` (guardian_scan.ts's own report-output flag) previously matched
// NEITHER this write-form vocabulary NOR the fence extractor, so it rode the
// read-only escape unrecognized as a write at all: an out-of-fence `--out`
// target was invisible to `profile_path_fence`, and a legitimate IN-fence
// `--out` target could never earn the gate-verdict-write allow either (both
// paths require `mutationTargets` to see a target first). The trailing
// `(?=$|[\s=])` boundary WF_LONG_OUT already applies still rejects an
// unrelated `--outer-flag`.
const WF_LONG_OUT_CORE = String.raw`(?:^|\s)--out(?:put|file|dir)?`;
const WF_SORT_O_CORE = String.raw`(?:^|\s)-[bcdfghimnrsuz]*o`; // -o last in a sort short-flag cluster is ALWAYS the output flag
const WF_FIND_FILE_CORE = String.raw`(?:^|\s)-(?:fprintf|fprint0|fprint|fls)`; // -fprint*/-fls take a FILE
const WF_FIND_DELETE_CORE = String.raw`(?:^|\s)-delete\b`;                      // -delete targets the search roots
// W-179 (a): sed's `-i` / `--in-place` REWRITES the input file — a write, unlike an
// ordinary read-only `sed -n`/`sed 's///'`. `-i` consumes the REST of its token as
// an optional backup SUFFIX (`-i`, `-i.bak`, `-ibak`, `-i~`) and can be bundled
// (`-ni`), so ANY leading `-` short cluster CONTAINING `i` is in-place — no read-only
// sed flag (n/e/f/r/E/s/z/l/u) carries an `i`. W-179 Observer fix: the earlier form
// required `i` to be followed by end/space/.=digit and so FAIL-OPEN missed the
// attached-alpha suffix `-ibak` (an in-place write that rode the read-only allow on
// gate). No trailing constraint — the escape only ever runs when head === "sed".
const WF_SED_INPLACE_CORE = String.raw`(?:^|\s)-[a-z]*i|--in-place\b`;
// W-382 r2: cargo's PATH-valued flags. `cargo tree` / `cargo metadata` are query
// subcommands with no write mode of their own, but the resolver they run writes
// `Cargo.lock` FOR THE MANIFEST IT IS POINTED AT — so `--manifest-path` moves that
// write wherever the flag points, and `--target-dir` / `--out-dir` move build
// output. An earlier revision of the cargo read-only class asserted "cargo has no
// flag that redirects the lockfile elsewhere", which is wrong: `--manifest-path`
// is exactly that flag, and with an unconstrained flag tail
// `cargo tree --manifest-path <out-of-fence>/Cargo.toml` rode the read-only allow
// straight past the path fence. Sharing ONE core with hasWriteFormFlag and
// writeFormTargets is what keeps the escape and the fence from disagreeing,
// exactly as the `--output` family already does.
const WF_CARGO_PATH_CORE = String.raw`(?:^|\s)--(?:manifest-path|target-dir|out-dir)`;
// The escape tests presence: the long flag must END (so `--output-format` is not a
// write, a harmless FP the extractor already avoided); the sort `-o` needs NO
// trailing constraint (for sort the flag consumes the rest as the file).
const WF_APPEND = new RegExp(WF_APPEND_CORE);
const WF_LONG_OUT = new RegExp(WF_LONG_OUT_CORE + String.raw`(?=$|[\s=])`, "i");
const WF_SORT_O = new RegExp(WF_SORT_O_CORE, "i");
const WF_FIND_WRITE = new RegExp(`${WF_FIND_FILE_CORE}\\b|${WF_FIND_DELETE_CORE}`, "i");
const WF_SED_INPLACE = new RegExp(WF_SED_INPLACE_CORE, "i");
const WF_CARGO_PATH = new RegExp(WF_CARGO_PATH_CORE + String.raw`(?=$|[\s=])`, "i");

function writeFormHead(tokens: string[]): string {
  return (tokens[0] ?? "").replace(/^['"]|['"]$/g, "").replace(/^.*[\\/]/, "").toLowerCase();
}
function uniqOutputPositionals(tokens: string[]): string[] {
  // uniq IN OUT: the 2nd non-flag, non-numeric positional is the output file. A
  // blanked quoted target ("" after unquote) is still counted as present so the
  // escape fires even when the path is not extractable.
  return tokens.slice(1).map((t) => t.replace(/^['"]|['"]$/g, "")).filter((t) => !t.startsWith("-") && !/^\d+$/.test(t));
}

/** W-178-fix: does the segment carry a write-form operator/flag? Target-INDEPENDENT
 * (a blanked quoted target still leaves the real operator), so the read-only escape
 * never depends on extracting a path. Same indicator set as writeFormTargets. */
export function hasWriteFormFlag(segment: string, tokens: string[]): boolean {
  if (WF_APPEND.test(segment) || WF_LONG_OUT.test(segment)) return true;
  const head = writeFormHead(tokens);
  if (head === "sort" && WF_SORT_O.test(segment)) return true;
  if (head === "find" && WF_FIND_WRITE.test(segment)) return true;
  if (head === "uniq" && uniqOutputPositionals(tokens).length >= 2) return true;
  if (head === "sed" && WF_SED_INPLACE.test(segment)) return true;
  if (head === "cargo" && WF_CARGO_PATH.test(segment)) return true;
  return false;
}

/** W-178: the SHARED write-form vocabulary. ONE definition consumed by BOTH the
 * read-only escape (segmentEscapesReadOnly, via hasWriteFormFlag) and the fence
 * extractor (mutationTargets, via this), so editing one layer can never reopen a
 * hole in the other. Two hand-kept copies drifted and let `sort -bo /etc/x` (a
 * bundled short flag) slip past both anchors → gate auto-allow. Returns every write
 * / delete TARGET named by an append (`>>`), a long output flag (`--output/
 * --outfile/--outdir`), `sort -o` (incl. bundled `-bo` and attached `-oFILE`),
 * `uniq IN OUT`, or a find write-predicate (`-fprint*`/`-fls` FILE, `-delete`
 * roots). A blanked quoted target yields no extractable path here (the fence deny
 * then falls to profile_unknown) — the escape above still fires on the operator. */
export function writeFormTargets(segment: string, tokens: string[]): Array<{ path: string; operation: "write" | "delete" }> {
  const out: Array<{ path: string; operation: "write" | "delete" }> = [];
  const unq = (s: string): string => s.replace(/^['"]|['"]$/g, "");
  const push = (raw: string, operation: "write" | "delete"): void => {
    const path = unq(raw);
    if (path.trim() && !(operation === "write" && /^(?:\/dev\/null|NUL)$/i.test(path))) out.push({ path, operation });
  };
  for (const m of segment.matchAll(new RegExp(WF_APPEND_CORE + String.raw`\s*("[^"]*"|'[^']*'|[^\s&|]+)`, "g"))) push(m[1], "write");
  // W-178 rework#2: built from the SAME operator cores the escape uses, + a capture
  // group, so extractor and escape agree on WHICH forms write (only the extractor
  // needs the resolvable path).
  for (const m of segment.matchAll(new RegExp(WF_LONG_OUT_CORE + String.raw`(?:=|\s+)("[^"]*"|'[^']*'|[^\s&|]+)`, "gi"))) push(m[1], "write");
  const head = writeFormHead(tokens);
  // `sort -o FILE` writes, incl. bundled `-bo FILE` and attached `-oFILE`/`-boC:\…`;
  // grep/rg `-o` is only-matching, so this is scoped to sort.
  if (head === "sort") {
    const m = new RegExp(WF_SORT_O_CORE + String.raw`(?:=|\s*)("[^"]*"|'[^']*'|[^\s&|=]+)`, "i").exec(segment);
    if (m) push(m[1], "write");
  }
  if (head === "uniq") {
    const positionals = uniqOutputPositionals(tokens);
    if (positionals.length >= 2) push(positionals[1], "write"); // uniq IN OUT: 2nd positional is the output file
  }
  if (head === "find") {
    for (const m of segment.matchAll(new RegExp(WF_FIND_FILE_CORE + String.raw`\s+("[^"]*"|'[^']*'|[^\s&|]+)`, "gi"))) push(m[1], "write");
    if (new RegExp(WF_FIND_DELETE_CORE, "i").test(segment)) {
      const roots: string[] = [];
      for (const t of tokens.slice(1)) { if (t.startsWith("-")) break; roots.push(unq(t)); }
      for (const root of roots.length ? roots : ["."]) push(root, "delete");
    }
  }
  // W-179: `sed -i` rewrites its FILE operand(s) — extract them so path_fence denies
  // an out-of-fence in-place edit (`sed -ibak … /etc/passwd`) on a role seat's
  // in-fence band too, not only the read-only escape. The sed SCRIPT is NOT a file:
  // it is the `-e`/`--expression` / `-f`/`--file` argument, or (absent those) the
  // FIRST bare positional — skip exactly that one so an in-fence edit whose script
  // merely MENTIONS an out-of-fence path (`sed -i 's|/etc/hosts|x|' ./mine`) is not
  // false-denied. Every operand after the script is a real file to fence-check.
  // W-382 r2: cargo's path-valued flags, extracted from the SAME core the escape
  // uses, so `cargo tree --manifest-path <p>` is fence-checked at `<p>` instead of
  // riding the read-only allow. In-fence stays allowed (the gate seat's verdict
  // write / the role seat's in-fence band); out-of-fence denies.
  if (head === "cargo") {
    for (const m of segment.matchAll(new RegExp(WF_CARGO_PATH_CORE + String.raw`(?:=|\s+)("[^"]*"|'[^']*'|[^\s&|]+)`, "gi"))) push(m[1], "write");
  }
  if (head === "sed" && WF_SED_INPLACE.test(segment)) {
    const toks = tokens.map(unq);
    let scriptSeen = false;
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (t.startsWith("-")) {
        const name = t.replace(/^--?/, "").split("=")[0];
        // -e / -f / --expression / --file (and a bundled short cluster ending in e/f)
        // consume the NEXT token as the script; an `=`-attached long form does not.
        if (/^(?:e|f|expression|file)$/.test(name) || /^-[a-z]*[ef]$/.test(t)) {
          scriptSeen = true;
          if (!t.includes("=")) i++;
        }
        continue;
      }
      if (!scriptSeen) { scriptSeen = true; continue; } // the inline script (no -e/-f)
      push(t, "write");
    }
  }
  return out;
}

/** W-176 (B1-B4): a segment whose head matches a read-only inspection preset can
 * still EXECUTE a sub-command or NAME a write target — so it must never be vouched
 * read-only. Any of these drops it back to the profile + family rules (its exact
 * pre-W-176 path, where egress / path-fence / fail-closed-to-ask still apply).
 * Deliberately broad and fail-closed: a literal `$(` inside quotes or a redundant
 * flag only costs that one command a re-review, whereas a miss auto-allows
 * exfiltration or an out-of-fence write on the most-trusted (gate) seat. */
function segmentEscapesReadOnly(segment: string): boolean {
  const s = stripInertRedirects(segment);
  // B1 — a command substitution runs an arbitrary (possibly egressing) command:
  // `$(…)`, backtick, and process substitution `<(…)` / `>(…)` (O-1). All three
  // execute their inner command in this shell, so a read-only head cannot vouch
  // for them (`cat <(curl …)` egressed on gate before this).
  if (/\$\(|`|[<>]\(/.test(s)) return true;
  // B2 — find EXECUTION predicates run an arbitrary command (-exec/-execdir/-ok/
  // -okdir/-fput). The find WRITE predicates (-delete/-fprint*/-fls) name a fence
  // target and are shared with mutationTargets via writeFormTargets below.
  if (/(?:^|\s)-(?:exec(?:dir)?|ok(?:dir)?|fput)\b/i.test(s)) return true;
  // B2b (W-382 r2) — cargo's CONFIGURATION-injection flags. `--config` sets any
  // cargo config key for this invocation, including `build.rustc-wrapper` /
  // `target.*.runner` / `[source] replace-with`, i.e. it chooses a program to run
  // and a registry to fetch from; `-Z` opens unstable behavior wholesale. Neither
  // names a path, so there is nothing for the fence to check — the only correct
  // handling is that they never read as read-only. Same class as find's execution
  // predicates above, and deliberately NOT part of the cargo path-flag family
  // (that family is fence-checked; this one is refused outright).
  // r3: the `-Z` predicate is "the ARGUMENT STARTS WITH -Z", not "-Z is a whole
  // token". cargo takes the value attached (`-Zunstable-options`,
  // `-Zbuild-std=core`, `-Zscript`), so a token-boundary lookahead refused only
  // the detached spelling and let every attached one through — the same shape of
  // hole this bundle closed for `\b` in the presets, reintroduced one line later.
  // `--config` keeps its `(?=$|[\s=])` boundary: its value is never attached
  // without `=`, and a bare prefix match there would also catch `--config-file`
  // style flags that do not exist for cargo today but would be a silent widening
  // if they appeared.
  if (/(?:^|\s)cargo(?:\.exe)?(?:\s|$)/i.test(s) && /(?:^|\s)(?:--config(?=$|[\s=])|-Z)/i.test(s)) return true;
  // B3/B4 — an append (`>>`) or an output flag (`--output`/`sort -o`/`uniq IN OUT`/
  // find write-predicate) is a write. TARGET-INDEPENDENT (W-178-fix): a QUOTED
  // target is blanked by stripQuotedProse (W-172) yet the operator is real, so the
  // escape must fire on the operator's PRESENCE, never on extracting the path
  // (`grep x >> "/etc/x"` / `sort -bo "/etc/x"` regression). Same indicator set as
  // mutationTargets' writeFormTargets, so the two layers cannot disagree on which
  // forms write.
  const tokens = s.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) ?? [];
  const gitCollapsed = stripGitGlobalOpts(s).match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) ?? tokens;
  if (hasWriteFormFlag(s, gitCollapsed)) return true;
  return false;
}

/** W-382 (AC-2), r2: the env-assignment PREFIX names a read-only classification
 * may look past. A POSITIVE allowlist, not a deny family.
 *
 * `FOO=bar <cmd>` sets one variable for one command and executes nothing, so the
 * head still decides what runs — that is why `stripQuotedProse`'s own
 * `commandHead` already tolerates the prefix. But an environment variable is one
 * of the standard ways to change what a program DOES without changing its argv:
 * where it resolves its executable (`PATH`), which repository it reads
 * (`GIT_DIR`), and — the case an earlier deny-family revision of this constant
 * missed entirely — where it discovers its CONFIG (`HOME`, `XDG_CONFIG_HOME`,
 * `CARGO_HOME`, `RIPGREP_CONFIG_PATH`, `GIT_CONFIG_GLOBAL`, …), which for several
 * read-only heads is enough to make them run another program. A deny list cannot
 * be complete over that space: every name it lacks is silently allowed, which is
 * the enumeration failure this bundle refuses everywhere else.
 *
 * So the rule is inverted. A prefix is looked past only when its name is one of
 * these — variables that select TEST SELECTION or OUTPUT VERBOSITY and nothing
 * else. None of them can name a program, a repository, a config file, or a search
 * path. Any other name (known, or invented tomorrow) keeps the segment opaque:
 * the command is then judged with the prefix attached, does not match a
 * head-anchored preset, and falls to the profile rules — fail-closed.
 *
 * Adding a member requires that same one-line argument, here. */
const READ_ONLY_ENV_PREFIX_ALLOW: ReadonlySet<string> = new Set([
  "GARELIER_TEST_SCENARIO_FILTER", // selects which declared scenarios run; read by the driver's own tests
  "RUST_LOG",                      // log level only
  "RUST_BACKTRACE",                // panic verbosity only
  "NO_COLOR",                      // ANSI suppression only
  "FORCE_COLOR",                   // ANSI forcing only
  "CLICOLOR",                      // ANSI toggle only
  "CLICOLOR_FORCE",                // ANSI toggle only
  "TERM",                          // terminal capability name only
  "CI",                            // the "am I on CI" boolean test runners read
]);

/** Strip a leading run of `NAME=value` assignments, or return the segment
 * unchanged when any name is outside the allowlist above or any value carries a
 * substitution. The VALUE is checked for `$(`/backtick even though
 * `segmentEscapesReadOnly` also scans the whole segment, because the two callers
 * differ: the quality-gate preset path does not run that escape. */
function stripEnvAssignmentPrefix(segment: string): string {
  let rest = segment.trimStart();
  for (;;) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s]*)\s+(?=\S)/.exec(rest);
    if (!match) return rest;
    if (!READ_ONLY_ENV_PREFIX_ALLOW.has(match[1]!.toUpperCase())) return segment;
    if (/\$\(|`|[<>]\(/.test(match[2]!)) return segment;
    rest = rest.slice(match[0].length);
  }
}

function isReadOnlyInspectionCommand(
  segment: string,
  input: GuardInput,
  runtimeBase: string | undefined,
): boolean {
  // W-176 (B1-B4): a segment that executes a sub-command or names a write target
  // is never read-only, even when its head matches an inspection preset below.
  if (segmentEscapesReadOnly(segment)) return false;
  // W-153: collapse git's pre-subcommand global options with the SAME helper the
  // deny floor uses (stripGitGlobalOpts), so `git -C <dir> log` / `git -c k=v
  // status` normalize to `git log` / `git status` and are recognized by the
  // read-only inspection presets instead of falling to unknown (gate → deny,
  // baseline → ask — the 3× live ask-friction this row fixes). The collapse runs
  // BEFORE the MUTATION_HINT check, so a mutating subcommand behind the same
  // prefix (`git -C <dir> push`) still trips MUTATION_HINT (→ not read-only) and
  // is left to the deny floor; the strip never launders a mutation.
  const cleaned = stripGitGlobalOpts(stripInertRedirects(segment));
  // W-382 (AC-2): a per-command env prefix must not change the verdict — the
  // preset patterns are all head-anchored, so `FOO="x" bun test f.test.ts` matched
  // nothing and a gate seat could not run its own filtered test the way its own
  // runbook spells it, while the identical command without the prefix was allowed.
  const normalized = stripEnvAssignmentPrefix(normalizedCommand(cleaned));
  const nonMutating = !MUTATION_HINT.test(cleaned) || isHeredocDocumentWrite(normalized);
  if (!gitleaksSeatIsBound(normalized, input, runtimeBase)) return false;
  if (nonMutating && isFencedChangeDirectory(normalized, input)) return true;
  return nonMutating && READ_ONLY_INSPECTION_PRESETS.some(
    // `cd` is deliberately handled above: unlike inspection commands it
    // changes the shell context and therefore must stay within the dispatch
    // fence even when it appears in a read-only command chain.
    ({ id, pattern }) => id !== "change-directory" && new RegExp(pattern, "i").test(normalized),
  );
}

/** W-176: a `cd <literal path>` with no flags and no command substitution —
 * read-only-COMPATIBLE inside an otherwise all-read-only chain. Unlike
 * isFencedChangeDirectory it does NOT require the target to be in fence: a `cd`
 * followed only by read-only inspection cannot mutate anything, so the fence is
 * irrelevant. A command substitution (`cd $(…)` / backtick) EXECUTES a subcommand,
 * so it is excluded (not a plain cd). */
function isPlainChangeDirectory(segment: string): boolean {
  const s = stripInertRedirects(segment).trim();
  if (/^cd\s*$/i.test(s)) return true; // bare `cd` (home) — read-only
  const m = /^cd\s+(.+?)\s*$/i.exec(s);
  if (!m) return false;
  const operand = m[1].trim();
  if (operand.startsWith("-")) return false;      // flags → not a plain cd
  if (/\$\(|`/.test(operand)) return false;        // command substitution executes → not read-only
  const quoted = /^(['"])([\s\S]*)\1$/.exec(operand);
  if (!quoted && /\s/.test(operand)) return false; // multiple unquoted tokens → ambiguous
  return true;
}

/** W-519: one ARM of a `case`, i.e. `<pattern>) <inner>` (or a bare `<pattern>)`
 * when the arm's body was split off). The LABEL is a glob pattern — data the
 * shell matches, never executes — so the arm is read-only exactly when its inner
 * command is, which is decided by the same three predicates the rest of a chain
 * uses. FAIL-CLOSED in both directions: a label containing a command
 * substitution runs code before any match happens, and a label containing a
 * parenthesis is not a shape this recognizes, so both return false and the
 * compound drops to the profile rules. `a) rm -rf x` is false because `rm -rf x`
 * is, and a `case` whose arms include one non-read-only command therefore still
 * cannot read as read-only. */
function isReadOnlyCaseArm(
  segment: string,
  input: GuardInput,
  runtimeBase: string | undefined,
): boolean {
  const text = segment.trim();
  // W-519 r2 (fail-open closed): the earlier shape accepted an OPTIONAL leading
  // `(`, which is bash's `(pattern)` arm spelling — but after `;`/`&&` splitting a
  // SUBSHELL is byte-identical to it. `(rm -rf y)` parsed as label `rm -rf y` with
  // an empty body and returned TRUE, so a subshell running anything read as a
  // read-only case arm with nothing left to check. The leading `(` form is dropped
  // entirely: the plain `pattern)` spelling is what `;;` splitting produces, and
  // refusing the ambiguous one costs a `case` written with `(a)` a re-review, while
  // the alternative auto-allowed arbitrary code.
  const match = /^([^()]+?)\s*\)\s*([\s\S]*)$/.exec(text);
  if (!match) return false;
  const label = match[1]!.trim();
  if (label === "" || /\$\(|`|[<>]\(/.test(label)) return false;
  // r3 (regression closed): the LABEL must be a case PATTERN, not a command.
  // A bash case pattern is a single word, or `|`-separated words — it never
  // contains unquoted whitespace. Without this, a label-only segment such as
  // `rm -rf /tmp/zzz)` parsed as "label = rm -rf /tmp/zzz, body empty" and an
  // empty body reads as read-only, so a command that base DENIED became
  // allow/read_only. Counting parentheses cannot separate the two — a genuine
  // arm (`a) rg --version`) has exactly the same one-unmatched-`)` shape — so the
  // predicate has to be on what a pattern may look like.
  if (!/^[^\s()]+(?:\s*\|\s*[^\s()]+)*$/.test(label)) return false;
  const inner = match[2]!.replace(/;;\s*$/, "").trim();
  // Unbalanced parentheses in the body mean this segment is a FRAGMENT of a larger
  // shell construct that the separator split apart, so what it will actually run
  // cannot be decided from the fragment alone. Fail closed rather than judge half
  // a command.
  if ((inner.match(/\(/g) ?? []).length !== (inner.match(/\)/g) ?? []).length) return false;
  // r4 (the pattern predicate was not enough on its own): a BODY must follow.
  // The label rule alone still vouched for `rm)`, `sh)`, `bash)`, `poweroff)`,
  // `npm)` and `x) > /etc/passwd` — every one of those is a single token, so it
  // satisfies "a pattern is one word", and an EMPTY body then read as
  // "executes nothing". That is only true if the segment really is a case arm;
  // for a fragment the separator produced it is an assumption, and it flipped
  // four `profile_path_fence` denies from base into allow. The arm form this
  // predicate exists for is `pattern) <command>`, so a bare `pattern)` — whether
  // it stands alone or ends the segment — is refused. An arm genuinely written
  // with an empty body (`*) ;;`) costs one re-review; the alternative vouched for
  // whatever the fragment turned out to be.
  if (inner === "") return false;
  return isReadOnlyInspectionCommand(inner, input, runtimeBase)
    || isPlainChangeDirectory(inner)
    || isReadOnlyControlSegment(inner, input, runtimeBase);
}

/** W-179 (a): a shell CONTROL-STRUCTURE segment that is read-only-COMPATIBLE. When a
 * compound (`if …; then …; fi` / `for f in *; do …; done`) is split on `;`/`|`/`&&`,
 * its control keywords land as their own segments (`if grep …`, `then head …`,
 * `for f in *`, `do tail …`, `done`). A bare closer/keyword executes nothing; a
 * keyword FOLLOWED by an inner command is read-only iff that inner command is
 * (recurse); a `for X in LIST` header is read-only iff the LIST executes nothing (no
 * command substitution / process sub — those would run arbitrary code). Anything
 * else → false (FAIL-CLOSED: the compound then drops to the profile/family rules, so
 * a `do rm x` / `for f in $(curl …)` / `if curl … | sh` never reads as read-only). */
function isReadOnlyControlSegment(
  segment: string,
  input: GuardInput,
  runtimeBase: string | undefined,
): boolean {
  const s = stripInertRedirects(segment).trim();
  // Bare keyword / block delimiter — binds a loop var or closes a block; no command.
  if (/^(?:then|else|do|done|fi|esac|in|\{|\})$/i.test(s)) return true;
  // `for X in LIST` / `select X in LIST`: the LIST is data (globs/literals). A
  // command substitution / process sub in it EXECUTES arbitrary code — exclude it.
  const forHead = /^(?:for|select)\s+\w+\s+in\b(.*)$/i.exec(s);
  if (forHead) return !/\$\(|`|[<>]\(/.test(forHead[1]);
  if (/^(?:for|select)\s+\w+\s*$/i.test(s)) return true; // `for f` (the `in …` on the next line)
  // `case X in` header: X is data; exclude command substitution.
  //
  // W-519: the header rarely arrives ALONE. `splitSegments` cuts on `;`, and a
  // one-line case ends every arm with `;;`, so the real segments of
  // `case x in a) rg --version ;; *) rg --version ;; esac` are
  // `case x in a) rg --version`, `*) rg --version` and `esac` — the header
  // carries the FIRST arm, and the later arms arrive as bare arms. Only the
  // `esac` matched anything before, so an all-read-only `case` chain was denied
  // on the gate seat while the identical `if …; then …; fi` chain was allowed.
  // (The named cause in the row — the peel rule `[^)]*\)` — was removed with the
  // W-431 identity pivot; this is the site the symptom actually lives at now.)
  const caseHead = /^case\s+([\s\S]+?)\s+in(?=\s|$)([\s\S]*)$/i.exec(s);
  if (caseHead) {
    // The selector is data (a word or a parameter expansion). A command
    // substitution in it RUNS something, so it can never be vouched read-only —
    // the same exclusion the `for X in LIST` header above applies.
    if (/\$\(|`|[<>]\(/.test(caseHead[1]!)) return false;
    const firstArm = caseHead[2]!.trim();
    return firstArm === "" || isReadOnlyCaseArm(firstArm, input, runtimeBase);
  }
  if (isReadOnlyCaseArm(s, input, runtimeBase)) return true;
  // A keyword wrapping an inner command: the inner must itself be read-only.
  const kwInner = /^(?:if|elif|while|until|then|else|do)\s+(.+)$/i.exec(s);
  if (kwInner) {
    const inner = kwInner[1].trim();
    return isReadOnlyInspectionCommand(inner, input, runtimeBase) || isPlainChangeDirectory(inner)
      || isReadOnlyControlSegment(inner, input, runtimeBase);
  }
  return false;
}

function profileChain(name: PermissionProfileName): PermissionProfileName[] {
  const out: PermissionProfileName[] = [];
  let cur: PermissionProfileName | undefined = name;
  while (cur && !out.includes(cur)) { out.unshift(cur); cur = PERMISSION_PROFILES[cur].extends; }
  return out;
}

function mutationTargets(segment: string): Array<{ path: string; operation: "create" | "write" | "delete" }> {
  const out: Array<{ path: string; operation: "create" | "write" | "delete" }> = [];
  const tokens = segment.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g)?.map((t) => t.replace(/^['"]|['"]$/g, "")) ?? [];
  const commandAt = tokens.findIndex((t) => new RegExp(`^(?:${MUTATION_VERBS})$`, "i").test(t));
  if (commandAt >= 0) {
    const cmd = tokens[commandAt].toLowerCase();
    const args = tokens.slice(commandAt + 1).filter((t) => !t.startsWith("-") && !/^\/[A-Za-z]+$/.test(t));
    const op = /^(?:rm|del|rd|rmdir|remove-item)$/.test(cmd) ? "delete" : /^(?:mkdir|touch|new-item)$/.test(cmd) ? "create" : "write";
    const selected = /^(?:mv|move|move-item|cp|copy|copy-item)$/.test(cmd) ? args.slice(-1) : args;
    for (const path of selected) if (path.trim()) out.push({ path, operation: op });
  }
  const redirect = /(?<!>)>(?!>)\s*("[^"]*"|'[^']*'|[^\s&|]+)/g;
  for (const m of segment.matchAll(redirect)) {
    const path = m[1].replace(/^['"]|['"]$/g, "");
    if (!path.trim() || /^(?:\/dev\/null|NUL)$/i.test(path)) continue; // empty target = no target; inert redirect = not a file write
    out.push({ path, operation: "write" });
  }
  // W-177/W-178: write-form flags name a write target the MUTATION_VERBS / lone-`>`
  // scan misses (`sort -o /x` / `--output=/x` / `x >> /y` / `find /x -delete` /
  // `uniq in /x`), so profile_path_fence can catch an out-of-fence one on a role
  // seat. The extraction is the SHARED writeFormTargets — the same vocabulary the
  // read-only escape uses — so the two layers can never drift (the `sort -bo`
  // bundled-flag hole came from two hand-kept copies).
  out.push(...writeFormTargets(segment, tokens));
  return out;
}

function profileDecisions(
  input: GuardInput,
  gitContexts?: GitInvocationContext[],
  declaredCommand?: DeclaredCommandMatch,
): Decision[] {
  if (!input.profile) return [];
  const decisions: Decision[] = [];
  const policy = input.policy ?? DEFAULT_POLICY;
  const profile = PERMISSION_PROFILES[input.profile];
  // W-150: match deny rules against the git-normalized form so a `git -C <path>`
  // (or `-c k=v`) prefix cannot smuggle a denied subcommand past a profile floor.
  const denyClassified = gitContexts
    ? gitContexts.map((context) => context.normalized).join(";")
    : classificationForDeny(input.command);
  for (const name of profileChain(input.profile)) {
    for (const rule of PERMISSION_PROFILES[name].deny) {
      if (new RegExp(rule.pattern, "i").test(denyClassified)) {
        decisions.push({ action: "deny", rule: `profile_${rule.id}`, reason: `${rule.reason}. ${ESCALATE}` });
      }
    }
  }
  const segments = splitSegments(input.command);
  const hasDeclaredCommand = declaredCommand !== undefined;
  const fenceRoots = input.fenceRoots ?? [];
  const classified = classificationCommand(input.command);
  // Resolve each segment's relative mutation targets against its own preceding
  // `cd` (or the dispatch fence anchor), not the hook's session cwd — a leaked
  // cross-dispatch cwd otherwise pushes a worker's own-worktree target outside
  // the fence and false-denies it (W-119, #348), and a trailing `cd` must not
  // launder an earlier out-of-fence write (W-119 R1).
  const bases = segmentBases(segments, ownWorktreeRoots(input));
  const runtimeBases = commandRuntimeBases(segments, input.cwd);
  // W-164: the per-segment path fence is the `profile_path_fence` family, gated
  // by its own flag (default off = passthrough). The profile deny table and the
  // fail-closed `profile_unknown` band below are NOT family-gated (they are the
  // dispatch-seat core, not one of the named W-164 families).
  // W-177: gate on mutationTargets itself, not the coarser MUTATION_HINT — the
  // write-form flags it now models (`sort -o`, `--output`, `>>`, find `-delete`)
  // carry no MUTATION_HINT token, so the old pre-filter skipped the fence check and
  // a role seat's out-of-fence write rode the W-122 in-fence band. Empty-target
  // segments make the inner loop a no-op, so the per-segment scan is the filter.
  if (policy.path_fence_guard_enabled && fenceRoots.length) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const resolveBase = bases[i] ?? input.cwd;
      for (const target of mutationTargets(seg)) {
        // W-178 rework#2: a write target carrying an unexpanded shell expansion
        // (`$VAR` / `$(…)` / backtick) cannot be proven in-fence — it could resolve
        // anywhere at runtime — so it is treated as out-of-fence, not a safe in-fence
        // (or gate-verdict) write (`sort -bo$OUT`).
        if (/[$`]/.test(target.path)) {
          decisions.push({ action: "deny", rule: "profile_path_fence", reason: `write target '${target.path}' contains an unexpanded shell expansion and cannot be fence-verified. ${ESCALATE}` });
          continue;
        }
        try {
          assertPathMutation(target.path, target.operation, { cwd: resolveBase, fenceRoots });
        } catch (error) {
          decisions.push({ action: "deny", rule: "profile_path_fence", reason: `${String(error)}. ${ESCALATE}` });
        }
      }
    }
  }
  // W-179 (d3): the PM-grown per-profile deny/ask/allow pattern lists — the learning
  // loop, evaluated INSIDE the profile judgment (no new layer). Consulted across the
  // profile chain (a rule on `baseline-destructive` covers every seat; a rule on
  // `role` only roles). Matched against the SAME git-normalized, prose-stripped
  // form as the profile deny table (denyClassified), so a `git -C <path>` prefix or
  // quoted prose cannot launder a project deny. A `deny` match adds a hard block; an
  // `ask` a pause; an `allow` records the PM's learning-loop escape (finalizeDecision
  // in evaluate() relaxes the fail-closed unknown band and asks on it, but NEVER a
  // family/profile deny — strictest-wins keeps deny 先勝ち).
  for (const name of profileChain(input.profile)) {
    const rules = policy.profile_rules?.[name];
    if (!rules) continue;
    if (matchesAnyPattern(rules.deny, denyClassified)) {
      decisions.push({ action: "deny", rule: "project_deny", reason: `Command matches a project deny pattern for profile '${name}'. ${ESCALATE}` });
    }
    if (matchesAnyPattern(rules.ask, denyClassified)) {
      decisions.push({ action: "ask", rule: "project_ask", reason: `Command matches a project ask pattern for profile '${name}'; confirm it is intended and in-scope. ${ESCALATE}` });
    }
    if (!hasDeclaredCommand && matchesAnyPattern(rules.allow, denyClassified)) {
      decisions.push({ action: "allow", rule: "project_allow", reason: "" });
    }
  }
  if (decisions.length === 0) {
    // W-159/P-13: a declaration-identity match is safe only through the shared
    // predicate above. Independently read-only / preset / cd / control segments
    // remain the non-declaration alternative and never read qualityGateCommands.
    const declaredAdmissionSafe = declaredCommandAdmissionIsSafe(input, declaredCommand);
    const safe = declaredAdmissionSafe || (segments.length > 0 && segments.every(
      (seg, index) => isReadOnlyInspectionCommand(seg, input, runtimeBases[index])
        || qualityGateSegmentIsAllowed(seg, input, runtimeBases[index])
        || isPlainChangeDirectory(seg) || isReadOnlyControlSegment(seg, input, runtimeBases[index]),
    ));
    // W-181: a gate seat's write is a legitimate VERDICT write only when EVERY
    // target lands IN-fence. The old check treated ANY mutation as a verdict write,
    // so an out-of-fence append (`grep x >> /etc/y`), tee (`… | tee /etc/y`), or
    // plain write on the gate seat rode this suppression and was ALLOWED whenever
    // the role-oriented `path_fence` family flag was off — the shipped default
    // (실측: gate seat out-of-fence append/tee auto-allow). Gate read-only-ness is
    // core (like the gate_mutation deny), NOT an opt-in family, so enforce the fence
    // here UNCONDITIONALLY, reusing the SAME per-segment write-form target extraction
    // (mutationTargets → writeFormTargets: `>>`, tee, sort -o, sed -i, …) and the
    // SAME assertPathMutation the path_fence family uses. A target with an
    // unverifiable expansion (`$VAR`/`$(…)`/backtick) can resolve anywhere, so it is
    // never provable in-fence. Any out-of-fence target drops gateVerdictWrite to
    // false → the command falls to the fail-closed `profile_unknown` (deny) below.
    const gateWrites = input.profile === "gate"
      ? segments.flatMap((seg, i) => mutationTargets(seg).map((target) => ({ target, base: bases[i] ?? input.cwd })))
      : [];
    const gateVerdictWrite = input.profile === "gate" && fenceRoots.length > 0 && gateWrites.length > 0
      && gateWrites.every(({ target, base }) => {
        if (/[$`]/.test(target.path)) return false;
        try { assertPathMutation(target.path, target.operation, { cwd: base, fenceRoots }); return true; }
        catch { return false; }
      });
    if (!safe && !gateVerdictWrite) {
      // W-122: reaching here means no deny/ask class matched above (profile deny
      // rules + the per-segment path fence) and the command is neither a
      // read-only inspection nor a quality-gate run. With a trusted fence
      // resolved, a profile that opts in (`profile.unknown_action`) may take that
      // relaxed action instead of failing closed — the in-fence band the user's
      // risk model tolerates. Without a fence, or for a profile with no
      // relaxation, keep the fail-closed `unknown`. This is an ALLOW/ASK
      // decision only; the global egress/delete/secret/force classes in
      // evaluate() still run afterward and each outranks it under strictest-wins,
      // so unknown-allow can never weaken the deny floor.
      const fenced = fenceRoots.length > 0;
      const action: Action = fenced && profile.unknown_action ? profile.unknown_action : profile.unknown;
      // W-187: when the fail-closed deny is because a named seat resolved no record
      // from this cwd, the deny is very likely the cwd-mismatch class — append the
      // diagnostic so the operator does not re-run the 45-minute investigation.
      const cwdHint = action !== "allow" && input.seatRecordUnresolved
        ? cwdRecordHint(input.agentName ?? "", input.cwd ?? "")
        : "";
      // W-575/W-545 (GF-12): a fail-closed deny must say WHERE the seat's
      // position came from. The profile and the fence both derive from it, and
      // "profile 'gate' denied this" reads identically whether the command is
      // genuinely out of scope or whether the position resolved from an ambient
      // session cwd instead of the seat's own record. Reporting only; nothing is
      // widened, and no automatic re-resolution is attempted.
      const originHint = action !== "allow" ? positionOriginHint(input) : "";
      // W-382 (AC-3): a bare scanner binary stays DENIED — the canonical argv is
      // the only gitleaks spelling any seat is authorized for — but the refusal
      // now names the route that does work instead of leaving the seat to guess.
      const scannerHint = action !== "allow" && /\bgitleaks(?:\.exe)?\b/i.test(classified)
        ? " 経路 (W-382): 素の `gitleaks` 起動は認可されない。gate 席の scanner 経路は"
          + " `bun <path>/guardian_scan.ts …` (availability probe は `--probe-gitleaks`)、"
          + " 直接起動が要る場合は W-297 の canonical argv"
          + " (`gitleaks dir . --no-banner --redact --report-format json --report-path -`) のみ。"
        : "";
      decisions.push({
        action,
        rule: "profile_unknown",
        reason: action === "allow"
          ? `No deny/ask class matched and every in-command mutation target is within the trusted fence; profile '${input.profile}' allows unknown in-fence commands (W-122).`
          : `Command does not match an allow pattern for profile '${input.profile}'; failing closed to ${action}. ${ESCALATE}${originHint}${scannerHint}${cwdHint}`,
      });
    }
  }
  return decisions;
}

// --- core evaluation -------------------------------------------------------

function roleResidentStartDecision(input: GuardInput): Decision | null {
  if (!input.dispatchRecordBacked || input.profile !== "role") return null;
  const command = classificationCommand(input.command ?? "");
  const expanded = splitShellSegments(withoutHeredocBodies(input.command ?? ""))
    .map((segment) => normalizedToolInvocations(segment));
  const invocations = expanded.flatMap(({ invocations }) => invocations);
  const opaqueResidentStart = expanded.some(({ invocations, opaqueWrapper }) => opaqueWrapper
    && invocations.some((invocation) => {
      const executable = /(?:^|[\s"'\\/])sccache(?:\.exe)?(?=$|[\s"'])/i.exec(invocation);
      return executable !== null && /--start-server(?=$|[\s"'])/i.test(invocation.slice(executable.index));
    }));
  const startsResident = opaqueResidentStart || invocations.some((invocation) =>
    /^sccache(?:\s|$)[\s\S]*--start-server(?:\s|$)/i.test(invocation)
    || /^(?:(?:bun|node|deno|tsx)\s+)?(?:[^\s]*[\\/])?status_web_cli\.ts(?:\s|$)[\s\S]*\bstart\b/i.test(invocation)
    || /^(?:(?:bun|node|deno|tsx)\s+)?(?:[^\s]*[\\/])?status_web\.ts(?:\s|$)/i.test(invocation)
    || /^(?:(?:bun|node|deno|tsx)\s+)?(?:[^\s]*[\\/])?fleet_watch\.ts(?:\s|$)/i.test(invocation)
    || /^(?:(?:bun|node|deno|tsx)\s+)?(?:[^\s]*[\\/])?long_job_runner\.ts(?:\s|$)[\s\S]*\bbroker\b/i.test(invocation)
  );
  const wrapperCanFallBackToUserConfig =
    /\bunset\s+RUSTC(?:_WORKSPACE)?_WRAPPER\b/i.test(command)
    || /\benv\b[\s\S]*\s-u\s+RUSTC(?:_WORKSPACE)?_WRAPPER\b/i.test(command)
    || /\bRemove-Item\b[\s\S]*\bEnv:RUSTC(?:_WORKSPACE)?_WRAPPER\b/i.test(command);
  const enablesSharedWrapper =
    /\bRUSTC(?:_WORKSPACE)?_WRAPPER\s*=\s*["']?sccache(?:\.exe)?\b/i.test(command)
    || /\$env:RUSTC(?:_WORKSPACE)?_WRAPPER\s*=\s*["']sccache(?:\.exe)?["']/i.test(command);
  if (!startsResident && !wrapperCanFallBackToUserConfig && !enablesSharedWrapper) return null;
  return {
    action: "deny",
    rule: "role_resident_start",
    reason: "A dispatch-record-backed role cannot start a shared resident process or re-enable/fall back to a shared rustc wrapper. Use the role no-daemon environment and the operator-owned lifecycle.",
  };
}

export function evaluate(
  input: GuardInput,
  lifecycle: DispatchContainerLifecycle = DISPATCH_CONTAINER_LIFECYCLE,
): Decision {
  return evaluateCommand(input, lifecycle);
}

function evaluateCommand(input: GuardInput, lifecycle: DispatchContainerLifecycle): Decision {
  const policy = input.policy ?? DEFAULT_POLICY;
  const command = input.command ?? "";
  // W-431 r8: declaration identity starts from the raw command bytes. The only
  // permitted normalization is normalizedCommand's whitespace collapse; no
  // heredoc/body removal or wrapper expansion may run before the exact match.
  // Direct Bash scripts additionally require tracked/HEAD-blob identity.
  // Ordinary direct scanners use the same command-identity predicate; options,
  // wrappers, delegation, heredocs, and substitutions fail closed even when
  // their full text was listed.
  const declaredCommand = matchingDeclaredCommand(input);
  let declaredScriptIdentityVerified = false;
  const declaredUses = declaredCommand ? [declaredCommand] : [];
  for (const use of declaredUses) {
    if (use.shellScript.kind === "outside_identity") {
      return { action: "deny", rule: "tool_install_update", reason: "This declared command shape cannot establish execution identity." };
    }
    if (use.shellScript.kind !== "identity") continue;
    const verified = input.shellScriptProbe?.(use.shellScript.value, use.runtimeCwd) ?? false;
    if (!verified) {
      return { action: "deny", rule: "tool_install_update", reason: "Declared Bash script is not a tracked, HEAD-identical file in the command's runtime worktree." };
    }
    declaredScriptIdentityVerified = true;
  }
  const installSegments = splitShellSegments(withoutHeredocBodies(command));
  let expanded = installSegments.map((segment) => normalizedToolInvocations(segment));
  if (declaredScriptIdentityVerified && expanded.length > 0) {
    // The one P-13 match proves the complete execution shape. For the cwd-safe
    // spelling this includes the leading cd plus the direct Bash declaration,
    // so no segment may independently reclassify that verified Bash command as
    // an opaque wrapper.
    //
    // W-439: "the cwd-safe spelling" is exactly `cd "<seat worktree>" && <decl>`
    // with the operand QUOTED — that is the only leading-cd form
    // matchingDeclaredCommand accepts. An UNQUOTED `cd <path> && <decl>` is
    // deliberately refused as `outside_identity`, and the earlier wording of this
    // comment (which said only "includes the leading cd") read as if any leading
    // cd qualified; a reader measuring the unquoted form concluded the comment
    // contradicted the code. It does not — the producers already print the quoted
    // form (`attended_seat.ts` quality_gate_commands_cwd_safe), and the seat is
    // told to run the printed bytes verbatim.
    expanded = expanded.map((invocation) => ({ ...invocation, opaqueWrapper: false }));
  }
  if (policy.install_guard_enabled) {
    const classified = classificationCommand(command);
    const invocations = expanded.flatMap(({ invocations }) => invocations);
    if (RE.pipeToShell.test(classified)) {
      return { action: "deny", rule: "pipe_to_shell", reason: "Comprehensive install guard blocks pipe-to-shell execution for every seat." };
    }
    if (invocations.some((invocation) => RE.toolInstallUpdate.test(invocation) || RE.installerAcquisition.test(invocation))) {
      return { action: "deny", rule: "tool_install_update", reason: "Comprehensive install guard blocks install, update, upgrade, and executable-tool download commands for every seat." };
    }
    // W-164: `comprehensiveInstallRun` matches bare `\bnpx\b`, which subsumes
    // every form the deleted `npxRemote` regex matched — so the old
    // `|| RE.npxRemote.test(...)` operand was dead weight and is dropped (Observer
    // Note 4). Zero behavior change here.
    if (invocations.some((invocation) => RE.comprehensiveInstallRun.test(invocation))) {
      return { action: "deny", rule: "install_run", reason: "Comprehensive install guard blocks install-run tools for every seat." };
    }
    if (expanded.some(({ opaqueWrapper }) => opaqueWrapper)) {
      return { action: "deny", rule: "tool_install_update", reason: "Comprehensive install guard cannot statically inspect this shell wrapper and fails closed for every seat." };
    }
  }
  const residentStart = roleResidentStartDecision(input);
  if (residentStart) return residentStart;
  if (!policy.enabled && declaredUses.length === 0) return { action: "allow", rule: "disabled", reason: "" };

  const classified = classificationCommand(command);
  // W-305: evaluate consumes the already-resolved permission profile, never the
  // ambient role string. The hook entrypoint additionally refuses to derive the
  // Concierge profile from role fallback alone (resolveRuntimeProfile below).
  const isConcierge = input.profile === "concierge";
  // Own-worktree fence for the destructive rules, derived without the hook's
  // session cwd (W-119). Each segment resolves relative targets against its own
  // preceding `cd` (segmentBases), so a trailing `cd` cannot launder an earlier
  // out-of-fence delete (W-119 R1).
  const fenceRoots = ownWorktreeRoots(input);
  const segments = splitSegments(command);
  const cdBases = segmentCdBases(segments);
  const bases = segmentBases(segments, fenceRoots);
  const runtimeBases = commandRuntimeBases(segments, input.cwd);
  // W-312: one stateful parse feeds BOTH classification and probes. Selector
  // mutations in an earlier shell segment taint every later Git invocation.
  const gitContexts = gitInvocationContexts(
    command,
    segments,
    cdBases.map((base) => base ?? input.cwd),
    input.gitEnvironmentContext,
  );

  // W-176 (0): a WHOLLY read-only command is ALLOWED on EVERY profile — no ask,
  // never fail-closed. A read-only inspection (grep/rg/git log·show·diff/ls/cat/…
  // + build/test presets) mutates nothing and reaches no remote, so it needs no
  // approval regardless of seat (baseline-destructive / gate included). A compound
  // is read-only when EVERY segment is a read-only inspection or a plain `cd`
  // (even out of fence — a cd followed only by read-only cannot mutate). A single
  // non-read-only segment (`… | sh`, `curl -X POST`, `rm`, `git push`) breaks this
  // and the command falls through to the profile + family rules below, where the
  // fail-closed-to-ask still guards a command that CANNOT be proven read-only.
  if (declaredUses.length === 0 && segments.length > 0 && segments.every((seg, index) =>
    isReadOnlyInspectionCommand(seg, input, runtimeBases[index])
    || isPlainChangeDirectory(seg)
    || isReadOnlyControlSegment(seg, input, runtimeBases[index]))) {
    return { action: "allow", rule: "read_only", reason: "" };
  }

  const decisions: Decision[] = [];

  decisions.push(...profileDecisions(input, gitContexts, declaredCommand));

  // Rule 1 — pipe-to-shell (checked on the whole command; the pipe matters).
  // W-164: gated by the per-family flag (default off = passthrough).
  if (policy.pipe_to_shell_guard_enabled && RE.pipeToShell.test(classified)) {
    decisions.push({
      action: withAction(policy, "pipe_to_shell", "deny"),
      rule: "pipe_to_shell",
      reason: `Piping downloaded content straight into a shell runs unreviewed remote code (install-and-run). ${ESCALATE}`,
    });
  }

  // Rule 1b — process kill (W-170), checked on the whole command since a kill
  // pipeline spans `|` stages. Per-family opt-in (default off = passthrough).
  if (policy.process_kill_guard_enabled) {
    const pk = processKillDecision(classified, input, policy);
    if (pk) decisions.push(pk);
  }

  // Rule 1c — attended-seat control commit on a lane branch (W-267). Whole-command
  // like 1b: it inspects each `git commit` segment against that repo's live git
  // facts. Per-family opt-in (default off = passthrough).
  {
    const misplace = controlMisplaceDecision(gitContexts, input, policy);
    if (misplace) decisions.push(misplace);
  }

  // Rule 1d — hand-merging a lane branch into the integration branch, bypassing
  // the merge gate (W-318). Whole-command like 1b/1c; per-family opt-in.
  {
    const bypass = mergeGateBypassDecision(gitContexts, input, policy);
    if (bypass) decisions.push(bypass);
  }
  {
    const indexMutation = mergeGateIndexMutationDecision(gitContexts, input);
    if (indexMutation) decisions.push(indexMutation);
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segBase = bases[i];
    // W-150: the git rules below match against the git-normalized segment so a
    // `git -C <path>` / `-c <k=v>` prefix cannot hide the subcommand from the
    // egress / force / destructive deny floor.
    const gitContext = gitContexts[i]!;
    const gitSeg = gitContext.normalized;
    // Rule 2 — network egress / off-list GET. W-164: gated by the per-family
    // flag (covers both network_egress and network_offlist; default off).
    if (policy.network_egress_guard_enabled && RE.netTool.test(seg)) {
      if (RE.uploadFlags.test(seg)) {
        decisions.push({
          action: withAction(policy, "network_egress", "deny"),
          rule: "network_egress",
          reason: `Outbound request carries data (upload / POST / PUT / PATCH). ${ESCALATE_EGRESS}`,
        });
      } else {
        const hosts = extractHosts(seg);
        const offlist = hosts.filter((h) => !hostAllowed(h, policy.network_allow_domains));
        if (hosts.length === 0 || offlist.length > 0) {
          const where = hosts.length === 0 ? "an unverified host" : offlist.join(", ");
          decisions.push({
            action: withAction(policy, "network_offlist", "deny"),
            rule: "network_offlist",
            reason: `Network fetch to ${where} is not on the allow-list. ${ESCALATE_EGRESS}`,
          });
        }
      }
    }

    // Rule 2b — git egress (W-058): push / fetch / pull / remote-write reach a
    // remote and so leave the local sandbox. Non-Concierge seats are denied.
    // Concierge is NOT exempted wholesale: only explicit promote-shaped git
    // operations pass conciergeGitEgressDecision. Generic curl/wget egress stays
    // under Rule 2, push destinations must be explicit, and remote mutation is
    // limited to an existing URL or a dispatch-fenced local repository.
    if (
      policy.git_egress_guard_enabled &&
      (RE.gitPushAny.test(gitSeg) || RE.gitFetchPull.test(gitSeg) || RE.gitRemoteWrite.test(gitSeg))
    ) {
      if (isConcierge) {
        const scoped = conciergeGitEgressDecision(input, gitContext);
        if (scoped) decisions.push(scoped);
      } else {
        decisions.push({
          action: withAction(policy, "git_egress", "deny"),
          rule: "git_egress",
          reason: `Reaching a remote with git (push / fetch / pull / remote add|set-url) is an external send. ${ESCALATE_EGRESS}`,
        });
      }
    }

    // Rule 3 — remote-package immediate execution (W-163): deny the
    // fetch-an-external-package-and-run-it family (bunx / uvx / npx <pkg> / pipx
    // run / pnpm dlx / `uv run --with` / `deno run <remote url>`). This is a
    // PER-FAMILY OPT-IN family: it fires only when `remote_exec_guard_enabled`
    // is on (default false, framework ships it off = passthrough; a project such
    // as the target project / garelier turns it on). Same config path and default-off shape
    // as the install/update/download floor `install_guard_enabled` (W-160); the
    // two are independent family flags, unified with the rest by W-164 (per-family
    // enable + PM-readable deny/ask report). npx is unified into the family (no
    // separate special case). Local script runners that fetch nothing (`bun run`,
    // `npm run`, `bunx ./x.ts`, `npx ./x.js`, `uv run x.py`, `deno run ./x.ts`)
    // never match, so enabling the flag does not disturb them. A specific package
    // stays individually allowable via actions.remote_package_exec.
    if (policy.remote_exec_guard_enabled && RE.remotePackageExec.test(seg)) {
      decisions.push({
        action: withAction(policy, "remote_package_exec", "deny"),
        rule: "remote_package_exec",
        reason: `Remote-package runner fetches and executes an unreviewed external package in one step (W-049 / W-163). Add a pinned dependency + lockfile and run the local binary instead. ${ESCALATE}`,
      });
    }

    // Rule 3b — raw `codex exec` (W-039): a Codex-dispatched role must go through
    // dispatch_provider.ts — the wrapper grants --add-dir for the project
    // root / dispatch container / result dir, which a raw exec in a dispatch
    // worktree lacks (the worktree's .git points at the main repo). Without the
    // grants every process spawn dies (CreateProcessAsUserW 1312) and reads as a
    // broken sandbox (2026-07-10 PM misdiagnosis). Read-only probes stay allowed;
    // danger-full-access is denied outright (the wrapper refuses it too — it
    // needs explicit per-use user approval, never a default).
    if (policy.codex_raw_exec_guard_enabled && RE.codexExec.test(seg)) {
      if (RE.codexSandboxDanger.test(seg)) {
        decisions.push({
          action: withAction(policy, "codex_raw_exec", "deny"),
          rule: "codex_raw_exec",
          reason: `codex --sandbox danger-full-access requires explicit user approval per use and is never launched raw (dispatch_provider.ts refuses it). ${ESCALATE}`,
        });
      } else if (!RE.codexSandboxReadOnly.test(seg)) {
        decisions.push({
          action: withAction(policy, "codex_raw_exec", "ask"),
          rule: "codex_raw_exec",
          reason: `Raw \`codex exec\` lacks the --add-dir grants (project root / dispatch container / result dir) and dies with CreateProcessAsUserW 1312 in a dispatch worktree. Launch via dispatch_provider.ts — dispatch_prepare emits the ready-to-run launch_cmd. ${ESCALATE}`,
        });
      }
    }

    // Rule 4 — recursive delete: allowed only under the role's container.
    // W-164: gated by the per-family flag (default off = passthrough).
    const isRecursiveDelete =
      RE.rmRecursive.test(seg) || RE.psRemoveRecurse.test(seg) || RE.rdRecurse.test(seg);
    if (policy.recursive_delete_guard_enabled && isRecursiveDelete) {
      const targets = pathTokens(seg);
      const outside =
        targets.length === 0 || targets.some((t) => !withinOwnWorktree(t, segBase, fenceRoots));
      if (outside) {
        const where = fenceRoots[0] ?? "your dispatch worktree";
        decisions.push({
          action: withAction(policy, "recursive_delete", "deny"),
          rule: "recursive_delete",
          reason: `Recursive delete outside your own worktree (${where}) is unrecoverable. Inventory the targets and get approval first. ${ESCALATE}`,
        });
      }
    }

    // Rule 4b — indirect delete/reset/clean (W-059): the literal-flag rules
    // above (rmRecursive / gitResetHard / gitCleanForce) only see flags present
    // in the raw text. A one-level indirection like `F=-rf; rm $F /data` hides
    // the flag until shell expansion, after the guard has scanned — so
    // isRecursiveDelete stays false and the command falls through to allow. When
    // a segment BOTH invokes a delete/reset/clean command AND contains shell
    // indirection ($VAR / ${...} / $(...) / backtick), the guard cannot
    // statically prove the expanded flags/targets are in-container, so it
    // demotes to ask rather than silently allow. This is a heuristic, not a
    // closure — eval / functions / aliases with no $ or backtick still bypass;
    // ask (not deny) bounds the false-positive cost of a legitimate `rm $tmp`.
    if (policy.indirect_delete_guard_enabled && RE.destructiveCmd.test(gitSeg) && RE.shellIndirection.test(seg)) {
      decisions.push({
        action: withAction(policy, "indirect_delete", "ask"),
        rule: "indirect_delete",
        reason: `A delete / reset / clean command with shell indirection ($VAR, $(...), backtick) can expand to flags or targets the guard cannot verify (e.g. \`F=-rf; rm $F\`). Inline the literal flags and targets so they can be checked. ${ESCALATE}`,
      });
    }

    // Rule 6 — DB / secret files: delete or overwrite. W-164: per-family flag.
    if (policy.secret_file_guard_enabled && RE.secretName.test(seg)) {
      const isDelete = RE.deleteCmd.test(seg);
      const isOverwrite =
        RE.overwriteRedirect.test(seg) || RE.psOverwrite.test(seg) || RE.overwriteCp.test(seg);
      if (isDelete || isOverwrite) {
        const targets = pathTokens(seg).filter((t) => RE.secretName.test(t));
        const anyOutside =
          targets.length === 0 || targets.some((t) => !withinOwnWorktree(t, segBase, fenceRoots));
        decisions.push({
          action: anyOutside
            ? withAction(policy, "secret_file", "deny")
            : (policy.actions.secret_file ?? "ask"),
          rule: "secret_file",
          reason: `Deleting or overwriting a database / secret file (*.db, *.sqlite, *.env, credentials*) can lose live state irrecoverably. Read it first and confirm. ${ESCALATE}`,
        });
      }
    }

    const ownedDiscard = ownedWorkingTreeDiscard(input, gitContext, gitSeg, lifecycle);
    // Rule 5 — forced git history / tree rewrites → ask. W-164: per-family flag.
    if (
      policy.force_write_guard_enabled &&
      (RE.gitPushForce.test(gitSeg) ||
      RE.gitResetHard.test(gitSeg) ||
      RE.gitCleanForce.test(gitSeg) ||
      isGitBranchForce(gitSeg) ||
      RE.gitAmend.test(gitSeg) ||
      RE.gitWorktreeRmForce.test(gitSeg) ||
      (RE.gitRestore.test(gitSeg) && !RE.gitRestoreStagedOnly.test(gitSeg) && !ownedDiscard) ||
      (RE.gitCheckoutDiscard.test(gitSeg) && !ownedDiscard))
    ) {
      decisions.push({
        action: withAction(policy, "force_write", "ask"),
        rule: "force_write",
        reason: `Forced git rewrite discards state or rewrites a shared/gated SHA. Confirm the recovery path; only rewrite your own un-shared branch. ${ESCALATE}`,
      });
    }
  }

  // W-179 (d3): a PM-adjudicated project allow (pushed by profileDecisions when a
  // command matches a profile allow pattern) relaxes the fail-closed `profile_unknown`
  // band and any ASK for THIS command — the learning loop that stops a resolved class
  // re-escalating. It never overrides a family/profile hard DENY (egress, path fence,
  // scout_mutation, secret_file, recursive/indirect delete, …): those are kept and win
  // under strictest-wins, so `project の allow より family deny が先勝ち` holds.
  let ranked = decisions;
  if (decisions.some((d) => d.rule === "project_allow")) {
    const hardDeny = decisions.filter((d) => d.action === "deny" && d.rule !== "profile_unknown");
    if (hardDeny.length === 0) return { action: "allow", rule: "project_allow", reason: "" };
    ranked = hardDeny;
  }
  if (ranked.length === 0) return { action: "allow", rule: "none", reason: "" };
  // Strictest wins; among equal severity, the first found.
  ranked.sort((a, b) => SEVERITY[b.action] - SEVERITY[a.action]);
  const final = ranked[0];
  // W-179 (d2): PM resolution mode emits NO user-facing ask. A final ASK — whether the
  // fail-closed `profile_unknown`, a family ask (force_write / process_kill / codex_raw_exec
  // / indirect_delete / in-fence secret_file), or a project_ask — becomes a fail-closed
  // DENY carrying the escalate-to-PM instruction; the PM-readable pending report is then
  // written by maybeWriteGuardReport on the resulting deny (W-164 path). No new ALLOW is
  // ever synthesized here (deny+report only) — the ONLY pass in pm mode is a project allow.
  if (final.action === "ask" && policy.resolution_mode === "pm") {
    return { action: "deny", rule: final.rule, reason: `${final.reason} ${PM_MODE_ESCALATE}`, pmConverted: true };
  }
  return final;
}

// --- policy loading (CLI side) ---------------------------------------------

function coerceAction(v: unknown): Action | undefined {
  return v === "allow" || v === "ask" || v === "deny" ? v : undefined;
}

/** W-179 (d3): parse `[command_guard.profile_rules.<profile>]` allow/ask/deny string
 * lists. Unknown profile keys and non-string entries are dropped (fail-safe: a
 * malformed list never becomes a wildcard). */
function parseProfileRules(v: unknown): ProjectProfileRules {
  const out: ProjectProfileRules = {};
  if (!v || typeof v !== "object") return out;
  const stringList = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((e): e is string => typeof e === "string") : [];
  for (const [name, body] of Object.entries(v as Record<string, unknown>)) {
    if (!(name in PERMISSION_PROFILES) || !body || typeof body !== "object") continue;
    const b = body as Record<string, unknown>;
    out[name as PermissionProfileName] = { allow: stringList(b.allow), ask: stringList(b.ask), deny: stringList(b.deny) };
  }
  return out;
}

export function policyFromToml(text: string): GuardPolicy {
  const raw = parse(text) as Record<string, unknown>;
  const cg = (raw.command_guard ?? raw) as Record<string, unknown>;
  const actions: Partial<Record<RuleId, Action>> = {};
  const actTable = (cg.actions ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(actTable)) {
    const a = coerceAction(v);
    if (a) actions[k as RuleId] = a;
  }
  const domains = cg.network_allow_domains;
  return {
    enabled: cg.enabled === undefined ? true : cg.enabled !== false,
    install_guard_enabled: cg.install_guard_enabled === true,
    remote_exec_guard_enabled: cg.remote_exec_guard_enabled === true,
    // W-164: strict-boolean parse (=== true), so a missing key / non-boolean →
    // false (fail-safe-off), matching the two existing flags byte-for-byte.
    pipe_to_shell_guard_enabled: cg.pipe_to_shell_guard_enabled === true,
    network_egress_guard_enabled: cg.network_egress_guard_enabled === true,
    git_egress_guard_enabled: cg.git_egress_guard_enabled === true,
    codex_raw_exec_guard_enabled: cg.codex_raw_exec_guard_enabled === true,
    recursive_delete_guard_enabled: cg.recursive_delete_guard_enabled === true,
    indirect_delete_guard_enabled: cg.indirect_delete_guard_enabled === true,
    secret_file_guard_enabled: cg.secret_file_guard_enabled === true,
    force_write_guard_enabled: cg.force_write_guard_enabled === true,
    path_fence_guard_enabled: cg.path_fence_guard_enabled === true,
    process_kill_guard_enabled: cg.process_kill_guard_enabled === true,
    control_misplace_guard_enabled: cg.control_misplace_guard_enabled === true,
    merge_gate_bypass_guard_enabled: cg.merge_gate_bypass_guard_enabled === true,
    network_allow_domains: Array.isArray(domains) ? (domains as string[]) : [],
    actions,
    // W-179 (d1, 第 6 報): pm is the DEFAULT. Only the explicit string "ask" opts out;
    // anything else (missing / typo / non-string) resolves to "pm" — the fail-safe
    // direction is now toward deny+report, not toward a user prompt.
    resolution_mode: cg.resolution_mode === "ask" ? "ask" : "pm",
    // W-179 (d3): the PM-grown per-profile pattern lists.
    profile_rules: parseProfileRules(cg.profile_rules),
  };
}

/** The sole pm directory under a `__garelier` root, or null when zero or
 *  ambiguous (>1). Mirrors attended_record.resolvePmId's inference so a single-pm
 *  project resolves its policy without an explicit GARELIER_PM_ID. */
function solePmUnder(gdir: string): string | null {
  try {
    const dirs = readdirSync(gdir).filter((name) => {
      // `__`-prefixed entries are shared/system dirs (e.g. __atmos lenses), never
      // a pm id — exclude so a single-pm project still resolves uniquely.
      if (name.startsWith("__")) return false;
      try { return statSync(join(gdir, name)).isDirectory(); } catch { return false; }
    });
    return dirs.length === 1 ? dirs[0] : null;
  } catch { return null; }
}

/** Resolve a policy file: explicit env path, else walk up from cwd to find
 *  __garelier/<pm_id>/control/operations/command_guard_policy.toml. The pm id is
 *  the explicit GARELIER_PM_ID, else the sole pm under __garelier — without that
 *  fallback a committed, reviewed project policy was silently unreachable
 *  whenever the PreToolUse hook env lacked GARELIER_PM_ID (the common case: the
 *  hook command carries no env), always falling to DEFAULT_POLICY. */
export function findPolicyPath(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const explicit = env.GARELIER_COMMAND_GUARD_POLICY;
  if (explicit && existsSync(explicit)) return explicit;
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const gdir = join(dir, "__garelier");
    if (existsSync(gdir)) {
      const pmId = env.GARELIER_PM_ID ?? solePmUnder(gdir);
      if (pmId) {
        const c = join(gdir, pmId, "control", "operations", "command_guard_policy.toml");
        if (existsSync(c)) return c;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadPolicy(cwd: string, env: NodeJS.ProcessEnv): GuardPolicy {
  try {
    const p = findPolicyPath(cwd, env);
    if (p) return policyFromToml(readFileSync(p, "utf8"));
  } catch {
    // fall through to defaults
  }
  return DEFAULT_POLICY;
}

/** Resolve the current attended-seat route marker with a two-release read
 * fallback. A conflicting current/legacy pair is untrusted and fails closed. */
function executionRouteFrom(raw: {
  execution_route?: unknown;
  lane_kind?: unknown;
}): string | undefined {
  const current = typeof raw.execution_route === "string" ? raw.execution_route : undefined;
  const legacy = typeof raw.lane_kind === "string" ? raw.lane_kind : undefined;
  if (current !== undefined && legacy !== undefined && current !== legacy) return undefined;
  return current ?? legacy;
}

function permissionRecordFrom(path: string): DispatchPermissionRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as any;
    const guard = raw.guard && typeof raw.guard === "object" ? raw.guard : raw;
    const role = guard.role ?? raw.task?.role;
    const profile = guard.permission_profile === undefined && typeof role === "string"
      ? profileForRole(role)
      : guard.permission_profile;
    const roots = guard.fence_roots;
    if (!(profile in PERMISSION_PROFILES) || !Array.isArray(roots) || roots.length === 0) return null;
    // W-127: a dispatch record may store fence roots / worktree as paths RELATIVE
    // to itself (dispatch_prepare historically emitted `./…`). Anchor them on the
    // record file's OWN directory — never the hook's session cwd, which can leak
    // in from another dispatch (W-119) — so the absolute mutation targets the fence
    // is compared against actually match. Absolute entries are left byte-for-byte
    // so path_guard's flavor-aware canonicalization still decides POSIX/Windows (W-036).
    const recordDir = dirname(path);
    const anchorToRecord = (value: string): string =>
      isAbsolutePath(value) ? value : resolve(recordDir, value);
    const anchorOptional = (value: string | undefined): string | undefined =>
      value && value.trim() ? anchorToRecord(value) : value;
    const resolvedRoots = roots.map(String).map(anchorToRecord);
    const worktree = anchorOptional(guard.worktree ?? raw.worktree);
    // W-567: early gate_runner builds minted their own Dock identity immediately
    // before execution and left the resulting baseline-destructive record live.
    // Such a record proves only self-assertion and has no external lifecycle, so
    // it is never permission authority. Rejecting it also makes already-leftover
    // files inert without requiring a destructive cross-worktree cleanup.
    if (raw.source === "attended_record" && raw.spawned_via === "gate_runner") {
      reportRejectedRecord(
        path,
        profile,
        resolvedRoots,
        typeof raw.execution_route === "string" ? raw.execution_route : undefined,
        typeof raw.lane_kind === "string" ? raw.lane_kind : undefined,
        "gate_runner self-issued attribution records are not permission authority",
      );
      return null;
    }
    // W-174 R3: a `context.json` is trusted by a POSITIVE LOCATION ALLOWLIST, not a
    // denylist of forge shapes. A worker's checkout / lane worktree is writable
    // area it fully controls, so a planted `context.json` (fabricated profile /
    // fence / execution-route marker to defeat the guard — the hole W-170 Guardian found) can
    // sit anywhere with any claimed fields; a denylist of "known bad" spots always
    // left a gap (a 1-field `worktree` claim slipped past R2 — Observer). The
    // dispatcher writes the container record at exactly ONE shape: `<container>/
    // context.json` where `<container>` is a canonical `dispatch<N>` container
    // and (when present) the record's `worktree` resolves UNDER that container
    // (`<container>/checkout`). ONLY that shape is trusted; every other location is
    // rejected — regardless of the claimed worktree/fence. (`_crew/lanes/.meta/
    // *.dispatch.json` isolation records are a different basename, skipped here.)
    // fence_roots is NOT the yardstick (a PM-direct seat fences the whole repo root
    // — R1). A rejected record is REPORTED (`guard_record_rejected`) so an in-flight
    // forge, or a legit-migration misdetection, is visible — never a silent drop.
    // NOTE (W-174 residual): a determined worker can still mimic the allowlist shape
    // INSIDE its own worktree (create `<own>/_crew/dispatch9/checkout`, cd in, plant) —
    // fully closing that needs a dispatcher-written provenance nonce (row residual).
    if (/(?:^|[\\/])context\.json$/i.test(path)) {
      const containerLeaf = recordDir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
      const isDispatchContainer = /^dispatch\d+$/i.test(containerLeaf);
      const dispatchId = /^dispatch(\d+)$/i.exec(containerLeaf)?.[1] ?? "";
      const seatRole = raw.task?.role;
      const seatIdentity = raw.role_seat_binding?.identity;
      const seatProjectRoot = typeof raw.project?.project_root === "string"
        ? anchorToRecord(raw.project.project_root)
        : "";
      const seatPmId = typeof raw.project?.pm_id === "string" ? raw.project.pm_id : "";
      const expectedResultRoot = seatProjectRoot && seatPmId && (seatRole === "guardian" || seatRole === "observer")
        ? resolve(seatProjectRoot, "__garelier", seatPmId, "runtime", seatRole, "results")
        : "";
      const externalReadOnlyGateSeat = (seatRole === "guardian" || seatRole === "observer")
        && seatIdentity?.kind === "role-seat"
        && String(seatIdentity.id ?? "") === dispatchId
        && seatIdentity.role === seatRole
        && profile === "gate"
        && Boolean(worktree && seatProjectRoot)
        && pathIsInside(worktree!, seatProjectRoot)
        && pathIsInside(seatProjectRoot, worktree!)
        && resolvedRoots.length === 1
        && pathIsInside(resolvedRoots[0]!, expectedResultRoot)
        && pathIsInside(expectedResultRoot, resolvedRoots[0]!);
      const worktreeUnderContainer = externalReadOnlyGateSeat || (worktree ? pathIsInside(worktree, recordDir) : true);
      if (!(isDispatchContainer && worktreeUnderContainer)) {
        reportRejectedRecord(
          path,
          profile,
          resolvedRoots,
          typeof raw.execution_route === "string" ? raw.execution_route : undefined,
          typeof raw.lane_kind === "string" ? raw.lane_kind : undefined,
          isDispatchContainer ? "record worktree does not resolve under its dispatch container" : "context.json is not at a dispatch container (`_crew/dispatch<N>/context.json`)");
        return null;
      }
    }
    const quality = raw.quality_gate && typeof raw.quality_gate === "object" ? raw.quality_gate : {};
    const commandList = (value: unknown): string[] => Array.isArray(value)
      ? value.map(String).filter((command) => command.trim().length > 0)
      : [];
    const qualityCommands = [
      ...commandList(guard.quality_gate_commands),
      ...commandList(quality.full),
      ...commandList(quality.fast),
      ...commandList(quality.scoped),
      ...commandList(quality.run_verify),
    ];
    // W-183: a dispatcher/attended-record-declared supplementary binding — extra
    // repo control roots this SAME operator is authorized to work in (a target-project
    // session whose PM-direct record ALSO covers the garelier repo). Cross-repo
    // work via a relative path / bare git (cwd = repo A, targets repo B) does not
    // yield an absolute cd/`git -C` target for the W-150 scan, so the seat fell to
    // baseline-destructive and every command asked (실측 6 件 2026-07-20). These
    // roots are EXPLICIT (never inferred from the ambient cwd — that design refuses
    // cwd trust, W-119) and carry the SAME trust as fence_roots (they come from the
    // same record), so they are merged INTO the effective fence: an in-fence write
    // in a declared additional root is allowed under the seat's profile, while an
    // UNdeclared repo stays out-of-fence and fails closed. Anchored to the record
    // like fence_roots so a relative entry resolves against the record's own dir.
    const additionalRoots: string[] = Array.isArray(guard.additional_roots)
      ? [...new Set((guard.additional_roots as unknown[]).map(String).filter((r) => r.trim().length > 0).map(anchorToRecord))]
      : [];
    const approvedRemoteDestinations =
      normalizeApprovedRemoteDestinations(guard.approved_remote_destinations);
    return {
      permission_profile: profile,
      fence_roots: [...new Set([...resolvedRoots, ...additionalRoots])],
      additional_roots: additionalRoots,
      approved_remote_destinations: approvedRemoteDestinations,
      role,
      agent_name: guard.agent_name ?? raw.agent_name ?? raw.owner,
      worktree,
      quality_gate_commands: [...new Set(qualityCommands)],
      project_root: typeof raw.project?.project_root === "string" ? raw.project.project_root : undefined,
      // W-206: current `execution_route` first, legacy `lane_kind` fallback.
      // A mismatch resolves undefined, preserving role process_kill=deny.
      execution_route: executionRouteFrom(raw),
      lane_kind: typeof raw.lane_kind === "string" ? raw.lane_kind : undefined,
      source: path,
    };
  } catch { return null; }
}

function recordMatchesAgent(record: DispatchPermissionRecord | null, agentName: string): record is DispatchPermissionRecord {
  return record !== null && (!record.agent_name || !agentName || record.agent_name === agentName);
}

/** W-179 (b): the running cwd is inside the record's OWN worktree / fence — the same
 * cwd-containment identity proof W-133 (recordFromCdTarget) uses to adopt a container
 * record regardless of agent_name. When the launcher's resolved agent name drifts
 * from what attended_record wrote (a hash `agent_id` vs the seat name), a lane's
 * record would otherwise fail the strict agent match and the seat would strand at the
 * strictest baseline-destructive (the `profile_unknown` → baseline fallback this
 * fixes). Being inside the record's worktree is the identity, and the adopted fence
 * still bounds every mutation to that worktree, so adopting is safe (never an
 * escalation — a role lane's fence is its own worktree). */
function recordWorktreeContains(record: DispatchPermissionRecord | null, cwd: string): boolean {
  if (!record) return false;
  const c = resolve(cwd);
  const roots = [record.worktree, ...(record.fence_roots ?? [])].filter((r): r is string => !!r && r.trim().length > 0);
  return roots.some((r) => pathIsInside(c, resolve(r)));
}

/** W-129: gate seats (Guardian / Observer) get no dispatch worktree, so no record
 * is keyed to their name — the name lives in a role context.json's
 * `gate_agents`. When the looked-up agent matches a gate seat there, synthesize a
 * gate-profile record fenced to the target project root so its `cd`-into-checkout
 * read-only chains ride the W-118 read-only path, instead of falling to a
 * record-less baseline-destructive seat that asks on every inspection (실측:
 * ga-guardian-w496 / ga-guardian-w174). */
function gatePermissionRecord(path: string, agentName: string): DispatchPermissionRecord | null {
  if (!agentName) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as any;
    const gate = raw.gate_agents;
    if (!gate || typeof gate !== "object") return null;
    const role = gate.guardian?.name === agentName ? "guardian"
      : gate.observer?.name === agentName ? "observer"
      : undefined;
    if (!role) return null;
    // Fence the gate seat to the target project root: context.json's own
    // project_root when present, else the record file's repo root (the nearest
    // ancestor that owns a __garelier tree = the project root, W-126).
    const targetRoot = typeof raw.project?.project_root === "string" && raw.project.project_root.trim()
      ? raw.project.project_root
      : ancestorGareilerRoots(dirname(path))[0];
    if (!targetRoot) return null;
    return {
      permission_profile: "gate",
      fence_roots: [targetRoot],
      role,
      agent_name: agentName,
      worktree: targetRoot,
      quality_gate_commands: [],
      project_root: targetRoot,
      source: path,
    };
  } catch { return null; }
}

/** W-130: an ad-hoc gate reviewer (a Guardian / Observer / Refuter spawned by
 * hand, not tied to a dispatch — e.g. a design-review Observer with no role)
 * has no context.json keyed to its name and no `gate_agents` entry to synthesize
 * from, so every record lookup above returns null and it falls to a
 * baseline-destructive seat that ASKS on every inspection. When NOTHING resolves,
 * fall back to the garelier naming convention (`ga-<role>-<slug>`): a
 * `ga-(guardian|observer|refuter)-*` name IS a gate seat, so synthesize a
 * gate-profile record fenced to the nearest ancestor target root. Safe-direction
 * ONLY: the gate profile is STRICTER on mutation than baseline (mkdir/rm/git
 * commit are denied by its `gate_mutation` rule) while its read-only inspection
 * chains ride the W-118 allow path — so this can only turn an ask into an allow
 * for read-only work, or into a deny for a mutation; it never promotes a role
 * seat (`ga-worker-*` etc. stay baseline-destructive). */
function gateSeatFromNaming(cwd: string, agentName: string): DispatchPermissionRecord | null {
  const match = /^ga-(guardian|observer|refuter)-/.exec(agentName);
  if (!match) return null;
  const targetRoot = ancestorGareilerRoots(cwd)[0];
  if (!targetRoot) return null;
  return {
    permission_profile: "gate",
    fence_roots: [targetRoot],
    role: match[1],
    agent_name: agentName,
    worktree: targetRoot,
    quality_gate_commands: [],
    project_root: targetRoot,
    source: `naming-convention:${agentName}`,
  };
}

/** W-133: resolve a dispatch record from the command's own absolute `cd` target
 * when the agent name cannot. A real Claude Code hook payload can deliver ONLY a
 * hash `agent_id` (e.g. `ab3c4ca546985fbaa`) with no `agent_type`/`agent_name`,
 * so resolveAgentName yields a hash that keys no record. The absolute `cd` target
 * is the one value W-119's segmentBases ALREADY trusts as an intended
 * destination; when it lands inside a dispatch container's checkout, that
 * container's context.json describes the worktree the agent is actually operating
 * in, so adopt its record — fence + profile included — WITHOUT the agent_name
 * match. Being inside the checkout is the identity proof, and the adopted fence
 * still bounds every mutation to that checkout, so even pointing at a DIFFERENT
 * container's checkout is safe (the fence protects it). No absolute cd, or a cd
 * that resolves to no container, keeps the caller null → baseline. */
function recordFromCdTarget(command: string): DispatchPermissionRecord | null {
  if (!command) return null;
  let target: string | undefined;
  for (const seg of splitSegments(command)) {
    const cd = absoluteCdTarget(seg);
    if (cd) target = cd; // the last absolute cd is the one in effect
  }
  if (!target) return null;
  let dir = resolve(target);
  for (let i = 0; i < 12; i++) {
    const ctx = join(dir, "context.json");
    if (existsSync(ctx)) {
      const record = permissionRecordFrom(ctx);
      if (record) return record; // adopt regardless of agent_name (W-133)
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Absolute directories a command explicitly operates in — a plain `cd <abs>` or
 * a `git -C <abs>`. In a cross-repo launch (session cwd = repo A, command targets
 * repo B) these name repo B, whose `__garelier` holds the operator's record even
 * though it is not an ancestor of the hook cwd (W-150). */
function commandTargetDirs(command: string): string[] {
  const dirs: string[] = [];
  let activeCd: string | undefined;
  for (const seg of splitSegments(command)) {
    const cd = absoluteCdTarget(seg);
    if (cd) {
      activeCd = resolve(cd);
      dirs.push(activeCd);
    }
    const git = gitInvocationContext(seg, activeCd);
    if (git.explicitChdir && git.probeDir && !git.probeError) dirs.push(git.probeDir);
  }
  return [...new Set(dirs)];
}

/** Scan a single `__garelier` root for a canonical dispatch/lane record whose
 * agent name matches. Returns the first match or null; a missing/racing runtime
 * record leaves the caller fail-safe and lets an outer root still be tried. */
function scanGareilerRootForAgent(root: string, agentName: string): DispatchPermissionRecord | null {
  const garelier = join(root, "__garelier");
  try {
    for (const pm of readdirSync(garelier)) {
      const pmRoot = join(garelier, pm);
      if (!statSync(pmRoot).isDirectory()) continue;
      const crewRoot = join(pmRoot, "_crew");
      if (!existsSync(crewRoot)) continue;
      const dispatchIds = new Set<string>();
      for (const name of readdirSync(crewRoot)) {
        const match = /^dispatch(\d+)$/.exec(name);
        if (match) dispatchIds.add(match[1]);
      }
      for (const id of dispatchIds) {
        const candidate = join(dispatchContainer(root, pm, id), "context.json");
        if (!existsSync(candidate)) continue;
        const record = permissionRecordFrom(candidate);
        if (record?.agent_name === agentName) return record;
        const gate = gatePermissionRecord(candidate, agentName); // W-129
        if (gate) return gate;
      }
      const meta = join(crewRoot, "lanes", ".meta");
      if (!existsSync(meta)) continue;
      for (const file of readdirSync(meta).filter((f) => f.endsWith(".dispatch.json"))) {
        const record = permissionRecordFrom(join(meta, file));
        if (record?.agent_name === agentName) return record;
        const gate = gatePermissionRecord(join(meta, file), agentName); // W-129
        if (gate) return gate;
      }
    }
  } catch { /* missing/racing runtime record -> caller remains fail-safe */ }
  return null;
}

/** Resolve the permission identity for a prospective named Agent seat.
 *
 * This is the name -> record portion of command_guard's canonical resolver,
 * shared with the Agent PreToolUse warning. It deliberately scans both dispatch
 * context.json files and slug-keyed lane records by their embedded agent_name;
 * callers must never assume the record filename equals the Agent name. Unlike
 * findDispatchPermissionRecord(), this prospective-seat form does not adopt the
 * caller's own cwd-contained record or GARELIER_DISPATCH_RECORD, because those
 * identify the parent seat rather than the Agent about to be spawned. */
export function findDispatchPermissionRecordForAgent(cwd: string, agentName: string): DispatchPermissionRecord | null {
  if (!agentName) return null;
  for (const root of ancestorGareilerRoots(cwd)) {
    const record = scanGareilerRootForAgent(root, agentName);
    if (record) return record;
  }
  return null;
}

/** Resolve the dispatch permission record from cwd first; the agent name is a
 * secondary discriminator for future shared-cwd launchers. */
export function findDispatchPermissionRecord(cwd: string, agentName = "", env: NodeJS.ProcessEnv = process.env, command = ""): DispatchPermissionRecord | null {
  const explicit = env.GARELIER_DISPATCH_RECORD;
  if (explicit) {
    const record = permissionRecordFrom(explicit);
    if (record) return record;
  }
  let dir = resolve(cwd);
  for (let i = 0; i < 12; i++) {
    for (const candidate of [join(dir, "context.json"), join(dirname(dir), "context.json")]) {
      if (existsSync(candidate)) {
        const record = permissionRecordFrom(candidate);
        if (recordMatchesAgent(record, agentName)) return record;
        const gate = gatePermissionRecord(candidate, agentName); // W-129
        if (gate) return gate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Isolate lanes keep the append-only record beside the lanes directory
  // (`<lanes>/.meta/<slug>.dispatch.json`), while the lane worktree is
  // `<lanes>/<slug>/`. Walk UP from cwd so a SUBDIR of the lane worktree still
  // resolves the record (the old form assumed cwd === the lane root exactly), and
  // (W-179 b) adopt it either on an agent-name match OR by cwd-containment — the
  // same identity proof W-133 uses for a container record — so a drifted resolved
  // agent name no longer strands the lane at baseline-destructive.
  {
    let dir = resolve(cwd);
    for (let i = 0; i < 12; i++) {
      const laneRecord = join(dirname(dir), ".meta", `${dir.split(/[\\/]/).pop()}.dispatch.json`);
      if (existsSync(laneRecord)) {
        const record = permissionRecordFrom(laneRecord);
        if (record && (recordMatchesAgent(record, agentName) || recordWorktreeContains(record, cwd))) return record;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Attended subagents can inherit the parent session's project-root cwd. In
  // that launch shape the agent name selects its live dispatch/lane record.
  // Scan EVERY ancestor __garelier root (nearest → farthest), not just the
  // innermost: a full-repo checkout worktree carries its own committed
  // __garelier tree that holds no live record, so stopping at it fell through
  // to a baseline-destructive seat (#348, W-126). Nearest wins when both hold a
  // matching record.
  if (agentName) {
    const record = findDispatchPermissionRecordForAgent(cwd, agentName);
    if (record) return record;
  }
  // W-150: cross-repo lookup. The agent's record was not among the hook cwd's
  // ancestor roots, but the command may operate on a DIFFERENT repo via `cd <abs>`
  // / `git -C <abs>` (session cwd = repo A, command targets repo B — e.g. a target-project
  // session running `git -C <garelier> commit`). Resolve each target's canonical
  // control root with the SAME resolver the writer anchors on (resolveControlRoot),
  // plus its ancestor roots, and scan there. Agent-name-matched, so it only
  // supplies a record written for THIS operator — never a broadening of policy,
  // and the resolved fence still bounds every mutation.
  if (agentName && command) {
    const seen = new Set<string>();
    for (const target of commandTargetDirs(command)) {
      for (const root of [resolveControlRoot(target), ...ancestorGareilerRoots(target)]) {
        if (seen.has(root)) continue;
        seen.add(root);
        const record = scanGareilerRootForAgent(root, agentName);
        if (record) return record;
      }
    }
  }
  // W-133: no agent-matched record (e.g. a bare-hash agent_id keys nothing). Fall
  // back to the command's TRUSTED absolute cd target — if it lands in a dispatch
  // container's checkout, adopt that container's record (fence bounds it). Tried
  // before the naming fallback since it is command-evidenced, not a name heuristic.
  const cdRecord = recordFromCdTarget(command);
  if (cdRecord) return cdRecord;
  // W-130: last resort — no dispatch/lane/gate_agents record resolved anywhere.
  // A garelier-named gate seat still gets a synthesized gate-profile record
  // (safe-direction only); anything else stays null → baseline.
  return gateSeatFromNaming(cwd, agentName);
}

// --- W-205: harness Edit/Write/MultiEdit fence ------------------------------

export interface FileEditInput {
  /** The harness tool name (Edit / Write / MultiEdit). */
  toolName: string;
  /** The absolute file_path the tool will mutate (Edit/Write/MultiEdit all carry
   *  one; the harness requires it absolute). */
  filePath: string;
  cwd?: string;
  /** The resolved dispatch record's worktree + fence roots (the seat's own fence). */
  worktree?: string;
  fenceRoots?: string[];
  policy?: GuardPolicy;
  /** W-187 parity: a named seat that resolved no record (→ no fence). */
  seatRecordUnresolved?: boolean;
  agentName?: string;
}

/** W-205 (W-187 parity): the deny hint when a harness Edit/Write lands outside the
 * seat's worktree fence. The harness file tools bypass the shell entirely, so the
 * Bash path fence never sees them — an absolute-path Edit could write into the
 * primary / parent checkout (the #400 misplace class, same root as
 * feedback_symphorie_worker_worktree_path 2026-05-25). Name the fence + the fix. */
function fileEditFenceHint(tool: string, filePath: string, fenceRoots: string[]): string {
  return (
    `${tool} target '${filePath}' is OUTSIDE your worktree fence (${fenceRoots.join(", ")}). ` +
    `The harness ${tool}/Write tools bypass the shell, so an absolute path here writes into the ` +
    `PRIMARY / parent checkout — the #400 misplace class (成果物が studio へ紛れる). Edit only files ` +
    `UNDER your own checkout worktree; re-target the path under ${fenceRoots[0]} ` +
    `(the same repo-relative file lives there). ${ESCALATE}`
  );
}

/** W-205: fence the harness Edit/Write/MultiEdit tools the same way the Bash path
 * fence bounds a shell mutation. Enforced only when the path_fence family is on AND
 * a dispatch record resolved a fence (a role/gate seat's own worktree): an
 * absolute Edit/Write target OUTSIDE that fence is a DENY (with a W-187-style hint);
 * a target inside is an ALLOW. No fence resolved (no record) or the family flag off =
 * passthrough, so a non-dispatch session is never affected. Mirrors the Bash
 * `profile_path_fence` rule id + the unexpanded-expansion fail-closed (W-178). */
export function evaluateFileEdit(input: FileEditInput): Decision {
  const policy = input.policy ?? DEFAULT_POLICY;
  if (!policy.enabled) return { action: "allow", rule: "disabled", reason: "" };
  if (!policy.path_fence_guard_enabled) return { action: "allow", rule: "path_fence_off", reason: "" };
  const fenceRoots = [...new Set(
    [input.worktree, ...(input.fenceRoots ?? [])].filter((v): v is string => Boolean(v && v.trim())),
  )];
  if (fenceRoots.length === 0) {
    // W-205 N1 (design-owner 裁定 2026-07-21): a NAMED seat (agentName present) that
    // resolved NO record is the W-187 cwd-mismatch / strand class — and the #400
    // misplace happened in exactly this state, so FAIL CLOSED like the Bash side
    // (deny + the cwd-contract diagnostic) instead of letting an unbounded edit through.
    // A truly record-less session (no agentName = a general user session, not a dispatch
    // role) still passes through, so a non-Garelier user is never falsely blocked.
    if (input.seatRecordUnresolved) {
      return {
        action: "deny",
        rule: "profile_path_fence",
        reason: `${input.toolName} '${input.filePath}': fence 未解決のため fail-closed。` +
          cwdRecordHint(input.agentName ?? "", input.cwd ?? ""),
      };
    }
    // No fence and no named seat: the target cannot be proven out-of-fence, so allow —
    // exactly like the Bash path fence, which is a no-op without fenceRoots.
    return { action: "allow", rule: "path_fence_no_fence", reason: "" };
  }
  if (!input.filePath) return { action: "allow", rule: "path_fence_no_path", reason: "" };
  // An unexpanded expansion cannot be proven in-fence (W-178 parity).
  if (/[$`]/.test(input.filePath)) {
    return { action: "deny", rule: "profile_path_fence", reason: `${input.toolName} target '${input.filePath}' contains an unexpanded shell expansion and cannot be fence-verified. ${ESCALATE}` };
  }
  try {
    assertPathMutation(input.filePath, "write", { cwd: input.cwd ?? fenceRoots[0], fenceRoots });
    return { action: "allow", rule: "path_fence", reason: "" };
  } catch {
    return { action: "deny", rule: "profile_path_fence", reason: fileEditFenceHint(input.toolName, input.filePath, fenceRoots) };
  }
}

// --- Claude Code PreToolUse hook wrapper -----------------------------------

export interface HookPayload {
  tool_name?: string;
  cwd?: string;
  agent_id?: string;
  agent_name?: string;
  /** Real Claude Code hook payloads carry the Agent-tool spawn name here (equal
   *  to the dispatch record's agent_name), alongside a hash-suffixed agent_id —
   *  and NO agent_name. This is the field the record lookup keys on (W-125). */
  agent_type?: string;
  /** command for the shell tools; file_path (Edit/Write/MultiEdit) or notebook_path
   *  (NotebookEdit) for the W-205 file fence. */
  tool_input?: { command?: string; file_path?: string; notebook_path?: string };
}

/** The dispatch record is keyed on the Agent-tool spawn name. A real hook
 *  payload delivers that name as `agent_type` (with a hash-suffixed `agent_id`
 *  and no `agent_name`); `agent_name` is still honored first for any launcher
 *  that sets it, and the hash-suffixed `agent_id` is the last-resort fallback so
 *  a name is never empty when one is present (W-125). */
export function resolveAgentName(payload: HookPayload): string {
  return payload.agent_name ?? payload.agent_type ?? payload.agent_id ?? "";
}

export type RiskClass = "read-only" | "write-in-fence" | "write-out-fence" | "destructive" | "egress";

/** W-176 (a): a self-classification for every deny/ask, so the reviewer sees the
 * risk class and a recommendation instead of judging a blocked command cold. Maps
 * a decision's rule to one of five classes; anything unmapped falls to the
 * fail-safe `destructive` (an unknown that could not be proven read-only is treated
 * as the worst case, never silently downgraded). read-only never reaches here (it
 * short-circuits to allow, W-176 0). Recommendation: an in-fence write may be
 * approved if intended; everything else is deny + escalate. */
export function riskClassification(rule: string): { classification: RiskClass; recommended: string } {
  const classification: RiskClass =
    rule === "network_egress" || rule === "network_offlist" || rule === "git_egress" || /(?:^|_)(?:push|fetch|pull|remote|egress)/i.test(rule) ? "egress"
    : rule === "profile_path_fence" ? "write-out-fence"
    // N1 (W-176): secret_file deletes or overwrites a *.db/*.env/credentials file
    // (its out-of-fence form is a hard DENY) — destructive, not an in-fence write.
    // Mapping it soft ("approve if intended") understated it.
    : "destructive"; // secret_file (db/secret delete-overwrite), recursive/indirect delete, force_write, process_kill, pipe_to_shell, remote_package_exec, install*, codex_raw_exec, profile_unknown, and any unmapped rule (fail-safe)
  // W-182: key the recommendation by RiskClass instead of a `=== "write-in-fence"`
  // literal comparison — TS narrows `classification` to the classes the mapping
  // above can PRODUCE (egress / write-out-fence / destructive), so the comparison
  // was statically dead (`no overlap`, the latent tsc error). A write-in-fence /
  // read-only decision never reaches here today (both short-circuit to allow,
  // W-176 0); the soft recommendation is retained for those keys so a future
  // mapping that does emit them stays correct. Behavior is unchanged for the three
  // classes actually produced.
  const SOFT = "approve only if the write is intended and in-scope, else deny + escalate to the PM";
  const HARD = "deny + escalate to the PM (approve only if genuinely required and in-scope)";
  const recommended: string = ({
    "read-only": SOFT,
    "write-in-fence": SOFT,
    "write-out-fence": HARD,
    "destructive": HARD,
    "egress": HARD,
  } satisfies Record<RiskClass, string>)[classification];
  return { classification, recommended };
}

/** Map a Decision to the PreToolUse hook stdout. "allow" emits nothing so the
 *  normal permission flow proceeds (we never auto-approve). W-176 (a): a non-allow
 *  reason carries a 2-line risk self-classification so no ask/deny is un-triaged. */
export function hookOutput(d: Decision): string | null {
  if (d.action === "allow") return null;
  const risk = riskClassification(d.rule);
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: d.action,
      permissionDecisionReason: `[command_guard:${d.rule}] ${d.reason}\nclassification: ${risk.classification}\nrecommended: ${risk.recommended}`,
    },
  });
}

export interface GuardTraceContext {
  tool: string;
  command: string;
  cwd: string;
  payload: HookPayload;
  /** resolveAgentName(payload) — the name the record lookup keyed on. */
  resolvedAgent: string;
  record: DispatchPermissionRecord | null;
  profile?: PermissionProfileName;
}

/** Append a one-line JSON trace of the guard's decision so a "simulation allows
 * but the live hook asks" divergence (the #348 class) can be diagnosed from real
 * payloads instead of guesswork. Non-allow decisions are always traced; allow is
 * silent unless GARELIER_GUARD_TRACE=1. W-188: the line lands next to the guard
 * report, in `guardRuntimeDir(cwd)/guard_trace.jsonl` — under `__garelier/`, never
 * at the consuming project's root.
 * Diagnostic only: every failure (no root resolved, unwritable dir) is swallowed
 * so tracing can never disturb the guard's own verdict. The command body is
 * truncated to 80 chars since it can carry secrets. */
export function maybeTraceDecision(decision: Decision, ctx: GuardTraceContext, env: NodeJS.ProcessEnv = process.env): void {
  if (decision.action === "allow" && env.GARELIER_GUARD_TRACE !== "1") return;
  const traceDir = guardRuntimeDir(ctx.cwd, env);
  if (!traceDir) return;
  try {
    mkdirSync(traceDir, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      tool: ctx.tool,
      cwd: ctx.cwd,
      command: ctx.command.slice(0, 80),
      agent_id: ctx.payload.agent_id ?? null,
      agent_type: ctx.payload.agent_type ?? null,
      agent_name: ctx.payload.agent_name ?? null,
      resolved_agent: ctx.resolvedAgent,
      record_found: ctx.record?.source ?? null,
      profile: ctx.profile ?? null,
      rule: decision.rule,
      action: decision.action,
    };
    appendFileSync(join(traceDir, "guard_trace.jsonl"), JSON.stringify(entry) + "\n");
  } catch { /* tracing must never disturb the guard's decision */ }
}

/** W-164 / W-188: the runtime dir guard output (reports AND the decision trace)
 * lands in, mirroring runtime_recovery_hook.runtimeDir so the guard and the
 * recovery hook share ONE incidents.jsonl stream (no second mechanism).
 *
 * W-188: everything stays UNDER `__garelier/`. Garelier is a guest in someone
 * else's repo, so it must never create state dirs at the consuming project's
 * root — the former `<root>/.claude/runtime/garelier/` fallback did exactly that.
 * Resolution order:
 *   1. cwd under `__garelier/<pm>/…`      → that pm's `runtime/hooks/`
 *   2. explicit GARELIER_PM_ID, or the SOLE pm under `__garelier/` → same
 *   3. ambiguous (0 or >1 pm, none named) → `__garelier/__atmos/guard/unresolved/`.
 *      `__atmos` is the EXISTING pm-independent shared tier (home of
 *      lens_registry.toml), so this invents no new hierarchy and no synthetic pm
 *      id — both were considered and rejected (user 裁定 2026-07-20).
 * Null when no `__garelier` root resolves at all (a plain repo with no Garelier
 * coordination): nothing is written and nothing is created — the guard's own
 * deny/allow verdict is unaffected, only the report is lost. */
export function guardRuntimeDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const roots = ancestorGareilerRoots(cwd);
  if (roots.length === 0) return null;
  const root = roots[0];
  const gdir = join(root, "__garelier");
  const norm = cwd.replace(/\\/g, "/");
  const prefix = `${root.replace(/\\/g, "/")}/__garelier/`;
  if (norm.startsWith(prefix)) {
    const pmId = norm.slice(prefix.length).split("/")[0];
    // `__`-prefixed entries are shared/system dirs, never a pm id.
    if (pmId && !pmId.startsWith("__")) return join(gdir, pmId, "runtime", "hooks");
  }
  const named = env.GARELIER_PM_ID;
  const pmId = named && !named.startsWith("__") && existsSync(join(gdir, named))
    ? named
    : solePmUnder(gdir);
  if (pmId) return join(gdir, pmId, "runtime", "hooks");
  return join(gdir, "__atmos", "guard", "unresolved");
}

/** W-164: the recommended next step surfaced to the PM alongside a deny/ask. */
function recommendedNextStep(decision: Decision): string {
  // W-179 (d2): a PM-mode-converted ask is a PENDING adjudication, not a plain deny —
  // the PM resolves it by GROWING the profile's pattern list (the learning loop).
  if (decision.pmConverted) {
    return `PM resolution mode held this command (an ask was converted to a fail-closed deny, no user prompt). Adjudicate by growing the profile's pattern list in command_guard_policy.toml: add a matching pattern to [command_guard.profile_rules.<profile>].allow to permit the class going forward, or .deny to hard-block it. Use pattern_hint as the starting regex. The agent was told to escalate to the PM.`;
  }
  return decision.action === "deny"
    ? `Blocked. Do not work around it — escalate to the PM. A project may individually allow this class in its command_guard_policy.toml (actions.${decision.rule} = "allow" / "ask") after review, or turn the family flag off.`
    : `Paused for confirmation. Confirm the command is intended and in-scope before proceeding; if unsure, escalate to the PM.`;
}

/** W-164: write a PM-readable structured report for every guard deny / ask,
 * integrated into the EXISTING incidents.jsonl stream (runtime_recovery_hook.ts)
 * rather than a second mechanism — an incident-shaped record with a
 * `guard_deny` / `guard_ask` kind that dock_status surfaces in the pmAction pane.
 * Carries command (verbatim), rule, fence roots, reason, and recommended next
 * step. Best-effort: any failure is swallowed so reporting never disturbs the
 * guard's own verdict. `allow` writes nothing. The user's framing: the guard is
 * insurance against AI runaway and script bugs, so a deny/ask without a report is
 * forbidden (a silent block is a dead end for the PM). */
export function maybeWriteGuardReport(decision: Decision, ctx: GuardTraceContext, env: NodeJS.ProcessEnv = process.env): void {
  if (decision.action === "allow") return;
  const dir = guardRuntimeDir(ctx.cwd, env);
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const record = {
      incident_id: `gri-guard-${now.replace(/[^0-9TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`,
      kind: `guard_${decision.action}`, // guard_deny | guard_ask
      status: "open",
      created_at: now,
      cwd: ctx.cwd,
      agent_id: ctx.payload.agent_id ?? null,
      agent_type: ctx.payload.agent_type ?? null,
      resolved_agent: ctx.resolvedAgent || null,
      tool_name: ctx.tool,
      rule: decision.rule,
      action: decision.action,
      command: ctx.command,
      fence_roots: ctx.record?.fence_roots ?? [],
      reason: decision.reason,
      recommended: recommendedNextStep(decision),
      // W-179 (d2): true when PM resolution mode converted an ask into this deny — the
      // PM must adjudicate it (grow the profile allow/deny list), not just note a block.
      pm_pending: decision.pmConverted === true,
      // W-179 (d3): the git-normalized, prose-stripped form the profile_rules lists
      // match on, so the PM can copy it straight into an allow/deny pattern.
      pattern_hint: classificationForDeny(ctx.command),
    };
    // The cause is the exact command this rule blocked in this cwd. Two different
    // commands stay two records; the same one re-attempted stays one.
    appendIncident(dir, record, incidentRepeatKey(record.kind, [decision.rule, decision.action, ctx.command, ctx.cwd]));
  } catch { /* reporting must never disturb the guard's verdict */ }
}

/** W-174 R3: report a REJECTED (untrusted-location) dispatch record so an
 * in-flight forge attempt — or a legit-migration misdetection — is visible in the
 * pmAction pane, never a silent drop. Integrated into the same incidents.jsonl
 * stream as `guard_deny`/`guard_ask` (a `guard_record_rejected` kind). Carries the
 * planted file path and the record's CLAIMED profile / fence / route markers so the PM
 * can judge intent. Best-effort; runs only when a well-formed context.json is
 * rejected by the location allowlist (an absent/malformed file never reaches here). */
function reportRejectedRecord(
  recordPath: string,
  claimedProfile: string,
  claimedFence: string[],
  claimedExecutionRoute: string | undefined,
  claimedLegacyLaneKind: string | undefined,
  reason: string,
): void {
  const dir = guardRuntimeDir(dirname(recordPath));
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const record = {
      incident_id: `gri-guardrec-${now.replace(/[^0-9TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "guard_record_rejected",
      status: "open",
      created_at: now,
      record_path: recordPath,
      claimed_profile: claimedProfile,
      claimed_fence_roots: claimedFence,
      claimed_execution_route: claimedExecutionRoute ?? null,
      claimed_legacy_lane_kind: claimedLegacyLaneKind ?? null,
      // Public incident compatibility: retained for at least two releases.
      claimed_lane_kind: claimedLegacyLaneKind ?? null,
      reason,
      recommended: `An untrusted dispatch record was ignored (the seat fell to the strictest baseline). If this is a LEGIT record at a new layout, move it to the container form (\`<...>/_crew/dispatch<N>/context.json\`) or use an attended \`.meta/*.dispatch.json\` record; if it is a FORGE (a worker planting its own seat), investigate the agent. Escalate to the PM.`,
    };
    // One mis-located record is ONE cause however many times it is re-read: this
    // is the path that wrote 103,214 byte-identical records over ten days.
    appendIncident(dir, record, incidentRepeatKey(record.kind, [recordPath, reason]));
  } catch { /* reporting must never disturb record resolution */ }
}

/** W-267 production probe: the live git facts of a commit's target repo. Kept out
 * of `evaluate` so the evaluator stays subprocess-free and unit-testable; every
 * failure yields null, leaving the rule inert rather than fail-closed on a
 * non-repo path. */
export function gitCommitRepoProbe(dir: string): CommitRepoFacts | null {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync(requireRuntimeExecutable("git"), ["-C", dir, ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true });
    } catch { return null; }
  };
  const shape = git(["rev-parse", "--show-toplevel", "--git-common-dir"]);
  if (!shape) return null;
  const [topLevelRaw = "", commonDirRaw = ""] = shape.trim().split(/\r?\n/).map((line) => line.trim());
  if (!topLevelRaw || !commonDirRaw) return null;
  const gitDir = resolve(dir, commonDirRaw);
  // One shared derivation for every "common gitdir -> main worktree root" site.
  const mainWorktreeRoot = mainWorktreeRootFromGitDir(gitDir);
  const headRef = (git(["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "").trim();
  const refParts = headRef.split("/");
  const pmId = refParts[0] === "garelier" && refParts.at(-1) === "studio" ? refParts[2] ?? "" : "";
  const targetRoot = resolve(mainWorktreeRoot);
  const samePath = (left: string, right: string): boolean => {
    const normalized = (value: string) => resolve(value).replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
    const a = normalized(left);
    const b = normalized(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  };
  let mergeGateProbeError = "";
  const mergeGateActive = (() => {
    if (!pmId) return false;
    const plant = resolvePlant(targetRoot);
    if (plant.issues.some((entry) => entry.level === "error")
      || !plant.controlRoot || !plant.targetRoot
      || !samePath(plant.targetRoot, targetRoot)) {
      mergeGateProbeError = plant.issues.filter((entry) => entry.level === "error")
        .map((entry) => `${entry.code}: ${entry.message}`).join("; ")
        || "Plant resolution did not bind this Git main worktree to one control root";
      return false;
    }
    const gateRoot = join(plant.controlRoot, "__garelier", pmId, "runtime", "merge_gate");
    const lockPath = join(gateRoot, "locks", "active.lock");
    let lock: Record<string, unknown>;
    try {
      lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    } catch {
      return false;
    }
    const pid = typeof lock.pid === "number" && Number.isInteger(lock.pid) && lock.pid > 0 ? lock.pid : 0;
    const requestId = typeof lock.request_id === "string" ? lock.request_id.trim() : "";
    const requestFile = typeof lock.request_file === "string" ? lock.request_file.trim() : "";
    const lockTarget = typeof lock.target_root === "string" ? lock.target_root.trim() : "";
    if (!pid || !requestId || !requestFile.endsWith(".json") || basename(requestFile) !== requestFile
      || !isAbsolute(lockTarget) || !samePath(lockTarget, targetRoot) || !pidAlive(pid)) return false;
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(readFileSync(join(gateRoot, "requests", requestFile), "utf8")) as Record<string, unknown>;
    } catch {
      return false;
    }
    const requestTarget = typeof request.target_root === "string" ? request.target_root.trim() : "";
    return request.request_id === requestId
      && request.studio_branch === headRef
      && isAbsolute(requestTarget)
      && samePath(requestTarget, targetRoot);
  })();
  return {
    topLevel: resolve(topLevelRaw),
    mainWorktreeRoot,
    headRef,
    stagedPaths: (git(["diff", "--cached", "--name-only"]) ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    mergeGateActive,
    mergeGateProbeError: mergeGateProbeError || undefined,
  };
}

/** Resolve exactly one merge source through Git's own revision/ref rules.
 * `--symbolic-full-name` turns every accepted shorthand into its canonical
 * namespace. Object IDs, revision expressions without one symbolic ref,
 * ambiguity, and lookup failures return null and therefore fail closed. */
export function gitCanonicalRefProbe(dir: string, ref: string): string | null {
  try {
    const out = execFileSync(
      requireRuntimeExecutable("git"),
      ["-C", dir, "rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", ref],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true },
    );
    const refs = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return refs.length === 1 && refs[0]!.startsWith("refs/") ? refs[0]! : null;
  } catch {
    return null;
  }
}

/** Resolve the two-sided topology contract for a local merge source.
 *
 * A source already reachable from integration is safe target tracking even if a
 * zero-change lane shares its tip. Otherwise every Garelier lane whose history
 * contains the source is returned, catching aliases to historical unpublished
 * lane commits after the lane itself has advanced. */
export function gitMergeSourceTopologyProbe(dir: string, ref: string, integrationRef: string): GitMergeSourceTopology | null {
  try {
    const executable = requireRuntimeExecutable("git");
    const sourceTip = execFileSync(
      executable,
      ["-C", dir, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true },
    ).trim();
    const integrationTip = execFileSync(
      executable,
      ["-C", dir, "rev-parse", "--verify", "--end-of-options", `${integrationRef}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true },
    ).trim();
    if (!/^[0-9a-f]{40,64}$/.test(sourceTip) || !/^[0-9a-f]{40,64}$/.test(integrationTip)) return null;
    let sourceInIntegration = false;
    try {
      execFileSync(
        executable,
        ["-C", dir, "merge-base", "--is-ancestor", sourceTip, integrationTip],
        { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"], timeout: 5000, windowsHide: true },
      );
      sourceInIntegration = true;
    } catch (error) {
      if ((error as { status?: number }).status !== 1) return null;
    }
    const out = execFileSync(
      executable,
      ["-C", dir, "for-each-ref", "--format=%(refname)", `--contains=${sourceTip}`, "refs/heads/garelier/"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true },
    );
    return {
      sourceTip,
      integrationTip,
      sourceInIntegration,
      containingLaneRefs: out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** Hook-side permission resolution. Ambient role remains useful for ordinary
 * role defaults, but it is not authority to mint the external-operation
 * profile: Concierge requires a resolved record or an explicit harness-owned
 * GARELIER_PERMISSION_PROFILE. The latter and the record are both unsigned
 * local inputs; their accepted trust boundary is the protected control-path /
 * process environment plus the record reader's name and cwd-containment checks,
 * not cryptographic integrity (W-305/F3). */
export function resolveRuntimeProfile(
  record: DispatchPermissionRecord | null,
  envProfile: string | undefined,
  role: string | undefined,
  agentName: string | null,
): PermissionProfileName | undefined {
  if (record) return record.permission_profile;
  if (envProfile && envProfile in PERMISSION_PROFILES) return envProfile as PermissionProfileName;
  if (role) {
    const fallback = profileForRole(role);
    return fallback === "concierge" ? "baseline-destructive" : fallback;
  }
  return agentName ? "baseline-destructive" : undefined;
}

/** Live configured URLs for one named remote. Failures return null so scoped
 * Concierge egress fails closed instead of treating an unresolved name as
 * approved. */
export function gitRemoteUrlProbe(dir: string, remote: string): string[] | null {
  try {
    const out = execFileSync(
      requireRuntimeExecutable("git"),
      ["-C", dir, "remote", "get-url", "--all", remote],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true },
    );
    const urls = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return urls.length ? urls : null;
  } catch {
    return null;
  }
}

async function main() {
  let out: string | null = null;
  try {
    const stdin = await Bun.stdin.text();
    const payload: HookPayload = stdin.trim() ? JSON.parse(stdin) : {};
    const tool = payload.tool_name ?? "";
    const command = payload.tool_input?.command ?? "";
    // W-205 N2: NotebookEdit names its target `notebook_path`; the other file tools use
    // `file_path`. Take whichever the payload carries.
    const filePath = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path ?? "";
    const isShell = /^(Bash|PowerShell|Shell)$/i.test(tool);
    // W-205: the harness Edit/Write/MultiEdit/NotebookEdit tools carry a file path (not
    // a command) and bypass the shell entirely — fence them so an out-of-worktree edit
    // is denied. (Read is read-only and needs no fence; this is the full file-mutation set.)
    const isFileEdit = /^(Edit|Write|MultiEdit|NotebookEdit)$/i.test(tool);
    if ((!isShell && !isFileEdit) || (isShell && !command) || (isFileEdit && !filePath)) {
      process.exit(0);
    }
    const sessionCwd = normalizePathFlavor(payload.cwd ?? process.cwd());
    const role = process.env.GARELIER_ROLE?.toLowerCase();
    const agentName = resolveAgentName(payload);
    const record = findDispatchPermissionRecord(sessionCwd, agentName, process.env, command);
    const profile = resolveRuntimeProfile(record, process.env.GARELIER_PERMISSION_PROFILE, role, agentName);
    // W-575 / W-539 (bug 2) / FORK-D (ii): ONE position authority, in priority
    // order — the seat's own dispatch record, then the ambient session cwd. Every
    // downstream consumer (profile resolution above, the git probe base, the
    // relative-target resolution, `cd` fence checks) reads this one value, so the
    // same seat typing the same command gets the same verdict from the Bash tool
    // and the PowerShell tool. Previously the ONLY position input was the hook
    // payload's `cwd`, which is whatever the shell was left in: a seat whose shell
    // sat elsewhere resolved a foreign — or no — profile, and a `git merge` inside
    // a dispatch checkout had its HEAD read from the session's repository rather
    // than from the checkout the command targets.
    //
    // The record's worktree is not a widening: it is the root that record already
    // grants, and the fence roots come from the same record. An explicit in-command
    // `cd <abs>` / `git -C <abs>` still overrides per segment further down
    // (segmentCdBases / commandRuntimeBases), which is the third rung of the same
    // order. Nothing here repairs a bad position — an unresolvable record simply
    // leaves the session cwd in place and says so in the refusal.
    const recordWorktree = record?.worktree?.trim() ? normalizePathFlavor(record.worktree) : undefined;
    const cwd = recordWorktree ?? sessionCwd;
    const positionOrigin = recordWorktree ? "dispatch_record" as const : "session_cwd" as const;
    const decision = isFileEdit
      ? evaluateFileEdit({
          toolName: tool,
          filePath,
          cwd,
          worktree: record?.worktree,
          fenceRoots: record?.fence_roots,
          policy: loadPolicy(cwd, process.env),
          seatRecordUnresolved: Boolean(agentName) && !record,
          agentName,
        })
      : evaluate({
          command,
          tool,
          role: record?.role ?? role,
          containerDir: process.env.GARELIER_CONTAINER,
          worktree: record?.worktree,
          cwd,
          policy: loadPolicy(cwd, process.env),
          profile,
          dispatchRecordBacked: Boolean(record),
          fenceRoots: record?.fence_roots,
          targetRoot: record?.project_root,
          qualityGateCommands: record?.quality_gate_commands,
          executionRoute: record?.execution_route,
          approvedRemoteDestinations: record?.approved_remote_destinations,
          gitEnvironmentContext: Object.keys(process.env).filter(isAmbientNonParityRepositorySelector),
          gitleaksConfigEnvironment: ["GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML"]
            .filter((name) => Boolean(process.env[name]?.trim())),
          additionalRoots: record?.additional_roots,
          shellScriptProbe: gitTrackedScriptIdentityVerified,
          // W-187: a named seat that resolved NO record from this cwd fell to
          // baseline-destructive — the fingerprint of the cwd-mismatch class. Surface it
          // (+ the resolved name) so a fail-closed profile_unknown deny carries the
          // cwd-contract diagnostic instead of a generic block.
          seatRecordUnresolved: Boolean(agentName) && !record,
          agentName,
          positionOrigin,
          positionRecordPath: record?.source,
          // W-267: live git facts for a `git commit`'s target repo, supplied here so
          // evaluate() stays subprocess-free.
          commitRepo: gitCommitRepoProbe,
          remoteUrlProbe: gitRemoteUrlProbe,
          canonicalRefProbe: gitCanonicalRefProbe,
          mergeSourceTopologyProbe: gitMergeSourceTopologyProbe,
        });
    // For a file edit the "command" surfaced in trace/report is the target file_path.
    const traceCtx = { tool, command: isFileEdit ? filePath : command, cwd, payload, resolvedAgent: agentName, record, profile };
    maybeTraceDecision(decision, traceCtx, process.env);
    // W-164: every deny / ask also lands a PM-readable report in incidents.jsonl.
    maybeWriteGuardReport(decision, traceCtx, process.env);
    out = hookOutput(decision);
  } catch (err) {
    // fail-safe: never fail-open. Ask the user instead.
    out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `[command_guard:error] guard failed (${String(
          err,
        )}); defaulting to ask.`,
      },
    });
  }
  if (out) process.stdout.write(out + "\n");
  process.exit(0);
}

if (import.meta.main) {
  void main();
}
