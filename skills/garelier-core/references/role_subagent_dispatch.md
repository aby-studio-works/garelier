# Role dispatch via subagent (DEC-057)

How the **orchestrator** delegates a role's assignment to a **subagent**:
request → run-to-completion → return. This is the Claude execution substrate
that supersedes the DEC-052 watching-bay / terminal-launch model — there is no
idle bay to wake, so no wake mechanism and no deadlock.

The orchestrator is the top interactive session: **PM** in
the artisan lane, **Dock** in the dock lane. Subagent nesting is one level, so
PM/Dock coordinate at the top and the producer/reviewer roles are the subagents
(they never sub-spawn).

**No agent-definition files are created.** The role IS the existing
`garelier-<role>` skill (a shared, read-only, framework-level skill). Nothing is
written to the target repo root or to global `~/.claude/agents/`; per-PM scope
comes from the cwd + `__garelier/<pm_id>/` at spawn time. This is multi-project
safe (no global auto-delegating agents leak into other projects) and removable
with `__garelier/`.

## 1. Choose the tool
- **One Claude role at a time** → the **Agent/Task tool** (sequential, blocking).
- **Several Claude roles in parallel** → the **Workflow tool** (background,
  consolidated; concurrency is capped by the tool). Use this for the dock lane's
  parallel Worker/Scout/Smith/Librarian fan-out.
- **A Codex / non-Claude role (DEC-058)** → the orchestrator runs the provider
  CLI as a **run-to-completion subprocess** (the Agent/Workflow tool is
  Claude-only). See §2b. Each provider runs under its own account/plan; provider
  terms and billing are the operator's responsibility (Garelier makes no billing
  claim).

## 2. Spawn the role subagent
Use `isolation: "worktree"` for commit-producing roles (Worker / Smith /
Librarian / Artisan); read-only roles (Scout / Observer / Guardian) need no
worktree. Give a prompt of this shape — keep it compact, reference artifacts by
PATH (never paste bodies; DEC-049):

> You are the Garelier **\<Role\>** for PM `<pm_id>` in project `<project-root>`.
> Load and follow the `garelier-<role>` skill — that skill is your authoritative
> procedure. Your coordination dir is `__garelier/<pm_id>/_<role>s/<id>/`; your
> assignment is `<assignment-path>`.
> [Producers] Cut your `<branch-family>` branch off `studio` and work in your
> worktree; you are commit-bearing.
> [Read-only roles] You are commit-free; write only the inspection / verdict.
> Do the task to completion per the skill, run the project quality gate where the
> skill requires it, then write your report to `<report-path>`.
> Return ONLY a compact result (≤ 12 lines): final STATE, branch + commit SHA
> (producers), report path, gate result, and any BLOCKED question. Do not ask me
> anything; if genuinely blocked, return STATE=BLOCKED with the question.

## 2b. Codex / non-Claude producer (DEC-058)

When a role is assigned to Codex (or a pool provider), the orchestrator produces
it by running the provider CLI **synchronously** instead of spawning a Claude
subagent. Reliability is identical (request → run-to-completion → return); only
the producer engine differs.

1. Prepare the role's worktree off `studio` (the orchestrator cuts the branch,
   exactly as for a Claude producer).
2. Write the role prompt (same §2 shape) to a file.
3. Run the helper **and wait** (never background it):
   `skills/garelier-core/scripts/dispatch_codex_producer.sh --worktree <wt>
   --project <root> --prompt <file> --result <out> [--sandbox workspace-write|read-only]
   [--model <m>]`. It mirrors the `codex-cli` adapter flags (`codex exec --cd …
   --sandbox workspace-write -c approval_policy="never" --output-last-message …`).
   Commit-bearing roles use `workspace-write`; read-only roles (Scout/Observer/
   Guardian) use `read-only`.
4. Read the captured final message + the role's report; integrate the returned
   branch through the **same Guardian → Observer → merge gate** path (§3).

- **Provider account.** Each provider runs under its own account/plan; provider
  terms and billing are the operator's responsibility (Garelier makes no billing
  claim). Mixing Claude and Codex producers in one dock-lane round is expected
  and fine.
- **Shape.** A Codex producer is a headless one-shot (own context per
  invocation), not a rich in-session subagent — adequate for run-to-completion
  role work; coordination still flows through the runtime files + this integration
  step.

