# Mode E "Jig" — deterministic dispatch tick (DEC-062, proposed)

Status: **accepted / Phase 1 shipped** — (named "Jig": the workshop fixture that
guides a tool deterministically regardless of the operator's skill; renamed
from "Conductor" 2026-06-11 to avoid collision with other orchestration
projects.)  this reference records the procedure so the
orchestrator and reviewers share one definition. The jig is **default-on**
(2026-06-11 amendment): an absent `[jig]` block means enabled, and
`enabled = false` is the explicit opt-out;
until then the Mode D prose tick (`role_subagent_dispatch.md` §4) is the
operative procedure and remains the fallback afterwards.

## What it is

Mode E moves the dispatch tick's CONTROL FLOW out of model-interpreted prose
into a deterministic, resumable Workflow script (the *jig*) that
the attended interactive orchestrator session executes. Models keep the
judgment calls; code keeps the sequencing. All DEC-061 invariants hold:
interactive PM only, in-session subagents / `codex exec` producers only, the
file protocol, Guardian→Observer order, the four human gates, and
explicit-human promote are unchanged.

## The tick (one jig invocation)

1. **OBSERVE** (mechanical): read `runtime/manifest.md`, backlog, role
   STATE files, merge-gate state, `dispatch_hold.md`. No model call.
2. **PLAN** (one bounded model decision): choose which ready backlog items
   to dispatch this tick, within `fan_out_cap`. Anything matching a human
   gate (protected path, scope expansion, promote, ambiguous blocker —
   DEC-059 detector) is PARKED to PM, never decided.
3. **DISPATCH** (code): producers run as worktree-isolated subagents on
   their `workbench`/`anvil`/`shelf` branches, or `codex exec` subprocesses
   (DEC-058), run-to-completion. The script enforces the cap and records a
   `dispatch` event per seat.
4. **GATE** (code-enforced order): Guardian subagent, then Observer
   subagent. Review depth scales with the change's declared criticality:
   - LOW — Guardian + Observer once.
   - NORMAL — plus one adversarial verifier prompted to REFUTE the
     producer's report (kill on refute).
   - CRITICAL — `critical_producers` independent producers in parallel
     worktrees → judge panel selects/synthesizes → full gate path.
5. **INTEGRATE** (zero-LLM): `dock_merge.ts poll` merges passing branches
   into `studio` (DEC-045 order).
6. **RECORD** (mechanical): one `dispatch_event.{sh,ps1}` command appends
   the event to `runtime/dispatch/events.jsonl` (the append-only single
   source, DEC-064 §3) and regenerates the `backlog/in_flight.md` derived
   view; write verdict artifacts. REWORK loops the same producer at most
   `max_rework_rounds` times, then escalates to PM.

A crashed or restarted session re-invokes the same script with its resume
journal: completed steps return cached results; nothing double-runs.

## Phase 1 artifacts (shipped)

- `skills/garelier-core/templates/jig_tick.workflow.js` — the tick template
  the orchestrator substitutes (`{{project_root}}`, `{{pm_id}}`,
  `{{garelier_core_dir}}`, the `[jig]` knobs) and invokes via the Workflow
  tool; LOW/NORMAL depths; CRITICAL items park to PM. Hardened from live
  dispatch runs (2026-06-11): producers start via `dispatch_prepare.sh`
  (worktree cut from the STUDIO tip — never the session repo's HEAD);
  INTEGRATE writes the merge request WITH `guardian_verdict` /
  `observer_verdict` / a non-empty `merge_message` (the mechanical gate
  rejects requests without them); a RECORD phase runs
  `dispatch_event.sh` (event append + in_flight.md view regen, W-011) so
  the Status Web reflects the tick.
- Driver `normalizeJig` parses `[jig]` (defaults off) — see `config.ts`.
- `doctor.{sh,ps1}` emit a P2 advisory when `[jig] enabled = true`.

## Config (opt-in)

```toml
[jig]
enabled = true           # DEFAULT (absent key = true); false = opt out to the prose tick
fan_out_cap = 3          # max producers dispatched per tick
max_rework_rounds = 2    # bounded self-rework before PM escalation
critical_producers = 3   # N-version count for CRITICAL changes

[jig.review_depth]
low = "gate"             # Guardian + Observer
normal = "gate+refute"   # + adversarial verifier
critical = "nversion"    # N producers + judge panel + gate
```

## Per-seat model routing (Phase 3)

Each seat (producer, refuter, judge, Guardian, Observer) is model-addressable.
Route by judgment density per `model_routing.md`: mid-tier on gated producers,
a strong model on the judge/Guardian seats and on the orchestrator. This is
how a weaker PM stays safe — the planning model can be modest when the gate
seats are strong and the tick order is code.

## Boundaries

- The jig never auto-decides a human gate, never merges to `<target>`,
  never pushes, and never runs headless — it executes inside the attended
  session like any dispatch work.
- If the script itself fails mid-tick, the orchestrator falls back to the
  Mode D prose tick for that cycle and reports the failure to PM.

See the project DEC-062 record for rationale, phases, and risks.
