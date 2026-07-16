# Design-campaign playbook — study → adversarial review → bold rebuild

Field-derived pattern (2026-07-14, a large-scale engine-restructure design cycle:
two studies, four review rounds, one campaign DEC in a single day) for taking a
**structural redesign** ("remove this architectural split", "unify these two
systems") from a user's hunch to an approved, dispatchable campaign — without
the design rotting into opinion. Generalized; no project-specific content.

## 1. The two-tier study/review cycle

**Tier 1 — census-grounded study (worker-tier model, e.g. opus).**
A read-only Scout produces the design study. Non-negotiables:

- **Census first, opinion second.** Every claim maps ACTUAL code (file:line)
  onto the design vocabulary. A unification study enumerates both sides
  system-by-system before saying "these are twins". The census table IS the
  deliverable; the conclusion is derived from it.
- **The honest-residue section.** A study that finds "everything unifies" is
  suspect. Require a 真の残余 section: what genuinely does NOT flatten, with
  evidence. (Field result: one residue claimed, and review reduced even that
  to a data-parameter difference — but the section forced the argument.)
- **Deliverable = file, message = pointer.** The study is a runtime/ draft the
  PM later accepts into control/inspections.

**Tier 2 — adversarial review (senior/judgment-tier model, e.g. Fable).**
A second agent reviews the study. Non-negotiables:

- **Spot-check the citations, don't trust them.** The reviewer re-opens N of M
  file:line claims and reports the hit rate (field: 8/8, 10/11 — an off-by-one
  caught). A review that never opens a file is prose, not review.
- **Verdict vocabulary: STUDY_SOUND / STUDY_NEEDS_REWORK** + a re-investigation
  list (R-list) written as instructions the study author can execute verbatim.
  "なし" must be said explicitly when the list is empty.
- **Reviewer continuity.** The same reviewer re-judges rev.N+1 (it holds the
  context and its own R-list); a fresh reviewer restarts the argument.
- **The reviewer designs, too.** Part 3 of the review is a counter/strengthened
  proposal (e.g. recasting an incremental migration into the bold campaign
  form) — review that only criticizes wastes the strongest model in the room.
- Loop until STUDY_SOUND, then the PM drafts the DEC from study + review.

**Why two tiers**: the census is high-volume reading (worker-tier is enough and
cheaper); the judgment — "is this claim load-bearing", "which stages are
incrementalism" — is where the senior tier pays for itself. One agent doing
both self-grades its own homework.

## 2. Bold-rebuild campaign form (V → B → D)

When the user chooses reconstruction over incremental migration ("リスクを
取ってでも再構築、レガシー削除"), the migration plan takes this shape:

- **Phase V — oracle fixation.** BEFORE any deletion: fix the verification
  net's own holes (a determinism gate that only hashes half the state is the
  first fix, with a NEGATIVE test proving the gate actually fails on injected
  drift), capture goldens from the legacy implementation, and build a legacy
  census script (grep-count of every symbol scheduled to die — close = 0).
  **Gate G-V is the ONLY ordering constraint bold keeps**: no delete-commits
  until the net is green.
- **Phase B — direct construction.** Build the target structure directly; the
  legacy code stays as a **read-only oracle**, never as a facade-swap
  intermediate ("replace re-exports gradually" is incrementalism — delete it
  from the plan). Workstreams are parallel by design, serialized only by build
  resources. Gate G-B: the new substrate reproduces the V-phase oracles.
- **Phase D — bulk deletion.** One campaign-close deletion of the legacy
  (crates, aliases, compat shims), unlocked by G-B, closed by census=0 +
  resource measurements.
- **Baselines must be format-neutral.** If the campaign changes a serialization
  format, capture V-phase baselines as semantic projections (field-by-field,
  final-state, completion flags), not bytes — byte comparison only within one
  format. Otherwise G-B cannot compare across the break.
- **The bundling rule (壊れるものは 1 回で壊す).** All format-breaking changes
  ride ONE version bump (no migration writer; explicit reject of old data
  where the project's save discipline allows). All folder/crate surgery rides
  ONE re-org (merge any pending crate-split plans into it). Things that do NOT
  share a breaking surface do NOT get bundled — a second campaign with its own
  V→B→D beats one mega-campaign whose equivalence surface explodes.
- **Risk is managed by verification, not by increments.** Rollback unit = the
  campaign. State the residual risks honestly (oracle holes = the real risk
  surface; performance floors as the defense line; resource ceilings).

## 3. Full-backlog triage vocabulary (post-DEC re-planning)

After a campaign DEC, re-triage EVERY open row against it ("手戻りの少ない
方向"). One disposition per row:

| Disposition | Meaning |
| --- | --- |
| CAMPAIGN-ABSORB | The row IS a campaign workstream item; independent dispatch would be rework. Name the phase. |
| FREEZE | Touches the surface the campaign rewrites, but isn't part of it — do after close, on the new substrate. |
| EVAPORATE | The campaign's delete/rewrite makes it moot — retire with a citation to the phase that kills it. |
| MERGE-INTO | Duplicate/subset of another row — consolidate. |
| PARALLEL-OK | Independent of the campaign surface — runs concurrently, with a priority band. |
| BLOCKED-EXTERNAL | Waiting on a named external (user/review/vendor). |

Then verify the re-plan: an **Observer completeness pass** (every pre-triage id
accounted for; absorbed content actually present in the campaign row text) and
a **docs-consistency pass** (the plan vs the spec corpus — each divergence is
either a plan bug or a named docs-update item inside the campaign).

## 4. PM practices that made the cycle work (pointers, not restatement)

- **Planned-queue discipline**: proceed from the plan's head; new items go
  through evaluate-and-reflect; a user question is not a dispatch directive
  (garelier-pm `references/autonomous-mode.md` §15.4 — the canonical text).
- **DEC provenance trail**: record the user's actual directive sentences
  (verbatim, dated) in the DEC — approval of a bold campaign must be traceable
  to explicit user words, and each mid-flight user refinement gets relayed to
  running agents AND recorded in the DEC/backlog in the same turn.
- **Decision points go to the user as options** (2-4 options with a
  recommendation, previews where visual), not as open questions; fold the
  answers back into the DEC as a 確認結果 section.
- **発見即起票**: every gate note / review NOTE / census finding becomes a row
  or a DEC line in the turn it appears; a review NOTE that "carries to phase X"
  is written into phase X's row text, not remembered.
- **Verify "already done" before dispatching**: `git log --grep '<id>'` (and
  the parent item's id — follow-ups often land under the parent) before any
  dispatch; a stale row costs a whole producer run.
- **Design review before high-stakes dispatch (DEC-076)** iterates to a passing
  verdict and records the reviewer + verdict in the blueprint sign-off; the
  reviewer's non-blocking NOTEs become acceptance criteria of later phases.

## See also

- `references/pm_playbook.md` — dispatch/merge operational judgment
- `garelier-pm/references/planning/blueprint-authoring.md` §4 — DEC-076 review
- `garelier-pm/references/autonomous-mode.md` §15.4 — planned-queue discipline
- `references/attended-gate-dispatch.md` — gate verdict contracts (W-065/W-073)
