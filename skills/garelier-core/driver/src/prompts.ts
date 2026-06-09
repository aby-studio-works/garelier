// Per-role prompt construction for the subprocess-based driver.
//
// Claude Code handles skill activation itself: each role's worktree has
// its own CLAUDE.md and Claude discovers the installed garelier-* skills
// (under the resolved skill root — plugin cache or ~/.claude/skills in dev
// symlink mode). Other provider CLIs may not load Claude Code skills, so
// these prompts include exact entrypoint paths (skillRootDir, resolved
// cache-safe by role.ts). They deliberately do NOT bulk-require every core doc on
// every iteration; role skills and role_index.toml route deeper reading when
// the task actually needs it.
//
// What we DO inject is:
//   1. A headless directive (via --append-system-prompt-file) that
//      overrides any project plugins (e.g. terse-plugin's terse style)
//      and forbids silent end-of-turn.
//   2. A per-iteration user message that describes the one piece of
//      work to do, with absolute paths so Claude doesn't get confused
//      about its cwd.
//
// v2.1: all paths are scoped under __garelier/<pm_id>/... per DEC-006.

export type RoleKind =
  | "pm"
  | "dock"
  | "artisan"
  | "worker"
  | "scout"
  | "smith"
  | "librarian"
  | "observer"
  | "guardian"
  | "concierge";

export type ProviderKind =
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"
  | "copilot-cli"
  | "cursor-cli";

// Roles the driver launches as detached, per-id child processes (everything
// except the two in-checkout roles PM and Dock). Single source of truth
// for main.ts and agent_child.ts.
export type DetachedAgentRole = Exclude<RoleKind, "pm" | "dock">;

const HEADLESS_DIRECTIVE = `Headless driver mode: no human, no questions, no AskUserQuestion. Ignore terse-style plugins. Follow your garelier-* skill literally. Execute via Read/Write/Edit/Bash/Glob/Grep; commit via Bash when the skill says to. End every turn with exactly one line: \`action: <what>\`, \`action: coord_only: <what>\`, or \`no action: <why>\`. Silent exits break the driver.`;

export function getHeadlessDirective(): string {
  return HEADLESS_DIRECTIVE;
}

export interface RoleContext {
  projectRoot: string;
  pmId: string;
  skillRootDir?: string; // directory containing garelier-core, garelier-worker, ...
  // For worker / scout / smith / librarian / observer / artisan iterations:
  workerOrScoutId?: string;
  // DEC-020: the role CONTAINER — where coordination files (STATE.md,
  // assignment.md, report.md, checkpoints/, …) live. NOT the git worktree.
  workerOrScoutCwd?: string; // absolute path to the container
  // DEC-020: the git worktree = <container>/checkout. This is the provider's
  // cwd and the target of every git operation. Defaults to
  // `${workerOrScoutCwd}/checkout` when omitted.
  worktreeDir?: string; // absolute path to the checkout worktree
  // DEC-021: read-only roles (scout/observer) with checkout=false have NO
  // worktree — they read source via git show/grep. Default (undefined) = true.
  checkout?: boolean;
  // DEC-035: for the Dock / PM iterations — every detached role's RESOLVED
  // physical container (a machine-local exile home, or the legacy in-project
  // path). Dock/PM scan STATE.md and write assignment/review/abort into
  // these containers; the in-project `_<role>/<id>/` path may not exist on disk.
  roster?: RoleMailbox[];
  // Driver-built compact snapshot of role states. Coordinator prompts use this
  // for triage instead of asking the model to re-open every STATE.md.
  roleStatusSummary?: string;
  // Provider running this iteration. Used only for prompt guidance; provider
  // command construction stays in providers/.
  providerKind?: ProviderKind;
}

export interface RoleMailbox {
  role: DetachedAgentRole; // worker | scout | smith | librarian | observer | guardian | concierge | artisan
  id: string;
  container: string; // absolute resolved container (coordination files live here)
}

