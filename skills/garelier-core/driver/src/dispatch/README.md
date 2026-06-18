# Garelier dispatch (DEC-057)

Dispatch is the **subagent/Workflow dispatch** model: an interactive
dispatching session (PM in the artisan lane, Dock in the dock lane)
delegates each role's assignment to a **subagent** via the Agent tool (one role)
or the Workflow tool (parallel) — request → run-to-completion → return — then
integrates the returned branches. There is no idle bay to wake, so no wake
mechanism and no deadlock.

**How to dispatch**: see
[`../../../references/role_subagent_dispatch.md`](../../../references/role_subagent_dispatch.md)
(the Dock procedure + the dock-lane loop). Roles are the existing
`garelier-<role>` skills — **no agent-definition files** are created, nothing is
written to the target repo root, and there is no global `~/.claude/agents`
pollution, so it is multi-project safe and removable with `__garelier/`.

## What lives here
| file | role |
| --- | --- |
| `dock_merge.ts` | the Dock-owned **merge-gate driver** — `poll` spawns/advances the background merge of `workbench` / `anvil` / `shelf` branches into `studio`; `status` reports gate state. The Dock runs this to integrate returned producer branches. |

## Removed (DEC-057 supersedes DEC-052)
The hook-driven watching-bay substrate was removed after the first live spike
showed its idle-bay wake unreliable (a dispatched assignment sat unread; the
external reference shares the gap "simplicity over guaranteed delivery"):
`launch_bay.ts`, `watch.ts` (Monitor stream), `check_inbox.ts` (Stop-hook wake +
re-poke), `bay_settings.ts`, `session_start.ts`, and the file `inbox.ts` /
`send.ts` JSON message store + presence/liveness guard. Coordination now uses
subagent return values + the existing runtime file protocol (STATE.md /
assignment.md / report.md / `runtime/manifest.md` / `runtime/<role>/inbox/`).

Codex roles run as a separate `codex exec` subprocess rather than an in-session
subagent. Provider terms and billing are the operator's responsibility; Garelier
makes no billing claim (see `docs/concepts.md` Billing & ToS).
