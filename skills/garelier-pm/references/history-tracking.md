# Garelier PM History Tracking Reference

## §11. History tracking

`__garelier/<pm_id>/_pm/history.md` is the **hot index** for every
blueprint PM has dispatched plus structural events (project init, agent
set changes, promotes). In high-volume projects, old completed entries
move to `_pm/history/archive/YYYY-MM.md` per
`garelier-core/retention.md`. The hot file plus archive files are the
ground truth for "what has this PM done", and the index that
re-execution (§12) uses to find a past blueprint.

### 11.1 File format

The wizard creates the file on fresh init with entry #001 (the init
itself). Every subsequent entry is appended in this shape:

```markdown
## #042 — 2026-05-24T14:33:21Z — Add settings page
- Blueprint: __garelier/<pm_id>/control/blueprints/add-settings-page.md
- Milestone: MVP completion
- Outcome: in-progress
- Notes: (free text — added context, decisions, links)
```

When the entry was created without user confirmation (autonomous mode,
§15), the Outcome is prefixed `autopilot:` and Notes includes the
autopilot reason:

```markdown
## #043 — 2026-05-24T14:35:00Z — Refactor auth
- Blueprint: __garelier/<pm_id>/control/blueprints/refactor-auth.md
- Milestone: MVP completion
- Outcome: autopilot: in-progress
- Notes: auto_approve_blueprints=true. Open questions recorded in blueprint.
```

The hot file ends with a hidden marker:

```markdown
<!-- Next entry number: 43 -->
```

Numbers are sequential, never reused, and zero-padded to a minimum of
three digits in the heading (they grow beyond three with no upper bound —
see control_contract.md "ID numbering"). The marker tracks the next number
to assign. PM keeps the marker as the last non-blank line of the file.

The full template is in `templates/history_entry.md`.

When entries have been archived, keep an `## Archived history` section
in the hot file:

```markdown
## Archived history

- `archive/2026-05.md` — #001-#120
```

Archive files never contain the `Next entry number` marker.

### 11.2 When PM appends an entry

Append a new entry whenever:

- A blueprint is committed (Outcome: `in-progress`)
- A blueprint ships, i.e. is included in a promote (Outcome: `shipped`)
- A blueprint is abandoned by the user (Outcome: `abandoned`)
- A promote is executed (§7) — Outcome: `promoted`, Notes record the
  range and tag
- The agent set is changed via diff-mode wizard (the wizard writes
  this entry itself; PM does not)
- Project init (the wizard writes #001)
- A base-tracking conflict was resolved (§7.5) — Outcome:
  `merge-resolution`, Notes record the conflicted paths and which
  side won (or the synthesis used)
- A data-changing blueprint receives explicit user approval for
  execution — Outcome: `data-change-approval`, Notes record the
  blueprint slug, the execution scope, and the user's exact words
  (per data_change_policy.md)

For a milestone change on an already-active blueprint, **update** the
existing entry's `Milestone:` line in place (don't append a new one),
and add a brief note in the `Notes:` field. Apart from retention
rotation (§11.2.A), this is the only allowable in-place edit on
`__garelier/<pm_id>/_pm/history.md`.

### 11.2.A Retention rotation

Triggered when `[retention]` exists or defaults apply and
`history.md` exceeds `history_hot_entries` completed entries.

1. Read `history_hot_entries` and `history_archive_granularity` from
   setup_config or `retention.md` defaults.
2. Keep all `in-progress` / `autopilot: in-progress` entries in the
   hot file, regardless of age.
3. Keep the newest `history_hot_entries` completed entries in the hot
   file.
4. Move older completed entries into
   `_pm/history/archive/YYYY-MM.md`, grouped by entry timestamp month.
   Preserve each entry block exactly.
5. Update `## Archived history` in the hot file with archive path and
   entry-number ranges.
6. Leave `<!-- Next entry number: N -->` as the last non-blank line of
   the hot file.
7. Commit the hot file and archive file changes:
   `maintenance: rotate PM history`.

### 11.3 When a blueprint ships or is abandoned

When the blueprint ships:

1. Find its entry in `__garelier/<pm_id>/_pm/history.md` and change
   `Outcome: in-progress` to `Outcome: shipped`. Add the promote
   date in `Notes:`.
2. Move `__garelier/<pm_id>/control/blueprints/<slug>.md` to
   `__garelier/<pm_id>/control/blueprints/archive/<slug>.md`.
3. Commit:
   ```bash
   git mv __garelier/<pm_id>/control/blueprints/<slug>.md __garelier/<pm_id>/control/blueprints/archive/<slug>.md
   git add __garelier/<pm_id>/_pm/history.md
   git commit -m "blueprint: <slug> shipped"
   ```

When the blueprint is abandoned (user decides to drop it):

1. Change `Outcome: in-progress` to `Outcome: abandoned`. Note the
   reason in `Notes:`.
2. Move the blueprint to
   `__garelier/<pm_id>/control/blueprints/archive/<slug>.md` so it remains
   discoverable for re-execution but doesn't clutter the active list.
3. Commit similarly.

### 11.4 Showing history to the user

When the user asks "what have we done", "show me history", or
"show me recent blueprints":

1. Read `__garelier/<pm_id>/_pm/history.md`.
2. Show the last N entries (default: 10) in compact form. Format:
   ```
   #042  2026-05-24  Add settings page         in-progress
   #041  2026-05-22  Refactor auth module      shipped
   #040  2026-05-20  Survey GPU compute crates shipped
   ```
3. If the user asks for full detail of a specific entry, read it
   from history.md or `_pm/history/archive/*.md` and show the full
   block, then offer to read the linked blueprint from
   `__garelier/<pm_id>/control/blueprints/` or
   `__garelier/<pm_id>/control/blueprints/archive/`.
