# Garelier State Machine (v2.5.0)

This file defines the state transitions for Worker, Smith, Scout,
Librarian, Artisan, Observer, Guardian, and Concierge roles, and the
escalation flow used by all roles.

All paths below are relative to the project root. The `<target-slug>`
token in branch names is the configured target branch with `/` replaced
by `-` (see `protocol.md` §9).

**DEC-036 — container paths.** Where a transition names a role file under
`__garelier/<pm_id>/_<role>/<id>/` (`assignment.md`, `STATE.md`, `review.md`,
`abort.md`, …), that path is in-project by default and is the real path. A role
addresses its OWN files relatively (`../assignment.md`; its cwd is the
`checkout/` worktree). When **exile** is opted in, the `_<role>/<id>/` segment is
a machine-local home outside the project, so Dock/PM addressing ANOTHER
role's container (e.g. PM recovery reading every Worker `STATE.md`, or writing
`abort.md`) must resolve it via `__garelier/<pm_id>/runtime/workspace_paths`
(`<role-singular>.<id>=<absolute container>`); with no pointer (the default) the
in-project path is used directly. See `protocol.md` §1 and §2.

## 1. Worker states

| State        | When you are here                                       |
| ------------ | ------------------------------------------------------- |
| `IDLE`       | No `assignment.md` present. Wait for Dock to write one. |
| `ASSIGNED`   | `assignment.md` exists. You have not yet begun work.    |
| `WORKING`    | Implementation in progress on the workbench branch.     |
| `REPORTING`  | `report.md` written. Notification sent to Dock. Wait for review. |
| `REVIEWING`  | Dock has acknowledged your report and is reviewing. Do not modify your branch. |
| `MERGED`     | Dock merged your workbench branch. You return to `IDLE` after archiving. |
| `REWORK`     | Dock rejected; reasons in `review.md`. Resume implementation. |
| `BLOCKED`    | You cannot proceed without external input. Question sent. Halt all work. |
| `ABORTED`    | Dock (or PM) cancelled your task. Reset your worktree and return to `IDLE`. |

## 2. Worker transitions

### IDLE → ASSIGNED

Trigger: `__garelier/<pm_id>/_workers/<id>/assignment.md` appears.

Required action: Update `STATE.md` status to `ASSIGNED`. Read the
assignment fully. Verify that referenced blueprint files exist. Do not
yet begin implementation.

### ASSIGNED → WORKING

Trigger: You have read the assignment and are starting work.

Required action: Create the workbench branch
`garelier/<target-slug>/<pm_id>/workbench/#<ID>/<slug>` from
`garelier/<target-slug>/<pm_id>/studio`. Update `STATE.md` to `WORKING`. Begin
implementation.

### WORKING (in-state): forward-integration / catch-up merge (DEC-039)

While WORKING, your base is **not frozen**. When Dock drops a
`track-target.md` (it does this systematically once your branch drifts behind
`studio`), merge `studio` in at your next iteration boundary
(`git merge --no-edit <studio>`), resolve any conflicts yourself, remove the
trigger, and continue — **no state change** (you stay WORKING). Re-read files you
depend on afterward; `studio` may have changed them. If the merge is genuinely
unresolvable, go WORKING → BLOCKED. (See garelier-worker §6.5,
garelier-dock/references/review-and-merge.md §8.5/§8.6.)

### WORKING → REPORTING

Trigger: All acceptance criteria in `assignment.md` are met. Tests pass.

