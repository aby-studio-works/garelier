# Garelier Control Contract

This is the compact routing contract for persistent project control. Load this
file first, then only the schema-specific contract selected by `control.toml`.

## Authority

- Durable authority: `__garelier/<pm_id>/control/`.
- Transient sessions, claims, locks, journals, caches, diagnostics, and
  generated views: `__garelier/<pm_id>/runtime/control/`.
- There is no third persistent `state/` tree.
- Runtime data may accelerate or coordinate control, but must be rebuildable
  from tracked authority and must never overwrite it as a cache side effect.

## Schema routing

Dispatch by the exact pair in `control.toml`, never by directory presence.

| Canonical schema | Storage | Contract | Status |
| --- | --- | --- | --- |
| 3 | `plan_graph_markdown` | `plan_graph_contract.md` | required |

Every version/storage pairing other than schema 3 with `plan_graph_markdown`
fails closed.

Runtime records, CLI response envelopes, and bundle
manifests have independent protocol versions. They carry
`control_schema_version` and storage where ambiguity is possible; changing
canonical control schema does not bulk-renumber those protocols.

## Shared read and write rules

- Query, graph, validator, Status Web, import/export, and resume use the
  schema-3 plan graph model.
- Reads are bounded and deterministic. If output is truncated it reports exact
  omitted counts and follow-up queries.
- A read must not omit current position, blockers, or exact next action while
  implying they are absent.
- Direct authoring permitted by a schema remains authority after strict parse
  and validation.
- Helper mutations use expected revision/content hash, namespace lock, staged
  strict reload, generation journal, atomic replacement, rollback, and
  recovery.
- Schema-3 Decision and Blueprint lifecycle changes use
  `control transition decision|blueprint <id> --to <status> --session <id>
  --expect-control-revision <revision>`. They are helper mutations: stale
  Control revisions, invalid transitions, and malformed artifacts fail closed.
  Direct Markdown authoring remains valid for artifact content, but not as a
  substitute for this revision-protected lifecycle operation.
- Schema-3 `artifact-create decision|blueprint` is an optional atomic helper
  for canonical Markdown authoring. It requires bounded regular UTF-8
  metadata/body files, an exact Control revision, closed kind-specific
  metadata, and a body with exactly one non-empty H1. Schema-3
  artifact bodies reject standalone complete-tag CommonMark type-7 HTML lines;
  fenced code and bounded HTML block types 1–6 remain valid inputs. Schema-3
  artifact identity uniqueness is case-folded within each named kind;
  Decision and Blueprint may share an identity, while owner paths remain
  globally case-folded. Schema-3
  `artifact-update decision|blueprint <id>` additionally requires the typed
  artifact revision (`Date.parse(updated)` milliseconds), replaces only
  supplied fields, preserves owner path/identity/status/lifecycle, and does
  not churn bytes or timestamps for a no-op. Neither helper introduces the
  schema-2 `integrity`, seal, or numeric revision model.
- Full-Garelier concurrent roles use runtime sessions and claims. Claims
  represent live occupancy; durable Checkpoints represent resumable work.
- Schema-3 `landing-finalize --plan/--apply` repairs an already-gated,
  already-landed `triage`/`ready`/`active` Backlog from its typed durable
  gate/merge evidence. It runs the canonical sealed gate validator, binds the
  result to the requested role branch/tip and configured studio
  branch/base, rechecks Git ancestry, and rejects expired or heartbeat-stale
  claims. Apply requires the exact plan digest and Control revision,
  transitions only to `verification` (the recovery-only
  `triage|ready -> verification` exception), preserves evidence and acceptance
  criteria, never closes or archives, and releases only a matching live claim
  with compensating claim/session restoration on final transaction failure;
  claimless historical recovery is valid.
- Schema-3 Backlog `title` is the exact non-empty text after
  `# W-NNN:` in the record H1. The parser exposes that one projection to task
  mirror, Status, and `control cockpit`; Current position and Exact next action
  are resume data, never title fallbacks.
  Pre-contract H1s without the identity prefix remain readable for migration
  and are counted as `legacy_import`; an H1 with a mismatched identity is
  malformed and fails closed.
- `control cockpit [--top-n N]` is a read-only, deterministic schema-3 view.
  Counts are complete while samples are bounded. It reports canonical
  Checkpoint/Backlog focus plus `landed_state_drift`, `focus_drift`,
  `missing_ac`, `legacy_import`, `unblocked_ready`, warning, cleanup, incident,
  bypass, and malformed-row indicators. Malformed Backlog rows remain visible
  and make the command fail closed instead of disappearing from the count.
- `control backlog triage-batch --plan/--apply --file <toml>` only validates
  and applies reviewed decisions; it never chooses them. The TOML root requires
  `schema_version = 1`, `kind = "garelier_backlog_triage_batch"`,
  `reviewed_by`, `reviewed_at`, and one or more `[[decision]]` tables. Every
  decision binds `id`, `action`, and `expect_revision`. `keep` is a no-op;
  `transition` requires a valid nonterminal `to`; `cancel` requires `reason`;
  `supersede` requires `reason` and an existing `replacement`. Unknown keys,
  IDs, actions, duplicates, stale revisions, invalid lifecycle changes, or
  malformed TOML reject the entire batch before writes. Apply additionally
  requires the reviewed plan digest and Control revision, then uses one
  Control file-plan transaction for all rows and the canonical archive layout
  for terminal actions.
- `control transition-batch --file <toml>` moves N entities through their
  lifecycle in one Control file-plan transaction. The TOML requires one or more
  `[[row]]` tables binding `kind`, `id`, and `to`, with optional `reason`,
  `replacement`, and `checkpoint`; unknown keys reject the batch. Each row is
  planned by the same code path as single-row `control transition`, so the state
  matrix, evidence gate, reason/replacement requirements, chronology, and the
  three-write Backlog activation plan apply per row with no batch-only relaxation.
  Terminal Backlog, Checkpoint, and Risk targets still require the atomic
  terminal+archive operation. All-or-nothing is structural: every row is planned
  before any write is emitted, so a rejected row aborts the batch with the
  canonical tree untouched and nothing to roll back. Two rows may not target the
  same entity or write the same file — notably two Backlog activations, which
  would each derive `project_dashboard/current.md` from its pre-batch state — and
  such a batch fails closed instead of committing a last-writer-wins result.
- The CLI never commits. The accountable role commits each coherent result
  after its gate.
- Quality-gate authority is the schema-3
  Dashboard policy document (`project_dashboard/quality_gates.md`) plus the
  setup execution config (`_crew/pm/setup_config.toml [quality_gate]`, parsed by
  `config.ts`).

## Completion

A schema change is complete only when:

1. its model, validator, query/resume, graph, CLI, Status Web, import/export,
   scaffold, skills, role integrations, and documentation agree on schema 3;
2. non-canonical version/storage rejection tests remain green;
3. all framework tests, typecheck, document sync, Guardian, and Observer pass.
