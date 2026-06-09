# Lazy-load reading order & driver batch boundary

Two framework-wide conventions every role shares: how much to read on a given
iteration (lazy-load), and how far to run under one driver prompt (the batch
boundary). The per-role SKILL.md cites this; the hard rules in each role file
always apply on top.

## §1. Lazy-load reading order (DEC-032)

Keep each iteration small. Read only what the current task needs, in this order,
stopping once you have what you need:

1. The **SKILL routing row** for your current state / task — each role SKILL.md
   has a routing table mapping your state to the single reference to open. Read
   that row and only the reference it names.
2. The **on-demand reference** for the active task only — do **not** bulk-load
   every reference or every core document when the current state does not need
   it. Load `protocol.md` only when you need file ownership / path / branch-push
   rules, `state_machine.md` only before a state transition, `compact_handoff.md`
   only before writing coordination files, and `output_control.md` only before
   composing your provider final response.
3. **Compact JSON sidecars before full Markdown.** When a matching JSON sidecar
   exists (`report.json`, `review.json`, `guardian_report.json`,
   `concierge_report.json`, `inspection.json`), read it first for fast
   routing/status; open the full Markdown record only when you need the detail.
   When writing, keep the Markdown as the official human-readable record and
   write the compact sibling JSON too — the JSON is for routing/status only; do
   not duplicate the Markdown body inside it.

Knowledge retrieval follows the same progressive discipline — see
`references/knowledge-consult.md` (role_index → category index → graph/registry
→ term search → only the necessary topic section).

## §2. Driver batch boundary

**One iteration handles one assignment only.** In headless driver mode, run a
bounded batch for the **current** assignment/inspection/task rather than stopping
after an artificial single state step. You may continue across the phases of one
assignment — e.g. pickup → implementation → report, pickup → investigation →
inspection draft, pickup → hardening → report, or (Artisan) planning →
implementation → hardening → self-review → merge — **only while**:

- the scope is unchanged and the work remains coherent (and, per role, sources /
  coverage window / lane / authority / safety are clear), and
- every phase boundary leaves a **durable checkpoint**: `STATE.md`, a commit, a
  checkpoint entry, the report/inspection draft, a notification, or a question.

**Stop promptly when there is no action to take.** Stop at `REPORTING`,
`BLOCKED`, a review/merge/ack wait, lane/approval uncertainty, any point where a
PM decision is required, or any uncertainty. **Never pick up a second assignment
in the same iteration.**

When a role is in a marker-waiting state (`REPORTING`, `REVIEWING`, an ack wait),
the dispatch substrate / driver does **not** spawn the role again until the
awaited marker appears (`under_review.md`, `review.md`, `merged.md`,
`committed.md`, `acked.md`, `answers.md`, or `abort.md`), so the waiting state
costs no provider tokens. In interactive mode, print a short "no action: <STATE>;
awaiting <marker>" line when asked to run.

The **dispatch substrate runs each role to completion** for its assignment: the
batch boundary bounds one iteration of one role; the substrate, not the role,
decides when to re-spawn it for the next marker or assignment.

## See also

- DEC-032 (thin role-skill entrypoints + references)
- DEC-002
- `references/knowledge-consult.md`, `compact_handoff.md`, `output_control.md`