Required action: Run the project's quality gate (`cargo check`, `cargo
test`, project-specific `check_assets`, etc., as listed in the
assignment). If any fails, fix it before continuing — do not report a
failing build. Once green: write `report.md` from
`templates/report.md`. Do not push the branch. Send a notification to
`__garelier/<pm_id>/runtime/dock/inbox/`. Update `STATE.md` to `REPORTING`.

### REPORTING → REVIEWING

Trigger: Dock acknowledges your notification (writes a marker file
to `__garelier/<pm_id>/_workers/<id>/` named `under_review.md`).

Required action: Update `STATE.md` to `REVIEWING`. Stop modifying the
branch. Wait.

### REVIEWING → MERGED

Trigger: Dock merges and writes `__garelier/<pm_id>/_workers/<id>/merged.md`.

Required action: Update `STATE.md` to `MERGED` briefly. Archive
`assignment.md`, `report.md`, `under_review.md`, and `merged.md` to
`__garelier/<pm_id>/_workers/<id>/archive/<ID>/`. Return the worktree to
a clean detached HEAD on the latest integration tip:

```bash
git fetch origin
git checkout --detach origin/garelier/<target-slug>/<pm_id>/studio
git branch -D garelier/<target-slug>/<pm_id>/workbench/#<ID>/<slug>
```

Do **not** run `git checkout garelier/<target-slug>/<pm_id>/studio` (without
`--detach`) — primary worktree owns that branch and the checkout
will fail. Detached HEAD pointing at the same commit is the correct
end state.

Transition `STATE.md` to `IDLE`. Wait for the next assignment.

### REVIEWING → REWORK

Trigger: Dock rejects and writes
`__garelier/<pm_id>/_workers/<id>/review.md` with findings.

Required action: Read `review.md`. Update `STATE.md` to `REWORK`. Address
each finding on the same workbench branch. Do not create a new branch.
When done, transition back to `WORKING` → `REPORTING` as before.

### WORKING → BLOCKED

Trigger: You encounter a question whose answer is outside `assignment.md`
and cannot be resolved by web search within your task scope.

Required action: Write `__garelier/<pm_id>/_workers/<id>/questions.md` from
`templates/questions.md`. Send a notification to
`__garelier/<pm_id>/runtime/dock/inbox/` describing the block. Update
`STATE.md` to `BLOCKED`. Halt. Do not guess.

### BLOCKED → WORKING

Trigger: Dock writes an answer to
`__garelier/<pm_id>/_workers/<id>/answers.md`.

Required action: Read the answers. Update `assignment.md` if Dock
amended the task. Update `STATE.md` to `WORKING`. Resume.

### Any state → ABORTED

Trigger: `__garelier/<pm_id>/_workers/<id>/abort.md` exists. Either PM or
Dock may write it (PM for user-requested aborts via
garelier-pm/references/history-and-operations.md §13.2; Dock for
execution-driven aborts). The Worker does not
care who wrote it — the file's existence is the trigger. The file's
`Issued by:` field records the writer for audit.

Required action — **do not commit pending work**:

1. Read `abort.md` for the reason.
2. Save the current uncommitted state as patches **without
   committing**:
   - `git status --short > status.txt`
   - If `git diff` is non-empty: `git diff > wip.patch`
   - If there are untracked files: list them in `untracked.txt`
3. Update `STATE.md` to `ABORTED`.
4. Return the worktree to a clean detached HEAD on the latest
   integration tip:
   ```bash
   git fetch origin
   git reset --hard HEAD                 # discard staged/unstaged changes
   git clean -fd                          # remove untracked working-tree files
   git checkout --detach origin/garelier/<target-slug>/<pm_id>/studio
   git branch -D garelier/<target-slug>/<pm_id>/workbench/#<ID>/<slug> 2>/dev/null || true
   ```
   The workbench branch deletion is `-D` because abort discards
   commits on it. If you need to keep the local commits for audit,
   create a tag first.
5. Move `assignment.md`, partial `report.md` (if it exists),
   `abort.md`, and the saved `status.txt` / `wip.patch` /
   `untracked.txt` into
   `__garelier/<pm_id>/_workers/<id>/archive/<ID>-aborted/`.
6. Update `STATE.md` to `IDLE`.

The patch and status files preserve audit trail for what was
abandoned without committing potentially broken state to a branch.

## 3. Smith states

Smith uses the Worker state set, but works on an Anvil branch after
Dock has already merged Worker output into studio.

| State        | When you are here                                       |
| ------------ | ------------------------------------------------------- |
| `IDLE`       | No `assignment.md` present. Wait for Dock to write one. |
| `ASSIGNED`   | `assignment.md` exists. You have not yet begun work.    |
| `WORKING`    | Integration hardening in progress on the Anvil branch.  |
| `REPORTING`  | `report.md` written. Notification sent to Dock. Wait for review. |
| `REVIEWING`  | Dock has acknowledged your report and is reviewing. Do not modify your branch. |
| `MERGED`     | Dock merged your Anvil branch. You return to `IDLE` after archiving. |
| `REWORK`     | Dock rejected; reasons in `review.md`. Resume on the same Anvil branch. |
| `BLOCKED`    | You cannot proceed without external input. Question sent. Halt all work. |
| `ABORTED`    | Dock (or PM) cancelled your task. Reset your worktree and return to `IDLE`. |

## 4. Smith transitions

### IDLE -> ASSIGNED

Trigger: `__garelier/<pm_id>/_smiths/<id>/assignment.md` appears.

Required action: Update `STATE.md` status to `ASSIGNED`. Read the
assignment fully. Verify referenced Worker reports, merge notes,
project specs, policy files, and backlog pointers exist. Do not yet
begin implementation.

### ASSIGNED -> WORKING

Trigger: You have read the assignment and are starting work.

Required action: Create the Anvil branch
`garelier/<target-slug>/<pm_id>/anvil/#<ID>/<slug>` from
`garelier/<target-slug>/<pm_id>/studio`. Update `STATE.md` to
`WORKING`. Begin integration hardening.

