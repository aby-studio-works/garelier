# Garelier Dock Merge Gate Reference
Roots and exiled containers: follow `garelier-dock/SKILL.md`.

## §8. The merge gate (Worker, Smith, and Librarian)

The merge-gate request schema keeps the historical field name
`workbench_branch`; for Smith, put the Anvil branch in that field and set
`agent_role: "smith"` / `agent_id: "<smith-id>"`. For Librarian, put the
shelf branch in that field and set `agent_role: "librarian"` /
`agent_id: "<librarian-id>"`. The mechanical merge into studio is
identical for all three; `agent_role` is metadata for routing the result.

### §8.0 Base tracking (always run first)

Before any operation that requires the integration branch to be
current, run base tracking. This is the most important pre-step.

From the primary worktree:

```bash
git fetch
git checkout garelier/<target-slug>/<pm_id>/studio
git merge --no-edit <target>
```

If the merge produces conflicts:

1. Read each conflicted file.
2. Resolve by combining `<target>` changes and studio changes in the
   way that preserves both intents. Use commit messages and the
   originating blueprint for context.
3. `git add` the resolved files and `git commit --no-edit` to
   complete the merge.
4. Append a brief resolution summary to
   `__garelier/<pm_id>/runtime/manifest.md` Recent activity so the user
   can audit.

If the resolution is genuinely ambiguous from blueprint + code context,
abort with `git merge --abort` and escalate to PM (§11).

This step runs at three points:
- (a) before creating a new workbench or Anvil branch (handled by setup
  wizard's diff mode for agent additions; for ordinary IDLE → ASSIGNED
  dispatch, run this step yourself before the Worker/Smith creates their
  task branch);
- (b) before running the merge gate in §8.1;
- (c) PM runs the equivalent before promote.

Forward-integration of `studio` **into** in-flight workbench/anvil branches —
the reverse direction that keeps a long-running producer from drifting — is a
**systematic per-iteration duty**, not an afterthought: see §8.6 (detect) + §8.5
(trigger), formalized by DEC-039.

### §8.1 The merge gate — async dispatch (DEC-007)

**Important (v2.2+):** Dock no longer runs the merge + quality
gate inside its own LLM iteration. The driver runs a background
`merge-gate.{sh,ps1}` subprocess for the mechanical part. Dock's
job splits into two iterations:

- **Dispatch** (§8.1.A): observe a Worker or Smith in REPORTING, write a
  `merge-request.json` to `runtime/merge_gate/requests/`.
- **Resolve result** (§8.1.B): observe a `result.json` land in
  `runtime/merge_gate/results/`, decide what to do (write
  `merged.md` / `review.md` / escalate concern to PM / resolve
  conflict).

The subprocess never invokes LLM. Driver enforces single-active
concurrency, so only one merge is in flight per PM at any time.

#### §8.1.A Dispatch a merge request

When a Worker or Smith review passes:

1. Run base tracking (§8.0) — this still happens inside Dock's
   LLM iteration because it precedes dispatch.

2. Verify the task branch is up-to-date with studio. From the
   primary worktree:
   ```bash
   git log --oneline garelier/<target-slug>/<pm_id>/studio..<task-branch>
   git log --oneline <task-branch>..garelier/<target-slug>/<pm_id>/studio
   ```
   If studio has commits the task branch doesn't have, ask the Worker or
   Smith to merge studio in (write to that agent's `review.md`, move them
   back to WORKING with a "merge studio in" note).

3. Allocate the next sequence number from
   `__garelier/<pm_id>/runtime/merge_gate/next_seq` (read, increment,
   write back atomically — Dock owns this counter).

