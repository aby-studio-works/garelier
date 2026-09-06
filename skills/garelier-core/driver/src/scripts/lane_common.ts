// Shared helpers for the W-095 attended-lane toolkit (lane_dispatch / lane_verify
// / lane_collect / lane_recover / lane_commit_plan). These commands mechanize the
// PM's hand-run isolated-worktree workflow (DEC-093 PM-directed route) on top of
// workspace_isolate.ts, so the lane layout MUST match it exactly:
//   worktree  = <repo>/__garelier/<pm_id>/_crew/lanes/<slug>/
//   branch    = garelier/isolate/<slug>
//   meta dir  = <repo>/__garelier/<pm_id>/_crew/lanes/.meta/
// The toolkit's own sidecars (prompt, instruction ledger, dispatch record) live
// in the meta dir alongside workspace_isolate's <slug>.json, so they never land
// on the lane branch. Read operations fall back to the pre-W-102
// <repo>/.garelier-work/ layout so an already-running lane can finish.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { PM_ID_RE } from "../config.ts";
import type { PermissionProfileName } from "../guard/permission_profiles.ts";
import { DISPATCH_RESULT_STATE_FIRST_LINE_CONTRACT } from "../dispatch/lane_status.ts";
import { resolveCommand } from "./_lib.ts";

export { DISPATCH_RESULT_STATE_FIRST_LINE_CONTRACT };

export const SLUG_RE = /^[a-z0-9-]+$/;
export { PM_ID_RE };

// W-448: keep each provider's load-bearing prompt marker beside the one shared
// predicate both launchers call. Claude's final-line recovery rule is emitted
// for every Claude preamble and proves the completion contract was included;
// the Codex-only sandbox marker continues to prove its stricter preamble.
export const CODEX_ROLE_PROMPT_CONTRACT_MARKER = "Codex-dispatched role sandbox contract:";
export const CLAUDE_ROLE_PROMPT_CONTRACT_MARKER = "Runtime recovery: the final line of every subagent final output";

export interface PromptContractCheck { ok: boolean; reason: string }

export function checkRolePromptContractMarker(
  promptText: string,
  marker: string,
  missingReason: string,
): PromptContractCheck {
  return marker.length > 0 && promptText.includes(marker)
    ? { ok: true, reason: "" }
    : { ok: false, reason: missingReason };
}

export interface CodexRoleContractOptions {
  worktree: string;
  branch: string;
  baseSha: string;
  subjectSuffix: string;
  trailer: string;
  seatTrailer?: string;
}

// W-641: the required gate is executed by the DOCK seat from the producer's
// register (`review_prepare.ts` → `gate_runner.ts --from-register`), on every
// provider. That path has no `--steps` route, so a register without this block
// is refused as `required_gate_block_missing` and the lane can never reach a
// Guardian/Observer seat. Before this was shared, the clauses lived only in
// `codexProviderContract`, so claude lanes were never told to emit the block and
// were structurally unable to produce a GREEN handoff — measured on #355/#437.
// Only the REASON differs per provider; the obligation and the block form do
// not, so both preambles interpolate this one definition.
export const REQUIRED_GATE_BLOCK_OPEN = "=== REQUIRED GATE (Dock-run) ===";
export const REQUIRED_GATE_BLOCK_CLOSE = "=== END REQUIRED GATE ===";

/** The reason a producer must not run the required gate itself. Codex is
 * additionally unable to (no heavy_compile_lock in the sandbox); an attended or
 * subprocess claude lane could, but must not, because the Dock run is the one
 * the handoff record and the gate seat are bound to. */
export const CODEX_REQUIRED_GATE_REASON =
  "the sandbox cannot take heavy_compile_lock, so you CANNOT run the required project gate yourself";
export const DOCK_RUN_REQUIRED_GATE_REASON =
  "the required project gate is run by the Dock seat from your register (`review_prepare.ts` → `gate_runner.ts --from-register`) under the heavy-compile lock, so you MUST NOT run it yourself";

