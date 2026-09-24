# Model routing governance

Garelier is provider-neutral. Model and effort are decisions made by the user
and PM for the project and task; the framework records and forwards those
decisions. It does not silently lower a requested model or require confirmation
before dispatch. Gate verdicts have a separate quality recommendation: an
explicit light-tier flag is forwarded unchanged with one policy warning.

Concrete model ids live in ONE place: the per-provider tier table
`[model_routing.tiers.<provider>]` in the project's `setup_config.toml`
(W-846). This reference, the other runbooks, and the driver name tiers
(`light` / `mid` / `strong`) and point at that table; they do not name models.
A model generation change is a table edit, never a code change.

The former above-PM ceiling was removed by the 2026-08-11 user decision. It
could silently downgrade a task even when the PM deliberately requested a
higher model, which directly lowers quality. A safety mechanism must surface
risk, not replace an explicit PM judgment with a weaker model.

## The four governance layers

### 1. Indicators are recommendations

The routing indicators recommend a model and effort; they are not a mechanical
clamp. Start with one question: can the task file state the shape of the answer
well enough that implementation is the main work? If yes, it is a bounded
role task. If exploration, adjudication, or falsification is the main work,
choose a higher model.

| Task shape | Recommended model / effort | Why |
| --- | --- | --- |
| Fully specified mechanical change | light / low–medium | The answer is already constrained by the task. |
| Bounded implementation with a clear blueprint | mid / high | Implementation judgment remains, but the task is reviewable and gated. |
| Cross-module implementation, root-cause debugging, validator or gate work | strong / high | The answer must be discovered or defended, not merely applied. |
| Architecture, determinism/concurrency, security-sensitive change | strong / xhigh | A wrong judgment has broad or hard-to-reverse impact. |
| Guardian, Observer, or judge review | strong / task-appropriate | These seats test or arbitrate another result. |

The built-in rules (`engine_LARGE`, risk tags, rework, and task type) are also
indicators used only when a task leaves model selection open. They never
override a flag or blueprint hint.

#### Gate quality floor — standing policy 2026-07-16

The PM applies this standing doctrine: never use a light-tier model for a
Guardian, Observer, or judge verdict. A machine-resolved gate route that would
land on a light-tier model uses the mid tier of the same provider's table. An
explicit light-tier gate flag is forwarded verbatim and emits one stderr warning
naming the 2026-07-16 doctrine. The framework neither raises nor blocks that
explicit selection; the PM remains the sole selection authority.

The light-tier two-condition policy from the 2026-07-16 user ruling permits a
role only when both conditions hold:

1. the task is genuinely judgment-zero (a uniform rename, specified conversion,
   or equivalent mechanical work); and
2. the PM can review the output and the Guardian and Observer are not weaker.

A light-tier role is reviewed by mid-tier-or-stronger Guardian and Observer. One
judgment-derived REWORK proves that task class was not judgment-zero and promotes
it to the mid tier or stronger for the next attempt.

