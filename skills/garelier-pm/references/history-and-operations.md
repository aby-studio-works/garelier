# Garelier PM History and Operations Reference

History tracking, blueprint re-execution, runtime status, clean stop, retire-and-requeue, cleanup, and health checks.

Extracted from the previous role `SKILL.md`; legacy section numbers are intentionally preserved for cross-references.

## §11. History tracking

`__garelier/<pm_id>/_pm/history.md` is the **hot index** for every
blueprint PM has dispatched plus structural events (project init, agent
set changes, promotes). In high-volume projects, old completed entries
move to `_pm/history/archive/YYYY-MM.md` per
`garelier-core/retention.md`. The hot file plus archive files are the
ground truth for "what has this PM done", and the index that
re-execution (§12) uses to find a past blueprint.

### 11.1 File format

The wizard creates the file on fresh init with entry #001 (the init
itself). Every subsequent entry is appended in this shape:

```markdown
## #042 — 2026-05-24T14:33:21Z — Add settings page
- Blueprint: __garelier/<pm_id>/control/blueprints/add-settings-page.md
- Milestone: MVP completion
- Outcome: in-progress
- Notes: (free text — added context, decisions, links)
```

When the entry was created without user confirmation (autonomous mode,
§15), the Outcome is prefixed `autopilot:` and Notes includes the
autopilot reason:

```markdown
## #043 — 2026-05-24T14:35:00Z — Refactor auth
- Blueprint: __garelier/<pm_id>/control/blueprints/refactor-auth.md
- Milestone: MVP completion
- Outcome: autopilot: in-progress
- Notes: auto_approve_blueprints=true. Open questions recorded in blueprint.
```

The hot file ends with a hidden marker:

```markdown
<!-- Next entry number: 43 -->
```

Numbers are sequential, never reused, and zero-padded to a minimum of
three digits in the heading (they grow beyond three with no upper bound —
see control_contract.md "ID numbering"). The marker tracks the next number
to assign. PM keeps the marker as the last non-blank line of the file.

The full template is in `templates/history_entry.md`.

When entries have been archived, keep an `## Archived history` section
in the hot file:

```markdown
## Archived history

- `archive/2026-05.md` — #001-#120
```

Archive files never contain the `Next entry number` marker.

### 11.2 When PM appends an entry

Append a new entry whenever:

- A blueprint is committed (Outcome: `in-progress`)
- A blueprint ships, i.e. is included in a promote (Outcome: `shipped`)
- A blueprint is abandoned by the user (Outcome: `abandoned`)
- A promote is executed (§7) — Outcome: `promoted`, Notes record the
  range and tag
- The agent set is changed via diff-mode wizard (the wizard writes
  this entry itself; PM does not)
- Project init (the wizard writes #001)
- A base-tracking conflict was resolved (§7.5) — Outcome:
  `merge-resolution`, Notes record the conflicted paths and which
  side won (or the synthesis used)
- A data-changing blueprint receives explicit user approval for
  execution — Outcome: `data-change-approval`, Notes record the
  blueprint slug, the execution scope, and the user's exact words
  (per data_change_policy.md)

For a milestone change on an already-active blueprint, **update** the
existing entry's `Milestone:` line in place (don't append a new one),
and add a brief note in the `Notes:` field. Apart from retention
rotation (§11.2.A), this is the only allowable in-place edit on
`__garelier/<pm_id>/_pm/history.md`.

### 11.2.A Retention rotation

Triggered when `[retention]` exists or defaults apply and
`history.md` exceeds `history_hot_entries` completed entries.

1. Read `history_hot_entries` and `history_archive_granularity` from
   setup_config or `retention.md` defaults.
2. Keep all `in-progress` / `autopilot: in-progress` entries in the
   hot file, regardless of age.
3. Keep the newest `history_hot_entries` completed entries in the hot
   file.
4. Move older completed entries into
   `_pm/history/archive/YYYY-MM.md`, grouped by entry timestamp month.
   Preserve each entry block exactly.
5. Update `## Archived history` in the hot file with archive path and
   entry-number ranges.
6. Leave `<!-- Next entry number: N -->` as the last non-blank line of
   the hot file.
7. Commit the hot file and archive file changes:
   `maintenance: rotate PM history`.

### 11.3 When a blueprint ships or is abandoned

When the blueprint ships:

1. Find its entry in `__garelier/<pm_id>/_pm/history.md` and change
   `Outcome: in-progress` to `Outcome: shipped`. Add the promote
   date in `Notes:`.
2. Move `__garelier/<pm_id>/control/blueprints/<slug>.md` to
   `__garelier/<pm_id>/control/blueprints/archive/<slug>.md`.
3. Commit:
   ```bash
   git mv __garelier/<pm_id>/control/blueprints/<slug>.md __garelier/<pm_id>/control/blueprints/archive/<slug>.md
   git add __garelier/<pm_id>/_pm/history.md
   git commit -m "blueprint: <slug> shipped"
   ```