4. Write the merge request to
   `__garelier/<pm_id>/runtime/merge_gate/requests/<seq>-<slug>.json`
   using the schema in DEC-007 §2.2:
   ```json
   {
     "request_id": "<seq>-<slug>",
     "workbench_branch": "garelier/<target-slug>/<pm_id>/<workbench-or-anvil-or-shelf>/#<id>/<slug>",
     "worker_id": "<id>",
     "agent_role": "worker | smith | librarian",
     "agent_id": "<id>",
     "task_id": "BP-<N>",
     "requested_at": "<ISO timestamp>",
     "requested_by": "dock",
     "studio_branch": "garelier/<target-slug>/<pm_id>/studio",
     "merge_message": "Merge garelier/<target-slug>/<pm_id>/<workbench-or-anvil>/#<id>/<slug>: <short description>",
     "quality_gate_commands": ["<cmd1>", "<cmd2>", ...],
     "quality_gate_timeout_minutes_per_cmd": 120,
     "pre_merge_base_tracking": true,
     "observer_required": false,
     "observer_request_id": "OBS-<id>",
     "observer_verdict": "PASS | PASS_WITH_NOTES",
     "observer_report_path": "__garelier/<pm_id>/_observers/<id>/report.md",
     "guardian_required": false,
     "guardian_verdict": "PASS | PASS_WITH_NOTES",
     "guardian_report_path": "__garelier/<pm_id>/_guardians/<id>/guardian_report.md"
   }
   ```
   The `quality_gate_commands` come from `setup_config.toml`
   `[quality_gate] commands = [...]`. Dock may pull straight
   from there or curate (e.g., skip a particular gate command for a
   doc-only blueprint).

   **Write exactly one file, named `<seq>-<slug>.json`.** Do not add a
   `.request` infix, and do not also drop a request-side
   `<seq>-<slug>.summary.json` sidecar — `requests/` holds dispatchable
   merge requests only. The compact `<seq>-<slug>.summary.json` companion
   is written by the merge-gate subprocess into `results/`, never here.
   The driver self-heals (it prunes stray request-side sidecars and any
   request that already has a result, so a misnamed extra file can no
   longer head-of-line-stall the gate), but do not create them.

   **Observer gate (mechanical, DEC-019).** When §7.5 made Observer
   review **mandatory**, set `observer_required: true` and include
   `observer_report_path` (path to the Observer's `report.md`, relative to
   `control_root`, unless absolute) and/or `observer_verdict`. The merge gate subprocess
   reads the verdict from that report — not from a request-supplied claim —
   and **refuses the merge** (writes a `failed` result) unless the verdict
   is `PASS` or `PASS_WITH_NOTES`. This is a backstop: it does not replace
   the §7.5 hook, but it mechanically prevents a merge that proceeds without
   the required passing review. Leave `observer_required` false (or omit it)
   for low-risk changes outside the policy triggers.

   **Guardian gate (mechanical, DEC-024).** When the change touches a
   security-sensitive path, a package manifest/lockfile, or a protected path
   (per `[guardian_policy]`), set `guardian_required: true` and include
   `guardian_report_path` (path to the Guardian's `guardian_report.md`) and/or
   `guardian_verdict`. The merge gate reads the verdict from that report and
   **refuses the merge** unless it is `PASS` or `PASS_WITH_NOTES` — checked
   **before** the Observer gate. It also binds the verdict to the report's
   `review_sha`: if the workbench tip moved after the Guardian reviewed it, the
   verdict is refused as **stale** and the Guardian must re-run on HEAD (so
   always prefer `guardian_report_path` over a bare `guardian_verdict`, which
   carries no sha). Leave `guardian_required` false (or omit it) outside the
   policy triggers; the gate still applies the `[guardian_policy]` backstop for
   high-risk paths.

5. Update manifest: mark assignment as `MERGING` (not `MERGED` yet —
   the subprocess hasn't run). Worker/Smith stays in REPORTING.

6. **Stop this iteration.** The subprocess runs in the background.
   Dock's next iteration (after the result file lands) handles
   the outcome (§8.1.B).

Do NOT run `git merge`, `git commit`, or quality gate commands
yourself. That's the subprocess's job.

#### §8.1.B Resolve a merge result

Trigger: a new file appears at
`__garelier/<pm_id>/runtime/merge_gate/results/<seq>-<slug>.json`.
(The subprocess writes it atomically via `.tmp` + rename. The
driver’s `pollMergeGate` may already have moved it into archive on
crash recovery; check both locations.)

If `<seq>-<slug>.summary.json` exists, read it first for status,
failure_reason, compact gate step metadata, and log pointer. Open the
full result JSON/log only when you need stdout/stderr tails or detailed
evidence. Branch on `status`:

##### `success`

1. Sanity check: `git log -1 <studio_branch>` matches
   `result.studio_commit`.
2. Spot-check that the merge commit's `git diff` is consistent with
   the Worker/Smith `report.md` (high-level — file list, claimed scope).
3. Write the agent's `merged.md`
   (`__garelier/<pm_id>/_workers/<id>/merged.md` or
   `__garelier/<pm_id>/_smiths/<id>/merged.md`):
   ```markdown
   # Merge complete

   Task: <task_id>
   Merged by: Dock (subprocess merge-gate, request <request_id>)
   Merged at: <ISO timestamp>
   Studio branch: garelier/<target-slug>/<pm_id>/studio
   Merge commit: <result.studio_commit>
   Duration: <result.duration_ms> ms
   ```
4. Update manifest: mark assignment MERGED, archive to
   `__garelier/<pm_id>/runtime/backlog/done/<task_id>-<slug>.md`.
5. Remove the agent's `under_review.md` if present.
6. Optionally `git branch -d <task-branch>`
   (delete-after-merge policy).
7. **Archive the merge gate result + summary + log.** The subprocess archived
   only the request (per DEC-007 §2.3, to stop driver re-dispatch);
   the result.json + summary.json + log are still in
   `runtime/merge_gate/results/` + `logs/` so Dock can read them.
   Now that consumption is complete, `mv` them into
   `runtime/merge_gate/archive/`:
   ```bash
   mv runtime/merge_gate/results/<request_id>.json         runtime/merge_gate/archive/<request_id>.result.json
   mv runtime/merge_gate/results/<request_id>.summary.json runtime/merge_gate/archive/<request_id>.summary.json 2>/dev/null || true
   mv runtime/merge_gate/logs/<request_id>.log             runtime/merge_gate/archive/<request_id>.log
   ```
   If you forget this step, the next Dock iteration will see
   the leftover result.json and try to re-process the same merge.
8. **If the spot-check found a concern** (e.g., merge commit's diff
   doesn't match what `report.md` claimed, or subprocess wrote a
   misleading merge message): also write to
   `__garelier/<pm_id>/runtime/pm/inbox/<ts>-merge-concern-<task_id>.md`
   describing the discrepancy. PM resolves on next iteration (PM
   may dispatch a follow-up Worker/Scout/Smith, record in `notes.md`, or
   in severe cases `git revert <merge-sha>` per DEC-001 §2.5).
   The Worker/Smith still transitions to MERGED → IDLE — concerns are
   project-level follow-ups, not REWORK signals.

   **Gate producers release automatically.** A Guardian/Observer that gated
   this merge is waiting in REPORTING for `acked.md`. The driver writes that
   ack deterministically once the merge SUCCEEDS — it reads the
   `guardian_report_path` / `observer_report_path` from the request, and (only
   while the producer is still REPORTING and unacked) drops `acked.md` into the
   producer's container so it archives + returns to IDLE (driver log
   `gate_producer_auto_acked`). You therefore do **not** need to ack them by
   hand; the verdict being embedded in the merge request is the consumption
   event, and a successful merge is its durable confirmation. (Acking manually
   is still harmless — the driver skips a producer that already has `acked.md`.)

##### `failed`

The subprocess ran `git merge --abort` already; studio is unchanged.

1. Read `failure_reason` and the relevant `gate_steps` entry (whose
   `exit_code` is non-zero) for stdout/stderr tails.
2. Write the agent's `review.md` quoting the failed command + tails,
   instruct REWORK.
3. Update manifest: assignment moves back to REWORK.
4. Worker/Smith picks up review.md on its next iteration and transitions
   REPORTING → REWORK → WORKING.

##### `conflict`

The subprocess hit merge conflicts the mechanical script cannot
resolve. Studio is back at pre-merge state (`git merge --abort` ran).

Dock performs the merge **manually in this iteration** (DEC
0001 §2.5 exception — Dock resolves conflicts itself):

> **This is Dock's job, not the Worker's.** A `conflict` merge-gate
> result is resolved *here* — do **not** reflexively bounce it back to the
> Worker as a `review.md` REWORK / drift-resync. (Worker-side drift-resync via
> §8.5/§8.6 is the *pre-merge* path for a branch that is merely *behind* studio
> — §8.1.A step 2 — **not** for a merge-gate conflict result.) The driver
> grants the git command set this step needs (`git checkout` / `git merge` /
> `git add` / `git commit`, plus read-only inspection) to the Dock session
> in the `reviewed` profile (claude adapter `GARELIER_GIT_ALLOWED_TOOLS`), so a
> stripped or incomplete project `.claude/settings.local.json` no longer
> silently blocks it. Only when the resolution is **genuinely ambiguous** from
> blueprint + report + code do you `git merge --abort` and escalate to PM (§11)
> for a merge-assist — never hand a routine keep-both conflict to a headless
> Worker that cannot run `git merge` either.

1. `git checkout garelier/<target-slug>/<pm_id>/studio`
2. `git merge --no-ff --no-commit <task-branch>`
3. Read each conflicted file in `result.conflict_files`, resolve
   based on blueprint + Worker/Smith `report.md` + recent commits.
4. `git add <resolved files>`.
5. Run the same quality gate commands the subprocess would have
   (from `setup_config.toml` `[quality_gate]`) — manually invoke
   via Bash, since you're already in the LLM iteration.
6. On pass: `git commit -m "Merge ... (conflicts manually resolved by Dock)"`.
   Follow §8.1.B `success` from step 2.
7. On fail: `git merge --abort`. Follow §8.1.B `failed`.

This is the rare path; Dock accepts the long LLM iteration
because real conflict resolution needs human-level judgment. Worker/Smith
stays in REPORTING during this — do NOT bounce them to REWORK
unless the post-resolution gate also fails.

##### `aborted`

Either the driver was stopped or the subprocess died unexpectedly.
Studio is at the pre-merge state.

1. Log to manifest: `aborted by subprocess (pid <pid> died / SIGTERM)`.
2. Do NOT auto-retry. The next Dock iteration may re-dispatch
   the same request if Worker/Smith is still REPORTING and nothing else
   changed.
3. Optionally write a heads-up to `runtime/pm/inbox/` so PM knows on
   next session.

#### §8.1.C Archive

**Ownership split (DEC-007 §2.3 corrected):**
- Subprocess archives ONLY `request.json` (to prevent re-dispatch by
  the driver's queue scan).
- Dock archives `result.json` + `<seq>.log` AFTER consuming
  the result (writing merged.md / review.md / merge-concern PM
  inbox item). See §8.1.B steps for the `mv` commands.

Rationale: if the subprocess archived the result too, Dock
would never see it land in `runtime/merge_gate/results/` and would
report "no action: merge_gate results ∅" while a successful merge
sits unacknowledged in archive. Real incident on Project-X
2026-05-25 — Worker stayed REPORTING for hours after successful
merge.

The `runtime/merge_gate/archive/` directory is otherwise audit-only;
once all 3 files (request, result, log) are in it the task is
fully archived.

#### §8.1.D Restrictions on Dock's git operations

- Dock **does not** run `git commit -m "Merge ..."` directly in
  the §8.1.A dispatch path. The subprocess owns that.
- The §8.1.B conflict path is the **only** path where Dock
  runs merge + commit by hand.
- Dock never runs `git push` (per protocol.md §6.5 local-only).

### §8.2 Merge gate failure modes

| Symptom                                | Action                                            |
| -------------------------------------- | ------------------------------------------------- |
| Base-tracking merge conflict           | Resolve yourself (§8.0); abort + escalate only if genuinely ambiguous |
| Workbench/Anvil merge conflict (with studio) | Agent merges studio in; review.md notes the conflict |
| Quality gate fails post-merge          | Worker/Smith debugs; review.md attaches log       |
| Test flakiness (intermittent failure)  | Re-run once; if flaky twice, escalate to PM       |
| Branch already deleted (race)          | Investigate; likely manual intervention           |
| Data-change guards missing on report   | Automatic REWORK; pointer to data_change_policy   |

The merge gate is **fail-closed** for workbench/Anvil merges and quality
gates. Base-tracking is the only "fail-resolve" path (per DEC-001
§2.5).

### §8.5 Instructing a Worker to track target (forward-integration, DEC-039)

For long-running Worker tasks, the workbench branch can drift behind
`garelier/<target-slug>/<pm_id>/studio`. Dock triggers workbench-side
base tracking by writing a one-shot instruction file to the Worker. **You
trigger; the Worker performs the merge and resolves conflicts itself** (it owns
the code) — so forward-integration does *not* widen Dock's no-code-writing
boundary. The same applies to a Smith on an `anvil` branch.

When to instruct:

- After a significant merge into the integration branch that the
  workbench branch will eventually need to absorb (e.g., a shared-file
  refactor landed).
- When a Worker has been WORKING for >4 hours without your
  intervention and a fresh integration tip exists.
- Before §8.1 merge gate if the workbench branch is conspicuously
  behind studio (the Worker would have to do it anyway).

How to instruct:

Write `__garelier/<pm_id>/_workers/<id>/track-target.md` with this minimal
content:

```markdown
# Track target

Issued at: <ISO timestamp>
Issued by: Dock
Strategy: merge        # or "rebase" — see notes
Reason: <one sentence — what landed and why the Worker should pick it up>
```

`strategy: merge` is the default and almost always correct. Use
`strategy: rebase` only when:

- No external party (PM, reviewer) has inspected the branch yet, AND
- The branch is short and rewriting history is harmless.

The Worker reads `track-target.md`, performs the operation per
garelier-worker SKILL.md §6.5, and removes the file when done.

Do not instruct a Worker that is BLOCKED, REPORTING, REVIEWING, or
REWORK. Wait for WORKING state.

### §8.6 Detecting drift — a per-iteration duty (DEC-039)

Detecting and correcting drift is **systematic**, not optional: on **each
iteration**, for **every** in-flight Worker/Smith in WORKING state, measure how
far its branch is behind the `studio` tip:

```bash
git log --oneline garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>..garelier/<target-slug>/<pm_id>/studio | wc -l
```

Trigger §8.5 (drop `track-target.md`) when the branch is behind **and** the
trigger would not thrash:

- **Threshold (default ≥ 3 commits behind), OR a significant shared-file merge
  landed** (e.g. a refactor the branch will have to absorb) regardless of count.
- **Idempotent**: skip if a `track-target.md` is already pending for that
  producer, or if the branch is already current — so one `studio` advance yields
  at most one catch-up per branch. This keeps it systematic without churning
  Worker builds (the original concern): you re-trigger only when `studio` has
  *newly* advanced past the branch beyond the threshold and no catch-up is
  pending.

On a later iteration, confirm the catch-up landed (the `..studio` count is back
to ~0). If a producer reports the merge unresolvable it goes BLOCKED — escalate
(§7), don't force it. The merge-gate readiness check (§8.1.A step 2) remains the
backstop: a branch conspicuously behind `studio` is caught up before it merges,
regardless of the cadence above. Merge, never rebase.
