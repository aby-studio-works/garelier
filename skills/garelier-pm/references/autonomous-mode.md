# Garelier PM Autonomous Mode Reference

> **DEC-061 — dispatch-only.** The headless `claude -p` DRIVER (Mode B) and its
> hybrid/`supervise_pm`/`driver_poll_interval_seconds` variants below are
> **DISABLED**: `start_driver` and the driver entrypoint refuse to launch.
> Garelier runs roles via **dispatch** only (the interactive PM/Dock session
> dispatches each role as an in-session subagent, or a `codex exec` subprocess).
> The only autonomous path is the opt-in Mode-D `/loop` (still `enabled = false`
> by default) — see `garelier-dock/references/mode-d-tick.md`. The driver-mode
> material below is retained as historical context.

Autonomous /loop (dispatch) mode and finished-roadmap handling. (The headless
driver / hybrid material is historical — see the DEC-061 note above.)

Extracted from the previous role `SKILL.md`; legacy section numbers are intentionally preserved for cross-references.

## §15. Autonomous mode

Garelier can run unattended for large, long-running roadmaps. PM is
the role most affected — many user-confirmation gates collapse when
autonomous mode is enabled. This section is the consolidated reference;
individual sections (§3.4, §4.1, §7) cite back here.

DEC: DEC-002 (autonomous mode via per-iteration `claude -p` driver).

### 15.1 The `[autonomy]` block

Read it from `__garelier/<pm_id>/_pm/setup_config.toml`. The wizard generates
this block commented out, so the absence of an `[autonomy]` section is
equivalent to `enabled = false`.

```toml
[autonomy]
enabled = false                          # top-level switch (the autonomous loop is opt-in)
auto_approve_blueprints = false          # PM commits drafts without user review
auto_approve_milestones = false          # PM updates milestones without confirmation

# Canonical mode (DEC-059) — see §15.12 for the full Mode-D schema:
mode = "d"                               # "d" = dispatch (the default and only live mode, even when this block is absent)
                                         # "b" = headless driver — disabled (DEC-061), retained as history

# Mode B (driver) supervision:
driver_poll_interval_seconds = 30
supervise_pm = true                      # false = hybrid mode (see §15.8):
                                         #   driver skips PM; user runs interactive
                                         #   PM in _pm/ themselves. Auto-approve
                                         #   flags still apply to that PM.

# Mode D (DEC-059 gated Dock auto-loop; see §15.12 + garelier-dock/references/mode-d-tick.md):
fan_out_cap = 3                          # max parallel producer subagents per tick
protected_paths = ["core/engine/**", "Cargo.toml", ".github/**", "infra/**", "migrations/**"]
```

When `enabled = false`:
- All sub-flags are ignored. PM behaves as classic (pre-autonomous) v2.0.
- The driver is not started.
- Nothing below applies.

When `enabled = true`:
- Sub-flags take effect (see §15.2).
- Driver (`skills/garelier-core/scripts/start_driver.{sh,ps1}`)
  invokes each role as a fresh configured-provider process per poll
  interval (`claude -p` or `codex exec`). Every iteration is
  short-lived; state is recovered from files on cold start.
- See garelier-core `references/execution-and-operations.md`
  "The driver (autonomous mode)" for the supervision model.

### 15.2 What PM skips when enabled

| Flag                                | Skipped step                                                        |
| ----------------------------------- | ------------------------------------------------------------------- |
| `auto_approve_blueprints = true`    | §4.1 step 2 (clarifying questions) and step 5 (user approval). PM drafts on its best interpretation and records open questions in the blueprint. |
| `auto_approve_milestones = true`    | §3.4 milestone confirmation. §4.1 step 6 milestone creation/update without confirmation. |

Anything not listed remains user-gated. In particular:

- **Promote** (§7): always user-instructed. There is no
  `auto_promote` flag.
- **Setup wizard** (§3): asks user for project name, target, agent set
  even with autonomy enabled (because the config doesn't exist yet
  when the wizard runs).
- **Clean stop** (§13.2): always user-confirmed (it's the safety
  valve).
- **Data-change execution approval** (per data_change_policy.md):
  always user-confirmed per execution; no autonomy bypass.
- **Escalation responses** (§6): when user judgment is genuinely
  needed, PM still asks. Autonomous mode does not invent answers.

### 15.3 `autopilot:` tagging