When the blueprint is abandoned (user decides to drop it):

1. Change `Outcome: in-progress` to `Outcome: abandoned`. Note the
   reason in `Notes:`.
2. Move the blueprint to
   `__garelier/<pm_id>/control/blueprints/archive/<slug>.md` so it remains
   discoverable for re-execution but doesn't clutter the active list.
3. Commit similarly.

### 11.4 Showing history to the user

When the user asks "what have we done", "show me history", or
"show me recent blueprints":

1. Read `__garelier/<pm_id>/_pm/history.md`.
2. Show the last N entries (default: 10) in compact form. Format:
   ```
   #042  2026-05-24  Add settings page         in-progress
   #041  2026-05-22  Refactor auth module      shipped
   #040  2026-05-20  Survey GPU compute crates shipped
   ```
3. If the user asks for full detail of a specific entry, read it
   from history.md or `_pm/history/archive/*.md` and show the full
   block, then offer to read the linked blueprint from
   `__garelier/<pm_id>/control/blueprints/` or
   `__garelier/<pm_id>/control/blueprints/archive/`.

## §12. Re-executing a past blueprint

The user may want to repeat a previously-completed blueprint —
typically for periodic work like "run a full test pass" or "regenerate
the status report". This is also the mechanism that pairs with Claude
Code's `/loop` command to schedule recurring runs without baking a
scheduler into Garelier.

### 12.1 Trigger

Phrases that mean "re-execute":

- "re-run #042"
- "do that test pass again"
- "rerun the status report"
- "run #017 again"

If the user names a blueprint by topic but not number, search
history.md for a matching blueprint and confirm with the user before
proceeding.

### 12.2 Process

1. **Find the original entry** in `__garelier/<pm_id>/_pm/history.md`; if
   missing, search `__garelier/<pm_id>/_pm/history/archive/*.md`. If the
   blueprint is in
   `__garelier/<pm_id>/control/blueprints/archive/<slug>.md`, read it from
   there. If still in `__garelier/<pm_id>/control/blueprints/<slug>.md`,
   read it there.
2. **Compute a new slug** by appending a numeric suffix:
   - If `<slug>` has no suffix: `<slug>-2`
   - If `<slug>` ends with `-N`: `<slug>-(N+1)` where the new N is
     the smallest integer such that
     `__garelier/<pm_id>/control/blueprints/<new-slug>.md` and
     `__garelier/<pm_id>/control/blueprints/archive/<new-slug>.md` both do
     not exist.
   - Examples: `auth-refactor` → `auth-refactor-2` →
     `auth-refactor-3`. `status-report-2` → `status-report-3`.
3. **Copy the original blueprint** to
   `__garelier/<pm_id>/control/blueprints/<new-slug>.md`.
4. **Update its Context section** to add a line:
   `Re-execution of #<original-id> (original blueprint: <original-slug>).`
   Update any time-bound details (dates, branch names, snapshot
   references) that need to refresh.
5. **Confirm the milestone** with the user. The original blueprint's
   milestone may be shipped already; ask which milestone the
   re-execution belongs under (or whether to create a new one).
6. **Show the modified blueprint to the user** and iterate until
   approved.
7. **Append a new entry to `__garelier/<pm_id>/_pm/history.md`** linking the
   new blueprint and noting the re-execution origin.
8. **Commit** as in §4.1 step 8.

### 12.3 Handling a still-running re-execution

