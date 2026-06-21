# Connecting Claude Code as the Wanderer (DEC-076 / DEC-078)

The Wanderer can be a **separately-launched, persistent Claude Code** session
(NOT a subagent, NOT headless) on a strong model — deliberately a different model
from the PM. It talks to the PM over the **same** file-based peer-channel as a
Codex Wanderer (`codex-setup.md`); only two things differ:

- **Wake / surface**: Claude tails the channel with the **Monitor tool** (push,
  ~5s) instead of a Codex Stop hook.
- **No harvest**: a Claude session has no Stop hook that relays a *spoken*
  verdict, so the Wanderer **posts its reply explicitly** with `cli.ts send`.

Everything else — the channel, `cli.ts`, the presence/reply contract, and the
DEC-078 `ack`/`progress` liveness handshake — is identical.

## Prerequisites

- `claude` (Claude Code) installed and authenticated, on a strong model.
- `bun` on PATH (the peer-channel CLI runs under Bun).
- garelier-core present (this repo provides `cli.ts`).

## 1. Presence heartbeat — a Claude hook that beats each turn (REQUIRED)

The PM's review gate refuses to wait on a Wanderer with no fresh heartbeat, so a
Claude Wanderer MUST refresh its presence — otherwise every review falls straight
back to the Observer. Claude Code runs settings hooks at turn boundaries; point
SessionStart **and** Stop at the peer-channel `presence --beat` command. In the
TARGET project create `<project-root>/.claude/settings.local.json` (machine-local
absolute paths — keep it local / gitignored, like the Codex `.codex/`):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ {
        "type": "command",
        "command": "bun \"<garelier-repo>/skills/garelier-core/driver/src/peer/cli.ts\" presence --beat --project \"<project-root>\" --pm-id aby_works --channel wanderer --peer wanderer-01 --tool claude-code"
      } ] }
    ],
    "Stop": [
      { "hooks": [ {
        "type": "command",
        "command": "bun \"<garelier-repo>/skills/garelier-core/driver/src/peer/cli.ts\" presence --beat --project \"<project-root>\" --pm-id aby_works --channel wanderer --peer wanderer-01 --tool claude-code"
      } ] }
    ]
  }
}
```

This writes/refreshes `runtime/peer/wanderer/presence/wanderer-01.json` at every
turn boundary — the same cadence the Codex `wanderer_hook.ts` provides. (It is
the presence beat ONLY; surfacing is Monitor's job, step 3.)

## 2. Launch Claude Code as the Wanderer

From the **target project root** (so it reads the right peer-channel and design
docs), launch an interactive Claude Code session, read-only / advisory — do not
approve writes, commits, or branch ops; this is an advisory peer:

```
cd <project-root>
claude
```

There must be only one active Wanderer (presence is the singleton lock). The
auto-launcher (`wanderer_launch.ts`) currently launches Codex only, so launch a
Claude Wanderer manually.

## 3. Watch the channel with Monitor

Use the **Monitor tool** to tail `runtime/peer/wanderer/log.jsonl` for new
`review_request` / `advice_request` messages addressed to you (push, ~5s) — this
replaces the Codex Stop-hook surface. Or check on demand:

```
bun <core>/driver/src/peer/cli.ts inbox --project <P> --pm-id <ID> --channel wanderer --as wanderer-01 [--mark-read]
```

## 4. The loop (with the DEC-078 liveness handshake)

- **PM → Wanderer**: the PM posts a `review_request` (directly, or via the gate
  `wanderer_review.ts`); Monitor surfaces it within ~5s.
- **Wanderer signals liveness (DEC-078)**: FIRST post `cli.ts send … --kind ack
  --ref <ref>`, then `--kind progress` lines (≈ once a minute) while you review,
  so the PM extends instead of falling back on slowness.
- **Wanderer → PM**: review the `ref` design doc, then **post your verdict
  explicitly** (there is no harvest hook on Claude):
  `cli.ts send … --kind review_reply --body "<verdict + advice>"`. Verdict ∈
  `PASS` / `PASS_WITH_NOTES` / `REWORK_RECOMMENDED` / `BLOCK` / `NO_OPINION`. If
  you cannot finish (rate-limited / quota / error), post `--kind unavailable`.
- **Convergence**: exchange until you and the PM agree, then `--kind agree`.

## 5. Reliability

Same floor as the Codex path: the PM checks presence, runs the DEC-078 handshake
(extend while the Wanderer proves life via `ack`/`progress` or fresh
turn-boundary beats), and falls back to the **Observer subagent** on genuine
absence / ~90s silence / rate-limit / the absolute ceiling — so a missing or
unusable Claude Wanderer never blocks the PM.
