# Role dispatch via subagent (DEC-057)

How the top interactive session — **Dock** in the dock lane, **PM** in the
artisan lane — delegates a role's assignment to a **subagent**:
request → run-to-completion → return. This is the Claude execution substrate
that supersedes the DEC-052 watching-bay / terminal-launch model — there is no
idle bay to wake, so no wake mechanism and no deadlock.

Subagent nesting is one level, so PM/Dock coordinate at the top and the
producer/reviewer roles are the subagents (they never sub-spawn). Below,
"Dock" means that top dispatching session (the **PM** in the artisan lane).

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
- **A Codex / non-Claude role (DEC-058)** → the Dock runs the provider
  CLI as a **run-to-completion subprocess** (the Agent/Workflow tool is
  Claude-only). See §2b. Each provider runs under its own account/plan; provider
  terms and billing are the operator's responsibility (Garelier makes no billing
  claim).

## 2. Spawn the role subagent

**Pick the model first (`model_routing.md`).** Tier follows judgment density:
a mid-tier model is fine for a gated producer (Worker/Smith/Librarian/Scout);
use a strong model for judgment-dense seats (Guardian, Observer, a Jig judge),
and for the Dock (PM/Dock) itself. Pass `model` on the Agent/Workflow
call (`opus`/`sonnet`/`haiku` or a provider id), or `--model` for a Codex
producer; a subagent inherits the Dock's model when you omit it.

**Producer worktree checklist (commit-bearing roles).** Preferred: run the
zero-LLM helper `scripts/dispatch_prepare.sh` / `.ps1` (`--project --pm-id
--role --slug [--blueprint <path>]`) — it performs steps 1–2 atomically and
prints `{id, container, checkout, branch, base_sha, context}` for the producer
prompt, and writes a forward-supply fact-pack `context.json` into the container
(DEC-081 Piece 1) so the producer reads the gate command / target_slug / branch
names / base sha / blueprint anchors instead of re-deriving them in its cold
worktree; after integration, `scripts/dispatch_cleanup.sh --id <n>
[--delete-branch]` removes the worktree (DEC-063). The manual contract it
implements:
1. Claim the next task id: read `runtime/backlog/next_id`, use it, write back
   `id+1` (atomically — one Dock owns this counter).
2. Create a fresh worktree off the **studio tip**, on the role's branch family,
   in a container that is NOT an in-flight role's (never reuse
   `_workers/<id>/` while it holds another task):
   `git -C <project> worktree add <container>/checkout -b
   garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug> <studio-branch>`.
3. The producer works ONLY inside that `checkout/`; its coordination files
   (assignment.md, report.md, STATE.md) live one level up in the container.
4. After integration, the Dock removes the worktree (`git worktree
   remove`); read-only roles (Scout/Observer/Guardian) skip steps 1–2 — they
   need no worktree.

Use `isolation: "worktree"` for commit-producing roles (Worker / Smith /
Librarian / Artisan); read-only roles (Scout / Observer / Guardian) need no
worktree. Give a prompt of this shape — keep it compact, reference artifacts by
PATH (never paste bodies; DEC-049):

> You are the Garelier **\<Role\>** for PM `<pm_id>` in project `<project-root>`.
> Load and follow the `garelier-<role>` skill — that skill is your authoritative
> procedure. Your coordination dir is `__garelier/<pm_id>/_<role>s/<id>/`; your
> assignment is `<assignment-path>`.
> Read your `context.json` (the dispatch `context` path) FIRST — it forward-
> supplies the gate command, target_slug, branch names, base sha, and blueprint
> anchors (DEC-081), so you need not re-derive them. It is advisory: open the raw
> assignment / blueprint / AGENTS.md on demand; never treat it as a substitute
> for reading what your task actually needs.
> [Producers] Cut your `<branch-family>` branch off `studio` and work in your
> worktree; you are commit-bearing.
> [Read-only roles] You are commit-free; write only the inspection / verdict.
> Do the task to completion per the skill, run the project quality gate where the
> skill requires it, then write your report to `<report-path>`.
> Run every gate / build / test command in the FOREGROUND and wait for it to
> finish — do NOT offload a long command to a Monitor or a background task and
> end your turn; you are run-to-completion and will not be re-woken, so that
> strands the task and orphans the build process. A long cold build is expected;
> just wait. Only a real external blocker (missing input/authority) is grounds
> to BLOCK.
> Return ONLY a compact result (≤ 12 lines): final STATE, branch + commit SHA
> (producers), report path, gate result, and any BLOCKED question. Do not ask me
> anything; if genuinely blocked, return STATE=BLOCKED with the question.

