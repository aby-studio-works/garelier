# Role dispatch via subagent (DEC-057)

How the top interactive session — **Dock** for Dock orchestration, **PM** for
the Artisan Artisan route — delegates a role's assignment to a **subagent**:
request → run-to-completion → return. This is the Claude execution substrate
that supersedes the DEC-052 watching-bay / terminal-launch model — there is no
idle bay to wake, so no wake mechanism and no deadlock.

Subagent nesting is one level, so PM/Dock coordinate at the top and the
dispatched and reviewer roles are the subagents (they never sub-spawn). Below,
"Dock" means that top dispatching session (the **PM** on the Artisan route).

**No agent-definition files are created.** The role IS the existing
`garelier-<role>` skill (a shared, read-only, framework-level skill). Nothing is
written to the target repo root or to global `~/.claude/agents/`; per-PM scope
comes from the cwd + `__garelier/<pm_id>/` at spawn time. This is multi-project
safe (no global auto-delegating agents leak into other projects) and removable
with `__garelier/`.

## 0. Hot rules（高頻度 read 用の 1-行 索引）

Dock/PM が role を subagent に dispatch する時の運用規則の索引。**まずここを読み、
手順詳細が要る時だけ該当 §N を開く**（§1–§6 が詳細本体 = この file の 後半）。
health 語彙・taxonomy は `pm_playbook.md` §11 と共通。

| # | 状況 | 正しい手（core） |
| :-- | :-- | :-- |
| §1 | tool を選ぶ | 1 role = Agent/Task（sequential, blocking）/ 並列 = Workflow（background, cap）/ Codex 等 non-Claude = CLI subprocess（§2b） |
| §2 | dispatched role subagent を spawn | model を先に（`model_routing.md`）。全 detached role は同じ `dispatch_prepare.ts` 入口で `context.json` + canonical `label`/`name` を得る。worktree の要否は helper 内部で分岐。dispatch scaffolding の無い repo は `workspace_isolate.ts`。prompt は compact・artifact は PATH 参照・foreground gate 規律・interim message 1 本・最終 compact result |
| §2b | mixed-provider dispatched role | `dispatch_prepare --provider codex|claude-code` → emitted `provider_parent_routes`。budget 内は helper を直接同期、超過は helper 全体を durable broker の 1 command として実行（ad-hoc background 禁止）。branch-owning role だけが同じ Guardian→Observer→merge gate 経路へ進み、no-worktree role は指定 artifact を返す |
| §2d | CLI session へ追加指示 | `provider_session.ts resume` + **記録済み explicit ID** のみ。instruction ledger/file → 同一 worktree、session lock 中に resume。`--last` / `--continue` 禁止、missing/expired は fresh dispatch 必須 metadata |
| §2c | 並列 dispatched role の衝突検出 | `--touches '<glob>'`（**single-quote**）+ `--depends-on` を宣言 → active dispatch と交差 check（warn のみ、block しない）。overlap は serialize / split / `--allow-conflict` |
| §3 | 返ってきた branch を integrate（Dock） | report は path で読む。Guardian→Observer per `observer_policy`（normal-risk は combined 1 体可、protected/CRITICAL は 2 体）。`merge_request.ts` 1 command。**active merge gate 中は studio primary に commit しない**（`active.lock` / `MERGE_HEAD` 両方不在を確認）。idle 通知は `contract_check --stall-scan` で build-wait と切り分け |
| §4 | Dock orchestration loop | ready assignment を pick → Workflow で並列 fan-out（heavy build は `heavy_compile_lock`）→ Guardian→Observer → merge gate serial（DEC-045）→ Smith hardening → manifest/STATE 更新。idle 時 ~0 token |
| §4b | dispatch event を記録 | `runtime/dispatch/events.jsonl` が単一 source、`dispatch_event.ts` で追記（手編集しない）。refs のみ・body 貼らない |
| §5 | 制約 | agent-def file なし / bay・Monitor wake なし / 全 detached role は必ず `dispatch_prepare` / dispatched role は foreground run-to-completion / refs not bodies |
| §6 | harness 実行限界（W-077） | foreground bash は budget（`bash_timeout_budget_ms`、2min 既定 / 10min / `BASH_MAX_TIMEOUT_MS`）で kill。budget 内 = foreground / 超過 = unchanged helper command を durable single-flight broker が所有。operator watch / `SendMessage` は任意通知、authority は ledger の result + exact ACK。安全は 3 層（foreground=timeout / broker=watchdog RUNAWAY / behavior=guard）。taxonomy = PROGRESS / ADVANCING / BUILDING / DECLARED-DONE / SPAWN-GRACE / STALLED / RUNAWAY / REVIVE-NEEDED |
| §6 | 最終 turn の終え方（W-085） | commit / STATE 更新だけで沈黙せず、必ず **register message**（§2 final-message 契約: STATE / branch+SHA / report / gate 結果 / BLOCKED 質問）で終える。run-to-completion なので register が唯一の完了 signal、無いと done でも stall と区別不能。この規則は operator の workshop subagent 自身にも適用 |
| §6 | 指示台帳の消し込み（W-092） | REPORTING 前に container の `instructions.md` を開き、全 entry を消し込む（`checked = false` → `checked = true` + `consumed = '''<sha\|register>'''`）。未消化 entry が 1 つでも残る間は REPORTING しない。register に「台帳 N/N 消化」を必須記載。mid-flight の PM 指示（scope 拡張）が完了 register と交差して落ちる class を防ぐ（`--stall-scan` UNCONSUMED-INSTRUCTIONS が検出） |
| §6(C) | idle_notification の扱い（W-089/W-078） | bare idle ping は no-action（evidence は git fingerprint が正）。**唯一の例外 = IDLE-DONE wake**: idle + STATE≠REPORTING + background 完走確認の 3 条件が揃えば PM が wake message（output path + 転記指示 + register 形式）を送る |

## 1. Choose the tool
- **One Claude-dispatched role at a time** → the **Agent/Task tool** (sequential, blocking).
- **Several Claude-dispatched roles in parallel** → the **Workflow tool** (background,
  consolidated; concurrency is capped by the tool). Use this for Dock orchestration's
  parallel Worker/Scout/Smith/Librarian fan-out.
- **A Codex / non-Claude-dispatched role (DEC-058)** → the Dock runs the provider
  CLI as a **run-to-completion subprocess** (the Agent/Workflow tool is
  Claude-only). See §2b. Each provider runs under its own account/plan; provider
  terms and billing are the operator's responsibility (Garelier makes no billing
  claim).

## 2. Spawn the role subagent

**Pick the model first (`model_routing.md`).** Tier follows judgment density:
a mid-tier model is fine for a gated dispatched role (Worker/Smith/Librarian/Scout);
use a strong model for judgment-dense seats (Guardian, Observer, a Jig judge),
and for the Dock (PM/Dock) itself. Pass `model` on the Agent/Workflow
call (`opus`/`sonnet`/`haiku` or a provider id), or `--model` for a Codex
dispatched role; a subagent inherits the Dock's model when you omit it.

