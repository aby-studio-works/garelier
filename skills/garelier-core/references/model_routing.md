# Model routing — which model on which seat

Garelier is model-agnostic, but WHERE you spend a stronger model decides output
quality more than any single tuning knob. This is the operational guidance for
choosing a model per role/seat, and the answer to "should a weaker model run
PM?". Distilled from operating the framework across model tiers; the
config-level form is DEC-062 (Jig) Phase 3 per-seat routing.

## The rule: tier follows judgment density, not token volume

Spend the strongest model where a single wrong judgment is **systemic** —
where the mistake is not caught downstream and propagates. Spend cheaper
models where work is **mechanical, parallel, and gated** — a producer's slip
is caught by the gate, so a mid-tier producer is safe by construction.

| Seat | Why it is judgment-dense or not | Model tier |
| --- | --- | --- |
| **PM** (top-level routing decisions) | Decides scope, lane, what to dispatch, when to promote, how to resolve a blocker. A wrong PM call mis-aims every downstream producer and is not gated. **Systemic.** | **Strongest available.** |
| **Dock** (integration judgment) | Sequences dispatch, reads verdicts, decides rework vs merge vs escalate. A wrong integration call lands bad work or stalls good work. | **Strong.** |
| **Guardian / Observer** (gate verdicts) | The last line before a merge; a missed security/quality issue ships. Judgment-dense and terminal. | **Strong** (Guardian especially). |
| **Judge panel** (Jig CRITICAL, DEC-062) | Picks/synthesizes among N producer attempts — quality is the whole point of the seat. | **Strong.** |
| **Worker / Smith / Librarian / Scout producers** | Bounded assignment, run-to-completion, then **gated** by Guardian→Observer + the quality gate. A slip is caught and reworked. | **Mid-tier is fine**; raise only for unusually subtle implementation work. |
| **Mechanical steps** (merge gate poll, dispatch event writes, status) | Zero-LLM or near-zero judgment. | **Cheapest / N/A.** |

## Answering "can a weaker model run PM?"

It can, but it is the **worst** place to economize: PM/Dock mistakes are the
ones nothing downstream catches. To make a weaker PM safe, compensate
structurally rather than hoping:

- **Keep the human-decision gates ON** (`require_for_all_merges`, the four
  hard gates). A weaker PM should ask more, not auto-approve more — set
  `auto_approve_*` conservatively.
- **Run Mode E "Jig" (DEC-062)** so the tick's ORDER is code, not the PM
  model's memory — the weaker model only makes the bounded PLAN decision,
  and every gate ordering is enforced by the script.
- **Put a strong model on Guardian and the judge seat** even when PM is
  mid-tier: a weak planner with strong gates degrades gracefully (more
  rework, not bad merges); a strong planner with weak gates does not.
- **Prefer NORMAL/CRITICAL review depth** for a weaker PM's dispatches —
  the adversarial refuter and N-version panel buy back the planning risk.

## How to set it

- **Per dispatch (manual / Agent/Workflow tool):** pass `model` on the
  `agent()` call or the Agent tool (`opus` / `sonnet` / `haiku`, or a
  provider model id). A producer subagent inherits the Dock's model
  unless you override it — override DOWN for cheap bulk producers, UP for a
  judgment-dense reviewer.
- **Per role (driver / config):** each `[[workers]]` / `[[guardians]]` / …
  entry takes a `model` (and Codex producers take `--model`); the Jig
  `[jig]` block (DEC-062 Phase 3) makes per-seat routing first-class.