## 2b. Codex / non-Claude producer (DEC-058)

When a role is assigned to Codex (or a pool provider), the Dock produces
it by running the provider CLI **synchronously** instead of spawning a Claude
subagent. Reliability is identical (request → run-to-completion → return); only
the producer engine differs.

1. Prepare the role's worktree off `studio` (the Dock cuts the branch,
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

## 3. Integrate after it returns (Dock)
- Read the compact result + the referenced `report.md` (path, not body).
- **Dock lane**: send the returned branch through **Guardian → Observer** per
  `observer_policy`. **Combined-reviewer profile (DEC-064 §2):** on a
  normal-risk merge, ONE reviewer subagent may run both lenses (security gate
  checklist + adversarial quality review) and emit both verdicts in one pass.
  Two separate agents remain REQUIRED when the diff touches protected paths /
  gate globs, dependency or license surfaces, or is CRITICAL-classified.
- Then file the merge request with ONE command — never hand-write the JSON
  (DEC-064 §1): `scripts/merge_request.sh --project <root> --pm-id <pm>
  --branch <workbench-branch> --guardian <verdict> [--observer <verdict>]`
  derives the studio branch + a non-empty merge_message and runs the zero-LLM
  `dock_merge.ts poll` (DEC-045 order); dispatch Smith hardening if configured.
- **Do NOT commit on the studio primary checkout while a merge gate is active
  (DEC-075).** The async merge gate runs in the PRIMARY checkout and stages its
  merge there (`git merge --no-commit` → `MERGE_HEAD` set, committed only after the
  gate passes). If the Dock runs its own `git commit` on `studio` during
  that window, the commit **consumes the staged `MERGE_HEAD`** — it becomes a
  mislabeled merge commit bundling the workbench branch with the Dock's
  change, and bypasses the gate's verdict. Before ANY Dock `studio` commit
  (dashboard / milestone / history / blueprint / `.claude` config), verify BOTH are
  absent: `runtime/merge_gate/locks/active.lock` and `.git/MERGE_HEAD`. If either is
  present, wait for the gate to finish (its result lands in `merge_gate/results/`,
  `active.lock` clears). Sequence control commits BEFORE filing the merge request or
  AFTER the gate finishes — never during.
- **Artisan lane**: the Artisan already passed Guardian + Observer and integrated
  its `satchel` itself — just intake the report.
- **BLOCKED**: write the role's `answers.md` and re-dispatch, or escalate to PM.
- **Monitor-stalled / non-returning producer (DEC-074)**: if a producer ended its
  turn mid-gate against the run-to-completion rule (DEC-073 Part A) — its result
  reads like "I'll wait for the background build" with STATE still `WORKING` and
  uncommitted/ungated changes — recover **without losing its context** when **Agent
  Teams is enabled** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`): send the stalled
  subagent a `SendMessage` (`to: <agentId>`) instructing it to run the gate in the
  FOREGROUND, commit, and write its report. A stopped subagent auto-resumes with its
  full transcript, so it finishes **its own** gate — the **Worker contract is
  preserved** (no gate-ownership re-draw needed). **Fallback** (Agent Teams off, or
  the subagent is unreachable): the Dock finishes the work itself —
  diff-verify the producer's uncommitted changes, kill any orphan build process +
  clear `target/debug/incremental`, commit on the producer's branch, run the gate
  solo, finalize the report — then proceed to review. Enable Agent Teams via
  `settings.json` `env` (project `.claude/settings.json` or `~/.claude/settings.json`);
  it is launch-time, so it applies from the next session, and it is experimental.
- Update `runtime/manifest.md` and the role `STATE.md` so the Status Web reflects
  progress.

## 4. Dock-lane orchestration loop

Each Dock iteration (the top Dock session):
1. From the blueprint / backlog, pick the ready assignments (respect priority +
   interest-file gating; don't re-dispatch in-flight work).
2. **Fan out producers in parallel via the Workflow tool** — one subagent per
   ready Worker / Scout / Smith / Librarian assignment (§2 prompt; producers
   `isolation: worktree`). Each runs to completion and returns
   `{STATE, branch, sha, report, blocked?}`.
   - **Heavy-compile lock (DEC-073 Part B)**: when a producer's gate runs a heavy
     build (`cargo build --workspace` etc.) on a RAM-bound box, the Dock
     holds `bun scripts/heavy_compile_lock.ts` for that producer's lifetime
     (acquire before the dispatch, release on return) so the producer's compile
     does not run in parallel with the async merge gate's `cargo test --workspace
     --no-run` (the merge gate holds the same lock around its own gate). Tune via
     `[heavy_compile] max_concurrent` (0 = off when builds are concurrency-safe).
     The lock fail-opens on timeout and self-heals (pid-dead + lease reclaim).
3. For each returned commit-bearing branch, **review** via Guardian → Observer
   subagents (read-only) per `observer_policy`; collect verdicts.
4. **Merge gate**: integrate passing branches into `studio` serially (DEC-045
   order). A failing / conflicting branch is sent back as rework (re-dispatch the
   role with `review.md`).
5. Dispatch **Smith** hardening on the integrated `studio` snapshot if configured
   (same review + merge path).
6. Update `runtime/manifest.md` and role `STATE.md`; surface BLOCKED to PM.

The Dock idles at ~0 tokens when nothing is ready — it does not poll.

## 4b. Record dispatch events (single-source runtime state, W-011)

`runtime/dispatch/events.jsonl` is the **append-only single source** of
dispatch execution (DEC-064 §3); `runtime/backlog/in_flight.md` is a GENERATED
view of the live producers — never hand-edit either. Record every lifecycle
event with one command (it appends the JSON line with correct escaping AND
regenerates the view):

```bash
garelier-core/scripts/dispatch_event.sh --project <root> --pm-id <id> \
  --kind start --role "worker(#12)" --task "#12 reliable-resend repro"
