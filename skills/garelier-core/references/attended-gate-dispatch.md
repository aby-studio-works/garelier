# Attended-mode Guardian/Observer gate dispatch

Canonical template for an **attended PM** (dispatch-native, no driver —
`SendMessage`/`Agent` tool calls hand-rolled in-session) to dispatch the
Guardian → Observer gate before merging a role branch. Fixes the
"hand-rolled prompt / report path / verdict contract every session" class
(W-024; target-project live friction 2026-06-30 to 07-01, 4 cycles) by giving the
attended PM one prompt shape and one report contract to reuse, instead of
reinventing both per cycle.

A jig/Workflow run (`ga-tick`, `ga-gate`) does not need this file — it
already gets the same prompt shape + verdict handling from
`references/jig.md`. This file is for the **no-driver, hand-dispatch**
path only.

## Dispatch predicate (all roles)

Prepare every detached role with the same command:
`bun skills/garelier-core/driver/src/scripts/dispatch_prepare.ts --project
<root> --pm-id <id> --role <role> --slug <slug> [--provider <codex|claude-code>] ...`.
`--provider` is optional on a fresh dispatch: omitting it resolves to
`claude-code`, and `codex` requires the explicit flag (W-690; the record marks a
defaulted provider `provider_source: "framework-default"`). Model and effort are
NOT defaulted — a recorded Claude dispatch still refuses without them.
Pass the emitted `agent_name`, model, and provider route to the selected
transport. The helper decides internally whether the role needs a worktree;
provider selection never decides it. Wanderer remains outside this managed
dispatch path because DEC-076 requires a separately launched external session.

A seat without the permission record has every tool call denied as
`profile_unknown` and becomes **no-output idle**. The PM receives only the idle
notification, so the failure is easily misdiagnosed as a model/server problem.
When a seat becomes no-output idle, check whether `command_guard` can resolve its
agent name first. The canonical resolver searches both dispatch `context.json`
and `_crew/lanes/.meta/*.dispatch.json` by the embedded `guard.agent_name`; a
lane record may be slug-keyed, so absence of a same-name filename is not proof
that the record is missing.

Existing installs created before W-434 need the new `PreToolUse` / `Agent`
wiring. `doctor.ts` reports `runtime-recovery-agent-hook` when it is absent.
Repair idempotently by re-running `setup_wizard.ts --mode diff` for that PM, or
run `install_runtime_recovery_hook.ts` against the target project's
`.claude/settings.local.json`; the installer preserves unrelated hooks.

## Precondition: the producer register must carry a REQUIRED GATE block (W-641)

A Guardian/Observer seat is issued only after `review_prepare.ts` produces the
Dock review handoff, and that run executes the gate as
`gate_runner.ts --from-register <register>`. There is no `--steps` route on this
path, so a register **without** the
`=== REQUIRED GATE (Dock-run) ===` … `=== END REQUIRED GATE ===` block is refused
as `required_gate_block_missing` → RED → `final_accounting.md` never reaches
`Gate result: GREEN (exit 0)` → `dispatch_prepare --attended-seat` fails with
`Dock review handoff postcondition failed`.

This holds for **every provider**, attended-agent and claude-subprocess lanes
included — the block form is provider-independent and its authority is
[`worker_field_manual.md` §5b](worker_field_manual.md). When an already-REPORTING
lane has no block, the PM does **not** edit the register: see the followup route
in `garelier-core/references/pm_field_manual.md#pmfm-15-3`.

The register does **not** name the gate run (W-711): the seal binds the run the
Dock's own review record already holds over the log's exact bytes, so there is no
`[gate] gate_run_id` field and a run id quoted in prose is not read.

## What the seat checks about the run itself (W-710)

