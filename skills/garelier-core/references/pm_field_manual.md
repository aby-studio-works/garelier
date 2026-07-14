# PM field manual — 判断不要の手順表・決定表

`pm_playbook.md` の**機械化された姉妹編**。playbook は「状況 → 正しい手 → 根拠(実例)」で
書かれていて、読み手が「今どの状況か」を自分で見分けて手を選ぶ前提になっている。この
file はその見分けと選択を**決定表**（左列＝機械的トリガ → 右列＝そのまま実行する手）と
**番号付き手順**に落とし、運用判断を合成しなくても execute できるようにしたもの。

**この file の使い方（3 ルール）:**

1. **左列のトリガに合致したら、右列を verbatim で実行する。** 「なぜ」を再構成しない。
   根拠・実例が要る時だけ、各節末尾の「→ pm_playbook §N」を開く。
2. **command は placeholder（`<pm_id>` `<root>` `<N>` `<slug>`）を埋めてそのまま走らせる。**
   定型 boilerplate は手書きしない（`dispatch_prepare.sh` / `merge_land.sh` が emit する値を使う）。
3. **迷ったら止まって file を実査する。** 印象・記憶で答えない。status/verdict/進捗は
   全て `git` / `contract_check` / marker file で機械確認してから動く。

read-on-demand（DEC-032、常駐させない）。playbook と**重複させず相互参照**する —
本 file は「手順の文書化」で、register↔report.md の二重帳簿解消（W-019）や gate 結果 path
正本の機械化（W-020）は別 task（機構）。機構が landing するまでの手動手順であり、landing 後も
判断基準として残す。gate の verdict 生成・検証は PM の仕事ではない（DEC-090）— PM は marker を
relay するだけ。

---

## 0. 索引（トリガ → 節）

| トリガ | 節 |
| :-- | :-- |
| producer が idle 通知を出した / 無音になった | §1 wake protocol |
| `GARELIER_PM_ESCALATION` / `GARELIER_RUNTIME_INCIDENT` marker を見た | §11 runtime incident 処理 |
| producer から完了 register（final message）が届いた | §2 register 処理 |
| merge 前に Guardian→Observer gate を依頼する | §3 gate 依頼 |
| gate 通過 branch を studio に land する | §4 merge_land |
| heavy build を走らせる / lock が塞いでいる | §5 lock 規律 |
| producer を dispatch する prompt を書く | §6 dispatch 必須文言 |
| 修正の効果を A/B で測る | §7 交絡排除 |
| register が長くて 1 message に入らない | §8 長文 register |
| studio に commit したい | §9 studio commit 規律 |
| gate 役に verdict marker を書かせる | §10 verdict template |

---

**外部 model worker (Codex 等) を使う場合**: 先に `codex_worker_playbook.md` (同 dir) を読む —
model 運用方針 (Codex first / Claude fallback)、sandbox 制約、rate 枯渇時の完全手順が正本。

**agent の使い回し規則**: idle agent はトークン消費ゼロで残留する。**同一対象への追加往復
(rework 後 re-gate / 反証照合 / 同じ diff への追加質問) は使い回す** — boot 分 (manual +
context 読込) を節約できる。**新規 task・大きな turn を終えた agent・新しい merge の gate は
fresh を立てる** — 前文脈の混入回避 + context 劣化 (大 review 後に無反応化する実例 2026-07-07)
+ gate の独立性 (fresh eyes) のため。

## 1. wake protocol — idle ≠ 即 wake

**大原則: idle 通知を受けても即 wake しない。** 必ず先に evidence を取ってから分類する。
手で「無音 = 止まってる」と即断して wake / respawn すると、build 中の producer を殺す。

**手順:**

1. まず 1 command を回して evidence（fingerprint + procs + 分類）を取る:

```bash
bun skills/garelier-core/driver/src/dispatch/contract_check.ts --pm-id <pm_id> --project <root> --stall-scan --format text
```

2. scan の出力を下表の左列に合わせ、右列を verbatim で実行する（**合致が無ければ wake しない**）:

