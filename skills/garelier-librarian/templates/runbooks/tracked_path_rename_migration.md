# Runbook: safe tracked-path / vocabulary rename + live-deployment migration

<!--
  Written by the Librarian. Knowledge path in target projects:
  runbooks/tracked_path_rename_migration.md
  Captures how to rename a framework vocabulary term / tracked path (role name,
  brand, branch family, the __garelier prefix) WITHOUT parking the pipeline.
  Distilled from DEC-050 (Symphorie→Garelier) — including the mistake that
  caused a P0 operator-surgery stall, so it is never repeated.
  Registered in the routine_registry.toml knowledge index.
-->

## Purpose

Rename a framework vocabulary term or tracked path — e.g. brand (Symphorie→
Garelier), a role (Orchestra→Dock, Soloist→Artisan), a branch family
(instrument→satchel), or the `__garelier/` prefix — across (A) the framework
repo and (B) a **live** target deployment (its `__garelier/<pm_id>/` tree +
`garelier/<slug>/<pm_id>/*` branches + worktrees), preserving all in-flight work
and history, **without** creating the branch divergence that parks the pipeline.

## Trigger

Any rename that touches **tracked** paths/strings present on **more than one
branch** of a live deployment (studio + in-flight workbench/anvil/shelf/satchel).
Pure framework-repo renames (no live deployment) only need Procedure A.

## Default role

- **operator** (human-grant lane) executes the git mutate steps (branch rename,
  `git mv`, `worktree repair`, cherry-pick) — headless roles CANNOT (git
  history-rewrite is approval-gated by design).
- **Librarian** maintains this runbook; **PM** approves the migration and
  intakes the result.

## Inputs

- The ordered rename map (every case variant, longest stem first — see THE CORE RULE).
- Framework repo path; live deployment project root + `pm_id`.

## Output

- Renamed framework repo (committed) and migrated live deployment (committed on
  all branches; runtime/config rewritten); `doctor` clean; zero residual old tokens.

## THE CORE RULE (this is what bites — read first)

**Produce ONE shared rename ancestor. NEVER commit the same path-rename
independently on studio AND on each in-flight branch.**

If studio gets rename commit `X` and workbench `#16` gets a *different* rename
commit `Y` (same logical change, no common ancestor), git sees BOTH sides
renaming `old/path`→`new/path` independently. A `--no-ff` merge then produces
`rename/delete` + `add/add` conflicts that the **headless merge-gate / Dock
cannot resolve** (history rewrite is approval-gated) → the pipeline parks and
escalates "operator surgery required" (DEC-050). Avoid by choosing ONE of:

- **Strategy 1 (preferred): rename on studio once, then rebase in-flight onto it.**
  Commit the rename as a single commit on `studio`. For each open
  workbench/anvil branch, `git rebase --onto <new-studio> <old-base> <branch>`
  so it replays its work on top of the renamed studio = **shares the one rename
  ancestor**. Then normal merge-gate merges cleanly.
- **Strategy 2: flush first.** Land/merge all in-flight branches into studio,
  reach a quiescent tree (no open workbenches), THEN rename once on studio and
  cut new branches from it.

Either way: gitignored runtime/role dirs (`runtime/`, `_workers/`, `_dock`,
`_artisan`, …) are branch-independent — moving them is a filesystem op, not a
per-branch commit.

## Procedure A — framework repo rename

1. Recon: `git grep -I -io <term>` counts; find collisions and **stems that must
   order first** (e.g. `orchestration`→`coordination` BEFORE `orchestra`→`dock`,
   else "docktion"). Check katakana/non-ASCII variants too (`git grep` ASCII-only).
2. Pre-edit any prose the mechanical pass would corrupt (e.g. "orchestral",
   "an `instrument`" article cases — fix a/an after).
3. Run the token replacer (ordered, case-aware, NUL-safe):
   `bun scripts/rename_tracked_token.ts <repo> rules.json --dry` then for real.
   It round-trips latin1 so files with an intentional NUL (e.g. a cache-key
   separator) are patched byte-exact — do NOT use a NUL=binary skip.
4. `git mv` dirs/files (skill dirs, role-named templates, DECs, the dogfood
   `__garelier/`). Re-point `~/.claude/skills/<old>-*` symlinks to `<new>-*`
   (use the PowerShell installer on Windows for native symlinks; MSYS `ln -s`
   silently COPIES).
5. Fix a/an articles, verify: `git grep --text -l -iE "<old tokens>"` = ∅
   (use `--text`; `-I` hides binary-detected files like the NUL one).
6. `tsc --noEmit`, driver tests, `check_doc_sync.ts`, `ci.sh`. Add an DEC.

## Procedure B — live deployment in-place migration

