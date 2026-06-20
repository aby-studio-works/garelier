# Worker reference: assignment → working → reporting

> Detailed per-state procedure moved out of `SKILL.md` to keep the skill
> entrypoint small (DEC-032). Read this when your state is ASSIGNED /
> WORKING / REPORTING. The hard rules in `SKILL.md` (the §1 worktree-guard
> invariant, MUST BLOCK IF, the §2 boundaries) always apply.

## §1a. Worktree guard before edits — the command block

`SKILL.md` §1 states the invariant. Before any file edit, `git add`,
`git commit`, quality-gate command, or cleanup command, run the check
(`../garelier-core/references/worktree-addressing.md` §4 is the shared,
all-role form):

```bash
pwd
git rev-parse --show-toplevel
git branch --show-current
```

`git rev-parse --show-toplevel` must resolve to your own git worktree — your
cwd, which is your `…/_workers/<id>/checkout/` checkout (DEC-020; in-project at
`<project-root>/__garelier/<pm_id>/_workers/<id>/checkout/` by default, or under
an opted-in exile home `~/.garelier/studios/<home_id>/_workers/<id>/checkout/`).
Never run a bare `git -C <container>` (the container is NOT a worktree — no
`.git`); it would resolve to the studio checkout. If it resolves to
`<project-root>` (the primary studio checkout), the container itself (one level
up — it is NOT a worktree), another agent's worktree, or any other path, stop
immediately. Do not edit, stage, commit, run the gate, or clean up. `cd` to your
worker checkout and re-check first.

While implementing, reworking, or reporting an assignment,
`git branch --show-current` must be your workbench branch:
`garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>`. A detached HEAD
is acceptable only while IDLE or during post-merge cleanup, and only if
the top-level path guard above still points at your worker worktree.

## §4. Receiving an assignment (IDLE → ASSIGNED → WORKING)

When `assignment.md` appears in your container (`../assignment.md`, NOT inside
the checkout/ worktree):

### 4.1 Read carefully

1. Read `assignment.md` end to end.
2. Read every file in the **Inputs** section (blueprints, source
   files, design docs).
3. Read your project's `AGENTS.md` if you haven't already this session.
4. If the assignment has a **Data-change guards** section, read
   `__garelier/<pm_id>/control/operations/data_change_policy.md` now.

### 4.2 Sanity check before starting

Ask yourself, before touching code:

- Do I understand the goal in plain language?
- Are the acceptance criteria concrete enough to verify?
- Are the listed input files all present and current?
- Is the branch name in the assignment unambiguous?
- Is anything in `Out of scope` likely to be mistaken for in-scope?
- If data-changing: is the dry-run strategy clear? Is the user
  approval channel specified?

If any answer is "no" or "I'm not sure," **transition to BLOCKED**
(see §10) before changing anything. Do not guess.

### 4.3 Update STATE.md and start working

Once the assignment is clear:

1. Update `STATE.md` to status `ASSIGNED`. Record the task ID and the
   timestamp.
2. Create the workbench branch from the integration branch:
   ```bash
   # You are inside __garelier/<pm_id>/_workers/<id>/checkout/, on detached HEAD.
   git fetch origin
   git checkout -b garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug> garelier/<target-slug>/<pm_id>/studio
   ```
   The integration branch should already be current with `<target>` —
   Dock runs base tracking before dispatching you. If you
   suspect drift, mention it in a state-change notification (don't
   try to merge `<target>` yourself).
3. Update `STATE.md` to status `WORKING`.
4. Write a state-change notification to
   `__garelier/<pm_id>/runtime/dock/inbox/<YYYYMMDD-HHMMSS>-<your-id>-state-change.md`
   using `templates/inbox_notification.md`. Content: "transitioned
   ASSIGNED → WORKING for task #<id>".

## §5. Implementing the work (WORKING)

### 5.1 Discipline during implementation

> The **general** implementation / debugging / change-isolation / evidence
> principles are Librarian-managed canonical knowledge in
> the `engineering/` knowledge tree (DEC-029). Consult them for a bug fix, refactor,
> unclear implementation path, cross-module change, or repeated gate failure. The
> bullets below are the Worker-specific application — when they and the tree
> disagree, the tree is the source of truth.

- **Commit incrementally.** Each commit should have a clear, focused
  message. "WIP" is fine for in-progress work, but rebase or amend
  before reporting so the final history is clean.
- **Pre-commit hygiene (mandatory).** Before every `git add` / commit, review the
  staged diff and confirm no secret, token, key, credential, customer data, or
  real PII is in the change, the commit message, or the branch name — per
  the `security/commit_hygiene_policy.md` knowledge file. A secret that reaches a
  commit is compromised even if a later commit removes it. The Guardian gate is
  the backstop, not your excuse to skip this.
