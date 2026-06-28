# Lens Packs

Lens Packs let PM select a role's judgment focus without changing that role's
authority.

A Lens Group is not a persona and not a permission profile. It cannot change
write paths, MUST BLOCK conditions, role contracts, merge authority, external
write authority, or handoff format.

## Storage

Fresh setup seeds the shared Lens registry under:

```text
__garelier/__atmos/lens_registry.toml
__garelier/__atmos/lenses/*.toml
```

The PM defaults live in:

```toml
[lenses.defaults]
worker = "worker.implementation:minimal_patch"
guardian = "guardian.risk_control:strict"
```

## Blueprint And Assignment Flow

PM may add a `## Lens selection` section to a blueprint. Dock's deterministic
assignment renderer resolves the active role Lens with this precedence:

1. CLI `--lens`
2. blueprint `## Lens selection`
3. `setup_config.toml` `[lenses.defaults]`
4. no explicit Lens

The generated assignment includes `## Equipped lens` so the producer sees the
resolved focus without re-parsing the blueprint.

Example blueprint section:

```markdown
## Lens selection

- Source: explicit PM choice
- PM: `pm.planning:specification_first`
- Worker: `worker.implementation:minimal_patch`
- Guardian: `guardian.risk_control:strict`
- Observer: `observer.review:architecture`
- Librarian: `librarian.source:strict`
- Concierge: `concierge.external_ops:explicit_only`
```

Omit role rows that should use `[lenses.defaults]`.

## Validation

`lenses.ts validate-registry --garelier-root __garelier` validates registry
entries, Lens Pack roles, active groups, and forbidden authority-like fields
such as `allow_promote`, `ignore_role_contract`, or `relax_must_block`.