| scan が示すもの | 実態 | 手（判断不要） |
| :-- | :-- | :-- |
| dirty_hash 変化 / 新 commit / 直近 interim message あり | 進捗している | **何もしない**（wake しない） |
| `BUILDING` / build proc（cargo・rustc）生存 | cold build 中（正当に数分〜十数分） | **何もしない**（wake しない） |
| `idle_no_register`（`IDLE-NO-REGISTER`） | REPORTING 到達で register 未着 / WORKING 停滞 / gate 役の verdict 未着 | item の **`wake_cmd` を verbatim** で `SendMessage` → 処理後 §2-2 の marker を touch（wake であって respawn ではない） |
| `unwatched`（`UNWATCHED`） | WORKING だが watch 未 arm | item の **`watch_cmd` を `run_in_background`**（wake ではない、§6 参照） |
| `unprocessed_results`（`UNPROCESSED-RESULT`） | merge 成功済だが cleanup 未 | `dispatch_cleanup.sh --delete-branch` を回し次 merge を drain（§9） |
| `STALLED` / stall-suspect（tip SHA が N 分不変で REPORTING 未達。commit 済でも該当） | 停滞 | 定型 nudge を送る（下記文面） |
| `REVIVE-NEEDED` / dormant（既定 30 分超無進捗） | 死んでいる | worktree から **fresh respawn**（wake ではない） |
| `session_resume` banner | wall-clock gap 後の再開 | banner の指示どおり dormant を respawn（§11 の anchor bundle を回す） |

3. 分類語彙（`PROGRESS` / `ADVANCING` / `BUILDING` / `STALLED` / `RUNAWAY` /
   `REVIVE-NEEDED`）は `dispatch_watch.sh` と共通の単一 taxonomy
   （`role_subagent_dispatch.md` §6）。

**定型 nudge の文面（stall-suspect / STALLED 用、これで書くと回収率が高い）:**

> 残作業は X と Y。15 分で REPORTING に達しなければ別 worker に handoff する。
> build 中なら「まだ build 中」と 1 行返して。

「進んでる?」のような曖昧な ping は送らない（watchdog の timer を reset する権利は
monitor 側だけ、bare な liveness ping では reset しない）。

**常設 fleet watch（W-028、停滞が「PM が尋ねるまで」放置される構造を消す）:**

`--stall-scan` を PM が思い出した時だけ手で回すと、(1) subagent は turn 終了後に外部 message まで
再起動されない、(2) `dispatch_watch` は窓が切れると無監視、(3) scan→wake が手動 — の 3 つで停滞が
放置される。対策は **session 開始時に fleet watch を 1 本だけ `run_in_background` で arm** すること:

```bash
bash skills/garelier-core/scripts/fleet_watch.sh --project <root> --pm-id <pm_id>
```

**arm 手順の固定（2026-07-07 実測、これを外すと網が沈黙する）: 必ず harness 追跡下の
`run_in_background` で起動する。** fleet watch は actionable を検出すると **exit して**
`run_in_background` の完了通知で PM を起こす設計なので、追跡されていない起動では発火が
誰にも届かない。shell の `&`（background job）で起こすのは **禁止** — `&` は harness 非追跡で
その exit が通知に化けず、監視網がそのまま沈黙する（＝この watch が塞ぐはずの穴に逆戻り）。
再 arm も同じく `run_in_background` の 1 本のみ。fleet_watch.sh は起動時に「起動先が追跡下か」を
内側から判別できない（`&` と `run_in_background` は区別不能）ため、起動のたび stderr にこの
注意 1 行を出す — 追跡下起動は PM 側の手順責任。

これは常設 loop で、既定 5 分ごとに `--stall-scan` を回し、**actionable
（`idle_no_register` / `unprocessed_results` / `unwatched` のいずれかが 1 件以上）を検出した
瞬間だけ** `RESULT: FLEET-ATTENTION` + 検出 JSON（各 `wake_cmd` 込み）を出して exit する。
run_in_background の完了通知で PM が起きるので、**下表どおり対処 → その後 fleet watch を再 arm**
（1 本のみ — 二重起動は lock が exit 3 で拒否）:

| RESULT | 意味 | 手（判断不要） |
| :-- | :-- | :-- |
| `FLEET-ATTENTION` + JSON | actionable 検出 | JSON の各項目（idle は `wake_cmd`、unwatched は `watch_cmd`、unprocessed は `cleanup_cmd`）を §上表どおり verbatim 実行（idle は wake→marker touch / unprocessed は cleanup / unwatched は dispatch_watch arm、組み立て不要、W-033）→ **再 arm** |
| `FLEET-CLEAR` | 12h 安全上限で無事終了 | そのまま **再 arm** |
| `FLEET-STOP` | driver stop file 検出 | stop を解除してから **再 arm** |

