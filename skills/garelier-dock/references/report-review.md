# Garelier Dock Report Review Reference
Roots and exiled containers: follow `garelier-dock/SKILL.md`.

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
3. Run the project quality gate (from `AGENTS.md` §2). This
   typically includes the project's configured check and test
   commands, plus any project-specific
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
