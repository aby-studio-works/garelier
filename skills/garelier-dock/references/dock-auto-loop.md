# The gated Dock auto-loop tick (DEC-059)

How the Dock runs autonomously on the **dispatch** substrate (DEC-057/058) while
the human steers ONLY via the interactive PM dialog + the read-only Status Web.
The Dock auto-loop is the autonomous dispatch loop (the jig, DEC-062, runs its
tick as code); the former headless driver
is DISABLED (DEC-061: it refuses to launch in this dispatch-only build) and is
retained only as historical/reference.

The former headless-driver mode (interactive PM + headless driver) was deleted
(DEC-066); the Dock auto-loop = interactive PM + dispatch auto-loop. Garelier
always has an interactive PM (DEC-059).

## Arming / disarming

The PM (or operator) arms a **self-paced `/loop`** with the tick prompt below —
no fixed interval (the loop idles at ~0 tokens when nothing is ready, DEC-049):

```
/loop  Run one Garelier Dock auto-loop tick: follow skills/garelier-dock/references/dock-auto-loop.md.
```

Disarm by stopping the loop. State is durable in the runtime file protocol, so a
relaunch recovers from `runtime/manifest.md` / role `STATE.md` / escalations /
`runtime/dock/dispatch_hold.md` / merge-gate active lock.

## The tick (one Dock iteration)

Each tick is exactly one Dock-orchestration iteration of
`garelier-core/references/role_subagent_dispatch.md` §4, with a gate check:

1. **OBSERVE** — read `runtime/manifest.md`, role `STATE.md`, the backlog, and
   `runtime/dock/inbox`/escalations. Compute the ready assignments (respect
   priority tiers + interest-file gating; never re-dispatch in-flight work). If
   nothing is ready, the tick does nothing (the loop self-paces).
2. **GATE CHECK (pre-dispatch)** — classify each ready action against the four
   human-decision gates (see below). On a hit, **park only that thread** (write
   `runtime/dock/escalation/ESC-*.md` + a `runtime/pm/inbox/` note + refresh
   `runtime/dock/dispatch_hold.md`; set the role `BLOCKED` + `questions.md`) and
   skip dispatching it. Other threads keep flowing. Never auto-decide a gate.
3. **DISPATCH** — fan out the non-gated ready roles, capped at
   `[autonomy] fan_out_cap` parallel (Workflow tool for parallel, Agent tool for a
   single one; recorded CLI roles via `dispatch_provider.ts` synchronously,
   DEC-058). Each runs to completion in its own worktree off `studio`
   (`dispatch_prepare` records the `start` event automatically, §4b).
4. **INTEGRATE** — on each return: re-run the GATE CHECK (on-return), then send the
   branch through **Guardian → Observer** (`require_for_all_merges`) and run the
   **merge gate** into `studio` (DEC-045 order); dispatch Smith hardening if
   configured. Record `complete`/`blocked` with `dispatch_event.ts`
   (event append + in_flight.md view regen, §4b).
   - **Long quality gates are Dock-run, not role-run** — a role reliably
     abandons a ~30-min build. The role edits + does a quick local sanity; the
     authoritative gate runs as a Dock-controlled run-to-completion
     background task (`merge_gate.ts` / a Dock-launched gate) that notifies on
     finish. Integrate only after it actually completes (never background-and-bail).
5. **RECORD** — role `STATE.md` + a manifest activity line; execution rows are
   DERIVED (W-011: `in_flight.md` is generated, the manifest carries no roster
   tables). Parked gates light `pmAction` + the ⏸ DISPATCH HOLD banner on the
   Status Web and surface as a PM dialog question.

## The four human-decision gates (HALT to PM; never auto-decide)

Driven by the existing knowledge — the `engineering/change_isolation_policy.md` knowledge file
(protected/engine-core globs, plus `[autonomy] protected_paths`),
`system/decision_authority.md`, and `system/escalation_policy.md`:

1. **Engine-core / protected-path** — the change would touch a protected glob
   (core source, the dependency manifest/lockfiles, CI/infra/migrations, `__garelier/**`, or
   anything in `[autonomy] protected_paths`).
2. **Scope expansion** — the work needs more than the assignment's allowed scope
   (new root structure, removing an acceptance criterion, cross-domain blast).
3. **Promote** — anything that would leave the local sandbox (promote `studio`
   into the target, push). PM approves; Concierge executes.
4. **Ambiguous blocker** — a BLOCKED return whose resolution needs a human call
   (contradictory AC, missing input, a policy judgment).

A gate parks the affected thread and keeps the rest of the pipeline moving; the
loop does not re-tick a parked item until the PM answers.

## Config (`[autonomy]`, DEC-059)

```toml
[autonomy]
enabled = true             # arm the self-pacing Dock auto-loop (opt-in; absent = off)
fan_out_cap = 3            # max parallel role subagents per tick
# NOTE: require_for_all_merges is NOT an [autonomy] key — it is parsed only under
# [guardian_policy] / [observer_policy]. Set it true THERE; placing it here is
# silently ignored. The INTEGRATE step keeps Guardian→Observer on every merge.
auto_approve_blueprints = false # soft-gate collapse only (PM auto-proceeds on its own judgment)
auto_approve_milestones = false
protected_paths = [        # HARD gates to the human PM
  "src/core/**", "<dependency-manifest>", "<lockfile>", ".github/**", "infra/**",
  "deploy/**", "migrations/**",
]
```

A *headless-supervised PM* is not a Garelier usage mode (the PM always stays
interactive); its "proceed on PM judgment when safe" value is the `auto_approve_*`
soft-gate collapse above, WITHIN the Dock auto-loop.

## Limits

The provider's usage limit is unchanged (the loop simply stops when the provider's
usage limit is reached; there is no capacity governor). The loop is tied to one
live interactive session (file-state recovers on
relaunch; use `/compact`). Gate globs need per-target tuning. A doctor warning
for an empty `[autonomy] protected_paths` when the auto-loop is armed is
**planned (roadmap, DEC-059 later phase) — not yet shipped**; until then, set
`protected_paths` explicitly when arming the Dock auto-loop so the
engine-core/protected-path gate has globs to match.
