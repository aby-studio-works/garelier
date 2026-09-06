# Garelier Control 契約

永続的なプロジェクト管理を始める時の短いルーターです。まずこの文書を読み、
`control.toml`で選ばれたschema固有契約だけを追加で読みます。

## Authority

- 永続正本: `__garelier/<pm_id>/control/`
- session、claim、lock、journal、cache、diagnostic、生成view:
  `__garelier/<pm_id>/runtime/control/`
- 第3の永続`state/` treeは作りません。
- runtimeはtracked authorityから再構築可能でなければならず、cache更新で
  authorityを書き換えてはいけません。

## Schema routing

directoryの有無ではなく、`control.toml`のschema/storage組を厳密に使います。

| Canonical schema | Storage | 読む契約 |
| --- | --- | --- |
| 3 | `plan_graph_markdown` | `plan_graph_contract.md` |

schema 3と`plan_graph_markdown`の組合せだけを受理し、それ以外はfail-closedです。
runtime record、CLI envelope、bundle manifestのprotocol versionは
control schemaとは別管理し、必要箇所に`control_schema_version`を持たせます。

## 読み書き

- query、graph、validator、Status Web、import/export、resumeはschema-3
  plan graph modelを使います。
- 読取はboundedかつdeterministicです。省略時は件数と追跡queryを返します。
- current position、blocker、exact next actionを「ない」ように省略しません。
- schemaが許す直接authoringは、strict parse/validation後にauthorityです。
- helper mutationはexpected revision/hash、namespace lock、staged strict reload、
  generation journal、atomic replacement、rollback/recoveryを使います。
- runtime claimはlive占有、tracked Checkpointはdurable resumeです。
- schema 3 Backlogの`title`はrecord H1の`# W-NNN:`直後にある空でない全文です。
  parserがこの1つの投影をtask mirror、Status、`control cockpit`へ渡します。
  Current positionとExact next actionはresume情報であり、title代替にはしません。
  identity prefix導入前のH1はmigration用にreadableのまま`legacy_import`へ数えます。
  identityが不一致のH1はmalformedとしてfail-closedします。
- `control cockpit [--top-n N]`はschema 3専用のread-only/deterministic viewです。
  sampleはbounded、countは完全です。canonical Checkpoint/Backlog focusと
  `landed_state_drift`、`focus_drift`、`missing_ac`、`legacy_import`、
  `unblocked_ready`、warning、cleanup、incident、bypass、malformed-rowを返します。
  malformed Backlog rowは不可視にせず表示し、commandをfail-closedにします。
- `control backlog triage-batch --plan/--apply --file <toml>`はreview済みdecisionを
  検証・適用するだけで、decisionを作りません。TOML rootは
  `schema_version = 1`、`kind = "garelier_backlog_triage_batch"`、
  `reviewed_by`、`reviewed_at`、1件以上の`[[decision]]`を必須とします。
  各decisionは`id`、`action`、`expect_revision`をbindします。`keep`はno-op、
  `transition`は有効なnonterminal `to`、`cancel`は`reason`、
  `supersede`は`reason`と既存`replacement`が必要です。未知key/ID/action、
  duplicate、stale revision、不正lifecycle、malformed TOMLは書込前にbatch全体を
  拒否します。applyはplan digestとControl revisionも要求し、全rowを1回の
  Control file-plan transactionで処理し、terminal actionはcanonical archiveへ移します。
- CLIはcommitしません。責任roleがgate後にcoherent commitを作ります。

## 完了条件

schema変更はmodel、validator、query/resume、graph、CLI、Status Web、
import/export、scaffold、skills、role文書がschema 3で一致し、非正規形式の拒否test、
framework CI、Guardian、Observerがすべて通った時だけ完了です。
