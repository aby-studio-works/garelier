# Producer register contract

This is the single provider-neutral reference for a dispatched role's final
register. `dispatch_prepare.ts::renderFullRegisterTemplate` renders the exact
starting form into every initial prompt and follow-up. Do not reconstruct a
short form from this prose.

Before delivery, re-read the current `instructions.md`, complete every
generated `[[instruction]]` row, and fill every mandatory evidence section in
the rendered template. A proxy lane keeps exactly one `=== COMMIT PLAN ===`
block and `=== END COMMIT PLAN ===` as the final non-empty line. Re-issued
registers use the full rendered form again.

Validate the producer file before delivery:

```bash
bun skills/garelier-core/driver/src/scripts/register_check.ts <producer-register> \
  --instructions <dispatch-container>/instructions.md
```

The command calls `provider_session.ts::inspectCapturedRegister`, the same
function used after launcher capture and before Dock proxy transcription. It
names every detected repair and exits non-zero; it does not mutate the
register. Front matter may contain any valid TOML value. The driver-owned
review binder preserves those values and changes only its own bound fields.

Provider transport changes the producer leaf, not the register grammar:

- attended Claude: `lane/register.md`, captured by the driver as `report.md`;
- Codex proxy: `lane/result.md`, which is also the captured leaf.

The prompt is authoritative for the resolved absolute paths and supplies the
complete template. This file is the stable contract pointer for the PM,
Worker, and provider playbooks.
