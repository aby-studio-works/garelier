# Concepts / フレームワーク概念

> v2.8.3 — the canonical human-readable reference for the Garelier
> design rationale.

> **Non-affiliation / 非提携.** Garelier is an independent community project.
> It works with Claude Code and Codex CLI but is not affiliated with, endorsed,
> or sponsored by Anthropic or OpenAI. "Claude", "Claude Code", and other marks
> belong to their respective owners.
> Garelier は独立したコミュニティプロジェクトです。Claude Code / Codex CLI と
> 連携しますが、Anthropic / OpenAI との公式な提携・承認・スポンサー関係は
> ありません。各製品名・サービス名はそれぞれの所有者の商標です。

Garelier は軽量な AI 作業補助ではなく、**安全に AI に働いてもらうための
統治された自律協調フレームワーク**です。ロール数・ファイル契約・承認境界の
重さは、安全性・監査性・復旧性を確保するための設計要件です。本ドキュメントは、
Garelier が前提とする設計思想、**11 ロール**の責務分担、ブランチ階層、
そして他の協調(コーディネーション)手法との比較を解説します。

## Table of Contents

1. [設計思想](#design-philosophy)
   - [提供形態と Plugin 呼称](#product-compositions)
2. [ロール構成（11 ロール）](#roles)
   - [信頼境界 / 脅威モデル](#trust-boundaries)
   - [課金と利用規約について / Billing & ToS](#billing-tos)
3. [ブランチ階層](#branch-hierarchy)
4. [エスカレーション](#escalation)
5. [複数マイルストーンの並列](#parallel-milestones)
6. [Worker / Scout / Smith の境界](#worker-scout-smith)
7. [スキルとプロジェクト固有設定の責任分担](#skills-vs-project-config)

## <a id="design-philosophy"></a>1. 設計思想

Garelier は以下の前提で設計されています。

- **Governed autonomy（定義された枠の中で正しく働く）** — Garelier の
  autonomous は「AI が自由に目的や手順を決める」ことではない。各ロールは
  role contract・state machine・所有 branch/checkout・allowed paths・承認境界
  という**定義された枠の中で正しく働く**。目的・受入基準・role 境界・承認を
  AI が勝手に変えることはしない。「正しく働いたか」は
  [`correct_operation.md`](../skills/garelier-core/correct_operation.md) の
  10 条件で判定し、成果物が完成していても境界を破れば失敗とみなす(DEC-023)。
- **役割の物理分離** — 各エージェントは独立した worktree とディレクトリを持ち、
  互いの作業領域を直接参照しない。
- **ファイルベース通信** — エージェント間の情報伝達は永続化されたファイルを介して
  行う。これにより、セッション切断後の状態復元が可能になる。
- **明示的なエスカレーション** — 自己判断で進めない迷いは、上位ロールに必ず
  ファイルとして残す。沈黙による暴走を防ぐ。
- **品質基準の明文化** — レビュー観点と完了条件はあらかじめ文書化し、
  Dock のレビューを再現可能にする。
- **隔離された prefix** — フレームワーク管理ファイルはすべて
  `__garelier/` 配下に集約し、target project のソースと混ざらない。
- **PM 単位の完全隔離** (v2.1+、DEC-006) — 各 PM は短い id
  (`<pm_id>`) を持ち、自分専用の Garelier 環境を
  `__garelier/<pm_id>/` 配下に完結させる。`__garelier/` 直下に
  共有 coordination state は存在しない。同一プロジェクトに複数
  開発者が居る場合、それぞれが独立した PM を立てて作業し、
  cross-PM の連携は `request_intake/` 経由でのみ行う。
- **永続正本と実行状態の分離** — 各 PM の
  `__garelier/<pm_id>/control/` は永続正本(project_dashboard /
  operations / blueprints / inspections / delegation /
  request_intake / scheduled_jobs / decisions / reports)、
  `__garelier/<pm_id>/runtime/` は実行中の一時状態
  (manifest / inbox / escalation / requests / scheduled_jobs /
  dispatch イベント)。両者は git 管理粒度もライフタイムも別。
- **プロジェクト管理の正本は control** — durable な roadmap、backlog、
  milestone、decision は、明示的に選んだ
  `__garelier/<pm_id>/control/` namespace に置く。通常の `docs/` は目標、
  設計、背景の説明に使い、別の管理正本にはしない。
- **Compact handoff** — role 間ファイルは短い事実行と参照パス中心で
  書く。`assignment.md`, `report.md`, `questions.md`, inbox notification,
  manifest activity は常時 compact。詳細は
  [`compact_handoff.md`](compact_handoff.md)。

## <a id="product-compositions"></a>1.1 提供形態と Plugin 呼称

Garelier の個別機能は、起動中の AI が必要時に読む小さな skill として提供します。
特に管理面の skill は `garelier-control-*` で揃えます。

| 呼称 | 構成 |
| --- | --- |
| **Garelier Control** | `garelier-control-project` / `garelier-control-library` を単体または併用する最小管理面。bundle / validation / graph を共有し、role / lane / dispatch を起動しない。compact handoff と control-only diagnosis は project skill の内蔵作法。 |
| **Garelier Plugin Artisan** | Garelier Control + PM-guided Artisan lane。 |
| **Garelier Plugin Full Garelier** | Garelier Control + 全 coordinated role + dock/artisan 両 lane + runtime/branch/dispatch。 |

ここでの `Plugin` は、複数 skill・lane・dispatch を組み合わせた利用者向け構成の
**呼称**です。skill folder の prefix、単一巨大 skill、技術的 plugin package を
意味しません。既存の `garelier-artisan`、`garelier-pm` 等は個別 skill 名のまま
維持します。

## <a id="roles"></a>2. ロール構成

中核は PM / Dock / Worker / Scout / Smith。v2.5 で Librarian / Artisan /
Observer、さらに Guardian (DEC-024)、Concierge (DEC-025)、そして DEC-076 で
Wanderer(確定前の PM 設計をレビューする外部アドバイザリ役)が加わり、計 11
ロールになりました。境界は「誰が何を書くか」と「誰にだけ話すか」で決まります。

| Role | 主な責務 | 所有するもの | 会話相手 |
| ---- | -------- | ------------ | -------- |
| PM | ユーザ意図を roadmap / blueprint / promote 判断 / lane 選択へ変換する | `__garelier/<pm_id>/control/project_dashboard/`, `blueprints/`, promote 判断 | User, Dock, Artisan |
| Dock | blueprint を phase / assignment に分解し、実行順序と merge gate を管理する | `runtime/manifest.md`, `runtime/backlog/`, `studio` branch | PM, Worker, Scout, Smith, Librarian |
| Worker | コミットを伴う 1 タスクを実装し、report を返す | 1 本の `workbench` branch と Worker worktree | Dock のみ |
| Scout | コミットを伴わない調査・検証・実行結果を inspection として残す | 1 件の inspection と Scout worktree | Dock のみ |
| Smith | studio 統合後の結合・システム・リリース・仕様整合・ライセンス/セキュリティ hardening を行い、report を返す | 1 本の `anvil` branch と Smith worktree | Dock のみ |
| Librarian | 登録済み外部情報の同期・内部規約化・runbook 化・registry 維持 | 1 本の `shelf` branch と Librarian worktree | Dock のみ |
| Artisan | artisan lane: Dock+Worker+Scout+Smith+Librarian の範囲を単独実行し、gate 後に `satchel` を `studio` へ統合 | 1 本の `satchel` branch と Artisan worktree | PM のみ |
| Observer | コミット無の独立レビュー/助言 sidecar (両 lane、`lane.lock` 取得せず) | 何も所有しない (review/advice のみ) | 依頼元 (Dock / Artisan / Worker) |
| Guardian | コミット無の security/privacy/dependency/license **gate**。Librarian 管理の規約を適用し PASS/PASS_WITH_NOTES/BLOCK 判定 (DEC-024) | 1 本の ephemeral `gavel` branch (使い捨て) | 依頼元 (Dock / PM / Artisan) |
| Concierge | PM の「最後の委任先」。承認済み外部操作 (Phase 1: promote の merge/tag/push) を実行。レーンの無い未定型作業の受け皿で、コード実装・方針決定・ゲートはしない (DEC-025) | 1 本の local-only `clipboard` branch | PM のみ |
| Wanderer | 確定前の PM 設計 (blueprint / project spec) を独立レビューし相互サインオフする外部アドバイザリ役。不在・沈黙・rate-limited 時は Observer にフォールバック (DEC-076) | 何も所有しない (外部セッション。`peer-channel` 越しに助言のみ) | PM (peer-channel) |

11 ロールは責務で次のように分かれます:

- **計画・統合系**: PM / Dock — 意図の確定と統合の統制。
- **実行系**: Worker / Scout / Smith / Librarian / Artisan — 実装・調査・hardening・知識・単独実行。
- **安全・監査系**: Observer / Guardian / Concierge — 独立レビュー、security/privacy/license ゲート、外部操作の隔離。
- **設計レビュー(外部)**: Wanderer — 確定前の PM 設計を外部セッションが独立レビューする(不在時は Observer にフォールバック)。

**Wanderer の設計レビューゲート(DEC-076)**: 非自明な PM 設計(大きな diff・新しい top-level key・protected-path / architecture / policy 変更)は、確定前に独立レビュー＋相互サインオフを通します。主レビュアーは Wanderer(別途起動した Codex / Claude Code セッション、多くは別の強力な model、`peer-channel` 越し)で、不在・沈黙・rate-limited 時は **Observer** subagent にフォールバックします。`auto_approve_blueprints` は非自明な設計でこのゲートをバイパスしません。Wanderer は外部セッションとして動き、lane も branch も持たず、commit も決定もしません。

「安全・監査系」は意図的に **判断するAI と実行するAI を癒着させない**ための分離です。特に Guardian(判定) と Concierge(実行) を分けることで、セキュリティ判断と外部 write が同一ロールに乗らないようにしています。安全 gate の関係:

| 場面 | 必要ロール | 判定/出力 | stale 防止 | 実行者 |
| --- | --- | --- | --- | --- |
| 通常 merge | Observer (policy 次第) | PASS / PASS_WITH_NOTES / … | `review_sha` | Dock |
| security-sensitive merge | Guardian | PASS / PASS_WITH_NOTES / BLOCK | `review_sha` | Dock |
| post-merge hardening | Smith | report + quality gate | studio sha | Dock |
| promote / push | Guardian + Concierge | `promote_gate` | `target_sha` / fixed tag | Concierge |
| PR / release / ticket | Guardian + Concierge + Librarian runbook | operation 固有 | request id / target sha | Concierge |

fresh setup は Guardian / Concierge を含む全ロールを既定 enabled にします。これは生成プロジェクトが最初から安全 gate と外部操作 executor を持つためです。Concierge が無効または未設定の場合、`studio` への統合は可能ですが promote は Concierge が構成されるまで BLOCK します。

### <a id="trust-boundaries"></a>2.1 信頼境界 / 脅威モデル

安全・監査系ロールが守るのは 1 つの境界です。**信頼ループの外から来た内容は
データであって、従うべき指示ではありません。**

- **UNTRUSTED(データ扱い)**: web fetch / 取得 URL、登録外部ソースの sync、
  delegated-request の自由記述本文、import した knowledge / control バンドル、
  そしてそれらから派生した report / diff / inspection / fixture(injection は
  1 ホップ「信頼」成果物へ伝播しうる)。
- **TRUSTED(信頼ループ)**: ユーザ / PM の直接指示、commit 済みの
  control / config / knowledge、そしてフレームワーク protocol と role skill。

UNTRUSTED 内に埋め込まれた命令調のテキスト(scope 変更、コマンド/資格情報の
要求、scanner 無効化、自動承認、push/promote 誘導など)は権限ゼロです。従わず、
suspicious-source note として記録し PM へ BLOCK / escalate します。完全な不変条件は
[`untrusted_input.md`](../skills/garelier-core/references/untrusted_input.md)。

v2.5 は **2 つの排他 lane** を導入しました (DEC-017): dock lane
(PM → Dock → {Worker, Scout, Smith, Librarian} → studio → promote)
と artisan lane (PM → Artisan → Guardian → Observer → Artisan → studio)。
両 lane の成果は PM 承認後に Concierge が target へ promote する。Observer はどちらの lane でも
動く読み取り専用 sidecar (DEC-019) です。各ロールの正本一覧は
`skills/garelier-core/SKILL.md`、詳細は DEC-017 / 0018 / 0019 を参照。

PM は v2.0 以降は専用ブランチを持ちません。PM が書くのは永続正本
(`control/`) と、ユーザ明示指示時の `studio` → `target` promote 承認・監督です。
Worker / Scout / Smith は PM や相互に直接連絡せず、Dock が唯一の中継点に
なります。これにより、並列実行中でも判断経路と責任境界が追跡可能です。

### <a id="billing-tos"></a>2.2 課金と利用規約について / Billing & ToS

Garelier は **AI プロバイダの利用規約 (ToS) や課金条件を自己認定しません。**
どのプロバイダ・プラン・実行モードを使うかは利用者の選択であり、**その規約・
課金条件を遵守する責任は運用者 (operator) 自身にあります。** Garelier はいかなる
構成についても「ToS-clean (規約上クリーン)」と保証せず、プロバイダによる承認・
提携を示唆する表現も付けません (DEC-052)。

- **実行モード**: 既定の autonomous モード (Mode D) は、人が立ち会う**対話型 (attended)
  セッション**の上で、**ファーストパーティのセッション内 subagent** (Agent /
  Workflow tool) を producer として動かす構成です。それでも「規約上問題なし」を
  Garelier が保証するものではありません。
- **課金**: どの枠に課金されるか・上限到達時の挙動などは、すべてプロバイダ側の
  条件に従います。Garelier は課金に関する保証も、課金に関与する仕組みも提供しません。
- **運用者の確認事項**: 利用前に、自分のプラン・地域・プロバイダの最新 ToS で、
  自動化・subagent・自律実行(loop での自走)の扱いを各自で確認してください。
  疑義があればプロバイダに確認するのが安全です。

> **In English.** Garelier does **not** self-certify any provider's Terms of
> Service or billing conditions. Choice of provider, plan, and execution mode is
> the operator's; **the operator remains responsible for complying with their
> provider's terms.** Garelier does not certify any configuration as "ToS-clean"
> and makes no claim of provider endorsement or affiliation (DEC-052). The default
> autonomous mode runs as an **attended interactive session** with **first-party
> in-session subagents** as producers. How any execution mode is billed is wholly
> the provider's concern; Garelier makes no billing claim and ships no
> billing-related feature. Check your own plan's current terms before use.

## <a id="branch-hierarchy"></a>3. ブランチ階層

ユーザが選択する `<target>` (規定: `main`) を基点に、`garelier/` 名前
空間の下にぶら下げる階層構造です。

```
<target> (ユーザ所有、PM がユーザ明示指示時にのみ触る)
 └── garelier/<target-slug>/<pm_id>/studio                       Dock 所有(integration)
      └── garelier/<target-slug>/<pm_id>/workbench/#<ID>/<slug>  Worker 所有
      └── garelier/<target-slug>/<pm_id>/anvil/#<ID>/<slug>      Smith 所有
```

`<target-slug>` は `<target>` の `/` を `-` に置換したもの。例:
- `target = main`, `pm_id = acme` → slug = `main` → `garelier/main/acme/studio`
- `target = develop/soft`, `pm_id = acme` → slug = `develop-soft` → `garelier/develop-soft/acme/studio`

階層深度を一定に保つことで、パスのパースが安定し、git のレフ階層衝突
(branch `develop/soft` がある状態で `develop/soft/...` が作れない問題)
を回避します。

物理配置はブランチ所有と一致します。

| 場所 | git 状態 | 主な利用者 |
| ---- | -------- | ---------- |
| primary checkout | `garelier/<target-slug>/<pm_id>/studio` | PM / Dock(オーケストレータ) |
| `__garelier/<pm_id>/_pm/` | primary checkout 内の通常ディレクトリ | PM |
| `__garelier/<pm_id>/_dispatch<N>/` | タスク毎の一時 producer ホーム(DEC-063)。worktree は `checkout/`、作業中は `workbench`/`anvil` 等の branch | dispatch producer |
| `__garelier/<pm_id>/_workers/<id>/` 等の `_<role>/` | オンデマンド container(DEC-065 — fresh setup は事前作成しない)。git worktree は `checkout/` に nest(DEC-020) | 長期退避した作業 |

`_dock/` などの永続 role ホームも同じくオンデマンドです(DEC-065)。通常運用
では PM セッションがオーケストレータ(PM+Dock)を兼ね、producer は
`_dispatch<N>/` で実行・撤去されます。

PM と Dock が primary checkout を共有するのは、どちらも `studio` 上の
統合作業を扱うためです。Worker は自分の `workbench` だけを変更し、Scout
はブランチを持たず inspection だけを生成します。Smith は Dock が
`studio` に統合した後の状態から `anvil` を切り、統合後 hardening だけを
変更します。

昇格フロー: workbench → Dock のレビュー → studio マージ →
必要なら anvil → Dock のレビュー → studio マージ → PM が
ユーザ指示で studio → target へ promote。v0.1.0 にあった `trunk/soft`
中間層は v0.2.0 で廃止(DEC-001)。v2.0 で `develop` → `studio`、
`feature` → `workbench`、`base` → `target`、`release` → `promote` に
名称統一(DEC-003)。

## <a id="escalation"></a>4. エスカレーション

エスカレーションは 2 段階です。

```
Worker / Scout / Smith (BLOCKED)
  -> Dock
      -> 解決できる: answers.md で Worker / Scout / Smith へ返す
      -> ユーザ判断が必要: runtime/dock/escalation/ に記録し PM へ送る
  -> PM
      -> 必要ならユーザへ確認し、runtime/pm/resolutions/ に回答を書く
  -> Dock
      -> Worker / Scout / Smith へ転送し、BLOCKED から WORKING へ戻す
```

Worker / Scout / Smith が `BLOCKED` に入ったら自走しません。質問は自分の
`questions.md` と Dock inbox 通知に残し、Dock から
`answers.md` が来るまで停止します。Dock は assignment や blueprint
だけで解ける疑問をその場で解決し、ユーザ判断・スコープ変更・promote
判断を伴うものだけを PM に上げます。

PM は Worker / Scout / Smith と直接やり取りしません。PM の回答は
`runtime/pm/resolutions/` に残り、Dock が作業者へ転送します。
この一段挟む構造により、PM は設計判断に集中し、Dock は実行中状態
の一貫性を保てます。詳細な状態遷移は
[`state_machine.md`](state_machine.md) を参照してください。

## <a id="parallel-milestones"></a>5. 複数マイルストーンの並列

PM は roadmap 上で複数マイルストーンを並べられますが、実行単位は
blueprint、phase、assignment に分解されます。Dock は
「どのマイルストーンか」よりも「いま安全に並列化できる assignment は
どれか」を基準に runtime backlog を組みます。

並列化の基本単位:

- Worker assignment: コミットを伴う workbench branch 1 本。
- Scout assignment: inspection 1 件。
- Smith assignment: studio 統合後の hardening を伴う anvil branch 1 本。
- Phase: 依存関係のある assignment 群をまとめる実行計画。
- Blueprint: PM が承認したユーザ価値単位。複数 phase に分解されることがある。

複数マイルストーンを同時に進める場合でも、`studio` は 1 本だけです。
Dock は workbench merge を直列化し、merge 前に `target` を
`studio` へ取り込み、品質ゲートを通したものだけを統合します。これにより
Worker の並列実装速度と、最終統合の一貫性を両立します。

Scout は commit を出さないため、依存関係が薄い調査・検証・ベンチマークを
先行して走らせやすい役割です。PM は Scout の inspection を受けて
blueprint や roadmap を更新し、Dock はその更新後の正本に従って
次の assignment を切ります。

## <a id="worker-scout-smith"></a>6. Worker / Scout / Smith の境界

判定基準は **「コミットか inspection か」** と
**「studio 統合前か統合後か」** です。

- **Worker**: コミットを生成するタスクを担当 (機能実装、バグ修正、
  リファクタリング、依存更新、ドキュメント編集など)。Worker は専用
  worktree で `garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>` ブランチ
  を切る。
- **Scout**: コミットを伴わないタスクを担当 (Web 調査、経理処理、
  税務調査、全数テスト実行、デプロイチェック、ベンチマーク、外部 API
  ヘルスチェック、メトリクス収集など)。Scout の出力(inspection)は
  detached worktree 内で draft 作成され、Dock 受理後に PM が
  `__garelier/<pm_id>/control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md` へ
  取り込み commit する。
- **Smith**: Dock が workbench を `studio` にマージした後の
  統合状態を hardening するタスクを担当 (結合テスト、E2E/システムテスト、
  release 付属ツール、target project の仕様書不整合修正、
  ライセンス/セキュリティ/コンプライアンス確認など)。Smith は専用
  worktree で `garelier/<target-slug>/<pm_id>/anvil/#<id>/<slug>` ブランチを
  切り、完了後は Dock が review して `studio` にマージする。

Smith は Worker の未完 feature scope を肩代わりしません。残件が PM backlog
にすでにある場合は重複作業を作らず、Dock が backlog 参照として扱います。
プロジェクトで決まっているライセンスポリシーは Smith が検証し、未決の方針は
Dock 経由で PM にエスカレーションします。

Smith が動いている間も、Dock は Worker dispatch と Worker → studio
merge を基本的に止めません。Smith 数が concurrency cap で、Smith が埋まって
いる間に進んだ Worker merge は次の Smith batch にまとめます。Smith が空いた
時点で、前回 Smith が確認した studio tip から現在の studio tip までを
hardening window として Anvil branch で検証します。止めるのは PM/user が
明示 freeze した場合、Smith が作るファイルに依存する場合、または
production/destructive 作業の安全確認が Smith 結果に依存する場合だけです。
Smith 数は Worker 数との比率を見てユーザが調整する運用パラメータです。
Garelier は Worker を自動停止せず、`status.{sh,ps1}` で
`Smith hardening targets remaining` (pending + active) を表示して判断材料を
出します。複数 Smith を使う場合は、同じ hardening window を
`integration` / `release` / `policy` / `spec` などの focus lane に分けるのが
安全です。後続 window の調査は先行できますが、先行 Smith の修正が studio に
入るまでは promote-ready の根拠にしません。

Worker は自分のタスクスコープ内で軽量な web 検索を自由に行います
(コメント 1 行で済むレベルのチェック)。Inspection 1 ファイルになる規模の
調査・実行・チェックは Scout に escalate されます。

`__garelier/<pm_id>/control/inspections/<category>/` の category は自由命名です。
setup wizard は `tech / market / status` の 3 つを初期生成しますが、
必要に応じて `accounting / deploy_check / test_results / benchmark /
data_audit` などを追加できます。

日報や定期 status など大量に増える inspection は
`control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md` に分けます。
詳細は [`retention.md`](retention.md)。

## <a id="skills-vs-project-config"></a>7. スキルとプロジェクト固有設定の責任分担

| Layer                                             | Content                  | Lifetime          |
| ------------------------------------------------- | ------------------------ | ----------------- |
| `~/.claude/skills/garelier-*`                    | フレームワーク本体           | フレームワーク版に従う |
| `<project>/AGENTS.md`                             | プロジェクト固有のルール       | プロジェクト版に従う  |
| `<project>/__garelier/<pm_id>/control/`                  | プロジェクト永続正本         | プロジェクト版に従う  |
| `<project>/__garelier/<pm_id>/runtime/`                  | 実行時状態                  | 走行中のスナップショット |
| `<project>/__garelier/<pm_id>/_*/CLAUDE.md`              | ロール識別子(最小)         | 初期化時に生成      |

## <a id="execution-backends"></a>8. 実行バックエンド (DEC-057 / DEC-061)

**Garelier の実行は dispatch のみ(DEC-061/066)** です — PM 対話セッション内の
サブエージェント(および Codex 割当ロールは `codex exec` subprocess)として
ロールを実行します。**headless driver(Mode B, `claude -p`)は削除済み
(DEC-066)** — コードもスクリプトも存在しません(経緯は decision record に
残ります)。provider 多様化(Codex)は dispatch producer として維持されます。
tick の決定的実行は jig(Mode E, DEC-062 — 既定 ON)が担います。

**モデルと effort はユーザの選択**で、フレームワークは効率のためにモデルを
降格しません(全ロール `opus`/`xhigh` も一級サポート)。上限到達で止まるのは
正しい挙動として許容します(容量ガバナは作りません)。

> **課金・利用規約は運用者の責任**です。Garelier はどの枠に課金されるかについて
> 保証も主張もせず、課金に関与する仕組みも提供しません。詳細は §2.2
> [課金と利用規約について](#billing-tos) を参照してください。

旧 `[execution] backend` 軸(`headless`/`codex`)は driver と共に廃止
されました。既存 config に残っていても無視されます(ロール単位の
`provider = "codex-cli"` は dispatch producer の割当として引き続き有効)。

効率化は「同じモデルのままトークンを減らす」方向 — prompt cache の安定プレフィックス、
コンテキストダイエット(DEC-049)、無駄イテレーション抑制、そして Status Web の
**Efficiency パネル**(tokens/iter・cache ヒット率・ロール別消費)で可視化します。

詳細は [`execution_backends.md`](execution_backends.md) を参照してください。