### WORKING -> REPORTING

Trigger: Assigned integration/system checks pass, required fixes are
committed, and acceptance criteria are met.

Required action: Run the assigned integration/system checks and the
project quality gate. Write `report.md` from `templates/report.md`.
Do not push the branch. Send a notification to
`__garelier/<pm_id>/runtime/dock/inbox/`. Update `STATE.md` to
`REPORTING`.

### REPORTING -> REVIEWING

Trigger: Dock acknowledges your notification by writing
`__garelier/<pm_id>/_smiths/<id>/under_review.md`.

Required action: Update `STATE.md` to `REVIEWING`. Stop modifying the
Anvil branch. Wait.

### REVIEWING -> MERGED

Trigger: Dock merges and writes
`__garelier/<pm_id>/_smiths/<id>/merged.md`.

Required action: Update `STATE.md` to `MERGED` briefly. Archive
`assignment.md`, `report.md`, `under_review.md`, and `merged.md` to
`__garelier/<pm_id>/_smiths/<id>/archive/<ID>/`. Return the worktree to
a clean detached HEAD on the latest integration tip and transition to
`IDLE`.

### REVIEWING -> REWORK

Trigger: Dock rejects and writes
`__garelier/<pm_id>/_smiths/<id>/review.md` with findings.

Required action: Read `review.md`. Update `STATE.md` to `REWORK`.
Address each finding on the same Anvil branch. Do not create a new
branch. When done, transition back to `WORKING` -> `REPORTING`.

### WORKING -> BLOCKED

Trigger: You encounter a question outside the assignment: undecided
license policy, ambiguous target-project spec, missing environment, or
a fix that would become new feature scope instead of integration repair.

Required action: Write `__garelier/<pm_id>/_smiths/<id>/questions.md`
from `templates/questions.md`. Send a notification to
`__garelier/<pm_id>/runtime/dock/inbox/`. Update `STATE.md` to
`BLOCKED`. Halt.

### BLOCKED -> WORKING

Trigger: Dock writes
`__garelier/<pm_id>/_smiths/<id>/answers.md`.

Required action: Read the answer. Update `assignment.md` if Dock
amended the task. Update `STATE.md` to `WORKING`. Resume.

### Any state -> ABORTED

Same protocol as Worker, using `_smiths/<id>/` paths and the Anvil
branch name.

## 5. Scout states

| State        | When you are here                                       |
| ------------ | ------------------------------------------------------- |
| `IDLE`       | No `assignment.md`. Wait.                               |
| `ASSIGNED`   | `assignment.md` present. Have not yet read sources.     |
| `WORKING`    | Reading sources, drafting inspection.                   |
| `REPORTING`  | Inspection draft written in the Scout worktree. Notification sent; waiting for Dock review and PM commit/verification. |
| `BLOCKED`    | Scope ambiguous or sources unavailable. Question sent.  |
| `ABORTED`    | Dock (or PM) cancelled the investigation.          |

Scout has no `REVIEWING` / `MERGED` / `REWORK` states. If an
inspection needs revision, Dock issues a new assignment that
supersedes the previous inspection.

## 6. Scout transitions

