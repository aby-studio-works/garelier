# Garelier Knowledge Contract

これは、フル機能の Garelier の Librarian と、スタンドアロンの `garelier-control-library` skill によって使用される、正規の knowledge 管理契約です。

## Storage

追跡され、キュレーションされ、共有される knowledge:

```text
docs/garelier/
├── knowledge/
│   ├── knowledge.toml
│   ├── role_index.toml
│   ├── source_registry.toml
│   └── routine_registry.toml
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

`garelier-control-library` が、他に明確な namespace なしで使用される場合は、デフォルトのステージング用 `pm_id` として `_workshop` を使用します。複数の namespace が存在する場合、AI はそれらを列挙し、どのステージング/管理コンテキストを使用するかを尋ねなければなりません。決して暗黙のうちに 1 つを選択してはなりません。raw/cache/drafts/reports は gitignore されており、決してエクスポートされません。

## Knowledge identity

`docs/garelier/knowledge/knowledge.toml` がスキーマを識別します:

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

**knowledge ツリーを一括で読み込まないでください。** ツリー全体の読み込みは context を浪費し、有効なルールを特定しにくくします。段階的に取得してください:

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
6. レビュー済みで、ライセンス上クリーンで、オリジナルの表現の knowledge のみを `docs/garelier/` に移動する;
7. キュレーション済みの knowledge のみをコミットする。

追跡され、レビュー済みで、secret/PII がクリーンな knowledge のみをエクスポートします。runtime の作業データは決してエクスポートしないでください。