The gate's own record of where it ran — one JSON file under the PM runtime tree
at `<pm runtime>/gate/run_records/`, written by `gate_runner.ts` and never beside
the log (a log path can sit inside the tree the gate measures, and an untracked
sibling there breaks the next run's step identity) — carries the run id, the cwd,
and `git rev-parse HEAD` taken
before the first step and after the last. `review_prepare.ts` copies those heads
into the seal as `gate_start_head` / `gate_end_head`, digests the record with the
other handoff artifacts, and **refuses to write a seal at all** when the two
disagree with each other or with the review SHA — a run whose checkout moved
measured two commits, so nothing it produced describes one review.

A seat therefore reads the SEAL, never the log's `GATE_START` / `RESULT` prose,
to answer "which run is this and did the tree hold still": the full branch table
and the exact predicate are in
[`gate_field_manual.md`](gate_field_manual.md) §A-8b.

## When

Before an attended PM merges a role's branch into `studio`: DEC-090
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

`dispatch_prepare.ts`'s JSON (and the `context.json` it writes) carries these
verbatim under `gate_agents.guardian`/`gate_agents.observer` (`name` +
`report` + `verdict_template`, W-040/W-020) — read them from there instead of
hand-building the strings above when the role was dispatched through
`dispatch_prepare.ts`. `report` is the SINGLE canonical verdict-marker path
(`runtime/<role>/results/<slug>-<role>.md`) — the exact path
`contract_check.ts --gate` and `merge_land.ts`'s verdict auto-read both parse, so
copy THAT into the gate request rather than retyping one that can drift.
`verdict_template` (`skills/garelier-core/templates/gate_verdict.md`) is the marker's
canonical starting point — paste it into the gate prompt so the role writes the
`+++` TOML front matter with `[verdict] result` and `[verdict] review_sha`. The
merge-request path validates the same parser contract before queueing; free prose,
a placeholder, or a missing field fail closed (§ Report contract). Do NOT append
the role to `--slug` yourself: `report` already carries it, and a doubled slug
produces a second candidate path for the seat to choose between (W-634). A prompt
that names two verdict paths for one seat is refused at spawn.

Gate seats remain read-only and no-worktree, but now pass through
`dispatch_prepare.ts`. Read the resolved model and route from that command's
JSON. The role's dispatch JSON also carries the planned gate model under
`gate_agents.guardian.model` / `gate_agents.observer.model` (W-049); use it when
preparing the matching gate dispatch rather than re-running the resolver by hand:

```bash
bun skills/garelier-core/driver/src/dispatch/model_routing.ts \
  --project {project_root} --pm-id {pm_id} --seat guardian   # or --seat observer
```

The `model` field of the one-line JSON is the model to spawn the gate subagent
at (gates default to the `strong` indicator tier); `""` means inherit the
dispatcher's model. An explicit task flag is always forwarded verbatim. A non-empty `warnings`
array (e.g. `gate_weaker_than_role`) flags a gate resolved weaker than the
roles it reviews — non-blocking, but confirm the intent with the user before
gating with it.

**MANDATORY (W-049):** the Agent tool call that spawns the Guardian/Observer
subagent MUST set `model:` to this resolved value explicitly. The Claude Code
Agent tool inherits the PARENT (PM) session's model when `model` is omitted —
there is no error, no warning at spawn time, just a subagent silently running
at the wrong tier. This has happened in production (a target project, 2026-07-11:
one worker + four gate subagents ran at the PM's own model because `model` was
left off the Agent tool call). Treat a missing `model:` param on a gate/role
spawn as a bug in the dispatch, not an acceptable default.

## Task-list mirroring (W-040)

Mechanize the harness Task list from the dispatch instead of hand-building
it: once `dispatch_prepare.ts` succeeds, `TaskCreate` one Task from its JSON
(`metadata`: backlog id, dispatch id, `agent_name`). For the gate step, reuse
that same JSON's `gate_agents.guardian`/`gate_agents.observer` `name`/
`report` verbatim (see Naming above) — never re-derive them by hand. Once
the merge succeeds and `dispatch_cleanup.ts` removes the `_crew/dispatch<N>`
container, `TaskUpdate` the Task to `completed` — that removal is the only
"done" signal (a role marking its own Task `completed` mid-gate is not).
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
   `__garelier/<pm_id>/_crew/guardians/<id>/guardian_report.md` or
   `__garelier/<pm_id>/_crew/observers/<id>/report.md`. Full findings, evidence,
   redaction rules — this reference does not restate that shape.
2. Verdict marker (what `contract_check.ts` gate mode and `merge_land.ts`'s
   verdict auto-read both parse):
   `__garelier/<pm_id>/runtime/<role>/results/<slug>-<role>.md`. The file OPENS
   with `+++` TOML front matter carrying `[verdict] result` (one canonical token:
   `PASS` / `PASS_WITH_NOTES` / `REWORK_RECOMMENDED` / `BLOCK` / `NO_OPINION`)
   and `[verdict] review_sha` (full 40..64-character lowercase hex SHA). Minimal
   valid file:

   ```toml
   +++
   [verdict]
   result = 'PASS_WITH_NOTES'
   review_sha = '0123456789abcdef0123456789abcdef01234567'
   +++

   Findings and prose go here. Nothing below the closing `+++` is parsed, so
   parentheses, backticks and quotes in a finding are just characters.
   ```

   **Not accepted** (all fail-closed to "no verdict", which silently blocks the
   land — the recurring re-failure): a prose sentence (`Guardian verdict: PASS —
   no blockers`), a token written in the body instead of the front matter, the
   untouched `{{PASS | …}}` template menu, a typo/near-miss (`PASSED`,
   `BLOCKING`), or a missing `review_sha`. A file with NO front matter is
   rejected as unreadable and says so — it is not reported as "no verdict".
   **W-073 — write the vocabulary INTO your gate prompt.** The recurring PM
   drift is offering the reviewer a menu like `PASS_WITH_CHANGES` (not a
   canonical token): the reviewer answers with it verbatim and the land
   false-rejects. When you author a gate prompt, quote the verdict menu
   exactly as `PASS / PASS_WITH_NOTES / BLOCK / NO_OPINION` (Observer may add
   `REWORK_RECOMMENDED`) — never paraphrase the tokens. (`merge_request.ts`
   normalizes the PM-typed CLI near-synonym `PASS_WITH_CHANGES` →
   `PASS_WITH_NOTES` with a warning, but the report-side parser stays strict.)
   **W-065 — verdict-before-idle is mandatory.** A gate agent that finishes its
   review MUST (1) write the verdict marker file above AND (2) send the one-line
   verdict register message BEFORE going idle — an idle notification alone is a
   contract violation (two field cases: an Observer reviewed for ~5 minutes and
   idled with no verdict at all; another wrote the result file but never sent
   the register). Put this requirement verbatim in every gate prompt. PM
   recovery order when a gate idles silently: read the result file (it is the
   VERDICT CANONICAL — a written file with a missing message is recoverable);
   if the file is also absent, the review is void — re-dispatch the gate, never
   guess or self-author a verdict (DEC-090).
   **The marker has TWO readers and they parse different surfaces (W-668 / F-20,
   measured 2026-09-02).** `merge_land.ts` reads `[verdict] result` from the front
   matter; `contract_check.ts --gate` requires a `## Verdict` heading with a BARE
   canonical token directly under it. **Write BOTH, identical.** A marker with only
   the front matter is refused by `contract_check` as `verdict_section_missing`; a
   marker with only the section is read by `merge_land` as "present but MALFORMED"
   = no verdict. So the minimal valid file above is not sufficient on its own —
   append:

   ```markdown
   ## Verdict

   PASS_WITH_NOTES
   ```

   The canonical starting point for this marker is `templates/gate_verdict.md`,
   which carries both surfaces; filling its placeholders satisfies both readers.
   (Its parser contract + fail-closed rules are documented in the template header.)
   The other register contracts a PM/producer trips over are tabulated in
   `worker_field_manual.md` §5b-1, which owns their count as well as their text.

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
> (`+++` front matter: `[verdict] result` = exactly one of PASS/PASS_WITH_NOTES/BLOCK/NO_OPINION, plus `[verdict] review_sha`).
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
> (`+++` front matter: `[verdict] result` = exactly one of
> PASS/PASS_WITH_NOTES/REWORK_RECOMMENDED/BLOCK/NO_OPINION, plus `[verdict] review_sha`). Return only a
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
(`haiku` never — subagent policy). Naming: `ga-refuter-<slug>`.

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
> `__garelier/{pm_id}/runtime/observer/results/{slug}-refuter.md` whose `+++`
> front matter carries `[refuter] result` = exactly `UPHELD` or `REFUTED`, plus a
> short evidenced rationale below the closing `+++`. Return only a compact result
> (verdict, marker path, ≤ 6 lines).

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
skills/garelier-core/driver/src/scripts/merge_request.ts \
  --project {project_root} --pm-id {pm_id} --branch {branch} \
  --guardian <verdict> --guardian-report __garelier/{pm_id}/_crew/guardians/<id>/guardian_report.md \
  --observer <verdict> --observer-report __garelier/{pm_id}/_crew/observers/<id>/report.md \
  [--preflight '<cmd>']...
```

`--guardian-report`/`--observer-report` bind the verdict to the real report
(DEC-088 group C) instead of an asserted string; `--guardian-review-sha`
defaults to the workbench tip. See `garelier-dock/references/merge-gate.md`
for the full merge-gate lifecycle.

**Get pushed the result (attended, W-079).** The gate runs async and nothing
watches `results/` in attended mode, so add `--notify` to the `merge_request.ts`
call above: it prints a ready-to-run `gate_result_waiter.ts --request-id <REQ_ID>`
command. Launch that with `run_in_background` and the harness wakes the PM when
the gate terminates with `MERGE_RESULT: <status> <request_id> <studio_commit|
failure_reason>` (exit 0 success / 1 non-success / 124 timeout). The waiter only
watches its own request's result file — it never polls the gate or touches the
queue (self-drain W-039 stays intact). Not needed under the driver (its poll loop
already drives the result). See `pm_playbook.md` § 1.

## Mechanical-delta re-gate (W-032)

> This is the Guardian's **`delta_gate` carabiner** (DEC-095;
> `carabiners.md`) — the same Guardian role clipped onto a lightweight one-role
> re-gate task-form instead of the full `final_gate`. Shared with the Observer as
> `delta_check`.

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
`merge_request.ts` requires `--guardian` but not `--observer` — using the
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
skills/garelier-core/driver/src/scripts/merge_request.ts \
  --project {project_root} --pm-id {pm_id} --branch {branch} \
  --guardian <verdict> --guardian-report __garelier/{pm_id}/_crew/guardians/<id>/guardian_report.md \
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