export function buildIterationPrompt(role: RoleKind, ctx: RoleContext): string {
  switch (role) {
    case "pm":
      return buildPmPrompt(ctx);
    case "dock":
      return buildDockPrompt(ctx);
    case "artisan":
      return buildArtisanPrompt(ctx);
    case "worker":
      return buildWorkerPrompt(ctx);
    case "scout":
      return buildScoutPrompt(ctx);
    case "smith":
      return buildSmithPrompt(ctx);
    case "librarian":
      return buildLibrarianPrompt(ctx);
    case "observer":
      return buildObserverPrompt(ctx);
    case "guardian":
      return buildGuardianPrompt(ctx);
    case "concierge":
      return buildConciergePrompt(ctx);
  }
}

// Per-role prompts are intentionally lean: the garelier-* skill (loaded
// by Claude Code via its skill system) already contains step-by-step
// flow for each role. We only inject what the model can't derive: cwd,
// pm_id, key absolute paths, the iteration boundary rule, and any
// load-bearing reminders not covered by SKILL.md.

function pmRoot(ctx: RoleContext) {
  return `${ctx.projectRoot}/__garelier/${ctx.pmId}`;
}

function skillRoot(ctx: RoleContext) {
  // role.ts always supplies skillRootDir (resolved cache-safe / dual-mode), so
  // the fallback is dormant. If it ever fires, prefer the plugin runtime root
  // over a bogus literal "~" path that no tool would expand. (DEC-053)
  return (
    ctx.skillRootDir ??
    (process.env.CLAUDE_PLUGIN_ROOT
      ? `${process.env.CLAUDE_PLUGIN_ROOT}/skills`
      : `${process.env.USERPROFILE ?? process.env.HOME ?? "."}/.claude/skills`)
  );
}

// DEC-020: resolve a worktree role's container (coordination files) and its
// git worktree (<container>/checkout, the provider cwd). `def` is the default
// container when ctx.workerOrScoutCwd is absent.
function roleDirs(ctx: RoleContext, def: string): { coordDir: string; worktreeDir: string } {
  const coordDir = ctx.workerOrScoutCwd ?? def;
  const worktreeDir = ctx.worktreeDir ?? `${coordDir}/checkout`;
  return { coordDir, worktreeDir };
}

// One-line orientation every worktree role shares (DEC-020): the cwd is the
// git worktree; coordination files live one level up in the container.
function worktreeOrientation(coordDir: string, worktreeDir: string): string {
  return `Your cwd is the git worktree (${worktreeDir}) — do ALL git/branch/commit work and edit target code here. Your coordination files (STATE.md, assignment.md, report.md, …) live in the PARENT container (${coordDir}); read AND write them there, never inside your cwd.`;
}

// DEC-021: orientation for a read-only role (scout/observer). With a checkout
// it sits on a named throwaway branch (`spyglass`/`monocle`) cut from a fixed
// tip — a stable snapshot that doesn't move when studio advances and doesn't
// block others; deleted on return to IDLE, never committed to. With
// checkout=false it has no worktree and reads via git show/grep at a fixed SHA.
function readOnlyHead(ctx: RoleContext, coordDir: string, worktreeDir: string, branch: string): string[] {
  if (ctx.checkout === false) {
    return [
      `You have NO worktree (checkout=false). Capture the fixed tip SHA at pickup and read source via \`git -C ${ctx.projectRoot} show <sha>:<path>\` and \`git -C ${ctx.projectRoot} grep <sha> …\`, so your view stays stable while studio advances. Coordination files (STATE.md, assignment.md, report.md) live in ${coordDir}.`,
    ];
  }
  return [
    worktreeOrientation(coordDir, worktreeDir),
    `At pickup, cut a throwaway \`${branch}\` branch from the fixed tip and stay on it (stable snapshot; won't move as studio advances; doesn't block others): \`git checkout -b garelier/<target-slug>/${ctx.pmId}/${branch}/#<id>/<slug> <tip>\`. NEVER commit — the branch only names the snapshot. Delete it on return to IDLE.`,
  ];
}

