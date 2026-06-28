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
   - or simply run `skills/garelier-core/scripts/status.{sh,ps1}`.
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
one snapshot), launch the project's `status.{sh,ps1}` helper in a
new terminal window with a 30-second refresh interval.

**Windows (default for this project):**
```powershell
Start-Process pwsh -ArgumentList @(
  '-NoExit',
  '-NoProfile',
  '-Command',
  "garelier status -ProjectRoot '<control-root>' -PmId '<pm_id>' -Watch 30"
)
```

**Unix:**
```bash
gnome-terminal -- bash -c "garelier status --project '<control-root>' --pm-id '<pm_id>' --watch 30; exec bash"
# or `xterm -e ...`, or open a new tmux pane, depending on the user's environment
```

Run the appropriate one via Bash with `Start-Process` (Windows) or
the user's terminal launcher (Unix). After running, tell the user:
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
# Windows (PowerShell)
garelier status -Watch 30

# Unix (bash)
garelier status --watch 30
```

Add explanatory notes:
- "`garelier` is the bundled dispatcher; it works in the agent's shell
  (the plugin adds `bin/` to PATH). To run it in your OWN terminal, add
  the plugin/checkout `bin/` to your PATH first, or call the script by its
  full path."
- "Auto-detects the PM if exactly one `__garelier/<pm_id>/`
  exists. Otherwise pass `-PmId <id>` / `--pm-id <id>`."
- "Walks up parent directories to find the control root that owns
  `__garelier/`, so it works from any control subdir."
- "Top-line summary shows `RUNNING / STOPPED / SHUTTING_DOWN /
  STOPPED_DIRTY`."
- "Ctrl-C exits the watch."

If the user wants a one-shot (no auto-refresh), tell them to drop
`-Watch 30` / `--watch 30`.
