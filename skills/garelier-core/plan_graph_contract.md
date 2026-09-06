# Garelier Control schema-3 plan graph

Schema 3 is `storage = "plan_graph_markdown"`. Markdown bodies are canonical;
strict TOML front matter carries only machine-indexed fields.

## Layout

```text
control/
├── control.toml
├── project_dashboard/
│   ├── README.md
│   ├── current.md
│   ├── roadmap.md
│   ├── backlog.md
│   ├── decisions.md
│   ├── risks.md
│   ├── quality_gates.md
│   └── notes.md
├── roadmaps/
├── milestones/
├── backlog/
│   ├── open/
│   └── archive/YYYY/
├── backlog_views/
├── checkpoints/
│   ├── active/
│   └── archive/YYYY/
├── risks/
│   ├── open/
│   └── archive/YYYY/
├── notes/
├── blueprints/
├── decisions/
├── operations/
├── inspections/
├── observations/
├── reports/
├── delegation/
├── request_intake/
├── scheduled_jobs/
└── templates/
```

All eight Dashboard files remain tracked mixed authority. `current.md` and
`notes.md` are parsed durable memory; the others retain curated view text.
Generated index regions are optional; when markers exist they must be a single,
ordered pair, and rendering never changes marker-external text.

## Canonical model

```text
Roadmap * -> * Milestone
Milestone * -> * child Milestone   (DAG, shared child allowed)
Milestone * -> * prerequisite Milestone (dependency DAG)
Backlog  * -> * Milestone
Backlog  * -> * Backlog view
Current  -> ordered active Checkpoints
Checkpoint -> Roadmap/Milestone/Backlog
Risk -> typed references and mitigation Backlog
Note -> any typed reference
```

- User/UI/CLI/type/directory noun: Backlog. Stable IDs remain `W-NNN`.
- Roadmap owns Roadmap→Milestone edges.
- Parent Milestone owns child edges.
- A Milestone owns its prerequisite edges in `depends_on`, using exact
  Milestone slugs. Missing targets and direct/transitive dependency cycles are
  strict errors with the complete cycle path.
- Backlog owns Backlog→Milestone edges.
- Backlog owns Backlog→view membership; a view file owns purpose, selection,
  ordering, and exit policy, and is retired rather than deleted after use.
- Inverses are derived and never stored as a second canonical edge.
- One Backlog may belong to zero or more Milestones.
- Multiple Roadmaps may be active.
- Milestone containment cycles are errors.
- Milestone dependency cycles are errors.
- Risk records use `garelier_risk`, carry severity/likelihood, and live under
  `risks/open/` until terminal `closed`/`superseded` records move to
  `risks/archive/YYYY/` with closure evidence.

Typed-reference list fields hold `kind:id` refs, and a bare `W-NNN` is
accepted everywhere as shorthand for `backlog:W-NNN` (the `W-` prefix is
unique to Backlog ids in this schema) — but the *kind* of typed ref accepted
depends on the field, not just its shape:

- `related` (on every record kind — Backlog, Checkpoint, Risk, Note,
  Decision, Blueprint) is a general cross-kind link: any `kind:id`, e.g.
  `backlog:W-NNN`, `decision:DEC-NNN`, `checkpoint:CP-NNN`.
- `depends_on`, `blocked_by` (Backlog), `mitigation_backlog` (Risk), and
  `backlog` (Checkpoint) may **only** reference a Backlog — the bare `W-NNN`
  shorthand still applies, but a typed ref there must carry the `backlog:`
  prefix specifically; a typed ref of any other kind (e.g. `decision:DEC-1`)
  is invalid for these fields even if that target exists.

The canonical, on-disk form is always the typed form — the bare shorthand is
an input convenience, not a second stored representation.

Milestone `depends_on` is separate from the typed-reference lists above: it
stores exact Milestone slugs. Pre-contract `dependency_targets` remains a
compatibility-read field. A bare phase token such as `m17` resolves only when
it uniquely prefixes one Milestone slug (`m17-*`); `W-NNN` entries are retained
as legacy Backlog targets but are not Milestone graph edges. A dependency
mutation migrates resolved legacy Milestone targets into canonical
`depends_on` without discarding those legacy Backlog targets.

