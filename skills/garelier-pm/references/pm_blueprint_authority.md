<!-- absorbed-from: garelier-pm/SKILL.md ## Blueprint authority contract -->

# Blueprint authority contract

Moved out of `garelier-pm/SKILL.md` (W-599): the PM entrypoint carries the index,
not the procedure. This file is trigger-loaded from the routing table in that SKILL.md.

A blueprint is the pre-dispatch canonical statement of the **correct result**.
Every executing and reviewing role derives judgment from it; a prompt, task
file, or follow-up only points to that authority and carries dispatch-specific
mechanics.

Every blueprint states these eight things as concrete, reviewable content:

1. **Why the Backlog exists** — the observed harm, reproduction conditions,
   and measured facts.
2. **Derivation from governing rules** — exact document/section pointers and
   the correct result derived from them.
3. **PM decision** — when multiple valid choices exist, the selected choice and
   why.
4. **Predicates to satisfy** — mechanically or independently decidable
   conditions; "be careful" is not a predicate.
5. **Refutation** — evidence that distinguishes completion from a vacuous pass,
   including the relevant counterfactual.
6. **Gate focus** — the complete set of points gate roles judge for this
   blueprint; unstated preferences are not later promoted into gate criteria.
7. **Out of scope** — work owned by another Backlog or intentionally excluded.
8. **Output definition** — the result's artifact kind (code, documentation,
   tests, inspection, or control artifact); format (including any template,
   register shape, and commit-plan shape); mandatory elements (for example one
   standalone parser-valid `review_sha`, a census denominator, or evidence that
   a required counterfactual actually ran); and destination kind (verdict file,
   inspection, Backlog/row body, or register). The dispatch resolves the
   concrete slug/date/path; the blueprint does not.

A blueprint does **not** contain either of these changing runtime facts:

- dispatch-specific state such as tip SHA, completed base tracking, concurrent
  dispatches, which stage runs the gate, or a resolved output path;
- a role-result summary that the receiver can read from the canonical
  `result.md` / report.

A prompt/task file may carry the concrete destination path only. It must not
add a heading or field for output format, mandatory elements, or artifact
contents; needing one means the blueprint is incomplete. Since W-708 the
section contract no longer refuses an unknown heading (only the two
mechanism-owned ones and the field shapes), so this boundary is a content
judgement the gate seat enforces per `gate_field_manual.md` §A-0 steps 1-5,
not something the heading check catches: `verdict file` path is dispatch data,
while what belongs in that verdict is blueprint authority.

All dispatched roles and PM as receiver apply
`../garelier-core/references/blueprint-output-contract.md`. PM does not
proxy-commit a role register/commit plan that violates the output
definition. A role receiving a blueprint without a complete output definition
returns its defined blocking/rework outcome instead of choosing a format. Gate
roles do not PASS an artifact that omits a declared mandatory element, and
Concierge checks conformance before any external effect.

Write and commit the blueprint before dispatch; a role dispatch is not ready
without its explicit `--blueprint` authority. If a running role reveals
something else the role or gate must know, treat that as a blueprint gap:
update the blueprint authority, record what changed and why in its revision
history (or the Backlog register), and commit it. Never copy the new rule into a
prompt or follow-up body.

To deliver that committed revision to the exact running session, write only a
compact pointer instruction and append
`--blueprint-update-commit <full-commit-sha>` to its emitted `resume_cmd`.
`provider_session.ts` verifies that the commit contains the bound blueprint path
and that its text matches the current authority after checkout line-ending
normalization. It records the path, commit SHA, current content hash, and
immutable committed-content hash in the canonical instruction chain, then adds
a `git show "<sha>:<path>"` read pointer for the role. The ordinary
instruction-ledger and delivery acknowledgement remain required. A current
blueprint hash that is neither the originally bound hash nor a delivered
instruction-chain hash is still refused as `source changed`.
