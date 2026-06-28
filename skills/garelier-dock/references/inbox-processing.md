# Garelier Dock Inbox Processing Reference
Roots and exiled containers: follow `garelier-dock/SKILL.md`.

## §6. Inbox processing

`__garelier/<pm_id>/runtime/dock/inbox/` contains messages from
Workers, Scouts, Smiths, and PM. In Plant-Crust, cross-container work arrives
as a container-local PM request here; Dock still reads only its active
container. Each filename is timestamped:
`<YYYYMMDD-HHMMSS>-<from>-<topic>.md`. Process in chronological order.

For each message:

1. Read the message.
2. Take the action described, or note that no action is needed (purely
   informational notifications still need acknowledgement).
3. If the message asks for a PM-visible cross-container result, write a compact
   response to `__garelier/<pm_id>/runtime/dock/outbox/`.
4. Move the file to `__garelier/<pm_id>/runtime/dock/inbox-archive/`.

Common message types:

| `from`     | `topic`                  | Action                                |
| ---------- | ------------------------ | ------------------------------------- |
| `<worker>` | `state-change`           | Update manifest; if REPORTING → §7     |
| `<worker>` | `question`               | Read `questions.md`; answer or §11    |
| `<worker>` | `blocked`                | Read STATE.md; resolve or §11         |
| `<scout>`  | `state-change`           | Update manifest; if REPORTING → §7.2  |
| `<scout>`  | `inspection-ready`       | Read inspection file; integrate via §7.2 |
| `<smith>`  | `state-change`           | Update manifest; if REPORTING → §7.3  |
| `<smith>`  | `question`               | Read `questions.md`; answer or §11    |
| `<smith>`  | `blocked`                | Read STATE.md; resolve or §11         |
| `<librarian>` | `state-change`        | Update manifest; if REPORTING → §7.4  |
| `<librarian>` | `question` / `blocked` | Read `questions.md` / STATE.md; answer or §11 |
| `<observer>` | `state-change`         | Update manifest; if REPORTING → consume verdict per §7.5 (Observer never merges) |
| `<observer>` | `question` / `blocked` | Read `questions.md` / STATE.md; answer or §11 |
| `pm`       | `resolution-ready`       | Read `__garelier/<pm_id>/runtime/pm/resolutions/`; if Scout commit-ready → §7.2 |
| `pm`       | `cross-container-request` | Treat as a normal active-container request; never read sibling containers; write completion/result to `runtime/dock/outbox/` when requested |

Do not skip messages, even ones that look like duplicates. Multiple
state-change messages from the same agent reflect real transitions.
