# Garelier Dock Review and Merge Reference

Inbox processing, Worker/Scout/Smith report review, async merge gate, and drift tracking.

Extracted from the previous role `SKILL.md`; legacy section numbers are intentionally preserved for cross-references.

> **DEC-036 — role containers.** Throughout this file,
> `__garelier/<pm_id>/_<role>/<id>/` is the role's container. By default it is
> **in-project** — the path is real, use it directly. ONLY when **exile** is opted
> in is it a machine-local home outside the project; then, before you READ a role
> file (`report.md`, `STATE.md`), WRITE one (`under_review.md`, `review.md`,
> `merged.md`, `answers.md`), or `cd` into a role's worktree (`…/<id>/checkout`),
> resolve the container from `__garelier/<pm_id>/runtime/workspace_paths`
> (`<role-singular>.<id>=<absolute container>`), falling back to the in-project
> path when the pointer has no entry (the default). The driver also lists each
> resolved container in the Dock prompt. `runtime/`, `control/`, and
> `merge_gate/` paths are always in-project and need no resolution.

## §6. Inbox processing

`__garelier/<pm_id>/runtime/dock/inbox/` contains messages from
Workers, Scouts, Smiths, and (rarely) PM. Each filename is timestamped:
`<YYYYMMDD-HHMMSS>-<from>-<topic>.md`. Process in chronological order.

For each message:

1. Read the message.
2. Take the action described, or note that no action is needed (purely
   informational notifications still need acknowledgement).
3. Move the file to `__garelier/<pm_id>/runtime/dock/inbox-archive/`.

Common message types:

| `from`     | `topic`                  | Action                                |
| ---------- | ------------------------ | ------------------------------------- |
| `<worker>` | `state-change`           | Update manifest; if REPORTING → §7     |
| `<worker>` | `question`               | Read `questions.md`; answer or §11    |
| `<worker>` | `blocked`                | Read STATE.md; resolve or §11         |
| `<scout>`  | `state-change`           | Update manifest; if REPORTING → §7.2  |
| `<scout>`  | `inspection-ready`       | Read inspection file; integrate via §7.2 |
| `<smith>`  | `state-change`           | Update manifest; if REPORTING → §7.3  |
| `<smith>`  | `question`               | Read `questions.md`; answer or §11    |
| `<smith>`  | `blocked`                | Read STATE.md; resolve or §11         |
| `<librarian>` | `state-change`        | Update manifest; if REPORTING → §7.4  |
| `<librarian>` | `question` / `blocked` | Read `questions.md` / STATE.md; answer or §11 |
| `<observer>` | `state-change`         | Update manifest; if REPORTING → consume verdict per §7.5 (Observer never merges) |
| `<observer>` | `question` / `blocked` | Read `questions.md` / STATE.md; answer or §11 |
| `pm`       | `resolution-ready`       | Read `__garelier/<pm_id>/runtime/pm/resolutions/`; if Scout commit-ready → §7.2 |

Do not skip messages, even ones that look like duplicates. Multiple
state-change messages from the same agent reflect real transitions.

## §7. Reviewing reports

When writing any `review.md`, also write the sibling `review.json` from
`garelier-core/templates/review.json`. It is a compact routing/status summary
only; keep the Markdown review as the official human-readable record and do not
copy the Markdown body into JSON.

### §7.1 Worker report review

When a Worker enters REPORTING:

1. Read `__garelier/<pm_id>/_workers/<id>/report.md` and
   `__garelier/<pm_id>/_workers/<id>/assignment.md`.
2. Verify each acceptance criterion: read the relevant code, run any
   commands the criterion specifies, check that the deliverable exists.
3. Run the project quality gate (from `AGENTS.md` §2). For Rust
   projects this typically includes `cargo check --workspace --locked`,
   `cargo test --workspace --locked`, and any project-specific
   commands.
4. Run quality gate **inside the Worker's worktree**:
   `cd __garelier/<pm_id>/_workers/<id> && <quality gate commands>`. This
   validates the workbench branch in isolation.