- **Codex / pool producers:** `dispatch_codex_producer.sh --model <m>
  [--effort <e>]` — the same judgment-density rule applies across providers.
  The helper maps `--effort` to `codex exec -c model_reasoning_effort="<e>"`
  (verified against codex-cli `exec --help`: `-m/--model` + `-c key=value`
  config override, 2026-07-12).

  **Codex model names (verified 2026-07-12):** the GPT-5.6 family is tiered —
  `gpt-5.6-sol` (top tier; supports `model_reasoning_effort` up to `xhigh`,
  and an `ultra` mode that fans out subagents — pair `ultra` with a rollout
  token budget) and `gpt-5.6-terra` (mid tier; typical effort `high`).
  `gpt-5.5` remains valid. The bare alias `codex` is NOT a model name on
  ChatGPT accounts (400). **CLI version gate:** GPT-5.6 models require a
  newer codex-cli than 0.143.0 — the server answers
  "requires a newer version of Codex. Please upgrade" until the CLI is
  updated; probe with
  `codex exec --skip-git-repo-check -m gpt-5.6-sol -c model_reasoning_effort=high "Reply OK"`
  after upgrading.

  **Model × effort selection guide (operational heuristic, 2026-07-12):**
  pick the MODEL by the task's judgment density (how much design/debugging
  judgment the whole task needs); pick the EFFORT by the depth of the single
  hardest reasoning step in it. Raising effort is usually cheaper than
  raising tier — try `terra --effort high` before `sol` for one hard spot in
  otherwise mechanical work. For plain implementation the two defaults are
  `terra high` and `sol medium` (sol's capability ceiling at moderate effort
  suits writing code; pick terra when the work is closer to mechanical, sol
  when code quality/idiom judgment matters).

  | Seat / task class | model | effort |
  | --- | --- | --- |
  | bulk mechanical producer (rename sweep, TOML 量産, boilerplate migration, test scaffolds) | `gpt-5.6-terra` | `low`/`medium` |
  | standard worker (bounded feature, clear blueprint, few unknowns) | `gpt-5.6-terra` | `high` |
  | standard implementation, higher code-quality ceiling (user 補足 2026-07-12: sol は medium でも実装向き — terra high と並ぶ実装既定の選択肢) | `gpt-5.6-sol` | `medium` |
  | judgment-dense worker (root-cause debugging, cross-crate change, validator/gate hardening) | `gpt-5.6-sol` | `high` |
  | hardest single-agent reasoning (architecture refactor, determinism/concurrency bugs, security-sensitive) | `gpt-5.6-sol` | `xhigh` |
  | standalone deep investigation with explicit user/PM opt-in ONLY | `gpt-5.6-sol` | `ultra` + `rollout_token_budget` |

  Rules of thumb:
  - `ultra` is an orchestration change (codex spawns its own subagents), not a
    quality dial — **do not use it inside a normal Garelier dispatch**: the
    Garelier lane is already the fan-out layer, and nesting fan-outs multiplies
    cost without adding oversight. Always cap it (`-c rollout_token_budget=…`).
  - **Field notes (a target-project campaign, 2026-07-13〜16 実戦):**
    - `sol high` は「新 crate を理から直接構築 + 非恒真 test 自作 + fixed-point 決定論」級を
      1 発完走できた (pl_field/behavior/port/mover 等、each ~500 行 + 4 AC test)。実装 crate
      構築の主力。**外部視点 audit は codex 必須** (Claude が Claude を gate すると視点が消える)。
    - `terra medium/low` は resume・小 fix・probe・行番号追随の cook fix に十分。security row の
      traversal/fail-open 封鎖は `sol high` を使った (境界の敵対思考が要る)。
    - **cold worktree の全 workspace compile は ~15 分**。producer には warm per-crate を
      foreground・cold 全体のみ background と指示 (silent idle 予防、dispatch_prompt_craft §1-8)。
    - Pro plan では週次 quota が大幅緩和 (2026-07-16 user)。旧 sol-high-≤2/日 の burn 制約は撤廃、
      2 lane 同時上限のみ継続。codex-first に完全復帰。

  - Escalate on evidence, not in advance: if a `terra high` producer stalls or
    ships a wrong root cause once, re-dispatch that item on `sol high`; reserve
    `sol xhigh` for a task the blueprint itself marks high-stakes (DEC-076
    trigger class).
  - De-escalate rework: mechanical follow-ups to a `sol` design (apply the
    reviewed plan across N files) go back down to `terra low/medium`.
  - `gpt-5.5` = fallback when the installed CLI predates 5.6 support.

## Mechanized resolution (W-026)

The rule above is applied by hand no longer: `driver/src/dispatch/model_routing.ts`
resolves a seat's model/effort deterministically, and `dispatch_prepare.sh` calls
it at every producer dispatch (forward-supplying the decision in `context.json`
and its output JSON). Read-only gate seats have no worktree, so a gate dispatch
calls the resolver directly (`--seat guardian` / `--seat observer`).

**Resolution order (highest wins):**

1. `--model` / `--effort` explicit dispatch flag — `source: flag`
2. blueprint `Model-hint:` / `Effort-hint:` line (Identity section; parsed by
   line grep, an unfilled `{{…}}` placeholder is ignored) — `source: blueprint`
