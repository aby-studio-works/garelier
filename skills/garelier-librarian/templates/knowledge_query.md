# Knowledge Query (read-only)  — DEC-048

<!--
  A READ-ONLY broad search of the CURATED Librarian knowledge
  (all `knowledge/*` trees + `knowledge/*.toml` registries). File this when your
  role_index `read_first` set did not resolve a question and you need the
  Librarian to look across the whole curated knowledge base.

  This is NOT a knowledge_update_request — it changes NOTHING. The Librarian
  searches and returns COMPACT POINTERS (path:line + one-line conclusion);
  it does not rewrite, decide, or adopt anything.

  Scope boundary: the Librarian searches ONLY registered/curated knowledge.
  A question that needs NEW external information is out of scope here — it is
  routed to a registered source sync, or it is free investigation, which is
  SCOUT's job (request a Scout inspection via Dock), never ad-hoc web
  research by the Librarian.

  Path: the requester's container, or runtime/librarian/inbox/ for async.
  Never paste secret / PII values; reference by redacted pointer.
-->

## Query identity

- Requester role:
- Requester id:
- Related assignment / branch / sha:
- Date:

## Question

State the single question in original wording (no external content, no secrets).

## Already checked

- role_index `read_first` entries consulted:
- Why they did not resolve it:

## Search hint (optional)

- Likely tree(s): engineering | quality | review | system | security | external_operations
- Keywords:

## Expected answer shape

- [ ] pointer(s) to existing curated docs (path:line) + one-line conclusion
- [ ] "not covered" → then: register a source / escalate to PM / request a Scout inspection

<!--
  Librarian response rules:
  - Do NOT bulk-read the knowledge trees. Use role/category indexes + graph/registry
    metadata to narrow candidates, then read only matching topic sections.
  - Return COMPACT POINTERS only (path:line + conclusion). Do not paste bodies.
  - Stop once sufficient authoritative pointers answer the question.
  - Search curated knowledge only; do NOT do free web research (that is Scout).
  - If the answer is "not covered", say so and name the correct next step
    (registered source sync / PM escalation / Scout inspection) — do not invent.
  - This query changes no rule. A needed rule change is a separate
    knowledge_update_request.md.
-->
