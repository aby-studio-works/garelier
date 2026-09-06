# Blueprint output contract

This is the single shared reader/receiver contract for a blueprint's
`Output definition` section. Role entrypoints point here instead of copying the
rules. The blueprint is the authority for **what** the result is; a dispatch
prompt or task file resolves only **where this invocation writes it**.

## 1. Authority split

Every blueprint defines all four output dimensions:

1. **Artifact kind** — code, documentation, tests, an inspection, or a control
   artifact.
2. **Format** — the applicable template plus the required register and commit
   plan shape, when any.
3. **Mandatory elements** — fields or evidence the output must contain, such as
   one standalone `review_sha` line, a census denominator, or the recorded run
   of a required counterfactual.
4. **Destination kind** — verdict file, inspection, Backlog/row body, register,
   or a role final response captured by its launcher. The resolved
   slug/date/dispatch-specific path belongs only in the prompt or task file.

A path in a prompt is routing data, not permission to define or alter the
artifact's kind, format, or mandatory elements. A prompt must not restate those
three dimensions. If it does, or if its resolved path is incompatible with the
blueprint's destination kind, stop and return the conflict to PM rather than
choosing one locally.

## 2. Reader contract

Before acting, every Worker, Scout, Guardian, Observer, Smith, Librarian,
Artisan, and Concierge reads the blueprint's `Output definition` section and
checks all four dimensions above. If the section is absent, contains an
unresolved placeholder, or omits a dimension needed to decide the result, the
role returns its defined blocking outcome (`BLOCKED`, `BLOCK`, or
`REWORK_RECOMMENDED`) and does not invent an output shape.

The role then produces the exact artifact kind and format and includes every
mandatory element. For a captured role result, the role returns that
artifact as its final response and the trusted launcher writes the resolved
path; the role must not pre-write the capture file. For a role-owned verdict,
inspection, or control artifact, the role writes only its resolved path.
Framework-wide templates and parsers remain a floor: a blueprint may specialize
them but never remove a mandatory parser field or weaken a role/security
boundary.

## 3. Receiver contract

An output that does not conform to the blueprint is not accepted:

- PM does not proxy-commit a role register or commit plan that fails the
  declared format or mandatory elements.
- PM treats the launcher-captured role final response as the gate input;
  compact progress-register rules never justify removing blueprint-required
  evidence from that response.
- Guardian and Observer do not return `PASS` / `PASS_WITH_NOTES` when the
  reviewed artifact, or their own verdict, omits a declared mandatory element.
- Librarian verifies registered-source and generated knowledge artifacts before
  offering them for shelf integration.
- Concierge verifies the output definition before any merge, tag, push, or
  other remote effect; a mismatch blocks before the irreversible boundary.
- Every other role/receiver keeps the artifact in rework or blocked state
  until it conforms.

## 4. Mechanical boundary

Machine-readable invariants stay machine-enforced. For example,
`merge_request` / `merge_land` require exactly one standalone lowercase
40–64-hex `review_sha` line through the canonical gate parser, and role
templates carry that field. A prompt may carry the **resolved output path
only**; it must not carry output-format or mandatory-element sections. That
boundary is judged by the gate seat on content (`gate_field_manual.md` §A-0),
not by a heading allowlist — the machine refuses only the two mechanism-owned
headings and the field shapes (W-708, 2026-09-05).

Blueprint-specific semantic evidence is intentionally heterogeneous. A census
denominator, a counterfactual run, or the required contents of an inspection
cannot be safely inferred from arbitrary Markdown by one generic parser. Until
those requirements have a typed schema and artifact-specific validator, the
reader and receiver checks above are the fail-closed enforcement. Absence of a
generic parser is never permission to accept a missing element.