分類（build 中は wake しない 等）は全て `--stall-scan` 側に委譲されるので、fleet watch は
build-wait を誤検出しない。`dispatch_watch`（heavy producer の近接 RUNAWAY 監視）と併走する —
片方の watch が切れても fleet watch が `unwatched` で拾う。

→ pm_playbook §3, §11

---

## 2. register 処理 checklist

**トリガ: producer が完了 register（final message = 新 SHA + 結果）を返した。** 上から順に:

1. **受領** — final message の 新 SHA / branch / 結果を読む。
2. **marker を touch**（idle-no-register 抑制、W-018）:

```bash
touch __garelier/<pm_id>/_dispatch<N>/register_received
```

3. **report.md を永続化** — register 本文が report.md の正本（W-019）。worker が
   harness 制約で `report.md` template を埋められなかった場合、register 本文を該当 role の
   `__garelier/<pm_id>/_<role>/<id>/report.md`（isolate worker は dispatch checkout）に
   転写しておく（後続 gate / 監査が参照）。W-019 の自動転写が landing するまで手で。
4. **gate dispatch**（§3）— Guardian → Observer（固定順）。
5. **verdict marker を verify**（prose の verdict を鵜呑みにしない）:

```bash
bun skills/garelier-core/driver/src/dispatch/contract_check.ts --project <root> --pm-id <pm_id> --gate <slug> --roles guardian,observer --format text
```

   `ok:false`（exit 3）= marker 不在 / malformed → 印字された `nudge` を gate 役に verbatim 送る（§10）。
6. **land**（§4）— `merge_land.sh --id <N>`。
7. **anchor bundle を apply** — cleanup 完了 JSON の `task_mirror_hint` をそのまま実行して Task list を derive し直す（§11、hand-craft しない）。
8. **`TASK-MIRROR diff:` を反映**（W-030）— setup wizard が配線する framework 所有の PostToolUse hook（`skills/garelier-core/hooks/task_mirror_hook.sh`）が、land/dispatch コマンドの後に **差分だけ**を注入する（差分ゼロ＝無出力＝トークン0）。`TASK-MIRROR diff:` 行が出たら、その `追加`/`削除`/`変化` を `TaskCreate`/`TaskUpdate` にそのまま反映する（`#<id>` 紐付きは dispatch owner を設定）。行が出なければ Task list は既に一致——何もしない。

→ pm_playbook §11

---

## 3. gate 依頼の正準形

**report path の正本（W-020、これ以外に書かせない）:**

```
__garelier/<pm_id>/runtime/guardian/results/<branch-slug>-guardian.md
__garelier/<pm_id>/runtime/observer/results/<branch-slug>-observer.md
```

- **`<branch-slug>` は branch 由来の slug を使う。** 短縮名・別名で書かせると auto-read
  （`merge_land` / `contract_check --gate`）が拾えない（W-020 の実例）。
- 本文に **`## Verdict` 節必須**、その **直下は素の token 1 行だけ**（bold `**PASS**` /
  prose 文 `Guardian verdict: PASS …` / `{{}}` menu を残す、いずれも不可）:
  - Guardian: `PASS` / `PASS_WITH_NOTES` / `BLOCK` / `NO_OPINION`
  - Observer: `PASS` / `PASS_WITH_NOTES` / `REWORK_RECOMMENDED` / `BLOCK` / `NO_OPINION`
  - bold / prose 文 / `{{...}}` menu / typo（`PASSED` `BLOCKING`）/ 途中截断は
    すべて **null = fail-closed**（PASS にならず、`merge_land` の verdict auto-read が
    「verdict なし」として merge を止める。gate 役が prose verdict を書いた実例あり）。
  - marker の雛形 = `templates/gate_verdict.md`（§10）。最小 valid body:

    ```markdown
    ## Verdict

    PASS_WITH_NOTES
    ```

- **marker は gate 役自身が書く**（DEC-090）。PM は authored / republish しない。
- **prompt は手書きしない** — Guardian / Observer / refuter の完全な prompt template と
  naming（`ga-guardian-<slug>` / `ga-observer-<slug>`）、model 解決、post-dispatch verify は
  `attended-gate-dispatch.md` § Prompt templates を verbatim。`dispatch_prepare.sh` を
  通した producer なら `gate_agents.guardian` / `gate_agents.observer`（`name` + `report`）が
  context.json に確定済みなので、その値を使う（手で組まない）。
