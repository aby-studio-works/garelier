# Garelier PM Promote and Agent Roster Reference

Promote workflow plus Worker, Scout, and Smith add/remove procedures.

Extracted from the previous role `SKILL.md`; legacy section numbers are intentionally preserved for cross-references.

## §7. Promote flow (merge integration branch into target)

User triggers this with phrases like "promote", "release", "merge to
main", "merge studio into target", "ready to ship".

**Promote ALWAYS requires explicit user instruction**, even when
`[autonomy] enabled = true`. This is a hard boundary — there is no
`auto_promote` flag in v2.0. If you find yourself about to promote
without an explicit user trigger, stop. Promoting into `<target>` has
visibility outside Garelier's sandbox and must remain user-gated.

Read the target branch name and integration branch name from
`__garelier/<pm_id>/_pm/setup_config.toml` `[branches]` section. Both are
recorded at setup time.

### 7.1 Build the promote document

Walk through every item in
`__garelier/<pm_id>/control/operations/promote_checklist.md` and confirm.

```bash
git fetch origin
# What's about to ship: commits in studio not yet in target
git log --oneline <target>..garelier/<target-slug>/<pm_id>/studio
```

Generate a promote document at
`__garelier/<pm_id>/control/reports/promote/<YYYY-MM-DD>.md` using
`templates/promote.md`. Include:

