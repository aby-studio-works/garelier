<!-- absorbed-from: garelier-pm/SKILL.md ## Critical Invariants -->

# PM critical invariants

Moved out of `garelier-pm/SKILL.md` (W-599): the PM entrypoint carries the index,
not the procedure. This file is trigger-loaded from the routing table in that SKILL.md.

- **Gate prompt / task file は blueprint の transport であって第 2 の正本ではない（W-451、絶対遵守）。**
  禁止される背景 / Gate 重点 / role 要約 / 新判定基準と、機構が生成する canonical section 集合は
  `../garelier-core/references/gate_field_manual.md` §A-0 が唯一の human-readable 正本である。
  この SKILL や個別 prompt に列挙を複製しない。伝えたい判定基準が増えたら dispatch 前に
  blueprint を直す。走行中は bound blueprint を変えず、land 後の統合対象にする。
  **機械が拒否するのは機構専有 2 見出しと field 形だけ (W-708 / DEC-100 段 0)** —
  `dispatch_prepare.ts --prompt-file <path>` と `--task-file <path>` は
  `driver/src/dispatch/prompt_section_contract.ts` を共有し、PM 入力に
  `## Role source pointers` / `## Task` が現れたら blueprint path 付きで refuse し、
  `## Review SHA` / `## Dock gate` はその見出しが在る時に field 形を検査する。
  **それ以外の `##` 見出しの追加は refuse されない** (旧形の閉じた allowlist は退役)。
  したがって「blueprint を prompt へ複製した」の判定は見出し名ではなく**中身**で行い、
  gate 役が §A-0 の手順 1-5 で BLOCK する。`dispatch_prepare` の `prompt_skeleton` に未検査の
  task-specific prose を手で追記してはならない。
  **prompt 源の無い normal dispatch は副作用の前に refuse される (W-667 F-1)**: `--task-file`
  も `--pipeline-package` も無い normal dispatch は claim / container / worktree を作る前に
  exit 4 になる (旧挙動 = 全部作った後に `spawn_directive = BLOCK` を返す)。`--reuse` /
  `--rework` / recovery は既存 container の assignment.md を継続するので対象外。
  **acceptance が `- [ ] Define acceptance.` 1 行だけの row も同じ位置で refuse される
  (W-666)** — `control backlog update <id> --set-acceptance ...` で AC を入れてから dispatch する。
- **managed detached role = `dispatch_prepare.ts`; control-repo isolate =
  `workspace_isolate.ts`; explicit PM-directed lightweight exception =
  `dispatch_prepare.ts` + its `attended_record.ts` permission record.** Gate seats
  receive their no-worktree shape inside `dispatch_prepare.ts`; `attended_record.ts`
  records command-guard authority for the explicit attended exceptions and is not
  a managed detached-role launcher. Never reuse the legacy gate-only
  `attended_record` + bare Agent pattern for a
  commit-bearing role (worker/smith/librarian/artisan) — it skips dock
  tracking and the isolated worktree, and the PM ends up editing the studio
  tree directly with no container (live incident, W-139, 2026-07-18). A
  role-profile `attended_record` is a sanctioned PM-directed-route exception
  ONLY when its `--worktree` IS an existing `dispatch_prepare` checkout or
  `workspace_isolate` isolated worktree; `contract_check.ts --stall-scan` flags any other
  case as `BYPASS-SPAWN`. Third case (W-155/DEC-093): `attended_record.ts
  --pm-direct` writes an `execution_route: "pm-direct"` record (plus the legacy
  `lane_kind` compatibility alias) that declares the PM-directed lightweight
  route — `--stall-scan` then surfaces that seat as ADVISORY (visible so you can
  see your PM-direct seats) and does NOT flip the scan to fail, unlike an
  UNDECLARED role `attended_record`, which stays a hard `BYPASS-SPAWN`
  (advisory=false) that flips ok. Declare the route so a legit PM-direct seat is
  never misread as a bypass. See
  `../garelier-core/references/attended-gate-dispatch.md`.
