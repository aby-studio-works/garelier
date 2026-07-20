# 実プロジェクトに `$DT` `$CT` 等の literal 変数名フォルダが湧く — 原因と対策

Status: **W-045 で二層 guard 実装済み (2026-07-11)**。実害 = ある target project の
working tree に `$CT/ $DT/ $PT/ $ST/ $T/` という literal 名 dir が生成され、
merge gate の `git commit` step が untracked として拾う / worktree が DIRTY 化する。

## 訂正 (W-045 実装時の再調査)
初動の root-cause note は `merge_land.test.ts:228` を主犯として挙げたが、実装時に
再検証したところ、その行はヒアドキュメント (`<<EOF`、非 quote) 内にあり `$MYWIN`
`$DT` はヒアドキュメント書き出し時に正しく展開される (実機で確認済み) — つまり
その行 **単体は literal を漏らさない**。真の detective gap は下記の
**「対策」節に実装したガード** が守っている 3 箇所 (`merge_gate.ts` の
`requestTargetRoot()`、`merge_gate_parse.ts` の `resolveTrustedTargetRoot()`、
`merge-gate.ts` の `TARGET_ROOT_FOR_GIT` 解決) —
いずれも「`target_root` が相対/不正値なら `fallback` に対して無条件で
`resolve()`/`path.resolve()` して信頼する」実装だった。これだと、どんな経路で
（壊れた fixture・破損した lock ファイル・手編集など）relative かつ `$` を含む
ような不正文字列が `target_root` に紛れ込んでも `<fallback>/$DT` という
「実在しないが絶対パスに見える」値が作られ、それを渡された spawn cwd /
`cd` / (将来的な) mkdir がそのディレクトリ配下に副作用を作り得た。
`merge_land.test.ts:228` はこの脆弱パターンの**見た目上の実例**として引用する
価値はある (視覚的に紛らわしいので W-045 で `%s`+arg 形式に書き直し済み) が、
実際に literal を漏らしていたわけではない。

## 症状
- 実プロジェクトの working tree に **`$` で始まる literal 名の dir** (`$DT` `$CT`
  `$PT` `$ST` `$T` 等) が湧く。中身は `__garelier/tpm/runtime/...` (`tpm` =
  テストの `--pm-id tpm`)。git status に `?? $DT/` として出る。

## 真因
merge-gate 系の **テスト fixture** (`merge_land.test.ts` / `dispatch_cleanup.test.ts`
等) が lock/request JSON を **シングルクォートの printf** で書き出しており、path
フィールドのシェル変数が展開されず literal 文字列で残る:

```bash
# merge_land.test.ts:228 付近 — printf format が ' で囲まれているため $DT が展開されない
printf '{"pid":$MYWIN,...,"target_root":"$DT"}' ... > "$LOCKDIR/active.lock"
#                              ^^^ literal 文字列 "$DT" が JSON に焼き付く
```

この lock/request を後段のツールが読み、`target_root` = literal `$DT` を取り出して
`mkdir -p "$target_root/..."` すると、値が `$DT` なので **`$DT` という名前の dir** を
そのツールの cwd (= 実プロジェクト) に掘る。sibling fixture が `$CT`/`$PT`/`$ST`/`$T`
を同様に漏らすので 5 個揃う。

**本番経路は無害**: `merge_request.ts:225` は `printf '"target_root": "%s"' "$(esc "$GIT_ROOT")"`
で正しく展開している。漏れるのは **テスト fixture の literal printf だけ**。

## 対策 (二層 — preventive + detective、W-045 実装済み)
1. **preventive (fixture 修正)**: `merge_land.test.ts` の `plant_lock.ts` ヒアドキュメント
   (旧 :228 付近) を、format 文字列内 literal `$VAR` 埋め込みではなく `%s` + arg 形式に
   書き直し済み (視覚的に紛らわしい書き方をやめただけで、実害修正は下記 detective 側が本体)。
2. **detective (恒久防御、本体)**: `target_root` を JSON から読んで spawn cwd / `cd` に使う
   4 箇所全てに「絶対 + 実在 dir」検証ガードを実装。相対値・`$` を含む値・実在しない値は
   **fallback にそのまま skip** する (旧実装は `resolve(fallback, target)` で無条件に
   信頼して合成していたのが detective gap の本体):
   - `skills/garelier-core/driver/src/merge_gate.ts` の `requestTargetRoot()` — spawn cwd
     + `active.lock` の `target_root` フィールドの元。
   - `skills/garelier-core/driver/src/merge_gate.ts` の `abortActiveGate()` (W-048、
     2026-07-12 追加) — `active.lock` の `target_root` を読み `git merge --abort` の cwd に
     使う経路。W-045 実装時点で未対応だった残 1 箇所 (Observer W-045/046 note)。
     `resolveTrustedTargetRoot()` を直接 import して同じガードを適用。
   - `skills/garelier-core/driver/src/merge_gate_parse.ts` の `resolveTrustedTargetRoot()`
     (export 済み、`merge_gate_parse.test.ts` で単体テスト) — Guardian/Observer stale-verdict
     ガードの git 参照解決 cwd、および上記 `abortActiveGate()` の直接呼び出し元。
   - `skills/garelier-core/driver/src/scripts/merge-gate.ts` の `TARGET_ROOT_FOR_GIT` 解決 (inline
     `bun -e` one-liner) — この値が最終的に `cd "$TARGET_ROOT"` される。
   `merge_request.ts` (書き込み側) と `dispatch_cleanup.ts` は `target_root` を mkdir/cd に
   使っておらず、この class の gap を持たない (確認済み、2026-07-11)。
   テスト: `merge_gate.test.ts`「a malformed target_root … never becomes the spawn cwd」
   ほか、`merge_gate_parse.test.ts` の `resolveTrustedTargetRoot` 単体テスト 5 本。

## 応急処置 (湧いた時)
```bash
# 中身を確認 (literal 変数名 + __garelier/tpm なら fixture 由来で安全)
ls -la '$DT' '$CT' '$PT' '$ST' '$T' 2>/dev/null
# 除去 (literal 名なので明示 quote)
for d in '$CT' '$DT' '$PT' '$ST' '$T'; do rm -rf "./$d"; done
```

修正 work item = garelier backlog (mechanism、dock lane → Guardian+Observer)。
