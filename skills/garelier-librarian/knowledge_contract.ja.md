# Garelier Knowledge Contract

これは、フル機能の Garelier の Librarian と、スタンドアロンの `garelier-control-library` skill によって使用される、正規の knowledge 管理契約です。

## Storage

Garelier の knowledge は、いずれも `__garelier/` 配下の **2 つの追跡レイヤー**に格納されます(DEC-077)。knowledge はプロジェクト自身の `docs/` には決して置かれません。

**共有レイヤー(追跡)— `__garelier/__atmos/knowledge/`。** 汎用の `__atmos` 共有ティアであり、knowledge はその下の 1 つのテナントです。これはプロジェクト全体・pm 非依存のレイヤーで、`knowledge_id` の衝突時に既定で優先されます。共有が決まったときにオンデマンドで作成され、初回セットアップでは存在しません。レジストリ・カテゴリ・role ツリーが `knowledge/` 直下に並びます:

```text
__garelier/__atmos/knowledge/
├── knowledge.toml
├── role_index.toml
├── source_registry.toml
├── routine_registry.toml
├── <category>/
│   ├── index.md
│   └── <topic>.md
├── runbooks/
└── manuals/
```

**per-pm レイヤー(追跡)— `__garelier/<pm_id>/knowledge/`。** セットアップ時にシードされる作業用の knowledge ホームで、`control/` と `runtime/` の兄弟であり、共有レイヤーと同じ knowledge の形を使います。ここでの「パーソナル」とはプライバシーではなくスコープ(この pm_id か共有か)を意味します: git で追跡され、`control/` と同様に promote を通じて `<target>` に到達します。

```text
__garelier/<pm_id>/knowledge/
├── knowledge.toml
├── role_index.toml
├── source_registry.toml
├── routine_registry.toml
├── <category>/
│   ├── index.md
│   └── <topic>.md
├── runbooks/
└── manuals/
```

ローカル専用の作業データ:

```text
__garelier/<pm_id>/runtime/librarian/
├── raw/
├── cache/
├── drafts/
└── reports/
```

`garelier-control-library` が、他に明確な namespace なしで使用される場合は、デフォルトの per-pm `pm_id` として `_workshop` を使用します。複数の namespace が存在する場合、AI はそれらを列挙し、どのステージング/管理コンテキストを使用するかを尋ねなければなりません。決して暗黙のうちに 1 つを選択してはなりません。raw/cache/drafts/reports は gitignore されており、決してエクスポートされません。

`__garelier/` 配下では、`__`(二重アンダースコア)接頭辞は共有 / 非 pm の namespace 用に予約されており、`__atmos` は構造的に決して pm になりません — pm であることは `_pm/setup_config.toml` の存在を要件とするため、doctor/status の pm 自動判定や pm 内のコンテナ走査が `__atmos` を pm として列挙することはありません。pm X として動作する role は `[共有 __atmos, この pm]` のみを読み、他の pm のレイヤーは決して読みません。

早見表 — knowledge の所在:

| 場所 | 役割 |
| --- | --- |
| `__garelier/__atmos/knowledge/` | プロジェクト全体の共有 knowledge(競合時の正準)。 |
| `__garelier/<pm_id>/knowledge/` | この pm の追加(additive)knowledge レイヤー。 |
| `docs/rules/` | 人間・プロジェクト向けの rules ミラー/成果物。knowledge store ではない。 |

## Layered resolution

knowledge は、共有レイヤーの上に追加(additive)される per-pm レイヤーを持つようになりました(DEC-077)。解決は **shared-priority + per-pm-additive** です:

- pm X として動作する role は、レイヤーリスト `[__garelier/__atmos/knowledge(共有), __garelier/<pm_id-X>/knowledge(pm)]` を読み、他の pm のレイヤーは決して読みません。
- `role_index.toml` のエントリは 2 つのレイヤーをまたいで(共有を先に)和集合(union)されます。
- `knowledge_id`(`<category>.<topic>`)が衝突した場合、**既定では共有レイヤーが勝ちます**。per-pm レイヤーは原則として追加(additive)で、共有レイヤーに存在しない id を ADD します。唯一の例外は、明示的で監査可能なトピック単位のオプトインです: per-pm トピックの YAML フロントマターに `override_shared: true` が設定されている場合、その `knowledge_id` についてのみ per-pm が共有コピーに勝ちます。このフラグがなければ二次レイヤーは追加(additive)であり上書き(override)ではありません — これが「ルールの意味を**決して暗黙に**変えない」という厳格な不変条件を守る仕組みです。
- グラフバリデータは両方のレイヤーに対して実行され、per-pm の id が共有の id と衝突した場合に `shadowed-by-shared` を警告します。ただし per-pm トピックが `override_shared: true` を設定している場合は、その上書きは意図的で尊重されるため警告しません。
- knowledge バンドルは、両方のレイヤー(共有 `__atmos` レイヤーと per-pm レイヤー)に加えてプロジェクト自身の `docs/rules/` ルールツリーを、git 追跡済みかつ秘密情報/PII を含まない内容に限ってエクスポートします。

## Knowledge identity

`__garelier/__atmos/knowledge/knowledge.toml` がスキーマを識別します(同じマーカーファイルが `__garelier/<pm_id>/knowledge/knowledge.toml` で per-pm レイヤーを識別します):

```toml
schema_version = 1
kind = "garelier_knowledge"
```

