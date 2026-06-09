# SharePoint Test Rules Sync Runbook

Installed path: `docs/garelier/runbooks/sharepoint_test_rules_sync.md`
Default role: Librarian
Risk: medium
Registry source: `company-test-policy`

## Purpose

Refresh generalized project testing rules from the registered internal
SharePoint policy source. Treat the external page as source material only; do
not copy its wording or structure into project docs.

## Preconditions

- `docs/garelier/knowledge/source_registry.toml` contains source
  `company-test-policy`.
- The source entry records `authority`, `license`, `use`,
  `last_reviewed_at`, and `last_synced_at`.
- PM approval exists for accessing the SharePoint source.

## Procedure

1. Read the source registry entry and confirm the target path.
2. Fetch or receive the current SharePoint policy content through the approved
   project mechanism.
3. Compare it against the current target Markdown.
4. Rewrite the target as original project guidance, preserving only generalized
   rules and citing the source id in front matter or comments.
5. Update `last_synced_at` in both the registry entry and target Markdown.
6. Report changed topics, skipped material, and any licensing or PII concern.

## Blocking Conditions

- Source is not registered or metadata is incomplete.
- License is `unknown` or `not-adoptable` and PM has not approved handling.
- Target Markdown contains raw copied policy text.
- `last_synced_at` differs between target Markdown and source registry.
