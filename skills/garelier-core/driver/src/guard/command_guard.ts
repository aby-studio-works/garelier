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
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, sep, dirname, join } from "node:path";
import { assertPathMutation } from "./path_guard.ts";
import { dispatchContainer } from "../workspace.ts";
import {
  QUALITY_GATE_PRESETS,
  READ_ONLY_INSPECTION_PRESETS,
} from "./quality_gate_presets.ts";
import {
  PERMISSION_PROFILES,
  profileForRole,
  type PermissionProfileName,
} from "./permission_profiles.ts";
// W-150: the record READER and WRITER (attended_record.ts) share one control-root
// resolver, so a written record is always found where the reader scans.
import { ancestorGareilerRoots, resolveControlRoot } from "./record_paths.ts";

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
  fenceRoots?: string[];
  /** Target-project root from a trusted dispatch fact pack. */
  targetRoot?: string;
  /** Resolved project quality-gate commands from the dispatch fact pack. */
  qualityGateCommands?: string[];
  /** W-170: the dispatch lane kind (`pm-direct` marks an attended PM-direct seat).
   *  A PM-direct seat gets `ask` (attended judgment) where a worker/producer seat
   *  gets `deny` for an indiscriminate process kill. */
  laneKind?: string;
}

export interface DispatchPermissionRecord {
  permission_profile: PermissionProfileName;
  /** Effective fence — the declared fence_roots PLUS any W-183 additional_roots
   *  (both carry the same record-level trust), so every downstream fence check
   *  honors a declared cross-repo binding with no further threading. */
  fence_roots: string[];
  /** W-183: the supplementary cross-repo roots that were merged into fence_roots,
   *  retained separately for reporting/clarity. Empty when none declared. */
  additional_roots?: string[];
  role?: string;
  agent_name?: string;
  worktree?: string;
  /** Resolved project commands from context.json; they override presets. */
  quality_gate_commands: string[];
  project_root?: string;
  /** W-155/W-170: top-level `lane_kind` marker (`pm-direct` for an attended
   *  PM-direct lane). Threaded to the process_kill family. */
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
  /** raw `codex exec` outside dispatch_codex_producer.ts (`codex_raw_exec`). Default false. */
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
  | "process_kill";

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
  // W-172: a git READ-ONLY search subcommand (grep / log / shortlog) carries a
  // quoted PATTERN that is search DATA, not a URL/path/ref — so unlike other git
  // commands it is NOT load-bearing, and its quoted metachars must be blanked so a
  // literal `git grep '>>'` / `git grep '<('` is not mistaken for a real redirect
  // or process substitution (and denied by segmentEscapesReadOnly).
  const isGitSearch = /^\s*(?:(?:sudo|command|env)\s+)*git\s+(?:grep|log|shortlog)\b/i.test(stripGitGlobalOpts(segment));
  const commandHead = new RegExp(
    `^\\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s]+)\\s+)*(?:(?:sudo|command|env)\\s+)*(?:${MUTATION_VERBS}|${REMOTE_EXEC_HEADS}|${PROCESS_KILL_HEADS}|git|curl|wget|iwr|invoke-webrequest|invoke-restmethod|cd)\\b`,
    "i",
  );
  if (!isGitSearch && commandHead.test(segment)) return segment;
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
  return splitShellParts(withoutHeredocBodies(command))
    .map(({ segment, separator }) => `${stripQuotedProse(segment)}${separator}`)
    .join("");
}

/** classificationCommand with each segment's leading git global options collapsed
 * (stripGitGlobalOpts), so a profile deny rule keyed on `git <subcommand>` also
 * matches `git -C <path> <subcommand>` (W-150). Deliberately separate from
 * classificationCommand, whose raw form the `-C` record-target extraction still
 * reads for cross-repo record lookup. */