function commonDocs(ctx: RoleContext, roleSkill: string): string[] {
  const s = skillRoot(ctx);
  const provider =
    ctx.providerKind === "codex-cli"
      ? "Codex CLI: read the role entrypoint and project AGENTS.md explicitly before acting."
      : ctx.providerKind === "claude-code"
      ? "Claude Code: the role skill may be auto-loaded; verify the entrypoint if it is not already in context."
      : "Provider note: if this CLI does not auto-load Claude skills, read the role entrypoint explicitly before acting.";
  return [
    `Context policy (${ctx.providerKind ?? "unknown-provider"}):`,
    `- ${provider}`,
    `- ${s}/${roleSkill}/SKILL.md`,
    `- ${s}/garelier-core/SKILL.md`,
    `- ${ctx.projectRoot}/AGENTS.md`,
    `- For non-trivial task work, if ${ctx.projectRoot}/docs/garelier/knowledge/role_index.toml exists, read only this role's read_first entries, then follow pointers as needed.`,
    `- Load ${s}/garelier-core/protocol.md, state_machine.md, compact_handoff.md, and role references only when the current state/action needs that procedure.`,
    `- Official deliverables stay Markdown-first. When a matching ${s}/garelier-core/templates/*.json sidecar exists, also write the compact sibling JSON summary; do not duplicate the full Markdown body.`,
  ];
}

function boundedBatchLine(role: "Worker" | "Scout" | "Smith" | "Librarian" | "Artisan"): string {
  return `${role} driver boundary: run one bounded batch for the current task, not an unbounded loop. Continue across adjacent state/action steps only while context is fresh, scope is unchanged, and you can leave a durable checkpoint (STATE/report/inspection/commit) at the end. Stop at REPORTING, BLOCKED, a review/merge/ack wait, or any uncertainty. Never pick up a second task in the same iteration.`;
}

function qualityGatePolicyLine(role: "Worker" | "Smith" | "Librarian" | "Artisan" | "Concierge"): string {
  const finish =
    role === "Artisan"
      ? "Before self-review completion, studio integration, or REPORTING"
      : role === "Concierge"
      ? "Before committing/tagging/pushing a promote merge"
      : "Before REPORTING or completion";
  return `Quality gate policy: during bounded implementation/hardening batches, run the fast quality gate when available. ${finish}, run the full quality gate when available. If only legacy [quality_gate] commands exist, treat them as the full gate. Do not repeatedly run the full gate after every small sub-step unless the assignment explicitly requires it.`;
}

function roleStatusSummaryLines(ctx: RoleContext): string[] {
  if (!ctx.roleStatusSummary?.trim()) return [];
  return [
    `Driver role status summary (fresh at launch; use for triage instead of re-reading every STATE.md):`,
    ctx.roleStatusSummary.trim(),
    `Read a specific role's STATE.md / assignment.md / report.md only when you are about to act on that role, write into its container, or the summary is missing/unclear.`,
  ];
}

function buildPmPrompt(ctx: RoleContext): string {
  const r = pmRoot(ctx);
  const s = skillRoot(ctx);
  return [
    `Garelier PM iteration — pm_id=${ctx.pmId}, cwd=${r}/_pm/`,
    ...commonDocs(ctx, "garelier-pm"),
    `PM reference for this driver path: ${s}/garelier-pm/references/autonomous-mode.md`,
    `Per garelier-pm references/autonomous-mode.md §15.4: one iteration only.`,
    `Recover from ${r}/runtime/manifest.md + ${r}/_pm/history.md;`,
    `process ${r}/runtime/pm/inbox/ (including Scout inspection intake); if autonomy on, draft ONE pending blueprint;`,
    `update history.md (autopilot tag), apply retention if thresholds are exceeded, and commit on studio if a semantic PM-owned artifact changed.`,
    `When consuming reports/reviews/inspections, read the matching compact JSON sidecar first when present; open the full Markdown only for evidence or prose details.`,
    `No-op write rule: do not rewrite history/dashboard/manifest files just to refresh timestamps; if nothing semantic changed, end "no action".`,
    `If you only touched coordination/status bookkeeping with no dispatch, decision, blueprint, review, or semantic PM artifact change, end "action: coord_only: <what>".`,
    ...roleStatusSummaryLines(ctx),
    ...rosterScanLines(ctx),
    `End with "action: ...", "action: coord_only: ...", or "no action: <reason>". Don't loop.`,
  ].join("\n");
}

