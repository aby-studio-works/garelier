# Garelier PM Autonomous Mode Reference

The autonomous layer for **dispatch-only** Garelier (DEC-057/059/061/066):
one attended interactive PM session + a self-pacing Dock auto-loop whose
roles are in-session subagents (or `codex exec` subprocesses, DEC-058)
and whose tick runs as code via the jig (DEC-062 — default-on).
There is no headless PM and no headless driver; the former Mode B was
deleted outright (DEC-066 — history lives in the decision records).

Section numbers are stable (§15.x) because other documents cite them.

## §15. Autonomous mode

### 15.1 The `[autonomy]` block

Read it from `__garelier/<pm_id>/_crew/pm/setup_config.toml`. Absence of the
section is equivalent to `enabled = false` (the loop is opt-in; one-off
dispatches need no `[autonomy]` at all).

```toml
[autonomy]
enabled = false                  # arm the self-pacing Dock auto-loop (opt-in)
auto_approve_blueprints = false  # PM commits blueprint drafts without user review
auto_approve_milestones = false  # PM updates milestones without confirmation
protected_paths = ["src/core/**", "<dependency-manifest>", ".github/**", "infra/**", "migrations/**"]
```

The tick mechanics (adaptive admission, gates, merge, record) are configured by the
`[jig]` block (`garelier-core/references/jig.md`); `[autonomy]`
governs WHEN the loop runs and what PM may auto-approve.

### 15.1a Config knob inventory (W-199)

Every `[autonomy]` / `[jig]` knob below has a LIVE code reader (`config.ts`
`normalizeAutonomy` / `normalizeJig`) and a real branch — there are no dead
"pick-one-of-one" switches left after the D/E label retirement (the taxonomy was
the dead part, not the flags). There is no `mode` knob: the old `mode = "d"`
mention was a phantom (no reader) and has been removed from the docs.

| Block | Knob | Live branch |
| :-- | :-- | :-- |
| `[autonomy]` | `enabled` | arms / disarms the self-pacing Dock auto-loop (opt-in; absent = off) |
| `[autonomy]` | `auto_approve_blueprints` | collapses the blueprint soft-gate (HARD gates never collapse) |
| `[autonomy]` | `auto_approve_milestones` | commits milestone bookkeeping without confirmation |
| `[autonomy]` | `protected_paths` | globs that HARD-gate to the human PM |
| `[jig]` | `enabled` | DEFAULT-ON (DEC-062); `false` is the explicit opt-out → the prose Dock auto-loop tick operates |
| `[jig]` | `max_rework_rounds` | rework-loop bound before escalation |
| `[jig]` | `critical_roles` | N-version fan for a critical item |
| `[jig]` | `smith_batch_every` | Smith window-hardening cadence (DEC-069; 0 = disabled) |
| `[jig]` | `review_depth` | per-severity gate depth (`gate` / `gate+refute` / `nversion`) |

### 15.2 What PM skips when enabled

- `auto_approve_blueprints = true`: PM finalizes blueprint drafts without
  waiting for user review (soft-gate collapse). The four HARD gates never
  collapse: protected-path changes, scope expansion, promote, and
  ambiguous blockers always HALT to the human (DEC-059). Also NOT collapsed:
  the DEC-076 **design-review gate** — a non-trivial blueprint/design still needs
  independent review + sign-off before it is finalized. Wanderer is user-opt-in
  only; when it is absent, stale, rate-limited, or unavailable, the PM uses the
  Observer subagent fallback.
- `auto_approve_milestones = true`: milestone bookkeeping updates commit
  without confirmation.

### 15.3 `autopilot:` tagging

Every commit/artifact PM produces while the loop is armed carries an
`autopilot:` marker in its history entry, so a later review can separate
loop decisions from conversational ones.

### 15.4 The tick (loop invocation)

One tick = one pass of OBSERVE → PLAN → DISPATCH → GATE → INTEGRATE →
RECORD:

1. Preferred: substitute and run the jig template
   (`garelier-core/templates/jig_tick.workflow.js`) via the Workflow tool —
   order is code. Pass `args.admission.provider_available_slots`, current
   `args.admission.host.{cpu,memory,io}_available_slots`, and every candidate's
   `resource_class`; PLAN chooses among the candidates within that adaptive
   measured budget. Partial telemetry uses only the measurements present, and
   every known zero keeps the budget at zero. Only when no relevant provider or
   host measurement exists at all does the tick emit a diagnostic and admit at
   most one non-heavy item; heavy and remaining work are explicitly requeued.
   PLAN prefers items that
   retire an open high/critical risk (blueprint `Kills risk:` / the
   milestone's riskiest unknown — DEC-070 risk-first) over comfort work;
   the control graph's `risk-first-drift` advisory flags drift.
   **If a plan exists, proceed from its head.** PLAN's default candidate is the
   PLANNED progression order — schema-3 Current/Checkpoint and queried open
   Backlog, then the concept-first tiers, then active Milestone relations. Never
   scan the control tree or substitute a generated view for bounded resume. A newly
   discovered task (from an audit, a gate note, or a user aside) is **not
   dispatched impulsively**: evaluate its risk **against the existing planned
   tasks**, assign it a priority, and **reflect that into the plan** — insert it
   at the resulting queue/backlog position. If, and only if, the evaluation
   genuinely ranks it above the current head, **reorder the plan to lead with
   it** (a deliberate, recorded priority decision — not an impulse). Then
   proceed from the plan's head. "risk-first" (DEC-070) means the riskiest
   unknown **WITHIN the planned scope**, never "the newest / most salient item".
   **The failure is dispatching a just-registered item ahead of the queue
   WITHOUT this evaluate-and-reflect step** — that is recency-bias drift, the
   exact thing `risk-first-drift` exists to catch. Registering a "new" item that
   merely re-touches something already planned is churn, not progress: work the
   existing planned item.
   **A user question or design conversation is NOT a dispatch directive.** When
   the user asks about, discusses, or confirms the design of a topic, that
   yields a *filed, evaluated* item — not a queue jump. The user-redirect
   exception applies only to an **explicit instruction to do it first / now**.
   When unsure, ask one line: "計画では次は X ですが、これを先行させますか".
   An idle lane is never a reason to jump — leaving capacity unused while the
   queue head is in a mandatory pre-step (e.g. design review) is correct
   behavior, not waste.
2. Resume after BLOCKED: when a role finishes but blocks (question /
   pre-existing base failure), resolve the block (answers.md / repair
   task), then run `garelier-core/templates/jig_gate_held.workflow.js` to
   gate + merge the held branches without re-running the role.
3. Fallback (`[jig] enabled = false`): the prose tick in
   `garelier-core/references/role_subagent_dispatch.md` §4 /
   `garelier-dock/references/dock-auto-loop.md`.
4. Self-pacing: drive ticks with the built-in `/loop` (no fixed interval);
   the Dock idles at ~0 tokens between ticks (DEC-049).
5. Anything matching a hard gate is PARKED (ESC note + pm/inbox +
   dispatch_hold) — never auto-decided.

### 15.5 Enabling

1. Confirm the quality gate commands are real (`[quality_gate]`).
2. Set `[autonomy] enabled = true` (+ chosen auto_approve flags and
   `protected_paths` tuned to the target). Do not tune a fixed fan-out value;
   each Jig tick uses its measured adaptive admission budget.
3. Run the §13.4 cleanup audit (history-and-operations) if resuming after
   a crash/interruption.
4. Arm `/loop`. Tell the user how to stop it (§15.6).

### 15.6 Disabling / stopping

Explicit user stop phrases (§13.2) stop the loop: finish or park the
current tick, never mid-merge. Set `enabled = false` to disarm across
sessions. A dispatch HOLD (`dispatch_hold.md`) parks the backlog without
disarming the loop.

### 15.7 User input during the loop

The PM session stays conversational. User messages interleave between
ticks; gate questions surface as PM dialog questions AND on the Status
Web (pmAction / DISPATCH HOLD). Answering a parked question un-parks only
that thread.

### 15.8 Loop state inspection

To see what the loop is doing right now:

- `skills/garelier-core/driver/src/dispatch/dock_status.ts` — lane, merge gate,
  backlog counts, LIVE `_crew/dispatch<N>` roles, parked inventory, recent
  events.
- The read-only Status Web (Dispatch activity + Live work board).
- Raw truths: `runtime/dispatch/events.jsonl`,
  `runtime/merge_gate/{requests,results,locks}/`, `_crew/dispatch<N>/STATE.md`.

### 15.9 When the roadmap is finished

When every milestone is shipped and the backlog has no ready rows: report
it, disarm the loop (or leave it idle — an empty PLAN dispatches nothing
and costs ~0), and ask the user for the next direction. Do not invent
work to keep the loop busy.

## See also

- `garelier-core/references/jig.md` — the deterministic tick (DEC-062)
- `garelier-core/references/role_subagent_dispatch.md` — dispatch procedure
- `garelier-core/references/entry_routing.md` / `model_routing.md`
- `garelier-dock/references/dock-auto-loop.md` — Dock-side tick detail
- `references/runtime/clean-stop.md` §13.2 and
  `references/runtime/cleanup-audit.md` §13.4 — stop phrases, cleanup audit