- **Stay within scope.** If you find yourself wanting to refactor
  something outside the assignment's Inputs, stop and reconsider:
  is this strictly required to satisfy an acceptance criterion? If
  yes, escalate to BLOCKED to confirm with Dock. If no, leave
  it.
- **Use web search for narrow technical questions.** API references,
  syntax checks, error message lookups — these are fine within your
  task scope. Do not use web search for design decisions or
  architecture questions; those go to BLOCKED.
- **Run partial checks frequently.** Don't wait until the end to
  discover the build is broken. Run `cargo check`, syntax checkers,
  unit tests for files you've touched, etc., as you go.

### 5.2 When to escalate during implementation

Transition to BLOCKED (§10) if:

- An acceptance criterion is impossible or contradictory.
- A required input file is missing or empty.
- You discover the work depends on another blueprint/Worker that
  hasn't shipped.
- The work as scoped will produce a result that violates project
  invariants (e.g., would break MOD compatibility per `AGENTS.md`).
- You need a design decision that wasn't in the assignment.
- The assignment looks data-changing but lacks a Data-change guards
  section (the blueprint is incomplete; do not improvise).

Do not silently work around problems. Silent assumptions cause
rework.

### 5.2.1 Observer direction advice

If the assignment scope is clear but you need
**implementation-direction** advice, you may request Observer advice
(kind `direction_advice`) — ONLY for choices **inside the existing
assignment scope**. The Observer is a read-only sidecar; its advice is
non-binding and never changes what you are accountable for.

**Allowed** questions:

- which existing pattern to follow;
- which local abstraction is smaller / safer;
- how to split a local change;
- whether to reuse or duplicate a helper for this task.

**Not allowed** (these are decisions, not direction):

- changing acceptance criteria;
- expanding scope;
- making product / architecture / security policy;
- approving migrations or production data writes.

If the question touches a forbidden area, do **not** ask the Observer —
transition to BLOCKED (§10) and ask Dock/PM instead. (The Observer
will itself return `ESCALATE_TO_DOCK_OR_PM` and give no advice on a
forbidden question.)

Observer advice is **non-binding**; you remain accountable. If you adopt
advice, record the advice id and the reason in `report.md` (§7.1). If
adopting it would change scope, transition to BLOCKED (§10) first — you
cannot grow scope on Observer advice alone.

### 5.3 Updating your STATE.md

Keep `STATE.md` current. At minimum, update:

- The "Last activity" timestamp whenever you actively work.
- The "Recent log" with one-line entries for major milestones
  (commits made, tests passing, blockers encountered).
- The "Next planned action" when it changes.

Dock reads your STATE.md to know if you're alive and what
you're doing.

**Format is fixed.** Always use the canonical headers from
`../../garelier-core/templates/state.md`:

```markdown
## Status

WORKING

## Current branch

`garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>`

## Current task

Task #<id>: <one-line summary>

## Last activity

<ISO8601> -- <action>

## Recent log (last 10 entries, most recent first)

- <ISO8601> -- <action>
...
```

Do **NOT** switch to list-item form (`- Current state: WORKING`,
`- Task ID: ...`, `- Picked up at: ...`). The status helper parses
canonical `## Section` headers; list-item form makes the helper
fall back through aliases and may misreport your state. It also
breaks Dock's quick STATE.md scan during its iteration.

**Per-field length limits (LOAD-BEARING).** Each STATE.md field
content MUST be compact:

| Field | Max | Style |
|---|---|---|
| `## Status` | 1 word | `IDLE` / `WORKING` / `REPORTING` / `REVIEWING` / `MERGED` / `REWORK` / `BLOCKED` / `ABORTED` |
| `## Current branch` | 1 line, ≤ 120 chars | branch name in backticks, optional " (detached HEAD)" suffix |
| `## Current task` | 1 line, ≤ 100 chars | `Task #<id>: <one-line summary>` — NOT a multi-paragraph re-description of the assignment |
| `## Last activity` | 1 line, ≤ 120 chars | `<ISO8601> -- <verb>: <short action>` |
| `## Recent log` | bullet list, each entry ≤ 120 chars | most recent first, max 10 entries — older ones drop off |

The status helper truncates long fields to ~100-120 chars with
"..." so anything longer is invisible to PM/user anyway. If you
need to record the full reasoning, write it in `report.md` (which
PM/Dock reads at REPORTING) or your container's `../archive/<id>/`
folder — NOT in STATE.md fields.