5. If the assignment had a **Data-change guards** section, verify
   that the report includes Data-change evidence (dry-run output,
   before/after counts, sample records, rollback verification, and a
   reference to the user-approval entry in
   `__garelier/<pm_id>/_pm/history.md`). If any guard is missing, this is
   an automatic REWORK per
   `__garelier/<pm_id>/control/operations/data_change_policy.md`.
6. If the assignment's **Test discipline** mode is `tdd`, verify the report's
   TDD evidence: focused test path/name, red failure evidence, green pass
   evidence, and refactor status. Missing evidence is REWORK.
7. **Assignment Coverage Review** (see §7.1.1). A passing quality gate
   does not prove the assignment was fully covered. Run this audit
   before signaling review start; a shortfall is a Fail (REWORK), not a
   merge.

8. **Signal review start** by writing
   `__garelier/<pm_id>/_workers/<id>/under_review.md` (Worker transitions
   `REPORTING → REVIEWING` upon seeing it; see state_machine.md §2).
   Minimal content:

   ```markdown
   # Under review

   Task: <task_id>
   Reviewed by: Dock
   Started at: <ISO timestamp>
   ```

9. Decide:
   - **Pass**: proceed to merge gate (§8). `under_review.md` stays in
     place until the merge completes; the Worker has no role until
     `merged.md` or `review.md` appears.
   - **Fail**: write `__garelier/<pm_id>/_workers/<id>/review.md` using
     `templates/review.md`, listing each failed criterion **or coverage
     shortfall** (§7.1.1) with evidence. The Worker reads `review.md` and
     transitions `REVIEWING → REWORK` per state_machine.md. `review.md`
     itself is the trigger (no auxiliary marker).

If the report is well-written but acceptance criteria are unclear or
contradictory, this is a blueprint issue → escalate to PM.

#### §7.1.1 Assignment Coverage Review

Acceptance criteria and the quality gate catch "does the build pass?" —
they do not catch "did the Worker quietly drop a Do item or miss a
blueprint requirement?". Before merging, confirm coverage against
`assignment.md` and the linked blueprint. Read the Worker's
**Completion Coverage Audit** section in `report.md` (garelier-worker
§6.6) and independently verify, do not just trust it:

- [ ] `assignment.md` §Goal is satisfied.
- [ ] Every `assignment.md` §Do item was processed — none silently skipped.
- [ ] Every acceptance criterion is met with evidence.
- [ ] Blueprint **Functional requirements** have no gaps (re-read the blueprint, not the report).
- [ ] Blueprint **Non-functional requirements** are not violated.
- [ ] Work stayed within `assignment.md` §Out of scope.
- [ ] Files/resources in `assignment.md` §Inputs were reviewed.
- [ ] Changed files fall within the assignment's scope.
- [ ] Any extra touched file has a stated reason in `report.md`.
- [ ] If `assignment.md` §Test discipline mode is `tdd`, red/green/refactor
      evidence is present and matches the claimed behavior.
- [ ] Quality gate passes.

If any item falls short, **do not merge.** Write `review.md`
(`templates/review.md`) describing the missing content under "Missing
required content" with the expected state and the required action, and
return the Worker to REWORK (step 8 Fail). A missed Do item or dropped
functional requirement is a coverage shortfall even when every listed
acceptance criterion and the quality gate pass.

### §7.2 Scout inspection review

When a Scout enters REPORTING:

1. Read the Scout's `STATE.md` for the location of the inspection
   (typically `__garelier/<pm_id>/control/inspections/<cat>/YYYY/MM/<date>-<topic>.md`).
   Treat that repo-relative path as being inside the Scout worktree
   first; the same file may not yet exist in the primary checkout.
2. Read `assignment.md` and, if present, `report.md` for the task id,
   acceptance criteria, source worktree path, and intended destination.
3. Verify the inspection exists in the Scout worktree, follows
   `templates/inspection.md`, and satisfies the assignment.