/** Heavy gate delegation + register-step form + scoped self-gate: the three
 * clauses `gate_runner --from-register` depends on. Provider-independent. */
export function requiredGateDelegationContract(reason: string): string {
  return `- Heavy gate (W-157/#361/W-641): ${reason}. Run only safe standalone checks as interim evidence, then DELEGATE the required gate to the Dock seat by emitting a block \`${REQUIRED_GATE_BLOCK_OPEN}\` … \`${REQUIRED_GATE_BLOCK_CLOSE}\` listing the EXACT project-declared commands (one per line, or \`name: command …\`). gate_runner.ts classifies each worker-authored command through \`[quality_gate.register.steps]\`, checks touched-path coverage and declared test-tree inventory, appends \`[quality_gate.register.closure]\` as the terminal whole-project step, then applies command_guard under the lock. Missing policy, uncovered paths, undeclared trees, commands outside the declared prefixes, or guard denial all block GREEN. A register WITHOUT this block is refused as \`required_gate_block_missing\`, which is RED — there is no fallback to the project's fixed steps.
- Register-step form: each line is a bare project command relative to the checkout root and MUST match a \`[quality_gate.register.steps]\` \`command_prefixes\` entry. Do not add an inline environment wrapper or \`cd … &&\` unless the project declaration explicitly owns that exact prefix. The runner uses a minimal, secret-scrubbed environment.
- Scoped self-gate (W-402): always run the scoped per-package check/test yourself before submitting, even on a cold build — delegate to the REQUIRED GATE block only the full-workspace-tier gate.`;
}

// Single source for every Codex-dispatched role preamble (managed dispatch and isolate
// lanes). Codex's sandbox cannot write the shared gitdir, so the role edits
// worktree files only and hands a mechanically parseable plan to the Dock proxy
// committer. Keep the block delimiters in sync with lane_commit_plan.ts.
export function codexProviderContract(options: CodexRoleContractOptions): string {
  const trailers = [options.trailer, options.seatTrailer].filter(Boolean).join("\n");
  return `- ${CODEX_ROLE_PROMPT_CONTRACT_MARKER} NEVER run git merge, git add, git commit, git stash, git restore, git checkout, or any index-mutating Git command. The shared gitdir is sandbox-protected; do not retry a denied Git write.
- Edit worktree files only inside ${options.worktree}. Git read commands (status/log/diff) are allowed.
- ${DISPATCH_RESULT_STATE_FIRST_LINE_CONTRACT}
${requiredGateDelegationContract(CODEX_REQUIRED_GATE_REASON)}
- Long-run commands (W-402): if a build/test is likely to exceed \`bash_timeout_budget_ms\`, do not wait in the foreground — launch it as a background terminal and poll → collect (codex's own official long-run mechanism, \`background_terminal_max_timeout\` default 300000ms/poll; never block one call waiting on it).
- Launch ack timing (W-402): \`generation-N/launch.json\` is written by the launcher only AFTER the provider process exits — not seeing your own launch ack during your own session is expected, never a BLOCK condition.
- Base drift (W-402): a control-only commit difference between studio and your base is not a BLOCK reason by itself — BLOCK only when the differing commits actually overlap your code paths.
- Branch: ${options.branch} (dispatch base ${options.baseSha}). Before dispatch, the PM compares the branch/base and studio tips. If the tips are identical, skip base-track. If the tips differ, the PM must merge studio into this branch and resolve conflicts before dispatch; the Codex-dispatched role never performs that merge.
- Commit (PROXY mode — W-042): you CANNOT run git add / git commit / git stash in this worktree. For each commit-worthy milestone, describe the exact changed file list and a full message whose subject ends with ${options.subjectSuffix}. Include these provenance trailers in the message (replace any {{TASK_ID}} placeholder with the bound backlog id); the proxy committer enforces the seat trailer:
${trailers.split("\n").map((line) => `  ${line}`).join("\n")}
  Explain WHY in the body; never paste diffs. The Dock seat must compare the actual worktree diff with the declared file list before proxy-committing.
- Register-terminate: report final STATE, branch, gate result, and "commit plan submitted (Dock commits — PROXY mode, no SHA yet)". End the result with one COMMIT PLAN block in EXACTLY this machine-parseable format:
=== COMMIT PLAN ===
files:
- path/to/changed_file
message:
<type>(<scope>): summary ${options.subjectSuffix}

why this change is needed

${trailers}
=== END COMMIT PLAN ===`;
}

