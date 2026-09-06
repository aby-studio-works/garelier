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
- **Framework public release** (`framework_release`) — in the Garelier
  framework repository only, validate a history-free export, sync and push the
  approved public clone, wait for that commit's CI, then tag and create the
  release. See §6.4.
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

### Recovery: pushed but not tagged (`framework_release`)

A release lock left at `status = "pushed"` with **no `.done`** is not a stale
lock and is not a failure you clean up. It is the one state a release can stop
in after an irreversible external write: public `main` carries the release
commit, and the tag and GitHub release do not exist yet. Deleting the lock, or
finalizing it by hand, is what strands the release — the tag can then never be
created through the canonical route.

Recover it by continuing the same request, never by starting a new one:

```bash
GARELIER_ROLE=concierge GARELIER_PM_ID=<pm_id> GARELIER_AGENT_NAME=<agent> \
bun skills/garelier-core/driver/src/scripts/concierge_release.ts \
  --approval-ledger <approved-json> \
  --permission-record <attended-record-json> \
  --guardian-report <guardian-verdict.md> \
  --publish-repo <public-clone> --repo <owner/name> \
  --external-lock <canonical release__<tag>.lock> \
  --resume <request_id>
```

`--resume` proves exactly the same authority as a first attempt — same ledger,
same attended permission record, same passing Guardian verdict, same approved
remote. Only the publish-clone binding differs: instead of the ledger's
pre-release `expected_publish_sha`, the clone `HEAD` must equal the SHA that was
pushed, and the remote's own `main` head must equal it too. It skips the export,
the sync commit and the push, and restarts at the CI watch. A request whose
`.done` says `outcome = "failed"` is resumable and its `.done` is rewritten as
`complete` on success (the prior timestamp is kept as
`superseded_completed_at`); a request already finalized `complete` is not.

If the clone has moved on, restore it to the pushed SHA before resuming — do not
re-export, because that would publish a second, different tree under a tag the
approval was issued for.

## §6. Promote execution (promote_target)

PM has already: built the promote document, obtained explicit user approval,
ensured base-tracking (`<target>` folded into `studio`), and written your
assignment with the fixed `studio` SHA, the `<target>`, the tag/version, the
promote notes, and the passing Guardian `promote_gate` / `final_gate` verdict.

All remote git goes through the **mechanical push guard** (DEC-030):
`GUARD=../../garelier-core/driver/src/scripts/concierge_git_guard.ts`. The guard refuses `pull`, force
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

### Verifying phase (post-push confirmation)

`SKILL.md` §4 names a **verifying** phase inside `WORKING`, after `executing`.
For `promote_target` this is the concrete procedure — do it after
`"$GUARD" push origin <target> --tags` succeeds and before you write `DONE`:

```bash
"$GUARD" fetch origin
git log --oneline "$target_before_sha".."$target_after_sha"   # expected commits, in push order
git rev-parse "origin/<target>"                                # must equal $target_after_sha
```

- `git fetch` refreshes your worktree's view of the remote; a local push exit
  code of 0 is not on its own proof the ref updated the way you intended
  (a racing update to the same ref, a rejected non-fast-forward you silently
  retried, etc.).
- `git log --oneline target_before_sha..target_after_sha` is the same
  before/after pair you already recorded — re-display it so the report can
  point at the exact commit range that should now be live on `<target>`.
- `git rev-parse origin/<target>` must equal `target_after_sha`. If it does
  not, the push did not land as expected: do **not** report `DONE` — BLOCK to
  PM with the observed remote SHA.
- Record both `target_before_sha` and `target_after_sha` in
  `concierge_report.md` (§9); they are now confirmed against the fetched
  remote, not only the local merge.

No dedicated script backs this — `git fetch` + `git log --oneline` +
`git rev-parse` is the full verifying-phase procedure. It is deliberately
lightweight; automating it further is not warranted for a check this small.

If no Concierge is configured, promote is blocked. PM never performs this
external execution as a fallback.

## §6.4 Framework public release (framework_release)

The canonical entrypoint is
`skills/garelier-core/driver/src/scripts/concierge_release.ts`;
the privileged engine is private to that guarded module. `release.ts` exposes
only non-privileged tree helpers and refuses direct CLI execution. PM
first records explicit user approval in a JSON approval ledger, obtains a
passing Guardian verdict bound to the approved framework source SHA, and uses
`dispatch_prepare.ts --attended-seat --role concierge --approved-remote origin=<exact-url>` to
mint the attended permission record. The assignment fixes the approval-ledger
path, permission-record path, Guardian report, public clone, public `HEAD`,
GitHub repository, and exact remote URL.

