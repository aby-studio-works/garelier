# Retention / 大量運用時の保持方針

> Operational source: `skills/garelier-core/retention.md`. Keep both in
> sync.

Garelier は毎日の日報、調査、benchmark、雑多な整理を大量に扱えるように、
「永続正本」と「普段読む hot index」を分けます。削除で監査性を落とすの
ではなく、月別 archive と summary で通常の読み込み量を抑えます。

## Defaults

```toml
[retention]
history_hot_entries = 120
history_archive_granularity = "month"
inspection_path_granularity = "month"
inspection_monthly_summary = true
runtime_archive_keep_days = 30
runtime_archive_keep_files = 300
role_local_archive_keep_days = 30
scratch_keep_days = 14
preserved_artifact_max_bytes = 65536
```

`runtime/merge_gate/` の `archive/` はこの `[retention]` ブロックではなく
`[merge_gate] archive_keep_days`（既定 14）で保持されます（下記参照）。

## PM-owned

- `_crew/pm/history.md` は hot index。active entry と最近の完了 entry だけを置く。
- 古い完了 entry は `_crew/pm/history/archive/YYYY-MM.md` に月別分割する。
- `<!-- Next entry number: N -->` は hot file のみに置く。
- `## Archived history` に月別 archive と entry number range を書く。
- 再実行検索は hot file → archive の順で探す。
- 日報・定期 status・大量 Scout output は
  `control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md` を標準にする。
- raw dump / full log / generated cache は commit しない。summary、source path、
  count、sample、再現 command を inspection に残す。

tracked `control/reports/gates/**/*.log` は原本の SHA-256 / byte 数と bounded excerpt
を持つ形式を既定とし、full raw bytes は `runtime/gate/preserved_raw/` に置きます。
legacy raw tracked log が残る tree は PM が次を preview → apply の順で一度だけ実行します:

```text
bun skills/garelier-core/driver/src/scripts/migrate_control_report_logs.ts --project <root> --pm-id <id> --inspection inspections/quality/YYYY/MM/YYYY-MM-DD-control-report-retention.md
bun skills/garelier-core/driver/src/scripts/migrate_control_report_logs.ts --project <root> --pm-id <id> --inspection inspections/quality/YYYY/MM/YYYY-MM-DD-control-report-retention.md --apply
```

inspection path は PM が選び、migrate 件数と tracked byte の前後値を記録します。
apply 済み migration の再実行は idempotent です。excerpt / raw pointer は手編集しません。

## Dock / runtime

- `runtime/manifest.md` の Recent activity は last 10。
- `runtime/backlog/done/` は保持数/保持日数を超えたら
  `runtime/backlog/archive/YYYY-MM.md` に compact し、古い個別 runtime file を削除可。
- `pending.md`、`in_flight.md`、active inbox、lock、STATE は prune 禁止。

`runtime/control/locks/recovery_epochs/` の固定 directory は recovery election
ledger です。current/highest epoch は常に削除禁止です。older released epoch は、
strict な `owner.json` と `released.json` の epoch、token、PM、journal
generation/hash、operation、result がすべて一致するときだけ prune できます。
older unreleased epoch は、strict owner が same-host の dead process で、同じ PM /
journal に bind され、正確な stale namespace-token lineage が current epoch に
継承済みの場合だけ prune できます。別の recovery audit file は retention authority
ではなく、epoch prune の必須条件でもありません。

対象の older epoch は current/highest を保ったまま、最初に
`runtime/control/locks/recovery_epoch_staging/` へ atomic move し、移動後の内容を
再検証してから削除します。これにより count 境界で election room を確保し、再帰
cleanup 中の crash 残骸を authoritative ledger の外に残します。epoch の gap は
有効で、次の番号は常に `max(epoch)+1` です。crash-left election、release-marker、
prune staging entry は election authority ではなく、canonical epoch ではないことと
live recovery process の所有物ではないことを証明した場合だけ整理できます。

## Local archives

未知の dispatch artifact と gate run record は、tracked な
`control/reports/gates/<W-N>/dispatch<N>/` へ公開する前に一括で security admission
を受けます。secret / PII / prompt-injection registry、customer-data marker、
provenance 条件を検査し、binary・検査不能な文字列・欠落/空/不正な pattern registry
は拒否します。非 CLEAN の batch は source を削除せず、redacted な判定記録だけを
`runtime/land_aftercare/preservation_admissions/` に残します。

CLEAN の bytes は `artifacts/<encoded-path>/payload` と
`run_records/<encoded-name>/payload` の別 namespace へ保存し、
`security_admission.json` を添えます。UTF-8 path の lowercase hex 分割により
`lane/a` と `lane-a`、未知 leaf と run record の衝突を防ぎます。既存 destination
は bytes が同一の場合だけ再利用し、異なる証拠を上書きしません。全件を
`land_aftercare: PRESERVED …` で通知します。symlink / reparse guard と W-741 の
専用 `gate-step4-<sha12>.log` 保全順序は引き続き必須です。

