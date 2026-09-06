# 常駐 process の health 判定と operator recovery

shared process 障害を code failure と判断する前に、次の read-only preflight を使う。

```bash
bun skills/garelier-core/driver/src/scripts/resident_process_health.ts \
  --project <control-root> --pm-id <pm-id> --format text
```

`--project` には `__garelier/` を所有する resolved Garelier control root を渡す。
Plant-Crust では `target/` 配下の target repository ではなく container/control root
である。sccache、Status Web、fleet watch、long-job broker、active merge-gate request を
`component`、named `PID`、`owner`、`provenance`、`health`、`reason` で報告する。
marker-backed component は記録済み PID/owner/provenance を報告するが、framework marker
を持たない sccache は意図的に unverifiable とする。relevant resident boundary が不健全
または検証不能なら `ENVIRONMENT_BLOCKED` とする。failure classification の `RED` は、
captured output が exact boundary を証明しない、または direct executable observation が
失敗したことを意味する。classifier は元 command を replay しない。実行不能・検証不能を
`PASS` にしない。

preflight は compiler も sccache client も呼ばない。`rustc -Vv` も active process であり、
stats request でも shared daemon を lazy-start
し得るためである。standalone 実行には failed-command の captured evidence がないため、
sccache row は意図的に unverifiable、overall diagnostic は fail-closed の
`ENVIRONMENT_BLOCKED` となる。これは daemon 不健全の証明ではない。merge-gate の failure
classification は captured output が exact mediated compiler path と permission boundary を
証明した場合だけ sccache を bind し、曖昧な Rust failure は `RED` のままにする。

stale Status Web pidfile は health failure である。ただし source/code defect や
resident-process contamination の証拠ではない。

## Operator-only recovery

role seat から recovery しない。user Cargo config を変更しない。service install と
process image 名による一括 kill を行わない。

1. 変更前に component、exact PID、owner/provenance、marker path、captured command
   の cwd/output、別途承認された operator observation を保存する。
2. named PID が期待する executable と PM namespace を指すことを確認する。owner が
   missing / mismatch / unverifiable なら停止して escalate し、image 名から推測しない。
3. recovery 前に次を保持する。
   - sccache: user cache directory と `sccache --show-stats` output
   - Status Web: pidfile と stdout log
   - fleet watch: lock、state JSON、stop marker、最新 terminal result
   - long-job broker: ledger 全体、broker/wake lock、child PID、attempt log
   - merge gate: active lock、request、result、log
4. component の operator-owned lifecycle だけを使う。stop-file または documented
   stop command を優先し、named PID の終了を待つ。sccache は exact server を確認後、
   operator が documented client stop/start を実行できる。server stop は disk cache を
   削除しない。
5. graceful recovery が失敗した場合、exact PID または検証済み process tree の終了前に
   operator の明示承認を得る。`taskkill /IM`、`Get-Process <image> | Stop-Process`、
   `pkill <image>` 等の image-name-wide 操作は禁止する。
6. read-only preflight と元の whole command を再実行する。before/after evidence を保持し、
   retry を clean に見せるために cache、log、lock、request/result、long-job ledger を
   削除しない。