- **Launch every detached managed role through `dispatch_prepare.ts`
  (W-168/W-424).** Use `--provider codex` for `codex exec` or `--provider claude-code`
  for the configured Claude transport. The dispatcher creates the canonical
  permission record, role-seat binding, prompt, result path, and provider
  command, then internally selects a linked worktree for Worker, Smith,
  Librarian, Artisan, and Concierge or the no-worktree read-only route for
  Scout, Observer, and Guardian. Do not hand-make a seat or invoke a raw child
  launch. Wanderer remains a separately launched external session under
  DEC-076 and is not a managed detached seat. For Concierge operations, repeat
  `--approved-remote <name>=<url>` for each exact PM-approved destination; the
  dispatcher also preserves the clipboard branch and `external.lock` guards.
  `dispatch_prepare.ts` is the single entry point for managed detached roles and
  explicit PM-directed lightweight Claude seats.
- Keep `control/` persistent and `runtime/` transient. Do not treat the
  runtime manifest or generated views as control authority.
- For schema v3 only, Backlog/Roadmap/Milestone/Checkpoint/Note records, Current,
  typed relations, archives, and Gate records are canonical; the tracked
  Dashboard combines curated authority with marker-bounded generated indexes.
- In schema v3, create/update Roadmap, Milestone, Backlog, Checkpoint, Note,
  Blueprint, and Decision Markdown from canonical templates and validate the
  whole graph; transition Decision/Blueprint status only through `control
  transition decision|blueprint` with a session and expected Control revision.
- The canonical integration branch is `studio`; the user's branch is
  `target`; Worker branches are `workbench`; Smith branches are `anvil`.
- **A high-stakes design gets an independent design-review BEFORE you dispatch
  the work it produces (DEC-076).** High-stakes = a migration, a protected path,
  a new top-level key, a large diff, or an architecture / policy change (the same
  triggers the merge gate mechanizes). Route it through a **Wanderer**
  (user-opt-in; never self-launched) or, on its absence / rate-limit /
  fallback-to-Observer, an **Observer** subagent, iterate to a passing verdict,
  and record the reviewer + verdict in the blueprint's `## Review sign-off`
  footer before dispatching.
  Trivial designs skip it — this is **not** a tax on daily dispatch. Triggers,
  the review command, sign-off fields, and full procedure:
  `references/planning/blueprint-authoring.md` §4.
- When launching a subagent with the Agent tool directly (attended, no
  driver), its `name` is `ga-<step>-<slug>` — use `dispatch_prepare.ts`'s
  emitted `agent_name` verbatim for a role; see
  `../garelier-core/references/workflow-naming.md` §5.
- **The Agent tool call MUST set `model:` to the model `dispatch_prepare.ts`
  emitted** (`model` for a role, `gate_agents.guardian.model` /
  `gate_agents.observer.model` for a gate) — see the JSON's own
  `spawn_directive` field. Omitting `model:` is not a safe default: the
  Agent tool silently inherits the PARENT PM session's model instead, with
  no error (W-049; target project 実戦 2026-07-11, a worker + four gate subagents ran
  at the PM's own model this way). Verify `../garelier-core/references/attended-gate-dispatch.md`
  and `../garelier-core/references/pm_field_manual.md#pmfm-6` before spawning.
- **Per-task routing is authoritative.** Pass `--provider`, `--model`, and
  `--effort` for the task being dispatched. Fixed role metadata is never a
  provider/model fallback; when task flags are absent, blueprint hints and
  `[model_routing]` apply in that order.
- Use compact handoff for role-to-role runtime files.
- For a user-requested cleanup that should restore work to the backlog,
  use retire-and-requeue, not an aborted terminal state.
- Before arming the dispatch auto-loop after a crash or interruption, run
  the cleanup audit in `references/runtime/cleanup-audit.md` §13.4.
- When the user asks for a role to stop receiving work, stop or retire-requeue
  the active task; do not create a fixed roster exclusion or delete role state.
- When the user asks to do something **first / urgently** (e.g. "investigate
  XXX with a Scout first"), dispatch that task first and — if adaptive provider
  availability or host pressure defers it — have an `urgent.md` marker written in that agent's container
  (DEC-031). It jumps the task above all launch tiers (FIFO among urgents) but
  never preempts a running agent: it takes the next free slot. It does NOT
  reorder the work itself; sequencing of multiple tasks stays in the backlog.