// DEC-035: render the resolved role-container scan list. Dock/PM must NOT
// glob the in-project `_<role>/<id>/` paths — under exile those dirs don't
// exist; the driver passes the resolved absolute containers instead.
function rosterScanLines(ctx: RoleContext): string[] {
  if (!ctx.roster || ctx.roster.length === 0) return [];
  const byRole = new Map<string, string[]>();
  for (const m of ctx.roster) {
    if (!byRole.has(m.role)) byRole.set(m.role, []);
    byRole.get(m.role)!.push(`${m.container}/STATE.md`);
  }
  const lines: string[] = [
    `DEC-035: role containers may be machine-local (outside the project). Use the RESOLVED containers below — do NOT assume ${pmRoot(ctx)}/_<role>/<id>/ exists on disk. Use the driver role status summary for status triage when present; read a specific STATE.md only before acting on that role. Write assignment.md / review.md / under_review.md / merged.md / answers.md / track-target.md / abort.md into the SAME resolved container dir. The mapping also lives in ${pmRoot(ctx)}/runtime/workspace_paths.`,
  ];
  for (const [role, paths] of byRole) lines.push(`  ${role}: ${paths.join(", ")}`);
  return lines;
}

function buildDockPrompt(ctx: RoleContext): string {
  const r = pmRoot(ctx);
  const s = skillRoot(ctx);
  const roster = rosterScanLines(ctx);
  const scanLine = roster.length > 0
    ? `Use the driver role status summary for role triage; scan ${r}/control/blueprints/ (skip draft/archived), ${r}/_pm/history.md, and only the specific resolved role containers you need to act on.`
    : `Scan ${r}/_workers/*/STATE.md, ${r}/_scouts/*/STATE.md, ${r}/_smiths/*/STATE.md, ${r}/_librarians/*/STATE.md, ${r}/control/blueprints/ (skip draft/archived), ${r}/_pm/history.md.`;
  return [
    `Garelier Dock iteration — pm_id=${ctx.pmId}, cwd=${r}/_dock/`,
    ...commonDocs(ctx, "garelier-dock"),
    `Dock references for this driver path: ${s}/garelier-dock/references/main-loop-and-routing.md, ${s}/garelier-dock/references/review-and-merge.md, ${s}/garelier-dock/references/state-and-escalation.md`,
    `Per garelier-dock references/main-loop-and-routing.md §3: one iteration only.`,
    `Read ${r}/runtime/manifest.md; process ${r}/runtime/pm/resolutions/ + ${r}/runtime/dock/inbox/.`,
    `When consuming report.md/review.md/guardian_report.md/inspection artifacts, read the matching compact JSON sidecar first when present; open the full Markdown only for evidence or prose details.`,
    scanLine,
    ...roleStatusSummaryLines(ctx),
    ...roster,
    `Dispatch new assignments (IDLE → ASSIGNED). For Worker/Smith/Librarian REPORTING, follow references/review-and-merge.md §8.1 (async merge gate via runtime/merge_gate/requests/). Librarian review uses §7.4.`,
    `For Scout REPORTING, verify the draft and hand accepted inspections to PM intake; do not mark done until PM commit/verification.`,
    `Read any new runtime/merge_gate/results/ and act per references/review-and-merge.md §8.1.B.`,
    `Update manifest/backlog, apply runtime retention if thresholds are exceeded, and commit on studio if semantic runtime/control content changed.`,
    `No-op write rule: do not rewrite manifest/backlog/inbox files with identical content; if no action is needed, leave mtimes alone and end "no action".`,
    `If you only touched coordination/status bookkeeping with no dispatch, review, merge request, merge result handling, or semantic queue change, end "action: coord_only: <what>".`,
    `End with "action: ...", "action: coord_only: ...", or "no action: <reason>".`,
  ].join("\n");
}