**Single dispatched-role entry (all detached roles).** Run the
zero-LLM helper `driver/src/scripts/dispatch_prepare.ts` (`--project --pm-id
--role --slug [--blueprint <path>] [--pipeline-package PP-N]
[--target-root <git-root>]`) — it performs
steps 1–2 atomically and prints `{id, container, checkout, branch, base_sha,
context, pickup_pack, label, name}` for the role's prompt (`label` =
`<role>:<slug>`, `name` = `<role>(#<id>)` — the canonical agent label + dispatch
agent-id per `workflow-naming.md` §4, emitted so the launcher reuses them
verbatim instead of reconstructing them). With `--pipeline-package`, it also renders
`assignment.md` from the blueprint's `## Pipeline packages` section. It always
writes a forward-supply fact-pack `context.json` into the container (DEC-081
Piece 1) so the dispatched role reads the gate command / target_slug / branch names /
base sha / blueprint anchors instead of re-deriving them in its cold worktree;
when an assignment exists it also writes the advisory `pickup_pack.json` (W-017)
with the task summary, package id, role-index pointers, and context path so the
role can orient itself before opening raw files;
after integration, `driver/src/scripts/dispatch_cleanup.ts --id <n>
--checkout <container>/checkout
[--delete-branch] [--target-root <git-root>]` removes the worktree (DEC-063).
In Plant-Crust, `--project` is the container/control root and `--target-root`
is the selected container's `target/` Git repository. The manual contract it
implements:
1. Claim the next task id: read `runtime/backlog/next_id`, use it, write back
   `id+1` (atomically — one Dock owns this counter).
2. When the role owns a branch, create a fresh worktree off the **studio tip**, on the role's branch family,
   in a container that is NOT an in-flight role's (never reuse
   `_crew/workers/<id>/` while it holds another task):
   `git -C <project> worktree add <container>/checkout -b
   garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug> <studio-branch>`.
3. The dispatched role works ONLY inside that `checkout/`; its coordination files
   (assignment.md, report.md, STATE.md) live one level up in the container.
4. After integration, the Dock removes an owned worktree (`git worktree
   remove`). Scout/Observer/Guardian still claim a dispatch id and container but
   skip the branch/worktree operation. They bind the Work as read-only authority
   but do not acquire, renew, or release its Control claim, so issuing or cleaning
   a gate seat cannot change the role-bound Work bytes. Their repository view
   stays read-only and the provider launcher captures only the designated artifact.

**Repos without `__garelier/<pm_id>/` dispatch-native scaffolding (W-028).**
`dispatch_prepare.ts` assumes a target project's per-PM containers; such a repo
has none of that, so an attended PM fanning out 2+ dispatched role subagents by
hand has them share the ONE working tree and collide on the index/HEAD. Use the lighter
`driver/src/scripts/workspace_isolate.ts` instead — same isolate-then-integrate shape,
zero `__garelier/` dependency:
`workspace_isolate.ts --repo <path> --slug <kebab> --owner <agent-name> [--pm-id <id>] [--base <branch>]`
cuts a `garelier/isolate/<slug>` branch off the current (or `--base`) branch
into a worktree at `<repo>/__garelier/<pm_id>/_crew/lanes/<slug>/` (excluded
via `.git/info/exclude`, never pollutes `git status`) and prints `{worktree,
branch, base_sha}` — give that `worktree` path to the dispatched role as its
cwd, and name it `--owner` exactly what you name it as the Agent tool's
`agent_name`. **`--owner` is not optional in practice** (W-240): it is what
makes `workspace_isolate.ts` also write a command_guard permission record
(profile `role`, fenced to the worktree) for that agent name — omit it and
the dispatched role's own git/test/build commands in the worktree are denied
at `baseline-destructive` (the isolate-lane worker seat's dispatch record was
missing entirely for 3 lanes in a row before this was fixed). After the role
returns, run `workspace_isolate.ts --collect --repo <path> --slug <slug>`
(fast-forwards when possible, else cherry-picks; a real conflict exits 3 with
manual-resolve steps, never auto-resolved) or `--abort` to discard — either
one also removes the guard record. Prefer `dispatch_prepare`/the jig whenever
`__garelier/<pm_id>/` scaffolding exists — this is the fallback for when it
doesn't.

Use `isolation: "worktree"` for commit-producing roles (Worker / Smith /
Librarian / Artisan); read-only roles (Scout / Observer / Guardian) need no
worktree. Give a prompt of this shape — keep it compact, reference artifacts by
PATH (never paste bodies; DEC-049):

> You are the Garelier **\<Role\>** for PM `<pm_id>`.
> `control_root=<control-root>`; `target_root=<target-root>`.
> Load and follow the `garelier-<role>` skill — that skill is your authoritative
> procedure. Your coordination dir is `__garelier/<pm_id>/_crew/<role-container>/`; your
> assignment is `<assignment-path>`.
> If `<pickup_pack-path>` exists, read it FIRST. It is an advisory pickup map:
> task id/package id, compact assignment bullets, role knowledge pointers, and
> generated context paths. Its `knowledge.triggered` list is the docs a
> `[[triggers]]` entry matched for THIS task (DEC-067) — read those alongside
> `knowledge.read_first`. Then read `assignment.md` and any raw code/policy/
> evidence your judgment requires; a missing/stale pickup pack is not a blocker.
> Read your `context.json` (the dispatch `context` path) next — it forward-
> supplies the gate command, target_slug, branch names, base sha, and blueprint
> anchors (DEC-081), so you need not re-derive them. It is advisory: open the raw
> assignment / blueprint / AGENTS.md on demand; never treat it as a substitute
> for reading what your task actually needs.
> [Dispatched roles] Cut your `<branch-family>` branch off `studio` and work in your
> worktree; you are commit-bearing.
> [Read-only roles] You are commit-free; write only the inspection / verdict.
> Do the task to completion per the skill, run the project quality gate where the
> skill requires it, then write your report to `<report-path>`.
> Run every gate / build / test command in the FOREGROUND and wait for it to
> finish — do NOT offload a long command to a Monitor or a background task and
> end your turn. You are run-to-completion and will not be re-woken; ending the
> turn mid-work strands the task and orphans the build process (why:
> `garelier-core/correct_operation.md` item 12). A long cold
> build is expected; just wait. Only a real external blocker (missing
> input/authority) is grounds to BLOCK. While you wait, send ONE brief progress
> message (STATE.md Recent log update, or SendMessage in Agent Teams) so a silent
> mid-build agent is not mistaken for a stalled one and needlessly nudged (W-034).
> Return ONLY a compact result (≤ 12 lines): final STATE, branch + commit SHA
> (dispatched roles), report path, gate result, and any BLOCKED question. Do not ask me
> anything; if genuinely blocked, open the result with `+++` front matter carrying `[lane] state = 'BLOCKED'` and the question.
> Write `report.md` and this compact result register-compliant — no greeting/
> thanks/request-echo, fragments fine, id/SHA over re-explaining, code/error/SHA/
> verdict verbatim (`garelier-core/output_control.md` § Inter-agent compressed
> register; heavy gate/verify command output — pipe it through
> `driver/src/scripts/run_summarized.ts` per § Inbound output discipline instead of
> letting it flood context, W-043b).