`runtime/merge_gate/archive/`、Worker/Scout/Smith/Librarian/Observer の
`archive/`、`_crew/artisan/archive/`、`runtime/observer/results/` は gitignored です。
削除前に dry-run summary を出し、active task 参照がないことを確認します。

`runtime/merge_gate/archive/`（1 request につき `<stem>.request.json`）は
書込み時（読み取り時ではなく）に自動 prune されます。`[merge_gate]
archive_keep_days`（既定 14）より古い archive request を削除し、未解決
request、active lock、aftercare journal evidence が指す stem は保護します。
aftercare pair は journal authority が存在する間 pin され、successful aftercare は
dispatch container を既に削除済みです。

`runtime/merge_gate/results/`（1 request につき `.json` + `.summary.json`）は
書込み時（読み取り時ではなく）に自動 prune されます。`[merge_gate]
results_keep`（既定 40）件分の最新 request stem のみ保持し、未解決 request
や active lock が指す stem は保護するため、手動整理は不要です（W-030）。

`runtime/merge_gate/logs/`（1 request につき `<stem>.log`）も同様に書込み時に
自動 prune されます。`[merge_gate] logs_keep`（既定は `results_keep` と同値）
件分の最新 log のみ保持し、in-flight / active lock の stem を保護します。従来は
削除経路が無く単調増加していました（実測 137MB / 120 file の「log を永遠に
書き続ける」ディスク圧迫 class）。手動整理は不要です（W-030 fix）。

`runtime/gate/preserved_raw/dispatch<N>/` と `runtime/gate/run_records/` は、
一つの自動 WRITE-time retention owner を共有します。`gate_runner` は run record
書込み後に、二つの preservation publisher は raw evidence 公開後に owner を実行
します。denominator は両 subtree の unpinned regular file 全体です。
`runtime_archive_keep_days` より古い file、または新しい
`runtime_archive_keep_files` 件から外れた file を退役させます。既存の
`_crew/dispatch<N>/` container または non-terminal land-aftercare journal から
参照される evidence は pin し、age / count の両上限から除外します。journal / run
record が読めない、または malformed の場合、disposable と推定せず evidence を
保持します。このため PM-step raw log、oversized raw artifact、gate run record は
同じ trigger・denominator・pin 規則に従います。

`[retention].preserved_artifact_max_bytes` は tracked preservation artifact 一つの
実 byte 上限です（既定 65536、最小 256 byte）。最小値未満は
`preserved_artifact_bound_too_small` として config load 時に拒否し、truncation
marker と raw runtime pointer が上限外へはみ出す設定を受理しません。

`runtime/driver/usage/YYYY-MM.jsonl`（Output Control の usage summary, DEC-028）は
月別分割で、傾向を確認後に `runtime_archive_keep_days` 方針で古い月を整理できます。
`runtime/driver/logs/` の JSONL は driver が size rotation（`driver_log_max_bytes` /
`driver_log_keep_files`）し、keep 数を超えた `.N` は自動削除されます。

`runtime/pm/scratch/`（attended PM とその配下 agent の手動 verify log /
screenshot / 使い捨て作業 file）は agent 所有の ephemeral で、単調増加する
唯一の未 prune path でした（実測 32MB）。`[retention] scratch_keep_days`
（既定 14、`0` で無効）より古い entry を age prune できますが、merge-gate 系と
違い**自動 driver hook は持ちません**。実行中の PM が使用中の scratch を持ち得る
ため、dry-run first の手動操作です。preview → 削除:
`bun skills/garelier-core/driver/src/scratch_retention.ts --project <root>
--pm-id <id>`（dry-run: 候補と byte を表示）、`--apply` で実削除（W-084(d)）。

## Showcase 成果物 (W-085)

`__garelier/<pm_id>/showcase/` は格納先未定の user 向け成果物（スクショ / audio
preview / render 比較）の既定ドロップ先。**gitignore** され、`runtime/` と同じ
transient 規律に従う:

- file は必ず subfolder（`showcase/<topic>/…`）に置き、`showcase/` 直下には
  置かない。
- retention は `runtime/` に準拠: ephemeral 扱いで `[retention]
  scratch_keep_days` と同じ姿勢で age prune（dry-run first、自動 driver hook
  なし — 実行中 role が使用中 file を持ち得る）。
- `showcase/` → `gallery/` の昇格は user の明示指定でのみ。`gallery/` は
  TRACKED（バイナリは Git LFS）で本 retention の対象外 — user が残すと決めた
  成果物を保持する。
