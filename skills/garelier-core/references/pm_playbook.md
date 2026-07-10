# PM/worker operational playbook

実運用で PM と producer が繰り返し踏んだ判断ミスを、再現しない形の手順に落とした
read-on-demand リファレンス。2026-07-03/04 の実運用（14 merge、stall 4 例、
merge conflict 復旧、gate rebind 多数）から抽出した。SKILL.md の entrypoint には
常駐させない（DEC-032）— dispatch / merge / stall の運用判断が要るときだけ開く。

各項は **状況 → 正しい手 → 根拠(実例)** で書く。ここに書く手順の多くは、
恒久ガード（W-039 / W-044 / W-045 等）が landed するまでの「手で守る」層でもある。
ガードが入ればツールが自動で守るが、ガードの有無に関わらず判断基準は変わらない。

このファイルは attended（driver なし、`SendMessage`/`Agent` を手で回す）PM でも
driver 運用の PM でも読む。gate の verdict 生成・検証は PM の仕事ではない（DEC-090）—
ここでも PM は verdict を relay するだけで、判断は Guardian → Observer が返す。

同じ運用を「状況判断なしで execute する決定表・手順表」に落とした mid-tier PM 向けの
姉妹編が `pm_field_manual.md`。この file の「状況 → 正しい手 → 根拠(実例)」から状況判定を
機械化したのがそちらで、両者は重複させず相互参照する（field_manual の各節末尾が
ここの §N を根拠として指す）。

---

## 0. Hot rules（高頻度 read 用の 1-行 索引）

計画 cycle・dispatch・merge・stall 判断で毎回参照する運用規則の索引。**まずここを読み、
根拠(実例)や手順詳細が要る時だけ該当 §N を開く**（§1–§12 が詳細本体 = この file の 後半）。
語彙・taxonomy は `role_subagent_dispatch.md` §6 と共通。

| # | 状況 | 正しい手（core） |
| :-- | :-- | :-- |
| §1 | producer branch を merge に出す/片付ける | **既定は `merge_land.sh` 1 本を `run_in_background`**（submit→wait→成功時のみ cleanup+pull を集約、失敗は cleanup せず非 0、W-088）。手で回す時は merge result の `status=success` を確認して**から**別 step で cleanup（control-only は `workspace_isolate.sh --collect`）。gate 走行中（`active.lock`）は studio に commit しない。手回しで submit だけした時は `waiter_cmd` を `run_in_background` で arm 必須（忘れると `--stall-scan` が `UNPROCESSED-RESULT`、W-086） |
| §2 | gate 通過（待ち）branch に commit が乗り tip SHA が動いた | verdict は review した SHA に bind → 古い verdict は stale。tree 同一（reword/amend）は tree-hash fallback（`--guardian-report` を渡す）、tree 変化は Guardian→Observer に新 SHA で rebind 依頼。PM が「軽微」と verdict を自作しない |
| §3 | producer が idle / 無音 | **stall-scan を先に**三分岐（build-wait=待つ / stall-suspect=定型 nudge / unknown=file 実査）、respawn は後。**spawn 直後に `watch_cmd`（dispatch_prepare emit）を `run_in_background` で arm するのは必須**（忘れると `--stall-scan` が `UNWATCHED` 報告、W-085）。予算超え job は watch 完了で `SendMessage` wake |
| §4 | 指示と完了報告が交差 | 「未反映 / 重複 / stale」を主張する前に `git show` / `grep` / `git rev-parse` で機械確認する（記憶・到着順で判断しない） |
| §5 | studio→branch / base tracking の conflict | code を持つ producer（Worker/Smith/Artisan）が両側保全で解決、Dock は trigger+verify のみ。branch は SHA から復元、Windows path 長は `C:\` 直下の短 path worktree（git config は触らない）。drift 検出は `base_tracking_scan.sh` |
| §6 | 複数 producer を並列 dispatch | heavy cargo build は同時 1 本（`heavy_compile_lock.ts` で直列化 / RAM 予算 lease）、docs・調査は並列可。worker self-gate=scoped（`--touches`）、full-workspace compile は merge gate。prompt に交通整理文を必ず入れる |
| §7 | producer dispatch prompt を書く | **prompt = `dispatch_prepare` の `prompt_preamble`（確定値埋め済 boilerplate）を冒頭に verbatim + 任務固有本文だけ**（W-095、trailer の `{{TASK_ID}}` は置換）。定型は手書きしない。preamble = checkout 絶対 path / 親 repo 禁止 / base-track / commit 書式 / register 終端 / 台帳消し込み / heavy 規律 / push 禁止。PM 追記 = blueprint+design-review notes / scoped gate 具体形 / scope 境界 / (対象 project 固有) determinism |
| §7 | 走行中 worker に scope を追加する | **まず container の `instructions.md` に `- [ ] I<n> <1 行>` を append**（口頭 message だけで送らない）→ その pointer を message で送る。完了 register と交差しても台帳に残り、worker が消し込む。未消化のまま REPORTING は `--stall-scan` UNCONSUMED-INSTRUCTIONS が検出（W-092） |
| §8 | 新 logic/action を blueprint 化（deterministic target） | rng は canonical seed から / timer は sim tick 基準 / save round-trip 不変 / 新 field の restore 初期化は loss 可・dupe 不可の側 |
| §9 | バグ・drift・stall の原因が「たぶんこれ」 | evidence（code/log）で真因を確定してから dispatch。log 計装 1 本で一撃確定。1 件見たら class 監査。外部 platform 挙動は公式 source（原文引用+URL）、Claude Code は `claude-code-guide` |
| §10 | active gate 中に merge_request を追加投入 | 前 gate 完了時に `dock_merge.ts poll` を 1 回蹴って drain（attended は自動 consumer が居ない） |
| §11 | status 回答 / session 再開 / merge 完了 / cleanup 完了（= anchor） | どの anchor でも同じ fresh-scan bundle: `contract_check --stall-scan` + `task_mirror --format ops` を apply（result/cleanup JSON の `task_mirror_hint` が正確な command）。印象・記憶で答えない / TaskList を hand-craft しない（DEC-092） |
| §12 | 高 stakes merge で Observer が単独 PASS | Observer verdict 受領後に refuter を +1 体（refute-default、UPHELD/REFUTED を relay）。日常 merge には焚かない |

---

## 1. cleanup は merge 成功を確認してから、別 step で

**状況.** producer branch を merge に出したあと、worktree/branch を片付けたくなる。

**既定は `merge_land.sh` 1 本を `run_in_background`（W-088）.** submit → 結果待ち → 成功なら
cleanup → pull の 4 タッチを 1 command に集約したのが `scripts/merge_land.sh`。PM は手で順序を
守る代わりにこれ 1 本を background で回す（引数は `merge_request.sh` とほぼ同型）：

```bash
bash skills/garelier-core/scripts/merge_land.sh --project <root> --pm-id <pm> \
  --dispatch-id <N> [--guardian <PASS|PASS_WITH_NOTES>] [--observer <v>] [--no-pull] \
  [--close-row <item-id> …] [--close-trailer <trailer-line>]
