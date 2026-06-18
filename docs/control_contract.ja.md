# Garelier Control Contract

これは、full Garelier と `garelier-control-project` の両方で使われる、永続的なプロジェクト管理のための正規の契約です。

`garelier-control-library`、bundle ツール群、検証、派生グラフと併せて、これらが **Garelier Control** を構成します。すなわち、スタンドアロンの管理プレーンです。小さな starter はその最小デプロイモードです。full Garelier は、この control プレーンを置き換えることなく、実行 role、lane、branch、runtime、driver を追加します。

## Location and identity

永続的な authority は次の場所に存在します:

```text
__garelier/<pm_id>/control/
```

すべての control tree は `control.toml` を持ちます:

```toml
schema_version = 1
kind = "garelier_control"
pm_id = "<pm_id>"
mode = "full" # full | control_only
```

`_workshop` は単一ユーザープロジェクトのデフォルトの `pm_id` です。これは小さな starter と full Garelier の両方で有効であり、Artisan および dock lane を含みます。full setup は既存の `_workshop` control-only namespace をその場でアップグレードします。共有または複数ユーザーのプロジェクトでは、明示的で一意な `pm_id` を選択しなければなりません。`_workspace` を使ってはいけません。`workspace` は `runtime` の非推奨エイリアスです。

兄弟ディレクトリの `__garelier/<pm_id>/runtime/` は一時的であり、gitignore されています。そこに永続的な authority を置いてはいけません。

## Canonical layout

```text
control/
├── control.toml
├── README.md
├── project_dashboard/
│   ├── README.md
│   ├── current.md
│   ├── roadmap.md
│   ├── backlog.md
│   ├── decisions.md
│   ├── risks.md
│   ├── quality_gates.md
│   └── notes.md
├── milestones/<slug>.md
├── blueprints/<slug>.md
├── decisions/DEC-NNN-<slug>.md
├── operations/
├── inspections/
├── observations/
├── reports/
│   ├── handoffs/
│   └── diagnostics/
├── delegation/
├── request_intake/
├── scheduled_jobs/
└── templates/
```

正規の scaffold と artifact テンプレートは `skills/garelier-core/templates/control_scaffold/` にあります。それらを使ってください。セッションローカルなフォーマットを発明してはいけません。

## Authority and hot-file rules

authority は、高い順に:

1. 明示的なユーザー指示;
2. `operations/` の安全ポリシーと `project_dashboard/quality_gates.md`;
3. 受理された `decisions/` レコード;
4. アクティブな milestone、blueprint、および dashboard の状態;
5. `project_dashboard/notes.md`。

dashboard ファイルは短い現在状態のサーフェスです:

- `current.md`: アクティブなフォーカス、次のアクション、blocker。完了ログは含みません。
- `roadmap.md`: 方向性、および正規の milestone ファイルへのリンク。
- `backlog.md`: 未着手の作業のみ。完了済み/チェックマーク付きの項目を保持してはいけません。
- `decisions.md`: 正規の decision ファイルのインデックスであり、decision 本文の二重管理ではありません。
- `risks.md`: アクティブな risk のみ。クローズした risk は解決するコミットで削除します。
- `notes.md`: 一時的なスクラッチ。速やかに昇格するか削除します。

削除された完了済み backlog 項目や、過去の hot-file の状態のアーカイブは git history です。

dashboard のスキーマは意図的に JIRA や Redmine より小さくしてありますが、推測なしに作業をインポート、エクスポート、ソート、再開するために必要なフィールドは保持しています。正規の scaffold は厳密な見出しとテーブルヘッダーを定義します。既存のプロジェクトは段階的に移行できます。validator は非標準の dashboard 構造を警告として報告する一方、必須ファイルの欠落と完了済み backlog エントリはエラーのままです。並行する `docs/project_dashboard/` も移行負債として報告されます。`docs/` はプロジェクトを説明してよいですが、第二の管理 authority ではありません。decision の本文は `control/decisions/` 配下に属し、並行する `docs/decisions/` 配下に置いてはいけません。