# (PowerShell: dispatch_event.ps1 -Kind start -Role 'worker(#12)' -Task '...')
```

- Event fields: `ts` (ISO), `role` (role id), `kind` (`start` | `complete` |
  `blocked` | `rework` | `cleanup` | `note`), `task` (assignment id /
  one-line), `ref` (report / inspection path, optional).
- `dispatch_prepare` records `start` and `dispatch_cleanup` records `cleanup`
  automatically; the Dock (or the jig RECORD phase) records the
  **return** (`complete` / `blocked` / `rework`). Refs only — never paste
  bodies (DEC-049).
- Best-effort and read-only-safe: the Status Web tolerates a missing file or a
  corrupt line, and shows the newest 20 with a "showing N of M" total. The
  live *in-progress* list derives from `_dispatch<N>/STATE.md` (and any
  non-IDLE role container) — structural truth, not bookkeeping.

## 5. Constraints
- **No agent-definition files**, no global `~/.claude/agents/` entries, no writes
  to the target repo root (the role is the shared read-only `garelier-<role>`
  skill; multi-project safe; removable).
- **No terminal bays / Monitor / Stop-hook wake** (DEC-052 substrate superseded).
- **Producer run-to-completion, foreground gates (DEC-073 Part A)**: a dispatched
  role runs its gate / build / test commands in the FOREGROUND and waits; it
  never offloads a blocking command to a Monitor / background task and ends its
  turn expecting a re-wake. There is no re-wake — ending the turn mid-work
  strands the task and leaves an orphan build process holding the worktree's
  `target/` lock (which starves the next compile and blocks cleanup). A long
  cold build is waited out, not backgrounded. This is `correct_operation.md`
  item 12; the Dock that detects a stranded producer finishes the gate +
  commit itself or re-dispatches, and reclaims the orphan + worktree per Part B
  (heavy-compile lock) / Part C (cleanup sweep).
- **In-session subagents**: subagents are spawned from the interactive
  Dock (in the same session). Provider terms and billing are the
  operator's responsibility; Garelier makes no billing claim.
- **Token discipline (DEC-049)**: refs not bodies; compact returns; the
  Dock idles at ~0 tokens between dispatches.
- **Codex** is a separate path (`codex exec`); subagents are Claude-only.

## Validated (2026-06-08, live)

- Single role roundtrips: a **Scout** (read-only inspection) and a **Worker**
  (`studio` → `workbench` → implement → gate → commit → return) each completed
  and returned — no agent-definition files, no wake, no deadlock.
- Dock-lane loop: **2 Worker subagents produced on `workbench/*` branches in
  parallel** (each in its own worktree off `studio`, gate-pass), and a **Dock
  subagent integrated both into `studio`** (`--no-ff`, clean). ~4 agents, ~85k
  tokens. Ran as in-session subagents from the interactive Dock.
