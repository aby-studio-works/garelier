# Garelier PM Status Reference

## §13. Showing what's running, and stopping it cleanly

The user does not have a live dashboard of agent activity. PM is the
inspection point. PM also provides the **only** safe way for the user
to stop work in progress: by writing a clean-stop signal that the
target agent will pick up at its next session boundary.

### 13.1 "What's running?"

Triggered by phrases like "what's running", "show me active work",
"what is everyone doing", "agent status", "ステータス", "状況",
"状態確認".

PM has two response modes, depending on what the user wants:

#### 13.1.A One-shot inspection inside this chat (default)

For a one-time check inside the current PM conversation:

1. List all `__garelier/<pm_id>/_crew/workers/<id>/STATE.md`,
   `__garelier/<pm_id>/_crew/scouts/<id>/STATE.md`, and
   `__garelier/<pm_id>/_crew/smiths/<id>/STATE.md`.
2. For each, read the file (it's a small Markdown file maintained by
   the agent). Extract:
   - Status (IDLE / WORKING / BLOCKED / REPORTING / etc — see
     `../../../garelier-core/state_machine.md`)
   - Current task line
   - Last activity timestamp
   - For Scouts in `REPORTING`, the inspection destination and whether
     `git log -1 -- <destination>` shows a committed accepted copy.
3. Read `__garelier/<pm_id>/_crew/dock/STATE.md` if present, for
   Dock's own status.
4. Check dispatch state:
   - LIVE roles: any `__garelier/<pm_id>/_crew/dispatch<N>/STATE.md`.
   - merge gate: `runtime/merge_gate/locks/active.lock` (running) and
     pending request count.
   - or simply run `garelier status --pm-id <pm_id> --project <control-root>`.
5. Show a compact table with a top-line summary
   `DISPATCHING / GATE RUNNING / IDLE`:

   ```
   Status: DISPATCHING (1 live role; gate idle)

   Agent                                          State      Task                                            Last activity
   __garelier/<pm_id>/_crew/workers/worker-01         WORKING    garelier/main/<pm_id>/workbench/#042/settings  2026-05-24 13:50Z (40m ago)
   __garelier/<pm_id>/_crew/workers/worker-02         IDLE       (none)                                          2026-05-23 22:14Z (16h ago)
   __garelier/<pm_id>/_crew/scouts/scout-01           REPORTING  GPU crate survey                                2026-05-24 14:15Z (15m ago)
   __garelier/<pm_id>/_crew/smiths/smith-01           IDLE       (none)                                          2026-05-24 14:20Z (10m ago)
   dock                                      ACTIVE     dispatching #043 phase 2                        2026-05-24 14:20Z (10m ago)
   ```
6. After the table, ask the user if they want to do anything
   (typically: nothing, or stop one of the items).

#### 13.1.B Live status in another terminal (user asks for "ステータス出して" / "別ターミナル" / "watch")

When the user wants a continuously-updating status display (not just
one snapshot), launch `garelier status` in a new terminal window with a
30-second refresh interval.

```bash
gnome-terminal -- bash -c "garelier status --project '<control-root>' --pm-id '<pm_id>' --watch 30; exec bash"
# On Windows, use Git Bash; on Unix, use the user's terminal launcher
# (`xterm -e ...`, tmux pane, etc.) depending on the environment.
```

Run the appropriate terminal launcher. After running, tell the user:
"Status window opened in a new terminal, refreshing every 30
seconds. Ctrl-C in that window stops the watch."

If launching the terminal fails (e.g., no GUI on a headless Linux
host), fall back to telling the user the exact command to run
themselves (see §13.1.C).

#### 13.1.C "How do I show the status?" (user wants to learn the command)

Triggered by phrases like "ステータスの出し方", "how do I check
status", "what's the status command", "教えて".

Reply with the canonical commands the user can paste into their
own terminal. Default to 30-second refresh, since one-shot is
rarely what someone asking "how" actually wants:

```
garelier status --watch 30
```

Add explanatory notes:
- "`garelier` is the bundled dispatcher; it works in the agent's shell
  (the plugin adds `bin/` to PATH). To run it in your OWN terminal, add
  the plugin/checkout `bin/` to your PATH first, or call the script by its
  full path."