### IDLE → ASSIGNED

Same as Worker.

### ASSIGNED → WORKING

Required action: Update `STATE.md`. **If `checkout = true` (default): cut your
throwaway `spyglass` branch from the studio tip and stay on it — a stable
snapshot for the whole investigation that won't move as studio advances (DEC
0021). If `checkout = false`: capture the studio tip SHA and read via
`git show <sha>:<path>` / `git grep <sha>` instead of a worktree.** Identify
required sources. If a source is unreachable, escalate immediately to
`BLOCKED`. Otherwise, begin investigation.

### WORKING → REPORTING

Required action: Write the inspection to
`__garelier/<pm_id>/control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md`
using `templates/inspection.md`. Send notification to
`__garelier/<pm_id>/runtime/dock/inbox/`. Update `STATE.md` to
`REPORTING`. Do not stage or commit it. Then transition to `IDLE` only
after Dock acknowledges that PM committed or verified the accepted
inspection — **and delete your `spyglass` branch on the return to `IDLE`
(it is throwaway; you never committed to it).**

Scouts do not enter `REVIEWING` or `REWORK`. The inspection draft is
immutable once reported; if it needs supplementation, Dock issues a
new assignment. The persistent inspection becomes authoritative only
after PM commits or verifies the accepted copy.

### WORKING → BLOCKED, BLOCKED → WORKING, * → ABORTED

Same protocol as Worker.

## 6.5 Librarian states and transitions (DEC-018)

Librarian uses the **Worker state set and transitions exactly** (IDLE →
ASSIGNED → WORKING → REPORTING → REVIEWING → MERGED → IDLE, plus REWORK,
BLOCKED, ABORTED), but works on a `shelf` branch
(`garelier/<target-slug>/<pm_id>/shelf/#<id>/<slug>`) created from studio,
using `_librarians/<id>/` paths. Dock reviews it with the Librarian
Review (`garelier-dock/references/review-and-merge.md` §7.4) and
merges it through the merge gate like Worker work. Substitute "shelf" for
"workbench" in the Worker transitions (§2).

## 6.6 Artisan states and transitions (DEC-017)

The Artisan is the artisan lane: it is its own reviewer and integrator, so
its state set is shorter than Worker's.

| State | Meaning |
| ----- | ------- |
| `IDLE` | No task; waiting for PM to write `assignment.md` + the artisan `lane.lock`. |
| `ASSIGNED` | Picked up the assignment; about to create the `satchel` branch. |
| `WORKING` | Doing the whole task: implement, harden, knowledge work, self-review, quality gate, Guardian, Observer, and integration into `studio` all happen here. Checkpoints written per phase. |
| `REPORTING` | Merged into studio; `report.md` written for PM; `lane.lock` released. |
| `BLOCKED` | Waiting on `answers.md` for a judgment/authority/safety question (never for time/size). |
| `ABORTED` | `abort.md` appeared. |

Transitions: `IDLE → ASSIGNED → WORKING → REPORTING → IDLE`, with
`WORKING ⇄ BLOCKED` and `* → ABORTED`. There is **no** `REVIEWING`,
`REWORK`, or `MERGED` — review and merge are internal to `WORKING`. The
Artisan holds `__garelier/<pm_id>/runtime/lane.lock` (lane = `artisan`)
for the whole task and removes it at `REPORTING`, which is what lets the
dock lane resume. Uses `_artisan/` paths.

## 6.7 Observer states and transitions (DEC-019)

