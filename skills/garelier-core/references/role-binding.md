# Role binding authority

Role work is runnable only when the canonical, versioned binding under
`__garelier/<pm_id>/runtime/dispatch/bindings/<binding_id>/` has both phases:

1. `generation-N/authorization.json` — issued by PM/Dock/coordinator from the
   exact Work revision, assignment, prompt, role/carabiner, route, integration
   base, resolved Lens sources, resolved two-layer Knowledge sources, and an
   immutable content-addressed snapshot of the initial instruction ledger.
2. `generation-N/launch.json` — written by the launcher/attended parent only
   after the provider returned an exact session/agent handle and successful
   result evidence.

`current.json` selects one generation. Ready files, context/pickup packs,
provider self-reports, and report fields are pointers only. Consumers re-read
the canonical records and source hashes. Unknown versions, malformed canonical
JSON, a changed source, missing launch acknowledgement, mismatched execution
identity, stale generation/digest, or replayed session fail closed.

## Execution identities and transports

- Dispatch roles bind `{kind:"dispatch", id}`.
- Held/branch-only and Artisan satchel roles bind the full branch ref through
  a role-scoped branch hash. A branch-only flag cannot authorize another branch.
- Recorded Codex/Claude CLI, exact-session resume, attended Agent, warm reuse,
  and lane dispatch all use the same issuer and validator.
- Empty/blocked preparation emits `runnable:false` and no authorization or launch
  acknowledgement. Launchers reject bindingless input.

### Launch acknowledgement authority

"Role authority that affects launch" means the immutable binding core
selected by `current.json`: its execution identity, generation/digest, Work,
assignment/blueprint/prompt hashes, role/carabiner, routing, Lens, Knowledge,
integration base, and initial-instruction snapshot. The launcher validates the
live source paths against that core immediately before it starts the provider.
The later launch acknowledgement records the returned handle and the bound
prompt hash against the same generation/digest; it does not re-read mutable
source paths.

Therefore, a blueprint commit made after the provider started (for example, a
new gate-round section) cannot rewrite or invalidate the historical launch.
It is still rejected by resume/report/close/merge source-freshness admission
unless delivered through the canonical instruction/update path. A change that
really alters producer launch authority must issue a replacement binding
generation; acknowledgement of the superseded generation/digest remains
refused. This split preserves both facts: post-launch planning may advance, and
producer permissions cannot be silently changed under an existing launch.

## Instructions, close, and merge

Authorization snapshots the initial `instructions.md` bytes under
`runtime/dispatch/initial-instructions/<content-hash>.md` and binds that
immutable file as source authority. The dispatch-local `instructions.md`
remains a mutable append/consume ledger whose canonical path is bound
separately; changing it does not rewrite or invalidate the initial authority.

Post-launch instructions are append-only, sequenced records. Each must have a
delivery acknowledgement bound to the launched session. At reporting, close,
merge-request, and merge-gate admission, every `[[instruction]]` table must be
consumed (`checked = true` carrying non-empty `consumed`) and the ledger must
contain each issued token and message-digest prefix. Resume
still validates the immutable snapshot and canonical instruction/delivery
chain, but permits pending ledger work. Prose or a role-authored substitute
is not authority. Deleting, renaming, duplicating, reordering, or rewriting an
initial `[[instruction]]` table/evidence, or substituting the ledger path, fails
closed; only setting `checked = true` on that same table and filling its
`consumed` value is permitted.

The admission controller/Dock writes `close.json` only after validating current
sources, launch, instruction deliveries/ledger, candidate SHA, and report hash.
`merge_request.ts` requires that close receipt and embeds its binding reference.
`merge-gate.ts` re-validates the same canonical generation immediately before
checkout/merge, so a queued request superseded while waiting is refused.