function buildSmithPrompt(ctx: RoleContext): string {
  const id = ctx.workerOrScoutId ?? "(unknown)";
  const { coordDir, worktreeDir } = roleDirs(ctx, `${pmRoot(ctx)}/_smiths/${id}`);
  return [
    `Garelier Smith ${id} — pm_id=${ctx.pmId}, cwd=${worktreeDir}`,
    worktreeOrientation(coordDir, worktreeDir),
    ...commonDocs(ctx, "garelier-smith"),
    boundedBatchLine("Smith"),
    qualityGatePolicyLine("Smith"),
    ``,
    `1. Read ${coordDir}/{STATE.md,assignment.md,under_review.md,review.md,merged.md,answers.md,abort.md} (whichever exist).`,
    `2. First action: \`git status\` + \`git diff --stat\`. If coherent uncommitted work exists from a prior iteration, commit it before continuing.`,
    `3. Do one of: pick up assignment (ASSIGNED→WORKING + create anvil branch); add/run integration/system tests; fix integration-only failures; write report.md and transition REPORTING; handle review.md → REWORK/WORKING.`,
    `4. Scope guard: Smith handles post-merge hardening, integration tests, release tooling, project specification consistency, and license/security audits. Do not take over unfinished Worker feature scope or PM-owned Garelier control docs.`,
    ``,
    `**STATE.md format:** use canonical \`## Status\` / \`## Current branch\` / \`## Current task\` / \`## Last activity\` headers from \`templates/state.md\`. Not list-item form.`,
    ``,
    `End with "transition: <from> -> <to>" or "action: <chunk + commits>" or "no action: <reason>".`,
  ].join("\n");
}

function buildArtisanPrompt(ctx: RoleContext): string {
  const id = ctx.workerOrScoutId ?? "(unknown)";
  const { coordDir, worktreeDir } = roleDirs(ctx, `${pmRoot(ctx)}/_artisan`);
  const r = pmRoot(ctx);
  return [
    `Garelier Artisan ${id} — pm_id=${ctx.pmId}, cwd=${worktreeDir} (artisan lane)`,
    worktreeOrientation(coordDir, worktreeDir),
    ...commonDocs(ctx, "garelier-artisan"),
    boundedBatchLine("Artisan"),
    qualityGatePolicyLine("Artisan"),
    `You are the artisan lane: perform the WHOLE dock-lane scope (Dock + Worker + Scout + Smith + Librarian) for one task BY YOURSELF, then pass Guardian → Observer and integrate your satchel branch into studio. Do NOT delegate and NEVER merge to target.`,
    ``,
    `1. Read ${coordDir}/{STATE.md,assignment.md,answers.md,abort.md} (whichever exist) and the latest ${coordDir}/checkpoints/ entry.`,
    `2. **First action: \`git status\` + \`git diff --stat\`.** If coherent uncommitted work from a prior iteration exists, commit it as a checkpoint before continuing — do NOT redo it.`,
    `3. Verify ${r}/runtime/lane.lock names the artisan lane and is yours (stamp pid/branch; write it if absent). If it names the dock lane, BLOCK and return to PM.`,
    `4. Do one of: pick up assignment (IDLE/ASSIGNED→WORKING + create satchel branch from studio); implement/harden/knowledge-work one cohesive chunk + commit + checkpoint; run self-review + quality gate; forward-integrate studio; pass Guardian then Observer; verify pinned studio SHA and merge satchel into studio; run the full quality gate; write report.md + release lane.lock + notify PM inbox + → IDLE.`,
    ``,
    `**Commit discipline (load-bearing):** commit per cohesive sub-step; leave a checkpoint at each phase boundary. Uncommitted work at a compaction/timeout boundary is lost.`,
    `**STATE.md format:** canonical \`## Status\` / \`## Current branch\` / \`## Current task\` / \`## Last activity\` headers from templates/state.md. Track phase in Current task.`,
    `Escalate to PM only for judgment/authority/safety — never because the task is large or slow.`,
    ``,
    `End with one line: "transition: <from> -> <to>" or "action: <chunk + commits>" or "no action: <reason>".`,
  ].join("\n");
}

