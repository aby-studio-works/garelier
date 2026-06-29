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

1. List all `__garelier/<pm_id>/_workers/<id>/STATE.md`,
   `__garelier/<pm_id>/_scouts/<id>/STATE.md`, and
   `__garelier/<pm_id>/_smiths/<id>/STATE.md`.
2. For each, read the file (it's a small Markdown file maintained by
   the agent). Extract:
   - Status (IDLE / WORKING / BLOCKED / REPORTING / etc — see
     `../../../garelier-core/state_machine.md`)
   - Current task line
   - Last activity timestamp
   - For Scouts in `REPORTING`, the inspection destination and whether
     `git log -1 -- <destination>` shows a committed accepted copy.
3. Read `__garelier/<pm_id>/_dock/STATE.md` if present, for
   Dock's own status.
4. Check dispatch state:
   - LIVE producers: any `__garelier/<pm_id>/_dispatch<N>/STATE.md`.
   - merge gate: `runtime/merge_gate/locks/active.lock` (running) and
     pending request count.
   - or simply run `garelier status --pm-id <pm_id> --project <control-root>`.
5. Show a compact table with a top-line summary
   `DISPATCHING / GATE RUNNING / IDLE`:

   ```
   Status: DISPATCHING (1 live producer; gate idle)

   Agent                                          State      Task                                            Last activity
   __garelier/<pm_id>/_workers/worker-01         WORKING    garelier/main/<pm_id>/workbench/#042/settings  2026-05-24 13:50Z (40m ago)
   __garelier/<pm_id>/_workers/worker-02         IDLE       (none)                                          2026-05-23 22:14Z (16h ago)
   __garelier/<pm_id>/_scouts/scout-01           REPORTING  GPU crate survey                                2026-05-24 14:15Z (15m ago)
   __garelier/<pm_id>/_smiths/smith-01           IDLE       (none)                                          2026-05-24 14:20Z (10m ago)
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
checklist without asking. Mirror-only: `backlog.md` stays canonical, the Task list
is a read-only-ish session view (backlog wins on disagreement). Skip for a
single-item session.

The standard **display format** (subject `<id>: <title> [<class>]` + fixed
description fields) and the **refresh-timing design** (the mirror is re-derived
from the canonical backlog + in-flight `_dispatch<N>` at defined anchors — every
loop-iteration boundary, **every user status query**, every merge, and on session
resume / after compaction — so a forgotten update self-corrects) live in the
system knowledge `system/backlog_task_mirror.md`. Build and refresh per that doc.
