---
knowledge_id: review.user_perspective_review
title: User-Perspective Review
category: review
status: active
owners:
  - pm
consumers:
  - observer
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# User-Perspective Review

The Observer also looks from the user's side, not only the implementer's. Original
wording; project-specific.

## Questions to ask

- Did the change actually satisfy what the user asked for?
- Is the behavior natural for the person who uses it?
- Is the experience on the error path acceptable, or does it break?
- Does it preserve existing user workflows, or quietly break one?
- Do logs, messages, and docs help the user rather than mislead them?
- Are the CLI / UI / config / report wordings written for the **user**, not for
  the implementer's convenience?
- Is the result not just internally correct, but something the user can
  **verify, understand, and operate**?

## Boundaries

- The Observer may raise user-perspective concerns.
- The Observer does **not** set new product requirements.
- If the user's intent is ambiguous, escalate to PM rather than deciding.

Record user-perspective findings in the Observer report's "User perspective"
section (`Not applicable` when there is no user-visible impact).

Generalized project knowledge, Librarian-maintained under PM approval.
