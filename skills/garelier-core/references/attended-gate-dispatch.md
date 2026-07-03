# Attended-mode Guardian/Observer gate dispatch

Canonical template for an **attended PM** (dispatch-native, no driver —
`SendMessage`/`Agent` tool calls hand-rolled in-session) to dispatch the
Guardian → Observer gate before merging a producer branch. Fixes the
"hand-rolled prompt / report path / verdict contract every session" class
(W-024; target-project live friction 2026-06-30 to 07-01, 4 cycles) by giving the
attended PM one prompt shape and one report contract to reuse, instead of
reinventing both per cycle.

A jig/Workflow run (`ga-tick`, `ga-gate`) does not need this file — it
already gets the same prompt shape + verdict handling from
`references/mode_e_jig.md`. This file is for the **no-driver, hand-dispatch**
path only.

## When

Before an attended PM merges a producer's branch into `studio`: DEC-090
forbids the PM from producing a gate verdict or performing the gate
verification itself, so Guardian then Observer (fixed order) run as
subagents and the PM only relays their verdicts into the merge request. This
also applies to a held/reworked branch being re-gated. If a driver-run
jig is available, prefer `jig_gate_held` (DEC-090 R3) over hand-dispatch.

## Naming

Agent tool `name` (hard regex, no `:`; `workflow-naming.md` §5):
`ga-guardian-<slug>` / `ga-observer-<slug>`. `<slug>` is the exact kebab
task slug used in the branch and the dispatch board — do not invent a new
one for the gate step.

Gate seats are read-only (no worktree), so `dispatch_prepare.sh` does not run
for them — resolve the gate role's model directly (W-026,
`references/model_routing.md`) and pass it as the Agent tool `model`:

```bash
bun skills/garelier-core/driver/src/dispatch/model_routing.ts \
  --project {project_root} --pm-id {pm_id} --seat guardian   # or --seat observer
```

The `model` field of the one-line JSON is the model to spawn the gate subagent
at (gates default to the `strong` tier, clamped to the PM's model per
`above_pm`); `""` means inherit the dispatcher's model. A non-empty `warnings`
array (e.g. `gate_weaker_than_producer`) flags a gate resolved weaker than the
producers it reviews — non-blocking, but confirm the intent with the user before
gating with it.

## Report contract

Each gate role writes **two** artifacts before ending its turn — its own
canonical role report, and a completion-contract verdict marker the PM
verifies mechanically:

1. Canonical role report (per `garelier-guardian`/`garelier-observer` SKILL.md):
   `__garelier/<pm_id>/_guardians/<id>/guardian_report.md` or
   `__garelier/<pm_id>/_observers/<id>/report.md`. Full findings, evidence,
   redaction rules — this reference does not restate that shape.
2. Verdict marker (what `contract_check.ts` gate mode reads):
   `__garelier/<pm_id>/runtime/<role>/results/<slug>-<role>.md`, containing
   at minimum a `## Verdict` section whose body includes exactly one
   canonical token: `PASS` / `PASS_WITH_NOTES` / `REWORK_RECOMMENDED` /
   `BLOCK` / `NO_OPINION`. Minimal valid body:

   ```markdown
   ## Verdict

   PASS_WITH_NOTES
   ```

Every finding needs file:line/diff evidence (DEC-088) — a bare adjective
verdict is not acceptable. **The gate-role subagent writes the marker
itself**, as the last step before its final message (DEC-090: a verdict is
a gate-role artifact; the PM never authors or republishes it on the role's
behalf). Only after both files exist does the subagent return.

## Prompt templates

Placeholders: `{project_root}` `{pm_id}` `{slug}` `{branch}` `{head_sha}`
`{base_sha}` `{changed_files}` `{blueprint_path}`. Launch with
`isolation: "worktree"` is not needed — Guardian/Observer are read-only
(no worktree). Optionally run
`bun <core>/driver/src/review_gate_prep.ts --role guardian --project {project_root} --base {base_sha} --head {head_sha} --out-dir <container>`
(and `--role observer`) first to generate an advisory review brief —
`<core>` is the `garelier-core` skill directory, per `role_subagent_dispatch.md`
§3 — pass its output path in the prompt if you do.

**Guardian** (`name: ga-guardian-{slug}`):

> You are the Garelier **Guardian** for PM `{pm_id}` at `{project_root}`.
> Load the `garelier-guardian` skill — it is your authoritative procedure
> for scope, redaction rules, and verdict semantics; this prompt does not
> restate them. Review branch `{branch}` (`{base_sha}`..`{head_sha}`,
> changed files: `{changed_files}`) against blueprint `{blueprint_path}`.
> You are the security / privacy / dependency / license / provenance gate
> (secrets, PII, vulnerable/malicious deps, forbidden licenses, dangerous
> auth/crypto/logging/CI/deploy/infra changes) — see
> `garelier-guardian/SKILL.md` for the full checklist. Every finding needs
> file:line or diff evidence (DEC-088) — never assert a verdict without it.
> Before your final message, write BOTH: your canonical
> `guardian_report.md`, and the verdict marker at
> `__garelier/{pm_id}/runtime/guardian/results/{slug}-guardian.md`
> (`## Verdict` section, exactly one of PASS/PASS_WITH_NOTES/BLOCK/NO_OPINION).
> Return only a compact result (verdict, marker path, report path, ≤ 8 lines).

