# Garelier PM Setup Wizard Reference

Detailed setup wizard workflow for fresh project initialization and partial recovery.

Extracted from the previous role `SKILL.md`; legacy section numbers are intentionally preserved for cross-references.

## §3. Setup Wizard (fresh project initialization)

Triggered when the pre-flight setup-state check (§1 step 3) reports
**absent** or **partial**. Partial state means a prior wizard run was
interrupted; the wizard script will detect it and offer cleanup
before retrying — see §3.6.

### 3.1 Greet and gather

Open with a brief greeting and explain what setup will do, then collect
the following from the user.

**Ask only the project-specific parameters below** (pm_id, project name,
target branch, and optionally the first milestone) via `AskUserQuestion`,
restating each chosen value in confirmation.

**Do NOT run a composition wizard.** Agent composition is fixed: a fresh
setup declares **exactly one seat of every role** (one Worker, Scout, Smith,
Librarian, Observer, Guardian, Concierge) plus the Artisan lane, all on
Claude Code — as config seats in `setup_config.toml`, with no containers
created (DEC-065). Never ask the user how many of each, which provider, or
about scout idle — every role is minimum one (0 is not an option) and the
wizard supplies these defaults automatically. The user adds more seats or
switches a seat's provider (e.g. Codex) **later** by asking the PM, which
runs `--mode diff` (see `references/promote-and-agents.md`).

1. **PM identifier (`pm_id`)** — required, first question. `_workshop` is the
   recommended default for a single-user project and remains valid after full
   setup for both Artisan and dock lanes. If the project is shared or used by
   multiple users, explicitly require a unique per-user/per-PM id matching
   `[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?` (1–20 chars, lowercase ASCII
   + digits + internal hyphens/underscores). This becomes the
   directory segment `__garelier/<pm_id>/` and the branch segment
   `garelier/<target-slug>/<pm_id>/...`. Multiple PMs can coexist
   on the same project — each developer uses their own slug. Ask whether the
   project is single-user or shared in the `AskUserQuestion`; present
   `_workshop` as the single-user default and explain that shared use requires
   a unique explicit id. Reject invalid ids and re-ask. If
   `__garelier/<chosen_pm_id>/` already exists, abort with a
   helpful error unless it is a `mode = "control_only"` small starter; that
   state is upgraded in place while preserving control and knowledge.