Every history.md entry created without user confirmation gets its
Outcome prefixed `autopilot:`. This lets the user audit later what
was auto-decided:

```bash
grep "Outcome: autopilot:" __garelier/<pm_id>/_pm/history.md
```

The Notes field records which flag(s) caused the auto-approval, e.g.
`Notes: auto_approve_blueprints=true. Open questions recorded in blueprint.`

### 15.4 Per-iteration invocation

When `enabled = true` **and** `supervise_pm = true` (the default),
PM is invoked by the driver as a fresh configured-provider process
every poll interval. Each invocation runs one iteration of PM's
responsibilities (process inbox, draft pending blueprints, update
history, etc.) and exits. There is no long-lived PM session.

When `supervise_pm = false` (hybrid mode, §15.8), the driver does
**not** spawn PM — the user keeps an interactive PM session in
`__garelier/<pm_id>/_pm/`. The autonomy auto-approve flags still apply to
that interactive PM (PM skips clarifying questions and user confirmation
per §15.2), but PM only acts when the user prompts it.

Implication for your behavior:

- **Do not poll or sleep inside your iteration.** Respond to current
  state in one pass and exit.
- **Trust files for state.** You don't carry context between
  invocations. Re-read
  `__garelier/<pm_id>/control/project_dashboard/roadmap.md`,
  `history.md`, and inbox on each cold start.
- **Exit promptly when there's nothing to do.** If inbox is empty,
  all active milestones already have blueprint backlog covered, and
  no blueprint is pending, just stop.
- **Do not refresh derived files for status only.** In driver mode,
  no-op writes to `history.md`, dashboard files, or `runtime/manifest.md`
  create mtime churn that can wake later iterations without new work.
  If computed content is identical, leave the file untouched and exit
  with `no action: <reason>`.
- **No `/compact` or `/clear` strategy.** Each invocation is fresh;
  context-lifecycle tuning is irrelevant.

When `enabled = false`, PM is started by the user in a terminal as
in v1.0, and your loop is driven by user prompts.

### 15.5 Enabling autonomous mode

> **Taxonomy reconciliation (DEC-059, 2026-06-08).** The Mode A/B/C labels in
> this section and §15.9 are the **historical** driver-era taxonomy and are kept
> for cross-reference. The **canonical** modes are now just **two** (see §15.12):
> **Mode B = interactive PM + headless DRIVER** (disabled per DEC-061, retained as
> historical/reference) and **Mode D = interactive PM + DISPATCH** (the default and
> only live mode). The older labels map as:
> - **Old Mode A (Full driver, `supervise_pm = true`)** — its *headless-supervised
>   PM* is **deprecated**: Garelier always runs an **interactive** PM, so a
>   headless PM is no longer a usage mode. Its *valuable* part — letting PM
>   **proceed on its own judgment when safe** instead of asking at every step — is
>   **kept**, but as the `auto_approve_*` soft-gate-collapse **setting within Mode
>   B/D** (plus the four hard human gates), not as a headless PM.
> - **Old Mode B (Hybrid driver + interactive PM, `supervise_pm = false`)** **is**
>   the canonical **Mode B** — interactive PM + headless driver for the rest of the
>   pipeline. "Mode B" therefore has ONE meaning across both taxonomies.
> - **Old Mode C (no driver, interactive `/loop`)** **folds into Mode D** — Mode D
>   *is* the dispatch `/loop` with the gate detector (§15.12).
>
> So when picking a mode below, read "Mode A" as "deprecated headless-PM; use the
> auto-proceed flags within B/D instead", "Mode B" as the canonical headless-driver
> path, and "Mode C" as "use Mode D" (§15.12).

The user opts in by uncommenting `[autonomy]` and setting
`enabled = true`. When the user enables it for the first time, PM
should:

1. Confirm the user understands cost implications: every poll
   interval spawns a fresh provider CLI invocation per active role
   (PM and Dock every interval; Worker, Scout, and Smith while their
   STATE is active). Total cost scales with poll frequency × number
   of agents × duration.
