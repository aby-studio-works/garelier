# Scout reference: investigating → reporting

> Detailed procedure moved from `SKILL.md` to keep the entrypoint small
> (DEC-032). Read when your state is ASSIGNED / WORKING / REPORTING. The
> hard rules in `SKILL.md` (MUST BLOCK IF, §10) always apply.

## §4. Receiving an assignment (IDLE → ASSIGNED → WORKING)

When `assignment.md` appears in your container (`../assignment.md`):

### 4.1 Read carefully

1. Read `assignment.md` end to end.
2. Read every file referenced in the **Inputs** section.
3. Note the **Expected outputs** section: it specifies the inspection
   path (typically
   `__garelier/<pm_id>/control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md`) and the
   format expected.

### 4.2 Sanity check before starting

Ask yourself:

- Do I understand what question(s) I'm answering?
- Are the sources / systems I need to consult listed and accessible?
- Is the expected output path and format clear?
- Are the acceptance criteria checkable?

If any answer is "no" or "I'm not sure," **transition to BLOCKED**
(§8) before starting. Better to ask now than to deliver an irrelevant
inspection.

### 4.3 Update STATE.md and start

1. **Worktree cleanup (mandatory before WORKING).** Re-pin your
   detached HEAD to the current studio tip and discard any drift:
   ```bash
   git checkout --detach garelier/<target-slug>/<pm_id>/studio
   git reset --hard HEAD
   ```
   This guarantees you read sources at the studio tip the assignment
   was generated against, not an old tip where files may differ.
2. Update `STATE.md` to status `ASSIGNED`. Record the task ID.
3. Update `STATE.md` to status `WORKING`.
4. Write a state-change notification to
   `__garelier/<pm_id>/runtime/dock/inbox/<YYYYMMDD-HHMMSS>-<your-id>-state-change.md`
   using `templates/inbox_notification.md`.

(There is no branch creation step. Your worktree stays on detached
HEAD.)

**STATE.md format is fixed.** Always use the canonical `## Status`
/ `## Current branch` / `## Current task` / `## Last activity`
headers from `../../garelier-core/templates/state.md`.
Do NOT switch to list-item form (`- Current state: WORKING`); the
status helper and Dock's scan both expect canonical headers.

**Per-field length limits (LOAD-BEARING):**

| Field | Max | Style |
|---|---|---|
| `## Status` | 1 word | `IDLE` / `ASSIGNED` / `WORKING` / `REPORTING` / `BLOCKED` / `ABORTED` |
| `## Current task` | 1 line, ≤ 100 chars | `Task #<id>: <one-line summary>` |
| `## Last activity` | 1 line, ≤ 120 chars | `<ISO8601> -- <verb>: <short action>` |
| `## Recent log` | bullet list, each ≤ 120 chars | most recent first, max 10 entries |

The status helper truncates longer fields with "..." so anything
beyond the limit is invisible to PM/user. Multi-paragraph reasoning
belongs in your `report.md` or `archive/<task_id>/notes.md`, not in
STATE.md fields.

## §5. Conducting the work (WORKING)

### 5.1 Source selection

The assignment lists Inputs. Use those first. If you discover you
need additional sources:

- For web research: search freely within the topic. Cite every URL.
- For project files: read them via absolute path
  (`<project-root>/path/to/file`). Don't try to edit them.
- For external systems (APIs, services): check the assignment for
  access notes. If not specified, transition to BLOCKED.
- For data files (CSVs, logs, exports): read them; don't modify.

### 5.2 Investigation discipline

- **Cite as you go.** Don't try to remember sources at the end.
  Maintain a running list of `[1] URL, [2] file:line, ...` and
  reference inline as you write.
- **Distinguish observation from inference.** "The repo's CHANGELOG
  shows v0.18 was released 2024-09" is observation. "Therefore the
  upgrade should be safe" is inference. Tag inferences clearly.
- **Note what you didn't check.** Scope is critical. If the
  assignment says "survey the top 5 GPU compute crates" and you
  surveyed 5 of 20 candidates, name the candidates you considered
  and explain why you picked these 5.
- **Time-box appropriately.** An inspection should usually be a
  few hours of work, not a week. If the assignment seems to require
  a week of research, transition to BLOCKED and discuss scoping with
  Dock.

### 5.3 Different work shapes

Scout assignments come in many shapes. The structure of your work
depends on the deliverable:

| Assignment shape           | Your activity                              |
| -------------------------- | ------------------------------------------ |
| Web research               | Search, read, synthesize, cite             |
| Market study               | Survey vendors/products, compare, analyze  |
| Accounting calculation     | Read source data, compute, validate, report |
| Tax filing review          | Compare filings against source records     |
| Full test suite run        | Execute, capture output, summarize results |
| Deploy health check        | Query services, capture metrics, summarize |
| Benchmark                  | Run benchmark, capture data, compare       |
| External API check         | Query APIs, validate responses             |
| Metrics collection         | Pull metrics from monitoring, summarize    |

In all cases, the inspection follows the same structure (see §6) but
emphasizes different sections.

### 5.4 When to escalate

Transition to BLOCKED (§8) if:

- An input file is missing or empty.
- A required external system is unreachable or returns errors.
- The scope is ambiguous and your interpretations would diverge
  significantly.
- Conducting the investigation would require credentials or access
  you don't have.