4. Decide:
   - **Pass, not yet committed**: write a PM inbox handoff at
     `__garelier/<pm_id>/runtime/pm/inbox/<YYYYMMDD-HHMMSS>-scout-inspection-ready-<task_id>.md`
     containing: Scout id, task id, source path in the Scout worktree,
     intended destination under `control/inspections/`, acceptance
     summary, and "PM action: review, copy/compare into primary
     checkout, commit, then notify Dock." Update manifest recent
     activity to `AWAITING_PM_COMMIT`. Do **not** archive the assignment
     or acknowledge Scout IDLE yet.
   - **Pass, already committed**: verify with
     `git log -1 -- <destination>` that the accepted inspection is
     present on studio, then archive the assignment to
     `__garelier/<pm_id>/runtime/backlog/done/<task_id>-<slug>.md`,
     acknowledge Scout IDLE, and update manifest.
   - **PM commit-ready resolution received**: read the PM resolution,
     verify the destination file and commit SHA, then archive the
     assignment, acknowledge Scout IDLE, and update manifest/backlog.
   - **Insufficient**: do **not** ask the same Scout to re-do the
     same assignment. Inspections are immutable once written. If
     the inspection needs supplementation, issue a **new** follow-up
     assignment (with a new task ID and slug) referencing the
     previous inspection and stating what additional work is needed.
     The Scout starts a fresh IDLE → ASSIGNED → WORKING cycle for
     the follow-up. The original inspection stays in place as the
     historical record.

Scout work does not have a merge gate. Scout drafts are committed only
through PM inspection intake.

### §7.3 Smith report review

When a Smith enters REPORTING:

1. Read `__garelier/<pm_id>/_smiths/<id>/report.md` and
   `__garelier/<pm_id>/_smiths/<id>/assignment.md`.
2. Verify each acceptance criterion, with emphasis on integration,
   contract, system, release, spec-consistency, and license/security
   evidence.
3. Verify the Smith coverage window. The report must name
   `studio_base_commit`, `studio_tip_at_dispatch`, covered Worker merge
   SHAs, and any later studio merges observed as outside coverage. Do
   not treat later merges as verified by this Smith batch.
4. If later studio merges were observed, confirm they are present in the
   next queued Smith batch or intentionally waived by PM/user. Keep
   `runtime/manifest.md` Backlog summary's Smith hardening target count
   in sync before marking the Smith review pass.
5. Confirm Smith did not duplicate work already tracked in backlog. If
   the report lists existing backlog items as deferred, keep them there.
6. Confirm license/security/compliance changes enforce already-decided
   project policy. If the policy is undecided, fail the review into
   `BLOCKED`/PM escalation rather than accepting an unapproved policy.
7. Run the project quality gate inside the Smith worktree:
   `cd __garelier/<pm_id>/_smiths/<id> && <quality gate commands>`.
7b. Run the **Assignment Coverage Review** (§7.1.1) against the Smith
   `assignment.md` — confirm the assigned hardening scope (integration,
   system, release tooling, spec consistency, license/security) is fully
   covered, not just that the gate passes. A shortfall is a Fail.
8. Signal review start by writing
   `__garelier/<pm_id>/_smiths/<id>/under_review.md` (Smith transitions
   `REPORTING -> REVIEWING`; see state_machine.md §4).
9. Decide:
   - **Pass**: proceed to merge gate (§8) for the Anvil branch.
   - **Fail**: write `__garelier/<pm_id>/_smiths/<id>/review.md`,
     listing each failed criterion with evidence. Smith reworks on the
     same Anvil branch.

If the report reveals a Garelier control/doc inconsistency rather than a
target-project issue, escalate to PM. Smith must not patch PM-owned
Garelier control files.

### §7.4 Librarian report review

When a Librarian enters REPORTING (knowledge/registry/runbook work on a
`shelf` branch; see `garelier-librarian`):

1. Read `__garelier/<pm_id>/_librarians/<id>/report.md` and
   `assignment.md`.