The Observer is a commit-free, read-only review/advice sidecar. It runs
in **both** lanes, never takes `lane.lock`, and merges nothing, so it has
no `REVIEWING`, `REWORK`, or `MERGED` states — a report is a point-in-time
observation, and if it is insufficient the requester issues a **new**
request (new `request_id`) rather than sending the Observer back to revise
(mirrors Scout's immutable-inspection rule). Uses `_observers/<id>/` paths.
With `checkout = true` (default) it cuts a throwaway `monocle` branch from the
review-target tip at `ASSIGNED → OBSERVING` (a stable snapshot) and deletes it
at the return to `IDLE` (DEC-021; never committed); with `checkout = false`
it has no worktree and reads the target via `git show`/`git grep`.

| State | When you are here |
| ----- | ----------------- |
| `IDLE` | No `assignment.md`. Wait for a request. |
| `ASSIGNED` | `assignment.md` exists; not yet begun reading. |
| `OBSERVING` | Reading diff/report/sources, running the required checks, drafting the report/advice. |
| `REPORTING` | `report.md` (or `advice.md`) written; notification sent. Waiting for the requester to acknowledge. |
| `ACKED` | Requester wrote `acked.md`; about to archive under `archive/<request_id>/` and return to `IDLE`. |
| `BLOCKED` | Cannot judge without input (missing diff/report, unknown target branch, a policy decision only PM can make). Question sent; halt. |
| `ABORTED` | PM / Dock / Artisan cancelled the request (`abort.md`). Reset and return to `IDLE`. |

Transitions: `IDLE → ASSIGNED → OBSERVING → REPORTING → ACKED → IDLE`,
with `OBSERVING ⇄ BLOCKED` (resume after `answers.md`) and `* → ABORTED`.
A `BLOCK` verdict always escalates to PM and is never waivable; the
mandatory-gate policy lives in `[observer_policy]`.

## 6.8 Guardian states and transitions (DEC-024)

The Guardian is the commit-free security / privacy / dependency / license
**gate**. Like Observer it merges nothing and has no `REWORK` / `MERGED` — a
report is a point-in-time verdict; an insufficient one is replaced by a **new**
Guardian request. It runs on an ephemeral `gavel` branch cut from the
review-target tip at pickup (capturing `review_sha`) and deleted at IDLE. Uses
`_guardians/<id>/` paths.

| State | When you are here |
| ----- | ----------------- |
| `IDLE` | No `assignment.md`. Wait for a gate request. |
| `ASSIGNED` | `assignment.md` exists; about to cut the gavel branch + capture `review_sha`. |
| `CHECKING` | Running scanners + applying Librarian-owned policy to the diff/tree. |
| `REPORTING` | `guardian_report.md` written (verdict); waiting for ack. |
| `ACKED` | `acked.md` written; archive + delete the gavel branch + return to IDLE. |
| `BLOCKED` | Missing policy source / mandatory scanner, or a policy decision only PM can make. |
| `ABORTED` | Request cancelled (`abort.md`). |

Transitions: `IDLE → ASSIGNED → CHECKING → REPORTING → ACKED → IDLE`, with
`CHECKING ⇄ BLOCKED` (resume after `answers.md`) and `* → ABORTED`. A `BLOCK`
on secret / private key / customer-data always escalates to PM and is never
waivable; the mandatory-gate policy lives in `[guardian_policy]`. A verdict is
bound to `base_ref` / `head_ref` / `review_sha` — a stale verdict (older sha)
must not be reused.

## 6.9 Concierge states and transitions (DEC-025)

The Concierge is PM's external-operations executor / delegate of last resort. It
is **PM-dispatched only**, commit-bearing for the operation it runs (e.g. a
promote merge + tag) but **never implements source**. It has no `REVIEWING` /
`REWORK` / `MERGED` — PM **acks** its report. It works in its own worktree on a
local-only `clipboard` branch; uses `_concierges/<id>/` paths.

| State | When you are here |
| ----- | ----------------- |
| `IDLE` | No `assignment.md`. Wait for a PM external-operation request. |
| `ASSIGNED` | `assignment.md` exists; about to read policy/runbook and fix refs. |
| `WORKING` | Carrying out the operation. Track the fine phase in `Current task`: `preparing` (read Librarian policy/runbook, fix refs) → `checking_gates` (confirm Guardian/Observer/CI/quality preconditions, non-stale) → `executing` (acquire the target-scoped lock, run the operation) → `verifying` (confirm the remote/target result). |
| `REPORTING` | `concierge_report.md` written; PM notified; lock released. Waiting for ack. |
| `ACKED` | `acked.md` written; archive + return to IDLE. |
| `BLOCKED` | Missing approval/policy/gate, target drift, lock unavailable, or work that needs source changes (hand back to PM). |
| `ABORTED` | Request cancelled (`abort.md`). |

Transitions: `IDLE → ASSIGNED → WORKING → REPORTING → ACKED → IDLE`, with
`WORKING ⇄ BLOCKED` (resume after `answers.md`) and `* → ABORTED`. The phase-fine
states ride inside `WORKING` (no extra `STATE.md status` values). External writes
require a passing, non-stale Guardian verdict and an explicit user instruction
behind the PM assignment; `garelier/*` is never pushed, no force-push, no blind
`git pull` (`[concierge_policy]`). With no Concierge configured, promote is
blocked until one is configured.

## 7. Escalation flow

Garelier uses two-level escalation:

```
Worker / Scout / Smith (BLOCKED)
        │
        ▼
Dock reads `__garelier/<pm_id>/runtime/dock/inbox/`
        │
        ├─ Resolvable by Dock ────► Write answer to
        │                                 `__garelier/<pm_id>/_workers/<id>/answers.md`
        │                                 (or scout/smith equivalent)
        │
        └─ Blueprint ambiguity / user judgment needed ───►
                Write to `__garelier/<pm_id>/runtime/dock/escalation/`
                Notify PM via `__garelier/<pm_id>/runtime/pm/inbox/`
                        │
                        ▼
                PM reads, may consult user
                        │
                        ▼
                PM writes resolution to
                `__garelier/<pm_id>/runtime/pm/resolutions/<ID>.md`
                Notifies Dock
                        │
                        ▼
                Dock forwards to the BLOCKED Worker/Scout/Smith
```

PM does not communicate directly with Worker, Scout, or Smith. Dock is the
sole intermediary for those three (and for Librarian, which uses the same
Worker path via Dock).

Two roles escalate differently:
- **Artisan** (§6.6) holds `lane.lock` and has no Dock above it, so it
  escalates **directly to PM**: it writes `questions.md`, PM answers via
  `_artisan/answers.md` (PM ⇄ Artisan directly; no Dock hop).
- **Observer** (§6.7) escalates to its **requester** (Dock, Artisan, or
  Worker); a `BLOCK` verdict always goes to PM and is never waivable. The
  Observer never holds `lane.lock` and merges nothing.

Base-tracking merge conflicts (`git merge <target>` failing on
`garelier/<target-slug>/<pm_id>/studio`) are **resolved by Dock or PM
themselves**, not escalated by default (DEC-001 §2.5). Escalate only
if the resolution is genuinely ambiguous from blueprint and code
context.

## 8. State invariants

These must always hold. Violation indicates a bug.

- A Worker has at most one workbench branch checked out at any time.
- A Worker in `WORKING`/`REPORTING`/`REVIEWING`/`REWORK`/`BLOCKED` has
  exactly one `assignment.md` present.
- A Worker in `IDLE`/`ABORTED` has no `assignment.md` (or it has been
  archived).
- A Scout in any non-`IDLE` state has exactly one `assignment.md`.
- A Smith has at most one Anvil branch checked out at any time.
- A Smith in `WORKING`/`REPORTING`/`REVIEWING`/`REWORK`/`BLOCKED` has
  exactly one `assignment.md` present.
- A Smith in `IDLE`/`ABORTED` has no `assignment.md` (or it has been
  archived).
- `STATE.md` `status` field always matches the agent's actual state.
- `__garelier/<pm_id>/runtime/manifest.md` reflects the latest known state of
  every Worker, Scout, and Smith. (Dock updates this on every transition
  notification it receives.)

## 9. Recovery from inconsistent state

If you (as Dock) detect inconsistency on startup — e.g., a Worker's
`STATE.md` says `WORKING` but no workbench branch exists — perform
reconciliation:

1. Read every `__garelier/<pm_id>/_workers/<id>/STATE.md` and
   `__garelier/<pm_id>/_scouts/<id>/STATE.md`, plus every
   `__garelier/<pm_id>/_smiths/<id>/STATE.md`.
2. Compare with `__garelier/<pm_id>/runtime/manifest.md`.
3. For each mismatch, write a reconciliation entry to
   `__garelier/<pm_id>/runtime/dock/inbox-archive/reconcile-<timestamp>.md`.
4. Update `manifest.md` to the most conservative consistent state (prefer
   `IDLE` if uncertain; force the Worker to re-assign).
5. Notify the affected Worker(s) of the reconciled state.

Do not silently fix inconsistencies. Always log them.