If the user requests another re-execution of #N while a previous
re-execution (say #N+5, with slug `<slug>-2`) is still
`in-progress`, ask the user:

- Wait for the current run to finish before starting a new one?
- Run a new instance in parallel (creating `<slug>-3`)?
- Abort the current run (§13) and start fresh?

Do not silently start a parallel run. Re-runs of the same work in
parallel almost always indicate a misunderstanding.

### 12.4 Periodic triggers

Periodic re-execution is triggered externally. There are two supported
contracts:

- The user uses `/loop` (Claude Code's repeat-prompt capability) with
  a prompt like "re-run #042". On each loop iteration, PM treats it as
  a fresh re-execution request via §12.2.
- The project defines an RRULE job in
  `__garelier/<pm_id>/control/scheduled_jobs/<job_id>.toml`; an external
  scheduler notifies PM at the configured time.

Garelier owns the job definition and safety policy, not the clock.

## §13. Showing what's running, and stopping it cleanly

The user does not have a live dashboard of agent activity. PM is the
inspection point. PM also provides the **only** safe way for the user
to stop work in progress: by writing a clean-stop signal that the
target agent will pick up at its next session boundary.

### 13.1 "What's running?"

Triggered by phrases like "what's running", "show me active work",
"what is everyone doing", "agent status", "ステータス", "状況",
"状態確認".

PM has two response modes, depending on what the user wants:

#### 13.1.A One-shot inspection inside this chat (default)

For a one-time check inside the current PM conversation:

1. List all `__garelier/<pm_id>/_workers/<id>/STATE.md`,
   `__garelier/<pm_id>/_scouts/<id>/STATE.md`, and
   `__garelier/<pm_id>/_smiths/<id>/STATE.md`.
2. For each, read the file (it's a small Markdown file maintained by
   the agent). Extract:
   - Status (IDLE / WORKING / BLOCKED / REPORTING / etc — see
     `../../garelier-core/state_machine.md`)
   - Current task line
   - Last activity timestamp
   - For Scouts in `REPORTING`, the inspection destination and whether
     `git log -1 -- <destination>` shows a committed accepted copy.
3. Read `__garelier/<pm_id>/_dock/STATE.md` if present, for
   Dock's own status.
4. Check dispatch state:
   - LIVE producers: any `__garelier/<pm_id>/_dispatch<N>/STATE.md`.
   - merge gate: `runtime/merge_gate/locks/active.lock` (running) and
     pending request count.
   - or simply run `skills/garelier-core/scripts/status.{sh,ps1}`.
5. Show a compact table with a top-line summary
   `DISPATCHING / GATE RUNNING / IDLE`:

   ```
   Status: DISPATCHING (1 live producer; gate idle)

   Agent                                          State      Task                                            Last activity
   __garelier/<pm_id>/_workers/worker-01         WORKING    garelier/main/<pm_id>/workbench/#042/settings  2026-05-24 13:50Z (40m ago)
   __garelier/<pm_id>/_workers/worker-02         IDLE       (none)                                          2026-05-23 22:14Z (16h ago)
   __garelier/<pm_id>/_scouts/scout-01           REPORTING  GPU crate survey                                2026-05-24 14:15Z (15m ago)
   __garelier/<pm_id>/_smiths/smith-01           IDLE       (none)                                          2026-05-24 14:20Z (10m ago)
   dock                                      ACTIVE     dispatching #043 phase 2                        2026-05-24 14:20Z (10m ago)
   ```
6. After the table, ask the user if they want to do anything
   (typically: nothing, or stop one of the items).

#### 13.1.B Live status in another terminal (user asks for "ステータス出して" / "別ターミナル" / "watch")

When the user wants a continuously-updating status display (not just
one snapshot), launch the project's `status.{sh,ps1}` helper in a
new terminal window with a 30-second refresh interval.

**Windows (default for this project):**
```powershell
Start-Process pwsh -ArgumentList @(
  '-NoExit',
  '-NoProfile',
  '-Command',
  "garelier status -ProjectRoot '<project-root>' -PmId '<pm_id>' -Watch 30"
)
```

**Unix:**
```bash
gnome-terminal -- bash -c "garelier status --project '<project-root>' --pm-id '<pm_id>' --watch 30; exec bash"
# or `xterm -e ...`, or open a new tmux pane, depending on the user's environment
```

Run the appropriate one via Bash with `Start-Process` (Windows) or
the user's terminal launcher (Unix). After running, tell the user:
"Status window opened in a new terminal, refreshing every 30
seconds. Ctrl-C in that window stops the watch."

If launching the terminal fails (e.g., no GUI on a headless Linux
host), fall back to telling the user the exact command to run
themselves (see §13.1.C).

#### 13.1.C "How do I show the status?" (user wants to learn the command)

Triggered by phrases like "ステータスの出し方", "how do I check
status", "what's the status command", "教えて".

Reply with the canonical commands the user can paste into their
own terminal. Default to 30-second refresh, since one-shot is
rarely what someone asking "how" actually wants:

```
# Windows (PowerShell)
garelier status -Watch 30

# Unix (bash)
garelier status --watch 30
```

Add explanatory notes:
- "`garelier` is the bundled dispatcher; it works in the agent's shell
  (the plugin adds `bin/` to PATH). To run it in your OWN terminal, add
  the plugin/checkout `bin/` to your PATH first, or call the script by its
  full path."
- "Auto-detects the PM if exactly one `__garelier/<pm_id>/`
  exists. Otherwise pass `-PmId <id>` / `--pm-id <id>`."
- "Walks up parent directories to find the project root, so it
  works from any subdir."
- "Top-line summary shows `RUNNING / STOPPED / SHUTTING_DOWN /
  STOPPED_DIRTY`."
- "Ctrl-C exits the watch."

If the user wants a one-shot (no auto-refresh), tell them to drop
`-Watch 30` / `--watch 30`.

#### 13.1.D "Show me Scout's findings" (Scout completion query)

Triggered by phrases like "scout-01 の成果", "show scout's results",
"スカウトの調査見せて", "scout の完了済", "what did the scout
find", "any inspections from <topic>".

Per DEC-008, Scout never commits its own inspection — PM commits
the accepted copy after Dock review. So "what has Scout
finished?" is a PM question, not a manifest question. Use this
authoritative chain (do NOT trust only `runtime/manifest.md`,
which can lag the file-level truth):

1. **Live state** — Read `__garelier/<pm_id>/_scouts/<id>/STATE.md`:
   - `WORKING` → tell the user it's still in progress; quote
     `## Last activity` so they see the latest sub-step.
   - `REPORTING` → draft is ready, awaiting PM commit. Locate the
     intake item: `runtime/pm/inbox/<ts>-scout-intake-<task_id>.md`
     (per DEC-008). If you haven't processed it yet, this is the
     prompt to do so before answering.
   - `IDLE` → previous task complete. Find its archive.
   - `BLOCKED` → Scout has a question; show `questions.md` content
     and ask the user to resolve.
2. **Recent commits** — `git log --grep "scout" --oneline -20` on
   studio shows your past Scout-related commits. For a specific
   task: `git log --all -- __garelier/<pm_id>/control/inspections/`
   and grep for the topic. The commit messages should include the
   task id and scout id (PM commits them per DEC-008 step 3).
3. **Archived assignments** — `__garelier/<pm_id>/runtime/backlog/done/`
   contains completed task records. For each Scout task, the entry
   names the inspection path. If retention has moved older entries,
   also check `_pm/history.md` (and its monthly archive under
   `_pm/history/archive/YYYY-MM.md` per DEC-009).
4. **Direct file display** — When the user wants the actual content,
   `Read` the inspection file at the resolved path and quote the
   first 30-60 lines plus the executive summary. If the inspection
   is large (a monthly summary or long dump), prefer the summary
   section; mention the full path so the user can open it.

Output template (compact):

```
=== Scout scout-01 completion query ===
Current state:    IDLE (last task #23 closed 2026-05-25T16:42Z)
Last inspection:  __garelier/<pm_id>/control/inspections/tech/2026/05/2026-05-25-bevy-ecosystem-status.md
                  committed: 2d34a598 by PM (2026-05-25)
Open work:        (none / Task #N WORKING — last activity Xm ago)
Pending intake:   (none / runtime/pm/inbox/<ts>-scout-intake-<task>.md awaiting your review)

Recent Scout deliveries (last 5):
  #23 2026-05-25  bevy-ecosystem-status  inspections/tech/2026/05/...
  #18 2026-05-20  perf-baseline-Q2       inspections/benchmark/2026/05/...
  ...
```

If the user wants the *content* of a specific inspection, show the
first ~30 lines (or the `## Executive summary` block) and offer to
display more.

**Critical: "I've seen it, delete it / 見たから消して" handling.**

When the user says they've seen / consumed an inspection and asks to
remove or clean it up, the safe default is:

- **Do nothing destructive to git history.** Inspections are
  immutable historical records (Scout SKILL §3, DEC-008). The
  committed studio commit must stay in history; an inspection that
  the user has acknowledged is the same as an inspection they
  remember from yesterday — a permanent record. Future re-execution
  searches and audit trails depend on it.
- **Do NOT `git revert <inspection-commit>`.** Reverting a Scout
  inspection commit is wrong by default; it pollutes studio history
  with a noise revert and loses the durable record. Only revert if
  the user explicitly says "revert the commit" AND the inspection
  is provably incorrect (e.g., contained sensitive data committed
  by mistake, or factual errors that make it dangerous to keep
  around).
- **Do NOT stop any running producer.** "I've seen it" is a
  per-file acknowledgement, not a system stop signal. In-flight
  dispatches keep running. If the user wants to stop work, they will
  use the explicit phrases listed in §13.2 (Clean stop).

What you MAY do when the user says "見たから消して":

1. Acknowledge: "Inspection #N is on record at <studio commit SHA>.
   The on-disk file in the Scout's worktree is just a draft copy
   that gets archived to `_scouts/<id>/archive/<task_id>/` on the
   Scout's next IDLE transition — there's nothing left for me to
   actively delete."
2. If the user is concerned about clutter in their working tree
   listing: confirm the inspection's permanent home is the studio
   commit, and that no further action is needed. If they still want
   the file removed from CURRENT (not history), check with them
   that the studio commit is the canonical version, then `git rm`
   + commit ON STUDIO. Do NOT use revert.
3. Confirm Scout's REPORTING → IDLE transition will fire on next
   Scout iteration via the `committed.md` mechanism (DEC-008).
   You don't need to do anything special — Dock already wrote
   the trigger when it processed the intake.

If the user *really* wants the inspection rolled back from studio
history (rare, e.g., it contained secrets or was committed by
mistake), confirm with explicit yes/no questioning, then use
`git rm` + commit (preserves history showing it existed; commits a
deletion). Reserve `git revert` for cases where the user explicitly
says "revert" — and even then, double-check it's not a Scout
inspection (which is supposed to be immutable).

### 13.2 Clean stop

Triggered by phrases like "stop X", "abort worker-01", "cancel #042",
"kill the GPU survey".

PM does not directly terminate an agent. PM writes an **abort
signal** that the agent's state machine handles at its next session.
The agent's clean-shutdown sequence (state_machine.md §2 "Any state
→ ABORTED") **does not commit pending work** — it saves the
uncommitted state as patches under `archive/<ID>-aborted/` and resets
the worktree to a clean detached HEAD. This avoids landing
potentially broken WIP on a branch.

Process:

1. Identify the target. If the user gave an agent id (`worker-01`),
   confirm which role (worker or scout) by reading STATE.md. If the
   user named a blueprint/task, find which agent owns it.
2. Confirm with the user: **"Stop worker-01's current task
   (garelier/main/<pm_id>/workbench/#042/settings)? Uncommitted changes will
   be saved as a patch under archive/, the worktree will be reset
   to clean, and the agent will return to IDLE. Confirm?"**
3. On confirmation, write `abort.md` into the role's container
   (`<container>/abort.md`). The container is `__garelier/<pm_id>/_<role>/<id>/`
   for the default **in-project** layout (DEC-036) — write there directly. ONLY
   when **exile** is opted in resolve it from
   `__garelier/<pm_id>/runtime/workspace_paths`
   (`<role-singular>.<id>=<absolute container>`), falling back to the in-project
   path when absent. The `abort.md` contains:

   ```markdown
   # Abort signal
   Issued at: <ISO timestamp>
   Issued by: PM (user request)
   Reason: <user's stated reason, or "user request">

   Action: clean shutdown per state_machine.md §2 (Any state → ABORTED).
   ```

   The `Issued by:` field is mandatory; it lets the Worker / Scout / Smith
   and later audit understand who initiated the abort. PM and
   Dock are both permitted writers of `abort.md`; PM uses this
   path for user-requested aborts, Dock for execution-driven
   ones.

4. The agent's next session will detect `abort.md`, perform the
   clean-shutdown sequence, and remove `abort.md` itself when done.
5. Append a note to `__garelier/<pm_id>/_pm/history.md` if the aborted task
   corresponds to an in-progress blueprint entry: change its Outcome
   from `in-progress` to `aborted` (a new outcome value) and add the
   reason in Notes.
6. Update `__garelier/<pm_id>/runtime/manifest.md`'s recent activity line.
7. Tell the user: **"Stop signal written. The agent will clean up at
   its next session start. You can verify with 'what's running'."**

### 13.2.B Retire and requeue (not aborted)

Triggered by phrases like "delete this Worker but keep the task",
"return it to pending", "do not mark it aborted", "作業前に戻す",
"pending に戻す", or "中止済みにしない".

Use this when the user wants to remove or replace an active Worker /
Scout / Smith but does **not** want the assigned task recorded as `aborted`.
This is a PM-owned backlog repair workflow. It does not ask the agent
to run a clean-shutdown turn.

Rules:

- Do not write `abort.md`.
- Do not mark the agent `ABORTED`.
- Do not change the task id.
- Do not increment `runtime/backlog/next_id` for the returned task.
- Record PM history outcome `requeued`, not `aborted`.

Process:

1. Ensure no producer is live in that worktree first (its
   `_dispatch<N>/STATE.md` is gone or the subagent returned). Never remove
   a worktree mid-dispatch.
2. Identify each active assignment from the agent `STATE.md`,
   `assignment.md`, and `runtime/backlog/in_flight.md`. Record the
   task id, blueprint path, milestone/phase, role type, and dependency
   note exactly as written in the backlog row.
3. Pause the involved blueprint(s) (`Status: paused`) when immediate
   redispatch would be unsafe. This is especially important for GUI /
   GPU / exclusive-resource tasks.
4. Confirm with the user before discarding the current worktree:
   **"Requeue #042 from worker-01 without marking it aborted?
   Unmerged WIP will not be merged. The same task id returns to
   runtime/backlog/pending.md. Confirm?"**
5. If there are local commits or uncommitted patches the user may want
   for audit, archive them under
   `runtime/backlog/requeued/<timestamp>-<task-id>-<agent-id>/`
   using `git format-patch`, `git diff`, and a short `README.md`.
   This archive is runtime-only and may be pruned by retention policy;
   it is not a merge path.
6. `runtime/backlog/in_flight.md` is a GENERATED view (W-011) — it drops the
   row by itself once the producer container/STATE is gone. Refresh it with
   `garelier-core/scripts/dispatch_event.{sh,ps1} --regen-only` if needed;
   never hand-edit it.
7. Insert the same task row into `runtime/backlog/pending.md`, preserving
   the original task id and blueprint reference. Place it before later
   numeric task ids unless the dependency note requires a different
   order. If the blueprint was paused, annotate the row as paused in the
   same compact style Dock already uses.
8. Append/update the matching `_pm/history.md` entry:
   `Outcome: requeued`; notes include the prior agent id, whether WIP
   was archived, and the user reason.
9. Update `runtime/manifest.md`: add a compact activity line such as
   `PM -- requeued #042 from worker-01`. (Per-agent roster tables exist only
   in LEGACY manifests — W-011 manifests carry no execution rows; if a
   legacy table is present, remove the retiring agent from it after setup
   diff succeeds.)
10. Run setup wizard diff with the desired final pool and the explicit
    non-IDLE removal override:

    ```bash
    setup_wizard.sh --mode diff --allow-requeued-removal \
      --workers "<final workers>" --scouts "<final scouts>" --smiths "<final smiths>"
    ```

    ```powershell
    .\setup_wizard.ps1 -Mode Diff -AllowRequeuedRemoval `
      -Workers "<final workers>" -Scouts "<final scouts>" -Smiths "<final smiths>"
    ```

11. Commit the PM-owned backlog/history/config/manifest changes on
    studio. Only unpause the blueprint once replacement agents are ready.

### 13.3 Limitations

- The signal takes effect when the target agent next reads its
  worktree. If Claude Code is currently executing, the user can
  interrupt that turn manually; the abort.md ensures the next turn
  cleans up rather than continuing.
- PM cannot abort itself or Dock via this mechanism. If the
  user wants to stop a Dock-level decomposition, write a
  marker file at
  `__garelier/<pm_id>/runtime/dock/inbox/abort-<blueprint-id>.md` and
  let Dock handle it on its next pass. Dock's clean-stop
  protocol is in `../../garelier-dock/SKILL.md`.

### 13.4 Cleanup audit before re-arming the dispatch loop

Triggered when the user says "resume" / "再開" / "進めて" after a crash,
interruption, or session loss (and on any suspicion of residue).

An interrupted session may have left residue from a kill -9, power
loss, a mid-merge gate subprocess termination, or producer WIP that
didn't reach commit. **Audit and clean BEFORE dispatching new work** —
starting on top of dirt makes the next producer inherit confusing
state (pre-existing modified files, a stale merge-gate result, etc.).

Run this audit every time, even when state looks clean — it takes
30 seconds and prevents whole classes of "why is everything
stuck" debugging.

#### 13.4.1 Audit checklist

Run these checks in order, via Bash tool. For each, report findings
to the user and either auto-clean (when safe) or ask before acting.

**1. Orphaned dispatch containers**

```bash
# containers whose producer is gone but STATE.md says WORKING
ls -d __garelier/<pm_id>/_dispatch*/ 2>/dev/null
```

Action:
- A `_dispatch<N>/` with committed work and no live producer → the
  interrupted task. Either re-dispatch INTO the same worktree (resume)
  or `dispatch_cleanup.{sh,ps1} --id <N>` after preserving the branch.
- A `_dispatch<N>/` at the base commit with no work → safe to clean.

**2. Merge gate residue**

```bash
ls __garelier/<pm_id>/runtime/merge_gate/{requests,results,locks}/
cat __garelier/<pm_id>/runtime/merge_gate/locks/active.lock 2>/dev/null
```

Action:
- `locks/active.lock` present + its pid still alive → a merge-gate run IS
  running (caught by step 1 too). Refuse.
- `locks/active.lock` present + its pid dead → subprocess crashed.
  Remove the lock: `rm __garelier/<pm_id>/runtime/merge_gate/locks/active.lock`.
  The next `dock_merge.ts poll` will synthesize an `aborted` result
  per DEC-007 §2.5.
- `results/*.json` present → orphan results that Dock never
  consumed (= the session ended between subprocess success and the
  next Dock iteration). Leave them. The next poll/Dock
  Dock iteration will see them, write `merged.md` to the
  Worker (or `review.md` on failure), and archive. Tell the user
  "N orphan merge results found, will be processed on next
  Dock iteration." Don't delete unless user explicitly says
  so.
- `requests/*.json` present → orphan requests that weren't picked
  up. Same logic — the next poll will spawn the subprocess for
  them. Tell user, leave them.

**3. Partial merge in primary checkout**

```bash
test -f .git/MERGE_HEAD && echo "merge in progress: $(cat .git/MERGE_HEAD)"
```

Action:
- Present → a previous run was interrupted mid-`git merge --no-ff
  --no-commit`. Abort: `git merge --abort`. This restores working
  tree to the studio commit, drops staged-merge state.

**4. Primary checkout dirty state**

```bash
git status --short
```

For each file in the output, categorize:

| Path pattern                                              | Category | Default action |
|-----------------------------------------------------------|----------|-----------------|
| `AGENTS.md`, `CLAUDE.md`                                  | PM-owned (project docs) | Ask user: commit or leave? |
| `__garelier/<pm_id>/_pm/*` (history.md, setup_config.toml, .claude/...) | PM-owned | Ask user: commit or leave? |
| `__garelier/<pm_id>/control/*`                           | PM/Scout-owned | Ask user: commit or leave? |
| `__garelier/<pm_id>/runtime/*`                           | Gitignored — should never appear | Ignore (gitignored anyway) |
| Files matching content on an active workbench branch       | Worker leak (from interrupted merge gate) | Auto-revert: `git checkout HEAD -- <file>` or `rm` if untracked. Tell user. |
| Anything else                                              | Unknown | Show diff to user, ask |

**Detecting Worker leak**: a file `M` or `??` in primary checkout
that exists identically on `garelier/<target-slug>/<pm_id>/workbench/#<N>/<slug>` for
some active Worker is almost certainly leftover from Dock's
merge gate `git merge --no-ff --no-commit` that didn't commit.
Confirm by:
```bash
git diff <workbench-branch> -- <path>     # empty diff = leaked from there
```
If confirmed, revert it. The Worker's workbench branch retains the
work; the next §8.1 merge gate dispatch will properly merge it.

**5. Worktree HEAD drift**

```bash
git worktree list
```

Action:
- Scout / IDLE Workers on detached HEAD pointing at a studio tip
  older than current `garelier/<target-slug>/<pm_id>/studio` →
  not an error. Per Scout SKILL §3 + Worker SKILL §9.1, they
  re-attach to the current studio tip on their next iteration.
  Just note it: "Scout scout-01 is on f798d024, studio is at
  53e6312d; re-attach happens automatically on next Scout iter."
- A `workbench`/`anvil`/`shelf` branch with committed work → in-flight
  inventory; requeue or resume by re-dispatching into its worktree.
- A worktree path that no longer exists on disk → run
  `git worktree prune`. Then file a heads-up to user (something
  deleted a worker's worktree dir).

#### 13.4.2 Decision protocol

For each audit finding, classify:

- **Auto-safe** (= no user input needed): dead-pid `active.lock`, producer-leak
  files with confirmed `git diff <workbench> = empty`,
  `git merge --abort` for an orphan `MERGE_HEAD`.
- **User input needed**: PM-owned dirty files, unknown dirty
  files, any worktree anomaly that's not just a stale tip.

Auto-safe actions: perform them, then tell the user what was
cleaned. Format:

```
Pre-flight cleanup performed:
- aborted orphan merge state (MERGE_HEAD pointed to workbench/#12)
- reverted Worker leak: core/middleware/chunk/src/{lib.rs, residency.rs} (matched workbench/#12 tip)
- 1 orphan merge_gate/results/<file>.json kept — Dock will consume on next iteration
```

User-input items: ask via `AskUserQuestion` with options Commit /
Leave / Show diff first. Never auto-commit PM-owned files —
those represent the user's in-progress conversational state and
deserve explicit acknowledgement.

#### 13.4.3 After audit passes

Resume dispatching: re-dispatch any interrupted task into its preserved
worktree (or `dispatch_cleanup` + fresh `dispatch_prepare`), then continue
the normal loop (jig tick or prose tick). Tell the user what was resumed.

#### 13.4.4 Why not skip the audit?

Historical incidents that this audit prevents (= caught in
practice on Project-X before this section existed):

- **Scout stayed REPORTING forever** (2026-05-25) — Dock
  wrote `committed.md` but Scout SKILL didn't know what to do
  with it. (Fixed by Scout SKILL update.) An audit catches the
  inverse: leftover `committed.md` / `merged.md` from a partial
  cycle that should be cleaned before resume.
- **`M core/middleware/chunk/src/lib.rs`** in primary checkout
  (2026-05-26) — Dock's merge gate sandbox left Worker leak
  when a session stopped mid-cycle. Without audit, the next
  run dispatched on top of this drift.
- **`M script/bin/sccache.exe` everywhere** — 19MB tracked binary
  that sccache touches on every cargo run. Audit catches
  patterns of "same DIRTY file across all worktrees, looks like
  build artifact" and prompts to untrack.

The audit is cheap (under a minute) and prevents these from
silently compounding.

## §14. Optional health check

Garelier does **not** auto-scan agent state on PM startup. Instead,
health check is an explicit user-invoked tool, and only available if
the user has opted in by uncommenting the `[health_check]` section
in `__garelier/<pm_id>/_pm/setup_config.toml`.

### 14.1 Enabling

The wizard generates `__garelier/<pm_id>/_pm/setup_config.toml` with the
section commented out. To enable, the user uncomments and edits
thresholds:

```toml
[health_check]
worker_working_warn_hours = 24
worker_blocked_warn_hours = 12
scout_working_warn_hours = 12
scout_reporting_warn_hours = 6
dock_silent_warn_hours = 24
pending_backlog_warn_hours = 48
```

Any threshold can be omitted to disable that specific check.

### 14.2 Detection

On every session start, after reading `setup_config.toml`, check for
a `[health_check]` section.

- Section absent (commented out): feature is **off**. Do not scan,
  do not mention health.
- Section present: feature is **on**. Tell the user once at session
  start that health check is available ("you can ask 'run a health
  check' to scan for stale work"), but do not run the scan
  automatically.

### 14.3 Running a health check

Triggered by phrases like "health check", "scan for stuck work",
"any agents stalled".

Process:

1. Read `[health_check]` thresholds.
2. For each Worker/Scout/Smith, read STATE.md, extract Status and Last
   activity timestamp.
3. Compute hours-since-last-activity for each.
4. For each agent, if its (Status, hours) exceeds the matching
   threshold, flag it.
5. For Dock, read `__garelier/<pm_id>/_dock/STATE.md` and
   apply `dock_silent_warn_hours`.
6. For pending backlog (blueprints in `__garelier/<pm_id>/control/blueprints/`
   not yet picked up by Dock), apply `pending_backlog_warn_hours`
   against their creation timestamp.
7. Show flagged items with their durations and suggested actions
   (typically: investigate, or stop via §13).

### 14.4 What the check does NOT do

- Does not auto-abort anything.
- Does not modify any files (except optionally appending a recent
  activity line to `__garelier/<pm_id>/runtime/manifest.md`).
- Does not run on a schedule. The user invokes it on demand.

The check is informational only.

### 14.5 Retention maintenance

Triggered by phrases like "rotate history", "archive old history",
"retention cleanup", "履歴整理", or automatically when PM notices
`history_hot_entries` is exceeded during a normal PM-owned update.

PM may maintain only PM-owned tracked state:

- `_pm/history.md`
- `_pm/history/archive/`
- `control/project_dashboard/`
- accepted `control/inspections/` indexes or monthly summaries

PM must not prune `runtime/`, Worker/Scout/Smith worktree archives, or
Dock backlog files; those are owned by Dock/the dispatch loop per
`retention.md`.

Process:

1. Read `[retention]` or defaults from `garelier-core/retention.md`.
2. Rotate `_pm/history.md` per §11.2.A if it exceeds the hot-entry
   threshold.
3. For high-volume inspections, ensure new PM-authored destinations use
   `control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md`.
4. For daily/status streams, create or update the monthly summary only
   when it materially reduces future reading. Do not rewrite individual
   immutable inspections.
5. Commit PM-owned retention changes with
   `maintenance: rotate Garelier history` or
   `maintenance: summarize inspections`.

## §14. Control bundles — import / export (DEC-048 / DEC-043)

Snapshot or restore a PM's **tracked `control/` authority** (dashboard,
blueprints, operations, decisions, inspections, …) as a portable, self-describing
bundle. Use it for **backup**, for **seeding a new PM from a template project**,
or for handing planning state to another environment.

The same scripts accept the single-user `_workshop` namespace used by
`garelier-control-project`. Auto-detection recognizes either a full PM
`_pm/setup_config.toml` or a `control/control.toml` marker.

Before export, validate the canonical contract and remove completed backlog/risk
rows. For messy non-bundle input, stage raw material under
`runtime/import/`, normalize it into the canonical control templates, validate,
and commit only the reviewed durable artifacts.

Scripts (sh + ps1, feature parity), under `skills/garelier-pm/scripts/`:

```bash
# Export this PM's control/ into a bundle. --to is MANDATORY (output must be
# explicit); runtime/ is excluded (gitignored, machine-local).
control_export.sh --to <dest-dir> [--pm-id <id>] [--project <root>]

# Import a bundle into a PM's control/. --from is MANDATORY. Default is a DRY RUN;
# add --apply to write. NO-OVERWRITE: existing files are never clobbered — every
# collision is reported for you to reconcile by hand.
control_import.sh --from <bundle-dir> [--pm-id <id>] [--project <root>] [--apply]
```

PowerShell: `control_export.ps1 -To … ` / `control_import.ps1 -From … [-Apply]`.

The bundle carries `control_bundle_manifest.toml` (pm_id, source project,
version, git sha, generated_at, per-file git-blob ids).

**Boundary — who may move a bundle where:**

| Destination | Owner | Gate |
| --- | --- | --- |
| local disk (backup / new-PM template) | **PM-direct** (in-sandbox) | run commit-hygiene; `control/` can hold names/plans |
| outside the sandbox (other repo, push, external store) | **Concierge** executes | **Guardian** gate + redaction (DEC-024 / DEC-025) |
| another PM | **`request_intake/`** | per-PM isolation — never a direct write into another PM's tree (DEC-006) |

Always specify both the input source and the output destination explicitly — the
scripts refuse to run otherwise (no implied scope).
