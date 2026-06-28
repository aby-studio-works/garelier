---
knowledge_id: engineering.debugging_principles
title: Debugging Principles
category: engineering
status: active
owners:
  - pm
consumers:
  - worker
source_ids:
  - project-original
last_reviewed_at: 2026-06-12
review_cycle: on-change
---

# Debugging Principles

How a producing role isolates a cause and fixes it safely, instead of papering
over a failure. Project-specific; original wording.

## First moves (ordered — do these before proposing any fix)

The opening sequence matters more than cleverness. Run it in order; each
step can end the task early (and early honest endings are good outcomes).

1. **Reproduce as a fact, not a description.** Run the exact failing
   command yourself and capture the exact output. If you cannot reproduce,
   say so and stop — do not fix from the report's paraphrase.
2. **Classify which layer is broken** before theorizing. The failure is in
   exactly one of: (a) the product code, (b) the test itself, (c) the
   environment/toolchain, (d) your understanding of the spec. Cheap
   discriminators: does it reproduce at the base SHA (→ pre-existing, not
   yours — report BLOCKED with evidence, never widen scope)? Does the same
   command behave differently in another shell/runner (→ environment)?
   Does the test assert something the spec never promised (→ test)?
3. **Read the error literally before pattern-matching.** The exact
   message, the exact line, the exact bytes when text is involved — a
   familiar-looking symptom with a different cause is the classic
   strong-model-too trap. Quote the evidence in your notes; if you cannot
   point at the line that proves your theory, you do not have a theory yet.
4. **Trace to the first wrong value, not the loudest symptom.** Walk the
   data flow upstream (writer audit): who produced the bad value first?
   Fixing where the error is *observed* instead of where it is *created*
   is how regressions multiply.
5. **Design one discriminating experiment per hypothesis** — the cheapest
   command whose outcome differs between your top two hypotheses. Repeat
   it (a 1/1 result is an anecdote; 5/5 is evidence).
6. **Look for siblings before fixing.** The same mistake rarely lives in
   one place (copy-pasted twins, parallel wrappers, the same
   pattern in a neighboring module). One grep now beats a second bug
   report later.
7. **Write the failing test first** (red), fix (green), then run the FULL
   gate — not just the test you added. A fix that passes its own test and
   breaks the suite is not a fix; never trust your own success without the
   full re-run.

## Method

- Reproduce the failure first. A bug you cannot reproduce, you cannot confirm
  fixed.
- Separate expected from actual, and recent-change from pre-existing defect.
- Build the minimal reproduction. Shrink the input/conditions until the failure
  is the smallest thing that still fails.
- When you add logging, never emit secrets or PII. Remove temporary
  `print`/debug code before committing.

## Flaky failures

- Re-run a suspected flake exactly once. **Two consecutive failures are a real
  failure**, not a flake — treat them as such.
- Do not "fix" a flake by adding sleeps, broad `try/catch`, or
  unwrap/`?`-suppression to hide it.

## Fixing

- Do not hide an unknown cause behind a broad catch, a suppressed error, or a
  retry loop.
- If you must take a workaround, record the **residual risk** and a **follow-up**
  in `report.md` (and `backlog`/`questions.md` if it needs PM attention).
- After fixing, add a test or a durable evidence artifact that would catch this
  failure again (see `../quality/regression_policy.md`).

## When the cause stays unknown

Stop and escalate (`../system/escalation_policy.md`) with the minimal
reproduction and what you ruled out. A documented unknown beats a silent
workaround.
