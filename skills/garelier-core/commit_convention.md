# Commit message convention (canonical)

Garelier standardizes commit messages on **Conventional Commits 1.0.0** plus a
**bound item ID** (subject) and a **`Garelier:` git trailer** (footer), so history
is consistent regardless of which AI/session, role, or human authored the commit,
every commit is traceable to the tracked work that motivated it, and every commit
Garelier *itself* produced is machine-identifiable after the fact.

> **Non-mandatory layer — Garelier stays removable, contributors are not impacted.**
> A project has many contributors: Garelier users, non-users, and people using
> other skills/tools. This convention is enforced **only inside Garelier's own
> operation** (the driver/roles validate the commit messages *they* produce) and
> is offered to humans as an **opt-in** local git hook. It is **NEVER** wired into
> a target project's shared CI or a repo-global hook (`core.hooksPath`,
> committed `.githooks/`, mandatory PR check) — doing so would impose Garelier on
> everyone and break non-users. A repo using Garelier MUST stay fully usable with
> plain `git` / build / test by people who do not use it, and **merging Garelier
> work into a shared branch must not propagate any enforcement that affects
> others**. The framework's *own* `ci.sh` may enforce this (it is Garelier's
> repo); in target projects the lint is Garelier-artifact-scoped, opt-in, and a
> no-op when Garelier is absent. See `correct_operation.md`.

## Format

```
<type>(<scope>): <summary>  [<item-id>]

<body>

<Garelier: …>
<other footer trailers>
```

- **First line ≤ 72 chars preferred** (the validator *warns* past 72, never blocks),
  imperative mood, no trailing period, lowercase summary.
- `[<item-id>]` binds the tracked work (see *Item ID* below). It may be a trailing
  `[…]` token OR appear naturally in the summary (e.g. `accept DEC-045: …`).
- Blank line before the body and before the footer trailer block.
- The **canonical position for the item ID is the trailing `[…]` suffix**
  (`docs(core): … [W-043b]`). A leading `[<item-id>] <type>(<scope>): …` **prefix
  form is deprecated** — it does not match the `type(scope): summary` shape the
  validator (and the wider Conventional-Commits ecosystem) parses, so it is
  *rejected*, not just discouraged. If you have muscle memory for the prefix form
  from another project, move the token to the suffix.

## type (required)

`feat` · `fix` · `refactor` · `docs` · `test` · `chore` · `build` · `ci` · `perf` · `revert` · `release`

- `feat` new capability/skill/template · `fix` bug/broken test/wrong template ·
  `refactor` reorg/rename (on-disk artifact-format change needs a DEC + migration) ·
  `docs` documentation only · `test` test-only (no test-inflation: see DEC / `feedback_no_test_inflation`) ·
  `chore` version bump/deps/tooling · `build`/`ci`/`perf`/`revert` as usual ·
  `release` version release commit (VERSION/CHANGELOG/manifest bump; matches existing history).

## scope (required where it has one)

The affected skill or document area:

- skill: `garelier-pm` `garelier-dock` `garelier-worker` `garelier-scout`
  `garelier-smith` `garelier-artisan` `garelier-librarian` `garelier-observer`
  `garelier-guardian` `garelier-concierge` `garelier-core`
  `garelier-control-project` `garelier-control-library`
- area: `control` `docs` `templates` `driver` `knowledge` — or a target-project
  module name (e.g. `auth`, `parser`).

## item ID (required when one exists)

Bind the commit to the tracked work it advances:

| Repo | Item ID source | Example |
| --- | --- | --- |
| **Framework** (`garelier/`) | a decision `DEC-NNN` (for control/policy) or a workshop `W-NNN` | `docs(control): accept DEC-045 — both lanes integrate via studio` |
| **Target project** | roadmap milestone slug / canonical backlog `W-NNN` / runtime task `#NN` | `feat(parser): schema + validate  [m6 / W-006]` |

A commit with no natural tracked item (pure tooling chore) may omit the ID; the
lint only requires an ID when the change touches a milestone/blueprint/decision
or a target-project work path. Unbound substantive commits are treated as
inflation (target projects may require the ID always — see their `AGENTS.md`).

## Garelier marker (required on every Garelier-produced commit) — a git trailer

Every commit Garelier produces (any role, any lane, PM-direct, or an isolate
worktree) ends with a **`Garelier:` git trailer** in the footer:

```
Garelier: <pm_id> <actor> <item-id>
```

- `<pm_id>` — the PM namespace that owns the work (e.g. `acme`).
- `<actor>` — WHO produced it, in one of these forms:
  - `<role>#<dispatch-id>` — a dispatched producer (`worker#162`, `smith#7`,
    `librarian#3`, `artisan#5`). The dispatch id is the `_dispatch<N>` id / task id
    from `dispatch_prepare` (the `#<id>` in the branch `…/#<id>/<slug>`).
  - `pm-direct` — a commit the PM authored directly (accepted inspection, dashboard
    update, control artifact) with no producer dispatch.
  - `isolate/<slug>` — a commit made in a lightweight `workspace_isolate.sh`
    worktree (`garelier/isolate/<slug>`), used for parallel producers in a
    control-only repo.
  - `merge` — a studio integration merge commit (see the merge example below);
    the `<item-id>` is the merged branch tail.
- `<item-id>` — the same bound item ID as the subject (`W-051`, `DEC-045`,
  `#42`, `m6`).

### Why a trailer, not the subject line

- **Subject-space** — the subject stays a clean `type(scope): summary [id]`; the
  provenance does not compete with it for the ≤ 72-char budget.