```

**引数 UX（W-017）.** dispatch #N を landing する時は `--dispatch-id <N>`（alias `--id`。
dispatch_prepare / dispatch_cleanup と同じ id）だけで済む：`--branch` 省略時は
`__garelier/<pm>/_dispatch<N>/checkout` の HEAD branch を読んで解決する（明示 `--branch` は常に優先。
`--branch` 指定時の dispatch id は従来どおり branch の `#<N>/` から導出）。`--guardian` / `--observer`
も省略可で、省略時は verdict marker（`runtime/<role>/results/<slug>-<role>.md` の `## Verdict` 節）を
gate と同じ fail-closed parser で読む（marker 不在 / placeholder / 誤記は「verdict なし」= PASS 仮定
しない）。明示 flag は常に marker を上書き。必須引数の不足は submit 前に **一括** で報告 + usage 表示する
（旧: submit 段階で `--branch required` → `--guardian required` と 1 個ずつ判明していた 3 回失敗の解消）。
auto-read した Guardian verdict が非 PASS なら submit せず止まる（明示 `--guardian` は PM 判断として通す）。

`--close-row <item-id>`（複数可、W-093）で merge 成功 + cleanup 後に backlog の `| <item-id> |` 行を
削除+`chore(dashboard): … close` commit まで畳む（次 gate active なら defer、行不在は not-found、project 固有 trailer は `--close-trailer`）。

自身が waiter として block-wait し、**gate 成功時のみ** cleanup + pull する。失敗/conflict/timeout
は cleanup を一切せず（branch の作業を保全）`{"status":"failed","cleaned_up":false}` を返して非 0
exit。成功は `{"status":"success","studio_commit","branch_deleted","cleanup_status","pulled"}` +
exit 0。backlog は既定では触らない（PM 所掌。`--close-row` 指定時のみ close 行を削除+commit）。gate spawn は W-087 detach 済みなので submit は数秒で返り、
gate は本 command を kill しても完走する。**以下は merge_land が内部で守る順序**（手で回す時の
規約であり、根拠でもある）:

**正しい手.** 「merge 結果の確認」と「`dispatch_cleanup.sh --delete-branch` /
branch 削除」を**同一 command・同一判断に入れない**。

1. merge gate の result を先に読む — `runtime/merge_gate/results/<seq>-<slug>.json`
   （`.summary.json` があれば先に status だけ見る）で `status=success` を確認。
2. success を確認して**から**、独立した次の step として cleanup を呼ぶ。
3. cleanup 出力に出る merge 状態表示を必ず読む。`status=success` の result が
   無いのに branch を消そうとしていたら止まる。

**根拠(実例).** 2026-07-04、PM が merge 結果を確認する前に cleanup を同一 command で
実行し、merge が conflict で失敗していたのに branch を削除した。SHA が会話 context に
残っていたため `git branch <name> <sha>` で復旧できたが、無ければ完成済みの作業が
消えていた。W-044 の guard（`dispatch_cleanup.sh` が該当 slug の `status=success`
result 不在時に削除を拒否し `--force` を要求）が landed するまでは、この手順で防ぐ。
guard が入っても「結果確認 → 別 step で cleanup」の順序は変えない。

**復旧の一撃.** branch を消してしまっても、直前の merge/commit SHA が context か
`git reflog` に残っていれば `git branch <name> <sha>` / `git worktree add <path> <sha>`
で完全復旧できる。**慌てて `git gc` / `git worktree prune` を先に走らせない** —
unreachable object を GC する前なら reflog から拾える。

**control-only repo の相当 = `workspace_isolate.sh --collect`（W-080）.**
dispatch-native scaffolding の無い control-only repo（本 framework repo 含む）
では `workspace_isolate.sh --collect` が同じ役割を持つ。collect は worker の
完了 register 後に呼ぶ。isolate worktree が未 commit のまま collect すると
`git worktree remove --force` で編集ごと破棄される事故があった（実 incident
2026-07-05、W-077 追送 C）ため、dirty refuse（未 commit 変更ありで拒否）が
出たら worker に commit させる — `--force-collect` は本当に破棄してよい時だけ。

**merge gate 走行中は studio に commit しない（W-055）.** merge gate は primary
checkout の共有 index で `git merge --no-commit` を張ったまま数分 quality gate を回す。
その間に PM が studio へ別件を commit すると、git がその staged merge を**吸収して**
2-parent merge commit にしてしまい（実例 2026-07-04 の d85a283d が w082w1 の merge を
吸収）、gate は commit step で「merge 無し」になり abort する。`runtime/merge_gate/
locks/active.lock` が在るのが gate 走行中のサイン — commit は gate 完了後に回す。commit
guard（W-055 fix）がこの吸収 commit を mode 非依存で機械 block するが、順序を守るのが先。

**attended では merge_request の直後に waiter を background で張る（W-079）.** merge gate
は async で、driver 無しの attended では results/ を誰も見ていない — gate が終わって（あるいは
conflict で落ちて）も PM が見に行くまで放置される（実例 2026-07-05、conflict-failed gate が
1h+ 放置）。`merge_request.sh --notify` が出す `gate_result_waiter.sh --request-id <REQ_ID>`
を `run_in_background` で起動しておけば、gate 終了時に harness が background 完了で main
session を起こし、`MERGE_RESULT: <status> …`（exit 0=success / 1=非success / 124=timeout）
が push される。waiter は自分の request_id の result だけを見て queue には触れない（self-drain
W-039 と非干渉）。driver 運用では poll loop が拾うので不要。

**submit したら即 waiter を arm する（必須手順、W-086）.** attended で merge_request を
投入したら waiter を `run_in_background` で張るのは省略可の推奨ではなく **必須 step**。--notify の
印字を手で組み立てず、`merge_request.sh` の **JSON 出力の `waiter_cmd` field**（--notify 有無に
関わらず常に出る・引数確定済み）を **verbatim で `run_in_background`** する。arm を忘れると
landed merge の後処理（cleanup / 次 merge の `dock_merge.ts poll` drain / 起票）が user 契機まで
滞留する（2026-07-06、4 merge 停滞）。**detective**: `contract_check.ts --stall-scan` は cleanup
未実行の success merge（workbench branch が残存 = archive request の branch がまだ存在）を
**`UNPROCESSED-RESULT`**（top-level `unprocessed_results` list、直近 24h 窓）として報告する —
出たら `dispatch_cleanup.sh --delete-branch` を回し、次 merge を drain する（advisory、`ok` は倒さない）。

---

## 2. SHA が動いたときの gate 対応 — verdict は SHA に bind される