Bad (don't do this):
```markdown
## Current task

Task #9 — HP-P1-4 step 4 drift resync 完遂。merge commit `f77bbfb9`
clean (= 1 conflict STATE.md root `--ours` resolve、production conflict 0)、
7 gate re-verify all green (= dev profile fresh build / 8954 test pass /
clippy / fmt / shader_validate / dispatch_bench 9-axis threshold passed=true
/ snapshot_validate failure_messages=[])、report.md § Drift resync section
append + restore...  [continues for 500+ chars]
```

Good:
```markdown
## Current task

Task #9: HP-P1-4 step 4 — render graph edge (drift resync complete, ready for merge gate).
```

## §6. Running the quality gate (before REPORTING)

Before you transition to REPORTING, the quality gate must pass.

### 6.1 What the gate is

`AGENTS.md` §2 (or the equivalent) lists the project's quality gate
commands. For Rust projects, this typically includes:

```bash
cargo check --workspace --locked
cargo test --workspace --locked
```

Plus any project-specific commands (asset checks, lint passes, etc.).

### 6.2 Run from inside your worktree

```bash
# Already in __garelier/<pm_id>/_workers/<id>/checkout/, on garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>.
pwd
git rev-parse --show-toplevel
git branch --show-current
<quality gate commands here>
```

### 6.2.1 Auto-fix formatting FIRST (DEC-049)

A formatter is deterministic and auto-fixable, so a formatting violation must
NEVER reach the merge gate — there it would fail the (expensive) full gate and
force a whole rework cycle for a whitespace nit. Before running the check gate,
run the project's declared auto-fix command(s) ONCE (`[quality_gate.autofix]` in
setup_config; e.g. `cargo fmt --all`, `ruff format .`, `go fmt ./...`), then
commit any resulting change:

```bash
cargo fmt --all            # or the project's declared autofix command
git diff --quiet || (git add -A && git commit -m "<task> step N: rustfmt")  # commit only if it changed files
```

The driver grants the declared autofix command to your `--allowedTools`. If it
is still permission-blocked in your environment, apply the formatter's reported
diff by hand instead (your edits are auto-accepted) — either way, do not enter
REPORTING with a `fmt --check` failure. Run the autofix at most ONCE per
REPORTING attempt; a check that still fails after it is a real defect → §6.3.

### 6.3 Failure handling

> Canonical gate / flaky-test / regression handling is Librarian-managed in
> the `quality/` knowledge tree (`quality_gate_policy.md`, `flaky_test_policy.md`,
> `regression_policy.md`; DEC-029). The steps below are the Worker-specific
> application of that knowledge.

If a check fails:

- **First: investigate.** Read the failure. Decide if it is caused
  by your changes or by something pre-existing.
- **If caused by your changes**: fix it. Commit the fix. Re-run the
  gate.
- **If pre-existing**: this is a project-state issue. Transition to
  BLOCKED and report it to Dock. Do not "work around" by
  ignoring the failure.
- **If intermittent (flake)**: re-run once. If it fails twice in a
  row, treat it as a real failure and investigate.

Do not transition to REPORTING with a failing gate. Dock will
re-run the gate post-merge and will reject your work; you will save
no time.

## §6.5 Workbench-side base tracking

For long-running tasks, `<target>` and the integration branch may
advance while you're WORKING. To keep the workbench branch close to
the latest integration tip, periodically pull studio in. Dock now
**systematically** drops a `track-target.md` when your branch drifts behind
`studio` (DEC-039, forward-integration) — so expect a **moving base**: after a
catch-up merge, re-read any files you depend on before continuing, since `studio`
may have changed them. You perform the merge and resolve conflicts yourself.

### 6.5.1 When to do it

Trigger base tracking on the workbench branch when:

- You receive an instruction from Dock
  (`__garelier/<pm_id>/_workers/<id>/track-target.md` appears — see
  garelier-dock/references/review-and-merge.md §8.5).
- You've been WORKING for more than ~4 hours and want a clean
  integration point before continuing.
- The quality gate behaves oddly in a way that suggests stale
  dependencies (e.g., a transitive crate update landed in studio).

Do **not** rebase pre-emptively on every commit. Tracking has a cost
(rebuild caches, possible conflict resolution) and should be done
when there's a reason.

### 6.5.2 How to do it

Use **merge**, not rebase, by default. Rebase rewrites history that
Dock and reviewers may have already inspected; merge appends.

```bash
# Inside __garelier/<pm_id>/_workers/<id>/checkout/, on your workbench branch
git fetch origin
git merge --no-edit origin/garelier/<target-slug>/<pm_id>/studio
```

If conflicts occur:

1. Resolve each conflict, preferring your in-progress changes for
   files you own and incoming studio changes for files outside your
   assignment.
2. `git add` the resolved files and `git commit --no-edit` to
   complete the merge.
3. Re-run the quality gate (§6) — base tracking can introduce
   regressions that were not your code's fault.
4. If you cannot resolve a conflict (e.g., another Worker's recent
   merge contradicts your design), transition to BLOCKED (§10).
   Don't guess what the other Worker intended.

Add a note to `STATE.md` "Recent log" when you complete tracking:
`<timestamp> tracked target; resolved N conflicts`.

