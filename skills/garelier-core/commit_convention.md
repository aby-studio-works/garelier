# Commit message convention (canonical)

Garelier standardizes commit messages on **Conventional Commits 1.0.0** plus a
**bound item ID**, so history is consistent regardless of which AI/session or
human authored the commit, and every commit is traceable to the tracked work
that motivated it.

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

<footer>
```

- **First line ≤ 72 chars preferred** (the validator *warns* past 72, never blocks),
  imperative mood, no trailing period, lowercase summary.
- `[<item-id>]` binds the tracked work (see *Item ID* below). It may be a trailing
  `[…]` token OR appear naturally in the summary (e.g. `accept DEC-045: …`).
- Blank line before body and before footer.

## type (required)

`feat` · `fix` · `refactor` · `docs` · `test` · `chore` · `build` · `ci` · `perf` · `revert`

- `feat` new capability/skill/template · `fix` bug/broken test/wrong template ·
  `refactor` reorg/rename (on-disk artifact-format change needs a DEC + migration) ·
  `docs` documentation only · `test` test-only (no test-inflation: see DEC / `feedback_no_test_inflation`) ·
  `chore` version bump/deps/tooling · `build`/`ci`/`perf`/`revert` as usual.

## scope (required where it has one)

The affected skill or document area:

- skill: `garelier-pm` `garelier-dock` `garelier-worker` `garelier-scout`
  `garelier-smith` `garelier-artisan` `garelier-librarian` `garelier-observer`
  `garelier-guardian` `garelier-concierge` `garelier-core`
  `garelier-control-project` `garelier-control-library`
- area: `control` `docs` `templates` `driver` `knowledge` — or a target-project
  module name (e.g. `voxel_baker`, `render`).

## item ID (required when one exists)

Bind the commit to the tracked work it advances:

| Repo | Item ID source | Example |
| --- | --- | --- |
| **Framework** (`garelier/`) | a decision `DEC-NNN` (for control/policy) | `docs(control): accept DEC-045 — both lanes integrate via studio` |
| **Target project** | roadmap milestone slug / canonical backlog `W-NNN` / runtime task `#NN` | `feat(voxel_baker): schema + validate  [m6 / W-006]` |

A commit with no natural tracked item (pure tooling chore) may omit the ID; the
lint only requires an ID when the change touches a milestone/blueprint/decision
or a target-project work path. Unbound substantive commits are treated as
inflation (target projects may require the ID always — see their `AGENTS.md`).

## body (encouraged)

- Explain **why** (the diff already shows *what*).
- **Never paste diffs, logs, file dumps, or artifact bodies** — reference paths
  or commit SHAs instead (compact handoff, see `compact_handoff.md`).
- Bullets OK; wrap ~72 chars.

## footer (optional)

- `Closes <id>` / `Refs <id>` — decision file, task, or issue.
- `Co-Authored-By: Name <email>` — when collaborative.

## Special form — accepting a decision (framework control commit)

```
docs(control): accept DEC-NNN — <decision one-liner>

<consequences for the codebase, in 1-4 lines>

Closes __garelier/<pm_id>/control/decisions/DEC-NNN-<slug>.md
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
checks message shape (type/scope/summary, item-ID where required, no diff-in-body).
It is applied at three levels, none of which can break a non-Garelier contributor:

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