## 2b. Mixed-provider dispatched role (DEC-058)

Select the task provider with `dispatch_prepare --provider codex|claude-code`, then
execute the emitted route for the current parent surface from
`provider_parent_routes`. Role/container metadata has no provider authority.
The provider helper remains a **synchronous run-to-completion process**; only
its owning transport differs.

1. Prepare the role through the common dispatcher. It cuts a worktree only for
   branch-owning roles; Scout/Observer/Guardian receive the same route metadata
   without a worktree.
2. Write the role prompt (same §2 shape) to a file.
3. Run the emitted helper directly and wait only when the whole command fits
   `bash_timeout_budget_ms`. Otherwise arm that unchanged command once in the
   durable single-flight broker (§6). Never use a raw Codex/Claude provider
   invocation, shell `&`, or one waiter per job:
   `skills/garelier-core/driver/src/scripts/dispatch_provider.ts --provider codex --worktree <wt>
   --project <control-root> [--target-root <target-root>] --prompt <file>
   --result <out> [--sandbox workspace-write|read-only] [--model <m>]`.
   Cross-parent Claude dispatch uses the same recorded
   `dispatch_provider.ts --provider claude-code` command emitted by `dispatch_prepare`.
   The provider adapter constructs CLI argv and extracts the response only.
   Binding validation, prompt and role-seat checks, worktree boundary, result
   overwrite, child-tree cleanup, session record, and launch acknowledgement are
   one common path. For a role/Concierge that path grants only the checkout,
   dispatch container, result dir, the Bun executable directory required on
   Windows, and explicit operator `--add-dir` values. For a no-worktree
   Scout/Observer/Guardian seat it runs from and grants only the designated
   artifact directory; the repository is read context, never the provider cwd
   or an `--add-dir`. This grant boundary prevents repository writes while
   retaining the network/certificate access required by the provider.
   Project/control, target, framework skills, CODEX_HOME skills, and
   `context.json` context roots remain readable context but are never broadened
   into Codex write grants.
   `danger-full-access` is not a Garelier launch mode; the helper refuses it.
4. Read the captured final message + the role's designated artifact. For a
   branch-owning role, integrate the returned branch through the **same Guardian
   → Observer → merge gate** path (§3). A no-worktree role returns only its
   inspection/verdict artifact and has no branch to integrate.

- **Provider account.** Each provider runs under its own account/plan; provider
  terms and billing are the operator's responsibility (Garelier makes no billing
  claim). Mixing Claude and Codex dispatched roles in one Dock-orchestration round is expected
  and fine.
- **Shape.** A Codex dispatched role is a headless one-shot (own context per
  invocation), not a rich in-session subagent — adequate for run-to-completion
  role work; coordination still flows through the runtime files + this integration
  step.

## 2d. Explicit provider-session resume (W-146)

An attended PM or Dock may send a compact follow-up to a recorded external CLI
session from either a Claude Code or Codex parent surface. The parent provider is
irrelevant: `provider_session.ts` reads the record's provider and resumes **that
exact session id**. It never chooses a recent session and never starts a fresh one.

`dispatch_provider.ts` writes `<result-dir>/session.json` by default (the
prepared launch commands pass `--session-record` explicitly). The response
adapter consumes Codex JSONL `thread.started.thread_id` or Claude's explicit
JSON session id; the common path records canonical worktree/git-dir identity and
marks the record `ready` or `failed` atomically.

Garelier's normal Claude-dispatched roles use Agent/Workflow and do not expose a Claude CLI
session id. For a deliberately headless Claude launch, execute the
`dispatch_prepare`-emitted `dispatch_provider.ts --provider claude-code` command unchanged;
never reconstruct a raw provider command. The helper uses a fixed,
non-confidential `-p` query, pipes the exact prompt file via stdin, validates the
returned explicit session id, and atomically records that id plus the resolved
model/effort/source route identity and canonical worktree:

```bash
bun <core>/driver/src/scripts/dispatch_provider.ts --provider claude-code \
  --worktree <wt> --prompt <prompt-file> --result <session-dir>/result.md \
  --session-record <session-dir>/session.json \
  --model <resolved-model> --effort <resolved-effort> \
  --model-source <resolved-source>
```

To follow up, write only the new compact instruction to the emitted `resume_instruction_file` or session `instructions_file`, then run the emitted `resume_cmd` unchanged because it supplies record/instruction/result/worktree/routing plus canonical `--project` / `--pm-id` / execution / `--role` / `--slug` / binding flags and no hand-written equivalent is supported.

The helper validates schema/provider, an explicit non-option session id, canonical
worktree path, git-dir identity, and exact PM/Dock-authoritative model/effort/source
parity before provider spawn. A per-provider/session PID lock rejects a
live concurrent resume and reclaims only a verifiably stale owner. Provider
commands are helper-owned: Codex uses `codex exec resume <id> -`; Claude uses a
fixed non-confidential `-p` query with explicit resume id/model/effort and pipes
the exact instruction file via stdin. Operators run the emitted
`provider_session.ts resume` helper and never reconstruct raw provider argv. `--last`,
`--continue`, arbitrary provider arguments, and silent fresh fallback are not
supported. Missing/invalid/expired records write machine-readable
`fresh_dispatch_required` metadata to the requested result path; busy and
retryable launch failures write `retry_explicit_resume` metadata.

Official Codex evidence: the non-interactive-mode reference documents both
`codex exec resume --last <prompt>` and exact `codex exec resume <SESSION_ID>`;
the installed CLI's `codex exec resume --help` additionally confirms that `-`
reads the follow-up prompt from stdin. Source:
<https://learn.chatgpt.com/docs/non-interactive-mode.md#resume-a-non-interactive-session>.

## 2c. Declared touches / depends_on + the conflict check (W-053)

When fanning out **parallel** dispatched roles, declare each dispatch's file scope so
the mechanical check catches collisions the Dock/PM would otherwise judge by eye
(the measured hand-work: W-073/W-074 were serialized by hand because both edit
`stage_transition.rs`; the garelier repo hit a PM commit clashing with an
uncommitted worker change). Two optional `dispatch_prepare.ts` flags:

