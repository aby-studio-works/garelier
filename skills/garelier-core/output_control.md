# Output Control (operational)

This is the runtime contract for how a Garelier role keeps its **final response**
short without losing anything that matters. It sits on top of — and never weakens
— compact handoff (`compact_handoff.md`) and retention (`retention.md`).

Role skills are the authoritative behavior contract. Active dispatch prompt builders
may add the shared output-control directive where wired; the dispatch-only runtime
does not require reviving the retired headless iteration loop. This file explains
what that directive means so you act on it the same way whichever provider you run on.

**Attended dispatch path:** a producer dispatched by an attended PM (via
`dispatch_prepare`'s `prompt_preamble`, not the driver's iteration loop) does not
receive the driver's per-iteration directive — `dispatch_prepare.ts`'s
`PROMPT_PREAMBLE` carries its own distilled "Output control" bullet instead, so
the compressed-register rule below still reaches that producer's first turn.

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

## Inter-agent compressed register

The fragmentary inter-agent register applies to worker/gate `report.md`, final
subagent responses, Dock final returns, progress messages, and inbox notes. PM
user-facing output uses the separate polite concise register in
`garelier-pm/SKILL.md`; control canon such as backlog, DEC, and blueprint stays
complete and readable.

- No greeting / thanks / request-echo / routine self-narration / repeated closing recap; fragments are fine; report deltas only.
- Use the artifact's fixed section schema — table/bullets, not paragraphs.
- An id/SHA/path reference replaces re-explaining it (delta-only; never restate
  a context-pack fact you can point to).
- Verbatim only: code, error text, SHAs, numbers, verdict tokens — same
  exceptions as "Never shorten these" above.
- Compressed does NOT mean omitted: a dispatched role's FINAL turn must still send
  this register — it is the sole completion signal (`role_subagent_dispatch.md` §6).
  A commit/STATE update with no final message is indistinguishable from a stall;
  the PM flags it as `IDLE-NO-REGISTER` (`contract_check.ts --stall-scan`
  `idle_no_register`, W-018) and wakes you for it.

## Inbound output discipline

The register above is outbound (what you write); this is inbound (what a raw
command dumps into your context) — the rtk concept
(github.com/rtk-ai/rtk), generalized: no external binary, bash only. Run a
heavy gate/verify command through
`skills/garelier-core/driver/src/scripts/run_summarized.ts --log-dir <dir> --slug <slug>
-- <command...>` instead of letting its full output land in context: it keeps
the FULL output in a log file and prints only exit code, a recognized-pattern
digest (`test result:` lines / error+warning counts / fmt-diff presence /
line-count+tail fallback), and — never omitted — the first 20 failure/error
lines verbatim, plus the log path. Read the log file itself only when the
summary is insufficient; the summary never substitutes for gate judgment.

## Profiles

| Profile  | Soft budget | Shape |
| -------- | ----------- | ----- |
| `normal` | ~1600 chars | concise but complete; never drop a decision / warning / external-action detail |
| `compact`| ~900 chars  | short bullets — result + evidence pointer + next action |
| `micro`  | ~500 chars  | 1–3 lines; detailed findings live in the official artifact, referenced by a `read:` pointer |

Default assignment: PM `normal`; Dock / Worker / Smith / Artisan / Librarian
`compact`; Scout / Observer `micro`; **Guardian / Concierge `normal`**. A project
can override per role in `[output_control.roles]`.

A soft budget is headroom, not a target to fill.

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

