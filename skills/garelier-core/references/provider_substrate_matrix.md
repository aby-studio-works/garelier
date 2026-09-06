# Provider substrate and completion matrix (W-146)

Verified 2026-07-19. Every substrate writes the same durable long-job ledger and
uses exact job-id/attempt ACK/drain semantics. Provider completion is transport;
the ledger is authority.

## Hot path: per-task provider dispatch

Select the provider explicitly for the task with
`dispatch_prepare --provider codex|claude-code`; add `--model` / `--effort` when the
task requires them. Fixed role metadata never supplies or conflicts with these
values. Routine dispatch uses the emitted `provider_parent_routes` object
directly, without loading the long dispatch manual.

| Parent surface | Claude task | Codex task |
| --- | --- | --- |
| Claude Code | emitted Agent/Workflow directive | emitted recorded CLI `launch_cmd` |
| Codex CLI host | emitted recorded Claude CLI `launch_cmd` | emitted recorded Codex CLI `launch_cmd` |

Recorded CLI helpers pin the resolved model, non-empty effort, explicit session
id, and exact-session resume. They do not install anything or change timeout or
permission settings. Run a helper directly and wait only when the whole command
fits `bash_timeout_budget_ms`; otherwise arm the unchanged `launch_cmd` once in
the durable single-flight broker. Never substitute a raw provider command or an
ad-hoc background waiter.

| Substrate | Continuity / resume | Completion path |
| --- | --- | --- |
| Claude custom Agent | completed/stopped agent resumes by explicit `SendMessage` agent ID with its transcript | broker pending result, then explicit message when supported |
| Claude Agent Teams teammate | separate adapter; no session-resume restoration, no nested background subagent; restart is fresh respawn | broker/startup scan; never pretend team respawn restores the old teammate |
| Claude background session / Agent View | `--bg`; supervisor-backed session, `logs`/`respawn` only when help probe exposes them | Agent View notification or broker; ledger scan survives notification loss |
| `claude -p` | exact recorded `--resume <id>` only | provider-session record plus broker/ACK |
| `codex exec` | exact recorded thread resume; routing model/effort are replayed and mismatch fails closed | result file before FINISHED, then broker/ACK |

Effort per transport (W-667 F-9): `codex exec` takes `--effort` natively; the
recorded Claude subprocess pins model plus a non-empty effort on its launch
command; the **attended Agent transport has no effort argument at all** — the
Agent tool accepts a model and nothing else — so `dispatch_prepare` writes the
resolved effort as the first line of `lane/prompt.md`, which is the only channel
an attended seat reads. The value is recorded in `context.json` either way. See
`model_routing.md` § Operational use for the table.

The capability probe executes the resolved absolute Claude binary with
`--help` and `agents --help`; it never enables a feature from a version number.
On this host the 2026-07-19 probe found `--bg`, `agents`, `agents --json`, `logs`, and `respawn`;
`--exec`, Monitor event push, and `asyncRewake` were not exposed by those harmless
CLI probes, so the durable broker/startup scan is the fallback. No plugin/channel
is installed. `asyncRewake` may be auxiliary only when a runtime hook capability
probe says it is supported; it never replaces the ledger and Garelier never
writes user settings to enable it.

Parallel dispatch has no fixed Garelier-wide agent cap: admit work
from advertised provider/substrate availability and current host CPU, memory, and
I/O pressure, weighted by the task `resource_class`. A host's current slot quota
(for example a provider account's current concurrent-job quota) is an external availability signal,
not a framework constant or a value to copy into config.

Official sources checked 2026-07-19:

- Claude Code CLI `--bg`: <https://code.claude.com/docs/en/cli-usage>
- Agent View, background supervisor, logs/respawn: <https://code.claude.com/docs/en/agent-view>
- Background Bash task id/output, 5 GB limit, session-exit cleanup: <https://code.claude.com/docs/en/interactive-mode>
- Background Bash/Monitor tasks not restored on resume: <https://code.claude.com/docs/en/scheduled-tasks>
- custom/background subagents: <https://code.claude.com/docs/en/sub-agents>
- timeout defaults: <https://code.claude.com/docs/en/env-vars>
- async hook and `asyncRewake` contract: <https://code.claude.com/docs/en/hooks>
- Codex non-interactive exact-session resume: <https://learn.chatgpt.com/docs/non-interactive-mode.md#resume-a-non-interactive-session>