**状況.** 一度 gate を通した（あるいは通過待ちの）branch に、producer がもう 1 commit
積んだ。tip SHA が動いた。

**正しい手.** delta の性質で二分岐する。**gate の verdict は review した SHA
（report の `review_sha`）に bind される**のが本質 — SHA が動けば古い verdict は
mechanical に stale 扱いになり、merge gate が拒否する。

- **(a) tree 同一（reword / amend / message-only）** — reviewed tree が変わって
  いなければ W-035 の tree-hash fallback（`merge-gate.sh` G-15）が自動通過させる。
  bare `--guardian-verdict` は SHA を持たないので、必ず `--guardian-report`
  （`review_sha` 入り）を渡す。tree 同一なら re-gate 不要。
- **(b) tree 変化** — 両 gate（Guardian → Observer）に **delta の内容 + 新 SHA を
  明示して rebind を依頼**する。verdict は新 SHA に取り直す。delta が
  「識別子 rename / 可視性キーワード / log・comment・doc のみ / typo・fmt」の
  enumerated set に収まるなら、`attended-gate-dispatch.md` § Mechanical-delta
  re-gate（W-032）の軽量 1-role 経路が使える。それ以外は full の 2-role gate。

**やってはいけない.** PM が「これは軽微だから通っている扱い」と verdict を
自作・据え置きしない（DEC-090）。「mechanical かどうか」も producer の自己申告で
決めず、gate role が full diff を読んで構造的に確認する。

**根拠.** merge gate は `guardian_report_path` の `review_sha` と workbench tip を
照合し、動いていれば verdict を stale として merge を拒否する（`merge-gate.md`
§8.1.A）。だから bare verdict 文字列より report path を常に優先する。

---

## 3. idle 通知の三分岐 — stall-scan を先に、respawn を後に

**状況.** producer が idle 通知を出した / 一定時間無音になった。stall か、単に
build 待ちか、判別が要る。

**正しい手.** **stall-scan を先に走らせて三分岐**し、それから手を打つ。順番を
逆にして「無音 = stall」と即断し respawn しない。

1. **build-wait（待つ）** — STATE=WORKING で、直近に「まだ build 中」の interim
   message がある / background build が生きている。何もしない。cold build は
   正当に数分〜十数分かかる。ここで respawn すると完成間近の実装を捨てる。
2. **stall-suspect（定型 nudge）** — WORKING のまま進捗の痕跡（dirty_hash 変化、
   新 commit、interim message）が N 分止まっている。定型 nudge を送る。
   nudge は **具体的な残作業の列挙 + 15 分 deadline + handoff 予告** で書くと効く
   （実運用で 4/4 回収）。「進んでる？」ではなく「残りは X と Y。15 分で REPORTING
   に達しなければ別 worker に handoff する」。
3. **unknown（file 実査）** — 判定に必要な signal が無い。STATE.md / report.md /
   `git log` / tree 状態を自分で読んで実態を確定してから動く。

**盲点に注意.** 従来の stall-suspect 判定は `commits==0` を前提にしていたため、
**commit を積んで tree clean のまま REPORTING 未達で眠る worker** を unknown に
落として escalation が不発になる（W-045）。commit 済みでも tip SHA が N 分不変で
REPORTING 未達なら post-commit-stall として同じ nudge→handoff に乗せる。

**根拠(実例).** build-wait を stall と誤診して respawn した例（W-053 class）と、
4 commit・tree clean 後に 45 分無音で escalation が不発だった例（W-045、2026-07-04）。
verify 側は `contract_check.ts` の判定・W-037 の stall-scan escalation が担う。
attended では PM が上の三分岐を手で当てる。

**register 未処理の idle は手で wake せず `idle_no_register` の `wake_cmd` を使う（W-018）.**
上の三分岐は WORKING の停滞だが、**REPORTING に達したのに完了 register が届かない**
（done-but-unregistered）/ gate 役の verdict 未着も、PM が手で wake していた摩擦
（2026-07-06、手動 wake 9 回）。**規約**: PM は dispatch の register を処理したら
`_dispatch<N>/register_received` を touch する。この marker が無い idle を
`contract_check.ts --stall-scan` は **`IDLE-NO-REGISTER`**（top-level
`idle_no_register` list）として報告し、各 item に **そのまま送れる `wake_cmd`**
（宛先 Agent 名 + 状態別 wake 文面: REPORTING=register 送信 / WORKING 停滞=続行 or
BLOCKED / gate 役=verdict register）を同梱する。文面を手書きせず SendMessage に
verbatim で載せ、処理後に marker を touch する（respawn ではなく wake — producer は
DONE か到達可能で、dead な REVIVE-NEEDED とは別）。`dispatch_watch.sh`（single、`--id`）は
同判定を `RESULT: IDLE-NO-REGISTER` で出す。advisory（`ok` は倒さない）。

**heavy producer には watchdog を手作りせず `dispatch_watch.sh` を回す（reachability）.**
上の三分岐は「idle 通知が来てから」の判断だが、**heavy な build を伴う producer を
dispatch した直後**は、operator（stall-immune な main session）がこれを
**background task として起動**する（Bash の `run_in_background` / jig なら毎 tick 自動）：

```bash
bash skills/garelier-core/scripts/dispatch_watch.sh --project <root> --pm-id <pm_id> --id <N>
#   （--id の代わりに --branch <ref>；build/run プロセス名が独自なら --proc-regex '<ERE>'）
```

**spawn したら即 arm する（必須手順、W-085）.** producer を spawn した直後に上の watch を
`run_in_background` で起動するのは省略可の推奨ではなく **必須 step**。上のコマンドを手で組み立てず、
`dispatch_prepare.sh`（および jig）が spawn 用 JSON に emit する **`watch_cmd`** field
（引数確定済みの one-liner）を **verbatim で `run_in_background`** する。arm を忘れると producer は
無音のまま dormant になり得る（2026-07-06、watch 忘れで 6 producer が夜間停止）。**detective**:
`contract_check.ts --stall-scan` は watch heartbeat の無い WORKING dispatch を `UNWATCHED` として
報告する（§11 の anchor scan で毎回可視化）。fleet 全体を 1 本で見張るなら §11 の
`dispatch_watch --fleet`。

producer branch の新 commit（spawn 時 tip からの前進）と host の compile 活動を polling し、
`PROGRESS` / `ADVANCING` / `BUILDING` / `STALLED` の RESULT 行で **exit → operator を再起動**
する = stall を event-driven に拾う backstop（DEC-091）。**PM が「進んでる？」と自分で定期
polling したり watchdog を手作りしたりしない** — それは既存機構の再発明（W-071）で、
healthy な間 PM は起きない（RESULT 到達＝exit 時にだけ再起動）。RESULT が `STALLED` なら
上の stall-suspect と同じ warm-resume / re-dispatch に乗せ、`ADVANCING`（commit 無しだが
STATE/report 前進）と `BUILDING` は生存の証なので watch を再度回すだけ。この判定は
mtime / liveness ping では reset されない（§11 の reset 規約）。