- `--touches '<glob>,<glob>'` — the path globs this dispatch expects to edit.
  **SINGLE-quote the value** (`--touches 'docs/**'`): unquoted or double-quoted
  glob chars can be expanded by the invoking shell against the cwd BEFORE
  `dispatch_prepare.ts` sees them, so the value arrives as stray positionals and
  fails with `unknown arg: docs/engine` (W-054). Write the **narrowest** set that
  is still honest: concrete files (`core/recipe/filter.rs`) and directory globs
  (`core/recipe/**`) are both fine; a bare `**` declares "touches everything" and
  will conflict with every other dispatch. The blueprint package's / assignment's
  **Touches** field is the source — PM writes it once, Dock copies it into
  `--touches`.
- `--depends-on '<slug|#id>,...'` — prior dispatches this one should follow
  (single-quote it too, same reason).

At dispatch time the new touches are intersected with every **active**
`_crew/dispatch*/context.json`'s touches (a simple prefix + concrete-basename glob
heuristic — deliberately false-positive-leaning: a spurious "might collide" costs
a glance, a missed one costs a mid-integration clash). An overlap, or a
`--depends-on` dispatch that is still in-flight, prints a `[conflict_check]`
**warning** to stderr and lands under the output JSON `conflict_check` key
(`{touches, depends_on, conflicts:[{dispatch,slug,overlapping}], unmet_deps,
warning}`). It **never blocks** — the attended PM keeps the call:

- **Serialize** — wait for the in-flight dispatch to merge, then dispatch this one
  off the updated `studio` tip (the safe default when both truly edit the same
  code).
- **Split** — narrow one or both dispatches to disjoint files so they can run in
  parallel (e.g. move the shared helper edit into one of them, or into a prior
  dispatch both depend on).
- **Intentional parallel** — when the overlap is benign (different regions of a
  large file, or you will integrate them serially and resolve by hand anyway),
  re-run with `--allow-conflict` to silence the warning.

The whole active landscape (each dispatch's touches / depends_on / who it
conflicts with) is also shown by
`contract_check.ts --pm-id <id> --stall-scan [--format text]` under `touch map:`,
so the PM can read the parallel-collision picture at any time, not only at
dispatch.

## 3. Integrate after it returns (Dock)
- Read the compact result + the referenced `report.md` (path, not body).
- Before spawning Observer / Guardian / Smith review work, prefer the wrapper
  `bun <core>/driver/src/review_gate_prep.ts --role <observer|guardian|smith> --project <P> --base <base> --head <head> --out-dir <container> [--assignment <assignment.md>] [--update-assignment]`.
  It writes `*_review_brief.json` and, for Guardian, a redacted
  `guardian_scan_draft.json` path. These are advisory orientation files only;
  verdict authority stays with Guardian/Observer/Smith and raw diff/report reads
  remain allowed.
- **Dock orchestration**: send the returned branch through **Guardian → Observer** per
  `observer_policy`. **Combined-reviewer profile (DEC-064 §2):** on a
  normal-risk merge, ONE reviewer subagent may run both lenses (security gate
  checklist + adversarial quality review) and emit both verdicts in one pass.
  Two separate agents remain REQUIRED when the diff touches protected paths /
  gate globs, dependency or license surfaces, or is CRITICAL-classified.
- Then file the merge request with ONE command — never hand-write the JSON
  (DEC-064 §1): `driver/src/scripts/merge_request.ts --project <root> --pm-id <pm>
  --branch <workbench-branch> --guardian <verdict> [--observer <verdict>]
  [--target-root <git-root>]`
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
- **Artisan Artisan route**: the Artisan already passed Guardian + Observer and integrated
  its `satchel` itself — just intake the report.
- **BLOCKED**: write the role's `answers.md` and re-dispatch, or escalate to PM.
- **Idle notification vs. a genuine stall (W-034)**: in attended Agent Teams
  dispatch, Dock may see an "idle" notification for a dispatched role that is still
  legitimately mid-build (DEC-091 cold builds run many minutes) — nudging or
  respawning it there wastes a nearly-finished implementation (live
  mis-diagnoses: 2026-07-02 and 2026-07-03). Before acting on an idle
  notification, run `bun <core>/driver/src/dispatch/contract_check.ts --pm-id
  <id> [--project <root>] --stall-scan [--format text]`: it scans every
  `WORKING` `_crew/dispatch<N>/` container and, only for one with zero commits AND a
  dirty checkout, reports whether a build/test process is still running on that
  checkout (`judgement: build-wait` — leave it alone) or not (`judgement:
  stall-suspect` — the genuine-stall case). It never mis-asserts on an
  unverifiable platform (`judgement: unknown`). Only on `stall-suspect` does it
  emit a ready-to-paste nudge; add `--handoff <N>` for a respawn-handoff prompt
  that preserves the stalled dispatch's partial worktree for the next dispatched role
  instead of discarding it.
  **Escalation (W-037)**: a PM does not have to manually re-run and eyeball
  this — the tool persists a per-dispatch judgement history
  (`runtime/dispatch/stall_scan_history.json`) across scans and, when the SAME
  dispatch stays `stall-suspect` with an UNCHANGED checkout diff across
  scans (real progress or a judgement change resets it), the item's
  `escalation` field steps `none` → `nudge` (default 10 continuous minutes,
  `--nudge-after <N>`) → `handoff` (default 25 minutes, `--handoff-after <M>`)
  with an `escalation_prompt` carrying the same respawn-handoff content
  `--handoff <N>` produces. `jig_tick` already runs `--stall-scan` every tick
  (`jig.md` §"Stall-scan vs. build-wait"), so a genuinely stalled
  dispatched role escalates on its own even with no PM watching.
- **Monitor-stalled / non-returning dispatched role (DEC-074)**: if a custom dispatched role ended its
  turn mid-gate against the run-to-completion rule (DEC-073 Part A) — its result
  reads like "I'll wait for the background build" with STATE still `WORKING` and
  uncommitted/ungated changes — recover **without losing its context** when the custom
  agent adapter supports explicit resume: send the stalled subagent a `SendMessage`
  (`to: <agentId>`). A stopped custom subagent resumes with its transcript. Agent
  Teams teammates are a separate adapter: no session-resume restoration; restart is
  a fresh respawn. **Fallback** (resume unavailable, or
  the subagent is unreachable): the Dock finishes the work itself —
  diff-verify the dispatched role's uncommitted changes, kill any orphan build process +
  clear `target/debug/incremental`, commit on the dispatched role's branch, run the gate
  solo, finalize the report — then proceed to review. Garelier does not enable or
  install provider capabilities by writing user/project settings.
- Update `runtime/manifest.md` and the role `STATE.md` so the Status Web reflects
  progress.

## 4. Dock orchestration loop