1. **Pre-flight.** Quiesce dispatch: disarm the `/loop`, wait for live
   `_dispatch<N>` producers to finish (`status.{sh,ps1}` LIVE = none), and stop
   the Status Web (`stop_status.sh` — its bun process holds file handles; MSYS
   `ps` cannot see native Windows processes, use PowerShell `Get-Process`).
   Back up: `git bundle create <bk>.bundle --all` + tar the
   coordination state (`__garelier`, `--exclude '*/checkout/*'`, use
   `--force-local` on Windows so the `C:` drive isn't read as a remote host) +
   copy `.git/worktrees/`.
2. **Branch strategy.** Apply Strategy 1 or 2 from THE CORE RULE so studio and
   every in-flight branch end up sharing ONE rename ancestor.
3. **Branch namespace rename** (do BEFORE dir moves, while worktree pointers are
   intact so HEADs update): `git branch -m old new` for each
   `<old>/<slug>/<pm_id>/*` → `<new>/<slug>/<pm_id>/*` (modern git updates
   branches checked out in linked worktrees).
4. **Directory moves**: rename inner gitignored role dirs (`_orchestra`→`_dock`,
   `_soloist`→`_artisan`, `runtime/orchestra`→`runtime/dock`) then the top
   `__symphorie`→`__garelier`. Then `git worktree repair <new-checkout-paths…>`
   to re-link all worktree gitdir pointers; verify `git worktree list` shows new
   paths with no "prunable", and `worktree prune -n` finds nothing.
5. **Token rewrite — WHOLE tracked tree, in TWO scoped passes** (do NOT limit to
   `__garelier/` — the framework is referenced project-wide: the Librarian
   knowledge tree `docs/<old>/`, `AGENTS.md`, the nested
   `__garelier/.gitignore`/`.ignore` (DEC-051 — the project's ROOT .gitignore is
   not framework-owned), and `__<old>/...` path mentions in the target's own
   source doc-comments + docs).
   Exclude any `/checkout/` path (nested worktree trees). Also `git mv
   docs/<old>/ docs/<new>/` — the status web reads `docs/<new>/` for the
   Knowledge / RoleKnowledge / Source / Routine panels; if you forget it they
   show EMPTY (observed live, DEC-050 follow-up).
   - **Pass 1 — brand/path only** (`<old-brand>`→`<new-brand>`, e.g.
     symphorie→garelier): apply to ALL tracked files. Always safe — fixes
     `__<old>/…` paths in rust doc-comments/docs everywhere.
   - **Pass 2 — role/vocabulary rules** (Orchestra→Dock, Soloist→Artisan,
     instrument→satchel, orchestration→coordination): apply ONLY to
     FRAMEWORK-OWNED files — `docs/<new>/**`, `AGENTS.md`, the nested
     `__garelier/.gitignore`/`.ignore` (NOT the project's root files; DEC-051),
     role_index/registries. **NEVER the target's own source/docs**: a real
     project routinely uses these words as DOMAIN terms (e.g. the target
     project's `server_orchestration.rs`, "session orchestration",
     `instrument`-ation) and
     a blanket pass would corrupt the build. Verify first:
     `git grep -niw "orchestration|instrument|orchestra|soloist"` over the
     non-framework tree and confirm every hit is a framework reference.
   Then normalize a/an articles (an Artisan / a Dock / a satchel). All branches
   must agree (Strategy 1's rebase, or rename on studio only when no in-flight
   branch touches the renamed paths — a one-sided rename merges cleanly).
6. **Re-install** `~/.claude/skills` symlinks to the new names. Re-install any
   per-worktree git config that points at the old skill path (e.g. the Concierge
   push-guard `core.hooksPath` → `install_concierge_guards.sh`).
7. **Verify**: `doctor.{sh,ps1}` = 0 P0/P1 (incl. the studio-topology check);
   filesystem scan for residual old tokens in the coordination tree = ∅; every
   branch tree has 0 old-prefix tracked paths.
8. **Restart** the Status Web (`start_status.sh`) and re-arm the dispatch loop
   if it was armed; confirm the status web picks up the new tip and the next
   dispatch cuts its worktree from the renamed studio.

## Recovery — if the divergence already happened (operator surgery)

The deliverables are safe (preserved on the workbench branches). To land them on
studio without the double-rename conflict:

1. `git switch <studio>` in the main checkout (un-detach if drifted).
2. `git cherry-pick -x <work-commits>` for each in-flight branch — the actual
   work commits ONLY, dropping the redundant rename commit. They apply cleanly
   (the work diff doesn't touch the rename paths).
3. Notify Dock/PM (new studio tip) via `runtime/dock/inbox/` + `runtime/pm/inbox/`
   so they re-gate, mark the workbenches done, lift holds, and GC the redundant
   branches. Do NOT let the workbenches re-merge (double-apply).

## Completion criteria

- [ ] `git grep --text -l -iE "<old tokens>"` = ∅ in framework repo and live tree.
- [ ] Every live branch tree has 0 `<old-prefix>/` tracked paths; all share one rename ancestor.
- [ ] `git worktree list` healthy (new paths, no prunable); `doctor` 0 P0/P1.
- [ ] Driver restarts, PM intakes, pipeline resumes; manifest/status reflect the new tip.

## Escalation

- To PM: approve the migration; intake the result; decide post-hoc audit for any
  gate skipped during recovery surgery.
- To Scout: investigate unexpected residual references or build breakage.
- To Worker: code-level fixes a mechanical rename can't make.
- To Smith: integration/quality verification after the rename.

## Revision history

- 2026-06-04 — Initial version (distilled from DEC-050 Symphorie→Garelier rebrand
  + the operator-surgery recovery; pairs with `scripts/rename_tracked_token.ts`,
  the doctor studio-topology check, and the merge-gate detached-HEAD guard).