**予算超え job は watch 完了で worker を message で wake する（W-077）.** worker の
gate/verify が `context.json` の `bash_timeout_budget_ms`（= bash tool timeout 上限、
超えると harness が kill）を超えそうな時、worker は foreground で走らせず background に
逃がして眠るのが**正常**。operator が `dispatch_watch.sh` を張り、**job 完了で
`SendMessage` で worker を wake** する — worker は context 保持のまま結果確認 → commit →
report。**handoff 再 spawn より先にこの message wake を試す**（cold worktree の作り直しより
context 保持のほうが安い）。「subagent は background 完了で再起動されない」は undocumented
実装挙動なので、この documented な message-resume 経路だけに依存する（`role_subagent_dispatch.md` §6）。

**予算超えを許す = 暴走窓が開くので watch で補償する（W-077）.** budget-read + wake は
tool-timeout の暴走 kill を迂回するので、operator 側の watch がその安全を肩代わりする。
`dispatch_watch.sh` は `RUNAWAY` verdict を安価 signal で出す: (a) **hard ceiling** =
`BUILDING` が `--max-building-windows`（既定 3、~連続 60 分）連続 → **process group kill +
FAILED 扱い**（無限 BUILDING を待たない）、(b) **output 肥大** = `--output-file` が
`--max-output-mb`（既定 100MB）超で進捗 marker 無し → 同 kill（過去 = log 永遠 write で SSD 破損）、
(c) job 終了後の **orphan**（rustc 等残存）は wake message に「kill してから確認」を含める。
worker を起こす時は「起き上がり self-check（exit code + log 末尾 / orphan / log サイズ /
worktree 整合、暴走痕あれば masking せず正直 report + escalate）」を求める（§6(B)）。**上限
引き上げ（`BASH_MAX_TIMEOUT_MS`）は暴走窓を広げるので watch 併用が前提**、引き上げて放置しない。

---

## 4. message crossing — 主張の前に git/file で機械確認

**状況.** 指示と完了報告が交差する。PM は「まだ反映されていない」と思い、worker は
「重複 assignment だ / stale だ」と思う。実際はすれ違いで、片方は既に正しい。

**正しい手.** 「未反映」「重複」「stale」を**主張する前に、git/file の状態で機械確認**
する。記憶や message の到着順で判断しない。

- PM 側 — 「反映されていない」と言う前に `git show <sha>:<path>` / `grep` /
  対象 file を読んで、既に landed していないか確認する。
- worker 側 — 「重複 / 既にやった」と即断する前に、指示された branch の **tip SHA を
  `git rev-parse` で確認**する。自分の記憶する tip と一致するか、指示が指す SHA が
  自分の成果を含むかを見る。

**根拠(実例).** W-067/W-068 の相互誤解 — PM の再指示と worker の完了が交差し、
双方が「相手が古い」と誤認した。git/file で確認すれば 1 手で解ける。message の
harness boilerplate は round-trip 課金が重いので、確認は自分の手元で済ませて
往復を減らす（`attended-gate-dispatch.md` § Harness message tax）。

---

## 5. merge conflict は producer が解決 — 復旧手順

**状況.** studio → in-flight branch の forward-integration（DEC-039）や base
tracking の merge で conflict が出た。あるいは merge gate が conflict で失敗し、
branch が中途半端になった。

**正しい手.** **conflict は code を持つ producer（Worker/Smith/Artisan）が解決する**
（DEC-039 / DEC-001 §2.5 の定義済み例外）。PM/Dock は trigger と verify だけで、
自分では code を書かない。復旧は次の順で：

1. **branch を SHA から復元** — 失敗で branch tip が動いた / 消えた場合、直前の
   producer tip SHA（reflog / context）から `git branch -f <name> <sha>`。
2. **一時 worktree を切る** — producer の checkout で `git merge <studio>` を回す。
3. **両側保全で解決** — どちらの変更も落とさない形で marker を潰す。片側を
   まるごと `--theirs`/`--ours` で捨てない（設計変更を silent に消す）。
4. **marker 0 を確認** — `grep -rn '^<<<<<<<\|^=======\|^>>>>>>>'` が 0 件。
   commit してから gate に戻す。
5. **gate rebind** — tree が変わっているので §2(b) に従い新 SHA で re-gate。

