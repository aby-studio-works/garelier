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

`dispatch_prepare.sh`'s JSON (and the `context.json` it writes) carries these
verbatim under `gate_agents.guardian`/`gate_agents.observer` (`name` +
`report` + `verdict_template`, W-040/W-020) — read them from there instead of
hand-building the strings above when the producer was dispatched through
`dispatch_prepare.sh`. `report` is the SINGLE canonical verdict-marker path
(`runtime/<role>/results/<slug>-<role>.md`) — the exact path
`contract_check.ts --gate` and `merge_land.sh`'s verdict auto-read both parse, so
copy THAT into the gate request rather than retyping one that can drift.
`verdict_template` (`skills/garelier-core/templates/gate_verdict.md`) is the marker's
canonical starting point — paste it into the gate prompt so the role writes a
`## Verdict` bare-token marker the parser reads, not free prose (§ Report contract).

Gate seats are read-only (no worktree), so `dispatch_prepare.sh` does not run
for them — resolve the gate role's model directly (W-026,
`references/model_routing.md`) and pass it as the Agent tool `model`. The
producer's own `dispatch_prepare.sh` JSON already carries this resolved value
under `gate_agents.guardian.model` / `gate_agents.observer.model` (W-049) —
prefer reading it from there over re-running the resolver by hand:

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

**MANDATORY (W-049):** the Agent tool call that spawns the Guardian/Observer
subagent MUST set `model:` to this resolved value explicitly. The Claude Code
Agent tool inherits the PARENT (PM) session's model when `model` is omitted —
there is no error, no warning at spawn time, just a subagent silently running
at the wrong tier. This has happened in production (a target project, 2026-07-11:
one worker + four gate subagents ran at the PM's own model because `model` was
left off the Agent tool call). Treat a missing `model:` param on a gate/producer
spawn as a bug in the dispatch, not an acceptable default.

## Task-list mirroring (W-040)

Mechanize the harness Task list from the dispatch instead of hand-building
it: once `dispatch_prepare.sh` succeeds, `TaskCreate` one Task from its JSON
(`metadata`: backlog id, dispatch id, `agent_name`). For the gate step, reuse
that same JSON's `gate_agents.guardian`/`gate_agents.observer` `name`/
`report` verbatim (see Naming above) — never re-derive them by hand. Once
the merge succeeds and `dispatch_cleanup.sh` removes the `_dispatch<N>`
container, `TaskUpdate` the Task to `completed` — that removal is the only
"done" signal (a producer marking its own Task `completed` mid-gate is not).
Re-run

```bash
bun skills/garelier-core/driver/src/dispatch/task_mirror.ts \
  --pm-id {pm_id} --project {project_root} --include-dispatches --current <tasklist.json>
```

at any refresh anchor (loop boundary, status query, merge) to see the ops
needed to converge the Task list on the desired state — including a
correction if a live dispatch's Task was completed too early.

## Report contract

Each gate role writes **two** artifacts before ending its turn — its own
canonical role report, and a completion-contract verdict marker the PM
verifies mechanically:

1. Canonical role report (per `garelier-guardian`/`garelier-observer` SKILL.md):
   `__garelier/<pm_id>/_guardians/<id>/guardian_report.md` or
   `__garelier/<pm_id>/_observers/<id>/report.md`. Full findings, evidence,
   redaction rules — this reference does not restate that shape.
2. Verdict marker (what `contract_check.ts` gate mode and `merge_land.sh`'s
   verdict auto-read both parse):
   `__garelier/<pm_id>/runtime/<role>/results/<slug>-<role>.md`. The line
   **directly under the `## Verdict` heading must be a BARE canonical token**,
   nothing else: `PASS` / `PASS_WITH_NOTES` / `REWORK_RECOMMENDED` / `BLOCK` /
   `NO_OPINION`. Minimal valid body:

   ```markdown
   ## Verdict

   PASS_WITH_NOTES
   ```

   **Not accepted** (all fail-closed to "no verdict", which silently blocks the
   land — the recurring re-failure): a prose sentence (`Guardian verdict: PASS —
   no blockers`), a bold/emphasised token (`**PASS**`), the untouched
   `{{PASS | …}}` template menu, or a typo/near-miss (`PASSED`, `BLOCKING`). The
   parser reads the first `[A-Z_]+` run after the heading and whole-token-matches
   it against the enum, so anything but the bare token resolves to null. The
   canonical starting point for this marker is `templates/gate_verdict.md` (its
   parser contract + fail-closed rules are documented in the template header).

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

## High-stakes refuter (W-066)

**Only for a HIGH-STAKES merge** — one that already earns a mandatory Observer
review via the `[observer_policy]` `require_for_*` subset: `require_for_large_diff`
/ `require_for_protected_paths` (mechanical), or a semantic
`migration` / `public_api` / `auth_security` trigger you judged applies. A daily,
low-stakes merge skips this entirely — do NOT spawn a refuter for it (cost design).

After the Observer verdict verifies, spawn **one** refuter subagent that verifies
that verdict adversarially (refute-default) — it does not re-review the code, it
checks whether the Observer's verdict survives. It is commit-free / read-only like
the Observer. Tier: `sonnet` normally, `opus` for a critical/security merge
(`fable`/`haiku` never — subagent policy). Naming: `ga-refuter-<slug>`.

**Refuter** (`name: ga-refuter-{slug}`):

> You are the Garelier **refuter** for PM `{pm_id}` at `{project_root}` (W-066).
> Load `garelier-observer` and read `references/refuter-verify.md` — that is your
> authoritative contract. An Observer reviewed branch `{branch}`
> (`{base_sha}`..`{head_sha}`) and returned verdict `{observer_verdict}`; its
> report is at `{observer_report_path}`. Your job is NOT to re-review — it is to
> verify that verdict, refute-default: if the Observer said PASS/PASS_WITH_NOTES,
> try to overturn it with file:line/diff evidence; if it said
> REWORK_RECOMMENDED/BLOCK, try to invalidate the finding. Read the Observer's
> report and the specific hunks its findings point at (`git diff` by path; never
> check the branch out). Before your final message, write the verdict marker at
> `__garelier/{pm_id}/runtime/observer/results/{slug}-refuter.md` with a
> `refuter_verdict:` line that is exactly `UPHELD` or `REFUTED`, plus a short
> evidenced rationale. Return only a compact result (verdict, marker path,
> ≤ 6 lines).

Then relay the refuter verdict into the merge request with `--refuter-verdict`
(and `--refuter-report` to bind it to the marker). A `REFUTED` holds the merge for
PM escalation; a `UPHELD` merges normally. If you (attended) chose NOT to run a
refuter on a high-stakes merge, pass `--high-stakes` so the gate records the
advisory warning rather than silently landing it. Per DEC-090 you never author the
refuter verdict yourself — the refuter subagent writes its own marker.

## Merge

Once both markers verify (and, for a high-stakes merge, the refuter marker too),
file the merge request — never hand-write the JSON (DEC-064 §1):

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

**Get pushed the result (attended, W-079).** The gate runs async and nothing
watches `results/` in attended mode, so add `--notify` to the `merge_request.sh`
call above: it prints a ready-to-run `gate_result_waiter.sh --request-id <REQ_ID>`
command. Launch that with `run_in_background` and the harness wakes the PM when
the gate terminates with `MERGE_RESULT: <status> <request_id> <studio_commit|
failure_reason>` (exit 0 success / 1 non-success / 124 timeout). The waiter only
watches its own request's result file — it never polls the gate or touches the
queue (self-drain W-039 stays intact). Not needed under the driver (its poll loop
already drives the result). See `pm_playbook.md` § 1.

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
