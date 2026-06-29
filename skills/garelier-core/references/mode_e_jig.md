# Mode E "Jig" — deterministic dispatch tick (DEC-062, proposed)

Status: **accepted / Phase 1 shipped** — (named "Jig": the workshop fixture that
guides a tool deterministically regardless of the operator's skill; renamed
from "Conductor" 2026-06-11 to avoid collision with other orchestration
projects.)  this reference records the procedure so the
Dock and reviewers share one definition. The jig is **default-on**
(2026-06-11 amendment): an absent `[jig]` block means enabled, and
`enabled = false` is the explicit opt-out;
until then the Mode D prose tick (`role_subagent_dispatch.md` §4) is the
operative procedure and remains the fallback afterwards.

## What it is

Mode E moves the dispatch tick's CONTROL FLOW out of model-interpreted prose
into a deterministic, resumable Workflow script (the *jig*) that
the attended interactive Dock session executes. Models keep the
judgment calls; code keeps the sequencing. All DEC-061 invariants hold:
interactive PM only, in-session subagents / `codex exec` producers only, the
file protocol, Guardian→Observer order, the four human gates, and
explicit-human promote are unchanged.

## The tick (one jig invocation)

1. **OBSERVE** (mechanical): read `runtime/manifest.md`, backlog, role
   STATE files, merge-gate state, `dispatch_hold.md`. No model call.
2. **PLAN** (one bounded model decision): choose which ready backlog items
   to dispatch this tick, within `fan_out_cap`. Prefer items that retire
   an open high/critical risk (blueprint `Kills risk:` / the milestone's
   riskiest unknown — DEC-070 risk-first) over comfort work. Anything
   matching a human gate (protected path, scope expansion, promote,
   ambiguous blocker — DEC-059 detector) is PARKED to PM, never decided.
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
5. **INTEGRATE + RECORD + CLEANUP** (zero-LLM, DEC-083): the mechanical tail
   no longer runs as schema-bearing workflow agents (which recurrently dropped
   their StructuredOutput). After GATE, ONE thin journaled agent runs the
   deterministic `dock_integrate.ts` over all GATED branches: per item, serially
   (single-poller), it `merge_request.sh`s the branch (idempotently — adopts an
   in-flight request keyed on `workbench_branch`, re-detects an already-merged
   tip), AWAITS the terminal result in-process, `dispatch_event`s the outcome
   (+ `questions.md` on non-complete), and `dispatch_cleanup`s on success only.
   `success` = INTEGRATED; `failed/conflict/aborted` = MERGE_FAILED (warm rework
   next tick if a warm producer exists); await timeout = ENQUEUED. Because
   record+cleanup are deterministic, a dropped agent summary loses NOTHING (the
   merge is done + recorded + cleaned — `garelier status` confirms; surfaces as
   `integrateUntracked`). Merge order is DEC-045. The GATE **warm-rework loop**
   (DEC-082 fix-2 — resume the producer's OWN warm worktree with reviewer findings,
   up to `max_rework_rounds`, no cold re-implement) stays in the pipeline, since
   resuming the producer needs the LLM.
6. **SMITH window** (DEC-069): a mechanical check compares the studio tip
   against `runtime/dispatch/last_smith_window`; when ≥
   `smith_batch_every` merges have accumulated, the tick dispatches a
   Smith batch over the whole window (anvil branch, the ordered views in
   the `quality/integration_hardening_views.md` knowledge doc, same
   Guardian→Observer→merge-gate path when it commits fixes). Per-merge
   gates cover each merge alone; the Smith window covers what only shows
   up ACROSS merges. A clean window is a successful pass; the marker
   advances on clean or merged outcomes only.

A crashed or restarted session re-invokes the same script with its resume
journal: completed steps return cached results; nothing double-runs.

## Resilience: agent-death + warm resume (DEC-082)

Long ticks meet two failure modes the gate now handles in-tick rather than
losing or cold-restarting work:

