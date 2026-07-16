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
```

`runtime/merge_gate/` の `archive/` はこの `[retention]` ブロックではなく
`[merge_gate] archive_keep_days`（既定 14）で保持されます（下記参照）。

## PM-owned

- `_pm/history.md` は hot index。active entry と最近の完了 entry だけを置く。
- 古い完了 entry は `_pm/history/archive/YYYY-MM.md` に月別分割する。
- `<!-- Next entry number: N -->` は hot file のみに置く。
- `## Archived history` に月別 archive と entry number range を書く。
- 再実行検索は hot file → archive の順で探す。
- 日報・定期 status・大量 Scout output は
  `control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md` を標準にする。
- raw dump / full log / generated cache は commit しない。summary、source path、
  count、sample、再現 command を inspection に残す。

## Dock / runtime

- `runtime/manifest.md` の Recent activity は last 10。
- `runtime/backlog/done/` は保持数/保持日数を超えたら
  `runtime/backlog/archive/YYYY-MM.md` に compact し、古い個別 runtime file を削除可。
- `pending.md`、`in_flight.md`、active inbox、lock、STATE は prune 禁止。

## Local archives

`runtime/merge_gate/archive/`、Worker/Scout/Smith/Librarian/Observer の
`archive/`、`_artisan/archive/`、`runtime/observer/results/` は gitignored です。
削除前に dry-run summary を出し、active task 参照がないことを確認します。

`runtime/merge_gate/archive/`（1 request につき `<stem>.request.json`）は
書込み時（読み取り時ではなく）に自動 prune されます。`[merge_gate]
archive_keep_days`（既定 14）より古い archive request を削除し、未解決
request や active lock が指す stem は保護するため、手動整理は不要です
（W-038）。

`runtime/merge_gate/results/`（1 request につき `.json` + `.summary.json`）は
書込み時（読み取り時ではなく）に自動 prune されます。`[merge_gate]
results_keep`（既定 40）件分の最新 request stem のみ保持し、未解決 request
や active lock が指す stem は保護するため、手動整理は不要です（W-030）。

`runtime/merge_gate/logs/`（1 request につき `<stem>.log`）も同様に書込み時に
自動 prune されます。`[merge_gate] logs_keep`（既定は `results_keep` と同値）
件分の最新 log のみ保持し、in-flight / active lock の stem を保護します。従来は
削除経路が無く単調増加していました（実測 137MB / 120 file の「log を永遠に
書き続ける」ディスク圧迫 class）。手動整理は不要です（W-030 fix）。

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
  なし — 実行中 producer が使用中 file を持ち得る）。
- `showcase/` → `gallery/` の昇格は user の明示指定でのみ。`gallery/` は
  TRACKED（バイナリは Git LFS）で本 retention の対象外 — user が残すと決めた
  成果物を保持する。
