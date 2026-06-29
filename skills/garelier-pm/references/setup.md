# Garelier PM Setup Wizard Reference

Detailed setup wizard workflow for fresh project initialization and partial recovery.

Extracted from the previous role `SKILL.md`; legacy section numbers are intentionally preserved for cross-references.

## §3. Setup Wizard (fresh project initialization)

Triggered when the pre-flight setup-state check (§1 step 3) reports
**absent** or **partial**. Partial state means a prior wizard run was
interrupted; the wizard script will detect it and offer cleanup
before retrying — see §3.6.

### 3.0 Repo scan FIRST — ask only what the repo cannot tell (DEC-068)

Before asking the user anything, scan the repository and derive every
parameter that is derivable. The user's first setup experience should be
ONE confirmation, not a questionnaire.

Detect (read-only, seconds):

| Parameter | How |
| --- | --- |
| Stack | `Cargo.toml` → rust; `package.json` → typescript; `pyproject.toml`/`setup.py` → python; `go.mod` → go; several → mixed |
| Build/test commands | CI workflows (`.github/workflows/*`), `package.json` scripts, `Makefile`/`justfile`, README build section — prefer what CI actually runs |
| Target branch | `git symbolic-ref --short HEAD` (present as recommended; list real branches) |
| Project name | repo directory name / manifest `name` field (confirmable default) |
| Restricted-file candidates (for §3.3b) | lockfiles, `.github/**`, `migrations/**`, deploy/infra configs, large central data files |
| Convention sources (for §3.3b) | formatter/linter configs (`rustfmt.toml`, `.eslintrc*`, `ruff.toml`…), existing style docs |

Then present ONE summary — "この内容で初期化します: stack=…, gate=…,
target=…, name=…, pm_id=_workshop" — and let the user correct anything.
Only `pm_id` genuinely needs a human answer (single-user default
`_workshop`; shared projects need a unique id, §3.1). Pass the confirmed
values to the wizard as flags (`--stack`, `--quality-gate`, `--target`,
`--project-name`, `--pm-id`).

### 3.1 Greet and gather

Open with a brief greeting and explain what setup will do. With the §3.0
scan done, most parameters arrive pre-filled — confirm the scan summary
instead of asking item by item.

**Ask only what §3.0 could not derive** (always: `pm_id`; sometimes: the
target branch when the repo state is ambiguous; optionally the first
milestone) via `AskUserQuestion`, restating each chosen value in
confirmation.

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

- Fresh Lithosphere setup runs from `target_root/__garelier`.
- Fresh Plant-Crust setup runs from `control_root/__garelier` and passes
  `--target-root target` (normally via `garelier crust-init`; the path is
  relative to `control_root`, not to `garelier_root`).
- Diff mode runs from `garelier_root/<pm_id>/_pm/`.
- `target_root` is a git repository
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

**bash (Git Bash on Windows / Linux / macOS):**
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

### 3.3c Plant-Crust setup

When the user wants Garelier outside the target repository, do not run fresh
setup directly in the target repo. Use Plant-Crust:

```bash
garelier crust-init \
  --workfolder "$WORKFOLDER" \
  --container-id "$CONTAINER_ID" \
  --target-remote "$REMOTE_URL" \
  --target-branch "$TARGET" \
  --pm-id "$PM_ID" \
  --project-name "$PROJECT_NAME"
```

If `target/` already exists inside the container, omit `--target-remote`. If the
user explicitly wants a new empty target repo, pass `--target-init`; otherwise
do not initialize an empty target silently.

The initializer creates `crust.toml`, `container.lock.toml`, the container
`__garelier/`, and `target/`, then runs normal fresh setup from
`container/__garelier/` with `--target-root target`. `crust.toml` is only the
workfolder ledger (`id` plus optional `path` per container); target remote,
target branch, target path, and policy live in `container.lock.toml`.
`crust.toml` only supports `[plant]` and `[[containers]]`. In
Plant-Crust:

- `workfolder/__garelier` is not created and must not be treated as a control
  root. The workfolder is only the registered-container ledger.
- control/runtime writes go under `control_root/__garelier`;
- target `AGENTS.md`, target project scans, Git operations, branch creation,
  and quality gates go under `target_root`;
- `target_root/__garelier` is forbidden.
- PM may coordinate registered containers by reading `crust.toml`, validating
  every registered `container.lock.toml`, reading each
  `container_root/__garelier/<pm_id>/`, and writing per-container Dock requests.
  Dock and subordinate roles stay active-container scoped.
- existing `crust.toml` files are treated as workfolder ledgers: new containers
  are appended, existing `[[containers]]` entries are preserved, and duplicate
  container ids or container paths fail. Removing a container from the ledger is
  a `[[containers]]` block deletion; archiving/deleting the directory is a
  separate user operation.
- `container.lock.toml` is generated by the shared `plant.ts write-lock` path,
  not by shell-specific TOML rendering. Use `garelier plant-lock-validate
  --crust <path> --lock <path>` to validate it directly.