## Artifact formats

### Milestone

Path: `milestones/<slug>.md`。必須の identity フィールド:

```markdown
# Milestone: <title>

## Identity

- Slug: `<slug>`
- Status: planned | active | shipped | abandoned
- Started: YYYY-MM-DD | -
- Target: YYYY-MM-DD | -
- Shipped: YYYY-MM-DD | -
```

残りの必須セクションには正規の milestone テンプレートを使ってください。

### Decision

Path: `decisions/DEC-NNN-<slug>.md`。必須の identity フィールド:

```markdown
# DEC-NNN: <title>

- Date: YYYY-MM-DD
- Status: proposed | accepted | superseded | rejected
- Scope: <boundaries>
- Supersedes: <decision id or none>
- Related: <paths or none>
```

本文には `## Context`、`## Decision`、`## Consequences` を含めなければなりません。

### Backlog

`project_dashboard/backlog.md` は単一の未着手作業テーブルを使います:

```markdown
| ID | Type | Priority | Status | Owner | Milestone | Outcome | Acceptance | Detail |
```

- ID: 安定した `W-NNN`(後述の *ID numbering* を参照)。ID を再利用してはいけません。
- Type: `feature | bug | maintenance | research | decision | docs`。
- Priority: `critical | high | normal | low`。
- Status: `triage | ready | blocked | deferred`。
- Owner: 責任を負う role または人物、未割り当ての間は `-`。
- Milestone: 正規の milestone slug/path、または `-`。
- Outcome: アクティビティの説明ではなく、簡潔な結果。
- Acceptance: 受理基準、issue、blueprint へのポインタ、または `-`。
- Detail: 厳密な path、issue URL、commit SHA、その他の安定したポインタ。

完了済みの `[x]` 行を使ってはいけません。作業が完了したら、同じコミットでその行を削除します。

### ID numbering

すべての連番 ID — `DEC-NNN`、`W-NNN`(backlog)、`R-NNN`(risks)、`J-NNN`(scheduled jobs)、PM history `#NNN`、および merge-gate の `<seq>` — は、件数が大きくなってもツールが正しく動作するよう、1 つのルールを共有します:

- `NNN` は **最小 3 桁にゼロ埋めされた**十進カウンタで、3 桁を超えて自然に増えます(`-009`、`-099`、`-100`、`-1000`、`-100000`)。**固定幅も上限もありません**。
- ID は **単調増加であり、決して再利用されません**。
- 上限のないパターン(`-[0-9]{3,}` または `-\d+`)で **マッチ** します。`-\d{3}` のような固定桁数は決して使わないでください。これは 4 桁以上の ID を黙って取りこぼします。
- **数値として** ソート・比較します(`sort -t- -k2 -n`、または `parseInt`)。`-1000` が `-999` より前に並ぶような辞書順は決して使わないでください。
- 切り詰めのない最小幅パディングで **フォーマット** します(`String(n).padStart(3,"0")`)。

スクリプト、lint、driver はこれらのルールに従うので、大きな ID 件数でもマッチング、パディング、順序付けが壊れません。

### Other dashboard files

- `current.md`: `Active focus`、`Next actions`、`Blockers`、`Read first`。
- `roadmap.md`: `Direction`、`Active milestones`、`Planned milestones`、`Out of scope`。milestone の詳細は `control/milestones/` 配下に存在します。
- `decisions.md`: `ID | Status | Title | Record` を持つ `Decision index` テーブル。
- `risks.md`: `ID | Severity | Likelihood | Risk | Trigger | Mitigation | Owner | Detail` を持つ `Active risks` テーブル。
- `quality_gates.md`: `ID | Scope | Command | Required` を持つ `Required commands` テーブル、加えて再利用可能な `Review conditions`。
- `notes.md`: `ID | Note | Promote to | Review by` を持つ一時的な `Scratch` テーブル。

意図的に空のフィールドには `-` を使ってください。基盤となる正規の artifact を書き換えることなく dashboard の状態を issue tracker へ移行できるよう、ファイル横断の ID とポインタを安定させてください。

