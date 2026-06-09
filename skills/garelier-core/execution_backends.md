<!-- EXACT MIRROR: skills/garelier-core/execution_backends.md == docs/execution_backends.md
     (byte-identical; enforced by scripts/check_doc_sync.ts). Edit both together. -->

# Execution backends & token efficiency

> **DEC-061 — dispatch-only.** Garelier runs roles via **dispatch**: the
> interactive PM/Dock session dispatches each role as an in-session subagent
> (Agent/Workflow tool), or a `codex exec` subprocess for a Codex/pool role
> (DEC-057/058). The headless `claude -p` / `codex exec` per-iteration **driver**
> (Mode B, the `[execution] backend` axis) is **DISABLED**:
> `start_driver.{sh,ps1}` and the driver entrypoint refuse to launch. The driver
> material below is kept as historical context; the `backend` selector no longer
> governs how Garelier runs.

How each role iteration is **executed**, and how to do more useful work per unit
of capacity at a fixed model.

> **Provider terms and billing are the operator's responsibility.** Garelier does
> not certify any configuration as "ToS-clean", makes no claim about which plan,
> credit, or API budget a provider bills for any execution mode, and ships no
> billing-related feature. Which provider, plan, and mode you use — and compliance
> with that provider's current terms — is your choice. See the **Billing & ToS**
> note in `concepts.md`.

## Two execution substrates

Garelier has two ways to execute a role iteration:

- **Dispatch (Mode D, DEC-057/058) — the default and only live substrate.** A
  long-running **interactive orchestrator** session (PM in the artisan lane, Dock
  in the dock lane) delegates each role's assignment to a **subagent** — the Agent
  tool (one role) or the Workflow tool (parallel) — request → run-to-completion →
  return — then integrates the returned branches. There is no idle bay to wake, so
  no wake mechanism and no deadlock. A Codex/pool role runs the same way via a
  `codex exec` subprocess.
- **Headless driver (Mode B) — disabled (DEC-061), retained as history.** A
  per-iteration `claude -p` / `codex exec` cold-start driver. It is no longer run;
  the `backend` axis below configured how it ran and is kept for reference only.

## Driver backends (`[execution] backend`) — historical, disabled

The `backend` axis selected how the (now disabled) headless driver ran each role
iteration:

| backend | what it ran |
| --- | --- |
| `headless` | `claude -p` cold-start per iteration |
| `codex` | `codex exec` per iteration |

New setups ship `backend = "headless"` and an absent `[execution]` section
defaults to `headless` for the driver (backward compatibility), but per DEC-061
the driver does not run regardless of this value.

## Dispatch mode (subagent orchestrator, DEC-057)

- **Entry stays control-project / control-library / PM.** The orchestrator IS the
  PM/Dock session; it spawns producer/reviewer subagents (1-level nesting). No
  terminal bays, no `~/.claude/agents` files — the role is the existing
  `garelier-<role>` skill (multi-project safe; removable with `__garelier/`).
  (Procedure: `references/role_subagent_dispatch.md`. Supersedes the DEC-052
  watching-bay substrate, which the first live spike showed unreliable, and the
  DEC-042 `claude-dispatch` PTY backend, which was removed.)
- **Producers** run with `isolation: worktree` (a `workbench` / `anvil` / `shelf`
  / `satchel` branch off `studio`), implement, run the quality gate, commit, and
  return a compact result (branch + SHA + report path).
- **Integrate.** The orchestrator (Dock) sends returned branches through Guardian
  → Observer review subagents, then runs the merge gate (`dock_merge.ts poll`, a
  zero-LLM mechanical subprocess) into `studio` (DEC-045 order); Smith hardens.
- **Token discipline (DEC-049).** Subagents run only on real work; the
  orchestrator idles at ~0 tokens (no polling); results return as compact values
  + file refs (never inlined bodies).

## Token efficiency (fixed model)

The optimization axis is doing more useful work per unit of capacity, model held
constant:

- **Prompt cache.** The large stable prefix (role SKILL.md + CLAUDE.md +
  AGENTS.md + the fixed directive) is kept byte-stable and first so server-side
  cache reads (0.1×) absorb the fixed per-iteration overhead. Same-role
  iterations within the cache TTL hit it.
- **Context diet (DEC-049).** Per-iteration prompts reference reports/diffs by
  path + compact JSON sidecars instead of inlining bodies; coordinators triage
  from a bounded role-status summary.
- **Wasteful-iteration hygiene.** Interest-file gating + the no-op / `coord_only`
  rules suppress empty runs.
- **Visibility.** The Status Web **Efficiency** panel (and `/api/efficiency`)
  shows tokens/iteration, cache-hit ratio, per-role token/cost, and the
  action-kind mix from `runtime/driver/usage/*.jsonl` — so you can see where
  tokens go and target them, at your fixed model.

## Not built (roadmap)

- A capacity governor (reset-time parse / pause-until-reset) — stopping when the
  provider's usage limit is reached is accepted instead.
- A budget governor — credit/API is optional, not the design center.
