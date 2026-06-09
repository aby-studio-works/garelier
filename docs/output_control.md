# Output Control

> Human-readable companion to the runtime contract in
> `skills/garelier-core/output_control.md` and the rationale in
> DEC-028. Keep the three in sync.

Garelier runs the full role roster, and that is intentional — the weight is the
price of governed AI labor. But two things grew unbounded over a long run and had
nothing to do with governance:

1. The provider's **final response** — long even when the durable detail was
   already written to `report.md` / inspections / `STATE.md` — inflated the
   driver's per-role conversation log every iteration.
2. The driver's **JSONL log files**, and the fixed 1000-char `model_result`
   truncation with no per-role tuning and no over-length signal.

Output Control (`[output_control]`, DEC-028) addresses exactly those, **on top of**
the existing compact-handoff (durable role-to-role files) and retention (history
ageing/archival) — it does not replace either.

## What it does

- **Per-role output profiles.** `normal` / `compact` / `micro`, each with a
  `soft_result_chars` budget. The driver appends a short directive to the
  iteration prompt asking the provider to keep its FINAL response within that
  budget and put durable detail in official files.
- **Excerpt logging.** `model_result` is stored as a bounded excerpt
  (`model_result_log_chars`) with `result_chars` / `output_profile` /
  `over_budget`. The full response is still used for role-state decisions — only
  the stored excerpt is bounded.
- **Over-budget warning.** A too-long response logs `output_budget_exceeded`.
  This is an observation, not a failure (`violation_mode = "warn"`; `"fail"` is
  experimental).
- **Usage summary.** One record per OK iteration in
  `runtime/driver/usage/YYYY-MM.jsonl` — role, provider, profile, tokens, cost,
  result_chars, over_budget — so you can see which role bloats output over time.
- **Log rotation.** Driver and per-role JSONL logs roll at
  `driver_log_max_bytes`, keeping `driver_log_keep_files` rotated files.

## What it never does

- Never abbreviates code, file paths, commands, URLs, error text, dates, numbers,
  or commit SHAs.
- Never hides risks, blockers, warnings, required approvals, or responsibility
  boundaries. **Guardian and Concierge default to `normal`** precisely so safety
  content is never pressured short.
- Never truncates the result used for role-state parsing.
- Never compresses public/user-facing docs or source code, and depends on no
  external compression tool or copied external phrasing.

## Configuration

```toml
[output_control]
enabled = true
default_profile = "compact"          # normal | compact | micro
violation_mode = "warn"              # warn (observe) | fail (experimental)
model_result_log_chars = 600         # excerpt cap in driver JSONL (100–5000)
error_tail_chars = 500               # stderr/stdout tail kept on failure
driver_log_max_bytes = 10485760      # rotate JSONL past this size
driver_log_keep_files = 10
usage_summary = true                 # runtime/driver/usage/YYYY-MM.jsonl

[output_control.profiles.normal]  ; soft_result_chars = 1600, max_bullets = 8
[output_control.profiles.compact] ; soft_result_chars = 900,  max_bullets = 5
[output_control.profiles.micro]   ; soft_result_chars = 500,  max_bullets = 3

[output_control.roles]
pm = "normal"        # decisions / blueprint rationale
guardian = "normal"  # never pressure safety warnings short
concierge = "normal" # never pressure external-op conditions short
scout = "micro"      # detail lives in the inspection
observer = "micro"   # detail lives in the observation
# … worker/smith/artisan/librarian/dock = compact
```

Absent `[output_control]` ⇒ these defaults apply (enabled). `default_profile`
outside the three names, an invalid `violation_mode`, or a `soft_result_chars`
below 200 is a hard config error; `model_result_log_chars` is clamped to
[100, 5000].

## Visibility

- **doctor** flags an invalid profile / violation_mode, a sub-1 MB rotation size,
  a sub-200 budget (P0); `guardian`/`concierge = "micro"` or
  `violation_mode = "fail"` (P1); `enabled = false` / `usage_summary = false` (P2).
- **status** shows whether output control is enabled and the latest month's
  over-budget ratio (read-only; zero provider tokens).

## Relationship to other layers

| Layer          | Governs                                   |
| -------------- | ----------------------------------------- |
| Compact handoff (DEC-005) | durable role-to-role files (pointers, no pasted bodies) |
| Retention (DEC-009)       | history ageing / archival                 |
| **Output Control (DEC-028)** | the provider's final response + driver log storage |
