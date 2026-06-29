# Garelier PM Clean Stop Reference

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
   `garelier-core/scripts/dispatch_event.sh --regen-only` if needed;
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
  protocol is in `../../../garelier-dock/SKILL.md`.