- "Auto-detects the PM if exactly one `__garelier/<pm_id>/`
  exists. Otherwise pass `--pm-id <id>`."
- "Walks up parent directories to find the control root that owns
  `__garelier/`, so it works from any control subdir."
- "Top-line summary shows `RUNNING / STOPPED / SHUTTING_DOWN /
  STOPPED_DIRTY`."
- "Ctrl-C exits the watch."

If the user wants a one-shot (no auto-refresh), tell them to drop
`--watch 30`.

#### 13.1.E Backlog → Task-list mirror (session view, standard) — DEC-092

`garelier status` / `dock_status` are point-in-time. For a session that works a
backlog (a drain, an autonomous loop, or any multi-item dispatch), ALSO mirror the
open backlog into the harness **Task list** so the user has a live per-item
checklist without asking. Mirror-only: schema-3 Backlog is canonical and the
Task list is a read-only-ish session view (Control wins on disagreement). Skip for a
single-item session.

The standard **display format** (subject `<id>: <title> [<class>]` + fixed
description fields) and the **refresh-timing design** (the mirror is re-derived
from schema-selected canonical Work + in-flight `_crew/dispatch<N>` at defined anchors — every
loop-iteration boundary, **every user status query**, every merge, and on session
resume / after compaction — so a forgotten update self-corrects) live in the
system knowledge `system/backlog_task_mirror.md`. Build and refresh per that doc.

**Session continuation (W-027).** A session resume or post-compaction turn can
start with the harness Task list empty (the store did not survive the gap) even
though the backlog and live dispatch are unchanged. That is normal, self-healing
input for the mirror, not evidence of a bug — do **not** hand-diagnose it as
"display desync" and do **not** hand-reconstruct the list from memory. Run
`task_mirror --format ops` with whatever current list you have (empty is fine —
absent `--current` treats it as create-all) and apply the returned ops; the
mirror rebuilds every open item fresh from schema-selected canonical control + live
`_crew/dispatch<N>` state. The same command also reports `foreign` (count of
same-session Task-list entries carrying another project's own W-NNN id that the
mirror correctly left untouched) and any `op: "warn"` entries (a Task shows
completed while its `_crew/dispatch<N>` is still actually running — surface the
warning to the user, do not silently resolve it either way).

#### 13.1.F Subagent went idle — check the completion contract (W-022)

In attended mode you drive role/gate subagents by hand (no headless driver).
A run-to-completion subagent sometimes ends its turn **before** satisfying its
artifact contract: implemented but never committed, `report.md` left as the
dispatch scaffold, `STATE.md` still `WORKING`, or a gate role that reviewed but
never wrote its verdict file. When you are notified (or notice) that a subagent
has gone idle, do **not** eyeball it — run the detector first, and if it reports a
violation, send its `nudge` text back to that subagent verbatim:

```bash
# role (a _crew/dispatch<N> home): checks [lane] state = REPORTING|BLOCKED, a commit past
# base_sha, and report.md is no longer the scaffold template.
bun 'skills/garelier-core/driver/src/dispatch/contract_check.ts' \
  --pm-id <pm_id> --project <control-root> --dispatch <N>

# gate (Guardian/Observer): checks runtime/<role>/results/<slug>-<role>.md exists
# whose front matter carries a canonical [verdict] result token.
bun 'skills/garelier-core/driver/src/dispatch/contract_check.ts' \
  --pm-id <pm_id> --project <control-root> --gate <slug> --roles guardian,observer
```

Exit 0 = contract satisfied (the subagent really is done — proceed to gate/merge).
Exit 3 = one or more artifacts missing; the JSON `nudge` field is a ready-to-paste
Japanese SendMessage body listing exactly what to finish. Add `--format text` for a
human-readable view. This closes the idle-without-artifact class detectively so you
stop discovering it by hand.

**Respawn discipline (attended version of DEC-089).** Before respawning a worker
after an idle notification: (a) run `contract_check` first to see whether it
already produced its artifacts, and (b) ping the original subagent once and wait
for a reply or a new commit before spawning a replacement — a respawn issued while
the first subagent's message is merely delayed in transit creates a duplicate
in-flight dispatch on the same slug.