**Windows path 長対応.** worktree の path が深く（`__garelier/<pm_id>/_workers/<id>/checkout/…`）、
Windows の path 長上限に当たって git 操作が失敗することがある。**短い path の
worktree を `C:\` 直下（例 `C:\gw\<slug>`）に切って**そこで解決する。
**`git config core.longpaths` 等の git config は変更しない** — repo/global の設定を
勝手に触ると他 worktree・他 agent に波及する。短 path worktree はその場限りで安全。

**drift 検出は手打ちしない（W-061）.** §8.6 の「in-flight branch が studio より
どれだけ behind か」を producer ごとに `git log … | wc -l` する per-iteration duty は
1 コマンドに機械化済み：

```bash
bash skills/garelier-core/scripts/base_tracking_scan.sh --pm-id <pm_id> --project <root>          # 検出のみ（dry-run）
bash skills/garelier-core/scripts/base_tracking_scan.sh --pm-id <pm_id> --project <root> --write  # track-target.md を idempotent に drop
```

WORKING の workbench/anvil producer を列挙し behind を計算、`--write` で §8.5 の
`track-target.md` を（current / `--threshold` 未満 / pending は skip して）idempotent に落とす。
jig は毎 tick 自動で `--write` 実行。attended の Dock/PM はこの script を叩く（手打ち loop 廃止）。

**根拠.** DEC-039（forward-integration、producer が merge & 自力 conflict 解決）、
`merge-gate.md` §8.5/§8.6。producer が解決する原則は「no code writing」境界を
広げない — Dock は trigger + verify のみ。

---

## 6. RAM 律速の並列規律

**状況.** 複数 producer を並列 dispatch したい。だが heavy な cargo build は
1 本で大量の RAM を食う（大型 project の full-workspace compile は ~16GB、31.7GB PC で
2 本同時は OOM → link 破損・incremental 破壊）。

**正しい手.**

- **heavy cargo build は同時 1 本**に絞る。走っているかは `tasklist`（Windows）で
  `cargo`/`rustc` プロセスを確認してから次を出す。build job 数は
  `CARGO_BUILD_JOBS=8` で 1 build 内の並列を抑える。
- **docs / 調査 / 監査系（build を伴わない）は並列無制限**でよい。RAM を食わない。
- **worker prompt に必ず交通整理文を入れる** — 「重い build は同時 1 本、他が build
  中なら待つ / docs・調査は並列可」を明示する。producer は他 producer の存在を
  知らないので、PM が prompt で order を渡さないと衝突する。
- **worker=scoped / merge gate=workspace の分業を固定する（W-068）** — worker の
  self-gate は **触った crate だけ**（`cargo check -p <pkg>` + `cargo test -p <pkg>
  --lib`、2-5GB で並列可能）に絞る。full-workspace compile（~16GB、2 本で OOM）は
  **merge gate の権威 check** に一本化する。この scoped command と **実 package 名**は
  `dispatch_prepare.sh --touches` から context.json に機械解決される（`quality_gate.
  scoped` / `quality_gate.default_gate="scoped"` / `task.touched_packages`）ので、
  worker が dir 名から `-p <crate>` を手で導出して間違える（`cooker_magic` →
  `acme_cooker_magic` の再発 drift）余地が消える。だから **dispatch は必ず
  `--touches '<触る glob>'` を付ける**（付けないと scoped 化できず `default_gate="full"`
  に落ちる）。workspace を worker の self-gate にしたい例外 task だけ `--full-gate`。
- **merge_request 側は workspace を渡し続ける** — PM が `merge_request.sh` に渡す
  quality-gate は **workspace 全体のまま**でよい（gate は stall-immune な main session
  から走るので RAM/foreground 制約を受けない）。scoped は「worker の self-gate を軽く
  して並列を通す」ためであって、権威 check を弱めるものではない（DEC-091 Consequences）。

**RAM 交通整理を目視でやらず `heavy_compile_lock.ts` で直列化する（reachability）.**
上の「同時 1 本」を PM が `tasklist` で目視して守り続けるのは手作業 = 再発明（W-070）。
heavy compile の **initiator**（async merge gate / heavy build を dispatch する Dock /
interactive に full build を走らせる PM）は、cargo 実行の前後で shared file lock を握る：

```bash
TOKEN=$(bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode acquire --label <slug>)
#   … この間に heavy build / merge gate を走らせる …（TOKEN が "OPEN" のときは lock 無効/fail-open）
bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode release --token "$TOKEN"
```

`[heavy_compile] max_concurrent`（既定 1）が同時本数、`lease_minutes`（既定 240）が **hard
backstop**、`stale_minutes`（既定 30、W-024）が **idle 回収**。acquire は timeout で
**fail-open**（`OPEN` を返して pipeline を止めない）、owner pid 死亡 + **idle**（owner が pid-0 /
非 live で `stale_minutes` 超過 かつ cargo/rustc プロセス 0 本）+ lease で self-heal（DEC-073
Part B、`role_subagent_dispatch.md` §4）。**誤解放防止**: live な owner pid や compile 実行中
（cargo 親が生存）は idle 回収しない。回収は `runtime/locks/heavy_compile/reclaim.log` に 1 行
残る。merge gate はこの lock を自分の gate 実行に巻き、Dock は producer の lifetime に巻く。
ただし **data-only の merge gate**（`[merge_gate] data_only_paths` で docs/data-only 判定）は
heavy compile を走らせないので lock を取らない（W-024。docs-only gate が lock 待ちで 90 分停滞した
実摩擦の是正、2026-07-06）。だから attended PM も heavy build を手で出す時は同じ lock を通し、
OOM（`anon.llvm` link err / incremental 破損）を目視でなく機構で防ぐ。build が concurrency-safe な
project は `max_concurrent = 0` で無効化（non-mandatory）。

**RAM 予算 build-lease で並列度を自動化する（W-070）.** 固定本数 `max_concurrent` に加え、
同じ `[heavy_compile]` section の `build_ram_budget_gb`（1 build の推定 RAM、既定 16GB）と
`max_build_ram_gb`（**user 指定ハード cap**、未設定なら実容量 − OS margin 3GB）で admission を
RAM から自動判定する: `min(max_build_ram_gb, free_ram − margin) ≥ build_ram_budget_gb ×
（現 holder 数 + 1）` を満たす分だけ lease を出す（**唯一の build は常に通す** — 2 本目以降だけ
RAM で絞る。free-RAM 読取不能な env は従来の count-only に degrade＝fail-open）。運用 model は
**「既知の重量 project / Garelier は上限まで使う既定、他 project は保守既定、OOM が出たら config で締める」**:
既知の重量 project / Garelier は `max_build_ram_gb` を書かず cap = 実容量 − margin（例 31.7GB → ~28.7GB）
にし、`max_concurrent` を高め・`build_ram_budget_gb` を build 規模（workspace≈16 / scoped≈4）に
合わせれば収まるだけ最大並列で自走する。他 project は `max_concurrent = 1` の保守既定のまま。
他作業と共存したい時は user が `max_build_ram_gb` を下げて絞る。OOM（`anon.llvm` link err /
incremental 破損 / exit 137）が release 時に検出されると `oom_hint` が記録され、次 acquire が
予算を 1 段締めて「config を締めろ」と warn する。

**根拠(実例).** 2 並列 full-workspace compile で OOM → `undefined symbol anon.llvm`
の link error、incremental cache 破損（`rm -rf target/debug/incremental` で復旧）。
実運用の RAM 律速教訓（大型 workspace 並列 build の事例）。分業の機械化は W-068、
scoped 規律の根拠は DEC-091。

---

## 7. dispatch prompt の必須要素 checklist

**状況.** producer を dispatch する prompt を書く。抜けがあると worker が困る /
scope 外に出る / 親 repo を壊す / foreground を外して stall する。

**prompt = preamble + 任務本文（W-095）.** 定型 boilerplate は手書きしない。`dispatch_prepare.sh`
が JSON 出力の **`prompt_preamble`** field に、その dispatch の確定値（checkout 絶対 path /
branch / 着手時 base-track / commit 書式 + trailer / register 終端 / 台帳消し込み / heavy 規律 /
push 禁止）を埋めた boilerplate を emit する。PM はそれを prompt 冒頭に verbatim で置き、続けて
**任務固有本文だけ**（blueprint 参照 / 具体 scope と境界 / determinism 等）を書く。preamble の commit
trailer は `{{TASK_ID}}` placeholder を残すので、bound backlog id（例 W-123）に置換する。以下の
checklist は preamble が満たす分と PM が足す分の一覧：

**正しい手.** 毎回このチェックリストを満たす（`dispatch_prepare.sh` を使うなら
emit される値を verbatim 使う。定型項目は `prompt_preamble` が満たす — W-095）：

- [ ] **checkout の絶対 path** + 「**親 repo / primary checkout を直接編集しない**」
      — 全 edit/commit は自分の `…/checkout/` worktree 内で（DEC-020 worktree guard）。
- [ ] **blueprint 参照 + design-review notes** — 実装対象の spec path と、
      design レビューで挙がった注意点（§8 の determinism 等）。
- [ ] **gate command の具体形（scoped, DEC-091 + W-068）** — 触った component の
      per-package check + test（+ lint）。full-project build は foreground に
      入れさせない（merge gate の仕事）。`--touches '<glob>'` を付ければ
      `dispatch_prepare.sh` が context.json に scoped command + 実 package 名を
      機械解決するので、worker が手で `-p <crate>` を導出せず verbatim 実行できる。
- [ ] **foreground 規律 + 途中経過 message** — gate/build は foreground 同期実行、
      background にして turn を終えない（DEC-073 / W-034）。long build 中に
      interim message を 1 本入れる（stall 誤診防止）。
- [ ] **最終メッセージ契約** — 完了時に **1 本だけ**、**新 SHA + 結果** を含む
      final message を返す（commit/report 後、途中や事前ではなく）。
- [ ] **scope 外の明示** — 何を触ってよくて何を触るなという境界。逸脱しそうなら
      silent に広げず BLOCKED。
- [ ] **(対象 project 固有) determinism 制約** — §8 の checklist を該当箇所に埋め込む。

**根拠.** DEC-091（scoped gate）、DEC-073 Part A（foreground 規律）、W-034
（interim message）、DEC-020（worktree guard）。attended の prompt shape は
`attended-gate-dispatch.md` の template と揃える。

**走行中 worker への scope 追加は指示台帳に書いてから message で pointer（必須、W-092）.**
dispatch 後に scope を足す・仕様を変える時、**口頭 message だけで送らない**。まず producer
container の **`instructions.md`** に append-only で `- [ ] I<n> <1 行> (→ pointer)` を 1 entry
書き、その pointer を message で送る。理由: run-to-completion な worker は完了間際に register
を返すので、scope 拡張 message がその register と**交差**すると未消化のまま REPORTING に達し落ちる
（本日 4 回の実害 class）。台帳に書いておけば message が交差しても entry が残り、worker は
REPORTING 前に消し込む（§6 worker 規約）。未消化のまま REPORTING した dispatch は
`contract_check --stall-scan` が **UNCONSUMED-INSTRUCTIONS**（advisory、`ok` は倒さない）で報告
するので、review.md で差し戻して消化させる。`dispatch_prepare` が空台帳（消し込み規約 header 付き）
を生成済みなので、PM は entry を append するだけ。

---

## 8. blueprint design-review の determinism チェックリスト

**状況.** deterministic simulation / replay / network sync を持つ
target で、新 logic/action を blueprint 化する。非決定な種を混ぜると replay と save
が壊れる。

**正しい手.** design-review でこの 4 点を必ず当て、prompt の design-review notes に
残す：

- [ ] **rng は canonical seed から** — `thread_rng` / `RandomState`（HashMap 既定
      hasher の乱択含む）/ wall-clock を種にしない。同一 frame counter・canonical
      seed から決定的に引く。
- [ ] **timer は sim tick 基準** — 実時間（wall-clock / `Instant::now`）でなく
      simulation tick で計る。
- [ ] **save round-trip 不変** — save → load で state が完全一致（canonical state
      正本 `execution_state.logic_runtime.snapshot` 経路）。round-trip で値が
      変わる field を足さない。
- [ ] **新 field の restore 初期化は安全側** — 旧 save に無い field を restore する
      とき、**loss は可・dupe は不可**の側に倒す。二重付与・二重消費を生む初期値を
      選ばない。

**根拠.** 対象 project の CLAUDE.md の determinism 制約（Lockstep / GPU 決定論、Frame
Generation で破壊禁止）。非決定な hasher/rng は最も見落としやすい侵入口。

---

## 9. 推測 fix 禁止 — verify-before-dispatch

**状況.** バグ・drift・stall の原因が「たぶんこれ」で見えている。すぐ fix を
dispatch したくなる。

**正しい手.** **監査・修正は必ず code/log の evidence で真因を確定してから** dispatch
する。推測で対策を当てない。

- 症状が既知の failure に pattern-match しても、真因は別のことがある。restart /
  delete / config 変更のような不可逆手の前に、その手が evidence で支持されるか確認。
- 見えない挙動は **log 計装を 1 本足して一撃で確定**させる。推測で外して 2 周
  するより速い。
- 「1 件見たら class 全体を監査」— 同種のバグは preventive/detective の仕組みで
  是正し、横断監査してから対策する（memory: mechanism-fix-and-class-audit）。
- **外部 platform/tool の挙動に依存する判断は公式 source で確定する.** 設計・fix が
  harness / Claude Code / OS / 第三者 lib の挙動に依存するなら、repo 内 docstring や
  観測で確定せず、**確定前に公式文書で verify**（Claude Code の挙動は `claude-code-guide`
  agent、他は WebSearch/WebFetch）し **原文引用 + URL を DEC/report に残す**。判定 test =
  「我々が作った物か、消費している物か？後者 → 公式 source 必須」。自 repo の docstring は
  spec でなく観測（producer 版は `debugging_discipline.md` §6、source tag 記法は
  `document_standards.md` §Source tags）。

**根拠(実例).** log 計装で真因を一撃確定した例（W-058 class）と、推測で当てて外した
例の対比。全 finding に file:line / diff の evidence を要求する（DEC-088）—
bare な形容詞判断は不可。**外部 platform 版の外し例** = Claude Code の Bash timeout /
subagent 継続性を repo 内観測だけで確定扱いし対策を 2 回誤設計した W-077（公式確認で
`BASH_MAX_TIMEOUT_MS` 可変が判明し option 空間が変わった）。

---

## 10. merge queue の drain — 前の gate 完了時に poll を蹴る

**状況.** merge gate が active な間にもう 1 件 `merge_request.sh` を投入した。
attended mode では前の gate 完了後、その pending を誰も取り出さない。

**正しい手.** merge_request を投入したら、**前の gate が active なら、その完了時に
`dock_merge.ts poll` を 1 回蹴って次を spawn** する。attended には driver の poll
loop に相当する consumer が居ないので、PM が手で drain する。

```bash
bun skills/garelier-core/driver/src/dispatch/dock_merge.ts poll \
  --pm-id <pm_id> --project <project_root>
