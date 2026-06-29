# Control Splitting

Splitting extracts part of one control namespace into another namespace. A
common path is separating one initiative from `_workshop` into a named
`pm_id`.

It does **not** automatically split project-wide knowledge, git history,
runtime, role homes, worktrees, branches, setup configuration, or lane locks.
Those require separate explicit decisions. `__garelier/__atmos/knowledge/` remains shared
project knowledge unless the user is splitting the project itself.

## Safety model

1. Require one source `pm_id`, one distinct destination `pm_id`, and explicit
   control-relative selections.
2. Run the split helper without `-Apply` / `--apply` first.
3. Apply only to stage selected source files under the destination's gitignored
   `runtime/import/split/<batch>/`; never write destination `control/` directly.
4. Preserve the source namespace unchanged.
5. Analyze inbound/outbound references and decide whether each dependency is:
   copied, rewritten as a cross-PM pointer, duplicated as an approved policy, or
   intentionally left shared.
6. Normalize and review drafts before promoting them into destination
   `control/`.
7. Validate both source and destination graphs after promotion.
8. Remove moved authority from the source only in a separate user-approved
   commit after the destination is proven complete.

## Stage a split

Selections are relative to the source `control/` tree. Select canonical records,
not just dashboard summaries.

```bash
garelier control-split \
  --project <root> \
  --from-pm-id _workshop \
  --to-pm-id payments \
  --select milestones/payments.md \
  --select blueprints/payments-api.md \
  --select decisions/DEC-012-payment-provider.md

garelier control-split \
  --project <root> \
  --from-pm-id _workshop \
  --to-pm-id payments \
  --select milestones/payments.md \
  --select blueprints/payments-api.md \
  --select decisions/DEC-012-payment-provider.md \
  --apply
```

When the destination does not exist, apply initializes it as `control_only`.
Run the `garelier-pm` fresh setup wizard later with the same destination id to
upgrade it to full Garelier without changing its identity.

## Reconciliation rules

- Rebuild destination dashboard files from the extracted canonical records;
  never copy `_workshop` hot summaries wholesale.
- Copy only open backlog/risks belonging to the separated scope.
- Give destination decisions unique IDs where collisions exist and preserve
  provenance to source IDs.
- Treat operations and quality gates as shared project policy by default. Copy
  only when the destination truly needs an independently owned policy.
- Keep source records until destination validation and user-approved cutover
  complete.
