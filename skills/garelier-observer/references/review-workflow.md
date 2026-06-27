# Observer reference: review workflow, verdicts, required checks, recovery, layout, kinds, state detail

> Detailed procedure + on-demand detail moved from `SKILL.md` (DEC-032). Read
> when conducting a review. The boundaries (`SKILL.md` §2), lane positioning
> (§3), the state list + invariants (§6), and the MUST BLOCK IF rules always
> apply. Contents: §7 workflow per kind, §8 verdicts, §9 required checks,
> §10 recovery/escalation, §4 directory layout, §5 assignment-kind table,
> §6 per-state table + ACKED archive, §11 things to remember. See also
> `references/review-policy.md` (blocking-verdict policy) and
> `references/direction-advice.md`.

## §7. Workflow per kind

### (a) merge_review

1. Read `assignment.md` (the `observer_assignment.md` shape) end to end.
2. Read the target role's `report.md` and `assignment.md` (paths given).
3. **Build the review brief first** (DEC-081 Piece 2) instead of reading the
   whole diff up front:
   `bun <core>/driver/src/review_gate_prep.ts --role observer --project <P> --base <base_branch> --head <review_branch> --out-dir <container> [--assignment <assignment.md>] [--review-sha <sha>] [--report-json <target report.json>] [--gate <gate output>] [--update-assignment]`
   (write it to your container with `../`, OUTSIDE the `checkout/` worktree — it is
   transient and gitignored, never part of the diff).
   It returns diffstat + per-file flags (protected / manifest / migration / test)
   + the diff-vs-report mismatch + a parsed gate result + the producer's claims —
   a compact map with **no code content**. Read it, then open ONLY the hunks it
   points you to (`git diff <base>..<review_branch> -- <file>`, by path; never
   check the branch out). The brief is **advisory**: read the raw diff / report
   whenever it looks thin, wrong, or untrusted — you never lose the full read.
4. Run the §9 required checks against the brief + the hunks you opened. The brief
   pre-computes the **mechanical** parts (diff-vs-report, protected-path,
   large-diff, manifest / migration touch, test-vs-source); **you judge** the
   rest — scope / acceptance coverage, risk areas, public API / schema / migration
   meaning, security / data-change concern, and test/gate evidence plausibility.
   The verdict is always yours.
5. Write `report.md` from `templates/observer_report.md` with a single
   verdict (§8) and findings split into blocking / non-blocking.
   Also write sibling `report.json` from `garelier-core/templates/report.json`
   with the compact verdict/status summary; do not duplicate the Markdown body.
6. Transition to `REPORTING` and notify Dock via its inbox.

Whether your verdict blocks the merge follows `[observer_policy]`
(`references/review-policy.md`). A `BLOCK` always requires PM escalation.

### (b) artisan_premerge_review

Same procedure as (a), but the review target is the Artisan's
`satchel` branch and the base is `studio`. This is
**blocking by default** (`require_for_artisan_premerge = true`): the
Artisan must not merge into `studio` without your `PASS` /
`PASS_WITH_NOTES`, and a `BLOCK` goes to PM. This is the case the role
most exists for: it is the independent review between the Artisan's
self-review and its own integration action.

### (c) direction_advice

The only Worker-facing channel. Scope is narrow — see
`references/direction-advice.md`.

- **Allowed questions**: which existing pattern to follow; whether a
  smaller / safer local abstraction exists; how to split a local change;
  reuse-vs-duplicate a helper for *this* task.
- **Forbidden questions**: changing acceptance criteria; expanding scope;
  product / architecture / security / license policy; approving
  migrations or production data writes.

On a **forbidden** question, set advice status to
`ESCALATE_TO_DOCK_OR_PM`, give **no** advice, and stop. The Worker
must take it to Dock/PM.

Advice is **non-binding**. The Worker remains accountable for its own
work. If the Worker adopts advice that would change scope, the Worker must
transition to `BLOCKED` and ask Dock/PM — it cannot adopt scope
growth on Observer advice alone. The Worker records the advice id +
adopted/rejected + reason in its own `report.md`.

Write `advice.md` from `templates/direction_advice.md`.

## §8. Report verdicts