2. **Project name** (string, free-form, used in summaries)
3. **Target branch** (the user-owned branch Garelier integrates into).
   - First run `git symbolic-ref --short HEAD` to learn the current
     branch. Present that as the **first option (recommended)** in the
     `AskUserQuestion` call.
   - **Build the option list ONLY from branches that actually exist**
     (`git branch --list`) — e.g. `main`, `develop`, `release/v1`,
     `main/soft`; cap the list at four so the user can always pick
     "Other" for a free-form entry. **Never invent or suggest a branch
     name from memory.** Garelier's default is `main`; do NOT propose
     the legacy pre-`main` default branch name that git retired for
     inclusivity reasons (it is a banned term here). If the repo's
     current branch literally is that retired name, you may integrate
     into it (it is the user's real branch) but recommend renaming to
     `main` — never let the framework itself put that name forward.
   - If the target name contains `/`, the wizard converts it to a
     slug by replacing `/` with `-` (e.g., `develop/soft` →
     `develop-soft`). Confirm this with the user.
4. **Initial milestone** (optional; can be deferred to the first session
   after setup)

Agent composition is NOT asked here — the wizard declares exactly one seat of
every role in `setup_config.toml` automatically (the rule above). Seats are
SEAT DEFAULTS (provider/model routing, DEC-063/065): no role containers are
created at setup — producers run in ephemeral `_dispatch<N>/` homes. To run
more Workers/Scouts/Smiths, or to put a seat on another provider (e.g. Codex),
the user asks the PM later, which applies the change via `--mode diff`
(`references/promote-and-agents.md`).

### 3.2 Verify git state

Before invoking the wizard script, confirm:

- The cwd is the project's `__garelier/<pm_id>/_pm/` directory.
  (`basename $(pwd)` = `_pm`, parent = `__garelier`).
- The project root is a git repository
  (`git rev-parse --is-inside-work-tree`).
- The repository has at least one commit (`git rev-parse HEAD`
  succeeds).
- The chosen target branch exists. If the user names a target that
  doesn't exist, ask whether to create it first or pick a different
  one.
- The user is willing to have `garelier/<target-slug>/<pm_id>/studio` created
  from that target.

If any of these fail, ask the user how to proceed. Do not modify
git state without confirmation.

### 3.3 Run the wizard

Once parameters are gathered, invoke the wizard script:

**bash (default on MSYS2/Git Bash/Linux/macOS):**
```bash
garelier setup \
  --pm-id "$PM_ID" \
  --project-name "$PROJECT_NAME" \
  --target "$TARGET"
```

No composition flags are needed — fresh setup declares exactly one seat of
every role on Claude Code in `setup_config.toml` (no containers; DEC-065).
(Power users, or the PM via `--mode diff`, may still pass `--workers` /
`--scouts` / `--smiths` / `--librarians` / … to set explicit seats or
providers; omitting them yields one each.)

`--pm-id` is **mandatory** for agent-driven/non-interactive setup — always pass
the value the user chose in §3.1 step 1. Use `_workshop` for single-user use;
use a unique explicit id for shared/multi-user use.

The wizard checks for missing local tooling before project changes:
Bun, driver dependencies, the offline Mermaid bundle, and gitleaks when
Guardian gates are configured. In a real interactive terminal it asks
whether to set them up. If the PM runs the wizard through a
non-interactive tool and it exits with code 3, ask the user whether to
install/setup the listed items; rerun with `--install-tools` only after
that approval. Use `--skip-confirm` only when the user explicitly wants
to continue without tool setup.

**PowerShell (native Windows):**
```powershell
garelier setup `
  -PmId $PmId `
  -ProjectName $ProjectName `
  -Target $Target
```

PowerShell uses the same flow: if the non-interactive run exits with code 3,
ask the user for approval and rerun with `-InstallTools`; otherwise continue
without the flag. `-SkipConfirm` never installs external tools implicitly.

The script:
- Creates `garelier/<target-slug>/<pm_id>/studio` from the chosen target if
  missing
- Switches the primary worktree to `garelier/<target-slug>/<pm_id>/studio`
- Pre-creates NO role containers (DEC-065 dispatch-native): no `_dock/`, no
  `_workers/<id>/`, no `_artisan/`. Producers run in ephemeral
  `_dispatch<N>/` homes; a persistent container is created on demand via
  `--mode diff`
- Initializes `__garelier/<pm_id>/control/` tree, or preserves and upgrades an
  existing small-starter control tree in place
- Initializes `__garelier/<pm_id>/runtime/` tree (manifest, backlog, dock,
  pm)
- Generates `__garelier/<pm_id>/_pm/setup_config.toml` from the parameters
  (with `[retention]` defaults and a commented `[health_check]` section;
  see §14 and `garelier-core/retention.md`)
- Generates `__garelier/<pm_id>/_pm/history.md` with entry #001 (project
  initialized; see §11)
- Creates `__garelier/<pm_id>/control/blueprints/archive/` for shipped /
  abandoned blueprints (see §11)
- Generates `__garelier/<pm_id>/runtime/manifest.md` initial snapshot
- Writes a nested `__garelier/.gitignore` (from `runtime_gitignore`) and
  `__garelier/.ignore` (from `search_ignore`); DEC-051 — the project's root
  `.gitignore`/`.ignore` are NEVER touched (git/ripgrep honor nested ignores).
  Any legacy Garelier block left in a root file by a pre-DEC-051 install is
  migrated away.
- Generates `AGENTS.md` skeleton at project root if missing

After the script returns, verify success by:
- Confirming `__garelier/<pm_id>/{_pm,control,runtime}/` exist and no role
  containers were created (`_workers/` etc. absent is correct — DEC-065).
- Confirming the completion marker:
  `grep '^complete = true' __garelier/<pm_id>/_pm/setup_config.toml`. If
  this line is missing, the wizard did not finish — treat the
  install as partial (see §3.6) and re-run.

### 3.4 Define the first milestone

If the user provided an initial milestone in §3.1, draft it now using
`__garelier/<pm_id>/control/templates/milestone.md`. Save it at
`__garelier/<pm_id>/control/milestones/<slug>.md`, then link it from
`control/project_dashboard/roadmap.md` under "Active milestones".

If `[autonomy] auto_approve_milestones = true`, skip the user
confirmation step here — commit the milestone immediately and log it
to `history.md` with an `autopilot:` tag (see §15).

### 3.5 Commit the initial state

```bash
# __garelier/.gitignore + .ignore (nested, DEC-051) are committed via __garelier/.
git add AGENTS.md __garelier/.gitignore __garelier/.ignore \
  __garelier/<pm_id>/_pm/ __garelier/<pm_id>/control/
git commit -m "Garelier: initialize project (v2.6.1)"
```

Do NOT push `garelier/<target-slug>/<pm_id>/studio` to the remote — Garelier
coordination branches are local-only per `garelier-core/protocol.md`
§6.5. The only Garelier operation that pushes to remote is promote
(§7.3), which pushes the user's `<target>` branch, not studio.

Then the project is ready. Tell the user how to proceed (typically: keep
working in this PM session — it is the orchestrator; producers run as
in-session subagents in ephemeral `_dispatch<N>/` homes, so no separate
Dock session is needed; DEC-061/065).

### 3.6 Partial install recovery

If pre-flight (§1 step 3) reported **partial**, a prior wizard run
was interrupted (user cancelled, terminal closed, hook killed it,
etc.). The leftover state can include any subset of:

- `__garelier/{runtime,control,_pm,_dock}/` directories
- `__garelier/<pm_id>/_workers/<id>/` and `__garelier/<pm_id>/_scouts/<id>/`
  worktrees (registered with `git worktree`)
- A `garelier/<target-slug>/<pm_id>/studio` branch
- A nested `__garelier/.gitignore` / `__garelier/.ignore` (DEC-051; root
  `.gitignore` is not touched)
- A partially-written `__garelier/<pm_id>/_pm/setup_config.toml` (lacking the
  `[setup] complete = true` marker)

Procedure:

1. Tell the user what was detected. Run `git worktree list` and
   `git for-each-ref --format='%(refname:short)' refs/heads/garelier/*`
   and list both alongside the directories that exist under
   `__garelier/`.
2. Re-do §3.1 from scratch — gather parameters fresh. Do not assume
   the previous values are still wanted.
3. Invoke the wizard normally (§3.3). It detects the partial state,
   re-prints the leftover summary, and prompts:
   `Clean these up and continue with fresh init? [y/N]`. Confirm with
   the user before answering `y` on their behalf — this step removes
   worktrees, deletes the studio branch, and runs `rm -rf __garelier/`.
4. After cleanup the wizard continues into normal fresh init.

If the user prefers manual cleanup (e.g., they want to preserve some
of the leftover state), abort the wizard at the prompt and resolve by
hand, then re-run.