function buildWorkerPrompt(ctx: RoleContext): string {
  const id = ctx.workerOrScoutId ?? "(unknown)";
  const { coordDir, worktreeDir } = roleDirs(ctx, `${pmRoot(ctx)}/_workers/${id}`);
  return [
    `Garelier Worker ${id} — pm_id=${ctx.pmId}, cwd=${worktreeDir}`,
    worktreeOrientation(coordDir, worktreeDir),
    ...commonDocs(ctx, "garelier-worker"),
    boundedBatchLine("Worker"),
    qualityGatePolicyLine("Worker"),
    ``,
    `1. Read ${coordDir}/{STATE.md,assignment.md,track-target.md,under_review.md,review.md,merged.md,answers.md,abort.md} (whichever exist).`,
    `2. **First action: \`git status\` + \`git diff --stat\`.** If uncommitted work from a prior iteration is coherent, commit it as a checkpoint before continuing — do NOT redo it.`,
    `3. Do one of: pick up assignment (ASSIGNED→WORKING + create workbench branch); implement one cohesive chunk + commit; write report.md and transition REPORTING; handle review.md → REWORK/WORKING.`,
    `4. If implementing, use the quality gate policy above before report.md.`,
    ``,
    `**Commit discipline (load-bearing):**`,
    `- Commit per cohesive sub-step. WIP commits encouraged: \`git commit -m "WIP <task-id> <sub-step>: ..."\`.`,
    `- **Warning sign:** 3+ files modified with 0 commits → stop, commit what's coherent, continue.`,
    `- Driver has a 6h stuckness timeout (not a deadline). Uncommitted work at timeout = lost.`,
    ``,
    `**STATE.md format:** use the canonical \`## Status\` / \`## Current branch\` / \`## Current task\` / \`## Last activity\` headers from \`templates/state.md\`. Do NOT switch to "- Current state: ..." list-item form — it breaks the status helper's parser.`,
    ``,
    `End with one line: "transition: <from> -> <to>" or "action: <chunk + commits>" or "no action: <reason>".`,
  ].join("\n");
}

function buildLibrarianPrompt(ctx: RoleContext): string {
  const id = ctx.workerOrScoutId ?? "(unknown)";
  const { coordDir, worktreeDir } = roleDirs(ctx, `${pmRoot(ctx)}/_librarians/${id}`);
  return [
    `Garelier Librarian ${id} — pm_id=${ctx.pmId}, cwd=${worktreeDir}`,
    worktreeOrientation(coordDir, worktreeDir),
    ...commonDocs(ctx, "garelier-librarian"),
    boundedBatchLine("Librarian"),
    qualityGatePolicyLine("Librarian"),
    `You manage the project's knowledge bookshelf: (1) sync REGISTERED external sources into internal docs Markdown with project-specific augmentation + provenance; (2) standardize work into runbooks/manuals + registries. NO free research (Scout), NO feature code (Worker), NO QA (Smith), NO unregistered sources, NO rule-meaning change.`,
    ``,
    `1. Read ${coordDir}/{STATE.md,assignment.md,under_review.md,review.md,merged.md,answers.md,abort.md} (whichever exist).`,
    `2. First action: \`git status\` + \`git diff --stat\`. Commit coherent prior-iteration work before continuing.`,
    `3. Do one of: pick up assignment (ASSIGNED→WORKING + create shelf branch from studio); fetch+transform a registered source into target Markdown with provenance front matter (references/source-sync.md); author/update a runbook + registry entry (references/registries-and-runbooks.md); write report.md and transition REPORTING; handle review.md → REWORK/WORKING; BLOCK on unregistered source / fetch failure (no stale overwrite) / registry conflict / meaning change.`,
    ``,
    `**STATE.md format:** canonical \`## Status\` / \`## Current branch\` / \`## Current task\` / \`## Last activity\` headers from templates/state.md.`,
    `End with one line: "transition: <from> -> <to>" or "action: <chunk + commits>" or "no action: <reason>".`,
  ].join("\n");
}