Schema-3 Backlog item authority keeps the exact row-byte `content_hash` plus a
semantic hash that excludes the four lifecycle fields `status`, `updated`,
`status_changed`, and `transition_reason`, together with the typed
`evidence_refs` records written by claim/merge lifecycle operations; those
fields need no gate evidence. When the same Backlog row is also the assignment,
the binding stores and validates that semantic item authority once instead of
adding a second exact assignment hash. Every other frontmatter field and the row
body remain authority, so changing them still fails closed. Thus the Backlog
Outcome's prohibition on unaudited authority changes remains in force while a
claim refresh does not invalidate unchanged Outcome/AC/body authority. After a
passing Guardian or Observer verdict, the
coordinator may run `dispatch_prepare.ts --rebind-authority --id <N> --evidence
<gate-verdict-path>` to append a generation-local admission transition from the
old item hash to current canonical row bytes. `--candidate-sha <full-sha>` uses
the same evidence-bound append path for a reviewed post-close candidate; neither
`authorization.json` nor `close.json` is rewritten. The transition chain binds
the Work, predecessor/new authority, optional predecessor/new candidate,
an immutable, content-addressed generation-local snapshot of the verdict
bytes/hash, its mutable
runtime result path as provenance only, reviewed branch/SHA, writer, and
timestamp. Later admission validates the snapshot, never the overwrite-prone or
prunable runtime result. Missing, non-passing, stale, cross-branch, or
non-canonical evidence is refused.

The verdict evidence binds the reviewed branch and commit; it does not itself
bind or approve the corrected Backlog row text. The transition independently
binds the exact new row authority bytes, preserving that separation.

The snapshot pins verdict bytes, not the parser grammar used to interpret them.
Because every chain replay parses the snapshot again, tightening the parser is
a breaking change for existing chains unless the old accepted grammar remains
readable or a versioned-grammar migration lands first. This is a known
compatibility property; this change preserves the historical grammar rather
than adding transition schema/version scope.

The rebind CLI additionally requires Control schema 3, mutually consistent
dispatch `context.json` and `control_binding.json`, a resolvable bound branch tip,
and a live claim for the bound Backlog in the bound Control session. In particular,
an expired claim must be restored through its authorized lifecycle before
rebind; the evidence flag alone cannot revive a sleeping lane. When
`--candidate-sha` is present, it must equal both the current branch tip and the
verdict's reviewed SHA.

One `close.json` remains single-consumed, but its admission contract now covers
the gate-validated candidate chain rooted at that receipt rather than only its
initial candidate SHA. Each later candidate is admitted only by an ordered,
immutable-evidence transition; the receipt itself remains byte-identical.

## `role_recovery`

`role_recovery` is the only migration/replacement path for stale or legacy
in-flight role work. It is shared by Worker, Smith, Librarian, and Artisan;
it grants no additional permission. A new generation must bind:

- the current Work authority/revision, execution route, Lens, Knowledge, and base;
- the superseded digest;
- a path + content-hash inventory of preserved WIP when WIP exists (an empty
  inventory is canonical for a fully committed, clean worktree);
- an explicit dependency re-audit and all-acceptance-criteria re-audit.

When recovery targets an existing numbered dispatch under Control schema 3,
the coordinator also revalidates that dispatch's canonical Work/session, exact
WIP-derived touches, and integration ref/base. An existing context may advance
from its old base only when that full SHA is an ancestor of the current tip of
the same integration ref; divergent/rewound lineage, a changed ref, or any
changed branch/session/touch identity is refused. The coordinator takes the
same-session Control claim and publishes the matching `control_binding.json`
before advancing authorization. An old binding advances by atomic replacement
only when its non-base identity and old base exactly match the validated
context; authorization failure restores that old record and releases only the
claim created by the attempt. The launcher then canonically republishes context
from the new authorization. This restores ordinary dispatch aftercare rather
than changing the recovered role to `branch_only`; merge admission validates
the exact context-bound recovery identity while retaining the numbered dispatch
binding.

The replacement requires a new real launch acknowledgement. The old generation
is immediately inadmissible. Recovery never treats an authorized-but-unlaunched
generation or a spawn/ack crash as success, never destroys WIP, and still emits
the role's ordinary report and gates.

Implementation source: `driver/src/dispatch/role_binding.ts`. Path and
ownership authority remain in `protocol.md`.
