# Management Workflow

Resolve `control.toml` first. Schema 3 is the only supported Control format;
reject schemas 1/2 and unknown combinations explicitly.

## Session start

1. Resolve project root and `pm_id`; if multiple namespaces exist and none was
   named, list them and ask.
2. Read the compact control contract.
3. Open a schema-3 session and request bounded resume:

   ```bash
   garelier control session-open --project <root> --pm-id <id> --agent <provider> --format json
   garelier control context --project <root> --pm-id <id> --resume --format json
   ```

4. Read Current, the primary/ordered Checkpoints, their exact next actions,
   blockers, and read-first pointers. Compare recorded branch, HEAD, modified
   files, and gate baseline with repository reality.
5. Read only referenced Backlogs, nearby Milestone/Roadmap graph, relevant Note
   sections, Decisions, and gates. Resolve drift before resuming.

## During schema-3 work

- Create a new concrete planning/execution unit as Backlog and link every
  applicable Milestone. Do not force a single membership.
- Multiple active Roadmaps are valid. Share a Milestone across Roadmaps or
  parents instead of copying it. Milestone containment is a DAG.
- Activate Backlog, active Checkpoint, and Current pointer in one lifecycle
  transaction. A partial activation is invalid.
- Before any interruptible repository mutation, long command, migration, or
  archive operation, run `begin-action`: record exact next action, targets,
  branch/HEAD/working tree, success condition, and failure checks; validate the
  Checkpoint before the target action.
- Immediately after the action, run `finish-action`: record last completed,
  actual result/changed files, new assumptions/blockers/risks, recaptured
  repository state, and the next exact action.
- Flush unfinished state before a user reply, compact/clear, task/provider
  switch, external wait, commit boundary, or session stop.
- Record user ideas/corrections, design dialogue, rejected rationale, and open
  hypotheses in durable Notes before switching topics. Promotion adds a typed
  relation; it never deletes or summarizes away the source.
- Update only the smallest authoritative record set for the event. Derived
  progress updates indexes, not every ancestor body. Reading or formatting
  alone does not advance `updated`.
- Direct Markdown authoring is valid after strict whole-model validation,
  except that Decision/Blueprint status changes use `control transition
  decision|blueprint <id> --to <status> --session <id>
  --expect-control-revision <revision>`. Stale revisions, malformed artifacts,
  and invalid transitions fail closed. Shared/automated multi-file activation,
  archive, relation retirement, purge, and other revision-protected changes use
  the crash-recoverable helper transaction.
- Decision transitions are `proposed -> accepted|rejected|superseded` and
  `accepted -> superseded`. Blueprint transitions are
  `draft -> active|archived`, `active -> blocked|verification|archived`,
  `blocked -> active|archived`, `verification -> active|blocked|shipped|archived`,
  and `shipped -> archived`. Supply `--reason` for blocked/rejected/superseded/
  archived transitions.
- Use RFC 3339 timestamps. `created` is immutable; `status_changed`, `closed`,
  and `archived` change only on their named lifecycle event. Semantic changes
  to scope, relations, acceptance, or replacement receive Revision history.

## Stop, compact, interruption, and handoff

Even when work is incomplete:

1. Update affected Backlog Current position.
2. Update Checkpoint last completed, in progress, exact next action, partial
   files, commands/results, blockers, assumptions, and repository state.
3. Update Current only when global focus, active Checkpoint order, next queue,
   standing instruction, project-wide blocker, or verified baseline changed.
4. Strict-validate. Record unfinished gates honestly; do not mark Backlog done.
5. WIP commit is optional; branch/HEAD/working tree capture is mandatory.
6. Release live claims and close the runtime session after durable flush.

## Completion and archive

- Verify every acceptance criterion, required gate, evidence binding, and Git
  reconciliation.
- Transition terminal Backlog status and move it to `backlog/archive/YYYY/` in
  one atomic lifecycle operation. Preserve body, evidence, relations, and ID.
- Complete/archive relevant Checkpoints before removing Current pointers.
- Re-evaluate parent/child Milestone and Roadmap exits, but never auto-ship or
  auto-complete them.
- Advance Current next queue. Never delete Notes.

## Relation retirement and purge

Removing from an active view, retiring a relation, archiving a record, and
purging a file are distinct operations.

- Relation removal retires the owner-local `rel-NNN` with timestamp and reason.
  A retired edge is never reactivated; re-adding endpoints allocates a new ID.
- Purge is exceptional and fail-closed. It requires an explicit reason, proof
  of no unique information, full reference/reachability checks, and a durable
  purge manifest. Unknown sharing requires user approval.
- Cache, unadopted atomic temp files, and generated marker contents may be
  rebuilt. Reports, Evidence, and tracked archives are
  not cache.

## Unsupported formats

Schema 1, schema 2, unknown versions, and storage mismatches are rejected
explicitly. No command upgrades or reinterprets them.

## Diagnosis and Status Web

Run strict doctor and `reconcile --git`. Treat malformed authority, lifecycle
path mismatch, missing Current/Checkpoint, dangling/cyclic relations, missing
terminal evidence, unmanifested purge, or generated marker drift as findings,
not permission to guess or delete.

Status Web is loopback and read-only by default. It uses the same ControlModel
for Roadmap selection, shared/nested Milestone graph, Backlog memberships and
archives, Checkpoint resume, and Note heading/filter views.
