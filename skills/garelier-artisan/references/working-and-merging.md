# Artisan reference: working → self-review → merge → report

> Detailed end-to-end procedure moved from `SKILL.md` (DEC-032). Read when
> your state is ASSIGNED / WORKING / REPORTING. The boundaries (`SKILL.md`
> §3) and MUST BLOCK IF always apply; consult the engineering/quality/review
> knowledge per §1 before non-trivial work.

## §5. Receiving an assignment (IDLE → ASSIGNED → WORKING)

When `assignment.md` appears:

1. Read it fully (use `templates/artisan_assignment.md` shape).
2. If the assignment's **Test discipline** mode is `tdd`, read
   `quality/test_driven_development.md` before any implementation edit.
3. Sanity-check the task against the actual code. If the assignment and
   reality contradict, BLOCK (§10).
4. Create your satchel branch from the current studio tip:

   ```bash
   git checkout --detach garelier/<target-slug>/<pm_id>/studio
   git checkout -b garelier/<target-slug>/<pm_id>/satchel/#<id>/<slug>
   ```

5. Update `STATE.md` to `WORKING` and write the first checkpoint.

## §6. Working (WORKING)

Do the task end to end. Commit per cohesive sub-step — WIP commits are
encouraged (`git commit -m "WIP #<id> <phase>: ..."`). Uncommitted work
at a compaction/timeout boundary is lost.

Leave a checkpoint (`checkpoints/NNNN-<phase>.md`,
`templates/artisan_checkpoint.md`) at each phase boundary: after survey,
after a major implementation chunk, after hardening, after knowledge
work. A checkpoint records what is done, what remains, the current
branch/commit, and any blocking risk, so a fresh session resumes without
redoing work.

Follow the specialist procedures for each part of the work:

- Implementation: `garelier-worker/references/working-and-reporting.md` §5–§6.
- Hardening (integration/system tests, license/security):
  `garelier-smith` §6, §9.
- Knowledge/registry/runbook: `garelier-librarian`.

If `assignment.md` says `Test discipline` mode `tdd`, follow
`quality/test_driven_development.md` during implementation and carry the
red/green/refactor evidence into the report.

## §7. Self-review (still WORKING, before merge)

Run both coverage audits on your own
output and treat a shortfall the way Dock would treat a Worker's:
go back and close the gap, or BLOCK if it needs a decision you cannot
make.

1. **Completion Coverage Audit** — `garelier-worker/references/working-and-reporting.md`
   §6.6: Goal, every Do item, acceptance criteria with evidence, blueprint
   functional + non-functional requirements, out-of-scope, inputs reviewed, extra
   touched files justified, and any assigned TDD evidence.
2. **Assignment Coverage Review** — `garelier-dock/references/report-review.md`
   §7.1.1: verify the same coverage independently, as if reviewing someone else's work.
   A dropped Do item or missed functional requirement is a shortfall
   even when tests pass.
3. **Quality gate** — run the project quality gate from `AGENTS.md` §2
   inside this worktree. It must pass. Auto-fix FIRST (DEC-049): before the
   check gate, run the formatter declared in `[quality_gate.autofix]`
   once and commit any change, so a formatting nit never blocks the
   merge you are about to perform yourself.

Record the audit results in `report.md` (§9).

### §7.4 Forward-integrate studio, then Guardian security gate