- **Machine-extractable after merge** — `git log --grep '^Garelier:'` (or
  `git log --format='%(trailers:key=Garelier)'`) lists *every* Garelier-produced
  commit across the whole history, even long after the coordination branches are
  gone. A subject tag would be lossy (squash/reword) and mixed in with prose.
- **Non-interference (the non-mandatory-layer principle)** — a footer trailer does
  not touch a non-Garelier contributor's subject-line conventions, so Garelier
  work merged into a shared branch imposes nothing on anyone else.

### The `[ga]` subject tag is optional, not the marker

`user` may prefer a visible `[ga]` marker in the subject. That is allowed as an
**optional** `[ga]` tag appended to the summary — it never *replaces* the trailer,
which stays the machine-readable source of truth:

```
docs(core): tighten wiring note [ga]  [W-051]
```

Projects that do not want a visible tag simply omit it; the `Garelier:` trailer is
what tooling reads either way.

## Role examples (subject + trailer)

```
# Worker (dispatched #162)
feat(parser): schema + validate  [W-006 / m6]

<body: why>

Garelier: acme worker#162 W-006

# Smith (post-merge hardening, dispatch #7)
test(engine): cover conveyor-accumulator interaction  [W-014]

Garelier: acme smith#7 W-014

# Librarian (shelf sync, dispatch #3)
docs(knowledge): sync coding-standards from source registry  [W-018]

Garelier: acme librarian#3 W-018

# Artisan (single-agent lane, dispatch #5)
feat(auth): token refresh + regression test  [W-021]

Garelier: acme artisan#5 W-021

# PM-direct (accepted inspection, no producer dispatch)
docs(control): accept inspection — dependency audit (Scout #4)  [W-009]

Garelier: acme pm-direct W-009

# Isolate worktree (garelier/isolate/<slug>, control-only repo)
docs(core): standardize commit convention + Garelier trailer  [W-051]

Garelier: acme isolate/commit-convention W-051

# Merge (studio integration — keep the existing merge subject, add the trailer)
merge #6-parser into studio

Guardian PASS; Observer PASS.

Garelier: acme merge workbench/#6/parser
```

`merge_request.sh` generates the merge subject and appends this trailer
automatically; producers get their trailer verbatim in the dispatch context pack
(`dispatch_prepare.sh` → `context.json` → the ready-to-copy `commit_template`).

## body (encouraged)

- Explain **why** (the diff already shows *what*).
- **Never paste diffs, logs, file dumps, or artifact bodies** — reference paths
  or commit SHAs instead (compact handoff, see `compact_handoff.md`).
- Bullets OK; wrap ~72 chars.

## footer (optional, besides the required `Garelier:` trailer)

- `Closes <id>` / `Refs <id>` — decision file, task, or issue.
- `Co-Authored-By: Name <email>` — when collaborative.
- Trailers may appear in any order; keep them in the trailer block (blank line
  after the body, one `Key: value` per line).

## Special form — accepting a decision (framework control commit)

```
docs(control): accept DEC-NNN — <decision one-liner>

<consequences for the codebase, in 1-4 lines>

Closes __garelier/<pm_id>/control/decisions/DEC-NNN-<slug>.md
Garelier: <pm_id> pm-direct DEC-NNN
```

This makes `git log --grep="DEC-NNN"` find exactly the commit that adopted it.

## Discipline

- One coherent, reviewable, revertible outcome per commit; run the quality gate
  and tests first.
- Remove completed backlog/risk rows in the **same** commit that resolves them.
- No secrets/tokens/PII in messages or diffs (Guardian gate is a backstop, not a
  substitute — see the `security/commit_hygiene_policy.md` knowledge file).
- Never commit broken, WIP, timestamp-only, or formatting-only changes.

## Enforcement (layered, non-intrusive)

A Bun/TS validator `bun scripts/lint_commits.ts` (the Garelier env requires Bun)
checks message shape (type/scope/summary, item-ID where required, no diff-in-body,
**and the `Garelier:` trailer's presence**). It is applied at three levels, none of
which can break a non-Garelier contributor:

1. **Garelier pipeline (hard):** the driver/roles validate the commit message they
   are about to make and refuse to commit a non-conforming message. This is where
   the AI/session variance was, so it is enforced strictly — and it only ever
   touches Garelier-produced commits.
2. **Human, opt-in (soft):** an installable local git `commit-msg` hook runs the
   same validator. It is **not** auto-installed and **not** committed as a
   repo-global hook; a contributor chooses it. Plain `git commit` works without it.
3. **Framework repo CI only:** the framework's own `ci.sh` runs the validator over
   its commits. **Target projects do NOT get this in their shared CI** — there the
   validator is available + pipeline-enforced + opt-in, scoped to `__garelier/` /
   control artifacts, and a no-op when Garelier is absent.

### Trailer check is a warning, not a hard block (for now)

The `Garelier:` trailer is validated as a **warning**, not a shape error: the
existing history predates it, and CI checks only `HEAD`, so a warn cannot fail a
pre-trailer commit or a non-Garelier contributor's plain commit. Garelier-produced
commits should carry it (the pipeline forward-supplies a ready-to-copy template),
and the warning surfaces a producer that dropped it. Promotion to a hard error is a
future decision once the pipeline reliably emits it.

### Recommended regex for a project-side lint (opt-in)

A target project that *chooses* to lint its own `__garelier/`-scoped commits can
match the trailer with:

```
^Garelier: [^ ]+ [^ ]+( .+)?$
```

(pm_id, actor, optional item-id). To extract every Garelier-produced commit from a
range for an audit, use `git log --grep '^Garelier:' <range>` — do NOT wire this
into the project's shared CI or a repo-global hook (see the non-mandatory-layer
callout above).
