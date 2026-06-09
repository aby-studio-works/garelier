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
merge_gate_archive_keep_days = 14
role_local_archive_keep_days = 30
```

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

`runtime/driver/usage/YYYY-MM.jsonl`（Output Control の usage summary, DEC-028）は
月別分割で、傾向を確認後に `runtime_archive_keep_days` 方針で古い月を整理できます。
`runtime/driver/logs/` の JSONL は driver が size rotation（`driver_log_max_bytes` /
`driver_log_keep_files`）し、keep 数を超えた `.N` は自動削除されます。
