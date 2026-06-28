# Concierge reference: external-operation execution

> Detailed procedure moved from `SKILL.md` (DEC-032). Read when executing
> an operation. The boundaries (`SKILL.md` §3), the external lock invariant
> (`SKILL.md` §5), and the MUST BLOCK IF rules (§10) always apply — and every
> remote git op goes through the DEC-030 mechanical guard.

## §2. What a Concierge does (Phase 1)

For one PM-approved operation:

- **Promote execution** (`promote_target`) — merge the shared integration
  branch `studio`
  into `<target>`, run the quality gate on the merged tree, tag, and push. See
  §6. This is the work PM used to do in `promote-and-agents.md` §7.3.
- **Remote sync** (`sync_remote`) — read-only `git fetch --prune` / `git status`
  / `git log` / `git diff` to refresh and report remote state. No merge/rebase/
  push unless the assignment explicitly names it.

Phase 2 operations (`create_pr`, `create_release`, `update_ticket`, …) are
listed in `[concierge_policy]` but **disabled by default**; do not perform them
unless policy enables them and the assignment requests them.

### Investigate, then execute

Some operations are a single fixed command (promote). Others (a ticket) need you
to first **investigate the external operation** — read the ticket, check the
current remote / PR / CI state — and then execute the approved method. Your
`PREPARING` / `CHECKING_GATES` / `VERIFYING` states exist for this. You
investigate *the external operation*, never the **policy** and never the
**code**: if an operation turns out to need source changes, you STOP and hand
back to PM (§10); PM dispatches a Worker.

## §5 mechanics. The external lock — filename, fields, stale/reclaim

The §5 invariant (`SKILL.md`): acquire a target-scoped lock before any external
write; same-target serializes, different-target runs in parallel; a live
same-target lock held by another Concierge → BLOCK. The mechanics:

The lock lives under `runtime/concierge/locks/`. Its **filename is the sanitized
identity of what you write**, so same-target operations collide on the same
filename:

- `promote_target` / write `sync_remote`: `<target_remote>__<target_ref>.lock` (e.g. `origin__main.lock`)
- `create_pr` / `update_pr` / `close_pr`: `pr__<head-slug>.lock`
- `create_release` / `update_release` / `publish_artifact`: `release__<tag>.lock`
- `create_ticket` / `update_ticket` / `close_ticket`: `ticket__<ticket_id>.lock`

Sanitize the key (replace `/` and non-`[A-Za-z0-9._-]` with `-`). The lock file
is a small JSON object with the fields `request_id`, `operation_kind`,
`target_remote`, `target_ref`, `source_sha`, `pid`, `started_at`. If a **live**
lock for the same target is held by another Concierge, BLOCK. If it is **stale**
(dead pid), reclaim it. Read-only operations (`check_external_ci`, read-only
`sync_remote`) take no lock. Release it (or set `status = "done"`) in `REPORTING`.

## §6. Promote execution (promote_target)

PM has already: built the promote document, obtained explicit user approval,
ensured base-tracking (`<target>` folded into `studio`), and written your
assignment with the fixed `studio` SHA, the `<target>`, the tag/version, the
promote notes, and the passing Guardian `promote_gate` / `final_gate` verdict.

All remote git goes through the **mechanical push guard** (DEC-030):
`GUARD=../../garelier-core/scripts/concierge_git_guard.sh`. The guard refuses `pull`, force
pushes, and `garelier/*` pushes; a `pre-push` hook (installed in your worktree
at pre-flight, §1) enforces the garelier/\* and force-push bans even if you
forget the wrapper. Before the target push you MUST pass `preflight-target-push`.

Then, in **your** worktree (`<target>` is free — the main checkout is on
`studio`):

```bash
"$GUARD" fetch origin
git checkout <target>
# Merge the shared integration branch into target WITHOUT committing yet:
git merge --no-ff --no-commit garelier/<target-slug>/<pm_id>/studio
# Run the project quality gate (AGENTS.md §2) on the MERGED tree:
<quality gate commands>
# Only if the gate passes, finalize:
git commit -m "Promote: <date or version>"
git tag -a "v<version>" -m "<promote notes title>"
# Mechanical pre-flight: live remote tip == approved expected SHA (no drift) AND
# a PASS/PASS_WITH_NOTES Guardian verdict bound to exactly this HEAD (the gate).
# Refuses (exit 2/3) on drift, a stale/BLOCK verdict, or a garelier/* ref.
"$GUARD" preflight-target-push --remote origin --ref <target> \
  --expected-sha <expected_target_sha> \
  --verdict <path-to-guardian-verdict> --head "$(git rev-parse HEAD)"
# Guarded push (the pre-push hook is the unconditional backstop):
"$GUARD" push origin <target> --tags
# Return your worktree to a detached, neutral state:
git checkout --detach <target>
```

