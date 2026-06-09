# Delegation

This directory defines PM-to-PM delegation boundaries.

It is deliberately separate from `request_intake/`:

- `delegation/` says which remote PMs this project knows about and
  which capabilities this PM is willing to offer.
- `request_intake/` validates incoming request branches and normalizes
  accepted requests into runtime inbox records.

Delegation never bypasses PM. A remote PM can ask for work, but the
local PM still interprets the request, applies local policy, and routes
through the normal PM -> Dock -> Worker / Scout / Smith chain.

## Layout

```
__garelier/<pm_id>/control/delegation/
├── README.md
├── remote_pms.toml             outgoing PM registry
└── capability_registry.toml    capabilities this PM may accept
```

## Invariants

- Remote PMs are enrolled explicitly in `remote_pms.toml`.
- Incoming `source_pm` values must also appear in
  `request_intake/allowed_sources.toml`.
- A request kind is accepted only when all three checks pass:
  `allowed_request_kinds.toml`, `capability_registry.toml`, and the
  relevant remote PM policy.
- Commit-producing delegation is default-off.
- Production writes, promote, deploy, secret changes, and external
  customer email never become automatic remote commands.