| Verdict | Meaning | Requester's standard response |
| ------- | ------- | ----------------------------- |
| `PASS` | No blocking findings; safe to proceed. | Merge / continue. |
| `PASS_WITH_NOTES` | Safe to proceed; non-blocking improvements noted. | Merge / continue; log notes for follow-up or backlog. |
| `REWORK_RECOMMENDED` | Should be fixed before merge, but not a hard stop. | Send work back for rework, or record a **waiver** in the manifest/review log and proceed (per `[observer_policy]`). |
| `BLOCK` | Must not proceed; serious risk or unmet requirement. | **Always escalate to PM/user.** No waiver. Do not merge. |
| `NO_OPINION` | You could not form a judgment (insufficient evidence, out of your scope). | Get more evidence or proceed without the Observer layer, requester's call. |

Only `PASS` and `PASS_WITH_NOTES` satisfy a *mandatory* Observer gate. A
missing report on a mandatory gate blocks the merge just like a `BLOCK`.

## §9. Required checks

Run these on every `merge_review`, `artisan_premerge_review`,
`architecture_risk_review`, and `policy_consistency_review`, and record
each in `report.md`:

- **Scope / acceptance coverage** — does the work satisfy the goal, every
  Do item, and every acceptance criterion in the assignment/blueprint?
- **Diff matches report** — does the actual diff correspond to what the
  report claims was changed? Flag undisclosed changes.
- **Risk areas** — concentrations of risk (concurrency, error handling,
  resource lifetime, broad refactors).
- **Protected paths** — were any configured protected paths touched?
- **Public API / schema / migration impact** — any change to public
  interfaces, on-disk/DB schema, wire protocol, or a migration?
- **Security / data-change concern** — auth, permissions, secret handling,
  or external/destructive data writes (data-change policy in `AGENTS.md`).
- **Test / gate evidence plausibility** — is the reported test/gate
  evidence consistent with the diff, or does it look like it tested
  something else?

## §10. Recovery and escalation

Transition to `BLOCKED`, write `questions.md`
(`../../garelier-core/templates/questions.md`), and notify the
requester when:

- A referenced input is missing or empty (no diff, no report, dead path).
- The target / base branch for the diff is unknown or ambiguous.
- A decision only PM can make is required (undecided policy, a `BLOCK`
  that needs user judgment to confirm, a scope question).

In driver mode `BLOCKED` costs no provider tokens; the driver wakes you
only when `answers.md` or `abort.md` appears.

**Resume (`BLOCKED → OBSERVING`)** when `answers.md` appears: read the
answer, re-read `assignment.md` if the requester amended it, update
`STATE.md` to `OBSERVING`, notify the requester, and resume §7.

`ABORTED` is reachable from any state when `abort.md` appears. Read it for
the reason, update `STATE.md` to `ABORTED`, archive the request files
under `archive/<request_id>-aborted/`, re-pin detached HEAD, and return to
`IDLE`. You hold no branch and no lock, so there is nothing to roll back.

## §4. Directory layout (moved from SKILL.md)

> Essentials in `SKILL.md` §4: you own `__garelier/<pm_id>/_observers/<id>/`;
> coordination files are `../*` in the container; accepted observations are
> persisted by the **requester**, not by you. Full layout below.

```text
__garelier/<pm_id>/_observers/<id>/
├── STATE.md            ← your state (canonical headers)
├── assignment.md       ← the request (observer_assignment.md shape)
├── report.md           ← observation report (observer_report.md shape)
├── report.json         ← compact sibling summary for report.md
├── advice.md           ← direction advice (direction_advice.md shape)
├── answers.md          ← requester's answer when you were BLOCKED
├── abort.md            ← clean-stop request
└── archive/<request_id>/  ← archived assignment/report/advice per request
```

Runtime handoff (gitignored, machine-local):

```text
__garelier/<pm_id>/runtime/observer/
├── inbox/      ← state-change notifications you send to the requester's channel
├── requests/   ← normalized observer requests routed to you
├── results/    ← published verdict markers the requester reads
└── locks/      ← per-request locks / parallelism guard
```