function classificationForDeny(command: string): string {
  return splitShellParts(withoutHeredocBodies(command))
    .map(({ segment, separator }) => `${stripGitGlobalOpts(stripQuotedProse(segment))}${separator}`)
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

/** Per-segment resolution base for each segment in order: the last absolute `cd`
 * that ran BEFORE that segment, else the first trusted root. A `cd` only affects
 * the segments after it, so `cd /foreign && rm -rf x && cd /own` resolves the
 * delete against /foreign and cannot be laundered "inside" by the trailing `cd`
 * (W-119 R1). Undefined when nothing trusted resolves, so relative targets in
 * that segment fail closed. */
function segmentBases(segments: string[], roots: string[]): (string | undefined)[] {
  const bases: (string | undefined)[] = [];
  let activeCd: string | undefined;
  for (const seg of segments) {
    bases.push(activeCd ?? roots[0]);
    const cd = absoluteCdTarget(seg);
    if (cd) activeCd = cd;
  }
  return bases;
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
 * form the W-150 cross-repo record lookup now routes through the producer
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

function stripGitGlobalOpts(segment: string): string {
  const head = /^(\s*(?:(?:sudo|command|env)\s+)*git\s+)([\s\S]*)$/i.exec(segment);
  if (!head) return segment;
  // W-154: a QUOTE-AWARE tokenizer, not the old anchored `\s+\S+` pattern which
  // under-stripped three forms and let a denied subcommand slip the egress/force
  // floor: a quoted value with a space (`-C "/a b" push` — the `\S+` stopped at the
  // space, mangling the tail), an ATTACHED value (`-C/x push` / `-cfoo=bar` — no
  // `=`/space, so no anchored match at all), and an inline alias (`-c
  // alias.p='push --force' p`). Only the LEADING run of globals is dropped and the
  // tail is rebuilt from the RAW source so a subcommand's own later quotes are
  // untouched.
  const rest = head[2];
  const toks = shellTokensWithPos(rest);
  // No-argument global flags. W-172 N-B: the pager toggles (`-P`/`--no-pager`/
  // `--paginate`/`-p`) must be stripped so a leading `git --no-pager grep` still
  // classifies as a git search (isGitSearch) instead of a quoted-pattern false
  // positive.
  const flagGlobal = /^(?:-p|-P|--paginate|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--no-optional-locks|--icase-pathspecs|--no-lazy-fetch)$/i;
  // Argument-taking globals in `<opt> <value>` (separate value) form.
  const valueGlobal = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env)$/i;
  // Attached forms: `-C/path`, `-cfoo=bar`, `--git-dir=/x`.
  const attachedShort = /^-[Cc].+$/;
  const attachedLong = /^--(?:git-dir|work-tree|namespace|super-prefix|exec-path|config-env)=/i;
  const aliasDefs = new Map<string, string>();
  const noteAlias = (kv: string | undefined): void => {
    if (!kv) return;
    const m = /^alias\.([^=\s]+)=([\s\S]+)$/i.exec(kv);
    if (m) aliasDefs.set(m[1].toLowerCase(), m[2]);
  };
  let i = 0;
  for (; i < toks.length; i++) {
    const t = toks[i].text;
    if (flagGlobal.test(t)) continue;
    if (valueGlobal.test(t)) {
      if (/^-c$/i.test(t)) noteAlias(toks[i + 1]?.text); // -c alias.NAME=VALUE (separate)
      i++; // also consume the value token
      continue;
    }
    if (attachedShort.test(t)) {
      if (/^-c/i.test(t)) noteAlias(t.slice(2)); // -calias.NAME=VALUE (attached)
      continue;
    }
    if (attachedLong.test(t)) continue;
    break; // the first non-global token is the subcommand
  }
  if (i >= toks.length) return head[1].trimEnd(); // globals only, no subcommand
  const sub = toks[i];
  // W-154: git expands `-c alias.NAME=VALUE … NAME` to VALUE, so a `push --force`
  // hidden in an alias must reach the deny floor. When the invoked subcommand names
  // a defined alias, substitute its value in place (keeping the raw tail after it).
  const aliasValue = aliasDefs.get(sub.text.toLowerCase());
  if (aliasValue) return head[1] + aliasValue + rest.slice(sub.end);
  return head[1] + rest.slice(sub.start);
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
  // W-039: raw `codex exec` (vs the dispatch_codex_producer.ts wrapper).
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
  gitBranchForce: /\bgit\s+branch\b[^\n;]*\s-\S*[fD]/i,
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
 * dispatch (contains a digit, length ≥ 4: `_dispatch9`, `dispatch371`, `w170-…`),
 * so a kill filter referencing it (`-like '*_dispatch9*'`) proves the kill is
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
 * full fence-root path, or a distinctive fence segment (`_dispatch9`), in the SAME
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
 * fence-filtered kill are out of scope (null → allow). A worker/producer seat gets
 * deny (it must not stop another lane's build — the #371 incident); a PM-direct /
 * PM / record-less seat gets ask (attended judgment). */
function processKillDecision(command: string, input: GuardInput, policy: GuardPolicy): Decision | null {
  const fenceRoots = ownWorktreeRoots(input);
  const offending = splitKillStatements(command)
    .map(stripStatementComment) // W-173: a `#` comment cannot launder a bulk kill
    .find((stmt) => statementIsBulkKill(stmt) && !isFenceScopedKill(stmt, fenceRoots));
  if (!offending) return null; // no unscoped bulk kill statement → allow
  const producerSeat =
    (input.profile === "producer" || input.profile === "scout" ||
      (input.role ?? "").toLowerCase() === "worker") &&
    input.laneKind !== "pm-direct";
  const base: Action = producerSeat ? "deny" : "ask";
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
    reason: `Indiscriminate process kill by name/image can stop OTHER lanes' builds — the #371 incident killed the primary's post-merge verify. ${example}. ${ESCALATE}`,
  };
}

function normalizedToolInvocation(segment: string): { invocation: string; opaquePrefix: boolean } {
  let rest = segment.trim();
  let opaquePrefix = false;
  for (;;) {
    const callOperator = /^&\s+/.exec(rest);
    if (callOperator) { rest = rest.slice(callOperator[0].length); continue; }
    const wrapper = /^(sudo|command)\s+/i.exec(rest);
    if (wrapper) {
      rest = rest.slice(wrapper[0].length);
      if (/^--\s+/.test(rest)) rest = rest.replace(/^--\s+/, "");
      else if (/^-/.test(rest)) { opaquePrefix = true; break; }
      continue;
    }
    const env = /^env\s+/i.exec(rest);
    if (env) {
      rest = rest.slice(env[0].length);
      if (/^--\s+/.test(rest)) rest = rest.replace(/^--\s+/, "");
      else if (/^-/.test(rest)) { opaquePrefix = true; break; }
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

function normalizedToolInvocations(segment: string, maxDepth = 64): { invocations: string[]; opaqueWrapper: boolean } {
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
  return command.trim().replace(/\s+/g, " ");
}

function outputsStayWithinFence(segment: string, input: GuardInput): boolean {
  const roots = [...(input.fenceRoots ?? []), ...(input.targetRoot ? [input.targetRoot] : [])];
  if (roots.length === 0 || !input.cwd) return false;
  try {
    // Default build outputs (target/, node_modules/, coverage/, etc.) are under
    // cwd. An explicit output directory must independently stay in the fence.
    assertPathMutation(".", "write", { cwd: input.cwd, fenceRoots: roots });
    const outputFlags = /(?:--target-dir|--out-dir|--outdir|--outDir|--outfile)\s+("[^"]+"|'[^']+'|\S+)/g;
    for (const match of segment.matchAll(outputFlags)) {
      assertPathMutation(match[1].replace(/^['"]|['"]$/g, ""), "write", { cwd: input.cwd, fenceRoots: roots });
    }
    return true;
  } catch {
    return false;
  }
}

function isQualityGateCommand(segment: string, input: GuardInput): boolean {
  const normalized = normalizedCommand(segment);
  const configured = input.qualityGateCommands ?? [];
  const declared = configured.some((command) => normalizedCommand(command) === normalized);
  const preset = QUALITY_GATE_PRESETS.some(({ pattern }) => new RegExp(pattern, "i").test(normalized));
  return (declared || preset) && outputsStayWithinFence(segment, input);
}

// W-159: a PM-declared verify command the gate seat must run is frequently a
// COMPOUND or a non-preset script (a project census `bash scripts/census.sh`, a
// `cd checkout && bun test && tsc --noEmit` chain) — the WHOLE invocation is the
// unit the PM listed in the record's quality_gate_commands, so the per-segment
// preset/declared match (isQualityGateCommand) never recognizes it and the seat
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
function isDeclaredWholeCommand(input: GuardInput): boolean {
  const configured = input.qualityGateCommands ?? [];
  if (configured.length === 0) return false;
  const whole = normalizedCommand(input.command ?? "");
  if (!whole) return false;
  return configured.some((command) => normalizedCommand(command) === whole)
    && outputsStayWithinFence(input.command ?? "", input);
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
const WF_LONG_OUT_CORE = String.raw`(?:^|\s)--out(?:put|file|dir)`;
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
// The escape tests presence: the long flag must END (so `--output-format` is not a
// write, a harmless FP the extractor already avoided); the sort `-o` needs NO
// trailing constraint (for sort the flag consumes the rest as the file).
const WF_APPEND = new RegExp(WF_APPEND_CORE);
const WF_LONG_OUT = new RegExp(WF_LONG_OUT_CORE + String.raw`(?=$|[\s=])`, "i");
const WF_SORT_O = new RegExp(WF_SORT_O_CORE, "i");
const WF_FIND_WRITE = new RegExp(`${WF_FIND_FILE_CORE}\\b|${WF_FIND_DELETE_CORE}`, "i");
const WF_SED_INPLACE = new RegExp(WF_SED_INPLACE_CORE, "i");

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
  // an out-of-fence in-place edit (`sed -ibak … /etc/passwd`) on a producer seat's
  // in-fence band too, not only the read-only escape. The sed SCRIPT is NOT a file:
  // it is the `-e`/`--expression` / `-f`/`--file` argument, or (absent those) the
  // FIRST bare positional — skip exactly that one so an in-fence edit whose script
  // merely MENTIONS an out-of-fence path (`sed -i 's|/etc/hosts|x|' ./mine`) is not
  // false-denied. Every operand after the script is a real file to fence-check.
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

function isReadOnlyInspectionCommand(segment: string, input: GuardInput): boolean {
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
  const normalized = normalizedCommand(cleaned);
  const nonMutating = !MUTATION_HINT.test(cleaned) || isHeredocDocumentWrite(normalized);
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

/** W-179 (a): a shell CONTROL-STRUCTURE segment that is read-only-COMPATIBLE. When a
 * compound (`if …; then …; fi` / `for f in *; do …; done`) is split on `;`/`|`/`&&`,
 * its control keywords land as their own segments (`if grep …`, `then head …`,
 * `for f in *`, `do tail …`, `done`). A bare closer/keyword executes nothing; a
 * keyword FOLLOWED by an inner command is read-only iff that inner command is
 * (recurse); a `for X in LIST` header is read-only iff the LIST executes nothing (no
 * command substitution / process sub — those would run arbitrary code). Anything
 * else → false (FAIL-CLOSED: the compound then drops to the profile/family rules, so
 * a `do rm x` / `for f in $(curl …)` / `if curl … | sh` never reads as read-only). */
function isReadOnlyControlSegment(segment: string, input: GuardInput): boolean {
  const s = stripInertRedirects(segment).trim();
  // Bare keyword / block delimiter — binds a loop var or closes a block; no command.
  if (/^(?:then|else|do|done|fi|esac|in|\{|\})$/i.test(s)) return true;
  // `for X in LIST` / `select X in LIST`: the LIST is data (globs/literals). A
  // command substitution / process sub in it EXECUTES arbitrary code — exclude it.
  const forHead = /^(?:for|select)\s+\w+\s+in\b(.*)$/i.exec(s);
  if (forHead) return !/\$\(|`|[<>]\(/.test(forHead[1]);
  if (/^(?:for|select)\s+\w+\s*$/i.test(s)) return true; // `for f` (the `in …` on the next line)
  // `case X in` header: X is data; exclude command substitution.
  if (/^case\s+.+\s+in$/i.test(s)) return !/\$\(|`|[<>]\(/.test(s);
  // A keyword wrapping an inner command: the inner must itself be read-only.
  const kwInner = /^(?:if|elif|while|until|then|else|do)\s+(.+)$/i.exec(s);
  if (kwInner) {
    const inner = kwInner[1].trim();
    return isReadOnlyInspectionCommand(inner, input) || isPlainChangeDirectory(inner)
      || isReadOnlyControlSegment(inner, input);
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
  // `uniq in /x`), so profile_path_fence can catch an out-of-fence one on a producer
  // seat. The extraction is the SHARED writeFormTargets — the same vocabulary the
  // read-only escape uses — so the two layers can never drift (the `sort -bo`
  // bundled-flag hole came from two hand-kept copies).
  out.push(...writeFormTargets(segment, tokens));
  return out;
}

function profileDecisions(input: GuardInput): Decision[] {
  if (!input.profile) return [];
  const decisions: Decision[] = [];
  const policy = input.policy ?? DEFAULT_POLICY;
  const profile = PERMISSION_PROFILES[input.profile];
  // W-150: match deny rules against the git-normalized form so a `git -C <path>`
  // (or `-c k=v`) prefix cannot smuggle a denied subcommand past a profile floor.
  const denyClassified = classificationForDeny(input.command);
  for (const name of profileChain(input.profile)) {
    for (const rule of PERMISSION_PROFILES[name].deny) {
      if (new RegExp(rule.pattern, "i").test(denyClassified)) {
        decisions.push({ action: "deny", rule: `profile_${rule.id}`, reason: `${rule.reason}. ${ESCALATE}` });
      }
    }
  }
  const segments = splitSegments(input.command);
  const fenceRoots = input.fenceRoots ?? [];
  const classified = classificationCommand(input.command);
  // Resolve each segment's relative mutation targets against its own preceding
  // `cd` (or the dispatch fence anchor), not the hook's session cwd — a leaked
  // cross-dispatch cwd otherwise pushes a worker's own-worktree target outside
  // the fence and false-denies it (W-119, #348), and a trailing `cd` must not
  // launder an earlier out-of-fence write (W-119 R1).
  const bases = segmentBases(segments, ownWorktreeRoots(input));
  // W-164: the per-segment path fence is the `profile_path_fence` family, gated
  // by its own flag (default off = passthrough). The profile deny table and the
  // fail-closed `profile_unknown` band below are NOT family-gated (they are the
  // dispatch-seat core, not one of the named W-164 families).
  // W-177: gate on mutationTargets itself, not the coarser MUTATION_HINT — the
  // write-form flags it now models (`sort -o`, `--output`, `>>`, find `-delete`)
  // carry no MUTATION_HINT token, so the old pre-filter skipped the fence check and
  // a producer seat's out-of-fence write rode the W-122 in-fence band. Empty-target
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
  // `producer` only producers). Matched against the SAME git-normalized, prose-stripped
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
    if (matchesAnyPattern(rules.allow, denyClassified)) {
      decisions.push({ action: "allow", rule: "project_allow", reason: "" });
    }
  }
  if (decisions.length === 0) {
    // W-159: a whole-command verbatim match against the record's declared verify
    // commands is safe (a PM-listed compound / non-preset script), OR every
    // segment is independently a read-only / preset / declared / cd / control run.
    const safe = isDeclaredWholeCommand(input) || (segments.length > 0 && segments.every(
      (seg) => isReadOnlyInspectionCommand(seg, input) || isQualityGateCommand(seg, input)
        || isPlainChangeDirectory(seg) || isReadOnlyControlSegment(seg, input),
    ));
    // W-181: a gate seat's write is a legitimate VERDICT write only when EVERY
    // target lands IN-fence. The old check treated ANY mutation as a verdict write,
    // so an out-of-fence append (`grep x >> /etc/y`), tee (`… | tee /etc/y`), or
    // plain write on the gate seat rode this suppression and was ALLOWED whenever
    // the producer-oriented `path_fence` family flag was off — the shipped default
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
      // resolved, a profile that opts in (producer.unknown_action) may take that
      // relaxed action instead of failing closed — the in-fence band the user's
      // risk model tolerates. Without a fence, or for a profile with no
      // relaxation, keep the fail-closed `unknown`. This is an ALLOW/ASK
      // decision only; the global egress/delete/secret/force classes in
      // evaluate() still run afterward and each outranks it under strictest-wins,
      // so unknown-allow can never weaken the deny floor.
      const fenced = fenceRoots.length > 0;
      const action: Action = fenced && profile.unknown_action ? profile.unknown_action : profile.unknown;
      decisions.push({
        action,
        rule: "profile_unknown",
        reason: action === "allow"
          ? `No deny/ask class matched and every in-command mutation target is within the trusted fence; profile '${input.profile}' allows unknown in-fence commands (W-122).`
          : `Command does not match an allow pattern for profile '${input.profile}'; failing closed to ${action}. ${ESCALATE}`,
      });
    }
  }
  return decisions;
}

// --- core evaluation -------------------------------------------------------

export function evaluate(input: GuardInput): Decision {
  const policy = input.policy ?? DEFAULT_POLICY;
  const command = input.command ?? "";
  if (policy.install_guard_enabled) {
    const classified = classificationCommand(command);
    const expanded = splitShellSegments(withoutHeredocBodies(command)).map((segment) => normalizedToolInvocations(segment));
    const invocations = expanded.flatMap(({ invocations }) => invocations);
    if (RE.pipeToShell.test(classified)) return { action: "deny", rule: "pipe_to_shell", reason: "Comprehensive install guard blocks pipe-to-shell execution for every seat." };
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
  if (!policy.enabled) return { action: "allow", rule: "disabled", reason: "" };

  const classified = classificationCommand(command);
  const role = (input.role ?? "").toLowerCase();
  const isConcierge = role === "concierge";
  // Own-worktree fence for the destructive rules, derived without the hook's
  // session cwd (W-119). Each segment resolves relative targets against its own
  // preceding `cd` (segmentBases), so a trailing `cd` cannot launder an earlier
  // out-of-fence delete (W-119 R1).
  const fenceRoots = ownWorktreeRoots(input);
  const segments = splitSegments(command);
  const bases = segmentBases(segments, fenceRoots);

  // W-176 (0): a WHOLLY read-only command is ALLOWED on EVERY profile — no ask,
  // never fail-closed. A read-only inspection (grep/rg/git log·show·diff/ls/cat/…
  // + build/test presets) mutates nothing and reaches no remote, so it needs no
  // approval regardless of seat (baseline-destructive / gate included). A compound
  // is read-only when EVERY segment is a read-only inspection or a plain `cd`
  // (even out of fence — a cd followed only by read-only cannot mutate). A single
  // non-read-only segment (`… | sh`, `curl -X POST`, `rm`, `git push`) breaks this
  // and the command falls through to the profile + family rules below, where the
  // fail-closed-to-ask still guards a command that CANNOT be proven read-only.
  if (segments.length > 0 && segments.every((seg) =>
    isReadOnlyInspectionCommand(seg, input) || isPlainChangeDirectory(seg) || isReadOnlyControlSegment(seg, input))) {
    return { action: "allow", rule: "read_only", reason: "" };
  }

  const decisions: Decision[] = [];

  decisions.push(...profileDecisions(input));

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

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segBase = bases[i];
    // W-150: the git rules below match against the git-normalized segment so a
    // `git -C <path>` / `-c <k=v>` prefix cannot hide the subcommand from the
    // egress / force / destructive deny floor.
    const gitSeg = stripGitGlobalOpts(seg);
    // Rule 2 — network egress / off-list GET. W-164: gated by the per-family
    // flag (covers both network_egress and network_offlist; default off).
    if (policy.network_egress_guard_enabled && RE.netTool.test(seg)) {
      if (RE.uploadFlags.test(seg)) {
        if (!isConcierge)
          decisions.push({
            action: withAction(policy, "network_egress", "deny"),
            rule: "network_egress",
            reason: `Outbound request carries data (upload / POST / PUT / PATCH). ${ESCALATE_EGRESS}`,
          });
      } else {
        const hosts = extractHosts(seg);
        const offlist = hosts.filter((h) => !hostAllowed(h, policy.network_allow_domains));
        if (!isConcierge && (hosts.length === 0 || offlist.length > 0)) {
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
    // remote and so leave the local sandbox — the Concierge's exclusive role
    // (DEC-025; injection_and_egress.md Rule 2). Same isConcierge exemption as
    // the network-egress rule above. Orthogonal to force_write below: a
    // non-Concierge `git push --force` is denied HERE as egress (the stronger
    // concern) while the Concierge's own force push still falls to force_write
    // (ask) — strictest-wins picks deny for the former, ask for the latter.
    if (
      policy.git_egress_guard_enabled &&
      !isConcierge &&
      (RE.gitPushAny.test(gitSeg) || RE.gitFetchPull.test(gitSeg) || RE.gitRemoteWrite.test(gitSeg))
    ) {
      decisions.push({
        action: withAction(policy, "git_egress", "deny"),
        rule: "git_egress",
        reason: `Reaching a remote with git (push / fetch / pull / remote add|set-url) is an external send. ${ESCALATE_EGRESS}`,
      });
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

    // Rule 3b — raw `codex exec` (W-039): a Codex producer must go through
    // dispatch_codex_producer.ts — the wrapper grants --add-dir for the project
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
          reason: `codex --sandbox danger-full-access requires explicit user approval per use and is never launched raw (dispatch_codex_producer.ts refuses it). ${ESCALATE}`,
        });
      } else if (!RE.codexSandboxReadOnly.test(seg)) {
        decisions.push({
          action: withAction(policy, "codex_raw_exec", "ask"),
          rule: "codex_raw_exec",
          reason: `Raw \`codex exec\` lacks the --add-dir grants (project root / dispatch container / result dir) and dies with CreateProcessAsUserW 1312 in a dispatch worktree. Launch via dispatch_codex_producer.ts — dispatch_prepare emits the ready-to-run launch_cmd. ${ESCALATE}`,
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

    // Rule 5 — forced git history / tree rewrites → ask. W-164: per-family flag.
    if (
      policy.force_write_guard_enabled &&
      (RE.gitPushForce.test(gitSeg) ||
      RE.gitResetHard.test(gitSeg) ||
      RE.gitCleanForce.test(gitSeg) ||
      RE.gitBranchForce.test(gitSeg) ||
      RE.gitAmend.test(gitSeg) ||
      RE.gitWorktreeRmForce.test(gitSeg) ||
      (RE.gitRestore.test(gitSeg) && !RE.gitRestoreStagedOnly.test(gitSeg)) ||
      RE.gitCheckoutDiscard.test(gitSeg))
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
    // W-174 R3: a `context.json` is trusted by a POSITIVE LOCATION ALLOWLIST, not a
    // denylist of forge shapes. A worker's checkout / lane worktree is writable
    // area it fully controls, so a planted `context.json` (fabricated profile /
    // fence / lane_kind to defeat the guard — the hole W-170 Guardian found) can
    // sit anywhere with any claimed fields; a denylist of "known bad" spots always
    // left a gap (a 1-field `worktree` claim slipped past R2 — Observer). The
    // dispatcher writes the container record at exactly ONE shape: `<container>/
    // context.json` where `<container>` is a dispatch container (`_?dispatch<N>`)
    // and (when present) the record's `worktree` resolves UNDER that container
    // (`<container>/checkout`). ONLY that shape is trusted; every other location is
    // rejected — regardless of the claimed worktree/fence. (`_crew/lanes/.meta/
    // *.dispatch.json` lane records are a different basename, skipped here.)
    // fence_roots is NOT the yardstick (a PM-direct seat fences the whole repo root
    // — R1). A rejected record is REPORTED (`guard_record_rejected`) so an in-flight
    // forge, or a legit-migration misdetection, is visible — never a silent drop.
    // NOTE (W-174 residual): a determined worker can still mimic the allowlist shape
    // INSIDE its own worktree (create `<own>/_dispatch9/checkout`, cd in, plant) —
    // fully closing that needs a dispatcher-written provenance nonce (row residual).
    if (/(?:^|[\\/])context\.json$/i.test(path)) {
      const containerLeaf = recordDir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
      const isDispatchContainer = /^_?dispatch\d+$/i.test(containerLeaf);
      const worktreeUnderContainer = worktree ? pathIsInside(worktree, recordDir) : true;
      if (!(isDispatchContainer && worktreeUnderContainer)) {
        reportRejectedRecord(path, profile, resolvedRoots, typeof raw.lane_kind === "string" ? raw.lane_kind : undefined,
          isDispatchContainer ? "record worktree does not resolve under its dispatch container" : "context.json is not at a dispatch container (`_dispatch<N>/context.json`)");
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
    return {
      permission_profile: profile,
      fence_roots: [...new Set([...resolvedRoots, ...additionalRoots])],
      additional_roots: additionalRoots,
      role,
      agent_name: guard.agent_name ?? raw.agent_name ?? raw.owner,
      worktree,
      quality_gate_commands: [...new Set(qualityCommands)],
      project_root: typeof raw.project?.project_root === "string" ? raw.project.project_root : undefined,
      // W-155/W-170: top-level `lane_kind` marker (pm-direct) → process_kill = ask.
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
 * escalation — a producer lane's fence is its own worktree). */
function recordWorktreeContains(record: DispatchPermissionRecord | null, cwd: string): boolean {
  if (!record) return false;
  const c = resolve(cwd);
  const roots = [record.worktree, ...(record.fence_roots ?? [])].filter((r): r is string => !!r && r.trim().length > 0);
  return roots.some((r) => pathIsInside(c, resolve(r)));
}

/** W-129: gate seats (Guardian / Observer) get no dispatch worktree, so no record
 * is keyed to their name — the name lives in a producer context.json's
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
 * hand, not tied to a dispatch — e.g. a design-review Observer with no producer)
 * has no context.json keyed to its name and no `gate_agents` entry to synthesize
 * from, so every record lookup above returns null and it falls to a
 * baseline-destructive seat that ASKS on every inspection. When NOTHING resolves,
 * fall back to the garelier naming convention (`ga-<role>-<slug>`): a
 * `ga-(guardian|observer|refuter)-*` name IS a gate seat, so synthesize a
 * gate-profile record fenced to the nearest ancestor target root. Safe-direction
 * ONLY: the gate profile is STRICTER on mutation than baseline (mkdir/rm/git
 * commit are denied by its `gate_mutation` rule) while its read-only inspection
 * chains ride the W-118 allow path — so this can only turn an ask into an allow
 * for read-only work, or into a deny for a mutation; it never promotes a producer
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

/** Absolute `-C <dir>` chdir targets of a `git` segment (W-150). A cross-repo
 * `git -C <other-repo> …` names the repo it actually operates on; that repo — not
 * the hook's session cwd — is where the operator's dispatch record lives.
 * Restricted to a `git` head so an unrelated `-C` flag (`grep -C 3`) is never
 * mistaken for a chdir. Shell-expanded / relative targets yield nothing (they
 * depend on the ambient cwd the guard refuses to trust), matching absoluteCdTarget. */
function absoluteGitChdirTargets(segment: string): string[] {
  const s = stripInertRedirects(segment).trim();
  if (!/^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)\s+)*(?:(?:sudo|command|env)\s+)*git\b/i.test(s)) return [];
  const out: string[] = [];
  const re = /(?:^|\s)-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const path = m[1] ?? m[2] ?? m[3] ?? "";
    if (path && !/[$*?~`]/.test(path) && isAbsolutePath(path)) out.push(path);
  }
  return out;
}

/** Absolute directories a command explicitly operates in — a plain `cd <abs>` or
 * a `git -C <abs>`. In a cross-repo launch (session cwd = repo A, command targets
 * repo B) these name repo B, whose `__garelier` holds the operator's record even
 * though it is not an ancestor of the hook cwd (W-150). */
function commandTargetDirs(command: string): string[] {
  const dirs: string[] = [];
  for (const seg of splitSegments(command)) {
    const cd = absoluteCdTarget(seg);
    if (cd) dirs.push(cd);
    dirs.push(...absoluteGitChdirTargets(seg));
  }
  return [...new Set(dirs)];
}

/** Scan a single `__garelier` root for a dispatch/lane record whose agent name
 * matches, following the canonical crew → legacy → default precedence. Returns
 * the first match or null; a missing/racing runtime record leaves the caller
 * fail-safe and lets an outer root still be tried. */
function scanGareilerRootForAgent(root: string, agentName: string): DispatchPermissionRecord | null {
  const garelier = join(root, "__garelier");
  try {
    for (const pm of readdirSync(garelier)) {
      const pmRoot = join(garelier, pm);
      if (!statSync(pmRoot).isDirectory()) continue;
      // Discover ids from either physical layout, then resolve each through
      // workspace.ts so an interrupted migration still follows its canonical
      // crew -> legacy -> default precedence.
      const dispatchIds = new Set<string>();
      for (const base of [join(pmRoot, "_crew"), pmRoot]) {
        if (!existsSync(base)) continue;
        for (const name of readdirSync(base)) {
          const match = /^_?dispatch(\d+)$/.exec(name);
          if (match) dispatchIds.add(match[1]);
        }
      }
      for (const id of dispatchIds) {
        const candidate = join(dispatchContainer(root, pm, id), "context.json");
        if (!existsSync(candidate)) continue;
        const record = permissionRecordFrom(candidate);
        if (record?.agent_name === agentName) return record;
        const gate = gatePermissionRecord(candidate, agentName); // W-129
        if (gate) return gate;
      }
      const lanes = join(pmRoot, "_crew", "lanes");
      const legacyLanes = join(pmRoot, "lanes");
      for (const laneDir of [lanes, legacyLanes]) {
        const meta = join(laneDir, ".meta");
        if (!existsSync(meta)) continue;
        for (const file of readdirSync(meta).filter((f) => f.endsWith(".dispatch.json"))) {
          const record = permissionRecordFrom(join(meta, file));
          if (record?.agent_name === agentName) return record;
          const gate = gatePermissionRecord(join(meta, file), agentName); // W-129
          if (gate) return gate;
        }
      }
    }
  } catch { /* missing/racing runtime record -> caller remains fail-safe */ }
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
    for (const root of ancestorGareilerRoots(cwd)) {
      const record = scanGareilerRootForAgent(root, agentName);
      if (record) return record;
    }
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
  tool_input?: { command?: string };
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
    appendFileSync(join(dir, "incidents.jsonl"), JSON.stringify(record) + "\n");
  } catch { /* reporting must never disturb the guard's verdict */ }
}

/** W-174 R3: report a REJECTED (untrusted-location) dispatch record so an
 * in-flight forge attempt — or a legit-migration misdetection — is visible in the
 * pmAction pane, never a silent drop. Integrated into the same incidents.jsonl
 * stream as `guard_deny`/`guard_ask` (a `guard_record_rejected` kind). Carries the
 * planted file path and the record's CLAIMED profile / fence / lane_kind so the PM
 * can judge intent. Best-effort; runs only when a well-formed context.json is
 * rejected by the location allowlist (an absent/malformed file never reaches here). */
function reportRejectedRecord(recordPath: string, claimedProfile: string, claimedFence: string[], claimedLaneKind: string | undefined, reason: string): void {
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
      claimed_lane_kind: claimedLaneKind ?? null,
      reason,
      recommended: `An untrusted dispatch record was ignored (the seat fell to the strictest baseline). If this is a LEGIT record at a new layout, move it to the container form (\`<...>/_dispatch<N>/context.json\`) or use an attended \`.meta/*.dispatch.json\` record; if it is a FORGE (a worker planting its own seat), investigate the agent. Escalate to the PM.`,
    };
    appendFileSync(join(dir, "incidents.jsonl"), JSON.stringify(record) + "\n");
  } catch { /* reporting must never disturb record resolution */ }
}

async function main() {
  let out: string | null = null;
  try {
    const stdin = await Bun.stdin.text();
    const payload: HookPayload = stdin.trim() ? JSON.parse(stdin) : {};
    const tool = payload.tool_name ?? "";
    const command = payload.tool_input?.command ?? "";
    // Only the shell tools carry a command to guard.
    if (!/^(Bash|PowerShell|Shell)$/i.test(tool) || !command) {
      process.exit(0);
    }
    const cwd = payload.cwd ?? process.cwd();
    const role = process.env.GARELIER_ROLE?.toLowerCase();
    const agentName = resolveAgentName(payload);
    const record = findDispatchPermissionRecord(cwd, agentName, process.env, command);
    const profile = record?.permission_profile ?? (process.env.GARELIER_PERMISSION_PROFILE as PermissionProfileName | undefined) ?? (role ? profileForRole(role) : agentName ? "baseline-destructive" : undefined);
    const decision = evaluate({
      command,
      tool,
      role: record?.role ?? role,
      containerDir: process.env.GARELIER_CONTAINER,
      worktree: record?.worktree,
      cwd,
      policy: loadPolicy(cwd, process.env),
      profile,
      fenceRoots: record?.fence_roots,
      targetRoot: record?.project_root,
      qualityGateCommands: record?.quality_gate_commands,
      laneKind: record?.lane_kind,
    });
    const traceCtx = { tool, command, cwd, payload, resolvedAgent: agentName, record, profile };
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
