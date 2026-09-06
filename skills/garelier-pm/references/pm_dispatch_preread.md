<!-- absorbed-from: garelier-pm/SKILL.md ## Role dispatch pre-read (MANDATORY) -->

# Role dispatch pre-read (MANDATORY)

Moved out of `garelier-pm/SKILL.md` (W-599): the PM entrypoint carries the index,
not the procedure. This file is trigger-loaded from the routing table in that SKILL.md.

Before writing a dispatch prompt, read the target role's field manual — not
just its SKILL.md:

| Dispatch する役 | 先に読む正本 |
| --- | --- |
| Worker / Scout | `../garelier-core/references/worker_field_manual.md` + 該当 SKILL.md |
| Guardian / Observer | `../garelier-core/references/gate_field_manual.md` + `../garelier-core/references/attended-gate-dispatch.md` |
| Smith | `../garelier-smith/SKILL.md` + knowledge `quality/integration_hardening_views.md` |
| Librarian | `../garelier-librarian/SKILL.md` + `../garelier-librarian/knowledge_contract.md` |
| Artisan | `../garelier-artisan/SKILL.md` |
| Concierge | `../garelier-concierge/SKILL.md` + knowledge `external_operations/` |
| provider=codex (どの役でも) | `../garelier-core/references/codex_worker_playbook.md` + `../garelier-core/references/provider_substrate_matrix.md` |

上表は「役」ごとの表で、provider=codex 行だけは役に直交する横断行 (Worker/Smith/Artisan いずれも
codex 席なら適用)。**`dispatch_prepare --provider codex` の JSON 出力に同梱される
`codex_knowledge.read_first` / `codex_knowledge.dock_gate_commands` (W-224) が機械的な最短経路** —
heavy build gate は codex 自身が取れない (sandbox は heavy_compile_lock を acquire 不能) ので
`dock_gate_commands` に列挙されたコマンドの実行者は常に **Dock 席**である。実行前に
`dispatch_prepare.ts --attended-seat --role dock` で Dock 席を外部発行し、その JSON の
`name` / `record_path` を `GARELIER_AGENT_NAME` / `GARELIER_DISPATCH_RECORD` として
`GARELIER_ROLE=dock` と共に `gate_runner.ts --from-register` へ渡す。runner 自身は席や permission
record を発行せず、外部 record が無い・不一致なら command 実行前に BLOCK する。PM 名義の実務面を作らない。
**codex prompt (手書き含む) に `heavy_compile_lock.ts` や `garelier-core/scripts|driver` への
直接呼び出しを書かない** — 別 repo なので sandbox から到達不能、`dispatch_prepare` はこの pattern
を検出すると fail-closed で BLOCK する (W-224)。

**register 受領から land までは 1 command (W-668)。** `land_pipeline.ts` が ack → report 転写 →
`review_prepare` → PM 選定 step → gate task file → gate 席 prepare → (spawn は PM) → verdict 検証 →
`merge_land` → cleanup を順に通し、止まった時は最終行に `NEXT_COMMAND: <command>` を出す。
gate 席の spawn / verdict / lock / row close は機械化していない (「機械化は告知まで」)。
手順は `../garelier-core/references/pm_field_manual.md#pmfm-2`、register 契約の全数は
`../garelier-core/references/worker_field_manual.md` §5b-1（件数もそこが正本 — 本書に転記しない）。

**その session で初めて使う役は、dispatch prompt を書く前に該当行を読む。**
assignment には worker manual §3 の premise 反証 (前提を 5-10 分で機械確認、崩れたら
BLOCKED+2-3 案) を含める。