- 高 stakes merge（`require_for_large_diff` / `require_for_protected_paths` / semantic な
  migration・public_api・auth_security）だけ refuter を +1（`attended-gate-dispatch.md`
  § High-stakes refuter）。日常 merge には焚かない。

→ attended-gate-dispatch.md § Report contract / § Prompt templates、pm_playbook §2, §12

---


### 3.1 gate 依頼が判別力を持つ書き方 (2026-07-07/08 の実戦蒸留)

依頼文の質が verdict の質を決める。効いた型:

1. **対象を完全に pin**: branch + HEAD SHA + commit 数。**実装者が外部 model (Codex 等) なら明示**
   — gate の警戒水準が変わる (実例: 外部 model 産の初 merge に「通常より丁寧に」と書いた
   Guardian が bypass を scratch fixture 再現込みで検出)
2. **重点は番号付き 3-5 点、各点に「何をどう疑うか」まで**: 「正しいか確認」は無力。
   「この分界が攻撃面を残さないか — 悪意 MOD が同名 vault products を後勝ち merge で
   上書きする経路が cook で塞がっているか**実 code で確認**」のように、疑うべき経路と
   確認手段を書く
3. **本丸を 1 つ名指し**: 「ここが最大 risk (座標変換の正準整合)」— gate の時間配分が変わる
4. **worker の主張を並記**して突合を仕事にする: 「worker 主張: X test pass / diff 0」を書けば
   gate は主張の裏取りに回り、over-claim (「spawn に戻る」→ 実は dead field) を検出できる
5. **検証水準の宣言を要求**: register 冒頭に RUN / evidence-check / 静的 のどれで確かめたかを
   書かせる — 「見たつもり」を構造的に排除
6. **判断の正本を指定**: DEC / blueprint / backlog row の該当節 — gate の裁定が正本に接地する
7. verdict marker は正準 path + 素 token を毎回明記 (fail-closed に乗せる)

### 3.2 調査/実装 dispatch が迷子にならない書き方

1. **症状は生 data で貼る** (log 原文 / screenshot の記述) — 要約は仮説を混入させる
2. **手掛かり (candidate file 列挙) は与え、結論は与えない** — 「NavigatorDialogue の
   consumer は A/B/C/D (最後が新系=正)」まで絞ると精度が上がる
3. **裁定型 task は「どちらが正か判断して修正 + 根拠を doc に接地」**と書く (実例: 2 仕様書の
   矛盾 → 明示例のある側に倒す判断を worker がした)
4. **出口を常に 2 つ**: 完遂 or 「BLOCKED + 現状 dump」。BLOCKED を正当な成果と扱う
   (実例: 「削除すると test build が壊れる + 既存知見と矛盾」の BLOCKED が誤 dispatch を止めた)
5. **完遂できない場合の完成条件を定義**: 「次回起動 log で断点確定できる状態まで」等 —
   全か無かにしない
6. **並走 lane の禁止領域を列挙** (branch が見えない worker には必須)
7. **class 監査を仕込む**: 1 件直したら「同型が他に無いか grep」を AC に入れる

## 4. merge_land 使用手順

**既定（1 本で submit→wait→成功時のみ cleanup+pull を集約、W-088）:**

```bash
bash skills/garelier-core/scripts/merge_land.sh --project <root> --pm-id <pm_id> --id <N>
```

- `--id <N>`（= `--dispatch-id`、`dispatch_prepare`/`dispatch_cleanup` と同じ id）だけで解決する:
  - **branch** = `__garelier/<pm_id>/_dispatch<N>/checkout` の HEAD branch（明示 `--branch` は常に優先）。
  - **verdict** = §3 の marker を fail-closed parser で自動読取（marker 不在 / `{{}}` / typo は
    「verdict なし」= PASS 仮定しない）。
- **決定分岐 — auto-read が止まった時:**