// Normalize a path to forward slashes. The lane layout paths are built by string
// interpolation and also flow through workspace_isolate's hand-built JSON line,
// where a Windows backslash (e.g. a PowerShell-supplied --repo) would produce an
// invalid JSON escape (\U...). git on Windows accepts forward slashes, so
// normalizing --repo up front keeps every downstream path JSON-safe and stable.
export function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function validateSlug(slug: string): void {
  if (!slug) throw new Error("--slug is required");
  if (!SLUG_RE.test(slug)) throw new Error(`--slug must be kebab-case [a-z0-9-]: ${slug}`);
}

export function validatePmId(pmId: string): void {
  if (pmId !== "_workshop" && !PM_ID_RE.test(pmId)) {
    throw new Error(`--pm-id must be "_workshop" or match ${PM_ID_RE.source}: ${pmId}`);
  }
}

export function resolvePmId(repo: string, explicit = ""): string {
  if (explicit) {
    validatePmId(explicit);
    return explicit;
  }
  const root = `${repo}/__garelier`;
  let candidates: string[] = [];
  try {
    candidates = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === "_workshop" || PM_ID_RE.test(entry.name)))
      .map((entry) => entry.name)
      .sort();
  } catch { /* reported below as zero candidates */ }
  if (candidates.length === 1) return candidates[0];
  const found = candidates.length === 0 ? "none" : candidates.join(", ");
  throw new Error(`--pm-id is required: expected exactly one PM namespace under ${root}, found ${found}`);
}

export interface LanePaths {
  pmId: string;
  worktree: string;
  metaDir: string;
  legacy: boolean;
}

function hasSlug(paths: LanePaths, slug: string): boolean {
  if (existsSync(paths.worktree) || existsSync(`${paths.metaDir}/${slug}.json`)) return true;
  try {
    return readdirSync(paths.metaDir).some((name) => name.startsWith(`${slug}.`));
  } catch {
    return false;
  }
}

// Resolve one lane as a unit so its worktree and every bookkeeping sidecar
// always come from the same namespace. New writes pass allowLegacy=false.
// Existing-lane operations pass true: the new namespace wins when the slug is
// present there; otherwise the pre-W-102 root dotdir is used if it has the slug.
export function resolveLanePaths(repo: string, slug: string, pmId = "", allowLegacy = true): LanePaths {
  const legacy: LanePaths = {
    pmId: "",
    worktree: `${repo}/.garelier-work/${slug}`,
    metaDir: `${repo}/.garelier-work/.meta`,
    legacy: true,
  };

  let resolvedPm = "";
  try {
    resolvedPm = resolvePmId(repo, pmId);
  } catch (error) {
    if (allowLegacy && hasSlug(legacy, slug)) return legacy;
    throw error;
  }
  const current: LanePaths = {
    pmId: resolvedPm,
    worktree: `${repo}/__garelier/${resolvedPm}/_crew/lanes/${slug}`,
    metaDir: `${repo}/__garelier/${resolvedPm}/_crew/lanes/.meta`,
    legacy: false,
  };
  if (allowLegacy && !hasSlug(current, slug) && hasSlug(legacy, slug)) return legacy;
  return current;
}

export function laneWorktree(repo: string, slug: string, pmId = "", allowLegacy = true): string {
  return resolveLanePaths(repo, slug, pmId, allowLegacy).worktree;
}