2. Confirm the user has reviewed the sub-flags.
3. Help the user pick a **run mode** — there are three (see also §15.9 for a side-by-side):

   **Mode A: Full driver** (`supervise_pm = true`). *(DEC-059: the
   headless-supervised PM is **deprecated** — Garelier always keeps PM
   interactive. Do not start a headless PM; instead use Mode B/D and set the
   `auto_approve_*` flags so the interactive PM proceeds on its own judgment when
   safe. The rest of this entry is retained for historical reference.)*
   Driver supervises PM, Dock, Workers, Scouts, Smiths. User has no
   interactive Garelier sessions open. Best for unattended runs.
   - Prereq: `bun` and `ripgrep` on PATH. First-time only:
     `cd ../../garelier-core/driver && bun install`.
   - Auth: run `claude login` or `codex login` once for every provider
     configured in `_pm/setup_config.toml`. The driver uses each CLI's
     local login store; no provider API key is managed by Garelier.
   - Provider/model/effort: configure `[runner]` and per-agent
     `provider`, `model`, `effort` before starting the driver. Changing
     these requires driver restart.
   - **Before starting the driver, run §13.4 pre-flight cleanup**
     (stale pid file, orphan merge_gate locks, primary-checkout
     dirt categorization, partial merge state). Skipping this lets
     prior-session residue confuse the new driver.
   - Start (user opens a fresh terminal, closes everything else):
     ```powershell
     garelier driver -ProjectRoot <path>
     ```
     (bash: `garelier driver --project <project-root>`)

   **Mode B: Hybrid driver + interactive PM** (`supervise_pm = false`).
   *(DEC-059: this **is** the canonical **Mode B** — interactive PM + headless
   **driver**. Per DEC-061 the headless driver is **disabled** (refuses to launch);
   this entry is retained as historical/reference. "Mode B" means the same thing in
   §15.12.)*
   Driver supervises Dock / Workers / Scouts / Smiths; user keeps an
   interactive PM session. Best when the project needs frequent PM
   conversations. See §15.8 for full setup.
   - Same prereqs as Mode A.
   - PM may invoke the start_driver helper via its Bash tool — the
     helper detaches the driver from PM's subprocess so it survives.

   **Mode C: No driver, interactive `/loop`** (no `[autonomy]` change
   required, or set `enabled = false`). *(DEC-059: Mode C **folds into Mode D**
   (§15.12) — Mode D is the dispatch `/loop` with the gate detector and is the
   default and only live mode. Prefer Mode D; this §15.10 setup is retained as a
   historical pattern.)*
   User opens an interactive `claude` session per role's worktree and
   uses `/loop <interval>` to auto-poll each one. No driver process,
   no `bun`, no `start_driver` helper. Works with no tooling beyond
   Claude Code itself. See §15.10 for setup.

   In **Mode A** specifically, PM must **not** spawn the driver
   itself via the start_driver helper — that would cause a duplicate
   PM iteration. The driver writes its own `driver.pid` and refuses
   to start a second instance, so the actual failure is just a clean
   "already running" error — but it's still the wrong pattern.
4. From the next session onward (when driver-invoked PM starts up),
   behave per §15.2 onward.

### 15.6 Disabling

The user can flip `enabled = false` at any time. PM should:

1. Touch `__garelier/<pm_id>/runtime/driver/stop` to signal the driver.
2. Wait for in-flight Worker/Scout/Smith tasks to complete (or call clean
   stop on each via §13.2).
3. Confirm to user that autonomous mode is off.

### 15.6.1 Status inspection

Use `../../garelier-core/scripts/status.{sh,ps1}` (run
from the project root) to get a one-shot human-readable summary of
project state: driver liveness (alive / stale / not running), currently
spawning iterations, per-Worker / per-Scout / per-Smith state from STATE.md,
backlog counts and active milestones from manifest.md, open
escalations, and the last lines of driver logs. Pass `--watch N`
(bash) or `-Watch N` (PowerShell) to refresh every N seconds.

PM should mention this to the user when they ask how to monitor an
autonomous run — it requires no PM session, can be opened in any
spare terminal, and surfaces stale-driver markers prominently.

### 15.7 User input during autonomous mode

When `supervise_pm = true`, PM is not interactive while autonomous
mode is running (no terminal at the keyboard, just one-shot Anthropic
API calls from the driver). The user has four channels to inject
input mid-run:

