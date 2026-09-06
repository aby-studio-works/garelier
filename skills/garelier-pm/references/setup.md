# Garelier PM Setup Wizard Reference

Detailed setup wizard workflow for fresh project initialization and in-place repair of an incomplete install.

Extracted from the previous role `SKILL.md`; legacy section numbers are intentionally preserved for cross-references.

## §3. Setup Wizard (fresh project initialization)

Triggered when the pre-flight setup-state check (§1 step 3) reports
**absent** or **partial**. Partial state means a prior wizard run was
interrupted; the wizard script detects it and repairs the namespace in
place, deleting nothing — see §3.6.

### 3.0 Repo scan FIRST — ask only what the repo cannot tell (DEC-068)

Before asking the user anything, scan the repository and derive every
parameter that is derivable. The user's first setup experience should be
ONE confirmation, not a questionnaire.

Detect (read-only, seconds):

| Parameter | How |
| --- | --- |
| Stack | `Cargo.toml` → rust; `package.json` → typescript; `pyproject.toml`/`setup.py` → python; `go.mod` → go; several → mixed |
| Build/test commands | explicit AGENTS.md / CLAUDE.md quality-gate rules, then CI workflows, then manifest scripts — fail if none is authoritative |
| Target branch | `git symbolic-ref --short HEAD` (present as recommended; list real branches) |
| Project name | repo directory name / manifest `name` field (confirmable default) |
| Restricted-file candidates (for §3.3b) | lockfiles, `.github/**`, `migrations/**`, deploy/infra configs, large central data files |
| Convention sources (for §3.3b) | formatter/linter configs (`rustfmt.toml`, `.eslintrc*`, `ruff.toml`…), existing style docs |

Then present the detected summary — "この内容で初期化します: stack=…, gate=…,
target=…, name=…, pm_id=_workshop". Do not turn detected facts into a
questionnaire. Only `pm_id` genuinely needs a human answer (single-user default
`_workshop`; shared projects need a unique id, §3.1). Pass the confirmed
values to the wizard as flags (`--stack`, `--quality-gate`, `--target`,
`--project-name`, `--pm-id`).

Setup leaves provider/model unset and does not infer either from the current
user session. Fresh dispatch supplies provider/model/effort explicitly per task;
an omitted `--provider` is the one exception and resolves to `claude-code`
(W-690, recorded as `provider_source: "framework-default"`) — model and effort
are never defaulted. Recovery and warm reuse read the existing canonical role
authorization.
Setup does not persist or change the user's provider permissions. Plant placement
is inferred from the existing layout: ordinary fresh setup is Lithosphere; new
Crust setup is only an explicit user choice.

### 3.1 Greet and gather

Open with a brief greeting and explain what setup will do. With the §3.0
scan done, most parameters arrive pre-filled — confirm the scan summary
instead of asking item by item.