export function laneBranch(slug: string): string {
  return `garelier/isolate/${slug}`;
}

export function laneMetaDir(repo: string, slug: string, pmId = "", allowLegacy = true): string {
  return resolveLanePaths(repo, slug, pmId, allowLegacy).metaDir;
}

export function lanePromptPath(repo: string, slug: string, pmId = "", allowLegacy = true): string {
  return `${laneMetaDir(repo, slug, pmId, allowLegacy)}/${slug}.prompt.md`;
}

export function laneInstructionsPath(repo: string, slug: string, pmId = "", allowLegacy = true): string {
  return `${laneMetaDir(repo, slug, pmId, allowLegacy)}/${slug}.instructions.md`;
}

export function laneRecordPath(repo: string, slug: string, pmId = "", allowLegacy = true): string {
  return `${laneMetaDir(repo, slug, pmId, allowLegacy)}/${slug}.dispatch.json`;
}

// workspace_isolate writes <meta>/<slug>.json holding the lane's base branch.
// Read it back (base FIRST in the JSON, so a plain regex is robust to the
// additive owner/created fields). "" when absent.
export function readIsolateBase(repo: string, slug: string, pmId = ""): string {
  try {
    const raw = readFileSync(`${laneMetaDir(repo, slug, pmId, true)}/${slug}.json`, "utf8");
    return raw.match(/"base":"([^"]*)"/)?.[1] ?? "";
  } catch {
    return "";
  }
}

export interface DispatchRecord {
  slug: string;
  row: string;
  pm_id: string;
  provider: string; // "codex" | "claude-code"
  model: string;
  routing?: { model: string; effort: string; source: string };
  branch: string;
  worktree: string;
  base: string;
  base_sha: string;
  owner: string;
  commit_trailer: string;
  created: string;
  permission_profile: PermissionProfileName;
  fence_roots: string[];
  agent_name?: string;
}

export function readRecord(repo: string, slug: string, pmId = ""): DispatchRecord | undefined {
  const path = laneRecordPath(repo, slug, pmId, true);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as DispatchRecord; } catch { return undefined; }
}

export function writeRecord(repo: string, slug: string, pmId: string, record: DispatchRecord): void {
  const metaDir = laneMetaDir(repo, slug, pmId, false);
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(laneRecordPath(repo, slug, pmId, false), `${JSON.stringify(record, null, 2)}\n`);
}

// The canonical isolate-lane commit trailer (mirrors workspace_isolate's
// commit_template + dispatch_prepare's Garelier: line, minus the dock role).
export function commitTrailer(pmId: string, slug: string, row: string): string {
  return `Garelier: ${pmId} isolate/${slug} ${row}`;
}

// Run one step capturing its real exit code and combined output WITHOUT any
// shell pipe (so no PIPESTATUS masking / false-green — the whole reason
// lane_verify exists). stderr is folded into stdout so a verbatim summary shows
// the failure text in order.
export interface StepResult { code: number; output: string; }

export function captureStep(command: string[], cwd?: string, env?: Record<string, string | undefined>): StepResult {
  const resolved = resolveCommand(command, { env: env ?? (process.env as Record<string, string | undefined>) });
  if (!resolved) return { code: 127, output: `required executable not found: ${command[0] ?? "<empty>"}` };
  const child = Bun.spawnSync(resolved, { windowsHide: true, cwd, ...(env ? { env } : {}), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = child.stdout?.toString() ?? "";
  const stderr = child.stderr?.toString() ?? "";
  const output = stderr ? `${stdout}${stdout.endsWith("\n") || stdout === "" ? "" : "\n"}${stderr}` : stdout;
  // A spawn that never launched (binary missing) reports exitCode null.
  return { code: child.exitCode ?? 127, output };
}

// Keep only the last `n` non-empty-ish lines of a step's output for a compact
// but verbatim summary (never rewords — just trims to the tail).
export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\r/g, "").replace(/\n$/, "").split("\n");
  return lines.slice(-n).join("\n");
}