function buildObserverPrompt(ctx: RoleContext): string {
  const id = ctx.workerOrScoutId ?? "(unknown)";
  const { coordDir, worktreeDir } = roleDirs(ctx, `${pmRoot(ctx)}/_observers/${id}`);
  const cwdLabel = ctx.checkout === false ? coordDir : worktreeDir;
  return [
    `Garelier Observer ${id} — pm_id=${ctx.pmId}, cwd=${cwdLabel} (read-only sidecar)`,
    ...readOnlyHead(ctx, coordDir, worktreeDir, "monocle"),
    ...commonDocs(ctx, "garelier-observer"),
    `Per garelier-observer SKILL + state_machine.md: advance by exactly one step. You are an INDEPENDENT, READ-ONLY reviewer/advisor. You do NOT modify code, commit, merge, or change acceptance criteria.`,
    ``,
    `1. Read ${coordDir}/{STATE.md,assignment.md,answers.md,abort.md,acked.md} (whichever exist).`,
    `2. From assignment.md, identify the kind (merge_review|artisan_premerge_review|direction_advice|architecture_risk_review|policy_consistency_review) and the review target (base branch, review branch, diff command, assignment/report/gate-output paths). Unless checkout=false, cut your \`monocle\` branch from the review-target tip for a stable snapshot.`,
    `3. Do one of: pick up assignment (IDLE/ASSIGNED→OBSERVING); read the diff + report + assignment + quality-gate output + relevant source and run the required checks (scope/coverage, diff-vs-report, protected paths, public-API/schema/migration, security/data-change, test-gap); write report.md with a Verdict (PASS|PASS_WITH_NOTES|REWORK_RECOMMENDED|BLOCK|NO_OPINION) OR (for direction_advice) advice.md with status (ADVICE|ESCALATE_TO_DOCK_OR_PM|NO_OPINION), then transition REPORTING; on acked.md → archive + IDLE (delete your monocle branch); BLOCK on missing info / unknown review branch / policy decision needed.`,
    `4. Boundaries: NO code edits, NO commits, NO merges, NO acceptance-criteria changes, NO PM/user-level decisions. For direction_advice, only advise within the existing assignment scope; if the question touches scope/architecture/security/migration policy, return ESCALATE_TO_DOCK_OR_PM.`,
    ``,
    `**STATE.md format:** canonical \`## Status\` / \`## Current branch\` / \`## Current task\` / \`## Last activity\` headers from templates/state.md. Not list-item form.`,
    `End with one line: "transition: <from> -> <to>" or "action: <what you reviewed>" or "no action: <reason>".`,
  ].join("\n");
}

function buildScoutPrompt(ctx: RoleContext): string {
  const id = ctx.workerOrScoutId ?? "(unknown)";
  const { coordDir, worktreeDir } = roleDirs(ctx, `${pmRoot(ctx)}/_scouts/${id}`);
  const r = pmRoot(ctx);
  const cwdLabel = ctx.checkout === false ? coordDir : worktreeDir;
  return [
    `Garelier Scout ${id} — pm_id=${ctx.pmId}, cwd=${cwdLabel} (read-only)`,
    ...readOnlyHead(ctx, coordDir, worktreeDir, "spyglass"),
    ...commonDocs(ctx, "garelier-scout"),
    boundedBatchLine("Scout"),
    `1. Read ${coordDir}/{STATE.md,assignment.md,answers.md,committed.md,abort.md} (whichever exist). \`committed.md\` triggers REPORTING → IDLE per DEC-008.`,
    `2. Do one of: pick up assignment (unless checkout=false, cut your spyglass branch from the studio tip); chunk of investigation; write inspection draft at ${r}/control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md; transition state; on REPORTING→IDLE delete your spyglass branch.`,
    `3. NO commits. Output is a draft for Dock review and PM commit intake.`,
    `4. **STATE.md format:** use canonical \`## Status\` / etc. headers from \`templates/state.md\`. Not list-item form.`,
    `End with "transition: ..." / "action: ..." / "no action: <reason>".`,
  ].join("\n");
}

