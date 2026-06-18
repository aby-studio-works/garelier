# Garelier PM Autonomous Mode Reference

The autonomous layer for **dispatch-only** Garelier (DEC-057/059/061/066):
one attended interactive PM session + a self-pacing Dock auto-loop whose
producers are in-session subagents (or `codex exec` subprocesses, DEC-058)
and whose tick runs as code via the jig (Mode E, DEC-062 — default-on).
There is no headless PM and no headless driver; the former Mode B was
deleted outright (DEC-066 — history lives in the decision records).

Section numbers are stable (§15.x) because other documents cite them.

## §15. Autonomous mode

### 15.1 The `[autonomy]` block

Read it from `__garelier/<pm_id>/_pm/setup_config.toml`. Absence of the
section is equivalent to `enabled = false` (the loop is opt-in; one-off
dispatches need no `[autonomy]` at all).

```toml
[autonomy]
enabled = false                  # arm the self-pacing Dock auto-loop (opt-in)
auto_approve_blueprints = false  # PM commits blueprint drafts without user review
auto_approve_milestones = false  # PM updates milestones without confirmation
fan_out_cap = 3                  # max parallel producer subagents per tick
protected_paths = ["core/engine/**", "Cargo.toml", ".github/**", "infra/**", "migrations/**"]
```

The tick mechanics (fan-out, gates, merge, record) are configured by the
`[jig]` block (`garelier-core/references/mode_e_jig.md`); `[autonomy]`
governs WHEN the loop runs and what PM may auto-approve.

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
   order is code; PLAN (which ready items to dispatch, within
   `fan_out_cap`) is the only model decision. PLAN prefers items that
   retire an open high/critical risk (blueprint `Kills risk:` / the
   milestone's riskiest unknown — DEC-070 risk-first) over comfort work;
   the control graph's `risk-first-drift` advisory flags drift.
2. Resume after BLOCKED: when a producer finishes but blocks (question /
   pre-existing base failure), resolve the block (answers.md / repair
   task), then run `garelier-core/templates/jig_gate_held.workflow.js` to
   gate + merge the held branches without re-running the producer.
3. Fallback (`[jig] enabled = false`): the prose tick in
   `garelier-core/references/role_subagent_dispatch.md` §4 /
   `garelier-dock/references/mode-d-tick.md`.
4. Self-pacing: drive ticks with the built-in `/loop` (no fixed interval);
   the Dock idles at ~0 tokens between ticks (DEC-049).
5. Anything matching a hard gate is PARKED (ESC note + pm/inbox +
   dispatch_hold) — never auto-decided.

### 15.5 Enabling

1. Confirm the quality gate commands are real (`[quality_gate]`).
2. Set `[autonomy] enabled = true` (+ chosen auto_approve flags,
   `fan_out_cap`, `protected_paths` tuned to the target).
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

- `skills/garelier-core/scripts/status.{sh,ps1}` — lane, merge gate,
  backlog counts, LIVE `_dispatch<N>` producers, parked inventory, recent
  events.
- The Status Web Dashboard (Dispatch activity + Live work board).
- Raw truths: `runtime/dispatch/events.jsonl`,
  `runtime/merge_gate/{requests,results,locks}/`, `_dispatch<N>/STATE.md`.

### 15.9 When the roadmap is finished

When every milestone is shipped and the backlog has no ready rows: report
it, disarm the loop (or leave it idle — an empty PLAN dispatches nothing
and costs ~0), and ask the user for the next direction. Do not invent
work to keep the loop busy.

## See also

- `garelier-core/references/mode_e_jig.md` — the deterministic tick (DEC-062)
- `garelier-core/references/role_subagent_dispatch.md` — dispatch procedure
- `garelier-core/references/entry_routing.md` / `model_routing.md`
- `garelier-dock/references/mode-d-tick.md` — Dock-side tick detail
- `references/history-and-operations.md` §13.2/§13.4 — stop phrases, cleanup audit
