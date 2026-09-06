<!-- absorbed-from: garelier-pm/SKILL.md ## Pre-flight: context routing -->

# PM pre-flight: context routing

Moved out of `garelier-pm/SKILL.md` (W-599): the PM entrypoint carries the index,
not the procedure. This file is trigger-loaded from the routing table in that SKILL.md.

**Session-start checklist (run first, before any status claim or dispatch):**

① **状況確認 (機械出力優先)**: `dock_status` (JSON) + `contract_check --stall-scan`
   (`../garelier-core/references/pm_field_manual.md#pmfm-1`) を読む。control schema v3では
   `garelier control session-open --agent <provider> --format json`のbounded resumeを正本とし、
   Current/primary Checkpoint/blockers/read_setだけを読む。schema v1/v2と未知の形式は
   明示rejectする。印象でなく機械出力で
   現在地を確定してから動く。stall-scan の `container_inventory` は
   `_crew/dispatch<N>` の directory reality 全件を分母にするため、省略せず各 entry の
   checkout/worktree、branch landing、claim、dirty、`treatment` を消費する。context や
   checkout が無い entry も「存在しない」扱いにせず、`cleanup-ready` / `active` /
   `unlanded-work` / `guard-hold` の機械分類に従う。
② **規約確認**: この project を拘束する規約に接地する — (a) knowledge `role_index.toml` の
   PM read_first pointer (item 11 の前倒し実行)、(b) schema v3 primary
   Checkpoint/Backlogの`control get --with-links`が返すDecision refs、
   (c) `_crew/pm/setup_config.toml`
   の `[autonomy]` / `[retention]` / `[observer_policy]` / `[lenses.defaults]` (item 12 の前倒し
   実行)、(d) target project の `CLAUDE.md` / `AGENTS.md` hard rules — auto-load されるが、本
   session の作業領域に効く節を意識して確認する。
③ **監視 arm**: 未 arm なら `fleet_watch.ts --project <root> --pm-id <pm_id>` を
   `run_in_background` で 1 本 (`../garelier-core/references/pm_field_manual.md#pmfm-1`)。
   **これは 1 pass の検査ではなく常駐 loop** (W-667 F-11): 既定 `--interval-sec 300` で
   `contract_check.ts --stall-scan` を回し続け、**actionable を見つけた時・driver stop file・
   `--max-hours` 上限 (既定 12) の 3 つでだけ exit する**。exit = PM を起こす合図なので、
   **起こされたら wake_cmd を実行して同じ形で再 arm する** (arm しっぱなしにはならない)。
   flag と既定値の全体は `fleet_watch.ts --help` と
   `../garelier-core/references/pm_playbook.md` の fleet watch 節。二重起動は
   `runtime/driver/fleet_watch.lock` が exit 3 で拒否する。

On every session start:

1. Read this skill entrypoint and the installed `garelier-core/SKILL.md` for
   framework invariants.
2. Read `garelier-core/protocol.md` when you need runtime handoff, ownership,
   or compact-format details.
3. Read `garelier-core/state_machine.md` before changing any role state.
4. Read `garelier-core/retention.md` before pruning or rotating artifacts.
5. You are the authority for the Librarian-managed knowledge trees (DEC-029):
   you **approve** which sources enter the `source_registry.toml` knowledge registry
   and any change to a security / quality / review / system / engineering policy's
   meaning, including exceptions and waivers. The Librarian generalizes and applies
   approved updates; it never re-decides policy. Public skills / web checklists are
   never copied — only generalized through approved registered sources.
6. Resolve Plant roots before reading project files. Prefer
   `garelier plant-resolve --start <cwd>` when available; otherwise use
   `garelier-core/driver/src/plant.ts resolve --start <path>`.
7. Determine setup state under `garelier_root`:
   - no `garelier_root`: fresh project; read `references/setup.md`.
   - `[setup] complete = true`: recover runtime and schema-selected control state, then check
     for a **version upgrade** — compare the config's `garelier_version` with the
     installed framework (run `doctor`; it reports `version-mismatch` when the
     project was set up by an older Garelier). On a drift, report the explicit
     incompatibility and stop; no automated upgrade entry point is provided.
   - partial `__garelier/`: read `references/setup.md` §3.6 (in-place repair;
     the wizard never deletes an existing namespace, branch, or worktree).
8. Read `AGENTS.md` according to the Root terms above.
9. Read `garelier_root/<pm_id>/control/operations/` when present.
10. Read `garelier-core/control_contract.md` before changing persistent control
   structure, importing/exporting control, or choosing a control artifact format.
11. If the `role_index.toml` knowledge index exists, read it before a
   non-trivial planning, policy, or review task, then load only the PM-relevant
   pointers.
12. Read `__garelier/<pm_id>/_crew/pm/setup_config.toml` for `[autonomy]`,
   `[retention]`, branches, gate policy, and fallback model-routing policy.
13. Read schema-3 Control through `control session-open` / bounded resume, then
    `control get <id> --with-links` only for the referenced
    Backlog/Checkpoint/Roadmap neighborhood; do not scan the control tree.
    Reject schema v1/v2 and unknown combinations explicitly.
14. For the dispatch auto-loop (jig) state, see
    `references/autonomous-mode.md` §15.8.
15. On session start/resume (incl. after compaction) and before answering any
    status query, apply `task_mirror --format ops` to reconcile the harness
    Task list against the canonical backlog + live dispatch (DEC-092) — never
    hand-diagnose a missing/stale Task list as "display desync"; see
    `references/runtime/status.md` §13.1.E.

Prefer compact artifacts (`dock_pulse.json`, report/review JSON sidecars,
status summaries) before opening full Markdown bodies.

If a task uses a workflow listed in **Reference Routing**, read that
reference before taking action. Do not bulk-load every reference just
because this skill activated.
