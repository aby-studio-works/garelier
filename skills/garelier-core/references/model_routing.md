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
| **PM** (the orchestrator's decisions) | Decides scope, lane, what to dispatch, when to promote, how to resolve a blocker. A wrong PM call mis-aims every downstream producer and is not gated. **Systemic.** | **Strongest available.** |
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
  provider model id). A producer subagent inherits the orchestrator's model
  unless you override it — override DOWN for cheap bulk producers, UP for a
  judgment-dense reviewer.
- **Per role (driver / config):** each `[[workers]]` / `[[guardians]]` / …
  entry takes a `model` (and Codex producers take `--model`); the Jig
  `[jig]` block (DEC-062 Phase 3) makes per-seat routing first-class.
- **Codex / pool producers:** `dispatch_codex_producer.sh --model <m>` —
  the same judgment-density rule applies across providers.

Cross-references: `role_subagent_dispatch.md` (the dispatch procedure that
consumes this), `mode_e_jig.md` (per-seat routing as a shipped mode).