Each Dock iteration (the top Dock session):
1. From the blueprint / backlog, pick the ready assignments (respect priority +
   interest-file gating; don't re-dispatch in-flight work).
2. **Fan out dispatched roles in parallel via the Workflow tool** — one subagent per
   ready Worker / Scout / Smith / Librarian assignment (§2 prompt; dispatched roles
   `isolation: worktree`). Each runs to completion and returns
   `{STATE, branch, sha, report, blocked?}`.
   - **Heavy-compile lock (DEC-073 Part B)**: when a dispatched role's gate runs a heavy
     full workspace build on a RAM-bound box, the Dock
     holds `bun scripts/heavy_compile_lock.ts` for that dispatched role's lifetime
     (acquire before the dispatch, release on return) so the dispatched role's compile
     does not run in parallel with the async merge gate's test run (the merge
     gate holds the same lock around its own gate). Tune via
     `[heavy_compile] max_concurrent` (0 = off when builds are concurrency-safe).
     The lock QUEUE-WAITS rather than executing lockless (W-158: the former
     "fail-opens on timeout" behavior is retired — a waiter blocks and never runs
     unserialized) and self-heals via reclaim (pid-dead + idle + lease, W-024/
     W-156/W-169): a holder past `stale_minutes` (default 30) whose owner is not a
     live pid (the liveness probe is MSYS-pid-aware, W-169) and runs zero
     cargo/rustc is reclaimed with an audit line in
     `runtime/locks/heavy_compile/reclaim.log`, so a BLOCKED/orphaned hold cannot
     stall waiters for the full `lease_minutes`. A merge gate whose diff is
     data-only (`[merge_gate] data_only_paths`) runs no heavy build and does not
     take the lock.
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
view of the live dispatched roles — never hand-edit either. Record every lifecycle
event with one command (it appends the JSON line with correct escaping AND
regenerates the view):

```bash
garelier-core/driver/src/scripts/dispatch_event.ts --project <root> --pm-id <id> \
  --kind start --role "worker(#12)" --task "#12 reliable-resend repro"
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
  live *in-progress* list derives from `_crew/dispatch<N>/STATE.md` (and any
  non-IDLE role container) — structural truth, not bookkeeping.

## 5. Constraints
- **No agent-definition files**, no global `~/.claude/agents/` entries, no writes
  to the target repo root (the role is the shared read-only `garelier-<role>`
  skill; multi-project safe; removable).
- **No terminal bays / Monitor / Stop-hook wake** (DEC-052 substrate superseded).
- **Dispatched-role launch path (all detached roles) — MUST go through
  `dispatch_prepare`/jig.** Worker / Smith / Librarian / Artisan / Scout /
  Observer / Guardian / Concierge MUST be launched through
  `dispatch_prepare.ts` (or the jig, which calls it): that provides a recorded
  `start` event, the forward-supply `context.json`, and the canonical
  `label`/`name` (`<role>:<slug>` / `<role>(#<id>)`). It also chooses the role's
  branch/worktree or no-worktree read-only shape internally. A bare Agent / Task
  launch is not a dispatched-role path. A resume re-uses the same `<role>:<slug>` path
  (the jig warm-rework closure, DEC-082) — there is no separate resume step. A
  stray dispatch that skipped this path (orphan container / mislabel) is caught
  by the doctor dispatch-integrity check.
- **Dispatched role run-to-completion, foreground gates (DEC-073 Part A)**: a dispatched
  role runs its gate / build / test commands in the FOREGROUND and waits; it
  never offloads a blocking command to a Monitor / background task and ends its
  turn expecting a re-wake. There is no re-wake — ending the turn mid-work
  strands the task and leaves an orphan build process holding the worktree's
  `target/` lock (which starves the next compile and blocks cleanup). A long
  cold build is waited out, not backgrounded. This is `correct_operation.md`
  item 12; the Dock that detects a stranded dispatched role finishes the gate +
  commit itself or re-dispatches, and reclaims the orphan + worktree per Part B
  (heavy-compile lock) / Part C (cleanup sweep).
- **In-session subagents**: subagents are spawned from the interactive
  Dock (in the same session). Provider terms and billing are the
  operator's responsibility; Garelier makes no billing claim.
- **Token discipline (DEC-049)**: refs not bodies; compact returns; the
  Dock idles at ~0 tokens between dispatches.
- **Codex** is a separate path (`codex exec`); subagents are Claude-only.

## 6. Harness execution limits — bash timeout budget & the wake path (W-077)

Every dispatched role dispatch has to design around two hard limits, one documented and
one not. This is the official-research result (user decision, 2026-07-05).

**Documented — the bash-tool timeout ceiling.** From the Claude Code tools
reference (`https://code.claude.com/docs/en/tools-reference.md`, verified
2026-07-05):

> **Timeout**: two minutes by default. Claude can request up to 10 minutes per
> command with the `timeout` parameter. Override the default and ceiling with
> `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS`.

So a foreground command uses the host's effective default (officially 2 min)
and may request up to the effective ceiling (officially 10 min). If the resolved
default exceeds the resolved ceiling, the effective foreground value is capped
at that ceiling.
When a command reaches the ceiling the harness **kills the tool call** — not a
clean cancel; on Windows the killed `cargo`/`rustc` child has been observed to
survive as an orphan holding the worktree's `target/` lock (W-058/W-055 live
cases). A cold full-workspace build can exceed the default ceiling — which is
exactly why the dispatched role self-gate is **scoped** (DEC-091 / W-068) and the
authoritative whole-workspace compile is the merge gate's job on the
stall-immune main session.

**Provider behavior is substrate-specific (verified 2026-07-19).** A completed or
stopped custom Claude subagent can resume by explicit `SendMessage` to its agent
ID with the same transcript. Agent Teams teammates are a different adapter: no
session-resume restoration and no nested background subagent; restart is a fresh
respawn. A background Bash task has a task id/output and is cleaned up at session
exit, but Bash/Monitor tasks themselves have no session-resume restoration.
Top-level completion notification is useful transport, not a universal guarantee.
The durable ledger/startup scan remains authoritative.

**Timeout semantics — the exact picture (five easy misreads).** The ceiling and
the wake are two DIFFERENT things; conflating them is the recurring confusion.

|                  | foreground tool call | durable broker job |
| ---------------- | -------------------- | ----------------------- |
| **main/Dock** | host timeout may kill the tool call | one tracked single-flight broker emits pending work; startup scan recovers a lost notification |
| **dispatched role** | the **SAME** host timeout applies | role does not own ad-hoc background jobs; operator broker owns them |

1. **The timeout applies identically in a subagent and the main session** — it is
   a per-foreground-tool-call limit; nothing about "running it in a subagent"
   changes it. "A subagent gets a longer/looser timeout" is a misread. The real
   difference between the two rows is **continuity, not the ceiling**: the main
   session is re-invoked when its background job finishes, a subagent is not
   (observed, undocumented — the reason step 3 of the design exists).