2. Run the **Librarian Review** checklist:
   - [ ] The assignment Goal is met and every Do item is processed.
   - [ ] No **unregistered** source was adopted as authoritative.
   - [ ] The target Markdown carries provenance front matter
     (`source_id`, `source_type`, `last_synced_at`, `transform`).
   - [ ] `source_registry.toml` and `routine_registry.toml` are
     internally consistent and consistent with the Markdown they point at.
   - [ ] Any runbook is reusable at a repeatable granularity (a future run
     by its `default_role` can follow it without re-deriving it).
   - [ ] The **meaning** of a rule was not changed (project-specific
     augmentation is fine; reinterpretation is not).
   - [ ] No feature code was written; no QA was performed.
   - [ ] No PM-approval-needed policy change was merged unilaterally.
   - [ ] On a source-fetch failure, internal docs were **not** overwritten
     with stale data (the report records the failure instead).
3. Signal review start with `under_review.md`.
4. Decide:
   - **Pass**: proceed to the merge gate (§8) for the shelf branch (set
     `agent_role: "librarian"` in the merge request).
   - **Fail**: write `review.md`; the Librarian reworks on the same shelf
     branch. Return reasons: missing `source_id`/provenance, target not
     updated, registry↔Markdown mismatch, runbook too abstract to reuse,
     meaning changed, unregistered source adopted, code mixed in, or an
     unapproved policy change.

Librarian work merges through this review + the merge gate exactly like
Worker work — it never merges directly to target.

### §7.5 Observer review hook (before the merge gate)

After a Worker / Smith / Librarian review passes (§7.1–§7.4) and before
dispatching to the merge gate (§8), determine whether **Observer** review
is required (consult `[observer_policy]` in `setup_config.toml`; see
`../../garelier-observer/references/review-policy.md`).

Observer review is **REQUIRED** when:

- `require_for_all_merges` is set — then it is required on **every** merge,
  unconditionally (this is the default). When set, the "skip for low-risk"
  escape below does **not** apply: every Worker / Smith / Librarian merge
  gets an Observer review after the Guardian gate and before §8. This is the
  observer step of the mandated order **worker → guardian → observer →
  dock**;
- the diff exceeds `large_diff_lines`;
- protected paths changed;
- public API / schema / protocol changed;
- migration / data-change code changed;
- auth / security / permission code changed;
- the report and the diff do not obviously match; or
- PM explicitly requested independent review.

If required:

1. Write an Observer `assignment.md` (kind `merge_review`) into an
   available `__garelier/<pm_id>/_observers/<id>/` (use
   `templates/observer_assignment.md`; give the Diff command, the review
   branch, the base branch, and paths to the role's `report.md` /
   `assignment.md`).
2. Keep the reviewed role in REVIEWING (`under_review.md` stays in place;
   do not dispatch the merge gate yet).
3. Wait for the Observer `report.md`.
4. **PASS / PASS_WITH_NOTES** → continue to the merge gate (§8). Carry the
   verdict into the merge request: set `observer_required: true` and
   `observer_report_path` (and/or `observer_verdict`) so the merge gate
   mechanically enforces the passing verdict (§8.1.A).
5. **REWORK_RECOMMENDED** → write `review.md` back to the reviewed role
   (REWORK), adopting the Observer findings as concrete rework actions.
6. **BLOCK** → escalate to PM (§11). A BLOCK verdict is **never waivable**.
7. **NO_OPINION** → escalate to PM (§11) unless `[observer_policy]`
   allows a waiver.

Do not rubber-stamp the Observer report. Either adopt its findings as
concrete `review.md` rework actions, or — if proceeding past a non-BLOCK
verdict — record a **waiver** in `runtime/manifest.md` / the review log
naming the request id, verdict, and rationale. The Observer never merges
and never holds `lane.lock`; when it enters REPORTING you consume the
verdict here and acknowledge it (Observer REPORTING → requester ACK).

For low-risk changes outside the policy triggers, skip this hook and go
straight to §8 — **but only when `require_for_all_merges` is false**. When
`require_for_all_merges` is set (the default), there is no low-risk skip:
the merge gate's `observer_policy_check.ts` backstop will refuse any merge
that lands without a passing Observer verdict, so dispatch the review here.
Dock may also raise `architecture_risk_review` or
`policy_consistency_review` requests per `[observer_policy]`.

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
   the project root) and/or `observer_verdict`. The merge gate subprocess
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
