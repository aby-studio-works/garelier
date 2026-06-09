# Correct Operation Contract (DEC-023)

Garelier's test of "did this role work correctly?" is **not** "is the
deliverable finished?" It is whether the role stayed inside its defined frame.
A finished deliverable that broke a role boundary or an approval boundary is a
**failure**, not a success.

A role acted correctly only if **all** of the following hold:

1. It **read the required sources** for its current state — its SKILL,
   `garelier-core` `protocol.md` / `state_machine.md` / `compact_handoff.md`,
   its `assignment.md`, its **`docs/garelier/knowledge/role_index.toml`
   `read_first` set** for its role (DEC-048), and any policy / knowledge the
   assignment names. When the `read_first` set does not resolve a question, it
   filed a read-only **`knowledge_query`** to the Librarian (a broad search of
   the curated trees) instead of guessing or doing ad-hoc web research (free
   investigation is Scout's job).
2. It used **only its assigned inputs** (it did not pull in unrelated scope).
3. It stayed **inside its role boundary** — a commit-free role made no commits;
   a non-integrator merged nothing; a reviewer edited no code; a role did not
   take over another role's accountable work.
4. It wrote **only its allowed outputs** (the files its role/state owns).
5. It changed **only allowed files** — within `allowed_write_paths`, never
   inside `forbidden_write_paths` or a protected path without recorded
   approval.
6. It used **only its owned branch / `checkout/`** (the branch its assignment
   names; no work on another role's branch or the primary checkout).
7. It followed a **legal state transition** (`state_machine.md`) — no skipped
   states, no transition its role does not have.
8. It **preserved compact handoff** (`compact_handoff.md`) — pointers and
   summaries, never pasted artifact bodies / full diffs in handoff files.
9. It produced **evidence for every completed acceptance criterion** (a pointer
   to the commit / test output / file that proves it, not just a claim).
10. It **escalated (BLOCKED)** instead of guessing whenever authority or
    information was missing.
11. If it committed, it ran **pre-commit hygiene** — no secret, token, private
    key, credential, customer data, or real PII in the staged change, the commit
    message, or the branch name. The pre-commit runbook is
    `docs/garelier/security/commit_hygiene_policy.md`; the Guardian gate is the
    backstop, not a substitute. A secret that reaches a commit is compromised —
    git history keeps it even if a later commit removes it.

If **any** item is false, the iteration was not done correctly even when the
visible work looks complete. The fix is to repair the boundary violation or to
**escalate** — not to ship.

This is the operational form of **governed autonomy** (DEC-023): a role is
autonomous only in the sense that it works *correctly within its frame*, never
in the sense that it may redefine goals, acceptance criteria, boundaries, or
approval. Two companions make the frame explicit: the **authority hierarchy**
in `protocol.md` (which source wins on conflict, and the rule to BLOCK rather
than silently reconcile) and each role's **`## MUST BLOCK IF`** section (the
exact conditions to stop).