2. **The durable broker is outside a foreground tool call's budget.** A brokered
   job keeps running — so an unbounded
   runaway (an infinite log write, a wedged build) happens HERE, past the timeout's
   reach. That is the gap the RUNAWAY watch (compensation A below) covers.
3. **Orphan children can survive the timeout kill.** The timeout kills the tool
   call but does not always kill the whole process tree — a `cargo`/`rustc` child
   has been observed to outlive the killed wrapper (Windows, 2026-07-04/05, 2
   cases), still holding the `target/` lock. The orphan check (watch wake message +
   worker self-check B below) exists because the kill is not a guarantee.
4. **A "rapid-fire" runaway is not stopped by the timeout at all.** The timeout
   bounds ONE command's hang; an agent that keeps issuing sub-ceiling commands
   forever is never tripped by it. That failure mode belongs to the behavior
   layer — `command_guard` (PreToolUse), the permission mode, and the
   roadmap-binding / per-iteration conventions — not to any timeout or watchdog.
5. **So the safety is three layers, not "the timeout has us covered":**
   - **foreground → the bash timeout** (bounds a single command's hang).
   - **background → the watchdog** (`dispatch_watch.ts` RUNAWAY: hard ceiling +
     output bloat, compensation A) — because background is timeout-exempt.
   - **behavior → guards / conventions** (`command_guard`, permission mode,
     roadmap-binding; plus the orphan + self-check of compensation B) — for
     rapid-fire loops and surviving orphans that the first two layers do not bound.

**The design.** Ordered so the simplest, most robust option is the default:

1. **Dispatch reads the budget and forward-supplies it.** `context_pack.ts` emits
   `bash_timeout_budget_ms` into `context.json` (the effective ceiling; read order
   below). The dispatched role reads it — **it never guesses the limit.**
2. **In-budget job → foreground to completion.** A gate/build/verify that fits
   inside `bash_timeout_budget_ms` runs in the FOREGROUND and the turn stays alive
   until it returns (the run-to-completion rule, §5). No background, no wake.
3. **Over-budget job → durable ledger + one broker transport.** Preserve the
   unchanged helper/gate as one whole command. Arm durable ledger metadata first, store a
   safe command reference plus digest/cwd, then let the operator-owned broker
   launch it once. Five individual completions still produce one broker wake; the
   drain ACKs all five exact job-id/attempt pairs. FINISHED is read-only result
   consumption, never a rerun. FAILED/stale recovery audits pid/orphan, log, exit,
   cwd/worktree and digest into an attempt-specific hash manifest before explicitly
   rearming the same whole command. Ledger schema v2 pins canonical cwd identity;
   legacy v1 records fail closed as `BLOCK_LEDGER_PATH` until an owner-reviewed
   migration is performed outside the running recovery path. The ledger result +
   exact ACK are authority; operator watch / `SendMessage` are optional notifications.
4. **Timeout configuration is user/host-owned and read-only to Garelier.** The
   framework never writes either timeout setting, changes it, injects it into a
   child environment, or suggests raising it. Unavailable values use the official
   defaults and record that source.

Field evidence (2026-07-19): central gate #361 emitted a quality command whose
first executable was bare `bash`; it failed 127 with empty stderr before heavy
Cargo began. Retrying the unchanged whole command through resolved absolute Git
Bash with absolute Cargo started correctly. Operator-emitted commands therefore
obey the same absolute executable contract as direct driver spawns.

**Mechanized read order (W-077).** `context_pack.ts` resolves
`BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` independently, including
each effective value and source, with this precedence for each key: project local
settings → shared settings → process env → official defaults. The foreground
effective value is capped at the resolved ceiling. This is observation only; the
framework never writes, injects, or recommends changing either key. The dispatched role reads
`context.json.bash_timeout_context`; it does not re-derive or mutate the limit. The Worker SKILL §2 resilience bullet and
`pm_playbook.md` §3 carry the hot-rule pointers.

**Runaway compensation (W-077).** A brokered job can outlive a foreground tool
call, so the safety has to be supplied
on both sides — cheaply, not as a new framework.

*(A) Before waking — the operator/watch runaway verdict.* `dispatch_watch.ts`
adds a `RUNAWAY` verdict from cheap signals only:
- **Hard ceiling** — `BUILDING` for `--max-building-windows` consecutive windows
  (default 3; a per-branch counter under `runtime/dispatch/watch/` survives across
  the operator's re-invocations and resets on any non-BUILDING verdict). A healthy
  cold build should have committed by then, so the operator **process-group-kills
  the dispatched role, marks the job FAILED, and does not keep waiting on infinite
  BUILDING**.
- **Output bloat** — an opt-in `--output-file <path>` that grows past
  `--max-output-mb` (default 100) with no STATE/report progress = a job writing
  without advancing (the log-fills-the-SSD precedent). Same kill+FAILED response.
- **Orphan after exit** — when the operator kills a runaway (or the target process
  exits) it checks the poll lines' `compile_procs` for surviving descendants
  (`rustc`/etc.) and includes "orphan present — kill before re-dispatch" in the
  wake message.

*(B) On waking — the worker self-check (before trusting any result).* A woken
worker runs a cheap checklist as its FIRST action, and treats any runaway trace as
a reason to distrust the output — never to mask it:
1. **Real exit code + log tail** — read the job's actual exit status and the tail
   of its log; do not trust a wrapper's `exit 0` (a trailing `echo` can swallow a
   real failure — `debugging_discipline.md` §5).
2. **Orphaned processes** — check for its own job's surviving build procs and kill
   them (they hold the `target/` lock and starve the next compile).
3. **Output/log size sanity** — an abnormally huge log/output is a runaway trace;
   do not trust a "success" produced alongside it.
4. **Worktree integrity** — the checkout is in the expected state (no partial
   write / corruption) before building on top of it.
All clean → proceed to commit/report. Any runaway trace → **report it honestly
(do not mask the result) and escalate to PM** rather than committing a suspect
build.

**Agent Teams — official spec (W-077) [official spec].** Per the official
docs (`https://code.claude.com/docs/en/agent-teams`, the `/agent-view`
command, and the CHANGELOG `v2.1.178`–`v2.1.199` range; verified 2026-07-05):

- **Wake = `SendMessage` only** — broadcast wake was dropped from the
  product. As of `v2.1.198`, messaging a stuck teammate wakes it to retry
  immediately; a teammate that dies on an API error reports **"failed" to
  the lead**, and the operator treats a "failed" report as an immediate
  respawn trigger. **Silent dormancy remains the watchdog's job** — a loud
  "failed" and a silent stall are two different failure modes handled by two
  different mechanisms (division of labor); do not conflate them.
- **State observation is push-only** — there is no pull API for the lead to
  query a teammate's state; it only ever receives an idle notification or a
  failed report. The human user's official view is the **panel icons**:
  **Working** (animated), **Needs input** (yellow), **Idle** (dimmed),
  **Completed** (green), **Failed** (red). **Idle ≠ dead**: an idle teammate
  stays running and addressable — its row just hides from the panel after
  30s of idling and reappears on its next turn.
- **Teammates are NOT restored by `/resume`** (an official limitation, not a
  Garelier gap) — after a session restart, recovery is a **fresh respawn**
  from the worktree/`STATE.md`, never a wake attempt at a teammate that no
  longer exists. One team per session; no nested teams; the lead is fixed
  for the session's lifetime.

**DEC-073 × over-budget exception, reconciled (W-077).** detach-and-end-turn
remains **forbidden by default** (DEC-073 Part A — never end a turn on a
backgrounded blocking command expecting an automatic re-wake; there is
none). The **sole exception** is the over-budget path above (**P2** — design
step 3: hand the unchanged helper command to the durable single-flight broker
after arming its ledger entry; P1 is the in-budget foreground path of design step 2).
This split is not just convention: **an in-process teammate cannot itself run
a background subagent** `[official spec]` — a teammate's background work
can't outlive the lead's process — so the over-budget job is necessarily
owned by the operator/lead, never backgrounded by the dispatched role itself.
Before returning under P2, the dispatched role must **register** the brokered job
in the durable ledger with its command reference, log/result path, completion
criteria, and resume point (see compensation (B) above). A STATE.md note,
operator watch, or `SendMessage` may notify humans/Agent Teams, but is optional:
lost notification does not change authority, which is the ledger result + exact
job-id/attempt ACK. Without ledger registration and broker ownership the job is
an unrecoverable orphan, not a sanctioned P2 case. This is the
same exception `garelier-worker/SKILL.md` §2's "commit gate-passed work
before a flaky verify" bullet now states against its own `run_in_background`
line — keep the two in sync.

**Anomaly taxonomy — one vocabulary for both watchers (W-071).** `dispatch_watch.ts`
(single + `--fleet`) and `contract_check.ts --stall-scan` classify dispatched role health
with ONE set of terms, so a PM reads a single vocabulary instead of reconciling two
tools' words (the "2 tools / 2 taxonomies" confusion). Progress is git-observable
only — a new commit, or a moved STATE.md/report.md content hash; the clock that
separates these resets ONLY on that, never on a bare liveness ping or a file mtime
(the reset rule, `pm_playbook.md` §11).

| Term | Meaning | `contract_check --stall-scan` | `dispatch_watch` |
| ---- | ------- | ----------------------------- | ---------------- |
| **PROGRESS** | a new commit landed (HEAD advanced past the baseline) — the dispatched role is finishing | a moved `tip_sha` resets its clock | `RESULT: PROGRESS` |
| **ADVANCING** | no new commit, but the seat's write destination advanced — STATE.md/report.md content OR its checkout worktree (dirty-file count / file mtime). The checkout counts for EVERY seat: a role can edit for a whole window without committing and without touching the container | a moved `dirty_hash` resets its clock | `RESULT: ADVANCING` |
| **BUILDING** | flat fingerprint, but a build/verify process is live — a cold build, not a stall | `judgement:"build-wait"` | `RESULT: BUILDING` |
| **STALLED** | flat for one window, no build, PAST the spawn/resume grace, and the lane has NOT declared completion — suspect; warm-resume / re-dispatch | `judgement:"stall-suspect"` or `"post-commit-stall"` | `RESULT: STALLED` |
| **DECLARED-DONE** | the lane declared `STATE=REPORTING` / `STATE=BLOCKED`. A finished lane stops committing and stops touching its tree, so a flat window is the EXPECTED shape — do NOT warm-resume or re-dispatch. Remaining aftercare is to gate the result and process its register. Read from `lane/result.md` when a provider result exists (both providers, CLI transport), else from the STATE.md heading (Agent-tool transport) — so the suppression is the same for either launch path | `judgement:"ungated-reporting"` for the REPORTING case | `RESULT: DECLARED-DONE` |
| **SPAWN-GRACE** | flat, but still inside `--spawn-grace-sec` of the container's `dispatched_at`/`resumed_at` (or its transcript is still being written): the role is READING/THINKING and has not had time to produce anything. Not a stall — re-arm; STALLED can only be asserted once the grace has elapsed | reclassified to `judgement:"build-wait"` | `RESULT: SPAWN-GRACE` (re-arms the next window) |
| **RUNAWAY** | a safety trip — hard-ceiling BUILDING windows, or output-bloat with no progress — kill + FAILED (W-077) | — | `RESULT: RUNAWAY` |
| **REVIVE-NEEDED** | sustained dormancy: flat past the stall threshold with no build — the dispatched role is DEAD. Respawn FRESH from the worktree; do NOT wake (a `/resume` does not restore an in-process teammate — official) | `escalation:"revive"` (>= `--revive-after`, default 30min) | `RESULT: REVIVE-NEEDED` (`--fleet`) |
| **IDLE-NO-REGISTER** | idle but the PM never processed its register (no `register_received` marker): REPORTING = done-but-unregistered, or a WORKING idle stall. A WAKE, not a respawn — wake it to send the register (a gate role: its verdict register), then touch the marker (W-018) | `idle_no_register:[{dispatch,state,role,kind,wake_cmd}]` (each with a ready-to-send wake body) | `RESULT: IDLE-NO-REGISTER` (single, needs `--id`) |

STALLED is one flat window; **REVIVE-NEEDED** is a STALLED that stayed flat past the
dormancy threshold — so a truly dead dispatched role is respawned, not nudged forever. The
two watchers divide the labor: `dispatch_watch --fleet` is the durable, project-
agnostic sweep of EVERY WORKING/REWORK + ungated REPORTING dispatch under a pm-id in
one process (drains to `exit 0`); `contract_check --stall-scan` adds the
per-checkout-scoped build probe, the ungated-REPORTING (W-086) blind-spot check, and
the wall-clock **session-resume** detector (a large gap since the last scan means the
fleet went unwatched — respawn, not wake). This is the same division as the
push-signal split above: a loud API-death "failed" report is an immediate respawn
trigger, silent dormancy is the watchdog's REVIVE-NEEDED (`pm_playbook.md` §11).

**Register-terminate the final turn — a commit/STATE update is not a completion
signal (W-085).** A dispatched role is run-to-completion: once its turn ends it gets
NO further turn until an external message arrives (there is no automatic re-wake —
above). So the **last turn MUST end with the compact register message** — the §2
final-message contract: final STATE, branch + commit SHA (dispatched roles), report path,
gate result, any BLOCKED question. Committing the work and updating STATE.md/report.md
but then ending the turn **without sending that message** leaves the operator/PM with
**no completion signal**: the work is done, but to every watcher it is indistinguishable
from a silent stall (the §6 taxonomy, `dispatch_watch.ts`, `contract_check.ts
--stall-scan` all read "flat + silent" as STALLED/REVIVE-NEEDED). A fleet of dispatched roles
that fell silent this way after finishing stalled a whole night's run undetected
(2026-07-06). The register message is the ONE thing that says "done — gate me," so do
not fall silent after the last commit: send it, and let it be the turn's final act.
This applies to **every** dispatched role, including the operator's own workshop
subagents (the same rule the dispatch prompt / `context.json` note now carries).

**The register message is the canonical record — report.md is a mirror of it
(W-019).** In live runs a dispatched role often CANNOT write `report.md` (the harness
blocks the write, or the turn ends on the register before the file is saved), and
the archived report is left as the untouched dispatch scaffold while the real
outcome lives only in the compact register message — a two-ledger split that made
the Observer note a missing report on nearly every dispatch. Resolve it by treating
the **register body as canonical**: write `report.md` when you can, but do not block
completion on it. When the harness prevented the write, the PM saves your register
text to a file and runs `dispatch_cleanup.ts --report-from-file <path>` (or
`merge_land.ts` forwards it), which transcribes that text into `report.md` before
archiving — so the single archived record is your register, not an empty template.
Either way there is exactly ONE canonical record; never re-narrate the outcome in a
second place.

**PM side — mark the register processed (W-018).** When the PM processes a
dispatch's register (reads it, moves it into the gate/merge pipeline, or otherwise
acknowledges it), it touches `_crew/dispatch<N>/register_received`. That marker is the
suppressor for the **IDLE-NO-REGISTER** detective: `contract_check.ts --stall-scan`
reports every idle dispatch WITHOUT the marker under `idle_no_register` — a REPORTING
dispatched role whose register never arrived (done-but-unregistered), a WORKING idle stall,
or a gate role with no verdict — each with a ready-to-send `wake_cmd` (the target
Agent name + a state-specific wake body) so the PM wakes it without hand-writing the
message. `dispatch_watch.ts` (single, `--id`) surfaces the same as `RESULT:
IDLE-NO-REGISTER`. It is a WAKE, not a respawn: the dispatched role is done or reachable, not
dead (contrast REVIVE-NEEDED). Advisory — it never flips the scan's `ok`.

