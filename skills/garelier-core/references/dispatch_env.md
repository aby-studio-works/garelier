# Project-declared dispatch environment

Consumer projects declare per-child values only in their canonical
`__garelier/<pm_id>/_crew/pm/setup_config.toml`:

```toml
[[dispatch.env]]
name       = "PROJECT_CHECKOUT"
value      = "{checkout}"
why        = "The consumer project's operation rule and owner decision"
applies_to = ["producer", "gate"]
```

`name`, `value`, and non-empty `why` are required. `applies_to` defaults to
`["producer"]`; use `"gate"` only when a merge-gate child needs the value.
Garelier never interprets either `name` or `why`.

Only these placeholders are supported: `{checkout}`, `{project}`, `{container}`,
`{dispatch_id}`, `{role}`, and `{slug}`. Unknown or malformed placeholders,
missing `why`, and an empty resolved value make `dispatch_prepare` fail before
the child starts. If a path has not yet established a placeholder it needs, that
declaration is not injected on that path; its `name`, `why`, and unavailable
placeholder are recorded as `dispatch_env.skipped` in the generated context.
Once the value is established, an empty expansion still fails fast. A declaration
does not validate the consumer tool's semantics.

Path words have one meaning at every boundary:

| boundary | checkout authority | project authority |
| :-- | :-- | :-- |
| producer launch | `{checkout}` is the dispatched role's direct execution checkout and child cwd | `{project}` is the target-project root used to resolve the PM Control/runtime namespace |
| Dock-run gate | the dispatch fact pack's checkout is the gate child cwd; a declaration is expanded from that same fact pack | the same fact pack's project root supplies PM configuration and attribution |
| merge request | no placeholder is re-expanded; the request records the candidate checkout and project provenance already validated from the fact pack | the request's project root identifies the Control/runtime namespace |
| merge gate | the request-bound candidate checkout is validated and used as the command cwd | the request-bound project root remains the configuration/control authority |

`{git_root}` is deliberately **not** a supported placeholder. A child may use
Git to discover the repository containing its already-bound cwd, but that does
not create a second path authority. If a pipeline stage intentionally moves the
candidate to another checkout, it must issue a new fact pack/request naming that
checkout; consumers never silently reinterpret an earlier `{checkout}`.

The PM-run `gate_runner` reads the dispatch fact pack beside a lane register when
one is available. If that boundary cannot establish a requested placeholder, it
continues without injecting that declaration and records
`DISPATCH_ENV_SKIPPED` with its `name`, `why`, and unavailable placeholder in
both the PM-visible result and gate log.

The resolved `name`, `value`, and `why` are shown in `dispatch_prepare` output
and `context.json`; `dock_status` shows the project declarations. Put the full
operating rule and its rationale in the consumer project's knowledge document,
then add this reference path to the relevant consumer role's `read_first` list.

Declaration names are case-insensitively unique. Declarations are overlaid
after inherited environment scrubbing, then that launch path's complete,
explicit core-owned overlay is re-applied with the same case-insensitive
semantics. Fresh provider launch and exact-session resume share the provider
overlay; gate paths apply their own complete core overlay. Core-owned values
(including merge-gate safe-directory handoff) therefore win when names collide.
Do not place secrets in tracked configuration.

<a id="dispatch-declaration-axes"></a>

## Dispatch declaration axes — `resource_class`, `heavy_tier`, `touches`

These three are declared once, at `context_pack` / `dispatch_prepare` time, and
every later stage reads them instead of guessing. **This section is the single
canonical statement.** Other manuals point here; none of them restate it.

```
context_pack.ts … [--touches a,b] [--depends-on slug,#id]
                  [--resource-class heavy|light|data|review]
                  [--runtime-effect none|headless|visual|aural|input]
                  [--heavy-tier check|codegen] [--full-gate]
```

<a id="heavy-tier"></a>

### `--heavy-tier check|codegen` — the duration axis of a heavy dispatch

`--resource-class heavy` says the dispatch takes the machine-wide slot
(`heavy_dispatch_gate.ts`, so two full-workspace compiles never run at once on a
RAM-bound box). `--heavy-tier` says **for how long**, because the watch and the
lock size their timeouts from it.

| tier | measured shape | declare it for |
| :-- | :-- | :-- |
| `check` | a scoped or cold check, ~7 minutes | `cargo check`-grade steps, scoped package tests |
| `codegen` | a full codegen / test run, **hours** | full-workspace `cargo test`, whole-project closure gates |

- The axis exists **only** when `resource_class = heavy`. On any other class
  `heavy_tier` is packed as `null`; declaring it there is meaningless.