`control milestone update <slug> --add-dependency|--set-depends-on` starts from
a strict model and the staged/final model must remain strict. A remove-only
update is the narrow repair exception: its preload may contain only Milestone
dependency cycle/missing/ambiguous-target errors, while all other strict errors
still block. It can remove several edges atomically with repeated
`--remove-dependency owner=target`; session binding, expected Control revision,
namespace lock, staging, generation journal, rollback, and recovery remain
mandatory, and the staged/final graph must be fully strict-valid.

Every relation has owner-local immutable `rel-NNN`; its global selector is
`(owner typed-ref, relation_id)`. Only duplicate active owner/kind/target edges
are errors. Retirement preserves the edge. Re-adding the endpoints creates a
new relation ID; retired relations are never reactivated.

Each relation row contains `id`, target `slug`, relation-specific attributes,
`state`, `added`, and `updated`. A retired row also contains `retired` and
`retire_reason`. Roadmaps use `milestone_links`; Milestones use `child_links`;
Backlogs use `milestone_memberships` and `view_memberships`. Timestamps are
RFC 3339 (date-only input is compatibility-read only).

### Backlog edge and Milestone inheritance

- `control backlog create` and `control create backlog` accept `related` and
  `depends_on` typed edges. By default a new Backlog inherits every active
  Milestone membership of the Backlogs reached by those edges.
- `inherit_milestones = false` (CLI: `--no-inherit-milestones`) opts a Backlog
  out of that inheritance. `milestone = "none"` explicitly marks an
  intentionally cross-cutting Backlog and suppresses the unbound warning.
- Strict validation stays read-only for directly authored Markdown. When both
  `related` and `depends_on` are empty, it scans the title/body for `W-NNN`
  references and emits actionable typed-edge candidates. If those candidates,
  or existing typed edges, reach Milestone-bound Backlogs, validation also
  reports the memberships that can be inherited. It never edits authority.
- `plan_graph_milestone_backfill.ts` provides the attended existing-store path:
  dry-run reports `row -> candidate milestones` with reference snippets;
  `--apply` requires the reviewed control revision and an open session, and
  inserts only `milestone_memberships` frontmatter blocks.

## Durable memory

- `current.md`: standing instructions, current position, one primary active
  Checkpoint, ordered candidates, next queue, blockers, verified baseline, and
  read-first pointers.
- Backlog: outcome, acceptance, current position, exact next action, evidence,
  resume data, notes, and revision history.
- Checkpoint: last completed, in progress, exact next action, repository state,
  commands/results, blockers, assumptions, read-first, do-not-repeat, and
  resume verification.
- Notes: durable project notebook. Promotion links a destination but never
  deletes or automatically summarizes the source.

## Lifecycle

Create, update, remove-from-active-view, retire-relation, archive, and purge are
different operations.

- Active Backlog, active Checkpoint, and Current pointer activation form one
  crash-recoverable helper transaction in shared/automated operation.
- Terminal Backlog/Checkpoint transition and archive move form one helper
  transaction.
- Decision lifecycle is `proposed -> accepted|rejected|superseded` and
  `accepted -> superseded`; `rejected` and `superseded` are terminal.
- Blueprint lifecycle is `draft -> active|archived`,
  `active -> blocked|verification|archived`, `blocked -> active|archived`,
  `verification -> active|blocked|shipped|archived`, and
  `shipped -> archived`; `archived` is terminal.
- Schema-3 Decision and Blueprint status changes use
  `control transition decision|blueprint <id> --to <status> --session <id>
  --expect-control-revision <revision>`. They use the same namespace lock,
  staged strict reload, generation journal, atomic replacement, rollback, and
  recovery as other helper mutations. Invalid transitions, malformed artifact
  front matter, and stale Control revisions fail before a canonical write.
  `rejected`, `superseded`, `shipped`, and `archived` record `closed`, and an
  `archived` Blueprint also records its archive timestamp; artifact files
  remain in their canonical directory.
- `control artifact-create decision|blueprint --id <DEC-NNN|slug>
  --metadata-file <json> --body-file <markdown> --session <id>
  --expect-control-revision <revision>` is an optional helper; validated
  direct Markdown authoring remains canonical. Decision paths are
  `decisions/<DEC-NNN>-<safe-title-slug>.md`; Blueprint paths are
  `blueprints/<slug>.md`. Create generates kind, identity, initial
  `proposed`/`draft` status, `created`, and `updated`; the body H1 never owns
  identity. Decision metadata accepts only `title`, `related`, and
  `supersedes`; Blueprint metadata accepts only `title`, `related`,
  `backlog_ids`, `decision_ids`, and `acceptance_ids`.