**Consume the instruction ledger before REPORTING (W-092).** Your container holds an
append-only **`instructions.md`** ledger. The PM appends an `[[instruction]]` table
entry every time it sends you a mid-flight instruction (a scope change), so an
instruction can't be lost when its message crosses your completion register (the
live class: a PM scope-expansion arriving as you finish, dropped unconsumed — 4
cases 2026-07-06). **Before you reach REPORTING**, open `instructions.md` and check
off EVERY entry: set that `[[instruction]]` table's `checked = true` and add
`consumed = '''<commit SHA | "register">'''`, actually doing the work each names. The
value is a TOML string, so parentheses, backticks and newlines need no escaping and
no evidence ever has to be reworded for the parser. Do NOT flip STATE to REPORTING
while any entry is still `checked = false`; state **"ledger N/N consumed"** in your register
message. A REPORTING dispatch with an unchecked entry is flagged by
`contract_check.ts --stall-scan` as **UNCONSUMED-INSTRUCTIONS** (advisory) and sent
back to consume it. When the ledger holds no `[[instruction]]` table at all, there is nothing to consume — say "ledger 0/0".

### §6(C) teammate idle_notification の扱い [official spec + 既知 issue]

- idle notification は teammate の turn 完了時に自動配信される（公式:
  `code.claude.com/docs/en/agent-teams.md` の "idle notifications: when a
  teammate finishes and stops"）。抑制する公式設定は現状存在しない。