| 起きたこと | 手（判断不要） |
| :-- | :-- |
| marker が不在 / 壊れている（fail-closed で submit されない） | gate 役に marker を直させる（§10 の nudge を wake）。**PM が verdict を発明しない** |
| marker は valid だが非 PASS（例 `PASS_WITH_NOTES`）で、PM が relay して通す | `--guardian <token>` / `--observer <token>` を明示。**渡す値は marker に実在する token のみ**（marker に無い verdict を捏造しない、DEC-090） |
| 必須引数が足りない | submit 前に一括で報告 + usage が出る。指示どおり補う |

- **連続 land は直列。** 1 本ずつ `run_in_background` で land する。複数を並列に land しない
  （merge gate は共有 index を張るので競合する）。
- **失敗（conflict / non-PASS / timeout）は cleanup せず非 0 exit** — branch の作業は保全される。
  復旧は producer の tip SHA から `git branch -f <name> <sha>`（§5）。
- backlog の close 行まで畳むなら `--close-row <item-id>`（複数可）。

→ pm_playbook §1

---

## 5. lock 規律 — heavy_compile_lock（RAM 直列）

merge-gate の `active.lock`（studio commit 排他、§9）とは**別の lock**。こちらは heavy build
（full-workspace compile ≈ 16GB）の**同時本数を絞る** lock。slot dir は
`__garelier/<pm_id>/runtime/locks/heavy_compile/`。

**PM が対話的に heavy build を走らせる時の手順（保持待機禁止）:**

```bash
# build の直前に acquire
TOKEN=$(bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode acquire --label <slug>)
#   … この間に heavy build を走らせる …（TOKEN が "OPEN" のときは lock 無効/fail-open、そのまま進む）
# build の直後に release（即座に。lock を握ったまま眠らない・他作業しない）
bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode release --token "$TOKEN"
```

- **docs / 調査 / 監査（build 無し）は lock 不要で並列可。** RAM を食わない。
- **RAM 直列 = PM の GO 合図.** 複数の heavy build を並べたい時、PM が「今から N を走らせる」と
  **1 本ずつ GO を出して串刺し**にする（同時 1 本 = `max_concurrent`）。2 並列 full-workspace
  compile は OOM（`undefined symbol anon.llvm` link err / incremental 破損）を起こす。

**stale lock の見分け方と手動解放（W-024 が自動 liveness reclaim を landing するまで）:**

stale の条件（いずれか）: (a) owner pid が死亡、(b) lease（既定 240 分）超過、(c) owner の
cargo/rustc プロセスが 0 なのに slot が残っている（← W-024 が塞ぐ盲点）。

| 手順 | command / 確認 |
| :-- | :-- |
| 1. build proc を確認 | `tasklist`（Windows）で cargo/rustc を見る。**該当 build の proc が生存していれば触らない** |
| 2. sweep で pid 死亡 + lease 超過を回収 | `bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode sweep` |
| 3. sweep で消えず proc 0 を確認済みなら slot を rm | `runtime/locks/heavy_compile/` 下の該当 slot dir を削除（proc 0 を確認してから、これ 1 回きり） |

acquire は timeout で fail-open（`OPEN` を返して pipeline を止めない）ので、握れなくても
deadlock しない。

→ pm_playbook §6

---

## 6. worker dispatch prompt の必須文言 checklist

prompt = **`dispatch_prepare.sh` の `prompt_preamble` を冒頭に verbatim + 任務固有本文だけ**
（W-095）。preamble が下の定型を満たすので、PM は**この checklist を「preamble に入っているか」
の verify list として使う**（preamble を使わず手書きする時は全項目を自分で満たす）:

- [ ] **checkout の絶対 path** + 「**親 repo / primary checkout を直接編集しない。cargo も
      編集も commit も必ず自分の `…/checkout/` worktree の cwd で**」— primary で走らせると
      検証 evidence が丸ごと無効化する（誤走 2 回の実害）。
- [ ] **着手時 base-track** — studio を merge してから始める。
- [ ] **commit 書式 + trailer** — preamble の `{{TASK_ID}}` placeholder を bound backlog id
      （例 `W-123`）に置換。
- [ ] **register 終端** — 完了時に **1 本だけ**、新 SHA + 結果を含む final message（commit/report 後、途中や事前でなく）。
- [ ] **台帳消し込み** — 走行中の scope 追加は口頭 message でなく `instructions.md` の
      `- [ ] I<n> …` に append してから pointer を message（W-092）。
