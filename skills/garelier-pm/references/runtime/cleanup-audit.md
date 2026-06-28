# Garelier PM Cleanup Audit Reference

### 13.4 Cleanup audit before re-arming the dispatch loop

Triggered when the user says "resume" / "再開" / "進めて" after a crash,
interruption, or session loss (and on any suspicion of residue).

An interrupted session may have left residue from a kill -9, power
loss, a mid-merge gate subprocess termination, or producer WIP that
didn't reach commit. **Audit and clean BEFORE dispatching new work** —
starting on top of dirt makes the next producer inherit confusing
state (pre-existing modified files, a stale merge-gate result, etc.).

Run this audit every time, even when state looks clean — it takes
30 seconds and prevents whole classes of "why is everything
stuck" debugging.

#### 13.4.1 Audit checklist

Run these checks in order, via Bash tool. For each, report findings
to the user and either auto-clean (when safe) or ask before acting.

**1. Orphaned dispatch containers**

```bash
# containers whose producer is gone but STATE.md says WORKING
ls -d __garelier/<pm_id>/_dispatch*/ 2>/dev/null
```

Action:
- A `_dispatch<N>/` with committed work and no live producer → the
  interrupted task. Either re-dispatch INTO the same worktree (resume)
  or `dispatch_cleanup.{sh,ps1} --id <N>` after preserving the branch.
- A `_dispatch<N>/` at the base commit with no work → safe to clean.

**2. Merge gate residue**

```bash
ls __garelier/<pm_id>/runtime/merge_gate/{requests,results,locks}/
cat __garelier/<pm_id>/runtime/merge_gate/locks/active.lock 2>/dev/null
```

Action:
- `locks/active.lock` present + its pid still alive → a merge-gate run IS
  running (caught by step 1 too). Refuse.
- `locks/active.lock` present + its pid dead → subprocess crashed.
  Remove the lock: `rm __garelier/<pm_id>/runtime/merge_gate/locks/active.lock`.
  The next `dock_merge.ts poll` will synthesize an `aborted` result
  per DEC-007 §2.5.
- `results/*.json` present → orphan results that Dock never
  consumed (= the session ended between subprocess success and the
  next Dock iteration). Leave them. The next poll/Dock
  Dock iteration will see them, write `merged.md` to the
  Worker (or `review.md` on failure), and archive. Tell the user
  "N orphan merge results found, will be processed on next
  Dock iteration." Don't delete unless user explicitly says
  so.
- `requests/*.json` present → orphan requests that weren't picked
  up. Same logic — the next poll will spawn the subprocess for
  them. Tell user, leave them.

**3. Partial merge in primary checkout**

```bash
test -f .git/MERGE_HEAD && echo "merge in progress: $(cat .git/MERGE_HEAD)"
```

Action:
- Present → a previous run was interrupted mid-`git merge --no-ff
  --no-commit`. Abort: `git merge --abort`. This restores working
  tree to the studio commit, drops staged-merge state.

**4. Primary checkout dirty state**

```bash
git status --short
```

For each file in the output, categorize:

| Path pattern                                              | Category | Default action |
|-----------------------------------------------------------|----------|-----------------|
| `AGENTS.md`, `CLAUDE.md`                                  | PM-owned (project docs) | Ask user: commit or leave? |
| `__garelier/<pm_id>/_pm/*` (history.md, setup_config.toml, .claude/...) | PM-owned | Ask user: commit or leave? |
| `__garelier/<pm_id>/control/*`                           | PM/Scout-owned | Ask user: commit or leave? |
| `__garelier/<pm_id>/runtime/*`                           | Gitignored — should never appear | Ignore (gitignored anyway) |
| Files matching content on an active workbench branch       | Worker leak (from interrupted merge gate) | Auto-revert: `git checkout HEAD -- <file>` or `rm` if untracked. Tell user. |
| Anything else                                              | Unknown | Show diff to user, ask |

**Detecting Worker leak**: a file `M` or `??` in primary checkout
that exists identically on `garelier/<target-slug>/<pm_id>/workbench/#<N>/<slug>` for
some active Worker is almost certainly leftover from Dock's
merge gate `git merge --no-ff --no-commit` that didn't commit.
Confirm by:
```bash
git diff <workbench-branch> -- <path>     # empty diff = leaked from there
```
If confirmed, revert it. The Worker's workbench branch retains the
work; the next §8.1 merge gate dispatch will properly merge it.

**5. Worktree HEAD drift**

```bash
git worktree list
```

Action:
- Scout / IDLE Workers on detached HEAD pointing at a studio tip
  older than current `garelier/<target-slug>/<pm_id>/studio` →
  not an error. Per Scout SKILL §3 + Worker SKILL §9.1, they
  re-attach to the current studio tip on their next iteration.
  Just note it: "Scout scout-01 is on f798d024, studio is at
  53e6312d; re-attach happens automatically on next Scout iter."
- A `workbench`/`anvil`/`shelf` branch with committed work → in-flight
  inventory; requeue or resume by re-dispatching into its worktree.
- A worktree path that no longer exists on disk → run
  `git worktree prune`. Then file a heads-up to user (something
  deleted a worker's worktree dir).

#### 13.4.2 Decision protocol

For each audit finding, classify:

- **Auto-safe** (= no user input needed): dead-pid `active.lock`, producer-leak
  files with confirmed `git diff <workbench> = empty`,
  `git merge --abort` for an orphan `MERGE_HEAD`.
- **User input needed**: PM-owned dirty files, unknown dirty
  files, any worktree anomaly that's not just a stale tip.

Auto-safe actions: perform them, then tell the user what was
cleaned. Format:

```
Pre-flight cleanup performed:
- aborted orphan merge state (MERGE_HEAD pointed to workbench/#12)
- reverted Worker leak: core/middleware/chunk/src/{lib.rs, residency.rs} (matched workbench/#12 tip)
- 1 orphan merge_gate/results/<file>.json kept — Dock will consume on next iteration
```

User-input items: ask via `AskUserQuestion` with options Commit /
Leave / Show diff first. Never auto-commit PM-owned files —
those represent the user's in-progress conversational state and
deserve explicit acknowledgement.

#### 13.4.3 After audit passes

Resume dispatching: re-dispatch any interrupted task into its preserved
worktree (or `dispatch_cleanup` + fresh `dispatch_prepare`), then continue
the normal loop (jig tick or prose tick). Tell the user what was resumed.

#### 13.4.4 Why not skip the audit?

Historical incidents that this audit prevents (= caught in
practice on Project-X before this section existed):

- **Scout stayed REPORTING forever** (2026-05-25) — Dock
  wrote `committed.md` but Scout SKILL didn't know what to do
  with it. (Fixed by Scout SKILL update.) An audit catches the
  inverse: leftover `committed.md` / `merged.md` from a partial
  cycle that should be cleaned before resume.
- **`M core/middleware/chunk/src/lib.rs`** in primary checkout
  (2026-05-26) — Dock's merge gate sandbox left Worker leak
  when a session stopped mid-cycle. Without audit, the next
  run dispatched on top of this drift.
- **`M script/bin/sccache.exe` everywhere** — 19MB tracked binary
  that sccache touches on every cargo run. Audit catches
  patterns of "same DIRTY file across all worktrees, looks like
  build artifact" and prompts to untrack.

The audit is cheap (under a minute) and prevents these from
silently compounding.
