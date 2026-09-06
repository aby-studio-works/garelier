# Reuse routing — warm serial reuse vs fresh spawn (W-191)

When a role seat finishes a row, the PM can either **reuse** it — keep the
same warm subagent and hand it the next row via `dispatch_prepare --reuse
<agent>` — or **spawn fresh**. This is the operational guidance for that choice,
the sibling of `model_routing.md` (which model on which seat) and `entry_routing.md`
(which surface). The mechanical part is enforced/measured for you: the hard rules
are guards in `dispatch_prepare` (a mismatch hard-fails), and the soft signal is an
overlap `reuse_hint` the delta block already carries. This table is the *why* the
PM reads alongside that hint.

## The rule: reuse when the next row shares the seat's warm working set

The full dispatch contract (standing constraints, commit/kill/terminate rules,
long-job policy) is a fixed token cost paid at **first spawn**. A reuse pays it
**once** and hands each subsequent row a delta only. Reuse is right when the warm
context is an asset for the next row; fresh is right when carrying that context is
a liability (stale subsystem knowledge) or a correctness requirement (independence).

| Choose | When | Why |
| --- | --- | --- |
| **Reuse (warm serial)** | Same row family / same milestone's next slice; high touch overlap; the seat's own BLOCKED→answered continuation; a bundle of small nibbles in one lane. | Warm context saves the spec re-read AND continues the implementation thread — the same reasoning that keeps a role *consistent* (see `model_routing.md`). Cost is a delta, not a preamble. |
| **Fresh — REQUIRED** | A **gate seat** (Guardian/Observer); a **different role**; a **different pm_id or repo scope**; a **risk-class** row (security/schema/determinism/save/cooker). | Independence and identity are not economies to trade away. A gate must read independently (DEC-090); cross-role/-repo/-pm reuse carries the wrong fence and contaminates context (measured harm, W-191d/e). These are the `dispatch_prepare` **hard guards** — a reuse that violates them fails closed. **Carve-out (§C1):** a same-seat WARM delta *re-gate* of a rework is allowed — but that is the `gate_field_manual` §C1 mechanical-delta continuation (same engagement, the seat holds the finding = the check spec, not a stake), NOT a `--reuse` across dispatches, which stays banned. |
| **Fresh — RECOMMENDED** | A **subsystem shift** (touch overlap ≈ 0); the seat hit a **rotation threshold** (long context / many rows consumed); early **quality-drift** signs. | This is a *capacity* concern, not an independence one: a bloated or drifting context degrades output. Rotating to a fresh seat is the cheap insurance. Not a hard rule — the PM decides. |

## The mechanical overlap hint

`dispatch_prepare --reuse <agent> --touches '<globs>'` emits a `reuse_hint`:

```json
{ "overlap_pct": 62, "basis": "touched_packages",
  "recommendation": "reuse", "reason": "62% touched_packages overlap — same working set…" }
```

- **basis** — `touched_packages` (semantic working set) when both the prior record
  and the new dispatch carry package metadata, else the raw `touches` globs, else
  `none`.
- **overlap_pct** — Jaccard overlap (|∩| / |∪|) of the two sets.
- **recommendation** — `reuse` at `overlap_pct ≥ 40`, `fresh` at `≤ 10`
  (subsystem shift), `reuse` (with a rotate-if-drifting caveat) in between. With
  `basis: none` it still recommends `reuse` (a warm seat saves the preamble) but
  flags that the PM must confirm same-family from the row itself.

The hint is **advisory**. The PM makes the call; the hard guards above make the
unsafe calls impossible regardless.

## Spec drift is delivered, not summarized (W-191 c)

A reuse is not a blind continuation: the seat may have been briefed on a governance
file (`[prompt] spec_files` in `setup_config.toml`) that has since changed. Each
dispatch stamps those files' git versions into its record; a `--reuse` diffs the
stamped versions against current and attaches `git diff` for the **changed files
only** (a stable governance set sends nothing). The reused seat's one-line contract:
**apply each attached spec diff as a rule update to how it works the current row.**

The stamp is the **committed** blob SHA (`git rev-parse HEAD:<file>`), so a spec
edit reaches a reuse only once it is **committed** — an uncommitted change to a
governance file will not surface in the delta. Commit the rule change first, then
rely on reuse to carry it (W-191 G note ii).

## Relationship to the fresh-eyes rule (W-192)

W-192's fresh-eyes principle — *fresh is required when existing context holds a
stake in the judgment* — is the deeper root of the "Fresh — REQUIRED" gate/role
rows here. Reuse economizes the **role** side (consistency is a virtue there);
it never economizes a **verifier's** independence. The two rules agree: warm the
role thread, keep every gate cold.

The authoritative statement of the principle — the 5 stake categories, the
compact-fresh default, and the 5-axis warm/fresh rationale (role warm /
verifier fresh) — lives in `gate_field_manual.md` §D. This section is its reuse-side
face; §D is its gate-side face.