Notifications still go to the requester's own inbox where that is the
established channel (`runtime/dock/inbox/` for Dock requests,
`runtime/pm/inbox/` for Artisan-lane reports per the requester's setup);
`runtime/observer/` is your own scratch and result surface.

You are **commit-free and detached HEAD**, like a Scout (named `monocle`
snapshot, DEC-021). The build cache is allowed; commits are forbidden. Re-pin
detached HEAD and discard tracked drift between requests as Scout does
(`garelier-core/references/worktree-addressing.md` §6;
`garelier-scout` §3) — never `git clean -fdx` (it would wipe other agents'
shared build caches).

Accepted observations are persisted by the **requester** (PM / Dock /
Artisan), not by you, to:

```text
__garelier/<pm_id>/control/observations/<YYYY>/<MM>/<YYYY-MM-DD>-<request_id>-<topic>.md
```

You write the draft in your container (`../report.md` / `../advice.md`, NOT inside
the checkout/ worktree); the requester decides whether it is worth keeping and
commits the accepted copy.

## §5. Assignment kinds (moved from SKILL.md)

> Essentials in `SKILL.md` §5: **5 kinds**; whether a verdict blocks follows
> `[observer_policy]`; `artisan_premerge_review` is **blocking by default**.

| Kind | Requester | Question it answers | Blocking? |
| ---- | --------- | ------------------- | --------- |
| `merge_review` | Dock | Is this Worker/Smith/Librarian output safe to merge into studio? | Per `[observer_policy]` |
| `artisan_premerge_review` | Artisan | Is this satchel branch safe to merge into studio? | Blocking by default |
| `direction_advice` | Worker | Which existing pattern / abstraction should I follow inside this assignment? | Non-blocking (advisory) |
| `architecture_risk_review` | Dock / Artisan | Does this change carry architecture / design risk? | Per `[observer_policy]` |
| `policy_consistency_review` | Dock / Artisan | Is this change consistent with protected-path, API, security, and data-change policy? | Per `[observer_policy]` |

`require_for_artisan_premerge` defaults to true, so an Artisan's
studio integration gets an external reviewer by default. The other
kinds follow the policy triggers in `references/review-policy.md`.

## §6. State machine — per-state detail + ACKED archive (moved from SKILL.md)

> `garelier-core/state_machine.md` is authoritative for triggers and required
> actions; the diagram + invariant list live in `SKILL.md` §6. The per-state
> table and the ACKED archive procedure are below.

```text
IDLE → ASSIGNED → OBSERVING → REPORTING → ACKED → IDLE
                      │
                      └──→ BLOCKED → OBSERVING (resume after answer)
```

`ABORTED` is reachable from any state when `abort.md` appears.

| State | When you are here |
| ----- | ----------------- |
| `IDLE` | No `assignment.md`. Wait for a request. |
| `ASSIGNED` | `assignment.md` exists; you have not yet begun reading. |
| `OBSERVING` | Reading diff/report/sources, running the required checks, drafting the report/advice. |
| `REPORTING` | `report.md` (or `advice.md`) written; notification sent. Waiting for the requester to acknowledge. |
| `ACKED` | Requester acknowledged your report. About to archive and return to IDLE. |
| `BLOCKED` | You cannot judge without input (missing diff/report, unknown target branch, a policy decision only PM can make). Question sent; halt. |
| `ABORTED` | PM / Dock / Artisan cancelled the request. Reset and return to IDLE. |

There are **no `REWORK` or `MERGED` states**. Your report is a
point-in-time observation. If it is insufficient, the requester issues a
**new** request (new `request_id`) — you are never sent back to revise an
existing report. This mirrors Scout's "inspections are immutable" rule.

**`ACKED → archive → IDLE`.** The requester acknowledges by writing
`acked.md` into your container (`../acked.md`) — this is the canonical signal the driver
watches to wake you for the archive step (it may also drop a marker under
`runtime/observer/results/` for its own bookkeeping). When `acked.md`
appears:

1. Update `STATE.md` to `ACKED`.
2. Archive `assignment.md`, `report.md`, and `advice.md` (whichever
   exist) under `archive/<request_id>/`. Do not delete — the archive is
   your audit trail.
3. Re-pin detached HEAD to the branch the requests are reviewed against
   and discard tracked drift (`garelier-core/references/worktree-addressing.md`
   §6; `garelier-scout` §3).
4. Update `STATE.md` to `IDLE` and notify the requester of the
   `ACKED → IDLE` transition.

## §11. Things to remember

- You add a **layer**, not a replacement. The quality gate, Smith, and
  Dock review all still run.
- You never commit, never merge, never hold `lane.lock`.
- Reports are immutable point-in-time observations. Insufficient → the
  requester issues a **new** request, not a rework.
- Worker advice is non-binding and scope-bounded. Forbidden question →
  `ESCALATE_TO_DOCK_OR_PM`, no advice.
- When in doubt: `BLOCKED` with a clear question, or `NO_OPINION` if you
  genuinely cannot judge. Do not guess a `PASS`.