Before the final gates, merge the latest `studio` into `satchel` and run the
full quality gate. This makes the reviewed diff the exact integration candidate.
Then run the security gate before the
Observer review (the mandated order is **artisan → guardian → observer →
artisan**; the Guardian's own `delta gate` is defined as "after role work +
quality gate, before Observer"). Check `[guardian_policy]` in
`setup_config.toml` (`../../garelier-guardian/SKILL.md`).

A Guardian gate is **required** when `require_for_all_merges` is set (the
default; then every artisan merge is gated), when
`require_for_artisan_premerge = true` (the default), or when the diff hits a
mechanical trigger (dependency / lockfile / auth-security / config-infra-ci
/ protected paths). When required:

1. Write a Guardian `assignment.md` (gate kind `delta`/`final` per
   `[guardian_policy]`) into an available
   `__garelier/<pm_id>/_crew/guardians/<id>/` (use
   `../../garelier-guardian/templates/guardian_assignment.md`;
   the review branch is your `satchel` branch, the base is `studio`, and pin
   both the studio base SHA and `review_sha` to the exact heads you will merge).
2. Stay WORKING; do not run §7.5 or §8 yet. Wait for the Guardian
   `guardian_report.md` verdict.
3. **PASS / PASS_WITH_NOTES** → proceed to §7.5 (Observer review). Keep the
   `guardian_report_path` + verdict to record in `artisan_report.md`. If you
   add commits after the gate, the verdict is **stale** — re-gate on the new
   base SHA or `review_sha` before merging.
4. **BLOCK** → do **NOT** merge. Escalate to PM/user (§10); a BLOCK is never
   waivable. **NO_OPINION** → get more evidence or escalate.

You still own the integration request: the Guardian gates and blocks but never
commits or merges.

### §7.5 External Observer review before studio integration

You are your own reviewer and integrator. Before merging into `studio` (§8),
check `[observer_policy]` in
`setup_config.toml`
(`../../garelier-observer/references/review-policy.md`).

If Observer review is required — **always when `require_for_all_merges` is
set** (the default; then every artisan merge is reviewed unconditionally),
**by default for an artisan pre-merge** (`require_for_artisan_premerge =
true`), and always for protected paths / migration / auth / public-API
changes / a large diff — write an Observer `assignment.md` of kind
`artisan_premerge_review` into
an available `__garelier/<pm_id>/_crew/observers/<id>/` (use
`templates/observer_assignment.md`; the review branch is your
`satchel` branch and the base is `studio`). Wait for the
Observer `report.md`.

- **PASS / PASS_WITH_NOTES** → proceed to studio integration (§8).
- **REWORK_RECOMMENDED** → rework (back to §6), rerun the quality gate
  (§7.3), update `report.md`, and re-request Observer review if the
  material diff changed.
- **BLOCK or NO_OPINION** → do **NOT** merge. Escalate to PM/user (§10).

You still own the merge request: the Observer reviews, advises, and blocks, but it
never merges or commits. Record the
Observer request id, the verdict, and your response in `artisan_report.md`
(§9).

## §8. Merge into studio (still WORKING)

Only after §7 passes, submit the satchel through the merge-gate request protocol,
pinning the reviewed satchel SHA and the expected current `studio` SHA. The shared
`runtime/merge_gate/locks/active.lock` serializes this integration with Dock work.

- If the request reports a stale expected studio SHA, do not retry the old gates.
  Return to `satchel`, forward-integrate the new studio tip, rerun the quality gate,
  Guardian, and Observer, then submit a new request with the new expected SHA.
- If forward-integration has a conflict, resolve it on `satchel`, rerun the quality
  gate and both required gates, then submit a new request.
- Do **not** push. Garelier coordination branches and merges are
  local-only (`garelier-core/protocol.md` §6.5). PM approval and Concierge
  handle any later promote into `target`.
- Record the merge commit SHA for the report.

## §9. Report and finish the route (WORKING → REPORTING → IDLE)

1. Write `report.md` using `templates/artisan_report.md`: summary, work
   branch + studio + merge commit, completed items, the §7 audit results,
   quality-gate result, files changed, and notes for PM (decisions,
   risks, follow-ups).
   Also write sibling `report.json` from `garelier-core/templates/report.json`
   with the compact status/summary/commits/files/tests/risks/needs record; do
   not duplicate the Markdown body.
2. Archive `assignment.md`, `report.md`, and checkpoints under
   `archive/<task_id>/`.
3. Reset your worktree to detached studio and optionally delete the
   satchel branch:

   ```bash
   git checkout --detach garelier/<target-slug>/<pm_id>/studio
   git branch -d garelier/<target-slug>/<pm_id>/satchel/#<id>/<slug>
   ```

4. Update `STATE.md` to `REPORTING`, write a PM inbox notification at
   `__garelier/<pm_id>/runtime/pm/inbox/<YYYYMMDD-HHMMSS>-artisan-report-<task_id>.md`
   pointing at `report.md`, then transition to `IDLE`.
