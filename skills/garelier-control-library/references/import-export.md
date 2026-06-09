# Library Import and Export

## Clean knowledge bundle

Use the existing Librarian bundle scripts:

```powershell
garelier knowledge-export -Project <root> -To <dest>
garelier knowledge-import -Project <root> -PmId <id> -From <bundle>
```

```bash
garelier knowledge-export --project <root> --to <dest>
garelier knowledge-import --project <root> --pm-id <id> --from <bundle>
```

Import stages only; it never directly adopts tracked knowledge. Export is
tracked-only and refuses blocking rights/secret/PII conditions.

## Messy import

1. Stage raw input under `runtime/librarian/raw/`.
2. Inventory each source, rights basis, intended use, conflicts, and candidate
   category in `runtime/librarian/reports/`.
3. Draft canonical documents under `runtime/librarian/drafts/`.
4. Register sources before adopting external claims.
5. Reconcile meaning conflicts with the knowledge owner; never silently merge
   incompatible rules.
6. Update indexes/registries/runbooks, validate the graph, then promote only
   reviewed curated results into `docs/garelier/`.

## Export

1. Validate the graph.
2. Confirm tracked state, provenance, rights, secret/PII hygiene, and review
   dates.
3. Export to an explicit empty destination.
4. Review the manifest before sharing.
