# Provider substrate and completion matrix (W-146)

Verified 2026-07-19. Every substrate writes the same durable long-job ledger and
uses exact job-id/attempt ACK/drain semantics. Provider completion is transport;
the ledger is authority.

| Substrate | Continuity / resume | Completion path |
| --- | --- | --- |
| Claude custom Agent | completed/stopped agent resumes by explicit `SendMessage` agent ID with its transcript | broker pending result, then explicit message when supported |
| Claude Agent Teams teammate | separate adapter; no session-resume restoration, no nested background subagent; restart is fresh respawn | broker/startup scan; never pretend team respawn restores the old teammate |
| Claude background session / Agent View | `--bg`; supervisor-backed session, `logs`/`respawn` only when help probe exposes them | Agent View notification or broker; ledger scan survives notification loss |
| `claude -p` | exact recorded `--resume <id>` only | provider-session record plus broker/ACK |
| Codex Desktop subagent | model/effort override requires `fork_turns="none"` or a positive limited fork; `all` with override is rejected | Codex task return plus broker/ACK |
| `codex exec` | exact recorded thread resume; routing model/effort are replayed and mismatch fails closed | result file before FINISHED, then broker/ACK |

The capability probe executes the resolved absolute Claude binary with
`--help` and `agents --help`; it never enables a feature from a version number.
On this host the 2026-07-19 probe found `--bg`, `agents`, `agents --json`, `logs`, and `respawn`;
`--exec`, Monitor event push, and `asyncRewake` were not exposed by those harmless
CLI probes, so the durable broker/startup scan is the fallback. No plugin/channel
is installed. `asyncRewake` may be auxiliary only when a runtime hook capability
probe says it is supported; it never replaces the ledger and Garelier never
writes user settings to enable it.

Official sources checked 2026-07-19:

- Claude Code CLI `--bg`: <https://code.claude.com/docs/en/cli-usage>
- Agent View, background supervisor, logs/respawn: <https://code.claude.com/docs/en/agent-view>
- Background Bash task id/output, 5 GB limit, session-exit cleanup: <https://code.claude.com/docs/en/interactive-mode>
- Background Bash/Monitor tasks not restored on resume: <https://code.claude.com/docs/en/scheduled-tasks>
- custom/background subagents: <https://code.claude.com/docs/en/sub-agents>
- timeout defaults: <https://code.claude.com/docs/en/env-vars>
- async hook and `asyncRewake` contract: <https://code.claude.com/docs/en/hooks>
- Codex non-interactive exact-session resume: <https://learn.chatgpt.com/docs/non-interactive-mode.md#resume-a-non-interactive-session>