- **Producer death mid-task** (usage/quota limit, crash). A falsy producer
  result is classified `AGENT_DIED` — distinct from `FAILED` — and keeps the
  prior `{dispatchId, branch}`, so the work committed on the **warm worktree
  survives**. It surfaces in a dedicated `agentDied` bucket of the tick result
  with a retry hint (warm-resume if the `_dispatch<id>/checkout` still exists,
  else cold re-dispatch). Never silently folded into `blockedOrParked`.
- **Warm rework, not cold re-implement.** On `NEEDS_REWORK`/`REFUTED`, the GATE
  stage resumes the producer's OWN warm worktree (`produce({kind:'rework',
  findings})`, incremental build) up to `max_rework_rounds`, re-gating each
  round, before escalating. The resume prompt first verifies the checkout still
  exists (returns BLOCKED if it was cleaned up — never fabricates work). A
  re-dispatch from scratch is the fallback, not the default.

These keep the **producer warm worktree as the unit of recovery**: a tick
re-run resumes it warm instead of rebuilding cold, and the await in INTEGRATE
means a quota death during the merge wait still leaves a terminal, inspectable
state (`dock_merge` self-heals a dead gate pid into a synthetic `aborted`).

## Peer (Wanderer) idle-resilience (DEC-082 fix-3)

The Wanderer review path (DEC-076) is best-effort over an external read-only
Codex pane whose hook only fires on a turn boundary. Two bounded mitigations
keep an idle pane from silently stalling a review: `wanderer_drive` RE-SENDS the
file-pointer prompt (≤3×, 20s no-progress windows) to wake a pane that dropped
the first nudge; `wanderer_hook` RE-SURFACES a still-pending request every turn
instead of letting it slip. The reliability floor is unchanged — the PM
await-timeout + automatic Observer fallback after stale-heartbeat/timeout.

## Phase 1 artifacts (shipped)

- `skills/garelier-core/templates/jig_tick.workflow.js` — the tick template
  the Dock substitutes (`{{project_root}}`, `{{pm_id}}`,
  `{{garelier_core_dir}}`, the `[jig]` knobs) and invokes via the Workflow
  tool; LOW/NORMAL depths; CRITICAL items park to PM. Hardened from live
  dispatch runs (2026-06-11/12): producers start via `dispatch_prepare.sh`
  (worktree cut from the STUDIO tip — never the session repo's HEAD; the
  helper also pre-creates the `report.md` scaffold); a PREFLIGHT step
  runs doctor (P0 findings PARK the whole tick — nothing dispatches onto
  a broken install), checks the base is known-green (newest gate
  result = success AND the studio tip is gate-made), warning producers
  otherwise, and runs the context-pack guard (DEC-071): an item whose
  assignment still carries `{{...}}` placeholders is PARKED back to PM
  (an unfinished design never reaches a producer), and a THIN context
  pack (no entry points / invariants / local-verify) dispatches with a
  warning telling the producer to record what it had to rediscover under
  the report's "Context pack gaps" — `retro_digest` aggregates those at
  milestone close so recurring gaps improve the PM's blueprints; producers carry
  a pre-existing-failure protocol (a gate failure that reproduces at the
  base SHA → BLOCKED with evidence, never scope-widening); INTEGRATE
  writes the merge request WITH `guardian_verdict` / `observer_verdict` /
  a non-empty `merge_message` (the mechanical gate rejects requests
  without them); a RECORD phase runs `dispatch_event.sh` (event append +
  in_flight.md view regen, W-011) so the Status Web reflects the tick.
- `skills/garelier-core/scripts/jig_render.{sh,ps1}` — one-command render of the
  tick template for a MANUAL one-off dispatch (the loop renders automatically; this
  is the manual twin). Reads `[jig]` from the project's setup_config (the documented
  defaults above when the block is absent), substitutes the `{{placeholders}}`, writes
  a runnable script under `runtime/jig/`, and prints `{scriptPath, jig, args_schema}`
  so the PM then calls `Workflow({ scriptPath, args: { items: [...] } })`. CLI flags
  (`--fan-out`/`--smith-every`/`--depth-*`/`--out`) override config for a single run.
- `skills/garelier-core/templates/jig_gate_held.workflow.js` — the RESUME
  path: when a producer finishes its work but returns BLOCKED (question /
  pre-existing base failure), its branch survives the tick. After the
  block is resolved (answers.md written, repair merged), this template
  takes the held branches through the same Guardian → refuter → Observer →
  merge gate → record order WITHOUT re-running the producer; pass
  `args.note` so reviewers do not re-block on the already-dispositioned
  context. Proven live (2026-06-12: two held branches gated and merged
  after a base repair). Render it with
  `bash scripts/jig_render.sh --project <root> --pm-id <id> --gate-held`
  (args `{ items: [ { slug, branch, assignmentPath, reportPath } ], note? }`).
  **This is the ONLY role-safe re-gate path** — also the path for a branch the
  PM/Dock had reworked. Its verdicts come from gate-role agents with the
  workflow's death→null→GATE_BLOCKED safety, so a dead/stalled gate agent
  escalates, it never falls to the PM. The PM/Dock therefore never
  hand-dispatches bare Guardian/Observer agents and never verifies the held work
  itself; if this workflow stalls or a gate agent hangs, kill and re-run it
  (fresh gate-role agents), never substitute PM/Dock verification (DEC-090).
- Driver `normalizeJig` parses `[jig]` (defaults off) — see `config.ts`.
- `doctor.sh` emits a P2 advisory when `[jig] enabled = true`.

## Config (opt-in)

```toml
[jig]
enabled = true           # DEFAULT (absent key = true); false = opt out to the prose tick
fan_out_cap = 3          # max producers dispatched per tick
max_rework_rounds = 2    # bounded self-rework before PM escalation
critical_producers = 3   # N-version count for CRITICAL changes
smith_batch_every = 5    # DEC-069: Smith window-hardening due after N merges (0 = disabled)

