# Output Control (operational)

This is the runtime contract for how a Garelier role keeps its **final response**
short without losing anything that matters. It sits on top of — and never weakens
— compact handoff (`compact_handoff.md`) and retention (`retention.md`).

When `[output_control]` is enabled (default), the driver appends a short directive
to every iteration prompt. This file explains what that directive means so you act
on it the same way whichever provider you run on.

## The rule

Your final response is for the screen and the driver's conversation log. It is NOT
where durable detail lives. So:

- Put durable detail in your role's **official files** — `report.md`,
  `assignment.md` answers, `STATE.md`, inspections, observations, verdicts — not in
  the final response.
- The final response carries only: the **result**, the **state transition / action
  line** your skill requires, and **pointers** (`path:line`, task id, commit SHA,
  report path).
- Keep it within your role's soft budget (see profiles below). Going over is a
  warning, not a failure — but treat the budget as the target.

## Never shorten these (even to fit the budget)

- Code symbols, file paths, commands, URLs, error text, dates, numbers, commit
  SHAs — reproduce them exactly.
- Risks, blockers, warnings, required approvals, and responsibility boundaries —
  state them fully. **Guardian and Concierge especially**: never compress a
  security/privacy/license warning, a required approval, a BLOCK reason, or a
  responsibility boundary to satisfy an output budget. Your profile is `normal`
  for exactly this reason.

## Profiles

| Profile  | Soft budget | Shape |
| -------- | ----------- | ----- |
| `normal` | ~1600 chars | concise but complete; never drop a decision / warning / external-action detail |
| `compact`| ~900 chars  | short bullets — result + evidence pointer + next action |
| `micro`  | ~500 chars  | 1–3 lines; detailed findings live in the official artifact, referenced by a `read:` pointer |

Default assignment: PM `normal`; Dock / Worker / Smith / Artisan / Librarian
`compact`; Scout / Observer `micro`; **Guardian / Concierge `normal`**. A project
can override per role in `[output_control.roles]`.

## What the driver does (you don't manage this)

- Stores `model_result` as a bounded **excerpt** (default 600 chars) with
  `result_chars` / `over_budget`; the FULL response is still used for role-state
  decisions — never truncated for logic.
- Warns `output_budget_exceeded` when your response exceeds the soft budget
  (observation; `violation_mode` is `warn` by default).
- Appends one usage record per OK iteration to
  `runtime/driver/usage/YYYY-MM.jsonl` (token / output / over-budget trends).
- Rotates its JSONL logs by size.

## Relationship to compact handoff

Compact handoff governs **durable role-to-role files** (no pasted diffs / full
reports / blueprint bodies; pointers instead). Output Control governs the
**provider's final screen response**. Same spirit, different surface — follow both.
The official artifact is always the source of truth; the final response is a
pointer-bearing summary of it.

## Tool-call output robustness (observed)

Observed on some providers: when a tool call immediately follows prose in the same
turn, the tool-call block's **opening tag** can be emitted malformed, producing a
"malformed / could not be parsed" error. Once it happens it tends to **repeat within
the session** — the model imitates its own prior malformed output — so fixing only
the tool's *arguments* and retrying keeps failing with the same error. The historical
workaround was to start a fresh session; that is not required if you reset the format.

The root cause is the **opening tag**, not the arguments. Mitigation:

- Put **no prose immediately before a tool call**. Separate the explanation from the
  call (explain in a prior turn, or keep the pre-call text minimal/absent).
- If malformed errors begin, emit a tool call **with no preceding prose** to reset
  the format — do not merely re-edit the arguments under the same broken framing.
- Most relevant to high-tool-volume roles (Worker / Dock / PM). It does not affect
  prose-only turns (no tool call = no opening tag to corrupt), so a status report
  with no tool call is always safe.

