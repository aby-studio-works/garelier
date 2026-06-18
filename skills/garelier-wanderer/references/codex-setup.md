# Connecting Codex as the Wanderer (DEC-076)

The Wanderer is a **separately-launched, persistent** Codex session (NOT a
subagent, NOT `codex exec`). It talks to the PM over the file-based peer-channel.
Codex notices inbound PM requests between turns via a **Stop hook**, and announces
itself via a **SessionStart hook** — both run the adapter
`driver/src/peer/wanderer_hook.ts`, which heartbeats presence and surfaces the
inbox into the session.

## Prerequisites

- `codex` CLI installed and authenticated (a strong model, e.g. `gpt-5-codex`).
- `bun` on PATH (the peer-channel adapter runs under Bun).
- garelier-core present (this repo provides the adapter + CLI).

## 1. Place `.codex/hooks.json` in the TARGET project root

Codex auto-discovers `<repo>/.codex/hooks.json`. For the project being reviewed,
create `<project-root>/.codex/hooks.json`. Concrete example (replace the
`<garelier-repo>` / `<project-root>` placeholders and pm-id with your own):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ {
        "type": "command",
        "command": "bun \"<garelier-repo>/skills/garelier-core/driver/src/peer/wanderer_hook.ts\" --project \"<project-root>\" --pm-id aby_works --channel wanderer --peer wanderer-01 --tool codex",
        "timeout": 30
      } ] }
    ],
    "Stop": [
      { "hooks": [ {
        "type": "command",
        "command": "bun \"<garelier-repo>/skills/garelier-core/driver/src/peer/wanderer_hook.ts\" --project \"<project-root>\" --pm-id aby_works --channel wanderer --peer wanderer-01 --tool codex",
        "timeout": 30
      } ] }
    ]
  }
}
```

`.codex/` holds machine-specific absolute paths — keep it local (gitignore it)
rather than committing it to the target repo.

## 2. Launch Codex as the Wanderer

From the **target project root** (so it reads the right peer-channel and design
docs), launch an interactive Codex session **read-only / approval-required** so
it stays advisory (no commits, no writes):

```
cd <project-root>
codex            # interactive; approve nothing that writes — this is an advisory peer
```

On first run, **trust the project hooks**: run `/hooks` in Codex and approve the
two entries (project-local hooks load only when the `.codex/` layer is trusted;
otherwise pass `--dangerously-bypass-hook-trust` only if you understand it).

At session start the SessionStart hook writes the presence heartbeat and prints
a one-line role reminder. The Wanderer is now "present."

## 3. The loop

- **PM → Wanderer**: the PM posts a review request to the channel (directly, or
  via the gate `driver/src/peer/wanderer_review.ts`).
- **Wanderer picks it up**: on the Wanderer's next turn boundary, the Stop hook
  surfaces the inbox into the session as a `systemMessage` with the reply command.
- **Wanderer → PM**: it reviews the `ref` design doc and replies with
  `cli.ts send … --kind review_reply --body "<verdict + advice>"`.
- **Convergence**: exchange until you and the PM agree, then `--kind agree`.

> Idle wake is best-effort: the Stop hook only fires after a *completed* turn, so
> a fully-idle Codex won't auto-pick-up until it takes a turn (a human nudge, or
> while it is actively working). This is by design — the **PM await timeout +
> Observer subagent fallback** (DEC-076 §4) is the reliability floor, so a
> sleeping or absent Wanderer never blocks the PM.

## 4. PM-side gate

The PM runs:

```
bun driver/src/peer/wanderer_review.ts --project <P> --pm-id <ID> --doc <design.md> [--peer wanderer-01] [--timeout-ms 180000]
```

It checks the Wanderer's presence, posts the request, and waits. Output:
`{ outcome: "reviewed", reply }` (exit 0) when the Wanderer answers, or
`{ outcome: "fallback_observer", reason }` (exit 3) when it is absent/silent —
the PM then runs the Observer subagent for that review instead.

## A Claude Code Wanderer (alternative)

A Claude Code Wanderer can use the Monitor tool to tail the channel (push, ~5s)
instead of a Stop hook. Same channel, same `cli.ts`, same presence/reply
contract; only the wake mechanism differs.
