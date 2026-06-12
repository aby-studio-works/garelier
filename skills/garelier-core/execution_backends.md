<!-- EXACT MIRROR: skills/garelier-core/execution_backends.md == docs/execution_backends.md
     (byte-identical; enforced by scripts/check_doc_sync.ts). Edit both together. -->

# Execution & token efficiency

How role iterations are **executed**, and how to do more useful work per unit
of capacity at a fixed model.

> **Provider terms and billing are the operator's responsibility.** Garelier
> does not certify any configuration as "ToS-clean", makes no claim about which
> plan, credit, or API budget a provider bills for any execution mode, and
> ships no billing-related feature. See the **Billing & ToS** note in
> `concepts.md`.

## The execution model: dispatch (DEC-057/061/066)

Garelier has ONE execution substrate. A user-attended **interactive
orchestrator** session (PM in the artisan lane, Dock in the dock lane)
delegates each role's assignment to a **subagent** — the Agent tool (one
role) or the Workflow tool (parallel) — request → run-to-completion → return —
then integrates the returned branches through Guardian → Observer → the merge
gate. A Codex/pool role runs the same way via a `codex exec` subprocess
(DEC-058). There is no idle bay to wake, so no wake mechanism and no deadlock.
The former headless per-iteration driver (`claude -p` / `codex exec`, "Mode B")
was deleted outright under DEC-066; its history lives in the decision records,
not here.

- **Producers** run in isolated worktrees cut from the studio tip
  (`scripts/dispatch_prepare.{sh,ps1}` does the bookkeeping — id claim,
  branch family, worktree, visibility events), implement, run the quality
  gate, commit, and return a compact result.
- **The jig (Mode E, DEC-062 — default-on)** runs the tick as a deterministic
  Workflow script: DISPATCH → GATE (Guardian→Observer, code-enforced order) →
  INTEGRATE (`scripts/merge_request.{sh,ps1}` + the zero-LLM merge gate) →
  RECORD (events for the Status Web). `[jig] enabled = false` opts out to the
  prose tick (`references/role_subagent_dispatch.md`).
- **Model routing**: pick the model per seat by judgment density
  (`references/model_routing.md`) — strong on PM/Dock/Guardian/judge seats,
  mid-tier on gated producers.

## Token efficiency (fixed model)

The optimization axis is doing more useful work per unit of capacity, model
held constant:

- **Prompt cache.** Keep the large stable prefix (role SKILL.md + CLAUDE.md +
  AGENTS.md + the fixed directive) byte-stable and first, so server-side cache
  reads absorb the fixed per-iteration overhead.
- **Context diet (DEC-049).** Reference reports/diffs by path + compact JSON
  sidecars instead of inlining bodies; coordinators triage from bounded
  summaries. Subagents run only on real work; the orchestrator idles at ~0
  tokens between turns.
- **Visibility.** Dispatch progress is visible on the Status Web (Dispatch
  activity panel + Live work board) and `status.{sh,ps1}`; producer start /
  completion / gate / merge events append to `runtime/dispatch/events.jsonl`
  via one command — `scripts/dispatch_event.{sh,ps1}` — which also
  regenerates the `backlog/in_flight.md` derived view (W-011, DEC-064 §3).

## Not built (roadmap)

- A capacity governor (reset-time parse / pause-until-reset) — stopping when
  the provider's usage limit is reached is accepted instead.
- A budget governor — credit/API is optional, not the design center.
