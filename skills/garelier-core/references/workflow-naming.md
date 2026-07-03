# Garelier workflow display-string naming (`ga-*`)

The strings a jig / Workflow run surfaces — in `/workflows`, in task
notifications, and on the Status Web — follow one convention so a single run
reads identically across `/workflows`, the dispatch board (`in_flight.md`),
`events.jsonl`, and the branch name. Four surfaces, four rules.

## 1. `meta.name` — `ga-<op>`

The workflow's operation: `ga-` prefix, lower-kebab. Fixed set:

- `ga-tick` — full dock-lane tick (Dispatch→Gate→Integrate→Record→Smith).
- `ga-gate` — gate + integrate + record for already-produced (held) branches.
- `ga-smith` — accumulated-window hardening.
- `ga-audit` — read-only inventory / scan (no merge).
- `ga-promote-check` — pre-promote verification.

Add a new `ga-<op>` only for a genuinely new operation.

Do NOT encode the run instance (task `#N`, timestamp) in the name. The harness
already stamps every run with a Run ID (`wf_…`) and a timestamp (shown in the
notification and on the Status Web). Also `meta` is a pure literal and the
script may not call `Date.now()` / `new Date()`, so a per-run timestamp cannot
be generated in-script — a reusable template would otherwise show the same
string on every run. The name says WHAT the workflow is; the harness says WHICH
run.

## 2. `meta.description` — `<Stage>…→…<Stage> <object> (DEC-NNN)`

One terse line. Stage words are the canonical phase titles; the gate's internal
order is written `Guardian→refute→Observer`. Use the arrow `→` (U+2192), never
ASCII `->`. End with the governing DEC.

> `Gate(Guardian→refute→Observer)→Integrate→Record for held #79 (DEC-062)`

## 3. `meta.phases[].title` — the Status-Web Pipeline stages

Title-case, from the fixed set: `Preflight` · `Dispatch` · `Gate` ·
`Integrate` · `Record` · `Smith`. These are the grouping keys of the Status Web
**Pipeline** view — do NOT invent new stage words. `detail` is one terse line.

## 4. agent `label` — `<step>:<slug>`

Lower-case, colon-separated.

- `<step>` from the fixed step vocabulary: `preflight` · `prepare` · `produce` ·
  `advise` · `contract` · `guardian` · `refute` · `observer` · `merge` · `record`
  · `smith` (a producer may instead use its role: `worker` / `scout` / …).
  `advise` is a producer's one-shot Observer direction-advice request mid-Dispatch
  (DEC-019, advisory). `prepare` is the mechanical `dispatch_prepare.sh` step the
  jig runs BEFORE `produce` (so the W-026 routing decision applies to the produce
  agent; W-033). `contract` is the mechanical `contract_check.ts` completion-
  contract verification before the gate (W-022/W-033). `preflight:gate-routing` is
  the per-tick gate-seat model resolution (W-033).
- `<slug>` is the EXACT kebab task slug from `dispatch_prepare` — the same slug
  in the dispatch board `Task` column and in the branch `…/#<N>/<slug>`. A
  non-task step uses `<step>:<qualifier>` (`preflight:doctor+base`,
  `smith:window-check`).

Use `:` (not `-`): the slug itself contains `-`, so a `-` separator would blur
the step↔slug boundary (`guardian-p2-5b-…` is ambiguous; `guardian:p2-5b-…`
is not).

## 5. attended bare-Agent `name` — `ga-<step>-<slug>`

The Claude Code Agent tool's `name` parameter is a distinct surface from the
`label` in §4: it has a **hard regex constraint**
(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` — no `:`, no `(`/`)`), so the §4
`<step>:<slug>` label and the dispatch agent-id `<role>(#<id>)` name (both
emitted by `dispatch_prepare.sh`, §4) cannot be used verbatim as an Agent
`name` — a bare launch with `label` as `name` fails with an
`InputValidationError`. This applies to an **attended PM** (no driver,
`SendMessage`/`Agent` tool calls hand-rolled in-session) launching a subagent
directly, as opposed to a jig/Workflow run which uses §1-4 display strings.

- `<step>` is the same fixed vocabulary as §4 (`produce` for a
  `dispatch_prepare`-launched producer; `guardian` / `refute` / `observer` /
  `merge` / `record` / `smith` / `scout` for the corresponding non-producer
  steps a PM hand-dispatches).
- `<slug>` is the same exact kebab task slug as §4.
- Hyphen-join instead of `:` (the Agent name regex forbids `:`): `ga-<step>-<slug>`.

For a producer, use the `agent_name` key `dispatch_prepare.sh` emits verbatim
(`ga-produce-<slug>`, already regex-safe and truncated to 64 chars) — do not
reconstruct it by hand. For a non-dispatch step (Guardian/Observer/refute
gates, a Scout, etc.) that the PM launches directly with the Agent tool,
build the same form by hand: `ga-<step>-<slug>`.

| §4 label | §5 Agent `name` |
| --- | --- |
| `produce:p2-5c-spatial-collision-fixed32` | `ga-produce-p2-5c-spatial-collision-fixed32` |
| `guardian:p2-5b-replication-dimension-position-wire` | `ga-guardian-p2-5b-replication-dimension-position-wire` |

## Alignment guarantee

| surface | shared token |
| --- | --- |
| `/workflows` phase groups ↔ Status Web **Pipeline** | the stage set |
| `/workflows` label slug ↔ board **Task** ↔ **branch** `<slug>` | one kebab slug |
| label step / role ↔ Status Web role vocabulary | guardian / observer / smith / worker… |
| `events.jsonl` `kind` (unchanged) | start / complete / blocked / rework / cleanup / note |

Enforced elsewhere (not display strings): `<slug>` is kebab `[a-z0-9-]`
(`dispatch_prepare.sh`); the branch is
`garelier/<target-slug>/<pm_id>/<family>/#<N>/<slug>` (`worktree-addressing.md`).
The `produce:<slug>` label, the `<role>(#<id>)` dispatch agent-id name, and the
`ga-produce-<slug>` attended Agent-tool name (§5) are all **emitted** by
`dispatch_prepare.sh` (the `label` / `name` / `agent_name` JSON keys) so a jig,
a manual launcher, or an attended PM reuses them verbatim rather than
reconstructing the string — a bare launch that skips `dispatch_prepare` (and so
has no `produce:<slug>` name) is a producer-launch escape hatch the doctor
dispatch-integrity check flags.

## Worked examples

| run | `meta.name` | a few labels |
| --- | --- | --- |
| full tick dispatching worker #80 | `ga-tick` | `produce:p2-5c-spatial-collision-fixed32`, `advise:p2-5c-spatial-collision-fixed32` (worker-requested), `guardian:p2-5c-spatial-collision-fixed32`, `merge:p2-5c-spatial-collision-fixed32` |
| gate held #79 | `ga-gate` | `guardian:p2-5b-replication-dimension-position-wire`, `refute:…`, `observer:…`, `merge:…`, `record:…` |
| smith window | `ga-smith` | `smith:window-check`, `smith:window-hardening`, `smith:guardian` |