3. automatic rules (below) — `source: rule:<names>`
4. `[model_routing]` per-seat default — `source: seat-default`
5. unresolved — `source: inherit` (the caller passes no `model`; the subagent
   inherits the dispatcher's model, exactly as before this resolver existed)

**Automatic rules** move a producer's tier (never a hardcoded model name):
gate/judge seat → `strong`; scope marker `engine_LARGE` (flag or blueprint
body) → promote; a risk tag (`schema` / `determinism` / `save` / `security` /
`cooker`) → promote; `--rework` → promote; a `docs`/`research` type demotes one
tier only when nothing promoted. Promotions stack and cap at `strong`.

**Config** (project `setup_config.toml`; absent section ⇒ everything inherits =
full back-compat):

```toml
[model_routing]
rules.on = true            # automatic rules (default on when the section exists)
above_pm = "deny"          # deny | ask | allow — escalation ceiling (below)
tiers.strong = "opus"
tiers.mid    = "sonnet"
tiers.light  = "haiku"

[model_routing.seats]
worker = "mid"             # a tier name, or a direct provider model id
guardian = "strong"
```

**`light` tier (haiku) の使用方針 (user 2026-07-16「opus PM が扱い切れるなら解禁」).**
`tiers.light = "haiku"` は既定で定義されるが、**producer/gate に haiku を割り当てるのは既定で避ける** —
理由は本 doc 冒頭の「弱い gate が悪い merge を通す」class。解禁の条件は 2 つ全て:
1. **task が真に judgment-zero** — 完全機械変換のみ (一律 rename sweep / 定型 boilerplate /
   determinism を持たない doc 整形)。少しでも設計・debug・境界判断を含むなら mid 以上。
2. **PM が opus 級で、かつ gate が producer より弱くない** — haiku producer は必ず opus/sonnet の
   Guardian→Observer で受ける (`gate_weaker_than_producer` warning を出さない構成)。PM 自身が
   haiku 出力を diff review できる tier に居ること。
この 2 条件下では haiku は許可 (`seats.worker = "light"` を明示 or per-dispatch `model: haiku`)。
**懐疑が正当な既定**: 迷ったら mid。haiku producer が REWORK を 1 度でも出したら、その task class は
judgment-zero でなかった証拠 — 即 mid へ格上げする (evidence-based escalation)。Claude 側 tier 選定も
codex と同じ「model = 判断密度 / effort 相当 = 最難ステップ」で、haiku = terra-low 相当の位置づけ。

**Blueprint hint** (Identity section):

```markdown
- Model-hint: opus
- Effort-hint: high
```

**Above-PM ceiling.** A resolved model is never allowed to exceed the PM's own
model — the default is **equal-or-below only**. Config `[model_routing] above_pm`
= `deny` (default) | `ask` | `allow`. Rank order `haiku < sonnet < opus <
fable/mythos`; a provider-custom id ranks through the config `tiers` when it is
assigned to one, otherwise it is *incomparable*. The PM model comes from
`--pm-model` (dispatch_prepare prefers `GARELIER_PM_MODEL`, else `[runner]
pm_model` / `default_agent_model`); when the PM model is unknown the ceiling
defaults conservatively to the `mid` tier.

- **`deny` (default):** a would-be-higher model is clamped down to the ceiling;
  `source` gains `+clamped-pm-ceiling` and the clamped-away model is reported in
  `suggested_model`.
- **`ask`:** `model` still carries the SAFE (clamped) value — so any **jig /
  unattended** path is deny-equivalent by construction (it cannot confirm) — plus
  `needs_confirmation: true` and the escalated `suggested_model`. Only an
  **attended** PM, after user confirmation, spawns `suggested_model` itself.
- **`allow`:** the resolved model passes through unchanged.
- **Incomparable desired** (a custom model that ranks nowhere): under `deny`/`ask`
  it cannot be proven within the ceiling, so it is clamped to the `mid` tier (the
  safe side); pin such a model to a `tiers` entry or use `above_pm = allow` to
  spawn it as-is.

**Gate-weaker-than-producer advisory.** `above_pm` bounds each seat against the
PM but does not constrain seats against each other, so an explicit config can
still produce a *strong producer gated by a weaker reviewer* (e.g. Worker=opus,
Guardian=haiku) — the anti-pattern at the top of this document, where a bad merge
sails through. This is **not blocked** (explicit config is respected) but it is
**surfaced**: the resolver adds a non-blocking `warnings` array. A gate seat
(Guardian / Observer / Judge) whose resolved rank is below the producer default —
`seats.worker`'s resolved rank — warns `gate_weaker_than_producer`; when
`seats.worker` is not configured the comparison cannot be made, so a gate below the
`mid` tier warns `gate_below_mid` instead. The resolution itself is unchanged — an
attended PM seeing the warning should confirm the intent with the user.

Output JSON: `{model, effort, source, seat, suggested_model, needs_confirmation,
above_pm, warnings}`.

**Effort caveat.** The attended Agent tool accepts `model` only — it has no
effort parameter. A resolved `effort` therefore takes effect on the jig /
Workflow dispatch path (and is recorded in `context.json` for visibility); an
attended bare-Agent launch applies the `model` and ignores `effort`.

**Fable seat caveat — OS-layer diagnostics (hypothesis-grade, observed
2026-07-12).** A Fable-model session that itself runs OS/environment-layer
diagnostic tools — PATH enumeration, DLL inspection (`objdump` etc.), system
config probing, REST/network reachability checks — **may trip a security
warning at the moment of tool use and render the Fable seat unusable**
(user-reported; single-incident evidence, treat as "かもしれない" until
corroborated). Operating rule derived from it: a Fable PM keeps to
report-based judgment and direction; hands-on 実務調査 of the OS/environment
layer is always delegated to an opus/sonnet subagent. Project-internal git /
backlog / control operations are NOT affected. Incident context: 2026-07-12
MSYS2 libwinpthread version-skew investigation run directly by a Fable PM
session → session had to be switched to Opus.

Cross-references: `role_subagent_dispatch.md` (the dispatch procedure that
consumes this), `mode_e_jig.md` (per-seat routing as a shipped mode),
`attended-gate-dispatch.md` (gate seats call the resolver directly).
