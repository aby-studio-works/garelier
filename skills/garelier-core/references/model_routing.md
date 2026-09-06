# Model routing governance

Garelier is provider-neutral. Model and effort are decisions made by the user
and PM for the project and task; the framework records and forwards those
decisions. It does not silently lower a requested model or require confirmation
before dispatch. Gate verdicts have a separate quality recommendation: an
explicit Luna/haiku-class flag is forwarded unchanged with one policy warning.

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

The PM applies this standing doctrine: never use Luna for a Guardian, Observer,
or judge verdict. A machine-resolved gate route that would land on a light tier
uses the configured mid tier (or `sonnet` if that configured value is also
light). An explicit light-tier gate flag is forwarded verbatim and emits one
stderr warning naming the 2026-07-16 doctrine. The framework neither raises nor
blocks that explicit selection; the PM remains the sole selection authority.

The Luna/haiku two-condition policy from the 2026-07-16 user ruling permits a
role only when both conditions hold:

1. the task is genuinely judgment-zero (a uniform rename, specified conversion,
   or equivalent mechanical work); and
2. the PM can review the output and the Guardian and Observer are not weaker.

A Luna role is reviewed by Terra-or-stronger Guardian and Observer. One
judgment-derived REWORK proves that task class was not judgment-zero and promotes
it to Terra or stronger for the next attempt.

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
tiers.strong = "opus"
tiers.mid = "sonnet"
tiers.light = "haiku"

[model_routing.agreement]
models = ["haiku", "sonnet", "opus"]
efforts = ["low", "medium", "high", "xhigh"]

[model_routing.seats]
worker = "mid"
guardian = "strong"
```

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
applies. A provider is resolved separately from model routing.

The resolver emits one JSON line:

```json
{"model":"opus","effort":"high","source":"flag","seat":"worker","warnings":[]}
```

`warnings` can include `flag_outside_agreed_model_range`,
`flag_outside_agreed_effort_range`, `gate_flag_below_recommended_floor`,
`gate_weaker_than_role`, or `gate_below_mid`. Warnings are advisory only.
`dispatch_prepare.ts` emits one stderr warning for an agreement-range warning
or, for a light-tier gate flag, for the 2026-07-16 doctrine; it then continues
with the verbatim flag.

## Codex capability boundary and PM-default translation

`codex_advertised_models` is the W-330 capability boundary. For a non-flag
canonical light-tier route, the adapter selects `gpt-5.6-luna` only when that
exact id is advertised. Missing, empty, or nonmatching capability data is
unknown availability, not permission to probe a provider, so light maps to
`gpt-5.6-terra`. The driver never performs a network availability probe.

| Canonical non-flag model | Codex execution model |
| --- | --- |
| light / `haiku` | `gpt-5.6-luna` when advertised; otherwise `gpt-5.6-terra` |
| mid / `sonnet` | `gpt-5.6-terra` |
| strong / `opus` | `gpt-5.6-sol` |
| a direct Codex model id | unchanged |

This also describes the PM-default edge case. With no `[model_routing]`
section, an `opus` PM produces `source: "pm-default"` and a Codex dispatch
translates it to `gpt-5.6-sol`. A PM model that cannot be translated (for
example, `fable`) blocks the Codex route with an explicit
`cannot be translated to Codex` error; it is not silently mapped to another
model. An explicit provider-model flag remains a caller-owned availability
assertion and is forwarded verbatim; a light gate flag receives only the
advisory doctrine warning above.

## Known Codex model ids beyond the tier table (2026-09-05)

The tier table above is the driver's translation for canonical names only;
it does not enumerate every id the provider accepts. Ids measured on
2026-09-05 with Codex CLI 0.153.4 under a ChatGPT account:

| Codex model id | Notes |
| --- | --- |
| `gpt-6-astra` | Released 2026-09-03. 1,050,000-token context, 128k output, effort `low` / `medium` / `high` / `xhigh` / `max` (the provider recommends `high` as the default). Stronger than `gpt-5.6-sol`; not yet ranked by `rankModel`, so a strong-tier canonical name still translates to Sol. Pass it as a direct flag: `--provider codex --model gpt-6-astra --effort high`. |
| `gpt-6.0-astra` | Not an id — the provider answers HTTP 400 (`not supported when using Codex with a ChatGPT account`). |

A direct id is forwarded verbatim (source `…+adapter:codex-explicit`) and
counts as the caller's availability assertion; `codex_advertised_models`
may be empty and the launch still proceeds. `codex models` needs a TTY
(`stdin is not a terminal` under a driver shell), so record the probe with
`codex exec --model <id> --skip-git-repo-check "Reply OK"` in a scratch
directory instead. Making the strong-tier translation configurable (so a
canonical `opus` can map to Astra without a flag) is tracked in the
Garelier backlog.

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