- `control artifact-update decision|blueprint <DEC-NNN|slug>
  [--metadata-file <json>] [--body-file <markdown>] --session <id>
  --expect-control-revision <revision> --expect-revision <updated-ms>`
  requires at least one input. The entity precondition is keyed by
  `decision:<id>` or `blueprint:<slug>` and is the integer millisecond value
  of canonical `updated`; existing Backlog/Risk second-based revision keys do
  not change. A semantic update writes
  `max(transaction_now, prior_updated + 1ms)`, while a no-op preserves every
  byte. Update preserves the canonical owner path, identity, kind, status,
  lifecycle fields, and every omitted metadata field.
- Artifact metadata JSON is a closed object; duplicate or unknown keys fail.
  `related` is normalized flat typed-reference metadata and every target must
  resolve uniquely. Decision `supersedes` accepts existing
  `decision:DEC-NNN` references only. Blueprint `backlog_ids` and
  `decision_ids` accept existing canonical IDs of their named kind;
  `acceptance_ids` are unique non-empty stable labels. These fields never
  create `rel-NNN` rows or relation retirement history.
- Artifact input files are untrusted data. Metadata is capped at 64 KiB and
  body Markdown at 8 MiB; both must be real regular UTF-8 files whose path and
  identity remain stable during read. Symlink/junction/reparse traversal,
  invalid UTF-8, NUL, TOML-front-matter bodies, unsafe/reserved identities,
  duplicate/case-folded identities within the same artifact kind, globally
  case-folded owner paths, and malformed references fail before canonical
  replacement. Decision and Blueprint identities are kind-qualified, so the
  same spelling may exist once in each kind. Staging, strict reload, namespace
  lock, generation journal, atomic replacement, and rollback cover the complete
  Control tree. Schema 3 has no per-artifact seal or `integrity` field.
- Normal Backlog progression does not skip directly from `triage` or `ready`
  to `verification`. The sole recovery exception is
  `landing-finalize --plan/--apply`: an already-landed merge with canonical
  durable passing gate evidence may move `triage|ready|active` to
  `verification`. The finalizer revalidates sealed request/result payloads,
  ordered zero-exit steps, configured gate commands, required review bindings,
  exact role and studio refs, Git ancestry, plan digest, and Control
  revision. It preserves acceptance/evidence, never closes or archives, permits
  a claimless historical row, and releases only a matching non-stale claim with
  compensating restoration if final Control validation fails.
- Relation removal retires by default.
- Purge is a separate fail-closed command. It requires an empty/error duplicate
  with no references or unique information, explicit reason, reachability
  proof, and a durable purge manifest. Unknown sharing requires user approval.
- Direct Markdown edits remain valid when the complete result passes strict
  validation. A direct multi-file edit is a coherent Git change, not a claim of
  filesystem atomicity.

## Resume and efficiency

Resume loads Current, the primary/ordered Checkpoints, referenced Backlogs,
nearby Milestone/Roadmap graph, relevant artifacts/Notes, and gates. It never
scans or embeds the full control tree.

Ordering and byte limits are deterministic. Truncation returns omitted counts
and exact follow-up queries. Cache under `runtime/control/cache/` is disposable
and cannot write authority.

For interruptible target work, `begin-action` records intent and repository
state before the target-workspace mutation; `finish-action` records result and
the next action. The control write that records intent is not itself the target
mutation.

## Validation minimum

Strict validation checks:

- kind/path/schema/front-matter validity and duplicate IDs;
- broken/self/duplicate-active relations, Milestone containment cycles, and
  direct/transitive Milestone dependency cycles with an actionable path (a bare
  `W-NNN` in a typed-reference list resolves as `backlog:W-NNN` before the
  target-existence check; any other id must already carry its `kind:`
  prefix; `depends_on`/`blocked_by`/`mitigation_backlog`/Checkpoint
  `backlog` additionally reject a typed ref of any kind other than
  `backlog:`, even when that target exists);
- lifecycle timestamps and state/path mismatch;
- missing Current/primary Checkpoint and stale pointers;
- active Backlog/Checkpoint missing resume fields;
- terminal status missing closure evidence;
- retired relation missing retirement metadata;
- purge without manifest/reference/reachability proof;
- generated marker drift without changing marker-external content;
- repository/evidence drift through `control reconcile --git`.
