# PM field manual — 判断不要の手順表・決定表

`pm_playbook.md` の**機械化された姉妹編**。playbook は「状況 → 正しい手 → 根拠(実例)」で
書かれていて、読み手が「今どの状況か」を自分で見分けて手を選ぶ前提になっている。この
file はその見分けと選択を**決定表**（左列＝機械的トリガ → 右列＝そのまま実行する手）と
**番号付き手順**に落とし、運用判断を合成しなくても execute できるようにしたもの。

**この file の使い方（3 ルール）:**

1. **左列のトリガに合致したら、右列を verbatim で実行する。** 「なぜ」を再構成しない。
   根拠・実例が要る時だけ、各節末尾の「→ pm_playbook §N」を開く。
2. **command は placeholder（`<pm_id>` `<root>` `<N>` `<slug>`）を埋めてそのまま走らせる。**
   定型 boilerplate は手書きしない（`dispatch_prepare.ts` / `merge_land.ts` が emit する値を使う）。
3. **迷ったら止まって file を実査する。** 印象・記憶で答えない。status/verdict/進捗は
   全て `git` / `contract_check` / marker file で機械確認してから動く。

read-on-demand（DEC-032、常駐させない）。playbook と**重複させず相互参照**する —
本 file は「手順の文書化」で、register↔report.md の二重帳簿解消（W-019）や gate 結果 path
正本の機械化（W-020）は別 task（機構）。機構が landing するまでの手動手順であり、landing 後も
判断基準として残す。gate の verdict 生成・検証は PM の仕事ではない（DEC-090）— PM は marker を
relay するだけ。

---

<a id="pmfm-entry"></a>

## 入口 — 記憶から手順を再構成しない

PM が land、seat 投入、resume、artifact bind、post-land 回復で使う版管理済みの手順正本が
本 file である。**記憶から手順を再構成せず、まず canonical Control と
`garelier pm next --work W-NNN` が出す `NEXT_COMMAND` を読む。**

```bash
garelier control list backlog --project <project> --pm-id <pm_id> --format json
garelier pm next --work W-NNN --project <project> --pm-id <pm_id>
```

`pm next` は claim、dispatch context、instruction ledger、gate log、Guardian / Observer
verdict、merge request / result を再読して**次の 1 command を出す**。下の索引はその 1 command が
止まった時、または手で辿る時に引く。

**Control mutation が timeout した時は canonical state を再読し、mutation を盲目的に
再実行しない。** timeout は「効かなかった」ではなく「結果が分からない」であり、再実行は
二重適用になりうる。

---

<a id="pmfm-0"></a>
## 0. 索引（トリガ → 節）

