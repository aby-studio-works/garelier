# Protocol / 通信プロトコル

> v2.7.3 — the canonical operational specification lives at
> `skills/garelier-core/protocol.md`; this file is the human-readable
> explanation. Keep both in sync.

本ドキュメントは Garelier におけるエージェント間通信の規約を定義します。
全ての通信は `<project>/__garelier/<pm_id>/runtime/` 配下のファイルを介して行われ、
口頭(直接やり取り)による情報伝達は許可されません。永続正本(計画、
判断、blueprints、inspections、reports)は `<project>/__garelier/<pm_id>/control/`
に置かれます。

エージェントは「定義された権限の中で正しく働く」ことが大前提です(governed
autonomy)。権限序列・MUST BLOCK 条件・assignment 契約の正本は
`skills/garelier-core/protocol.md` §1.10 と
`skills/garelier-core/correct_operation.md`(DEC-023)にあります。

## Table of Contents

1. [ディレクトリレイアウト](#layout)
2. [ファイル所有権マトリクス](#ownership)
3. [メッセージ書式](#formats)
4. [命名規則](#naming)
5. [永続化と Git 管理](#persistence)

## <a id="layout"></a>1. ディレクトリレイアウト

Garelier は同一プロジェクトに **複数 PM** が並列で立ち上がる構成を
想定しています(1 開発者 1 PM 等)。各 PM は短い識別子 `<pm_id>`
(例: `acme`, `bob`) を持ち、**完全に独立した Garelier 環境** を
`__garelier/<pm_id>/` 配下に持ちます。`__garelier/` 直下に
共有 coordination state は存在しません。

```
<project>/__garelier/
├── <pm_id-A>/                            ← 1 PM の完全な Garelier 世界
│   ├── _pm/                              PM ロール
│   ├── _dispatch<N>/                     一時 producer ホーム(DEC-063): STATE.md + checkout/ worktree。
│   │                                     dispatch_prepare がタスク毎に作成、dispatch_cleanup が撤去
│   ├── _dock/                            Dock ロールホーム(オンデマンド、DEC-065 — 事前作成しない)
│   ├── _workers/<worker_id>/             Worker container(オンデマンド、DEC-065): 調整ファイル + checkout/ worktree、in-project(DEC-036; exile は opt-in)
│   ├── _scouts/<scout_id>/               Scout container (+ checkout/ detached worktree)
│   ├── _smiths/<smith_id>/               Smith container (+ checkout/ worktree)
│   ├── _artisan/                         Artisan container (+ checkout/; 単一; artisan lane, DEC-017)
│   ├── _librarians/<librarian_id>/       Librarian container (+ checkout/; dock lane, DEC-018)
│   ├── _observers/<observer_id>/         Observer container (+ checkout/; read-only review/advice, DEC-019)
│   ├── _guardians/<guardian_id>/         Guardian container (+ checkout/ on a gavel branch; security gate, DEC-024)
│   ├── _concierges/<concierge_id>/       Concierge container (+ checkout/ on a clipboard branch; external ops, DEC-025)
│   ├── control/                          この PM の永続正本(git 管理)
│   │   ├── README.md
│   │   ├── project_dashboard/            この PM の roadmap / backlog / current / notes / decisions / risks / quality_gates
│   │   ├── operations/                   この PM の runbook / promote_checklist / recovery / data_change_policy
│   │   ├── blueprints/                   この PM の task spec
│   │   ├── inspections/                  この PM の受理済み Scout 成果物
│   │   ├── observations/                 受理済み Observer report(DEC-019)
│   │   ├── delegation/                   この PM が知る他 PM 一覧
│   │   │   ├── known_pms.toml            同 project の他 PM(交流相手)
│   │   │   └── remote_pms.toml           他 project の PM(横断 request 用)
│   │   ├── request_intake/               この PM 宛 request 受口
│   │   ├── scheduled_jobs/               この PM の RRULE jobs
│   │   ├── decisions/                    この PM の DEC(任意)
│   │   └── reports/                      promote / benchmark / data_audit / requests 等
│   └── runtime/                          実行中の一時状態(gitignore、machine-local)
│       ├── manifest.md                   milestone / backlog 集計 / activity(実行行は持たない、W-011)
│       ├── backlog/
│       │   ├── pending.md                未着手・進行中
│       │   ├── in_flight.md              実行中作業の生成ビュー(W-011; dispatch_event.{sh,ps1} が再生成。手書き禁止)
│       │   ├── next_id                   task id (BP-N) カウンタ
│       │   └── done/
│       │   └── archive/
│       │   └── requeued/                 PM が戻した WIP 監査メモ
│       ├── dock/inbox/              各 Worker / Scout / Smith からの通知
│       ├── dock/escalation/         Dock → PM
│       ├── pm/inbox/                     Dock → PM 進捗
│       ├── pm/resolutions/               PM 回答
│       ├── requests/                     delegated request state
│       ├── observer/                     Observer request/result inbox(DEC-019; 両 lane）
│       ├── guardian/                     Guardian gate request/result inbox(DEC-024)
│       ├── concierge/                    Concierge external-op request/result inbox + locks/(target-scoped, DEC-025)
│       ├── librarian/                    Librarian ローカル専用作業領域(DEC-038): raw/ cache/ drafts/ — curated 知識は tracked な docs/garelier/ へ promote
│       ├── lane.lock                     稼働 lane 調停: artisan | dock(DEC-017)
│       ├── scheduled_jobs/               locks / per-run
│       ├── workspace_paths               role→exile container ポインタ — exile opt-in 時のみ(DEC-036; gitignored)
│       └── dispatch/                     producer の start/gate/merge イベントログ(Status Web の情報源)
└── <pm_id-B>/                            ← 別 PM、完全に独立
    └── ... (同じ shape)
```

producer の排他は dispatch では構造的に保証されます(DEC-066): 各タスクは
`scripts/dispatch_prepare.{sh,ps1}`(アトミックな id 採番)が用意した専用
`_dispatch<N>/checkout` worktree 上の run-to-completion サブエージェント
1体として実行され、pid lease も二重起動の窓も存在しません。

永続的な `_<role>/` container は **オンデマンドでのみ**作られます(DEC-065):
fresh setup は何も事前作成せず、wizard の diff mode によるロスター追加が
唯一の作成経路です(長期に作業を退避する座席が必要なときだけ)。container の
無い座席が健全な既定状態で、`setup_config.toml` のロスター項目はシート既定値
(provider/model ルーティング)です。

Worker / Scout / Smith の状態ファイルは **container 側**(DEC-020)
(`__garelier/<pm_id>/_workers/<worker_id>/STATE.md` 等)に置かれます。
git worktree は container 内の `checkout/` に nest され、実行時の cwd は
その `checkout/`。調整ファイルは一つ上(`../STATE.md` 等)で読み書きします。

**DEC-036 — role worktree は既定でプロジェクト内**: 上記
`__garelier/<pm_id>/_<role>/<id>/` の container はプロジェクト**内**にあり、
git worktree は `…/checkout/` です。role の cwd(checkout)はプロジェクトの
子孫なので `CLAUDE.md` 祖先探索が対象プロジェクト自身の `<proj>/CLAUDE.md` も
読みますが、これは worktree が既に持つコピーの重複で**トークンコストのみ**
(identity は dispatch prompt で正典＝prompt-
authoritative)。wizard はプロジェクト内のまま
`<checkout>/.claude/settings.local.json` に
`claudeMdExcludes`(本流 `CLAUDE.md` 群の絶対 glob)を
書き、重複ロードを除外します(headless でも有効)。

**exile は opt-in**: `--exile`/`-Exile`/`GARELIER_HOME`/`[workspace] home_root`
を指定すると、container はプロジェクト外のマシンローカル studio home
`$GARELIER_HOME/<home_id>/_<role>/<id>/`(既定 `~/.garelier/studios/<home_id>/…`)
になり、gitignored な `__garelier/<pm_id>/runtime/workspace_paths`(1 行
`<role 単数>.<id>=<絶対 container>`、加えて `artisan=…`)に記録されます。tooling
`roleContainer()` / wizard `ws_resolve_container` / doctor・status のリゾルバは
ポインタがあればそれを、無ければ in-proj パスを解決します(既定は in-proj)。
どちらの配置でも role は調整ファイルを `../` で、primary/runtime/control を
`CLAUDE.md` の絶対パス(dispatch prompt が再注入)で
扱います。既定の in-project は Claude Code の launch-folder アクセスモデルに
従い共有/制限環境でも動作します。詳細は
DEC-036(0035 を supersede)。

Scout の inspection は Scout detached worktree 内で draft として作成されます。
Dock が受理した後、PM が primary checkout 側へ取り込み、同内容を
commit または既存 commit 確認します。Scout 自身は commit しません。

**`__garelier/` 直下に共有の `control/` は存在しません**(すべての
`control/` は `<pm_id>` 配下にあります)。2 PM 間で tracked
ファイルは共有されず、coordination が必要な場合は
`request_intake/` 機構(後述)経由でのみ行います。

## <a id="external-plan"></a>1.5 プロジェクト全体計画

永続的なプロジェクト管理の正本は、明示的に選んだ
`__garelier/<pm_id>/control/` namespace に置きます。
`project_dashboard/`、milestone、blueprint、decision、operations は
Garelier Control の標準形式を使います。

プロジェクトの `docs/` は目標、設計、背景を説明できますが、別の roadmap、
backlog、decision 正本を維持してはいけません。既存の
`docs/project_dashboard/` がある場合、永続管理情報を選択した control
namespace へ移行し、`docs/` には説明文章だけを残します。

複数 PM の coordination は `request_intake`、control bundle、または
明示的に選択した shared control-only namespace を使います。agents は
directory 名から共有正本を推測しません。

## <a id="retire-requeue"></a>1.6 Retire-and-requeue

active な Worker / Scout / Smith を退役させたいが、task を `aborted`
扱いにしたくない場合、PM は clean-stop ではなく
retire-and-requeue を使います。

- `abort.md` は書きません。
- agent を `ABORTED` にしません。
- task を同じ task id のまま `runtime/backlog/pending.md` に戻します
  (`in_flight.md` は生成ビュー(W-011)— producer の container/STATE が
  消えれば行は自動で落ちます。手で編集しません)。
- `_pm/history.md` の outcome は `requeued` とします。
- `runtime/backlog/next_id` は増やしません。
- WIP 監査を残す場合は
  `runtime/backlog/requeued/<timestamp>-<task-id>-<agent-id>/`
  に置きます。これは merge 経路ではありません。

## <a id="ownership"></a>2. ファイル所有権マトリクス

request reports は状態ごとに writer が異なります。accepted/completed の
report は PM、rejected report は request_intake が書きます。

下表の path は全て 1 PM のツリー (`__garelier/<pm_id>/...`) 内です。
書き込み権限は同 `<pm_id>` のロールに限られ、別 PM の同種ファイル
への書き込みは **禁止** です(cross-PM 連携は §5 の request_intake
経由)。「全員」は「この PM の全ロール」を意味します。

| Path                                                                  | 書き込み権限         | 読み取り       |
| --------------------------------------------------------------------- | ------------------- | ------------- |
| `__garelier/<pm_id>/runtime/manifest.md`                             | Dock            | 全員(同 PM)  |
| `__garelier/<pm_id>/runtime/backlog/pending.md`                      | Dock            | 全員(同 PM)  |
| `__garelier/<pm_id>/runtime/backlog/in_flight.md`                    | dispatch_event ツール(生成ビュー、W-011) | 全員(同 PM)  |
| `__garelier/<pm_id>/runtime/dispatch/events.jsonl`                   | dispatch ツール(追記専用の単一情報源、DEC-064 §3) | 全員(同 PM)  |
| `__garelier/<pm_id>/runtime/backlog/done/`                           | Dock            | 全員(同 PM)  |
| `__garelier/<pm_id>/runtime/backlog/archive/`                        | Dock            | 全員(同 PM)  |
| `__garelier/<pm_id>/runtime/backlog/requeued/`                       | PM                   | 全員(同 PM)  |
| `__garelier/<pm_id>/runtime/dock/inbox/`                        | Worker / Scout / Smith | Dock   |
| `__garelier/<pm_id>/runtime/dock/escalation/`                   | Dock            | PM            |
| `__garelier/<pm_id>/runtime/dock/tier_order.json`               | Dock            | dispatch loop(DEC-031) |
| `__garelier/<pm_id>/runtime/merge_gate/requests/` + `…/next_seq`     | Dock            | merge-gate subprocess (DEC-007) |
| `__garelier/<pm_id>/runtime/merge_gate/{results,logs,archive}/`      | merge-gate subprocess | Dock |
| `__garelier/<pm_id>/runtime/merge_gate/locks/` (`active.lock` 含む)  | merge-gate subprocess | Dock |
| `__garelier/<pm_id>/runtime/pm/inbox/`                               | Dock / User     | PM            |
| `__garelier/<pm_id>/runtime/pm/resolutions/`                         | PM                   | Dock     |
| `__garelier/<pm_id>/runtime/requests/inbox/`                         | request_intake       | PM            |
| `__garelier/<pm_id>/runtime/requests/processing/`                    | PM                   | PM            |
| `__garelier/<pm_id>/runtime/requests/processed/`                     | PM                   | PM            |
| `__garelier/<pm_id>/runtime/requests/rejected/`                      | request_intake       | PM            |
| `__garelier/<pm_id>/runtime/requests/failed/`                        | request_intake       | PM            |
| `__garelier/<pm_id>/runtime/scheduled_jobs/locks/`                   | scheduler wrapper    | owner role    |
| `__garelier/<pm_id>/runtime/scheduled_jobs/runs/`                    | owner role           | owner role    |
| `__garelier/<pm_id>/_workers/<id>/STATE.md`                          | Worker `<id>`        | 全員(同 PM)  |
| `__garelier/<pm_id>/_workers/<id>/assignment.md`                     | Dock            | Worker `<id>` |
| `__garelier/<pm_id>/_workers/<id>/report.md`                         | Worker `<id>`        | Dock     |
| `__garelier/<pm_id>/_workers/<id>/under_review.md`                   | Dock            | Worker `<id>` |
| `__garelier/<pm_id>/_workers/<id>/review.md`                         | Dock            | Worker `<id>` |
| `__garelier/<pm_id>/_workers/<id>/merged.md`                         | Dock            | Worker `<id>` |
| `__garelier/<pm_id>/_workers/<id>/answers.md`                        | Dock            | Worker `<id>` |
| `__garelier/<pm_id>/_workers/<id>/track-target.md`                   | Dock            | Worker `<id>` |
| `__garelier/<pm_id>/_workers/<id>/abort.md`                          | PM or Dock      | Worker `<id>` |
| `__garelier/<pm_id>/_<role>/<id>/urgent.md` (任意の detached agent)   | PM or Dock      | dispatch loop(DEC-031) |
| `__garelier/<pm_id>/_scouts/<id>/STATE.md`                           | Scout `<id>`         | 全員(同 PM)  |
| `__garelier/<pm_id>/_scouts/<id>/assignment.md`                      | Dock            | Scout `<id>`  |
| `__garelier/<pm_id>/_scouts/<id>/committed.md`                       | Dock            | Scout `<id>`  |
| `__garelier/<pm_id>/_scouts/<id>/abort.md`                           | PM or Dock      | Scout `<id>`  |
| `__garelier/<pm_id>/_smiths/<id>/STATE.md`                           | Smith `<id>`         | 全員(同 PM)  |
| `__garelier/<pm_id>/_smiths/<id>/assignment.md`                      | Dock            | Smith `<id>`  |
| `__garelier/<pm_id>/_smiths/<id>/report.md`                          | Smith `<id>`         | Dock     |
| `__garelier/<pm_id>/_smiths/<id>/under_review.md`                    | Dock            | Smith `<id>`  |
| `__garelier/<pm_id>/_smiths/<id>/review.md`                          | Dock            | Smith `<id>`  |
| `__garelier/<pm_id>/_smiths/<id>/merged.md`                          | Dock            | Smith `<id>`  |
| `__garelier/<pm_id>/_smiths/<id>/answers.md`                         | Dock            | Smith `<id>`  |
| `__garelier/<pm_id>/_smiths/<id>/abort.md`                           | PM or Dock      | Smith `<id>`  |
| `__garelier/<pm_id>/_librarians/<id>/STATE.md`                       | Librarian `<id>`     | 全員(同 PM)  |
| `__garelier/<pm_id>/_librarians/<id>/assignment.md`                  | Dock            | Librarian `<id>` |
| `__garelier/<pm_id>/_librarians/<id>/report.md`                      | Librarian `<id>`     | Dock     |
| `__garelier/<pm_id>/_artisan/STATE.md`                               | Artisan              | 全員(同 PM)  |
| `__garelier/<pm_id>/_artisan/assignment.md`                          | PM                   | Artisan       |
| `__garelier/<pm_id>/_artisan/{report,checkpoint}.md`                 | Artisan              | PM            |
| `__garelier/<pm_id>/runtime/lane.lock`                               | lane holder (Artisan/Dock) | dispatch loop, 全員 |
| `__garelier/<pm_id>/_observers/<id>/STATE.md`                        | Observer `<id>`      | 全員(同 PM)  |
| `__garelier/<pm_id>/_observers/<id>/assignment.md`                   | Requester (Dock/Artisan/Worker) | Observer `<id>` |
| `__garelier/<pm_id>/_observers/<id>/{report,advice}.md`              | Observer `<id>`      | Requester     |
| `__garelier/<pm_id>/_observers/<id>/acked.md`                        | Requester            | Observer `<id>` |
| `__garelier/<pm_id>/runtime/observer/{requests,results}/`            | Requester (requests) / Observer (results) | Observer, Dock |
| `__garelier/<pm_id>/control/observations/`                           | Observer draft / PM·Dock·Artisan commit | 全員(同 PM) |
| `__garelier/<pm_id>/_guardians/<id>/{STATE,guardian_report}.md`      | Guardian `<id>`      | 全員(同 PM)  |
| `__garelier/<pm_id>/_guardians/<id>/assignment.md`                   | Requester (Dock/PM/Artisan) | Guardian `<id>` |
| `__garelier/<pm_id>/runtime/guardian/{requests,results}/`            | Requester (requests) / Guardian (results) | Guardian, Dock |
| `__garelier/<pm_id>/_concierges/<id>/{STATE,concierge_report}.md`    | Concierge `<id>`     | 全員(同 PM)  |
| `__garelier/<pm_id>/_concierges/<id>/assignment.md`                  | PM                   | Concierge `<id>` |
| `__garelier/<pm_id>/runtime/concierge/{requests,results,locks}/`     | PM (requests) / Concierge (results, target-scoped locks) | Concierge, Dock |
| `docs/garelier/knowledge/{source,routine}_registry.toml`            | Librarian draft / shelf review | 全員(同 PM)  |
| `__garelier/<pm_id>/control/inspections/<category>/<topic>.md`       | Scout draft / PM commit | 全員(同 PM)  |
| `__garelier/<pm_id>/control/inspections/<category>/YYYY/MM/<date>-<topic>.md` | Scout draft / PM commit | 全員(同 PM) |
| `__garelier/<pm_id>/control/blueprints/BP-<N>-<slug>.md`             | PM                   | 全員(同 PM)  |
| `__garelier/<pm_id>/control/project_dashboard/`                      | PM                   | 全員(同 PM)  |
| `__garelier/<pm_id>/control/operations/`                             | PM (with user)       | 全員(同 PM)  |
| `__garelier/<pm_id>/control/delegation/`                             | PM (with user)       | 全員(同 PM)  |
| `__garelier/<pm_id>/control/request_intake/`                         | PM (with user)       | 全員(同 PM)  |
| `__garelier/<pm_id>/control/scheduled_jobs/`                         | PM (with user)       | 全員(同 PM)  |
| `__garelier/<pm_id>/control/reports/promote/`                        | PM                   | 全員(同 PM)  |
| `__garelier/<pm_id>/control/reports/benchmark/`                      | Worker / Scout / Smith | 全員(同 PM) |
| `__garelier/<pm_id>/control/reports/data_audit/`                     | Worker / Scout / Smith | 全員(同 PM) |
| `__garelier/<pm_id>/control/reports/requests/`                       | PM / request_intake  | 全員(同 PM)  |
| `__garelier/<pm_id>/control/reports/delegated_requests/`             | PM                   | 全員(同 PM)  |
| `__garelier/<pm_id>/control/reports/notifications/`                  | owner role           | 全員(同 PM)  |
| `__garelier/<pm_id>/control/reports/scheduled_jobs/`                 | owner role           | 全員(同 PM)  |
| `__garelier/<pm_id>/_pm/setup_config.toml`                           | PM                   | PM, Dock |
| `__garelier/<pm_id>/_pm/history.md`                                  | PM                   | 全員(同 PM)  |
| `__garelier/<pm_id>/_pm/history/archive/YYYY-MM.md`                  | PM                   | 全員(同 PM)  |

## <a id="formats"></a>3. メッセージ書式

各ファイル形式の**正本テンプレート**は
`skills/garelier-core/templates/` と `skills/garelier-pm/templates/`
配下にあり（`assignment.md` / `report.md` / `review.md` / `manifest.md` /
`blueprint.md` / `inspection.md` / `observer_*` / `artisan_*` /
`source_registry.toml` / `routine_registry.toml` など）、ロールは必ず
テンプレートから開始します。本書はそれを置き換えず、概要のみを示します。
ファイル所有権の正本は §2 の表と
`skills/garelier-core/protocol.md`（canonical）です。

### Compact handoff

Garelier の role 間ファイルは常時 compact handoff。対象は
`assignment.md`, `report.md`, `questions.md`, inbox notification,
manifest activity, runtime backlog。詳細は
[`compact_handoff.md`](compact_handoff.md)。

次ロールが compact handoff と参照先ファイルだけで行動できることが条件。
path、command、identifier、error、date、number、commit SHA、
data-change evidence、risk statement は省略・改変しない。

Smith batch を `runtime/backlog/pending.md` や `assignment.md` に書く場合、
対象 Worker merge は `#<worker_task_id>@<merge_sha>` token で列挙する。
標準フィールド名は pending 側が `smith_targets:`、assignment / report 側が
`Covered Worker merges:`。`status.{sh,ps1}` はこの token を数えて
`Smith hardening targets remaining` を表示するため、別表現へ崩さない。

## <a id="naming"></a>4. 命名規則

- PM ID (`<pm_id>`): 単一ユーザーの default は `_workshop`。共有・複数
  ユーザーでは明示的に一意な
  `[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?` (1–20 文字、小文字 ASCII +
  数字 + 内部ハイフン/アンダースコア) を指定する。setup_wizard で決定。
- Agent ID: provider 名ではなく安定した role slot を表す。推奨形式は
  `<role>-NN` (例: `worker-01`, `worker-02`, `scout-01`, `smith-01`,
  `artisan-01`)。`provider` / `model` はこの slot に割り当てる実行 CLI
  として別に管理し、差し替え時も同じ container を再利用する。
- Worker / Scout / Smith / Librarian / Observer / Guardian / Concierge ID:
  同一 PM ツリー内で一意にする。
- Target branch (`<target>`): ユーザが setup 時に選択(規定: `main`)
- Target slug (`<target-slug>`): `<target>` の `/` を `-` に置換
  (例: `develop/soft` → `develop-soft`)
- Studio branch: `garelier/<target-slug>/<pm_id>/studio`
- Workbench branch:
  `garelier/<target-slug>/<pm_id>/workbench/#<N>/<short-description>`
- Anvil branch:
  `garelier/<target-slug>/<pm_id>/anvil/#<N>/<short-description>`
- Task ID: `BP-<N>` (PM ツリー内で一意、`runtime/backlog/next_id`
  からインクリメント)
- Inspection category: `tech` / `market` / `status` / `benchmark` /
  `data_audit` / `<custom>`
- Inspection topic file: `<YYYY-MM-DD>-<topic-slug>.md`
  (daily/high-volume: `YYYY/MM/<YYYY-MM-DD>-<topic-slug>.md`)

## <a id="persistence"></a>5. 永続化と Git 管理

各 PM の `__garelier/<pm_id>/` ツリーの git 取り扱い(全 PM 共通):

| Path                                                          | Git 管理 | 理由                                  |
| ------------------------------------------------------------- | -------- | ------------------------------------- |
| `__garelier/<pm_id>/control/`                                | する      | この PM の永続正本                     |
| `__garelier/<pm_id>/runtime/`                                | しない    | 走行中状態、machine-local              |
| `__garelier/<pm_id>/_workers/<id>/`                          | しない    | worktree container                    |
| `__garelier/<pm_id>/_scouts/<id>/`                           | しない    | worktree container                    |
| `__garelier/<pm_id>/_smiths/<id>/`                           | しない    | worktree container                    |
| `__garelier/<pm_id>/_dock/`                             | しない    | 揮発的な作業状態                       |
| `__garelier/<pm_id>/_pm/CLAUDE.md`                           | しない    | 自動生成(ロール identity)              |
| `__garelier/<pm_id>/_pm/setup_config.toml`                   | する      | 構成設定                              |
| `__garelier/<pm_id>/_pm/history.md`                          | する      | この PM の永続履歴                     |

DEC-051: これらの ignore ルールは**ネストした `__garelier/.gitignore`**
(garelier-core の `templates/runtime_gitignore` を `__garelier/` 相対パターンで配置:
`*/runtime/`, `*/_workers/`, `*/_scouts/`, `*/_smiths/`, `*/_dock/`,
`*/_pm/CLAUDE.md` 等)に置き、**プロジェクトの root `.gitignore` には触れません**。
git はネストした `.gitignore` を尊重するので全 `<pm_id>` に適用されつつ、root は
churn せず・他者を巻き込まず・`__garelier/` 削除で ignore ルールごと消えます。
ripgrep / fd 用に同等のネスト `__garelier/.ignore`(`templates/search_ignore`)も置きます。

大量運用時は `docs/retention.md` / `skills/garelier-core/retention.md`
に従います。`_pm/history.md` は hot index とし、古い完了 entry は
`_pm/history/archive/YYYY-MM.md` に月別分割します。日報・定期 status・
大量 inspection は
`control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md` を標準にします。

### Garelier ブランチは local-only

Garelier が作成する協調用ブランチは **絶対にリモートへ push しません**:

| ブランチ                                                          | リモート push           |
| ----------------------------------------------------------------- | ----------------------- |
| `garelier/<target-slug>/<pm_id>/studio`                          | **しない**              |
| `garelier/<target-slug>/<pm_id>/workbench/#<N>/<slug>`           | **しない**              |
| `garelier/<target-slug>/<pm_id>/anvil/#<N>/<slug>`               | **しない**              |
| `garelier/<target-slug>/<pm_id>/shelf/#<N>/<slug>`               | **しない**              |
| `garelier/<target-slug>/<pm_id>/satchel/#<N>/<slug>`          | **しない**              |
| `garelier/<target-slug>/<pm_id>/spyglass/#<N>/<slug>` (Scout, 使い捨て・DEC-021)  | **しない**       |
| `garelier/<target-slug>/<pm_id>/monocle/#<N>/<slug>` (Observer, 使い捨て・DEC-021) | **しない**       |
| `garelier/<target-slug>/<pm_id>/gavel/#<N>/<slug>` (Guardian, 使い捨て・DEC-024)   | **しない**       |
| `garelier/<target-slug>/<pm_id>/clipboard/#<N>/<slug>` (Concierge, local-only・DEC-025) | **しない**       |
| `<target>` (例 `main`)                                            | promote 時のみ (user 指示 + PM 承認後、Concierge が実行) |
| `garelier/request/...`                                           | request-intake 機構経由のみ (opt-in) |

理由: これらは **1 開発者の 1 マシン上の協調状態** であり、
共有リモートへ漏れると別の開発者が同じ target project に
Garelier を立てられなくなる(studio 名衝突、workbench id 衝突、
Anvil id 衝突、リモートが多重 coordination state の混沌になる)。各開発者の
Garelier セッションはローカル完結とし、共有リモートに流れるのは
通常の `<target>` ブランチ経由(= promote)のみとします。

各ロールへの帰結:
- PM bootstrap は初期 commit をローカルで完了させ push しない。
- Worker は workbench ブランチを push しない(base-tracking rebase 後も
  REPORTING 遷移時も)。
- Smith は Anvil ブランチを push しない。
- Dock は studio merge 後も push しない。workbench / Anvil 削除時も
  リモート側 (`git push origin --delete`) を触らない。
- Garelier ロールが実行する唯一の `git push` は promote 時の
  `git push origin <target> --tags` (= user 自身のブランチ)。

既にリモートへ garelier/* が出ている場合(過去の誤 push 等)、
削除は user の明示判断で行います。ロール側からリモート garelier/*
を削除する処理は禁止(他開発者の coordination state を破壊する恐れ)。