A security-tier dispatch (`gate_plan.gate_model_floor = "strong"`) floors both
gate seat models at the strong tier of `[model_routing.tiers.claude-code]` (the
gate seats' Agent-tool vocabulary). Without that table the dispatch is refused;
there is no built-in strong model.

### 2. Escalate from recurring evidence

Repeated failure of the same task class overrides the indicator. First raise
effort, then raise the model when the failure is still judgment-related. Record
the evidence in the task or project control record so the next PM decision is
informed by the recurrence rather than a guess. Mechanical follow-up work to a
reviewed design may de-escalate again.

### 3. User–PM agreement is the project policy layer

Each project’s user and PM agree which providers, models, and efforts they are
willing to use. `setup_config.toml` may record the agreed model and effort
ranges. This is an auditable agreement, not a clamp: an explicit task flag
outside the recorded range is dispatched verbatim and produces one stderr
warning from `dispatch_prepare.ts`.

```toml
[model_routing]
rules.on = true

# The one seat for concrete model ids: tier -> model id, one table per
# `--provider` value. Both tables and all three tiers are required.
[model_routing.tiers.claude-code]
strong = "<model id>"
mid = "<model id>"
light = "<model id>"

[model_routing.tiers.codex]
strong = "<model id>"
mid = "<model id>"
light = "<model id>"

[model_routing.agreement]
models = ["<model id>", "<model id>"]
efforts = ["low", "medium", "high", "xhigh"]

[model_routing.seats]
worker = "mid"
guardian = "strong"
```

The table is validated when it is read and a defect refuses the read instead
of falling back to anything: a missing `[model_routing.tiers]` while
`[model_routing]` is present, a missing provider table or tier, an unknown
provider or tier key, one id declared under two providers, and the retired
flat form (`tiers.strong = "<id>"` directly under `[model_routing]`) are each
named. `model_routing.ts` exits 3 with `REFUSED` and `dispatch_prepare.ts`
refuses the dispatch before any claim, branch, or worktree exists.

The same id may fill several tiers of one provider (for example, mid and light
both naming one model). An id's rank is the HIGHEST tier it fills, so rank
comparisons and the gate floor read the table, not the spelling of the id.

The obsolete `above_pm` key is accepted and ignored for configuration
compatibility. Do not add it to new configuration.

### 4. Framework initial value

Without a recorded project agreement, the framework uses its ordinary indicator
defaults. If neither a task flag, blueprint hint, nor indicator supplies a
model, the model is inherited from the PM’s current AI.

Provider selection remains task authority — role metadata and config never
choose one, and `--provider` is always honoured verbatim. What the framework
supplies is the OMISSION case: a fresh dispatch that names no provider resolves
to **`claude-code`**, and `codex` requires the explicit `--provider codex` flag
(W-690, user ruling 2026-09-05 retiring codex operation). The dispatch record
keeps the two distinguishable — `ready.json.provider_source` is `task-flag` when
the PM named the provider and `framework-default` when the default filled it in
— so a defaulted provider is never reported as a task decision. Reuse, rework
and recovery are unaffected: they derive the provider from the canonical
producer binding and are never defaulted into a substitution.

Model and effort use the resolution below; the provider default supplies
NEITHER. A recorded Claude dispatch still refuses without an explicit model and
a non-empty effort.

## Resolution and forwarding contract

Resolution order is:

1. explicit `--model` / `--effort` flag;
2. blueprint `Model-hint:` / `Effort-hint:`;
3. indicator default within the recorded agreement;
4. the PM’s current AI.

`--model` is always forwarded verbatim, including a value outside the recorded
agreement and on a gate seat. The resolver reports `source: "flag"`; it does
not rank, clamp, suggest a replacement, or ask for confirmation. An explicit
gate flag never emits `gate_weaker_than_role`; a light-tier gate flag's
gate-quality advisory is the 2026-07-16 doctrine warning only. Agreement-range
warnings, when applicable, remain separate. The Codex provider adapter preserves
every explicit flag verbatim.

An unfilled blueprint placeholder is ignored. With no `[model_routing]`
section, indicators are off for compatibility and the final inheritance step
applies; no tier table exists, so nothing can be ranked, translated to Codex,
or floored (see below). A provider is resolved separately from model routing:
`dispatch_prepare.ts` passes the dispatch provider as `--provider`, and a
tier-based route reads that provider's table. The CLI's `--provider` omission
default is `claude-code`, the same omission rule as a fresh dispatch.

The resolver emits one JSON line:

```json
{"model":"<model id>","effort":"high","source":"flag","seat":"worker","warnings":[]}
```

`warnings` can include `flag_outside_agreed_model_range`,
`flag_outside_agreed_effort_range`, `gate_flag_below_recommended_floor`,
`gate_weaker_than_role`, `gate_below_mid`, or `model_not_in_tier_table`.
Warnings are advisory only. `model_not_in_tier_table` names a gate-seat model
that no `[model_routing.tiers.<provider>]` row lists: its rank is unknown, so
the gate floor and the weaker-than-role comparison cannot apply, and the
resolver says so instead of treating the unknown rank as acceptable.
`dispatch_prepare.ts` emits one stderr warning for an agreement-range warning,
for a light-tier gate flag (the 2026-07-16 doctrine), or naming a gate-seat
model absent from the table; it then continues with the verbatim flag.

## Codex translation and availability

For a Codex dispatch the adapter reads the same tier table. A non-flag model
is handled by where the table lists it:

| Non-flag model | Codex execution model | Source suffix |
| --- | --- | --- |
| an id in `[model_routing.tiers.codex]` | unchanged | `adapter:codex-preserved` |
| an id in another provider's table | the codex id of the SAME tier (the id's highest tier) | `adapter:codex-canonical-<tier>` |
| an id in no table, or no table at all | blocked, `cannot be translated to Codex` | `adapter:block-untranslatable` |