## Standard knowledge document

新規またはマテリアルに更新されたすべてのキュレーション済みトピックドキュメントは、YAML front matter を使用します:

```markdown
---
knowledge_id: <category>.<topic>
title: <human title>
category: <category>
status: active
owners:
  - <policy/knowledge owner>
consumers:
  - <role or audience>
source_ids:
  - <registered source id or project-original>
last_reviewed_at: YYYY-MM-DD
review_cycle: on-change
---
```

必須の本文セクション:

```markdown
# <Title>

## Purpose
## Rules
## Application
## Exceptions and escalation
## References
```

外部 source を持たないオリジナルのプロジェクト knowledge には、`source_ids: [project-original]` のセマンティクスを使用します。外部 source の id は `source_registry.toml` に存在しなければなりません。権利/provenance ポリシーは引き続き適用されます。

index ドキュメントは正規の knowledge-index テンプレートを使用し、そのカテゴリ内のすべての正規トピックをリンクします。runbook は正規の runbook テンプレートを使用し、`routine_registry.toml` に登録されます。

## Retrieval

**knowledge ツリーを一括で読み込まないでください。** ツリー全体の読み込みは context を浪費し、有効なルールを特定しにくくします。両方のレイヤー(共有を先に、次にこの pm のレイヤー)をまたいで解決しながら、段階的に取得してください:

1. 有効な role/対象者に対応する `role_index.toml` のエントリ(存在する場合)。あわせてその `[[triggers]]` エントリ(DEC-067)もマッチさせます: `when` のパス glob / キーワードを、タスクのテキストと触れたパスに対して照合し、マッチした `read` ドキュメントがそのタスクの read-first セットに加わります(reviewer は diff に対して照合します)。
2. 関連するカテゴリの `index.md`。
3. 派生グラフ/レジストリを参照して、関連しそうなトピックファイルと関係を特定します。グラフにはメタデータ/ポインタが含まれ、ドキュメント本文は含まれません。
4. 候補ファイルを正確な用語/見出しで検索し、その後、関連するセクション/範囲のみを読みます。
5. タスクにそのトピックの構造または完全なルールセットが必要な場合にのみ、トピックドキュメント全体を開きます。
6. 通常の index で答えが得られない場合は、まずキュレーションされた index/メタデータに対する広範な knowledge クエリを行い、その後、範囲を限定したトピック検索を行います。

本文を貼り付けるのではなく、コンパクトなポインタ(`path:line` と 1 行の結論)を返します。キュレーションされた knowledge が質問をカバーしていない場合は、その旨を述べてください。答えをでっち上げたり、登録されていない source を暗黙のうちに採用したりしてはなりません。

Retrieval バジェット:

- まず多くても role エントリ 1 つ、カテゴリ index 1 つ、グラフのメタデータから始めます。
- 答えられる最小の候補トピックファイルのセットへと拡張します。
- 「網羅性のために」無関係なカテゴリを読まないでください。
- 質問に答える十分な権威あるポインタが得られたら、検索を停止します。

## Maintenance

- knowledge オーナーが意味を決定します。メンテナンスを行う AI は、承認された変更を整理して適用します。
- オリジナルのプロジェクトの表現を保持します。承認された権利上の根拠なしに、外部の表現や構造をコピーしてはなりません。
- カテゴリ index、`role_index.toml`、source ターゲット、routine マニュアル、および参照されるファイルを相互に整合させ続けます。
- reachability（到達可能性）: 新規 doc は必ず read path を伴って出します — index の Consumption-rules「いつ読むか」行に加え、仕事が触れる対象に応じて surface すべきなら `role_index.toml` の narrow な `[[triggers]]` entry。どちらにも拾われない doc は orphan（出荷されても読まれない）です。reach のためだけに `read_first` へ昇格しないこと（token 予算の分割に逆行します）。詳細は `role_index.toml` の header（DEC-090）。
- 派生グラフ/バリデータを使用して、宙ぶらりんの参照やフォーマットのドリフトを見つけます。
- 1 つの一貫した knowledge の成果を、そのレジストリ/index の更新および検証の証跡とともにコミットします。

## Import and export

クリーンなバンドルには `knowledge_import` / `knowledge_export` を使用します。

雑然とした入力:

1. `runtime/librarian/raw/` 配下にステージングする;
2. provenance、権利、コンフリクト、候補カテゴリをインベントリ化する;
3. 正規のテンプレートを使用して `runtime/librarian/drafts/` 配下にドラフトを作成する;
4. 採用前に source を登録する;
5. knowledge グラフを検証し、宙ぶらりん/コンフリクトする参照を解決する;
6. レビュー済みで、ライセンス上クリーンで、オリジナルの表現の knowledge のみを、この pm の `__garelier/<pm_id>/knowledge/` レイヤー(既定の、シード済み作業用ホーム)に移動する。プロジェクト全体で共有すると利用者が明示的に決めたときにのみ、共有レイヤー `__garelier/__atmos/knowledge/` に昇格する(無ければ `__atmos` ティアをオンデマンドで作成)。この書き込み先の選択は、`knowledge_id` 衝突時に共有レイヤーが勝つという読み取り時のルールとは別である;
7. キュレーション済みの knowledge のみをコミットする。

追跡され、レビュー済みで、secret/PII がクリーンな knowledge のみをエクスポートします。runtime の作業データは決してエクスポートしないでください。