- Diff summary (commits in studio not in target), including the knowledge delta —
  files changed under `__garelier/<pm_id>/knowledge/` and shared
  `__garelier/__atmos/knowledge/` that will ship; confirm Guardian cleared them
  and the knowledge graph validates (the shared layer is project-wide, so a
  promote may carry another pm's shared-knowledge edits into `<target>`)
- Completed milestones in this window
- Quality check results (run the project quality gate from
  `AGENTS.md` §2)
- Smith hardening target count from `status.{sh,ps1}` or
  `runtime/manifest.md`; if non-zero, include the explicit user waiver
  reference before requesting approval
- Promote checklist (each item verified)
- Known issues
- Draft promote notes

### 7.2 User review

Show the promote document to the user. Wait for explicit
approval. Common responses:

- **Approve**: proceed to §7.3
- **Hold**: tell user what's missing or wait for more work
- **Modify promote notes**: edit and re-show

### 7.3 Execute the promote

Only after explicit user approval. The flow is **base-track first, then
promote**. PM always does the base-track; the `studio`→`<target>` merge +
quality gate + tag + push is **executed by Concierge** (DEC-025 / DEC-045).
If no Concierge is configured, stop and configure one; PM never executes the
target merge.

```bash
# Step 1 (PM, main checkout): base-tracking safety net — fold any new target
# commits into studio. PM performs this safety step in the main checkout.
git checkout garelier/<target-slug>/<pm_id>/studio
git merge --no-edit <target>
# If conflicts, resolve them yourself (see §7.5). Commit the base-track.
```

Then dispatch Concierge:

#### 7.3.1 Concierge execution

A Concierge cannot check out `studio` (PM holds it in the main checkout), and
PM keeps the base-track above and hands the
rest to Concierge, which works on `<target>` in its own worktree.

Write a Concierge `assignment.md` (kind `promote_target`,
`templates/concierge_assignment.md`) into an idle
`__garelier/<pm_id>/_concierges/<id>/` with the **fixed** refs: the base-tracked
`studio` tip SHA (`source_sha`), `<target>`, the tag/version, the promote-notes
path, and the passing Guardian `promote_gate` (or `final_gate`) verdict +
`guardian_report_path`. Notify the Concierge and wait for its
`concierge_report.md`. The Concierge (its SKILL §6) checks out `<target>`,
`git merge --no-ff --no-commit studio`, runs the quality gate **on the merged
tree**, and only on success commits + tags + `git push origin <target> --tags`,
returning `target_before_sha` / `target_after_sha`. PM records the result; it
does not run the merge/push itself. A `BLOCKED` / `FAILED` Concierge report means
the promote did not happen — relay it to the user; do not retry silently.

#### 7.3.2 No Concierge configured

Do not promote. Report that integration is ready on `studio`, configure an
enabled Concierge, then issue the approved assignment. PM must not merge,
tag, or push as a fallback.

### 7.4 Archive

Keep the promote document at
`__garelier/<pm_id>/control/reports/promote/<YYYY-MM-DD>.md` as the
persistent record. Update
`__garelier/<pm_id>/control/project_dashboard/roadmap.md` to mark shipped
milestones as promoted, and move them under "Recently promoted".
Move shipped blueprints from
`__garelier/<pm_id>/control/blueprints/<slug>.md` to
`__garelier/<pm_id>/control/blueprints/archive/<slug>.md`. Append a promote
entry to `__garelier/<pm_id>/_pm/history.md` (see §11).

### 7.5 Base-tracking conflict resolution

`git merge <target>` (step 1) is the moment when divergence between
the user-owned target and Garelier's integration branch surfaces.
Per DEC-001 §2.5, PM **resolves these conflicts itself** as
integration work, not feature implementation:

1. Read each conflicted file.
2. Resolve by combining target changes and studio changes in the way
   that preserves both intents. If the blueprint or commit messages
   give context, use them.
3. `git add` the resolved files and `git commit --no-edit` to
   complete the merge.
4. Append a brief resolution summary to
   `__garelier/<pm_id>/_pm/history.md` so the user can audit.

Escalate to the user only when the resolution is genuinely ambiguous
from the blueprint and code context.

## §8. Adding or removing Workers / Scouts / Smiths

When the user wants to scale the agent pool, run the wizard in
**diff mode**. The wizard compares the current
`__garelier/<pm_id>/_pm/setup_config.toml` with the desired set you pass via
`--workers`, `--scouts`, and `--smiths`, applies only the differences, and refuses
to remove agents that are not in `IDLE` state unless PM already completed
the retire-and-requeue audit in §13.2.B.

Before adding any new worktree, the wizard also runs the base-tracking
merge step (§7.3 step 1) on `garelier/<target-slug>/<pm_id>/studio` so the
new worktree starts from the latest integration tip.

### 8.1 When to use diff mode

- User asks to add another Worker, Scout, or Smith
- User asks to retire an existing one
- User asks to rename or replace one (do this as a
  remove + add in a single invocation)

> Provider/model/effort changes for an existing id do not require
> removing the worktree. Edit `_pm/setup_config.toml` before starting
> the driver (or stop/restart the driver). Diff mode is for changing
> the agent set: add/remove/rename.

### 8.2 Pre-flight checks

Before invoking the wizard:

1. Read `__garelier/<pm_id>/_pm/setup_config.toml` to learn the current set.
2. For each agent that will be removed, read its `STATE.md` and
   confirm `Status: IDLE`. If not IDLE, either:
   - Wait for it to finish (preferred), or
   - Use the clean-stop path (§13.2) to abort its current work first, or
   - Use retire-and-requeue (§13.2.B) when the user wants the task
     returned to `pending` without an `aborted` outcome.
3. If a Worker is on a workbench branch or a Smith is on an Anvil branch with unmerged commits, decide
   with the user whether those commits are abandoned or should be
   merged via Dock before removal.

### 8.3 Invocation

The desired set is the **final** state, not a delta. Always pass all
agents you want to keep.

```bash
garelier setup \
  --mode diff \
  --workers "worker-01:claude-code,worker-03:claude-code" \
  --scouts  "scout-01:claude-code" \
  --smiths  "smith-01:codex-cli:gpt-5-codex"
```

In diff mode, omitting `--smiths` keeps the existing Smith
set unchanged. Pass an empty value only when intentionally removing all
Smiths after the required IDLE/requeue checks.

The wizard prints the planned diff (kept / added / removed) and asks
for confirmation. Pass `--skip-confirm` only when you've already shown
the plan to the user and
they've approved.

After PM has completed §13.2.B for every non-IDLE removal, pass
`--allow-requeued-removal`. This flag is only for the post-audit delete step; it
does not perform backlog surgery and must not be used to skip PM's
requeue audit.

### 8.4 What the wizard does

A diff-mode addition is the **only** path that creates a persistent role
container (DEC-065 dispatch-native — fresh setup pre-creates none; producers
run in ephemeral `_dispatch<N>/` homes, and a seat needs a container only
when work is deliberately parked in it long-term).

For each addition: the wizard creates the role's container **in-project** by
default (DEC-036) at `__garelier/<pm_id>/_<role>/<id>/`, runs
`git worktree add --detach <container>/checkout` on
`garelier/<target-slug>/<pm_id>/studio`, writes that worktree's `CLAUDE.md`
(with ABSOLUTE primary/runtime/control paths) and `STATE.md` at the container,
and writes `<checkout>/.claude/settings.local.json` with `claudeMdExcludes` (so
the target's mainline `CLAUDE.md` isn't re-loaded by the ancestry walk). With
**exile** opted in (`--exile`), the container is instead a machine-local home
`$GARELIER_HOME/<home_id>/_<role>/<id>/` (default `~/.garelier/studios/…`) and
the wizard records `<role-singular>.<id>=<absolute container>` in the gitignored
`__garelier/<pm_id>/runtime/workspace_paths` pointer.

For each removal: the wizard resolves the container via the pointer, runs
`git worktree remove --force <container>/checkout`, deletes the container, drops
the pointer entry, and prunes. Note: any local archive content under the
container's `archive/` is gitignored, so it is destroyed with the worktree.
Merged commits remain in `garelier/<target-slug>/<pm_id>/studio`. If the user
wants those local archives preserved, copy them out before invoking the wizard.

Before any addition, the wizard runs `git merge <target>` on the
integration branch (base tracking). If that merge produces conflicts,
the wizard exits with code 3 and asks PM to resolve and re-run; PM
performs the resolution per §7.5.

After the diff is applied, the wizard:
- Rewrites `[[workers]]`, `[[scouts]]`, and `[[smiths]]` blocks in
  `__garelier/<pm_id>/_pm/setup_config.toml` to match the desired set
- Rebuilds the Workers/Scouts/Smiths tables in
  `__garelier/<pm_id>/runtime/manifest.md`
- Appends an entry to `__garelier/<pm_id>/_pm/history.md` recording the
  change

### 8.5 If the wizard refuses to remove an agent

It will exit with code 2 and print which agents are not IDLE. Do not
override this. Either wait for the agent to finish, or use the
clean-stop path (§13.2). If the user explicitly wants the work put
back on the backlog rather than marked aborted, complete §13.2.B and
then re-run the diff with the explicit requeued-removal flag.

### 8.6 Commit

After the wizard returns, commit:

```bash
git add __garelier/<pm_id>/_pm/setup_config.toml __garelier/<pm_id>/_pm/history.md __garelier/<pm_id>/runtime/manifest.md
git commit -m "Garelier: agent set updated"
```