- [ ] **heavy build 規律** — 同時 1 本、他が build 中なら待つ / docs・調査は並列可（§5）。
- [ ] **scope 境界** — 触ってよい path と触るなの境界。逸脱しそうなら silent に広げず BLOCKED。
- [ ] **push 禁止** — workbench branch は push しない。
- [ ] （対象 project 固有）**determinism 制約** — 該当時は blueprint の design-review notes に埋める。

heavy producer を spawn したら**即** `dispatch_prepare.sh` emit の `watch_cmd` を
`run_in_background` で arm する（必須、W-085）。忘れると無音のまま dormant 化する。

**MANDATORY（W-049）— Agent tool の `model:` param:** `dispatch_prepare.sh` の
JSON にある `model`（producer）/ `gate_agents.guardian.model` /
`gate_agents.observer.model`（gate）を、subagent を起こす Agent tool 呼び出しの
**`model:` param に必ずそのまま渡す**。省略すると Claude Code の Agent tool は
**親（PM）session の model を無音で継承する**（error にも warning にもならない）。
これは実害が出た（target project 実戦 2026-07-11: worker 1 + gate 4 体が `model:` 未指定で
PM 自身の model のまま走った）。JSON の `spawn_directive` field にこの警告文が
埋め込まれているので、Agent tool を組み立てる直前に読み返す。

→ pm_playbook §7、attended-gate-dispatch.md

---

## 7. 検証設計の交絡排除

**A/B で修正の効果を測る時は、対照側を無効化してから単独で測る。**

- 修正 X の効果を測るなら、既存の bypass / fallback / 旧 path を**先に off にする**。
  bypass が入ったまま「X の効果」を測ると、実際に効いているのが X か bypass か切り分けられず、
  結論が交絡して丸ごと無効になる。
- dispatch prompt に明示する: 「対照は片方（bypass / 旧経路）を off にして単独で測れ。
  両方 on のまま before/after を比較しない」。

→ pm_playbook §9（evidence で真因確定）

---

## 8. 長文 register の part 分割

register が長く 1 message に収まらない時、**dispatch prompt で最初から part 分割を許可する**:

> 完了 register が長い場合は final message を `part 1/N` `part 2/N` … に分割してよい。
> 最初の part で N を宣言し、順に送ること。1 message に押し込んで截断されるより分割が正。

harness の message サイズで truncate されて register が欠けるより、明示的な分割のほうが安全。

---

## 9. studio commit 規律

- **studio への commit は merge gate idle 時のみ。** `__garelier/<pm_id>/runtime/merge_gate/
  locks/active.lock` が在る間は commit しない — gate が張った staged merge を git が吸収して
  2-parent merge commit になり、gate が abort する（W-055）。別件は溜めて **gate idle 時に
  batch commit** する。
- **gitignored path（`runtime/` 配下）を commit に混ぜない。** `git add -A` を使わず対象 path を
  明示 add。commit 前に `git status` で `runtime/` が staged されていないか確認する。
- **手動確認を避けたいなら `pm_commit.sh` で commit する（W-023）。** `git commit` を薄く包み、
  `active.lock` 在中 or 未処理 gate request があれば commit を止める。既定は明確に断る、
  `--wait` で gate idle まで poll してから commit:

  ```bash
  # 既定 = gate 走行中なら refuse（exit 3、何も commit しない）
  bash skills/garelier-core/scripts/pm_commit.sh --project <root> --pm-id <pm_id> -- -m "<msg>" -- <path…>
  # --wait = gate idle まで待ってから commit
  bash skills/garelier-core/scripts/pm_commit.sh --project <root> --pm-id <pm_id> --wait -- -m "<msg>" -- <path…>
  ```

  git hook ではなく明示 wrapper（producer worktree の commit を巻き込む W-158 の誤爆を避けるため
  ambient にしない）。`--project`/`--pm-id` 以降の残り引数は `git commit` へそのまま渡る。

→ pm_playbook §1（merge gate 走行中の commit 吸収）

---

## 10. gate verdict marker template

gate 役（Guardian / Observer）が verdict marker を書く時の雛形 = `templates/gate_verdict.md`。

- 置き場は §3 の正本 path（`runtime/<role>/results/<branch-slug>-<role>.md`）。
- `## Verdict` 節の直下に **canonical token 1 個だけ**。`{{}}` menu を残したまま提出すると
  fail-closed で「verdict なし」になり merge が止まる（＝埋め忘れが安全側に倒れる設計）。