- if initialization was interrupted after the container was added to
  `crust.toml`, rerun `crust-init --resume`; use `--repair-lock` to rewrite only
  `container.lock.toml`.
- in Plant-Crust v1, `setup_wizard --mode diff` may run from
  `container/__garelier/<pm_id>/_pm/`; it auto-detects `container.lock.toml` and
  runs Git operations against `target/`.
- use `garelier plant-containers --crust <workfolder>/crust.toml` for PM
  cross-container planning, and `garelier plant-workfolder-validate --crust
  <workfolder>/crust.toml` before dispatching cross-container work.

For health checks from a workfolder with multiple containers, use:

```bash
garelier doctor --project <workfolder> --container <container-id>
```

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
- Generates `AGENTS.md` skeleton at `target_root` if missing

After the script returns, verify success by:
- Confirming `__garelier/<pm_id>/{_pm,control,runtime}/` exist and no role
  containers were created (`_workers/` etc. absent is correct — DEC-065).
- Confirming the completion marker:
  `grep '^complete = true' __garelier/<pm_id>/_pm/setup_config.toml`. If
  this line is missing, the wizard did not finish — treat the
  install as partial (see §3.6) and re-run.

### 3.3b Guided AGENTS.md fill — propose, don't assign homework (DEC-068)

The fresh `AGENTS.md` keeps `{{...}}` placeholders (restricted files §3,
conventions §10) and a starter §0 principles list — and doctor holds a P0
until they are real. Do NOT leave this as a homework note. Immediately
draft the fill from the §3.0 scan and the repo itself:

1. **Restricted files (§3)**: propose candidates with reasons — lockfiles
   and dependency manifests (human-approval territory), `.github/**` /
   deploy / infra / migrations, central data files the scan flagged as
   conflict-prone. Mark each proposed Lead Owner (often "Human only").
2. **Conventions (§10)**: propose 2-5 short entries from observed reality —
   formatter/linter configs found, commit-message style seen in
   `git log`, naming/layout patterns. Never invent rules the repo does not
   show; fewer honest entries beat padded lists.
3. **Principles (§0)**: keep P1-P3; propose P4+ only where the project has
   a real non-negotiable (determinism gates, protocol compatibility, data
   safety). "P1-P3 only" is a fine outcome.
4. Show the complete draft as a diff, get the user's approval (this is the
   ONE review that replaces hand-editing), apply it, and re-run doctor —
   expected result: zero P0 without the user ever opening an editor.
   The user can of course edit further later; AGENTS.md stays user-owned.

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
git commit -m "Garelier: initialize project (v2.9.2)"
```

Do NOT push `garelier/<target-slug>/<pm_id>/studio` to the remote — Garelier
coordination branches are local-only per `garelier-core/protocol.md`
§6.5. The only Garelier operation that pushes to remote is promote
(§7.3), which pushes the user's `<target>` branch, not studio.

Then the project is ready. Do not end on a manual: **ask for the first
goal** ("最初に何を作りましょうか / what should we build first?") and offer
to turn the answer into the first blueprint on the spot (§4). The setup is
finished when the user has a next action, not when the directories exist.
(Producers run as in-session subagents in ephemeral `_dispatch<N>/` homes —
no separate Dock session is needed; DEC-061/065.)

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

### 3.7 Version upgrade (migrate)

When the installed Garelier skills are newer than the project's recorded
version (config `[project] garelier_version` < the framework's version),
upgrade the project **in place** — no re-init, control and knowledge preserved.

Detection: `doctor` emits a `version-mismatch` finding (config `garelier_version`
vs the installed `EXPECTED_VERSION`). The PM surfaces this on session start /
recovery (pre-flight step 7) and offers the upgrade.

Procedure:

1. Tell the user the project was set up with an older Garelier and that an
   in-place upgrade is available. Confirm before changing anything.
2. Commit or stash uncommitted tracked changes under `__garelier/<pm_id>/` —
   migrate refuses to relocate a worktree that has uncommitted tracked changes.
3. Run the wizard in migrate mode:
   `setup_wizard --mode migrate --pm-id <pm_id>`. It:
   - rewrites `garelier_version` / `wizard_version` to the installed version
     (any prior version, not a fixed list);
   - applies structural migrations for the layout it finds (per-PM layout,
     DEC-051 nested ignores, worktree paths, exile in/out);
   - appends config blocks introduced since the project's version (e.g.
     `[artisan]`, `[status_web]`) without overwriting existing settings.
4. Re-run `doctor` and resolve any remaining findings (e.g. seed new template
   files it flags). A clean `doctor` means the upgrade is complete.

Migrate is idempotent — safe to re-run. It never discards control, blueprints,
inspections, observations, or knowledge; it only updates Garelier's own
structure and version. Structural changes shipped in a new release must add
their own migration here so a cross-version upgrade stays complete.