This also describes the PM-default edge case. With no `[model_routing]`
section a PM model produces `source: "pm-default"`, no table exists, and a
Codex dispatch is blocked. A PM model the table does not list (for
example, `fable`) blocks the Codex route with an explicit
`cannot be translated to Codex` error; it is not silently mapped to another
model. An explicit provider-model flag remains a caller-owned availability
assertion and is forwarded verbatim; a light gate flag receives only the
advisory doctrine warning above.

Availability is checked against the Codex CLI's own model list, not against a
hand-maintained one. Before a Codex dispatch creates anything,
`dispatch_prepare.ts` reads `models_cache.json` under `$CODEX_HOME` (default
`~/.codex`) and refuses when any `[model_routing.tiers.codex]` id is absent from
its `models[].slug`, or when the file cannot be read. The retired
`[runner] codex_advertised_models` list is refused by name; `ready.json`'s
`codex_advertised_models` now carries the cache's slugs. The driver never
performs a network availability probe. `codex models` needs a TTY, so to probe
an id by hand run `codex exec --model <id> --skip-git-repo-check "Reply OK"` in a
scratch directory.

The Codex launcher (`dispatch_provider.ts --model`) accepts the tier names
`light` / `mid` / `strong` as aliases and resolves them through
`[model_routing.tiers.codex]`; any other bare alphabetic token is refused as an
unknown alias. Full ids pass through unchanged.

A tier whose model is provisional (a value the user has not ruled on) is marked
in the table's own comment. Changing it is that one line; no reference,
runbook, or driver change follows.

## Operational use

`dispatch_prepare.ts` resolves before creating the role authorization and
records the result in `context.json`. Gate routes resolve their own indicator
default in the same way. The caller must pass the resolved model to the provider
launch; a role never re-routes its own running model.

### How effort reaches the seat, per transport (W-667 F-9)

Effort is resolved once and carried differently, because the transports do not
accept it the same way. Reading the resolution as though it always applied is
what made an `xhigh` dispatch behave like an unrouted one.

| Transport | How effort is applied | What the emitted artifact carries |
| --- | --- | --- |
| `codex exec` | native `--effort <value>` on the launch command; a resume replays it as `--expected-effort` and a mismatch fails closed | `launch_cmd` |
| Claude recorded subprocess (`claude-subprocess`) | the recorded launch pins model and a non-empty effort; both are required | `launch_cmd`, `context.json` |
| Attended Agent (`attended-agent`) | **no effort argument exists** — the Agent tool takes a model and nothing else, so nothing is applied mechanically. The resolved effort is written as the first line of `lane/prompt.md` and the seat is expected to work at it | `lane/prompt.md`, `context.json` |

The resolved effort is recorded in `context.json` for every transport, so the
workflow can report and audit it regardless of how it was applied.

Cross-references: `role_subagent_dispatch.md`, `jig.md`, and
`attended-gate-dispatch.md`.