(When `supervise_pm = false`, the user simply talks to the interactive
PM session as in classic mode — see §15.8. The four channels below
still work, but they're the *only* options under full driver mode.)

1. **Edit the milestone listing directly** (in
   `__garelier/<pm_id>/control/project_dashboard/roadmap.md` or a dedicated
   milestones file) — add a new milestone, or add a new entry under
   an existing milestone's "Blueprints included" section. PM picks it
   up on the next iteration via §4.5 and drafts the blueprint.
2. **Drop a blueprint stub** at
   `__garelier/<pm_id>/control/blueprints/<slug>.md` with minimal Goal /
   Acceptance criteria. PM treats it as a user-supplied blueprint on
   the next iteration (you'll see the file exists but lacks the
   polish §4.2 demands; flesh it out, then commit per §4.1 step
   7-8).
3. **Write a PM inbox notification** at
   `__garelier/<pm_id>/runtime/pm/inbox/<YYYYMMDD-HHMMSS>-user-<topic>.md`
   following `templates/inbox_notification.md`. PM reads the inbox
   at the start of every iteration (§6) and acts before drafting.
   Use this for instructions that aren't tied to a specific blueprint —
   "pause new blueprint drafting," "switch milestone priority,"
   "promote when current work completes," etc.

   **Dispatch holds must be visible.** A hold silently parks the backlog;
   from the outside an idle run then looks broken ("why is nothing
   moving?"). Whenever a directive HOLDS dispatch of a milestone, also
   write/refresh the canonical marker
   `__garelier/<pm_id>/runtime/dock/dispatch_hold.md` (a short note:
   which milestone/scope is held, why, issued timestamp). **Delete it the
   moment the hold is lifted.** The Status Web reads this marker (falling
   back to scanning `dock/inbox/` for hold directives) and shows a
   `⏸ DISPATCH HOLD` banner so a watcher sees *why* the pipeline is parked
   without reading runtime files. There is no per-milestone auto-stop in
   the framework — milestones progress continuously under autonomy (§4.5);
   a hold is the *only* thing that parks them, so it must never be silent.
4. **Stop the driver and resume interactive PM** — touch
   `__garelier/<pm_id>/runtime/driver/stop`, wait for in-flight work,
   then open a PM terminal as in v1.0. Required for: promote
   approval, complex re-scoping conversations, anything where back-
   and-forth dialogue beats single-shot file writes.

For scope changes mid-run, option 1 is preferred (most direct).
Option 3 is the catch-all when the change doesn't map cleanly to
the milestone/blueprint model.

### 15.8 Hybrid mode (interactive PM + driver-supervised others)

Setting `[autonomy] supervise_pm = false` lets the user keep PM
interactive while the driver still supervises Dock, Workers, and
Scouts headlessly. The driver logs `supervise_pm=false` and
`hybrid mode: PM is NOT supervised` at startup so you can confirm the
mode.

**When to choose this over full driver mode**:

- The project needs frequent back-and-forth between user and PM
  (clarifying scope, judgment calls on data-change tasks, promote
  conversations) that don't map cleanly to the four file-based input
  channels in §15.7.
- The user wants to *see* PM's reasoning in real time, not read it
  back from logs after the fact.
- Cost-wise, the user accepts the longer-running interactive PM
  session in exchange for skipping the driver's PM polling overhead.

**Setup**:

1. In `__garelier/<pm_id>/_pm/setup_config.toml`, set
   `[autonomy] supervise_pm = false` (and keep `enabled = true` plus
   the auto-approve flags you want).
2. Open an interactive PM session: `cd __garelier/<pm_id>/_pm && claude`
   or, for a Codex PM session, run Codex from the same directory after
   reading the PM and garelier-core skill files.
3. Start the driver. Two equivalent paths:
   - **User-managed** (separate terminal): user opens a new terminal
     and runs the start_driver helper at the project root:
     `& "..\..\garelier-core\scripts\start_driver.ps1"`
     (or `start_driver.sh` on bash). The helper detaches the driver
     via `Start-Process -WindowStyle Hidden` (Windows) / `setsid` or
     `nohup` (Unix), so it outlives the launching shell.
   - **PM-managed** (when user says "進めて" / "start driver" /
     "再開"): PM **first runs §13.4 pre-flight cleanup audit**
     (stale pid/lock removal, partial-merge abort, primary-checkout
     dirt classification with user confirmation for PM-owned items,
     Worker-leak revert), then uses its Bash tool to call the same
     helper. Detach guarantees the driver survives PM's next turn.
   The driver writes `__garelier/<pm_id>/runtime/driver/driver.pid` on
   startup and refuses to start if another instance is alive. It
   spawns the configured provider per role iteration — auth via
   `claude login` or `codex login`; Garelier does not manage provider
   API keys.
4. Do not open additional Dock / Worker / Scout / Smith interactive
   sessions — the driver is now spawning provider CLIs for those
   roles, and a second interactive agent in the same worktree will
   race on the git index and STATE.md.

**Stopping the driver**:

Four options:

- **Automatic on /quit** (recommended, hybrid mode): the SessionEnd hook in
  `_pm/.claude/settings.json` touches the stop file when an **interactive**
  PM session ends. Driver exits within ~500ms. Just `/quit` PM normally.
  The hook is gated on `GARELIER_DRIVER` being **unset**: the driver sets
  `GARELIER_DRIVER=1` for every provider session it spawns (role.ts), so
  under `supervise_pm = true` the driver's own headless PM iterations end
  without touching the stop file — otherwise the driver would kill itself
  after a single PM iteration. Only a human-run interactive PM `/quit`
  (no such env) signals a stop.
- **PM-managed via helper** (when user says "終了" / "stop driver"
  but wants to keep PM open): PM uses its Bash tool to call
  `stop_driver.ps1 -ProjectRoot <path>` (or `stop_driver.sh
  <project-root>`). Add `-Wait` / `--wait` to block until exit.
- **Manual stop-file touch**:
  `New-Item __garelier/<pm_id>/runtime/driver/stop -ItemType File`
  (PowerShell) or `touch __garelier/<pm_id>/runtime/driver/stop` (bash).
- **Ctrl-C in the driver terminal**: same effect as the stop file
  (driver traps SIGINT/SIGTERM).

**Behavioral implications for PM (you)**:

- You behave as in classic v1.0 mode: respond to user prompts,
  iterate on blueprint drafts conversationally if `auto_approve_blueprints
  = false`, or write your best interpretation immediately if it's
  `true` (per §15.2).
- You share the main checkout with the driver-spawned Dock (per
  CLAUDE.md `_pm/` and `_dock/` share the index). Concurrent
  commits can hit `.git/index.lock`; if a `git commit` fails with
  that error, retry once after 1-2 seconds. Don't auto-loop more
  than 2 retries — instead surface the conflict to the user.
- You do **not** need to process `__garelier/<pm_id>/runtime/pm/inbox/`
  proactively (the user is at the keyboard) — but check it when the
  user says "any pending?" or at the start of each session in case
  driver-Dock or scheduled jobs left notifications.
- Auto-drafting from milestones (§4.5) is **not** triggered
  automatically — there's no per-poll PM iteration. If the user wants
  PM to walk through the milestone backlog, they prompt you for it
  explicitly.

**Switching back to full driver mode**: edit the config to
`supervise_pm = true`, close the interactive PM session, then restart
the driver. The driver will resume invoking PM every poll.

### 15.9 Mode comparison

> **Reconciliation (DEC-059, 2026-06-08).** This table compares the **historical**
> A/B/C driver-era modes and is kept for reference. Under the canonical two-mode
> taxonomy (§15.12): **column "Mode A"** = the now-**deprecated** headless-supervised
> PM (use the `auto_approve_*` auto-proceed flags inside B/D instead — never a
> headless PM); **column "Mode B"** = the canonical **Mode B** (interactive PM +
> headless driver — disabled per DEC-061, retained as historical/reference);
> **column "Mode C"** = now **folded into Mode D** (interactive PM + dispatch, the
> **default and only live** mode, §15.12). For the current picture, read §15.12
> alongside this table.

| | Mode A: Full driver | Mode B: Hybrid driver | Mode C: Interactive + /loop |
|---|---|---|---|
| `[autonomy] enabled` | `true` | `true` | `false` (or `true` if you want auto-approve flags to still apply to interactive PM) |
| `supervise_pm` | `true` | `false` | n/a |
| Terminals user has open | 0 (or just monitoring) | 1 (PM) | PM + Dock + each Worker / Scout / Smith |
| Bun required | yes | yes | no |
| Provider login required | yes (`claude login` / `codex login` as configured) | yes | yes (for interactive sessions) |
| Provider API key managed by Garelier | no | no | no |
| User can converse with PM mid-run | no (file-based inputs only — §15.7) | yes | yes |
| Cost when idle | 0 (mtime pre-check skips iterations) | 0 (same) | one full claude turn per /loop tick per session |
| Best for | unattended batch / overnight | active development with frequent PM steering | quick iteration / debugging / first try / cost-sensitive |

Switching modes is cheap: stop the driver if any (touch the stop
file), edit `supervise_pm` if changing between A and B, and start
the chosen mode's setup.

### 15.10 Mode C: interactive sessions with /loop

When the driver isn't desirable — no Bun install, debugging a stuck
role one step at a time, or simply wanting full live observability
of every reasoning step — the
user can run all roles as **interactive `claude` sessions** and add
`/loop <interval> "<prompt>"` to each non-PM session for auto-polling.

This is what users did before the driver existed. It's a fully
supported run mode and PM should suggest it when the user doesn't
want the Bun toolchain.

**Setup**:

1. Optionally set `[autonomy] enabled = false` if you want PM to
   behave classically. Or leave `enabled = true` so the auto-approve
   flags still apply (PM still skips clarifying questions etc.).
2. User opens one terminal per role:
   ```text
   Terminal 1:  cd <root>/__garelier/<pm_id>/_pm           ; claude
   Terminal 2:  cd <root>/__garelier/<pm_id>/_dock    ; claude
   Terminal 3:  cd <root>/__garelier/<pm_id>/_workers/<id> ; claude   (per worker)
   Terminal 4:  cd <root>/__garelier/<pm_id>/_scouts/<id>  ; claude   (per scout)
   Terminal 5:  cd <root>/__garelier/<pm_id>/_smiths/<id>  ; claude   (per smith)
   ```
3. In each **non-PM** terminal, run `/loop` with a poll interval and
   the role's iteration prompt. Suggested prompts:

   - **Dock**:
     `/loop 90s Run one Dock iteration per SKILL.md §3: process inbox, scan blueprints, dispatch undispatched work to IDLE workers/scouts/smiths, run merge gate for any REPORTING workbench or Anvil branches, update manifest. Print "no action: <reason>" if nothing was actionable.`
   - **Worker**:
     `/loop 90s Read STATE.md and any assignment/review/answers files. Advance one step in your state machine per SKILL.md / state_machine.md §2. Print one line summary. Print "no action: <reason>" if nothing to do.`
   - **Scout**:
     `/loop 120s Read STATE.md and assignment/answers files. Advance one step. Write inspection drafts to control/inspections/ without committing. Print one line summary.`
   - **Smith**:
     `/loop 90s Read STATE.md and any assignment/review/answers files. Advance one step in your state machine per SKILL.md / state_machine.md §4. Print one line summary. Print "no action: <reason>" if nothing to do.`

4. PM stays a normal interactive session — the user converses with PM
   to add blueprints, approve promotes, etc. PM's blueprint commits
   show up in `control/blueprints/` and Dock's /loop tick picks
   them up within the poll interval.

**Stopping**: type `/quit` in each terminal (or just close it). No
stop file, no PID, no detach gymnastics.

**Trade-offs**:

- Pro: Zero infrastructure. Live observability of every step. Easy
  to intervene (just type in the relevant terminal). No extra tooling
  required.
- Con: Each /loop tick is a full interactive `claude` turn — it
  consumes context every cycle even when there's nothing to do. The
  driver's mtime pre-check (skipping a model call entirely when no
  relevant file changed) doesn't apply here. For idle projects with
  long poll intervals, this consumes more tokens than Mode A.
- Con: 4–5 terminals to manage. If one closes, that role stops.

Best for: short bursts of active work, debugging a state-machine
issue one step at a time, or as the default for users who haven't
installed Bun yet.

### 15.11 When the roadmap is finished

PM does **not** auto-stop autonomous mode when the roadmap completes.
When all milestones are shipped and no blueprints are in-progress,
every PM iteration finds nothing to do (inbox empty, every
milestone-listed blueprint exists and is in archive or in-flight) and
exits quickly per §4.5. The driver keeps polling, invoking PM and
Dock at each interval; they exit fast; nothing happens.

The user is expected to:

1. Notice via `runtime/manifest.md` / `history.md` that activity has
   stalled (no recent merges, all milestones shipped).
2. Decide whether to issue a promote (see §15.7 option 4 or 3) or
   add more work (§15.7 option 1).
3. When truly done, touch
   `__garelier/<pm_id>/runtime/driver/stop` to halt the driver.

This is intentional. PM does not unilaterally declare a project
"finished" — that judgment belongs to the user. Idle polling cost
is low (per-iteration invocations exit in seconds when there's
nothing to do).

### 15.12 Mode D: gated Dock auto-loop (DEC-059) — the default and only live autonomous mode

The default and only live autonomous mode (dispatch). It runs on the
DEC-057/058 **dispatch** substrate (in-session subagents + Codex subprocess), not
the `claude -p` driver. Model and effort are the user's choice (opus/xhigh are
first-class; there is no framework tiering or downgrade). The headless driver
(Mode B) is **disabled** (DEC-061, refuses to launch) and retained only as
historical/reference. Provider terms and billing are the operator's responsibility;
Garelier makes no billing claim.

