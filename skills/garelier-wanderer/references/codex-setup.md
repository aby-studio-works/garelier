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

## 1. Place `.codex/hooks.json` in the Garelier control root

Codex auto-discovers `<repo>/.codex/hooks.json`. For the Garelier PM being
reviewed, create `<control-root>/.codex/hooks.json` (the directory that owns
`__garelier/`; in Plant-Lithosphere it is also the target project root).
Concrete example (replace the `<garelier-repo>` / `<control-root>` placeholders
and pm-id with your own):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ {
        "type": "command",
        "command": "bun \"<garelier-repo>/skills/garelier-core/driver/src/peer/wanderer_hook.ts\" --project \"<control-root>\" --pm-id aby_works --channel wanderer --peer wanderer-01 --tool codex",
        "timeout": 30
      } ] }
    ],
    "Stop": [
      { "hooks": [ {
        "type": "command",
        "command": "bun \"<garelier-repo>/skills/garelier-core/driver/src/peer/wanderer_hook.ts\" --project \"<control-root>\" --pm-id aby_works --channel wanderer --peer wanderer-01 --tool codex",
        "timeout": 30
      } ] }
    ]
  }
}
```

`.codex/` holds machine-specific absolute paths — keep it local (gitignore it)
rather than committing it to the control or target repo.

## 2. Launch Codex as the Wanderer

From the **control root** (so it reads the right peer-channel and design docs),
launch an interactive Codex session **read-only / approval-required** so it
stays advisory (no commits, no writes):

```
cd <control-root>
codex            # interactive; approve nothing that writes — this is an advisory peer
```

On first run, **trust the project hooks**: run `/hooks` in Codex and approve the
two entries (project-local hooks load only when the `.codex/` layer is trusted;
otherwise pass `--dangerously-bypass-hook-trust` only if you understand it).

Also **pre-approve the peer cli** once. Under `--sandbox read-only`, the very
first time the Wanderer runs `cli.ts send … --kind ack/progress/review_reply`
(its only sanctioned writes — they target the peer-channel, not the project),
Codex shows a "Would you like to run …" prompt; choose the **"don't ask again
for commands that start with `bun …/peer/cli.ts`"** option so the liveness
ack/reply posts are never blocked. The PM review gate (`wanderer_review.ts`,
DEC-076 §6) also auto-confirms these READ-only / peer-cli prompts while refusing
any write when it drives a recorded pane, so this manual step is a one-time
convenience and a fallback for the no-pane case.

At session start the SessionStart hook writes the presence heartbeat and prints
a one-line role reminder. The Wanderer is now "present."

There must be only one active Wanderer. If a recorded Wanderer pane is still
alive but has no fresh heartbeat, do **not** launch another one; inspect/trust
hooks, nudge it, or close it before launching again. If the pane is rate-limited
or otherwise unavailable, use the Observer fallback for the review.

## 3. The loop

- **PM → Wanderer**: the PM posts a review request to the channel (directly, or
  via the gate `driver/src/peer/wanderer_review.ts`).
- **Wanderer picks it up**: on the Wanderer's next turn boundary, the Stop hook
  surfaces the inbox into the session as a `systemMessage` with the reply command.
- **Wanderer signals liveness (DEC-078)**: on a long review it FIRST posts
  `cli.ts send … --kind ack`, then `--kind progress` lines (≈ once a minute)
  while it thinks. The PM extends its wait while these arrive and falls back to
  the Observer only on ~90s of silence — a slow-but-alive review is not abandoned.
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
bun driver/src/peer/wanderer_review.ts --project <P> --pm-id <ID> --doc <design.md> [--peer wanderer-01] \
  [--ack-window-ms 45000] [--silence-window-ms 90000] [--ceiling-ms 900000] [--legacy --timeout-ms 180000]
```

It checks the Wanderer's presence, posts the request, and waits. **By default
(DEC-078) it runs the liveness handshake**: it extends the wait while the Wanderer
posts `ack`/`progress` (or refreshes its turn-boundary heartbeat) and degrades to
the Observer only on genuine absence / ~90s silence / rate-limit / the absolute
ceiling — instead of abandoning a slow-but-alive review at a flat timeout.
`--legacy` reverts to the old flat `--timeout-ms`. Output:
`{ outcome: "reviewed", verdict, reply }` (exit 0) only when the Wanderer
answers with a canonical verdict token, or
`{ outcome: "fallback_observer", reason }` (exit 3) when it is absent, silent,
rate-limited/unavailable, or replies without a valid verdict — the PM then runs
the Observer subagent for that review instead. The PM launches/uses a Wanderer
only when the user has explicitly asked for it; otherwise Observer review is the
normal independent review path.

## A Claude Code Wanderer (alternative)

See `claude-setup.md`. In short: a Claude Wanderer keeps its presence heartbeat
via a Claude Code SessionStart/Stop hook running `cli.ts presence --beat`, tails
the channel with the Monitor tool (push, ~5s) instead of a Codex Stop hook, and
posts its reply explicitly (no Stop-hook harvest). Same channel, same `cli.ts`,
same presence/reply contract and DEC-078 liveness handshake; only the wake +
heartbeat wiring differ.