- You discover the assignment as scoped is impossible (e.g., "survey
  closed-source competitor pricing" without access).

Do not partially deliver an inspection and call it done. If you
cannot answer the question fully, escalate so Dock (and PM) can
re-scope.

## §6. Writing the deliverable (WORKING → REPORTING)

### 6.1 Pick the file path

The assignment's `Expected outputs` section specifies the path.
Standard form for daily/high-volume outputs:

```
__garelier/<pm_id>/control/inspections/<category>/<YYYY>/<MM>/<YYYY-MM-DD>-<topic-slug>.md
```

Where `<category>` is one of the standard categories (`tech/`,
`market/`, `status/`) or a project-specific one
(`accounting/`, `deploy_check/`, `test_results/`, `benchmark/`,
`data_audit/`, ...).

Address `control/inspections/` by the ABSOLUTE path in your `CLAUDE.md`
("Inspections to: …") — it works whether your container is in-project (default,
DEC-036) or an opted-in exile home outside the project, so don't hand-build a
relative hop to `control/`. If the category subdirectory doesn't exist yet,
create it (substitute the absolute inspections root from your `CLAUDE.md`):

```bash
mkdir -p "<inspections-root>/<category>/<YYYY>/<MM>"
```

### 6.2 Use the inspection template

Use `../../garelier-core/templates/inspection.md`.
The template's structure works for all Scout work shapes; rename or
omit sections that don't apply (e.g., for a test suite run, "Sources"
becomes "Test files run"; "Recommendations" may be empty if the
assignment didn't ask for them).
Also write a sibling `<same-name>.json` from
`../../garelier-core/templates/inspection.json`. Keep it to the
compact schema/version, status, one-line summary, tests, risk flags, and needs;
do not copy the Markdown inspection body.

A good inspection:

- **Starts with an executive summary** (2-4 sentences). The reader
  should be able to stop after this paragraph and have the answer.
- **States the question explicitly** before answering. Lift it from
  the assignment.
- **Distinguishes findings from inferences.**
- **Cites every source** with a stable identifier (URL with
  access date, file path with line number, command and timestamp).
- **Flags uncertainty.** Use phrases like "based on the data
  available" or "this could not be verified because X."
- **Notes scope limits.** What you did *not* investigate.
- **Summarizes bulky sources.** Do not commit raw dumps, full logs,
  generated caches, or bulk input snapshots as the inspection. Include
  counts, sample records, source paths, and reproduction commands.

### 6.3 Notify Dock

1. Update `STATE.md` to status `REPORTING`. Reference the inspection
   filename in the STATE.
2. Write a state-change notification to
   `__garelier/<pm_id>/runtime/dock/inbox/<YYYYMMDD-HHMMSS>-<your-id>-state-change.md`
   referencing the new inspection file.

The notification points to the inspection; do not duplicate findings in
the inbox file.

The inspection file is a **handoff draft** until PM commits the accepted
copy from the primary checkout. Do not `git add`, `git commit`, switch
branches, or try to make the file visible by manipulating git state.
Dock validates the draft and hands it to PM for commit.

### 6.4 Wait for acknowledgement

Dock reviews your inspection. When Dock acknowledges (the
mechanism in v2.0 is the assignment being archived to
`__garelier/<pm_id>/runtime/backlog/done/<task_id>-<slug>.md`, your
`assignment.md` being removed, and, when the inspection is persistent,
PM having committed or verified the committed inspection):

1. Update `STATE.md` to status `IDLE`.
2. Archive any local files (`assignment.md` if still present) to
   `__garelier/<pm_id>/_scouts/<id>/archive/<task_id>/` for your own records.
3. Notify Dock of the IDLE transition.

If Dock wants follow-up work, a **new** `assignment.md` will
appear (with a new task ID). Treat it as a fresh IDLE → ASSIGNED →
WORKING cycle. Do not modify the previous inspection.

## §6.5 `committed.md` cleanup (REPORTING → IDLE)

> Moved from `SKILL.md` §3 (DEC-032). Trigger + invariant stay in the
> entrypoint: on `committed.md`, re-pin detached HEAD to studio, `reset
> --hard`, archive, notify — and **NEVER `git clean -fdx`**. The shared
> worktree-hygiene contract is
> `../../garelier-core/references/worktree-addressing.md`.

When `committed.md` appears in your container (`../committed.md`), read it for
the studio commit SHA and the destination path of the committed inspection,
then:

1. **Worktree cleanup (mandatory).** Re-pin your detached HEAD to the
   current studio tip and discard any tracked-file drift that has
   accumulated since your last attach:
   ```bash
   git checkout --detach garelier/<target-slug>/<pm_id>/studio
   git reset --hard HEAD
   ```
   Why: between tasks the studio branch advances as Workers' merges
   land; your old detached HEAD lags behind and `git status` reports
   spurious `M` (modified) entries for files the merges touched (e.g.
   sccache binaries, build artifacts that other Workers regenerated).
   You do not own commits, so resetting to the current studio HEAD is
   always safe. Do NOT `git clean -fdx` — that would wipe other
   agents' worktree build caches that share the project root.
2. Update `STATE.md` to `IDLE`.
3. Archive `assignment.md`, `report.md`, and the local copy of the
   inspection draft (if any remains in your container) under
   `../archive/<task_id>/`. Do not delete; the archive is your audit
   trail.
4. Remove `committed.md` after archiving (Dock will re-write a
   fresh one for the next task).
5. Write a state-change notification to
   `__garelier/<pm_id>/runtime/dock/inbox/<YYYYMMDD-HHMMSS>-<your-id>-state-change.md`
   confirming REPORTING → IDLE with the studio commit SHA from
   `committed.md`.
