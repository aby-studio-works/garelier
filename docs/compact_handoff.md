# Compact Handoff

> 運用上の正本: `skills/garelier-core/compact_handoff.md`。このファイルは
> 人間向けの説明です。両者を同期させ続けてください。

Garelier は内部の role 間の状態には常に compact handoff を使用します。
これにより、PM、Dock、Worker、Scout、Smith、Artisan、Librarian、Observer
の判断に必要な事実を保ちつつ、繰り返されるコンテキスト読み込みを削減します。

## Scope

Compact handoff は、runtime の状態、inbox の通知、assignment、report、
質問、回答、review、manifest のアクティビティ、および backlog の handoff
ファイルに適用されます。

これは、ユーザー向けの返信、公開ドキュメント、ソースコード、シェル
コマンド、エラーメッセージ、識別子、URL、パス、データ変更の証跡、
あるいは圧縮すると曖昧さが生じる警告を、自動的に書き換えることは
しません。

## Rules

- 1 行につき 1 つの事実。
- 貼り付けたコンテキストよりも参照を優先する: `path:line`、task id、commit
  SHA、report のパス。
- **アーティファクトの本文を決して貼り付けない**(diff、report の全文、blueprint、
  inspection、Observer の report、`result.json`)を handoff や
  inbox ファイルに入れない。結論 + `read:` のポインタを持ち運び、本文は
  その公式ファイルに残す。本文を埋め込むとトークンを浪費し(読み手全員が
  再取り込みする)、正本ではない 2 つ目のコピーを作ってしまう。
- 正規の用語を正確に保つ: `target`、`studio`、`workbench`、`anvil`、
  `blueprint`、`inspection`、`promote`、`control`、`runtime`。
- コードシンボル、パス、コマンド、URL、エラーテキスト、数値、日付、
  および commit SHA を正確に保つ。
- 次の role が必要としない作業日誌、賞賛、謝罪、理由づけは削除する。
- アクション、リスク、順序、責任が変わってしまう箇所のみ展開する。
- トークンを節約するためにリスクを隠してはならない。

## Preferred Shapes

Assignment:

```text
goal: <one outcome>
read:
- <path> (<section or lines>)
do:
- <action>
AC:
- [ ] <checkable criterion>
stop:
- <condition requiring BLOCKED>
out:
- <expected file/commit/report>
```

Report:

```text
result: <one-line outcome>
diff:
- <path> -- <effect>
AC:
- [x] <criterion> -- <evidence>
QG:
- `<command>` -- pass|fail -- <short evidence>
risks:
- none | <remaining risk>
next:
- none | <follow-up>
```

Inbox:

```text
from/to: <sender> -> <recipient>
type: <state|question|escalation|status|request|schedule>
task: #<id> | N/A
read: <path>
ask: <single requested action>
urgency: low|normal|high
```

Receiver test: 次の role は、compact handoff と参照されたソースファイルを
読めば行動できなければなりません。

Reading rule(節約が実現される箇所): 監督的な読み手
(PM、Dock)は結論 + ポインタに基づいて行動し、その判断が内容を必要と
するときにのみ参照先のアーティファクトを開く。実行する読み手は現在の
タスクが必要とするアーティファクトのみを開く。すでに消費したものでは
なく、現在の handoff に基づいて行動すること。
