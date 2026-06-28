# Worktree addressing & hygiene contract

A framework-wide contract every role shares. It governs where a role's files
live, how it addresses them, how it proves it is in its own checkout before any
write, and how a commit-free role keeps its detached worktree clean. The
per-role SKILL.md cites this; its own hard guards (the §1 worktree guard, the
**MUST BLOCK IF** list) always apply on top. `protocol.md` is canonical for the
full path/ownership matrix and the branch-push policy; this reference gives the
shared addressing/hygiene rules.

## §1. Container vs. checkout — the `../` relationship (DEC-020)

Your cwd is your **git worktree** — the `checkout/` inside your container. Your
coordination files (`STATE.md`, `assignment.md`, `report.md`, `questions.md`,
`checkpoints/`, …) live **one level up** in the container — read and write them
as `../STATE.md`, `../report.md`, etc., **never inside your cwd** (the
`checkout/` worktree). This `../` relationship always holds.

- `abort.md`, `answers.md`, `committed.md`, `merged.md`, `review.md`,
  `acked.md`, and any other marker your role watches also live in the container
  (`../abort.md`, etc.), **NOT** inside the `checkout/` worktree.
- The container itself is **NOT a git worktree** — it has no `.git`. Never run a
  bare `git -C <container>` (it would resolve to the studio checkout).

## §2. Addressing — absolute paths from CLAUDE.md, never fixed relative hops

The **primary checkout, runtime, and control** are addressed by the ABSOLUTE
paths recorded in your `CLAUDE.md` (and the driver's injected system prompt):
"Primary checkout", "Runtime directory", "Control directory". Use those — they
work whether your container is **in-project** (the DEC-036 default, e.g.
`__garelier/<pm_id>/_workers/<id>/`, `…/_scouts/<id>/`, `…/_smiths/<id>/`,
`…/_artisan/`, `…/_librarians/<id>/`, `…/_observers/<id>/`,
`…/_guardians/<id>/`, `…/_concierges/<id>/`) or in an **opted-in exile home**
outside the project (e.g. `~/.garelier/studios/<home_id>/_workers/<id>/checkout/`).

Only `../` to your **own** container is relative. **Do not hand-build fixed
relative hops** like `../../../runtime/`, `../../runtime/`, `../../../../`, or
`../../../../../` — they happen to resolve in-project but break under exile.
Your `CLAUDE.md` is the contract either way.

## §3. PM ownership of the per-PM tree

Resolve Plant roots before interpreting paths:

- `control_root`: the root that owns `__garelier/`.
- `garelier_root`: `control_root/__garelier`.
- `target_root`: the target project Git root.
- Plant-Lithosphere: `control_root == target_root`.
- Plant-Crust: `control_root != target_root`; `target_root` is normally the
  active container's `target/` checkout, and `target_root/__garelier` is
  forbidden. `workfolder_root` is only the `crust.toml` registry; it does not
  own `workfolder_root/__garelier`.

All Garelier paths are addressed relative to `control_root`, and the **active
PM owns `garelier_root/<pm_id>/`** in its entirety. Target project files, Git
operations, and quality gates are addressed relative to `target_root` or a role
checkout created from `target_root`. A role reads and writes only inside its own
subtree (its container) plus the framework paths its skill authorizes; it never
touches another agent's worktree, STATE.md, assignment, or report, and never
another PM's `<pm_id>/` tree.

Plant-Crust PM exception: PM may resolve the workfolder registry, validate each
registered `container.lock.toml`, read registered
`container_root/__garelier/<pm_id>/` trees, and write per-container Dock
requests. Dock and all subordinate roles remain active-container scoped and
must not read or write sibling containers.

## §4. Worktree guard before any edit / commit / gate (commit-producing roles)

Before any file edit, `git add`, `git commit`, quality-gate command, or cleanup
command, verify your checkout with `pwd`, `git rev-parse --show-toplevel`, and
`git branch --show-current`.

- `git rev-parse --show-toplevel` **must** resolve to your **own** git worktree
  — your cwd, i.e. your role's `…/<id>/checkout/` checkout (DEC-020). If it
  resolves to `target_root` / the primary studio checkout, the container
  itself (one level up — NOT a worktree), another agent's worktree, or any other
  path: **stop immediately.** Do not edit, stage, commit, run the gate, or clean
  up. `cd` to your own checkout and re-check first.
- While implementing / reworking / reporting, `git branch --show-current` must
  be your role's owned branch:
  - Worker: `garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>`
  - Smith: `garelier/<target-slug>/<pm_id>/anvil/#<id>/<slug>`
  - Librarian: `garelier/<target-slug>/<pm_id>/shelf/#<id>/<slug>`
  - Artisan: `garelier/<target-slug>/<pm_id>/satchel/#<id>/<slug>`
  - Concierge: a local-only `clipboard` work-ticket branch (DEC-021)
- A detached HEAD is acceptable **only** while `IDLE` or during post-merge
  cleanup, and only if the top-level path guard above still points at your own
  worktree.

## §5. Commit-free read-only roles — named ephemeral detached branch (DEC-021)

Commit-free roles (Scout, Observer, Guardian) take **no** owned long-lived
branch and **produce no commits**. At task pickup each cuts a throwaway,
named detached snapshot from the review-target / studio tip and stays on it for
the whole task — a stable snapshot — then deletes it on return to IDLE:

- Scout: `spyglass`, cut from the `studio` tip.
- Observer: `monocle`, cut from the review-target tip.
- Guardian: `gavel`, cut from the review-target tip (captures `review_sha`);
  delete the `gavel` branch on the return to IDLE.

These roles never `git add` / `git commit` / switch branches to inspect another
branch — read other branches by `git diff <base>..<branch>` or by absolute file
path, never by checking them out into the worktree. With `checkout = false` a
role has no worktree at all and reads source via `git show` / `git grep` at a
fixed SHA instead.

## §6. Cleanup on return to IDLE / after merge — re-pin + reset, never `git clean -fdx`

On `committed.md` / `merged.md` / `acked.md` (per role), re-pin your detached
HEAD to the current `studio` (or review-target) tip and discard tracked-file
drift accumulated since your last attach:

```bash
git checkout --detach garelier/<target-slug>/<pm_id>/studio
git reset --hard HEAD
```

Why: between tasks the studio branch advances as merges land; an old detached
HEAD lags behind and `git status` reports spurious `M` (modified) entries for
files those merges touched (e.g. sccache binaries, build artifacts other agents
regenerated). A commit-free role owns no commits, so resetting to the current
tip is always safe; a commit-producing role does this only after its branch is
merged.

**NEVER `git clean -fdx`.** It would wipe other agents' worktree build caches
that share the same target checkout family. The build cache is shared; resetting
tracked drift is safe, removing untracked/ignored files is not.