**Ask only what §3.0 could not derive** (always: `pm_id`; sometimes: the
only `pm_id` via `AskUserQuestion`. Project name, target branch, and quality
gate are inferred from project rules, manifests, and CI; ask a fail-safe
question only when a quality gate cannot be determined.

**Do NOT run a composition/provider/model/permissions/Plant wizard.** Fresh
setup makes every framework role available without fixed role entries,
containers, or pinned provider/model. PM selects the capability and
provider/model/effort per task; blueprint hints and `[model_routing]` are
fallbacks. Diff-mode role flags only maintain intentional persistent
containers and never route a task.

1. **PM identifier (`pm_id`)** — required, first question. `_workshop` is the
   recommended default for a single-user project and remains valid for every
   task-scoped execution route. If the project is shared or used by
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
2. Infer the project name and target branch from repository state. If target
   resolution is ambiguous, fail safely rather than presenting a composition
   interview; request only the missing target value.
3. Infer the quality gate from project policy, manifests, and CI. If no
   authoritative gate is found, require an explicit user confirmation.
4. Defer the initial milestone to the first PM session.

Agent composition is NOT asked here. The wizard registers one id-only
capability entry for every role, creates no role containers, and leaves
provider/model unset. Fresh dispatch supplies provider/model/effort explicitly
per task (an omitted `--provider` resolves to `claude-code`, W-690); recovery and
warm reuse consume their canonical binding. Explicit
persisted overrides may be applied later through `--mode diff`
(`references/promote-and-agents.md`).

### 3.2 Verify git state

Before invoking the wizard script, confirm:

- Plant is auto-detected: fresh normal setup is Lithosphere and runs from
  `target_root/__garelier`; Crust is used only through explicit `crust-init`.
- Fresh Plant-Crust setup runs from `control_root/__garelier` and passes
  `--target-root target` (normally via `garelier crust-init`; the path is
  relative to `control_root`, not to `garelier_root`).
- Diff mode runs from `garelier_root/<pm_id>/_crew/pm/`.
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
  --pm-id "$PM_ID"
```

No composition/provider/model/permission/Plant flags are needed. Fresh setup
auto-detects project name, target, stack, and authoritative quality gate;
registers each role capability by id; and creates no containers (DEC-065).
Power users may still pass `--workers` /
`--scouts` / `--smiths` / `--librarians` / … to set explicit seats or
providers as advanced compatibility overrides.

`--pm-id` is **mandatory** for agent-driven/non-interactive setup — always pass
the value the user chose in §3.1 step 1. Use `_workshop` for single-user use;
use a unique explicit id for shared/multi-user use.

The wizard resolves required executables before project changes: Bun and
gitleaks when Guardian gates are configured. Resolution order is an explicit
`GARELIER_*` override, `PATH`, then narrow OS-standard locations. An unresolved
mandatory executable exits 3. Garelier never installs, downloads, vendors, or
recommends tools.

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
  `container/__garelier/<pm_id>/_crew/pm/`; it auto-detects `container.lock.toml` and
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
- Creates the stable layout-v2 `_crew/` base and its plain `pm/` directory.
  It pre-creates NO role containers (DEC-065 dispatch-native): no `dock/`, no
  `workers/<id>/`, no `artisan/`. Roles run in ephemeral
  `_crew/dispatch<N>/` homes; a persistent container is created on demand via
  `--mode diff`
- Initializes a schema-v3 `__garelier/<pm_id>/control/` tree from
  `control_scaffold_v3`, with `plan_graph_markdown`, a tracked
  `project_dashboard/`, Roadmaps, Backlogs, Checkpoints, Notes, and strict
  lifecycle validation. An existing schema-3 small-starter tree is preserved
  in place and only its `mode` is upgraded to `full`; schemas 1 and 2 are
  rejected explicitly.
- Initializes `__garelier/<pm_id>/runtime/` tree (manifest, backlog, dock,
  pm)
- Generates `__garelier/<pm_id>/_crew/pm/setup_config.toml` from the parameters
  (with `[retention]` defaults and a commented `[health_check]` section;
  see §14 and `garelier-core/retention.md`)
- Leaves optional provider- and stack-neutral `[[dispatch.env]]` declarations
  commented. Each has `name`, `value`, and required `why`; `applies_to` defaults
  to `["producer"]` and may include `"gate"`. The closed placeholder set is
  `{checkout}`, `{project}`, `{container}`, `{dispatch_id}`, `{role}`, `{slug}`.
  Unknown placeholders, a missing `why`, and empty expansion fail prepare;
  secrets do not belong in tracked setup configuration. Put the consumer rule in
  its knowledge tree and add `garelier-core/references/dispatch_env.md` to the
  relevant role's `read_first` list. `{checkout}` always means the direct
  execution checkout/cwd at producer, gate, request, and merge-gate boundaries;
  `{project}` is the PM Control/runtime project root. `{git_root}` is not a
  placeholder. The complete boundary table is in that reference.
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
- Confirming the PM root contains exactly `_crew/`, `control/`, `runtime/`,
  `knowledge/`, `showcase/`, and `gallery/`, with no legacy flat containers.
  `_crew/pm/` exists, while `_crew/workers/` etc. are absent until needed
  (DEC-065).
- Confirming the completion marker:
  `grep '^complete = true' __garelier/<pm_id>/_crew/pm/setup_config.toml`. If
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

If the user provided an initial milestone in §3.1, create the schema-v3
Roadmap/Milestone/Backlog records from their canonical Markdown templates, then
strict-validate the complete plan graph. Use the shared lifecycle transaction
to activate Backlog, Checkpoint, and Current together; no direct multi-file edit
claims filesystem atomicity. The initial session reads bounded Current and
Checkpoint state, then follows typed links rather than scanning `control/`.

Schema 1 and schema 2 starters are rejected explicitly.

If `[autonomy] auto_approve_milestones = true`, skip the user
confirmation step here — commit the milestone immediately and record that it
was approved autonomously in the Backlog Evidence (see §15).

### 3.5 Commit the initial state

```bash
# __garelier/.gitignore + .ignore (nested, DEC-051) are committed via __garelier/.
git add AGENTS.md __garelier/.gitignore __garelier/.ignore \
  __garelier/<pm_id>/_crew/pm/ __garelier/<pm_id>/control/
git commit -m "Garelier: initialize project (v2.10.0)"
```

Do NOT push `garelier/<target-slug>/<pm_id>/studio` to the remote — Garelier
coordination branches are local-only per `garelier-core/protocol.md`
§6.5. The only Garelier operation that pushes to remote is promote
(§7.3), which pushes the user's `<target>` branch, not studio.

Then the project is ready. Do not end on a manual: **ask for the first
goal** ("最初に何を作りましょうか / what should we build first?") and offer
to turn the answer into the first blueprint on the spot (§4). The setup is
finished when the user has a next action, not when the directories exist.
(Roles run as in-session subagents in ephemeral `_crew/dispatch<N>/` homes —
no separate Dock session is needed; DEC-061/065.)

### 3.6 Incomplete install repair

If pre-flight (§1 step 3) reported **partial**, a prior wizard run
was interrupted (user cancelled, terminal closed, hook killed it,
etc.). The existing state can include any subset of:

- `__garelier/<pm_id>/{runtime,control,knowledge,_crew}/` directories
- `_crew/{workers,scouts}/<id>/` worktrees (registered with `git worktree`)
- A `garelier/<target-slug>/<pm_id>/studio` branch
- A nested `__garelier/.gitignore` / `__garelier/.ignore` (DEC-051; root
  `.gitignore` is not touched)
- A partially-written `_crew/pm/setup_config.toml` lacking the
  `[setup] complete = true` marker)

**"partial" means one thing only: the `[setup] complete = true` marker is
absent.** It says nothing about how much control, knowledge, or runtime
evidence the namespace holds — a namespace with years of backlog rows reads
exactly the same as an install that died in its first second. So the wizard
**repairs in place and deletes nothing** (W-313): no `rm -rf`, no
`git branch -D`, no worktree removal. It adds what is missing and keeps every
existing byte.

Concretely, fresh mode on a partial namespace:

- keeps `control/` untouched (identity-checked read-only; it refuses, without
  deleting, a `control/` directory that has no `control.toml`);
- keeps `knowledge/`, `showcase/`, `gallery/` and every existing `runtime/`
  file, and creates only the runtime directories that are absent;
- keeps an existing `runtime/manifest.md` and
  `_crew/pm/.claude/settings.json` rather than regenerating them;
- keeps an existing `setup_config.toml` byte-for-byte and appends only the
  completion marker, taking `[branches] target` / `integration` from it so the
  repair cannot strand the namespace behind a second studio branch. If that
  file exists but records no `[branches] integration`, the wizard stops and
  says so instead of overwriting it;
- **reuses** an existing studio branch (it may carry unmerged work) instead of
  recreating it.

Procedure:

1. Tell the user what was detected. Run `git worktree list` and
   `git for-each-ref --format='%(refname:short)' refs/heads/garelier/*`
   and list both alongside the directories that exist under
   `__garelier/`.
2. Re-do §3.1 from scratch — gather parameters fresh. Do not assume
   the previous values are still wanted. (Branch parameters recorded in an
   existing `setup_config.toml` still win, per above.)
3. Invoke the wizard normally (§3.3). It detects the partial state, prints the
   preserved inventory, and prompts `Repair this install in place? [Y/n]`.
   Nothing is destroyed by answering yes; answering `n` exits without changing
   anything.
4. The wizard continues into the rest of fresh init, filling only the gaps.

Deliberate removal is **not** a side effect of `fresh`. It is `--mode teardown`,
which strips hook wiring, then inventories the remaining worktrees and PM root
and hands the deletion commands to the user — see
`garelier-core/references/deletion_and_forcewrite_safety.md` (inventory →
approval → remove).