> **Canonical modes = B and D (DEC-059, refined 2026-06-08).** Garelier ALWAYS
> runs an **interactive PM** — there is no using it without PM dialogue. The only
> distinction that matters is how the *rest* of the pipeline runs:
> **Mode B** = interactive PM + headless **driver**; **Mode D** = interactive PM +
> **dispatch**. Mode A's headless-*supervised* PM is not a Garelier usage mode (PM
> stays interactive); Mode A's good part — *proceed on the PM's own judgment when
> safe* — is kept as an **autonomy setting within B/D** (`auto_approve_*` soft-gate
> collapse + the four hard human gates), not as a headless PM. Mode C folds into D.

Shape (hybrid):
- **One interactive PM session** (the human's only conversational surface): owns
  `control/`, ARMS/DISARMS the loop, answers gates, sole promote-approver.
- **A self-pacing Dock auto-loop**: each tick = one dock-lane iteration from
  `garelier-core/references/role_subagent_dispatch.md` §4
  (OBSERVE→DISPATCH→INTEGRATE→RECORD), driven by the built-in self-paced `/loop`
  (no fixed interval; ~0 idle tokens). Producers are Claude subagents
  (Agent/Workflow) or a synchronous Codex `dispatch_codex_producer.sh` (DEC-058).
- **Gate detector**: before dispatch and on return, classify the pending action
  against `change_isolation_policy` (protected/engine-core globs),
  `decision_authority` (scope/promote), `escalation_policy` (when to stop) and
  HALT-to-human at four gates — **engine-core/protected-path, scope expansion,
  promote, ambiguous-blocker** — parking ONLY that thread (ESC-*.md + pm/inbox +
  dispatch_hold.md + BLOCKED/questions.md) while others keep flowing; never
  auto-decide. Parked gates light pmAction + ⏸ DISPATCH HOLD on the Status Web and
  surface as a PM dialog question.
- **Long quality gates are Dock/orchestrator-run, not producer-run** (producers
  reliably abandon ~30-min cargo builds): the producer edits + does a quick local
  sanity; the authoritative gate runs as an orchestrator-controlled
  run-to-completion background task (`merge_gate.ts` / Dock-launched) that notifies
  on finish. The user interacts only via PM dialog + the read-only Status Web.

Run it (today, manually): the PM arms a `/loop` with the OBSERVE→DISPATCH→
INTEGRATE tick (the substrate is validated 2026-06-08); the per-tick fan-out cap
replaces the retired DEC-027 lease counter; `require_for_all_merges` stays on.
Stop: disarm the loop. Limits: there is no capacity governor — the loop simply
stops when the provider's usage limit is reached (Codex is the opt-in alternate
provider); the loop is tied to one live session (file-state recovers on relaunch);
gate globs need per-target tuning.

Supersedes for the *default autonomous path*: the per-iteration `claude -p` driver
as the default. The driver path (Mode B) is **disabled** (DEC-061, refuses to
launch) and retained only as historical/reference; the old Mode A
*headless-supervised PM* is deprecated (its auto-proceed value lives on as the
`auto_approve_*` settings within B/D, §15.5), and old Mode C folds into Mode D.
Also supersedes the DEC-052 watching bays (already retired by DEC-057).

## See also

- `../../garelier-core/SKILL.md`
- `../../garelier-core/protocol.md`
- `../../garelier-core/state_machine.md`
- `../../garelier-dock/SKILL.md`
- Restructure DEC: DEC-001 (restructure to Garelier and remove trunk tier).
- Autonomous mode DEC: DEC-002 (autonomous mode via per-iteration `claude -p` driver).
- Rename DEC: DEC-003 (rename to studio / workbench / target / control / runtime).