[jig.review_depth]
low = "gate"             # Guardian + Observer
normal = "gate+refute"   # + adversarial verifier
critical = "nversion"    # N producers + judge panel + gate
```

## Per-seat model routing (Phase 3)

Each seat (producer, refuter, judge, Guardian, Observer) is model-addressable.
Route by judgment density per `model_routing.md`: mid-tier on gated producers,
a strong model on the judge/Guardian seats and on the Dock. This is
how a weaker PM stays safe — the planning model can be modest when the gate
seats are strong and the tick order is code.

## Naming (display strings)

A run's `meta.name` / `meta.description` / phase titles / agent labels follow
`references/workflow-naming.md`, so one run reads identically across
`/workflows`, the dispatch board, `events.jsonl`, and the branch. In short:
`meta.name = ga-<op>` (`ga-tick` / `ga-gate` / `ga-smith`); phase titles are the
Status Web Pipeline stages; an agent label is `<step>:<slug>` carrying the
board/branch slug.

## Boundaries

- The jig never auto-decides a human gate, never merges to `<target>`,
  never pushes, and never runs headless — it executes inside the attended
  session like any dispatch work.
- If the script itself fails mid-tick, the Dock falls back to the
  Mode D prose tick for that cycle and reports the failure to PM.
- A gate verdict is a gate-role artifact. The PM/Dock never produces a
  Guardian/Observer verdict and never performs the gate verification (running
  the validators/tests, or reviewing the diff as the gate) in place of a gate
  agent. A held or reworked branch is re-gated via `jig_gate_held` (above); a
  stalled or missing gate is recovered by re-running the gate workflow with
  fresh gate-role agents, or escalated to PM as a DECISION — never by PM/Dock
  verification. `doctor.sh` flags a runtime gate report that reads as
  PM-performed (DEC-090).

See the project DEC-062 record for rationale, phases, and risks.