- **同一内容の重複配信は既知バグ**
  （`github.com/anthropics/claude-code/issues/47930` — lead が idle ack だけで
  大量 turn/token を消費する報告あり）。仕様ではない。
- **PM/lead 規約**: bare idle ping（register や内容を伴わない
  idle_notification のみの受信）は **no-action** — 応答・状態遷移・timer
  reset の根拠にしない（進捗 evidence は git fingerprint が正、
  `dispatch_watch`/`contract_check --stall-scan` の判定と同じ）。作業中
  worker への影響が疑われる時のみ evidence check（tip/dirty/procs）を行う。
- upstream 追跡: 抑制 env（`CLAUDE_CODE_TEAM_LEAD_SUPPRESS_IDLE`、提案段階・
  未実装）が実装されたら採用を検討 — `[observation]` tag で将来 version の
  release note を確認。
- **例外 — durable long-job pending protocol (W-146)**: bare idle ping は従来どおり
  no-action。PM が動く根拠は `runtime/long_jobs/` の FINISHED/FAILED-not-ACKED と
  broker の `LONG-JOBS-PENDING` だけ。result/log を読み exact job-id+attempt を ACK
  する。notification が失われても wake lease と startup scan が再通知する。
- **`--command-ref` の置き場**: `long_job_runner.ts arm` は command payload file が
  **ledger root (`runtime/long_jobs/`) の内側**に在ることを要求する。
  そこに payload 用の sibling directory を作ってよい
  (`runtime/long_jobs/commands/<job>.cmd` 等) — **job の分母は
  「job artifact (`record.json` / `job.log` / `exit.json` / `.done` / `ack.json` /
  `result.json` / `retirement.json` / `attempt-audits`) を 1 つ以上持つ dir」**であって
  「ledger root 直下の dir すべて」ではないので、payload dir が偽 job にならない。
  job artifact を持つのに `record.json` を欠く dir は従来どおり BLOCK する
  (部分削除で job を隠せない)。ACKED の job は payload file の実在を要求しない —
  再実行する経路が無く、実行した command の identity は record の `command_digest`
  に残るため。**provider に依らず同一** (ledger は席の provider を読まない)。

## Validated (2026-06-08, live)

- Single role roundtrips: a **Scout** (read-only inspection) and a **Worker**
  (`studio` → `workbench` → implement → gate → commit → return) each completed
  and returned — no agent-definition files, no wake, no deadlock.
- Dock orchestration loop: **2 Worker subagents produced on `workbench/*` branches in
  parallel** (each in its own worktree off `studio`, gate-pass), and a **Dock
  subagent integrated both into `studio`** (`--no-ff`, clean). ~4 agents, ~85k
  tokens. Ran as in-session subagents from the interactive Dock.

## Dispatch declaration axes

`--resource-class`, `--heavy-tier`, and `--touches` are declared once at
`context_pack` / `dispatch_prepare` time and read by every later stage. The
canonical statement — the `check` vs `codegen` table, the exact stderr warning an
undeclared heavy dispatch prints, the `--mode progress` / `--mode probe`
distinction for a multi-turn slot hold, and the three uses an empty `touches`
silently disables — is [`dispatch_env.md#dispatch-declaration-axes`](dispatch_env.md).
No copy is kept here.
