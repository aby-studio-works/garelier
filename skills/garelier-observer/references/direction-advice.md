# Observer reference: direction advice

Detail for `garelier-observer` §7c: the Worker-facing
`direction_advice` channel. This is the **only** Observer interaction a
Worker may request, and it is deliberately narrow.

The Observer gives **implementation-direction advice inside the Worker's
existing assignment scope**. It does not change what the Worker is
building, only helps with how — and only within bounds.

## Allowed questions

These stay inside the assignment scope and are answerable as advice:

- **Which existing pattern should I follow?** ("Two modules already do X;
  which is the one to mirror here?")
- **Is there a smaller / safer local abstraction?** ("Can this be done
  with the existing helper instead of a new type?")
- **How should I split this local change?** ("Should this be one commit
  or split across these files?")
- **Reuse vs duplicate a helper for this task?** ("There is a similar
  helper in `foo`; reuse it or keep a local copy here?")

For these, the Observer reads the relevant code, weighs the options, and
returns a concise recommendation plus the alternatives it considered
(`templates/direction_advice.md`).

## Forbidden questions

These exceed advice scope. The Observer must **not** answer them:

- Changing **acceptance criteria** or the assignment goal.
- **Expanding scope** beyond what the assignment covers.
- **Product / architecture / security / license policy** decisions.
- **Approving a migration or a production data write.**

On any forbidden question, the Observer:

1. Sets the advice status to `ESCALATE_TO_DOCK_OR_PM`.
2. Gives **no** advice on the substance of the question.
3. Notes briefly *why* it is out of scope, so the Worker knows where to
   take it.

The Worker then escalates to Dock/PM through the normal
`BLOCKED` → escalation path (`state_machine.md` §7). The Observer is not a
shortcut around PM authority.

## Advice is non-binding

Unless `[observer_policy].advice_is_binding` is true (default false),
advice is **advisory only**:

- The **Worker remains accountable** for its own work. Adopting or
  rejecting advice does not transfer responsibility to the Observer.
- If adopting the advice would **change the assignment scope**, the Worker
  must **not** just do it. The Worker transitions to `BLOCKED` and asks
  Dock/PM — Observer advice alone never authorizes scope growth.
- The Worker **records** in its own `report.md`: the advice `request_id`,
  whether it was **adopted or rejected**, and the **reason**. This keeps
  the audit trail intact and makes the non-binding nature explicit.

## Quick reference

| Situation | Observer advice status | What happens next |
| --------- | ---------------------- | ----------------- |
| Allowed question, clear recommendation | `ADVICE` | Worker decides; records adopted/rejected + reason. |
| Allowed question, no clear answer | `NO_OPINION` | Worker proceeds on its own judgment. |
| Forbidden question | `ESCALATE_TO_DOCK_OR_PM` | Worker escalates via BLOCKED; no advice given. |
| Adopting advice changes scope | — | Worker transitions to BLOCKED and asks Dock/PM. |
