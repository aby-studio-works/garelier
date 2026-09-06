# Garelier Dock Compatibility and Reminders Reference

Operational reminders, compatibility guidance, and related references.

Extracted from the previous role `SKILL.md`; legacy section numbers are intentionally preserved for cross-references.

## §13. Things to remember

- The user is not your interlocutor. PM is. Talking to PM via files
  is your only user-facing channel.
- Keep `runtime/manifest.md` accurate, but never treat it as control authority.
  Schema 3 uses bounded plan-graph reads; PM-owned shared/automated mutations
  use revision-checked CLI transactions. Schemas 1 and 2 are rejected.
- The merge gate is fail-closed for workbench/Anvil merges. Unclear →
  investigate, not merge. Base-tracking is the one exception: you
  resolve those conflicts yourself.
- A blueprint that needs PM clarification gets escalated, not guessed.
- The Worker/Scout/Smith state machine in
  `../../garelier-core/state_machine.md` is authoritative.
  If your behavior conflicts with it, fix your behavior, not the
  document.

## §14. Compatibility

Requires `garelier-core`.

## See also

- `../../garelier-core/SKILL.md`
- `../../garelier-core/protocol.md`
- `../../garelier-core/state_machine.md`
- `../../garelier-pm/SKILL.md`
- `../../garelier-worker/SKILL.md`
- `../../garelier-scout/SKILL.md`
- Restructure DEC: DEC-001
- Rename DEC: DEC-003
