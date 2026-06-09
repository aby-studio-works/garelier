# Observer reference: review policy

Detail for `garelier-observer` §5, §8, and §10: when an Observer review
is **mandatory**, when a verdict **blocks** a merge, and how Dock may
proceed past a non-`BLOCK` verdict with a recorded waiver.

The policy lives in a `[observer_policy]` section (in the PM's
`setup_config.toml`, alongside the other role config blocks). The
Observer reads it; Dock and the Artisan enforce it.

## When Observer review is mandatory

Review is mandatory for a change when **any** of these hold and the
corresponding policy key is enabled:

- **Every merge**, unconditionally (`require_for_all_merges`). When set,
  this is the dominant rule: no producer merge into `studio` in either lane
  may land without a passing Observer verdict,
  regardless of diff size or which paths changed. It encodes the mandated
  pipeline order **worker → guardian → observer → dock** (and
  **artisan → guardian → observer → artisan**): the Observer review is the
  last gate before the merge. The merge-gate backstop
  (`observer_policy_check.ts`) enforces it mechanically — a forgotten
  `observer_required` cannot let a merge through.
- The diff exceeds `large_diff_lines` (`require_for_large_diff`).
- A configured **protected path** is changed (`require_for_protected_paths`).
- A **public API**, on-disk/DB **schema**, or wire **protocol** changes
  (`require_for_public_api_change`).
- The change includes a **migration** or any external **data change**
  (`require_for_migration`).
- The change touches **auth / security / permission** code
  (`require_for_auth_security`).
- The target role's **report and diff do not match** (an undisclosed
  change). This always triggers review regardless of size.
- **PM explicitly requested** an Observer review for this work.

For the Artisan, `require_for_artisan_premerge` makes
`artisan_premerge_review` mandatory by default because the Artisan is also its
own studio integrator.

When review is mandatory, a **missing** Observer `PASS` /
`PASS_WITH_NOTES` blocks the merge exactly like a `BLOCK` verdict: the
requester must not merge until the Observer has reported a passing verdict
(or PM has overridden via escalation).

## Blocking vs non-blocking

| Verdict | Mandatory gate | Optional review |
| ------- | -------------- | --------------- |
| `PASS` | Merge may proceed. | Merge may proceed. |
| `PASS_WITH_NOTES` | Merge may proceed; notes logged. | Merge may proceed. |
| `REWORK_RECOMMENDED` | Rework, **or** record a waiver and proceed (see below). | Requester's call; log the decision. |
| `BLOCK` | **Always escalate to PM/user. No waiver. Do not merge.** | Same — `BLOCK` is never waivable. |
| `NO_OPINION` | Gate not satisfied; get more evidence or escalate. | Proceed without the Observer layer if the requester chooses. |

A non-blocking (optional) review never gates the merge; it only adds
findings the requester may act on.

## Waivers

When the verdict is `REWORK_RECOMMENDED` (never `BLOCK`) and the requester
judges that proceeding is acceptable, Dock **may proceed past it but
must record a waiver**. The waiver is logged in the runtime manifest /
review log with: the `request_id`, the verdict, the specific findings
being waived, who waived, the reason, and any follow-up backlog item. An
unrecorded skip of a mandatory review is a protocol violation.

`BLOCK` is **not** waivable. A `BLOCK` always goes to PM/user via the
standard escalation flow (`state_machine.md` §7); PM may then re-scope,
override with explicit instruction, or send the work back.

## Policy keys

`[observer_policy]`:

| Key | Type | Meaning |
| --- | ---- | ------- |
| `enabled` | bool | Top-level switch for the Observer layer. |
| `require_for_all_merges` | bool | Require a passing Observer verdict on **every** merge (both lanes), unconditionally. Enforces worker→guardian→observer→dock; backstopped by the merge gate. Default false (relies on the triggers below); the template sets it true. |
| `require_for_artisan_premerge` | bool | Make `artisan_premerge_review` mandatory (default true). |
| `require_for_large_diff` | bool | Require review when the diff exceeds `large_diff_lines`. |
| `large_diff_lines` | int | Changed-line threshold for "large diff". |
| `require_for_protected_paths` | bool | Require review when a protected path changes. |
| `require_for_public_api_change` | bool | Require review on public API / schema / protocol change. |
| `require_for_migration` | bool | Require review when a migration / data change is present. |
| `require_for_auth_security` | bool | Require review on auth / security / permission code. |
| `allow_worker_direction_request` | bool | Allow Workers to request `direction_advice`. |
| `max_parallel_requests` | int | Max concurrent Observer requests (parallelism guard via `runtime/observer/locks/`). |
| `advice_is_binding` | bool | Whether `direction_advice` is binding. **Default false** — advice is advisory; the Worker stays accountable. |

When `advice_is_binding` is false (the default), direction advice never
forces a Worker action; see `references/direction-advice.md`.