The ledger is accepted only at
`control_root/__garelier/<pm_id>/runtime/concierge/requests/framework_release__<request_id>.approval.json`.
It binds `pm_id`, `control_root`, the shared `git_common_dir`, attended
`agent_name`, exact canonical permission/Guardian paths, `release_tag`, source
SHA, and destination inputs. The permission record is accepted only at the
canonical attended-spawn path for `GARELIER_AGENT_NAME`; the Guardian report is
accepted only under that PM's `runtime/guardian/results/`. A caller-created
lookalike elsewhere grants no authority.

`<pm_id>` is judged by the driver's one pm_id authority, `config.ts::validatePmId`
— the wrapper carries no pattern of its own, so the single-user default id
`_workshop` is accepted here exactly as it is at every other seat.

The Concierge first proves the whole route without an external write:

```bash
GARELIER_ROLE=concierge GARELIER_PM_ID=<pm_id> GARELIER_AGENT_NAME=<agent> \
bun skills/garelier-core/driver/src/scripts/concierge_release.ts \
  --approval-ledger <approved-json> \
  --permission-record <attended-record-json> \
  --guardian-report <guardian-verdict.md> \
  --publish-repo <public-clone> --repo <owner/name> --dry-run
```

Inspect the printed `export -> publish push -> CI watch -> tag -> release` plan.
Dry-run is lock-free and never reaches an external write.

Before the push, run `bun skills/garelier-core/driver/src/scripts/ci.ts` on the
export tree and require it to end `CI: ok` — the public CI runs on what is
pushed, not on the development tree, so a check that only the export tree can
fail (a smoke whose fixture went stale, or a version surface left behind) is
found there or not at all.

**Run it once, on Windows.** That single run is the release's real pre-flight
because `.github/workflows/ci.yml` pins `runs-on: windows-latest` — the same
platform, running the same command. While the workflow ran on `ubuntu-latest`,
which it did only because that is the default runner, the green Windows export
tree and the red public run were two different measurements: one release
published at 238 pass / 0 fail locally and failed 7 driver tests publicly.

A Linux run (under WSL2) is **not** required here and is not part of this
procedure. It is tracked as its own piece of work, and this section will call
for it only when the workflow carries a multi-platform matrix again. Until
then, a `runs-on` that moves off the platform releases are cut on is the defect
to raise — not something to compensate for with an extra manual run.

The version-drift check covers `VERSION` plus
`plugin.json`, `marketplace.json`, both READMEs, and the `CHANGELOG` section;
the setup wizard and the doctor are a seventh surface that no longer carries a
literal — they read `VERSION` through `src/version.ts`, and the check asserts
that literal stays absent.

For the live run, the lock path is not caller-selected. It is exactly
`control_root/__garelier/<pm_id>/runtime/concierge/locks/release__<tag>.lock`,
where `<tag>` is derived from the framework `VERSION` as `v<VERSION>` and
sanitized with the §5 filename rule. Set `GARELIER_PM_ID` and pass that
canonical path as `--external-lock`; the wrapper itself atomically creates the
immutable owner file (`create-if-absent`) with `pid=process.pid` and a random
nonce before the first external write. Finalization atomically creates
`<lock>.done`, bound to that request, PID, and nonce; it never overwrites the
owner record. Callers never pre-create either record and cannot substitute
another JSON path. An already-finalized tag or a pre-existing lock owned by
another live PID BLOCKs; a stale PID requires the §5 recovery procedure and is
not authorization. Keep the attended confirmations unless the recorded
approval explicitly authorizes `--yes`.

`.done` is written for a release that completed the tag and the GitHub release,
and for a failure that never pushed. It is **not** written for a failure after
the push: the lock is moved to `status = "pushed"` with the pushed SHA the
moment `git push origin main` returns, and the run continues to the CI watch
under a bounded wait — GitHub creates the workflow run a few seconds after the
push returns, so a single query can, and did, miss it. If the run never appears
inside that window the release aborts before the tag and says so, leaving the
request resumable. Continue it with `--resume` per the §5 "pushed but not
tagged" procedure; do not open a new request and do not hand-finalize the lock.

The wrapper also fails closed for a non-Concierge role, a missing/unapproved
ledger, source or public-clone drift, a stale/non-passing Guardian verdict, a
missing/mismatched attended permission record, or a live remote URL outside
the exact approved destination.

This is a two-layer authority model. Garelier role policy and the attended
record authorize the operation; the host harness still classifies the command
independently. Configure a narrow allow for
`Bash(bun skills/garelier-core/driver/src/scripts/concierge_release.ts *)`, or
have the user run that exact entrypoint. Never broaden the Concierge profile or
invoke `release.ts` directly to get around a harness denial.

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
- **Framework release** — `concierge_release.ts` requires a `PASS` /
  `PASS_WITH_NOTES` Guardian report whose `review_sha` is the exact approved
  framework source SHA.
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