### 6.5.3 If you're in REWORK

Base tracking during REWORK follows the same procedure. After tracking
+ resolving + addressing review feedback, transition to REPORTING.

### 6.5.4 Rebase is allowed only with explicit instruction

If Dock's `track-target.md` says `strategy: rebase`, then use
rebase instead of merge. Use this only when Dock confirms it is
safe (no other tooling in this workspace consults the previous branch
state).

```bash
git fetch origin
git rebase origin/garelier/<target-slug>/<pm_id>/studio
```

Do NOT push the workbench branch after rebase. Garelier coordination
branches are local-only per `garelier-core/protocol.md` §6.5; the
rebase result stays in your local worktree only.

## §6.6 Completion Coverage Audit (before REPORTING)

The quality gate proves the build and tests pass; it does NOT prove you
did everything the assignment asked. Before writing `report.md`, run this
audit against `assignment.md` and the linked blueprint. Its purpose is to
catch the "tests are green but a Do item was dropped" failure.

Confirm every line. Each needs concrete evidence — a file, a diff, a
test, a commit — not a mental "probably done":

- [ ] **Goal** satisfied (`assignment.md` §Goal).
- [ ] Every **Do** item processed (`assignment.md` §Do) — none silently skipped.
- [ ] Every **Acceptance criterion** met with evidence (`assignment.md` §Acceptance criteria).
- [ ] Blueprint **Functional requirements** all covered — re-read the linked blueprint; do not trust memory.
- [ ] Blueprint **Non-functional requirements** not violated (perf, security, compatibility, docs/examples).
- [ ] Stayed within **Out of scope** (`assignment.md` §Out of scope) — no drift into forbidden areas.
- [ ] Reviewed every file/resource listed in **Inputs** (`assignment.md` §Inputs).
- [ ] Changed files fall within the assignment's intended scope.
- [ ] Any **extra** touched file has a stated reason (recorded in `report.md`).
- [ ] Quality gate (§6) passes.

### If any item is uncertain

Do NOT transition to REPORTING with an unchecked or uncertain item.
"Tests pass" is not a substitute for coverage. Instead:

- continue working and close the gap, or
- transition to BLOCKED and write `questions.md` (§10) when the gap needs
  a decision you cannot make, returning the judgment to Dock.

A REPORTING transition asserts that this audit passed. Record its result
in `report.md` (§7.1) so Dock's Assignment Coverage Review can verify
it rather than re-derive it.

## §7. Writing the report (WORKING → REPORTING)

When the gate passes and all acceptance criteria are met:

### 7.1 Write `report.md`

Use `../../garelier-core/templates/report.md`. Save to
`__garelier/<pm_id>/_workers/<id>/report.md`.
Also write the compact sibling `report.json` from
`../../garelier-core/templates/report.json`. Keep it to
schema/version, status, one-line summary, commits, files, tests, risk flags, and
needs; do not copy the Markdown body.

A good report includes:

- **What was done** — high-level summary of the work.
- **How it was done** — key implementation decisions, why this
  approach over alternatives.
- **Acceptance criteria check** — go down the list from
  `assignment.md` and confirm each.
- **Completion Coverage Audit** — the §6.6 result (Goal, Do items,
  functional + non-functional requirements, inputs reviewed, scope,
  extra touched files). This is what Dock's Assignment Coverage
  Review reads.
- **Quality gate output** — paste the green output (last few lines of
  `cargo test`, etc.).
- **Files changed** — list, with one-line descriptions.
- **Data-change evidence** (if applicable) — dry-run output,
  before/after counts, sample records, rollback verification,
  reference to the user-approval entry in `_pm/history.md`.
- **Anything Dock should know** — odd cases, future cleanup
  candidates, things you noticed but did not change.

Keep it compact: `result`, `diff`, `AC`, `QG`, `risks`, `next`.
Use `path -- effect` for changed files. Paste only the final lines of
quality-gate output needed as evidence; link or summarize the rest.

### 7.2 Do not push the branch

The workbench branch stays local. Garelier coordination branches
are local-only per `garelier-core/protocol.md` §6.5 — Dock
reads your branch directly from the shared repo's local refs (your
worktree and the primary checkout share the same `.git/`), so no
push is needed for Dock to merge it.

### 7.3 Notify Dock

1. Update `STATE.md` to status `REPORTING`.
2. Write a state-change notification to
   `__garelier/<pm_id>/runtime/dock/inbox/<YYYYMMDD-HHMMSS>-<your-id>-state-change.md`
   referencing your `report.md`.
3. Wait. Do not modify the branch. In driver mode, `REPORTING` and
   `REVIEWING` are marker-waiting states; the driver does not spawn
   Worker again until `under_review.md`, `review.md`, `merged.md`, or
   `abort.md` appears.
