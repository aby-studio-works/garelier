# Librarian reference: registries and runbooks

Detail for `garelier-librarian` §2 / §4 (assignment-lifecycle "Working").
Covers `source_registry.toml`, `routine_registry.toml`, and runbook/manual
authoring.

## source_registry.toml

Path: `docs/garelier/knowledge/source_registry.toml`. The list of
external sources the Librarian may treat as authoritative. Only registered
sources are adopted (SKILL §3). Template:
`../templates/source_registry.toml`.

Fields per `[[sources]]`:

| field | required | meaning |
|---|---|---|
| `id` | yes | unique source id (used by routines + front matter) |
| `title` | yes | human name |
| `kind` | yes | `testing_rules`, `coding_rules`, `review_rules`, … |
| `source_type` | yes | `sharepoint`, `url`, `local_file`, `repo_file` |
| `url` / `path` | conditional | external URL or local path |
| `target` | yes | internal Markdown the content reflects into |
| `transform` | yes | named transform rule (e.g., `coding_rules_v1`) |
| `owner` | recommended | usually `pm` |
| `update_mode` | yes | `manual`, `scheduled`, `on_demand` |
| `trust` | recommended | e.g., `internal-authoritative` |
| `authority` | required for external URL/SharePoint | `official`, `recognized`, `internal`, or `third-party` |
| `license` | required for external URL/SharePoint | `confirmed`, `unknown`, or `not-adoptable` |
| `use` | required for external URL/SharePoint | `internal-policy-source`, `allowed-summary`, or `inspiration-only` |
| `last_reviewed_at` | required for external URL/SharePoint | PM / owner rights review timestamp |
| `last_synced_at` | recommended | ISO timestamp; Librarian updates on each sync |

External source entries also follow
`docs/garelier/security/provenance_rights_policy.md`. `license = "unknown"`
or `"not-adoptable"` must not become tracked authoritative knowledge or be
exported in a knowledge bundle.

## routine_registry.toml

Path: `docs/garelier/knowledge/routine_registry.toml`. The catalogue of
standardized, repeatable work. Its purpose is **re-dispatch**: PM reads a
routine and hands it to whichever role fits next time. Template:
`templates/routine_registry.toml`.

Fields per `[[routines]]`:

| field | required | meaning |
|---|---|---|
| `id` | yes | unique routine id |
| `title` | yes | human name |
| `manual` | yes | path to the runbook |
| `default_role` | yes | usual role: `librarian` / `scout` / `worker` / `smith` / `artisan` |
| `target_file` | conditional | file the routine updates |
| `source_id` | conditional | links to a `source_registry` entry |
| `trigger` | recommended | `manual`, `scheduled`, `on_demand` |
| `risk` | recommended | `low`, `medium`, `high` |

`default_role` mapping guide for PM (record the role that matches the
routine's actual work):

- docs/registry update only → `librarian`
- needs real-state investigation, no commits → `scout`
- needs code change → `worker` (or `artisan` for small end-to-end)
- needs quality/integration verification → `smith`

## Runbooks and manuals

- **Runbook** (`docs/garelier/runbooks/<routine_id>.md`): the
  step-by-step procedure. Template: `templates/runbook.md`. Must contain
  purpose, trigger, default role, inputs, output (target file + format),
  granularity (what to record, what to omit), procedure, completion
  criteria, and escalation conditions (to PM / Scout / Worker / Smith).
- **Manual** (`docs/garelier/manuals/<name>.md`): longer explanatory
  "book" when a runbook needs background. Optional.

A good runbook is reusable: a future run by the `default_role` can follow
it without re-deriving the procedure. If it is too abstract to repeat,
Dock returns it (Librarian Review). Keep granularity explicit (e.g.,
"1 task = 1–3 lines; do not over-detail; always record unresolved risks").

When you write or change a routine, keep the registry entry, the runbook,
and any `target_file`/`source_id` it references mutually consistent.
Run the derived knowledge graph validator after registry/runbook changes; a
dangling routine manual or source reference is a blocking consistency defect.

## git_command_policy.toml (DEC-048)

Path: `docs/garelier/knowledge/git_command_policy.toml`. The Librarian owns it
(SKILL §2) as the single source of truth for which git commands roles may run:
both branch-create idioms are allowed; `push` / `tag` / `pull` / `rebase` /
`reset` are forbidden, each with a recorded reason. The driver's capability
grant is **CI-enforced to mirror** this file, so a capability gap can never
silently deadlock the autonomous flow. Because of that mirror, a change to the
allowed/forbidden set here **forces the matching driver-grant change** — do not
edit one side alone.