- **Undeclared on a heavy dispatch is not an error and not a default.**
  `context_pack` packs `null` and prints on stderr:
  `heavy_tier unspecified on a heavy dispatch — packing null (each consumer keeps its own documented default). Declare --heavy-tier check|codegen to schedule this dispatch on its measured duration. Rule: skills/garelier-core/references/dispatch_env.md#dispatch-declaration-axes`
  The warning names this section, so the reader reaches the decision table above
  in one hop. A declared dispatch prints no warning at all.
  Each consumer then applies its own documented default; the absence is carried,
  not silently resolved at the pack boundary.
- A consumer resolving an unspecified tier resolves it to **`codegen`, the safe
  side**. The harm is asymmetric: a real codegen job scheduled as `check` trips
  RUNAWAY at ~60 minutes and gets stopped mid-run, while a check job scheduled
  as `codegen` only delays detection of one that is genuinely hung.
- Declaring the tier is therefore how you stop a long job from being stopped —
  not a scheduling nicety.

<a id="heavy-lock-multi-turn"></a>

### Holding the slot across turns

`heavy_compile_lock.ts` acquires the slot, and the holder must prove it is still
alive. Two modes do that, and **they are not the same call**:

```bash
# acquire, immediately before the heavy command
bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <id> --mode acquire
#   -> TOKEN. If TOKEN is "OPEN" the lock is not held: ABORT. Running lockless is forbidden.

# refresh liveness after the log has actually grown (side effect: writes `progress`)
bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <id> --mode progress --token <TOKEN>

# read-only "do I still hold slot-N?" — same HELD/LOST answer, no side effect
bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <id> --mode probe --token <TOKEN>

# release immediately after the command returns — never sleep or do other work while holding
bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <id> --mode release --token <TOKEN>
```

- `progress` is the **only** mode that refreshes liveness, and the production
  gate runner calls it **only after captured stdout/stderr has actually grown**.
  Calling it on a timer keeps a hung job's slot alive forever.
- `probe` is its read-only sibling. Use it in a wrapper that reconfirms
  ownership before running the guarded command, in a multi-turn hold where a
  turn may have died, or when reporting status. It never refreshes anything.
- **There is no `--mode heartbeat`.** The full set is
  `acquire` / `release` / `sweep` / `progress` / `probe`.
- Turn-death reclaim, the pattern actually hit in operation: a turn acquires the
  slot and then ends without releasing. The lease is 240 minutes, so the reclaim
  scan reports `holders=1 / evaluated=slot-0=held / ram_ok=false` and waits out
  the lease even though the owning pid is gone. Symptom = a gate log with
  `GATE_START` and no step line for minutes. The check is
  `runtime/locks/heavy_compile/slot-*/owner`: if that pid does not exist, release
  by token. `probe` tells you HELD/LOST for your own token; it does not tell you
  whether someone else's holder is dead.

<a id="touches"></a>

### `--touches` — optional, and what an empty value costs

`touches` is **optional** (`context_pack.ts` usage spells it `[--touches a,b]`).
Leaving it empty is a legal declaration, not an omission the driver repairs.
What it costs is three concrete things, all of which silently stop working:

| use | who reads it | what an empty `touches` does |
| :-- | :-- | :-- |
| running-lane overlap detection | `conflict_check.ts` compares a new dispatch's declared touches against every already-active dispatch's | no overlap can be computed, so two lanes edit the same files and discover it as a merge conflict at land |
| gate tier classification | the gate seat sizes the required check from the declared paths | the tier is decided from something other than the candidate's real footprint |
| proxy-commit scope check | the commit-time comparison of declared scope against the actual dirty set | the declared scope is empty, so nothing contradicts an out-of-scope edit |

**Defaults by case — all three rows are decided, none is "use judgement":**

| case | declare | why |
| :-- | :-- | :-- |
| single lane, nothing else running | **empty** | there is no other lane to overlap with, and the other two uses are recoverable from the diff at gate time. Declaring a guess is worse than declaring nothing |
| parallel lanes | **declare the paths**, as claim globs | this is the only case where overlap detection has anything to compare. An undeclared parallel lane is the failure this field exists to prevent |
| scope not yet known | **run the census first, then declare** | do not dispatch with a guess. A wrong `touches` is worse than an empty one: it claims globs the lane will not honour, and it makes `touch_conflicts[].overlapping_globs` report a conflict that does not exist |

`touch_conflicts[].overlapping_globs` returns **executable claim globs**. Do not
mix prose into `touches`; the value is consumed as globs, not read by a person.

**Design note (open):** the three uses above share one field, and they do not
want the same thing — overlap detection wants the *claim*, tier classification
and scope checking want the *actual footprint*. A lane that declares a
deliberately wide claim to reserve ground therefore also widens its gate tier.
The field is not split here (the rule has to exist before the shape changes);
splitting it is a separate row.