| トリガ | 節 |
| :-- | :-- |
| PM turn を始める / 次の 1 手が分からない | [§入口](#pmfm-entry) — `pm next` が出す `NEXT_COMMAND` を先に読む |
| role が idle 通知を出した / 無音になった | §1 wake protocol |
| `GARELIER_PM_ESCALATION` / `GARELIER_RUNTIME_INCIDENT` marker を見た | §11 runtime incident 処理 |
| role から完了 register（final message）が届いた | §2 register 処理 |
| merge 前に Guardian→Observer gate を依頼する | §3 gate 依頼 |
| gate 通過 branch を studio に land する | §4 merge_land |
| heavy build を走らせる / lock が塞いでいる | §5 lock 規律 |
| role を dispatch する prompt を書く | §6 dispatch 必須文言 |
| 修正の効果を A/B で測る | §7 交絡排除 |
| register が長くて 1 message に入らない | §8 長文 register |
| studio に commit したい | §9 studio commit 規律 |
| gate 役に verdict marker を書かせる | §10 verdict template |
| lane が終わったか判らない / STATE.md と register が食い違う | §2-0 lane の状態の読み方 |
| codex lane の dirty を PM が commit する / review SHA を束縛する | §3.3 proxy commit と review SHA |
| scanner を実走する / `--security-root` が refuse された | §3.4 mandatory scanner |
| Dock seat・Guardian・Observer を出す argv が要る | §3.5 Dock gate と review seat |
| `merge_land` が refuse した | §4.3 refusal recovery |
| land 後に cleanup / Control evidence が欠けた | §4.4 post-land recovery |
| 走行中 lane に追加指示を届ける / ledger を消し込ませる | §12 resume と instruction ledger |
| `command_guard` に deny された / control mutation の argv が要る | §13 PM shell / artifact 規約 |
| gate が遅い / Bun・lock・summary metrics の扱い | §14 負荷と gate 運用 |
| 手順書どおりに打ったのに argv が違った | §15 実測で確定した argv |
| 上のどれにも当たらない実測 fact を引く | §16 運用実測 fact の転記 |

**この file は `pm_field_manual.md` の唯一の正本**である (2026-09-03、W-538 束)。
かつて `skills/garelier-pm/references/pm_field_manual.md` に同名の第 2 の file があり、
merge_land / resume / PM shell を別番号で二重に持っていた。その固有内容は本 file の
§2-0 / §3.3-3.5 / §4.2-4.4 / §12-§15 へ吸収し、pm 側 file は削除した。転送 stub は置かない —
`pm_field_manual.md` への pointer は本 file だけを指す。

---

**外部 model worker (Codex 等) を使う場合**: 先に `codex_worker_playbook.md` (同 dir) を読む —
sandbox 制約、起動手順、rate 枯渇時の完全手順が正本。**どの provider を優先するかは
framework でなく project の user+PM 裁定** (per-task flag で伝える)。

**agent の使い回し規則**: idle agent はトークン消費ゼロで残留する。**同一対象への追加往復
(rework 後 re-gate / 反証照合 / 同じ diff への追加質問) は使い回す** — boot 分 (manual +
context 読込) を節約できる。**新規 task・大きな turn を終えた agent・新しい merge の gate は
fresh を立てる** — 前文脈の混入回避 + context 劣化 (大 review 後に無反応化する実例 2026-07-07)
+ gate の独立性 (fresh eyes) のため。

<a id="pmfm-1"></a>
## 1. wake protocol — idle ≠ 即 wake

**大原則: idle 通知を受けても即 wake しない。** 必ず先に evidence を取ってから分類する。
手で「無音 = 止まってる」と即断して wake / respawn すると、build 中の role を殺す。

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
| gate 席（guardian / observer）が `unwatched` に出ない | **正常**。gate 席は read-only で席固有 branch も worktree も持たず、`dispatch_watch` の branch 基準の進行 signal が原理的に効かない（`--id` では branch を解決できず exit 2）。`watch=not-applicable` として分母から外れる | **何もしない**。gate 席の進行は `items[].gate_verdict`（`absent` / `published` = verdict file の有無）で読む。**REPORTING に達したのに verdict が無い**席は従来どおり `idle_no_register` の `gate-no-verdict` に出る。**既知の gap**: **WORKING のまま死んだ gate 席は何も検出しない**（`gate-no-verdict` は REPORTING 分岐、Agent-tool 席は `lane/result.md` を書かない）。外した `unwatched` は全 gate 席で constant-true = 判別力 0 だったので退行ではないが、gap は未閉（W-632 AC-3b） |
| `unprocessed_results`（`UNPROCESSED-RESULT`） | merge 成功済だが cleanup 未 | `dispatch_cleanup.ts --delete-branch` を回し次 merge を drain（§9） |
| `STALLED` / stall-suspect（tip SHA が N 分不変で REPORTING 未達。commit 済でも該当） | 停滞 | 定型 nudge を送る（下記文面） |
| `REVIVE-NEEDED` / dormant（既定 30 分超無進捗） | 死んでいる | worktree から **fresh respawn**（wake ではない） |
| `session_resume` banner | wall-clock gap 後の再開 | banner の指示どおり dormant を respawn（§11 の anchor bundle を回す） |

3. 分類語彙（`PROGRESS` / `ADVANCING` / `BUILDING` / `DECLARED-DONE` /
   `SPAWN-GRACE` / `STALLED` / `RUNAWAY` / `REVIVE-NEEDED`）は
   `dispatch_watch.ts` と共通の単一 taxonomy
   （`role_subagent_dispatch.md` §6）。

**定型 nudge の文面（stall-suspect / STALLED 用、これで書くと回収率が高い）:**

> 残作業は X と Y。15 分で REPORTING に達しなければ別 worker に handoff する。
> build 中なら「まだ build 中」と 1 行返して。

「進んでる?」のような曖昧な ping は送らない（watchdog の timer を reset する権利は
monitor 側だけ、bare な liveness ping では reset しない）。

**silent-idle（無言 idle）= register が「無い」class（W-200）:** register/progress を 1 通も
出さず turn を終えた seat は `idle_no_register` の `working-stalled` として上表 §71 の経路で
拾う（`STALE-REGISTER`＝register は「有るが古い」class の姉妹。両者は相補で state
を共有しない）。この経路の `wake_cmd.message` は **「残 step 明示形」template を機械生成済**
（残り step の番号列挙＋現在 step＋次の 1 手／build 待ちなら bg job を貼り直して progress ／
進められないなら BLOCKED、の 3 択。上の定型 nudge を実戦で強化した文面）なので、PM は
`wake_cmd` を **verbatim** で送るだけでよい（自分で文面を組まない）。

**構造制約（doc 明記, W-200）:** `contract_check --stall-scan` / `fleet_watch` は wake を
**提示するだけ**で、実 `SendMessage` は **親 PM session が実行する**。session 内 teammate
（Agent tool で spawn した seat）への送信は親 session しかできない構造で、detective 自身や
別 process からは送れない。だから半自動化の到達点は「機械が判定＋文面を出し、PM が 1 手
verbatim 送信」であって、送信まで自動化はしない（権威なし不変則＝判定に留める、の実装形）。

**spawn/resume grace（W-143）:** role の spawn 直後〜premise 読込 / think phase は
「commit 0・fingerprint 不変・compile procs 0」= stall と同形だが正常なので、両 watchdog は
container の `dispatched_at`（dispatch_prepare が spawn 時に書く epoch）から既定 **10 分**（`dispatch_watch --spawn-grace-sec` / `contract_check --spawn-grace-sec`、秒）は IDLE-DONE / working-stalled を発火しない。**window 末尾の終端判定も同じ grace に従い**、猶予内の flat window は `STALLED` ではなく `SPAWN-GRACE`（非 stall、次 window へ再 arm）になる。**resume 後**は grace が spawn 基準では効かないので、resume 直後に
`dispatch_watch.ts --project <root> --pm-id <pm> --id <N> --mark-resumed` を 1 回回して
`resumed_at` を打ち直す（次の watch がその read phase を stall と読まない）。加えて
heavy_compile_lock の **queue 待ち**（slot/RAM 待ちで build なし）も `waiters/` heartbeat を
active 信号として認識するので working-stalled にならない（#354）。marker 不在の legacy container は
grace ゼロ = 従来どおり発火。

**常設 fleet watch（W-028、停滞が「PM が尋ねるまで」放置される構造を消す）:**

> **カラビナ語彙:** ここで arm する fleet watch / dispatch watch / gate 待ち /
> heartbeat / doctor は、いずれも PM/Dock rack の **observation-class カラビナ**（役でも
> 工具でも検査器でもない — 権威なしで「観測して起こす」task-form）。実装 script は
> カラビナの実装工具にすぎない。分類判定は `garelier-core/references/carabiners.md`
> §「Four categories」参照。

`--stall-scan` を PM が思い出した時だけ手で回すと、(1) subagent は turn 終了後に外部 message まで
再起動されない、(2) `dispatch_watch` は窓が切れると無監視、(3) scan→wake が手動 — の 3 つで停滞が
放置される。対策は **session 開始時に fleet watch を 1 本だけ `run_in_background` で arm** すること:

```bash
bun skills/garelier-core/driver/src/scripts/fleet_watch.ts --project <root> --pm-id <pm_id>
```

**arm 手順の固定（2026-07-07 実測、これを外すと網が沈黙する）: 必ず harness 追跡下の
`run_in_background` で起動する。** fleet watch は actionable を検出すると **exit して**
`run_in_background` の完了通知で PM を起こす設計なので、追跡されていない起動では発火が
誰にも届かない。shell の `&`（background job）で起こすのは **禁止** — `&` は harness 非追跡で
その exit が通知に化けず、監視網がそのまま沈黙する（＝この watch が塞ぐはずの穴に逆戻り）。
再 arm も同じく `run_in_background` の 1 本のみ。fleet_watch.ts は起動時に「起動先が追跡下か」を
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
build-wait を誤検出しない。`dispatch_watch`（heavy role の近接 RUNAWAY 監視）と併走する —
片方の watch が切れても fleet watch が `unwatched` で拾う。

→ pm_playbook §3, §11

---

<a id="pmfm-2"></a>
## 2. register 処理 checklist

**トリガ: role が完了 register（final message = 新 SHA + 結果）を返した。**

**既定は 1 command（W-668）**。2026-09-02 の実測では、この節を手で辿ると 1 land あたり
**12 command** を打ち、そのうち 8 件は拒否 message で初めて知る契約だった。
`land_pipeline.ts` がその順序と契約を持つ:

```bash
# 1 回目 — ack → report 転写 → review_prepare → PM 選定 step → gate task file → gate 席 prepare
bun skills/garelier-core/driver/src/scripts/land_pipeline.ts --project <root> --pm-id <pm_id> --id <N> [--pm-step <steps.toml>] [--facts <facts.md>]

# ここで PM が gate 席 2 つを spawn する（pipeline は spawn command を印字するだけ、実行しない）

# 2 回目 — verdict 検証 → merge_land → cleanup の告知（削除は --cleanup を付けた時だけ）
bun skills/garelier-core/driver/src/scripts/land_pipeline.ts --project <root> --pm-id <pm_id> --id <N> [--pm-step <steps.toml>] --resume
```

- **手で打つのは spawn 2 回だけ。** 他はすべて段として入っている。
- **各段は idempotent。** 直したら**同じ command をもう一度**打つ。済んだ段は `SKIPPED` になる。
- **止まったら最終行が `NEXT_COMMAND: <command>`** — verbatim で実行できる形。
  PM が error message から復旧手順を組み立て直さない。
- **判断は機械化していない**（user 規約「機械化は告知まで」）。pipeline は verdict を書かず、
  lock を解放せず、row を close せず、**authority rebind も実行せず**、**何も削除しない**。
  （`merge_land` 自身の row close は従来どおり。削除は `--cleanup` を明示した時だけ。）
  gate 席の spawn もしない — 両 transport の command は `dispatch_prepare` が publish した
  `provider_parent_routes` を**そのまま中継**して印字し、そこで止まる。

<a id="pmfm-2-0"></a>
### 2-0. lane の状態の読み方 — register を読む前に

**完了判定の正本は `<container>/lane/result.md` 先頭の `STATE:` 行**（codex lane）。
`<container>/STATE.md` は Dock が転記する側なので、producer が REPORTING に達しても
`WORKING` のまま残り得る。**STATE.md だけを見て「まだ走っている」と判定しない。**

| 読む file | 値 | 意味（そのまま実行する手） |
| :-- | :-- | :-- |
| `lane/result.md` 先頭 `STATE:` | `REPORTING` / `BLOCKED` | register を読む段へ進む |
| `lane/session.json` の `status` | `ready` | Codex 停止済み。register を読む |
| 同上 | `resuming` | 走行中。provider process の本数も併読する |
| `instructions.md` の `[[instruction]]` | `checked = true` | 消費済み。canonical `digest = '<message_digest 先頭 12 hex>'` と typed `consumed` evidence が在ることを確認する |
| register 本文 | `ledger N/N consumed` | 未消化 0 の宣言。無ければ REPORTING 不成立 |
| `git -C <checkout> status --short` | `dirty 0` | register のみの round |
| 同上 | `dirty > 0` | proxy commit が必要な round |

<a id="pmfm-2-1"></a>
### 2-1. 段と、止まった時の手

| 段 | 何をするか | 止まる典型と `NEXT_COMMAND` |
| :-- | :-- | :-- |
| `ack` | `register_received` を touch（role への受領 ack、W-018/W-190） | — |
| `report` | `lane/result.md` を `report.md` へ転写。機械 header は front matter の `[control]` へ入れる（F-18） | register が machine artifact でない → 直す |
| `review` | expected studio = **candidate が含む最新の studio commit**を自動導出して `review_prepare.ts`。gate は **report が引用した run を束縛**（§2-1c）、候補が driver を変えるなら**候補側 script へ委譲**（§2-1d） | 実 overlap があれば `git -C <checkout> merge <studio>`（base-track）／その他は `review_prepare.ts …` を再掲 |
| `pm_step` | Dock 席の env 3 本を内部で発行し `gate_runner --steps <toml>` | RED なら候補を直して同じ pipeline command |
| `gate_tasks` | A-0 の canonical 7 節 + PM の `--facts` を task file 2 本に | `--facts` file 不在 |
| `gate_seats` | `dispatch_prepare --role guardian/observer --task-file` ×2 → **spawn command を印字して停止** | 常にここで 1 度止まる。spawn 後 `--resume`。席の prepare が落ちるのは大抵 row 側 — AC が create 時の placeholder 1 行のままだと `dispatch_prepare` が exit 4 で拒否する (W-666)。`control backlog update <id> --set-acceptance …` で AC を入れてから再実行 |
| `verdict` | `contract_check --gate` | marker 不在 / 片面のみ → `contract_check …` を再掲（§10） |
| `rebind` | **実行しない**。drift 時に rebind command を名指しして停止する (PM 裁定 2026-09-03) | `dispatch_prepare --rebind-authority --id <N> --evidence <Guardian marker>` |
| `land` | `merge_land --id <N>` を 1 回 | drift なら rebind command (上段)／他は `merge_land …` を再掲 |
| `cleanup` | **既定は告知のみ** — 削除対象 (lane file / container / branch) を列挙して停止。`--cleanup` を付けた時だけ、未知 artifact を `control/reports/gates/<W>/dispatch<N>/` へ保全してから container / branch を外す (F-21) | 既定 = 同じ command に `--cleanup`／実行後に refuse したら `dispatch_cleanup …` を再掲 |

`--pm-step` の steps file は `[[step]] name = "…"` / `cmd = "…"` 形（§5）。
`--facts` は task file の `## Dispatch-specific facts` にそのまま入る本文。

**`NEXT_COMMAND:` は pipeline 専用の書式ではない**（W-667 land、2026-09-03）。
`dispatch_prepare` 自身も、prompt 源（`--task-file` / `--pipeline-package`）の無い normal
dispatch を **claim / container / worktree を作る前に** exit 4 で拒否し、その message の末尾に
`NEXT_COMMAND: …` を出す。**どの層から出ていても、その行をそのまま打つ**のが正しい手であり、
message を読んで手順を組み立て直さない。

<a id="pmfm-2-1b"></a>
### 2-1b. LP-7 dry-run が埋めた欠落（W-668、fresh 席が答えられなかった 7 点）

改訂後の §2 + `worker_field_manual.md` §5b-1 だけを渡した fresh な opus 席に
register → land を辿らせ、答えられなかった問いを同じ diff で閉じたもの:

- **cwd**: `bun skills/...` の相対 path は **`--project` に渡す project root から**打つ。
  **session cwd が lane checkout の中に残っていても control mutation は自 project へ通る**
  (W-545、2026-09-03)。lane は linked worktree で `.git` を file として持つため、以前は
  path fence が「その lane 1 個」に縮み、自 project の control tree への書込が全て
  out-of-fence で落ちていた。現在は control mutation が (1) W-267 の foreign-root 検査を
  **先に**走らせ、(2) 拒否されなかった **control root だけ**をその操作の fence root として
  宣言する。宣言は `execute()` の入口と出口で捨てられる (W-467)。
  **拒否されてから広げるのではない**ので、`--project` を明示する既定は変わらない。
  宣言されるのは `__garelier/<pm_id>/` であって repository root ではない —
  `__garelier/<pm_id>/` の**外**へ lane cwd から書く経路は本束では広げていない。
  fence 拒否に遭ったら message 末尾の `[fence origin: …; roots: …]` を読む —
  `session cwd (…)` と出ていれば位置の由来が cwd で、`caller-supplied fence roots
  (dispatch record)` なら席の record が fence を決めている。
  path の綴りは **drive-letter 形 (`C:/env/...`)** を既定にする。MSYS の `/c/env/...` 形も
  guard 内では同一 path として扱われるようになった (W-354) が、正規化は win32 host 限定の規則。
- **`--pm-step` は resume 側にも同じ値で渡す**（段の idempotence 判定が step log 名を使う）。
- **`NEXT_COMMAND` が出たらそれを打つ**。出ていない（別の理由で止めた）時だけ同じ pipeline
  command を打ち直す。どちらの場合も済んだ段は `SKIPPED` になる。
- **保全 path の `<W>`** = その dispatch に bound な row id（`context.json` の `control.work_id`）。
- **rebind は pipeline が実行しない** (PM 裁定 2026-09-03)。drift を晴らす evidence は drift より**前**に
  書かれた Guardian marker で、新しい row bytes を保証しない。row の何が変わったかを人が見る。
- **`--rebind-authority --evidence <marker>`** の marker = その dispatch の **Guardian verdict
  marker file の path**（`runtime/guardian/results/<slug>-guardian.md`）。
- **cleanup は既定で何も消さない**。1 回目の停止は「消す対象はこれです」の告知なので、内容を見てから
  同じ command に `--cleanup` を付けて打ち直す。`--cleanup` 付きで走った後に refuse したら、
  未知 artifact の保全は済んでいるので印字された `dispatch_cleanup …` を打ち直すだけでよい。
- **rework round に入る前に、前 round の gate 痕跡を片付ける**。gate container は自動回収されない
  ので、前 round の verdict marker は同じ path に残り、席 container も残る。pipeline は段 6 で
  **marker と席の review_sha を candidate と突き合わせ**、一致しないものを stale として
  `dispatch_cleanup … --sweep` を `NEXT_COMMAND` に出して止まる (**自動削除はしない** — 差し戻しの
  記録を機械が消さないため)。片付けてから次 round の pipeline を回す。
- **verdict が `BLOCK` / `REWORK_RECOMMENDED` の時は land しない**。`--resume` を打たず、
  rework round を dispatch する（§3.1 / `gate_field_manual.md` §C1）。pipeline は verdict の
  中身で分岐しない（判断は機械化しない）ので、**この分岐は PM が持つ**。

<a id="pmfm-2-1c"></a>
### 2-1c. seal は Dock review record が既に束縛している gate run を再利用する（W-693 / W-711）

**順序の正本**: `review_prepare` は **自分の seal が既に名指している run を束縛する**。
「seal してから report を書く」でも「report が引用した run を探す」でもない。

`review_prepare` は以前 seal のたびに gate を再実行していた。producer が run X を引用した
report を出す → Dock が seal を作ると run Y が走る → Observer が「report は X、seal は Y」で
BLOCK → producer が Y を引用し直す → seal が run Z を作る、で **同じ形の BLOCK が無限に続く**。
garelier #394 は r43 / r44 をこれだけで消費した（code は Guardian PASS ×3、実装も確認済）。
W-693 はこれを再利用へ変えたが、**再利用の条件に register の `[gate] gate_run_id` を混ぜた**ため
「引用が無い / 違う」で refuse する新しい round 消費を作った。**W-711 でその要求は撤回**した。

| 状況 | `review_prepare` の挙動 | PM の手 |
| :-- | :-- | :-- |
| Dock review record がこの review SHA の GREEN run を、log の現 bytes の digest 付きで束縛している | **再実行しない**。seal はその run を束縛 | そのまま land へ |
| それ以外（log に terminal GREEN が無い / record が無い / record と log が食い違う / register の宣言 step が変わった） | gate を**実行**して新しい run を束縛 | そのまま。理由は `final_accounting.md` の `- Gate run source:` に出る |
| 新しい run が要る（候補を直した等） | `--rerun-gate` を付けた時だけ実行 | 候補 SHA が変われば log path 自体が変わるので通常は不要 |

- **判定は 2 値**（実行 / 再利用）で、**refuse は無い**。producer に値を書かせて待つ状態が
  無くなったので、この段で round が増えることはない。分岐の**全数 1 表**は
  `gate_field_manual.md` §A-8b が持つ（本表はその要約）。
- **register は run を書かない**。`templates/report.md` に `gate_run_id` field は無く、散文の
  run id は読まれない。
- seal (`runtime/dock/review_handoff/dispatch<N>.json`) の `gate_run_id` と
  `lane/final_accounting.md` の `Gate run source:` を見れば、束縛した run と、
  それが再利用か新規実行かが分かる。

<a id="pmfm-2-1d"></a>
### 2-1d. 候補が driver 自身を変える dispatch（W-691）

**判定条件**: 候補の diff（`git -C <checkout> diff --name-only <base>..<review>`）に
`skills/garelier-core/driver/src/` の path が **1 件でも**含まれる。

その候補は gate の契約（log marker / seal の artifact 数 / step 分類）を**自分で実装している**
ので、studio に install 済の script で回すと契約が成立しない。#394 では候補が
`GATE_START … head=<40hex>` / `GATE_HEAD_END …` marker を要求していたのに Dock が studio 側の
`review_prepare.ts` を回しており、Observer が「候補の契約で consume 可能な formal GREEN が無い」
と BLOCK、lane は r34〜r40 にわたり `PRE_LAND_UNATTAINABLE` を報告し続けた。

- **既定は自動**: studio 側 `review_prepare.ts` がこの条件を検出すると、**候補 checkout の
  `review_prepare.ts` へ委譲**する（`GARELIER_REVIEW_PREPARE_GATE_SCRIPT_SOURCE=candidate` を
  渡すので、委譲先は再委譲しない）。
- **候補側の script が無い**（driver の別 file だけ変えた／旧 branch）場合は警告を出して
  studio 側で回し、`final_accounting.md` にその旨を書く。
- **手で回す形**（pipeline を使わない時）:

  ```bash
  bun <checkout>/skills/garelier-core/driver/src/scripts/review_prepare.ts \
      --project <root> --pm-id <pm_id> --dispatch-id <N> --expected-studio-sha <sha>
  ```

  候補 checkout の script を直接起動した時も `gate_script_source: candidate` になる。
- **読む場所**: `lane/final_accounting.md` の `- Gate script source:` 行。
  `studio` / `candidate` / `studio (candidate driver changed but … is absent)` の 3 値。
  seal はこの file の digest を持つので、後から書き換えても検出される。

<a id="pmfm-2-2"></a>
### 2-2. pipeline を使わず手で辿る時

pipeline が使えない状況（別 project / 段の途中だけやり直す）では上表の command を順に打つ。
その際に踏む register 契約は **`worker_field_manual.md` §5b-1 が正本**（件数もそこが持つ）。
特に PM 側で効くのは:

- `report.md` の 1 行目は `+++`（機械 header を先頭に置かない）— でないと `review_prepare` が exit 1。
- `review_prepare` の `--expected-studio-sha` は **candidate が含む** studio 権威。studio tip を
  そのまま渡すと並列 land のたびに base-track 往復が増える。
- verdict marker は front matter と `## Verdict` 節の**両方**（§10）。
- `instructions.md` は front matter の内側（§6.1、`dispatch_prompt_craft.md` §3b）。

<a id="pmfm-2-3"></a>
### 2-3. land 後に続けるもの（pipeline の外、PM の手）

1. **anchor bundle を apply** — cleanup 完了 JSON の `task_mirror_hint` をそのまま実行して Task list を derive し直す（§11、hand-craft しない）。
2. **`TASK-MIRROR diff:` を反映**（W-030）— setup wizard が配線する framework 所有の PostToolUse hook（`skills/garelier-core/hooks/task_mirror_hook.sh`）が、land/dispatch コマンドの後に **差分だけ**を注入する（差分ゼロ＝無出力＝トークン0）。`TASK-MIRROR diff:` 行が出たら、その `追加`/`削除`/`変化` を `TaskCreate`/`TaskUpdate` にそのまま反映する（`#<id>` 紐付きは dispatch owner を設定）。行が出なければ Task list は既に一致——何もしない。

→ pm_playbook §11

**再指示は pointer 形（W-190）**: 再利用中の subagent（`--reuse` 直列席・named
teammate）は inbox / context を保持し配達保証があるので、行き違い時の再指示は
**msg-id 参照 + 1 行差分**のみを送る。row 全文・裁定全文・checkpoint prose の
再掲は禁止（実例 = PM 再送が純重複になった事象）。全文が必要な状況＝
subagent が fresh spawn のときだけで、その判断は §6 の dispatch prompt checklist が持つ。

---

<a id="pmfm-3"></a>
## 3. gate 依頼の正準形

**report path の正本（W-020、これ以外に書かせない）:**

```
__garelier/<pm_id>/runtime/guardian/results/<branch-slug>-guardian.md
__garelier/<pm_id>/runtime/observer/results/<branch-slug>-observer.md
```

- **`<branch-slug>` は branch 由来の slug を使う。** 短縮名・別名で書かせると auto-read
  （`merge_land` / `contract_check --gate`）が拾えない（gate 結果 path の正本が二重帳簿になっていた実例）。
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

- **何席立てるかは `gate_plan` が決める**（tier 機械化、W-192）— `dispatch_prepare` が
  dispatch の touches/tags から risk tier を分類し `gate_plan.seats` を emit する:
  docs-only → 席なし（PM diff review のみ）/ test-only → Observer 1 席 / code → Guardian+Observer /
  security → Guardian+Observer（gate model opus floor）。**`gate_plan.seats` の席をそのまま
  立てる**（席数を手で推測しない）。判定表と escalate 条件（fixture 実データ等）は
  `gate_field_manual.md` §C0。
- **marker は gate 役自身が書く**（DEC-090）。PM は authored / republish しない。
- **prompt は手書きしない** — Guardian / Observer / refuter の完全な prompt template と
  naming（`ga-guardian-<slug>` / `ga-observer-<slug>`）、model 解決、post-dispatch verify は
  `attended-gate-dispatch.md` § Prompt templates を verbatim。`dispatch_prepare.ts` を
  通した role なら `gate_agents.guardian` / `gate_agents.observer`（`name` + `report`）が
  context.json に確定済みなので、その値を使う（手で組まない）。
- 高 stakes merge（`require_for_large_diff` / `require_for_protected_paths` / semantic な
  migration・public_api・auth_security）だけ refuter を +1（`attended-gate-dispatch.md`
  § High-stakes refuter）。日常 merge には焚かない。

→ attended-gate-dispatch.md § Report contract / § Prompt templates、pm_playbook §2, §12

---


<a id="pmfm-3-1"></a>
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

<a id="pmfm-3-2"></a>
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

<a id="pmfm-3-3"></a>
### 3.3 proxy commit と review SHA

通常の Codex proxy unit は手順を分解せず、dispatch が出した次の 1 command を使う。

```bash
bun skills/garelier-core/driver/src/scripts/dock_proxy.ts \
  --project <project> --pm-id <pm_id> --dispatch-id <N>
```

この command は canonical session が選ぶ exact result の COMMIT PLAN と dirty 集合を
完全一致で検証し、`git commit -F`、その exact result と `report.md` の review SHA bind を
順に行う。成功はその proxy unit の terminal (`status: "committed"`) であり、bookkeeping
acknowledgement の `followup.md` 作成や provider resume は行わない。不一致では commit しない。
`[autonomy].auto_proxy_commit = true` の project だけは
`fleet_watch` が ready + dirty + COMMIT PLAN を検出して同じ入口を起動する。

1. `lane/session.json.result_file` が `ready.json` の initial / resumed result のどちらかと
   canonical path で一致することを検証し、その artifact の `=== COMMIT PLAN ===` から
   files / message を取り、checkout の中でだけ stage / commit する。message は plan の
   verbatim で、`Garelier:` と `Garelier-Seat:` trailer を含む。commit 後は repo root へ
   戻ってから次の操作を行う。checkout に居たまま外側へ書くと `profile_path_fence` が拒否する。
   **例外は `control` の mutation だけ**（W-545、2026-09-03）: control は W-267 検査を先に通した
   上で、解決した control root をその操作の fence root として宣言するので、session cwd が
   checkout の中にあっても自 project の **control tree へは**書ける（`__garelier/<pm_id>/` の
   外は対象外）。それ以外の書込（commit / 任意の file 編集）は従来どおり拒否される。拒否
   message 末尾の `[fence origin: …; roots: …]` が、その fence が席の record 由来か session cwd
   由来かを名指す。詳しくは [§2-1b](#pmfm-2-1b)。
2. `bind_review_sha.ts` に full HEAD と dispatch base を渡す。既存 full review を変える時は
   `--replace` も渡す。binder は両 artifact の `[gate]` に `review_sha` / `declared_base_sha` /
   `gate_log`（`--gate-log` を渡した時）を書く。**この 3 つは driver 専有 field**（W-709 /
   W-720、DEC-100 P1）: producer が同名 field を書いていても refuse せず上書きし、
   上書きした field 名を `driver_overwrote=<field…>` として artifact ごとに 1 行で告知する。
   `review_sha` と `gate_log`（と `candidate_stat`）は**同じ commit についての 1 組**なので
   毎 bind 一緒に書き直され、別 review の log を渡すと binder が refuse する（W-720）。
   round を跨いだ register の `gate_log` が 1 round 古いまま seal される形は消えた（#463 r2）。
   rework/proxy commit で HEAD が変わった時は、binder が旧 current 値を型付きの
   `previous_review_sha` へ移して current `review_sha` を一意に再束縛する。
3. 両 artifact の `[gate]` が期待値になったことは binder の census 出力
   (`review_sha=bound declared_base_sha=bound … driver_overwrote=…`) で確認する。
   **散文中の SHA は自由** (W-708 / DEC-100 裁定 2) — binder は typed field だけを見る。
   別 commit を主張する register を止める経路は **proxy admission
   (`dispatch_prepare_lane_commit_plan.ts::inspectDeclaredReviewShas`) の 1 本**で、
   そこは coordinator が commit を作る経路だから declared final SHA ≠ 解決 HEAD を refuse する。
   claude 経路 (producer 自身が commit する) では HEAD が唯一の正で、宣言は上書き + 告知になる。
   旧形の「本文の完全 40hex を除外 list で許す」方式は廃止した
   (W-618 / F-27 / #394 r6 の再発 class)。

<a id="pmfm-3-4"></a>
### 3.4 mandatory scanner

review SHA が確定してから、reviewed checkout で scanner を実走する。

- `guardian_scan.ts --project <root> --base <merge-base> --head <sha> --pm-id <pm> --security-root <checkout>/__garelier/<pm>/knowledge/security --scope diff --out <container>/lane/secret-scan.md`。
  `lines_scanned` が candidate の挿入範囲を覆うことを確認する。base が非祖先なら
  under-cover なので修正する。
- gitleaks は `context.json` の `guard.mandatory_scanner.commands` にある canonical
  argv を完全一致で使い、reviewed checkout を cwd にする。canonical command は
  `gitleaks dir . --no-banner --redact --report-format json --report-path -`。evidence は
  argv、cwd、base、head、run_at、実 exit、stdout SHA-256、stderr を束縛する。
  `--exit-code 0` の追加や report path の置換はしない。
- framework repository は `identity_scrub_lint.ts` も reviewed checkout で実行する。
  `skills/` の fixture / manual に target 固有の project、crate、test、人名を置かない。
- **canonical scanner artifact の writer は `scanner_evidence.ts` 1 本**である。生の
  `gitleaks` 出力をそのまま canonical path へ置くと `attended_seat.ts` が形の誤りとして
  拒否する。拒否 message は writer path と再生成 command を印字するので、その行を実行する。

<a id="pmfm-3-5"></a>
### 3.5 Dock gate と review seat

proxy commit 後の scanner / Dock gate 準備は次の 1 command を使う。review SHA bind、
`guardian_scan`、canonical scanner evidence、framework repository の identity scrub、Dock
attended record、`gate_runner --from-register` を fail-fast の順で合成する。

```bash
bun skills/garelier-core/driver/src/scripts/review_prepare.ts \
  --project <project> --pm-id <pm_id> --dispatch-id <N> \
  --expected-studio-sha <Dock が固定した studio の full SHA>
```

`secret-scan.md` は毎回置換され、`scope.base_ref` が dispatch の full base SHA、かつ
`scope.head_ref` が現在の full HEAD と一致しない限り gate を起動しない。
`expected-studio-sha` と review HEAD の merge-base がその full SHA と一致せず、candidate が
固定済み studio authority を含まない場合も scanner 前に停止する。required script が不在なら
stale evidence を使わず、その段で停止する。旧 `base_sha.txt`、非 SHA 名の `gitleaks.json` /
`gitleaks.stderr`、旧 SHA 名の `gitleaks-<sha>.*` は新しい scan 前に retire する。

`dispatch_prepare.ts` は worktree / container、role binding、routing、prompt、result、
provider launch command の正本。手組みしない。attended seat は次の入口を使う。

```bash
# Dock seat (gate 実行用、reviewed checkout ごと)
bun skills/garelier-core/driver/src/scripts/dispatch_prepare.ts --attended-seat --role dock   --slug <branch-slug> --worktree <checkout> --project <project> --pm-id <pm_id>
# Guardian / Observer seat (task file の canonical 見出しは本節。追加見出しは自由、W-708)
bun skills/garelier-core/driver/src/scripts/dispatch_prepare.ts --project <project> --pm-id <pm_id>   --role guardian --model opus --effort xhigh   --work-id <W-N> --control-session <cs_…> --blueprint <blueprint.md> --slug <slug>-guardian --task-file <seat-task.md>
bun skills/garelier-core/driver/src/scripts/dispatch_prepare.ts --project <project> --pm-id <pm_id>   --role observer --provider claude-code --model opus --effort xhigh   --work-id <W-N> --control-session <cs_…> --blueprint <blueprint.md> --slug <slug>-observer --task-file <seat-task.md>
```

**`--provider` は省略形が既定**（W-690、user 裁定 2026-09-05）: 省略すると `claude-code`。
codex 席を出す時だけ `--provider codex --model gpt-5.6-sol` を明示する。
**model / effort は既定化されない** — claude 席も明示が要る（省略すると
`recorded Claude CLI dispatch requires explicit model, non-empty effort` で exit 4）。

(旧記述 `garelier dispatch-prepare --attended-seat --role <role> --dispatch-id <N>` は attended seat の実 argv と一致しないため 2026-08-30 に置換。§15 も参照。)

- Dock seat は reviewed checkout ごとに作る。別 container の record で gate を走らせると
  Dock attribution が不一致になる。
- `pm next` が出す Dock seat command の後、同じ record に束縛された
  `gate_runner.ts --from-register <result.md>` を実行する。log の `RESULT GREEN` と対応する
  `GATE_END` が揃って初めて review seat へ進む。RED や `RESULT` の無い短い log は進行根拠にしない。
- gate runner の実体は generated Dock record を環境へ束縛した次の形。seat 名、record、
  checkout、result、log は `pm next` の出力をそのまま使う。

  ```bash
  GARELIER_ROLE=dock GARELIER_AGENT_NAME=<seat> GARELIER_DISPATCH_RECORD=<dispatch-record> \
    bun skills/garelier-core/driver/src/scripts/gate_runner.ts \
    --project <project> --pm-id <pm_id> --cwd <checkout> \
    --from-register <container>/lane/result.md --log <gate-log>
  ```

- gate task が機構から受け取る canonical 見出しは `## Seat`、`## Dispatch`、
  `## Blueprint`、`## Output`、`## Review SHA`、`## Verdict`、`## Dock gate`。
  dispatch 固有事実は `## Dispatch` に含める。**機構専有の `## Role source pointers` /
  `## Task` を入力に書くと拒否**され、それ以外の見出しの追加は自由 (W-708)。
  `## Review SHA` / `## Dock gate` を書く時は field 形の検査が効く。
- Guardian / Observer は同じ dispatch の attended seat とし、生成された identity、
  model、prompt、fence、verdict template、`runtime/<role>/results/` の出力先をそのまま
  使う。PM が verdict を代筆しない。
- Codex seat の effort は `high|xhigh`。blueprint の `Effort-hint: max` は dispatcher が
  `xhigh` に正規化した実行可能な next command を出す。

<a id="pmfm-4"></a>
## 4. merge_land 使用手順

**通常経路は §2 の `land_pipeline.ts`**（`land` 段が下の command を打つ）。本節は
pipeline が止まった時と、pipeline を使わず手で land する時の正本。

**既定（1 本で submit→wait→成功時のみ cleanup+pull を集約、W-088）:**

```bash
bun skills/garelier-core/driver/src/scripts/merge_land.ts --project <root> --pm-id <pm_id> --id <N>
```

- `--id <N>`（= `--dispatch-id`、`dispatch_prepare`/`dispatch_cleanup` と同じ id）だけで解決する:
  - **branch** = `__garelier/<pm_id>/_crew/dispatch<N>/checkout` の HEAD branch（明示 `--branch` は常に優先）。
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
  復旧は role の tip SHA から `git branch -f <name> <sha>`（§5）。
- transactional landing で閉じる bound Backlog を再確認するなら `--close-row <item-id>`（複数可）。

→ pm_playbook §1

<a id="pmfm-4-1"></a>
### 4.1 land 後に閉じる全数 — 後から sweep する形にしない

**land は「studio に merge した」で終わりではない。**
下の全部が閉じて初めて完了とする。**後から数え直す形にすると、そのたびに
「どれを消してよいか」を再判断することになり、判断そのものが無駄になる。**

| # | 閉じるもの | 機構 | 状態 |
| ---: | :--- | :--- | :--- |
| 1 | studio へ merge | `merge_land` submit + gate | 実装済 |
| 2 | container の cleanup + pull | `merge_land` success path | 実装済 (**失敗が沈む**) |
| 3 | bound row の close | `merge_land` row close | 実装済 |
| 4 | **依存 row の解放** (`depends_on` / `blocked_by` で待っていた row) | — | **未実装** |
| 5 | **内包 (co-close) row の同時 close** | — | **未実装** |
| 6 | **milestone / roadmap の更新** | — | **未実装** |
| 7 | **superseded round container の退役** | — | **未実装** |
| 8 | **走行中の他 lane へ base-track させる** | — | **未実装** |

**8 は束を並列に走らせる時に必須。** land した内容を他 lane が取り込まないと、
各 lane が自分の merge で同じ conflict を独立に解くことになり、後の lane ほど発散する。

**PM が走行中の checkout へ直接 merge しない** — role が編集中の tree を壊す。
**正規経路は `instructions.md`** — role が安全な点で自分で merge する。

```toml
[[instruction]]
id = 'I<n>'
message = '''base-track: studio <SHA> が land した。安全な点で studio を merge してから続行する。
conflict は自分の変更を優先せず、land 済の形に合わせる。'''
checked = false
```

**instructions.md は role の prompt preamble が「REPORTING 前に全 entry を
消し込む」契約として持つ**ので、走行中に append できる (§6.1)。

**2 の失敗は沈む。** cleanup が refuse すると `cleanup_status: failed(...)` に記録されるが
land 自体は success を返し、**後で拾う経路が無い**。

**cleanup が refuse する主因**: checkout に未 commit path があること。
**codex lane は構造的に必ず未 commit を残す** — sandbox が gitdir 書込を拒否するので
role は commit できず、PM の proxy commit に載らなかった差分が checkout に残る。
その残骸は多くの場合**後続 round が置き換えた中間成果**で失って困らないが、
cleanup は「未 commit」と「失われて困る」を区別できない。

**実測 (2026-08-23、2 project 合計)**: container **172** / checkout **84** /
git worktree **86**。checkout の内訳は
land 済で片付いていない **37** / row が閉じている **25** / 後続 round がある **12** /
現行 **10**。`du -sh` が 5 分で返らない規模まで溜まっていた。

#### 当面の手 (機構が入るまで)

**2 件は機構が入った (2026-09-03)**: 削除失敗は `dispatch_cleanup` が OS error を診断して
4 回まで再試行してから deferred にする (W-667 / F-16)。未知 artifact は
§2 の `land_pipeline.ts` の `cleanup` 段が `control/reports/gates/<W>/dispatch<N>/` へ
保全してから消す (W-668 / F-21)。下は**残りの手**である。

**land した turn の中で**次を実行する。**別の turn へ回さない。**

1. `merge_land` の JSON で **`cleanup_status` が `success` か**を必ず読む。
   `failed(...)` なら **その場で** `dispatch_cleanup` を単独で走らせ、
   refuse 理由を潰す (未 commit なら `git -C <checkout> stash push -u` で退避してから再実行 —
   stash は復元できるので破棄ではない)
2. **同じ row の旧 round container を退役する** — row ごとに最新 dispatch id だけ残す
3. **内包 row と依存 row を手で close / 解放する** (co-close 表は anchor row が持つ)
4. milestone / roadmap に触る row なら、その更新を同じ turn で入れる

機構化は control backlog で追跡中。


---

<a id="pmfm-4-2"></a>
### 4.2 land composition が行うこと — verdict が control へ入る唯一の口

`merge_land.ts` は既存の merge request、await、Control settlement、aftercare を再利用し、
次を順に行う。

1. dispatch context の Work / session / touches を読む。
2. claim が無ければ同じ session で取得し、foreign claim は実際に stale の時だけ steal
   する。authority が変わっていれば claim 後に rebind する。
3. Guardian / Observer verdict file を読み canonical token を導出する。明示 token は
   override だが、通常操作では `--guardian` / `--observer` を渡さない。
4. merge request を submit し、同じ process で await する。N-B として既定 await ceiling
   は従来のおよそ 2 時間から **30 分**へ変更された。`--max-wait` を与えればその値を
   `dock_merge.ts await` の ceiling と caller timeout に反映する。
5. gate 中に同一 dispatch の claim が失効しても、landed commit / request id に束縛した
   audited renewal で gate record と row transition を完了する。
6. successful-land cleanup を行う。gate 非成功時は cleanup しない。merge 成功後に
   cleanup が拒否した場合は `status=cleanup_failed` と exact `NEXT_COMMAND` を返す。

N-C の順序上の開示: 同一 session・同一 touches の claim がまだ live なら renewal は
read-only no-op で早期 return する。後から生じた overlapping claim を遡及的に既存 claim
の失効理由にはしない。stale / touches 変更時だけ競合再検査と監査付き更新を行う。

**述語 — verdict が Control へ封止される経路は 1 本しかない。**
`gate` / `merge` の結果を Control row の evidence として書き込む関数は
`skills/garelier-core/driver/src/control/garelier_integration.ts::recordMergeControlOutcome`
1 本。**production の call site は 6 個、file は 4 本**（test を除く。数え方は下の判定形）:

| file | call site | いつ呼ばれるか |
| :-- | --: | :-- |
| `scripts/merge-gate.ts` | 1 | gate が merge を成立させた時 |
| `control/landing_finalize.ts` | 1 | landing の settlement |
| `dispatch/land_aftercare.ts` | 1 | land 後の aftercare（`--request-id` 経路） |
| `scripts/dispatch_cleanup.ts` | 3 | cleanup 時の記録 / 回復 / 更新 |

4 本とも `merge_land` が submit した **request id と landed commit に束縛された settlement**
からしか呼ばれない。したがって:

- `git merge` を手で打って studio を進めても、**verdict は control に入らない**。
  row は evidence 無しのまま残り、後続の archive 検査が落ちる。
- 判定形: 下 2 つを**分けて**数える。file 数だけを数えると、1 file に複数 call site が
  ある `dispatch_cleanup.ts` を 1 と数えて分母を過小に報告する。

  ```bash
  # call site（定義行と typeof を除く）— 期待値 6
  git grep -n "recordMergeControlOutcome(" -- skills/garelier-core/driver/src \
    | grep -v "\.test\.ts" | grep -v "typeof" | grep -v "^.*:export function"
  # 上の出力の file 数 — 期待値 4
  ```

  この集合に `merge_land` 経路の外が現れたら、封止が破れている。
- 復旧は `land_aftercare.ts apply --request-id <id>`（§4.4）であり、row を手で書くことではない。

「規約だから `merge_land` を使う」のではなく、**`merge_land` を通らない限り
書き込み関数に到達する caller が存在しない**。

<a id="pmfm-4-3"></a>
### 4.3 refusal recovery

| Refusal class | 実行する機械的 recovery |
| --- | --- |
| verdict path / token の取り違え | `--guardian` / `--observer` を外し、verdict file を読む printed land command を実行する。 |
| caller session と context の矛盾 | `--dispatch-id` を中心とする printed land command を実行する。context session が正本。 |
| live foreign claim | steal せず、printed `garelier control get` で owner を確認して調整する。 |
| `--steal` だが stale claim が無い | `--steal` を外した printed claim command を実行する。 |
| authority rebind に live claim が無い | printed land command を実行する。land が claim → rebind の順を所有する。 |
| await ceiling 到達 | 同じ request id の printed `skills/garelier-core/driver/src/dispatch/dock_merge.ts await` を実行する。再 submit しない。 |
| ledger token / digest 不足 | `ready.json.resume_cmd` で resume し、機械配達された token / digest を消費する。 |
| review SHA / evidence shorthand / revision の形が不正 | printed canonical read / bind command で full SHA、`gate:<request-id>:<landed-commit>:<path>`、秒単位 revision を使う。 |
| Codex effort `max` | printed command の `xhigh` 正規化をそのまま使う。 |
| touches overlap | `touch_conflicts[].overlapping_globs` を読む。値は実行可能な claim glob で、説明文を touches に混ぜない。 |
| merge-bound row state が不正 | refusal が要求する `active/verification` へ canonical Control transition してから再評価する。 |

`NEXT_COMMAND` は bypass ではない。live foreign claim、non-passing verdict、stale review、
mismatched SHA、unproven merge は引き続き fail-closed。

<a id="pmfm-4-4"></a>
### 4.4 post-land recovery

immutable merge request / result を正本にする。まず dry-run の read-only plan を読み、
その digest を独立 precondition として apply に返す。

```bash
bun skills/garelier-core/driver/src/dispatch/land_aftercare.ts dry-run \
  --project <project> --target-root <target-root> --pm-id <pm_id> \
  --request-id <request-id> [--dispatch-id <N>]
bun skills/garelier-core/driver/src/dispatch/land_aftercare.ts apply \
  --project <project> --target-root <target-root> --pm-id <pm_id> \
  --request-id <request-id> [--dispatch-id <N>] \
  --expect-plan-digest <plan_digest-from-dry-run>
```

`apply` は digest 不在を拒否し、自分で期待値を導出しない。checkout / branch が残って
いれば journaled aftercare が回収する。legacy cleanup で両方消えている場合は exact
request / result hash、workbench tip ancestry、landed commit、surviving archived role report、
gate report を検証し、Control finalization だけを行う。filesystem target を再生成・削除
しない。

`dispatch_cleanup --force-remove` は removal だけを許可する。bound Control session が
closed なら `control-update-failed-force-remove` を記録し、独立に選択済みの checkout /
branch だけを外す。その後 request id の aftercare で canonical Control evidence を再生成する。

**`--force-remove` は land の常用経路ではない (W-741)。** 残る用途は 3 つだけ:
(1) checkout が dirty で、その変更を意図的に捨てる、
(2) branch が merge 済と確認できないまま削除する、
(3) bound Control session が closed で removal だけを通す。
**「unknown nested artifact で refuse したから付ける」は用途に入らない。** land pipeline の
`pm_step` が書く `lane/gate-step4-<sha12>.log` は `dispatch_cleanup --request-id` 自身が
`control/reports/gates/<W>/dispatch<N>/` へ保全してから外すので、force 無しで通る
(#605 = 毎回 force で通していた実害)。**規約外の名前の log は保全されず refuse に戻る** —
その refuse は正しい検知なので、force で押し通さず中身を見る。

**`--dry-run` は保全予定を先に名指す (#474)。** preview は 1 byte も動かさないので、lane に
まだ在る log を「無い」ことにはできない — 代わりに保全予定を
`would preserve pm-step gate log -> <保全先>` として印字し、
**「--dry-run を外して同じ command を実行せよ。--force-remove は付けるな」**と言って exit 3 する。
そこで見るべきは force ではなく、印字された保全先。
**保全対象外の unknown artifact が居る場合はこの印字が出ず、通常の refuse になる** ので、
印字の有無がそのまま「force で押し通す話ではない」の判定になる。
**preview は apply より緩い規則で走らせない** — dirty checkout / ownership 欠落は
log が lane に在っても dry-run で refuse する (#474 r3 の regression = force-remove で
preview を取り直し、dirty checkout が success に見えた)。preview と apply が食い違ったら、
どちら向きでも defect。

<a id="pmfm-5"></a>
## 5. lock 規律 — heavy_compile_lock（RAM 直列）

merge-gate の `active.lock`（studio commit 排他、§9）とは**別の lock**。こちらは heavy build
（full-workspace compile ≈ 16GB）の**同時本数を絞る** lock。slot dir は
`__garelier/<pm_id>/runtime/locks/heavy_compile/`。

**heavy gate は必ず `gate_runner.ts` 経由（手書き script 禁止、W-157）:** lock acquire →
trap でなく finally で**確実 release** → step 直列 → marker（`GATE_START` / `LOCK_ACQUIRED` /
`RESULT GREEN|RED` / `ABORT_FAILOPEN`）→ full log → current `RUN_ID` 範囲だけの
project-declared summary 抽出、を 1 tool が持つ。Dock 席は **project command の step list**だけ渡す。
帰属は runner の自己申告ではなく、先に `dispatch_prepare.ts --attended-seat --role dock` が外部発行した
attended record を読む。runner は permission record を新規発行せず、下記 3 environment binding の
欠落・不一致・非正規 provenance を command 実行前に fail-closed で拒否する。
手書き gate script は #353/#354 で lock stuck / parse error を毎回再発明したため退役。

```bash
# 先に Dock 席を外部発行し、JSON の name / record_path を次へ束縛する:
bun skills/garelier-core/driver/src/scripts/dispatch_prepare.ts --attended-seat \
  --project <root> --pm-id <pm_id> --role dock --slug <slug> --worktree <checkout>
export GARELIER_ROLE=dock GARELIER_AGENT_NAME=<name> GARELIER_DISPATCH_RECORD=<record_path>
# steps.toml: [[step]] name="component" cmd="scripts/quality/check component" …
bun skills/garelier-core/driver/src/scripts/gate_runner.ts \
  --project <root> --pm-id <pm_id> --label <slug> --cwd <checkout> --steps steps.toml
# producer register の required gate 代行（#361 / W-641 — codex / claude 両 provider）:
#   codex は sandbox が lock を取れないため、claude は Dock 席の run が handoff record に束縛される
#   ため、どちらの席も自分では走らせない。register の block 形は worker_field_manual.md §5b が正本。
bun skills/garelier-core/driver/src/scripts/gate_runner.ts \
  --project <root> --pm-id <pm_id> --label <slug> --cwd <checkout> --from-register <register.md>
#   register の `=== REQUIRED GATE (Dock-run) ===` … `=== END REQUIRED GATE ===` block を steps 化。
#   worker 由来 command は [quality_gate.register.steps] の prefix で分類し、touched-path coverage と
#   test-tree inventory を照合、project closure を終端に必ず付与する。その後 command_guard を通った
#   step だけ実行する。policy 未宣言 / uncovered path / undeclared tree / prefix 外 / guard deny は RESULT RED。
```

同一 register 内の focused/subset と workspace/superset の重複は project-owned policy でのみ
正規化する。`[[quality_gate.register.supersessions]]` の `step` と `superseded_by` は既知の別 step
名を参照し、両方が present の時だけ前者を実行 plan から除外して
`STEP-SKIPPED <step> superseded_by=<superseded_by>` を log に残す。これは同じ gate run の
production register supersession であり、過去 GREEN の skip/carry/reuse ではない。

`[quality_gate.register] summary_metrics` は省略可。使うなら
`["test_count", "finished_seconds", "duplicate_test_names"]` の閉じた 3 要素を全て宣言し、
runner が terminal `GATE_SUMMARY_METRICS` JSON (`schema_version = 1`) に実測を記録する。
同名 test の二重実行は 0 を期待し、wall-clock は before/after の報告値に留めて合否条件にしない。

長い Smith batch は `--steps <json> --batch-kind smith` を使う。runner は heavy lock を step ごとに
解放して gate waiter を優先し、step ledger / exact identity / test census を観測用に記録する。ただし現行 host は
candidate process tree に対する immutable execution boundary を持たないため、candidate code/build/test/source/config
を読む step の GREEN は再利用しない。`--resume-from-ledger` request を受けても `skipped_green=0` のまま全 step を
実走し、`STEP_REUSE_DISABLED reason=no_immutable_execution_boundary` を残す。candidate CLI/register/diff/environment
から skip/carry を有効化する経路はない。focused test の結果も full CI へ carry せず、full CI は post-land Smith
batch が canonical inventory を一度だけ実行する。

aggregate test へ scenario を足す変更は、同じ変更で同等以上の scenario を統合・削除し、同 file の
`scenario_count` を純増させない。実測 `wall_clock_s` は before/after の報告値であって単独の合否条件ではない。
GREEN になるだけで対象 mutation を RED にできない
scenario は削除対象であり、「既存 aggregate に足す」は round 指示にしない。

runner は own Bun pid（native Windows PID）を owner-pid に使うので git-bash の `$$` が sub-shell pid を返す盲点は
発生しない。`RESULT ABORT_FAILOPEN` は lock infra 故障（`OPEN`）で lockless 実行を拒否した印。

**検査境界**: command_guard は step の **shell 文字列合成だけ**を検査する — `build.rs` / test 本体 /
`scripts/quality/` の中身は非検査（コンパイル済 Rust が env を読んで直接 egress する経路は文字列に
現れない）。その面の防御は minimal env（allowlist + `_TOKEN|_SECRET|_PASSWORD|_KEY|_CREDENTIAL` の
blanket drop）+ checkout fence + local-secrets 前提の 3 点で、guard には依存しない。

**低レベル手動 acquire/release（runner を使わない稀なケースのみ）:**

```bash
# build の直前に acquire
TOKEN=$(bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode acquire --label <slug> --owner-pid "$(cat /proc/$$/winpid 2>/dev/null || echo $$)")
#   … この間に heavy build を走らせる …（TOKEN が "OPEN" なら ABORT。lockless 禁止）
# build の直後に release（即座に。lock を握ったまま眠らない・他作業しない）
bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode release --token "$TOKEN"
```

`--owner-pid "$$"` は build 中も生存する呼出し shell を lease owner にする。省略時は
`unknown` と記録され、`stale_minutes` 猶予 + cargo/rustc 実在確認後だけ回収される。
待機中は `reason=slot-busy` / `reason=ram-budget` を出し、解放まで queue-wait を続ける。
`OPEN` は lock infra 故障だけを表すため、その場合は ABORT する。

- **docs / 調査 / 監査（build 無し）は lock 不要で並列可。** RAM を食わない。
- **RAM 直列 = PM の GO 合図.** 複数の heavy build を並べたい時、PM が「今から N を走らせる」と
  **1 本ずつ GO を出して串刺し**にする（同時 1 本 = `max_concurrent`）。2 並列 full-workspace
  compile は OOM（`undefined symbol anon.llvm` link err / incremental 破損）を起こす。

**stale lock の見分け方と手動解放:**

stale の条件: (a) 実 owner pid が死亡、(b) 実 owner pid の lease（既定 240 分）超過、
(c) owner pid が `unknown` / legacy `0` / 欠損で `stale_minutes` 猶予を超え、かつ machine-wide
cargo/rustc プロセスが 0 と確認できる。unknown pid は age だけで回収しない。

| 手順 | command / 確認 |
| :-- | :-- |
| 1. build proc を確認 | `tasklist`（Windows）で cargo/rustc を見る。**該当 build の proc が生存していれば触らない** |
| 2. sweep で pid 死亡 + lease 超過を回収 | `bun skills/garelier-core/scripts/heavy_compile_lock.ts --project <root> --pm-id <pm_id> --mode sweep` |
| 3. sweep で消えず proc 0 を確認済みなら slot を rm | `runtime/locks/heavy_compile/` 下の該当 slot dir を削除（proc 0 を確認してから、これ 1 回きり） |
| 4. 恒常 busy fleet の unknown-pid slot 究極 override | machine-wide cargo/rustc が**常に非 0** の fleet では idle-reclaim の「proc 0」条件も手順 3 も永久に満たせず、unknown/`0`/欠損 owner の stale slot が残り続ける。この時だけ machine-wide quiet を待たず **per-owner liveness** で判断する: 該当 slot の `owner` file（pid\|label\|時刻）と `reclaim.log`（`probe=` 欄、W-169）を読み、その**特定 owner が実在しない**（対応する live process が無い — MSYS pid なら `ps`、Windows pid なら `tasklist /FI "PID eq <n>"` で確認）ことを確かめてから slot dir を rm する（これ 1 回きり）。unknown-pid は自動回収されない設計なので、この override は恒常 busy fleet でのみ必要 |

acquire は `slot-busy` / `ram-budget` を表示しつつ解放まで queue-wait する。`timeout-sec` は
待機 heartbeat 間隔で、lockless へ抜ける timeout ではない。`OPEN` は lock infra 故障のみで
caller は ABORT する。

→ pm_playbook §6

---

<a id="pmfm-6"></a>
## 6. worker dispatch prompt の必須文言 checklist

prompt = **`dispatch_prepare.ts` の `prompt_preamble` を冒頭に verbatim + 任務固有本文だけ**
（W-095）。preamble が下の定型を満たすので、PM は**この checklist を「preamble に入っているか」
の verify list として使う**（preamble を使わず手書きする時は全項目を自分で満たす）:

- [ ] **checkout の絶対 path** + 「**親 repo / primary checkout を直接編集しない。cargo も
      編集も commit も必ず自分の `…/checkout/` worktree の cwd で**」— primary で走らせると
      検証 evidence が丸ごと無効化する（誤走 2 回の実害）。
- [ ] **着手時 base-track** — studio を merge してから始める。
- [ ] **commit 書式 + trailer** — preamble の `{{TASK_ID}}` placeholder を bound backlog id
      （bound backlog row の id）に置換。
- [ ] **register 終端** — 完了時に **1 本だけ**、新 SHA + 結果を含む final message（commit/report 後、途中や事前でなく）。
- [ ] **台帳消し込み** — 走行中の scope 追加は `instructions.md` の
      front matter へ `[[instruction]]` table を append する。**詳細と transport 別の可否は §6.1**。
- [ ] **heavy build 規律** — 同時 1 本、他が build 中なら待つ / docs・調査は並列可（§5）。
- [ ] **scope 境界** — 触ってよい path と触るなの境界。逸脱しそうなら silent に広げず BLOCKED。
- [ ] **push 禁止** — workbench branch は push しない。
- [ ] （対象 project 固有）**determinism 制約** — 該当時は blueprint の design-review notes に埋める。

heavy role を spawn したら**即** `dispatch_prepare.ts` emit の `watch_cmd` を
`run_in_background` で arm する（必須、W-085）。忘れると無音のまま dormant 化する。

**MANDATORY（W-049）— Agent tool の `model:` param:** `dispatch_prepare.ts` の
JSON にある `model`（role）/ `gate_agents.guardian.model` /
`gate_agents.observer.model`（gate）を、subagent を起こす Agent tool 呼び出しの
**`model:` param に必ずそのまま渡す**。省略すると Claude Code の Agent tool は
**親（PM）session の model を無音で継承する**（error にも warning にもならない）。
これは実害が出た（target project 実戦 2026-07-11: worker 1 + gate 4 体が `model:` 未指定で
PM 自身の model のまま走った）。JSON の `spawn_directive` field にこの警告文が
埋め込まれているので、Agent tool を組み立てる直前に読み返す。

→ pm_playbook §7、attended-gate-dispatch.md

---

<a id="pmfm-6-1"></a>
### 6.1 走行中の lane へ追加指示を届ける — `instructions.md` が唯一の正規経路

**`<container>/instructions.md` (Instruction ledger) が正本。**
`dispatch_prepare.ts` が container root に生成し、**role の prompt preamble に
契約として入っている**ので、**dispatch を止めずに追記できる**。

**PM 側**:

```
[[instruction]]
id = 'I<n>'
message = '''<一行の指示> [-> <詳細への pointer>]'''
checked = false
```

- **1 指示 = 1 entry**。**先行 entry を書き換えない**
- 長い内容は別 file へ書き、entry には pointer だけ置く

**dispatched role 側 (preamble が課す契約)**:

> BEFORE REPORTING, set `checked = true` on EVERY `[[instruction]]` table, each with a
> non-empty `consumed = '''…'''`。値は TOML string なので括弧・backtick の escape 不要。
> **Do NOT reach REPORTING while any entry is `checked = false`**;
> state "ledger N/N consumed" in your register.

→ register の **`ledger N/N consumed`** が消し込みの証拠。
**`ledger 0/0 consumed` は「PM が何も追記しなかった」の意**であり、
指示が届いて無視されたのではない。

#### transport 別の可否

| role | live message | 追加指示の経路 |
| :--- | :--- | :--- |
| **codex-cli** | **無し** | **`instructions.md` のみ** |
| **claude / `attended-agent`** (既定) | **有り** — `SendMessage` で `agent_name` (prepare 出力の `agent_name`、例 `ga-worker-<slug>`) へ | message で送ってよいが、**受け手が `id = 'M<n>'` / `message = '''… (via message)'''` / `checked = false` の `[[instruction]]` table として ledger へ自分で追記する**契約 |
| **claude / `claude-subprocess`** | 無し | `instructions.md` のみ |

#### `lane/followup.md` は走行中の channel ではない

`dispatch_prepare` は `lane/followup.md` を**空 file で作る**が、これは
**`provider_session.ts resume --instruction` が読む resume 専用 slot** である
(`role_subagent_dispatch.md` の resume 節)。

- **走行中の role は読まない**。prompt にも記載されない
- role 系 script (`dispatch_provider.ts`) は `followup` を参照しない
- worker 系 doc (`garelier-worker/SKILL.md` / `codex_worker_playbook.md` /
  `worker_field_manual.md`) にも記載が無い

**実害 (実測 1 件)**: PM が「走行中 lane の bound source
(task file / blueprint) を触らない」を守るつもりで `lane/followup.md` へ
先回り指示 3 点を書いた。**role には届かず**、
PM が「BLOCK して返せ」と指定した箇所で role は新 substrate を作り、
gate 席が BLOCK した。register は `ledger 0/0 consumed` だった。
**gate 席は `followup.md` を読めるため「PM は指定した」と記録され、
指示が届いていないことが verdict からは見えない。**

#### 判定

- 走行中に足す指示は **`instructions.md` に append する**
- 送ったつもりで止まっていないかは **register の `ledger N/N consumed`** で確認する。
  **`0/0` が返ったら PM が書いた場所が違う**
- `followup.md` は **resume を発行する時にだけ**使う
- successful proxy commit は terminal。commit acknowledgement のために `followup.md` を
  書いたり provider を resume したりせず、genuine REWORK だけを explicit resume する

---

<a id="pmfm-7"></a>
## 7. 検証設計の交絡排除

**A/B で修正の効果を測る時は、対照側を無効化してから単独で測る。**

- 修正 X の効果を測るなら、既存の bypass / fallback / 旧 path を**先に off にする**。
  bypass が入ったまま「X の効果」を測ると、実際に効いているのが X か bypass か切り分けられず、
  結論が交絡して丸ごと無効になる。
- dispatch prompt に明示する: 「対照は片方（bypass / 旧経路）を off にして単独で測れ。
  両方 on のまま before/after を比較しない」。

→ pm_playbook §9（evidence で真因確定）

---

<a id="pmfm-8"></a>
## 8. 長文 register の part 分割

register が長く 1 message に収まらない時、**dispatch prompt で最初から part 分割を許可する**:

> 完了 register が長い場合は final message を `part 1/N` `part 2/N` … に分割してよい。
> 最初の part で N を宣言し、順に送ること。1 message に押し込んで截断されるより分割が正。

harness の message サイズで truncate されて register が欠けるより、明示的な分割のほうが安全。

---

<a id="pmfm-9"></a>
## 9. studio commit 規律

- **studio への commit は merge gate idle 時のみ。** `__garelier/<pm_id>/runtime/merge_gate/
  locks/active.lock` が在る間は commit しない — gate が張った staged merge を git が吸収して
  2-parent merge commit になり、gate が abort する（W-055）。別件は溜めて **gate idle 時に
  batch commit** する。
- **gitignored path（`runtime/` 配下）を commit に混ぜない。** `git add -A` を使わず対象 path を
  明示 add。commit 前に `git status` で `runtime/` が staged されていないか確認する。
- **手動確認を避けたいなら `pm_commit.ts` で commit する（W-023）。** `git commit` を薄く包み、
  `active.lock` 在中 or 未処理 gate request があれば commit を止める。既定は明確に断る、
  `--wait` で gate idle まで poll してから commit:

  ```bash
  # 既定 = gate 走行中なら refuse（exit 3、何も commit しない）
  bun skills/garelier-core/driver/src/scripts/pm_commit.ts --project <root> --pm-id <pm_id> -- -m "<msg>" -- <path…>
  # --wait = gate idle まで待ってから commit
  bun skills/garelier-core/driver/src/scripts/pm_commit.ts --project <root> --pm-id <pm_id> --wait -- -m "<msg>" -- <path…>
  ```

  git hook ではなく明示 wrapper（role worktree の commit を巻き込む誤爆を避けるため
  ambient にしない）。`--project`/`--pm-id` 以降の残り引数は `git commit` へそのまま渡る。

→ pm_playbook §1（merge gate 走行中の commit 吸収）

---

<a id="pmfm-10"></a>
## 10. gate verdict marker template

gate 役（Guardian / Observer）が verdict marker を書く時の雛形 = `templates/gate_verdict.md`。

- 置き場は §3 の正本 path（`runtime/<role>/results/<branch-slug>-<role>.md`）。
- **marker には読み手が 2 つあり、同じ面を読まない（W-668 / F-20）。両方を書く。**
  `merge_land.ts` は front matter の `[verdict] result` / `review_sha` を読み、
  `contract_check.ts --gate` は `## Verdict` 見出しとその直下の bare token を要求する。
  片方だけの marker は他方が refuse する（front matter だけ → `verdict_section_missing`、
  `## Verdict` 節だけ → `present but MALFORMED` = verdict なし）。
  `templates/gate_verdict.md` は両面を持つので、雛形を埋めれば両方を満たす。
- `## Verdict` 節の直下に **canonical token 1 個だけ**。`{{}}` menu を残したまま提出すると
  fail-closed で「verdict なし」になり merge が止まる（＝埋め忘れが安全側に倒れる設計）。
- finding は file:line / diff evidence 付き（DEC-088）。bare な形容詞 verdict は不可。
- marker が不在 / malformed（`contract_check --gate` が `ok:false`）なら、印字された `nudge` を
  gate 役に verbatim 送って直させる（§2-5）。PM は marker を書かない（DEC-090）。

refuter（高 stakes のみ）は `[verdict] result` ではなく `[refuter] result` 行形式
（`attended-gate-dispatch.md` § High-stakes refuter）。

---

## 参照

- `worker_field_manual.md` — dispatch する role（Worker / Scout）側の決定表（対になる view）
- `gate_field_manual.md` — gate 役（Guardian / Observer）側の決定表 + Observer 独立レビュー視点集
- `pm_playbook.md` — 各節の「なぜ」と実例（§1 cleanup 順序 / §2 SHA-verdict bind / §3 idle 三分岐 /
  §6 RAM 律速 / §7 dispatch prompt / §11 anchor protocol / §12 refuter）
- `attended-gate-dispatch.md` — gate dispatch の完全 prompt template、report contract、
  high-stakes refuter、mechanical-delta re-gate
- `role_subagent_dispatch.md` §6 — stall taxonomy（PROGRESS / ADVANCING / BUILDING / STALLED /
  RUNAWAY / REVIVE-NEEDED）と push-signal 分担
- `../../garelier-dock/references/merge-gate.md` — merge gate lifecycle、verdict-SHA binding
- `templates/gate_verdict.md` — verdict marker 雛形
- scripts: `merge_land.ts` / `heavy_compile_lock.ts` / `dispatch_watch.ts` /
  `dispatch_prepare.ts` / `contract_check.ts`
- 役割分担: 手順の文書化＝本 file、機構化＝ W-019（report 二重帳簿）/ W-020（gate path 正本）/
  W-024（lock stale 自動 reclaim）。機構が入っても判断基準は変わらない。

---

<a id="pmfm-11"></a>
## 11. runtime incident 処理

**トリガ:** `GARELIER_PM_ESCALATION` / `GARELIER_RUNTIME_INCIDENT` marker を見た。

1. **user に聞く前に incident を読む。** 最新 open incident を機械確認する
   (incident は `__garelier/<pm>/runtime/hooks/`、pm 帰属不能時のみ
   `__garelier/__atmos/guard/unresolved/`。dock_status の pmAction が両方を読む):

```bash
tail -n 20 __garelier/<pm>/runtime/hooks/incidents.jsonl
```

2. **rerun safety を分類する（判断表どおり）:**

| 分類 | command / 状況 | 手 |
| :-- | :-- | :-- |
| `safe` | read-only / test / build / check / lint / grep / status | recovery subagent を起動し、`incident_id` だけ渡す |
| `needs_inspection` | generator / install / cache warm / dependency fetch / large log rewrite | incident と log を読ませ、差分・生成物・cache 範囲を確認してから再実行 |
| `unsafe` | delete / reset / credential / publish / push / external API write / production data mutation | 破壊操作・外部 write の前に user 確認。dry-run、rollback、before/after counts が無ければ止める |

3. **safe は recovery subagent に渡す。** prompt は incident_id だけを正本 pointer にする:

```text
Recover runtime incident <incident_id>. Read __garelier/<pm>/runtime/hooks/incidents.jsonl
(or __garelier/__atmos/guard/unresolved/incidents.jsonl when unattributed),
inspect the referenced command/log/output, do not immediately rerun the same command
after timeout, and finish with:
GARELIER_RUNTIME_STATUS: {"runtime_ok": true|false, "incident_id": "<incident_id>", "evidence": "..."}
```

4. **unsafe は user 確認が先。** `rm -rf` / `git reset --hard` / credential 操作 / publish /
   push / production write は、確認なしに recovery subagent へ実行させない。
5. **復旧後 marker は要求する。** recovery の最終行は
   `GARELIER_RUNTIME_STATUS: {"runtime_ok": true, ...}` とする。`runtime_ok:false` は
   未復旧として扱い、同じ command を即再実行しない。**位置と個数は機械検査しない**
   (W-708 / DEC-100 段 0) — 終端の正本は register front matter の `[lane].state` であり、
   marker はその横に置く観測行である。
6. **marker は本文への「追記」であって置換ではない。** subagent の final message が
   marker 1 行だけで調査本文/deliverable を欠くのは契約違反 — 実戦で Explore agent の
   最終出力が marker のみになり調査本文が届かない事象を 3 回観測 (agent 側には結果が実在 =
   生成でなく伝達の欠落)。PM 側の扱い: **marker-only final message は stall と同格**として
   `SendMessage` で本文を再要求する (再要求で回収できる)。subagent へ出す prompt には
   「final message = 本文 + 最終行に marker、marker 単独は違反」を明記する。

---

<a id="pmfm-12"></a>
## 12. resume と instruction ledger

<a id="pmfm-12-1"></a>
### 12.1 canonical resume

genuine REWORK の追加指示だけを手組みせず `ready.json.resume_cmd` で届ける。
proxy commit 成功の通知には使わない。`provider_session.ts resume` は
canonical instruction を登録し、bound `instructions.md` へ次の pending 行を機械で書く。

```bash
bun skills/garelier-core/driver/src/scripts/provider_session.ts resume \
  --record <container>/lane/session.json \
  --instruction <container>/lane/followup.md \
  --result <container>/lane/followup.result.md --worktree <checkout> \
  --lock-dir <container>/lane/locks \
  --expected-model <model> --expected-effort <effort> --expected-source <source> \
  --project <project> --pm-id <pm_id> --dispatch-id <N> \
  --binding-generation <generation> --binding-digest <digest> \
  [--blueprint-update-commit <sha>]
```

exact session が provider により expired と確認された場合、resume launcher は同じ
dispatch/container、provider、model、effort のまま fresh session を 1 回作り、instruction
delivery に `previous_provider_session_id` を束縛する。新 session は predecessor chain と
一致した時だけ canonical tail になる。provider 自動切替、別 dispatch 作成、task refuse は
行わず、replacement 自体が失敗した時だけ fail-closed の fresh-dispatch fallback を返す。

Codex task の wording hygiene は
`skills/garelier-core/knowledge/provider_filter_vocabulary.toml` の語彙を report-only で照合する。
hit は `PROVIDER_VOCABULARY_HIT ... action=report-only` として operator に見せるだけで、provider
切替・dispatch refusal・task 書換えをしてはならない。role prompt の counterfactual は
first-party project / framework repository の test・gate が defect を検出する証明であり、
第三者 system を操作する指示ではない。

```toml
[[instruction]]
id = 'I0001'
message = '''<normalized message>'''
digest = '<message_digest first 12 hex>'
checked = false
```

producer に届く resume pointer も `ledger_token`、12-hex digest、exact declaration form を
含む。完了時は次のどちらかで消費根拠を型付けする。

```text
[[instruction]]
id = 'I0001'
digest = '<12hex>'
consumed = '''artifact:<project-relative-path>'''

[[instruction]]
id = 'I0001'
digest = '<12hex>'
consumed = '''commit:<40 lowercase hex>'''
```

`consumed = 'register'` を拒否し typed artifact / commit evidence を要求するのは Codex proxy
transcription (`transcribeCodexRegisterConsumption`) だけである。producer 自身が bound ledger を
書く場合は非空の `consumed` evidence を許す。artifact path は project-relative で、絶対 path、
drive prefix、空 / `.` / `..` segment を含めない。Codex register transcription は canonical
instruction chain と delivery を lock 内で照合してから既存 pending entry を `checked = true` にする。

**register 側の宣言は canonical ledger の全件**でなければならない。`I0001` から 1 件でも
欠けると proxy commit tool が
`Codex register does not declare consumption for canonical instruction: I0001` で refuse する。
BLOCKED 状態の register は定義上 ledger 未消費なので必ず refuse される。register の行形は
`I<n> digest:<12hex> (consumed: artifact:<report path>)` で、**1 行・行末・内側 ASCII 括弧 0 個**。

ledger 未消費は REPORTING / close admission で検出するため、merge request が最初の検出点に
ならない。PM が proxy transcription を行う場合も、artifact / commit による消費証明が必須。

**採番経路は lane ごとに 1 本に固定する。** PM が `instructions.md` へ手書きした行と
resume が採番する canonical entry は番号空間を共有するため、手書き `I0005` の後に resume が
`I0008` を配送すると
`role instruction ledger delivery conflicts with existing ledger entry: I0005` で
session failed / `fresh_dispatch_required` になる。resume 主体の lane では手書きしない。

<a id="pmfm-12-2"></a>
### 12.2 routing / binding / result preservation

- `--expected-model` / `--expected-effort` / `--expected-source` は
  `lane/session.json.routing` と完全一致させる。`--expected-source` の値は
  `ready.json.model_source` (例 `seat-default+adapter:codex-preserved`)、generation / digest は
  `ready.json.role_seat_binding` から読む。
- `--result` は hand-written の固定名ではなく `ready.json.resume_result_file` を使う。resume
  成功時に `lane/session.json.result_file` がその canonical resumed result を選び、以後の
  `dock_proxy` / `review_prepare` / gate は同じ artifact を読む。initial `result.md` へ戻して
  stale register を bind しない。
- resume の instruction file は **`instructions.md` に書いた当該 `I000N` 節だけ**を切り出して
  渡す。全文を渡すと旧 `I` を再消費して ledger が衝突する。
- blueprint update を届ける場合は commit に束縛し、`--blueprint-update-commit <sha>` を使う。
  bound source の直接変更は拒否される。
- merge failure や base-track 後の candidate 変更で binding が無効なら resume しない。
  refusal の `fresh_dispatch_required` に従い、新 dispatch で前 branch の成果を
  forward-integrate する。
- resume が失敗しても `--result` の producer register には触れない。診断 JSON は
  deterministic な `<result>.resume-error.json` に書かれ、stdout の `failure_file` が
  その absolute path を指す。成功時だけ `--result` を新しい producer output に置換する。

<a id="pmfm-12-3"></a>
### 12.3 binding 失効後の forward integration

binding が失効したら `--rework` で既存 container を再利用しない。studio を base とする fresh
dispatch を作り、前 branch は (a) PM が新 checkout で `git merge --no-ff <old-branch>` を行うか、
(b) producer の task に同じ forward merge を明記する。`--rework` は `STATE=REWORK` かつ
`review.md` がある container だけに使う。stale claim は dispatch context の session が分かる
場合はその session で `claim-release` し、context が無い場合だけ
`control claim <W-N> --session <sid> --pm-id <pm_id> --steal --reason "<理由>"` で所有権移行を
明示する (`dispatch_prepare` 側に `--steal` は無い)。

resume 後の register は既存内容を基礎に、blueprint Output の mandatory blocks、
standalone `review_sha:` marker、failure sets、census、scanner 節を保持する。結果 artifact
全体を書き直して required evidence を落とさない。

---

<a id="pmfm-13"></a>
## 13. PM shell / artifact 規約

- checkout 内の proxy commit 後は repo root へ `cd` を単独で行ってから次へ進む。
- Git command の selector を shell 展開で組み立てず、literal path / ref を 1 command
  ずつ使う。対象 cwd と write fence を常に一致させる。
- **`command_guard` が deny する 5 形** (実測、facts §8-4):

  | 形 | deny 理由 | 正しい形 |
  | :-- | :-- | :-- |
  | `cd /c/env/...` (POSIX 形) + git | probe repo を `C:\c\env\...` に誤解決 | `cd "C:/env/..."` (Windows 形) |
  | shell 変数 (`$B` / `$S`) を含む compound + git | `Git-affecting selector context (<VAR>)` | path は literal |
  | `if` / heredoc / `for` と git を同一 command に混在 | `DYNAMIC_ENVIRONMENT_SELECTOR` | **file 編集と git commit を別 command に分ける** |
  | `git merge-base` | 常に deny | dispatch の `base_sha` (`context.json`) を使う |
  | `git commit --amend` | `force_write` | studio では amend しない |

- cross-platform path は platform の separator API を使う。console encoding に依存する
  非 ASCII の中間出力は durable file へ書く。
- **Windows の fixture cleanup は `EBUSY` で落ちる**。子 process (claude-code provider) が dir を
  握ったまま `rmSync` すると `EBUSY` + ゴミ残置になる。cleanup は子 process 終了待ち +
  bounded retry を持たせる。
- destructive worktree / branch cleanup を raw Git command で行わず、
  `dispatch_cleanup.ts` の検証済み経路を使う。
- **`garelier` は PowerShell に存在しない** (bash function)。control mutation は Bash から
  打つか、`bun skills/garelier-core/driver/src/scripts/control.ts <subcommand> …` の形を使う。
- `garelier control --expect-revision` は Control reader が出す整数秒。control mutation
  (`backlog create` / `archive` / `transition`) は `--expect-control-revision` 必須で、値は
  `control session-open --pm-id <id> --agent claude --format json` の `base_control_revision`。
  usage 末尾の「cwd fence … `--allow-foreign-cwd`」段落は boilerplate であり、実エラーは
  **先頭 1 行**。`--pm-id` を省くと既定 PM で `PM namespace does not exist` になる。
  evidence shorthand は `gate:<request-id>:<commit>:<path>`、`path:`、`commit:`。
- archive done は 1 件以上の evidence と `## Acceptance criteria` を持つ。
- `garelier control list backlog --format json` は JSON object の `records` array を返す。
  人向け text を JSON stdout に混ぜない。
- `review_sha:` は artifact ごとに standalone 1 本。proxy commit 前は marker、commit 後は
  binder が full SHA に置換する。

---

<a id="pmfm-14"></a>
## 14. 負荷と gate 運用

- TypeScript/Bun driver の toolchain は Bun `>=1.4.0` を要求する。W-606 実測で Bun 1.3.14 の main-thread panic が 1.4.0 で消滅したため、gate 前に `bun --version` で確認する。
- framework の大きな Bun aggregate と別 target の heavy build を並走させない。実測上、
  resource contention で focused aggregate が 600 秒上限へ到達し得る。
- Worker は assignment が指定する scoped package check / aggregate を自分で 1 回実行する。
  formal merge candidate の whole-project gate は project が宣言した 1 closure command を
  Dock seat が lock 下で実行する。個別 command へ分割・重複実行しない。
- `[[quality_gate.register.supersessions]]` は project が step 名の包含関係を宣言した時だけ、
  同じ register に superset と subset の両方がある場合に subset を実行前に落とし、
  `STEP-SKIPPED <subset> superseded_by=<superset>` を残す。candidate-controlled GREEN の
  carry/reuse ではなく、その gate run 内の production plan 正規化である。
- `[quality_gate.register].summary_metrics` を使う場合は
  `test_count`, `finished_seconds`, `duplicate_test_names` の閉じた 3 要素を全て宣言する。
  runner は `GATE_SUMMARY_METRICS` の schema-versioned JSON を出す。同名 test の二重実行は
  zero を期待するが、wall-clock は before/after 報告値であり単独の合否条件にしない。
- long-running command は 1 single-flight job とし、recorded PID、cwd、command digest、log、
  exit evidence を持つ。notification だけを完了根拠にせず、FINISHED record と log を読み
  ACK する。
- timeout / FAILED 後は live orphan の有無を確認し、同じ mutation を即 replay しない。
  canonical state と runner evidence を読んで recovery edge を選ぶ。
- strict doctor の合格表現は **0 errors**。warning は project baseline と比較し、既存
  baseline を勝手に 0 と主張しない。

---

<a id="pmfm-15"></a>
## 15. 実測で確定した argv と落とし穴 (2026-08-30 運用実測)

本節は §3〜§14 の記述で **実測と食い違った / 書かれていなかった** 手順の正本。矛盾する場合は本節が勝つ。

<a id="pmfm-15-1"></a>
### 15.1 起動

- **codex lane / seat の起動は prepare JSON の `launch_cmd` をそのまま実行する** (`dispatch_provider.ts` に `--dispatch` は無い。`--worktree --project --prompt --result --context …` は prepare が組む)。python 等で `launch_cmd` を `.sh` に書き出して `bash` で走らせる。
- **claude-code seat (Observer 等) は Agent tool で spawn した後に ack が必須**:
  `dispatch_prepare.ts --ack-launch --dispatch-id <N> --project <project> --pm-id <pm_id> --agent-handle <spawn が返した handle> --parent-id <PM の session id>`。`--agent-handle` / `--parent-id` の両方が無いと 1 本ずつ refuse する。
- **新 lane の control session**: `control.ts session-open --agent <pm_id> --project <abs root> --pm-id <pm_id>` (**subcommand を先頭**、`--project` は絶対 path。`--project .` は cwd fence で拒否) → `control.ts claim <W-N> --session <cs> --project <abs> --pm-id <pm_id>` → `dispatch_prepare --control-session <cs>`。
- row が `verification` の Work に次 unit / Smith を出す時は先に `status = "active"` へ戻して commit する (prepare が拒否する)。

<a id="pmfm-15-2"></a>
### 15.2 resume

- 実 argv と落とし穴は §12.2 が正本。ここでは順序だけ再掲する:
  `ready.json.resume_result_file` → resume → `lane/session.json.result_file` が canonical へ移る。
- register の ledger 行が既存 entry と digest / consumed で食い違うと proxy commit が
  `Codex register consumption conflicts with existing ledger entry` で拒否する →
  既存 entry を正として書き直させる resume を 1 回挟む。

<a id="pmfm-15-3"></a>
### 15.3 Dock gate

- pre-merge gate = **project が宣言した固定 step + PM が land ごとに選ぶ 5 分以内の step** (`gate_runner.ts --steps <json>`; user 裁定 2026-08-29)。統合 test (workspace test / cooker / headless / bench / full CI) は **Smith batch** であり gate ではない。他の作業は Smith を待たない。
- PM 選定 step は **「その round の fix を戻すと RED になる test」**。worker に REQUIRED GATE へ bare command 行で書かせ、Dock はその行をそのまま使う。**block の書式・必須性は provider 非依存で `worker_field_manual.md` §5b が正本** (W-641) — codex lane / claude lane (attended-agent / claude-subprocess) で書き方は変わらない。`bun test -t` は **regex** (`+` 等の metachar を含む scenario 名は 0 件一致 → bun は fail-closed で exit 1)。log の実出力に probe 名が現れることを確認してから席へ。
- **既に REPORTING の lane に block が無い時の回復 (W-641、主語を明示)**:
  1. **PM** は register を編集しない (DEC-090 — PM は gate 判定面を書かない)。
  2. **PM** が container の `instructions.md` へ `id = 'I<n>'` の `[[instruction]]` table を 1 つ足すか `lane/followup.md` に
     追補指示を書く。指示内容は「新 contract の REQUIRED GATE block を register 末尾に追記して
     再 register せよ」+ **PM が選んだ step の bare command 1 行**
     (選定権は PM、記載場所は producer の register)。
  3. **producer** が自分の register (attended lane = `<container>/report.md`) に block を追記し、
     再度 register する。
  4. **PM** が `review_prepare.ts --project … --pm-id … --dispatch-id <N> --expected-studio-sha <sha>`
     を走らせ、`final_accounting.md` が `Gate result: GREEN (exit 0)` になったのを確認してから
     `dispatch_prepare --attended-seat --role guardian --dispatch-id <N>` で席を出す。
- Dock attribution の env 3 本: `GARELIER_ROLE=dock GARELIER_AGENT_NAME=<record 名から .dispatch.json を除いたもの> GARELIER_DISPATCH_RECORD=<record の絶対 path>`。**path 区切りは record の `source` と同じ形** (bash で作った record は `/`)。不一致は `selected external Dock dispatch record is missing or rejected`。**live な codex lane の worktree** に対する gate も同じ文言で拒否される (lane が idle / BLOCKED になってから)。
- 同じ log file に複数 run を追記しない (旧 run の `DOCK_ATTRIBUTION_ERROR` / `RESULT` を監視が拾う)。run ごとに log 名を変える。
- sccache 環境で `CARGO_INCREMENTAL=1` を一度でも付けて cargo を起動すると、**その checkout の `target/.rustc_info.json` が汚染され以後の全 cargo が `incremental compilation is prohibited` で即 fail** する。復旧 = 当該 file の削除 (`sccache --stop-server` だけでは直らない)。

<a id="pmfm-15-4"></a>
### 15.4 席

- **worker が「最終・worktree clean」と言うまで席を出さない**。追補指示の作業中 (`git status --short` が非空) の register に席を出すと Guardian が「是正が review SHA に無い」で BLOCK する。

<a id="pmfm-15-5"></a>
### 15.5 merge_land

- `--message` は **`[#N]` 付き subject + 空行 + `Garelier: <pm_id> worker#N <W-N>` + `Garelier-Seat: codex <model> (proxy-commit via dock seat)`** を含める (schema-v3 trailer 検査。`Garelier-Seat:` は proxy commit だけ — claude lane は role 自身が commit するので付かない)。
- **base-track merge に `--seat-trailer` は要らない** (W-692)。seat-trailer 検査の分母は
  **単一 parent の commit** だけで、Dock が checkout で作った merge commit (parent 2 本) は
  分母の外。判定は subject の文字列ではなく parent 数で、PM の control commit は
  `--range --first-parent` が最初から除外している。
  **`--seat-trailer <checked|skip>` は「検査が判定不能な時」の override** — container が
  解決できない / `context.json` の内容が読めない (どちらも fail-closed) 場合に使う。
  値は `checked` / `skip` のみ (amend は guard 拒否)。
  **proxy commit の trailer が実際に欠けている時にこの flag で通さない** — 検査ごと skip する
  ので、通ったことは何の証明にもならない。commit を直す。
- verdict は `--guardian-report / --observer-report` で明示するか、`runtime/<role>/results/<branch-slug>-<role>.md` 名で copy を置く (auto-read はその名を読む)。
- land したら settlement commit の message に **「解けたもの」(related / 内包 row / queue head) を列挙**する。

<a id="pmfm-15-6"></a>
### 15.6 Smith

- Smith は統合・結合 test の担当で **gate ではない** (project の quality gate 宣言で scope smith / required=false)。PM 判断で出す。`dispatch_prepare --role smith` が anvil branch を切る。
- Smith seat が heavy lock を取れない間は、batch を **Dock が `gate_runner --steps <smith steps json>` で anvil checkout に対して実走**し、Smith には log を渡して三値表を書かせる (resume)。到達形 = step ledger + 途中再開 + step 単位 lock + gate 優先 (framework backlog で追跡)。

---

<a id="pmfm-16"></a>
## 16. 運用実測 fact の転記 (2026-08-28 / 2026-08-29)

正本の実測記録は `control/reports/pm_procedure/2026-08-27-pm-procedure-facts.md` §8 / §9 / §9-10。
本節は**その全項を手順として使える形へ落としたもの**であり、各小節が転記先の anchor になる。
矛盾する場合は §15 → 本節 → §3〜§14 の順で勝つ。

<a id="pmfm-16-1"></a>
### 16.1 dispatch を出す前

- **席 task file は A-0 envelope**。`## Dispatch` は id / branch / tip / base / checkout /
  成果物 path **だけ**。`## Blueprint` は path + 正本宣言 1 行、`## Verdict` は token 集合、
  `## Output` は解決済 path、`## Seat` は席名のみ。過去 gate の経緯・前 verdict の要約・
  判定点・scanner 値の複製は **gate request 自体を BLOCK する** (しかも複製値が stale だった)。
  前 verdict は file path で指す。scanner evidence / 引継ぎ元 / showcase の記載は
  `## Dispatch-specific facts` 節へ置く (worker task はこの節のみ)。
- **席 prepare は `--model` / `--effort` 必須**、`--control-session` は当該 dispatch の
  `control_binding.json` から採る。
- **手書き row の frontmatter が schema-3 語彙外だと store 全体が parse 落ちする**。
  無関係な `dispatch_prepare` まで refuse される。`status` は
  `triage/ready/active/blocked/verification/deferred/done/cancelled/superseded` のみ、
  時刻は実時刻以前。`status = "open"` や未来時刻を書かない。
- **task / blueprint の冒頭に前提文を置く** (codex content filter 誤検知の真因、user 指摘):

  > 本作業は自社 engine / 自 repo の品質検証 (first-party、対象は本 repository のみ、
  > 第三者システムへの適用なし)。反証 (counterfactual) は「既存の oracle (test / gate /
  > census) が欠陥を検出する / 検出できないことを示す」ための regression 試験であり、
  > 欠陥を起こすことが目的ではない。

  反証の書式は「X を起こす」ではなく **「oracle が X を検出することを示す (検出できないなら
  UNCOVERED)」**。症状の再現は「入力 Y で oracle が RED になる」と書く。

<a id="pmfm-16-2"></a>
### 16.2 走行中の lane に触る

- **bound blueprint を走行中に commit すると binding が死ぬ**。resume 終了時に blueprint
  hash を再検査し、bound hash でも delivered instruction-chain hash でもない content は
  `blueprint source changed` → `status=failed` / `fallback=fresh_dispatch_required`。
  `instructions.md` に `git show <sha>:<path>` の pointer を書いても救えず、proxy commit も
  `instruction-delivery/<n>.json` 欠落で refuse する。
  正 = **lane idle 時に commit → 次 resume に `--blueprint-update-commit <sha>`**。
- **`item authority` の binding は prepare 時の working tree の row bytes** (未 commit の
  claim renewal 行を含む) を hash する。PM が row を HEAD へ「復元」すると逆に食い違い、
  `merge_request: item authority source changed` になる。
  正 = 復元しない。`dispatch_prepare --rebind-authority --id <N> --evidence <gate verdict path>`
  で現 bytes へ再束縛してから `merge_land`。**rebind は live claim を要する** (期限切れなら
  fresh dispatch + carry)。land する dispatch 以外の row は dirty のまま放置し、触るのは
  land 直前の当該 row だけ、それも本項の経路で行う。
- **`merge_request` は claim 更新 → row への evidence 書込み → item authority hash 検査、の
  順序欠陥を持つ**。症状 = `item authority source changed: <row>` が 1 回目に必ず出る。
  回避 = 1 回目の refuse で claim は更新済 (fresh) なので、**row を bound 内容
  (`git show HEAD:<row>`) に戻して即再投入**すると 2 回目は evidence 書込みが起きず通る。
  席 (Guardian / Observer) の prepare も row を書くため同じ症状が出る。
- **patch 移送した fresh dispatch は producer が role-binding 契約で BLOCK し得る**。
  worker skill の契約は「他 dispatch の WIP が pre-applied なら `role_recovery` generation か、
  PM の authority record」を要求する。判断は producer 差で割れる。
  正 = **task file に最初から hash 一覧 (patch の sha256 + untracked 各 sha256 + 取り込み元
  branch tip) と「recovery ではなく immutable assignment 入力である」宣言を書く** (prepare 前)。
- **`dispatch_prepare --recover-role` は要件が多い** (`--expected-previous-digest` /
  `--acceptance-id` 全件 / assignment・prompt・initial-instructions path / `--recovery-wip` は
  file 単位)。binding が死んだ lane の成果は、**fresh dispatch +
  `git merge <旧 branch>` (committed 分) + `git apply --index <絶対 path>.patch` (未 commit 分、
  `git diff HEAD` で採る。untracked file は別途 copy)** の方が確実。
  task file に「適用済、作り直さない」を prepare 前に書く。

<a id="pmfm-16-3"></a>
### 16.3 proxy commit と review SHA

- **codex は `result.md` を削除→再作成で書き直す**ため、REPORTING 直後の数十秒は file が
  存在しない瞬間がある。monitor の STATE 空 event はこの状態。読むのは
  `session.json` の `status` が `ready` になってから。
- **proxy commit 後の成果物 (result / report) は必ず「stale」で gate 席に BLOCK される**。
  producer は proxy commit 前に result を書くため、`review_sha` が placeholder、gate 状態が
  pending、canonical 値が pre-proxy のままになる → Guardian が「final SHA / Output definition
  未結合」で BLOCK → 帳尻だけの resume 1 round + Guardian 再要求。
  正 = **proxy commit → `bind_review_sha` → 席を出す前に producer を 1 回 resume して
  gate 実結果へ更新させる** (席より先)。

<a id="pmfm-16-4"></a>
### 16.4 gate の実行

- **`gate_runner --from-register` の silent refuse** (RESULT 行なし・exit 0) の 3 原因 =
  終端 marker の欠落 / undeclared step / coverage rule 外の path。register block は
  bare command 行 + `=== END REQUIRED GATE ===`、step は catalog 内のみ、config 系 path は
  covered doc へ入れる。
- **`gate_runner` は拡張子なしの shell script `bin/garelier` を Windows で exec できない**。
  register step の prefix `garelier control doctor --profile strict` は runner から
  `RUN_FAILED Executable not found in $PATH` になる。producer の register には runner が
  実走できる bun 形
  `bun <garelier>/skills/garelier-core/driver/src/scripts/control.ts doctor --profile strict --pm-id <id> --project .`
  を書かせ、policy の prefix にもその形を並べる。
- **再起動後の `heavy_compile` lock は死んだ holder が slot を握り続ける**。reclaim scan は
  `holders=1 / evaluated=slot-0=held / ram_ok=false` で、lease 240 min が切れるまで pid 死亡を
  見ない (dead-owner reclaim は deadline 超過 + dead pid + 同 host + gate 非稼働の全条件が必要)。
  正 = 再起動後、または `GATE_START` の後 5 分経っても step 行が無い時は
  `runtime/locks/heavy_compile/slot-*/owner` の pid 生存を確認し、死んでいれば
  `heavy_compile_lock.ts --mode release --token <slot dir>` で解放する (evidence = pid 不在、
  cargo process 0)。
- **席の guard record が「record worktree does not resolve under its dispatch container」で
  reject されると、席は最厳格 baseline に落ちて read-only command まで deny される**。
  席は producer worktree (`_crew/dispatch<N>/checkout`) を read-only で見るが、席自身の
  container (`_crew/dispatch<M>`) 配下に worktree が無いため record 解決が失敗する。
  席は verdict を出せるが `bash script/…` / awk / pipeline を deny されるので、
  evidence は Grep / Read で採る (回避ではなく代替手段)。

<a id="pmfm-16-5"></a>
### 16.5 merge_land と base

- **`BASE BEHIND STUDIO` 警告を無視して `merge_land` すると、同 file を触った sibling 束の
  land 後に merge gate が conflict で落ちる** (実測 = `merge produced 7 conflicted files`、
  席 2 本と heavy gate 1 本が無駄になった)。
  正 = `merge_land` の前に「base 以降の studio commit が候補の touch set に触るか」を
  `git diff --stat <base>..studio -- <候補の変更 file>` で見る。触るなら **席を出す前に**
  producer へ forward merge + 解消の round を出す (席の verdict は merge 後の SHA で取り直す)。
- **走行中 lane の studio commit (PM control 含む) は `review_prepare` の `B09` 検査で
  forward merge を強制する** (「候補が現 studio tip を内包」)。control row / blueprint の
  PM commit ごとに Dock が forward merge + 再束縛を踏む。
  運用 = **lane の E2E 直前は studio へ commit しない**。
- **landed lane / gate 席 container の回収**: `dispatch_cleanup` は Dock の
  `lane/base_sha.txt` を unknown artifact として refuse し、席は `--checkout` に registry
  派生 path (`_crew/dispatch<N>/checkout`、実在不要) を要求する。
  evidence を `showcase/` へ退避してから `--request-id` 無しで `--force-remove` する。

<a id="pmfm-16-6"></a>
### 16.6 provider の落とし穴

- **PM 事由で codex process を停止すると session が復旧できない**。`session.json` は
  `running` / `resuming` のまま残り、resume は `session_invocation_in_progress` で refuse、
  status を手で戻すと `role_binding_invalid` になる。
  正 = 停止した lane は resume せず **fresh dispatch + carry**
  (`git merge <旧 branch>` + WIP は `git apply --index`。staged deletion は plan tool の前に
  `git reset -q -- <path>`)。
- **codex は指示文の語で `content filter` (「possible cybersecurity risk」) を発火し
  resume を拒否する**。誘因 = 「crash / kill / signal 送信 / 子 process の停止 /
  0xc0000094 / 注入 / minidump / 再現 / 同時起動」等の語の密度。
  正 = 指示文は中立語で書き (「ランタイムの異常終了」「終了済 child handle への signal 送信」)、
  `kill` を動詞で使わない。task file は **pointer のみ**にし、症状・再現手順は row / report に
  置いて prompt に載せない。`provider_resume_failed` は成果 0 のまま binding 終端になるため、
  復旧は fresh dispatch (branch merge のみ)。

<a id="pmfm-16-7"></a>
### 16.7 損失の分類 — 何を減らすのか

- **必要経費** (減らさない): gate BLOCK → rework の round。SHA 束縛 evidence の取り直し。
- **手順欠陥** (機構で消す): 指示経路 2 本の採番衝突 / bound blueprint の走行中 commit /
  failure の 1 件ずつ列挙 (attribution env を 3 回、ledger 宣言、control revision) /
  失効後回復の手作業 / `command_guard` の path 形。
- 目標は round 数を減らすことではなく、**同じ round を 2 回やる空振りを 0 にする**こと。

---

<a id="pmfm-17"></a>

## 17. dispatch 宣言 3 軸 — 正本は 1 枚

`--resource-class` / `--heavy-tier` / `--touches` の判定表・warning 文言・既定は
[`dispatch_env.md#dispatch-declaration-axes`](dispatch_env.md) が正本。**本 file に複製は置かない**
(同一規則を 2 箇所に書くと、次に条文を足す席が両方を読むことになる)。

PM が最も踏むのは 2 点:

- **heavy dispatch に `--heavy-tier` を付け忘れる** → `context_pack` が stderr に warning を
  出し、tier は `null` で packed される。消費側が安全側 (`codegen`) へ倒すので、
  `check` 相当の job が hung 検知を遅らせる方向にずれる。逆に本当の codegen job が
  `check` として扱われると RUNAWAY (~60 分) で止められる。
- **並列 lane に `--touches` を宣言しない** → `conflict_check` が比較する物を持たず、
  重複は land 時の merge conflict として初めて出る。単独 lane では空でよい。