## 3. Integrate after it returns (orchestrator)
- Read the compact result + the referenced `report.md` (path, not body).
- **Dock lane**: send the returned branch through **Guardian → Observer** (spawn
  them as review subagents) per `observer_policy`, then run the **merge gate**
  into `studio` (DEC-045 order); dispatch Smith hardening if configured.
- **Artisan lane**: the Artisan already passed Guardian + Observer and integrated
  its `satchel` itself — just intake the report.
- **BLOCKED**: write the role's `answers.md` and re-dispatch, or escalate to PM.
- Update `runtime/manifest.md` and the role `STATE.md` so the Status Web reflects
  progress.

## 4. Dock-lane orchestration loop

Each Dock iteration (the top orchestrator session):
1. From the blueprint / backlog, pick the ready assignments (respect priority +
   interest-file gating; don't re-dispatch in-flight work).
2. **Fan out producers in parallel via the Workflow tool** — one subagent per
   ready Worker / Scout / Smith / Librarian assignment (§2 prompt; producers
   `isolation: worktree`). Each runs to completion and returns
   `{STATE, branch, sha, report, blocked?}`.
3. For each returned commit-bearing branch, **review** via Guardian → Observer
   subagents (read-only) per `observer_policy`; collect verdicts.
4. **Merge gate**: integrate passing branches into `studio` serially (DEC-045
   order). A failing / conflicting branch is sent back as rework (re-dispatch the
   role with `review.md`).
5. Dispatch **Smith** hardening on the integrated `studio` snapshot if configured
   (same review + merge path).
6. Update `runtime/manifest.md` and role `STATE.md`; surface BLOCKED to PM.

The orchestrator idles at ~0 tokens when nothing is ready — it does not poll.

## 4b. Record dispatch events for the Status Web (recommended)

The live role `STATE.md` already drives the Status Web's *in-progress* list (any
role in `ASSIGNED` / `WORKING` / `REPORTING` / `BLOCKED` shows as a live dispatch).
To give the **Dispatch activity** panel a *recent log* too, the orchestrator
appends one compact JSON line per dispatch lifecycle event to
`__garelier/<pm_id>/runtime/dispatch/events.jsonl`:

```jsonl
{"ts":"2026-06-08T05:00:00Z","role":"worker-01","kind":"start","task":"#12 reliable-resend repro","ref":null}
{"ts":"2026-06-08T05:14:00Z","role":"worker-01","kind":"complete","task":"#12 reliable-resend repro","ref":"__garelier/<pm_id>/runtime/worker/worker-01/report.md"}
```

- One object per line (append-only). Fields: `ts` (ISO), `role` (the role id),
  `kind` (`start` | `complete` | `blocked` | `note`), `task` (assignment id /
  one-line), `ref` (report / inspection path, or null).
- Append at the **start** of a dispatch and again on its **return** (and on
  BLOCKED / rework). Refs only — never paste bodies (DEC-049).
- Best-effort and read-only-safe: the panel tolerates a missing file or a corrupt
  line, and shows the newest 20 with a "showing N of M" total. This is purely for
  visibility; coordination state still lives in the runtime file protocol.

## 5. Constraints
- **No agent-definition files**, no global `~/.claude/agents/` entries, no writes
  to the target repo root (the role is the shared read-only `garelier-<role>`
  skill; multi-project safe; removable).
- **No terminal bays / Monitor / Stop-hook wake** (DEC-052 substrate superseded).
- **In-session subagents**: subagents are spawned from the interactive
  orchestrator (in the same session). Provider terms and billing are the
  operator's responsibility; Garelier makes no billing claim.
- **Token discipline (DEC-049)**: refs not bodies; compact returns; the
  orchestrator idles at ~0 tokens between dispatches.
- **Codex** is a separate path (`codex exec`); subagents are Claude-only.

## Validated (2026-06-08, live)

- Single role roundtrips: a **Scout** (read-only inspection) and a **Worker**
  (`studio` → `workbench` → implement → gate → commit → return) each completed
  and returned — no agent-definition files, no wake, no deadlock.
- Dock-lane loop: **2 Worker subagents produced on `workbench/*` branches in
  parallel** (each in its own worktree off `studio`, gate-pass), and a **Dock
  subagent integrated both into `studio`** (`--no-ff`, clean). ~4 agents, ~85k
  tokens. Ran as in-session subagents from the interactive orchestrator.
