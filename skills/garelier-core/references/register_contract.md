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

The REQUIRED GATE block is a set of exact project-declared command lines. Its
line order carries no authority: the Dock runner owns execution order after it
has verified that every mandatory line is present and every added line matches
an allowed prefix. Each command line may appear exactly once; duplicates,
missing, altered, and undeclared lines fail closed before any step executes.

In a proxy COMMIT PLAN, list every changed path literally as one `- <path>`
line. There is no file-count ceiling and no indirect list-file path; the Dock
passes the admitted literal set to Git through a NUL-delimited stdin pathspec.
The role trailer work id must be either the dispatch-bound work id or one of the
bound blueprint's `backlog_ids`.

## Instruction consumption writers

Re-read the current `instructions.md` immediately before the final register and
account for every `[[instruction]]` entry. The consumption writer depends on
the seat, not on which transport delivered the instruction:

| seat | one authored `consumed` value | other surface |
| :-- | :-- | :-- |
| Claude direct-ledger | Set `checked = true` and non-empty `consumed` in `instructions.md` before REPORTING. | Declare the consumed instruction in the register; the ledger is the authored evidence. |
| Codex proxy | Declare `checked = 'true'` and typed `consumed = '''artifact:<project-relative-path>'''` or `consumed = '''commit:<40hex>'''` in the register before REPORTING. | The proxy driver derives the ledger's `checked` and `consumed` values from the register; do not edit those ledger fields. |

For Codex proxy, a previously checked ledger row that adds an instruction
summary after the same artifact is normalized to the register value. A
different artifact or other genuine conflict is refused with both values;
correct the cause and re-issue the full register. Capture alone does not prove
consumption; proxy transcription checks the digest, checked state, and full
consumed value. State `ledger N/N consumed` in either seat's register.

The prompt is authoritative for the resolved absolute paths and supplies the
complete template. This file is the stable contract pointer for the PM,
Worker, and provider playbooks.
