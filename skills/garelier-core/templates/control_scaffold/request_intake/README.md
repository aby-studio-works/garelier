# Request Intake

This directory holds the policies, schema, and allowed-source / allowed-kind
registries that govern incoming requests delivered via git webhook (typically
from Jenkins).

The framework ships the contract, bootstrap scaffold, and a dependency-free
local reference handler. A target project still wires its own webhook
receiver to the handler; the receiver is deliberately environment-specific.

A "request" in this sense is an asynchronous **delegation to PM**: another
PC, another repository, or a scheduled job pushes a request branch
that names a PM action to take. The request is never a direct command
to a Worker, Scout, or Smith; it is always a *PM-handled* item.

```
request branch
   ↓  (git push triggers webhook)
Jenkins (validation only)
   ↓
request_intake handler (validation + normalization)
   ↓
runtime/requests/inbox/      ← TOML, machine-readable
runtime/pm/inbox/            ← Markdown, human-readable
   ↓
PM
   ↓
Blueprint / Scout inspection / Worker task / Smith hardening / Dock
```

## Layout

```
__garelier/<pm_id>/control/request_intake/
├── README.md                     this file
├── request_schema.md             field-by-field schema for request.toml
├── delegated_request_policy.md   what is and isn't allowed
├── allowed_request_kinds.toml    enumeration of request kinds
├── allowed_sources.toml          enumeration of permitted source PMs
├── webhook_policy.md             rules Jenkins / webhook receiver must follow
└── templates/
    ├── request.toml              canonical machine-readable format
    └── request.md                canonical human-readable companion
```

Persistent reports go to `__garelier/<pm_id>/control/reports/requests/<request_id>.md`.
PM-PM delegated requests additionally produce
`__garelier/<pm_id>/control/reports/delegated_requests/<request_id>.md`.

Transient state (inbox, processing, processed, rejected, failed,
locks) lives under `__garelier/<pm_id>/runtime/requests/`.

## Reference handler

The local reference implementation lives in the core skill, outside this
project scaffold:

```bash
garelier request-intake \
  --project-root /path/to/project \
  --request-dir /path/to/request-branch-export \
  --request-branch garelier/request/<target_pm>/<source_pm>/<request_id>-<uid> \
  --target-pm <local_pm_id>
```

```powershell
garelier request-intake `
  -ProjectRoot C:\path\to\project `
  -RequestDir C:\path\to\request-branch-export `
  -RequestBranch garelier/request/<target_pm>/<source_pm>/<request_id>-<uid> `
  -TargetPm <local_pm_id>
```

The webhook receiver still owns signature checks, git fetch/checkout, and
branch cleanup. The handler only validates `.garelier/request.toml`, writes
accepted requests to `runtime/requests/inbox/`, writes PM notifications to
`runtime/pm/inbox/`, and writes rejection reports when validation fails. It
never executes request-provided commands.

## The two-file convention

A request branch carries two files at the top level under
`.garelier/`:

- `.garelier/request.toml` — machine-readable, validated against
  `request_schema.md` and `allowed_request_kinds.toml`.
- `.garelier/request.md`   — human-readable companion (context,
  rationale, follow-ups).

Neither file may carry arbitrary shell commands, scripts, or
arbitrary parameter sets that map to shell invocations. The
allowable `kind` values are enumerated; each kind has a fixed
parameter shape defined by `request_schema.md`.

## Mandatory rules (summary)

For details see `delegated_request_policy.md`.

1. The request branch MUST follow the format
   `garelier/request/<target_pm>/<source_pm>/<request_id>-<short_uid>`.
2. The receiving PM MUST only process branches whose `<target_pm>`
   segment matches its own id (from `_pm/setup_config.toml`).
3. `source_pm` MUST appear in `allowed_sources.toml`.
4. `kind` MUST appear in `allowed_request_kinds.toml`, MUST NOT have
   `allowed = false`, and MUST appear in the target PM's capability
   registry (per
   `__garelier/<pm_id>/control/delegation/capability_registry.toml`).
5. The request CANNOT request `promote`, deploy, secret change, or
   external customer email. Production write is accepted only when the
   capability allows it and data-change guards are present.
6. The request CANNOT carry a `command` field, a `script` field, or
   any shell-invocation field.
7. Duplicate detection by `request_id` AND by request commit SHA.
8. After completion or rejection, the request branch is deleted.

## Inbox normalization

When a request is accepted, the intake handler writes:

```
__garelier/<pm_id>/runtime/requests/inbox/<request_id>.toml
__garelier/<pm_id>/runtime/pm/inbox/<YYYYMMDD-HHMMSS>-request-<request_id>.md
```

The TOML is the validated, normalized version of the original
request file. The Markdown is what PM reads on its next iteration
— it is structured per `templates/request.md` and includes the
restrictions PM must honor.

PM treats this as **a delegation from another PM**, not as a user
instruction. The Markdown explicitly tags it.

## See also

- `delegated_request_policy.md` — what's allowed, what's blocked
- `request_schema.md` — field-by-field schema
- `webhook_policy.md` — what Jenkins / the webhook receiver must do
- `../delegation/README.md` — the receiving-side capability and
  routing model
- `../operations/data_change_policy.md` — guards that apply even
  when the request crosses PCs