- If the `studio`→`<target>` merge conflicts, resolve it yourself, preserving
  both intents (the DEC-001 §2.5 exception applies to you for this merge);
  re-run the quality gate after resolving. If resolution is genuinely ambiguous,
  `git merge --abort` and BLOCK to PM (§10).
- If the quality gate fails, `git merge --abort` (or reset the no-commit merge),
  do **not** tag or push, and BLOCK to PM with the failure. Never silently retry.
- If `<target>` has clearly diverged because base-tracking was skipped (the merge
  is huge or full of conflicts you would have to invent intent for), STOP and
  hand back to PM — base-tracking is PM/Dock's job, not yours.
- Record `target_before_sha` (target tip before the merge) and
  `target_after_sha` (the merge commit) for the report.

If no Concierge is configured, promote is blocked. PM never performs this
external execution as a fallback.

## §6.5 Phase 2 external-platform operations (default-disabled)

`create_pr` / `update_pr` / `close_pr`, `create_release` / `update_release` /
`publish_artifact`, `create_ticket` / `update_ticket` / `close_ticket`,
`check_external_ci`, and a write-enabled `sync_remote` are **off unless** your
`allowed_operation_kinds` lists the kind AND the assignment requests it. For each,
follow the Librarian runbook the assignment names (e.g.
`external_operations/runbooks/create_pr.md`).

`check_external_ci` is **read-only** (e.g. `gh run list` / `gh pr checks` /
`glab ci status`): it reports external CI state for the requester and writes
nothing, so it needs no Guardian gate — but it still requires the platform CLI
(NO_OP/BLOCK if absent) and reports pointer-only.

Three rules bind every Phase-2 operation that **writes**:

- **Provider parity / safe degradation.** Before any platform write, confirm the
  CLI exists (`command -v gh` / `glab` / the tracker CLI). If it is **absent**,
  write a `NO_OP` report naming the missing CLI and BLOCK — never push or open
  anything partially. (This is what keeps Phase 2 safe across Claude Code and
  Codex CLI runners.)
- **Remote-visible work uses a non-`garelier/*` prefix.** A PR head / release
  branch is pushed to `pr/<pm_id>/<slug>` / `publish/<pm_id>/<slug>` /
  `release/<version>` (the `allowed_external_branch_prefixes`), **never** a
  `garelier/*` branch, and never force-pushed.
- **Published text is redacted.** A PR body, release note, or ticket comment is
  generated from the Librarian template and must not contain a secret, token,
  PII value, internal `__garelier/` runtime path, or a long log — pointers only.

## §7. Gate consumption (you consume verdicts; you do not gate)

Before an external write you confirm — you do **not** re-judge — the gates:

- **Guardian** — a promote needs a passing Guardian verdict (`promote_gate` or
  `final_gate`: `PASS` / `PASS_WITH_NOTES`) bound to the integration tip. A
  `BLOCK`, a missing verdict, or a **stale** verdict (its `review_sha` ≠ the live
  tip — DEC-024) means you do **not** proceed: BLOCK to PM. There is no
  `release_gate`; promote reuses `promote_gate` / `final_gate`.
- **Observer** — if the assignment marks an Observer review required, its verdict
  must be `PASS` / `PASS_WITH_NOTES`.
- **Quality gate** — runs on the merged tree as part of §6; its pass is part of
  the promote, not a separate prerequisite you can skip.

## §8. Librarian knowledge dependency

Durable external-operation knowledge (promote policy, git-remote policy, rollback
policy, runbooks, body/note/record templates) is **owned by Librarian** under
the `external_operations/` knowledge tree. You read and apply it; you do not write
it. If you find a gap, a missing runbook, or a needed exception, write
`knowledge_update_request.md` (do not change the rule yourself) for Librarian; PM
approves before the knowledge changes — apply-a-rule is separated from
change-a-rule, exactly as for Guardian. Each operation you perform is a candidate
for Librarian to routinize into a defined approach the standard lanes can carry.

## §9. Report

Write `concierge_report.md` (`templates/concierge_report.md`): the operation
kind and verdict (`DONE` / `BLOCKED` / `FAILED` / `NO_OP`), the fixed refs,
`target_before_sha` / `target_after_sha`, the gate verdicts consumed, the
external result (URL / branch / tag — `n/a` in Phase 1 promote beyond the tag),
a compact command summary, and a **rollback / recovery** note (how to revert this
if needed). Follow compact handoff — never paste long logs, PR bodies, or release
notes; point at paths / URLs / SHAs. Never paste a secret or PII value.
Also write compact sibling `concierge_report.json` from
`garelier-core/templates/concierge_report.json`; do not duplicate the Markdown
body.
