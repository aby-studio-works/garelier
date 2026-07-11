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
import { readFileSync, existsSync } from "node:fs";
import { resolve, sep, dirname, join } from "node:path";

export type Action = "allow" | "ask" | "deny";

export interface Decision {
  action: Action;
  /** stable rule id, e.g. "pipe_to_shell" */
  rule: string;
  reason: string;
}

export interface GuardInput {
  command: string;
  /** tool name from the hook (Bash / PowerShell / Shell). */
  tool?: string;
  /** GARELIER_ROLE, lowercased by the caller (e.g. "worker", "concierge"). */
  role?: string;
  /** GARELIER_CONTAINER — the role's own worktree root; recursive deletes are
   *  allowed only under here. Falls back to cwd. */
  containerDir?: string;
  cwd?: string;
  policy?: GuardPolicy;
}

/** Per-class action override + the network allow-list. */
export interface GuardPolicy {
  enabled: boolean;
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
  | "codex_raw_exec"
  | "recursive_delete"
  | "indirect_delete"
  | "force_write"
  | "secret_file";

export const DEFAULT_POLICY: GuardPolicy = {
  enabled: true,
  network_allow_domains: [],
  actions: {},
};

const ESCALATE = "If this is genuinely required, do not work around it — escalate to the PM.";
const ESCALATE_EGRESS =
  "External sends go through the Concierge only (DEC-025); escalate to the PM instead of sending directly.";

const SEVERITY: Record<Action, number> = { allow: 1, ask: 2, deny: 3 };

// --- helpers ---------------------------------------------------------------

/** Split a command into segments on ; newline && || and | so a rule that
 *  matches one segment (e.g. `echo hi; rm -rf /`) is not hidden by the rest.
 *  The pipe-to-shell rule is checked on the WHOLE command separately because
 *  it depends on the `|` that this split removes. */
export function splitSegments(command: string): string[] {
  return command
    .split(/[;\n]|&&|\|\|?|\bthen\b|\bdo\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
// or POSIX (W-036). `path.resolve()` only recognizes drive letters/UNC as
// absolute on win32 — on a POSIX host (e.g. the publish-repo Linux CI runner)
// `resolve(cwd, "C:/Windows/Temp")` silently joins it as a relative subpath
// of cwd instead of rejecting it as absolute, so a container-scope check that
// passes locally on Windows can allow the same command on Linux. Matching the
// drive-letter / UNC prefix here (a pure string check) makes the "is this an
// absolute, non-container-relative path" judgment identical on every host.
const DANGEROUS_PATH = /^(\/|~|~\/|\/\*|\.|\.\.|\*|\$[A-Za-z_]|[A-Za-z]:[\\/]|\\\\)/;

function underContainer(p: string, container: string, cwd: string): boolean {
  if (DANGEROUS_PATH.test(p)) return false;
  if (p.includes("..")) return false;
  const base = container || cwd;
  if (!base) return false;
  const abs = resolve(cwd || base, p);
  const root = resolve(base);
  return abs === root || abs.startsWith(root + sep);
}

// --- rule tables -----------------------------------------------------------

const RE = {
  pipeToShell:
    /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod|fetch)\b[\s\S]*?\|\s*(sudo\s+)?(sh|bash|zsh|dash|ash|pwsh|powershell|python[0-9.]*|perl|ruby|node)\b/i,
  netTool: /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b/i,
  uploadFlags:
    /(?:^|\s)(-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|-d\b|--data\b|--data-[a-z]+\b|-F\b|--form\b|-T\b|--upload-file\b|-Method\s+(?:Post|Put|Patch|Delete)|-Body\b|-InFile\b|-Form\b)/i,
  installRun: /\b(uvx|pipx\s+run|pnpm\s+dlx)\b/i,
  // W-039: raw `codex exec` (vs the dispatch_codex_producer.sh wrapper).
  codexExec: /(?:^|[\s"'/\\])codex(?:\.exe|\.cmd)?["']?\s+exec\b/i,
  codexSandboxReadOnly: /--sandbox[=\s]+["']?read-only\b/i,
  codexSandboxDanger: /--sandbox[=\s]+["']?danger-full-access\b/i,
  npxRemote: /\bnpx\s+(?!-|\.\/|\.\\|\/)[a-z0-9@][^\s]*/i,
  rmRecursive: /\brm\s+(?:-\S+\s+)*-\S*r/i, // rm with an r flag (recursive)
  psRemoveRecurse: /\bRemove-Item\b[\s\S]*-Recurse\b/i,
  rdRecurse: /\b(rd|rmdir)\b[\s\S]*\/s\b/i,
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
  gitCheckoutDiscard: /\bgit\s+checkout\b[^\n;]*\s--(\s|$)/i, // `checkout -- <path>` (not branch switch)
  // W-059: destructive command family + shell indirection heuristic. A
  // one-level `$VAR` / `$(...)` / backtick can materialize a `-rf` / `--hard` /
  // `-fdx` flag or an out-of-container target only at shell-expansion time,
  // after the literal-flag rules have already scanned the raw text.
  destructiveCmd: /\b(?:rm|del|rd|rmdir|Remove-Item)\b|\bgit\s+(?:reset|clean)\b/i,
  shellIndirection: /\$[A-Za-z0-9_{(]|`/,
  secretName: /(\.db|\.sqlite3?|\.env(?:\.[a-z0-9_-]+)?|credentials)\b/i,
  overwriteRedirect: /(?<!>)>(?!>)\s*("[^"]+"|'[^']+'|[^\s&|]+)/,
  psOverwrite: /\b(Set-Content|Out-File|New-Item)\b/i,
  overwriteCp: /\b(cp\s+-\S*f|mv|tee)\b/i,
  deleteCmd: /\b(rm|del|Remove-Item)\b/i,
};

function withAction(policy: GuardPolicy, rule: RuleId, fallback: Action): Action {
  return policy.actions[rule] ?? fallback;
}

// --- core evaluation -------------------------------------------------------

export function evaluate(input: GuardInput): Decision {
  const policy = input.policy ?? DEFAULT_POLICY;
  if (!policy.enabled) return { action: "allow", rule: "disabled", reason: "" };

  const command = input.command ?? "";
  const role = (input.role ?? "").toLowerCase();
  const isConcierge = role === "concierge";
  const cwd = input.cwd ?? process.cwd();
  const container = input.containerDir ?? cwd;
  const decisions: Decision[] = [];

  // Rule 1 — pipe-to-shell (checked on the whole command; the pipe matters).
  if (RE.pipeToShell.test(command)) {
    decisions.push({
      action: withAction(policy, "pipe_to_shell", "deny"),
      rule: "pipe_to_shell",
      reason: `Piping downloaded content straight into a shell runs unreviewed remote code (install-and-run). ${ESCALATE}`,
    });
  }

  for (const seg of splitSegments(command)) {
    // Rule 2 — network egress / off-list GET.
    if (RE.netTool.test(seg)) {
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
      !isConcierge &&
      (RE.gitPushAny.test(seg) || RE.gitFetchPull.test(seg) || RE.gitRemoteWrite.test(seg))
    ) {
      decisions.push({
        action: withAction(policy, "git_egress", "deny"),
        rule: "git_egress",
        reason: `Reaching a remote with git (push / fetch / pull / remote add|set-url) is an external send. ${ESCALATE_EGRESS}`,
      });
    }

    // Rule 3 — install-and-run tools (W-049).
    if (RE.installRun.test(seg) || RE.npxRemote.test(seg)) {
      decisions.push({
        action: withAction(policy, "install_run", "deny"),
        rule: "install_run",
        reason: `Install-and-run tool fetches and executes a package in one step (W-049 package policy). Add a pinned dependency + lockfile and run the local binary instead. ${ESCALATE}`,
      });
    }

    // Rule 3b — raw `codex exec` (W-039): a Codex producer must go through
    // dispatch_codex_producer.sh — the wrapper grants --add-dir for the project
    // root / dispatch container / result dir, which a raw exec in a dispatch
    // worktree lacks (the worktree's .git points at the main repo). Without the
    // grants every process spawn dies (CreateProcessAsUserW 1312) and reads as a
    // broken sandbox (2026-07-10 PM misdiagnosis). Read-only probes stay allowed;
    // danger-full-access is denied outright (the wrapper refuses it too — it
    // needs explicit per-use user approval, never a default).
    if (RE.codexExec.test(seg)) {
      if (RE.codexSandboxDanger.test(seg)) {
        decisions.push({
          action: withAction(policy, "codex_raw_exec", "deny"),
          rule: "codex_raw_exec",
          reason: `codex --sandbox danger-full-access requires explicit user approval per use and is never launched raw (dispatch_codex_producer.sh refuses it). ${ESCALATE}`,
        });
      } else if (!RE.codexSandboxReadOnly.test(seg)) {
        decisions.push({
          action: withAction(policy, "codex_raw_exec", "ask"),
          rule: "codex_raw_exec",
          reason: `Raw \`codex exec\` lacks the --add-dir grants (project root / dispatch container / result dir) and dies with CreateProcessAsUserW 1312 in a dispatch worktree. Launch via dispatch_codex_producer.sh — dispatch_prepare emits the ready-to-run launch_cmd. ${ESCALATE}`,
        });
      }
    }

    // Rule 4 — recursive delete: allowed only under the role's container.
    const isRecursiveDelete =
      RE.rmRecursive.test(seg) || RE.psRemoveRecurse.test(seg) || RE.rdRecurse.test(seg);
    if (isRecursiveDelete) {
      const targets = pathTokens(seg);
      const outside =
        targets.length === 0 || targets.some((t) => !underContainer(t, container, cwd));
      if (outside) {
        decisions.push({
          action: withAction(policy, "recursive_delete", "deny"),
          rule: "recursive_delete",
          reason: `Recursive delete outside your own worktree (${container}) is unrecoverable. Inventory the targets and get approval first. ${ESCALATE}`,
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
    if (RE.destructiveCmd.test(seg) && RE.shellIndirection.test(seg)) {
      decisions.push({
        action: withAction(policy, "indirect_delete", "ask"),
        rule: "indirect_delete",
        reason: `A delete / reset / clean command with shell indirection ($VAR, $(...), backtick) can expand to flags or targets the guard cannot verify (e.g. \`F=-rf; rm $F\`). Inline the literal flags and targets so they can be checked. ${ESCALATE}`,
      });
    }

    // Rule 6 — DB / secret files: delete or overwrite.
    if (RE.secretName.test(seg)) {
      const isDelete = RE.deleteCmd.test(seg);
      const isOverwrite =
        RE.overwriteRedirect.test(seg) || RE.psOverwrite.test(seg) || RE.overwriteCp.test(seg);
      if (isDelete || isOverwrite) {
        const targets = pathTokens(seg).filter((t) => RE.secretName.test(t));
        const anyOutside =
          targets.length === 0 || targets.some((t) => !underContainer(t, container, cwd));
        decisions.push({
          action: anyOutside
            ? withAction(policy, "secret_file", "deny")
            : (policy.actions.secret_file ?? "ask"),
          rule: "secret_file",
          reason: `Deleting or overwriting a database / secret file (*.db, *.sqlite, *.env, credentials*) can lose live state irrecoverably. Read it first and confirm. ${ESCALATE}`,
        });
      }
    }

    // Rule 5 — forced git history / tree rewrites → ask.
    if (
      RE.gitPushForce.test(seg) ||
      RE.gitResetHard.test(seg) ||
      RE.gitCleanForce.test(seg) ||
      RE.gitBranchForce.test(seg) ||
      RE.gitAmend.test(seg) ||
      RE.gitWorktreeRmForce.test(seg) ||
      RE.gitRestore.test(seg) ||
      RE.gitCheckoutDiscard.test(seg)
    ) {
      decisions.push({
        action: withAction(policy, "force_write", "ask"),
        rule: "force_write",
        reason: `Forced git rewrite discards state or rewrites a shared/gated SHA. Confirm the recovery path; only rewrite your own un-shared branch. ${ESCALATE}`,
      });
    }
  }

  if (decisions.length === 0) return { action: "allow", rule: "none", reason: "" };
  // Strictest wins; among equal severity, the first found.
  decisions.sort((a, b) => SEVERITY[b.action] - SEVERITY[a.action]);
  return decisions[0];
}

// --- policy loading (CLI side) ---------------------------------------------

function coerceAction(v: unknown): Action | undefined {
  return v === "allow" || v === "ask" || v === "deny" ? v : undefined;
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
    network_allow_domains: Array.isArray(domains) ? (domains as string[]) : [],
    actions,
  };
}

/** Resolve a policy file: explicit env path, else walk up from cwd to find
 *  __garelier/<pm_id>/control/operations/command_guard_policy.toml. */
export function findPolicyPath(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const explicit = env.GARELIER_COMMAND_GUARD_POLICY;
  if (explicit && existsSync(explicit)) return explicit;
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const gdir = join(dir, "__garelier");
    if (existsSync(gdir)) {
      const pmId = env.GARELIER_PM_ID;
      const candidates = pmId
        ? [join(gdir, pmId, "control", "operations", "command_guard_policy.toml")]
        : [];
      for (const c of candidates) if (existsSync(c)) return c;
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

// --- Claude Code PreToolUse hook wrapper -----------------------------------

interface HookPayload {
  tool_name?: string;
  cwd?: string;
  tool_input?: { command?: string };
}

/** Map a Decision to the PreToolUse hook stdout. "allow" emits nothing so the
 *  normal permission flow proceeds (we never auto-approve). */
export function hookOutput(d: Decision): string | null {
  if (d.action === "allow") return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: d.action,
      permissionDecisionReason: `[command_guard:${d.rule}] ${d.reason}`,
    },
  });
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
    const decision = evaluate({
      command,
      tool,
      role: process.env.GARELIER_ROLE?.toLowerCase(),
      containerDir: process.env.GARELIER_CONTAINER,
      cwd,
      policy: loadPolicy(cwd, process.env),
    });
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