**Observer** (`name: ga-observer-{slug}`):

> You are the Garelier **Observer** for PM `{pm_id}` at `{project_root}`.
> Load the `garelier-observer` skill — it is your authoritative procedure
> for review dimensions and verdict semantics; this prompt does not restate
> them. Independently review branch `{branch}` (`{base_sha}`..`{head_sha}`,
> changed files: `{changed_files}`) against blueprint `{blueprint_path}` as
> a `merge_review` (or `artisan_premerge_review`, if applicable). You are
> commit-free and read-only — see `garelier-observer/SKILL.md` for the full
> review dimensions (design/scope/risk + user-perspective + system-impact).
> Every finding needs file:line or diff evidence (DEC-088). Before your
> final message, write BOTH: your canonical `report.md`, and the verdict
> marker at `__garelier/{pm_id}/runtime/observer/results/{slug}-observer.md`
> (`## Verdict` section, exactly one of
> PASS/PASS_WITH_NOTES/REWORK_RECOMMENDED/BLOCK/NO_OPINION). Return only a
> compact result (verdict, marker path, report path, ≤ 8 lines).

## Post-dispatch verify

When a gate subagent goes idle, verify its completion contract before
trusting its returned verdict — don't just take the final message at face
value:

```bash
bun skills/garelier-core/driver/src/dispatch/contract_check.ts \
  --project {project_root} --pm-id {pm_id} --gate {slug} \
  --roles guardian,observer --format text
```

`ok: false` (exit 3) means a verdict marker is missing or malformed; send
the printed `nudge` to the subagent verbatim (or re-dispatch) rather than
proceeding to merge on the subagent's prose claim alone.

## Merge

Once both markers verify, file the merge request — never hand-write the
JSON (DEC-064 §1):

```bash
skills/garelier-core/scripts/merge_request.sh \
  --project {project_root} --pm-id {pm_id} --branch {branch} \
  --guardian <verdict> --guardian-report __garelier/{pm_id}/_guardians/<id>/guardian_report.md \
  --observer <verdict> --observer-report __garelier/{pm_id}/_observers/<id>/report.md \
  [--preflight '<cmd>']...
```

`--guardian-report`/`--observer-report` bind the verdict to the real report
(DEC-088 group C) instead of an asserted string; `--guardian-review-sha`
defaults to the workbench tip. See `garelier-dock/references/merge-gate.md`
for the full merge-gate lifecycle.

## Mechanical-delta re-gate (W-032)

A branch that already has a full Guardian→Observer verdict (gated once,
merge pending or held) sometimes gains one more commit before merge. Re-
running the full two-role gate for that commit is wasted cost when it is a
**mechanical delta only** — the enumerated set:

- identifier rename with unchanged behavior
- a visibility keyword change (e.g. `pub`/`pub(crate)`) with no signature
  or behavior change
- log/diagnostic line, comment, or doc-only edit
- typo fix or `fmt`-only formatting

Any commit outside this list is not a mechanical delta — run the full
two-role gate above, not this shortcut.

**Procedure:** dispatch a single gate-role subagent — Guardian, since
`merge_request.sh` requires `--guardian` but not `--observer` — using the
same naming/model resolution as above. Its prompt is the standard Guardian
prompt PLUS: review the FULL delta diff (never a worker summary — the gate
role, not the worker's self-label, is what makes "mechanical" structurally
true), read the prior gate's `guardian_report.md`/Observer `report.md`, and
state explicitly whether the delta changes any premise those verdicts
relied on; if it does, escalate to a full two-role gate itself instead of
issuing a lightweight verdict. Guardian writes its report with a
`DELTA-REGATE of <old head SHA>` line naming the previously-gated SHA, plus
the usual verdict marker (§ Report contract). Observer is skipped for this
cycle.

**Boundary (DEC-090 unchanged):** the PM still never authors or asserts a
verdict. A worker's "this is mechanical" claim is not trusted — the single
gate role reads the whole diff and independently confirms it, so a
mislabeled substantive change is caught structurally, not by vigilance.

**Merge request:** bind `--guardian-report` to the NEW delta-regate report
(its own `DELTA-REGATE of <sha>` line is the link back to the prior full
gate — do not point the flag at the stale report):

```bash
skills/garelier-core/scripts/merge_request.sh \
  --project {project_root} --pm-id {pm_id} --branch {branch} \
  --guardian <verdict> --guardian-report __garelier/{pm_id}/_guardians/<id>/guardian_report.md \
  [--preflight '<cmd>']...
```

## Harness message tax note

Every message to a teammate (`SendMessage` reply, `Agent` dispatch) carries
harness-injected boilerplate (system-reminder blocks, tool schemas) that the
PM cannot remove — it is not a Garelier artifact and no Garelier-side change
shrinks it. Minimize round-trips instead: require each dispatched
Worker/Scout/gate subagent to send exactly ONE final message (after its
commit/report is written, never before or mid-task), and do not reply to a
routine driver idle notification — let `contract_check.ts` (or the jig's own
liveness loop) process those mechanically instead of spending a reply on
each one.
