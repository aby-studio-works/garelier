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
   (single-poller), it `merge_request.ts`s the branch (idempotently — adopts an
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

## Stall-scan vs. build-wait (W-034)

Every tick's Dispatch phase runs a mechanical `preflight:stall-scan` step
(`contract_check.ts --stall-scan`, unconditional — including a 0-item
Smith-window-only tick) before dispatching, so a `WORKING` `_dispatch<N>/`
container left behind by a crashed/aborted prior session is caught on the
next invocation instead of sitting silent. Only `judgement="stall-suspect"`
items surface, as the tick result's `stallSuspects` field — a still-running
cold build (`build-wait`) or an unverifiable platform probe (`unknown`) are
expected per-tick noise and stay silent. See `role_subagent_dispatch.md` §3
for the false-positive lesson (W-053) behind the build-wait/stall-suspect
split, and the Build-stall prevention section below for the related DEC-091
heuristics it is scoped from.

**Escalation across ticks (W-037).** A single tick's scan cannot tell "just
went WORKING" from "has been stall-suspect for 25 minutes with nobody
watching" — `contract_check.ts` closes that gap itself by persisting a
per-dispatch judgement history (`runtime/dispatch/stall_scan_history.json`,
gitignored) across invocations. A dispatch that stays `stall-suspect` with an
UNCHANGED checkout diff (same `git status --porcelain` hash) across scans
steps its `escalation` field `none` → `nudge` (continuous >= 10 min, default;
`--nudge-after <N>`) → `handoff` (continuous >= 25 min, default;
`--handoff-after <M>`), the latter carrying the same respawn-handoff prompt
`--handoff <N>` produces. Real progress (the diff moves) or a judgement change
away from `stall-suspect` (build-wait/unknown) resets the clock. This closes
the exact gap the design record behind W-037 found live (target-project W-058/W-055,
2026-07-03): a producer backgrounded its gate against the foreground
instruction (DEC-073) and orphaned mid-WORKING with no automated escalation —
a normative instruction alone did not stop it, so detection had to.
`jig_tick.workflow.js`'s Dispatch-phase log surfaces `escalation: nudge=N
handoff=M` counts alongside the stall-suspect list once either is nonzero.

## Build-stall prevention (DEC-091)

A sub-agent (producer, gate, preflight) is run-to-completion: a command it
*backgrounds* does NOT re-invoke it on completion, so a sub-agent that detaches a
long build and ends its turn **stalls** — it is never re-woken (DEC-073 Part A).
The foreground limit is ~10 min, and a cold full-project build of a heavy
dependency graph can exceed it — the trap that strands a producer. **Prevent it,
don't just detect it:**

- **Warm the cache from the MAIN session before dispatch.** The PM/operator runs
  the project build once from the attended (main) session — which IS re-invoked on
  background completion, so it is stall-immune — before launching a producer
  dispatch on a cold cache (fresh clone, long idle, or a merge touching heavy
  shared components). With a warm build cache, every producer gate build is
  incremental and fits the foreground limit. (Live: a cold producer build detached
  + stalled at ~16 min; the same build warm finished in the foreground in ~9.5 min.)
- **Scope the producer self-gate to the touched components** — the project's
  per-package / per-module check / test / lint for what changed — never a
  full-project build. The comprehensive whole-project build is the **merge gate's**
  job and runs from the main session (stall-immune). This structurally keeps
  producer commands under the foreground limit. (Concrete commands come from the
  project's `[quality_gate]` config; this guidance is language-neutral.)
- **If a scoped gate still cannot fit the foreground limit on a warm cache, the
  producer BLOCKs** (`gate exceeds foreground budget — needs a warm cache`); it
  does NOT detach-and-idle. The PM warms the cache from main and re-dispatches the
  producer warm. A clean BLOCK is recoverable; a detach-and-idle is a silent stall.
- **Backstop (defense-in-depth, not the primary):** after dispatching a heavy
  producer the operator may run `driver/src/scripts/dispatch_watch.ts --project <root>
  --pm-id <id> --id <N>` in the background (main session) — it polls the producer's
  branch + compile activity and exits with `PROGRESS` / `STALLED` / `BUILDING`, so a
  stall is caught actively rather than on the next user prompt; on `STALLED` the
  operator warm-resumes or re-dispatches. `doctor.ts` also flags a
  `stranded-producer` (a WORKING dispatch with uncommitted work and no live
  compile). These only catch a stall the preventive measures let through.

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
  dispatch runs (2026-06-11/12): producers start via `dispatch_prepare.ts`
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
  without them); a RECORD phase runs `dispatch_event.ts` (event append +
  in_flight.md view regen, W-011) so the Status Web reflects the tick.
- `skills/garelier-core/driver/src/scripts/jig_render.ts` — one-command render of the
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
  `bun driver/src/scripts/jig_render.ts --project <root> --pm-id <id> --gate-held`
  (args `{ items: [ { slug, branch, assignmentPath, reportPath } ], note? }`).
  **This is the ONLY role-safe re-gate path** — also the path for a branch the
  PM/Dock had reworked. Its verdicts come from gate-role agents with the
  workflow's death→null→GATE_BLOCKED safety, so a dead/stalled gate agent
  escalates, it never falls to the PM. The PM/Dock therefore never
  hand-dispatches bare Guardian/Observer agents and never verifies the held work
  itself; if this workflow stalls or a gate agent hangs, kill and re-run it
  (fresh gate-role agents), never substitute PM/Dock verification (DEC-090).
- Driver `normalizeJig` parses `[jig]` (defaults off) — see `config.ts`.
- `doctor.ts` emits a P2 advisory when `[jig] enabled = true`.

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

## Attended-parity integration (W-033)

The attended-mode reliability features (W-022 contract check, W-025 agent naming,
W-026 model routing, W-023 preflight) are wired into the jig templates so a jig
run is at least as reliable as hand-driven dispatch — adopting the jig never
regresses to below the attended path:

- **Routing on producers (W-025/W-026).** Each item's DISPATCH now runs a
  mechanical `prepare:<slug>` step (`dispatch_prepare.ts`) BEFORE the `produce`
  agent, then applies the emitted `model`/`effort` to the produce `agent()` opts
  (`model` is already PM-ceiling-clamped, so this unattended path uses it
  verbatim; `needs_confirmation` is only logged — the jig never auto-escalates
  above the PM model). The `produce:<slug>` label is taken from `dispatch_prepare`
  verbatim, keeping board / branch / events aligned. Producing a routed model
  requires this order: a produce agent cannot re-route its own running model.
- **Routing on gates (W-026).** A per-run `preflight:gate-routing` step resolves
  the Guardian / Observer / refuter (judge-tier) models once (they are
  item-independent — forced to `strong`) and every gate `agent()` spreads the
  resolved `{model, effort}`. No `[model_routing]` section ⇒ inherit (back-compat).
- **Contract check (W-022).** When a producer returns REPORTING, a mechanical
  `contract:<slug>` step (`contract_check.ts --dispatch`) verifies it actually
  committed, closed STATE, and overwrote the report scaffold BEFORE gating. A
  violation with a warm producer feeds the ready-made nudge back as a warm-rework
  round (bounded by `max_rework_rounds`); otherwise it falls through to the gate,
  which BLOCKs on the real gap — it never silently passes. (Gate-role verdicts in
  the jig are structured return values, not files, so `contract_check --gate` is
  the attended path only.)
- **Preflight (W-023).** The merge paths pick up `[merge_gate] preflight_commands`
  from config via `merge_request.ts` (fallback mirrors the quality-gate one), so
  both the main tick (through `dock_integrate.ts`) and the Smith window get the
  fail-fast preflight without threading a flag; `merge-gate.ts` itself is
  untouched. Absent config ⇒ no preflight step (unchanged behavior).

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
  verification. `doctor.ts` flags a runtime gate report that reads as
  PM-performed (DEC-090).

See the project DEC-062 record for rationale, phases, and risks.