function buildGuardianPrompt(ctx: RoleContext): string {
  const id = ctx.workerOrScoutId ?? "(unknown)";
  const { coordDir, worktreeDir } = roleDirs(ctx, `${pmRoot(ctx)}/_guardians/${id}`);
  const cwdLabel = ctx.checkout === false ? coordDir : worktreeDir;
  return [
    `Garelier Guardian ${id} — pm_id=${ctx.pmId}, cwd=${cwdLabel} (security gate, commit-free)`,
    ...readOnlyHead(ctx, coordDir, worktreeDir, "gavel"),
    ...commonDocs(ctx, "garelier-guardian"),
    `Per garelier-guardian SKILL + state_machine.md §6.8: advance by exactly one step. You GATE — you do NOT implement, remediate, commit, merge, promote, decide policy, edit the security registry, or reprint secret values.`,
    ``,
    `1. Read ${coordDir}/{STATE.md,assignment.md,answers.md,abort.md,acked.md} (whichever exist).`,
    `2. From assignment.md: the gate kind (preflight|delta_gate|final_gate|promote_gate), base/head refs + review_sha, the required gates, and the Librarian-owned policy sources to read (docs/garelier/security/...).`,
    `3. Do one of: pick up (ASSIGNED→CHECKING; unless checkout=false cut your gavel branch from the review-target tip); run the required scanners + apply the policy/registries to the diff (whole tree for final/promote); write guardian_report.md with a verdict (PASS|PASS_WITH_NOTES|BLOCK|NO_OPINION) + REDACTED/pointer-only evidence, transition REPORTING; on acked.md → archive + delete gavel + IDLE; BLOCK on a missing policy/scanner or a policy decision only PM can make.`,
    `4. Redaction (load-bearing): NEVER paste a secret/PII value into the report. A mandatory scanner (secret/PII) unavailable + policy requires it → BLOCK. If PM explicitly set [guardian_tools].secret_scan = "off" and block_when_required_scanner_unavailable = false, continue in degraded secret-scan mode: use git/Bun/text review, report the disabled scanner, and do NOT claim full scanner coverage. For a rule gap / false positive / needed exception, write knowledge_update_request.md (do NOT edit the registry yourself).`,
    ``,
    `**STATE.md format:** canonical \`## Status\` / \`## Current branch\` / \`## Current task\` / \`## Last activity\` headers from templates/state.md.`,
    `End with one line: "transition: <from> -> <to>" or "action: <what you gated>" or "no action: <reason>".`,
  ].join("\n");
}

function buildConciergePrompt(ctx: RoleContext): string {
  const id = ctx.workerOrScoutId ?? "(unknown)";
  const { coordDir, worktreeDir } = roleDirs(ctx, `${pmRoot(ctx)}/_concierges/${id}`);
  const r = pmRoot(ctx);
  return [
    `Garelier Concierge ${id} — pm_id=${ctx.pmId}, cwd=${worktreeDir} (external operations executor / PM's delegate of last resort)`,
    worktreeOrientation(coordDir, worktreeDir),
    ...commonDocs(ctx, "garelier-concierge"),
    qualityGatePolicyLine("Concierge"),
    `Per garelier-concierge SKILL + DEC-025: advance by exactly one step. PM decides/approves; you EXECUTE the approved method. You do NOT implement source, decide policy, gate, push garelier/* branches, force-push, or run a blind git pull. If a task turns out to need code, hand back to PM.`,
    ``,
    `1. Read ${coordDir}/{STATE.md,assignment.md,answers.md,abort.md,acked.md} (whichever exist). Act only on a PM assignment.md.`,
    `2. From assignment.md: operation_kind (Phase 1: promote_target | sync_remote), the FIXED refs (source_ref/source_sha, target_ref/expected_target_sha, tag), the required gate verdicts (Guardian promote_gate/final_gate PASS|PASS_WITH_NOTES, non-stale), and the Librarian-owned policy/runbook under docs/garelier/external_operations/.`,
    `3. Do one of: pick up (ASSIGNED→PREPARING; read policy/runbook, fix refs) → CHECKING_GATES (confirm Guardian/Observer/CI/quality preconditions; BLOCK if Guardian is BLOCK/missing/stale or target drifted) → acquire the target-scoped lock under ${r}/runtime/concierge/locks/ → EXECUTING → VERIFYING → write concierge_report.md (REPORTING) → on acked.md archive + release lock + IDLE.`,
    `4. promote_target (in your worktree; target is free, main checkout holds studio): \`git fetch origin\`; \`git checkout <target>\`; \`git merge --no-ff --no-commit garelier/<target-slug>/${ctx.pmId}/studio\`; run the full quality gate on the MERGED tree; only if it passes \`git commit\` + \`git tag\` + \`git push origin <target> --tags\`; record target_before_sha/target_after_sha. Resolve conflicts in THIS merge yourself; if base-tracking was clearly skipped (huge/ambiguous), abort + BLOCK to PM. NEVER push garelier/*, NEVER force-push, NEVER git pull.`,
    ``,
    `**STATE.md format:** canonical \`## Status\` / \`## Current branch\` / \`## Current task\` / \`## Last activity\` headers from templates/state.md.`,
    `End with one line: "transition: <from> -> <to>" or "action: <operation + result>" or "no action: <reason>".`,
  ].join("\n");
}