- finding は file:line / diff evidence 付き（DEC-088）。bare な形容詞 verdict は不可。
- marker が不在 / malformed（`contract_check --gate` が `ok:false`）なら、印字された `nudge` を
  gate 役に verbatim 送って直させる（§2-5）。PM は marker を書かない（DEC-090）。

refuter（高 stakes のみ）は `## Verdict` ではなく `refuter_verdict: UPHELD|REFUTED` 行形式
（`attended-gate-dispatch.md` § High-stakes refuter）。

---

## 参照

- `worker_field_manual.md` — dispatch する producer（Worker / Scout）側の決定表（対になる view）
- `gate_field_manual.md` — gate 役（Guardian / Observer）側の決定表 + Observer 独立レビュー視点集
- `pm_playbook.md` — 各節の「なぜ」と実例（§1 cleanup 順序 / §2 SHA-verdict bind / §3 idle 三分岐 /
  §6 RAM 律速 / §7 dispatch prompt / §11 anchor protocol / §12 refuter）
- `attended-gate-dispatch.md` — gate dispatch の完全 prompt template、report contract、
  high-stakes refuter、mechanical-delta re-gate
- `role_subagent_dispatch.md` §6 — stall taxonomy（PROGRESS / ADVANCING / BUILDING / STALLED /
  RUNAWAY / REVIVE-NEEDED）と push-signal 分担
- `../../garelier-dock/references/merge-gate.md` — merge gate lifecycle、verdict-SHA binding
- `templates/gate_verdict.md` — verdict marker 雛形
- scripts: `merge_land.sh` / `heavy_compile_lock.ts` / `dispatch_watch.sh` /
  `dispatch_prepare.sh` / `contract_check.ts`
- 役割分担: 手順の文書化＝本 file、機構化＝ W-019（report 二重帳簿）/ W-020（gate path 正本）/
  W-024（lock stale 自動 reclaim）。機構が入っても判断基準は変わらない。

---

## 11. runtime incident 処理

**トリガ:** `GARELIER_PM_ESCALATION` / `GARELIER_RUNTIME_INCIDENT` marker を見た。

1. **user に聞く前に incident を読む。** 最新 open incident を機械確認する:

```bash
tail -n 20 .claude/runtime/garelier/incidents.jsonl
```

2. **rerun safety を分類する（判断表どおり）:**

| 分類 | command / 状況 | 手 |
| :-- | :-- | :-- |
| `safe` | read-only / test / build / check / lint / grep / status | recovery subagent を起動し、`incident_id` だけ渡す |
| `needs_inspection` | generator / install / cache warm / dependency fetch / large log rewrite | incident と log を読ませ、差分・生成物・cache 範囲を確認してから再実行 |
| `unsafe` | delete / reset / credential / publish / push / external API write / production data mutation | 破壊操作・外部 write の前に user 確認。dry-run、rollback、before/after counts が無ければ止める |

3. **safe は recovery subagent に渡す。** prompt は incident_id だけを正本 pointer にする:

```text
Recover runtime incident <incident_id>. Read .claude/runtime/garelier/incidents.jsonl,
inspect the referenced command/log/output, do not immediately rerun the same command
after timeout, and finish with:
GARELIER_RUNTIME_STATUS: {"runtime_ok": true|false, "incident_id": "<incident_id>", "evidence": "..."}
```

4. **unsafe は user 確認が先。** `rm -rf` / `git reset --hard` / credential 操作 / publish /
   push / production write は、確認なしに recovery subagent へ実行させない。
5. **復旧後 marker 必須。** recovery の最終行は必ず
   `GARELIER_RUNTIME_STATUS: {"runtime_ok": true, ...}`。`runtime_ok:false` または marker 無しは
   未復旧として扱い、同じ command を即再実行しない。
6. **marker は本文への「追記」であって置換ではない (W-067)。** subagent の final message が
   marker 1 行だけで調査本文/deliverable を欠くのは契約違反 — 実戦で Explore agent の
   最終出力が marker のみになり調査本文が届かない事象を 3 回観測 (agent 側には結果が実在 =
   生成でなく伝達の欠落)。PM 側の扱い: **marker-only final message は stall と同格**として
   `SendMessage` で本文を再要求する (再要求で回収できる)。subagent へ出す prompt には
   「final message = 本文 + 最終行に marker、marker 単独は違反」を明記する。
