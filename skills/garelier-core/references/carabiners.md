# Carabiners — a role's task-forms

The canonical reference for **carabiner**, Garelier's word for a task-form a role
clips on. Decision of record: DEC-095 (ACCEPTED 2026-07-16, user 確定). Other docs
point here rather than redefining the term.

## What a carabiner is

A **carabiner** is the task + output-contract type a role takes on **without
changing its identity, permissions, or skill**. The Observer verifying a merge
verdict, the Guardian re-gating a mechanical delta, the Scout running a full test
suite — these are the same role clipping onto different work, not different roles.

"mode" is deliberately **not** used for this: it is already overloaded
(`--mode fresh/diff/migrate`, permission mode, `commit_mode`, "Mode D/E"). The
older scattered spellings `variant` and "gate mode" for a role's task-form are
retired in favor of carabiner. (`variant` in its other, unrelated senses — an
enum variant, a register-canonical template variant, a case variant — is a
different word and stays.)

## Mental model (gear metaphor)

Same gear family as `satchel` / `anvil` / `gavel` / `shelf` / `lane` / `lens`.
Picture a climber jangling with clips:

- **role** = the climber (identity / seat / roster entry).
- **gear rack** = the bundle of carabiners that role carries = its whole set of
  usable task-forms.
- **carabiner** = one clip you re-attach = one task-form (task + output-contract
  type). The role does not change; only where it clips does.
- **lens** = where the eye focuses (a judgment focus). **Orthogonal** to the
  carabiner.

## Three axes (role / carabiner / lens)

They are independent. A role picks a carabiner (which task), then optionally a
lens (which focus) — neither changes its permissions or identity.

| axis | changes | examples |
| :-- | :-- | :-- |
| **role** | identity / permissions / skill | Observer / Guardian / Smith |
| **carabiner** | the task + output-contract type | `refuter` / `delta_gate` / `merge_review` |
| **lens** | the focus of judgment only | observer.review `over_engineering` / `architecture` |

A **lens is not a carabiner**: a lens tunes *focus* only — it never changes
permissions or the output format. A carabiner changes the *task and its output
contract*. (See `skills/garelier-core/templates/lenses/lens_registry.toml` and the lens
packs for the lens side.)

A **PM-direct lane form is not a carabiner** either. `direct` versus `isolate`
selects execution placement, not a task/output contract; both forms are
contained under `__garelier/<pm_id>/_crew/lanes/` (DEC-093).

## Ownership: shared carabiners + per-role racks

A carabiner is **defined standalone**, not as a sub-kind of one role — the way a
real carabiner is a general-purpose clip that fits any climber's harness. Each
role then declares its **rack** (the list of carabiners it may clip), and a role
may only clip carabiners on its rack.

- **Shared carabiner** (on more than one role's rack): `adversarial_verify` — the
  general form of the refuter, where the task type is common (challenge a claim
  with evidence, refute-default) and the target is supplied by role + context.
  The Observer clips it to refute a merge verdict; the Smith clips it to refute a
  window-hardening claim. Also shared: `design_review` (Observer + Wanderer) and
  `delta_check` (Guardian + Observer).
- **Single-role carabiner** (on exactly one rack): `merge_review` (the Observer's
  own core task) / `preflight` and `final_gate` (the Guardian's security core).
- **Safety catch**: the rack is a compatibility list. A misapplication — a Scout
  trying to clip `merge_review`, say — is rejected because the carabiner is not on
  that role's rack.

Consequence: the refuter is **not** "an Observer-only thing." It is the
`adversarial_verify` carabiner as the Observer clips it. The Smith can clip the
same carabiner.

## Initial carabiners (the existing task-forms, organized)

Existing task-forms, read as carabiners. The `kind` enum values used by the
tooling (e.g. the Observer assignment `kind`) are unchanged — this table names
which carabiner each is.

**Observer** rack:
- `merge_review` — standard: is this output safe to merge into studio?
  (Observer-only.)
- `artisan_premerge_review` — is this satchel branch safe to merge into studio?
- `architecture_risk_review` / `policy_consistency_review` — design-risk and
  policy-consistency review kinds.
- `advice` (`direction_advice`) — non-binding direction options, no verdict.
- `adversarial_verify` (**refuter**, W-066) — verify a verdict, refute-default;
  output `refuter_verdict: UPHELD | REFUTED`. Shared with Smith.
- `design_review` (DEC-076) — pre-implementation blueprint review; the Observer's
  stand-in when the Wanderer peer is absent. Shared with Wanderer.

**Guardian** rack:
- `preflight` / `final_gate` — standard security gates (Guardian-only core).
- `delta_gate` / `delta_check` (mechanical-delta re-gate, W-032) — the lightweight
  one-role re-gate, recorded with a `DELTA-REGATE of <sha>` line. Shared with
  Observer as `delta_check`.

**Scout** rack:
- web research / test-suite run / daily report — the commit-free investigation
  carabiners, one per target kind.

**Concierge** rack:
- external-effect carabiner: dry-run → approval → execute.

## Extension norms

New work is expressed **by adding a carabiner, not a role**:

1. if an existing carabiner fits, add it to that role's rack;
2. if it is a genuinely new task-form, define a new carabiner and put it on the
   racks of the roles it fits.

**Adding a new role is the last resort.** The three axes stay separate: reach for
a new carabiner (new task-form) or a new lens (new focus) before a new seat.

## See also

- DEC-095 — `__garelier/<pm_id>/control/decisions/DEC-095-carabiner-role-task-forms.md`
  (definition, gear metaphor, ownership model, initial carabiner list).
- `skills/garelier-observer/references/refuter-verify.md` — the `adversarial_verify`
  carabiner as the Observer clips it (the refuter contract).
- `attended-gate-dispatch.md` § Mechanical-delta re-gate — the `delta_gate`
  carabiner.
- `skills/garelier-core/templates/lenses/lens_registry.toml` — the lens axis (focus, not
  task-form).