## AI operating contract

AI がプロジェクトの管理を依頼されたとき:

1. 要求された `pm_id` を解決します。何も指定されておらず、他にアクティブな control namespace も明らかでない場合に限り `_workshop` を使います。複数の namespace が存在する場合は、それらの id/mode を列挙してどれを管理するかユーザーに尋ねます。決して黙って最初のものや `_workshop` を選ばないでください。
2. `control.toml`、この契約、`project_dashboard/README.md`、それから関連する hot ファイルと正規の artifact を読みます。
3. decision や plan がセッションをまたいで残らなければならないときは、永続的な control 状態を更新します。runtime ステージングは一時的に保ちます。
4. 貼り付けたコンテキストの代わりにポインタを使います。
5. 管理/インポート/エクスポートタスクが完了したと主張する前に、control tree を検証します。

## Control-only handoff and diagnosis

`garelier-control-project` は、compact handoff と control-only diagnosis を project-control の手順として含みます。これらは別個の skill、role、lane、driver 機能ではありません。

- compact handoff は再開サーフェスとして `project_dashboard/current.md` を更新し、より長い永続的な handoff レポートを `reports/handoffs/` 配下に置くことがあります。
- control-only diagnosis は control tree の健全性をチェックし、永続的な diagnostic レポートを `reports/diagnostics/` 配下に置くことがあります。
- いずれの手順も、role を起動したり、worktree を作成したり、`lane.lock` を取得したり、promote を承認したり、Concierge を dispatch したりすることはありません。

## Upgrade to full Garelier

control-only namespace は意図的な開始状態であり、部分的または失敗した full setup ではありません。同じ `pm_id` で `garelier-pm` の fresh setup wizard を実行すると:

1. 既存の `control/` artifact とプロジェクト知識を保持します;
2. full な runtime、role home、branch、設定、lane を追加します;
3. `control.toml` の mode を `control_only` から `full` へ変更するだけです。

アップグレード後、driver と両 lane は引き続き同じ `pm_id` を使います。

## Consolidation and splitting

control authority は、正規のフォーマットを変えることなく PM namespace 間で再編成できます:

- consolidation は、意味的な調整のために複数のソース control を 1 つの宛先へステージングします;
- splitting は、1 つのソースから明示的なサブセットを別の宛先へステージングします。

どちらの操作もソース namespace を保持し、まず宛先の runtime ステージングへ書き込み、自動上書きを避け、永続的な昇格の前に検証とレビューを必要とします。これらは `control/` authority のみを再編成します。full-PM の runtime、role、branch、worktree、lane には別途明示的な移行が必要です。

## Import and export

クリーンな control bundle は `control_export` / `control_import` を使います。runtime は常に除外されます。import はソースの `control.toml` を移植しません。既存の宛先マーカーを保持するか、宛先固有の `control_only` マーカーを作成するので、インポートされた authority が誤った `pm_id` を主張することは決してありません。

雑然とした外部入力の場合:

1. 生データを `__garelier/<pm_id>/runtime/import/raw/` にステージングします。
2. ソースと曖昧さを `runtime/import/reports/` に棚卸しします。
3. 正規のテンプレートを使って `runtime/import/drafts/` でドラフトを正規化します。
4. 衝突と検証のチェックを dry-run します。
5. レビュー済みで永続的な artifact のみを `control/` へ移動します。
6. 正規化された control の変更をコミットします。デフォルトでは生入力を決してコミットしません。

## Commit checkpoints

一貫性があり、レビュー可能で、リバート可能な永続的成果ごとにコミットします:

- 実装、関連するテスト、対応する control 更新をまとめて含めます;
- 完了した backlog 行をその同じコミットで削除します;
- 先に関連する quality gate を実行します;
- ユーザーが明示的にチェックポイントを要求しない限り、タイムスタンプのみ、フォーマットのみ、壊れた、WIP のコミットを避けます;
- 無関係な成果は別々のコミットに保ちます。