```

**根拠(実例).** 2026-07-03、W-057 gate 実行中に投入した W-064 request が queue に
積まれたまま、W-057 完了後も誰も取り出さず **1.5h silent 滞留** — PM が手で
`dock_merge.ts poll` を蹴って初めて処理開始。W-039 の self-drain
（`merge-gate.sh` が完走時に自分で poll を 1 回呼ぶ）が landed するまでは手で蹴る。
guard が入っても、queue 投入時に「active gate 完了後に自動処理される/されない」を
確認する癖は残す。

---

## 11. anchor protocol — status 回答 / session 再開 / merge 完了 / cleanup 完了 で回す単一 bundle

**状況.** 次の 4 つの瞬間（= **anchor**）のどれかに達した: (a) user・teammate に
「順調？ 止まってない？」と status を聞かれた、(b) wall-clock が大きく空いた／日付が
変わった後に session を再開した、(c) merge gate が完了した（`MERGE_RESULT:` / result JSON）、
(d) `dispatch_cleanup.sh` が完了した。attended PM は session そのものなので、pause 中は
監視も止まる（常時 poll は driver mode だけ）。

**正しい手.** **どの anchor でも同じ fresh-scan bundle を回す。印象で「順調」と答えない／
記憶で Task list を触らない**（LLM は健全側に reassuring な誤答をする構造 bias がある）。
以前は status 規律（W-071）と merge/cleanup での TaskList 更新（W-076）が別々に書かれて
いたが、**anchor は 1 つ・bundle も 1 つ**に統一する（分散させない — これが単一 anchor
protocol の主眼）。

| anchor | トリガ | bundle（この順で回す） |
| :--- | :--- | :--- |
| status 回答 | 「順調？」「止まってる？」 | ① fresh `contract_check --stall-scan` ② `task_mirror --format ops` を apply ③ pending merge を `dock_merge poll`（§10） |
| session 再開 | wall-clock gap / 日付変化（最優先） | ① `--stall-scan`（`session_resume` banner が出れば dormant を **respawn**）② `task_mirror --format ops` を apply ③ heavy producer 走行中なら `dispatch_watch`（§3 / --fleet）を background で起動し直す |
| merge 完了 | `MERGE_RESULT:` / result JSON | ① `task_mirror --format ops` を apply（result JSON の `task_mirror_hint` が正確な command）② 次の pending を `dock_merge poll`（§10） |
| cleanup 完了 | `dispatch_cleanup` の JSON | ① `task_mirror --format ops` を apply（cleanup JSON の `task_mirror_hint` が正確な command） |

bundle の中身:

- **fresh `contract_check --stall-scan`** — 各 dispatch の判定（build-wait / stall-suspect /
  post-commit-stall / ungated-reporting / unknown）を取る。記憶や「さっき動いてた」で返さない。
  scan は **ungated REPORTING**（gate 未実施で放置された完了 dispatch、W-086 盲点）も拾い、
  watch heartbeat の無い WORKING dispatch を **`UNWATCHED`**（top-level `unwatched` list、W-085）
  として報告する — 出たら §3 の `watch_cmd` / `--fleet` で watch を arm する（advisory、`ok` は倒さない）。
  cleanup 未実行の landed merge（success result + workbench branch 残存、直近 24h）を
  **`UNPROCESSED-RESULT`**（top-level `unprocessed_results` list、W-086）として報告する — 出たら §1 の
  `dispatch_cleanup.sh --delete-branch` を回し次 merge を drain する（advisory、`ok` は倒さない）。
  register 未処理（`register_received` marker 不在）の idle dispatch — REPORTING の done-but-
  unregistered / WORKING の停滞 / gate 役の verdict 未着 — を **`IDLE-NO-REGISTER`**（top-level
  `idle_no_register` list、W-018）として報告し、各 item に送信用 `wake_cmd` を同梱する — 出たら §3 の
  とおり文面を verbatim で wake し、処理後に marker を touch する（advisory、`ok` は倒さない）。
  長時間 dormant な stall は `escalation:"revive"`（REVIVE-NEEDED、既定 30 分）へ上げる —
  REVIVE-NEEDED は worktree からの fresh **respawn**（wake ではない）。判定語彙は
  `role_subagent_dispatch.md` §6 の単一 taxonomy（PROGRESS / ADVANCING / BUILDING / STALLED /
  RUNAWAY / REVIVE-NEEDED）で `dispatch_watch` と共通。`--stall-scan` は前回 scan からの gap が
  `--resume-gap-hours`（既定 2h）超なら `session_resume` banner（`SESSION-RESUME: … respawn
  required`）を先頭に出すので、session 再開 anchor の「強制 health-scan」もこの 1 command で兼ねる。

```bash
bun skills/garelier-core/driver/src/dispatch/contract_check.ts --pm-id <pm_id> --project <root> --stall-scan --format text
```

- **`task_mirror --format ops` を apply** — session の Task list を canonical backlog +
  live dispatch から **derive** し直す（DEC-092）。merge / cleanup は結果 JSON に
  `task_mirror_hint`（そのまま走らせられる command）を同梱するので、それを実行して出た ops を
  **そのまま** 適用する。event 駆動 — PM の「記憶して手で回す」を廃す（stall-scan / watchdog と
  同じ「anchor で自動」原則）。

```bash
bun skills/garelier-core/driver/src/dispatch/task_mirror.ts --pm-id <pm_id> --project <root> --format ops --current <TaskList.json>
```

- **必要なら revive / respawn** — 上の scan が REVIVE-NEEDED / dormant を返したら §3 の
  warm-resume / fresh respawn に乗せる。

**session TaskList は task_mirror ops でのみ更新する（hand-craft 禁止、DEC-092）.** PM が
Task list を手で作る／書き換えると canonical から drift する。TaskCreate / TaskUpdate は
`task_mirror --format ops` が出した op を **judgment-free に適用するだけ**（内容は script が
決める）。「たぶんこの item が済んだ」で手 update しない — backlog が canonical、mirror は
derive view（不一致は backlog が勝つ）。単一 item だけの session では mirror を省く。

- **fleet 全体の durable 監視** — 個別 heavy producer は §3 の `dispatch_watch.sh`（single）、
  **pm-id 配下の全 dispatch を 1 プロセスで durable に見張る**なら `--fleet`。WORKING/REWORK +
  ungated REPORTING を fingerprint（HEAD | STATE/report hash）で追い、長時間 dormant + build 無しを
  `RESULT: REVIVE-NEEDED` で LOUD に返し（対象ゼロで `RESULT: DRAIN` → exit 0）、operator を起こす：

```bash
bash skills/garelier-core/scripts/dispatch_watch.sh --fleet --project <root> --pm-id <pm_id>
#   （既定: --stall-min 30 --interval-sec 90 --max-run-min 60。REVIVE 行 or DRAIN で exit）
```

- **常設 fleet watch（W-028、session 開始時に 1 本 arm）** — `dispatch_watch --fleet` は
  `--max-run-min` の窓が切れると exit するので、**再 arm しない限り無監視になる**（停滞が「PM が
  尋ねるまで」放置される構造要因）。これを消すのが `fleet_watch.sh`: 停滞 logic を一切持たず、
  既定 5 分ごとに `contract_check --stall-scan` を回し、**actionable（`idle_no_register` /
  `unprocessed_results` / `unwatched` のいずれか）を検出した瞬間だけ** `RESULT: FLEET-ATTENTION`
  ＋検出 JSON（`wake_cmd` 込み）で exit（run_in_background 完了通知で PM を起こす）。何も無ければ
  polling を続け、**期限で無監視にならない**（唯一の終端は actionable / driver stop / `--max-hours`
  安全上限、どれも「対処 → 再 arm」）:

```bash
bash skills/garelier-core/scripts/fleet_watch.sh --project <root> --pm-id <pm_id>
#   （既定: --interval-sec 300 --max-hours 12 --confirm-delay-sec 60 --suppress-min 15。
#    FLEET-ATTENTION / FLEET-CLEAR / FLEET-STOP で exit 0、lock により二重起動は exit 3 で拒否、
#    stale lock は W-024 liveness で自動回収）
```

  分類は 100% `--stall-scan` 側に委譲するので build-wait を誤検出しない。§3 の `dispatch_watch`
  （single、heavy producer の近接 RUNAWAY 監視）と併走 — single watch が窓切れで消えても
  fleet_watch が `unwatched` で拾う。pm_field_manual §1 に決定表。
  **wake-spam 抑制（W-029）.** 単発 scan は瞬間値なので producer の race で誤発火する（初日実測
  5 発中 4 発が偽陽性）。fleet_watch は actionable を**即発火せず**、`--confirm-delay-sec`（既定 60s）
  待って**再 scan**し、(1) 両 scan で actionable かつ (2) `items[].tip_sha`＋`dirty_hash`
  fingerprint が不変の dispatch **だけ**発火する（build-wait で procs が一瞬 0 に見えた偽陽性は
  confirm scan で消え、dirty が伸びている＝編集中は fingerprint が動くので落ちる）。発火した key は
  `runtime/driver/fleet_watch_state.json` に刻まれ、`--suppress-min`（既定 15 分）の間は再 flag
  しない（PM が手でやっていた「それはもう起こした」判断の機構化）。`unprocessed_results` は
  fingerprint を持たないので presence＋window だけで confirm。

**watchdog の reset 規約（監視を回すときの原則）.** heartbeat / watchdog / `dispatch_watch.sh`
の timer を **reset するのは進捗の証拠だけ** — 新 commit / tip 移動 / dirty-hash 変化、
または worker の実質 message（新 SHA・gate 結果・STATE 遷移）。**bare な idle ping /
liveness では reset しない**。dormant な producer が ping だけで timer を延ばせると
watchdog が無効化する（reset 権は monitor 側が持ち、サブの自己申告では動かさない）。

**push-signal の分担（W-071、Agent Teams 公式）.** teammate の死は 2 経路で来る。**API エラーで
死ぬと lead に "failed" 報告**が push される（v2.1.198 公式）—これは **即 respawn trigger**（wake で
なく worktree からの fresh respawn 一択；`/resume` は teammate を復元しない）。一方 **silent dormancy
（"failed" も idle notification も来ない無音）は watchdog の担当**（`--stall-scan` の REVIVE-NEEDED /
`dispatch_watch --fleet`）。2 つは別 failure mode を別機構が拾う分業なので、混同しない
（`role_subagent_dispatch.md` §6）。

**根拠(実例).** 2026-07-04→05、worker が ~21h dormant（session pause）だったのに PM が
fresh stall-scan せず「順調」を複数回 誤答し、user の「止まってる？」で初めて発覚（W-071）。
同 class で、merge / dispatch_cleanup 完了時に `task_mirror` が自動発火せず PM が session
TaskList を **hand-craft** して canonical backlog から drift（W-076、DEC-092）。どちらも
mechanism-without-reachability の同型（scan / mirror は在るが anchor の前に reach されない）。
W-071 で `dispatch_watch --fleet` + `--stall-scan` の REVIVE-NEEDED / ungated-REPORTING /
session-resume 検知を、W-076 で merge / cleanup 完了 JSON への `task_mirror_hint` 同梱を landed。
attended はこの anchor bundle でそれらへ reach する。

---

## 12. 高 stakes merge は Observer verdict の上に refuter を 1 体（W-066）

**状況.** Observer が単独 reviewer として PASS を返したが、その PASS 自体が
plausible-but-wrong / rubber-stamp かもしれない。単一 reviewer の相関盲点は、
もう 1 体の独立 agent に「その verdict を覆せるか」を試させないと潰れない。

**正しい手.** merge が **高 stakes**（`[observer_policy]` の `require_for_*` 部分集合 =
`require_for_large_diff` / `require_for_protected_paths`、または semantic な
migration / public_api / auth_security）のときだけ、Observer verdict 受領後に
**refuter を +1 体** spawn する。**日常 merge には焚かない**（コスト設計。
`require_for_all_merges` は高 stakes トリガではない — 全 merge に焚くと設計が逆転する）。

1. refuter は Observer verdict の**再レビューではなく検証**（refute-default）。
   PASS なら覆せるか / REWORK なら指摘が無効か を file:line 証拠で試す。tier =
   通常 `sonnet` / critical・security は `opus`（`fable`/`haiku` 不使用）。
   prompt 雛形と役割定義は `attended-gate-dispatch.md` § High-stakes refuter と
   `../../garelier-observer/references/refuter-verify.md`。
2. refuter は `__garelier/<pm_id>/runtime/observer/results/<slug>-refuter.md` に
   `refuter_verdict: UPHELD|REFUTED` marker を自分で書く（DEC-090 — PM は authored しない）。
3. `merge_request.sh --refuter-verdict <UPHELD|REFUTED> [--refuter-report <path>]` で
   relay する。**REFUTED** なら merge gate が verdict を **hold**（`status=failed`）して
   PM escalate、**UPHELD** は通常 merge。高 stakes なのに refuter を焚かなかった場合は
   `--high-stakes` を付けると gate が result に advisory warn を残す（非 block）。

**根拠.** lens（1 agent の観点パック）とは別機構。ultracode で loader-sealed critical /
verdict fail-open を掘れたのは「refute-default の独立 verify」を足したから。既定
（flag 無し・低 stakes）は挙動不変で、コストは高 stakes 分のみ。

---

## 参照

- `attended-gate-dispatch.md` — attended PM の Guardian→Observer gate dispatch template、
  high-stakes refuter（W-066）、mechanical-delta re-gate（W-032）、harness message tax
- `../../garelier-observer/references/refuter-verify.md` — refuter 役割定義（W-066 opt-in 敵対 verify）
- `../../garelier-dock/references/merge-gate.md` — merge gate lifecycle、verdict-SHA
  binding（§8.1.A）、forward-integration（§8.5/§8.6、DEC-039）
- `mode_e_jig.md` — driver 運用時の jig/gate loop（`jig_gate_held` 等）
- `driver-batch-boundary.md` — 1 iteration = 1 assignment の境界、lazy-load 順
- DEC-039 / DEC-088 / DEC-090 / DEC-091 — forward-integration / evidence 要求 /
  gate verdict 境界 / scoped gate build-stall 防止
